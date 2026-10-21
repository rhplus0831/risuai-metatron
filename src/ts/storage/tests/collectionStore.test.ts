import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations, plain } from "./mutationStoresHarness";

// The settings, persona, module, plugin, order, OAuth, and preset mutations
// (`collectionStore.svelte.ts`) against the real server store. Every refusal is checked to throw
// and change nothing (mirror and server compared after the next cycle); every write is checked in
// the mirror and on the server after the cycle. A forwarded settings write is a mutation carrying
// the preset id.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
}));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertReloadNotice: alerts.normal,
        alertNormalWait: alerts.normalWait,
    }),
);
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
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const presets = await import("../presets.svelte");
    return { ...booted, presets };
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
    it("writes a forwarded key into the selected preset of its owner by id, and with presetId or modelPresetId into that preset after a switch", async () => {
        const { sync, collectionStore, presets, selection, record, settings, settingsViews, activePreset } =
            await boot();
        const [p1, p2] = settings.presets.map((preset: any) => preset.id);
        const [m1, m2] = settings.modelPresets.map((preset: any) => preset.id);
        // `maxContext` is a profile field written into the main slot's profile: give m2 its own main
        // profile so each owner is distinct.
        const [f1] = settings.modelProfiles.map((profile: any) => profile.id);
        const f2 = collectionStore.addModelProfile({ name: "F2" });
        expect(collectionStore.setMainModelSlot(m2, f2)).toBe(true);
        const profile = (id: string): any => settings.modelProfiles.find((entry: any) => entry.id === id);
        const activeMainProfile = settingsViews.activeMainProfile;
        expect(selection.presetId).toBe(p1);
        expect(selection.modelPresetId).toBe(m1);
        // `temperature` is the prompt preset's.
        collectionStore.updateSettings({ temperature: 5, maxContext: 1234 });
        expect(activePreset.temperature).toBe(5);
        expect(activeMainProfile.maxContext).toBe(1234);
        expect(profile(f1).maxContext).toBe(1234);
        expect(settings.presets[1].temperature).not.toBe(5);
        expect(profile(f2).maxContext).not.toBe(1234);
        expect(settings.presets.every((preset: any) => !("maxContext" in preset))).toBe(true);
        expect(settings.modelPresets.every((preset: any) => !("maxContext" in preset))).toBe(true);
        // A caller that captured p1/m1 before an await writes there although p2/m2 are selected now.
        presets.changeToPreset(p2);
        presets.changeToModelPreset(m2);
        expect(selection.presetId).toBe(p2);
        expect(selection.modelPresetId).toBe(m2);
        collectionStore.updateSettings({ temperature: 9, maxContext: 1999 }, { presetId: p1, modelPresetId: m1 });
        expect(settings.presets[0].temperature).toBe(9);
        expect(profile(f1).maxContext).toBe(1999);
        expect(activePreset.temperature).not.toBe(9);
        expect(activeMainProfile.maxContext).not.toBe(1999);
        // Each id names its own owner: a captured prompt preset with the selected model preset.
        collectionStore.updateSettings({ temperature: 2, maxContext: 2222 }, { presetId: p1 });
        expect(settings.presets[0].temperature).toBe(2);
        expect(profile(f2).maxContext).toBe(2222);
        collectionStore.updateSettings({ temperature: 3 });
        expect(settings.presets[1].temperature).toBe(3);
        await sync.flushResources();
        const saved = record("presets");
        expect(saved.map((preset: any) => [preset.id, preset.temperature])).toEqual([
            [p1, 2],
            [p2, 3],
        ]);
        expect(record("modelProfiles").map((entry: any) => [entry.id, entry.maxContext])).toEqual([
            [f1, 1999],
            [f2, 2222],
        ]);
        expect(record("modelPresets").every((preset: any) => !("maxContext" in preset))).toBe(true);
    });

    it("writes a former keep-on-switch key into its owning preset and section keys into their sections, including absent optional fields", async () => {
        const { sync, collectionStore, record, settings, selection } = await boot();
        expect(settings.ui.guiHTML).toBeUndefined();
        expect(settings.secrets.googleSearchCredentials).toBeUndefined();
        collectionStore.updateSettings({
            seperateModelsForAxModels: true,
            seperateParameters: { memory: { temperature: 1 }, emotion: {}, translate: {}, otherAx: {}, overrides: {} },
            theme: "waifu",
            guiHTML: "<div/>",
            googleSearchCredentials: { apiKey: "k", searchEngineId: "e" },
            hypaModel: "m",
        });
        await sync.flushResources();
        // The `providers` section holds none of the five any more.
        expect(record("providers")).not.toHaveProperty("seperateModelsForAxModels");
        expect(record("providers")).not.toHaveProperty("seperateParameters");
        const modelPreset = record("modelPresets").find((preset: any) => preset.id === selection.modelPresetId);
        expect(modelPreset.seperateModelsForAxModels).toBe(true);
        const preset = record("presets").find((preset: any) => preset.id === selection.presetId);
        expect(preset.seperateParameters.memory).toEqual({ temperature: 1 });
        expect(record("ui")).toMatchObject({ theme: "waifu", guiHTML: "<div/>" });
        expect(record("secrets").googleSearchCredentials).toEqual({ apiKey: "k", searchEngineId: "e" });
        expect(record("memoryTranslateMedia").hypaModel).toBe("m");
        expect(record("presets").every((preset: any) => !("theme" in preset))).toBe(true);
        expect(record("presets").every((preset: any) => preset.seperateModelsForAxModels === undefined)).toBe(true);
        expect(record("modelPresets").every((preset: any) => preset.seperateParameters === undefined)).toBe(true);
    });

    it("applies the preset aliases and the nullable rule, and detaches the value", async () => {
        const { sync, collectionStore, record, settings, refused, validation } = await boot();
        const nai = { cfg_scale: 3 };
        collectionStore.updateSettings({ NAIsettings: nai, min_p: null, reasoningEffort: 2 });
        nai.cfg_scale = 4;
        expect(settings.presets[0].NAISettings.cfg_scale).toBe(3);
        expect(settings.presets[0].min_p).toBeNull();
        expect(settings.presets[0].reasonEffort).toBe(2);
        await sync.flushResources();
        expect(record("presets")[0]).toMatchObject({ NAISettings: { cfg_scale: 3 }, min_p: null, reasonEffort: 2 });
        await refused(() => collectionStore.updateSettings({ temperature: null }), validation.MutationValidationError);
        await refused(() => collectionStore.updateSettings({ theme: null }), validation.MutationValidationError);
        await refused(() => collectionStore.updateSettings({ theme: undefined }), validation.MutationValidationError);
        await refused(() => collectionStore.updateSettings({ min_p: undefined }), validation.MutationValidationError);
    });

    it("validates a mixed patch before any write, and throws MutationTargetGoneError for a stale preset id", async () => {
        const { sync, collectionStore, refused, validation, record, activePreset, settingsViews } = await boot();
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
        // A gone model preset refuses a model key the same way, and only a model key.
        await refused(
            () => collectionStore.updateSettings({ theme: "t", maxContext: 1 }, { modelPresetId: "nope" }),
            validation.MutationTargetGoneError,
        );
        collectionStore.updateSettings({ temperature: 4 }, { modelPresetId: "nope" });
        expect(activePreset.temperature).toBe(4);
        // A section-only patch does not need the preset.
        collectionStore.updateSettings({ theme: "only" }, { presetId: "nope" });
        await sync.flushResources();
        expect(record("ui").theme).toBe("only");
        // `maxContext` is the main slot's profile's.
        expect(settingsViews.activeMainProfile.maxContext).not.toBe(999);
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
        const { sync, collectionStore, record, settings } = await boot();
        expect(plain(settings.statics)).toEqual({ messages: 0, imports: 0 });
        collectionStore.incrementStatic("imports");
        settings.statics = { messages: 3, imports: settings.statics.imports };
        collectionStore.incrementStatic("imports");
        collectionStore.incrementStatic("messages");
        expect(plain(settings.statics)).toEqual({ messages: 4, imports: 2 });
        await sync.flushResources();
        expect(record("statics")).toEqual({ messages: 4, imports: 2 });
        settings.statics = { messages: "x", imports: Number.NaN } as any;
        collectionStore.incrementStatic("messages");
        expect(settings.statics.messages).toBe(1);
    });

    it("adds a preset under a fresh id with the canonical fields, without the credentials", async () => {
        const { sync, collectionStore, record, settings, selection, refused, validation } = await boot();
        const selected = selection.presetId;
        const id = collectionStore.addPreset({
            name: "Added",
            temperature: 7,
            proxyKey: "secret",
            unknownField: 1,
            id: "given",
        });
        expect(id).not.toBe("given");
        expect(settings.presets.map((preset: any) => preset.id)).toContain(id);
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
        const { sync, collectionStore, selectionModule, selection, record, settings, activePersona } = await boot();
        const first = settings.personas[0].id;
        collectionStore.addPersona({ name: "Second", id: "second" });
        selectionModule.selectPersona("second");
        expect(activePersona.name).toBe("Second");
        collectionStore.setPersonas([{ name: "Kept", id: first }, { name: "Fresh" }, "not an object"]);
        expect(settings.personas.map((persona: any) => persona.name)).toEqual(["Kept", "Fresh"]);
        expect(settings.personas[0].id).toBe(first);
        expect(settings.personas[1].id).toEqual(expect.any(String));
        expect(settings.personas[1]).toMatchObject({ icon: "", personaPrompt: "", note: "" });
        // The selected persona is gone: the selection falls back to the first record.
        expect(selection.personaId).toBe(first);
        expect(activePersona.name).toBe("Kept");
        await sync.flushResources();
        expect(record("personas").map((persona: any) => persona.name)).toEqual(["Kept", "Fresh"]);
        expect(record("personas")[1].id).toBe(settings.personas[1].id);
    });

    it("setPersonas refuses a non-list or non-data input, and never leaves the list empty", async () => {
        const { sync, collectionStore, refused, validation, record, settings } = await boot();
        await refused(() => collectionStore.setPersonas({ name: "x" }), validation.MutationValidationError);
        await refused(() => collectionStore.setPersonas([{ name: () => 1 }]), validation.MutationValidationError);
        collectionStore.setPersonas([]);
        expect(settings.personas).toHaveLength(1);
        await sync.flushResources();
        expect(record("personas")).toHaveLength(1);
    });

    it("addPersona assigns a new id when it is missing, invalid, or taken, and keeps a valid one", async () => {
        const { sync, collectionStore, record, settings, refused, validation } = await boot();
        const first = settings.personas[0].id;
        const missing = collectionStore.addPersona({ name: "A" });
        const taken = collectionStore.addPersona({ name: "B", id: first });
        const empty = collectionStore.addPersona({ name: "C", id: "" });
        expect(collectionStore.addPersona({ name: "D", id: "mine", personaPrompt: 5 })).toBe("mine");
        expect(new Set([first, missing, taken, empty, "mine"]).size).toBe(5);
        expect(settings.personas.at(-1)).toMatchObject({ id: "mine", personaPrompt: "", icon: "", note: "" });
        await sync.flushResources();
        expect(record("personas").map((persona: any) => persona.id)).toEqual([first, missing, taken, empty, "mine"]);
        await refused(() => collectionStore.addPersona("x"), validation.MutationValidationError);
    });

    it("updatePersona refuses the id and non-string persona fields, throws for a missing persona, and stores prototype-named keys", async () => {
        const { sync, collectionStore, record, settings, activePersona, refused, validation } = await boot();
        const id = settings.personas[0].id;
        await refused(() => collectionStore.updatePersona(id, { id: "other" }), validation.MutationValidationError);
        await refused(() => collectionStore.updatePersona(id, { name: 1 }), validation.MutationValidationError);
        await refused(() => collectionStore.updatePersona(id, { note: undefined }), validation.MutationValidationError);
        await refused(() => collectionStore.updatePersona("nope", { name: "x" }), validation.MutationTargetGoneError);
        collectionStore.updatePersona(id, { name: "Renamed", extra: 1, constructor: 1, hasOwnProperty: "h" });
        collectionStore.updatePersona(id, { extra: undefined });
        expect(activePersona.name).toBe("Renamed");
        expect(settings.personas[0].id).toBe(id);
        expect(plain(settings.personas[0])).toMatchObject({ constructor: 1, hasOwnProperty: "h" });
        expect(plain(settings.personas[0])).not.toHaveProperty("extra");
        await sync.flushResources();
        expect(record("personas")[0]).toMatchObject({ id, name: "Renamed", constructor: 1, hasOwnProperty: "h" });
    });
});

