import type { Credential, CredentialType, ModelPreset } from "../../../../shared/database.ts";
import { newId } from "../../../../shared/ids.ts";
import { LLMFormat } from "../../../../shared/llm.ts";
import {
    MODEL_PROFILE_DEFAULT_NAME,
    normalizeModelPreset,
    normalizeModelProfile,
    normalizeModelProfiles,
    normalizePreset,
    PERSONA_ROOT_ALIASES,
    plainClone,
    PRESET_ROOT_ALIASES,
    presetTemplate,
    PROMPT_PRESET_FIELDS,
} from "../../../../shared/presets.ts";
import {
    defaultJailbreak,
    defaultMainPrompt,
    oldJailbreak,
    oldMainPrompt,
} from "../../../../shared/presetTemplates.ts";
import { RESOURCE_KIND, type ResourceKindName, SINGLETON_RESOURCE_ID } from "../../../../shared/resources.ts";
import {
    COLLECTION_FIELDS,
    COLLECTION_KIND,
    COLLECTION_SELECTION_FIELDS,
    DROPPED_FIELDS,
    FORWARDED_ROOT_KEYS,
    MODEL_PROFILE_ROOT_FIELDS,
    PHASE1_FIELDS,
    SECTION_FIELDS,
    SECTION_KIND,
} from "../../../../shared/sections.ts";
import {
    addUpstreamReportEntry,
    createUpstreamImportReport,
    type UpstreamImportReport,
    type UpstreamImportSelection,
} from "../../../../shared/upstreamBackup.ts";
import { isPlainObject } from "../../../../shared/valueKinds.ts";
import { DEFAULT_RESOURCE_KINDS, type ResourceKind } from "../kinds.ts";
import { ResourceValidationError, serialize } from "../resourceStore.ts";

/**
 * The upstream RisuAI flat `Database` → metatron resources converter (`docs/plan/upstream-bin-compat.md`
 * S3: settings, presets, personas, secrets; S4 adds characters, chats, modules, plugins, and assets).
 * It works on the plain object `database.risudat` decodes to and does no I/O. Upstream behavior is
 * read from RisuAI `669b12ce` (`src/ts/storage/database.svelte.ts` `setDatabase`/`setPreset`,
 * `src/ts/bootstrap.ts` `checkNewFormat`); "U" below is that `src/ts/`.
 *
 * Every record's data is what its kind's own normalizer (`DEFAULT_RESOURCE_KINDS`) returns for the
 * stored form of the converted input, checked with the store's `serialize`, so a staged store
 * accepts it and its startup pass leaves it unchanged. A value the converter cannot make valid is
 * dropped (a list entry) or replaced by the kind's fresh-boot value (a record) and reported; only a
 * database that is not an object fails the conversion. The input is never mutated.
 *
 * Hand-off: every kind emitted here is a materialized singleton (`SINGLETON_RESOURCE_ID`), so a fresh
 * staged store already holds a record for each; the writer updates those at their current revision.
 * Each `(kind, id)` appears once. `characterOrder` and `enabledModules` are emitted as upstream
 * stored them; S4 replaces them after dropping ids of characters and modules it did not import.
 */

export type UpstreamResource = { kind: ResourceKindName; id: string; data: unknown };

export type UpstreamConversion = {
    resources: UpstreamResource[];
    selection: UpstreamImportSelection;
    report: UpstreamImportReport;
};

type Root = Record<string, unknown>;

const kinds = new Map<string, ResourceKind>(DEFAULT_RESOURCE_KINDS.map((kind) => [kind.name, kind]));

/** Root fields left to S4 (the Phase 1 collections) and to the preset step (`botPresets`). */
const nonSettingsFields = new Set<string>(PHASE1_FIELDS);

/** Root names of the prompt preset fields (`PRESET_ROOT_ALIASES` reversed). */
const promptRootNames: Record<string, string> = Object.fromEntries(
    Object.entries(PRESET_ROOT_ALIASES).map(([root, field]) => [field, root]),
);

/**
 * Root fields consumed by a conversion step, migrated, or inert upstream metadata: never reported.
 * `proxyKey` becomes a named key, `antiClaudeOverload`/`largeChatPerformanceMode` and the translator
 * and HypaV3 legacy fields feed their migrations, and the cold-storage flag's data is folded by S4.
 */
const silentFields = new Set<string>([
    "apiType",
    "proxyKey",
    "formatversion",
    "antiClaudeOverload",
    "largeChatPerformanceMode",
    "translatorPrompt",
    "translatorMaxResponse",
    "hypaV3Settings",
    "saveTime",
    "lastPatchNoteCheckVersion",
    "hubServerType",
    "modelCredentials",
    "proxyCredentialId",
    "coldstorage",
    "skipSavingAssetsOnWebSync",
]);

/** Upstream `Database` fields metatron removed with their feature (outside every `shared/sections.ts` list). */
const upstreamRemovedFields = [
    "keiServerURL",
    "betaMobileGUI",
    "lightningRealmImport",
    "pluginV2",
    "showDeprecatedTriggerV1",
    "doNotChangeSeperateModels",
    "fallbackModels",
    "doNotChangeFallbackModels",
    "fallbackWhenBlankResponse",
    "requestLocation",
    "enableRemoteSaving",
    "enableRisuaiProTools",
    "epEnabled",
    "seperateParametersByModel",
    "disableSeperateParameterChangeOnPresetChange",
    "customSidebarItems",
];

