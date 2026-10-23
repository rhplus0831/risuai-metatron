// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatOp } from "../../../shared/chats.ts";
import type { Chat, Message } from "../../../shared/database.ts";
import type { DiagnosticEventInput } from "../../../shared/diagnostics.ts";
import type { GenerationKind } from "../../../shared/jobs.ts";
import { createCheckpointService } from "../data/checkpointService.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore } from "../data/resourceStore.ts";
import { createSnapshotManager } from "../data/snapshots.ts";
import { createGenerationJobs, type GenerationRunner, type RunningJob } from "../jobs/generationJobs.ts";
import { createGenerationLock } from "../jobs/generationLock.ts";
import { createResourceTestClient, json } from "./testSupport.ts";

const ref = { characterId: "c", chatId: "k" };
const policyPath = "/api/chat-checkpoints/policy";
const message = (chatId: string, data = chatId, role: Message["role"] = "user"): Message => ({ chatId, data, role });
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function setup(hook?: Parameters<typeof createGenerationJobs>[0]["onChatJobDone"]) {
    // An abort must be decided by the runner's terminal, never a real grace deadline under load.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-checkpoint-auto-"));
    const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
    const lock = createGenerationLock();
    const store = createResourceStore({ file: path.join(dir, "resources.sqlite"), kinds, guard: lock });
    const snapshots = createSnapshotManager({ store, dir: path.join(dir, "backups") });
    const diagnostics: DiagnosticEventInput[] = [];
    const service = createCheckpointService({
        store,
        busy: (characterId, chatId) =>
            jobs.chatBusy(characterId, chatId) || lock.chatHolders(characterId, chatId).size > 0,
        memoryTasks: null,
    });
    let runner: GenerationRunner = async () => {};
    const jobs: ReturnType<typeof createGenerationJobs> = createGenerationJobs({
        store,
        kinds,
        gate: snapshots.gate,
        snapshots,
        lock,
        authorize: async () => true,
        runner: (job) => runner(job),
        onChatJobDone: hook ?? ((characterId, chatId) => service.autoSave(characterId, chatId)),
        diagnostics: { record: (event) => diagnostics.push(event) },
    });
    cleanups.push(async () => {
        jobs.beginShutdown();
        await jobs.drain();
        jobs.dispose();
        await snapshots.stop();
        store.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const firstId = (name: string) => (store.get(kinds.get(name)!, "main")!.data as { id: string }[])[0].id;
    const bound = {
        presetId: firstId("presets"),
        modelPresetId: firstId("modelPresets"),
        personaId: firstId("personas"),
    };
    store.put(kinds.get("characters")!, ref.characterId, { chaId: ref.characterId, name: "C" }, null);
    store.applyChanges({
        chats: [
            {
                ...ref,
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            name: "Story",
                            localLore: [],
                            note: "",
                            promptPresetId: bound.presetId,
                            modelPresetId: bound.modelPresetId,
                            bindedPersona: bound.personaId,
                            message: [message("u1"), message("reply", "draft", "char")],
                        },
                    },
                ],
            },
        ],
    });
    const revision = () => store.chatRevision(ref.characterId, ref.chatId)!;
    const chat = () => store.readChatSource(ref.characterId, ref.chatId).data!;
    const edit = (ops: ChatOp[]) => store.applyChanges({ chats: [{ ...ref, baseRevision: revision(), ops }] });
    const appendUser = (turn: number) =>
        edit([{ op: "append", anchor: { end: true }, messages: [message(`u${turn}`)] }]);
    const replaceTurns = (turns: number) =>
        edit([
            {
                op: "replace",
                chat: {
                    ...chat(),
                    message: [
                        ...Array.from({ length: turns }, (_, i) => message(`u${i + 1}`)),
                        message("reply", "draft", "char"),
                    ],
                },
            },
        ]);
    const policy = (autoEvery = 2, autoKeep = 5) => {
        const result = service.writePolicy({ epoch: store.epoch(), body: { ...ref, autoEvery, autoKeep } });
        expect(result.status).toBe(200);
    };
    const all = () => store.checkpoints.list(ref.characterId, ref.chatId)!;
    const autos = () => all().filter((checkpoint) => checkpoint.kind === "auto");
    const baseline = () => store.checkpoints.readPolicy(ref.characterId, ref.chatId)?.lastAutoTurns;
    const done = (job: RunningJob) => job.emit({ type: "done", messageId: "reply", revision: revision() });
    const start = (
        run: (job: RunningJob) => void | Promise<void> = done,
        kind: Exclude<GenerationKind, "command"> = "send",
    ) => {
        runner = async (job) => run(job);
        const result = jobs.create(
            {
                kind,
                context: { ...ref, ...bound, mode: "normal", input: "", chatRevision: revision() },
                clientId: "tab",
            },
            store.epoch(),
        );
        if (!result.ok) throw new Error(`create: ${result.status} ${JSON.stringify(result.body)}`);
        // drain captures this job's finished promise before its runner starts in a microtask.
        return { id: result.jobId, finished: jobs.drain() };
    };
    const finish = async (kind: Exclude<GenerationKind, "command"> = "send") => {
        const job = start(done, kind);
        await job.finished;
        expect(jobs.status(job.id, "tab")?.terminal).toEqual({
            type: "done",
            epoch: store.epoch(),
            messageId: "reply",
            revision: revision(),
        });
    };
    return {
        store,
        service,
        jobs,
        diagnostics,
        revision,
        chat,
        edit,
        appendUser,
        replaceTurns,
        policy,
        all,
        autos,
        baseline,
        done,
        start,
        finish,
    };
}

