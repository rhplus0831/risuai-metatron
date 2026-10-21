// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GenerationTerminalEvent } from "../../../shared/jobs.ts";
import { allowListenerOrigin, createSigner, createTestServer, json, sleep } from "./testSupport.ts";
import { UNHURRIED_SCRIPT_WORKERS } from "./unhurriedLimits.ts";

// A Lua button as a server `command` job, end to end on a real listening server
// with the default runner (`server/src/jobs/commandRunner.ts`), the real worker pool and prelude,
// the production bindings (`server/src/lua/bindings.ts`) over the job scope (`jobScope.ts`,
// `cbsHost.ts`), the job channel over the owner socket, and the request layer against a mock
// provider. The route's command validation; the host-function contract (shapes, guards, the table
// bridges, the frozen effective persona, CBS and lore over the scope, the live character reads,
// the chat writes by id); permission provenance per trigger (the character's `lowLevelAccess`
// versus a module's) and the trigger order; the group refusal; a load failure versus a handler
// error; the fatal latch (a barrier failure caught by `pcall` has no later effect); writes built
// from the current chat after an external edit; and the notices kept before the owner's first
// attach (an ended job, and the order against a question). The in-process `runInJob` is in
// `llmRequests.test.ts`; the hub's byte budget in `jobChannel.test.ts`.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SLOW = 60_000;

type Provider = { body: { model: string; messages: { role: string; content: string }[] }; auth?: string };
type EmbeddingCall = { body: { input: string | string[]; model?: string }; auth?: string };

let provider: http.Server;
let providerUrl = "";
const providerCalls: Provider[] = [];
let embedder: http.Server;
let embedderUrl = "";
const embeddingCalls: EmbeddingCall[] = [];
/**
 * The mock embedding server's vectors: `q` is the query, and `near`, `mid`, `far` rank by their dot
 * product with it (0.9, 0.5, 0); any other text is the zero vector.
 */
const MOCK_VECTORS: Record<string, number[]> = {
    q: [1, 0],
    near: [0.9, 0.1],
    mid: [0.5, 0.5],
    far: [0, 1],
};
let rootDir = "";
let server: ReturnType<typeof createTestServer>;
let node: http.Server;
let base = "";
let epoch = "";
let signer: Awaited<ReturnType<typeof createSigner>>;
let presetId = "";
let modelPresetId = "";
let defaultPersonaId = "";
let defaultPersonaName = "";

