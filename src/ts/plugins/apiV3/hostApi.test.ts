import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The v3 host API used to borrow its `setDatabase`/`setDatabaseLite` and
// `safeLocalStorage` implementations from the removed API 2.1 layer. They now
// live in `v3.svelte.ts`. These tests pin the contracts the move must keep:
// - `setDatabaseLite`/`setDatabase` route each `allowedDbKeys` key to the
//   mutation that owns it on the settings records (a forwarded key such as
//   `temperature` into the selected preset) and every other key to the top
//   level of `pluginCustomStorage`, without touching the v3 `_pluginStorage`
//   sub-object. The removed `pluginV2` key is no longer an allowed key, so it
//   lands in custom storage too. Nothing normalizes the records globally
//   (each routed value is checked by its owner; there is no whole-database
//   normalizer).
// - the `_*SafeLocalStorage` aliases work when called detached, which is how
//   the sandbox RPC (`CALL_ROOT` does `fn(...args)`) invokes them. `key` and
//   `clear` used to be exported unbound and threw on `this`.

type CapturedApi = Record<string, (...args: any[]) => any>;

const { captured } = vi.hoisted(() => ({
    captured: { api: null as CapturedApi | null },
}));

vi.mock("./factory", () => ({
    SandboxHost: class {
        constructor(apiFactory: CapturedApi) {
            captured.api = apiFactory;
        }
        run() {}
        executeInIframe() {
            return Promise.resolve();
        }
        dispose() {}
    },
}));

vi.mock("src/ts/globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    getFetchLogs: vi.fn(() => []),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    saveAsset: vi.fn(),
    readImage: vi.fn(),
    getFileSrc: vi.fn(),
    downloadFile: vi.fn(),
}));

vi.mock("src/ts/alert", async (importOriginal) => {
    // The terminal notice is the real one: the plugin key listeners read its flag.
    const { terminalNotice, alertTerminal, acknowledgeTerminalNotice, terminalNoticeShown } =
        await importOriginal<typeof import("src/ts/alert")>();
    return (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: vi.fn(async () => true),
        terminalNotice,
        alertTerminal,
        acknowledgeTerminalNotice,
        terminalNoticeShown,
    });
});

// Permissions are granted (`getRootDocument` asks for `mainDom`): no prompt and no grant record.
vi.mock("./permissionStore", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./permissionStore")>()),
    hasPermissionGrant: () => true,
    getLastGrantTime: () => Date.now(),
    recordPermissionGrants: vi.fn(async () => undefined),
}));

// The real parser module installs a module-level `$effect.root` over the selection, which is
// still uninitialized here because the modules import each other. Nothing under test parses CBS.
vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
}));

import { normalizeCharacter, supaMemoryOnCount } from "../../../../shared/characters.ts";
import { acknowledgeTerminalNotice, alertTerminal, terminalNoticeShown } from "src/ts/alert";
import { characterList } from "src/ts/storage/characterStore.svelte";
import { selection, selectPersona, selectPreset } from "src/ts/storage/selection.svelte";
import { activePreset, selectedPersonaIndex, settings } from "src/ts/storage/settingsViews.svelte";
import { rootSnapshot } from "src/ts/storage/snapshots.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { executePluginV3 } from "./v3.svelte";

/**
 * The records installed as the app installs them (there is no whole-database aggregate): one
 * preset (`preset`, selected here), which a forwarded key such as `temperature` reads and writes
 * through `activePreset`, and the characters' chats held in the chat module, as boot assembles
 * them. `selectedPersonaIndex()` reads this client's persona selection.
 */
function installDatabase(fields: Record<string, unknown>) {
    selectPreset("preset");
    installFlatDatabaseWithChats({ botPresets: [{ id: "preset", name: "P", temperature: 0 }], ...fields });
}

const selectedPresetOf = () => settings.presets.find((preset: { id: string }) => preset.id === "preset") as any;

async function makeApi(): Promise<CapturedApi> {
    captured.api = null;
    await executePluginV3({
        name: `hostApi-test-${Math.random().toString(36).slice(2)}`,
        script: "",
        version: "3.0",
    } as any);
    expect(captured.api).not.toBeNull();
    return captured.api!;
}