const removedFields = new Set<string>(
    [...DROPPED_FIELDS, ...upstreamRemovedFields].filter((field) => !silentFields.has(field)),
);

const knownFields = new Set<string>([
    ...Object.values(SECTION_FIELDS).flat(),
    ...Object.values(COLLECTION_FIELDS),
    ...Object.values(COLLECTION_SELECTION_FIELDS),
    ...PHASE1_FIELDS,
    ...FORWARDED_ROOT_KEYS,
]);

export function convertUpstreamDatabase(
    db: unknown,
    options: { report?: UpstreamImportReport } = {},
): UpstreamConversion {
    if (!isPlainObject(db)) {
        throw new ResourceValidationError("The upstream database is not an object");
    }
    const report = options.report ?? createUpstreamImportReport();
    const resources: UpstreamResource[] = [];
    const push = (kind: ResourceKindName, data: unknown) => resources.push({ kind, id: SINGLETON_RESOURCE_ID, data });
    const invalid = (path: string) => addUpstreamReportEntry(report.excluded, "invalid-setting", path);

    const root = settingsRoot(db);
    migrateRoot(root, invalid);

    const credentials = createCredentialRegistry();
    const customModelBindings = new Map<string, string>();
    const customModels = convertCustomModels(db.customModels, credentials, customModelBindings, report);
    const presets = convertPresets(db.botPresets, root, credentials, customModelBindings, report);

    for (const section of Object.values(SECTION_KIND)) {
        const input = pick(root, SECTION_FIELDS[section]);
        const recovered: Root = {};
        for (const [field, value] of Object.entries(input)) {
            const result = tryNormalize(kinds.get(section)!, { [field]: value });
            if (result.ok) {
                Object.assign(recovered, storedForm({ [field]: value }));
            } else {
                invalid(field);
            }
        }
        if (section === SECTION_KIND.llmSecrets) {
            recovered.credentials = credentials.secrets;
        }
        push(section, normalizeRecord(section, recovered, invalid));
    }

    const personas = convertPersonas(db.personas, root, invalid);
    for (const kind of Object.values(COLLECTION_KIND)) {
        switch (kind) {
            case COLLECTION_KIND.personas:
                push(kind, personas.list);
                break;
            case COLLECTION_KIND.credentials:
                push(kind, normalizeRecord(kind, credentials.entries, invalid));
                break;
            case COLLECTION_KIND.customModels:
                push(kind, customModels);
                break;
            case COLLECTION_KIND.modelPresets:
                push(kind, presets.modelPresets);
                break;
            case COLLECTION_KIND.modelProfiles:
                push(kind, presets.modelProfiles);
                break;
            case COLLECTION_KIND.translatorPresets:
                push(kind, convertTranslatorPresets(root, db.translatorPresets, invalid, report));
                break;
            case COLLECTION_KIND.hypaV3Presets:
                push(kind, convertHypaV3Presets(root, db.hypaV3Presets, invalid, report));
                break;
            default: {
                const field = COLLECTION_FIELDS[kind];
                const value = root[field];
                const input = Array.isArray(value)
                    ? recoverItems(
                          kind,
                          value,
                          value.map((_, index) => `${field}[${index}]`),
                          report,
                      )
                    : value;
                push(kind, normalizeRecord(kind, input, invalid, field));
            }
        }
    }
    push(RESOURCE_KIND.presets, presets.promptPresets);

    reportRootFields(db, report);

    const list = <T>(kind: ResourceKindName) => resources.find((resource) => resource.kind === kind)?.data as T[];
    report.counts.promptPresets = presets.promptPresets.length;
    report.counts.modelPresets = presets.modelPresets.length;
    report.counts.modelProfiles = presets.modelProfiles.length - 1;
    report.counts.credentials = list<Credential>(COLLECTION_KIND.credentials).length;
    report.counts.personas = personas.list.length;
    report.counts.customModels = list<unknown>(COLLECTION_KIND.customModels).length;

    return {
        resources,
        selection: {
            promptPresetId: presets.selectedPromptPresetId,
            modelPresetId: presets.selectedModelPresetId,
            personaId: personas.selectedId,
        },
        report,
    };
}

// ---------------------------------------------------------------------------------------------
// Records and their recovery

/** What the store keeps for `input` written to `kind`: its normalizer on the stored form, checked. */
function storeNormalize(kind: ResourceKind, input: unknown): unknown {
    const data = kind.normalize(input === undefined ? undefined : serialize(input).stored, {
        id: SINGLETON_RESOURCE_ID,
    });
    serialize(data);
    return data;
}

/**
 * `kind`'s record for `input`; failing that, for its JSON copy (a non-finite number becomes `null`,
 * which the normalizers replace with the field default); failing that, the kind's fresh-boot value,
 * reported under `label` (default: the kind name).
 */
function normalizeRecord(
    kindName: ResourceKindName,
    input: unknown,
    invalid: (path: string) => void,
    label: string = kindName,
): unknown {
    const kind = kinds.get(kindName)!;
    const repaired = tryNormalize(kind, input);
    if (repaired.ok) {
        return repaired.data;
    }
    invalid(label);
    return storeNormalize(kind, undefined);
}