async function api(url: string, init: RequestInit = {}) {
    const res = await fetch(`${base}${url}`, {
        ...init,
        headers: {
            "risu-auth": await signer.jwt(),
            "x-resource-epoch": epoch,
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

beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The mock provider: an OpenAI-compatible answer echoing the last message.
    provider = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(chunk as Buffer);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        providerCalls.push({ body, auth: req.headers.authorization });
        const last = body.messages?.at(-1)?.content ?? "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `mock:${last}` } }] }));
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
    allowListenerOrigin(provider);
    providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1/chat/completions`;
    // The mock embedding server (`hypaModel: "custom"`): deterministic vectors per input text, in the
    // OpenAI-compatible `{ data: [{ embedding }] }` shape; no local model, nothing on the network.
    embedder = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(chunk as Buffer);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as EmbeddingCall["body"];
        embeddingCalls.push({ body, auth: req.headers.authorization });
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: inputs.map((text) => ({ embedding: MOCK_VECTORS[text] ?? [0, 0] })) }));
    });
    await new Promise<void>((resolve) => embedder.listen(0, "127.0.0.1", () => resolve()));
    allowListenerOrigin(embedder);
    embedderUrl = `http://127.0.0.1:${(embedder.address() as { port: number }).port}/v1`;

    // The server's root: `public/` (json.lua, the tokenizer payloads) and `version.json` as the
    // repository has them, an empty `save/`.
    rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-lua-bindings-"));
    mkdirSync(path.join(rootDir, "dist"));
    writeFileSync(path.join(rootDir, "dist", "index.html"), "<!doctype html><html><head></head><body></body></html>");
    symlinkSync(path.join(REPO_ROOT, "public"), path.join(rootDir, "public"), "dir");
    cpSync(path.join(REPO_ROOT, "version.json"), path.join(rootDir, "version.json"));
    mkdirSync(path.join(rootDir, "save", "server"), { recursive: true });
    writeFileSync(path.join(rootDir, "save", "server", "password"), "pw");
    server = createTestServer({ rootDir, scriptWorkerOptions: UNHURRIED_SCRIPT_WORKERS });
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

    // One profile on the mock provider for both the main and the aux model's slot; a second persona
    // the chats can bind, with a prompt CBS parses; the embeddings on the mock embedding server.
    const presets = await single("presets");
    const modelPresets = await single("modelPresets");
    const modelProfiles = await single("modelProfiles");
    const profileId = modelProfiles.data[0].id;
    const personas = await single("personas");
    const memorySettings = await single("memoryTranslateMedia");
    const secrets = await single("secrets");
    presetId = presets.data[0].id;
    modelPresetId = modelPresets.data[0].id;
    defaultPersonaId = personas.data[0].id;
    defaultPersonaName = personas.data[0].name;
    const seeded = await api("/api/resources/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            ops: [
                {
                    kind: "modelProfiles",
                    id: "main",
                    baseRevision: modelProfiles.revision,
                    data: modelProfiles.data.map((profile: any, index: number) =>
                        index === 0
                            ? {
                                  ...profile,
                                  modelId: "reverse_proxy",
                                  forceReplaceUrl: providerUrl,
                                  customProxyRequestModel: "mock",
                              }
                            : profile,
                    ),
                },
                {
                    kind: "modelPresets",
                    id: "main",
                    baseRevision: modelPresets.revision,
                    data: modelPresets.data.map((preset: any, index: number) =>
                        index === 0 ? { ...preset, mainSlot: { profileId }, subSlot: { profileId } } : preset,
                    ),
                },
                {
                    kind: "personas",
                    id: "main",
                    baseRevision: personas.revision,
                    data: [...personas.data, { id: "bound", name: "Bound", personaPrompt: "I am {{user}}" }],
                },
                {
                    kind: "memoryTranslateMedia",
                    id: "main",
                    baseRevision: memorySettings.revision,
                    data: { ...memorySettings.data, hypaModel: "custom" },
                },
                {
                    kind: "secrets",
                    id: "main",
                    baseRevision: secrets.revision,
                    data: {
                        ...secrets.data,
                        hypaCustomSettings: { url: embedderUrl, key: "embed-key", model: "mock-embed" },
                    },
                },
            ],
        }),
    });
    expect(seeded.status).toBe(200);
}, SLOW);

afterAll(async () => {
    await server?.close();
    node?.closeAllConnections();
    await new Promise((resolve) => node?.close(resolve));
    provider?.close();
    embedder?.close();
    rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

/** `onButtonClick` around a handler body. */
const button = (body: string) => `onButtonClick = async(function(id, data)\n${body}\nend)`;
const luaTrigger = (code: string, comment = "lua") => ({
    comment,
    type: "manual",
    conditions: [],
    effect: [{ type: "triggerlua", code }],
});

let seeded = 0;
/** A character with Lua triggers and its chat `k` (`[char greeting, user hi there]`, a note). */
async function seedCharacter(options: {
    codes: string[];
    lowLevelAccess?: boolean;
    type?: "character" | "group";
    bindPersona?: boolean;
    extra?: Record<string, unknown>;
}) {
    const chaId = `lua-${++seeded}`;
    const characterRecord: Record<string, unknown> = {
        chaId,
        name: "Lua Char",
        type: options.type ?? "character",
        firstMessage: "first!",
        desc: "a desc",
        backgroundHTML: "",
        defaultVariables: "dv=7",
        lowLevelAccess: options.lowLevelAccess ?? true,
        globalLore: [
            {
                key: "",
                comment: "always",
                content: "Always {{user}}",
                alwaysActive: true,
                insertorder: 100,
                mode: "normal",
                secondkey: "",
                selective: false,
            },
        ],
        triggerscript: options.codes.map((code, index) => luaTrigger(code, `t${index}`)),
        ...(options.type === "group" ? { characters: [] } : {}),
        ...options.extra,
    };
    const res = await api("/api/resources/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            ops: [{ kind: "characters", id: chaId, baseRevision: null, data: characterRecord }],
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
                                note: "note!",
                                // The binding the jobs send: a job runs on its chat's binding.
                                modelPresetId,
                                promptPresetId: presetId,
                                bindedPersona: options.bindPersona ? "bound" : defaultPersonaId,
                                message: [
                                    { role: "char", data: "greeting", chatId: "m1" },
                                    { role: "user", data: "hi there", chatId: "m2" },
                                ],
                            },
                        },
                    ],
                },
            ],
        }),
    });
    expect(res.status).toBe(200);
    return chaId;
}