describe("v3 setDatabase / setDatabaseLite routing", () => {
    beforeEach(() => {
        installDatabase({ characters: [], pluginCustomStorage: undefined });
    });

    it("setDatabaseLite assigns allowed keys and routes the rest into pluginCustomStorage", async () => {
        const api = await makeApi();

        await api.setDatabaseLite({
            characters: [{ name: "c" }],
            custom: { x: 1 },
            pluginV2: [{ name: "old" }],
        });

        // `characters` is reconciled on the live mirror: a new character is added with a `chaId`, the
        // shared defaults and a `creation_date` (prepared as a creation), and ids for its chats (a
        // default chat when it has none), usable at once. The chats are the wrapper's chat view, not
        // own keys of the record.
        expect(characterList()).toEqual([
            {
                ...normalizeCharacter({ name: "c" }),
                chaId: expect.any(String),
                creation_date: expect.any(Number),
            },
        ]);
        expect((characterList()[0] as any).chatPage).toBe(0);
        expect((characterList()[0] as any).chats).toEqual([
            { id: expect.any(String), message: [], note: "", name: "Chat 1", localLore: [], fmIndex: -1 },
        ]);
        expect(settings.pluginStorage).toEqual({ custom: { x: 1 }, pluginV2: [{ name: "old" }] });
        // Neither key is a settings root: the legacy flat shape has no such field.
        expect("custom" in rootSnapshot()).toBe(false);
        expect("pluginV2" in rootSnapshot()).toBe(false);
    });

    it("setDatabase routes the same way, a forwarded key into the selected preset, with no global normalization", async () => {
        const api = await makeApi();

        await api.setDatabase({ temperature: 80, custom: "v" });

        expect(selectedPresetOf().temperature).toBe(80);
        expect(activePreset.temperature).toBe(80);
        expect(settings.pluginStorage).toEqual({ custom: "v" });
    });

    it("keeps existing ids, gives a persona without an id one, and drops non-object entries", async () => {
        const api = await makeApi();
        const personas = [
            { name: "no id", icon: "", personaPrompt: "" },
            { id: "keep", name: "kept", icon: "", personaPrompt: "" },
            { id: "", name: "empty id", icon: "", personaPrompt: "" },
            null,
        ];

        // Both setters apply the collection's contract (`shared/personas.ts`): a missing or empty id
        // gets one, an existing id is kept, a non-object entry is dropped, and the four persona fields
        // are filled as strings (`note` here).
        await api.setDatabaseLite({ personas });
        const lite = settings.personas as any[];
        expect(lite).toHaveLength(3);
        expect(lite[0]).toEqual({ name: "no id", icon: "", personaPrompt: "", note: "", id: expect.any(String) });
        expect(lite[0].id.length).toBeGreaterThan(0);
        expect(lite[1]).toEqual({ ...personas[1], note: "" });
        expect(lite[2].id.length).toBeGreaterThan(0);
        expect(new Set(lite.map((persona) => persona.id)).size).toBe(3);
        // The plugin's own array is not mutated.
        expect(personas[0]).toEqual({ name: "no id", icon: "", personaPrompt: "" });
        expect(personas[3]).toBeNull();

        await api.setDatabase({ personas: [{ name: "again", icon: "", personaPrompt: "" }] });
        const full = settings.personas as any[];
        expect(full).toHaveLength(1);
        expect(full[0].id.length).toBeGreaterThan(0);
    });

    it("keeps the v3 _pluginStorage sub-object next to routed custom keys", async () => {
        settings.pluginStorage = { _pluginStorage: { k: 1 } };
        const api = await makeApi();

        await api.setDatabaseLite({ custom: 1 });
        await api.setDatabase({ other: 2 });

        expect(settings.pluginStorage).toEqual({ _pluginStorage: { k: 1 }, custom: 1, other: 2 });
        expect(await api._getPluginStorage("k")).toBe(1);
    });
});

