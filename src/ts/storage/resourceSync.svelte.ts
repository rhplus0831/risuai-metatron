import isEqual from "lodash/isEqual";
import {
    ABSENT,
    fieldOf,
    isItemMergeKind,
    mergeCharacterFields,
    mergeItemCollection,
    mergeSectionFields,
} from "./recordMerge";
import { newId } from "../../../shared/ids.ts";
import {
    JOURNAL_FORMAT,
    JOURNAL_LAYER_NAMES,
    MAX_JOURNAL_ENTRY_BYTES,
    journalValueSize,
    pageDraftJournal,
    recordTarget,
    type JournalWrite,
    type ConflictDraft,
    type DraftInput,
    type JournalRemoval,
    type RecordLayerValues,
    type StoredLayers,
    type MutationEntry,
} from "./draftJournal";
import { isJournalEligible } from "./journalEligibility";
import { tick, untrack } from "svelte";
import { get } from "svelte/store";
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
import { alertError, alertNormal, alertReloadNotice, alertTerminal, reloadNotice } from "../alert";
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
    type ChatJournalKey,
    chatJournal,
    acceptRemoteCollection,
    ackChatWork,
    applyRemoteCollection,
    canApplyRemoteCollection,
    heldChatRefs,
    heldChatRevision,
    heldChatRevisionsByCharacter,
    heldOrderRevision,
    issueChatReadStamp,
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
    hydrateChat,
    hydrateChatPatch,
    isChatBehind,
    type ChatPatch,
    JOB_RETRY_MS,
    hasUnsavedChatWork,
    hasRefusedChatWork,
    refusedChatItems,
    retryRefusedChat,
    discardRefusedChat,
    type RefusedChatItem,
    isCharacterStreamedHere,
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
    idleChatRows,
    finishIdleChatRows,
    idleSummaryRefreshes,
    scheduleTrim,
    settleSummaryRefresh,
    summaryRefreshNotices,
    chatNoticeSeq,
    finishIdleChatRefresh,
    noteIdleChatRead,
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
    epochMismatch,
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
 * and each cycle orders them after resource ops, splitting requests when needed.
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
 * - Requests split at the operation/byte caps or isolate refusals; one cycle is in flight. A key
 *   stays dirty if it was marked again while its batch was in flight.
 * - Eligible record, chat, and order intent is mirrored to the page's draft journal. One serialized
 *   queue coalesces pre-dispatch deltas and debounces later outcomes; hide flushes run independently
 *   of the network. Creates wait at most 200 ms; a split chat batch waits for journal confirmation.
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
 *   writer committed are read by an independent refresh queue, only while this client
 *   has no unsent change of them; nothing is discarded and no notice is shown. A record with a local
 *   change waits: its save then lands (the update is older) or conflicts (the normal 409 path).
 *
 * Transport maps are plain; `saving` and the refusal inventory counter are reactive.
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
export const MAX_BATCH_OPERATIONS = 5000;
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

const recordKey = recordTarget;
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
let refusalVersion = $state(0);
const recordAlerts = new Set<string>();

function notifyRefusals() {
    untrack(() => {
        refusalVersion += 1;
    });
}

function clearRecordRefusal(key: string) {
    if (quarantinedRecords.delete(key)) {
        queueJournalRecord(key);
        notifyRefusals();
    }
}
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
let stopped = false;
let removeLifecycleListeners: (() => void) | null = null;
let unloadAuthInterval: ReturnType<typeof setInterval> | null = null;
let stopChatDriftCheck: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** When the scheduled cycle runs; a later mark never postpones it. */
let timerDeadline = 0;
/** No cycle before this time after a failure (retry backoff), whatever marks arrive. */
let backoffUntil = 0;
/** Characters whose chat list must be read from the server (a recovery inserted or emptied them). */
const hydrate = new Set<string>();
/**
 * Characters whose chat list an acknowledgement showed another writer changed (`ackChatWork`), or
 * whose membership replay or adopted create supplied no order: read as a live update that keeps a
 * queued reorder (`applyRemoteCollection` with `keepPendingOrder`), unless a kept chat with a held revision is
 * missing from the server's list: then the reorder is discarded with the notice and report. Their
 * reorders wait until then.
 */
const listRefresh = new Set<string>();
/** List refreshes parked while the character is absent locally; a same-id re-add resumes them. */
const parkedListRefresh = new Set<string>();
let inFlight: Promise<boolean> | null = null;
let refreshInFlight: Promise<void> | null = null;
let refreshFailures = 0;
const reportedRefreshErrors = new WeakSet<object>();
let refreshBackoffUntil = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshDeadline = 0;
const readControllers = new Set<AbortController>();
const READ_DEADLINE_MS = 20_000;
const characterRefreshes = new Map<string, Promise<boolean>>();
const deferredRefreshes = new Map<string, Promise<boolean>>();
const listReadGenerations = new Map<string, number>();
const characterWriteSerials = new Map<string, number>();
const writingCharacters = new Map<string, number>();
let cycleWrote = false;
let recoveringConflict = false;
const unloadWrites = new Map<string, Promise<void>>();
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
 * Live updates waiting to be read and applied by the refresh queue: record key → the newest revision
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
/**
 * A live update waits this long, so the refs of a burst of commits are read together; an earlier
 * pending wakeup may read sooner and refresh backoff may delay it.
 */
const REMOTE_DELAY_MS = 50;
/**
 * Most records, chat lists, and idle chats (each counted on its own) one refresh read requests;
 * the rest wait for the next pass.
 */
const MAX_REMOTE_READS = 1000;

type JournalRecordLayers = Partial<RecordLayerValues>;
type JournalRecordView = {
    epoch: string;
    desired: JournalRecordLayers;
    written: StoredLayers<"record">;
    dispatched?: RecordLayerValues["sent"];
    projection?: {
        generation: number;
        character: character | groupChat | undefined;
        value: Projection | undefined;
        canonical: boolean;
    };
    largeWriteAt?: number;
    skippedGeneration?: number;
};
/**
 * Keys touched by this page, including captured layers handed over by boot recovery. Eligible
 * record intent uses the loaded epoch and recordTarget(kind, id): sent holds the dispatched/doubt
 * op, base and whole text; latest holds newer intent, including a revert or blocked character
 * delete; refused holds the exact op/text/reason. Membership creates and deletes are records too.
 * Membership changes queue only creates, deletes, in-doubt characters and characters already holding
 * journal intent. Unchanged characters retain their cached projections; collection reuses the
 * character object already in its loop instead of looking it up again.
 */
const journalRecords = new Map<string, JournalRecordView>();
const journalPending = new Set<string>();
const journalWritingRecords = new Set<string>();
type JournalChatView = {
    key: ChatJournalKey;
    epoch: string;
    written: Record<string, { version: number; value: unknown }>;
    splitFailures?: { groupId: string; count: number };
};
/**
 * Scope is part of identity; these keys never enter the record projection loop. Detached per-layer
 * projections come from src/ts/storage/chatStore.svelte.ts; bookkeeping and captured versions stay
 * separate from records while sharing the same journal transaction.
 */
const journalChatViews = new Map<string, JournalChatView>();
const journalChatPending = new Set<string>();
/** Includes captures in a transaction until its commit is known, so restore can snapshot them too. */
const conflictDrafts = new Map<string, ConflictDraft>();

/**
 * Capture before accepting a server copy, using a detached value and a stable id. Failed transactions
 * and restore snapshots reuse that id. Cleanup may commit without an ineligible or over-budget
 * draft; off or halted journaling cannot preserve discarded intent.
 */
function queueConflictDraft(input: DraftInput) {
    if (halted || journalOff) return;
    if (input.scope === "record") {
        const kind = input.target.split("\u0000")[0];
        if (
            !Object.values(input.layers).every(
                (value) => !value || isJournalEligible({ scope: "record", kind, text: value.text }),
            )
        )
            return;
    } else if (!isJournalEligible({ scope: input.scope })) return;
    const draft = structuredClone({ ...input, id: newId(), createdAt: Date.now() });
    conflictDrafts.set(draft.id, draft);
    scheduleJournal();
}

function captureJournalChat(projection: ReturnType<typeof chatJournal.project>) {
    if (halted || journalOff) return;
    const view = journalChatViews.get(`${projection.scope}\u0000${projection.target}`);
    queueConflictDraft({ ...projection, epoch: view?.epoch ?? getResourceEpoch() });
}

/**
 * Snapshot potentially abandoned record intent before clearing inDoubt and attempting a 409 merge:
 * the sent/doubt value, newest local text or deletion, and exact refused text. Queue this capture
 * only if the merge fails and the remote copy is accepted, or hydration finds the character gone.
 * Recognized or adopted landed writes bypass capture; successful merges discard the candidate;
 * clean records yield none.
 */
function captureRecordConflict(key: string, op?: PendingOp, gone = false): DraftInput | undefined {
    const view = journalView(key);
    if (!view) return;
    const [kind, id] = key.split("\u0000");
    const base = persisted.get(key);
    const text = journalProjection(key, kind, id)?.text ?? null;
    const doubt = inDoubt.get(key);
    const refusal = quarantinedRecords.get(key);
    const sent = doubt
        ? { ...journalOperation(doubt.text, doubt.baseRevision), dispatched: true as const, inDoubt: true }
        : (view.dispatched ??
          (op
              ? { ...journalOperation(op.text, op.baseRevision), dispatched: true as const, inDoubt: false }
              : undefined));
    const membership = kind === RESOURCE_KIND.characters && (text === null) !== (base === undefined);
    if (gone && text === null) return;
    if ((!dirty.has(key) || text === (base?.text ?? null)) && !membership && !sent && !refusal) return;
    const layers: Partial<RecordLayerValues> = {};
    if (sent) layers.sent = sent;
    if (refusal)
        layers.refused = {
            op: view.desired.refused?.op ?? journalOperation(refusal.text, base?.revision ?? null).op,
            text: refusal.text,
            reason: refusal.error.message,
        };
    if (sent ? text !== sent.text : !refusal || text !== refusal.text) {
        layers.latest = journalOperation(text, base?.revision ?? null);
    }
    return { scope: "record", target: recordTarget(kind, id), epoch: view.epoch, layers };
}

function queueJournalChat(key: ChatJournalKey) {
    if (halted) return;
    if (journalOff) {
        if (key.scope === "chat") {
            const split = chatJournal.splitGroupId(key.target);
            if (split) chatJournal.confirmSplit(key.target, split);
        }
        return;
    }
    const scoped = `${key.scope}\u0000${key.target}`;
    if (!journalChatViews.has(scoped)) {
        journalChatViews.set(scoped, { key, epoch: getResourceEpoch(), written: {} });
    }
    journalChatPending.add(scoped);
    scheduleJournal();
}

function disableChatJournal() {
    for (const { key } of journalChatViews.values()) {
        if (key.scope === "chat") {
            const split = chatJournal.splitGroupId(key.target);
            if (split) chatJournal.confirmSplit(key.target, split);
        }
    }
    journalChatPending.clear();
    journalChatViews.clear();
    conflictDrafts.clear();
    chatJournal.setConflictListener(null);
}

function hasJournalPending() {
    return journalPending.size > 0 || journalChatPending.size > 0 || conflictDrafts.size > 0;
}
let journalQueue: Promise<void> = Promise.resolve();
let journalOff = false;
let journalTimer: ReturnType<typeof setTimeout> | null = null;
let journalDeadline = 0;
const LARGE_JOURNAL_BYTES = 256 * 1024;
const LARGE_JOURNAL_INTERVAL_MS = 5000;
const JOURNAL_CREATE_WAIT_MS = 200;
const JOURNAL_RESTORE_WAIT_MS = 1000;
const RECORD_JOURNAL_LAYERS = ["sent", "latest", "refused"] as const;

function journalView(key: string): JournalRecordView | undefined {
    if (journalOff || halted) {
        return;
    }
    const [kind] = key.split("\u0000");
    // Excluded kinds never reach the journal's synchronous clone of the plaintext.
    if (!isJournalEligible({ scope: "record", kind, text: null })) {
        return;
    }
    let view = journalRecords.get(key);
    if (!view) {
        view = { epoch: getResourceEpoch(), desired: {}, written: {} };
        journalRecords.set(key, view);
    }
    return view;
}

function scheduleJournal(delay = DEBOUNCE_MS) {
    if (halted || journalOff || !hasJournalPending()) {
        return;
    }
    const deadline = Date.now() + delay;
    if (journalTimer && journalDeadline <= deadline) {
        return;
    }
    if (journalTimer) {
        clearTimeout(journalTimer);
    }
    journalDeadline = deadline;
    journalTimer = setTimeout(() => {
        journalTimer = null;
        // A cycle due in this same turn absorbs the deltas into its pre-dispatch transaction.
        if (timer && timerDeadline <= Date.now() && !inFlight) {
            return;
        }
        void flushJournal();
    }, delay);
}

function queueJournalRecord(key: string, invalidateProjection = false) {
    const view = journalView(key);
    if (!view) {
        return;
    }
    if (invalidateProjection) {
        view.projection = undefined;
    }
    journalPending.add(key);
    scheduleJournal();
}

function rememberJournalProjection(
    key: string,
    value: Projection | undefined,
    canonical = false,
    character?: character | groupChat,
) {
    const view = journalView(key);
    if (view) {
        view.projection = {
            generation: dirty.get(key) ?? acked.get(key) ?? 0,
            character,
            value,
            canonical,
        };
    }
    return value;
}