function tryNormalize(kind: ResourceKind, input: unknown): { ok: true; data: unknown } | { ok: false } {
    try {
        return { ok: true, data: storeNormalize(kind, input) };
    } catch (error) {
        if (!(error instanceof ResourceValidationError)) {
            throw error;
        }
    }
    let copy: unknown;
    try {
        copy = plainClone(input);
    } catch {
        return { ok: false };
    }
    try {
        return { ok: true, data: storeNormalize(kind, copy) };
    } catch (error) {
        if (!(error instanceof ResourceValidationError)) {
            throw error;
        }
        return { ok: false };
    }
}

/**
 * The entries of a list record that the kind accepts one by one (each tried as a one-entry record,
 * or its JSON copy), in order; each other entry is dropped and reported under its label. `wrap`
 * builds the one-entry record.
 */
function recoverItems(
    kindName: ResourceKindName,
    items: readonly unknown[],
    labels: readonly string[],
    report: UpstreamImportReport,
    wrap: (item: unknown) => unknown = (item) => [item],
    code: "invalid-setting" | "invalid-custom-model" = "invalid-setting",
): unknown[] {
    return recoverIndexed(kindName, items, labels, report, wrap, code).map((entry) => entry.item);
}

function recoverIndexed(
    kindName: ResourceKindName,
    items: readonly unknown[],
    labels: readonly string[],
    report: UpstreamImportReport,
    wrap: (item: unknown) => unknown,
    code: "invalid-setting" | "invalid-custom-model" = "invalid-setting",
): { item: unknown; index: number }[] {
    const kind = kinds.get(kindName)!;
    const kept: { item: unknown; index: number }[] = [];
    items.forEach((item, index) => {
        if (tryNormalize(kind, wrap(item)).ok) {
            kept.push({ item, index });
            return;
        }
        let copy: unknown;
        try {
            copy = plainClone(item);
        } catch {
            copy = undefined;
        }
        if (copy !== undefined && tryNormalize(kind, wrap(copy)).ok) {
            kept.push({ item: copy, index });
            return;
        }
        addUpstreamReportEntry(report.excluded, code, labels[index]);
    });
    return kept;
}

/** The stored (JSON round trip) form of a small source object, a non-finite number becoming `null`. */
function storedForm(value: Record<string, unknown>): Record<string, unknown> {
    try {
        return serialize(value).stored as Record<string, unknown>;
    } catch (error) {
        if (!(error instanceof ResourceValidationError)) {
            throw error;
        }
        return serialize(plainClone(value)).stored as Record<string, unknown>;
    }
}

// ---------------------------------------------------------------------------------------------
// Root

/** A shallow copy of the root's settings fields (own keys, including ones holding `undefined`). */
function settingsRoot(db: Record<string, unknown>): Root {
    const root: Root = {};
    for (const key of Object.keys(db)) {
        if (!nonSettingsFields.has(key) && key !== "__proto__") {
            root[key] = db[key];
        }
    }
    return root;
}

function pick(root: Root, fields: readonly string[]): Record<string, unknown> {
    const picked: Record<string, unknown> = {};
    for (const field of fields) {
        if (Object.hasOwn(root, field)) {
            picked[field] = root[field];
        }
    }
    return picked;
}

/** U `bootstrap.ts` `checkNewFormat`'s path repair of a database saved before `formatversion` 2. */
function checkClean(data: string): string {
    if (data.startsWith("assets") || data.length < 3) {
        return data;
    }
    return "assets/" + data.replace(/\\/g, "/").split("assets/")[1];
}

/**
 * The upstream load migrations whose target fields metatron still has and its normalizers no longer
 * apply, in upstream order. Only top-level root fields are replaced (the root is a shallow copy).
 * `openrouterProvider`'s string form is migrated by `normalizeFields` for the root and every preset.
 */
function migrateRoot(root: Root, invalid: (path: string) => void): void {
    // U `bootstrap.ts` `checkNewFormat`.
    if (!root.formatversion) {
        for (const field of ["customBackground", "userIcon"]) {
            if (typeof root[field] === "string") {
                root[field] = checkClean(root[field]);
            }
        }
    }
    if (
        root.formatversion !== undefined &&
        (typeof root.formatversion !== "number" || !Number.isFinite(root.formatversion))
    ) {
        invalid("formatversion");
    }
    const formatVersion = root.formatversion || 2;
    if (
        typeof formatVersion === "number" &&
        formatVersion < 5 &&
        typeof root.loreBookToken === "number" &&
        root.loreBookToken < 8000
    ) {
        root.loreBookToken = 8000;
    }
    if (root.mainPrompt === oldMainPrompt) {
        root.mainPrompt = defaultMainPrompt;
    }
    if (root.mainPrompt === oldJailbreak) {
        root.mainPrompt = defaultJailbreak;
    }
    // U `storage/database.svelte.ts` `setDatabase`.
    const usesOllamaCloud = root.aiModel === "ollama-cloud" || root.subModel === "ollama-cloud";
    root.ollamaModelSource ??= usesOllamaCloud ? "cloud" : "local";
    if (usesOllamaCloud && !root.ollamaCloudModel) {
        root.ollamaCloudModel = root.ollamaModel ?? "";
        root.ollamaCloudModelName = root.ollamaModelName ?? "";
    }
    if (root.antiClaudeOverload) {
        root.antiServerOverloads = true;
    }
    root.streamingDisplayOptimizationMode ??= root.largeChatPerformanceMode;
}

