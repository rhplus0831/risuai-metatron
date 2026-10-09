// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GenerationTerminalEvent } from "../../../shared/jobs.ts";
import { createSigner, createTestServer, json, sleep } from "./testSupport.ts";

// Phase 5 slice 10: memory on the server, end to end. A send (and a preview) as a server job on a
// real listening server with the default runner, the production memory services, the vector cache
// file, a mock chat provider (summaries answered to the non-streamed `memory` requests, the reply
// streamed) and a mock embedding server (`hypaModel: "custom"`); no local model. The four
// algorithms with their persistence: HypaV3's summaries requested and stored before the main
// request and the memory card in the prompt, the vectors reused from the cache on a later send, a
// preview writing too, a partial failure keeping the summaries made, the WebLLM summarization
// model refused; HypaV2's chunks, and its repeated failure writing nothing; SupaMemory's
// `supaMemoryData` and `lastMemory` kept when the main provider then fails; Hanurai writing no
// memory field, its exhaustion the job's error also with `inlayErrorResponse`; the priority Hanurai,
// V2, V3, Supa among enabled flags; an unrelated metadata edit during a delayed summary kept; an
// abort during a summary with no later request, write, or cache row; a progress notice closed; the
// embedding key never in the job's error, events, chat, or log when the provider echoes it;
// `additionalInformations` in the description; a WebLLM model's `previewPrompt` answered without
// inference. The algorithms' outputs against the browser are `memoryAlgorithms.test.ts`'s.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SLOW = 60_000;
const EMBED_KEY = 'emb-KEY"quoted&url=1 x';

// The chat provider: a non-streamed request is a summary (the `memory` requests stream nothing),
// answered from `state.summaries` in order; a streamed one is the main request.
type Upstream = { body: any; summary: boolean; chatAtRequest?: any };
const upstream: Upstream[] = [];
const state = {
    summaries: [] as (string | { fail: string })[],
    summaryIndex: 0,
    /** Awaited before a summary is answered (a delayed summary). */
    holdSummary: null as null | (() => Promise<void>),
    mainStatus: 0,
    /** Called when the main request arrives (reads the stored chat at that moment). */
    onMain: null as null | (() => Promise<unknown>),
    embedMode: "ok" as "ok" | "leak",
};
const provider = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) {
        parts.push(chunk as Buffer);
    }
    const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
    const summary = body.stream !== true;
    const entry: Upstream = { body, summary };
    upstream.push(entry);
    if (summary) {
        if (state.holdSummary) {
            await state.holdSummary();
        }
        const answer =
            state.summaries[state.summaryIndex++] ??
            `Summary ${state.summaryIndex}: events happened.\n\nPart two of ${state.summaryIndex}.`;
        if (typeof answer !== "string") {
            // A failure stays: the request layer retries a failed request, and every retry must fail too.
            state.summaryIndex--;
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: answer.fail } }));
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer } }] }));
        return;
    }
    if (state.onMain) {
        entry.chatAtRequest = await state.onMain();
    }
    if (state.mainStatus) {
        res.writeHead(state.mainStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "main provider broke" } }));
        return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of ["Main ", "reply."]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
});

// The embedding server: a deterministic vector per text; a few named texts rank against `[1, 0]`.
const embedCalls: { input: string[]; auth?: string; model?: string }[] = [];
// Every other text gets `[1, x, y]` normalized with `x, y < 1`, so against it the named texts rank
// near, mid, low, far whatever the query.
const NAMED: Record<string, number[]> = { near: [0.9, 0.1, 0], mid: [0.5, 0.5, 0], low: [0.2, 0.8, 0], far: [0, 1, 0] };
const vectorOf = (text: string): number[] => {
    if (NAMED[text]) {
        return NAMED[text];
    }
    let h = 11;
    for (let i = 0; i < text.length; i++) {
        h = (h * 31 + text.charCodeAt(i)) % 100003;
    }
    const v = [1, (h % 97) / 97, ((h >> 3) % 89) / 89];
    const norm = Math.hypot(...v);
    return v.map((x) => x / norm);
};
const embedder = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) {
        parts.push(chunk as Buffer);
    }
    const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
    const input: string[] = Array.isArray(body.input) ? body.input : [body.input];
    embedCalls.push({ input, auth: req.headers.authorization, model: body.model });
    if (state.embedMode === "leak") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
            JSON.stringify({
                error: `bad key ${req.headers.authorization} / ${JSON.stringify(EMBED_KEY).slice(1, -1)} / ${encodeURIComponent(EMBED_KEY)}`,
            }),
        );
        return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: input.map((text) => ({ embedding: vectorOf(text) })) }));
});

