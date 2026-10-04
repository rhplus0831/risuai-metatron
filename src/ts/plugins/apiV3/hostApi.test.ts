import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The v3 host API used to borrow its `setDatabase`/`setDatabaseLite` and
// `safeLocalStorage` implementations from the removed API 2.1 layer. They now
// live in `v3.svelte.ts`. These tests pin the contracts the move must keep:
// - `setDatabaseLite`/`setDatabase` route each `allowedDbKeys` key to the
//   mutation that owns it on the live database (a forwarded key such as
//   `temperature` into the selected preset) and every other key to the top
//   level of `pluginCustomStorage`, without touching the v3 `_pluginStorage`
//   sub-object. The removed `pluginV2` key is no longer an allowed key, so it
//   lands in custom storage too.
// - neither setter calls the whole-database normalizer `setDatabase` of
//   `database.svelte` (Phase 4: each routed value is checked by its owner).
// - the `_*SafeLocalStorage` aliases work when called detached, which is how
//   the sandbox RPC (`CALL_ROOT` does `fn(...args)`) invokes them. `key` and
//   `clear` used to be exported unbound and threw on `this`.

type CapturedApi = Record<string, (...args: any[]) => any>;

const { captured, dbMocks } = vi.hoisted(() => ({
    captured: { api: null as CapturedApi | null },
    dbMocks: {
        setDatabase: vi.fn(),
    },
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

vi.mock("src/ts/storage/database.svelte", async () => {
    // The live database, as in the app (the mutations the setters route to write `DBState.db`);
    // resolved here because the factory runs before this file's own imports are initialized.
    // The whole-database normalizer `setDatabase` is a spy only to assert it is no longer called.
    const stores = await vi.importActual<typeof import("src/ts/stores.svelte")>("src/ts/stores.svelte");
    return {
        getDatabase: () => stores.DBState.db,
        setDatabase: dbMocks.setDatabase,
        getCurrentCharacter: vi.fn(),
        getCurrentChat: vi.fn(),
        setCurrentChat: vi.fn(),
    };
});

vi.mock("src/ts/globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    getFetchLogs: vi.fn(() => []),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    forageStorage: { getItem: vi.fn(), setItem: vi.fn(), keys: vi.fn(async () => []) },
    saveAsset: vi.fn(),
    readImage: vi.fn(),
    getFileSrc: vi.fn(),
    downloadFile: vi.fn(),
}));

vi.mock("src/ts/alert", () => ({
    alertConfirm: vi.fn(async () => true),
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertMd: vi.fn(),
    alertStore: { set: vi.fn(), subscribe: vi.fn() },
}));

// The real parser module installs a module-level `$effect.root` that reads
// `selIdState` from `stores.svelte`, which is still uninitialized here because
// the two modules import each other. Nothing under test parses CBS.
vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
}));

import { DBState } from "src/ts/stores.svelte";
import { installForwarding } from "src/ts/storage/forwarding.svelte";
import { initializeRecords, takeRecordFields } from "src/ts/storage/records.svelte";
import { selection, selectPersona, selectPreset } from "src/ts/storage/selection.svelte";
import { executePluginV3 } from "./v3.svelte";

/**
 * A live database with the forwarding accessors installed, as `setDatabaseLite` installs them in
 * the app (its record fields moved into the records first, the whole set replaced): a forwarded
 * key such as `temperature` reads and writes the selected preset (`preset`, selected here), and
 * `selectedPersona` reads this client's persona selection.
 */
function forwardedDatabase(fields: Record<string, unknown>) {
    selectPreset("preset");
    const raw: Record<string, unknown> = { botPresets: [{ id: "preset", name: "P", temperature: 0 }], ...fields };
    initializeRecords(takeRecordFields(raw));
    return installForwarding(raw) as any;
}

