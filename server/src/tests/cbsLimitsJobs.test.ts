// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GenerationTerminalEvent } from "../../../shared/jobs.ts";
import { createSigner, createTestServer, json } from "./testSupport.ts";

// Phase 5 slice 9b: a reached CBS limit ends the job, whatever evaluated the text, on a real
// listening server with the default runner, the real worker pool (Lua, the regex scripts task), the
// production bindings and the job channel, against a fake provider that records every request. For
// each stage that evaluates card text (the description in assembly, a lore entry, the persona
// prompt, a native `start` trigger's effect, the `request` trigger before the provider call, a Lua
// `editRequest` listener's `cbs` inside `pcall`, an `editprocess` regex script's `parse` host call,
// a group member's description, a Lua button and a manual trigger as command jobs): one error
// terminal with `CBS limit reached … (<chat owner>)`, no provider request, no write after the
// failure (the writes before it kept: termination, not rollback), the chat left as it was or with
// the input stage's message, `inlayErrorResponse` not turning the failure into a stopped send, and
// the same chat and worker serving the next job. The evaluator's accounting is in `cbsLimits.test.ts`,
// the host and the bindings' latch in `cbsLimitsHost.test.ts`.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SLOW = 60_000;
const STUCK = "{{range::[0,1,0]}}";
const LIMIT = /^CBS limit reached: one template took more than 10000000 steps \((.+)\)$/;

const bodies: any[] = [];
const provider = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) {
        parts.push(chunk as Buffer);
    }
    const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
    bodies.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Reply." } }] }));
});

