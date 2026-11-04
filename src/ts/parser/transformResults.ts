/**
 * The tab's bounded LRU of confirmed transform text and server answers, keyed by the call's identity: filled by
 * `transformClient.ts`, cleared by `src/ts/storage/resourceClient.ts` on an epoch change. A read or a confirmation
 * makes an entry the most recent; a write evicts the least recent until at most 2,048 entries and an 8 MiB
 * estimate (two bytes per character of the identity, server key, source, result, and message key, plus 64 per
 * entry) remain, and an answer larger than that alone is not kept.
 * Every write is conditional on the entry version its caller read, so an overlapping older answer cannot overwrite
 * a newer entry. Effects (emotions) are never retained.
 */

/** Confirmed transform text for this tab; effects are never retained here. */
export type TransformResultEntry = Readonly<{ key: string; source: string; text: string; version: symbol }>;

type Entry = TransformResultEntry & { message: string | null; bytes: number };
const MAX_ENTRIES = 2_048;
const MAX_BYTES = 8 * 1024 * 1024;
const entries = new Map<string, Entry>();
let bytes = 0;
let generation = 0;

/** The generation a capture records: `transformClient.ts` writes an answer here only while it is unchanged. */
export function transformResultsGeneration(): number {
    return generation;
}

/** GUI resets invalidate pending answers but keep confirmed text across chat switches. */
export function advanceTransformResultsGeneration(): void {
    generation += 1;
}

/** Clears text and pending-answer validity on an epoch change, or a future sign-out. */
export function clearTransformResults(): void {
    entries.clear();
    bytes = 0;
    advanceTransformResultsGeneration();
}

function remove(identity: string): void {
    const entry = entries.get(identity);
    if (!entry) return;
    bytes -= entry.bytes;
    entries.delete(identity);
}

/** Re-render invalidates every source, mode, and viewport of this message. */
export function dropMessageTransformResults(message: string): void {
    for (const [identity, entry] of entries) {
        if (entry.message === message) remove(identity);
    }
}

/** The hash only selects a slot; a hit requires the exact source too. */
export function getTransformResult(identity: string, source: string): TransformResultEntry | undefined {
    const entry = entries.get(identity);
    if (!entry || entry.source !== source) return;
    entries.delete(identity);
    entries.set(identity, entry);
    return entry;
}

/** A bypass still captures the entry's version for a conditional replacement, without reusing its text. */
export function transformResultVersion(identity: string): symbol | undefined {
    return entries.get(identity)?.version;
}

/** A `same` answer for the entry version the caller read: that entry becomes the most recent; else nothing. */
export function confirmTransformResult(identity: string, version: symbol): void {
    const entry = entries.get(identity);
    if (entry?.version === version) getTransformResult(identity, entry.source);
}

/** An overlapping answer can only replace or remove the version it started with. */
export function replaceTransformResult(
    identity: string,
    version: symbol | undefined,
    message: string | null,
    result?: { key: string; source: string; text: string },
): void {
    if (entries.get(identity)?.version !== version) return;
    remove(identity);
    if (!result) return;
    const size =
        2 * (identity.length + result.key.length + result.source.length + result.text.length + (message?.length ?? 0)) +
        64;
    if (size > MAX_BYTES) return;
    while (entries.size >= MAX_ENTRIES || bytes + size > MAX_BYTES) {
        remove(entries.keys().next().value!);
    }
    entries.set(identity, {
        key: result.key,
        source: result.source,
        text: result.text,
        version: Symbol(),
        message,
        bytes: size,
    });
    bytes += size;
}
