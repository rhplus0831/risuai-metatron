import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, plain } from "./mutationStoresHarness";

// Phase 4, slice 1: the settings, persona, module, plugin, order, OAuth, and preset mutations
// (`collectionStore.svelte.ts`) against the real server store. Every refusal is checked to throw
// and change nothing (mirror and server compared after the next cycle); every write is checked in
// the mirror and on the server after the cycle. A forwarded settings write is a mutation carrying
// the preset id (`PLAN.md` Decision 3).

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
}));

vi.mock("../nodeStorage", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
}));
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored" },
    changeLanguage: vi.fn(),
}));
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

async function boot() {
    vi.resetModules();
    return bootMutations((fake) => {
        server.current = fake;
    });
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("updateSettings", () => {
    it("writes a forwarded key into the selected preset by id, and with presetId into that preset after a switch", async () => {
        const { sync, collectionStore, database, selection, record, db } = await boot();
        const [p1, p2] = db().botPresets.map((preset: any) => preset.id);
        expect(selection.presetId).toBe(p1);
        collectionStore.updateSettings({ temperature: 5, maxContext: 1234 });
        expect(db().temperature).toBe(5);
        expect(db().botPresets[1].temperature).not.toBe(5);
        // A caller that captured p1 before an await writes there although p2 is selected now.
        database.changeToPreset(p2);
        expect(selection.presetId).toBe(p2);
        collectionStore.updateSettings({ temperature: 9 }, { presetId: p1 });
        expect(db().botPresets[0].temperature).toBe(9);
        expect(db().temperature).not.toBe(9);
        collectionStore.updateSettings({ temperature: 2 });
        expect(db().botPresets[1].temperature).toBe(2);
        await sync.flushResources();
        const presets = record("presets");
        expect(presets.map((preset: any) => [preset.id, preset.temperature, preset.maxContext])).toEqual([
            [p1, 9, 1234],
            [p2, 2, expect.any(Number)],
        ]);
    });

    it("writes a keep-on-switch key into providers and section keys into their sections, including absent optional fields", async () => {
        const { sync, collectionStore, record, db } = await boot();
        expect(db().guiHTML).toBeUndefined();
        expect(db().googleSearchCredentials).toBeUndefined();
        collectionStore.updateSettings({
            fallbackWhenBlankResponse: true,
            theme: "waifu",
            guiHTML: "<div/>",
            googleSearchCredentials: { apiKey: "k", searchEngineId: "e" },
            hypaModel: "m",
        });
        await sync.flushResources();
        expect(record("providers").fallbackWhenBlankResponse).toBe(true);
        expect(record("ui")).toMatchObject({ theme: "waifu", guiHTML: "<div/>" });
        expect(record("secrets").googleSearchCredentials).toEqual({ apiKey: "k", searchEngineId: "e" });
        expect(record("memoryTranslateMedia").hypaModel).toBe("m");
        expect(record("presets").every((preset: any) => !("theme" in preset))).toBe(true);
        expect(record("presets").every((preset: any) => preset.fallbackWhenBlankResponse === undefined)).toBe(true);
    });

    it("applies the preset aliases and the nullable rule, and detaches the value", async () => {
        const { sync, collectionStore, record, db, refused, validation } = await boot();
        const nai = { cfg_scale: 3 };
        collectionStore.updateSettings({ NAIsettings: nai, min_p: null, reasoningEffort: 2 });
        nai.cfg_scale = 4;
        expect(db().botPresets[0].NAISettings.cfg_scale).toBe(3);
        expect(db().botPresets[0].min_p).toBeNull();
        expect(db().botPresets[0].reasonEffort).toBe(2);
        await sync.flushResources();
        expect(record("presets")[0]).toMatchObject({ NAISettings: { cfg_scale: 3 }, min_p: null, reasonEffort: 2 });
        await refused(() => collectionStore.updateSettings({ temperature: null }), validation.MutationValidationError);
        await refused(() => collectionStore.updateSettings({ theme: null }), validation.MutationValidationError);
        await refused(() => collectionStore.updateSettings({ theme: undefined }), validation.MutationValidationError);
        await refused(() => collectionStore.updateSettings({ min_p: undefined }), validation.MutationValidationError);
    });

    it("validates a mixed patch before any write, and throws MutationTargetGoneError for a stale preset id", async () => {
        const { sync, collectionStore, refused, validation, record, db } = await boot();
        await refused(
            () => collectionStore.updateSettings({ maxContext: 999, temperature: "hot" }),
            validation.MutationValidationError,
        );
        await refused(
            () => collectionStore.updateSettings({ theme: "t", proxyKey: "x" }),
            validation.MutationValidationError,
        );
        await refused(
            () => collectionStore.updateSettings({ theme: "t", temperature: 1 }, { presetId: "nope" }),
            validation.MutationTargetGoneError,
        );
        // A section-only patch does not need the preset.
        collectionStore.updateSettings({ theme: "only" }, { presetId: "nope" });
        await sync.flushResources();
        expect(record("ui").theme).toBe("only");
        expect(db().maxContext).not.toBe(999);
    });

    it("refuses credentials, persona and selection keys, unknown keys, wrong kinds, and non-data values", async () => {
        const { collectionStore, refused, validation } = await boot();
        for (const patch of [
            { openAIKey: "sk" },
            { proxyKey: "x" },
            { username: "me" },
            { personaPrompt: "p" },
            { botPresetsId: 1 },
            { selectedPersona: 0 },
            { loreBookPage: 1 },
            { nope: 1 },
            { characters: [] },
            { personas: [] },
            JSON.parse('{"__proto__":{"x":1}}'),
            { temperature: "hot" },
            { temperature: Number.POSITIVE_INFINITY },
            { promptTemplate: {} },
            { theme: () => "t" },
            { theme: 1n },
            { customCSS: { nested: () => 1 } },
        ]) {
            await refused(() => collectionStore.updateSettings(patch), validation.MutationValidationError);
        }
        await refused(() => collectionStore.updateSettings(null as any), validation.MutationValidationError);
        await refused(() => collectionStore.updateSettings([] as any), validation.MutationValidationError);
    });
});

describe("incrementStatic and addPreset", () => {
    it("raises one counter and keeps the other, from the server's zeroed record", async () => {
        const { sync, collectionStore, record, db } = await boot();
        expect(plain(db().statics)).toEqual({ messages: 0, imports: 0 });
        collectionStore.incrementStatic("imports");
        db().statics = { messages: 3, imports: db().statics.imports };
        collectionStore.incrementStatic("imports");
        collectionStore.incrementStatic("messages");
        expect(plain(db().statics)).toEqual({ messages: 4, imports: 2 });
        await sync.flushResources();
        expect(record("statics")).toEqual({ messages: 4, imports: 2 });
        db().statics = { messages: "x", imports: Number.NaN };
        collectionStore.incrementStatic("messages");
        expect(db().statics.messages).toBe(1);
    });

    it("adds a preset under a fresh id with the canonical fields, without the credentials", async () => {
        const { sync, collectionStore, record, db, selection, refused, validation } = await boot();
        const selected = selection.presetId;
        const id = collectionStore.addPreset({
            name: "Added",
            temperature: 7,
            proxyKey: "secret",
            unknownField: 1,
            id: "given",
        });
        expect(id).not.toBe("given");
        expect(db().botPresets.map((preset: any) => preset.id)).toContain(id);
        expect(selection.presetId).toBe(selected);
        await sync.flushResources();
        const saved = record("presets").find((preset: any) => preset.id === id);
        expect(saved).toMatchObject({ name: "Added", temperature: 7 });
        expect(saved).not.toHaveProperty("proxyKey");
        expect(saved).not.toHaveProperty("unknownField");
        expect(record("llmSecrets").presets ?? {}).not.toHaveProperty(id);
        await refused(() => collectionStore.addPreset([]), validation.MutationValidationError);
        await refused(() => collectionStore.addPreset({ name: () => 1 }), validation.MutationValidationError);
    });
});

describe("personas", () => {
    it("setPersonas assigns ids to new entries, keeps existing ones, and reconciles the selection", async () => {
        const { sync, collectionStore, selectionModule, selection, record, db } = await boot();
        const first = db().personas[0].id;
        collectionStore.addPersona({ name: "Second", id: "second" });
        selectionModule.selectPersona("second");
        expect(db().username).toBe("Second");
        collectionStore.setPersonas([{ name: "Kept", id: first }, { name: "Fresh" }, "not an object"]);
        expect(db().personas.map((persona: any) => persona.name)).toEqual(["Kept", "Fresh"]);
        expect(db().personas[0].id).toBe(first);
        expect(db().personas[1].id).toEqual(expect.any(String));
        expect(db().personas[1]).toMatchObject({ icon: "", personaPrompt: "", note: "" });
        // The selected persona is gone: the selection falls back to the first record.
        expect(selection.personaId).toBe(first);
        expect(db().username).toBe("Kept");
        await sync.flushResources();
        expect(record("personas").map((persona: any) => persona.name)).toEqual(["Kept", "Fresh"]);
        expect(record("personas")[1].id).toBe(db().personas[1].id);
    });

    it("setPersonas refuses a non-list or non-data input, and never leaves the list empty", async () => {
        const { sync, collectionStore, refused, validation, record, db } = await boot();
        await refused(() => collectionStore.setPersonas({ name: "x" }), validation.MutationValidationError);
        await refused(() => collectionStore.setPersonas([{ name: () => 1 }]), validation.MutationValidationError);
        collectionStore.setPersonas([]);
        expect(db().personas).toHaveLength(1);
        await sync.flushResources();
        expect(record("personas")).toHaveLength(1);
    });

    it("addPersona assigns a new id when it is missing, invalid, or taken, and keeps a valid one", async () => {
        const { sync, collectionStore, record, db, refused, validation } = await boot();
        const first = db().personas[0].id;
        const missing = collectionStore.addPersona({ name: "A" });
        const taken = collectionStore.addPersona({ name: "B", id: first });
        const empty = collectionStore.addPersona({ name: "C", id: "" });
        expect(collectionStore.addPersona({ name: "D", id: "mine", personaPrompt: 5 })).toBe("mine");
        expect(new Set([first, missing, taken, empty, "mine"]).size).toBe(5);
        expect(db().personas.at(-1)).toMatchObject({ id: "mine", personaPrompt: "", icon: "", note: "" });
        await sync.flushResources();
        expect(record("personas").map((persona: any) => persona.id)).toEqual([first, missing, taken, empty, "mine"]);
        await refused(() => collectionStore.addPersona("x"), validation.MutationValidationError);
    });

    it("updatePersona refuses the id and non-string persona fields, throws for a missing persona, and stores prototype-named keys", async () => {
        const { sync, collectionStore, record, db, refused, validation } = await boot();
        const id = db().personas[0].id;
        await refused(() => collectionStore.updatePersona(id, { id: "other" }), validation.MutationValidationError);
        await refused(() => collectionStore.updatePersona(id, { name: 1 }), validation.MutationValidationError);
        await refused(() => collectionStore.updatePersona(id, { note: undefined }), validation.MutationValidationError);
        await refused(() => collectionStore.updatePersona("nope", { name: "x" }), validation.MutationTargetGoneError);
        collectionStore.updatePersona(id, { name: "Renamed", extra: 1, constructor: 1, hasOwnProperty: "h" });
        collectionStore.updatePersona(id, { extra: undefined });
        expect(db().username).toBe("Renamed");
        expect(db().personas[0].id).toBe(id);
        expect(plain(db().personas[0])).toMatchObject({ constructor: 1, hasOwnProperty: "h" });
        expect(plain(db().personas[0])).not.toHaveProperty("extra");
        await sync.flushResources();
        expect(record("personas")[0]).toMatchObject({ id, name: "Renamed", constructor: 1, hasOwnProperty: "h" });
    });
});

describe("modules", () => {
    it("adds, replaces, patches, and removes modules by id, and keeps enabledModules on removal", async () => {
        const { sync, collectionStore, record, db, refused, validation } = await boot();
        const generated = collectionStore.addModule({ name: "gen" });
        expect(collectionStore.addModule({ name: "given", id: "given" })).toBe("given");
        expect(collectionStore.findModule("given")?.name).toBe("given");
        collectionStore.setEnabledModules(["given", "given", generated]);
        expect(db().enabledModules).toEqual(["given", generated]);
        expect(collectionStore.updateModule("given", { name: "patched", toString: "t", extra: 1 })).toBe(true);
        expect(collectionStore.updateModule("given", { extra: undefined })).toBe(true);
        expect(collectionStore.updateModule("nope", { name: "x" })).toBe(false);
        await sync.flushResources();
        await refused(() => collectionStore.updateModule("given", { id: "x" }), validation.MutationValidationError);
        expect(plain(collectionStore.findModule("given"))).toEqual({ id: "given", name: "patched", toString: "t" });
        expect(collectionStore.removeModule(generated)).toBe(true);
        expect(collectionStore.removeModule(generated)).toBe(false);
        expect(db().enabledModules).toEqual(["given", generated]);
        collectionStore.setModuleEnabled(generated, false);
        collectionStore.setModuleEnabled("third", true);
        collectionStore.setModuleEnabled("third", true);
        expect(db().enabledModules).toEqual(["given", "third"]);
        await sync.flushResources();
        expect(record("modules")).toEqual([{ id: "given", name: "patched", toString: "t" }]);
        expect(record("enabledModules")).toEqual(["given", "third"]);
        collectionStore.setModules([{ name: "only" }, { id: "", name: "empty id" }]);
        expect(db().modules.every((module: any) => typeof module.id === "string" && module.id !== "")).toBe(true);
        await sync.flushResources();
        expect(record("modules").map((module: any) => module.name)).toEqual(["only", "empty id"]);
    });

    it("refuses sparse or malformed module and enabled-module lists synchronously", async () => {
        const { collectionStore, refused, validation } = await boot();
        for (const list of [Array(1), [null], ["x"], [{ name: () => 1 }], {}]) {
            await refused(() => collectionStore.setModules(list), validation.MutationValidationError);
        }
        for (const ids of [Array(1), [1], [null], "a", { 0: "a" }]) {
            await refused(() => collectionStore.setEnabledModules(ids), validation.MutationValidationError);
        }
        await refused(() => collectionStore.addModule("m"), validation.MutationValidationError);
    });
});

describe("character order, plugins, and OAuth entries", () => {
    it("setCharacterOrder accepts ids and folders with member lists, and refuses anything else", async () => {
        const { sync, collectionStore, record, db, refused, validation } = await boot();
        for (const order of [
            [[]],
            [{}],
            [{ data: "c" }],
            [{ data: [1] }],
            [1],
            [null],
            Array(1),
            "c",
            [{ data: [] }, () => 1],
        ]) {
            await refused(() => collectionStore.setCharacterOrder(order), validation.MutationValidationError);
        }
        const folder = { id: "f", name: "F", data: ["c"] };
        collectionStore.setCharacterOrder(["c", folder]);
        folder.data.push("mutated");
        expect(plain(db().characterOrder)).toEqual(["c", { id: "f", name: "F", data: ["c"] }]);
        await sync.flushResources();
        expect(record("characterOrder")).toEqual(["c", { id: "f", name: "F", data: ["c"] }]);
    });

    it("setPlugins, upsertPlugin, and setPluginArgument write the plugin list by name", async () => {
        const { sync, collectionStore, record, db, refused, validation } = await boot();
        for (const list of [Array(1), [null], [{}], [{ name: "" }], [{ name: 1 }], {}]) {
            await refused(() => collectionStore.setPlugins(list), validation.MutationValidationError);
        }
        await refused(() => collectionStore.upsertPlugin({ name: "" }), validation.MutationValidationError);
        collectionStore.upsertPlugin({ name: "plug", realArg: { a: "2" }, version: 2 });
        collectionStore.upsertPlugin({ name: "other", realArg: {} });
        collectionStore.setPlugins([...plain(db().plugins), { name: "plug", realArg: {} }]);
        expect(db().plugins.map((plugin: any) => plugin.name)).toEqual(["plug", "other", "plug"]);
        // Every plugin with that name, as `setArg` does.
        expect(collectionStore.setPluginArgument("plug", "k", "v")).toBe(true);
        expect(collectionStore.setPluginArgument("plug", "n", 3)).toBe(true);
        expect(collectionStore.setPluginArgument("nope", "k", "v")).toBe(false);
        await sync.flushResources();
        await refused(
            () => collectionStore.setPluginArgument("plug", "k", { o: 1 }),
            validation.MutationValidationError,
        );
        await refused(
            () => collectionStore.setPluginArgument("plug", "k", Number.NaN),
            validation.MutationValidationError,
        );
        expect(collectionStore.setPluginArgument("other", "constructor", "c")).toBe(true);
        expect(collectionStore.setPluginArgument("other", "__proto__", "p")).toBe(true);
        expect(collectionStore.setPluginArgument("other", "toString", "t")).toBe(true);
        expect(plain(db().plugins[0].realArg)).toEqual({ a: "2", k: "v", n: 3 });
        expect(plain(db().plugins[2].realArg)).toEqual({ k: "v", n: 3 });
        const otherArgs = plain(db().plugins[1].realArg);
        expect(Object.hasOwn(otherArgs, "__proto__")).toBe(true);
        expect(otherArgs).toMatchObject({ constructor: "c", toString: "t" });
        expect(Object.getPrototypeOf(db().plugins[1].realArg)).toBe(Object.prototype);
        await sync.flushResources();
        const saved = record("plugins");
        // The mirror keeps the own `__proto__`; the `plugins` projection goes through `$state.snapshot`,
        // which drops it (the adapter's rule, `persistence.md`: only `pluginStorage` is serialized from the proxy).
        const { ["__proto__"]: dropped, ...otherSaved } = otherArgs;
        expect(dropped).toBe("p");
        expect(saved.map((plugin: any) => plugin.realArg)).toEqual([
            { a: "2", k: "v", n: 3 },
            otherSaved,
            { k: "v", n: 3 },
        ]);
        expect(Object.hasOwn(saved[1].realArg, "__proto__")).toBe(false);
    });

    it("addAuthRefresh refuses a non-string field and saves a valid entry", async () => {
        const { sync, collectionStore, record, refused, validation } = await boot();
        for (const entry of [
            { url: 7 },
            { tokenUrl: null },
            { clientSecret: {} },
            "x",
            [],
            { refreshToken: () => 1 },
        ]) {
            await refused(() => collectionStore.addAuthRefresh(entry), validation.MutationValidationError);
        }
        collectionStore.addAuthRefresh({
            url: "https://mcp",
            tokenUrl: "https://mcp/token",
            refreshToken: "r",
            clientId: "id",
        });
        await sync.flushResources();
        expect(record("authRefreshes")).toEqual([
            { url: "https://mcp", tokenUrl: "https://mcp/token", refreshToken: "r", clientId: "id" },
        ]);
    });

    it("addAuthRefresh keeps one entry per server url: a new login replaces every entry of that url in place and keeps the others (Phase 5 slice 12a)", async () => {
        const { sync, collectionStore, record, db } = await boot();
        collectionStore.addAuthRefresh({ url: "https://a", refreshToken: "1" });
        collectionStore.addAuthRefresh({ url: "https://b", refreshToken: "2" });
        // A duplicate from before the replacement rule (the core app wrote the list directly).
        db().authRefreshes.push({ url: "https://a", refreshToken: "3" } as never);
        collectionStore.addAuthRefresh({ url: "https://a", refreshToken: "9", tokenUrl: "https://a/token" });
        expect(plain(db().authRefreshes)).toEqual([
            { url: "https://a", refreshToken: "9", tokenUrl: "https://a/token" },
            { url: "https://b", refreshToken: "2" },
        ]);
        // An entry without a url is appended, as before.
        collectionStore.addAuthRefresh({ refreshToken: "no-url" });
        await sync.flushResources();
        expect(record("authRefreshes")).toEqual([
            { url: "https://a", refreshToken: "9", tokenUrl: "https://a/token" },
            { url: "https://b", refreshToken: "2" },
            { refreshToken: "no-url" },
        ]);
    });
});
