import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, plain } from "../storage/tests/mutationStoresHarness";

// Phase 4, slice 5 (`docs/plan/phases/slices/phase-4-external-contracts/lua-character-setters.md`):
// the Lua character getters and setters (`getName`/`setName`, `getDescription`/`setDescription`,
// `getCharacterFirstMessage`/`setCharacterFirstMessage`, `getBackgroundEmbedding`/
// `setBackgroundEmbedding`) through a real wasmoon engine, over the real save adapter and the real
// server store (`storeBackedServer.ts`). A run addresses its own character by the id captured at
// entry (its `char` argument, else the selection at entry), never the tab's selection: the writes go
// through `updateCharacter`, land in that record only, and are sent by the next cycle. A `simple`
// argument resolves to no character (the getters answer "" and the setters write nothing), an
// engine reused across runs reads each run's character, the type checks run before the target is
// resolved (`setDescription` tests `desc`, not the run's data), and a record that goes away while
// the script waits gives the unresolved shapes. The group refusal of `get`/`setDescription` and the
// `upsertLocalLoreBook` type check read the run's character too.

const { server, alerts, image } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        /** `alertInput`: the tests swap it to hold a script open. */
        input: vi.fn(async (): Promise<string> => ""),
    },
    /** `generateAIImage`'s `currentChar` arguments, in order. */
    image: { characters: [] as unknown[] },
}));

vi.mock("../storage/nodeStorage", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertConfirm: vi.fn(async () => true),
    alertSelect: vi.fn(async () => ""),
    alertInput: (...args: unknown[]) => alerts.input(...(args as [])),
}));
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored" },
    changeLanguage: vi.fn(),
}));
vi.mock("./modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
    getModuleTriggers: vi.fn(() => []),
}));
vi.mock("../parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
}));
vi.mock("../globalApi.svelte", () => ({
    downloadFile: vi.fn(),
    saveAsset: vi.fn(),
    fetchNative: vi.fn(),
    readImage: vi.fn(),
}));
vi.mock("./files/inlays", () => ({ getInlayAsset: vi.fn(), writeInlayImage: vi.fn(async () => "inlay1") }));
vi.mock("./lorebook.svelte", () => ({ loadLoreBookV3Prompt: vi.fn() }));
vi.mock("./memory/hypamemory", () => ({ HypaProcesser: vi.fn() }));
vi.mock("./request/request", () => ({ requestChatData: vi.fn() }));
vi.mock("../tokenizer", () => ({ tokenize: vi.fn() }));
vi.mock("./stableDiff", () => ({
    generateAIImage: vi.fn(async (_prompt: string, currentChar: unknown) => {
        image.characters.push(currentChar);
        return "data:image/png;base64,";
    }),
}));
// wasmoon's emscripten glue sees both Node and a window under happy-dom: it resolves its script
// directory from `document.baseURI` and reads the wasm with `fs`. The `<base>` element installed in
// `boot` points the directory at the package, and the wasm is named by a `file:` URL (the glue
// skips its `fetch` attempt for one), since `scriptings.ts` constructs `LuaFactory` without one.
const wasmoonDist = dirname(createRequire(import.meta.url).resolve("wasmoon"));
vi.mock("wasmoon", async (importOriginal) => {
    const original = await importOriginal<typeof import("wasmoon")>();
    const { pathToFileURL } = await import("node:url");
    const { createRequire } = await import("node:module");
    const glue = pathToFileURL(createRequire(import.meta.url).resolve("wasmoon/dist/glue.wasm")).href;
    class LuaFactory extends original.LuaFactory {
        constructor() {
            super(glue);
        }
    }
    return { ...original, LuaFactory };
});

let jsonLua = "";

/**
 * The Lua of a run in mode `probe`: `body` runs with the access key `id` and returns a JSON text.
 * The wrapper's `async` runs it as a coroutine, so `:await()` on a JS promise is allowed.
 */
const probe = (body: string) => `
probe = async(function(id)
${body}
end)
`;

/** Holds the next `alertInput` open; the returned function answers it. */
function holdInput() {
    let release!: (value: string) => void;
    alerts.input.mockImplementationOnce(
        () =>
            new Promise<string>((resolve) => {
                release = resolve;
            }),
    );
    return (value: string) => release(value);
}