// The sections, the collections, and the two selection ids are normalized by the server, and the
// client applies no default to them any more, so no setter repairs a `null` or `undefined` a plugin
// writes there. Both setters refuse such a write (through the owning mutation, with a warning) and
// keep the value. A forwarded preset field is checked the same way by `updateSettings` (a `null` is
// refused where the field has no `null` value); a malformed non-null section value still goes
// through: the server repairs it on write.
describe("v3 setDatabase / setDatabaseLite against server-normalized fields", () => {
    const personas = [{ id: "p", name: "P", icon: "", personaPrompt: "", note: "", largePortrait: false }];

    beforeEach(() => {
        selectPersona("p");
        installDatabase({
            characters: [],
            askRemoval: true,
            theme: "",
            personas,
            // Not `enabledModules`: the module-update effect of `stores.svelte.ts` tracks it, and a
            // non-empty list would move `process/modules.ts`'s cache off the empty key the other
            // fixtures of this file (which have no `modules`) rely on.
            customCSS: "",
            characterOrder: ["c"],
            pluginCustomStorage: undefined,
        });
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("keeps a section, collection, or selection field when a plugin writes null or undefined, and warns", async () => {
        const api = await makeApi();

        await api.setDatabaseLite({ askRemoval: null, personas: undefined, customCSS: null, theme: undefined });
        expect(settings.ui.askRemoval).toBe(true);
        expect(settings.personas).toEqual(personas);
        expect(settings.ui.customCSS).toBe("");
        expect(settings.ui.theme).toBe("");
        expect(console.warn).toHaveBeenCalledTimes(4);
        expect(vi.mocked(console.warn).mock.calls[0][0]).toContain("askRemoval");

        await api.setDatabase({ characterOrder: null, personas: null, askRemoval: undefined });
        expect(settings.characterOrder).toEqual(["c"]);
        expect(settings.personas).toEqual(personas);
        expect(settings.ui.askRemoval).toBe(true);
        // Nothing lands in the custom storage either: the key is known, only its value is refused
        // (and the setters no longer create an empty dictionary when no custom key is sent).
        expect(settings.pluginStorage).toBeUndefined();
    });

    it("refuses null in a non-nullable forwarded preset field and an index that names no persona, and warns", async () => {
        const api = await makeApi();
        // A second persona, selected, so an unchanged selection is told apart from the fallback to the first.
        settings.personas = [...personas, { ...personas[0], id: "q", name: "Q" }];
        selectPersona("q");
        expect(selectedPersonaIndex()).toBe(1);

        await api.setDatabaseLite({ temperature: null, selectedPersona: undefined });
        expect(selectedPresetOf().temperature).toBe(0);
        expect(activePreset.temperature).toBe(0);
        expect(selectedPersonaIndex()).toBe(1);
        expect(selection.personaId).toBe("q");
        expect(console.warn).toHaveBeenCalledTimes(2);
        expect(vi.mocked(console.warn).mock.calls[0][0]).toMatch(
            /^\[Plugin\] Refused the database key temperature; the previous value was kept: /,
        );
        expect(vi.mocked(console.warn).mock.calls[1][0]).toMatch(
            /^\[Plugin\] Refused the database key selectedPersona; the previous value was kept: /,
        );

        await api.setDatabase({ temperature: null });
        expect(selectedPresetOf().temperature).toBe(0);
        expect(console.warn).toHaveBeenCalledTimes(3);
    });

    it("accepts a non-null value of a server-normalized field as-is (the server repairs a malformed one on write)", async () => {
        const api = await makeApi();
        await api.setDatabaseLite({ askRemoval: "yes", customCSS: ".x {}", theme: "dark" });
        expect(settings.ui.askRemoval).toBe("yes");
        expect(settings.ui.customCSS).toBe(".x {}");
        expect(settings.ui.theme).toBe("dark");
        expect(console.warn).not.toHaveBeenCalled();
        await api.setDatabase({ askRemoval: false });
        expect(settings.ui.askRemoval).toBe(false);
    });
});

describe("v3 safeLocalStorage aliases", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it("work when called detached, as the sandbox RPC calls them", async () => {
        const api = await makeApi();
        const {
            _setSafeLocalStorage,
            _getSafeLocalStorage,
            _keySafeLocalStorage,
            _keysSafeLocalStorage,
            _removeSafeLocalStorage,
            _clearSafeLocalStorage,
        } = api;

        localStorage.setItem("unrelated", "keep");
        _setSafeLocalStorage("a", "1");
        _setSafeLocalStorage("b", "2");

        expect(_getSafeLocalStorage("a")).toBe("1");
        expect(localStorage.getItem("safe_plugin_a")).toBe("1");
        expect(_keysSafeLocalStorage()).toEqual(["a", "b"]);
        expect(_keySafeLocalStorage(0)).toBe("a");
        expect(_keySafeLocalStorage(5)).toBeNull();

        _removeSafeLocalStorage("a");
        expect(_keysSafeLocalStorage()).toEqual(["b"]);

        _clearSafeLocalStorage();
        expect(_keysSafeLocalStorage()).toEqual([]);
        expect(localStorage.getItem("safe_plugin_b")).toBeNull();
        expect(localStorage.getItem("unrelated")).toBe("keep");
    });
});

// The character setters against the chat module's generation lock: a character that is generating
// a reply is neither dropped nor replaced by another id, a list with duplicate ids is refused as a
// whole, and a chat change that touches the generating message skips that chat (metadata and other
// messages still apply).
import * as chatStore from "src/ts/storage/chatStore.svelte";

describe("v3 character setters and the generation lock", () => {
    const refK = { chaId: "c", chatId: "k" };
    const message = (id: string, data: string, role: "user" | "char" = "char") => ({ role, data, chatId: id }) as any;
    function liveCharacters() {
        return [
            {
                chaId: "c",
                type: "character",
                name: "C",
                chatPage: 0,
                chats: [
                    {
                        id: "k",
                        name: "K",
                        note: "",
                        localLore: [],
                        message: [message("a", "reply so far"), message("b", "B", "user")],
                    },
                ],
            },
            {
                chaId: "d",
                type: "character",
                name: "D",
                chatPage: 0,
                chats: [{ id: "kd", name: "KD", note: "", localLore: [], message: [] }],
            },
        ];
    }

    // A server generation job locks the reply; an ended generation is retired, so each test uses its own.
    let job = 0;

    beforeEach(() => {
        // The characters are records: installed as boot installs them.
        installDatabase({ characters: liveCharacters(), pluginCustomStorage: undefined });
        vi.spyOn(console, "warn").mockImplementation(() => {});
        job += 1;
        chatStore.applyServerGeneration(refK, {
            jobId: `J${job}`,
            messageId: "a",
            generationId: `g${job}`,
            text: "reply so far",
            seq: 0,
        });
    });

    afterEach(() => {
        chatStore.endServerJob(`J${job}`);
        vi.restoreAllMocks();
    });

    it("keeps a generating character that setDatabaseLite's list omits, and refuses to replace it by another id", async () => {
        const api = await makeApi();
        await api.setDatabaseLite({ characters: [liveCharacters()[1]] });
        expect(characterList().map((character: any) => character.chaId)).toEqual(["c", "d"]);
        expect(chatStore.isMessageLocked(refK, "a")).toBe(true);
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/removal was skipped/));

        await api.setCharacterToIndex(0, { chaId: "other", type: "character", name: "Other", chats: [], chatPage: 0 });
        expect(characterList().map((character: any) => character.chaId)).toEqual(["c", "d"]);
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/replacement was skipped/));
        // A character that is not generating can be replaced.
        await api.setCharacterToIndex(1, { chaId: "other", type: "character", name: "Other", chats: [], chatPage: 0 });
        expect(characterList().map((character: any) => character.chaId)).toEqual(["c", "other"]);
    });

    it("refuses a character list with duplicate ids before changing anything", async () => {
        const api = await makeApi();
        const [c, d] = liveCharacters();
        await api.setDatabaseLite({ characters: [{ ...c, name: "renamed" }, d, { ...c, name: "again" }] });
        expect(characterList().map((character: any) => [character.chaId, character.name])).toEqual([
            ["c", "C"],
            ["d", "D"],
        ]);
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/duplicate chaId/));
        expect(chatStore.isMessageLocked(refK, "a")).toBe(true);
    });

    it("setChatToIndex skips a chat change that touches the generating message, and applies one that does not", async () => {
        const api = await makeApi();
        const current = await api.getChatFromIndex(0, 0);
        await api.setChatToIndex(0, 0, {
            ...current,
            note: "plugin note",
            message: [message("a", "rewritten by the plugin"), current.message[1]],
        });
        expect(chatStore.findChat(refK)!.message[0].data).toBe("reply so far");
        expect((chatStore.findChat(refK) as any).note).toBe("");
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/message being generated/), expect.anything());

        await api.setChatToIndex(0, 0, {
            ...current,
            note: "plugin note",
            message: [current.message[0], message("b", "edited by the plugin", "user")],
        });
        expect(chatStore.findChat(refK)!.message.map((entry) => entry.data)).toEqual([
            "reply so far",
            "edited by the plugin",
        ]);
        expect((chatStore.findChat(refK) as any).note).toBe("plugin note");
        expect(chatStore.isMessageLocked(refK, "a")).toBe(true);
    });
});

