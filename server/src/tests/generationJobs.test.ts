// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeCharacter } from "../../../shared/characters.ts";
import type { ChatOp } from "../../../shared/chats.ts";
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
    JobWriteConflictError,
    markFailure,
    type RunningJob,
} from "../jobs/generationJobs.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";
import { sleep, waitFor } from "./testSupport.ts";

// The generation job registry (`server/src/jobs/generationJobs.ts`) in process, with a fake runner
// per test: admission, the job's write capability (lock handoff, rollback, the one F-b retry, the
// fence outcomes), the end of a job (one terminal, dead capabilities, released locks and slot), the
// abort deadline, maintenance, and shutdown. The routes and the owner socket are covered by
// `generations.test.ts`.

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
function setup(options: { feed?: boolean; failCommitted?: { current: boolean } } = {}) {
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
                          ((applied) => {
                              const lists = writeOptions.committed!(applied);
                              if (failing.current) {
                                  throw new Error("bookkeeping failed");
                              }
                              return lists;
                          }),
                  })) satisfies ResourceStore["applyChanges"],
          })
        : store;
    const snapshots: SnapshotManager = createSnapshotManager({ store, dir: path.join(dir, "backups") });
    let runner: GenerationRunner = async () => {};
    const jobs = createGenerationJobs({
        store: jobStore,
        kinds,
        gate: snapshots.gate,
        snapshots,
        lock,
        authorize: async () => true,
        runner: (job) => runner(job),
    });
    cleanups.push(async () => {
        jobs.beginShutdown();
        await jobs.drain();
        jobs.dispose();
        await snapshots.stop();
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
    return { dir, lock, store, snapshots, jobs, revision, text, context, create, run, ended, owner, bound, events };
}

describe("admission", () => {
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
