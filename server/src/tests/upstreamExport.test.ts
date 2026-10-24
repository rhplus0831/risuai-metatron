// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { Credential, ModelPreset, ModelProfile, RisuPersona, botPreset } from "../../../shared/database.ts";
import { LLMFormat, LLMTokenizer } from "../../../shared/llm.ts";
import { RESOURCE_KIND, type ResourceKindName } from "../../../shared/resources.ts";
import { COLLECTION_KIND, DROPPED_FIELDS, SECTION_KIND } from "../../../shared/sections.ts";
import type { UpstreamReportEntry } from "../../../shared/upstreamBackup.ts";
import type { UpstreamExportReport } from "../../../shared/upstreamExportReport.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore, type ValidatedSnapshot } from "../data/resourceStore.ts";
import { collectUpstreamAssetReferences } from "../data/upstream/assetReferences.ts";
import { buildUpstreamDatabase, type UpstreamExportOptions } from "../data/upstream/exportDatabase.ts";
import { convertUpstreamDatabase, type UpstreamConversion } from "../data/upstream/importDatabase.ts";
import { decodeUpstreamDatabase, encodeUpstreamDatabase } from "../data/upstream/risuSave.ts";

// The store copy → upstream flat `Database` exporter, on a synthetic store (never a real backup): a
// store is seeded, copied with `backupTo`, read back with `readSnapshot` (the rows the route hands
// the exporter), and projected. Covers the counterexamples (`formatversion` and the override roots,
// auxiliary keys without `includeSecrets`, the named-key placement order and reservations, sub-slot
// proxy keys and option loss, the translator shape and both selections, boot-crashing shapes, the
// asset walker, character fields, trash and interaction times, dangling and orphan named keys,
// Vertex bindings, false/zero settings), ordering, input immutability, and the round trip through
// the `risuSave.ts` codec and the import converter: settings, presets, personas, and secrets, and
// the library written into a fresh staged store as the import does (characters and groups with their
// chats in order and message ids, toggles, modules and plugins, trash times and group members).

type Root = Record<string, unknown>;
type Entry = UpstreamReportEntry<string>;

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const LIMIT = { maxDecodedBytes: 64 * 1024 * 1024 };
/** The export time of every test: 2033, so a 2020s trash time is long expired and nothing depends on the clock. */
const NOW = 2_000_000_000_000;
const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------------------------
// The synthetic library

const KEYS = {
    rootOpenAI: "sk-root-OPENAI-ROOT-0001",
    rootClaude: "sk-ant-ROOT-0002",
    rootGoogle: "gcp-access-ROOT-0003",
    rootVertexKey: "pem-vertex-ROOT-0004",
    rootVertexToken: "cached-VERTEX-TOKEN-0005",
    deepseek: "ds-oaicomp-ROOT-0006",
    proxy: "proxy-NAMED-0007",
    custom: "custom-model-NAMED-0008",
    openaiB: "sk-named-B-0009",
    orphan: "orphan-no-metadata-0010",
    nai: "nai-aux-KEY-0011",
    deepl: "deepl-aux-KEY-0012",
    tts: "tts-character-KEY-0013",
    mcpRefresh: "mcp-refresh-TOKEN-0014",
    mcpSecret: "mcp-client-SECRET-0015",
};

/** The keys an `includeSecrets` export places somewhere upstream reads. */
const PLACED_WITH_SECRETS = [
    KEYS.rootOpenAI,
    KEYS.rootClaude,
    KEYS.rootGoogle,
    KEYS.rootVertexKey,
    KEYS.rootVertexToken,
    KEYS.deepseek,
    KEYS.proxy,
    KEYS.custom,
    KEYS.nai,
    KEYS.deepl,
    KEYS.tts,
    KEYS.mcpRefresh,
    KEYS.mcpSecret,
];

type Writer = {
    put: (kind: string, id: string, data: unknown) => void;
    chat: (characterId: string, chatId: string, chat: Root, index?: number) => void;
};

/**
 * The standard library: two prompt presets (A with a context override), three model presets (A:
 * OpenAI main without a key, a keyed reverse-proxy sub with its own URL, a keyed custom-model
 * translate slot; B: a keyed OpenAI profile; C: the default-backed main with B's keyed sub), named
 * keys with an orphan value, two personas (one with module links, one with an embedded module),
 * two translator and HypaV3 presets with the second selected, lorebooks and folders with shapes
 * upstream's boot trips on, device plugin storage, and four characters: Alice (every asset role,
 * two chats in a non-creation order, toggles, an inlay, a translation), Bob (trashed long ago),
 * Zed (`trashTime: 0`), and a group.
 */
