import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
import { newPersonaId } from "../../../../shared/presets.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { COLLECTION_KIND, RESIDUAL_ROOT_KEYS, SECTION_FIELDS, SECTION_KIND } from "../../../../shared/sections.ts";
import { createTranslatorPreset } from "../../../../shared/translatorPresets.ts";
import { FakeResourceServer } from "./fakeResourceServer";
import { materialize, serverNormalizer } from "./serverKinds";
import { StoreBackedServer } from "./storeBackedServer";

// Phase 3, slice 4 (`docs/plan/phases/slices/phase-3-settings-sections/client-section-mirrors.md`):
// the client mirrors of the five sections, the thirteen settings collections, and the residual
// `root`. Every boot here runs the real `loadData` sequence for the data: `readKinds`, `seedResources`,
// `assembleDatabase`, the real `setDatabase`, then the adapter's boot compare pass. The convergence
// rule of the implementation plan (A12) is the central contract: for every kind,
// `normalize(project(assemble(normalized)))` equals `normalized` as text, so an unchanged record is
// never written. The real server store (`storeBackedServer.ts`) materializes and normalizes the
// records; the in-memory fake (`fakeResourceServer.ts`) stores exactly what a test puts in it.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
}));

vi.mock("../nodeStorage", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
}));

vi.mock("../../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
}));

// `setDatabase` applies the stored language; the locale tables are not under test.
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored" },
    changeLanguage: vi.fn(),
}));

// `stores.svelte.ts` wires module updates into a module-level effect, and `database.svelte.ts`
// (reached through `process/scripts`) re-exports asset helpers; nothing under test needs them.
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

type Sync = typeof import("../resourceSync.svelte");
type Client = typeof import("../resourceClient");
type Stores = typeof import("../../stores.svelte");
type Bootstrap = typeof import("../../bootstrap");
type DatabaseModule = typeof import("../database.svelte");
type Secrets = typeof import("../llmSecrets.svelte");

type Server = FakeResourceServer | StoreBackedServer;

/** JSON text parsed into plain data: own `__proto__` keys stay own keys (`JSON.parse` defines them). */
const json = (text: string) => JSON.parse(text);
/** A plain copy of a mirror value, for `Object.hasOwn` checks that a Svelte proxy would answer differently. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

/** A fresh module graph with the server stand-in installed, without starting the adapter. */
async function fresh<S extends Server>(fake: S) {
    vi.resetModules();
    server.current = fake;
    const stores: Stores = await import("../../stores.svelte");
    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");
    const bootstrap: Bootstrap = await import("../../bootstrap");
    const database: DatabaseModule = await import("../database.svelte");
    const secrets: Secrets = await import("../llmSecrets.svelte");
    return { fake, stores, client, sync, bootstrap, database, secrets, db: () => stores.DBState.db as any };
}

/**
 * Boots the adapter the way `loadData` does: read, seed, assemble, the real `setDatabase`, start,
 * and let the boot compare pass run. `bootBatches` is what that pass sent.
 */
async function boot<S extends Server>(fake: S) {
    const modules = await fresh(fake);
    const { stores, client, sync, bootstrap, database } = modules;
    const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
    sync.seedResources(snapshot);
    database.setDatabase(bootstrap.assembleDatabase(snapshot));
    stores.selectedCharID.set(-1);
    fake.requests.length = 0;
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    const bootBatches = fake.batchBodies() as { ops: any[] }[];
    fake.requests.length = 0;
    return { ...modules, bootBatches };
}

/**
 * A fake with every materialized kind and the Phase 1 records a normal store holds. The default root
 * holds one residual key; `setDatabase` fills the other `RESIDUAL_ROOT_KEYS` and the boot pass
 * writes them once (the preset fields and the selection indexes are forwarded since slice 5).
 */
async function fakeStore(root: Record<string, unknown> | null = { username: "u" }) {
    const fake = new FakeResourceServer();
    if (root) {
        fake.set("root", "main", root);
    }
    // As the server stores a preset list: normalized, so `setDatabase`'s `normalizePresets` is a no-op.
    fake.set("presets", "main", (await serverNormalizer("presets"))([{ id: "preset-1", name: "p1" }]));
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    await materialize(fake);
    return fake;
}

