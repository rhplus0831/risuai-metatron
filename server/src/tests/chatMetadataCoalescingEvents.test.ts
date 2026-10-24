// @vitest-environment node
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatOp } from "../../../shared/chats.ts";
import type { GenerationEvent } from "../../../shared/jobs.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { createSnapshotManager } from "../data/snapshots.ts";
import { createGenerationJobs, type RunningJob } from "../jobs/generationJobs.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";
import { allowListenerOrigin, createResourceTestClient, waitFor } from "./testSupport.ts";
import { loadJobScope } from "../jobs/jobScope.ts";
import { createJobRunState, createRunSetup } from "../jobs/runSetup.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
});

async function setup() {
    // Include single-message SELECTs too: a metadata patch must read no transcript rows.
    let messageReads = 0;
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
        const statement = prepare.call(this, sql);
        if (/SELECT\b.*\bdata\b.*\bFROM messages\b/i.test(sql)) {
            const all = statement.all;
            const get = statement.get;
            statement.all = function (...args) {
                messageReads++;
                return Reflect.apply(all, this, args);
            };
            statement.get = function (...args) {
                messageReads++;
                return Reflect.apply(get, this, args);
            };
        }
        return statement;
    });
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-meta-events-"));
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const lock = createGenerationLock();
    const store = createResourceStore({ file: ":memory:", kinds, guard: lock });
    const snapshots = createSnapshotManager({ store, dir });
    let start!: (job: RunningJob) => void;
    const started = new Promise<RunningJob>((resolve) => {
        start = resolve;
    });
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const jobs = createGenerationJobs({
        store,
        kinds,
        lock,
        snapshots,
        gate: snapshots.gate,
        authorize: async () => true,
        runner: async (job) => {
            start(job);
            await finished;
        },
    });
    const server = http.createServer();
    server.on("upgrade", (req, socket, head) => {
        jobs.handleUpgrade(req, socket, head);
    });
    const sockets: WebSocket[] = [];
    cleanups.push(async () => {
        for (const socket of sockets) socket.terminate();
        finish();
        jobs.beginShutdown();
        await jobs.drain();
        jobs.dispose();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await snapshots.stop();
        store.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const first = (name: string) => (store.get(kinds.get(name)!, "main")!.data as { id: string }[])[0].id;
    const bound = { presetId: first("presets"), modelPresetId: first("modelPresets"), personaId: first("personas") };
    const group = (ops: ChatOp[], baseRevision = store.chatRevision("c", "k")) => ({
        characterId: "c",
        chatId: "k",
        baseRevision,
        ops,
    });
    store.applyChanges({
        ops: [{ kind: kinds.get("characters")!, id: "c", baseRevision: null, data: { chaId: "c", name: "Owner" } }],
        chats: [
            group([
                {
                    op: "create",
                    chat: {
                        id: "k",
                        name: "K",
                        note: "",
                        localLore: [],
                        modelPresetId: bound.modelPresetId,
                        promptPresetId: bound.presetId,
                        bindedPersona: bound.personaId,
                        message: [
                            { role: "user", chatId: "u", data: "hello" },
                            { role: "char", chatId: "r", data: "reply" },
                        ],
                    },
                },
            ]),
        ],
    });
    const admitted = store.chatRevision("c", "k")!;
    const created = jobs.create(
        {
            kind: "command",
            clientId: "tab",
            command: { type: "button", data: "" },
            context: { characterId: "c", chatId: "k", ...bound, mode: "manual", input: "", chatRevision: admitted },
        },
        store.epoch(),
    );
    if (!created.ok) throw new Error(JSON.stringify(created));
    const job = await started;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    allowListenerOrigin(server);
    const port = (server.address() as { port: number }).port;
    const attach = async () => {
        const events: GenerationEvent[] = [];
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/generations/${created.jobId}/ws?clientId=tab`);
        sockets.push(ws);
        ws.on("message", (data) => {
            const event = JSON.parse(String(data)) as GenerationEvent;
            if (event.type !== "ping") events.push(event);
        });
        await waitFor(() => events.length > 0);
        return {
            ws,
            events,
            close: async () => {
                ws.close();
                await waitFor(() => !job.ownerAttached());
            },
        };
    };
    const emit = () => job.emitRecords({ chats: [{ characterId: "c", id: "k" }] });
    const write = (ops: ChatOp[], baseRevision = store.chatRevision("c", "k")) =>
        job.write(() => ({ chats: [group(ops, baseRevision)] }));
    const scope = loadJobScope(store, kinds, job.context);
    const run = createRunSetup(
        job,
        {
            store,
            kinds,
            lock,
            rootDir: dir,
            savePath: dir,
            scriptWorkers: {} as never,
            llm: {} as never,
            embeddings: {} as never,
            transformers: {} as never,
            tokens: { count: async (text: string) => text.length, encode: async () => [] } as never,
        },
        createJobRunState(job),
        scope,
        { runCharacterId: "c", engineCharacterId: "c" },
    );
    return { job, store, attach, emit, write, group, admitted, run, reads: () => messageReads };
}

// The actual registry/channel/owner socket. Assert stored state synchronously after the
// boundary, before the queued microtask can conceal a missing barrier.
describe("coalesced metadata at job output boundaries", () => {
    it("flushes channel requests even before the owner attaches", async () => {
        const h = await setup();
        const services = h.run.bindings.services;
        services.setChatVar("notice", "queued");
        h.job.channel.notice({ kind: "alertNormal", payload: { message: "waiting" } });
        expect(h.store.chatMeta("c", "k")!.data.scriptstate).toEqual({ $notice: "queued" });
        services.setChatVar("question", "queued");
        const question = h.job.channel.ask({ kind: "alertInput", payload: { message: "waiting" } });
        expect(h.store.chatMeta("c", "k")!.data.scriptstate).toEqual({ $notice: "queued", $question: "queued" });
        services.setChatVar("callback", "queued");
        const callback = h.job.channel.callback("inlayImage", { id: "image", data: "aGVsbG8=", mimeType: "image/png" });
        expect(h.store.chatMeta("c", "k")!.data.scriptstate).toEqual({
            $notice: "queued",
            $question: "queued",
            $callback: "queued",
        });
        const owner = await h.attach();
        await waitFor(() => owner.events.some((e) => e.type === "question"));
        const ask = owner.events.find((e) => e.type === "question")!;
        if (ask.type !== "question") throw new Error("expected question");
        owner.ws.send(JSON.stringify({ type: "answer", id: ask.id, outcome: "answered", value: "answer" }));
        await question;
        await waitFor(() => owner.events.some((e) => e.type === "callback"));
        const call = owner.events.find((e) => e.type === "callback")!;
        if (call.type !== "callback") throw new Error("expected callback");
        owner.ws.send(JSON.stringify({ type: "answer", id: call.id, outcome: "answered", value: { id: "image" } }));
        await callback;
    });

    it.each(["emit", "emitRecords", "notice", "question", "callback", "write"] as const)(
        "flushes one batch before %s leaves the job",
        async (boundary) => {
            const h = await setup();
            const owner = await h.attach();
            const before = h.store.chatRevision("c", "k")!;
            const eventStart = owner.events.length;
            let transactions = 0;
            const exec = DatabaseSync.prototype.exec;
            vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
                if (/^BEGIN\b/i.test(sql)) transactions++;
                return exec.call(this, sql);
            });
            const reads = h.reads();
            for (let i = 0; i < 50; i++) h.run.bindings.services.setChatVar("x", String(i));
            h.run.bindings.services.writeChat(() => [{ op: "meta", set: { note: "batched note" } }]);
            expect(h.store.chatRevision("c", "k")).toBe(before);
            let pending: Promise<unknown> | undefined;
            switch (boundary) {
                case "emit":
                    h.job.emit({ type: "progress", payload: "boundary" });
                    break;
                case "emitRecords":
                    h.job.emitRecords({ refs: [{ kind: "ui", id: "main" }] });
                    break;
                case "notice":
                    h.job.channel.notice({ kind: "alertNormal", payload: { message: "boundary" } });
                    break;
                case "question":
                    pending = h.job.channel.ask({ kind: "alertInput", payload: { message: "boundary" } });
                    break;
                case "callback":
                    pending = h.job.channel.callback("inlayImage", {
                        id: "image",
                        data: "aGVsbG8=",
                        mimeType: "image/png",
                    });
                    break;
                case "write":
                    h.write([{ op: "meta", set: { name: "after batch" } }]);
                    break;
            }
            const stored = h.store.chatMeta("c", "k")!;
            expect(stored.data).toMatchObject({ scriptstate: { $x: "49" }, note: "batched note" });
            expect(transactions).toBe(boundary === "write" ? 2 : 1);
            if (boundary !== "callback") expect(h.reads() - reads).toBe(0);
            const delta = boundary === "write" ? 1 : boundary === "callback" ? 3 : 2;
            await waitFor(() => owner.events.length >= eventStart + delta);
            const events = owner.events.slice(eventStart);
            expect(events[0]).toMatchObject({
                type: "chatPatch",
                baseRevision: before,
                meta: { scriptstate: { $x: "49" }, note: "batched note" },
            });
            expect(events.filter((e) => e.type === "chatPatch")).toHaveLength(1);
            if (boundary === "callback") {
                const hydrated = events.find((e) => e.type === "resource");
                expect(hydrated).toMatchObject({
                    type: "resource",
                    revision: stored.revision,
                    data: { scriptstate: { $x: "49" }, note: "batched note" },
                });
                const callback = events.find((e) => e.type === "callback")!;
                expect(callback).toMatchObject({
                    revisions: expect.arrayContaining([
                        { kind: "chats", characterId: "c", id: "k", revision: stored.revision },
                    ]),
                });
            }
            const request = events.find((e) => e.type === "question" || e.type === "callback");
            if (request && (request.type === "question" || request.type === "callback")) {
                owner.ws.send(
                    JSON.stringify({
                        type: "answer",
                        id: request.id,
                        outcome: "answered",
                        value: boundary === "callback" ? { id: "image" } : "answer",
                    }),
                );
                await pending;
                // An awaited callback/question starts a fresh batch.
                h.run.bindings.services.setChatVar("after", "answer");
                await Promise.resolve();
                expect(transactions).toBe(2);
                expect(h.store.chatMeta("c", "k")!.data.scriptstate).toEqual({ $x: "49", $after: "answer" });
            }
        },
    );
});

// The default runner through real HTTP routes, including a real Lua worker host boundary.
// The first question holds the job until its owner socket is attached.
describe("coalescing through generation routes", () => {
    it.each(["manual", "button"] as const)(
        "persists %s batches and reports the final stored revision to HTTP and the owner",
        async (kind) => {
            // The effect loop's clock stands still: its 50 ms yield never comes, so the setters after
            // the alert answer coalesce with it whatever the wait or the machine's speed.
            // Capture only connections opened during this fixture, then identify its store by epoch.
            const connections = new Set<DatabaseSync>();
            const prepare = DatabaseSync.prototype.prepare;
            const capture = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
                this: DatabaseSync,
                sql,
            ) {
                if (sql === "SELECT value FROM meta WHERE key = 'epoch'") connections.add(this);
                return prepare.call(this, sql);
            });
            const client = await createResourceTestClient({ generationEffectClock: () => 0 });
            capture.mockRestore();
            const database = [...connections].find(
                (connection) =>
                    (connection.prepare("SELECT value FROM meta WHERE key = 'epoch'").get() as { value: string })
                        .value === client.epoch,
            )!;
            expect(database).toBeDefined();
            mkdirSync(path.join(client.rootDir, "public"));
            symlinkSync(
                path.resolve(import.meta.dirname, "../../../public/lua"),
                path.join(client.rootDir, "public/lua"),
                "dir",
            );
            const server = http.createServer();
            client.context.attachWebSocket(server);
            let ws: WebSocket | undefined;
            cleanups.push(async () => {
                ws?.terminate();
                await client.close();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            });
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            allowListenerOrigin(server);
            const first = async (name: string) =>
                ((await (await client.get(name, "main")).json()) as { data: { id: string }[] }).data[0].id;
            const bound = {
                presetId: await first("presets"),
                modelPresetId: await first("modelPresets"),
                personaId: await first("personas"),
            };
            const effect =
                kind === "manual"
                    ? [
                          {
                              type: "v2GetAlertInput",
                              indent: 0,
                              displayType: "value",
                              display: "ready",
                              outputVar: "ready",
                          },
                          ...Array.from({ length: 20 }, (_, i) => ({
                              type: "v2SetVar",
                              indent: 0,
                              var: "x",
                              operator: "=",
                              valueType: "value",
                              value: i === 0 ? "0" : "{{calc::{{getvar::x}}+1}}",
                          })),
                          { type: "v2SetAuthorNote", indent: 0, valueType: "value", value: "note {{getvar::x}}" },
                      ]
                    : [
                          {
                              type: "triggerlua",
                              code: `onButtonClick = async(function(id, data)
            alertInput(id, "ready"):await()
            setChatVar(id, "x", "one")
            setChatVar(id, "y", getChatVar(id, "x") .. "/two")
        end)`,
                          },
                      ];
            const seeded = await client.json("/api/resources/batch", {
                ops: [
                    {
                        kind: "characters",
                        id: "c",
                        baseRevision: null,
                        data: {
                            chaId: "c",
                            type: "character",
                            name: "Owner",
                            triggerscript: [{ comment: "go", type: "manual", conditions: [], effect }],
                        },
                    },
                ],
                chats: [
                    {
                        characterId: "c",
                        chatId: "k",
                        baseRevision: null,
                        ops: [
                            {
                                op: "create",
                                chat: {
                                    id: "k",
                                    name: "K",
                                    scriptstate: {},
                                    note: "before",
                                    localLore: [],
                                    modelPresetId: bound.modelPresetId,
                                    promptPresetId: bound.presetId,
                                    bindedPersona: bound.personaId,
                                    message: [{ chatId: "m", role: "user", data: "unchanged" }],
                                },
                            },
                        ],
                    },
                ],
            });
            expect(seeded.status).toBe(200);
            const read = async () => {
                const response = await client.json("/api/resources/read", { chats: [{ characterId: "c", id: "k" }] });
                expect(response.status).toBe(200);
                return (
                    (await response.json()) as {
                        chats: { revision: string; data: import("../../../shared/database.ts").Chat }[];
                    }
                ).chats[0];
            };
            const before = await read();
            const response = await client.json("/api/generations", {
                kind: "command",
                clientId: "tab",
                command: kind === "manual" ? { type: "manual", name: "go" } : { type: "button", data: "go" },
                context: {
                    characterId: "c",
                    chatId: "k",
                    ...bound,
                    chatRevision: before.revision,
                    mode: "manual",
                    input: "",
                },
            });
            expect(response.status).toBe(200);
            const { jobId } = (await response.json()) as { jobId: string };
            const events: GenerationEvent[] = [];
            ws = new WebSocket(
                `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/generations/${jobId}/ws?clientId=tab&risu-auth=${encodeURIComponent(await client.signer.jwt())}`,
            );
            ws.on("message", (data) => events.push(JSON.parse(String(data)) as GenerationEvent));
            await waitFor(() => events.some((e) => e.type === "question" || e.type === "error"));
            expect(events.find((e) => e.type === "error")).toBeUndefined();
            expect(events.some((e) => e.type === "accepted")).toBe(true);
            const question = events.find((e) => e.type === "question")!;
            if (question.type !== "question") throw new Error("expected question");
            let transactions = 0;
            const exec = database.exec;
            vi.spyOn(database, "exec").mockImplementation(function (this: DatabaseSync, sql) {
                if (/^BEGIN\b/i.test(sql)) transactions++;
                return exec.call(this, sql);
            });
            const start = events.length;
            ws.send(JSON.stringify({ type: "answer", id: question.id, outcome: "answered", value: "go" }));
            await waitFor(() => events.some((e) => e.type === "done" || e.type === "error"));
            const terminal = events.find((e) => e.type === "done" || e.type === "error");
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            const after = await read();
            expect(after.data.scriptstate).toEqual(
                kind === "manual" ? { $ready: "go", $x: "19" } : { $x: "one", $y: "one/two" },
            );
            expect(after.data.note).toBe(kind === "manual" ? "note 19" : "before");
            expect(after.data.message).toEqual(before.data.message);
            const expectedWrites = kind === "manual" ? 1 : 2;
            expect(transactions).toBe(expectedWrites);
            const parts = before.revision.split(":");
            parts[2] = String(Number(parts[2]) + expectedWrites);
            expect(after.revision).toBe(parts.join(":"));
            expect(terminal).toMatchObject({ type: "done", revision: after.revision });
            const patches = events.slice(start).filter((e) => e.type === "chatPatch" && e.meta);
            expect(patches).toHaveLength(expectedWrites);
            if (kind === "button") {
                expect(patches[0]).toMatchObject({ meta: { scriptstate: { $x: "one" } } });
                expect(patches[1]).toMatchObject({ meta: { scriptstate: { $x: "one", $y: "one/two" } } });
            }
            const status = await client.request(`/api/generations/${jobId}?clientId=tab`);
            expect(status.status).toBe(200);
            expect(await status.json()).toMatchObject({ terminal: { type: "done", revision: after.revision } });
        },
    );
});