/** Collection and hide/timer snapshots share a projection until a local mark or raw replacement. */
function journalProjection(
    key: string,
    kind: string,
    id: string,
    character = kind === RESOURCE_KIND.characters ? findMirrorCharacter(id) : undefined,
): Projection | undefined {
    const cached = journalView(key)?.projection;
    if (cached && cached.generation === (dirty.get(key) ?? acked.get(key) ?? 0) && cached.character === character) {
        return cached.value;
    }
    const projection =
        kind === RESOURCE_KIND.characters
            ? character
                ? characterProjection(character)
                : undefined
            : projectEntry(kind, id);
    return rememberJournalProjection(key, projection, false, character);
}

const journalOperation = (text: string | null, baseRevision: string | null): RecordLayerValues["latest"] => ({
    op: text === null ? "delete" : baseRevision === null ? "create" : "update",
    baseRevision,
    text,
});

/**
 * Record intent, separately from sendable operations: a blocked delete, a removed in-doubt create,
 * and a revert behind a sent write still belong here. This never takes or settles chat work.
 * Projections are reused at the same dirty generation and character identity; dispatch, doubt,
 * refusal and base changes independently change the layers. Acks, adopted lost writes and merges
 * move newer intent to the base we will send; refusal replaces sent until an edit or Retry releases
 * it, and acceptance of a remote copy removes discarded intent.
 */
function refreshJournalRecord(key: string, view: JournalRecordView) {
    const [kind, id] = key.split("\u0000");
    const current = persisted.get(key);
    let projection = journalProjection(key, kind, id);
    if (
        kind === RESOURCE_KIND.characters &&
        projection &&
        projection.text !== current?.text &&
        !inDoubt.has(key) &&
        !view.projection?.canonical
    ) {
        projection = rememberJournalProjection(
            key,
            canonicalCharacter(id, projection),
            true,
            view.projection?.character,
        );
    }
    const text = projection?.text ?? null;
    const refusal = recordQuarantine(key, text);
    // Hydration can make an old refusal's text the saved copy; it holds no unsaved intent then.
    const refused = text !== (current?.text ?? null) ? refusal : null;
    const doubt = inDoubt.get(key);
    const sent = refused
        ? undefined
        : (view.dispatched ??
          (doubt
              ? { ...journalOperation(doubt.text, doubt.baseRevision), dispatched: true as const, inDoubt: true }
              : undefined));
    const held = projection !== undefined || (kind === RESOURCE_KIND.characters && (current || sent));
    const intent = held ? journalOperation(text, current?.revision ?? null) : undefined;
    const latest =
        !refused &&
        intent &&
        (sent
            ? intent.text !== sent.text || intent.baseRevision !== sent.baseRevision
            : intent.text !== (current?.text ?? null))
            ? intent
            : undefined;
    view.desired = {
        sent,
        latest,
        refused: refused
            ? {
                  op: view.desired.refused?.op ?? journalOperation(text, current?.revision ?? null).op,
                  text,
                  reason: refused.message,
              }
            : undefined,
    };
}

function journalDispatched(ops: readonly PendingOp[]) {
    for (const op of ops) {
        const view = journalView(op.key);
        if (view) {
            const doubt = inDoubt.get(op.key);
            view.dispatched = {
                ...journalOperation(op.text, op.baseRevision),
                dispatched: true,
                inDoubt: doubt?.text === op.text && doubt.baseRevision === op.baseRevision,
            };
            queueJournalRecord(op.key);
        }
    }
}

/** An answer (or a lost answer) leaves only the intent the adapter still holds. */
function journalSettled(key: string) {
    if (halted) return;
    const view = journalRecords.get(key);
    if (view) {
        view.dispatched = undefined;
        queueJournalRecord(key);
    }
}

function journalDiscarded(key: string) {
    if (halted) return;
    const view = journalRecords.get(key);
    if (view) {
        view.dispatched = undefined;
        view.desired = {};
        queueJournalRecord(key, true);
    }
}

function sameJournalLayer(a: RecordLayerValues[keyof RecordLayerValues] | undefined, b: typeof a): boolean {
    if (!a || !b) {
        return a === b;
    }
    return (
        a.op === b.op &&
        a.text === b.text &&
        ("baseRevision" in a ? "baseRevision" in b && a.baseRevision === b.baseRevision : !("baseRevision" in b)) &&
        ("inDoubt" in a ? "inDoubt" in b && a.inDoubt === b.inDoubt : !("inDoubt" in b)) &&
        ("reason" in a ? "reason" in b && a.reason === b.reason : !("reason" in b))
    );
}

/**
 * Normal flushes are serialized after startup seeds the version counter, including removals. A
 * failed start disables journaling for this page; a restore halt also stops calls waiting on startup.
 * Normal record and unsplit chat/order flushes rewrite only changed layers. A split chat rewrites
 * its whole projection to obtain a per-item outcome. Removals use each layer's captured written
 * version. This adapter never reads or recovers old rows; src/ts/storage/journalRecovery.ts hands
 * them over at boot.
 * Whole record text above 256 KiB UTF-8 is throttled to one write per 5 s per key, except creates and
 * hide flushes. Deferred replacements keep the prior stored value while newer memory supersedes or
 * cancels them; absent desired layers are removed immediately. Chat/order layers have no throttle.
 * Credential-bearing kinds are excluded before cloning. Summed text lengths above 16 MiB skip
 * changed layers and remove their prior values while retaining unchanged layers, reporting tooLarge
 * once per key/content generation. src/ts/storage/draftJournal.ts still owns full eligibility and
 * exact UTF-8 budgets. A transaction failure retains conflict captures and unadvanced record
 * bookkeeping; failed chat writes retry. Split prefixes require an actual per-item write outcome.
 */
function flushJournal(onHide = false): Promise<void> {
    if (journalTimer) {
        clearTimeout(journalTimer);
        journalTimer = null;
    }
    if (halted || journalOff || !hasJournalPending()) {
        return journalQueue;
    }
    journalQueue = journalQueue
        .then(async () => {
            if (halted || journalOff || !hasJournalPending()) {
                return;
            }
            const journal = pageDraftJournal();
            const enabled = await journal.start();
            if (halted) {
                return;
            }
            if (!enabled || !journal.enabled) {
                journalOff = true;
                if (journalTimer) {
                    clearTimeout(journalTimer);
                    journalTimer = null;
                }
                journalPending.clear();
                journalRecords.clear();
                disableChatJournal();
                return;
            }
            const writes: JournalWrite[] = [];
            const removals: JournalRemoval[] = [];
            const recordChanges: {
                key: string;
                view: JournalRecordView;
                written: StoredLayers<"record">;
                largeWriteAt?: number;
            }[] = [];
            const drafts = [...conflictDrafts.values()];
            let nextDelay = Infinity;
            const now = Date.now();
            for (const key of journalPending) {
                const view = journalRecords.get(key)!;
                const written = { ...view.written };
                let largeWriteAt = view.largeWriteAt;
                recordChanges.push({ key, view, written });
                refreshJournalRecord(key, view);
                const desired = view.desired;
                const values = Object.values(desired).filter((value) => value !== undefined);
                const tooLarge =
                    values.reduce((sum, value) => sum + (value.text?.length ?? 0), 0) > MAX_JOURNAL_ENTRY_BYTES;
                const contentGeneration = Math.max(
                    dirty.get(key) ?? acked.get(key) ?? 0,
                    key.startsWith(characterPrefix) ? membershipGeneration : 0,
                );
                if (tooLarge && view.skippedGeneration !== contentGeneration) {
                    recordClientEvent({ kind: "sync", phase: "journalSkipped", reason: "tooLarge", entries: 1 });
                    view.skippedGeneration = contentGeneration;
                }
                const changed = RECORD_JOURNAL_LAYERS.filter(
                    (name) => !sameJournalLayer(desired[name], view.written[name]?.value),
                );
                const large =
                    !tooLarge &&
                    changed.some((name) => {
                        const text = desired[name]?.text;
                        return (
                            text &&
                            (text.length > LARGE_JOURNAL_BYTES ||
                                (text.length * 3 > LARGE_JOURNAL_BYTES && utf8ByteLength(text) > LARGE_JOURNAL_BYTES))
                        );
                    });
                const wait = (view.largeWriteAt ?? -Infinity) + LARGE_JOURNAL_INTERVAL_MS - now;
                const deferred = !onHide && large && wait > 0 && !values.some((value) => value.op === "create");
                const layers: JournalRecordLayers = {};
                for (const name of RECORD_JOURNAL_LAYERS) {
                    const stored = view.written[name];
                    const value = desired[name];
                    // Keep unchanged layers when a write is over budget, and keep a throttled
                    // layer until replacement. Settled layers and older values of skipped changes
                    // go through their captured versions.
                    if (stored && (!value || (tooLarge && changed.includes(name)))) {
                        removals.push({
                            epoch: view.epoch,
                            scope: "record",
                            target: key,
                            version: stored.version,
                            layers: [name],
                        });
                        delete written[name];
                    }
                    if (!tooLarge && !deferred && value && changed.includes(name)) {
                        Object.assign(layers, { [name]: value });
                    }
                }
                if (Object.keys(layers).length > 0) {
                    const version = journal.nextVersion();
                    writes.push({ epoch: view.epoch, scope: "record", target: key, version, layers });
                    for (const name of RECORD_JOURNAL_LAYERS) {
                        if (layers[name]) {
                            Object.assign(written, { [name]: { version, value: layers[name] } });
                        }
                    }
                    if (large) {
                        largeWriteAt = now;
                    }
                }
                recordChanges[recordChanges.length - 1].largeWriteAt = largeWriteAt;
                if (deferred) {
                    nextDelay = Math.min(nextDelay, wait);
                } else {
                    journalPending.delete(key);
                    if (values.length === 0) {
                        view.projection = undefined;
                    }
                }
            }
            // Chat projections are detached and cached per layer by their owner. Failed writes
            // retain their captured versions for retry; split confirmation needs the actual result.
            const chatWrites: {
                scoped: string;
                view: JournalChatView;
                index: number;
                layers: Record<string, unknown>;
                removed: string[];
                version: number;
                splitGroupId?: string;
            }[] = [];
            for (const scoped of journalChatPending) {
                const view = journalChatViews.get(scoped)!;
                const projection = chatJournal.project(view.key);
                const desired: Record<string, unknown> = projection.layers;
                const layers: Record<string, unknown> = {};
                const removed: string[] = [];
                for (const name of new Set([...Object.keys(view.written), ...Object.keys(desired)])) {
                    const value = desired[name];
                    const stored = view.written[name];
                    if (value === undefined) {
                        if (stored) {
                            removals.push({ ...view.key, epoch: view.epoch, version: stored.version, layers: [name] });
                            removed.push(name);
                        }
                    } else if (!stored || !isEqual(value, stored.value)) {
                        layers[name] = value;
                    }
                }
                const splitGroupId = projection.scope === "chat" ? projection.splitGroupId : undefined;
                // Even an unchanged split must get a per-item outcome, not merely a resolved flush.
                if (splitGroupId) Object.assign(layers, desired);
                journalChatPending.delete(scoped);
                if (Object.keys(layers).length === 0 && removed.length === 0) continue;
                const version = journal.nextVersion();
                chatWrites.push({ scoped, view, index: writes.length, layers, removed, version, splitGroupId });
                writes.push({ ...view.key, epoch: view.epoch, version, layers } as JournalWrite);
            }
            if (writes.length > 0 || removals.length > 0 || drafts.length > 0) {
                for (const { key } of recordChanges) journalWritingRecords.add(key);
                const result = await journal.write(writes, removals, drafts);
                journalWritingRecords.clear();
                if (halted) return;
                const outcomes = result.writes;
                if (result.committed) {
                    for (const item of recordChanges) {
                        item.view.written = item.written;
                        item.view.largeWriteAt = item.largeWriteAt;
                    }
                    for (const draft of drafts) conflictDrafts.delete(draft.id);
                    if (result.drafts.includes("written")) {
                        void import("./recoveryDrafts.svelte")
                            .then(({ recoveryDrafts }) => {
                                if (!halted) return recoveryDrafts.refresh();
                            })
                            .catch((error) => console.warn("[Save journal]", error));
                    }
                } else {
                    for (const { key } of recordChanges) journalPending.add(key);
                }
                for (const item of chatWrites) {
                    const outcome = outcomes[item.index];
                    if (outcome === "off") {
                        journalOff = true;
                        journalPending.clear();
                        journalRecords.clear();
                        disableChatJournal();
                        break;
                    }
                    if (outcome === "failed" || !outcome) {
                        journalChatPending.add(item.scoped);
                        if (item.splitGroupId) {
                            const previous = item.view.splitFailures;
                            const count = previous?.groupId === item.splitGroupId ? previous.count + 1 : 1;
                            item.view.splitFailures = { groupId: item.splitGroupId, count };
                            // Saving proceeds after repeated failure; a broken journal can retain
                            // the older whole-batch row, so recovery has a documented loss window.
                            if (count >= 2) chatJournal.confirmSplit(item.view.key.target, item.splitGroupId);
                        }
                        continue;
                    }
                    for (const name of item.removed) delete item.view.written[name];
                    for (const [name, value] of Object.entries(item.layers)) {
                        if (value !== undefined) item.view.written[name] = { version: item.version, value };
                    }
                    if (item.splitGroupId) {
                        if (outcome === "written" || outcome === "skipped" || outcome === "ineligible") {
                            chatJournal.confirmSplit(item.view.key.target, item.splitGroupId);
                            item.view.splitFailures = undefined;
                        } else {
                            journalChatPending.add(item.scoped);
                        }
                    }
                }
            }
            if (
                journalChatPending.size > 0 ||
                conflictDrafts.size > 0 ||
                (journalPending.size > 0 && !Number.isFinite(nextDelay))
            )
                scheduleJournal();
            if (Number.isFinite(nextDelay)) {
                scheduleJournal(Math.max(0, now + nextDelay - Date.now()));
            }
        })
        .catch((error) => {
            // Journaling must never reject a save or leave a rejected queue behind it.
            console.warn("[Save journal]", error);
            recordClientEvent({ kind: "sync", phase: "journalFailed", reason: "write" });
        });
    return journalQueue;
}

