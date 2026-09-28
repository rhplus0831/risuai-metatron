import { tick } from "svelte";
import { get } from "svelte/store";
import { v4 as uuidv4 } from "uuid";
import {
    RESOURCE_KIND,
    ROOT_EXCLUDED_KEYS,
    type ResourceBatchResult,
    type ResourceReadKindsResult,
    SINGLETON_RESOURCE_ID,
} from "../../../shared/resources.ts";
import { language } from "src/lang";
import { alertError, alertNormal, alertNormalWait } from "../alert";
import { DBState, selectedCharID } from "../stores.svelte";
import type { character, Database, groupChat } from "./database.svelte";
import {
    applyBatchText,
    readRefs,
    ResourceConflictError,
    ResourceEpochMismatchError,
    ResourceRequestError,
    setEpochMismatchListener,
    setResourceEpoch,
} from "./resourceClient";

/**
 * The write adapter of PLAN invariant 2 for Phase 1: `DBState.db` stays the live model, and this
 * module writes it back to the server resources per collection (`root`, `presets`, `modules`,
 * `plugins`, `pluginStorage`, one `characters` record per `chaId`).
 *
 * - Watchers mark collections dirty (the selected character, the root fields, and so on); writers
 *   that change a character while it is not selected call `markCharactersDirty`.
 * - A cycle serializes each dirty collection and skips it when the text equals what the server
 *   holds (`persisted`), so hydration and no-op re-renders never become writes. Character membership
 *   is diffed by `chaId` every cycle: a new id is created, a vanished one deleted.
 * - One batch per cycle, one cycle in flight. A key stays dirty if it was marked again while its
 *   batch was in flight.
 * - A 409 reloads the conflicting records into the mirror (another tab or device wrote them) and
 *   shows `resourceReloaded` once per episode; a 412 (the server was restored) stops saving and
 *   reloads the page. The character a generation runs on is not swapped out under it: its reload
 *   is deferred and runs, inside the cycle, once the generation ends.
 *
 * Transport state here is plain (no runes); only `saving` is reactive.
 */

type Collection = "root" | "presets" | "modules" | "plugins" | "pluginStorage";

const COLLECTION_FIELDS = {
    presets: "botPresets",
    modules: "modules",
    plugins: "plugins",
    pluginStorage: "pluginCustomStorage",
} as const satisfies Record<Exclude<Collection, "root">, keyof Database>;

const COLLECTIONS: readonly Collection[] = ["root", "presets", "modules", "plugins", "pluginStorage"];
const DEBOUNCE_MS = 500;
const MAX_BACKOFF_MS = 30_000;
/** Largest batch body the server accepts (its global body limit is 100 MiB), in UTF-8 bytes. */
const MAX_BATCH_BYTES = 100 * 1024 * 1024 - 64 * 1024;
const MAX_BATCH_OPERATIONS = 5000;
/** Bytes of the batch envelope around the operations: `{"ops":[` and `]}`. */
const BATCH_FRAME_BYTES = 10;

const excludedRootKeys = new Set<string>(ROOT_EXCLUDED_KEYS);

export const saving = $state({ state: false });

const recordKey = (kind: string, id: string) => `${kind}\u0000${id}`;
const collectionKey = (collection: Collection) => recordKey(collection, SINGLETON_RESOURCE_ID);
const characterPrefix = recordKey(RESOURCE_KIND.characters, "");
const characterKey = (id: string) => recordKey(RESOURCE_KIND.characters, id);

/** What the server holds for each record this client knows: `<kind>\0<id>` → revision and JSON text. */
const persisted = new Map<string, { revision: string; text: string }>();
/** Dirty record keys → the generation of their latest mark. */
const dirty = new Map<string, number>();
/**
 * Record keys → the highest generation known to be settled: saved, unchanged, or discarded by a
 * conflict. `flushResources` waits until every key dirty at its call is settled at that generation.
 */
const acked = new Map<string, number>();
let generation = 0;
/** Generation of the latest character membership change (add, remove, re-key) and of the last one saved. */
let membershipGeneration = 0;
let membershipAcked = 0;
let started = false;
let halted = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let failures = 0;
/** The last cycle's failure that a retry may fix (network, 5xx, 429); retried with backoff. */
let lastError: unknown = null;
/** A failure retrying cannot fix (400, 413); no retry until the next change. */
let permanentError: unknown = null;
/** Keys whose local edits a conflict discarded, with a sequence number of the discard. */
const discarded = new Map<string, number>();
let discardSequence = 0;
/**
 * Characters whose conflict reload waits until the generation running on them ends. They are
 * neither written nor deleted meanwhile; the next cycle after the generation reloads them.
 */
