// @vitest-environment node
import { describe, expect, it } from "vitest";
import type {
    Credential,
    ModelPreset,
    ModelProfile,
    ModelSlot,
    RisuPersona,
    botPreset,
} from "../../../shared/database.ts";
import { DEFAULT_MODEL_PROFILE_ID, PRESET_DEFAULTS } from "../../../shared/presets.ts";
import { defaultMainPrompt, oldMainPrompt } from "../../../shared/presetTemplates.ts";
import { RESOURCE_KIND, type ResourceKindName } from "../../../shared/resources.ts";
import { COLLECTION_KIND, SECTION_KIND } from "../../../shared/sections.ts";
import type { UpstreamImportReport } from "../../../shared/upstreamBackup.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import { createResourceStore, ResourceValidationError, serialize } from "../data/resourceStore.ts";
import { convertUpstreamDatabase, type UpstreamConversion } from "../data/upstream/importDatabase.ts";

// `docs/plan/upstream-bin-compat.md` S3: the upstream flat `Database` → settings, presets, personas,
// and secrets converter, on plain synthetic objects (never a real backup). Covers the S3 "Test" list,
// the plan-review counterexamples (own-`undefined` root overlay, preset network repair, Hypa seeding,
// Ollama cloud migration, original-index selection, canonical profile dedup, translator index rules,
// unbound preset OpenAI keys, custom-model lookup rules, removed-feature reporting, per-entry
// recovery), input immutability, serialized fixed points, staged-store acceptance, and the
// recovery defects found in review (dangling slots, section fields, binding order, key extraction,
// `formatversion`, report categories, unreported repairs).

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);

type Selectable = { items: { id: string; name: string }[]; selectedId: string };
type LlmSecrets = Record<string, unknown> & { credentials: Record<string, { key: string }> };

function record<T>(out: UpstreamConversion, kind: ResourceKindName): T {
    const found = out.resources.filter((resource) => resource.kind === kind);
    expect(found, kind).toHaveLength(1);
    return found[0].data as T;
}

const presetsOf = (out: UpstreamConversion) => record<botPreset[]>(out, RESOURCE_KIND.presets);
const modelPresetsOf = (out: UpstreamConversion) => record<ModelPreset[]>(out, COLLECTION_KIND.modelPresets);
const profilesOf = (out: UpstreamConversion) => record<ModelProfile[]>(out, COLLECTION_KIND.modelProfiles);
const credentialsOf = (out: UpstreamConversion) => record<Credential[]>(out, COLLECTION_KIND.credentials);
const secretsOf = (out: UpstreamConversion) => record<LlmSecrets>(out, SECTION_KIND.llmSecrets);
const personasOf = (out: UpstreamConversion) => record<RisuPersona[]>(out, COLLECTION_KIND.personas);

function profileOf(out: UpstreamConversion, slot: ModelSlot | undefined): ModelProfile {
    expect(slot).toBeDefined();
    expect("profileId" in slot!).toBe(true);
    const profile = profilesOf(out).find((entry) => entry.id === (slot as { profileId: string }).profileId);
    expect(profile).toBeDefined();
    return profile!;
}

const modelPresetNamed = (out: UpstreamConversion, name: string) => {
    const preset = modelPresetsOf(out).find((entry) => entry.name === name);
    expect(preset, name).toBeDefined();
    return preset!;
};
const presetNamed = (out: UpstreamConversion, name: string) => {
    const preset = presetsOf(out).find((entry) => entry.name === name);
    expect(preset, name).toBeDefined();
    return preset!;
};

const entry = (list: UpstreamImportReport["converted"] | UpstreamImportReport["excluded"], code: string) =>
    list.find((item) => item.code === code);
const excluded = (out: UpstreamConversion, code: string) => entry(out.report.excluded, code);
const converted = (out: UpstreamConversion, code: string) => entry(out.report.converted, code);

/** An object nested `levels` deep (the store refuses JSON nested 256 levels or deeper). */
function deep(levels: number): Record<string, unknown> {
    let value: Record<string, unknown> = { x: 1 };
    for (let i = 0; i < levels; i++) {
        value = { next: value };
    }
    return value;
}

/** Every emitted model-preset slot names an emitted profile. */
function expectSlotsResolve(out: UpstreamConversion): void {
    const ids = new Set(profilesOf(out).map((profile) => profile.id));
    for (const preset of modelPresetsOf(out)) {
        for (const slot of [preset.mainSlot, preset.subSlot, ...Object.values(preset.auxSlots)]) {
            expect("profileId" in slot && ids.has(slot.profileId), `${preset.name} slot`).toBe(true);
        }
    }
}

/** Every bound credential has a metadata entry and a stored key. */
function expectBindingsResolve(out: UpstreamConversion): void {
    const credentials = credentialsOf(out);
    const secrets = secretsOf(out).credentials;
    for (const profile of profilesOf(out)) {
        if (profile.credentialId !== undefined) {
            expect(credentials.some((credential) => credential.id === profile.credentialId)).toBe(true);
            expect(typeof secrets[profile.credentialId]?.key).toBe("string");
        }
    }
    for (const credential of credentials) {
        expect(typeof secrets[credential.id]?.key).toBe("string");
    }
}