type RestoreJournalItem = {
    write: JournalWrite;
    changed?: (keyof RecordLayerValues)[];
};

/**
 * Capture synchronously before halting or settling anything: record projection can invalidate a
 * refusal and queue more work. Include every record with desired/written layers or a transaction
 * in flight, plus every chat/order view, even an empty projection, to fence outstanding writes.
 */
function captureRestoreJournal(): RestoreJournalItem[] {
    const snapshot: RestoreJournalItem[] = [];
    for (const [key, view] of journalRecords) {
        refreshJournalRecord(key, view);
        if (
            !journalWritingRecords.has(key) &&
            !RECORD_JOURNAL_LAYERS.some((name) => view.desired[name] || view.written[name])
        )
            continue;
        snapshot.push({
            write: {
                epoch: view.epoch,
                scope: "record",
                target: key,
                version: 0,
                layers: Object.fromEntries(RECORD_JOURNAL_LAYERS.map((name) => [name, view.desired[name] ?? null])),
            },
            changed: RECORD_JOURNAL_LAYERS.filter(
                (name) => !sameJournalLayer(view.desired[name], view.written[name]?.value),
            ),
        });
    }
    // Written chat layers lag pending transactions. Even an empty projection must fence every
    // absent layer, so an outstanding write cannot bring settled work back after the snapshot.
    for (const view of journalChatViews.values()) {
        const projection = chatJournal.project(view.key);
        const desired: Record<string, unknown> = projection.layers;
        snapshot.push({
            write: {
                ...view.key,
                epoch: view.epoch,
                version: 0,
                layers: Object.fromEntries(
                    JOURNAL_LAYER_NAMES[view.key.scope].map((name) => [name, desired[name] ?? null]),
                ),
            } as JournalWrite,
        });
    }
    return structuredClone(snapshot);
}

/**
 * Bypass the adapter's journalQueue and large-record throttle so a stalled normal flush does not
 * prevent this attempt; IndexedDB transaction serialization still applies. After startup seeds the
 * counter, one fresh version writes or nulls every scope layer under its old epoch, superseding
 * pre-halt writes/removals even if they finish later. Oversized records drop changed layers while
 * preserving unchanged ones. src/ts/storage/draftJournal.ts skips reserved chat/order keys; the
 * next boot drafts old-epoch rows instead of replaying them.
 */
async function writeRestoreJournal(snapshot: RestoreJournalItem[], drafts: ConflictDraft[]) {
    if (journalOff || (snapshot.length === 0 && drafts.length === 0)) return;
    const journal = pageDraftJournal();
    if (!(await journal.start()) || !journal.enabled) return;
    // Bypass the normal queue: it may be stuck. Startup must seed the counter before this version
    // supersedes every pre-halt write and removal, even one that completes after the notice.
    const version = journal.nextVersion();
    const writes = snapshot.map(({ write, changed }) => {
        write.version = version;
        if (write.scope === "record") {
            const layers = Object.fromEntries(
                Object.entries(write.layers)
                    .filter(([, value]) => value != null)
                    .map(([name, value]) => [name, { version, value }]),
            );
            // Match the stored row's UTF-8 size, including its envelope. Rewriting an unchanged
            // layer into an oversized row would let the journal trim it along with the changes.
            const size = journalValueSize({
                ...write,
                layers,
                format: JOURNAL_FORMAT,
                type: "mutation",
                tabId: journal.tabId,
                createdAt: 0,
                updatedAt: 0,
                size: 0,
            });
            if (size > MAX_JOURNAL_ENTRY_BYTES) {
                write.layers = Object.fromEntries(changed!.map((name) => [name, null]));
                recordClientEvent({ kind: "sync", phase: "journalSkipped", reason: "tooLarge", entries: 1 });
            }
        }
        return write;
    });
    await journal.write(writes, [], drafts);
}

async function waitForRestoreJournal(snapshot: RestoreJournalItem[], drafts: ConflictDraft[]) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            writeRestoreJournal(snapshot, drafts).catch((error) => {
                console.warn("[Save journal]", error);
                recordClientEvent({ kind: "sync", phase: "journalFailed", reason: "write" });
            }),
            new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                    console.warn("[Save journal] Restore snapshot timed out");
                    recordClientEvent({ kind: "sync", phase: "journalFailed", reason: "timeout" });
                    resolve();
                }, JOURNAL_RESTORE_WAIT_MS);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/** Bound the wait for a create's dispatched journal mark to 200 ms. */
async function waitForCreateJournal(flush: Promise<void>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            flush,
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, JOURNAL_CREATE_WAIT_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** Records what the server holds, from the boot read. Call before the boot installs the records. */
export function seedResources(result: ResourceReadKindsResult) {
    setResourceEpoch(result.epoch);
    persisted.clear();
    inDoubt.clear();
    parkedListRefresh.clear();
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

/** A detached view of the server baseline; recovery must never seed it with local intent. */
export function heldRecordSnapshot(kind: string, id: string): { revision: string; text: string } | null {
    const held = persisted.get(recordKey(kind, id));
    return held ? { revision: held.revision, text: held.text } : null;
}

/**
 * Takes ownership only after recovery installed the local value (or found it satisfied). The first
 * journal flush replaces/removes captured layers atomically; an intervening reload keeps the row.
 * An unresolved update retains the exact resend ahead of any newer local value.
 */
export function adoptRecoveredRecord(
    entry: Extract<MutationEntry, { scope: "record" }>,
    unresolvedSent?: RecordLayerValues["sent"],
) {
    if (started || halted || entry.epoch !== getResourceEpoch()) {
        throw new Error("Record recovery requires the current boot before saving starts");
    }
    const written = structuredClone(entry.layers);
    if (unresolvedSent) {
        const held = persisted.get(entry.target);
        if (
            unresolvedSent.op !== "update" ||
            unresolvedSent.text === null ||
            !held ||
            unresolvedSent.baseRevision !== held.revision
        ) {
            throw new Error("Only an unresolved update on the held base can be recovered as in doubt");
        }
        inDoubt.set(entry.target, { baseRevision: held.revision, text: unresolvedSent.text, parts: null });
    }
    journalRecords.set(entry.target, { epoch: entry.epoch, desired: {}, written });
    // Do not start a timer before the service worker can request another reload. Startup's marks
    // schedule this reconciliation together with the normal save cycle.
    journalPending.add(entry.target);
}

/**
 * Hands installed or settled boot intent from src/ts/storage/journalRecovery.ts to the journal queue
 * before saving starts, copying the stored epoch/layers/versions. The first flush replaces or
 * removes them atomically; an empty settled projection clears its layers. Until then another
 * service-worker reload can recover the durable row again.
 */
export function adoptRecoveredChat(
    entry: Extract<MutationEntry, { scope: "chat" | "order" }>,
    layers: StoredLayers<"chat"> | StoredLayers<"order">,
) {
    if (started || halted || entry.epoch !== getResourceEpoch()) {
        throw new Error("Chat recovery requires the current boot before saving starts");
    }
    const key = { scope: entry.scope, target: entry.target };
    const scoped = `${key.scope}\u0000${key.target}`;
    journalChatViews.set(scoped, { key, epoch: entry.epoch, written: structuredClone(layers) });
    journalChatPending.add(scoped);
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
    noteWait(`record:${key}`, generation);
    // Cached projections and whole-record replacements need a notification too.
    if (quarantinedRecords.has(key)) {
        notifyRefusals();
    }
    permanentError = null;
    schedule();
    queueJournalRecord(key);
}

function markMembership() {
    generation += 1;
    membershipGeneration = generation;
    const present = new Set(characterData().map((character) => character.chaId as string));
    const journalKeys = new Set<string>();
    for (const id of present) {
        const key = characterKey(id);
        if (!persisted.has(key)) {
            noteWait(`record:${key}`, generation);
            journalKeys.add(key);
        }
    }
    for (const key of persisted.keys()) {
        if (key.startsWith(characterPrefix) && !present.has(key.slice(characterPrefix.length))) {
            noteWait(`record:${key}`, generation);
            journalKeys.add(key);
        }
    }
    if (quarantinedRecords.size > 0) {
        notifyRefusals();
    }
    permanentError = null;
    schedule();
    for (const key of inDoubt.keys()) {
        if (key.startsWith(characterPrefix)) {
            journalKeys.add(key);
        }
    }
    for (const [key, view] of journalRecords) {
        if (
            key.startsWith(characterPrefix) &&
            (view.dispatched || RECORD_JOURNAL_LAYERS.some((name) => view.desired[name] || view.written[name]))
        ) {
            journalKeys.add(key);
        }
    }
    for (const key of journalKeys) {
        queueJournalRecord(key);
    }
}

function settle(key: string, marked: number) {
    if ((acked.get(key) ?? 0) < marked) {
        acked.set(key, marked);
    }
}

/** The public chat obligations contain writes only; reload and idle refresh marks are separate. */
function pendingChatWrites(): string[] {
    const deferred = new Set(deferredReloads().map((ref) => `${ref.chaId}\u0000${ref.chatId}`));
    const refused = new Set(
        refusedChatItems().map((item) => (item.kind === "chat" ? `${item.chaId}\u0000${item.chatId}` : item.chaId)),
    );
    return unsettledChatObligations(captureChatObligations()).filter((key) => {
        const id = key.split("\u0000")[0];
        return (
            canSaveCharacter(id) &&
            !refused.has(key) &&
            !deferred.has(key) &&
            !isChatDeferred(key) &&
            (key.includes("\u0000") || (!hydrate.has(id) && !listRefresh.has(id)))
        );
    });
}

type WaitReason = "inFlight" | "backoff" | "refresh" | "generating" | "conflict";
type WaitMark = { seq: number; at: number; reason?: WaitReason };
const saveWaits = new Map<string, WaitMark[]>();
const collectedWaits = new Map<string, number>();

function noteWait(key: string, seq: number) {
    const marks = saveWaits.get(key) ?? [];
    const last = marks.at(-1);
    if (last && seq <= last.seq) {
        return;
    }
    if (last && last.seq > (collectedWaits.get(key) ?? -1)) {
        last.seq = seq;
    } else {
        marks.push({ seq, at: Date.now() });
    }
    saveWaits.set(key, marks);
}

function noteChatWaits() {
    const work = captureChatObligations();
    for (const [key, seq] of work.chats) {
        noteWait(`chat:${key}`, seq);
    }
    for (const [key, seq] of work.orders) {
        noteWait(`order:${key}`, seq);
    }
}

/** Record blockers when they occur; by dispatch time the reason may already have disappeared. */
function noteWaitBlockers(reason?: WaitReason) {
    for (const [key, marks] of saveWaits) {
        const own = key.slice(key.indexOf(":") + 1);
        const blocked =
            reason ??
            (key.startsWith("order:") && (hydrate.has(own) || listRefresh.has(own))
                ? "refresh"
                : ((key.startsWith("chat:") || key.startsWith("order:")) && isChatDeferred(own)) ||
                    (key.startsWith("record:") && isRecordJobBlocked(own))
                  ? "generating"
                  : recoveringConflict
                    ? "conflict"
                    : inFlight
                      ? "inFlight"
                      : Date.now() < backoffUntil
                        ? "backoff"
                        : undefined);
        if (blocked) {
            for (const mark of marks) {
                mark.reason = blocked;
            }
        }
    }
}

function recordWaitSequence(op: PendingOp, captured: ReadonlyMap<string, number>, membership: number): number {
    const marked = captured.get(op.key) ?? 0;
    // A membership change can follow a field edit of the same character before either is collected.
    return op.kind === RESOURCE_KIND.characters ? Math.max(marked, membership) : marked;
}

function captureWaits(
    ops: readonly PendingOp[],
    work: ChatWork,
    captured: ReadonlyMap<string, number>,
    membership: number,
) {
    for (const op of ops) {
        collectedWaits.set(`record:${op.key}`, recordWaitSequence(op, captured, membership));
    }
    for (const group of work.groups) {
        collectedWaits.set(`chat:${group.key}`, group.seq);
    }
    for (const order of work.orders) {
        collectedWaits.set(`order:${order.characterId}`, order.seq);
    }
}

function emitSaveWait(entries: { key: string; seq: number; category: "records" | "chats" | "orders" }[]) {
    const now = Date.now();
    const counts = { records: 0, chats: 0, orders: 0 };
    let oldest: WaitMark | undefined;
    for (const entry of entries) {
        const mark = saveWaits
            .get(entry.key)
            ?.find((mark) => mark.seq <= entry.seq && mark.reason && now - mark.at > 2000);
        if (!mark) {
            continue;
        }
        counts[entry.category] += 1;
        if (!oldest || mark.at < oldest.at) {
            oldest = mark;
        }
    }
    if (oldest) {
        recordClientEvent({
            kind: "sync",
            phase: "saveWait",
            reason: oldest.reason,
            ...counts,
            durationMs: now - oldest.at,
        });
    }
}

/**
 * Record a content-free `sync` / `saveWait` diagnostic for batch work waiting over 2 s;
 * retain its blocker even when that blocker cleared before dispatch.
 */
function recordSaveWait(batch: Batch, captured: ReadonlyMap<string, number>, membership: number) {
    emitSaveWait([
        ...batch.ops.map((op) => ({
            key: `record:${op.key}`,
            seq: recordWaitSequence(op, captured, membership),
            category: "records" as const,
        })),
        ...batch.work.groups.map((group) => ({ key: `chat:${group.key}`, seq: group.seq, category: "chats" as const })),
        ...batch.work.orders.map((order) => ({
            key: `order:${order.characterId}`,
            seq: order.seq,
            category: "orders" as const,
        })),
    ]);
}

function recordSecretWait(id: number) {
    collectedWaits.set(`secret:${id}`, id);
    emitSaveWait([{ key: `secret:${id}`, seq: id, category: "records" }]);
}

function pruneWaits() {
    for (const [key, marks] of saveWaits) {
        const own = key.slice(key.indexOf(":") + 1);
        const left = marks.filter((mark) => {
            if (key.startsWith("secret:")) {
                return llmSecretState.queue.some((op) => op.id === Number(own));
            }
            if (key.startsWith("record:")) {
                return (
                    mark.seq >
                    Math.max(
                        acked.get(own) ?? 0,
                        own.startsWith(characterPrefix) && !dirty.has(own) ? membershipAcked : 0,
                    )
                );
            }
            return (
                unsettledChatObligations({
                    chats: new Map(key.startsWith("chat:") ? [[own, mark.seq]] : []),
                    orders: new Map(key.startsWith("order:") ? [[own, mark.seq]] : []),
                }).length > 0
            );
        });
        if (left.length) {
            saveWaits.set(key, left);
        } else {
            saveWaits.delete(key);
            collectedWaits.delete(key);
        }
    }
}

/** Whether a cycle has writes to collect, including unchanged marks it must settle. */
function hasPendingWork(): boolean {
    return (
        hasPendingMembership(true) ||
        pendingChatWrites().length > 0 ||
        llmSecretState.queue.some((op) => !awaitsOwnerDeletion(op)) ||
        [...dirty.keys()].some((key) => !recordQuarantine(key) && !isRecordJobBlocked(key))
    );
}

function hasRefreshWork(): boolean {
    return (
        [...hydrate].some((id) => !isCharacterStreamedHere(id)) ||
        listRefresh.size > 0 ||
        [...parkedListRefresh].some((id) => findMirrorCharacter(id)) ||
        hasRemoteWork() ||
        deferredReloads().length > 0 ||
        idleChatRefreshes().length > 0 ||
        idleSummaryRefreshes().length > 0
    );
}

/**
 * Bound adapter reads, including conflict dependencies and every `readRefs` continuation round, to
 * `READ_DEADLINE_MS` (20 s), or abort on halt. No partial answer can reach an installer. Replacing an
 * owner does not cancel its read; adoption fences reject it and the deadline still bounds it.
 * `watchForRestore` uses its own shorter bound; external callers use `readDeadline.ts`.
 */
async function deadlineRead<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    assertSaveAdmission();
    const controller = new AbortController();
    readControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(new Error("Resource refresh timed out")), READ_DEADLINE_MS);
    let aborted!: () => void;
    const cancellation = new Promise<never>((_, reject) => {
        aborted = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", aborted, { once: true });
    });
    try {
        return await Promise.race([read(controller.signal), cancellation]);
    } finally {
        controller.signal.removeEventListener("abort", aborted);
        clearTimeout(timeout);
        readControllers.delete(controller);
    }
}

