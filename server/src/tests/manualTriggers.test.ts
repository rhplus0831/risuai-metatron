// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GenerationTerminalEvent } from "../../../shared/jobs.ts";
import { allowListenerOrigin, createSigner, createTestServer, json } from "./testSupport.ts";

// A manual trigger as a server `command` job end to end on a real listening server with the default
// runner (`server/src/jobs/commandRunner.ts` `runManualTrigger`), the trigger runtime, the command
// executor, the final applier, the real worker pool (regex tasks and `triggerlua`), the production
// bindings in working-copy mode, and the job channel over the owner socket. The route's manual
// command and `triggerId` validation; the group refusal; a trigger's variables, control flow, chat
// edits, notices, and the stored result (CBS reading the immediate writes and `{{trigger_id}}`);
// questions answered in order and one not answered ending the job with the immediate writes kept;
// `v2Command` with a nested `/trigger`; the six regex sites through the worker and an invalid
// pattern ending the job; an abort during `v2Wait` applying nothing; the persona write to the
// effective persona beside the frozen getter; Lua on the working copy with a native getter reading
// its `setDescription`; a Lua load failure versus a handler error; and the effect limit ending the
// job. The runtime's effect switch is pinned in `triggerRuntime.test.ts`, the applier in
// `chatResult.test.ts`, the executor in `commandExecutor.test.ts`.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SLOW = 60_000;

let rootDir = "";
let server: ReturnType<typeof createTestServer>;
let node: http.Server;
let base = "";
let epoch = "";
let signer: Awaited<ReturnType<typeof createSigner>>;
let presetId = "";
let modelPresetId = "";
let defaultPersonaId = "";
let defaultPersonaPrompt = "";

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

beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-manual-triggers-"));
    mkdirSync(path.join(rootDir, "dist"));
    writeFileSync(path.join(rootDir, "dist", "index.html"), "<!doctype html><html><head></head><body></body></html>");
    symlinkSync(path.join(REPO_ROOT, "public"), path.join(rootDir, "public"), "dir");
    cpSync(path.join(REPO_ROOT, "version.json"), path.join(rootDir, "version.json"));
    mkdirSync(path.join(rootDir, "save", "server"), { recursive: true });
    writeFileSync(path.join(rootDir, "save", "server", "password"), "pw");
    server = createTestServer({ rootDir });
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
    const personas = await single("personas");
    presetId = presets.data[0].id;
    modelPresetId = (await single("modelPresets")).data[0].id;
    defaultPersonaId = personas.data[0].id;
    defaultPersonaPrompt = personas.data[0].personaPrompt ?? "";
    const seeded = await api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                {
                    kind: "personas",
                    id: "main",
                    baseRevision: personas.revision,
                    data: [...personas.data, { id: "bound", name: "Bound", personaPrompt: "bound prompt" }],
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
    rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

const v = (value: string) => ({ value, valueType: "value" });
const ef = (type: string, fields: Record<string, unknown> = {}, indent = 0) => ({ type, indent, ...fields });
const setVar = (name: string, operator: string, value: string, indent = 0) =>
    ef("v2SetVar", { var: name, operator, ...v(value) }, indent);
const say = (role: "user" | "char", value: string, indent = 0) => ef("v2Impersonate", { role, ...v(value) }, indent);
const trig = (comment: string, effect: unknown[], extra: Record<string, unknown> = {}) => ({
    comment,
    type: "manual",
    conditions: [],
    effect,
    ...extra,
});

let seeded = 0;
/** A character with triggers and its chat `k` (`[char greeting, user second]`). */
async function seedCharacter(options: {
    triggers: unknown[];
    type?: "character" | "group";
    lowLevelAccess?: boolean;
    bindPersona?: boolean;
}) {
    const chaId = `trig-${++seeded}`;
    const res = await api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                {
                    kind: "characters",
                    id: chaId,
                    baseRevision: null,
                    data: {
                        chaId,
                        name: "Trig",
                        type: options.type ?? "character",
                        firstMessage: "hello",
                        desc: "",
                        lowLevelAccess: options.lowLevelAccess ?? true,
                        defaultVariables: "dv=7",
                        globalLore: [
                            {
                                key: "k1",
                                comment: "l1",
                                content: "lore1",
                                mode: "normal",
                                insertorder: 100,
                                alwaysActive: false,
                                secondkey: "",
                                selective: false,
                            },
                        ],
                        triggerscript: options.triggers,
                        ...(options.type === "group" ? { characters: [] } : {}),
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
                                // The binding the jobs send: a job runs on its chat's binding.
                                modelPresetId,
                                promptPresetId: presetId,
                                bindedPersona: options.bindPersona ? "bound" : defaultPersonaId,
                                message: [
                                    { role: "char", data: "greeting", chatId: "m1" },
                                    { role: "user", data: "second", chatId: "m2" },
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
            body: JSON.stringify({ chats: [{ characterId: chaId, id: "k" }] }),
        })
    ).body.chats[0] as { revision: string; data: any };
const readCharacter = async (chaId: string) => (await api(`/api/resources/characters/${chaId}`)).body;
const texts = (chat: { data: any }) => chat.data.message.map((m: any) => `${m.role}:${m.data}`);

const context = async (chaId: string, extra: Record<string, unknown> = {}) => ({
    characterId: chaId,
    chatId: "k",
    presetId,
    modelPresetId,
    personaId: defaultPersonaId,
    selectedPersonaId: defaultPersonaId,
    mode: "manual",
    input: "",
    chatRevision: (await readChat(chaId)).revision,
    ...extra,
});
const createJob = (body: Record<string, unknown>) =>
    api("/api/generations", { method: "POST", body: JSON.stringify(body) });

type Answerer = (event: any) => unknown | Promise<unknown>;
let attach = 0;
/** The owner socket of `jobId`: collects its events until the terminal, answering questions with `answer(event)`. */
async function follow(
    jobId: string,
    options: { answer?: Answerer; onAccepted?: () => void; notAnswered?: boolean } = {},
): Promise<{ events: any[]; terminal: GenerationTerminalEvent | undefined }> {
    const events: any[] = [];
    const url =
        `${base.replace("http", "ws")}/api/generations/${jobId}/ws` +
        `?risu-auth=${encodeURIComponent(await signer.jwt())}&clientId=tab&attach=${++attach}`;
    const ws = new WebSocket(url);
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 45_000);
        ws.onmessage = async (message) => {
            const event = JSON.parse(String(message.data));
            if (event.type === "ping") {
                return;
            }
            events.push(event);
            if (event.type === "accepted") {
                options.onAccepted?.();
            }
            if (event.type === "question") {
                if (options.notAnswered) {
                    ws.send(JSON.stringify({ type: "answer", id: event.id, outcome: "cancelled" }));
                } else {
                    const value = await options.answer?.(event);
                    if (value !== undefined) {
                        ws.send(JSON.stringify({ type: "answer", id: event.id, outcome: "answered", value }));
                    }
                }
            }
            if (event.type === "done" || event.type === "error") {
                clearTimeout(timer);
                resolve();
            }
        };
    });
    ws.close();
    return { events, terminal: events.find((event) => event.type === "done" || event.type === "error") };
}

async function runManual(
    chaId: string,
    name: string,
    options: {
        triggerId?: string;
        bound?: boolean;
        answer?: Answerer;
        onAccepted?: () => void;
        notAnswered?: boolean;
    } = {},
) {
    const created = await createJob({
        kind: "command",
        clientId: "tab",
        context: await context(chaId, {
            ...(options.triggerId ? { triggerId: options.triggerId } : {}),
            ...(options.bound ? { personaId: "bound" } : {}),
        }),
        command: { type: "manual", name },
    });
    expect(created.status).toBe(200);
    const jobId = created.body.jobId as string;
    return { jobId, ...(await follow(jobId, options)) };
}
const notices = (events: any[], kind: string) =>
    events.filter((event) => event.type === "notice" && event.kind === kind);