/**
 * A synthetic upstream database: the root is the working copy of `botPresets[0]` with newer values
 * than the stored preset; P1 and P2 share one endpoint, P3 uses another; a custom model with a key,
 * two personas, two translator presets, and fields the converter drops or reports.
 */
function fixture(): Record<string, unknown> {
    return {
        formatversion: 5,
        account: undefined,
        saveTime: 1,
        apiType: "reverse_proxy",
        aiModel: "reverse_proxy",
        subModel: "gpt-4o",
        forceReplaceUrl: "https://a.example/v1",
        proxyKey: "root-proxy",
        openAIKey: "sk-root",
        claudeAPIKey: "sk-claude",
        google: { accessToken: "g-token", projectId: "proj" },
        hordeConfig: { apiKey: "horde", model: "", softPrompt: "" },
        novelai: { token: "nai", model: "clio-v1" },
        OaiCompAPIKeys: { "https://x.example": "oai-comp" },
        temperature: 55,
        maxContext: 9000,
        maxResponse: 700,
        NAIsettings: { topK: 3 },
        presetRegex: [{ in: "a", out: "b", type: "editinput", ableFlag: false }],
        reasoningEffort: 2,
        openrouterProvider: "Anthropic",
        username: "Kim",
        userIcon: "assets/kim.png",
        personaPrompt: "pp",
        userNote: "note",
        botPresetsId: 0,
        selectedPersona: 1,
        translatorPresetId: 1,
        hypaV3PresetId: 0,
        personas: [
            { id: "p-a", name: "A", icon: "", personaPrompt: "", note: "" },
            { id: "p-b", name: "old", icon: "old.png", personaPrompt: "old", note: "" },
        ],
        translatorPresets: [
            { name: "T1", prompt: "x", maxResponse: 10 },
            { name: "T2", prompt: "y", maxResponse: 20 },
        ],
        hypaV3Presets: [{ name: "H1", settings: { memoryTokensRatio: 0.5 } }],
        customModels: [
            {
                id: "xcustom:::m1",
                internalId: "m1",
                url: "https://m1.example",
                format: 1,
                tokenizer: 0,
                name: "M1",
                params: "",
                flags: [],
                key: "cm-key",
            },
        ],
        seperateModels: { memory: "", translate: "xcustom:::m1", emotion: "", otherAx: "" },
        loreBook: [{ name: "LB", data: [] }],
        globalscript: [],
        hotkeys: [],
        characterOrder: ["c1"],
        enabledModules: ["mod"],
        statics: { messages: 3, imports: 1 },
        globalChatVariables: { a: "1" },
        togglePresets: [],
        useStreaming: true,
        loreBookToken: 12000,
        language: "ko",
        botPresets: [
            {
                name: "P0",
                aiModel: "reverse_proxy",
                subModel: "gpt-4o",
                forceReplaceUrl: "https://a.example/v1",
                proxyKey: "root-proxy",
                maxContext: 1234,
                temperature: 10,
                openAIKey: "sk-stale",
                NAISettings: { topK: 1 },
                regex: [],
                reasonEffort: 1,
                seperateModels: { memory: "", translate: "", emotion: "", otherAx: "" },
            },
            {
                name: "P1",
                aiModel: "reverse_proxy",
                subModel: "gpt-4o",
                forceReplaceUrl: "https://a.example/v1",
                proxyKey: "shared-proxy",
                maxContext: 9000,
                temperature: 99,
            },
            {
                name: "P2",
                aiModel: "reverse_proxy",
                subModel: "gpt-4o",
                forceReplaceUrl: "https://a.example/v1",
                proxyKey: "shared-proxy",
                maxContext: 9000,
                temperature: 98,
            },
            {
                name: "P3",
                aiModel: "reverse_proxy",
                subModel: "gpt-4o",
                forceReplaceUrl: "https://b.example/v1",
                proxyKey: "shared-proxy",
                maxContext: 9000,
            },
        ],
        weirdField: 3,
        fullScreen: true,
        loadouts: [{ name: "x" }],
    };
}

/** The S3 kinds (materialized singletons) and the S4 records always emitted (`pluginStorage` only when upstream had one). */
const EMITTED_KINDS: ResourceKindName[] = [
    ...Object.values(SECTION_KIND),
    ...Object.values(COLLECTION_KIND),
    RESOURCE_KIND.presets,
    RESOURCE_KIND.modules,
    RESOURCE_KIND.plugins,
];
const CREATED_KINDS: ResourceKindName[] = [RESOURCE_KIND.modules, RESOURCE_KIND.plugins, RESOURCE_KIND.pluginStorage];