describe("automatic chat checkpoints", () => {
    it("saves done sends at user turns 1 and 3 with autoEvery 2, skipping turn 2 and unchanged turns", async () => {
        const s = setup();
        s.policy();
        expect(s.baseline()).toBeNull();
        await s.finish();
        const first = s.autos()[0];
        expect(first).toMatchObject({ kind: "auto", userTurns: 1 });
        expect(s.baseline()).toBe(1);
        await s.finish("continue");
        await s.finish("reroll");
        expect(s.autos()).toEqual([first]);
        s.appendUser(2);
        await s.finish();
        expect(s.autos()).toEqual([first]);
        expect(s.baseline()).toBe(1);
        s.appendUser(3);
        await s.finish();
        expect(s.autos().map((checkpoint) => checkpoint.userTurns)).toEqual([3, 1]);
        expect(s.baseline()).toBe(3);
    });

    it("skips aborted, failed and preview jobs and chats without a policy", async () => {
        const s = setup();
        s.policy();
        const aborted = s.start();
        expect(s.jobs.abort(aborted.id, "tab")).toBe(true);
        await aborted.finished; // The runner emits done; the abort must override it before the hook.
        expect(s.jobs.status(aborted.id, "tab")?.terminal).toMatchObject({ type: "error", reason: "aborted" });
        expect(s.autos()).toEqual([]);
        expect(s.baseline()).toBeNull();
        const failed = s.start(() => {
            throw new Error("provider failed");
        });
        await failed.finished;
        expect(s.jobs.status(failed.id, "tab")?.terminal).toMatchObject({ type: "error", reason: "failed" });
        expect(s.autos()).toEqual([]);
        expect(s.baseline()).toBeNull();
        await s.finish("preview");
        expect(s.autos()).toEqual([]);
        expect(s.baseline()).toBeNull();
        expect(s.service.writePolicy({ epoch: s.store.epoch(), body: { ...ref, off: true } }).status).toBe(200);
        await s.finish();
        expect(s.autos()).toEqual([]);
        expect(s.store.checkpoints.readPolicy(ref.characterId, ref.chatId)).toBeNull();
    });

    it("keeps the newest autoKeep autos without pruning manual checkpoints", async () => {
        const s = setup();
        s.policy(1, 2);
        const manual = s.store.checkpoints.save(ref.characterId, ref.chatId, "Fork", "manual")!;
        await s.finish();
        s.appendUser(2);
        await s.finish();
        const second = s.autos()[0];
        s.appendUser(3);
        await s.finish();
        expect(s.autos().map((checkpoint) => checkpoint.userTurns)).toEqual([3, 2]);
        expect(s.autos()[1]).toEqual(second);
        expect(s.all().filter((checkpoint) => checkpoint.kind === "manual")).toEqual([manual]);
        expect(s.baseline()).toBe(3);
    });

    it("resets a decreased user-turn baseline without saving and resumes from the lower count", async () => {
        const s = setup();
        s.replaceTurns(5);
        s.policy();
        await s.finish();
        const before = s.autos();
        expect(s.baseline()).toBe(5);
        s.edit([{ op: "remove", ids: ["u2", "u3", "u4", "u5"] }]);
        await s.finish();
        expect(s.baseline()).toBe(1);
        expect(s.autos()).toEqual(before);
        s.appendUser(2);
        await s.finish();
        expect(s.autos()).toEqual(before);
        s.appendUser(3);
        await s.finish();
        expect(s.autos().map((checkpoint) => checkpoint.userTurns)).toEqual([3, 5]);
        expect(s.baseline()).toBe(3);
    });

    it("resumes autos at turn 4 after loading a turn-2 checkpoint over a turn-20 chat", async () => {
        const s = setup();
        s.replaceTurns(2);
        const checkpoint = s.store.checkpoints.save(ref.characterId, ref.chatId, "Turn two", "manual")!;
        s.replaceTurns(20);
        s.policy();
        await s.finish();
        expect(s.baseline()).toBe(20);
        expect(
            s.service.load({
                epoch: s.store.epoch(),
                body: { ...ref, id: checkpoint.id, chatBaseRevision: s.revision() },
            }).status,
        ).toBe(200);
        expect(s.chat().message.filter((entry) => entry.role === "user")).toHaveLength(2);
        expect(s.baseline()).toBe(2);
        const before = s.autos();
        await s.finish();
        s.appendUser(3);
        await s.finish();
        expect(s.autos()).toEqual(before);
        s.appendUser(4);
        await s.finish();
        expect(s.autos().map((entry) => entry.userTurns)).toEqual([4, 20]);
        expect(s.baseline()).toBe(4);
    });

    it("captures final reply text and committed memory for send, continue, reroll and group", async () => {
        const s = setup();
        s.policy(1);
        for (const kind of ["send", "continue", "reroll", "group"] as const) {
            if (kind !== "send") s.appendUser(s.chat().message.filter((entry) => entry.role === "user").length + 1);
            const memory: NonNullable<Chat["hypaV3Data"]> = {
                summaries: [{ text: `Memory from ${kind}`, chatMemos: ["u1"], isImportant: true }],
            };
            const finalText = `Final reply from ${kind}`;
            const job = s.start((running) => {
                running.write(() => ({
                    chats: [
                        {
                            ...ref,
                            baseRevision: s.revision(),
                            ops: [
                                { op: "begin", id: "reply", generationId: running.id },
                                {
                                    op: "setText",
                                    id: "reply",
                                    text: "unfinished",
                                    generation: { id: running.id, seq: 1 },
                                },
                                { op: "meta", set: { hypaV3Data: memory } },
                            ],
                        },
                    ],
                }));
                running.write(() => ({
                    chats: [
                        {
                            ...ref,
                            baseRevision: s.revision(),
                            ops: [
                                {
                                    op: "setText",
                                    id: "reply",
                                    text: finalText,
                                    generation: { id: running.id, seq: 2, final: true },
                                },
                            ],
                        },
                    ],
                }));
                s.done(running);
            }, kind);
            await job.finished;
            const saved = s.autos()[0];
            expect(saved, kind).toBeDefined();
            const composed = s.store.checkpoints.compose(ref.characterId, ref.chatId, saved.id)!;
            expect(composed.message.find((entry) => entry.chatId === "reply")?.data, kind).toBe(finalText);
            expect(composed.hypaV3Data, kind).toEqual(memory);
        }
    });

    it("skips a busy or missing chat and saves after the job releases its slot", async () => {
        const s = setup();
        s.policy();
        const job = s.start();
        expect(s.jobs.chatBusy(ref.characterId, ref.chatId)).toBe(true);
        s.service.autoSave(ref.characterId, ref.chatId);
        s.service.autoSave(ref.characterId, "missing");
        expect(s.autos()).toEqual([]);
        expect(s.baseline()).toBeNull();
        await job.finished;
        expect(s.autos().map((checkpoint) => checkpoint.userTurns)).toEqual([1]);
    });

    it("only logs a throwing auto-save hook and preserves done and finished", async () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const s = setup(() => {
            throw new Error("checkpoint unavailable");
        });
        let emitted = false;
        const job = s.start((running) => {
            s.done(running);
            emitted = true;
        });
        await job.finished;
        expect(emitted).toBe(true);
        expect(s.jobs.status(job.id, "tab")).toMatchObject({
            state: "ended",
            terminal: { type: "done", epoch: s.store.epoch(), messageId: "reply", revision: s.revision() },
        });
        expect(s.diagnostics.filter((event) => event.kind === "runtime")).toMatchObject([
            { kind: "runtime", origin: "checkpoint.auto", jobId: job.id },
        ]);
        expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("[Checkpoint] auto"));
    });
});

