// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as WsClient } from "ws";
import { normalizeCharacter } from "../../../shared/characters.ts";
import type { ChatOp } from "../../../shared/chats.ts";
import type { loreBook } from "../../../shared/database.ts";
import { GENERATION_KINDS, NO_GENERATION_HOOKS, type GenerationEvent } from "../../../shared/jobs.ts";
import { createGenerationReceipts } from "../data/generationReceipts.ts";
import { createChannelHub } from "../jobs/channel.ts";
import { type ChangeFeedEvent, createChangeFeed } from "../data/changeFeed.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { CommittedWriteError, createResourceStore, type ResourceStore } from "../data/resourceStore.ts";
import { createSnapshotManager, type SnapshotManager } from "../data/snapshots.ts";
import {
    createGenerationJobs,
    failureOf,
    GenerationJobEndedError,
    GenerationRunnerError,
    type GenerationRunner,
    JOB_ABORT_GRACE_MS,
    JOB_DONE_GRACE_MS,
    JobWriteConflictError,
    KEPT_OUTCOME_MS,
    markFailure,
    MAX_KEPT_MESSAGE_BYTES,
    MAX_KEPT_OUTCOMES,
    type RunningJob,
} from "../jobs/generationJobs.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";
import { installSnapshot } from "./stagedRestore.ts";
import { allowListenerOrigin, sleep, waitFor } from "./testSupport.ts";

/** A promise with its settle functions (`Promise.withResolvers` is newer than the server's `lib`). */
function withResolvers<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

// The generation job registry (`server/src/jobs/generationJobs.ts`) in process, with a fake runner
// per test: admission, the job's write capability (lock handoff, rollback, the one F-b retry, the
// fence outcomes), the end of a job (one terminal, dead capabilities, released locks and slot), the
// abort deadline, the outcome kept after the job is collected, maintenance, and shutdown. The routes
// and the owner socket are covered by `generations.test.ts`.

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const characters = kinds.get("characters")!;
const m = (id: string, data = "", role: "user" | "char" = "user") => ({ role, data, chatId: id });
const ref = { characterId: "c", chatId: "k" };
const group = (baseRevision: string | null, ops: ChatOp[], chatId = "k") => ({
    characterId: "c",
    chatId,
    baseRevision,
    ops,
});
const begin = (id: string, generationId: string): ChatOp => ({ op: "begin", id, generationId });
/** Resolves when the job's signal aborts (at once if it already did: a runner may start after a DELETE). */
const aborted = (job: RunningJob) =>
    new Promise<void>((resolve) => {
        if (job.signal.aborted) {
            resolve();
        } else {
            job.signal.addEventListener("abort", () => resolve());
        }
    });
