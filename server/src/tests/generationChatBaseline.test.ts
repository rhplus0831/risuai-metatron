// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import type { ChatOp } from "../../../shared/chats.ts";
import type { Chat, Message } from "../../../shared/database.ts";
import type { GenerationChatPatchEvent, GenerationEvent } from "../../../shared/jobs.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { createSnapshotManager } from "../data/snapshots.ts";
import { chatBaseline, createGenerationJobs, diffChat, type RunningJob } from "../jobs/generationJobs.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";
import { chatMetadataFor, flushChatMetadata, loadJobScope } from "../jobs/jobScope.ts";
import { allowListenerOrigin } from "./testSupport.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

const ref = { characterId: "c", id: "k" };
const message = (chatId: string, data = chatId): Message => ({ chatId, role: "char", data });
const checkpoint = (seq: number, text: string): ChatOp => ({
    op: "setText",
    id: "b",
    text,
    generation: { id: "g", seq },
});
type Copy = { revision: string; data: Chat };
type Owner = { ws: WsClient; closed: Promise<void>; next(): Promise<GenerationEvent> };

/** A small client mirror: remove ids, place carried rows at their anchors, replace metadata. */
function applyPatch(copy: Copy, patch: GenerationChatPatchEvent): Copy {
    expect([patch.baseRevision, patch.revision]).toContain(copy.revision);
    const data = structuredClone(copy.data);
    const removed = new Set(patch.removed ?? []);
    const messages = data.message.filter((row) => !removed.has(row.chatId!));
    for (const row of patch.messages ?? []) {
        // These sockets never advertise `rows=streamed`: every carried row is whole.
        if (!("message" in row)) throw new Error(`unexpected streamed row ${row.id}`);
        const incoming = row.message as Message;
        const previous = messages.findIndex((item) => item.chatId === incoming.chatId);
        if (previous !== -1) messages.splice(previous, 1);
        const anchor = row.after === null ? -1 : messages.findIndex((item) => item.chatId === row.after);
        if (row.after !== null) expect(anchor, `missing anchor ${row.after}`).toBeGreaterThanOrEqual(0);
        messages.splice(anchor + 1, 0, structuredClone(incoming));
    }
    expect(messages).toHaveLength(patch.count);
    return { revision: patch.revision, data: { ...(patch.meta ?? data), message: messages } as Chat };
}

