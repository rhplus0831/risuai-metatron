// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { DiagnosticEventInput } from "../../../shared/diagnostics.ts";
import { NO_GENERATION_HOOKS, type GenerationStatus, type GenerationTerminalEvent } from "../../../shared/jobs.ts";
import {
    createGenerationReceipts,
    type GenerationReceiptAdmission,
    type GenerationReceipts,
} from "../data/generationReceipts.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { createSnapshotManager } from "../data/snapshots.ts";
import { createGenerationJobs, type GenerationRunner } from "../jobs/generationJobs.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";
import { createAuthStore } from "../routes/auth.ts";
import { registerGenerationRoutes } from "../routes/generations.ts";
import type { AppEnv } from "../types.ts";
import { createResourceTestClient, createTestServer } from "./testSupport.ts";

const HOUR = 60 * 60_000;
const START = Date.parse("2026-10-28T00:00:00Z");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.useRealTimers();
});

function directory(parent = os.tmpdir()) {
    const dir = mkdtempSync(path.join(parent, "risu-generation-receipts-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}
function open(
    file = path.join(directory(), "generation-jobs.sqlite"),
    epoch = "epoch",
    now = () => START,
    events: DiagnosticEventInput[] = [],
) {
    const receipts = createGenerationReceipts({
        file,
        epoch,
        now,
        diagnostics: { record: (event) => events.push(event) },
    });
    cleanups.push(() => receipts.close());
    return receipts;
}
function admission(jobId: string, epoch = "epoch", admittedAt = START): GenerationReceiptAdmission {
    return { jobId, clientId: "owner", epoch, kind: "command", characterId: "c", chatId: "k", admittedAt };
}
function outcome(
    jobId: string,
    epoch = "epoch",
    terminal: GenerationTerminalEvent = { type: "done", epoch, revision: "r" },
): GenerationStatus {
    return { jobId, kind: "command", characterId: "c", chatId: "k", epoch, state: "ended", terminal, kept: true };
}
function finish(receipts: GenerationReceipts, jobId: string, endedAt = START, epoch = "epoch") {
    receipts.admit(admission(jobId, epoch));
    receipts.end(jobId, endedAt, outcome(jobId, epoch));
}
/** A separate connection is used only for fault injection and physical retention checks. */
function sql<T>(file: string, work: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(file);
    try {
        return work(db);
    } finally {
        db.close();
    }
}
function counts(file: string) {
    return sql(file, (db) => db.prepare("SELECT COUNT(*) AS rows, COUNT(status) AS payloads FROM receipts").get());
}
function clock() {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(START);
}

/** Real resource store and receipt store; only the job's runner and clock are controlled. */
function registryFixture(beforeOpen?: (file: string, epoch: string) => void) {
    const dir = directory();
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const lock = createGenerationLock();
    const store = createResourceStore({ file: path.join(dir, "resources.sqlite"), kinds, guard: lock });
    cleanups.push(() => store.close());
    const snapshots = createSnapshotManager({ store, dir: path.join(dir, "backups") });
    cleanups.push(() => snapshots.stop());
    const first = (kind: string) => (store.get(kinds.get(kind)!, "main")!.data as { id: string }[])[0].id;
    const bound = { presetId: first("presets"), modelPresetId: first("modelPresets"), personaId: first("personas") };
    store.applyChanges({
        ops: [{ kind: kinds.get("characters")!, id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
        chats: [
            {
                characterId: "c",
                chatId: "k",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            name: "K",
                            message: [],
                            promptPresetId: bound.presetId,
                            modelPresetId: bound.modelPresetId,
                            bindedPersona: bound.personaId,
                        } as never,
                    },
                ],
            },
        ],
    });
    const file = path.join(dir, "generation-jobs.sqlite");
    beforeOpen?.(file, store.epoch());
    const events: DiagnosticEventInput[] = [];
    const receipts = open(file, store.epoch(), () => Date.now(), events);
    const registry = (
        disk = receipts,
        runner: GenerationRunner = async (job) => {
            job.emit({ type: "done", revision: "r" });
        },
    ) => {
        const jobs = createGenerationJobs({
            store,
            kinds,
            gate: snapshots.gate,
            snapshots,
            lock,
            authorize: async () => true,
            runner,
            receipts: disk,
        });
        cleanups.push(async () => {
            jobs.beginShutdown();
            await jobs.drain();
            jobs.dispose();
        });
        return jobs;
    };
    const create = (jobs: ReturnType<typeof registry>) => {
        const result = jobs.create(
            {
                kind: "command",
                clientId: "owner",
                command: { type: "button", data: "" },
                context: {
                    characterId: "c",
                    chatId: "k",
                    ...bound,
                    mode: "normal",
                    input: "",
                    chatRevision: store.chatRevision("c", "k")!,
                },
            },
            store.epoch(),
        );
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error("Job admission failed");
        return result.jobId;
    };
    const changeEpoch = async () => {
        const snapshot = path.join(dir, "snapshot.sqlite");
        await store.backupTo(snapshot);
        store.replaceAll(store.readSnapshot(snapshot));
    };
    return { dir, bound, snapshots, file, store, receipts, events, registry, create, changeEpoch };
}

/** In-process HTTP, with real admission and SQLite; authentication is bypassed for this fixture. */
function requestFixture() {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(START);
    const s = registryFixture();
    const body = {
        kind: "send" as const,
        requestId: "request-one",
        clientId: "owner",
        context: {
            characterId: "c",
            chatId: "k",
            ...s.bound,
            mode: "normal",
            input: "hello",
            userMessageId: "user-one",
            chatRevision: s.store.chatRevision("c", "k")!,
        },
    };
    const route = (jobs: ReturnType<typeof s.registry>) => {
        const app = new Hono<AppEnv>();
        registerGenerationRoutes(app, {
            jobs,
            auth: createAuthStore(s.dir, { bypass: true }),
            limiter: async (_c, next) => next(),
        });
        return async (value: unknown = body, endpoint = "/api/generations", epoch = s.store.epoch()) => {
            const response = await app.request(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json", "x-resource-epoch": epoch },
                body: JSON.stringify(value),
            });
            return {
                status: response.status,
                body: (await response.json()) as {
                    jobId?: string;
                    replayed?: boolean;
                    status?: GenerationStatus | null;
                    error?: string;
                },
            };
        };
    };
    return { ...s, body, route };
}

describe("request identity over HTTP", () => {
    it("replays a completed unanswered create before revision, binding, maintenance and shutdown refusals", async () => {
        const s = requestFixture();
        const runner = vi.fn<GenerationRunner>(async (job) => {
            job.write(() => ({
                chats: [
                    {
                        characterId: "c",
                        chatId: "k",
                        baseRevision: s.body.context.chatRevision,
                        ops: [
                            {
                                op: "append",
                                messages: [{ role: "user", data: "hello", chatId: "user-one" }],
                                anchor: { end: true },
                            },
                        ],
                    },
                ],
            }));
            job.emit({ type: "done", revision: s.store.chatRevision("c", "k")!, result: "owner-only" });
        });
        const jobs = s.registry(s.receipts, runner);
        const post = s.route(jobs);
        // The caller never consumes the first create's answer.
        await post();
        await jobs.drain();
        expect(s.store.chatRevision("c", "k")).not.toBe(s.body.context.chatRevision);
        const receipt = s.receipts.readByRequest(s.body.requestId);
        expect(receipt).toMatchObject({ cancelled: false, status: { state: "ended" } });
        if (!receipt || receipt.cancelled) throw new Error("Missing admitted receipt");
        const replay = {
            status: 200,
            body: {
                jobId: receipt.jobId,
                replayed: true,
                owned: true,
                status: { state: "ended", terminal: { type: "done", result: "owner-only" } },
            },
        };
        expect(await post()).toMatchObject(replay);
        await s.snapshots.withMaintenance(async () => {
            expect(s.snapshots.gate.active).toBe(true);
            expect(await post()).toMatchObject(replay);
            expect(await post(s.body, "/api/generations", "old-epoch")).toMatchObject({ status: 412 });
        });
        s.store.applyChanges({
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: s.store.chatRevision("c", "k"),
                    ops: [{ op: "meta", set: { bindedPersona: null } }],
                },
            ],
        });
        expect(await post()).toMatchObject(replay);
        // Revision, bindings, hooks and client id do not belong to the fingerprint.
        const foreign = await post({
            ...s.body,
            clientId: "other",
            hooks: { ...NO_GENERATION_HOOKS, chatOutput: true },
            context: { ...s.body.context, chatRevision: s.store.chatRevision("c", "k"), personaId: null },
        });
        expect(foreign).toMatchObject({
            status: 200,
            body: {
                jobId: receipt.jobId,
                replayed: true,
                owned: false,
                status: { state: "ended", terminal: { type: "done" } },
            },
        });
        expect(foreign.body.status?.terminal).not.toHaveProperty("result");
        jobs.beginShutdown();
        expect(await post()).toMatchObject(replay);
        expect(runner).toHaveBeenCalledTimes(1);
    });

    it("admits identical concurrent posts once while the runner is latched and rejects changed request identities", async () => {
        const s = requestFixture();
        const runner = vi.fn<GenerationRunner>(async (job) => {
            await new Promise<void>((resolve) => {
                if (job.signal.aborted) resolve();
                else job.signal.addEventListener("abort", () => resolve(), { once: true });
            });
        });
        const jobs = s.registry(s.receipts, runner);
        const post = s.route(jobs);
        const answers = await Promise.all([post(), post()]);
        expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
        const first = answers.find((answer) => !answer.body.replayed)!;
        const replay = answers.find((answer) => answer.body.replayed)!;
        expect(replay).toMatchObject({
            status: 200,
            body: { jobId: first.body.jobId, replayed: true, owned: true, status: { state: "running" } },
        });
        expect(runner).toHaveBeenCalledTimes(1);
        for (const change of [{ input: "changed" }, { characterId: "another-character" }]) {
            expect(await post({ ...s.body, context: { ...s.body.context, ...change } })).toEqual({
                status: 409,
                body: { error: "requestIdReused" },
            });
        }
        expect(runner).toHaveBeenCalledTimes(1);
    });

    it("cancels an unknown request before its late create and aborts only the named running request across owners", async () => {
        const s = requestFixture();
        const signals: AbortSignal[] = [];
        const jobs = s.registry(s.receipts, async (job) => {
            signals.push(job.signal);
            await new Promise<void>((resolve) => {
                if (job.signal.aborted) resolve();
                else job.signal.addEventListener("abort", () => resolve(), { once: true });
            });
        });
        const post = s.route(jobs);
        const running = await post();
        const cancel = (requestId: string) => post({ requestId, clientId: "another-tab" }, "/api/generations/cancel");
        expect(await cancel("late-request")).toEqual({ status: 200, body: { state: "cancelled" } });
        expect(signals[0].aborted).toBe(false);
        expect(await post({ ...s.body, requestId: "late-request" })).toEqual({
            status: 409,
            body: { error: "requestCancelled" },
        });
        expect(await cancel(s.body.requestId)).toMatchObject({
            status: 200,
            body: { state: "aborted", jobId: running.body.jobId, owned: false },
        });
        expect(signals[0].aborted).toBe(true);
        await jobs.drain();
        expect(await post()).toMatchObject({
            status: 200,
            body: { replayed: true, status: { state: "ended", terminal: { type: "error", reason: "aborted" } } },
        });
        expect(signals).toHaveLength(1);
    });

    it("replays an interrupted request as shutdown after the receipts are reopened", async () => {
        const s = requestFixture();
        const jobs = s.registry(s.receipts, async (job) => {
            await new Promise<void>((resolve) => job.signal.addEventListener("abort", () => resolve(), { once: true }));
        });
        const first = await s.route(jobs)();
        // Closing the disk first leaves the running admission without a terminal, as a crash does.
        s.receipts.close();
        jobs.beginShutdown();
        await jobs.drain();
        jobs.dispose();
        const reopened = open(s.file, s.store.epoch(), () => Date.now());
        const runner = vi.fn<GenerationRunner>(async () => {});
        const next = s.registry(reopened, runner);
        expect(await s.route(next)()).toMatchObject({
            status: 200,
            body: {
                jobId: first.body.jobId,
                replayed: true,
                owned: true,
                status: { state: "ended", terminal: { type: "error", reason: "shutdown", status: 503 } },
            },
        });
        expect(runner).not.toHaveBeenCalled();
    });

    it("admits a request id again after 72 hours without degrading or losing its new receipt", async () => {
        const s = requestFixture();
        const runner = vi.fn<GenerationRunner>(async (job) => {
            job.emit({ type: "done", revision: "r" });
        });
        const jobs = s.registry(s.receipts, runner);
        const post = s.route(jobs);
        const first = await post();
        await jobs.drain();
        jobs.startGc();
        await vi.advanceTimersByTimeAsync(60_000);
        // No GC timer fires after the jump: lookup itself must retire the expired unique request key.
        vi.setSystemTime(START + 72 * HOUR + 1);
        const second = await post();
        expect(second.status).toBe(200);
        expect(second.body).not.toHaveProperty("replayed", true);
        expect(second.body.jobId).not.toBe(first.body.jobId);
        await jobs.drain();
        expect(runner).toHaveBeenCalledTimes(2);
        expect(s.receipts.degraded()).toBe(false);
        expect(s.receipts.readByRequest(s.body.requestId)).toMatchObject({
            jobId: second.body.jobId,
            status: { state: "ended", terminal: { type: "done" } },
        });
    });
});