describe("the route", () => {
    it("accepts a manual command with a free-text trigger id, and refuses a bad shape, an over-long name, or an empty or over-long trigger id", async () => {
        const chaId = await seedCharacter({ triggers: [trig("go", [say("char", "id={{trigger_id}}")])] });
        for (const [body, message] of [
            [{ command: { type: "manual" } }, /button.*manual/],
            [{ command: { type: "manual", name: "x".repeat(5000) } }, /command\.name.*4096/],
            [{ command: { type: "manual", name: "go" }, context: { triggerId: "" } }, /triggerId.*nonempty/],
            [{ command: { type: "manual", name: "go" }, context: { triggerId: "y".repeat(5000) } }, /triggerId.*4096/],
        ] as [Record<string, any>, RegExp][]) {
            const res = await createJob({
                kind: "command",
                clientId: "tab",
                ...body,
                context: await context(chaId, body.context ?? {}),
            });
            expect(res.status, JSON.stringify(body)).toBe(400);
            expect(res.body.error).toMatch(message);
        }
        const { terminal } = await runManual(chaId, "go", { triggerId: "btn one! (not an id)" });
        expect(terminal?.type).toBe("done");
        expect(texts(await readChat(chaId)).at(-1)).toBe("char:id=btn one! (not an id)");
    });

    it("refuses a manual trigger in a group chat with a 400 terminal", async () => {
        const chaId = await seedCharacter({ triggers: [trig("go", [say("char", "ran")])], type: "group" });
        const { terminal } = await runManual(chaId, "go");
        expect(terminal).toMatchObject({
            type: "error",
            status: 400,
            message: /Manual triggers do not run in a group chat/,
        });
        expect(texts(await readChat(chaId))).toEqual(["char:greeting", "user:second"]);
    });
});