async function setup() {
    // Freeze production deadlines, leaving socket I/O and runner latches event driven.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const prepare = DatabaseSync.prototype.prepare;
    let wholeReads = 0;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql) {
        const statement = prepare.call(this, sql);
        if (sql === "SELECT data FROM messages WHERE chatSeq = ? ORDER BY position") {
            const all = statement.all;
            statement.all = function (...args) {
                wholeReads++;
                return Reflect.apply(all, this, args);
            };
        }
        return statement;
    });
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-chat-baseline-"));
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const lock = createGenerationLock();
    const store = createResourceStore({ file: ":memory:", kinds, guard: lock });
    const snapshots = createSnapshotManager({ store, dir });
    const first = (name: string) => (store.get(kinds.get(name)!, "main")!.data as { id: string }[])[0].id;
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
                        note: "A",
                        localLore: [],
                        fmIndex: -1,
                        modelPresetId: bound.modelPresetId,
                        promptPresetId: bound.presetId,
                        bindedPersona: bound.personaId,
                        message: [message("a", "A"), message("b", "B")],
                    },
                },
            ]),
        ],
    });
    const read = (): Copy => {
        const chat = store.readRefs([], { chats: [ref] }).chats[0];
        if (!chat.data || !chat.revision) throw new Error("Fixture chat disappeared");
        return { revision: chat.revision, data: chat.data };
    };
    let held = read();
    const generated = new Set<string>();
    type Step = (job: RunningJob) => void | "end";
    const steps: Step[] = [];
    let wake: (() => void) | undefined;
    const jobs = createGenerationJobs({
        store,
        kinds,
        snapshots,
        gate: snapshots.gate,
        lock,
        authorize: async () => true,
        runner: async (job) => {
            const onAbort = () => wake?.();
            job.signal.addEventListener("abort", onAbort);
            try {
                while (!job.signal.aborted) {
                    if (!steps.length)
                        await new Promise<void>((resolve) => {
                            wake = resolve;
                        });
                    wake = undefined;
                    if (job.signal.aborted) return;
                    if (steps.shift()?.(job) === "end") return;
                }
            } finally {
                job.signal.removeEventListener("abort", onAbort);
            }
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
    // A step resolves only after the runner has done its writes and emits, including without a socket.
    const step = (fn: Step) =>
        new Promise<void>((resolve, reject) => {
            steps.push((job) => {
                try {
                    const result = fn(job);
                    resolve();
                    return result;
                } catch (error) {
                    reject(error);
                }
            });
            wake?.();
        });
    const context = { characterId: "c", chatId: "k", ...bound, mode: "normal", input: "", chatRevision: revision() };
    const created = jobs.create({ kind: "send", context, clientId: "tab" }, store.epoch());
    if (!created.ok) throw new Error(`Admission failed: ${JSON.stringify(created.body)}`);
    const listener = createServer();
    listener.on("upgrade", (req, socket, head) => jobs.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    allowListenerOrigin(listener);
    cleanups.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
    const { port } = listener.address() as { port: number };
    const follow = async () => {
        const ws = new WsClient(`ws://127.0.0.1:${port}/api/generations/${created.jobId}/ws?clientId=tab`);
        const events: GenerationEvent[] = [];
        const waiters: ((event: GenerationEvent) => void)[] = [];
        const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
        ws.on("message", (data) => {
            const event = JSON.parse(String(data)) as GenerationEvent;
            if (event.type === "ping") return;
            const waiting = waiters.shift();
            if (waiting) waiting(event);
            else events.push(event);
            if (event.type === "done" || event.type === "error") ws.close();
        });
        cleanups.push(async () => {
            ws.close();
            await closed;
        });
        await new Promise<void>((resolve, reject) => {
            ws.once("open", resolve);
            ws.once("error", reject);
        });
        const next = () =>
            events.length
                ? Promise.resolve(events.shift()!)
                : new Promise<GenerationEvent>((resolve) => waiters.push(resolve));
        // Every attach opens with the owner's role, before the attach chat the callers check next.
        expect(await next()).toEqual({ type: "handoff", epoch: store.epoch(), owner: "self" });
        return { ws, closed, next };
    };
    const resetReads = () => {
        wholeReads = 0;
    };
    const expectPatch = async (owner: Owner, reads = 0) => {
        const event = await owner.next();
        expect(event.type).toBe("chatPatch");
        if (event.type !== "chatPatch") throw new Error(`Expected patch, got ${event.type}`);
        // The fresh-read oracle must not be included in the measured region.
        expect(wholeReads, "whole-transcript reads before the oracle").toBe(reads);
        const fresh = read();
        const { type, epoch, characterId, id, baseRevision, revision: nextRevision, streaming, ...body } = event;
        expect({ type, epoch, characterId, id, baseRevision, revision: nextRevision }).toEqual({
            type: "chatPatch",
            epoch: store.epoch(),
            ...ref,
            baseRevision: held.revision,
            revision: fresh.revision,
        });
        expect(body).toEqual(
            diffChat(chatBaseline(held.revision, held.data), chatBaseline(fresh.revision, fresh.data), generated),
        );
        expect(applyPatch(held, event)).toEqual(fresh);
        expect(applyPatch(fresh, event)).toEqual(fresh);
        held = fresh;
        resetReads();
        return event;
    };
    const expectWhole = async (owner: Owner, reads = 1) => {
        const event = await owner.next();
        expect(wholeReads, "whole-transcript reads before the oracle").toBe(reads);
        const fresh = read();
        expect(event).toMatchObject({ type: "resource", kind: "chats", epoch: store.epoch(), ...ref, ...fresh });
        held = fresh;
        resetReads();
        return fresh;
    };
    const write = (job: RunningJob, ops: ChatOp[]) => job.write(() => ({ chats: [group(ops)] }));
    const emit = (job: RunningJob) => job.emitRecords({ chats: [ref] });
    resetReads();
    const owner = await follow();
    await expectPatch(owner);
    return {
        store,
        kinds,
        jobs,
        context,
        group,
        read,
        step,
        write,
        emit,
        generated,
        follow,
        owner,
        expectPatch,
        expectWhole,
        resetReads,
        reads: () => wholeReads,
    };
}

const rows = (patch: GenerationChatPatchEvent) =>
    (patch.messages ?? []).map((entry) => {
        if (!("message" in entry)) throw new Error(`unexpected streamed row ${entry.id}`);
        const row = entry.message as Message;
        return [row.chatId, entry.after, row.data];
    });

describe("owner chat working baselines", () => {
    it("sends checkpoints and a metadata flush without rereading the transcript", async () => {
        const h = await setup();
        h.generated.add("b");
        await h.step((job) => {
            h.write(job, [{ op: "begin", id: "b", generationId: "g" }, checkpoint(1, "one")]);
            h.emit(job);
        });
        const first = await h.expectPatch(h.owner);
        expect(rows(first)).toEqual([["b", "a", "one"]]);
        expect(first).not.toHaveProperty("meta");
        let scope!: ReturnType<typeof loadJobScope>;
        await h.step(() => {
            scope = loadJobScope(h.store, h.kinds, h.context);
        });
        h.resetReads();
        await h.step((job) => {
            chatMetadataFor(job, h.store, scope).queue(
                { note: "flushed", scriptstate: { $own: "kept" } },
                (error) => error,
            );
            flushChatMetadata(job);
        });
        const meta = await h.expectPatch(h.owner);
        expect(meta.meta).toMatchObject({ note: "flushed", scriptstate: { $own: "kept" } });
        expect(rows(meta)).toEqual([["b", "a", "one"]]);
        await h.step((job) => {
            h.write(job, [checkpoint(2, "two")]);
            h.emit(job);
        });
        const second = await h.expectPatch(h.owner);
        expect(rows(second)).toEqual([["b", "a", "two"]]);
        expect(second).not.toHaveProperty("meta");
    });

    it("uses final anchors when inserts precede each other or their original anchor is removed", async () => {
        const h = await setup();
        await h.step((job) => {
            h.write(job, [{ op: "append", messages: [message("x")], anchor: { after: "a" } }]);
            h.write(job, [{ op: "append", messages: [message("y")], anchor: { after: "a" } }]);
            h.emit(job);
        });
        const inserted = await h.expectPatch(h.owner);
        expect(rows(inserted)).toEqual([
            ["y", "a", "y"],
            ["x", "y", "x"],
        ]);
        expect(h.read().data.message.map((row) => row.chatId)).toEqual(["a", "y", "x", "b"]);
        h.resetReads();
        // Return to [a, b], then compose an insertion with the removal of its original anchor.
        await h.step((job) => {
            h.write(job, [{ op: "remove", ids: ["x", "y"] }]);
            h.emit(job);
        });
        await h.expectPatch(h.owner);
        await h.step((job) => {
            h.write(job, [{ op: "append", messages: [message("x")], anchor: { after: "a" } }]);
            h.write(job, [{ op: "remove", ids: ["a"] }]);
            h.emit(job);
        });
        const removed = await h.expectPatch(h.owner);
        expect(rows(removed)).toEqual([["x", null, "x"]]);
        expect(removed.removed).toEqual(["a"]);
    });

    it("omits transient rows and reverted text and metadata but carries untouched generated rows", async () => {
        const h = await setup();
        h.generated.add("b");
        await h.step((job) => {
            h.write(job, [{ op: "begin", id: "b", generationId: "g" }]);
            h.emit(job);
        });
        expect(rows(await h.expectPatch(h.owner))).toEqual([["b", "a", "B"]]);
        await h.step((job) => {
            h.write(job, [
                { op: "append", messages: [message("temporary")], anchor: { end: true } },
                { op: "setText", id: "a", text: "B" },
                { op: "meta", set: { note: "B" } },
            ]);
            h.write(job, [
                { op: "remove", ids: ["temporary"] },
                { op: "setText", id: "a", text: "A" },
                { op: "meta", set: { note: "A" } },
            ]);
            h.emit(job);
        });
        const patch = await h.expectPatch(h.owner);
        expect(rows(patch)).toEqual([["b", "a", "B"]]);
        expect(patch).not.toHaveProperty("removed");
        expect(patch).not.toHaveProperty("meta");
        expect(patch.count).toBe(2);
    });

    it("sends a reordered remove-and-reappend whole and reseeds after a write without a by-id change", async () => {
        const h = await setup();
        await h.step((job) => {
            h.write(job, [{ op: "remove", ids: ["a"] }]);
            h.write(job, [{ op: "append", messages: [message("a", "A")], anchor: { end: true } }]);
            h.emit(job);
        });
        const reordered = await h.expectWhole(h.owner);
        expect(reordered.data.message.map((row) => row.chatId)).toEqual(["b", "a"]);
        await h.step((job) => {
            h.write(job, [{ op: "replace", chat: { ...reordered.data, note: "replacement" } }]);
            h.emit(job);
        });
        expect((await h.expectPatch(h.owner, 1)).meta).toMatchObject({ note: "replacement" });
        await h.step((job) => {
            h.write(job, [{ op: "setText", id: "a", text: "after replacement" }]);
            h.emit(job);
        });
        expect(rows(await h.expectPatch(h.owner))).toEqual([["a", "b", "after replacement"]]);
    });

    it("reads and diffs foreign by-id writes between own writes and after the last own write", async () => {
        const h = await setup();
        await h.step((job) => {
            h.write(job, [{ op: "setText", id: "b", text: "own one" }]);
            h.store.applyChanges({ chats: [h.group([{ op: "setText", id: "a", text: "foreign between" }])] });
            h.write(job, [{ op: "setText", id: "b", text: "own two" }]);
            h.emit(job);
        });
        expect(rows(await h.expectPatch(h.owner, 1))).toEqual([
            ["a", null, "foreign between"],
            ["b", "a", "own two"],
        ]);
        await h.step((job) => {
            h.write(job, [{ op: "setText", id: "b", text: "own three" }]);
            h.emit(job);
        });
        await h.expectPatch(h.owner);
        await h.step((job) => {
            h.write(job, [{ op: "setText", id: "b", text: "own four" }]);
            h.store.applyChanges({ chats: [h.group([{ op: "setText", id: "a", text: "foreign after" }])] });
            h.emit(job);
        });
        expect(rows(await h.expectPatch(h.owner, 1))).toEqual([
            ["a", null, "foreign after"],
            ["b", "a", "own four"],
        ]);
    });

    it("keeps unsent checkpoints across detach, reseeds on attach and resync, and sends whole after the end", async () => {
        const h = await setup();
        h.generated.add("b");
        await h.step((job) => {
            h.write(job, [{ op: "begin", id: "b", generationId: "g" }]);
            h.emit(job);
        });
        await h.expectPatch(h.owner);
        h.owner.ws.close();
        await h.owner.closed;
        await h.step((job) => {
            expect(job.ownerAttached()).toBe(false);
            h.write(job, [checkpoint(1, "one"), { op: "append", messages: [message("x")], anchor: { after: "a" } }]);
            expect(h.emit(job)).toEqual([]);
            h.write(job, [checkpoint(2, "two"), { op: "meta", set: { note: "offline" } }]);
            expect(h.emit(job)).toEqual([]);
        });
        expect(h.reads()).toBe(0);
        let owner = await h.follow();
        const reattached = await h.expectPatch(owner);
        expect(rows(reattached)).toEqual([
            ["x", "a", "x"],
            ["b", "x", "two"],
        ]);
        expect(reattached.meta).toMatchObject({ note: "offline" });
        owner.ws.close();
        await owner.closed;
        // A whole write has no stored by-id change. Attach must read it and seed later checkpoints.
        const replacement = h.read().data;
        h.resetReads();
        await h.step((job) => {
            h.write(job, [{ op: "replace", chat: { ...replacement, note: "attach read" } }]);
        });
        owner = await h.follow();
        expect((await h.expectPatch(owner, 1)).meta).toMatchObject({ note: "attach read" });
        await h.step((job) => {
            h.write(job, [
                { op: "begin", id: "b", generationId: "next" },
                { op: "setText", id: "a", text: "after attach" },
            ]);
            h.emit(job);
        });
        await h.expectPatch(owner);
        // Leave a foreign revision outside the working baseline before requesting the whole copy.
        h.store.applyChanges({ chats: [h.group([{ op: "setText", id: "a", text: "before resync" }])] });
        owner.ws.send(JSON.stringify({ type: "resync" }));
        const resynced = await h.expectWhole(owner);
        await h.step((job) => {
            h.write(job, [{ op: "meta", set: { note: "after resync" } }]);
            h.emit(job);
        });
        const afterResync = await h.expectPatch(owner);
        expect(afterResync.baseRevision).toBe(resynced.revision);
        expect(rows(afterResync)).toEqual([["b", "x", "two"]]);
        await h.step((job) => {
            job.emit({ type: "done", revision: h.store.chatRevision("c", "k") });
            return "end";
        });
        const terminalPatch = await h.expectPatch(owner);
        expect(terminalPatch.streaming).toEqual([]);
        expect((await owner.next()).type).toBe("done");
        await owner.closed;
        const afterEnd = await h.follow();
        await h.expectWhole(afterEnd);
        expect((await afterEnd.next()).type).toBe("done");
        await afterEnd.closed;
    });
});
