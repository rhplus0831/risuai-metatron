import type { Chat } from "../../../../shared/database.ts";
import {
    hypaV3DataHoldsSummaries,
    isSealedHypaV3Data,
    STRUCTURED_MEMORY_ALGORITHM,
} from "../../../../shared/structuredMemory.ts";
import { terminalNotice } from "src/ts/alert";
import { liveFeedCurrent } from "src/ts/network/eventFeed";
import { heldChatRevision, isChatBehind, type ChatRef } from "src/ts/storage/chatStore.svelte";
import { getResourceEpoch } from "src/ts/storage/resourceClient";
import { assertSaveAdmission, utf8ByteLength } from "src/ts/storage/resourceSync.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";

/**
 * Plain unloaded chat copies retained by the plugin `getDatabase` path, never installed in the chat
 * store or mutated. Reuse requires the exact held revision and a current live feed; under structured
 * memory only a HypaV3-owned value is stable, since projections can change without a chat revision.
 * The caller excludes values needing a held-store snapshot and rechecks hits after every await.
 * Copies go directly to the sandbox's structured clone, which gives the plugin its own objects.
 *
 * One epoch, at most 64 MiB of JSON UTF-8 bytes, oldest insertion first (reuse does not reorder).
 * Page hide, epoch change, a terminal notice, or five minutes without a characters read clear it;
 * the notice disables it until reload. Clears fence pending reads and hits through `invalidation`.
 */
type Entry = { revision: string; data: Chat; bytes: number; structured: boolean };
export type DetachedChatCacheHit = { entry: Entry; invalidation: number };

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

/** Called at entry and completion of every `getDatabase` that includes characters, hooks included. */
export function touchDetachedChatCache() {
    checkEpoch();
    clearTimeout(idleTimer);
    idleTimer = disabled ? undefined : setTimeout(clear, IDLE_MS);
}

/** Capture before a detached read; a clear during the read prevents its answer from refilling the cache. */
export function detachedChatCacheGeneration(): number {
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
    const size = utf8ByteLength(JSON.stringify(read.data));
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
    entries.set(keyOf(ref), { ...read, bytes: size, structured });
    bytes += size;
}

/** Rechecks an in-flight hit even if capacity eviction has since removed its retained entry. */
export function detachedChatCacheHitCurrent(ref: ChatRef, hit: DetachedChatCacheHit): boolean {
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
        entry.structured === structured &&
        (!structured || (hypaV3DataHoldsSummaries(entry.data.hypaV3Data) && !isSealedHypaV3Data(entry.data.hypaV3Data)))
    );
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
