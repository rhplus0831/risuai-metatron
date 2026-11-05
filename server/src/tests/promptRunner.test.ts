// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { type GenerationEvent, type GenerationTerminalEvent, NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
import type { ChangeFeed, ChangeFeedEvent } from "../data/changeFeed.ts";
import type { EventFeedFrame } from "../../../shared/events.ts";
import { completionNotificationTag } from "../../../shared/notifications.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import * as resourceStores from "../data/resourceStore.ts";
import type { ChatGroup, ChatOp } from "../../../shared/chats.ts";
import * as localModels from "../prompt/transformers.ts";
import { allowListenerOrigin, createSigner, createTestServer, json, sleep, waitFor } from "./testSupport.ts";
import { UNHURRIED_CBS, UNHURRIED_SCRIPT_WORKERS } from "./unhurriedLimits.ts";

// A send as a server job end to end (`server/src/prompt/runner.ts` `runPromptJob`,
// `server/src/prompt/scripts.ts`, `server/src/jobs/runSetup.ts`) on a real listening server with the
// default runner, the real worker pool (the regex scripts task, Lua), the production bindings, the
// job channel, and a fake OpenAI-compatible provider (SSE and JSON). The input stage (the input
// trigger, `editinput` through the worker, the plugin hook as a callback, the user message under its
// id, the retry that skips it, the id of another role refused); the streamed reply (chunks,
// `accepted`, `done`, the stored raw text and its generation info, the lock
// released); a continue extending its message while a Lua `editRequest` write to it is refused; the
// checkpoint timer during a stalled stream and the text kept on abort; a group send under the job's
// frozen configuration with one terminal; a non-streaming reply; a failing provider as the job's
// error or, with `inlayErrorResponse`, a stopped send; a start trigger's stop; the request trigger's
// effect limit ending the job before any provider call; `previewPrompt` and `preview`; `presetChain`
// (the input stage on the admitted preset, the pick for the prompt, the `preset` event, a missing
// name's toast); and the route's `userMessageId` rule. The assembled prompt's parity is the golden in
// `assemble.test.ts`; the worker task's bounds are in `regexScriptsTask.test.ts`.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SLOW = 60_000;

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/**
 * Runs `cleanup` once: at the test's end even when it times out (its `finally` then never runs), or
 * earlier from that `finally`.
 */
function cleanupOnce(cleanup: () => void): () => void {
    let done = false;
    const run = () => {
        if (done) return;
        done = true;
        cleanup();
    };
    onTestFinished(run);
    return run;
}

// The provider: `mode` picks the next answer; `onRequest` runs when a request arrives.
let mode: {
    chunks: string[];
    delayMs: number;
    status?: number;
    samples?: string[];
    /** The stream's socket is destroyed after this many chunks (a dropped connection). */
    breakAfterChunks?: number;
    /** Holds that break until the test releases it. */
    breakWhen?: Promise<void>;
    /** Holds this chunk and the stream end until the test releases them. */
    holdBeforeChunk?: { index: number; until: Promise<void> };
} = { chunks: ["Hel", "lo"], delayMs: 0 };
let onRequest: (() => Promise<void>) | null = null;
/** The text a non-streaming request (a translation's) gets instead of `mode.chunks` while set. */
let plainAnswer: ((body: any) => string) | null = null;
/** Resolves once the current job's owner socket is open (set per job by `job()`). */
let socketOpen: Promise<void> = Promise.resolve();
const bodies: any[] = [];
const provider = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) {
        parts.push(chunk as Buffer);
    }
    const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
    bodies.push(body);
    // The owner socket of the job attaches after the create answered: wait for it, so every chunk is
    // observed as a `chunk` event (a chunk sent to no socket is folded into the attach's `accepted`).
    await socketOpen;
    if (onRequest) {
        await onRequest();
    }
    // onRequest may choose this response; keep that choice fixed across subsequent chunk waits.
    const requestMode = mode;
    if (requestMode.status) {
        res.writeHead(requestMode.status, { "content-type": "application/json" });
        // An OpenAI error envelope: the message (never stored on the event) and the code.
        res.end(JSON.stringify({ error: { message: "upstream broke", code: "upstream_broke" } }));
        return;
    }
    if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        const content = plainAnswer ? plainAnswer(body) : requestMode.chunks.join("");
        res.end(
            JSON.stringify({
                choices: [content, ...(requestMode.samples ?? [])].map((text) => ({
                    message: { role: "assistant", content: text },
                })),
            }),
        );
        return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    let sent = 0;
    for (const [index, chunk] of requestMode.chunks.entries()) {
        if (requestMode.holdBeforeChunk?.index === index) {
            await requestMode.holdBeforeChunk.until;
        }
        if (res.destroyed) {
            return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        await sleep(requestMode.delayMs);
        if (++sent === requestMode.breakAfterChunks) {
            await requestMode.breakWhen;
            res.destroy();
            return;
        }
    }
    res.write("data: [DONE]\n\n");
    res.end();
});

