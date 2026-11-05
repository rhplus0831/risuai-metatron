import type { Chat } from "../../../../shared/database.ts";
import {
    hypaV3DataHoldsSummaries,
    isSealedHypaV3Data,
    sealedHypaV3DataIntact,
    sealedHypaV3DataRevision,
    MEMORY_REVISION_CHATS_MAX,
    type SealedHypaV3Data,
    STRUCTURED_MEMORY_ALGORITHM,
} from "../../../../shared/structuredMemory.ts";
import { parseRevisionToken } from "../../../../shared/resources.ts";
import { readStructuredMemoryProjection, readStructuredMemoryRevisions } from "src/ts/process/structuredMemory.svelte";
import { readWithDeadline } from "src/ts/storage/readDeadline";
import { terminalNotice } from "src/ts/alert";
import { liveFeedCurrent } from "src/ts/network/eventFeed";
import { heldChatRevision, isChatBehind, type ChatRef } from "src/ts/storage/chatStore.svelte";
import { getResourceEpoch } from "src/ts/storage/resourceClient";
import { assertSaveAdmission, utf8ByteLength } from "src/ts/storage/resourceSync.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";

/**
 * Unloaded chat bodies retained by plugin full-chat reads, never installed in the chat store or
 * mutated. Sealed projections live in separate replaceable records; the underlying unsealed value
 * is unknown when a whole read overlaid it. Body reuse requires the exact held revision and a current
 * live feed. Under structured memory, reads check projection revisions on every reuse except for real
 * HypaV3 summaries. Structured-memory setters retain their stricter synchronous eligibility and never
 * match projections.
 * Callers exclude held-store work and recheck hits after every await. Returned objects are immutable
 * here; the sandbox's structured clone gives the plugin its own objects.
 *
 * One epoch, at most 64 MiB of JSON UTF-8 bytes, oldest insertion first (reuse does not reorder).
 * Projection bytes are accounted separately, without serializing a retained body again. Page hide,
 * epoch change, a terminal notice, or five minutes without a characters read clear it; the notice
 * disables it until reload. Listeners precede cold reads; clears fence pending reads through `invalidation`.
 */
type Projection = { value: SealedHypaV3Data | null; bytes: number };
type Entry = {
    revision: string;
    data: Chat;
    bytes: number;
    structured: boolean;
    underlyingKnown: boolean;
    projection: Projection;
};
export type DetachedChatCacheHit = { entry: Entry; invalidation: number };
export type DetachedChatReadHit = DetachedChatCacheHit & { data: Chat; projection: Projection };

const MAX_BYTES = 67_108_864;
const IDLE_MS = 5 * 60_000;
const entries = new Map<string, Entry>();
let bytes = 0;
let epoch: string | undefined;
let invalidation = 0;
let disabled = false;
let watching = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

const keyOf = ({ chaId, chatId }: ChatRef) => `${chaId}\u0000${chatId}`;

function clear() {
    entries.clear();
    bytes = 0;
    epoch = undefined;
    invalidation += 1;
    clearTimeout(idleTimer);
    idleTimer = undefined;
}

function checkEpoch() {
    if (epoch !== undefined && epoch !== getResourceEpoch()) clear();
}

function watchInvalidation() {
    if (watching) return;
    watching = true;
    window.addEventListener("pagehide", clear);
    terminalNotice.subscribe((notice) => {
        if (notice !== null) {
            disabled = true;
            clear();
        }
    });
}

function admitted(): boolean {
    if (disabled) return false;
    try {
        assertSaveAdmission();
        return true;
    } catch {
        return false;
    }
}

/** Called at entry and completion of full-chat `getDatabase` reads and `getChats`, hooks included. */
export function touchDetachedChatCache() {
    checkEpoch();
    clearTimeout(idleTimer);
    idleTimer = disabled ? undefined : setTimeout(clear, IDLE_MS);
}

/** Capture before a detached read; a clear during the read prevents its answer from refilling the cache. */
export function detachedChatCacheGeneration(): number {
    watchInvalidation();
    checkEpoch();
    return invalidation;
}