async function answer(response: Response, status: number) {
    const body: unknown = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return body;
}

async function server() {
    const s = await createResourceTestClient({
        generationRunner: async (job) => job.emit({ type: "done", revision: job.context.chatRevision }),
    });
    cleanups.push(() => s.close());
    const firstId = async (kind: string) =>
        ((await (await s.get(kind, "main")).json()) as { data: { id: string }[] }).data[0].id;
    const bound = {
        presetId: await firstId("presets"),
        modelPresetId: await firstId("modelPresets"),
        personaId: await firstId("personas"),
    };
    await answer(
        await s.json("/api/resources/batch", {
            ops: [{ kind: "characters", id: ref.characterId, baseRevision: null, data: { chaId: ref.characterId } }],
            chats: [
                {
                    ...ref,
                    baseRevision: null,
                    ops: [
                        {
                            op: "create",
                            chat: {
                                name: "Story",
                                promptPresetId: bound.presetId,
                                modelPresetId: bound.modelPresetId,
                                bindedPersona: bound.personaId,
                                message: [message("u1")],
                            },
                        },
                    ],
                },
            ],
        }),
        200,
    );
    const getPolicy = (ids = ref) => s.request(`${policyPath}?${new URLSearchParams(ids)}`);
    const putPolicy = (body: unknown, epoch?: string | null) => s.json(policyPath, body, { method: "PUT" }, epoch);
    const finish = async () => {
        const chat = (
            (await (
                await s.json("/api/resources/read", { chats: [{ characterId: ref.characterId, id: ref.chatId }] })
            ).json()) as { chats: { revision: string }[] }
        ).chats[0];
        const created = await s.json("/api/generations", {
            kind: "send",
            clientId: "tab",
            context: { ...ref, ...bound, mode: "normal", input: "", chatRevision: chat.revision },
        });
        expect(created.status).toBe(200);
        await s.context.generationJobs.drain();
    };
    return { ...s, getPolicy, putPolicy, finish };
}

