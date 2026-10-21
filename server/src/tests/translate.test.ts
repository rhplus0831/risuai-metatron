// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, beforeAll, afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ChatOp } from "../../../shared/chats.ts";
import type { MessageTranslation } from "../../../shared/database.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import { createTranslatorPreset } from "../../../shared/translatorPresets.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore, type ResourceStore } from "../data/resourceStore.ts";
import { MaintenanceError, type MaintenanceGate } from "../data/snapshots.ts";
import type { GenerationRunner, RunningJob } from "../jobs/generationJobs.ts";
import { createGenerationLock, type GenerationLock } from "../jobs/generationLock.ts";
import type { requestDataResponse } from "../llm/request.ts";
import type { JobRequestSpec } from "../llm/requests.ts";
import type { TokenCountScope } from "../prompt/tokens.ts";
import {
    createTranslationRunner,
    MAX_RUNNING_TRANSLATIONS,
    TRANSLATION_DEADLINE_MS,
    type TranslateMessageRequest,
    type TranslationRunner,
} from "../translation/runner.ts";
import {
    allowListenerOrigin,
    allowTestLoopbackOrigin,
    createResourceTestClient,
    type ResourceTestClient,
    waitFor,
} from "./testSupport.ts";

// The server translation runner (`server/src/translation/runner.ts`) and its route
// (`POST /api/translate/message`, `server/src/routes/translate.ts`).
//
// The first part drives the real app with the `Echo` model (`createResourceTestClient`): a stored
// write and its `fresh` and `force` answers, a source edited during the run (`ignored`, nothing
// stored), a join (one run, the same result for both callers, the joiner's ids checked), a message a
// generation owns (refused before the run and at the write), the route's admission (authentication
// before the body, the body rules, the epoch, the 16 KiB cap, missing records, the binding
// mismatch), maintenance (the run ends 503 at once, admission closed while it lasts, also while the
// jobs' listener waits for a job, nothing written after), shutdown (503, `dispose` waits for the
// work), a failed provider request (502), and a run that outlives its HTTP request over a real socket.
//
// The second part builds the runner over a real in-memory store with a fake request layer, where
// the lifecycle can be controlled: the deadline from the timer and from the clock alone, an
// immediate retry loop (`banCharacterset`) that still ends at the deadline because every attempt
// yields, the capacity counted on unsettled work (also after `pause`), the write fence (shutdown,
// the maintenance gate), a message or chat removed or recreated before the write (404 / 409), a
// streaming answer cancelled (502), a failed answer (502), an unexpected failure (500), `fresh`
// never entering the in-flight map, and the detached request spec (the pipeline's messages with the
// languages and the translator note, the step chain, no tools, no inlays, no plugin callback, CBS
// over the chat).

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const m = (id: string, data = "", role: "user" | "char" = "user") => ({ role, data, chatId: id });
const group = (chatId: string, baseRevision: string | null, ops: ChatOp[], characterId = "c") => ({
    characterId,
    chatId,
    baseRevision,
    ops,
});
const tr = (text: string, source: string, extra: Partial<MessageTranslation> = {}): MessageTranslation => ({
    text,
    sourceHash: translationSourceHash(source),
    targetLanguage: "ko",
    translatedAt: 1,
    ...extra,
});
const TRANSLATE = "/api/translate/message";

beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});