const selectedPresetOf = (db: any) => db.botPresets.find((preset: { id: string }) => preset.id === "preset");

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
        DBState.db = forwardedDatabase({ characters: [], pluginCustomStorage: undefined });
        dbMocks.setDatabase.mockClear();
    });

    it("setDatabaseLite assigns allowed keys and routes the rest into pluginCustomStorage", async () => {
        const api = await makeApi();

        api.setDatabaseLite({
            characters: [{ name: "c" }],
            custom: { x: 1 },
            pluginV2: [{ name: "old" }],
        });

        // `characters` is reconciled on the live mirror: a new character is added with a `chaId` and
        // ids for its chats (a default chat when it has none), usable at once.
        expect(DBState.db.characters).toEqual([
            {
                name: "c",
                chaId: expect.any(String),
                chatPage: 0,
                chats: [{ id: expect.any(String), message: [], note: "", name: "Chat 1", localLore: [], fmIndex: -1 }],
            },
        ]);
        expect(DBState.db.pluginCustomStorage).toEqual({ custom: { x: 1 }, pluginV2: [{ name: "old" }] });
        expect("custom" in DBState.db).toBe(false);
        expect("pluginV2" in DBState.db).toBe(false);
        expect(dbMocks.setDatabase).not.toHaveBeenCalled();
    });

    it("setDatabase routes the same way, a forwarded key into the selected preset, without the normalizing setDatabase", async () => {
        const api = await makeApi();

        await api.setDatabase({ temperature: 80, custom: "v" });

        expect(selectedPresetOf(DBState.db).temperature).toBe(80);
        expect(DBState.db.temperature).toBe(80);
        expect(DBState.db.pluginCustomStorage).toEqual({ custom: "v" });
        expect(dbMocks.setDatabase).not.toHaveBeenCalled();
    });

    it("keeps existing ids, gives a persona without an id one, and drops non-object entries (Phase 3 slice 6)", async () => {
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
        api.setDatabaseLite({ personas });
        const lite = DBState.db.personas as any[];
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
        const full = DBState.db.personas as any[];
        expect(full).toHaveLength(1);
        expect(full[0].id.length).toBeGreaterThan(0);
        expect(dbMocks.setDatabase).not.toHaveBeenCalled();
    });

    it("keeps the v3 _pluginStorage sub-object next to routed custom keys", async () => {
        DBState.db.pluginCustomStorage = { _pluginStorage: { k: 1 } };
        const api = await makeApi();

        api.setDatabaseLite({ custom: 1 });
        await api.setDatabase({ other: 2 });

        expect(DBState.db.pluginCustomStorage).toEqual({ _pluginStorage: { k: 1 }, custom: 1, other: 2 });
        expect(await api._getPluginStorage("k")).toBe(1);
    });
});

