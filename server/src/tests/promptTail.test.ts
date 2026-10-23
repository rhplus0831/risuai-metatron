// @vitest-environment node
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import webPush from "web-push";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type GenerationTerminalEvent, NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
import { completionNotificationTag } from "../../../shared/notifications.ts";
import type { PushTransport } from "../push/pushService.ts";
import { allowListenerOrigin, createSigner, createTestServer, json, sleep, waitFor } from "./testSupport.ts";

// The tail of a reply inside a send job (`server/src/prompt/runner.ts` `runSpeaker` and `runSend`,
// `server/src/prompt/postProcess.ts`, `server/src/prompt/scripts.ts` `editoutput`), end to end on a
// listening server with the default runner, the real worker pool (Lua and the regex scripts), the
// production bindings, the job channel over the owner socket, a fake OpenAI-compatible provider that
// answers one scripted reply per request, and a fake embedding server. Pinned against the tab's
// `sendChatInner` (`src/ts/process/index.svelte.ts`) with the approved differences: on the streaming
// path `editoutput` once on the completed text (Lua `editOutput`, the plugin hook as a callback, the
// regex) while the chunks stream raw, the output trigger, the `chatOutput` callback with the reply's
// id and speaker, the `tts` notice with the raw result, the `notification` notice, the timings and
// the final write; the non-streaming continue's two `editoutput` calls; auto-continue as a continue
// round of the same reply with `igp` once on the terminal reply (a prompt that is not ChatML an error
// notice); the cap of 8 rounds with the terminal tail after it; a trigger's resend with `igp` only on
// the last reply; a trigger that removes the reply ending the turn; a trigger's rewrite of the reply
// under its generation with the stream's last chunk claimed by every later write; the inlay rewrites
// (the emotion tag, image commands through `generateImage` callbacks one after the other, a failed
// one removed); the `imggen` callback of the image view; the submodel emotion mode (the four-message
// request, the biases from the history trimmed to four, exact/contained/no-match, a failed request
// shown and the turn ended before the timing write); the embedding emotion mode (the recency penalty
// on the trimmed history, the dot-product ranking); a cached empty `editoutput` result computed again
// with its `@@emo` effect; the route's bound on `context.client.emotions`.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SLOW = 60_000;

/** `paced`: each chunk is written once the owner holds the text so far, so no two chunks reach the server together. */
type Answer = { chunks: string[]; status?: number; paced?: boolean };
/** The provider: one scripted answer per request, in order; `fallback` once the queue is empty. */
let answers: Answer[] = [];
let fallback: Answer = { chunks: ["Done."] };
const CHUNK_DELAY_MS = 20;
/** Resolves once the current job's owner socket is open (set per job by `job()`). */
let socketOpen: Promise<void> = Promise.resolve();
/** The current job's owner events (`job()`), and the waiters for a text the owner's chunks rebuild. */
let ownerEvents: any[] = [];
let ownerWaiters: { text: string; resolve: () => void }[] = [];
const ownerHolds = (text: string) => streamedTexts(ownerEvents).includes(text);
function ownerEventAdded() {
    ownerWaiters = ownerWaiters.filter((waiter) => !(ownerHolds(waiter.text) && (waiter.resolve(), true)));
}
const untilOwnerHolds = (text: string) =>
    ownerHolds(text) ? Promise.resolve() : new Promise<void>((resolve) => ownerWaiters.push({ text, resolve }));
const bodies: any[] = [];
const provider = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) {
        parts.push(chunk as Buffer);
    }
    const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
    bodies.push(body);
    const answer = answers.shift() ?? fallback;
    // The owner socket attaches after the create answered: wait for it, so every chunk is a `chunk` event.
    await socketOpen;
    if (answer.status) {
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "upstream broke" } }));
        return;
    }
    if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer.chunks.join("") } }] }));
        return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    let sent = "";
    for (const chunk of answer.chunks) {
        if (res.destroyed) {
            return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        sent += chunk;
        if (answer.paced) {
            await untilOwnerHolds(sent);
        }
        await sleep(CHUNK_DELAY_MS);
    }
    res.write("data: [DONE]\n\n");
    res.end();
});

// The embedding server: the emotion documents get fixed vectors, every other text (the reply, the
// query) `[1, 0, 0]`, so the ranking is the dot product with the document's first component.
const EMBED_VECTORS: Record<string, number[]> = {
    "emotion:near": [1, 0, 0],
    "emotion:mid": [0.927, 0, 0],
    "emotion:far": [0, 0, 1],
};
const embedder = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) {
        parts.push(chunk as Buffer);
    }
    const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
    const input: string[] = Array.isArray(body.input) ? body.input : [body.input];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: input.map((text) => ({ embedding: EMBED_VECTORS[text] ?? [1, 0, 0] })) }));
});

/** The Web Push deliveries: the fake transport records them instead of posting. */
const pushes: { endpoint: string; payload: string }[] = [];
const PUSH_ENDPOINT = "https://fcm.googleapis.com/fcm/send/tail-browser";
const pushTransport: PushTransport = {
    sendNotification: (async (subscription: { endpoint: string }, payload: unknown) => {
        pushes.push({ endpoint: subscription.endpoint, payload: String(payload) });
        return { statusCode: 201, body: "", headers: {} };
    }) as unknown as PushTransport["sendNotification"],
};

let rootDir = "";
let server: ReturnType<typeof createTestServer>;
let node: http.Server;
let base = "";
let epoch = "";
let signer: Awaited<ReturnType<typeof createSigner>>;
let presetId = "";
let modelPresetId = "";
let personaId = "";
let embedderUrl = "";

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

