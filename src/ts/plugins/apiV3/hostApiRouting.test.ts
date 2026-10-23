import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The v3 `setDatabase` and `setDatabaseLite` host setters route every `allowedDbKeys` key to the
// mutation that owns it, on the live settings records as the app runs them (read through the
// settings views, two presets, the real character, collection, and plugin storage mutations).
// Pinned here:
// - the routing table: each of the 23 keys lands in its owner through both setters (a forwarded key
//   in the selected preset by id, a section key at the root and in no preset, the collections
//   through their mutations), except `plugins`, which the lite setter ignores, and every other key
//   at the top level of `pluginCustomStorage`;
// - the key order: `characterOrder` is applied after `characters` and `selectedPersona` last,
//   whatever the object's key order, so an explicit order survives the additions of the same call
//   and a persona index names a persona of the list the same call sets;
// - the per-key contract: a refused value (`MutationValidationError`) is warned about and keeps
//   the previous mirror value while the other keys land; a `characters` or `plugins` list is
//   preflighted whole; a gone preset (`MutationTargetGoneError`) and an unexpected error propagate;
// - the full setter's `plugins`: the installed plugins stay, the user is asked once per new plugin,
//   a confirmed same-name update replaces its entry in place, a denial installs nothing, and a
//   malformed list asks nothing;
// - a reserved storage namespace a plugin replaced with a list stays readable, enumerable, and
//   writable without losing an entry, own `constructor`/`__proto__` keys included;
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

vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: alerts.confirm,
    }),
);

// The module-update effect of `stores.svelte.ts` tracks `enabledModules`; nothing here needs modules.
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));

// The real parser module installs a module-level `$effect.root` over the selection, which is still
// uninitialized here because the modules import each other. Nothing under test parses CBS.
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

import * as chatStore from "src/ts/storage/chatStore.svelte";
import { characterList } from "src/ts/storage/characterStore.svelte";
import { checkCharOrder } from "src/ts/storage/characterOrder";
import { resetRecords } from "src/ts/storage/records.svelte";
import { MutationTargetGoneError } from "src/ts/storage/mutationValidation";
import {
    selectCharacter,
    selectCharacterAt,
    selectedIndex,
    selection,
    selectModelPreset,
    selectPersona,
    selectPreset,
} from "src/ts/storage/selection.svelte";
import { readSettingsRoot, selectedPersonaIndex, settings } from "src/ts/storage/settingsViews.svelte";
import { rootSnapshot } from "src/ts/storage/snapshots.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { normalizeModelPreset, normalizeModelProfile } from "../../../../shared/presets";
import { executePluginV3 } from "./v3.svelte";

const ui = () => settings.ui as any;
const preset = (id: string) => settings.presets.find((entry: { id: string }) => entry.id === id) as any;
const modelPreset = (id: string) => settings.modelPresets.find((entry: { id: string }) => entry.id === id) as any;
const modelProfile = (id: string) => settings.modelProfiles.find((entry: { id: string }) => entry.id === id) as any;
/** A plain copy (a Svelte proxy compares differently, and an own `__proto__` key survives JSON). */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const ids = () => characterList().map((character: any) => character.chaId);
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
 * The live records, installed as boot installs them (there is no whole-database aggregate): two
 * presets (`a` selected), two personas (`p` selected), and the fields the routed keys write, so an
 * unchanged value is told apart from a missing one. The characters' chats are held in the chat
 * module, as boot assembles them.
 */
