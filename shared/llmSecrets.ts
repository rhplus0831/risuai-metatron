// The write-only `llmSecrets` kind (Phase 5 slice 7b, `request-layer-and-llm-secrets`): which paths
// of the record are credentials, the path codec of `/api/llm-secrets/*`, and the masked projection
// a client reads. Both runtimes compile this file; keep it free of DOM types and runes.

/** The flat string credentials of the record (`SECTION_FIELDS.llmSecrets`). */
export const FLAT_SECRET_FIELDS = [
    "openAIKey",
    "claudeAPIKey",
    "openrouterKey",
    "nanogptKey",
    "mistralKey",
    "cohereAPIKey",
    "ollamaApiKey",
    "novellistAPI",
    "mancerHeader",
    "supaMemoryKey",
    "vertexPrivateKey",
    "vertexAccessToken",
] as const;

/** The credential leaf of each container field; its other fields are readable siblings. */
export const NESTED_SECRET_FIELDS = {
    google: "accessToken",
    hordeConfig: "apiKey",
    novelai: "token",
} as const;

/** The maps whose every entry is a credential: `OaiCompAPIKeys.<id>` is the value itself. */
export const SECRET_MAP_FIELDS = ["OaiCompAPIKeys"] as const;

/**
 * The per-record maps, each named after the settings collection whose records own its entries:
 * `modelPresets.<modelPresetId>.proxyKey`, `customModels.<modelId>.key`.
 */
export const SECRET_ENTRY_MAPS = { modelPresets: "proxyKey", customModels: "key" } as const;

export type FlatSecretField = (typeof FLAT_SECRET_FIELDS)[number];
export type NestedSecretField = keyof typeof NESTED_SECRET_FIELDS;
export type SecretEntryMap = keyof typeof SECRET_ENTRY_MAPS;

/** One credential's place in the record. */
export type SecretPath =
    | { kind: "flat"; field: FlatSecretField }
    | { kind: "nested"; field: NestedSecretField }
    | { kind: "map"; field: "OaiCompAPIKeys"; id: string }
    | { kind: "entry"; field: SecretEntryMap; id: string };

/** What a client reads in place of a credential. */
export type MaskedLeaf = { set: boolean; hint: string };

const HINT_MIN_LENGTH = 16;
const HINT_LENGTH = 4;

export function isMaskedLeaf(value: unknown): value is MaskedLeaf {
    return (
        !!value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 2 &&
        typeof (value as MaskedLeaf).set === "boolean" &&
        typeof (value as MaskedLeaf).hint === "string"
    );
}

/** A stored value's masked leaf: set only for a non-empty string; a hint only for a long one. */
export function maskedLeaf(value: unknown): MaskedLeaf {
    if (typeof value !== "string" || value === "") {
        return { set: false, hint: "" };
    }
    return { set: true, hint: value.length >= HINT_MIN_LENGTH ? value.slice(-HINT_LENGTH) : "" };
}

const hasOwn = (value: unknown, key: string) =>
    !!value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);