/** The section homes of the settings used here (`shared/sections.ts`). */
const SECTION_OF: Record<string, string> = {
    useStreaming: "providers",
    autoContinueChat: "providers",
    autoContinueMinTokens: "providers",
    removeIncompleteResponse: "providers",
    igpPrompt: "providers",
    inlayErrorResponse: "providers",
    ttsAutoSpeech: "memoryTranslateMedia",
    emotionPrompt2: "memoryTranslateMedia",
    emotionProcesser: "memoryTranslateMedia",
    hypaModel: "memoryTranslateMedia",
    hypaCustomSettings: "secrets",
    notification: "ui",
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
/** The tail settings this file turns on, back to their defaults. */
const DEFAULT_SETTINGS = {
    useStreaming: true,
    autoContinueChat: false,
    autoContinueMinTokens: 0,
    igpPrompt: "",
    inlayErrorResponse: false,
    ttsAutoSpeech: false,
    emotionProcesser: "submodel",
    notification: false,
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
    firstMessage: "Hi from {{char}}",
    desc: "Desc of {{char}}",
    lowLevelAccess: true,
    newGenData: { prompt: "", negative: "", instructions: "", emotionInstructions: "" },
};
const v = (value: string) => ({ value, valueType: "value" });
const ef = (type: string, fields: Record<string, unknown> = {}, indent = 0) => ({ type, indent, ...fields });
const trig = (type: string, effect: unknown[]) => ({
    comment: type,
    type,
    conditions: [],
    effect,
    lowLevelAccess: true,
});
const lua = (code: string) => trig("manual", [{ type: "triggerlua", code }]);
const regex = (comment: string, inText: string, out: string) => ({
    comment,
    in: inText,
    out,
    type: "editoutput",
    flag: "g",
    ableFlag: true,
});
/** An output trigger that replaces the text of the message at `index`. */
const rewriteTrigger = (index: string, value: string) =>
    trig("output", [ef("v2ModifyChat", { indexType: "value", index, valueType: "value", value })]);

let seeded = 0;
/** A character with one chat `k` holding `messages`. */
async function seedCharacter(options: {
    name: string;
    messages?: Record<string, unknown>[];
    triggerscript?: unknown[];
    customscript?: unknown[];
    extra?: Record<string, unknown>;
}) {
    const chaId = `tail-${++seeded}`;
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
                    type: "character",
                    triggerscript: options.triggerscript ?? [],
                    customscript: options.customscript ?? [],
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
                        chat: {
                            id: "k",
                            name: "K",
                            fmIndex: -1,
                            // Bound to the ids the jobs send: a job runs on its chat's binding.
                            modelPresetId,
                            promptPresetId: presetId,
                            bindedPersona: personaId,
                            message: options.messages ?? [{ role: "user", data: "q", chatId: "u1" }],
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
    /** Answers a `callback` event: the answer message's fields. */
    answerCallback?: (event: any) => Record<string, unknown>;
    hooks?: typeof NO_GENERATION_HOOKS;
    /** `context.client.emotions`: the emotions the tab showed last, by character. */
    emotions?: Record<string, string[]>;
};
/** Creates a job and follows its owner socket to the terminal. */
async function job(
    kind: string,
    chaId: string,
    extra: Record<string, unknown> = {},
    options: JobOptions = {},
): Promise<{ status: number; body: any; events: any[]; terminal: GenerationTerminalEvent | undefined }> {
    const chat = await readChat(chaId);
    // The gate and the event list are this job's before it is created: its provider request may come
    // before the create answers.
    let opened!: () => void;
    socketOpen = new Promise<void>((resolve) => {
        opened = resolve;
    });
    const events: any[] = [];
    ownerEvents = events;
    ownerWaiters = [];
    const created = await api("/api/generations", {
        method: "POST",
        body: JSON.stringify({
            kind,
            clientId: "tab",
            hooks: options.hooks ?? NO_GENERATION_HOOKS,
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
                client: {
                    viewport: { width: 800, height: 600 },
                    browserLanguage: "en",
                    ...(options.emotions ? { emotions: options.emotions } : {}),
                },
                ...extra,
            },
        }),
    });
    if (created.status !== 200) {
        opened();
        return { ...created, events: [], terminal: undefined };
    }
    const jobId = created.body.jobId as string;
    const url =
        `${base.replace("http", "ws")}/api/generations/${jobId}/ws` +
        `?risu-auth=${encodeURIComponent(await signer.jwt())}&clientId=tab&attach=${++attach}`;
    const ws = new WebSocket(url);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ended = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 45_000);
        ws.onmessage = (message) => {
            const event = JSON.parse(String(message.data));
            if (event.type === "ping") {
                return;
            }
            events.push(event);
            ownerEventAdded();
            if (event.type === "callback") {
                const answer = options.answerCallback?.(event) ?? { outcome: "answered", value: true };
                ws.send(JSON.stringify({ type: "answer", id: event.id, ...answer }));
            }
            if (event.type === "done" || event.type === "error") {
                clearTimeout(timer);
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
    ws.close();
    return {
        ...created,
        events,
        terminal: events.find((event) => event.type === "done" || event.type === "error"),
    };
}
const notices = (events: any[], kind: string) => events.filter((e) => e.type === "notice" && e.kind === kind);
const callbacks = (events: any[], name?: string) =>
    events.filter((e) => e.type === "callback" && (name === undefined || e.name === name));
const indexOf = (events: any[], predicate: (event: any) => boolean) => events.findIndex(predicate);
/**
 * The chunks' whole texts, rebuilt from the wire deltas: a chunk keeps `keep` units of the text its
 * generation held at `base` (the reply's `accepted` text at its seq, 0 by default, then the previous
 * chunk's) and appends `text`; each chunk's base must be the seq held before it.
 */
function streamedTexts(events: any[]): string[] {
    const held = new Map<string, { seq: number; text: string }>();
    const out: string[] = [];
    for (const event of events) {
        if (event.type === "accepted" && event.messageId && event.generationId) {
            held.set(event.generationId, { seq: event.seq ?? 0, text: event.text });
        } else if (event.type === "chunk") {
            const before = held.get(event.generationId);
            expect(before, `chunk ${event.seq} without a held base`).toBeDefined();
            expect(event.base).toBe(before!.seq);
            const text = before!.text.slice(0, event.keep) + event.text;
            held.set(event.generationId, { seq: event.seq, text });
            out.push(text);
        }
    }
    return out;
}
/**
 * The job chat's events (the job's hydration of its chat): whole `resource` events (the callback
 * barrier) and `chatPatch` events (every other job chat event). Both carry `streaming`.
 */
const chatRecords = (events: any[]) =>
    events.filter((e) => (e.type === "resource" && e.kind === "chats") || e.type === "chatPatch");
/**
 * The stored text of message `id` as a job chat event carries it: the whole copy's row, or the
 * patch's row (undefined when the patch does not carry that message).
 */
const storedText = (event: any, id: string): string | undefined =>
    event.type === "resource"
        ? event.data.message.find((entry: any) => entry.chatId === id)?.data
        : event.messages?.find((row: any) => row.message.chatId === id)?.message.data;

beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
    allowListenerOrigin(provider);
    await new Promise<void>((resolve) => embedder.listen(0, "127.0.0.1", () => resolve()));
    allowListenerOrigin(embedder);
    const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1/chat/completions`;
    embedderUrl = `http://127.0.0.1:${(embedder.address() as { port: number }).port}/v1/embeddings`;
    rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-prompt-tail-"));
    mkdirSync(path.join(rootDir, "dist"));
    writeFileSync(path.join(rootDir, "dist", "index.html"), "<!doctype html><html><head></head><body></body></html>");
    symlinkSync(path.join(REPO_ROOT, "public"), path.join(rootDir, "public"), "dir");
    cpSync(path.join(REPO_ROOT, "version.json"), path.join(rootDir, "version.json"));
    mkdirSync(path.join(rootDir, "save", "server"), { recursive: true });
    writeFileSync(path.join(rootDir, "save", "server", "password"), "pw");
    // A stored image inlay the `generateImage` callback can answer with.
    mkdirSync(path.join(rootDir, "save", "assets"), { recursive: true });
    writeFileSync(path.join(rootDir, "save", "assets", "inlay_cat.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    server = createTestServer({ rootDir, generationRandom: () => 0, pushTransport });
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
    personaId = personas.data[0].id;
    // The selected model preset's main and sub slots use one profile: a reverse proxy to the fake
    // provider; the selected prompt preset holds the prompt.
    const profileId = modelProfiles.data[0].id;
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
                        maxResponse: 100,
                        jailbreakToggle: false,
                        mainPrompt: "Main {{char}}",
                        formatingOrder: ["main", "description", "chats", "lastChat"],
                        regex: [],
                    },
                ],
            },
        ],
    });
    expect(seededPresets.status, JSON.stringify(seededPresets.body)).toBe(200);
    const inlay = await batch({
        ops: [
            {
                kind: "inlays",
                id: "inlay-cat",
                baseRevision: null,
                data: { name: "cat", ext: "png", type: "image", asset: "assets/inlay_cat.png" },
            },
        ],
    });
    expect(inlay.status, JSON.stringify(inlay.body)).toBe(200);
    await patchSettings({
        ...DEFAULT_SETTINGS,
        hypaModel: "custom",
        hypaCustomSettings: { url: embedderUrl, key: "embed-key", model: "emb" },
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

/** Runs `body` with the settings on, then restores the defaults and the provider queue. */
async function withSettings(fields: Record<string, unknown>, body: () => Promise<void>) {
    await patchSettings(fields);
    try {
        await body();
    } finally {
        const reset: Record<string, unknown> = {};
        for (const key of Object.keys(fields)) {
            reset[key] = DEFAULT_SETTINGS[key as keyof typeof DEFAULT_SETTINGS];
        }
        await patchSettings(reset);
        answers = [];
        fallback = { chunks: ["Done."] };
    }
}

describe("the streaming tail", () => {
    it(
        "runs editoutput once on the completed text (Lua, the plugin hook, the regex) while the chunks stream raw, then the trigger, the listeners, TTS, the notification, the timings, and the final write",
        async () => {
            const chaId = await seedCharacter({
                name: "Ann",
                customscript: [regex("greet", "Hello", "Howdy")],
                triggerscript: [
                    lua(`listenEdit('editOutput', function(id, data) return data .. ' [lua]' end)`),
                    trig("output", [ef("v2SetVar", { var: "seen", operator: "=", ...v("yes") })]),
                ],
            });
            await withSettings({ ttsAutoSpeech: true, notification: true }, async () => {
                answers = [{ chunks: ["Hel", "lo", " there"], paced: true }];
                const before = bodies.length;
                // A browser registered for Web Push (`routes/push.ts`): the completion reaches it too.
                pushes.length = 0;
                const registered = await api("/api/push/subscription", {
                    method: "PUT",
                    body: JSON.stringify({
                        subscription: {
                            endpoint: PUSH_ENDPOINT,
                            expirationTime: null,
                            keys: {
                                p256dh: webPush.generateVAPIDKeys().publicKey,
                                auth: randomBytes(16).toString("base64url"),
                            },
                        },
                    }),
                });
                expect(registered.status).toBe(204);
                const { events, terminal } = await job(
                    "send",
                    chaId,
                    {},
                    {
                        hooks: { ...NO_GENERATION_HOOKS, scripts: ["editoutput"], chatOutput: true },
                        answerCallback: (event) =>
                            event.name === "editoutput"
                                ? { outcome: "answered", value: `${event.payload.text} [plugin]` }
                                : { outcome: "answered", value: true },
                    },
                );
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                expect(bodies.length).toBe(before + 1);
                const chat = await readChat(chaId);
                const reply = chat.data.message[1];
                // Lua first, then the plugin hook on the completed text, then the regex on the hook's answer.
                expect(texts(chat)).toEqual(["user:q", "char:Howdy there [lua] [plugin]"]);
                expect(chat.data.scriptstate?.$seen).toBe("yes");
                // The chunks are the raw text so far; the plugin hook ran once, on the completed text.
                const chunks = events.filter((event) => event.type === "chunk");
                const streamed = streamedTexts(events);
                // A chunk event for each paced chunk: the raw text so far, never an edited one (the stream's end
                // may send the final text once more).
                expect(streamed.slice(0, 3)).toEqual(["Hel", "Hello", "Hello there"]);
                expect(streamed.at(-1)).toBe("Hello there");
                expect(streamed.every((text) => !text.includes("[lua]"))).toBe(true);
                expect(callbacks(events, "editoutput").map((event) => event.payload)).toEqual([
                    { text: "Hello there [lua]" },
                ]);
                // The listeners get the reply's id and the speaker, after the edit hook; TTS carries the
                // raw result (the tab's `result`); the notification never carries the reply: the
                // server's sentence for the chat, and the same text goes out as Web Push to the
                // registered browser.
                expect(callbacks(events, "chatOutput").map((event) => event.payload)).toEqual([
                    { messageId: reply.chatId, speakerId: chaId },
                ]);
                expect(notices(events, "tts").map((event) => event.payload)).toEqual([{ chaId, text: "Hello there" }]);
                const notification = {
                    chaId,
                    chatId: "k",
                    title: "Risuai",
                    body: "Ann's message has been processed.",
                    url: `/chat/${chaId}/k`,
                    tag: completionNotificationTag(chaId, "k"),
                };
                expect(notices(events, "notification").map((event) => event.payload)).toEqual([notification]);
                await waitFor(() => pushes.length === 1);
                expect(pushes[0].endpoint).toBe(PUSH_ENDPOINT);
                expect(JSON.parse(pushes[0].payload)).toEqual({
                    title: notification.title,
                    body: notification.body,
                    url: notification.url,
                    tag: notification.tag,
                    icon: "/logo_192.png",
                    badge: "/logo_192.png",
                });
                expect(pushes[0].payload).not.toContain("Hello there");
                const editAt = indexOf(events, (e) => e.type === "callback" && e.name === "editoutput");
                const listenersAt = indexOf(events, (e) => e.type === "callback" && e.name === "chatOutput");
                const ttsAt = indexOf(events, (e) => e.type === "notice" && e.kind === "tts");
                const notificationAt = indexOf(events, (e) => e.type === "notice" && e.kind === "notification");
                expect(indexOf(events, (e) => e === chunks.at(-1))).toBeLessThan(editAt);
                expect(editAt).toBeLessThan(listenersAt);
                expect(listenersAt).toBeLessThan(ttsAt);
                expect(ttsAt).toBeLessThan(notificationAt);
                // The timings are written onto the reply, and the lock is released by the final write.
                expect(reply.generationInfo.stageTiming.stage3).toBeGreaterThanOrEqual(CHUNK_DELAY_MS);
                expect(terminal).toMatchObject({ messageId: reply.chatId, alternatives: ["Hello there"] });
                expect(await clientSetText(chaId, reply.chatId, "edited by the tab")).toBe(200);
                const removed = await api("/api/push/subscription", {
                    method: "DELETE",
                    body: JSON.stringify({ endpoint: PUSH_ENDPOINT }),
                });
                expect(removed.status).toBe(204);
            });
        },
        SLOW,
    );

    it(
        "a trigger's rewrite of the reply is written under its generation, every write after the stream claims its last chunk, and the listeners see the rewritten reply",
        async () => {
            const chaId = await seedCharacter({ name: "Ann", triggerscript: [rewriteTrigger("1", "Rewritten.")] });
            await withSettings({ ttsAutoSpeech: true }, async () => {
                answers = [{ chunks: ["Raw", " text"] }];
                const { events, terminal } = await job(
                    "send",
                    chaId,
                    {},
                    { hooks: { ...NO_GENERATION_HOOKS, chatOutput: true } },
                );
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                const chat = await readChat(chaId);
                const reply = chat.data.message[1];
                expect(texts(chat)).toEqual(["user:q", "char:Rewritten."]);
                expect(callbacks(events, "chatOutput").map((event) => event.payload)).toEqual([
                    { messageId: reply.chatId, speakerId: chaId },
                ]);
                // TTS reads the tab's `result` (the stream's last value), not the stored reply.
                expect(notices(events, "tts").map((event) => event.payload.text)).toEqual(["Raw text"]);
                // After the last chunk, every hydration that still lists the reply as streaming claims
                // that chunk, so a tab never puts streamed text over the processed write.
                const chunks = events.filter((event) => event.type === "chunk");
                const lastSeq = chunks.at(-1).seq;
                const after = events.slice(indexOf(events, (e) => e === chunks.at(-1)) + 1);
                const claims = chatRecords(after)
                    .flatMap((event) => event.streaming as { messageId: string; seq: number }[])
                    .filter((entry) => entry.messageId === reply.chatId)
                    .map((entry) => entry.seq);
                expect(claims.length).toBeGreaterThanOrEqual(2);
                expect(claims.every((seq) => seq === lastSeq)).toBe(true);
                // The rewritten reply reaches the tab as stored (a patch carries the reply's row on
                // every event: the job began its generation).
                expect(chatRecords(after).some((event) => storedText(event, reply.chatId) === "Rewritten.")).toBe(true);
                expect(await clientSetText(chaId, reply.chatId, "edited by the tab")).toBe(200);
            });
        },
        SLOW,
    );

    it(
        "a trigger that removes the reply ends the turn: no listeners, no TTS, no auto-continue, no igp, done without a message",
        async () => {
            const chaId = await seedCharacter({
                name: "Ann",
                triggerscript: [
                    trig("output", [ef("v2CutChat", { startType: "value", start: "0", endType: "value", end: "1" })]),
                ],
            });
            await withSettings(
                {
                    ttsAutoSpeech: true,
                    autoContinueChat: true,
                    igpPrompt: "<|im_start|>user<|im_sep|>Add a tag<|im_end|>",
                },
                async () => {
                    answers = [{ chunks: ["No end"] }];
                    const before = bodies.length;
                    const { events, terminal } = await job(
                        "send",
                        chaId,
                        {},
                        { hooks: { ...NO_GENERATION_HOOKS, chatOutput: true } },
                    );
                    expect(terminal).toEqual(expect.objectContaining({ type: "done" }));
                    expect((terminal as any).messageId).toBeUndefined();
                    expect((terminal as any).stopped).toBeUndefined();
                    expect(texts(await readChat(chaId))).toEqual(["user:q"]);
                    expect(callbacks(events, "chatOutput")).toHaveLength(0);
                    expect(notices(events, "tts")).toHaveLength(0);
                    expect(bodies.length).toBe(before + 1);
                },
            );
        },
        SLOW,
    );
});

describe("the non-streaming tail", () => {
    it(
        "a continue runs editoutput on the new text and again on the continued message plus the new text, stores the second, and keeps the reply open through the tail",
        async () => {
            const chaId = await seedCharacter({
                name: "Ann",
                messages: [
                    { role: "user", data: "q", chatId: "u1" },
                    { role: "char", data: "Again.", chatId: "r1" },
                ],
                customscript: [regex("more", "More", "MORE")],
            });
            await withSettings({ useStreaming: false, ttsAutoSpeech: true }, async () => {
                answers = [{ chunks: [" More text."] }];
                const { events, terminal } = await job(
                    "continue",
                    chaId,
                    {},
                    {
                        hooks: { ...NO_GENERATION_HOOKS, scripts: ["editoutput"], chatOutput: true },
                        answerCallback: (event) =>
                            event.name === "editoutput"
                                ? { outcome: "answered", value: event.payload.text }
                                : { outcome: "answered", value: true },
                    },
                );
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                expect(events.filter((event) => event.type === "chunk")).toHaveLength(0);
                // Both of the tab's `processScriptFull` calls: the new text, then the whole message.
                expect(callbacks(events, "editoutput").map((event) => event.payload.text)).toEqual([
                    "More text.",
                    "Again. More text.",
                ]);
                const chat = await readChat(chaId);
                expect(texts(chat)).toEqual(["user:q", "char:Again. MORE text."]);
                expect(chat.data.message[1].chatId).toBe("r1");
                expect(callbacks(events, "chatOutput").map((event) => event.payload)).toEqual([
                    { messageId: "r1", speakerId: chaId },
                ]);
                // The non-streaming `result` is the processed text.
                expect(notices(events, "tts").map((event) => event.payload.text)).toEqual(["Again. MORE text."]);
                expect(terminal).toMatchObject({ messageId: "r1" });
                expect((terminal as any).alternatives).toBeUndefined();
                expect(await clientSetText(chaId, "r1", "edited by the tab")).toBe(200);
            });
        },
        SLOW,
    );
});

describe("rounds", () => {
    it(
        "auto-continue is a continue round of the same reply; igp runs once, on the terminal reply, and appends the answer",
        async () => {
            const chaId = await seedCharacter({ name: "Ann" });
            await withSettings(
                { autoContinueChat: true, igpPrompt: "<|im_start|>user<|im_sep|>Add a tag<|im_end|>" },
                async () => {
                    answers = [{ chunks: ["Hello there"] }, { chunks: [" friend."] }, { chunks: [" #tag"] }];
                    const before = bodies.length;
                    const { events, terminal } = await job("send", chaId);
                    expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                    const chat = await readChat(chaId);
                    expect(texts(chat)).toEqual(["user:q", "char:Hello there friend. #tag"]);
                    const reply = chat.data.message[1];
                    expect(terminal).toMatchObject({ messageId: reply.chatId });
                    // Three requests: the send, the continue, igp (the ChatML prompt, in the aux mode).
                    const sent = bodies.slice(before);
                    expect(sent).toHaveLength(3);
                    expect(sent[2].messages).toEqual([{ role: "user", content: "Add a tag" }]);
                    expect(sent[2].stream).toBeFalsy();
                    // The continue round takes the reply over: an `accepted` with its text so far.
                    expect(
                        events
                            .filter((event) => event.type === "accepted" && event.messageId)
                            .map((event) => [event.messageId, event.text]),
                    ).toEqual([
                        [reply.chatId, ""],
                        [reply.chatId, "Hello there"],
                    ]);
                    expect(notices(events, "alertToast")).toHaveLength(0);
                    expect(await clientSetText(chaId, reply.chatId, "edited by the tab")).toBe(200);
                },
            );
        },
        SLOW,
    );

    it(
        "a continue round whose request fails ends the job as that request's failure (the round's own request stage and id), with the first round's text stored",
        async () => {
            const chaId = await seedCharacter({ name: "Ann" });
            await withSettings({ autoContinueChat: true }, async () => {
                // The request layer retries a 500: every attempt of the round fails.
                answers = [
                    { chunks: ["Hello there"] },
                    ...Array.from({ length: 6 }, () => ({ chunks: [], status: 500 })),
                ];
                const before = bodies.length;
                const { body, terminal } = await job("send", chaId);
                answers = [];
                expect(terminal, JSON.stringify(terminal)).toMatchObject({
                    type: "error",
                    status: 500,
                    reason: "failed",
                    stage: "request",
                });
                // The send, then the continue round's attempts (the request layer retries a 500).
                expect(bodies.length).toBeGreaterThanOrEqual(before + 2);
                const rows = (await api(`/api/request-history?jobId=${encodeURIComponent(body.jobId)}`)).body.items as {
                    id: string;
                    status: string;
                }[];
                expect(rows.filter((row) => row.status === "success")).toHaveLength(1);
                const errored = rows.filter((row) => row.status === "error");
                expect(errored.length).toBeGreaterThanOrEqual(1);
                // Newest first: the last attempt is the one the event names.
                expect((terminal as any).requestId).toBe(errored[0].id);
                const chat = await readChat(chaId);
                expect(texts(chat)).toEqual(["user:q", "char:Hello there"]);
                expect(await clientSetText(chaId, chat.data.message[1].chatId, "edited by the tab")).toBe(200);
            });
        },
        SLOW,
    );

    it(
        "an igp prompt that is not ChatML is an error notice and no request",
        async () => {
            const chaId = await seedCharacter({ name: "Ann" });
            await withSettings({ igpPrompt: "plain text" }, async () => {
                answers = [{ chunks: ["Fine."] }];
                const before = bodies.length;
                const { events, terminal } = await job("send", chaId);
                expect(terminal?.type).toBe("done");
                expect(bodies.length).toBe(before + 1);
                expect(notices(events, "alertError").map((event) => event.payload.message)).toEqual([
                    "The IGP prompt is not ChatML",
                ]);
                expect(texts(await readChat(chaId))).toEqual(["user:q", "char:Fine."]);
            });
        },
        SLOW,
    );

    it(
        "the cap: after 8 rounds the requested round is suppressed with one toast, and the terminal tail runs on the reply as it stands",
        async () => {
            const chaId = await seedCharacter({ name: "Ann" });
            await withSettings({ autoContinueChat: true, notification: true }, async () => {
                fallback = { chunks: [" more"] };
                const before = bodies.length;
                const { events, terminal } = await job("send", chaId);
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                expect(bodies.length).toBe(before + 9);
                const chat = await readChat(chaId);
                expect(texts(chat)).toEqual(["user:q", `char:${Array(9).fill("more").join(" ")}`]);
                expect(notices(events, "alertToast").map((event) => event.payload.message)).toEqual([
                    "Auto-continue and resend stopped after 8 rounds",
                ]);
                // The terminal tail ran once, after the cap.
                expect(notices(events, "notification")).toHaveLength(1);
                expect(terminal).toMatchObject({ messageId: chat.data.message[1].chatId });
                expect(await clientSetText(chaId, chat.data.message[1].chatId, "edited by the tab")).toBe(200);
            });
        },
        SLOW,
    );

    it(
        "a trigger's sendAIprompt is a fresh send of the same speaker; igp runs only on the last reply",
        async () => {
            const chaId = await seedCharacter({
                name: "Ann",
                triggerscript: [
                    trig("output", [
                        ef("v2If", { source: "resent", condition: "!=", targetType: "value", target: "1" }),
                        ef("v2SetVar", { var: "resent", operator: "=", ...v("1") }, 1),
                        ef("v2SendAIprompt", {}, 1),
                        ef("v2EndIndent", { endOfLoop: false }, 1),
                    ]),
                ],
            });
            await withSettings({ igpPrompt: "<|im_start|>user<|im_sep|>Add a tag<|im_end|>" }, async () => {
                answers = [{ chunks: ["First."] }, { chunks: ["Second."] }, { chunks: [" #tag"] }];
                const before = bodies.length;
                const { terminal } = await job("send", chaId);
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                expect(bodies.length).toBe(before + 3);
                const chat = await readChat(chaId);
                expect(texts(chat)).toEqual(["user:q", "char:First.", "char:Second. #tag"]);
                expect(chat.data.message[1].chatId).not.toBe(chat.data.message[2].chatId);
                expect(terminal).toMatchObject({ messageId: chat.data.message[2].chatId });
                expect(await clientSetText(chaId, chat.data.message[1].chatId, "edited by the tab")).toBe(200);
            });
        },
        SLOW,
    );

    it(
        "an empty editoutput result is computed again on every round with its @@emo effect (the tab's cache condition)",
        async () => {
            const chaId = await seedCharacter({
                name: "Ann",
                customscript: [regex("emo", "x", "@@emo happy"), regex("blank", "x", "")],
                extra: { viewScreen: "emotion", emotionImages: [["happy", "happy.png"]] },
            });
            await withSettings({ autoContinueChat: true, emotionProcesser: "submodel" }, async () => {
                fallback = { chunks: ["x"] };
                const before = bodies.length;
                const { events, terminal } = await job("send", chaId);
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                // Nine rounds of "x" at the same reply index, each with its emotion effect; the regex
                // emotion counts as shown, so the terminal round makes no emotion-mode request.
                expect(bodies.length).toBe(before + 9);
                expect(notices(events, "emotion").map((event) => event.payload)).toEqual(
                    Array(9).fill({ chaId, name: "happy", image: "happy.png" }),
                );
                expect(texts(await readChat(chaId))).toEqual(["user:q", "char:"]);
            });
        },
        SLOW,
    );
});

describe("inlays and the image view", () => {
    it(
        "the emotion inlay view rewrites the emotion tag",
        async () => {
            const chaId = await seedCharacter({
                name: "Ann",
                extra: { inlayViewScreen: true, viewScreen: "emotion", emotionImages: [["joy", "joy.png"]] },
            });
            answers = [{ chunks: ['Hi <Emotion="joy"> there.'] }];
            const { events, terminal } = await job("send", chaId);
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            expect(texts(await readChat(chaId))).toEqual(["user:q", "char:Hi {{emotion::joy}} there."]);
            // The inlay view: no automatic emotion mode.
            expect(notices(events, "emotion")).toHaveLength(0);
        },
        SLOW,
    );

    it(
        "the image inlay view shows [Generating...] at once, asks one generateImage callback per command one after the other, and removes a command whose image failed",
        async () => {
            const chaId = await seedCharacter({
                name: "Ann",
                extra: {
                    inlayViewScreen: true,
                    viewScreen: "imggen",
                    newGenData: {
                        prompt: "best, {{slot}}",
                        negative: "neg",
                        instructions: "",
                        emotionInstructions: "",
                    },
                },
            });
            answers = [{ chunks: ['A <ImgGen="cat"> and {{ImgGen="dog"}} end.'] }];
            const asked: unknown[] = [];
            const { events, terminal } = await job(
                "send",
                chaId,
                {},
                {
                    answerCallback: (event) => {
                        asked.push(event.payload);
                        return event.payload.prompt === "best, cat"
                            ? { outcome: "answered", value: { id: "inlay-cat" } }
                            : { outcome: "failed", failure: "hook", error: "no image" };
                    },
                },
            );
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            expect(callbacks(events).map((event) => event.name)).toEqual(["generateImage", "generateImage"]);
            expect(asked).toEqual([
                { prompt: "best, cat", negative: "neg", characterId: chaId },
                { prompt: "best, dog", negative: "neg", characterId: chaId },
            ]);
            const chat = await readChat(chaId);
            expect(texts(chat)).toEqual(["user:q", "char:A {{inlay::inlay-cat}} and  end."]);
            // The placeholder text was stored before the images were asked for.
            const generating = chatRecords(events).map((event) => storedText(event, chat.data.message[1].chatId));
            expect(generating).toContain("A [Generating...] and [Generating...] end.");
            expect(await clientSetText(chaId, chat.data.message[1].chatId, "edited by the tab")).toBe(200);
        },
        SLOW,
    );

    it(
        "the image view asks an imggen callback with the last user message and the character messages after it; a failed one is logged and the send completes",
        async () => {
            const chaId = await seedCharacter({
                name: "Ann",
                messages: [
                    { role: "char", data: "Older.", chatId: "c0" },
                    { role: "user", data: "Show me", chatId: "u1" },
                    { role: "char", data: "Earlier\nreply.", chatId: "c1" },
                ],
                extra: {
                    viewScreen: "imggen",
                    newGenData: {
                        prompt: "best, {{slot}}",
                        negative: "neg",
                        instructions: "Describe.",
                        emotionInstructions: "",
                    },
                },
            });
            answers = [{ chunks: ["Pic."] }];
            const shown = await job(
                "send",
                chaId,
                {},
                { answerCallback: () => ({ outcome: "answered", value: true }) },
            );
            expect(shown.terminal?.type, JSON.stringify(shown.terminal)).toBe("done");
            expect(callbacks(shown.events).map((event) => [event.name, event.payload])).toEqual([
                [
                    "imggen",
                    { characterId: chaId, text: "user: Show me \ncharacter: Earlier reply. \ncharacter: Pic. \n" },
                ],
            ]);
            answers = [{ chunks: ["Again."] }];
            const failed = await job(
                "send",
                chaId,
                {},
                { answerCallback: () => ({ outcome: "failed", failure: "hook", error: "no provider" }) },
            );
            expect(failed.terminal?.type, JSON.stringify(failed.terminal)).toBe("done");
            const chat = await readChat(chaId);
            expect(texts(chat).slice(-2)).toEqual(["char:Pic.", "char:Again."]);
            expect(await clientSetText(chaId, chat.data.message.at(-1).chatId, "edited by the tab")).toBe(200);
        },
        SLOW,
    );
});

describe("the emotion modes", () => {
    const EMOTIONS = [
        ["happy", "happy.png"],
        ["sad", "sad.png"],
        ["angry", "angry.png"],
        ["calm", "calm.png"],
        ["bored", "bored.png"],
    ];
    const history = (chaId: string, names: string[]) => ({ [chaId]: names });

    it(
        "the submodel mode: the four-message request with the biases from the history trimmed to four, the exact, contained, and no-match answers; a failed request is shown and ends the turn before the timing write",
        async () => {
            const chaId = await seedCharacter({
                name: "Ann",
                extra: { viewScreen: "emotion", emotionImages: EMOTIONS },
            });
            await withSettings({ emotionProcesser: "submodel" }, async () => {
                const five = ["happy", "sad", "angry", "calm", "bored"];
                answers = [{ chunks: ["Fine."] }, { chunks: ["Calm"] }];
                let before = bodies.length;
                const exact = await job("send", chaId, {}, { emotions: history(chaId, five) });
                expect(exact.terminal?.type, JSON.stringify(exact.terminal)).toBe("done");
                expect(bodies.length).toBe(before + 2);
                const request = bodies.at(-1);
                expect(request.max_tokens).toBe(30);
                expect(request.messages).toHaveLength(4);
                expect(request.messages[0].content).toMatch(/output only one word\.$/);
                expect(request.messages[3]).toEqual({ role: "user", content: "Fine." });
                // The oldest of five is dropped before scoring: its tokens keep the list's +10, the other
                // four take the penalties 5, 10, 15, 20.
                const biases = new Set(Object.values(request.logit_bias as Record<string, number>));
                expect([...biases].sort((a, b) => a - b)).toEqual([-10, -5, 0, 5, 10]);
                expect(notices(exact.events, "emotion").map((event) => event.payload)).toEqual([
                    { chaId, name: "calm", image: "calm.png" },
                ]);
                let chat = await readChat(chaId);
                // The mode ends the turn before the last generation-info write (the tab's early return).
                expect(chat.data.message.at(-1).generationInfo.stageTiming.stage3).toBe(0);
                expect(await clientSetText(chaId, chat.data.message.at(-1).chatId, "edited by the tab")).toBe(200);

                answers = [{ chunks: ["Fine."] }, { chunks: ["I feel rather SAD today"] }];
                const contained = await job("send", chaId, {}, { emotions: history(chaId, []) });
                expect(contained.terminal?.type).toBe("done");
                expect(notices(contained.events, "emotion").map((event) => event.payload.name)).toEqual(["sad"]);
                // No recent emotion: no penalty, every token at +10.
                expect(new Set(Object.values(bodies.at(-1).logit_bias as Record<string, number>))).toEqual(
                    new Set([10]),
                );

                answers = [{ chunks: ["Fine."] }, { chunks: ["nothing fits"] }];
                const none = await job("send", chaId);
                expect(none.terminal?.type).toBe("done");
                expect(notices(none.events, "emotion")).toHaveLength(0);
                expect(notices(none.events, "alertError")).toHaveLength(0);

                // The emotion request fails (its retries too): the error is shown, the send is done.
                answers = [{ chunks: ["Fine."] }];
                fallback = { chunks: [], status: 500 };
                before = bodies.length;
                const failed = await job("send", chaId);
                expect(failed.terminal?.type, JSON.stringify(failed.terminal)).toBe("done");
                expect(bodies.length).toBeGreaterThanOrEqual(before + 2);
                expect(notices(failed.events, "emotion")).toHaveLength(0);
                expect(notices(failed.events, "alertError")).toHaveLength(1);
                chat = await readChat(chaId);
                expect(texts(chat).at(-1)).toBe("char:Fine.");
                expect(await clientSetText(chaId, chat.data.message.at(-1).chatId, "edited by the tab")).toBe(200);
            });
        },
        SLOW,
    );

    it(
        "the embedding mode ranks by the dot product with the recency penalty on the history trimmed to four",
        async () => {
            const chaId = await seedCharacter({
                name: "Ann",
                extra: {
                    viewScreen: "emotion",
                    emotionImages: [
                        ["near", "near.png"],
                        ["mid", "mid.png"],
                        ["far", "far.png"],
                    ],
                },
            });
            await withSettings({ emotionProcesser: "embedding" }, async () => {
                answers = [{ chunks: ["Fine."] }];
                let before = bodies.length;
                const fresh = await job("send", chaId);
                expect(fresh.terminal?.type, JSON.stringify(fresh.terminal)).toBe("done");
                // No request of the provider for this mode.
                expect(bodies.length).toBe(before + 1);
                expect(notices(fresh.events, "emotion").map((event) => event.payload)).toEqual([
                    { chaId, name: "near", image: "near.png" },
                ]);
                // Five recent "near": the oldest is dropped, the four left cost 2+3+4+5 over 200 = 0.07,
                // so "near" (1 - 0.07 = 0.93) still beats "mid" (0.927). All five would cost 0.075.
                answers = [{ chunks: ["Fine."] }];
                const penalized = await job("send", chaId, {}, { emotions: history(chaId, Array(5).fill("near")) });
                expect(penalized.terminal?.type).toBe("done");
                expect(notices(penalized.events, "emotion").map((event) => event.payload.name)).toEqual(["near"]);
                expect(bodies.length).toBe(before + 2);
                const chat = await readChat(chaId);
                expect(chat.data.message.at(-1).generationInfo.stageTiming.stage3).toBe(0);
                expect(await clientSetText(chaId, chat.data.message.at(-1).chatId, "edited by the tab")).toBe(200);
            });
        },
        SLOW,
    );

    it("the route bounds context.client.emotions", async () => {
        const chaId = await seedCharacter({ name: "Ann" });
        const tooMany = await job("send", chaId, {}, { emotions: history(chaId, Array(6).fill("happy")) });
        expect(tooMany.status).toBe(400);
        expect(tooMany.body.error).toMatch(/context\.client\.emotions/);
        const notNames = await job("send", chaId, {}, { emotions: { [chaId]: [1] as unknown as string[] } });
        expect(notNames.status).toBe(400);
        const notAMap = await job("send", chaId, {}, { emotions: ["happy"] as unknown as Record<string, string[]> });
        expect(notAMap.status).toBe(400);
    });
});
