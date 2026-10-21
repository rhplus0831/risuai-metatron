// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { allowListenerOrigin, createSigner, createTestServer, json } from "./testSupport.ts";

// The script transform (`POST /api/transform`, `POST /api/transform/continue`;
// `server/src/routes/transform.ts`, `server/src/prompt/transform.ts`) end to end in process, with the
// production bindings in frozen mode, the real worker pool (Lua and the regex scripts), and a fake
// embedding server. Pinned: `editdisplay` in the client's order (Lua `editDisplay` with `meta.index`,
// the `display` trigger on the chat's owner (a group's modules included), CBS, the regex scripts, the
// dynamic assets) and `editprocess` (CBS and the regex only); `@@emo` returned as the target's
// emotions (kept by a cached result), `@@inject` discarded; nothing stored (the chat's variables and
// messages unchanged); each target's own variables, regex cache, and emotions; a Lua variable kept
// across the image getter's refused callback; the cache key's dependencies (the chat's variables,
// author's note, local lore, the source character, the language) and its deliberate staleness (the
// viewport, the other messages); the two-call protocol (the snapshot's variables, not the store's;
// the exact pending set checked before the snapshot is used; one winner; the text limits of the first
// call's pending texts and of the snapshot); a maintenance ending a snapshot and refusing renders;
// the admission order (authentication before the body is read, the 8 MiB cap, the epoch, a missing
// record); an aborted request computing nothing; the embedding key used by the server and never
// answered. The lifetime rules with held workers are `transformService.test.ts`.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SLOW = 60_000;
const EMBED_KEY = "sk-embed-sentinel-13a";

/** The embedding server: every text `[1, 0, 0]` (one asset, so it is always the best match). */
const embedRequests: { auth: string | undefined; input: string[] }[] = [];
const embedder = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) {
        parts.push(chunk as Buffer);
    }
    const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
    const input: string[] = Array.isArray(body.input) ? body.input : [body.input];
    embedRequests.push({ auth: req.headers.authorization, input });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: input.map(() => ({ embedding: [1, 0, 0] })) }));
});

let rootDir = "";
let server: ReturnType<typeof createTestServer>;
let signer: Awaited<ReturnType<typeof createSigner>>;
let epoch = "";
let presetId = "";
let modelPresetId = "";
let personaId = "";

async function api(url: string, body?: unknown, init: RequestInit = {}) {
    const res = await server.app.request(url, {
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        ...init,
        headers: {
            "risu-auth": await signer.jwt(),
            "x-resource-epoch": epoch,
            "content-type": "application/json",
            ...((init.headers as Record<string, string>) ?? {}),
        },
    });
    let parsed: any = null;
    try {
        parsed = await res.json();
    } catch {}
    return { status: res.status, body: parsed, headers: res.headers };
}
const single = async (kind: string) => (await api(`/api/resources/${kind}/main`)).body;
const batch = async (body: unknown) => {
    const res = await api("/api/resources/batch", body);
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
    return res.body;
};
const readChat = async (characterId: string, chatId: string) =>
    (await api("/api/resources/read", { chats: [{ characterId, id: chatId }] })).body.chats[0];
const patchChat = async (characterId: string, chatId: string, set: Record<string, unknown>) => {
    const chat = await readChat(characterId, chatId);
    await batch({ chats: [{ characterId, chatId, baseRevision: chat.revision, ops: [{ op: "meta", set }] }] });
};
async function patchSection(section: string, patch: Record<string, unknown>) {
    const current = await single(section);
    await batch({
        ops: [{ kind: section, id: "main", baseRevision: current.revision, data: { ...current.data, ...patch } }],
    });
}

const lua = (code: string) => ({
    comment: "lua",
    type: "start",
    conditions: [],
    effect: [{ type: "triggerlua", code }],
});
const rx = (input: string, out: string, type = "editdisplay") => ({ comment: "", in: input, out, type, flag: "g" });
const ef = (type: string, fields: Record<string, unknown> = {}) => ({ type, indent: 0, ...fields });
/** A display trigger that appends `suffix` to the display text (and sets a trigger variable `tv`). */
const displayTrigger = (suffix: string) => ({
    comment: "display",
    type: "display",
    conditions: [],
    effect: [
        ef("v2GetDisplayState", { outputVar: "d" }),
        ef("v2SetVar", { var: "tv", operator: "=", value: "9", valueType: "value" }),
        ef("v2ConcatString", {
            source1: "d",
            source1Type: "var",
            source2: suffix,
            source2Type: "value",
            outputVar: "out",
        }),
        ef("v2SetDisplayState", { value: "out", valueType: "var" }),
    ],
});

