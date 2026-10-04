import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 4, slice 2 (`plugin-host-setters`): the v3 `setDatabase` and `setDatabaseLite` host setters
// route every `allowedDbKeys` key to the mutation that owns it, on the live `DBState.db` as the app
// runs it (the forwarding accessors installed, two presets, the real character, collection, and
// plugin storage mutations). Pinned here:
// - the routing table: each of the 23 keys lands in its owner through both setters (a forwarded key
//   in the selected preset by id, a section key at the root and in no preset, the collections
//   through their mutations), and every other key at the top level of `pluginCustomStorage`;
// - the key order: `characterOrder` is applied after `characters` and `selectedPersona` last,
//   whatever the object's key order, so an explicit order survives the additions of the same call
//   (Astra challenge point 1) and a persona index names a persona of the list the same call sets;
// - the per-key contract (A14): a refused value (`MutationValidationError`) is warned about and keeps
//   the previous mirror value while the other keys land; a `characters` or `plugins` list is
//   preflighted whole; a gone preset (`MutationTargetGoneError`) and an unexpected error propagate;
// - the full setter's `plugins`: the installed plugins stay, the user is asked once per new plugin,
//   a denial installs nothing, and a malformed list asks nothing;
// - a reserved storage namespace a plugin replaced with a list stays readable, enumerable, and
//   writable without losing an entry (Astra challenge point 2), own `constructor`/`__proto__` keys
//   included;
// - `setArg`/`setArgument` and the theme APIs go through the mutations; an unknown color scheme name
//   changes nothing.

type CapturedApi = Record<string, (...args: any[]) => any>;

const { captured, alerts } = vi.hoisted(() => ({
    captured: { api: null as CapturedApi | null },
    alerts: { confirm: vi.fn(async (_text: string) => true) },
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
    // The live database (the mutations write `DBState.db`); resolved here because the factory runs
    // before this file's own imports are initialized.
    const stores = await vi.importActual<typeof import("src/ts/stores.svelte")>("src/ts/stores.svelte");
    return {
        getDatabase: () => stores.DBState.db,
        setDatabase: vi.fn(),
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
    alertConfirm: alerts.confirm,
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertMd: vi.fn(),
    alertStore: { set: vi.fn(), subscribe: vi.fn() },
}));

// The module-update effect of `stores.svelte.ts` tracks `enabledModules`; nothing here needs modules.
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));

// The real parser module installs a module-level `$effect.root` over `selIdState`, which is still
// uninitialized here because the two modules import each other. Nothing under test parses CBS.
vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
}));

// The plugin `getDatabase` needs the `db` permission: granted, so no prompt and no grant record.
vi.mock("./permissionStore", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./permissionStore")>()),
    hasPermissionGrant: () => true,
    getLastGrantTime: () => Date.now(),
    recordPermissionGrants: vi.fn(async () => undefined),
}));

import { DBState, selectedCharID } from "src/ts/stores.svelte";
import * as chatStore from "src/ts/storage/chatStore.svelte";
import { checkCharOrder } from "src/ts/storage/characterOrder";
import { installForwarding } from "src/ts/storage/forwarding.svelte";
import { initializeRecords, takeRecordFields } from "src/ts/storage/records.svelte";
import { MutationTargetGoneError } from "src/ts/storage/mutationValidation";
import { selection, selectPersona, selectPreset } from "src/ts/storage/selection.svelte";
import { executePluginV3 } from "./v3.svelte";

const db = () => DBState.db as any;
const preset = (id: string) => db().botPresets.find((entry: { id: string }) => entry.id === id);
/** A plain copy (a Svelte proxy compares differently, and an own `__proto__` key survives JSON). */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const ids = () => db().characters.map((character: any) => character.chaId);
/** The `[Plugin]` warnings (the full setter's pre-existing `[WARN] Plugin attempted to access plugin directly` line is left out). */
const warnings = () =>
    vi
        .mocked(console.warn)
        .mock.calls.map((call) => String(call[0]))
        .filter((text) => text.startsWith("[Plugin]"));

