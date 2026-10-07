import type { AINsettings, botPreset, OobaSettings } from "./database.ts";
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
 * The canonical bot preset schema (Phase 3, Decision 3 of `docs/plan/PLAN.md`), used by the client
 * (importers, the forwarding layer from slice 5) and the server `presets` normalizer (slice 3).
 *
 * `PRESET_DEFAULTS` lists every field a preset owns, keyed by its preset name, with the value a
 * fresh boot shows for it: the `setDatabase` root default as captured in
 * `src/ts/storage/tests/fixtures/phase3/boot-snapshot.json`, not `presetTemplate`'s value (they
 * differ for `maxResponse` and the two textgen URLs). A field a fresh boot leaves unset takes the
 * fallback `setPreset` (or else `saveCurrentPreset`) applies; `undefined` means neither has one and
 * the field stays absent. `name` and `image` are preset-only. Not preset fields: `openAIKey` (one
 * global secret), `forceReplaceUrl2` (no reader), `autoSuggestPrefix` and `autoSuggestClean`
 * (`saveCurrentPreset` never wrote them, so they were global; they are `ui` fields).
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

type PresetDefaults = { [K in Exclude<keyof botPreset, PresetOnlyExcluded>]-?: botPreset[K] | null | undefined };
/**
 * Not preset fields: the id, the two LLM credentials (`openAIKey` is a global `llmSecrets` field;
 * `proxyKey` lives in `llmSecrets.presets` by preset id), and fields that were never saved per preset.
 */
type PresetOnlyExcluded =
    "id" | "openAIKey" | "proxyKey" | "forceReplaceUrl2" | "autoSuggestPrefix" | "autoSuggestClean";

export const PRESET_DEFAULTS: Readonly<PresetDefaults> = {
    name: "New Preset",
    apiType: "gemini-3-flash-preview",
    localNetworkMode: false,
    localNetworkTimeoutSec: 600,
    mainPrompt: defaultMainPrompt,
    jailbreak: defaultJailbreak,
    globalNote: "",
    temperature: 80,
    maxContext: 4000,
    maxResponse: 500,
    frequencyPenalty: 70,
    PresensePenalty: 70,
    formatingOrder: defaultFormatingOrder,
    aiModel: "gemini-3-flash-preview",
    subModel: "gemini-3-flash-preview",
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
    regex: [],
    reasonEffort: 0,
    thinkingTokens: null,
    thinkingType: "budget",
    deepseekThinkingType: "off",
    adaptiveThinkingEffort: "high",
    deepseekReasoningEffort: "high",
    outputImageModal: false,
    seperateModelsForAxModels: false,
    seperateModels: { memory: "", emotion: "", translate: "", otherAx: "" },
    modelTools: [],
    fallbackModels: { model: [], memory: [], emotion: [], translate: [], otherAx: [] },
    fallbackWhenBlankResponse: false,
    verbosity: 1,
    dynamicOutput: null,
};

export type PresetField = keyof PresetDefaults;

/** Every field a preset owns, by its preset name. */
export const PRESET_FIELDS = Object.keys(PRESET_DEFAULTS) as readonly PresetField[];