const readChat = async (chaId: string) =>
    (
        await api("/api/resources/read", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chats: [{ characterId: chaId, id: "k" }] }),
        })
    ).body.chats[0] as { revision: string; data: any };
const readCharacter = async (chaId: string) => (await api(`/api/resources/characters/${chaId}`)).body;
const texts = (chat: { data: any }) => chat.data.message.map((m: any) => `${m.role}:${m.data}`);

type Answerer = (event: any) => unknown | Promise<unknown>;
const context = async (chaId: string, bound = false) => ({
    characterId: chaId,
    chatId: "k",
    presetId,
    modelPresetId,
    personaId: bound ? "bound" : defaultPersonaId,
    selectedPersonaId: defaultPersonaId,
    mode: "button",
    input: "",
    chatRevision: (await readChat(chaId)).revision,
    client: { viewport: { width: 800, height: 600 }, browserLanguage: "ko" },
});
const createJob = (body: Record<string, unknown>) =>
    api("/api/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });

/**
 * Attaches the owner socket of `jobId` (after `attachAfterMs`) and collects its events until the
 * terminal: a question is answered with `answer(event)` (undefined: left pending), a callback with
 * `callback(event)` (an answer message; the default is an ordinary hook failure).
 */
async function follow(
    jobId: string,
    options: { answer?: Answerer; callback?: (event: any) => Record<string, unknown>; attachAfterMs?: number } = {},
): Promise<{ events: any[]; terminal: GenerationTerminalEvent | undefined }> {
    if (options.attachAfterMs) {
        await sleep(options.attachAfterMs);
    }
    const events: any[] = [];
    const url =
        `${base.replace("http", "ws")}/api/generations/${jobId}/ws` +
        `?risu-auth=${encodeURIComponent(await signer.jwt())}&clientId=tab&attach=${Date.now()}`;
    const ws = new WebSocket(url);
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 30_000);
        ws.onmessage = async (message) => {
            const event = JSON.parse(String(message.data));
            if (event.type === "ping") {
                return;
            }
            events.push(event);
            if (event.type === "question") {
                const value = await options.answer?.(event);
                if (value !== undefined) {
                    ws.send(JSON.stringify({ type: "answer", id: event.id, outcome: "answered", value }));
                }
            }
            if (event.type === "callback") {
                const answer = options.callback?.(event) ?? { outcome: "failed", failure: "hook", error: "no tab" };
                ws.send(JSON.stringify({ type: "answer", id: event.id, ...answer }));
            }
            if (event.type === "done" || event.type === "error") {
                clearTimeout(timer);
                resolve();
            }
        };
    });
    ws.close();
    const terminal = events.find((event) => event.type === "done" || event.type === "error");
    return { events, terminal };
}

async function runButton(
    chaId: string,
    options: {
        data?: string;
        bound?: boolean;
        answer?: Answerer;
        callback?: (event: any) => Record<string, unknown>;
        attachAfterMs?: number;
    } = {},
) {
    const created = await createJob({
        kind: "command",
        clientId: "tab",
        context: await context(chaId, options.bound),
        command: { type: "button", data: options.data ?? "go" },
    });
    expect(created.status).toBe(200);
    const jobId = created.body.jobId as string;
    const result = await follow(jobId, options);
    return { jobId, ...result };
}

const notice = (events: any[], kind: string) =>
    events.find((event) => event.type === "notice" && event.kind === kind)?.payload?.message as string | undefined;

describe("the route", () => {
    it("requires `command` for a command job and refuses it on any other kind", async () => {
        const chaId = await seedCharacter({ codes: [] });
        expect((await createJob({ kind: "command", clientId: "tab", context: await context(chaId) })).status).toBe(400);
        expect(
            (
                await createJob({
                    kind: "send",
                    clientId: "tab",
                    context: await context(chaId),
                    command: { type: "button", data: "x" },
                })
            ).status,
        ).toBe(400);
        expect(
            (
                await createJob({
                    kind: "command",
                    clientId: "tab",
                    context: await context(chaId),
                    command: { type: "button", data: "x".repeat(64 * 1024 + 1) },
                })
            ).status,
        ).toBe(400);
        expect(
            (
                await createJob({
                    kind: "command",
                    clientId: "tab",
                    context: {
                        ...(await context(chaId)),
                        client: { viewport: { width: -1, height: 1 }, browserLanguage: "ko" },
                    },
                    command: { type: "button", data: "x" },
                })
            ).status,
        ).toBe(400);
    });
});

