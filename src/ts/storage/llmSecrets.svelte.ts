import { SECTION_FIELDS } from "../../../shared/sections.ts";
import {
    FLAT_SECRET_FIELDS,
    NESTED_SECRET_FIELDS,
    SECRET_ENTRY_MAPS,
    llmSecretSiblings,
    type SecretEntryMap,
    maskedSecret,
    secretPathKey,
    type MaskedLeaf,
    type MaskedLlmSecrets,
    type SecretPath,
} from "../../../shared/llmSecrets.ts";

/**
 * The tab's view of the write-only `llmSecrets` record (Phase 5 slice 7b, `shared/llmSecrets.ts`):
 * the masked record the server last answered (each credential's `{ set, hint }`; the readable
 * siblings are held in the `llmSecrets` record like any section field, the credential fields there
 * are always `""`), a version per credential path (bumped whenever its acknowledged status changes, so
 * a view that depends on a key refreshes when it is replaced), and the queue of credential writes
 * the save adapter sends (`resourceSync.svelte.ts`) through `/api/llm-secrets/*`. The status a view
 * shows is the masked record with the queued writes applied over it.
 */
export type SecretRequest =
    | { kind: "put"; path: SecretPath; value: string }
    | { kind: "copy"; from: string; to: string }
    /**
     * Removes the entry of a deleted preset or custom model: sent only once the owner's deletion
     * is saved, and dropped if the owner is back (a conflict discarded the deletion).
     */
    | { kind: "cleanup"; path: Extract<SecretPath, { kind: "entry" }> };

export type QueuedSecretOp = { id: number; request: SecretRequest };

export type SecretStatus = MaskedLeaf & {
    /** A queued write of this path has not been acknowledged yet. */
    pending: boolean;
};

export const llmSecretState: {
    masked: MaskedLlmSecrets | null;
    versions: Record<string, number>;
    queue: QueuedSecretOp[];
} = $state({ masked: null, versions: {}, queue: [] });

let nextOpId = 1;
let scheduler: () => void = () => {};

/** The save adapter's hook: called whenever a write is queued. */
export function setSecretScheduler(schedule: () => void) {
    scheduler = schedule;
}

function enqueue(request: SecretRequest): number {
    const id = nextOpId++;
    llmSecretState.queue.push({ id, request });
    scheduler();
    return id;
}

/** Sets a credential (an empty value clears it). The plaintext lives only in the queue until it is sent. */
export function setSecret(path: SecretPath, value: string): number {
    return enqueue({ kind: "put", path, value });
}

export function clearSecret(path: SecretPath): number {
    return setSecret(path, "");
}

/** Gives preset `to` a copy of preset `from`'s `proxyKey` (on the server; the tab never reads it). */
export function copyPresetSecret(from: string, to: string): number {
    return enqueue({ kind: "copy", from, to });
}

/** The entry of a preset or custom model the tab just deleted (not a clear of a live one). */
export function deleteEntrySecret(field: SecretEntryMap, id: string): number {
    return enqueue({ kind: "cleanup", path: { kind: "entry", field, id } });
}

export function deletePresetSecret(id: string): number {
    return deleteEntrySecret("presets", id);
}

const presetPath = (id: string): SecretPath => ({ kind: "entry", field: "presets", id });

/** The paths a queued write changes. */
export function secretOpTarget(request: SecretRequest): SecretPath {
    return request.kind === "copy" ? presetPath(request.to) : request.path;
}

/**
 * The status of `path`: the acknowledged masked leaf with the queued writes applied over it in
 * queue order (as the server applies them), so a copy reads its source as it is at that point.
 */
export function secretStatus(path: SecretPath): SecretStatus {
    const wanted = secretPathKey(path);
    const overlay = new Map<string, SecretStatus>();
    const current = (target: SecretPath): SecretStatus =>
        overlay.get(secretPathKey(target)) ?? { ...maskedSecret(llmSecretState.masked, target), pending: false };
    for (const op of llmSecretState.queue) {
        const request = op.request;
        if (request.kind === "put") {
            overlay.set(secretPathKey(request.path), { set: request.value !== "", hint: "", pending: true });
        } else if (request.kind === "cleanup") {
            overlay.set(secretPathKey(request.path), { set: false, hint: "", pending: true });
        } else {
            const source = current(presetPath(request.from));
            overlay.set(secretPathKey(presetPath(request.to)), { set: source.set, hint: source.hint, pending: true });
        }
    }
    return overlay.get(wanted) ?? current(path);
}