let rootDir = "";
let server: ReturnType<typeof createTestServer>;
let node: http.Server;
let base = "";
let epoch = "";
let signer: Awaited<ReturnType<typeof createSigner>>;
let presetId = "";
let modelPresetId = "";
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
async function patchSingleton(kind: string, data: (current: any) => unknown) {
    const current = await single(kind);
    const res = await batch({ ops: [{ kind, id: "main", baseRevision: current.revision, data: data(current.data) }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
}
const patchProviders = (patch: Record<string, unknown>) =>
    patchSingleton("providers", (current) => ({ ...current, ...patch }));
const patchPersonaPrompt = (prompt: string) =>
    patchSingleton("personas", (personas: any[]) =>
        personas.map((persona) => (persona.id === personaId ? { ...persona, personaPrompt: prompt } : persona)),
    );

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
const setVar = (name: string, value: string) => ({
    type: "v2SetVar",
    indent: 0,
    var: name,
    operator: "=",
    ...v(value),
});
const trig = (type: string, effect: unknown[], comment = type) => ({ comment, type, conditions: [], effect });
const luaTrigger = (code: string) => trig("manual", [{ type: "triggerlua", code }], "lua");
const lore = (content: string) => ({
    key: "",
    comment: "always",
    content,
    alwaysActive: true,
    insertorder: 100,
    mode: "normal",
    secondkey: "",
    selective: false,
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
    desc?: string;
    globalLore?: unknown[];
}) {
    const chaId = `limit-${++seeded}`;
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
                    globalLore: options.globalLore ?? [],
                    ...(options.desc !== undefined ? { desc: options.desc } : {}),
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
/** A plain client write of the message: 200 once no job holds it. */
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
/** Creates a job and follows its owner socket to the terminal. */
async function job(
    kind: string,
    chaId: string,
    extra: Record<string, unknown> = {},
    command?: Record<string, unknown>,
): Promise<{ status: number; body: any; events: any[]; terminal: GenerationTerminalEvent | undefined }> {
    const chat = await readChat(chaId);
    const created = await api("/api/generations", {
        method: "POST",
        body: JSON.stringify({
            kind,
            clientId: "tab",
            ...(command ? { command } : {}),
            context: {
                characterId: chaId,
                chatId: "k",
                presetId,
                modelPresetId,
                personaId,
                selectedPersonaId: personaId,
                mode: kind === "command" ? "button" : kind,
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
        `?risu-auth=${encodeURIComponent(await signer.jwt())}&clientId=tab&attach=${++attach}`;
    const ws = new WebSocket(url);
    const events: any[] = [];
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 45_000);
        ws.onmessage = (message) => {
            const event = JSON.parse(String(message.data));
            if (event.type === "ping") {
                return;
            }
            events.push(event);
            if (event.type === "done" || event.type === "error") {
                clearTimeout(timer);
                resolve();
            }
        };
        ws.onerror = () => resolve();
    });
    ws.close();
    return {
        ...created,
        events,
        terminal: events.find((event) => event.type === "done" || event.type === "error"),
    };
}
const terminals = (events: any[]) => events.filter((event) => event.type === "done" || event.type === "error");

/** The send fails with the limit error naming `owner`, made no provider request, and wrote nothing after. */
function expectLimitTerminal(result: { events: any[]; terminal: any }, owner: string, providerBefore: number) {
    expect(result.terminal?.type, JSON.stringify(result.terminal)).toBe("error");
    const match = LIMIT.exec(result.terminal.message);
    expect(match, result.terminal.message).not.toBeNull();
    expect(match![1]).toBe(owner);
    expect(terminals(result.events)).toHaveLength(1);
    expect(bodies.length).toBe(providerBefore);
}

beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
    const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1/chat/completions`;
    rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-cbs-limits-jobs-"));
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
    modelPresetId = (await single("modelPresets")).data[0].id;
    personaId = personas.data[0].id;
    // The model preset: a reverse proxy to the fake provider (`docs/plan/split-preset.md`).
    await patchSingleton("modelPresets", (data: any[]) => [
        {
            ...data[0],
            aiModel: "reverse_proxy",
            subModel: "reverse_proxy",
            maxContext: 4000,
            forceReplaceUrl: providerUrl,
            customProxyRequestModel: "m",
        },
        ...data.slice(1),
    ]);
    await patchSingleton("presets", (data: any[]) => [
        {
            ...data[0],
            maxResponse: 100,
            jailbreakToggle: false,
            mainPrompt: "Main {{char}}",
            formatingOrder: ["main", "description", "lorebook", "chats", "lastChat"],
            regex: [],
        },
        ...data.slice(1),
    ]);
    await patchProviders({ useStreaming: false, customTokenizer: "tik", inlayErrorResponse: false });
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

describe("a send whose card text reaches the CBS limit", () => {
    it(
        "ends with the limit error after the input stage, keeps the user message, calls no provider, and the chat serves the next send",
        async () => {
            const chaId = await seedCharacter({ name: "Ann", desc: `Desc ${STUCK}` });
            const before = bodies.length;
            const started = Date.now();
            const failed = await job("send", chaId, { input: "hi there", userMessageId: "u1" });
            expectLimitTerminal(failed, "Ann", before);
            expect(Date.now() - started).toBeLessThan(20_000);
            // The input stage's write stays (termination, not rollback); no reply was appended.
            expect(texts(await readChat(chaId))).toEqual(["user:hi there"]);
            expect(await clientSetText(chaId, "u1", "edited by the tab")).toBe(200);
            // The same chat and worker serve the next send once the card is fixed.
            const current = (await api(`/api/resources/characters/${chaId}`)).body;
            const fixed = await batch({
                ops: [
                    {
                        kind: "characters",
                        id: chaId,
                        baseRevision: current.revision,
                        data: { ...current.data, desc: "Desc of {{char}}" },
                    },
                ],
            });
            expect(fixed.status).toBe(200);
            const ok = await job("send", chaId, { input: "again", userMessageId: "u2" });
            expect(ok.terminal?.type, JSON.stringify(ok.terminal)).toBe("done");
            expect(bodies.length).toBe(before + 1);
            expect(texts(await readChat(chaId))).toEqual(["user:edited by the tab", "user:again", "char:Reply."]);
        },
        SLOW,
    );

    it(
        "is the job's error with inlayErrorResponse too: nothing is written into the chat, and preview generates nothing",
        async () => {
            const chaId = await seedCharacter({
                name: "Ann",
                desc: STUCK,
                messages: [{ role: "user", data: "q", chatId: "u1" }],
            });
            await patchProviders({ inlayErrorResponse: true });
            try {
                const before = bodies.length;
                expectLimitTerminal(await job("send", chaId), "Ann", before);
                expect(texts(await readChat(chaId))).toEqual(["user:q"]);
                expectLimitTerminal(await job("preview", chaId), "Ann", before);
                expectLimitTerminal(await job("previewPrompt", chaId), "Ann", before);
                expect(texts(await readChat(chaId))).toEqual(["user:q"]);
            } finally {
                await patchProviders({ inlayErrorResponse: false });
            }
        },
        SLOW,
    );

    it(
        "a lore entry or the persona prompt holding the template ends the send the same way",
        async () => {
            const withLore = await seedCharacter({
                name: "Lora",
                globalLore: [lore(`Always ${STUCK}`)],
                messages: [{ role: "user", data: "q", chatId: "u1" }],
            });
            const before = bodies.length;
            expectLimitTerminal(await job("send", withLore), "Lora", before);
            expect(texts(await readChat(withLore))).toEqual(["user:q"]);

            const plain = await seedCharacter({ name: "Pat", messages: [{ role: "user", data: "q", chatId: "u1" }] });
            await patchPersonaPrompt(`I am ${STUCK}`);
            try {
                expectLimitTerminal(await job("send", plain), "Pat", before);
            } finally {
                await patchPersonaPrompt("");
            }
            const ok = await job("send", plain);
            expect(ok.terminal?.type, JSON.stringify(ok.terminal)).toBe("done");
            expect(bodies.length).toBe(before + 1);
        },
        SLOW,
    );

    it(
        "a start trigger's effect ends the job, keeping the writes before it and making none after",
        async () => {
            const chaId = await seedCharacter({
                name: "Trig",
                triggerscript: [trig("start", [setVar("first", "1"), setVar("stuck", STUCK), setVar("late", "1")])],
                messages: [{ role: "user", data: "q", chatId: "u1" }],
            });
            const before = bodies.length;
            expectLimitTerminal(await job("send", chaId), "Trig", before);
            const chat = await readChat(chaId);
            expect(chat.data.scriptstate).toEqual({ $first: "1" });
            expect(texts(chat)).toEqual(["user:q"]);
        },
        SLOW,
    );

    it(
        "the request trigger's effect ends the job before any provider attempt, with inlayErrorResponse either way",
        async () => {
            const chaId = await seedCharacter({
                name: "Req",
                triggerscript: [trig("request", [setVar("stuck", STUCK)])],
                messages: [{ role: "user", data: "q", chatId: "u1" }],
            });
            const before = bodies.length;
            expectLimitTerminal(await job("send", chaId), "Req", before);
            await patchProviders({ inlayErrorResponse: true });
            try {
                expectLimitTerminal(await job("send", chaId), "Req", before);
            } finally {
                await patchProviders({ inlayErrorResponse: false });
            }
            const chat = await readChat(chaId);
            expect(texts(chat)).toEqual(["user:q"]);
            expect(chat.data.scriptstate ?? {}).toEqual({});
        },
        SLOW,
    );

    it(
        "a Lua editRequest listener's cbs inside pcall ends the job, and the write after the pcall never lands",
        async () => {
            const chaId = await seedCharacter({
                name: "Lua",
                triggerscript: [
                    luaTrigger(
                        `listenEdit('editRequest', function(id, data)
                            local ok, err = pcall(function() return cbs(${JSON.stringify(STUCK)}) end)
                            setChatVar(id, "late", "1")
                            return data
                        end)`,
                    ),
                ],
                messages: [{ role: "user", data: "q", chatId: "u1" }],
            });
            const before = bodies.length;
            expectLimitTerminal(await job("send", chaId), "Lua", before);
            const chat = await readChat(chaId);
            expect(chat.data.scriptstate ?? {}).toEqual({});
            expect(texts(chat)).toEqual(["user:q"]);
        },
        SLOW,
    );

    it(
        "an editprocess regex script whose replacement holds the template ends the job through the worker's parse host call",
        async () => {
            const chaId = await seedCharacter({
                name: "Rex",
                customscript: [
                    { comment: "stuck", in: "q", out: STUCK, type: "editprocess", flag: "g", ableFlag: true },
                ],
                messages: [{ role: "user", data: "q", chatId: "u1" }],
            });
            const before = bodies.length;
            expectLimitTerminal(await job("send", chaId), "Rex", before);
            expect(texts(await readChat(chaId))).toEqual(["user:q"]);
            // The worker is reusable: a send of a character without the script answers.
            const plain = await seedCharacter({ name: "Pat", messages: [{ role: "user", data: "q", chatId: "u1" }] });
            const ok = await job("send", plain);
            expect(ok.terminal?.type, JSON.stringify(ok.terminal)).toBe("done");
            expect(bodies.length).toBe(before + 1);
        },
        SLOW,
    );

    it(
        "a group send names the group (the chat owner) and ends with one terminal when a member's card reaches the limit",
        async () => {
            const bob = await seedCharacter({ name: "Bob" });
            const cid = await seedCharacter({ name: "Cid", desc: STUCK });
            const grp = await seedCharacter({
                name: "Grp",
                type: "group",
                members: [bob, cid],
                messages: [{ role: "user", data: "hello all", chatId: "u0" }],
            });
            const before = bodies.length;
            const result = await job("group", grp);
            expect(result.terminal?.type, JSON.stringify(result.terminal)).toBe("error");
            const message = (result.terminal as { message: string }).message;
            expect(message).toMatch(LIMIT);
            expect(LIMIT.exec(message)![1]).toBe("Grp");
            expect(terminals(result.events)).toHaveLength(1);
            // Bob's reply was requested and stored; Cid's card ended the job before its request.
            expect(bodies.length).toBe(before + 1);
            const chat = await readChat(grp);
            expect(texts(chat)).toEqual(["user:hello all", "char:Reply."]);
            expect(chat.data.message[1].saying).toBe(bob);
            expect(await clientSetText(grp, chat.data.message[1].chatId, "tab edit")).toBe(200);
        },
        SLOW,
    );
});

describe("a command job whose text reaches the CBS limit", () => {
    it(
        "a Lua button's cbs inside pcall ends the job with the limit error, writes nothing after, and the next button runs",
        async () => {
            const chaId = await seedCharacter({
                name: "Btn",
                triggerscript: [
                    luaTrigger(
                        `onButtonClick = async(function(id, data)
                            local ok, err = pcall(function() return cbs(${JSON.stringify(STUCK)}) end)
                            setChatVar(id, "late", "1")
                            addChat(id, "char", "after")
                        end)`,
                    ),
                ],
                messages: [{ role: "user", data: "q", chatId: "u1" }],
            });
            const before = bodies.length;
            const failed = await job("command", chaId, {}, { type: "button", data: "go" });
            expectLimitTerminal(failed, "Btn", before);
            const chat = await readChat(chaId);
            expect(chat.data.scriptstate ?? {}).toEqual({});
            expect(texts(chat)).toEqual(["user:q"]);

            const fine = await seedCharacter({
                name: "Btn2",
                triggerscript: [luaTrigger(`onButtonClick = async(function(id, data) setChatVar(id, "ran", "1") end)`)],
            });
            const ok = await job("command", fine, {}, { type: "button", data: "go" });
            expect(ok.terminal?.type, JSON.stringify(ok.terminal)).toBe("done");
            expect((await readChat(fine)).data.scriptstate).toEqual({ $ran: "1" });
        },
        SLOW,
    );

    it(
        "a manual trigger's effect ends the job with the limit error and applies nothing of its copy",
        async () => {
            const chaId = await seedCharacter({
                name: "Man",
                triggerscript: [
                    trig(
                        "manual",
                        [
                            setVar("first", "1"),
                            { type: "v2Impersonate", indent: 0, role: "char", ...v("spoken") },
                            setVar("stuck", STUCK),
                            setVar("late", "1"),
                        ],
                        "go",
                    ),
                ],
                messages: [{ role: "user", data: "q", chatId: "u1" }],
            });
            const before = bodies.length;
            const failed = await job("command", chaId, {}, { type: "manual", name: "go" });
            expectLimitTerminal(failed, "Man", before);
            const chat = await readChat(chaId);
            // The variable writes are immediate (kept up to the failure); the message of the copy is not applied.
            expect(chat.data.scriptstate).toEqual({ $first: "1" });
            expect(texts(chat)).toEqual(["user:q"]);
        },
        SLOW,
    );
});