const deferredCharacters = new Set<string>();
let generatingCharacter: () => string | null = () => null;
let noticeShown = false;
type RemoteChangeListener = (kind: string, id: string) => void;
const remoteChangeListeners = new Set<RemoteChangeListener>();

/** Records what the server holds, from the boot read. Call before `setDatabase` touches the data. */
export function seedResources(result: ResourceReadKindsResult) {
    setResourceEpoch(result.epoch);
    persisted.clear();
    for (const [kind, records] of Object.entries(result.kinds)) {
        for (const record of records) {
            persisted.set(recordKey(kind, record.id), { revision: record.revision, text: JSON.stringify(record.data) });
        }
    }
}

/**
 * Tells the adapter which character (by `chaId`) a generation is running on, or null. A conflict
 * on that character is not applied to the mirror while the check names it.
 */
export function setGeneratingCharacter(check: () => string | null) {
    generatingCharacter = check;
}

/**
 * Registers a listener called after a server record replaced the mirror's copy (a conflict reload
 * or a deferred reload): another tab or device wrote it, so caches derived from it may be stale.
 */
export function onRemoteRecordApplied(listener: RemoteChangeListener): () => void {
    remoteChangeListeners.add(listener);
    return () => {
        remoteChangeListeners.delete(listener);
    };
}

function markKey(key: string) {
    generation += 1;
    dirty.set(key, generation);
    permanentError = null;
    schedule();
}

function markMembership() {
    generation += 1;
    membershipGeneration = generation;
    permanentError = null;
    schedule();
}

function settle(key: string, marked: number) {
    if ((acked.get(key) ?? 0) < marked) {
        acked.set(key, marked);
    }
}

/** Whether a character's reload must still wait: it was deferred and its generation is still running. */
function isBlockedByGeneration(id: string): boolean {
    return deferredCharacters.has(id) && generatingCharacter() === id;
}

function isBlockedKey(key: string): boolean {
    return key.startsWith(characterPrefix) && isBlockedByGeneration(key.slice(characterPrefix.length));
}

/** Whether anything waits to be saved or reloaded, not counting characters whose generation still runs. */
function hasPendingWork(): boolean {
    if (membershipGeneration > membershipAcked) {
        return true;
    }
    for (const id of deferredCharacters) {
        if (!isBlockedByGeneration(id)) {
            return true;
        }
    }
    for (const key of dirty.keys()) {
        if (!isBlockedKey(key)) {
            return true;
        }
    }
    return false;
}

/** Marks characters for the next compare-and-save; for writers that change a non-selected character. */
export function markCharactersDirty(ids: readonly string[] | "all") {
    const list = ids === "all" ? (DBState.db.characters ?? []).map((character) => character?.chaId) : ids;
    for (const id of list) {
        if (typeof id === "string") {
            markKey(characterKey(id));
        }
    }
}

/** `markCharactersDirty` for the character at an index of `DBState.db.characters`. */
export function markCharacterDirtyAt(index: number) {
    const id = DBState.db.characters?.[index]?.chaId;
    if (typeof id === "string") {
        markCharactersDirty([id]);
    }
}

function schedule(delay = DEBOUNCE_MS) {
    if (!started || halted) {
        return;
    }
    if (timer) {
        clearTimeout(timer);
    }
    timer = setTimeout(() => {
        timer = null;
        void runCycle();
    }, delay);
}

function projectCollection(collection: Collection): string | undefined {
    const db = DBState.db;
    if (collection === "root") {
        const root: Record<string, unknown> = {};
        for (const key in db) {
            if (!excludedRootKeys.has(key)) {
                root[key] = $state.snapshot((db as unknown as Record<string, unknown>)[key]);
            }
        }
        return JSON.stringify(root);
    }
    if (collection === "pluginStorage") {
        // Plugins choose these keys. Serialized straight from the proxy: `$state.snapshot` assigns
        // `copy[key] = ...`, which would drop an own `__proto__` key.
        return JSON.stringify(db.pluginCustomStorage);
    }
    return JSON.stringify($state.snapshot(db[COLLECTION_FIELDS[collection]]));
}