describe("convertUpstreamDatabase: records", () => {
    it("emits every expected kind once as a serialized fixed point of its normalizer, and nothing else", () => {
        const out = convertUpstreamDatabase(fixture());
        expect(out.resources.map((resource) => resource.kind).sort()).toEqual([...EMITTED_KINDS].sort());
        for (const resource of out.resources) {
            expect(resource.id).toBe("main");
            const kind = kinds.get(resource.kind)!;
            const { stored, text } = serialize(resource.data);
            const again = kind.normalize(stored, { id: resource.id });
            expect(JSON.stringify(again), resource.kind).toBe(text);
        }
    });

    it("does not mutate the input", () => {
        const db = fixture();
        const before = JSON.stringify(db);
        const keys = Object.keys(db);
        convertUpstreamDatabase(db);
        expect(JSON.stringify(db)).toBe(before);
        expect(Object.keys(db)).toEqual(keys);
        expect("account" in db && db.account === undefined).toBe(true);
    });

    it("is accepted by a fresh staged store: materialized records at their current revision, the others created", () => {
        const out = convertUpstreamDatabase(fixture());
        const store = createResourceStore({ file: ":memory:", kinds });
        try {
            for (const resource of out.resources) {
                const kind = kinds.get(resource.kind)!;
                const current = store.get(kind, resource.id);
                expect(current === null, resource.kind).toBe(CREATED_KINDS.includes(resource.kind));
                store.put(kind, resource.id, resource.data, current?.revision ?? null);
                expect(store.get(kind, resource.id)!.data, resource.kind).toEqual(resource.data);
            }
        } finally {
            store.close();
        }
    });

    it("refuses only a database that is not an object", () => {
        expect(() => convertUpstreamDatabase(null)).toThrow(ResourceValidationError);
        expect(() => convertUpstreamDatabase([])).toThrow(ResourceValidationError);
        expect(() => convertUpstreamDatabase({})).not.toThrow();
    });

    it("counts the produced records", () => {
        const out = convertUpstreamDatabase(fixture());
        expect(out.report.counts).toEqual({
            promptPresets: 4,
            modelPresets: 4,
            modelProfiles: profilesOf(out).length - 1,
            credentials: credentialsOf(out).length,
            personas: 2,
            customModels: 1,
            characters: 0,
            groups: 0,
            chats: 0,
            messages: 0,
            modules: 0,
            plugins: 0,
        });
        expect(profilesOf(out)[0].id).toBe(DEFAULT_MODEL_PROFILE_ID);
    });
});

