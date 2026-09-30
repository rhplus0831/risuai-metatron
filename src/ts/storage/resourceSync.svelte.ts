import { tick, untrack } from "svelte";
import { get } from "svelte/store";
import { v4 as uuidv4 } from "uuid";
import {
    isChatConflict,
    isChatOrderConflict,
    RESOURCE_KIND,
    type ResourceBatchResult,
    type ResourceReadKindsResult,
    SINGLETON_RESOURCE_ID,
} from "../../../shared/resources.ts";
import {
    COLLECTION_FIELDS as SETTINGS_COLLECTION_FIELDS,
    COLLECTION_KIND,
    COLLECTION_SELECTION_FIELDS,
    type CollectionKind,
    RESIDUAL_ROOT_KEYS,
    SECTION_FIELDS,
    SECTION_KIND,
    type SectionKind,
} from "../../../shared/sections.ts";
import { language } from "src/lang";
import { llmSecretPresets, replacePresetSecrets } from "./llmSecrets.svelte";
import { alertError, alertNormal, alertNormalWait } from "../alert";
import { DBState, selectedCharID } from "../stores.svelte";
import type { character, Database, groupChat } from "./database.svelte";
import {
    acceptRemoteCollection,
    ackChatWork,
    adoptCharacter,
    captureChatObligations,
    chatDiscardSequence,
    chatDiscardsSince,
    type ChatWork,
    chatWorkBody,
    checkpointAllGenerations,
    forgetCharacter,
    hasChatWork,
    hasUnsavedChatWork,
    isCharacterGenerating,
    isChatDeferred,
    noteMirrorReplaced,
    quarantineChat,
    quarantineChatOrder,
    rebaseChatOrders,
    type RemoteChat,
    recoverChatConflicts,
    requeueChatWork,
    type SentChatGroup,
    type SentChatOrder,
    setChatWorkListener,
    startChatDriftCheck,
    deferredReloads,
    finishDeferredReload,
    idleChatRefreshes,
    finishIdleChatRefresh,
    settleUnloadCheckpoint,
    takeChatWork,
    trackUnloadCheckpoint,
    unloadCheckpoint,
    unloadPendingChatWork,
    unsettledChatObligations,
} from "./chatStore.svelte";
import {
    applyBatchText,
    prepareUnloadAuth,
    readRefs,
    ResourceConflictError,
    ResourceEpochMismatchError,
    ResourceRequestError,
    sendBatchOnUnload,
    setEpochMismatchListener,
    setResourceEpoch,
    UNLOAD_BODY_LIMIT,
} from "./resourceClient";

/**
 * The write adapter of PLAN invariant 2: `DBState.db` stays the live model, and this module writes
 * it back to the server resources per collection: the residual `root` (`RESIDUAL_ROOT_KEYS`), the
 * Phase 3 sections and collections (`shared/sections.ts`; `llmSecrets` also carries
 * `llmSecretPresets`), `presets`, `modules`, `plugins`, `pluginStorage`, and one `characters`
 * record per `chaId`. Chats are not part of a
 * character record (Phase 2): the chat module (`chatStore.svelte.ts`) queues explicit chat
 * operations, and each cycle sends them in the same batch, after the resource ops.
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

type Phase1Collection = "presets" | "modules" | "plugins" | "pluginStorage";
type Collection = "root" | Phase1Collection | SectionKind | CollectionKind;

const COLLECTION_FIELDS = {
    presets: "botPresets",
    modules: "modules",
    plugins: "plugins",
    pluginStorage: "pluginCustomStorage",
} as const satisfies Record<Phase1Collection, keyof Database>;

const SECTIONS: readonly SectionKind[] = Object.values(SECTION_KIND);
const SETTINGS_COLLECTIONS: readonly CollectionKind[] = Object.values(COLLECTION_KIND);
const COLLECTIONS: readonly Collection[] = [
    "root",
    "presets",
    "modules",
    "plugins",
    "pluginStorage",
    ...SECTIONS,
    ...SETTINGS_COLLECTIONS,
];
const isSection = (collection: string): collection is SectionKind => SECTIONS.includes(collection as SectionKind);
const isSettingsCollection = (collection: string): collection is CollectionKind =>
    SETTINGS_COLLECTIONS.includes(collection as CollectionKind);
const selectionField = (collection: CollectionKind) =>
    Object.hasOwn(COLLECTION_SELECTION_FIELDS, collection)
        ? COLLECTION_SELECTION_FIELDS[collection as keyof typeof COLLECTION_SELECTION_FIELDS]
        : null;
const DEBOUNCE_MS = 500;
const MAX_BACKOFF_MS = 30_000;
/** Largest batch body the server accepts (its global body limit is 100 MiB), in UTF-8 bytes. */
const MAX_BATCH_BYTES = 100 * 1024 * 1024 - 64 * 1024;
const MAX_BATCH_OPERATIONS = 5000;
/** Bytes of the batch envelope around its parts: `{"ops":[],"chats":[],"chatOrders":[]}`. */
const BATCH_FRAME_BYTES = 38;

