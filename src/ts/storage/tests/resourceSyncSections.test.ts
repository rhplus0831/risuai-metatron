import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
import { maskLlmSecrets, type SecretPath } from "../../../../shared/llmSecrets.ts";
import { newPersonaId } from "../../../../shared/presets.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { COLLECTION_KIND, PERSONA_ROOT_KEYS, SECTION_FIELDS, SECTION_KIND } from "../../../../shared/sections.ts";
import { createTranslatorPreset } from "../../../../shared/translatorPresets.ts";
import { FakeResourceServer } from "./fakeResourceServer";
import { materialize, serverNormalizer } from "./serverKinds";
import { StoreBackedServer } from "./storeBackedServer";

// Phase 3, slice 4 (`docs/plan/phases/slices/phase-3-settings-sections/client-section-mirrors.md`):
// the client mirrors of the five sections and the thirteen settings collections (the residual `root`
// went in slice 6). Every boot here runs the real `loadData` sequence for the data: `readKinds`, `seedResources`,
// `assembleDatabase`, the real `setDatabase`, then the adapter's boot compare pass. The convergence
// rule of the implementation plan (A12) is the central contract: for every kind,
// `normalize(project(assemble(normalized)))` equals `normalized` as text, so an unchanged record is
// never written. The real server store (`storeBackedServer.ts`) materializes and normalizes the
// records; the in-memory fake (`fakeResourceServer.ts`) stores exactly what a test puts in it. Since
// Phase 5 slice 7b (`request-layer-and-llm-secrets.md`) `llmSecrets` is write-only: both stand-ins
// answer it masked, the record's text is its readable siblings, the mirror's credential fields are
// `""`, the status comes from the masked record (`llmSecretState`), and a credential write goes
// through `/api/llm-secrets/*` after the cycle's batch, never in the record.

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
const presetPath = (id: string): SecretPath => ({ kind: "entry", field: "presets", id });

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
 * A fake with every materialized kind and the Phase 1 records a normal store holds. There is no
 * `root` record (slice 6): the preset and persona fields and the selection indexes are forwarded.
 */