function seedLibrary(w: Writer): void {
    w.put(SECTION_KIND.llmSecrets, "main", {
        openAIKey: KEYS.rootOpenAI,
        claudeAPIKey: KEYS.rootClaude,
        google: { accessToken: KEYS.rootGoogle, projectId: "root-project" },
        vertexPrivateKey: KEYS.rootVertexKey,
        vertexClientEmail: "root@example.iam",
        vertexAccessToken: KEYS.rootVertexToken,
        vertexAccessTokenExpires: 9_000_000_000_000,
        OaiCompAPIKeys: { deepseek: KEYS.deepseek },
        credentials: {
            credProxy: { key: KEYS.proxy },
            credCustom: { key: KEYS.custom },
            credOpenaiB: { key: KEYS.openaiB },
            credOrphan: { key: KEYS.orphan },
        },
    });
    w.put(COLLECTION_KIND.credentials, "main", [
        { id: "credProxy", name: "Proxy key", type: "custom" },
        { id: "credCustom", name: "Custom key", type: "custom" },
        { id: "credOpenaiB", name: "B key", type: "openai" },
    ]);
    w.put(COLLECTION_KIND.customModels, "main", [
        {
            id: "xcustom:::m1",
            internalId: "m1",
            url: "https://custom.example/v1",
            format: LLMFormat.OpenAICompatible,
            tokenizer: LLMTokenizer.Unknown,
            name: "Custom M1",
            params: "",
            flags: [],
        },
    ]);
    w.put(COLLECTION_KIND.modelProfiles, "main", [
        { id: "pMain", name: "Main", modelId: "gpt4o", maxContext: 4000 },
        {
            id: "pProxy",
            name: "Proxy",
            modelId: "reverse_proxy",
            credentialId: "credProxy",
            forceReplaceUrl: "https://proxy.example/v1",
            proxyRequestModel: "custom",
            customProxyRequestModel: "my-proxy-model",
        },
        { id: "pCustom", name: "Custom", modelId: "xcustom:::m1", credentialId: "credCustom", maxContext: 4000 },
        { id: "pB", name: "OpenAI B", modelId: "gpt4om", credentialId: "credOpenaiB", maxContext: 4000 },
    ]);
    w.put(COLLECTION_KIND.modelPresets, "main", [
        {
            id: "mpA",
            name: "Model A",
            mainSlot: { profileId: "pMain" },
            subSlot: { profileId: "pProxy" },
            auxSlots: { translate: { profileId: "pCustom" } },
            seperateModelsForAxModels: true,
        },
        { id: "mpB", name: "Model B", mainSlot: { profileId: "pB" }, subSlot: { profileId: "pB" }, auxSlots: {} },
        { id: "mpC", name: "Model C", mainSlot: { profileId: "pMain" }, subSlot: { profileId: "pB" }, auxSlots: {} },
    ]);
    w.put(RESOURCE_KIND.presets, "main", [
        {
            id: "ppA",
            name: "Prompt A",
            image: "assets/presetA.png",
            mainPrompt: "A main",
            temperature: 70,
            maxContextOverride: true,
            maxContextOverrideSize: 8000,
        },
        { id: "ppB", name: "Prompt B", mainPrompt: "B main", temperature: 50 },
    ]);
    w.put(COLLECTION_KIND.personas, "main", [
        { id: "u1", name: "Uma", personaPrompt: "I am Uma", icon: "assets/uma.png", modules: ["mod1"] },
        {
            id: "u2",
            name: "Vic",
            personaPrompt: "I am Vic",
            icon: "assets/vic.png",
            embeddedModule: {
                id: "em",
                name: "Embedded",
                lorebook: [{ key: "e", content: "embedded" }, null],
                assets: [["pic", "assets/embedded.png", "png"]],
                icon: "assets/embedded-icon.png",
            },
        },
    ]);
    w.put(COLLECTION_KIND.translatorPresets, "main", {
        items: [
            {
                id: "t1",
                name: "T1",
                steps: [
                    {
                        id: "s1",
                        name: "Only",
                        prompt: "P1",
                        maxResponse: 500,
                        enabled: true,
                        model: { mode: "inherit" },
                    },
                ],
            },
            {
                id: "t2",
                name: "T2",
                steps: [
                    { id: "s2a", name: "Off", prompt: "disabled", maxResponse: 100, enabled: false },
                    { id: "s2b", name: "On", prompt: "P2", maxResponse: 700, enabled: true },
                ],
            },
        ],
        selectedId: "t2",
    });
    w.put(COLLECTION_KIND.hypaV3Presets, "main", {
        items: [
            { id: "h1", name: "H1", settings: {} },
            { id: "h2", name: "H2", settings: {} },
        ],
        selectedId: "h2",
    });
    w.put(COLLECTION_KIND.characterOrder, "main", [
        "c1",
        { name: "Folder", id: "f1", data: ["c2", 5], img: "assets/folder.png", imgFile: "assets/folder-file.png" },
        { name: "F" },
    ]);
    w.put(COLLECTION_KIND.loreBook, "main", [
        { name: "Page", data: [{ key: "k", content: "entry" }, { key: "bad", content: 5 }, "junk"] },
    ]);
    w.put(RESOURCE_KIND.modules, "main", [
        {
            id: "mod1",
            name: "Mod",
            lorebook: [null, { key: "m", content: "module entry" }],
            assets: [["pic", "assets/module.png", "png"]],
            icon: "assets/module-icon.png",
        },
    ]);
    w.put(RESOURCE_KIND.plugins, "main", [{ name: "plug", displayName: "Plug" }]);
    w.put(RESOURCE_KIND.pluginStorage, "main", {
        _pluginStorage: { a: 1, b: 2 },
        _safeLocalPluginStorage: { c: 3 },
        _coldplugin: { d: 4 },
        keep: "yes",
    });
    w.put(SECTION_KIND.secrets, "main", {
        NAIApiKey: KEYS.nai,
        deeplOptions: { key: KEYS.deepl, upgradedAPI: true },
        googleSearchCredentials: { apiKey: "", cx: "cx-1" },
    });
    w.put(SECTION_KIND.providers, "main", { requestHistoryContent: false });
    w.put(SECTION_KIND.ui, "main", { chatScreenWidth: 0, customBackground: "assets/background.png" });
    w.put(COLLECTION_KIND.authRefreshes, "main", [
        {
            url: "https://mcp.example",
            tokenUrl: "https://mcp.example/token",
            refreshToken: KEYS.mcpRefresh,
            clientId: "client-1",
            clientSecret: KEYS.mcpSecret,
        },
    ]);

    w.put(RESOURCE_KIND.characters, "c1", {
        chaId: "c1",
        type: "character",
        name: "Alice",
        image: "assets/alice.png",
        emotionImages: [["happy", "assets/happy.png"]],
        additionalAssets: [["bg", "assets/bg.png", "png"]],
        vits: { files: { voice: "assets/voice.wav" } },
        ccAssets: [{ type: "icon", uri: "assets/cc.png", name: "cc", ext: "png" }],
        gptSoVitsConfig: { ref_audio_data: { assetId: "assets/ref.wav", name: "ref" } },
        oaiTTSConfig: { apiKey: KEYS.tts, model: "tts-1", voice: "alloy" },
        globalLore: [{ key: "g", content: "global" }, null],
        customNotificationMessage: "Alice answered",
        supaMemoryOnCount: 3,
        lastInteraction: 1000,
    });
    w.chat("c1", "k1", {
        name: "K1",
        pinned: true,
        togglePresetId: "tp",
        promptPresetId: "ppA",
        modelPresetId: "mpA",
        translatorPresetId: "t1",
        autoTranslate: true,
        translateBotOnly: false,
        bilingualDisplay: true,
        bilingualEmphasis: "original",
        bilingualSentences: 2,
        GLGlobalVariables: { toggle_x: "1" },
        localLore: [{ key: "l", content: "local" }, 7],
        lastDate: 500,
        message: [
            {
                role: "user",
                data: "hello {{inlay::abc}}",
                time: 1000,
                translation: { text: "안녕", sourceHash: "h1", targetLanguage: "ko", translatedAt: 1 },
            },
            { role: "char", data: "hi there", time: 3000 },
        ],
    });
    w.chat("c1", "k2", { name: "K2", message: [{ role: "user", data: "second", time: 2000 }] }, 0);
    w.put(RESOURCE_KIND.characters, "c2", {
        chaId: "c2",
        type: "character",
        name: "Bob",
        trashTime: 1000,
        lastInteraction: 500,
    });
    w.chat("c2", "kb", { name: "KB", message: [{ role: "user", data: "bob", time: 2500 }] });
    w.put(RESOURCE_KIND.characters, "c3", { chaId: "c3", type: "character", name: "Zed", trashTime: 0 });
    w.put(RESOURCE_KIND.characters, "g1", {
        chaId: "g1",
        type: "group",
        name: "Group",
        image: "assets/group.png",
        characters: ["c1", "c2"],
        characterTalks: [1, 1],
        characterActive: [true, true],
    });
}

/** Seeds a store, copies it as the route does, and reads the copy back. */
async function snapshotOf(seed: (w: Writer) => void = seedLibrary): Promise<ValidatedSnapshot> {
    const store = createResourceStore({ file: ":memory:", kinds });
    try {
        const w: Writer = {
            put(kind, id, data) {
                const row = store.get(kinds.get(kind)!, id);
                store.applyChanges({
                    ops: [{ kind: kinds.get(kind)!, id, baseRevision: row?.revision ?? null, data }],
                });
            },
            chat(characterId, chatId, chat, index) {
                store.applyChanges({
                    chats: [{ characterId, chatId, baseRevision: null, ops: [{ op: "create", chat, index }] }],
                });
            },
        };
        seed(w);
        const dir = mkdtempSync(path.join(os.tmpdir(), "risu-upstream-export-"));
        dirs.push(dir);
        const file = path.join(dir, "copy.sqlite");
        await store.backupTo(file);
        return store.readSnapshot(file);
    } finally {
        store.close();
    }
}

const SELECT_A: UpstreamExportOptions = {
    promptPresetId: "ppA",
    modelPresetId: "mpA",
    personaId: "u1",
    includeSecrets: false,
    now: NOW,
};

function exportOf(snapshot: ValidatedSnapshot, options: Partial<UpstreamExportOptions> = {}) {
    return buildUpstreamDatabase(snapshot.rows, snapshot, { ...SELECT_A, ...options });
}

const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);
const entry = (list: Entry[], code: string) => list.find((item) => item.code === code);
const excluded = (report: UpstreamExportReport, code: string) => entry(report.excluded, code);
const converted = (report: UpstreamExportReport, code: string) => entry(report.converted, code);
const characterNamed = (db: Root, name: string) => {
    const found = (db.characters as Root[]).find((character) => character.name === name);
    expect(found, name).toBeDefined();
    return found!;
};
const chatsOf = (db: Root, name: string) => characterNamed(db, name).chats as Root[];