describe("generation receipts on disk", () => {
    it("ends an interrupted job on reopen, preserving progress and the owning tab's status", () => {
        clock();
        const s = registryFixture();
        const epoch = s.store.epoch();
        const progress = { sent: 2, parts: [null, { text: "kept", flags: [true, 3] }] };
        s.receipts.admit(admission("interrupted", epoch, START - HOUR));
        s.receipts.progress("interrupted", progress);
        finish(s.receipts, "finished", START - 1, epoch);
        s.receipts.close();
        vi.setSystemTime(START + 100);
        const reopened = open(s.file, epoch, () => Date.now());
        const jobs = s.registry(reopened);
        const expected = outcome("interrupted", epoch, {
            type: "error",
            epoch,
            reason: "shutdown",
            status: 503,
            message: "The server stopped while this job ran",
        });
        expect(reopened.read("interrupted")).toEqual({
            ...admission("interrupted", epoch, START - HOUR),
            requestId: null,
            fingerprint: null,
            endedAt: START + 100,
            progress,
            status: expected,
        });
        expect(jobs.status("interrupted", "owner")).toEqual(expected);
        expect(jobs.status("interrupted", "other")).toBeNull();
        expect(jobs.status("interrupted", undefined)).toBeNull();
        expect(jobs.status("finished", "owner")).toEqual(outcome("finished", epoch));
        reopened.close();
        vi.setSystemTime(START + 200);
        expect(open(s.file, epoch).read("interrupted")?.endedAt).toBe(START + 100);
    });

    it("deletes other epochs at open and on sync, so switching back cannot revive them", () => {
        let now = START;
        const file = path.join(directory(), "generation-jobs.sqlite");
        const first = open(file, "old", () => now);
        first.admit(admission("running", "old"));
        finish(first, "ended", now, "old");
        first.close();
        now++;
        const next = open(file, "new", () => now);
        expect(next.read("running")).toBeNull();
        expect(next.read("ended")).toBeNull();
        expect(counts(file)).toEqual({ rows: 0, payloads: 0 });
        finish(next, "current", now, "new");
        next.sync("replacement");
        expect(counts(file)).toEqual({ rows: 0, payloads: 0 });
        next.sync("new");
        expect(next.read("current")).toBeNull();
    });

    it("clears the oldest payload above 500 and expires payloads at 24 hours while retaining identity and progress", () => {
        let now = START;
        const file = path.join(directory(), "generation-jobs.sqlite");
        const receipts = open(file, "epoch", () => now);
        // Admission order differs from end order; the earliest end must lose its payload.
        for (let n = 0; n <= 500; n++) finish(receipts, `job-${n}`, START - n);
        receipts.progress("job-500", ["opaque", { count: 7 }]);
        receipts.prune(now);
        expect(counts(file)).toEqual({ rows: 501, payloads: 500 });
        expect(receipts.read("job-500")).toMatchObject({
            ...admission("job-500"),
            progress: ["opaque", { count: 7 }],
            status: null,
        });
        expect(receipts.read("job-499")?.status).toEqual(outcome("job-499"));
        now = START + 24 * HOUR - 1;
        expect(receipts.read("job-0")?.status).toEqual(outcome("job-0"));
        now++;
        // No prune or timer ran: a retained payload must already be unreadable at the boundary.
        expect(receipts.read("job-0")).toMatchObject({ jobId: "job-0", status: null });
        receipts.prune(now);
        expect(counts(file)).toEqual({ rows: 501, payloads: 0 });
        expect(receipts.read("job-500")?.progress).toEqual(["opaque", { count: 7 }]);
        now = START + 72 * HOUR - 1;
        expect(receipts.read("job-0")).not.toBeNull();
        now++;
        expect(receipts.read("job-0")).toBeNull();
        receipts.prune(now);
        expect(counts(file)).toEqual({ rows: 0, payloads: 0 });
    });

    it("caps compact rows at 10000 and prunes an expiry backlog in bounded passes without removing a running row", () => {
        let now = START;
        const file = path.join(directory(), "generation-jobs.sqlite");
        const receipts = open(file, "epoch", () => now);
        receipts.admit(admission("running", "epoch", START - 100 * HOUR));
        receipts.progress("running", { completed: 1 });
        for (let n = 0; n < 10_001; n++) finish(receipts, `job-${n}`, START + n);
        now += 10_001;
        receipts.prune(now);
        expect(counts(file)?.rows).toBe(10_000);
        expect(receipts.read("job-0")).toBeNull();
        expect(receipts.read("job-1")).toBeNull();
        expect(receipts.read("job-2")).not.toBeNull();
        now += 72 * HOUR;
        receipts.prune(now);
        const remaining = Number(counts(file)?.rows);
        expect(remaining).toBeGreaterThan(1);
        expect(remaining).toBeLessThan(10_000);
        for (let n = 0; n < 20 && Number(counts(file)?.rows) > 1; n++) receipts.prune(now);
        expect(counts(file)).toEqual({ rows: 1, payloads: 0 });
        expect(receipts.read("running")).toMatchObject({
            ...admission("running", "epoch", START - 100 * HOUR),
            endedAt: null,
            progress: { completed: 1 },
            status: null,
        });
        expect(receipts.degraded()).toBe(false);
    });
});