/**
 * A character as stored: without the per-chat streaming flags, which are client-only state
 * (`setDatabase` resets them on every load) and would otherwise make every booting tab rewrite a
 * character another tab is streaming into.
 */
function projectCharacter(character: character | groupChat): string {
    const copy = $state.snapshot(character) as character | groupChat;
    if (!Array.isArray(copy.chats)) {
        copy.chats = [];
    }
    for (const chat of copy.chats) {
        delete chat.isStreaming;
        delete chat.activeStreamingDisplayOptimizationMode;
    }
    return JSON.stringify(copy);
}

/** The text a record has after a server copy was written into the mirror (its key order, not the server's). */
function projectRecord(kind: string, id: string): string | undefined {
    if (kind === RESOURCE_KIND.characters) {
        const character = DBState.db.characters?.find((entry) => entry?.chaId === id);
        return character ? projectCharacter(character) : undefined;
    }
    return COLLECTIONS.includes(kind as Collection) ? projectCollection(kind as Collection) : undefined;
}

type PendingOp = {
    key: string;
    kind: string;
    id: string;
    baseRevision: string | null;
    text: string | null;
    /** The operation's JSON inside the batch body. */
    part: string;
    /** UTF-8 size of `part`. */
    bytes: number;
};

/** UTF-8 size of a string (JSON text is well-formed, so surrogates come in pairs). */
export function utf8ByteLength(text: string): number {
    let bytes = 0;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code < 0x80) {
            bytes += 1;
        } else if (code < 0x800) {
            bytes += 2;
        } else if (code >= 0xd800 && code <= 0xdbff) {
            bytes += 4;
            index += 1;
        } else {
            bytes += 3;
        }
    }
    return bytes;
}

function pendingOp(op: Omit<PendingOp, "part" | "bytes">): PendingOp {
    const head = `{"kind":${JSON.stringify(op.kind)},"id":${JSON.stringify(op.id)},"baseRevision":${JSON.stringify(op.baseRevision)}`;
    const part = op.text === null ? `${head},"delete":true}` : `${head},"data":${op.text}}`;
    return { ...op, part, bytes: utf8ByteLength(part) };
}

/** Gives a duplicate `chaId` a new id (as `assignIds` does at boot) so no record overwrites another. */
function dedupeCharacterIds(characters: (character | groupChat)[]) {
    const seen = new Set<string>();
    for (const character of characters) {
        if (!character) {
            continue;
        }
        if (typeof character.chaId !== "string" || seen.has(character.chaId)) {
            character.chaId = uuidv4();
        }
        seen.add(character.chaId);
    }
}

/** Builds this cycle's operations and the generation each dirty key had when it was captured. */
function collectOperations(): { ops: PendingOp[]; captured: Map<string, number>; membership: number } {
    const captured = new Map(dirty);
    const membership = membershipGeneration;
    const ops: PendingOp[] = [];
    for (const collection of COLLECTIONS) {
        const key = collectionKey(collection);
        if (!captured.has(key)) {
            continue;
        }
        const text = projectCollection(collection);
        const current = persisted.get(key);
        // An absent collection (e.g. no plugin storage yet) has no record to write.
        if (text !== undefined && text !== current?.text) {
            ops.push(
                pendingOp({
                    key,
                    kind: collection,
                    id: SINGLETON_RESOURCE_ID,
                    baseRevision: current?.revision ?? null,
                    text,
                }),
            );
        }
    }

    const characters = DBState.db.characters ?? [];
    dedupeCharacterIds(characters);
    const present = new Set<string>();
    for (const character of characters) {
        if (!character) {
            continue;
        }
        const id = character.chaId;
        present.add(id);
        const key = characterKey(id);
        if (deferredCharacters.has(id)) {
            continue;
        }
        const current = persisted.get(key);
        if (current && !captured.has(key)) {
            continue;
        }
        const text = projectCharacter(character);
        if (text !== current?.text) {
            ops.push(
                pendingOp({ key, kind: RESOURCE_KIND.characters, id, baseRevision: current?.revision ?? null, text }),
            );
        }
    }
    for (const [key, current] of persisted) {
        if (key.startsWith(characterPrefix)) {
            const id = key.slice(characterPrefix.length);
            if (!present.has(id) && !deferredCharacters.has(id)) {
                ops.push(
                    pendingOp({ key, kind: RESOURCE_KIND.characters, id, baseRevision: current.revision, text: null }),
                );
            }
        }
    }
    return { ops, captured, membership };
}