describe("POST /api/translate/message with the Echo model", () => {
    let client: ResourceTestClient;
    let ids = { presetId: "", modelPresetId: "", personaId: "" };
    /** What the fake generation runner does for the next job (a test sets it). */
    let jobRun: (job: RunningJob) => Promise<void> = async () => {};
    const generationRunner: GenerationRunner = (job) => jobRun(job);

    /** Every hold of the test (provider answers, fake generation jobs), released before the client closes. */
    const holds: (() => void)[] = [];
    afterEach(async () => {
        jobRun = async () => {};
        for (const release of holds.splice(0)) release();
        await client?.close();
    });

    type Single = { revision: string; data: any };
    const single = async (kind: string) => (await (await client.get(kind, "main")).json()) as Single;
    const write = async (kind: string, data: unknown) => {
        const current = await single(kind);
        const res = await client.put(kind, "main", { baseRevision: current.revision, data });
        expect(res.status, `${kind}: ${await res.clone().text()}`).toBe(200);
    };
    const patch = async (kind: string, fields: Record<string, unknown>) => {
        const current = await single(kind);
        await write(kind, { ...current.data, ...fields });
    };
    const readChat = async (chatId = "k") =>
        (
            (await (
                await client.json("/api/resources/read", { chats: [{ characterId: "c", id: chatId }] })
            ).json()) as any
        ).chats[0] as {
            revision: string;
            data: { message: { chatId: string; data: string; translation?: MessageTranslation }[] };
        };
    const message = async (id: string, chatId = "k") =>
        (await readChat(chatId)).data.message.find((entry) => entry.chatId === id)!;
    const chatBatch = async (chatId: string, ops: ChatOp[]) => {
        const current = await readChat(chatId);
        const res = await client.json("/api/resources/batch", { chats: [group(chatId, current.revision, ops)] });
        expect(res.status, await res.clone().text()).toBe(200);
    };

    /**
     * A server whose default profile is the Echo model (`pong`, no delay), with `translator: "ko"`, a
     * character `c` (with a translator note) holding the bound chat `k` (`u`: "hi", `r`: "reply") and
     * the unbound chat `loose` (`a`: "alpha", `b`: "beta"). An aborted generation job gets a
     * ten-minute grace, so no 5 s deadline races a test that holds its runner.
     */
    async function seed(echo: { echoMessage?: string } = {}) {
        client = await createResourceTestClient({ generationRunner, generationAbortGraceMs: 10 * 60_000 });
        ids = {
            presetId: (await single("presets")).data[0].id,
            modelPresetId: (await single("modelPresets")).data[0].id,
            personaId: (await single("personas")).data[0].id,
        };
        const profiles = await single("modelProfiles");
        profiles.data[0] = { ...profiles.data[0], modelId: "echo_model" };
        await write("modelProfiles", profiles.data);
        await patch("providers", { echoMessage: "pong", echoDelay: 0, requestRetrys: 0, ...echo });
        await patch("memoryTranslateMedia", { translator: "ko" });
        const seeded = await client.json("/api/resources/batch", {
            ops: [
                {
                    kind: "characters",
                    id: "c",
                    baseRevision: null,
                    data: { chaId: "c", name: "Cara", translatorNote: "keep names" },
                },
            ],
            chats: [
                group("k", null, [
                    {
                        op: "create",
                        chat: {
                            name: "K",
                            modelPresetId: ids.modelPresetId,
                            promptPresetId: ids.presetId,
                            bindedPersona: ids.personaId,
                            message: [m("u", "hi"), m("r", "reply", "char")],
                        } as never,
                    },
                ]),
                group("loose", null, [
                    { op: "create", chat: { name: "L", message: [m("a", "alpha"), m("b", "beta", "char")] } as never },
                ]),
            ],
        });
        expect(seeded.status, await seeded.clone().text()).toBe(200);
    }

    const req = (messageId: string, extra: Record<string, unknown> = {}, chatId = "k") => ({
        characterId: "c",
        chatId,
        messageId,
        ...ids,
        ...extra,
    });
    const translate = async (body: unknown, epoch?: string | null) => {
        const res = await client.json(TRANSLATE, body, {}, epoch);
        let parsed: any = null;
        try {
            parsed = await res.json();
        } catch {}
        return { status: res.status, body: parsed, headers: res.headers };
    };
    const runner = () => client.context.translationRunner;
    /** The chat's stored revision number: one more per applied write. */
    const revisionOf = async (chatId = "k") => Number((await readChat(chatId)).revision.split(":")[2]);

    /**
     * Holds the runs' provider answers: every request-layer call (`runInJob`) runs the real request
     * (Echo, no delay), then waits for `release` before the run sees the answer. `answered` resolves
     * at the first held answer; `calls` counts the provider requests; `restore` ends the holding.
     */
    function holdProvider() {
        const llm = client.context.llmRequests;
        // A later hold replaces an earlier one (whose spy would otherwise call itself).
        if (vi.isMockFunction(llm.runInJob)) llm.runInJob.mockRestore();
        const runInJob = llm.runInJob;
        let answered!: () => void;
        const reached = new Promise<void>((resolve) => (answered = resolve));
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        holds.push(release);
        const spy = vi.spyOn(llm, "runInJob").mockImplementation(async (spec) => {
            const answer = await runInJob.call(llm, spec);
            answered();
            await released;
            return answer;
        });
        return { answered: reached, release, calls: () => spy.mock.calls.length, restore: () => spy.mockRestore() };
    }
    /** Resolves once the runner took a request matching `match` (a join is decided in that call). */
    function admitted(match: (request: TranslateMessageRequest) => boolean) {
        const target = runner();
        const translate = target.translate;
        let seen!: () => void;
        const taken = new Promise<void>((resolve) => (seen = resolve));
        vi.spyOn(target, "translate").mockImplementation((request) => {
            const result = translate.call(target, request);
            if (match(request)) seen();
            return result;
        });
        return taken;
    }
    /** Passes a few immediate turns of the event loop, so promise continuations already due have run. */
    const turns = async (count = 5) => {
        for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
    };

    /** Creates a `send` job on chat `k` for the fake runner; returns its id. */
    async function createJob() {
        const res = await client.json("/api/generations", {
            kind: "send",
            clientId: "tab",
            context: {
                characterId: "c",
                chatId: "k",
                ...ids,
                mode: "normal",
                input: "",
                chatRevision: (await readChat()).revision,
            },
        });
        expect(res.status, await res.clone().text()).toBe(200);
        return ((await res.json()) as { jobId: string }).jobId;
    }
    const jobState = async (jobId: string) =>
        ((await (await client.request(`/api/generations/${jobId}?clientId=tab`)).json()) as { state: string }).state;
    /** Polls the owner's status until the job is no longer running. */
    const jobEnded = (jobId: string) => waitFor(async () => (await jobState(jobId)) !== "running");
    /** A job that locks `messageId` and holds it until the returned `release` is called. */
    function lockingJob(messageId: string) {
        let locked!: () => void;
        let release!: () => void;
        const held = new Promise<void>((resolve) => (locked = resolve));
        const released = new Promise<void>((resolve) => (release = resolve));
        holds.push(release);
        jobRun = async (job) => {
            job.write(() => ({
                chats: [group("k", job.context.chatRevision, [{ op: "begin", id: messageId, generationId: "g1" }])],
            }));
            locked();
            await released;
        };
        return { held, release };
    }

    it("translates a stored message, answers the stored translation as fresh, and retranslates with force", async () => {
        await seed();
        const applied = await translate(req("r"));
        expect(applied.status, JSON.stringify(applied.body)).toBe(200);
        expect(applied.headers.get("cache-control")).toBe("no-store");
        const selected = (await single("translatorPresets")).data as { selectedId: string };
        expect(applied.body).toEqual({
            outcome: "applied",
            translation: {
                text: "pong",
                sourceHash: translationSourceHash("reply"),
                presetId: selected.selectedId,
                targetLanguage: "ko",
                translatedAt: expect.any(Number),
            },
        });
        expect((await message("r")).translation).toEqual(applied.body.translation);
        expect(runner().runningCount()).toBe(0);

        // Not forced: the stored translation, without a request (the Echo text changed meanwhile).
        await patch("providers", { echoMessage: "pong2" });
        const fresh = await translate(req("r"));
        expect(fresh.body).toEqual({ outcome: "fresh", translation: applied.body.translation });
        const forced = await translate(req("r", { force: true }));
        expect(forced.body).toMatchObject({ outcome: "applied", translation: { text: "pong2" } });
        expect((await message("r")).translation?.text).toBe("pong2");
        // The other message is untouched; the user message translates too.
        expect((await message("u")).translation).toBeUndefined();
        expect((await translate(req("u"))).body).toMatchObject({ outcome: "applied", translation: { text: "pong2" } });
    });

    it("ignores a translation whose source text changed during the run and stores nothing", async () => {
        await seed();
        const held = holdProvider();
        const pending = translate(req("r"));
        await held.answered;
        await chatBatch("k", [{ op: "setText", id: "r", text: "edited" }]);
        held.release();
        expect(await pending).toMatchObject({ status: 200, body: { outcome: "ignored", translation: null } });
        const after = await message("r");
        expect(after.data).toBe("edited");
        expect(after.translation).toBeUndefined();
        expect(runner().workingCount()).toBe(0);
    });

    it("joins a run in flight (one run, the same result, whatever the joiner's force) after the joiner's ids pass the display binding and exist", async () => {
        await seed();
        const held = holdProvider();
        const joined = admitted((request) => request.force === true);
        const before = await revisionOf();
        const first = translate(req("r"));
        await held.answered;
        const joiner = translate(req("r", { force: true }));
        await joined;
        // A joiner whose ids are not the bound chat's, and one naming a record that does not exist.
        expect(await translate(req("r", { modelPresetId: "other" }))).toMatchObject({
            status: 409,
            body: { error: "chatBindingMismatch" },
        });
        expect(runner().runningCount()).toBe(1);
        held.release();
        const results = await Promise.all([first, joiner]);
        expect(results[0].status).toBe(200);
        expect(results[0].body).toMatchObject({ outcome: "applied", translation: { text: "pong" } });
        expect(results[1].body).toEqual(results[0].body);
        expect(runner().runningCount()).toBe(0);
        expect(runner().workingCount()).toBe(0);
        // One run: one provider request and one stored write for both callers.
        expect(held.calls()).toBe(1);
        expect(await revisionOf()).toBe(before + 1);

        // The unbound chat takes the sent ids: a joiner's must still name existing records.
        const heldLoose = holdProvider();
        const loose = translate(req("a", {}, "loose"));
        await heldLoose.answered;
        expect(await translate(req("a", { personaId: "nope" }, "loose"))).toMatchObject({
            status: 404,
            body: { error: "The request's preset, model preset, or persona no longer exists" },
        });
        heldLoose.release();
        expect((await loose).body).toMatchObject({ outcome: "applied" });
        expect((await message("a", "loose")).translation?.text).toBe("pong");
        expect(heldLoose.calls()).toBe(1);
    });

    it("refuses a message a generation owns: before the run (409 generating) and at the write when the lock was taken meanwhile", async () => {
        await seed();
        const held = lockingJob("r");
        const jobId = await createJob();
        await held.held;
        expect(await translate(req("r"))).toMatchObject({ status: 409, body: { error: "generating" } });
        // The other message of the chat is free.
        expect((await translate(req("u"))).body).toMatchObject({ outcome: "applied" });
        held.release();
        await jobEnded(jobId);
        expect((await translate(req("r"))).body).toMatchObject({ outcome: "applied" });

        // A lock taken during the run: the write conflicts with reason generating, nothing stored.
        await patch("providers", { echoMessage: "late" });
        await chatBatch("k", [{ op: "setTranslation", id: "u", translation: null }]);
        const provider = holdProvider();
        const pending = translate(req("u"));
        await provider.answered;
        const second = lockingJob("u");
        const secondJob = await createJob();
        await second.held;
        provider.release();
        expect(await pending).toMatchObject({ status: 409, body: { error: "generating" } });
        expect((await message("u")).translation).toBeUndefined();
        second.release();
        await jobEnded(secondJob);
    });

    it("the route: authentication before the body, the body rules, the epoch, the 16 KiB cap, missing records, and the binding mismatch", async () => {
        await seed();
        const oversized = JSON.stringify({ ...req("r"), pad: "x".repeat(17 * 1024) });
        // The JWT failure bodies are the auth store's (400); the oversized body is not read first.
        const denied = await client.request(TRANSLATE, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "risu-auth": await client.signer.jwt({ breakSignature: true }),
            },
            body: oversized,
        });
        expect(denied.status).toBe(400);
        expect(await denied.json()).toEqual({ error: "Invalid Signature" });
        const tooLarge = await client.request(TRANSLATE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: oversized,
        });
        expect(tooLarge.status).toBe(413);
        expect(await tooLarge.json()).toEqual({ error: "Request body too large" });

        expect(await translate({})).toMatchObject({ status: 400, body: { error: "characterId must be an id" } });
        expect(await translate({ ...req("r"), personaId: 3 })).toMatchObject({
            status: 400,
            body: { error: "personaId must be an id" },
        });
        expect(await translate(req("r", { force: "yes" }))).toMatchObject({
            status: 400,
            body: { error: "force must be a boolean" },
        });
        expect(await translate([])).toMatchObject({ status: 400, body: { error: "The body must be an object" } });
        expect(await translate(req("r"), "stale")).toMatchObject({
            status: 412,
            body: { error: "EpochMismatch", epoch: client.epoch },
        });
        expect(await translate(req("r"), null)).toMatchObject({ status: 412 });

        expect(await translate(req("zz"))).toMatchObject({
            status: 404,
            body: { error: "The message no longer exists" },
        });
        expect(await translate(req("r", {}, "gone"))).toMatchObject({ status: 404 });
        expect(await translate(req("r", { characterId: "nobody" }))).toMatchObject({ status: 404 });
        // The unbound chat takes the sent ids, which must name records.
        expect(await translate(req("a", { personaId: "nope" }, "loose"))).toMatchObject({
            status: 404,
            body: { error: "The job's persona no longer exists" },
        });
        expect(await translate(req("a", { presetId: "nope" }, "loose"))).toMatchObject({ status: 404 });
        // The bound chat: an id that is not the bound one is a mismatch even when it names no record.
        expect(await translate(req("r", { modelPresetId: "other" }))).toMatchObject({
            status: 409,
            body: { error: "chatBindingMismatch" },
        });
        expect(await translate(req("r", { presetId: "other" }))).toMatchObject({ status: 409 });
        // Nothing of the above wrote anything.
        expect((await message("r")).translation).toBeUndefined();
        expect((await message("a", "loose")).translation).toBeUndefined();
    });

    it("maintenance ends a run at once (503, Retry-After), refuses new ones while it lasts, also while the jobs' listener waits, and the ended run never writes", async () => {
        await seed();
        const held = holdProvider();
        const pending = translate(req("r"));
        await held.answered;
        let inside: Awaited<ReturnType<typeof translate>> | undefined;
        await client.context.snapshots.withMaintenance(async () => {
            inside = await translate(req("u"));
        });
        // The run ended while its answer is still held: it did not wait for the provider.
        const ended = await pending;
        expect(ended.status).toBe(503);
        expect(ended.body).toEqual({ error: "The server data is being replaced" });
        expect(ended.headers.get("retry-after")).toBe("5");
        expect(inside).toMatchObject({ status: 503, body: { error: "The server data is being replaced" } });
        expect(runner().runningCount()).toBe(0);
        expect(runner().workingCount()).toBe(1);
        // The held answer arrives after the run ended: once it settles, nothing is stored.
        const before = await revisionOf();
        held.release();
        await waitFor(() => runner().workingCount() === 0);
        expect((await message("r")).translation).toBeUndefined();
        expect(await revisionOf()).toBe(before);
        // Admission reopened with the maintenance's end.
        held.restore();
        expect((await translate(req("r"))).body).toMatchObject({ outcome: "applied" });

        // The jobs' listener (registered after the runner's) aborts the running jobs and waits for
        // their end before the gate closes: translations are refused during that wait.
        let abortSeen!: () => void;
        let release!: () => void;
        const aborted = new Promise<void>((resolve) => (abortSeen = resolve));
        const released = new Promise<void>((resolve) => (release = resolve));
        holds.push(release);
        jobRun = async (job) => {
            job.signal.addEventListener("abort", () => abortSeen(), { once: true });
            await released;
        };
        await createJob();
        const maintenance = client.context.snapshots.withMaintenance(async () => {});
        await aborted;
        expect(await translate(req("u"))).toMatchObject({ status: 503 });
        release();
        await maintenance;
        expect((await translate(req("u"))).body).toMatchObject({ outcome: "applied" });
    });

    it("shutdown ends a run (503) and refuses new ones; dispose waits for the work still settling", async () => {
        await seed();
        const held = holdProvider();
        const pending = translate(req("r"));
        await held.answered;
        client.context.beginShutdown();
        const ended = await pending;
        expect(ended.status).toBe(503);
        expect(ended.body).toEqual({ error: "The server is shutting down" });
        expect(ended.headers.get("retry-after")).toBe("5");
        expect(runner().runningCount()).toBe(0);
        expect(runner().workingCount()).toBe(1);
        expect(await translate(req("u"))).toMatchObject({
            status: 503,
            body: { error: "The server is shutting down" },
        });
        // The runner's drain is bounded by a 5 s timer: hold that timer, so only the work settling ends it.
        const target = runner();
        const drain = target.drain;
        let drainCapped = false;
        let drained = false;
        vi.spyOn(target, "drain").mockImplementation(() => {
            const realSetTimeout = globalThis.setTimeout;
            const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation((() => {
                drainCapped = true;
                return realSetTimeout(() => {}, 0);
            }) as unknown as typeof setTimeout);
            try {
                const draining = drain.call(target);
                void draining.then(() => (drained = true));
                return draining;
            } finally {
                timers.mockRestore();
            }
        });
        const disposing = client.context.dispose();
        expect(drainCapped).toBe(true);
        await turns();
        // Dispose waits for the work of the ended run, still held.
        expect(drained).toBe(false);
        held.release();
        await disposing;
        expect(drained).toBe(true);
        expect(runner().workingCount()).toBe(0);
    });

    it("answers 502 with the request layer's failure text when the provider request fails", async () => {
        // Nothing listens on port 9: the test wants the refused connection.
        onTestFinished(allowTestLoopbackOrigin("http://127.0.0.1:9"));
        await seed();
        // A reverse proxy at a port nothing listens on: the request fails without a retry.
        const profiles = await single("modelProfiles");
        profiles.data[0] = {
            ...profiles.data[0],
            modelId: "reverse_proxy",
            forceReplaceUrl: "http://127.0.0.1:9/v1/chat/completions",
            customProxyRequestModel: "mock-model",
            customAPIFormat: 0,
        };
        await write("modelProfiles", profiles.data);
        const failed = await translate(req("r"));
        expect(failed.status, JSON.stringify(failed.body)).toBe(502);
        expect(typeof failed.body.error).toBe("string");
        expect(failed.body.error.length).toBeGreaterThan(0);
        expect((await message("r")).translation).toBeUndefined();
        expect(runner().runningCount()).toBe(0);
    });

    // A step on a profile runs on that profile, not the slot.
    it("runs a step on a profile on that profile: a dead connection fails the run (502) where the slot's Echo answers, a deleted profile fails it by name, and nothing is stored", async () => {
        // Nothing listens on port 9: the test wants the refused connection.
        onTestFinished(allowTestLoopbackOrigin("http://127.0.0.1:9"));
        await seed();
        const profiles = await single("modelProfiles");
        await write("modelProfiles", [
            ...profiles.data,
            {
                ...profiles.data[0],
                id: "dead",
                name: "Dead",
                modelId: "reverse_proxy",
                forceReplaceUrl: "http://127.0.0.1:9/v1/chat/completions",
                customProxyRequestModel: "mock-model",
                customAPIFormat: 0,
            },
        ]);
        const stepsOn = (model: { mode: "inherit" } | { mode: "profile"; profileId: string }) =>
            createTranslatorPreset("Steps", {
                id: "steps",
                steps: [{ prompt: "First {{slot::content}}" }, { prompt: "Second {{slot::prev}}", model }],
            });
        const usePreset = (model: Parameters<typeof stepsOn>[0]) =>
            patch("translatorPresets", { items: [stepsOn(model)], selectedId: "steps" });

        await usePreset({ mode: "profile", profileId: "dead" });
        const dead = await translate(req("r"));
        expect(dead.status, JSON.stringify(dead.body)).toBe(502);
        expect(typeof dead.body.error).toBe("string");
        expect(dead.body.error).not.toContain("connection it names");
        expect((await message("r")).translation).toBeUndefined();

        await usePreset({ mode: "profile", profileId: "deleted-profile" });
        expect(await translate(req("r"))).toMatchObject({
            status: 502,
            body: { error: "Cannot send the request: the connection it names no longer exists." },
        });
        expect((await message("r")).translation).toBeUndefined();

        // The same steps on the translate slot (the Echo profile) answer: the profile was the difference.
        await usePreset({ mode: "inherit" });
        expect((await translate(req("r"))).body).toMatchObject({
            outcome: "applied",
            translation: { text: "pong", presetId: "steps" },
        });
        expect(runner().runningCount()).toBe(0);
    });

    it("a run outlives its HTTP request: the tab's disconnect does not end it, and the translation lands", async () => {
        await seed();
        const held = holdProvider();
        // The server's side of the translate request: its signal aborts when the tab's socket closes.
        let disconnected!: () => void;
        const serverSawDisconnect = new Promise<void>((resolve) => (disconnected = resolve));
        const node = serve({
            fetch: (request, env) => {
                if (new URL(request.url).pathname === TRANSLATE) {
                    request.signal.addEventListener("abort", () => disconnected(), { once: true });
                }
                return client.app.fetch(request, env);
            },
            port: 0,
            hostname: "127.0.0.1",
        }) as http.Server;
        await new Promise<void>((resolve) => node.once("listening", () => resolve()));
        allowListenerOrigin(node);
        try {
            const { port } = node.address() as { port: number };
            const controller = new AbortController();
            const request = fetch(`http://127.0.0.1:${port}${TRANSLATE}`, {
                method: "POST",
                headers: await client.headers({ "content-type": "application/json" }),
                body: JSON.stringify(req("r")),
                signal: controller.signal,
            });
            await held.answered;
            controller.abort();
            await expect(request).rejects.toThrow();
            await serverSawDisconnect;
            await turns();
            expect(runner().runningCount()).toBe(1);
            held.release();
            await waitFor(() => runner().runningCount() === 0);
            expect((await message("r")).translation).toMatchObject({ text: "pong", targetLanguage: "ko" });
        } finally {
            node.closeAllConnections();
            await new Promise((resolve) => node.close(resolve));
        }
    });
});