/** Kinds of the fields whose default does not show one (no default, or a `null` default). */
const kindsWithoutDefault: Partial<Record<PresetField, ValueKind>> = {
    promptPreprocess: "boolean",
    koboldURL: "string",
    proxyRequestModel: "string",
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
 * Preset fields that the three "keep on preset change" toggles keep across a switch. They stay root
 * (`providers`) fields that `changeToPreset` copies, outside the forwarding layer, until the
 * follow-up after `docs/plan/PLAN.md` decides their owner (Decision 3, deferred).
 */
export const PRESET_KEEP_ON_SWITCH_FIELDS = [
    "seperateModels",
    "seperateModelsForAxModels",
    "fallbackModels",
    "fallbackWhenBlankResponse",
    "seperateParameters",
] as const satisfies readonly PresetField[];

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

const keepOnSwitchFields = new Set<string>(PRESET_KEEP_ON_SWITCH_FIELDS);
const nullableFields = new Set<string>(PRESET_NULLABLE_FIELDS);

/** The provider object that replaced the old single-provider string; runs before the kind check. */
function migrateOpenrouterProvider(value: unknown): unknown {
    return typeof value === "string" ? { order: value ? [value] : [], only: [], ignore: [] } : value;
}

/**
 * The `setDatabase` migrations of two keep-on-switch containers, in place: `seperateParameters`
 * gets its `overrides` map and every `fallbackModels` list becomes an array without empty entries.
 * Shared by `normalizePreset` and the server `providers` normalizer, which holds the root copies.
 */
export function migrateKeepOnSwitchFields(record: Record<string, unknown>): void {
    if (isPlainObject(record.seperateParameters)) {
        record.seperateParameters.overrides ??= {};
    }
    if (isPlainObject(record.fallbackModels)) {
        const fallback = record.fallbackModels;
        for (const key of ["model", "memory", "emotion", "translate", "otherAx"]) {
            fallback[key] = Array.isArray(fallback[key]) ? fallback[key].filter((model: unknown) => model !== "") : [];
        }
    }
}

/**
 * A normalized copy of a preset: only the canonical fields, each missing one (absent or `undefined`)
 * or one of the wrong JSON kind (`PRESET_FIELD_KINDS`; a number where an object belongs) filled
 * with its default, and the migrations `setDatabase` and `setPreset` applied to the root working
 * copy before Phase 3. Nested values are not checked beyond those migrations. The server `presets`
 * normalizer runs this, so a stored preset always has the containers the client reads through
 * (`NAISettings.cfg_scale`, `ooba.formating`). An explicit `null` is kept only where it is a
 * value (`PRESET_NULLABLE_FIELDS`: `setPreset` passed it through as it was, such as `min_p`) and in
 * the keep-on-switch fields (`saveCurrentPreset` writes `seperateModels: null` on purpose while
 * `doNotChangeSeperateModels` is on); any other `null` gets the default, as `setPreset` gave the
 * root copy (a number field cleared in the UI comes back as its default after a reload, as the
 * working copy's did before Phase 3). The keep-on-switch fields are never filled:
 * they stay on the pre-Phase 3 path, where `setPreset` applies their fallback. The input is never
 * mutated and must be plain data (pass `plainClone` of a proxy: `$state.snapshot` drops an own
 * `__proto__` key). The id is `options.id` when
 * given (a copy or an import passes a fresh one), else the input's valid id, else a new one.
 */
export function normalizePreset(input: unknown, options: { id?: string } = {}): botPreset {
    const source = isPlainObject(input) ? input : {};
    const preset: Record<string, unknown> = {
        id: options.id ?? (isRecordId(source.id) ? source.id : newPresetId()),
    };
    for (const field of PRESET_FIELDS) {
        const value = field === "openrouterProvider" ? migrateOpenrouterProvider(source[field]) : source[field];
        const keepsNull = nullableFields.has(field) || keepOnSwitchFields.has(field);
        if ((value === null && keepsNull) || (value != null && valueKindOf(value) === PRESET_FIELD_KINDS[field])) {
            preset[field] = plainClone(value);
            continue;
        }
        const fallback = PRESET_DEFAULTS[field];
        if (fallback !== undefined && !keepOnSwitchFields.has(field)) {
            preset[field] = plainClone(fallback);
        }
    }

    if (isPlainObject(preset.NAISettings)) {
        const nai = preset.NAISettings;
        nai.starter ??= "";
        nai.cfg_scale ??= 1;
        nai.mirostat_tau ??= 0;
        nai.mirostat_lr ??= 1;
    }
    if (isPlainObject(preset.promptSettings)) {
        preset.promptSettings.maxThoughtTagDepth ??= -1;
    }
    if (Array.isArray(preset.formatingOrder) && !preset.formatingOrder.includes("personaPrompt")) {
        const main = preset.formatingOrder.indexOf("main");
        preset.formatingOrder.splice(main === -1 ? 0 : main, 0, "personaPrompt");
    }
    if (typeof preset.top_p !== "number") {
        preset.top_p = 1;
    }
    if (typeof preset.localNetworkMode !== "boolean") {
        preset.localNetworkMode = false;
    }
    if (typeof preset.localNetworkTimeoutSec !== "number" || Number.isNaN(preset.localNetworkTimeoutSec)) {
        preset.localNetworkTimeoutSec = 600;
    }
    migrateKeepOnSwitchFields(preset);
    if (preset.promptTemplate !== undefined && preset.promptTemplate !== null) {
        preset.promptTemplate = normalizePromptTemplate(preset.promptTemplate as PromptItem[]);
    }
    return preset as unknown as botPreset;
}

/**
 * The normalized preset collection: every element normalized, a duplicate id re-keyed, and a
 * non-array or empty input replaced by one default preset (so a selection always has a record).
 */
export function normalizePresets(input: unknown): botPreset[] {
    const source = Array.isArray(input) ? input : [];
    const seen = new Set<string>();
    const presets = source.map((entry) => {
        const preset = normalizePreset(entry);
        if (seen.has(preset.id)) {
            preset.id = newPresetId();
        }
        seen.add(preset.id);
        return preset;
    });
    return presets.length > 0 ? presets : [normalizePreset({ name: "New Preset" })];
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