function batchBody(ops: readonly PendingOp[]): string {
    return `{"ops":[${ops.map((op) => op.part).join(",")}]}`;
}

/**
 * Splits operations into batches under the operation and byte caps, measured in UTF-8 bytes as the
 * server counts them (only a boot pass needs more than one batch).
 */
export function splitBatches<T extends { bytes: number }>(ops: readonly T[]): T[][] {
    const batches: T[][] = [];
    let current: T[] = [];
    let bytes = BATCH_FRAME_BYTES;
    for (const op of ops) {
        const size = op.bytes + 1;
        if (current.length > 0 && (current.length >= MAX_BATCH_OPERATIONS || bytes + size > MAX_BATCH_BYTES)) {
            batches.push(current);
            current = [];
            bytes = BATCH_FRAME_BYTES;
        }
        current.push(op);
        bytes += size;
    }
    if (current.length > 0) {
        batches.push(current);
    }
    return batches;
}

function runCycle(): Promise<void> {
    if (inFlight) {
        return inFlight;
    }
    inFlight = (async () => {
        try {
            await cycle();
            failures = 0;
            lastError = null;
            permanentError = null;
        } catch (error) {
            lastError = error;
            handleCycleError(error);
        } finally {
            inFlight = null;
            saving.state = false;
            if (!halted && !permanentError && (hasPendingWork() || lastError)) {
                schedule(lastError ? Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 5)) : DEBOUNCE_MS);
            }
        }
    })();
    return inFlight;
}

async function cycle() {
    if (halted || !DBState.db?.characters) {
        return;
    }
    await reloadDeferredCharacters();
    const { ops, captured, membership } = collectOperations();
    if (ops.length > 0) {
        saving.state = true;
        for (const batch of splitBatches(ops)) {
            if (batch.length === 1 && batch[0].bytes + BATCH_FRAME_BYTES > MAX_BATCH_BYTES) {
                throw new ResourceRequestError(413, `${batch[0].kind} ${batch[0].id} is too large to save`);
            }
            let result: ResourceBatchResult;
            try {
                result = await applyBatchText(batchBody(batch));
            } catch (error) {
                if (error instanceof ResourceConflictError) {
                    await recoverFromConflict(error, batch);
                    return;
                }
                throw error;
            }
            batch.forEach((op, index) => {
                const revision = result.results[index]?.revision;
                if (op.text === null || revision === null || revision === undefined) {
                    persisted.delete(op.key);
                } else {
                    persisted.set(op.key, { revision, text: op.text });
                }
            });
        }
    }
    for (const [key, marked] of captured) {
        if (key.startsWith(characterPrefix) && deferredCharacters.has(key.slice(characterPrefix.length))) {
            // Not saved: its reload waits for the running generation.
            continue;
        }
        settle(key, marked);
        if (dirty.get(key) === marked) {
            dirty.delete(key);
        }
    }
    if (membershipAcked < membership) {
        membershipAcked = membership;
    }
}

function handleCycleError(error: unknown) {
    if (error instanceof ResourceEpochMismatchError) {
        void haltForRestore();
        return;
    }
    failures += 1;
    if (error instanceof ResourceRequestError && (error.status === 413 || error.status === 400)) {
        // Retrying the same data cannot succeed; report it once and wait for the next change.
        if (!permanentError) {
            alertError(error.message);
        }
        permanentError = error;
        lastError = null;
        return;
    }
    if (failures === 5) {
        alertError(error instanceof Error ? error : String(error));
    } else {
        console.error("[Save]", error);
    }
}

/**
 * The server data was replaced (restore or import): every revision here is void. Also reached from
 * `resourceClient` for a 412 or a changed epoch on any other resource request (inlays, permissions).
 */
async function haltForRestore() {
    if (halted) {
        return;
    }
    halted = true;
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    await alertNormalWait(language.resourceRestored);
    location.reload();
}

type RemoteItem = { kind: string; id: string; revision: string | null; data: unknown };

