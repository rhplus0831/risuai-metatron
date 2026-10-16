import { RESOURCE_KIND } from "../../../shared/resources.ts";
import { isAssetStorageKey } from "../routes/storage.ts";
import {
    normalizeAuthRefreshes,
    normalizeCharacterOrder,
    normalizeCredentials,
    normalizeCustomModels,
    normalizeEnabledModules,
    normalizeGlobalChatVariables,
    normalizeGlobalscript,
    normalizeHotkeys,
    normalizeHypaV3Presets,
    normalizeLoreBook,
    normalizeStatics,
    normalizeTranslatorPresets,
} from "./normalize/collections.ts";
import { normalizeLlmSecrets } from "./normalize/llmSecrets.ts";
import { normalizeMemoryTranslateMedia } from "./normalize/memoryTranslateMedia.ts";
import { normalizePersonas } from "./normalize/personas.ts";
import {
    normalizeModelPresetCollection,
    normalizeModelProfileCollection,
    normalizePresetCollection,
} from "./normalize/presets.ts";
import { normalizeProviders } from "./normalize/providers.ts";
import { normalizeSecrets } from "./normalize/secrets.ts";
import { requireArrayOfObjects, requireObject } from "./normalize/shared.ts";
import { normalizeModules } from "./normalize/modules.ts";
import { normalizeCharacterRecord } from "./normalize/characters.ts";
import { normalizeUi } from "./normalize/ui.ts";
import { carriesSecretPath, maskLlmSecrets, withStoredSecrets } from "../../../shared/llmSecrets.ts";
import { ResourceValidationError } from "./resourceStore.ts";

/**
 * A resource kind: its name, the schema version stored with each record, and a pure normalizer that
 * runs on every write and in the store's startup pass. `normalize` returns the value to persist, or
 * throws `ResourceValidationError` to reject the write with a 400; it must be idempotent (normalizing
 * its own output returns the same JSON), or the startup pass rewrites the record on every start. A
 * singleton kind has exactly one record, `SINGLETON_RESOURCE_ID`, which cannot be deleted. A
 * `materialize` kind is a singleton the store creates as `normalize(undefined)` whenever it is missing
 * (at startup and after a restore), so a client always finds it.
 *
 * A write-only kind (`llmSecrets`, Phase 5 slice 7b) has `project` and `prepareWrite`: the resource
 * routes return `project(data)` wherever a record reaches a client (the stored data stays as it is
 * for the server), and a plain write's data is `prepareWrite(incoming, stored)` before it is
 * normalized (it may refuse with `ResourceValidationError`). Both run in the same synchronous block
 * as the write, so they are atomic with its revision check.
 */
export interface ResourceKind<T = unknown> {
    readonly name: string;
    readonly schemaVersion: number;
    readonly singleton?: boolean;
    readonly materialize?: true;
    normalize(input: unknown, context: { id: string }): T;
    /**
     * The normalizer changes neither its input nor anything reachable from it, and every top-level field
     * (an object record) or item (an array record) of its result that it did not replace is the input's,
     * by reference: a patch then serializes only what changed (`writePatch`'s fast path).
     */
    readonly shallowNormalize?: true;
    project?(data: unknown): unknown;
    prepareWrite?(incoming: unknown, stored: unknown | null): unknown;
}

export type ResourceKindRegistry = ReadonlyMap<string, ResourceKind>;

const kindNameRegex = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/**
 * Path segments the resource routes use themselves (`/api/resources/batch`, `/api/resources/read`),
 * and the `kind` values of chat and chat-order entries in a batch conflict.
 */
const reservedKindNames = new Set(["batch", "read", "chat", "chatOrder"]);

/** Builds the kind lookup for the resource routes. Rejects invalid, reserved, and duplicate names. */
export function createKindRegistry(kinds: readonly ResourceKind[]): ResourceKindRegistry {
    const registry = new Map<string, ResourceKind>();
    for (const kind of kinds) {
        if (!kindNameRegex.test(kind.name) || reservedKindNames.has(kind.name)) {
            throw new Error(`Invalid resource kind name: ${kind.name}`);
        }
        if (!Number.isSafeInteger(kind.schemaVersion) || kind.schemaVersion < 1) {
            throw new Error(`Invalid schema version for resource kind ${kind.name}`);
        }
        if (kind.materialize && !kind.singleton) {
            throw new Error(`Resource kind ${kind.name} materializes but is not a singleton`);
        }
        if (registry.has(kind.name)) {
            throw new Error(`Duplicate resource kind: ${kind.name}`);
        }
        registry.set(kind.name, kind);
    }
    return registry;
}

function requireOptionalNumber(record: Record<string, unknown>, key: string, what: string) {
    if (Object.hasOwn(record, key) && record[key] !== undefined && typeof record[key] !== "number") {
        throw new ResourceValidationError(`${what}.${key} must be a number`);
    }
}

/** A Phase 3 settings kind: a singleton the store materializes, normalized by `normalize`. */
function settingsKind(
    name: string,
    normalize: (input: unknown) => unknown,
    extra: Pick<ResourceKind, "project" | "prepareWrite"> = {},
): ResourceKind {
    return {
        name,
        schemaVersion: 1,
        singleton: true,
        materialize: true,
        ...extra,
        normalize: (input) => normalize(input),
    };
}

const inlayTypes = new Set(["image", "video", "audio", "signature"]);

/**
 * The Phase 1 kinds check minimum shapes and return the input unchanged, except `presets`, which
 * gets the canonical preset schema. The Phase 3 sections and collections
 * (`server/src/data/normalize/`) apply their defaults and migrations, which `setDatabase` applied on
 * the client before.
 */