async function fakeStore() {
    const fake = new FakeResourceServer();
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
    it("writes only modules and plugins on a first boot from a fresh store, and nothing on the next", async () => {
        const store = await StoreBackedServer.create();
        try {
            const first = await boot(store);
            // The server materialized every section, collection, and `presets`; the client's
            // defaults create only the two Phase 1 lists `setDatabase` fills (no `root` since slice 6).
            expect(opKinds(first.bootBatches).sort()).toEqual(["modules", "plugins"]);
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
            expect(opKinds(bootBatches).sort()).toEqual(["modules", "plugins"]);
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
            expect(Object.hasOwn(plain(db().seperateParameters.overrides), "__proto__")).toBe(true);
            expect(Object.hasOwn(plain(db().botPresets[0].seperateParameters.overrides), "__proto__")).toBe(true);
            // The write-only `llmSecrets` record (7b) reaches the tab masked: the mirror's credential
            // fields read "", and the status (own `__proto__` keys included) is in `llmSecretState`.
            expect(db().openAIKey).toBe("");
            expect(plain(db().OaiCompAPIKeys)).toEqual({});
            expect(Object.hasOwn(plain(secrets.llmSecretState.masked!.OaiCompAPIKeys), "__proto__")).toBe(true);
            expect(secrets.isSecretSet({ kind: "map", field: "OaiCompAPIKeys", id: "__proto__" })).toBe(true);
            expect(secrets.isSecretSet({ kind: "flat", field: "openAIKey" })).toBe(true);
            expect(secrets.secretStatus(presetPath("__proto__"))).toEqual({ set: true, hint: "", pending: false });
            expect(secrets.secretStatus(presetPath("preset-1"))).toEqual({ set: true, hint: "", pending: false });
            await sync.flushResources();
            expect(store.batchCount()).toBe(0);
        } finally {
            store.close();
        }
    });

    it("writes nothing on a boot from a store whose personas hold appended defaults, unknown fields, an own __proto__ key, and a repaired duplicate id", async () => {
        // Slice 6: `normalizePersonas` (`shared/personas.ts`) runs on the server (at `set`) and in
        // `setDatabase`; the persona fixed point is what keeps an idle boot write-free.
        const store = await StoreBackedServer.create();
        try {
            store.set("personas", "main", [
                json('{"id":"persona-1","name":"A","extra":{"deep":true},"__proto__":{"polluted":true}}'),
                { id: "persona-1", name: "dup", icon: "i", personaPrompt: "p", note: "n", embeddedModule: { id: "m" } },
                { name: "no id", note: 5 },
            ]);
            const stored = store.record("personas", "main")!.data as Record<string, any>[];
            const storedText = JSON.stringify(stored);
            expect(stored.map((persona) => persona.name)).toEqual(["A", "dup", "no id"]);
            expect(Object.keys(stored[0])).toEqual([
                "id",
                "name",
                "extra",
                "__proto__",
                "icon",
                "personaPrompt",
                "note",
            ]);
            expect(stored[1].id).not.toBe("persona-1");
            expect(new Set(stored.map((persona) => persona.id)).size).toBe(3);
            expect(stored[2]).toMatchObject({ name: "no id", note: "", icon: "", personaPrompt: "" });
            expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);

            const first = await boot(store);
            expect(opKinds(first.bootBatches).sort()).toEqual(["modules", "plugins"]);
            expect(first.db().personas.map((persona: any) => persona.id)).toEqual(stored.map((persona) => persona.id));
            expect(first.db().personas[0].extra).toEqual({ deep: true });
            expect(Object.hasOwn(plain(first.db().personas[0]), "__proto__")).toBe(true);
            expect(first.db().personas[1].embeddedModule).toEqual({ id: "m" });
            expect(first.db().username).toBe("A");
            expect(first.db().userNote).toBe("");
            await first.sync.flushResources();
            expect(store.batchCount()).toBe(0);
            expect(JSON.stringify(store.record("personas", "main")!.data)).toBe(storedText);

            // The repaired ids are stable: the next boot sees the same ones and writes nothing.
            const second = await boot(store);
            expect(second.bootBatches).toEqual([]);
            expect(second.db().personas.map((persona: any) => persona.id)).toEqual(stored.map((persona) => persona.id));
            await second.sync.flushResources();
            expect(store.batchCount()).toBe(0);
            expect(JSON.stringify(store.record("personas", "main")!.data)).toBe(storedText);
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
            // The `llmSecrets` edit is a sibling (its credentials are queued writes, not record edits).
            db.vertexClientEmail = "vertex@example.test";
            first.secrets.setSecret(presetPath("__proto__"), "proto2");
            first.secrets.setSecret(presetPath(db.botPresets[1].id), "q");
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
            // Forwarded fields (slices 5 and 6): the edits go to the selected (first) persona and
            // preset records; nothing is written under a root.
            db.username = "u2";
            db.temperature = 42;
            db.botPresets[0].name = "P2";
            await first.sync.flushResources();
            const written = opKinds(store.batchBodies());
            for (const kind of [...Object.values(SECTION_KIND), ...Object.values(COLLECTION_KIND), "presets"]) {
                expect(written, kind).toContain(kind);
            }
            expect(written).not.toContain("root");
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
            expect(store.record("llmSecrets", "main")!.data.presets[db.botPresets[1].id]).toEqual({ proxyKey: "q" });
            // The sibling write carried no credential, and the server kept the stored ones.
            expect(store.record("llmSecrets", "main")!.data.vertexClientEmail).toBe("vertex@example.test");
            expect(store.record("llmSecrets", "main")!.data.openAIKey).toBe("sk");
            expect(store.secretRequests().map((request) => request.path)).toEqual([
                "/api/llm-secrets/presets/~__proto__/proxyKey",
                `/api/llm-secrets/presets/~${db.botPresets[1].id}/proxyKey`,
            ]);
            expect(store.record("personas", "main")!.data[0].name).toBe("u2");
            expect(store.record("personas", "main")!.data[0]).not.toHaveProperty("username");
            expect(store.record("presets", "main")!.data[0]).toMatchObject({ name: "P2", temperature: 42 });

            const second = await boot(store);
            expect(second.bootBatches).toEqual([]);
            expect(second.db().zoomsize).toBe(112);
            expect(second.db().username).toBe("u2");
            expect(second.db().temperature).toBe(42);
            expect(second.db().translatorPresetId).toBe(third.id);
            expect(second.db().hypaV3PresetId).toBe(hypa.id);
            expect(second.db().vertexClientEmail).toBe("vertex@example.test");
            expect(second.secrets.secretStatus(presetPath("__proto__"))).toEqual({
                set: true,
                hint: "",
                pending: false,
            });
            expect(second.secrets.isSecretSet(presetPath(db.botPresets[1].id))).toBe(true);
            expect(Object.hasOwn(plain(second.db().seperateParameters.overrides), "__proto__")).toBe(true);
            await second.sync.flushResources();
            expect(store.batchCount()).toBe(0);
        } finally {
            store.close();
        }
    });
});

