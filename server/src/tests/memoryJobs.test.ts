// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serve } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type GenerationTerminalEvent,
    type MemoryChatRef,
    type MemoryTaskInput,
    type MemoryTaskService,
    type MemoryTaskStatus,
    NO_GENERATION_HOOKS,
} from "../../../shared/jobs.ts";
import { LLMFlags, LLMFormat, type LLMModel, LLMProvider, LLMTokenizer } from "../../../shared/llm.ts";
import { allowListenerOrigin, createSigner, createTestServer, json, sleep, waitFor } from "./testSupport.ts";
import { UNHURRIED_CBS, UNHURRIED_HYPAV3_SEPARATOR, UNHURRIED_SCRIPT_WORKERS } from "./unhurriedLimits.ts";

// Memory on the server, end to end. A send (and a preview) as a server job on a real listening
// server with the default runner, the production memory services, the vector cache file, a mock chat
// provider (summaries answered to the non-streamed `memory` requests, the reply streamed) and a mock
// embedding server (`hypaModel: "custom"`); no local model. The four algorithms with their
// persistence: HypaV3's summaries requested and stored before the main request and the memory card
// in the prompt, the vectors reused from the cache on a later send, a preview writing too, a partial
// failure keeping the summaries made, the WebLLM summarization model refused; HypaV2's chunks, and
// its repeated failure writing nothing; SupaMemory's `supaMemoryData` and `lastMemory` kept when the
// main provider then fails; Hanurai writing no memory field, its exhaustion the job's error also
// with `inlayErrorResponse`; the priority Hanurai, V2, V3, Supa among enabled flags; an unrelated
// metadata edit during a delayed summary kept; an abort during a summary with no later request,
// write, or cache row; a progress notice closed; the embedding key never in the job's error, events,
// chat, or log when the provider echoes it; `additionalInformations` in the description; a WebLLM
// model's `previewPrompt` answered without inference. The algorithms' outputs against the browser
// are `memoryAlgorithms.test.ts`'s. The first stack runs without a memory task service (every HypaV3
// step summarizes inside the job); a later block starts a second stack with a fake service for the
// select-only sends, the gap question, the initial runs with their stop control, the protected
// history tail, and the hand-offs; the last block starts a third stack with the server's own service
// (production): the task's summaries written after the job's terminal and selected by the next send,
// and a manual start through the route.

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
    /** The main replies' texts, in order (`Main reply.` once they run out). */
    mainTexts: null as null | string[],
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
    const mainText = state.mainTexts?.shift() ?? "Main reply.";
    for (const chunk of [mainText.slice(0, 5), mainText.slice(5)]) {
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

/** A listening test server with its own save directory, settings, and login. */
type Stack = {
    rootDir: string;
    server: ReturnType<typeof createTestServer>;
    node: http.Server;
    base: string;
    epoch: string;
    signer: Awaited<ReturnType<typeof createSigner>>;
    presetId: string;
    modelPresetId: string;
    profileId: string;
    personaId: string;
};
// The stack the helpers below talk to (`use`).
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
let providerUrl = "";
let embedderUrl = "";
const logged: string[] = [];

function use(stack: Stack) {
    ({ rootDir, server, node, base, epoch, signer, presetId, modelPresetId, profileId, personaId } = stack);
}

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
    autoContinueChat: "providers",
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
                ops: [
                    {
                        op: "create",
                        // Bound to the ids the jobs send: a job runs on its chat's binding.
                        chat: {
                            id: "k",
                            name: "K",
                            fmIndex: -1,
                            modelPresetId,
                            promptPresetId: presetId,
                            bindedPersona: personaId,
                            message: messages,
                        },
                    },
                ],
            },
        ],
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return chaId;
}
const readChat = async (chaId: string, chatId = "k") =>
    (
        await api("/api/resources/read", {
            method: "POST",
            body: JSON.stringify({ chats: [{ characterId: chaId, id: chatId }] }),
        })
    ).body.chats[0] as { revision: string; data: any };
const readCharacter = async (chaId: string) =>
    (await api(`/api/resources/characters/${chaId}`)).body as { revision: string; data: any };