const checkpoint = (id: string, generationId: string, seq: number, text: string, final = false): ChatOp => ({
    op: "setText",
    id,
    text,
    generation: { id: generationId, seq, final },
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    vi.useRealTimers();
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

/**
 * `feed`: build the store with the change feed and record what it publishes (`events`). `failCommitted`:
 * while `current`, the store the jobs write through throws from a write's `committed` hook after the
 * job's own bookkeeping ran (a `CommittedWriteError`).
 */
function setup(
    options: {
        feed?: boolean;
        failCommitted?: { current: boolean };
        now?: () => number;
        receipts?: boolean;
        clientName?: (clientId: string) => string | undefined;
    } = {},
) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-generation-jobs-"));
    const lock = createGenerationLock();
    const feed = options.feed ? createChangeFeed() : undefined;
    const events: ChangeFeedEvent[] = [];
    feed?.subscribe((event) => events.push(event));
    const store: ResourceStore = createResourceStore({
        file: path.join(dir, "data", "resources.sqlite"),
        kinds,
        guard: lock,
        feed,
    });
    const failing = options.failCommitted;
    const jobStore: ResourceStore = failing
        ? Object.assign(Object.create(store) as ResourceStore, {
              applyChanges: ((batch, writeOptions) =>
                  store.applyChanges(batch, {
                      ...writeOptions,
                      committed:
                          writeOptions?.committed &&
                          ((applied, written) => {
                              const lists = writeOptions.committed!(applied, written);
                              if (failing.current) {
                                  throw new Error("bookkeeping failed");
                              }
                              return lists;
                          }),
                  })) satisfies ResourceStore["applyChanges"],
          })
        : store;
    const snapshots: SnapshotManager = createSnapshotManager({ store, dir: path.join(dir, "backups") });
    const handoffs: unknown[] = [];
    const receipts = options.receipts
        ? createGenerationReceipts({ file: path.join(dir, "receipts.sqlite"), epoch: store.epoch(), now: options.now })
        : undefined;
    let runner: GenerationRunner = async () => {};
    const jobs = createGenerationJobs({
        store: jobStore,
        kinds,
        gate: snapshots.gate,
        snapshots,
        lock,
        authorize: async () => true,
        runner: (job) => runner(job),
        now: options.now,
        hub: createChannelHub({ now: options.now }),
        receipts,
        publishHandoff: (event) => handoffs.push(event),
        clientName: options.clientName,
    });
    cleanups.push(async () => {
        jobs.beginShutdown();
        await jobs.drain();
        jobs.dispose();
        await snapshots.stop();
        receipts?.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
    });
    // The chats' binding: the default records' ids, which every job names.
    const firstId = (name: string) => (store.get(kinds.get(name)!, "main")!.data as { id: string }[])[0].id;
    const bound = {
        presetId: firstId("presets"),
        modelPresetId: firstId("modelPresets"),
        personaId: firstId("personas"),
    };
    const binding = {
        modelPresetId: bound.modelPresetId,
        promptPresetId: bound.presetId,
        bindedPersona: bound.personaId,
    };
    store.applyChanges({
        ops: [{ kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
        chats: [
            group(null, [
                { op: "create", chat: { name: "K", ...binding, message: [m("u", "hi"), m("r", "", "char")] } as never },
            ]),
            group(null, [{ op: "create", chat: { name: "J", ...binding, message: [m("x", "X")] } as never }], "j"),
            // No binding: cannot be sent.
            group(null, [{ op: "create", chat: { name: "Loose", message: [m("y", "Y")] } as never }], "loose"),
        ],
    });
    const revision = () => store.chatRevision("c", "k")!;
    const text = (id: string) =>
        store
            .readRefs([], { chats: [{ characterId: "c", id: "k" }] })
            .chats[0].data!.message.find((entry) => entry.chatId === id)!.data;
    const context = (input = "") => ({
        characterId: "c",
        chatId: "k",
        ...bound,
        mode: "normal",
        input,
        chatRevision: revision(),
    });
    /** Creates a job for chat k owned by `tab` and returns its id (the create must succeed). */
    const create = (input = "", kind: "send" | "command" = "send") => {
        // A command job carries what it runs; the body is a union by kind, so each branch names its
        // kind.
        const result = jobs.create(
            kind === "command"
                ? { kind, context: context(input), clientId: "tab", command: { type: "button", data: "" } }
                : { kind, context: context(input), clientId: "tab" },
            store.epoch(),
        );
        if (!result.ok) {
            throw new Error(`create: ${result.status} ${JSON.stringify(result.body)}`);
        }
        return result.jobId;
    };
    /** Installs the runner and resolves (or rejects) with what it returned once the runner settled. */
    const run = <T>(fn: (job: RunningJob) => Promise<T>) => {
        let settle!: { resolve: (value: T) => void; reject: (error: unknown) => void };
        const outcome = new Promise<T>((resolve, reject) => {
            settle = { resolve, reject };
        });
        runner = async (job) => {
            try {
                settle.resolve(await fn(job));
            } catch (error) {
                settle.reject(error);
                throw error;
            }
        };
        return outcome;
    };
    const ended = (jobId: string) => waitFor(() => jobs.status(jobId, "tab")?.state === "ended");
    const owner = (messageId: string) => lock.ownerOf({ ...ref, messageId })?.generationId ?? null;
    /** Follows the registry's owner stream; a ping fences the snapshot and any preceding emits. */
    const follow = async (jobId: string, clientId = "tab", query = "") => {
        const listener = createServer();
        listener.on("upgrade", (req, socket, head) => jobs.handleUpgrade(req, socket, head));
        await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
        allowListenerOrigin(listener);
        cleanups.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
        const { port } = listener.address() as { port: number };
        const ws = new WsClient(`ws://127.0.0.1:${port}/api/generations/${jobId}/ws?clientId=${clientId}${query}`);
        const events: GenerationEvent[] = [];
        const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
        const waiters = new Set<() => void>();
        ws.on("message", (data) => {
            const event = JSON.parse(String(data)) as GenerationEvent;
            if (event.type !== "ping") {
                events.push(event);
            }
            for (const notify of waiters) notify();
        });
        cleanups.push(async () => {
            ws.close();
            await closed;
        });
        await new Promise<void>((resolve, reject) => {
            ws.once("open", resolve);
            ws.once("error", reject);
        });
        const fence = () =>
            new Promise<void>((resolve, reject) => {
                const onClose = () => reject(new Error("fence: the socket closed before the pong"));
                ws.once("close", onClose);
                ws.once("pong", () => {
                    ws.off("close", onClose);
                    resolve();
                });
                ws.ping();
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
            events,
            fence,
            ws,
            until,
            closed,
            close: async () => {
                ws.close();
                await closed;
            },
        };
    };
    return {
        dir,
        handoffs,
        receipts,
        lock,
        store,
        snapshots,
        jobs,
        revision,
        text,
        context,
        create,
        run,
        ended,
        owner,
        bound,
        events,
        follow,
    };
}

describe("the presentation stage", () => {
    it("sends a repeated stage once and sends each changed stage to the owner", async () => {
        const { store, create, run, follow } = setup();
        let ready!: (job: RunningJob) => void;
        const started = new Promise<RunningJob>((resolve) => {
            ready = resolve;
        });
        run(async (job) => {
            ready(job);
            await aborted(job);
        });
        const jobId = create();
        const job = await started;
        const owner = await follow(jobId);
        for (const stage of ["preparing", "preparing", "memory", "memory", "generating", "finishing"] as const) {
            job.emit({ type: "stage", stage });
        }
        await owner.fence();
        expect(owner.events.filter((event) => event.type === "stage")).toEqual([
            { type: "stage", epoch: store.epoch(), stage: "preparing" },
            { type: "stage", epoch: store.epoch(), stage: "memory" },
            { type: "stage", epoch: store.epoch(), stage: "generating" },
            { type: "stage", epoch: store.epoch(), stage: "finishing" },
        ]);
    });

    it("replays the current stage on a late attach after the preset and before the current reply", async () => {
        const { store, create, run, follow, revision, bound } = setup();
        let ready!: () => void;
        const started = new Promise<void>((resolve) => {
            ready = resolve;
        });
        run(async (job) => {
            job.emit({ type: "stage", stage: "preparing" });
            job.emit({ type: "preset", presetId: bound.presetId });
            job.emit({ type: "stage", stage: "memory" });
            job.write(() => ({ chats: [group(revision(), [begin("r", "g1")])] }));
            job.emit({
                type: "accepted",
                jobId: job.id,
                messageId: "r",
                generationId: "g1",
                revision: revision(),
                text: "",
            });
            job.emit({ type: "chunk", messageId: "r", generationId: "g1", text: "one two", seq: 1 });
            job.emit({ type: "stage", stage: "generating" });
            ready();
            await aborted(job);
        });
        const jobId = create();
        await started;
        const owner = await follow(jobId);
        await owner.fence();
        const snapshot = owner.events.filter(
            (event) => event.type === "preset" || event.type === "stage" || event.type === "accepted",
        );
        expect(snapshot.map((event) => event.type)).toEqual(["preset", "stage", "accepted"]);
        expect(snapshot[0]).toEqual({ type: "preset", epoch: store.epoch(), presetId: bound.presetId });
        expect(snapshot[1]).toEqual({ type: "stage", epoch: store.epoch(), stage: "generating" });
        expect(snapshot[2]).toMatchObject({ type: "accepted", messageId: "r", text: "one two", seq: 1 });
    });

    it("omits the stage from the snapshot when the job ended before its owner attached", async () => {
        const { store, create, run, follow, revision, bound } = setup();
        const outcome = run(async (job) => {
            job.emit({ type: "preset", presetId: bound.presetId });
            job.emit({ type: "stage", stage: "finishing" });
            job.emit({ type: "done", revision: revision() });
        });
        const jobId = create();
        await outcome;
        const owner = await follow(jobId);
        await owner.fence();
        expect(owner.events.filter((event) => event.type === "stage")).toEqual([]);
        expect(owner.events.at(-1)).toEqual({ type: "done", epoch: store.epoch(), revision: revision() });
    });
});

describe("admission", () => {
    const lore = (id: string, comment = "", key = ""): loreBook => ({
        id,
        comment,
        key,
        secondkey: "",
        content: "Frozen lore",
        insertorder: 100,
        mode: "normal",
        alwaysActive: false,
        selective: false,
    });

    it("checks the epoch, the chat, a running job (before staleness), and the revision, in that order", async () => {
        const { jobs, store, context, create, run, ended } = setup();
        const stale = { ...context(), chatRevision: "00000000-0000-4000-8000-000000000000:1:1" };
        expect(jobs.create({ kind: "send", context: stale, clientId: "tab" }, "wrong")).toMatchObject({
            ok: false,
            status: 412,
            body: { error: "EpochMismatch", epoch: store.epoch() },
        });
        expect(
            jobs.create({ kind: "send", context: { ...context(), chatId: "nope" }, clientId: "tab" }, store.epoch()),
        ).toMatchObject({ ok: false, status: 404 });
        expect(jobs.create({ kind: "send", context: stale, clientId: "tab" }, store.epoch())).toMatchObject({
            ok: false,
            status: 409,
            body: { error: "stale" },
        });
        const finished = run(async (job) => {
            await aborted(job);
        });
        const jobId = create();
        // Busy wins over stale: a reloaded tab with an old revision still learns the job id.
        expect(jobs.create({ kind: "send", context: stale, clientId: "other" }, store.epoch())).toEqual({
            ok: false,
            status: 409,
            body: { error: "chatBusy", jobId },
        });
        // A command job takes the slot too; another chat is free.
        expect(
            jobs.create(
                { kind: "command", context: context(), clientId: "tab", command: { type: "button", data: "" } },
                store.epoch(),
            ),
        ).toMatchObject({
            ok: false,
            status: 409,
        });
        const other = jobs.create(
            {
                kind: "send",
                context: { ...context(), chatId: "j", chatRevision: store.chatRevision("c", "j")! },
                clientId: "tab",
            },
            store.epoch(),
        );
        expect(other.ok).toBe(true);
        expect(jobs.status(jobId, "tab")).toEqual({
            jobId,
            kind: "send",
            characterId: "c",
            chatId: "k",
            epoch: store.epoch(),
            state: "running",
        });
        expect(jobs.status(jobId, "other")).toBeNull();
        expect(jobs.abort(jobId, "other")).toBeNull();
        expect(jobs.abort(jobId, "tab")).toBe(true);
        await finished;
        await ended(jobId);
        expect(jobs.abort(jobId, "tab")).toBe(false);
        // The slot is free again once the job ended.
        expect(jobs.create({ kind: "send", context: context(), clientId: "tab" }, store.epoch()).ok).toBe(true);
    });

    // A job of any kind runs on its chat's complete binding or not at all.
    it("refuses a chat whose binding is not complete (with its problems) or whose ids differ from the context's, after busy and stale, for a preview too", async () => {
        const { jobs, store, context, create, run, ended } = setup();
        const loose = { ...context(), chatId: "loose", chatRevision: store.chatRevision("c", "loose")! };
        const incomplete = {
            ok: false,
            status: 409,
            body: {
                error: "chatBindingIncomplete",
                problems: [
                    { field: "modelPresetId", reason: "unset" },
                    { field: "promptPresetId", reason: "unset" },
                    { field: "personaId", reason: "unset" },
                ],
            },
        };
        expect(jobs.create({ kind: "send", context: loose, clientId: "tab" }, store.epoch())).toEqual(incomplete);
        expect(jobs.create({ kind: "preview", context: loose, clientId: "tab" }, store.epoch())).toEqual(incomplete);
        expect(
            jobs.create(
                { kind: "command", context: loose, clientId: "tab", command: { type: "button", data: "" } },
                store.epoch(),
            ),
        ).toEqual(incomplete);
        const other = { ...context(), personaId: "other" };
        expect(jobs.create({ kind: "send", context: other, clientId: "tab" }, store.epoch())).toEqual({
            ok: false,
            status: 409,
            body: { error: "chatBindingMismatch" },
        });
        expect(jobs.create({ kind: "previewPrompt", context: other, clientId: "tab" }, store.epoch())).toMatchObject({
            status: 409,
            body: { error: "chatBindingMismatch" },
        });
        // Staleness and a running job are answered first (a reloaded tab learns the job id).
        expect(
            jobs.create(
                {
                    kind: "send",
                    context: { ...other, chatRevision: "00000000-0000-4000-8000-000000000000:1:1" },
                    clientId: "tab",
                },
                store.epoch(),
            ),
        ).toMatchObject({ status: 409, body: { error: "stale" } });
        const finished = run(async (job) => {
            await aborted(job);
        });
        const jobId = create();
        expect(jobs.create({ kind: "send", context: other, clientId: "other" }, store.epoch())).toEqual({
            ok: false,
            status: 409,
            body: { error: "chatBusy", jobId },
        });
        expect(jobs.abort(jobId, "tab")).toBe(true);
        await finished;
        await ended(jobId);
        expect(jobs.status(jobId, "tab")?.state).toBe("ended");
        // Nothing ran for the refused ones: no job of chat `loose` exists, and its slot is free.
        expect(jobs.create({ kind: "send", context: loose, clientId: "tab" }, store.epoch())).toEqual(incomplete);
    });

    it("refuses every job kind for orphaned lore overrides, naming them by comment, key, then id, without creating or running a job", async () => {
        vi.useFakeTimers();
        const { jobs, store, context, revision, run } = setup();
        const runner = vi.fn(async () => {});
        void run(runner);
        store.applyChanges({
            chats: [
                group(revision(), [
                    {
                        op: "meta",
                        set: {
                            loreOverrides: [
                                { entry: lore("deleted-title", "Lost title", "Ignored key"), off: false },
                                { entry: lore("deleted-key", "", "Lost key"), off: false },
                                { entry: lore("deleted-off"), off: true },
                            ],
                        },
                    },
                ]),
            ],
        });
        const before = store.readRefs([], { chats: [{ characterId: "c", id: "k" }] });

        for (const kind of GENERATION_KINDS) {
            const body =
                kind === "command"
                    ? { kind, context: context(), clientId: "tab", command: { type: "button" as const, data: "" } }
                    : { kind, context: context(), clientId: "tab" };
            expect(jobs.create(body, store.epoch()), kind).toEqual({
                ok: false,
                status: 409,
                body: {
                    error: "chatLoreOverrideOrphaned",
                    entries: [
                        { id: "deleted-title", name: "Lost title" },
                        { id: "deleted-key", name: "Lost key" },
                        { id: "deleted-off", name: "deleted-off" },
                    ],
                },
            });
        }

        expect(jobs.live()).toBe(0);
        await jobs.drain();
        expect(runner).not.toHaveBeenCalled();
        expect(store.readRefs([], { chats: [{ characterId: "c", id: "k" }] })).toEqual(before);
    });

    it("admits chats with no overrides or with every override id in the owner's lore, including off entries", async () => {
        vi.useFakeTimers();
        const { jobs, store, context, revision, run } = setup();
        const runner = vi.fn(async (job: RunningJob) => {
            job.emit({ type: "done", revision: job.context.chatRevision });
        });
        void run(runner);
        store.applyChanges({
            ops: [
                {
                    kind: characters,
                    id: "c",
                    baseRevision: store.get(characters, "c")!.revision,
                    data: { chaId: "c", name: "C", globalLore: [lore("kept"), lore("disabled")] },
                },
            ],
            chats: [
                group(revision(), [
                    {
                        op: "meta",
                        set: {
                            loreOverrides: [
                                { entry: lore("kept", "Chat's frozen title"), off: false },
                                { entry: lore("disabled"), off: true },
                            ],
                        },
                    },
                ]),
            ],
        });

        for (const chatId of ["k", "j"]) {
            expect(
                jobs.create(
                    {
                        kind: "send",
                        context: { ...context(), chatId, chatRevision: store.chatRevision("c", chatId)! },
                        clientId: "tab",
                    },
                    store.epoch(),
                ),
            ).toEqual({ ok: true, jobId: expect.any(String) });
            await jobs.drain();
        }
        expect(runner).toHaveBeenCalledTimes(2);
    });

    it("checks group overrides against the group's own lore, refusing a member-only id and admitting a group-only id", async () => {
        vi.useFakeTimers();
        const { jobs, store, context, revision, run } = setup();
        const runner = vi.fn(async (job: RunningJob) => {
            job.emit({ type: "done", revision: job.context.chatRevision });
        });
        void run(runner);
        store.applyChanges({
            ops: [
                {
                    kind: characters,
                    id: "c",
                    baseRevision: store.get(characters, "c")!.revision,
                    data: {
                        chaId: "c",
                        type: "group",
                        name: "Group",
                        characters: ["member"],
                        useCharacterLore: true,
                        globalLore: [lore("group-only")],
                    },
                },
                {
                    kind: characters,
                    id: "member",
                    baseRevision: null,
                    data: { chaId: "member", name: "Member", globalLore: [lore("member-only")] },
                },
            ],
            chats: [
                group(revision(), [
                    {
                        op: "meta",
                        set: { loreOverrides: [{ entry: lore("member-only", "Member lore"), off: false }] },
                    },
                ]),
            ],
        });
        const createGroupJob = () =>
            jobs.create(
                { kind: "group", context: { ...context(), speakerChaId: "member" }, clientId: "tab" },
                store.epoch(),
            );
        expect(createGroupJob()).toEqual({
            ok: false,
            status: 409,
            body: { error: "chatLoreOverrideOrphaned", entries: [{ id: "member-only", name: "Member lore" }] },
        });
        expect(jobs.live()).toBe(0);
        await jobs.drain();
        expect(runner).not.toHaveBeenCalled();

        store.applyChanges({
            chats: [
                group(revision(), [
                    {
                        op: "meta",
                        set: { loreOverrides: [{ entry: lore("group-only"), off: false }] },
                    },
                ]),
            ],
        });
        expect(createGroupJob()).toEqual({ ok: true, jobId: expect.any(String) });
        await jobs.drain();
        expect(runner).toHaveBeenCalledTimes(1);
    });
});

describe("the write capability", () => {
    it("hands a message from one generation to the next in one write and releases it only when the owning generation's final applies", async () => {
        const { jobs, store, create, run, ended, owner, revision, text } = setup();
        const clientWrite = (value: string) =>
            store.applyChanges({ chats: [group(revision(), [{ op: "setText", id: "r", text: value }])] });
        const outcome = run(async (job) => {
            const first = job.write(() => ({
                chats: [group(revision(), [begin("r", "g1"), checkpoint("r", "g1", 1, "one")])],
            }));
            expect(first.chats[0].checkpoints).toEqual(["applied"]);
            expect(owner("r")).toBe("g1");
            expect(() => clientWrite("mine")).toThrow(/conflict/i);
            // The final of g1 and the begin of g2 in one write: g2 keeps the message.
            const handoff = job.write(() => ({
                chats: [group(revision(), [checkpoint("r", "g1", 2, "one two", true), begin("r", "g2")])],
            }));
            expect(handoff.chats[0].checkpoints).toEqual(["applied"]);
            expect(owner("r")).toBe("g2");
            expect(() => clientWrite("mine")).toThrow(/conflict/i);
            expect(text("r")).toBe("one two");
            // A late g1 final is ignored by the fence and does not release g2; a replay of g2 is a
            // duplicate and does not either.
            expect(
                job.write(() => ({ chats: [group(revision(), [checkpoint("r", "g1", 9, "late", true)])] })).chats[0]
                    .checkpoints,
            ).toEqual(["ignored"]);
            job.write(() => ({ chats: [group(revision(), [checkpoint("r", "g2", 1, "two")])] }));
            expect(
                job.write(() => ({ chats: [group(revision(), [checkpoint("r", "g2", 1, "two")])] })).chats[0]
                    .checkpoints,
            ).toEqual(["duplicate"]);
            expect(owner("r")).toBe("g2");
            expect(text("r")).toBe("two");
            // g2's applied final releases the message: the client's write applies.
            job.write(() => ({ chats: [group(revision(), [checkpoint("r", "g2", 2, "two three", true)])] }));
            expect(owner("r")).toBeNull();
            expect(clientWrite("mine").chats[0].revision).toBeTruthy();
            expect(text("r")).toBe("mine");
            job.emit({ type: "done", revision: revision(), messageId: "r" });
        });
        const jobId = create();
        await outcome;
        await ended(jobId);
        expect(jobs.status(jobId, "tab")?.terminal).toMatchObject({ type: "done", messageId: "r" });
    });

    it("restores every owner it replaced when an acquisition or the write fails, and retries exactly once on a resource-only conflict", async () => {
        const { store, lock, create, run, ended, owner, revision } = setup();
        lock.addToken("other");
        lock.acquire({ ...ref, messageId: "u" }, { jobId: "J9", generationId: "g9", token: "other" });
        const character = () => store.get(characters, "c")!;
        const outcome = run(async (job) => {
            // The second acquisition fails: the first is undone.
            expect(() =>
                job.write(() => ({ chats: [group(revision(), [begin("r", "gA"), begin("u", "gB")])] })),
            ).toThrow("Another generation job owns this message");
            expect(owner("r")).toBeNull();
            expect(owner("u")).toBe("g9");
            // The store refuses the write (a begin on a missing message): the acquired lock is undone,
            // and a chat conflict is never retried.
            let builds = 0;
            expect(() =>
                job.write(() => {
                    builds += 1;
                    return { chats: [group(revision(), [begin("r", "gA"), begin("zz", "gA")])] };
                }),
            ).toThrow(JobWriteConflictError);
            expect(builds).toBe(1);
            expect(owner("r")).toBeNull();
            // A resource-only conflict: `build` runs again and the second attempt applies.
            builds = 0;
            const stale = character().revision;
            store.put(characters, "c", { chaId: "c", name: "edited elsewhere" }, stale);
            const applied = job.write(() => {
                builds += 1;
                return {
                    ops: [
                        {
                            kind: characters,
                            id: "c",
                            baseRevision: builds === 1 ? stale : character().revision,
                            data: { chaId: "c", name: `patched ${builds}` },
                        },
                    ],
                    chats: [group(revision(), [begin("r", "gA"), checkpoint("r", "gA", 1, "a")])],
                };
            });
            expect(builds).toBe(2);
            expect(applied.results[0].revision).toBe(character().revision);
            expect(character().data).toEqual(normalizeCharacter({ chaId: "c", name: "patched 2" }));
            expect(owner("r")).toBe("gA");
            // A second conflict fails the write, with every owner of this write restored (r keeps gA
            // from before, u is still the other job's).
            builds = 0;
            let error: unknown;
            try {
                job.write(() => {
                    builds += 1;
                    return {
                        ops: [{ kind: characters, id: "c", baseRevision: stale, data: { chaId: "c", name: "never" } }],
                        chats: [group(revision(), [begin("r", "gB")])],
                    };
                });
            } catch (e) {
                error = e;
            }
            expect(error).toBeInstanceOf(JobWriteConflictError);
            expect((error as JobWriteConflictError).conflicts).toEqual([
                { kind: "characters", id: "c", revision: character().revision },
            ]);
            expect(builds).toBe(2);
            expect(owner("r")).toBe("gA");
            expect(owner("u")).toBe("g9");
            // A conflict naming a chat beside a resource is not retried either.
            builds = 0;
            expect(() =>
                job.write(() => {
                    builds += 1;
                    return {
                        ops: [{ kind: characters, id: "c", baseRevision: stale, data: { chaId: "c" } }],
                        chats: [group(revision(), [{ op: "setText", id: "u", text: "x" }])],
                    };
                }),
            ).toThrow(JobWriteConflictError);
            expect(builds).toBe(1);
            job.emit({ type: "done", revision: revision() });
        });
        const jobId = create();
        await outcome;
        await ended(jobId);
        // The job's end releases its own lock only.
        expect(owner("r")).toBeNull();
        expect(owner("u")).toBe("g9");
    });
});

describe("the end of a job", () => {
    it("ends once with a terminal, kills every capability, and frees the locks and the slot", async () => {
        const { jobs, lock, create, run, ended, owner, revision, store } = setup();
        let captured!: RunningJob;
        const outcome = run(async (job) => {
            captured = job;
            job.write(() => ({ chats: [group(revision(), [begin("r", "g1"), checkpoint("r", "g1", 1, "one")])] }));
            expect(owner("r")).toBe("g1");
            // Hidden kinds never leave the server.
            expect(() =>
                job.emit({ type: "resource", kind: "llmSecrets", id: "main", revision: "x", data: {} }),
            ).toThrow(/never sent/);
            expect(() => job.emitRecords({ refs: [{ kind: "authRefreshes", id: "main" }] })).toThrow(/never sent/);
            const off = job.onClientMessage(() => {});
            off();
            job.emit({ type: "done", revision: revision(), messageId: "r" });
            // Ended: everything throws now, including a second terminal.
            expect(() => job.emit({ type: "error", message: "late", status: 500, reason: "failed" })).toThrow(
                GenerationJobEndedError,
            );
        });
        const jobId = create();
        await outcome;
        await ended(jobId);
        expect(jobs.status(jobId, "tab")).toMatchObject({ state: "ended", terminal: { type: "done", messageId: "r" } });
        expect(owner("r")).toBeNull();
        expect(lock.chatHolders("c", "k").size).toBe(0);
        expect(() => captured.write(() => ({ chats: [] }))).toThrow(GenerationJobEndedError);
        expect(() => captured.emit({ type: "progress", payload: 1 })).toThrow(GenerationJobEndedError);
        expect(() => captured.emitRecords({ refs: [] })).toThrow(GenerationJobEndedError);
        expect(() => captured.onClientMessage(() => {})).toThrow(GenerationJobEndedError);
        // The message is free for a client, and the chat slot for a new job.
        store.applyChanges({ chats: [group(revision(), [{ op: "setText", id: "r", text: "mine" }])] });
        expect(create()).toBeTruthy();
    });

    it("turns a runner's return, throw, and unserializable result into one safe error terminal, and the tracked lifetime still ends", async () => {
        const { jobs, snapshots, create, run, ended, revision } = setup();
        const outcomes: unknown[] = [];
        for (const [fn, expected] of [
            [
                async () => {},
                { type: "error", reason: "failed", status: 500, message: "The job ended without a result" },
            ],
            [
                async () => {
                    throw new GenerationRunnerError(418, "teapot");
                },
                { type: "error", reason: "failed", status: 418, message: "teapot" },
            ],
            [
                async () => {
                    throw new Error("plain");
                },
                { type: "error", reason: "failed", status: 500, message: "plain" },
            ],
            [
                async (job: RunningJob) => {
                    job.emit({ type: "done", revision: revision(), result: 1n });
                },
                { type: "error", reason: "failed", status: 500 },
            ],
        ] as [(job: RunningJob) => Promise<void>, Record<string, unknown>][]) {
            const outcome = run(fn).catch(() => {});
            const jobId = create();
            await outcome;
            await ended(jobId);
            const terminal = jobs.status(jobId, "tab")!.terminal!;
            expect(terminal).toMatchObject(expected);
            outcomes.push(terminal);
        }
        expect((outcomes[3] as { message: string }).message).toMatch(/could not be sent.*BigInt/);
        // Every job resolved its tracked lifetime: stopping the snapshot manager does not wait.
        await expect(Promise.race([snapshots.stop(), sleep(500).then(() => "timeout")])).resolves.toBeUndefined();
    });

    it("lets the first abort decide the outcome and fixes one deadline per job, after which a runner that ignores its signal is ended for it", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const { jobs, create, run, owner, revision } = setup();
        // A synchronous abort listener that reports success: the outcome is still the abort.
        const sync = run(async (job) => {
            job.write(() => ({ chats: [group(revision(), [begin("r", "g1"), checkpoint("r", "g1", 1, "one")])] }));
            job.signal.addEventListener("abort", () =>
                job.emit({ type: "done", revision: revision(), messageId: "r" }),
            );
            await aborted(job);
        });
        const first = create();
        await vi.advanceTimersByTimeAsync(0);
        expect(jobs.status(first, "tab")?.state).toBe("running");
        expect(jobs.abort(first, "tab")).toBe(true);
        await sync;
        expect(jobs.status(first, "tab")).toMatchObject({
            state: "ended",
            terminal: { type: "error", reason: "aborted", status: 499 },
        });
        expect(owner("r")).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        expect(jobs.abort(first, "tab")).toBe(false);

        // A runner that reports done after the abort fired (asynchronously): still the abort.
        const later = run(async (job) => {
            await aborted(job);
            job.emit({ type: "done", revision: revision() });
        });
        const second = create();
        await vi.advanceTimersByTimeAsync(0);
        jobs.abort(second, "tab");
        await later;
        expect(jobs.status(second, "tab")?.terminal).toMatchObject({ type: "error", reason: "aborted" });

        // A runner that ignores its signal: ended exactly at the grace deadline, measured from the
        // first abort; a later abort does not extend it; its late capabilities throw and its
        // rejection is handled.
        let stubborn!: RunningJob;
        const unhandled = vi.fn();
        process.on("unhandledRejection", unhandled);
        const abandoned = run(async (job) => {
            stubborn = job;
            job.write(() => ({ chats: [group(revision(), [begin("r", "g3"), checkpoint("r", "g3", 1, "three")])] }));
            await new Promise<void>((resolve) => setTimeout(resolve, JOB_ABORT_GRACE_MS * 3));
            // Far past the deadline: the job is gone.
            job.write(() => ({ chats: [group(revision(), [checkpoint("r", "g3", 2, "late", true)])] }));
        }).catch((error: unknown) => error);
        const third = create();
        await vi.advanceTimersByTimeAsync(0);
        expect(jobs.abort(third, "tab")).toBe(true);
        await vi.advanceTimersByTimeAsync(JOB_ABORT_GRACE_MS - 1);
        expect(jobs.status(third, "tab")?.state).toBe("running");
        expect(jobs.abort(third, "tab")).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(jobs.status(third, "tab")).toMatchObject({
            state: "ended",
            terminal: { type: "error", reason: "aborted", status: 499 },
        });
        expect(owner("r")).toBeNull();
        expect(vi.getTimerCount()).toBe(1); // the abandoned runner's own sleep
        expect(() => stubborn.emit({ type: "progress", payload: 1 })).toThrow(GenerationJobEndedError);
        await vi.advanceTimersByTimeAsync(JOB_ABORT_GRACE_MS * 3);
        expect(await abandoned).toBeInstanceOf(GenerationJobEndedError);
        await vi.advanceTimersByTimeAsync(0);
        expect(unhandled).not.toHaveBeenCalled();
        process.off("unhandledRejection", unhandled);
    });
});

describe("the failure fields of the error terminal", () => {
    const REQUEST = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

    it("markFailure fills only the fields the error does not hold yet (the nearest site wins), ignores null, undefined, and a primitive; failureOf copies; a GenerationRunnerError holds its own", () => {
        const foreign = new Error("x");
        expect(markFailure(foreign, { stage: "request", requestId: REQUEST })).toBe(foreign);
        expect(failureOf(foreign)).toEqual({ stage: "request", requestId: REQUEST });
        markFailure(foreign, { stage: "script", requestId: "other", providerCode: "rate_limit_exceeded" });
        expect(failureOf(foreign)).toEqual({
            stage: "request",
            requestId: REQUEST,
            providerCode: "rate_limit_exceeded",
        });
        // A copy: changing it changes nothing.
        failureOf(foreign).stage = "tail";
        expect(failureOf(foreign).stage).toBe("request");
        const blank = new Error("y");
        markFailure(blank, { stage: undefined, requestId: null as never, providerCode: null });
        expect(failureOf(blank)).toEqual({});
        markFailure(blank, { stage: "persist" });
        expect(failureOf(blank)).toEqual({ stage: "persist" });
        expect(markFailure("text", { stage: "script" })).toBe("text");
        expect(failureOf("text")).toEqual({});
        expect(failureOf(null)).toEqual({});
        expect(failureOf(undefined)).toEqual({});
        const own = new GenerationRunnerError(500, "m", { stage: "tail", providerCode: null });
        expect(own.failure).toEqual({ stage: "tail" });
        markFailure(own, { stage: "setup", requestId: REQUEST });
        expect(own.failure).toEqual({ stage: "tail", requestId: REQUEST });
        expect(failureOf(own)).toEqual({ stage: "tail", requestId: REQUEST });
        // A replacement error takes the original's fields through failureOf.
        const replacement = new GenerationRunnerError(500, "wrapped", failureOf(own));
        expect(replacement.failure).toEqual({ stage: "tail", requestId: REQUEST });
    });

    it("copies the checked fields of a runner's failure to the terminal and logs one content-free `generation.failed` line; a value outside its pattern or list is left out", async () => {
        const { jobs, create, run, ended } = setup();
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        cleanups.push(() => log.mockRestore());
        const cases: [() => never, Record<string, unknown>, (jobId: string) => string][] = [
            [
                () => {
                    throw new GenerationRunnerError(502, "Upstream broke: private text", {
                        stage: "request",
                        requestId: REQUEST,
                        providerCode: "rate_limit_exceeded",
                    });
                },
                { status: 502, stage: "request", requestId: REQUEST, providerCode: "rate_limit_exceeded" },
                (jobId) =>
                    `[Generation] failed job=${jobId} request=${REQUEST} kind=send stage=request reason=failed status=502 providerCode=rate_limit_exceeded`,
            ],
            [
                () => {
                    // A foreign error marked at a site: its fields reach the terminal too.
                    throw markFailure(new Error("plain"), { stage: "persist" });
                },
                { status: 500, stage: "persist" },
                (jobId) => `[Generation] failed job=${jobId} kind=send stage=persist reason=failed status=500`,
            ],
            [
                () => {
                    throw new GenerationRunnerError(500, "bad fields", {
                        stage: "parsing" as never,
                        requestId: "Private Character",
                        providerCode: "rate limit exceeded",
                    });
                },
                { status: 500 },
                (jobId) => `[Generation] failed job=${jobId} kind=send reason=failed status=500`,
            ],
        ];
        for (const [fn, expected, line] of cases) {
            log.mockClear();
            const outcome = run(async () => fn()).catch(() => {});
            const jobId = create();
            await outcome;
            await ended(jobId);
            const terminal = jobs.status(jobId, "tab")!.terminal as Record<string, unknown>;
            expect(terminal).toMatchObject({ type: "error", reason: "failed", ...expected });
            for (const field of ["stage", "requestId", "providerCode"]) {
                if (!(field in expected)) {
                    expect(field in terminal).toBe(false);
                }
            }
            const lines = log.mock.calls.map((call) => call[0]).filter((text) => typeof text === "string");
            expect(lines).toEqual([line(jobId)]);
            expect(lines[0]).not.toContain("private");
            expect(lines[0]).not.toContain("Private");
        }
    });

    it("a failed job write (a conflict) is marked `persist` for the runner, which carries it to the terminal; an aborted job has no fields and no failed line", async () => {
        const { jobs, create, run, ended, store } = setup();
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        cleanups.push(() => log.mockRestore());
        log.mockClear();
        const outcome = run(async (job) => {
            // A resource write at a stale revision conflicts (a chat op by message id would still apply).
            const stale = store.get(characters, "c")!.revision;
            const changed = { chaId: "c", name: "Changed" };
            store.applyChanges({ ops: [{ kind: characters, id: "c", baseRevision: stale, data: changed }] });
            try {
                job.write(() => ({
                    ops: [{ kind: characters, id: "c", baseRevision: stale, data: { chaId: "c", name: "Late" } }],
                }));
            } catch (error) {
                expect(error).toBeInstanceOf(JobWriteConflictError);
                expect(failureOf(error)).toEqual({ stage: "persist" });
                // The runner's conversion keeps the stage.
                throw new GenerationRunnerError(409, "The send's write conflicted with another change", {
                    ...failureOf(error),
                    stage: "persist",
                });
            }
            throw new Error("the stale write applied");
        }).catch(() => {});
        const jobId = create();
        await outcome;
        await ended(jobId);
        expect(jobs.status(jobId, "tab")!.terminal).toMatchObject({ type: "error", status: 409, stage: "persist" });
        expect(log.mock.calls.map((call) => call[0])).toEqual([
            `[Generation] failed job=${jobId} kind=send stage=persist reason=failed status=409`,
        ]);

        log.mockClear();
        const abortedRun = run(async (job) => {
            await aborted(job);
            throw markFailure(new Error("stopped"), { stage: "request", requestId: REQUEST });
        }).catch(() => {});
        const abortedId = create();
        expect(jobs.abort(abortedId, "tab")).toBe(true);
        await abortedRun;
        await ended(abortedId);
        const terminal = jobs.status(abortedId, "tab")!.terminal as Record<string, unknown>;
        expect(terminal).toMatchObject({ type: "error", reason: "aborted" });
        expect("stage" in terminal || "requestId" in terminal).toBe(false);
        expect(log.mock.calls.filter((call) => String(call[0]).includes("failed"))).toEqual([]);
    });
});

describe("maintenance and shutdown", () => {
    it("aborts the jobs while writes stay open, so the abort checkpoint lands before the replacement and in the safety snapshot", async () => {
        const { jobs, store, snapshots, create, run, text, revision, context } = setup();
        const outcome = run(async (job) => {
            job.write(() => ({ chats: [group(revision(), [begin("r", "g1"), checkpoint("r", "g1", 1, "partial")])] }));
            await aborted(job);
            // The abort path persists the text so far: the gate is still open here.
            const applied = job.write(() => ({
                chats: [group(revision(), [checkpoint("r", "g1", 2, "partial final", true)])],
            }));
            return {
                outcome: applied.chats[0].checkpoints,
                gateActive: snapshots.gate.active,
                reason: job.signal.reason,
            };
        });
        const jobId = create();
        await waitFor(() => text("r") === "partial");
        const inside = await snapshots.withMaintenance(async ({ snapshot }) => {
            const safety = await snapshot();
            return {
                safety,
                state: jobs.status(jobId, "tab")?.state,
                terminal: jobs.status(jobId, "tab")?.terminal,
                text: text("r"),
                gateActive: snapshots.gate.active,
                create: jobs.create({ kind: "send", context: context(), clientId: "tab" }, store.epoch()),
            };
        });
        expect(await outcome).toEqual({ outcome: ["applied"], gateActive: false, reason: "maintenance" });
        expect(inside).toMatchObject({
            state: "ended",
            terminal: { type: "error", reason: "maintenance", status: 503 },
            text: "partial final",
            gateActive: true,
            create: { ok: false, status: 503 },
        });
        const rows = store.readSnapshot(path.join(snapshots.resolve(inside.safety.id)!)).messages;
        expect(rows.find((row) => row.id === "r")).toMatchObject({ data: expect.stringContaining("partial final") });
        // Admission reopens once the maintenance ends.
        expect(jobs.create({ kind: "send", context: context(), clientId: "tab" }, store.epoch()).ok).toBe(true);
    });

    it("beginShutdown aborts every job with shutdown and refuses new ones; drain resolves at their end; dispose follows", async () => {
        const { jobs, store, create, run, context, text, revision } = setup();
        const outcome = run(async (job) => {
            job.write(() => ({ chats: [group(revision(), [begin("r", "g1"), checkpoint("r", "g1", 1, "so far")])] }));
            await aborted(job);
            job.write(() => ({ chats: [group(revision(), [checkpoint("r", "g1", 2, "so far", true)])] }));
        });
        const jobId = create();
        await waitFor(() => text("r") === "so far");
        jobs.beginShutdown();
        expect(jobs.create({ kind: "send", context: context(), clientId: "tab" }, store.epoch())).toMatchObject({
            ok: false,
            status: 503,
        });
        await outcome;
        await expect(Promise.race([jobs.drain(), sleep(1000).then(() => "timeout")])).resolves.toBeUndefined();
        expect(jobs.status(jobId, "tab")).toMatchObject({
            state: "ended",
            terminal: { type: "error", reason: "shutdown", status: 503 },
        });
        jobs.dispose();
    });
});

// The change feed carries the generation locks. A job's write publishes, with its change, every lock
// of each chat it touched (`chatStreaming` from the committed hook: a `begin`'s new owner, a
// checkpoint's watermark, a final write's release), and the job's end publishes the chats it locked
// once more with no refs (`publishStreaming`), so a release reaches every tab without a write.
describe("the locks a job's writes and end publish", () => {
    const locks = (event: ChangeFeedEvent | undefined) => {
        if (event?.type !== "change") throw new Error("expected a committed change");
        return event.streaming;
    };
    const chatK = (streaming: { messageId: string; generationId: string; seq: number }[]) => ({
        characterId: "c",
        id: "k",
        streaming,
    });

    it("lists the new owner on `begin`, the watermark on a checkpoint, the release on the final write, and the empty list again at the job's end", async () => {
        const { jobs, create, run, ended, revision, events } = setup({ feed: true });
        const outcome = run(async (job) => {
            job.write(() => ({ chats: [group(revision(), [begin("r", "g1")])] }));
            expect(events.at(-1)).toMatchObject({ changes: { chats: [{ characterId: "c", id: "k" }] } });
            expect(locks(events.at(-1))).toEqual([chatK([{ messageId: "r", generationId: "g1", seq: 0 }])]);
            // The listed `seq` is the write's `covers` claim (the newest stream chunk the stored text
            // includes), as the job's own chat events list it; a write without a claim is 0.
            job.write(() => ({ chats: [group(revision(), [checkpoint("r", "g1", 1, "one")])] }), {
                covers: [{ messageId: "r", generationId: "g1", seq: 3 }],
            });
            expect(locks(events.at(-1))).toEqual([chatK([{ messageId: "r", generationId: "g1", seq: 3 }])]);
            // A duplicate checkpoint changes nothing stored (the claim stays) but still announces the locks.
            job.write(() => ({ chats: [group(revision(), [checkpoint("r", "g1", 1, "one")])] }));
            expect(locks(events.at(-1))).toEqual([chatK([{ messageId: "r", generationId: "g1", seq: 3 }])]);
            job.write(() => ({ chats: [group(revision(), [checkpoint("r", "g1", 4, "one two", true)])] }));
            // The final write's own frame already carries the release.
            expect(events.at(-1)).toMatchObject({ changes: { chats: [{ characterId: "c", id: "k" }] } });
            expect(locks(events.at(-1))).toEqual([chatK([])]);
            const published = events.length;
            job.emit({ type: "done", revision: revision(), messageId: "r" });
            return published;
        });
        const jobId = create();
        const published = await outcome;
        await ended(jobId);
        // The end publishes the chat's (empty) list again, with no refs.
        const end = events.slice(published).filter((event) => event.type === "change" && event.streaming);
        expect(end).toEqual([
            {
                type: "change",
                epoch: expect.any(String),
                changes: { resources: [], chats: [], chatOrders: [] },
                streaming: [chatK([])],
            },
        ]);
    });

    it("a replayed `begin` of a generation the job released takes no lock again", async () => {
        const { create, run, ended, revision, owner, events } = setup({ feed: true });
        const outcome = run(async (job) => {
            job.write(() => ({
                chats: [group(revision(), [begin("r", "g1"), checkpoint("r", "g1", 1, "one", true)])],
            }));
            expect(owner("r")).toBeNull();
            // The store treats the replay as a no-op; the job's released generation stays released.
            job.write(() => ({ chats: [group(revision(), [begin("r", "g1")])] }));
            expect(owner("r")).toBeNull();
            expect(locks(events.at(-1))).toEqual([chatK([])]);
            // A new generation on the same message locks it as before.
            job.write(() => ({ chats: [group(revision(), [begin("r", "g2")])] }));
            expect(owner("r")).toBe("g2");
            job.emit({ type: "done", revision: revision(), messageId: "r" });
        });
        const jobId = create();
        await outcome;
        await ended(jobId);
        expect(owner("r")).toBeNull();
    });

    it("a handoff lists only the generation that owns the message now, each chat lists its own locks, and an abort without a final write releases every locked chat at the end", async () => {
        const { jobs, store, create, run, ended, revision, owner, events } = setup({ feed: true });
        const outcome = run(async (job) => {
            job.write(() => ({ chats: [group(revision(), [begin("r", "g1"), checkpoint("r", "g1", 1, "one")])] }));
            job.write(() => ({
                chats: [group(revision(), [checkpoint("r", "g1", 2, "one two", true), begin("r", "g2")])],
            }));
            expect(owner("r")).toBe("g2");
            // g1's final applied and released g1; the begin of g2 in the same write keeps r locked by g2,
            // whose stored text holds no chunk of g2 yet.
            expect(locks(events.at(-1))).toEqual([chatK([{ messageId: "r", generationId: "g2", seq: 0 }])]);
            // A write touching another chat lists that chat's locks only.
            job.write(() => ({ chats: [group(store.chatRevision("c", "j"), [begin("x", "gJ")], "j")] }));
            expect(locks(events.at(-1))).toEqual([
                { characterId: "c", id: "j", streaming: [{ messageId: "x", generationId: "gJ", seq: 0 }] },
            ]);
            await aborted(job);
        });
        const jobId = create();
        expect(jobs.abort(jobId, "tab")).toBe(true);
        await outcome;
        await ended(jobId);
        expect(owner("r")).toBeNull();
        // No final write: the end's frame releases both chats the job locked, in the order it locked them.
        expect(locks(events.at(-1))).toEqual([chatK([]), { characterId: "c", id: "j", streaming: [] }]);
        expect(events.at(-1)).toMatchObject({ changes: { resources: [], chats: [], chatOrders: [] } });
    });

    it("a `committed` that throws surfaces as `CommittedWriteError`: the committed write and its owner stand, nothing is restored or retried, and the job's later writes and end still publish", async () => {
        const failing = { current: false };
        const { create, run, ended, revision, owner, text, events } = setup({ feed: true, failCommitted: failing });
        const outcome = run(async (job) => {
            failing.current = true;
            const before = events.length;
            expect(() =>
                job.write(() => ({ chats: [group(revision(), [begin("r", "g1"), checkpoint("r", "g1", 1, "one")])] })),
            ).toThrow(CommittedWriteError);
            // The write committed and was published (without lists); the lock it took is kept.
            expect(text("r")).toBe("one");
            expect(owner("r")).toBe("g1");
            expect(events).toHaveLength(before + 1);
            expect(events.at(-1)).toMatchObject({ changes: { chats: [{ characterId: "c", id: "k" }] } });
            expect(events.at(-1)).not.toHaveProperty("streaming");
            failing.current = false;
            job.write(() => ({ chats: [group(revision(), [checkpoint("r", "g1", 2, "one two")])] }), {
                covers: [{ messageId: "r", generationId: "g1", seq: 2 }],
            });
            expect(locks(events.at(-1))).toEqual([chatK([{ messageId: "r", generationId: "g1", seq: 2 }])]);
            job.emit({ type: "done", revision: revision(), messageId: "r" });
        });
        const jobId = create();
        await outcome;
        await ended(jobId);
        expect(owner("r")).toBeNull();
        expect(locks(events.at(-1))).toEqual([chatK([])]);
    });
});

describe("the memory stop control", () => {
    it("records the owner's stop for the registered run only (idempotent), refuses another epoch, client, run, or no run, and ends with the job", async () => {
        const { jobs, store, create, run, ended, revision } = setup();
        const outcome = run(async (job) => {
            const epoch = store.epoch();
            const stop = (clientId: string, runId: string, at = epoch) =>
                jobs.requestMemoryStop(job.id, clientId, runId, at);
            expect(stop("tab", "run-1", "other-epoch")).toEqual({
                ok: false,
                status: 412,
                body: { error: "EpochMismatch", epoch },
            });
            expect(stop("other", "run-1")).toEqual({ ok: false, status: 404, body: { error: "Generation not found" } });
            expect(jobs.requestMemoryStop("nope", "tab", "run-1", epoch)).toMatchObject({ ok: false, status: 404 });
            expect(stop("tab", "run-1")).toEqual({ ok: false, status: 409, body: { error: "noMemoryRun" } });

            const first = job.registerMemoryControl!("run-1");
            expect(first.stopRequested()).toBe(false);
            expect(stop("tab", "run-2")).toEqual({ ok: false, status: 409, body: { error: "otherMemoryRun" } });
            expect(first.stopRequested()).toBe(false);
            expect(stop("tab", "run-1")).toEqual({ ok: true });
            expect(stop("tab", "run-1")).toEqual({ ok: true });
            expect(first.stopRequested()).toBe(true);

            // A later run replaces the registration; the earlier control's release leaves it alone.
            const second = job.registerMemoryControl!("run-2");
            first.release();
            expect(stop("tab", "run-1")).toEqual({ ok: false, status: 409, body: { error: "otherMemoryRun" } });
            expect(second.stopRequested()).toBe(false);
            expect(stop("tab", "run-2")).toEqual({ ok: true });
            expect(second.stopRequested()).toBe(true);
            second.release();
            expect(stop("tab", "run-2")).toEqual({ ok: false, status: 409, body: { error: "noMemoryRun" } });

            const third = job.registerMemoryControl!("run-3");
            job.emit({ type: "done", revision: revision() });
            // Ended: the registration is gone, a new one is refused, a late release is harmless.
            expect(stop("tab", "run-3")).toEqual({ ok: false, status: 409, body: { error: "jobEnded" } });
            expect(() => job.registerMemoryControl!("run-4")).toThrow(GenerationJobEndedError);
            expect(() => third.release()).not.toThrow();
            expect(third.stopRequested()).toBe(false);
        });
        const jobId = create();
        await outcome;
        await ended(jobId);
        expect(jobs.requestMemoryStop(jobId, "tab", "run-3", store.epoch())).toEqual({
            ok: false,
            status: 409,
            body: { error: "jobEnded" },
        });
    });
});

describe("the kept outcome of a collected job", () => {
    /** The GC's own interval (`JOB_GC_INTERVAL_MS`), after which an ended job past its grace is collected. */
    const GC_TICK_MS = 30_000;
    /** Only the clock the registry reads and the GC's interval are faked: `ended` and `drain` keep their real timers. */
    const fakeClock = () => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    /** Runs the clock to the GC tick 60 s after the ended jobs' end (the clock stands still otherwise): they are collected. */
    const collect = () => vi.advanceTimersByTimeAsync(JOB_DONE_GRACE_MS);
    /** Lets `job` run as a command job of chat `k` and returns the job's id once the runner is done. */
    const endJob = async (
        s: ReturnType<typeof setup>,
        body: (job: RunningJob) => void,
        kind: "send" | "command" = "command",
    ) => {
        const outcome = s.run(async (job) => body(job));
        const jobId = s.create("", kind);
        await outcome;
        await s.ended(jobId);
        return jobId;
    };

    it("answers a collected job's outcome as `ended` and `kept` to its owner only, without the preview result, and refuses an attach to it", async () => {
        fakeClock();
        const s = setup();
        const { jobs, store, revision, follow } = s;
        jobs.startGc();
        const sequence = { total: 2, sent: 1, stopped: "notSent" };
        const jobId = await endJob(s, (job) =>
            job.emit({
                type: "done",
                revision: revision(),
                messageId: "r",
                result: { assembled: "x".repeat(10_000) },
                sequence,
            }),
        );
        // Still live inside the grace: the whole terminal, not kept.
        expect(jobs.status(jobId, "tab")).toMatchObject({
            state: "ended",
            terminal: { type: "done", result: { assembled: expect.any(String) } },
        });
        expect(jobs.status(jobId, "tab")?.kept).toBeUndefined();
        await vi.advanceTimersByTimeAsync(GC_TICK_MS);
        expect(jobs.status(jobId, "tab")?.kept).toBeUndefined();
        await collect();
        expect(jobs.status(jobId, "tab")).toEqual({
            jobId,
            kind: "command",
            characterId: "c",
            chatId: "k",
            epoch: store.epoch(),
            state: "ended",
            terminal: {
                type: "done",
                epoch: store.epoch(),
                revision: revision(),
                messageId: "r",
                sequence,
            },
            kept: true,
        });
        expect(jobs.status(jobId, "other")).toBeNull();
        expect(jobs.abort(jobId, "tab")).toBeNull();
        // The job is gone: its socket is refused as for an unknown job.
        await expect(follow(jobId)).rejects.toThrow();
    });

    it("trims a kept terminal: a sequence summary is kept, and an error message is cut to 4 KiB at a code point boundary", async () => {
        fakeClock();
        const s = setup();
        const { jobs, revision } = s;
        jobs.startGc();
        const sequenceDone = await endJob(s, (job) =>
            job.emit({
                type: "done",
                revision: revision(),
                sequence: { total: 2, sent: 2 },
            }),
        );
        // 4095 one-byte characters, then a three-byte one that the 4096-byte limit cuts through.
        const message = "x".repeat(MAX_KEPT_MESSAGE_BYTES - 1) + "\u20ac" + "z".repeat(10);
        const longError = await endJob(s, (job) => job.emit({ type: "error", message, status: 500, reason: "failed" }));
        await collect();
        expect(jobs.status(sequenceDone, "tab")?.terminal).toEqual({
            type: "done",
            epoch: expect.any(String),
            revision: expect.any(String),
            sequence: { total: 2, sent: 2 },
        });
        const kept = jobs.status(longError, "tab")?.terminal;
        expect(kept).toMatchObject({ type: "error", status: 500, reason: "failed" });
        const cut = (kept as { message: string }).message;
        expect(cut).toBe("x".repeat(MAX_KEPT_MESSAGE_BYTES - 1));
        expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(MAX_KEPT_MESSAGE_BYTES);
    });

    it("keeps at most 500 outcomes, the oldest out first, and drops each one 24 h after it was kept", async () => {
        fakeClock();
        const s = setup();
        const { jobs, revision } = s;
        jobs.startGc();
        const ids: string[] = [];
        for (let n = 0; n <= MAX_KEPT_OUTCOMES; n++) {
            const outcome = s.run(async (job) => job.emit({ type: "done", revision: revision() }));
            ids.push(s.create());
            await outcome;
            await jobs.drain();
        }
        await collect();
        const keptAt = Date.now();
        expect(jobs.status(ids[0], "tab")).toBeNull();
        expect(jobs.status(ids[1], "tab")).toMatchObject({ state: "ended", kept: true });
        expect(jobs.status(ids[MAX_KEPT_OUTCOMES], "tab")).toMatchObject({ state: "ended", kept: true });
        // Kept at the GC tick that collected them: readable until 24 h after it.
        vi.setSystemTime(keptAt + KEPT_OUTCOME_MS - 1);
        expect(jobs.status(ids[1], "tab")).toMatchObject({ kept: true });
        vi.setSystemTime(keptAt + KEPT_OUTCOME_MS);
        expect(jobs.status(ids[1], "tab")).toBeNull();
        expect(jobs.status(ids[MAX_KEPT_OUTCOMES], "tab")).toBeNull();
    });

    it("clears every kept outcome when the epoch changes, and keeps none for a job of the old epoch collected after that", async () => {
        fakeClock();
        const s = setup();
        const { jobs, store, dir, revision } = s;
        jobs.startGc();
        const before = await endJob(s, (job) => job.emit({ type: "done", revision: revision() }));
        await collect();
        expect(jobs.status(before, "tab")).toMatchObject({ kept: true });
        // Ended, still inside its grace when the data is replaced.
        const during = await endJob(s, (job) => job.emit({ type: "done", revision: revision() }));
        const snapshot = path.join(dir, "snapshot.sqlite");
        await store.backupTo(snapshot);
        const oldEpoch = store.epoch();
        await installSnapshot(store, snapshot, kinds);
        expect(store.epoch()).not.toBe(oldEpoch);
        expect(jobs.status(before, "tab")).toBeNull();
        expect(jobs.status(during, "tab")).toMatchObject({ state: "ended", epoch: oldEpoch });
        await collect();
        expect(jobs.status(during, "tab")).toBeNull();
    });
});

describe("generation ownership handoffs", () => {
    const hooks = { ...NO_GENERATION_HOOKS, scripts: ["editoutput" as const], chatOutput: true, interceptors: true };
    const clock = () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
        vi.setSystemTime(0);
    };
    async function live(
        options: {
            preferred?: boolean;
            receipts?: boolean;
            clientName?: (clientId: string) => string | undefined;
        } = {},
    ) {
        clock();
        const s = setup({ now: () => Date.now(), receipts: options.receipts, clientName: options.clientName });
        const entered = withResolvers<RunningJob>();
        const finish = withResolvers<void>();
        const completed = s.run(async (job) => {
            entered.resolve(job);
            await Promise.race([finish.promise, aborted(job)]);
        });
        cleanups.push(() => {
            finish.resolve();
        });
        const body = {
            kind: "send" as const,
            clientId: "tab",
            context: s.context(),
            hooks,
            requestId: "handoff-request",
            ...(options.preferred ? { handoff: "prefer" as const } : {}),
        };
        const created = s.jobs.create(body, s.store.epoch());
        if (!created.ok) throw new Error(JSON.stringify(created));
        const job = await entered.promise;
        const offer = (target?: string, clientId = "tab") =>
            s.jobs.handoff(job.id, { clientId, ...(target ? { target } : {}) }, s.store.epoch());
        const ticket = (clientId = "worker") => {
            const result = s.jobs.takeover(job.id, { clientId }, s.store.epoch());
            if (!result.ok) throw new Error(JSON.stringify(result));
            return result.body.ticket;
        };
        const take = async (clientId = "worker", query = "&hydration=patch") =>
            s.follow(job.id, clientId, `&ticket=${ticket(clientId)}${query}`);
        return { ...s, job, body, offer, ticket, take, finish, completed };
    }
    const roles = (events: GenerationEvent[]) => events.filter((event) => event.type === "handoff");
    const callbacks = (events: GenerationEvent[]) => events.filter((event) => event.type === "callback");
    const chats = (events: GenerationEvent[]) =>
        events.filter((event) => event.type === "chatPatch" || (event.type === "resource" && event.kind === "chats"));
    const answer = async (
        socket: Awaited<ReturnType<ReturnType<typeof setup>["follow"]>>,
        id: string,
        value: unknown = "ok",
    ) => {
        socket.ws.send(JSON.stringify({ type: "answer", id, outcome: "answered", value }));
        await socket.fence();
    };

    it("publishes absence only after ten seconds without an owner and closes it on return", async () => {
        const h = await live();
        const first = await h.follow(h.job.id);
        await first.fence();
        await first.close();
        await vi.advanceTimersByTimeAsync(9_999);
        expect(h.handoffs).toEqual([]);
        const returned = await h.follow(h.job.id);
        await returned.fence();
        await vi.advanceTimersByTimeAsync(1);
        expect(h.handoffs).toEqual([]);
        await returned.close();
        await vi.advanceTimersByTimeAsync(9_999);
        expect(h.jobs.handoffSnapshot()).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        const offer = {
            epoch: h.store.epoch(),
            jobId: h.job.id,
            characterId: "c",
            chatId: "k",
            state: "open",
            reason: "absent",
        };
        expect(h.jobs.handoffSnapshot()).toEqual([offer]);
        expect(h.handoffs).toEqual([{ type: "handoff", ...offer }]);
        await h.follow(h.job.id);
        expect(h.jobs.handoffSnapshot()).toEqual([]);
        expect(h.handoffs.at(-1)).toEqual({ type: "handoff", ...offer, state: "closed" });
    });

    it("reattaches the current owner through its absent offer and replays outstanding callbacks in order", async () => {
        const h = await live();
        const old = await h.follow(h.job.id, "tab", "&liveness=1");
        await old.fence();
        await vi.advanceTimersByTimeAsync(10_000);
        const root = h.job.channel.callback("editoutput", { text: "root" });
        await old.until((events) => callbacks(events).length === 1);
        const rootId = callbacks(old.events)[0].id;
        const child = h.job.channel.callback("editoutput", { text: "child" }, { parentId: rootId });
        await old.until((events) => callbacks(events).length === 2);
        const childId = callbacks(old.events)[1].id;

        // Silence removes the owner at 45 seconds; its absent offer opens ten seconds later.
        await vi.advanceTimersByTimeAsync(45_000);
        expect(h.job.ownerAttached()).toBe(false);
        expect(h.jobs.handoffSnapshot()).toEqual([expect.objectContaining({ reason: "absent", state: "open" })]);
        const ticket = h.ticket("tab");
        const returned = await h.follow(h.job.id, "tab", `&ticket=${ticket}`);
        await returned.fence();
        expect(roles(returned.events)).toEqual([{ type: "handoff", epoch: h.store.epoch(), owner: "self" }]);
        expect(h.job.ownerAttached()).toBe(true);
        expect(h.jobs.handoffSnapshot()).toEqual([]);
        expect(callbacks(returned.events)).toMatchObject([
            { id: rootId, name: "editoutput", payload: { text: "root" }, replay: true },
            { id: childId, name: "editoutput", payload: { text: "child" }, replay: true },
        ]);
        await old.closed;
        await answer(returned, childId, "child resumed");
        await answer(returned, rootId, "root resumed");
        expect(await child).toEqual({ outcome: "answered", value: "child resumed" });
        expect(await root).toEqual({ outcome: "answered", value: "root resumed" });
        await vi.advanceTimersByTimeAsync(10_001);
        expect(h.jobs.handoffSnapshot()).toEqual([]);
        expect(h.jobs.status(h.job.id, "tab")).toMatchObject({ state: "running" });
    });

    it("reattaches a reloaded worker owner through its absent offer", async () => {
        const h = await live({ preferred: true });
        const worker = await h.take();
        await worker.fence();
        const pending = h.job.channel.callback("editoutput", { text: "before reload" });
        await worker.fence();
        const id = callbacks(worker.events)[0].id;
        await worker.close();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(h.jobs.handoffSnapshot()).toEqual([expect.objectContaining({ reason: "absent", state: "open" })]);

        const reloaded = await h.take("worker");
        await reloaded.fence();
        expect(roles(reloaded.events)).toEqual([{ type: "handoff", epoch: h.store.epoch(), owner: "self" }]);
        expect(h.job.ownerAttached()).toBe(true);
        expect(h.jobs.handoffSnapshot()).toEqual([]);
        expect(callbacks(reloaded.events)).toMatchObject([{ id, payload: { text: "before reload" }, replay: true }]);
        await answer(reloaded, id, "resumed after reload");
        expect(await pending).toEqual({ outcome: "answered", value: "resumed after reload" });
        expect(h.jobs.status(h.job.id, "worker")).toMatchObject({ state: "running", handedOff: true });
        expect(h.offer("worker", "worker")).toEqual({ ok: false, status: 409, body: { error: "alreadyOwner" } });
    });

    it("names the current owner on self, viewer and pending roles and names the new owner after switching", async () => {
        const names = new Map([
            ["tab", "Creator"],
            ["worker", "Desk worker"],
        ]);
        const h = await live({ preferred: true, clientName: (id) => names.get(id) });
        const worker = await h.take();
        await worker.fence();
        const role = { type: "handoff", epoch: h.store.epoch(), clientName: "Desk worker" };
        expect(roles(worker.events)).toEqual([{ ...role, owner: "self" }]);
        const viewer = await h.follow(h.job.id, "tab", "&role=viewer");
        await viewer.fence();
        expect(roles(viewer.events)).toEqual([{ ...role, owner: "other" }]);

        const pending = h.job.channel.callback("editoutput", { text: "worker's outstanding work" });
        await worker.fence();
        const id = callbacks(worker.events)[0].id;
        await worker.close();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(h.jobs.handoffSnapshot()).toEqual([expect.objectContaining({ reason: "absent", state: "open" })]);
        // The creator is a different client from the current owner, so reclaiming still waits.
        const creator = await h.take("tab");
        await creator.fence();
        expect(roles(creator.events)).toEqual([{ ...role, owner: "other", pending: true }]);
        expect(callbacks(creator.events)).toEqual([]);

        const returnedWorker = await h.follow(h.job.id, "worker");
        await returnedWorker.fence();
        expect(roles(returnedWorker.events)).toEqual([{ ...role, owner: "self" }]);
        await answer(returnedWorker, id, "worker finished");
        expect(await pending).toEqual({ outcome: "answered", value: "worker finished" });
        await vi.advanceTimersByTimeAsync(0);
        await creator.fence();
        await returnedWorker.fence();
        expect(roles(creator.events).at(-1)).toEqual({ ...role, owner: "self", clientName: "Creator" });
        expect(roles(returnedWorker.events).at(-1)).toEqual({ ...role, owner: "other", clientName: "Creator" });
    });

    it.each([
        { label: "no lookup", clientName: undefined },
        { label: "unknown owner", clientName: () => undefined },
        { label: "empty name", clientName: () => "" },
        {
            label: "throwing lookup",
            clientName: () => {
                throw new Error("presence unavailable");
            },
        },
    ])("still sends an unnamed role with $label", async ({ clientName }) => {
        const h = await live({ clientName });
        const owner = await h.follow(h.job.id);
        await owner.fence();
        expect(roles(owner.events)).toEqual([{ type: "handoff", epoch: h.store.epoch(), owner: "self" }]);
    });

    it("binds one-use tickets to the job and client, reopens expired offers, and refuses ended or shutting-down jobs", async () => {
        const h = await live();
        const takeover = (id = h.job.id, clientId = "worker") => h.jobs.takeover(id, { clientId }, h.store.epoch());
        expect(takeover("unknown")).toMatchObject({ ok: false, status: 404 });
        expect(takeover()).toMatchObject({ ok: false, status: 409 });
        await expect(h.follow(h.job.id, "worker")).rejects.toThrow("404");
        expect(h.offer("worker")).toMatchObject({ ok: true });
        expect(takeover(h.job.id, "third")).toMatchObject({ ok: false, status: 409 });
        const expired = h.ticket();
        expect(takeover()).toMatchObject({ ok: false, status: 409 });
        await expect(h.follow(h.job.id, "third", `&ticket=${expired}`)).rejects.toThrow("409");
        // A second known job cannot consume the first job's ticket.
        const second = h.jobs.create(
            {
                ...h.body,
                requestId: "second",
                context: { ...h.body.context, chatId: "j", chatRevision: h.store.chatRevision("c", "j")! },
            },
            h.store.epoch(),
        );
        if (!second.ok) throw new Error(JSON.stringify(second));
        await expect(h.follow(second.jobId, "worker", `&ticket=${expired}`)).rejects.toThrow("409");
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(h.follow(h.job.id, "worker", `&ticket=${expired}`)).rejects.toThrow("409");
        expect(h.jobs.handoffSnapshot()).toContainEqual(
            expect.objectContaining({ jobId: h.job.id, reason: "requested", target: "worker", state: "open" }),
        );
        const used = h.ticket();
        const owner = await h.follow(h.job.id, "worker", `&ticket=${used}`);
        await owner.fence();
        expect(owner.events[0]).toEqual({ type: "handoff", epoch: h.store.epoch(), owner: "self" });
        await expect(h.follow(h.job.id, "worker", `&ticket=${used}`)).rejects.toThrow("409");
        expect(takeover()).toMatchObject({ ok: false, status: 409 });
        h.job.emit({ type: "done", revision: h.revision() });
        expect(takeover()).toMatchObject({ ok: false, status: 409 });
        h.jobs.beginShutdown();
        expect(takeover(second.jobId)).toMatchObject({ ok: false, status: 409 });
    });

    it("compares attach stamps within each client and requires a ticket for the creator to reclaim ownership", async () => {
        const h = await live({ preferred: true });
        const creator = await h.follow(h.job.id, "tab", "&attach=900");
        await creator.fence();
        expect(creator.events[0]).toMatchObject({ type: "handoff", owner: "self" });
        const worker = await h.take("worker", "&attach=1");
        await worker.fence();
        expect(worker.events[0]).toMatchObject({ type: "handoff", owner: "self" });
        const viewer = await h.follow(h.job.id, "tab", "&attach=901");
        await viewer.fence();
        expect(viewer.events[0]).toMatchObject({ type: "handoff", owner: "other" });
        const reattached = await h.follow(h.job.id, "worker", "&attach=2");
        await reattached.fence();
        expect(reattached.events[0]).toMatchObject({ type: "handoff", owner: "self" });
        await expect(h.follow(h.job.id, "worker", "&attach=1")).rejects.toThrow("409");
        expect(h.offer("tab", "worker")).toMatchObject({ ok: true });
        const reclaimed = await h.take("tab", "&attach=902");
        await reclaimed.fence();
        expect(reclaimed.events[0]).toMatchObject({ type: "handoff", owner: "self" });
        expect(h.jobs.status(h.job.id, "tab")).not.toHaveProperty("handedOff");
    });

    it("keeps delivered work with the old owner until its answer and sends queued work to the new owner once", async () => {
        const h = await live({ preferred: true });
        const creator = await h.follow(h.job.id);
        const edit = h.job.channel.callback("editoutput", { text: "original" });
        await creator.fence();
        const first = callbacks(creator.events)[0];
        const tail = h.job.channel.callback("chatOutput", { messageId: "r", speakerId: "c" });
        const worker = await h.take();
        await worker.fence();
        expect(worker.events[0]).toMatchObject({ type: "handoff", owner: "other", pending: true });
        expect(callbacks(worker.events)).toEqual([]);
        expect(h.jobs.parentCallback(h.job.id, "worker", first.id, () => {})).toBeNull();
        const parent = h.jobs.parentCallback(h.job.id, "tab", first.id, () => {});
        expect(parent).not.toBeNull();
        parent!.unwatch();
        await vi.advanceTimersByTimeAsync(10_001);
        expect(h.jobs.handoffSnapshot()).toEqual([]);
        await answer(worker, first.id, "intruder");
        await answer(creator, first.id, "edited by creator");
        expect(await edit).toEqual({ outcome: "answered", value: "edited by creator" });
        await vi.advanceTimersByTimeAsync(0);
        await worker.fence();
        await creator.fence();
        expect(roles(worker.events).at(-1)).toMatchObject({ owner: "self" });
        expect(roles(creator.events).at(-1)).toMatchObject({ owner: "other" });
        expect(callbacks(worker.events)).toHaveLength(1);
        const next = callbacks(worker.events)[0];
        expect(next).toMatchObject({ name: "chatOutput", payload: { messageId: "r", speakerId: "c" } });
        expect(next).not.toHaveProperty("replay");
        expect(callbacks(creator.events).map((event) => event.id)).toEqual([first.id]);
        await answer(worker, next.id);
        expect(await tail).toMatchObject({ outcome: "answered" });
    });

    it("waits for the last delivered request and promotes the pending owner after cancellation", async () => {
        const h = await live({ preferred: true });
        const creator = await h.follow(h.job.id);
        const controller = new AbortController();
        const root = h.job.channel.callback("editoutput", { text: "root" }, { signal: controller.signal });
        await creator.fence();
        const rootId = callbacks(creator.events)[0].id;
        const child = h.job.channel.callback("editoutput", { text: "child" }, { parentId: rootId });
        await creator.fence();
        const childId = callbacks(creator.events)[1].id;
        const worker = await h.take();
        await worker.fence();
        expect(worker.events[0]).toMatchObject({ owner: "other", pending: true });
        await answer(creator, childId, "child done");
        expect(await child).toMatchObject({ value: "child done" });
        await vi.advanceTimersByTimeAsync(1);
        await worker.fence();
        expect(roles(worker.events).at(-1)).toMatchObject({ owner: "other", pending: true });
        controller.abort();
        expect(await root).toMatchObject({ outcome: "aborted" });
        await vi.advanceTimersByTimeAsync(1);
        await worker.fence();
        expect(roles(worker.events).at(-1)).toMatchObject({ owner: "self" });
        expect(callbacks(worker.events)).toEqual([]);
        expect(h.jobs.callbackDrained(h.job.id, "third", rootId)).toBeNull();
        expect(h.jobs.callbackDrained(h.job.id, "tab", rootId)).toBe(true);
    });

    it("reopens a requested offer when the pending socket leaves before the old request settles", async () => {
        const h = await live();
        const creator = await h.follow(h.job.id);
        const pending = h.job.channel.callback("editoutput", { text: "held" });
        await creator.fence();
        h.offer("worker");
        const worker = await h.take();
        await worker.fence();
        expect(worker.events[0]).toMatchObject({ pending: true, owner: "other" });
        await worker.close();
        expect(h.jobs.handoffSnapshot()).toEqual([
            expect.objectContaining({ state: "open", reason: "requested", target: "worker" }),
        ]);
        await answer(creator, callbacks(creator.events)[0].id, "kept");
        expect(await pending).toMatchObject({ value: "kept" });
        expect(h.jobs.status(h.job.id, "tab")).not.toHaveProperty("handedOff");
        const replacement = await h.take();
        await replacement.fence();
        expect(replacement.events[0]).toMatchObject({ owner: "self" });
    });

    it("delivers an absent owner's callback at one hundred seconds as a first delivery before its real deadline", async () => {
        const h = await live();
        const old = await h.follow(h.job.id, "tab", "&liveness=1");
        await old.fence();
        await vi.advanceTimersByTimeAsync(45_000);
        expect(h.job.ownerAttached()).toBe(false);
        const pending = h.job.channel.callback("editoutput", { text: "waiting" });
        await vi.advanceTimersByTimeAsync(9_999);
        expect(h.jobs.handoffSnapshot()).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.jobs.handoffSnapshot()).toEqual([expect.objectContaining({ reason: "absent", state: "open" })]);
        await vi.advanceTimersByTimeAsync(45_000);
        const worker = await h.take();
        await worker.fence();
        expect(worker.events[0]).toMatchObject({ owner: "self" });
        const callback = callbacks(worker.events)[0];
        expect(callback).toMatchObject({ name: "editoutput", payload: { text: "waiting" } });
        expect(callback).not.toHaveProperty("replay");
        expect(callbacks(old.events)).toEqual([]);
        await answer(worker, callback.id, "rescued");
        expect(await pending).toEqual({ outcome: "answered", value: "rescued" });
    });

    it("settles an undelivered callback at one hundred five seconds when nobody takes over", async () => {
        const h = await live();
        const old = await h.follow(h.job.id, "tab", "&liveness=1");
        await old.fence();
        await vi.advanceTimersByTimeAsync(45_000);
        let result: unknown;
        const pending = h.job.channel.callback("editoutput", { text: "waiting" }).then((value) => {
            result = value;
            return value;
        });
        await vi.advanceTimersByTimeAsync(59_999);
        expect(result).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toMatchObject({ outcome: "disconnected" });
        expect(callbacks(old.events)).toEqual([]);
    });

    it("lets a delivered callback expire on its old owner at seventy seconds before promoting the pending socket", async () => {
        const h = await live();
        const old = await h.follow(h.job.id, "tab", "&liveness=1");
        await old.fence();
        await vi.advanceTimersByTimeAsync(10_000);
        let result: unknown;
        const pending = h.job.channel.callback("editoutput", { text: "keep this text" }).then((value) => {
            result = value;
            return value;
        });
        await old.until((events) => callbacks(events).length === 1);
        expect(callbacks(old.events)[0].deadline).toBe(70_000);
        await vi.advanceTimersByTimeAsync(46_000);
        const worker = await h.take();
        await worker.fence();
        expect(worker.events[0]).toMatchObject({ owner: "other", pending: true });
        await vi.advanceTimersByTimeAsync(13_999);
        expect(result).toBeUndefined();
        expect(callbacks(worker.events)).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toMatchObject({ outcome: "disconnected", delivered: true });
        await vi.advanceTimersByTimeAsync(1);
        await worker.fence();
        expect(roles(worker.events).at(-1)).toMatchObject({ owner: "self" });
        expect(callbacks(worker.events)).toEqual([]);
    });

    it("routes display events to viewers, dialogs to the owner, and device notices to the creator", async () => {
        const h = await live({ preferred: true });
        const viewer = await h.follow(h.job.id, "tab", "&liveness=1");
        const owner = await h.take();
        await owner.fence();
        await viewer.fence();
        expect(roles(viewer.events).at(-1)).toMatchObject({ owner: "other" });
        const display = [
            "emotion",
            "progress",
            "memoryProgress",
            "translating",
            "reloadChat",
            "reloadDisplay",
            "updateGUI",
        ];
        const dialogs = ["alertNormal", "alertError", "alertToast", "alertMd", "alertWait", "alertClear", "openURL"];
        for (const kind of [...display, ...dialogs, "tts", "notification"])
            h.job.channel.notice({ kind, payload: {} } as never);
        h.job.emit({
            type: "accepted",
            jobId: h.job.id,
            revision: h.revision(),
            messageId: "r",
            generationId: "g",
            text: "",
        });
        h.job.emit({ type: "chunk", messageId: "r", generationId: "g", seq: 1, text: "visible" });
        const question = h.job.channel.ask({ kind: "alertConfirm", payload: { message: "owner?" } });
        await owner.fence();
        await viewer.fence();
        const noticeKinds = (events: GenerationEvent[]) =>
            events.filter((event) => event.type === "notice").map((event) => event.kind);
        expect(noticeKinds(viewer.events)).toEqual([...display, "tts", "notification"]);
        expect(noticeKinds(owner.events)).toEqual([...display, ...dialogs]);
        expect(viewer.events.some((event) => event.type === "chunk" && event.text === "visible")).toBe(true);
        expect(viewer.events.some((event) => event.type === "question")).toBe(false);
        const request = owner.events.find((event) => event.type === "question")!;
        let settled = false;
        void question.then(() => {
            settled = true;
        });
        const ownerMessages: unknown[] = [];
        const unlisten = h.job.onClientMessage((message) => ownerMessages.push(message));
        await answer(viewer, request.id, false);
        viewer.ws.send(JSON.stringify({ type: "pong", ts: 0 }));
        await viewer.fence();
        expect(settled).toBe(false);
        expect(ownerMessages).toEqual([]);
        unlisten();
        const ping = new Promise<void>((resolve) =>
            viewer.ws.on("message", (raw) => {
                if (JSON.parse(String(raw)).type === "ping") resolve();
            }),
        );
        await vi.advanceTimersByTimeAsync(45_001);
        await ping;
        expect(h.job.ownerAttached()).toBe(true);
        expect(viewer.ws.readyState).toBe(WsClient.OPEN);
        await answer(owner, request.id, true);
        expect(await question).toEqual({ outcome: "answered", value: true });
        h.job.emit({ type: "done", revision: h.revision() });
        await viewer.fence();
        expect(viewer.events.at(-1)).toMatchObject({ type: "done" });
    });

    it("sends raw checkpoint rows by stream reference only while no viewer shares the job chat", async () => {
        const h = await live({ preferred: true });
        const viewer = await h.follow(h.job.id, "tab", "&hydration=patch&rows=streamed");
        await viewer.fence();
        const owner = await h.take("worker", "&hydration=patch&rows=streamed");
        await owner.fence();
        await viewer.fence();
        h.job.write(() => ({ chats: [group(h.revision(), [begin("r", "g1")])] }));
        h.job.emitRecords({ chats: [{ characterId: "c", id: "k" }] });
        const raw = (seq: number, text: string) => {
            h.job.write(() => ({ chats: [group(h.revision(), [checkpoint("r", "g1", seq, text)])] }), {
                covers: [{ messageId: "r", generationId: "g1", seq, raw: true }],
            });
            h.job.emitRecords({ chats: [{ characterId: "c", id: "k" }] });
        };
        raw(1, "one");
        await owner.fence();
        await viewer.fence();
        // The viewer gets the same event and cannot be assumed to hold the owner's stream buffer.
        expect(chats(owner.events).at(-1)).toMatchObject({
            type: "chatPatch",
            messages: [{ after: "u", message: expect.objectContaining({ chatId: "r", data: "one" }) }],
        });
        expect(chats(viewer.events).at(-1)).toEqual(chats(owner.events).at(-1));
        await viewer.close();
        raw(2, "one two");
        await owner.fence();
        expect(chats(owner.events).at(-1)).toMatchObject({
            type: "chatPatch",
            messages: [{ after: "u", id: "r", streamed: { generationId: "g1", seq: 2 } }],
        });
    });

    it("shares whole hydration, speaker checkpoints, viewer resync, and a legacy viewer's callback barrier with every socket", async () => {
        const h = await live({ preferred: true });
        const viewer = await h.follow(h.job.id, "tab", "&hydration=patch");
        await viewer.fence();
        viewer.events.length = 0;
        const owner = await h.take();
        await owner.fence();
        await viewer.fence();
        expect(chats(owner.events)).toHaveLength(1);
        expect(chats(owner.events)[0]).toMatchObject({
            type: "resource",
            kind: "chats",
            data: { message: [m("u", "hi"), m("r", "", "char")] },
        });
        expect(chats(viewer.events)).toEqual(chats(owner.events));
        owner.events.length = viewer.events.length = 0;
        h.job.write(() => ({
            chats: [group(h.revision(), [begin("r", "g1"), checkpoint("r", "g1", 1, "first speaker")])],
        }));
        h.job.emitRecords({ chats: [{ characterId: "c", id: "k" }] });
        h.job.write(() => ({
            chats: [
                group(h.revision(), [
                    {
                        op: "append",
                        anchor: { end: true },
                        messages: [{ ...m("second", "second speaker", "char"), saying: "speaker-two" }],
                    },
                ]),
            ],
        }));
        h.job.emitRecords({ chats: [{ characterId: "c", id: "k" }] });
        await owner.fence();
        await viewer.fence();
        expect(chats(viewer.events)).toEqual(chats(owner.events));
        expect(chats(owner.events)).toHaveLength(2);
        expect(chats(owner.events)[1]).toMatchObject({
            type: "chatPatch",
            messages: expect.arrayContaining([
                expect.objectContaining({
                    after: "r",
                    message: expect.objectContaining({
                        chatId: "second",
                        data: "second speaker",
                        saying: "speaker-two",
                    }),
                }),
            ]),
        });
        owner.events.length = viewer.events.length = 0;
        viewer.ws.send(JSON.stringify({ type: "resync" }));
        await viewer.fence();
        await owner.fence();
        expect(chats(owner.events)[0]).toMatchObject({ type: "resource", kind: "chats" });
        expect(chats(viewer.events)).toEqual(chats(owner.events));
        const legacy = await h.follow(h.job.id, "tab", "&attach=1");
        await legacy.fence();
        await owner.fence();
        legacy.events.length = owner.events.length = 0;
        const pending = h.job.channel.callback("editoutput", { text: "barrier" });
        await owner.fence();
        await legacy.fence();
        expect(chats(owner.events)).toHaveLength(1);
        expect(chats(owner.events)[0]).toMatchObject({ type: "resource", kind: "chats" });
        expect(chats(legacy.events)).toEqual(chats(owner.events));
        const callback = callbacks(owner.events)[0];
        expect(owner.events.indexOf(chats(owner.events)[0])).toBeLessThan(owner.events.indexOf(callback));
        await answer(owner, callback.id);
        await pending;
    });

    it.each([true, false])(
        "freezes late replay for the final recipient when the worker is attached: %s",
        async (attached) => {
            const h = await live({ preferred: true, receipts: true });
            const creator = await h.follow(h.job.id);
            const worker = await h.take();
            await worker.fence();
            if (!attached) await worker.close();
            const skipped = [{ name: "chatOutput" as const, payload: { messageId: "r", speakerId: "c" } }];
            const missed = [{ name: "chatOutput" as const, payload: { messageId: "previous", speakerId: "c" } }];
            h.job.emit({ type: "done", revision: h.revision(), skipped, missed });
            await creator.fence();
            if (attached) await worker.fence();
            const creatorList = attached ? [] : skipped;
            const workerList = attached ? skipped : [];
            expect(creator.events.at(-1)).toMatchObject({ type: "done", skipped: creatorList, missed });
            if (attached) expect(worker.events.at(-1)).toMatchObject({ type: "done", skipped: workerList, missed });
            const lateCreator = await h.follow(h.job.id);
            await lateCreator.fence();
            expect(lateCreator.events[0]).toMatchObject({ type: "handoff", owner: "other" });
            expect(lateCreator.events.at(-1)).toMatchObject({ skipped: creatorList, missed });
            expect(h.jobs.status(h.job.id, "tab")).toMatchObject({
                handedOff: true,
                terminal: { skipped: creatorList, missed },
            });
            expect(h.jobs.status(h.job.id, "worker")).toMatchObject({
                handedOff: true,
                terminal: { skipped: workerList, missed },
            });
            expect(h.jobs.create(h.body, h.store.epoch())).toMatchObject({
                ok: true,
                status: { terminal: { skipped: creatorList, missed } },
            });
            expect(h.jobs.cancel({ requestId: "handoff-request", clientId: "tab" }, h.store.epoch())).toMatchObject({
                ok: true,
                body: { status: { terminal: { skipped: creatorList, missed } } },
            });
            expect(h.receipts!.read(h.job.id)).toMatchObject({
                clientId: "tab",
                status: { terminal: { skipped: creatorList, missed } },
            });
            h.jobs.startGc();
            await vi.advanceTimersByTimeAsync(JOB_DONE_GRACE_MS);
            expect(h.jobs.status(h.job.id, "worker")).toMatchObject({
                kept: true,
                terminal: { skipped: workerList, missed },
            });
            expect(h.jobs.status(h.job.id, "tab")).toMatchObject({
                kept: true,
                terminal: { skipped: creatorList, missed },
            });
            expect(h.jobs.status(h.job.id, "third")).toBeNull();
        },
    );
});
