/**
 * A resource kind: its name, the schema version stored with each record, and a pure normalizer that
 * runs on every write. `normalize` returns the value to persist, or throws `ResourceValidationError`
 * to reject the write with a 400.
 */
export interface ResourceKind<T = unknown> {
    readonly name: string;
    readonly schemaVersion: number;
    normalize(input: unknown): T;
}

export type ResourceKindRegistry = ReadonlyMap<string, ResourceKind>;

const kindNameRegex = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Builds the kind lookup for the resource routes. Rejects invalid and duplicate names. */
export function createKindRegistry(kinds: readonly ResourceKind[]): ResourceKindRegistry {
    const registry = new Map<string, ResourceKind>();
    for (const kind of kinds) {
        if (!kindNameRegex.test(kind.name)) {
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

const identity = (input: unknown): unknown => input;

/**
 * The save blocks that Phase 1 of the server data ownership plan turns into resources. Phase 0 stores
 * them unchecked: the normalizers are identity and the payloads untyped. Phase 1 binds each kind to
 * its shared type, decides which `Database` fields `root` holds, and adds real normalizers.
 */
export const DEFAULT_RESOURCE_KINDS: readonly ResourceKind[] = [
    "root",
    "presets",
    "modules",
    "plugins",
    "pluginStorage",
    "characters",
].map((name) => ({ name, schemaVersion: 1, normalize: identity }));