function queueCharacterRefresh(id: string, purpose: "hydrate" | "listRefresh") {
    (purpose === "hydrate" ? hydrate : listRefresh).add(id);
    listReadGenerations.set(id, (listReadGenerations.get(id) ?? 0) + 1);
    noteWaitBlockers();
    scheduleRefresh(0);
}

function scheduleRefresh(delay = DEBOUNCE_MS) {
    if (!started || halted || !hasRefreshWork()) {
        return;
    }
    const deadline = Math.max(Date.now() + delay, refreshBackoffUntil);
    if (refreshTimer && refreshDeadline <= deadline) {
        return;
    }
    if (refreshTimer) {
        clearTimeout(refreshTimer);
    }
    refreshDeadline = deadline;
    refreshTimer = setTimeout(
        () => {
            refreshTimer = null;
            void runRefresh();
        },
        Math.max(0, deadline - Date.now()),
    );
}

function failedRefresh(error: unknown) {
    if (halted) {
        return;
    }
    if (typeof error === "object" && error !== null) {
        if (reportedRefreshErrors.has(error)) {
            return;
        }
        reportedRefreshErrors.add(error);
    }
    refreshFailures += 1;
    refreshBackoffUntil = Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(refreshFailures, 5));
    console.error("[Refresh]", error);
    scheduleRefresh(0);
}

/**
 * Refreshes have their own flight, timer and backoff (2 s doubling to 30 s), independent of writes.
 * Each stage starts independently: a failed or stalled read cannot starve another kind of refresh
 * or change write backoff. A completed stage wakes pending writes even while other reads remain.
 * `flushResources` joins only the reads its captured writes depend on.
 */
function runRefresh(): Promise<void> {
    if (refreshInFlight) {
        return refreshInFlight;
    }
    if (halted || !hasRefreshWork()) {
        return Promise.resolve();
    }
    if (Date.now() < refreshBackoffUntil) {
        scheduleRefresh(0);
        return Promise.resolve();
    }
    if (refreshTimer) {
        clearTimeout(refreshTimer);
    }
    refreshTimer = null;
    refreshInFlight = (async () => {
        const failuresBefore = refreshFailures;
        const results = await Promise.allSettled(
            [
                reloadDeferredChats(),
                hydrateCharacters(),
                applyRemoteUpdates(),
                refreshIdleSummaries(),
                readIdleChats(
                    idleChatRefreshes()
                        .filter(
                            (ref) =>
                                !remoteCollections.has(ref.chaId) &&
                                !hydrate.has(ref.chaId) &&
                                !listRefresh.has(ref.chaId),
                        )
                        .slice(0, MAX_REMOTE_READS),
                ),
            ].map(async (stage) => {
                const discardedWork = await stage;
                if (discardedWork && !halted) {
                    showReloadedNotice();
                }
                // A refresh may finish during the debounce of a local edit made while it was reading.
                if (!halted && hasPendingWork()) {
                    schedule(0);
                }
            }),
        );
        if (halted) {
            return;
        }
        const failed = results.filter((result) => result.status === "rejected");
        if (failed.length > 0) {
            for (const result of failed) {
                failedRefresh(result.reason);
            }
        } else if (refreshFailures === failuresBefore) {
            refreshFailures = 0;
            refreshBackoffUntil = 0;
        }
    })().finally(() => {
        refreshInFlight = null;
        if (!stopped) {
            scheduleTrim();
            scheduleRefresh();
        }
    });
    return refreshInFlight;
}

