// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type GenerationTerminalEvent, NO_GENERATION_HOOKS } from "../../../shared/jobs.ts";
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
let mode: { chunks: string[]; delayMs: number; status?: number } = { chunks: ["Hel", "lo"], delayMs: 0 };
let onRequest: (() => Promise<void>) | null = null;
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
        res.end(JSON.stringify({ error: { message: "upstream broke" } }));
        return;
    }
    if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: mode.chunks.join("") } }] }));
        return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of mode.chunks) {
        if (res.destroyed) {
            return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        await sleep(mode.delayMs);
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
/** Patches the `providers` section (streaming, `inlayErrorResponse`, `presetChain`). */
async function patchProviders(patch: Record<string, unknown>) {
    const current = await single("providers");
    const res = await batch({
        ops: [{ kind: "providers", id: "main", baseRevision: current.revision, data: { ...current.data, ...patch } }],
    });
    expect(res.status).toBe(200);
}
/** Patches one preset by id. */
async function patchPreset(id: string, patch: Record<string, unknown>) {
    const current = await single("presets");
    const res = await batch({
        ops: [
            {
                kind: "presets",
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
                },
            },
        ],
        chats: [
            {
                characterId: chaId,
                chatId: "k",
                baseRevision: null,
                ops: [{ op: "create", chat: { id: "k", name: "K", fmIndex: -1, message: options.messages ?? [] } }],
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
const notices = (events: any[], kind: string) => events.filter((e) => e.type === "notice" && e.kind === kind);

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
    const personas = await single("personas");
    presetId = presets.data[0].id;
    personaId = personas.data[0].id;
    // The selected preset: a reverse proxy to the fake provider; `Alpha` the presetChain pick.
    const common = {
        aiModel: "reverse_proxy",
        subModel: "reverse_proxy",
        maxContext: 4000,
        maxResponse: 100,
        forceReplaceUrl: providerUrl,
        customProxyRequestModel: "m",
        jailbreakToggle: false,
    };
    const seededPresets = await batch({
        ops: [
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
    await patchProviders({ useStreaming: true, customTokenizer: "tik" });
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
            // Each chunk carries the whole text so far (the provider's events may coalesce on the wire, and
            // the parser re-sends the final text on `[DONE]`, as the client's does): growing, numbered, whole.
            const chunks = events.filter((event) => event.type === "chunk");
            expect(chunks.length).toBeGreaterThanOrEqual(2);
            expect(chunks.map((event) => event.seq)).toEqual(chunks.map((_, i) => i + 1));
            for (let i = 1; i < chunks.length; i++) {
                expect(chunks[i].text.startsWith(chunks[i - 1].text)).toBe(true);
            }
            expect(chunks.at(-1).text).toBe("Hello there.");
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
            expect(clash.terminal).toMatchObject({ type: "error", status: 409, message: /another message/ });
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
            // Each chunk is the whole text so far, the old reply included. The provider's two events may
            // still coalesce on the wire under load (as in the send test above), so the chunks are
            // checked as a growing sequence that ends with the whole reply, not as an exact list.
            const chunks = events.filter((event) => event.type === "chunk").map((event) => event.text);
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
            expect(events.filter((event) => event.type === "chunk").map((event) => event.text)).toEqual(["First."]);
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
            // While the first speaker's request runs, the stored preset changes its model.
            onRequest = async () => {
                onRequest = null;
                await patchPreset(presetId, { customProxyRequestModel: "changed-during-job" });
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
                await patchPreset(presetId, { customProxyRequestModel: "m" });
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
            expect(terminal).toMatchObject({ type: "error", message: /more than 100000 trigger effects/ });
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
            });
            expect(texts(await readChat(chaId))).toHaveLength(2);
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