describe("the registry's disk fallback", () => {
    it("answers live and collected outcomes from memory before disk, including owner refusals", async () => {
        clock();
        const s = registryFixture();
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
            resolve = done;
        });
        const release = { promise, resolve };
        const jobs = s.registry(s.receipts, async (job) => {
            await release.promise;
            job.emit({ type: "done", revision: "r", result: "preview" });
        });
        cleanups.push(() => release.resolve());
        const id = s.create(jobs);
        // A real failed disk read would degrade the store. Neither memory path may attempt it.
        sql(s.file, (db) => db.prepare("UPDATE receipts SET progress = ? WHERE job_id = ?").run("invalid JSON", id));
        vi.setSystemTime(START + 1);
        expect(jobs.status(id, "owner")?.state).toBe("running");
        expect(jobs.status(id, "other")).toBeNull();
        expect(s.receipts.degraded()).toBe(false);
        release.resolve();
        await jobs.drain();
        expect(jobs.status(id, "owner")?.terminal).toMatchObject({ type: "done", result: "preview" });
        jobs.startGc();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(jobs.status(id, "owner")).toEqual(outcome(id, s.store.epoch()));
        expect(jobs.status(id, "other")).toBeNull();
        expect(s.receipts.degraded()).toBe(false);
    });

    it("runs receipt pruning on the 30 second GC tick", async () => {
        clock();
        const s = registryFixture();
        finish(s.receipts, "expired", START - 24 * HOUR, s.store.epoch());
        s.receipts.admit(admission("running", s.store.epoch(), START - 100 * HOUR));
        const jobs = s.registry();
        jobs.startGc();
        vi.setSystemTime(START + 1);
        await vi.advanceTimersByTimeAsync(29_999);
        expect(counts(s.file)).toEqual({ rows: 2, payloads: 1 });
        await vi.advanceTimersByTimeAsync(1);
        expect(counts(s.file)).toEqual({ rows: 2, payloads: 0 });
        expect(s.receipts.read("running")?.endedAt).toBeNull();
    });

    it("syncs disk receipts when the registry observes an epoch change", async () => {
        clock();
        const s = registryFixture();
        const jobs = s.registry();
        const id = s.create(jobs);
        await jobs.drain();
        jobs.startGc();
        await vi.advanceTimersByTimeAsync(60_000);
        await s.changeEpoch();
        vi.setSystemTime(Date.now() + 1);
        expect(jobs.status(id, "owner")).toBeNull();
        expect(s.receipts.read(id)).toBeNull();
        expect(counts(s.file)).toEqual({ rows: 0, payloads: 0 });
    });

    it("persists the kept terminal trim for disk-only status reads", async () => {
        clock();
        const s = registryFixture();
        const epoch = s.store.epoch();
        const small = [{ clear: false, parts: ["next"] }];
        const big = "é".repeat(32 * 1024); // Under 64 Ki characters, over 64 KiB once JSON encoded.
        const terminals: GenerationTerminalEvent[] = [
            {
                type: "done",
                epoch,
                revision: "r",
                result: { preview: "private" },
                alternatives: ["alt"],
                followUps: small,
            },
            { type: "done", epoch, revision: "r", alternatives: ["alt"], followUps: [{ clear: true, parts: [big] }] },
            { type: "done", epoch, revision: "r", alternatives: [big], followUps: small },
            { type: "error", epoch, reason: "failed", status: 500, message: "x".repeat(4095) + "€tail" },
        ];
        const expected: GenerationTerminalEvent[] = [
            { type: "done", epoch, revision: "r", alternatives: ["alt"], followUps: small },
            { type: "done", epoch, revision: "r", alternatives: ["alt"], followUpsDropped: true },
            { type: "done", epoch, revision: "r", followUps: small },
            { type: "error", epoch, reason: "failed", status: 500, message: "x".repeat(4095) },
        ];
        let current = 0;
        const jobs = s.registry(s.receipts, async (job) => {
            job.emit(terminals[current++]);
        });
        const ids: string[] = [];
        for (const _ of terminals) {
            ids.push(s.create(jobs));
            await jobs.drain();
        }
        jobs.startGc();
        await vi.advanceTimersByTimeAsync(60_000);
        ids.forEach((id, n) => expect(jobs.status(id, "owner")).toEqual(outcome(id, epoch, expected[n])));
        jobs.beginShutdown();
        await jobs.drain();
        jobs.dispose();
        s.receipts.close();
        const reopened = open(s.file, epoch, () => Date.now());
        const restarted = s.registry(reopened);
        ids.forEach((id, n) => expect(restarted.status(id, "owner")).toEqual(outcome(id, epoch, expected[n])));
        vi.setSystemTime(START + 24 * HOUR - 1);
        expect(restarted.status(ids[0], "owner")).toEqual(outcome(ids[0], epoch, expected[0]));
        vi.setSystemTime(START + 24 * HOUR);
        expect(restarted.status(ids[0], "owner")).toBeNull();
    });
});