/** Dispatch and settlement both invalidate destructive list snapshots, even on an unanswered write. */
function fenceCharacterWrites(ops: readonly PendingOp[], work: ChatWork, entering: boolean) {
    const ids = new Set([
        ...ops.filter((op) => op.kind === RESOURCE_KIND.characters).map((op) => op.id),
        ...work.groups.map((group) => group.characterId),
        ...work.orders.map((order) => order.characterId),
    ]);
    for (const id of ids) {
        characterWriteSerials.set(id, (characterWriteSerials.get(id) ?? 0) + 1);
        const count = (writingCharacters.get(id) ?? 0) + (entering ? 1 : -1);
        if (count > 0) {
            writingCharacters.set(id, count);
        } else {
            writingCharacters.delete(id);
        }
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
    scheduleRefresh(delay);
    noteWaitBlockers();
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

function recordQuarantine(key: string, projected?: string | null): ResourceRequestError | null {
    const refused = quarantinedRecords.get(key);
    if (!refused) {
        return null;
    }
    const separator = key.indexOf("\u0000");
    const kind = key.slice(0, separator);
    const id = key.slice(separator + 1);
    const text = projected === undefined ? (projectRecord(kind, id) ?? null) : projected;
    if (text === refused.text) {
        if (text !== null) {
            // The refused text stays held: the cache keeps that string, not an equal copy.
            shareSavedText(kind, id, text, refused.text!);
        }
        return refused.error;
    }
    clearRecordRefusal(key);
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
        hasUnsavedChatWork(canSaveCharacter) ||
        refusedRecords().length > 0 ||
        hasRefusedChatWork()
    );
}

/**
 * Hold the exact refused text; quarantine suppresses automatic retries of unchanged content.
 * Indexed `ops[i]` errors and the pre-dispatch 413 check alert once per key/session. An isolated
 * unindexed refusal alerts on every rejected attempt, including explicit Retry with unchanged text.
 * Other records and unrelated chat work keep saving.
 */
function quarantineRecord(op: PendingOp, error: ResourceRequestError, indexed = true) {
    quarantinedRecords.set(op.key, { text: op.text, error });
    const view = journalView(op.key);
    if (view) {
        view.desired.refused = {
            op: journalOperation(op.text, op.baseRevision).op,
            text: op.text,
            reason: error.message,
        };
        journalSettled(op.key);
    }
    notifyRefusals();
    // Indexed errors alert once per key per session. An isolated unindexed refusal alerts on every
    // rejected attempt. Quarantine suppresses automatic retries; explicit Retry releases it even
    // when the text is unchanged.
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

export type RefusedItem =
    { kind: "record"; key: string; reason: string; resourceKind: string; id: string } | RefusedChatItem;

/** Reads projections without pruning quarantine: safe inside a reactive derived expression. */
function refusedRecords(): Extract<RefusedItem, { kind: "record" }>[] {
    void refusalVersion;
    const items: Extract<RefusedItem, { kind: "record" }>[] = [];
    for (const [key, refused] of quarantinedRecords) {
        const [resourceKind, id] = key.split("\u0000");
        const text = projectRecord(resourceKind, id) ?? null;
        if (text === refused.text && text !== (persisted.get(key)?.text ?? null)) {
            items.push({ kind: "record", key, reason: refused.error.message, resourceKind, id });
        }
    }
    return items;
}

/** Reactive inventory of refused local data. Pass an item's opaque key to Retry or Discard. */
export function refusedItems(): RefusedItem[] {
    return [...refusedRecords(), ...refusedChatItems()];
}

/**
 * Release one current refusal for one new save attempt, preserving its session alert guard.
 * Halted adapters reject Retry just as they reject new writes.
 */
export function retryRefused(key: string) {
    assertSaveAdmission();
    if (refusedRecords().some((item) => item.key === key)) {
        clearRecordRefusal(key);
        markKey(key);
    } else if (retryRefusedChat(key)) {
        schedule();
    }
}

/**
 * Discard by reading the server copy, only while refusal identity, projection, edit generation and
 * character membership/owner fences still match after the read. An edit, Retry or recreation wins
 * over the older Discard. Halted adapters reject admission; chat discards also fence character writes.
 */
export async function discardRefused(key: string): Promise<void> {
    assertSaveAdmission();
    const item = refusedRecords().find((item) => item.key === key);
    if (!item) {
        const chat = refusedChatItems().find((item) => item.key === key);
        const serial = chat ? (characterWriteSerials.get(chat.chaId) ?? 0) : 0;
        if (
            await discardRefusedChat(
                key,
                () =>
                    !halted &&
                    (!chat ||
                        ((characterWriteSerials.get(chat.chaId) ?? 0) === serial &&
                            !writingCharacters.has(chat.chaId))),
            )
        ) {
            schedule();
        }
        return;
    }
    const refused = quarantinedRecords.get(key);
    const marked = dirty.get(key);
    const membership = membershipGeneration;
    const owner = item.resourceKind === RESOURCE_KIND.characters ? chatOwnerToken(item.id) : null;
    const read = await deadlineRead((signal) => readRefs([{ kind: item.resourceKind, id: item.id }], { signal }));
    if (
        halted ||
        quarantinedRecords.get(key) !== refused ||
        dirty.get(key) !== marked ||
        (owner !== null && (membershipGeneration !== membership || chatOwnerToken(item.id) !== owner)) ||
        (projectRecord(item.resourceKind, item.id) ?? null) !== refused?.text
    ) {
        return;
    }
    const server = read.items.find((record) => record.kind === item.resourceKind && record.id === item.id);
    if (!server) {
        return;
    }
    if (server.kind === RESOURCE_KIND.characters && server.revision !== null && !findMirrorCharacter(server.id)) {
        queueCharacterRefresh(server.id, "hydrate");
    }
    acceptRemote(server, true);
    schedule();
    if (hydrate.has(item.id)) {
        await refreshCharacter(item.id);
    }
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
 * Creates and records without parts go whole; `llmSecrets` never has patch parts. A changed own
 * `__proto__` forces the object record, or the affected item, whole. Hooks detected by `hasJsonHook`
 * at a serialization boundary also disable parts; `Date.prototype.toJSON` is excluded.
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
 * Diff membership by `chaId` against `persisted`: a held id removed/re-added before collection updates,
 * never two ops for one id. A quarantined or oversized character create stays out of `creating`,
 * holding its chats and membership obligation without keeping an idle save cycle scheduled.
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
        queueJournalRecord(op.key);
    }
    for (const collection of COLLECTIONS) {
        const key = collectionKey(collection);
        if (!captured.has(key)) {
            continue;
        }
        const projection = journalProjection(key, collection, SINGLETON_RESOURCE_ID);
        queueJournalRecord(key);
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
        if (
            inDoubt.has(key) &&
            resendInDoubt(
                key,
                RESOURCE_KIND.characters,
                id,
                journalProjection(key, RESOURCE_KIND.characters, id, character)?.text,
            )
        ) {
            continue;
        }
        const current = persisted.get(key);
        if (current && !captured.has(key)) {
            continue;
        }
        let projection = journalProjection(key, RESOURCE_KIND.characters, id, character)!;
        queueJournalRecord(key);
        let saved = projection.text === current?.text;
        if (!saved) {
            projection = canonicalCharacter(id, projection);
            rememberJournalProjection(key, projection, true, character);
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
            if (!present.has(id)) {
                queueJournalRecord(key);
            }
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
        chatWork: takeChatWork(creating, {
            maxOps: MAX_BATCH_OPERATIONS,
            holdOrders: new Set([...listRefresh, ...hydrate]),
        }),
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
 * server counts them. Later cycles can split too; one chat group remains indivisible.
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

/**
 * One write cycle at a time, after the normal 500 ms debounce; `schedule` keeps an earlier wakeup.
 * Network failures, 5xx and 429 retry with backoff capped at 30 s. Refresh failures never change
 * that backoff. Acknowledgements hold sent text, while marks made in flight remain dirty.
 */
function runCycle(): Promise<boolean> {
    if (halted) {
        return Promise.resolve(false);
    }
    if (inFlight) {
        return inFlight;
    }
    cycleWrote = false;
    inFlight = (async () => {
        try {
            await cycle();
            failures = 0;
            lastError = null;
            permanentError = null;
        } catch (error) {
            if (!stopped) {
                lastError = error;
                handleCycleError(error);
            }
        } finally {
            inFlight = null;
            if (!stopped) {
                sendingKeys.clear();
                // Early returns also release conservative marks of batches that never dispatched.
                for (const [key, view] of journalRecords) {
                    if (view.dispatched) {
                        journalSettled(key);
                    }
                }
                // Chat transitions already invalidated their real layers, including early exits.
                scheduleJournal();
                pruneWaits();
                scheduleRefresh(0);
                // A record whose hydration waited for the batch: its ordering check runs again now.
                for (const record of [...deferredHydrations.values()]) {
                    deferredHydrations.delete(recordKey(record.kind, record.id));
                    applyHydration(record);
                }
                saving.state = false;
                // Chats whose protection ended in this cycle (saved, refreshed, released) may be evicted now.
                scheduleTrim();
                backoffUntil = lastError ? Date.now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 5)) : 0;
                if (lastError) {
                    noteWaitBlockers("backoff");
                }
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
        }
        return cycleWrote;
    })();
    return inFlight;
}

/**
 * Collect writes without awaiting unrelated refresh reads, applying only ready feed patches first.
 * A refused batch's conflict read and a credential revision reread are write dependencies and may
 * still be awaited. Unindexed 400/413 on several units enables one request per unit; a single
 * unit is quarantined, so unrelated work can proceed. Every request is its own server transaction.
 * Capture credential op ids at collection: send them after resource batches, so a newly queued
 * owner's credential waits for the next cycle. Batch success holds sent record text as the baseline.
 */
async function cycle() {
    // Nothing is saved before the boot installed the records.
    if (halted || trackedCharacters() === undefined) {
        return;
    }
    applyRemotePatches();
    scheduleRefresh(0);
    const { ops, captured, heldBack, membership, chatWork } = collectOperations();
    // The credential writes queued so far go after this batch; one queued while it is in flight
    // (say, the key of a preset created meanwhile) waits for the next cycle, after its resource.
    const capturedSecretOps = new Set(llmSecretState.queue.map((op) => op.id));
    captureWaits(ops, chatWork, captured, membership);
    const { batches, oversized } = planBatches(ops, chatWork);
    for (const group of oversized) {
        const reason = `The chat ${group.chatId} is too large to save`;
        quarantineChat(group, reason, reason);
    }
    // Later batches are conservatively marked sent too: recovery treats an unanswered create
    // as dispatched even if an earlier batch prevented its request from going out.
    journalDispatched(ops);
    const journalFlush = flushJournal();
    if (
        !journalOff &&
        (ops.some((op) => op.text !== null && op.baseRevision === null && journalRecords.has(op.key)) ||
            batches.some((batch) => batch.work.groups.some((group) => group.ops[0]?.op === "create")))
    ) {
        await waitForCreateJournal(journalFlush);
    }
    if (stopped) return;
    if (batches.length > 0) {
        saving.state = true;
        cycleWrote = true;
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
                void flushJournal();
            }
            let result: ResourceBatchResult;
            for (const op of batch.ops) {
                sendingKeys.add(op.key);
            }
            // A remote replacement may have settled a conservative mark while an earlier batch
            // waited; this request still carries its collected op.
            journalDispatched(batch.ops);
            try {
                fenceCharacterWrites(batch.ops, batch.work, true);
                recordSaveWait(batch, captured, membership);
                try {
                    result = await applyBatchText(batchBody(batch));
                } catch (error) {
                    if (halted) {
                        return;
                    }
                    // Nothing of this request or the later ones was saved.
                    requeueChatWork(later);
                    // A known refusal returns records to collected intent before any conflict read.
                    if (
                        error instanceof ResourceConflictError ||
                        (error instanceof ResourceRequestError && error.status > 0 && error.status < 500)
                    ) {
                        batch.ops.forEach((op) => journalSettled(op.key));
                    }
                    if (error instanceof ResourceConflictError) {
                        await recoverFromConflict(error, batch.ops, batch.work);
                        return;
                    }
                    if (quarantineRejectedChat(error, batch.work)) {
                        return;
                    }
                    if (
                        error instanceof ResourceRequestError &&
                        (error.status === 400 || error.status === 413) &&
                        batch.ops.length + batch.work.groups.length + batch.work.orders.length === 1
                    ) {
                        // Quarantine before requeueing, so retained refused ops occur exactly once.
                        if (batch.work.groups[0]) {
                            quarantineChat(batch.work.groups[0], error.message);
                            return;
                        }
                        if (batch.work.orders[0]) {
                            quarantineChatOrder(batch.work.orders[0], error.message);
                            return;
                        }
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
                        }
                        return;
                    }
                    throw error;
                }
                if (halted) {
                    return;
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
                            listRefresh.delete(op.id);
                            parkedListRefresh.delete(op.id);
                        }
                    } else {
                        persisted.set(op.key, { revision, text: op.text, parts: op.parts });
                    }
                    journalSettled(op.key);
                });
                for (const characterId of ackChatWork(batch.work, result.chats ?? [], result.chatOrders ?? [])) {
                    queueCharacterRefresh(characterId, "listRefresh");
                }
            } finally {
                fenceCharacterWrites(batch.ops, batch.work, false);
            }
        }
    }
    if (halted) {
        return;
    }
    try {
        sendingKeys.add(collectionKey(SECTION_KIND.llmSecrets));
        await sendSecretOps(capturedSecretOps);
    } finally {
        sendingKeys.delete(collectionKey(SECTION_KIND.llmSecrets));
    }
    if (halted) {
        return;
    }
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
        queueJournalRecord(key);
    }
    if (membershipAcked < membership && !collectMembershipChanges()) {
        membershipAcked = membership;
    }
    scheduleRefresh(0);
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
    const held = persisted.get(key);
    if (held && (compareRevision(revision, held.revision) ?? 0) < 0) {
        return;
    }
    if (!adoptSecretSiblings(revision, masked, invalidate)) {
        // Through `applySettingsRecord`, which invalidates every credential path.
        acceptRemote({ kind: SECTION_KIND.llmSecrets, id: SINGLETON_RESOURCE_ID, revision, data: masked });
        showReloadedNotice();
    }
}

/**
 * The readable siblings are one unit for credential replies, live updates, and save conflicts:
 * unchanged local siblings take remote; unchanged remote siblings keep local. Two changed bodies
 * conflict without touching the mirror. Credential status is always the actual masked server copy.
 */
function adoptSecretSiblings(revision: string, masked: MaskedLlmSecrets, invalidate: SecretPath[] | "all"): boolean {
    const key = collectionKey(SECTION_KIND.llmSecrets);
    const saved = persisted.get(key)?.text;
    const remote = llmSecretsText(masked);
    const local = projectCollection(SECTION_KIND.llmSecrets);
    if (local === saved) {
        persisted.set(key, { revision, text: remote });
        applySettingsRecord(SECTION_KIND.llmSecrets, masked, invalidate);
        return true;
    }
    if (remote === saved) {
        persisted.set(key, { revision, text: remote });
        setMaskedSecrets(masked, invalidate);
        return true;
    }
    return false;
}