describe("the job's Lua budget", () => {
    it(
        "is one budget from the pool's createBudget, which every run of the button shares",
        async () => {
            const pool = server.context.scriptWorkers;
            const budgets = vi.spyOn(pool, "createBudget");
            const runs = vi.spyOn(pool, "runLua");
            try {
                const chaId = await seedCharacter({ codes: [button(`return "one"`), button(`return "two"`)] });
                const { terminal } = await runButton(chaId);
                expect(terminal?.type, JSON.stringify(terminal)).toBe("done");
                expect(budgets).toHaveBeenCalledTimes(1);
                const budget = budgets.mock.results[0].value;
                expect(budget.totalMs).toBe(UNHURRIED_SCRIPT_WORKERS.luaBudgetMs);
                expect(runs.mock.calls.map(([, run]) => run?.budget)).toEqual([budget, budget]);
            } finally {
                runs.mockRestore();
                budgets.mockRestore();
            }
        },
        SLOW,
    );
});

describe("the host-function contract through the real worker", () => {
    it(
        "answers the client's shapes and values over the job scope: reads, variables, CBS, the bound persona, live character reads and setters, hash, tokens, questions, lore, LLM, similarity, and the staged refusals",
        async () => {
            const code = button(`
                local R = {}
                R.chat0 = getChatMain(id, 0)
                R.chatNeg = getChatData(id, -1)
                R.roleNeg = getChatRole(id, -1)
                R.chatMissing = getChatMain(id, 9)
                R.dataMissing = getChatData(id, 9)
                R.len = getChatLength(id)
                R.recent = getRecentChatsMain(id, 1)
                R.var0 = getChatVar(id, "nope")
                R.dv = getChatVar(id, "dv")
                local changed1 = setChatVarChanged(id, "x", "1")
                local changed2 = setChatVarChanged(id, "x", "1")
                R.changed1 = tostring(changed1)
                R.changed2 = type(changed2)
                local refusedSync = getDescription("not-a-key")
                R.refusedSync = type(refusedSync)
                local refusedAsync = getTokens("not-a-key", "x"):await()
                R.refusedAsync = type(refusedAsync)
                R.cbsSetvar = cbs("{{setvar::fromcbs::1}}") .. "|" .. getChatVar(id, "fromcbs")
                R.persona = getPersonaName(id)
                R.personaDesc = getPersonaDescription(id)
                R.note = getAuthorsNote(id)
                R.name = getName(id)
                R.desc = getDescription(id)
                R.first = getCharacterFirstMessage(id)
                R.bg = getBackgroundEmbedding(id)
                setName(id, "Renamed")
                setDescription(id, "new desc")
                R.setFirst = tostring(setCharacterFirstMessage(id, "new first"))
                R.setFirstBad = tostring(setCharacterFirstMessage(id, 5))
                R.setBg = tostring(setBackgroundEmbedding(id, "<b>bg</b>"))
                R.nameAfter = getName(id)
                R.cbs = cbs("{{char}}|{{user}}|{{getvar::x}}|{{screenwidth}}|{{metadata::browserlanguage}}|{{getglobalvar::g}}")
                R.hash = hash(id, "abc"):await()
                R.tokens = getTokens(id, "hello world"):await()
                R.input = alertInput(id, "Who?"):await()
                R.sel = alertSelect(id, {"a", "b"}):await()
                R.conf = alertConfirm(id, "sure?"):await()
                upsertLocalLoreBook(id, "lua-lore", "lore {{char}} content", {key = "kk", insertOrder = 5})
                R.lore = getLoreBooksMain(id, "lua-lore")
                R.loaded = loadLoreBooks(id)
                R.lastChar = getCharacterLastMessage(id)
                R.lastUser = getUserLastMessage(id)
                R.llm = LLM(id, {{role = "sys", content = "S"}, {role = "user", content = "hi from lua"}})
                R.simple = simpleLLM(id, "simple"):await()
                R.ax = axLLM(id, {{role = "user", content = "ax"}})
                R.sim = similarity(id, "q", {"far", "mid", "near"}):await()
                R.img = getCharacterImage(id)
                R.gen = generateImage(id, "a cat", "bad"):await()
                alertNormal(id, json.encode(R))
            `);
            const chaId = await seedCharacter({ codes: [code], bindPersona: true });
            providerCalls.length = 0;
            embeddingCalls.length = 0;
            const callbacks: any[] = [];
            const { events, terminal } = await runButton(chaId, {
                bound: true,
                answer: (event) => (event.kind === "alertInput" ? "Ada" : event.kind === "alertSelect" ? "1" : true),
                callback: (event) => {
                    callbacks.push(event);
                    return { outcome: "failed", failure: "hook", error: "no image backend" };
                },
            });
            expect(terminal?.type).toBe("done");
            expect(events.find((event) => event.type === "accepted")).toMatchObject({ type: "accepted" });
            expect(events.find((event) => event.type === "accepted").messageId).toBeUndefined();
            const R = JSON.parse(notice(events, "alertNormal")!);

            // Reads: the client's projections, negative indexes, the missing-index values.
            expect(JSON.parse(R.chat0)).toEqual({ role: "char", data: "greeting", time: 0 });
            expect(R.chatNeg).toBe("hi there");
            expect(R.roleNeg).toBe("user");
            expect(R.chatMissing).toBe("null");
            expect(R.dataMissing).toBe("");
            expect(R.len).toBe(2);
            expect(JSON.parse(R.recent)).toEqual([{ role: "user", data: "hi there", time: 0 }]);
            // Variables: the literal "null", the character's default, changed only once; Lua `cbs`
            // does not persist `{{setvar}}` (no `runVar`).
            expect(R.var0).toBe("null");
            expect(R.dv).toBe("7");
            expect(R.changed1).toBe("true");
            // As the client: no change and a refused guard are `nil`, synchronous or awaited.
            expect(R.changed2).toBe("nil");
            expect(R.refusedSync).toBe("nil");
            expect(R.refusedAsync).toBe("nil");
            // Without `runVar` the shared evaluator leaves `{{setvar}}` as text, as on the client.
            expect(R.cbsSetvar).toBe("{{setvar::fromcbs::1}}|null");
            // The frozen effective persona (the chat's bound one), its prompt parsed with the engine.
            expect(R.persona).toBe("Bound");
            expect(R.personaDesc).toBe("I am Bound");
            expect(R.note).toBe("note!");
            // The run character, read live: before and after the setters in one run.
            expect([R.name, R.desc, R.first, R.bg]).toEqual(["Lua Char", "a desc", "first!", ""]);
            expect([R.setFirst, R.setFirstBad, R.setBg]).toEqual(["true", "false", "true"]);
            expect(R.nameAfter).toBe("Renamed");
            // CBS over the scope: the renamed character, the bound persona, the written variable,
            // the tab's viewport and language, a missing global.
            expect(R.cbs).toBe("Renamed|Bound|1|800|ko|null");
            expect(R.hash).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
            expect(typeof R.tokens).toBe("number");
            expect(R.tokens).toBeGreaterThan(0);
            // Questions through the channel: the answered values, confirm as a boolean.
            expect([R.input, R.sel, R.conf]).toEqual(["Ada", "1", true]);
            expect(events.filter((event) => event.type === "question").map((event) => event.kind)).toEqual([
                "alertInput",
                "alertSelect",
                "alertConfirm",
            ]);
            // Lore: the upsert through the options table, read back parsed; activation of the
            // always-active entry with the user's name.
            expect(JSON.parse(R.lore)).toEqual([
                expect.objectContaining({
                    comment: "lua-lore",
                    content: "lore Renamed content",
                    key: "kk",
                    insertorder: 5,
                    alwaysActive: false,
                    useRegex: false,
                    selective: false,
                }),
            ]);
            expect(R.loaded).toEqual([{ data: "Always Bound", role: "system" }]);
            expect(R.lastChar).toBe("greeting");
            expect(R.lastUser).toBe("hi there");
            // LLM through the server request layer: the JSON result, the role mapping, the aux model;
            // simpleLLM as a table.
            expect(R.llm).toEqual({ success: true, result: "mock:hi from lua" });
            expect(R.simple).toEqual({ success: true, result: "mock:simple" });
            expect(R.ax).toEqual({ success: true, result: "mock:ax" });
            const llmCall = providerCalls.find((call) => call.body.messages.at(-1)?.content === "hi from lua")!;
            expect(llmCall.body.messages.map((message) => message.role)).toEqual(["system", "user"]);
            expect(providerCalls.every((call) => call.body.model === "mock")).toBe(true);
            // Similarity through the server embeddings (the job's `hypaModel: "custom"` on the mock
            // embedding server): the values as a table ranked by their similarity to the source, the
            // values embedded as documents and the source as the query, with the settings' key and model.
            expect(R.sim).toEqual(["near", "mid", "far"]);
            expect(embeddingCalls.map((call) => call.body.input)).toEqual([["far", "mid", "near"], "q"]);
            expect(embeddingCalls.every((call) => call.body.model === "mock-embed")).toBe(true);
            expect(embeddingCalls.every((call) => call.auth === "Bearer embed-key")).toBe(true);
            // The empty image, the image callback's ordinary failure.
            expect(R.img).toBe("");
            expect(R.gen).toBe("Error: Image generation failed");
            expect(callbacks).toHaveLength(1);
            expect(callbacks[0]).toMatchObject({
                name: "generateImage",
                payload: { prompt: "a cat", negative: "bad", characterId: chaId },
            });

            // Stored: the character's fields, the chat's variables and local lore; hydrated to the tab.
            const character = await readCharacter(chaId);
            expect(character.data).toMatchObject({
                name: "Renamed",
                desc: "new desc",
                firstMessage: "new first",
                backgroundHTML: "<b>bg</b>",
            });
            const chat = await readChat(chaId);
            expect(chat.data.scriptstate).toEqual({ $x: "1" });
            expect(chat.data.localLore.map((book: any) => book.comment)).toEqual(["lua-lore"]);
            expect(events.some((event) => event.type === "resource" && event.kind === "characters")).toBe(true);
            expect(events.some((event) => event.type === "resource" && event.kind === "chats")).toBe(true);
        },
        SLOW,
    );

    it(
        "writes the chat by id: append, insert at a position, text and role edits, remove, cut, and a whole replacement that keeps the metadata",
        async () => {
            const first = button(`
                addChat(id, "char", "added")
                insertChat(id, 0, "user", "inserted")
                insertChat(id, 2, "char", "mid")
                setChat(id, 1, "edited greeting")
                setChatRole(id, -1, "user")
                removeChat(id, 0)
                cutChat(id, 1, 3)
            `);
            const second = button(`setFullChat(id, {{role = "user", data = "A"}, {role = "char", data = "B"}})`);
            const chaId = await seedCharacter({ codes: [first] });
            expect((await runButton(chaId)).terminal?.type).toBe("done");
            const afterFirst = await readChat(chaId);
            // [inserted, edited greeting, mid, hi there, added(user)] minus index 0, kept [1, 3).
            expect(texts(afterFirst)).toEqual(["char:mid", "user:hi there"]);
            // The surviving message keeps its id; the inserted one got a fresh id, no invented time.
            expect(afterFirst.data.message[1].chatId).toBe("m2");
            expect(afterFirst.data.message[0].chatId).toMatch(/^[0-9a-f-]{36}$/);
            expect(afterFirst.data.message[0].time).toBeUndefined();

            const character = await readCharacter(chaId);
            await api("/api/resources/batch", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    ops: [
                        {
                            kind: "characters",
                            id: chaId,
                            baseRevision: character.revision,
                            data: { ...character.data, triggerscript: [luaTrigger(second)] },
                        },
                    ],
                }),
            });
            expect((await runButton(chaId)).terminal?.type).toBe("done");
            const replaced = await readChat(chaId);
            expect(texts(replaced)).toEqual(["user:A", "char:B"]);
            expect(replaced.data.message.map((m: any) => m.chatId)).not.toContain("m2");
            expect(replaced.data).toMatchObject({ name: "K", note: "note!" });
        },
        SLOW,
    );

    it(
        "grants each trigger its own stored permission (the character's, then each module's), in the client's order",
        async () => {
            const characterCode = button(`
                local r = {}
                local llm = LLMMain(id, "[]", false, ""):await()
                local sim = similarity(id, "q", {"a"}):await()
                local simple = simpleLLM(id, "p"):await()
                local lore = loadLoreBooksMain(id):await()
                local req = request(id, "https://example.com/")
                local gen = generateImage(id, "p"):await()
                local fakeInput = alertInput("not-a-key", "x")
                local tokens = getTokens(id, "x"):await()
                r.llm = type(llm)
                r.sim = type(sim)
                r.simple = type(simple)
                r.lore = type(lore)
                r.req = type(req)
                r.gen = type(gen)
                r.fakeInput = type(fakeInput)
                r.tokens = type(tokens)
                setChatVar(id, "a", "1")
                r.desc = getDescription(id)
                addChat(id, "char", "A:" .. json.encode(r))
            `);
            const moduleCode = button(`
                local r = LLM(id, {{role = "user", content = "from module"}})
                addChat(id, "char", "B:" .. tostring(r.success) .. ":" .. tostring(r.result))
            `);
            const chaId = await seedCharacter({ codes: [characterCode], lowLevelAccess: false });
            const modules = await single("modules");
            const enabled = await single("enabledModules");
            const moduleId = `mod-${chaId}`;
            const res = await api("/api/resources/batch", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    ops: [
                        {
                            kind: "modules",
                            id: "main",
                            baseRevision: modules?.revision ?? null,
                            data: [
                                ...(modules?.data ?? []),
                                {
                                    id: moduleId,
                                    name: "M",
                                    description: "",
                                    lowLevelAccess: true,
                                    trigger: [luaTrigger(moduleCode, "module")],
                                },
                            ],
                        },
                        {
                            kind: "enabledModules",
                            id: "main",
                            baseRevision: enabled?.revision ?? null,
                            data: [moduleId],
                        },
                    ],
                }),
            });
            expect(res.status).toBe(200);
            providerCalls.length = 0;
            try {
                const { events, terminal } = await runButton(chaId);
                expect(terminal?.type).toBe("done");
                // No callback and no question were asked of the tab by the refused functions.
                expect(events.filter((event) => event.type === "callback" || event.type === "question")).toEqual([]);
                const lines = texts(await readChat(chaId));
                expect(lines.slice(0, 2)).toEqual(["char:greeting", "user:hi there"]);
                expect(lines, JSON.stringify(lines)).toHaveLength(4);
                const [a, b] = lines.slice(2);
                expect(a, a).toMatch(/^char:A:\{/);
                expect(JSON.parse(a.slice("char:A:".length))).toEqual({
                    llm: "nil",
                    sim: "nil",
                    // The prelude's `__decoded` wrapper keeps a refused call's nil (not wasmoon's null userdata).
                    simple: "nil",
                    lore: "nil",
                    req: "nil",
                    gen: "nil",
                    fakeInput: "nil",
                    tokens: "number",
                    desc: "a desc",
                });
                expect(b).toBe("char:B:true:mock:from module");
                expect(providerCalls.map((call) => call.body.messages.at(-1)?.content)).toEqual(["from module"]);
                expect((await readChat(chaId)).data.scriptstate).toEqual({ $a: "1" });
            } finally {
                // The module's grant is its own: the enabled list is cleared for the later tests.
                const enabledNow = await single("enabledModules");
                await api("/api/resources/batch", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        ops: [{ kind: "enabledModules", id: "main", baseRevision: enabledNow.revision, data: [] }],
                    }),
                });
            }
        },
        SLOW,
    );
});

