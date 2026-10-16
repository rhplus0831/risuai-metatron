// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type GenerationTerminalEvent, NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import { createSigner, createTestServer, json, sleep, waitFor } from "./testSupport.ts";

// Phase 5 slice 9: a send as a server job end to end (`server/src/prompt/runner.ts` `runPromptJob`,
// `server/src/prompt/scripts.ts`, `server/src/jobs/runSetup.ts`) on a real listening server with
// the default runner, the real worker pool (the regex scripts task, Lua), the production bindings,
// the job channel, and a fake OpenAI-compatible provider (SSE and JSON). The input stage (the input
// trigger, `editinput` through the worker, the plugin hook as a callback, the user message under
// its id, the retry that skips it, the id of another role refused); the streamed reply (chunks,
// `accepted`, `done` with the alternatives, the stored raw text and its generation info, the lock
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

// The provider: `mode` picks the next answer; `onRequest` runs when a request arrives.
let mode: {
    chunks: string[];
    delayMs: number;
    status?: number;
    /** The stream's socket is destroyed after this many chunks (a dropped connection). */
    breakAfterChunks?: number;
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
    if (mode.status) {
        res.writeHead(mode.status, { "content-type": "application/json" });
        // An OpenAI error envelope: the message (never stored on the event) and the code (slice 6).
        res.end(JSON.stringify({ error: { message: "upstream broke", code: "upstream_broke" } }));
        return;
    }
    if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        const content = plainAnswer ? plainAnswer(body) : mode.chunks.join("");
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
        return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    let sent = 0;
    for (const chunk of mode.chunks) {
        if (res.destroyed) {
            return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        await sleep(mode.delayMs);
        if (++sent === mode.breakAfterChunks) {
            res.destroy();
            return;
        }
    }
    res.write("data: [DONE]\n\n");
    res.end();
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
                        // Bound to the ids the jobs send (`docs/plan/chat-binding.md`): a job runs on its chat's binding.
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
    abortAfterChunks?: number;
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
    const created = await api("/api/generations", {
        method: "POST",
        body: JSON.stringify({
            kind,
            clientId: "tab",
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
    let opened!: () => void;
    socketOpen = new Promise<void>((resolve) => {
        opened = resolve;
    });
    const url =
        `${base.replace("http", "ws")}/api/generations/${jobId}/ws` +
        `?risu-auth=${encodeURIComponent(await signer.jwt())}&clientId=tab&attach=${++attach}`;
    const ws = new WebSocket(url);
    const events: any[] = [];
    let chunks = 0;
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
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 45_000);
        ws.onmessage = async (message) => {
            const event = JSON.parse(String(message.data));
            if (event.type === "ping") {
                return;
            }
            events.push(event);
            if (event.type === "chunk" && ++chunks === options.abortAfterChunks) {
                await api(`/api/generations/${jobId}?clientId=tab`, { method: "DELETE" });
            }
            if (event.type === "callback" && options.answerCallback) {
                ws.send(JSON.stringify({ type: "answer", id: event.id, ...options.answerCallback(event) }));
            }
            if (event.type === "done" || event.type === "error") {
                clearTimeout(timer);
                resolve();
            }
        };
    });
    ws.close();
    return {
        ...created,
        events,
        terminal: events.find((event) => event.type === "done" || event.type === "error"),
    };
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
/** The request history rows of a job, newest first (slice 6: the error event names the failed one). */
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
    const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1/chat/completions`;
    rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-prompt-runner-"));
    mkdirSync(path.join(rootDir, "dist"));
    writeFileSync(path.join(rootDir, "dist", "index.html"), "<!doctype html><html><head></head><body></body></html>");
    symlinkSync(path.join(REPO_ROOT, "public"), path.join(rootDir, "public"), "dir");
    cpSync(path.join(REPO_ROOT, "version.json"), path.join(rootDir, "version.json"));
    mkdirSync(path.join(rootDir, "save", "server"), { recursive: true });
    writeFileSync(path.join(rootDir, "save", "server", "password"), "pw");
    server = createTestServer({ rootDir, generationRandom: () => 0 });
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
    const presets = await single("presets");
    const modelPresets = await single("modelPresets");
    const modelProfiles = await single("modelProfiles");
    const personas = await single("personas");
    presetId = presets.data[0].id;
    modelPresetId = modelPresets.data[0].id;
    profileId = modelProfiles.data[0].id;
    personaId = personas.data[0].id;
    // The selected model preset's main and sub slots use one profile: a reverse proxy to the fake
    // provider. The prompt presets: the selected one and `Alpha`, the presetChain pick
    // (`docs/plan/split-preset.md`, `docs/plan/model-profiles.md`).
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
                        regex: [editinputScript("preset")],
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
        "runs the input stage (the input trigger, editinput in the worker, the user message under its id) and streams the raw reply",
        async () => {
            const chaId = await seedCharacter({
                name: "Ann",
                triggerscript: [trig("input", [ef("v2SetVar", { var: "seen", operator: "=", ...v("yes") })])],
            });
            mode = { chunks: ["Hel", "lo ", "there."], delayMs: 40 };
            const before = bodies.length;
            const { events, terminal } = await job("send", chaId, { input: "hi you", userMessageId: "user-1" });
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
            const chat = await readChat(chaId);
            expect(texts(chat)).toEqual(["user:hello you", "char:Hello there."]);
            const [user, reply] = chat.data.message;
            expect(user.chatId).toBe("user-1");
            expect(chat.data.scriptstate?.$seen).toBe("yes");
            expect(reply.saying).toBe(chaId);
            expect(reply.generationInfo).toMatchObject({ generationId: reply.chatId, model: "custom-m" });
            // The events: the bare accepted, the input stage's, the reply's, the chunks, one done.
            // The bare first `accepted` may precede the socket's attach (an attach re-sends only the current one).
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
                alternatives: ["Hello there."],
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
            const { events, terminal } = await job("continue", chaId);
            expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
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
            // The alternatives are the provider's values as they came (the tab's `Object.values(lastChunk)`).
            expect((terminal as any).alternatives).toEqual([" More text."]);
            expect(await clientSetText(chaId, "r1", "tab edit")).toBe(200);
        },
        SLOW,
    );

    it(
        "checkpoints a stalled stream on the timer, and an abort keeps the text so far and releases the lock",
        async () => {
            const chaId = await seedCharacter({ name: "Ann", messages: [{ role: "user", data: "q", chatId: "u1" }] });
            mode = { chunks: ["First.", " Never."], delayMs: 20_000 };
            const started = Date.now();
            // The DELETE fires on the first chunk, while the provider stalls before its second one.
            const { events, terminal } = await job("send", chaId, {}, { abortAfterChunks: 1 });
            expect(terminal).toMatchObject({ type: "error", status: 499, reason: "aborted" });
            expect(Date.now() - started).toBeLessThan(15_000);
            expect(streamedTexts(events).map((chunk) => chunk.text)).toEqual(["First."]);
            expect(events.filter((event) => event.type === "done")).toHaveLength(0);
            const chat = await readChat(chaId);
            expect(texts(chat)).toEqual(["user:q", "char:First."]);
            expect(await clientSetText(chaId, chat.data.message.at(-1).chatId, "tab edit")).toBe(200);
        },
        SLOW,
    );

    it(
        "writes the checkpoint 3 s after a chunk while the provider stalls, before any other chunk",
        { tags: ["slow"], timeout: SLOW },
        async () => {
            const chaId = await seedCharacter({ name: "Ann" });
            mode = { chunks: ["First.", " Second."], delayMs: 4500 };
            const pending = job("send", chaId);
            // The reply exists once the first chunk is out; its stored text is still empty.
            let reply: any;
            await waitFor(() => {
                void readChat(chaId).then((chat) => (reply = chat.data.message.at(-1)));
                return reply?.role === "char";
            }, 10_000);
            expect(reply.data).toBe("");
            await sleep(3600);
            expect(texts(await readChat(chaId)).at(-1)).toBe("char:First.");
            const { terminal } = await pending;
            expect(terminal?.type).toBe("done");
            expect(texts(await readChat(chaId)).at(-1)).toBe("char:First. Second.");
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
                const { events, terminal } = await job("group", grp);
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
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
        "a group send's completion notifications name the group's chat and use the group's name and custom message, not the speaking member's (docs/plan/web-push.md)",
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
                    tag: "risuai-chat-completion",
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
            // The error names where it failed (slice 6): the request stage, the last attempt's history
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

    it(
        "previewPrompt answers the provider body and preview the assembled messages, generating nothing",
        async () => {
            const chaId = await seedCharacter({ name: "Ann", messages: [{ role: "user", data: "q", chatId: "u1" }] });
            const before = bodies.length;
            const body = await job("previewPrompt", chaId);
            expect(body.terminal?.type).toBe("done");
            const parsed = JSON.parse((body.terminal as any).result);
            expect(parsed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/);
            expect(parsed.body.model).toBe("m");
            const preview = await job("preview", chaId);
            expect(preview.terminal?.type).toBe("done");
            const formated = (preview.terminal as any).result as { role: string; content: string }[];
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
                expect(((missing.terminal as any).result as any[])[0].content).toMatch(/^Main Ann/);
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
            mode = { chunks: ["First.", " Never."], delayMs: 150, breakAfterChunks: 1 };
            try {
                const { body, events, terminal } = await job("send", chaId);
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
                mode = { chunks: ["x"], delayMs: 0 };
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

describe("automatic translation of a send's messages (docs/plan/translation.md slice 2.3)", () => {
    /** Polls the chat until `condition` holds on it. */
    async function chatUntil(chaId: string, condition: (chat: any) => boolean, timeoutMs = 10_000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const chat = await readChat(chaId);
            if (condition(chat.data)) {
                return chat;
            }
            if (Date.now() > deadline) {
                throw new Error(`chat ${chaId}: ${JSON.stringify(chat.data.message)}`);
            }
            await sleep(25);
        }
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
                await waitFor(() => bodies.length === before + 3, 10_000);
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
            const before = bodies.length;
            const off = await job("send", plain, { input: "hi", userMessageId: "u1" });
            expect(off.terminal?.type).toBe("done");
            expect(translating(off.events)).toEqual([]);
            await sleep(200);
            expect(bodies.length).toBe(before + 1);
            expect(translations(await readChat(plain))).toEqual([
                ["u1", null],
                [(off.terminal as any).messageId, null],
            ]);
            await waitFor(() => server.context.translationRunner.runningCount() === 0);
        },
        SLOW,
    );

    it(
        "an aborted send hands nothing over: no notice, and neither its partial reply nor its user message is translated",
        async () => {
            const chaId = await seedCharacter({ name: "Ann", chat: { autoTranslate: true } });
            mode = { chunks: ["First.", " Never."], delayMs: 20_000 };
            const before = bodies.length;
            const { events, terminal } = await job(
                "send",
                chaId,
                { input: "hi", userMessageId: "u1" },
                { abortAfterChunks: 1 },
            );
            expect(terminal).toMatchObject({ type: "error", status: 499, reason: "aborted" });
            expect(translating(events)).toEqual([]);
            await sleep(200);
            expect(bodies.length).toBe(before + 1);
            expect(server.context.translationRunner.runningCount()).toBe(0);
            expect(translations(await readChat(chaId))).toEqual([
                ["u1", null],
                [expect.any(String), null],
            ]);
            expect(texts(await readChat(chaId))).toEqual(["user:hello", "char:First."]);
        },
        SLOW,
    );
});

// Audit item A2: the owner record's `lastInteraction` is the job's to stamp (`stampInteraction` in
// `runner.ts`): a field patch with the server clock, published on the change feed with only that
// field, never a character record on the job socket; a preview stamps nothing.
describe("the lastInteraction stamp", () => {
    const readCharacter = async (id: string) =>
        (await api(`/api/resources/characters/${encodeURIComponent(id)}`)).body as {
            revision: string;
            data: Record<string, any>;
        };
    /** The live-update socket (`/api/events/ws`), collecting every frame after `hello`. */
    async function feedSocket() {
        const ws = new WebSocket(
            `${base.replace("http", "ws")}/api/events/ws?risu-auth=${encodeURIComponent(await signer.jwt())}`,
        );
        const frames: any[] = [];
        ws.onmessage = (message) => frames.push(JSON.parse(String(message.data)));
        await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error("the feed socket did not open"));
        });
        await waitFor(() => frames.some((frame) => frame.type === "hello"));
        return { frames, close: () => ws.close() };
    }
    const stampEntries = (frames: any[], id: string) =>
        frames
            .filter((frame) => frame.type === "change")
            .flatMap((frame) => frame.changes.resources as any[])
            .filter((entry) => entry.kind === "characters" && entry.id === id);
    const next = (revision: string) => revision.replace(/:(\d+)$/, (_, n: string) => `:${Number(n) + 1}`);
    /** Runs a job and checks the owner's stamp: server time, one revision, nothing else of the record changed. */
    async function stamps(kind: string, owner: string, extra: Record<string, unknown>, frames: any[]) {
        const before = await readCharacter(owner);
        const started = Date.now();
        const result = await job(kind, owner, extra);
        expect(result.terminal?.type, JSON.stringify(result.terminal)).toBe("done");
        const after = await readCharacter(owner);
        expect(after.data.lastInteraction).toBeGreaterThanOrEqual(started);
        expect(after.data.lastInteraction).toBeLessThanOrEqual(Date.now());
        expect(after.revision).toBe(next(before.revision));
        expect({ ...after.data, lastInteraction: before.data.lastInteraction }).toEqual(before.data);
        await waitFor(() => stampEntries(frames, owner).some((entry) => entry.revision === after.revision));
        expect(stampEntries(frames, owner).filter((entry) => entry.revision === after.revision)).toEqual([
            {
                kind: "characters",
                id: owner,
                revision: after.revision,
                patch: {
                    baseRevision: before.revision,
                    set: { lastInteraction: after.data.lastInteraction },
                    remove: [],
                },
            },
        ]);
        // No character record reaches the job socket for the stamp (no receipt, no whole-record hydration).
        expect(result.events.filter((event) => event.type === "resource" && event.kind === "characters")).toEqual([]);
        return { before, after, result };
    }

    it(
        "send, continue, and group stamp the owner once with the server clock as a field patch on the feed; a future stamp is replaced",
        async () => {
            mode = { chunks: ["Ok."], delayMs: 0 };
            // A stamp an older client clock wrote in the future is overwritten with the server's time.
            const future = Date.now() + 86_400_000;
            const ann = await seedCharacter({ name: "Ann", extra: { lastInteraction: future } });
            const bob = await seedCharacter({ name: "Bob" });
            const grp = await seedCharacter({
                name: "Grp",
                type: "group",
                members: [bob],
                messages: [{ role: "user", data: "hello all", chatId: "u0" }],
            });
            // The feed opens after the seeds: every character entry it sees from here on is a job's.
            const feed = await feedSocket();
            try {
                expect((await readCharacter(ann)).data.lastInteraction).toBe(future);
                const sent = await stamps("send", ann, { input: "hi", userMessageId: "u1" }, feed.frames);
                expect(sent.after.data.lastInteraction).toBeLessThan(future);
                // One stamp per job: the one character change the send made.
                expect(stampEntries(feed.frames, ann)).toHaveLength(1);
                await stamps("continue", ann, {}, feed.frames);
                expect(stampEntries(feed.frames, ann)).toHaveLength(2);

                const bobBefore = await readCharacter(bob);
                await stamps("group", grp, {}, feed.frames);
                expect(await readCharacter(bob)).toEqual(bobBefore);
                expect(stampEntries(feed.frames, bob)).toEqual([]);
            } finally {
                feed.close();
            }
        },
        SLOW,
    );

    it(
        "a preview or a prompt preview stamps nothing",
        async () => {
            const ann = await seedCharacter({ name: "Ann", extra: { lastInteraction: 5 } });
            const feed = await feedSocket();
            try {
                const before = await readCharacter(ann);
                for (const kind of ["preview", "previewPrompt"]) {
                    const { terminal } = await job(kind, ann);
                    expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                }
                expect(await readCharacter(ann)).toEqual(before);
                expect(stampEntries(feed.frames, ann)).toEqual([]);
            } finally {
                feed.close();
            }
        },
        SLOW,
    );
});