describe("createTranslationRunner over a fake request layer", () => {
    let store: ResourceStore;
    let lock: GenerationLock;
    let runner: TranslationRunner;
    let rootDir = "";
    let gateClosed = false;
    let ids = { presetId: "", modelPresetId: "", personaId: "" };
    /** Every `runInJob` call's spec, in order. */
    let calls: JobRequestSpec[] = [];
    /** What `runInJob` answers (a test sets it). */
    let answer: (spec: JobRequestSpec) => Promise<requestDataResponse> = async () => ({
        type: "success",
        result: "번역",
    });
    /** Every `tokens.count` call (the history slots), in order. */
    let counts: { text: string; scope: TokenCountScope }[] = [];
    /** What `tokens.count` answers (a test sets it): one token per character by default. */
    let count: (text: string, scope: TokenCountScope) => Promise<number> = async (text) => text.length;
    const gate: MaintenanceGate = {
        get active() {
            return gateClosed;
        },
        assertOpen() {
            if (gateClosed) {
                throw new MaintenanceError();
            }
        },
        enter() {
            gate.assertOpen();
            return () => {};
        },
    };
    const MESSAGES = Array.from({ length: MAX_RUNNING_TRANSLATIONS + 2 }, (_, i) => m(`m${i}`, `text ${i}`));
    const CHAT = { name: "K", message: MESSAGES };

    const kindOf = (name: string) => kinds.get(name)!;
    const single = (name: string) =>
        store.readRefs([{ kind: kindOf(name), id: "main" }]).items[0] as { revision: string; data: any };
    const patch = (name: string, fields: Record<string, unknown>) => {
        const current = single(name);
        store.applyChanges({
            ops: [
                {
                    kind: kindOf(name),
                    id: "main",
                    baseRevision: current.revision,
                    data: { ...current.data, ...fields },
                },
            ],
        });
    };
    const readChat = (chatId = "k") =>
        store.readRefs([], { chats: [{ characterId: "c", id: chatId }] }).chats[0] as {
            revision: string | null;
            data: { message: { chatId: string; data: string; translation?: MessageTranslation }[] } | null;
        };
    const message = (id: string) => readChat().data!.message.find((entry) => entry.chatId === id)!;
    const chatBatch = (ops: ChatOp[], baseRevision: string | null = readChat().revision) =>
        store.applyChanges({ chats: [group("k", baseRevision, ops)] });
    const req = (messageId: string, extra: Partial<TranslateMessageRequest> = {}): TranslateMessageRequest => ({
        characterId: "c",
        chatId: "k",
        messageId,
        ...ids,
        force: false,
        ...extra,
    });
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
    /** Waits on event-loop turns (not timers, which a test may fake) until `condition` holds. */
    async function until(condition: () => boolean, turns = 2000) {
        for (let i = 0; i < turns; i++) {
            if (condition()) {
                return;
            }
            await tick();
        }
        throw new Error("until: condition not met");
    }
    function deferred<T>() {
        let resolve!: (value: T) => void;
        let reject!: (reason: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    }
    /** A `runInJob` that stays pending until the test settles it. */
    function pendingAnswers() {
        const pending: ReturnType<typeof deferred<requestDataResponse>>[] = [];
        answer = () => {
            const entry = deferred<requestDataResponse>();
            pending.push(entry);
            return entry.promise;
        };
        return pending;
    }

    function build(options: { now?: () => number } = {}) {
        lock = createGenerationLock();
        store = createResourceStore({ file: ":memory:", kinds, guard: lock });
        ids = {
            presetId: single("presets").data[0].id,
            modelPresetId: single("modelPresets").data[0].id,
            personaId: single("personas").data[0].id,
        };
        patch("memoryTranslateMedia", { translator: "ko", translatorInputLanguage: "en" });
        store.applyChanges({
            ops: [
                {
                    kind: kindOf("characters"),
                    id: "c",
                    baseRevision: null,
                    data: { chaId: "c", name: "Cara", translatorNote: "keep names" },
                },
            ],
            chats: [group("k", null, [{ op: "create", chat: CHAT as never }])],
        });
        runner = createTranslationRunner({
            store,
            kinds,
            gate,
            lock,
            llm: {
                runInJob: (spec) => {
                    calls.push(spec);
                    return answer(spec);
                },
            },
            tokens: {
                count: (text, scope) => {
                    counts.push({ text, scope });
                    return count(text, scope);
                },
            },
            rootDir,
            ...options,
        });
    }

    beforeAll(() => {
        rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-translate-"));
    });
    afterAll(() => {
        rmSync(rootDir, { recursive: true, force: true });
    });
    afterEach(() => {
        vi.useRealTimers();
        gateClosed = false;
        calls = [];
        answer = async () => ({ type: "success", result: "번역" });
        counts = [];
        count = async (text) => text.length;
        store?.close();
    });

    it("runs the preset's steps as detached translate requests over the chat and stores the last output", async () => {
        build({ now: () => 1234 });
        const preset = createTranslatorPreset("Two steps", {
            steps: [
                {
                    prompt: "To {{slot}} from {{slot::from}}; note: {{slot::tnote}}\n{{slot::content}}",
                    maxResponse: 123,
                },
                { prompt: "Polish {{slot::prev}}", maxResponse: 45 },
            ],
        });
        patch("translatorPresets", { items: [createTranslatorPreset("Other"), preset], selectedId: preset.id });
        answer = async () => ({ type: "success", result: calls.length === 1 ? "<think>hm</think>one" : "two" });

        const result = await runner.translate(req("m0"));
        const translation = {
            text: "two",
            sourceHash: translationSourceHash("text 0"),
            presetId: preset.id,
            targetLanguage: "ko",
            translatedAt: 1234,
        };
        expect(result).toEqual({ ok: true, outcome: "applied", translation });
        expect(message("m0").translation).toEqual(translation);
        expect(calls).toHaveLength(2);
        const [first, second] = calls;
        expect(first.arg.formated).toEqual([{ role: "system", content: "To ko from en; note: keep names\ntext 0" }]);
        expect(first.arg).toMatchObject({ useStreaming: false, noMultiGen: true, maxTokens: 123 });
        expect(second.arg.formated).toEqual([{ role: "system", content: "Polish one" }]);
        expect(second.arg.maxTokens).toBe(45);
        expect(first.jobId).toMatch(/^translate-/);
        expect(second.jobId).toBe(first.jobId);
        expect(first.mode).toBe("translate");
        expect(first.loaded.db.aiModel).toBeDefined();
        // Detached: no plugin callback, no tools, no inlay, no tool records; CBS runs over the chat.
        expect(await first.channel.callback("bodyIntercepter", { body: {}, type: "x" }, {})).toMatchObject({
            outcome: "refused",
            refusal: "unregistered",
        });
        expect(first.tools).toMatchObject({ descriptors: [], limit: 0 });
        expect(first.tools.charge()).toBe(false);
        await expect(first.tools.call("x", {})).rejects.toThrow("A translation calls no tools");
        await expect(first.inlays.saveSignature("sig" as never, "x" as never)).rejects.toThrow(
            "A translation stores no inlay",
        );
        expect(first.toolCalls.read()).toBeUndefined();
        expect(first.parseCbs("{{char}} / {{user}}", { chaId: "c", chatId: "k" })).toMatch(/^Cara \/ /);
        expect(first.signal.aborted).toBe(false);
        expect(runner.runningCount()).toBe(0);
        expect(runner.workingCount()).toBe(0);
    });

    it("sends a profile step's profile as the request's profileId and an inheriting step's request without one, every step in translate mode", async () => {
        build();
        const preset = createTranslatorPreset("Mixed", {
            steps: [
                { prompt: "A {{slot::content}}", model: { mode: "profile", profileId: "profile-a" } },
                { prompt: "B {{slot::prev}}" },
                { prompt: "C {{slot::prev}}", model: { mode: "profile", profileId: "profile-c" } },
            ],
        });
        patch("translatorPresets", { items: [preset], selectedId: preset.id });
        expect(await runner.translate(req("m0"))).toMatchObject({ ok: true, outcome: "applied" });
        expect(calls.map((call) => [call.mode, call.arg.profileId, Object.hasOwn(call.arg, "profileId")])).toEqual([
            ["translate", "profile-a", true],
            ["translate", undefined, false],
            ["translate", "profile-c", true],
        ]);
        expect(calls.map((call) => call.arg.formated[0].content)).toEqual(["A text 0", "B 번역", "C 번역"]);
    });

    it("translates with the chat's own translator preset when it names one, the global selection otherwise, and falls back to it for a deleted preset without rewriting the chat", async () => {
        build({ now: () => 99 });
        const own = createTranslatorPreset("Own", { prompt: "Own {{slot::content}}", maxResponse: 7 });
        const global = createTranslatorPreset("Global", { prompt: "Global {{slot::content}}", maxResponse: 8 });
        patch("translatorPresets", { items: [global, own], selectedId: global.id });
        // Another chat of the character, without a preset of its own, translates with the global one.
        store.applyChanges({
            chats: [
                group("other", null, [{ op: "create", chat: { name: "O", message: [m("o0", "other 0")] } as never }]),
            ],
        });
        chatBatch([{ op: "meta", set: { translatorPresetId: own.id }, unset: [] }]);

        const withOwn = await runner.translate(req("m0"));
        expect(withOwn).toMatchObject({
            ok: true,
            outcome: "applied",
            translation: { text: "번역", presetId: own.id },
        });
        expect(message("m0").translation).toMatchObject({ presetId: own.id, targetLanguage: "ko", translatedAt: 99 });
        expect(calls).toHaveLength(1);
        expect(calls[0].arg.formated).toEqual([{ role: "system", content: "Own text 0" }]);
        expect(calls[0].arg.maxTokens).toBe(7);

        const withGlobal = await runner.translate(req("o0", { chatId: "other" }));
        expect(withGlobal).toMatchObject({ ok: true, outcome: "applied", translation: { presetId: global.id } });
        expect(calls).toHaveLength(2);
        expect(calls[1].arg.formated).toEqual([{ role: "system", content: "Global other 0" }]);
        expect(calls[1].arg.maxTokens).toBe(8);

        // The chat's preset is deleted: the global selection, and the chat keeps naming the deleted one.
        patch("translatorPresets", { items: [global], selectedId: global.id });
        const fallback = await runner.translate(req("m1"));
        expect(fallback).toMatchObject({ ok: true, outcome: "applied", translation: { presetId: global.id } });
        expect(calls).toHaveLength(3);
        expect(calls[2].arg.formated).toEqual([{ role: "system", content: "Global text 1" }]);
        expect((readChat().data as unknown as { translatorPresetId?: string }).translatorPresetId).toBe(own.id);
        // The earlier translation stays fresh under the deleted preset's id.
        expect(await runner.translate(req("m0"))).toMatchObject({
            outcome: "fresh",
            translation: { presetId: own.id },
        });
        expect(calls).toHaveLength(3);
    });

    it("answers fresh without a run or a map entry, runs again with force, and lets a non-forced request join that run", async () => {
        build();
        chatBatch([{ op: "setTranslation", id: "m0", translation: tr("old", "text 0") }]);
        expect(await runner.translate(req("m0"))).toEqual({
            ok: true,
            outcome: "fresh",
            translation: tr("old", "text 0"),
        });
        expect(calls).toHaveLength(0);
        expect(runner.runningCount()).toBe(0);

        const pending = pendingAnswers();
        const forced = runner.translate(req("m0", { force: true }));
        expect(runner.runningCount()).toBe(1);
        const joined = runner.translate(req("m0"));
        await until(() => pending.length === 1);
        expect(calls).toHaveLength(1);
        pending[0].resolve({ type: "success", result: "new" });
        const results = await Promise.all([forced, joined]);
        expect(results[0]).toMatchObject({ ok: true, outcome: "applied", translation: { text: "new" } });
        expect(results[1]).toEqual(results[0]);
        expect(message("m0").translation?.text).toBe("new");

        // A message a generation owns is refused before any request.
        lock.addToken("t");
        lock.acquire({ characterId: "c", chatId: "k", messageId: "m1" }, { jobId: "j", generationId: "g", token: "t" });
        expect(await runner.translate(req("m1"))).toEqual({ ok: false, status: 409, error: "generating" });
        expect(calls).toHaveLength(1);
    });

    it("ends at the deadline from the timer: callers settle 504, the request keeps counting until it stops, and its late answer is never written", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        build();
        const pending = pendingAnswers();
        const result = runner.translate(req("m0"));
        await until(() => pending.length === 1);
        expect(runner.runningCount()).toBe(1);
        vi.advanceTimersByTime(TRANSLATION_DEADLINE_MS - 1);
        await tick();
        expect(runner.runningCount()).toBe(1);
        vi.advanceTimersByTime(1);
        expect(await result).toEqual({ ok: false, status: 504, error: "The translation took too long" });
        expect(calls[0].signal.aborted).toBe(true);
        expect(runner.runningCount()).toBe(0);
        expect(runner.workingCount()).toBe(1);
        pending[0].resolve({ type: "success", result: "late" });
        await until(() => runner.workingCount() === 0);
        expect(message("m0").translation).toBeUndefined();
    });

    it("ends at the deadline read from the clock when the timer has not fired: a response past it is 504 and not written", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        build();
        const pending = pendingAnswers();
        const result = runner.translate(req("m0"));
        await until(() => pending.length === 1);
        vi.setSystemTime(Date.now() + TRANSLATION_DEADLINE_MS);
        pending[0].resolve({ type: "success", result: "late" });
        expect(await result).toEqual({ ok: false, status: 504, error: "The translation took too long" });
        await until(() => runner.workingCount() === 0);
        expect(message("m0").translation).toBeUndefined();
    });

    it("an immediate retry loop (a banned character set) yields each attempt and still ends at the deadline", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        build();
        // A budget the deadline comes before: a rejection counts against `requestRetrys`.
        patch("providers", { banCharacterset: ["Latin"], requestRetrys: 1_000 });
        answer = async () => ({ type: "success", result: "latin again" });
        const start = Date.now();
        const result = runner.translate(req("m0"));
        // The loop retries at once; this test's own turns still run between the attempts.
        await until(() => calls.length >= 5);
        expect(runner.runningCount()).toBe(1);
        vi.setSystemTime(start + TRANSLATION_DEADLINE_MS);
        expect(await result).toEqual({ ok: false, status: 504, error: "The translation took too long" });
        await until(() => runner.workingCount() === 0);
        const attempts = calls.length;
        await tick();
        await tick();
        expect(calls.length).toBe(attempts);
        expect(message("m0").translation).toBeUndefined();
    });

    it("counts capacity on unsettled work: 429 past 16, also for a fresh stored translation, and still after pause ended the runs", async () => {
        build();
        chatBatch([{ op: "setTranslation", id: "m17", translation: tr("old", "text 17") }]);
        const pending = pendingAnswers();
        const results = Array.from({ length: MAX_RUNNING_TRANSLATIONS }, (_, i) => runner.translate(req(`m${i}`)));
        await until(() => pending.length === MAX_RUNNING_TRANSLATIONS);
        const refused = { ok: false, status: 429, error: "Too many translations are running" };
        expect(await runner.translate(req("m16"))).toEqual(refused);
        expect(await runner.translate(req("m17"))).toEqual(refused);
        // A joiner is not new work.
        const joined = runner.translate(req("m0", { force: true }));

        runner.pause("The server data is being replaced");
        for (const result of await Promise.all(results)) {
            expect(result).toEqual({ ok: false, status: 503, error: "The server data is being replaced" });
        }
        expect(await joined).toEqual({ ok: false, status: 503, error: "The server data is being replaced" });
        expect(runner.runningCount()).toBe(0);
        expect(runner.workingCount()).toBe(MAX_RUNNING_TRANSLATIONS);
        expect(await runner.translate(req("m16"))).toEqual({
            ok: false,
            status: 503,
            error: "The server data is being replaced",
        });
        runner.resume();
        expect(await runner.translate(req("m16"))).toEqual(refused);

        for (const entry of pending) {
            entry.resolve({ type: "success", result: "late" });
        }
        await until(() => runner.workingCount() === 0);
        expect(message("m0").translation).toBeUndefined();
        answer = async () => ({ type: "success", result: "번역" });
        expect(await runner.translate(req("m16"))).toMatchObject({ ok: true, outcome: "applied" });
        expect(calls).toHaveLength(MAX_RUNNING_TRANSLATIONS + 1);
    });

    it("the write fence: shutdown settles the run 503, its answer is never written, and resume does not reopen", async () => {
        build();
        const pending = pendingAnswers();
        const result = runner.translate(req("m0"));
        await until(() => pending.length === 1);
        runner.beginShutdown();
        expect(await result).toEqual({ ok: false, status: 503, error: "The server is shutting down" });
        expect(calls[0].signal.aborted).toBe(true);
        runner.resume();
        expect(await runner.translate(req("m1"))).toEqual({
            ok: false,
            status: 503,
            error: "The server is shutting down",
        });
        pending[0].resolve({ type: "success", result: "late" });
        const drained = runner.drain();
        await until(() => runner.workingCount() === 0);
        await drained;
        expect(message("m0").translation).toBeUndefined();
    });

    it("the write fence: a maintenance gate closed at the write is 503 and nothing is written", async () => {
        build();
        const pending = pendingAnswers();
        const result = runner.translate(req("m0"));
        await until(() => pending.length === 1);
        gateClosed = true;
        pending[0].resolve({ type: "success", result: "new" });
        expect(await result).toEqual({ ok: false, status: 503, error: "The server data is being replaced" });
        expect(message("m0").translation).toBeUndefined();
        gateClosed = false;
        answer = async () => ({ type: "success", result: "번역" });
        expect(await runner.translate(req("m0"))).toMatchObject({ ok: true, outcome: "applied" });
    });

    it("a message or chat gone before the write is 404; a chat recreated under the same id is 409", async () => {
        build();
        const pending = pendingAnswers();
        const gone = runner.translate(req("m0"));
        await until(() => pending.length === 1);
        chatBatch([{ op: "remove", ids: ["m0"] }]);
        pending[0].resolve({ type: "success", result: "new" });
        expect(await gone).toEqual({ ok: false, status: 404, error: "The message no longer exists" });

        const chatGone = runner.translate(req("m1"));
        await until(() => pending.length === 2);
        chatBatch([{ op: "delete" }]);
        pending[1].resolve({ type: "success", result: "new" });
        expect(await chatGone).toEqual({ ok: false, status: 404, error: "The chat no longer exists" });

        chatBatch([{ op: "create", chat: CHAT as never }], null);
        const replaced = runner.translate(req("m1"));
        await until(() => pending.length === 3);
        chatBatch([{ op: "delete" }]);
        chatBatch([{ op: "create", chat: CHAT as never }], null);
        pending[2].resolve({ type: "success", result: "new" });
        expect(await replaced).toEqual({
            ok: false,
            status: 409,
            error: "The chat changed while it was translated; translate again",
        });
        expect(message("m1").translation).toBeUndefined();
        expect(runner.runningCount()).toBe(0);
    });

    it("maps a streaming answer (cancelled), a failed answer, and an unexpected failure", async () => {
        build();
        let cancelled = false;
        answer = async () => ({
            type: "streaming",
            result: new ReadableStream({
                cancel() {
                    cancelled = true;
                },
            }),
        });
        expect(await runner.translate(req("m0"))).toEqual({
            ok: false,
            status: 502,
            error: "The translation model answered in an unexpected form",
        });
        expect(cancelled).toBe(true);

        answer = async () => ({ type: "fail", result: "upstream said no", noRetry: true });
        expect(await runner.translate(req("m0"))).toEqual({ ok: false, status: 502, error: "upstream said no" });

        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        answer = async () => {
            throw new Error("kaboom with details");
        };
        expect(await runner.translate(req("m0"))).toEqual({ ok: false, status: 500, error: "The translation failed" });
        expect(logged).toHaveBeenCalledWith("[translate] unexpected failure:", "Error");
        expect(logged.mock.calls.flat().join(" ")).not.toContain("kaboom");
        logged.mockRestore();
        expect(message("m0").translation).toBeUndefined();
        expect(runner.workingCount()).toBe(0);
    });

    // A send's hand-off, and the chain behind a run of an older text.
    const target = () => ({ characterId: "c", chatId: "k", ...ids });
    /** Chat `k` auto-translates with the LLM translator on the stored translation; `r1` and `r2` are replies. */
    function enableAutoTranslation() {
        patch("memoryTranslateMedia", { translatorType: "llm", llmTranslationTarget: "message" });
        chatBatch([
            { op: "meta", set: { autoTranslate: true }, unset: [] },
            {
                op: "append",
                messages: [m("r1", "reply one", "char"), m("r2", "reply two", "char")],
                anchor: { end: true },
            },
        ]);
    }

    it("handOff starts an unforced run per message when the chat auto-translates on the stored LLM translation, skips user messages with translateBotOnly, and returns only the ids with a run", async () => {
        build();
        const pending = pendingAnswers();
        const sent = () => pending.length;

        // Off: the chat's flag, a target language, the LLM translator, and the stored target are all needed.
        patch("memoryTranslateMedia", { translatorType: "llm", llmTranslationTarget: "message" });
        expect(runner.handOff(target(), ["m0"])).toEqual([]);
        chatBatch([{ op: "meta", set: { autoTranslate: true }, unset: [] }]);
        patch("memoryTranslateMedia", { translator: "" });
        expect(runner.handOff(target(), ["m0"])).toEqual([]);
        patch("memoryTranslateMedia", { translator: "ko", translatorType: "google" });
        expect(runner.handOff(target(), ["m0"])).toEqual([]);
        patch("memoryTranslateMedia", { translatorType: "llm", llmTranslationTarget: "rendered" });
        expect(runner.handOff(target(), ["m0"])).toEqual([]);
        patch("memoryTranslateMedia", { llmTranslationTarget: "message" });
        expect(runner.handOff({ ...target(), chatId: "nope" }, ["m0"])).toEqual([]);
        expect(runner.handOff(target(), [])).toEqual([]);
        await tick();
        expect(runner.runningCount()).toBe(0);
        expect(sent()).toBe(0);

        // On: one run per message (duplicates once, unknown ids skipped), each an unforced start.
        chatBatch([
            {
                op: "append",
                messages: [m("r1", "reply one", "char"), m("r2", "reply two", "char")],
                anchor: { end: true },
            },
        ]);
        expect(runner.handOff(target(), ["r1", "m0", "r1", "nope"])).toEqual(["r1", "m0"]);
        expect(runner.runningCount()).toBe(2);
        await until(() => sent() === 2);
        const source = (index: number) => JSON.stringify(calls[index].arg.formated);
        expect(source(0)).toContain("reply one");
        expect(source(1)).toContain("text 0");
        // A message in flight is reported again (the tab follows it); a fresh one and a locked one are not.
        expect(runner.handOff(target(), ["r1"])).toEqual(["r1"]);
        expect(runner.runningCount()).toBe(2);
        pending[0].resolve({ type: "success", result: "하나" });
        pending[1].resolve({ type: "success", result: "영" });
        await until(() => runner.runningCount() === 0);
        expect(message("r1").translation).toMatchObject({
            text: "하나",
            sourceHash: translationSourceHash("reply one"),
        });
        expect(message("m0").translation).toMatchObject({ text: "영" });
        expect(runner.handOff(target(), ["r1", "m0"])).toEqual([]);
        lock.addToken("t");
        lock.acquire({ characterId: "c", chatId: "k", messageId: "r2" }, { jobId: "j", generationId: "g", token: "t" });
        expect(runner.handOff(target(), ["r2"])).toEqual([]);
        lock.release({ characterId: "c", chatId: "k", messageId: "r2" }, "t", "g");
        expect(runner.runningCount()).toBe(0);
        expect(sent()).toBe(2);

        // Bot replies only: the user messages are skipped, the replies translated.
        chatBatch([{ op: "meta", set: { translateBotOnly: true }, unset: [] }]);
        expect(runner.handOff(target(), ["r2", "m1"])).toEqual(["r2"]);
        expect(runner.runningCount()).toBe(1);
        await until(() => sent() === 3);
        expect(source(2)).toContain("reply two");
        expect(calls[2].arg).toMatchObject({ useStreaming: false, noMultiGen: true });

        // Ids that fail the chat's display binding or name a missing record hand nothing over, also while
        // the message's run is in flight (a joiner's refusal is not "in flight").
        expect(runner.handOff({ ...target(), modelPresetId: "other" }, ["r2", "m1"])).toEqual([]);
        expect(runner.handOff({ ...target(), personaId: "nope" }, ["r2"])).toEqual([]);
        // Maintenance refuses the hand-off; the run in flight ends.
        runner.pause("The server data is being replaced");
        expect(runner.handOff(target(), ["r2"])).toEqual([]);
        runner.resume();
        await until(() => runner.runningCount() === 0);
        pending[2].resolve({ type: "success", result: "late" });
        await until(() => runner.workingCount() === 0);
        expect(message("r2").translation).toBeUndefined();

        // At capacity the hand-off is best effort: nothing is queued or retried.
        chatBatch([{ op: "meta", set: {}, unset: ["translateBotOnly"] }]);
        const filling = Array.from({ length: MAX_RUNNING_TRANSLATIONS }, (_, i) => runner.translate(req(`m${i + 1}`)));
        await until(() => sent() === 3 + MAX_RUNNING_TRANSLATIONS);
        expect(runner.handOff(target(), ["r2"])).toEqual([]);
        expect(runner.runningCount()).toBe(MAX_RUNNING_TRANSLATIONS);
        for (const entry of pending.slice(3)) {
            entry.resolve({ type: "success", result: "번역" });
        }
        await Promise.all(filling);
        await until(() => runner.workingCount() === 0);
        expect(runner.handOff(target(), ["r2"])).toEqual(["r2"]);
        await until(() => sent() === 4 + MAX_RUNNING_TRANSLATIONS);
        pending.at(-1)!.resolve({ type: "success", result: "둘" });
        await until(() => runner.runningCount() === 0);
        expect(message("r2").translation?.text).toBe("둘");
    });

    it("a request for a text the run in flight no longer translates waits for that run and then translates the current text; a hand-off made meanwhile is reported and followed through the chain", async () => {
        build();
        enableAutoTranslation();
        const pending = pendingAnswers();
        const first = runner.translate(req("r1"));
        await until(() => pending.length === 1);
        expect(runner.runningCount()).toBe(1);

        // A continue extended the reply while its translation runs: the send's hand-off waits behind
        // the run (and is reported, so the tab follows), and so does a follower's request.
        chatBatch([{ op: "setText", id: "r1", text: "reply one, continued" }]);
        expect(runner.handOff(target(), ["r1"])).toEqual(["r1"]);
        const follower = runner.translate(req("r1"));
        // A request for the unchanged text of another message joins as before; nothing new started.
        await tick();
        expect(runner.runningCount()).toBe(1);
        expect(calls).toHaveLength(1);

        // The old run's write is ignored (its text is gone); the chain starts one run for the new text.
        pending[0].resolve({ type: "success", result: "stale" });
        expect(await first).toEqual({ ok: true, outcome: "ignored", translation: null });
        await until(() => pending.length === 2);
        expect(runner.runningCount()).toBe(1);
        expect(calls).toHaveLength(2);
        expect(JSON.stringify(calls[1].arg.formated)).toContain("reply one, continued");
        expect(calls[1].jobId).not.toBe(calls[0].jobId);
        // A late joiner finds the new run through the map.
        const late = runner.translate(req("r1", { force: true }));
        await tick();
        expect(calls).toHaveLength(2);

        pending[1].resolve({ type: "success", result: "이어서" });
        const results = await Promise.all([follower, late]);
        expect(results[0]).toMatchObject({
            ok: true,
            outcome: "applied",
            translation: { text: "이어서", sourceHash: translationSourceHash("reply one, continued") },
        });
        expect(results[1]).toEqual(results[0]);
        expect(message("r1").translation).toEqual(results[0].ok ? results[0].translation : null);
        await until(() => runner.runningCount() === 0 && runner.workingCount() === 0);

        // A chained request whose chat is gone when the run settles ends with the chain's own refusal.
        const again = runner.translate(req("r2", { force: true }));
        await until(() => pending.length === 3);
        chatBatch([{ op: "setText", id: "r2", text: "reply two, continued" }]);
        const chained = runner.translate(req("r2"));
        chatBatch([{ op: "delete" }]);
        pending[2].resolve({ type: "success", result: "stale" });
        expect(await again).toEqual({ ok: false, status: 404, error: "The chat no longer exists" });
        expect(await chained).toMatchObject({ ok: false, status: 404 });
        expect(calls).toHaveLength(3);
        expect(runner.runningCount()).toBe(0);
    });

    // Without Send Text As-Is (every preset from before the option) the runner protects lines as the
    // Fastify fork's server did (`translateProtectingLines`): one pipeline run per part between the
    // empty and asset lines, one after another, under the message's one job id, controller, deadline,
    // and write; with it, one run over the whole source, the reply stored as it is. The automatic
    // hand-off is the same run.
    const PARTS = "  one\ntwo \n\n{{img::pic}}\n{{raw::x}}\nthree\n";
    const partsPreset = (sendTextAsIs?: boolean) =>
        createTranslatorPreset("Parts", {
            id: "parts",
            steps: [
                { prompt: "A {{slot::content}}", outputKey: "draft" },
                { prompt: "B {{slot::prev}} [{{slot::out::draft}}]" },
            ],
            sendTextAsIs,
        });
    /** Selects the two-step `parts` preset and appends message `p` holding `PARTS` to chat `k`. */
    function usePartsPreset(sendTextAsIs?: boolean) {
        patch("translatorPresets", { items: [partsPreset(sendTextAsIs)], selectedId: "parts" });
        chatBatch([{ op: "append", messages: [m("p", PARTS, "char")], anchor: { end: true } }]);
    }
    const contents = () => calls.map((call) => call.arg.formated[0].content);

    it("protects lines by default: one pipeline run per part between the empty and asset lines, in order, each part's named outputs its own, the parts trimmed and joined around the kept lines, under one job id", async () => {
        build({ now: () => 7 });
        usePartsPreset();
        const outputs = ["d1", "<think>plan</think>\n f1 ", "d2", "f2"];
        answer = async () => ({ type: "success", result: outputs[calls.length - 1] });
        const text = "f1\n\n\n{{img::pic}}\n\n{{raw::x}}\nf2";
        expect(await runner.translate(req("p"))).toEqual({
            ok: true,
            outcome: "applied",
            translation: {
                text,
                sourceHash: translationSourceHash(PARTS),
                presetId: "parts",
                targetLanguage: "ko",
                translatedAt: 7,
            },
        });
        // Part by part, each part through both steps before the next; the second part's step 2 reads
        // the second part's draft, never the first's.
        expect(contents()).toEqual(["A one\ntwo", "B d1 [d1]", "A three", "B d2 [d2]"]);
        expect(new Set(calls.map((call) => call.jobId)).size).toBe(1);
        expect(message("p").translation?.text).toBe(text);
        expect(runner.workingCount()).toBe(0);

        // A source of protected lines alone stores them trimmed, without a request.
        chatBatch([{ op: "append", messages: [m("q", "\n{{img::a}}\n{{img::b}}\n", "char")], anchor: { end: true } }]);
        expect(await runner.translate(req("q"))).toMatchObject({
            outcome: "applied",
            translation: {
                text: "{{img::a}}\n\n{{img::b}}",
                sourceHash: translationSourceHash("\n{{img::a}}\n{{img::b}}\n"),
            },
        });
        expect(calls).toHaveLength(4);
    });

    it("sends the whole source in one run with Send Text As-Is and stores the reply as it is, untrimmed", async () => {
        build();
        usePartsPreset(true);
        const reply = "  f\n\n{{img::pic}}\n  ";
        answer = async () => ({ type: "success", result: calls.length === 1 ? "d" : reply });
        expect(await runner.translate(req("p"))).toMatchObject({
            ok: true,
            outcome: "applied",
            translation: { text: reply, presetId: "parts", sourceHash: translationSourceHash(PARTS) },
        });
        expect(contents()).toEqual([`A ${PARTS}`, "B d [d]"]);
        expect(message("p").translation?.text).toBe(reply);
        // The flag is read from the stored preset: off again, the next run goes part by part.
        patch("translatorPresets", { items: [partsPreset()], selectedId: "parts" });
        answer = async () => ({ type: "success", result: "x" });
        expect(await runner.translate(req("p", { force: true }))).toMatchObject({
            outcome: "applied",
            translation: { text: "x\n\n\n{{img::pic}}\n\n{{raw::x}}\nx" },
        });
        expect(calls).toHaveLength(6);
    });

    it("a later part's failure ends the run (502), and the deadline during a later part ends it (504): the earlier parts' answers are discarded and nothing is stored", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        build();
        usePartsPreset();
        answer = async () =>
            calls.length === 3
                ? { type: "fail", result: "second part failed", noRetry: true }
                : { type: "success", result: "ok" };
        expect(await runner.translate(req("p"))).toEqual({ ok: false, status: 502, error: "second part failed" });
        expect(calls).toHaveLength(3);
        expect(message("p").translation).toBeUndefined();
        expect(runner.workingCount()).toBe(0);

        calls = [];
        const pending = pendingAnswers();
        const start = Date.now();
        const result = runner.translate(req("p"));
        await until(() => pending.length === 1);
        pending[0].resolve({ type: "success", result: "d1" });
        await until(() => pending.length === 2);
        pending[1].resolve({ type: "success", result: "f1" });
        await until(() => pending.length === 3);
        // The first part is done when the message's one deadline passes during the second part's request.
        vi.setSystemTime(start + TRANSLATION_DEADLINE_MS);
        pending[2].resolve({ type: "success", result: "d2" });
        expect(await result).toEqual({ ok: false, status: 504, error: "The translation took too long" });
        expect(calls).toHaveLength(3);
        expect(calls[2].signal.aborted).toBe(true);
        await until(() => runner.workingCount() === 0);
        expect(message("p").translation).toBeUndefined();
    });

    it("the automatic hand-off translates in the preset's mode too: part by part by default, the whole reply as it is with Send Text As-Is", async () => {
        build();
        enableAutoTranslation();
        chatBatch([
            { op: "setText", id: "r1", text: "reply one\n\nmore" },
            { op: "setText", id: "r2", text: "reply two\n\nmore" },
        ]);
        const pending = pendingAnswers();
        expect(runner.handOff(target(), ["r1"])).toEqual(["r1"]);
        await until(() => pending.length === 1);
        expect(calls[0].arg.formated.at(-1)).toEqual({ role: "user", content: "reply one" });
        pending[0].resolve({ type: "success", result: "하나" });
        await until(() => pending.length === 2);
        expect(calls[1].arg.formated.at(-1)).toEqual({ role: "user", content: "more" });
        pending[1].resolve({ type: "success", result: " 더 " });
        await until(() => runner.runningCount() === 0);
        expect(message("r1").translation).toMatchObject({
            text: "하나\n\n더",
            sourceHash: translationSourceHash("reply one\n\nmore"),
        });

        const asIs = createTranslatorPreset("As-Is", { id: "asis", prompt: "T {{slot::content}}", sendTextAsIs: true });
        patch("translatorPresets", { items: [asIs], selectedId: "asis" });
        expect(runner.handOff(target(), ["r2"])).toEqual(["r2"]);
        await until(() => pending.length === 3);
        expect(calls[2].arg.formated).toEqual([{ role: "system", content: "T reply two\n\nmore" }]);
        pending[2].resolve({ type: "success", result: " 둘 " });
        await until(() => runner.runningCount() === 0);
        expect(message("r2").translation).toMatchObject({ text: " 둘 ", presetId: "asis" });
        expect(calls).toHaveLength(3);
        await until(() => runner.workingCount() === 0);
    });

    // A preset on Exclude Chain-of-Thought strips the reasoning blocks from the whole source once,
    // before the As-Is run or the line cut, and from each history entry's source and fresh
    // translation after the freshness check; a source left blank stores an empty translation without
    // a request or a count; `sourceHash` stays the stored text's.
    /** A non-idempotent text: one strip leaves `<think>secret</think>visible`. */
    const NONIDEM = "<thi<think>x</think>nk>secret</think>visible";
    const EX_STEPS = [
        { prompt: "A {{slot::content}}", outputKey: "draft" },
        { prompt: "B {{slot::prev}} [{{slot::out::draft}}]" },
    ];
    /** Selects an `ex` preset of `steps` on Exclude Chain-of-Thought (and Send Text As-Is when asked). */
    function useExcludePreset(
        steps: NonNullable<Parameters<typeof createTranslatorPreset>[1]>["steps"],
        sendTextAsIs?: boolean,
    ) {
        patch("translatorPresets", {
            items: [createTranslatorPreset("Ex", { id: "ex", steps, sendTextAsIs, excludeThoughts: true })],
            selectedId: "ex",
        });
    }

    it("strips the whole source exactly once before the line cut (a block spanning blank and asset lines leaves whole), joins a part's lines with newlines as before, and stores under the stored text's hash", async () => {
        build({ now: () => 9 });
        useExcludePreset(EX_STEPS);
        const raw = `${NONIDEM}\n<Thoughts>\nhidden\n\n{{img::h}}\n</Thoughts>\nfirst\nsecond\n\n{{img::pic}}\nthird`;
        chatBatch([{ op: "append", messages: [m("x", raw, "char")], anchor: { end: true } }]);
        answer = async () => ({ type: "success", result: `o${calls.length}` });
        expect(await runner.translate(req("x"))).toEqual({
            ok: true,
            outcome: "applied",
            translation: {
                text: "o2\n\no4\n\n\n{{img::pic}}\no6",
                sourceHash: translationSourceHash(raw),
                presetId: "ex",
                targetLanguage: "ko",
                translatedAt: 9,
            },
        });
        expect(contents()).toEqual([
            "A <think>secret</think>visible",
            "B o1 [o1]",
            "A first\nsecond",
            "B o3 [o3]",
            "A third",
            "B o5 [o5]",
        ]);
        expect(new Set(calls.map((call) => call.jobId)).size).toBe(1);
        expect(message("x").translation?.text).toBe("o2\n\no4\n\n\n{{img::pic}}\no6");
        expect(runner.workingCount()).toBe(0);

        // The flag is read from the stored preset: without it the same source goes as it is.
        patch("translatorPresets", {
            items: [createTranslatorPreset("Ex", { id: "ex", steps: EX_STEPS })],
            selectedId: "ex",
        });
        calls = [];
        expect(await runner.translate(req("x", { force: true }))).toMatchObject({ ok: true, outcome: "applied" });
        expect(contents()).toHaveLength(6);
        expect(contents()[0]).toBe(`A ${NONIDEM}\n<Thoughts>\nhidden`);
        expect(contents()[2]).toBe("A </Thoughts>\nfirst\nsecond");
    });

    it("with Send Text As-Is sends the stripped source whole and trimmed in one run and stores the reply as it is; a source without an opening tag goes as it is", async () => {
        build();
        useExcludePreset(EX_STEPS, true);
        const raw = "  <think>\nhidden\n</think>  Hello\n\n{{img::pic}}  ";
        chatBatch([
            {
                op: "append",
                messages: [m("x", raw, "char"), m("y", "  plain </think> ", "char")],
                anchor: { end: true },
            },
        ]);
        answer = async () => ({ type: "success", result: calls.length === 1 ? "d" : " r " });
        expect(await runner.translate(req("x"))).toMatchObject({
            ok: true,
            outcome: "applied",
            translation: { text: " r ", sourceHash: translationSourceHash(raw), presetId: "ex" },
        });
        expect(contents()).toEqual(["A Hello\n\n{{img::pic}}", "B d [d]"]);
        expect(await runner.translate(req("y"))).toMatchObject({ ok: true, outcome: "applied" });
        expect(contents()[2]).toBe("A   plain </think> ");
        expect(runner.workingCount()).toBe(0);
    });

    it("a source the strip leaves blank stores an empty translation under the stored text's hash (a forced run replacing the old one), without a request or a history count; one left with protected lines alone stores them without a request", async () => {
        build({ now: () => 3 });
        useExcludePreset([{ prompt: "A[{{slot::history::10}}] {{slot::content}}" }]);
        const only = "<Thoughts>\nonly\n</Thoughts>\n";
        chatBatch([
            {
                op: "append",
                messages: [
                    { ...m("o", only, "char"), translation: tr("old", only) },
                    m("p", "<think>x</think>\n{{img::a}}\n<think>y</think>", "char"),
                ],
                anchor: { end: true },
            },
        ]);
        expect(await runner.translate(req("o", { force: true }))).toEqual({
            ok: true,
            outcome: "applied",
            translation: {
                text: "",
                sourceHash: translationSourceHash(only),
                presetId: "ex",
                targetLanguage: "ko",
                translatedAt: 3,
            },
        });
        expect(message("o").translation?.text).toBe("");
        // Fresh now: an unforced request runs nothing more.
        expect(await runner.translate(req("o"))).toMatchObject({ ok: true, outcome: "fresh" });
        expect(await runner.translate(req("p"))).toMatchObject({
            ok: true,
            outcome: "applied",
            translation: {
                text: "{{img::a}}",
                sourceHash: translationSourceHash("<think>x</think>\n{{img::a}}\n<think>y</think>"),
            },
        });
        expect(calls).toEqual([]);
        expect(counts).toEqual([]);
        expect(runner.workingCount()).toBe(0);
    });

    it("strips each history entry's source and fresh translation after the freshness check (a translation of the stripped text is stale), keeps an entry left empty, and counts the stripped blocks once for every part and step", async () => {
        build();
        useExcludePreset([
            { prompt: "A[{{slot::history::10}}] {{slot::content}}", outputKey: "draft" },
            { prompt: "B[{{slot::historytrans::10}}] {{slot::prev}}" },
        ]);
        chatBatch([
            {
                op: "append",
                messages: [
                    { ...m("cut", "cut here"), disabled: "allBefore" },
                    {
                        ...m("h0", "hello <think>hh</think>"),
                        translation: tr("안녕 <think>tt</think>", "hello <think>hh</think>"),
                    },
                    m("h1", "<think>only</think>", "char"),
                    { ...m("h2", "<think>s</think>stale"), translation: tr("오래", "stale") },
                    m("t", "<think>t</think>target\n\nsecond", "char"),
                ],
                anchor: { end: true },
            },
        ]);
        answer = async () => ({ type: "success", result: `o${calls.length}` });
        expect(await runner.translate(req("t"))).toMatchObject({
            ok: true,
            outcome: "applied",
            translation: { text: "o2\n\no4", sourceHash: translationSourceHash("<think>t</think>target\n\nsecond") },
        });
        const history = "user: hello\n\n---\n\nchar: \n\n---\n\nuser: stale\n\n---\n\n";
        const historyTrans = "user: 안녕\n\n---\n\nchar: \n\n---\n\nuser: \n\n---\n\n";
        expect(contents()).toEqual([
            `A[${history}] target`,
            `B[${historyTrans}] o1`,
            `A[${history}] second`,
            `B[${historyTrans}] o3`,
        ]);
        expect(counts.map((entry) => entry.text)).toEqual([
            "user: hello\n\n---\n\n",
            "user: 안녕\n\n---\n\n",
            "char: \n\n---\n\n",
            "char: \n\n---\n\n",
            "user: stale\n\n---\n\n",
            "user: \n\n---\n\n",
        ]);
        expect(runner.workingCount()).toBe(0);
    });

    // The history slots. The runner builds the history of the message from the run's chat copy once,
    // when the first pipeline run starts, with `tokens` in the main model's scope, and hands it to
    // every part and step in both modes; a text that sends nothing counts nothing. Each count yields
    // a turn and checks the run before and after it, so a run ended during a held count settles its
    // callers at once, stays counted until the count settles, and then neither counts, requests, nor
    // writes; a tokenizer failure is an unexpected failure (500).
    const HISTORY_STEPS = [
        { prompt: "A[{{slot::history::10}}] {{slot::content}}", outputKey: "draft" },
        {
            prompt: "B[{{slot::historytrans::10}}] {{slot::prev}}",
            model: { mode: "profile", profileId: "profile-b" } as const,
        },
    ];
    /** Selects a `hist` preset of `steps`. */
    function useHistoryPreset(
        steps: NonNullable<Parameters<typeof createTranslatorPreset>[1]>["steps"],
        sendTextAsIs?: boolean,
    ) {
        patch("translatorPresets", {
            items: [createTranslatorPreset("Hist", { id: "hist", steps, sendTextAsIs })],
            selectedId: "hist",
        });
    }
    /**
     * Appends to chat `k`: an `allBefore` row, `h0` (translated), a comment, `h2` (raw CBS, no
     * translation), a disabled row, the target `t` ("target\n\nsecond"), and a row after it.
     */
    function appendHistoryRows() {
        chatBatch([
            {
                op: "append",
                messages: [
                    { ...m("cut", "cut here"), disabled: "allBefore" },
                    { ...m("h0", "hello"), translation: tr("안녕", "hello") },
                    { ...m("h1", "a comment", "char"), isComment: true },
                    m("h2", "world {{char}}", "char"),
                    { ...m("h3", "off"), disabled: true },
                    m("t", "target\n\nsecond", "char"),
                    m("after", "later"),
                ],
                anchor: { end: true },
            },
        ]);
    }
    const HISTORY = "user: hello\n\n---\n\nchar: world {{char}}\n\n---\n\n";
    const HISTORY_TRANS = "user: 안녕\n\n---\n\nchar: \n\n---\n\n";
    const BLOCKS = [
        "user: hello\n\n---\n\n",
        "user: 안녕\n\n---\n\n",
        "char: world {{char}}\n\n---\n\n",
        "char: \n\n---\n\n",
    ];
    /** A `tokens.count` whose first call stays pending until the test settles it; the rest count characters. */
    function holdFirstCount() {
        const held = deferred<number>();
        let first = true;
        count = async (text) => {
            if (first) {
                first = false;
                return held.promise;
            }
            return text.length;
        };
        return held;
    }

    it("fills the history slots from the run's chat copy, built once for every part and step in the main model's token scope, in both modes", async () => {
        build({ now: () => 5 });
        appendHistoryRows();
        useHistoryPreset(HISTORY_STEPS);
        const profiles = single("modelProfiles");
        store.applyChanges({
            ops: [
                {
                    kind: kindOf("modelProfiles"),
                    id: "main",
                    baseRevision: profiles.revision,
                    data: [
                        ...profiles.data,
                        { ...profiles.data[0], id: "profile-b", name: "B", modelId: "other-model" },
                    ],
                },
            ],
        });
        answer = async () => ({ type: "success", result: `out${calls.length}` });

        expect(await runner.translate(req("t"))).toEqual({
            ok: true,
            outcome: "applied",
            translation: {
                text: "out2\n\nout4",
                sourceHash: translationSourceHash("target\n\nsecond"),
                presetId: "hist",
                targetLanguage: "ko",
                translatedAt: 5,
            },
        });
        // The same history in every part's steps: the sources in step A, the translations in step B.
        expect(contents()).toEqual([
            `A[${HISTORY}] target`,
            `B[${HISTORY_TRANS}] out1`,
            `A[${HISTORY}] second`,
            `B[${HISTORY_TRANS}] out3`,
        ]);
        // Two entries, two blocks each, counted once for the whole run, in the main model's scope,
        // although step B runs on another profile.
        expect(counts.map((entry) => entry.text)).toEqual(BLOCKS);
        expect(calls[1].arg.profileId).toBe("profile-b");
        for (const entry of counts) {
            expect(entry.scope).toEqual(calls[0].tokenScope);
            expect(entry.scope.aiModel).toBe(profiles.data[0].modelId);
            expect(entry.scope.aiModel).not.toBe("other-model");
        }
        expect(message("t").translation?.text).toBe("out2\n\nout4");
        expect(runner.workingCount()).toBe(0);

        // Send Text As-Is: one run over the whole source, the same history, built once again.
        calls = [];
        counts = [];
        useHistoryPreset(HISTORY_STEPS, true);
        expect(await runner.translate(req("t", { force: true }))).toMatchObject({
            ok: true,
            outcome: "applied",
            translation: { text: "out2" },
        });
        expect(contents()).toEqual([`A[${HISTORY}] target\n\nsecond`, `B[${HISTORY_TRANS}] out1`]);
        expect(counts.map((entry) => entry.text)).toEqual(BLOCKS);
        expect(runner.workingCount()).toBe(0);
    });

    it("counts nothing for a prompt without a valid history slot (an invalid count fills in empty), for a protected-only text, or for a disabled step's slot", async () => {
        build();
        appendHistoryRows();
        useHistoryPreset([
            { prompt: "X[{{slot::history::0}}][{{slot::history}}][{{slot::historytrans::51}}] {{slot::content}}" },
        ]);
        expect(await runner.translate(req("t"))).toMatchObject({ ok: true, outcome: "applied" });
        expect(contents()).toEqual(["X[][{{slot::history}}][] target", "X[][{{slot::history}}][] second"]);
        expect(counts).toEqual([]);

        // A protected-only text with a history prompt: no part is sent, so nothing is counted.
        useHistoryPreset(HISTORY_STEPS);
        chatBatch([{ op: "append", messages: [m("q", "\n{{img::a}}\n", "char")], anchor: { end: true } }]);
        expect(await runner.translate(req("q"))).toMatchObject({
            ok: true,
            outcome: "applied",
            translation: { text: "{{img::a}}" },
        });
        expect(counts).toEqual([]);
        expect(calls).toHaveLength(2);

        // A history slot in a step that does not run is not counted.
        useHistoryPreset([{ prompt: "Y {{slot::content}}" }, { prompt: "{{slot::history::3}}", enabled: false }]);
        expect(await runner.translate(req("t", { force: true }))).toMatchObject({ ok: true, outcome: "applied" });
        expect(contents().at(-1)).toBe("Y second");
        expect(counts).toEqual([]);
    });

    it("trims the oldest whole entries to translatorHistoryMaxTokens as stored, charging both blocks; a budget at or below 0 is stored as 2048", async () => {
        build();
        appendHistoryRows();
        useHistoryPreset([{ prompt: "A[{{slot::history::10}}|{{slot::historytrans::10}}] {{slot::content}}" }], true);
        // The entries cost 18 + 15 = 33 and 27 + 13 = 40 (one token per character, the empty
        // translation block included): a budget of exactly 40 keeps the newest entry alone.
        patch("memoryTranslateMedia", { translatorHistoryMaxTokens: 40 });
        expect(await runner.translate(req("t"))).toMatchObject({ ok: true, outcome: "applied" });
        expect(contents()).toEqual(["A[char: world {{char}}\n\n---\n\n|char: \n\n---\n\n] target\n\nsecond"]);
        expect(counts.map((entry) => entry.text)).toEqual(BLOCKS);
        // One token less: the newest entry alone passes the budget, both slots are empty.
        patch("memoryTranslateMedia", { translatorHistoryMaxTokens: 39 });
        expect(await runner.translate(req("t", { force: true }))).toMatchObject({ ok: true, outcome: "applied" });
        expect(contents()[1]).toBe("A[|] target\n\nsecond");
        // The normalizer stores a value at or below 0 as the default, under which both entries fit.
        patch("memoryTranslateMedia", { translatorHistoryMaxTokens: 0 });
        expect(single("memoryTranslateMedia").data.translatorHistoryMaxTokens).toBe(2048);
        expect(await runner.translate(req("t", { force: true }))).toMatchObject({ ok: true, outcome: "applied" });
        expect(contents()[2]).toBe(`A[${HISTORY}|${HISTORY_TRANS}] target\n\nsecond`);
        expect(runner.workingCount()).toBe(0);
    });

    it("builds from the run's chat copy: history rows edited during a held count do not change the run, and the target's own edit makes the write ignored", async () => {
        build();
        appendHistoryRows();
        useHistoryPreset([{ prompt: "A[{{slot::history::10}}] {{slot::content}}" }], true);
        const held = holdFirstCount();
        const result = runner.translate(req("t"));
        await until(() => counts.length === 1);
        expect(calls).toHaveLength(0);
        chatBatch([
            { op: "setText", id: "h0", text: "changed" },
            { op: "setText", id: "h2", text: "changed too" },
        ]);
        held.resolve(1);
        expect(await result).toMatchObject({ ok: true, outcome: "applied", translation: { text: "번역" } });
        expect(contents()).toEqual([`A[${HISTORY}] target\n\nsecond`]);
        expect(message("h0").data).toBe("changed");
        expect(message("t").translation?.text).toBe("번역");

        // The target itself edited during the held count: the run finishes on the captured text and
        // its write is ignored.
        calls = [];
        counts = [];
        const again = holdFirstCount();
        const second = runner.translate(req("t", { force: true }));
        await until(() => counts.length === 1);
        chatBatch([{ op: "setText", id: "t", text: "target edited" }]);
        again.resolve(1);
        expect(await second).toEqual({ ok: true, outcome: "ignored", translation: null });
        expect(contents()).toEqual(["A[user: changed\n\n---\n\nchar: changed too\n\n---\n\n] target\n\nsecond"]);
        expect(message("t").translation?.text).toBe("번역");
        expect(message("t").translation?.sourceHash).toBe(translationSourceHash("target\n\nsecond"));
        expect(runner.workingCount()).toBe(0);
    });

    it("a count held past the deadline: the callers settle 504 at once, the work stays counted, and the late count brings no further count, request, or write", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        build();
        appendHistoryRows();
        useHistoryPreset([{ prompt: "A[{{slot::history::10}}] {{slot::content}}" }], true);
        const held = holdFirstCount();
        const result = runner.translate(req("t"));
        await until(() => counts.length === 1);
        expect(runner.runningCount()).toBe(1);
        vi.advanceTimersByTime(TRANSLATION_DEADLINE_MS);
        expect(await result).toEqual({ ok: false, status: 504, error: "The translation took too long" });
        expect(runner.runningCount()).toBe(0);
        expect(runner.workingCount()).toBe(1);
        held.resolve(1);
        await until(() => runner.workingCount() === 0);
        expect(counts).toHaveLength(1);
        expect(calls).toHaveLength(0);
        expect(message("t").translation).toBeUndefined();
    });

    it("the deadline read from the clock during a held count: 504 once the count settles, nothing requested or written", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        build();
        appendHistoryRows();
        useHistoryPreset([{ prompt: "A[{{slot::history::10}}] {{slot::content}}" }], true);
        const held = holdFirstCount();
        const result = runner.translate(req("t"));
        await until(() => counts.length === 1);
        vi.setSystemTime(Date.now() + TRANSLATION_DEADLINE_MS);
        held.resolve(1);
        expect(await result).toEqual({ ok: false, status: 504, error: "The translation took too long" });
        await until(() => runner.workingCount() === 0);
        expect(counts).toHaveLength(1);
        expect(calls).toHaveLength(0);
        expect(message("t").translation).toBeUndefined();
    });

    it("maintenance and shutdown during a held count settle the callers 503 at once; a late rejection or resolution counts, requests, and writes nothing more", async () => {
        build();
        appendHistoryRows();
        useHistoryPreset([{ prompt: "A[{{slot::history::10}}] {{slot::content}}" }], true);
        const held = holdFirstCount();
        const result = runner.translate(req("t"));
        await until(() => counts.length === 1);
        runner.pause("The server data is being replaced");
        expect(await result).toEqual({ ok: false, status: 503, error: "The server data is being replaced" });
        expect(runner.runningCount()).toBe(0);
        expect(runner.workingCount()).toBe(1);
        held.reject(new Error("the count failed late"));
        await until(() => runner.workingCount() === 0);
        expect(counts).toHaveLength(1);
        expect(calls).toHaveLength(0);
        expect(message("t").translation).toBeUndefined();
        runner.resume();

        counts = [];
        const again = holdFirstCount();
        const second = runner.translate(req("t"));
        await until(() => counts.length === 1);
        runner.beginShutdown();
        expect(await second).toEqual({ ok: false, status: 503, error: "The server is shutting down" });
        expect(runner.workingCount()).toBe(1);
        again.resolve(1);
        await runner.drain();
        expect(runner.workingCount()).toBe(0);
        expect(counts).toHaveLength(1);
        expect(calls).toHaveLength(0);
        expect(message("t").translation).toBeUndefined();
    });

    it("a tokenizer failure is an unexpected failure: 500 with only the error name logged, nothing requested or written; the next run counts again", async () => {
        build();
        appendHistoryRows();
        useHistoryPreset(HISTORY_STEPS);
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});
        count = async () => {
            throw new Error("tokenizer exploded with details");
        };
        expect(await runner.translate(req("t"))).toEqual({ ok: false, status: 500, error: "The translation failed" });
        expect(logged).toHaveBeenCalledWith("[translate] unexpected failure:", "Error");
        expect(logged.mock.calls.flat().join(" ")).not.toContain("exploded");
        logged.mockRestore();
        expect(counts).toHaveLength(1);
        expect(calls).toHaveLength(0);
        expect(message("t").translation).toBeUndefined();
        expect(runner.runningCount()).toBe(0);
        expect(runner.workingCount()).toBe(0);

        count = async (text) => text.length;
        expect(await runner.translate(req("t"))).toMatchObject({ ok: true, outcome: "applied" });
        expect(counts).toHaveLength(5);
        expect(contents()[0]).toBe(`A[${HISTORY}] target`);
    });
});