describe("convertUpstreamDatabase: presets (D6)", () => {
    it("shares one profile between presets on the same endpoint and splits another endpoint", () => {
        const out = convertUpstreamDatabase(fixture());
        const p1 = modelPresetNamed(out, "P1");
        const p2 = modelPresetNamed(out, "P2");
        const p3 = modelPresetNamed(out, "P3");
        expect(p1.mainSlot).toEqual(p2.mainSlot);
        expect(p1.subSlot).toEqual(p2.subSlot);
        expect(p1.mainSlot).not.toEqual(p3.mainSlot);
        expect(p1.subSlot).not.toEqual(p3.subSlot);
        expect(profileOf(out, p1.mainSlot).forceReplaceUrl).toBe("https://a.example/v1");
        expect(profileOf(out, p3.mainSlot).forceReplaceUrl).toBe("https://b.example/v1");
        expect(profileOf(out, p1.subSlot).modelId).toBe("gpt-4o");
        expectSlotsResolve(out);
    });

    it("dedups profiles by content with sorted nested keys and splits on maxContext", () => {
        const db = fixture();
        db.botPresets = [
            { name: "S", aiModel: "openrouter", openrouterProvider: { order: ["a"], only: [], ignore: [] } },
            { name: "A", aiModel: "openrouter", openrouterProvider: { ignore: [], only: [], order: ["a"] } },
            { name: "B", aiModel: "openrouter", openrouterProvider: { order: ["a"], only: [], ignore: [] } },
            {
                name: "C",
                aiModel: "openrouter",
                openrouterProvider: { order: ["a"], only: [], ignore: [] },
                maxContext: 1,
            },
        ];
        db.botPresetsId = 0;
        const out = convertUpstreamDatabase(db);
        const a = profileOf(out, modelPresetNamed(out, "A").mainSlot);
        expect(modelPresetNamed(out, "B").mainSlot).toEqual({ profileId: a.id });
        const c = profileOf(out, modelPresetNamed(out, "C").mainSlot);
        expect(c.id).not.toBe(a.id);
        expect(c.maxContext).toBe(1);
        expect(a.maxContext).toBe(9000);
        expect(a.openrouterProvider).toEqual({ order: ["a"], only: [], ignore: [] });
        // S is selected: the root's provider string wins there, so S gets its own profile.
        expect(modelPresetNamed(out, "S").mainSlot).not.toEqual({ profileId: a.id });
        expect(profileOf(out, modelPresetNamed(out, "S").mainSlot).openrouterProvider).toEqual({
            order: ["Anthropic"],
            only: [],
            ignore: [],
        });
    });

    it("lets the root working copy win over the selected preset's stale fields only", () => {
        const db = fixture();
        (db.botPresets as Record<string, unknown>[])[0].localStopStrings = ["stale"];
        db.localStopStrings = undefined;
        const out = convertUpstreamDatabase(db);
        const p0 = presetNamed(out, "P0");
        expect(p0.temperature).toBe(55);
        expect(p0.maxResponse).toBe(700);
        expect(p0.localStopStrings).toEqual(PRESET_DEFAULTS.localStopStrings);
        expect(profileOf(out, modelPresetNamed(out, "P0").mainSlot).maxContext).toBe(9000);
        expect(p0.maxContextOverrideSize).toBe(9000);
        expect(p0.maxContextOverride).toBe(false);
        expect(presetNamed(out, "P1").temperature).toBe(99);
        expect(presetNamed(out, "P2").temperature).toBe(98);
        // `setPreset`: a field the preset lacks falls back to the root's value, not the schema default.
        expect(presetNamed(out, "P3").temperature).toBe(55);
    });

    it("maps the aliases NAIsettings, presetRegex and reasoningEffort from the root", () => {
        const out = convertUpstreamDatabase(fixture());
        const p0 = presetNamed(out, "P0");
        expect(p0.NAISettings?.topK).toBe(3);
        expect(p0.regex).toHaveLength(1);
        expect(p0.reasonEffort).toBe(2);
        const p1 = presetNamed(out, "P1");
        expect(p1.NAISettings?.topK).toBe(3); // `setPreset`: a preset without NAISettings keeps the root's
        expect(p1.regex).toEqual([]);
        expect(p1.reasonEffort).toBe(0);
    });

    it("seeds the override size from maxContext with the override left off, per preset", () => {
        const db = fixture();
        db.botPresets = [
            { name: "Small", aiModel: "gpt-4o", maxContext: 123 },
            { name: "Inherits", aiModel: "gpt-4o" },
        ];
        db.botPresetsId = 5;
        const out = convertUpstreamDatabase(db);
        expect(presetNamed(out, "Small").maxContextOverride).toBe(false);
        expect(presetNamed(out, "Small").maxContextOverrideSize).toBe(123);
        expect(profileOf(out, modelPresetNamed(out, "Small").mainSlot).maxContext).toBe(123);
        expect(presetNamed(out, "Inherits").maxContextOverrideSize).toBe(9000);
        expect(profileOf(out, modelPresetNamed(out, "Inherits").mainSlot).maxContext).toBe(9000);
    });

    it("gives every set auxiliary model a profile sharing the main profile's options", () => {
        const out = convertUpstreamDatabase(fixture());
        const p0 = modelPresetNamed(out, "P0");
        expect(Object.keys(p0.auxSlots)).toEqual(["translate"]);
        const aux = profileOf(out, p0.auxSlots.translate);
        expect(aux.modelId).toBe("xcustom:::m1");
        expect(aux.forceReplaceUrl).toBe("https://a.example/v1");
        expect(modelPresetNamed(out, "P1").auxSlots).toEqual({});
    });

    it("repairs a stored preset's network fields before applying it (upstream setDatabase)", () => {
        const db = fixture();
        db.localNetworkMode = true;
        db.localNetworkTimeoutSec = 30;
        (db.botPresets as Record<string, unknown>[])[1].localNetworkMode = "yes";
        const out = convertUpstreamDatabase(db);
        expect(profileOf(out, modelPresetNamed(out, "P0").mainSlot).localNetworkMode).toBe(true);
        expect(profileOf(out, modelPresetNamed(out, "P0").mainSlot).localNetworkTimeoutSec).toBe(30);
        const p1 = profileOf(out, modelPresetNamed(out, "P1").mainSlot);
        expect(p1.localNetworkMode).toBe(false);
        expect(p1.localNetworkTimeoutSec).toBe(600);
    });

    it("migrates the openrouterProvider string on the root and on a preset", () => {
        const db = fixture();
        (db.botPresets as Record<string, unknown>[])[1].openrouterProvider = "Groq";
        const out = convertUpstreamDatabase(db);
        expect(profileOf(out, modelPresetNamed(out, "P0").mainSlot).openrouterProvider).toEqual({
            order: ["Anthropic"],
            only: [],
            ignore: [],
        });
        expect(profileOf(out, modelPresetNamed(out, "P1").mainSlot).openrouterProvider).toEqual({
            order: ["Groq"],
            only: [],
            ignore: [],
        });
        expect(profileOf(out, modelPresetNamed(out, "P3").mainSlot).openrouterProvider).toEqual(
            PRESET_DEFAULTS.openrouterProvider,
        );
    });

    it("returns the selected preset's converted ids (D4) and names the model preset after it", () => {
        const db = fixture();
        db.botPresetsId = 2;
        const out = convertUpstreamDatabase(db);
        expect(out.selection.promptPresetId).toBe(presetNamed(out, "P2").id);
        expect(out.selection.modelPresetId).toBe(modelPresetNamed(out, "P2").id);
        expect(presetsOf(out).map((preset) => preset.name)).toEqual(["P0", "P1", "P2", "P3"]);
        expect(modelPresetsOf(out).map((preset) => preset.name)).toEqual(["P0", "P1", "P2", "P3"]);
        expect(presetNamed(out, "P2").temperature).toBe(55);
        expect(presetNamed(out, "P0").temperature).toBe(10);
    });

    it("selects by original index past a dropped entry, and appends a root preset for a bad selection", () => {
        const db = fixture();
        db.botPresets = [null, { name: "Second" }];
        db.botPresetsId = 1;
        const out = convertUpstreamDatabase(db);
        expect(presetsOf(out).map((preset) => preset.name)).toEqual(["Second"]);
        expect(out.selection.promptPresetId).toBe(presetNamed(out, "Second").id);
        expect(excluded(out, "invalid-setting")?.examples).toEqual(["botPresets[0]"]);

        const bad = fixture();
        bad.botPresetsId = 7;
        const outBad = convertUpstreamDatabase(bad);
        expect(presetsOf(outBad).map((preset) => preset.name)).toEqual(["P0", "P1", "P2", "P3", "Default"]);
        expect(outBad.selection.promptPresetId).toBe(presetNamed(outBad, "Default").id);
        expect(presetNamed(outBad, "Default").temperature).toBe(55);
        expect(excluded(outBad, "invalid-setting")?.examples).toContain("botPresetsId");

        const none = convertUpstreamDatabase({});
        expect(presetsOf(none).map((preset) => preset.name)).toEqual(["Default"]);
        expect(none.report.excluded).toEqual([]);
    });
});