describe("modules", () => {
    it("adds, replaces, patches, and removes modules by id, and keeps enabledModules on removal", async () => {
        const { sync, collectionStore, record, settings, refused, validation } = await boot();
        const generated = collectionStore.addModule({ name: "gen" });
        expect(collectionStore.addModule({ name: "given", id: "given" })).toBe("given");
        expect(collectionStore.findModule("given")?.name).toBe("given");
        collectionStore.setEnabledModules(["given", "given", generated]);
        expect(settings.enabledModules).toEqual(["given", generated]);
        expect(collectionStore.updateModule("given", { name: "patched", toString: "t", extra: 1 })).toBe(true);
        expect(collectionStore.updateModule("given", { extra: undefined })).toBe(true);
        expect(collectionStore.updateModule("nope", { name: "x" })).toBe(false);
        await sync.flushResources();
        await refused(() => collectionStore.updateModule("given", { id: "x" }), validation.MutationValidationError);
        expect(plain(collectionStore.findModule("given"))).toEqual({ id: "given", name: "patched", toString: "t" });
        expect(collectionStore.removeModule(generated)).toBe(true);
        expect(collectionStore.removeModule(generated)).toBe(false);
        expect(settings.enabledModules).toEqual(["given", generated]);
        collectionStore.setModuleEnabled(generated, false);
        collectionStore.setModuleEnabled("third", true);
        collectionStore.setModuleEnabled("third", true);
        expect(settings.enabledModules).toEqual(["given", "third"]);
        await sync.flushResources();
        expect(record("modules")).toEqual([{ id: "given", name: "patched", toString: "t" }]);
        expect(record("enabledModules")).toEqual(["given", "third"]);
        collectionStore.setModules([{ name: "only" }, { id: "", name: "empty id" }]);
        expect(settings.modules.every((module: any) => typeof module.id === "string" && module.id !== "")).toBe(true);
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
        const { sync, collectionStore, record, settings, refused, validation } = await boot();
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
        expect(plain(settings.characterOrder)).toEqual(["c", { id: "f", name: "F", data: ["c"] }]);
        await sync.flushResources();
        expect(record("characterOrder")).toEqual(["c", { id: "f", name: "F", data: ["c"] }]);
    });

    it("setPlugins, upsertPlugin, and setPluginArgument write the plugin list by name", async () => {
        const { sync, collectionStore, record, settings, refused, validation } = await boot();
        for (const list of [Array(1), [null], [{}], [{ name: "" }], [{ name: 1 }], {}]) {
            await refused(() => collectionStore.setPlugins(list), validation.MutationValidationError);
        }
        await refused(() => collectionStore.upsertPlugin({ name: "" }), validation.MutationValidationError);
        collectionStore.upsertPlugin({ name: "plug", realArg: { a: "2" }, version: 2 });
        collectionStore.upsertPlugin({ name: "other", realArg: {} });
        collectionStore.setPlugins([...plain(settings.plugins), { name: "plug", realArg: {} }]);
        expect(settings.plugins.map((plugin: any) => plugin.name)).toEqual(["plug", "other", "plug"]);
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
        expect(plain(settings.plugins[0].realArg)).toEqual({ a: "2", k: "v", n: 3 });
        expect(plain(settings.plugins[2].realArg)).toEqual({ k: "v", n: 3 });
        const otherArgs = plain(settings.plugins[1].realArg);
        expect(Object.hasOwn(otherArgs, "__proto__")).toBe(true);
        expect(otherArgs).toMatchObject({ constructor: "c", toString: "t" });
        expect(Object.getPrototypeOf(settings.plugins[1].realArg)).toBe(Object.prototype);
        await sync.flushResources();
        const saved = record("plugins");
        // The own `__proto__` is saved too: the `plugins` projection serializes the record, no longer
        // `$state.snapshot`, which dropped it.
        expect(saved.map((plugin: any) => plugin.realArg)).toEqual([
            { a: "2", k: "v", n: 3 },
            otherArgs,
            { k: "v", n: 3 },
        ]);
        expect(Object.hasOwn(saved[1].realArg, "__proto__")).toBe(true);
        expect(saved[1].realArg["__proto__"]).toBe("p");
        expect(Object.getPrototypeOf(saved[1].realArg)).toBe(Object.prototype);
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

    it("addAuthRefresh keeps one entry per server url: a new login replaces every entry of that url in place and keeps the others", async () => {
        const { sync, collectionStore, record, settings } = await boot();
        collectionStore.addAuthRefresh({ url: "https://a", refreshToken: "1" });
        collectionStore.addAuthRefresh({ url: "https://b", refreshToken: "2" });
        // A duplicate from before the replacement rule (the core app wrote the list directly).
        settings.authRefreshes.push({ url: "https://a", refreshToken: "3" } as never);
        collectionStore.addAuthRefresh({ url: "https://a", refreshToken: "9", tokenUrl: "https://a/token" });
        expect(plain(settings.authRefreshes)).toEqual([
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

describe("named credentials", () => {
    const keyPath = (id: string) => ({ kind: "entry" as const, field: "credentials" as const, id });

    it("adds metadata only, takes its key through the credential route, and a delete removes both but leaves the bindings", async () => {
        const { sync, collectionStore, record, settings, fake, mirrorText } = await boot();
        const secrets = await import("../llmSecrets.svelte");
        const work = collectionStore.addCredential({ name: "Work", type: "openai" });
        const sa = collectionStore.addCredential({
            name: "SA",
            type: "vertex",
            clientEmail: "sa@example.test",
            projectId: "proj-2",
        });
        const [profileId] = settings.modelProfiles.map((profile: any) => profile.id);
        secrets.setSecret(keyPath(work), "sk-named-SENTINEL");
        expect(collectionStore.setProfileCredential(profileId, work)).toBe(true);
        await sync.flushResources();
        expect(record("credentials")).toEqual([
            { id: work, name: "Work", type: "openai" },
            { id: sa, name: "SA", type: "vertex", clientEmail: "sa@example.test", projectId: "proj-2" },
        ]);
        expect(fake.secretRequests().map((request: any) => request.path)).toEqual([
            `/api/llm-secrets/credentials/~${work}/key`,
        ]);
        expect(record("llmSecrets").credentials).toEqual({ [work]: { key: "sk-named-SENTINEL" } });
        expect(JSON.stringify(fake.batchBodies())).not.toContain("sk-named-SENTINEL");
        expect(mirrorText()).not.toContain("sk-named-SENTINEL");

        expect(collectionStore.deleteCredential(work)).toBe(true);
        expect(collectionStore.deleteCredential("missing-id")).toBe(false);
        await sync.flushResources();
        expect(record("credentials").map((entry: any) => entry.id)).toEqual([sa]);
        expect(record("llmSecrets").credentials).toEqual({});
        // The binding stays: the server refuses its requests, and the UI shows it as missing.
        expect(record("modelProfiles").find((profile: any) => profile.id === profileId).credentialId).toBe(work);
        expect(settings.modelProfiles.find((profile: any) => profile.id === profileId)!.credentialId).toBe(work);
    });

    it("updates a name and the Vertex fields, removes an optional field with undefined, and refuses a type change", async () => {
        const { sync, collectionStore, record, refused, validation } = await boot();
        const sa = collectionStore.addCredential({ name: "SA", type: "vertex", clientEmail: "a@x.test" });
        const work = collectionStore.addCredential({ name: "Work", type: "anthropic" });
        expect(collectionStore.updateCredential(sa, { name: "Service", projectId: "p", clientEmail: undefined })).toBe(
            true,
        );
        expect(collectionStore.updateCredential(work, { name: "Job", type: "anthropic" })).toBe(true);
        expect(collectionStore.updateCredential("missing-id", { name: "x" })).toBe(false);
        await sync.flushResources();
        expect(record("credentials")).toEqual([
            { id: sa, name: "Service", type: "vertex", projectId: "p" },
            { id: work, name: "Job", type: "anthropic" },
        ]);
        const invalid = validation.MutationValidationError;
        await refused(() => collectionStore.updateCredential(work, { type: "openai" }), invalid);
        await refused(() => collectionStore.updateCredential(work, { clientEmail: "a@x.test" }), invalid);
        await refused(() => collectionStore.updateCredential(work, { key: "sk-leak" }), invalid);
        await refused(() => collectionStore.updateCredential(work, { name: 1 }), invalid);
        await refused(() => collectionStore.updateCredential(sa, { projectId: null }), invalid);
    });

    it("refuses a new credential with a key, an unknown type or field, or a non-string name or Vertex field", async () => {
        const { collectionStore, refused, validation } = await boot();
        const invalid = validation.MutationValidationError;
        await refused(() => collectionStore.addCredential({ name: "A", type: "openai", key: "sk-leak" }), invalid);
        await refused(() => collectionStore.addCredential({ name: "A", type: "aws" }), invalid);
        await refused(() => collectionStore.addCredential({ name: "A", type: "openai", extra: 1 }), invalid);
        await refused(() => collectionStore.addCredential({ name: 1, type: "openai" }), invalid);
        await refused(() => collectionStore.addCredential({ name: "A", type: "vertex", clientEmail: 1 }), invalid);
        await refused(() => collectionStore.addCredential(null), invalid);
    });

    it("sets and removes a profile's binding synchronously, never storing null or an empty id", async () => {
        // `setProfileCredential` replaces the three former bindings.
        const { sync, collectionStore, record, settings, refused, validation } = await boot();
        const [f1] = settings.modelProfiles.map((profile: any) => profile.id);
        // A profile no slot uses too.
        const f2 = collectionStore.addModelProfile({ name: "F2", modelId: "xcustom:::a" });
        const profile = (id: string): any => settings.modelProfiles.find((entry: any) => entry.id === id);
        // A credential id that names no credential yet may be bound (it refuses when used).
        expect(collectionStore.setProfileCredential(f1, "cred-1")).toBe(true);
        expect(profile(f1).credentialId).toBe("cred-1");
        expect(collectionStore.setProfileCredential(f2, "cred-3")).toBe(true);
        expect(collectionStore.setProfileCredential("gone", "cred-3")).toBe(false);
        await sync.flushResources();
        expect(record("modelProfiles").map((entry: any) => [entry.id, entry.credentialId])).toEqual([
            [f1, "cred-1"],
            [f2, "cred-3"],
        ]);

        collectionStore.setProfileCredential(f1, null);
        expect(Object.hasOwn(profile(f1), "credentialId")).toBe(false);
        await sync.flushResources();
        expect(Object.hasOwn(record("modelProfiles")[0], "credentialId")).toBe(false);
        expect(record("modelProfiles")[1].credentialId).toBe("cred-3");

        const invalid = validation.MutationValidationError;
        await refused(() => collectionStore.setProfileCredential(f1, ""), invalid);
        await refused(() => collectionStore.setProfileCredential(f2, ""), invalid);
    });
});