const faults = ["open", "reopen", "admission", "terminal", "read", "progress", "sync", "prune"] as const;
describe("receipt failures", () => {
    it.each(faults)(
        "falls back to memory for good after a failure (%s), frees the chat, and records one content-free fault",
        async (fault) => {
            clock();
            const s = registryFixture((file, epoch) => {
                if (fault === "open") mkdirSync(file);
                if (fault === "reopen") {
                    const initial = open(file, epoch);
                    finish(initial, "disk-only", START, epoch);
                    initial.close();
                    sql(file, (db) => db.exec("PRAGMA user_version = 999"));
                }
            });
            const epoch = s.store.epoch();
            const jobs = s.registry();
            const secret = "private receipt failure /private/customer/generation-jobs.sqlite";
            if (fault !== "open" && fault !== "reopen") {
                finish(s.receipts, "disk-only", START, epoch);
            }
            const inject = (operation: "INSERT" | "DELETE" | "UPDATE") =>
                sql(s.file, (db) =>
                    db.exec(
                        `CREATE TRIGGER fail_receipt BEFORE ${operation} ON receipts BEGIN SELECT RAISE(FAIL, '${secret}'); END`,
                    ),
                );
            if (fault === "admission") inject("INSERT");
            const id = s.create(jobs);
            if (fault === "terminal") {
                expect(s.receipts.degraded()).toBe(false);
                inject("INSERT");
            }
            await jobs.drain();
            if (["read", "progress", "sync", "prune"].includes(fault)) {
                expect(s.receipts.degraded()).toBe(false);
                if (fault !== "read") inject(fault === "sync" ? "DELETE" : "UPDATE");
            }
            if (fault === "read") {
                sql(s.file, (db) =>
                    db.exec("UPDATE receipts SET progress = 'private invalid JSON' WHERE job_id = 'disk-only'"),
                );
                expect(jobs.status("disk-only", "owner")).toBeNull();
            } else if (fault === "progress") s.receipts.progress("disk-only", { part: 1 });
            else if (fault === "sync") s.receipts.sync("replacement");
            else if (fault === "prune") s.receipts.prune(START + 24 * HOUR);
            expect(s.receipts.degraded()).toBe(true);
            expect(jobs.status(id, "owner")?.terminal).toEqual({ type: "done", epoch, revision: "r" });
            // Repair the underlying fault: the process must still never serve disk receipts again.
            if (fault === "open") {
                rmSync(s.file, { recursive: true });
                const repaired = open(s.file, epoch);
                finish(repaired, "disk-only", START, epoch);
                repaired.close();
            } else
                sql(s.file, (db) => {
                    db.exec(
                        "DROP TRIGGER IF EXISTS fail_receipt; PRAGMA user_version = 1; UPDATE receipts SET progress = NULL",
                    );
                });
            expect(jobs.status("disk-only", "owner")).toBeNull();
            vi.setSystemTime(START + 1);
            const next = s.create(jobs); // Same chat: the failed receipt must not strand its slot.
            await jobs.drain();
            jobs.startGc();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(jobs.status(id, "owner")).toEqual(outcome(id, epoch));
            expect(jobs.status(next, "owner")).toEqual(outcome(next, epoch));
            s.receipts.progress(id, [1]);
            s.receipts.sync(epoch);
            s.receipts.prune(Date.now());
            expect(s.receipts.read("disk-only")).toBeNull();
            expect(s.receipts.degraded()).toBe(true);
            expect(s.events).toHaveLength(1);
            expect(s.events[0]).toMatchObject({ kind: "runtime", origin: "generation.receipts" });
            expect(s.events[0]).not.toHaveProperty("message");
            expect(s.events[0]).not.toHaveProperty("path");
            const diagnostic = JSON.stringify(s.events);
            expect(diagnostic).not.toContain(secret);
            expect(diagnostic).not.toContain("private invalid JSON");
            expect(diagnostic).not.toContain(s.file);
        },
    );
});