describe("convertUpstreamDatabase: secrets", () => {
    it("lands the root keys in llmSecrets", () => {
        const secrets = secretsOf(convertUpstreamDatabase(fixture()));
        expect(secrets.openAIKey).toBe("sk-root");
        expect(secrets.claudeAPIKey).toBe("sk-claude");
        expect(secrets.google).toEqual({ accessToken: "g-token", projectId: "proj" });
        expect((secrets.hordeConfig as { apiKey: string }).apiKey).toBe("horde");
        expect((secrets.novelai as { token: string }).token).toBe("nai");
        expect(secrets.OaiCompAPIKeys).toEqual({ "https://x.example": "oai-comp" });
    });

    it("turns each distinct proxyKey into one custom named key bound by its reverse_proxy profiles", () => {
        const out = convertUpstreamDatabase(fixture());
        const rootBound = profileOf(out, modelPresetNamed(out, "P0").mainSlot).credentialId!;
        const sharedBound = profileOf(out, modelPresetNamed(out, "P1").mainSlot).credentialId!;
        expect(rootBound).not.toBe(sharedBound);
        expect(profileOf(out, modelPresetNamed(out, "P2").mainSlot).credentialId).toBe(sharedBound);
        expect(profileOf(out, modelPresetNamed(out, "P3").mainSlot).credentialId).toBe(sharedBound);
        expect(profileOf(out, modelPresetNamed(out, "P0").subSlot).credentialId).toBeUndefined();
        const secrets = secretsOf(out).credentials;
        expect(secrets[rootBound]).toEqual({ key: "root-proxy" });
        expect(secrets[sharedBound]).toEqual({ key: "shared-proxy" });
        const credentials = credentialsOf(out);
        expect(credentials.find((credential) => credential.id === rootBound)).toEqual({
            id: rootBound,
            name: "Reverse proxy key",
            type: "custom",
        });
        expect(credentials.find((credential) => credential.id === sharedBound)?.type).toBe("custom");
        expect(converted(out, "proxy-key-to-credential")).toEqual({
            code: "proxy-key-to-credential",
            count: 4,
            examples: ["P0", "P1", "P2", "P3"],
        });
        expectBindingsResolve(out);
    });

    it("inherits the root proxyKey for a preset without one, as setPreset keeps it", () => {
        const db = fixture();
        delete (db.botPresets as Record<string, unknown>[])[3].proxyKey;
        const out = convertUpstreamDatabase(db);
        expect(profileOf(out, modelPresetNamed(out, "P3").mainSlot).credentialId).toBe(
            profileOf(out, modelPresetNamed(out, "P0").mainSlot).credentialId,
        );
    });

    it("keeps a preset openAIKey other than the root's as an unbound openai named key", () => {
        const out = convertUpstreamDatabase(fixture());
        const stale = credentialsOf(out).find((credential) => credential.type === "openai");
        expect(stale?.name).toBe("OpenAI key (P0)");
        expect(secretsOf(out).credentials[stale!.id]).toEqual({ key: "sk-stale" });
        expect(profilesOf(out).some((profile) => profile.credentialId === stale!.id)).toBe(false);
        expect(converted(out, "preset-openai-key-to-credential")).toEqual({
            code: "preset-openai-key-to-credential",
            count: 1,
            examples: ["P0"],
        });

        const same = fixture();
        (same.botPresets as Record<string, unknown>[])[0].openAIKey = "sk-root";
        const outSame = convertUpstreamDatabase(same);
        expect(credentialsOf(outSame).some((credential) => credential.type === "openai")).toBe(false);
        expect(converted(outSame, "preset-openai-key-to-credential")).toBeUndefined();
    });

    it("moves a customModels key into a named key bound by the first xcustom definition's profiles", () => {
        const db = fixture();
        db.customModels = [
            ...(db.customModels as unknown[]),
            { id: "xcustom:::m1", internalId: "dup", key: "dup-key" },
            { id: "plain-model", internalId: "plain", key: "plain-key" },
            { id: "xcustom:::blank", internalId: "blank", key: "   " },
            { id: "xcustom:::nokey", internalId: "nokey" },
            { name: "Broken", id: "xcustom:::broken", key: "broken-key" },
        ];
        const out = convertUpstreamDatabase(db);
        const definitions = record<{ id: string; key?: unknown }[]>(out, COLLECTION_KIND.customModels);
        expect(definitions.map((definition) => definition.id)).toEqual([
            "xcustom:::m1",
            "xcustom:::m1",
            "plain-model",
            "xcustom:::blank",
            "xcustom:::nokey",
        ]);
        expect(definitions.every((definition) => !("key" in definition))).toBe(true);
        const aux = profileOf(out, modelPresetNamed(out, "P0").auxSlots.translate);
        const bound = credentialsOf(out).find((credential) => credential.id === aux.credentialId);
        expect(bound).toEqual({ id: aux.credentialId, name: "M1 key", type: "custom" });
        expect(secretsOf(out).credentials[aux.credentialId!]).toEqual({ key: "cm-key" });
        const names = credentialsOf(out).map((credential) => credential.name);
        expect(names).toContain("xcustom:::m1 key");
        expect(names).toContain("plain-model key");
        expect(names).toContain("Broken key");
        expect(names.some((name) => name.startsWith("xcustom:::blank"))).toBe(false);
        expect(converted(out, "custom-model-key-to-credential")?.count).toBe(4);
        expect(excluded(out, "invalid-custom-model")).toEqual({
            code: "invalid-custom-model",
            count: 1,
            examples: ["Broken"],
        });
        expectBindingsResolve(out);
    });
});