/** A plain client write of the owner record (another tab's toggle). */
async function patchCharacter(chaId: string, patch: Record<string, unknown>) {
    const current = await readCharacter(chaId);
    const res = await batch({
        ops: [{ kind: "characters", id: chaId, baseRevision: current.revision, data: { ...current.data, ...patch } }],
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
}
/** Another chat of `chaId`, bound as `seedCharacter`'s, with `count` long messages. */
async function seedChat(chaId: string, chatId: string, count = 24) {
    const res = await batch({
        chats: [
            {
                characterId: chaId,
                chatId,
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: chatId,
                            name: chatId,
                            fmIndex: -1,
                            modelPresetId,
                            promptPresetId: presetId,
                            bindedPersona: personaId,
                            message: Array.from({ length: count }, (_, i) => ({
                                role: i % 2 === 0 ? "user" : "char",
                                data: longText(i),
                                chatId: `${chatId}-m${i}`,
                            })),
                        },
                    },
                ],
            },
        ],
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
}
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
/** An `answer` that sends nothing back (the question stays open). */
const NO_ANSWER = Symbol("no answer");
/**
 * Creates a job and follows its owner socket to the terminal. `extra.chatId` runs it on another
 * chat of the character; `answer` answers each `question` event with its value (`NO_ANSWER`: none);
 * `hooks` are the job's plugin hooks and `answerCallback` answers each `callback` event with the
 * answer message's fields.
 */
async function job(
    kind: string,
    chaId: string,
    extra: Record<string, unknown> = {},
    options: {
        onEvent?: (event: any) => void;
        answer?: (event: any) => unknown | Promise<unknown>;
        hooks?: Record<string, unknown>;
        answerCallback?: (event: any) => Record<string, unknown>;
    } = {},
): Promise<{ status: number; body: any; events: any[]; terminal: GenerationTerminalEvent | undefined }> {
    const chat = await readChat(chaId, (extra.chatId as string | undefined) ?? "k");
    const created = await api("/api/generations", {
        method: "POST",
        body: JSON.stringify({
            kind,
            clientId: "tab",
            ...(options.hooks ? { hooks: options.hooks } : {}),
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
        ws.onmessage = async (message) => {
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
            if (event.type === "question" && options.answer) {
                const value = await options.answer(event);
                if (value !== NO_ANSWER) {
                    ws.send(JSON.stringify({ type: "answer", id: event.id, outcome: "answered", value }));
                }
            }
            if (event.type === "callback" && options.answerCallback) {
                ws.send(JSON.stringify({ type: "answer", id: event.id, ...options.answerCallback(event) }));
            }
        };
    });
    ws.close();
    return { ...created, events, terminal: events.find((event) => event.type === "done" || event.type === "error") };
}
const summaries = () => upstream.filter((entry) => entry.summary);
const mains = () => upstream.filter((entry) => !entry.summary);
const questions = (events: any[]) => events.filter((event) => event.type === "question");
/** The `resource` events of the owner record `chaId`. */
const ownerRecords = (events: any[], chaId: string) =>
    events.filter((event) => event.type === "resource" && event.kind === "characters" && event.id === chaId);
const memoryCard = (messages: any[]) =>
    messages.find((m) => typeof m.content === "string" && m.content.includes("<Past Events Summary>"));

/**
 * Starts a stack, makes it the helpers' target, and gives it the settings every test here starts
 * from: the main and sub slots on one reverse-proxy profile to the fake provider, a 900-token
 * context, the fake embedding server, memory off.
 */
async function startStack(options: { memoryTasks?: "disabled" | MemoryTaskService } = {}): Promise<Stack> {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-memory-jobs-"));
    mkdirSync(path.join(dir, "dist"));
    writeFileSync(path.join(dir, "dist", "index.html"), "<!doctype html><html><head></head><body></body></html>");
    symlinkSync(path.join(REPO_ROOT, "public"), path.join(dir, "public"), "dir");
    cpSync(path.join(REPO_ROOT, "version.json"), path.join(dir, "version.json"));
    mkdirSync(path.join(dir, "save", "server"), { recursive: true });
    writeFileSync(path.join(dir, "save", "server", "password"), "pw");
    const started = createTestServer({
        rootDir: dir,
        generationRandom: () => 0.5,
        scriptWorkerOptions: UNHURRIED_SCRIPT_WORKERS,
        cbsTimeLimits: UNHURRIED_CBS,
        generationHypaV3SeparatorLimits: UNHURRIED_HYPAV3_SEPARATOR,
        ...(options.memoryTasks ? { memoryTasks: options.memoryTasks } : {}),
    });
    const listening = serve({ fetch: started.app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
    await new Promise<void>((resolve) => listening.once("listening", () => resolve()));
    allowListenerOrigin(listening);
    started.context.attachWebSocket(listening);
    const url = `http://127.0.0.1:${(listening.address() as { port: number }).port}`;
    const signing = await createSigner();
    await fetch(`${url}/api/login`, json({ password: "pw", publicKey: signing.publicJwk }));
    const stack: Stack = {
        rootDir: dir,
        server: started,
        node: listening,
        base: url,
        signer: signing,
        epoch: (
            (await (
                await fetch(`${url}/api/resources/ui`, { headers: { "risu-auth": await signing.jwt() } })
            ).json()) as any
        ).epoch,
        presetId: "",
        modelPresetId: "",
        profileId: "",
        personaId: "",
    };
    use(stack);
    stack.presetId = presetId = (await single("presets")).data[0].id;
    stack.modelPresetId = modelPresetId = (await single("modelPresets")).data[0].id;
    stack.profileId = profileId = (await single("modelProfiles")).data[0].id;
    stack.personaId = personaId = (await single("personas")).data[0].id;
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
    return stack;
}

async function closeStack(stack: Stack) {
    await stack.server.close();
    stack.node.closeAllConnections();
    await new Promise((resolve) => stack.node.close(resolve));
    rmSync(stack.rootDir, { recursive: true, force: true });
}

/** The stack without a memory task service: every HypaV3 step summarizes inside the job. */
let blockingStack: Stack;

beforeAll(async () => {
    const record = (...args: unknown[]) =>
        logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    vi.spyOn(console, "log").mockImplementation(record);
    vi.spyOn(console, "error").mockImplementation(record);
    vi.spyOn(console, "warn").mockImplementation(record);
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
    allowListenerOrigin(provider);
    await new Promise<void>((resolve) => embedder.listen(0, "127.0.0.1", () => resolve()));
    allowListenerOrigin(embedder);
    providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1/chat/completions`;
    embedderUrl = `http://127.0.0.1:${(embedder.address() as { port: number }).port}/v1`;
    blockingStack = await startStack({ memoryTasks: "disabled" });
}, SLOW);

afterAll(async () => {
    await closeStack(blockingStack);
    provider.closeAllConnections();
    provider.close();
    embedder.closeAllConnections();
    embedder.close();
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
    state.mainTexts = null;
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
            // The spy is restored after the job (the file's `afterAll` restores it if the job fails).
            const regexes = vi.spyOn(server.context.scriptWorkers, "regex");
            const first = await job("send", chaId, { input: "Hello V3", userMessageId: "u1" });
            const splits = regexes.mock.calls.filter(([op]) => op.op === "split");
            regexes.mockRestore();
            expect(first.terminal?.type, JSON.stringify(first.terminal)).toBe("done");
            const made = summaries();
            // The summaries the similarity search embeds (the recent share aside) were split on a
            // worker by the preset's separator, under the test server's separator limits (a production
            // split gets at most 1,000 ms), and their parts embedded apart.
            expect(splits.map(([op]) => op.input)).toContain("Summary 1: events happened.\n\nPart two of 1.");
            expect(
                splits.every(
                    ([op, opts]) => op.pattern === "\\n\\n" && op.flags === "" && (opts?.deadlineMs ?? 0) > 1000,
                ),
            ).toBe(true);
            expect(embedCalls.flatMap((call) => call.input)).toEqual(
                expect.arrayContaining(["Summary 1: events happened.", "Part two of 1."]),
            );
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

    // The job's `hypaV3Data` write is placed onto the value stored at the write (`mergeHypaV3Write`),
    // not written over it.
    const seeded = { text: "Seeded summary.", chatMemos: ["m0", "m1"], isImportant: false };
    const edited = { ...seeded, text: "Seeded summary, edited meanwhile.", isImportant: true, tags: ["mine"] };
    /** Seeds `hypaV3Data` with one summary and edits it (or `set`s another value) at the first summary request. */
    async function seedAndEditDuringSummary(set: Record<string, unknown> = { summaries: [edited] }) {
        const chaId = await seedCharacter();
        await setChatMeta(chaId, { hypaV3Data: { summaries: [seeded], categories: [{ id: "c1", name: "Mine" }] } });
        let done = false;
        state.holdSummary = async () => {
            if (!done) {
                done = true;
                await setChatMeta(chaId, { hypaV3Data: { ...set, categories: [{ id: "c1", name: "Mine" }] } });
            }
        };
        return chaId;
    }
    const skipped = () => logged.some((line) => line.includes("[HypaV3] The memory data changed during the summary"));

    it.each([
        ["standard", false],
        ["experimental", true],
    ])(
        "%s: a summary edit saved during the summarization await survives the job's write, and the job's new summaries survive the edit",
        async (_mode, useExperimentalImpl) => {
            await patchSettings({ hypaV3: true });
            await patchHypaV3({ useExperimentalImpl, summarizationMaxConcurrent: 1, embeddingMaxConcurrent: 1 });
            try {
                const chaId = await seedAndEditDuringSummary();
                const { terminal } = await job("send", chaId, { input: "Hello", userMessageId: "u1" });
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                expect(summaries().length).toBeGreaterThan(0);
                const data = (await readChat(chaId)).data.hypaV3Data as {
                    summaries: { text: string; chatMemos: string[]; isImportant: boolean; tags?: string[] }[];
                    categories: unknown;
                    metrics?: Record<string, number[]>;
                };
                // The edit as saved, the job's summaries after it, none covering the seeded messages again.
                expect(data.summaries[0]).toEqual(edited);
                expect(data.summaries.length).toBe(1 + summaries().length);
                expect(data.summaries.slice(1).map((s) => s.text)).toEqual(
                    summaries().map((_, i) => `Summary ${i + 1}: events happened.\n\nPart two of ${i + 1}.`),
                );
                expect(data.summaries.slice(1).flatMap((s) => s.chatMemos)).not.toEqual(expect.arrayContaining(["m0"]));
                expect(data.categories).toEqual([{ id: "c1", name: "Mine" }]);
                // The run selected from the merged list: every index resolves.
                expect(data.metrics).toBeDefined();
                const indices = Object.values(data.metrics!).flat();
                expect(indices.length).toBeGreaterThan(0);
                expect(indices.every((index) => index >= 0 && index < data.summaries.length)).toBe(true);
                expect(skipped()).toBe(false);
                // The merge is of the write only: the prompt carried the algorithm's own memory card.
                expect(memoryCard(mains()[0].body.messages)).toBeDefined();
            } finally {
                await patchHypaV3({ useExperimentalImpl: false });
            }
        },
        SLOW,
    );

    it(
        "a summary saved at its checkpoint is placed onto the edit saved meanwhile, and the failure of the next summary keeps it",
        async () => {
            await patchSettings({ hypaV3: true });
            state.summaries = ["First landed.", { fail: "summary provider down" }];
            const chaId = await seedAndEditDuringSummary();
            const { terminal } = await job("send", chaId, { input: "Hello", userMessageId: "u1" });
            expect(terminal).toMatchObject({ type: "error", message: expect.stringMatching(/Summarization failed/) });
            const data = (await readChat(chaId)).data.hypaV3Data;
            expect(data.summaries.map((s: any) => s.text)).toEqual([edited.text, "First landed."]);
            expect(data.summaries[0]).toEqual(edited);
            expect(data.categories).toEqual([{ id: "c1", name: "Mine" }]);
            expect(skipped()).toBe(false);
        },
        SLOW,
    );

    it(
        "a reset saved during the summarization await skips the job's write: the stored value stands and the send goes on",
        async () => {
            await patchSettings({ hypaV3: true });
            const chaId = await seedAndEditDuringSummary({ summaries: [] });
            const { terminal } = await job("send", chaId, { input: "Hello", userMessageId: "u1" });
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            expect(summaries().length).toBeGreaterThan(0);
            expect(mains()).toHaveLength(1);
            expect((await readChat(chaId)).data.hypaV3Data).toEqual({
                summaries: [],
                categories: [{ id: "c1", name: "Mine" }],
            });
            expect(skipped()).toBe(true);
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
            // The memory layer answers its failure as text: the error is the assembly's, naming no
            // request.
            expect((failed.terminal as any).stage).toBe("assembly");
            expect("requestId" in failed.terminal!).toBe(false);
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
            // The main request's failure names the request stage and the request.
            expect(terminal).toMatchObject({
                stage: "request",
                requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
            });
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
        "a chat without supaMemory on its character runs no algorithm and trims instead, once the trim question is answered 'once'",
        async () => {
            await patchSettings({ hypaV3: true });
            const chaId = await seedCharacter({ extra: { supaMemory: false } });
            const { events, terminal } = await job(
                "send",
                chaId,
                { input: "Hi", userMessageId: "u1" },
                { answer: () => "once" },
            );
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            // One question, with no text of its own (the tab localizes it).
            expect(questions(events)).toEqual([expect.objectContaining({ kind: "memoryTrim", payload: {} })]);
            expect(summaries()).toHaveLength(0);
            expect(embedCalls).toHaveLength(0);
            const chat = await readChat(chaId);
            expect(chat.data.hypaV3Data).toBeUndefined();
            expect(chat.data.lastMemory).toMatch(/^m\d+$/);
            // "Once" records nothing: neither on the chat nor on the character.
            expect(chat.data.memoryTrimAck).toBeUndefined();
            const owner = (await readCharacter(chaId)).data;
            expect([owner.supaMemory, owner.supaMemoryOnCount]).toEqual([false, undefined]);
            expect(ownerRecords(events, chaId)).toHaveLength(0);
            // The next over-budget send asks again.
            const again = await job(
                "send",
                chaId,
                { input: "Hi again", userMessageId: "u2" },
                { answer: () => "once" },
            );
            expect(again.terminal?.type, JSON.stringify(again.terminal)).toBe("done");
            expect(questions(again.events)).toHaveLength(1);
            expect(summaries()).toHaveLength(0);
        },
        SLOW,
    );
});

// The no-memory trim question (`docs/structure/memory.md`, "The no-memory trim question"): a memory
// method is set, the owner's toggle is off, and the trim would drop chat history. The three answers
// through the owner socket; the per-chat "don't ask again" against the owner's `supaMemoryOnCount`
// and its invalidation by a later turn-on; the owner read when the answer is applied (a toggle
// another tab made while the question waited); a group's one question for both speakers; a
// preview and an overflow the example dialogue absorbs ask nothing; an invalid answer and an abort
// while waiting end the job without a trim or a preference written.
describe("the no-memory trim question", () => {
    it(
        "'memory' turns the owner's toggle on (counting the transition), emits the record, runs memory in the same send, and is not asked again",
        async () => {
            const ws = new WebSocket(
                `${base.replace("http", "ws")}/api/events/ws?risu-auth=${encodeURIComponent(await signer.jwt())}`,
            );
            const frames: any[] = [];
            ws.onmessage = (message) => frames.push(JSON.parse(String(message.data)));
            try {
                await new Promise<void>((resolve, reject) => {
                    ws.onopen = () => resolve();
                    ws.onerror = () => reject(new Error("feed socket failed"));
                });
                await waitFor(() => frames.some((frame) => frame.type === "hello"));
                await patchSettings({ hypaV3: true });
                const chaId = await seedCharacter({ extra: { supaMemory: false } });
                let patchBase = "";
                const { events, terminal } = await job(
                    "send",
                    chaId,
                    { input: "Hello V3", userMessageId: "u1" },
                    {
                        answer: async () => {
                            patchBase = (await readCharacter(chaId)).revision;
                            return "memory";
                        },
                    },
                );
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                expect(questions(events)).toHaveLength(1);
                // The owner: on, its first off→on transition counted, the record sent to the tab.
                const owner = (await readCharacter(chaId)).data;
                expect([owner.supaMemory, owner.supaMemoryOnCount]).toEqual([true, 1]);
                expect(ownerRecords(events, chaId).map((event) => event.data.supaMemory)).toEqual([true]);
                const memoryPatches = () =>
                    frames
                        .filter((frame) => frame.type === "change")
                        .flatMap((frame) => frame.changes.resources)
                        .filter(
                            (ref) =>
                                ref.kind === "characters" && ref.id === chaId && ref.patch?.set?.supaMemory === true,
                        );
                await waitFor(() => memoryPatches().length > 0);
                expect(memoryPatches()).toHaveLength(1);
                expect(memoryPatches()[0].patch).toEqual({
                    baseRevision: patchBase,
                    set: { supaMemory: true, supaMemoryOnCount: 1 },
                    remove: [],
                });
                // Memory ran in this send: the summaries, the card in the main request, the data stored.
                expect(summaries().length).toBeGreaterThan(0);
                expect(mains()).toHaveLength(1);
                expect(memoryCard(mains()[0].body.messages)?.content).toContain("Summary 1: events happened.");
                const chat = await readChat(chaId);
                expect(chat.data.hypaV3Data.summaries.length).toBe(summaries().length);
                expect(chat.data.memoryTrimAck).toBeUndefined();
                // The next send finds the owner on: no question, memory again.
                upstream.length = 0;
                const next = await job(
                    "send",
                    chaId,
                    { input: "Hello again", userMessageId: "u2" },
                    { answer: () => "once" },
                );
                expect(next.terminal?.type, JSON.stringify(next.terminal)).toBe("done");
                expect(questions(next.events)).toHaveLength(0);
                expect(memoryCard(mains()[0].body.messages)).toBeDefined();
            } finally {
                ws.close();
            }
        },
        SLOW,
    );

    it(
        "'ignore' trims, records the owner's count on the chat only, and is void once the toggle is turned on again",
        async () => {
            await patchSettings({ hypaV3: true });
            const chaId = await seedCharacter({ extra: { supaMemory: false } });
            const first = await job("send", chaId, { input: "Hi", userMessageId: "u1" }, { answer: () => "ignore" });
            expect(first.terminal?.type, JSON.stringify(first.terminal)).toBe("done");
            expect(questions(first.events)).toHaveLength(1);
            expect(summaries()).toHaveLength(0);
            let chat = await readChat(chaId);
            expect(chat.data.memoryTrimAck).toBe(0);
            expect(chat.data.lastMemory).toMatch(/^m\d+$/);
            expect(chat.data.hypaV3Data).toBeUndefined();
            const owner = (await readCharacter(chaId)).data;
            expect([owner.supaMemory, owner.supaMemoryOnCount]).toEqual([false, undefined]);
            // The next over-budget send of this chat trims without asking.
            const second = await job("send", chaId, { input: "Hi 2", userMessageId: "u2" }, { answer: () => "memory" });
            expect(second.terminal?.type, JSON.stringify(second.terminal)).toBe("done");
            expect(questions(second.events)).toHaveLength(0);
            expect(summaries()).toHaveLength(0);
            expect((await readCharacter(chaId)).data.supaMemory).toBe(false);
            // Another chat of the same owner has no acknowledgment: it is asked.
            await seedChat(chaId, "k2");
            const other = await job(
                "send",
                chaId,
                { chatId: "k2", input: "Hi other", userMessageId: "u3" },
                { answer: () => "once" },
            );
            expect(other.terminal?.type, JSON.stringify(other.terminal)).toBe("done");
            expect(questions(other.events)).toHaveLength(1);
            expect((await readChat(chaId, "k2")).data.memoryTrimAck).toBeUndefined();
            // The toggle turned on (the tab counts it) and off again: the acknowledgment is void.
            await patchCharacter(chaId, { supaMemory: true, supaMemoryOnCount: 1 });
            await patchCharacter(chaId, { supaMemory: false });
            const third = await job("send", chaId, { input: "Hi 3", userMessageId: "u4" }, { answer: () => "ignore" });
            expect(third.terminal?.type, JSON.stringify(third.terminal)).toBe("done");
            expect(questions(third.events)).toHaveLength(1);
            chat = await readChat(chaId);
            expect(chat.data.memoryTrimAck).toBe(1);
            expect(summaries()).toHaveLength(0);
            const fourth = await job("send", chaId, { input: "Hi 4", userMessageId: "u5" }, { answer: () => "once" });
            expect(fourth.terminal?.type, JSON.stringify(fourth.terminal)).toBe("done");
            expect(questions(fourth.events)).toHaveLength(0);
        },
        SLOW,
    );

    it(
        "a toggle another tab makes while the question waits is read when the answer is applied",
        async () => {
            await patchSettings({ hypaV3: true });
            // Turned on meanwhile (count 5): "memory" keeps that count (no second transition) and runs memory.
            const turnedOn = await seedCharacter({ extra: { supaMemory: false } });
            const onMeanwhile = await job(
                "send",
                turnedOn,
                { input: "Hi", userMessageId: "u1" },
                {
                    answer: async () => {
                        await patchCharacter(turnedOn, { supaMemory: true, supaMemoryOnCount: 5 });
                        return "memory";
                    },
                },
            );
            expect(onMeanwhile.terminal?.type, JSON.stringify(onMeanwhile.terminal)).toBe("done");
            expect(questions(onMeanwhile.events)).toHaveLength(1);
            const owner = (await readCharacter(turnedOn)).data;
            expect([owner.supaMemory, owner.supaMemoryOnCount]).toEqual([true, 5]);
            expect(summaries().length).toBeGreaterThan(0);
            expect((await readChat(turnedOn)).data.hypaV3Data).toBeDefined();
            // Cycled meanwhile (on with count 5, then off): "ignore" records the count of that moment, not the one before the question.
            upstream.length = 0;
            embedCalls.length = 0;
            const cycled = await seedCharacter({ extra: { supaMemory: false } });
            const offAgain = await job(
                "send",
                cycled,
                { input: "Hi", userMessageId: "u1" },
                {
                    answer: async () => {
                        await patchCharacter(cycled, { supaMemory: true, supaMemoryOnCount: 5 });
                        await patchCharacter(cycled, { supaMemory: false });
                        return "ignore";
                    },
                },
            );
            expect(offAgain.terminal?.type, JSON.stringify(offAgain.terminal)).toBe("done");
            expect(summaries()).toHaveLength(0);
            expect((await readChat(cycled)).data.memoryTrimAck).toBe(5);
            expect((await readCharacter(cycled)).data.supaMemoryOnCount).toBe(5);
            const next = await job("send", cycled, { input: "Hi 2", userMessageId: "u2" }, { answer: () => "memory" });
            expect(next.terminal?.type, JSON.stringify(next.terminal)).toBe("done");
            expect(questions(next.events)).toHaveLength(0);
            expect(summaries()).toHaveLength(0);
        },
        SLOW,
    );

    it(
        "a group send asks once for both speakers, and 'memory' turns the group's toggle on",
        async () => {
            await patchSettings({ hypaV3: true });
            const bob = await seedCharacter({ count: 0, extra: { name: "Bob" } });
            const cid = await seedCharacter({ count: 0, extra: { name: "Cid" } });
            const groupOf = (name: string) =>
                seedCharacter({
                    messages: Array.from({ length: 24 }, (_, i) => ({
                        role: i % 2 === 0 ? "user" : "char",
                        data: longText(i),
                        chatId: `m${i}`,
                        ...(i % 2 === 1 ? { saying: i % 4 === 1 ? bob : cid } : {}),
                    })),
                    extra: {
                        name,
                        type: "group",
                        supaMemory: false,
                        characters: [bob, cid],
                        characterTalks: [1, 1],
                        characterActive: [true, true],
                        orderByOrder: true,
                        firstMessage: "",
                        desc: "",
                    },
                });
            const once = await groupOf("Once");
            const trimmed = await job(
                "group",
                once,
                { input: "hello all", userMessageId: "u1" },
                { answer: () => "once" },
            );
            expect(trimmed.terminal?.type, JSON.stringify(trimmed.terminal)).toBe("done");
            expect(questions(trimmed.events)).toHaveLength(1);
            expect(mains()).toHaveLength(2);
            expect(summaries()).toHaveLength(0);
            expect((await readChat(once)).data.message.slice(-2).map((m: any) => m.saying)).toEqual([bob, cid]);
            expect((await readCharacter(once)).data.supaMemory).toBe(false);
            upstream.length = 0;
            const memory = await groupOf("Memory");
            const enabled = await job(
                "group",
                memory,
                { input: "hello all", userMessageId: "u1" },
                { answer: () => "memory" },
            );
            expect(enabled.terminal?.type, JSON.stringify(enabled.terminal)).toBe("done");
            expect(questions(enabled.events)).toHaveLength(1);
            const group = (await readCharacter(memory)).data;
            expect([group.type, group.supaMemory, group.supaMemoryOnCount]).toEqual(["group", true, 1]);
            expect(ownerRecords(enabled.events, memory)).toHaveLength(1);
            expect(mains()).toHaveLength(2);
            expect(summaries().length).toBeGreaterThan(0);
            // Both speakers' requests carried the memory card; neither member's own toggle was touched.
            expect(mains().every((entry) => memoryCard(entry.body.messages) !== undefined)).toBe(true);
            expect((await readCharacter(bob)).data.supaMemoryOnCount).toBeUndefined();
        },
        SLOW,
    );

    it(
        "a preview trims without asking, and an overflow the example dialogue absorbs asks nothing",
        async () => {
            await patchSettings({ hypaV3: true });
            const chaId = await seedCharacter({ extra: { supaMemory: false } });
            const preview = await job("preview", chaId, {}, { answer: () => "memory" });
            expect(preview.terminal?.type, JSON.stringify(preview.terminal)).toBe("done");
            expect(questions(preview.events)).toHaveLength(0);
            expect(summaries()).toHaveLength(0);
            const result = (preview.terminal as any).result as { content: string }[];
            expect(JSON.stringify(result)).not.toContain("Message number 0:");
            expect(memoryCard(result)).toBeUndefined();
            expect((await readCharacter(chaId)).data.supaMemory).toBe(false);
            expect((await readChat(chaId)).data.memoryTrimAck).toBeUndefined();
            // Two short stored messages after a long example dialogue: the trim drops only examples.
            const exampleMessage = Array.from({ length: 6 }, (_, i) =>
                ["<START>", `{{user}}: ${longText(100 + 2 * i)}`, `{{char}}: ${longText(101 + 2 * i)}`].join("\n"),
            ).join("\n");
            const examples = await seedCharacter({ count: 2, extra: { supaMemory: false, exampleMessage } });
            const sent = await job("send", examples, { input: "Hi", userMessageId: "u1" }, { answer: () => "memory" });
            expect(sent.terminal?.type, JSON.stringify(sent.terminal)).toBe("done");
            expect(questions(sent.events)).toHaveLength(0);
            expect(summaries()).toHaveLength(0);
            const prompt = JSON.stringify(mains().at(-1)!.body.messages);
            // The history stayed whole (the greeting and both stored messages); the first example did not.
            expect(prompt).toContain("Greetings.");
            expect(prompt).toContain("Message number 0:");
            expect(prompt).toContain("Message number 1:");
            expect(prompt).not.toContain("Message number 100:");
            expect((await readCharacter(examples)).data.supaMemory).toBe(false);
        },
        SLOW,
    );

    it(
        "an invalid answer, and an abort while the question waits, end the job with nothing trimmed or recorded",
        async () => {
            await patchSettings({ hypaV3: true });
            const invalid = await seedCharacter({ extra: { supaMemory: false } });
            const refused = await job("send", invalid, { input: "Hi", userMessageId: "u1" }, { answer: () => "nope" });
            expect(refused.terminal).toMatchObject({
                type: "error",
                message: expect.stringContaining("The memory question got no valid answer: nope"),
            });
            expect(questions(refused.events)).toHaveLength(1);
            expect(mains()).toHaveLength(0);
            expect(summaries()).toHaveLength(0);
            let chat = await readChat(invalid);
            expect([chat.data.lastMemory, chat.data.memoryTrimAck]).toEqual([undefined, undefined]);
            // The user message of the input stage stays; the error is the job's, never a chat message.
            expect(chat.data.message.at(-1).data).toBe("Hi");
            expect((await readCharacter(invalid)).data.supaMemory).toBe(false);
            const aborted = await seedCharacter({ extra: { supaMemory: false } });
            const cancelled = await job(
                "send",
                aborted,
                { input: "Hi", userMessageId: "u1" },
                {
                    answer: async () => {
                        await api(`/api/generations/${currentJobId}?clientId=tab`, { method: "DELETE" });
                        return NO_ANSWER;
                    },
                },
            );
            expect(cancelled.terminal?.type, JSON.stringify(cancelled.terminal)).toBe("error");
            expect((cancelled.terminal as any).message).toMatch(/abort/i);
            expect(questions(cancelled.events)).toHaveLength(1);
            await sleep(300);
            expect(mains()).toHaveLength(0);
            chat = await readChat(aborted);
            expect([chat.data.lastMemory, chat.data.memoryTrimAck]).toEqual([undefined, undefined]);
            expect((await readCharacter(aborted)).data.supaMemory).toBe(false);
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

// A memory task service makes a send select from the stored summaries instead of summarizing
// (`docs/structure/chat-pipeline.md`, the job's HypaV3 step): the dispatch (previews and server-slot
// sends select only; a Plugin `memory` slot and a request trigger keep the summaries in the job), the
// `memoryProgress` runs before any legacy progress of the same work, the gap question and its
// answers, the approved initial run with its per-summary saves, the retryable error of an edit, the
// abort and the stop control, the protected history tail at the final re-check, and the hand-off
// with its source-generation check. The service is a fake: hand-offs and leases recorded, the status
// and `pendingManual` set by the test.
function createFakeMemoryTasks() {
    const handOffs: MemoryTaskInput[] = [];
    const leases: { chatRef: MemoryChatRef; ownerId: string; released: boolean }[] = [];
    let status: MemoryTaskStatus | null = null;
    let manual = false;
    const service = {
        handOff(input: MemoryTaskInput) {
            handOffs.push(input);
        },
        status() {
            return status;
        },
        acquireSummaryWriter(chatRef: MemoryChatRef, ownerId: string) {
            const lease = { chatRef, ownerId, released: false };
            leases.push(lease);
            return Promise.resolve({
                release: () => {
                    lease.released = true;
                },
            });
        },
        pendingManual() {
            return manual;
        },
    } satisfies MemoryTaskService;
    return {
        service,
        handOffs,
        leases,
        setStatus(value: MemoryTaskStatus | null) {
            status = value;
        },
        setPendingManual(value: boolean) {
            manual = value;
        },
        reset() {
            handOffs.length = 0;
            leases.length = 0;
            status = null;
            manual = false;
        },
    };
}

describe("HypaV3 with a memory task service", () => {
    const fake = createFakeMemoryTasks();
    let tasksStack: Stack;
    /** A `request` trigger with a request effect: the owner's summaries stay in the job. */
    const REQUEST_TRIGGER = {
        comment: "request",
        type: "request",
        conditions: [],
        effect: [{ type: "v2SetVar", indent: 0, var: "seen", operator: "=", value: "1", valueType: "value" }],
        lowLevelAccess: true,
    };
    const luaTrigger = (code: string) => ({
        comment: "lua",
        type: "manual",
        conditions: [],
        effect: [{ type: "triggerlua", indent: 0, code }],
        lowLevelAccess: true,
    });
    /** The provider descriptor the tab registers for the job's plugin provider `prov`. */
    const PLUGIN_DESCRIPTOR: LLMModel = {
        id: "pluginmodel:::prov",
        name: "prov",
        shortName: "prov",
        fullName: "prov",
        internalID: "pluginmodel:::prov",
        provider: LLMProvider.AsIs,
        format: LLMFormat.Plugin,
        flags: [LLMFlags.hasFullSystemPrompt],
        parameters: ["temperature"],
        tokenizer: LLMTokenizer.Unknown,
    };
    const PLUGIN_HOOKS = { ...NO_GENERATION_HOOKS, providers: [{ name: "prov", model: PLUGIN_DESCRIPTOR }] };
    const PLUGIN_PROFILE_ID = "plugin-memory";
    const seededSummary = { text: "Seeded summary of the first steps.", chatMemos: ["m0", "m1"], isImportant: false };

    const memoryNotices = (events: any[]) =>
        events.filter((event) => event.type === "notice" && event.kind === "memoryProgress").map((e) => e.payload);
    const legacyNotices = (events: any[]) =>
        events.filter((event) => event.type === "notice" && event.kind === "progress").map((e) => e.payload);
    /** Every legacy `progress` open notice falls inside a `memoryProgress` run (opened before, closed after). */
    function expectRunsToCoverLegacyProgress(events: any[]) {
        const runs = new Map<string, { openAt: number; closeAt: number }>();
        events.forEach((event, index) => {
            if (event.type !== "notice" || event.kind !== "memoryProgress") {
                return;
            }
            const run = runs.get(event.payload.runId) ?? { openAt: Number.POSITIVE_INFINITY, closeAt: -1 };
            if (event.payload.open) {
                run.openAt = Math.min(run.openAt, index);
            } else {
                run.closeAt = index;
            }
            runs.set(event.payload.runId, run);
        });
        const legacyOpens = events
            .map((event, index) => ({ event, index }))
            .filter(({ event }) => event.type === "notice" && event.kind === "progress" && event.payload.open === true);
        expect(legacyOpens.length).toBeGreaterThan(0);
        for (const { event, index } of legacyOpens) {
            const covered = [...runs.values()].some((run) => run.openAt < index && run.closeAt > index);
            expect(
                covered,
                `legacy progress at event ${index} (${event.payload.msg}) inside a memoryProgress run`,
            ).toBe(true);
        }
        for (const [runId, run] of runs) {
            expect(run.openAt, `${runId} opened`).toBeLessThan(Number.POSITIVE_INFINITY);
            expect(run.closeAt, `${runId} closed`).toBeGreaterThan(run.openAt);
        }
        return runs;
    }
    /** Patches the selected HypaV3 preset for `body` and restores the fields after. */
    async function withHypaV3(settings: Record<string, unknown>, body: () => Promise<void>) {
        const current = await single("hypaV3Presets");
        const selected = current.data.items.find((item: any) => item.id === current.data.selectedId);
        const before = Object.fromEntries(Object.keys(settings).map((key) => [key, selected.settings[key]]));
        await patchHypaV3(settings);
        try {
            await body();
        } finally {
            await patchHypaV3(before);
        }
    }
    /** The `memory` slot on a reverse-proxy profile whose format is Plugin (the tab's provider `prov`). */
    async function withPluginMemorySlot(body: () => Promise<void>) {
        const profiles = await single("modelProfiles");
        const presets = await single("modelPresets");
        const preset = presets.data.find((entry: any) => entry.id === modelPresetId);
        const before = { auxSlots: preset.auxSlots, seperateModelsForAxModels: preset.seperateModelsForAxModels };
        const added = await batch({
            ops: [
                {
                    kind: "modelProfiles",
                    id: "main",
                    baseRevision: profiles.revision,
                    data: [
                        ...profiles.data,
                        {
                            ...profiles.data[0],
                            id: PLUGIN_PROFILE_ID,
                            name: "plugin memory",
                            customAPIFormat: LLMFormat.Plugin,
                            currentPluginProvider: "prov",
                        },
                    ],
                },
            ],
        });
        expect(added.status, JSON.stringify(added.body).slice(0, 300)).toBe(200);
        await patchPreset("modelPresets", {
            auxSlots: { memory: { profileId: PLUGIN_PROFILE_ID } },
            seperateModelsForAxModels: true,
        });
        try {
            await body();
        } finally {
            await patchPreset("modelPresets", before);
            const now = await single("modelProfiles");
            await batch({
                ops: [
                    {
                        kind: "modelProfiles",
                        id: "main",
                        baseRevision: now.revision,
                        data: now.data.filter((entry: any) => entry.id !== PLUGIN_PROFILE_ID),
                    },
                ],
            });
        }
    }
    /** Answers the job's `provider` callbacks with one plugin summary each. */
    function pluginAnswers() {
        const calls: any[] = [];
        return {
            calls,
            answerCallback: (event: any) => {
                calls.push(event);
                return {
                    outcome: "answered",
                    value: { success: true, content: `Plugin summary ${calls.length}: events happened.` },
                };
            },
        };
    }
    /** A message edit as another client makes it (`setText`). */
    async function editMessage(chaId: string, id: string, text: string) {
        const chat = await readChat(chaId);
        const res = await batch({
            chats: [
                { characterId: chaId, chatId: "k", baseRevision: chat.revision, ops: [{ op: "setText", id, text }] },
            ],
        });
        expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    }
    const stopMemoryRun = (runId: string) =>
        api(`/api/generations/${currentJobId}/memory-stop?clientId=tab`, {
            method: "POST",
            body: JSON.stringify({ runId }),
        });

    beforeAll(async () => {
        tasksStack = await startStack({ memoryTasks: fake.service });
        await patchSettings({ hypaV3: true });
    }, SLOW);
    afterAll(async () => {
        use(blockingStack);
        await closeStack(tasksStack);
    });
    // The file's `afterEach` turns memory off again after the inner hooks ran: on before each test.
    beforeEach(async () => {
        fake.reset();
        await patchSettings({ hypaV3: true });
    });

    it(
        "a request trigger keeps the summaries in the send: stored before the main request under the chat's lease, and memoryProgress names the reason; nothing is handed off",
        async () => {
            const chaId = await seedCharacter({ extra: { triggerscript: [REQUEST_TRIGGER] } });
            state.onMain = async () => (await readChat(chaId)).data.hypaV3Data;
            const { events, terminal } = await job("send", chaId, { input: "Hello", userMessageId: "u1" });
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            expect(summaries().length).toBeGreaterThan(0);
            expect(mains()).toHaveLength(1);
            const atMain = mains()[0].chatAtRequest as { summaries: unknown[] };
            expect(atMain.summaries).toHaveLength(summaries().length);
            expect(memoryCard(mains()[0].body.messages)?.content).toContain("Summary 1: events happened.");
            const notices = memoryNotices(events);
            expect(notices[0]).toMatchObject({ phase: "blocking", reason: "requestTrigger", open: true, done: 0 });
            expect(notices.at(-1)).toMatchObject({ runId: notices[0].runId, open: false });
            expect(notices.filter((n) => n.open).at(-1)).toMatchObject({
                done: summaries().length,
                total: summaries().length,
            });
            expect(fake.leases).toEqual([{ chatRef: { chaId, chatId: "k" }, ownerId: currentJobId, released: true }]);
            expect(fake.handOffs).toHaveLength(0);
        },
        SLOW,
    );

    it(
        "a Plugin memory slot keeps the summaries in the send through the tab's provider callback, before the main request, and memoryProgress names the reason",
        async () => {
            await withPluginMemorySlot(async () => {
                const chaId = await seedCharacter();
                const plugin = pluginAnswers();
                state.onMain = async () => (await readChat(chaId)).data.hypaV3Data;
                const { events, terminal } = await job(
                    "send",
                    chaId,
                    { input: "Hello", userMessageId: "u1" },
                    { hooks: PLUGIN_HOOKS, answerCallback: plugin.answerCallback },
                );
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                expect(plugin.calls.length).toBeGreaterThan(0);
                expect(plugin.calls.every((call) => call.name === "provider" && call.payload.name === "prov")).toBe(
                    true,
                );
                expect(JSON.stringify(plugin.calls[0].payload.argument.prompt_chat)).toContain(
                    "Summarize the ongoing role story",
                );
                // The summaries never reached the HTTP provider; the main request did, after the writes.
                expect(summaries()).toHaveLength(0);
                expect(mains()).toHaveLength(1);
                const atMain = mains()[0].chatAtRequest as { summaries: { text: string }[] };
                expect(atMain.summaries.map((s) => s.text)).toEqual(
                    plugin.calls.map((_, i) => `Plugin summary ${i + 1}: events happened.`),
                );
                expect(memoryCard(mains()[0].body.messages)?.content).toContain("Plugin summary 1: events happened.");
                expect(memoryNotices(events)[0]).toMatchObject({
                    phase: "blocking",
                    reason: "pluginModel",
                    open: true,
                });
                expect(fake.handOffs).toHaveLength(0);
            });
        },
        SLOW,
    );

    it(
        "both preview kinds select only, under a request trigger and under a Plugin slot: no history summary, no new stored summary, no question, no hand-off",
        async () => {
            const previews = async (chaId: string, options: Parameters<typeof job>[3] = {}) => {
                for (const kind of ["preview", "previewPrompt"]) {
                    const { events, terminal } = await job(kind, chaId, {}, { ...options, answer: () => "generate" });
                    expect(terminal?.type, `${kind}: ${JSON.stringify(terminal)}`).toBe("done");
                    expect(questions(events)).toHaveLength(0);
                    if (kind === "preview") {
                        const result = (terminal as any).result as { content: string }[];
                        expect(memoryCard(result)?.content).toContain(seededSummary.text);
                        expect(JSON.stringify(result)).not.toContain("Message number 2:");
                        expect(JSON.stringify(result)).toContain("Message number 23:");
                    }
                }
                expect(summaries()).toHaveLength(0);
                expect(mains()).toHaveLength(0);
                expect((await readChat(chaId)).data.hypaV3Data.summaries.map((s: any) => s.text)).toEqual([
                    seededSummary.text,
                ]);
                expect(fake.handOffs).toHaveLength(0);
            };
            const triggered = await seedCharacter({ extra: { triggerscript: [REQUEST_TRIGGER] } });
            await setChatMeta(triggered, { hypaV3Data: { summaries: [seededSummary] } });
            await previews(triggered);
            await withPluginMemorySlot(async () => {
                const plugged = await seedCharacter();
                await setChatMeta(plugged, { hypaV3Data: { summaries: [seededSummary] } });
                const plugin = pluginAnswers();
                await previews(plugged, { hooks: PLUGIN_HOOKS, answerCallback: plugin.answerCallback });
                expect(plugin.calls).toHaveLength(0);
            });
        },
        SLOW,
    );

    it(
        "a server-slot send selects the stored summaries without a summary request, trims the uncovered history behind the protected tail without asking for a gap under the threshold, and hands the chat off",
        async () => {
            const chaId = await seedCharacter();
            await setChatMeta(chaId, { hypaV3Data: { summaries: [seededSummary] } });
            const { events, terminal } = await job("send", chaId, { input: "Hello", userMessageId: "u1" });
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            expect(questions(events)).toHaveLength(0);
            expect(summaries()).toHaveLength(0);
            expect(mains()).toHaveLength(1);
            const prompt = JSON.stringify(mains()[0].body.messages);
            expect(memoryCard(mains()[0].body.messages)?.content).toContain(seededSummary.text);
            // The uncovered history is dropped oldest first; the last `queryChatCount` entries and the input stay.
            expect(prompt).not.toContain("Message number 2:");
            expect(prompt).toContain("Message number 22:");
            expect(prompt).toContain("Message number 23:");
            expect(prompt).toContain("Hello");
            // The hand-off: the history as read for the prompt, with its sources and the chat's generation.
            expect(fake.handOffs).toHaveLength(1);
            const input = fake.handOffs[0];
            expect(input).toMatchObject({
                chatRef: { chaId, chatId: "k" },
                epoch,
                speakerId: chaId,
                historyStart: 1,
                maxContext: 900,
                maxResponse: 100,
                effective: { fromChain: false },
            });
            expect(typeof input.sourceGeneration).toBe("number");
            expect(input.history.length).toBe(input.sources.length);
            expect(input.history.some((entry) => entry.content.includes("Message number 0:"))).toBe(true);
            expect(input.sources[1]).toMatchObject({ kind: "greeting", fmIndex: -1 });
            expect(input.sources[2]).toMatchObject({ kind: "message", id: "m0" });
            expect(input.tokenPolicy.tokenizer.customTokenizer).toBe("tik");
            expect(typeof input.settingsFingerprint).toBe("string");
            // The stored summaries are untouched; the job's own append and meta writes did not block the hand-off.
            expect((await readChat(chaId)).data.hypaV3Data.summaries.map((s: any) => s.text)).toEqual([
                seededSummary.text,
            ]);
        },
        SLOW,
    );

    it(
        "with the similarity correction on, a select-only send makes exactly one correction request before the main request and stores no summary",
        async () => {
            await withHypaV3({ enableSimilarityCorrection: true }, async () => {
                const chaId = await seedCharacter();
                await setChatMeta(chaId, { hypaV3Data: { summaries: [seededSummary] } });
                const { terminal } = await job("send", chaId, { input: "Hello", userMessageId: "u1" });
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                expect(upstream.map((entry) => entry.summary)).toEqual([true, false]);
                expect((await readChat(chaId)).data.hypaV3Data.summaries.map((s: any) => s.text)).toEqual([
                    seededSummary.text,
                ]);
                expect(fake.handOffs).toHaveLength(1);
            });
        },
        SLOW,
    );

    it(
        "a gap over the threshold asks once with the planned count: 'continue', a dismissed question, and a running task's silence all trim and hand off; a failed task's error is shown",
        async () => {
            await withHypaV3({ gapConfirmTokens: 0 }, async () => {
                const expectTrimmedAndHandedOff = async (
                    result: Awaited<ReturnType<typeof job>>,
                    chaId: string,
                    handOffs: number,
                ) => {
                    expect(result.terminal?.type, JSON.stringify(result.terminal)).toBe("done");
                    expect(summaries()).toHaveLength(0);
                    expect(mains().length).toBeGreaterThan(0);
                    const prompt = JSON.stringify(mains().at(-1)!.body.messages);
                    expect(prompt).not.toContain("Message number 0:");
                    expect(prompt).toContain("Message number 23:");
                    expect(fake.handOffs).toHaveLength(handOffs);
                    expect(fake.handOffs.at(-1)?.chatRef).toEqual({ chaId, chatId: "k" });
                };
                const continued = await seedCharacter();
                const first = await job(
                    "send",
                    continued,
                    { input: "Hello", userMessageId: "u1" },
                    { answer: () => "continue" },
                );
                expect(questions(first.events)).toEqual([
                    expect.objectContaining({
                        kind: "memoryGap",
                        payload: { gapTokens: expect.any(Number), plannedCalls: expect.any(Number) },
                    }),
                ]);
                expect(questions(first.events)[0].payload.gapTokens).toBeGreaterThan(0);
                expect(questions(first.events)[0].payload.plannedCalls).toBeGreaterThan(1);
                await expectTrimmedAndHandedOff(first, continued, 1);

                upstream.length = 0;
                fake.setStatus({
                    taskId: "t1",
                    state: "failed",
                    done: 1,
                    total: 3,
                    error: "the summary model broke",
                    terminalRevision: null,
                });
                const dismissed = await seedCharacter();
                const second = await job(
                    "send",
                    dismissed,
                    { input: "Hello", userMessageId: "u1" },
                    { answer: () => null },
                );
                expect(questions(second.events)).toHaveLength(1);
                expect(questions(second.events)[0].payload.lastTaskError).toBe("the summary model broke");
                await expectTrimmedAndHandedOff(second, dismissed, 2);

                upstream.length = 0;
                fake.setStatus({ taskId: "t2", state: "running", done: 0, total: 3 });
                const busy = await seedCharacter();
                const third = await job(
                    "send",
                    busy,
                    { input: "Hello", userMessageId: "u1" },
                    { answer: () => "generate" },
                );
                expect(questions(third.events)).toHaveLength(0);
                await expectTrimmedAndHandedOff(third, busy, 3);
            });
        },
        SLOW,
    );

    it(
        "'generate' takes the lease, summarizes the gap one window at a time with each summary saved before the next request and before the main request, reuses the gap measurement's correction, and reports the initial run",
        async () => {
            await withHypaV3({ gapConfirmTokens: 0, enableSimilarityCorrection: true }, async () => {
                const chaId = await seedCharacter();
                await setChatMeta(chaId, { hypaV3Data: { summaries: [seededSummary] } });
                fake.setPendingManual(true);
                const storedAtRequest: number[] = [];
                state.holdSummary = async () => {
                    storedAtRequest.push((await readChat(chaId)).data.hypaV3Data.summaries.length);
                };
                state.onMain = async () => (await readChat(chaId)).data.hypaV3Data;
                const { events, terminal } = await job(
                    "send",
                    chaId,
                    { input: "Hello", userMessageId: "u1" },
                    { answer: () => "generate" },
                );
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                const question = questions(events)[0];
                expect(question.payload.plannedCalls).toBeGreaterThan(1);
                // One correction request (the gap measurement's, reused by the run), then the history summaries.
                const planned = question.payload.plannedCalls as number;
                expect(summaries()).toHaveLength(planned + 1);
                expect(storedAtRequest).toEqual([1, ...Array.from({ length: planned }, (_, i) => 1 + i)]);
                expect(mains()).toHaveLength(1);
                const atMain = mains()[0].chatAtRequest as { summaries: { text: string }[] };
                expect(atMain.summaries).toHaveLength(1 + planned);
                expect(atMain.summaries[0].text).toBe(seededSummary.text);
                const stored = (await readChat(chaId)).data.hypaV3Data.summaries.map((s: any) => s.text);
                expect(stored).toEqual(atMain.summaries.map((s) => s.text));
                const prompt = mains()[0].body.messages as { content: string }[];
                expect(memoryCard(prompt)?.content).toContain("events happened.");
                expect(JSON.stringify(prompt)).toContain("Message number 23:");
                expect(fake.leases).toEqual([
                    { chatRef: { chaId, chatId: "k" }, ownerId: currentJobId, released: true },
                ]);
                const initial = memoryNotices(events).filter((n) => n.phase === "initial");
                expect(initial[0]).toMatchObject({ reason: "gap", open: true, done: 0, total: planned });
                expect(initial.filter((n) => n.open).at(-1)).toMatchObject({ done: planned, total: planned });
                expect(
                    memoryNotices(events)
                        .filter((n) => n.runId === initial[0].runId)
                        .at(-1),
                ).toEqual({
                    chatRef: { chaId, chatId: "k" },
                    runId: initial[0].runId,
                    open: false,
                });
                // A manual start waits for the chat: the input is handed off whatever the lookahead says.
                expect(fake.handOffs).toHaveLength(1);
            });
        },
        SLOW,
    );

    it(
        "a message edited during 'generate' ends the send with the retryable error and saves nothing past the valid prefix",
        async () => {
            await withHypaV3({ gapConfirmTokens: 0 }, async () => {
                const chaId = await seedCharacter();
                let edited = false;
                state.holdSummary = async () => {
                    // During the second window's request: a message of that window changes.
                    if (state.summaryIndex === 1 && !edited) {
                        edited = true;
                        await editMessage(chaId, "m8", "Message number 8, rewritten by another tab.");
                    }
                };
                const { terminal } = await job(
                    "send",
                    chaId,
                    { input: "Hello", userMessageId: "u1" },
                    { answer: () => "generate" },
                );
                expect(terminal).toMatchObject({
                    type: "error",
                    message: expect.stringContaining("[HypaV3] The chat changed during summarization"),
                });
                expect(edited).toBe(true);
                expect(summaries()).toHaveLength(2);
                expect(mains()).toHaveLength(0);
                expect((await readChat(chaId)).data.hypaV3Data.summaries.map((s: any) => s.text)).toEqual([
                    "Summary 1: events happened.\n\nPart two of 1.",
                ]);
                expect(fake.leases.map((lease) => lease.released)).toEqual([true]);
                expect(fake.handOffs).toHaveLength(0);
            });
        },
        SLOW,
    );

    it(
        "an abort after two summaries of an initial run keeps the two, makes no later request, and releases the lease",
        async () => {
            await withHypaV3({ gapConfirmTokens: 0 }, async () => {
                const chaId = await seedCharacter({ count: 36 });
                state.holdSummary = async () => {
                    if (state.summaryIndex === 2) {
                        await api(`/api/generations/${currentJobId}?clientId=tab`, { method: "DELETE" });
                    }
                };
                const { events, terminal } = await job(
                    "send",
                    chaId,
                    { input: "Hello", userMessageId: "u1" },
                    { answer: () => "generate" },
                );
                expect(terminal?.type, JSON.stringify(terminal)).toBe("error");
                expect((terminal as any).message).toMatch(/abort/i);
                expect(questions(events)[0].payload.plannedCalls).toBeGreaterThan(3);
                expect(summaries()).toHaveLength(3);
                expect(mains()).toHaveLength(0);
                expect((await readChat(chaId)).data.hypaV3Data.summaries.map((s: any) => s.text)).toEqual([
                    "Summary 1: events happened.\n\nPart two of 1.",
                    "Summary 2: events happened.\n\nPart two of 2.",
                ]);
                expect(fake.leases.map((lease) => lease.released)).toEqual([true]);
                expect(fake.handOffs).toHaveLength(0);
            });
        },
        SLOW,
    );

    it(
        "memory-stop after two summaries keeps the two, trims the rest, and the group's second speaker selects only",
        async () => {
            await withHypaV3({ gapConfirmTokens: 0 }, async () => {
                const bob = await seedCharacter({ count: 0, extra: { name: "Bob" } });
                const cid = await seedCharacter({ count: 0, extra: { name: "Cid" } });
                const group = await seedCharacter({
                    messages: Array.from({ length: 36 }, (_, i) => ({
                        role: i % 2 === 0 ? "user" : "char",
                        data: longText(i),
                        chatId: `m${i}`,
                        ...(i % 2 === 1 ? { saying: i % 4 === 1 ? bob : cid } : {}),
                    })),
                    extra: {
                        name: "Band",
                        type: "group",
                        characters: [bob, cid],
                        characterTalks: [1, 1],
                        characterActive: [true, true],
                        orderByOrder: true,
                        firstMessage: "",
                        desc: "",
                    },
                });
                let runId: string | undefined;
                let stopped: { status: number; body: any } | undefined;
                state.holdSummary = async () => {
                    if (state.summaryIndex === 1 && !stopped) {
                        expect(runId).toBeDefined();
                        stopped = await stopMemoryRun(runId!);
                    }
                };
                const { events, terminal } = await job(
                    "group",
                    group,
                    { input: "hello all", userMessageId: "u1" },
                    {
                        answer: () => "generate",
                        onEvent: (event) => {
                            if (
                                event.type === "notice" &&
                                event.kind === "memoryProgress" &&
                                event.payload.phase === "initial"
                            ) {
                                runId = event.payload.runId;
                            }
                        },
                    },
                );
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                expect(stopped).toMatchObject({ status: 200, body: { stopped: true } });
                expect(questions(events)).toHaveLength(1);
                expect(summaries()).toHaveLength(2);
                expect((await readChat(group)).data.hypaV3Data.summaries.map((s: any) => s.text)).toEqual([
                    "Summary 1: events happened.\n\nPart two of 1.",
                    "Summary 2: events happened.\n\nPart two of 2.",
                ]);
                // Both speakers replied from the stored summaries with the rest of the history trimmed.
                expect(mains()).toHaveLength(2);
                for (const main of mains()) {
                    const prompt = JSON.stringify(main.body.messages);
                    expect(memoryCard(main.body.messages)?.content).toContain("Summary 1: events happened.");
                    expect(prompt).not.toContain("Message number 20:");
                    expect(prompt).toContain("Message number 35:");
                }
                expect(
                    memoryNotices(events)
                        .filter((n) => n.runId === runId)
                        .at(-1),
                ).toMatchObject({ open: false });
                expect(memoryNotices(events).filter((n) => n.phase === "blocking")).toHaveLength(0);
                expect(fake.leases).toHaveLength(1);
                expect(fake.handOffs).toHaveLength(1);
                expect(fake.handOffs[0].speakerId).toBe(cid);
            });
        },
        SLOW,
    );

    it(
        "the protected tail survives the final re-check: an editRequest growth drops the older history first, and one past the tail ends with the too-many-tokens error, also when sendChatAsSystem merged them into one system message",
        async () => {
            const grow = (words: number) =>
                luaTrigger(
                    `listenEdit('editRequest', function(id, data) data[#data + 1] = { role = 'system', content = string.rep('word ', ${words}) } return data end)`,
                );
            // A short chat that fits: the protected tail (the last three history entries) and the
            // removable entries before it.
            const fits = await seedCharacter({ count: 8, extra: { triggerscript: [grow(450)] } });
            const kept = await job("send", fits, { input: "Hi", userMessageId: "u1" });
            expect(kept.terminal?.type, JSON.stringify(kept.terminal)).toBe("done");
            const prompt = JSON.stringify(mains()[0].body.messages);
            expect(prompt).not.toContain("Message number 0:");
            expect(prompt).toContain("Message number 6:");
            expect(prompt).toContain("Message number 7:");
            expect(prompt).toContain("word word");
            // Nothing is due for a chat this short.
            expect(fake.handOffs).toHaveLength(0);

            upstream.length = 0;
            const over = await seedCharacter({ count: 8, extra: { triggerscript: [grow(760)] } });
            const refused = await job("send", over, { input: "Hi", userMessageId: "u1" });
            expect(refused.terminal).toMatchObject({
                type: "error",
                message: expect.stringContaining("At token rechecking"),
            });
            expect(mains()).toHaveLength(0);

            const presets = await single("presets");
            const preset = presets.data.find((entry: any) => entry.id === presetId);
            const before = {
                promptTemplate: preset.promptTemplate ?? null,
                promptSettings: preset.promptSettings ?? null,
            };
            await patchPreset("presets", {
                promptTemplate: [
                    { type: "plain", type2: "main", role: "system", text: "Main prompt." },
                    { type: "description" },
                    { type: "chat", rangeStart: 0, rangeEnd: "end" },
                ],
                promptSettings: {
                    assistantPrefill: "",
                    postEndInnerFormat: "",
                    sendChatAsSystem: true,
                    sendName: false,
                    utilOverride: false,
                },
            });
            try {
                const merged = await seedCharacter({ count: 8, extra: { triggerscript: [grow(760)] } });
                const result = await job("send", merged, { input: "Hi", userMessageId: "u1" });
                expect(result.terminal).toMatchObject({
                    type: "error",
                    message: expect.stringContaining("At token rechecking"),
                });
                expect(mains()).toHaveLength(0);
            } finally {
                await patchPreset("presets", before);
            }
        },
        SLOW,
    );

    it(
        "a whole-chat replace during the step (same ids, texts, and memory; another scriptstate) hands off nothing",
        async () => {
            await withHypaV3({ enableSimilarityCorrection: true }, async () => {
                const chaId = await seedCharacter();
                await setChatMeta(chaId, { hypaV3Data: { summaries: [seededSummary] } });
                let replaced = false;
                // The correction request runs inside the step, after the history and its generation were read.
                state.holdSummary = async () => {
                    if (!replaced) {
                        replaced = true;
                        const chat = await readChat(chaId);
                        const res = await batch({
                            chats: [
                                {
                                    characterId: chaId,
                                    chatId: "k",
                                    baseRevision: chat.revision,
                                    ops: [{ op: "replace", chat: { ...chat.data, scriptstate: { reloaded: "1" } } }],
                                },
                            ],
                        });
                        expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
                    }
                };
                const { terminal } = await job("send", chaId, { input: "Hello", userMessageId: "u1" });
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                expect(replaced).toBe(true);
                expect(mains()).toHaveLength(1);
                const chat = (await readChat(chaId)).data;
                expect(chat.scriptstate).toEqual({ reloaded: "1" });
                expect(chat.hypaV3Data.summaries.map((s: any) => s.text)).toEqual([seededSummary.text]);
                expect(chat.message.at(-1).data).toBe("Main reply.");
                expect(fake.handOffs).toHaveLength(0);
            });
        },
        SLOW,
    );

    it(
        "continue, reroll, and an auto-continue round each hand off the last round's input",
        async () => {
            const chaId = await seedCharacter();
            const continued = await job("continue", chaId, {});
            expect(continued.terminal?.type, JSON.stringify(continued.terminal)).toBe("done");
            expect(fake.handOffs).toHaveLength(1);
            expect(fake.handOffs[0].history.at(-1)?.content).toContain("Message number 23:");

            const rerolled = await job("reroll", chaId, {});
            expect(rerolled.terminal?.type, JSON.stringify(rerolled.terminal)).toBe("done");
            expect(fake.handOffs).toHaveLength(2);

            await patchSettings({ autoContinueChat: true });
            try {
                upstream.length = 0;
                state.mainTexts = ["Main reply without an end", "Main reply."];
                const other = await seedCharacter();
                const auto = await job("send", other, { input: "Hello", userMessageId: "u1" });
                expect(auto.terminal?.type, JSON.stringify(auto.terminal)).toBe("done");
                expect(mains()).toHaveLength(2);
                expect((await readChat(other)).data.message.at(-1).data).toBe("Main reply without an endMain reply.");
                // The continue round's history ends with the reply it continued.
                expect(fake.handOffs).toHaveLength(3);
                expect(fake.handOffs[2].history.at(-1)?.content).toContain("Main reply without an end");
            } finally {
                await patchSettings({ autoContinueChat: false });
            }
        },
        SLOW,
    );

    it(
        "the experimental selection's embedding queue reports inside a selection run: memoryProgress opens before the legacy progress and closes after it",
        async () => {
            await withHypaV3(
                {
                    useExperimentalImpl: true,
                    summarizationMaxConcurrent: 1,
                    embeddingMaxConcurrent: 1,
                    recentMemoryRatio: 0.1,
                    similarMemoryRatio: 0.6,
                },
                async () => {
                    const chaId = await seedCharacter();
                    await setChatMeta(chaId, {
                        hypaV3Data: {
                            summaries: [
                                {
                                    text: "Alpha: the party left the village.",
                                    chatMemos: ["m0", "m1"],
                                    isImportant: false,
                                },
                                {
                                    text: "Beta: the desert crossing began.",
                                    chatMemos: ["m2", "m3"],
                                    isImportant: false,
                                },
                            ],
                        },
                    });
                    const { events, terminal } = await job("send", chaId, { input: "Hello", userMessageId: "u1" });
                    expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                    expect(summaries()).toHaveLength(0);
                    expect(
                        legacyNotices(events).some((n) => n.open && String(n.msg).includes("Similarity searching")),
                    ).toBe(true);
                    const runs = expectRunsToCoverLegacyProgress(events);
                    expect(
                        memoryNotices(events)
                            .filter((n) => n.open)
                            .every((n) => n.phase === "selection" && n.reason === null),
                    ).toBe(true);
                    // The summary chunks were embedded (the queue the notices report), not only the queries.
                    expect(embedCalls.some((call) => call.input.some((text) => text.startsWith("Alpha:")))).toBe(true);
                    expect(runs.size).toBeGreaterThan(0);
                    expect(fake.handOffs).toHaveLength(1);
                },
            );
        },
        SLOW,
    );

    it(
        "an experimental blocking run reports its summaries and its selection inside memoryProgress runs that open before and close after the legacy progress",
        async () => {
            await withHypaV3(
                { useExperimentalImpl: true, summarizationMaxConcurrent: 1, embeddingMaxConcurrent: 1 },
                async () => {
                    const chaId = await seedCharacter({ extra: { triggerscript: [REQUEST_TRIGGER] } });
                    const { events, terminal } = await job("send", chaId, { input: "Hello", userMessageId: "u1" });
                    expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                    expect(summaries().length).toBeGreaterThan(0);
                    expect(legacyNotices(events).some((n) => n.open && String(n.msg).includes("Summarizing"))).toBe(
                        true,
                    );
                    const runs = expectRunsToCoverLegacyProgress(events);
                    const notices = memoryNotices(events);
                    expect(notices[0]).toMatchObject({ phase: "blocking", reason: "requestTrigger", open: true });
                    const blocking = runs.get(notices[0].runId)!;
                    const firstLegacy = events.findIndex(
                        (event) => event.type === "notice" && event.kind === "progress",
                    );
                    expect(blocking.openAt).toBeLessThan(firstLegacy);
                    expect((await readChat(chaId)).data.hypaV3Data.summaries.length).toBe(summaries().length);
                },
            );
        },
        SLOW,
    );
});

// The server's own memory task service, as in production: a send over the lookahead line selects the
// stored summaries and hands its chat to the service, whose task writes the summaries after the job
// ended; the manual routes are open.
describe("HypaV3 with the server's memory task service", () => {
    let serviceStack: Stack;
    const TERMINAL_STATES = new Set(["done", "failed", "cancelled", "skipped"]);
    const tasks = () => server.context.memoryTasks!;
    /** The chat's next terminal task status (listened for from now on). */
    function nextTerminal(chaId: string) {
        return new Promise<MemoryTaskStatus>((resolve) => {
            const off = tasks().onStatus(({ chatRef, status }) => {
                if (chatRef.chaId === chaId && chatRef.chatId === "k" && TERMINAL_STATES.has(status.state)) {
                    off();
                    resolve(status);
                }
            });
        });
    }
    function deferred() {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => (resolve = done));
        return { promise, resolve };
    }
    /** The texts a summary's vectors are made of (the preset's `\n\n` separator). */
    const chunksOf = (texts: string[]) => texts.flatMap((text) => text.split("\n\n").map((part) => part.trim()));

    beforeAll(async () => {
        serviceStack = await startStack();
        // A small recent share leaves summaries for the similarity search (their chunks embedded).
        await patchHypaV3({ recentMemoryRatio: 0.1, similarMemoryRatio: 0.6 });
    }, SLOW);
    afterAll(async () => {
        use(blockingStack);
        await closeStack(serviceStack);
    });
    // The file's `afterEach` turns memory off again: on before each test.
    beforeEach(async () => {
        await patchSettings({ hypaV3: true });
    });

    it(
        "a send over the lookahead line ends `done` with no summary request, the task's summary requests start only after the job's terminal, and the next send selects the task's summaries without embedding them again",
        async () => {
            const chaId = await seedCharacter();
            state.onMain = async () => (await readChat(chaId)).data.hypaV3Data;
            // Every memory request the task makes records the send's job as it is at that moment.
            const jobAtMemoryRequest: (ReturnType<typeof server.context.generationJobs.status> | undefined)[] = [];
            const runInJob = server.context.llmRequests.runInJob;
            const spy = vi.spyOn(server.context.llmRequests, "runInJob").mockImplementation((spec) => {
                if (spec.source === "memory") {
                    jobAtMemoryRequest.push(structuredClone(server.context.generationJobs.status(currentJobId, "tab")));
                }
                return runInJob(spec);
            });
            // The task's first summary waits until the send's terminal reached the tab.
            const reached = deferred();
            const release = deferred();
            state.holdSummary = async () => {
                reached.resolve();
                await release.promise;
            };
            const terminal = nextTerminal(chaId);
            try {
                const first = await job("send", chaId, { input: "Hello", userMessageId: "u1" });
                expect(first.terminal?.type, JSON.stringify(first.terminal)).toBe("done");
                expect(mains()).toHaveLength(1);
                expect((mains()[0].chatAtRequest as { summaries?: unknown[] } | undefined)?.summaries ?? []).toEqual(
                    [],
                );
                await reached.promise;
                expect(upstream.findIndex((entry) => entry.summary)).toBeGreaterThan(
                    upstream.findIndex((entry) => !entry.summary),
                );
                expect(tasks().status({ chaId, chatId: "k" })).toMatchObject({ state: "running", done: 0 });
                release.resolve();
                const status = await terminal;
                expect(status.state).toBe("done");
                expect(status.done).toBeGreaterThan(0);
                expect(status.done).toBe(status.total);
                expect(jobAtMemoryRequest.length).toBeGreaterThanOrEqual(status.done);
                for (const at of jobAtMemoryRequest) {
                    expect(at).toMatchObject({ jobId: currentJobId, state: "ended", terminal: { type: "done" } });
                }
            } finally {
                state.holdSummary = null;
                release.resolve();
                spy.mockRestore();
            }
            const made = summaries();
            const stored = (await readChat(chaId)).data.hypaV3Data.summaries.map((s: { text: string }) => s.text);
            expect(stored).toEqual(made.map((_, i) => `Summary ${i + 1}: events happened.\n\nPart two of ${i + 1}.`));
            // The task warmed the summaries' vectors.
            const warmed = embedCalls.flatMap((call) => call.input);
            expect(warmed).toEqual(expect.arrayContaining(chunksOf(stored)));

            // The next send: the task's summaries in the card, their vectors from the cache. A task the
            // send hands off holds its first summary until the send's embeddings are counted.
            upstream.length = 0;
            embedCalls.length = 0;
            state.onMain = null;
            const before = tasks().status({ chaId, chatId: "k" })!.taskId;
            const next = nextTerminal(chaId);
            const hold = deferred();
            state.holdSummary = () => hold.promise;
            try {
                const second = await job("send", chaId, { input: "Hello again", userMessageId: "u2" });
                expect(second.terminal?.type, JSON.stringify(second.terminal)).toBe("done");
                expect(memoryCard(mains()[0].body.messages)?.content).toContain("Summary 1: events happened.");
                // A summary request, if any, is the handed-off task's, after the main request.
                const firstSummary = upstream.findIndex((entry) => entry.summary);
                expect(firstSummary === -1 || firstSummary > upstream.findIndex((entry) => !entry.summary)).toBe(true);
                const embedded = embedCalls.flatMap((call) => call.input);
                expect(embedded.length).toBeGreaterThan(0);
                expect(embedded.filter((text) => chunksOf(stored).includes(text))).toEqual([]);
            } finally {
                hold.resolve();
                state.holdSummary = null;
            }
            if (tasks().status({ chaId, chatId: "k" })!.taskId !== before) {
                expect((await next).state).toBe("done");
            }
        },
        SLOW,
    );

    it(
        "a manual start from the route on a chat under the lookahead line waits for the next send (`pendingManual`), which hands the chat off; a later start reuses the retained input and runs",
        async () => {
            const chaId = await seedCharacter({ count: 4 });
            const chatRef = { chaId, chatId: "k" };
            const startTask = () =>
                api("/api/memory/tasks", { method: "POST", body: JSON.stringify({ characterId: chaId, chatId: "k" }) });
            const first = await job("send", chaId, { input: "Hello", userMessageId: "u1" });
            expect(first.terminal?.type, JSON.stringify(first.terminal)).toBe("done");
            // No summary is due: nothing is handed off.
            expect(tasks().status(chatRef)).toBeNull();

            expect(await startTask()).toEqual({ status: 200, body: { outcome: "pendingManual" } });
            expect(tasks().pendingManual(chatRef)).toBe(true);
            const handedOff = nextTerminal(chaId);
            const second = await job("send", chaId, { input: "Hello again", userMessageId: "u2" });
            expect(second.terminal?.type, JSON.stringify(second.terminal)).toBe("done");
            expect(tasks().pendingManual(chatRef)).toBe(false);
            const ran = await handedOff;
            expect(ran).toMatchObject({ state: "done", done: 0, total: 0 });

            const again = nextTerminal(chaId);
            const restart = await startTask();
            expect(restart.status).toBe(200);
            expect(["running", "queued"]).toContain(restart.body.outcome);
            expect(restart.body.status.taskId).not.toBe(ran.taskId);
            expect(await again).toMatchObject({ taskId: restart.body.status.taskId, state: "done" });
        },
        SLOW,
    );
});
