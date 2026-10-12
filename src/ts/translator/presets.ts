import { decode as decodeMsgpack, encode as encodeMsgpack } from "msgpackr/index-no-eval";
import * as fflate from "fflate";
import { decryptBuffer, encryptBuffer } from "src/ts/util";
import { decodeRPack, encodeRPack } from "src/ts/rpack/rpack_js.js";
import type { TranslatorPreset } from "../../../shared/settings.ts";
import { createTranslatorPreset, defaultTranslatorPrompt } from "../../../shared/translatorPresets.ts";
import { selectedTranslatorPreset } from "../../../shared/translation/chatSettings.ts";
import { language } from "src/lang";

export type { TranslatorPreset } from "../../../shared/settings.ts";
export { createTranslatorPreset, defaultTranslatorPrompt };

/** The part of `Database` the selection reads: the list and the selected preset's id. */
export interface TranslatorPresetStateLike {
    translatorPresets?: unknown[];
    translatorPresetId?: string;
}

interface EncryptedTranslatorPresetFile {
    translatorPresetVersion: 1;
    type: "translator-preset";
    preset: Uint8Array | ArrayBuffer;
}

export const translatorPresetFileExtension = "risutl";
export const translatorPresetImportExtensions = [translatorPresetFileExtension];
const translatorPresetEncryptionKey = "risutl";

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** The preset a `.risutl` file (version 1) holds: one prompt and its response size. */
interface TranslatorPresetFilePayload {
    name: string;
    prompt: string;
    maxResponse: number;
}

function isTranslatorPresetFilePayload(value: unknown): value is TranslatorPresetFilePayload {
    return (
        isRecord(value) &&
        typeof value.name === "string" &&
        typeof value.prompt === "string" &&
        typeof value.maxResponse === "number" &&
        Number.isFinite(value.maxResponse)
    );
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
        value.translatorPresetVersion === 1 &&
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

    const parsedPreset: unknown = decodeMsgpack(new Uint8Array(decryptedPreset));

    if (!isTranslatorPresetFilePayload(parsedPreset)) {
        throw new Error("Invalid translator preset file.");
    }

    // An imported preset always gets a fresh id, whatever the file carries, and one step.
    return createTranslatorPreset(parsedPreset.name.trim().length > 0 ? parsedPreset.name : "Imported Preset", {
        prompt: parsedPreset.prompt,
        maxResponse: parsedPreset.maxResponse,
    });
}

/**
 * The preset as a `.risutl` file. Version 1 holds one prompt, so a preset whose run a single prompt
 * cannot reproduce (more than one step, or a step on its own model) is refused, not cut down; version
 * 2 arrives with the step editor (translation slice 3.1).
 */
export async function encodeTranslatorPresetFile(preset: TranslatorPreset): Promise<Uint8Array> {
    const normalizedPreset = createTranslatorPreset(preset.name.trim().length > 0 ? preset.name : "Preset", preset);
    const [step, ...rest] = normalizedPreset.steps;
    if (rest.length > 0 || step.model.mode !== "inherit") {
        throw new Error(language.translatorPresetExportUnsupported);
    }
    // The `.risutl` format carries no id (D5): only the name and the step's prompt and size are encoded.
    const filePreset: TranslatorPresetFilePayload = {
        name: normalizedPreset.name,
        prompt: step.prompt,
        maxResponse: step.maxResponse,
    };
    const encryptedPreset = new Uint8Array(
        await encryptBuffer(encodeMsgpack(filePreset), translatorPresetEncryptionKey),
    );
    const payload: EncryptedTranslatorPresetFile = {
        translatorPresetVersion: 1,
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