/**
 * Puts a server record into the mirror and records it as the saved state: the text is taken from
 * the hydrated mirror (its own key order), so the watcher that fires next compares equal and
 * nothing is echoed back. The local edit of that record counts as discarded.
 */
function acceptRemote(item: RemoteItem) {
    const key = recordKey(item.kind, item.id);
    applyToMirror(item.kind, item.id, item.revision === null ? null : item.data);
    if (item.revision === null) {
        persisted.delete(key);
    } else {
        persisted.set(key, {
            revision: item.revision,
            text: projectRecord(item.kind, item.id) ?? JSON.stringify(item.data),
        });
    }
    discardSequence += 1;
    discarded.set(key, discardSequence);
    settle(key, generation);
    dirty.delete(key);
    for (const listener of remoteChangeListeners) {
        try {
            listener(item.kind, item.id);
        } catch (error) {
            console.error("[Save]", error);
        }
    }
}

function showReloadedNotice() {
    if (noticeShown) {
        return;
    }
    noticeShown = true;
    alertNormal(language.resourceReloaded);
    setTimeout(() => {
        noticeShown = false;
    }, 10_000);
}

/**
 * Another tab or device wrote records this batch was based on. Reads them back and puts the server
 * version into the mirror, unless the server already holds exactly what this client sent (a retry
 * after a lost response). The rest of the batch goes out in the next cycle.
 */
async function recoverFromConflict(error: ResourceConflictError, batch: readonly PendingOp[]) {
    const sent = new Map(batch.map((op) => [op.key, op.text]));
    const refs = error.conflicts.map(({ kind, id }) => ({ kind, id }));
    const read = await readRefs(refs);
    let reloaded = false;
    for (const item of read.items) {
        const key = recordKey(item.kind, item.id);
        const text = item.revision === null ? null : JSON.stringify(item.data);
        if (text !== null && sent.get(key) === text) {
            persisted.set(key, { revision: item.revision!, text });
            continue;
        }
        if (item.kind === RESOURCE_KIND.characters && generatingCharacter() === item.id) {
            deferredCharacters.add(item.id);
            continue;
        }
        acceptRemote(item);
        reloaded = true;
    }
    if (reloaded) {
        showReloadedNotice();
    }
}

/**
 * Reloads the deferred characters whose generation ended (part of the cycle, so it never races a
 * write; a failed read is retried with the cycle's backoff and keeps the characters excluded).
 */
async function reloadDeferredCharacters() {
    const ids = [...deferredCharacters].filter((id) => !isBlockedByGeneration(id));
    if (ids.length === 0) {
        return;
    }
    const read = await readRefs(ids.map((id) => ({ kind: RESOURCE_KIND.characters, id })));
    for (const item of read.items) {
        acceptRemote(item);
        deferredCharacters.delete(item.id);
    }
    for (const id of ids) {
        // Not answered (never happens with the current route); do not keep it excluded forever.
        deferredCharacters.delete(id);
    }
    showReloadedNotice();
}

/** Wakes the loop for characters whose reload waited for a generation; call when a generation ends. */
export function releaseDeferredCharacters() {
    if (deferredCharacters.size > 0) {
        schedule(0);
    }
}

/** Puts a server record into `DBState.db` in place (data null: the record is gone). */
function applyToMirror(kind: string, id: string, data: unknown) {
    const db = DBState.db as unknown as Record<string, unknown>;
    switch (kind) {
        case RESOURCE_KIND.root: {
            if (data === null) {
                return;
            }
            const next = data as Record<string, unknown>;
            for (const key of Object.keys(db)) {
                if (!excludedRootKeys.has(key) && !Object.hasOwn(next, key)) {
                    delete db[key];
                }
            }
            for (const [key, value] of Object.entries(next)) {
                db[key] = value;
            }
            return;
        }
        case RESOURCE_KIND.presets:
        case RESOURCE_KIND.modules:
        case RESOURCE_KIND.plugins:
        case RESOURCE_KIND.pluginStorage:
            if (data !== null) {
                db[COLLECTION_FIELDS[kind]] = data;
            }
            return;
        case RESOURCE_KIND.characters: {
            const characters = DBState.db.characters;
            const index = characters.findIndex((character) => character?.chaId === id);
            if (data === null) {
                if (index === -1) {
                    return;
                }
                const selected = get(selectedCharID);
                characters.splice(index, 1);
                if (selected === index) {
                    selectedCharID.set(-1);
                } else if (selected > index) {
                    selectedCharID.set(selected - 1);
                }
            } else if (index === -1) {
                characters.push(data as character | groupChat);
            } else {
                characters[index] = data as character | groupChat;
            }
            return;
        }
    }
}