/** Character fields that are client-only: chats (saved on their own), the selection, a render key. */
const CHARACTER_LOCAL_KEYS = new Set(["chats", "chatPage", "reloadKeys"]);

export const saving = $state({ state: false });

const recordKey = (kind: string, id: string) => `${kind}\u0000${id}`;
const collectionKey = (collection: Collection) => recordKey(collection, SINGLETON_RESOURCE_ID);
const characterPrefix = recordKey(RESOURCE_KIND.characters, "");
const characterKey = (id: string) => recordKey(RESOURCE_KIND.characters, id);

/** What the server holds for each record this client knows: `<kind>\0<id>` → revision and JSON text. */
const persisted = new Map<string, { revision: string; text: string }>();
/** Dirty record keys → the generation of their latest mark. */
const dirty = new Map<string, number>();
/** Refused content, keyed by the same kind + NUL + id as dirty/persisted; edits release it. */
const quarantinedRecords = new Map<string, { text: string | null; error: ResourceRequestError }>();
const recordAlerts = new Set<string>();
/** An unindexed refusal is isolated into one resource, chat group, or order per request. */
let isolateBatches = false;
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
/** When the scheduled cycle runs; a later mark never postpones it. */
let timerDeadline = 0;
/** No cycle before this time after a failure (retry backoff), whatever marks arrive. */
let backoffUntil = 0;
/** Characters whose chat list must be read from the server (a recovery inserted or emptied them). */
const hydrate = new Set<string>();
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
    if (hasPendingMembership() || hasChatWork(canSaveCharacter) || hydrate.size > 0) {
        return true;
    }
    for (const id of deferredCharacters) {
        if (!isBlockedByGeneration(id)) {
            return true;
        }
    }
    for (const key of dirty.keys()) {
        if (!isBlockedKey(key) && !recordQuarantine(key)) {
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

/**
 * Schedules a cycle `delay` from now. An already scheduled earlier cycle is kept (marks never
 * postpone a pending cycle, so a stream of marks cannot starve saving), and nothing runs before the
 * retry backoff after a failure ends.
 */
function schedule(delay = DEBOUNCE_MS) {
    if (!started || halted) {
        return;
    }
    // Watchers call schedule: avoid subscribing them to other records while checking quarantine.
    untrack(() => {
        if (hasUnsavedWork()) {
            prepareUnloadAuth();
        }
    });
    const now = Date.now();
    const deadline = Math.max(now + delay, backoffUntil);
    if (timer) {
        if (timerDeadline <= deadline) {
            return;
        }
        clearTimeout(timer);
    }
    timerDeadline = deadline;
    timer = setTimeout(() => {
        timer = null;
        if (Date.now() < backoffUntil) {
            // A failure after this timer was set moved the earliest retry later.
            schedule(0);
            return;
        }
        void runCycle();
    }, deadline - now);
}

/**
 * A collection's text as the server stores it. Sections and the settings collections serialize the
 * live values straight from the proxy (like `pluginStorage`): `$state.snapshot` would drop an own
 * `__proto__` key of a user-keyed map (`llmSecrets.presets`, `globalChatVariables`,
 * `OaiCompAPIKeys`), and the text must equal the server's normalized text on an idle boot. The
 * fields go in `SECTION_FIELDS` order and an `undefined` one is left out, as the normalizer does.
 * Reading every field deeply, it also serves as the watchers' dependency read.
 */
function projectCollection(collection: Collection): string | undefined {
    const db = DBState.db;
    const fields = db as unknown as Record<string, unknown>;
    if (collection === "root") {
        const root: Record<string, unknown> = {};
        for (const key of RESIDUAL_ROOT_KEYS) {
            root[key] = $state.snapshot(fields[key]);
        }
        return JSON.stringify(root);
    }
    if (isSection(collection)) {
        const record: Record<string, unknown> = {};
        for (const field of SECTION_FIELDS[collection]) {
            record[field] = fields[field];
        }
        if (collection === SECTION_KIND.llmSecrets) {
            record.presets = llmSecretPresets.value;
        }
        return JSON.stringify(record);
    }
    if (isSettingsCollection(collection)) {
        const value = fields[SETTINGS_COLLECTION_FIELDS[collection]];
        const selection = selectionField(collection);
        if (selection) {
            return JSON.stringify({ items: value, selectedId: fields[selection] });
        }
        return JSON.stringify(value);
    }
    if (collection === "pluginStorage" || collection === "presets") {
        // User-chosen keys (plugin storage, a preset's `seperateParameters.overrides`). Serialized
        // straight from the proxy: `$state.snapshot` assigns `copy[key] = ...`, which would drop an
        // own `__proto__` key.
        return JSON.stringify(db[COLLECTION_FIELDS[collection]]);
    }
    return JSON.stringify($state.snapshot(db[COLLECTION_FIELDS[collection]]));
}

/**
 * A character as stored: its own fields in their order, without `CHARACTER_LOCAL_KEYS` (the chats
 * are saved on their own; the selection and the render key are client-only). Reads only those
 * fields, so a watcher built on it does not track the chats.
 */
function projectCharacter(character: character | groupChat): string {
    const copy: Record<string, unknown> = {};
    for (const key in character) {
        if (!CHARACTER_LOCAL_KEYS.has(key)) {
            copy[key] = $state.snapshot((character as unknown as Record<string, unknown>)[key]);
        }
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

function recordQuarantine(key: string): ResourceRequestError | null {
    const refused = quarantinedRecords.get(key);
    if (!refused) {
        return null;
    }
    const separator = key.indexOf("\u0000");
    const text = projectRecord(key.slice(0, separator), key.slice(separator + 1)) ?? null;
    if (text === refused.text) {
        return refused.error;
    }
    quarantinedRecords.delete(key);
    return null;
}

function canSaveCharacter(id: string): boolean {
    return persisted.has(characterKey(id)) || !recordQuarantine(characterKey(id));
}

function hasPendingMembership(): boolean {
    if (membershipGeneration <= membershipAcked) {
        return false;
    }
    const ids = new Set((DBState.db.characters ?? []).filter(Boolean).map((character) => character.chaId));
    for (const id of ids) {
        if (!persisted.has(characterKey(id)) && !recordQuarantine(characterKey(id))) {
            return true;
        }
    }
    for (const key of persisted.keys()) {
        if (key.startsWith(characterPrefix) && !ids.has(key.slice(characterPrefix.length)) && !recordQuarantine(key)) {
            return true;
        }
    }
    return false;
}

function hasUnsavedWork(): boolean {
    return (
        inFlight !== null ||
        [...dirty.keys()].some((key) => !recordQuarantine(key)) ||
        hasPendingMembership() ||
        hasUnsavedChatWork(canSaveCharacter)
    );
}

function quarantineRecord(op: PendingOp, error: ResourceRequestError, indexed = true) {
    quarantinedRecords.set(op.key, { text: op.text, error });
    // Indexed errors alert once per key per session. An isolated unindexed refusal alerts once
    // per content change; unchanged content never makes it back to this function.
    if (!indexed || !recordAlerts.has(op.key)) {
        alertError(`${language.resourceRecordRefused}\n${op.kind}/${op.id}: ${error.message}`);
        recordAlerts.add(op.key);
    }
}

function quarantineReason(): ResourceRequestError | null {
    for (const key of quarantinedRecords.keys()) {
        const error = recordQuarantine(key);
        if (error) {
            return error;
        }
    }
    return null;
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

/**
 * Builds this cycle's operations and the generation each dirty key had when it was captured, then
 * takes the chat work: a new character's chats are created with it, a deleted one's are dropped.
 */
function collectOperations(): {
    ops: PendingOp[];
    captured: Map<string, number>;
    membership: number;
    chatWork: ChatWork;
} {
    const captured = new Map(dirty);
    const membership = membershipGeneration;
    const ops: PendingOp[] = [];
    function addOperation(op: PendingOp) {
        if (recordQuarantine(op.key)) {
            return;
        }
        if (op.bytes + BATCH_FRAME_BYTES > MAX_BATCH_BYTES) {
            quarantineRecord(op, new ResourceRequestError(413, `${op.kind} ${op.id} is too large to save`));
            return;
        }
        ops.push(op);
    }
    for (const collection of COLLECTIONS) {
        const key = collectionKey(collection);
        if (!captured.has(key)) {
            continue;
        }
        const text = projectCollection(collection);
        const current = persisted.get(key);
        // An absent collection (e.g. no plugin storage yet) has no record to write.
        if (text !== undefined && text !== current?.text) {
            addOperation(
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
            addOperation(
                pendingOp({ key, kind: RESOURCE_KIND.characters, id, baseRevision: current?.revision ?? null, text }),
            );
        }
    }
    const creating = new Set<string>();
    for (const op of ops) {
        if (op.kind === RESOURCE_KIND.characters && op.baseRevision === null) {
            creating.add(op.id);
            adoptCharacter(op.id);
        }
    }
    for (const [key, current] of persisted) {
        if (key.startsWith(characterPrefix)) {
            const id = key.slice(characterPrefix.length);
            if (!present.has(id) && !deferredCharacters.has(id)) {
                forgetCharacter(id);
                addOperation(
                    pendingOp({ key, kind: RESOURCE_KIND.characters, id, baseRevision: current.revision, text: null }),
                );
            }
        }
    }
    return { ops, captured, membership, chatWork: takeChatWork(creating, { maxOps: MAX_BATCH_OPERATIONS }) };
}

/** One request of a cycle: resource ops, then chat groups and reorders. */
type Batch = { ops: PendingOp[]; work: ChatWork };

function batchBody(batch: Batch): string {
    const { chats, chatOrders } = chatWorkBody(batch.work);
    return `{"ops":[${batch.ops.map((op) => op.part).join(",")}],"chats":[${chats.join(",")}],"chatOrders":[${chatOrders.join(",")}]}`;
}

type BatchUnit =
    | { type: "op"; op: PendingOp; bytes: number; count: number }
    | { type: "group"; group: SentChatGroup; bytes: number; count: number }
    | { type: "order"; order: SentChatOrder; bytes: number; count: number };

/**
 * Splits a cycle into requests under the operation and byte caps: resource ops first (a character
 * is created before its chats), then chat groups (each whole), then reorders. A chat group that is
 * larger than one request on its own (its bytes, or its nested ops: the module already splits an
 * ordinary chat's work, so only a create or a resent group can reach that) is returned in
 * `oversized` and not sent.
 */
function planBatches(ops: readonly PendingOp[], work: ChatWork): { batches: Batch[]; oversized: SentChatGroup[] } {
    const body = chatWorkBody(work);
    const units: BatchUnit[] = [
        ...ops.map((op) => ({ type: "op" as const, op, bytes: op.bytes, count: 1 })),
        ...work.groups.map((group, index) => ({
            type: "group" as const,
            group,
            bytes: utf8ByteLength(body.chats[index]),
            count: group.ops.length,
        })),
        ...work.orders.map((order, index) => ({
            type: "order" as const,
            order,
            bytes: utf8ByteLength(body.chatOrders[index]),
            count: 1,
        })),
    ];
    const oversized: SentChatGroup[] = [];
    const sendable = units.filter((unit) => {
        if (
            unit.type === "group" &&
            (unit.bytes + BATCH_FRAME_BYTES > MAX_BATCH_BYTES || unit.count > MAX_BATCH_OPERATIONS)
        ) {
            oversized.push(unit.group);
            return false;
        }
        return true;
    });
    const batches: Batch[] = [];
    const chunks = isolateBatches
        ? sendable.map((unit) => [unit])
        : splitBatches(sendable.map((unit) => ({ ...unit, bytes: unit.bytes, weight: unit.count })));
    for (const chunk of chunks) {
        const batch: Batch = { ops: [], work: { groups: [], orders: [] } };
        for (const unit of chunk) {
            if (unit.type === "op") {
                batch.ops.push(unit.op);
            } else if (unit.type === "group") {
                batch.work.groups.push(unit.group);
            } else {
                batch.work.orders.push(unit.order);
            }
        }
        batches.push(batch);
    }
    return { batches, oversized };
}

/**
 * Splits operations into batches under the operation and byte caps, measured in UTF-8 bytes as the
 * server counts them (only a boot pass needs more than one batch).
 */
export function splitBatches<T extends { bytes: number; weight?: number }>(ops: readonly T[]): T[][] {
    const batches: T[][] = [];
    let current: T[] = [];
    let bytes = BATCH_FRAME_BYTES;
    let count = 0;
    for (const op of ops) {
        const size = op.bytes + 1;
        const weight = op.weight ?? 1;
        if (current.length > 0 && (count + weight > MAX_BATCH_OPERATIONS || bytes + size > MAX_BATCH_BYTES)) {
            batches.push(current);
            current = [];
            bytes = BATCH_FRAME_BYTES;
            count = 0;
        }
        current.push(op);
        bytes += size;
        count += weight;
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
            backoffUntil = lastError ? Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 5)) : 0;
            if (!halted && !permanentError && (hasPendingWork() || lastError)) {
                schedule(DEBOUNCE_MS);
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
    await reloadDeferredChats();
    await hydrateCharacters();
    await refreshIdleChats();
    const { ops, captured, membership, chatWork } = collectOperations();
    const { batches, oversized } = planBatches(ops, chatWork);
    for (const group of oversized) {
        quarantineChat(group);
        alertError(`The chat ${group.chatId} is too large to save`);
    }
    if (batches.length > 0) {
        saving.state = true;
        for (const [index, batch] of batches.entries()) {
            const later = mergeWork(batches.slice(index + 1).map((entry) => entry.work));
            if (index > 0) {
                // An earlier request of this cycle may have created or deleted chats of a character
                // whose reorder travels here: base it on the order revision that acknowledgement gave.
                rebaseChatOrders(batch.work);
            }
            let result: ResourceBatchResult;
            try {
                result = await applyBatchText(batchBody(batch));
            } catch (error) {
                // Nothing of this request or the later ones was saved.
                requeueChatWork(later);
                if (error instanceof ResourceConflictError) {
                    await recoverFromConflict(error, batch.ops, batch.work);
                    return;
                }
                if (quarantineRejectedChat(error, batch.work)) {
                    return;
                }
                requeueChatWork(batch.work);
                if (error instanceof ResourceRequestError && (error.status === 400 || error.status === 413)) {
                    const match = /^ops\[(\d+)\]/.exec(error.message);
                    const op = match ? batch.ops[Number(match[1])] : undefined;
                    if (op) {
                        quarantineRecord(op, error);
                    } else if (batch.ops.length + batch.work.groups.length + batch.work.orders.length > 1) {
                        // The error names no record (including order/envelope errors). Probe each
                        // unit separately next cycle so unrelated records and chats can still save.
                        isolateBatches = true;
                    } else if (batch.ops[0]) {
                        quarantineRecord(batch.ops[0], error, false);
                    } else if (batch.work.groups[0]) {
                        quarantineChat(batch.work.groups[0]);
                        alertError(`${language.chatSaveRefused}\n${error.message}`);
                    } else if (batch.work.orders[0]) {
                        quarantineChatOrder(batch.work.orders[0]);
                        alertError(`${language.chatOrderRefused}\n${error.message}`);
                    }
                    return;
                }
                throw error;
            }
            batch.ops.forEach((op, opIndex) => {
                const revision = result.results[opIndex]?.revision;
                if (op.text === null || revision === null || revision === undefined) {
                    persisted.delete(op.key);
                } else {
                    persisted.set(op.key, { revision, text: op.text });
                }
            });
            for (const characterId of ackChatWork(batch.work, result.chats ?? [], result.chatOrders ?? [])) {
                hydrate.add(characterId);
            }
        }
    }
    for (const [key, marked] of captured) {
        if (recordQuarantine(key)) {
            continue;
        }
        if (key.startsWith(characterPrefix) && deferredCharacters.has(key.slice(characterPrefix.length))) {
            // Not saved: its reload waits for the running generation.
            continue;
        }
        settle(key, marked);
        if (dirty.get(key) === marked) {
            dirty.delete(key);
        }
    }
    if (membershipAcked < membership && !collectMembershipChanges()) {
        membershipAcked = membership;
    }
    await refreshIdleChats();
}

function mergeWork(works: readonly ChatWork[]): ChatWork {
    return { groups: works.flatMap((work) => work.groups), orders: works.flatMap((work) => work.orders) };
}

/**
 * A 400 that names one chat group (`chats[i]...`) is that chat's invalid data: stop sending it (one
 * alert) and send the rest again, so one bad chat never blocks every other save.
 */
function quarantineRejectedChat(error: unknown, work: ChatWork): boolean {
    if (!(error instanceof ResourceRequestError) || error.status !== 400) {
        return false;
    }
    const match = /^chats\[(\d+)\]/.exec(error.message);
    const group = match ? work.groups[Number(match[1])] : undefined;
    if (!group) {
        return false;
    }
    quarantineChat(group);
    alertError(`The chat ${group.chatId} could not be saved: ${error.message}`);
    requeueChatWork({ groups: work.groups.filter((entry) => entry !== group), orders: work.orders });
    return true;
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
    quarantinedRecords.delete(key);
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
async function recoverFromConflict(error: ResourceConflictError, batch: readonly PendingOp[], work: ChatWork) {
    const sent = new Map(batch.map((op) => [op.key, op.text]));
    const refs: { kind: string; id: string }[] = [];
    const chatRefs: { characterId: string; id: string }[] = [];
    const conflictedChats = new Set<string>();
    const conflictedOrders = new Set<string>();
    for (const conflict of error.conflicts) {
        if (isChatConflict(conflict)) {
            chatRefs.push({ characterId: conflict.characterId, id: conflict.id });
            conflictedChats.add(`${conflict.characterId}\u0000${conflict.id}`);
        } else if (isChatOrderConflict(conflict)) {
            conflictedOrders.add(conflict.characterId);
        } else {
            refs.push({ kind: conflict.kind, id: conflict.id });
        }
    }
    let read: Awaited<ReturnType<typeof readRefs>>;
    try {
        read = refs.length + chatRefs.length > 0 ? await readRefs(refs, { chats: chatRefs }) : { epoch: "", items: [] };
    } catch (readError) {
        // Nothing was applied: the chat work goes out again in the next cycle.
        requeueChatWork(work);
        throw readError;
    }
    const recovered = recoverChatConflicts(work, conflictedChats, conflictedOrders, (read.chats ?? []) as RemoteChat[]);
    let reloaded = recovered.reloaded;
    for (const characterId of recovered.refresh) {
        // Read in `hydrateCharacters` (now, and again next cycle if the read fails).
        hydrate.add(characterId);
    }
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
        if (item.kind === RESOURCE_KIND.characters && item.revision !== null && !findMirrorCharacter(item.id)) {
            // A character the mirror did not have: its chats come with their order.
            hydrate.add(item.id);
        }
        acceptRemote(item);
        reloaded = true;
    }
    if (hydrate.size > 0) {
        reloaded = (await hydrateCharacters()) || reloaded;
    }
    if (reloaded) {
        showReloadedNotice();
    }
}

/**
 * Reads the chat lists of characters a recovery inserted or whose chats changed on the server, and
 * puts them into the mirror. A character stays listed until its read succeeds.
 */
async function hydrateCharacters(): Promise<boolean> {
    // A character with a running generation waits until it ends.
    const ids = [...hydrate].filter((id) => !isCharacterGenerating(id));
    if (ids.length === 0) {
        return false;
    }
    const read = await readRefs(
        ids.map((id) => ({ kind: RESOURCE_KIND.characters, id })),
        { chatCollections: ids },
    );
    const records = new Map(read.items.map((item) => [item.id, item]));
    for (const collection of read.chatCollections ?? []) {
        const record = records.get(collection.characterId);
        if (!collection.order && record && record.revision === null) {
            // The character itself is gone on the server: remove it with its chats.
            acceptRemote(record);
        } else if (collection.order) {
            acceptRemoteCollection(collection);
        } else {
            console.error(`[Save] Character ${collection.characterId} has no chat order on the server`);
        }
        hydrate.delete(collection.characterId);
    }
    return true;
}

function findMirrorCharacter(id: string) {
    return DBState.db.characters?.find((character) => character?.chaId === id);
}

/**
 * Reloads chats whose reload waited for a generation that has ended (part of the cycle). A chat
 * stays deferred until its read succeeds; one that is gone refreshes its character's chat list.
 */
async function reloadDeferredChats() {
    const released = deferredReloads();
    if (released.length === 0) {
        return;
    }
    const read = await readRefs([], {
        chats: released.map((ref) => ({ characterId: ref.chaId, id: ref.chatId })),
    });
    for (const chat of read.chats ?? []) {
        const refresh = finishDeferredReload(chat as RemoteChat);
        if (refresh) {
            hydrate.add(refresh);
        }
    }
    showReloadedNotice();
}

/** Stale acknowledgements rebase only idle chats, inside the cycle and without a reload notice. */
async function refreshIdleChats() {
    const refs = idleChatRefreshes();
    if (refs.length === 0) {
        return;
    }
    const read = await readRefs([], {
        chats: refs.map((ref) => ({ characterId: ref.chaId, id: ref.chatId })),
    });
    for (const chat of read.chats ?? []) {
        if (finishIdleChatRefresh(chat as RemoteChat) && chat.revision === null) {
            hydrate.add(chat.characterId);
        }
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

/** Assigns `fields` of `DBState.db` from `next` in place; a field `next` lacks is deleted. */
function replaceFields(fields: readonly string[], next: Record<string, unknown>) {
    const db = DBState.db as unknown as Record<string, unknown>;
    for (const field of fields) {
        if (Object.hasOwn(next, field)) {
            db[field] = next[field];
        } else if (Object.hasOwn(db, field)) {
            delete db[field];
        }
    }
}

/** Puts a section or settings collection record into `DBState.db` (and `llmSecretPresets`). */
function applySettingsRecord(kind: SectionKind | CollectionKind, data: unknown) {
    if (data === null) {
        // Singletons: the server never deletes them.
        return;
    }
    if (isSection(kind)) {
        replaceFields(SECTION_FIELDS[kind], data as Record<string, unknown>);
        if (kind === SECTION_KIND.llmSecrets) {
            replacePresetSecrets((data as { presets?: unknown }).presets);
        }
        return;
    }
    const db = DBState.db as unknown as Record<string, unknown>;
    const selection = selectionField(kind);
    if (selection) {
        const record = data as { items: unknown; selectedId: unknown };
        db[SETTINGS_COLLECTION_FIELDS[kind]] = record.items;
        db[selection] = record.selectedId;
    } else {
        db[SETTINGS_COLLECTION_FIELDS[kind]] = data;
    }
}

/** Puts a server record into `DBState.db` in place (data null: the record is gone). */
function applyToMirror(kind: string, id: string, data: unknown) {
    const db = DBState.db as unknown as Record<string, unknown>;
    if (isSection(kind) || isSettingsCollection(kind)) {
        applySettingsRecord(kind, data);
        return;
    }
    switch (kind) {
        case RESOURCE_KIND.root: {
            if (data !== null) {
                replaceFields(RESIDUAL_ROOT_KEYS, data as Record<string, unknown>);
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
            noteMirrorReplaced();
            if (data === null) {
                if (index === -1) {
                    return;
                }
                const selected = get(selectedCharID);
                characters.splice(index, 1);
                forgetCharacter(id);
                if (selected === index) {
                    selectedCharID.set(-1);
                } else if (selected > index) {
                    selectedCharID.set(selected - 1);
                }
            } else if (index === -1) {
                // Its chats arrive with a collection read (`recoverFromConflict`).
                characters.push({ ...(data as character | groupChat), chats: [], chatPage: 0 });
            } else {
                // The server record has only the character's own fields: keep the mirror's chats,
                // selection, and render key.
                const local = characters[index];
                characters[index] = {
                    ...(data as character | groupChat),
                    chats: local.chats,
                    chatPage: local.chatPage,
                    reloadKeys: local.reloadKeys,
                };
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
    const refused = quarantineReason();
    if (refused) {
        throw refused;
    }
    // A running generation's text so far becomes a checkpoint, so it is part of what is flushed.
    checkpointAllGenerations();
    // What must be settled: every key dirty now, at its current generation, every membership
    // change so far (a later mark of the same key raises the bar but never lowers it), and every
    // chat and chat order with queued or in-flight work.
    const obligations = new Map(dirty);
    if (collectMembershipChanges()) {
        markMembership();
    }
    const chatObligations = captureChatObligations();
    const membershipTarget = membershipGeneration;
    const firstDiscard = discardSequence + 1;
    const firstChatDiscard = chatDiscardSequence();
    const unsettled = () =>
        [...obligations].filter(([key, marked]) => (acked.get(key) ?? 0) < marked).map(([key]) => key);
    const hydrating = new Set(hydrate);
    const pending = () =>
        unsettled().length > 0 ||
        membershipAcked < membershipTarget ||
        unsettledChatObligations(chatObligations).length > 0 ||
        [...hydrating].some((id) => hydrate.has(id));
    for (let attempt = 0; attempt < 10 && pending(); attempt += 1) {
        if (halted) {
            throw new Error("Saving stopped: the server data was restored");
        }
        if (unsettled().some(isBlockedKey) || unsettledChatObligations(chatObligations).some(isChatDeferred)) {
            throw new Error("A character is still being generated; try again when it finishes");
        }
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        await runCycle();
        const refused = quarantineReason();
        if (refused) {
            throw refused;
        }
        if (lastError || permanentError) {
            throw lastError ?? permanentError;
        }
    }
    if (pending()) {
        throw new Error("Could not save every change");
    }
    return {
        discarded: [
            ...[...discarded]
                .filter(([, sequence]) => sequence >= firstDiscard)
                .map(([key]) => key.replace("\u0000", "/")),
            ...chatDiscardsSince(firstChatDiscard).map((key) => `chats/${key}`),
        ],
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
    setChatWorkListener(() => {
        schedule();
    });
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "hidden" || halted) {
            return;
        }
        void (async () => {
            await tick();
            checkpointAllGenerations();
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            backoffUntil = 0;
            const wasInFlight = inFlight !== null;
            await runCycle();
            if (wasInFlight && hasPendingWork() && !lastError && !halted) {
                await runCycle();
            }
        })();
    });
    window.addEventListener("beforeunload", (event) => {
        if (hasUnsavedWork()) {
            event.preventDefault();
            event.returnValue = "";
        }
    });
    // One shared budget, including requests still in flight from an earlier pagehide. Checkpoints
    // have priority; ordinary by-id work follows in separate requests. Resource writes use only
    // normal cycles, so they never race a keepalive write on the same revision.
    let unloadBytes = 0;
    function sendUnload(request: { body: string; work: ChatWork }) {
        const bytes = utf8ByteLength(request.body);
        if (bytes + unloadBytes > UNLOAD_BODY_LIMIT) {
            return;
        }
        if (
            sendBatchOnUnload(request.body, (result) => {
                unloadBytes -= bytes;
                settleUnloadCheckpoint(request.work, result?.chats ?? null);
            })
        ) {
            unloadBytes += bytes;
            trackUnloadCheckpoint(request.work);
        }
    }
    window.addEventListener("pagehide", () => {
        try {
            const checkpoint = unloadCheckpoint(UNLOAD_BODY_LIMIT - unloadBytes);
            if (checkpoint) {
                sendUnload(checkpoint);
            }
            for (const request of unloadPendingChatWork(UNLOAD_BODY_LIMIT - unloadBytes)) {
                sendUnload(request);
            }
        } catch {}
    });
    setInterval(() => {
        if (!halted && hasUnsavedWork()) {
            prepareUnloadAuth();
        }
    }, 60_000);
    startChatDriftCheck();
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
            projectCollection("presets");
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
        // The residual root, each section, and each settings collection: the projection reads exactly
        // the fields the record holds, so an edit marks only its own record.
        for (const collection of ["root", ...SECTIONS, ...SETTINGS_COLLECTIONS] as const) {
            $effect(() => {
                projectCollection(collection);
                markKey(collectionKey(collection));
            });
        }
        // Membership: an added, removed, or re-keyed character wakes the loop even when it is not selected.
        $effect(() => {
            for (const character of DBState.db.characters ?? []) {
                void character?.chaId;
            }
            markMembership();
        });
        // The selected character's own fields (never its chats, selection, or render key).
        $effect(() => {
            const character = DBState.db.characters?.[selectedIndex];
            if (character) {
                projectCharacter(character);
                markCharactersDirty([character.chaId]);
            }
        });
    });
}
