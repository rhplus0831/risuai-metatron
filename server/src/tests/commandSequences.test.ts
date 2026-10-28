// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { WebSocket } from "ws";
import type { Chat, Message } from "../../../shared/database.ts";
import type { ChatOp } from "../../../shared/chats.ts";
import type { DiagnosticEventInput } from "../../../shared/diagnostics.ts";
import { NO_GENERATION_HOOKS, type GenerationEvent, type GenerationHooks } from "../../../shared/jobs.ts";
import { LLMFlags, LLMFormat, LLMProvider, LLMTokenizer } from "../../../shared/llm.ts";
import { createChangeFeed } from "../data/changeFeed.ts";
import { createGenerationReceipts } from "../data/generationReceipts.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createRequestHistory } from "../data/requestHistory.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { createSnapshotManager } from "../data/snapshots.ts";
import { createVectorCache } from "../data/vectorCache.ts";
import { CALLBACK_TIMEOUT_MS, createChannelHub } from "../jobs/channel.ts";
import { createGenerationRunner } from "../jobs/commandRunner.ts";
import { createGenerationJobs, JOB_MAX_DURATION_MS } from "../jobs/generationJobs.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";
import { createClaudeObserver } from "../llm/claudeObserver.ts";
import { createHistoryObserver } from "../llm/historyObserver.ts";
import { createLlmRequests } from "../llm/requests.ts";
import { createVertexTokenCache } from "../llm/vertexToken.ts";
import { createEmbeddings } from "../prompt/embeddings.ts";
import { createTransformers } from "../prompt/transformers.ts";
import { createAuthStore } from "../routes/auth.ts";
import { registerGenerationRoutes } from "../routes/generations.ts";
import type { AppEnv } from "../types.ts";
import type { TokenCounter } from "../prompt/tokens.ts";
import { createScriptWorkerPool } from "../scripts/workerPool.ts";
import { allowListenerOrigin } from "./testSupport.ts";
import { UNHURRIED_CBS, UNHURRIED_SCRIPT_WORKERS } from "./unhurriedLimits.ts";

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}
const cleanups: (() => void | Promise<void>)[] = [];
const workers = createScriptWorkerPool({
    rootDir: path.resolve(import.meta.dirname, "../../.."),
    ...UNHURRIED_SCRIPT_WORKERS,
});
beforeAll(() => workers.warm());
afterAll(() => workers.dispose());
beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

// The manual-trigger command syntax follows manualTriggers.test.ts: escape the separator through
// both CBS passes, as in the existing real-command harness.
const sep = "{{u::7b}}{{u::7b}}u::7c}}".repeat(3);
const commands = ["/multisend one", `/multisend clear ${sep}two${sep}three`];
const trigger = (type: string, effect: unknown[]) => ({ comment: "go", type, conditions: [], effect });