async function rereadSecrets() {
    const item = await deadlineRead((signal) =>
        getResource<MaskedLlmSecrets>(SECTION_KIND.llmSecrets, SINGLETON_RESOURCE_ID, { signal }),
    );
    if (halted) {
        return;
    }
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
 * `SECRET_CONFLICT_RETRIES` permits two reread/retries per op/cycle. Refusals report `llmSecrets/<path>`
 * without exposing values. Cleanup sends only after the owner leaves both mirror and saved copy;
 * a restored live owner drops it, an unsaved deletion holds it without scheduling another cycle.
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
            cycleWrote = true;
            recordSecretWait(op.id);
            try {
                const reply = await sendSecretRequest(
                    {
                        kind: "put",
                        path: encodeSecretPath(op.request.path),
                        value: op.request.kind === "put" ? op.request.value : "",
                    },
                    base,
                );
                if (halted) {
                    return;
                }
                removeSecretOp(op.id);
                adoptSecretRecord(reply.revision, reply.data as MaskedLlmSecrets, [secretOpTarget(op.request)]);
                break;
            } catch (error) {
                if (halted) {
                    return;
                }
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
 * of them was refused, when saving fails, or when the data was restored. Cleanups held only by an
 * unsaved owner deletion also throw: another credential cycle cannot save that owner.
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
    quarantineChat(group, error.message, `The chat ${group.chatId} could not be saved: ${error.message}`);
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
 * Registers one hook before the restore notice, replacing any previous hook; returns its
 * unregister. The upstream import stores its prepared selection here when the socket reports the
 * new epoch before the commit's answer (`src/ts/drive/upstreamBackupClient.ts`). The notice never
 * waits on the network.
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
 * `src/ts/storage/resourceClient.ts` for an EpochMismatch 412 or a changed epoch on any resource
 * request (inlays and permissions included). The restore journal is captured synchronously before
 * anything can settle; late cycle answers and aborted refresh reads apply nothing. The snapshot's
 * 1 s wait bound starts before the synchronous hook and terminal notice (`alertTerminal` in
 * `src/ts/alert.ts`), so acknowledgement adds only any remaining journal wait. Reload follows
 * acknowledgement and the existing wait, even if the journal fails or times out. Acknowledgement
 * has no timeout; an off or empty journal adds no wait.
 */
async function haltForRestore() {
    if (halted) {
        return;
    }
    let snapshot: RestoreJournalItem[] = [];
    try {
        snapshot = captureRestoreJournal();
    } catch (error) {
        console.warn("[Save journal]", error);
        recordClientEvent({ kind: "sync", phase: "journalFailed", reason: "write" });
    }
    const drafts = [...conflictDrafts.values()];
    halted = true;
    if (journalTimer) {
        clearTimeout(journalTimer);
        journalTimer = null;
    }
    journalPending.clear();
    journalChatPending.clear();
    chatJournal.setListener(null);
    chatJournal.setConflictListener(null);
    if (refreshTimer) {
        clearTimeout(refreshTimer);
    }
    refreshTimer = null;
    for (const controller of readControllers) {
        controller.abort(new Error("Saving stopped: the server data was restored"));
    }
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    const journalSnapshot =
        !journalOff && (snapshot.length > 0 || drafts.length > 0) ? waitForRestoreJournal(snapshot, drafts) : null;
    try {
        restoreReloadHook?.();
    } catch (error) {
        console.error("[Save] Before restore reload:", error);
    }
    restoreReloadHook = null;
    // The terminal notice opens synchronously after the hook; no other alert replaces or clears it.
    // Any snapshot's bound starts above; an off or empty journal adds no wait after acknowledgement.
    await alertTerminal(language.resourceRestored);
    if (journalSnapshot) await journalSnapshot;
    if (stopped) return;
    recordClientEvent({ kind: "sync", phase: "reload", reason: "restore" });
    flushClientDiagnostics();
    location.reload();
}

/** How long `watchForRestore` reads, how often, and how long one read may take. */
const RESTORE_WATCH_MS = 120_000;
const RESTORE_POLL_MS = 1_000;
const RESTORE_READ_MS = 5_000;
let restoreWatch: Promise<boolean> | null = null;
let cancelRestorePoll: (() => void) | null = null;

/**
 * A server job of this tab ended because a restore or import is replacing the data (its
 * `maintenance` terminal, which comes before the replacement): waits 1 s before each small-record
 * read until the server answers with another epoch, which `src/ts/storage/resourceClient.ts`'s
 * `getResource` epoch check turns into `haltForRestore` (the restore notice and a reload). An
 * answer with the old epoch, the maintenance 503, and a network failure keep it waiting. A read
 * that takes over 5 s is aborted and the watch reads again; a maintenance that replaced nothing
 * ends the watch after two minutes, however its reads hang. Writes need no pause meanwhile: each
 * names the epoch it was based on, so one after the replacement is refused (412) and halts too. One
 * watch at a time; resolves true when the data was replaced (or saving had already halted).
 */
export function watchForRestore(): Promise<boolean> {
    if (halted) {
        return Promise.resolve(true);
    }
    restoreWatch ??= (async () => {
        try {
            const until = Date.now() + RESTORE_WATCH_MS;
            while (Date.now() < until && !halted) {
                await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, RESTORE_POLL_MS);
                    cancelRestorePoll = () => {
                        clearTimeout(timer);
                        resolve();
                    };
                });
                cancelRestorePoll = null;
                if (halted) return true;
                const controller = new AbortController();
                readControllers.add(controller);
                const read = getResource(SECTION_KIND.ui, "main", { signal: controller.signal }).then(
                    () => false,
                    (error) => error instanceof ResourceEpochMismatchError,
                );
                const budget = Math.max(0, Math.min(RESTORE_READ_MS, until - Date.now()));
                let timer: ReturnType<typeof setTimeout> | undefined;
                const timedOut = new Promise<false>((resolve) => {
                    controller.signal.addEventListener("abort", () => resolve(false), { once: true });
                    timer = setTimeout(() => {
                        controller.abort();
                        resolve(false);
                    }, budget);
                });
                const replaced = await Promise.race([read, timedOut]);
                clearTimeout(timer);
                readControllers.delete(controller);
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
function acceptRemote(item: RemoteItem, removeAbsentSingleton = false) {
    const key = recordKey(item.kind, item.id);
    // What the plugins lose, taken before the mirror changes and told after the record is settled.
    const lost =
        item.kind === RESOURCE_KIND.pluginStorage && pluginStorageDiscardListeners.size > 0
            ? pluginStorageLosses(key, item)
            : null;
    clearRecordRefusal(key);
    inDoubt.delete(key);
    applyToMirror(item.kind, item.id, item.revision === null ? null : item.data);
    if (removeAbsentSingleton && item.revision === null && COLLECTIONS.includes(item.kind as Collection)) {
        // An explicitly discarded absent singleton (notably pluginStorage) must leave no local copy.
        applyRaw(item.kind as RecordKind, undefined);
    }
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
    journalDiscarded(key);
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

/**
 * Shows the reload notice; one already on screen is kept (it latches until dismissed). Only a notice
 * this call put on screen is a `notice` event.
 */
function showReloadedNotice() {
    const shown = get(reloadNotice) === null;
    alertReloadNotice(language.resourceReloaded);
    if (shown) {
        recordClientEvent({ kind: "notice", notice: "resourceReloaded" });
    }
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

const isStamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
/** The `statics` counts (`incrementStatic`). */
const STATIC_COUNTS = new Set(["imports", "messages"]);
/**
 * Best-effort statics counts add this client's increments to the server's count. Other fields keep
 * the existing equal/absent-field rule; a substantive remote change of one still conflicts.
 */
function benignChanges(
    saved: Record<string, unknown>,
    remote: Record<string, unknown>,
    local: Record<string, unknown>,
): Map<string, unknown> | null {
    const changes = new Map<string, unknown>();
    for (const field of new Set([...Object.keys(saved), ...Object.keys(remote), ...Object.keys(local)])) {
        const [base, theirs, ours] = [fieldOf(saved, field), fieldOf(remote, field), fieldOf(local, field)];
        if (STATIC_COUNTS.has(field)) {
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
 * Merges independent fields or items against the saved base and the current local projection. All
 * units must resolve before the mirror changes; otherwise normal conflict recovery keeps eligible
 * local intent as a draft and accepts the server record. Successful merges rebase through
 * `adoptMergedBase`, with no discard or reload notice. Character creates/deletes and taken fields
 * the mirror only inherits remain conflicts; item collections also support concurrent creation.
 */
function mergeConcurrentChange(item: RemoteItem, key: string): boolean {
    if (item.kind === RESOURCE_KIND.pluginStorage) {
        return mergePluginStorageChange(item, key);
    }
    if (isItemMergeKind(item.kind)) {
        return mergeItemListChange(item, key);
    }
    if (isSection(item.kind)) {
        return mergeSectionChange(item, key);
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
    if (!remote || !saved || !local) {
        return false;
    }
    const merged = isCharacter ? mergeCharacterFields(saved, remote, local) : null;
    const changes = isCharacter
        ? merged &&
          new Map(
              [...new Set([...Object.keys(local), ...Object.keys(merged)])]
                  .filter((field) => !isEqual(fieldOf(local, field), fieldOf(merged, field)))
                  .map((field) => [field, fieldOf(merged, field)]),
          )
        : benignChanges(saved, remote, local);
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
    adoptMergedBase(item, item.revision, key, prepared.length > 0);
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
    journalSettled(key);
    rememberJournalProjection(
        key,
        merged,
        false,
        item.kind === RESOURCE_KIND.characters ? findMirrorCharacter(item.id) : undefined,
    );
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
 * Sections merge by field and coupled tuple; llmSecrets keeps its entire readable sibling body as
 * one unit. Masked credential status always comes from the server, never from the merged projection.
 * No section merges without a saved base, and every value is detached before raw application.
 */
function mergeSectionChange(item: RemoteItem, key: string): boolean {
    const base = persisted.get(key);
    const projected = projectRecord(item.kind, item.id);
    if (!base || item.revision === null || projected === undefined || !isSection(item.kind)) {
        return false;
    }
    if (item.kind === SECTION_KIND.llmSecrets) {
        if (!adoptSecretSiblings(item.revision, item.data as MaskedLlmSecrets, "all")) {
            return false;
        }
        adoptMergedBase(item, item.revision, key, projected !== projectCollection(item.kind));
        return true;
    }
    let merged: Record<string, unknown> | null;
    const local = JSON.parse(projected);
    try {
        merged = mergeSectionFields(item.kind, JSON.parse(base.text), item.data, local);
        if (merged) merged = structuredClone(merged);
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

/**
 * Independent items merge whole by id, with explicit ordering, nonempty, and selection rules.
 * The detached result goes into the mirror raw and the next cycle saves it on the server revision.
 * Lists both tabs created merge against an empty base; any unresolved item leaves the mirror alone.
 */
function mergeItemListChange(item: RemoteItem, key: string): boolean {
    const projected = projectRecord(item.kind, item.id);
    if (item.revision === null || projected === undefined || !isItemMergeKind(item.kind)) {
        return false;
    }
    const base = persisted.get(key);
    let local: unknown;
    let merged: Record<string, unknown>[] | Record<string, unknown> | null;
    try {
        local = JSON.parse(projected);
        merged = mergeItemCollection(item.kind, base ? JSON.parse(base.text) : ABSENT, item.data, local);
        if (merged) merged = structuredClone(merged);
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

/** Compares adapter-produced compact JSON, key order aside; only equal-length texts are parsed. */
export function sameJson(a: string, b: string): boolean {
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
        journalSettled(op.key);
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
    journalSettled(key);
    return true;
}

/**
 * Reconstruct only the exact conflicting revision: a feed patch at the held base, one write ahead
 * in the loaded epoch/incarnation, or an exact-revision `deferredHydrations` entry. Both use the
 * same merge/acceptance path as a read-back; anything else requires `readRefs`.
 */
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
 * or reads it back. An exact JSON match of sent text recognizes a lost reply; otherwise independent
 * changes merge before accepting the server copy and drafting discarded local intent. The rest of
 * the batch goes out next cycle. This read is a write dependency under `deadlineRead`; `hydrate` lists
 * queued by recovery run in the background refresh queue instead.
 * The reload notice is shown once per recovery, when it discarded anything, also when a read after
 * the first discard throws.
 */
async function recoverFromConflict(error: ResourceConflictError, batch: readonly PendingOp[], work: ChatWork) {
    const notice = { owed: false };
    recoveringConflict = true;
    noteWaitBlockers("conflict");
    try {
        await recoverConflictedWork(error, batch, work, notice);
    } finally {
        recoveringConflict = false;
        if (notice.owed && !halted) {
            showReloadedNotice();
        }
    }
}

/**
 * Drop generating refusals' named locked-message edits through `chatStore.svelte.ts` before any
 * unrelated conflict read can fail; retained work alone waits `JOB_RETRY_MS`. Character deletes
 * receive the same retry block. Server `messageIds` decide the split even for an observing tab.
 * Set `notice.owed` as soon as a discard occurs, so a later read failure still shows the reload notice.
 */
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
    // Drop refused locked edits and retain conflicting order snapshots before any read can fail.
    const expiredRecovered = new Set(
        work.groups
            .filter((group) => group.recoveredAt !== undefined && expiredChats.has(group.key))
            .map((group) => group.key),
    );
    const immediateRecovery = recoverChatConflicts(
        {
            groups: work.groups.filter((group) => generatingChats.has(group.key) || expiredRecovered.has(group.key)),
            orders: work.orders.filter((order) => conflictedOrders.has(order.characterId)),
        },
        new Set(),
        conflictedOrders,
        [],
        generatingChats,
        lockedMessages,
        expiredChats,
    );
    if (generating || immediateRecovery.blocked) {
        showGeneratingNotice();
    }
    if (immediateRecovery.reloaded) {
        notice.owed = true;
    }
    for (const characterId of immediateRecovery.refresh) {
        queueCharacterRefresh(characterId, "hydrate");
    }
    noteWaitBlockers();
    const remainingWork = {
        groups: work.groups.filter((group) => !generatingChats.has(group.key) && !expiredRecovered.has(group.key)),
        orders: work.orders.filter((order) => !conflictedOrders.has(order.characterId)),
    };
    let read: Awaited<ReturnType<typeof readRefs>>;
    const readStamp = issueChatReadStamp();
    try {
        read =
            refs.length + chatRefs.length > 0
                ? await deadlineRead((signal) => readRefs(refs, { chats: chatRefs, signal }))
                : { epoch: "", items: [] };
        if (halted) {
            return;
        }
    } catch (readError) {
        if (halted) {
            return;
        }
        // Only work outside the immediate recovery still needs to be requeued.
        requeueChatWork(remainingWork);
        throw readError;
    }
    const recovered = recoverChatConflicts(
        remainingWork,
        conflictedChats,
        conflictedOrders,
        (read.chats ?? []).map((chat) => ({ ...chat, readStamp }) as RemoteChat),
        undefined,
        undefined,
        expiredChats,
    );
    if (recovered.reloaded) {
        notice.owed = true;
    }
    for (const characterId of recovered.refresh) {
        // The background queue retries the list independently of this refused batch.
        queueCharacterRefresh(characterId, "hydrate");
    }
    for (const characterId of recovered.refreshOrders) {
        queueCharacterRefresh(characterId, "listRefresh");
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
            journalSettled(key);
            if (op.kind === RESOURCE_KIND.characters && op.baseRevision === null) {
                queueCharacterRefresh(item.id, "listRefresh");
            }
            continue;
        }
        if (text !== null && adoptInDoubt(key, item.revision!, text)) {
            // An earlier lost write landed (this op, say a delete, is newer): its text is the base,
            // and this client's newer change goes next cycle.
            continue;
        }
        const abandoned = captureRecordConflict(key, op, item.revision === null);
        inDoubt.delete(key);
        if (mergeConcurrentChange(item, key)) {
            continue;
        }
        if (item.kind === RESOURCE_KIND.characters && item.revision !== null) {
            if (op?.baseRevision === null) {
                // Another writer owns this id: settle the superseded chats with the parent conflict,
                // preserving their local history as drafts before loading the server's chat list.
                forgetCharacter(item.id, { capture: true });
                queueCharacterRefresh(item.id, "hydrate");
            } else if (!findMirrorCharacter(item.id)) {
                // A character the mirror did not have: its chats come with their order.
                queueCharacterRefresh(item.id, "hydrate");
            }
        }
        if (abandoned) queueConflictDraft(abandoned);
        acceptRemote(item);
        notice.owed = true;
    }
    scheduleRefresh(0);
}

/**
 * Reads the chat lists of characters a recovery inserted or whose chats changed on the server (their
 * summaries: a chat is loaded only on demand), and puts them into the mirror. A character stays listed
 * until its response can be applied. A recovery's character (`hydrate`) takes the server's list
 * (`acceptRemoteCollection`, which discards what the list has no room for) and waits while a generation
 * of this tab runs on it, and one the read finds gone is removed with its chats unless its held revision
 * or its chats' lifetime moved during the read (then it stays listed for the next read); an
 * acknowledgement's or adopted create's (`listRefresh`) is applied as a live update that keeps a queued
 * reorder unless a kept chat with a held revision is missing from the server's list (then the reorder is
 * discarded and reported), also during a generation (busy chats keep their copy), and stays listed while
 * the list cannot be applied yet. A locally absent character's refresh is parked until it is re-added,
 * without scheduling reads. Each character has its own joinable read; a snapshot from before a write's
 * dispatch or settlement is retried without applying it.
 */
async function hydrateCharacters(): Promise<void> {
    for (const id of parkedListRefresh) {
        if (findMirrorCharacter(id)) {
            parkedListRefresh.delete(id);
            queueCharacterRefresh(id, "listRefresh");
        }
    }
    for (const id of listRefresh) {
        if (!findMirrorCharacter(id)) {
            listRefresh.delete(id);
            parkedListRefresh.add(id);
        }
    }
    const results = await Promise.allSettled([...new Set([...hydrate, ...listRefresh])].map(refreshCharacter));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
        throw failed.reason;
    }
}

/** Joins only this character's read; a flush need not wait for the rest of a refresh pass. */
function refreshCharacter(id: string): Promise<boolean> {
    const existing = characterRefreshes.get(id);
    if (existing) {
        return existing;
    }
    const purpose = hydrate.has(id) ? "hydrate" : "listRefresh";
    if (
        halted ||
        (!hydrate.has(id) && !listRefresh.has(id)) ||
        (purpose === "hydrate" && isCharacterStreamedHere(id))
    ) {
        return Promise.resolve(false);
    }
    const request = readCharacter(id, purpose)
        .then((discardedWork) => {
            if (discardedWork && !halted) {
                showReloadedNotice();
            }
            if (!halted && hasPendingWork()) {
                schedule(0);
            }
            return discardedWork;
        })
        .catch((error) => {
            failedRefresh(error);
            throw error;
        })
        .finally(() => characterRefreshes.delete(id));
    characterRefreshes.set(id, request);
    return request;
}

/**
 * Lists read beside writes may apply only while `listReadGenerations`, `characterWriteSerials`,
 * `writingCharacters` and `chatOwnerToken` still permit the issued snapshot. Dispatch and settlement
 * both fence it, even after an unanswered write. A stale answer leaves the character queued;
 * `holdOrders` prevents a reorder using the old revision without stopping its chat groups.
 */
async function readCharacter(id: string, purpose: "hydrate" | "listRefresh"): Promise<boolean> {
    const ids = [id];
    const requestGeneration = listReadGenerations.get(id);
    const writeSerial = characterWriteSerials.get(id) ?? 0;
    const issued = heldChatRevisionsByCharacter(ids);
    // Taken before the read: a recovery's character found gone is removed only if neither its held
    // revision (a job hydration, a live update) nor its chats' lifetime (a same-id recreation) moved
    // while the read was pending.
    const issuedHeld = new Map(
        ids.map((id) => [id, persisted.get(recordKey(RESOURCE_KIND.characters, id))?.revision ?? null]),
    );
    const issuedOwners = new Map(ids.map((id) => [id, chatOwnerToken(id)]));
    const read = await deadlineRead((signal) =>
        readRefs(
            ids.map((id) => ({ kind: RESOURCE_KIND.characters, id })),
            { chatSummaryCollections: ids, signal },
        ),
    );
    if (halted) {
        return false;
    }
    let discardedWork = false;
    const records = new Map(read.items.map((item) => [item.id, item]));
    for (const collection of read.chatSummaryCollections ?? []) {
        const id = collection.characterId;
        const record = records.get(id);
        if (
            listReadGenerations.get(id) !== requestGeneration ||
            (characterWriteSerials.get(id) ?? 0) !== writeSerial ||
            writingCharacters.has(id) ||
            chatOwnerToken(id) !== issuedOwners.get(id)
        ) {
            continue;
        }
        if (purpose === "listRefresh") {
            if (!listRefresh.has(id)) {
                continue;
            }
            // Without an order (gone on the server) nothing is applied here: the live update or this
            // client's next save removes the character, with the notice when that discards anything.
            const discardsBefore = chatDiscardSequence();
            if (collection.order && !findMirrorCharacter(id)) {
                parkedListRefresh.add(id);
                listRefresh.delete(id);
            } else if (
                !collection.order ||
                applyRemoteCollection(collection, issued.get(id), { keepPendingOrder: true })
            ) {
                listRefresh.delete(id);
                parkedListRefresh.delete(id);
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
            // The character itself is gone on the server: preserve intent before removing its chats.
            const abandoned = captureRecordConflict(recordKey(record.kind, record.id), undefined, true);
            if (abandoned) queueConflictDraft(abandoned);
            acceptRemote(record);
            discardedWork = true;
        } else if (collection.order) {
            discardedWork = acceptRemoteCollection(collection) || discardedWork;
        } else {
            console.error(`[Save] Character ${id} has no chat order on the server`);
        }
        hydrate.delete(id);
        listRefresh.delete(id);
        parkedListRefresh.delete(id);
    }
    return discardedWork;
}

/** The raw `$state` object of a character in the mirror (reads and raw writes; no wrapper). */
function findMirrorCharacter(id: string): (character | groupChat) | undefined {
    return characterData().find((character) => character.chaId === id) as unknown as
        (character | groupChat) | undefined;
}

/**
 * The refresh queue reloads chats whose generation has ended. Each chat stays deferred until its
 * response can be applied; one that is gone queues its character's list. The queue shows the reload
 * notice as soon as a response discards local work.
 */
async function reloadDeferredChats(): Promise<void> {
    const results = await Promise.allSettled(deferredReloads().map(refreshDeferredChat));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
        throw failed.reason;
    }
}

function refreshDeferredChat(ref: ChatRef): Promise<boolean> {
    const key = `${ref.chaId}\u0000${ref.chatId}`;
    const existing = deferredRefreshes.get(key);
    if (existing) {
        return existing;
    }
    const request = readDeferredChat(ref)
        .then((discardedWork) => {
            if (discardedWork && !halted) {
                showReloadedNotice();
            }
            return discardedWork;
        })
        .catch((error) => {
            failedRefresh(error);
            throw error;
        })
        .finally(() => deferredRefreshes.delete(key));
    deferredRefreshes.set(key, request);
    return request;
}

async function readDeferredChat(ref: ChatRef): Promise<boolean> {
    const readStamp = issueChatReadStamp();
    const read = await deadlineRead((signal) =>
        readRefs([], {
            chats: [{ characterId: ref.chaId, id: ref.chatId }],
            signal,
        }),
    );
    if (halted) {
        return false;
    }
    const discardsBefore = chatDiscardSequence();
    for (const chat of read.chats ?? []) {
        const refresh = finishDeferredReload({ ...chat, readStamp } as RemoteChat);
        if (refresh) {
            queueCharacterRefresh(refresh, "hydrate");
        }
    }
    return chatDiscardSequence() > discardsBefore;
}

/**
 * Refreshes only `ref` when it is a stale or noticed loaded chat that is idle, independently of
 * other queue work. Its caller can then start a job on the server's revision. Returns whether
 * the chat is no longer known to be behind the server; local work or a newer notice can prevent
 * adoption and leave it behind.
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

/**
 * Reads eligible chats for the background queue or an explicit stale-chat refresh. Responses are
 * checked against the notice, held revision and read stamp before they enter the mirror. Eligible
 * manifests read named rows; a moved answer or apply miss awaits one whole-chat fallback under the
 * same deadline and epoch checks.
 */
async function readIdleChats(refs: readonly ChatRef[]) {
    if (refs.length === 0) {
        return;
    }
    // Taken before the read: a notice that arrives while the read is in flight keeps its mark, and a
    // chat found gone is removed only if its held revision did not change meanwhile.
    const notices = new Map(refs.map((ref) => [`${ref.chaId}\u0000${ref.chatId}`, chatNoticeSeq(ref)]));
    const issued = new Map(refs.map((ref) => [`${ref.chaId}\u0000${ref.chatId}`, heldChatRevision(ref)]));
    const readStamp = issueChatReadStamp();
    for (const ref of refs) {
        noteIdleChatRead(ref, readStamp);
    }
    const rows = new Map(
        refs.flatMap((ref) => {
            const request = idleChatRows(ref);
            return request ? [[`${ref.chaId}\u0000${ref.chatId}`, { ref, request }] as const] : [];
        }),
    );
    const finishWhole = (read: Awaited<ReturnType<typeof readRefs>>) => {
        for (const chat of read.chats ?? []) {
            const key = `${chat.characterId}\u0000${chat.id}`;
            if (
                finishIdleChatRefresh({ ...chat, readStamp } as RemoteChat, notices.get(key) ?? 0, issued.get(key)) &&
                chat.revision === null
            ) {
                // The chat is gone: the character's list is read again, never discarding local work.
                noteRemoteCollection(chat.characterId);
            }
        }
    };
    await deadlineRead(async (signal) => {
        const read = await readRefs([], {
            chats: refs
                .filter((ref) => !rows.has(`${ref.chaId}\u0000${ref.chatId}`))
                .map((ref) => ({ characterId: ref.chaId, id: ref.chatId })),
            ...(rows.size > 0
                ? {
                      chatRows: [...rows.values()].map(({ ref, request }) => ({
                          characterId: ref.chaId,
                          id: ref.chatId,
                          revision: request.revision,
                          messageIds: request.rows.changed,
                          meta: request.rows.meta,
                      })),
                  }
                : {}),
            signal,
        });
        // A timed-out transport may still resolve: neither it nor its fallback may install late.
        signal.throwIfAborted();
        if (halted) return;
        finishWhole(read);
        const answers = new Map((read.chatRows ?? []).map((chat) => [`${chat.characterId}\u0000${chat.id}`, chat]));
        const fallback = [...rows.entries()].filter(
            ([key, { ref, request }]) => !finishIdleChatRows(ref, request, answers.get(key), readStamp),
        );
        if (fallback.length === 0) return;
        const whole = await readRefs([], {
            chats: fallback.map(([, { ref }]) => ({ characterId: ref.chaId, id: ref.chatId })),
            signal,
        });
        signal.throwIfAborted();
        if (halted) return;
        if (whole.epoch !== read.epoch) throw epochMismatch(whole.epoch);
        finishWhole(whole);
    });
}

/**
 * Reads the summary lists of characters with an idle stale or noticed chat that is not loaded and
 * applies them as live updates; an applied list ends those chats' marks (`settleSummaryRefresh`).
 */
async function refreshIdleSummaries() {
    const ids = idleSummaryRefreshes()
        .filter((id) => !remoteCollections.has(id) && !hydrate.has(id) && !listRefresh.has(id))
        .slice(0, MAX_REMOTE_READS);
    if (ids.length === 0) {
        return;
    }
    const notices = summaryRefreshNotices(ids);
    const issued = heldChatRevisionsByCharacter(ids);
    const read = await deadlineRead((signal) => readRefs([], { chatSummaryCollections: ids, signal }));
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
 * another writer discards its chats' unsent work (`forgetCharacter` in
 * `src/ts/storage/chatStore.svelte.ts`); returns whether it had any. Removing the selected
 * character selects home. Selection reconciliation lives in `src/ts/storage/settingsViews.svelte.ts`.
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
            if (data === null) {
                listRefresh.delete(id);
                parkedListRefresh.delete(id);
            }
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
 * A live update: the refs and revisions one committed write changed. Each is compared with what
 * this client holds when it arrives, and one that is not newer is dropped (this client's own save,
 * or a job event that applied it first). A field patch this client can take now is applied at once
 * (`applyRemotePatch`), with no read. A newer record waits for the refresh queue, which applies it
 * only without local edits, except preserved `llmSecrets` siblings (`applyRemoteUpdates`); a
 * missing character or a singleton absent at boot (such as pluginStorage) can be inserted remotely,
 * but a locally created unsaved record waits for its save's 409 instead of adopting another create.
 * A chat goes to `src/ts/storage/chatStore.svelte.ts` with its optional by-id change (`rowDelta`, else
 * `delta`, else `patch`: applied at its exact base while loaded and idle, otherwise the ordinary idle
 * refresh)
 * and its summary knowledge (`summary` or `summaryBase`: settles a chat held only as its summary
 * without its character's chat list when it fits); a new chat or a changed chat order reads the
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
        // At most one body: whole rows, metadata by field, or row diffs with metadata by field.
        const change = chat.rowDelta ?? chat.delta ?? chat.patch;
        const { summary, summaryBase } = chat;
        const outcome = noteRemoteChat(
            { chaId: chat.characterId, chatId: chat.id },
            chat.revision,
            change,
            { summary, summaryBase },
            chat.rows,
        );
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
 * Reconciles with server revisions after every live-update `hello`, from the advertised map when
 * its digest matches or a fetched listing otherwise: every listed record, chat, and order goes
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
 * Applies a live update's record patch without reading the record, when this client holds the
 * record at exactly the patch's base revision (of the loaded epoch, the same incarnation, one write
 * before the update) and has no local change of it (`canApplyRemote`), except an echo of a lost
 * in-doubt write may advance the saved base while preserving newer local mirror text. Sending,
 * quarantined and job-blocked records still refuse that echo. In the ordinary path, a character's
 * field patch (`RecordFieldPatch`) goes in raw (`patchRawCharacter`: no mark, no echo); another
 * mirrored record patch (except `llmSecrets`) is applied to a detached copy of the held text and
 * the result goes through the mirror's whole-record path (`applyToMirror`, as a read would). The
 * saved text is the mirror's projection afterwards, as for a whole update, and a waiting notice the
 * update covers is settled. The remote-change listeners hear of every changed field. Returns false,
 * changing nothing, for anything else (another kind or patch form, another base, a local change, a
 * malformed patch or one naming a field twice, a character's fixed or client-only field or one the
 * mirror object only inherits, an item patch that does not fit the held list): the update is then
 * read whole as before.
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
    journalDiscarded(key);
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
 * apply, else whether any field changed (false for an empty patch).
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
    return fields.length > 0;
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

/**
 * Admission for ordinary live updates: never overwrite a local edit, in-flight/doubt write,
 * quarantine or job-blocked delete. An unheld record may enter only as a missing remote character
 * or an absent singleton; a local unsaved creation must reach its save/conflict outcome instead.
 * Character generation alone is no blocker. llmSecrets is checked against server siblings after
 * reading; blockedLocal prevents rereading the same conflicting local text while its 409 is
 * pending.
 */
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
    return adoptSecretSiblings(revision, masked, "all");
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
    journalDiscarded(key);
    if (isNew && collection) {
        applyRemoteCollection(collection);
    }
    notifyRemoteListeners(item.kind, item.id);
    return discardedWork;
}

/** Applies eligible feed patches synchronously before either writes or whole-record refreshes. */
function applyRemotePatches() {
    settleRemoteRecords();
    for (const entry of [...remoteRecords.values()]) {
        if (entry.patch) {
            applyRemotePatch(entry);
        }
    }
}

/**
 * Reads and applies waiting live updates concurrently with writes: first eligible patches without a
 * read (`applyRemotePatch`), then the eligible records and the chat lists of characters with no
 * order work, at most `MAX_REMOTE_READS` of each, new characters' lists first. Their lists go
 * through `src/ts/storage/chatStore.svelte.ts`; chat/order refs that beat insertion keep a list
 * read pending, and notices arriving during a read retain their sequence fence. Eligibility is
 * checked again after the read: a change made meanwhile keeps the update waiting. A read settles
 * only the notice it was issued for, or a later one its answer covers. A deletion applies only if
 * the held revision is unchanged since the read was issued; otherwise it is read again. Returns
 * whether a character deletion discarded unsent chat work (the refresh queue shows the reload
 * notice). Already-held revisions drop without a read. Adoptions except `llmSecrets` save the
 * mirror's projection, so watchers do not echo it; ordinary adoption discards no work, settles no
 * resource key and shows no notice. A deleted character's chat-work discard is the exception.
 * llmSecrets adopts the masked status and siblings as a credential reply does; conflicting
 * local/server siblings apply nothing and block on that local text until its save or 409 decides.
 */
async function applyRemoteUpdates(): Promise<boolean> {
    applyRemotePatches();
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
    const read = await deadlineRead((signal) =>
        readRefs(
            records.map(([, entry]) => ({ kind: entry.kind, id: entry.id })),
            { chatSummaryCollections: collections, signal },
        ),
    );
    if (halted) {
        return false;
    }
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
 * delete the server refused for a generating message (`isRecordJobBlocked`), nor `inDoubt`. A
 * generating character's record is applied at once. A record refused for a local change is kept
 * (the newest) and checked again after the next save cycle. A record this client does not hold,
 * a deletion, `llmSecrets`, and `authRefreshes` are not hydrated. A chat goes to `hydrateChat`.
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
    journalDiscarded(key);
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

/**
 * `flushResources` refused: a change it must save waits for a generation (this tab's or a server job's).
 * `chats` are the chats whose changes wait (empty when only a record or a chat order waits).
 */
export class GenerationBlockedError extends Error {
    constructor(readonly chats: readonly ChatRef[] = []) {
        super("A character is still being generated; try again when it finishes");
        this.name = "GenerationBlockedError";
    }
}

/** How many times `chatGenerating` was shown by the save adapter (a caller tells whether its flush showed it). */
let generatingNotices = 0;

/** Number of `chatGenerating` notices shown, so a flush caller can avoid showing the same refusal twice. */
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

/** Keepalive answers and held journal splits cannot hold a flush caller indefinitely. */
async function waitForWriteDependency(write: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Could not save every change")), READ_DEADLINE_MS);
    });
    try {
        await Promise.race([write, deadline]);
    } finally {
        clearTimeout(timer!);
    }
}

/**
 * Whether the adapter has nothing left to do: no record, membership change, chat write, or
 * credential write waiting that it could save now, no cycle scheduled or in flight, and no refresh
 * scheduled or in flight. For the browser harness (`e2e/fixtures.ts` `settle`), which waits on it
 * instead of sleeping past the debounce; a halted or stopped adapter counts as idle, since nothing
 * more will happen, and one not started yet does not, since its marks wait for the start.
 */
export function resourceSyncIdle(): boolean {
    if (halted || stopped) {
        return true;
    }
    if (!started) {
        return false;
    }
    return (
        timer === null &&
        inFlight === null &&
        refreshTimer === null &&
        refreshInFlight === null &&
        !hasPendingWork() &&
        !hasRefreshWork()
    );
}

/**
 * Settles changes queued before this call. Reports keys discarded since the call (with `scope`,
 * since the scope began), and every key still refused locally when the flush resolves;
 * rejects when saving fails or when a character that must be saved is still being generated.
 * Writes and dependency reads that leave their dependency pending share a ten-attempt limit;
 * outstanding unload answers and split journal dependencies each have a twenty-second wait bound;
 * a split timeout rejects without releasing its prefix. Captures record generations, membership,
 * chat/order sequences and credential ids; unrelated background reads and later edits do not add
 * obligations. Relevant dependency reads alone are joined and propagate errors.
 * Result keys are `<kind>/<id>`, `chats/<chaId>/<chatId>`, and `chats/<chaId>` for orders.
 * `discarded` covers a conservative time window; `refused` is the inventory at resolution. An empty
 * discard list does not prove every change durable. Quarantined chat/order work is nonblocking
 * and remains refused; its discard event appears only in the refusal's window. A quarantined
 * record rejects immediately (`quarantineReason`); generation-blocked work throws `GenerationBlockedError`.
 */
export async function flushResources(
    options: { scope?: MutationScope } = {},
): Promise<{ discarded: string[]; refused: string[] }> {
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
    const secretTarget = new Set(llmSecretState.queue.map((op) => op.id));
    const pending = () =>
        llmSecretState.queue.some((op) => secretTarget.has(op.id)) ||
        unsettled().length > 0 ||
        membershipAcked < membershipTarget ||
        unsettledChatObligations(chatObligations).length > 0;
    let attempts = 0;
    while (pending() && attempts < 10) {
        if (halted) {
            throw new Error("Saving stopped: the server data was restored");
        }
        const waiting = unsettledChatObligations(chatObligations).filter(isChatDeferred);
        if (waiting.length > 0 || [...jobBlockedRecords.keys()].some(isRecordJobBlocked)) {
            // A chat obligation's key is `chaId\u0000chatId`; a chat order's is the character id.
            throw new GenerationBlockedError(
                waiting
                    .filter((key) => key.includes("\u0000"))
                    .map((key) => {
                        const [chaId, chatId] = key.split("\u0000");
                        return { chaId, chatId };
                    }),
            );
        }
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        const wrote = await runCycle();
        if (wrote) {
            attempts += 1;
        }
        assertSaveAdmission();
        const refused = quarantineReason();
        if (refused) {
            throw refused;
        }
        if (lastError || permanentError) {
            throw lastError ?? permanentError;
        }
        if (!pending()) {
            break;
        }
        const waitingOnSplit = unsettledChatObligations(chatObligations).some((key) => chatJournal.splitGroupId(key));
        if (waitingOnSplit) {
            await waitForWriteDependency(flushJournal());
            continue;
        }
        if (wrote && hasPendingWork()) {
            continue;
        }
        const open = new Set(unsettledChatObligations(chatObligations));
        const dependencies: Promise<unknown>[] = [];
        const refreshing = new Set<string>();
        const deferred = new Set<string>();
        for (const id of new Set([...open].map((key) => key.split("\u0000")[0]))) {
            if (
                (hydrate.has(id) || listRefresh.has(id)) &&
                (open.has(id) ||
                    (!wrote && [...open].some((key) => key.startsWith(`${id}\u0000`) && !unloadWrites.has(key))))
            ) {
                if (isCharacterStreamedHere(id) && hydrate.has(id)) {
                    throw new GenerationBlockedError([]);
                }
                refreshing.add(id);
                dependencies.push(refreshCharacter(id));
            }
        }
        for (const ref of deferredReloads()) {
            const key = `${ref.chaId}\u0000${ref.chatId}`;
            if (open.has(key)) {
                deferred.add(key);
                dependencies.push(refreshDeferredChat(ref));
            }
        }
        for (const key of open) {
            const unload = unloadWrites.get(key);
            if (unload) {
                dependencies.push(waitForWriteDependency(unload));
            }
        }
        if (dependencies.length > 0) {
            // Only reads holding captured writes participate in the barrier or propagate failures.
            await Promise.all(dependencies);
            // A successful transport may still leave a stale snapshot or an ineligible list.
            // Count that unsuccessful refresh so repeated read-only cycles cannot hold the flush.
            if (
                !wrote &&
                ([...refreshing].some((id) => hydrate.has(id) || listRefresh.has(id)) ||
                    deferredReloads().some((ref) => deferred.has(`${ref.chaId}\u0000${ref.chatId}`)))
            ) {
                attempts += 1;
            }
        } else if (!wrote && pending()) {
            // A collection-only cycle may settle no-op generations, but cannot make an unavailable
            // obligation runnable. Do not burn the write-attempt budget on empty cycles.
            const waiting = unsettledChatObligations(chatObligations).filter(isChatDeferred);
            if (waiting.length > 0 || [...jobBlockedRecords.keys()].some(isRecordJobBlocked)) {
                continue;
            }
            throw new Error("Could not save every change");
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
        refused: refusedItems().map((item) =>
            item.kind === "chat"
                ? `chats/${item.chaId}/${item.chatId}`
                : item.kind === "order"
                  ? `chats/${item.chaId}`
                  : `${item.resourceKind}/${item.id}`,
        ),
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
 * Hidden visibility bypasses debounce/backoff, joining a running cycle and following it with one
 * more only if work remains and it did not fail. `beforeunload` protects refused content too, but
 * never warns after halt; refusals alone keep no retry loop running. `pagehide` uses only whole eligible
 * by-id chat batches under existing ids, one keepalive per chat with a shared `UNLOAD_BODY_LIMIT`
 * (60 KiB) including outstanding requests. Only a dispatched group becomes in flight; failed sends
 * retain it. Records, credentials, creates/deletes, replacements and orders use normal cycles only,
 * avoiding competing writes on the same revision. Keepalive settlement belongs to `chatStore.svelte.ts`.
 */
export function startResourceSync() {
    if (started || halted) {
        return;
    }
    started = true;
    setEpochMismatchListener(() => {
        void haltForRestore();
    });
    setMutationAdmission(() => !halted);
    setSecretScheduler(() => {
        for (const op of llmSecretState.queue) {
            noteWait(`secret:${op.id}`, op.id);
        }
        permanentError = null;
        schedule();
    });
    chatJournal.setListener(queueJournalChat);
    chatJournal.setConflictListener(captureJournalChat);
    setChatWorkListener(() => {
        pruneWaits();
        noteChatWaits();
        schedule();
    });
    // The settings records mark themselves: every local write of one (`records.svelte.ts`).
    setRecordWriteListener((kind) => {
        markKey(collectionKey(kind));
    });
    function onVisibilityChange() {
        if (document.visibilityState !== "hidden" || halted) {
            return;
        }
        void flushJournal(true);
        void (async () => {
            await tick();
            if (halted) return;
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
    }
    function onBeforeUnload(event: BeforeUnloadEvent) {
        // A halted loop (the data was replaced) can save nothing more: no warning, so the reload after
        // the restore notice goes through.
        if (!halted && hasUnsavedWork()) {
            event.preventDefault();
            event.returnValue = "";
        }
    }
    // One shared budget, including requests still in flight from an earlier pagehide: by-id chat work,
    // one request per chat. Resource writes use only normal cycles, so they never race a keepalive
    // write on the same revision.
    let unloadBytes = 0;
    function sendUnload(request: { body: string; work: ChatWork }) {
        const bytes = utf8ByteLength(request.body);
        if (bytes + unloadBytes > UNLOAD_BODY_LIMIT) {
            return;
        }
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => {
            finish = resolve;
        });
        fenceCharacterWrites([], request.work, true);
        if (
            sendBatchOnUnload(request.body, (result) => {
                unloadBytes -= bytes;
                try {
                    if (!halted) {
                        settleUnloadWork(request.work, result?.chats ?? null);
                    }
                } finally {
                    fenceCharacterWrites([], request.work, false);
                    for (const group of request.work.groups) {
                        unloadWrites.delete(group.key);
                    }
                    finish();
                    if (!halted) {
                        schedule();
                    }
                }
            })
        ) {
            unloadBytes += bytes;
            captureWaits([], request.work, new Map(), membershipGeneration);
            recordSaveWait({ ops: [], work: request.work }, new Map(), membershipGeneration);
            trackUnloadWork(request.work);
            for (const group of request.work.groups) {
                unloadWrites.set(group.key, pending);
            }
        } else {
            fenceCharacterWrites([], request.work, false);
        }
    }
    function onPageHide() {
        if (halted) {
            return;
        }
        void flushJournal(true);
        try {
            for (const request of unloadPendingChatWork(UNLOAD_BODY_LIMIT - unloadBytes)) {
                sendUnload(request);
            }
        } catch {}
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onPageHide);
    removeLifecycleListeners = () => {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("beforeunload", onBeforeUnload);
        window.removeEventListener("pagehide", onPageHide);
    };
    unloadAuthInterval = setInterval(() => {
        if (!halted && hasUnsavedWork()) {
            prepareUnloadAuth();
        }
    }, 60_000);
    noteChatWaits();
    stopChatDriftCheck = startChatDriftCheck();
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

/**
 * Terminal teardown: fence mutations, detach listeners, clear timers and abort adapter reads without
 * saving, alerting or reloading. The shared page draft journal is closed separately by its owner.
 */
export function stopResourceSync() {
    stopped = true;
    halted = true;
    setMutationAdmission(() => false);
    removeLifecycleListeners?.();
    removeLifecycleListeners = null;
    stopChatDriftCheck?.();
    stopChatDriftCheck = null;
    if (timer) clearTimeout(timer);
    if (refreshTimer) clearTimeout(refreshTimer);
    if (journalTimer) clearTimeout(journalTimer);
    if (unloadAuthInterval) clearInterval(unloadAuthInterval);
    timer = refreshTimer = journalTimer = null;
    unloadAuthInterval = null;
    cancelRestorePoll?.();
    cancelRestorePoll = null;
    for (const controller of readControllers) {
        controller.abort(new Error("Resource sync stopped"));
    }
    journalPending.clear();
    conflictDrafts.clear();
    journalChatPending.clear();
    chatJournal.setListener(null);
    chatJournal.setConflictListener(null);
    setRecordWriteListener(null);
    setCharacterWriteListener(null);
    setChatWorkListener(null);
    setEpochMismatchListener(null);
    setSecretScheduler(() => {});
    restoreReloadHook = null;
    remoteChangeListeners.clear();
    pluginStorageDiscardListeners.clear();
    saving.state = false;
}