/** The gzip payload of an encoded database as text: what a byte search of the archive can see. */
const payloadText = (bytes: Uint8Array) => Buffer.from(gunzipSync(bytes.subarray(11))).toString("latin1");

function record<T>(out: UpstreamConversion, kind: ResourceKindName): T {
    const found = out.resources.filter((resource) => resource.kind === kind);
    expect(found, kind).toHaveLength(1);
    return found[0].data as T;
}

/** Export → encode → decode → convert. */
function roundTrip(snapshot: ValidatedSnapshot, options: Partial<UpstreamExportOptions> = {}) {
    const exported = exportOf(snapshot, options);
    const decoded = decodeUpstreamDatabase(encodeUpstreamDatabase(exported.db), LIMIT);
    return { exported, decoded: decoded as Root, imported: convertUpstreamDatabase(decoded) };
}

/** `roundTrip` with the import options an upstream import passes: the exported asset keys as the archive's, and the export time. */
function libraryRoundTrip(snapshot: ValidatedSnapshot, options: Partial<UpstreamExportOptions> = {}) {
    const exported = exportOf(snapshot, options);
    const decoded = decodeUpstreamDatabase(encodeUpstreamDatabase(exported.db), LIMIT) as Root;
    const imported = convertUpstreamDatabase(decoded, {
        cold: new Map(),
        assetKeys: new Set(exported.assetKeys.map((asset) => asset.key)),
        now: NOW,
    });
    return { exported, decoded, imported };
}

/** Writes a conversion into a fresh store in the converter's hand-off order and reads its `backupTo` copy back. */
async function stage(out: UpstreamConversion): Promise<ValidatedSnapshot> {
    const store = createResourceStore({ file: ":memory:", kinds });
    try {
        for (const resource of out.resources) {
            const kind = kinds.get(resource.kind)!;
            store.put(kind, resource.id, resource.data, store.get(kind, resource.id)?.revision ?? null);
        }
        for (const character of out.characters) {
            store.put(kinds.get(RESOURCE_KIND.characters)!, character.id, character.data, null);
        }
        store.applyChanges({ chats: out.chats });
        const dir = mkdtempSync(path.join(os.tmpdir(), "risu-upstream-export-"));
        dirs.push(dir);
        const file = path.join(dir, "staged.sqlite");
        await store.backupTo(file);
        return store.readSnapshot(file);
    } finally {
        store.close();
    }
}

/**
 * A snapshot's characters by id, each with its chats in chat order and their messages in order: the
 * ids, names, and the message fields an export carries (translations are left out), the group
 * speaker (`saying`) included.
 */
function libraryOf(snapshot: ValidatedSnapshot) {
    const messages = new Map<number, { position: number; data: string }[]>();
    for (const message of snapshot.messages) {
        messages.set(message.chatSeq, [...(messages.get(message.chatSeq) ?? []), message]);
    }
    const chats = new Map(snapshot.chats.map((chat) => [chat.id + "\0" + chat.characterId, chat]));
    const orders = new Map(snapshot.chatOrders.map((order) => [order.characterId, JSON.parse(order.ids) as string[]]));
    return Object.fromEntries(
        snapshot.rows
            .filter((row) => row.kind === RESOURCE_KIND.characters)
            .map((row) => [
                row.id,
                {
                    name: (JSON.parse(row.text) as Root).name,
                    chats: (orders.get(row.id) ?? []).map((id) => {
                        const chat = chats.get(id + "\0" + row.id)!;
                        return {
                            id,
                            name: (JSON.parse(chat.meta) as Root).name,
                            messages: (messages.get(chat.seq) ?? [])
                                .sort((a, b) => a.position - b.position)
                                .map((message) => {
                                    const { chatId, role, data, time, saying } = JSON.parse(message.data) as Root;
                                    return { chatId, role, data, time, saying };
                                }),
                        };
                    }),
                },
            ]),
    );
}

// ---------------------------------------------------------------------------------------------

describe("buildUpstreamDatabase: presets and the root", () => {
    it("exports one upstream preset per prompt preset, in stored order, with the chosen model preset", async () => {
        const { db, report } = exportOf(await snapshotOf());
        const presets = db.botPresets as Root[];
        expect(presets.map((preset) => preset.name)).toEqual(["Prompt A", "Prompt B"]);
        for (const preset of presets) {
            expect(preset.aiModel).toBe("gpt4o");
            expect(preset.subModel).toBe("reverse_proxy");
            expect(preset.seperateModels).toEqual({ memory: "", translate: "xcustom:::m1", emotion: "", otherAx: "" });
            expect(preset.seperateModelsForAxModels).toBe(true);
            for (const field of [
                "id",
                "archived",
                "maxContextOverride",
                "maxContextOverrideSize",
                "proxyCredentialId",
            ]) {
                expect(preset, field).not.toHaveProperty(field);
            }
            expect(preset).not.toHaveProperty("customTokenizer");
        }
        expect(presets[0].mainPrompt).toBe("A main");
        expect(presets[0].temperature).toBe(70);
        // The override wins over the main profile's context; without one the profile's applies.
        expect(presets[0].maxContext).toBe(8000);
        expect(presets[1].maxContext).toBe(4000);
        expect(presets[0].image).toBe("assets/presetA.png");
        expect(converted(report, "model-presets-flattened")).toMatchObject({
            count: 2,
            examples: ["Model B", "Model C"],
        });
        expect(report.counts.promptPresets).toBe(2);
    });

    it("fills the root from the selected pair and persona, and indexes the selection", async () => {
        const snapshot = await snapshotOf();
        const { db } = exportOf(snapshot, { promptPresetId: "ppB", personaId: "u2" });
        expect(db.botPresetsId).toBe(1);
        expect(db.mainPrompt).toBe("B main");
        expect(db.temperature).toBe(50);
        expect(db.maxContext).toBe(4000);
        expect(db.aiModel).toBe("gpt4o");
        expect(db.subModel).toBe("reverse_proxy");
        expect(db.selectedPersona).toBe(1);
        expect(db.username).toBe("Vic");
        expect(db.personaPrompt).toBe("I am Vic");
        expect(db).not.toHaveProperty("maxContextOverride");
        expect(db).not.toHaveProperty("maxContextOverrideSize");

        const first = exportOf(snapshot).db;
        expect(first.botPresetsId).toBe(0);
        expect(first.mainPrompt).toBe("A main");
        expect(first.maxContext).toBe(8000);
        expect(first.selectedPersona).toBe(0);
        expect(first.username).toBe("Uma");
    });

    it("falls back to the first records for unknown ids and reports it; botPresets is never empty", async () => {
        const { db, report } = exportOf(await snapshotOf(), {
            promptPresetId: "gone",
            modelPresetId: "gone",
            personaId: "gone",
        });
        expect((db.botPresets as Root[]).length).toBeGreaterThanOrEqual(1);
        expect(db.botPresetsId).toBe(0);
        expect(db.selectedPersona).toBe(0);
        expect(converted(report, "selection-fallback")).toMatchObject({
            count: 3,
            examples: ["Prompt A", "Model A", "Uma"],
        });

        // A store with nothing written: the normalizers' defaults still give one preset.
        const empty = exportOf(await snapshotOf(() => {}));
        expect((empty.db.botPresets as Root[]).length).toBeGreaterThanOrEqual(1);
        expect((empty.db.personas as Root[]).length).toBeGreaterThanOrEqual(1);
        expect(empty.db.formatversion).toBe(5);
    });

    it("reports a sub or auxiliary profile whose options the main profile's flattening loses", async () => {
        const snapshot = await snapshotOf();
        const { report } = exportOf(snapshot);
        // The proxy sub profile has its own URL and request model; the translate slot has none of its own.
        expect(excluded(report, "slot-options-flattened")).toMatchObject({ count: 1, examples: ["sub"] });
        // Model B uses one profile for both slots: nothing is lost.
        expect(excluded(exportOf(snapshot, { modelPresetId: "mpB" }).report, "slot-options-flattened")).toBeUndefined();
    });
});