export function isSecretSet(path: SecretPath): boolean {
    return secretStatus(path).set;
}

/** Bumped each time the acknowledged status of `path` changes. */
export function secretVersion(path: SecretPath): number {
    return llmSecretState.versions[secretPathKey(path)] ?? 0;
}

/** Every path a masked record names (the flat and nested leaves, the map and entry ids). */
function pathsOf(masked: MaskedLlmSecrets | null): SecretPath[] {
    const paths: SecretPath[] = [
        ...FLAT_SECRET_FIELDS.map((field): SecretPath => ({ kind: "flat", field })),
        ...(Object.keys(NESTED_SECRET_FIELDS) as (keyof typeof NESTED_SECRET_FIELDS)[]).map((field): SecretPath => ({
            kind: "nested",
            field,
        })),
    ];
    if (masked) {
        for (const id of Object.keys(masked.OaiCompAPIKeys ?? {})) {
            paths.push({ kind: "map", field: "OaiCompAPIKeys", id });
        }
        for (const field of Object.keys(SECRET_ENTRY_MAPS) as (keyof typeof SECRET_ENTRY_MAPS)[]) {
            for (const id of Object.keys((masked as Record<string, any>)[field] ?? {})) {
                paths.push({ kind: "entry", field, id });
            }
        }
    }
    return paths;
}

/**
 * Adopts the masked record the server answered (boot, an acknowledgement, a reread). A path's
 * version is bumped when its status changed, and also for each path in `invalidate` (the target of
 * an acknowledged write: two keys can share a status) or, with `"all"`, for every path (a record
 * changed elsewhere, whose keys may have been replaced with the same status). Boot bumps nothing.
 */
export function setMaskedSecrets(masked: MaskedLlmSecrets, invalidate: SecretPath[] | "all" = []) {
    const before = llmSecretState.masked;
    const forced = new Set(invalidate === "all" ? [] : invalidate.map(secretPathKey));
    const seen = new Set<string>();
    for (const path of [...pathsOf(before), ...pathsOf(masked), ...(invalidate === "all" ? [] : invalidate)]) {
        const key = secretPathKey(path);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        const a = maskedSecret(before, path);
        const b = maskedSecret(masked, path);
        if (before !== null && (invalidate === "all" || forced.has(key) || a.set !== b.set || a.hint !== b.hint)) {
            llmSecretState.versions[key] = (llmSecretState.versions[key] ?? 0) + 1;
        }
    }
    llmSecretState.masked = masked;
}

/** Removes an acknowledged or dropped write from the queue. */
export function removeSecretOp(id: number) {
    const index = llmSecretState.queue.findIndex((op) => op.id === id);
    if (index !== -1) {
        llmSecretState.queue.splice(index, 1);
    }
}

/**
 * The fields the tab's `llmSecrets` record holds for a masked record: the readable siblings as they
 * are, every flat credential `""`, each container's credential leaf `""`, `OaiCompAPIKeys` empty.
 */
export function mirrorFields(masked: Record<string, any>): Record<string, unknown> {
    const fields = SECTION_FIELDS.llmSecrets;
    const out: Record<string, unknown> = llmSecretSiblings(masked, fields);
    for (const field of FLAT_SECRET_FIELDS) {
        if ((fields as readonly string[]).includes(field)) {
            out[field] = "";
        }
    }
    for (const [field, leaf] of Object.entries(NESTED_SECRET_FIELDS)) {
        out[field] = { ...((out[field] as object) ?? {}), [leaf]: "" };
    }
    out.OaiCompAPIKeys = {};
    return out;
}

/** The text the save adapter writes and compares for the record: its readable siblings only. */
export function llmSecretsText(record: Record<string, any>): string {
    return JSON.stringify(llmSecretSiblings(record, SECTION_FIELDS.llmSecrets));
}
