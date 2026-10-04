// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeCharacter } from "../../../shared/characters.ts";
import type { ChatOp } from "../../../shared/chats.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore, type ResourceStore } from "../data/resourceStore.ts";
import { createSnapshotManager, type SnapshotManager } from "../data/snapshots.ts";
import {
    createGenerationJobs,
    GenerationJobEndedError,
    GenerationRunnerError,
    type GenerationRunner,
    JOB_ABORT_GRACE_MS,
    JobWriteConflictError,
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

function setup() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-generation-jobs-"));
    const lock = createGenerationLock();
    const store: ResourceStore = createResourceStore({
        file: path.join(dir, "data", "resources.sqlite"),
        kinds,
        guard: lock,
    });
    const snapshots: SnapshotManager = createSnapshotManager({ store, dir: path.join(dir, "backups") });
    let runner: GenerationRunner = async () => {};
    const jobs = createGenerationJobs({
        store,
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
    store.applyChanges({
        ops: [{ kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
        chats: [
            group(null, [{ op: "create", chat: { name: "K", message: [m("u", "hi"), m("r", "", "char")] } as never }]),
            group(null, [{ op: "create", chat: { name: "J", message: [m("x", "X")] } as never }], "j"),
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
        presetId: null,
        personaId: null,
        mode: "normal",
        input,
        chatRevision: revision(),
    });
    /** Creates a job for chat k owned by `tab` and returns its id (the create must succeed). */
    const create = (input = "", kind: "send" | "command" = "send") => {
        // A command job carries what it runs (slice 8a); the body is a union by kind, so each branch names its kind.
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
    return { dir, lock, store, snapshots, jobs, revision, text, context, create, run, ended, owner };
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
