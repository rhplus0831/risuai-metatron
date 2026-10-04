import isEqual from "lodash/isEqual";
import { tick, untrack } from "svelte";
import { get } from "svelte/store";
import { v4 as uuidv4 } from "uuid";
import type { ChatOrderRecord, ChatRecord } from "../../../shared/chats.ts";
import { HIDDEN_HYDRATION_KINDS, type StreamingMessage } from "../../../shared/jobs.ts";
import {
    compareRevision,
    isChatConflict,
    isChatOrderConflict,
    parseRevisionToken,
    RESOURCE_KIND,
    type ChangeSet,
    type ResourceBatchResult,
    type ResourceReadKindsResult,
    type ResourceRevisionListing,
    SINGLETON_RESOURCE_ID,
} from "../../../shared/resources.ts";
import {
    COLLECTION_FIELDS as SETTINGS_COLLECTION_FIELDS,
    COLLECTION_KIND,
    COLLECTION_SELECTION_FIELDS,
    type CollectionKind,
    SECTION_FIELDS,
    SECTION_KIND,
    type SectionKind,
} from "../../../shared/sections.ts";
import { language } from "src/lang";
import {
    llmSecretState,
    llmSecretsText,
    mirrorFields,
    removeSecretOp,
    secretOpTarget,
    setMaskedSecrets,
    setSecretScheduler,
    type QueuedSecretOp,
} from "./llmSecrets.svelte";
import {
    encodeSecretPath,
    type MaskedLlmSecrets,
    type SecretEntryMap,
    type SecretPath,
} from "../../../shared/llmSecrets.ts";
import { alertError, alertNormal, alertTerminal } from "../alert";
import { assignsInherited } from "./mutationValidation";
import { DBState, selectedCharID } from "../stores.svelte";
import { reconcileSelection } from "./forwarding.svelte";
import type { character, Chat, Database, groupChat } from "./database.svelte";
import {
    acceptRemoteCollection,
    ackChatWork,
    applyRemoteCollection,
    canApplyRemoteCollection,
    heldChatRefs,
    heldChatRevision,
    heldChatRevisionsOf,
    heldOrderRevision,
    noteRemoteChat,
    adoptCharacter,
    captureChatObligations,
    chatDiscardSequence,
    chatJobRetryAt,
    chatDiscardsSince,
    type ChatWork,
    chatWorkBody,
    forgetCharacter,
    hasChatWork,
    hydrateChat,
    JOB_RETRY_MS,
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
    chatNoticeSeq,
    finishIdleChatRefresh,
    settleUnloadWork,
    takeChatWork,
    trackUnloadWork,
    unloadPendingChatWork,
    unsettledChatObligations,
} from "./chatStore.svelte";
import {
    applyBatchText,
    getResource,
    getResourceEpoch,
    prepareUnloadAuth,
    readRefs,
    ResourceConflictError,
    ResourceEpochMismatchError,
    ResourceRequestError,
    sendBatchOnUnload,
    sendSecretRequest,
    setEpochMismatchListener,
    setMutationAdmission,
    setResourceEpoch,
    UNLOAD_BODY_LIMIT,
} from "./resourceClient";

/**
 * The write adapter of PLAN invariant 2: `DBState.db` stays the live model, and this module writes
 * it back to the server resources per collection: the
 * Phase 3 sections and collections (`shared/sections.ts`; `llmSecrets` also carries
 * `llmSecretPresets`), `presets`, `modules`, `plugins`, `pluginStorage`, and one `characters`
 * record per `chaId`. Chats are not part of a
 * character record (Phase 2): the chat module (`chatStore.svelte.ts`) queues explicit chat
 * operations, and each cycle sends them in the same batch, after the resource ops.
 *
 * - Watchers mark collections dirty (the selected character, each section, and so on); writers
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
 * - A 409 entry with `reason: "generating"` (a server generation job owns a message the change
 *   touches) is not a reload: the work stays unsaved and is retried after `JOB_RETRY_MS`, and
 *   `chatGenerating` is shown once per refusal episode.
 * - `applyHydration` applies a record a server job sent, without any outgoing write.
 * - Live updates (`noteRemoteChanges`, from the change feed, `network/eventFeed.ts`): records another
 *   writer committed are read and applied inside the cycle, before its batch, only while this client
 *   has no unsent change of them; nothing is discarded and no notice is shown. A record with a local
 *   change waits: its save then lands (the update is older) or conflicts (the normal 409 path).
 *
 * Transport state here is plain (no runes); only `saving` is reactive.
 */

type Phase1Collection = "presets" | "modules" | "plugins" | "pluginStorage";
type Collection = Phase1Collection | SectionKind | CollectionKind;

const COLLECTION_FIELDS = {
    presets: "botPresets",
    modules: "modules",
    plugins: "plugins",
    pluginStorage: "pluginCustomStorage",
} as const satisfies Record<Phase1Collection, keyof Database>;