/**
 * Saves everything that was changed before this call. Resolves once it is on the server, with the
 * keys whose local edits a conflict replaced meanwhile; rejects when saving fails or when a
 * character that must be saved is still being generated.
 */
export async function flushResources(): Promise<{ discarded: string[] }> {
    await tick();
    // What must be settled: every key dirty now, at its current generation, and every membership
    // change so far (a later mark of the same key raises the bar but never lowers it).
    const obligations = new Map(dirty);
    if (collectMembershipChanges()) {
        markMembership();
    }
    const membershipTarget = membershipGeneration;
    const firstDiscard = discardSequence + 1;
    const unsettled = () =>
        [...obligations].filter(([key, marked]) => (acked.get(key) ?? 0) < marked).map(([key]) => key);
    const pending = () => unsettled().length > 0 || membershipAcked < membershipTarget;
    for (let attempt = 0; attempt < 10 && pending(); attempt += 1) {
        if (halted) {
            throw new Error("Saving stopped: the server data was restored");
        }
        if (unsettled().some(isBlockedKey)) {
            throw new Error("A character is still being generated; try again when it finishes");
        }
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        await runCycle();
        if (lastError || permanentError) {
            throw lastError ?? permanentError;
        }
    }
    if (pending()) {
        throw new Error("Could not save every change");
    }
    return {
        discarded: [...discarded]
            .filter(([, sequence]) => sequence >= firstDiscard)
            .map(([key]) => key.replace("\u0000", "/")),
    };
}

/** True when a character was added or removed since the last save. */
function collectMembershipChanges(): boolean {
    const characters = DBState.db.characters ?? [];
    const before = characters.map((character) => character?.chaId);
    dedupeCharacterIds(characters);
    if (characters.some((character, index) => character?.chaId !== before[index])) {
        return true;
    }
    const ids = new Set(characters.filter(Boolean).map((character) => character.chaId));
    let known = 0;
    for (const key of persisted.keys()) {
        if (key.startsWith(characterPrefix)) {
            if (!ids.has(key.slice(characterPrefix.length))) {
                return true;
            }
            known += 1;
        }
    }
    return known !== ids.size;
}

/**
 * Starts saving. Every collection and every character is marked once, so the client's load-time
 * normalization (`setDatabase`, `checkNewFormat`, `assignIds`) reaches the server; unchanged records
 * compare equal and are not sent.
 */
export function startResourceSync() {
    if (started) {
        return;
    }
    started = true;
    setEpochMismatchListener(() => {
        void haltForRestore();
    });
    for (const collection of COLLECTIONS) {
        markKey(collectionKey(collection));
    }
    markCharactersDirty("all");

    $effect.root(() => {
        let selectedIndex = $state(get(selectedCharID));
        selectedCharID.subscribe((value) => {
            selectedIndex = value;
        });

        $effect(() => {
            $state.snapshot(DBState.db.botPresets);
            markKey(collectionKey("presets"));
        });
        $effect(() => {
            $state.snapshot(DBState.db.modules);
            markKey(collectionKey("modules"));
        });
        $effect(() => {
            $state.snapshot(DBState.db.plugins);
            markKey(collectionKey("plugins"));
        });
        $effect(() => {
            $state.snapshot(DBState.db.pluginCustomStorage);
            markKey(collectionKey("pluginStorage"));
        });
        $effect(() => {
            for (const key in DBState.db) {
                if (!excludedRootKeys.has(key)) {
                    $state.snapshot((DBState.db as unknown as Record<string, unknown>)[key]);
                }
            }
            markKey(collectionKey("root"));
        });
        // Membership: an added, removed, or re-keyed character wakes the loop even when it is not selected.
        $effect(() => {
            for (const character of DBState.db.characters ?? []) {
                void character?.chaId;
            }
            markMembership();
        });
        $effect(() => {
            const character = DBState.db.characters?.[selectedIndex];
            if (character) {
                $state.snapshot(character);
                markCharactersDirty([character.chaId]);
            }
        });
    });
}
