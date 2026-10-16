// @vitest-environment node
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
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
import { waitFor } from "./testSupport.ts";

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
    return { job, store, attach, emit, write, group, admitted, reads: () => messageReads };
}

describe("metadata delivery to the job owner", () => {
    it.each([false, true])(
        "sends metadata and any generated rows without reading messages (generating=%s)",
        async (generating) => {
            const h = await setup();
            const owner = await h.attach();
            let baseline = h.admitted;
            if (generating) {
                h.write([{ op: "begin", id: "r", generationId: "g" }]);
                h.emit();
                await waitFor(() => owner.events.length === 2);
                baseline = h.store.chatRevision("c", "k")!;
            }
            const count = owner.events.length;
            const before = h.reads();
            h.write([{ op: "meta", set: { note: "author note", scriptstate: { $x: "1" } } }]);
            const receipts = h.emit();
            await waitFor(() => owner.events.length === count + 1);
            expect(h.reads() - before).toBe(0);
            const patch = owner.events.at(-1)!;
            expect(patch).toMatchObject({
                type: "chatPatch",
                baseRevision: baseline,
                revision: h.store.chatRevision("c", "k"),
                count: 2,
                meta: { note: "author note", scriptstate: { $x: "1" } },
            });
            if (patch.type !== "chatPatch") throw new Error("expected chatPatch");
            expect(patch.meta).not.toHaveProperty("message");
            expect(patch.messages ?? []).toEqual(
                generating ? [{ after: "u", message: { role: "char", chatId: "r", data: "reply" } }] : [],
            );
            expect(patch.streaming).toEqual(generating ? [{ messageId: "r", generationId: "g", seq: 0 }] : []);
            expect(receipts).toEqual([{ kind: "chats", characterId: "c", id: "k", revision: patch.revision }]);
        },
    );

    it("falls back to the full patch when the socket missed another writer's message change", async () => {
        const h = await setup();
        const owner = await h.attach();
        h.store.applyChanges({ chats: [h.group([{ op: "setText", id: "u", text: "other tab" }])] });
        const before = h.reads();
        // This own write is current, but its base is newer than the socket's last taken revision.
        h.write([{ op: "meta", set: { note: "own" } }]);
        h.emit();
        await waitFor(() => owner.events.length === 2);
        expect(h.reads() > before, "the changed transcript must be read").toBe(true);
        expect(owner.events[1]).toMatchObject({
            type: "chatPatch",
            baseRevision: h.admitted,
            revision: h.store.chatRevision("c", "k"),
            meta: { note: "own" },
            messages: [{ after: null, message: { chatId: "u", data: "other tab" } }],
        });
    });

    it("builds nothing without an open socket and reconnects from the last taken copy", async () => {
        const h = await setup();
        const owner = await h.attach();
        h.write([{ op: "meta", set: { note: "taken" } }]);
        h.emit();
        await waitFor(() => owner.events.length === 2);
        const lastTaken = h.store.chatRevision("c", "k")!;
        await owner.close();
        const before = h.reads();
        h.write([{ op: "meta", set: { note: "missed", scriptstate: { $x: "offline" } } }]);
        expect(h.emit()).toEqual([]);
        expect(h.reads() - before).toBe(0);
        expect(owner.events).toHaveLength(2);
        const reattached = await h.attach();
        expect(reattached.events[0]).toMatchObject({
            type: "chatPatch",
            baseRevision: lastTaken,
            revision: h.store.chatRevision("c", "k"),
            meta: { note: "missed", scriptstate: { $x: "offline" } },
        });
    });
});