describe("the command runner", () => {
    it("refuses a button in a group chat with a 400 terminal", async () => {
        const chaId = await seedCharacter({ codes: [button(`addChat(id, "char", "ran")`)], type: "group" });
        const { terminal } = await runButton(chaId);
        // A command job's failure names its stage: its setup here.
        expect(terminal).toMatchObject({ type: "error", status: 400, message: /group chat/, stage: "setup" });
        expect(texts(await readChat(chaId))).toEqual(["char:greeting", "user:hi there"]);
    });

    it(
        "ends the job on a load failure, but logs a handler's own error and runs the next trigger",
        async () => {
            const broken = await seedCharacter({ codes: ["this is not lua"] });
            const { terminal } = await runButton(broken);
            expect(terminal).toMatchObject({ type: "error", message: /^Lua: /, stage: "script" });

            const throwing = await seedCharacter({
                codes: [button(`error("boom")`), button(`addChat(id, "char", "second ran")`)],
            });
            const second = await runButton(throwing);
            expect(second.terminal?.type).toBe("done");
            expect(texts(await readChat(throwing))).toEqual(["char:greeting", "user:hi there", "char:second ran"]);
        },
        SLOW,
    );

    it(
        "latches a barrier failure outside Lua: a script that catches it writes nothing more, no later trigger runs, and the job ends with that error",
        async () => {
            const code = button(`
                local ok, err = pcall(function() return generateImage(id, "p"):await() end)
                setName(id, "AFTER")
                addChat(id, "char", "after")
                alertNormal(id, "after")
            `);
            const chaId = await seedCharacter({ codes: [code, button(`addChat(id, "char", "second")`)] });
            const { events, terminal } = await runButton(chaId, {
                callback: () => ({ outcome: "failed", failure: "barrier", error: "local changes were discarded" }),
            });
            expect(terminal).toMatchObject({
                type: "error",
                message: /generateImage callback failed \(barrier\)/,
                stage: "script",
            });
            expect("requestId" in terminal!).toBe(false);
            expect(notice(events, "alertNormal")).toBeUndefined();
            expect((await readCharacter(chaId)).data.name).toBe("Lua Char");
            expect(texts(await readChat(chaId))).toEqual(["char:greeting", "user:hi there"]);
        },
        SLOW,
    );

    it(
        "builds every write from the chat as stored now: an edit made while a question waits survives a role change, and a replacement uses the current revision",
        async () => {
            const code = button(`
                local a = alertInput(id, "wait"):await()
                setChatRole(id, 0, "user")
                setChatVar(id, "v", "1")
            `);
            const chaId = await seedCharacter({ codes: [code] });
            const { terminal } = await runButton(chaId, {
                answer: async () => {
                    const current = await readChat(chaId);
                    const res = await api("/api/resources/batch", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                            chats: [
                                {
                                    characterId: chaId,
                                    chatId: "k",
                                    baseRevision: current.revision,
                                    ops: [
                                        { op: "setText", id: "m1", text: "external" },
                                        { op: "meta", set: { note: "external note" } },
                                    ],
                                },
                            ],
                        }),
                    });
                    expect(res.status).toBe(200);
                    return "go on";
                },
            });
            expect(terminal?.type).toBe("done");
            const chat = await readChat(chaId);
            expect(texts(chat)).toEqual(["user:external", "user:hi there"]);
            expect(chat.data).toMatchObject({ note: "external note", scriptstate: { $v: "1" } });

            const character = await readCharacter(chaId);
            await api("/api/resources/batch", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    ops: [
                        {
                            kind: "characters",
                            id: chaId,
                            baseRevision: character.revision,
                            data: {
                                ...character.data,
                                triggerscript: [luaTrigger(button(`setFullChat(id, {{role = "char", data = "Z"}})`))],
                            },
                        },
                    ],
                }),
            });
            expect((await runButton(chaId)).terminal?.type).toBe("done");
            const replaced = await readChat(chaId);
            expect(texts(replaced)).toEqual(["char:Z"]);
            expect(replaced.data).toMatchObject({ note: "external note", scriptstate: { $v: "1" } });
        },
        SLOW,
    );
});