describe("convertUpstreamDatabase: personas and selectable collections", () => {
    it("writes the root persona fields into the selected persona and selects it", () => {
        const out = convertUpstreamDatabase(fixture());
        const personas = personasOf(out);
        expect(personas.map((persona) => persona.id)).toEqual(["p-a", "p-b"]);
        expect(personas[1]).toMatchObject({ name: "Kim", icon: "assets/kim.png", personaPrompt: "pp", note: "note" });
        expect(personas[0]).toMatchObject({ name: "A", icon: "", personaPrompt: "" });
        expect(out.selection.personaId).toBe("p-b");
    });

    it("selects personas by original index and appends a root persona for a bad selection", () => {
        const db = fixture();
        db.personas = [null, { id: "p-a", name: "A" }, { id: "p-b", name: "B" }];
        db.selectedPersona = 2;
        const out = convertUpstreamDatabase(db);
        expect(personasOf(out).map((persona) => persona.name)).toEqual(["A", "Kim"]);
        expect(out.selection.personaId).toBe("p-b");
        expect(excluded(out, "invalid-setting")?.examples).toEqual(["personas[0]"]);

        const bad = fixture();
        bad.selectedPersona = 9;
        const outBad = convertUpstreamDatabase(bad);
        expect(personasOf(outBad).map((persona) => persona.name)).toEqual(["A", "old", "Kim"]);
        expect(outBad.selection.personaId).toBe(personasOf(outBad)[2].id);
        expect(excluded(outBad, "invalid-setting")?.examples).toContain("selectedPersona");

        const none = convertUpstreamDatabase({ username: "Solo" });
        expect(personasOf(none).map((persona) => persona.name)).toEqual(["Solo"]);
        expect(none.report.excluded).toEqual([]);
    });

    it("maps the numeric translatorPresetId to the selected item, integer check before clamp", () => {
        const out = convertUpstreamDatabase(fixture());
        const translator = record<Selectable>(out, COLLECTION_KIND.translatorPresets);
        expect(translator.items.map((item) => item.name)).toEqual(["T1", "T2"]);
        expect(translator.selectedId).toBe(translator.items[1].id);

        const fraction = fixture();
        fraction.translatorPresetId = 1.5;
        const first = record<Selectable>(convertUpstreamDatabase(fraction), COLLECTION_KIND.translatorPresets);
        expect(first.selectedId).toBe(first.items[0].id);

        const past = fixture();
        past.translatorPresetId = 99;
        const last = record<Selectable>(convertUpstreamDatabase(past), COLLECTION_KIND.translatorPresets);
        expect(last.selectedId).toBe(last.items[1].id);

        const legacy = convertUpstreamDatabase({
            translatorPrompt: "tp",
            translatorMaxResponse: 77,
            translatorPresets: [],
        });
        const seeded = record<{ items: { name: string; steps: { prompt: string; maxResponse: number }[] }[] }>(
            legacy,
            COLLECTION_KIND.translatorPresets,
        );
        expect(seeded.items).toHaveLength(1);
        expect(seeded.items[0].name).toBe("Default");
        expect(seeded.items[0].steps[0]).toMatchObject({ prompt: "tp", maxResponse: 77 });
        expect(legacy.report.excluded).toEqual([]);
    });

    it("seeds a missing HypaV3 list from the legacy settings and repairs a bad index", () => {
        const out = convertUpstreamDatabase({
            supaMemoryPrompt: "summarize",
            hypaV3Settings: { memoryTokensRatio: 0.5, summarizationPrompt: "legacy wins" },
            hypaV3PresetId: 0,
        });
        const hypa = record<{
            items: { id: string; name: string; settings: Record<string, unknown> }[];
            selectedId: string;
        }>(out, COLLECTION_KIND.hypaV3Presets);
        expect(hypa.items).toHaveLength(1);
        expect(hypa.items[0].name).toBe("Default");
        expect(hypa.items[0].settings).toMatchObject({ summarizationPrompt: "legacy wins", memoryTokensRatio: 0.5 });
        expect(hypa.selectedId).toBe(hypa.items[0].id);
        expect(out.report.excluded).toEqual([]);

        const bare = convertUpstreamDatabase({ supaMemoryPrompt: "summarize" });
        expect(record<typeof hypa>(bare, COLLECTION_KIND.hypaV3Presets).items[0].settings.summarizationPrompt).toBe(
            "summarize",
        );

        const db = fixture();
        db.hypaV3PresetId = 5;
        const repaired = convertUpstreamDatabase(db);
        const list = record<typeof hypa>(repaired, COLLECTION_KIND.hypaV3Presets);
        expect(list.items.map((item) => item.name)).toEqual(["H1"]);
        expect(list.selectedId).toBe(list.items[0].id);
        expect(excluded(repaired, "invalid-setting")?.examples).toEqual(["hypaV3PresetId"]);
    });

    it("recovers a collection entry by entry and reports the dropped ones by path", () => {
        const db = fixture();
        db.loreBook = [{ name: "A", data: [] }, null, { name: "B", data: [] }];
        db.translatorPresets = [{ name: "T1" }, 7, { name: "T3" }];
        db.translatorPresetId = 2;
        const out = convertUpstreamDatabase(db);
        expect(record<{ name: string }[]>(out, COLLECTION_KIND.loreBook).map((book) => book.name)).toEqual(["A", "B"]);
        const translator = record<Selectable>(out, COLLECTION_KIND.translatorPresets);
        expect(translator.items.map((item) => item.name)).toEqual(["T1", "T3"]);
        expect(translator.selectedId).toBe(translator.items[1].id);
        expect(excluded(out, "invalid-setting")?.count).toBe(2);
        expect([...excluded(out, "invalid-setting")!.examples].sort()).toEqual(["loreBook[1]", "translatorPresets[1]"]);
    });
});