let rootDir = "";
let server: ReturnType<typeof createTestServer>;
let node: http.Server;
let base = "";
let epoch = "";
let signer: Awaited<ReturnType<typeof createSigner>>;
let presetId = "";
let modelPresetId = "";
let profileId = "";
let personaId = "";
const logged: string[] = [];

async function api(url: string, init: RequestInit = {}) {
    const res = await fetch(`${base}${url}`, {
        ...init,
        headers: {
            "risu-auth": await signer.jwt(),
            "x-resource-epoch": epoch,
            "content-type": "application/json",
            ...((init.headers as Record<string, string>) ?? {}),
        },
    });
    let body: any = null;
    try {
        body = await res.json();
    } catch {}
    return { status: res.status, body };
}
const single = async (kind: string) => (await api(`/api/resources/${kind}/main`)).body;
const batch = (body: unknown) => api("/api/resources/batch", { method: "POST", body: JSON.stringify(body) });

/** The section homes of the settings used here. */
const SECTION_OF: Record<string, string> = {
    hypaV3: "memoryTranslateMedia",
    hypav2: "memoryTranslateMedia",
    hanuraiEnable: "memoryTranslateMedia",
    hypaMemory: "memoryTranslateMedia",
    supaModelType: "memoryTranslateMedia",
    hypaModel: "memoryTranslateMedia",
    hypaAllocatedTokens: "memoryTranslateMedia",
    hypaChunkSize: "memoryTranslateMedia",
    hanuraiTokens: "memoryTranslateMedia",
    hanuraiSplit: "memoryTranslateMedia",
    hypaCustomSettings: "secrets",
    useStreaming: "providers",
    inlayErrorResponse: "providers",
};
async function patchSettings(fields: Record<string, unknown>) {
    const bySection = new Map<string, Record<string, unknown>>();
    for (const [key, value] of Object.entries(fields)) {
        const section = SECTION_OF[key];
        expect(section, `the setting ${key} has a known section`).toBeDefined();
        bySection.set(section, { ...(bySection.get(section) ?? {}), [key]: value });
    }
    const ops: unknown[] = [];
    for (const [section, patch] of bySection) {
        const current = await single(section);
        ops.push({ kind: section, id: "main", baseRevision: current.revision, data: { ...current.data, ...patch } });
    }
    const res = await batch({ ops });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
}
/** Patches the selected prompt preset (`presets`), model preset (`modelPresets`), or its profile. */
async function patchPreset(kind: "presets" | "modelPresets" | "modelProfiles", patch: Record<string, unknown>) {
    const current = await single(kind);
    const target = kind === "presets" ? presetId : kind === "modelPresets" ? modelPresetId : profileId;
    const res = await batch({
        ops: [
            {
                kind,
                id: "main",
                baseRevision: current.revision,
                data: current.data.map((preset: any) => (preset.id === target ? { ...preset, ...patch } : preset)),
            },
        ],
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
}
/** Patches the selected HypaV3 preset's settings. */
async function patchHypaV3(settings: Record<string, unknown>) {
    const current = await single("hypaV3Presets");
    const data = current.data as { items: { id: string; settings: Record<string, unknown> }[]; selectedId: string };
    const res = await batch({
        ops: [
            {
                kind: "hypaV3Presets",
                id: "main",
                baseRevision: current.revision,
                data: {
                    ...data,
                    items: data.items.map((item) =>
                        item.id === data.selectedId ? { ...item, settings: { ...item.settings, ...settings } } : item,
                    ),
                },
            },
        ],
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
}
const defaultMemorySettings = {
    hypaV3: false,
    hypav2: false,
    hanuraiEnable: false,
    hypaMemory: false,
    supaModelType: "none",
    hypaModel: "custom",
    inlayErrorResponse: false,
};

const BLANK_CHARACTER = {
    exampleMessage: "",
    personality: "",
    scenario: "",
    bias: [],
    emotionImages: [],
    alternateGreetings: [],
    globalLore: [],
    systemPrompt: "",
    replaceGlobalNote: "",
    utilityBot: false,
    additionalAssets: [],
    viewScreen: "none",
    firstMessage: "Greetings.",
    desc: "Desc of {{char}}.",
    lowLevelAccess: false,
    supaMemory: true,
};
const longText = (i: number) =>
    `Message number ${i}: ` +
    `the party walked through the ${["forest", "desert", "city", "cave"][i % 4]} and talked at length about item ${i}. `.repeat(
        3,
    );

let seeded = 0;
/** A character with memory on and a chat `k` of `count` long messages (`m0..`), or the given messages. */
async function seedCharacter(
    options: { count?: number; messages?: Record<string, unknown>[]; extra?: Record<string, unknown> } = {},
) {
    const chaId = `mem-${++seeded}`;
    const messages =
        options.messages ??
        Array.from({ length: options.count ?? 24 }, (_, i) => ({
            role: i % 2 === 0 ? "user" : "char",
            data: longText(i),
            chatId: `m${i}`,
            ...(i % 2 === 1 ? { saying: chaId } : {}),
        }));
    const res = await batch({
        ops: [
            {
                kind: "characters",
                id: chaId,
                baseRevision: null,
                data: {
                    ...BLANK_CHARACTER,
                    chaId,
                    name: "Mira",
                    type: "character",
                    triggerscript: [],
                    customscript: [],
                    ...(options.extra ?? {}),
                },
            },
        ],
        chats: [
            {
                characterId: chaId,
                chatId: "k",
                baseRevision: null,
                ops: [{ op: "create", chat: { id: "k", name: "K", fmIndex: -1, message: messages } }],
            },
        ],
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return chaId;
}
const readChat = async (chaId: string) =>
    (
        await api("/api/resources/read", {
            method: "POST",
            body: JSON.stringify({ chats: [{ characterId: chaId, id: "k" }] }),
        })
    ).body.chats[0] as { revision: string; data: any };
async function setChatMeta(chaId: string, set: Record<string, unknown>) {
    const chat = await readChat(chaId);
    const res = await batch({
        chats: [{ characterId: chaId, chatId: "k", baseRevision: chat.revision, ops: [{ op: "meta", set }] }],
    });
    expect(res.status).toBe(200);
}
/** The vector cache file's row count, read directly. */
function cacheRows(): number {
    const db = new DatabaseSync(path.join(rootDir, "save", "data", "vectors.sqlite"), { readOnly: true });
    try {
        return Number((db.prepare("SELECT COUNT(*) AS n FROM vectors").get() as { n: number }).n);
    } finally {
        db.close();
    }
}

let attach = 0;
let currentJobId = "";
/** Creates a job and follows its owner socket to the terminal. */
async function job(
    kind: string,
    chaId: string,
    extra: Record<string, unknown> = {},
    options: { onEvent?: (event: any) => void } = {},
): Promise<{ status: number; body: any; events: any[]; terminal: GenerationTerminalEvent | undefined }> {
    const chat = await readChat(chaId);
    const created = await api("/api/generations", {
        method: "POST",
        body: JSON.stringify({
            kind,
            clientId: "tab",
            context: {
                characterId: chaId,
                chatId: "k",
                presetId,
                modelPresetId,
                personaId,
                selectedPersonaId: personaId,
                mode: kind,
                input: "",
                chatRevision: chat.revision,
                ...extra,
            },
        }),
    });
    if (created.status !== 200) {
        return { ...created, events: [], terminal: undefined };
    }
    currentJobId = created.body.jobId as string;
    const url =
        `${base.replace("http", "ws")}/api/generations/${currentJobId}/ws` +
        `?risu-auth=${encodeURIComponent(await signer.jwt())}&clientId=tab&attach=${++attach}`;
    const ws = new WebSocket(url);
    const events: any[] = [];
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 55_000);
        ws.onmessage = (message) => {
            const event = JSON.parse(String(message.data));
            if (event.type === "ping") {
                return;
            }
            events.push(event);
            options.onEvent?.(event);
            if (event.type === "done" || event.type === "error") {
                clearTimeout(timer);
                resolve();
            }
        };
    });
    ws.close();
    return { ...created, events, terminal: events.find((event) => event.type === "done" || event.type === "error") };
}
const summaries = () => upstream.filter((entry) => entry.summary);
const mains = () => upstream.filter((entry) => !entry.summary);
const memoryCard = (messages: any[]) =>
    messages.find((m) => typeof m.content === "string" && m.content.includes("<Past Events Summary>"));

beforeAll(async () => {
    const record = (...args: unknown[]) =>
        logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    vi.spyOn(console, "log").mockImplementation(record);
    vi.spyOn(console, "error").mockImplementation(record);
    vi.spyOn(console, "warn").mockImplementation(record);
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
    await new Promise<void>((resolve) => embedder.listen(0, "127.0.0.1", () => resolve()));
    const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1/chat/completions`;
    const embedderUrl = `http://127.0.0.1:${(embedder.address() as { port: number }).port}/v1`;
    rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-memory-jobs-"));
    mkdirSync(path.join(rootDir, "dist"));
    writeFileSync(path.join(rootDir, "dist", "index.html"), "<!doctype html><html><head></head><body></body></html>");
    symlinkSync(path.join(REPO_ROOT, "public"), path.join(rootDir, "public"), "dir");
    cpSync(path.join(REPO_ROOT, "version.json"), path.join(rootDir, "version.json"));
    mkdirSync(path.join(rootDir, "save", "server"), { recursive: true });
    writeFileSync(path.join(rootDir, "save", "server", "password"), "pw");
    server = createTestServer({ rootDir, generationRandom: () => 0.5 });
    node = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
    await new Promise<void>((resolve) => node.once("listening", () => resolve()));
    server.context.attachWebSocket(node);
    base = `http://127.0.0.1:${(node.address() as { port: number }).port}`;
    signer = await createSigner();
    await fetch(`${base}/api/login`, json({ password: "pw", publicKey: signer.publicJwk }));
    epoch = (
        (await (
            await fetch(`${base}/api/resources/ui`, { headers: { "risu-auth": await signer.jwt() } })
        ).json()) as any
    ).epoch;
    presetId = (await single("presets")).data[0].id;
    modelPresetId = (await single("modelPresets")).data[0].id;
    profileId = (await single("modelProfiles")).data[0].id;
    personaId = (await single("personas")).data[0].id;
    // The main and sub slots use one profile: a reverse proxy to the fake provider.
    await patchPreset("modelProfiles", {
        modelId: "reverse_proxy",
        maxContext: 900,
        forceReplaceUrl: providerUrl,
        customProxyRequestModel: "m",
        customTokenizer: "tik",
    });
    await patchPreset("modelPresets", { mainSlot: { profileId }, subSlot: { profileId } });
    await patchPreset("presets", {
        maxResponse: 100,
        mainPrompt: "Main prompt.",
        formatingOrder: ["main", "description", "chats", "lastChat"],
        jailbreakToggle: false,
    });
    await patchSettings({
        useStreaming: true,
        ...defaultMemorySettings,
        hypaCustomSettings: { url: embedderUrl, key: EMBED_KEY, model: "emb-model" },
    });
}, SLOW);

afterAll(async () => {
    await server?.close();
    node?.closeAllConnections();
    await new Promise((resolve) => node?.close(resolve));
    provider.closeAllConnections();
    provider.close();
    embedder.closeAllConnections();
    embedder.close();
    rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

afterEach(async () => {
    upstream.length = 0;
    embedCalls.length = 0;
    logged.length = 0;
    state.summaries = [];
    state.summaryIndex = 0;
    state.holdSummary = null;
    state.mainStatus = 0;
    state.onMain = null;
    state.embedMode = "ok";
    await patchSettings(defaultMemorySettings);
});

describe("HypaV3", () => {
    it(
        "requests the summaries without streaming, stores them before the main request, puts the memory card in the prompt, and reuses the vectors on the next send",
        async () => {
            await patchSettings({ hypaV3: true });
            // A small recent share leaves summaries for the similarity search (their chunks embedded).
            await patchHypaV3({ recentMemoryRatio: 0.1, similarMemoryRatio: 0.6 });
            const chaId = await seedCharacter();
            state.onMain = async () => (await readChat(chaId)).data.hypaV3Data;
            const first = await job("send", chaId, { input: "Hello V3", userMessageId: "u1" });
            expect(first.terminal?.type, JSON.stringify(first.terminal)).toBe("done");
            const made = summaries();
            expect(made.length).toBeGreaterThan(0);
            expect(made.every((entry) => entry.body.stream !== true && entry.body.model === "m")).toBe(true);
            expect(
                made.every((entry) => JSON.stringify(entry.body.messages).includes("Summarize the ongoing role story")),
            ).toBe(true);
            // The memory was stored before the provider got the main request.
            expect(mains()).toHaveLength(1);
            const atMain = mains()[0].chatAtRequest as { summaries: { text: string; chatMemos: string[] }[] };
            expect(atMain?.summaries?.length).toBe(made.length);
            const chat = await readChat(chaId);
            const data = chat.data.hypaV3Data as {
                summaries: { text: string; chatMemos: string[] }[];
                metrics: unknown;
            };
            expect(data.summaries.map((s) => s.text)).toEqual(
                made.map((_, i) => `Summary ${i + 1}: events happened.\n\nPart two of ${i + 1}.`),
            );
            // Each summary names the messages it covers (the greeting, without a memo, is among the first's as null).
            expect(data.summaries.every((s) => s.chatMemos.length > 0)).toBe(true);
            expect(data.summaries.flatMap((s) => s.chatMemos)).toEqual(expect.arrayContaining(["m0", "m1", "m2"]));
            expect(data.metrics).toBeDefined();
            // The main prompt: the card with the summaries, the summarized messages gone, the input kept.
            const prompt = mains()[0].body.messages as { role: string; content: string }[];
            const card = memoryCard(prompt);
            expect(card?.content).toContain("Summary 1: events happened.");
            expect(JSON.stringify(prompt)).not.toContain("Message number 0:");
            expect(JSON.stringify(prompt)).toContain("Hello V3");
            expect(chat.data.message.at(-1).data).toBe("Main reply.");
            // The embeddings: the summary chunks as documents with the settings' key and model, the recent chats as queries.
            const documentCalls = embedCalls.filter((call) =>
                call.input.some((text) => text.startsWith("Summary 1: events happened.")),
            );
            expect(documentCalls.length).toBeGreaterThan(0);
            expect(embedCalls.every((call) => call.auth === `Bearer ${EMBED_KEY}` && call.model === "emb-model")).toBe(
                true,
            );
            expect(cacheRows()).toBeGreaterThan(0);
            // The next send: the cached chunk vectors are not asked for again.
            upstream.length = 0;
            embedCalls.length = 0;
            const second = await job("send", chaId, { input: "Hello again", userMessageId: "u2" });
            expect(second.terminal?.type).toBe("done");
            expect(
                embedCalls.some((call) => call.input.some((text) => text.startsWith("Summary 1: events happened."))),
            ).toBe(false);
            expect(embedCalls.length).toBeGreaterThan(0);
            await patchHypaV3({ recentMemoryRatio: 0.4, similarMemoryRatio: 0.4 });
        },
        SLOW,
    );

    it(
        "a preview runs the memory step and stores the summaries too",
        async () => {
            await patchSettings({ hypaV3: true });
            const chaId = await seedCharacter();
            const { terminal } = await job("preview", chaId);
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            expect(summaries().length).toBeGreaterThan(0);
            expect(mains()).toHaveLength(0);
            const card = memoryCard((terminal as any).result);
            expect(card?.content).toContain("Summary 1: events happened.");
            expect((await readChat(chaId)).data.hypaV3Data.summaries).toHaveLength(summaries().length);
        },
        SLOW,
    );

    it(
        "a summary that fails after another succeeded ends the job with the error, keeps the summary made, and makes no main request",
        async () => {
            await patchSettings({ hypaV3: true });
            state.summaries = ["First landed.", { fail: "summary provider down" }];
            const chaId = await seedCharacter();
            const { terminal } = await job("send", chaId, { input: "Hello", userMessageId: "u1" });
            expect(terminal).toMatchObject({
                type: "error",
                message: expect.stringMatching(/\[HypaV3\] Summarization failed/),
            });
            // The first answered, the second failed through the request layer's retries.
            expect(summaries().length).toBeGreaterThanOrEqual(2);
            expect(mains()).toHaveLength(0);
            const chat = await readChat(chaId);
            expect(chat.data.hypaV3Data.summaries.map((s: any) => s.text)).toEqual(["First landed."]);
            // No reply, no user message write beyond the input stage.
            expect(chat.data.message.at(-1).data).toBe("Hello");
        },
        SLOW,
    );

    it(
        "refuses a WebLLM summarization model where a summary is needed, and serves a chat that needs none",
        async () => {
            await patchSettings({ hypaV3: true });
            await patchHypaV3({ summarizationModel: "Qwen3-0.6B-q4f16_1-MLC" });
            try {
                const needing = await seedCharacter();
                const refused = await job("send", needing, { input: "Hello", userMessageId: "u1" });
                expect(refused.terminal).toMatchObject({
                    type: "error",
                    message: expect.stringContaining("Local summarization models are unsupported on the server"),
                });
                expect(summaries()).toHaveLength(0);
                expect(mains()).toHaveLength(0);
                const fitting = await seedCharacter({ count: 2 });
                const served = await job("send", fitting, { input: "Hello", userMessageId: "u1" });
                expect(served.terminal?.type, JSON.stringify(served.terminal)).toBe("done");
                expect(memoryCard(mains()[0].body.messages)?.content).toContain(
                    "<Past Events Summary>\n\n</Past Events Summary>",
                );
            } finally {
                await patchHypaV3({ summarizationModel: "subModel" });
            }
        },
        SLOW,
    );

    it(
        "keeps an unrelated metadata edit made while a summary was delayed, and writes the memory beside it",
        async () => {
            await patchSettings({ hypaV3: true });
            const chaId = await seedCharacter();
            let release!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            let edited = false;
            state.holdSummary = async () => {
                if (!edited) {
                    edited = true;
                    await setChatMeta(chaId, { note: "edited during the summary" });
                    release();
                }
            };
            const { terminal } = await job("send", chaId, { input: "Hello", userMessageId: "u1" });
            await held;
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            const chat = await readChat(chaId);
            expect(chat.data.note).toBe("edited during the summary");
            expect(chat.data.hypaV3Data.summaries.length).toBeGreaterThan(0);
        },
        SLOW,
    );

    it(
        "an abort during a summary makes no later request, no memory write, and no cache row",
        async () => {
            await patchSettings({ hypaV3: true });
            const chaId = await seedCharacter();
            const rowsBefore = cacheRows();
            state.holdSummary = async () => {
                await api(`/api/generations/${currentJobId}?clientId=tab`, { method: "DELETE" });
                await sleep(200);
            };
            const { terminal } = await job("send", chaId, { input: "Hello", userMessageId: "u1" });
            expect(terminal?.type, JSON.stringify(terminal)).toBe("error");
            expect((terminal as any).message).toMatch(/abort/i);
            await sleep(300);
            expect(summaries()).toHaveLength(1);
            expect(mains()).toHaveLength(0);
            expect(embedCalls).toHaveLength(0);
            expect((await readChat(chaId)).data.hypaV3Data).toBeUndefined();
            expect(cacheRows()).toBe(rowsBefore);
        },
        SLOW,
    );

    it(
        "the experimental implementation sends progress notices and closes the last one",
        async () => {
            await patchSettings({ hypaV3: true });
            await patchHypaV3({ useExperimentalImpl: true, summarizationMaxConcurrent: 1, embeddingMaxConcurrent: 1 });
            try {
                const chaId = await seedCharacter();
                const { events, terminal } = await job("send", chaId, { input: "Hello exp", userMessageId: "u1" });
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                const progress = events.filter((event) => event.type === "notice" && event.kind === "progress");
                expect(progress.length).toBeGreaterThan(1);
                expect(progress.some((event) => event.payload.open === true)).toBe(true);
                expect(progress.at(-1).payload.open).toBe(false);
                expect((await readChat(chaId)).data.hypaV3Data.summaries.length).toBe(summaries().length);
            } finally {
                await patchHypaV3({ useExperimentalImpl: false });
            }
        },
        SLOW,
    );
});

describe("HypaV2, SupaMemory, Hanurai, and the priority", () => {
    it(
        "HypaV2 stores its chunks; three failed summaries end the job without any memory written",
        async () => {
            // V2's summaries go to the sub model only with `supaModelType: "subModel"` (else OpenAI completions).
            await patchSettings({
                hypav2: true,
                supaModelType: "subModel",
                hypaAllocatedTokens: 200,
                hypaChunkSize: 300,
            });
            const chaId = await seedCharacter();
            const { terminal } = await job("send", chaId, { input: "Hello V2", userMessageId: "u1" });
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            expect(summaries().length).toBeGreaterThan(0);
            const data = (await readChat(chaId)).data.hypaV2Data;
            expect(data.mainChunks.length).toBe(summaries().length);
            expect(data.mainChunks[0]).toMatchObject({
                id: 1,
                text: expect.stringContaining("Summary 1"),
                lastChatMemo: expect.stringMatching(/^m\d+$/),
            });
            expect(data.chunks.length).toBeGreaterThanOrEqual(data.mainChunks.length);
            upstream.length = 0;
            state.summaries = [{ fail: "down" }];
            state.summaryIndex = 0;
            const failing = await seedCharacter();
            const failed = await job("send", failing, { input: "Hello", userMessageId: "u1" });
            expect(failed.terminal).toMatchObject({ type: "error", message: expect.stringContaining("[HypaV2]") });
            expect(mains()).toHaveLength(0);
            expect((await readChat(failing)).data.hypaV2Data).toBeUndefined();
        },
        SLOW,
    );

    it(
        "SupaMemory stores supaMemoryData and lastMemory before the main request, and keeps them when the main provider fails",
        async () => {
            await patchSettings({ supaModelType: "subModel" });
            const chaId = await seedCharacter();
            state.mainStatus = 500;
            const { terminal } = await job("send", chaId, { input: "Hello Supa", userMessageId: "u1" });
            expect(terminal).toMatchObject({ type: "error", status: 500 });
            expect(summaries().length).toBeGreaterThan(0);
            // The failing main request is retried by the request layer; every attempt is after the write.
            expect(mains().length).toBeGreaterThanOrEqual(1);
            const chat = await readChat(chaId);
            expect(typeof chat.data.supaMemoryData).toBe("string");
            expect(chat.data.supaMemoryData).toContain("Summary 1: events happened.");
            expect(chat.data.supaMemoryData.split("\n")[0]).toBe(chat.data.lastMemory);
            expect(chat.data.lastMemory).toMatch(/^m\d+$/);
            // The card leads the prompt the provider got.
            expect(
                mains()[0].body.messages.some((m: any) => String(m.content).includes("Summary 1: events happened.")),
            ).toBe(true);
        },
        SLOW,
    );

    it(
        "Hanurai embeds the chat and writes no memory field; its exhaustion is the job's error, also with inlayErrorResponse",
        async () => {
            await patchSettings({ hanuraiEnable: true, hanuraiTokens: 200 });
            const chaId = await seedCharacter();
            const { terminal } = await job("send", chaId, { input: "Hello Hanurai", userMessageId: "u1" });
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            expect(summaries()).toHaveLength(0);
            expect(embedCalls.length).toBeGreaterThan(0);
            expect(embedCalls[0].input.every((text) => text.startsWith("search_document: "))).toBe(true);
            expect(embedCalls.some((call) => call.input[0].startsWith("search_query: "))).toBe(true);
            const chat = await readChat(chaId);
            for (const field of ["hypaV3Data", "hypaV2Data", "supaMemoryData", "lastMemory"]) {
                expect(chat.data[field], field).toBeUndefined();
            }
            expect(chat.data.message.at(-1).data).toBe("Main reply.");
            // Exhaustion: a token reservation no trim can satisfy.
            await patchSettings({ hanuraiTokens: 5000, inlayErrorResponse: true });
            upstream.length = 0;
            const other = await seedCharacter({ count: 4 });
            const exhausted = await job("send", other, { input: "Hello", userMessageId: "u1" });
            expect(exhausted.terminal).toMatchObject({
                type: "error",
                message: expect.stringContaining("The minimum required token is greater than the max context size."),
            });
            // Not written into the chat as a message (the browser alerts), and no main request.
            const after = await readChat(other);
            expect(after.data.message.map((m: any) => m.data)).toEqual([
                ...Array.from({ length: 4 }, (_, i) => longText(i)),
                "Hello",
            ]);
            expect(mains()).toHaveLength(0);
        },
        SLOW,
    );

    it(
        "runs Hanurai before V2 before V3 before Supa when several flags are on",
        async () => {
            await patchSettings({
                hanuraiEnable: true,
                hypav2: true,
                hypaV3: true,
                supaModelType: "subModel",
                hanuraiTokens: 200,
            });
            const hanurai = await seedCharacter();
            expect((await job("send", hanurai, { input: "Hi", userMessageId: "u1" })).terminal?.type).toBe("done");
            expect(summaries()).toHaveLength(0);
            const chat1 = (await readChat(hanurai)).data;
            expect([chat1.hypaV2Data, chat1.hypaV3Data, chat1.supaMemoryData]).toEqual([
                undefined,
                undefined,
                undefined,
            ]);
            await patchSettings({ hanuraiEnable: false });
            const v2 = await seedCharacter();
            expect((await job("send", v2, { input: "Hi", userMessageId: "u1" })).terminal?.type).toBe("done");
            const chat2 = (await readChat(v2)).data;
            expect(chat2.hypaV2Data).toBeDefined();
            expect([chat2.hypaV3Data, chat2.supaMemoryData]).toEqual([undefined, undefined]);
            await patchSettings({ hypav2: false });
            const v3 = await seedCharacter();
            expect((await job("send", v3, { input: "Hi", userMessageId: "u1" })).terminal?.type).toBe("done");
            const chat3 = (await readChat(v3)).data;
            expect(chat3.hypaV3Data).toBeDefined();
            expect([chat3.hypaV2Data, chat3.supaMemoryData]).toEqual([undefined, undefined]);
        },
        SLOW,
    );

    it(
        "a chat without supaMemory on its character runs no algorithm and trims instead",
        async () => {
            await patchSettings({ hypaV3: true });
            const chaId = await seedCharacter({ extra: { supaMemory: false } });
            const { terminal } = await job("send", chaId, { input: "Hi", userMessageId: "u1" });
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            expect(summaries()).toHaveLength(0);
            expect(embedCalls).toHaveLength(0);
            const chat = await readChat(chaId);
            expect(chat.data.hypaV3Data).toBeUndefined();
            expect(chat.data.lastMemory).toMatch(/^m\d+$/);
        },
        SLOW,
    );
});

describe("credentials and the other consumers", () => {
    it(
        "an embedding error that echoes the key leaves it out of the job's error, every event, the chat, and the server log",
        async () => {
            await patchSettings({ hanuraiEnable: true });
            state.embedMode = "leak";
            logged.length = 0;
            const chaId = await seedCharacter();
            const { events, terminal } = await job("send", chaId, { input: "Hello", userMessageId: "u1" });
            expect(terminal?.type).toBe("error");
            const forms = [EMBED_KEY, JSON.stringify(EMBED_KEY).slice(1, -1), encodeURIComponent(EMBED_KEY)];
            const everything = JSON.stringify(events) + JSON.stringify(await readChat(chaId)) + logged.join("\n");
            for (const form of forms) {
                expect(everything).not.toContain(form);
            }
            expect((terminal as any).message).toContain("[redacted]");
            expect(mains()).toHaveLength(0);
        },
        SLOW,
    );

    it(
        "additionalInformations adds the three paragraphs nearest to the first four messages to the description",
        async () => {
            const chaId = await seedCharacter({
                count: 6,
                extra: { supaMemory: false, additionalText: ["far", "low", "near", "mid"].join("\n\n") },
            });
            const { terminal } = await job("preview", chaId);
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            // The description follows the main prompt in the first system message.
            const first = ((terminal as any).result as { content: string }[])[0];
            expect(first.content).toBe("Main prompt.\n\nDesc of Mira.\n\nnear\n\nmid\n\nlow");
            // The paragraphs as documents, then the first four messages (each under its speaker) as the query.
            expect(embedCalls[0].input).toEqual(["far", "low", "near", "mid"]);
            // A message's `saying` is used as its speaker's name as it is (the client's rule), the persona names the user.
            const query = embedCalls[1].input[0];
            const persona = (await single("personas")).data[0].name;
            expect(query.split("\n\n").map((line) => line.split(":")[0])).toEqual([persona, chaId, persona, chaId]);
            expect(query).toContain(longText(0));
            expect(query).not.toContain(longText(4));
        },
        SLOW,
    );

    it(
        "answers a WebLLM model's previewPrompt without inference, as the browser does",
        async () => {
            await patchPreset("modelProfiles", { modelId: "hf:::Xenova/tiny-random-mistral" });
            try {
                const chaId = await seedCharacter({ count: 2, extra: { supaMemory: false } });
                const { terminal } = await job("previewPrompt", chaId);
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                expect(JSON.parse((terminal as any).result)).toEqual({
                    error: "Preview body is not supported for WebLLM",
                });
                expect(upstream).toHaveLength(0);
            } finally {
                await patchPreset("modelProfiles", { modelId: "reverse_proxy" });
            }
        },
        SLOW,
    );
});