describe("notices before the owner's first attach", () => {
    it(
        "delivers a notice-only job's notice before its terminal when the owner attaches after the job ended",
        async () => {
            const chaId = await seedCharacter({ codes: [button(`alertNormal(id, "only")`)] });
            const created = await createJob({
                kind: "command",
                clientId: "tab",
                context: await context(chaId),
                command: { type: "button", data: "go" },
            });
            const jobId = created.body.jobId as string;
            for (let i = 0; i < 300; i++) {
                const status = await api(`/api/generations/${jobId}?clientId=tab`);
                if (status.body?.state === "ended") {
                    break;
                }
                await sleep(100);
            }
            const { events } = await follow(jobId);
            const types = events.map((event) => `${event.type}:${event.kind ?? ""}`);
            expect(types.indexOf("notice:alertNormal")).toBeGreaterThanOrEqual(0);
            expect(types.indexOf("notice:alertNormal")).toBeLessThan(types.indexOf("done:"));
            expect(notice(events, "alertNormal")).toBe("only");
        },
        SLOW,
    );

    it(
        "keeps a notice made before a late first attach beside the question outstanding then, both before the terminal",
        async () => {
            const code = button(`
                local p = alertInput(id, "q")
                alertNormal(id, "beside the question")
                local a = p:await()
                addChat(id, "char", "a=" .. tostring(a))
            `);
            const chaId = await seedCharacter({ codes: [code] });
            const { events, terminal } = await runButton(chaId, { attachAfterMs: 1500, answer: () => "yes" });
            expect(terminal?.type).toBe("done");
            const types = events.map((event) => `${event.type}:${event.kind ?? ""}`);
            const question = types.indexOf("question:alertInput");
            const kept = types.indexOf("notice:alertNormal");
            expect(question, JSON.stringify(types)).toBeGreaterThanOrEqual(0);
            expect(kept, JSON.stringify(types)).toBeGreaterThanOrEqual(0);
            // Their relative order is not fixed: the question travels as an async host call and the
            // notice as a synchronous one, on two message ports (recorded in `self-host-server.md`).
            expect(Math.max(question, kept)).toBeLessThan(types.indexOf("done:"));
            expect(notice(events, "alertNormal")).toBe("beside the question");
            expect(texts(await readChat(chaId)).at(-1)).toBe("char:a=yes");
        },
        SLOW,
    );
});