function fixture(options: { hooks?: GenerationHooks; stopSend?: boolean; modelId?: string } = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-command-sequence-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const lock = createGenerationLock();
    const feed = createChangeFeed();
    const file = path.join(dir, "resources.sqlite");
    const store = createResourceStore({ file, kinds, guard: lock, feed });
    cleanups.push(() => store.close());
    const snapshots = createSnapshotManager({ store, dir: path.join(dir, "backups") });
    cleanups.push(() => snapshots.stop());
    let now = 1_000_000;
    const clock = () => now;
    const receiptFile = path.join(dir, "generation-jobs.sqlite");
    const receipts = createGenerationReceipts({ file: receiptFile, epoch: store.epoch(), now: clock });
    cleanups.push(() => receipts.close());
    const history = createRequestHistory({ file: path.join(dir, "history.sqlite"), now: clock });
    cleanups.push(() => history.close());
    const singleton = (name: string, change: (data: any) => unknown) => {
        const kind = kinds.get(name)!;
        const row = store.get(kind, "main")!;
        store.put(kind, "main", change(row.data), row.revision);
    };
    const first = (name: string) => (store.get(kinds.get(name)!, "main")!.data as { id: string }[])[0].id;
    const bound = { presetId: first("presets"), modelPresetId: first("modelPresets"), personaId: first("personas") };
    const profileId = first("modelProfiles");
    singleton("modelProfiles", (rows) => [
        {
            ...rows[0],
            modelId: options.modelId ?? "reverse_proxy",
            maxContext: 4000,
            forceReplaceUrl: "https://provider.invalid/v1/chat/completions",
            customProxyRequestModel: "m",
        },
    ]);
    singleton("modelPresets", (rows) => [{ ...rows[0], mainSlot: { profileId }, subSlot: { profileId } }]);
    singleton("presets", (rows) => [
        { ...rows[0], maxResponse: 100, formatingOrder: ["chats", "lastChat"], regex: [], mainPrompt: "" },
    ]);
    singleton("providers", (row) => ({ ...row, useStreaming: false, requestRetrys: 0 }));
    store.put(
        kinds.get("characters")!,
        "c",
        {
            chaId: "c",
            name: "C",
            type: "character",
            firstMessage: "",
            desc: "",
            lowLevelAccess: true,
            triggerscript: [
                trigger(
                    "manual",
                    commands.map((value) => ({ type: "v2Command", indent: 0, value, valueType: "value" })),
                ),
                ...(options.stopSend ? [trigger("start", [{ type: "v2StopPromptSending", indent: 0 }])] : []),
            ],
        },
        null,
    );
    const write = (ops: ChatOp[]) =>
        store.applyChanges({
            chats: [{ characterId: "c", chatId: "k", baseRevision: store.chatRevision("c", "k"), ops }],
        });
    write([
        {
            op: "create",
            chat: {
                id: "k",
                name: "K",
                note: "",
                localLore: [],
                message: [{ role: "char", data: "keep until clear", chatId: "old" }],
                promptPresetId: bound.presetId,
                modelPresetId: bound.modelPresetId,
                bindedPersona: bound.personaId,
            },
        },
    ]);
    const read = () => store.readChatSource("c", "k");
    const messages = () => (read().data as Chat).message;
    const committed: { messages: Message[]; locked: string[] }[] = [];
    feed.subscribe((event) => {
        if (event.type === "change" && event.changes.chats.length && store.chatRevision("c", "k")) {
            committed.push({
                messages: structuredClone(messages()),
                locked: messages()
                    .filter(
                        (message) =>
                            lock.ownerOf({ characterId: "c", chatId: "k", messageId: message.chatId! }) !== null,
                    )
                    .map((message) => message.chatId!),
            });
        }
    });
    const providerCalls: { body: any; messages: Message[] }[] = [];
    let respond = async (_index: number, _signal: AbortSignal) =>
        new Response(
            JSON.stringify({ choices: [{ message: { role: "assistant", content: `reply-${_index + 1}` } }] }),
            { headers: { "content-type": "application/json" } },
        );
    const tokens: TokenCounter = { count: async () => 1, encode: async () => [1] };
    const observer = createClaudeObserver({ now: clock });
    cleanups.push(() => observer.dispose());
    const llm = createLlmRequests({
        store,
        kinds,
        tokens,
        vertexTokens: createVertexTokenCache({ now: clock }),
        claudeObserver: observer,
        parentCallback: () => null,
        now: clock,
        observer: createHistoryObserver(history, { content: () => true }),
        fetchImpl: (async (_url, init) => {
            const index = providerCalls.length;
            providerCalls.push({
                body: JSON.parse(String(init?.body)),
                messages: structuredClone(messages()),
            });
            return respond(index, init!.signal as AbortSignal);
        }) as typeof fetch,
    });
    cleanups.push(() => llm.dispose());
    const cache = createVectorCache({ file: path.join(dir, "vectors.sqlite") });
    cleanups.push(() => cache.close());
    const transformers = createTransformers({ cacheDir: path.join(dir, "models") });
    cleanups.push(() => transformers.dispose());
    const runner = createGenerationRunner({
        store,
        kinds,
        lock,
        scriptWorkers: workers,
        llm,
        tokens,
        rootDir: path.resolve(import.meta.dirname, "../../.."),
        savePath: dir,
        embeddings: createEmbeddings({ cache, transformers }),
        transformers,
        cbsTimeLimits: UNHURRIED_CBS,
        effectClock: () => 0,
    });
    const start = deferred();
    const diagnostics: DiagnosticEventInput[] = [];
    const jobs = createGenerationJobs({
        store,
        kinds,
        lock,
        snapshots,
        gate: snapshots.gate,
        authorize: async () => true,
        receipts,
        diagnostics: { record: (event) => diagnostics.push(event) },
        now: clock,
        hub: createChannelHub({ now: clock }),
        runner: async (job) => {
            await start.promise;
            await runner(job);
        },
    });
    cleanups.push(async () => {
        start.resolve();
        jobs.beginShutdown();
        await jobs.drain();
        jobs.dispose();
    });
    const app = new Hono<AppEnv>();
    registerGenerationRoutes(app, {
        jobs,
        auth: createAuthStore(dir, { bypass: true }),
        limiter: async (_c, next) => next(),
    });
    const context = () => ({
        characterId: "c",
        chatId: "k",
        ...bound,
        mode: "manual",
        input: "",
        chatRevision: store.chatRevision("c", "k")!,
    });
    const create = () => {
        const result = jobs.create(
            {
                kind: "command",
                clientId: "owner",
                context: context(),
                command: { type: "manual", name: "go" },
                hooks: options.hooks ?? NO_GENERATION_HOOKS,
            },
            store.epoch(),
        );
        if (!result.ok) throw new Error(JSON.stringify(result));
        return result.jobId;
    };
    const boundary = (fn: (sent: number, jobId: string) => void) => {
        const progress = receipts.progress.bind(receipts);
        vi.spyOn(receipts, "progress").mockImplementation((id, value) => {
            progress(id, value);
            fn((value as { sent: number }).sent, id);
        });
    };
    const follow = async (id: string) => {
        const listener = createServer();
        listener.on("upgrade", (req, socket, head) => jobs.handleUpgrade(req, socket, head));
        await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
        allowListenerOrigin(listener);
        const ws = new WebSocket(
            `ws://127.0.0.1:${(listener.address() as { port: number }).port}/api/generations/${id}/ws?clientId=owner`,
        );
        const events: GenerationEvent[] = [];
        const waiters = new Set<() => void>();
        ws.on("message", (raw) => {
            events.push(JSON.parse(String(raw)));
            for (const notify of waiters) notify();
        });
        const closed = new Promise<void>((resolve) => ws.once("close", resolve));
        cleanups.push(async () => {
            ws.close();
            await closed;
            await new Promise<void>((resolve) => listener.close(() => resolve()));
        });
        await new Promise<void>((resolve, reject) => {
            ws.once("open", resolve);
            ws.once("error", reject);
        });
        const until = async (predicate: (events: GenerationEvent[]) => boolean) => {
            if (predicate(events)) return;
            await new Promise<void>((resolve) => {
                const notify = () => {
                    if (predicate(events)) {
                        waiters.delete(notify);
                        resolve();
                    }
                };
                waiters.add(notify);
            });
        };
        return {
            ws,
            events,
            until,
            close: async () => {
                ws.close();
                await closed;
            },
        };
    };
    return {
        jobs,
        diagnostics,
        app,
        store,
        file,
        kinds,
        snapshots,
        receipts,
        receiptFile,
        history,
        read,
        messages,
        write,
        context,
        create,
        start,
        boundary,
        follow,
        providerCalls,
        committed,
        setNow: (value: number) => {
            now = value;
        },
        respond: (fn: typeof respond) => {
            respond = fn;
        },
    };
}