describe("buildUpstreamDatabase: settings", () => {
    it("writes formatversion 5, keeps upstream shapes, and strips metatron-only settings with a report", async () => {
        const { db, report } = exportOf(await snapshotOf());
        expect(db.formatversion).toBe(5);
        expect(Array.isArray(db.hotkeys)).toBe(true);
        expect(db).not.toHaveProperty("fallbackModels");
        // `proxyKey` and `formatversion` are the two dropped roots upstream still reads.
        for (const field of DROPPED_FIELDS) {
            if (field !== "proxyKey" && field !== "formatversion") {
                expect(db, field).not.toHaveProperty(field);
            }
        }
        for (const field of [
            "chatScreenWidth",
            "googleSearchCredentials",
            "requestHistoryContent",
            "requestHistoryLimit",
            "togglePresets",
            "credentials",
            "modelPresets",
            "modelProfiles",
            "irisDialogue",
            "llmTranslationTarget",
            "newChatBinding",
            "translatorHistoryMaxTokens",
        ]) {
            expect(db, field).not.toHaveProperty(field);
        }
        // Changed settings are reported, false and zero included; settings at their default are not.
        const settings = excluded(report, "metatron-settings")!;
        expect(settings.examples).toEqual(
            expect.arrayContaining(["requestHistoryContent", "chatScreenWidth", "googleSearchCredentials"]),
        );
        expect(settings.examples).not.toContain("requestHistoryLimit");
        expect(settings.examples).not.toContain("togglePresets");
        expect(settings.examples).not.toContain("credentials");
    });

    it("converts translator presets to upstream's shape from the first enabled step and selects by position", async () => {
        const { db, report } = exportOf(await snapshotOf());
        expect(db.translatorPresets).toEqual([
            { name: "T1", prompt: "P1", maxResponse: 500 },
            { name: "T2", prompt: "P2", maxResponse: 700 },
        ]);
        expect(db.translatorPresetId).toBe(1);
        expect(db.hypaV3PresetId).toBe(1);
        expect((db.hypaV3Presets as Root[]).map((preset) => preset.name)).toEqual(["H1", "H2"]);
        expect(excluded(report, "translator-steps")).toMatchObject({ count: 1, examples: ["T2"] });
    });

    it("repairs the shapes upstream's boot walks unchecked and reports each path", async () => {
        const { db, report } = exportOf(await snapshotOf());
        expect(db.characterOrder).toEqual([
            "c1",
            { name: "Folder", id: "f1", data: ["c2"], img: "assets/folder.png", imgFile: "assets/folder-file.png" },
            { name: "F", data: [] },
        ]);
        expect((db.loreBook as Root[])[0].data).toEqual([
            { key: "k", content: "entry" },
            { key: "bad", content: "" },
        ]);
        expect((db.modules as Root[])[0].lorebook).toEqual([{ key: "m", content: "module entry" }]);
        expect(((db.personas as Root[])[1].embeddedModule as Root).lorebook).toEqual([
            { key: "e", content: "embedded" },
        ]);
        expect(characterNamed(db, "Alice").globalLore).toEqual([{ key: "g", content: "global" }]);
        expect(chatsOf(db, "Alice")[1].localLore).toEqual([{ key: "l", content: "local" }]);
        const repaired = converted(report, "shape-repaired")!;
        expect(repaired.count).toBe(7);
        expect(repaired.examples).toHaveLength(5);
        expect(repaired.examples).toEqual(
            expect.arrayContaining(["characterOrder[1]", "characterOrder[2]", "loreBook[0]", "modules[0].lorebook"]),
        );
    });

    it("strips the persona module links and reports them", async () => {
        const { db, report } = exportOf(await snapshotOf());
        const personas = db.personas as Root[];
        expect(personas.map((persona) => persona.name)).toEqual(["Uma", "Vic"]);
        expect(personas[0]).not.toHaveProperty("modules");
        expect(excluded(report, "persona-modules")).toMatchObject({ count: 1, examples: ["Uma"] });
        expect(report.counts.personas).toBe(2);
    });
});

describe("buildUpstreamDatabase: characters and chats", () => {
    it("strips lore overrides from every exported character and group chat", async () => {
        const snapshot = await snapshotOf((w) => {
            for (const type of ["character", "group"]) {
                w.put(RESOURCE_KIND.characters, type, { chaId: type, name: type, type });
                for (const id of ["one", "two"]) {
                    w.chat(type, id, {
                        name: id,
                        message: [{ role: "user", data: `${type} ${id}`, chatId: "m" }],
                        loreOverrides: [{ entry: { id: "owner", content: "Only in metatron" }, off: id === "one" }],
                    });
                }
            }
        });
        const { db } = exportOf(snapshot);
        for (const type of ["character", "group"]) {
            const chats = chatsOf(db, type);
            expect(chats.map((chat) => chat.name)).toEqual(["one", "two"]);
            for (const chat of chats) {
                expect(chat).not.toHaveProperty("loreOverrides");
                expect(chat.message).toEqual([{ role: "user", data: `${type} ${chat.name}`, chatId: "m" }]);
            }
        }
    });

    it("rebuilds chats in chatOrders order, strips metatron chat fields and translations, and sets lastDate", async () => {
        const { db, report } = exportOf(await snapshotOf(), { selectedChat: { characterId: "c1", chatId: "k1" } });
        const alice = characterNamed(db, "Alice");
        const chats = alice.chats as Root[];
        expect(chats.map((chat) => chat.name)).toEqual(["K2", "K1"]);
        expect(alice.chatPage).toBe(1);
        expect(characterNamed(db, "Bob").chatPage).toBe(0);
        const k1 = chats[1];
        for (const field of [
            "pinned",
            "togglePresetId",
            "promptPresetId",
            "modelPresetId",
            "translatorPresetId",
            "autoTranslate",
            "translateBotOnly",
            "bilingualDisplay",
            "bilingualEmphasis",
            "bilingualSentences",
        ]) {
            expect(k1, field).not.toHaveProperty(field);
        }
        expect(k1.id).toBe("k1");
        expect(k1.useLocallySetGlobalVariables).toBe(true);
        expect(k1.GLGlobalVariables).toEqual({ toggle_x: "1" });
        expect(chats[0]).not.toHaveProperty("useLocallySetGlobalVariables");
        const messages = k1.message as Root[];
        expect(messages.map((message) => message.data)).toEqual(["hello {{inlay::abc}}", "hi there"]);
        expect(messages[0]).not.toHaveProperty("translation");
        expect(messages.every((message) => typeof message.chatId === "string")).toBe(true);
        // The stored 500 is older than the newest message; the other chat keeps its message time.
        expect(k1.lastDate).toBe(3000);
        expect(chats[0].lastDate).toBe(2000);
        expect(excluded(report, "chat-fields")).toMatchObject({ count: 1 });
        expect(excluded(report, "chat-fields")!.examples).toEqual(expect.arrayContaining(["pinned", "togglePresetId"]));
        expect(excluded(report, "message-translations")).toMatchObject({ count: 1 });
        expect(excluded(report, "inlays")).toMatchObject({ count: 1, examples: ["Alice"] });
        // Zed and the group hold the empty first chat each.
        expect(report.counts).toMatchObject({ characters: 4, groups: 1, chats: 5, messages: 4 });
    });

    it("strips metatron character fields, refreshes an expired trash time only, and raises lastInteraction", async () => {
        const { db, report } = exportOf(await snapshotOf());
        const alice = characterNamed(db, "Alice");
        expect(alice).not.toHaveProperty("customNotificationMessage");
        expect(alice).not.toHaveProperty("supaMemoryOnCount");
        expect(excluded(report, "character-fields")).toMatchObject({
            count: 1,
            examples: ["customNotificationMessage", "supaMemoryOnCount"],
        });
        // Upstream deletes a character trashed three days ago at boot; zero means not trashed.
        expect(characterNamed(db, "Bob").trashTime).toBe(NOW);
        expect(characterNamed(db, "Zed").trashTime).toBe(0);
        expect(converted(report, "trash-time-refreshed")).toMatchObject({ count: 1, examples: ["Bob"] });
        // Upstream's cold storage reads lastInteraction: at least the newest chat.
        expect(alice.lastInteraction).toBe(3000);
        expect(characterNamed(db, "Bob").lastInteraction).toBe(2500);
        expect(characterNamed(db, "Zed")).not.toHaveProperty("lastInteraction");
        const group = characterNamed(db, "Group");
        expect(group.type).toBe("group");
        expect(group.characters).toEqual(["c1", "c2"]);
        // A character without chats gets upstream's empty first chat (upstream reads `chats[chatPage]` unguarded).
        expect(group.chats).toEqual([{ message: [], note: "", name: "Chat 1", localLore: [] }]);
        expect(chatsOf(db, "Zed")).toEqual([{ message: [], note: "", name: "Chat 1", localLore: [] }]);
    });

    it("leaves a recent trash time alone", async () => {
        const { db, report } = exportOf(
            await snapshotOf((w) => {
                w.put(RESOURCE_KIND.characters, "c", {
                    chaId: "c",
                    type: "character",
                    name: "Recent",
                    trashTime: NOW - THREE_DAYS + 1,
                });
            }),
        );
        expect(characterNamed(db, "Recent").trashTime).toBe(NOW - THREE_DAYS + 1);
        expect(converted(report, "trash-time-refreshed")).toBeUndefined();
    });

    it("strips device plugin storage and reports it", async () => {
        const { db, report } = exportOf(await snapshotOf());
        expect(db.pluginCustomStorage).toEqual({ keep: "yes" });
        expect(excluded(report, "plugin-storage")).toMatchObject({ count: 3, examples: ["plug"] });
        expect(db.plugins).toEqual([{ name: "plug", displayName: "Plug" }]);
        expect(report.counts).toMatchObject({ plugins: 1, modules: 1 });
    });
});

