// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { ChatOp } from "../../../shared/chats.ts";
import { NO_GENERATION_HOOKS, type GenerationEvent } from "../../../shared/jobs.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { createSnapshotManager } from "../data/snapshots.ts";
import { createGenerationJobs, type RunningJob } from "../jobs/generationJobs.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";
import { allowListenerOrigin } from "./testSupport.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

async function setup(patches = true, rows = false) {
    // Socket messages are latches; neither the job nor callback deadlines advance with real I/O.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-generation-barrier-"));
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const lock = createGenerationLock();
    const store = createResourceStore({ file: ":memory:", kinds, guard: lock });
    const snapshots = createSnapshotManager({ store, dir });
    const first = (kind: string) => (store.get(kinds.get(kind)!, "main")!.data as { id: string }[])[0].id;
    const bound = { presetId: first("presets"), modelPresetId: first("modelPresets"), personaId: first("personas") };
    store.put(kinds.get("characters")!, "c", { chaId: "c", name: "C", type: "character" }, null);
    const revision = () => store.chatRevision("c", "k")!;
    const group = (ops: ChatOp[]) => ({ characterId: "c", chatId: "k", baseRevision: revision(), ops });
    store.applyChanges({
        chats: [
            group([
                {
                    op: "create",
                    chat: {
                        id: "k",
                        name: "K",
                        note: "",
                        localLore: [],
                        fmIndex: -1,
                        modelPresetId: bound.modelPresetId,
                        promptPresetId: bound.presetId,
                        bindedPersona: bound.personaId,
                        message: [
                            { chatId: "a", role: "user", data: "A" },
                            { chatId: "b", role: "char", data: "B" },
                        ],
                    },
                },
            ]),
        ],
    });
    let expose!: (job: RunningJob) => void;
    const running = new Promise<RunningJob>((resolve) => {
        expose = resolve;
    });
    const jobs = createGenerationJobs({
        store,
        kinds,
        snapshots,
        gate: snapshots.gate,
        lock,
        authorize: async () => true,
        runner: async (job) => {
            expose(job);
            await new Promise<void>((resolve) => job.signal.addEventListener("abort", () => resolve(), { once: true }));
        },
    });
    cleanups.push(async () => {
        jobs.beginShutdown();
        await jobs.drain();
        jobs.dispose();
        await snapshots.stop();
        store.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const created = jobs.create(
        {
            kind: "send",
            clientId: "tab",
            context: { characterId: "c", chatId: "k", ...bound, mode: "normal", input: "", chatRevision: revision() },
            hooks: { ...NO_GENERATION_HOOKS, scripts: ["editoutput"] },
        },
        store.epoch(),
    );
    if (!created.ok) throw new Error(`Admission failed: ${JSON.stringify(created.body)}`);
    const job = await running;
    const listener = createServer();
    listener.on("upgrade", (req, socket, head) => jobs.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    allowListenerOrigin(listener);
    cleanups.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
    const { port } = listener.address() as { port: number };
    let stamp = 0;
    const attach = async (rows: boolean, proto?: string) => {
        const ws = new WebSocket(
            `ws://127.0.0.1:${port}/api/generations/${created.jobId}/ws?clientId=tab&attach=${++stamp}&liveness=1${patches ? "&hydration=patch" : ""}${rows ? "&rows=streamed" : ""}${proto === undefined ? "" : `&proto=${proto}`}`,
        );
        const events: GenerationEvent[] = [];
        const waiters: ((event: GenerationEvent) => void)[] = [];
        const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
        ws.on("message", (raw) => {
            const event = JSON.parse(String(raw)) as GenerationEvent;
            if (event.type === "ping") {
                ws.send(JSON.stringify({ type: "pong", ts: event.ts }));
                return;
            }
            const waiter = waiters.shift();
            if (waiter) waiter(event);
            else events.push(event);
        });
        cleanups.push(async () => {
            ws.close();
            await closed;
        });
        const next = () =>
            events.length
                ? Promise.resolve(events.shift()!)
                : new Promise<GenerationEvent>((resolve) => waiters.push(resolve));
        await new Promise<void>((resolve, reject) => {
            ws.once("open", resolve);
            ws.once("error", reject);
        });
        // The owner's role comes first on every attach, before the attach chat.
        expect(await next()).toEqual({ type: "handoff", epoch: store.epoch(), owner: "self" });
        const snapshot = await next();
        expect(snapshot).toMatchObject({ type: "chatPatch", revision: revision() });
        const receiveCallback = async () => {
            const before: GenerationEvent[] = [];
            for (;;) {
                const event = await next();
                if (event.type === "callback") return { event, before };
                before.push(event);
            }
        };
        const answer = (id: string) => ws.send(JSON.stringify({ type: "answer", id, outcome: "answered", value: "t" }));
        const callback = async () => {
            const result = job.channel.callback("editoutput", { text: "t" });
            const received = await receiveCallback();
            answer(received.event.id);
            expect(await result).toMatchObject({ outcome: "answered" });
            return received;
        };
        return { next, snapshot, callback, receiveCallback, answer };
    };
    const owner = await attach(rows);
    const write = (ops: ChatOp[], options?: Parameters<RunningJob["write"]>[1]) =>
        job.write(() => ({ chats: [group(ops)] }), options);
    const receipt = () => [{ kind: "chats", characterId: "c", id: "k", revision: revision() }];
    return { job, store, revision, write, ...owner, attach, receipt };
}

describe("callback chat delivery over the owner socket", () => {
    it("omits unchanged chat frames on three callbacks and keeps the receipt at the last delivered revision", async () => {
        const h = await setup();
        const receipt = h.receipt();
        for (let i = 0; i < 3; i++) {
            const { event, before } = await h.callback();
            expect(before).toEqual([]);
            expect(event.revisions).toEqual(receipt);
        }
    });

    it("sends one checkpoint patch with its new receipt and falls back to a whole chat for reordered rows", async () => {
        const h = await setup();
        const base = h.revision();
        expect((await h.callback()).event.revisions).toEqual(h.receipt());
        h.write([
            { op: "begin", id: "b", generationId: "g" },
            { op: "setText", id: "b", text: "checkpoint", generation: { id: "g", seq: 1 } },
        ]);
        const patched = await h.callback();
        expect(patched.before).toEqual([
            expect.objectContaining({
                type: "chatPatch",
                characterId: "c",
                id: "k",
                baseRevision: base,
                revision: h.revision(),
                messages: [{ after: "a", message: expect.objectContaining({ chatId: "b", data: "checkpoint" }) }],
                count: 2,
            }),
        ]);
        expect(h.revision()).not.toBe(base);
        expect(patched.event.revisions).toEqual(h.receipt());
        h.write([{ op: "remove", ids: ["a"] }]);
        h.write([{ op: "append", messages: [{ chatId: "a", role: "user", data: "A" }], anchor: { end: true } }]);
        const whole = await h.callback();
        expect(whole.before).toEqual([
            expect.objectContaining({
                type: "resource",
                kind: "chats",
                characterId: "c",
                id: "k",
                revision: h.revision(),
                data: expect.objectContaining({
                    message: [
                        expect.objectContaining({ chatId: "b", data: "checkpoint" }),
                        expect.objectContaining({ chatId: "a", data: "A" }),
                    ],
                }),
            }),
        ]);
        expect(whole.event.revisions).toEqual(h.receipt());
    });

    it("sends the whole chat on every callback when the socket did not advertise patch hydration", async () => {
        const h = await setup(false);
        for (let i = 0; i < 3; i++) {
            const { event, before } = await h.callback();
            expect(before).toEqual([
                expect.objectContaining({
                    type: "resource",
                    kind: "chats",
                    characterId: "c",
                    id: "k",
                    revision: h.revision(),
                }),
            ]);
            expect(event.revisions).toEqual(h.receipt());
        }
    });

    it("flushes an own write queued before callback dispatch and delivers it before the callback receipt", async () => {
        const h = await setup();
        const base = h.revision();
        const first = h.job.channel.callback("editoutput", { text: "first" });
        const firstEvent = await h.receiveCallback();
        const second = h.job.channel.callback("editoutput", { text: "second" });
        // The second callback is queued behind the first. Its enqueue-time flush already ran.
        h.job.setPendingFlush!(() => {
            h.job.setPendingFlush!(null);
            h.write([{ op: "meta", set: { note: "queued own write" } }]);
        });
        h.answer(firstEvent.event.id);
        await first;
        const { event, before } = await h.receiveCallback();
        h.answer(event.id);
        await second;
        expect(h.revision()).not.toBe(base);
        expect(before).toEqual([
            expect.objectContaining({
                type: "chatPatch",
                baseRevision: base,
                revision: h.revision(),
                meta: expect.objectContaining({ note: "queued own write" }),
            }),
        ]);
        expect(event.revisions).toEqual(h.receipt());
    });
});

describe("streamed checkpoint rows on the owner socket", () => {
    async function generating() {
        const h = await setup(true, true);
        h.write([{ op: "begin", id: "b", generationId: "g" }]);
        h.job.emit({
            type: "accepted",
            jobId: h.job.id,
            messageId: "b",
            generationId: "g",
            revision: h.revision(),
            text: "B",
        });
        expect(await h.next()).toMatchObject({ type: "chatPatch" });
        expect(await h.next()).toMatchObject({ type: "accepted", seq: 0 });
        h.job.emit({ type: "chunk", messageId: "b", generationId: "g", seq: 1, text: "Raw 😀 reply" });
        expect(await h.next()).toMatchObject({ type: "chunk", seq: 1 });
        return h;
    }

    it("sends raw checkpoints by stream reference only to opted-in sockets, with whole user rows and identical callback receipts regardless of protocol", async () => {
        const h = await generating();
        const baseRevision = h.revision();
        h.write(
            [
                { op: "setText", id: "a", text: "User edit" },
                { op: "setText", id: "b", text: "Raw 😀 reply", generation: { id: "g", seq: 1 } },
            ],
            { covers: [{ messageId: "b", generationId: "g", seq: 1, raw: true }] },
        );
        const revision = h.revision();
        const streamed = { after: "a", id: "b", streamed: { generationId: "g", seq: 1 } };
        const whole = { after: "a", message: { chatId: "b", role: "char", data: "Raw 😀 reply" } };
        const checkpoint = await h.callback();
        expect(checkpoint.before).toEqual([
            expect.objectContaining({
                type: "chatPatch",
                baseRevision,
                revision,
                count: 2,
                messages: [{ after: null, message: { chatId: "a", role: "user", data: "User edit" } }, streamed],
                streaming: [{ messageId: "b", generationId: "g", seq: 1 }],
            }),
        ]);
        const receipt = [{ kind: "chats", characterId: "c", id: "k", revision }];
        expect(checkpoint.event.revisions).toEqual(receipt);
        // Reattach to the same checkpoint: neither proto nor row encoding changes its revision.
        for (const proto of ["1", "garbage", undefined]) {
            for (const rows of [false, true]) {
                const owner = await h.attach(rows, proto);
                expect(owner.snapshot).toMatchObject({
                    type: "chatPatch",
                    revision,
                    messages: [rows ? streamed : whole],
                    streaming: [{ messageId: "b", generationId: "g", seq: 1 }],
                });
                expect(await owner.next()).toMatchObject({ type: "accepted", text: "Raw 😀 reply", seq: 1 });
                const callback = await owner.callback();
                expect(callback.before).toEqual([]);
                expect(callback.event.revisions).toEqual(receipt);
            }
        }
    });

    it.each(["processed text", "rewritten checkpoint", "changed role", "changed name", "released generation"] as const)(
        "sends a whole row after %s even when the socket accepts stream references",
        async (change) => {
            const h = await generating();
            h.write([{ op: "setText", id: "b", text: "Raw 😀 reply", generation: { id: "g", seq: 1 } }], {
                covers: [{ messageId: "b", generationId: "g", seq: 1, raw: true }],
            });
            expect((await h.callback()).before).toEqual([
                expect.objectContaining({
                    messages: [{ after: "a", id: "b", streamed: { generationId: "g", seq: 1 } }],
                }),
            ]);
            const message = {
                chatId: "b",
                role: change === "changed role" ? ("user" as const) : ("char" as const),
                data:
                    change === "processed text" || change === "rewritten checkpoint"
                        ? "Processed reply"
                        : "Raw 😀 reply",
                ...(change === "changed name" ? { name: "Renamed" } : {}),
            };
            h.write(
                [
                    {
                        op: "setMessage",
                        message: change === "rewritten checkpoint" ? { ...message, data: "Raw 😀 reply" } : message,
                        generation: { id: "g", seq: 2, final: change === "released generation" },
                    },
                    ...(change === "rewritten checkpoint"
                        ? [{ op: "setText" as const, id: "b", text: "Processed reply" }]
                        : []),
                ],
                {
                    covers: [
                        {
                            messageId: "b",
                            generationId: "g",
                            seq: 1,
                            ...(change === "processed text" ? {} : { raw: true as const }),
                        },
                    ],
                },
            );
            const result = await h.callback();
            expect(result.before).toEqual([
                expect.objectContaining({
                    type: "chatPatch",
                    revision: h.revision(),
                    messages: [{ after: "a", message }],
                    streaming: change === "released generation" ? [] : [{ messageId: "b", generationId: "g", seq: 1 }],
                }),
            ]);
            expect(result.event.revisions).toEqual(h.receipt());
        },
    );
});