describe("assembleDatabase", () => {
    it("takes every section field, the collections unpacked, and the masked secret status, and assembles no forwarded field", async () => {
        const fake = await fakeStore();
        fake.set("llmSecrets", "main", {
            ...fake.data<Record<string, unknown>>("llmSecrets", "main")!,
            presets: json('{"p":{"proxyKey":"x"},"__proto__":{"proxyKey":"y"}}'),
        });
        fake.set("characters", "a", { chaId: "a", name: "Alice", type: "character" });
        const { client, bootstrap, secrets } = await fresh(fake);
        const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
        const db = bootstrap.assembleDatabase(snapshot) as any;
        // The forwarded fields (the preset and persona working copies, the selection indexes) are
        // served by the forwarding layer, not assembled; a section's own fields come from its record.
        expect(db).not.toHaveProperty("username");
        expect(db).not.toHaveProperty("selectedPersona");
        expect(db).not.toHaveProperty("botPresetsId");
        expect(db).not.toHaveProperty("temperature");
        expect(db.zoomsize).toBe(100);
        expect(db.language).toBe("en");
        for (const [section, fields] of Object.entries(SECTION_FIELDS)) {
            const stored = fake.data<Record<string, unknown>>(section, "main")!;
            // The write-only `llmSecrets` record (7b) is read masked and assembled through
            // `mirrorFields`: its siblings as stored, every credential field "".
            const record = section === "llmSecrets" ? secrets.mirrorFields(maskLlmSecrets(stored)) : stored;
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
        expect(db.openAIKey).toBe("");
        expect(secrets.isSecretSet(presetPath("p"))).toBe(true);
        expect(secrets.isSecretSet(presetPath("__proto__"))).toBe(true);
        expect(secrets.isSecretSet(presetPath("absent"))).toBe(false);
    });

    it("leaves the optional Phase 1 collections absent when the server has no record, and defaults nothing else", async () => {
        const fake = await fakeStore();
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

// Slice 6 removed the residual `root` (the cases here replaced "the residual root": its projection
// and its filtering of a pre-slice root no longer exist). No root record is written or read; the
// fields it held are forwarded to their records.
describe("no root record", () => {
    it("writes no root: the persona fields land in the selected persona, the preset fields in the selected preset, a section field in its section", async () => {
        const { fake, sync, db } = await boot(await fakeStore());
        db().username = "renamed";
        db().personaPrompt = "prompt";
        db().userNote = "note";
        db().zoomsize = 5;
        db().temperature = 42;
        db().promptTemplate = [];
        await sync.flushResources();
        const ops = fake.batchBodies().flatMap((batch) => batch.ops);
        expect(ops.map((op) => op.kind).sort()).toEqual(["personas", "presets", "ui"]);
        expect(fake.get("root", "main")).toBeNull();
        const persona = fake.data("personas", "main")[0];
        expect(persona).toMatchObject({ name: "renamed", personaPrompt: "prompt", note: "note" });
        // The persona record holds the persona keys, never the root names (`personaPrompt` is both).
        for (const field of PERSONA_ROOT_KEYS.filter((key) => key !== "personaPrompt")) {
            expect(persona, field).not.toHaveProperty(field);
        }
        expect(fake.data("ui", "main").zoomsize).toBe(5);
        expect(fake.data("presets", "main")[0]).toMatchObject({ temperature: 42, promptTemplate: [] });
        expect(db().selectedPersona).toBe(0);
    });

    it("neither reads a stale root record nor writes it back: its keys never reach the mirror and it stays untouched", async () => {
        const fake = await fakeStore();
        // A root from before slice 6 (a real store with one is refused at startup; the fake keeps it).
        const stale = { username: "old", selectedPersona: 1, temperature: 33, zoomsize: 5, formatversion: 5 };
        const revision = fake.set("root", "main", stale);
        const { bootBatches, sync, db } = await boot(fake);
        expect(bootBatches).toEqual([]);
        // The materialized persona and the `ui` record, not the stale root, serve the mirror.
        expect(db().username).toBe("User");
        expect(db().zoomsize).toBe(100);
        expect(db().temperature).toBe(80 /* the preset default, not a root value */);
        expect(db()).not.toHaveProperty("formatversion");
        db().username = "edited";
        db().zoomsize = 50;
        await sync.flushResources();
        expect(opKinds(fake.batchBodies()).sort()).toEqual(["personas", "ui"]);
        expect(fake.get("root", "main")).toEqual({ revision, data: stale });
    });
});

describe("watchers", () => {
    it("mark only the record an edit belongs to", async () => {
        const { fake, sync, secrets, db } = await boot(await fakeStore());
        const edits: [string, () => void][] = [
            ["ui", () => (db().zoomsize = 111)],
            ["ui", () => (db().colorScheme.bgcolor = "#123")],
            ["providers", () => (db().seperateParameters.overrides.gpt = { temperature: 2 })],
            // The `llmSecrets` siblings (7b): a credential is not a record edit (checked below).
            ["llmSecrets", () => (db().vertexClientEmail = "vertex@example.test")],
            ["llmSecrets", () => (db().google.projectId = "proj")],
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
            // A forwarded persona field (slice 6) is an edit of the selected persona record.
            ["personas", () => (db().username = "renamed user")],
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
        // A credential write (7b) is no record edit: no batch, one request to `/api/llm-secrets`.
        fake.requests.length = 0;
        secrets.setSecret(presetPath("p"), "k");
        await sync.flushResources();
        expect(fake.batchBodies()).toHaveLength(0);
        expect(fake.secretRequests().map((request) => request.path)).toEqual(["/api/llm-secrets/presets/~p/proxyKey"]);
        expect(fake.data("llmSecrets", "main").presets).toEqual({ p: { proxyKey: "k" } });
        expect(secrets.secretStatus(presetPath("p"))).toEqual({ set: true, hint: "", pending: false });
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

    it("replaces the secret status with the masked llmSecrets record, own __proto__ key included, keeps the stored credentials on the next sibling write, and echoes nothing", async () => {
        const { fake, sync, secrets, db } = await boot(await fakeStore());
        secrets.setSecret(presetPath("p1"), "local");
        await sync.flushResources();
        expect(fake.data("llmSecrets", "main").presets).toEqual({ p1: { proxyKey: "local" } });
        expect(secrets.secretStatus(presetPath("p1"))).toEqual({ set: true, hint: "", pending: false });
        // Another client replaced the record: a sibling, a credential, and the presets map.
        fake.set("llmSecrets", "main", {
            ...fake.data<Record<string, unknown>>("llmSecrets", "main")!,
            openAIKey: "remote",
            vertexClientEmail: "remote",
            presets: json('{"p2":{"proxyKey":"remote"},"__proto__":{"proxyKey":"proto"}}'),
        });
        db().vertexClientEmail = "local";
        fake.requests.length = 0;
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["llmSecrets/main"]);
        expect(db().vertexClientEmail).toBe("remote");
        // The mirror never holds a credential; the status comes from the masked record.
        expect(db().openAIKey).toBe("");
        expect(secrets.isSecretSet({ kind: "flat", field: "openAIKey" })).toBe(true);
        expect(secrets.isSecretSet(presetPath("p1"))).toBe(false);
        expect(secrets.isSecretSet(presetPath("p2"))).toBe(true);
        expect(secrets.isSecretSet(presetPath("__proto__"))).toBe(true);
        const before = fake.batchCount();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(before);
        // The next sibling write carries no credential and no map; the server keeps the stored ones.
        db().vertexClientEmail = "again";
        await sync.flushResources();
        const sentOp = fake
            .batchBodies()
            .at(-1)!
            .ops.find((op) => op.kind === "llmSecrets");
        expect(sentOp.data).not.toHaveProperty("openAIKey");
        expect(sentOp.data).not.toHaveProperty("presets");
        const stored = fake.data("llmSecrets", "main");
        expect(stored.vertexClientEmail).toBe("again");
        expect(stored.openAIKey).toBe("remote");
        expect(Object.hasOwn(stored.presets, "__proto__")).toBe(true);
        expect(stored.presets.__proto__).toEqual({ proxyKey: "proto" });
        expect(stored.presets.p2).toEqual({ proxyKey: "remote" });
        expect(stored.presets).not.toHaveProperty("p1");
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