describe("buildUpstreamDatabase: assets", () => {
    it("collects every referenced asset once by role and moves the absent ones to missing", async () => {
        const { assetKeys, report } = exportOf(await snapshotOf(), {
            hasAsset: (key) => key !== "assets/bg.png",
        });
        const byKey = Object.fromEntries(assetKeys.map((asset) => [asset.key, asset]));
        expect(byKey).toMatchObject({
            "assets/alice.png": { owner: "Alice", role: "profile" },
            "assets/happy.png": { owner: "Alice", role: "emotion" },
            "assets/voice.wav": { owner: "Alice", role: "vits" },
            "assets/cc.png": { owner: "Alice", role: "ccAsset" },
            "assets/ref.wav": { owner: "Alice", role: "sovitsReference" },
            "assets/group.png": { owner: "Group", role: "profile" },
            "assets/background.png": { role: "background" },
            // The selected persona's icon is also the root `userIcon`, which the walker meets first.
            "assets/uma.png": { owner: "", role: "userIcon" },
            "assets/vic.png": { owner: "Vic", role: "persona" },
            "assets/embedded.png": { owner: "Vic", role: "module" },
            "assets/embedded-icon.png": { owner: "Vic", role: "moduleIcon" },
            "assets/folder.png": { owner: "Folder", role: "folder" },
            "assets/folder-file.png": { owner: "Folder", role: "folder" },
            "assets/presetA.png": { owner: "Prompt A", role: "preset" },
            "assets/module.png": { owner: "Mod", role: "module" },
            "assets/module-icon.png": { owner: "Mod", role: "moduleIcon" },
        });
        expect(Object.keys(byKey)).toHaveLength(16);
        expect(report.missing).toEqual([{ key: "assets/bg.png", owner: "Alice", role: "additional" }]);
        expect(report.counts.assets).toBe(16);
    });

    it("walks only assets/ keys and dedups a key referenced twice, keeping the first owner", () => {
        const assets = collectUpstreamAssetReferences({
            characters: [
                { name: "A", image: "assets/shared.png", emotionImages: [["e", "assets/shared.png"]] },
                { name: "B", image: "https://example/not-an-asset.png", emotionImages: [["x", 5]] },
            ],
            userIcon: "assets/user.png",
            personas: [{ name: "P", icon: "assets/shared.png" }],
        });
        expect(assets).toEqual([
            { key: "assets/shared.png", owner: "A", role: "profile" },
            { key: "assets/user.png", owner: "", role: "userIcon" },
        ]);
    });
});