function response(index: number) {
    return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: `reply-${index + 1}` } }] }),
        { headers: { "content-type": "application/json" } },
    );
}
function holdSecond(h: ReturnType<typeof fixture>, fail = false) {
    const entered = deferred<AbortSignal>();
    const release = deferred();
    h.respond(async (index, signal) => {
        if (index === 1) {
            entered.resolve(signal);
            await new Promise<void>((resolve, reject) => {
                signal.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true });
                release.promise.then(resolve);
            });
        }
        return fail && index === 1
            ? new Response(JSON.stringify({ error: { message: "provider failed" } }), {
                  status: 500,
                  headers: { "content-type": "application/json" },
              })
            : response(index);
    });
    return { entered: entered.promise, release: release.resolve };
}
const sequenceEvents = (events: GenerationEvent[]) => events.filter((event) => event.type === "sequence");
const textOf = (messages: readonly Message[]) => messages.map(({ role, data }) => `${role}:${data}`);

describe("server command sequences", () => {
    it("runs differently cleared commands as ordinary sends under one job and records every part", async () => {
        const h = fixture();
        const id = h.create();
        const owner = await h.follow(id);
        const progress: unknown[] = [];
        const replies: Message[] = [];
        let busy: unknown;
        h.boundary((sent) => {
            progress.push(h.receipts.read(id)?.progress);
            if (sent > 0) replies.push(structuredClone(h.messages().at(-1)!));
            if (sent === 1)
                busy = h.jobs.create({ kind: "send", clientId: "other", context: h.context() }, h.store.epoch());
        });
        h.start.resolve();
        await h.jobs.drain();
        await owner.until((events) => events.some((event) => event.type === "done" || event.type === "error"));
        expect(
            h.jobs.status(id, "owner")?.terminal,
            JSON.stringify(h.jobs.status(id, "owner")?.terminal),
        ).toMatchObject({
            type: "done",
            sequence: { total: 3, sent: 3 },
            messageId: h.messages().at(-1)!.chatId,
        });
        expect(h.jobs.status(id, "other")).toBeNull();
        expect(busy).toEqual({ ok: false, status: 409, body: { error: "chatBusy", jobId: id } });
        expect(h.providerCalls.map((call) => textOf(call.messages.filter((message) => message.data)))).toEqual([
            ["char:keep until clear", "user:one"],
            ["user:two"],
            ["user:three"],
        ]);
        expect(textOf(h.messages())).toEqual(["user:three", "char:reply-3"]);
        for (const call of h.providerCalls) {
            expect(call.messages.find((message) => message.role === "user")).toEqual({
                role: "user",
                data: expect.any(String),
                chatId: expect.any(String),
            });
        }
        for (const reply of replies) {
            expect(reply.generationInfo?.generationId).toEqual(expect.any(String));
            expect(h.committed.some((write) => write.locked.includes(reply.chatId!))).toBe(true);
        }
        // A subscriber can never observe a clear without the replacement user message.
        expect(h.committed.every((write) => write.messages.length > 0)).toBe(true);
        expect(new Set(replies.map((message) => message.generationInfo?.generationId)).size).toBe(3);
        expect(owner.events.filter((event) => event.type === "stage" && event.stage === "generating")).toHaveLength(3);
        expect(sequenceEvents(owner.events)).toEqual(
            replies.map((reply, index) => ({
                type: "sequence",
                epoch: h.store.epoch(),
                index,
                total: 3,
                sent: index + 1,
                messageId: reply.chatId,
            })),
        );
        expect(progress).toEqual([
            { total: 3, sent: 0 },
            { total: 3, sent: 1 },
            { total: 3, sent: 2 },
            { total: 3, sent: 3 },
        ]);
        expect(h.history.list({ jobId: id }).items).toHaveLength(3);
        expect(owner.events.some((event) => "followUps" in event)).toBe(false);
    });

    it.each([
        ["orphaned lore override", "chatLoreOverrideOrphaned"],
        ["binding change", "chatBindingMismatch"],
        ["deleted chat", "chatNotFound"],
        ["closed gate", "maintenance"],
        ["changed epoch", "EpochMismatch"],
    ])("refuses the next part after %s without writing its clear or append", async (condition, stopped) => {
        const h = fixture();
        const id = h.create();
        let before: unknown;
        let messageId: string | undefined;
        let writes = 0;
        h.boundary((sent) => {
            if (sent !== 1) return;
            messageId = h.messages().at(-1)!.chatId;
            if (condition === "orphaned lore override")
                h.write([
                    {
                        op: "meta",
                        set: {
                            loreOverrides: [
                                {
                                    off: false,
                                    entry: {
                                        id: "missing",
                                        key: "missing",
                                        comment: "Missing",
                                        content: "orphan",
                                        mode: "normal",
                                        insertorder: 100,
                                        alwaysActive: false,
                                        secondkey: "",
                                        selective: false,
                                    },
                                },
                            ],
                        },
                        unset: [],
                    },
                ]);
            if (condition === "binding change") {
                const kind = h.kinds.get("personas")!;
                const row = h.store.get(kind, "main")!;
                h.store.put(
                    kind,
                    "main",
                    [...(row.data as object[]), { id: "replacement", name: "Other" }],
                    row.revision,
                );
                h.write([{ op: "meta", set: { bindedPersona: "replacement" }, unset: [] }]);
            }
            if (condition === "deleted chat") h.write([{ op: "delete" }]);
            if (condition === "closed gate") vi.spyOn(h.snapshots.gate, "active", "get").mockReturnValue(true);
            if (condition === "changed epoch") vi.spyOn(h.store, "epoch").mockReturnValue("new-epoch");
            before = structuredClone(h.read());
            const apply = h.store.applyChanges.bind(h.store);
            vi.spyOn(h.store, "applyChanges").mockImplementation((batch, options) => {
                if (Array.isArray(batch.chats) && batch.chats.length) writes++;
                return apply(batch, options);
            });
        });
        h.start.resolve();
        await h.jobs.drain();
        expect(
            h.jobs.status(id, "owner")?.terminal,
            JSON.stringify(h.jobs.status(id, "owner")?.terminal),
        ).toMatchObject({
            type: "done",
            sequence: { total: 3, sent: 1, stopped },
        });
        expect(writes).toBe(0);
        expect(h.read()).toEqual(before);
        expect(h.providerCalls).toHaveLength(1);
        // The last part's reply is reported while it is still in the chat; a deleted chat has none.
        if (condition !== "deleted chat") expect(h.jobs.status(id, "owner")?.terminal).toMatchObject({ messageId });
    });

    it("rolls back clear when the same part's append fails", async () => {
        const h = fixture();
        const id = h.create();
        let before: unknown;
        h.boundary((sent) => {
            if (sent !== 1) return;
            before = structuredClone(h.read());
            const db = new DatabaseSync(h.file);
            db.exec(
                "CREATE TRIGGER refuse_part BEFORE INSERT ON messages WHEN json_extract(NEW.data, '$.data') = 'two' BEGIN SELECT RAISE(ABORT, 'append failed'); END",
            );
            db.close();
        });
        h.start.resolve();
        await h.jobs.drain();
        expect(
            h.jobs.status(id, "owner")?.terminal,
            JSON.stringify(h.jobs.status(id, "owner")?.terminal),
        ).toMatchObject({ type: "error", sequence: { total: 3, sent: 1 } });
        expect(h.read()).toEqual(before);
        expect(h.providerCalls).toHaveLength(1);
    });
});

