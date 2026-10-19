import type { AINsettings, botPreset, ModelPreset, ModelProfile, ModelSlot, OobaSettings } from "./database.ts";
import { isRecordId, newId } from "./ids.ts";
import { LLMFormat } from "./llm.ts";
import {
    defaultAutoSuggestPrompt,
    defaultJailbreak,
    defaultMainPrompt,
    prebuiltNAIpresets,
} from "./presetTemplates.ts";
import type { PromptItem } from "./prompt.ts";
import { isPlainObject, type ValueKind, valueKindOf } from "./valueKinds.ts";

/**
 * The canonical schema for prompt presets, model presets, and model profiles
 * (`docs/plan/model-profiles.md`), used by the client (importers, the views) and server normalizers.
 *
 * `PRESET_DEFAULTS` is the one table of every schema field, keyed by its record name, with its
 * fresh-boot default. The profile fields retain the former preset and provider defaults.
 * Each field has one owner: the model preset (`MODEL_PRESET_FIELDS`, the `modelPresets` collection)
 * or profile (`MODEL_PROFILE_FIELDS`), or the prompt preset (`PROMPT_PRESET_FIELDS`, the `presets`
 * record); `name` is every record's own (`PRESET_RECORD_FIELDS`), and `image` the prompt preset's.
 * `archived` (`PROMPT_PRESET_LOCAL_FIELDS`) is the prompt preset's list metadata, not a prompt field.
 * The defaults, kinds, and null rules are shared, so `presetFieldValue` serves every record.
 * The values originated from the `setDatabase` root defaults, not `presetTemplate` (they differ
 * for `maxResponse` and the two textgen URLs).
 * `undefined` means the field has no default and stays absent. Not preset fields: `openAIKey` (one
 * global secret), `proxyKey` (removed), `forceReplaceUrl2` (no reader), `autoSuggestPrefix` and
 * `autoSuggestClean` (`ui` fields).
 */

export const defaultAIN: AINsettings = {
    top_p: 0.7,
    rep_pen: 1.0625,
    top_a: 0.08,
    rep_pen_slope: 1.7,
    rep_pen_range: 1024,
    typical_p: 1.0,
    badwords: "",
    stoptokens: "",
    top_k: 140,
};

export const defaultOoba: OobaSettings = {
    max_new_tokens: 180,
    do_sample: true,
    temperature: 0.7,
    top_p: 0.9,
    typical_p: 1,
    repetition_penalty: 1.15,
    encoder_repetition_penalty: 1,
    top_k: 20,
    min_length: 0,
    no_repeat_ngram_size: 0,
    num_beams: 1,
    penalty_alpha: 0,
    length_penalty: 1,
    early_stopping: false,
    seed: -1,
    add_bos_token: true,
    truncation_length: 4096,
    ban_eos_token: false,
    skip_special_tokens: true,
    top_a: 0,
    tfs: 1,
    epsilon_cutoff: 0,
    eta_cutoff: 0,
    formating: {
        header: "Below is an instruction that describes a task. Write a response that appropriately completes the request.",
        systemPrefix: "### Instruction:",
        userPrefix: "### Input:",
        assistantPrefix: "### Response:",
        seperator: "",
        useName: false,
    },
};

const defaultFormatingOrder: botPreset["formatingOrder"] = [
    "main",
    "description",
    "personaPrompt",
    "chats",
    "lastChat",
    "jailbreak",
    "lorebook",
    "globalNote",
    "authorNote",
];