describe("v3 character setters normalize new characters", () => {
    beforeEach(() => {
        // The characters are records: installed as boot installs them.
        installDatabase({
            characters: [
                {
                    chaId: "c",
                    type: "character",
                    name: "C",
                    chatPage: 0,
                    chats: [{ id: "k", name: "K", note: "", localLore: [], message: [] }],
                },
                {
                    chaId: "d",
                    type: "character",
                    name: "D",
                    chatPage: 0,
                    chats: [{ id: "kd", name: "KD", note: "", localLore: [], message: [] }],
                },
            ],
            pluginCustomStorage: undefined,
        });
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("gives a character added by a list, with or without a chaId, chat and message ids at once, and keeps the existing ones", async () => {
        const api = await makeApi();
        const existing = JSON.parse(JSON.stringify(characterList()));
        await api.setDatabaseLite({
            characters: [
                ...existing,
                {
                    name: "with id",
                    chaId: "n",
                    chats: [{ message: [{ role: "user", data: "hi" }], note: "", name: "Chat 1", localLore: [] }],
                },
                { name: "without id", chats: [] },
            ],
        });
        const [c, d, n, w] = characterList() as any[];
        expect([c.chaId, d.chaId, n.chaId]).toEqual(["c", "d", "n"]);
        expect(typeof w.chaId).toBe("string");
        expect(w.chaId).not.toBe("");
        expect(typeof n.chats[0].id).toBe("string");
        expect(typeof n.chats[0].message[0].chatId).toBe("string");
        expect(n.chatPage).toBe(0);
        expect(w.chats).toEqual([
            { id: expect.any(String), message: [], note: "", name: "Chat 1", localLore: [], fmIndex: -1 },
        ]);
        expect(chatStore.findChat({ chaId: w.chaId, chatId: w.chats[0].id })).toBeDefined();
        expect(chatStore.findChat({ chaId: "n", chatId: n.chats[0].id })!.message[0].data).toBe("hi");
        // Existing characters keep their chats; nothing is queued for the new ones yet (their
        // creates travel with the characters' own creates in the save loop).
        expect(c.chats[0].id).toBe("k");
        expect(chatStore.takeChatWork(new Set([n.chaId, w.chaId])).groups).toEqual([]);
    });

    it("refuses a list that names one id-less object twice (it would get one id twice), leaving the mirror unchanged", async () => {
        const api = await makeApi();
        const existing = JSON.parse(JSON.stringify(characterList()));
        const twice = { name: "alias", chats: [] };
        await api.setDatabaseLite({ characters: [...existing, twice, twice] });
        expect(characterList().map((character: any) => character.chaId)).toEqual(["c", "d"]);
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/duplicate chaId/));
        // The same object once is an ordinary new character.
        await api.setDatabaseLite({ characters: [...existing, twice] });
        expect(characterList().map((character: any) => character.name)).toEqual(["C", "D", "alias"]);
    });

    it("normalizes a replacement character in setCharacterToIndex, and skips one whose chaId another character has", async () => {
        const api = await makeApi();
        await api.setCharacterToIndex(1, {
            name: "replacement",
            chats: [{ message: [], note: "", name: "R", localLore: [] }],
        });
        const r = characterList()[1] as any;
        expect(typeof r.chaId).toBe("string");
        expect(r.chaId).not.toBe("d");
        expect(typeof r.chats[0].id).toBe("string");
        expect(r.chatPage).toBe(0);
        expect(chatStore.findChat({ chaId: r.chaId, chatId: r.chats[0].id })).toBeDefined();

        await api.setCharacterToIndex(1, {
            chaId: "c",
            type: "character",
            name: "a copy of c",
            chats: [],
            chatPage: 0,
        });
        expect(characterList().map((character: any) => character.chaId)).toEqual(["c", r.chaId]);
        expect((characterList()[1] as any).name).toBe("replacement");
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/another character already has/));
    });

    it("setCharacterToIndex prepares a new character as a creation, and gives a same-id replacement the defaults only", async () => {
        const api = await makeApi();
        const oldLore = { key: "k", content: "<char>", bookVersion: 1 };
        await api.setCharacterToIndex(1, {
            chaId: "n",
            name: "new",
            firstMsgIndex: 1,
            postHistoryInstructions: "moved",
            ttsMode: "none",
            globalLore: [oldLore],
        });
        const created = characterList()[1] as any;
        expect(created).toMatchObject({
            chaId: "n",
            desc: "",
            ttsMode: "",
            postHistoryInstructions: "",
            creation_date: expect.any(Number),
            globalLore: [{ key: "k", content: "{{char}}", bookVersion: 2 }],
        });
        expect(created.chats).toHaveLength(1);
        expect(created.chats[0]).toMatchObject({ name: "Chat 1", note: "moved", fmIndex: 1, localLore: [] });

        // The same id: a whole replacement of the character's fields, with the defaults, no creation step.
        await api.setCharacterToIndex(1, { chaId: "n", name: "replaced", globalLore: [oldLore], ttsMode: "none" });
        const replaced = characterList()[1] as any;
        expect(replaced).toMatchObject({ chaId: "n", name: "replaced", desc: "", ttsMode: "none" });
        expect(JSON.parse(JSON.stringify(replaced.globalLore))).toEqual([oldLore]);
        expect(replaced).not.toHaveProperty("creation_date");
        expect(replaced.chats[0]).toMatchObject({ note: "moved", fmIndex: 1 });
    });
});