describe("buildUpstreamDatabase: credentials", () => {
    it("without includeSecrets leaves no key in the decoded object or the archive payload and reports them", async () => {
        const snapshot = await snapshotOf();
        const { db, report } = exportOf(snapshot);
        const bytes = encodeUpstreamDatabase(db);
        const decodedText = JSON.stringify(decodeUpstreamDatabase(bytes, LIMIT));
        const raw = Buffer.from(bytes).toString("latin1");
        const payload = payloadText(bytes);
        for (const key of Object.values(KEYS)) {
            expect(decodedText, key).not.toContain(key);
            expect(payload, key).not.toContain(key);
            expect(raw, key).not.toContain(key);
        }
        expect(db.openAIKey).toBe("");
        expect(db.proxyKey).toBe("");
        expect((db.google as Root).accessToken).toBe("");
        expect((db.google as Root).projectId).toBe("root-project");
        expect(db.OaiCompAPIKeys).toEqual({});
        expect(db.vertexAccessToken).toBe("");
        expect(db.vertexAccessTokenExpires).toBe(0);
        for (const preset of db.botPresets as Root[]) {
            expect(preset.openAIKey).toBe("");
            expect(preset.proxyKey).toBe("");
        }
        expect((db.customModels as Root[])[0].key).toBe("");
        expect(db.NAIApiKey).toBe("");
        expect(db.deeplOptions as Root).toEqual({ key: "", upgradedAPI: true });
        expect(characterNamed(db, "Alice").oaiTTSConfig).toEqual({ apiKey: "", model: "tts-1", voice: "alloy" });
        expect(db.authRefreshes).toEqual([
            { url: "https://mcp.example", tokenUrl: "https://mcp.example/token", clientId: "client-1" },
        ]);
        const omitted = excluded(report, "api-keys")!;
        expect(omitted.examples).toHaveLength(5);
        expect(omitted.count).toBe(11);
        expect(excluded(report, "named-keys")).toBeUndefined();
        expect(converted(report, "named-key-to-field")).toBeUndefined();
    });

    it("with includeSecrets places the stored keys where upstream reads them (positive control)", async () => {
        const snapshot = await snapshotOf();
        const { db, report } = exportOf(snapshot, { includeSecrets: true });
        const bytes = encodeUpstreamDatabase(db);
        const decodedText = JSON.stringify(decodeUpstreamDatabase(bytes, LIMIT));
        const payload = payloadText(bytes);
        for (const key of PLACED_WITH_SECRETS) {
            expect(decodedText, key).toContain(key);
            expect(payload, key).toContain(key);
        }
        // Upstream has no place for a named key no chosen slot binds, nor for a value without metadata.
        for (const key of [KEYS.openaiB, KEYS.orphan]) {
            expect(decodedText, key).not.toContain(key);
        }
        expect(db.openAIKey).toBe(KEYS.rootOpenAI);
        expect(db.claudeAPIKey).toBe(KEYS.rootClaude);
        expect(db.google).toEqual({ accessToken: KEYS.rootGoogle, projectId: "root-project" });
        expect(db.OaiCompAPIKeys).toEqual({ deepseek: KEYS.deepseek });
        // The sub slot's reverse proxy key: upstream reads the same root proxyKey for any proxy request.
        expect(db.proxyKey).toBe(KEYS.proxy);
        for (const preset of db.botPresets as Root[]) {
            expect(preset.openAIKey).toBe(KEYS.rootOpenAI);
            expect(preset.proxyKey).toBe(KEYS.proxy);
        }
        expect((db.customModels as Root[])[0]).toMatchObject({ id: "xcustom:::m1", key: KEYS.custom });
        expect(db.NAIApiKey).toBe(KEYS.nai);
        expect(characterNamed(db, "Alice").oaiTTSConfig).toMatchObject({ apiKey: KEYS.tts });
        expect((db.authRefreshes as Root[])[0]).toMatchObject({
            refreshToken: KEYS.mcpRefresh,
            clientSecret: KEYS.mcpSecret,
        });
        expect(excluded(report, "api-keys")).toBeUndefined();
        // Proxy and custom-model keys are the import's inverse, not conversions; B and the orphan are left out.
        expect(converted(report, "named-key-to-field")).toBeUndefined();
        expect(excluded(report, "named-keys")).toMatchObject({ count: 2, examples: ["B key", "credOrphan"] });
    });

    it("writes a chosen slot's named key into the upstream field its model reads", async () => {
        const { db, report } = exportOf(await snapshotOf(), { includeSecrets: true, modelPresetId: "mpB" });
        expect(db.openAIKey).toBe(KEYS.openaiB);
        for (const preset of db.botPresets as Root[]) {
            expect(preset.openAIKey).toBe(KEYS.openaiB);
            expect(preset.proxyKey).toBe("");
        }
        expect(db.proxyKey).toBe("");
        // The custom model's key is the definition's own, whichever preset uses it.
        expect((db.customModels as Root[])[0].key).toBe(KEYS.custom);
        expect(converted(report, "named-key-to-field")).toMatchObject({ count: 1, examples: ["B key"] });
        expect(excluded(report, "named-keys")).toMatchObject({ count: 2, examples: ["Proxy key", "credOrphan"] });
    });

    it("lets a default-backed main slot keep the root key against a sub slot's named key", async () => {
        const { db, report } = exportOf(await snapshotOf(), { includeSecrets: true, modelPresetId: "mpC" });
        expect(db.openAIKey).toBe(KEYS.rootOpenAI);
        expect((db.botPresets as Root[])[0].openAIKey).toBe(KEYS.rootOpenAI);
        expect(converted(report, "named-key-to-field")).toBeUndefined();
        expect(excluded(report, "named-keys")!.examples).toEqual(expect.arrayContaining(["B key", "Proxy key"]));
    });

    it("reports a custom-model key whose definition is gone and a key without metadata", async () => {
        const { db, report } = exportOf(
            await snapshotOf((w) => {
                w.put(SECTION_KIND.llmSecrets, "main", {
                    credentials: { credDangling: { key: "dangling-KEY-1" }, credOrphan: { key: "orphan-KEY-2" } },
                });
                w.put(COLLECTION_KIND.credentials, "main", [{ id: "credDangling", name: "Dangling", type: "custom" }]);
                w.put(COLLECTION_KIND.modelProfiles, "main", [
                    { id: "pMain", name: "Main", modelId: "gpt4o" },
                    { id: "pDangling", name: "Dangling", modelId: "xcustom:::nope", credentialId: "credDangling" },
                ]);
                w.put(COLLECTION_KIND.modelPresets, "main", [
                    {
                        id: "mp",
                        name: "MP",
                        mainSlot: { profileId: "pMain" },
                        subSlot: { profileId: "pDangling" },
                        auxSlots: {},
                    },
                ]);
            }),
            { includeSecrets: true, modelPresetId: "mp" },
        );
        expect(db.customModels).toEqual([]);
        expect(JSON.stringify(db)).not.toContain("dangling-KEY-1");
        expect(JSON.stringify(db)).not.toContain("orphan-KEY-2");
        expect(excluded(report, "named-keys")).toMatchObject({ count: 2, examples: ["Dangling", "credOrphan"] });
    });

    it("places a Vertex binding with its project and clears the cached token; skips one without an email", async () => {
        const seedVertex = (email: string | undefined) => (w: Writer) => {
            w.put(SECTION_KIND.llmSecrets, "main", {
                vertexPrivateKey: KEYS.rootVertexKey,
                vertexClientEmail: "root@example.iam",
                vertexAccessToken: KEYS.rootVertexToken,
                vertexAccessTokenExpires: 9_000_000_000_000,
                google: { accessToken: "", projectId: "root-project" },
                credentials: { credV: { key: "pem-vertex-NAMED-B" } },
            });
            w.put(COLLECTION_KIND.credentials, "main", [
                {
                    id: "credV",
                    name: "Vertex B",
                    type: "vertex",
                    ...(email ? { clientEmail: email } : {}),
                    projectId: "proj-b",
                },
            ]);
            w.put(COLLECTION_KIND.modelProfiles, "main", [
                { id: "pV", name: "Vertex", modelId: "gemini-3.5-flash-vertex", credentialId: "credV" },
            ]);
            w.put(COLLECTION_KIND.modelPresets, "main", [
                { id: "mp", name: "MP", mainSlot: { profileId: "pV" }, subSlot: { profileId: "pV" }, auxSlots: {} },
            ]);
        };
        const placed = exportOf(await snapshotOf(seedVertex("svc@proj-b.iam")), {
            includeSecrets: true,
            modelPresetId: "mp",
        });
        expect(placed.db.vertexPrivateKey).toBe("pem-vertex-NAMED-B");
        expect(placed.db.vertexClientEmail).toBe("svc@proj-b.iam");
        expect((placed.db.google as Root).projectId).toBe("proj-b");
        expect(placed.db.vertexAccessToken).toBe("");
        expect(placed.db.vertexAccessTokenExpires).toBe(0);
        expect(converted(placed.report, "named-key-to-field")).toMatchObject({ count: 1, examples: ["Vertex B"] });
        expect(excluded(placed.report, "named-keys")).toBeUndefined();

        const skipped = exportOf(await snapshotOf(seedVertex(undefined)), {
            includeSecrets: true,
            modelPresetId: "mp",
        });
        expect(skipped.db.vertexPrivateKey).toBe(KEYS.rootVertexKey);
        expect(skipped.db.vertexClientEmail).toBe("root@example.iam");
        expect((skipped.db.google as Root).projectId).toBe("root-project");
        expect(skipped.db.vertexAccessToken).toBe(KEYS.rootVertexToken);
        expect(excluded(skipped.report, "named-keys")).toMatchObject({ count: 1, examples: ["Vertex B"] });

        const withoutSecrets = exportOf(await snapshotOf(seedVertex("svc@proj-b.iam")), { modelPresetId: "mp" });
        expect(withoutSecrets.db.vertexPrivateKey).toBe("");
        expect(withoutSecrets.db.vertexAccessToken).toBe("");
        expect(withoutSecrets.db.vertexAccessTokenExpires).toBe(0);
    });

    it("places a keyIdentifier model's named key into OaiCompAPIKeys", async () => {
        const { db } = exportOf(
            await snapshotOf((w) => {
                w.put(SECTION_KIND.llmSecrets, "main", {
                    OaiCompAPIKeys: { deepseek: "ds-ROOT" },
                    credentials: { credDs: { key: "ds-NAMED" } },
                });
                w.put(COLLECTION_KIND.credentials, "main", [{ id: "credDs", name: "DeepSeek", type: "custom" }]);
                w.put(COLLECTION_KIND.modelProfiles, "main", [
                    { id: "pDs", name: "DS", modelId: "deepseek-v4-flash", credentialId: "credDs" },
                ]);
                w.put(COLLECTION_KIND.modelPresets, "main", [
                    {
                        id: "mp",
                        name: "MP",
                        mainSlot: { profileId: "pDs" },
                        subSlot: { profileId: "pDs" },
                        auxSlots: {},
                    },
                ]);
            }),
            { includeSecrets: true, modelPresetId: "mp" },
        );
        expect(db.OaiCompAPIKeys).toEqual({ deepseek: "ds-NAMED" });
    });
});