const character = (chaId: string, fields: Record<string, unknown> = {}) => ({
    kind: "characters",
    id: chaId,
    baseRevision: null,
    data: {
        chaId,
        name: chaId.toUpperCase(),
        type: "character",
        firstMessage: "hi",
        desc: "",
        globalLore: [],
        emotionImages: [["happy", `img-happy-${chaId}`]],
        customscript: [],
        triggerscript: [],
        ...fields,
    },
});
const chatCreate = (characterId: string, chatId: string, chat: Record<string, unknown> = {}) => ({
    characterId,
    chatId,
    baseRevision: null,
    ops: [
        {
            op: "create",
            chat: {
                id: chatId,
                name: chatId,
                message: [
                    { role: "char", data: "first", chatId: "m1" },
                    { role: "user", data: "second", chatId: "m2" },
                ],
                ...chat,
            },
        },
    ],
});

const context = (characterId: string, chatId: string) => ({
    characterId,
    chatId,
    presetId,
    modelPresetId,
    personaId,
    selectedPersonaId: personaId,
});
const client = (width = 800, browserLanguage = "en") => ({ viewport: { width, height: 600 }, browserLanguage });
const target = (id: string, sourceId: string, source: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind: "message",
    sourceId,
    chatIndex: 1,
    messageId: "m2",
    source,
    ...extra,
});
const render = (
    characterId: string,
    chatId: string,
    targets: unknown[],
    extra: Record<string, unknown> = {},
    init: RequestInit = {},
) =>
    api(
        "/api/transform",
        {
            clientId: "tab1",
            mode: "editdisplay",
            context: context(characterId, chatId),
            client: client(),
            targets,
            ...extra,
        },
        init,
    );
const resume = (snapshotId: string, texts: unknown[], clientId = "tab1") =>
    api("/api/transform/continue", { clientId, snapshotId, texts });

beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await new Promise<void>((resolve) => embedder.listen(0, "127.0.0.1", () => resolve()));
    allowListenerOrigin(embedder);
    const embedderUrl = `http://127.0.0.1:${(embedder.address() as { port: number }).port}/v1/embeddings`;
    rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-transform-"));
    mkdirSync(path.join(rootDir, "dist"));
    writeFileSync(path.join(rootDir, "dist", "index.html"), "<!doctype html><html><head></head><body></body></html>");
    symlinkSync(path.join(REPO_ROOT, "public"), path.join(rootDir, "public"), "dir");
    cpSync(path.join(REPO_ROOT, "version.json"), path.join(rootDir, "version.json"));
    mkdirSync(path.join(rootDir, "save", "server"), { recursive: true });
    writeFileSync(path.join(rootDir, "save", "server", "password"), "pw");
    server = createTestServer({ rootDir });
    signer = await createSigner();
    await server.app.request("/api/login", json({ password: "pw", publicKey: signer.publicJwk }));
    epoch = (await api("/api/resources/ui")).body.epoch;
    presetId = (await single("presets")).data[0].id;
    modelPresetId = (await single("modelPresets")).data[0].id;
    personaId = (await single("personas")).data[0].id;
    await patchSection("memoryTranslateMedia", { hypaModel: "custom" });
    await patchSection("secrets", { hypaCustomSettings: { url: embedderUrl, key: EMBED_KEY, model: "emb" } });
}, SLOW);