let runnerStore: resourceStores.ResourceStore;
let runnerFeed: ChangeFeed;
let rootDir = "";
let server: ReturnType<typeof createTestServer>;
let transformers: localModels.TransformersService;
let node: http.Server;
let base = "";
let epoch = "";
let signer: Awaited<ReturnType<typeof createSigner>>;
let presetId = "";
let modelPresetId = "";
let profileId = "";
let personaId = "";

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
/** Patches a settings section (`providers`: streaming, `inlayErrorResponse`, `presetChain`; `memoryTranslateMedia`). */
async function patchSection(kind: string, patch: Record<string, unknown>) {
    const current = await single(kind);
    const res = await batch({
        ops: [{ kind, id: "main", baseRevision: current.revision, data: { ...current.data, ...patch } }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
}
const patchProviders = (patch: Record<string, unknown>) => patchSection("providers", patch);
/** Patches one prompt preset (`presets`), model preset (`modelPresets`), or model profile by id. */
async function patchPreset(
    kind: "presets" | "modelPresets" | "modelProfiles",
    id: string,
    patch: Record<string, unknown>,
) {
    const current = await single(kind);
    const res = await batch({
        ops: [
            {
                kind,
                id: "main",
                baseRevision: current.revision,
                data: current.data.map((preset: any) => (preset.id === id ? { ...preset, ...patch } : preset)),
            },
        ],
    });
    expect(res.status).toBe(200);
}

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
    firstMessage: "Hi from {{char}}",
    desc: "Desc of {{char}}",
    lowLevelAccess: true,
};
const v = (value: string) => ({ value, valueType: "value" });
const ef = (type: string, fields: Record<string, unknown> = {}, indent = 0) => ({ type, indent, ...fields });
const trig = (type: string, effect: unknown[]) => ({ comment: type, type, conditions: [], effect });
const editinputScript = (comment: string) => ({
    comment,
    in: "hi",
    out: "hello",
    type: "editinput",
    flag: "g",
    ableFlag: true,
});
/** An `editprocess` script that never matches, so previews and groups reach the script worker. */
const editprocessScript = {
    comment: "preset-process",
    in: "never-matches-a-message",
    out: "@@emo none",
    type: "editprocess",
    flag: "g",
    ableFlag: true,
};

let seeded = 0;
/** A character (or a group of `members`) with one chat `k` holding `messages`. */
async function seedCharacter(options: {
    name: string;
    type?: "character" | "group";
    members?: string[];
    messages?: Record<string, unknown>[];
    triggerscript?: unknown[];
    customscript?: unknown[];
    /** More fields of the chat (its translation settings). */
    chat?: Record<string, unknown>;
    /** More fields of the character or group (`customNotificationMessage`). */
    extra?: Record<string, unknown>;
}) {
    const chaId = `send-${++seeded}`;
    const res = await batch({
        ops: [
            {
                kind: "characters",
                id: chaId,
                baseRevision: null,
                data: {
                    ...BLANK_CHARACTER,
                    chaId,
                    name: options.name,
                    type: options.type ?? "character",
                    triggerscript: options.triggerscript ?? [],
                    customscript: options.customscript ?? [],
                    ...(options.type === "group"
                        ? {
                              characters: options.members,
                              characterTalks: options.members!.map(() => 1),
                              characterActive: options.members!.map(() => true),
                              orderByOrder: true,
                              firstMessage: "",
                              desc: "",
                          }
                        : {}),
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
                            message: options.messages ?? [],
                            ...(options.chat ?? {}),
                        },
                    },
                ],
            },
        ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return chaId;
}
const readChat = async (chaId: string) =>
    (
        await api("/api/resources/read", {
            method: "POST",
            body: JSON.stringify({ chats: [{ characterId: chaId, id: "k" }] }),
        })
    ).body.chats[0] as { revision: string; data: any };
const texts = (chat: { data: any }) => chat.data.message.map((m: any) => `${m.role}:${m.data}`);
/** A plain client write of the message: 200 once the job's lock is released, 409 while it holds it. */
async function clientSetText(chaId: string, messageId: string, text: string) {
    const chat = await readChat(chaId);
    const res = await batch({
        chats: [
            {
                characterId: chaId,
                chatId: "k",
                baseRevision: chat.revision,
                ops: [{ op: "setText", id: messageId, text }],
            },
        ],
    });
    return res.status;
}

let attach = 0;
type JobOptions = {
    command?: import("../../../shared/jobs.ts").GenerationCommand;
    /** Hold the first script worker call until attach can replay preparing. */
    observeStages?: boolean;
    streamedRows?: boolean;
    onEvent?: (event: GenerationEvent) => void;
    abortAfterChunks?: number;
    /** Runs at every `chunk` event the owner socket gets. */
    onChunk?: () => void;
    /** Answers a `callback` event (an edit hook): the answer message's fields. */
    answerCallback?: (event: any) => Record<string, unknown>;
    hooks?: typeof NO_GENERATION_HOOKS;
    presetId?: string;
};
/** Creates a job and follows its owner socket to the terminal. */
async function job(
    kind: string,
    chaId: string,
    extra: Record<string, unknown> = {},
    options: JobOptions = {},
): Promise<{ status: number; body: any; events: any[]; terminal: GenerationTerminalEvent | undefined }> {
    const chat = await readChat(chaId);
    // The provider waits for this job's owner socket: the gate is set before the job is admitted,
    // whose runner may reach the provider before the create's answer arrives here.
    let opened!: () => void;
    socketOpen = new Promise<void>((resolve) => {
        opened = resolve;
    });
    const ownerAttached = socketOpen;
    const workers = server.context.scriptWorkers;
    const runScripts = workers.runScripts.bind(workers);
    // This preset's regex scripts reach the worker before memory or the request: editinput (sends
    // with input), or editprocess on the greeting/history (previews and groups).
    const workerHold = options.observeStages
        ? vi.spyOn(workers, "runScripts").mockImplementationOnce(async (...args) => {
              await ownerAttached;
              return runScripts(...args);
          })
        : undefined;
    if (workerHold) {
        onTestFinished(() => {
            opened();
            workerHold.mockRestore();
        });
    }
    let socket: WebSocket | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    try {
        const created = await api("/api/generations", {
            method: "POST",
            body: JSON.stringify({
                kind,
                clientId: "tab",
                ...(options.command ? { command: options.command } : {}),
                ...(options.hooks ? { hooks: options.hooks } : {}),
                context: {
                    characterId: chaId,
                    chatId: "k",
                    presetId: options.presetId ?? presetId,
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
        const jobId = created.body.jobId as string;
        const url =
            `${base.replace("http", "ws")}/api/generations/${jobId}/ws` +
            `?risu-auth=${encodeURIComponent(await signer.jwt())}&clientId=tab&attach=${++attach}` +
            (options.streamedRows ? "&rows=streamed&hydration=patch&proto=1" : "");
        const ws = new WebSocket(url);
        socket = ws;
        const events: any[] = [];
        let chunks = 0;
        // Every frame is observed from the open on: the handler is set before the provider is released.
        const ended = new Promise<void>((resolve) => {
            fallback = setTimeout(resolve, 45_000);
            ws.onmessage = async (message) => {
                const event = JSON.parse(String(message.data));
                if (event.type === "ping") {
                    return;
                }
                events.push(event);
                options.onEvent?.(event);
                if (event.type === "chunk") {
                    options.onChunk?.();
                }
                if (event.type === "chunk" && ++chunks === options.abortAfterChunks) {
                    await api(`/api/generations/${jobId}?clientId=tab`, { method: "DELETE" });
                }
                if (event.type === "callback" && options.answerCallback) {
                    ws.send(JSON.stringify({ type: "answer", id: event.id, ...options.answerCallback(event) }));
                }
                if (event.type === "done" || event.type === "error") {
                    resolve();
                }
            };
        });
        await new Promise<void>((resolve) => {
            ws.onopen = () => {
                opened();
                resolve();
            };
            ws.onerror = () => {
                opened();
                resolve();
            };
        });
        await ended;
        return {
            ...created,
            events,
            terminal: events.find((event) => event.type === "done" || event.type === "error"),
        };
    } finally {
        // Also on a failed create or a throw: the provider never waits on this job's gate forever.
        opened();
        clearTimeout(fallback);
        socket?.close();
        workerHold?.mockRestore();
    }
}
/**
 * The chunks' whole texts, rebuilt from the wire deltas: each chunk keeps `keep` units of the text its
 * generation held at `base` (the reply's `accepted` text at its seq, 0 by default, then the previous
 * chunk) and appends `text`. Each chunk's base must be the seq held before it.
 */
function streamedTexts(events: any[]): { seq: number; text: string; messageId: string; generationId: string }[] {
    const held = new Map<string, { seq: number; text: string }>();
    const out: { seq: number; text: string; messageId: string; generationId: string }[] = [];
    for (const event of events) {
        if (event.type === "accepted" && event.messageId && event.generationId) {
            held.set(event.generationId, { seq: event.seq ?? 0, text: event.text });
        } else if (event.type === "chunk") {
            const before = held.get(event.generationId);
            expect(before, `chunk ${event.seq} without a held base`).toBeDefined();
            expect(event.base).toBe(before!.seq);
            expect(event.keep).toBeLessThanOrEqual(before!.text.length);
            const text = before!.text.slice(0, event.keep) + event.text;
            held.set(event.generationId, { seq: event.seq, text });
            out.push({ seq: event.seq, text, messageId: event.messageId, generationId: event.generationId });
        }
    }
    return out;
}
const notices = (events: any[], kind: string) => events.filter((e) => e.type === "notice" && e.kind === kind);
/** The request history rows of a job, newest first (the error event names the failed one). */
const historyOf = async (jobId: string) =>
    (await api(`/api/request-history?jobId=${encodeURIComponent(jobId)}`)).body.items as {
        id: string;
        status: string;
        providerCode: string | null;
        source: string;
    }[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
    allowListenerOrigin(provider);
    const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1/chat/completions`;
    rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-prompt-runner-"));
    mkdirSync(path.join(rootDir, "dist"));
    writeFileSync(path.join(rootDir, "dist", "index.html"), "<!doctype html><html><head></head><body></body></html>");
    symlinkSync(path.join(REPO_ROOT, "public"), path.join(rootDir, "public"), "dir");
    cpSync(path.join(REPO_ROOT, "version.json"), path.join(rootDir, "version.json"));
    mkdirSync(path.join(rootDir, "save", "server"), { recursive: true });
    writeFileSync(path.join(rootDir, "save", "server", "password"), "pw");
    // An aborted job gets a ten-minute grace: no 5 s deadline races the runner's last write.
    // Capture the real service so a test can refuse local inference at the process boundary.
    const createdModels = vi.spyOn(localModels, "createTransformers");
    const createdStore = vi.spyOn(resourceStores, "createResourceStore");
    try {
        server = createTestServer({
            rootDir,
            generationRandom: () => 0,
            generationAbortGraceMs: 10 * 60_000,
            scriptWorkerOptions: UNHURRIED_SCRIPT_WORKERS,
            cbsTimeLimits: UNHURRIED_CBS,
        });
        transformers = createdModels.mock.results[0].value;
        runnerStore = createdStore.mock.results[0].value;
        runnerFeed = createdStore.mock.calls[0][0].feed!;
    } finally {
        createdModels.mockRestore();
        createdStore.mockRestore();
    }
    node = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
    await new Promise<void>((resolve) => node.once("listening", () => resolve()));
    allowListenerOrigin(node);
    server.context.attachWebSocket(node);
    base = `http://127.0.0.1:${(node.address() as { port: number }).port}`;
    signer = await createSigner();
    await fetch(`${base}/api/login`, json({ password: "pw", publicKey: signer.publicJwk }));
    epoch = (
        (await (
            await fetch(`${base}/api/resources/ui`, { headers: { "risu-auth": await signer.jwt() } })
        ).json()) as any
    ).epoch;
    const presets = await single("presets");
    const modelPresets = await single("modelPresets");
    const modelProfiles = await single("modelProfiles");
    const personas = await single("personas");
    presetId = presets.data[0].id;
    modelPresetId = modelPresets.data[0].id;
    profileId = modelProfiles.data[0].id;
    personaId = personas.data[0].id;
    // The selected model preset's main and sub slots use one profile: a reverse proxy to the fake
    // provider. The prompt presets: the selected one and `Alpha`, the presetChain pick.
    const common = {
        maxResponse: 100,
        jailbreakToggle: false,
    };
    const seededPresets = await batch({
        ops: [
            {
                kind: "modelProfiles",
                id: "main",
                baseRevision: modelProfiles.revision,
                data: [
                    {
                        ...modelProfiles.data[0],
                        modelId: "reverse_proxy",
                        maxContext: 4000,
                        forceReplaceUrl: providerUrl,
                        customProxyRequestModel: "m",
                        customTokenizer: "tik",
                    },
                ],
            },
            {
                kind: "modelPresets",
                id: "main",
                baseRevision: modelPresets.revision,
                data: [{ ...modelPresets.data[0], mainSlot: { profileId }, subSlot: { profileId } }],
            },
            {
                kind: "presets",
                id: "main",
                baseRevision: presets.revision,
                data: [
                    {
                        ...presets.data[0],
                        ...common,
                        mainPrompt: "Main {{char}}",
                        formatingOrder: ["main", "description", "chats", "lastChat"],
                        regex: [editinputScript("preset"), editprocessScript],
                    },
                    {
                        ...presets.data[0],
                        ...common,
                        id: "preset-alpha",
                        name: "Alpha",
                        mainPrompt: "Alpha {{char}}",
                        formatingOrder: ["main", "chats", "lastChat"],
                        regex: [],
                    },
                ],
            },
        ],
    });
    expect(seededPresets.status, JSON.stringify(seededPresets.body)).toBe(200);
    await patchProviders({ useStreaming: true });
}, SLOW);

afterAll(async () => {
    await server?.close();
    node?.closeAllConnections();
    await new Promise((resolve) => node?.close(resolve));
    provider.closeAllConnections();
    provider.close();
    rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe("a send", () => {
    it(
        "reconstructs a runner checkpoint from the raw stream but sends the editoutput rewrite whole at the same chunk",
        async () => {
            const chaId = await seedCharacter({ name: "Ann", messages: [{ role: "user", data: "q", chatId: "u1" }] });
            vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
            let controller!: ReadableStreamDefaultController<Record<string, string>>;
            const stream = new ReadableStream<Record<string, string>>({
                start(value) {
                    controller = value;
                },
            });
            const upstream = vi.spyOn(server.context.llmRequests, "runInJob").mockImplementationOnce(async () => {
                await socketOpen;
                return { type: "streaming", result: stream };
            });
            const chunk = deferred<void>();
            const checkpoint = deferred<Extract<GenerationEvent, { type: "chatPatch" }>>();
            const pending = job(
                "send",
                chaId,
                {},
                {
                    streamedRows: true,
                    hooks: { ...NO_GENERATION_HOOKS, scripts: ["editoutput"] },
                    answerCallback: () => ({ outcome: "answered", value: "Processed reply" }),
                    onChunk: () => chunk.resolve(),
                    onEvent: (event) => {
                        if (event.type === "chatPatch" && event.streaming.some((entry) => entry.seq === 1)) {
                            checkpoint.resolve(event);
                        }
                    },
                },
            );
            const cleanup = cleanupOnce(() => {
                upstream.mockRestore();
                vi.useRealTimers();
            });
            try {
                controller.enqueue({ "0": "Raw reply" });
                await chunk.promise;
                await vi.advanceTimersByTimeAsync(3000);
                const raw = await checkpoint.promise;
                const { messageId, generationId } = raw.streaming[0];
                expect(raw.messages).toEqual([{ after: "u1", id: messageId, streamed: { generationId, seq: 1 } }]);
                controller.close();
                const result = await pending;
                expect(result.terminal?.type).toBe("done");
                const processed = result.events.find(
                    (event) =>
                        event.type === "chatPatch" &&
                        event.streaming.some(
                            (entry: { generationId: string; seq: number }) =>
                                entry.generationId === generationId && entry.seq === 1,
                        ) &&
                        event.messages?.some(
                            (entry: { message?: { data: string } }) => entry.message?.data === "Processed reply",
                        ),
                );
                expect(processed).toBeDefined();
                const initial = result.events.find(
                    (event) =>
                        event.type === "chatPatch" &&
                        event.messages?.some(
                            (entry: { message?: { chatId: string; data: string } }) =>
                                entry.message?.chatId === messageId && entry.message.data === "",
                        ),
                );
                const initialRow = initial.messages.find(
                    (entry: { message?: { chatId: string } }) => entry.message?.chatId === messageId,
                ).message;
                expect(processed.messages).toEqual([
                    { after: "u1", message: { ...initialRow, data: "Processed reply" } },
                ]);
                expect(processed.streaming).toEqual([{ messageId, generationId, seq: 1 }]);
            } finally {
                if (stream.locked) {
                    try {
                        controller.close();
                    } catch {
                        /* Already closed by the test. */
                    }
                }
                cleanup();
            }
        },
        SLOW,
    );

    it("ends with status 429 and the queue-full message when SupaMemory's local summarizer is refused", async () => {
        const memorySettings = (await single("memoryTranslateMedia")).data;
        const profile = (await single("modelProfiles")).data.find((item: any) => item.id === profileId);
        const summarizer = vi
            .spyOn(transformers, "runSummarizer")
            .mockRejectedValue(new localModels.TransformersQueueFullError());
        try {
            await patchSection("memoryTranslateMedia", {
                supaModelType: "distilbart",
                hypaV3: false,
                hypav2: false,
                hanuraiEnable: false,
                hypaMemory: false,
            });
            await patchPreset("modelProfiles", profileId, { maxContext: 600 });
            const chaId = await seedCharacter({
                name: "Ann",
                extra: { supaMemory: true },
                messages: Array.from({ length: 8 }, (_, i) => ({
                    role: i % 2 === 0 ? "user" : "char",
                    data: `Message ${i}: ` + "The party explored the forest and discussed the journey. ".repeat(12),
                    chatId: `m${i}`,
                })),
            });
            const { terminal } = await job("send", chaId, { input: "Continue", userMessageId: "next" });
            expect(summarizer).toHaveBeenCalled();
            expect(terminal).toMatchObject({
                type: "error",
                status: 429,
                message: "Local model queue is full",
            });
        } finally {
            summarizer.mockRestore();
            await patchSection("memoryTranslateMedia", memorySettings);
            await patchPreset("modelProfiles", profileId, { maxContext: profile.maxContext });
        }
    });

    it(
        "counts images with the runner's main profile and routed request model",
        async () => {
            const profile = (await single("modelProfiles")).data.find((item: any) => item.id === profileId);
            const quality = (await single("providers")).data.gptVisionQuality;
            // Replace only the provider request, after the real runner has assembled and counted.
            const upstream = vi.spyOn(server.context.llmRequests, "runInJob").mockResolvedValue({
                type: "success",
                result: "ok",
            });
            mkdirSync(path.join(rootDir, "save", "assets"), { recursive: true });
            writeFileSync(
                path.join(rootDir, "save", "assets", "token_image.png"),
                Buffer.from([0x89, 0x50, 0x4e, 0x47]),
            );
            const stored = await batch({
                ops: [
                    {
                        kind: "inlays",
                        id: "token-image",
                        baseRevision: null,
                        data: {
                            name: "token image",
                            ext: "png",
                            type: "image",
                            asset: "assets/token_image.png",
                            width: 1024,
                            height: 1024,
                        },
                    },
                ],
            });
            expect(stored.status).toBe(200);
            try {
                await patchProviders({ gptVisionQuality: "low" });
                for (const [modelId, expected] of [
                    ["gpt4om", 2833],
                    ["openrouter", 2833],
                    ["nanogpt", 308],
                ] as const) {
                    await patchPreset("modelProfiles", profileId, {
                        modelId,
                        maxContext: 10000,
                        openrouterRequestModel: "openai/gpt-4o-mini",
                        nanogptRequestModel: "openai/gpt-5.5",
                    });
                    const counts: number[] = [];
                    for (const suffix of ["", "{{inlay::token-image}} "]) {
                        const chaId = await seedCharacter({
                            name: "Image counter",
                            extra: { firstMessage: "", desc: "" },
                        });
                        const result = await job("send", chaId, { input: suffix + "photo", userMessageId: "photo" });
                        expect(result.terminal?.type, JSON.stringify(result.terminal)).toBe("done");
                        const messages = (await readChat(chaId)).data.message;
                        counts.push(messages.at(-1).generationInfo.inputTokens);
                        const prompt = upstream.mock.calls.at(-1)![0].arg.formated;
                        expect(prompt.find((message) => message.memo === "photo")?.multimodals?.length ?? 0).toBe(
                            suffix ? 1 : 0,
                        );
                    }
                    // Identical text and message overhead: the difference is exactly one image's cost.
                    expect(counts[1] - counts[0], modelId).toBe(expected);
                }
            } finally {
                upstream.mockRestore();
                await patchPreset("modelProfiles", profileId, profile);
                await patchProviders({ gptVisionQuality: quality });
            }
        },
        SLOW,
    );

    it(
        "runs the input stage (the input trigger, editinput in the worker, the user message under its id), streams the raw reply while generating, and reports preparing then generating then finishing before done",
        async () => {
            const chaId = await seedCharacter({
                name: "Ann",
                triggerscript: [trig("input", [ef("v2SetVar", { var: "seen", operator: "=", ...v("yes") })])],
            });
            const release = deferred<void>();
            const firstChunk = deferred<void>();
            const stages: string[] = [];
            mode = {
                chunks: ["Hel", "lo ", "there."],
                delayMs: 0,
                holdBeforeChunk: { index: 1, until: release.promise },
            };
            const before = bodies.length;
            const pending = job(
                "send",
                chaId,
                { input: "hi you", userMessageId: "user-1" },
                {
                    observeStages: true,
                    onEvent: (event) => {
                        if (event.type === "stage") stages.push(event.stage);
                    },
                    onChunk: () => firstChunk.resolve(),
                },
            );
            const cleanup = cleanupOnce(() => release.resolve());
            try {
                await Promise.race([firstChunk.promise, pending]);
                // The second chunk and stream end are still held: the spinner remains generating.
                expect(stages.at(-1)).toBe("generating");
            } finally {
                cleanup();
                await pending;
            }
            const { events, terminal } = await pending;
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            // Exact wire order also rejects consecutive duplicate stages.
            expect(
                events
                    .filter((event) => event.type === "stage" || event.type === "done")
                    .map((event) => (event.type === "stage" ? event.stage : event.type)),
            ).toEqual(["preparing", "generating", "finishing", "done"]);
            const chat = await readChat(chaId);
            expect(texts(chat)).toEqual(["user:hello you", "char:Hello there."]);
            const [user, reply] = chat.data.message;
            expect(user.chatId).toBe("user-1");
            expect(chat.data.scriptstate?.$seen).toBe("yes");
            expect(reply.saying).toBe(chaId);
            expect(reply.generationInfo).toMatchObject({ generationId: reply.chatId, model: "custom-m" });
            // The events: the bare accepted, the input stage's, the reply's, the chunks, one done.
            // The worker hold keeps preparing current until attach replays it and the bare accepted.
            const accepted = events.filter(
                (event) => event.type === "accepted" && (event.userMessageId || event.messageId),
            );
            expect(accepted.map((event) => [event.userMessageId, event.messageId, event.text])).toEqual([
                ["user-1", undefined, ""],
                [undefined, reply.chatId, ""],
            ]);
            // Each chunk rebuilds the whole text so far from its delta (the provider's events may coalesce on
            // the wire, and the parser re-sends the final text on `[DONE]`, as the client's does): growing,
            // numbered, whole.
            const chunks = streamedTexts(events);
            expect(chunks.length).toBeGreaterThanOrEqual(2);
            expect(chunks.map((event) => event.seq)).toEqual(chunks.map((_, i) => i + 1));
            for (let i = 1; i < chunks.length; i++) {
                expect(chunks[i].text.startsWith(chunks[i - 1].text)).toBe(true);
            }
            expect(chunks.at(-1)?.text).toBe("Hello there.");
            expect(
                chunks.every((event) => event.messageId === reply.chatId && event.generationId === reply.chatId),
            ).toBe(true);
            expect(terminal).toMatchObject({
                messageId: reply.chatId,
                revision: chat.revision,
            });
            expect((terminal as any).stopped).toBeUndefined();
            // The prompt the provider got holds the edited input; the reply's lock is released.
            expect(bodies.length).toBe(before + 1);
            expect(JSON.stringify(bodies.at(-1).messages)).toContain("hello you");
            expect(bodies.at(-1).model).toBe("m");
            expect(await clientSetText(chaId, reply.chatId, "edited by the tab")).toBe(200);
        },
        SLOW,
    );

    it(
        "skips the input stage for a user message the chat already holds under the id, and refuses the id of another role",
        async () => {
            const chaId = await seedCharacter({ name: "Ann" });
            mode = { chunks: ["One."], delayMs: 0 };
            expect((await job("send", chaId, { input: "hi", userMessageId: "user-1" })).terminal?.type).toBe("done");
            mode = { chunks: ["Two."], delayMs: 0 };
            const again = await job("send", chaId, { input: "hi", userMessageId: "user-1" });
            expect(again.terminal?.type).toBe("done");
            const chat = await readChat(chaId);
            expect(texts(chat)).toEqual(["user:hello", "char:One.", "char:Two."]);
            expect(again.events.some((event) => event.type === "accepted" && event.userMessageId)).toBe(false);
            const replyId = chat.data.message[1].chatId;
            const clash = await job("send", chaId, { input: "hi", userMessageId: replyId });
            expect(clash.terminal).toMatchObject({
                type: "error",
                status: 409,
                message: /another message/,
                stage: "input",
            });
            expect("requestId" in clash.terminal!).toBe(false);
            expect(texts(await readChat(chaId))).toHaveLength(3);
        },
        SLOW,
    );

    it(
        "continue extends the last reply, refuses a Lua editRequest write to the locked message, and closes the generation",
        async () => {
            const chaId = await seedCharacter({
                name: "Ann",
                messages: [
                    { role: "user", data: "q", chatId: "u1" },
                    { role: "char", data: "Again.", chatId: "r1" },
                ],
                triggerscript: [
                    trig("manual", [
                        {
                            type: "triggerlua",
                            code: `listenEdit('editRequest', function(id, data) setChat(id, -1, 'EDITED') return data end)`,
                        },
                    ]),
                ],
            });
            mode = { chunks: [" More", " text."], delayMs: 40 };
            // The job's Lua runs share one budget from the pool's `createBudget` (the test server's size).
            const runs = vi.spyOn(server.context.scriptWorkers, "runLua");
            onTestFinished(() => runs.mockRestore());
            const { events, terminal } = await job("continue", chaId);
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            // The regex-script run (`runScripts`, a `runLua` without a budget) is not a Lua run of the job.
            const budgets = runs.mock.calls.map(([, run]) => run?.budget).filter((budget) => budget !== undefined);
            expect(budgets.length).toBeGreaterThan(0);
            expect(new Set(budgets).size).toBe(1);
            expect(budgets[0].totalMs).toBe(UNHURRIED_SCRIPT_WORKERS.luaBudgetMs);
            expect(
                events
                    .filter((event) => event.type === "accepted" && event.messageId)
                    .map((event) => [event.messageId, event.text]),
            ).toEqual([["r1", "Again."]]);
            // Each chunk rebuilds the whole text so far, the old reply included (its delta keeps the
            // accepted text). The provider's two events may still coalesce on the wire under load (as in
            // the send test above), so the chunks are checked as a growing sequence that ends with the
            // whole reply, not as an exact list.
            const chunks = streamedTexts(events).map((chunk) => chunk.text);
            const distinct = chunks.filter((text, i) => text !== chunks[i - 1]);
            expect(distinct.length).toBeGreaterThanOrEqual(1);
            expect(distinct.every((text) => text.startsWith("Again. More"))).toBe(true);
            for (let i = 1; i < distinct.length; i++) {
                expect(distinct[i].startsWith(distinct[i - 1])).toBe(true);
            }
            expect(distinct.at(-1)).toBe("Again. More text.");
            const chat = await readChat(chaId);
            expect(texts(chat)).toEqual(["user:q", "char:Again. More text."]);
            expect(chat.data.message[1].chatId).toBe("r1");
            expect(terminal).toMatchObject({ messageId: "r1" });
            // One provider sample: the terminal carries no samples and the reply keeps no candidates.
            expect((terminal as any).alternatives).toBeUndefined();
            expect(chat.data.message[1].candidates).toBeUndefined();
            expect(await clientSetText(chaId, "r1", "tab edit")).toBe(200);
        },
        SLOW,
    );

    it(
        "an abort while the provider stalls keeps the text so far and releases the lock",
        async () => {
            const chaId = await seedCharacter({ name: "Ann", messages: [{ role: "user", data: "q", chatId: "u1" }] });
            const stalled = deferred<void>();
            mode = { chunks: ["First.", " Never."], delayMs: 0, holdBeforeChunk: { index: 1, until: stalled.promise } };
            // The clock stands still, so no periodic checkpoint stores the text: the abort's write must.
            const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
            // The deadline the DELETE fixes is this server's configured grace, not the 5 s default: the
            // timers set while the registry aborts the job are captured.
            const jobs = server.context.generationJobs;
            const abort = jobs.abort;
            const deadlines: unknown[] = [];
            const abortSpy = vi.spyOn(jobs, "abort").mockImplementation((...args) => {
                const realSetTimeout = globalThis.setTimeout;
                const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
                    callback: (...rest: unknown[]) => void,
                    ms?: number,
                    ...rest: unknown[]
                ) => {
                    deadlines.push(ms);
                    return realSetTimeout(callback, ms, ...rest);
                }) as typeof setTimeout);
                try {
                    return abort.apply(jobs, args);
                } finally {
                    timers.mockRestore();
                }
            });
            const cleanup = cleanupOnce(() => {
                abortSpy.mockRestore();
                clock.mockRestore();
                stalled.resolve();
            });
            try {
                // The DELETE fires on the first chunk; the second is held, so the terminal comes
                // without waiting for the provider.
                const { events, terminal } = await job("send", chaId, {}, { abortAfterChunks: 1 });
                expect(terminal).toMatchObject({ type: "error", status: 499, reason: "aborted" });
                expect(deadlines).toContain(10 * 60_000);
                expect(streamedTexts(events).map((chunk) => chunk.text)).toEqual(["First."]);
                expect(events.filter((event) => event.type === "done")).toHaveLength(0);
                const chat = await readChat(chaId);
                expect(texts(chat)).toEqual(["user:q", "char:First."]);
                expect(await clientSetText(chaId, chat.data.message.at(-1).chatId, "tab edit")).toBe(200);
            } finally {
                cleanup();
            }
        },
        SLOW,
    );

    it(
        "writes the checkpoint 3 s after a chunk while the provider stalls, before any other chunk",
        { tags: ["slow"], timeout: SLOW },
        async () => {
            const chaId = await seedCharacter({ name: "Ann" });
            const release = deferred<void>();
            mode = {
                chunks: ["First.", " Second."],
                delayMs: 0,
                holdBeforeChunk: { index: 1, until: release.promise },
            };
            const started = Date.now();
            const pending = job("send", chaId);
            try {
                // Read sequentially: the stored checkpoint persists while the provider is held.
                const deadline = started + 15_000;
                for (;;) {
                    const stored = texts(await readChat(chaId)).at(-1);
                    if (stored === "char:First.") {
                        // readReply starts its checkpoint clock after job creation. Pin the documented
                        // 3 s interval independently of production so an eager checkpoint fails.
                        expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
                        break;
                    }
                    if (Date.now() > deadline) {
                        throw new Error(`Checkpoint not stored while provider held: ${JSON.stringify(stored)}`);
                    }
                    await sleep(25);
                }
                release.resolve();
                const { terminal } = await pending;
                expect(terminal?.type).toBe("done");
                expect(texts(await readChat(chaId)).at(-1)).toBe("char:First. Second.");
            } finally {
                release.resolve();
                await pending;
            }
        },
    );

    it(
        "a group send answers with each member in order on the job's frozen configuration, with one terminal",
        async () => {
            const bob = await seedCharacter({ name: "Bob" });
            const cid = await seedCharacter({ name: "Cid" });
            const grp = await seedCharacter({
                name: "Grp",
                type: "group",
                members: [bob, cid],
                messages: [{ role: "user", data: "hello all", chatId: "u0" }],
            });
            mode = { chunks: ["Reply."], delayMs: 0 };
            const before = bodies.length;
            // While the first speaker's request runs, the stored profile changes its model.
            onRequest = async () => {
                onRequest = null;
                await patchPreset("modelProfiles", profileId, { customProxyRequestModel: "changed-during-job" });
            };
            try {
                const { events, terminal } = await job("group", grp, {}, { observeStages: true });
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                expect(events.filter((event) => event.type === "stage").map((event) => event.stage)).toEqual([
                    "preparing",
                    "generating",
                    "finishing",
                    "preparing",
                    "generating",
                    "finishing",
                ]);
                expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
                const chat = await readChat(grp);
                expect(texts(chat)).toEqual(["user:hello all", "char:Reply.", "char:Reply."]);
                expect(chat.data.message.slice(1).map((m: any) => m.saying)).toEqual([bob, cid]);
                expect(terminal).toMatchObject({ messageId: chat.data.message[2].chatId });
                expect(bodies.slice(before).map((body) => body.model)).toEqual(["m", "m"]);
                expect(JSON.stringify(bodies.at(-1).messages)).toContain("[Write the next reply only as Cid]");
            } finally {
                onRequest = null;
                await patchPreset("modelProfiles", profileId, { customProxyRequestModel: "m" });
            }
        },
        SLOW,
    );

    it(
        "a group send's completion notifications name the group's chat and use the group's name and custom message, not the speaking member's",
        async () => {
            const bob = await seedCharacter({ name: "Bob", extra: { customNotificationMessage: "Bob's own" } });
            const cid = await seedCharacter({ name: "Cid" });
            const grp = await seedCharacter({
                name: "The Crew",
                type: "group",
                members: [bob, cid],
                messages: [{ role: "user", data: "hello all", chatId: "u0" }],
                extra: { customNotificationMessage: "  Crew is done  " },
            });
            mode = { chunks: ["Reply."], delayMs: 0 };
            const ui = await single("ui");
            await patchSection("ui", { notification: true, language: "ko" });
            try {
                const first = await job("group", grp);
                expect(first.terminal?.type, JSON.stringify(first.terminal)).toBe("done");
                const custom = {
                    chaId: grp,
                    chatId: "k",
                    title: "Risuai",
                    body: "Crew is done",
                    url: `/chat/${grp}/k`,
                    tag: completionNotificationTag(grp, "k"),
                };
                // One per member's reply; neither names the member nor carries the reply.
                expect(notices(first.events, "notification").map((event) => event.payload)).toEqual([custom, custom]);

                // Without a custom message: the default sentence of the language setting, naming the group.
                const current = (await api(`/api/resources/characters/${grp}`)).body;
                const cleared = await batch({
                    ops: [
                        {
                            kind: "characters",
                            id: grp,
                            baseRevision: current.revision,
                            data: { ...current.data, customNotificationMessage: "" },
                        },
                    ],
                });
                expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
                const second = await job("group", grp);
                expect(second.terminal?.type, JSON.stringify(second.terminal)).toBe("done");
                const sentence = { ...custom, body: "The Crew의 메시지 처리가 완료되었습니다" };
                expect(notices(second.events, "notification").map((event) => event.payload)).toEqual([
                    sentence,
                    sentence,
                ]);
            } finally {
                await patchSection("ui", { notification: false, language: ui.data.language });
            }
        },
        SLOW,
    );

    it(
        "stores a non-streaming reply in one write",
        async () => {
            const chaId = await seedCharacter({ name: "Ann" });
            await patchProviders({ useStreaming: false });
            try {
                mode = { chunks: ["Plain reply."], delayMs: 0 };
                const { events, terminal } = await job("send", chaId, { input: "hi", userMessageId: "u" });
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                expect(events.filter((event) => event.type === "chunk")).toHaveLength(0);
                const chat = await readChat(chaId);
                expect(texts(chat)).toEqual(["user:hello", "char:Plain reply."]);
                expect(chat.data.message[1]).toMatchObject({ saying: chaId, chatId: (terminal as any).messageId });
                expect(await clientSetText(chaId, chat.data.message[1].chatId, "tab edit")).toBe(200);
            } finally {
                await patchProviders({ useStreaming: true });
            }
        },
        SLOW,
    );

    it(
        "a failing provider ends the job with its error, or writes it into the chat as a stopped send with inlayErrorResponse",
        async () => {
            const chaId = await seedCharacter({ name: "Ann", messages: [{ role: "user", data: "q", chatId: "u1" }] });
            mode = { chunks: [], delayMs: 0, status: 500 };
            const failed = await job("send", chaId);
            expect(failed.terminal).toMatchObject({ type: "error", status: 500, message: /upstream broke|500/ });
            expect(texts(await readChat(chaId))).toEqual(["user:q"]);
            // The error names where it failed: the request stage, the last attempt's history
            // row, and the provider's code, which the row holds too.
            const rows = await historyOf(failed.body.jobId);
            const errored = rows.filter((row) => row.status === "error");
            expect(errored.length).toBeGreaterThanOrEqual(1);
            expect(rows.every((row) => row.source === "send")).toBe(true);
            expect(failed.terminal).toMatchObject({
                stage: "request",
                requestId: errored[0].id,
                providerCode: "upstream_broke",
            });
            expect(errored[0].providerCode).toBe("upstream_broke");
            await patchProviders({ inlayErrorResponse: true });
            try {
                const inlaid = await job("send", chaId);
                expect(inlaid.terminal).toMatchObject({ type: "done", stopped: true });
                const chat = await readChat(chaId);
                expect(texts(chat)).toHaveLength(2);
                expect(chat.data.message[1].data).toMatch(/^```risuerror\n/);
                expect(chat.data.message[1].saying).toBe(chaId);
            } finally {
                await patchProviders({ inlayErrorResponse: false });
                mode = { chunks: ["x"], delayMs: 0 };
            }
        },
        SLOW,
    );

    it(
        "a start trigger's stop ends the send quietly as stopped, after the input stage, without a provider call",
        async () => {
            const chaId = await seedCharacter({
                name: "Ann",
                triggerscript: [trig("start", [ef("v2StopPromptSending")])],
            });
            const before = bodies.length;
            const { terminal } = await job("send", chaId, { input: "hi", userMessageId: "u" });
            expect(terminal).toMatchObject({ type: "done", stopped: true });
            expect(texts(await readChat(chaId))).toEqual(["user:hello"]);
            expect(bodies.length).toBe(before);
        },
        SLOW,
    );

    it("sends unchanged prompt messages without request-trigger errors when the character and modules have no triggers", async () => {
        const chaId = await seedCharacter({
            name: "Ann",
            triggerscript: [],
            messages: [{ role: "user", data: "question", chatId: "u1" }],
        });
        const preset = (await single("presets")).data.find((item: any) => item.id === presetId);
        await patchPreset("presets", presetId, {
            promptSettings: { ...preset.promptSettings, trimStartNewChat: true },
        });
        await patchProviders({ useStreaming: false });
        const error = vi.mocked(console.error);
        error.mockClear();
        const before = bodies.length;
        try {
            const { terminal } = await job("send", chaId);
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            expect(bodies.slice(before).map((body) => body.messages)).toEqual([
                [
                    { role: "system", content: "Main Ann\n\nDesc of Ann" },
                    { role: "assistant", content: "Hi from Ann" },
                    { role: "user", content: "question" },
                ],
            ]);
            expect(error).not.toHaveBeenCalled();
        } finally {
            await patchPreset("presets", presetId, { promptSettings: preset.promptSettings });
            await patchProviders({ useStreaming: true });
        }
    });

    it(
        "the request trigger's effect limit ends the job before any provider call",
        async () => {
            const chaId = await seedCharacter({
                name: "Ann",
                triggerscript: [
                    trig("request", [
                        ef("v2Loop"),
                        ef("v2SetVar", { var: "spin", operator: "+=", ...v("1") }, 1),
                        ef("v2EndIndent", { endOfLoop: true }, 1),
                    ]),
                ],
            });
            const before = bodies.length;
            const { terminal } = await job("send", chaId, { input: "hi", userMessageId: "u" });
            expect(terminal).toMatchObject({
                type: "error",
                message: /more than 100000 trigger effects/,
                stage: "script",
            });
            expect("requestId" in terminal!).toBe(false);
            expect(bodies.length).toBe(before);
            // The input stage's message stays; no reply was appended.
            expect(texts(await readChat(chaId))).toEqual(["user:hello"]);
        },
        SLOW,
    );

    it("failed preview and previewPrompt jobs leave the chat untouched even with inlayErrorResponse enabled", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        const providers = (await single("providers")).data;
        const profile = (await single("modelProfiles")).data.find((item: any) => item.id === profileId);
        try {
            await patchProviders({ inlayErrorResponse: true });
            await patchPreset("modelProfiles", profileId, { maxContext: 100 });
            const chaId = await seedCharacter({
                name: "Ann",
                messages: [{ role: "user", chatId: "u1", data: "A protected final question. ".repeat(200) }],
            });
            const before = await readChat(chaId);
            const requests = bodies.length;
            for (const kind of ["preview", "previewPrompt"]) {
                const result = await job(kind, chaId);
                expect(result.terminal, kind).toMatchObject({
                    type: "error",
                    message: expect.stringContaining("token"),
                });
                expect(await readChat(chaId)).toEqual(before);
            }
            expect(bodies).toHaveLength(requests);
        } finally {
            await patchProviders({ inlayErrorResponse: providers.inlayErrorResponse });
            await patchPreset("modelProfiles", profileId, { maxContext: profile.maxContext });
            vi.useRealTimers();
        }
    });

    it(
        "previewPrompt answers the provider body and preview the assembled messages, generating nothing",
        async () => {
            const chaId = await seedCharacter({ name: "Ann", messages: [{ role: "user", data: "q", chatId: "u1" }] });
            const before = bodies.length;
            const body = await job("previewPrompt", chaId, {}, { observeStages: true });
            expect(body.terminal?.type).toBe("done");
            expect(body.events.filter((event) => event.type === "stage").map((event) => event.stage)).toEqual([
                "preparing",
            ]);
            const parsed = JSON.parse((body.terminal as any).result);
            expect(parsed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/);
            expect(parsed.body.model).toBe("m");
            const preview = await job("preview", chaId, {}, { observeStages: true });
            expect(preview.terminal?.type).toBe("done");
            expect(preview.events.filter((event) => event.type === "stage").map((event) => event.stage)).toEqual([
                "preparing",
            ]);
            const formated = (preview.terminal as any).result.messages as { role: string; content: string }[];
            expect(formated[0]).toEqual({ role: "system", content: "Main Ann\n\nDesc of Ann" });
            expect(formated.at(-1)).toMatchObject({ role: "user", content: "q" });
            expect(bodies.length).toBe(before);
            expect(texts(await readChat(chaId))).toEqual(["user:q"]);
        },
        SLOW,
    );

    it(
        "presetChain runs the input stage on the admitted preset, picks the chain's preset for the prompt, tells the tab once, and toasts a missing name",
        async () => {
            const chaId = await seedCharacter({ name: "Ann" });
            mode = { chunks: ["Picked."], delayMs: 0 };
            await patchProviders({ presetChain: "Alpha" });
            try {
                const { events, terminal } = await job("send", chaId, { input: "hi there", userMessageId: "u" });
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                // The admitted preset's editinput regex ran (Alpha has none); the prompt is Alpha's.
                expect(texts(await readChat(chaId))).toEqual(["user:hello there", "char:Picked."]);
                expect(bodies.at(-1).messages[0].content).toBe("Alpha Ann");
                const picks = events.filter((event) => event.type === "preset");
                expect(picks).toEqual([expect.objectContaining({ presetId: "preset-alpha" })]);

                await patchProviders({ presetChain: "Alpha, Missing" });
                // `generationRandom` is 0: the first name, Alpha. A missing-only chain toasts and keeps the preset.
                await patchProviders({ presetChain: "Missing" });
                const missing = await job("preview", chaId);
                expect(missing.terminal?.type).toBe("done");
                expect(notices(missing.events, "alertToast").map((event) => event.payload.message)).toEqual([
                    "Cannot find preset: Missing",
                ]);
                expect(missing.events.some((event) => event.type === "preset")).toBe(false);
                expect(((missing.terminal as any).result.messages as any[])[0].content).toMatch(/^Main Ann/);
            } finally {
                await patchProviders({ presetChain: "" });
            }
        },
        SLOW,
    );

    it(
        "runs the plugin editinput hook as a callback: an answer replaces the text before the regex, a hook failure ends the send",
        async () => {
            const chaId = await seedCharacter({ name: "Ann" });
            mode = { chunks: ["Ok."], delayMs: 0 };
            const hooks = { ...NO_GENERATION_HOOKS, scripts: ["editinput" as const] };
            const callbacks: any[] = [];
            const answered = await job(
                "send",
                chaId,
                { input: "hi you", userMessageId: "u1" },
                {
                    hooks,
                    answerCallback: (event) => {
                        callbacks.push(event);
                        return { outcome: "answered", value: `plugin said ${event.payload.text}` };
                    },
                },
            );
            expect(answered.terminal?.type, JSON.stringify(answered.terminal)).toBe("done");
            expect(callbacks.map((event) => [event.name, event.payload])).toEqual([["editinput", { text: "hi you" }]]);
            expect(callbacks[0].targets).toMatchObject({ presetId, personaId, chatRef: { chaId, chatId: "k" } });
            expect(texts(await readChat(chaId))).toEqual(["user:plugin said hello you", "char:Ok."]);

            const failed = await job(
                "send",
                chaId,
                { input: "hi again", userMessageId: "u2" },
                { hooks, answerCallback: () => ({ outcome: "failed", failure: "hook", error: "plugin broke" }) },
            );
            expect(failed.terminal).toMatchObject({
                type: "error",
                status: 500,
                message: /plugin hook failed.*plugin broke/,
                stage: "script",
            });
            expect(texts(await readChat(chaId))).toHaveLength(2);
            // A failure of the callback itself (a barrier, a timeout, a disconnect) is latched as the
            // job's fatal failure: still the script's stage, not the input stage's.
            const barrier = await job(
                "send",
                chaId,
                { input: "hi once more", userMessageId: "u3" },
                {
                    hooks,
                    answerCallback: () => ({ outcome: "failed", failure: "barrier", error: "local changes discarded" }),
                },
            );
            expect(barrier.terminal).toMatchObject({
                type: "error",
                status: 500,
                message: /editinput callback failed \(barrier\)/,
                stage: "script",
            });
            expect("requestId" in barrier.terminal!).toBe(false);
            expect(texts(await readChat(chaId))).toHaveLength(2);
        },
        SLOW,
    );

    it(
        "a stream that breaks after its chunks ends the job as the request's failure, naming the request, with the text so far stored and the lock released",
        async () => {
            const chaId = await seedCharacter({ name: "Ann", messages: [{ role: "user", data: "q", chatId: "u1" }] });
            // The socket breaks only once the owner saw the first chunk: the runner read it before.
            const seen = deferred<void>();
            mode = { chunks: ["First.", " Never."], delayMs: 0, breakAfterChunks: 1, breakWhen: seen.promise };
            // The clock stands still, so no periodic checkpoint stores the text: the failure's write must.
            const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
            const cleanup = cleanupOnce(() => {
                clock.mockRestore();
                seen.resolve();
                mode = { chunks: ["x"], delayMs: 0 };
            });
            try {
                const { body, events, terminal } = await job("send", chaId, {}, { onChunk: () => seen.resolve() });
                expect(terminal).toMatchObject({ type: "error", status: 500, reason: "failed", stage: "request" });
                const rows = await historyOf(body.jobId);
                const errored = rows.filter((row) => row.status === "error");
                expect(errored).toHaveLength(1);
                expect((terminal as any).requestId).toBe(errored[0].id);
                // No error event in the body: no code on the event nor on the row.
                expect("providerCode" in terminal!).toBe(false);
                expect(errored[0].providerCode).toBeNull();
                expect(streamedTexts(events).map((chunk) => chunk.text)).toEqual(["First."]);
                const chat = await readChat(chaId);
                expect(texts(chat)).toEqual(["user:q", "char:First."]);
                expect(await clientSetText(chaId, chat.data.message.at(-1).chatId, "tab edit")).toBe(200);
            } finally {
                cleanup();
            }
        },
        SLOW,
    );

    it(
        "a group send whose second member's request fails names that request (a later speaker's own stage), after the first member's reply was stored",
        async () => {
            const bob = await seedCharacter({ name: "Bob" });
            const cid = await seedCharacter({ name: "Cid" });
            const grp = await seedCharacter({
                name: "Grp",
                type: "group",
                members: [bob, cid],
                messages: [{ role: "user", data: "hello all", chatId: "u0" }],
            });
            mode = { chunks: ["Reply."], delayMs: 0 };
            let requests = 0;
            onRequest = async () => {
                if (++requests === 2) {
                    mode = { chunks: [], delayMs: 0, status: 500 };
                }
            };
            try {
                const { body, events, terminal } = await job("group", grp);
                expect(terminal).toMatchObject({
                    type: "error",
                    status: 500,
                    stage: "request",
                    requestId: expect.stringMatching(UUID),
                    providerCode: "upstream_broke",
                });
                expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
                const rows = await historyOf(body.jobId);
                expect(rows.filter((row) => row.status === "success")).toHaveLength(1);
                const errored = rows.filter((row) => row.status === "error");
                expect(errored.length).toBeGreaterThanOrEqual(1);
                expect((terminal as any).requestId).toBe(errored[0].id);
                const chat = await readChat(grp);
                expect(texts(chat)).toEqual(["user:hello all", "char:Reply."]);
                expect(chat.data.message[1].saying).toBe(bob);
                expect(await clientSetText(grp, chat.data.message[1].chatId, "tab edit")).toBe(200);
            } finally {
                onRequest = null;
                mode = { chunks: ["x"], delayMs: 0 };
            }
        },
        SLOW,
    );
});

describe("the route", () => {
    it("accepts userMessageId only for send, continue, reroll, and group jobs", async () => {
        const chaId = await seedCharacter({ name: "Ann" });
        for (const kind of ["preview", "previewPrompt"]) {
            const res = await job(kind, chaId, { userMessageId: "u-x" });
            expect(res.status, kind).toBe(400);
            expect(res.body.error).toMatch(/userMessageId is only for send, continue, reroll, and group/);
        }
        for (const userMessageId of ["", "x".repeat(600)]) {
            const bad = await job("send", chaId, { userMessageId });
            expect(bad.status).toBe(400);
            expect(bad.body.error).toMatch(/userMessageId must be an id/);
        }
    });
});

describe("automatic translation of a send's messages", () => {
    /** Polls the chat until `condition` holds on it. */
    async function chatUntil(chaId: string, condition: (chat: any) => boolean) {
        let chat!: Awaited<ReturnType<typeof readChat>>;
        await waitFor(async () => condition((chat = await readChat(chaId)).data), undefined, 25);
        return chat;
    }
    const translations = (chat: { data: any }) =>
        chat.data.message.map((m: any) => [m.chatId, m.translation?.text ?? null]);
    const translating = (events: any[]) => notices(events, "translating").map((event) => event.payload);
    /** A deferred hold for the translation requests (the non-streaming ones); the sends run on. */
    function holdTranslations() {
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        onRequest = async () => {
            if (!bodies.at(-1).stream) {
                await released;
            }
        };
        return release;
    }

    beforeAll(async () => {
        await patchSection("memoryTranslateMedia", {
            translator: "ko",
            translatorType: "llm",
            llmTranslationTarget: "message",
        });
        plainAnswer = (body) => `번역: ${body.messages.at(-1).content}`;
    });
    afterAll(async () => {
        onRequest = null;
        plainAnswer = null;
        await patchSection("memoryTranslateMedia", { translator: "", translatorType: "google" });
    });
    afterEach(() => {
        onRequest = null;
    });

    it(
        "hands the reply and the user message over before done and tells the tab, without waiting: a second send runs while the translations are held, then they land",
        async () => {
            const chaId = await seedCharacter({ name: "Ann", chat: { autoTranslate: true } });
            mode = { chunks: ["Reply one."], delayMs: 0 };
            const before = bodies.length;
            const release = holdTranslations();
            try {
                const { events, terminal } = await job("send", chaId, { input: "hi you", userMessageId: "user-1" });
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                const chat = await readChat(chaId);
                const replyId = chat.data.message[1].chatId;
                // The notice names the replies first, then the user message, and precedes `done`.
                expect(translating(events)).toEqual([{ chaId, chatId: "k", messageIds: [replyId, "user-1"] }]);
                expect(
                    events.findIndex((event) => event.type === "notice" && event.kind === "translating"),
                ).toBeLessThan(events.findIndex((event) => event.type === "done"));
                expect(translations(chat)).toEqual([
                    ["user-1", null],
                    [replyId, null],
                ]);
                // The two translation requests reach the provider (non-streaming, the source text in each) and are held.
                await waitFor(() => bodies.length === before + 3);
                const held = bodies.slice(before + 1);
                expect(held.map((body) => body.stream ?? false)).toEqual([false, false]);
                expect(held.map((body) => body.messages.at(-1).content).sort()).toEqual(["Reply one.", "hello you"]);
                expect(server.context.translationRunner.runningCount()).toBe(2);

                // The send did not wait: another send on the same chat runs to its end meanwhile.
                mode = { chunks: ["Reply two."], delayMs: 0 };
                const second = await job("send", chaId, { input: "again", userMessageId: "user-2" });
                expect(second.terminal?.type, JSON.stringify(second.terminal)).toBe("done");
                expect(server.context.translationRunner.runningCount()).toBe(4);
                const secondReply = (second.terminal as any).messageId as string;
                expect(translating(second.events)).toEqual([
                    { chaId, chatId: "k", messageIds: [secondReply, "user-2"] },
                ]);
                expect(translations(await readChat(chaId))).toEqual([
                    ["user-1", null],
                    [replyId, null],
                    ["user-2", null],
                    [secondReply, null],
                ]);

                release();
                const done = await chatUntil(chaId, (data) => data.message.every((m: any) => m.translation));
                expect(translations(done)).toEqual([
                    ["user-1", "번역: hello you"],
                    [replyId, "번역: Reply one."],
                    ["user-2", "번역: again"],
                    [secondReply, "번역: Reply two."],
                ]);
                expect(done.data.message[1].translation).toMatchObject({
                    sourceHash: translationSourceHash("Reply one."),
                    targetLanguage: "ko",
                });
                await waitFor(() => server.context.translationRunner.runningCount() === 0);
                // A reply with a fresh translation is not handed over again (the user message's text is new).
                mode = { chunks: ["Reply three."], delayMs: 0 };
                const third = await job("continue", chaId);
                expect(third.terminal?.type).toBe("done");
                expect(translating(third.events)).toEqual([{ chaId, chatId: "k", messageIds: [secondReply] }]);
                const continued = await chatUntil(
                    chaId,
                    (data) => data.message.at(-1).translation?.text !== "번역: Reply two.",
                );
                expect(continued.data.message.at(-1).translation.text).toBe("번역: Reply two.Reply three.");
            } finally {
                release();
            }
        },
        SLOW,
    );

    it(
        "a group send hands every member's reply, then the user message it found in the chat; bot-only skips the user message; a chat that does not auto-translate hands nothing",
        async () => {
            const bob = await seedCharacter({ name: "Bob" });
            const cid = await seedCharacter({ name: "Cid" });
            const grp = await seedCharacter({
                name: "Grp",
                type: "group",
                members: [bob, cid],
                messages: [{ role: "user", data: "hello all", chatId: "u0" }],
                chat: { autoTranslate: true },
            });
            mode = { chunks: ["Reply."], delayMs: 0 };
            const { events, terminal } = await job("group", grp, { input: "hello all", userMessageId: "u0" });
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            const chat = await readChat(grp);
            const [, first, second] = chat.data.message.map((m: any) => m.chatId);
            expect(translating(events)).toEqual([{ chaId: grp, chatId: "k", messageIds: [first, second, "u0"] }]);
            await chatUntil(grp, (data) => data.message.every((m: any) => m.translation));
            expect(translations(await readChat(grp))).toEqual([
                ["u0", "번역: hello all"],
                [first, "번역: Reply."],
                [second, "번역: Reply."],
            ]);

            const botOnly = await seedCharacter({ name: "Ann", chat: { autoTranslate: true, translateBotOnly: true } });
            const only = await job("send", botOnly, { input: "hi", userMessageId: "u1" });
            expect(only.terminal?.type).toBe("done");
            const onlyReply = (only.terminal as any).messageId as string;
            expect(translating(only.events)).toEqual([{ chaId: botOnly, chatId: "k", messageIds: [onlyReply] }]);
            await chatUntil(botOnly, (data) => data.message[1].translation);
            expect(translations(await readChat(botOnly))).toEqual([
                ["u1", null],
                [onlyReply, "번역: Reply."],
            ]);

            const plain = await seedCharacter({ name: "Ann" });
            await waitFor(() => server.context.translationRunner.runningCount() === 0);
            const before = bodies.length;
            // The handover is decided by the runner before `done`, and a run it starts counts at once.
            const handOff = vi.spyOn(server.context.translationRunner, "handOff");
            try {
                const off = await job("send", plain, { input: "hi", userMessageId: "u1" });
                expect(off.terminal?.type).toBe("done");
                expect(translating(off.events)).toEqual([]);
                expect(handOff).toHaveBeenCalledTimes(1);
                expect(handOff.mock.results[0]).toEqual({ type: "return", value: [] });
                expect(server.context.translationRunner.runningCount()).toBe(0);
                expect(bodies.length).toBe(before + 1);
                expect(translations(await readChat(plain))).toEqual([
                    ["u1", null],
                    [(off.terminal as any).messageId, null],
                ]);
            } finally {
                handOff.mockRestore();
            }
        },
        SLOW,
    );

    it(
        "an aborted send hands nothing over: no notice, and neither its partial reply nor its user message is translated",
        async () => {
            const chaId = await seedCharacter({ name: "Ann", chat: { autoTranslate: true } });
            const stalled = deferred<void>();
            mode = { chunks: ["First.", " Never."], delayMs: 0, holdBeforeChunk: { index: 1, until: stalled.promise } };
            const before = bodies.length;
            // The handover is decided by the runner before it returns, and the job ends only then.
            const handOff = vi.spyOn(server.context.translationRunner, "handOff");
            const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
            const cleanup = cleanupOnce(() => {
                clock.mockRestore();
                handOff.mockRestore();
                stalled.resolve();
            });
            try {
                const { events, terminal } = await job(
                    "send",
                    chaId,
                    { input: "hi", userMessageId: "u1" },
                    { abortAfterChunks: 1 },
                );
                expect(terminal).toMatchObject({ type: "error", status: 499, reason: "aborted" });
                expect(translating(events)).toEqual([]);
                expect(handOff).not.toHaveBeenCalled();
                expect(bodies.length).toBe(before + 1);
                expect(server.context.translationRunner.runningCount()).toBe(0);
                expect(translations(await readChat(chaId))).toEqual([
                    ["u1", null],
                    [expect.any(String), null],
                ]);
                expect(texts(await readChat(chaId))).toEqual(["user:hello", "char:First."]);
            } finally {
                cleanup();
            }
        },
        SLOW,
    );
});

describe("chat activity without character writes", () => {
    const replyTime = Date.parse("2026-10-29T00:00:00Z");
    const readOwner = async (id: string) => (await api(`/api/resources/characters/${id}`)).body;
    const readSummary = async (id: string) =>
        (await api("/api/resources/read", { method: "POST", body: JSON.stringify({ chatSummaryCollections: [id] }) }))
            .body.chatSummaryCollections[0].chats[0];

    /** Observes the actual feed; a later seed is a barrier for all preceding publications. */
    async function activityFeed() {
        const ws = new WebSocket(
            `${base.replace("http", "ws")}/api/events/ws?risu-auth=${encodeURIComponent(await signer.jwt())}`,
        );
        const close = cleanupOnce(() => ws.close());
        const frames: EventFeedFrame[] = [];
        const listeners = new Set<() => void>();
        ws.onmessage = (message) => {
            frames.push(JSON.parse(String(message.data)));
            for (const listener of listeners) listener();
        };
        const until = (matches: (frame: EventFeedFrame) => boolean) =>
            new Promise<void>((resolve) => {
                const check = () => {
                    if (frames.some(matches)) {
                        listeners.delete(check);
                        resolve();
                    }
                };
                listeners.add(check);
                check();
            });
        await until((frame) => frame.type === "hello");
        return {
            frames,
            close,
            async drain() {
                const marker = await seedCharacter({ name: "Feed barrier" });
                await until(
                    (frame) =>
                        frame.type === "change" &&
                        frame.changes.resources.some((entry) => entry.kind === "characters" && entry.id === marker),
                );
            },
        };
    }

    it.each([
        { label: "send", kind: "send", streaming: true },
        { label: "streamed continue", kind: "continue", streaming: true },
        { label: "non-streamed continue", kind: "continue", streaming: false },
        { label: "reroll", kind: "reroll", streaming: true },
        { label: "group", kind: "group", streaming: true },
        { label: "preview", kind: "preview", streaming: true },
        { label: "previewPrompt", kind: "previewPrompt", streaming: true },
    ])(
        "$label keeps owner revisions and character feed entries unchanged while recording only written replies as activity",
        async ({ kind, streaming }) => {
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(replyTime);
            const restoreClock = cleanupOnce(() => vi.useRealTimers());
            const providers = (await single("providers")).data;
            const cleanup = cleanupOnce(() => {
                onRequest = null;
                plainAnswer = null;
                restoreClock();
            });
            let feed: Awaited<ReturnType<typeof activityFeed>> | undefined;
            try {
                await patchProviders({ useStreaming: streaming });
                mode = { chunks: ["Reply."], delayMs: 0 };
                const member = kind === "group" ? await seedCharacter({ name: "Member" }) : undefined;
                const owner = await seedCharacter({
                    name: "Owner",
                    type: member ? "group" : "character",
                    members: member ? [member] : undefined,
                    extra: { lastInteraction: replyTime + 86_400_000 },
                    messages: [
                        { role: "user", data: "earlier", chatId: "u0", time: 900 },
                        { role: kind === "continue" ? "char" : "user", data: "Before.", chatId: "tail", time: 100 },
                    ],
                });
                const before = await readOwner(owner);
                const memberBefore = member ? await readOwner(member) : undefined;
                const chatBefore = await readChat(owner);
                expect((await readSummary(owner)).lastMessageAt).toBe(100);
                feed = await activityFeed();
                const result = await job(kind, owner, kind === "send" ? { input: "hello", userMessageId: "u1" } : {});
                expect(result.terminal?.type, JSON.stringify(result.terminal)).toBe("done");
                expect(await readOwner(owner)).toEqual(before);
                if (member) expect(await readOwner(member)).toEqual(memberBefore);
                const after = await readChat(owner);
                if (kind === "preview" || kind === "previewPrompt") {
                    expect(after.data.message).toEqual(chatBefore.data.message);
                    expect((await readSummary(owner)).lastMessageAt).toBe(100);
                } else {
                    expect(after.data.message.at(-1)).toMatchObject({ role: "char", time: replyTime });
                    expect(after.data.message.at(-1).data).toContain("Reply.");
                    if (kind === "continue") expect(after.data.message.at(-1).chatId).toBe("tail");
                    expect((await readSummary(owner)).lastMessageAt).toBe(replyTime);
                }
                await feed.drain();
                expect(
                    feed.frames
                        .flatMap((frame) => (frame.type === "change" ? frame.changes.resources : []))
                        .filter((entry) => entry.kind === "characters" && (entry.id === owner || entry.id === member)),
                ).toEqual([]);
            } finally {
                feed?.close();
                cleanup();
                await patchProviders({ useStreaming: providers.useStreaming });
            }
        },
        SLOW,
    );

    it(
        "saves a concurrent character edit on the tab's original revision while a send is waiting for its provider",
        async () => {
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(replyTime);
            const entered = deferred<void>();
            const release = deferred<void>();
            const cleanup = cleanupOnce(() => {
                release.resolve();
                onRequest = null;
                vi.useRealTimers();
            });
            let running: ReturnType<typeof job> | undefined;
            try {
                mode = { chunks: ["Reply."], delayMs: 0 };
                const owner = await seedCharacter({ name: "Editable", extra: { lastInteraction: 500 } });
                const held = await readOwner(owner);
                onRequest = async () => {
                    entered.resolve();
                    await release.promise;
                };
                running = job("send", owner, { input: "hello", userMessageId: "u1" });
                await entered.promise;
                const saved = await batch({
                    ops: [
                        {
                            kind: "characters",
                            id: owner,
                            baseRevision: held.revision,
                            patch: { set: { desc: "edited while sending" } },
                        },
                    ],
                });
                expect(saved.status, JSON.stringify(saved.body)).toBe(200);
                release.resolve();
                const result = await running;
                expect(result.terminal?.type, JSON.stringify(result.terminal)).toBe("done");
                const after = await readOwner(owner);
                expect(after.revision).toBe(saved.body.results[0].revision);
                expect(after.data).toMatchObject({ desc: "edited while sending", lastInteraction: 500 });
                expect((await readSummary(owner)).lastMessageAt).toBe(replyTime);
            } finally {
                cleanup();
                await running;
            }
        },
        SLOW,
    );
});

describe("in-place reply candidates", () => {
    const oldInfo = { model: "old-model", generationId: "old-generation", inputTokens: 8, outputTokens: 2 };
    const oldPrompt = { promptName: "Old preset", promptToggles: [{ key: "tone", value: "quiet" }] };
    const oldTranslation = {
        text: "이전 응답",
        sourceHash: translationSourceHash("Previous reply."),
        targetLanguage: "ko",
        translatedAt: 1,
    };
    const baseline = { $x: "0", $edited: "0" };
    const after = { $x: "1", $edited: "1" };
    const carrier = (extra: Record<string, unknown> = {}) => ({
        role: "char",
        chatId: "r",
        data: "Previous reply.",
        name: "Kept name",
        disabled: false,
        isComment: false,
        generationInfo: { ...oldInfo, context: { report: "must not enter the candidate copy" } },
        promptInfo: { ...oldPrompt, promptText: [{ role: "system", content: "OLD FULL PROMPT" }] },
        translation: oldTranslation,
        scriptstateCheckpoint: { before: baseline, after },
        ...extra,
    });
    const setVar = (name: string, value: string) => ef("v2SetVar", { var: name, operator: "=", ...v(value) });
    const seed = (extra: Partial<Parameters<typeof seedCharacter>[0]> = {}) =>
        seedCharacter({
            name: "Candidate owner",
            messages: [{ role: "user", chatId: "u", data: "Question." }, carrier()],
            chat: { scriptstate: { ...after, $edited: "9" } },
            ...extra,
        });
    const edit = async (chaId: string, ops: ChatOp[]) => {
        const current = await readChat(chaId);
        const result = await batch({
            chats: [{ characterId: chaId, chatId: "k", baseRevision: current.revision, ops }],
        });
        expect(result.status, JSON.stringify(result.body)).toBe(200);
    };
    const storedCarrier = async (chaId: string) =>
        (await readChat(chaId)).data.message.find((entry: any) => entry.chatId === "r");
    const observeWrites = (expected?: { chaId: string; rollback: boolean }) => {
        const feed: Extract<ChangeFeedEvent, { type: "change" }>[] = [];
        const unsubscribe = runnerFeed.subscribe((event) => {
            if (event.type === "change") feed.push(event);
        });
        onTestFinished(unsubscribe);
        // Observe the real SQLite store's public acknowledgements without replacing its behavior.
        const writes = vi.spyOn(runnerStore, "applyChanges");
        onTestFinished(() => writes.mockRestore());
        return () => {
            const outcomes = writes.mock.results
                .filter((result) => result.type === "return")
                .flatMap((result) => result.value.chats.flatMap((chat: any) => chat.checkpoints ?? []));
            expect(outcomes.length).toBeGreaterThan(0);
            expect(
                outcomes.every((outcome) => outcome === "applied"),
                JSON.stringify(outcomes),
            ).toBe(true);
            if (expected) {
                const calls = writes.mock.calls
                    .map(([changes, options], index) => ({
                        groups: (changes.chats ?? []) as ChatGroup[],
                        options,
                        result: writes.mock.results[index],
                    }))
                    .filter(({ groups }) => groups.some((group) => group.characterId === expected.chaId));
                const begin = calls.find(({ groups }) =>
                    groups.some((group) => group.ops.some((op) => op.op === "begin" && op.id === "r")),
                )!;
                const final = calls.findLast(({ groups }) =>
                    groups.some((group) =>
                        group.ops.some(
                            (op) => op.op === "setMessage" && op.message.chatId === "r" && op.generation?.final,
                        ),
                    ),
                )!;
                const control = {
                    characterId: expected.chaId,
                    chatId: "k",
                    messageId: "r",
                    generationId: expect.any(String),
                };
                expect(begin.options).toMatchObject({
                    jobToken: expect.any(String),
                    changes: true,
                    committed: expect.any(Function),
                    rerollAttempt: { ...control, action: "begin" },
                });
                expect(final.options).toMatchObject({
                    jobToken: begin.options!.jobToken,
                    changes: true,
                    committed: expect.any(Function),
                    ...(expected.rollback ? { rerollAttempt: { ...control, action: "rollback" } } : {}),
                });
                for (const [call, revision, texts] of [
                    [begin, 1, ["Previous reply.", ""]],
                    [final, 2, expected.rollback ? undefined : ["Previous reply.", "New reply."]],
                ] as const) {
                    expect(call.result.type).toBe("return");
                    const committedRevision = call.result.value.chats[0].revision;
                    const entry = feed
                        .flatMap((event) => event.changes.chats)
                        .find(
                            (chat) =>
                                chat.id === "k" &&
                                chat.characterId === expected.chaId &&
                                chat.revision === committedRevision,
                        )!;
                    expect(entry).toBeDefined();
                    const row = entry.patch?.messages?.find(
                        ({ message }) => (message as { chatId: string }).chatId === "r",
                    )?.message as { candidates?: { data: string }[]; candidatesRevision?: number } | undefined;
                    expect(row).toBeDefined();
                    expect(row!.candidatesRevision).toBe(revision);
                    expect(row!.candidates?.map((candidate) => candidate.data)).toEqual(texts);
                }
            }
        };
    };
    let providers: Record<string, unknown>;
    let preset: Record<string, unknown>;
    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-11-05T00:00:00Z"));
        providers = (await single("providers")).data;
        preset = (await single("presets")).data.find((entry: any) => entry.id === presetId);
        await patchProviders({
            useStreaming: true,
            autoContinueChat: false,
            inlayErrorResponse: false,
            presetChain: "",
            requestRetrys: 0,
        });
        mode = { chunks: ["New reply."], delayMs: 0 };
        onRequest = null;
        plainAnswer = null;
    });
    afterEach(async () => {
        onRequest = null;
        plainAnswer = null;
        await patchProviders(providers);
        await patchPreset("presets", presetId, preset);
        vi.useRealTimers();
    });

    it("sends raw in-place reroll checkpoints by stream reference and the completed candidates as a whole row", async () => {
        const chaId = await seed();
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
        let controller!: ReadableStreamDefaultController<Record<string, string>>;
        const stream = new ReadableStream<Record<string, string>>({
            start(value) {
                controller = value;
            },
        });
        const upstream = vi.spyOn(server.context.llmRequests, "runInJob").mockImplementationOnce(async () => {
            await socketOpen;
            return { type: "streaming", result: stream };
        });
        const chunk = deferred<void>();
        const checkpoint = deferred<Extract<GenerationEvent, { type: "chatPatch" }>>();
        const pending = job(
            "reroll",
            chaId,
            { rerollMessageId: "r" },
            {
                streamedRows: true,
                onChunk: () => chunk.resolve(),
                onEvent: (event) => {
                    if (
                        event.type === "chatPatch" &&
                        event.streaming.some((entry) => entry.messageId === "r" && entry.seq === 1)
                    )
                        checkpoint.resolve(event);
                },
            },
        );
        const cleanup = cleanupOnce(() => {
            upstream.mockRestore();
            vi.useRealTimers();
        });
        try {
            controller.enqueue({ "0": "New reply." });
            await chunk.promise;
            await vi.advanceTimersByTimeAsync(3000);
            const raw = await checkpoint.promise;
            const generationId = raw.streaming[0].generationId;
            expect(raw.messages).toEqual([{ after: "u", id: "r", streamed: { generationId, seq: 1 } }]);
            controller.close();
            const result = await pending;
            expect(result.terminal).toMatchObject({
                type: "done",
                epoch,
                messageId: "r",
                revision: (await readChat(chaId)).revision,
            });
            expect(result.terminal).not.toHaveProperty("alternatives");
            const patches = result.events.filter((event) => event.type === "chatPatch");
            const final = patches.at(-1);
            expect(final.streaming).toEqual([]);
            expect(final.messages).toHaveLength(1);
            expect(final.messages[0]).not.toHaveProperty("streamed");
            expect(final.messages[0]).toMatchObject({
                after: "u",
                message: {
                    chatId: "r",
                    data: "New reply.",
                    selected: 1,
                    candidatesRevision: 2,
                    candidates: [
                        { id: expect.any(String), data: "Previous reply." },
                        { id: expect.any(String), data: "New reply." },
                    ],
                },
            });
            expect(final.messages[0].message).toEqual(await storedCarrier(chaId));
            const beginIndex = patches.findIndex((event) =>
                event.messages?.some(
                    (entry: { message?: { chatId: string; candidatesRevision?: number } }) =>
                        entry.message?.chatId === "r" && entry.message.candidatesRevision === 1,
                ),
            );
            expect(beginIndex).toBeGreaterThanOrEqual(0);
            expect(patches[beginIndex].messages).toEqual([
                {
                    after: "u",
                    message: expect.objectContaining({
                        chatId: "r",
                        data: "",
                        selected: 1,
                        candidatesRevision: 1,
                        candidates: [
                            expect.objectContaining({ data: "Previous reply." }),
                            { id: expect.any(String), data: "" },
                        ],
                    }),
                },
            ]);
            expect(patches.indexOf(raw)).toBeGreaterThan(beginIndex);
        } finally {
            try {
                controller.close();
            } catch {
                /* Already closed by the test. */
            }
            cleanup();
            await pending;
        }
    });

    it("streams into the same reply, snapshots bounded metadata, restores unchanged variables before start, and refreshes the selected candidate on completion", async () => {
        const chaId = await seed({
            triggerscript: [trig("start", [setVar("seen", "{{getvar::x}}/{{getvar::edited}}"), setVar("x", "2")])],
        });
        await patchPreset("presets", presetId, { mainPrompt: "History {{history}} Characters {{charhistory}}" });
        const release = deferred<void>();
        const first = deferred<void>();
        const cleanup = cleanupOnce(() => release.resolve());
        mode = { chunks: ["New ", "reply."], delayMs: 0, holdBeforeChunk: { index: 1, until: release.promise } };
        const assertApplied = observeWrites({ chaId, rollback: false });
        const beforeRequests = bodies.length;
        const pending = job("reroll", chaId, { rerollMessageId: "r" }, { onChunk: () => first.resolve() });
        try {
            await Promise.race([first.promise, pending]);
            const during = await storedCarrier(chaId);
            expect(during.chatId).toBe("r");
            expect(during.candidatesRevision).toBe(1);
            expect(during.selected).toBe(1);
            expect(during.candidates[0]).toEqual({
                id: expect.stringMatching(/^[a-zA-Z0-9]{1,32}$/),
                data: "Previous reply.",
                generationInfo: oldInfo,
                promptInfo: oldPrompt,
                translation: oldTranslation,
                scriptstateAfter: after,
            });
            expect(await clientSetText(chaId, "r", "foreign edit")).toBe(409);
            const sent = JSON.stringify(bodies.slice(beforeRequests));
            expect(sent).toContain("Question.");
            expect(sent).not.toContain("Previous reply.");
            expect(sent).not.toContain("candidates");
            release.resolve();
            const { terminal, events } = await pending;
            expect(terminal, JSON.stringify(terminal)).toMatchObject({ type: "done", messageId: "r" });
            expect(streamedTexts(events).at(-1)).toMatchObject({ messageId: "r", text: "New reply." });
            const chat = await readChat(chaId);
            expect(texts(chat)).toEqual(["user:Question.", "char:New reply."]);
            const result = await storedCarrier(chaId);
            expect(result).toMatchObject({
                name: "Kept name",
                disabled: false,
                isComment: false,
                candidatesRevision: 2,
                selected: 1,
            });
            expect(result.candidates.map((entry: any) => entry.id)).toEqual(
                during.candidates.map((entry: any) => entry.id),
            );
            expect(new Set(result.candidates.map((entry: any) => entry.id)).size).toBe(2);
            const { context: _context, ...info } = result.generationInfo;
            const { promptText: _text, ...prompt } = result.promptInfo;
            expect(info).toMatchObject({
                model: "custom-m",
                generationId: events.find((event) => event.type === "accepted" && event.messageId === "r").generationId,
            });
            expect(result.candidates[1]).toEqual({
                id: during.candidates[1].id,
                data: "New reply.",
                generationInfo: info,
                promptInfo: prompt,
                scriptstateAfter: { $x: "2", $edited: "9", $seen: "0/9" },
            });
            expect(result.scriptstateCheckpoint).toEqual({
                before: baseline,
                after: { $x: "2", $edited: "9", $seen: "0/9" },
            });
            expect(result.translation).toBeUndefined();
            assertApplied();
            expect(await clientSetText(chaId, "r", "manual edit")).toBe(200);
        } finally {
            cleanup();
            await pending;
        }
    });

    it("preserves non-streaming carrier fields and excludes older candidates from ordinary CBS history", async () => {
        await patchProviders({ useStreaming: false });
        const chaId = await seed();
        const rerolled = await job("reroll", chaId, { rerollMessageId: "r" });
        expect(rerolled.terminal).toMatchObject({ type: "done", messageId: "r" });
        const reply = await storedCarrier(chaId);
        expect(reply).toMatchObject({
            name: "Kept name",
            disabled: false,
            isComment: false,
            selected: 1,
            scriptstateCheckpoint: { before: baseline },
        });
        expect(reply.candidates.map((entry: any) => entry.data)).toEqual(["Previous reply.", "New reply."]);
        await patchPreset("presets", presetId, { mainPrompt: "History {{history}} Characters {{charhistory}}" });
        const beforeRequests = bodies.length;
        const sent = await job("send", chaId, { input: "Next question", userMessageId: "u2" });
        expect(sent.terminal?.type).toBe("done");
        const prompt = JSON.stringify(bodies.slice(beforeRequests));
        expect(prompt).toContain("New reply.");
        expect(prompt).not.toContain("Previous reply.");
        expect(prompt).not.toContain("candidates");
        const old = await storedCarrier(chaId);
        expect(old.scriptstateCheckpoint).toBeUndefined();
        expect(old.candidates.map((entry: any) => entry.data)).toEqual(["Previous reply.", "New reply."]);
        expect(old.candidates.every((entry: any) => entry.scriptstateAfter === undefined)).toBe(true);
    });

    it("keeps trigger appends after the carrier, exposes the history view to Lua and CBS, and removes obsolete checkpoints on success and failure", async () => {
        for (const fail of [false, true]) {
            const chaId = await seed({
                triggerscript: [
                    trig("manual", [
                        {
                            type: "triggerlua",
                            code: `function onStart(id) addChat(id, "user", "Lua saw " .. tostring(getChatLength(id))) end`,
                        },
                    ]),
                    trig("start", [ef("v2Impersonate", { role: "user", ...v("Trigger appended") })]),
                ],
            });
            mode = fail ? { chunks: [], delayMs: 0, status: 400 } : { chunks: ["New reply."], delayMs: 0 };
            const assertApplied = observeWrites();
            const beforeRequests = bodies.length;
            const result = await job("reroll", chaId, { rerollMessageId: "r" });
            expect(result.terminal, JSON.stringify(result.terminal)).toMatchObject({ type: fail ? "error" : "done" });
            const chat = await readChat(chaId);
            expect(chat.data.message.map((entry: any) => entry.chatId).slice(0, 2)).toEqual(["u", "r"]);
            expect(chat.data.message.slice(2).map((entry: any) => entry.data)).toEqual([
                "Lua saw 1",
                "Trigger appended",
            ]);
            const prompt = JSON.stringify(bodies.slice(beforeRequests));
            expect(prompt).toContain("Lua saw 1");
            expect(prompt).not.toContain("Previous reply.");
            const reply = await storedCarrier(chaId);
            expect(reply.data).toBe(fail ? "Previous reply." : "New reply.");
            expect(reply.scriptstateCheckpoint).toBeUndefined();
            expect(reply.candidates?.some((entry: any) => entry.scriptstateAfter !== undefined) ?? false).toBe(false);
            if (!fail)
                expect(reply.candidates.map((entry: any) => entry.data)).toEqual(["Previous reply.", "New reply."]);
            assertApplied();
            expect(await clientSetText(chaId, "r", "after end")).toBe(200);
        }
    });

    it("writes the previous candidate back on stream abort and request failure while undoing only the attempt's variables", async () => {
        for (const failure of ["abort", "request"] as const) {
            const chaId = await seed({
                triggerscript: [trig("start", [setVar("x", "2"), setVar("introduced", "attempt")])],
            });
            const release = deferred<void>();
            const cleanup = cleanupOnce(() => release.resolve());
            mode =
                failure === "request"
                    ? { chunks: [], delayMs: 0, status: 400 }
                    : {
                          chunks: ["Partial", " must vanish"],
                          delayMs: 0,
                          holdBeforeChunk: { index: 1, until: release.promise },
                      };
            onRequest = async () => {
                expect(await clientSetText(chaId, "r", "foreign edit")).toBe(409);
                await edit(chaId, [{ op: "meta", merge: { scriptstate: { $edited: "external" } } }]);
            };
            const assertApplied = observeWrites({ chaId, rollback: true });
            try {
                const result = await job(
                    "reroll",
                    chaId,
                    { rerollMessageId: "r" },
                    failure === "abort" ? { abortAfterChunks: 1 } : {},
                );
                expect(result.terminal).toMatchObject({
                    type: "error",
                    reason: failure === "abort" ? "aborted" : "failed",
                });
                const reply = await storedCarrier(chaId);
                expect(reply).toMatchObject({
                    data: "Previous reply.",
                    generationInfo: oldInfo,
                    promptInfo: oldPrompt,
                    translation: oldTranslation,
                    scriptstateCheckpoint: { before: baseline, after },
                    candidatesRevision: 2,
                });
                expect(reply.candidates).toBeUndefined();
                expect(reply.selected).toBeUndefined();
                expect((await readChat(chaId)).data.scriptstate).toEqual({ $x: "1", $edited: "external" });
                assertApplied();
                expect(await clientSetText(chaId, "r", "after rollback")).toBe(200);
            } finally {
                onRequest = null;
                cleanup();
            }
        }
    });

    it("keeps all prior candidates when an output trigger removes the carrier and targets inlaid errors through trailing comments", async () => {
        const chaId = await seed({
            messages: [
                { role: "user", chatId: "u", data: "Question." },
                carrier({
                    candidates: [
                        { id: "a", data: "First" },
                        { id: "b", data: "Previous reply." },
                    ],
                    selected: 1,
                }),
            ],
            triggerscript: [
                trig("output", [ef("v2CutChat", { startType: "value", start: "0", endType: "value", end: "1" })]),
            ],
        });
        const removed = await job("reroll", chaId, { rerollMessageId: "r" });
        expect(removed.terminal?.type).toBe("done");
        const restored = await storedCarrier(chaId);
        expect(restored).toMatchObject({ data: "Previous reply.", selected: 1 });
        expect(restored.candidates.map((entry: any) => [entry.id, entry.data])).toEqual([
            ["a", "First"],
            ["b", "Previous reply."],
        ]);
        await patchProviders({ inlayErrorResponse: true });
        for (const role of ["char", "user"]) {
            const id = await seed({
                messages: [
                    { role: "user", chatId: "u", data: "Question." },
                    carrier(),
                    { role, chatId: "comment", data: "Untouched comment", isComment: true },
                ],
            });
            mode = { chunks: [], delayMs: 0, status: 400 };
            const result = await job("reroll", id, { rerollMessageId: "r" });
            expect(result.terminal).toMatchObject({ type: "done", messageId: "r" });
            const chat = await readChat(id);
            expect(chat.data.message.map((entry: any) => entry.chatId)).toEqual(["u", "r", "comment"]);
            expect(chat.data.message[2].data).toBe("Untouched comment");
            const reply = chat.data.message[1];
            expect(reply.data).toContain("```risuerror");
            expect(reply.candidates[0].data).toBe("Previous reply.");
            expect(reply.candidates[reply.selected].data).toBe(reply.data);
        }
    });

    it.each(["an earlier checkpointed candidate", "a checkpointed candidate after text-only selection and reload"])(
        "restores the turn baseline before rerolling %s",
        async (scenario) => {
            const textOnly = scenario.includes("text-only");
            const chaId = await seed({
                messages: [
                    { role: "user", chatId: "u", data: "Question." },
                    carrier({
                        data: textOnly ? "A" : "B",
                        selected: textOnly ? 0 : 1,
                        candidates: [
                            { id: "A", data: "A", scriptstateAfter: { $x: "1" } },
                            { id: "B", data: "B", ...(textOnly ? {} : { scriptstateAfter: { $x: "2" } }) },
                        ],
                        scriptstateCheckpoint: { before: { $x: "0" }, after: { $x: textOnly ? "1" : "2" } },
                    }),
                ],
                chat: { scriptstate: { $x: textOnly ? "1" : "2" } },
                triggerscript: [trig("start", [setVar("seen", "{{getvar::x}}")])],
            });
            if (textOnly) {
                await edit(chaId, [
                    {
                        op: "selectCandidate",
                        messageId: "r",
                        candidateId: "B",
                        expect: { candidatesRevision: (await storedCarrier(chaId)).candidatesRevision },
                    },
                ]);
                // A fresh API read, as a reloaded tab obtains: no old in-memory baseline is reused.
                const reloaded = await readChat(chaId);
                expect(reloaded.data.message.at(-1).scriptstateCheckpoint).toEqual({ before: { $x: "0" } });
                expect(reloaded.data.scriptstate).toEqual({ $x: "1" });
            }
            await edit(chaId, [
                {
                    op: "selectCandidate",
                    messageId: "r",
                    candidateId: "A",
                    expect: { candidatesRevision: (await storedCarrier(chaId)).candidatesRevision },
                },
            ]);
            expect((await storedCarrier(chaId)).scriptstateCheckpoint).toEqual({
                before: { $x: "0" },
                after: { $x: "1" },
            });
            const result = await job("reroll", chaId, { rerollMessageId: "r" });
            expect(result.terminal, JSON.stringify(result.terminal)).toMatchObject({ type: "done", messageId: "r" });
            expect((await readChat(chaId)).data.scriptstate).toEqual({ $x: "0", $seen: "0" });
            expect((await storedCarrier(chaId)).scriptstateCheckpoint.before).toEqual({ $x: "0" });
        },
    );

    it("takes a missing baseline at reroll start, retains a text-only candidate baseline without restoring, and checkpoints a reply without generation metadata", async () => {
        for (const checkpoint of [undefined, { before: { $x: "baseline" } }]) {
            const chaId = await seed({
                messages: [
                    { role: "user", chatId: "u", data: "Question." },
                    carrier({
                        scriptstateCheckpoint: checkpoint,
                        ...(checkpoint
                            ? {
                                  candidates: [
                                      { id: "older", data: "Earlier", scriptstateAfter: baseline },
                                      { id: "text-only", data: "Previous reply." },
                                  ],
                                  selected: 1,
                                  generationInfo: undefined,
                                  promptInfo: undefined,
                                  translation: undefined,
                              }
                            : {}),
                    }),
                ],
                triggerscript: [trig("start", [setVar("seen", "{{getvar::x}}")])],
            });
            const result = await job("reroll", chaId, { rerollMessageId: "r" });
            expect(result.terminal?.type).toBe("done");
            const reply = await storedCarrier(chaId);
            expect(reply.scriptstateCheckpoint).toEqual({
                before: checkpoint?.before ?? { $x: "1", $edited: "9" },
                after: { $x: "1", $edited: "9", $seen: "1" },
            });
        }
        const chaId = await seedCharacter({
            name: "No generation info",
            extra: { viewScreen: "emotion", emotionImages: [] },
            chat: { scriptstate: { $base: "kept" } },
            triggerscript: [trig("input", [setVar("input", "kept")]), trig("start", [setVar("reply", "written")])],
        });
        const sent = await job("send", chaId, { input: "Question.", userMessageId: "u" });
        expect(sent.terminal?.type).toBe("done");
        const reply = (await readChat(chaId)).data.message.at(-1);
        expect(reply.scriptstateCheckpoint).toEqual({
            before: { $base: "kept", $input: "kept" },
            after: { $base: "kept", $input: "kept", $reply: "written" },
        });
        const withoutInfo = await seed({
            messages: [{ role: "user", chatId: "u", data: "Question." }, carrier({ generationInfo: undefined })],
            triggerscript: [trig("start", [setVar("x", "2"), ef("v2StopPromptSending")])],
        });
        const stopped = await job("continue", withoutInfo, { continueMessageId: "r" });
        expect(stopped.terminal).toMatchObject({ type: "done", stopped: true });
        const continued = await storedCarrier(withoutInfo);
        expect(continued.generationInfo).toBeUndefined();
        expect(continued.scriptstateCheckpoint).toEqual({ before: baseline, after: { $x: "2", $edited: "9" } });
    });

    it("persists extra provider samples as text-only candidates and bounds count, aggregate bytes, previous replies, and snapshots with coded notices", async () => {
        await patchProviders({ useStreaming: false, genTime: 3 });
        const profile = (await single("modelProfiles")).data.find((entry: any) => entry.id === profileId);
        await patchPreset("modelProfiles", profileId, { modelId: "gpt4om" });
        const fetchProvider = globalThis.fetch;
        const redirected = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            return fetchProvider(url.startsWith("https://api.openai.com/") ? profile.forceReplaceUrl : input, init);
        });
        onTestFinished(async () => {
            redirected.mockRestore();
            await patchPreset("modelProfiles", profileId, profile);
        });
        mode = { chunks: ["Selected sample."], samples: ["Second sample.", "Third sample."], delayMs: 0 };
        const chaId = await seedCharacter({
            name: "Samples",
            messages: [{ role: "user", chatId: "u", data: "Question." }],
            triggerscript: [
                {
                    ...trig("manual", [
                        ef("v2Command", v("/send From command")),
                        ef("v2Command", v("/multisend Next sample")),
                    ]),
                    comment: "commands",
                },
            ],
        });
        const sampled = await job("send", chaId);
        expect(sampled.terminal).toMatchObject({
            type: "done",
            epoch,
            revision: (await readChat(chaId)).revision,
            messageId: expect.any(String),
        });
        expect(sampled.terminal).not.toHaveProperty("alternatives");
        const reply = (await readChat(chaId)).data.message.at(-1);
        expect(reply.selected).toBe(0);
        expect(reply.candidates.map((entry: any) => entry.data)).toEqual([
            "Selected sample.",
            "Second sample.",
            "Third sample.",
        ]);
        expect(reply.candidates.slice(1)).toEqual([
            { id: expect.any(String), data: "Second sample." },
            { id: expect.any(String), data: "Third sample." },
        ]);
        expect(new Set(reply.candidates.map((entry: any) => entry.id)).size).toBe(3);
        const sequence = await job("command", chaId, {}, { command: { type: "manual", name: "commands" } });
        expect(sequence.terminal).toMatchObject({
            type: "done",
            epoch,
            revision: (await readChat(chaId)).revision,
            sequence: { total: 1, sent: 1 },
        });
        expect(sequence.terminal).not.toHaveProperty("alternatives");
        const part = sequence.events.filter((event) => event.type === "sequence");
        expect(part).toHaveLength(1);
        expect(part[0]).not.toHaveProperty("alternatives");
        expect(part[0]).toMatchObject({
            type: "sequence",
            epoch,
            index: 0,
            total: 1,
            sent: 1,
            messageId: expect.any(String),
        });
        const afterCommand = await readChat(chaId);
        expect(afterCommand.data.message.some((entry: any) => entry.data === "From command")).toBe(true);
        const older = afterCommand.data.message.find((entry: any) => entry.chatId === reply.chatId);
        expect(older.scriptstateCheckpoint).toBeUndefined();
        expect(older.candidates.every((entry: any) => entry.scriptstateAfter === undefined)).toBe(true);
        expect(afterCommand.data.message.at(-1).candidates.map((entry: any) => entry.data)).toEqual([
            "Selected sample.",
            "Second sample.",
            "Third sample.",
        ]);
        redirected.mockRestore();
        await patchPreset("modelProfiles", profileId, profile);
        await patchProviders({ genTime: 1 });
        for (const scenario of ["count", "total", "reply", "snapshot"] as const) {
            const candidates =
                scenario === "count"
                    ? Array.from({ length: 16 }, (_, i) => ({ id: String(i), data: `Old ${i}` }))
                    : scenario === "total"
                      ? Array.from({ length: 3 }, (_, i) => ({ id: String(i), data: String(i).repeat(50 * 1024) }))
                      : undefined;
            const previous =
                candidates?.at(-1)?.data ?? (scenario === "reply" ? "X".repeat(193 * 1024) : "Previous reply.");
            const id = await seed({
                messages: [
                    { role: "user", chatId: "u", data: "Question." },
                    carrier({
                        data: previous,
                        ...(candidates ? { candidates, selected: candidates.length - 1 } : {}),
                        ...(scenario === "snapshot" ? { scriptstateCheckpoint: undefined } : {}),
                    }),
                ],
                ...(scenario === "snapshot" ? { chat: { scriptstate: { $large: "X".repeat(65 * 1024) } } } : {}),
            });
            mode = { chunks: [scenario === "total" ? "N".repeat(100 * 1024) : "New reply."], delayMs: 0 };
            const result = await job("reroll", id, { rerollMessageId: "r" });
            expect(result.terminal, scenario + JSON.stringify(result.terminal)).toMatchObject({
                type: "done",
                messageId: "r",
            });
            const final = await storedCarrier(id);
            const code =
                scenario === "reply"
                    ? "rerollCandidateTooLarge"
                    : scenario === "snapshot"
                      ? "scriptstateCheckpointSkipped"
                      : "rerollCandidateDropped";
            expect(notices(result.events, "alertToast").filter((entry) => entry.payload.code === code)).toHaveLength(1);
            if (scenario === "count") {
                expect(final.candidates).toHaveLength(16);
                expect(final.candidates.map((entry: any) => entry.id).slice(0, 15)).toEqual(
                    Array.from({ length: 15 }, (_, i) => String(i + 1)),
                );
            }
            if (scenario === "total") {
                expect(final.candidates.map((entry: any) => entry.data)).toEqual([
                    "2".repeat(50 * 1024),
                    "N".repeat(100 * 1024),
                ]);
                expect(
                    Buffer.byteLength(
                        JSON.stringify({
                            candidates: final.candidates,
                            scriptstateCheckpoint: final.scriptstateCheckpoint,
                        }),
                    ),
                ).toBeLessThanOrEqual(192 * 1024);
            }
            if (scenario === "reply") expect(final.candidates).toBeUndefined();
            if (scenario === "snapshot") {
                expect(final.scriptstateCheckpoint).toBeUndefined();
                expect(final.candidates.every((entry: any) => entry.scriptstateAfter === undefined)).toBe(true);
                expect((await readChat(id)).data.scriptstate.$large).toHaveLength(65 * 1024);
            }
        }
    });

    it("validates reroll addressing, rejects a superseded carrier, and uses only the carrier's speaker in a group", async () => {
        const chaId = await seed();
        for (const kind of ["send", "continue", "group", "preview", "previewPrompt"]) {
            const result = await job(kind, chaId, { rerollMessageId: "r" });
            expect(result.status, kind).toBe(400);
            expect(result.body.error).toContain("rerollMessageId");
        }
        await edit(chaId, [
            {
                op: "append",
                anchor: { end: true },
                messages: [{ role: "user", chatId: "newer", data: "Newer question" }],
            },
        ]);
        const old = await job("reroll", chaId, { rerollMessageId: "r" });
        expect(old.terminal).toMatchObject({ type: "error", reason: "failed" });
        expect((await storedCarrier(chaId)).data).toBe("Previous reply.");
        const legacy = await job("reroll", chaId);
        expect(legacy.terminal?.type).toBe("done");
        expect(texts(await readChat(chaId))).toEqual([
            "user:Question.",
            "char:Previous reply.",
            "user:Newer question",
            "char:New reply.",
        ]);
        const first = await seedCharacter({ name: "First speaker" });
        const second = await seedCharacter({ name: "Carrier speaker" });
        const owner = await seed({
            type: "group",
            members: [first, second],
            messages: [{ role: "user", chatId: "u", data: "Question." }, carrier({ saying: second })],
        });
        const beforeRequests = bodies.length;
        const result = await job("reroll", owner, { rerollMessageId: "r", speakerChaId: second });
        expect(result.terminal).toMatchObject({ type: "done", messageId: "r" });
        expect(bodies.slice(beforeRequests)).toHaveLength(1);
        expect(JSON.stringify(bodies.at(-1))).toContain("Carrier speaker");
        expect((await storedCarrier(owner)).saying).toBe(second);
        expect((await readChat(owner)).data.message).toHaveLength(2);
    });

    it("auto-continues the new candidate once and keeps it selected when the later request fails", async () => {
        const chaId = await seed();
        await patchProviders({ autoContinueChat: true });
        let calls = 0;
        onRequest = async () => {
            mode =
                ++calls === 1
                    ? { chunks: ["Unfinished new reply"], delayMs: 0 }
                    : { chunks: [], delayMs: 0, status: 400 };
        };
        const result = await job("reroll", chaId, { rerollMessageId: "r" });
        expect(result.terminal).toMatchObject({ type: "error", reason: "failed" });
        expect(calls).toBe(2);
        expect(
            result.events
                .filter((event) => event.type === "accepted" && event.messageId)
                .map((event) => [event.messageId, event.text]),
        ).toEqual([
            ["r", ""],
            ["r", "Unfinished new reply"],
        ]);
        const reply = await storedCarrier(chaId);
        expect(reply.data).toBe("Unfinished new reply");
        expect(reply.candidates.map((entry: any) => entry.data)).toEqual(["Previous reply.", "Unfinished new reply"]);
        expect(reply.selected).toBe(1);
        expect(await clientSetText(chaId, "r", "after later failure")).toBe(200);
    });

    it("omits the carrier from memory summarization as well as the provider prompt", async () => {
        const memorySettings = (await single("memoryTranslateMedia")).data;
        const profile = (await single("modelProfiles")).data.find((entry: any) => entry.id === profileId);
        const summaries: string[] = [];
        const summarizer = vi.spyOn(transformers, "runSummarizer").mockImplementation(async (input) => {
            summaries.push(JSON.stringify(input));
            return "The party explored a forest.";
        });
        try {
            await patchSection("memoryTranslateMedia", {
                supaModelType: "distilbart",
                hypaV3: false,
                hypav2: false,
                hanuraiEnable: false,
                hypaMemory: false,
            });
            await patchPreset("modelProfiles", profileId, { maxContext: 600 });
            const chaId = await seed({
                extra: { supaMemory: true },
                messages: [
                    ...Array.from({ length: 8 }, (_, i) => ({
                        role: i % 2 === 0 ? "user" : "char",
                        chatId: `older-${i}`,
                        data: `History ${i}: ` + "The party explored the forest and discussed the journey. ".repeat(12),
                    })),
                    { role: "user", chatId: "u", data: "Question." },
                    carrier({ data: "CARRIER_SECRET " + "discarded reply ".repeat(200) }),
                ],
            });
            const beforeRequests = bodies.length;
            const result = await job("reroll", chaId, { rerollMessageId: "r" });
            expect(result.terminal, JSON.stringify(result.terminal)).toMatchObject({ type: "done", messageId: "r" });
            expect(summaries.length).toBeGreaterThan(0);
            expect(summaries.join(" ")).toContain("History 0");
            expect(summaries.join(" ")).not.toContain("CARRIER_SECRET");
            expect(JSON.stringify(bodies.slice(beforeRequests))).not.toContain("CARRIER_SECRET");
            expect((await storedCarrier(chaId)).candidates[0].data).toContain("CARRIER_SECRET");
        } finally {
            summarizer.mockRestore();
            await patchSection("memoryTranslateMedia", memorySettings);
            await patchPreset("modelProfiles", profileId, profile);
        }
    });

    it("writes back a timed-out or maintenance-aborted attempt before releasing the carrier lock", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
        server.context.generationJobs.startGc();
        for (const reason of ["timeout", "maintenance"] as const) {
            const chaId = await seed({
                triggerscript: [trig("start", [setVar("x", "2"), setVar("introduced", "attempt")])],
            });
            const first = deferred<void>();
            const release = deferred<void>();
            const cleanup = cleanupOnce(() => release.resolve());
            mode = {
                chunks: ["Partial", " discarded"],
                delayMs: 0,
                holdBeforeChunk: { index: 1, until: release.promise },
            };
            const apply = runnerStore.applyChanges;
            let guarded = false;
            const writes = vi.spyOn(runnerStore, "applyChanges").mockImplementation((changes, options) => {
                if (options?.rerollAttempt?.action === "rollback") {
                    guarded = true;
                    try {
                        apply({
                            chats: [
                                {
                                    characterId: chaId,
                                    chatId: "k",
                                    baseRevision: runnerStore.chatRevision(chaId, "k"),
                                    ops: [{ op: "setText", id: "r", text: "edit while unwinding" }],
                                },
                            ],
                        });
                        throw new Error("the carrier was unlocked before write-back");
                    } catch (error) {
                        expect(error).toBeInstanceOf(resourceStores.ResourceBatchConflictError);
                        expect((error as resourceStores.ResourceBatchConflictError).conflicts).toEqual([
                            expect.objectContaining({ reason: "generating", messageIds: ["r"] }),
                        ]);
                    }
                }
                return apply(changes, options);
            });
            const pending = job("reroll", chaId, { rerollMessageId: "r" }, { onChunk: () => first.resolve() });
            try {
                await Promise.race([first.promise, pending]);
                if (reason === "timeout") {
                    vi.setSystemTime(Date.now() + 31 * 60_000);
                    await vi.advanceTimersByTimeAsync(30_000);
                } else {
                    await server.context.snapshots.withMaintenance(async () => {});
                }
                const result = await pending;
                expect(result.terminal).toMatchObject({ type: "error", reason });
                expect(guarded).toBe(true);
                const reply = await storedCarrier(chaId);
                expect(reply).toMatchObject({
                    data: "Previous reply.",
                    generationInfo: oldInfo,
                    promptInfo: oldPrompt,
                    translation: oldTranslation,
                });
                expect(reply.candidates).toBeUndefined();
                expect((await readChat(chaId)).data.scriptstate).toEqual({ $x: "1", $edited: "9" });
                expect(await clientSetText(chaId, "r", "after write-back")).toBe(200);
            } finally {
                writes.mockRestore();
                cleanup();
                await pending;
            }
        }
        vi.clearAllTimers();
    });
});
