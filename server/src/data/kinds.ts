import { RESOURCE_KIND, ROOT_EXCLUDED_KEYS } from "../../../shared/resources.ts";
import { isAssetStorageKey } from "../routes/storage.ts";
import { ResourceValidationError } from "./resourceStore.ts";

/**
 * A resource kind: its name, the schema version stored with each record, and a pure normalizer that
 * runs on every write. `normalize` returns the value to persist, or throws `ResourceValidationError`
 * to reject the write with a 400. A singleton kind has exactly one record, `SINGLETON_RESOURCE_ID`,
 * which cannot be deleted.
 */
export interface ResourceKind<T = unknown> {
    readonly name: string;
    readonly schemaVersion: number;
    readonly singleton?: boolean;
    normalize(input: unknown, context: { id: string }): T;
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
        if (registry.has(kind.name)) {
            throw new Error(`Duplicate resource kind: ${kind.name}`);
        }
        registry.set(kind.name, kind);
    }
    return registry;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
    if (!isPlainObject(value)) {
        throw new ResourceValidationError(`${what} must be an object`);
    }
    return value;
}

function requireArrayOfObjects(value: unknown, what: string): unknown[] {
    if (!Array.isArray(value) || !value.every(isPlainObject)) {
        throw new ResourceValidationError(`${what} must be an array of objects`);
    }
    return value;
}

function requireOptionalNumber(record: Record<string, unknown>, key: string, what: string) {
    if (Object.hasOwn(record, key) && record[key] !== undefined && typeof record[key] !== "number") {
        throw new ResourceValidationError(`${what}.${key} must be a number`);
    }
}

const inlayTypes = new Set(["image", "video", "audio", "signature"]);

/**
 * Minimum shapes only: Phase 1 keeps defaults and migrations on the client (`setDatabase`), so these
 * normalizers check what the client needs to assemble `Database` and return the input unchanged.
 */
export const DEFAULT_RESOURCE_KINDS: readonly ResourceKind[] = [
    {
        name: RESOURCE_KIND.root,
        schemaVersion: 1,
        singleton: true,
        normalize(input) {
            const root = requireObject(input, "root");
            for (const key of ROOT_EXCLUDED_KEYS) {
                if (Object.hasOwn(root, key)) {
                    throw new ResourceValidationError(`root must not hold ${key}`);
                }
            }
            return root;
        },
    },
    {
        name: RESOURCE_KIND.presets,
        schemaVersion: 1,
        singleton: true,
        normalize: (input) => requireArrayOfObjects(input, "presets"),
    },
    {
        name: RESOURCE_KIND.modules,
        schemaVersion: 1,
        singleton: true,
        normalize: (input) => requireArrayOfObjects(input, "modules"),
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
        normalize(input, { id }) {
            const character = requireObject(input, "character");
            if (character.chaId !== id) {
                throw new ResourceValidationError("character.chaId must equal the resource id");
            }
            // Chats live in the chat tables (Phase 2); the character record holds only its own fields.
            if (Object.hasOwn(character, "chats")) {
                throw new ResourceValidationError("character must not hold chats");
            }
            return character;
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
];