afterAll(async () => {
    await server?.close();
    embedder.closeAllConnections();
    embedder.close();
    rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe("the transform's stages", () => {
    it(
        "editdisplay: Lua editDisplay, the display trigger, CBS, the regex scripts in order; @@emo answered, @@inject and the variables not stored",
        async () => {
            await batch({
                ops: [
                    character("tx", {
                        customscript: [
                            rx("Hello", "HELLO"),
                            rx("EMO", "@@emo happy"),
                            rx("INJ", "@@inject"),
                            rx("PROC", "no", "editprocess"),
                        ],
                        triggerscript: [
                            lua(`listenEdit("editDisplay", function(id, value, meta)
                                setChatVar(id, "lv", "7")
                                return value .. " [lua" .. meta.index .. "]"
                            end)`),
                            displayTrigger(" <disp>"),
                        ],
                    }),
                ],
                chats: [chatCreate("tx", "k")],
            });
            const before = await readChat("tx", "k");
            const source = "Hello EMO INJ PROC {{getvar::lv}} {{getvar::tv}}";
            const first = await render("tx", "k", [target("a", "tx", source)]);
            expect(first.status, JSON.stringify(first.body)).toBe(200);
            // Lua ran first (its variable read by CBS), the trigger on Lua's output (its own variable is
            // the trigger's, not the chat's), then CBS and the regex; `@@inject` removed its match.
            expect(first.body.results).toEqual([
                {
                    id: "a",
                    ok: true,
                    text: "HELLO EMO  PROC 7 null [lua1] <disp>",
                    emotions: [{ name: "happy", image: "img-happy-tx" }],
                    key: expect.stringMatching(/^[0-9a-f]{64}$/),
                    cached: false,
                },
            ]);
            const after = await readChat("tx", "k");
            expect(after.revision).toBe(before.revision);
            expect(after.data.scriptstate ?? {}).toEqual({});
            expect(after.data.message.map((m: { data: string }) => m.data)).toEqual(["first", "second"]);

            // A cached result keeps its emotions (a second tab gets them too); `noCache` computes it again.
            const cached = await api("/api/transform", {
                clientId: "tab2",
                mode: "editdisplay",
                context: context("tx", "k"),
                client: client(),
                targets: [target("other-id", "tx", source)],
            });
            expect(cached.body.results[0]).toEqual({ ...first.body.results[0], id: "other-id", cached: true });
            const again = await render("tx", "k", [target("a", "tx", source, { noCache: true })]);
            expect(again.body.results[0]).toEqual({ ...first.body.results[0], cached: false });

            // `editprocess`: no Lua, no display trigger, only the `editprocess` regex.
            const processed = await render("tx", "k", [target("p", "tx", source)], { mode: "editprocess" });
            expect(processed.body.results[0]).toMatchObject({
                ok: true,
                text: "Hello EMO INJ no null null",
                emotions: [],
            });
            expect((await readChat("tx", "k")).revision).toBe(before.revision);
        },
        SLOW,
    );

    it(
        "each target has its own variables, regex results, and emotions, in either order",
        async () => {
            const scripts = [rx("X", "{{getvar::v}}"), rx("i[ab]", "@@emo happy")];
            await batch({
                ops: ["ia", "ib"].map((chaId) =>
                    character(chaId, {
                        customscript: scripts,
                        triggerscript: [
                            lua(
                                `listenEdit("editDisplay", function(id, data) setChatVar(id, "v", "${chaId}") return data end)`,
                            ),
                        ],
                    }),
                ),
                chats: [chatCreate("ia", "k")],
            });
            // The text before the regex is the same ("X"); the variable Lua wrote differs.
            const expected = (id: string, chaId: string, cached: boolean) =>
                expect.objectContaining({
                    id,
                    ok: true,
                    text: chaId,
                    emotions: [{ name: "happy", image: `img-happy-${chaId}` }],
                    cached,
                });
            const first = await render("ia", "k", [target("a", "ia", "X"), target("b", "ib", "X")]);
            expect(first.body.results).toEqual([expected("a", "ia", false), expected("b", "ib", false)]);
            expect(first.body.results[0].key).not.toBe(first.body.results[1].key);
            const reversed = await render("ia", "k", [
                target("b", "ib", "X", { noCache: true }),
                target("a", "ia", "X", { noCache: true }),
            ]);
            expect(reversed.body.results).toEqual([expected("b", "ib", false), expected("a", "ia", false)]);
            // Each cache entry is its own target's.
            const alone = await render("ia", "k", [target("b", "ib", "X")]);
            expect(alone.body.results).toEqual([expected("b", "ib", true)]);
            expect(alone.body.results[0].key).toBe(first.body.results[1].key);
            expect((await readChat("ia", "k")).data.scriptstate ?? {}).toEqual({});
        },
        SLOW,
    );

    it(
        "a Lua variable survives the image getter's refused callback (the snapshot is not read again)",
        async () => {
            await batch({
                ops: [
                    character("img", {
                        image: "assets/no-such-file.png",
                        triggerscript: [
                            lua(`listenEdit("editDisplay", function(id, data)
                                setChatVar(id, "v", "image-local")
                                getCharacterImage(id)
                                getPersonaImage(id)
                                return data .. " {{getvar::v}}"
                            end)`),
                        ],
                    }),
                ],
                chats: [chatCreate("img", "k", { scriptstate: { $v: "stored" } })],
            });
            const res = await render("img", "k", [target("a", "img", "x")]);
            expect(res.body.results[0]).toMatchObject({ ok: true, text: "x image-local" });
            expect((await readChat("img", "k")).data.scriptstate).toEqual({ $v: "stored" });
        },
        SLOW,
    );

    it(
        "a group chat: the source member's Lua and regex, the display trigger of the group's modules",
        async () => {
            const modules = await single("modules");
            await batch({
                ops: [
                    {
                        kind: "modules",
                        id: "main",
                        baseRevision: modules?.revision ?? null,
                        data: [
                            ...(modules?.data ?? []),
                            { id: "mod-g", name: "M", description: "", trigger: [displayTrigger(" <mod>")] },
                        ],
                    },
                    character("gm", {
                        customscript: [rx("member", "MEMBER")],
                        triggerscript: [
                            lua(`listenEdit("editDisplay", function(id, data) return data .. " [gm]" end)`),
                        ],
                    }),
                    {
                        kind: "characters",
                        id: "grp",
                        baseRevision: null,
                        data: {
                            chaId: "grp",
                            type: "group",
                            name: "G",
                            firstMessage: "",
                            characters: ["gm"],
                            characterTalks: [1],
                            characterActive: [true],
                            globalLore: [],
                            emotionImages: [],
                            customscript: [],
                        },
                    },
                ],
                chats: [chatCreate("grp", "gk", { modules: ["mod-g"] })],
            });
            const res = await render("grp", "gk", [target("a", "gm", "member")]);
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body.results[0]).toMatchObject({ ok: true, text: "MEMBER [gm] <mod>" });
            // Without the module the group has no display trigger.
            await patchChat("grp", "gk", { modules: [] });
            const plain = await render("grp", "gk", [target("a", "gm", "member")]);
            expect(plain.body.results[0]).toMatchObject({ ok: true, text: "MEMBER [gm]", cached: false });
        },
        SLOW,
    );

    it(
        "dynamic assets: with dynamicAssetsEditDisplay only, through the server's embeddings; the key is never answered",
        async () => {
            await batch({
                ops: [
                    character("dyn", {
                        additionalAssets: [["smile", "assets/smile.png", "png"]],
                        // A script that never matches: the dynamic assets run after the regex scripts here;
                        // the no-script path is covered by `dynamicAssets.test.ts`.
                        customscript: [rx("never-matches", "x")],
                    }),
                ],
                chats: [chatCreate("dyn", "k")],
            });
            const source = "{{img::grin}} {{emotion::grin}}";
            await patchSection("memoryTranslateMedia", { dynamicAssets: true });
            const off = await render("dyn", "k", [target("a", "dyn", source)]);
            expect(off.body.results[0]).toMatchObject({ ok: true, text: source });
            await patchSection("ui", { dynamicAssetsEditDisplay: true });
            embedRequests.length = 0;
            const on = await render("dyn", "k", [target("a", "dyn", source)]);
            expect(on.body.results[0]).toMatchObject({
                ok: true,
                text: "{{img::smile}} {{emotion::grin}}",
                cached: false,
            });
            expect(embedRequests.length).toBeGreaterThan(0);
            expect(embedRequests.every((request) => request.auth?.includes(EMBED_KEY))).toBe(true);
            // `editprocess` never replaces assets.
            const processed = await render("dyn", "k", [target("a", "dyn", source)], { mode: "editprocess" });
            expect(processed.body.results[0]).toMatchObject({ ok: true, text: source });
            for (const res of [off, on, processed]) {
                expect(JSON.stringify(res.body)).not.toContain(EMBED_KEY);
            }
            await patchSection("ui", { dynamicAssetsEditDisplay: false });
            await patchSection("memoryTranslateMedia", { dynamicAssets: false });
        },
        SLOW,
    );
});

describe("the transform cache's key", () => {
    it(
        "renders again after a committed variable, author's note, local lore, source character, or language change; not for the viewport or the other messages",
        async () => {
            await batch({
                ops: [character("ck", { customscript: [rx("x", "y")] })],
                chats: [chatCreate("ck", "k")],
            });
            const t = [target("a", "ck", "x {{getvar::v}}")];
            const run = async (extra: Record<string, unknown> = {}) =>
                (await render("ck", "k", t, extra)).body.results[0];
            const first = await run();
            expect(first).toMatchObject({ ok: true, text: "y null", cached: false });
            // Deliberately stale: the viewport, and the chat's other messages.
            expect(await run({ client: client(320) })).toMatchObject({ cached: true, key: first.key });
            const chat = await readChat("ck", "k");
            await batch({
                chats: [
                    {
                        characterId: "ck",
                        chatId: "k",
                        baseRevision: chat.revision,
                        ops: [
                            {
                                op: "append",
                                anchor: { end: true },
                                messages: [{ role: "char", data: "third", chatId: "m3" }],
                            },
                        ],
                    },
                ],
            });
            expect(await run()).toMatchObject({ cached: true, key: first.key });

            const keys = new Set([first.key]);
            const expectNew = async (label: string, expectedText: string, extra: Record<string, unknown> = {}) => {
                const result = await run(extra);
                expect(result, label).toMatchObject({ ok: true, text: expectedText, cached: false });
                expect(keys.has(result.key), label).toBe(false);
                keys.add(result.key);
            };
            await patchChat("ck", "k", { scriptstate: { $v: "1" } });
            await expectNew("variable", "y 1");
            await patchChat("ck", "k", { note: "a note" });
            await expectNew("note", "y 1");
            await patchChat("ck", "k", {
                localLore: [
                    {
                        key: "k",
                        content: "c",
                        comment: "",
                        mode: "normal",
                        insertorder: 0,
                        alwaysActive: false,
                        secondkey: "",
                        selective: false,
                    },
                ],
            });
            await expectNew("local lore", "y 1");
            const stored = (await api("/api/resources/characters/ck")).body;
            await batch({
                ops: [
                    {
                        kind: "characters",
                        id: "ck",
                        baseRevision: stored.revision,
                        data: { ...stored.data, customscript: [rx("x", "z")] },
                    },
                ],
            });
            await expectNew("source character", "z 1");
            await expectNew("language", "z 1", { client: client(800, "ko") });
        },
        SLOW,
    );

    it(
        "the same message id in two chats has two entries",
        async () => {
            await batch({
                ops: [character("two", { customscript: [rx("x", "y")] })],
                chats: [chatCreate("two", "k1"), chatCreate("two", "k2")],
            });
            const one = (await render("two", "k1", [target("a", "two", "x")])).body.results[0];
            const two = (await render("two", "k2", [target("a", "two", "x")])).body.results[0];
            expect(one).toMatchObject({ ok: true, text: "y", cached: false });
            expect(two).toMatchObject({ ok: true, text: "y", cached: false });
            expect(one.key).not.toBe(two.key);
        },
        SLOW,
    );
});

describe("the two-call protocol", () => {
    beforeAll(async () => {
        await batch({
            ops: [
                character("tp", {
                    customscript: [rx("X", "{{getvar::v}}"), rx("A", "@@emo happy")],
                    triggerscript: [
                        lua(
                            `listenEdit("editDisplay", function(id, data) setChatVar(id, "v", "A") return data .. "!" end)`,
                        ),
                    ],
                }),
            ],
            chats: [chatCreate("tp", "k")],
        });
    }, SLOW);

    it(
        "the first call stops before the plugin handlers; the second runs on the snapshot's variables, not the store's",
        async () => {
            // A target answered before is cached: it is answered in the first call, not pending.
            const primed = await render("tp", "k", [target("c", "tp", "cached X")], { handlers: "doc:editdisplay:1" });
            expect(primed.body.pending).toEqual([{ id: "c", text: "cached X!" }]);
            expect((await resume(primed.body.snapshotId, primed.body.pending)).body.results[0]).toMatchObject({
                ok: true,
                text: "cached A!",
            });
            const first = await render("tp", "k", [target("a", "tp", "X"), target("c", "tp", "cached X")], {
                handlers: "doc:editdisplay:1",
            });
            expect(first.status).toBe(200);
            expect(first.body.pending).toEqual([{ id: "a", text: "X!" }]);
            expect(first.body.results).toEqual([
                expect.objectContaining({ id: "c", ok: true, text: "cached A!", cached: true }),
            ]);
            await patchChat("tp", "k", { scriptstate: { $v: "stored-later" } });
            const second = await resume(first.body.snapshotId, [{ id: "a", text: "X {{getvar::v}} +plugin" }]);
            expect(second.body.results).toEqual([
                expect.objectContaining({
                    id: "a",
                    ok: true,
                    text: "A A +plugin",
                    emotions: [{ name: "happy", image: "img-happy-tp" }],
                    cached: false,
                }),
            ]);
            expect((await readChat("tp", "k")).data.scriptstate).toEqual({ $v: "stored-later" });
            await patchChat("tp", "k", { scriptstate: {} });
        },
        SLOW,
    );

    it(
        "a wrong continuation is refused without using the snapshot; a used one is gone; a plugin failure fails its target only",
        async () => {
            const first = await render(
                "tp",
                "k",
                [
                    target("a", "tp", "X"),
                    target("b", "tp", "X b", { kind: "text", messageId: undefined, chatIndex: -1 }),
                ],
                {
                    handlers: "doc:editdisplay:2",
                },
            );
            expect(first.body.pending.map((p: { id: string }) => p.id)).toEqual(["a", "b"]);
            const id = first.body.snapshotId;
            const ok = [
                { id: "a", text: "X" },
                { id: "b", error: "boom" },
            ];
            expect((await resume(id, ok, "tab2")).status).toBe(409);
            expect((await resume(id, [{ id: "a", text: "X" }])).status).toBe(400);
            expect((await resume(id, [...ok, { id: "c", text: "X" }])).status).toBe(400);
            expect(
                (
                    await resume(id, [
                        { id: "a", text: "X" },
                        { id: "a", text: "X" },
                    ])
                ).status,
            ).toBe(400);
            expect((await resume(id, [{ id: "a", text: "x".repeat(512 * 1024 + 1) }, ok[1]])).status).toBe(400);
            expect((await resume(id, [{ id: "a", text: "X", error: "both" }, ok[1]])).status).toBe(400);
            const done = await resume(id, ok);
            expect(done.status).toBe(200);
            expect(done.body.results).toEqual([
                expect.objectContaining({ id: "a", ok: true, text: "A" }),
                { id: "b", ok: false, error: "A plugin handler failed: boom" },
            ]);
            const used = await resume(id, ok);
            expect(used.status).toBe(409);
            expect(used.body).toEqual({ error: "SnapshotExpired" });
        },
        SLOW,
    );

    it(
        "two second calls for one snapshot: one wins",
        async () => {
            const first = await render("tp", "k", [target("a", "tp", "X", { noCache: true })], {
                handlers: "doc:editdisplay:3",
            });
            const texts = [{ id: "a", text: "X" }];
            const both = await Promise.all([
                resume(first.body.snapshotId, texts),
                resume(first.body.snapshotId, texts),
            ]);
            expect(both.map((res) => res.status).sort()).toEqual([200, 409]);
        },
        SLOW,
    );

    it(
        "a text before the plugin handlers over 512 KiB fails its target; the pending texts and the variables stay within the limits",
        async () => {
            await batch({
                ops: [
                    character("big", {
                        triggerscript: [
                            lua(`listenEdit("editDisplay", function(id, data) return string.rep("x", 600000) end)`),
                        ],
                    }),
                    character("agg", {
                        triggerscript: [
                            lua(`listenEdit("editDisplay", function(id, data) return string.rep("x", 500000) end)`),
                        ],
                    }),
                    character("ovl", {
                        triggerscript: [
                            lua(
                                `listenEdit("editDisplay", function(id, data) setChatVar(id, "large", string.rep("v", 2000000)) return "tiny" end)`,
                            ),
                        ],
                    }),
                ],
            });
            const big = await render("tp", "k", [target("big", "big", "x")], { handlers: "doc:editdisplay:4" });
            expect(big.body).toEqual({
                results: [{ id: "big", ok: false, error: "The text before the plugin handlers is over 524288 bytes" }],
            });
            const targets = (sourceId: string) =>
                Array.from({ length: 10 }, (_, i) => target(`${sourceId}${i}`, sourceId, "x"));
            const agg = await render("tp", "k", targets("agg"), { handlers: "doc:editdisplay:4" });
            expect(agg.body.pending).toHaveLength(8);
            expect(agg.body.results.filter((r: { ok: boolean }) => !r.ok)).toHaveLength(2);
            // Sent back unchanged (an identity plugin), the pending texts are a valid second call.
            const back = await resume(agg.body.snapshotId, agg.body.pending);
            expect(back.status).toBe(200);
            expect(
                back.body.results.every((r: { ok: boolean; text: string }) => r.ok && r.text.length === 500000),
            ).toBe(true);
            const ovl = await render("tp", "k", targets("ovl"), { handlers: "doc:editdisplay:4" });
            expect(ovl.body.pending).toHaveLength(4);
            expect(ovl.body.results.filter((r: { ok: boolean }) => !r.ok)).toHaveLength(6);
        },
        SLOW,
    );

    it(
        "a maintenance ends the snapshot and refuses renders while it lasts; the cache starts over after it",
        async () => {
            const t = [target("a", "tp", "X")];
            await render("tp", "k", t);
            expect((await render("tp", "k", t)).body.results[0].cached).toBe(true);
            const first = await render("tp", "k", t, { handlers: "doc:editdisplay:5" });
            expect(first.body.snapshotId).toBeTruthy();
            await server.context.snapshots.withMaintenance(async () => {
                const during = await render("tp", "k", t);
                expect(during.status).toBe(503);
                expect(during.headers.get("retry-after")).toBe("5");
                expect((await resume(first.body.snapshotId, [{ id: "a", text: "X" }])).status).toBe(503);
            });
            expect((await resume(first.body.snapshotId, [{ id: "a", text: "X" }])).status).toBe(409);
            expect((await render("tp", "k", t)).body.results[0]).toMatchObject({ ok: true, cached: false });
        },
        SLOW,
    );
});

describe("the transform's admission", () => {
    it(
        "a stale epoch is 412, a missing chat or preset 404, a malformed request 400",
        async () => {
            const t = [target("a", "tp", "X")];
            const stale = await render("tp", "k", t, {}, { headers: { "x-resource-epoch": "old" } });
            expect(stale.status).toBe(412);
            expect(stale.body).toMatchObject({ error: "EpochMismatch", epoch });
            expect((await render("tp", "nope", t)).status).toBe(404);
            expect(
                (
                    await api("/api/transform", {
                        clientId: "tab1",
                        mode: "editdisplay",
                        context: { ...context("tp", "k"), presetId: "nope" },
                        targets: t,
                    })
                ).status,
            ).toBe(404);
            expect(
                (
                    await api("/api/transform", {
                        clientId: "tab1",
                        mode: "editdisplay",
                        context: { ...context("tp", "k"), modelPresetId: "nope" },
                        targets: t,
                    })
                ).status,
            ).toBe(404);
            for (const bad of [
                { targets: [] },
                { mode: "editinput" },
                { targets: [target("a", "tp", "X"), target("a", "tp", "Y")] },
                { targets: [target("a", "tp", "x".repeat(512 * 1024 + 1))] },
                { targets: [{ ...target("a", "tp", "X"), messageId: undefined }] },
                { targets: [target("a", "tp", "X", { cbsConditions: { other: true } })] },
                { targets: Array.from({ length: 65 }, (_, i) => target(`t${i}`, "tp", "X")) },
            ]) {
                const res = await render("tp", "k", t, bad);
                expect(res.status, JSON.stringify(bad).slice(0, 100)).toBe(400);
            }
        },
        SLOW,
    );

    it(
        "renders with the display rule: a bound record that exists must be the one sent (409 chatBindingMismatch), an unset or gone one takes the sent id, a pending review does not matter",
        async () => {
            const personas = await single("personas");
            await batch({
                ops: [
                    {
                        kind: "personas",
                        id: "main",
                        baseRevision: personas.revision,
                        data: [...personas.data, { id: "u2", name: "Bound User" }],
                    },
                    character("tb"),
                ],
                chats: [
                    chatCreate("tb", "k", {
                        modelPresetId: "m-gone",
                        promptPresetId: presetId,
                        bindedPersona: "u2",
                        bindingReview: true,
                    }),
                ],
            });
            const t = [target("a", "tb", "{{user}}")];
            // The tab's persona for a chat bound to another one: refused, nothing rendered.
            const mismatch = await render("tb", "k", t);
            expect(mismatch.status).toBe(409);
            expect(mismatch.body).toEqual({ error: "chatBindingMismatch" });
            const otherPreset = await render("tb", "k", t, {
                context: { ...context("tb", "k"), personaId: "u2", presetId: "nope" },
            });
            expect(otherPreset.status).toBe(409);
            expect(otherPreset.body).toEqual({ error: "chatBindingMismatch" });
            // The bound persona, the bound preset, and the tab's model preset for the gone one: rendered with that persona.
            const ok = await render("tb", "k", t, {
                context: { ...context("tb", "k"), personaId: "u2", selectedPersonaId: "u2" },
            });
            expect(ok.status, JSON.stringify(ok.body)).toBe(200);
            expect(ok.body.results).toMatchObject([{ id: "a", ok: true, text: "Bound User" }]);
        },
        SLOW,
    );

    it(
        "authentication comes before the body is read; an authenticated body over 8 MiB is 413, with or without its length",
        async () => {
            const streamOf = (chunks: number, counter: { pulled: number }) =>
                new ReadableStream({
                    pull(controller) {
                        if (counter.pulled === chunks) {
                            controller.close();
                            return;
                        }
                        counter.pulled++;
                        controller.enqueue(new Uint8Array(1024 * 1024));
                    },
                });
            const unauthenticated = { pulled: 0 };
            const denied = await server.app.request("/api/transform", {
                method: "POST",
                body: streamOf(12, unauthenticated),
                duplex: "half",
                headers: { "content-type": "application/json", "x-resource-epoch": epoch },
            } as RequestInit);
            expect(denied.status).toBe(400);
            expect(unauthenticated.pulled).toBeLessThanOrEqual(2);
            for (const path of ["/api/transform", "/api/transform/continue"]) {
                const streamed = { pulled: 0 };
                const res = await server.app.request(path, {
                    method: "POST",
                    body: streamOf(12, streamed),
                    duplex: "half",
                    headers: {
                        "content-type": "application/json",
                        "risu-auth": await signer.jwt(),
                        "x-resource-epoch": epoch,
                    },
                } as RequestInit);
                expect(res.status, path).toBe(413);
                expect(streamed.pulled).toBeLessThan(12);
                const sized = await server.app.request(path, {
                    method: "POST",
                    body: "x".repeat(9 * 1024 * 1024),
                    headers: {
                        "content-type": "application/json",
                        "content-length": String(9 * 1024 * 1024),
                        "risu-auth": await signer.jwt(),
                        "x-resource-epoch": epoch,
                    },
                });
                expect(sized.status, path).toBe(413);
            }
        },
        SLOW,
    );

    it(
        "an already-aborted request answers 400 and computes nothing",
        async () => {
            const controller = new AbortController();
            controller.abort();
            const t = [target("a", "tp", "X aborted")];
            const aborted = await render("tp", "k", t, {}, { signal: controller.signal });
            expect(aborted.status).toBe(400);
            expect(aborted.body).toEqual({ error: "The request was aborted" });
            expect((await render("tp", "k", t)).body.results[0]).toMatchObject({ ok: true, cached: false });
        },
        SLOW,
    );
});
