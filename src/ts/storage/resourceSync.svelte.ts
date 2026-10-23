import isEqual from "lodash/isEqual";
import { tick, untrack } from "svelte";
import type { ChatOrderRecord, ChatSummary } from "../../../shared/chats.ts";
import { HIDDEN_HYDRATION_KINDS, type StreamingMessage } from "../../../shared/jobs.ts";
import {
    compareRevision,
    isChatConflict,
    isChatOrderConflict,
    parseRevisionToken,
    RESOURCE_KIND,
    type ChangeSet,
    type RecordPatch,
    type ResourceBatchResult,
    type ResourceReadKindsResult,
    type ResourceRevisionListing,
    SINGLETON_RESOURCE_ID,
} from "../../../shared/resources.ts";
import {
    COLLECTION_KIND,
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
import { alertError, alertNormal, alertReloadNotice, alertTerminal } from "../alert";
import { assignsInherited, CHARACTER_FIXED_FIELDS } from "./mutationValidation";
import { PLUGIN_STORAGE_KEY, SAFE_LOCAL_PLUGIN_STORAGE_KEY } from "./pluginStorageStore.svelte";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { applyItemPatch, checkFields, checkItemPatch, itemIds, withFields } from "../../../shared/recordPatch.ts";
import { CHARACTER_SHAPE_FIELDS, normalizeCharacter } from "../../../shared/characters.ts";
import { reconcileSelection } from "./settingsViews.svelte";
import {
    applyRaw,
    applyRawCharacter,
    characterData,
    characterFieldStamp,
    moduleItemFieldStamp,
    patchRawCharacter,
    recordData,
    REMOVE_FIELD,
    setCharacterWriteListener,
    setRecordWriteListener,
    trackedCharacters,
    type RecordKind,
} from "./records.svelte";
import { flushClientDiagnostics, recordClientEvent } from "../diagnostics/collector";
import type { character, Chat, Database, groupChat } from "./database.svelte";
import {
    type ChatRef,
    acceptRemoteCollection,
    ackChatWork,
    applyRemoteCollection,
    canApplyRemoteCollection,
    heldChatRefs,
    heldChatRevision,
    heldChatRevisionsByCharacter,
    heldOrderRevision,
    noteRemoteChat,
    adoptCharacter,
    captureChatObligations,
    chatDiscardSequence,
    chatOwnerToken,
    chatJobRetryAt,
    chatDiscardsSince,
    type ChatWork,
    chatWorkBody,
    forgetCharacter,
    settleCharacterDelete,
    ackCharacterDelete,
    hasChatWork,
    hydrateChat,
    hydrateChatPatch,
    isChatBehind,
    type ChatPatch,
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
    idleSummaryRefreshes,
    scheduleTrim,
    settleSummaryRefresh,
    summaryRefreshNotices,
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
 * The write adapter: the records (`records.svelte.ts`) and the chat module are the live model, and
 * this module writes them back to the server resources per collection: the settings sections and
 * collections (`shared/sections.ts`; `llmSecrets` also carries `llmSecretPresets`), `presets`,
 * `modules`, `plugins`, `pluginStorage`, and one `characters` record per `chaId`. Chats are not part
 * of a character record: the chat module (`chatStore.svelte.ts`) queues explicit chat operations,
 * and each cycle sends them in the same batch, after the resource ops.
 *
 * - The settings records (the sections, the collections, `presets`, `modules`, `plugins`,
 *   `pluginStorage`) are write-through records (`records.svelte.ts`): every local write of one
 *   marks it here at once (`setRecordWriteListener`), and every server copy goes in through
 *   `applyRaw`, which marks nothing. The characters are write-through records too: a write of a
 *   character's own fields marks it (`setCharacterWriteListener`), a
 *   membership change (add, replace, remove through `characterStore`) wakes the loop, and a server
 *   copy goes in through `applyRawCharacter`/`patchRawCharacter`, which mark nothing.
 * - A cycle serializes each dirty collection and skips it when the text equals what the server
 *   holds (`persisted`), so hydration and no-op re-renders never become writes. Character membership
 *   is diffed by `chaId` every cycle: a new id is created, a vanished one deleted.
 * - One batch per cycle, one cycle in flight. A key stays dirty if it was marked again while its
 *   batch was in flight.
 * - A 409 reloads the conflicting records into the mirror (another tab or device wrote them) and
 *   shows `resourceReloaded` as the reload notice (`alertReloadNotice`: its own store, kept until the
 *   user dismisses it, so one notice per episode on screen); a 412 (the server was restored) stops saving and
 *   reloads the page. A server generation job reads its own configuration and refreshes character
 *   records from the server, so a conflict reload of a character it runs on applies at once.
 * - A 409 entry with `reason: "generating"` (a server generation job owns a message the change
 *   touches) is not a reload: the work stays unsaved and is retried after `JOB_RETRY_MS`, and
 *   `chatGenerating` is shown once per refusal episode. A chat's edits of the locked messages the
 *   entry names (`messageIds`) are dropped instead (`recoverChatConflicts`), with the reload notice.
 * - `applyHydration` applies a record a server job sent, without any outgoing write.
 * - Live updates (`noteRemoteChanges`, from the change feed, `network/eventFeed.ts`): records another
 *   writer committed are read and applied inside the cycle, before its batch, only while this client
 *   has no unsent change of them; nothing is discarded and no notice is shown. A record with a local
 *   change waits: its save then lands (the update is older) or conflicts (the normal 409 path).
 *
 * Transport state here is plain (no runes); only `saving` is reactive.
 */

type ListCollection = "presets" | "modules" | "plugins" | "pluginStorage";
type Collection = ListCollection | SectionKind | CollectionKind;

/** A top-level field of a record's text: its name, and where its value's JSON text is in that text. */
type FieldSpan = [key: string, start: number, end: number];
/**
 * A record's JSON text in parts, what a save diffs to send a patch: an object's top-level fields,
 * or an array's items by id (each item's span and fields), as spans of `source`, the text they
 * were built with (a projection's own text, so the parts hold no copy of it).
 */
type RecordParts =
    | { type: "fields"; source: string; fields: FieldSpan[] }
    | { type: "items"; source: string; items: { id: string; start: number; end: number; fields: FieldSpan[] }[] };
/** A record's text with its parts (null: it has none, it is saved whole). */
type Projection = { text: string; parts: RecordParts | null };
/**
 * What this client holds as the server's copy of a record: its revision and text, and `parts` once
 * computed for that text (`baseParts`; null when the record has none). An entry is replaced, never
 * changed, when its text changes, so cached parts always belong to its text.
 */
type Persisted = { revision: string; text: string; parts?: RecordParts | null };

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
const DEBOUNCE_MS = 500;
const MAX_BACKOFF_MS = 30_000;
/** Largest batch body the server accepts (its global body limit is 100 MiB), in UTF-8 bytes. */
const MAX_BATCH_BYTES = 100 * 1024 * 1024 - 64 * 1024;
const MAX_BATCH_OPERATIONS = 5000;
/** Bytes of the batch envelope around its parts: `{"ops":[],"chats":[],"chatOrders":[]}`. */
const BATCH_FRAME_BYTES = 38;

/** Character fields that are client-only: chats (saved on their own), the selection, a render key. */
const CHARACTER_LOCAL_KEYS = new Set(["chats", "chatPage", "reloadKeys"]);

/**
 * A character's last projection (`characterProjection`): its text, and per top-level field the value
 * (identity) and field-text stamp (`characterFieldStamp`) its span of that text was serialized from.
 */
type FieldTextCache = {
    source: string;
    fields: Map<string, { value: unknown; stamp: number; start: number; end: number }>;
};
/** The field-text caches of the characters projected last, oldest first (`characterProjection`). */
const characterTexts = new Map<string, FieldTextCache>();
/**
 * Only the last live modules projection: one source text, with per-element field spans. Rebuilt
 * each cycle so retained/removed elements cannot keep older source texts alive through this cache.
 * Identity, not id: duplicate ids disable patches, but do not disable field-text reuse.
 */
let moduleTexts: { source: string; items: WeakMap<object, FieldTextCache["fields"]> } | null = null;
/** At most this many characters, and this many UTF-16 units of their texts, are cached. */
const CHARACTER_TEXTS_MAX = 8;
const CHARACTER_TEXTS_MAX_UNITS = 64 * 1024 * 1024;

export const saving = $state({ state: false });

const recordKey = (kind: string, id: string) => `${kind}\u0000${id}`;
const collectionKey = (collection: Collection) => recordKey(collection, SINGLETON_RESOURCE_ID);
const characterPrefix = recordKey(RESOURCE_KIND.characters, "");
const characterKey = (id: string) => recordKey(RESOURCE_KIND.characters, id);

/** What the server holds for each record this client knows: `<kind>\0<id>` → revision and JSON text. */
const persisted = new Map<string, Persisted>();
/**
 * The text this client sent for a record whose answer was lost (a network failure or a 5xx, not a
 * refusal), on the saved base revision it was sent on: the server holds it or still the saved copy.
 * Keyed like `persisted`. While a key has one, every cycle resends exactly that text on that base
 * (`collectOperations`), and the key's newer text, a revert to the saved text included, waits for
 * the next cycle: on a given base only one write can land, so one text per key is enough, and the
 * retry's answer (or its 409's read, compared with the op as for any retry) settles it. A live
 * update or a job's record does not go into the mirror meanwhile (`canApplyRemote`,
 * `applyHydration`). A feed patch (`applyRemotePatch`) or a conflict read (`recoverConflictedWork`,
 * say for a delete sent after it) equal to it is the lost write: it becomes the saved base at the
 * server's revision with no discard, and the newer text is sent on it. Cleared then, on the
 * acknowledgement of a write of the key, when the server refuses that text (400, 413), and when a
 * conflict replaces the record.
 */
const inDoubt = new Map<string, { baseRevision: string | null; text: string; parts: RecordParts | null }>();
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
/**
 * Characters whose chat list an acknowledgement of this client's own write showed another writer
 * changed (`ackChatWork`): read and applied as a live update that keeps a queued reorder
 * (`applyRemoteCollection` with `keepPendingOrder`), unless a kept chat with a held revision is
 * missing from the server's list: then the reorder is discarded with the notice and report. Their
 * reorders wait until then.
 */
const listRefresh = new Set<string>();
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
 * What a conflict discarded of this client's unsaved `pluginStorage` edits: the keys of the two
 * reserved dictionaries whose local value the server copy replaced, and whether any other top-level
 * value (a `setDatabase` custom key, a reserved name replaced by a value that is no dictionary, or a
 * reserved dictionary this client created, removed, or turned from a list into an object) was
 * replaced too. Custom key names are not listed: reading them takes the plugin `db` permission.
 */
export type PluginStorageDiscard = { pluginStorage: string[]; localPluginStorage: string[]; customStorage: boolean };
type PluginStorageDiscardListener = (lost: PluginStorageDiscard) => void;
const pluginStorageDiscardListeners = new Set<PluginStorageDiscardListener>();
/**
 * Live updates waiting to be read and applied inside the cycle: record key → the newest revision
 * another writer committed (null: deleted). `blockedLocal`: the `llmSecrets` siblings this client
 * held unsent when the server's siblings had changed too; the entry waits for that local text to
 * change (its save or a conflict settles it). `patch`: the notice's record patch, applied without a
 * read if this client still holds its base when the cycle runs (`applyRemotePatch`).
 */
const remoteRecords = new Map<
    string,
    { kind: string; id: string; revision: string | null; blockedLocal?: string; patch?: RecordPatch }
>();
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

/** Records what the server holds, from the boot read. Call before the boot installs the records. */
export function seedResources(result: ResourceReadKindsResult) {
    setResourceEpoch(result.epoch);
    persisted.clear();
    inDoubt.clear();
    characterTexts.clear();
    moduleTexts = null;
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
 * Registers a listener called after a server record replaced the mirror's copy (a conflict reload
 * or a deferred reload): another tab or device wrote it, so caches derived from it may be stale.
 */
export function onRemoteRecordApplied(listener: RemoteChangeListener): () => void {
    remoteChangeListeners.add(listener);
    return () => {
        remoteChangeListeners.delete(listener);
    };
}

/**
 * Registers a listener called after a conflict discarded unsaved `pluginStorage` edits of this
 * client (the record's entry in the discard report, `flushResources`), with what it lost; it is
 * not called when the conflict was merged (`mergeConcurrentChange`) or lost nothing.
 */
export function onPluginStorageDiscarded(listener: PluginStorageDiscardListener): () => void {
    pluginStorageDiscardListeners.add(listener);
    return () => {
        pluginStorageDiscardListeners.delete(listener);
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

/** Whether anything waits to be saved or reloaded. */
function hasPendingWork(): boolean {
    if (
        hasPendingMembership(true) ||
        hasChatWork(canSaveCharacter) ||
        hydrate.size > 0 ||
        listRefresh.size > 0 ||
        llmSecretState.queue.some((op) => !awaitsOwnerDeletion(op)) ||
        hasRemoteWork()
    ) {
        return true;
    }
    for (const key of dirty.keys()) {
        // A delete refused for a generating message stays unsaved but waits for its retry.
        if (!recordQuarantine(key) && !isRecordJobBlocked(key)) {
            return true;
        }
    }
    return false;
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
 * A settings record's text as the server stores it, from the record (`records.svelte.ts`), read
 * untracked: the live value straight from the `$state` data (`$state.snapshot` would drop an own
 * `__proto__` key of a user-keyed map: `globalChatVariables`, `OaiCompAPIKeys`, plugin storage), so
 * the text equals the server's normalized text on an idle boot. A section's fields go in
 * `SECTION_FIELDS` order and an `undefined` one is left out, as the normalizer does.
 */
function projectCollection(collection: Collection): string | undefined {
    const record = recordData<Record<string, unknown>>(collection as RecordKind);
    if (record === undefined) {
        // An absent record (no plugin storage yet) has nothing to write.
        return undefined;
    }
    if (isSection(collection)) {
        if (collection === SECTION_KIND.llmSecrets) {
            // Its readable siblings only: the credentials are written through `/api/llm-secrets`.
            return llmSecretsText(record);
        }
        const ordered: Record<string, unknown> = {};
        for (const field of SECTION_FIELDS[collection]) {
            ordered[field] = record[field];
        }
        return JSON.stringify(ordered);
    }
    if (collection === RESOURCE_KIND.modules) {
        return moduleProjection(record).text;
    }
    // User-chosen keys (plugin storage, a preset's `seperateParameters.overrides`, the credential
    // maps): serialized straight from the live record; `$state.snapshot` would drop an own
    // `__proto__` key.
    return JSON.stringify(record);
}

/**
 * Whether `JSON.stringify` would call a `toJSON` hook of `value` that may answer by its key (a Date's
 * ignores it). A record holding one is serialized whole, without parts: a value serialized on its own
 * gets the key `""` instead of its field name or index.
 */
function hasJsonHook(value: unknown): boolean {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
        return false;
    }
    const hook = (value as { toJSON?: unknown }).toJSON;
    return typeof hook === "function" && hook !== Date.prototype.toJSON;
}

/**
 * The fields of an object with the JSON text of each value, in `JSON.stringify`'s order; a field
 * whose value has no JSON text (`undefined`, a function) is left out, as `JSON.stringify` does. Null
 * when the object or a value has a `toJSON` hook (`hasJsonHook`).
 */
function fieldTexts(record: Record<string, unknown>): [string, string][] | null {
    if (hasJsonHook(record)) {
        return null;
    }
    const fields: [string, string][] = [];
    for (const key of Object.keys(record)) {
        const value = record[key];
        if (hasJsonHook(value)) {
            return null;
        }
        const text = JSON.stringify(value);
        if (text !== undefined) {
            fields.push([key, text]);
        }
    }
    return fields;
}

/** JSON text written piece by piece, with the offset of what was written (`objectSpans`). */
type JsonWriter = { pieces: string[]; length: number };

function write(writer: JsonWriter, piece: string) {
    writer.pieces.push(piece);
    writer.length += piece.length;
}

/** Writes an object from its fields' texts (`fieldTexts`): `JSON.stringify`'s text. Returns their spans. */
function objectSpans(writer: JsonWriter, fields: readonly [string, string][]): FieldSpan[] {
    const spans: FieldSpan[] = [];
    write(writer, "{");
    fields.forEach(([key, text], index) => {
        write(writer, `${index > 0 ? "," : ""}${JSON.stringify(key)}:`);
        spans.push([key, writer.length, writer.length + text.length]);
        write(writer, text);
    });
    write(writer, "}");
    return spans;
}

/**
 * An object record's text and its top-level field parts; built from the parts, the text is
 * `JSON.stringify(record)`. One with a `toJSON` hook is its plain text without parts.
 */
function objectProjection(record: Record<string, unknown>): Projection {
    const fields = fieldTexts(record);
    if (!fields) {
        return { text: JSON.stringify(record), parts: null };
    }
    const writer: JsonWriter = { pieces: [], length: 0 };
    const spans = objectSpans(writer, fields);
    const text = writer.pieces.join("");
    return { text, parts: { type: "fields", source: text, fields: spans } };
}

/**
 * An item list's text and its parts by item id (`itemIds`: plain-object items with unique non-empty
 * string ids); built from the parts, the text is `JSON.stringify(list)`. Any other list, or one with a
 * `toJSON` hook on it, an item, or an item's value, is its plain text without parts.
 */
function itemProjection(list: unknown): Projection {
    const ids = itemIds(list);
    const items = list as Record<string, unknown>[];
    const texts = ids && !hasJsonHook(list) ? items.map(fieldTexts) : null;
    if (!ids || !texts || texts.some((fields) => fields === null)) {
        return { text: JSON.stringify(list), parts: null };
    }
    const writer: JsonWriter = { pieces: [], length: 0 };
    write(writer, "[");
    const parts = ids.map((id, index) => {
        if (index > 0) {
            write(writer, ",");
        }
        const start = writer.length;
        const fields = objectSpans(writer, texts[index]!);
        return { id, start, end: writer.length, fields };
    });
    write(writer, "]");
    const text = writer.pieces.join("");
    return { text, parts: { type: "items", source: text, items: parts } };
}

/** A dirty collection's text and parts; only modules reuse the field-text cache. */
function collectionProjection(collection: Collection): Projection | undefined {
    const record = recordData(collection as RecordKind);
    if (record === undefined) {
        return undefined;
    }
    if (collection === SECTION_KIND.llmSecrets) {
        // The server refuses patches of a projecting/prepareWrite kind, even its readable siblings.
        return { text: projectCollection(collection)!, parts: null };
    }
    if (collection === RESOURCE_KIND.modules) {
        return moduleProjection(record);
    }
    if (isSection(collection)) {
        const ordered = Object.fromEntries(
            SECTION_FIELDS[collection].map((field) => [field, (record as Record<string, unknown>)[field]]),
        );
        return objectProjection(ordered);
    }
    return isPlainObject(record) ? objectProjection(record) : itemProjection(record);
}

/**
 * The live modules list, reusing each element field while its value and stamp match. Every live
 * projection goes here; `baseParts` uses the uncached `itemProjection` on parsed persisted data.
 * Root list moves preserve identity, so only fields written since the last projection stringify.
 * Uncacheable records and shapes with JSON hooks use whole serialization, with no cache or parts.
 */
function moduleProjection(list: unknown): Projection {
    const cached = moduleTexts;
    moduleTexts = null;
    if (!Array.isArray(list) || hasJsonHook(list) || moduleItemFieldStamp(list, "") === null) {
        return { text: JSON.stringify(list), parts: null };
    }
    const writer: JsonWriter = { pieces: [], length: 0 };
    const items = new WeakMap<object, FieldTextCache["fields"]>();
    const spans: { start: number; end: number; fields: FieldSpan[] }[] = [];
    write(writer, "[");
    for (let index = 0; index < list.length; index += 1) {
        const item = list[index];
        if (!isPlainObject(item) || hasJsonHook(item)) {
            return { text: JSON.stringify(list), parts: null };
        }
        const fields: [string, string][] = [];
        const sources: { value: unknown; stamp: number }[] = [];
        const previous = cached?.items.get(item);
        for (const key of Object.keys(item)) {
            const value = item[key];
            const stamp = moduleItemFieldStamp(item, key);
            if (stamp === null || hasJsonHook(value)) {
                return { text: JSON.stringify(list), parts: null };
            }
            const hit = previous?.get(key);
            const text =
                hit && hit.stamp === stamp && Object.is(hit.value, value)
                    ? cached!.source.slice(hit.start, hit.end)
                    : JSON.stringify(value);
            if (text !== undefined) {
                fields.push([key, text]);
                sources.push({ value, stamp });
            }
        }
        if (index > 0) {
            write(writer, ",");
        }
        const start = writer.length;
        const fieldSpans = objectSpans(writer, fields);
        spans.push({ start, end: writer.length, fields: fieldSpans });
        items.set(item, new Map(fieldSpans.map(([key, start, end], i) => [key, { ...sources[i], start, end }])));
    }
    write(writer, "]");
    const text = writer.pieces.join("");
    if (import.meta.env.DEV && text !== JSON.stringify(list)) {
        // A missed stamp would lose an edit. Reported, not repaired, as for characters.
        console.error("[Save] modules: the field-text cache differs from a whole serialization");
    }
    moduleTexts = { source: text, items };
    const ids = itemIds(list);
    return {
        text,
        parts: ids ? { type: "items", source: text, items: spans.map((span, i) => ({ id: ids[i], ...span })) } : null,
    };
}

/**
 * A character as stored: its own fields in their order, without `CHARACTER_LOCAL_KEYS` (the chats
 * are saved on their own; the selection and the render key are client-only).
 */
function projectCharacter(character: character | groupChat): string {
    return characterProjection(character).text;
}

/**
 * A character's text (`projectCharacter`) and its top-level field parts (`objectProjection`). The
 * fields are taken from an ordinary object (`JSON.stringify` puts integer keys first there, not where
 * a `$state` proxy has them), so the text is `JSON.stringify` of that object.
 *
 * Serializing a large character through its `$state` proxies is the cost of a save cycle, so a field
 * whose value (identity) and stamp (`characterFieldStamp`) equal those of the last projection reuses
 * that projection's text of it: only the fields written since are serialized again. A character whose
 * stamps are null (shared state, data that is not plain JSON) is serialized whole every time.
 */
function characterProjection(character: character | groupChat): Projection {
    // Own keys defined, never assigned, and the values serialized straight from the record (not
    // `$state.snapshot`, which assigns keys): an own `__proto__` key survives at any depth.
    const copy: Record<string, unknown> = {};
    const record = character as unknown as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        if (!CHARACTER_LOCAL_KEYS.has(key)) {
            Object.defineProperty(copy, key, {
                value: record[key],
                enumerable: true,
                writable: true,
                configurable: true,
            });
        }
    }
    const id = character.chaId;
    const cached = characterTexts.get(id);
    characterTexts.delete(id);
    if (hasJsonHook(copy)) {
        return objectProjection(copy);
    }
    const fields: [string, string][] = [];
    const sources: { value: unknown; stamp: number | null }[] = [];
    for (const key of Object.keys(copy)) {
        const value = copy[key];
        const stamp = characterFieldStamp(id, key);
        const hit = stamp === null ? undefined : cached?.fields.get(key);
        let text: string | undefined;
        if (hit && hit.stamp === stamp && Object.is(hit.value, value)) {
            text = cached!.source.slice(hit.start, hit.end);
        } else {
            if (hasJsonHook(value)) {
                return objectProjection(copy);
            }
            text = JSON.stringify(value);
            if (text === undefined) {
                continue;
            }
        }
        fields.push([key, text]);
        sources.push({ value, stamp });
    }
    const writer: JsonWriter = { pieces: [], length: 0 };
    const spans = objectSpans(writer, fields);
    const text = writer.pieces.join("");
    if (import.meta.env.DEV && text !== JSON.stringify(copy)) {
        // A missed stamp: the cache would lose an edit. Reported, not repaired, so tests see it.
        console.error(`[Save] character ${id}: the field-text cache differs from a whole serialization`);
    }
    if (sources.every((source) => source.stamp !== null)) {
        rememberCharacterText(id, {
            source: text,
            fields: new Map(
                spans.map(([key, start, end], index) => [
                    key,
                    { value: sources[index].value, stamp: sources[index].stamp!, start, end },
                ]),
            ),
        });
    }
    return { text, parts: { type: "fields", source: text, fields: spans } };
}

/** Caches a character's projection (`characterTexts`), dropping the oldest past the bounds. */
function rememberCharacterText(id: string, cache: FieldTextCache) {
    characterTexts.set(id, cache);
    let units = 0;
    for (const entry of characterTexts.values()) {
        units += entry.source.length;
    }
    for (const [oldest, entry] of characterTexts) {
        if (characterTexts.size <= CHARACTER_TEXTS_MAX && units <= CHARACTER_TEXTS_MAX_UNITS) {
            break;
        }
        characterTexts.delete(oldest);
        units -= entry.source.length;
    }
}

/**
 * After a projection whose text equals the saved one (`collectOperations`): the field-text cache
 * that projection filled keeps the saved string instead, so the projection's equal copy (a large
 * record's whole text) can be freed. The spans stay valid: the texts are equal. A cache whose source
 * differs from `projected` (a whole serialization filled none) is left alone.
 */
function shareSavedText(kind: string, id: string, projected: string, saved: string) {
    // A whole serialization can answer undefined (a `toJSON` hook) and fills no cache.
    if (kind === RESOURCE_KIND.modules) {
        if (moduleTexts !== null && moduleTexts.source === projected) {
            moduleTexts.source = saved;
        }
        return;
    }
    const cache = kind === RESOURCE_KIND.characters ? characterTexts.get(id) : undefined;
    if (cache !== undefined && cache.source === projected) {
        cache.source = saved;
    }
}

/** A field's value in `canonicalShape`: present and not `null`, its value not read. */
const PRESENT: unknown = Object.freeze({});

/**
 * What `normalizeCharacter` needs of a character, from its field parts without parsing the whole text:
 * the fields it reads by value (`CHARACTER_SHAPE_FIELDS`) parsed, every other field `null` when its
 * JSON is `null` (an absent or `undefined` value has no part, so it stays absent), else `PRESENT`. The
 * helper reads those only for being missing, so it sees what it would see on a parse of the text.
 */
function canonicalShape(parts: Extract<RecordParts, { type: "fields" }>): Record<string, unknown> {
    const own: Record<string, unknown> = {};
    for (const [key, start, end] of parts.fields) {
        const text = parts.source.slice(start, end);
        const value = CHARACTER_SHAPE_FIELDS.includes(key) ? JSON.parse(text) : text === "null" ? null : PRESENT;
        // Defined, never assigned: an own `__proto__` key stays a key.
        Object.defineProperty(own, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return own;
}

/** The fields `normalizeCharacter` changed: a default or a rebuilt group array (it keeps the rest by reference). */
function canonicalChanges(own: Record<string, unknown>): (readonly [string, unknown])[] {
    const canonical = normalizeCharacter(own);
    return Object.keys(canonical)
        .filter((field) => !Object.hasOwn(own, field) || !Object.is(own[field], canonical[field]))
        .map((field) => [field, canonical[field]] as const);
}

/**
 * A character about to be written, made canonical: the server stores
 * `normalizeCharacter` of what it gets, so when a local write removed or never set a default, the
 * differing fields are written into the mirror raw first (`patchRawCharacter`: no mark, no echo) and the
 * canonical text is sent and held. Then the held text is the server's, and a later conflict merges
 * against the record the server really has. A character whose shape the helper refuses is sent as it
 * is (the server refuses it, and the record is quarantined as any refused write). The helper runs on
 * `canonicalShape` of the field parts; on the parse of the whole text when there are none, or when it
 * changed a field `canonicalShape` left unread (a by-value read missing from `CHARACTER_SHAPE_FIELDS`;
 * one that only picks another field's default is not caught here).
 */
function canonicalCharacter(id: string, projection: Projection): Projection {
    let changes: (readonly [string, unknown])[];
    try {
        if (projection.parts?.type === "fields") {
            const own = canonicalShape(projection.parts);
            changes = canonicalChanges(own);
            if (changes.some(([field]) => Object.hasOwn(own, field) && own[field] === PRESENT)) {
                changes = canonicalChanges(JSON.parse(projection.text) as Record<string, unknown>);
            }
        } else {
            changes = canonicalChanges(JSON.parse(projection.text) as Record<string, unknown>);
        }
    } catch {
        return projection;
    }
    if (changes.length === 0) {
        return projection;
    }
    patchRawCharacter(id, changes);
    const character = findMirrorCharacter(id);
    return character ? characterProjection(character) : projection;
}

/** A record's mirror text with its parts (`projectRecord`), or undefined when the mirror has none. */
function projectEntry(kind: string, id: string): Projection | undefined {
    if (kind === RESOURCE_KIND.characters) {
        const character = findMirrorCharacter(id);
        return character ? characterProjection(character) : undefined;
    }
    return COLLECTIONS.includes(kind as Collection) ? collectionProjection(kind as Collection) : undefined;
}

/** The text a record has after a server copy was written into the mirror (its key order, not the server's). */
function projectRecord(kind: string, id: string): string | undefined {
    if (kind === RESOURCE_KIND.characters) {
        const character = findMirrorCharacter(id);
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
    const kind = key.slice(0, separator);
    const id = key.slice(separator + 1);
    const text = projectRecord(kind, id) ?? null;
    if (text === refused.text) {
        if (text !== null) {
            // The refused text stays held: the cache keeps that string, not an equal copy.
            shareSavedText(kind, id, text, refused.text!);
        }
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
    const ids = new Set(characterData().map((character) => character.chaId as string));
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
    /** The whole record's text (null: a deletion), held as saved once the op is acknowledged. */
    text: string | null;
    /** The parts of `text` (`RecordParts`), cached with it once acknowledged. */
    parts?: RecordParts | null;
    /** The operation's JSON inside the batch body: the whole data, a deletion, or a record patch. */
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

/** An op sending the whole record (or, with `patch`, the JSON of a record patch of it). */
function pendingOp(op: Omit<PendingOp, "part" | "bytes">, patch?: string): PendingOp {
    const head = `{"kind":${JSON.stringify(op.kind)},"id":${JSON.stringify(op.id)},"baseRevision":${JSON.stringify(op.baseRevision)}`;
    const part =
        patch !== undefined
            ? `${head},"patch":${patch}}`
            : op.text === null
              ? `${head},"delete":true}`
              : `${head},"data":${op.text}}`;
    return { ...op, part, bytes: utf8ByteLength(part) };
}

/**
 * The parts of a held record's text (`RecordParts`), computed once from the text and cached on the
 * entry; null when it has none (`llmSecrets`, a list without unique item ids, a `toJSON` hook). Parts
 * rebuilt from a parse are spans of the held text when the rebuilt text equals it, else of the rebuilt
 * text: a parse may order nested integer keys differently from the live
 * record, and such a field only reads as changed and is sent again, never the reverse.
 */
function baseParts(kind: string, entry: Persisted): RecordParts | null {
    if (entry.parts !== undefined) {
        return entry.parts;
    }
    let projection: Projection | null = null;
    try {
        const data: unknown = JSON.parse(entry.text);
        if (kind !== SECTION_KIND.llmSecrets) {
            projection = isPlainObject(data) ? objectProjection(data) : itemProjection(data);
        }
    } catch {}
    const parts = projection?.parts ?? null;
    if (parts && projection!.text === entry.text) {
        parts.source = entry.text;
    }
    entry.parts = parts;
    return parts;
}

/** The text of a span of `source`, compared without a copy (a slice). */
const spanText = (source: string, start: number, end: number) => source.slice(start, end);

/**
 * The fields that differ from `base` to `local` by their text: `set` (new or changed, with the local
 * text), `remove` (fields `local` lacks). Null when `__proto__` is among them (a patch never names it:
 * such a record or item is saved whole).
 */
function diffFieldSpans(
    baseSource: string,
    base: readonly FieldSpan[],
    localSource: string,
    local: readonly FieldSpan[],
): { set: [string, string][]; remove: string[] } | null {
    const before = new Map(base.map(([key, start, end]) => [key, [start, end] as const]));
    const after = new Set(local.map(([key]) => key));
    const set: [string, string][] = [];
    for (const [key, start, end] of local) {
        const span = before.get(key);
        const text = spanText(localSource, start, end);
        if (!span || span[1] - span[0] !== end - start || spanText(baseSource, span[0], span[1]) !== text) {
            set.push([key, text]);
        }
    }
    const remove = base.filter(([key]) => !after.has(key)).map(([key]) => key);
    return set.some(([key]) => key === "__proto__") || remove.includes("__proto__") ? null : { set, remove };
}

/** A field patch's members (`"set":{...},"remove":[...]`) from field texts. */
function fieldPatchText(set: readonly [string, string][], remove: readonly string[]): string {
    const writer: JsonWriter = { pieces: [], length: 0 };
    objectSpans(writer, set);
    return `"set":${writer.pieces.join("")},"remove":${JSON.stringify(remove)}`;
}

/**
 * The JSON of the record patch from `base` to `local` (`RecordFieldPatch` or `RecordItemPatch`
 * without its revision), `""` when nothing differs but key order, or null when a whole write is
 * needed (a changed `__proto__` field of an object record).
 */
function recordPatchText(base: RecordParts, local: RecordParts): string | null {
    if (base.type === "fields" && local.type === "fields") {
        const fields = diffFieldSpans(base.source, base.fields, local.source, local.fields);
        if (!fields) {
            return null;
        }
        return fields.set.length === 0 && fields.remove.length === 0
            ? ""
            : `{${fieldPatchText(fields.set, fields.remove)}}`;
    }
    if (base.type !== "items" || local.type !== "items") {
        return null;
    }
    const before = new Map(base.items.map((item) => [item.id, item.fields]));
    const items: string[] = [];
    const changes: string[] = [];
    for (const item of local.items) {
        const baseFields = before.get(item.id);
        const fields = baseFields ? diffFieldSpans(base.source, baseFields, local.source, item.fields) : null;
        if (!fields) {
            // A new item, or one whose `__proto__` changed: sent whole.
            items.push(spanText(local.source, item.start, item.end));
        } else if (fields.set.length > 0 || fields.remove.length > 0) {
            changes.push(`{"id":${JSON.stringify(item.id)},${fieldPatchText(fields.set, fields.remove)}}`);
        }
    }
    const reordered =
        base.items.length !== local.items.length || base.items.some((item, index) => item.id !== local.items[index].id);
    if (items.length === 0 && changes.length === 0 && !reordered) {
        return "";
    }
    const order = reordered ? `,"order":${JSON.stringify(local.items.map((item) => item.id))}` : "";
    return `{"items":[${items.join(",")}],"changes":[${changes.join(",")}]${order}}`;
}

/**
 * The save of a held record whose text changed: a record patch against the saved base when both have
 * parts (an object's changed fields, an array's changed items), unless it is not smaller in UTF-8
 * bytes than the whole data; otherwise the whole record. Null when only key order differs: the local
 * text is held as the saved one (the same JSON values at the same revision), and nothing is sent.
 */
function updateOperation(
    key: string,
    kind: string,
    id: string,
    current: Persisted,
    local: Projection,
): PendingOp | null {
    const op = { key, kind, id, baseRevision: current.revision, text: local.text, parts: local.parts };
    const base = local.parts ? baseParts(kind, current) : null;
    const patch = base && local.parts ? recordPatchText(base, local.parts) : null;
    if (patch === "") {
        persisted.set(key, { revision: current.revision, text: local.text, parts: local.parts });
        return null;
    }
    if (patch === null) {
        return pendingOp(op);
    }
    // At most 3 UTF-8 bytes per UTF-16 unit, at least 1: only a close call is measured. `"patch":`
    // is one byte longer than `"data":`.
    const smaller = 3 * patch.length + 1 < local.text.length || utf8ByteLength(patch) + 1 < utf8ByteLength(local.text);
    return smaller ? pendingOp(op, patch) : pendingOp(op);
}

/**
 * Builds this cycle's operations and the generation each dirty key had when it was captured, then
 * takes the chat work: a new character's chats are created with it, a deleted one's are dropped.
 */
function collectOperations(): {
    ops: PendingOp[];
    captured: Map<string, number>;
    /** In-doubt keys resent as sent this cycle while a newer local text waits: not settled. */
    heldBack: Set<string>;
    membership: number;
    chatWork: ChatWork;
} {
    const captured = new Map(dirty);
    const membership = membershipGeneration;
    const ops: PendingOp[] = [];
    const heldBack = new Set<string>();
    /**
     * Resends an in-doubt key's text exactly as sent (`inDoubt`); its newer local text (`localText`)
     * waits for the next cycle, the key unsettled. False when the key is not in doubt (any more): its
     * saved base moved, or the text equals the saved one but for key order.
     */
    function resendInDoubt(key: string, kind: string, id: string, localText: string | undefined): boolean {
        const doubt = inDoubt.get(key);
        if (!doubt) {
            return false;
        }
        const current = persisted.get(key);
        if ((current?.revision ?? null) !== doubt.baseRevision) {
            inDoubt.delete(key);
            return false;
        }
        const sent = { text: doubt.text, parts: doubt.parts };
        const op = current
            ? updateOperation(key, kind, id, current, sent)
            : pendingOp({ key, kind, id, baseRevision: null, ...sent });
        if (!op) {
            inDoubt.delete(key);
            return false;
        }
        addOperation(op);
        if (localText !== doubt.text) {
            heldBack.add(key);
        } else {
            // Its acknowledgement saves `doubt.text`: the cache keeps that string, not an equal copy.
            shareSavedText(kind, id, localText, doubt.text);
        }
        return true;
    }
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
        const projection = collectionProjection(collection);
        if (resendInDoubt(key, collection, SINGLETON_RESOURCE_ID, projection?.text)) {
            continue;
        }
        const current = persisted.get(key);
        // An absent collection (e.g. no plugin storage yet) has no record to write.
        if (projection === undefined) {
            continue;
        }
        if (projection.text === current?.text) {
            // A whole serialization can answer undefined (a `toJSON` hook): equal to an absent record.
            if (current !== undefined) {
                shareSavedText(collection, SINGLETON_RESOURCE_ID, projection.text, current.text);
            }
        } else {
            const op = current
                ? updateOperation(key, collection, SINGLETON_RESOURCE_ID, current, projection)
                : pendingOp({ key, kind: collection, id: SINGLETON_RESOURCE_ID, baseRevision: null, ...projection });
            if (op) {
                addOperation(op);
            }
        }
    }

    // The ids are unique by construction (`records.svelte.ts`).
    const characters = characterData() as unknown as (character | groupChat)[];
    const present = new Set<string>();
    for (const character of characters) {
        const id = character.chaId;
        present.add(id);
        const key = characterKey(id);
        // A character whose refused delete was undone: nothing waits any more.
        jobBlockedRecords.delete(key);
        if (inDoubt.has(key) && resendInDoubt(key, RESOURCE_KIND.characters, id, characterProjection(character).text)) {
            continue;
        }
        const current = persisted.get(key);
        if (current && !captured.has(key)) {
            continue;
        }
        let projection = characterProjection(character);
        let saved = projection.text === current?.text;
        if (!saved) {
            projection = canonicalCharacter(id, projection);
            saved = projection.text === current?.text;
        }
        if (saved) {
            if (current !== undefined) {
                shareSavedText(RESOURCE_KIND.characters, id, projection.text, current.text);
            }
        } else {
            const op = current
                ? updateOperation(key, RESOURCE_KIND.characters, id, current, projection)
                : pendingOp({ key, kind: RESOURCE_KIND.characters, id, baseRevision: null, ...projection });
            if (op) {
                addOperation(op);
            }
        }
    }
    for (const key of inDoubt.keys()) {
        // A create whose answer was lost, of a character removed since: resent, so that its delete
        // follows on the revision it gets (or nothing, when it never landed).
        if (key.startsWith(characterPrefix) && !persisted.has(key)) {
            const id = key.slice(characterPrefix.length);
            if (!present.has(id)) {
                resendInDoubt(key, RESOURCE_KIND.characters, id, undefined);
            }
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
            if (!present.has(id) && !isRecordJobBlocked(key)) {
                // Its chats' work is settled now; the revisions held of them stay until the deletion
                // is acknowledged, for a re-add of the id before that (`settleCharacterDelete`).
                settleCharacterDelete(id);
                characterTexts.delete(id);
                addOperation(
                    pendingOp({ key, kind: RESOURCE_KIND.characters, id, baseRevision: current.revision, text: null }),
                );
            }
        }
    }
    return {
        ops,
        captured,
        heldBack,
        membership,
        chatWork: takeChatWork(creating, { maxOps: MAX_BATCH_OPERATIONS, holdOrders: listRefresh }),
    };
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
            // Chats whose protection ended in this cycle (saved, refreshed, released) may be evicted now.
            scheduleTrim();
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
    // Nothing is saved before the boot installed the records.
    if (halted || trackedCharacters() === undefined) {
        return;
    }
    const stages: (() => Promise<boolean | void>)[] = [
        reloadDeferredChats,
        hydrateCharacters,
        applyRemoteUpdates,
        refreshIdleChats,
    ];
    for (const stage of stages) {
        const discardedWork = await stage();
        if (halted) {
            // A restore replaced the data meanwhile: nothing more is applied or sent.
            return;
        }
        if (discardedWork) {
            // At once: a later stage's failure must not swallow it.
            showReloadedNotice();
        }
    }
    const { ops, captured, heldBack, membership, chatWork } = collectOperations();
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
                // No answer: the server may have committed the batch (a lost response). Its chat
                // groups are resent alone with their ids (`requeueChatWork`), its records' texts kept
                // in doubt.
                const lost = !(error instanceof ResourceRequestError) || error.status === 0 || error.status >= 500;
                requeueChatWork(batch.work, { lost });
                if (lost) {
                    noteInDoubt(batch.ops);
                }
                if (error instanceof ResourceRequestError && (error.status === 400 || error.status === 413)) {
                    const match = /^ops\[(\d+)\]/.exec(error.message);
                    const op = match ? batch.ops[Number(match[1])] : undefined;
                    if (op) {
                        // The server refuses that text: it never held it.
                        inDoubt.delete(op.key);
                        quarantineRecord(op, error);
                    } else if (batch.ops.length + batch.work.groups.length + batch.work.orders.length > 1) {
                        // The error names no record (including order/envelope errors). Probe each
                        // unit separately next cycle so unrelated records and chats can still save.
                        isolateBatches = true;
                    } else if (batch.ops[0]) {
                        inDoubt.delete(batch.ops[0].key);
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
                inDoubt.delete(op.key);
                const revision = result.results[opIndex]?.revision;
                if (op.text === null || revision === null || revision === undefined) {
                    persisted.delete(op.key);
                    if (op.text === null && op.kind === RESOURCE_KIND.characters) {
                        // The character's chats went with it: their state is forgotten now (a
                        // character added again under the id meanwhile creates its chats anew).
                        ackCharacterDelete(op.id);
                    }
                } else {
                    persisted.set(op.key, { revision, text: op.text, parts: op.parts });
                }
            });
            for (const characterId of ackChatWork(batch.work, result.chats ?? [], result.chatOrders ?? [])) {
                listRefresh.add(characterId);
            }
        }
    }
    if (halted) {
        return;
    }
    await sendSecretOps(capturedSecretOps);
    for (const [key, marked] of captured) {
        if (recordQuarantine(key) || heldBack.has(key)) {
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
    // Each entry map is named after the settings collection that owns its entries.
    const mirror = recordData(COLLECTION_KIND[field]);
    if (holds(mirror)) {
        return "live";
    }
    const saved = persisted.get(collectionKey(COLLECTION_KIND[field]))?.text;
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
                    {
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

/** Work run synchronously before the restore notice (`beforeRestoreReload`), or null. */
let restoreReloadHook: (() => void) | null = null;

/**
 * Registers one hook before the restore notice, replacing any previous hook; returns its unregister.
 * The upstream import stores its prepared selection here when the socket reports the new epoch
 * before the commit's answer (`upstreamBackupClient.ts`). The notice never waits on the network.
 */
export function beforeRestoreReload(fn: () => void): () => void {
    restoreReloadHook = fn;
    return () => {
        if (restoreReloadHook === fn) {
            restoreReloadHook = null;
        }
    };
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
    try {
        restoreReloadHook?.();
    } catch (error) {
        console.error("[Save] Before restore reload:", error);
    }
    restoreReloadHook = null;
    // The terminal notice: no other alert replaces or clears it, so the page reloads only after the
    // user acknowledged it.
    await alertTerminal(language.resourceRestored);
    recordClientEvent({ kind: "sync", phase: "reload", reason: "restore" });
    flushClientDiagnostics();
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
    // What the plugins lose, taken before the mirror changes and told after the record is settled.
    const lost =
        item.kind === RESOURCE_KIND.pluginStorage && pluginStorageDiscardListeners.size > 0
            ? pluginStorageLosses(key, item)
            : null;
    quarantinedRecords.delete(key);
    inDoubt.delete(key);
    applyToMirror(item.kind, item.id, item.revision === null ? null : item.data);
    if (item.revision === null) {
        persisted.delete(key);
    } else {
        persisted.set(key, {
            revision: item.revision,
            ...(projectEntry(item.kind, item.id) ?? { text: JSON.stringify(item.data) }),
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
    if (lost) {
        for (const listener of pluginStorageDiscardListeners) {
            try {
                listener({
                    ...lost,
                    pluginStorage: [...lost.pluginStorage],
                    localPluginStorage: [...lost.localPluginStorage],
                });
            } catch (error) {
                console.error("[Save]", error);
            }
        }
    }
}

/** Shows the reload notice; one already on screen is kept (it latches until dismissed). */
function showReloadedNotice() {
    alertReloadNotice(language.resourceReloaded);
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
 * What a conflicting record's server copy changed against the saved base, if every change is one
 * this client can take without losing or reinterpreting anything, else null. The changes are the
 * values the mirror must take (ABSENT: delete the field). Allowed, field by field (top level):
 * - a field the server holds as this client does (both made the same change);
 * - a field the base did not have and this client does not have either (another tab filled it in,
 *   such as a default its character screen binds); the server's value is taken;
 * - a character's `lastInteraction` (a send job stamped it while this client had an unsaved change):
 *   the server's finite stamp when this client left the field as saved (the server's clock wins, even
 *   over a later stamp an earlier client clock wrote), else the later of two finite stamps;
 * - a `statics` count: best effort, the server's count plus this client's increments since the
 *   base (`imports`, `messages`; a count both tabs raised to the same value, or one a lost answer
 *   already holds, may be off by those increments).
 * Anything else (a substantive remote edit, even of a field this client did not touch) is a
 * conflict as before, so related fields (a group's member arrays) are never combined from two
 * sources.
 */
function benignChanges(
    kind: string,
    saved: Record<string, unknown>,
    remote: Record<string, unknown>,
    local: Record<string, unknown>,
): Map<string, unknown> | null {
    const changes = new Map<string, unknown>();
    for (const field of new Set([...Object.keys(saved), ...Object.keys(remote), ...Object.keys(local)])) {
        const [base, theirs, ours] = [fieldOf(saved, field), fieldOf(remote, field), fieldOf(local, field)];
        if (kind === RESOURCE_KIND.characters && field === "lastInteraction") {
            if (isEqual(theirs, ours) || (isStamp(theirs) && (ours === ABSENT || isEqual(ours, base)))) {
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
        if (base === ABSENT && ours === ABSENT && field !== "__proto__") {
            changes.set(field, theirs);
            continue;
        }
        return null;
    }
    return changes;
}

/** The reserved `pluginStorage` dictionaries (`pluginStorageStore.svelte.ts`), merged key by key. */
const PLUGIN_STORAGE_NAMESPACES = new Set([PLUGIN_STORAGE_KEY, SAFE_LOCAL_PLUGIN_STORAGE_KEY]);
const CONFLICT = Symbol("conflict");

/** An own data property, so an inherited name (`__proto__`, `constructor`) stays an ordinary key. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown) {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * A reserved dictionary as the plugin storage module reads it (`dictionary`): an object as it is, a
 * list as its entries (the first write converts it), an absent one empty; null for any other value.
 */
function dictionaryView(value: unknown): Record<string, unknown> | null {
    if (value === ABSENT) {
        return {};
    }
    if (Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value));
    }
    return isPlainObject(value) ? value : null;
}

/**
 * A three-way merge of a dictionary's keys: a key the server holds as saved or as this client does
 * is kept as this client has it; a key this client left as saved takes the server's value (ABSENT:
 * removed); a key both changed, differently, goes to `mergeField` (null: a conflict, the default).
 * Returns a fresh object of own keys, or null.
 */
function mergeDictionary(
    base: Record<string, unknown>,
    theirs: Record<string, unknown>,
    ours: Record<string, unknown>,
    mergeField: (field: string, base: unknown, theirs: unknown, ours: unknown) => unknown = () => CONFLICT,
): Record<string, unknown> | null {
    const merged: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(ours)) {
        setOwn(merged, field, value);
    }
    for (const field of new Set([...Object.keys(base), ...Object.keys(theirs), ...Object.keys(ours)])) {
        const [b, t, o] = [fieldOf(base, field), fieldOf(theirs, field), fieldOf(ours, field)];
        if (isEqual(t, b) || isEqual(t, o)) {
            continue;
        }
        const value = isEqual(o, b) ? t : mergeField(field, b, t, o);
        if (value === CONFLICT) {
            return null;
        }
        if (value === ABSENT) {
            delete merged[field];
        } else {
            setOwn(merged, field, value);
        }
    }
    return merged;
}

/**
 * Both sides changed a top-level `pluginStorage` field: a reserved dictionary that both still hold as
 * a dictionary (or neither has) is merged one level down; anything else is a conflict.
 */
function mergePluginNamespace(field: string, base: unknown, theirs: unknown, ours: unknown): unknown {
    const saved = dictionaryView(base);
    if (
        !PLUGIN_STORAGE_NAMESPACES.has(field) ||
        !saved ||
        !(theirs === ABSENT || isPlainObject(theirs)) ||
        !(ours === ABSENT || isPlainObject(ours))
    ) {
        return CONFLICT;
    }
    const merged = mergeDictionary(saved, dictionaryView(theirs)!, dictionaryView(ours)!);
    if (!merged) {
        return CONFLICT;
    }
    return ours === ABSENT && Object.keys(merged).length === 0 ? ABSENT : merged;
}

/**
 * The `pluginStorage` record merged from a conflict, or null when it cannot be: every key the server
 * changed against the saved base must be one this client did not touch, inside each reserved
 * dictionary (`_pluginStorage`, `_safeLocalPluginStorage`) and at the top level (the `setDatabase`
 * custom keys, each compared whole). A key both sides changed to different values conflicts.
 */
function mergePluginStorage(saved: unknown, remote: unknown, local: unknown): Record<string, unknown> | null {
    if (!isPlainObject(saved) || !isPlainObject(remote) || !isPlainObject(local)) {
        return null;
    }
    return mergeDictionary(saved, remote, local, mergePluginNamespace);
}

/** What a reserved `pluginStorage` name holds, apart from its entries. */
function namespaceShape(value: unknown): "absent" | "list" | "dictionary" | "value" {
    if (value === ABSENT) {
        return "absent";
    }
    return Array.isArray(value) ? "list" : isPlainObject(value) ? "dictionary" : "value";
}

/** The keys this client changed against the base whose value the server copy does not hold. */
function lostKeys(base: Record<string, unknown>, theirs: Record<string, unknown>, ours: Record<string, unknown>) {
    return [...new Set([...Object.keys(base), ...Object.keys(theirs), ...Object.keys(ours)])].filter((field) => {
        const [b, t, o] = [fieldOf(base, field), fieldOf(theirs, field), fieldOf(ours, field)];
        return !isEqual(o, b) && !isEqual(o, t);
    });
}

/**
 * What replacing this client's `pluginStorage` with a server copy discards (`acceptRemote`): taken
 * from the saved base (empty when this client never saved the record: a create race), the mirror,
 * and the server copy. Null when nothing is lost.
 */
function pluginStorageLosses(key: string, item: RemoteItem): PluginStorageDiscard | null {
    const projected = projectRecord(item.kind, item.id);
    if (projected === undefined) {
        return null;
    }
    const held = persisted.get(key);
    let records: unknown[];
    try {
        records = [held ? JSON.parse(held.text) : {}, item.revision === null ? {} : item.data, JSON.parse(projected)];
    } catch {
        return null;
    }
    const [base, theirs, ours] = records.map((record) => (isPlainObject(record) ? record : {}));
    const lost: PluginStorageDiscard = { pluginStorage: [], localPluginStorage: [], customStorage: false };
    for (const field of lostKeys(base, theirs, ours)) {
        if (!PLUGIN_STORAGE_NAMESPACES.has(field)) {
            lost.customStorage = true;
            continue;
        }
        const raw = [fieldOf(base, field), fieldOf(theirs, field), fieldOf(ours, field)];
        const [b, t, o] = raw.map(dictionaryView);
        // A reserved name holding something that is no dictionary was replaced as a custom value, and
        // so was a dictionary whose own shape this client changed (created, removed, a list turned into
        // an object) when the server copy has another: its entries may all be unchanged.
        const [baseShape, theirShape, ourShape] = raw.map(namespaceShape);
        if (t === null || o === null || (ourShape !== baseShape && ourShape !== theirShape)) {
            lost.customStorage = true;
        }
        lost[field === PLUGIN_STORAGE_KEY ? "pluginStorage" : "localPluginStorage"] = lostKeys(
            b ?? {},
            t ?? {},
            o ?? {},
        );
    }
    return lost.pluginStorage.length > 0 || lost.localPluginStorage.length > 0 || lost.customStorage ? lost : null;
}

/**
 * A conflicting character or `statics` record whose server change this client can take
 * (`benignChanges`): a send job stamped the character (its `lastInteraction`), filled in a
 * default its screen binds, or counted a send. The changes go into the mirror, the base moves
 * to the server's revision, and the key stays dirty, so the next cycle writes the merged record.
 * Nothing is discarded and no reload notice is shown; a field taken from the server is announced to
 * the remote-change listeners (caches derived from the record). Not for a create, a delete, another
 * kind, a character whose reload already waits for its generation, or a taken field the mirror object
 * only inherits (`assignsInherited`). A `pluginStorage` record is merged key by key instead
 * (`mergePluginStorageChange`), and an item list of `ITEM_LIST_MERGE_KINDS` item by item
 * (`mergeItemListChange`: this client's added items over the server's list), a create included.
 */
function mergeConcurrentChange(item: RemoteItem, key: string): boolean {
    if (item.kind === RESOURCE_KIND.pluginStorage) {
        return mergePluginStorageChange(item, key);
    }
    if (ITEM_LIST_MERGE_KINDS.has(item.kind)) {
        return mergeItemListChange(item, key);
    }
    const isCharacter = item.kind === RESOURCE_KIND.characters;
    if (!(isCharacter || item.kind === COLLECTION_KIND.statics) || item.revision === null) {
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
    const changes = remote && saved && local ? benignChanges(item.kind, saved, remote, local) : null;
    if (!changes) {
        return false;
    }
    // `statics` is merged into a plain copy of its record, applied raw once (no write of its own).
    const target = (
        isCharacter ? findMirrorCharacter(item.id) : { ...(JSON.parse(projected) as Record<string, unknown>) }
    ) as Record<string, unknown> | undefined;
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
    if (isCharacter) {
        patchRawCharacter(
            item.id,
            prepared.map(([field, value]) => [field, value === ABSENT ? REMOVE_FIELD : value] as const),
        );
    } else {
        for (const [field, value] of prepared) {
            if (value === ABSENT) {
                delete target[field];
            } else {
                target[field] = value;
            }
        }
        applyRaw(COLLECTION_KIND.statics, target);
    }
    adoptMergedBase(
        item,
        item.revision,
        key,
        prepared.some(([field]) => !(isCharacter && field === "lastInteraction")),
    );
    return true;
}

/**
 * After a merge wrote the mirror: the saved base becomes the server's record and the key stays dirty.
 * The local projection stands for the base when the two are equal (no echo write for a key-order
 * difference); otherwise the next cycle writes the merge. Its parts belong to the local text only:
 * held with the server's text, they would hide the local edit. `announce`: a value was taken from
 * the server, so the remote-change listeners hear of it.
 */
function adoptMergedBase(item: RemoteItem, revision: string, key: string, announce: boolean) {
    const merged = projectEntry(item.kind, item.id)!;
    persisted.set(
        key,
        isEqual(JSON.parse(merged.text), item.data)
            ? { revision, ...merged }
            : { revision, text: recordText(item.kind, item.data) },
    );
    markKey(key);
    if (announce) {
        for (const listener of remoteChangeListeners) {
            try {
                listener(item.kind, item.id);
            } catch (error) {
                console.error("[Save]", error);
            }
        }
    }
}

/**
 * A conflicting `pluginStorage` record (`mergePluginStorage`): every plugin shares it, so two tabs
 * writing different keys meet here. The merge goes into the mirror raw, and the key stays dirty
 * (`adoptMergedBase`), so the next cycle writes it on the server's revision: no discard, no notice.
 * A record both tabs created (a plugin's first write creates it) merges against an empty base.
 */
function mergePluginStorageChange(item: RemoteItem, key: string): boolean {
    const projected = projectRecord(item.kind, item.id);
    if (item.revision === null || projected === undefined) {
        return false;
    }
    const base = persisted.get(key);
    let merged: Record<string, unknown> | null;
    try {
        merged = mergePluginStorage(base ? JSON.parse(base.text) : {}, item.data, JSON.parse(projected));
    } catch {
        return false;
    }
    if (!merged) {
        return false;
    }
    const taken = !isEqual(merged, JSON.parse(projected));
    applyRaw(RESOURCE_KIND.pluginStorage, merged);
    adoptMergedBase(item, item.revision, key, taken);
    return true;
}

/**
 * The item lists whose items are independent records addressed by their id, including toggle presets,
 * so an item this client added can go over another writer's list (`mergeItemAdds`). Other lists that
 * pass `itemIds` are not here: `characterOrder`'s folders hold character membership, and `loreBook`,
 * `plugins`, `hotkeys`, and `authRefreshes` are addressed by page, name, action, or URL, whatever ids
 * their items carry.
 */
const ITEM_LIST_MERGE_KINDS = new Set<string>([
    RESOURCE_KIND.modules,
    RESOURCE_KIND.presets,
    COLLECTION_KIND.personas,
    COLLECTION_KIND.credentials,
    COLLECTION_KIND.modelPresets,
    COLLECTION_KIND.modelProfiles,
    COLLECTION_KIND.togglePresets,
]);

/**
 * An item list merged from a conflict, or null when it cannot be: the server's list (its items and
 * order) with the items this client added (an id neither the saved base nor the server's list has)
 * after it, in this client's order. Every other change of this client must be one the server already
 * holds: each saved item as saved or as the server has it (an edit or removal only the server made is
 * taken; one this client made conflicts, even of an item the server left alone), the saved items in
 * the saved order or the server's, and an item both added under one id equal on both sides. All three
 * lists need unique item ids (`itemIds`).
 */
function mergeItemAdds(base: unknown, theirs: unknown, ours: unknown): Record<string, unknown>[] | null {
    const [baseIds, theirIds, ourIds] = [itemIds(base), itemIds(theirs), itemIds(ours)];
    if (!baseIds || !theirIds || !ourIds) {
        return null;
    }
    const byId = (list: unknown, ids: string[]) =>
        new Map(ids.map((id, index) => [id, (list as Record<string, unknown>[])[index]]));
    const [saved, remote, local] = [byId(base, baseIds), byId(theirs, theirIds), byId(ours, ourIds)];
    const valueOf = (items: Map<string, unknown>, id: string) => (items.has(id) ? items.get(id) : ABSENT);
    for (const id of baseIds) {
        const value = valueOf(local, id);
        if (!isEqual(value, valueOf(saved, id)) && !isEqual(value, valueOf(remote, id))) {
            return null;
        }
    }
    const kept = ourIds.filter((id) => saved.has(id));
    const savedOrder = baseIds.filter((id) => local.has(id));
    const remoteOrder = theirIds.filter((id) => saved.has(id) && local.has(id));
    if (!isEqual(kept, savedOrder) && !isEqual(kept, remoteOrder)) {
        return null;
    }
    const added: Record<string, unknown>[] = [];
    for (const id of ourIds) {
        if (saved.has(id)) {
            continue;
        }
        if (remote.has(id)) {
            if (!isEqual(local.get(id), remote.get(id))) {
                return null;
            }
            continue;
        }
        added.push(local.get(id)!);
    }
    return [...(theirs as Record<string, unknown>[]), ...added];
}

/**
 * A conflicting item list of `ITEM_LIST_MERGE_KINDS` (`mergeItemAdds`): a module this tab imported
 * while another tab renamed a different one keeps both. The merge goes into the mirror raw (the
 * selections are resolved against it, `applyToMirror`), and the key stays dirty (`adoptMergedBase`),
 * so the next cycle sends the added items on the server's revision: no discard, no notice. A list
 * both tabs created merges against an empty base.
 */
function mergeItemListChange(item: RemoteItem, key: string): boolean {
    const projected = projectRecord(item.kind, item.id);
    if (item.revision === null || projected === undefined) {
        return false;
    }
    const base = persisted.get(key);
    let local: unknown;
    let merged: Record<string, unknown>[] | null;
    try {
        local = JSON.parse(projected);
        merged = mergeItemAdds(base ? JSON.parse(base.text) : [], item.data, local);
    } catch {
        return false;
    }
    if (!merged) {
        return false;
    }
    applyToMirror(item.kind, item.id, merged);
    adoptMergedBase(item, item.revision, key, !isEqual(merged, local));
    return true;
}

/** Whether two JSON texts hold the same value, key order aside (same-length texts are compared parsed). */
function sameJson(a: string, b: string): boolean {
    if (a === b) {
        return true;
    }
    if (a.length !== b.length) {
        return false;
    }
    try {
        return isEqual(JSON.parse(a), JSON.parse(b));
    } catch {
        return false;
    }
}

/**
 * Keeps the texts of a batch whose answer was lost as in-doubt (`inDoubt`). A key already in doubt
 * keeps its entry (the batch resent that text, or deleted the record); a deletion starts none.
 */
function noteInDoubt(ops: readonly PendingOp[]) {
    for (const op of ops) {
        if (op.text !== null && !inDoubt.has(op.key)) {
            inDoubt.set(op.key, { baseRevision: op.baseRevision, text: op.text, parts: op.parts ?? null });
        }
    }
}

/**
 * When the server's copy of `key` is its in-doubt text (a lost write landed): that text becomes the
 * saved base at `revision`, the in-doubt entry is cleared, and the key is marked, so the next cycle
 * sends this client's newer text on it (nothing when the mirror holds that text).
 */
function adoptInDoubt(key: string, revision: string, text: string): boolean {
    const doubt = inDoubt.get(key);
    if (!doubt || !sameJson(doubt.text, text)) {
        return false;
    }
    inDoubt.delete(key);
    persisted.set(key, { revision, text: doubt.text, parts: doubt.parts });
    markKey(key);
    return true;
}

/** A conflicting revision already received over the feed or the job's hydration connection. */
function rebuildConflictRecord(conflict: { kind: string; id: string; revision: string | null }): RemoteItem | null {
    if (conflict.revision === null || parseRevisionToken(conflict.revision)?.epoch !== getResourceEpoch()) {
        return null;
    }
    const key = recordKey(conflict.kind, conflict.id);
    const held = persisted.get(key);
    const notice = remoteRecords.get(key);
    if (
        held &&
        notice?.revision === conflict.revision &&
        notice.patch &&
        held.revision === notice.patch.baseRevision &&
        matchesPatchRevision(notice.patch, conflict.revision)
    ) {
        const data = patchedRecord(held.text, notice.patch);
        if (data !== null) {
            return { ...conflict, data };
        }
    }
    const deferred = deferredHydrations.get(key);
    return deferred?.revision === conflict.revision ? { ...conflict, data: deferred.data } : null;
}

/**
 * Another tab or device wrote records this batch was based on. Rebuilds an already received revision
 * or reads it back, then puts the server version into the mirror, unless the server already holds
 * exactly what this client sent (a retry after a lost response). The rest of the batch goes out in the next cycle.
 * The reload notice is shown once per recovery, when it discarded anything, also when a read after
 * the first discard throws.
 */
async function recoverFromConflict(error: ResourceConflictError, batch: readonly PendingOp[], work: ChatWork) {
    const notice = { owed: false };
    try {
        await recoverConflictedWork(error, batch, work, notice);
    } finally {
        if (notice.owed && !halted) {
            showReloadedNotice();
        }
    }
}

/** The body of `recoverFromConflict`: sets `notice.owed` as soon as anything is discarded. */
async function recoverConflictedWork(
    error: ResourceConflictError,
    batch: readonly PendingOp[],
    work: ChatWork,
    notice: { owed: boolean },
) {
    const sent = new Map(batch.map((op) => [op.key, op]));
    const refs: { kind: string; id: string }[] = [];
    const rebuilt: RemoteItem[] = [];
    const chatRefs: { characterId: string; id: string }[] = [];
    const conflictedChats = new Set<string>();
    const conflictedOrders = new Set<string>();
    const generatingChats = new Set<string>();
    const expiredChats = new Set<string>();
    /** Per generating chat: the locked messages its group targets (their edits are dropped). */
    const lockedMessages = new Map<string, string[]>();
    let generating = false;
    // The diagnostics' counts by category; `generating` is a subset of them.
    const counted = { records: 0, chats: 0, orders: 0, generating: 0 };
    for (const conflict of error.conflicts) {
        if (isChatConflict(conflict)) {
            counted.chats++;
        } else if (isChatOrderConflict(conflict)) {
            counted.orders++;
        } else {
            counted.records++;
        }
        if ("reason" in conflict && conflict.reason === "generating") {
            // A server job owns a message this change touches: drop its edits, retry the rest.
            generating = true;
            counted.generating++;
            if (isChatConflict(conflict)) {
                const key = `${conflict.characterId}\u0000${conflict.id}`;
                generatingChats.add(key);
                if (Array.isArray(conflict.messageIds) && conflict.messageIds.length > 0) {
                    lockedMessages.set(key, conflict.messageIds);
                }
            } else if (!isChatOrderConflict(conflict)) {
                jobBlockedRecords.set(recordKey(conflict.kind, conflict.id), Date.now() + JOB_RETRY_MS);
            }
            continue;
        }
        if (isChatConflict(conflict)) {
            chatRefs.push({ characterId: conflict.characterId, id: conflict.id });
            const key = `${conflict.characterId}\u0000${conflict.id}`;
            conflictedChats.add(key);
            if (conflict.reason === "expired") {
                expiredChats.add(key);
            }
        } else if (isChatOrderConflict(conflict)) {
            conflictedOrders.add(conflict.characterId);
        } else {
            const item = rebuildConflictRecord(conflict);
            if (item) {
                rebuilt.push(item);
            } else {
                refs.push({ kind: conflict.kind, id: conflict.id });
            }
        }
    }
    // Counts only: the conflicting records' ids stay here.
    recordClientEvent({ kind: "sync", phase: "conflict", ...counted });
    // These refusals need no read: an unrelated read failure must not requeue the locked edits.
    const generatingRecovery = recoverChatConflicts(
        { groups: work.groups.filter((group) => generatingChats.has(group.key)), orders: [] },
        new Set(),
        new Set(),
        [],
        generatingChats,
        lockedMessages,
    );
    if (generating || generatingRecovery.blocked) {
        showGeneratingNotice();
    }
    if (generatingRecovery.reloaded) {
        notice.owed = true;
    }
    const remainingWork = {
        groups: work.groups.filter((group) => !generatingChats.has(group.key)),
        orders: work.orders,
    };
    let read: Awaited<ReturnType<typeof readRefs>>;
    try {
        read = refs.length + chatRefs.length > 0 ? await readRefs(refs, { chats: chatRefs }) : { epoch: "", items: [] };
    } catch (readError) {
        // Only work outside the generating recovery still needs to be requeued.
        requeueChatWork(remainingWork);
        throw readError;
    }
    const recovered = recoverChatConflicts(
        remainingWork,
        conflictedChats,
        conflictedOrders,
        (read.chats ?? []) as RemoteChat[],
        undefined,
        undefined,
        expiredChats,
    );
    if (recovered.reloaded) {
        notice.owed = true;
    }
    for (const characterId of recovered.refresh) {
        // Read in `hydrateCharacters` (now, and again next cycle if the read fails).
        hydrate.add(characterId);
    }
    for (const item of [...rebuilt, ...read.items]) {
        const key = recordKey(item.kind, item.id);
        const text = item.revision === null ? null : recordText(item.kind, item.data);
        const op = sent.get(key);
        if (text !== null && op?.text != null && sameJson(op.text, text)) {
            // A retry after a lost response: the server holds what was sent (a patch's result keeps
            // the server's key order, so the text may differ in order only).
            inDoubt.delete(key);
            persisted.set(key, { revision: item.revision!, text: op.text, parts: op.parts });
            continue;
        }
        if (text !== null && adoptInDoubt(key, item.revision!, text)) {
            // An earlier lost write landed (this op, say a delete, is newer): its text is the base,
            // and this client's newer change goes next cycle.
            continue;
        }
        inDoubt.delete(key);
        if (mergeConcurrentChange(item, key)) {
            continue;
        }
        if (item.kind === RESOURCE_KIND.characters && item.revision !== null && !findMirrorCharacter(item.id)) {
            // A character the mirror did not have: its chats come with their order.
            hydrate.add(item.id);
        }
        acceptRemote(item);
        notice.owed = true;
    }
    if (hydrate.size > 0 && (await hydrateCharacters())) {
        notice.owed = true;
    }
}

/**
 * Reads the chat lists of characters a recovery inserted or whose chats changed on the server (their
 * summaries: a chat is loaded only on demand), and puts them into the mirror. A character stays
 * listed until its read succeeds. A recovery's character (`hydrate`) takes the server's list
 * (`acceptRemoteCollection`, which discards what the list has no room for) and waits while a
 * generation runs on it, and one the read finds gone is removed with its chats unless its held
 * revision or its chats' lifetime moved during the read (then it stays listed for the next read);
 * an acknowledgement's (`listRefresh`) is applied as a live update that keeps
 * a queued reorder unless a kept chat with a held revision is missing from the server's list (then
 * the reorder is discarded and reported), also during a generation (busy chats keep their copy),
 * and stays listed while the list cannot be applied yet. Returns whether anything was discarded
 * (the caller shows the reload notice), not whether anything was read.
 */
async function hydrateCharacters(): Promise<boolean> {
    // A recovery's character with a running generation waits until it ends.
    const ids = [
        ...[...hydrate].filter((id) => !isCharacterGenerating(id)),
        ...[...listRefresh].filter((id) => !hydrate.has(id)),
    ];
    if (ids.length === 0) {
        return false;
    }
    const issued = heldChatRevisionsByCharacter(ids);
    // Taken before the read: a recovery's character found gone is removed only if neither its held
    // revision (a job hydration, a live update) nor its chats' lifetime (a same-id recreation) moved
    // while the read was pending.
    const issuedHeld = new Map(
        ids.map((id) => [id, persisted.get(recordKey(RESOURCE_KIND.characters, id))?.revision ?? null]),
    );
    const issuedOwners = new Map(ids.map((id) => [id, chatOwnerToken(id)]));
    const read = await readRefs(
        ids.map((id) => ({ kind: RESOURCE_KIND.characters, id })),
        { chatSummaryCollections: ids },
    );
    if (halted) {
        return false;
    }
    let discardedWork = false;
    const records = new Map(read.items.map((item) => [item.id, item]));
    for (const collection of read.chatSummaryCollections ?? []) {
        const id = collection.characterId;
        const record = records.get(id);
        if (!hydrate.has(id)) {
            if (!listRefresh.has(id)) {
                continue;
            }
            // Without an order (gone on the server) nothing is applied here: the live update or this
            // client's next save removes the character, with the notice when that discards anything.
            const discardsBefore = chatDiscardSequence();
            if (!collection.order || applyRemoteCollection(collection, issued.get(id), { keepPendingOrder: true })) {
                listRefresh.delete(id);
            }
            if (chatDiscardSequence() > discardsBefore) {
                discardedWork = true;
            }
            continue;
        }
        if (!collection.order && record && record.revision === null) {
            if (
                (persisted.get(recordKey(RESOURCE_KIND.characters, id))?.revision ?? null) !== issuedHeld.get(id) ||
                chatOwnerToken(id) !== issuedOwners.get(id)
            ) {
                // The answer is older than what the mirror now holds: kept listed for the next read.
                continue;
            }
            // The character itself is gone on the server: remove it with its chats.
            acceptRemote(record);
            discardedWork = true;
        } else if (collection.order) {
            discardedWork = acceptRemoteCollection(collection) || discardedWork;
        } else {
            console.error(`[Save] Character ${id} has no chat order on the server`);
        }
        hydrate.delete(id);
        listRefresh.delete(id);
    }
    return discardedWork;
}

/** The raw `$state` object of a character in the mirror (reads and raw writes; no wrapper). */
function findMirrorCharacter(id: string): (character | groupChat) | undefined {
    return characterData().find((character) => character.chaId === id) as unknown as
        (character | groupChat) | undefined;
}

/**
 * Reloads chats whose reload waited for a generation that has ended (part of the cycle). A chat
 * stays deferred until its read succeeds; one that is gone refreshes its character's chat list.
 * Returns whether a chat was replaced or removed (its work discarded: the cycle shows the reload
 * notice); false when every chat was skipped (a new job locked it, or the read did not list it).
 */
async function reloadDeferredChats(): Promise<boolean> {
    const released = deferredReloads();
    if (released.length === 0) {
        return false;
    }
    const read = await readRefs([], {
        chats: released.map((ref) => ({ characterId: ref.chaId, id: ref.chatId })),
    });
    if (halted) {
        return false;
    }
    const discardsBefore = chatDiscardSequence();
    for (const chat of read.chats ?? []) {
        const refresh = finishDeferredReload(chat as RemoteChat);
        if (refresh) {
            hydrate.add(refresh);
        }
    }
    return chatDiscardSequence() > discardsBefore;
}

/**
 * Stale acknowledgements and live notices rebase only idle chats, inside the cycle and without a
 * reload notice: loaded chats are read whole, chats that are not loaded through their character's
 * summary list (`refreshIdleSummaries`).
 */
async function refreshIdleChats() {
    await refreshIdleSummaries();
    if (halted) {
        return;
    }
    await readIdleChats(idleChatRefreshes().slice(0, MAX_REMOTE_READS));
}

/**
 * Reads `ref` whole now when it is a stale or noticed loaded chat that is idle (`idleChatRefreshes`),
 * as the save cycle's idle refresh would: a job is then created on the revision the server holds,
 * not on one this tab knows is old (a job chat patch that did not fit). Returns whether the chat is
 * then not known to be behind the server (`isChatBehind`): false when it was not idle, or the read
 * was not taken (a local change or a newer notice meanwhile).
 */
export async function refreshStaleChat(ref: ChatRef): Promise<boolean> {
    if (halted) {
        return false;
    }
    await readIdleChats(
        idleChatRefreshes().filter((entry) => entry.chaId === ref.chaId && entry.chatId === ref.chatId),
    );
    return !halted && !isChatBehind(ref);
}

/** The whole-chat reads of `refreshIdleChats`, for the given idle chats. */
async function readIdleChats(refs: readonly ChatRef[]) {
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
 * Reads the summary lists of characters with an idle stale or noticed chat that is not loaded and
 * applies them as live updates; an applied list ends those chats' marks (`settleSummaryRefresh`).
 */
async function refreshIdleSummaries() {
    const ids = idleSummaryRefreshes().slice(0, MAX_REMOTE_READS);
    if (ids.length === 0) {
        return;
    }
    const notices = summaryRefreshNotices(ids);
    const issued = heldChatRevisionsByCharacter(ids);
    const read = await readRefs([], { chatSummaryCollections: ids });
    if (halted) {
        return;
    }
    for (const collection of read.chatSummaryCollections ?? []) {
        if (applyRemoteCollection(collection, issued.get(collection.characterId))) {
            settleSummaryRefresh(collection, notices);
        }
    }
}

/** Puts a section or settings collection record into its record (and `llmSecretState`). */
function applySettingsRecord(
    kind: SectionKind | CollectionKind,
    data: unknown,
    secretInvalidate: SecretPath[] | "all" = "all",
) {
    if (data === null) {
        // Singletons: the server never deletes them.
        return;
    }
    if (kind === SECTION_KIND.llmSecrets) {
        // The masked record: its mirror form (credential fields `""`) into the record, its status
        // into `llmSecretState`.
        applyRaw(kind, mirrorFields(data as Record<string, unknown>));
        setMaskedSecrets(data as MaskedLlmSecrets, secretInvalidate);
        return;
    }
    applyRaw(kind, data);
}

/**
 * Puts a server record into the mirror (data null: the record is gone): a settings record through
 * `applyRaw` (nothing is marked), a character in place. After `presets`, `modelPresets`, or
 * `personas`, this tab's selections are resolved against the new list. A character removed by
 * another writer discards its chats' unsent work (`forgetCharacter`); returns whether it had any.
 */
function applyToMirror(kind: string, id: string, data: unknown): boolean {
    if (isSection(kind) || isSettingsCollection(kind)) {
        applySettingsRecord(kind, data);
        if (kind === COLLECTION_KIND.personas || kind === COLLECTION_KIND.modelPresets) {
            reconcileSelection();
        }
        return false;
    }
    switch (kind) {
        case RESOURCE_KIND.presets:
        case RESOURCE_KIND.modules:
        case RESOURCE_KIND.plugins:
        case RESOURCE_KIND.pluginStorage:
            if (data !== null) {
                applyRaw(kind, data);
                if (kind === RESOURCE_KIND.presets) {
                    reconcileSelection();
                }
            }
            return false;
        case RESOURCE_KIND.characters: {
            const existed = findMirrorCharacter(id) !== undefined;
            noteMirrorReplaced();
            if (data === null && !existed) {
                // Removed here too (its deletion collected, its chats' work settled): what this
                // client held of its chats is forgotten.
                forgetCharacter(id);
                return false;
            }
            // The raw path: the server record has only the character's own fields, so its render key
            // is kept and its chats stay the chat module's; a new one's chats arrive with a
            // collection read (`recoverFromConflict`). A removed selected character selects home.
            applyRawCharacter(id, data as Record<string, unknown> | null);
            if (data === null) {
                characterTexts.delete(id);
                return forgetCharacter(id, { discard: true });
            }
            return false;
        }
    }
    return false;
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

/** A mirrored singleton absent locally, so adopting its first remote record cannot overwrite a local create. */
function isAbsentMirroredSingleton({ kind, id }: { kind: string; id: string }): boolean {
    return (
        id === SINGLETON_RESOURCE_ID &&
        COLLECTIONS.includes(kind as Collection) &&
        collectionProjection(kind as Collection) === undefined
    );
}

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
 * client's own save, or a job event that applied it first). A field patch this client can take now
 * is applied at once (`applyRemotePatch`), with no read. A newer record waits for the cycle,
 * which reads and applies it while this client has no unsent change of it (`applyRemoteUpdates`); a
 * chat goes to the chat module with its optional by-id patch (applied at its exact base while
 * loaded and idle, otherwise the ordinary idle refresh); a new chat or a changed chat order reads the
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
        if (!held && ref.kind !== RESOURCE_KIND.characters && !isAbsentMirroredSingleton(ref)) {
            // A singleton absent at boot can arrive later. A local create still waits for its save.
            continue;
        }
        if (ref.patch && applyRemotePatch(ref)) {
            continue;
        }
        const waiting = remoteRecords.get(key);
        if (
            waiting &&
            waiting.revision !== null &&
            ref.revision !== null &&
            (compareRevision(ref.revision, waiting.revision) ?? 0) <= 0
        ) {
            // A revision listing may have named this revision first: keep the patch for the cycle.
            if (ref.patch && !waiting.patch && waiting.revision === ref.revision) {
                waiting.patch = ref.patch;
            }
            continue;
        }
        remoteRecords.set(key, {
            kind: ref.kind,
            id: ref.id,
            revision: ref.revision,
            ...(ref.patch ? { patch: ref.patch } : {}),
        });
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
        const outcome = noteRemoteChat({ chaId: chat.characterId, chatId: chat.id }, chat.revision, chat.patch);
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

/**
 * Applies a live update's record patch without reading the record, when this client holds the record
 * at exactly the patch's base revision (of the loaded epoch, the same incarnation, one write before
 * the update) and has no local change of it (`canApplyRemote`): a character's field patch
 * (`RecordFieldPatch`) goes in raw (`patchRawCharacter`: no mark, no echo); another mirrored record
 * patch (except `llmSecrets`) is applied to a detached copy of the held text and the result goes through
 * the mirror's whole-record path (`applyToMirror`, as a read would). The saved text is the mirror's
 * projection afterwards, as for a whole update, and a waiting notice the update covers is settled.
 * The remote-change listeners hear of it unless only a character's `lastInteraction` changed (a send
 * job's stamp, as `mergeConcurrentChange` treats it). Returns false, changing nothing, for anything
 * else (another kind or patch form, another base, a local change, a malformed patch or one naming a
 * field twice, a character's fixed or client-only field or one the mirror object only inherits, an
 * item patch that does not fit the held list): the update is then read whole as before.
 */
function applyRemotePatch(ref: {
    kind: string;
    id: string;
    revision: string | null;
    blockedLocal?: string;
    patch?: RecordPatch;
}): boolean {
    const patch = ref.patch;
    if (
        !patch ||
        ref.kind === SECTION_KIND.llmSecrets ||
        (ref.kind !== RESOURCE_KIND.characters && !COLLECTIONS.includes(ref.kind as Collection)) ||
        ref.revision === null ||
        !matchesPatchRevision(patch, ref.revision)
    ) {
        return false;
    }
    const key = recordKey(ref.kind, ref.id);
    const held = persisted.get(key);
    if (held?.revision !== patch.baseRevision) {
        return false;
    }
    if (inDoubt.has(key)) {
        // The echo of a lost write is taken as the saved base; the mirror keeps this client's text.
        if (sendingKeys.has(key) || recordQuarantine(key) || isRecordJobBlocked(key)) {
            return false;
        }
        const data = patchedRecord(held.text, patch);
        if (data === null || !adoptInDoubt(key, ref.revision, recordText(ref.kind, data))) {
            return false;
        }
        const waiting = remoteRecords.get(key);
        if (waiting && waiting.revision !== null && (compareRevision(waiting.revision, ref.revision) ?? 1) <= 0) {
            remoteRecords.delete(key);
        }
        return true;
    }
    if (!canApplyRemote(key, ref)) {
        return false;
    }
    const changed =
        ref.kind === RESOURCE_KIND.characters
            ? applyCharacterPatch(ref.id, patch)
            : applyCollectionPatch(ref.kind, ref.id, held.text, patch);
    if (changed === null) {
        return false;
    }
    const projection = projectEntry(ref.kind, ref.id)!;
    persisted.set(key, { revision: ref.revision, ...projection });
    const waiting = remoteRecords.get(key);
    if (waiting && waiting.revision !== null && (compareRevision(waiting.revision, ref.revision) ?? 1) <= 0) {
        remoteRecords.delete(key);
    }
    if (changed) {
        notifyRemoteListeners(ref.kind, ref.id);
    }
    return true;
}

/**
 * A character's field patch into the mirror raw (`applyRemotePatch`). Returns null when it does not
 * apply, else whether a field other than `lastInteraction` changed.
 */
function applyCharacterPatch(id: string, patch: RecordPatch): boolean | null {
    const character = findMirrorCharacter(id);
    if (
        !character ||
        Object.hasOwn(patch, "items") ||
        !isPlainObject((patch as { set?: unknown }).set) ||
        !Array.isArray((patch as { remove?: unknown }).remove)
    ) {
        return null;
    }
    const { set, remove } = patch as { set: Record<string, unknown>; remove: unknown[] };
    const setFields = Object.keys(set);
    const fields = [...setFields, ...remove];
    if (
        new Set(fields).size !== fields.length ||
        fields.some(
            (field) =>
                typeof field !== "string" || CHARACTER_FIXED_FIELDS.has(field) || CHARACTER_LOCAL_KEYS.has(field),
        ) ||
        setFields.some((field) => assignsInherited(character, field))
    ) {
        return null;
    }
    let changes: (readonly [string, unknown])[];
    try {
        changes = [
            ...setFields.map((field) => [field, structuredClone(set[field])] as const),
            ...(remove as string[]).map((field) => [field, REMOVE_FIELD] as const),
        ];
    } catch {
        return null;
    }
    if (!patchRawCharacter(id, changes)) {
        return null;
    }
    return fields.some((field) => field !== "lastInteraction");
}

/** A patch must describe exactly the next write of the held incarnation, in this epoch. */
function matchesPatchRevision(patch: RecordPatch, revision: string): boolean {
    const base = parseRevisionToken(patch.baseRevision);
    const next = parseRevisionToken(revision);
    return (
        !!base &&
        !!next &&
        base.epoch === getResourceEpoch() &&
        next.epoch === base.epoch &&
        next.seq === base.seq &&
        next.revision === base.revision + 1
    );
}

/** A detached server record reconstructed from held text; null for a malformed or inapplicable patch. */
function patchedRecord(
    heldText: string,
    patch: RecordPatch,
): Record<string, unknown> | Record<string, unknown>[] | null {
    try {
        const value: unknown = JSON.parse(heldText);
        const copy = structuredClone(patch) as Record<string, unknown>;
        if (!isPlainObject(copy)) {
            return null;
        }
        if (["items", "changes", "order"].some((key) => Object.hasOwn(copy, key))) {
            if (!Object.hasOwn(copy, "items") || Object.hasOwn(copy, "set") || Object.hasOwn(copy, "remove")) {
                return null;
            }
            return applyItemPatch(value, checkItemPatch(copy));
        }
        if (!isPlainObject(value) || !isPlainObject(copy.set) || !Array.isArray(copy.remove)) {
            return null;
        }
        // The feed can carry an empty diff after normalization kept every value.
        if (Object.keys(copy.set).length === 0 && copy.remove.length === 0) {
            return value;
        }
        const checked = checkFields(copy.set, copy.remove, "a patch");
        return withFields(value, checked.set, checked.remove);
    } catch {
        return null;
    }
}

/** Apply a detached patch result through exactly the same mirror path as a whole read. */
function applyCollectionPatch(kind: string, id: string, heldText: string, patch: RecordPatch): boolean | null {
    const data = patchedRecord(heldText, patch);
    if (data === null) {
        return null;
    }
    applyToMirror(kind, id, data);
    return true;
}

/** Whether a live update of `key` may be applied now: this client has no unsent change of it. */
function canApplyRemote(key: string, entry: { kind: string; id: string; blockedLocal?: string }): boolean {
    if (sendingKeys.has(key) || recordQuarantine(key) || isRecordJobBlocked(key) || inDoubt.has(key)) {
        return false;
    }
    const held = persisted.get(key);
    if (!held) {
        // A new remote record can be adopted only while no local creation would be overwritten.
        return entry.kind === RESOURCE_KIND.characters
            ? !findMirrorCharacter(entry.id)
            : isAbsentMirroredSingleton(entry);
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

/**
 * Puts a live update into the mirror as the server holds it: no settled resource key, no notice.
 * Nothing of the record is discarded (`canApplyRemote` held it while it had a local change); a deleted
 * character's unsent chat work is, and this returns whether there was any.
 */
function applyRemoteRecord(
    item: { kind: string; id: string; revision: string | null; data: unknown },
    collection?: { characterId: string; order: ChatOrderRecord | null; chats: ChatSummary[] },
): boolean {
    const key = recordKey(item.kind, item.id);
    const isNew = item.kind === RESOURCE_KIND.characters && !persisted.has(key);
    const discardedWork = applyToMirror(item.kind, item.id, item.revision === null ? null : item.data);
    if (item.revision === null) {
        persisted.delete(key);
    } else {
        persisted.set(key, {
            revision: item.revision,
            ...(projectEntry(item.kind, item.id) ?? { text: recordText(item.kind, item.data) }),
        });
    }
    if (isNew && collection) {
        applyRemoteCollection(collection);
    }
    notifyRemoteListeners(item.kind, item.id);
    return discardedWork;
}

/**
 * Reads and applies the waiting live updates (part of the cycle, before its batch, so it never races
 * this client's own write): first every waiting field patch this client can now take without a read
 * (`applyRemotePatch`), then the records this client can take now and the chat lists of characters
 * with no order work, at most `MAX_REMOTE_READS` of each. Eligibility is checked again after the
 * read: a change made meanwhile keeps the update waiting. A read settles only the notice it was
 * issued for, or a later one its answer covers. A deletion applies only if the held revision is
 * unchanged since the read was issued; otherwise it is read again. Returns whether a character
 * deletion discarded unsent chat work (the cycle shows the reload notice).
 */
async function applyRemoteUpdates(): Promise<boolean> {
    settleRemoteRecords();
    for (const entry of [...remoteRecords.values()]) {
        if (entry.patch) {
            applyRemotePatch(entry);
        }
    }
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
        return false;
    }
    const issuedEntries = new Map(records);
    const issuedHeld = new Map(records.map(([key]) => [key, persisted.get(key)?.revision ?? null]));
    const issuedSeqs = new Map(collections.map((id) => [id, remoteCollections.get(id)]));
    const issuedChats = heldChatRevisionsByCharacter(collections);
    const read = await readRefs(
        records.map(([, entry]) => ({ kind: entry.kind, id: entry.id })),
        { chatSummaryCollections: collections },
    );
    await tick();
    if (halted) {
        return false;
    }
    let discardedWork = false;
    const collectionOf = new Map((read.chatSummaryCollections ?? []).map((entry) => [entry.characterId, entry]));
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
            discardedWork = applyRemoteRecord(item) || discardedWork;
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
    return discardedWork;
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
 * an outgoing write: no discard, no `discardSequence` bump, no settled key, no
 * notice. Applied only when the token is of the loaded epoch and newer by `(seq, revision)` than
 * the one this client holds, and the client has no local change of it: not in the batch in flight,
 * its projection still equal to the saved text (a dirty mark alone is no change), and not a character
 * delete the server refused for a generating message (`isRecordJobBlocked`). A generating character's
 * record is applied at once. A record refused for a local change is kept (the newest) and checked
 * again after the next save cycle. A record this client does not hold, a deletion, `llmSecrets`,
 * and `authRefreshes` are not hydrated. A chat goes to `hydrateChat`.
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
    if (
        sendingKeys.has(key) ||
        isRecordJobBlocked(key) ||
        inDoubt.has(key) ||
        projectRecord(record.kind, record.id) !== held.text
    ) {
        // A local change (or one being sent): keep the newest event and check it again after the
        // next cycle; by then the save has landed (and is older) or conflicted and reloaded. A dirty
        // mark alone, with the projection still equal to the saved text, is no change.
        const waiting = deferredHydrations.get(key);
        if (!waiting || (compareRevision(record.revision, waiting.revision) ?? 0) > 0) {
            deferredHydrations.set(key, record);
        }
        return false;
    }
    applyToMirror(record.kind, record.id, record.data);
    persisted.set(key, {
        revision: record.revision,
        ...(projectEntry(record.kind, record.id) ?? { text: JSON.stringify(record.data) }),
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
 * Applies a job's `chatPatch` as `applyHydration` applies a whole chat (never an outgoing write),
 * through `hydrateChatPatch`: `"mismatch"` asks the caller to request the chat whole.
 */
export function applyPatchHydration(
    patch: ChatPatch,
    job?: { jobId: string; streaming: readonly StreamingMessage[] },
): "applied" | "busy" | "mismatch" | "old" {
    if (halted || parseRevisionToken(patch.revision)?.epoch !== getResourceEpoch()) {
        return "old";
    }
    return hydrateChatPatch(patch, job);
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
    const hydrating = new Set([...hydrate, ...listRefresh]);
    const secretTarget = new Set(llmSecretState.queue.map((op) => op.id));
    const pending = () =>
        llmSecretState.queue.some((op) => secretTarget.has(op.id)) ||
        unsettled().length > 0 ||
        membershipAcked < membershipTarget ||
        unsettledChatObligations(chatObligations).length > 0 ||
        [...hydrating].some((id) => hydrate.has(id) || listRefresh.has(id));
    for (let attempt = 0; attempt < 10 && pending(); attempt += 1) {
        if (halted) {
            throw new Error("Saving stopped: the server data was restored");
        }
        if (
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
    const ids = new Set(characterData().map((character) => character.chaId as string));
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
 * Starts saving. Every collection and every character is marked once, and the membership once, so
 * the client's load-time writes (the boot's defaults, its trash pruning and order repair) reach
 * the server; unchanged records compare equal and are not sent.
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
    // The settings records mark themselves: every local write of one (`records.svelte.ts`).
    setRecordWriteListener((kind) => {
        markKey(collectionKey(kind));
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
        // A halted loop (the data was replaced) can save nothing more: no warning, so the reload after
        // the restore notice goes through.
        if (!halted && hasUnsavedWork()) {
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
    // Every local write of a character marks it at once; a membership change wakes the loop.
    setCharacterWriteListener({
        character: (chaId) => markKey(characterKey(chaId)),
        membership: markMembership,
    });
    for (const collection of COLLECTIONS) {
        markKey(collectionKey(collection));
    }
    for (const character of characterData()) {
        markKey(characterKey(character.chaId as string));
    }
    markMembership();
}