describe("a manual trigger job", () => {
    it(
        "runs variables, control flow, and chat edits on a copy, writes the variables and note as it goes (CBS reads them), applies the copy, and notifies once",
        async () => {
            const chaId = await seedCharacter({
                triggers: [
                    trig("basic", [
                        setVar("x", "=", "5"),
                        setVar("x", "+=", "2"),
                        ef("v2If", { condition: "=", targetType: "value", target: "7", source: "x" }),
                        say("char", "x is {{getvar::x}}", 1),
                        ef("v2EndIndent", {}, 1),
                        ef("v2LoopNTimes", v("3")),
                        setVar("n", "+=", "1", 1),
                        ef("v2EndIndent", { endOfLoop: true }, 1),
                        ef("v2ModifyChat", { index: "0", indexType: "value", ...v("modified") }),
                        ef("v2ShowAlert", v("done {{getvar::n}} dv={{getvar::dv}}")),
                        ef("v2SetAuthorNote", v("note!")),
                        ef("v2CreateLorebook", {
                            name: "L2",
                            nameType: "value",
                            key: "k2",
                            keyType: "value",
                            content: "lore2",
                            contentType: "value",
                            insertOrder: "5",
                            insertOrderType: "value",
                        }),
                        ef("v2SetCharacterDesc", v("desc1")),
                        ef("v2GetCharacterDesc", { outputVar: "d" }),
                        say("user", "desc={{getvar::d}} trig={{trigger_id}}"),
                        ef("v2UpdateChatAt", { index: 0 }),
                    ]),
                    trig("other", [say("char", "not this one")]),
                ],
            });
            const { events, terminal } = await runManual(chaId, "basic", { triggerId: "tid-1" });
            expect(terminal?.type).toBe("done");
            const chat = await readChat(chaId);
            expect(texts(chat)).toEqual(["char:modified", "user:second", "char:x is 7", "user:desc=desc1 trig=tid-1"]);
            expect(chat.data).toMatchObject({ note: "note!", scriptstate: { $x: "7", $n: "3", $d: "desc1" } });
            expect(notices(events, "alertNormal").map((event) => event.payload.message)).toEqual(["done 3 dv=7"]);
            expect(notices(events, "updateGUI")).toHaveLength(1);
            expect(notices(events, "reloadChat").map((event) => event.payload)).toEqual([
                { chaId, chatId: "k", messageId: "m1" },
            ]);
            const character = (await readCharacter(chaId)).data;
            expect(character.desc).toBe("desc1");
            expect(character.globalLore.map((lore: any) => lore.comment)).toEqual(["l1", "L2"]);
            expect(character.triggerscript).toHaveLength(2);
            // The done terminal names the chat's revision after the final write.
            expect(terminal).toMatchObject({ revision: chat.revision });
        },
        SLOW,
    );

    it(
        "asks its questions in order through the channel, and a question not answered ends the job with an error, the earlier immediate writes kept",
        async () => {
            const chaId = await seedCharacter({
                triggers: [
                    trig("ask", [
                        setVar("before", "=", "1"),
                        ef("v2GetAlertInput", { display: "Name?", displayType: "value", outputVar: "name" }),
                        ef("v2GetAlertSelect", {
                            display: "Pick",
                            displayType: "value",
                            ...v("a|b"),
                            outputVar: "sel",
                        }),
                        say("char", "hi {{getvar::name}} {{getvar::sel}}"),
                    ]),
                ],
            });
            const answered = await runManual(chaId, "ask", {
                answer: (event) => (event.kind === "alertInput" ? "Ada" : "b"),
            });
            expect(answered.terminal?.type).toBe("done");
            expect(
                answered.events
                    .filter((event) => event.type === "question")
                    .map((event) => [event.kind, event.payload]),
            ).toEqual([
                ["alertInput", { message: "Name?" }],
                ["alertSelect", { options: ["a", "b"], display: "Pick" }],
            ]);
            expect(texts(await readChat(chaId)).at(-1)).toBe("char:hi Ada b");

            const unanswered = await runManual(chaId, "ask", { notAnswered: true });
            expect(unanswered.terminal).toMatchObject({
                type: "error",
                message: /Trigger: .*alertInput question ended: cancelled/,
                // A command job's trigger failure is the script's.
                stage: "script",
            });
            const chat = await readChat(chaId);
            expect(texts(chat)).toHaveLength(3);
            expect(chat.data.scriptstate.$before).toBe("1");
        },
        SLOW,
    );

    it(
        "runs v2Command through the executor on the job's chat, including a nested `/trigger`",
        async () => {
            const chaId = await seedCharacter({
                triggers: [
                    trig("cmd", [
                        ef(
                            "v2Command",
                            v("/send hello|/sendas world|/setvar key=cv 9|/trigger nested|/echo {{getvar::cv}}"),
                        ),
                        say("char", "outer done"),
                    ]),
                    trig("nested", [say("char", "from nested")]),
                ],
            });
            const { events, terminal } = await runManual(chaId, "cmd");
            expect(terminal?.type).toBe("done");
            const chat = await readChat(chaId);
            // The commands write the stored chat as they run; the outer trigger's own message is
            // anchored after its predecessor in the trigger's copy (m2), so it lands before them, as
            // the tab's `applyChatResult` places it.
            expect(texts(chat)).toEqual([
                "char:greeting",
                "user:second",
                "char:outer done",
                "user:hello",
                "char:world",
                "char:from nested",
            ]);
            expect(chat.data.scriptstate.$cv).toBe("9");
            expect(notices(events, "alertNormal").map((event) => event.payload.message)).toEqual(["null"]); // The trigger's CBS pass resolved `{{getvar::cv}}` before the commands ran, as in the tab.
        },
        SLOW,
    );

    it(
        "runs the six regex sites in the worker; an invalid pattern the tab would throw on ends the job with a trigger error",
        async () => {
            const chaId = await seedCharacter({
                triggers: [
                    trig("regex", [
                        ef("v2ExtractRegex", {
                            ...v("abc123"),
                            regex: "([a-z]+)(\\d+)",
                            regexType: "value",
                            flags: "",
                            flagsType: "value",
                            result: "$2-$1",
                            resultType: "value",
                            outputVar: "ex",
                        }),
                        ef("v2ReplaceString", {
                            source: "a1b2",
                            sourceType: "value",
                            regex: "(\\d)",
                            regexType: "value",
                            result: "[$1]",
                            resultType: "value",
                            replacement: "",
                            replacementType: "value",
                            flags: "g",
                            flagsType: "value",
                            outputVar: "rp",
                        }),
                        ef("v2RegexTest", {
                            ...v("x"),
                            regex: "(",
                            regexType: "value",
                            flags: "",
                            flagsType: "value",
                            outputVar: "rt",
                        }),
                        ef("v2SplitString", {
                            source: "a, b,c",
                            sourceType: "value",
                            delimiter: "/,\\s*/",
                            delimiterType: "regex",
                            outputVar: "sp",
                        }),
                        ef("v2GetLorebookByName", { name: "^l", nameType: "value", outputVar: "lb" }),
                        ef("v2QuickSearchChat", {
                            ...v("^greeting"),
                            depth: "2",
                            depthType: "value",
                            condition: "regex",
                            outputVar: "qs",
                        }),
                        say(
                            "char",
                            "ex={{getvar::ex}} rp={{getvar::rp}} rt={{getvar::rt}} sp={{getvar::sp}} lb={{getvar::lb}} qs={{getvar::qs}}",
                        ),
                    ]),
                    trig("bad", [
                        setVar("kept", "=", "1"),
                        ef("v2ExtractRegex", {
                            ...v("x"),
                            regex: "(",
                            regexType: "value",
                            flags: "",
                            flagsType: "value",
                            result: "",
                            resultType: "value",
                            outputVar: "o",
                        }),
                        say("char", "never"),
                    ]),
                ],
            });
            expect((await runManual(chaId, "regex")).terminal?.type).toBe("done");
            expect(texts(await readChat(chaId)).at(-1)).toBe(
                'char:ex=123-abc rp=a[1]b[2] rt=0 sp=["a","b","c"] lb=[0] qs=1',
            );
            const bad = await runManual(chaId, "bad");
            expect(bad.terminal).toMatchObject({
                type: "error",
                status: 500,
                message: /^Trigger: .*Invalid regular expression/,
            });
            const chat = await readChat(chaId);
            expect(texts(chat)).not.toContain("char:never");
            expect(chat.data.scriptstate.$kept).toBe("1");
        },
        SLOW,
    );

    it(
        "ends at once with `aborted` when the job is cancelled during v2Wait, applying nothing",
        async () => {
            const chaId = await seedCharacter({
                triggers: [trig("wait", [ef("v2Wait", v("30")), say("char", "never")])],
            });
            const started = Date.now();
            let jobId = "";
            const created = await createJob({
                kind: "command",
                clientId: "tab",
                context: await context(chaId),
                command: { type: "manual", name: "wait" },
            });
            jobId = created.body.jobId;
            const { terminal } = await follow(jobId, {
                onAccepted: () => {
                    setTimeout(() => void api(`/api/generations/${jobId}?clientId=tab`, { method: "DELETE" }), 300);
                },
            });
            expect(terminal).toMatchObject({ type: "error", reason: "aborted" });
            expect(Date.now() - started).toBeLessThan(15_000);
            expect(texts(await readChat(chaId))).toEqual(["char:greeting", "user:second"]);
        },
        SLOW,
    );

    it(
        "writes the persona description to the job's (bound) persona while the getter reads that persona's prompt as frozen at the job's start",
        async () => {
            const chaId = await seedCharacter({
                triggers: [
                    trig("persona", [
                        ef("v2SetPersonaDesc", v("pp")),
                        ef("v2GetPersonaDesc", { outputVar: "pd" }),
                        say("char", "pd=[{{getvar::pd}}]"),
                    ]),
                ],
                bindPersona: true,
            });
            const { terminal } = await runManual(chaId, "persona", { bound: true });
            expect(terminal?.type).toBe("done");
            const personas = (await single("personas")).data;
            expect(personas.find((persona: any) => persona.id === "bound").personaPrompt).toBe("pp");
            expect(personas.find((persona: any) => persona.id === defaultPersonaId).personaPrompt ?? "").toBe(
                defaultPersonaPrompt,
            );
            // The job has one persona, the chat's bound one: the forwarded `personaPrompt` the getter
            // reads is its prompt as loaded, not the tab's selected persona's.
            expect(texts(await readChat(chaId)).at(-1)).toBe("char:pd=[bound prompt]");
        },
        SLOW,
    );

    it(
        "runs triggerlua on the working copy: Lua's chat edits, variables, and local lore land with the copy, and a native getter reads its setDescription",
        async () => {
            const code = `
                function luaT(id)
                    setDescription(id, "lua desc")
                    addChat(id, "char", "lua added " .. getChatVar(id, "dv"))
                    setChatVar(id, "lv", "1")
                    setChat(id, 0, "lua edited first")
                    upsertLocalLoreBook(id, "LL", "local content", {})
                end
            `;
            const chaId = await seedCharacter({
                triggers: [
                    trig("luaT", [
                        { type: "triggerlua", code },
                        ef("v2GetCharacterDesc", { outputVar: "d" }),
                        say("user", "after lua: {{getvar::d}} lv={{getvar::lv}}"),
                    ]),
                ],
            });
            const { terminal } = await runManual(chaId, "luaT");
            expect(terminal?.type).toBe("done");
            const chat = await readChat(chaId);
            expect(texts(chat)).toEqual([
                "char:lua edited first",
                "user:second",
                "char:lua added 7",
                "user:after lua: lua desc lv=1",
            ]);
            expect(chat.data.localLore.map((lore: any) => lore.comment)).toEqual(["LL"]);
            expect(chat.data.scriptstate).toMatchObject({ $lv: "1", $d: "lua desc" });
            expect((await readCharacter(chaId)).data.desc).toBe("lua desc");
        },
        SLOW,
    );

    it(
        "ends the job on a Lua load failure, but logs a handler's own error and runs the trigger's next effect",
        async () => {
            const broken = await seedCharacter({
                triggers: [trig("x", [{ type: "triggerlua", code: "this is not lua" }])],
            });
            expect((await runManual(broken, "x")).terminal).toMatchObject({ type: "error", message: /^Lua: / });
            const throwing = await seedCharacter({
                triggers: [
                    trig("x", [
                        { type: "triggerlua", code: `function x(id) error("boom") end` },
                        say("char", "after the error"),
                    ]),
                ],
            });
            expect((await runManual(throwing, "x")).terminal?.type).toBe("done");
            expect(texts(await readChat(throwing)).at(-1)).toBe("char:after the error");
        },
        SLOW,
    );

    it(
        "ends the job with an error past the effect limit (the tab would loop forever)",
        { tags: ["slow"], timeout: SLOW },
        async () => {
            const chaId = await seedCharacter({
                triggers: [
                    trig("cap", [
                        ef("v2Loop"),
                        setVar("spin", "+=", "1", 1),
                        ef("v2EndIndent", { endOfLoop: true }, 1),
                    ]),
                ],
            });
            const { terminal } = await runManual(chaId, "cap");
            expect(terminal).toMatchObject({
                type: "error",
                status: 500,
                message: /^Trigger: more than 100000 trigger effects/,
                stage: "script",
            });
        },
    );
});