describe("convertUpstreamDatabase: root migrations and the report", () => {
    it("applies the upstream load migrations metatron's normalizers no longer carry", () => {
        const out = convertUpstreamDatabase({
            loreBookToken: 4000,
            mainPrompt: oldMainPrompt,
            antiClaudeOverload: true,
            largeChatPerformanceMode: "balanced",
            customBackground: "C:\\Users\\me\\assets\\bg.png",
            userIcon: "D:\\risu\\assets\\icon.png",
            aiModel: "ollama-cloud",
            ollamaModel: "llama3",
            ollamaModelName: "Llama 3",
        });
        const providers = record<Record<string, unknown>>(out, SECTION_KIND.providers);
        const ui = record<Record<string, unknown>>(out, SECTION_KIND.ui);
        expect(providers.loreBookToken).toBe(8000);
        expect(providers.antiServerOverloads).toBe(true);
        expect(ui.streamingDisplayOptimizationMode).toBe("balanced");
        expect(ui.customBackground).toBe("assets/bg.png");
        expect(personasOf(out)[0].icon).toBe("assets/icon.png");
        expect(presetsOf(out)[0].mainPrompt).toBe(defaultMainPrompt);
        const main = profileOf(out, modelPresetsOf(out)[0].mainSlot);
        expect(main).toMatchObject({
            modelId: "ollama-cloud",
            ollamaModelSource: "cloud",
            ollamaCloudModel: "llama3",
            ollamaCloudModelName: "Llama 3",
        });
        expect(out.report.excluded).toEqual([]);

        const current = convertUpstreamDatabase({
            formatversion: 5,
            loreBookToken: 4000,
            customBackground: "C:\\Users\\me\\assets\\bg.png",
            aiModel: "gpt-4o",
        });
        expect(record<Record<string, unknown>>(current, SECTION_KIND.providers).loreBookToken).toBe(4000);
        expect(record<Record<string, unknown>>(current, SECTION_KIND.ui).customBackground).toBe(
            "C:\\Users\\me\\assets\\bg.png",
        );
        expect(profileOf(current, modelPresetsOf(current)[0].mainSlot).ollamaModelSource).toBe("local");
    });

    it("reports unknown, removed, account and loadout fields, and only when they hold a value", () => {
        const out = convertUpstreamDatabase({
            ...fixture(),
            account: { useSync: true },
            fullScreen: false,
            hypaMemoryKey: "set",
            emotionPrompt: "",
            lastLoadedLoadoutName: "",
            formatversion: 5,
            apiType: "openai",
        });
        expect(excluded(out, "unknown-setting")).toEqual({
            code: "unknown-setting",
            count: 1,
            examples: ["weirdField"],
        });
        expect(excluded(out, "removed-feature")).toEqual({
            code: "removed-feature",
            count: 1,
            examples: ["hypaMemoryKey"],
        });
        expect(excluded(out, "risu-account")).toEqual({ code: "risu-account", count: 1, examples: [] });
        expect(excluded(out, "loadouts")).toEqual({ code: "loadouts", count: 1, examples: ["loadouts"] });
        expect(excluded(out, "invalid-setting")).toBeUndefined();

        // The fixture's `enabledModules: ["mod"]` names no module (S4); its `characterOrder: ["c1"]` is dropped silently.
        const quiet = convertUpstreamDatabase(fixture());
        expect(quiet.report.excluded.map((item) => item.code).sort()).toEqual([
            "loadouts",
            "module-reference-missing",
            "removed-feature",
            "unknown-setting",
        ]);
        expect(excluded(quiet, "module-reference-missing")?.examples).toEqual(["mod"]);
        expect(excluded(quiet, "removed-feature")?.examples).toEqual(["fullScreen"]);
    });

    it("sees every upstream Database field of the fixture as known", () => {
        const db = fixture();
        delete db.weirdField;
        expect(excluded(convertUpstreamDatabase(db), "unknown-setting")).toBeUndefined();
    });
});