describe("buildUpstreamDatabase: purity", () => {
    it("does not mutate the snapshot rows, the chat tables, or the options", async () => {
        const snapshot = await snapshotOf();
        const before = JSON.stringify(snapshot);
        const options: UpstreamExportOptions = {
            ...SELECT_A,
            includeSecrets: true,
            selectedChat: { characterId: "c1", chatId: "k1" },
            hasAsset: () => true,
        };
        const optionsBefore = JSON.stringify(options);
        const first = buildUpstreamDatabase(snapshot.rows, snapshot, options);
        expect(JSON.stringify(snapshot)).toBe(before);
        expect(JSON.stringify(options)).toBe(optionsBefore);
        // The result shares nothing with the rows: a second export is equal and independent.
        const second = buildUpstreamDatabase(snapshot.rows, snapshot, options);
        expect(second.db).toEqual(first.db);
        expect(second.report).toEqual(first.report);
        (first.db.characters as Root[])[0].name = "changed";
        expect((second.db.characters as Root[])[0].name).toBe("Alice");
    });

    it("encodes to bytes `decodeUpstreamDatabase` decodes back to the same database", async () => {
        const { db } = exportOf(await snapshotOf(), { includeSecrets: true });
        const decoded = decodeUpstreamDatabase(encodeUpstreamDatabase(db), LIMIT);
        expect(decoded).toEqual(JSON.parse(JSON.stringify(db)));
    });
});