describe("server receipt lifetime", () => {
    it("reopens the save directory's receipts and answers the owner's HTTP status until expiry", async () => {
        clock();
        const first = await createResourceTestClient({ memoryTasks: "disabled" });
        cleanups.push(() => first.close());
        const { generationReceipts } = first.context;
        finish(generationReceipts, "finished", START, first.epoch);
        generationReceipts.admit(admission("interrupted", first.epoch));
        generationReceipts.progress("interrupted", { sent: 2 });
        await first.context.dispose();
        // Disposal closes the receipt connection as well as the resource store.
        expect(generationReceipts.read("finished")).toBeNull();
        vi.setSystemTime(START + 1);
        const second = createTestServer({ rootDir: first.rootDir, memoryTasks: "disabled" });
        cleanups.push(() => second.context.dispose());
        const read = async (id: string, clientId: string) =>
            second.app.request(`/api/generations/${id}?clientId=${clientId}`, { headers: await first.headers() });
        expect((await read("finished", "owner")).status).toBe(200);
        expect(await (await read("finished", "owner")).json()).toEqual(outcome("finished", first.epoch));
        expect(await (await read("interrupted", "owner")).json()).toEqual(
            outcome("interrupted", first.epoch, {
                type: "error",
                epoch: first.epoch,
                reason: "shutdown",
                status: 503,
                message: "The server stopped while this job ran",
            }),
        );
        expect(second.context.generationReceipts.read("interrupted")?.progress).toEqual({ sent: 2 });
        expect((await read("finished", "other")).status).toBe(404);
        vi.setSystemTime(START + 24 * HOUR - 1);
        expect((await read("finished", "owner")).status).toBe(200);
        vi.setSystemTime(START + 24 * HOUR);
        expect((await read("finished", "owner")).status).toBe(404);
    });

    it("purges receipts as a restore finishes before any registry lookup", async () => {
        clock();
        const s = await createResourceTestClient({ memoryTasks: "disabled" });
        cleanups.push(() => s.close());
        finish(s.context.generationReceipts, "old", START, s.epoch);
        const snapshot = await s.context.snapshots.snapshotNow();
        vi.setSystemTime(START + 1);
        const restored = await s.request(`/api/backups/${snapshot.id}/restore`, { method: "POST" });
        expect(restored.status).toBe(200);
        expect(counts(path.join(s.savePath, "data", "generation-jobs.sqlite"))).toEqual({ rows: 0, payloads: 0 });
        expect(s.context.generationReceipts.read("old")).toBeNull();
        expect(s.context.generationJobs.status("old", "owner")).toBeNull();
    });
});