// The plugin index APIs keep the character list's position (creation order) as their index, read
// through `characterList()`/`selectedCharacter()`. The sidebar's order (`characterOrder`, which its
// drag rewrites) and the name order of the previous/next hotkeys are not the plugin's index; a
// getter's result is a detached copy.
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { removeCharacter } from "src/ts/storage/characterStore.svelte";

describe("v3 index APIs address the character list's position", () => {
    const character = (chaId: string, name: string) => ({
        chaId,
        type: "character",
        name,
        chatPage: 0,
        chats: [{ id: `k${chaId}`, name: `K${chaId}`, note: "", localLore: [], message: [] }],
    });

    beforeEach(() => {
        installDatabase({
            characters: [character("c", "Zed"), character("d", "Amy"), character("e", "Bob")],
            characterOrder: ["e", "d", "c"],
            pluginCustomStorage: undefined,
        });
        selectCharacter("d");
    });

    afterEach(() => {
        selectCharacter(null);
    });

    it("read the list position, unchanged by a reorder of the sidebar's order, with detached results", async () => {
        const api = await makeApi();
        const read = async () =>
            Promise.all([0, 1, 2, 3, -1].map(async (index) => (await api.getCharacterFromIndex(index))?.chaId ?? null));
        expect(await read()).toEqual(["c", "d", "e", null, null]);
        expect(api.getCurrentCharacterIndex()).toBe(1);
        expect(api.getCurrentChatIndex()).toBe(0);
        expect((await api.getChatFromIndex(2, 0)).id).toBe("ke");
        expect(await api.getChatFromIndex(3, 0)).toBeNull();

        // The sidebar's drag writes the order record; the plugin's indexes stay the list's.
        settings.characterOrder = ["c", "e", "d"];
        expect(await read()).toEqual(["c", "d", "e", null, null]);
        expect(api.getCurrentCharacterIndex()).toBe(1);

        const copy = await api.getCharacterFromIndex(0);
        copy.name = "changed by the plugin";
        expect(characterList()[0].name).toBe("Zed");

        // The selected character moves down when an earlier one leaves the list; its index follows.
        removeCharacter("c");
        expect(api.getCurrentCharacterIndex()).toBe(0);
        expect((await api.getCharacterFromIndex(0)).chaId).toBe("d");
    });
});