const SECTIONS: readonly SectionKind[] = Object.values(SECTION_KIND);
const SETTINGS_COLLECTIONS: readonly CollectionKind[] = Object.values(COLLECTION_KIND);
const COLLECTIONS: readonly Collection[] = [
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
/**
 * Character deletes the server refused for a generating message → when they may be sent again
 * (the deletion stays an unsaved membership change meanwhile).
 */
const jobBlockedRecords = new Map<string, number>();
/** Whether `chatGenerating` was shown in the current refusal episode. */
let generatingNoticeShown = false;
/** Record keys of the batch in flight (hydration does not apply over them). */
const sendingKeys = new Set<string>();
/** The newest hydration refused for a record in flight or locally changed; retried after each cycle. */
const deferredHydrations = new Map<string, HydrationRecord>();
type RemoteChangeListener = (kind: string, id: string) => void;
const remoteChangeListeners = new Set<RemoteChangeListener>();
/**
 * Live updates waiting to be read and applied inside the cycle: record key → the newest revision
 * another writer committed (null: deleted). `blockedLocal`: the `llmSecrets` siblings this client
 * held unsent when the server's siblings had changed too; the entry waits for that local text to
 * change (its save or a conflict settles it).
 */
const remoteRecords = new Map<string, { kind: string; id: string; revision: string | null; blockedLocal?: string }>();
/**
 * Characters whose chat list (chats created, deleted, or reordered elsewhere) waits to be read and
 * applied → the sequence of the latest notice; a read settles only the notice it was issued for.
 */
const remoteCollections = new Map<string, number>();
let remoteCollectionSeq = 0;
/** Kinds whose records live outside the mirror (`inlays`, `pluginPermissions`): their own owner applies a live update. */
const remoteOwners = new Map<string, RemoteResourceOwner>();
/** A live update waits this long, so the refs of a burst of commits are read together. */
const REMOTE_DELAY_MS = 50;
/** Most records (and, separately, chat lists) one cycle reads for live updates; the rest wait for the next. */
const MAX_REMOTE_READS = 1000;

/** Records what the server holds, from the boot read. Call before `setDatabase` touches the data. */
export function seedResources(result: ResourceReadKindsResult) {
    setResourceEpoch(result.epoch);
    persisted.clear();
    for (const [kind, records] of Object.entries(result.kinds)) {
        for (const record of records) {
            persisted.set(recordKey(kind, record.id), {
                revision: record.revision,
                text: recordText(kind, record.data),
            });
        }
    }
}

/**
 * A record's text as this client writes and compares it: the JSON of its data, except the
 * write-only `llmSecrets` record, whose text is its readable siblings (the server keeps the
 * credentials and answers them masked).
 */
function recordText(kind: string, data: unknown): string {
    return kind === SECTION_KIND.llmSecrets ? llmSecretsText(data as Record<string, unknown>) : JSON.stringify(data);
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
    if (
        hasPendingMembership(true) ||
        hasChatWork(canSaveCharacter) ||
        hydrate.size > 0 ||
        llmSecretState.queue.some((op) => !awaitsOwnerDeletion(op)) ||
        hasRemoteWork()
    ) {
        return true;
    }
    for (const id of deferredCharacters) {
        if (!isBlockedByGeneration(id)) {
            return true;
        }
    }
    for (const key of dirty.keys()) {
        // A delete refused for a generating message stays unsaved but waits for its retry.
        if (!isBlockedKey(key) && !recordQuarantine(key) && !isRecordJobBlocked(key)) {
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

/**
 * Marks the `pluginStorage` record for the next compare-and-save: its writers go through
 * `pluginStorageStore.svelte.ts`, which calls this after every write.
 */
export function markPluginStorageDirty() {
    markKey(collectionKey("pluginStorage"));
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
    if (isSection(collection)) {
        if (collection === SECTION_KIND.llmSecrets) {
            // Its readable siblings only: the credentials are written through `/api/llm-secrets`.
            return llmSecretsText(fields);
        }
        const record: Record<string, unknown> = {};
        for (const field of SECTION_FIELDS[collection]) {
            record[field] = fields[field];
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

/** Whether a character delete waits because the server refused it for a generating message. */
function isRecordJobBlocked(key: string): boolean {
    const until = jobBlockedRecords.get(key);
    if (until === undefined) {
        return false;
    }
    if (Date.now() >= until) {
        jobBlockedRecords.delete(key);
        return false;
    }
    return true;
}

/** When the earliest work refused for a generating message may be sent again, or null. */
function jobRetryAt(): number | null {
    let earliest = chatJobRetryAt();
    for (const key of [...jobBlockedRecords.keys()]) {
        if (isRecordJobBlocked(key)) {
            const until = jobBlockedRecords.get(key)!;
            earliest = earliest === null ? until : Math.min(earliest, until);
        }
    }
    return earliest;
}

/**
 * Whether a character was added or removed and not saved. `runnable`: leave out deletes waiting
 * for a generating message's job (they stay unsaved, but there is nothing to send yet).
 */
function hasPendingMembership(runnable = false): boolean {
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
        if (
            key.startsWith(characterPrefix) &&
            !ids.has(key.slice(characterPrefix.length)) &&
            !recordQuarantine(key) &&
            !(runnable && isRecordJobBlocked(key))
        ) {
            return true;
        }
    }
    return false;
}

function hasUnsavedWork(): boolean {
    return (
        inFlight !== null ||
        llmSecretState.queue.length > 0 ||
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
        // A character whose refused delete was undone: nothing waits any more.
        jobBlockedRecords.delete(key);
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
            if (!present.has(id) && !deferredCharacters.has(id) && !isRecordJobBlocked(key)) {
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
            sendingKeys.clear();
            // A record whose hydration waited for the batch: its ordering check runs again now.
            for (const record of [...deferredHydrations.values()]) {
                deferredHydrations.delete(recordKey(record.kind, record.id));
                applyHydration(record);
            }
            saving.state = false;
            backoffUntil = lastError ? Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 5)) : 0;
            const retryAt = jobRetryAt();
            if (retryAt === null) {
                generatingNoticeShown = false;
            }
            if (!halted && !permanentError && (hasPendingWork() || lastError)) {
                schedule(DEBOUNCE_MS);
            }
            if (!halted && retryAt !== null) {
                // Work refused for a generating message: one wakeup at its retry time.
                schedule(Math.max(0, retryAt - Date.now()));
            }
        }
    })();
    return inFlight;
}

async function cycle() {
    if (halted || !DBState.db?.characters) {
        return;
    }
    for (const stage of [
        reloadDeferredCharacters,
        reloadDeferredChats,
        hydrateCharacters,
        applyRemoteUpdates,
        refreshIdleChats,
    ]) {
        await stage();
        if (halted) {
            // A restore replaced the data meanwhile: nothing more is applied or sent.
            return;
        }
    }
    const { ops, captured, membership, chatWork } = collectOperations();
    // The credential writes queued so far go after this batch; one queued while it is in flight
    // (say, the key of a preset created meanwhile) waits for the next cycle, after its resource.
    const capturedSecretOps = new Set(llmSecretState.queue.map((op) => op.id));
    const { batches, oversized } = planBatches(ops, chatWork);
    for (const group of oversized) {
        quarantineChat(group);
        alertError(`The chat ${group.chatId} is too large to save`);
    }
    if (batches.length > 0) {
        saving.state = true;
        for (const [index, batch] of batches.entries()) {
            if (halted) {
                requeueChatWork(mergeWork(batches.slice(index).map((entry) => entry.work)));
                return;
            }
            const later = mergeWork(batches.slice(index + 1).map((entry) => entry.work));
            if (index > 0) {
                // An earlier request of this cycle may have created or deleted chats of a character
                // whose reorder travels here: base it on the order revision that acknowledgement gave.
                rebaseChatOrders(batch.work);
            }
            let result: ResourceBatchResult;
            for (const op of batch.ops) {
                sendingKeys.add(op.key);
            }
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
    if (halted) {
        return;
    }
    await sendSecretOps(capturedSecretOps);
    for (const [key, marked] of captured) {
        if (recordQuarantine(key)) {
            continue;
        }
        if (key.startsWith(characterPrefix) && deferredCharacters.has(key.slice(characterPrefix.length))) {
            // Not saved: its reload waits for the running generation.
            continue;
        }
        if (isRecordJobBlocked(key)) {
            // Not saved: its delete waits for a generation job.
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

/** Queued credential writes the server refused (400, 404): dropped and reported, by op id. */
const failedSecretOps = new Set<number>();
/** How many times one credential write is retried on a stale revision within one cycle. */
const SECRET_CONFLICT_RETRIES = 2;

/**
 * Where the owner of a deleted entry stands: `live` while the mirror holds it (also once a conflict
 * restored it), `unsaved` while the server's saved copy still holds it, `gone` once both lost it.
 */
function entryOwnerState(field: SecretEntryMap, id: string): "live" | "unsaved" | "gone" {
    const holds = (list: unknown) =>
        Array.isArray(list) && list.some((entry) => (entry as { id?: unknown } | null)?.id === id);
    const mirror = field === "presets" ? DBState.db.botPresets : DBState.db.customModels;
    if (holds(mirror)) {
        return "live";
    }
    const saved = persisted.get(
        field === "presets"
            ? recordKey(RESOURCE_KIND.presets, SINGLETON_RESOURCE_ID)
            : collectionKey(COLLECTION_KIND.customModels),
    )?.text;
    let savedList: unknown = null;
    try {
        savedList = saved === undefined ? null : JSON.parse(saved);
    } catch {}
    return holds(savedList) ? "unsaved" : "gone";
}

/**
 * A cleanup whose owner's deletion is not saved yet: unsaved, but not work a cycle can do (the
 * owner's own write wakes the loop; a quarantined one waits for an edit).
 */
function awaitsOwnerDeletion(op: QueuedSecretOp): boolean {
    return op.request.kind === "cleanup" && entryOwnerState(op.request.path.field, op.request.path.id) === "unsaved";
}

/** What a credential write is called in a discard report (never its value). */
function secretOpLabel(op: QueuedSecretOp): string {
    return encodeSecretPath(secretOpTarget(op.request));
}

/**
 * Adopts the server's `llmSecrets` record after a credential write or a reread: its revision, its
 * masked status, and its siblings, judged by text against the saved siblings (a dirty mark alone
 * is no edit). Mirror siblings equal to the saved text take the server's; a local edit over
 * unchanged server siblings is kept (written next, on this revision); a local edit where the
 * server's siblings changed too is the normal conflict: the server's copy wins, the local edit is
 * reported as discarded, and the reload notice is shown.
 */
function adoptSecretRecord(revision: string, masked: MaskedLlmSecrets, invalidate: SecretPath[] | "all") {
    const key = collectionKey(SECTION_KIND.llmSecrets);
    const saved = persisted.get(key)?.text;
    const remote = llmSecretsText(masked);
    const local = projectCollection(SECTION_KIND.llmSecrets);
    if (local === saved) {
        persisted.set(key, { revision, text: remote });
        applySettingsRecord(SECTION_KIND.llmSecrets, masked, invalidate);
    } else if (remote === saved) {
        persisted.set(key, { revision, text: remote });
        setMaskedSecrets(masked, invalidate);
    } else {
        // Through `applySettingsRecord`, which invalidates every credential path.
        acceptRemote({ kind: SECTION_KIND.llmSecrets, id: SINGLETON_RESOURCE_ID, revision, data: masked });
        showReloadedNotice();
    }
}

async function rereadSecrets() {
    const item = await getResource<MaskedLlmSecrets>(SECTION_KIND.llmSecrets, SINGLETON_RESOURCE_ID);
    if (item) {
        const before = persisted.get(collectionKey(SECTION_KIND.llmSecrets))?.revision;
        adoptSecretRecord(item.revision, item.data, item.revision === before ? [] : "all");
    }
}

/**
 * Sends the queued credential writes (`llmSecrets.svelte.ts`), after this cycle's resource batch
 * (a preset is saved before its key is copied or set), one at a time on the record's current
 * revision. A stale revision rereads the record and retries (a set is a blind write of one path),
 * a few times per cycle; a refused write (400, 404) is dropped and reported as a discard; any
 * other failure keeps the queue for the next cycle (the save backoff; 412 halts for a restore).
 */
async function sendSecretOps(captured: ReadonlySet<number>) {
    const key = collectionKey(SECTION_KIND.llmSecrets);
    for (const op of llmSecretState.queue.filter((entry) => captured.has(entry.id))) {
        if (op.request.kind === "cleanup") {
            const owner = entryOwnerState(op.request.path.field, op.request.path.id);
            if (owner === "live") {
                // The deletion was discarded (a conflict restored the owner): its key stays.
                removeSecretOp(op.id);
                continue;
            }
            if (owner === "unsaved") {
                // Its deletion is not on the server yet: the cleanup waits for it.
                continue;
            }
        }
        for (let attempt = 0; ; attempt += 1) {
            if (halted) {
                return;
            }
            const base = persisted.get(key)?.revision;
            if (!base) {
                throw new Error("The llmSecrets record is not loaded");
            }
            saving.state = true;
            try {
                const reply = await sendSecretRequest(
                    op.request.kind === "copy"
                        ? op.request
                        : {
                              kind: "put",
                              path: encodeSecretPath(op.request.path),
                              value: op.request.kind === "put" ? op.request.value : "",
                          },
                    base,
                );
                removeSecretOp(op.id);
                adoptSecretRecord(reply.revision, reply.data as MaskedLlmSecrets, [secretOpTarget(op.request)]);
                break;
            } catch (error) {
                if (error instanceof ResourceConflictError && attempt < SECRET_CONFLICT_RETRIES) {
                    await rereadSecrets();
                    continue;
                }
                if (error instanceof ResourceRequestError && (error.status === 400 || error.status === 404)) {
                    removeSecretOp(op.id);
                    failedSecretOps.add(op.id);
                    discardSequence += 1;
                    discarded.set(recordKey(SECTION_KIND.llmSecrets, secretOpLabel(op)), discardSequence);
                    alertError(`${language.resourceRecordRefused}\nllmSecrets/${secretOpLabel(op)}: ${error.message}`);
                    break;
                }
                throw error;
            }
        }
    }
}

/**
 * Waits until every credential write queued now is saved: an auxiliary call that uses a stored key
 * (`auxFetch`) goes out only after the key the user just entered is on the server. Throws when one
 * of them was refused, when saving fails, or when the data was restored.
 */
export async function awaitSecretWrites(): Promise<void> {
    assertSaveAdmission();
    const target = new Set(llmSecretState.queue.map((op) => op.id));
    const waiting = () => llmSecretState.queue.some((op) => target.has(op.id));
    for (let attempt = 0; attempt < 10 && waiting(); attempt += 1) {
        if (halted) {
            throw new Error("Saving stopped: the server data was restored");
        }
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        await runCycle();
        if (lastError || permanentError) {
            throw lastError ?? permanentError;
        }
        const left = llmSecretState.queue.filter((op) => target.has(op.id));
        if (left.length > 0 && left.every(awaitsOwnerDeletion)) {
            // Only cleanups behind an unsaved deletion are left: another cycle cannot help.
            throw quarantineReason() ?? new Error("A deleted preset or model is not saved yet");
        }
    }
    if (waiting()) {
        throw new Error("A key could not be saved");
    }
    if ([...target].some((id) => failedSecretOps.has(id))) {
        throw new Error("The server refused a key");
    }
    assertSaveAdmission();
}

/**
 * Throws once saving has stopped (the server data was restored): the tab's state is from the old
 * data, so a call that uses the server's stored keys is not sent until the page reloads.
 */
export function assertSaveAdmission() {
    if (halted) {
        throw new Error("Saving stopped: the server data was restored");
    }
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
    // The terminal notice: no other alert replaces or clears it, so the page reloads only after the
    // user acknowledged it.
    await alertTerminal(language.resourceRestored);
    location.reload();
}

/** How long `watchForRestore` reads, how often, and how long one read may take. */
const RESTORE_WATCH_MS = 120_000;
const RESTORE_POLL_MS = 1_000;
const RESTORE_READ_MS = 5_000;
let restoreWatch: Promise<boolean> | null = null;

/**
 * A server job of this tab ended because a restore or import is replacing the data (its
 * `maintenance` terminal, which comes before the replacement): reads one small record every second
 * until the server answers with another epoch, which `getResource`'s epoch check turns into
 * `haltForRestore` (the restore notice and a reload). An answer with the old epoch, the maintenance
 * 503, a network failure, and a read that takes over 5 s keep it waiting (a late answer with the
 * new epoch still halts through the same check); a maintenance that replaced nothing ends the watch
 * after two minutes, however its reads hang. Writes need no pause meanwhile: each names the epoch it was based on, so one
 * after the replacement is refused (412) and halts too. One watch at a time; resolves true when the
 * data was replaced (or saving had already halted).
 */
export function watchForRestore(): Promise<boolean> {
    if (halted) {
        return Promise.resolve(true);
    }
    restoreWatch ??= (async () => {
        try {
            const until = Date.now() + RESTORE_WATCH_MS;
            while (Date.now() < until && !halted) {
                await new Promise((resolve) => setTimeout(resolve, RESTORE_POLL_MS));
                const read = getResource(SECTION_KIND.ui, "main").then(
                    () => false,
                    (error) => error instanceof ResourceEpochMismatchError,
                );
                const budget = Math.max(0, Math.min(RESTORE_READ_MS, until - Date.now()));
                let timer: ReturnType<typeof setTimeout> | undefined;
                const timedOut = new Promise<false>((resolve) => {
                    timer = setTimeout(() => resolve(false), budget);
                });
                const replaced = await Promise.race([read, timedOut]);
                clearTimeout(timer);
                if (replaced) {
                    return true;
                }
            }
            return halted;
        } finally {
            restoreWatch = null;
        }
    })();
    return restoreWatch;
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

/** A record's own fields in a null-prototype dictionary (no client-only character keys), or null when it is not an object. */
function storedFields(data: unknown): Record<string, unknown> | null {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return null;
    }
    const copy = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
        if (!CHARACTER_LOCAL_KEYS.has(key)) {
            copy[key] = value;
        }
    }
    return copy;
}

const ABSENT = Symbol("absent");
const fieldOf = (record: Record<string, unknown>, field: string): unknown =>
    Object.hasOwn(record, field) ? record[field] : ABSENT;
const isStamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
/** The `statics` counts (`incrementStatic`). */
const STATIC_COUNTS = new Set(["imports", "messages"]);
/**
 * Values the character screen fills in for an absent field when it opens a character (the
 * `Toggles.svelte` checkbox binding): the only absent-field values taken while a generation runs on
 * the character.
 */
const OPEN_DEFAULTS: Readonly<Record<string, unknown>> = { supaMemory: false };

/**
 * What a conflicting record's server copy changed against the saved base, if every change is one
 * this client can take without losing or reinterpreting anything, else null. The changes are the
 * values the mirror must take (ABSENT: delete the field). Allowed, field by field (top level):
 * - a field the server holds as this client does (both made the same change);
 * - a field the base did not have and this client does not have either (another tab filled it in,
 *   such as a default its character screen binds); the server's value is taken. While a generation
 *   runs on the character (`generating`), only an `OPEN_DEFAULTS` value: anything else waits for
 *   the generation's deferral, so the running generation never sees a new setting;
 * - a character's `lastInteraction`: the later of two finite stamps (another tab opened or sent to
 *   the character);
 * - a `statics` count: best effort, the server's count plus this client's increments since the
 *   base (`imports`, `messages`; a count both tabs raised to the same value, or one a lost answer
 *   already holds, may be off by those increments).
 * Anything else (a substantive remote edit, even of a field this client did not touch) is a
 * conflict as before, so related fields (a group's member arrays) and a running generation's
 * character are never combined from two sources.
 */
function benignChanges(
    kind: string,
    saved: Record<string, unknown>,
    remote: Record<string, unknown>,
    local: Record<string, unknown>,
    generating: boolean,
): Map<string, unknown> | null {
    const changes = new Map<string, unknown>();
    for (const field of new Set([...Object.keys(saved), ...Object.keys(remote), ...Object.keys(local)])) {
        const [base, theirs, ours] = [fieldOf(saved, field), fieldOf(remote, field), fieldOf(local, field)];
        if (kind === RESOURCE_KIND.characters && field === "lastInteraction") {
            if (isEqual(theirs, ours) || (isStamp(theirs) && ours === ABSENT)) {
                if (!isEqual(theirs, ours)) {
                    changes.set(field, theirs);
                }
                continue;
            }
            if (!isStamp(theirs) && theirs === base) {
                continue;
            }
            if (!isStamp(theirs) || !isStamp(ours)) {
                return null;
            }
            if (theirs > ours) {
                changes.set(field, theirs);
            }
            continue;
        }
        if (kind === COLLECTION_KIND.statics && STATIC_COUNTS.has(field)) {
            const counted = (value: unknown) => (value === ABSENT ? 0 : value);
            const [b, t, o] = [counted(base), counted(theirs), counted(ours)];
            if (!isStamp(b) || !isStamp(t) || !isStamp(o)) {
                return null;
            }
            const merged = t + o - b;
            const value = Number.isSafeInteger(merged) && merged >= 0 ? merged : Math.max(t, o);
            if (value !== o) {
                changes.set(field, value);
            }
            continue;
        }
        if (isEqual(theirs, base) || isEqual(theirs, ours)) {
            continue;
        }
        if (
            base === ABSENT &&
            ours === ABSENT &&
            field !== "__proto__" &&
            (!generating || (Object.hasOwn(OPEN_DEFAULTS, field) && isEqual(theirs, OPEN_DEFAULTS[field])))
        ) {
            changes.set(field, theirs);
            continue;
        }
        return null;
    }
    return changes;
}

/**
 * A conflicting character or `statics` record whose server change this client can take
 * (`benignChanges`): another tab opened the character (its `lastInteraction` stamp and the
 * defaults its screen fills in) or counted a send. The changes go into the mirror, the base moves
 * to the server's revision, and the key stays dirty, so the next cycle writes the merged record.
 * Nothing is discarded and no reload notice is shown; a field taken from the server is announced to
 * the remote-change listeners (caches derived from the record). Not for a create, a delete, another
 * kind, a character whose reload already waits for its generation, or a taken field the mirror object
 * only inherits (`assignsInherited`).
 */
function mergeConcurrentChange(item: RemoteItem, key: string): boolean {
    const isCharacter = item.kind === RESOURCE_KIND.characters;
    if (!(isCharacter || item.kind === COLLECTION_KIND.statics) || item.revision === null) {
        return false;
    }
    if (isCharacter && deferredCharacters.has(item.id)) {
        return false;
    }
    const base = persisted.get(key);
    const projected = projectRecord(item.kind, item.id);
    if (!base || projected === undefined) {
        return false;
    }
    let saved: Record<string, unknown> | null;
    try {
        saved = storedFields(JSON.parse(base.text));
    } catch {
        return false;
    }
    const remote = storedFields(item.data);
    const local = storedFields(JSON.parse(projected));
    const generating = isCharacter && generatingCharacter() === item.id;
    const changes = remote && saved && local ? benignChanges(item.kind, saved, remote, local, generating) : null;
    if (!changes) {
        return false;
    }
    const target = (isCharacter ? findMirrorCharacter(item.id) : (DBState.db.statics ??= {} as Database["statics"])) as
        Record<string, unknown> | undefined;
    if (!target) {
        return false;
    }
    // A field the mirror object only inherits (`toString`, `constructor`, ...) cannot be assigned in
    // place on a Svelte proxy (`assignsInherited`): the merge would drop it and the next write would
    // remove it from the server. Such a record conflicts as before.
    if ([...changes].some(([field, value]) => value !== ABSENT && assignsInherited(target, field))) {
        return false;
    }
    // Every value is prepared before the mirror changes, so a value that cannot be copied applies nothing.
    let prepared: [string, unknown][];
    try {
        prepared = [...changes].map(([field, value]) => [field, value === ABSENT ? ABSENT : structuredClone(value)]);
    } catch {
        return false;
    }
    for (const [field, value] of prepared) {
        if (value === ABSENT) {
            delete target[field];
        } else {
            target[field] = value;
        }
    }
    // The saved base is the server's record. The local projection stands for it when the two are
    // equal (no echo write for a key-order difference); otherwise the next cycle writes the merge.
    const merged = projectRecord(item.kind, item.id)!;
    persisted.set(key, {
        revision: item.revision,
        text: isEqual(JSON.parse(merged), item.data) ? merged : recordText(item.kind, item.data),
    });
    markKey(key);
    if (prepared.some(([field]) => !(isCharacter && field === "lastInteraction"))) {
        for (const listener of remoteChangeListeners) {
            try {
                listener(item.kind, item.id);
            } catch (error) {
                console.error("[Save]", error);
            }
        }
    }
    return true;
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
    const generatingChats = new Set<string>();
    let generating = false;
    for (const conflict of error.conflicts) {
        if ("reason" in conflict && conflict.reason === "generating") {
            // A server job owns a message this change touches: keep the work, retry after the job.
            generating = true;
            if (isChatConflict(conflict)) {
                generatingChats.add(`${conflict.characterId}\u0000${conflict.id}`);
            } else if (!isChatOrderConflict(conflict)) {
                jobBlockedRecords.set(recordKey(conflict.kind, conflict.id), Date.now() + JOB_RETRY_MS);
            }
            continue;
        }
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
    const recovered = recoverChatConflicts(
        work,
        conflictedChats,
        conflictedOrders,
        (read.chats ?? []) as RemoteChat[],
        generatingChats,
    );
    if (generating || recovered.blocked) {
        showGeneratingNotice();
    }
    let reloaded = recovered.reloaded;
    for (const characterId of recovered.refresh) {
        // Read in `hydrateCharacters` (now, and again next cycle if the read fails).
        hydrate.add(characterId);
    }
    for (const item of read.items) {
        const key = recordKey(item.kind, item.id);
        const text = item.revision === null ? null : recordText(item.kind, item.data);
        if (text !== null && sent.get(key) === text) {
            persisted.set(key, { revision: item.revision!, text });
            continue;
        }
        if (mergeConcurrentChange(item, key)) {
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
    if (halted) {
        return false;
    }
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
    if (halted) {
        return;
    }
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
    const refs = idleChatRefreshes().slice(0, MAX_REMOTE_READS);
    if (refs.length === 0) {
        return;
    }
    // Taken before the read: a notice that arrives while the read is in flight keeps its mark, and a
    // chat found gone is removed only if its held revision did not change meanwhile.
    const notices = new Map(refs.map((ref) => [`${ref.chaId}\u0000${ref.chatId}`, chatNoticeSeq(ref)]));
    const issued = new Map(refs.map((ref) => [`${ref.chaId}\u0000${ref.chatId}`, heldChatRevision(ref)]));
    const read = await readRefs([], {
        chats: refs.map((ref) => ({ characterId: ref.chaId, id: ref.chatId })),
    });
    if (halted) {
        return;
    }
    for (const chat of read.chats ?? []) {
        const key = `${chat.characterId}\u0000${chat.id}`;
        if (
            finishIdleChatRefresh(chat as RemoteChat, notices.get(key) ?? 0, issued.get(key)) &&
            chat.revision === null
        ) {
            // The chat is gone: the character's list is read again, never discarding local work.
            noteRemoteCollection(chat.characterId);
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
    if (halted) {
        return;
    }
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

/** Puts a section or settings collection record into `DBState.db` (and `llmSecretState`). */
function applySettingsRecord(
    kind: SectionKind | CollectionKind,
    data: unknown,
    secretInvalidate: SecretPath[] | "all" = "all",
) {
    if (data === null) {
        // Singletons: the server never deletes them.
        return;
    }
    if (isSection(kind)) {
        if (kind === SECTION_KIND.llmSecrets) {
            // The masked record: its siblings into the mirror (its credential fields `""`), its
            // status into `llmSecretState`.
            replaceFields(SECTION_FIELDS[kind], mirrorFields(data as Record<string, unknown>));
            setMaskedSecrets(data as MaskedLlmSecrets, secretInvalidate);
            return;
        }
        replaceFields(SECTION_FIELDS[kind], data as Record<string, unknown>);
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
 * The owner of a kind whose records live outside the mirror (`inlays`, `pluginPermissions`): a live
 * update of such a record goes to `apply` with its id and revision (null: deleted); after a
 * reconnect, `reconcile` gets every id the server lists for the kind with its revision (an id it
 * holds that is not listed was deleted meanwhile).
 */
export type RemoteResourceOwner = {
    apply: (id: string, revision: string | null) => void;
    reconcile?: (listed: ReadonlyMap<string, string>) => void;
};

/** Registers (or, with null, removes) the owner of a kind outside the mirror. */
export function setRemoteResourceOwner(kind: string, owner: RemoteResourceOwner | null) {
    if (owner) {
        remoteOwners.set(kind, owner);
    } else {
        remoteOwners.delete(kind);
    }
}

const isMirroredKind = (kind: string) => kind === RESOURCE_KIND.characters || COLLECTIONS.includes(kind as Collection);

function noteRemoteCollection(chaId: string) {
    remoteCollectionSeq += 1;
    remoteCollections.set(chaId, remoteCollectionSeq);
}

/** A character this client does not hold yet whose record waits to be read (a new character). */
function awaitsInsertion(chaId: string): boolean {
    return remoteRecords.get(recordKey(RESOURCE_KIND.characters, chaId))?.revision != null;
}

function runOwner(kind: string, run: (owner: RemoteResourceOwner) => void) {
    const owner = remoteOwners.get(kind);
    if (!owner) {
        return;
    }
    try {
        run(owner);
    } catch (error) {
        console.error("[Save]", error);
    }
}

/**
 * A live update: the refs and revisions one committed write changed (the change feed). Each is
 * compared with what this client holds when it arrives, and one that is not newer is dropped (this
 * client's own save, or a job event that applied it first). A newer record waits for the cycle,
 * which reads and applies it while this client has no unsent change of it (`applyRemoteUpdates`); a
 * chat goes to the chat module's idle refresh; a new chat or a changed chat order reads the
 * character's chat list (also for a character still waiting to be inserted). Never an outgoing
 * write, a discard, or a notice.
 */
export function noteRemoteChanges(changes: ChangeSet) {
    if (halted || !started) {
        return;
    }
    let woke = false;
    for (const ref of changes.resources) {
        if (remoteOwners.has(ref.kind)) {
            runOwner(ref.kind, (owner) => owner.apply(ref.id, ref.revision));
            continue;
        }
        if (!isMirroredKind(ref.kind)) {
            continue;
        }
        const key = recordKey(ref.kind, ref.id);
        const held = persisted.get(key);
        if (ref.revision === null && !held) {
            // A record created and deleted before this client read it: nothing to read any more.
            remoteRecords.delete(key);
            continue;
        }
        if (ref.revision !== null && held && (compareRevision(ref.revision, held.revision) ?? 0) <= 0) {
            continue;
        }
        if (!held && ref.kind !== RESOURCE_KIND.characters) {
            // Singletons are seeded at boot; one this client does not hold is not its data.
            continue;
        }
        const waiting = remoteRecords.get(key);
        if (
            waiting &&
            waiting.revision !== null &&
            ref.revision !== null &&
            (compareRevision(ref.revision, waiting.revision) ?? 0) <= 0
        ) {
            continue;
        }
        remoteRecords.set(key, { kind: ref.kind, id: ref.id, revision: ref.revision });
        woke = true;
    }
    for (const chat of changes.chats) {
        if (!findMirrorCharacter(chat.characterId)) {
            if (chat.revision !== null && awaitsInsertion(chat.characterId)) {
                noteRemoteCollection(chat.characterId);
                woke = true;
            }
            continue;
        }
        const outcome = noteRemoteChat({ chaId: chat.characterId, chatId: chat.id }, chat.revision);
        if (outcome === "collection") {
            noteRemoteCollection(chat.characterId);
        }
        woke ||= outcome !== "ignored";
    }
    for (const order of changes.chatOrders) {
        if (order.revision === null) {
            // A deleted character's order goes with it.
            continue;
        }
        if (!findMirrorCharacter(order.characterId)) {
            if (awaitsInsertion(order.characterId)) {
                noteRemoteCollection(order.characterId);
                woke = true;
            }
            continue;
        }
        const held = heldOrderRevision(order.characterId);
        if (held !== null && (compareRevision(order.revision, held) ?? 0) <= 0) {
            continue;
        }
        noteRemoteCollection(order.characterId);
        woke = true;
    }
    if (woke) {
        schedule(REMOTE_DELAY_MS);
    }
}

/**
 * Reconciles with the server's revision listing (after every `hello` of the live-update socket, so
 * nothing committed while it was disconnected is missed): every listed record, chat, and order goes
 * through `noteRemoteChanges`, every one this client holds that the server no longer lists is a
 * deletion, and each owner outside the mirror reconciles its own records.
 */
export function reconcileRemote(listing: ResourceRevisionListing) {
    const changes: ChangeSet = {
        resources: listing.resources.filter((entry) => !remoteOwners.has(entry.kind)),
        chats: [...listing.chats],
        chatOrders: [...listing.chatOrders],
    };
    const listed = new Set(listing.resources.map((entry) => recordKey(entry.kind, entry.id)));
    for (const key of persisted.keys()) {
        const separator = key.indexOf("\u0000");
        const kind = key.slice(0, separator);
        if (!listed.has(key) && !remoteOwners.has(kind)) {
            changes.resources.push({ kind, id: key.slice(separator + 1), revision: null });
        }
    }
    const listedChats = new Set(listing.chats.map((chat) => `${chat.characterId}\u0000${chat.id}`));
    for (const { ref } of heldChatRefs()) {
        if (!listedChats.has(`${ref.chaId}\u0000${ref.chatId}`)) {
            changes.chats.push({ characterId: ref.chaId, id: ref.chatId, revision: null });
        }
    }
    for (const kind of remoteOwners.keys()) {
        const ofKind = new Map(
            listing.resources.filter((entry) => entry.kind === kind).map((entry) => [entry.id, entry.revision]),
        );
        runOwner(kind, (owner) => {
            if (owner.reconcile) {
                owner.reconcile(ofKind);
            } else {
                for (const [id, revision] of ofKind) {
                    owner.apply(id, revision);
                }
            }
        });
    }
    noteRemoteChanges(changes);
}

/** Whether a live update of `key` may be applied now: this client has no unsent change of it. */
function canApplyRemote(key: string, entry: { kind: string; id: string; blockedLocal?: string }): boolean {
    if (sendingKeys.has(key) || recordQuarantine(key) || isRecordJobBlocked(key)) {
        return false;
    }
    if (
        entry.kind === RESOURCE_KIND.characters &&
        (deferredCharacters.has(entry.id) || generatingCharacter() === entry.id)
    ) {
        return false;
    }
    const held = persisted.get(key);
    if (!held) {
        // A character this client does not hold yet; one it created and has not saved waits for its save.
        return entry.kind === RESOURCE_KIND.characters && !findMirrorCharacter(entry.id);
    }
    const local = projectRecord(entry.kind, entry.id);
    if (entry.kind === SECTION_KIND.llmSecrets) {
        // Decided against the server's siblings once read (`adoptRemoteSecretRecord`).
        return local !== entry.blockedLocal;
    }
    return local === held.text;
}

/** Drops waiting live updates this client already holds (its own save, a conflict reload, a job event). */
function settleRemoteRecords() {
    for (const [key, entry] of remoteRecords) {
        const held = persisted.get(key);
        if (entry.revision === null ? !held : held && (compareRevision(entry.revision, held.revision) ?? 0) <= 0) {
            remoteRecords.delete(key);
        }
    }
    for (const id of remoteCollections.keys()) {
        if (!findMirrorCharacter(id) && !awaitsInsertion(id)) {
            remoteCollections.delete(id);
        }
    }
}

/** The chat lists a cycle may read now: characters in the mirror with no order work. */
function applicableCollections(): string[] {
    return [...remoteCollections.keys()].filter((id) => findMirrorCharacter(id) && canApplyRemoteCollection(id));
}

function hasRemoteWork(): boolean {
    settleRemoteRecords();
    for (const [key, entry] of remoteRecords) {
        if (canApplyRemote(key, entry)) {
            return true;
        }
    }
    return applicableCollections().length > 0;
}

/**
 * Adopts the server's `llmSecrets` record from a live update: its revision, masked status, and
 * siblings, judged by text against the saved siblings, as `adoptSecretRecord` does, with every
 * credential path invalidated (two keys can share a status). Where a local sibling edit meets a
 * changed server sibling, nothing is applied and false is returned: the save's 409 decides.
 */
function adoptRemoteSecretRecord(revision: string, masked: MaskedLlmSecrets): boolean {
    const key = collectionKey(SECTION_KIND.llmSecrets);
    const saved = persisted.get(key)?.text;
    const remote = llmSecretsText(masked);
    const local = projectCollection(SECTION_KIND.llmSecrets);
    if (local === saved) {
        persisted.set(key, { revision, text: remote });
        applySettingsRecord(SECTION_KIND.llmSecrets, masked, "all");
        return true;
    }
    if (remote === saved) {
        persisted.set(key, { revision, text: remote });
        setMaskedSecrets(masked, "all");
        return true;
    }
    return false;
}

/** Puts a live update into the mirror as the server holds it: no discard, no settled key, no notice. */
function applyRemoteRecord(
    item: { kind: string; id: string; revision: string | null; data: unknown },
    collection?: { characterId: string; order: ChatOrderRecord | null; chats: ChatRecord[] },
) {
    const key = recordKey(item.kind, item.id);
    const isNew = item.kind === RESOURCE_KIND.characters && !persisted.has(key);
    applyToMirror(item.kind, item.id, item.revision === null ? null : item.data);
    if (item.revision === null) {
        persisted.delete(key);
    } else {
        persisted.set(key, {
            revision: item.revision,
            text: projectRecord(item.kind, item.id) ?? recordText(item.kind, item.data),
        });
    }
    if (isSettingsCollection(item.kind) || item.kind === RESOURCE_KIND.presets) {
        // The preset and persona selections are this tab's: resolve them against the new list.
        reconcileSelection(DBState.db);
    }
    if (isNew && collection) {
        applyRemoteCollection(collection);
    }
    notifyRemoteListeners(item.kind, item.id);
}

/**
 * Reads and applies the waiting live updates (part of the cycle, before its batch, so it never races
 * this client's own write): the records this client can take now and the chat lists of characters
 * with no order work, at most `MAX_REMOTE_READS` of each. Eligibility is checked again after the
 * read: a change made meanwhile keeps the update waiting. A read settles only the notice it was
 * issued for, or a later one its answer covers. A deletion applies only if the held revision is
 * unchanged since the read was issued; otherwise it is read again.
 */
async function applyRemoteUpdates() {
    settleRemoteRecords();
    const records = [...remoteRecords].filter(([key, entry]) => canApplyRemote(key, entry)).slice(0, MAX_REMOTE_READS);
    const newCharacters = new Set(
        records
            .filter(
                ([key, entry]) =>
                    entry.kind === RESOURCE_KIND.characters && !persisted.has(key) && entry.revision !== null,
            )
            .map(([, entry]) => entry.id),
    );
    const collections = [...newCharacters, ...applicableCollections().filter((id) => !newCharacters.has(id))].slice(
        0,
        MAX_REMOTE_READS,
    );
    if (records.length === 0 && collections.length === 0) {
        return;
    }
    const issuedEntries = new Map(records);
    const issuedHeld = new Map(records.map(([key]) => [key, persisted.get(key)?.revision ?? null]));
    const issuedSeqs = new Map(collections.map((id) => [id, remoteCollections.get(id)]));
    const issuedChats = new Map(collections.map((id) => [id, heldChatRevisionsOf(id)]));
    const read = await readRefs(
        records.map(([, entry]) => ({ kind: entry.kind, id: entry.id })),
        { chatCollections: collections },
    );
    await tick();
    if (halted) {
        return;
    }
    const collectionOf = new Map((read.chatCollections ?? []).map((entry) => [entry.characterId, entry]));
    for (const item of read.items) {
        const key = recordKey(item.kind, item.id);
        const entry = remoteRecords.get(key);
        if (!entry) {
            continue;
        }
        const held = persisted.get(key);
        // The notice the read was issued for, or a later one the answer covers.
        const settled =
            entry === issuedEntries.get(key) ||
            (entry.revision !== null &&
                item.revision !== null &&
                (compareRevision(entry.revision, item.revision) ?? 0) <= 0);
        if (item.revision === null) {
            if (!held) {
                if (settled) {
                    remoteRecords.delete(key);
                }
                continue;
            }
            if (held.revision !== issuedHeld.get(key) || !canApplyRemote(key, entry)) {
                continue;
            }
            applyRemoteRecord(item);
            if (settled) {
                remoteRecords.delete(key);
            }
            continue;
        }
        if (held && (compareRevision(item.revision, held.revision) ?? 0) <= 0) {
            if (settled) {
                remoteRecords.delete(key);
            }
            continue;
        }
        if (!canApplyRemote(key, entry)) {
            continue;
        }
        if (item.kind === SECTION_KIND.llmSecrets) {
            if (!adoptRemoteSecretRecord(item.revision, item.data as MaskedLlmSecrets)) {
                entry.blockedLocal = projectCollection(SECTION_KIND.llmSecrets);
                continue;
            }
            notifyRemoteListeners(item.kind, item.id);
        } else {
            applyRemoteRecord(item, collectionOf.get(item.id));
        }
        if (settled) {
            remoteRecords.delete(key);
        }
    }
    for (const id of collections) {
        const collection = collectionOf.get(id);
        const applied = newCharacters.has(id)
            ? findMirrorCharacter(id) !== undefined
            : !!collection && applyRemoteCollection(collection, issuedChats.get(id));
        if ((applied || !collection) && remoteCollections.get(id) === issuedSeqs.get(id)) {
            remoteCollections.delete(id);
        }
    }
}

function notifyRemoteListeners(kind: string, id: string) {
    for (const listener of remoteChangeListeners) {
        try {
            listener(kind, id);
        } catch (error) {
            console.error("[Save]", error);
        }
    }
}

/** The revision of a record this client holds as saved, or null (read only; the job channel's barrier). */
export function heldRecordRevision(kind: string, id: string): string | null {
    return persisted.get(recordKey(kind, id))?.revision ?? null;
}

/**
 * A record a server generation job sent (`resource` event): an update, never a deletion.
 * `job`: a job chat event's job and its messages still generating (see `hydrateChat`).
 */
export type HydrationRecord = {
    kind: string;
    id: string;
    characterId?: string;
    revision: string;
    data: unknown;
    job?: { jobId: string; streaming: readonly StreamingMessage[] };
};

/**
 * Applies a record a server generation job sent, as the server holds it, without it ever becoming
 * an outgoing write (PLAN invariant 2): no discard, no `discardSequence` bump, no settled key, no
 * notice. Applied only when the token is of the loaded epoch and newer by `(seq, revision)` than
 * the one this client holds, and the client has no local change of it: not in the batch in flight,
 * its projection still equal to the saved text (a dirty mark alone is no change), not refused for a
 * generating message, and (a character) not deferred behind a generation. A record refused for a
 * local change is kept (the newest) and checked again after the next save cycle. A record this client does not hold, a
 * deletion, `llmSecrets`, and `authRefreshes` are not hydrated. A chat goes to `hydrateChat`.
 * Returns whether it applied.
 */
export function applyHydration(record: HydrationRecord): boolean {
    if (halted || HIDDEN_HYDRATION_KINDS.includes(record.kind) || record.data === null || record.data === undefined) {
        return false;
    }
    if (parseRevisionToken(record.revision)?.epoch !== getResourceEpoch()) {
        return false;
    }
    if (record.kind === "chats") {
        return typeof record.characterId === "string"
            ? hydrateChat(
                  {
                      characterId: record.characterId,
                      id: record.id,
                      revision: record.revision,
                      data: record.data as Chat,
                  },
                  record.job,
              )
            : false;
    }
    if (record.kind !== RESOURCE_KIND.characters && !COLLECTIONS.includes(record.kind as Collection)) {
        return false;
    }
    const key = recordKey(record.kind, record.id);
    const held = persisted.get(key);
    if (!held) {
        return false;
    }
    const order = compareRevision(record.revision, held.revision);
    if (order === null || order <= 0) {
        return false;
    }
    if (sendingKeys.has(key) || isRecordJobBlocked(key) || projectRecord(record.kind, record.id) !== held.text) {
        // A local change (or one being sent): keep the newest event and check it again after the
        // next cycle; by then the save has landed (and is older) or conflicted and reloaded. A dirty
        // mark alone, with the projection still equal to the saved text, is no change.
        const waiting = deferredHydrations.get(key);
        if (!waiting || (compareRevision(record.revision, waiting.revision) ?? 0) > 0) {
            deferredHydrations.set(key, record);
        }
        return false;
    }
    if (
        record.kind === RESOURCE_KIND.characters &&
        (deferredCharacters.has(record.id) || generatingCharacter() === record.id)
    ) {
        return false;
    }
    applyToMirror(record.kind, record.id, record.data);
    persisted.set(key, {
        revision: record.revision,
        text: projectRecord(record.kind, record.id) ?? JSON.stringify(record.data),
    });
    for (const listener of remoteChangeListeners) {
        try {
            listener(record.kind, record.id);
        } catch (error) {
            console.error("[Save]", error);
        }
    }
    return true;
}

/**
 * Where a mutation scope began: the resource and chat discard sequences at that moment. See
 * `beginMutationScope`.
 */
export interface MutationScope {
    readonly resource: number;
    readonly chat: number;
}

/**
 * Starts a mutation scope: `flushResources({ scope })` then reports every key a conflict discarded
 * since this call, including one discarded before the flush began. A caller that must know a
 * callback's writes persisted begins a scope before the callback and flushes with it after; a
 * non-empty `discarded` list fails the callback. The check is a time window, not an attribution: a
 * discard of an unrelated write in the window counts too (a conservative failure).
 */
export function beginMutationScope(): MutationScope {
    return { resource: discardSequence, chat: chatDiscardSequence() };
}

/** `flushResources` refused: a change it must save waits for a generation (this tab's or a server job's). */
export class GenerationBlockedError extends Error {
    constructor() {
        super("A character is still being generated; try again when it finishes");
        this.name = "GenerationBlockedError";
    }
}

/** How many times `chatGenerating` was shown by the save adapter (a caller tells whether its flush showed it). */
let generatingNotices = 0;

export function generatingNoticeCount(): number {
    return generatingNotices;
}

/** Shows `chatGenerating` once per refusal episode (until no saved work waits for a job any more). */
function showGeneratingNotice() {
    if (generatingNoticeShown) {
        return;
    }
    generatingNoticeShown = true;
    generatingNotices += 1;
    alertNormal(language.chatGenerating);
}

/**
 * Saves everything that was changed before this call. Resolves once it is on the server, with the
 * keys whose local edits a conflict replaced since the call (with `scope`, since the scope began);
 * rejects when saving fails or when a character that must be saved is still being generated.
 */
export async function flushResources(options: { scope?: MutationScope } = {}): Promise<{ discarded: string[] }> {
    await tick();
    const refused = quarantineReason();
    if (refused) {
        throw refused;
    }
    // What must be settled: every key dirty now, at its current generation, every membership
    // change so far (a later mark of the same key raises the bar but never lowers it), and every
    // chat and chat order with queued or in-flight work.
    const obligations = new Map(dirty);
    if (collectMembershipChanges()) {
        markMembership();
    }
    const chatObligations = captureChatObligations();
    const membershipTarget = membershipGeneration;
    const firstDiscard = (options.scope?.resource ?? discardSequence) + 1;
    const firstChatDiscard = options.scope?.chat ?? chatDiscardSequence();
    const unsettled = () =>
        [...obligations].filter(([key, marked]) => (acked.get(key) ?? 0) < marked).map(([key]) => key);
    const hydrating = new Set(hydrate);
    const secretTarget = new Set(llmSecretState.queue.map((op) => op.id));
    const pending = () =>
        llmSecretState.queue.some((op) => secretTarget.has(op.id)) ||
        unsettled().length > 0 ||
        membershipAcked < membershipTarget ||
        unsettledChatObligations(chatObligations).length > 0 ||
        [...hydrating].some((id) => hydrate.has(id));
    for (let attempt = 0; attempt < 10 && pending(); attempt += 1) {
        if (halted) {
            throw new Error("Saving stopped: the server data was restored");
        }
        if (
            unsettled().some(isBlockedKey) ||
            unsettledChatObligations(chatObligations).some(isChatDeferred) ||
            [...jobBlockedRecords.keys()].some(isRecordJobBlocked)
        ) {
            throw new GenerationBlockedError();
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
    setMutationAdmission(() => !halted);
    setSecretScheduler(() => {
        permanentError = null;
        schedule();
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
    // One shared budget, including requests still in flight from an earlier pagehide: by-id chat work,
    // one request per chat. Resource writes use only normal cycles, so they never race a keepalive
    // write on the same revision.
    let unloadBytes = 0;
    function sendUnload(request: { body: string; work: ChatWork }) {
        const bytes = utf8ByteLength(request.body);
        if (bytes + unloadBytes > UNLOAD_BODY_LIMIT) {
            return;
        }
        if (
            sendBatchOnUnload(request.body, (result) => {
                unloadBytes -= bytes;
                settleUnloadWork(request.work, result?.chats ?? null);
            })
        ) {
            unloadBytes += bytes;
            trackUnloadWork(request.work);
        }
    }
    window.addEventListener("pagehide", () => {
        try {
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
        // Each section and each settings collection: the projection reads exactly the fields the record
        // holds, so an edit marks only its own record.
        for (const collection of [...SECTIONS, ...SETTINGS_COLLECTIONS] as const) {
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
