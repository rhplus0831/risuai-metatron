import { decode as decodeMsgpack, encode as encodeMsgpack } from "msgpackr/index-no-eval";
import * as fflate from "fflate";
import { decryptBuffer, encryptBuffer } from "src/ts/util";
import { decodeRPack, encodeRPack } from "src/ts/rpack/rpack_js.js";
import type { TranslatorPreset, TranslatorStepModel } from "../../../shared/settings.ts";
import { isRecordId } from "../../../shared/ids.ts";
import {
    createTranslatorPreset,
    defaultTranslatorPrompt,
    defaultTranslatorStepName,
    TRANSLATOR_OUTPUT_KEY_PATTERN,
    TRANSLATOR_PRESET_MAX_STEPS,
} from "../../../shared/translatorPresets.ts";
import { selectedTranslatorPreset } from "../../../shared/translation/chatSettings.ts";

export type { TranslatorPreset } from "../../../shared/settings.ts";
export { createTranslatorPreset, defaultTranslatorPrompt };

/** The part of `Database` the selection reads: the list and the selected preset's id. */
export interface TranslatorPresetStateLike {
    translatorPresets?: unknown[];
    translatorPresetId?: string;
}

interface EncryptedTranslatorPresetFile {
    translatorPresetVersion: 1 | 2;
    type: "translator-preset";
    preset: Uint8Array | ArrayBuffer;
}

export const translatorPresetFileExtension = "risutl";
export const translatorPresetImportExtensions = [translatorPresetFileExtension];
const translatorPresetEncryptionKey = "risutl";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** The preset a `.risutl` version 1 file holds: one prompt and its response size. */
interface TranslatorPresetFilePayload {
    name: string;
    prompt: string;
    maxResponse: number;
}

/**
 * A version 1 payload. Other keys are tolerated (older writers), except `sendTextAsIs` and
 * `excludeThoughts`, which version 1 cannot hold: a file carrying one is refused rather than imported
 * with the option off.
 */
function isTranslatorPresetFilePayload(value: unknown): value is TranslatorPresetFilePayload {
    return (
        isRecord(value) &&
        !Object.hasOwn(value, "sendTextAsIs") &&
        !Object.hasOwn(value, "excludeThoughts") &&
        typeof value.name === "string" &&
        typeof value.prompt === "string" &&
        typeof value.maxResponse === "number" &&
        Number.isFinite(value.maxResponse)
    );
}

/** A step as a `.risutl` version 2 file holds it: no id (D5). */
interface TranslatorStepFilePayload {
    name: string;
    enabled: boolean;
    prompt: string;
    maxResponse: number;
    model: TranslatorStepModel;
    outputKey?: string;
}

/**
 * The preset a `.risutl` version 2 file holds: its name, 1 to 5 steps, and Send Text As-Is and
 * Exclude Chain-of-Thought (optional booleans, each written only when it is on).
 */
interface TranslatorPresetFilePayloadV2 {
    name: string;
    steps: TranslatorStepFilePayload[];
    sendTextAsIs?: boolean;
    excludeThoughts?: boolean;
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) {
    const keys = Object.keys(value);
    return (
        required.every((key) => Object.hasOwn(value, key)) &&
        keys.every((key) => required.includes(key) || optional.includes(key))
    );
}

function isStepFileModel(value: unknown): value is TranslatorStepModel {
    return (
        isRecord(value) &&
        ((value.mode === "inherit" && hasOnlyKeys(value, ["mode"])) ||
            (value.mode === "profile" && hasOnlyKeys(value, ["mode", "profileId"]) && isRecordId(value.profileId)))
    );
}

function isStepFilePayload(value: unknown): value is TranslatorStepFilePayload {
    return (
        isRecord(value) &&
        hasOnlyKeys(value, ["name", "enabled", "prompt", "maxResponse", "model"], ["outputKey"]) &&
        typeof value.name === "string" &&
        typeof value.enabled === "boolean" &&
        typeof value.prompt === "string" &&
        typeof value.maxResponse === "number" &&
        Number.isFinite(value.maxResponse) &&
        isStepFileModel(value.model) &&
        (value.outputKey === undefined ||
            (typeof value.outputKey === "string" && TRANSLATOR_OUTPUT_KEY_PATTERN.test(value.outputKey)))
    );
}