/** An own-property map (an id such as `__proto__` stays an ordinary key). */
function ownEntries(value: unknown): [string, unknown][] {
    return value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : [];
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown) {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

// ---------------------------------------------------------------------------------------------
// The path codec. A path is one to three segments joined by `/`; each segment is
// `encodeURIComponent`ed with `.` escaped too, and decoded once from the raw pathname. An id
// segment (a map or entry id, which any string can be) carries a `~` prefix, so even the ids `.`
// and `..` never form a dot segment a URL parser would resolve away.

function encodeSegment(segment: string): string {
    return encodeURIComponent(segment).replace(/\./g, "%2E");
}

const ID_PREFIX = "~";

function encodeId(id: string): string {
    return ID_PREFIX + encodeSegment(id);
}

export function encodeSecretPath(path: SecretPath): string {
    switch (path.kind) {
        case "flat":
            return encodeSegment(path.field);
        case "nested":
            return `${encodeSegment(path.field)}/${encodeSegment(NESTED_SECRET_FIELDS[path.field])}`;
        case "map":
            return `${encodeSegment(path.field)}/${encodeId(path.id)}`;
        case "entry":
            return `${encodeSegment(path.field)}/${encodeId(path.id)}/${encodeSegment(SECRET_ENTRY_MAPS[path.field])}`;
    }
}

/** A path from its raw (still encoded) form, or `null` for anything outside the grammar. */
export function parseSecretPath(raw: string): SecretPath | null {
    const rawSegments = raw.split("/");
    let segments: string[];
    try {
        segments = rawSegments.map((segment) => decodeURIComponent(segment));
    } catch {
        return null;
    }
    if (segments.some((segment) => segment === "")) {
        return null;
    }
    const [field, second, third] = segments;
    // The id of a map or entry path: its prefixed segment, decoded once.
    const id = (): string | null => {
        const segment = rawSegments[1];
        if (!segment.startsWith(ID_PREFIX) || segment.length === ID_PREFIX.length) {
            return null;
        }
        try {
            return decodeURIComponent(segment.slice(ID_PREFIX.length));
        } catch {
            return null;
        }
    };
    if (segments.length === 1 && (FLAT_SECRET_FIELDS as readonly string[]).includes(field)) {
        return { kind: "flat", field: field as FlatSecretField };
    }
    if (
        segments.length === 2 &&
        hasOwn(NESTED_SECRET_FIELDS, field) &&
        NESTED_SECRET_FIELDS[field as NestedSecretField] === second
    ) {
        return { kind: "nested", field: field as NestedSecretField };
    }
    if (segments.length === 2 && field === "OaiCompAPIKeys") {
        const mapId = id();
        return mapId === null ? null : { kind: "map", field, id: mapId };
    }
    if (
        segments.length === 3 &&
        hasOwn(SECRET_ENTRY_MAPS, field) &&
        SECRET_ENTRY_MAPS[field as SecretEntryMap] === third
    ) {
        const entryId = id();
        return entryId === null ? null : { kind: "entry", field: field as SecretEntryMap, id: entryId };
    }
    return null;
}

/** A stable key for a path (status lookup, discards): the encoded path. */
export const secretPathKey = encodeSecretPath;

// ---------------------------------------------------------------------------------------------
// Reading and writing a plaintext record (the server's).

export function readSecret(record: Record<string, any>, path: SecretPath): string {
    let value: unknown;
    switch (path.kind) {
        case "flat":
            value = record[path.field];
            break;
        case "nested":
            value = hasOwn(record[path.field], NESTED_SECRET_FIELDS[path.field])
                ? record[path.field][NESTED_SECRET_FIELDS[path.field]]
                : undefined;
            break;
        case "map":
            value = hasOwn(record[path.field], path.id) ? record[path.field][path.id] : undefined;
            break;
        case "entry": {
            const entry = hasOwn(record[path.field], path.id) ? record[path.field][path.id] : undefined;
            value = hasOwn(entry, SECRET_ENTRY_MAPS[path.field]) ? entry[SECRET_ENTRY_MAPS[path.field]] : undefined;
            break;
        }
    }
    return typeof value === "string" ? value : "";
}

/**
 * Returns a copy of `record` with `path` set to `value`; an empty value clears a leaf and removes a
 * map entry. The containers are copied, never mutated.
 */
export function writeSecret(record: Record<string, any>, path: SecretPath, value: string): Record<string, any> {
    const next: Record<string, any> = { ...record };
    switch (path.kind) {
        case "flat":
            next[path.field] = value;
            break;
        case "nested": {
            const container = {
                ...(record[path.field] && typeof record[path.field] === "object" ? record[path.field] : {}),
            };
            container[NESTED_SECRET_FIELDS[path.field]] = value;
            next[path.field] = container;
            break;
        }
        case "map":
        case "entry": {
            const map: Record<string, unknown> = {};
            for (const [id, entry] of ownEntries(record[path.field])) {
                if (id !== path.id) {
                    defineOwn(map, id, entry);
                }
            }
            if (value !== "") {
                defineOwn(map, path.id, path.kind === "map" ? value : { [SECRET_ENTRY_MAPS[path.field]]: value });
            }
            next[path.field] = map;
            break;
        }
    }
    return next;
}

/** Whether a plain write's data carries any credential path (in any shape: a string, a masked leaf). */
export function carriesSecretPath(data: Record<string, unknown>): boolean {
    for (const field of FLAT_SECRET_FIELDS) {
        if (hasOwn(data, field)) {
            return true;
        }
    }
    for (const [field, leaf] of Object.entries(NESTED_SECRET_FIELDS)) {
        if (hasOwn(data[field], leaf)) {
            return true;
        }
    }
    return (
        SECRET_MAP_FIELDS.some((field) => hasOwn(data, field)) ||
        Object.keys(SECRET_ENTRY_MAPS).some((field) => hasOwn(data, field))
    );
}

/** `data` with every credential of `stored` copied in (the readable siblings are `data`'s). */
export function withStoredSecrets(data: Record<string, unknown>, stored: Record<string, any>): Record<string, unknown> {
    const next: Record<string, unknown> = { ...data };
    for (const field of FLAT_SECRET_FIELDS) {
        if (hasOwn(stored, field)) {
            next[field] = stored[field];
        }
    }
    for (const [field, leaf] of Object.entries(NESTED_SECRET_FIELDS)) {
        const container = { ...(data[field] && typeof data[field] === "object" ? (data[field] as object) : {}) };
        if (hasOwn(stored[field], leaf)) {
            (container as Record<string, unknown>)[leaf] = stored[field][leaf];
        }
        next[field] = container;
    }
    for (const field of [...SECRET_MAP_FIELDS, ...Object.keys(SECRET_ENTRY_MAPS)]) {
        if (hasOwn(stored, field)) {
            next[field] = stored[field];
        }
    }
    return next;
}

// ---------------------------------------------------------------------------------------------
// The masked projection.

export type MaskedLlmSecrets = Record<string, unknown> & {
    OaiCompAPIKeys: Record<string, MaskedLeaf>;
    modelPresets: Record<string, { proxyKey: MaskedLeaf }>;
    customModels: Record<string, { key: MaskedLeaf }>;
};

/** What a client reads: every credential replaced by its masked leaf, the readable siblings as they are. */
export function maskLlmSecrets(record: Record<string, any>): MaskedLlmSecrets {
    const masked: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(record)) {
        if ((FLAT_SECRET_FIELDS as readonly string[]).includes(field)) {
            masked[field] = maskedLeaf(value);
        } else if (hasOwn(NESTED_SECRET_FIELDS, field)) {
            const leaf = NESTED_SECRET_FIELDS[field as NestedSecretField];
            const container: Record<string, unknown> = {};
            for (const [key, entry] of ownEntries(value)) {
                container[key] = key === leaf ? maskedLeaf(entry) : entry;
            }
            if (!hasOwn(container, leaf)) {
                container[leaf] = maskedLeaf(undefined);
            }
            masked[field] = container;
        } else if (field === "OaiCompAPIKeys") {
            const map: Record<string, unknown> = {};
            for (const [id, entry] of ownEntries(value)) {
                defineOwn(map, id, maskedLeaf(entry));
            }
            masked[field] = map;
        } else if (hasOwn(SECRET_ENTRY_MAPS, field)) {
            const leaf = SECRET_ENTRY_MAPS[field as SecretEntryMap];
            const map: Record<string, unknown> = {};
            for (const [id, entry] of ownEntries(value)) {
                defineOwn(map, id, {
                    [leaf]: maskedLeaf(hasOwn(entry, leaf) ? (entry as Record<string, unknown>)[leaf] : undefined),
                });
            }
            masked[field] = map;
        } else {
            masked[field] = value;
        }
    }
    for (const field of FLAT_SECRET_FIELDS) {
        if (!hasOwn(masked, field)) {
            masked[field] = maskedLeaf(undefined);
        }
    }
    for (const field of ["OaiCompAPIKeys", ...Object.keys(SECRET_ENTRY_MAPS)]) {
        if (!hasOwn(masked, field)) {
            masked[field] = {};
        }
    }
    return masked as MaskedLlmSecrets;
}