describe("convertUpstreamDatabase: recovery", () => {
    it("never emits a model-preset slot that names no profile (deeply nested profile option)", () => {
        for (const levels of [252, 253, 254, 255, 260]) {
            const out = convertUpstreamDatabase({
                botPresets: [
                    { name: "Deep", aiModel: "openrouter", openrouterProvider: deep(levels) },
                    { name: "Fine" },
                ],
                botPresetsId: 0,
            });
            expectSlotsResolve(out);
            expect(modelPresetsOf(out).length).toBe(presetsOf(out).length);
            expect(out.selection.modelPresetId).toBe(modelPresetsOf(out)[0].id);
            if (levels >= 254) {
                expect(presetsOf(out).map((preset) => preset.name)).toEqual(["Fine"]);
                expect(excluded(out, "invalid-setting")?.examples).toEqual(["botPresets[0]"]);
            } else {
                expect(presetsOf(out).map((preset) => preset.name)).toEqual(["Deep", "Fine"]);
            }
        }
    });

    it("drops only the malformed llmSecrets field and keeps the other keys and every bound credential", () => {
        const db = fixture();
        db.google = deep(260);
        const out = convertUpstreamDatabase(db);
        const secrets = secretsOf(out);
        expect(secrets.openAIKey).toBe("sk-root");
        expect(secrets.google).toEqual({ accessToken: "", projectId: "" });
        expect(Object.keys(secrets.credentials)).toHaveLength(credentialsOf(out).length);
        expectBindingsResolve(out);
        expect(excluded(out, "invalid-setting")).toEqual({ code: "invalid-setting", count: 1, examples: ["google"] });
    });

    it("binds a custom model from the first surviving definition", () => {
        const out = convertUpstreamDatabase({
            aiModel: "xcustom:::m",
            customModels: [
                { id: "xcustom:::m", internalId: "a", key: "k1", url: deep(260) },
                { id: "xcustom:::m", internalId: "b", key: "k2" },
            ],
            botPresets: [{ name: "P" }],
            botPresetsId: 0,
        });
        expect(record<{ internalId: string }[]>(out, COLLECTION_KIND.customModels).map((m) => m.internalId)).toEqual([
            "b",
        ]);
        const profile = profileOf(out, modelPresetsOf(out)[0].mainSlot);
        expect(secretsOf(out).credentials[profile.credentialId!]).toEqual({ key: "k2" });
        expect(
            Object.values(secretsOf(out).credentials)
                .map((secret) => secret.key)
                .sort(),
        ).toEqual(["k1", "k2"]);
        expect(excluded(out, "invalid-custom-model")?.examples).toEqual(["xcustom:::m"]);
    });

    it("keeps the keys of a preset whose prompt fields are refused", () => {
        const out = convertUpstreamDatabase({
            proxyKey: "pk",
            openAIKey: "root",
            aiModel: "reverse_proxy",
            botPresets: [{ name: "P", promptSettings: deep(260), openAIKey: "other" }],
            botPresetsId: 0,
        });
        expect(
            Object.values(secretsOf(out).credentials)
                .map((secret) => secret.key)
                .sort(),
        ).toEqual(["other", "pk"]);
        expect(
            credentialsOf(out)
                .map((credential) => credential.type)
                .sort(),
        ).toEqual(["custom", "openai"]);
        expect(excluded(out, "invalid-setting")?.examples).toEqual(["botPresets[0]"]);
        expect(converted(out, "proxy-key-to-credential")?.count).toBe(1);
    });

    it("reports a malformed formatversion instead of throwing, without the legacy floor", () => {
        const out = convertUpstreamDatabase({ formatversion: { toString: 0, valueOf: 0 }, loreBookToken: 4000 });
        expect(record<Record<string, unknown>>(out, SECTION_KIND.providers).loreBookToken).toBe(4000);
        expect(excluded(out, "invalid-setting")?.examples).toEqual(["formatversion"]);
    });

    it("reports both conversions when a custom model key equals the proxy key", () => {
        const out = convertUpstreamDatabase({
            proxyKey: "same",
            aiModel: "reverse_proxy",
            customModels: [{ id: "xcustom:::m", internalId: "a", key: "same" }],
            botPresets: [{ name: "P" }],
            botPresetsId: 0,
        });
        expect(converted(out, "proxy-key-to-credential")?.count).toBe(1);
        expect(converted(out, "custom-model-key-to-credential")?.count).toBe(1);
        expect(credentialsOf(out)).toHaveLength(1);
        expectBindingsResolve(out);
    });

    it("reports an invalid translator container", () => {
        const out = convertUpstreamDatabase({ translatorPresets: 42, translatorPrompt: "tp" });
        expect(record<Selectable>(out, COLLECTION_KIND.translatorPresets).items.map((item) => item.name)).toEqual([
            "Default",
        ]);
        expect(excluded(out, "invalid-setting")?.examples).toEqual(["translatorPresets"]);
    });

    it("replaces a non-finite number with the field default instead of dropping the record", () => {
        const db = fixture();
        db.temperature = Number.POSITIVE_INFINITY;
        db.loreBookToken = Number.NaN;
        const out = convertUpstreamDatabase(db);
        expect(presetNamed(out, "P0").temperature).toBe(PRESET_DEFAULTS.temperature);
        expect(record<Record<string, unknown>>(out, SECTION_KIND.providers).useStreaming).toBe(true);
        expect(excluded(out, "invalid-setting")).toBeUndefined();
    });
});