export function forgetDetachedChat(ref: ChatRef, expected?: Entry) {
    const key = keyOf(ref);
    const entry = entries.get(key);
    if (entry && (expected === undefined || entry === expected)) {
        bytes -= entry.bytes;
        entries.delete(key);
    }
}

/** Stores raw server JSON that the caller checked does not need a held-store snapshot. */
export function rememberDetachedChat(
    ref: ChatRef,
    read: { revision: string; data: Chat },
    structured: boolean,
    generation: number,
) {
    checkEpoch();
    if (generation !== invalidation || !admitted()) return;
    const underlyingKnown = !isSealedHypaV3Data(read.data.hypaV3Data);
    const data = underlyingKnown ? read.data : { ...read.data };
    const projection = projectionRecord(underlyingKnown ? null : (read.data.hypaV3Data as SealedHypaV3Data));
    if (!underlyingKnown) delete data.hypaV3Data;
    const size = utf8ByteLength(JSON.stringify(data)) + projection.bytes;
    forgetDetachedChat(ref);
    if (size > MAX_BYTES) return;
    watchInvalidation();
    if (generation !== invalidation || !admitted()) return;
    while (bytes + size > MAX_BYTES) {
        const oldest = entries.keys().next().value!;
        bytes -= entries.get(oldest)!.bytes;
        entries.delete(oldest);
    }
    epoch ??= getResourceEpoch();
    entries.set(keyOf(ref), { revision: read.revision, data, bytes: size, structured, underlyingKnown, projection });
    bytes += size;
}

/** Body guards also apply to an in-flight hit evicted only for capacity. */
function bodyCurrent(ref: ChatRef, hit: DetachedChatCacheHit): boolean {
    checkEpoch();
    const { entry } = hit;
    if (entry.revision !== heldChatRevision(ref)) {
        forgetDetachedChat(ref, entry);
        return false;
    }
    const structured = settings.ui.memoryAlgorithmType === STRUCTURED_MEMORY_ALGORITHM;
    return (
        hit.invalidation === invalidation &&
        epoch === getResourceEpoch() &&
        admitted() &&
        !isChatBehind(ref) &&
        liveFeedCurrent() &&
        entry.structured === structured
    );
}

/** Setter matches remain synchronous: a structured projection or pending projection check cannot match. */
export function detachedChatCacheHitCurrent(ref: ChatRef, hit: DetachedChatCacheHit): boolean {
    return bodyCurrent(ref, hit) && (!hit.entry.structured || hypaV3Owned(hit.entry));
}

function hypaV3Owned(entry: Entry): boolean {
    return entry.underlyingKnown && !entry.projection.value && hypaV3DataHoldsSummaries(entry.data.hypaV3Data);
}

function projectionRecord(value: SealedHypaV3Data | null): Projection {
    return { value, bytes: value === null ? 0 : utf8ByteLength(JSON.stringify({ hypaV3Data: value })) };
}

function readHit(hit: DetachedChatCacheHit): DetachedChatReadHit {
    const { entry } = hit;
    return {
        ...hit,
        projection: entry.projection,
        data: entry.projection.value ? { ...entry.data, hypaV3Data: entry.projection.value } : entry.data,
    };
}

/** Rechecks body guards and the exact projection record this read validated. */
export function detachedChatReadHitCurrent(ref: ChatRef, hit: DetachedChatReadHit): boolean {
    return bodyCurrent(ref, hit) && hit.projection === hit.entry.projection;
}

/** Replace only the projection record; previously returned bodies and projected copies stay unchanged. */
function replaceProjection(ref: ChatRef, hit: DetachedChatReadHit, value: SealedHypaV3Data | null): boolean {
    if (!detachedChatReadHitCurrent(ref, hit) || entries.get(keyOf(ref)) !== hit.entry) return false;
    const entry = hit.entry;
    const projection = projectionRecord(value);
    const difference = projection.bytes - entry.projection.bytes;
    entry.projection = projection;
    entry.bytes += difference;
    bytes += difference;
    while (bytes > MAX_BYTES) {
        const oldest = entries.keys().next().value!;
        bytes -= entries.get(oldest)!.bytes;
        entries.delete(oldest);
    }
    return true;
}

