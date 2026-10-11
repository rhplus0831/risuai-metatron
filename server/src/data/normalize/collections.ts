import { CREDENTIAL_TYPES, type Credential, type CredentialType, type Database } from "../../../../shared/database.ts";
import { isRecordId } from "../../../../shared/ids.ts";
import { defaultHotkeys } from "../../../../shared/hotkeys.ts";
import { createHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
import type { CollectionResource } from "../../../../shared/resources.ts";
import { createTranslatorPreset, getNormalizedTranslatorPresetName } from "../../../../shared/translatorPresets.ts";
import { ResourceValidationError } from "../resourceStore.ts";
import { isPlainObject, plainClone, requireArrayOfObjects, requireObject } from "./shared.ts";

/**
 * The collection normalizers other than `personas`. Each accepts `undefined` (a record being
 * materialized) and returns the fresh-boot value; otherwise it rejects a value of the wrong shape
 * (a `ResourceValidationError`, a 400 on write) and returns a copy. Only `hotkeys` and the two
 * `{ items, selectedId }` records add anything to what the client sent.
 */

function objectList<T>(what: string, fallback: () => T[] = () => []): (input: unknown) => T[] {
    return (input) => (input === undefined ? fallback() : (plainClone(requireArrayOfObjects(input, what)) as T[]));
}

export const normalizeLoreBook = objectList<Database["loreBook"][number]>("loreBook", () => [
    { name: "My First LoreBook", data: [] },
]);

export const normalizeGlobalscript = objectList<Database["globalscript"][number]>("globalscript");

/** `hotkeys`: the stored list, then each built-in hotkey whose `action` it lacks (as `setDatabase` merged them). */
export function normalizeHotkeys(input: unknown): Database["hotkeys"] {
    if (input === undefined) {
        return plainClone(defaultHotkeys);
    }
    const hotkeys = plainClone(requireArrayOfObjects(input, "hotkeys")) as unknown as Database["hotkeys"];
    const actions = new Set(hotkeys.map((hotkey) => hotkey.action));
    for (const hotkey of defaultHotkeys) {
        if (!actions.has(hotkey.action)) {
            hotkeys.push(plainClone(hotkey));
        }
    }
    return hotkeys;
}

/** `characterOrder`: character ids and folder objects. */
export function normalizeCharacterOrder(input: unknown): Database["characterOrder"] {
    if (input === undefined) {
        return [];
    }
    if (!Array.isArray(input) || !input.every((entry) => typeof entry === "string" || isPlainObject(entry))) {
        throw new ResourceValidationError("characterOrder must be an array of ids and folders");
    }
    return plainClone(input) as Database["characterOrder"];
}

const authRefreshFields = ["url", "tokenUrl", "refreshToken", "clientId", "clientSecret"];

/** `authRefreshes`: MCP OAuth refresh entries; each field is a string or absent (a public client has no secret). */
export function normalizeAuthRefreshes(input: unknown): Database["authRefreshes"] {
    if (input === undefined) {
        return [];
    }
    const entries = requireArrayOfObjects(input, "authRefreshes");
    for (const entry of entries) {
        if (!authRefreshFields.every((field) => entry[field] === undefined || typeof entry[field] === "string")) {
            throw new ResourceValidationError("authRefreshes entries must hold strings");
        }
    }
    return plainClone(entries) as unknown as Database["authRefreshes"];
}

export function normalizeGlobalChatVariables(input: unknown): Database["globalChatVariables"] {
    return input === undefined
        ? {}
        : (plainClone(requireObject(input, "globalChatVariables")) as Record<string, string>);
}

/** `customModels`: each entry needs its string `id` and `internalId`. */
export function normalizeCustomModels(input: unknown): Database["customModels"] {
    if (input === undefined) {
        return [];
    }
    const entries = requireArrayOfObjects(input, "customModels");
    if (!entries.every((entry) => typeof entry.id === "string" && typeof entry.internalId === "string")) {
        throw new ResourceValidationError("customModels entries need string id and internalId");
    }
    // Definitions hold neither keys nor bindings: profiles choose named credentials. Drop the
    // retired fields from an older client or record instead of keeping them readable.
    return plainClone(entries).map(
        ({ key: _key, credentialId: _credentialId, ...entry }) => entry,
    ) as unknown as Database["customModels"];
}

/** Named credential metadata only; the key is a write-only `llmSecrets.credentials` entry. */
export function normalizeCredentials(input: unknown): Database["credentials"] {
    if (input === undefined) {
        return [];
    }
    const entries = requireArrayOfObjects(input, "credentials");
    const seen = new Set<string>();
    return entries.map((entry): Credential => {
        if (
            !isRecordId(entry.id) ||
            typeof entry.name !== "string" ||
            !(CREDENTIAL_TYPES as readonly unknown[]).includes(entry.type)
        ) {
            throw new ResourceValidationError("credentials entries need a record id, string name and known type");
        }
        if (seen.has(entry.id)) {
            throw new ResourceValidationError("credentials entries must have unique ids");
        }
        seen.add(entry.id);
        if (entry.type === "vertex") {
            if (Object.hasOwn(entry, "clientEmail") && typeof entry.clientEmail !== "string") {
                throw new ResourceValidationError("credentials.clientEmail must be a string when present for vertex");
            }
            if (Object.hasOwn(entry, "projectId") && typeof entry.projectId !== "string") {
                throw new ResourceValidationError("credentials.projectId must be a string when present for vertex");
            }
            return {
                id: entry.id,
                name: entry.name,
                type: "vertex",
                ...(Object.hasOwn(entry, "clientEmail") ? { clientEmail: entry.clientEmail as string } : {}),
                ...(Object.hasOwn(entry, "projectId") ? { projectId: entry.projectId as string } : {}),
            };
        }
        return { id: entry.id, name: entry.name, type: entry.type as Exclude<CredentialType, "vertex"> };
    });
}

/** `enabledModules`: module ids. */
export function normalizeEnabledModules(input: unknown): Database["enabledModules"] {
    if (input === undefined) {
        return [];
    }
    if (!Array.isArray(input) || !input.every((entry) => typeof entry === "string")) {
        throw new ResourceValidationError("enabledModules must be an array of strings");
    }
    return [...input];
}

/** `statics`: the two usage counters, each a number (a missing or non-number one is 0). */
export function normalizeStatics(input: unknown): Database["statics"] {
    const source = input === undefined ? {} : requireObject(input, "statics");
    const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    return { messages: count(source.messages), imports: count(source.imports) };
}

/**
 * A `{ items, selectedId }` record: every item rebuilt by `create` (which keeps a valid id), a
 * repeated id re-keyed, an empty list replaced by one default item, and `selectedId` kept when it
 * names an item and set to the first item's id otherwise.
 */
function selectableList<T extends { id: string }>(
    what: string,
    create: (entry: Record<string, unknown>, index: number, id: unknown) => T,
    createDefault: () => T,
) {
    return (input: unknown): { items: T[]; selectedId: string } => {
        const source = input === undefined ? { items: [] } : requireObject(input, what);
        const seen = new Set<string>();
        const items = requireArrayOfObjects(source.items, `${what}.items`).map((entry, index) => {
            const item = create(entry, index, seen.has(entry.id as string) ? undefined : entry.id);
            seen.add(item.id);
            return item;
        });
        if (items.length === 0) {
            items.push(createDefault());
        }
        const selectedId =
            typeof source.selectedId === "string" && items.some((item) => item.id === source.selectedId)
                ? source.selectedId
                : items[0].id;
        return { items, selectedId };
    };
}

/** `translatorPresets` with the selected preset (`translatorPresetId`). */
export const normalizeTranslatorPresets: (input: unknown) => CollectionResource<"translatorPresets"> = selectableList(
    "translatorPresets",
    (entry, index, id) =>
        // `createTranslatorPreset` normalizes the steps, and turns a preset without steps into one step.
        createTranslatorPreset(getNormalizedTranslatorPresetName(entry.name, index), { ...entry, id }),
    () => createTranslatorPreset("Default"),
);

/** `hypaV3Presets` with the selected preset (`hypaV3PresetId`). */
export const normalizeHypaV3Presets: (input: unknown) => CollectionResource<"hypaV3Presets"> = selectableList(
    "hypaV3Presets",
    (entry, index, id) =>
        createHypaV3Preset(
            typeof entry.name === "string" && entry.name ? entry.name : `Preset ${index + 1}`,
            isPlainObject(entry.settings) ? entry.settings : {},
            id,
        ),
    () => createHypaV3Preset("Default"),
);
