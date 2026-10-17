import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6 slice 10 (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/aggregate-removal.md`):
// the snapshot builders (`snapshots.svelte.ts`) that serve the legacy whole-database shape now that
// the aggregate is gone. Each answers a fresh plain object built from the records: `rootSnapshot`
// (every root name as an own key, `undefined` kept, no `proxyKey` since the model profiles removed it,
// the three selection indexes),
// `buildDatabaseSubset` (the plugin `getDatabase`: the 23 allowed keys, the characters with their
// chats, the persona index, a hook's preset for the preset keys, an own `__proto__` storage key kept
// as data), `buildSettingsReport` (the bug-report export: the removal list the component carried
// before the slice, every `llmSecrets` field, and every key named like a credential, with `meta`),
// and `buildBackupInventory` (chat-free character asset fields and the five settings). The model
// fields of the fixture live in the model presets' main profiles (`docs/plan/model-profiles.md`). The oracle
// for the report is the removed component's own filter, written out here, applied to the root
// snapshot; the builders are checked to be detached (a write into a result changes and queues
// nothing) and untracked (a read inside a `$derived` repairs a stale selection without throwing).

const held = vi.hoisted(() => ({
    asset: null as null | ((path: string) => void),
}));

vi.mock("../../globalApi.svelte", () => ({
    downloadFile: vi.fn(),
    readImage: vi.fn(),
    saveAsset: vi.fn(() => new Promise<string>((resolve) => (held.asset = resolve))),
    AppendableBuffer: class {},
}));
vi.mock("../../alert", () => ({
    alertNormal: vi.fn(),
    alertError: vi.fn(),
    alertStore: { set: vi.fn(), subscribe: vi.fn() },
}));
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../process/files/inlays", () => ({ reencodeImage: vi.fn(async (data: Uint8Array) => data) }));
vi.mock("../serverAuth", () => ({
    authFetch: vi.fn(),
    getNodeServerProxyAuth: vi.fn(async () => "token"),
    ensureAuth: vi.fn(async () => undefined),
}));

import { SECTION_FIELDS } from "../../../../shared/sections.ts";
import { normalizeModelPresets, normalizeModelProfiles, plainClone } from "../../../../shared/presets.ts";
import { characterList } from "../characterStore.svelte";
import { findChat } from "../chatStore.svelte";
import { resetRecords, setRecordWriteListener } from "../records.svelte";
import { selection, selectLoreBookPage, selectPersona, selectPreset } from "../selection.svelte";
import {
    activeMainProfile,
    activePreset,
    hasModelPreset,
    hasPreset,
    readSettingsRoot,
    SETTINGS_ROOT_KEYS,
    selectedPresetIndex,
    settings,
} from "../settingsViews.svelte";
import { buildBackupInventory, buildDatabaseSubset, buildSettingsReport, rootSnapshot } from "../snapshots.svelte";
import { evaluateInDerived } from "./derivedProbe.svelte";
import { installFlatDatabaseWithChats } from "./installFlatDatabase";

type AnyRecord = Record<string, any>;

/** The plugin API's `allowedDbKeys` (`plugins.svelte.ts`), the contract the subset serves. */
const ALLOWED_DB_KEYS = [
    "characters",
    "modules",
    "enabledModules",
    "moduleIntergration",
    "personas",
    "plugins",
    "pluginCustomStorage",
    "temperature",
    "askRemoval",
    "maxContext",
    "maxResponse",
    "frequencyPenalty",
    "PresensePenalty",
    "theme",
    "textTheme",
    "lineHeight",
    "seperateModelsForAxModels",
    "seperateModels",
    "customCSS",
    "guiHTML",
    "colorSchemeName",
    "selectedPersona",
    "characterOrder",
] as const;

/** The removal list of the component before the slice (`SettingsExportButtons.svelte`), verbatim. */
const COMPONENT_REMOVED_KEYS = [
    "characters",
    "irisDialogue",
    "googleSearchCredentials",
    "pluginCustomStorage",
    "loreBook",
    "plugins",
    "personas",
    "username",
    "userIcon",
    "userNote",
    "modules",
    "enabledModules",
    "botPresets",
    // The model presets go with the prompt presets (`docs/plan/split-preset.md`), and the model
    // profiles with them, as they hold URLs (`docs/plan/model-profiles.md`, "Import / export").
    "modelPresets",
    "modelProfiles",
    "characterOrder",
    "webUiUrl",
    "characterOrder",
    "hordeConfig",
    "novelai",
    "koboldURL",
    "ooba",
    "ainconfig",
    "personaPrompt",
    "promptTemplate",
    "deeplOptions",
    "google",
    "customPromptTemplateToggle",
    "globalChatVariables",
    "comfyConfig",
    "comfyUiUrl",
    "translatorPrompt",
    "translatorPresets",
    "translatorPresetId",
    "customModels",
    "credentials",
    "mcpURLs",
    "authRefreshes",
];

/**
 * Removed after the slice: the saved toggle presets (historical `docs/plan/chat-toggles-and-presets.md`,
 * slice 3; retrieve from `154711858` via `docs/archived-plan/README.md`) hold free user text like
 * `globalChatVariables` and `customPromptTemplateToggle`.
 */
const LATER_REMOVED_KEYS = ["togglePresets"];

/** The report's filter: the component's removal list, the later removals, and whether `key` is dropped. */
function componentDropped(key: string): boolean {
    return (
        COMPONENT_REMOVED_KEYS.includes(key) ||
        LATER_REMOVED_KEYS.includes(key) ||
        (SECTION_FIELDS.llmSecrets as readonly string[]).includes(key) ||
        key.toLowerCase().includes("key") ||
        key.toLowerCase().includes("proxy") ||
        key.toLowerCase().includes("hypa")
    );
}

const chat = (id: string) => ({ id, name: id, message: [{ chatId: `${id}-m1`, role: "user", data: "hi" }] });

function fixture(): AnyRecord {
    return {
        characters: [
            {
                chaId: "c1",
                type: "character",
                name: "Alice",
                image: "img-alice",
                emotionImages: [["happy", "asset-happy"]],
                additionalAssets: [["a1", "asset-a1", "png"]],
                desc: "A description",
                chats: [chat("k")],
                chatPage: 0,
            },
            {
                chaId: "g1",
                type: "group",
                name: "Group",
                image: "img-group",
                characters: ["c1"],
                chats: [chat("kg")],
                chatPage: 0,
            },
        ],
        botPresets: [
            { id: "a", name: "A", temperature: 40, moduleIntergration: "mod-a" },
            { id: "b", name: "B", temperature: 60 },
        ],
        // The model presets of the same ids; their main slots name the profiles `pa` and `pb`.
        modelPresets: normalizeModelPresets([
            { id: "a", name: "A", mainSlot: { profileId: "pa" }, subSlot: { profileId: "pa" } },
            { id: "b", name: "B", mainSlot: { profileId: "pb" }, subSlot: { profileId: "pb" } },
        ]),
        modelProfiles: normalizeModelProfiles([
            { id: "pa", name: "PA", modelId: "model-a", maxContext: 1234 },
            { id: "pb", name: "PB", modelId: "model-b", maxContext: 5678 },
        ]),
        personas: [
            { id: "p1", name: "Ann", icon: "icon-ann", personaPrompt: "pp1", note: "" },
            { id: "p2", name: "Bob", icon: "icon-bob", personaPrompt: "pp2", note: "" },
        ],
        theme: "dark",
        textTheme: "standard",
        didFirstSetup: true,
        customBackground: "asset-bg",
        hypaV3: true,
        openAIKey: "sk-secret-in-record",
        claudeAPIKey: "",
        characterOrder: ["c1", { name: "folder", data: ["g1"], color: "", id: "f1" }],
        pluginCustomStorage: JSON.parse('{"__proto__": {"evil": 1}, "plain": 2}'),
        modules: [],
        plugins: [],
        enabledModules: [],
        loreBook: [{ name: "L0", data: [] }],
    };
}

/** The record kinds a write notified, in order (the save loop's hook). */
let notified: string[] = [];

function boot() {
    installFlatDatabaseWithChats(fixture());
    notified = [];
    setRecordWriteListener((kind) => notified.push(kind));
}

beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    selectPreset("");
    selectPersona("");
    selectLoreBookPage(0);
});

afterEach(() => {
    setRecordWriteListener(null);
    resetRecords();
});

describe("rootSnapshot", () => {
    it("holds every root name as an own key (an unset one as undefined), no proxyKey, and the three selection indexes", () => {
        boot();
        const snapshot = rootSnapshot();
        for (const key of SETTINGS_ROOT_KEYS) {
            expect(Object.hasOwn(snapshot, key), key).toBe(true);
            expect(snapshot[key], key).toEqual(plainClone(readSettingsRoot(key)));
        }
        const unset = SETTINGS_ROOT_KEYS.filter((key) => readSettingsRoot(key) === undefined);
        expect(unset.length).toBeGreaterThan(0);
        for (const key of unset) {
            expect(Object.hasOwn(snapshot, key), key).toBe(true);
            expect(snapshot[key], key).toBeUndefined();
        }
        expect(Object.hasOwn(snapshot, "proxyKey")).toBe(false);
        expect(snapshot.botPresetsId).toBe(0);
        expect(snapshot.selectedPersona).toBe(0);
        expect(snapshot.loreBookPage).toBe(0);
        expect(Object.hasOwn(snapshot, "characters")).toBe(false);
        // The selection travels as indexes.
        selectPreset("b");
        selectPersona("p2");
        const again = rootSnapshot();
        expect(again.botPresetsId).toBe(1);
        expect(again.selectedPersona).toBe(1);
        expect(again.temperature).toBe(60);
        expect(again.username).toBe("Bob");
        expect(notified).toEqual([]);
    });

    it("is plain detached data: a write into it changes no record and queues nothing", () => {
        boot();
        const snapshot = rootSnapshot();
        expect(Object.getOwnPropertyDescriptor(snapshot, "temperature")).toHaveProperty("value", 40);
        (snapshot.botPresets as AnyRecord[])[0].name = "renamed in the snapshot";
        (snapshot.personas as AnyRecord[])[0].name = "renamed too";
        (snapshot.characterOrder as unknown[]).push("stray");
        snapshot.theme = "light";
        expect(settings.presets[0].name).toBe("A");
        expect(settings.personas[0].name).toBe("Ann");
        expect(plainClone(settings.characterOrder)).toEqual(fixture().characterOrder);
        expect(settings.ui.theme).toBe("dark");
        expect(notified).toEqual([]);
        // Two snapshots share nothing.
        expect(rootSnapshot().botPresets).not.toBe(snapshot.botPresets);
    });

    it("reads untracked: inside a $derived it repairs a stale selection without a tracked write", () => {
        boot();
        selectPreset("gone");
        selectPersona("gone");
        const indexes = evaluateInDerived(() => {
            const snapshot = rootSnapshot();
            return [snapshot.botPresetsId, snapshot.selectedPersona, snapshot.temperature];
        });
        expect(indexes).toEqual([0, 0, 40]);
        expect(selection.presetId).toBe("a");
        expect(selection.personaId).toBe("p1");
        expect(notified).toEqual([]);
    });
});

describe("buildDatabaseSubset (the plugin getDatabase)", () => {
    it("answers every allowed key: the characters with their chats, the persona index, the selected preset's fields, and the rest by root name", () => {
        boot();
        selectPersona("p2");
        const subset = buildDatabaseSubset(ALLOWED_DB_KEYS, null) as AnyRecord;
        expect(Object.keys(subset).sort()).toEqual([...ALLOWED_DB_KEYS].sort());
        expect(subset.characters.map((entry: AnyRecord) => entry.chaId)).toEqual(["c1", "g1"]);
        expect(subset.characters.map((entry: AnyRecord) => entry.chats.map((c: AnyRecord) => c.id))).toEqual([
            ["k"],
            ["kg"],
        ]);
        expect(subset.characters.map((entry: AnyRecord) => entry.chatPage)).toEqual([0, 0]);
        expect(subset.selectedPersona).toBe(1);
        expect(subset.temperature).toBe(40);
        expect(subset.maxContext).toBe(1234);
        expect(subset.moduleIntergration).toBe("mod-a");
        expect(subset.theme).toBe("dark");
        expect(subset.textTheme).toBe("standard");
        expect(subset.characterOrder).toEqual(fixture().characterOrder);
        expect(subset.personas.map((entry: AnyRecord) => entry.name)).toEqual(["Ann", "Bob"]);
        expect(subset.modules).toEqual([]);
        expect(subset.plugins).toEqual([]);
        // A requested key the records do not hold is an own `undefined` key.
        expect(Object.hasOwn(subset, "guiHTML")).toBe(true);
        expect(subset.guiHTML).toBeUndefined();
        expect(notified).toEqual([]);
    });

    it("keeps an own __proto__ key of the plugin storage as data", () => {
        boot();
        const subset = buildDatabaseSubset(["pluginCustomStorage"], null) as AnyRecord;
        const storage = subset.pluginCustomStorage;
        expect(Object.hasOwn(storage, "__proto__")).toBe(true);
        expect(Object.hasOwn(storage, "plain")).toBe(true);
        expect(storage.plain).toBe(2);
        expect(Object.getPrototypeOf(storage)).toBe(Object.prototype);
        expect(JSON.parse(JSON.stringify(storage))).toEqual(JSON.parse('{"__proto__": {"evil": 1}, "plain": 2}'));
    });

    it("reads a hook's presets for the preset keys, each from its owner, whatever is selected, and never redirects a gone one", () => {
        boot();
        expect(selection.presetId).toBe("a");
        expect(selection.modelPresetId).toBe("a");
        const keys = ["temperature", "maxContext", "theme", "selectedPersona"];
        const hooked = buildDatabaseSubset(keys, { presetId: "b", modelPresetId: "b" }) as AnyRecord;
        expect(hooked).toEqual({ temperature: 60, maxContext: 5678, theme: "dark", selectedPersona: 0 });
        // The pair is independent: the prompt preset `b` with the model preset `a`.
        expect(buildDatabaseSubset(keys, { presetId: "b", modelPresetId: "a" })).toMatchObject({
            temperature: 60,
            maxContext: 1234,
        });
        expect(selection.presetId).toBe("a");
        expect(selection.modelPresetId).toBe("a");
        expect(activePreset.temperature).toBe(40);
        expect(activeMainProfile.maxContext).toBe(1234);
        // A preset that is gone (the caller refuses it first, `hasPreset`/`hasModelPreset`): no
        // fallback to another preset of either kind.
        expect(hasPreset("gone")).toBe(false);
        expect(hasModelPreset("gone")).toBe(false);
        const gone = buildDatabaseSubset(["temperature", "maxContext"], {
            presetId: "gone",
            modelPresetId: "a",
        }) as AnyRecord;
        expect(Object.hasOwn(gone, "temperature")).toBe(true);
        expect(gone.temperature).toBeUndefined();
        expect(gone.maxContext).toBe(1234);
        const modelGone = buildDatabaseSubset(["temperature", "maxContext"], {
            presetId: "a",
            modelPresetId: "gone",
        }) as AnyRecord;
        expect(modelGone.temperature).toBe(40);
        expect(Object.hasOwn(modelGone, "maxContext")).toBe(true);
        expect(modelGone.maxContext).toBeUndefined();
    });

    it("is detached: a write into the subset changes no record, no chat, and queues nothing", () => {
        boot();
        const subset = buildDatabaseSubset(ALLOWED_DB_KEYS, null) as AnyRecord;
        subset.characters[0].name = "renamed in the subset";
        subset.characters[0].chats[0].message.push({ chatId: "z", role: "char", data: "Z" });
        subset.personas[0].name = "renamed too";
        subset.characterOrder.push("stray");
        subset.pluginCustomStorage.plain = 3;
        expect(characterList()[0].name).toBe("Alice");
        expect(findChat({ chaId: "c1", chatId: "k" })!.message).toHaveLength(1);
        expect(settings.personas[0].name).toBe("Ann");
        expect(plainClone(settings.characterOrder)).toEqual(fixture().characterOrder);
        expect((settings.pluginStorage as AnyRecord).plain).toBe(2);
        expect(notified).toEqual([]);
    });
});

describe("buildSettingsReport", () => {
    it("is the root snapshot without the component's removal list, the llmSecrets fields, and every key named like a credential, plus meta", () => {
        boot();
        const root = rootSnapshot();
        const report = buildSettingsReport();
        const expected = Object.keys(root).filter((key) => !componentDropped(key));
        expect(
            Object.keys(report)
                .filter((key) => key !== "meta")
                .sort(),
        ).toEqual(expected.sort());
        for (const key of expected) {
            expect(report[key], key).toEqual(root[key]);
        }
        expect(report.meta).toEqual({ isNodeServer: true, protocol: location.protocol });
        // The removal list is not empty by accident: the fixture holds values on both sides of it.
        expect(expected).toEqual(expect.arrayContaining(["theme", "textTheme", "temperature", "didFirstSetup"]));
        expect(expected).toEqual(expect.arrayContaining(["botPresetsId", "selectedPersona", "loreBookPage"]));
        for (const dropped of [
            "characters",
            "personas",
            "username",
            "userIcon",
            "personaPrompt",
            "botPresets",
            "pluginCustomStorage",
            "characterOrder",
            "promptTemplate",
            "proxyKey",
            "openAIKey",
            "claudeAPIKey",
            "hypaV3",
            "togglePresets",
        ]) {
            expect(Object.hasOwn(report, dropped), dropped).toBe(false);
        }
    });

    it("carries no credential text and is detached from the records", () => {
        boot();
        expect(rootSnapshot().openAIKey).toBe("sk-secret-in-record");
        const report = buildSettingsReport();
        const text = JSON.stringify(report);
        expect(text).not.toContain("sk-secret-in-record");
        expect(text).toContain('"theme":"dark"');
        report.theme = "light";
        (report.meta as AnyRecord).protocol = "x:";
        expect(settings.ui.theme).toBe("dark");
        expect(notified).toEqual([]);
    });
});

describe("buildBackupInventory", () => {
    it("lists each character's asset fields without its chats, and the selected persona's icon with the four other settings", () => {
        boot();
        const inventory = buildBackupInventory() as unknown as AnyRecord;
        expect(inventory.characters).toEqual([
            {
                name: "Alice",
                type: "character",
                image: "img-alice",
                emotionImages: [["happy", "asset-happy"]],
                additionalAssets: [["a1", "asset-a1", "png"]],
            },
            { name: "Group", type: "group", image: "img-group" },
        ]);
        for (const entry of inventory.characters) {
            expect(Object.hasOwn(entry, "chats")).toBe(false);
            expect(Object.hasOwn(entry, "chatPage")).toBe(false);
            expect(Object.hasOwn(entry, "chaId")).toBe(false);
        }
        expect(inventory.userIcon).toBe("icon-ann");
        expect(inventory.customBackground).toBe("asset-bg");
        expect(inventory.personas.map((entry: AnyRecord) => entry.icon)).toEqual(["icon-ann", "icon-bob"]);
        expect(inventory.characterOrder).toEqual(fixture().characterOrder);
        expect(inventory.botPresets.map((entry: AnyRecord) => entry.id)).toEqual(["a", "b"]);
        selectPersona("p2");
        expect((buildBackupInventory() as unknown as AnyRecord).userIcon).toBe("icon-bob");
        expect(selectedPresetIndex()).toBe(0);
        expect(notified).toEqual([]);
    });

    it("is detached: a write into the inventory changes no record and queues nothing", () => {
        boot();
        const inventory = buildBackupInventory() as unknown as AnyRecord;
        inventory.characters[0].image = "other";
        inventory.personas[0].icon = "other";
        inventory.botPresets.pop();
        inventory.characterOrder.length = 0;
        expect(characterList()[0].image).toBe("img-alice");
        expect(settings.personas[0].icon).toBe("icon-ann");
        expect(settings.presets).toHaveLength(2);
        expect(plainClone(settings.characterOrder)).toEqual(fixture().characterOrder);
        expect(notified).toEqual([]);
    });
});