// Phase 3, slice 4 (Astra challenge point 3): the sections, the collections, and the two selection
// ids are normalized by the server, and the client applies no default to them any more, so no
// setter repairs a `null` or `undefined` a plugin writes there. Both setters refuse such a write
// (through the owning mutation, with a warning) and keep the value. A forwarded preset field is
// checked the same way by `updateSettings` (a `null` is refused where the field has no `null`
// value); a malformed non-null section value still goes through: the server repairs it on write.
describe("v3 setDatabase / setDatabaseLite against server-normalized fields", () => {
    const personas = [{ id: "p", name: "P", icon: "", personaPrompt: "", note: "", largePortrait: false }];

    beforeEach(() => {
        selectPersona("p");
        DBState.db = forwardedDatabase({
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
        dbMocks.setDatabase.mockClear();
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("keeps a section, collection, or selection field when a plugin writes null or undefined, and warns", async () => {
        const api = await makeApi();

        api.setDatabaseLite({ askRemoval: null, personas: undefined, customCSS: null, theme: undefined });
        expect(DBState.db.askRemoval).toBe(true);
        expect(DBState.db.personas).toEqual(personas);
        expect(DBState.db.customCSS).toBe("");
        expect(DBState.db.theme).toBe("");
        expect(console.warn).toHaveBeenCalledTimes(4);
        expect(vi.mocked(console.warn).mock.calls[0][0]).toContain("askRemoval");

        await api.setDatabase({ characterOrder: null, personas: null, askRemoval: undefined });
        expect(DBState.db.characterOrder).toEqual(["c"]);
        expect(DBState.db.personas).toEqual(personas);
        expect(DBState.db.askRemoval).toBe(true);
        expect(dbMocks.setDatabase).not.toHaveBeenCalled();
        // Nothing lands in the custom storage either: the key is known, only its value is refused
        // (and the setters no longer create an empty dictionary when no custom key is sent).
        expect(DBState.db.pluginCustomStorage).toBeUndefined();
    });

    it("refuses null in a non-nullable forwarded preset field and an index that names no persona, and warns", async () => {
        const api = await makeApi();
        // A second persona, selected, so an unchanged selection is told apart from the fallback to the first.
        DBState.db.personas = [...personas, { ...personas[0], id: "q", name: "Q" }];
        selectPersona("q");
        expect(DBState.db.selectedPersona).toBe(1);

        api.setDatabaseLite({ temperature: null, selectedPersona: undefined });
        expect(selectedPresetOf(DBState.db).temperature).toBe(0);
        expect(DBState.db.temperature).toBe(0);
        expect(DBState.db.selectedPersona).toBe(1);
        expect(selection.personaId).toBe("q");
        expect(console.warn).toHaveBeenCalledTimes(2);
        expect(vi.mocked(console.warn).mock.calls[0][0]).toMatch(
            /^\[Plugin\] Refused the database key temperature; the previous value was kept: /,
        );
        expect(vi.mocked(console.warn).mock.calls[1][0]).toMatch(
            /^\[Plugin\] Refused the database key selectedPersona; the previous value was kept: /,
        );

        await api.setDatabase({ temperature: null });
        expect(selectedPresetOf(DBState.db).temperature).toBe(0);
        expect(console.warn).toHaveBeenCalledTimes(3);
        expect(dbMocks.setDatabase).not.toHaveBeenCalled();
    });

    it("accepts a non-null value of a server-normalized field as-is (the server repairs a malformed one on write)", async () => {
        const api = await makeApi();
        api.setDatabaseLite({ askRemoval: "yes", customCSS: ".x {}", theme: "dark" });
        expect(DBState.db.askRemoval).toBe("yes");
        expect(DBState.db.customCSS).toBe(".x {}");
        expect(DBState.db.theme).toBe("dark");
        expect(console.warn).not.toHaveBeenCalled();
        await api.setDatabase({ askRemoval: false });
        expect(DBState.db.askRemoval).toBe(false);
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
        DBState.db = { characters: liveCharacters(), pluginCustomStorage: undefined } as any;
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
        api.setDatabaseLite({ characters: [liveCharacters()[1]] });
        expect(DBState.db.characters.map((character: any) => character.chaId)).toEqual(["c", "d"]);
        expect(chatStore.isMessageLocked(refK, "a")).toBe(true);
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/removal was skipped/));

        api.setCharacterToIndex(0, { chaId: "other", type: "character", name: "Other", chats: [], chatPage: 0 });
        expect(DBState.db.characters.map((character: any) => character.chaId)).toEqual(["c", "d"]);
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/replacement was skipped/));
        // A character that is not generating can be replaced.
        api.setCharacterToIndex(1, { chaId: "other", type: "character", name: "Other", chats: [], chatPage: 0 });
        expect(DBState.db.characters.map((character: any) => character.chaId)).toEqual(["c", "other"]);
    });

    it("refuses a character list with duplicate ids before changing anything", async () => {
        const api = await makeApi();
        const [c, d] = liveCharacters();
        api.setDatabaseLite({ characters: [{ ...c, name: "renamed" }, d, { ...c, name: "again" }] });
        expect(DBState.db.characters.map((character: any) => [character.chaId, character.name])).toEqual([
            ["c", "C"],
            ["d", "D"],
        ]);
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/duplicate chaId/));
        expect(chatStore.isMessageLocked(refK, "a")).toBe(true);
    });

    it("setChatToIndex skips a chat change that touches the generating message, and applies one that does not", async () => {
        const api = await makeApi();
        const current = api.getChatFromIndex(0, 0);
        api.setChatToIndex(0, 0, {
            ...current,
            note: "plugin note",
            message: [message("a", "rewritten by the plugin"), current.message[1]],
        });
        expect(chatStore.findChat(refK)!.message[0].data).toBe("reply so far");
        expect((chatStore.findChat(refK) as any).note).toBe("");
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/message being generated/), expect.anything());

        api.setChatToIndex(0, 0, {
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
        DBState.db = {
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
        } as any;
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("gives a character added by a list, with or without a chaId, chat and message ids at once, and keeps the existing ones", async () => {
        const api = await makeApi();
        const existing = JSON.parse(JSON.stringify(DBState.db.characters));
        api.setDatabaseLite({
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
        const [c, d, n, w] = DBState.db.characters as any[];
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
        const existing = JSON.parse(JSON.stringify(DBState.db.characters));
        const twice = { name: "alias", chats: [] };
        api.setDatabaseLite({ characters: [...existing, twice, twice] });
        expect(DBState.db.characters.map((character: any) => character.chaId)).toEqual(["c", "d"]);
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/duplicate chaId/));
        // The same object once is an ordinary new character.
        api.setDatabaseLite({ characters: [...existing, twice] });
        expect(DBState.db.characters.map((character: any) => character.name)).toEqual(["C", "D", "alias"]);
    });

    it("normalizes a replacement character in setCharacterToIndex, and skips one whose chaId another character has", async () => {
        const api = await makeApi();
        api.setCharacterToIndex(1, {
            name: "replacement",
            chats: [{ message: [], note: "", name: "R", localLore: [] }],
        });
        const r = DBState.db.characters[1] as any;
        expect(typeof r.chaId).toBe("string");
        expect(r.chaId).not.toBe("d");
        expect(typeof r.chats[0].id).toBe("string");
        expect(r.chatPage).toBe(0);
        expect(chatStore.findChat({ chaId: r.chaId, chatId: r.chats[0].id })).toBeDefined();

        api.setCharacterToIndex(1, { chaId: "c", type: "character", name: "a copy of c", chats: [], chatPage: 0 });
        expect(DBState.db.characters.map((character: any) => character.chaId)).toEqual(["c", r.chaId]);
        expect((DBState.db.characters[1] as any).name).toBe("replacement");
        expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/another character already has/));
    });
});