it("measures receipt admission, terminal writes, and event-loop delay", { tags: ["slow"] }, async () => {
    const parent = process.env.RISU_RECEIPTS_MEASURE_DIR ?? os.tmpdir();
    const file = path.join(directory(parent), "generation-jobs.sqlite");
    const receipts = open(file, "epoch", Date.now);
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    const admissions: number[] = [];
    const terminals: number[] = [];
    histogram.enable();
    try {
        await delay(10); // Warm the sampler; this measurement intentionally uses the real clock.
        for (let n = 0; n < 300; n++) {
            const id = `measured-${n}`;
            const terminal: GenerationTerminalEvent =
                n % 3 === 0
                    ? { type: "error", epoch: "epoch", reason: "failed", status: 500, message: "x".repeat(4096) }
                    : {
                          type: "done",
                          epoch: "epoch",
                          revision: "r",
                          alternatives: ["a".repeat(16 * 1024)],
                          followUps: [{ clear: false, parts: ["next".repeat(2048)] }],
                      };
            const payload = outcome(id, "epoch", terminal);
            let start = performance.now();
            receipts.admit(admission(id, "epoch", Date.now()));
            admissions.push(performance.now() - start);
            start = performance.now();
            receipts.end(id, Date.now(), payload);
            terminals.push(performance.now() - start);
            if (n % 10 === 9) await delay(2);
        }
        await delay(10);
    } finally {
        histogram.disable();
    }
    const cost = (samples: number[]) => {
        const sorted = [...samples].sort((a, b) => a - b);
        return {
            meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
            p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
            maxMs: sorted.at(-1),
        };
    };
    console.log(
        "receipt measurement",
        JSON.stringify({
            parent,
            jobs: 300,
            admission: cost(admissions),
            terminal: cost(terminals),
            eventLoop: {
                meanMs: histogram.mean / 1e6,
                p95Ms: histogram.percentile(95) / 1e6,
                maxMs: histogram.max / 1e6,
            },
        }),
    );
    expect(receipts.degraded()).toBe(false);
});