/**
 * A version 2 payload, checked at every level: exactly `name`, `steps`, and the optional booleans
 * `sendTextAsIs` and `excludeThoughts` (a payload of another shape, such as the Fastify fork's, is refused, decision 8), 1
 * to 5 steps of exactly the step fields, and no output key used twice (a file whose
 * `{{slot::out::KEY}}` would break is refused, not repaired).
 */
function isTranslatorPresetFilePayloadV2(value: unknown): value is TranslatorPresetFilePayloadV2 {
    if (
        !isRecord(value) ||
        !hasOnlyKeys(value, ["name", "steps"], ["sendTextAsIs", "excludeThoughts"]) ||
        (Object.hasOwn(value, "sendTextAsIs") && typeof value.sendTextAsIs !== "boolean") ||
        (Object.hasOwn(value, "excludeThoughts") && typeof value.excludeThoughts !== "boolean") ||
        typeof value.name !== "string" ||
        !Array.isArray(value.steps) ||
        value.steps.length === 0 ||
        value.steps.length > TRANSLATOR_PRESET_MAX_STEPS ||
        !value.steps.every(isStepFilePayload)
    ) {
        return false;
    }
    const keys = value.steps.flatMap((step) => (step.outputKey === undefined ? [] : [step.outputKey]));
    return new Set(keys).size === keys.length;
}

function getBytes(value: unknown): Uint8Array | null {
    if (value instanceof Uint8Array) {
        return value;
    }

    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }

    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }

    return null;
}

function isEncryptedTranslatorPresetFile(value: unknown): value is EncryptedTranslatorPresetFile {
    return (
        isRecord(value) &&
        (value.translatorPresetVersion === 1 || value.translatorPresetVersion === 2) &&
        value.type === "translator-preset" &&
        getBytes(value.preset) !== null
    );
}

function sanitizeFileNamePart(value: string): string {
    const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
    return sanitized.length > 0 ? sanitized : "preset";
}

/**
 * The selected translator preset: the one whose id is `translatorPresetId`, else the first, else a
 * default (the server keeps the list nonempty and the id valid, so the fallbacks cover only another
 * client's deletion until the next reload). It never writes the state.
 */
export function getCurrentTranslatorPresetFromState(state: TranslatorPresetStateLike): TranslatorPreset {
    return selectedTranslatorPreset(state.translatorPresets, state.translatorPresetId);
}

async function decodeEncryptedTranslatorPresetFile(data: Uint8Array): Promise<TranslatorPreset> {
    let encodedPreset: Uint8Array;
    try {
        encodedPreset = await decodeRPack(data);
    } catch {
        throw new Error("Invalid translator preset file.");
    }

    let decodedContainer: unknown;

    try {
        decodedContainer = decodeMsgpack(fflate.decompressSync(encodedPreset));
    } catch {
        throw new Error("Invalid translator preset file.");
    }

    if (!isEncryptedTranslatorPresetFile(decodedContainer)) {
        throw new Error("Invalid translator preset file.");
    }

    const encryptedPreset = getBytes(decodedContainer.preset);

    if (!encryptedPreset) {
        throw new Error("Invalid translator preset file.");
    }

    let decryptedPreset: ArrayBuffer;

    try {
        decryptedPreset = await decryptBuffer(encryptedPreset, translatorPresetEncryptionKey);
    } catch {
        throw new Error("Invalid translator preset file.");
    }

    let parsedPreset: unknown;
    try {
        parsedPreset = decodeMsgpack(new Uint8Array(decryptedPreset));
    } catch {
        throw new Error("Invalid translator preset file.");
    }

    // An imported preset always gets fresh preset and step ids, whatever the file carries.
    if (decodedContainer.translatorPresetVersion === 1) {
        if (!isTranslatorPresetFilePayload(parsedPreset)) {
            throw new Error("Invalid translator preset file.");
        }
        // One step.
        return createTranslatorPreset(importedName(parsedPreset.name), {
            prompt: parsedPreset.prompt,
            maxResponse: parsedPreset.maxResponse,
        });
    }
    if (!isTranslatorPresetFilePayloadV2(parsedPreset)) {
        throw new Error("Invalid translator preset file.");
    }
    // Built field by field, so nothing but the checked fields reaches the normalizer. A step on a
    // profile keeps its id: it runs on that profile where it exists, and is shown missing elsewhere.
    return createTranslatorPreset(importedName(parsedPreset.name), {
        steps: parsedPreset.steps.map((step) => ({
            name: step.name,
            enabled: step.enabled,
            prompt: step.prompt,
            maxResponse: step.maxResponse,
            model:
                step.model.mode === "profile"
                    ? { mode: "profile", profileId: step.model.profileId }
                    : { mode: "inherit" },
            ...(step.outputKey === undefined ? {} : { outputKey: step.outputKey }),
        })),
        sendTextAsIs: parsedPreset.sendTextAsIs,
        excludeThoughts: parsedPreset.excludeThoughts,
    });
}