function liveDatabase(fields: Record<string, unknown> = {}) {
    selectPreset("a");
    selectModelPreset("a");
    selectPersona("p");
    const raw: Record<string, unknown> = {
        botPresets: [
            { id: "a", name: "A" },
            { id: "b", name: "B" },
        ],
        // The model presets of the same ids, each with its own main profile, which the routed
        // profile keys write.
        modelPresets: [
            normalizeModelPreset({ name: "A", mainSlot: { profileId: "m-a" } }, { id: "a" }),
            normalizeModelPreset({ name: "B", mainSlot: { profileId: "m-b" } }, { id: "b" }),
        ],
        modelProfiles: [
            normalizeModelProfile({ id: "m-a", name: "A", modelId: "model-a" }),
            normalizeModelProfile({ id: "m-b", name: "B", modelId: "model-b" }),
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
        ...fields,
    };
    installFlatDatabaseWithChats(raw);
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
    liveDatabase();
    selectCharacter(null);
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
        ["maxResponse", 301, 302],
        ["frequencyPenalty", 1, 2],
        ["PresensePenalty", 3, 4],
    ] as const)("%s lands in the selected prompt preset by id, through both setters", async (key, lite, full) => {
        const api = await makeApi();
        await api.setDatabaseLite({ [key]: lite });
        expect(preset("a")[key]).toBe(lite);
        expect(preset("b")[key]).toBeUndefined();
        expect(readSettingsRoot(key)).toBe(lite);
        expect(settings.pluginStorage).toBeUndefined();

        // The full setter writes the preset selected then: `b` after a switch, and `a` keeps its value.
        selectPreset("b");
        await api.setDatabase({ [key]: full });
        expect(preset("b")[key]).toBe(full);
        expect(preset("a")[key]).toBe(lite);
        expect(readSettingsRoot(key)).toBe(full);
        expect(console.warn).not.toHaveBeenCalled();
    });

    // The model roots plugins may write (through `writeModelRoot`): `maxContext` lands in the main
    // slot's profile, `seperateModels.<mode>` with no profile of that model id becomes a bare slot,
    // and `seperateModelsForAxModels` sets the preset toggle.
    const auxRoot = (memory: string) => ({ memory, translate: "", emotion: "", otherAx: "" });
    it.each([
        ["maxContext", 1001, 1002, (id: string) => modelProfile(`m-${id}`).maxContext, (value: any) => value],
        [
            "seperateModels",
            { memory: "m1" },
            { memory: "m2" },
            (id: string) => modelPreset(id).auxSlots,
            (value: any) => ({ memory: { modelId: value.memory } }),
        ],
        [
            "seperateModelsForAxModels",
            true,
            false,
            (id: string) => modelPreset(id).seperateModelsForAxModels,
            (value: any) => value,
        ],
    ] as const)(
        "%s lands in the selected model preset (or its main profile) by id, through both setters",
        async (key, lite, full, stored, storedOf) => {
            const rootOf = (value: any) => (key === "seperateModels" ? auxRoot(value.memory) : value);
            const api = await makeApi();
            await api.setDatabaseLite({ [key]: lite });
            expect(plain(stored("a"))).toEqual(storedOf(lite));
            expect(plain(stored("b") ?? null)).not.toEqual(storedOf(lite));
            expect(plain(readSettingsRoot(key))).toEqual(rootOf(lite));
            expect(settings.presets.every((entry: object) => !(key in entry))).toBe(true);
            expect(settings.pluginStorage).toBeUndefined();

            // The full setter writes the model preset selected then: `b` after a model switch (a prompt
            // switch alone changes nothing), and `a` keeps its value.
            selectPreset("b");
            selectModelPreset("b");
            await api.setDatabase({ [key]: full });
            expect(plain(stored("b"))).toEqual(storedOf(full));
            expect(plain(stored("a"))).toEqual(storedOf(lite));
            expect(plain(readSettingsRoot(key))).toEqual(rootOf(full));
            expect(console.warn).not.toHaveBeenCalled();
        },
    );

    it.each([
        ["askRemoval", false, true],
        ["theme", "t1", "t2"],
        ["textTheme", "highcontrast", "standard"],
        ["lineHeight", 1.4, 1.6],
        ["customCSS", ".a {}", ".b {}"],
        ["guiHTML", "<a></a>", "<b></b>"],
        ["colorSchemeName", "light", "dark"],
    ] as const)(
        "%s lands in its section at the root and in no preset, through both setters",
        async (key, lite, full) => {
            const api = await makeApi();
            await api.setDatabaseLite({ [key]: lite });
            expect(plain(readSettingsRoot(key))).toEqual(lite);
            await api.setDatabase({ [key]: full });
            expect(plain(readSettingsRoot(key))).toEqual(full);
            expect(settings.presets.every((entry: object) => !(key in entry))).toBe(true);
            expect(settings.pluginStorage).toBeUndefined();
            expect(console.warn).not.toHaveBeenCalled();
        },
    );
});