/** A plain deep copy of JSON data. Never `structuredClone`: callers may hold Svelte proxies. */
export function plainClone<T>(value: T): T {
    return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

type PresetSchema = Omit<botPreset, PresetOnlyExcluded> &
    Omit<ModelPreset, "id" | "name"> &
    Omit<ModelProfile, "id" | "name">;
type PresetDefaults = { [K in keyof Required<PresetSchema>]: PresetSchema[K] | null | undefined };
/**
 * Legacy import-only fields: credentials, the removed `apiType` and proxy binding, the model ids
 * now derived from slots, and fields that were never saved per preset. They have no schema default.
 */
type PresetOnlyExcluded =
    | "id"
    | "openAIKey"
    | "proxyKey"
    | "proxyCredentialId"
    | "apiType"
    | "aiModel"
    | "subModel"
    | "seperateModels"
    | "forceReplaceUrl2"
    | "autoSuggestPrefix"
    | "autoSuggestClean";

/** The materialized default profile; a default model preset names it in both required slots. */
export const DEFAULT_MODEL_PROFILE_ID = "default";

export const PRESET_DEFAULTS: Readonly<PresetDefaults> = {
    name: "New Preset",
    localNetworkMode: false,
    localNetworkTimeoutSec: 600,
    mainPrompt: defaultMainPrompt,
    jailbreak: defaultJailbreak,
    globalNote: "",
    temperature: 80,
    maxContext: 4000,
    maxResponse: 500,
    maxContextOverride: false,
    maxContextOverrideSize: 0,
    frequencyPenalty: 70,
    PresensePenalty: 70,
    formatingOrder: defaultFormatingOrder,
    modelId: "gemini-3-flash-preview",
    currentPluginProvider: "",
    textgenWebUIStreamURL: "wss://localhost/api/",
    textgenWebUIBlockingURL: "https://localhost/api/",
    forceReplaceUrl: "",
    promptPreprocess: undefined,
    bias: [],
    koboldURL: undefined,
    ooba: defaultOoba,
    ainconfig: defaultAIN,
    openrouterRequestModel: "openai/gpt-3.5-turbo",
    proxyRequestModel: undefined,
    credentialId: undefined,
    NAISettings: { ...prebuiltNAIpresets, cfg_scale: 1, mirostat_tau: 0, mirostat_lr: 1 },
    autoSuggestPrompt: defaultAutoSuggestPrompt,
    promptTemplate: undefined,
    NAIadventure: false,
    NAIappendName: true,
    localStopStrings: undefined,
    customProxyRequestModel: "",
    reverseProxyOobaArgs: { mode: "instruct" },
    top_p: 1,
    promptSettings: {
        assistantPrefill: "",
        postEndInnerFormat: "",
        sendChatAsSystem: false,
        sendName: false,
        utilOverride: false,
        customChainOfThought: false,
        maxThoughtTagDepth: -1,
    },
    repetition_penalty: 1,
    min_p: 0,
    top_a: 0,
    openrouterProvider: { order: [], only: [], ignore: [] },
    useInstructPrompt: false,
    customPromptTemplateToggle: "",
    templateDefaultVariables: "",
    moduleIntergration: "",
    top_k: 0,
    instructChatTemplate: "chatml",
    JinjaTemplate: "",
    jsonSchemaEnabled: false,
    jsonSchema: "",
    strictJsonSchema: true,
    extractJson: "",
    groupOtherBotRole: "user",
    groupTemplate: "",
    seperateParametersEnabled: false,
    seperateParameters: { memory: {}, emotion: {}, translate: {}, otherAx: {}, overrides: {} },
    customAPIFormat: LLMFormat.OpenAICompatible,
    systemContentReplacement: "system: {{slot}}",
    systemRoleReplacement: "user",
    enableCustomFlags: false,
    customFlags: [],
    image: "",
    archived: undefined,
    regex: [],
    reasonEffort: 0,
    thinkingTokens: null,
    thinkingType: "budget",
    deepseekThinkingType: "off",
    adaptiveThinkingEffort: "high",
    deepseekReasoningEffort: "high",
    outputImageModal: false,
    seperateModelsForAxModels: false,
    mainSlot: { profileId: DEFAULT_MODEL_PROFILE_ID },
    subSlot: { profileId: DEFAULT_MODEL_PROFILE_ID },
    auxSlots: {},
    modelTools: [],
    nanogptRequestModel: "",
    nanogptRequestModelName: "",
    nanogptProvider: "",
    ollamaURL: "",
    ollamaModel: "",
    ollamaModelName: "",
    ollamaModelSource: "local",
    ollamaInputMode: "manual",
    ollamaRequestFormat: LLMFormat.Ollama,
    ollamaCloudModel: "",
    ollamaCloudModelName: "",
    customTokenizer: "tik",
    verbosity: 1,
    dynamicOutput: null,
};

export type PresetField = keyof PresetDefaults;

/** Every schema field (all three owners), by its record name. */
export const PRESET_FIELDS = Object.keys(PRESET_DEFAULTS) as readonly PresetField[];

/**
 * The model preset's slot choices. Each slot container is one object-kind schema field, with
 * tag validation in `normalizeFields`; defaults and kinds stay in this table, without flattening
 * the four auxiliary modes into additional fields.
 */
export const MODEL_PRESET_FIELDS = [
    "mainSlot",
    "subSlot",
    "auxSlots",
    "seperateModelsForAxModels",
] as const satisfies readonly PresetField[];

export type ModelPresetField = (typeof MODEL_PRESET_FIELDS)[number];

/** The profile's definition, key binding, connection, routing, compatibility, and capacity. */
export const MODEL_PROFILE_FIELDS = [
    "modelId",
    "credentialId",
    "currentPluginProvider",
    "forceReplaceUrl",
    "customProxyRequestModel",
    "proxyRequestModel",
    "customAPIFormat",
    "textgenWebUIStreamURL",
    "textgenWebUIBlockingURL",
    "koboldURL",
    "localNetworkMode",
    "localNetworkTimeoutSec",
    "openrouterRequestModel",
    "openrouterProvider",
    "useInstructPrompt",
    "enableCustomFlags",
    "customFlags",
    "systemContentReplacement",
    "systemRoleReplacement",
    "instructChatTemplate",
    "JinjaTemplate",
    "outputImageModal",
    "modelTools",
    "maxContext",
    "nanogptRequestModel",
    "nanogptRequestModelName",
    "nanogptProvider",
    "ollamaURL",
    "ollamaModel",
    "ollamaModelName",
    "ollamaModelSource",
    "ollamaInputMode",
    "ollamaRequestFormat",
    "ollamaCloudModel",
    "ollamaCloudModelName",
    "customTokenizer",
] as const satisfies readonly PresetField[];

export type ModelProfileField = (typeof MODEL_PROFILE_FIELDS)[number];

/** The fields records hold for themselves (`image` is only on the prompt preset). */
export const PRESET_RECORD_FIELDS = ["name", "image"] as const satisfies readonly PresetField[];

/**
 * The prompt preset's list metadata: `archived` hides it from the preset list's default view. A
 * stored record keeps it (`normalizePreset`), but it is no prompt field: the root views and
 * `activePreset` do not serve it, and `downloadPreset` does not export it.
 */
export const PROMPT_PRESET_LOCAL_FIELDS = ["archived"] as const satisfies readonly PresetField[];

/** The fields the prompt preset owns: every other schema field (the prompt, sampling, reasoning). */
export type PromptPresetField = Exclude<
    PresetField,
    | ModelPresetField
    | ModelProfileField
    | (typeof PRESET_RECORD_FIELDS)[number]
    | (typeof PROMPT_PRESET_LOCAL_FIELDS)[number]
>;

const modelFieldSet = new Set<string>(MODEL_PRESET_FIELDS);
const profileFieldSet = new Set<string>(MODEL_PROFILE_FIELDS);
const recordFieldSet = new Set<string>(PRESET_RECORD_FIELDS);
const localFieldSet = new Set<string>(PROMPT_PRESET_LOCAL_FIELDS);

function isPromptPresetField(field: PresetField): field is PromptPresetField {
    return (
        !modelFieldSet.has(field) &&
        !profileFieldSet.has(field) &&
        !recordFieldSet.has(field) &&
        !localFieldSet.has(field)
    );
}

/** The prompt preset's fields, in `PRESET_DEFAULTS` order. */
export const PROMPT_PRESET_FIELDS: readonly PromptPresetField[] = PRESET_FIELDS.filter(isPromptPresetField);

/**
 * Which record owns a preset-schema field (`undefined` for `name`/`image`, which each record has;
 * `"prompt"` for the prompt preset's list metadata, `archived`).
 */
export function presetFieldOwner(field: PresetField): "model" | "profile" | "prompt" | undefined {
    return modelFieldSet.has(field)
        ? "model"
        : profileFieldSet.has(field)
          ? "profile"
          : recordFieldSet.has(field)
            ? undefined
            : "prompt";
}

/** Kinds of the fields whose default does not show one (no default, or a `null` default). */
const kindsWithoutDefault: Partial<Record<PresetField, ValueKind>> = {
    promptPreprocess: "boolean",
    archived: "boolean",
    koboldURL: "string",
    proxyRequestModel: "string",
    credentialId: "string",
    promptTemplate: "array",
    localStopStrings: "array",
    thinkingTokens: "number",
    dynamicOutput: "object",
};

/** The JSON kind each preset field's value must have: the declared one, else its default's. */
export const PRESET_FIELD_KINDS: Readonly<Record<PresetField, ValueKind>> = Object.fromEntries(
    PRESET_FIELDS.map((field) => {
        const kind = kindsWithoutDefault[field] ?? valueKindOf(PRESET_DEFAULTS[field]);
        if (kind === null) {
            throw new Error(`Preset field ${field} has no kind`);
        }
        return [field, kind];
    }),
) as Record<PresetField, ValueKind>;

/** Root field names that differ from the preset field they mirror (root → preset). */
export const PRESET_ROOT_ALIASES = {
    NAIsettings: "NAISettings",
    reasoningEffort: "reasonEffort",
    presetRegex: "regex",
} as const;

/** Root persona field names and the `RisuPersona` field each mirrors (root → persona). */
export const PERSONA_ROOT_ALIASES = {
    username: "name",
    userIcon: "icon",
    userNote: "note",
    personaPrompt: "personaPrompt",
} as const;

/**
 * Preset fields whose explicit `null` is a value the readers handle (`promptTemplate` null means no
 * template, `thinkingTokens` null no budget): `setPreset` copied it to the root as it was before
 * Phase 3. `normalizePreset` keeps it, and the forwarding layer serves it.
 */
export const PRESET_NULLABLE_FIELDS = [
    "promptTemplate",
    "NAIadventure",
    "NAIappendName",
    "localStopStrings",
    "repetition_penalty",
    "min_p",
    "top_a",
    "openrouterProvider",
    "thinkingTokens",
    "dynamicOutput",
] as const satisfies readonly PresetField[];

/**
 * The base `importPreset` spreads under an imported file, unchanged from before Phase 3 so old
 * files import as they did. It is not the default of a new preset (that is `normalizePreset`).
 */
export const presetTemplate: Omit<botPreset, "id"> = {
    name: "New Preset",
    apiType: "gemini-3-flash-preview",
    openAIKey: "",
    localNetworkMode: false,
    localNetworkTimeoutSec: 600,
    mainPrompt: defaultMainPrompt,
    jailbreak: defaultJailbreak,
    globalNote: "",
    temperature: 80,
    maxContext: 4000,
    maxResponse: 300,
    frequencyPenalty: 70,
    PresensePenalty: 70,
    formatingOrder: defaultFormatingOrder,
    aiModel: "gemini-3-flash-preview",
    subModel: "gemini-3-flash-preview",
    currentPluginProvider: "",
    textgenWebUIStreamURL: "",
    textgenWebUIBlockingURL: "",
    forceReplaceUrl: "",
    forceReplaceUrl2: "",
    promptPreprocess: false,
    proxyKey: "",
    bias: [],
    ooba: defaultOoba,
    ainconfig: defaultAIN,
    reverseProxyOobaArgs: {
        mode: "instruct",
    },
    top_p: 1,
    useInstructPrompt: false,
    verbosity: 1,
};

/** A new preset id. */
export const newPresetId = newId;

/** A new persona id. */
export const newPersonaId = newId;

function normalizePromptRole(role: unknown): "user" | "bot" | "system" | null {
    if (role === "user" || role === "bot" || role === "system") {
        return role;
    }
    if (role === "assistant" || role === "char") {
        return "bot";
    }
    return null;
}

function normalizeCacheRole(role: unknown): "user" | "assistant" | "system" | "all" {
    if (role === "user" || role === "assistant" || role === "system" || role === "all") {
        return role;
    }
    if (role === "bot" || role === "char") {
        return "assistant";
    }
    return "all";
}

/** A copy of `template` with its prompt roles normalized, or `null` when it is not an array. */
export function normalizePromptTemplate(template: PromptItem[] | null | undefined): PromptItem[] | null {
    if (!Array.isArray(template)) {
        return null;
    }
    const normalized = plainClone(template) as any[];
    for (const item of normalized) {
        if (!item || typeof item !== "object") {
            continue;
        }
        switch (item.type) {
            case "plain":
            case "jailbreak":
            case "cot": {
                item.role = normalizePromptRole(item.role) ?? "system";
                break;
            }
            case "persona":
            case "description":
            case "authornote":
            case "memory": {
                if (item.role2 !== undefined && item.role2 !== null) {
                    item.role2 = normalizePromptRole(item.role2) ?? "system";
                }
                break;
            }
            case "cache": {
                item.role = normalizeCacheRole(item.role);
                break;
            }
        }
    }
    return normalized as PromptItem[];
}

const nullableFields = new Set<string>(PRESET_NULLABLE_FIELDS);

/** The provider object that replaced the old single-provider string; runs before the kind check. */
function migrateOpenrouterProvider(value: unknown): unknown {
    return typeof value === "string" ? { order: value ? [value] : [], only: [], ignore: [] } : value;
}

/**
 * The `setDatabase` migration of a preset container, in place, on whichever record holds it:
 * `seperateParameters` (prompt) gets its `overrides` map.
 */
function migratePresetContainers(record: Record<string, unknown>): void {
    if (isPlainObject(record.seperateParameters)) {
        record.seperateParameters.overrides ??= {};
    }
}

/** A single non-empty, explicit tag; mixed tags and extra keys cannot change a slot's meaning. */
function normalizeModelSlot(value: unknown): ModelSlot | undefined {
    if (!isPlainObject(value) || Object.keys(value).length !== 1) {
        return undefined;
    }
    if (Object.hasOwn(value, "profileId") && isRecordId(value.profileId)) {
        return { profileId: value.profileId };
    }
    if (Object.hasOwn(value, "modelId") && isRecordId(value.modelId)) {
        return { modelId: value.modelId };
    }
    return undefined;
}

/** Only the four auxiliary modes are stored; an invalid or missing entry uses the sub slot. */
function normalizeAuxSlots(value: unknown): ModelPreset["auxSlots"] {
    const slots: ModelPreset["auxSlots"] = {};
    if (isPlainObject(value)) {
        for (const mode of ["memory", "translate", "emotion", "otherAx"] as const) {
            const slot = Object.hasOwn(value, mode) ? normalizeModelSlot(value[mode]) : undefined;
            if (slot) {
                slots[mode] = slot;
            }
        }
    }
    return slots;
}

/**
 * A normalized copy of `source`'s `fields`: each missing one (absent or `undefined`) or one of the
 * wrong JSON kind (`PRESET_FIELD_KINDS`; a number where an object belongs) filled with its default,
 * and the migrations `setDatabase` and `setPreset` applied to the root working copy before Phase 3,
 * each only where the record owns its field. An explicit `null` is kept only where it is a value
 * (`PRESET_NULLABLE_FIELDS`: `setPreset` passed it through as it was, such as `min_p`); any other
 * `null` gets the default, as `setPreset` gave the root copy (a number field cleared in the UI comes
 * back as its default after a reload). Fields outside `fields` are dropped. Nested values are not
 * checked beyond those migrations.
 */
function normalizeFields(source: Record<string, unknown>, fields: readonly PresetField[], id: string) {
    const record: Record<string, unknown> = { id };
    for (const field of fields) {
        if (field === "mainSlot" || field === "subSlot") {
            const slot = normalizeModelSlot(source[field]);
            record[field] = slot && "profileId" in slot ? slot : plainClone(PRESET_DEFAULTS[field]);
            continue;
        }
        if (field === "auxSlots") {
            record[field] = normalizeAuxSlots(source[field]);
            continue;
        }
        const value = field === "openrouterProvider" ? migrateOpenrouterProvider(source[field]) : source[field];
        if (
            (value === null && nullableFields.has(field)) ||
            (value != null && valueKindOf(value) === PRESET_FIELD_KINDS[field])
        ) {
            record[field] = plainClone(value);
            continue;
        }
        const fallback = PRESET_DEFAULTS[field];
        if (fallback !== undefined) {
            record[field] = plainClone(fallback);
        }
    }
    const owns = (field: PresetField) => fields.includes(field);
    if (owns("NAISettings") && isPlainObject(record.NAISettings)) {
        const nai = record.NAISettings;
        nai.starter ??= "";
        nai.cfg_scale ??= 1;
        nai.mirostat_tau ??= 0;
        nai.mirostat_lr ??= 1;
    }
    if (owns("promptSettings") && isPlainObject(record.promptSettings)) {
        record.promptSettings.maxThoughtTagDepth ??= -1;
    }
    if (
        owns("formatingOrder") &&
        Array.isArray(record.formatingOrder) &&
        !record.formatingOrder.includes("personaPrompt")
    ) {
        const main = record.formatingOrder.indexOf("main");
        record.formatingOrder.splice(main === -1 ? 0 : main, 0, "personaPrompt");
    }
    if (owns("top_p") && typeof record.top_p !== "number") {
        record.top_p = 1;
    }
    if (owns("localNetworkMode") && typeof record.localNetworkMode !== "boolean") {
        record.localNetworkMode = false;
    }
    if (
        owns("localNetworkTimeoutSec") &&
        (typeof record.localNetworkTimeoutSec !== "number" || Number.isNaN(record.localNetworkTimeoutSec))
    ) {
        record.localNetworkTimeoutSec = 600;
    }
    migratePresetContainers(record);
    if (owns("promptTemplate") && record.promptTemplate !== undefined && record.promptTemplate !== null) {
        record.promptTemplate = normalizePromptTemplate(record.promptTemplate as PromptItem[]);
    }
    return record;
}

const promptRecordFields: readonly PresetField[] = [
    ...PRESET_RECORD_FIELDS,
    ...PROMPT_PRESET_LOCAL_FIELDS,
    ...PROMPT_PRESET_FIELDS,
];
const modelRecordFields: readonly PresetField[] = ["name", ...MODEL_PRESET_FIELDS];
const profileRecordFields: readonly PresetField[] = ["name", ...MODEL_PROFILE_FIELDS];

/** A new model preset's name (the shared `name` default is the prompt preset's). */
export const MODEL_PRESET_DEFAULT_NAME = "New Model Preset";

/** A new model profile's name (shown as a connection; the shared `name` default is the prompt preset's). */
export const MODEL_PROFILE_DEFAULT_NAME = "New Connection";

/**
 * A normalized copy of a prompt preset (`normalizeFields` over `name`, `image`, `archived`, and
 * `PROMPT_PRESET_FIELDS`): the model fields an old file or record carries are dropped. The server
 * `presets` normalizer runs this, so a stored preset always has the containers the client reads
 * through (`NAISettings.cfg_scale`, `ooba.formating`). The input is never mutated and must be plain
 * data (pass `plainClone` of a proxy: `$state.snapshot` drops an own `__proto__` key). The id is
 * `options.id` when given (a copy or an import passes a fresh one), else the input's valid id, else
 * a new one.
 */
export function normalizePreset(input: unknown, options: { id?: string } = {}): botPreset {
    const source = isPlainObject(input) ? input : {};
    const id = options.id ?? (isRecordId(source.id) ? source.id : newPresetId());
    return normalizeFields(source, promptRecordFields, id) as unknown as botPreset;
}

/**
 * The normalized preset collection: every element normalized, a duplicate id re-keyed, and a
 * non-array or empty input replaced by one default preset (so a selection always has a record).
 */
export function normalizePresets(input: unknown): botPreset[] {
    return normalizeList(input, normalizePreset, { name: "New Preset" });
}

/**
 * A normalized copy of a model preset (`normalizeFields` over `name` and `MODEL_PRESET_FIELDS`;
 * `name` defaults to `MODEL_PRESET_DEFAULT_NAME`): every other field is dropped, with no migration
 * of old model ids, connection options, or credentials. Main and sub require a profile tag;
 * auxiliary slots allow either tag. Same input and id rules as `normalizePreset`.
 */
export function normalizeModelPreset(input: unknown, options: { id?: string } = {}): ModelPreset {
    const source = isPlainObject(input) ? input : {};
    const id = options.id ?? (isRecordId(source.id) ? source.id : newPresetId());
    const record = normalizeFields(source, modelRecordFields, id);
    if (typeof source.name !== "string") {
        record.name = MODEL_PRESET_DEFAULT_NAME;
    }
    return record as unknown as ModelPreset;
}

/** The normalized model preset collection, with the same rules as `normalizePresets`. */
export function normalizeModelPresets(input: unknown): ModelPreset[] {
    return normalizeList(input, normalizeModelPreset, {});
}

/**
 * A normalized model profile with the schema's field defaults and an optional string key binding.
 * Neither the model definition nor the credential's existence is checked here: dangling bindings
 * refuse when used. Same input and id rules as `normalizePreset`; no secret is stored.
 */
export function normalizeModelProfile(input: unknown, options: { id?: string } = {}): ModelProfile {
    const source = isPlainObject(input) ? input : {};
    const id = options.id ?? (isRecordId(source.id) ? source.id : newPresetId());
    const record = normalizeFields(source, profileRecordFields, id);
    if (typeof source.name !== "string") {
        record.name = MODEL_PROFILE_DEFAULT_NAME;
    }
    return record as unknown as ModelProfile;
}

/** Unique profile ids, with one materialized default profile for a non-array or empty list. */
export function normalizeModelProfiles(input: unknown): ModelProfile[] {
    return normalizeList(input, normalizeModelProfile, { id: DEFAULT_MODEL_PROFILE_ID });
}

function normalizeList<T extends { id: string }>(input: unknown, normalize: (entry: unknown) => T, empty: object): T[] {
    const source = Array.isArray(input) ? input : [];
    const seen = new Set<string>();
    const list = source.map((entry) => {
        const record = normalize(entry);
        if (seen.has(record.id)) {
            record.id = newPresetId();
        }
        seen.add(record.id);
        return record;
    });
    return list.length > 0 ? list : [normalize(empty)];
}

const nullablePresetFields = new Set<string>(PRESET_NULLABLE_FIELDS);

/**
 * A preset field as the client's views serve it (`src/ts/storage/settingsViews.svelte.ts`) and the
 * server request layer reads it (`server/src/llm/settings.ts`): a missing record or value reads as
 * a fresh copy of its `PRESET_DEFAULTS` value, a `null` in an object or array field outside
 * `PRESET_NULLABLE_FIELDS` as a fresh default, any other value as it is. Never writes.
 */
export function presetFieldValue(record: Record<string, unknown> | undefined, field: PresetField): unknown {
    const fallback = PRESET_DEFAULTS[field];
    if (record === undefined) {
        return plainClone(fallback);
    }
    const value = record[field];
    if (value === undefined) {
        return plainClone(fallback);
    }
    const container = PRESET_FIELD_KINDS[field] === "object" || PRESET_FIELD_KINDS[field] === "array";
    if (value === null && container && !nullablePresetFields.has(field)) {
        return plainClone(fallback);
    }
    return value;
}