describe("`/multisend` in a command job", () => {
    // An unquoted `|` splits the command line, so the separators of the `clear` form come out of
    // the executor's CBS of the argument (`{{u::7c}}` is `|`), as `commandExecutor.test.ts` does;
    // the trigger evaluates its value's CBS first, so the braces are escaped once more for it. The
    // quoted form keeps its quotes in the parts, as the tab's own `/multisend` does.
    const sep = "{{u::7b}}{{u::7b}}u::7c}}".repeat(3);
    it(
        "queues the parts for the tab (`done.followUps`: the clear mode, in order) instead of sending, and refuses too many parts with an alertError and no follow-ups",
        async () => {
            const chaId = await seedCharacter({
                triggers: [
                    trig("ms", [
                        ef("v2Command", v('/multisend "one|||two"')),
                        ef("v2Command", v(`/multisend clear ${sep} three`)),
                        say("char", "after"),
                    ]),
                    trig("many", [
                        ef("v2Command", v(`/multisend ${Array.from({ length: 65 }, (_, i) => `p${i}`).join(sep)}`)),
                        say("char", "still ran"),
                    ]),
                ],
            });
            const { events, terminal } = await runManual(chaId, "ms");
            expect(terminal).toMatchObject({
                type: "done",
                followUps: [
                    { clear: false, parts: ['"one', 'two"'] },
                    { clear: true, parts: [" three"] },
                ],
            });
            // Nothing was sent inside the job: the trigger's own effects landed, no user message.
            expect(texts(await readChat(chaId))).toEqual(["char:greeting", "user:second", "char:after"]);
            expect(notices(events, "alertError")).toEqual([]);
            const many = await runManual(chaId, "many");
            expect(many.terminal?.type).toBe("done");
            expect((many.terminal as { followUps?: unknown }).followUps).toBeUndefined();
            expect(notices(many.events, "alertError").map((event) => event.payload.message)).toEqual([
                expect.stringMatching(/multisend/),
            ]);
            expect(texts(await readChat(chaId)).at(-1)).toBe("char:still ran");
        },
        SLOW,
    );
});