describe("the routing table: collections, the selection, and custom keys", () => {
    it("modules and enabledModules go through setModules and setEnabledModules", async () => {
        const api = await makeApi();
        await api.setDatabaseLite({ modules: [{ name: "lite" }], enabledModules: ["x", "x", "y"] });
        expect(settings.modules).toEqual([{ name: "lite", id: expect.any(String) }]);
        expect(settings.enabledModules).toEqual(["x", "y"]);
        await api.setDatabase({ modules: [{ id: "keep", name: "full" }], enabledModules: ["keep"] });
        expect(settings.modules).toEqual([{ id: "keep", name: "full" }]);
        expect(settings.enabledModules).toEqual(["keep"]);
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("personas go through setPersonas (the collection's contract), through both setters", async () => {
        const api = await makeApi();
        await api.setDatabaseLite({ personas: [{ name: "lite", icon: "", personaPrompt: "" }] });
        expect(settings.personas).toEqual([
            { name: "lite", icon: "", personaPrompt: "", note: "", id: expect.any(String) },
        ]);
        await api.setDatabase({ personas: [{ id: "f", name: "full", icon: "", personaPrompt: "", note: "n" }] });
        expect(settings.personas).toEqual([{ id: "f", name: "full", icon: "", personaPrompt: "", note: "n" }]);
        expect(selection.personaId).toBe("f");
    });

    it("selectedPersona selects by id in the list the same call sets, whatever the key order", async () => {
        const api = await makeApi();
        const list = [
            { id: "n0", name: "N0", icon: "", personaPrompt: "" },
            { id: "n1", name: "N1", icon: "", personaPrompt: "" },
        ];
        await api.setDatabaseLite({ selectedPersona: 1, personas: list });
        expect(selection.personaId).toBe("n1");
        expect(selectedPersonaIndex()).toBe(1);

        await api.setDatabase({ personas: [...list].reverse(), selectedPersona: 1 });
        expect(selection.personaId).toBe("n0");
        expect(selectedPersonaIndex()).toBe(1);

        // An index naming no persona of the new list is refused; the selection resolved by
        // `setPersonas` (the same id, still present) stays.
        await api.setDatabaseLite({ selectedPersona: 5, personas: list });
        expect(selection.personaId).toBe("n0");
        expect(warnings()).toEqual([expect.stringMatching(/^\[Plugin\] Refused the database key selectedPersona;/)]);
    });

    it("the lite setter ignores plugins: the installed list stays, nothing is asked, and the other keys land", async () => {
        const installed = { name: "installed", script: "s", version: "3.0", realArg: {} };
        settings.plugins = [plain(installed)] as any;
        const api = await makeApi();
        await api.setDatabaseLite({ theme: "lite", plugins: [{ name: "lite", script: "l", version: "3.0" }] });
        await api.setDatabaseLite({ plugins: [], lineHeight: 3 });
        expect(plain(settings.plugins)).toEqual([installed]);
        expect(alerts.confirm).not.toHaveBeenCalled();
        expect(ui().theme).toBe("lite");
        expect(ui().lineHeight).toBe(3);
    });

    it("pluginCustomStorage replaces the whole object through both setters, and a list is refused", async () => {
        settings.pluginStorage = { old: 1, _pluginStorage: { k: 1 } };
        const api = await makeApi();
        await api.setDatabaseLite({ pluginCustomStorage: { lite: true } });
        expect(plain(settings.pluginStorage)).toEqual({ lite: true });
        await api.setDatabase({ pluginCustomStorage: { _pluginStorage: { full: 1 } } });
        expect(plain(settings.pluginStorage)).toEqual({ _pluginStorage: { full: 1 } });
        expect(await api._getPluginStorage("full")).toBe(1);
        await api.setDatabaseLite({ pluginCustomStorage: ["nope"] });
        expect(plain(settings.pluginStorage)).toEqual({ _pluginStorage: { full: 1 } });
        expect(warnings()).toEqual([
            expect.stringMatching(/^\[Plugin\] Refused the database key pluginCustomStorage;/),
        ]);
    });

    it("characterOrder goes through setCharacterOrder, and a malformed order is refused", async () => {
        liveDatabase({
            characters: [character("c", "C"), character("d", "D")],
            characterOrder: ["c", "d"],
        });
        const api = await makeApi();
        await api.setDatabaseLite({ characterOrder: ["d", "c"] });
        expect(plain(settings.characterOrder)).toEqual(["d", "c"]);
        await api.setDatabase({ characterOrder: [{ id: "f", name: "F", color: "", data: ["c", "d"] }] });
        expect(plain(settings.characterOrder)).toEqual([{ id: "f", name: "F", color: "", data: ["c", "d"] }]);
        await api.setDatabaseLite({ characterOrder: ["c", 5] });
        expect(plain(settings.characterOrder)).toEqual([{ id: "f", name: "F", color: "", data: ["c", "d"] }]);
        expect(warnings()).toEqual([expect.stringMatching(/^\[Plugin\] Refused the database key characterOrder;/)]);
    });

    it("a key outside allowedDbKeys lands at the top level of pluginCustomStorage, and undefined removes it", async () => {
        const api = await makeApi();
        await api.setDatabaseLite({ custom: { x: 1 }, pluginV2: [] });
        await api.setDatabase({ other: "o" });
        expect(plain(settings.pluginStorage)).toEqual({ custom: { x: 1 }, pluginV2: [], other: "o" });
        // Not a settings root: the legacy flat shape has no such field.
        expect("custom" in rootSnapshot()).toBe(false);
        await api.setDatabaseLite({ custom: undefined, never: undefined });
        expect(plain(settings.pluginStorage)).toEqual({ pluginV2: [], other: "o" });
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
        liveDatabase({
            characters: [character("c", "C"), character("d", "D")],
            characterOrder: ["c", "d"],
        });
    });

    it("a reordered list keeps the mirror order, appends a new character, and removes an omitted one (both setters)", async () => {
        const api = await makeApi();
        await api.setDatabaseLite({ characters: [character("d", "D"), character("c", "C2"), incoming("e", "E")] });
        expect(ids()).toEqual(["c", "d", "e"]);
        expect(characterList()[0].name).toBe("C2");
        expect((characterList()[2] as any).chats).toHaveLength(1);
        expect(plain(settings.characterOrder)).toEqual(["c", "d", "e"]);

        // An omission removes; the selection follows its character (`d` at index 1 stays selected at 0).
        selectCharacterAt(1);
        await api.setDatabase({ characters: [character("e", "E"), character("d", "D")] });
        expect(ids()).toEqual(["d", "e"]);
        expect(selectedIndex()).toBe(0);
        expect(plain(settings.characterOrder)).toEqual(["d", "e"]);
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
            await api.setDatabaseLite({ characters: [character("c", "renamed"), incoming("e", "E"), bad] });
        }
        await api.setDatabase({ characters: [character("c", "renamed"), incoming("e", "E"), { chaId: 5 }] });
        expect(ids()).toEqual(["c", "d"]);
        expect(characterList()[0].name).toBe("C");
        expect(warnings()).toHaveLength(5);
        expect(warnings().every((text) => /Refused the database key characters;.*characters\[2\]/.test(text))).toBe(
            true,
        );
    });

    it("refuses the whole list when a new entry fails its creation (prepared before the list changes)", async () => {
        const api = await makeApi();
        const before = plain(characterList());
        // The first new entry is valid; the second passes the shape check but not its creation (a
        // lorebook entry the conversion refuses, a group whose members are not a list).
        for (const bad of [
            { ...incoming("f", "bad lore"), globalLore: [null] },
            { ...incoming("f", "bad group"), type: "group", characters: "e" },
        ]) {
            await api.setDatabaseLite({ characters: [character("c", "renamed"), incoming("e", "E"), bad] });
        }
        expect(ids()).toEqual(["c", "d"]);
        expect(plain(characterList())).toEqual(before);
        expect(plain(settings.characterOrder)).toEqual(["c", "d"]);
        expect(warnings()).toHaveLength(2);
        expect(warnings().every((text) => /Refused the database key characters;.*characters\[2\]/.test(text))).toBe(
            true,
        );
        // A valid list then lands with its new entry created once (its creation steps done).
        await api.setDatabaseLite({ characters: [character("c", "renamed"), incoming("e", "E")] });
        expect(ids()).toEqual(["c", "e"]);
        const e = characterList()[1] as any;
        expect(e).toMatchObject({ type: "character", desc: "", firstMsgIndex: -1, creation_date: expect.any(Number) });
        expect(plain(e.chats)).toEqual([
            { id: expect.any(String), message: [], note: "", name: "Chat 1", localLore: [], fmIndex: -1 },
        ]);
    });

    it("a non-list characters value is refused with a warning, while the other keys land", async () => {
        const api = await makeApi();
        await api.setDatabaseLite({ theme: "before", characters: { chaId: "c" }, customCSS: "after" });
        expect(ids()).toEqual(["c", "d"]);
        expect(ui().theme).toBe("before");
        expect(ui().customCSS).toBe("after");
        expect(warnings()).toEqual([expect.stringMatching(/^\[Plugin\] Refused the database key characters;/)]);
    });
});

describe("characterOrder is applied after characters", () => {
    const folder = (data: string[]) => ({ id: "f", name: "F", color: "", data });

    it("an explicit order of ids the same call adds survives, with the order key first or last (both setters)", async () => {
        const api = await makeApi();
        await api.setDatabaseLite({ characterOrder: ["b", "a"], characters: [incoming("a", "A"), incoming("b", "B")] });
        expect(ids()).toEqual(["a", "b"]);
        expect(plain(settings.characterOrder)).toEqual(["b", "a"]);

        const [a, b] = plain(characterList());
        await api.setDatabase({
            characters: [incoming("d", "D"), a, incoming("c", "C"), b],
            characterOrder: ["d", "c", "b", "a"],
        });
        expect(ids()).toEqual(["a", "b", "d", "c"]);
        expect(plain(settings.characterOrder)).toEqual(["d", "c", "b", "a"]);
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("folder membership of added characters survives", async () => {
        const api = await makeApi();
        await api.setDatabaseLite({
            characterOrder: [folder(["b", "a"])],
            characters: [incoming("a", "A"), incoming("b", "B")],
        });
        expect(plain(settings.characterOrder)).toEqual([folder(["b", "a"])]);
        await api.setDatabase({
            characterOrder: [folder(["c"]), "a", "b"],
            characters: [incoming("a", "A"), incoming("b", "B"), incoming("c", "C")],
        });
        expect(plain(settings.characterOrder)).toEqual([folder(["c"]), "a", "b"]);
        expect(ids()).toEqual(["a", "b", "c"]);
    });

    it("additions and omissions in one call: the persisted order is the explicit one, the mirror keeps its order", async () => {
        liveDatabase({
            characters: [character("c", "C"), character("d", "D")],
            characterOrder: ["c", "d"],
        });
        const api = await makeApi();
        await api.setDatabaseLite({
            characterOrder: ["e", "d"],
            characters: [character("d", "D"), incoming("e", "E")],
        });
        expect(ids()).toEqual(["d", "e"]);
        expect(plain(settings.characterOrder)).toEqual(["e", "d"]);
    });

    it("a generating character omitted from the list stays in the mirror; the order is the explicit one until the next repair", async () => {
        const refK = { chaId: "c", chatId: "kc" };
        liveDatabase({
            characters: [
                character("c", "C", [chat("kc", [{ role: "char", data: "so far", chatId: "m" }])]),
                character("d", "D"),
            ],
            characterOrder: ["c", "d"],
        });
        chatStore.applyServerGeneration(refK, {
            jobId: "J",
            messageId: "m",
            generationId: "g",
            text: "so far",
            seq: 0,
        });
        try {
            const api = await makeApi();
            await api.setDatabaseLite({ characterOrder: ["d"], characters: [character("d", "D")] });
            expect(ids()).toEqual(["c", "d"]);
            expect(plain(settings.characterOrder)).toEqual(["d"]);
            expect(warnings()).toEqual([expect.stringMatching(/removal was skipped/)]);
            checkCharOrder();
            expect(plain(settings.characterOrder)).toEqual(["d", "c"]);
        } finally {
            chatStore.endServerJob("J");
        }
    });

    it("a refused order leaves the characters applied, and their added ids repaired into the old order", async () => {
        liveDatabase({ characters: [character("c", "C")], characterOrder: ["c"] });
        const api = await makeApi();
        await api.setDatabaseLite({ characterOrder: "c,e", characters: [character("c", "C"), incoming("e", "E")] });
        expect(ids()).toEqual(["c", "e"]);
        expect(plain(settings.characterOrder)).toEqual(["c", "e"]);
        expect(warnings()).toEqual([expect.stringMatching(/^\[Plugin\] Refused the database key characterOrder;/)]);
    });
});

describe("the per-key contract", () => {
    it("a refused key between two valid keys keeps its previous value while both valid keys land (both setters)", async () => {
        const api = await makeApi();
        await api.setDatabaseLite({ theme: "lite", temperature: "hot", customCSS: "lite css" });
        expect(ui().theme).toBe("lite");
        expect(ui().customCSS).toBe("lite css");
        expect(preset("a").temperature).toBeUndefined();
        expect(warnings()).toEqual([
            expect.stringMatching(/^\[Plugin\] Refused the database key temperature; the previous value was kept: /),
        ]);

        await api.setDatabase({ lineHeight: 2, personas: "nope", guiHTML: "<g></g>", askRemoval: null, modules: [] });
        expect(ui().lineHeight).toBe(2);
        expect(ui().guiHTML).toBe("<g></g>");
        expect(settings.personas).toEqual(personas);
        expect(ui().askRemoval).toBe(true);
        expect(settings.modules).toEqual([]);
        expect(warnings().slice(1)).toEqual([
            expect.stringMatching(/^\[Plugin\] Refused the database key personas;/),
            expect.stringMatching(/^\[Plugin\] Refused the database key askRemoval;/),
        ]);
    });

    it("a preset field written while the selected preset is gone throws MutationTargetGoneError to the plugin", async () => {
        const api = await makeApi();
        selectPreset("gone");
        await expect(api.setDatabaseLite({ theme: "first", temperature: 1 })).rejects.toBeInstanceOf(
            MutationTargetGoneError,
        );
        expect(ui().theme).toBe("first");
        // The setters are async (they load the chats first): the selection's repair ran during the
        // first call's awaits, so the preset is gone again for the second.
        selectPreset("gone");
        await expect(api.setDatabase({ temperature: 2 })).rejects.toBeInstanceOf(MutationTargetGoneError);
        expect(preset("a").temperature).toBeUndefined();
        expect(preset("b").temperature).toBeUndefined();
        expect(console.warn).not.toHaveBeenCalled();
    });

    it("an error that is not a refusal propagates to the plugin instead of being warned about", async () => {
        const api = await makeApi();
        // A mirror whose character list is not loaded (the records forgotten after the install): the
        // character routing passes its checks and fails at the list operation.
        resetRecords();
        await expect(api.setDatabaseLite({ characters: [incoming("e", "E")] })).rejects.toThrow(
            /characters are not loaded/,
        );
        await expect(api.setDatabase({ characters: [incoming("e", "E")] })).rejects.toThrow(
            /characters are not loaded/,
        );
        expect(console.warn).not.toHaveBeenCalled();
    });
});

// Plugins see model ids, never profile ids, and a write of a model root changes a slot only when
// the rules name exactly one target.
describe("the model roots under the plugin write rules", () => {
    const settingsWarnings = () =>
        vi
            .mocked(console.warn)
            .mock.calls.map((call) => String(call[0]))
            .filter((text) => text.startsWith("[Settings] Refused"));
    /** Model preset `a` with a twin profile of its main model in `memory` and a deleted one in `otherAx`. */
    function twinDatabase(mainProfileId = "m-a") {
        liveDatabase({
            modelPresets: [
                normalizeModelPreset(
                    {
                        name: "A",
                        mainSlot: { profileId: mainProfileId },
                        seperateModelsForAxModels: true,
                        auxSlots: {
                            memory: { profileId: "twin" },
                            emotion: { modelId: "gpt-5.5" },
                            otherAx: { profileId: "gone" },
                        },
                    },
                    { id: "a" },
                ),
                normalizeModelPreset({ name: "B", mainSlot: { profileId: "m-b" } }, { id: "b" }),
            ],
            modelProfiles: [
                normalizeModelProfile({ id: "m-a", name: "A", modelId: "model-a", maxContext: 3000 }),
                normalizeModelProfile({ id: "twin", name: "Twin", modelId: "model-a" }),
                normalizeModelProfile({ id: "m-b", name: "B", modelId: "model-b" }),
            ],
        });
    }

    it("reads model ids, and a read-modify-write round trip changes no slot (a twin model id, a deleted profile)", async () => {
        twinDatabase();
        const api = await makeApi();
        const keys = ["maxContext", "seperateModels", "seperateModelsForAxModels", "temperature"];
        const read = await api.getDatabase(keys);
        expect(read).toMatchObject({
            maxContext: 3000,
            seperateModelsForAxModels: true,
            seperateModels: { memory: "model-a", translate: "", emotion: "gpt-5.5", otherAx: "" },
        });
        const before = plain(modelPreset("a"));
        await api.setDatabaseLite({ ...read, temperature: 55 });
        await api.setDatabase({ ...read, temperature: 56 });
        expect(preset("a").temperature).toBe(56);
        expect(plain(modelPreset("a"))).toEqual(before);
        expect(modelProfile("m-a").maxContext).toBe(3000);
        expect(settingsWarnings()).toEqual([]);
    });

    it("applies each mode by the rules in order: clear, one match, no match (bare), a definition that needs a profile refused", async () => {
        twinDatabase();
        const api = await makeApi();
        await api.setDatabaseLite({
            seperateModels: { memory: "", translate: "model-b", emotion: "gemini-2.5-flash", otherAx: "reverse_proxy" },
            temperature: 57,
        });
        expect(plain(modelPreset("a").auxSlots)).toEqual({
            translate: { profileId: "m-b" },
            emotion: { modelId: "gemini-2.5-flash" },
            // Refused: the deleted profile stays named, and the other modes and keys still apply.
            otherAx: { profileId: "gone" },
        });
        expect(preset("a").temperature).toBe(57);
        expect(settingsWarnings()).toEqual([expect.stringContaining("seperateModels.otherAx")]);
    });

    it("refuses a model id two profiles share, keeping the slot", async () => {
        twinDatabase();
        const api = await makeApi();
        await api.setDatabase({ seperateModels: { translate: "model-a" } });
        expect(modelPreset("a").auxSlots.translate).toBeUndefined();
        expect(readSettingsRoot("seperateModels")).toMatchObject({ translate: "" });
        expect(settingsWarnings()).toEqual([expect.stringContaining("several profiles")]);
    });

    it("writes maxContext to the main profile, shared by every preset that uses it, and refuses it with no main profile", async () => {
        twinDatabase();
        const api = await makeApi();
        modelPreset("b").mainSlot = { profileId: "m-a" };
        await api.setDatabaseLite({ maxContext: 4096 });
        expect(modelProfile("m-a").maxContext).toBe(4096);
        selectModelPreset("b");
        expect(readSettingsRoot("maxContext")).toBe(4096);

        twinDatabase("deleted");
        const fresh = await makeApi();
        const read = await fresh.getDatabase(["maxContext"]);
        // Handing back the default the root reads is no change; a changed value has no target.
        await fresh.setDatabaseLite({ maxContext: read.maxContext, temperature: 58 });
        expect(settingsWarnings()).toEqual([]);
        await fresh.setDatabaseLite({ maxContext: 8192, temperature: 59 });
        expect(preset("a").temperature).toBe(59);
        expect(readSettingsRoot("maxContext")).toBe(read.maxContext);
        expect(settingsWarnings()).toEqual([expect.stringContaining("maxContext")]);
    });
});

describe("the full setter's plugins key", () => {
    const installed = { name: "installed", script: "s", version: "3.0", realArg: {} };
    const newPlugin = (name: string) => ({ name, script: `script of ${name}`, version: "3.0" });

    beforeEach(() => {
        settings.plugins = [plain(installed)] as any;
    });

    it("keeps the installed plugins, asks once for the new one, and appends it", async () => {
        const api = await makeApi();
        await api.setDatabase({ plugins: [installed, newPlugin("new")], theme: "with" });
        expect(alerts.confirm).toHaveBeenCalledTimes(1);
        expect(plain(settings.plugins)).toEqual([installed, newPlugin("new")]);
        expect(ui().theme).toBe("with");
        // Sent again, the same script asks nothing and changes nothing.
        await api.setDatabase({ plugins: [installed, newPlugin("new")] });
        expect(alerts.confirm).toHaveBeenCalledTimes(1);
        expect(plain(settings.plugins)).toEqual([installed, newPlugin("new")]);
    });

    it("an approved same-name update replaces the installed entry at the same index", async () => {
        const before = newPlugin("before");
        const after = newPlugin("after");
        settings.plugins = plain([before, installed, after]);
        const updated = { ...installed, script: "updated script" };
        alerts.confirm.mockResolvedValueOnce(true);
        const api = await makeApi();

        await api.setDatabase({ plugins: [updated] });

        expect(alerts.confirm).toHaveBeenCalledTimes(1);
        expect(plain(settings.plugins)).toEqual([before, updated, after]);
    });

    it("a denied same-name update keeps the old entry unchanged", async () => {
        const existing = [newPlugin("before"), installed, newPlugin("after")];
        settings.plugins = plain(existing);
        const updated = { ...installed, script: "updated script" };
        alerts.confirm.mockResolvedValueOnce(false);
        const api = await makeApi();

        await api.setDatabase({ plugins: [updated] });

        expect(alerts.confirm).toHaveBeenCalledTimes(1);
        expect(plain(settings.plugins)).toEqual(existing);
    });

    it("a denial installs nothing and the other keys still land", async () => {
        alerts.confirm.mockResolvedValueOnce(false);
        const api = await makeApi();
        await api.setDatabase({ theme: "still", plugins: [newPlugin("denied")], lineHeight: 3 });
        expect(plain(settings.plugins)).toEqual([installed]);
        expect(ui().theme).toBe("still");
        expect(ui().lineHeight).toBe(3);
    });

    it("asks once per new plugin and installs only the confirmed ones", async () => {
        alerts.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const api = await makeApi();
        await api.setDatabase({ plugins: [newPlugin("yes"), newPlugin("no"), installed] });
        expect(alerts.confirm).toHaveBeenCalledTimes(2);
        expect(settings.plugins.map((plugin: any) => plugin.name)).toEqual(["installed", "yes"]);
    });

    it("a list with a malformed last entry, or a non-list, asks nothing and keeps the installed plugins", async () => {
        const api = await makeApi();
        await api.setDatabase({ plugins: [newPlugin("valid"), { script: "no name" }], theme: "landed" });
        await api.setDatabase({ plugins: "nope" });
        expect(alerts.confirm).not.toHaveBeenCalled();
        expect(plain(settings.plugins)).toEqual([installed]);
        expect(ui().theme).toBe("landed");
        expect(warnings()).toEqual([
            expect.stringMatching(/^\[Plugin\] Refused the database key plugins;.*plugins\[1\]/),
            expect.stringMatching(/^\[Plugin\] Refused the database key plugins;.*expected a list/),
        ]);
    });
});

describe("reserved storage namespaces a plugin replaced", () => {
    it("a list in _pluginStorage is read by index, listed, removed from, and written to without losing an entry", async () => {
        const api = await makeApi();
        await api.setDatabaseLite({ _pluginStorage: ["saved", { deep: true }] });
        expect(await api._getPluginStorage("0")).toBe("saved");
        expect(await api._getPluginStorage("1")).toEqual({ deep: true });
        expect(await api._getPluginStorage("length")).toBeNull();
        expect(await api._keysPluginStorage()).toEqual(["0", "1"]);
        expect(await api._keyPluginStorage(1)).toBe("1");
        expect(await api._lengthPluginStorage()).toBe(2);

        await api._setPluginStorage("2", "next");
        expect(plain(settings.pluginStorage._pluginStorage)).toEqual({
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
        expect(plain(settings.pluginStorage)).toEqual({
            _pluginStorage: ["v3"],
            _safeLocalPluginStorage: { "0": "local", k: 1 },
        });
        await local.removeItem("0");
        expect(await local.keys()).toEqual(["k"]);
        await api._removePluginStorage("0");
        expect(plain(settings.pluginStorage)).toEqual({ _pluginStorage: {}, _safeLocalPluginStorage: { k: 1 } });
    });

    it("own constructor and __proto__ entries of a replaced namespace stay readable, writable, and removable", async () => {
        const api = await makeApi();
        await api.setDatabaseLite({ _pluginStorage: JSON.parse('{"constructor": 1, "__proto__": 2, "plain": 3}') });
        expect(await api._getPluginStorage("constructor")).toBe(1);
        expect(await api._getPluginStorage("__proto__")).toBe(2);
        expect(await api._getPluginStorage("toString")).toBeNull();
        expect((await api._keysPluginStorage()).sort()).toEqual(["__proto__", "constructor", "plain"]);
        expect(Object.getPrototypeOf(settings.pluginStorage._pluginStorage)).toBe(Object.prototype);

        await api._setPluginStorage("constructor", 10);
        await api._setPluginStorage("__proto__", 20);
        expect(await api._getPluginStorage("constructor")).toBe(10);
        expect(await api._getPluginStorage("__proto__")).toBe(20);
        expect(await api._getPluginStorage("plain")).toBe(3);
        expect(Object.getPrototypeOf(settings.pluginStorage._pluginStorage)).toBe(Object.prototype);

        await api._removePluginStorage("__proto__");
        await api._removePluginStorage("constructor");
        expect(await api._keysPluginStorage()).toEqual(["plain"]);
        expect(await api._getPluginStorage("constructor")).toBeNull();
    });
});

describe("setArg, setArgument, and the theme APIs", () => {
    it("setArg and setArgument write the plugin's argument through setPluginArgument, and a bad value is refused", async () => {
        settings.plugins = [
            { name: "other", script: "", version: "3.0", realArg: { foo: "bar" } },
            { name: "self", script: "", version: "3.0", realArg: {} },
        ] as any;
        const api = await makeApi("self");
        const argOf = (name: string) => plain(settings.plugins.find((plugin: any) => plugin.name === name).realArg);

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
        expect(settings.plugins.map((plugin: any) => plugin.name)).toEqual(["other", "self"]);
        expect(warnings()).toHaveLength(2);
    });

    it("changeColorScheme writes the named scheme and its name; an unknown name changes nothing", async () => {
        const api = await makeApi();
        api.changeColorScheme("dark");
        expect(ui().colorSchemeName).toBe("dark");
        expect(ui().colorScheme).toMatchObject({ type: "dark", bgcolor: "#1a1a1a" });

        api.changeColorScheme("no such scheme");
        expect(ui().colorSchemeName).toBe("dark");
        expect(ui().colorScheme).toMatchObject({ type: "dark", bgcolor: "#1a1a1a" });

        settings.ui.customColorScheme = { ...lightScheme, bgcolor: "#123456" } as any;
        api.changeColorScheme("custom");
        expect(ui().colorSchemeName).toBe("custom");
        expect(ui().colorScheme).toMatchObject({ type: "light", bgcolor: "#123456" });
        // A copy, not the custom scheme object itself.
        ui().customColorScheme.bgcolor = "#000000";
        expect(ui().colorScheme.bgcolor).toBe("#123456");
    });

    it("setColorScheme, changeTextTheme, and setCustomTextTheme land through updateSettings as detached copies", async () => {
        const api = await makeApi();
        const scheme = { ...lightScheme, type: "dark", bgcolor: "#010203" };
        api.setColorScheme(scheme);
        expect(ui().colorSchemeName).toBe("custom");
        expect(plain(ui().customColorScheme)).toEqual(scheme);
        expect(plain(ui().colorScheme)).toEqual(scheme);
        scheme.bgcolor = "#ffffff";
        expect(ui().colorScheme.bgcolor).toBe("#010203");
        expect(ui().customColorScheme.bgcolor).toBe("#010203");

        api.changeTextTheme("highcontrast");
        expect(ui().textTheme).toBe("highcontrast");
        expect(() => api.changeTextTheme("nope")).toThrow(/Invalid text theme/);
        expect(ui().textTheme).toBe("highcontrast");

        const theme = {
            FontColorStandard: "#1",
            FontColorBold: "#2",
            FontColorItalic: "#3",
            FontColorItalicBold: "#4",
            FontColorQuote1: "#5",
            FontColorQuote2: "#6",
        };
        api.setCustomTextTheme(theme);
        expect(ui().textTheme).toBe("custom");
        expect(plain(ui().customTextTheme)).toEqual(theme);
        theme.FontColorBold = "changed";
        expect(ui().customTextTheme.FontColorBold).toBe("#2");
        expect(settings.presets.every((entry: object) => !("textTheme" in entry) && !("colorScheme" in entry))).toBe(
            true,
        );
        expect(console.warn).not.toHaveBeenCalled();
    });
});