/** A value an upstream default would hold: nothing the user set (empty containers included). */
function isUnset(value: unknown): boolean {
    if (value === undefined || value === null || value === false || value === "" || value === 0) {
        return true;
    }
    if (Array.isArray(value)) {
        return value.length === 0;
    }
    return isPlainObject(value) && Object.values(value).every(isUnset);
}

/**
 * Reports the root fields that are not imported: the Risu Account and loadouts, fields of removed
 * features that hold a value, and fields in no `shared/sections.ts` list (`unknown-setting`).
 */
function reportRootFields(db: Record<string, unknown>, report: UpstreamImportReport): void {
    for (const field of Object.keys(db)) {
        const value = db[field];
        if (silentFields.has(field)) {
            continue;
        }
        if (field === "account") {
            if (!isUnset(value)) {
                addUpstreamReportEntry(report.excluded, "risu-account");
            }
        } else if (field === "loadouts" || field === "lastLoadedLoadoutName") {
            if (!isUnset(value)) {
                addUpstreamReportEntry(report.excluded, "loadouts", field);
            }
        } else if (removedFields.has(field)) {
            if (!isUnset(value)) {
                addUpstreamReportEntry(report.excluded, "removed-feature", field);
            }
        } else if (!knownFields.has(field) && value !== undefined) {
            addUpstreamReportEntry(report.excluded, "unknown-setting", field);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Credentials and custom models

type CredentialRegistry = {
    readonly entries: Credential[];
    readonly secrets: Record<string, { key: string }>;
    /** The named key holding `key` (one per type and value), and whether this call created it. */
    add(type: Exclude<CredentialType, "vertex">, name: string, key: string): { id: string; created: boolean };
};

function createCredentialRegistry(): CredentialRegistry {
    const entries: Credential[] = [];
    const secrets: Record<string, { key: string }> = {};
    const byValue = new Map<string, string>();
    const names = new Set<string>();
    return {
        entries,
        secrets,
        add(type, name, key) {
            const valueKey = `${type}\u0000${key}`;
            const existing = byValue.get(valueKey);
            if (existing !== undefined) {
                return { id: existing, created: false };
            }
            const id = newId();
            entries.push({ id, name: uniqueName(name, names), type });
            secrets[id] = { key };
            byValue.set(valueKey, id);
            return { id, created: true };
        },
    };
}

function uniqueName(base: string, used: Set<string>): string {
    let name = base;
    for (let suffix = 2; used.has(name); suffix++) {
        name = `${base} ${suffix}`;
    }
    used.add(name);
    return name;
}

function isKey(value: unknown): value is string {
    return typeof value === "string" && value.trim() !== "";
}

/**
 * Custom model definitions without their keys: each key becomes a named key, and the first
 * surviving definition of an `xcustom:::` id (the one upstream's request looks up, U `request.ts`
 * ~474) binds it for the profiles of that model. Rejected definitions' keys remain unbound.
 */
function convertCustomModels(
    value: unknown,
    credentials: CredentialRegistry,
    bindings: Map<string, string>,
    report: UpstreamImportReport,
): unknown[] {
    const entries: unknown[] = [];
    const labels: string[] = [];
    const credentialIds: (string | undefined)[] = [];
    if (value === undefined || value === null) {
        return entries;
    }
    if (!Array.isArray(value)) {
        addUpstreamReportEntry(report.excluded, "invalid-setting", "customModels");
        return entries;
    }
    value.forEach((entry, index) => {
        const name =
            isPlainObject(entry) && typeof entry.name === "string" && entry.name.trim() !== ""
                ? entry.name
                : isPlainObject(entry) && typeof entry.id === "string"
                  ? entry.id
                  : `customModels[${index}]`;
        if (!isPlainObject(entry)) {
            addUpstreamReportEntry(report.excluded, "invalid-custom-model", name);
            return;
        }
        const { key, ...definition } = entry;
        let credentialId: string | undefined;
        if (isKey(key)) {
            const credential = credentials.add("custom", `${name} key`, key);
            credentialId = credential.id;
            addUpstreamReportEntry(report.converted, "custom-model-key-to-credential", name);
        }
        if (typeof entry.id !== "string" || typeof entry.internalId !== "string") {
            addUpstreamReportEntry(report.excluded, "invalid-custom-model", name);
            return;
        }
        entries.push(definition);
        labels.push(name);
        credentialIds.push(credentialId);
    });
    const kept = recoverIndexed(
        COLLECTION_KIND.customModels,
        entries,
        labels,
        report,
        (item) => [item],
        "invalid-custom-model",
    );
    const definitions = storeNormalize(
        kinds.get(COLLECTION_KIND.customModels)!,
        kept.map((entry) => entry.item),
    ) as { id: string }[];
    const seen = new Set<string>();
    definitions.forEach((definition, index) => {
        const credentialId = credentialIds[kept[index].index];
        if (!seen.has(definition.id) && definition.id.startsWith("xcustom:::") && credentialId !== undefined) {
            bindings.set(definition.id, credentialId);
        }
        seen.add(definition.id);
    });
    return definitions;
}

// ---------------------------------------------------------------------------------------------
// Presets (D6)

/**
 * U `setPreset`: the root an upstream tab holds after switching to `preset`, for the fields metatron
 * keeps. A field the preset lacks keeps the root's value or takes upstream's fixed default, as each
 * line does there; fields `setPreset` never touches (`openAIKey`, the NanoGPT and Ollama options,
 * `customTokenizer`) are global and stay the root's. The nested defaults `setPreset` fills in place
 * (`NAIsettings.cfg_scale`, `promptSettings.maxThoughtTagDepth`) are applied by `normalizePreset`.
 */
function applyUpstreamPreset(root: Root, p: Root): Root {
    const r: Root = { ...root };
    r.localNetworkMode = p.localNetworkMode ?? r.localNetworkMode;
    r.localNetworkTimeoutSec = p.localNetworkTimeoutSec ?? r.localNetworkTimeoutSec;
    r.mainPrompt = p.mainPrompt ?? r.mainPrompt;
    r.jailbreak = p.jailbreak ?? r.jailbreak;
    r.globalNote = p.globalNote ?? r.globalNote;
    r.temperature = p.temperature ?? r.temperature;
    r.maxContext = p.maxContext ?? r.maxContext;
    r.maxResponse = p.maxResponse ?? r.maxResponse;
    r.frequencyPenalty = p.frequencyPenalty ?? r.frequencyPenalty;
    r.PresensePenalty = p.PresensePenalty ?? r.PresensePenalty;
    r.formatingOrder = p.formatingOrder ?? r.formatingOrder;
    r.aiModel = p.aiModel ?? r.aiModel;
    r.subModel = p.subModel ?? r.subModel;
    r.currentPluginProvider = p.currentPluginProvider ?? r.currentPluginProvider;
    r.textgenWebUIStreamURL = p.textgenWebUIStreamURL ?? r.textgenWebUIStreamURL;
    r.textgenWebUIBlockingURL = p.textgenWebUIBlockingURL ?? r.textgenWebUIBlockingURL;
    r.forceReplaceUrl = p.forceReplaceUrl ?? r.forceReplaceUrl;
    r.promptPreprocess = p.promptPreprocess ?? r.promptPreprocess;
    r.bias = p.bias ?? r.bias;
    r.koboldURL = p.koboldURL ?? r.koboldURL;
    r.proxyKey = p.proxyKey ?? r.proxyKey;
    r.ooba = p.ooba ?? r.ooba;
    r.ainconfig = p.ainconfig ?? r.ainconfig;
    r.openrouterRequestModel = p.openrouterRequestModel ?? r.openrouterRequestModel;
    r.proxyRequestModel = p.proxyRequestModel ?? r.proxyRequestModel;
    r.NAIsettings = p.NAISettings ?? r.NAIsettings;
    r.autoSuggestPrompt = p.autoSuggestPrompt ?? r.autoSuggestPrompt;
    r.promptTemplate = Array.isArray(p.promptTemplate) ? p.promptTemplate : null;
    r.NAIadventure = p.NAIadventure;
    r.NAIappendName = p.NAIappendName;
    r.localStopStrings = p.localStopStrings;
    r.customProxyRequestModel = p.customProxyRequestModel ?? "";
    r.reverseProxyOobaArgs = p.reverseProxyOobaArgs ?? { mode: "instruct" };
    r.top_p = p.top_p ?? 1;
    r.promptSettings = p.promptSettings ?? {
        assistantPrefill: "",
        postEndInnerFormat: "",
        sendChatAsSystem: false,
        sendName: false,
        utilOverride: false,
    };
    r.repetition_penalty = p.repetition_penalty;
    r.min_p = p.min_p;
    r.top_a = p.top_a;
    r.openrouterProvider = p.openrouterProvider;
    r.useInstructPrompt = p.useInstructPrompt ?? false;
    r.customPromptTemplateToggle = p.customPromptTemplateToggle ?? "";
    r.templateDefaultVariables = p.templateDefaultVariables ?? "";
    r.moduleIntergration = p.moduleIntergration ?? "";
    r.top_k = p.top_k ?? r.top_k;
    r.instructChatTemplate = p.instructChatTemplate ?? r.instructChatTemplate;
    r.JinjaTemplate = p.JinjaTemplate ?? r.JinjaTemplate;
    r.jsonSchemaEnabled = p.jsonSchemaEnabled ?? false;
    r.jsonSchema = p.jsonSchema ?? "";
    r.strictJsonSchema = p.strictJsonSchema ?? true;
    r.extractJson = p.extractJson ?? "";
    r.groupOtherBotRole = p.groupOtherBotRole ?? "user";
    r.groupTemplate = p.groupTemplate ?? "";
    r.seperateParametersEnabled = p.seperateParametersEnabled ?? false;
    r.customAPIFormat = p.customAPIFormat ?? LLMFormat.OpenAICompatible;
    r.systemContentReplacement = p.systemContentReplacement ?? "";
    r.systemRoleReplacement = p.systemRoleReplacement ?? "user";
    r.customFlags = p.customFlags ?? [];
    r.enableCustomFlags = p.enableCustomFlags ?? false;
    r.presetRegex = p.regex ?? [];
    r.reasoningEffort = p.reasonEffort ?? 0;
    r.thinkingTokens = p.thinkingTokens ?? null;
    r.thinkingType = p.thinkingType ?? "budget";
    r.deepseekThinkingType = p.deepseekThinkingType ?? "off";
    r.adaptiveThinkingEffort = p.adaptiveThinkingEffort ?? "high";
    r.deepseekReasoningEffort = p.deepseekReasoningEffort ?? "high";
    r.outputImageModal = p.outputImageModal ?? false;
    if (!r.doNotChangeSeperateModels) {
        r.seperateModelsForAxModels = p.seperateModelsForAxModels ?? false;
        r.seperateModels = p.seperateModels ?? { memory: "", emotion: "", translate: "", otherAx: "" };
    }
    if (!r.disableSeperateParameterChangeOnPresetChange) {
        r.seperateParameters = p.seperateParameters ?? {
            memory: {},
            emotion: {},
            translate: {},
            otherAx: {},
            overrides: {},
        };
    }
    r.modelTools = p.modelTools ?? [];
    r.verbosity = p.verbosity ?? 1;
    r.dynamicOutput = p.dynamicOutput;
    return r;
}

/** U `setDatabase`'s repair of each stored preset's network fields, on a shallow copy. */
function repairUpstreamPreset(preset: Root): Root {
    const p: Root = { ...preset };
    if (typeof p.localNetworkMode !== "boolean") {
        p.localNetworkMode = false;
    }
    if (typeof p.localNetworkTimeoutSec !== "number" || Number.isNaN(p.localNetworkTimeoutSec)) {
        p.localNetworkTimeoutSec = 600;
    }
    return p;
}

/** A context size that takes effect: a finite number above 0. */
function isPositiveSize(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function canonicalJson(value: unknown): string {
    return JSON.stringify(value, (_key, inner: unknown) =>
        isPlainObject(inner)
            ? Object.fromEntries(
                  Object.keys(inner)
                      .sort()
                      .map((key) => [key, inner[key]]),
              )
            : inner,
    );
}

type ConvertedPresets = {
    promptPresets: unknown[];
    modelPresets: unknown[];
    modelProfiles: unknown[];
    selectedPromptPresetId: string;
    selectedModelPresetId: string;
};

/**
 * One prompt preset and one model preset per upstream preset, in order, with model profiles shared
 * across presets by content. The effective settings of a preset are `setPreset`'s result on the
 * root; for the selected preset (`botPresetsId`) the root working copy wins wherever it has the
 * field (an own `undefined` included). A missing or invalid selection appends one more preset from
 * the root and selects it, as upstream's default preset list would hold it.
 */
function convertPresets(
    value: unknown,
    root: Root,
    credentials: CredentialRegistry,
    customModelBindings: ReadonlyMap<string, string>,
    report: UpstreamImportReport,
): ConvertedPresets {
    const invalid = (path: string) => addUpstreamReportEntry(report.excluded, "invalid-setting", path);
    const sources: { preset: Root; index: number }[] = [];
    if (Array.isArray(value)) {
        value.forEach((preset, index) => {
            if (isPlainObject(preset)) {
                sources.push({ preset: repairUpstreamPreset(preset), index });
            } else {
                invalid(`botPresets[${index}]`);
            }
        });
    } else if (value !== undefined && value !== null) {
        invalid("botPresets");
    }
    const requested = root.botPresetsId ?? 0;
    let selected = sources.find((source) => source.index === requested);
    if (!selected) {
        if (root.botPresetsId !== undefined && root.botPresetsId !== null) {
            invalid("botPresetsId");
        }
        selected = { preset: { ...presetTemplate, name: "Default" }, index: -1 };
        sources.push(selected);
    }

    const defaultProfile = normalizeModelProfiles([])[0];
    const profiles: Record<string, unknown>[] = [defaultProfile];
    const profileNames = new Set<string>([defaultProfile.name]);
    const profileByContent = new Map<string, string>();
    const profileFor = (effective: Root, modelId: unknown, credentialId: string | undefined, presetName: string) => {
        const source: Record<string, unknown> = { modelId };
        for (const field of MODEL_PROFILE_ROOT_FIELDS) {
            source[field] = effective[field];
        }
        if (credentialId !== undefined) {
            source.credentialId = credentialId;
        }
        const { id: _id, name: _name, ...content } = normalizeModelProfile(storedForm(source), { id: "" });
        const contentKey = canonicalJson(content);
        const existing = profileByContent.get(contentKey);
        if (existing !== undefined) {
            return existing;
        }
        const base = content.modelId || MODEL_PROFILE_DEFAULT_NAME;
        const id = newId();
        const name = uniqueName(profileNames.has(base) ? `${base} (${presetName})` : base, profileNames);
        const checked = storeNormalize(kinds.get(COLLECTION_KIND.modelProfiles)!, [{ id, name, ...content }]);
        profiles.push((checked as Record<string, unknown>[])[0]);
        profileByContent.set(contentKey, id);
        return id;
    };

    const promptPresets: Record<string, unknown>[] = [];
    const modelPresets: Record<string, unknown>[] = [];
    let selectedPromptPresetId: string | undefined;
    let selectedModelPresetId: string | undefined;
    for (const source of sources) {
        const { preset } = source;
        const applied = applyUpstreamPreset(root, preset);
        const effective = source === selected ? { ...applied, ...root } : applied;
        const label =
            typeof preset.name === "string" && preset.name !== "" ? preset.name : `botPresets[${source.index}]`;
        const proxyKey = effective.proxyKey;
        let proxyCredentialId: string | undefined;
        if (isKey(proxyKey)) {
            const credential = credentials.add("custom", "Reverse proxy key", proxyKey);
            proxyCredentialId = credential.id;
            addUpstreamReportEntry(report.converted, "proxy-key-to-credential", label);
        }
        // Upstream reads only the root `openAIKey` (`setPreset` restores no preset's key since
        // upstream 501167dd), so a different one a preset still carries is kept unbound.
        if (isKey(preset.openAIKey) && preset.openAIKey !== root.openAIKey) {
            credentials.add("openai", `OpenAI key (${label})`, preset.openAIKey);
            addUpstreamReportEntry(report.converted, "preset-openai-key-to-credential", label);
        }
        try {
            const promptSource: Record<string, unknown> = { name: preset.name, image: preset.image };
            for (const field of PROMPT_PRESET_FIELDS) {
                promptSource[field] = effective[promptRootNames[field] ?? field];
            }
            // `importPreset`'s rule (`src/ts/storage/presets.svelte.ts`): the context size seeds an unset
            // override size; only the source's own `maxContextOverride` turns the override on.
            if (!isPositiveSize(promptSource.maxContextOverrideSize) && isPositiveSize(effective.maxContext)) {
                promptSource.maxContextOverrideSize = effective.maxContext;
            }
            const promptPreset = (
                storeNormalize(kinds.get(RESOURCE_KIND.presets)!, [
                    normalizePreset(storedForm(promptSource), { id: newId() }),
                ]) as ReturnType<typeof normalizePreset>[]
            )[0];
            const credentialFor = (modelId: unknown) =>
                modelId === "reverse_proxy"
                    ? proxyCredentialId
                    : typeof modelId === "string"
                      ? customModelBindings.get(modelId)
                      : undefined;
            const slot = (modelId: unknown) => ({
                profileId: profileFor(effective, modelId, credentialFor(modelId), promptPreset.name ?? label),
            });
            const auxSlots: Record<string, unknown> = {};
            const seperateModels = effective.seperateModels;
            if (isPlainObject(seperateModels)) {
                for (const mode of ["memory", "translate", "emotion", "otherAx"]) {
                    const modelId = seperateModels[mode];
                    if (typeof modelId === "string" && modelId !== "") {
                        auxSlots[mode] = slot(modelId);
                    }
                }
            }
            const modelPreset = normalizeModelPreset(
                storedForm({
                    name: promptPreset.name,
                    mainSlot: slot(effective.aiModel),
                    subSlot: slot(effective.subModel),
                    auxSlots,
                    seperateModelsForAxModels: effective.seperateModelsForAxModels,
                }),
                { id: newId() },
            );
            const checked = storeNormalize(kinds.get(COLLECTION_KIND.modelPresets)!, [modelPreset]);
            promptPresets.push(promptPreset as unknown as Record<string, unknown>);
            modelPresets.push((checked as Record<string, unknown>[])[0]);
            if (source === selected) {
                selectedPromptPresetId = promptPreset.id;
                selectedModelPresetId = modelPreset.id;
            }
        } catch (error) {
            if (!(error instanceof ResourceValidationError)) {
                throw error;
            }
            invalid(source.index === -1 ? "botPresets" : `botPresets[${source.index}]`);
        }
    }

    const finish = (kind: ResourceKindName, records: Record<string, unknown>[], label: string) =>
        normalizeRecord(kind, records, invalid, label) as { id: string }[];
    const promptRecords = finish(RESOURCE_KIND.presets, promptPresets, "botPresets");
    let modelRecords = finish(COLLECTION_KIND.modelPresets, modelPresets, "botPresets") as ModelPreset[];
    const profileRecords = finish(COLLECTION_KIND.modelProfiles, profiles, "botPresets");
    const profileIds = new Set(profileRecords.map((profile) => profile.id));
    for (const preset of modelRecords) {
        for (const slot of [preset.mainSlot, preset.subSlot, ...Object.values(preset.auxSlots)]) {
            if ("profileId" in slot && !profileIds.has(slot.profileId)) {
                invalid(`modelPresets[${preset.id}]`);
                slot.profileId = profileRecords[0].id;
            }
        }
    }
    modelRecords = storeNormalize(kinds.get(COLLECTION_KIND.modelPresets)!, modelRecords) as ModelPreset[];
    const selectedOr = (records: { id: string }[], id: string | undefined) =>
        records.some((record) => record.id === id) ? (id as string) : records[0].id;
    return {
        promptPresets: promptRecords,
        modelPresets: modelRecords,
        modelProfiles: profileRecords,
        selectedPromptPresetId: selectedOr(promptRecords, selectedPromptPresetId),
        selectedModelPresetId: selectedOr(modelRecords, selectedModelPresetId),
    };
}

// ---------------------------------------------------------------------------------------------
// Personas and the selectable collections

/**
 * The persona list with the root persona fields (the selected persona's working copy) written into
 * the persona at `selectedPersona`, or into a new persona appended and selected when that index
 * holds none (upstream seeds its first persona from the root the same way).
 */
function convertPersonas(
    value: unknown,
    root: Root,
    invalid: (path: string) => void,
): { list: { id: string }[]; selectedId: string } {
    const sources: { persona: Root; index: number }[] = [];
    if (Array.isArray(value)) {
        value.forEach((persona, index) => {
            if (isPlainObject(persona)) {
                sources.push({ persona: { ...persona }, index });
            } else {
                invalid(`personas[${index}]`);
            }
        });
    } else if (value !== undefined && value !== null) {
        invalid("personas");
    }
    const requested = root.selectedPersona ?? 0;
    let selected = sources.find((source) => source.index === requested);
    if (!selected) {
        if (root.selectedPersona !== undefined && root.selectedPersona !== null) {
            invalid("selectedPersona");
        }
        selected = { persona: {}, index: -1 };
        sources.push(selected);
    }
    for (const [rootField, field] of Object.entries(PERSONA_ROOT_ALIASES)) {
        if (typeof root[rootField] === "string") {
            selected.persona[field] = root[rootField];
        }
    }
    const kind = kinds.get(COLLECTION_KIND.personas)!;
    const kept: Root[] = [];
    let selectedPosition = -1;
    for (const source of sources) {
        let persona: unknown = source.persona;
        if (!tryNormalize(kind, [persona]).ok) {
            try {
                persona = plainClone(persona);
            } catch {
                persona = undefined;
            }
            if (persona === undefined || !tryNormalize(kind, [persona]).ok) {
                invalid(source.index === -1 ? "personas" : `personas[${source.index}]`);
                continue;
            }
        }
        if (source === selected) {
            selectedPosition = kept.length;
        }
        kept.push(persona as Root);
    }
    const list = normalizeRecord(COLLECTION_KIND.personas, kept, invalid, "personas") as { id: string }[];
    return { list, selectedId: (list[selectedPosition] ?? list[0]).id };
}

type SelectableRecord = { items: { id: string }[]; selectedId: string };

/**
 * A `{ items, selectedId }` record from an upstream list and its numeric selection index: the
 * entries the kind accepts, with `selectedId` the id the selected entry got (the first item when
 * that entry is gone).
 */
function convertSelectable(
    kindName: ResourceKindName,
    field: string,
    items: readonly unknown[],
    selectedIndex: number,
    invalid: (path: string) => void,
    report: UpstreamImportReport,
): SelectableRecord {
    const kept = recoverIndexed(
        kindName,
        items,
        items.map((_, index) => `${field}[${index}]`),
        report,
        (item) => ({ items: [item] }),
    );
    const first = normalizeRecord(
        kindName,
        { items: kept.map((entry) => entry.item) },
        invalid,
        field,
    ) as SelectableRecord;
    const position = kept.findIndex((entry) => entry.index === selectedIndex);
    const selectedId = first.items[position]?.id ?? first.items[0].id;
    return normalizeRecord(kindName, { items: first.items, selectedId }, invalid, field) as SelectableRecord;
}

/**
 * U `translator/presets.ts` `normalizeTranslatorPresetState`: an empty or missing list becomes one
 * "Default" preset from the legacy root prompt; the index defaults to 0 when not an integer, then is
 * clamped to the list.
 */
function convertTranslatorPresets(
    root: Root,
    value: unknown,
    invalid: (path: string) => void,
    report: UpstreamImportReport,
): SelectableRecord {
    if (value !== undefined && value !== null && !Array.isArray(value)) {
        invalid("translatorPresets");
    }
    const items =
        Array.isArray(value) && value.length > 0
            ? value
            : [
                  {
                      name: "Default",
                      prompt: root.translatorPrompt ?? "",
                      maxResponse: root.translatorMaxResponse ?? 1000,
                  },
              ];
    const requested = Number.isInteger(root.translatorPresetId) ? (root.translatorPresetId as number) : 0;
    const index = Math.min(Math.max(requested, 0), items.length - 1);
    return convertSelectable(COLLECTION_KIND.translatorPresets, "translatorPresets", items, index, invalid, report);
}

/**
 * U `setDatabase`: a missing HypaV3 list becomes one "Default" preset from the legacy settings and
 * the SupaMemory prompt. Upstream's direct lookup throws for an index naming no preset; this
 * converter selects the first one and reports the repair.
 */
function convertHypaV3Presets(
    root: Root,
    value: unknown,
    invalid: (path: string) => void,
    report: UpstreamImportReport,
): SelectableRecord {
    let items: readonly unknown[];
    if (Array.isArray(value)) {
        items = value;
    } else {
        if (value !== undefined && value !== null) {
            invalid("hypaV3Presets");
        }
        items = [
            {
                name: "Default",
                settings: {
                    summarizationPrompt: root.supaMemoryPrompt ? root.supaMemoryPrompt : "",
                    ...(isPlainObject(root.hypaV3Settings) ? root.hypaV3Settings : {}),
                },
            },
        ];
    }
    const requested = root.hypaV3PresetId ?? 0;
    const valid =
        typeof requested === "number" && Number.isInteger(requested) && requested >= 0 && requested < items.length;
    if (!valid && items.length > 0) {
        invalid("hypaV3PresetId");
    }
    return convertSelectable(
        COLLECTION_KIND.hypaV3Presets,
        "hypaV3Presets",
        items,
        valid ? requested : 0,
        invalid,
        report,
    );
}