export const DEFAULT_RESOURCE_KINDS: readonly ResourceKind[] = [
    {
        name: RESOURCE_KIND.presets,
        schemaVersion: 1,
        singleton: true,
        // Created by the server like the Phase 3 kinds, so a selection always has a preset.
        materialize: true,
        normalize: (input) => normalizePresetCollection(input),
    },
    {
        name: RESOURCE_KIND.modules,
        schemaVersion: 1,
        singleton: true,
        shallowNormalize: true,
        normalize: (input) => normalizeModules(input),
    },
    {
        name: RESOURCE_KIND.plugins,
        schemaVersion: 1,
        singleton: true,
        normalize: (input) => requireArrayOfObjects(input, "plugins"),
    },
    {
        name: RESOURCE_KIND.pluginStorage,
        schemaVersion: 1,
        singleton: true,
        shallowNormalize: true,
        normalize: (input) => requireObject(input, "pluginStorage"),
    },
    {
        name: RESOURCE_KIND.pluginPermissions,
        schemaVersion: 1,
        singleton: true,
        normalize(input) {
            const record = requireObject(input, "pluginPermissions");
            const grants = requireObject(record.grants, "pluginPermissions.grants");
            const lastGrantTime = requireObject(record.lastGrantTime, "pluginPermissions.lastGrantTime");
            if (!Object.values(grants).every((value) => value === true)) {
                throw new ResourceValidationError("pluginPermissions.grants values must be true");
            }
            if (!Object.values(lastGrantTime).every((value) => typeof value === "number")) {
                throw new ResourceValidationError("pluginPermissions.lastGrantTime values must be numbers");
            }
            return record;
        },
    },
    {
        name: RESOURCE_KIND.characters,
        schemaVersion: 1,
        shallowNormalize: true,
        normalize(input, { id }) {
            return normalizeCharacterRecord(input, id);
        },
    },
    {
        name: RESOURCE_KIND.inlays,
        schemaVersion: 1,
        normalize(input) {
            const inlay = requireObject(input, "inlay");
            if (typeof inlay.name !== "string" || typeof inlay.ext !== "string") {
                throw new ResourceValidationError("inlay.name and inlay.ext must be strings");
            }
            if (typeof inlay.type !== "string" || !inlayTypes.has(inlay.type)) {
                throw new ResourceValidationError("inlay.type must be image, video, audio, or signature");
            }
            requireOptionalNumber(inlay, "width", "inlay");
            requireOptionalNumber(inlay, "height", "inlay");
            requireOptionalNumber(inlay, "size", "inlay");
            if (inlay.type === "signature") {
                if (typeof inlay.text !== "string") {
                    throw new ResourceValidationError("A signature inlay needs text");
                }
            } else if (!isAssetStorageKey(inlay.asset)) {
                // The same rule as the storage routes, so the key can always be read back.
                throw new ResourceValidationError("A media inlay needs a resolvable asset key in the assets namespace");
            }
            return inlay;
        },
    },
    settingsKind(RESOURCE_KIND.providers, normalizeProviders),
    settingsKind(RESOURCE_KIND.secrets, normalizeSecrets),
    settingsKind(RESOURCE_KIND.llmSecrets, normalizeLlmSecrets, {
        // Write-only (`shared/llmSecrets.ts`): a client reads masked leaves; a plain write keeps
        // every stored credential and may not carry one (they are written through `/api/llm-secrets`).
        project: (data) => maskLlmSecrets(data as Record<string, unknown>),
        prepareWrite: (incoming, stored) => {
            if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
                throw new ResourceValidationError("llmSecrets must be an object");
            }
            if (carriesSecretPath(incoming as Record<string, unknown>)) {
                throw new ResourceValidationError(
                    "llmSecrets credentials are written through /api/llm-secrets, not in the record",
                );
            }
            return withStoredSecrets(incoming as Record<string, unknown>, (stored ?? {}) as Record<string, unknown>);
        },
    }),
    settingsKind(RESOURCE_KIND.ui, normalizeUi),
    settingsKind(RESOURCE_KIND.memoryTranslateMedia, normalizeMemoryTranslateMedia),
    settingsKind(RESOURCE_KIND.loreBook, normalizeLoreBook),
    settingsKind(RESOURCE_KIND.globalscript, normalizeGlobalscript),
    settingsKind(RESOURCE_KIND.hotkeys, normalizeHotkeys),
    settingsKind(RESOURCE_KIND.characterOrder, normalizeCharacterOrder),
    settingsKind(RESOURCE_KIND.authRefreshes, normalizeAuthRefreshes),
    settingsKind(RESOURCE_KIND.globalChatVariables, normalizeGlobalChatVariables),
    settingsKind(RESOURCE_KIND.personas, normalizePersonas),
    settingsKind(RESOURCE_KIND.translatorPresets, normalizeTranslatorPresets),
    settingsKind(RESOURCE_KIND.hypaV3Presets, normalizeHypaV3Presets),
    settingsKind(RESOURCE_KIND.customModels, normalizeCustomModels),
    settingsKind(RESOURCE_KIND.credentials, normalizeCredentials),
    settingsKind(RESOURCE_KIND.enabledModules, normalizeEnabledModules),
    settingsKind(RESOURCE_KIND.statics, normalizeStatics),
    settingsKind(RESOURCE_KIND.modelPresets, normalizeModelPresetCollection),
    settingsKind(RESOURCE_KIND.modelProfiles, normalizeModelProfileCollection),
];