// A plugin character applied over the same `chaId` that turns memory on counts the turn-on
// (`supaMemoryOnCount`), so a chat's "don't ask again" answer to the no-memory trim question
// (`memoryTrimAck`, the count when answered) stops matching and the question asks again; the
// plugin's own copy of the count never replaces the stored one.
describe("v3 character setters and the memory turn-on count", () => {
    function installMemoryCharacter(fields: Record<string, unknown>) {
        installDatabase({
            characters: [
                {
                    chaId: "c",
                    type: "character",
                    name: "C",
                    chatPage: 0,
                    ...fields,
                    chats: [{ id: "k", name: "K", note: "", localLore: [], message: [], memoryTrimAck: 2 }],
                },
            ],
            pluginCustomStorage: undefined,
        });
    }
    const stored = () => characterList()[0] as any;
    const trimAck = () => (chatStore.findChat({ chaId: "c", chatId: "k" }) as any).memoryTrimAck;

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("setCharacterToIndex turning memory on bumps the stored count, whatever the plugin's copy says", async () => {
        installMemoryCharacter({ supaMemory: false, supaMemoryOnCount: 2 });
        const api = await makeApi();
        const copy = await api.getCharacterFromIndex(0);
        expect(supaMemoryOnCount(copy)).toBe(trimAck());
        await api.setCharacterToIndex(0, { ...copy, supaMemory: true, supaMemoryOnCount: 0 });
        expect(stored().supaMemory).toBe(true);
        expect(stored().supaMemoryOnCount).toBe(3);
        // The chat's answer no longer matches the owner's count: the trim question asks again.
        expect(trimAck()).toBe(2);
        expect(supaMemoryOnCount(stored())).not.toBe(trimAck());
    });

    it("keeps the stored count when memory stays on or turns off", async () => {
        installMemoryCharacter({ supaMemory: true, supaMemoryOnCount: 2 });
        const api = await makeApi();
        const copy = await api.getCharacterFromIndex(0);
        await api.setCharacterToIndex(0, { ...copy, desc: "edited", supaMemoryOnCount: 99 });
        expect(stored().desc).toBe("edited");
        expect(stored().supaMemoryOnCount).toBe(2);
        await api.setCharacterToIndex(0, { ...copy, supaMemory: false, supaMemoryOnCount: 7 });
        expect(stored().supaMemory).toBe(false);
        expect(stored().supaMemoryOnCount).toBe(2);
        // Turned on again: counted once more.
        await api.setCharacterToIndex(0, { ...copy, supaMemory: true });
        expect(stored().supaMemoryOnCount).toBe(3);
    });

    it("leaves an absent count absent unless memory turns on", async () => {
        installMemoryCharacter({ supaMemory: false });
        const api = await makeApi();
        const copy = await api.getCharacterFromIndex(0);
        await api.setCharacterToIndex(0, { ...copy, desc: "edited", supaMemoryOnCount: 5 });
        expect(stored().desc).toBe("edited");
        expect("supaMemoryOnCount" in stored()).toBe(false);
        await api.setCharacterToIndex(0, { ...copy, supaMemory: true, supaMemoryOnCount: 5 });
        expect(stored().supaMemoryOnCount).toBe(1);
    });

    it("counts a turn-on from a characters list (setDatabaseLite)", async () => {
        installMemoryCharacter({ supaMemory: false, supaMemoryOnCount: 2 });
        const api = await makeApi();
        const copy = await api.getCharacterFromIndex(0);
        await api.setDatabaseLite({ characters: [{ ...copy, supaMemory: true, supaMemoryOnCount: 2 }] });
        expect(stored().supaMemory).toBe(true);
        expect(stored().supaMemoryOnCount).toBe(3);
    });
});