/** An imported preset's name: the file's, or "Imported Preset" when it is blank (the normalizer's rule). */
function importedName(name: string): string {
    return name.trim().length > 0 ? name : "Imported Preset";
}

/**
 * Whether version 1 (`{ name, prompt, maxResponse }`) holds the preset without loss: Send Text As-Is
 * and Exclude Chain-of-Thought off, and one step on the `translate` slot, enabled, without an output key, and with the name a
 * version 1 import gives it.
 */
function fitsVersion1(preset: TranslatorPreset): boolean {
    const [step, ...rest] = preset.steps;
    return (
        preset.sendTextAsIs !== true &&
        preset.excludeThoughts !== true &&
        rest.length === 0 &&
        step.model.mode === "inherit" &&
        step.enabled &&
        step.outputKey === undefined &&
        step.name === defaultTranslatorStepName(0)
    );
}

/**
 * The preset as a `.risutl` file: version 1 when it holds the preset without loss (`fitsVersion1`), so
 * builds before steps can read it, else version 2 with every step. The file carries no preset or step
 * id (D5); a step on a profile carries the profile's id, never its settings or key.
 */
export async function encodeTranslatorPresetFile(preset: TranslatorPreset): Promise<Uint8Array> {
    const normalizedPreset = createTranslatorPreset(preset.name.trim().length > 0 ? preset.name : "Preset", preset);
    const version = fitsVersion1(normalizedPreset) ? 1 : 2;
    let filePreset: TranslatorPresetFilePayload | TranslatorPresetFilePayloadV2;
    if (version === 1) {
        const step = normalizedPreset.steps[0];
        filePreset = { name: normalizedPreset.name, prompt: step.prompt, maxResponse: step.maxResponse };
    } else {
        filePreset = {
            name: normalizedPreset.name,
            steps: normalizedPreset.steps.map((step) => ({
                name: step.name,
                enabled: step.enabled,
                prompt: step.prompt,
                maxResponse: step.maxResponse,
                model:
                    step.model.mode === "profile"
                        ? { mode: "profile", profileId: step.model.profileId }
                        : { mode: "inherit" },
                ...(step.outputKey === undefined ? {} : { outputKey: step.outputKey }),
            })),
            ...(normalizedPreset.sendTextAsIs === true ? { sendTextAsIs: true } : {}),
            ...(normalizedPreset.excludeThoughts === true ? { excludeThoughts: true } : {}),
        };
    }
    const encryptedPreset = new Uint8Array(
        await encryptBuffer(encodeMsgpack(filePreset), translatorPresetEncryptionKey),
    );
    const payload: EncryptedTranslatorPresetFile = {
        translatorPresetVersion: version,
        type: "translator-preset",
        preset: encryptedPreset,
    };

    return await encodeRPack(fflate.compressSync(encodeMsgpack(payload)));
}

export async function decodeTranslatorPresetFile(data: Uint8Array): Promise<TranslatorPreset> {
    return await decodeEncryptedTranslatorPresetFile(data);
}

export function getTranslatorPresetDownloadName(name: string): string {
    return `translator_preset_${sanitizeFileNamePart(name)}.${translatorPresetFileExtension}`;
}