/** The masked leaf of `path` in a masked record (unset when absent). */
export function maskedSecret(masked: Record<string, any> | null | undefined, path: SecretPath): MaskedLeaf {
    if (!masked) {
        return { set: false, hint: "" };
    }
    let value: unknown;
    switch (path.kind) {
        case "flat":
            value = masked[path.field];
            break;
        case "nested":
            value = hasOwn(masked[path.field], NESTED_SECRET_FIELDS[path.field])
                ? masked[path.field][NESTED_SECRET_FIELDS[path.field]]
                : undefined;
            break;
        case "map":
            value = hasOwn(masked[path.field], path.id) ? masked[path.field][path.id] : undefined;
            break;
        case "entry": {
            const entry = hasOwn(masked[path.field], path.id) ? masked[path.field][path.id] : undefined;
            value = hasOwn(entry, SECRET_ENTRY_MAPS[path.field]) ? entry[SECRET_ENTRY_MAPS[path.field]] : undefined;
            break;
        }
    }
    return isMaskedLeaf(value) ? value : { set: false, hint: "" };
}

/**
 * The readable siblings of a record (masked, plaintext, or the client mirror's fields), as the text
 * a client writes and compares: the `SECTION_FIELDS.llmSecrets` order, a credential leaf and the
 * credential maps left out, an `undefined` field left out (as JSON does).
 */
export function llmSecretSiblings(record: Record<string, any>, fields: readonly string[]): Record<string, unknown> {
    const siblings: Record<string, unknown> = {};
    for (const field of fields) {
        if ((FLAT_SECRET_FIELDS as readonly string[]).includes(field) || field === "OaiCompAPIKeys") {
            continue;
        }
        if (hasOwn(NESTED_SECRET_FIELDS, field)) {
            const leaf = NESTED_SECRET_FIELDS[field as NestedSecretField];
            const container: Record<string, unknown> = {};
            for (const [key, entry] of ownEntries(record[field])) {
                if (key !== leaf) {
                    container[key] = entry;
                }
            }
            siblings[field] = container;
            continue;
        }
        siblings[field] = record[field];
    }
    return siblings;
}
