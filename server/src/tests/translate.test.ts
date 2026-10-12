// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
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
import {
    createTranslationRunner,
    MAX_RUNNING_TRANSLATIONS,
    TRANSLATION_DEADLINE_MS,
    type TranslateMessageRequest,
    type TranslationRunner,
} from "../translation/runner.ts";
import { createResourceTestClient, type ResourceTestClient, sleep, waitFor } from "./testSupport.ts";

// `docs/plan/translation.md` slice 1.3: the server translation runner (`server/src/translation/runner.ts`)
// and its route (`POST /api/translate/message`, `server/src/routes/translate.ts`).
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

    afterEach(async () => {
        jobRun = async () => {};
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
     * the unbound chat `loose` (`a`: "alpha", `b`: "beta").
     */
    async function seed(echo: { echoDelay?: number; echoMessage?: string } = {}) {
        client = await createResourceTestClient({ generationRunner });
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
    async function jobEnded(jobId: string) {
        const deadline = Date.now() + 2000;
        while ((await jobState(jobId)) === "running") {
            if (Date.now() > deadline) {
                throw new Error(`job ${jobId} still running`);
            }
            await sleep(10);
        }
    }
    /** A job that locks `messageId` and holds it until the returned `release` is called. */
    function lockingJob(messageId: string) {
        let locked!: () => void;
        let release!: () => void;
        const held = new Promise<void>((resolve) => (locked = resolve));
        const released = new Promise<void>((resolve) => (release = resolve));
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
        await seed({ echoDelay: 0.3 });
        const pending = translate(req("r"));
        await waitFor(() => runner().runningCount() === 1);
        await chatBatch("k", [{ op: "setText", id: "r", text: "edited" }]);
        expect(await pending).toMatchObject({ status: 200, body: { outcome: "ignored", translation: null } });
        const after = await message("r");
        expect(after.data).toBe("edited");
        expect(after.translation).toBeUndefined();
        expect(runner().workingCount()).toBe(0);
    });

    it("joins a run in flight (one run, the same result, whatever the joiner's force) after the joiner's ids pass the display binding and exist", async () => {
        await seed({ echoDelay: 0.3 });
        const first = translate(req("r"));
        await waitFor(() => runner().runningCount() === 1);
        const joiner = translate(req("r", { force: true }));
        // A joiner whose ids are not the bound chat's, and one naming a record that does not exist.
        expect(await translate(req("r", { modelPresetId: "other" }))).toMatchObject({
            status: 409,
            body: { error: "chatBindingMismatch" },
        });
        expect(runner().runningCount()).toBe(1);
        const results = await Promise.all([first, joiner]);
        expect(results[0].status).toBe(200);
        expect(results[0].body).toMatchObject({ outcome: "applied", translation: { text: "pong" } });
        expect(results[1].body).toEqual(results[0].body);
        expect(runner().runningCount()).toBe(0);

        // The unbound chat takes the sent ids: a joiner's must still name existing records.
        const loose = translate(req("a", {}, "loose"));
        await waitFor(() => runner().runningCount() === 1);
        expect(await translate(req("a", { personaId: "nope" }, "loose"))).toMatchObject({
            status: 404,
            body: { error: "The request's preset, model preset, or persona no longer exists" },
        });
        expect((await loose).body).toMatchObject({ outcome: "applied" });
        expect((await message("a", "loose")).translation?.text).toBe("pong");
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
        await patch("providers", { echoDelay: 0.3, echoMessage: "late" });
        await chatBatch("k", [{ op: "setTranslation", id: "u", translation: null }]);
        const pending = translate(req("u"));
        await waitFor(() => runner().runningCount() === 1);
        const second = lockingJob("u");
        const secondJob = await createJob();
        await second.held;
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
        await seed({ echoDelay: 0.3 });
        const pending = translate(req("r"));
        await waitFor(() => runner().runningCount() === 1);
        let inside: Awaited<ReturnType<typeof translate>> | undefined;
        await client.context.snapshots.withMaintenance(async () => {
            inside = await translate(req("u"));
        });
        const ended = await pending;
        expect(ended.status).toBe(503);
        expect(ended.body).toEqual({ error: "The server data is being replaced" });
        expect(ended.headers.get("retry-after")).toBe("5");
        expect(inside).toMatchObject({ status: 503, body: { error: "The server data is being replaced" } });
        expect(runner().runningCount()).toBe(0);
        // The Echo request was still sleeping; once it settles, nothing is stored.
        await waitFor(() => runner().workingCount() === 0, 2000);
        expect((await message("r")).translation).toBeUndefined();
        // Admission reopened with the maintenance's end.
        await patch("providers", { echoDelay: 0 });
        expect((await translate(req("r"))).body).toMatchObject({ outcome: "applied" });

        // The jobs' listener (registered after the runner's) aborts the running jobs and waits for
        // their end before the gate closes: translations are refused during that wait.
        let abortSeen!: () => void;
        let release!: () => void;
        const aborted = new Promise<void>((resolve) => (abortSeen = resolve));
        const released = new Promise<void>((resolve) => (release = resolve));
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
        await seed({ echoDelay: 0.3 });
        const pending = translate(req("r"));
        await waitFor(() => runner().runningCount() === 1);
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
        await client.context.dispose();
        expect(runner().workingCount()).toBe(0);
    });

    it("answers 502 with the request layer's failure text when the provider request fails", async () => {
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

    // `docs/plan/translation.md` slice 3.1: a step on a profile runs on that profile, not the slot.
    it("runs a step on a profile on that profile: a dead connection fails the run (502) where the slot's Echo answers, a deleted profile fails it by name, and nothing is stored", async () => {
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
        await seed({ echoDelay: 0.3 });
        const node = serve({ fetch: client.app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
        await new Promise<void>((resolve) => node.once("listening", () => resolve()));
        try {
            const { port } = node.address() as { port: number };
            const controller = new AbortController();
            const request = fetch(`http://127.0.0.1:${port}${TRANSLATE}`, {
                method: "POST",
                headers: await client.headers({ "content-type": "application/json" }),
                body: JSON.stringify(req("r")),
                signal: controller.signal,
            });
            await waitFor(() => runner().runningCount() === 1);
            controller.abort();
            await expect(request).rejects.toThrow();
            expect(runner().runningCount()).toBe(1);
            await waitFor(() => runner().runningCount() === 0, 2000);
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

    it("sends a profile step's profile as the request's profileId and an inheriting step's request without one, every step in translate mode (slice 3.1)", async () => {
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

    it("translates with the chat's own translator preset when it names one (docs/plan/translation.md slice 2.2), the global selection otherwise, and falls back to it for a deleted preset without rewriting the chat", async () => {
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
        patch("providers", { banCharacterset: ["Latin"] });
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

    // `docs/plan/translation.md` slice 2.3: a send's hand-off, and the chain behind a run of an older text.
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

    // `docs/plan/translation.md` slice 3.2: without Send Text As-Is (every preset from before the
    // option) the runner protects lines as the Fastify fork's server did (`translateProtectingLines`):
    // one pipeline run per part between the empty and asset lines, one after another, under the
    // message's one job id, controller, deadline, and write; with it, one run over the whole source,
    // the reply stored as it is. The automatic hand-off (slice 2.3) is the same run.
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
});