/**
 * Waits until `alertInput` was called `count` times (the script reached its wait). Polled with
 * `setImmediate`, which the fake timers leave alone: the first run of a module instantiates the
 * wasm through `fs`, which needs macrotasks.
 */
async function inputCalled(count: number) {
    for (let i = 0; i < 5000 && alerts.input.mock.calls.length < count; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(alerts.input.mock.calls.length).toBe(count);
}

/**
 * Boots the harness, adds `other` (selected), `member` (a typed character), and `group` (a group
 * of `member`), flushes, and loads `scriptings.ts` on that module graph. The seeded `c` is neither
 * selected nor typed.
 */
async function boot() {
    vi.resetModules();
    if (!document.querySelector("base")) {
        const base = document.createElement("base");
        base.setAttribute("href", pathToFileURL(`${wasmoonDist}/`).href);
        document.head.appendChild(base);
    }
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const { characterStore, stores, db, sync, fake } = booted;
    const index = (chaId: string) => db().characters.findIndex((entry: any) => entry?.chaId === chaId);
    const other = characterStore.addCharacter({ type: "character", name: "Other", desc: "other" });
    const member = characterStore.addCharacter({ type: "character", name: "Member", desc: "member" });
    const group = characterStore.addCharacter({ type: "group", name: "Group", characters: [member] });
    stores.selectedCharID.set(index(other));
    await sync.flushResources();
    fake.requests.length = 0;
    const scriptings = await import("./scriptings");
    const chatRefOf = (chaId: string) => ({ chaId, chatId: booted.character(chaId).chats[0].id as string });
    /** Runs `code` in mode `probe` and parses the JSON it returns. */
    const run = async (code: string, arg: Parameters<typeof scriptings.runScripted>[1] = {}) => {
        const result = await scriptings.runScripted(code, { mode: "probe", ...arg });
        return { ...result, json: typeof result.res === "string" ? JSON.parse(result.res) : undefined };
    };
    const saved = (chaId: string) => booted.record("characters", chaId);
    return { ...booted, scriptings, index, other, member, group, chatRefOf, run, saved };
}

beforeAll(async () => {
    jsonLua = await readFile(resolve(process.cwd(), "public/lua/json.lua"), "utf8");
});

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(jsonLua, { status: 200 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    alerts.input.mockImplementation(async () => "");
    image.characters.length = 0;
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("a run's character", () => {
    it("the four setters write the run's non-selected character, the getters read it back, and only that record is sent", async () => {
        const { run, sync, fake, saved, character, other, stores, index } = await boot();
        expect(get(stores.selectedCharID)).toBe(index(other));
        const { json } = await run(
            probe(`
                setName(id, getName(id) .. "!")
                setDescription(id, "lua desc")
                local fm = setCharacterFirstMessage(id, "lua fm")
                local bg = setBackgroundEmbedding(id, "<b>bg</b>")
                return json.encode({
                    name = getName(id), desc = getDescription(id), fm = getCharacterFirstMessage(id),
                    bg = getBackgroundEmbedding(id), fmOk = fm, bgOk = bg,
                })
            `),
            { char: character("c") },
        );
        expect(json).toEqual({
            name: "C!",
            desc: "lua desc",
            fm: "lua fm",
            bg: "<b>bg</b>",
            fmOk: true,
            bgOk: true,
        });
        expect(plain(character("c"))).toMatchObject({
            name: "C!",
            desc: "lua desc",
            firstMessage: "lua fm",
            backgroundHTML: "<b>bg</b>",
        });
        expect(plain(character(other))).toMatchObject({ name: "Other", desc: "other" });
        await sync.flushResources();
        expect(saved("c")).toMatchObject({
            chaId: "c",
            name: "C!",
            desc: "lua desc",
            firstMessage: "lua fm",
            backgroundHTML: "<b>bg</b>",
        });
        expect(saved("c")).not.toHaveProperty("chats");
        expect(saved(other)).toMatchObject({ name: "Other", desc: "other" });
        const batches = fake.batchBodies();
        expect(batches).toHaveLength(1);
        expect(batches[0].ops.map((op: any) => `${op.kind}/${op.id}`)).toEqual(["characters/c"]);
    });

    it("a member's button script on the group's chat writes the member and the group's local lore; a group argument refuses the description and writes no lore", async () => {
        const { run, sync, fake, saved, character, characterStore, chat, member, group, chatRefOf, stores, index } =
            await boot();
        stores.selectedCharID.set(index(group));
        const groupRef = chatRefOf(group);
        const memberRef = chatRefOf(member);
        const code = `
            function onButtonClick(id, data)
                setName(id, "Member " .. data)
                setDescription(id, "member " .. data)
                setCharacterFirstMessage(id, "fm " .. data)
                setBackgroundEmbedding(id, "bg " .. data)
                upsertLocalLoreBook(id, "Town", "A town", { key = "town" })
            end
        `;
        characterStore.updateCharacter(member, {
            triggerscript: [{ comment: "", type: "manual", conditions: [], effect: [{ type: "triggerlua", code }] }],
        });
        await sync.flushResources();
        fake.requests.length = 0;
        const { runLuaButtonTrigger } = await import("./scriptings");
        await runLuaButtonTrigger(character(member) as any, "x", groupRef);
        expect(plain(character(member))).toMatchObject({
            name: "Member x",
            desc: "member x",
            firstMessage: "fm x",
            backgroundHTML: "bg x",
        });
        expect(plain(character(group))).toMatchObject({ type: "group", name: "Group" });
        expect(character(group)).not.toHaveProperty("desc");
        const town = { comment: "Town", content: "A town", key: "town", alwaysActive: false, insertorder: 100 };
        expect(chat.findChat(groupRef)?.localLore).toMatchObject([town]);
        expect(chat.findChat(memberRef)?.localLore).toEqual([]);
        await sync.flushResources();
        expect(saved(member)).toMatchObject({ name: "Member x", desc: "member x", firstMessage: "fm x" });
        expect(saved(group)).toMatchObject({ name: "Group" });
        expect(fake.chat(group, groupRef.chatId)?.data.localLore).toMatchObject([town]);
        expect(fake.chat(member, memberRef.chatId)?.data.localLore).toEqual([]);

        // The group itself as the argument: its description is refused both ways, the lore type
        // check rejects it (the group's chat keeps only Town), and its name is not guarded.
        const { json } = await run(
            probe(`
                local okSet, errSet = pcall(setDescription, id, "x")
                local okGet, errGet = pcall(getDescription, id)
                setName(id, "Group!")
                upsertLocalLoreBook(id, "Other", "content", {})
                return json.encode({
                    okSet = okSet, errSet = tostring(errSet), okGet = okGet, errGet = tostring(errGet),
                    fmNil = getCharacterFirstMessage(id) == nil,
                })
            `),
            { char: character(group), chatRef: groupRef },
        );
        expect(json.okSet).toBe(false);
        expect(json.errSet).toContain("Character is a group");
        expect(json.okGet).toBe(false);
        expect(json.errGet).toContain("Character is a group");
        expect(json.fmNil).toBe(true);
        expect(character(group).name).toBe("Group!");
        expect(character(group)).not.toHaveProperty("desc");
        expect(chat.findChat(groupRef)?.localLore.map((book) => book.comment)).toEqual(["Town"]);

        // A trigger's working copy: the member's run edits the copy and not the live group chat;
        // a group's run and a simple run edit neither.
        const lore = probe(`
            upsertLocalLoreBook(id, "Copy", "in the copy", {})
            return json.encode({})
        `);
        const workingCopy = () => ({ id: "w", name: "W", note: "", localLore: [], message: [] }) as any;
        const memberRun = await run(lore, { char: character(member), chat: workingCopy(), chatRef: groupRef });
        expect(memberRun.chat.localLore.map((book) => book.comment)).toEqual(["Copy"]);
        const groupRun = await run(lore, { char: character(group), chat: workingCopy(), chatRef: groupRef });
        expect(groupRun.chat.localLore).toEqual([]);
        const simpleRun = await run(lore, {
            char: { type: "simple", chaId: member, customscript: [] },
            chat: workingCopy(),
            chatRef: groupRef,
        });
        expect(simpleRun.chat.localLore).toEqual([]);
        expect(chat.findChat(groupRef)?.localLore.map((book) => book.comment)).toEqual(["Town"]);
    });

    it("one engine serves runs for two characters, a simple argument, and a removed record: each run reads and writes its own character", async () => {
        const { run, sync, saved, character, characterStore, chat, chatRefOf, other, member } = await boot();
        const otherRef = chatRefOf(other);
        const code = probe(`
            local v = alertInput(id, "wait"):await()
            local before = getName(id)
            setName(id, before .. "+")
            setDescription(id, "desc of " .. getName(id))
            local fm = setCharacterFirstMessage(id, "fm " .. getName(id))
            local bg = setBackgroundEmbedding(id, "bg")
            local img = generateImage(id, "prompt"):await()
            upsertLocalLoreBook(id, "L", getName(id), {})
            return json.encode({
                before = before, name = getName(id), desc = getDescription(id), fmOk = fm, bgOk = bg, img = img,
                fm = getCharacterFirstMessage(id), bgVal = getBackgroundEmbedding(id),
            })
        `);
        const arg = { lowLevelAccess: true };
        const first = await run(code, { ...arg, char: character(member) });
        expect(first.json).toMatchObject({ before: "Member", name: "Member+", desc: "desc of Member+", fmOk: true });
        expect(first.json.img).toBe("{{inlay::inlay1}}");
        expect(image.characters[0]).toBe(character(member));

        const second = await run(code, { ...arg, char: character(other) });
        expect(second.json).toMatchObject({ before: "Other", name: "Other+", fmOk: true, bgOk: true });
        expect(image.characters[1]).toBe(character(other));
        expect(chat.findChat(otherRef)?.localLore.map((book) => book.content)).toEqual(["Other+"]);

        // A simple argument carrying `other`'s id: no character to read or write; the image call
        // gets the argument itself.
        const simple = { type: "simple" as const, chaId: other, customscript: [] };
        const third = await run(code, { ...arg, char: simple });
        expect(third.json).toEqual({
            before: "",
            name: "",
            desc: "",
            fmOk: false,
            bgOk: false,
            img: "{{inlay::inlay1}}",
            fm: "",
            bgVal: "",
        });
        expect(image.characters[2]).toBe(simple);
        expect(plain(character(other))).toMatchObject({
            name: "Other+",
            desc: "desc of Other+",
            firstMessage: "fm Other+",
        });
        expect(chat.findChat(otherRef)?.localLore.map((book) => book.content)).toEqual(["Other+"]);

        const fourth = await run(code, { ...arg, char: character(member) });
        expect(fourth.json).toMatchObject({ before: "Member+", name: "Member++", desc: "desc of Member++" });
        expect(image.characters[3]).toBe(character(member));

        // The record is removed while the script waits: the getters answer "", the boolean setters
        // false, the void setters write nothing, and the image call falls back to the run's argument.
        const copy = plain(character(member));
        alerts.input.mockImplementationOnce(async () => {
            expect(characterStore.removeCharacter(member)).toBe(true);
            return "";
        });
        const fifth = await run(code, { ...arg, char: copy });
        expect(fifth.json).toEqual({
            before: "",
            name: "",
            desc: "",
            fmOk: false,
            bgOk: false,
            img: "{{inlay::inlay1}}",
            fm: "",
            bgVal: "",
        });
        expect(image.characters[4]).toBe(copy);
        expect(character(member)).toBeUndefined();

        expect(
            (console.log as any).mock.calls.filter((call: unknown[]) =>
                String(call[0]).startsWith("Creating new Lua engine"),
            ),
        ).toHaveLength(1);
        await sync.flushResources();
        expect(saved(other)).toMatchObject({ name: "Other+", desc: "desc of Other+", firstMessage: "fm Other+" });
        expect(saved(member)).toBeUndefined();
    });

    it("is fixed at entry: a queued run's changed argument and a moved selection do not redirect the writes", async () => {
        const { run, sync, saved, character, stores, index, other, member } = await boot();
        const code = probe(`
            local v = alertInput(id, "wait"):await()
            setName(id, "written " .. v)
            return json.encode({ name = getName(id) })
        `);

        // The first run holds the engine; the second queues on the mutex with a plain argument that
        // is changed (id and type) before it runs.
        const release = holdInput();
        const first = run(code, { char: character(member) });
        await inputCalled(1);
        const argument = plain(character(other));
        const second = run(code, { char: argument });
        alerts.input.mockImplementationOnce(async () => "second");
        argument.chaId = "c";
        argument.type = "simple";
        release("first");
        expect((await first).json).toEqual({ name: "written first" });
        expect((await second).json).toEqual({ name: "written second" });
        expect(character(member).name).toBe("written first");
        expect(character(other).name).toBe("written second");
        expect(character("c").name).toBe("C");

        // No argument: the selection at entry (`other`) is the character, although the selection
        // moved to `c` while the script waited.
        const releaseSelected = holdInput();
        const third = run(code);
        await inputCalled(3);
        stores.selectedCharID.set(index("c"));
        releaseSelected("sel");
        expect((await third).json).toEqual({ name: "written sel" });
        expect(character(other).name).toBe("written sel");
        expect(character("c").name).toBe("C");
        expect(get(stores.selectedCharID)).toBe(index("c"));

        await sync.flushResources();
        expect(saved(member).name).toBe("written first");
        expect(saved(other).name).toBe("written sel");
        expect(saved("c").name).toBe("C");
    });

    it("reads a record replaced under the same id while the script waited, and patches it without restoring old fields", async () => {
        const { run, sync, saved, character, characterStore, member } = await boot();
        const release = holdInput();
        const pending = run(
            probe(`
                local v = alertInput(id, "wait"):await()
                local seen = getName(id)
                setDescription(id, "patched")
                return json.encode({ seen = seen, name = getName(id), fm = getCharacterFirstMessage(id) })
            `),
            { char: character(member) },
        );
        await inputCalled(1);
        expect(
            characterStore.replaceCharacterFields({
                chaId: member,
                type: "character",
                name: "Replaced",
                firstMessage: "rfm",
            }),
        ).toBe(true);
        release("");
        expect((await pending).json).toEqual({ seen: "Replaced", name: "Replaced", fm: "rfm" });
        expect(plain(character(member))).toMatchObject({ name: "Replaced", firstMessage: "rfm", desc: "patched" });
        await sync.flushResources();
        expect(saved(member)).toMatchObject({ name: "Replaced", firstMessage: "rfm", desc: "patched" });
    });

    it("refuses non-string values and a bad access key before resolving the target, checks desc rather than the run's data, and answers nil for a missing field", async () => {
        const { run, sync, fake, saved, character, member } = await boot();
        const { json } = await run(
            probe(`
                local okName, errName = pcall(setName, id, 5)
                local okDesc, errDesc = pcall(setDescription, id, {})
                local fm = setCharacterFirstMessage(id, 5)
                local bg = setBackgroundEmbedding(id, {})
                setName("bad", "x")
                setDescription("bad", "x")
                local fmBad = setCharacterFirstMessage("bad", "x")
                local bgBad = setBackgroundEmbedding("bad", "x")
                setDescription(id, "typed")
                return json.encode({
                    okName = okName, errName = tostring(errName), okDesc = okDesc, errDesc = tostring(errDesc),
                    fm = fm, bg = bg, fmBad = fmBad == nil, bgBad = bgBad == nil,
                    descBad = getDescription("bad") == nil, bgGetBad = getBackgroundEmbedding("bad") == nil,
                    fmNil = getCharacterFirstMessage(id) == nil, bgNil = getBackgroundEmbedding(id) == nil,
                    name = getName(id), desc = getDescription(id),
                })
            `),
            // The run's data is not a string: the old `setDescription` checked it instead of `desc`.
            { char: character(member), data: [{ role: "user", content: "x" }] },
        );
        expect(json.okName).toBe(false);
        expect(json.errName).toContain("Invalid data type");
        expect(json.okDesc).toBe(false);
        expect(json.errDesc).toContain("Invalid data type");
        expect(json).toMatchObject({
            fm: false,
            bg: false,
            fmBad: true,
            bgBad: true,
            descBad: true,
            bgGetBad: true,
            fmNil: true,
            bgNil: true,
            name: "Member",
            desc: "typed",
        });
        expect(plain(character(member))).toEqual({ ...plain(character(member)), name: "Member", desc: "typed" });
        expect(character(member)).not.toHaveProperty("firstMessage");
        expect(character(member)).not.toHaveProperty("backgroundHTML");
        await sync.flushResources();
        expect(saved(member)).toMatchObject({ name: "Member", desc: "typed" });
        expect(saved(member)).not.toHaveProperty("firstMessage");
        expect(saved(member)).not.toHaveProperty("backgroundHTML");
        const batches = fake.batchBodies();
        expect(batches).toHaveLength(1);
        expect(batches[0].ops.map((op: any) => `${op.kind}/${op.id}`)).toEqual([`characters/${member}`]);
    });
});
