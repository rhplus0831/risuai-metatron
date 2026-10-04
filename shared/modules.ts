// Module shapes persisted in the database and in `.risum` files (STRUCTURE D5).

import type { customscript, loreBook } from "./database.ts";
import type { triggerscript } from "./triggers.ts";

export interface MCPModule {
    url: string;
}

export interface RisuModule {
    name: string;
    description: string;
    lorebook?: loreBook[];
    regex?: customscript[];
    cjs?: string;
    trigger?: triggerscript[];
    id: string;
    lowLevelAccess?: boolean;
    hideIcon?: boolean;
    backgroundEmbedding?: string;
    assets?: [string, string, string][];
    namespace?: string;
    customModuleToggle?: string;
    mcp?: MCPModule;
    icon?: string;
}

/** A module the shared normalizer refuses (a malformed supplied structure: nothing is discarded). */
export class ModuleShapeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ModuleShapeError";
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/** A shallow copy that keeps every own key (an own `__proto__` stays a key). */
function ownCopy(value: Record<string, unknown>): Record<string, unknown> {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
        Object.defineProperty(copy, key, { value: value[key], enumerable: true, writable: true, configurable: true });
    }
    return copy;
}

/**
 * The lorebook conversion of entries below `bookVersion` 2 (the startup step `updateLorebooks` ran
 * before Phase 6): an `activationPercent` becomes an `@@probability` line, `@@end`/`@@@end` becomes
 * `@@depth 0`, `<char>`/`<bot>` and `<user>` become their CBS forms, and the entry is marked version 2.
 * Returns new entries (the input is not changed); an entry already at version 2, or without a string
 * `content`, is kept as it is. A non-object entry is refused. Idempotent.
 */
export function upgradeLorebook(entries: readonly unknown[]): loreBook[] {
    return entries.map((entry, index) => {
        if (!isRecord(entry)) {
            throw new ModuleShapeError(`lorebook[${index}] must be an object`);
        }
        const version = typeof entry.bookVersion === "number" ? entry.bookVersion : 1;
        if (version >= 2 || typeof entry.content !== "string") {
            return entry as unknown as loreBook;
        }
        const next = ownCopy(entry);
        let content = entry.content;
        if (entry.activationPercent) {
            content = `@@probability ${entry.activationPercent}\n${content}`;
            next.activationPercent = null;
        }
        next.content = content
            .replace(/@@@?end/g, "@@depth 0")
            .replace(/<(char|bot)>/g, "{{char}}")
            .replace(/<(user)>/g, "{{user}}");
        next.bookVersion = 2;
        return next as unknown as loreBook;
    });
}

/**
 * Checks a module's shape (the client's mutations and the server's normalizer apply the same rule):
 * an object; `name` and `description` strings when present; `lorebook`, `regex`, and `trigger` lists
 * when present (a present non-list is refused, never dropped); every field kept. With `newId` (the
 * client's mutations) a missing or empty `id` is assigned on a copy; otherwise the input itself is
 * returned. The lorebook conversion of old entries (`upgradeLorebook`) is the import paths' step, not
 * part of this rule.
 */
export function normalizeModule(input: unknown, newId?: () => string): RisuModule {
    if (!isRecord(input)) {
        throw new ModuleShapeError("a module must be an object");
    }
    for (const field of ["name", "description"] as const) {
        if (input[field] !== undefined && typeof input[field] !== "string") {
            throw new ModuleShapeError(`a module's ${field} must be a string`);
        }
    }
    for (const field of ["lorebook", "regex", "trigger"] as const) {
        if (input[field] !== undefined && !Array.isArray(input[field])) {
            throw new ModuleShapeError(`a module's ${field} must be a list`);
        }
    }
    if (newId && (typeof input.id !== "string" || input.id === "")) {
        if (input.id !== undefined && input.id !== null && input.id !== "") {
            throw new ModuleShapeError("a module's id must be a string");
        }
        const module = ownCopy(input);
        module.id = newId();
        return module as unknown as RisuModule;
    }
    return input as unknown as RisuModule;
}