describe("automatic checkpoint policy routes", () => {
    it("round trips GET and PUT, enables the app's auto-save hook and deletes the policy with off", async () => {
        const s = await server();
        expect(await answer(await s.getPolicy(), 200)).toEqual({ epoch: s.epoch, policy: null });
        const policy = { autoEvery: 2, autoKeep: 3 };
        expect(await answer(await s.putPolicy({ ...ref, ...policy }), 200)).toEqual({ epoch: s.epoch, policy });
        expect(await answer(await s.getPolicy(), 200)).toEqual({ epoch: s.epoch, policy });
        await s.finish();
        const listPath = `/api/chat-checkpoints?${new URLSearchParams(ref)}`;
        const saved = await answer(await s.request(listPath), 200);
        expect(saved).toMatchObject({ epoch: s.epoch, checkpoints: [{ kind: "auto", userTurns: 1 }] });
        expect(await answer(await s.putPolicy({ ...ref, off: true }), 200)).toEqual({ epoch: s.epoch, policy: null });
        expect(await answer(await s.getPolicy(), 200)).toEqual({ epoch: s.epoch, policy: null });
        await s.finish();
        expect(await answer(await s.request(listPath), 200)).toEqual(saved);
    });

    it("rejects stale epochs, invalid policies and missing chats without changing the policy", async () => {
        const s = await server();
        const valid = { ...ref, autoEvery: 2, autoKeep: 3 };
        await answer(await s.putPolicy(valid), 200);
        for (const epoch of [null, "wrong-epoch"])
            expect(await answer(await s.putPolicy({ ...ref, off: true }, epoch), 412)).toEqual({
                error: "EpochMismatch",
                epoch: s.epoch,
            });
        for (const invalid of [{ autoEvery: 0 }, { autoEvery: 101 }, { autoKeep: 0 }, { autoKeep: 21 }]) {
            await answer(await s.putPolicy({ ...valid, ...invalid }), 400);
        }
        await answer(await s.putPolicy({ ...ref, off: true, autoEvery: 2 }), 400);
        await answer(await s.putPolicy([]), 400);
        await answer(
            await s.request(policyPath, { method: "PUT", headers: { "content-type": "application/json" }, body: "{" }),
            400,
        );
        const missing = { ...ref, chatId: "missing" };
        await answer(await s.getPolicy(missing), 404);
        await answer(await s.putPolicy({ ...valid, ...missing }), 404);
        expect(await answer(await s.getPolicy(), 200)).toEqual({
            epoch: s.epoch,
            policy: { autoEvery: 2, autoKeep: 3 },
        });
    });

    it("requires JWT, caps PUT bodies at 16 KiB and refuses policy writes during maintenance", async () => {
        const s = await server();
        const valid = { ...ref, autoEvery: 2, autoKeep: 3 };
        expect(await answer(await s.app.request(`${policyPath}?${new URLSearchParams(ref)}`), 400)).toEqual({
            error: "No auth header",
        });
        expect(
            await answer(
                await s.app.request(policyPath, {
                    ...json(valid),
                    method: "PUT",
                    headers: { "content-type": "application/json", "x-resource-epoch": s.epoch },
                }),
                400,
            ),
        ).toEqual({ error: "No auth header" });
        await answer(
            await s.request(policyPath, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(valid) + " ".repeat(16 * 1024),
            }),
            413,
        );
        // withMaintenance enters before calling this callback; no timer or polling is needed.
        await s.context.snapshots.withMaintenance(async () => {
            await answer(await s.putPolicy(valid), 503);
            expect(await answer(await s.getPolicy(), 200)).toEqual({ epoch: s.epoch, policy: null });
        });
        expect(await answer(await s.putPolicy(valid), 200)).toEqual({
            epoch: s.epoch,
            policy: { autoEvery: 2, autoKeep: 3 },
        });
    });
});