const opKinds = (batches: { ops: any[] }[]) => batches.flatMap((batch) => batch.ops.map((op) => op.kind));

/** Non-default values for every materialized kind, as another client or an older store could hold them. */
const customRecords: Record<string, unknown> = {
    providers: {
        loreBookToken: 1234,
        useStreaming: true,
        presetChain: "chain",
        seperateParameters: {
            memory: {},
            emotion: {},
            translate: {},
            otherAx: {},
            overrides: json('{"__proto__":{"temperature":1},"gpt":{"temperature":2}}'),
        },
        fallbackModels: { model: ["m", ""], memory: [], emotion: [], translate: [], otherAx: [] },
    },
    secrets: { NAIApiKey: "nai", googleSearchCredentials: { apiKey: "k", searchEngineId: "e" } },
    llmSecrets: {
        openAIKey: "sk",
        OaiCompAPIKeys: json('{"__proto__":"proto-key","https://x":"k2"}'),
        presets: json('{"__proto__":{"proxyKey":"proto"},"preset-1":{"proxyKey":"p1"}}'),
    },
    ui: {
        zoomsize: 111,
        colorSchemeName: "custom",
        colorScheme: { bgcolor: "#000" },
        irisDialogue: [{ speaker: "Iris", text: "hi", tip: "t" }],
        customTextTheme: { FontColorStandard: "#fff" },
    },
    memoryTranslateMedia: { sdSteps: 31, NAIImgConfig: { width: 1 } },
    loreBook: [
        {
            name: "Book",
            data: [
                {
                    key: "k",
                    secondkey: "",
                    insertorder: 100,
                    comment: "c",
                    content: "x",
                    mode: "normal",
                    alwaysActive: false,
                    selective: false,
                },
            ],
        },
    ],
    globalscript: [{ comment: "s", type: "editinput", in: "a", out: "b", flag: "" }],
    hotkeys: [{ action: "scrollToActiveChar", key: "z", ctrl: true }],
    customSidebarItems: [{ name: "item" }],
    characterOrder: ["a", { name: "folder", data: ["b"], id: "f" }],
    authRefreshes: [{ url: "u", tokenUrl: "t", refreshToken: "r", clientId: "c" }],
    globalChatVariables: json('{"__proto__":"p","x":"1"}'),
    personas: [
        { id: "persona-1", name: "A", icon: "", personaPrompt: "", note: "", largePortrait: false },
        { name: "no id" },
    ],
    translatorPresets: {
        items: [
            { id: "t1", name: "T1", prompt: "p", maxResponse: 5 },
            { id: "t2", name: "T2" },
        ],
        selectedId: "t2",
    },
    hypaV3Presets: {
        items: [{ id: "h1", name: "H1", settings: { similarMemoryRatio: 0.5 } }, { id: "h2" }],
        selectedId: "h2",
    },
    customModels: [{ id: "m", internalId: "i", name: "M" }],
    enabledModules: ["mod"],
    statics: { messages: 3, imports: "bad" },
    presets: [
        {
            id: "preset-1",
            name: "P",
            temperature: 30,
            seperateParameters: {
                memory: {},
                emotion: {},
                translate: {},
                otherAx: {},
                overrides: json('{"__proto__":{"a":1},"gpt":{"b":2}}'),
            },
        },
        { name: "Q" },
    ],
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe("fixed point and no echo (the convergence rule) on the real server store", () => {
    it("writes only root, modules, and plugins on a first boot from a fresh store, and nothing on the next", async () => {
        const store = await StoreBackedServer.create();
        try {
            const first = await boot(store);
            // The server materialized every section, collection, and `presets`; the client's
            // defaults create the residual root and the two Phase 1 lists `setDatabase` fills.
            expect(opKinds(first.bootBatches).sort()).toEqual(["modules", "plugins", "root"]);
            expect(first.bootBatches.flatMap((batch) => batch.ops).every((op) => op.baseRevision === null)).toBe(true);
            for (const kind of [...Object.values(SECTION_KIND), ...Object.values(COLLECTION_KIND), "presets"]) {
                expect(store.record(kind, "main"), kind).not.toBeNull();
            }
            const second = await boot(store);
            expect(second.bootBatches).toEqual([]);
            await second.sync.flushResources();
            expect(store.batchCount()).toBe(0);
        } finally {
            store.close();
        }
    });

    it("writes nothing on a boot from a store whose every kind holds non-default values, including own __proto__ keys", async () => {
        const store = await StoreBackedServer.create();
        try {
            for (const [kind, data] of Object.entries(customRecords)) {
                store.set(kind, "main", data);
            }
            const { bootBatches, db, secrets, sync } = await boot(store);
            expect(opKinds(bootBatches).sort()).toEqual(["modules", "plugins", "root"]);
            // The mirror shows the stored values, own `__proto__` keys included.
            expect(db().loreBookToken).toBe(1234);
            expect(db().zoomsize).toBe(111);
            expect(db().irisDialogue).toEqual([{ speaker: "Iris", text: "hi", tip: "t" }]);
            expect(db().NAIImgConfig.v4_prompt).toBeDefined();
            expect(db().translatorPresetId).toBe("t2");
            expect(db().hypaV3PresetId).toBe("h2");
            expect(db().hypaV3Presets[0].settings.similarMemoryRatio).toBe(0.5);
            expect(db().statics).toEqual({ messages: 3, imports: 0 });
            expect(db().hotkeys.length).toBeGreaterThan(1);
            expect(db().personas[1].id).toEqual(expect.any(String));
            expect(Object.hasOwn(plain(db().globalChatVariables), "__proto__")).toBe(true);
            expect(Object.hasOwn(plain(db().OaiCompAPIKeys), "__proto__")).toBe(true);
            expect(Object.hasOwn(plain(db().seperateParameters.overrides), "__proto__")).toBe(true);
            expect(Object.hasOwn(plain(db().botPresets[0].seperateParameters.overrides), "__proto__")).toBe(true);
            expect(secrets.getPresetSecret("__proto__")).toEqual({ proxyKey: "proto" });
            expect(secrets.getPresetSecret("preset-1")).toEqual({ proxyKey: "p1" });
            await sync.flushResources();
            expect(store.batchCount()).toBe(0);
        } finally {
            store.close();
        }
    });

    it("converges after client edits of every kind: the server-normalized result of a write boots without a write", async () => {
        const store = await StoreBackedServer.create();
        try {
            for (const [kind, data] of Object.entries(customRecords)) {
                store.set(kind, "main", data);
            }
            const first = await boot(store);
            const db = first.db();
            const third = createTranslatorPreset("Third", { prompt: "p3" });
            const hypa = createHypaV3Preset("H3");
            db.zoomsize = 112;
            db.seperateParameters.overrides.claude = { temperature: 3 };
            db.openAIKey = "sk2";
            first.secrets.setPresetSecret("__proto__", { proxyKey: "proto2" });
            first.secrets.setPresetSecret(db.botPresets[1].id, { proxyKey: "q" });
            db.elevenLabKey = "el";
            db.sdSteps = 32;
            db.globalChatVariables.y = "2";
            db.translatorPresets.push(third);
            db.translatorPresetId = third.id;
            db.hypaV3Presets.push(hypa);
            db.hypaV3PresetId = hypa.id;
            db.loreBook.push({ name: "Book 2", data: [] });
            db.hotkeys[0].key = "y";
            db.personas.push({
                id: newPersonaId(),
                name: "B",
                icon: "",
                personaPrompt: "",
                note: "",
                largePortrait: false,
            });
            db.characterOrder.push("z");
            db.authRefreshes.push({ url: "u2", tokenUrl: "t2", refreshToken: "r2", clientId: "c2" });
            db.customModels.push({ id: "m2", internalId: "i2", name: "M2" });
            db.enabledModules.push("mod2");
            db.statics.messages += 1;
            db.globalscript.push({ comment: "s2", type: "editoutput", in: "c", out: "d", flag: "" });
            db.customSidebarItems.push({ name: "item 2" });
            db.username = "u2";
            // A forwarded field: the edit goes to the selected (first) preset, not to root.
            db.temperature = 42;
            db.botPresets[0].name = "P2";
            await first.sync.flushResources();
            const written = opKinds(store.batchBodies());
            for (const kind of [...Object.values(SECTION_KIND), ...Object.values(COLLECTION_KIND), "presets", "root"]) {
                expect(written, kind).toContain(kind);
            }
            // The store holds the edits, normalized by the server (its idempotence is proven by the
            // server tests; here the client's text was already canonical for the rebuilt items).
            const translator = store.record("translatorPresets", "main")!.data;
            expect(translator.items.map((item: { id: string }) => item.id)).toEqual(["t1", "t2", third.id]);
            expect(translator.items[2]).toEqual(third);
            expect(translator.selectedId).toBe(third.id);
            expect(store.record("hypaV3Presets", "main")!.data.items[2]).toEqual(hypa);
            expect(store.record("hypaV3Presets", "main")!.data.selectedId).toBe(hypa.id);
            expect(store.record("statics", "main")!.data).toEqual({ messages: 4, imports: 0 });
            expect(Object.hasOwn(store.record("llmSecrets", "main")!.data.presets, "__proto__")).toBe(true);
            expect(store.record("llmSecrets", "main")!.data.presets.__proto__).toEqual({ proxyKey: "proto2" });
            expect(store.record("root", "main")!.data.username).toBe("u2");
            expect(store.record("root", "main")!.data).not.toHaveProperty("temperature");
            expect(store.record("root", "main")!.data).not.toHaveProperty("zoomsize");
            expect(store.record("presets", "main")!.data[0]).toMatchObject({ name: "P2", temperature: 42 });

            const second = await boot(store);
            expect(second.bootBatches).toEqual([]);
            expect(second.db().zoomsize).toBe(112);
            expect(second.db().username).toBe("u2");
            expect(second.db().temperature).toBe(42);
            expect(second.db().translatorPresetId).toBe(third.id);
            expect(second.db().hypaV3PresetId).toBe(hypa.id);
            expect(second.secrets.getPresetSecret("__proto__")).toEqual({ proxyKey: "proto2" });
            expect(Object.hasOwn(plain(second.db().seperateParameters.overrides), "__proto__")).toBe(true);
            await second.sync.flushResources();
            expect(store.batchCount()).toBe(0);
        } finally {
            store.close();
        }
    });
});

describe("assembleDatabase", () => {
    it("takes the residual keys from root, every section field, the collections unpacked, and the secret map", async () => {
        const fake = await fakeStore({ username: "u", botPresetsId: 1, zoomsize: 5, language: "ko", formatversion: 5 });
        fake.set("llmSecrets", "main", {
            ...fake.data<Record<string, unknown>>("llmSecrets", "main")!,
            presets: json('{"p":{"proxyKey":"x"},"__proto__":{"proxyKey":"y"}}'),
        });
        fake.set("characters", "a", { chaId: "a", name: "Alice", type: "character" });
        const { client, bootstrap, secrets } = await fresh(fake);
        const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
        const db = bootstrap.assembleDatabase(snapshot) as any;
        // Root keys outside `RESIDUAL_ROOT_KEYS` are ignored (`botPresetsId` is a per-client
        // selection since slice 5, served by the forwarding layer, not assembled); a section wins
        // for its own field.
        expect(db.username).toBe("u");
        expect(db).not.toHaveProperty("botPresetsId");
        expect(db.zoomsize).toBe(100);
        expect(db.language).toBe("en");
        expect(db).not.toHaveProperty("formatversion");
        for (const [section, fields] of Object.entries(SECTION_FIELDS)) {
            const record = fake.data<Record<string, unknown>>(section, "main")!;
            for (const field of fields) {
                if (Object.hasOwn(record, field)) {
                    expect(db[field], `${section}.${field}`).toEqual(record[field]);
                } else {
                    expect(db, `${section}.${field}`).not.toHaveProperty(field);
                }
            }
        }
        const translator = fake.data<{ items: unknown[]; selectedId: string }>("translatorPresets", "main")!;
        expect(db.translatorPresets).toEqual(translator.items);
        expect(db.translatorPresetId).toBe(translator.selectedId);
        const hypa = fake.data<{ items: unknown[]; selectedId: string }>("hypaV3Presets", "main")!;
        expect(db.hypaV3Presets).toEqual(hypa.items);
        expect(db.hypaV3PresetId).toBe(hypa.selectedId);
        expect(db.loreBook).toEqual(fake.data("loreBook", "main"));
        expect(db.hotkeys).toEqual(fake.data("hotkeys", "main"));
        expect(db.statics).toEqual({ messages: 0, imports: 0 });
        expect(db.botPresets).toEqual(fake.data("presets", "main"));
        expect(db.botPresets[0]).toMatchObject({ id: "preset-1", name: "p1" });
        expect(db.modules).toEqual([]);
        expect(db.plugins).toEqual([]);
        expect(db.pluginCustomStorage).toEqual({});
        expect(db.characters).toEqual([{ chaId: "a", name: "Alice", type: "character", chats: [], chatPage: 0 }]);
        expect(db).not.toHaveProperty("presets");
        expect(secrets.getPresetSecret("p")).toEqual({ proxyKey: "x" });
        expect(secrets.getPresetSecret("__proto__")).toEqual({ proxyKey: "y" });
    });

    it("leaves the optional Phase 1 collections absent when the server has no record, and defaults nothing else", async () => {
        const fake = await fakeStore(null);
        fake.delete("modules", "main");
        fake.delete("plugins", "main");
        fake.delete("pluginStorage", "main");
        const { client, bootstrap } = await fresh(fake);
        const db = bootstrap.assembleDatabase(await client.readKinds(Object.values(RESOURCE_KIND))) as any;
        expect(db).not.toHaveProperty("username");
        expect(db).not.toHaveProperty("modules");
        expect(db).not.toHaveProperty("plugins");
        expect(db).not.toHaveProperty("pluginCustomStorage");
        expect(db.characters).toEqual([]);
    });

    it("throws for a missing section, collection, or presets record instead of defaulting it", async () => {
        for (const kind of ["ui", "hotkeys", "presets"]) {
            const fake = await fakeStore();
            fake.delete(kind, "main");
            const { client, bootstrap } = await fresh(fake);
            const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
            expect(() => bootstrap.assembleDatabase(snapshot), kind).toThrow(`no ${kind} record`);
        }
    });
});

describe("the residual root", () => {
    it("projects exactly RESIDUAL_ROOT_KEYS, in that order, and never a section or forwarded field", async () => {
        const { fake, sync, db } = await boot(await fakeStore());
        db().personaPrompt = "prompt";
        db().userNote = "note";
        db().zoomsize = 5;
        // Forwarded fields (slice 5): the edits go to the selected preset, never to root.
        db().temperature = 42;
        db().promptTemplate = [];
        await sync.flushResources();
        const root = fake
            .batchBodies()
            .flatMap((batch) => batch.ops)
            .find((op) => op.kind === "root")!;
        expect(root).toBeDefined();
        const keys = Object.keys(root.data);
        expect(keys).toEqual(RESIDUAL_ROOT_KEYS.filter((key) => keys.includes(key)));
        expect(keys).toContain("personaPrompt");
        expect(keys).toContain("userNote");
        expect(keys).toContain("username");
        for (const field of Object.values(SECTION_FIELDS).flat()) {
            expect(root.data, field).not.toHaveProperty(field);
        }
        expect(root.data).not.toHaveProperty("temperature");
        expect(root.data).not.toHaveProperty("promptTemplate");
        expect(root.data).not.toHaveProperty("botPresetsId");
        expect(root.data).not.toHaveProperty("botPresets");
        expect(root.data).not.toHaveProperty("characters");
        expect(fake.data("presets", "main")[0]).toMatchObject({ temperature: 42, promptTemplate: [] });
    });

    it("ignores the extra keys of a root from before the slice and writes the filtered root once", async () => {
        // A root from before slice 5 still carries the preset working copy and the selection index.
        const fake = await fakeStore({
            username: "u",
            botPresetsId: 0,
            temperature: 80,
            zoomsize: 5,
            language: "ko",
            formatversion: 5,
        });
        const { bootBatches, sync, db } = await boot(fake);
        expect(db().zoomsize).toBe(100);
        expect(db().language).toBe("en");
        expect(db()).not.toHaveProperty("formatversion");
        expect(db().botPresetsId).toBe(0);
        expect(opKinds(bootBatches)).toEqual(["root"]);
        const stored = fake.data<Record<string, unknown>>("root", "main")!;
        expect(stored).not.toHaveProperty("zoomsize");
        expect(stored).not.toHaveProperty("language");
        expect(stored).not.toHaveProperty("formatversion");
        expect(stored).not.toHaveProperty("botPresetsId");
        expect(stored).not.toHaveProperty("temperature");
        expect(stored.username).toBe("u");
        // `setDatabase` fills the other residual keys, so the written root is the whole residual list.
        expect(Object.keys(stored)).toEqual([...RESIDUAL_ROOT_KEYS]);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
    });
});

describe("watchers", () => {
    it("mark only the record an edit belongs to", async () => {
        const { fake, sync, secrets, db } = await boot(await fakeStore());
        const edits: [string, () => void][] = [
            ["ui", () => (db().zoomsize = 111)],
            ["ui", () => (db().colorScheme.bgcolor = "#123")],
            ["providers", () => (db().seperateParameters.overrides.gpt = { temperature: 2 })],
            ["llmSecrets", () => (db().openAIKey = "sk")],
            ["llmSecrets", () => secrets.setPresetSecret("p", { proxyKey: "k" })],
            ["secrets", () => (db().elevenLabKey = "el")],
            ["memoryTranslateMedia", () => (db().sdConfig.width = 640)],
            ["loreBook", () => db().loreBook[0].data.push({ key: "k", content: "c", comment: "", mode: "normal" })],
            ["globalscript", () => db().globalscript.push({ comment: "s", type: "editinput", in: "a", out: "b" })],
            ["hotkeys", () => (db().hotkeys[0].key = "z")],
            ["customSidebarItems", () => db().customSidebarItems.push({ name: "item" })],
            ["characterOrder", () => db().characterOrder.push("x")],
            ["authRefreshes", () => db().authRefreshes.push({ url: "u" })],
            ["globalChatVariables", () => (db().globalChatVariables.x = "1")],
            ["personas", () => (db().personas[0].name = "Renamed")],
            ["translatorPresets", () => (db().translatorPresets[0].prompt = "edited")],
            ["hypaV3Presets", () => (db().hypaV3Presets[0].settings.queryChatCount = 5)],
            ["customModels", () => db().customModels.push({ id: "m", internalId: "i" })],
            ["enabledModules", () => db().enabledModules.push("mod")],
            ["statics", () => (db().statics.messages += 1)],
            ["root", () => (db().username = "renamed user")],
            // A forwarded preset field (slice 5) is an edit of the selected preset record.
            ["presets", () => (db().temperature = 42)],
            ["presets", () => (db().botPresets[0].name = "P")],
        ];
        for (const [kind, edit] of edits) {
            fake.requests.length = 0;
            edit();
            await sync.flushResources();
            const batches = fake.batchBodies();
            expect(batches, `${kind} edit`).toHaveLength(1);
            expect(opKinds(batches), `${kind} edit`).toEqual([kind]);
        }
    });

    it("send a selection change as the collection's { items, selectedId } record", async () => {
        const { fake, sync, db } = await boot(await fakeStore());
        const second = createTranslatorPreset("Second");
        db().translatorPresets.push(second);
        db().translatorPresetId = second.id;
        await sync.flushResources();
        expect(opKinds(fake.batchBodies())).toEqual(["translatorPresets"]);
        expect(fake.data("translatorPresets", "main")).toEqual({
            items: [expect.objectContaining({ name: "Default" }), second],
            selectedId: second.id,
        });
        fake.requests.length = 0;
        db().hypaV3PresetId = "elsewhere";
        await sync.flushResources();
        expect(opKinds(fake.batchBodies())).toEqual(["hypaV3Presets"]);
        expect(fake.data("hypaV3Presets", "main").selectedId).toBe("elsewhere");
    });
});

describe("conflict reloads", () => {
    it("replaces a section's fields in place, deletes a field the server record lacks, keeps the other sections, and echoes nothing", async () => {
        const { fake, sync, db } = await boot(await fakeStore());
        db().irisDialogue = [{ speaker: "me", text: "local", tip: "" }];
        await sync.flushResources();
        expect(fake.data("ui", "main").irisDialogue).toHaveLength(1);
        // Another client wrote `ui` without `irisDialogue` (it has no default) and with its own zoom.
        const remote: Record<string, unknown> = { ...fake.data<Record<string, unknown>>("ui", "main")!, zoomsize: 77 };
        delete remote.irisDialogue;
        fake.set("ui", "main", remote);
        db().zoomsize = 50;
        db().requestRetrys = 9;
        fake.requests.length = 0;
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["ui/main"]);
        expect(db().zoomsize).toBe(77);
        expect("irisDialogue" in db()).toBe(false);
        expect(db().irisDialogue).toBeUndefined();
        expect(db().requestRetrys).toBe(9);
        expect(fake.data("providers", "main").requestRetrys).toBe(9);
        expect(fake.data("ui", "main").zoomsize).toBe(77);
        expect(alerts.normal).toHaveBeenCalledTimes(1);
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        const before = fake.batchCount();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(before);
        // The next write of the section is built from the reloaded fields: no `irisDialogue`.
        db().zoomsize = 51;
        await sync.flushResources();
        expect(fake.data("ui", "main")).not.toHaveProperty("irisDialogue");
        expect(fake.data("ui", "main").zoomsize).toBe(51);
    });

    it("replaces the secret map with the llmSecrets record, own __proto__ key included, and echoes nothing", async () => {
        const { fake, sync, secrets, db } = await boot(await fakeStore());
        secrets.setPresetSecret("p1", { proxyKey: "local" });
        await sync.flushResources();
        expect(fake.data("llmSecrets", "main").presets).toEqual({ p1: { proxyKey: "local" } });
        fake.set("llmSecrets", "main", {
            ...fake.data<Record<string, unknown>>("llmSecrets", "main")!,
            openAIKey: "remote",
            presets: json('{"p2":{"proxyKey":"remote"},"__proto__":{"proxyKey":"proto"}}'),
        });
        db().openAIKey = "local";
        fake.requests.length = 0;
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["llmSecrets/main"]);
        expect(db().openAIKey).toBe("remote");
        expect(secrets.getPresetSecret("p1")).toBeUndefined();
        expect(secrets.getPresetSecret("p2")).toEqual({ proxyKey: "remote" });
        expect(secrets.getPresetSecret("__proto__")).toEqual({ proxyKey: "proto" });
        const before = fake.batchCount();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(before);
        db().openAIKey = "again";
        await sync.flushResources();
        const sent = fake.data("llmSecrets", "main");
        expect(sent.openAIKey).toBe("again");
        expect(Object.hasOwn(sent.presets, "__proto__")).toBe(true);
        expect(sent.presets.__proto__).toEqual({ proxyKey: "proto" });
        expect(sent.presets.p2).toEqual({ proxyKey: "remote" });
        expect(sent.presets).not.toHaveProperty("p1");
    });

    it("replaces a selectable collection and its selection together, and echoes nothing", async () => {
        const { fake, sync, db } = await boot(await fakeStore());
        const c = createTranslatorPreset("C", { id: "c" });
        const d = createTranslatorPreset("D", { id: "d" });
        fake.set("translatorPresets", "main", { items: [c, d], selectedId: "d" });
        db().translatorPresets[0].name = "local rename";
        fake.requests.length = 0;
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["translatorPresets/main"]);
        expect(db().translatorPresets).toEqual([c, d]);
        expect(db().translatorPresetId).toBe("d");
        const before = fake.batchCount();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(before);
    });

    it("replaces a plain collection and keeps the sections' key order equal to the server's, so nothing is echoed", async () => {
        const { fake, sync, db } = await boot(await fakeStore());
        const normalizeUi = await serverNormalizer("ui");
        // Another client wrote `ui` with its keys in another order (a hand-written or older record).
        const reversed = Object.fromEntries(Object.entries(fake.data("ui", "main")).reverse());
        reversed.zoomsize = 66;
        fake.set("ui", "main", reversed);
        fake.set("enabledModules", "main", ["remote-module"]);
        db().zoomsize = 1;
        db().enabledModules.push("local-module");
        fake.requests.length = 0;
        const result = await sync.flushResources();
        expect(result.discarded.sort()).toEqual(["enabledModules/main", "ui/main"]);
        expect(db().enabledModules).toEqual(["remote-module"]);
        expect(db().zoomsize).toBe(66);
        const before = fake.batchCount();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(before);
        // The projection after the reload is the server's canonical text.
        db().zoomsize = 67;
        await sync.flushResources();
        const stored = fake.data("ui", "main");
        expect(JSON.stringify(stored)).toBe(JSON.stringify(normalizeUi(stored)));
    });
});