/**
 * Read-path lookup, separate from setter matching. Every reuse of a structured non-HypaV3 body
 * checks batched memory revisions, with no loaded-chat window or shared held-chat refresh state.
 * Refusals, deadlines and failed fences miss, leaving the caller to read the whole chat again.
 */
export async function cachedDetachedChatsForRead(
    refs: readonly ChatRef[],
    deadlineMs: number,
): Promise<Map<ChatRef, DetachedChatReadHit>> {
    checkEpoch();
    const hits = new Map<ChatRef, DetachedChatReadHit>();
    const pending: { ref: ChatRef; hit: DetachedChatReadHit }[] = [];
    for (const ref of refs) {
        const entry = entries.get(keyOf(ref));
        if (!entry) continue;
        const hit = readHit({ entry, invalidation });
        if (!bodyCurrent(ref, hit)) continue;
        if (!entry.structured || hypaV3Owned(entry)) hits.set(ref, hit);
        else pending.push({ ref, hit });
    }
    if (pending.length === 0) return hits;
    try {
        const checked = await readWithDeadline(deadlineMs, "The memory refresh timed out", async (signal) => {
            const checked = new Map<ChatRef, DetachedChatReadHit>();
            for (let start = 0; start < pending.length; start += MEMORY_REVISION_CHATS_MAX) {
                if (signal.aborted) break;
                const asked = pending.slice(start, start + MEMORY_REVISION_CHATS_MAX);
                const answer = await readStructuredMemoryRevisions(
                    asked.map(({ ref }) => ref),
                    signal,
                );
                if (signal.aborted || answer.outcome !== "ok") continue;
                for (const [index, { ref, hit }] of asked.entries()) {
                    if (signal.aborted) break;
                    if (!detachedChatReadHitCurrent(ref, hit) || entries.get(keyOf(ref)) !== hit.entry) continue;
                    const revision = answer.value.revisions[index];
                    const held = sealedHypaV3DataRevision(hit.projection.value);
                    if (revision === null) {
                        if (!hit.entry.underlyingKnown) continue;
                        if (hit.projection.value && !replaceProjection(ref, hit, null)) continue;
                    } else if (revision !== held) {
                        const projection = await readStructuredMemoryProjection(ref, signal);
                        if (signal.aborted || projection.outcome !== "ok") continue;
                        const value = projection.value.hypaV3Data;
                        const token = parseRevisionToken(sealedHypaV3DataRevision(value));
                        const chat = parseRevisionToken(hit.entry.revision);
                        const heldToken = parseRevisionToken(held);
                        if (
                            !sealedHypaV3DataIntact(value) ||
                            !token ||
                            !chat ||
                            token.epoch !== chat.epoch ||
                            token.seq !== chat.seq ||
                            (heldToken?.epoch === token.epoch &&
                                heldToken.seq === token.seq &&
                                token.revision <= heldToken.revision) ||
                            settings.ui.memoryAlgorithmType !== STRUCTURED_MEMORY_ALGORITHM ||
                            !replaceProjection(ref, hit, value)
                        )
                            continue;
                    }
                    checked.set(ref, readHit(hit));
                }
            }
            return checked;
        });
        for (const [ref, hit] of checked) {
            if (detachedChatReadHitCurrent(ref, hit)) hits.set(ref, hit);
        }
    } catch {
        // Never serve an unchecked projection after a failed refresh or deadline.
    }
    return hits;
}

export function cachedDetachedChat(ref: ChatRef): DetachedChatCacheHit | undefined {
    checkEpoch();
    const entry = entries.get(keyOf(ref));
    if (!entry) return undefined;
    const hit = { entry, invalidation };
    return detachedChatCacheHitCurrent(ref, hit) ? hit : undefined;
}

/** Number of retained copies, after dropping any previous epoch. */
export function detachedChatCacheSize(): number {
    checkEpoch();
    return entries.size;
}