const personas = [
    { id: "p", name: "P", icon: "", personaPrompt: "", note: "", largePortrait: false },
    { id: "q", name: "Q", icon: "", personaPrompt: "", note: "", largePortrait: false },
];
const lightScheme = {
    bgcolor: "#ffffff",
    darkbg: "#f0f0f0",
    borderc: "#0f172a",
    selected: "#e0e0e0",
    draculared: "#ff5555",
    textcolor: "#0f172a",
    textcolor2: "#64748b",
    darkBorderc: "#d1d5db",
    darkbutton: "#e5e7eb",
    type: "light",
};
const chat = (id: string, message: any[] = []) => ({ id, name: id.toUpperCase(), note: "", localLore: [], message });
/** A character as the mirror holds it (its chats with ids). */
const character = (chaId: string, name: string, chats = [chat(`k${chaId}`)]) => ({
    chaId,
    type: "character",
    name,
    chatPage: 0,
    chats,
});
/** A character as a plugin hands one in (chats without ids, or none). */
const incoming = (chaId: string, name: string) => ({ chaId, name, chats: [] });

/**
 * A live database with the forwarding accessors installed, as `setDatabaseLite` installs them in
 * the app (its record fields moved into the records first, the whole set replaced): two presets (`a` selected), two personas (`p` selected), and the fields the routed keys
 * write, so an unchanged value is told apart from a missing one.
 */
function liveDatabase(fields: Record<string, unknown> = {}) {
    selectPreset("a");
    selectPersona("p");
    const raw: Record<string, unknown> = {
        botPresets: [
            { id: "a", name: "A" },
            { id: "b", name: "B" },
        ],
        personas: plain(personas),
        characters: [],
        characterOrder: [],
        plugins: [],
        modules: [],
        enabledModules: [],
        pluginCustomStorage: undefined,
        askRemoval: true,
        theme: "",
        textTheme: "standard",
        lineHeight: 1,
        customCSS: "",
        guiHTML: "",
        colorSchemeName: "default",
        colorScheme: plain(lightScheme),
        customColorScheme: undefined,
        customTextTheme: undefined,
        seperateModels: { memory: "" },
        seperateModelsForAxModels: false,
        ...fields,
    };
    initializeRecords(takeRecordFields(raw));
    return installForwarding(raw) as any;
}

async function makeApi(name = `routing-test-${Math.random().toString(36).slice(2)}`): Promise<CapturedApi> {
    captured.api = null;
    await executePluginV3({ name, script: "", version: "3.0" } as any);
    expect(captured.api).not.toBeNull();
    return captured.api!;
}

beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    DBState.db = liveDatabase();
    selectedCharID.set(-1);
    alerts.confirm.mockReset();
    alerts.confirm.mockResolvedValue(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("the routing table: settings keys", () => {
    it.each([
        ["moduleIntergration", "m1", "m2"],
        ["temperature", 11, 12],
        ["maxContext", 1001, 1002],
        ["maxResponse", 301, 302],
        ["frequencyPenalty", 1, 2],
        ["PresensePenalty", 3, 4],
    ] as const)("%s lands in the selected preset by id, through both setters", async (key, lite, full) => {
        const api = await makeApi();
        api.setDatabaseLite({ [key]: lite });
        expect(preset("a")[key]).toBe(lite);
        expect(preset("b")[key]).toBeUndefined();
        expect(db()[key]).toBe(lite);
        expect(db().pluginCustomStorage).toBeUndefined();

        // The full setter writes the preset selected then: `b` after a switch, and `a` keeps its value.
        selectPreset("b");
        await api.setDatabase({ [key]: full });
        expect(preset("b")[key]).toBe(full);
        expect(preset("a")[key]).toBe(lite);
        expect(db()[key]).toBe(full);
        expect(console.warn).not.toHaveBeenCalled();
    });

    it.each([
        ["askRemoval", false, true],
        ["theme", "t1", "t2"],
        ["textTheme", "highcontrast", "standard"],
        ["lineHeight", 1.4, 1.6],
        ["customCSS", ".a {}", ".b {}"],
        ["guiHTML", "<a></a>", "<b></b>"],
        ["colorSchemeName", "light", "dark"],
        ["seperateModels", { memory: "m1" }, { memory: "m2" }],
        ["seperateModelsForAxModels", true, false],
    ] as const)(
        "%s lands in its section at the root and in no preset, through both setters",
        async (key, lite, full) => {
            const api = await makeApi();
            api.setDatabaseLite({ [key]: lite });
            expect(plain(db()[key])).toEqual(lite);
            await api.setDatabase({ [key]: full });
            expect(plain(db()[key])).toEqual(full);
            expect(db().botPresets.every((entry: object) => !(key in entry))).toBe(true);
            expect(db().pluginCustomStorage).toBeUndefined();
            expect(console.warn).not.toHaveBeenCalled();
        },
    );
});

describe("the routing table: collections, the selection, and custom keys", () => {
    it("modules and enabledModules go through setModules and setEnabledModules", async () => {
        const api = await makeApi();
        api.setDatabaseLite({ modules: [{ name: "lite" }], enabledModules: ["x", "x", "y"] });
        expect(db().modules).toEqual([{ name: "lite", id: expect.any(String) }]);
        expect(db().enabledModules).toEqual(["x", "y"]);
        await api.setDatabase({ modules: [{ id: "keep", name: "full" }], enabledModules: ["keep"] });
        expect(db().modules).toEqual([{ id: "keep", name: "full" }]);
        expect(db().enabledModules).toEqual(["keep"]);
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("personas go through setPersonas (the collection's contract), through both setters", async () => {
        const api = await makeApi();
        api.setDatabaseLite({ personas: [{ name: "lite", icon: "", personaPrompt: "" }] });
        expect(db().personas).toEqual([
            { name: "lite", icon: "", personaPrompt: "", note: "", id: expect.any(String) },
        ]);
        await api.setDatabase({ personas: [{ id: "f", name: "full", icon: "", personaPrompt: "", note: "n" }] });
        expect(db().personas).toEqual([{ id: "f", name: "full", icon: "", personaPrompt: "", note: "n" }]);
        expect(selection.personaId).toBe("f");
    });

    it("selectedPersona selects by id in the list the same call sets, whatever the key order", async () => {
        const api = await makeApi();
        const list = [
            { id: "n0", name: "N0", icon: "", personaPrompt: "" },
            { id: "n1", name: "N1", icon: "", personaPrompt: "" },
        ];
        api.setDatabaseLite({ selectedPersona: 1, personas: list });
        expect(selection.personaId).toBe("n1");
        expect(db().selectedPersona).toBe(1);

        await api.setDatabase({ personas: [...list].reverse(), selectedPersona: 1 });
        expect(selection.personaId).toBe("n0");
        expect(db().selectedPersona).toBe(1);

        // An index naming no persona of the new list is refused; the selection resolved by
        // `setPersonas` (the same id, still present) stays.
        api.setDatabaseLite({ selectedPersona: 5, personas: list });
        expect(selection.personaId).toBe("n0");
        expect(warnings()).toEqual([expect.stringMatching(/^\[Plugin\] Refused the database key selectedPersona;/)]);
    });

    it("plugins go through setPlugins in the lite setter (the whole list, no prompt)", async () => {
        DBState.db.plugins = [{ name: "installed", script: "s", version: "3.0", realArg: {} }] as any;
        const api = await makeApi();
        api.setDatabaseLite({ plugins: [{ name: "lite", script: "l", version: "3.0" }] });
        expect(db().plugins).toEqual([{ name: "lite", script: "l", version: "3.0" }]);
        expect(alerts.confirm).not.toHaveBeenCalled();
    });

    it("pluginCustomStorage replaces the whole object through both setters, and a list is refused", async () => {
        DBState.db.pluginCustomStorage = { old: 1, _pluginStorage: { k: 1 } };
        const api = await makeApi();
        api.setDatabaseLite({ pluginCustomStorage: { lite: true } });
        expect(plain(db().pluginCustomStorage)).toEqual({ lite: true });
        await api.setDatabase({ pluginCustomStorage: { _pluginStorage: { full: 1 } } });
        expect(plain(db().pluginCustomStorage)).toEqual({ _pluginStorage: { full: 1 } });
        expect(await api._getPluginStorage("full")).toBe(1);
        api.setDatabaseLite({ pluginCustomStorage: ["nope"] });
        expect(plain(db().pluginCustomStorage)).toEqual({ _pluginStorage: { full: 1 } });
        expect(warnings()).toEqual([
            expect.stringMatching(/^\[Plugin\] Refused the database key pluginCustomStorage;/),
        ]);
    });

    it("characterOrder goes through setCharacterOrder, and a malformed order is refused", async () => {
        DBState.db.characters = [character("c", "C"), character("d", "D")] as any;
        DBState.db.characterOrder = ["c", "d"] as any;
        const api = await makeApi();
        api.setDatabaseLite({ characterOrder: ["d", "c"] });
        expect(plain(db().characterOrder)).toEqual(["d", "c"]);
        await api.setDatabase({ characterOrder: [{ id: "f", name: "F", color: "", data: ["c", "d"] }] });
        expect(plain(db().characterOrder)).toEqual([{ id: "f", name: "F", color: "", data: ["c", "d"] }]);
        api.setDatabaseLite({ characterOrder: ["c", 5] });
        expect(plain(db().characterOrder)).toEqual([{ id: "f", name: "F", color: "", data: ["c", "d"] }]);
        expect(warnings()).toEqual([expect.stringMatching(/^\[Plugin\] Refused the database key characterOrder;/)]);
    });

    it("a key outside allowedDbKeys lands at the top level of pluginCustomStorage, and undefined removes it", async () => {
        const api = await makeApi();
        api.setDatabaseLite({ custom: { x: 1 }, pluginV2: [] });
        await api.setDatabase({ other: "o" });
        expect(plain(db().pluginCustomStorage)).toEqual({ custom: { x: 1 }, pluginV2: [], other: "o" });
        expect("custom" in db()).toBe(false);
        api.setDatabaseLite({ custom: undefined, never: undefined });
        expect(plain(db().pluginCustomStorage)).toEqual({ pluginV2: [], other: "o" });
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("the plugin getDatabase snapshot holds a forwarded key's value from the selected preset", async () => {
        const api = await makeApi();
        await api.setDatabase({ temperature: 42 });
        selectPreset("b");
        preset("b").temperature = 7;
        const snapshot = await api.getDatabase(["temperature", "theme"]);
        expect(snapshot).toEqual({ temperature: 7, theme: "" });
        selectPreset("a");
        expect((await api.getDatabase(["temperature"])).temperature).toBe(42);
    });
});

describe("characters through the character mutations", () => {
    beforeEach(() => {
        DBState.db.characters = [character("c", "C"), character("d", "D")] as any;
        DBState.db.characterOrder = ["c", "d"] as any;
    });

    it("a reordered list keeps the mirror order, appends a new character, and removes an omitted one (both setters)", async () => {
        const api = await makeApi();
        api.setDatabaseLite({ characters: [character("d", "D"), character("c", "C2"), incoming("e", "E")] });
        expect(ids()).toEqual(["c", "d", "e"]);
        expect(db().characters[0].name).toBe("C2");
        expect(db().characters[2].chats).toHaveLength(1);
        expect(plain(db().characterOrder)).toEqual(["c", "d", "e"]);

        // An omission removes; the selection follows its character (`d` at index 1 stays selected at 0).
        selectedCharID.set(1);
        await api.setDatabase({ characters: [character("e", "E"), character("d", "D")] });
        expect(ids()).toEqual(["d", "e"]);
        expect(get(selectedCharID)).toBe(0);
        expect(plain(db().characterOrder)).toEqual(["d", "e"]);
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("refuses the whole list when the last entry is malformed, so the earlier entries stay unapplied", async () => {
        const api = await makeApi();
        for (const bad of [
            { chaId: 5, name: "bad id" },
            { name: "bad chats", chats: [{ message: "no" }] },
            { name: "bad type", type: "person" },
            "not an object",
        ]) {
            api.setDatabaseLite({ characters: [character("c", "renamed"), incoming("e", "E"), bad] });
        }
        await api.setDatabase({ characters: [character("c", "renamed"), incoming("e", "E"), { chaId: 5 }] });
        expect(ids()).toEqual(["c", "d"]);
        expect(db().characters[0].name).toBe("C");
        expect(warnings()).toHaveLength(5);
        expect(warnings().every((text) => /Refused the database key characters;.*characters\[2\]/.test(text))).toBe(
            true,
        );
    });

    it("a non-list characters value is refused with a warning, while the other keys land", async () => {
        const api = await makeApi();
        api.setDatabaseLite({ theme: "before", characters: { chaId: "c" }, customCSS: "after" });
        expect(ids()).toEqual(["c", "d"]);
        expect(db().theme).toBe("before");
        expect(db().customCSS).toBe("after");
        expect(warnings()).toEqual([expect.stringMatching(/^\[Plugin\] Refused the database key characters;/)]);
    });
});

describe("characterOrder is applied after characters (Astra challenge point 1)", () => {
    const folder = (data: string[]) => ({ id: "f", name: "F", color: "", data });

    it("an explicit order of ids the same call adds survives, with the order key first or last (both setters)", async () => {
        const api = await makeApi();
        api.setDatabaseLite({ characterOrder: ["b", "a"], characters: [incoming("a", "A"), incoming("b", "B")] });
        expect(ids()).toEqual(["a", "b"]);
        expect(plain(db().characterOrder)).toEqual(["b", "a"]);

        const [a, b] = plain(db().characters);
        await api.setDatabase({
            characters: [incoming("d", "D"), a, incoming("c", "C"), b],
            characterOrder: ["d", "c", "b", "a"],
        });
        expect(ids()).toEqual(["a", "b", "d", "c"]);
        expect(plain(db().characterOrder)).toEqual(["d", "c", "b", "a"]);
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("folder membership of added characters survives", async () => {
        const api = await makeApi();
        api.setDatabaseLite({
            characterOrder: [folder(["b", "a"])],
            characters: [incoming("a", "A"), incoming("b", "B")],
        });
        expect(plain(db().characterOrder)).toEqual([folder(["b", "a"])]);
        await api.setDatabase({
            characterOrder: [folder(["c"]), "a", "b"],
            characters: [incoming("a", "A"), incoming("b", "B"), incoming("c", "C")],
        });
        expect(plain(db().characterOrder)).toEqual([folder(["c"]), "a", "b"]);
        expect(ids()).toEqual(["a", "b", "c"]);
    });

    it("additions and omissions in one call: the persisted order is the explicit one, the mirror keeps its order", async () => {
        DBState.db.characters = [character("c", "C"), character("d", "D")] as any;
        DBState.db.characterOrder = ["c", "d"] as any;
        const api = await makeApi();
        api.setDatabaseLite({ characterOrder: ["e", "d"], characters: [character("d", "D"), incoming("e", "E")] });
        expect(ids()).toEqual(["d", "e"]);
        expect(plain(db().characterOrder)).toEqual(["e", "d"]);
    });

    it("a generating character omitted from the list stays in the mirror; the order is the explicit one until the next repair", async () => {
        const refK = { chaId: "c", chatId: "kc" };
        DBState.db.characters = [
            character("c", "C", [chat("kc", [{ role: "char", data: "so far", chatId: "m" }])]),
            character("d", "D"),
        ] as any;
        DBState.db.characterOrder = ["c", "d"] as any;
        chatStore.applyServerGeneration(refK, {
            jobId: "J",
            messageId: "m",
            generationId: "g",
            text: "so far",
            seq: 0,
        });
        try {
            const api = await makeApi();
            api.setDatabaseLite({ characterOrder: ["d"], characters: [character("d", "D")] });
            expect(ids()).toEqual(["c", "d"]);
            expect(plain(db().characterOrder)).toEqual(["d"]);
            expect(warnings()).toEqual([expect.stringMatching(/removal was skipped/)]);
            checkCharOrder();
            expect(plain(db().characterOrder)).toEqual(["d", "c"]);
        } finally {
            chatStore.endServerJob("J");
        }
    });

    it("a refused order leaves the characters applied, and their added ids repaired into the old order", async () => {
        DBState.db.characters = [character("c", "C")] as any;
        DBState.db.characterOrder = ["c"] as any;
        const api = await makeApi();
        api.setDatabaseLite({ characterOrder: "c,e", characters: [character("c", "C"), incoming("e", "E")] });
        expect(ids()).toEqual(["c", "e"]);
        expect(plain(db().characterOrder)).toEqual(["c", "e"]);
        expect(warnings()).toEqual([expect.stringMatching(/^\[Plugin\] Refused the database key characterOrder;/)]);
    });
});

describe("the per-key contract (A14)", () => {
    it("a refused key between two valid keys keeps its previous value while both valid keys land (both setters)", async () => {
        const api = await makeApi();
        api.setDatabaseLite({ theme: "lite", temperature: "hot", customCSS: "lite css" });
        expect(db().theme).toBe("lite");
        expect(db().customCSS).toBe("lite css");
        expect(preset("a").temperature).toBeUndefined();
        expect(warnings()).toEqual([
            expect.stringMatching(/^\[Plugin\] Refused the database key temperature; the previous value was kept: /),
        ]);

        await api.setDatabase({ lineHeight: 2, personas: "nope", guiHTML: "<g></g>", askRemoval: null, modules: [] });
        expect(db().lineHeight).toBe(2);
        expect(db().guiHTML).toBe("<g></g>");
        expect(db().personas).toEqual(personas);
        expect(db().askRemoval).toBe(true);
        expect(db().modules).toEqual([]);
        expect(warnings().slice(1)).toEqual([
            expect.stringMatching(/^\[Plugin\] Refused the database key personas;/),
            expect.stringMatching(/^\[Plugin\] Refused the database key askRemoval;/),
        ]);
    });

    it("a preset field written while the selected preset is gone throws MutationTargetGoneError to the plugin", async () => {
        const api = await makeApi();
        selectPreset("gone");
        expect(() => api.setDatabaseLite({ theme: "first", temperature: 1 })).toThrow(MutationTargetGoneError);
        expect(db().theme).toBe("first");
        await expect(api.setDatabase({ temperature: 2 })).rejects.toBeInstanceOf(MutationTargetGoneError);
        expect(preset("a").temperature).toBeUndefined();
        expect(preset("b").temperature).toBeUndefined();
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("an error that is not a refusal propagates to the plugin instead of being warned about", async () => {
        const api = await makeApi();
        // A mirror whose character list is not a list: the character routing fails past its checks.
        DBState.db.characters = "broken" as any;
        expect(() => api.setDatabaseLite({ characters: [incoming("e", "E")] })).toThrow(TypeError);
        await expect(api.setDatabase({ characters: [incoming("e", "E")] })).rejects.toThrow(TypeError);
        expect(console.warn).not.toHaveBeenCalled();
    });
});

describe("the full setter's plugins key", () => {
    const installed = { name: "installed", script: "s", version: "3.0", realArg: {} };
    const newPlugin = (name: string) => ({ name, script: `script of ${name}`, version: "3.0" });

    beforeEach(() => {
        DBState.db.plugins = [plain(installed)] as any;
    });

    it("keeps the installed plugins, asks once for the new one, and appends it", async () => {
        const api = await makeApi();
        await api.setDatabase({ plugins: [installed, newPlugin("new")], theme: "with" });
        expect(alerts.confirm).toHaveBeenCalledTimes(1);
        expect(plain(db().plugins)).toEqual([installed, newPlugin("new")]);
        expect(db().theme).toBe("with");
        // Sent again, the same script asks nothing and changes nothing.
        await api.setDatabase({ plugins: [installed, newPlugin("new")] });
        expect(alerts.confirm).toHaveBeenCalledTimes(1);
        expect(plain(db().plugins)).toEqual([installed, newPlugin("new")]);
    });

    it("a denial installs nothing and the other keys still land", async () => {
        alerts.confirm.mockResolvedValueOnce(false);
        const api = await makeApi();
        await api.setDatabase({ theme: "still", plugins: [newPlugin("denied")], lineHeight: 3 });
        expect(plain(db().plugins)).toEqual([installed]);
        expect(db().theme).toBe("still");
        expect(db().lineHeight).toBe(3);
    });

    it("asks once per new plugin and installs only the confirmed ones", async () => {
        alerts.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const api = await makeApi();
        await api.setDatabase({ plugins: [newPlugin("yes"), newPlugin("no"), installed] });
        expect(alerts.confirm).toHaveBeenCalledTimes(2);
        expect(db().plugins.map((plugin: any) => plugin.name)).toEqual(["installed", "yes"]);
    });

    it("a list with a malformed last entry, or a non-list, asks nothing and keeps the installed plugins", async () => {
        const api = await makeApi();
        await api.setDatabase({ plugins: [newPlugin("valid"), { script: "no name" }], theme: "landed" });
        await api.setDatabase({ plugins: "nope" });
        expect(alerts.confirm).not.toHaveBeenCalled();
        expect(plain(db().plugins)).toEqual([installed]);
        expect(db().theme).toBe("landed");
        expect(warnings()).toEqual([
            expect.stringMatching(/^\[Plugin\] Refused the database key plugins;.*plugins\[1\]/),
            expect.stringMatching(/^\[Plugin\] Refused the database key plugins;.*expected a list/),
        ]);
    });
});

describe("reserved storage namespaces a plugin replaced (Astra challenge point 2)", () => {
    it("a list in _pluginStorage is read by index, listed, removed from, and written to without losing an entry", async () => {
        const api = await makeApi();
        api.setDatabaseLite({ _pluginStorage: ["saved", { deep: true }] });
        expect(await api._getPluginStorage("0")).toBe("saved");
        expect(await api._getPluginStorage("1")).toEqual({ deep: true });
        expect(await api._getPluginStorage("length")).toBeNull();
        expect(await api._keysPluginStorage()).toEqual(["0", "1"]);
        expect(await api._keyPluginStorage(1)).toBe("1");
        expect(await api._lengthPluginStorage()).toBe(2);

        await api._setPluginStorage("2", "next");
        expect(plain(db().pluginCustomStorage._pluginStorage)).toEqual({
            "0": "saved",
            "1": { deep: true },
            "2": "next",
        });
        expect(await api._getPluginStorage("0")).toBe("saved");

        await api._removePluginStorage("1");
        expect(await api._keysPluginStorage()).toEqual(["0", "2"]);
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("a whole pluginCustomStorage with lists in both namespaces keeps every entry through reads and writes", async () => {
        const api = await makeApi();
        await api.setDatabase({ pluginCustomStorage: { _pluginStorage: ["v3"], _safeLocalPluginStorage: ["local"] } });
        const local = api.getLocalPluginStorage();
        expect(await local.getItem("0")).toBe("local");
        expect(await local.keys()).toEqual(["0"]);
        expect(await api._getPluginStorage("0")).toBe("v3");

        await local.setItem("k", 1);
        expect(plain(db().pluginCustomStorage)).toEqual({
            _pluginStorage: ["v3"],
            _safeLocalPluginStorage: { "0": "local", k: 1 },
        });
        await local.removeItem("0");
        expect(await local.keys()).toEqual(["k"]);
        await api._removePluginStorage("0");
        expect(plain(db().pluginCustomStorage)).toEqual({ _pluginStorage: {}, _safeLocalPluginStorage: { k: 1 } });
    });

    it("own constructor and __proto__ entries of a replaced namespace stay readable, writable, and removable", async () => {
        const api = await makeApi();
        api.setDatabaseLite({ _pluginStorage: JSON.parse('{"constructor": 1, "__proto__": 2, "plain": 3}') });
        expect(await api._getPluginStorage("constructor")).toBe(1);
        expect(await api._getPluginStorage("__proto__")).toBe(2);
        expect(await api._getPluginStorage("toString")).toBeNull();
        expect((await api._keysPluginStorage()).sort()).toEqual(["__proto__", "constructor", "plain"]);
        expect(Object.getPrototypeOf(db().pluginCustomStorage._pluginStorage)).toBe(Object.prototype);

        await api._setPluginStorage("constructor", 10);
        await api._setPluginStorage("__proto__", 20);
        expect(await api._getPluginStorage("constructor")).toBe(10);
        expect(await api._getPluginStorage("__proto__")).toBe(20);
        expect(await api._getPluginStorage("plain")).toBe(3);
        expect(Object.getPrototypeOf(db().pluginCustomStorage._pluginStorage)).toBe(Object.prototype);

        await api._removePluginStorage("__proto__");
        await api._removePluginStorage("constructor");
        expect(await api._keysPluginStorage()).toEqual(["plain"]);
        expect(await api._getPluginStorage("constructor")).toBeNull();
    });
});

describe("setArg, setArgument, and the theme APIs", () => {
    it("setArg and setArgument write the plugin's argument through setPluginArgument, and a bad value is refused", async () => {
        DBState.db.plugins = [
            { name: "other", script: "", version: "3.0", realArg: { foo: "bar" } },
            { name: "self", script: "", version: "3.0", realArg: {} },
        ] as any;
        const api = await makeApi("self");
        const argOf = (name: string) => plain(db().plugins.find((plugin: any) => plugin.name === name).realArg);

        api.setArg("other::foo", 3);
        api.setArg("other::added", "x");
        await api.setArgument("mine", "v");
        await api.setArgument("constructor", "own");
        expect(argOf("other")).toEqual({ foo: 3, added: "x" });
        expect(argOf("self")).toEqual({ mine: "v", constructor: "own" });
        expect(console.warn).not.toHaveBeenCalled();

        api.setArg("other::foo", { not: "allowed" } as any);
        await api.setArgument("mine", Number.NaN as any);
        expect(argOf("other").foo).toBe(3);
        expect(argOf("self").mine).toBe("v");
        expect(warnings()).toEqual([
            expect.stringMatching(/^\[Plugin\] Refused the argument other::foo;/),
            expect.stringMatching(/^\[Plugin\] Refused the argument mine;/),
        ]);

        // An unknown plugin name is a no-op.
        api.setArg("missing::foo", 1);
        expect(db().plugins.map((plugin: any) => plugin.name)).toEqual(["other", "self"]);
        expect(warnings()).toHaveLength(2);
    });

    it("changeColorScheme writes the named scheme and its name; an unknown name changes nothing", async () => {
        const api = await makeApi();
        api.changeColorScheme("dark");
        expect(db().colorSchemeName).toBe("dark");
        expect(db().colorScheme).toMatchObject({ type: "dark", bgcolor: "#1a1a1a" });

        api.changeColorScheme("no such scheme");
        expect(db().colorSchemeName).toBe("dark");
        expect(db().colorScheme).toMatchObject({ type: "dark", bgcolor: "#1a1a1a" });

        DBState.db.customColorScheme = { ...lightScheme, bgcolor: "#123456" } as any;
        api.changeColorScheme("custom");
        expect(db().colorSchemeName).toBe("custom");
        expect(db().colorScheme).toMatchObject({ type: "light", bgcolor: "#123456" });
        // A copy, not the custom scheme object itself.
        db().customColorScheme.bgcolor = "#000000";
        expect(db().colorScheme.bgcolor).toBe("#123456");
    });

    it("setColorScheme, changeTextTheme, and setCustomTextTheme land through updateSettings as detached copies", async () => {
        const api = await makeApi();
        const scheme = { ...lightScheme, type: "dark", bgcolor: "#010203" };
        api.setColorScheme(scheme);
        expect(db().colorSchemeName).toBe("custom");
        expect(plain(db().customColorScheme)).toEqual(scheme);
        expect(plain(db().colorScheme)).toEqual(scheme);
        scheme.bgcolor = "#ffffff";
        expect(db().colorScheme.bgcolor).toBe("#010203");
        expect(db().customColorScheme.bgcolor).toBe("#010203");

        api.changeTextTheme("highcontrast");
        expect(db().textTheme).toBe("highcontrast");
        expect(() => api.changeTextTheme("nope")).toThrow(/Invalid text theme/);
        expect(db().textTheme).toBe("highcontrast");

        const theme = {
            FontColorStandard: "#1",
            FontColorBold: "#2",
            FontColorItalic: "#3",
            FontColorItalicBold: "#4",
            FontColorQuote1: "#5",
            FontColorQuote2: "#6",
        };
        api.setCustomTextTheme(theme);
        expect(db().textTheme).toBe("custom");
        expect(plain(db().customTextTheme)).toEqual(theme);
        theme.FontColorBold = "changed";
        expect(db().customTextTheme.FontColorBold).toBe("#2");
        expect(db().botPresets.every((entry: object) => !("textTheme" in entry) && !("colorScheme" in entry))).toBe(
            true,
        );
        expect(console.warn).not.toHaveBeenCalled();
    });
});
