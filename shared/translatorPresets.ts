import { isRecordId, newId } from "./ids.ts";
import type { TranslatorPreset, TranslatorStep, TranslatorStepModel } from "./settings.ts";
import { isPlainObject } from "./valueKinds.ts";

export const defaultTranslatorPrompt =
    "You are a translator. translate the following html or text into {{slot}}. do not output anything other than the translation.";

/** The most steps a translator preset holds; the normalizer keeps the first ones. */
export const TRANSLATOR_PRESET_MAX_STEPS = 5;

/** A step's `outputKey`, the `KEY` of `{{slot::out::KEY}}`. */
export const TRANSLATOR_OUTPUT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const DEFAULT_MAX_RESPONSE = 1000;

/** What `createTranslatorPreset` takes in: a preset, possibly in the shape before steps, of unchecked types. */
export interface TranslatorPresetInput {
    readonly id?: unknown;
    readonly steps?: unknown;
    readonly prompt?: unknown;
    readonly maxResponse?: unknown;
    readonly sendTextAsIs?: unknown;
    readonly excludeThoughts?: unknown;
}

export function getNormalizedTranslatorPresetName(name: unknown, index: number): string {
    if (typeof name === "string" && name.trim().length > 0) {
        return name;
    }

    return `Preset ${index + 1}`;
}

function finiteNumber(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The name a step gets when it has none: `Step N`, N its position from 1. */
export function defaultTranslatorStepName(index: number): string {
    return `Step ${index + 1}`;
}

/**
 * A new step at `index` (0-based) in its normalized form, so a list holding it is stored as it is:
 * a fresh id, the default name, enabled, a blank prompt (`defaultTranslatorPrompt`), the default
 * response size, on the `translate` slot, and no output key.
 */
export function createTranslatorStep(index: number): TranslatorStep {
    return {
        id: newId(),
        name: defaultTranslatorStepName(index),
        enabled: true,
        prompt: "",
        maxResponse: DEFAULT_MAX_RESPONSE,
        model: { mode: "inherit" },
    };
}

function normalizeStepModel(value: unknown): TranslatorStepModel {
    if (isPlainObject(value) && value.mode === "profile" && isRecordId(value.profileId)) {
        return { mode: "profile", profileId: value.profileId };
    }
    return { mode: "inherit" };
}

/**
 * A translator preset's steps from `source`: its `steps` when that is a nonempty list, else one step
 * made from the `{ prompt, maxResponse }` shape presets had before steps. At most
 * `TRANSLATOR_PRESET_MAX_STEPS` (the first ones); a field of the wrong type gets its default, a step
 * id or output key already used earlier in the list is replaced (an id) or dropped (a key), and an
 * output key not matching `TRANSLATOR_OUTPUT_KEY_PATTERN` is dropped. Idempotent.
 */
export function normalizeTranslatorSteps(source: TranslatorPresetInput): TranslatorStep[] {
    const entries: unknown[] =
        Array.isArray(source.steps) && source.steps.length > 0
            ? source.steps
            : [{ prompt: source.prompt, maxResponse: source.maxResponse }];
    const ids = new Set<string>();
    const outputKeys = new Set<string>();

    return entries.slice(0, TRANSLATOR_PRESET_MAX_STEPS).map((entry, index) => {
        const value = isPlainObject(entry) ? entry : {};
        const id = isRecordId(value.id) && !ids.has(value.id) ? value.id : newId();
        ids.add(id);
        const step: TranslatorStep = {
            id,
            name:
                typeof value.name === "string" && value.name.trim().length > 0
                    ? value.name
                    : defaultTranslatorStepName(index),
            enabled: typeof value.enabled === "boolean" ? value.enabled : true,
            prompt: typeof value.prompt === "string" ? value.prompt : "",
            maxResponse: finiteNumber(value.maxResponse, DEFAULT_MAX_RESPONSE),
            model: normalizeStepModel(value.model),
        };
        if (
            typeof value.outputKey === "string" &&
            TRANSLATOR_OUTPUT_KEY_PATTERN.test(value.outputKey) &&
            !outputKeys.has(value.outputKey)
        ) {
            step.outputKey = value.outputKey;
            outputKeys.add(value.outputKey);
        }
        return step;
    });
}

/**
 * A translator preset with its steps normalized from `existing` (`normalizeTranslatorSteps`: its
 * steps, or one step from its `prompt` and `maxResponse`). `existing.id` is kept when it is a valid
 * record id; otherwise a new id is assigned. `sendTextAsIs` and `excludeThoughts` are each kept only
 * when it is `true` (absent otherwise). This is the server's normalizer of each preset too, so a preset the tab creates with it
 * is stored as it is.
 */
export function createTranslatorPreset(name = "New Preset", existing: TranslatorPresetInput = {}): TranslatorPreset {
    return {
        id: isRecordId(existing.id) ? existing.id : newId(),
        name,
        steps: normalizeTranslatorSteps(existing),
        ...(existing.sendTextAsIs === true ? { sendTextAsIs: true } : {}),
        ...(existing.excludeThoughts === true ? { excludeThoughts: true } : {}),
    };
}

function isTranslatorStepModel(value: unknown): value is TranslatorStepModel {
    return (
        isPlainObject(value) && (value.mode === "inherit" || (value.mode === "profile" && isRecordId(value.profileId)))
    );
}

/** Whether `value` has the shape of a `TranslatorStep`. */
export function isTranslatorStep(value: unknown): value is TranslatorStep {
    return (
        isPlainObject(value) &&
        isRecordId(value.id) &&
        typeof value.name === "string" &&
        typeof value.enabled === "boolean" &&
        typeof value.prompt === "string" &&
        typeof value.maxResponse === "number" &&
        Number.isFinite(value.maxResponse) &&
        isTranslatorStepModel(value.model) &&
        (value.outputKey === undefined || typeof value.outputKey === "string")
    );
}

/**
 * Whether `value` has the shape of a `TranslatorPreset` (1 to `TRANSLATOR_PRESET_MAX_STEPS` valid
 * steps, `sendTextAsIs` and `excludeThoughts` each absent or a boolean: a `false` the normalizer would
 * drop still reads as off).
 */
export function isTranslatorPreset(value: unknown): value is TranslatorPreset {
    return (
        isPlainObject(value) &&
        isRecordId(value.id) &&
        typeof value.name === "string" &&
        (value.sendTextAsIs === undefined || typeof value.sendTextAsIs === "boolean") &&
        (value.excludeThoughts === undefined || typeof value.excludeThoughts === "boolean") &&
        Array.isArray(value.steps) &&
        value.steps.length > 0 &&
        value.steps.length <= TRANSLATOR_PRESET_MAX_STEPS &&
        value.steps.every(isTranslatorStep)
    );
}