describe("a running sequence part", () => {
    it("lets another client stop the entire command sequence and attributes its live and kept end", async () => {
        const h = fixture();
        const held = holdSecond(h);
        const id = h.create();
        const owner = await h.follow(id);
        h.start.resolve();
        const signal = await held.entered;
        const current = await h.app.request("/api/generations/current?characterId=c&chatId=k&clientId=other");
        expect(current.status).toBe(200);
        expect(await current.json()).toEqual({
            jobId: id,
            kind: "command",
            owned: false,
            stage: "generating",
            sequence: { total: 3, sent: 1 },
        });
        const stopped = await h.app.request("/api/generations/stop", {
            method: "POST",
            headers: { "content-type": "application/json", "x-resource-epoch": h.store.epoch() },
            body: JSON.stringify({ characterId: "c", chatId: "k", jobId: id, clientId: "other" }),
        });
        expect(stopped.status).toBe(200);
        expect(signal.aborted).toBe(true);
        await h.jobs.drain();
        await owner.until((events) => events.some((event) => event.type === "error" || event.type === "done"));
        const terminal = {
            type: "error",
            reason: "aborted",
            abortedBy: "other",
            sequence: { total: 3, sent: 1 },
        };
        expect(owner.events.filter((event) => event.type === "error" || event.type === "done")).toEqual([
            expect.objectContaining(terminal),
        ]);
        expect(h.jobs.status(id, "owner")?.terminal).toMatchObject(terminal);
        expect(h.receipts.read(id)?.status?.terminal).toMatchObject(terminal);
        expect(h.diagnostics.filter((event) => event.kind === "job" && event.phase === "error")).toEqual([
            expect.objectContaining({ jobId: id, reason: "aborted", stoppedBy: "otherClient" }),
        ]);
        expect(h.providerCalls).toHaveLength(2);
        expect(textOf(h.messages())).toEqual(["user:two"]);
        expect(h.jobs.chatBusy("c", "k")).toBe(false);
    });

    it.each(["Stop", "provider failure", "shutdown"])(
        "ends the whole sequence on %s during part two, preserving progress",
        async (cause) => {
            const h = fixture();
            const held = holdSecond(h, cause === "provider failure");
            const id = h.create();
            const owner = await h.follow(id);
            h.start.resolve();
            const signal = await held.entered;
            if (cause === "Stop") {
                const deleted = await h.app.request(`/api/generations/${id}?clientId=owner`, { method: "DELETE" });
                expect(deleted.status).toBe(200);
                expect(await deleted.json()).toEqual({ aborted: true });
            }
            if (cause === "shutdown") h.jobs.beginShutdown();
            if (cause === "provider failure") {
                // The held HTTP request fails with a provider response when released.
                held.release();
            }
            await h.jobs.drain();
            await owner.until((events) => events.some((event) => event.type === "error" || event.type === "done"));
            const terminal = h.jobs.status(id, "owner")?.terminal;
            expect(terminal).toMatchObject({
                type: "error",
                reason: cause === "Stop" ? "aborted" : cause === "shutdown" ? "shutdown" : "failed",
                sequence: { total: 3, sent: 1 },
            });
            if (cause !== "provider failure") expect(signal.aborted).toBe(true);
            expect(h.providerCalls).toHaveLength(2);
            expect(textOf(h.messages())).toEqual(["user:two"]);
            expect(h.receipts.read(id)?.status?.terminal).toMatchObject({
                type: "error",
                sequence: { total: 3, sent: 1 },
            });
            expect(owner.events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
        },
    );

    it("finishes callback-free parts after the owner's socket closes after part one", async () => {
        const h = fixture();
        const held = holdSecond(h);
        const id = h.create();
        const owner = await h.follow(id);
        h.start.resolve();
        await held.entered;
        await owner.until((events) => sequenceEvents(events).length === 1);
        await owner.close();
        held.release();
        await h.jobs.drain();
        expect(h.jobs.status(id, "owner")?.terminal).toMatchObject({
            type: "done",
            messageId: h.messages().at(-1)!.chatId,
            sequence: { total: 3, sent: 3 },
        });
        expect(h.providerCalls).toHaveLength(3);
        expect(textOf(h.messages())).toEqual(["user:three", "char:reply-3"]);
    });

    it("saves a plugin provider's partial text and frees the chat when owner absence disconnects its callback", async () => {
        const modelId = "pluginmodel:::prov";
        const h = fixture({
            modelId,
            hooks: {
                ...NO_GENERATION_HOOKS,
                providers: [
                    {
                        name: "prov",
                        model: {
                            id: modelId,
                            name: "prov",
                            shortName: "prov",
                            fullName: "prov",
                            internalID: modelId,
                            provider: LLMProvider.AsIs,
                            format: LLMFormat.Plugin,
                            flags: [LLMFlags.hasStreaming, LLMFlags.hasFullSystemPrompt],
                            parameters: [],
                            tokenizer: LLMTokenizer.Unknown,
                        },
                    },
                ],
            },
        });
        const id = h.create();
        const sends = vi.spyOn(WebSocket.prototype, "send");
        const owner = await h.follow(id);
        const peer = sends.mock.contexts.find((socket) => socket !== owner.ws) as WebSocket;
        sends.mockRestore();
        const peerClosed = new Promise<void>((resolve) => peer.once("close", () => resolve()));
        h.start.resolve();
        await owner.until((events) => events.some((event) => event.type === "callback" && event.name === "provider"));
        const callback = owner.events
            .filter((event) => event.type === "callback")
            .find((event) => event.name === "provider")!;
        owner.ws.send(JSON.stringify({ type: "chunk", id: callback.id, text: "Unfinished reply" }));
        await owner.until((events) =>
            events.some((event) => event.type === "chunk" && event.text === "Unfinished reply"),
        );
        // No checkpoint timer has run: the failure path itself must persist the in-flight text.
        expect(h.messages().some((message) => message.data === "Unfinished reply")).toBe(false);
        await owner.close();
        await peerClosed;
        h.setNow(1_000_000 + 120_000);
        // A new attach enforces the elapsed absence without running any timers, including checkpoints.
        const late = await h.follow(id);
        await late.until((events) => events.some((event) => event.type === "error"));
        await h.jobs.drain();
        expect(h.jobs.status(id, "owner")?.terminal).toMatchObject({
            type: "error",
            message: expect.stringContaining("provider callback disconnected"),
            sequence: { total: 3, sent: 0 },
        });
        expect(h.messages().at(-1)?.data).toBe("Unfinished reply");
        const replyId = h.messages().at(-1)!.chatId!;
        // An ordinary write proves the reply's generation lock was released as well as the slot.
        h.write([{ op: "setText", id: replyId, text: "recovered" }]);
        expect(h.messages().at(-1)?.data).toBe("recovered");
        const next = h.create();
        expect(next).not.toBe(id);
        h.jobs.abort(next, "owner");
        await h.jobs.drain();
    });

    it("ends with the missing-owner reason when the next part needs a script callback", async () => {
        const h = fixture({ hooks: { ...NO_GENERATION_HOOKS, scripts: ["editoutput"] } });
        const held = holdSecond(h);
        const id = h.create();
        const owner = await h.follow(id);
        owner.ws.on("message", (raw) => {
            const event = JSON.parse(String(raw));
            if (event.type === "callback")
                owner.ws.send(
                    JSON.stringify({ type: "answer", id: event.id, outcome: "answered", value: event.payload.text }),
                );
        });
        h.start.resolve();
        await held.entered;
        await owner.until((events) => sequenceEvents(events).length === 1);
        await owner.close();
        // Observe the real callback's timer registration before moving the clock. No sleep races
        // prompt assembly, the provider, or the socket's close handshake.
        const waiting = deferred();
        const setTimer = globalThis.setTimeout;
        vi.spyOn(globalThis, "setTimeout").mockImplementation(((
            handler: (...args: any[]) => void,
            ms?: number,
            ...args: any[]
        ) => {
            const timer = setTimer(handler, ms, ...args);
            if (ms === CALLBACK_TIMEOUT_MS) waiting.resolve();
            return timer;
        }) as typeof setTimeout);
        held.release();
        await waiting.promise;
        h.setNow(1_000_000 + CALLBACK_TIMEOUT_MS);
        await vi.advanceTimersByTimeAsync(CALLBACK_TIMEOUT_MS);
        await h.jobs.drain();
        expect(h.jobs.status(id, "owner")?.terminal).toMatchObject({
            type: "error",
            message: expect.stringContaining("disconnected"),
            sequence: { total: 3, sent: 1 },
        });
        expect(h.providerCalls).toHaveLength(2);
        expect(textOf(h.messages())).not.toContain("user:three");
    });

    it("gives part two its own thirty-minute deadline even when the job is older", async () => {
        const h = fixture();
        const held = holdSecond(h);
        h.boundary((sent) => {
            if (sent === 1) h.setNow(1_000_000 + 29 * 60_000);
        });
        const id = h.create();
        h.jobs.startGc();
        h.start.resolve();
        const signal = await held.entered;
        // Jump the injected clock without firing timers, then explicitly run the GC tick.
        h.setNow(1_000_000 + 29 * 60_000 + JOB_MAX_DURATION_MS - 1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(h.jobs.status(id, "owner")?.state).toBe("running");
        expect(signal.aborted).toBe(false);
        h.setNow(1_000_000 + 29 * 60_000 + JOB_MAX_DURATION_MS);
        await vi.advanceTimersByTimeAsync(30_000);
        await h.jobs.drain();
        expect(signal.aborted).toBe(true);
        expect(h.jobs.status(id, "owner")?.terminal).toMatchObject({
            type: "error",
            reason: "timeout",
            sequence: { total: 3, sent: 1 },
        });
        expect(h.providerCalls).toHaveLength(2);
    });

    it("reads shutdown and completed-part progress after reopening the running job's receipt", async () => {
        const h = fixture();
        const held = holdSecond(h);
        const id = h.create();
        h.start.resolve();
        await held.entered;
        expect(h.receipts.read(id)).toMatchObject({ endedAt: null, progress: { total: 3, sent: 1 } });
        // Closing the receipt before aborting the old runner models a process disappearing without
        // writing a terminal. The new registry has no live or kept copy of the job.
        h.receipts.close();
        h.jobs.beginShutdown();
        await h.jobs.drain();
        const reopened = createGenerationReceipts({
            file: h.receiptFile,
            epoch: h.store.epoch(),
            now: () => 1_000_000,
        });
        cleanups.push(() => reopened.close());
        const restarted = createGenerationJobs({
            store: h.store,
            kinds: h.kinds,
            lock: createGenerationLock(),
            snapshots: h.snapshots,
            gate: h.snapshots.gate,
            authorize: async () => true,
            receipts: reopened,
            now: () => 1_000_000,
        });
        cleanups.push(() => restarted.dispose());
        expect(restarted.status(id, "owner")).toMatchObject({
            jobId: id,
            state: "ended",
            kept: true,
            terminal: { type: "error", reason: "shutdown", sequence: { total: 3, sent: 1 } },
        });
        expect(restarted.status(id, "other")).toBeNull();
        expect(restarted.live()).toBe(0);
        expect(h.providerCalls).toHaveLength(2);
    });

    it("stops with notSent and does not count a part whose start trigger stops sending", async () => {
        const h = fixture({ stopSend: true });
        const id = h.create();
        const owner = await h.follow(id);
        h.start.resolve();
        await h.jobs.drain();
        await owner.until((events) => events.some((event) => event.type === "done" || event.type === "error"));
        expect(h.jobs.status(id, "owner")?.terminal).toMatchObject({
            type: "done",
            sequence: { total: 3, sent: 0, stopped: "notSent" },
        });
        expect(sequenceEvents(owner.events)).toEqual([
            { type: "sequence", epoch: h.store.epoch(), index: 0, total: 3, sent: 0 },
        ]);
        expect(textOf(h.messages())).toEqual(["char:keep until clear", "user:one"]);
        expect(h.providerCalls).toHaveLength(0);
        expect(h.receipts.read(id)?.progress).toEqual({ total: 3, sent: 0 });
    });
});