describe("buildUpstreamDatabase: round trip through the import converter", () => {
    it("brings the settings, translator and HypaV3 selections back", async () => {
        const { imported } = roundTrip(await snapshotOf());
        const translator = record<{ items: Root[]; selectedId: string }>(imported, COLLECTION_KIND.translatorPresets);
        expect(translator.items.map((item) => item.name)).toEqual(["T1", "T2"]);
        expect((translator.items[1].steps as Root[]).map((step) => [step.prompt, step.maxResponse])).toEqual([
            ["P2", 700],
        ]);
        expect(translator.items.find((item) => item.id === translator.selectedId)?.name).toBe("T2");
        const hypa = record<{ items: Root[]; selectedId: string }>(imported, COLLECTION_KIND.hypaV3Presets);
        expect(hypa.items.find((item) => item.id === hypa.selectedId)?.name).toBe("H2");
        const providers = record<Root>(imported, SECTION_KIND.providers);
        expect(providers.requestHistoryContent).toBe(true);
        expect(record<Root[]>(imported, COLLECTION_KIND.loreBook)[0].data).toEqual([
            { key: "k", content: "entry" },
            { key: "bad", content: "" },
        ]);
        expect(excluded(imported.report as never, "unknown-setting")).toBeUndefined();
    });

    it("brings the prompt presets, the chosen model preset, and the selection back (semantic equivalence)", async () => {
        const { imported } = roundTrip(await snapshotOf(), { promptPresetId: "ppB", includeSecrets: true });
        const presets = record<botPreset[]>(imported, RESOURCE_KIND.presets);
        expect(presets.map((preset) => preset.name)).toEqual(["Prompt A", "Prompt B"]);
        expect(presets[0].mainPrompt).toBe("A main");
        expect(presets[0].temperature).toBe(70);
        // The override flattens into upstream's maxContext and seeds the size with the override off.
        expect(presets[0].maxContextOverrideSize).toBe(8000);
        expect(presets[1].maxContextOverrideSize).toBe(4000);
        expect(presets[1].maxContextOverride).not.toBe(true);
        expect(imported.selection.promptPresetId).toBe(presets[1].id);

        const modelPresets = record<ModelPreset[]>(imported, COLLECTION_KIND.modelPresets);
        const profiles = record<ModelProfile[]>(imported, COLLECTION_KIND.modelProfiles);
        const credentials = record<Credential[]>(imported, COLLECTION_KIND.credentials);
        const secrets = record<Root & { credentials: Record<string, { key: string }> }>(
            imported,
            SECTION_KIND.llmSecrets,
        );
        const profileOf = (slot: unknown) =>
            profiles.find((profile) => profile.id === (slot as { profileId: string }).profileId)!;
        const selected = modelPresets.find((preset) => preset.id === imported.selection.modelPresetId)!;
        expect(selected.name).toBe("Prompt B");
        expect(profileOf(selected.mainSlot).modelId).toBe("gpt4o");
        expect(profileOf(selected.mainSlot).maxContext).toBe(4000);
        expect(profileOf(selected.mainSlot).credentialId).toBeUndefined();
        const sub = profileOf(selected.subSlot);
        expect(sub.modelId).toBe("reverse_proxy");
        expect(credentials.find((credential) => credential.id === sub.credentialId)?.type).toBe("custom");
        expect(secrets.credentials[sub.credentialId!].key).toBe(KEYS.proxy);
        const translate = profileOf(selected.auxSlots.translate);
        expect(translate.modelId).toBe("xcustom:::m1");
        expect(secrets.credentials[translate.credentialId!].key).toBe(KEYS.custom);
        expect(selected.seperateModelsForAxModels).toBe(true);
        // Every exported preset shares the one proxy key, so the converter makes one credential of it.
        expect(Object.values(secrets.credentials).filter((entry) => entry.key === KEYS.proxy)).toHaveLength(1);
        expect(secrets.openAIKey).toBe(KEYS.rootOpenAI);
        expect(secrets.claudeAPIKey).toBe(KEYS.rootClaude);
        expect((secrets.google as Root).accessToken).toBe(KEYS.rootGoogle);
        expect((secrets.OaiCompAPIKeys as Root).deepseek).toBe(KEYS.deepseek);
        expect(Object.values(secrets.credentials).map((entry) => entry.key)).not.toContain(KEYS.openaiB);
    });

    it("brings the personas and the selected persona back", async () => {
        const { imported } = roundTrip(await snapshotOf(), { personaId: "u2" });
        const personas = record<RisuPersona[]>(imported, COLLECTION_KIND.personas);
        expect(personas.map((persona) => [persona.name, persona.personaPrompt, persona.icon])).toEqual([
            ["Uma", "I am Uma", "assets/uma.png"],
            ["Vic", "I am Vic", "assets/vic.png"],
        ]);
        expect(personas.find((persona) => persona.id === imported.selection.personaId)?.name).toBe("Vic");
    });

    it("brings no key back from an export made without includeSecrets", async () => {
        const { imported } = roundTrip(await snapshotOf());
        const secrets = record<Root & { credentials: Record<string, { key: string }> }>(
            imported,
            SECTION_KIND.llmSecrets,
        );
        expect(secrets.openAIKey).toBe("");
        expect(secrets.claudeAPIKey).toBe("");
        expect(secrets.OaiCompAPIKeys).toEqual({});
        expect(Object.values(secrets.credentials).every((entry) => entry.key === "")).toBe(true);
        expect(JSON.stringify(imported.resources)).not.toContain("NAMED");
    });

    it("brings every character and group back with its chats in order and its messages (chatId kept)", async () => {
        const original = await snapshotOf((w) => {
            seedLibrary(w);
            // Two group chats in a non-creation order, with message ids and speakers.
            w.chat("g1", "gk1", {
                name: "G1",
                message: [
                    { role: "char", data: "from Alice", saying: "c1", chatId: "gm1", time: 4000 },
                    { role: "user", data: "hi all", chatId: "gm2", time: 4100 },
                    { role: "char", data: "from Bob", saying: "c2", chatId: "gm3", time: 4200 },
                ],
            });
            w.chat(
                "g1",
                "gk2",
                { name: "G2", message: [{ role: "char", data: "Bob", saying: "c2", chatId: "gm4" }] },
                0,
            );
        });
        const { imported } = libraryRoundTrip(original);
        const staged = await stage(imported);
        const expected = libraryOf(original);
        const library = libraryOf(staged);
        expect(expected.g1.chats.map((chat) => chat.id)).toEqual(["gk2", "gk1"]);
        expect(expected.g1.chats[1].messages.map((message) => [message.chatId, message.saying])).toEqual([
            ["gm1", "c1"],
            ["gm2", undefined],
            ["gm3", "c2"],
        ]);
        // Zed had no chat: it comes back with the empty first chat the export gave it.
        expect(expected.c3.chats).toEqual([]);
        expected.c3.chats = [{ id: library.c3.chats[0]?.id, name: "Chat 1", messages: [] }];
        expect(library).toEqual(expected);
        expect(staged.rows.filter((row) => row.kind === RESOURCE_KIND.characters).map((row) => row.id)).toEqual([
            "c1",
            "c2",
            "c3",
            "g1",
        ]);
        expect(imported.report.counts).toMatchObject({ characters: 3, groups: 1, chats: 6, messages: 8 });
        expect(excluded(imported.report as never, "invalid-chat")).toBeUndefined();
        expect(excluded(imported.report as never, "invalid-character")).toBeUndefined();
    });

    it("brings a chat's toggles back from GLGlobalVariables with useLocallySetGlobalVariables", async () => {
        const original = await snapshotOf((w) => {
            seedLibrary(w);
            w.chat("c3", "kt", {
                name: "Toggles",
                GLGlobalVariables: { toggle_on: "1", toggle_unset: "", other: "" },
                message: [],
            });
        });
        const { exported, decoded, imported } = libraryRoundTrip(original);
        expect(chatsOf(exported.db, "Zed")[0]).toMatchObject({
            GLGlobalVariables: { toggle_on: "1", toggle_unset: "", other: "" },
            useLocallySetGlobalVariables: true,
        });
        expect(chatsOf(decoded, "Alice")[1].useLocallySetGlobalVariables).toBe(true);
        // A chat without toggle values gets no flag.
        expect(chatsOf(decoded, "Alice")[0].useLocallySetGlobalVariables).toBeUndefined();
        const staged = await stage(imported);
        const metas = new Map(staged.chats.map((chat) => [chat.id, JSON.parse(chat.meta) as Root]));
        // Upstream reads a non-"" chat value first whatever the flag, so the flag is dropped and the
        // "" toggles (upstream's "not set") are removed; other variables are kept as they are.
        expect(metas.get("kt")!.GLGlobalVariables).toEqual({ toggle_on: "1", other: "" });
        expect(metas.get("k1")!.GLGlobalVariables).toEqual({ toggle_x: "1" });
        for (const meta of metas.values()) {
            expect(meta).not.toHaveProperty("useLocallySetGlobalVariables");
        }
    });

    it("brings the modules (repaired lorebooks, assets, icons) and the plugins back", async () => {
        const plugins = [
            {
                name: "runner",
                displayName: "Runner",
                script: "console.log('runner')",
                arguments: { level: "int", mode: ["a", "b"] },
                realArg: { level: 2, mode: "b" },
                version: "3.0",
                customLink: [{ link: "https://plugin.example", hoverText: "Home" }],
                argMeta: { level: { label: "Level" } },
                versionOfPlugin: "1.2.0",
                updateURL: "https://plugin.example/runner.js",
                enabled: true,
                allowedIPC: ["other"],
            },
            { name: "plug", displayName: "Plug" },
        ];
        const original = await snapshotOf((w) => {
            seedLibrary(w);
            w.put(RESOURCE_KIND.plugins, "main", plugins);
        });
        const { exported, decoded, imported } = libraryRoundTrip(original);
        const modules = record<Root[]>(imported, RESOURCE_KIND.modules);
        expect(modules).toEqual([
            expect.objectContaining({
                id: "mod1",
                name: "Mod",
                lorebook: [expect.objectContaining({ key: "m", content: "module entry" })],
                assets: [["pic", "assets/module.png", "png"]],
                icon: "assets/module-icon.png",
            }),
        ]);
        const personas = record<RisuPersona[]>(imported, COLLECTION_KIND.personas);
        expect(personas.find((persona) => persona.name === "Vic")?.embeddedModule).toMatchObject({
            id: "em",
            lorebook: [expect.objectContaining({ key: "e", content: "embedded" })],
            assets: [["pic", "assets/embedded.png", "png"]],
            icon: "assets/embedded-icon.png",
        });
        const stored = JSON.parse(original.rows.find((row) => row.kind === RESOURCE_KIND.plugins)!.text) as Root[];
        expect(stored[0]).toEqual(plugins[0]);
        expect(record<Root[]>(imported, RESOURCE_KIND.plugins)).toEqual(stored);
        // Only the record without a version is kept but not run.
        expect(excluded(imported.report as never, "plugin-unsupported-version")).toMatchObject({
            count: 1,
            examples: ["plug"],
        });
        expect(record<Root>(imported, RESOURCE_KIND.pluginStorage)).toMatchObject({ keep: "yes" });
        expect(imported.report.missingAssets).toEqual([]);
        const staged = await stage(imported);
        const stagedModules = staged.rows.find((row) => row.kind === RESOURCE_KIND.modules)!;
        expect(JSON.parse(stagedModules.text)).toEqual(modules);
        expect(JSON.parse(staged.rows.find((row) => row.kind === RESOURCE_KIND.plugins)!.text)).toEqual(stored);
        // Both directions walk the same fields (one walker, `assetReferences.ts`): imported with no
        // asset, every key the export carries is reported missing by the same owner and role, except the
        // selected persona's icon, which the export meets first as the root `userIcon`.
        const missing = convertUpstreamDatabase(decoded, { cold: new Map(), assetKeys: new Set(), now: NOW }).report
            .missingAssets;
        expect(missing.map(({ key, owner, role }) => ({ key, owner, role })).sort(byKey)).toEqual(
            exported.assetKeys
                .map((asset) => (asset.role === "userIcon" ? { key: asset.key, owner: "Uma", role: "persona" } : asset))
                .sort(byKey),
        );
        expect(missing).toContainEqual({
            key: "assets/ref.wav",
            owner: "Alice",
            role: "sovitsReference",
            expected: true,
        });
        expect(missing).toContainEqual({
            key: "assets/module-icon.png",
            owner: "Mod",
            role: "moduleIcon",
            expected: false,
        });
        expect(exported.assetKeys.map((asset) => asset.key).sort()).toEqual(
            exportOf(staged)
                .assetKeys.map((asset) => asset.key)
                .sort(),
        );
    });

    it("keeps the trashed character with its refreshed trash time and the group's members", async () => {
        const { imported } = libraryRoundTrip(await snapshotOf());
        const staged = await stage(imported);
        const characters = new Map(
            staged.rows
                .filter((row) => row.kind === RESOURCE_KIND.characters)
                .map((row) => [row.id, JSON.parse(row.text) as Root]),
        );
        expect(characters.get("c2")).toMatchObject({ name: "Bob", trashTime: NOW });
        expect(characters.get("c3")?.trashTime).toBe(0);
        expect(characters.get("g1")).toMatchObject({
            type: "group",
            characters: ["c1", "c2"],
            characterTalks: [1, 1],
            characterActive: [true, true],
        });
        expect(excluded(imported.report as never, "group-member-missing")).toBeUndefined();
        // A second export of the staged store leaves the refreshed trash time alone.
        const again = exportOf(staged, { now: NOW + 1 });
        expect(characterNamed(again.db, "Bob").trashTime).toBe(NOW);
        expect(converted(again.report, "trash-time-refreshed")).toBeUndefined();
    });
});