// `TerminalNotice.svelte` stops only bubbling, so a plugin's capture-phase key listener on
// `document` ran before it; no plugin key listener gets a key while the terminal notice (the
// restore notice) is shown.
describe("v3 document key listeners and the terminal notice", () => {
    beforeEach(() => {
        installDatabase({ characters: [], pluginCustomStorage: undefined });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    const press = (key: string) =>
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    // The key listeners are delivered after a random delay below 100 ms: past it on fake timers.
    const settle = () => vi.advanceTimersByTimeAsync(100);

    it("delivers no key to a capture or bubbling listener while the notice is shown", async () => {
        const api = await makeApi();
        const root = await api.getRootDocument();
        const captured: string[] = [];
        const bubbled: string[] = [];
        const captureId = await root.addEventListener("keydown", (event: any) => captured.push(event.key), true);
        const bubbleId = await root.addEventListener("keydown", (event: any) => bubbled.push(event.key));
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            const notice = alertTerminal("restored");
            expect(terminalNoticeShown()).toBe(true);
            press("s");
            press("Enter");
            await settle();
            expect(captured).toEqual([]);
            expect(bubbled).toEqual([]);

            acknowledgeTerminalNotice();
            await notice;
            expect(terminalNoticeShown()).toBe(false);
            press("a");
            await settle();
            expect(captured).toEqual(["a"]);
            expect(bubbled).toEqual(["a"]);
        } finally {
            root.removeEventListener("keydown", captureId, true);
            root.removeEventListener("keydown", bubbleId);
        }
    });
});
