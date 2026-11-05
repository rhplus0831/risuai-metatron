// First: module effects elsewhere (`stores.svelte`) read `selectedChat()` while this module may still be loading.
import { onCharacterSelectionChanged, selection } from "./selection.svelte";
import { setOpenChatBindingSource, settings } from "./settingsViews.svelte";
import { untrack } from "svelte";
import { v4 as uuidv4 } from "uuid";
import type {
    ChatGroupResult,
    ChatOp,
    ChatOrderRecord,
    ChatOrderResult,
    ChatRecord,
    ChatSummary,
    MessageAnchor,
} from "../../../shared/chats.ts";
import { CHAT_META_FORBIDDEN_KEYS, CHAT_META_MERGE_KEYS } from "../../../shared/chats.ts";
import type { ChatStreaming, ChatStreamingSnapshot } from "../../../shared/events.ts";
import type { GenerationChunkEvent, StreamingMessage } from "../../../shared/jobs.ts";
import { readChatBindingIds } from "../../../shared/chatBinding.ts";
import {
    type ChangeSet,
    type ChatDeltaBody,
    type ChatMetaFields,
    type ChatPatchBody,
    compareRevision,
    parseRevisionToken,
} from "../../../shared/resources.ts";
import { firstOverridePerId } from "../../../shared/lore/overrides.ts";
import type { ChatLoreOverride } from "../../../shared/database.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import {
    hypaV3DataHoldsSummaries,
    isSealedHypaV3Data,
    sealedHypaV3DataIntact,
    sealedHypaV3DataRevision,
    STRUCTURED_MEMORY_ALGORITHM,
    type SealedHypaV3Data,
} from "../../../shared/structuredMemory.ts";
import {
    CHAT_TRANSLATION_FIELD_TYPES,
    chatTranslationSummary,
    type ChatTranslationFields,
} from "../../../shared/translation/chatSettings.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import { dropInvalidTranslation, isMessageTranslation } from "../../../shared/translation/messageTranslation.ts";
import { language } from "src/lang";
import { alertConfirm, alertError, alertToast } from "../alert";
import type { character, Chat, groupChat, Message, MessageTranslation } from "./database.svelte";
import { characterData, setCharacterChatView } from "./records.svelte";
import { readRefs } from "./resourceClient";
import {
    chatTarget,
    orderTarget,
    type ChatLayerValues,
    type OrderLayerValues,
    type JournalBefore,
    type JournalChatOp,
} from "./draftJournal";

/**
 * The chat mutation module. Chats are server resources of their own
 * (metadata plus one row per message, addressed by `Message.chatId`; each character's chat order is a
 * record of its own). This module holds them: per character, its chat ids in order
 * (the membership), each chat either loaded (the whole chat) or as its summary (the list fields),
 * reactive, outside the character records. It is the only code that writes them: every call updates
 * the held chats (the mirror) synchronously and queues an operation that the save loop
 * (`resourceSync.svelte.ts`) sends in its next batch. Boot reads summaries only (`assembleChats`); a
 * chat is loaded on demand (`ensureChatLoaded`, `loadChats`, the selected chat when it is selected),
 * kept loaded while it is pinned or busy, and evicted beyond `MAX_LOADED_CHATS` idle loaded chats
 * (least recently used first). Readers use `chatList`, `chatEntry`, `selectedChat`, `findChat`, and
 * the loading functions; a character wrapper's `chats`/`chatPage` is a view of the loaded chats
 * built here (`setCharacterChatView`) for the shared CBS evaluator, which reads that legacy shape.
 *
 * - Addressing is by `ChatRef` (`chaId`, `chatId`) and message id, never by index.
 * - Per chat, work is unsent (`pending`) or in flight (`inflight`, immutable until the save loop
 *   acknowledges it, requeues it after a failure, or recovers it after a conflict). Unsent operations
 *   of one chat coalesce. A chat never sent is sent as it is in the mirror; a create that was sent
 *   but not acknowledged is resent exactly as sent (it may have landed), followed by later work.
 * - Each chat has a local version that every change bumps (local or from the server); a hook's
 *   baseline records it, so a whole-chat replacement never overwrites a change made meanwhile.
 * - A stale acknowledgement keeps the old base and requests an idle refresh. Only a chat with no
 *   pending/in-flight work, lock, deferral, or quarantine may accept it; this is not a discard.
 * - The selected chat is per tab: `selectChat` records the chat id (`chatPage` in the facade view is
 *   its index).
 * - A server generation job locks the message it writes: nothing but the job may rewrite or
 *   remove it. `applyServerGeneration` writes the streamed text into the mirror without queuing
 *   anything, and the job's end releases its locks. A chat `resource` event replaces the chat through
 *   `hydrateChat` (never an outgoing write). Work the server refused for a generating message
 *   (`reason: "generating"`) is kept and retried after `JOB_RETRY_MS`, except its edits of the locked
 *   messages the refusal names, which are dropped with the reload notice and read back with the chat
 *   (also for a tab whose follow of its own job was lost). A conflict on a chat a job
 *   streams into is deferred: it reloads once the job ends. A chat's streamed message is its
 *   `streamingEntry` (the chat screen's display optimization) from its generation's first stream
 *   update until that generation's lock is released; each chat has its own.
 *   `lockedChatKeys` reads the distinct chat keys holding these locks (reactive).
 * - A structured chat's `hypaV3Data` is a projection a whole read overlays: the mirror holds it for
 *   plugins to read, and it never leaves the tab (`sendChat`). A write of the field is decided against
 *   the held value (`keepsHeldHypaV3Data`); a job's copy, which is stored data, leaves it in place
 *   unless it brings summaries of its own (`keepsProjection`). A plugin read's refresh takes a newer
 *   value through `installChatProjection`, fenced on what `chatProjectionState` captured before its
 *   first await: the one change of the field that is no write of the chat, so nothing is queued.
 */

export type ChatRef = { chaId: string; chatId: string };

type AnyCharacter = character | groupChat;

/** How long a chat whose work the server refused for a generating message waits before it is retried. */
export const JOB_RETRY_MS = 5000;
const SELECTION_STORAGE_KEY = "risu-selected-chats";
const forbiddenMetaKeys = new Set(CHAT_META_FORBIDDEN_KEYS);

const keyOf = (chaId: string, chatId: string) => `${chaId}\u0000${chatId}`;
const messageKeyOf = (ref: ChatRef, messageId: string) => `${keyOf(ref.chaId, ref.chatId)}\u0000${messageId}`;

/** Map transitions invalidate journal layers; in-place changes mark them at their write sites. */
class JournalMap<T> extends Map<string, T> {
    private readonly change: (key: string, before: T | undefined, after: T | undefined) => void;

    constructor(change: (key: string, before: T | undefined, after: T | undefined) => void) {
        super();
        this.change = change;
    }

    override set(key: string, value: T) {
        const before = this.get(key);
        super.set(key, value);
        this.change(key, before, value);
        return this;
    }

    override delete(key: string) {
        const before = this.get(key);
        const removed = super.delete(key);
        if (removed) this.change(key, before, undefined);
        return removed;
    }

    override clear() {
        for (const key of this.keys()) this.delete(key);
    }
}

/** A chat's queued, unsent work. */
type Pending = {
    characterId: string;
    chatId: string;
    /** Never sent: sent as a `create` built from the mirror (with only its generation ops). */
    create: boolean;
    /**
     * A group to send alone before anything else of the chat, exactly as it is (`Resend`): a sent
     * group whose answer was lost (it may have landed), a create that was not acknowledged, or a
     * group the recovery repaired. `create`, `ops`, and `seq` are the newer work behind it; they wait
     * until it is answered and go out in a group of their own.
     */
    resend: Resend | null;
    /** Identity of this unsent batch, independent of a kept resend's id. */
    groupId: string;
    /** Unsent ops, in order. */
    ops: ChatOp[];
    /** Local sequence number of the latest change. */
    seq: number;
    /** Creation time of intent installed by boot recovery. */
    recoveredAt?: number;
};

/**
 * A group kept apart for a resend: its ops, sequence, base, and
 * group id as sent. `inDoubt`: an earlier attempt may have landed (its answer was lost), so it goes
 * out with `retry` and the same id, and the server answers it as before if it did.
 */
type Resend = {
    ops: ChatOp[];
    seq: number;
    baseRevision: string | null;
    groupId: string;
    inDoubt: boolean;
    /** A split cannot send its prefix until the journal replaced the old whole-batch row. */
    unconfirmed?: true;
    recoveredAt?: number;
};

/** Whether the group kept for a resend is a create (the chat may not be on the server yet). */
function isCreateResend(entry: Pending | undefined): boolean {
    return entry?.resend?.ops[0]?.op === "create";
}

/** Whether a chat's queued work (its resend or its unsent ops) deletes it. */
function queuesDelete(entry: Pending | undefined): boolean {
    return !!entry && [...(entry.resend?.ops ?? []), ...entry.ops].some((op) => op.op === "delete");
}

/** One chat group of a batch, as sent (immutable). */
export type SentChatGroup = {
    key: string;
    characterId: string;
    chatId: string;
    baseRevision: string | null;
    ops: ChatOp[];
    seq: number;
    /** The group's id (`ChatGroup.groupId`): fresh for new work, the kept one for a resend. */
    groupId: string;
    /** Sent from a resend: requeued, it is kept apart again (never merged into newer work). */
    resent?: true;
    /** An earlier attempt may have landed: sent with `retry` (`Resend.inDoubt`). */
    inDoubt?: true;
    /** For a create: what the chat is on the server if this whole group landed (replay recognition). */
    expected?: string;
    recoveredAt?: number;
};

export type SentChatOrder = { characterId: string; baseRevision: string; ids: string[]; seq: number };

export type ChatWork = { groups: SentChatGroup[]; orders: SentChatOrder[] };

const chatRevisions = new Map<string, string>();
/**
 * Per chat (`keyOf`): bumped when this client first holds a revision for a chat it did not hold one
 * for (its first save landed or a landed create was recognized; not the boot seed or a restore), so
 * the rows rendered before it without a server transform context render again.
 */
const savedVersions = $state<Record<string, number>>({});
/** Per chat: authoritative installs and acknowledgements that finish its queued work. */
const installVersions = $state<Record<string, number>>({});
const unackedWork = $state<Record<string, boolean>>({});

function recordChatInstall(key: string) {
    untrack(() => {
        installVersions[key] = (installVersions[key] ?? 0) + 1;
    });
}

function syncUnackedWork(key: string) {
    untrack(() => {
        const busy = isBusy(key);
        if ((unackedWork[key] ?? false) !== busy) {
            if (busy) unackedWork[key] = true;
            else delete unackedWork[key];
        }
    });
}

// Keep the reactive read in sync at every work transition. Consumers drain asynchronously,
// after transfers between these collections (for example, in-flight work into quarantine).
class ChatWorkMap<T> extends Map<string, T> {
    override set(key: string, value: T): this {
        super.set(key, value);
        syncUnackedWork(key);
        return this;
    }

    override delete(key: string): boolean {
        const removed = super.delete(key);
        if (removed) syncUnackedWork(key);
        return removed;
    }

    override clear(): void {
        const keys = [...this.keys()];
        super.clear();
        for (const key of keys) syncUnackedWork(key);
    }
}

class ChatWorkSet extends Set<string> {
    override add(key: string): this {
        super.add(key);
        syncUnackedWork(key);
        return this;
    }

    override delete(key: string): boolean {
        const removed = super.delete(key);
        if (removed) syncUnackedWork(key);
        return removed;
    }

    override clear(): void {
        const keys = [...this];
        super.clear();
        for (const key of keys) syncUnackedWork(key);
    }
}

/**
 * Per chat (`keyOf`): the newest revision an acknowledgement of this client's work reported while
 * the held revision stayed older (a stale acknowledgement keeps the older base). The server holds
 * that edit from this revision on, so a copy older than it lacks the edit: no read, job copy, list,
 * or patch below it is installed, whatever the held revision. Dropped once the held revision
 * reaches it, or with the chat.
 */
const ackedRevisions = new Map<string, string>();

/**
 * Chats (`keyOf`) this client still holds a revision of that an authoritative chat list showed the
 * server no longer has, while this client keeps them (local work, a quarantine, a generation, or a
 * delete that cannot be sent): the server's order cannot hold them, so reorders, create indices, and
 * order acknowledgements leave them out (`serverHolds`). The held revision stays (the base of their
 * work, whose conflict removes them). Cleared only by positive membership evidence: a list that
 * places the chat, an acknowledged create whose answer lists the chat in the order, or the revision
 * being dropped. A revision installed otherwise (a late acknowledgement or read from before the
 * deletion) does not clear it.
 */
const absentChats = new Set<string>();

/**
 * Per character id: the resends (`Pending.resend`) of its chats that this tab's deletion of the
 * character settled while their groups may have landed, by chat key. The
 * deletion removes those chats once the server acknowledges it; until then a same-id re-add restores
 * them (`installCharacterChats`), so it reconciles the chats with their group ids and payloads (the
 * in-doubt replay recognition) instead of forgetting a landed create. Dropped when the server shows the
 * character gone (`forgetCharacter`), when its deletion is acknowledged, or when an authoritative
 * chat list of the character is accepted (`acceptRemoteCollection`). A create resend is not kept
 * only when it is not in doubt and this client holds no revision of the chat (`parkResends`).
 */
const parkedResends = new JournalMap<Map<string, { chatId: string; resend: Resend }>>((_id, before, after) => {
    for (const key of new Set([...(before?.keys() ?? []), ...(after?.keys() ?? [])])) {
        dirtyChatJournal(key, "resend");
    }
});

/** Whether the server's chat order holds the chat as far as this client knows (`absentChats`). */
function serverHolds(key: string): boolean {
    return chatRevisions.has(key) && !absentChats.has(key);
}

/** Records a chat's held revision (every runtime install but the seed): see `savedVersions`. */
function holdChatRevision(key: string, revision: string) {
    const first = !chatRevisions.has(key);
    chatRevisions.set(key, revision);
    dirtyChatJournal(key, "pending");
    dirtyOrderJournal(key.split("\u0000")[0], "latest");
    if (first) {
        savedVersions[key] = (savedVersions[key] ?? 0) + 1;
    }
    if (!belowAckedRevision(key, revision)) {
        ackedRevisions.delete(key);
    }
}

/** Drops a gone or forgotten chat's revision, acknowledged floor, feed locks, and read-order bookkeeping. */
function dropChatRevision(key: string) {
    chatRevisions.delete(key);
    ackedRevisions.delete(key);
    absentChats.delete(key);
    idleReadStamps.delete(key);
    dirtyChatJournal(key, "pending");
    dirtyOrderJournal(key.split("\u0000")[0], "latest");
    releaseFeedLocks(`${key}\u0000`);
}

/**
 * Whether a server copy at `revision` is older than an acknowledgement this client received for the
 * chat (`ackedRevisions`): it lacks an edit the server holds. An incomparable revision (another
 * epoch, malformed) counts as older.
 */
function belowAckedRevision(key: string, revision: string): boolean {
    const floor = ackedRevisions.get(key);
    return floor !== undefined && (compareRevision(revision, floor) ?? -1) < 0;
}

/**
 * How many times the chat gained its first held revision (reactive; `savedVersions`): a first save landed,
 * or a landed create was recognized; not the boot seed or a restore. The chat screen renders the chat's
 * rows again on it, since a row rendered before had no server transform context.
 */
export function chatSaveVersion(ref: ChatRef): number {
    return savedVersions[keyOf(ref.chaId, ref.chatId)] ?? 0;
}

/**
 * The chat's installed-state version (reactive): moves when `ackChatWork` empties the chat's work (not a
 * stale acknowledgement, which only marks a refresh) and on every installed copy (a patch or a job
 * hydration of another revision); local edits and stream chunks do not advance it.
 */
export function chatInstallVersion(ref: ChatRef): number {
    return installVersions[keyOf(ref.chaId, ref.chatId)] ?? 0;
}

/** Whether the chat has unacknowledged work (reactive), including refused, deferred, or job-blocked work. */
export function chatHasUnackedWork(ref: ChatRef): boolean {
    return unackedWork[keyOf(ref.chaId, ref.chatId)] ?? false;
}

const orderRevisions = new JournalMap<string>((id) => dirtyOrderJournal(id, "latest"));
const pending = new JournalMap<Pending>((key, before, after) => {
    dirtyChatJournal(key, "pending");
    if ((before?.resend ?? null) !== (after?.resend ?? null)) dirtyChatJournal(key, "resend");
    syncUnackedWork(key);
});
const inflight = new JournalMap<SentChatGroup>((key) => {
    dirtyChatJournal(key, "resend");
    syncUnackedWork(key);
});
const pendingOrders = new JournalMap<number>((id) => dirtyOrderJournal(id, "latest"));
const inflightOrders = new JournalMap<SentChatOrder>((id) => dirtyOrderJournal(id, "sent"));
/** Conflicting sent orders whose outcome waits for an authoritative collection read. */
const recoveringOrders = new JournalMap<SentChatOrder>((id) => dirtyOrderJournal(id, "sent"));
/** Chat keys → highest local sequence settled (acknowledged or discarded). */
const settled = new Map<string, number>();
const ordersSettled = new Map<string, number>();
/** Keys whose work a conflict discarded, with the discard sequence (for `flushResources`). */
const discarded = new Map<string, number>();
let discardSequence = 0;
/** Refused intent, retained until an explicit local edit, retry, or discard. Identity fences discards. */
type ChatRefusal = { reason: string; ops: ChatOp[]; create: boolean; delete: boolean; recovered?: true };
const quarantined = new JournalMap<ChatRefusal>((key) => {
    dirtyChatJournal(key, "refused");
    syncUnackedWork(key);
});
/** Refused reorders wait until the ordered ids change. */
const quarantinedOrders = new JournalMap<{ ids: string; reason: string }>((id) => {
    dirtyOrderJournal(id, "refused");
    dirtyOrderJournal(id, "latest");
});
const chatAlerts = new Set<string>();
const orderAlerts = new Set<string>();
let refusalVersion = $state(0);

function notifyRefusals() {
    untrack(() => {
        refusalVersion += 1;
    });
}

function clearChatRefusal(key: string) {
    if (quarantined.delete(key)) notifyRefusals();
}

function clearOrderRefusal(chaId: string) {
    if (quarantinedOrders.delete(chaId)) notifyRefusals();
}
/** Chats whose conflict reload waits for the server job streaming into them. */
const deferred = new ChatWorkSet();
/** Chats acknowledged on an older base, awaiting an idle read of the server's complete state. */
const staleChats = new Set<string>();
/**
 * Chats a live update announced as changed on the server (`noteRemoteChat`) → the sequence of the
 * latest notice and the revision it announced (null: deleted). Only an idle read that began after
 * that notice clears it, or this client coming to hold that revision another way (its own save, a
 * job's chat event).
 */
const noticedChats = new Map<string, { seq: number; revision: string | null }>();
let noticeSeq = 0;
/** Bumped when `serverGenerations` or `feedLocks` changes, so the chat screen's lock reads re-run. */
const lockState = $state({ version: 0 });
// Bumped by a generation's first chunk in this tab (`isMessageStreamed`), apart from the lock readers.
const streamedState = $state({ version: 0 });
/**
 * Messages a server generation job writes (`messageKeyOf`) → the job, its generation, the last
 * chunk's sequence, and the streamed text (put back after a chat hydration).
 */
const serverGenerations = new Map<string, { jobId: string; generationId: string; seq: number; text: string }>();
/**
 * Per message (`messageKeyOf`): the newest chunk `seq` of a server generation that the mirror's stored
 * copy holds (from the job's chat events); a streamed text at or below it is older than the copy.
 */
const serverWatermarks = new Map<string, { generationId: string; seq: number }>();
/** Server generations that ended or were replaced: their late events are dropped. */
const retiredGenerations = new Set<string>();
/**
 * Messages (`messageKeyOf`) the change feed announced as locked by a generation job of any tab or
 * device or an adopted whole read → the generation, the chat revision of the
 * frame or snapshot that announced it (null: none), and whether an announcement of that generation
 * said its stored text holds a streamed chunk (`seq` above 0). A lock only: no stream text, no watermark, no
 * retirement, and it never holds the save loop's reads, patches, or reloads (`isChatStreamedHere`).
 * Independent of this tab's job events: losing a follow does not release the feed lock.
 * Whole-read snapshots replace a chat's locks only when issued after its latest feed list, the
 * latest `hello`, and its last honored read. Reads without a stamped snapshot use revisions.
 */
const feedLocks = new Map<string, { generationId: string; revision: string | null; streamed: boolean }>();
/** One local issue order for feed lists, `hello`, and whole-chat reads; revisions do not order locks. */
let feedLockOrder = 0;
let feedHelloOrder = 0;
const feedChatOrders = new Map<string, number>();
const feedReadOrders = new Map<string, number>();

/** Capture immediately before issuing a whole-chat read and carry it on each adopted `RemoteChat`. */
export function issueChatReadStamp(): number {
    return ++feedLockOrder;
}
/**
 * Per chat: the newest job chat event whose metadata (streaming, releases) was taken, applied or
 * not; an older event's metadata is ignored. The entry's identity fences reads that reuse metadata.
 */
const jobMetadata = new Map<string, { revision: string }>();
/** Chats whose work the server refused for a generating message → when it may be sent again. */
const jobBlocked = new ChatWorkMap<number>();
/** Chat keys → local version, bumped by every change of the chat in the mirror. */
const versions = new Map<string, number>();
let localSeq = 0;
let workListener: (() => void) | null = null;
let remoteListener: ((ref: ChatRef) => void) | null = null;

/** Bumped by every mirror write this module makes (the development drift check compares it). */
let mutationToken = 0;

/** The message a chat shows as streaming and the display optimization mode it streams with. */
export type StreamingEntry = { messageId: string; mode: Chat["activeStreamingDisplayOptimizationMode"] };

/**
 * Per chat (`keyOf`): the message a server job of this tab streams into, for the chat screen's
 * display optimization (client-only; replaces the persisted flags), and the generation that set it
 * (null: set by `setStreamingState`). Set on the generation's first stream update with the
 * configured mode, cleared when that generation's lock is released; a job in another chat has its
 * own entry; a later generation in the chat takes the entry over.
 */
const streamingChats: Record<string, StreamingEntry & { generationId: string | null }> = $state({});

/** An unloaded chat's summary: list metadata and the derived time of its last message. */
type ChatEntryMeta = {
    /**
     * Derived, never written: kept across summary ingestion, whole-chat copies, and eviction; never laid
     * from a pending summary over a loaded chat.
     */
    lastMessageAt?: number;
    name: string;
    pinned?: boolean;
    folderId?: string;
    bindedPersona?: string;
    promptPresetId?: string;
    modelPresetId?: string;
    bindingReview?: boolean;
    fmIndex: number;
} & ChatTranslationFields;

/**
 * One character's chats: the ids in order (its membership), the loaded chats by id, and the summaries
 * of the chats that are not loaded (`slot` keys). Every member is in exactly one of the two.
 */
type HeldChats = { ids: string[]; chats: Record<string, Chat>; summaries: Record<string, ChatEntryMeta> };

/** One member as `setChatList` takes it: loaded (`chat`) or as its summary (`meta`). */
type ChatEntry = { id: string; chat?: Chat; meta?: ChatEntryMeta };

/**
 * The key of an id in the held dictionaries (`held`, `chosen`, `HeldChats.chats`): prefixed, so an
 * accepted id named like an `Object.prototype` member (`constructor`, `toString`, `__proto__`) is an
 * own key like any other (the dictionaries are `$state` objects, which keep `Object.prototype`).
 */
const slot = (id: string) => `#${id}`;

/**
 * The chats this module holds, per `chaId` (reactive). The membership changes only through this
 * module's membership writes (create, delete, reorder, a remote chat or collection); a load never adds
 * a chat to a list, and a server copy never loads a chat (only a load does).
 */
const held: Record<string, HeldChats> = $state({});

// Positions are validated against unique row ids; invalidation controls rebuild cost, not correctness.
const messagePositions = new Map<string, Map<string, number>>();
let messagePositionBuilds = 0;
let messagePositionLookups = 0;

/** Counts index builds and lookups so tests can check work without timing it. */
export function messagePositionStats(): Readonly<{ builds: number; lookups: number }> {
    return { builds: messagePositionBuilds, lookups: messagePositionLookups };
}

/** The selected chat id per character (this tab; reactive). */
const chosen: Record<string, string> = $state({});
/** Per character, bumped by every change of its selected chat (`chatSelectionVersion`). */
const selectionVersions = new Map<string, number>();

/** Sets a character's selected chat, bumping its selection version. */
function choose(chaId: string, id: string) {
    chosen[slot(chaId)] = id;
    selectionVersions.set(chaId, (selectionVersions.get(chaId) ?? 0) + 1);
}

/**
 * How many times a character's selected chat changed in this tab (not reactive): an action that
 * selects a result after an await compares it, so a newer selection is kept (also A, then B, then A).
 */
export function chatSelectionVersion(chaId: string): number {
    return selectionVersions.get(chaId) ?? 0;
}

/**
 * Pins per character (`pinChats`, keyed by `chaId`) and per chat (`pinChat`, keyed by `keyOf`): a
 * pinned chat, or every chat of a pinned character, is never evicted while a consumer works. Each
 * lifetime of a character's held chats has its own counters, so a release from before a reset never
 * takes a later pin.
 */
const pins = new Map<string, { count: number }>();

/** How many idle loaded chats a tab keeps (`trimLoadedChats`); busy, pinned, and selected ones do not count. */
export const MAX_LOADED_CHATS = 8;
/**
 * The keys of the loaded chats (kept by the list helpers below), so a trim with few loaded chats
 * costs nothing. A key here whose chat is no longer loaded is skipped by the trim.
 */
const loadedKeys = new Set<string>();
/** Per chat key: when it was last loaded, selected, or found loaded by `ensureChatLoaded` (eviction order). */
const lastUse = new Map<string, number>();
let useCounter = 0;
let trimTimer: ReturnType<typeof setTimeout> | null = null;
/** The loads of unloaded chats in flight, per chat key, with the owner lifetime they were issued in. */
/**
 * The loads in flight, per chat: concurrent loads of one chat share its read, and a reset of the
 * character's chats (`chatOwnerToken`) ends the load with nothing.
 */
const loading = new Map<string, { lifetime: string; promise: Promise<DeepReadonly<Chat> | undefined> }>();
/** How many times a load reads a chat again when the server answers older than the held revision. */
const MAX_LOAD_READS = 3;
/** Chats per read request of a load (well inside the server's per-request cap). */
const LOAD_CHUNK = 500;
/**
 * One read request of a load (`deadlineChatRead`) aborts after this and rejects with `chatLoadTimedOut`;
 * the shared load drops, so the next request reads again.
 */
const CHAT_READ_DEADLINE_MS = 60_000;

/**
 * Per character, the lifetime of its held chats: advanced whenever they are installed, forgotten, or
 * replaced by the boot assembly. A load fenced on it never applies across a reset of its owner.
 */
const lifetimes = new Map<string, number>();
let lifetimeCounter = 0;
/** Advanced by every boot assembly, which replaces every character's held chats at once. */
let assemblyEpoch = 0;

function renewLifetime(chaId: string) {
    lifetimeCounter += 1;
    lifetimes.set(chaId, lifetimeCounter);
}

function lifetimeOf(chaId: string): string {
    return `${assemblyEpoch}/${lifetimes.get(chaId) ?? 0}`;
}

/**
 * A token of the current lifetime of a character's held chats: it changes when they are installed
 * (an add or a replacement), forgotten, or replaced by a boot assembly. An operation that captures it
 * before an await and finds it changed afterwards works on another owner, even under the same ids.
 */
export function chatOwnerToken(chaId: string): string {
    return lifetimeOf(chaId);
}

export type ChatJournalKey = { scope: "chat" | "order"; target: string };
type JournalProjection =
    | { scope: "chat"; target: string; layers: Partial<ChatLayerValues>; splitGroupId?: string }
    | { scope: "order"; target: string; layers: Partial<OrderLayerValues> };
type LayerCache<T> = {
    generations: Partial<Record<keyof T, number>>;
    projected: Partial<Record<keyof T, number>>;
    layers: Partial<T>;
};
const journalChats = new Map<string, LayerCache<ChatLayerValues>>();
const journalOrders = new Map<string, LayerCache<OrderLayerValues>>();
let journalListener: ((key: ChatJournalKey) => void) | null = null;
let conflictListener: ((projection: JournalProjection) => void) | null = null;
const createSnapshots = new WeakMap<Chat, { version: number; value: Chat }>();

function dirtyLayer<T>(views: Map<string, LayerCache<T>>, target: string, layer: keyof T) {
    let view = views.get(target);
    if (!view) {
        view = { generations: {}, projected: {}, layers: {} };
        views.set(target, view);
    }
    view.generations[layer] = (view.generations[layer] ?? 0) + 1;
}

function dirtyChatJournal(key: string, layer: keyof ChatLayerValues) {
    const [chaId, chatId] = key.split("\u0000");
    if (
        !journalChats.has(key) &&
        !pending.has(key) &&
        !inflight.has(key) &&
        !quarantined.has(key) &&
        !parkedResends.get(chaId)?.has(key)
    )
        return;
    dirtyLayer(journalChats, key, layer);
    journalListener?.({ scope: "chat", target: chatTarget(chaId, chatId) });
}

function dirtyOrderJournal(chaId: string, layer: keyof OrderLayerValues) {
    if (
        !journalOrders.has(chaId) &&
        !pendingOrders.has(chaId) &&
        !inflightOrders.has(chaId) &&
        !recoveringOrders.has(chaId) &&
        !quarantinedOrders.has(chaId)
    )
        return;
    dirtyLayer(journalOrders, chaId, layer);
    journalListener?.({ scope: "order", target: orderTarget(chaId) });
}

function projectedLayer<T, K extends keyof T>(view: LayerCache<T>, name: K, project: () => T[K] | undefined) {
    const generation = view.generations[name] ?? 0;
    if (view.projected[name] !== generation) {
        view.layers[name] = project();
        view.projected[name] = generation;
    }
}

function queuedChatLayer(key: string): ChatLayerValues["pending"] | undefined {
    const entry = pending.get(key);
    if (!entry || (!entry.create && entry.ops.length === 0)) return;
    const ops = journalOps(entry.ops);
    let createSnapshot: Chat | undefined;
    if (entry.create) {
        const chat = heldChat({ chaId: entry.characterId, chatId: entry.chatId });
        if (chat) {
            const version = versions.get(key) ?? 0;
            let cached = createSnapshots.get(chat);
            if (!cached || cached.version !== version) {
                cached = { version, value: sendChat(chat) };
                createSnapshots.set(chat, cached);
            }
            createSnapshot = cached.value;
        }
    }
    return {
        ops,
        baseRevision: chatRevisions.get(key) ?? null,
        groupId: entry.groupId,
        ...(createSnapshot ? { createSnapshot } : {}),
        ...(entry.ops.some((op) => op.op === "delete") ? { delete: true } : {}),
    };
}

/** Take the WeakMap sidecar before cloning the original operation objects. */
function journalOps(ops: readonly ChatOp[]): JournalChatOp[] {
    return clone(ops.map((op) => ({ op, ...(beforeValues.has(op) ? { before: beforeValues.get(op) } : {}) })));
}

function resendLayer(group: Resend | SentChatGroup): ChatLayerValues["resend"] {
    return clone({
        ops: group.ops,
        baseRevision: group.baseRevision,
        groupId: group.groupId,
        seq: group.seq,
        inDoubt: !!group.inDoubt,
    });
}

/**
 * Capture only abandoned work, while its mirror and operation sidecars still exist. Conflict
 * replacement, gone/locally deleted chats, deferred reloads and collection removals reach here
 * before accepting the server copy. Pending befores, conflicted/in-flight/parked resends and refused
 * intent must survive that replacement. On parent removal or a lost same-id create, forgetCharacter
 * calls this for chat work and separately captures order intent through the conflict listener.
 * With fulfilledDelete, this capture omits delete operations already fulfilled by the parent removal.
 */
function captureChatConflict(
    key: string,
    options: { group?: SentChatGroup; gone?: boolean; fulfilledDelete?: boolean } = {},
) {
    if (!conflictListener) return;
    const [chaId, chatId] = key.split("\u0000");
    const entry = pending.get(key);
    const refusal = quarantined.get(key);
    const groups = [
        ...new Map(
            [options.group, inflight.get(key), entry?.resend, parkedResends.get(chaId)?.get(key)?.resend]
                .filter((group) => group != null)
                .map((group) => [group.groupId, group]),
        ).values(),
    ];
    const keep = (op: ChatOp) => !options.fulfilledDelete || op.op !== "delete";
    const layers: Partial<ChatLayerValues> = {};
    for (const group of groups) {
        const ops = group.ops.filter(keep);
        if (!ops.length) continue;
        if (layers.resend) conflictListener({ scope: "chat", target: key, layers: { resend: layers.resend } });
        layers.resend = resendLayer({ ...group, ops });
    }
    const queued = queuedChatLayer(key);
    if (queued) {
        queued.ops = queued.ops.filter(({ op }) => keep(op));
        if (options.fulfilledDelete) delete queued.delete;
        if (queued.ops.length || queued.createSnapshot) layers.pending = queued;
    }
    if (refusal) {
        const ops = refusal.ops.filter(keep);
        if (ops.length || refusal.create)
            layers.refused = clone({ ...refusal, ops, delete: !options.fulfilledDelete && refusal.delete });
    }
    if (!Object.keys(layers).length) return;
    // Recovered resends are not installed in the mirror. A loaded server copy cannot stand in for
    // their final local transcript; those gone chats retain operations for Export only.
    const mirrorHoldsIntent = !groups.some((group) => group.recoveredAt !== undefined) && !refusal?.recovered;
    if (options.gone && !mirrorHoldsIntent && layers.pending) delete layers.pending.createSnapshot;
    if (options.gone && mirrorHoldsIntent) {
        const chat = heldChat({ chaId, chatId });
        if (chat)
            layers.pending = {
                ...(layers.pending ?? {
                    ops: [],
                    baseRevision: chatRevisions.get(key) ?? null,
                    groupId: entry?.groupId ?? groups[0]?.groupId ?? uuidv4(),
                }),
                createSnapshot: sendChat(chat),
            };
    }
    conflictListener({ scope: "chat", target: key, layers });
}

function captureQueuedOrder(chaId: string) {
    if (!conflictListener) return;
    const refused = quarantinedOrders.get(chaId);
    const layers: Partial<OrderLayerValues> = refused
        ? { refused: { ids: JSON.parse(refused.ids), reason: refused.reason } }
        : pendingOrders.has(chaId)
          ? { latest: { baseRevision: orderRevisions.get(chaId) ?? null, ids: [...memberIds(chaId)] } }
          : {};
    if (Object.keys(layers).length) conflictListener({ scope: "order", target: orderTarget(chaId), layers });
}

function captureSentOrder(order: SentChatOrder | undefined) {
    if (order)
        conflictListener?.({
            scope: "order",
            target: orderTarget(order.characterId),
            layers: { sent: { baseRevision: order.baseRevision, ids: [...order.ids] } },
        });
}

/**
 * Detached, cached journal layers owned by the chat module. Subscription includes work queued
 * before the adapter starts. Projection never takes work, clears a refusal, or changes the mirror.
 * A chat projects resend (exact ops/base/groupId/sequence/doubt), pending (real unsent ops and their
 * befores, held base, batch id, optional create snapshot/delete), and refused intent; an empty pending
 * shell is not intent. Each pending batch mints its groupId before journaling, shared by normal
 * dispatch and whole-batch keepalive so the server remembers the journaled identity.
 * Orders project in-flight/recovering sent, pending latest except the identical quarantined vector,
 * and refused. A lost order answer returns to the current pending vector, never an exact resend.
 * Create snapshots are reused until mirror content changes; a pending edit does not clone an
 * unchanged resend. Taken groups/orders must be projected after oversized groups are quarantined,
 * before dispatch; order rebases dirty sent again. Acks, Retry, refusal, discard, conflict repair,
 * collection acceptance and base changes must invalidate layers even without another local edit.
 * src/ts/storage/resourceSync.svelte.ts consumes these projections; it alone writes mutation rows.
 */
export const chatJournal = {
    /**
     * Receives only discarded intent for src/ts/storage/resourceSync.svelte.ts to queue as drafts.
     * Generating refusals capture only removed locked-message ops. Orders capture the discarded
     * sent/latest/refused vector (including acknowledgement rebase and keepPendingOrder losses),
     * never a surviving newer reorder; superseded parked groups are captured as resend. Explicit
     * discardRefused omits the user's chosen discard but still captures collateral losses.
     */
    setConflictListener(listener: ((projection: JournalProjection) => void) | null) {
        conflictListener = listener;
    },
    setListener(listener: ((key: ChatJournalKey) => void) | null) {
        journalListener = listener;
        if (listener) {
            for (const target of journalChats.keys()) listener({ scope: "chat", target });
            for (const target of journalOrders.keys()) listener({ scope: "order", target });
        }
    },
    project({ scope, target }: ChatJournalKey): JournalProjection {
        if (scope === "chat") {
            const view = journalChats.get(target);
            if (!view) return { scope, target, layers: {} };
            const [chaId] = target.split("\u0000");
            const resend =
                inflight.get(target) ?? pending.get(target)?.resend ?? parkedResends.get(chaId)?.get(target)?.resend;
            projectedLayer(view, "resend", () =>
                resend
                    ? clone({
                          ops: resend.ops,
                          baseRevision: resend.baseRevision,
                          groupId: resend.groupId,
                          seq: resend.seq,
                          inDoubt: !!resend.inDoubt,
                      })
                    : undefined,
            );
            projectedLayer(view, "pending", () => queuedChatLayer(target));
            projectedLayer(view, "refused", () => {
                const refused = quarantined.get(target);
                return refused ? clone(refused) : undefined;
            });
            return {
                scope,
                target,
                layers: { ...view.layers },
                ...(resend && "unconfirmed" in resend && resend.unconfirmed ? { splitGroupId: resend.groupId } : {}),
            };
        }
        const view = journalOrders.get(target);
        if (!view) return { scope, target, layers: {} };
        projectedLayer(view, "sent", () => {
            const sent = inflightOrders.get(target) ?? recoveringOrders.get(target);
            return sent ? { baseRevision: sent.baseRevision, ids: [...sent.ids] } : undefined;
        });
        projectedLayer(view, "latest", () =>
            pendingOrders.has(target) && quarantinedOrders.get(target)?.ids !== sendableOrderText(target)
                ? { baseRevision: orderRevisions.get(target) ?? null, ids: [...memberIds(target)] }
                : undefined,
        );
        projectedLayer(view, "refused", () => {
            const refused = quarantinedOrders.get(target);
            return refused ? { ids: JSON.parse(refused.ids) as string[], reason: refused.reason } : undefined;
        });
        return { scope, target, layers: { ...view.layers } };
    },
    splitGroupId(target: string): string | undefined {
        const [chaId] = target.split("\u0000");
        const resend = pending.get(target)?.resend ?? parkedResends.get(chaId)?.get(target)?.resend;
        return resend?.unconfirmed ? resend.groupId : undefined;
    },
    confirmSplit(target: string, groupId: string) {
        const [chaId] = target.split("\u0000");
        const resend = pending.get(target)?.resend ?? parkedResends.get(chaId)?.get(target)?.resend;
        if (resend?.unconfirmed && resend.groupId === groupId) {
            delete resend.unconfirmed;
            notifyWork();
        }
    },
};

/** Registers the save loop's wake-up; called when new chat work is queued. */
export function setChatWorkListener(listener: (() => void) | null) {
    workListener = listener;
}

/** Registers a listener for chats replaced by a server copy (another tab or device wrote them). */
export function setRemoteChatListener(listener: ((ref: ChatRef) => void) | null) {
    remoteListener = listener;
}

export type ChatRemoval = { chaId: string; chatId: string | null };
const removalListeners = new Set<(removal: ChatRemoval) => void>();

/** Observes deletions here and on the server; null chatId means every chat of the character. */
export function onChatRemoved(listener: (removal: ChatRemoval) => void): () => void {
    removalListeners.add(listener);
    return () => removalListeners.delete(listener);
}

function notifyRemoval(removal: ChatRemoval) {
    for (const listener of removalListeners) {
        try {
            listener(removal);
        } catch (error) {
            console.warn("[Chat removal]", error);
        }
    }
}

function nextSeq() {
    localSeq += 1;
    return localSeq;
}

/** Records that a chat changed in the mirror (its version, and the drift check's token). */
function changed(key: string) {
    versions.set(key, (versions.get(key) ?? 0) + 1);
    if (pending.get(key)?.create) dirtyChatJournal(key, "pending");
    mutationToken += 1;
}

function notifyWork() {
    workListener?.();
}

function isValidId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 512;
}

/** A detached deep copy; a read-only input comes back mutable (pass `T` explicitly then). */
function clone<T>(value: T | DeepReadonly<T>): T {
    return value === undefined ? (value as T) : (JSON.parse(JSON.stringify(value)) as T);
}

function snapshot<T>(value: T): T {
    return clone($state.snapshot(value) as T);
}

/** A JSON object that is not an array (a map field's value, a patch's fields). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted, for comparing a chat with the server's copy whatever the key order. */
function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, entry: unknown) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
            ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : entry,
    );
}

/** The character with `chaId` (its raw record, untracked; this module only checks it and reads its defaults). */
function findCharacter(chaId: string): AnyCharacter | undefined {
    return characterData().find((entry) => entry?.chaId === chaId) as unknown as AnyCharacter | undefined;
}

function requireCharacter(chaId: string): AnyCharacter {
    const character = findCharacter(chaId);
    if (!character) {
        throw new Error(`No character ${chaId}`);
    }
    return character;
}

/** The held chats of a character, created empty for a write. */
function holdingOf(chaId: string): HeldChats {
    held[slot(chaId)] ??= { ids: [], chats: {}, summaries: {} };
    return held[slot(chaId)];
}

/** The held chats of a character, or undefined when it holds none. */
function holdingAt(chaId: string): HeldChats | undefined {
    return held[slot(chaId)];
}

/** A character's member chat ids in order (a copy; empty when it holds none). */
function memberIds(chaId: string): string[] {
    return [...(holdingAt(chaId)?.ids ?? [])];
}

/** Whether the chat is a member of its character's list. */
function isMember(ref: ChatRef): boolean {
    return holdingAt(ref.chaId)?.ids.includes(ref.chatId) ?? false;
}

/** A character's loaded member chats in order, writable here only (unloaded members are left out). */
function chatsOf(chaId: string): Chat[] {
    const holding = holdingAt(chaId);
    if (!holding) {
        return [];
    }
    return holding.ids.map((id) => holding.chats[slot(id)]).filter((chat): chat is Chat => chat !== undefined);
}

/** A loaded chat, writable (this module only). */
function heldChat(ref: ChatRef): Chat | undefined {
    return holdingAt(ref.chaId)?.chats[slot(ref.chatId)];
}

function dropMessagePositions(key: string) {
    messagePositions.delete(key);
}

function buildMessagePositions(key: string, chat: DeepReadonly<Chat>): Map<string, number> {
    const positions = new Map<string, number>();
    chat.message.forEach((message, position) => positions.set(message.chatId!, position));
    messagePositions.set(key, positions);
    messagePositionBuilds += 1;
    return positions;
}

/** A stale or missing position rebuilds once; a newly built map never rebuilds again in this lookup. */
function positionOf(key: string, chat: DeepReadonly<Chat>, id: string): number {
    messagePositionLookups += 1;
    let positions = messagePositions.get(key);
    const built = positions === undefined;
    positions ??= buildMessagePositions(key, chat);
    let position = positions.get(id);
    if (position !== undefined && chat.message[position]?.chatId === id) {
        return position;
    }
    if (!built) {
        positions = buildMessagePositions(key, chat);
        position = positions.get(id);
        if (position !== undefined && chat.message[position]?.chatId === id) {
            return position;
        }
    }
    return -1;
}

/** Whether a member chat is loaded (its whole chat is held, not only its summary). */
function isLoaded(ref: ChatRef): boolean {
    return heldChat(ref) !== undefined;
}

/** Whether every member chat of a character is loaded (true when it holds none). */
export function chatsLoaded(chaId: string): boolean {
    const holding = holdingAt(chaId);
    return !holding || holding.ids.every((id) => holding.chats[slot(id)] !== undefined);
}

/** Only the final message by position counts, even when an earlier message has a time. */
function lastMessageTime(chat: { message: readonly { time?: unknown }[] }): number | undefined {
    const time = chat.message.at(-1)?.time;
    return typeof time === "number" && Number.isFinite(time) ? time : undefined;
}

/**
 * Summary fields from a chat or summary (`name` "", `fmIndex` -1, `pinned` only when true).
 * Lists omit activity so reading their metadata never subscribes to messages.
 */
function metaOf(
    source: {
        message?: readonly { time?: unknown }[];
        lastMessageAt?: unknown;
        name?: unknown;
        pinned?: unknown;
        folderId?: unknown;
        bindedPersona?: unknown;
        promptPresetId?: unknown;
        modelPresetId?: unknown;
        bindingReview?: unknown;
        fmIndex?: unknown;
    },
    includeActivity = true,
): ChatEntryMeta {
    const meta: ChatEntryMeta = {
        name: typeof source.name === "string" ? source.name : "",
        fmIndex: typeof source.fmIndex === "number" ? source.fmIndex : -1,
    };
    if (includeActivity) {
        const time = source.message !== undefined ? lastMessageTime({ message: source.message }) : source.lastMessageAt;
        if (typeof time === "number" && Number.isFinite(time)) {
            meta.lastMessageAt = time;
        }
    }
    if (typeof source.folderId === "string") {
        meta.folderId = source.folderId;
    }
    if (typeof source.bindedPersona === "string") {
        meta.bindedPersona = source.bindedPersona;
    }
    if (typeof source.promptPresetId === "string") {
        meta.promptPresetId = source.promptPresetId;
    }
    if (typeof source.modelPresetId === "string") {
        meta.modelPresetId = source.modelPresetId;
    }
    if (typeof source.bindingReview === "boolean") {
        meta.bindingReview = source.bindingReview;
    }
    if (source.pinned === true) {
        meta.pinned = true;
    }
    // The translation settings, as the server's summary carries them.
    Object.assign(meta, chatTranslationSummary(source as Record<string, unknown>));
    return meta;
}

/** A member as an entry (loaded or summary), or undefined when it is not a member. */
function entryAt(chaId: string, id: string): ChatEntry | undefined {
    const holding = holdingAt(chaId);
    if (!holding?.ids.includes(id)) {
        return undefined;
    }
    const chat = holding.chats[slot(id)];
    return chat ? { id, chat } : { id, meta: holding.summaries[slot(id)] ?? metaOf({}) };
}

/** Puts a chat into a character's list at `index` (loaded and a member); returns the held copy. */
function insertChat(chaId: string, index: number, chat: Chat): Chat {
    const holding = holdingOf(chaId);
    dropMessagePositions(keyOf(chaId, chat.id!));
    loadedKeys.add(keyOf(chaId, chat.id!));
    holding.chats[slot(chat.id!)] = chat;
    delete holding.summaries[slot(chat.id!)];
    holding.ids.splice(index, 0, chat.id!);
    dirtyOrderJournal(chaId, "latest");
    return holding.chats[slot(chat.id!)];
}

/** Puts a chat into a character's list at `index` as its summary (not loaded). */
function insertSummary(chaId: string, index: number, id: string, meta: ChatEntryMeta) {
    const holding = holdingOf(chaId);
    dropMessagePositions(keyOf(chaId, id));
    loadedKeys.delete(keyOf(chaId, id));
    holding.summaries[slot(id)] = meta;
    delete holding.chats[slot(id)];
    holding.ids.splice(index, 0, id);
    dirtyOrderJournal(chaId, "latest");
}

/** Takes a chat out of a character's list (loaded or not). */
function removeChat(chaId: string, chatId: string) {
    const holding = holdingAt(chaId);
    if (!holding) {
        return;
    }
    const index = holding.ids.indexOf(chatId);
    if (index !== -1) {
        holding.ids.splice(index, 1);
    }
    loadedKeys.delete(keyOf(chaId, chatId));
    dropMessagePositions(keyOf(chaId, chatId));
    delete holding.chats[slot(chatId)];
    delete holding.summaries[slot(chatId)];
    dirtyOrderJournal(chaId, "latest");
    if (pending.get(keyOf(chaId, chatId))?.create) dirtyChatJournal(keyOf(chaId, chatId), "pending");
}

/** Drops everything held for a character (its list, loaded chats, and summaries). */
function dropHeld(chaId: string) {
    for (const id of holdingAt(chaId)?.ids ?? []) {
        loadedKeys.delete(keyOf(chaId, id));
        dropMessagePositions(keyOf(chaId, id));
    }
    delete held[slot(chaId)];
    dirtyOrderJournal(chaId, "latest");
    for (const [key, entry] of pending) {
        if (entry.characterId === chaId && entry.create) dirtyChatJournal(key, "pending");
    }
}

/** Replaces a character's whole list (membership, order, loaded chats, and summaries) with `entries`. */
function setChatList(chaId: string, entries: readonly ChatEntry[]) {
    const holding = holdingOf(chaId);
    for (const id of holding.ids) {
        loadedKeys.delete(keyOf(chaId, id));
        dropMessagePositions(keyOf(chaId, id));
    }
    const chats: Record<string, Chat> = {};
    const summaries: Record<string, ChatEntryMeta> = {};
    for (const entry of entries) {
        dropMessagePositions(keyOf(chaId, entry.id));
        if (entry.chat) {
            chats[slot(entry.id)] = entry.chat;
            loadedKeys.add(keyOf(chaId, entry.id));
        } else {
            summaries[slot(entry.id)] = entry.meta ?? metaOf({});
        }
    }
    holding.chats = chats;
    holding.summaries = summaries;
    holding.ids = entries.map((entry) => entry.id);
    dirtyOrderJournal(chaId, "latest");
    for (const entry of entries) {
        const key = keyOf(chaId, entry.id);
        if (pending.get(key)?.create) dirtyChatJournal(key, "pending");
    }
}

/** Loaded chats as list entries. */
function loadedEntries(chats: readonly Chat[]): ChatEntry[] {
    return chats.map((chat) => ({ id: chat.id!, chat }));
}

/** The loaded chat; read-only (change it through this module). Tracked when read reactively. */
export function findChat(ref: ChatRef): DeepReadonly<Chat> | undefined {
    return heldChat(ref);
}

/** The held row by id, read-only and tracked when read reactively. */
export function heldMessageById(ref: ChatRef, id: string): DeepReadonly<Message> | undefined {
    const chat = heldChat(ref);
    return chat?.message[positionOf(keyOf(ref.chaId, ref.chatId), chat, id)];
}

/** The message's current position in the held chat, or -1 when either is absent. */
export function messagePositionOf(ref: ChatRef, id: string): number {
    const chat = heldChat(ref);
    return chat ? positionOf(keyOf(ref.chaId, ref.chatId), chat, id) : -1;
}

function requireChat(ref: ChatRef): Chat {
    // A write needs the chat's owner in the character list as well (never an orphan's chats).
    const chat = findCharacter(ref.chaId) ? heldChat(ref) : undefined;
    if (!chat) {
        throw new Error(`No chat ${ref.chatId} in character ${ref.chaId}`);
    }
    return chat;
}

/** The ref of a chat of a character. */
export function chatRef(character: { chaId: string }, chat: DeepReadonly<Chat>): ChatRef {
    return { chaId: character.chaId, chatId: chat.id! };
}

/**
 * The selected chat id of a character (this tab): its chosen chat while that is a member, else its
 * first chat; null when it holds none. Reactive; a read never writes the selection.
 */
export function selectedChatId(chaId: string): string | null {
    const holding = holdingAt(chaId);
    if (!holding || holding.ids.length === 0) {
        return null;
    }
    const id = chosen[slot(chaId)];
    return id !== undefined && holding.ids.includes(id) ? id : holding.ids[0];
}

/** The index of a character's selected chat in its list (the facade's `chatPage`); 0 when it holds none. */
export function selectedChatIndex(chaId: string): number {
    const id = selectedChatId(chaId);
    return id === null ? 0 : Math.max(0, holdingAt(chaId)!.ids.indexOf(id));
}

/**
 * The ref of the selected character's selected chat, or null (at home, or before its chats are held).
 * It names the chat also while that chat is still loading (`selectedChat()` is null then).
 */
export function currentChatRef(): ChatRef | null {
    const chaId = selection.characterId;
    const chatId = chaId === null ? null : selectedChatId(chaId);
    return chaId !== null && chatId !== null ? { chaId, chatId } : null;
}

/**
 * The selected character's selected chat, or null at home and while it loads (`selectedChatLoad`);
 * the selected chat is never evicted. Reactive.
 */
export function selectedChat(): DeepReadonly<Chat> | null {
    const ref = currentChatRef();
    return ref === null ? null : (heldChat(ref) ?? null);
}

/**
 * A detached legacy copy of a character for the plugin and hook boundaries: `copy` (a chat-free
 * plain copy) with the character's chats as plain copies in order and `chatPage`, the index of
 * `chatId` when it is listed, else of the selected chat. Every chat must be loaded (the caller pins
 * and awaits `loadChats` first); throws otherwise, so a copy is never missing a chat.
 * Its `lastInteraction` is filled with the derived last-chatted time when positive, for plugins.
 */
export function withChatsCopy<T extends { chaId: string; lastInteraction?: unknown }>(
    copy: T,
    chatId?: string,
): T & { chats: Chat[]; chatPage: number } {
    if (!chatsLoaded(copy.chaId)) {
        throw new Error(`The chats of ${copy.chaId} are not loaded`);
    }
    const chats = clone<Chat[]>($state.snapshot(chatsOf(copy.chaId)) as Chat[]);
    const listed = chatId === undefined ? -1 : chats.findIndex((chat) => chat.id === chatId);
    const lastChatted = characterLastChattedAt(copy.chaId, copy.lastInteraction);
    return {
        ...copy,
        ...(lastChatted > 0 ? { lastInteraction: lastChatted } : {}),
        chats,
        chatPage: listed !== -1 ? listed : selectedChatIndex(copy.chaId),
    };
}

/**
 * A character in the legacy shape the shared CBS evaluator reads: a live
 * record already answers `chats`/`chatPage` (the facade view), any other object with a `chaId` gets
 * a shallow copy carrying the same view: its loaded chats (read-only by contract) and the selected
 * chat's index among them (`compatChatPage`). The shared readers find a chat by its ref's id or as
 * `chats[chatPage]`; an unloaded chat is not found, never another one.
 */
export function withCompatChats<T extends object>(char: T): T & { chats: readonly Chat[]; chatPage: number } {
    const fields = char as { chaId?: unknown; chats?: unknown };
    if (Array.isArray(fields.chats) || typeof fields.chaId !== "string") {
        return char as T & { chats: readonly Chat[]; chatPage: number };
    }
    return { ...char, chats: chatsOf(fields.chaId), chatPage: compatChatPage(fields.chaId) };
}

/** The selected chat's index among a character's loaded chats (the facade view's `chatPage`); -1 when it is not loaded. */
function compatChatPage(chaId: string): number {
    const id = selectedChatId(chaId);
    return id === null ? -1 : chatsOf(chaId).findIndex((chat) => chat.id === id);
}

/** How many chats a character has (its list's length; reactive over the membership only). */
export function chatCount(chaId: string): number {
    return holdingAt(chaId)?.ids.length ?? 0;
}

/**
 * The newest last-message time among a character's chats (reactive). Loaded chats use their own
 * final message, including an undated one; summaries serve unloaded chats only. The frozen legacy
 * value is a fallback only when no chat supplies a finite time, never part of the maximum, and the
 * stored `lastInteraction` is never written or migrated from it (`withChatsCopy` fills a derived copy
 * for plugins).
 */
export function characterLastChattedAt(chaId: string, fallback?: unknown): number {
    const holding = holdingAt(chaId);
    let newest: number | undefined;
    for (const id of holding?.ids ?? []) {
        const chat = holding!.chats[slot(id)];
        const time = chat ? lastMessageTime(chat) : holding!.summaries[slot(id)]?.lastMessageAt;
        if (typeof time === "number" && Number.isFinite(time)) {
            newest = newest === undefined ? time : Math.max(newest, time);
        }
    }
    return newest ?? (typeof fallback === "number" && Number.isFinite(fallback) ? fallback : 0);
}

/** One entry of a character's chat list (`chatList`): what a chat list shows, never a whole chat. */
export type ChatListEntry = { id: string } & Omit<ChatEntryMeta, "lastMessageAt">;

/**
 * A character's chats as list entries, in order (reactive over the listed fields and the
 * membership only, so a streamed message does not recompute it): from the loaded chat, or from the
 * summary of a chat that is not loaded. Includes `pinned` without loading messages. A summary is never a `Chat`.
 */
export function chatList(chaId: string): ChatListEntry[] {
    const holding = holdingAt(chaId);
    if (!holding) {
        return [];
    }
    return holding.ids.map((id) => listEntry(holding, id));
}

/** A member's list entry, loaded or not, or undefined when it is not a member (reactive like `chatList`). */
export function chatEntry(ref: ChatRef): ChatListEntry | undefined {
    const holding = holdingAt(ref.chaId);
    return holding?.ids.includes(ref.chatId) ? listEntry(holding, ref.chatId) : undefined;
}

/**
 * How many member chats of every held character pass `test`, each by its list entry (loaded or
 * summary). Untracked: a snapshot for a confirmation, not a live count.
 */
export function countChatEntries(test: (entry: ChatListEntry) => boolean): number {
    return untrack(() => {
        let count = 0;
        for (const holding of Object.values(held)) {
            for (const id of holding.ids) {
                if (test(listEntry(holding, id))) {
                    count += 1;
                }
            }
        }
        return count;
    });
}

function listEntry(holding: HeldChats, id: string): ChatListEntry {
    const chat = holding.chats[slot(id)];
    // Lists track metadata only; activity readers use `characterLastChattedAt` independently.
    return { id, ...metaOf(chat ?? holding.summaries[slot(id)] ?? {}, false) };
}

/** A chat as the mirror holds it: a plain copy without the client-only streaming flags. */
function projectChat(chat: Chat): Chat {
    const copy = snapshot(chat);
    delete copy.isStreaming;
    delete copy.activeStreamingDisplayOptimizationMode;
    copy.message ??= [];
    return copy;
}

/** Whether a chat field holds a projection: only a read gives it, and no write or journal takes it. */
function isProjection(field: string, value: unknown): boolean {
    return field === "hypaV3Data" && isSealedHypaV3Data(value);
}

/**
 * Whether a stored `value` of a chat field leaves the projection `held` in place: stored data never
 * holds one, and a stored value with no summaries owns nothing (`hypaV3DataHoldsSummaries`), absent or
 * empty alike. A value with summaries, or a read's sealed one, takes over.
 *
 * This rule applies to a job's copy and a patch's `meta` or field changes. Whole reads (`applyRemoteChat`,
 * `installRead`) take the field as answered instead: an absent field cannot preserve an old projection.
 */
function keepsProjection(field: string, held: unknown, value: unknown): boolean {
    return isProjection(field, held) && !isSealedHypaV3Data(value) && !hypaV3DataHoldsSummaries(value);
}

/**
 * A whole chat for a stored-data boundary, with any sealed `hypaV3Data` left out. This also guards the
 * recovered create converted to a replacement on refusal retry; its copy can predate the current mirror.
 */
function withoutProjection(chat: Chat): Chat {
    if (!isSealedHypaV3Data(chat.hypaV3Data)) {
        return chat;
    }
    const { hypaV3Data: _projected, ...stored } = chat;
    return stored;
}

/**
 * A chat built from the mirror for a write or journal snapshot: `projectChat` without a projection. Creates,
 * replacements, journal snapshots and retries of refused mirror writes all use this shape.
 * `projectChat` retains the value for `captureChatBaseline`, so a write's diff compares what it read.
 * Recovered resends replay their exact ops without passing through here.
 * `server/src/data/chatStore.ts` also strips sealed fields from writes a stale tab or recovered resend carries.
 */
function sendChat(chat: Chat): Chat {
    return withoutProjection(projectChat(chat));
}

/**
 * Prepares messages the module takes in (owned copies) as the server's `normalizeMessage` stores
 * them: a missing or duplicate id is assigned, and a `translation` that is not a `MessageTranslation`
 * is dropped (`dropInvalidTranslation`), so the mirror holds what the server holds.
 */
function prepareMessages(messages: Message[], taken: Set<string>) {
    for (const message of messages) {
        dropInvalidTranslation(message);
        if (!isValidId(message.chatId) || taken.has(message.chatId)) {
            message.chatId = uuidv4();
        }
        taken.add(message.chatId);
    }
}

function pendingFor(ref: ChatRef, newBatch = false): Pending {
    const key = keyOf(ref.chaId, ref.chatId);
    let entry = pending.get(key);
    if (!entry) {
        entry = {
            characterId: ref.chaId,
            chatId: ref.chatId,
            groupId: uuidv4(),
            create: false,
            resend: null,
            ops: [],
            seq: 0,
        };
        pending.set(key, entry);
    } else if (newBatch) {
        entry.groupId = uuidv4();
    }
    return entry;
}

/** The highest local sequence of a chat's queued or in-flight work. */
function workSeq(key: string): number {
    const entry = pending.get(key);
    return Math.max(entry?.seq ?? 0, entry?.resend?.seq ?? 0, inflight.get(key)?.seq ?? 0);
}

/**
 * Local metadata stays off the wire and follows copied ops through clones, reanchoring and
 * message-id acknowledgements. Coalescing retains the first before value or absence per touched
 * field, as defined by src/ts/storage/draftJournal.ts JournalBefore/JournalChatOp.
 */
const beforeValues = new WeakMap<ChatOp, JournalBefore>();

function fieldsBefore(target: object, fields: Iterable<string>): JournalBefore {
    const values = target as Record<string, unknown>;
    // A projection is left out: what an op overwrites on the server is no field at all.
    return {
        value: clone(
            Object.fromEntries(
                [...fields]
                    .filter((key) => Object.hasOwn(values, key) && !isProjection(key, values[key]))
                    .map((key) => [key, values[key]]),
            ),
        ),
    };
}

function touchedFields(op: ChatOp): string[] {
    if (op.op === "setText") return ["data"];
    if (op.op === "patchMessage" || op.op === "meta") {
        return [
            ...Object.keys(op.set ?? {}),
            ...(op.unset ?? []),
            ...(op.op === "meta" ? [...Object.keys(op.merge ?? {}), ...Object.keys(op.mergeUnset ?? {})] : []),
        ];
    }
    return [];
}

function coalescedBefore(last: ChatOp, next: ChatOp): JournalBefore | undefined {
    const before = beforeValues.get(last);
    const later = beforeValues.get(next);
    if (
        (last.op !== "patchMessage" && last.op !== "meta") ||
        !before ||
        !("value" in before) ||
        !later ||
        !("value" in later)
    )
        return before;
    const touched = new Set(touchedFields(last));
    const values = next.op === "setText" ? { data: later.value } : (later.value as Record<string, unknown>);
    return {
        value: {
            ...(before.value as object),
            ...Object.fromEntries(
                touchedFields(next)
                    .filter((key) => !touched.has(key) && Object.hasOwn(values, key))
                    .map((key) => [key, values[key]]),
            ),
        },
    };
}

function copyOpBefore<T extends ChatOp>(source: ChatOp, copy: T): T {
    const before = beforeValues.get(source);
    if (before) beforeValues.set(copy, clone<JournalBefore>(before));
    return copy;
}

/** Queues an explicit local edit after its mirror write, releasing any refused intent first. */
function enqueueLocalEdit(ref: ChatRef, op: ChatOp, before?: JournalBefore) {
    if (before) beforeValues.set(op, before);
    if (releaseChatRefusal(ref) === "snapshot") {
        // The replacement/create already includes this edit, including an append's new ids.
        notifyWork();
        return;
    }
    const entry = pendingFor(ref);
    entry.seq = nextSeq();
    const last = entry.ops[entry.ops.length - 1];
    // Capture the touched-field union before coalesce changes the earlier op.
    const mergedBefore = last ? coalescedBefore(last, op) : undefined;
    if (last && coalesce(last, op)) {
        if (mergedBefore) beforeValues.set(last, mergedBefore);
    } else {
        entry.ops.push(op);
    }
    dirtyChatJournal(keyOf(ref.chaId, ref.chatId), "pending");
    notifyWork();
}

/** Folds `next` into `last` (both unsent, consecutive) when the result is the same; returns whether it did. */
function coalesce(last: ChatOp, next: ChatOp): boolean {
    if (last.op === "setText" && next.op === "setText" && !last.generation && !next.generation && last.id === next.id) {
        last.text = next.text;
        return true;
    }
    if (
        last.op === "setMessage" &&
        next.op === "setText" &&
        !last.generation &&
        !next.generation &&
        last.message.chatId === next.id
    ) {
        last.message = { ...last.message, data: next.text };
        return true;
    }
    if (
        last.op === "setMessage" &&
        next.op === "setMessage" &&
        !last.generation &&
        !next.generation &&
        last.message.chatId === next.message.chatId
    ) {
        last.message = next.message;
        return true;
    }
    // A field patch (never a generation write) folds only with writes that carry no generation; a
    // `setText` before a patch, or a `setMessage` after one, stays a separate op.
    if (last.op === "patchMessage" && next.op === "patchMessage" && last.id === next.id) {
        const set: Record<string, unknown> = { ...(last.set ?? {}) };
        const unset = new Set<string>(last.unset ?? []);
        for (const key of next.unset ?? []) {
            delete set[key];
            unset.add(key);
        }
        for (const key of Object.keys(next.set ?? {})) {
            unset.delete(key);
            set[key] = (next.set as Record<string, unknown>)[key];
        }
        last.set = set as typeof last.set;
        last.unset = [...unset] as typeof last.unset;
        return true;
    }
    if (last.op === "patchMessage" && next.op === "setText" && !next.generation && last.id === next.id) {
        last.set = { ...(last.set ?? {}), data: next.text };
        return true;
    }
    if (last.op === "setMessage" && next.op === "patchMessage" && !last.generation && last.message.chatId === next.id) {
        const message: Record<string, unknown> = { ...last.message };
        for (const key of next.unset ?? []) {
            delete message[key];
        }
        for (const key of Object.keys(next.set ?? {})) {
            message[key] = (next.set as Record<string, unknown>)[key];
        }
        last.message = message as unknown as Message;
        return true;
    }
    // Entry removals (`mergeUnset`) are not folded: each such op is sent as it was queued. Nor are
    // entries merged into a field an earlier op sets to something that is not a map: the server
    // replaces that value with the entries, a fold would spread it into them.
    if (
        last.op === "meta" &&
        next.op === "meta" &&
        !last.mergeUnset &&
        !next.mergeUnset &&
        Object.keys(next.merge ?? {}).every(
            (key) => !Object.hasOwn(last.set ?? {}, key) || isPlainRecord(last.set![key]),
        )
    ) {
        const set = { ...(last.set ?? {}) };
        const unset = new Set(last.unset ?? []);
        for (const key of next.unset ?? []) {
            delete set[key];
            unset.add(key);
        }
        // A map field's merged entries (`toolCalls`): a later set or unset of the field replaces them;
        // a later merge joins them, or goes into the value an earlier op of this pair sets.
        const merge: Record<string, Record<string, unknown>> = { ...(last.merge ?? {}) };
        for (const key of next.unset ?? []) {
            delete merge[key];
        }
        for (const [key, value] of Object.entries(next.set ?? {})) {
            unset.delete(key);
            delete merge[key];
            set[key] = value;
        }
        for (const [key, entries] of Object.entries(next.merge ?? {})) {
            if (Object.hasOwn(set, key)) {
                set[key] = { ...(set[key] as Record<string, unknown>), ...entries };
            } else if (unset.has(key)) {
                unset.delete(key);
                set[key] = { ...entries };
            } else {
                merge[key] = { ...(merge[key] ?? {}), ...entries };
            }
        }
        last.set = set;
        last.unset = [...unset];
        if (Object.keys(merge).length > 0) {
            last.merge = merge;
        } else {
            delete last.merge;
        }
        return true;
    }
    if (last.op === "append" && next.op === "append" && "end" in last.anchor && "end" in next.anchor) {
        last.messages = [...last.messages, ...next.messages];
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------------------------
// Locks and server generations

/**
 * Whether a message is locked by a server generation job (its edit, delete, and regenerate are off)
 * until the job releases it. Reactive; the chat id is part of the identity: a branched or copied
 * chat keeps its source's message ids, and its copy of the generating message is not locked.
 */
export function isMessageLocked(ref: ChatRef | null, messageId: string | undefined): boolean {
    void lockState.version;
    if (ref === null || messageId === undefined) {
        return false;
    }
    return isLockedKey(messageKeyOf(ref, messageId));
}

/** A message key locked by this tab's job or by a job the change feed announced. */
function isLockedKey(messageKey: string): boolean {
    return serverGenerations.has(messageKey) || feedLocks.has(messageKey);
}

/** The message keys of every lock (this tab's jobs' and the change feed's). */
function lockedKeys(): string[] {
    return [...serverGenerations.keys(), ...feedLocks.keys()];
}

/**
 * Whether a locked message streams (reactive): a chunk of this tab's job reached it, or the change
 * feed announced a stored copy holding one. A reply that arrives whole, and a continue's `accepted`
 * before any text, do not count. Released messages are false.
 */
export function isMessageStreamed(ref: ChatRef | null, messageId: string | undefined): boolean {
    void lockState.version;
    void streamedState.version;
    if (ref === null || messageId === undefined) {
        return false;
    }
    const messageKey = messageKeyOf(ref, messageId);
    return (serverGenerations.get(messageKey)?.seq ?? 0) > 0 || !!feedLocks.get(messageKey)?.streamed;
}

/** The message `ref`'s chat shows as streaming, with its display optimization mode (reactive; null: none). */
export function streamingEntry(ref: ChatRef | null): StreamingEntry | null {
    const entry = ref === null ? undefined : streamingChats[keyOf(ref.chaId, ref.chatId)];
    return entry === undefined ? null : { messageId: entry.messageId, mode: entry.mode };
}

/**
 * Whether the chat screen shows `messageId` of `ref` as the message being generated (reactive, from
 * the chat's `streamingEntry`). The chat id is part of the identity: a branched or copied chat keeps
 * its source's message ids, and its copy of the generating message is not locked.
 */
export function isStreamingMessage(ref: ChatRef | null, messageId: string | undefined): boolean {
    return messageId !== undefined && streamingEntry(ref)?.messageId === messageId;
}

/** Whether any message of a chat is locked (reactive), by this tab's job or one the change feed announced. */
export function isChatGenerating(ref: ChatRef): boolean {
    void lockState.version;
    const prefix = `${keyOf(ref.chaId, ref.chatId)}\u0000`;
    return lockedKeys().some((key) => key.startsWith(prefix));
}

/**
 * Whether a job of this tab streams into a chat (a lock of its job events, not a feed lock): the
 * save loop's reads, patches, and reloads of the chat wait, since they would replace the streamed text.
 */
function isChatStreamedHere(ref: ChatRef): boolean {
    const prefix = `${keyOf(ref.chaId, ref.chatId)}\u0000`;
    return [...serverGenerations.keys()].some((key) => key.startsWith(prefix));
}

/** The distinct chat keys with server generation locks, the change feed's included (reactive). */
export function lockedChatKeys(): ReadonlySet<string> {
    void lockState.version;
    return new Set(lockedKeys().map((key) => key.slice(0, key.lastIndexOf("\u0000"))));
}

/** Whether any chat of a character is locked by this tab's job or the change feed (reactive). */
export function isCharacterGenerating(chaId: string): boolean {
    void lockState.version;
    const prefix = `${chaId}\u0000`;
    return lockedKeys().some((key) => key.startsWith(prefix));
}

/** Whether this tab streams into a character, so its recovery must wait (reactive). */
export function isCharacterStreamedHere(chaId: string): boolean {
    void lockState.version;
    const prefix = `${chaId}\u0000`;
    return [...serverGenerations.keys()].some((key) => key.startsWith(prefix));
}

/** Throws when a server job locks any of these messages. */
function assertUnlocked(ref: ChatRef, messageIds: readonly (string | undefined)[]) {
    for (const id of messageIds) {
        if (id !== undefined && isLockedKey(messageKeyOf(ref, id))) {
            throw new Error("This message is being generated; wait until it finishes");
        }
    }
}

/**
 * Streamed messages whose newest text waits for the next frame: the mirror takes at most one
 * stream update per frame, so the chat screen parses a streaming message once per frame, not once
 * per chunk. The text itself is the message's stream buffer (`serverGenerations`). `hydrateChat` first
 * flushes its chat's held updates and `endServerJob` its job's, so later events apply in order.
 */
const heldStreamText = new Map<string, ChatRef & { messageId: string }>();
/** A frame flush is scheduled: until it runs, a stream update after the first is held. */
let streamFrameScheduled = false;

function scheduleStreamFrame() {
    streamFrameScheduled = true;
    let ran = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
        if (ran) {
            return;
        }
        ran = true;
        clearTimeout(timer);
        streamFrameScheduled = false;
        if (heldStreamText.size > 0) {
            flushStreamText();
            scheduleStreamFrame();
        }
    };
    // A hidden tab (also one hidden after this frame was asked for) runs no frames: the timer, which
    // the browser throttles there, still shows the text. Without frames the timer is the frame.
    const hasFrames = typeof requestAnimationFrame === "function";
    if (hasFrames) {
        requestAnimationFrame(run);
    }
    timer = setTimeout(run, hasFrames ? 250 : 16);
}

/** Writes a streamed message's buffer into the mirror, unless its lock is gone or a copy covers it. */
function showStreamText(target: ChatRef & { messageId: string }) {
    const messageKey = messageKeyOf(target, target.messageId);
    const entry = serverGenerations.get(messageKey);
    if (!entry || entry.seq < 0 || retiredGenerations.has(entry.generationId)) {
        return;
    }
    const mark = serverWatermarks.get(messageKey);
    if (mark && mark.generationId === entry.generationId && entry.seq <= mark.seq) {
        return;
    }
    const chat = heldChat(target);
    const message = chat?.message[positionOf(keyOf(target.chaId, target.chatId), chat, target.messageId)];
    if (message && message.data !== entry.text) {
        message.data = entry.text;
        changed(keyOf(target.chaId, target.chatId));
    }
}

/**
 * Writes the held stream updates `which` selects (all by default) now: before a hydration of their
 * chat or their job's end, which came after them. The others stay held for the frame.
 */
function flushStreamText(which?: (target: ChatRef & { messageId: string }, messageKey: string) => boolean) {
    for (const [messageKey, target] of [...heldStreamText]) {
        if (!which || which(target, messageKey)) {
            heldStreamText.delete(messageKey);
            showStreamText(target);
        }
    }
}

/** Clears the streaming entry `generationId` set (its lock was released); other chats' entries stay. */
function releaseStreaming(generationId: string) {
    for (const [key, entry] of Object.entries(streamingChats)) {
        if (entry.generationId === generationId) {
            delete streamingChats[key];
        }
    }
}

/**
 * Mirrors a server generation job's reply (an `accepted` or `chunk` event): locks the message for
 * the job and writes `text` into the mirror. Nothing is queued and the chat's revision does not
 * move: only stored chat copies or patches advance it. A chunk older than the last one
 * of its generation (`seq`) is dropped. The generation's first stream update makes its message the
 * streaming one of its chat (`streamingEntry`, with the configured display optimization mode). The mirror takes
 * at most one stream update per frame: the generation's first update, and one when no frame flush is
 * pending, are written at once; a later one stays in the stream buffer until the frame flush
 * (`heldStreamText`). Returns false when the chat or message is not in the mirror (its hydration
 * comes first) or the chunk is old.
 */
export function applyServerGeneration(
    ref: ChatRef,
    update: { jobId: string; messageId: string; generationId: string; text: string; seq: number },
): boolean {
    if (retiredGenerations.has(update.generationId)) {
        return false;
    }
    const chat = heldChat(ref);
    const message = chat?.message[positionOf(keyOf(ref.chaId, ref.chatId), chat, update.messageId)];
    if (!message) {
        return false;
    }
    const messageKey = messageKeyOf(ref, update.messageId);
    const existing = serverGenerations.get(messageKey);
    if (existing && existing.generationId !== update.generationId) {
        // A new generation of the message (a continue): the previous one's late events are dropped.
        retiredGenerations.add(existing.generationId);
    } else if (existing && update.seq <= existing.seq) {
        return false;
    }
    // A placeholder lock from the job's chat event (sequence -1) has had no stream update yet.
    const firstUpdate = !existing || existing.generationId !== update.generationId || existing.seq < 0;
    // The stored copy may already hold this text or a later one (a processed checkpoint).
    const mark = serverWatermarks.get(messageKey);
    const older = mark?.generationId === update.generationId && update.seq <= mark.seq;
    serverGenerations.set(messageKey, {
        jobId: update.jobId,
        generationId: update.generationId,
        seq: update.seq,
        // The stream buffer always holds the newest chunk, shown or not (a lower claim later shows it).
        text: update.text,
    });
    if (!existing) {
        lockState.version += 1;
    }
    if (update.seq > 0 && !(existing?.generationId === update.generationId && existing.seq > 0)) {
        streamedState.version += 1;
    }
    if (firstUpdate) {
        streamingChats[keyOf(ref.chaId, ref.chatId)] = {
            messageId: update.messageId,
            mode: settings.ui.streamingDisplayOptimizationMode ?? "off",
            generationId: update.generationId,
        };
    }
    if (older) {
        return false;
    }
    if (streamFrameScheduled && !firstUpdate) {
        heldStreamText.set(messageKey, { ...ref, messageId: update.messageId });
        return true;
    }
    heldStreamText.delete(messageKey);
    message.data = update.text;
    changed(keyOf(ref.chaId, ref.chatId));
    if (!streamFrameScheduled) {
        scheduleStreamFrame();
    }
    return true;
}

/**
 * Reconstructs a wire chunk from the stream buffer, including text held for the next frame or
 * hidden by a stored checkpoint. False asks for the current reply only; retired generations and
 * messages not yet in the mirror drop silently. Applying a reconstructed text can leave the
 * displayed checkpoint in place.
 */
export function applyServerGenerationChunk(ref: ChatRef, jobId: string, chunk: GenerationChunkEvent): boolean {
    if (retiredGenerations.has(chunk.generationId)) {
        return true;
    }
    // A reply-only recovery cannot install a missing message. Wait for the job's chat copy;
    // its placeholder lock will make the next chunk request the full reply once it can apply.
    if (messagePositionOf(ref, chunk.messageId) === -1) {
        return true;
    }
    const held = serverGenerations.get(messageKeyOf(ref, chunk.messageId));
    if (
        !held ||
        held.generationId !== chunk.generationId ||
        held.seq < 0 ||
        held.seq !== chunk.base ||
        !Number.isSafeInteger(chunk.keep) ||
        chunk.keep < 0 ||
        chunk.keep > held.text.length
    ) {
        return false;
    }
    applyServerGeneration(ref, {
        jobId,
        messageId: chunk.messageId,
        generationId: chunk.generationId,
        seq: chunk.seq,
        text: held.text.slice(0, chunk.keep) + chunk.text,
    });
    return true;
}

/**
 * Releases every message a server generation job still locks (its terminal event). The terminal's
 * chat hydration normally released them already; one still locked here may hold streamed text
 * instead of the stored final, so its chat is marked for an idle refresh.
 */
export function endServerJob(jobId: string) {
    flushStreamText((_, messageKey) => serverGenerations.get(messageKey)?.jobId === jobId);
    let released = false;
    for (const [messageKey, entry] of [...serverGenerations]) {
        if (entry.jobId === jobId) {
            serverGenerations.delete(messageKey);
            serverWatermarks.delete(messageKey);
            retiredGenerations.add(entry.generationId);
            releaseStreaming(entry.generationId);
            const [chaId, chatId] = messageKey.split("\u0000");
            if (chatRevisions.has(keyOf(chaId, chatId))) {
                staleChats.add(keyOf(chaId, chatId));
            }
            released = true;
        }
    }
    if (released) {
        lockState.version += 1;
        notifyWork();
    } else if (staleChats.size > 0) {
        // A job that locked nothing (a command job) can still leave its chat stale (a patch that did
        // not fit): its end lets the idle refresh read it.
        notifyWork();
    }
}

/**
 * Marks a chat this client holds to be read whole by the idle refresh (or `refreshStaleChat`),
 * whether or not a job still locks anything in it: a server job's end this tab did not see (a lost
 * or gone follow, a kept outcome). The read applies under the idle refresh's rules (no local work,
 * the epoch and revision fences). False, marking nothing, for a chat the client does not hold.
 */
export function markChatStale(ref: ChatRef): boolean {
    const key = keyOf(ref.chaId, ref.chatId);
    if (!chatRevisions.has(key)) {
        return false;
    }
    staleChats.add(key);
    notifyWork();
    return true;
}

/**
 * The generation locks a change-feed frame announces (`ChatStreaming`: every job's locks of a chat
 * after a job's write or end, `[]` when none is left), so a tab that does not follow the job (an
 * observer, or an owner whose follow was lost) shows the generating reply locked: its edit, delete,
 * and regenerate are off (`isMessageLocked`), and `assertUnlocked` refuses its edits. Each chat's
 * list replaces that chat's feed locks: a message no longer listed, or listed with another
 * generation, is released. The feed socket delivers these full lists in order, independently of
 * this tab's job events. The lock is by message id, so a message or chat the mirror does not hold
 * yet is locked when it arrives. `changes`: the frame's refs, whose revision
 * of the chat is the lock's for reads without snapshots (`dropFeedLocksOf`); none: null. Each named
 * chat advances its feed order even for an empty list, fencing snapshots of already-issued reads.
 * Call after the frame's refs went to the save loop. Nothing is queued, read, or discarded.
 */
export function noteRemoteStreaming(streaming: readonly ChatStreaming[], changes?: ChangeSet) {
    let moved = false;
    for (const chat of streaming) {
        const key = keyOf(chat.characterId, chat.id);
        feedChatOrders.set(key, ++feedLockOrder);
        const revision =
            changes?.chats.find((entry) => entry.characterId === chat.characterId && entry.id === chat.id)?.revision ??
            null;
        moved = replaceChatFeedLocks(key, revision, chat.streaming) || moved;
    }
    if (moved) {
        lockState.version += 1;
    }
}

/** Replaces one chat's locks by id, preserving streamed status only within the same generation. */
function replaceChatFeedLocks(key: string, revision: string | null, streaming: readonly StreamingMessage[]): boolean {
    const prefix = `${key}\u0000`;
    const listed = new Map(streaming.map((entry) => [entry.messageId, entry]));
    let moved = false;
    for (const [messageKey, lock] of feedLocks) {
        if (
            messageKey.startsWith(prefix) &&
            listed.get(messageKey.slice(prefix.length))?.generationId !== lock.generationId
        ) {
            feedLocks.delete(messageKey);
            moved = true;
        }
    }
    for (const [messageId, { generationId, seq }] of listed) {
        const messageKey = `${prefix}${messageId}`;
        const current = feedLocks.get(messageKey);
        const streamed = seq > 0 || (current?.generationId === generationId && current.streamed);
        if (
            current?.generationId !== generationId ||
            current?.revision !== revision ||
            current?.streamed !== streamed
        ) {
            feedLocks.set(messageKey, { generationId, revision, streamed });
            moved = true;
        }
    }
    return moved;
}

/**
 * Replaces the feed's whole lock set with a `hello` snapshot, including chats the mirror does not
 * hold. Every call fences snapshots of already-issued reads, including an empty `hello`. Sampled
 * revisions serve only reads without stamped snapshots. This tab's job stream state is independent.
 */
export function replaceFeedLocks(snapshot: readonly ChatStreamingSnapshot[]) {
    feedHelloOrder = ++feedLockOrder;
    // The global fence now covers every older per-chat list and honored read.
    feedChatOrders.clear();
    feedReadOrders.clear();
    const desired = new Map<string, { generationId: string; revision: string | null; streamed: boolean }>();
    for (const chat of snapshot) {
        for (const { messageId, generationId, seq } of chat.streaming) {
            const messageKey = messageKeyOf({ chaId: chat.characterId, chatId: chat.id }, messageId);
            const current = feedLocks.get(messageKey);
            desired.set(messageKey, {
                generationId,
                revision: chat.revision,
                streamed: seq > 0 || (current?.generationId === generationId && current.streamed),
            });
        }
    }
    let moved = false;
    for (const messageKey of feedLocks.keys()) {
        if (!desired.has(messageKey)) {
            feedLocks.delete(messageKey);
            moved = true;
        }
    }
    for (const [messageKey, lock] of desired) {
        const current = feedLocks.get(messageKey);
        if (
            current?.generationId !== lock.generationId ||
            current?.revision !== lock.revision ||
            current?.streamed !== lock.streamed
        ) {
            feedLocks.set(messageKey, lock);
            moved = true;
        }
    }
    if (moved) {
        lockState.version += 1;
    }
}

/**
 * Releases every feed lock whose message key starts with `prefix` (all of them by default): the
 * chat or character is gone or forgotten. Clears matching per-chat ordering state, even without
 * locks, so forgotten chats do not accumulate. Not retired.
 */
export function releaseFeedLocks(prefix = "") {
    let moved = false;
    for (const messageKey of [...feedLocks.keys()]) {
        if (messageKey.startsWith(prefix)) {
            feedLocks.delete(messageKey);
            moved = true;
        }
    }
    for (const orders of [feedChatOrders, feedReadOrders]) {
        for (const key of orders.keys()) {
            if (`${key}\u0000`.startsWith(prefix)) orders.delete(key);
        }
    }
    if (moved) {
        lockState.version += 1;
    }
}

/**
 * An adopted whole read replaces this chat's feed locks with its snapshot (including `[]`) only
 * when its issue stamp is newer than the chat's latest feed list, the latest `hello`, and its last
 * honored read. A suppressed snapshot leaves locks unchanged. Without a snapshot or issue stamp,
 * the compatibility rule releases locks announced at an older revision (or with none). A gone chat
 * always releases all its locks and ordering state. Nothing retires a generation.
 */
function dropFeedLocksOf(
    key: string,
    revision: string | null,
    streaming?: readonly StreamingMessage[],
    readStamp?: number,
) {
    const prefix = `${key}\u0000`;
    if (revision === null) {
        releaseFeedLocks(prefix);
        return;
    }
    if (streaming !== undefined && readStamp !== undefined) {
        if (
            readStamp <= feedHelloOrder ||
            readStamp <= (feedChatOrders.get(key) ?? 0) ||
            readStamp <= (feedReadOrders.get(key) ?? 0)
        ) {
            return;
        }
        feedReadOrders.set(key, readStamp);
        if (replaceChatFeedLocks(key, revision, streaming)) {
            lockState.version += 1;
        }
        return;
    }
    let moved = false;
    for (const [messageKey, lock] of [...feedLocks]) {
        if (
            messageKey.startsWith(prefix) &&
            (lock.revision === null || (compareRevision(revision, lock.revision) ?? 1) > 0)
        ) {
            feedLocks.delete(messageKey);
            moved = true;
        }
    }
    if (moved) {
        lockState.version += 1;
    }
}

/**
 * Applies a chat `resource` event of a server job: the server's whole chat replaces the mirror's
 * when its revision is at least the held one and the chat has no local work (pending, in flight,
 * deferred, quarantined, refused for a generating message); otherwise the chat is marked for an
 * idle refresh. A chat the mirror lacks, or one this client has not seen on
 * the server, is not hydrated; a member that is not loaded takes the copy's revision and summary only
 * (a server copy never loads a chat). Nothing is queued, discarded, or settled, and no notice is shown.
 *
 * A copy whose `hypaV3Data` holds no summaries leaves a projection held in place (`keepsProjection`):
 * a job's copy is stored data, which never holds one.
 *
 * `job` (a job's chat event): its `streaming` messages are still generating, each with the newest
 * chunk the copy holds; a streamed text with a higher `seq` is put back on its message, and its lock
 * stays. Every other lock of that job in the chat is released (the reply is final in the copy; if the
 * copy could not be applied for local work, the chat is marked for an idle refresh). Another job's
 * locks and newer streamed text are kept. A copy older than the held revision, or of another epoch,
 * changes nothing, its job metadata included; a copy that could not be applied releases locks but
 * records no watermark. Returns whether it applied.
 */
export function hydrateChat(
    server: { characterId: string; id: string; revision: string; data: Chat },
    job?: { jobId: string; streaming: readonly StreamingMessage[] },
): boolean {
    // The chat's stream updates held for the next frame came before this event.
    flushStreamText((target) => target.chaId === server.characterId && target.chatId === server.id);
    const outcome = applyChatHydration(server);
    if (outcome === "old") {
        return false;
    }
    settleJobHydration(server, outcome, job);
    return outcome === "applied";
}

/**
 * Applies a job's `chatPatch` (`GenerationChatPatchEvent`): the change from `baseRevision` to
 * `revision` of a loaded chat, applied only when the mirror holds exactly one of the two revisions,
 * the chat is not marked stale, and it has no local work. Its messages are the stored rows (each
 * replaces the mirror's message of its id, or is inserted after `after`); every other message keeps
 * its object. Then `job` is handled as for `hydrateChat`. `"busy"`: local work (marked stale, as
 * `hydrateChat`); `"mismatch"`: the mirror cannot take it (marked stale: the caller asks the job for
 * the chat whole); `"old"`: older than the held revision, another epoch, or a chat this client lacks.
 */
export function hydrateChatPatch(
    patch: ChatPatch,
    job?: { jobId: string; streaming: readonly StreamingMessage[] },
): "applied" | "busy" | "mismatch" | "old" {
    flushStreamText((target) => target.chaId === patch.characterId && target.chatId === patch.id);
    const outcome = applyChatPatch(patch);
    if (outcome === "old") {
        return outcome;
    }
    // The locks of a copy that did not apply: as for local work.
    settleJobHydration(patch, outcome === "applied" ? "applied" : "busy", job);
    if (outcome !== "applied") {
        // Marked stale: the save loop runs its idle refresh once the chat is idle (after the job).
        notifyWork();
    }
    return outcome;
}

/** Whether a chat is marked to be read whole (a stale acknowledgement or a hydration that did not apply). */
export function isChatStale(ref: ChatRef): boolean {
    return staleChats.has(keyOf(ref.chaId, ref.chatId));
}

/** Whether the mirror knows a chat is behind the server: marked stale, or a live notice not yet answered. */
export function isChatBehind(ref: ChatRef): boolean {
    dropAnsweredNotices();
    const key = keyOf(ref.chaId, ref.chatId);
    return staleChats.has(key) || noticedChats.has(key);
}

/**
 * What keeps a job's whole chat from applying (`applyChatHydration`): `"saving"` (queued or in-flight
 * work, which a save settles), `"held"` (deferred behind a generation, quarantined, or refused for a
 * generating message: no save settles it), or `"none"`.
 */
export function chatHydrationHold(ref: ChatRef): "none" | "saving" | "held" {
    const key = keyOf(ref.chaId, ref.chatId);
    if (deferred.has(key) || quarantined.has(key) || jobBlocked.has(key)) {
        return "held";
    }
    return pending.has(key) || inflight.has(key) ? "saving" : "none";
}

/**
 * A guard for one callback-barrier read of a chat whose receipt neither the flush nor a remembered
 * job copy made held, at `revision` (the receipt's, or the newer job metadata the read reuses): no
 * copy at all, an older one, or one refused by the acknowledged floor. The chat must be a member
 * with a held revision of the same incarnation (and floor, when one is kept), no local work, and job
 * metadata no newer than `revision`. The guard fences the owner, chat incarnation, and job metadata
 * across the read; admission still goes through `hydrateChat`, which checks local work and the floor
 * again.
 */
export function prepareChatHydrationRefresh(ref: ChatRef, revision: string): ((server: ChatRecord) => boolean) | null {
    const { chaId, chatId } = ref;
    ref = { chaId, chatId };
    const key = keyOf(chaId, chatId);
    const heldRevision = chatRevisions.get(key);
    const held = parseRevisionToken(heldRevision);
    if (!held) {
        return null;
    }
    const sameChat = (token: string | undefined) => {
        const parsed = parseRevisionToken(token);
        return parsed?.epoch === held.epoch && parsed.seq === held.seq;
    };
    const metadata = jobMetadata.get(key);
    const floor = ackedRevisions.get(key);
    if (
        !findCharacter(chaId) ||
        !isMember(ref) ||
        absentChats.has(key) ||
        chatHydrationHold(ref) !== "none" ||
        !sameChat(revision) ||
        (floor !== undefined && !sameChat(floor)) ||
        (compareRevision(revision, heldRevision) ?? -1) < 0 ||
        (metadata && (compareRevision(revision, metadata.revision) ?? -1) < 0)
    ) {
        return null;
    }
    const owner = chatOwnerToken(chaId);
    return (server) =>
        server.characterId === chaId &&
        server.id === chatId &&
        chatOwnerToken(chaId) === owner &&
        !!findCharacter(chaId) &&
        isMember(ref) &&
        !absentChats.has(key) &&
        sameChat(chatRevisions.get(key)) &&
        sameChat(server.revision) &&
        jobMetadata.get(key) === metadata &&
        chatHydrationHold(ref) === "none";
}

/** The body of a job's `chatPatch` (`GenerationChatPatchEvent` without its event fields). */
export type ChatPatch = Omit<ChatPatchBody, "removed" | "messages"> & {
    characterId: string;
    id: string;
    revision: string;
    removed?: readonly string[];
    messages?: Readonly<ChatPatchBody["messages"]>;
};

/**
 * The job-lock part of a chat hydration (`hydrateChat`, `hydrateChatPatch`) after its copy was
 * applied (`applied`: the mirror holds the stored rows of the job's messages) or not (`busy`).
 */
function settleJobHydration(
    server: { characterId: string; id: string; revision: string },
    outcome: "applied" | "busy",
    job?: { jobId: string; streaming: readonly StreamingMessage[] },
) {
    const key = keyOf(server.characterId, server.id);
    const prefix = `${key}\u0000`;
    let released = false;
    let locked = false;
    const metadataHeld = jobMetadata.get(key);
    const metadataCurrent = !metadataHeld || (compareRevision(server.revision, metadataHeld.revision) ?? -1) >= 0;
    if (job && metadataCurrent) {
        jobMetadata.set(key, { revision: server.revision });
        const streaming = new Map(job.streaming.map((entry) => [entry.messageId, entry]));
        for (const [messageKey, entry] of [...serverGenerations]) {
            if (!messageKey.startsWith(prefix) || entry.jobId !== job.jobId) {
                continue;
            }
            const still = streaming.get(messageKey.slice(prefix.length));
            if (!still || still.generationId !== entry.generationId) {
                serverGenerations.delete(messageKey);
                serverWatermarks.delete(messageKey);
                retiredGenerations.add(entry.generationId);
                releaseStreaming(entry.generationId);
                released = true;
            }
        }
        for (const entry of job.streaming) {
            const messageKey = `${prefix}${entry.messageId}`;
            const holder = serverGenerations.get(messageKey);
            if (holder && holder.generationId !== entry.generationId) {
                // The server says this generation owns the message now: an older owner is gone.
                serverGenerations.delete(messageKey);
                retiredGenerations.add(holder.generationId);
                releaseStreaming(holder.generationId);
                released = true;
            }
            if (outcome === "applied") {
                // Only a copy in the mirror holds those chunks.
                serverWatermarks.set(messageKey, { generationId: entry.generationId, seq: entry.seq });
            }
            // The job's chat event can come before its `accepted`/`chunk` (a reply appended with
            // `begin`): the message is locked from here, so it is not rendered (or edited) as a
            // finished message before its stream starts. No stream update was received yet: the
            // sequence is below every protocol sequence (the first `accepted`/`chunk` fills the raw
            // buffer whatever its claim; the watermark above keeps a covering copy shown), and the
            // buffer starts as the mirror's text.
            const chat = heldChat({ chaId: server.characterId, chatId: server.id });
            const message = chat?.message[positionOf(key, chat, entry.messageId)];
            if (
                message &&
                serverGenerations.get(messageKey)?.generationId !== entry.generationId &&
                !retiredGenerations.has(entry.generationId)
            ) {
                serverGenerations.set(messageKey, {
                    jobId: job.jobId,
                    generationId: entry.generationId,
                    seq: -1,
                    text: message.data,
                });
                locked = true;
            }
        }
    }
    if (outcome === "applied") {
        for (const [messageKey, entry] of serverGenerations) {
            if (!messageKey.startsWith(prefix)) {
                continue;
            }
            const mark = serverWatermarks.get(messageKey);
            if (mark && mark.generationId === entry.generationId && entry.seq <= mark.seq) {
                // The copy holds this text or a later one; the stream buffer is kept for a lower claim.
                continue;
            }
            const chat = heldChat({ chaId: server.characterId, chatId: server.id });
            const message = chat?.message[positionOf(key, chat, messageKey.slice(prefix.length))];
            if (message) {
                message.data = entry.text;
            }
        }
    }
    if (locked && !released) {
        lockState.version += 1;
    }
    if (released) {
        lockState.version += 1;
        if (outcome === "busy" && chatRevisions.has(key)) {
            staleChats.add(key);
        }
        notifyWork();
    }
}

/**
 * "applied" (a loaded chat replaced, or an unloaded member's summary and revision taken); "busy"
 * (current, but local work keeps the mirror's copy: marked stale); "old" (older, another epoch, or unknown).
 */
function applyChatHydration(server: {
    characterId: string;
    id: string;
    revision: string;
    data: Chat;
}): "applied" | "busy" | "old" {
    const key = keyOf(server.characterId, server.id);
    const ref = { chaId: server.characterId, chatId: server.id };
    const character = findCharacter(server.characterId);
    const heldRevision = chatRevisions.get(key);
    if (!character || !isMember(ref) || heldRevision === undefined) {
        return "old";
    }
    const order = compareRevision(server.revision, heldRevision);
    if (order === null || order < 0) {
        return "old";
    }
    if (
        pending.has(key) ||
        inflight.has(key) ||
        deferred.has(key) ||
        quarantined.has(key) ||
        jobBlocked.has(key) ||
        // Older than an acknowledgement of this client's edit: the copy lacks it (`ackedRevisions`).
        belowAckedRevision(key, server.revision)
    ) {
        staleChats.add(key);
        return "busy";
    }
    if (isLoaded(ref)) {
        const copy = clone<Chat>(server.data);
        const heldData = heldChat(ref)?.hypaV3Data;
        if (keepsProjection("hypaV3Data", heldData, copy.hypaV3Data)) {
            copy.hypaV3Data = heldData;
        }
        dropMessagePositions(key);
        holdingOf(server.characterId).chats[slot(server.id)] = copy;
    } else {
        holdingOf(server.characterId).summaries[slot(server.id)] = metaOf(server.data);
    }
    holdChatRevision(key, server.revision);
    staleChats.delete(key);
    changed(key);
    if (heldRevision !== server.revision) {
        recordChatInstall(key);
    }
    remoteListener?.(ref);
    return "applied";
}

/**
 * `hydrateChatPatch`'s copy step. A patch is a diff of two stored states, so it fits a mirror that
 * holds exactly its base revision or its revision (its rows are their values at `revision`, which a
 * mirror already at `revision` holds too). Another held revision of the same incarnation (the
 * mirror missed changes), a held revision of an older incarnation, a chat marked stale or not
 * loaded, or a patch whose messages do not fit the mirror's is a mismatch. Nothing changes before
 * the whole result is checked.
 */
function applyChatPatch(patch: ChatPatch): "applied" | "busy" | "mismatch" | "old" {
    const key = keyOf(patch.characterId, patch.id);
    const ref = { chaId: patch.characterId, chatId: patch.id };
    const heldRevision = chatRevisions.get(key);
    if (!findCharacter(patch.characterId) || !isMember(ref) || heldRevision === undefined) {
        return "old";
    }
    const held = parseRevisionToken(heldRevision);
    const base = parseRevisionToken(patch.baseRevision);
    const next = parseRevisionToken(patch.revision);
    if (
        !held ||
        !base ||
        !next ||
        base.epoch !== next.epoch ||
        held.epoch !== next.epoch ||
        base.seq !== next.seq ||
        base.revision > next.revision
    ) {
        return "old";
    }
    if (held.seq > next.seq || (held.seq === next.seq && held.revision > next.revision)) {
        return "old";
    }
    if (
        pending.has(key) ||
        inflight.has(key) ||
        deferred.has(key) ||
        quarantined.has(key) ||
        jobBlocked.has(key) ||
        belowAckedRevision(key, patch.revision)
    ) {
        staleChats.add(key);
        return "busy";
    }
    const fits = held.seq === next.seq && (held.revision === base.revision || held.revision === next.revision);
    const chat = isLoaded(ref) ? heldChat(ref) : undefined;
    let patched: { start: number; tail: Message[] } | null = null;
    try {
        patched = fits && chat && !staleChats.has(key) ? patchedTail(chat.message, patch) : null;
    } catch (error) {
        // Anything unexpected in a server copy: read whole instead of failing the event.
        console.error("[Save]", error);
    }
    if (!chat || !patched) {
        staleChats.add(key);
        return "mismatch";
    }
    staleChats.delete(key);
    installChatPatch(chat, patch, patched);
    return "applied";
}

/**
 * A feed delta's metadata change (`ChatMetaFields`) checked and prepared against a loaded chat at the
 * delta's base, before anything changes: the fields to remove, and the fields to set with their new
 * values (a merged map whole). Null when it is not well formed (a field named twice, `message`, or
 * `__proto__`) or does not fit the held copy (a merge into a field the chat does not hold as a
 * map). Set values and merged entries are owned copies; the entries a merge keeps are the mirror's
 * own. A map is built from entries (never assigned by name, never through `$state.snapshot`), so an
 * entry named `__proto__` stays an own entry. The result equals the stored metadata as JSON values,
 * not necessarily in key order.
 */
function stagedMetaFields(chat: Chat, fields: unknown): { remove: string[]; set: [string, unknown][] } | null {
    if (!isPlainRecord(fields)) {
        return null;
    }
    const set = Object.hasOwn(fields, "set") ? fields.set : undefined;
    const remove = Object.hasOwn(fields, "remove") ? fields.remove : undefined;
    const merge = Object.hasOwn(fields, "merge") ? fields.merge : {};
    const mergeUnset = Object.hasOwn(fields, "mergeUnset") ? fields.mergeUnset : {};
    if (!isPlainRecord(set) || !Array.isArray(remove) || !isPlainRecord(merge) || !isPlainRecord(mergeUnset)) {
        return null;
    }
    const named = new Set<string>();
    /**
     * Whether `field` may change: a string, not named before, other than `message` and `__proto__`
     * (stored metadata never has that as its own field; assigning it would replace the prototype).
     */
    const fresh = (field: unknown): field is string => {
        if (typeof field !== "string" || field === "message" || field === "__proto__" || named.has(field)) {
            return false;
        }
        named.add(field);
        return true;
    };
    const staged: { remove: string[]; set: [string, unknown][] } = { remove: [], set: [] };
    for (const field of remove as unknown[]) {
        if (!fresh(field)) {
            return null;
        }
        staged.remove.push(field);
    }
    for (const field of Object.keys(set)) {
        if (!fresh(field)) {
            return null;
        }
        staged.set.push([field, clone(set[field])]);
    }
    const held = chat as unknown as Record<string, unknown>;
    for (const field of new Set([...Object.keys(mergeUnset), ...Object.keys(merge)])) {
        const removals: unknown = Object.hasOwn(mergeUnset, field) ? mergeUnset[field] : [];
        const entries: unknown = Object.hasOwn(merge, field) ? merge[field] : {};
        const current = Object.hasOwn(held, field) ? held[field] : undefined;
        if (
            !fresh(field) ||
            !Array.isArray(removals) ||
            !removals.every((id) => typeof id === "string") ||
            !isPlainRecord(entries) ||
            !isPlainRecord(current)
        ) {
            return null;
        }
        // The removals first, then the entries, as the server merged them.
        const dropped = new Set<string>(removals);
        const kept = Object.entries(current).filter(([id]) => !dropped.has(id));
        staged.set.push([field, Object.fromEntries([...kept, ...Object.entries(clone(entries))])]);
    }
    return staged;
}

/**
 * The checked row/meta/revision step shared by job hydration and idle change-feed patches. A whole
 * `meta` replaces the chat's fields; `fields` (a feed delta's, from `stagedMetaFields`) changes only
 * the fields it names.
 */
function installChatPatch(
    chat: Chat,
    patch: ChatPatch,
    patched: { start: number; tail: Message[] },
    fields?: { remove: string[]; set: [string, unknown][] },
) {
    // Only the positions that changed are written (an append writes one; a removal or insertion
    // writes the positions after it), never the whole list as call arguments.
    const { start, tail } = patched;
    dropMessagePositions(keyOf(patch.characterId, patch.id));
    for (let index = 0; index < tail.length; index++) {
        if (chat.message[start + index] !== tail[index]) {
            chat.message[start + index] = tail[index];
        }
    }
    if (chat.message.length !== start + tail.length) {
        chat.message.length = start + tail.length;
    }
    if (patch.meta) {
        // The chat's fields become the stored ones, as a whole copy replaces them, but for a
        // projection held, which stored fields replace only with summaries (`keepsProjection`).
        const fields = chat as unknown as Record<string, unknown>;
        for (const field of Object.keys(fields)) {
            if (
                field !== "message" &&
                !Object.hasOwn(patch.meta, field) &&
                !keepsProjection(field, fields[field], undefined)
            ) {
                delete fields[field];
            }
        }
        for (const [field, value] of Object.entries(patch.meta)) {
            if (field !== "message" && !keepsProjection(field, fields[field], value)) {
                fields[field] = clone(value);
            }
        }
    } else if (fields) {
        const target = chat as unknown as Record<string, unknown>;
        for (const field of fields.remove) {
            if (!keepsProjection(field, target[field], undefined)) {
                delete target[field];
            }
        }
        for (const [field, value] of fields.set) {
            if (!keepsProjection(field, target[field], value)) {
                target[field] = value;
            }
        }
    }
    const key = keyOf(patch.characterId, patch.id);
    const heldRevision = chatRevisions.get(key);
    holdChatRevision(key, patch.revision);
    changed(key);
    if (heldRevision !== patch.revision) {
        recordChatInstall(key);
    }
    remoteListener?.({ chaId: patch.characterId, chatId: patch.id });
}

/**
 * A feed patch or delta is optional: a miss neither marks stale nor touches a job's locks. A delta's
 * metadata fields are checked against the held copy with its rows, before anything changes; one
 * that does not fit is a miss.
 */
function applyRemoteChatPatch(ref: ChatRef, revision: string, body: ChatPatchBody | ChatDeltaBody): boolean {
    const key = keyOf(ref.chaId, ref.chatId);
    if (!isLoaded(ref) || !canRefreshChat(ref) || staleChats.has(key) || chatRevisions.get(key) !== body.baseRevision) {
        return false;
    }
    const base = parseRevisionToken(body.baseRevision);
    const next = parseRevisionToken(revision);
    if (
        !base ||
        !next ||
        base.epoch !== next.epoch ||
        base.seq !== next.seq ||
        next.revision <= base.revision ||
        belowAckedRevision(key, revision)
    ) {
        return false;
    }
    const chat = heldChat(ref);
    if (!chat) {
        return false;
    }
    let change: ChatPatchBody = body;
    let metaFields: ChatMetaFields | undefined;
    if ("metaFields" in body) {
        const { metaFields: fields, ...rest } = body;
        if (Object.hasOwn(rest, "meta")) {
            // The metadata both whole and by field: not a body this client knows.
            return false;
        }
        change = rest;
        metaFields = fields;
    }
    const patch: ChatPatch = { ...change, characterId: ref.chaId, id: ref.chatId, revision };
    let patched: { start: number; tail: Message[] } | null = null;
    let fields: ReturnType<typeof stagedMetaFields> | undefined = null;
    try {
        patched = patchedTail(chat.message, patch);
        fields = metaFields === undefined ? undefined : stagedMetaFields(chat, metaFields);
    } catch (error) {
        console.error("[Save]", error);
    }
    if (!patched || fields === null) {
        return false;
    }
    installChatPatch(chat, patch, patched, fields);
    return true;
}

/**
 * The mirror's messages from `start` on with a patch applied (the messages before `start` stay), or
 * null when it does not fit. Only the end of the list is read: back from the last message to the
 * first one the patch touches (its first row's `after`, or a removed message), since a patch's rows
 * come in stored order and never move a message. Not fitting: no first anchor in the list, a
 * message without an id or with a repeated one in the part read, a null `after` on a row other
 * than the first, a patch row that is not a message,
 * names a removed id, or comes twice, an `after` that is neither a message kept nor an earlier
 * inserted row, a row of an existing message that is not right after its `after`, or a length that
 * is not the patch's `count`. Rows are owned copies of the stored messages; every other message
 * keeps its object. The part before `start` is the held copy at the patch's base, which the patch
 * says is unchanged.
 */
function patchedTail(current: readonly Message[], patch: ChatPatch): { start: number; tail: Message[] } | null {
    const rows = patch.messages ?? [];
    const removed = new Set(patch.removed ?? []);
    if (rows.length === 0 && removed.size === 0) {
        return current.length === patch.count ? { start: current.length, tail: [] } : null;
    }
    if (rows.some((entry, index) => index > 0 && entry.after === null)) {
        // Only the first row of the stored order can be the chat's first message.
        return null;
    }
    // Back from the end to the first row's anchor (the start for a null one) and every removed id
    // the list holds.
    const anchor = rows.length > 0 ? rows[0].after : undefined;
    let start = anchor === null ? 0 : current.length;
    let anchorFound = anchor === undefined || anchor === null;
    let missing = removed.size;
    for (let index = current.length - 1; index >= 0 && (!anchorFound || missing > 0); index--) {
        const id = current[index].chatId;
        if (id === anchor) {
            anchorFound = true;
            start = Math.min(start, index);
        }
        if (typeof id === "string" && removed.has(id)) {
            missing -= 1;
            start = Math.min(start, index);
        }
    }
    if (!anchorFound) {
        return null;
    }
    const tail = patchedMessages(current.slice(start), rows, removed);
    return tail && start + tail.length === patch.count ? { start, tail } : null;
}

/** `patchedTail` on the part read: linear in its length. */
function patchedMessages(
    current: readonly Message[],
    rows: NonNullable<ChatPatch["messages"]>,
    removed: ReadonlySet<string>,
): Message[] | null {
    const seen = new Set<string>();
    const kept: Message[] = [];
    for (const message of current) {
        const id = message.chatId;
        if (typeof id !== "string" || seen.has(id)) {
            return null;
        }
        seen.add(id);
        if (!removed.has(id)) {
            kept.push(message);
        }
    }
    const keptIds = new Set(kept.map((message) => message.chatId!));
    /** Replacement rows of kept messages, with the `after` each must follow. */
    const replaced = new Map<string, { after: string | null; row: Message }>();
    /** Inserted rows by the id they follow (null: the start), in patch order. */
    const inserted = new Map<string | null, Message[]>();
    const placed = new Set<string>();
    for (const entry of rows) {
        const row = entry.message as Message | null;
        const id = row && typeof row === "object" ? row.chatId : undefined;
        if (typeof id !== "string" || removed.has(id) || placed.has(id)) {
            return null;
        }
        if (entry.after !== null && !keptIds.has(entry.after) && !placed.has(entry.after)) {
            // An anchor must be a kept message or a row placed before this one.
            return null;
        }
        placed.add(id);
        if (keptIds.has(id)) {
            replaced.set(id, { after: entry.after, row: clone<Message>(row!) });
        } else {
            const group = inserted.get(entry.after) ?? [];
            group.push(clone<Message>(row!));
            inserted.set(entry.after, group);
        }
    }
    const result: Message[] = [];
    // Each inserted row is followed by the rows anchored on it (iterative, any chain length).
    const emit = (anchor: string | null) => {
        const stack = [...(inserted.get(anchor) ?? [])].reverse();
        while (stack.length > 0) {
            const row = stack.pop()!;
            result.push(row);
            const next = inserted.get(row.chatId!);
            if (next) {
                for (let index = next.length - 1; index >= 0; index--) {
                    stack.push(next[index]);
                }
            }
        }
    };
    emit(null);
    for (const message of kept) {
        result.push(replaced.get(message.chatId!)?.row ?? message);
        emit(message.chatId!);
    }
    const positions = new Map(result.map((message, index) => [message.chatId!, index]));
    if (positions.size !== result.length) {
        return null;
    }
    for (const [id, { after }] of replaced) {
        // A null `after` is the chat's start: only a part read from the start can hold it.
        const expected = after === null ? 0 : (positions.get(after) ?? -2) + 1;
        if (positions.get(id) !== expected) {
            return null;
        }
    }
    return result;
}

/** The chat's revision this client holds (its saved base), or null when it has none (read only). */
export function heldChatRevision(ref: ChatRef): string | null {
    return chatRevisions.get(keyOf(ref.chaId, ref.chatId)) ?? null;
}

/** Whether a chat's work waits because the server refused it for a generating message. */
function isJobBlocked(key: string): boolean {
    const until = jobBlocked.get(key);
    if (until === undefined) {
        return false;
    }
    if (Date.now() >= until) {
        jobBlocked.delete(key);
        return false;
    }
    return true;
}

/** When the earliest chat refused for a generating message may be sent again, or null. */
export function chatJobRetryAt(): number | null {
    let earliest: number | null = null;
    for (const key of [...jobBlocked.keys()]) {
        if (isJobBlocked(key)) {
            const until = jobBlocked.get(key)!;
            earliest = earliest === null ? until : Math.min(earliest, until);
        }
    }
    return earliest;
}

/** Takes an unload request's ops out of the queue and marks its groups in flight (the request was sent). */
export function trackUnloadWork(work: ChatWork) {
    for (const group of work.groups) {
        pending.delete(group.key);
        inflight.set(group.key, group);
    }
}

/**
 * Records the answer to an unload request the page survived to receive (`results` in group order;
 * null: the request failed or was refused, and its ops go back in front of the queue). An answer is
 * an ordinary acknowledgement while the group is still the chat's work in flight. An answer to a
 * group that left it meanwhile changes nothing: its character the server confirmed gone
 * (`retireCharacterGroups`), or its chat's work an authoritative list discarded.
 */
export function settleUnloadWork(work: ChatWork, results: readonly ChatGroupResult[] | null) {
    work.groups.forEach((group, index) => {
        if (inflight.get(group.key)?.groupId !== group.groupId) {
            return;
        }
        const taken = { groups: [group], orders: [] };
        if (results?.[index]) {
            ackChatWork(taken, [results[index]], []);
        } else {
            // The keepalive request may have landed.
            requeueChatWork(taken, { lost: true });
        }
    });
    notifyWork();
}

/**
 * Pending by-id work for existing chats, one request per chat within the remaining shared budget.
 * Only whole eligible batches go: a remembered prefix id must never hide an unsent suffix.
 * Nothing leaves the queue until `trackUnloadWork` confirms the request was sent.
 */
export function unloadPendingChatWork(limitBytes: number): { body: string; work: ChatWork }[] {
    const requests: { body: string; work: ChatWork }[] = [];
    const encoder = new TextEncoder();
    for (const [key, entry] of pending) {
        const base = chatRevisions.get(key);
        if (
            !base ||
            entry.create ||
            entry.resend ||
            inflight.has(key) ||
            deferred.has(key) ||
            quarantined.has(key) ||
            isJobBlocked(key)
        ) {
            continue;
        }
        const ops = entry.ops;
        if (
            ops.length === 0 ||
            ops.length > 5000 ||
            !ops.every(
                (op) =>
                    op.op === "append" ||
                    op.op === "setText" ||
                    op.op === "setMessage" ||
                    op.op === "patchMessage" ||
                    op.op === "setTranslation" ||
                    op.op === "meta" ||
                    (op.op === "remove" && op.ids.length === 1),
            )
        ) {
            continue;
        }
        const group = sentGroup(key, entry, base, ops, entry.groupId);
        const work = { groups: [group], orders: [] };
        const body = `{"chats":[${chatWorkBody(work).chats.join(",")}]}`;
        const bytes = encoder.encode(body).length;
        if (bytes > limitBytes) {
            continue;
        }
        requests.push({ body, work });
        limitBytes -= bytes;
    }
    return requests;
}

/** Sets or clears the message `ref`'s chat shows as streaming (owned by no generation). */
export function setStreamingState(ref: ChatRef, entry: StreamingEntry | null) {
    const key = keyOf(ref.chaId, ref.chatId);
    if (entry === null) {
        delete streamingChats[key];
    } else {
        streamingChats[key] = { ...entry, generationId: null };
    }
}

// ---------------------------------------------------------------------------------------------
// Chat membership and selection

/**
 * A chat's defaults that come from its character: `fmIndex`, the greeting the chat
 * starts from, is the character's `firstMsgIndex` (-1: the first message) when absent, and `localLore`
 * is `[]` when absent. An explicit `fmIndex` (also 0 or -1) is kept. `loreOverrides` keep the first
 * per id, as the server stores them (an acknowledgement does not install the server's copy). Changes
 * `chat` in place.
 */
export function prepareChatInput(chat: Chat, character: { firstMsgIndex?: unknown }) {
    if (chat.fmIndex === undefined || chat.fmIndex === null) {
        chat.fmIndex = typeof character.firstMsgIndex === "number" ? character.firstMsgIndex : -1;
    }
    chat.localLore ??= [];
    if (Array.isArray(chat.loreOverrides)) {
        chat.loreOverrides = firstOverridePerId(chat.loreOverrides);
    }
}

/**
 * Creates a chat in a character at `index` (default: the end). Missing or duplicate chat and message
 * ids are assigned, and the character's chat defaults (`prepareChatInput`). Returns the mirror's chat.
 */
export function createChat(
    chaId: string,
    input: DeepReadonly<Chat>,
    options: { index?: number; select?: boolean } = {},
): DeepReadonly<Chat> {
    const character = requireCharacter(chaId);
    const ids = memberIds(chaId);
    const chat = clone<Chat>(input);
    prepareChatInput(chat, character);
    delete chat.isStreaming;
    delete chat.activeStreamingDisplayOptimizationMode;
    if (!isValidId(chat.id) || ids.includes(chat.id) || heldChat({ chaId, chatId: chat.id }) !== undefined) {
        chat.id = uuidv4();
    }
    chat.message ??= [];
    prepareMessages(chat.message, new Set());
    const key = keyOf(chaId, chat.id);
    settleHypaV3Data(key, chat, undefined);
    const index = Math.max(0, Math.min(options.index ?? ids.length, ids.length));
    const created = insertChat(chaId, index, chat);
    changed(key);
    const ref = { chaId, chatId: chat.id };
    if (!releaseChatRefusal(ref)) {
        const entry = pendingFor(ref);
        entry.create = true;
        entry.seq = nextSeq();
        dirtyChatJournal(key, "pending");
    }
    syncSelection(chaId);
    if (options.select) {
        selectChat(chaId, chat.id);
    }
    notifyWork();
    return created;
}

/** Gives a character without chats its first chat. */
export function ensureChat(chaId: string) {
    const character = findCharacter(chaId);
    if (character && memberIds(chaId).length === 0) {
        createChat(chaId, { message: [], note: "", name: "Chat 1", localLore: [] }, { index: 0 });
    }
}

/** Deletes a chat. The last chat of a character and a chat being generated in cannot be deleted. */
export function deleteChat(ref: ChatRef) {
    requireCharacter(ref.chaId);
    const ids = memberIds(ref.chaId);
    if (!ids.includes(ref.chatId)) {
        return;
    }
    if (ids.length === 1) {
        throw new Error("A character needs at least one chat");
    }
    if (isChatGenerating(ref)) {
        throw new Error("This chat is being generated; wait until it finishes");
    }
    removeChat(ref.chaId, ref.chatId);
    notifyRemoval(ref);
    const key = keyOf(ref.chaId, ref.chatId);
    changed(key);
    const entry = pending.get(key);
    const refused = quarantined.get(key);
    clearChatRefusal(key);
    const seq = nextSeq();
    if (
        (refused?.create || (entry?.create && !entry.resend)) &&
        !inflight.has(key) &&
        !chatRevisions.has(key) &&
        !queuesDelete(entry)
    ) {
        // Never sent: nothing to delete on the server.
        pending.delete(key);
        settleKey(key, seq);
    } else {
        pending.set(key, {
            characterId: ref.chaId,
            chatId: ref.chatId,
            groupId: uuidv4(),
            create: false,
            resend: entry?.resend ?? null,
            ops: [{ op: "delete" }],
            seq,
        });
    }
    syncSelection(ref.chaId);
    notifyWork();
}

/** Reorders a character's chats to `ids` (a permutation of its chat ids). */
export function reorderChats(chaId: string, ids: readonly string[]) {
    requireCharacter(chaId);
    const current = memberIds(chaId);
    const members = new Set(current);
    if (ids.length !== current.length || !ids.every((id) => members.has(id)) || new Set(ids).size !== ids.length) {
        throw new Error("reorderChats needs a permutation of the character's chat ids");
    }
    if (ids.every((id, index) => current[index] === id)) {
        return;
    }
    holdingOf(chaId).ids = [...ids];
    mutationToken += 1;
    pendingOrders.set(chaId, nextSeq());
    notifyWork();
}

function readSelectionPreference(): Record<string, string> {
    try {
        const parsed = JSON.parse(localStorage.getItem(SELECTION_STORAGE_KEY) ?? "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function writeSelectionPreference(chaId: string, chatId: string) {
    try {
        const stored = readSelectionPreference();
        stored[chaId] = chatId;
        localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(stored));
    } catch {}
}

/** Loads the browser's last selected chats (boot only; tabs do not follow each other). */
export function loadSelectionPreference() {
    for (const key of Object.keys(chosen)) {
        delete chosen[key];
    }
    for (const [chaId, chatId] of Object.entries(readSelectionPreference())) {
        if (typeof chatId === "string") {
            chosen[slot(chaId)] = chatId;
        }
    }
}

/**
 * Selects a chat of a character by id or by its index in the list (nothing when it names none). The
 * selection is immediate, loaded or not: a selected chat that is not loaded yet is loaded now
 * (`selectedChat()` is null meanwhile and `selectedChatLoad` reports it), so a slow load never
 * selects anything and the latest selection is always the selection.
 */
export function selectChat(chaId: string, idOrIndex: string | number) {
    if (!findCharacter(chaId)) {
        return;
    }
    const ids = memberIds(chaId);
    const id = typeof idOrIndex === "number" ? ids[idOrIndex] : ids.find((entry) => entry === idOrIndex);
    if (id === undefined) {
        return;
    }
    choose(chaId, id);
    writeSelectionPreference(chaId, id);
    if (untrack(() => selection.characterId) === chaId) {
        loadSelectedChat();
    }
}

/**
 * Keeps a character's selected chat a member after its membership changed: a chosen chat that left
 * falls back to the first chat (the stored preference is kept). A reorder keeps the chosen id. The
 * selected character's new selected chat is loaded when it is not.
 */
function syncSelection(chaId: string) {
    const ids = holdingAt(chaId)?.ids ?? [];
    const id = untrack(() => chosen[slot(chaId)]);
    if (ids.length > 0 && (id === undefined || !ids.includes(id))) {
        choose(chaId, ids[0]);
        if (untrack(() => selection.characterId) === chaId) {
            loadSelectedChat();
        }
    }
}

/**
 * The selected chat's load (the chat screen's loading state): the chat key and owner lifetime it is
 * for, its request token, and the error of a load that ended without the chat (null while it runs).
 * Reactive.
 */
const selectedLoad = $state({ key: "", owner: "", token: 0, error: null as string | null });
let selectedLoadToken = 0;

/**
 * Loads the selected chat when it is not loaded (a character or chat selection, a membership
 * fallback), and marks it as just used. Only the latest request reports its end: a failed load, or
 * one that ended without the chat (it is gone, or kept back), is shown by `selectedChatLoad` until a
 * retry or another selection.
 */
function loadSelectedChat() {
    const ref = untrack(() => currentChatRef());
    scheduleTrim();
    if (!ref) {
        return;
    }
    const key = keyOf(ref.chaId, ref.chatId);
    touch(key);
    if (untrack(() => isLoaded(ref))) {
        return;
    }
    const owner = lifetimeOf(ref.chaId);
    if (selectedLoad.key === key && selectedLoad.owner === owner && loading.get(key)?.lifetime === owner) {
        // This chat's load is already running for the screen: its request reports its end.
        selectedLoad.error = null;
        return;
    }
    selectedLoadToken += 1;
    const token = selectedLoadToken;
    selectedLoad.key = key;
    selectedLoad.owner = owner;
    selectedLoad.token = token;
    selectedLoad.error = null;
    const finish = (error: string | null) => {
        if (selectedLoad.token === token) {
            selectedLoad.error = error;
        }
    };
    ensureChatLoaded(ref).then(
        (chat) => {
            const now = untrack(() => currentChatRef());
            if (!chat && now?.chaId === ref.chaId && now.chatId === ref.chatId) {
                finish(language.chatUnavailable);
            }
        },
        (error: unknown) => {
            console.error("[Chat] The selected chat could not be loaded", error);
            finish(error instanceof Error ? error.message : String(error));
        },
    );
}

/**
 * The selected chat's loading state while it is not loaded: `{ error: null }` while its load runs,
 * `{ error }` after a load that failed or ended without it (`retrySelectedChatLoad` tries again);
 * null when it is loaded or nothing is selected. Reactive.
 */
export function selectedChatLoad(): { error: string | null } | null {
    const ref = currentChatRef();
    if (!ref || isLoaded(ref)) {
        return null;
    }
    const current = selectedLoad.key === keyOf(ref.chaId, ref.chatId) && selectedLoad.owner === lifetimeOf(ref.chaId);
    return { error: current ? selectedLoad.error : null };
}

/**
 * Loads the selected chat again after a failed load. A load still running for it is joined (its
 * request reports its end), never replaced.
 */
export function retrySelectedChatLoad() {
    loadSelectedChat();
}

// A character selection (or home) loads that character's selected chat only (and may evict others).
onCharacterSelectionChanged(() => loadSelectedChat());

// ---------------------------------------------------------------------------------------------
// Messages and metadata

function indexOfMessage(ref: ChatRef, chat: Chat, id: string): number {
    return positionOf(keyOf(ref.chaId, ref.chatId), chat, id);
}

/** An owned copy of an anchor (a caller may reuse its object). */
function ownAnchor(anchor: MessageAnchor): MessageAnchor {
    if ("start" in anchor) {
        return { start: true };
    }
    if ("end" in anchor) {
        return { end: true };
    }
    return { after: anchor.after };
}

/**
 * Inserts messages at `anchor` (default: the end). Missing or duplicate ids are assigned. Returns
 * the ids of the inserted messages.
 */
export function appendMessage(
    ref: ChatRef,
    input: DeepReadonly<Message> | readonly DeepReadonly<Message>[],
    options: { anchor?: MessageAnchor } = {},
): string[] {
    const chat = requireChat(ref);
    const messages = clone<Message[]>(Array.isArray(input) ? input : [input as DeepReadonly<Message>]);
    prepareMessages(messages, new Set(chat.message.map((message) => message.chatId!)));
    const anchor = ownAnchor(options.anchor ?? { end: true });
    let position: number;
    if ("start" in anchor) {
        position = 0;
    } else if ("end" in anchor) {
        position = chat.message.length;
    } else {
        const after = indexOfMessage(ref, chat, anchor.after);
        if (after === -1) {
            throw new Error(`No message ${anchor.after} to insert after`);
        }
        position = after + 1;
    }
    chat.message.splice(position, 0, ...messages);
    dropMessagePositions(keyOf(ref.chaId, ref.chatId));
    changed(keyOf(ref.chaId, ref.chatId));
    enqueueLocalEdit(ref, { op: "append", messages: clone(messages), anchor }, { absent: true });
    return messages.map((message) => message.chatId!);
}

/**
 * Replaces one message by its id (`message.chatId`) with a whole row (op `setMessage`): on an older
 * revision it reverts the fields another writer changed meanwhile, so a change of some fields is a
 * `patchMessage`. The held translation is kept, as the server's `setMessage` keeps it; `createChat`,
 * `appendMessage`, and `replaceChat` take in what their messages carry (`prepareMessages`).
 */
export function replaceMessage(ref: ChatRef, input: DeepReadonly<Message>) {
    const chat = requireChat(ref);
    const message = clone<Message>(input);
    const index = indexOfMessage(ref, chat, message.chatId!);
    if (index === -1) {
        throw new Error(`No message ${message.chatId}`);
    }
    assertUnlocked(ref, [message.chatId]);
    // The stored translation stays (the server's `setMessage` keeps it); `setMessageTranslation` changes it.
    delete message.translation;
    const current = chat.message[index].translation;
    if (current !== undefined) {
        message.translation = clone<MessageTranslation>(current);
    }
    const before = { value: clone(chat.message[index]) };
    chat.message[index] = message;
    dropMessagePositions(keyOf(ref.chaId, ref.chatId));
    changed(keyOf(ref.chaId, ref.chatId));
    enqueueLocalEdit(ref, { op: "setMessage", message: clone(message) }, before);
}

/** A message field patch as the server takes it (`patchMessage`): fields to set and fields to remove. */
type MessagePatch = { set: Record<string, unknown>; unset: string[] };

/**
 * A `patchMessage`'s fields, checked as the server's `preparePatchMessage` checks them: `set` is
 * taken as its JSON copy, `translation` is dropped from both sides (the stored one stays, as for
 * `replaceMessage`), `chatId` and `__proto__` are refused, `role` and `data` keep their message
 * shape and cannot be unset, and a field cannot be both set and unset. Null when no field is left.
 */
function prepareMessagePatch(set: unknown, unset: unknown): MessagePatch | null {
    const fields = set === undefined ? {} : clone<unknown>(set);
    if (!isPlainRecord(fields) || !Array.isArray(unset)) {
        throw new Error("patchMessage needs { set?: object, unset?: string[] }");
    }
    const removals = new Set<string>();
    for (let index = 0; index < unset.length; index++) {
        const key: unknown = unset[index];
        if (typeof key !== "string") {
            throw new Error("patchMessage needs { set?: object, unset?: string[] }");
        }
        removals.add(key);
    }
    for (const key of [...Object.keys(fields), ...removals]) {
        if (key === "chatId" || key === "__proto__") {
            throw new Error(`patchMessage cannot change ${key}`);
        }
    }
    delete fields.translation;
    removals.delete("translation");
    if (removals.has("role") || removals.has("data")) {
        throw new Error("patchMessage cannot unset role or data");
    }
    if ([...removals].some((key) => Object.hasOwn(fields, key))) {
        throw new Error("patchMessage sets and unsets the same field");
    }
    if (Object.hasOwn(fields, "role") && fields.role !== "user" && fields.role !== "char") {
        throw new Error("message.role must be user or char");
    }
    if (Object.hasOwn(fields, "data") && typeof fields.data !== "string") {
        throw new Error("message.data must be a string");
    }
    if (Object.keys(fields).length === 0 && removals.size === 0) {
        return null;
    }
    return { set: fields, unset: [...removals] };
}

/**
 * Applies a prepared patch to the message at `index` (already checked against the locks) and
 * queues it. The mirror changes where it differs; the op is queued as given either way, since the
 * server's copy may differ from this tab's (a patch equal to the mirror still lands, and still
 * closes the message's generation fence).
 */
function applyMessagePatch(ref: ChatRef, chat: Chat, index: number, id: string, patch: MessagePatch) {
    const row = chat.message[index] as unknown as Record<string, unknown>;
    const before = fieldsBefore(row, [...Object.keys(patch.set), ...patch.unset]);
    let differs = false;
    for (const key of patch.unset) {
        if (Object.hasOwn(row, key)) {
            delete row[key];
            differs = true;
        }
    }
    for (const [key, value] of Object.entries(patch.set)) {
        // Serialized as it is (a `$state.snapshot` would drop a nested own `__proto__`).
        if (JSON.stringify(row[key]) !== JSON.stringify(value)) {
            row[key] = clone(value);
            differs = true;
        }
    }
    if (differs) {
        changed(keyOf(ref.chaId, ref.chatId));
    }
    const op: Extract<ChatOp, { op: "patchMessage" }> = { op: "patchMessage", id };
    if (Object.keys(patch.set).length > 0) {
        op.set = clone(patch.set) as typeof op.set;
    }
    if (patch.unset.length > 0) {
        op.unset = [...patch.unset] as typeof op.unset;
    }
    enqueueLocalEdit(ref, op, before);
}

/**
 * Sets and removes fields of one message by its id (op `patchMessage`): the server applies them to
 * the message as stored, so fields this call does not name keep another writer's values, also when
 * this tab's copy is behind. Use it for a change of some fields; `replaceMessage` is for a whole row.
 * The stored translation never changes here (`setMessageTranslation` does). Every given field is
 * sent, also one the mirror already holds; nothing is queued when no field is left.
 */
export function patchMessage(
    ref: ChatRef,
    id: string,
    set: Partial<DeepReadonly<Omit<Message, "chatId" | "translation">>> | Record<string, unknown> = {},
    unset: readonly string[] = [],
) {
    const chat = requireChat(ref);
    const index = indexOfMessage(ref, chat, id);
    if (index === -1) {
        throw new Error(`No message ${id}`);
    }
    const patch = prepareMessagePatch(set, unset);
    assertUnlocked(ref, [id]);
    if (patch) {
        applyMessagePatch(ref, chat, index, id, patch);
    }
}

/** Sets a message's text. */
export function setMessageText(ref: ChatRef, id: string, text: string) {
    const chat = requireChat(ref);
    const index = indexOfMessage(ref, chat, id);
    if (index === -1) {
        throw new Error(`No message ${id}`);
    }
    assertUnlocked(ref, [id]);
    const before = { value: chat.message[index].data };
    if (chat.message[index].data !== text) {
        chat.message[index].data = text;
        changed(keyOf(ref.chaId, ref.chatId));
    }
    enqueueLocalEdit(ref, { op: "setText", id, text }, before);
}

/**
 * Sets (or with `null` clears) a message's stored translation. A
 * translation whose `sourceHash` does not match the message's current text is not taken: nothing
 * changes and false is returned. True means taken here and queued, not saved: the server ignores it
 * when its copy of the text differs by then (`ChatGroupResult.translations`).
 */
export function setMessageTranslation(
    ref: ChatRef,
    id: string,
    translation: DeepReadonly<MessageTranslation> | null,
): boolean {
    const chat = requireChat(ref);
    const index = indexOfMessage(ref, chat, id);
    if (index === -1) {
        throw new Error(`No message ${id}`);
    }
    // Checked as its JSON copy (what the mirror and the queue hold), never as the caller's object.
    const value = translation === null ? null : clone<MessageTranslation>(translation);
    if (value !== null && !isMessageTranslation(value)) {
        throw new Error("Not a message translation");
    }
    assertUnlocked(ref, [id]);
    const message = chat.message[index];
    if (value !== null && value.sourceHash !== translationSourceHash(message.data)) {
        return false;
    }
    const before: JournalBefore =
        message.translation === undefined ? { absent: true } : { value: clone(message.translation) };
    if (value === null) {
        delete message.translation;
    } else {
        message.translation = clone(value);
    }
    changed(keyOf(ref.chaId, ref.chatId));
    // Never coalesced: a set lands only on a matching text, so dropping an earlier op could change the result.
    enqueueLocalEdit(ref, { op: "setTranslation", id, translation: value }, before);
    return true;
}

/** The chat of `ref` and which of `ids` it holds; throws for a chat not held or a message locked. */
function removalTarget(ref: ChatRef, ids: readonly string[]): { chat: Chat; present: string[] } {
    const chat = requireChat(ref);
    const present = ids.filter((id) => indexOfMessage(ref, chat, id) !== -1);
    assertUnlocked(ref, present);
    return { chat, present };
}

/**
 * Removes messages by id: a person's delete. Removing several needs the chat's current revision on the
 * server. The checks throw here, in every chat. Under Structured Memory the removal itself comes later,
 * or not at all (`removeAfterAsking`), so the messages may still be there when this returns.
 */
export function removeMessages(ref: ChatRef, ids: readonly string[]) {
    const { chat, present } = removalTarget(ref, ids);
    if (present.length === 0) {
        return;
    }
    if (settings.ui.memoryAlgorithmType === STRUCTURED_MEMORY_ALGORITHM) {
        void removeAfterAsking(ref, present);
    } else {
        applyRemoval(ref, chat, present);
    }
}

/**
 * Removes messages by id now, asking nothing: for what no person answers, a command or a recovered
 * draft. Under Structured Memory what cites them reads as missing its source until someone repairs it,
 * unless `retract` carries a person's earlier yes.
 */
export function removeMessagesUnasked(ref: ChatRef, ids: readonly string[], options: { retract?: true } = {}) {
    const { chat, present } = removalTarget(ref, ids);
    if (present.length > 0) {
        applyRemoval(ref, chat, present, options);
    }
}

/**
 * How many of a chat's events that are not retracted cite any of `ids`. 0 when that cannot be read, so
 * a memory read that failed never stands in the way of a delete. The reader stays out of this module's
 * static graph.
 */
async function citingEvents(ref: ChatRef, ids: readonly string[]): Promise<number> {
    try {
        const { readStructuredMemoryCoverage } = await import("../process/structuredMemory.svelte");
        const coverage = await readStructuredMemoryCoverage(ref);
        if (coverage.outcome !== "ok") {
            return 0;
        }
        const removing = new Set(ids);
        return coverage.value.events.filter(
            ({ status, messageIds }) => status !== "retracted" && messageIds.some((id) => removing.has(id)),
        ).length;
    } catch {
        return 0;
    }
}

/**
 * The rest of a person's delete in a Structured Memory chat: asks when events cite the messages, then
 * removes them, marked so the server retracts those events. Declined removes nothing. The chat is
 * pinned while it waits, and what it waited through is checked again: another owner of the ids or a
 * chat no longer held removes nothing, messages already gone drop out, and a message a generation took
 * meanwhile refuses the whole delete. Its callers discard the result, so it owns its errors.
 */
async function removeAfterAsking(ref: ChatRef, ids: readonly string[]): Promise<void> {
    const owner = lifetimeOf(ref.chaId);
    const release = pinChat(ref);
    try {
        const citing = await citingEvents(ref, ids);
        if (citing > 0 && !(await alertConfirm(language.structuredMemory.removeRetracts(citing)))) {
            return;
        }
        const chat = lifetimeOf(ref.chaId) === owner && findCharacter(ref.chaId) ? heldChat(ref) : undefined;
        const present = chat ? ids.filter((id) => indexOfMessage(ref, chat, id) !== -1) : [];
        if (present.length === 0) {
            return;
        }
        if (present.some((id) => isLockedKey(messageKeyOf(ref, id)))) {
            alertError(language.chatGenerating);
            return;
        }
        applyRemoval(ref, chat, present, citing > 0 ? { retract: true } : {});
    } catch (error) {
        alertError(error instanceof Error ? error : String(error));
    } finally {
        release();
    }
}

/**
 * Removes messages already checked against the locks, as one op (several need the current revision).
 * `mark` holds a person's yes to retracting what cites them.
 */
function applyRemoval(ref: ChatRef, chat: Chat, present: readonly string[], mark: { retract?: true } = {}) {
    const removing = new Set(present);
    const positions = [...removing].map((id) => indexOfMessage(ref, chat, id));
    const before = removing.size === 1 ? { value: clone(chat.message[positions[0]]) } : undefined;
    const removedPositions = new Set(positions);
    const kept = chat.message.filter((_, position) => !removedPositions.has(position));
    chat.message.splice(0, chat.message.length, ...kept);
    dropMessagePositions(keyOf(ref.chaId, ref.chatId));
    changed(keyOf(ref.chaId, ref.chatId));
    enqueueLocalEdit(ref, { op: "remove", ids: [...removing], ...mark }, before);
}

/**
 * Puts back the messages a reroll removed (`messages`, the tail it removed after `anchor`, null: the
 * start) when its send did not run and a matching removal is pending: the last `remove` naming
 * exactly those ids must also be the queue's last op. It is withdrawn whole and nothing is queued.
 * The restoration is provisional: a removal requeued after a lost response may have committed,
 * so the chat is marked stale and its idle read can remove the restored replies again. Nothing
 * changes when the character's chats were replaced since `owner` (`chatOwnerToken`), the anchor
 * is gone, something follows it now, a message is back already, or no matching pending removal
 * ends the queue (a dropped single removal comes back with the chat's read instead). Returns
 * whether the messages were put back.
 */
export function restoreUnsentRemoval(
    ref: ChatRef,
    owner: string,
    anchor: string | null,
    messages: DeepReadonly<Message[]>,
): boolean {
    const chat = heldChat(ref);
    const key = keyOf(ref.chaId, ref.chatId);
    const entry = pending.get(key);
    if (!chat || !entry || messages.length === 0 || lifetimeOf(ref.chaId) !== owner) {
        return false;
    }
    const ids = new Set(messages.map((message) => message.chatId!));
    const index = entry.ops.findLastIndex(
        (op) => op.op === "remove" && op.ids.length === ids.size && op.ids.every((id) => ids.has(id)),
    );
    const anchorIndex = anchor === null ? -1 : indexOfMessage(ref, chat, anchor);
    if (
        index === -1 ||
        index !== entry.ops.length - 1 ||
        (anchor !== null && anchorIndex === -1) ||
        anchorIndex !== chat.message.length - 1 ||
        messages.some((message) => indexOfMessage(ref, chat, message.chatId!) !== -1)
    ) {
        return false;
    }
    entry.ops.splice(index, 1);
    dirtyChatJournal(key, "pending");
    const restored = clone<Message[]>(messages);
    restored.forEach((message) => dropInvalidTranslation(message));
    chat.message.push(...restored);
    dropMessagePositions(key);
    changed(key);
    staleChats.add(key);
    if (entry.ops.length === 0 && !entry.create && !entry.resend && !inflight.has(key)) {
        pending.delete(key);
        settleKey(key, entry.seq);
        jobBlocked.delete(key);
    }
    notifyWork();
    return true;
}

/**
 * The chat fields the server's chat normalizer (`normalizeChatMeta`) defaults: removing one, or setting
 * it to `null`, stores the default, so the client writes the default itself and holds what the server
 * holds.
 */
const SERVER_META_DEFAULTS: Readonly<Record<string, () => unknown>> = {
    name: () => "",
    note: () => "",
    localLore: () => [],
    fmIndex: () => -1,
};

/** The chats that showed the notice of a refused `hypaV3Data`, so a plugin writing on every send stacks no toasts. */
const refusedProjectionChats = new Set<string>();

/**
 * Tells of a `hypaV3Data` dropped from a write whose other fields still apply: `console.warn` on each
 * notice, and one `alertToast` per chat until reload. This refusal throws nothing: the field alone is
 * dropped and the rest of the same write applies. `src/ts/plugins/apiV3/v3.svelte.ts`'s `warnRefused`
 * handles a thrown `MutationValidationError`, which stops that setter's write; it rolls nothing back.
 */
function noticeRefusedProjection(key: string) {
    console.warn(
        "[Plugin] Refused a change to hypaV3Data, which Structured Memory projects from its records; the previous value was kept",
    );
    if (!refusedProjectionChats.has(key)) {
        refusedProjectionChats.add(key);
        alertToast(language.structuredMemory.projectionWriteRefused);
    }
}

/**
 * Whether a write's `hypaV3Data` (`incoming`, undefined when it names none) leaves the field as `held`
 * holds it, before the mirror changes or a journal sidecar is captured. `held` is the chat, undefined
 * for a new chat; `baseline` the value the writer started from, the held one when it has none. Nothing
 * here authorizes: a seal only says a value is a projection.
 *
 * With Structured Memory selected the field is the projection's: a sealed value held, or on an existing
 * chat anything but a real value with summaries, the one thing that means HypaV3 owns the field
 * (`hypaV3DataHoldsSummaries`).
 *
 * - A sealed value is never taken: it is a projection, this chat's or another's, or an older one a
 *   plugin read before a refresh. It raises the notice only when its seal is no longer intact and the
 *   value differs from `baseline`; an unchanged copy of an already altered baseline is silent too.
 * - An absent value leaves the field in place when it is the projection's, or a projection held or
 *   started from: a plugin's object without the field loses nothing. A real value goes as it always did.
 * - An unsealed value goes unless the field is the projection's, when a change is dropped with the
 *   notice, so it never becomes a stored owner. A new chat has no records. With another algorithm
 *   selected it is a real write, which replaces a projection held from before: HypaV3 owns the chat
 *   from then on when the value holds summaries.
 */
function keepsHeldHypaV3Data(key: string, incoming: unknown, held: Chat | undefined, baseline: unknown): boolean {
    const differs = () => JSON.stringify(incoming) !== JSON.stringify(baseline);
    if (isSealedHypaV3Data(incoming)) {
        if (!sealedHypaV3DataIntact(incoming) && differs()) {
            noticeRefusedProjection(key);
        }
        return true;
    }
    const heldValue = held?.hypaV3Data;
    const projectionsField = () =>
        (isSealedHypaV3Data(heldValue) || !hypaV3DataHoldsSummaries(heldValue)) &&
        settings.ui.memoryAlgorithmType === STRUCTURED_MEMORY_ALGORITHM;
    if (incoming === undefined) {
        return (
            isSealedHypaV3Data(heldValue) ||
            isSealedHypaV3Data(baseline) ||
            (heldValue !== undefined && projectionsField())
        );
    }
    if (!held || !projectionsField()) {
        return false;
    }
    if (differs()) {
        noticeRefusedProjection(key);
    }
    return true;
}

/**
 * `keepsHeldHypaV3Data` for a whole copy: `chat`, the copy a write takes in, gets the held value when
 * the field stays, so whatever holds the copy next holds that. Returns whether it stayed.
 */
function settleHypaV3Data(key: string, chat: Chat, held: Chat | undefined, baseline = held): boolean {
    if (!keepsHeldHypaV3Data(key, chat.hypaV3Data, held, baseline?.hypaV3Data)) {
        return false;
    }
    if (held?.hypaV3Data === undefined) {
        delete chat.hypaV3Data;
    } else {
        chat.hypaV3Data = clone(held.hypaV3Data);
    }
    return true;
}

/** A loaded chat as a refresh of its projection found it, before its first await (`chatProjectionState`). */
export type ChatProjectionState = {
    /** The held chat and its `hypaV3Data`, compared by identity. */
    chat: Chat;
    value: Chat["hypaV3Data"];
    /** `chatOwnerToken` of its character. */
    owner: string;
    /** `heldChatRevision`: null for a chat not on the server yet. */
    chatRevision: string | null;
    /** The memory revision the held value was read at (`sealedHypaV3DataRevision`). */
    memoryRevision: string | undefined;
    /** The held value is a real one with summaries: nothing projects over it. */
    hypaV3Owned: boolean;
};

/** What `installChatProjection` is fenced on, undefined for a chat that is not loaded. */
export function chatProjectionState(ref: ChatRef): ChatProjectionState | undefined {
    const chat = heldChat(ref);
    if (!chat) {
        return undefined;
    }
    const value = chat.hypaV3Data;
    return {
        chat,
        value,
        owner: chatOwnerToken(ref.chaId),
        chatRevision: heldChatRevision(ref),
        memoryRevision: sealedHypaV3DataRevision(value),
        hypaV3Owned: !isSealedHypaV3Data(value) && hypaV3DataHoldsSummaries(value),
    };
}

/**
 * Takes a refresh's `answer` for a chat's `hypaV3Data` and says whether the field changed. Only a chat
 * still as `state` found it takes one: the same held object with the same value, the same owner, and a
 * held revision of the same epoch and `seq`. Every whole replacement changes the object or the value, and
 * `chatInstallVersion` does not see them all. A chat's revision may move within its `seq`, since the memory
 * revision says nothing of its messages.
 *
 * - A null answer removes a sealed value. A real value stays.
 * - A value goes in only with this algorithm selected, sealed intact, at the held revision's epoch and
 *   `seq`, and past the counter of a held token of that `seq`. `compareRevision` alone would take a larger
 *   `seq`, which is another chat under these ids.
 *
 * The field is written here directly: `keepsHeldHypaV3Data` refuses every sealed value, and `changed`
 * would dirty a queued create's journal and move the version a reorder compares, for a value that never
 * leaves the tab.
 */
export function installChatProjection(
    ref: ChatRef,
    state: ChatProjectionState,
    answer: SealedHypaV3Data | null,
): boolean {
    const chat = heldChat(ref);
    const revision = parseRevisionToken(heldChatRevision(ref));
    const captured = parseRevisionToken(state.chatRevision);
    if (
        !chat ||
        chat !== state.chat ||
        chat.hypaV3Data !== state.value ||
        chatOwnerToken(ref.chaId) !== state.owner ||
        revision?.epoch !== captured?.epoch ||
        revision?.seq !== captured?.seq
    ) {
        return false;
    }
    if (answer === null) {
        if (!isSealedHypaV3Data(state.value)) {
            return false;
        }
        delete chat.hypaV3Data;
    } else {
        const token = parseRevisionToken(sealedHypaV3DataRevision(answer));
        const heldToken = parseRevisionToken(state.memoryRevision);
        if (
            state.hypaV3Owned ||
            settings.ui.memoryAlgorithmType !== STRUCTURED_MEMORY_ALGORITHM ||
            !sealedHypaV3DataIntact(answer) ||
            !token ||
            !revision ||
            token.epoch !== revision.epoch ||
            token.seq !== revision.seq ||
            (heldToken?.epoch === token.epoch && heldToken.seq === token.seq && token.revision <= heldToken.revision)
        ) {
            return false;
        }
        chat.hypaV3Data = answer;
    }
    mutationToken += 1;
    return true;
}

/**
 * The chat fields a chat list writes (`ChatListEntry`'s): `setChatMeta` changes them also in a chat
 * that is not loaded (its summary), with the type the summary holds. Optional fields such as `pinned`
 * are removed on unset, including from a whole-chat read arriving while the edit is pending.
 */
const SUMMARY_FIELD_TYPES: Readonly<Record<string, "string" | "number" | "boolean">> = {
    name: "string",
    pinned: "boolean",
    folderId: "string",
    bindedPersona: "string",
    promptPresetId: "string",
    modelPresetId: "string",
    bindingReview: "boolean",
    fmIndex: "number",
    ...CHAT_TRANSLATION_FIELD_TYPES,
};

/**
 * Sets and removes chat fields (not `id`, `message`, or the streaming flags). Values equal to the
 * current ones are skipped, so a component can commit its whole editing copy without echo. A field the
 * server defaults (`SERVER_META_DEFAULTS`) is set to its default instead of removed or set to `null`.
 * A chat that is not loaded takes changes of its list fields only (`SUMMARY_FIELD_TYPES`: its summary
 * changes and the same op is queued); any other field needs it loaded. The whole change is checked
 * before anything changes. A `hypaV3Data` that stays as held (`keepsHeldHypaV3Data`) drops out, and
 * the other fields still apply.
 */
export function setChatMeta(
    ref: ChatRef,
    set: Partial<DeepReadonly<Chat>> | Record<string, unknown>,
    unset: readonly string[] = [],
) {
    const loaded = findCharacter(ref.chaId) ? heldChat(ref) : undefined;
    let summary: ChatEntryMeta | undefined;
    if (!loaded) {
        summary =
            findCharacter(ref.chaId) && isMember(ref) ? holdingAt(ref.chaId)!.summaries[slot(ref.chatId)] : undefined;
        if (!summary) {
            throw new Error(`No chat ${ref.chatId} in character ${ref.chaId}`);
        }
        for (const [key, value] of [...Object.entries(set), ...unset.map((key) => [key, undefined] as const)]) {
            const type = SUMMARY_FIELD_TYPES[key];
            if (!Object.hasOwn(SUMMARY_FIELD_TYPES, key)) {
                throw new Error(`The chat is not loaded; setChatMeta cannot change ${key} now`);
            }
            if (value !== undefined && value !== null && typeof value !== type) {
                throw new Error(`setChatMeta needs a ${type} ${key}`);
            }
        }
    }
    const chat = (loaded ?? summary) as unknown as Record<string, unknown>;
    const changes: Record<string, unknown> = {};
    const requested: Record<string, unknown> = { ...set };
    for (const key of unset) {
        if (Object.hasOwn(SERVER_META_DEFAULTS, key) && requested[key] === undefined) {
            requested[key] = null;
        }
    }
    for (const [key, entry] of Object.entries(requested)) {
        let value = entry === null && Object.hasOwn(SERVER_META_DEFAULTS, key) ? SERVER_META_DEFAULTS[key]() : entry;
        // As the server stores it: an acknowledgement does not install the server's copy.
        if (key === "loreOverrides" && Array.isArray(value)) {
            value = firstOverridePerId(value as ChatLoreOverride[]);
        }
        if (forbiddenMetaKeys.has(key)) {
            throw new Error(`setChatMeta cannot change ${key}`);
        }
        if (value === undefined) {
            continue;
        }
        // Serialized as it is (a `$state.snapshot` would drop a nested own `__proto__`).
        if (JSON.stringify(chat[key]) === JSON.stringify(value)) {
            continue;
        }
        if (key !== "hypaV3Data" || !keepsHeldHypaV3Data(keyOf(ref.chaId, ref.chatId), value, loaded, chat[key])) {
            changes[key] = clone(value);
        }
    }
    const removals = unset.filter((key) => {
        if (forbiddenMetaKeys.has(key)) {
            throw new Error(`setChatMeta cannot change ${key}`);
        }
        // A field the server defaults is never removed: the loop above set it to its default.
        return (
            Object.hasOwn(chat, key) &&
            !Object.hasOwn(changes, key) &&
            !Object.hasOwn(SERVER_META_DEFAULTS, key) &&
            (key !== "hypaV3Data" || !keepsHeldHypaV3Data(keyOf(ref.chaId, ref.chatId), undefined, loaded, chat[key]))
        );
    });
    if (Object.keys(changes).length === 0 && removals.length === 0) {
        return;
    }
    const before = fieldsBefore(chat, [...Object.keys(changes), ...removals]);
    for (const [key, value] of Object.entries(changes)) {
        chat[key] = clone(value);
    }
    for (const key of removals) {
        delete chat[key];
    }
    changed(keyOf(ref.chaId, ref.chatId));
    enqueueLocalEdit(ref, { op: "meta", set: changes, unset: removals }, before);
}

/**
 * Adds entries to, and removes entry ids from, a chat field that is a map (`CHAT_META_MERGE_KEYS`:
 * `toolCalls`, `GLGlobalVariables`, `scriptstate`). The server applies them to the map as stored
 * (`merge`, `mergeUnset`; removals first), so the entries this call does not name keep what another
 * device wrote meanwhile (a `meta` set would replace the map; a named entry is still last writer
 * wins). An id both added and removed is added. A removal is sent also
 * when the mirror lacks the entry; removals alone leave a field that is not a map as it is, and
 * entries replace such a field with a map of them, as on the server.
 */
export function mergeChatMeta(
    ref: ChatRef,
    key: string,
    entries: Record<string, unknown>,
    removals: readonly string[] = [],
) {
    if (!CHAT_META_MERGE_KEYS.includes(key)) {
        throw new Error(`mergeChatMeta cannot merge ${key}`);
    }
    // Their JSON copy (what is sent): an entry whose value is undefined is no entry.
    const added = clone<unknown>(entries);
    if (!isPlainRecord(added) || !Array.isArray(removals)) {
        throw new Error(`mergeChatMeta needs entries and entry ids for ${key}`);
    }
    const ids = new Set<string>();
    for (let index = 0; index < removals.length; index++) {
        const id: unknown = removals[index];
        if (typeof id !== "string") {
            throw new Error(`mergeChatMeta needs entries and entry ids for ${key}`);
        }
        ids.add(id);
    }
    const removed = [...ids].filter((id) => !Object.hasOwn(added, id));
    const adding = Object.keys(added).length > 0;
    if (!adding && removed.length === 0) {
        return;
    }
    const chat = requireChat(ref) as unknown as Record<string, unknown>;
    const stored = chat[key];
    const before = fieldsBefore(chat, [key]);
    if (isPlainRecord(stored) || adding) {
        // Built from entries (never assigned by name, never through `$state.snapshot`, which drops
        // an own `__proto__`), so any entry id stays an own entry; kept values are the mirror's own.
        const dropped = new Set(removed);
        const kept = isPlainRecord(stored) ? Object.entries(stored).filter(([id]) => !dropped.has(id)) : [];
        chat[key] = Object.fromEntries([...kept, ...Object.entries(clone(added))]);
        changed(keyOf(ref.chaId, ref.chatId));
    }
    const op: Extract<ChatOp, { op: "meta" }> = { op: "meta" };
    if (adding) {
        op.merge = { [key]: clone(added) };
    }
    if (removed.length > 0) {
        op.mergeUnset = { [key]: removed };
    }
    enqueueLocalEdit(ref, op, before);
}

/**
 * Replaces a whole chat (fields and messages); needs the chat's current revision on the server.
 * Refused while a generation runs in the chat (the server treats it as a manual write of every
 * message, which would close the generation's fence).
 */
export function replaceChat(ref: ChatRef, input: DeepReadonly<Chat>) {
    const character = requireCharacter(ref.chaId);
    if (!heldChat(ref)) {
        throw new Error(`No chat ${ref.chatId}`);
    }
    if (isChatGenerating(ref)) {
        throw new Error("This chat is being generated; wait until it finishes");
    }
    const chat = clone<Chat>(input);
    chat.id = ref.chatId;
    prepareChatInput(chat, character);
    chat.message ??= [];
    prepareMessages(chat.message, new Set());
    delete chat.isStreaming;
    delete chat.activeStreamingDisplayOptimizationMode;
    settleHypaV3Data(keyOf(ref.chaId, ref.chatId), chat, heldChat(ref));
    dropMessagePositions(keyOf(ref.chaId, ref.chatId));
    holdingOf(ref.chaId).chats[slot(ref.chatId)] = chat;
    changed(keyOf(ref.chaId, ref.chatId));
    enqueueLocalEdit(ref, { op: "replace", chat: sendChat(chat) });
}

/**
 * What a hook started from: a detached copy of the chat, the chat's version then, and its owner's
 * lifetime (`chatOwnerToken`; a result is never applied to a chat whose character's chats were
 * replaced meanwhile, even under the same ids).
 */
export type ChatBaseline = { ref: ChatRef; chat: Chat; version: number; owner?: string };

/** Captures a chat before a hook works on a copy of it (for `applyChatResult`). */
export function captureChatBaseline(ref: ChatRef): ChatBaseline {
    return {
        ref,
        chat: projectChat(requireChat(ref)),
        version: versions.get(keyOf(ref.chaId, ref.chatId)) ?? 0,
        owner: lifetimeOf(ref.chaId),
    };
}

const nonMetaKeys = new Set(["message", "id", "isStreaming", "activeStreamingDisplayOptimizationMode"]);

/**
 * Applies what a hook changed in its copy of a chat (`result`) against the copy it started from
 * (`baseline`), onto the chat as it is now: messages the hook removed are removed, added ones are
 * inserted after their predecessor, changed message fields are sent as a field patch of the current
 * message (`patchMessage`), changed chat fields are set or removed, a changed map field
 * (`CHAT_META_MERGE_KEYS`) entry by entry (`mergeChatMeta`). A map the hook dropped is treated as an
 * emptied map: its baseline entries are removed, while entries others added meanwhile are kept.
 * Changes made meanwhile by others are kept. When the hook reordered surviving messages, the whole
 * chat is replaced, but only if it has not changed since the baseline and no generation runs in it
 * (otherwise the order change is dropped with a warning). The locks and the message patches are
 * checked before the mirror changes. A `hypaV3Data` that stays as held (`keepsHeldHypaV3Data`) is
 * dropped from the result alone: the rest of it still applies.
 */
export function applyChatResult(baseline: ChatBaseline, result: DeepReadonly<Chat>) {
    const { ref } = baseline;
    const current = heldChat(ref);
    if (!current) {
        return;
    }
    if (baseline.owner !== undefined && baseline.owner !== lifetimeOf(ref.chaId)) {
        console.warn("[Chat] A change to a chat whose character's chats were replaced meanwhile is dropped");
        return;
    }
    const next = clone<Chat>(result);
    // A result without the character-derived defaults gets them (it never unsets them).
    prepareChatInput(next, requireCharacter(ref.chaId));
    next.message ??= [];
    const baseMessages = new Map(baseline.chat.message.map((message) => [message.chatId!, message]));
    prepareMessages(next.message, new Set());
    for (const message of next.message) {
        // A new message may not reuse an id the chat already has.
        if (!baseMessages.has(message.chatId!) && indexOfMessage(ref, current, message.chatId!) !== -1) {
            message.chatId = uuidv4();
        }
    }
    const resultIds = new Set(next.message.map((message) => message.chatId!));
    const removed = baseline.chat.message
        .map((message) => message.chatId!)
        .filter((id) => !resultIds.has(id) && indexOfMessage(ref, current, id) !== -1);
    const changedMessages = next.message.filter((message) => {
        const before = baseMessages.get(message.chatId!);
        return before !== undefined && JSON.stringify(before) !== JSON.stringify(message);
    });
    const survivorsBefore = baseline.chat.message.map((message) => message.chatId!).filter((id) => resultIds.has(id));
    const survivorsAfter = next.message.map((message) => message.chatId!).filter((id) => baseMessages.has(id));
    const reordered = survivorsBefore.some((id, index) => survivorsAfter[index] !== id);
    assertUnlocked(ref, [...removed, ...changedMessages.map((message) => message.chatId!)]);
    // Each changed message the chat still has, as a patch of the fields the hook changed (prepared
    // before anything changes: an invalid field change refuses the whole result).
    const patches: { id: string; patch: MessagePatch }[] = [];
    for (const message of changedMessages) {
        const id = message.chatId!;
        if (indexOfMessage(ref, current, id) === -1) {
            continue;
        }
        const beforeFields = baseMessages.get(id)! as unknown as Record<string, unknown>;
        const afterFields = message as unknown as Record<string, unknown>;
        const set: [string, unknown][] = [];
        const unset: string[] = [];
        for (const key of new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])) {
            if (key === "chatId" || JSON.stringify(beforeFields[key]) === JSON.stringify(afterFields[key])) {
                continue;
            }
            if (Object.hasOwn(afterFields, key)) {
                set.push([key, afterFields[key]]);
            } else {
                unset.push(key);
            }
        }
        const patch = prepareMessagePatch(Object.fromEntries(set), unset);
        if (patch) {
            patches.push({ id, patch });
        }
    }

    // After every refusal of the whole result, so the notice speaks of a write that goes on.
    const heldHypaV3Data = settleHypaV3Data(keyOf(ref.chaId, ref.chatId), next, current, baseline.chat);

    if (reordered) {
        const unchanged = baseline.version === (versions.get(keyOf(ref.chaId, ref.chatId)) ?? 0);
        if (unchanged && !isChatGenerating(ref)) {
            replaceChat(ref, next);
            return;
        }
        console.warn(
            "[Chat] A script reordered messages of a chat that changed meanwhile; the order change is dropped",
        );
    }

    if (removed.length > 0) {
        // One op for all of them (checked per message above), so removing several keeps needing
        // the current revision.
        applyRemoval(ref, current, removed);
    }
    for (const { id, patch } of patches) {
        const index = indexOfMessage(ref, current, id);
        if (index !== -1) {
            applyMessagePatch(ref, current, index, id, patch);
        }
    }
    let previous: string | null = null;
    for (const message of next.message) {
        const id = message.chatId!;
        if (!baseMessages.has(id)) {
            const anchor: MessageAnchor =
                previous === null
                    ? { start: true }
                    : indexOfMessage(ref, current, previous) !== -1
                      ? { after: previous }
                      : { end: true };
            appendMessage(ref, message, { anchor });
        }
        if (indexOfMessage(ref, current, id) !== -1) {
            previous = id;
        }
    }

    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    const merges: { key: string; entries: Record<string, unknown>; removals: string[] }[] = [];
    const baseFields = baseline.chat as unknown as Record<string, unknown>;
    const nextFields = next as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(baseFields), ...Object.keys(nextFields)])) {
        if (
            nonMetaKeys.has(key) ||
            (key === "hypaV3Data" && heldHypaV3Data) ||
            JSON.stringify(baseFields[key]) === JSON.stringify(nextFields[key])
        ) {
            continue;
        }
        const before = baseFields[key];
        const after = nextFields[key];
        if (
            CHAT_META_MERGE_KEYS.includes(key) &&
            (before === undefined || isPlainRecord(before)) &&
            (isPlainRecord(after) || (after === undefined && isPlainRecord(before)))
        ) {
            // A map field (chat variables, toggles, tool calls) changed entry by entry: only the
            // entries the hook changed or removed are sent, so entries another writer changed
            // meanwhile are kept. A map the baseline lacked counts as an empty one.
            const was: Record<string, unknown> = isPlainRecord(before) ? before : {};
            const copy = isPlainRecord(after) ? after : {};
            merges.push({
                key,
                entries: Object.fromEntries(
                    Object.entries(copy).filter(
                        ([id, value]) => !Object.hasOwn(was, id) || JSON.stringify(was[id]) !== JSON.stringify(value),
                    ),
                ),
                removals: Object.keys(was).filter((id) => !Object.hasOwn(copy, id)),
            });
            continue;
        }
        if (Object.hasOwn(nextFields, key) && after !== undefined) {
            set[key] = after;
        } else {
            unset.push(key);
        }
    }
    if (Object.keys(set).length > 0 || unset.length > 0) {
        setChatMeta(ref, set, unset);
    }
    for (const { key, entries, removals } of merges) {
        mergeChatMeta(ref, key, entries, removals);
    }
}

/**
 * Applies a whole character's chats handed back by a plugin (last writer wins): chats matched by id
 * take the incoming version (a diff against the current mirror), new ones are created, missing ones
 * deleted (unless a generation runs in them), and the order follows the incoming list. Changes to a
 * message being generated are skipped with a warning.
 */
export function reconcileCharacterChats(chaId: string, incoming: readonly DeepReadonly<Chat>[], chatPage?: number) {
    const character = findCharacter(chaId);
    if (!character || !Array.isArray(incoming)) {
        return;
    }
    if (!chatsLoaded(chaId)) {
        // The caller pins and loads them first (`loadChats`); a chat diffed against a summary would be lost.
        throw new Error(`The chats of ${chaId} are not loaded`);
    }
    const chats = clone<Chat[]>(incoming).filter((chat) => chat && typeof chat === "object");
    const seen = new Set<string>();
    for (const chat of chats) {
        if (!isValidId(chat.id) || seen.has(chat.id)) {
            chat.id = uuidv4();
        }
        seen.add(chat.id);
    }
    for (const chat of chats) {
        const ref = { chaId, chatId: chat.id! };
        if (isMember(ref)) {
            try {
                applyChatResult(captureChatBaseline(ref), chat);
            } catch (error) {
                console.warn(
                    "[Chat] Skipped a plugin change to a chat (a message being generated, or a refused field)",
                    error,
                );
            }
        } else {
            createChat(chaId, chat);
        }
    }
    const incomingIds = new Set(chats.map((chat) => chat.id!));
    for (const id of memberIds(chaId)) {
        if (!incomingIds.has(id) && memberIds(chaId).length > 1) {
            try {
                deleteChat({ chaId, chatId: id });
            } catch (error) {
                console.warn("[Chat] Kept a chat a plugin removed", error);
            }
        }
    }
    const members = memberIds(chaId);
    const order = chats.map((chat) => chat.id!).filter((id) => members.includes(id));
    const rest = members.filter((id) => !order.includes(id));
    reorderChats(chaId, [...order, ...rest]);
    if (typeof chatPage === "number") {
        selectChat(chaId, chatPage);
    }
}

// ---------------------------------------------------------------------------------------------
// Boot

/**
 * Installs classified boot intent under its original identity, without applying resends to the mirror.
 * Even pending batches may already have reached the server, so they become isolated in-doubt
 * resends with their original id/base and retry identity. src/ts/storage/journalRecovery.ts drafts
 * dependent pending work first. Creates install their original snapshot/id; deletes remove the
 * mirror only after the caller's whole read checked generation locks, and still require another chat.
 */
export function installRecoveredChat(
    ref: ChatRef,
    intent: { groupId: string; snapshot: Chat } | Pick<Resend, "groupId" | "ops" | "baseRevision">,
    createdAt: number,
) {
    requireCharacter(ref.chaId);
    const key = keyOf(ref.chaId, ref.chatId);
    if (pending.has(key) || inflight.has(key) || quarantined.has(key)) {
        throw new Error("Chat recovery requires a chat without local work");
    }
    const create = "snapshot" in intent;
    const deleting = !create && intent.ops.some((op) => op.op === "delete");
    if (create) {
        if (isMember(ref) || chatRevisions.has(key) || intent.snapshot.id !== ref.chatId) {
            throw new Error("Recovered create requires its original absent chat id");
        }
    } else if (!isMember(ref) || !chatRevisions.has(key)) {
        throw new Error("Recovered resend requires an existing chat");
    }
    if (deleting && (memberIds(ref.chaId).length <= 1 || isChatGenerating(ref))) {
        throw new Error("Recovered delete requires another chat and no generation");
    }
    const copy = clone<typeof intent>(intent);
    const seq = nextSeq();
    if ("snapshot" in copy) {
        settleHypaV3Data(key, copy.snapshot, undefined);
        insertChat(ref.chaId, memberIds(ref.chaId).length, copy.snapshot);
        changed(key);
    } else if (deleting) {
        removeChat(ref.chaId, ref.chatId);
        notifyRemoval(ref);
        changed(key);
    }
    pending.set(key, {
        characterId: ref.chaId,
        chatId: ref.chatId,
        create,
        groupId: create ? intent.groupId : uuidv4(),
        ops: [],
        seq,
        ...("snapshot" in copy
            ? { resend: null, recoveredAt: createdAt }
            : { resend: { ...copy, seq, inDoubt: true, recoveredAt: createdAt } }),
    });
    syncSelection(ref.chaId);
    notifyWork();
}

/** Queues the classified vector even when recovery's membership changes already put it in order. */
export function installRecoveredOrder(chaId: string, ids: readonly string[]) {
    reorderChats(chaId, ids);
    pendingOrders.set(chaId, nextSeq());
    notifyWork();
}

/** Records what the server holds (boot read: chats or their summaries), before anything queues work. */
export function seedChats(
    chats: readonly { characterId: string; id: string; revision: string }[],
    orders: readonly ChatOrderRecord[],
) {
    chatRevisions.clear();
    ackedRevisions.clear();
    absentChats.clear();
    parkedResends.clear();
    orderRevisions.clear();
    staleChats.clear();
    noticedChats.clear();
    idleReadStamps.clear();
    for (const chat of chats) {
        chatRevisions.set(keyOf(chat.characterId, chat.id), chat.revision);
    }
    for (const order of orders) {
        orderRevisions.set(order.characterId, order.revision);
    }
}

/**
 * A character's chats in their server order: the order's ids that name a chat, then the chats the
 * order misses (each reported). The boot assembly's rule, also for detached reads.
 */
export function orderChats(chaId: string, chats: readonly ChatRecord[], ids: readonly string[]): Chat[] {
    return orderRecords(chaId, chats, ids).map((record) => record.data);
}

/** `orderChats` over any records with an id (full chats or summaries). */
function orderRecords<T extends { id: string }>(chaId: string, records: readonly T[], ids: readonly string[]): T[] {
    const available = new Map(records.map((record) => [record.id, record]));
    const ordered: T[] = [];
    for (const id of ids) {
        const record = available.get(id);
        if (record) {
            ordered.push(record);
            available.delete(id);
        } else {
            console.error(`[Chat] The chat order of ${chaId} names a missing chat ${id}`);
        }
    }
    for (const record of available.values()) {
        console.error(`[Chat] Chat ${record.id} of ${chaId} is missing from its chat order`);
        ordered.push(record);
    }
    return ordered;
}

/** A chat of a server read: a whole chat (`ChatRecord`) or its summary (`ChatSummary`). */
type ListedChat = ChatRecord | ChatSummary;

function listedData(record: ListedChat): Chat | undefined {
    return "data" in record && record.data ? record.data : undefined;
}

/** A listed chat's list fields (from the chat, or the summary's own fields). */
function listedMeta(record: ListedChat): ChatEntryMeta {
    return metaOf(listedData(record) ?? (record as ChatSummary));
}

/**
 * Holds every character's chats in their server order (the boot read), replacing whatever was held:
 * `characters` are the characters the boot read returned (only their `chaId` is read; chats of
 * other characters are not held). A summary is held as an unloaded chat (the boot reads summaries);
 * a whole chat is held loaded.
 */
export function assembleChats(
    characters: readonly ({ chaId: string } | null | undefined)[],
    chats: readonly ListedChat[],
    orders: readonly ChatOrderRecord[],
) {
    const byCharacter = new Map<string, ListedChat[]>();
    for (const record of chats) {
        let list = byCharacter.get(record.characterId);
        if (!list) {
            list = [];
            byCharacter.set(record.characterId, list);
        }
        list.push(record);
    }
    const orderOf = new Map(orders.map((order) => [order.characterId, order.ids]));
    for (const key of Object.keys(held)) {
        delete held[key];
    }
    for (const key of messagePositions.keys()) dropMessagePositions(key);
    loadedKeys.clear();
    pins.clear();
    lastUse.clear();
    loading.clear();
    selectedLoad.key = "";
    selectedLoad.token = 0;
    assemblyEpoch += 1;
    for (const character of characters) {
        if (!character) {
            continue;
        }
        const chaId = character.chaId;
        setChatList(
            chaId,
            orderRecords(chaId, byCharacter.get(chaId) ?? [], orderOf.get(chaId) ?? []).map((record) => {
                const data = listedData(record);
                return data ? { id: record.id, chat: data } : { id: record.id, meta: listedMeta(record) };
            }),
        );
    }
    mutationToken += 1;
}

/** Selects each character's remembered chat after boot (and gives chatless characters a chat). */
export function initializeChats() {
    loadSelectionPreference();
    for (const character of characterData()) {
        if (!character) {
            continue;
        }
        const chaId = character.chaId as string;
        ensureChat(chaId);
        syncSelection(chaId);
    }
}

// ---------------------------------------------------------------------------------------------
// Save loop

/** Whether any chat work waits to be sent or a deferred reload can run. */
export function hasChatWork(canSaveCharacter: (id: string) => boolean = () => true): boolean {
    // Empty entries still need takeChatWork to settle them once earlier in-flight work resolves.
    for (const [key, entry] of pending) {
        if (
            !quarantined.has(key) &&
            !deferred.has(key) &&
            !inflight.has(key) &&
            !isJobBlocked(key) &&
            canSaveCharacter(entry.characterId)
        ) {
            return true;
        }
    }
    return (
        [...pendingOrders.keys()].some(
            (id) =>
                canSaveCharacter(id) &&
                !recoveringOrders.has(id) &&
                !isOrderQuarantined(id) &&
                orderMembershipReady(id),
        ) ||
        deferredReloads().length > 0 ||
        idleChatRefreshes().length > 0 ||
        idleSummaryRefreshes().length > 0
    );
}

/**
 * Whether a reorder of `chaId` could go out now: every chat the server holds is in the mirror, or
 * its delete can be sent (not blocked, deferred, quarantined, or in flight). `takeChatWork` holds a
 * reorder back otherwise, so it is unsaved but not runnable (a delete refused for a generating
 * message makes the reorder wait for the same retry).
 */
function orderMembershipReady(chaId: string): boolean {
    if (!findCharacter(chaId)) {
        return false;
    }
    const visible = new Set(memberIds(chaId));
    const prefix = `${chaId}\u0000`;
    return [...chatRevisions.keys()].every((key) => {
        if (!key.startsWith(prefix) || visible.has(key.slice(prefix.length)) || !serverHolds(key)) {
            // A chat the server no longer has needs no delete before the reorder.
            return true;
        }
        const entry = pending.get(key);
        return (
            queuesDelete(entry) &&
            !quarantined.has(key) &&
            !deferred.has(key) &&
            !inflight.has(key) &&
            !isJobBlocked(key)
        );
    });
}

/** Unsaved user work, including requests in flight. */
export function hasUnsavedChatWork(canSaveCharacter: (id: string) => boolean = () => true): boolean {
    for (const key of new Set([...pending.keys(), ...inflight.keys()])) {
        if (!quarantined.has(key) && canSaveCharacter(key.split("\u0000")[0])) {
            return true;
        }
    }
    return [...pendingOrders.keys(), ...inflightOrders.keys(), ...recoveringOrders.keys()].some(
        (id) => canSaveCharacter(id) && !isOrderQuarantined(id),
    );
}

function isOrderQuarantined(chaId: string): boolean {
    const refused = quarantinedOrders.get(chaId);
    if (refused === undefined) {
        return false;
    }
    // The ids `takeChatWork` would send now (before this batch's creates).
    if (sendableOrderText(chaId) === refused.ids) {
        return true;
    }
    clearOrderRefusal(chaId);
    return false;
}

function sendableOrderText(chaId: string): string {
    return JSON.stringify(memberIds(chaId).filter((id) => serverHolds(keyOf(chaId, id))));
}

export function quarantineChatOrder(order: SentChatOrder, reason = language.chatOrderRefused) {
    inflightOrders.delete(order.characterId);
    quarantinedOrders.set(order.characterId, { ids: JSON.stringify(order.ids), reason });
    notifyRefusals();
    if (!pendingOrders.has(order.characterId)) {
        pendingOrders.set(order.characterId, order.seq);
    }
    if (!orderAlerts.has(order.characterId)) {
        orderAlerts.add(order.characterId);
        alertError(`${language.chatOrderRefused}\n${reason}`);
    }
}

export type RefusedChatItem =
    | { kind: "chat"; key: string; reason: string; chaId: string; chatId: string }
    | { kind: "order"; key: string; reason: string; chaId: string };

/** Reactive, read-only refusal inventory. A refused delete still owns intent without a local chat. */
export function refusedChatItems(): RefusedChatItem[] {
    void refusalVersion;
    const items: RefusedChatItem[] = [];
    for (const [key, refused] of quarantined) {
        const [chaId, chatId] = key.split("\u0000");
        if (findCharacter(chaId) && (isMember({ chaId, chatId }) || refused.delete)) {
            items.push({ kind: "chat", key: `chats\u0000${key}`, reason: refused.reason, chaId, chatId });
        }
    }
    for (const [chaId, refused] of quarantinedOrders) {
        if (findCharacter(chaId) && sendableOrderText(chaId) === refused.ids) {
            items.push({ kind: "order", key: `chatOrder\u0000${chaId}`, reason: refused.reason, chaId });
        }
    }
    return items;
}

/** Refused local intent protects page close, but is not runnable save work. */
export function hasRefusedChatWork(): boolean {
    return refusedChatItems().length > 0;
}

/**
 * Releases only at an explicit edit/retry. A loaded chat sends its whole current copy on the held
 * revision; an unloaded chat replays retained metadata ops without inventing an empty transcript.
 * Recovered work is replayed from its ops, since its effects are not in the boot mirror.
 */
function releaseChatRefusal(ref: ChatRef): "snapshot" | "ops" | false {
    const key = keyOf(ref.chaId, ref.chatId);
    const refused = quarantined.get(key);
    if (!refused) return false;
    const chat = heldChat(ref);
    const entry = pendingFor(ref, true);
    const seq = nextSeq();
    if (refused.recovered && chatRevisions.has(key)) {
        entry.create = false;
        entry.resend = null;
        entry.ops = [
            ...refused.ops.map((op): ChatOp =>
                op.op === "create" ? { op: "replace", chat: withoutProjection(op.chat) } : op,
            ),
            ...entry.ops,
        ];
        entry.seq = seq;
        staleChats.add(key);
    } else if (refused.delete && !isMember(ref)) {
        if (refused.create) {
            pending.delete(key);
            settleKey(key, seq);
        } else {
            entry.create = false;
            entry.resend = null;
            entry.ops = [{ op: "delete" }];
            entry.seq = seq;
        }
    } else {
        entry.create = refused.create;
        entry.resend = null;
        entry.ops =
            chat && !refused.recovered
                ? refused.create
                    ? []
                    : [{ op: "replace", chat: sendChat(chat) }]
                : [...refused.ops, ...entry.ops];
        entry.seq = seq;
    }
    clearChatRefusal(key);
    dirtyChatJournal(key, "pending");
    dirtyChatJournal(key, "resend");
    return chat && !refused.recovered ? "snapshot" : "ops";
}

/** Explicit retry of one chat or order from the refusal inventory. */
export function retryRefusedChat(key: string): boolean {
    const item = refusedChatItems().find((item) => item.key === key);
    if (!item) return false;
    if (item.kind === "chat") {
        releaseChatRefusal(item);
    } else {
        pendingOrders.set(item.chaId, nextSeq());
        clearOrderRefusal(item.chaId);
    }
    notifyWork();
    return true;
}

/** Applies a server copy only while this exact refusal and owner still survive the read. */
export async function discardRefusedChat(key: string, canApply: () => boolean): Promise<boolean> {
    const item = refusedChatItems().find((item) => item.key === key);
    if (!item) return false;
    const owner = chatOwnerToken(item.chaId);
    if (item.kind === "chat") {
        const chatKey = keyOf(item.chaId, item.chatId);
        const refused = quarantined.get(chatKey);
        const readStamp = issueChatReadStamp();
        const read = await readRefs([], { chats: [{ characterId: item.chaId, id: item.chatId }] });
        if (!canApply() || chatOwnerToken(item.chaId) !== owner || quarantined.get(chatKey) !== refused) return false;
        const server = read.chats?.find((chat) => chat.characterId === item.chaId && chat.id === item.chatId);
        if (!server) return false;
        acceptRemoteChat({ ...server, readStamp } as RemoteChat, 0, { capture: false });
        clearChatRefusal(chatKey);
    } else {
        const refused = quarantinedOrders.get(item.chaId);
        const seq = pendingOrders.get(item.chaId);
        const read = await readRefs([], { chatSummaryCollections: [item.chaId] });
        if (
            !canApply() ||
            chatOwnerToken(item.chaId) !== owner ||
            quarantinedOrders.get(item.chaId) !== refused ||
            pendingOrders.get(item.chaId) !== seq ||
            sendableOrderText(item.chaId) !== refused?.ids
        )
            return false;
        const collection = read.chatSummaryCollections?.find((collection) => collection.characterId === item.chaId);
        if (!collection) return false;
        acceptRemoteCollection(collection, { captureOrder: false });
        clearOrderRefusal(item.chaId);
    }
    notifyWork();
    return true;
}

/**
 * Prepares the chats a new character brings (an import, a plugin, a creation), in place: one chat
 * when it has none, valid and unique chat ids, message ids, and the character's chat defaults.
 */
function prepareCharacterChats(chats: Chat[], character: { firstMsgIndex?: unknown }): Chat[] {
    if (chats.length === 0) {
        chats.push({ id: uuidv4(), message: [], note: "", name: "Chat 1", localLore: [] });
    }
    const ids = new Set<string>();
    for (const chat of chats) {
        prepareChatInput(chat, character);
        if (!isValidId(chat.id) || ids.has(chat.id)) {
            chat.id = uuidv4();
        }
        ids.add(chat.id);
        chat.message ??= [];
        prepareMessages(chat.message, new Set());
        delete chat.isStreaming;
        delete chat.activeStreamingDisplayOptimizationMode;
    }
    return chats;
}

/**
 * Holds the chats of a character that is about to enter the character list (`characterStore`'s
 * add and replace), prepared (`prepareCharacterChats`), replacing anything held under `chaId`.
 * A new character's caller queues its creates with `adoptCharacter` after insertion. A reused
 * character id reconciles the chats the server holds or may receive from earlier work: its character record
 * stays an update, so the save loop will not adopt its replacement chats. The revisions stay held
 * until the server acknowledges the old character's deletion (`ackCharacterDelete`), so a re-add
 * after a deletion that failed or was refused reconciles the same way. Unsent work is superseded,
 * but an unacknowledged create keeps its payload for replay before the replacement or deletion, also
 * one the deletion's collection settled (`parkedResends`, restored here first). A reused id whose old
 * delete is in flight is created after that delete settles.
 * The caller has finished every check that can refuse the character first, and drops the held chats
 * (`forgetCharacterChats`) if insertion throws; the save loop then forgets the absent owner's work.
 *
 * A replacement based on a revision another tab changed follows the usual conflict reload, which
 * discards that chat's replacement with a notice. A chat another tab created that this client never
 * saw survives on the server; reconciliation can delete only chats this client knows about.
 */
export function installCharacterChats(chaId: string, chats: Chat[], character: { firstMsgIndex?: unknown }) {
    const prefix = `${chaId}\u0000`;
    restoreParkedResends(chaId);
    const known = new Set(
        [
            ...chatRevisions.keys(),
            ...quarantined.keys(),
            ...inflight.keys(),
            ...[...pending].filter(([, entry]) => entry.create || entry.resend).map(([key]) => key),
        ].filter((key) => key.startsWith(prefix)),
    );
    const reconcile =
        known.size > 0 || orderRevisions.has(chaId) || pendingOrders.has(chaId) || inflightOrders.has(chaId);
    renewLifetime(chaId);
    dropLoadState(chaId);
    const prepared = prepareCharacterChats(chats, character);
    for (const chat of prepared) {
        // Only a chat the mirror holds whole is an existing one here: of any other, nothing says what
        // the field is, and a value this drops would be lost with the chat's `replace`.
        settleHypaV3Data(keyOf(chaId, chat.id!), chat, heldChat({ chaId, chatId: chat.id! }));
    }
    setChatList(chaId, loadedEntries(prepared));
    // Explicit recreation supersedes the refused intent; reconciliation below queues its replacement.
    for (const key of known) clearChatRefusal(key);
    if (reconcile) {
        const ids = new Set(memberIds(chaId));
        for (const key of known) {
            const chatId = key.slice(prefix.length);
            if (ids.has(chatId)) {
                continue;
            }
            const entry = pending.get(key);
            const seq = nextSeq();
            if (!chatRevisions.has(key) && !inflight.has(key) && !entry?.resend) {
                // Only a never-sent create existed: nothing needs deleting on the server.
                pending.delete(key);
                settleKey(key, seq);
            } else {
                pending.set(key, {
                    characterId: chaId,
                    chatId,
                    groupId: uuidv4(),
                    create: false,
                    resend: entry?.resend ?? null,
                    ops: [{ op: "delete" }],
                    seq,
                });
            }
            staleChats.delete(key);
            noticedChats.delete(key);
            deferred.delete(key);
            jobBlocked.delete(key);
        }
        for (const chat of chatsOf(chaId)) {
            const key = keyOf(chaId, chat.id!);
            const entry = pendingFor({ chaId, chatId: chat.id! }, true);
            const sending = inflight.get(key);
            // A delete in flight will remove the base, so the reused id needs a create after it settles.
            entry.create =
                sending?.ops[0]?.op === "delete" ||
                !!entry.resend?.ops.some((op) => op.op === "delete") ||
                (!chatRevisions.has(key) && !sending && !entry.resend);
            entry.ops = entry.create ? [] : [{ op: "replace", chat: sendChat(chat) }];
            entry.seq = nextSeq();
            dirtyChatJournal(key, "pending");
        }
        // The reorder waits until the queued deletes can leave a permutation of the server's list.
        pendingOrders.set(chaId, nextSeq());
    }
    mutationToken += 1;
    syncSelection(chaId);
    if (reconcile) {
        notifyWork();
    }
}

/**
 * Puts the resends a deletion of the character parked (`parkedResends`) back in front of its chats'
 * work, so the re-add reconciles those chats; a chat that has a resend of its own keeps that one.
 */
function restoreParkedResends(chaId: string) {
    const parked = parkedResends.get(chaId);
    parkedResends.delete(chaId);
    for (const [key, { chatId, resend }] of parked ?? []) {
        const entry = pending.get(key);
        if (!entry) {
            pending.set(key, { characterId: chaId, chatId, groupId: uuidv4(), create: false, resend, ops: [], seq: 0 });
        } else if (!entry.resend) {
            entry.resend = resend;
            dirtyChatJournal(key, "resend");
        }
    }
}

/**
 * Keeps the resends of a character's chats whose group may have landed (`parkedResends`) before its
 * deletion settles them. A create resend that is not in doubt (no attempt of it can have landed; a
 * rollback keeps an earlier attempt's doubt) of a chat this client holds no revision of is not kept.
 */
function parkResends(chaId: string) {
    const prefix = `${chaId}\u0000`;
    const parked = parkedResends.get(chaId) ?? new Map<string, { chatId: string; resend: Resend }>();
    for (const [key, entry] of pending) {
        if (!key.startsWith(prefix) || !entry.resend) {
            continue;
        }
        if (isCreateResend(entry) && !entry.resend.inDoubt && !chatRevisions.has(key)) {
            continue;
        }
        parked.set(key, { chatId: entry.chatId, resend: entry.resend });
    }
    if (parked.size > 0) {
        parkedResends.set(chaId, parked);
    }
}

/**
 * The server confirmed a character gone (its deletion acknowledged, or another writer's): its chats'
 * groups still in flight (an unload request) are of the deleted chats. Their obligation is settled
 * now and they leave `inflight`, so their late answer is ignored (`settleUnloadWork`): it neither
 * holds a deleted chat's revision nor requeues work for it, and a chat of a character re-added under
 * the id meanwhile is not held back by them.
 */
function retireCharacterGroups(chaId: string) {
    const prefix = `${chaId}\u0000`;
    for (const [key, group] of [...inflight]) {
        if (key.startsWith(prefix)) {
            settleKey(key, group.seq);
            inflight.delete(key);
        }
    }
}

/**
 * Drops the chats held for a character that left the list (a local removal or replacement), or did
 * not enter it after all (its insertion threw): its chats, selection, and pins. The save loop settles
 * its chat work when it sends the character's deletion (`settleCharacterDelete`) and forgets the
 * revisions it holds of them when the server acknowledges it (`ackCharacterDelete`).
 */
export function forgetCharacterChats(chaId: string) {
    dropHeld(chaId);
    delete chosen[slot(chaId)];
    dropLoadState(chaId);
    renewLifetime(chaId);
    notifyRemoval({ chaId, chatId: null });
}

/** Drops a character's pins (character and chat pins), recency stamps, and loads in flight (a reset of its chats). */
function dropLoadState(chaId: string) {
    const prefix = `${chaId}\u0000`;
    pins.delete(chaId);
    for (const map of [pins, lastUse, loading] as Map<string, unknown>[]) {
        for (const key of [...map.keys()]) {
            if (key.startsWith(prefix)) {
                map.delete(key);
            }
        }
    }
}

/**
 * Gives a character new to the list its first chat when it holds none, and its chats their message
 * ids and defaults, without queuing anything (`adoptCharacter` queues the creates after insertion).
 */
export function normalizeNewCharacter(chaId: string) {
    const character = findCharacter(chaId);
    if (!character) {
        return;
    }
    if (memberIds(chaId).length === 0) {
        insertChat(chaId, 0, { id: uuidv4(), message: [], note: "", name: "Chat 1", localLore: [] });
    }
    for (const chat of chatsOf(chaId)) {
        dropMessagePositions(keyOf(chaId, chat.id!));
        prepareChatInput(chat, character);
        chat.message ??= [];
        prepareMessages(chat.message, new Set());
    }
    mutationToken += 1;
    syncSelection(chaId);
}

/** Queues creates for a new character's chats on insertion and for unsaved chats found by the save loop. */
export function adoptCharacter(chaId: string) {
    if (!findCharacter(chaId)) {
        return;
    }
    normalizeNewCharacter(chaId);
    for (const chatId of memberIds(chaId)) {
        const key = keyOf(chaId, chatId);
        const entry = pending.get(key);
        if (
            !chatRevisions.has(key) &&
            !entry?.create &&
            !entry?.resend &&
            !inflight.has(key) &&
            !quarantined.has(key)
        ) {
            const created = pendingFor({ chaId, chatId });
            created.create = true;
            created.seq = nextSeq();
            dirtyChatJournal(key, "pending");
        }
    }
}

/**
 * Drops all local chat state after a character's deletion or a conflicting create. With `discard`
 * (another writer deleted it), the chats' unsent work and a queued reorder count as
 * discarded (the flush and `MutationScope` reports, `markDiscarded`); returns whether there was any.
 * A queued delete the deletion fulfils is settled. This tab's own deletion settles them all instead
 * (`ackCharacterDelete`, once the server acknowledged it). Groups still in flight are retired
 * (`retireCharacterGroups`) and the parked resends dropped, so late answers cannot restore that state.
 * With `capture`, keeps eligible work as drafts even when settling it: a conflicting parent create
 * supersedes its local chats, with the discard reported on the character itself.
 */
export function forgetCharacter(chaId: string, options: { discard?: boolean; capture?: boolean } = {}): boolean {
    if ((options.discard || options.capture) && conflictListener) {
        const prefix = `${chaId}\u0000`;
        const keys = new Set([
            ...pending.keys(),
            ...inflight.keys(),
            ...quarantined.keys(),
            ...(parkedResends.get(chaId)?.keys() ?? []),
        ]);
        for (const key of keys) {
            if (key.startsWith(prefix)) captureChatConflict(key, { gone: true, fulfilledDelete: true });
        }
        captureQueuedOrder(chaId);
        captureSentOrder(recoveringOrders.get(chaId));
        captureSentOrder(inflightOrders.get(chaId));
    }
    const discardedWork = dropCharacterWork(chaId, options.discard === true);
    retireCharacterGroups(chaId);
    parkedResends.delete(chaId);
    forgetCharacterRevisions(chaId);
    notifyRemoval({ chaId, chatId: null });
    return discardedWork;
}

/**
 * Drops a character's chat work and local chat state: its refresh marks and feed locks, its chats'
 * queued work and queued reorder (settled, or with `discard` reported as discarded), its held chats,
 * selection, and loads. What the server holds (`forgetCharacterRevisions`) is kept, and so are the
 * resends that may have landed (`parkResends`) unless another writer deleted the character
 * (`discard`).
 */
function dropCharacterWork(chaId: string, discard: boolean): boolean {
    const prefix = `${chaId}\u0000`;
    let discardedWork = false;
    if (!discard) {
        parkResends(chaId);
    }
    releaseFeedLocks(prefix);
    for (const key of [...staleChats, ...deferred, ...noticedChats.keys()]) {
        if (key.startsWith(prefix)) {
            staleChats.delete(key);
            noticedChats.delete(key);
            deferred.delete(key);
        }
    }
    // A remote deletion also counts work only in flight (an unload request that may still answer).
    for (const key of new Set([...pending.keys(), ...(discard ? inflight.keys() : [])])) {
        if (!key.startsWith(prefix)) {
            continue;
        }
        if (discard && (pending.get(key)?.create || !hasUnsentDelete(key))) {
            markDiscarded(key, workSeq(key));
            discardedWork = true;
        } else {
            settleKey(key, workSeq(key));
        }
        pending.delete(key);
    }
    const orderSeq = pendingOrders.get(chaId);
    if (orderSeq !== undefined) {
        if (discard) {
            markOrderDiscarded(chaId, orderSeq);
            discardedWork = true;
        } else {
            settleOrder(chaId, orderSeq);
        }
    }
    pendingOrders.delete(chaId);
    const recoveringOrder = recoveringOrders.get(chaId);
    if (recoveringOrder) {
        if (discard) {
            markOrderDiscarded(chaId, recoveringOrder.seq);
            discardedWork = true;
        } else {
            settleOrder(chaId, recoveringOrder.seq);
        }
        recoveringOrders.delete(chaId);
    }
    dropHeld(chaId);
    delete chosen[slot(chaId)];
    dropLoadState(chaId);
    renewLifetime(chaId);
    return discardedWork;
}

/** Forgets what the server held of a character's chats: their revisions and retry blocks, its order. */
function forgetCharacterRevisions(chaId: string) {
    const prefix = `${chaId}\u0000`;
    for (const key of [...chatRevisions.keys(), ...ackedRevisions.keys(), ...jobBlocked.keys()]) {
        if (key.startsWith(prefix)) {
            dropChatRevision(key);
            jobBlocked.delete(key);
        }
    }
    orderRevisions.delete(chaId);
    clearOrderRefusal(chaId);
    for (const key of quarantined.keys()) {
        if (key.startsWith(prefix)) clearChatRefusal(key);
    }
}

/**
 * This tab's deletion of a character is collected (the save loop sends it): its chats' work is
 * settled (the deletion removes those chats), but the revisions this client holds of them stay until
 * the server acknowledges the deletion (`ackCharacterDelete`). A deletion that fails, is refused for
 * a generating message, or is still in flight when the same id is added again leaves the server with
 * the character's chats, and the re-added character's chats are reconciled against them by chat id
 * (`installCharacterChats`) as for a re-add before the deletion was collected; the resends settled
 * here are kept for that (`parkedResends`).
 */
export function settleCharacterDelete(chaId: string) {
    dropCharacterWork(chaId, false);
}

/**
 * The server acknowledged this tab's deletion of a character (its chats and their order went with
 * it): its chat state is forgotten. A character added again under the id while the deletion was in
 * flight keeps its chats: the reconciliation queued against the deleted chats is replaced by a create
 * of every chat in mirror order, which goes with the character's own create (the save loop's next
 * cycle sends it, its saved record being gone). Groups of the deleted chats still in flight are
 * retired (`retireCharacterGroups`): their late answer changes nothing.
 */
export function ackCharacterDelete(chaId: string) {
    const prefix = `${chaId}\u0000`;
    for (const key of quarantined.keys()) {
        if (key.startsWith(prefix)) {
            // The refused chat was of the deleted incarnation: a chat of a later one under its id is
            // a new create.
            clearChatRefusal(key);
        }
    }
    if (!findCharacter(chaId)) {
        forgetCharacter(chaId);
        return;
    }
    releaseFeedLocks(prefix);
    for (const key of [...staleChats, ...deferred, ...noticedChats.keys()]) {
        if (key.startsWith(prefix)) {
            staleChats.delete(key);
            noticedChats.delete(key);
            deferred.delete(key);
        }
    }
    forgetCharacterRevisions(chaId);
    for (const [key, entry] of [...pending]) {
        if (!key.startsWith(prefix)) {
            continue;
        }
        if (isMember({ chaId, chatId: entry.chatId })) {
            // Its server copy is gone: the create sends the mirror's chat, which holds every change.
            pending.set(key, { ...entry, groupId: uuidv4(), create: true, resend: null, ops: [], seq: workSeq(key) });
        } else {
            // A delete of a chat the character's deletion removed.
            settleKey(key, workSeq(key));
            pending.delete(key);
        }
    }
    const orderSeq = pendingOrders.get(chaId);
    if (orderSeq !== undefined) {
        // The creates go in mirror order.
        settleOrder(chaId, orderSeq);
        pendingOrders.delete(chaId);
    }
    parkedResends.delete(chaId);
    const recoveringOrder = recoveringOrders.get(chaId);
    if (recoveringOrder) {
        settleOrder(chaId, recoveringOrder.seq);
        recoveringOrders.delete(chaId);
    }
    // After the conversion above (whose sequences cover these groups'), before the creates.
    retireCharacterGroups(chaId);
    adoptCharacter(chaId);
    notifyWork();
}

/** Whether the server knows a character's chats (its order exists) or this batch creates it. */
function isCharacterKnown(chaId: string, creating: ReadonlySet<string>): boolean {
    return orderRevisions.has(chaId) || creating.has(chaId);
}

function memberIndex(entry: Pending): number {
    return holdingAt(entry.characterId)?.ids.indexOf(entry.chatId) ?? -1;
}

/**
 * Takes the chat work for one batch and marks it in flight: first creates (never-sent chats as they
 * are in the mirror, per character in mirror order; sent-but-unacknowledged creates exactly as
 * sent), then every other chat with unsent work, then reorders. `creating` names characters the
 * same batch creates; chat work of characters not yet on the server waits. A chat with more unsent
 * ops than `maxOps` (the server's cap on one request) holds the first part as a resend until the
 * journal confirms the split. The rest follows its acknowledgement, on the revision it produces;
 * its work counts as saved only when the last part is. Reorders wait behind in-doubt membership resends and `holdOrders` (characters whose
 * chat list still needs a read after an acknowledgement): their base may be stale.
 */
export function takeChatWork(
    creating: ReadonlySet<string>,
    options: { maxOps?: number; holdOrders?: ReadonlySet<string> } = {},
): ChatWork {
    const maxOps = options.maxOps ?? Infinity;
    // A quarantined character create may be removed or re-keyed before ever reaching the server.
    // There is no persisted character deletion to clear its old chat obligations in that case. A
    // saved character's deletion that waits (refused for a generating message) keeps the revisions
    // its re-add reconciles against (`settleCharacterDelete`).
    for (const id of new Set([...pending.values()].map((entry) => entry.characterId))) {
        if (!findCharacter(id)) {
            dropCharacterWork(id, false);
        }
    }
    const groups: SentChatGroup[] = [];
    const createdHere = new Set<string>();
    const deletedHere = new Set<string>();
    const eligible = [...pending.entries()].filter(
        ([key]) => !quarantined.has(key) && !deferred.has(key) && !inflight.has(key) && !isJobBlocked(key),
    );
    const creates = eligible
        .filter(([, entry]) => entry.create || entry.resend)
        .sort(([, a], [, b]) =>
            a.characterId === b.characterId ? memberIndex(a) - memberIndex(b) : a.characterId < b.characterId ? -1 : 1,
        );
    for (const [key, entry] of creates) {
        if (!isCharacterKnown(entry.characterId, creating)) {
            continue;
        }
        if (entry.resend) {
            // It may have landed: resend exactly what was sent, alone and with its own sequence and
            // id, so its replay can be recognized; later work follows once it is answered, in a
            // group of its own (a replay answered as a duplicate never carries it down).
            const { resend } = entry;
            if (resend.unconfirmed) continue;
            const group = sentGroup(key, entry, resend.baseRevision, resend.ops, resend.groupId, resend.seq, resend);
            inflight.set(key, group);
            if (entry.create || entry.ops.length > 0 || entry.seq > resend.seq) {
                // The newer work stays, also an empty entry whose newer sequence a flush may wait for.
                pending.set(key, { ...entry, resend: null });
            } else {
                pending.delete(key);
            }
            groups.push(group);
            if (resend.ops[0]?.op === "create") {
                createdHere.add(key);
            } else if (resend.ops.some((op) => op.op === "delete")) {
                deletedHere.add(key);
            }
            continue;
        }
        const base = chatRevisions.get(key);
        if (queuesDelete(entry) && base !== undefined) {
            // Delete the old incarnation alone. The recreation keeps its sequence until its own
            // create is answered, even when this deletion needs a replay or conflict recovery.
            const group = sentGroup(key, entry, base, [{ op: "delete" }], entry.groupId, 0);
            inflight.set(key, group);
            pending.set(key, { ...entry, groupId: uuidv4(), ops: [] });
            groups.push(group);
            deletedHere.add(key);
            continue;
        }
        const ref = { chaId: entry.characterId, chatId: entry.chatId };
        const chat = isMember(ref) ? heldChat(ref) : undefined;
        if (!chat) {
            pending.delete(key);
            settleKey(key, entry.seq);
            continue;
        }
        const ids = memberIds(entry.characterId);
        const index = ids.slice(0, ids.indexOf(entry.chatId)).filter((otherId) => {
            const otherKey = keyOf(entry.characterId, otherId);
            return serverHolds(otherKey) || createdHere.has(otherKey);
        }).length;
        // The mirror copy already holds every queued change.
        const group = sentGroup(key, entry, null, [{ op: "create", chat: sendChat(chat), index }], entry.groupId);
        inflight.set(key, group);
        pending.delete(key);
        groups.push(group);
        createdHere.add(key);
    }
    for (const [key, entry] of eligible) {
        if (entry.create || entry.resend || !isCharacterKnown(entry.characterId, creating)) {
            continue;
        }
        const base = chatRevisions.get(key);
        if (base === undefined) {
            // Not on the server yet: its create is in flight or waits for its character; drop work
            // for a chat that is gone and was never created.
            if (!isMember({ chaId: entry.characterId, chatId: entry.chatId }) && !inflight.has(key)) {
                pending.delete(key);
                settleKey(key, entry.seq);
            }
            continue;
        }
        if (entry.ops.length === 0) {
            pending.delete(key);
            settleKey(key, entry.seq);
            continue;
        }
        const deleting = entry.ops.some((op) => op.op === "delete");
        if (deleting) {
            deletedHere.add(key);
        }
        const ops = deleting ? [{ op: "delete" } as ChatOp] : entry.ops;
        if (ops.length > maxOps) {
            // The old id must not reach the server as a prefix while its recoverable row still
            // names the whole batch. Journal the split before sending the prefix, whose sequence
            // settles nothing; the remainder keeps the original flush obligation.
            pending.set(key, {
                ...entry,
                groupId: uuidv4(),
                ops: ops.slice(maxOps),
                resend: {
                    ops: ops.slice(0, maxOps),
                    baseRevision: base,
                    groupId: entry.groupId,
                    seq: 0,
                    inDoubt: false,
                    unconfirmed: true,
                },
            });
            continue;
        }
        const group = sentGroup(key, entry, base, ops, entry.groupId);
        inflight.set(key, group);
        pending.delete(key);
        groups.push(group);
    }
    const orders: SentChatOrder[] = [];
    for (const [chaId, seq] of pendingOrders) {
        const base = orderRevisions.get(chaId);
        if (
            base === undefined ||
            !findCharacter(chaId) ||
            inflightOrders.has(chaId) ||
            recoveringOrders.has(chaId) ||
            isOrderQuarantined(chaId) ||
            options.holdOrders?.has(chaId) ||
            groups.some(
                (group) =>
                    group.characterId === chaId &&
                    group.inDoubt &&
                    group.ops.some((op) => op.op === "create" || op.op === "delete"),
            )
        ) {
            continue;
        }
        const visible = new Set(memberIds(chaId));
        const prefix = `${chaId}\u0000`;
        const serverAfter = [...new Set([...chatRevisions.keys(), ...createdHere])].filter(
            (key) => key.startsWith(prefix) && !deletedHere.has(key) && (serverHolds(key) || createdHere.has(key)),
        );
        if (serverAfter.some((key) => !visible.has(key.slice(prefix.length)))) {
            // The server will still hold a chat the mirror no longer shows (its delete is not in
            // this batch): the reorder waits until the list can be a permutation of the server's.
            continue;
        }
        const ids = memberIds(chaId).filter((id) => {
            const key = keyOf(chaId, id);
            return (serverHolds(key) || createdHere.has(key)) && !deletedHere.has(key);
        });
        const order = { characterId: chaId, baseRevision: base, ids, seq };
        orders.push(order);
        inflightOrders.set(chaId, order);
        pendingOrders.delete(chaId);
    }
    return { groups, orders };
}

function sentGroup(
    key: string,
    entry: Pending,
    baseRevision: string | null,
    ops: ChatOp[],
    groupId: string,
    seq = entry.seq,
    resend: Resend | null = null,
): SentChatGroup {
    const create = ops[0]?.op === "create" ? ops[0] : null;
    return {
        key,
        characterId: entry.characterId,
        chatId: entry.chatId,
        baseRevision,
        ops,
        seq,
        groupId,
        ...(resend ? { resent: true as const } : {}),
        ...(resend?.inDoubt ? { inDoubt: true as const } : {}),
        ...((resend?.recoveredAt ?? entry.recoveredAt) !== undefined
            ? { recoveredAt: resend?.recoveredAt ?? entry.recoveredAt }
            : {}),
        // The chat as it is on the server if the create landed.
        ...(create ? { expected: canonicalChat(create.chat) } : {}),
    };
}

/** A chat in the form the server stores it (the defaults it adds), for comparisons. */
function canonicalChat(chat: Chat): string {
    const copy = withoutProjection(clone(chat) as Chat);
    delete copy.isStreaming;
    delete copy.activeStreamingDisplayOptimizationMode;
    copy.name ??= "";
    copy.note ??= "";
    copy.localLore ??= [];
    copy.fmIndex ??= -1;
    copy.message?.forEach((message) => dropInvalidTranslation(message));
    return canonical(copy);
}

/** The JSON of the `chats` and `chatOrders` parts of a batch body. */
export function chatWorkBody(work: ChatWork): { chats: string[]; chatOrders: string[] } {
    return {
        chats: work.groups.map((group) =>
            JSON.stringify({
                characterId: group.characterId,
                chatId: group.chatId,
                baseRevision: group.baseRevision,
                groupId: group.groupId,
                ...(group.inDoubt ? { retry: true } : {}),
                ops: group.ops,
            }),
        ),
        chatOrders: work.orders.map((order) =>
            JSON.stringify({ characterId: order.characterId, baseRevision: order.baseRevision, ids: order.ids }),
        ),
    };
}

/**
 * Puts taken reorders on the order revision this client knows now. A cycle that needs several
 * requests acknowledges the creates and deletes of an earlier request before a later one goes out;
 * that acknowledgement moved the order revision, and the reorder taken with them would otherwise
 * conflict with this client's own write. Only own acknowledgements move it here (a reorder another
 * tab made still conflicts and recovers).
 */
export function rebaseChatOrders(work: ChatWork) {
    for (const order of work.orders) {
        const current = orderRevisions.get(order.characterId);
        if (current !== undefined) {
            order.baseRevision = current;
            dirtyOrderJournal(order.characterId, "sent");
        }
    }
}

function settleKey(key: string, seq: number) {
    if ((settled.get(key) ?? 0) < seq) {
        settled.set(key, seq);
    }
}

function settleOrder(chaId: string, seq: number) {
    if ((ordersSettled.get(chaId) ?? 0) < seq) {
        ordersSettled.set(chaId, seq);
    }
}

/**
 * Records the server's answer to chat work that was saved. Returns the characters whose chat list
 * on the server differs from this client's membership, or whose membership replay acknowledgement
 * lacks an order result: their list is to be read again before any reorder is sent.
 */
export function ackChatWork(
    work: ChatWork,
    results: readonly ChatGroupResult[],
    orders: readonly ChatOrderResult[],
): string[] {
    const refresh = new Set<string>();
    const placedByOrders = new Map(orders.map((order) => [order.characterId, new Set(order.ids)]));
    work.groups.forEach((group, index) => {
        const previousRevision = chatRevisions.get(group.key);
        inflight.delete(group.key);
        jobBlocked.delete(group.key);
        const result = results[index];
        if (result) {
            if (conflictListener && result.targets?.includes("missing")) {
                let targetIndex = 0;
                const missingOps = group.ops.filter((op) => {
                    if (
                        op.op !== "setText" &&
                        op.op !== "setMessage" &&
                        op.op !== "patchMessage" &&
                        op.op !== "setTranslation"
                    )
                        return false;
                    return result.targets![targetIndex++] === "missing";
                });
                if (missingOps.length) {
                    conflictListener({
                        scope: "chat",
                        target: group.key,
                        layers: {
                            pending: {
                                ops: journalOps(missingOps),
                                baseRevision: group.baseRevision,
                                groupId: group.groupId,
                            },
                        },
                    });
                }
            }
            if (
                group.inDoubt &&
                group.ops.some((op) => op.op === "create" || op.op === "delete") &&
                !placedByOrders.has(group.characterId)
            ) {
                // A membership replay can answer only its chat revision. Read the order before
                // sending a queued reorder on the revision from before that membership change.
                refresh.add(group.characterId);
            }
            if (result.revision === null) {
                dropChatRevision(group.key);
                staleChats.delete(group.key);
                noticedChats.delete(group.key);
            } else if (
                (!result.stale || !chatRevisions.has(group.key)) &&
                (compareRevision(result.revision, chatRevisions.get(group.key) ?? result.revision) ?? 1) >= 0
            ) {
                // A group applied on an older revision leaves the older base: this client has not
                // seen every change up to the new revision. A newer revision held already (a load
                // installed a later read while the group was in flight) is not moved back.
                holdChatRevision(group.key, result.revision);
            }
            if (result.revision !== null && group.ops[0]?.op === "create" && absentChats.has(group.key)) {
                if (placedByOrders.get(group.characterId)?.has(group.chatId)) {
                    absentChats.delete(group.key);
                } else {
                    // A replay can lack an order result: the list must decide membership.
                    refresh.add(group.characterId);
                }
            }
            const held = chatRevisions.get(group.key);
            if (
                held !== undefined &&
                (compareRevision(result.revision, held) ?? -1) > 0 &&
                !belowAckedRevision(group.key, result.revision)
            ) {
                // The base stays older than this group's result: no copy below the result may replace
                // the mirror, which holds this group's edit (`ackedRevisions`).
                ackedRevisions.set(group.key, result.revision);
            }
            if (
                (group.recoveredAt !== undefined || result.stale || result.targets?.includes("missing")) &&
                result.revision !== null
            ) {
                // A `missing` target changed nothing and is kept as a draft, without a discard:
                // the idle read removes its local message. Recovered ops were never applied to the
                // boot mirror, so even a fresh or duplicate acknowledgement needs the whole read.
                staleChats.add(group.key);
            }
            if (result.messageIds) {
                adoptMessageIds(group, result.messageIds);
            }
        }
        settleKey(group.key, group.seq);
        if (
            result &&
            !pending.has(group.key) &&
            !inflight.has(group.key) &&
            (!result.stale || chatRevisions.get(group.key) !== previousRevision)
        ) {
            recordChatInstall(group.key);
        }
    });
    for (const order of orders) {
        const prefix = `${order.characterId}\u0000`;
        const known = new Set(
            [...chatRevisions.keys()]
                .filter((key) => key.startsWith(prefix) && serverHolds(key))
                .map((key) => key.slice(prefix.length)),
        );
        if (order.ids.length === known.size && order.ids.every((id) => known.has(id))) {
            orderRevisions.set(order.characterId, order.revision);
        } else {
            // The older revision stays, so a reorder conflicts (and recovers) instead of being refused.
            refresh.add(order.characterId);
        }
    }
    for (const order of work.orders) {
        inflightOrders.delete(order.characterId);
        settleOrder(order.characterId, order.seq);
    }
    return [...refresh];
}

/**
 * The server renamed messages of the group's last create or replace (a missing, invalid, or
 * duplicate id): rename them in the mirror (all at once, by occurrence), in queued ops, and in the
 * chat's streaming entry.
 */
function adoptMessageIds(group: SentChatGroup, ids: readonly string[]) {
    const last = [...group.ops].reverse().find((op) => op.op === "create" || op.op === "replace") as
        { chat: Chat } | undefined;
    const sent = last?.chat.message ?? [];
    const renames = new Map<string, string[]>();
    let any = false;
    sent.forEach((message, index) => {
        const next = ids[index] ?? message.chatId!;
        const list = renames.get(message.chatId!) ?? [];
        list.push(next);
        renames.set(message.chatId!, list);
        any ||= next !== message.chatId;
    });
    if (!any) {
        return;
    }
    const ref = { chaId: group.characterId, chatId: group.chatId };
    const chat = heldChat(ref);
    dropMessagePositions(group.key);
    const firstRename = new Map([...renames].map(([id, values]) => [id, values[0]]));
    if (chat) {
        for (const message of chat.message) {
            const list = renames.get(message.chatId!);
            const next = list?.shift();
            if (next !== undefined && next !== message.chatId) {
                message.chatId = next;
            }
        }
        changed(group.key);
    }
    const rename = (id: string) => firstRename.get(id) ?? id;
    const entry = pending.get(group.key);
    for (const op of entry?.ops ?? []) {
        const before = beforeValues.get(op);
        if (
            (op.op === "setMessage" || (op.op === "remove" && op.ids.length === 1)) &&
            before &&
            "value" in before &&
            isPlainRecord(before.value) &&
            typeof before.value.chatId === "string"
        ) {
            before.value.chatId = rename(before.value.chatId);
        }
        if (op.op === "setText" || op.op === "setTranslation" || op.op === "patchMessage") {
            op.id = rename(op.id);
        } else if (op.op === "setMessage") {
            op.message = { ...op.message, chatId: rename(op.message.chatId!) };
        } else if (op.op === "remove") {
            op.ids = op.ids.map(rename);
        } else if (op.op === "append" && "after" in op.anchor) {
            op.anchor = { after: rename(op.anchor.after) };
        }
    }
    dirtyChatJournal(group.key, "pending");
    const streamed = streamingChats[keyOf(ref.chaId, ref.chatId)];
    if (streamed !== undefined) {
        streamed.messageId = rename(streamed.messageId);
    }
}

/**
 * Puts chat work that was not saved (a failed or rolled-back request) back in front of newer work.
 * With `lost` (no answer came: the request may have landed) every group becomes a resend of exactly
 * what was sent, with its id (`Resend.inDoubt`); so does a create, a group that was itself a resend
 * (it keeps its doubt), and a group with a newer create behind it. Any other group is merged in front
 * of the newer ops.
 */
export function requeueChatWork(work: ChatWork, options: { lost?: boolean } = {}) {
    for (const group of work.groups) {
        inflight.delete(group.key);
        const newer = pending.get(group.key);
        if (group.ops[0]?.op === "create" || options.lost || group.resent || newer?.create) {
            // Kept apart and resent as it was; newer work (a recreation included) waits behind it.
            pending.set(group.key, {
                characterId: group.characterId,
                chatId: group.chatId,
                groupId: newer?.groupId ?? uuidv4(),
                create: newer?.create ?? false,
                resend: {
                    ops: group.ops,
                    seq: group.seq,
                    baseRevision: group.baseRevision,
                    groupId: group.groupId,
                    inDoubt: !!options.lost || !!group.inDoubt,
                    ...(group.recoveredAt !== undefined ? { recoveredAt: group.recoveredAt } : {}),
                },
                ops: newer?.ops ?? [],
                seq: newer?.seq ?? 0,
            });
            continue;
        }
        pending.set(group.key, {
            characterId: group.characterId,
            chatId: group.chatId,
            groupId: group.groupId,
            create: false,
            resend: newer?.resend ?? null,
            ops: [...group.ops, ...(newer?.ops ?? [])],
            seq: Math.max(group.seq, newer?.seq ?? 0),
        });
    }
    for (const order of work.orders) {
        inflightOrders.delete(order.characterId);
        if (!pendingOrders.has(order.characterId)) {
            pendingOrders.set(order.characterId, order.seq);
        }
    }
}

/** Holds refused work locally, reporting it discarded to flush callers, until an explicit release. */
export function quarantineChat(
    group: Pick<SentChatGroup, "key" | "seq" | "ops" | "recoveredAt">,
    reason = language.chatSaveRefused,
    alertText = `${language.chatSaveRefused}\n${reason}`,
) {
    const entry = pending.get(group.key);
    const ops = [...group.ops, ...(entry?.resend?.ops ?? []), ...(entry?.ops ?? [])];
    const seq = Math.max(group.seq, workSeq(group.key));
    inflight.delete(group.key);
    jobBlocked.delete(group.key);
    const [chaId, chatId] = group.key.split("\u0000");
    quarantined.set(group.key, {
        reason,
        ops: clone(ops).map((op, index) => copyOpBefore(ops[index], op)),
        create: (!chatRevisions.has(group.key) && !!entry?.create) || ops.some((op) => op.op === "create"),
        delete: !isMember({ chaId, chatId }) && ops.some((op) => op.op === "delete"),
        ...(group.recoveredAt !== undefined ? { recovered: true as const } : {}),
    });
    notifyRefusals();
    deferred.delete(group.key);
    staleChats.delete(group.key);
    pending.delete(group.key);
    markDiscarded(group.key, seq);
    if (!chatAlerts.has(group.key)) {
        chatAlerts.add(group.key);
        alertError(alertText);
    }
}

function quarantineRefusedCreate(group: Pick<SentChatGroup, "key" | "seq" | "ops">) {
    quarantineChat(group, language.chatCreateRefused, language.chatCreateRefused);
}

function markDiscarded(key: string, seq: number) {
    discardSequence += 1;
    discarded.set(key, discardSequence);
    settleKey(key, seq);
}

/**
 * A queued reorder replaced by the server's order: keyed by the character id alone, as the order
 * obligations are, so the flush report names it `chats/<characterId>`.
 */
function markOrderDiscarded(chaId: string, seq: number) {
    discardSequence += 1;
    discarded.set(chaId, discardSequence);
    settleOrder(chaId, seq);
}

/**
 * A whole server chat read (revision and data null: gone). `streaming`, when present, is authoritative
 * even when empty; `readStamp` is client-only, captured at issue to fence it against later feed lists,
 * `hello`, and honored reads. Without both, adoption keeps the revision-based lock release rule.
 */
export type RemoteChat = {
    characterId: string;
    id: string;
    revision: string | null;
    data: Chat | null;
    streaming?: StreamingMessage[];
    readStamp?: number;
};

/**
 * Handles the chat part of a 409 (the whole batch was rolled back). Work that did not conflict is
 * queued again. For each conflicting chat, with the server's copy read back: our own create or
 * delete that already landed (a replay) keeps the local state and the rest of its work; a chat a
 * server job locks is deferred (excluded from batches, reloaded when the job ends); a chat that is
 * gone is dropped with its work and its character's chat list is to be refreshed (`refresh`); a group
 * refused for an `append` whose anchor is gone is retried at the end (`reanchorGoneAppends`), unless
 * its id expired (`expired`: `reason: "expired"`) and it may already have landed; any
 * other is replaced by the server copy and its local work discarded. Expired recovered groups
 * quarantine their ops and newer work for explicit Retry/Discard and durable journaling.
 * Reorders that conflicted keep
 * their sent vectors until a collection read distinguishes a lost answer from a discarded reorder.
 * A group refused for a generating message (`generating`: `reason: "generating"`) is kept and retried
 * after `JOB_RETRY_MS`, not reloaded, except its edits of the locked messages the conflict names
 * (`lockedMessages`, see `dropLockedEdits`). Returns `{ reloaded, refresh, refreshOrders, blocked }`:
 * `reloaded` decides the reload notice, `refresh` names the lists to read, `refreshOrders` the lists
 * to read while keeping a queued reorder, and `blocked` signals retained work blocked by a generation.
 * A refused create's quarantine has its own alert.
 */
export function recoverChatConflicts(
    work: ChatWork,
    conflicted: ReadonlySet<string>,
    conflictedOrders: ReadonlySet<string>,
    remote: readonly RemoteChat[],
    generating: ReadonlySet<string> = new Set(),
    lockedMessages: ReadonlyMap<string, readonly string[]> = new Map(),
    expired: ReadonlySet<string> = new Set(),
): { reloaded: boolean; refresh: Set<string>; refreshOrders: Set<string>; blocked: boolean } {
    const byKey = new Map(remote.map((chat) => [keyOf(chat.characterId, chat.id), chat]));
    const retry: SentChatGroup[] = [];
    const refresh = new Set<string>();
    const refreshOrders = new Set<string>();
    let reloaded = false;
    let blocked = false;
    for (const group of work.groups) {
        inflight.delete(group.key);
        if (group.recoveredAt !== undefined && expired.has(group.key)) {
            quarantineChat(group, language.chatRecoveryExpired);
            continue;
        }
        if (generating.has(group.key)) {
            const outcome = dropLockedEdits(group, new Set(lockedMessages.get(group.key) ?? []));
            if (outcome.dropped) {
                reloaded = true;
            }
            if (outcome.kept.length > 0) {
                // Refused, so not applied (the server answers a known id before the lock check):
                // no longer in doubt, and a new id once its ops changed.
                retry.push({
                    ...group,
                    ops: outcome.kept,
                    inDoubt: undefined,
                    groupId: outcome.kept === group.ops ? group.groupId : uuidv4(),
                });
            }
            if (outcome.waiting) {
                jobBlocked.set(group.key, Date.now() + JOB_RETRY_MS);
                blocked = true;
            }
            continue;
        }
        const server = byKey.get(group.key);
        if (!conflicted.has(group.key) || !server) {
            retry.push(group);
            continue;
        }
        const ref = { chaId: group.characterId, chatId: group.chatId };
        const create = group.ops[0]?.op === "create";
        if (
            !expired.has(group.key) &&
            create &&
            server.revision !== null &&
            server.data &&
            group.expected === canonicalChat(server.data)
        ) {
            // Our create (and the rest of its group) landed before the answer was lost: the whole
            // group is settled at the server's revision, so none of its ops applies a second time.
            holdChatRevision(group.key, server.revision);
            if (group.recoveredAt !== undefined) staleChats.add(group.key);
            settleKey(group.key, group.seq);
            refreshOrders.add(group.characterId);
            continue;
        }
        if (group.ops.some((op) => op.op === "delete") && server.revision === null) {
            dropChatRevision(group.key);
            refreshOrders.add(group.characterId);
            if (pending.get(group.key)?.create) {
                // The chat was created again under its id: that create follows.
                settleKey(group.key, group.seq);
            } else {
                settleKey(group.key, Math.max(group.seq, workSeq(group.key)));
                pending.delete(group.key);
            }
            continue;
        }
        if (create && server.revision === null) {
            // This create never landed. Keep the local chat; a missing parent is recovered by
            // the character read, and retrying this same group would loop.
            quarantineRefusedCreate(group);
            refresh.add(group.characterId);
            continue;
        }
        const reanchored =
            !expired.has(group.key) && server.revision !== null && server.data
                ? reanchorGoneAppends(group, server)
                : null;
        if (reanchored) {
            // An append whose anchor another writer removed: retried at the end, nothing discarded
            // (also while a job streams here, since the chat is not replaced), alone and on its
            // base, so newer work that needs the current revision cannot make it conflict again.
            // The chat is read whole once its work has landed, which puts the messages in the
            // server's order.
            retry.push({ ...group, ops: reanchored, groupId: uuidv4(), resent: true, inDoubt: undefined });
            staleChats.add(group.key);
            continue;
        }
        if (isChatStreamedHere(ref)) {
            // A server job streams into it: replacing the chat now would drop the streamed text.
            deferred.add(group.key);
            retry.push(group);
            continue;
        }
        if (server.revision === null) {
            // Gone on the server (another tab deleted it): the character's list is read again. Its
            // work is discarded now, with the notice, also when that read waits for a generation.
            captureChatConflict(group.key, { group, gone: true });
            discardChatWork(group.key, group.seq);
            dropChatRevision(group.key);
            refresh.add(group.characterId);
            reloaded = true;
            continue;
        }
        if (!isMember(ref)) {
            // Deleted here but kept on the server (the delete conflicted): the character's list is
            // read again, which puts the chat back at its server position.
            captureChatConflict(group.key, { group });
            discardChatWork(group.key, group.seq);
            holdChatRevision(group.key, server.revision);
            refresh.add(group.characterId);
            reloaded = true;
            continue;
        }
        acceptRemoteChat(server, group.seq, { group });
        reloaded = true;
    }
    requeueRecovered(retry);
    const orders = work.orders.filter((order) => !conflictedOrders.has(order.characterId));
    requeueChatWork({ groups: [], orders });
    for (const order of work.orders) {
        if (conflictedOrders.has(order.characterId)) {
            // The sent snapshot, not the current mirror, decides whether its answer was lost.
            inflightOrders.delete(order.characterId);
            recoveringOrders.set(order.characterId, order);
            refresh.add(order.characterId);
        }
    }
    return { reloaded, refresh, refreshOrders, blocked };
}

/**
 * A group refused because an `append`'s `after` anchor is gone on the server (another writer removed
 * it; the server copy was read back): rewrites each such append, in the refused group and in the
 * chat's newer unsent work, to `{ end: true }`. Anchors are checked against the message ids as the
 * ops in order leave them (appends add theirs, a single-id `remove` takes its id away). Only for
 * by-id work on the same chat incarnation: a group holding an op that needs the current revision
 * (`create`, `delete`, `replace`, a multi-id `remove`) or a `begin` would conflict again on the older
 * base, so it is left to the ordinary recovery, as is a group with a recreation queued behind it.
 * The repaired group is resent alone, so the newer work, whatever it holds, follows in a
 * group of its own and takes its own chances. Returns the refused group's rewritten ops, or null
 * when none of its appends had a gone anchor (the conflict has another cause; the newer work is then
 * left as it is). A retried group whose conflict has another cause finds no gone anchor on its next
 * recovery.
 */
function reanchorGoneAppends(group: SentChatGroup, server: RemoteChat): ChatOp[] | null {
    const newer = pending.get(group.key);
    const base = parseRevisionToken(group.baseRevision);
    const read = parseRevisionToken(server.revision);
    if (
        !base ||
        !read ||
        base.epoch !== read.epoch ||
        base.seq !== read.seq ||
        newer?.create ||
        newer?.resend ||
        group.ops.some(
            (op) =>
                op.op === "create" ||
                op.op === "delete" ||
                op.op === "replace" ||
                op.op === "begin" ||
                (op.op === "remove" && op.ids.length > 1),
        )
    ) {
        return null;
    }
    const present = new Set(server.data!.message.map((message) => message.chatId!));
    const reanchor = (ops: ChatOp[]): boolean => {
        let rewritten = false;
        ops.forEach((op, index) => {
            if (op.op === "append") {
                if ("after" in op.anchor && !present.has(op.anchor.after)) {
                    ops[index] = copyOpBefore(op, { ...op, anchor: { end: true } });
                    rewritten = true;
                }
                for (const message of op.messages) {
                    present.add(message.chatId!);
                }
            } else if (op.op === "remove") {
                present.delete(op.ids[0]);
            }
        });
        return rewritten;
    };
    const ops = [...group.ops];
    if (!reanchor(ops)) {
        return null;
    }
    if (newer && reanchor(newer.ops)) {
        dirtyChatJournal(group.key, "pending");
    }
    return ops;
}

/** Whether an op rewrites or removes one of `locked` by id (a multi-id `remove` does not count). */
function targetsLocked(op: ChatOp, locked: ReadonlySet<string>): boolean {
    switch (op.op) {
        case "setText":
        case "patchMessage":
        case "setTranslation":
        case "begin":
            return locked.has(op.id);
        case "setMessage":
            return locked.has(op.message.chatId!);
        case "remove":
            return op.ids.length === 1 && locked.has(op.ids[0]);
        default:
            return false;
    }
}

/**
 * A group the server refused because a generation job owns messages it touches (`locked`, the
 * conflict's `messageIds`): its by-id edits of those messages, and those of the chat's newer unsent
 * work, are dropped, since a retry after the job would land over the finished reply. They count as
 * discarded (the flush report and the reload notice), and the chat is marked stale, so it is read
 * whole once its remaining work has landed (the mirror then shows the server's message again; the
 * split itself leaves the held revision unchanged). Everything else (chat-level ops, a multi-id `remove`,
 * which needs the current revision, ops on other messages) stays on the retry-after-job path:
 * `kept` is requeued and `waiting` says whether the chat is to be blocked until the retry. With
 * nothing named, or nothing dropped, the whole group waits, as before. The sent group's sequence is
 * settled when none of it is kept; newer work keeps its own.
 */
function dropLockedEdits(
    group: SentChatGroup,
    locked: ReadonlySet<string>,
): { kept: ChatOp[]; dropped: boolean; waiting: boolean } {
    const newer = pending.get(group.key);
    const filtered = group.ops.filter((op) => !targetsLocked(op, locked));
    const kept = filtered.length === group.ops.length ? group.ops : filtered;
    const newerKept = newer?.ops.filter((op) => !targetsLocked(op, locked)) ?? [];
    const dropped = kept.length < group.ops.length || (newer !== undefined && newerKept.length < newer.ops.length);
    if (!dropped) {
        return { kept: group.ops, dropped: false, waiting: true };
    }
    if (conflictListener) {
        const removed = group.ops.filter((op) => targetsLocked(op, locked));
        const removedPending = newer?.ops.filter((op) => targetsLocked(op, locked)) ?? [];
        conflictListener({
            scope: "chat",
            target: group.key,
            layers: {
                ...(removed.length ? { resend: resendLayer({ ...group, ops: removed }) } : {}),
                ...(removedPending.length
                    ? {
                          pending: {
                              ops: journalOps(removedPending),
                              baseRevision: chatRevisions.get(group.key) ?? null,
                              groupId: newer!.groupId,
                          },
                      }
                    : {}),
            },
        });
    }
    discardSequence += 1;
    discarded.set(group.key, discardSequence);
    staleChats.add(group.key);
    if (kept.length === 0) {
        settleKey(group.key, group.seq);
    }
    if (newer) {
        newer.ops = newerKept;
        dirtyChatJournal(group.key, "pending");
        if (newerKept.length === 0 && !newer.create && !newer.resend && kept.length === 0) {
            pending.delete(group.key);
            settleKey(group.key, newer.seq);
        }
    }
    return { kept, dropped: true, waiting: kept.length > 0 || pending.has(group.key) };
}

/**
 * Requeues recovered groups: ordinary work is merged in front of the newer ops. A group sent or
 * repaired as a resend stays one (the 409 rolled it back unanswered, or recovery isolated it), as does
 * a create (a recognized create is settled, never requeued).
 */
function requeueRecovered(groups: readonly SentChatGroup[]) {
    for (const group of groups) {
        if (
            group.baseRevision !== null &&
            group.ops[0]?.op !== "create" &&
            !group.resent &&
            !pending.get(group.key)?.create
        ) {
            const newer = pending.get(group.key);
            pending.set(group.key, {
                characterId: group.characterId,
                chatId: group.chatId,
                groupId: group.groupId,
                create: false,
                resend: null,
                ops: [...group.ops, ...(newer?.ops ?? [])],
                seq: Math.max(group.seq, newer?.seq ?? 0),
            });
        } else {
            requeueChatWork({ groups: [group], orders: [] });
        }
    }
}

function discardChatWork(key: string, seq: number) {
    const highest = Math.max(seq, workSeq(key));
    pending.delete(key);
    inflight.delete(key);
    staleChats.delete(key);
    jobBlocked.delete(key);
    markDiscarded(key, highest);
}

/**
 * Replaces a chat in the mirror with the server's copy and discards its local work. A chat that is
 * gone on the server is removed (a character left without chats gets a new one).
 */
export function acceptRemoteChat(
    server: RemoteChat,
    seq = 0,
    options: { group?: SentChatGroup; capture?: boolean } = {},
) {
    const key = keyOf(server.characterId, server.id);
    if (options.capture !== false) captureChatConflict(key, { group: options.group, gone: server.revision === null });
    discardChatWork(key, seq);
    applyRemoteChat(server);
}

/**
 * Applies a server copy without settling or discarding any work (callers establish eligibility). A
 * loaded chat takes the copy; a member that is not loaded, or a chat new to the list, takes its
 * summary only (a server copy never loads a chat). The copy is a whole read, so unlike a job's it
 * speaks for `hypaV3Data` too: without a projection of its own, one held is gone (the records are, or
 * another algorithm is selected). Feed locks reconcile from its stamped snapshot, with the
 * revision-based fallback only when the snapshot or stamp is absent.
 */
function applyRemoteChat(server: RemoteChat) {
    const key = keyOf(server.characterId, server.id);
    staleChats.delete(key);
    dropFeedLocksOf(key, server.revision, server.streaming, server.readStamp);
    if (findCharacter(server.characterId)) {
        const ref = { chaId: server.characterId, chatId: server.id };
        if (server.revision === null || !server.data) {
            removeChat(server.characterId, server.id);
        } else if (!isMember(ref)) {
            insertSummary(server.characterId, memberIds(server.characterId).length, server.id, metaOf(server.data));
        } else if (isLoaded(ref)) {
            dropMessagePositions(key);
            holdingOf(server.characterId).chats[slot(server.id)] = server.data;
        } else {
            holdingOf(server.characterId).summaries[slot(server.id)] = metaOf(server.data);
        }
        changed(key);
        ensureChat(server.characterId);
        syncSelection(server.characterId);
        recordChatInstall(key);
    }
    if (server.revision === null) {
        dropChatRevision(key);
    } else {
        holdChatRevision(key, server.revision);
    }
    if (server.revision === null || !server.data) {
        notifyRemoval({ chaId: server.characterId, chatId: server.id });
    }
    remoteListener?.({ chaId: server.characterId, chatId: server.id });
}

/**
 * Whether a held chat may take a server copy now: no pending or in-flight work, generation of this
 * tab, deferral, quarantine, or unexpired retry block.
 */
function canRefreshChat(ref: ChatRef): boolean {
    const key = keyOf(ref.chaId, ref.chatId);
    return (
        !pending.has(key) &&
        !inflight.has(key) &&
        !isChatStreamedHere(ref) &&
        !deferred.has(key) &&
        !quarantined.has(key) &&
        !isJobBlocked(key)
    );
}

/** The stale and noticed chats as refs. */
function refreshMarks(): ChatRef[] {
    dropAnsweredNotices();
    return [...new Set([...staleChats, ...noticedChats.keys()])].map((key) => {
        const [chaId, chatId] = key.split("\u0000");
        return { chaId, chatId };
    });
}

/** Whether a refresh mark is of a member that is not loaded (refreshed through its character's summaries). */
function isUnloadedMember(ref: ChatRef): boolean {
    return isMember(ref) && !isLoaded(ref);
}

/**
 * Stale and noticed chats eligible for a whole-chat read inside the save cycle, never alongside a
 * batch: loaded ones (and ones no longer listed). A member that is not loaded is refreshed through
 * its character's summary list instead (`idleSummaryRefreshes`).
 */
export function idleChatRefreshes(): ChatRef[] {
    return refreshMarks().filter((ref) => canRefreshChat(ref) && !isUnloadedMember(ref));
}

/**
 * The characters whose summary list is to be read inside the save cycle: they have a stale or noticed
 * member that is not loaded and is idle here, and no order work (`canApplyRemoteCollection`). The
 * list is applied by `applyRemoteCollection`, then `settleSummaryRefresh` ends those marks.
 */
export function idleSummaryRefreshes(): string[] {
    const ids = new Set<string>();
    for (const ref of refreshMarks()) {
        if (
            isUnloadedMember(ref) &&
            canRefreshChat(ref) &&
            findCharacter(ref.chaId) &&
            canApplyRemoteCollection(ref.chaId)
        ) {
            ids.add(ref.chaId);
        }
    }
    return [...ids];
}

/** The notice sequences of the refresh-marked chats of `chaIds`, taken when their summary lists are read. */
export function summaryRefreshNotices(chaIds: readonly string[]): Map<string, number> {
    const wanted = new Set(chaIds);
    const notices = new Map<string, number>();
    for (const [key, notice] of noticedChats) {
        if (wanted.has(key.split("\u0000")[0])) {
            notices.set(key, notice.seq);
        }
    }
    return notices;
}

/**
 * Ends the refresh marks of a character's idle unloaded members that its summary list, read after
 * those marks (`notices`: each mark's notice sequence when the read was issued) and applied, answers:
 * a member the list shows at or below its held revision (the list's newer summaries were adopted), or
 * one the list no longer has (its removal, or the list's last-chat rule, settles it; a replacement
 * comes with its own notice). A list older than the held order answers nothing; a notice that arrived
 * during the read, or announces a revision the held one does not cover, keeps its mark.
 */
export function settleSummaryRefresh(
    collection: { characterId: string; order: ChatOrderRecord | null; chats: readonly ListedChat[] },
    notices: ReadonlyMap<string, number>,
) {
    const chaId = collection.characterId;
    const heldOrder = orderRevisions.get(chaId);
    if (
        collection.order &&
        heldOrder !== undefined &&
        (compareRevision(collection.order.revision, heldOrder) ?? 0) < 0
    ) {
        return;
    }
    const byId = new Map(collection.chats.map((chat) => [chat.id, chat]));
    for (const id of memberIds(chaId)) {
        const ref = { chaId, chatId: id };
        const key = keyOf(chaId, id);
        if (!isUnloadedMember(ref) || !canRefreshChat(ref) || (!staleChats.has(key) && !noticedChats.has(key))) {
            continue;
        }
        const record = byId.get(id);
        const heldRevision = chatRevisions.get(key);
        const covers = (revision: string) =>
            heldRevision !== undefined && (compareRevision(revision, heldRevision) ?? 1) <= 0;
        if (record && (!covers(record.revision) || ackedRevisions.has(key))) {
            // Not adopted, or the held copy is older than an acknowledgement of this client's edit.
            continue;
        }
        staleChats.delete(key);
        const notice = noticedChats.get(key);
        if (
            notice &&
            notice.seq <= (notices.get(key) ?? 0) &&
            (notice.revision === null || !record || covers(notice.revision))
        ) {
            noticedChats.delete(key);
        }
    }
    scheduleTrim();
}

/** The sequence of a chat's latest notice (0 without one), taken before its read for `finishIdleChatRefresh`. */
export function chatNoticeSeq(ref: ChatRef): number {
    return noticedChats.get(keyOf(ref.chaId, ref.chatId))?.seq ?? 0;
}

/**
 * Rechecks eligibility after the read's await; busy chats retain their refresh mark for later. A
 * notice that arrived during the read (a later sequence than `notice`) keeps its mark: the read
 * may predate the change it announced. A chat the read found gone is removed only if the revision
 * held when the read was issued (`issued`) is still the held one (a job's chat event may have
 * installed a newer copy meanwhile: the mark stays and the chat is read again); it is removed
 * without creating a replacement chat (that would be a write), and the last chat of a character is
 * left in place for the writer's own new chat to replace through the character's chat list.
 */
export function finishIdleChatRefresh(server: RemoteChat, notice = 0, issued?: string | null): boolean {
    const key = keyOf(server.characterId, server.id);
    if (!staleChats.has(key) && !noticedChats.has(key)) {
        laterIdleReadOut(key, server.readStamp);
        return false;
    }
    const taken = adoptChatRead(server, notice, issued);
    if (taken && server.revision !== null && laterIdleReadOut(key, server.readStamp)) {
        // A later read of this chat is out: the copy that took may predate what that read was asked
        // for (a job's end), so the mark stays for its copy.
        staleChats.add(key);
    }
    return taken;
}

/**
 * Whether an idle read of the chat issued after the one `readStamp` answers is still out; the newest
 * read's answer ends the bookkeeping, whether or not its copy took.
 */
function laterIdleReadOut(key: string, readStamp: number | undefined): boolean {
    const newest = idleReadStamps.get(key);
    if (newest === undefined || readStamp === undefined) {
        return false;
    }
    if (newest <= readStamp) {
        idleReadStamps.delete(key);
        return false;
    }
    return true;
}

/** The newest idle read stamp issued per chat (`noteIdleChatRead`), until that read answers. */
const idleReadStamps = new Map<string, number>();

/**
 * An idle read of the chat was issued with `readStamp` (`readIdleChats`): an earlier read's copy that
 * takes before this one answers leaves the stale mark, so this read's copy, asked for later, can take
 * too (`finishIdleChatRefresh` adopts only a stale or noticed chat).
 */
export function noteIdleChatRead(ref: ChatRef, readStamp: number): void {
    const key = keyOf(ref.chaId, ref.chatId);
    if ((idleReadStamps.get(key) ?? 0) < readStamp) {
        idleReadStamps.set(key, readStamp);
    }
}

/** Applies a chat read by ref under the idle refresh's safeguards (`finishIdleChatRefresh`, without its mark). */
function adoptChatRead(server: RemoteChat, notice: number, issued: string | null | undefined): boolean {
    const key = keyOf(server.characterId, server.id);
    if (!canRefreshChat({ chaId: server.characterId, chatId: server.id })) {
        return false;
    }
    const heldRevision = chatRevisions.get(key);
    if (
        server.revision !== null &&
        heldRevision !== undefined &&
        (compareRevision(server.revision, heldRevision) ?? 0) < 0
    ) {
        // A read older than a hydration that arrived meanwhile.
        return false;
    }
    if (server.revision !== null && belowAckedRevision(key, server.revision)) {
        // A read issued before an acknowledgement of this client's edit came back (a stale one, so
        // the held base is older): the copy lacks that edit. The marks stay for a newer read.
        return false;
    }
    if (server.revision === null && issued !== undefined && (heldRevision ?? null) !== issued) {
        return false;
    }
    if ((noticedChats.get(key)?.seq ?? 0) <= notice || server.revision === null) {
        noticedChats.delete(key);
    }
    if (server.revision === null) {
        removeRemoteChat(server.characterId, server.id);
        return true;
    }
    applyRemoteChat(server);
    return true;
}

/**
 * Removes a chat another writer deleted, found by an idle read: no replacement chat is created and
 * nothing is queued. The character's only chat stays (its writer created another one, which its chat
 * list brings, and the list then drops this one).
 */
function removeRemoteChat(chaId: string, chatId: string) {
    const key = keyOf(chaId, chatId);
    staleChats.delete(key);
    dropFeedLocksOf(key, null);
    const ids = findCharacter(chaId) ? memberIds(chaId) : [];
    const index = ids.indexOf(chatId);
    if (index !== -1 && ids.length === 1) {
        notifyRemoval({ chaId, chatId });
        return;
    }
    if (index !== -1) {
        removeChat(chaId, chatId);
        changed(key);
        syncSelection(chaId);
    }
    dropChatRevision(key);
    notifyRemoval({ chaId, chatId });
    remoteListener?.({ chaId, chatId });
}

/** The chat revisions this client holds for a character's chats (a collection read's deletion fence). */
export function heldChatRevisionsOf(chaId: string): Map<string, string> {
    return heldChatRevisionsByCharacter([chaId]).get(chaId)!;
}

/** `heldChatRevisionsOf` for several characters, in one pass over the held revisions. */
export function heldChatRevisionsByCharacter(chaIds: readonly string[]): Map<string, Map<string, string>> {
    const byCharacter = new Map(chaIds.map((chaId) => [chaId, new Map<string, string>()]));
    for (const [key, revision] of chatRevisions) {
        byCharacter.get(key.slice(0, key.indexOf("\u0000")))?.set(key, revision);
    }
    return byCharacter;
}

/** A queued or in-flight delete of this chat (the mirror no longer shows it). */
function hasUnsentDelete(key: string): boolean {
    return queuesDelete(pending.get(key)) || !!inflight.get(key)?.ops.some((op) => op.op === "delete");
}

/** Drops a chat's notice once `revision` covers what it announced. */
function settleNotice(key: string, revision: string) {
    const notice = noticedChats.get(key);
    if (notice && notice.revision !== null && (compareRevision(notice.revision, revision) ?? 1) <= 0) {
        noticedChats.delete(key);
    }
}

/**
 * A notice whose revision this client now holds (its own save landed, or a job's chat event applied
 * it) needs no read: dropped, unless the chat waits for an idle read anyway (`staleChats`).
 */
function dropAnsweredNotices() {
    for (const [key, notice] of noticedChats) {
        const heldRevision = chatRevisions.get(key);
        if (
            notice.revision !== null &&
            heldRevision !== undefined &&
            !staleChats.has(key) &&
            (compareRevision(notice.revision, heldRevision) ?? 1) <= 0
        ) {
            noticedChats.delete(key);
        }
    }
}

/**
 * A feed entry's summary knowledge for a member held only as its summary (not loaded): with
 * `summary` (the chat's summary at `revision`), that summary is held; with `summaryBase` equal to
 * the held revision, the held summary is still the chat's. Either way the chat's held revision
 * becomes `revision` and its notice is settled, with no summary list read. Only that summary and
 * revision change (membership, order, and order work are left alone). False, for the ordinary
 * notice: a loaded chat, a revision that is not newer, local work or a generation of this tab
 * (`canRefreshChat`), a chat marked stale, a revision below an acknowledgement of this client's
 * edit, a `summary` of another chat or revision, or a `summaryBase` that is not the held revision.
 */
function applyRemoteSummary(
    ref: ChatRef,
    revision: string,
    known: { summary?: ChatSummary; summaryBase?: string },
): boolean {
    const key = keyOf(ref.chaId, ref.chatId);
    const heldRevision = chatRevisions.get(key);
    if (
        !isMember(ref) ||
        isLoaded(ref) ||
        heldRevision === undefined ||
        (compareRevision(revision, heldRevision) ?? 0) <= 0 ||
        !canRefreshChat(ref) ||
        staleChats.has(key) ||
        belowAckedRevision(key, revision)
    ) {
        return false;
    }
    const summary: unknown = known.summary;
    if (summary !== undefined) {
        if (
            !isPlainRecord(summary) ||
            summary.characterId !== ref.chaId ||
            summary.id !== ref.chatId ||
            summary.revision !== revision
        ) {
            return false;
        }
        holdingAt(ref.chaId)!.summaries[slot(ref.chatId)] = listedMeta(summary as ChatSummary);
    } else if (known.summaryBase !== heldRevision) {
        return false;
    }
    holdChatRevision(key, revision);
    settleNotice(key, revision);
    changed(key);
    remoteListener?.(ref);
    return true;
}

/**
 * A live update says the server committed this chat at `revision` (null: deleted). A chat the mirror
 * holds at an older revision is read again once it is idle here (no local work, generation, retry
 * block, deferral, or quarantine; `idleChatRefreshes`); a notice at or below the held revision is
 * dropped (this tab's own save, or a job's chat event that applied it first). A chat the mirror does
 * not hold, of a character it holds, is a new chat: `"collection"` asks for the character's chat list
 * (`applyRemoteCollection`). A member that is not loaded is noticed too and also answers
 * `"collection"`: its summary comes with that list (never a whole-chat read), unless the entry's
 * summary knowledge (`known`: `summary` or `summaryBase`) settles it at once (`applyRemoteSummary`).
 * An optional by-id change (`patch`: a `ChatPatchBody`, or a `ChatDeltaBody` with the metadata by
 * field) applies without a notice or read only to a loaded, idle, non-stale chat held at exactly its
 * base revision. A miss follows the ordinary notice path. Nothing is queued or discarded.
 */
export function noteRemoteChat(
    ref: ChatRef,
    revision: string | null,
    patch?: ChatPatchBody | ChatDeltaBody,
    known?: { summary?: ChatSummary; summaryBase?: string },
): "noticed" | "collection" | "ignored" {
    const key = keyOf(ref.chaId, ref.chatId);
    if (!findCharacter(ref.chaId)) {
        return "ignored";
    }
    const heldRevision = chatRevisions.get(key);
    if (!isMember(ref)) {
        return revision === null || heldRevision !== undefined ? "ignored" : "collection";
    }
    if (heldRevision === undefined) {
        // A chat this client created and has not saved yet: its own save settles it.
        return "ignored";
    }
    if (revision !== null && (compareRevision(revision, heldRevision) ?? 0) <= 0) {
        return "ignored";
    }
    if (revision !== null && patch && applyRemoteChatPatch(ref, revision, patch)) {
        return "ignored";
    }
    if (revision !== null && known && applyRemoteSummary(ref, revision, known)) {
        return "ignored";
    }
    noticeSeq += 1;
    noticedChats.set(key, { seq: noticeSeq, revision });
    notifyWork();
    return isLoaded(ref) ? "noticed" : "collection";
}

/** The chat-order revision this client holds for a character, or null (read only). */
export function heldOrderRevision(chaId: string): string | null {
    return orderRevisions.get(chaId) ?? null;
}

/** Every chat this client holds a revision for (the live-update reconcile compares them). */
export function heldChatRefs(): { ref: ChatRef; revision: string }[] {
    return [...chatRevisions].map(([key, revision]) => {
        const [chaId, chatId] = key.split("\u0000");
        return { ref: { chaId, chatId }, revision };
    });
}

/** Every character this client holds a chat-order revision for. */
export function heldOrderCharacters(): string[] {
    return [...orderRevisions.keys()];
}

/** Whether a character's chat list can take a live update now: no order work pending or in flight. */
export function canApplyRemoteCollection(chaId: string): boolean {
    return !pendingOrders.has(chaId) && !inflightOrders.has(chaId) && !recoveringOrders.has(chaId);
}

/**
 * Applies a character's chat list from a live update (another writer created, deleted, or reordered
 * its chats), keeping local work except for the reorder below: callers check
 * `canApplyRemoteCollection`, and an older order than the held one is ignored. The list's chats are
 * whole chats or summaries (the save loop reads summaries). A chat with unsent or in-flight work, a
 * running generation, a deferral, or a quarantine keeps its local copy; a chat deleted here and not
 * yet on the server stays out; a local chat not on the server yet stays (after the server's). An
 * idle local chat the server no longer has is removed, only while its held revision is the one in
 * `issued` (the revisions held when the list was read). A newer server chat that is not loaded here
 * (or new to the list) takes the summary and revision; a loaded one takes a whole chat when the
 * list has it, else keeps its copy and held revision and is marked stale (the next cycle reads it
 * whole). A kept chat with a held revision the list lacks, and a held chat deleted here whose delete
 * is not acknowledged, are marked as gone from the server's order (`absentChats`): reorders leave
 * them out. A chat's notice is dropped only when the adopted state covers it. Nothing is queued.
 * Returns false when the character's order work is busy or a held chat the list lacks changed while
 * it was read (`issued`; the caller reads the list again later). A list that would empty the
 * character's chats is left as it is; an empty list on both sides holds its order, so this client's
 * chat is saved.
 *
 * With `keepPendingOrder` (the membership refresh after this client's own acknowledgement), a queued
 * reorder does not refuse the list: the chats this client listed keep its order, the chats new to it
 * follow in the server's order, and the reorder stays queued, so it is sent next on the new order
 * revision as a permutation of the server's list. When a chat this client keeps and holds a revision
 * of is missing from the server's list, the reorder (arranged with that chat still listed) is
 * discarded and reported as `chats/<characterId>` (the caller shows the notice), and the
 * server's order and revision are adopted. An order in flight still refuses.
 */
export function applyRemoteCollection(
    collection: {
        characterId: string;
        order: ChatOrderRecord | null;
        chats: readonly ListedChat[];
    },
    issued?: ReadonlyMap<string, string>,
    options: { keepPendingOrder?: boolean } = {},
): boolean {
    const chaId = collection.characterId;
    const rebase =
        options.keepPendingOrder === true &&
        pendingOrders.has(chaId) &&
        !inflightOrders.has(chaId) &&
        !recoveringOrders.has(chaId);
    if (!canApplyRemoteCollection(chaId) && !rebase) {
        return false;
    }
    if (!collection.order || !findCharacter(chaId)) {
        return true;
    }
    const heldOrder = orderRevisions.get(chaId);
    if (heldOrder !== undefined && (compareRevision(collection.order.revision, heldOrder) ?? 0) < 0) {
        return true;
    }
    const byId = new Map(collection.chats.map((chat) => [chat.id, chat]));
    const localIds = memberIds(chaId);
    const next: ChatEntry[] = [];
    const placed = new Set<string>();
    const adopted: { key: string; revision: string; whole: boolean }[] = [];
    const outdated: string[] = [];
    for (const id of collection.order.ids) {
        const record = byId.get(id);
        if (!record || placed.has(id)) {
            continue;
        }
        placed.add(id);
        const key = keyOf(chaId, id);
        const mine = entryAt(chaId, id);
        const heldRevision = chatRevisions.get(key);
        if (!mine && hasUnsentDelete(key)) {
            // Deleted here, not yet on the server: stays out of the mirror (its delete settles it).
            continue;
        }
        if (mine && (!canRefreshChat({ chaId, chatId: id }) || pending.get(key)?.create)) {
            next.push(mine);
            continue;
        }
        if (
            mine &&
            ((heldRevision !== undefined && (compareRevision(record.revision, heldRevision) ?? 0) <= 0) ||
                belowAckedRevision(key, record.revision))
        ) {
            // Below an acknowledgement of this client's edit, the copy lacks it: the chat keeps its
            // copy and its stale mark.
            next.push(mine);
            continue;
        }
        const data = listedData(record);
        if (mine?.chat && !data) {
            // A newer summary of a loaded chat: the copy is not replaced by less than a whole chat.
            next.push(mine);
            outdated.push(key);
            continue;
        }
        next.push(mine?.chat && data ? { id, chat: data } : { id, meta: listedMeta(record) });
        adopted.push({ key, revision: record.revision, whole: !!(mine?.chat && data) });
    }
    const removed: string[] = [];
    const absent: string[] = [];
    const local = new Set(localIds);
    const prefix = `${chaId}\u0000`;
    for (const id of localIds) {
        if (placed.has(id)) {
            continue;
        }
        const key = keyOf(chaId, id);
        if (!chatRevisions.has(key)) {
            // Not on the server yet: kept; its own save settles it.
            next.push(entryAt(chaId, id)!);
            continue;
        }
        if (issued && issued.get(key) !== chatRevisions.get(key)) {
            // A newer copy arrived while the list was read (a job's chat event, an acknowledgement):
            // the list may predate it, so neither a removal nor an absence follows from it. Read the
            // list again.
            return false;
        }
        if (!canRefreshChat({ chaId, chatId: id })) {
            // Busy here: kept, its own save (or a conflict) settles it; the server's order no longer
            // holds it (`absentChats`).
            next.push(entryAt(chaId, id)!);
            absent.push(key);
            continue;
        }
        removed.push(key);
    }
    for (const key of chatRevisions.keys()) {
        const id = key.slice(prefix.length);
        if (!key.startsWith(prefix) || placed.has(id) || local.has(id)) {
            continue;
        }
        // Held but no longer in the mirror (deleted here, the delete not acknowledged): the server's
        // order does not hold it either, so a reorder need not wait for that delete.
        if (issued && issued.get(key) !== chatRevisions.get(key)) {
            return false;
        }
        absent.push(key);
    }
    if (next.length === 0) {
        // Every chat is gone on the server (the writer's own new chat follows in a later change):
        // the list is left as it is rather than creating a chat here, which would be a write. A
        // character with no chats on either side (another writer created it without one) has its
        // empty order held, so the chat this client gives it can be saved.
        if (localIds.length === 0) {
            orderRevisions.set(chaId, collection.order.revision);
        }
        for (const key of removed) {
            notifyRemoval({ chaId, chatId: key.slice(prefix.length) });
        }
        return true;
    }
    let entries = next;
    if (rebase) {
        if (next.some((entry) => !placed.has(entry.id) && chatRevisions.has(keyOf(chaId, entry.id)))) {
            captureQueuedOrder(chaId);
            markOrderDiscarded(chaId, pendingOrders.get(chaId)!);
            pendingOrders.delete(chaId);
        } else {
            const localIndex = new Map(localIds.map((id, index) => [id, index]));
            entries = [
                ...next
                    .filter((entry) => localIndex.has(entry.id))
                    .sort((a, b) => localIndex.get(a.id)! - localIndex.get(b.id)!),
                ...next.filter((entry) => !localIndex.has(entry.id)),
            ];
        }
    }
    orderRevisions.set(chaId, collection.order.revision);
    for (const id of placed) {
        absentChats.delete(keyOf(chaId, id));
    }
    for (const key of absent) {
        absentChats.add(key);
    }
    for (const { key, revision } of adopted) {
        holdChatRevision(key, revision);
        staleChats.delete(key);
        settleNotice(key, revision);
        changed(key);
    }
    for (const key of outdated) {
        staleChats.add(key);
    }
    for (const key of removed) {
        dropChatRevision(key);
        staleChats.delete(key);
        noticedChats.delete(key);
        changed(key);
    }
    setChatList(chaId, entries);
    for (const { key, whole } of adopted) {
        if (whole) recordChatInstall(key);
    }
    for (const key of removed) {
        notifyRemoval({ chaId, chatId: key.slice(prefix.length) });
    }
    mutationToken += 1;
    syncSelection(chaId);
    remoteListener?.({ chaId, chatId: "" });
    if (outdated.length > 0) {
        notifyWork();
    }
    return true;
}

/**
 * Replaces a character's chat list with the server's (an order conflict, a chat another tab deleted,
 * or a character the mirror learns about): the server order and chats (whole chats or summaries). A
 * chat with unsent or in-flight work or a running generation keeps its local copy; an unresolved
 * create keeps its exact resend until answered; a never-sent local chat stays (after the server's).
 * A local chat the server no longer has is dropped with its work, unless a generation runs in it
 * (its reload waits). An idle chat takes the server's state: a whole chat when it is loaded and the
 * list has one, the summary and revision when it is not loaded (or new to the list); a loaded chat the list gives
 * only a newer summary of keeps its copy and held revision and is marked stale (read whole next).
 * A kept chat with a held revision the list lacks (quarantined, a create, streamed here), and a held
 * chat deleted here whose delete is not acknowledged, are marked as gone from the server's order
 * (`absentChats`): reorders leave them out. A conflicting reorder is settled quietly only when its
 * sent vector equals the server's; a newer queued reorder keeps its own sequence and local order.
 * Other queued reorders and a dropped chat's work count as discarded (`markOrderDiscarded`,
 * `markDiscarded`: the flush and `MutationScope` reports); returns whether there was any.
 * A dropped idle chat discards nothing.
 */
export function acceptRemoteCollection(
    collection: {
        characterId: string;
        order: ChatOrderRecord | null;
        chats: readonly ListedChat[];
    },
    options: { captureOrder?: boolean } = {},
): boolean {
    const chaId = collection.characterId;
    const character = findCharacter(chaId);
    const recoveringOrder = recoveringOrders.get(chaId);
    const orderSeq = pendingOrders.get(chaId);
    if (!collection.order || !character) {
        if (orderSeq === undefined && !recoveringOrder) {
            return false;
        }
        if (options.captureOrder !== false) {
            captureQueuedOrder(chaId);
            captureSentOrder(recoveringOrder);
        }
        markOrderDiscarded(chaId, Math.max(orderSeq ?? 0, recoveringOrder?.seq ?? 0));
        pendingOrders.delete(chaId);
        recoveringOrders.delete(chaId);
        return true;
    }
    let discardedWork = false;
    if (recoveringOrder) {
        if (
            recoveringOrder.ids.length === collection.order.ids.length &&
            recoveringOrder.ids.every((id, index) => id === collection.order!.ids[index])
        ) {
            settleOrder(chaId, recoveringOrder.seq);
        } else {
            if (options.captureOrder !== false) captureSentOrder(recoveringOrder);
            markOrderDiscarded(chaId, recoveringOrder.seq);
            discardedWork = true;
        }
        recoveringOrders.delete(chaId);
    } else if (orderSeq !== undefined) {
        if (options.captureOrder !== false) captureQueuedOrder(chaId);
        markOrderDiscarded(chaId, orderSeq);
        pendingOrders.delete(chaId);
        discardedWork = true;
    }
    // The list cannot establish whether a parked group landed; preserve its exact identity.
    for (const [key, { resend }] of parkedResends.get(chaId) ?? []) {
        conflictListener?.({ scope: "chat", target: key, layers: { resend: resendLayer(resend) } });
    }
    parkedResends.delete(chaId);
    orderRevisions.set(chaId, collection.order.revision);
    const byId = new Map(collection.chats.map((chat) => [chat.id, chat]));
    const localIds = memberIds(chaId);
    const next: ChatEntry[] = [];
    const placed = new Set<string>();
    const installed: string[] = [];
    let outdated = false;
    for (const id of collection.order.ids) {
        const record = byId.get(id);
        if (!record || placed.has(id)) {
            continue;
        }
        placed.add(id);
        const key = keyOf(chaId, id);
        const mine = entryAt(chaId, id);
        const entry = pending.get(key);
        const busy = !canRefreshChat({ chaId, chatId: id });
        if (entry?.create || isCreateResend(entry) || inflight.get(key)?.ops[0]?.op === "create") {
            // Membership alone acknowledges no create. Keep its exact replay and the old base of
            // later edits; a same-id recreation also stays behind its old incarnation's delete.
            if (mine) {
                next.push(mine);
            }
            continue;
        }
        if (queuesDelete(entry)) {
            // Deleted here, not yet on the server: stays out of the mirror. The delete keeps its
            // own base revision (this tab has not seen the server's copy), so it conflicts if the
            // chat changed.
            continue;
        }
        const data = listedData(record);
        const heldRevision = chatRevisions.get(key);
        if (mine && busy) {
            next.push(mine);
            if (heldRevision === undefined) {
                holdChatRevision(key, record.revision);
            }
        } else if (mine?.chat && !data) {
            next.push(mine);
            if (heldRevision === undefined) {
                holdChatRevision(key, record.revision);
            } else if ((compareRevision(record.revision, heldRevision) ?? 1) !== 0) {
                // Not replaced by less than a whole chat: read whole in the next cycle.
                staleChats.add(key);
                outdated = true;
            }
        } else if (mine && belowAckedRevision(key, record.revision)) {
            // Older than an acknowledgement of this client's edit (`ackedRevisions`): read again.
            next.push(mine);
            staleChats.add(key);
            outdated = true;
        } else {
            next.push(mine?.chat && data ? { id, chat: data } : { id, meta: listedMeta(record) });
            if (mine?.chat && data) installed.push(key);
            holdChatRevision(key, record.revision);
            staleChats.delete(key);
            changed(key);
        }
    }
    const absent: string[] = [];
    for (const id of localIds) {
        if (placed.has(id)) {
            continue;
        }
        const key = keyOf(chaId, id);
        const entry = pending.get(key);
        const mine = entryAt(chaId, id)!;
        if (
            quarantined.has(key) ||
            entry?.create ||
            isCreateResend(entry) ||
            inflight.get(key)?.ops[0]?.op === "create"
        ) {
            // Not on the server yet (never sent, or a create whose attempt was rolled back or is
            // unresolved): it stays and its create goes out. A quarantined chat stays as it is.
            next.push(mine);
            absent.push(key);
        } else if (isChatStreamedHere({ chaId, chatId: id })) {
            next.push(mine);
            deferred.add(key);
            absent.push(key);
        } else {
            if (pending.has(key) || inflight.has(key)) {
                captureChatConflict(key, { gone: true });
                discardChatWork(key, 0);
                discardedWork = true;
            } else {
                staleChats.delete(key);
                jobBlocked.delete(key);
            }
            dropChatRevision(key);
            changed(key);
            notifyRemoval({ chaId, chatId: id });
        }
    }
    const local = new Set(localIds);
    const prefix = `${chaId}\u0000`;
    for (const key of chatRevisions.keys()) {
        const id = key.slice(prefix.length);
        if (key.startsWith(prefix) && !placed.has(id) && !local.has(id)) {
            // Held but no longer in the mirror (deleted here, the delete not acknowledged).
            absent.push(key);
        }
    }
    for (const id of placed) {
        absentChats.delete(keyOf(chaId, id));
    }
    for (const key of absent) {
        if (chatRevisions.has(key)) {
            // Kept with a held revision the server's order no longer holds (`absentChats`).
            absentChats.add(key);
        }
    }
    if (recoveringOrder && orderSeq !== undefined) {
        // A reorder queued after the conflicting request has its own obligation and local order.
        const localIndex = new Map(localIds.map((id, index) => [id, index]));
        next.sort((a, b) => (localIndex.get(a.id) ?? Infinity) - (localIndex.get(b.id) ?? Infinity));
    }
    setChatList(chaId, next);
    for (const key of installed) recordChatInstall(key);
    mutationToken += 1;
    if (
        !pendingOrders.has(chaId) &&
        next.some((chat) => !chatRevisions.has(keyOf(chaId, chat.id)) && !quarantined.has(keyOf(chaId, chat.id)))
    ) {
        // Local chats still to be created were placed after the server's; a reorder sent after
        // their creates makes the server's order match the mirror.
        pendingOrders.set(chaId, nextSeq());
    }
    ensureChat(chaId);
    syncSelection(chaId);
    remoteListener?.({ chaId, chatId: "" });
    if (outdated) {
        notifyWork();
    }
    return discardedWork;
}

// ---------------------------------------------------------------------------------------------
// Loading and eviction (chats load on demand; idle loaded chats are evicted)

/** Whether a chat has local work or a protection that keeps its local copy as it is. */
function isBusy(key: string): boolean {
    return pending.has(key) || inflight.has(key) || quarantined.has(key) || deferred.has(key) || jobBlocked.has(key);
}

/** Marks a chat as just used (the eviction order). */
function touch(key: string) {
    useCounter += 1;
    lastUse.set(key, useCounter);
}

/**
 * Reads a chat from the server and adopts it. A loaded chat is refreshed under the idle refresh's
 * safeguards (`adoptChatRead`): a chat with local work, a generation, a deferral, a quarantine, or a
 * retry block keeps its copy, a read older than the held revision changes nothing, a deletion applies
 * only while the revision held when the read was issued is still held, and a notice that arrived
 * during the read keeps its mark. A member that is not loaded is loaded (`readUnloaded`). A chat that
 * is not in its character's list is never appended: the character's summary list is read and applied
 * (`applyRemoteCollection`, which leaves a list with order work alone), then the chat is loaded if it
 * is listed now. Every step is fenced on the owner's lifetime: a load issued before its character's
 * chats were reset resolves to `undefined`. Resolves to the loaded chat, or `undefined` when there is
 * none; a failed read rejects.
 */
export async function loadChat(ref: ChatRef): Promise<DeepReadonly<Chat> | undefined> {
    const lifetime = lifetimeOf(ref.chaId);
    if (!isMember(ref)) {
        await readSummaryList(ref.chaId, lifetime);
        if (lifetimeOf(ref.chaId) !== lifetime || !isMember(ref)) {
            return undefined;
        }
        return heldChat(ref) ?? (await loadUnloaded(ref, lifetime));
    }
    if (!isLoaded(ref)) {
        return await loadUnloaded(ref, lifetime);
    }
    const notice = chatNoticeSeq(ref);
    const issued = heldChatRevision(ref);
    const readStamp = issueChatReadStamp();
    const read = await deadlineChatRead((signal) =>
        readRefs([], { chats: [{ characterId: ref.chaId, id: ref.chatId }], signal }),
    );
    const server = read.chats?.find((chat) => chat.characterId === ref.chaId && chat.id === ref.chatId);
    if (lifetimeOf(ref.chaId) !== lifetime) {
        return undefined;
    }
    if (server && findCharacter(ref.chaId) && isMember(ref)) {
        if (isLoaded(ref)) {
            adoptChatRead({ ...server, readStamp } as RemoteChat, notice, issued);
        } else {
            // Evicted during the read: loaded again as an unloaded chat is.
            return await loadUnloaded(ref, lifetime);
        }
    }
    return heldChat(ref);
}

/** Bounds on-demand reads even when the transport does not settle after an abort. */
async function deadlineChatRead<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(language.chatLoadTimedOut)), CHAT_READ_DEADLINE_MS);
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
    }
}

/** Reads a character's summary list and applies it as a live update (fenced on the owner's lifetime). */
async function readSummaryList(chaId: string, lifetime: string) {
    const revisions = heldChatRevisionsOf(chaId);
    const read = await deadlineChatRead((signal) => readRefs([], { chatSummaryCollections: [chaId], signal }));
    const collection = read.chatSummaryCollections?.find((entry) => entry.characterId === chaId);
    if (collection && findCharacter(chaId) && lifetimeOf(chaId) === lifetime) {
        applyRemoteCollection(collection, revisions);
    }
}

/** Loads one unloaded member, sharing a load of the same chat in flight in the same owner lifetime. */
function loadUnloaded(ref: ChatRef, lifetime: string): Promise<DeepReadonly<Chat> | undefined> {
    const key = keyOf(ref.chaId, ref.chatId);
    const running = loading.get(key);
    if (running && running.lifetime === lifetime) {
        return running.promise;
    }
    const promise = (async () => {
        try {
            await readUnloaded(ref.chaId, [ref.chatId], lifetime);
        } finally {
            if (loading.get(key)?.promise === promise) {
                loading.delete(key);
            }
        }
        return lifetimeOf(ref.chaId) === lifetime ? heldChat(ref) : undefined;
    })();
    loading.set(key, { lifetime, promise });
    return promise;
}

/**
 * Reads unloaded members of a character (`LOAD_CHUNK` per request) and installs them (`installRead`).
 * A read older than the held revision is read again, at most `MAX_LOAD_READS` times, then the load
 * fails (rejects). A chat the server reports gone is removed under the issued-revision fence, and the
 * character's summary list is read so a replacement is found. Stops when the owner's lifetime changed.
 */
async function readUnloaded(chaId: string, ids: readonly string[], lifetime: string) {
    let wanted = [...ids];
    for (let attempt = 0; attempt < MAX_LOAD_READS && wanted.length > 0; attempt++) {
        const issued = new Map(wanted.map((id) => [id, chatRevisions.get(keyOf(chaId, id)) ?? null]));
        const records = new Map<string, RemoteChat>();
        for (let start = 0; start < wanted.length; start += LOAD_CHUNK) {
            const readStamp = issueChatReadStamp();
            const read = await deadlineChatRead((signal) =>
                readRefs([], {
                    chats: wanted.slice(start, start + LOAD_CHUNK).map((id) => ({ characterId: chaId, id })),
                    signal,
                }),
            );
            if (lifetimeOf(chaId) !== lifetime) {
                return;
            }
            for (const chat of read.chats ?? []) {
                if (chat.characterId === chaId) {
                    records.set(chat.id, { ...chat, readStamp } as RemoteChat);
                }
            }
        }
        if (!findCharacter(chaId)) {
            return;
        }
        const retry: string[] = [];
        let gone = false;
        for (const id of wanted) {
            const outcome = installRead(chaId, id, records.get(id), issued.get(id) ?? null);
            if (outcome === "retry") {
                retry.push(id);
            } else if (outcome === "gone") {
                gone = true;
            }
        }
        if (gone) {
            await readSummaryList(chaId, lifetime);
            if (lifetimeOf(chaId) !== lifetime) {
                return;
            }
        }
        wanted = retry.filter((id) => isUnloadedMember({ chaId, chatId: id }));
    }
    if (wanted.length > 0) {
        throw new Error("The chat could not be loaded: the server kept answering an older copy");
    }
}

/**
 * Installs a read of an unloaded member: "installed"; "skip" (no longer an unloaded member, or busy
 * with a deletion pending here); "gone" (removed: the server no longer has it); "retry" (the read is
 * older than the held revision or than an acknowledgement of this client's edit, or an overtaken
 * deletion). A chat with local work keeps its list fields: an unloaded chat's summary is the local
 * truth of those fields, laid over the read. Its work keeps the held base revision so the server
 * can still reject edits from before a checkpoint restore. Feed locks take the read's stamped
 * snapshot independently of that held base, using the same ordering fence as a loaded chat.
 */
function installRead(
    chaId: string,
    id: string,
    server: RemoteChat | undefined,
    issued: string | null,
): "installed" | "skip" | "gone" | "retry" {
    const ref = { chaId, chatId: id };
    const key = keyOf(chaId, id);
    if (!isUnloadedMember(ref)) {
        return "skip";
    }
    if (!server) {
        return "retry";
    }
    const heldRevision = chatRevisions.get(key);
    if (server.revision === null || !server.data) {
        if ((heldRevision ?? null) !== issued) {
            return "retry";
        }
        if (isBusy(key)) {
            return "skip";
        }
        noticedChats.delete(key);
        removeRemoteChat(chaId, id);
        return "gone";
    }
    if (
        (heldRevision !== undefined && (compareRevision(server.revision, heldRevision) ?? -1) < 0) ||
        belowAckedRevision(key, server.revision)
    ) {
        return "retry";
    }
    const chat = clone<Chat>(server.data);
    const holding = holdingOf(chaId);
    const busy = isBusy(key);
    if (busy) {
        const summary = holding.summaries[slot(id)] ?? metaOf({});
        const fields = chat as unknown as Record<string, unknown>;
        for (const field of Object.keys(SUMMARY_FIELD_TYPES)) {
            const value = (summary as Record<string, unknown>)[field];
            if (value === undefined) {
                delete fields[field];
            } else {
                fields[field] = value;
            }
        }
        // The copy is not all the server's at this revision (its list fields are ours): read whole
        // again once the local work settles, whatever the acknowledgement says.
        staleChats.add(key);
    } else {
        staleChats.delete(key);
    }
    dropMessagePositions(key);
    holding.chats[slot(id)] = chat;
    delete holding.summaries[slot(id)];
    loadedKeys.add(key);
    if (!busy) {
        holdChatRevision(key, server.revision);
    }
    dropFeedLocksOf(key, server.revision, server.streaming, server.readStamp);
    if (!busy) {
        settleNotice(key, server.revision);
    }
    changed(key);
    touch(key);
    recordChatInstall(key);
    scheduleTrim();
    return "installed";
}

/**
 * A chat of its character's list, loaded: at once when it is (and marked as just used), else through
 * `loadChat`. A chat that is not in the list (deleted, or not known here yet) resolves to `undefined`
 * without a read: the list's membership comes from its own reads. Pin the chat (`pinChat`) to keep
 * it loaded across a later await.
 */
export async function ensureChatLoaded(ref: ChatRef): Promise<DeepReadonly<Chat> | undefined> {
    if (!isMember(ref)) {
        return undefined;
    }
    const chat = heldChat(ref);
    if (chat) {
        touch(keyOf(ref.chaId, ref.chatId));
        return chat;
    }
    return await loadUnloaded(ref, lifetimeOf(ref.chaId));
}

/**
 * A character's chats in order, every one loaded: the unloaded members are read (pinned while this
 * works, `LOAD_CHUNK` per request), again while the list changes meanwhile (at most
 * `MAX_LOAD_READS` rounds). Rejects when they could not all be loaded; resolves to an empty list when
 * the character's chats were reset meanwhile. Pin the character (`pinChats`) first to keep them
 * loaded after it resolves.
 */
export async function loadChats(chaId: string): Promise<readonly DeepReadonly<Chat>[]> {
    const lifetime = lifetimeOf(chaId);
    const release = pinChats(chaId);
    try {
        for (let round = 0; round < MAX_LOAD_READS; round++) {
            if (lifetimeOf(chaId) !== lifetime) {
                return [];
            }
            const missing = memberIds(chaId).filter((id) => !isLoaded({ chaId, chatId: id }));
            if (missing.length === 0) {
                return chatsOf(chaId);
            }
            await readUnloaded(chaId, missing, lifetime);
        }
        if (lifetimeOf(chaId) !== lifetime) {
            return [];
        }
        if (!chatsLoaded(chaId)) {
            throw new Error("The chats of this character could not be loaded");
        }
        return chatsOf(chaId);
    } finally {
        release();
    }
}

/** Takes a pin under `key` (a `chaId`, or a chat's `keyOf`); the release is idempotent and schedules a trim. */
function pinKey(key: string): () => void {
    let counter = pins.get(key);
    if (!counter) {
        counter = { count: 0 };
        pins.set(key, counter);
    }
    const pinned = counter;
    pinned.count += 1;
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        pinned.count -= 1;
        if (pinned.count <= 0 && pins.get(key) === pinned) {
            pins.delete(key);
        }
        scheduleTrim();
    };
}

/**
 * Pins a character's chats (none of its loaded chats is evicted while a consumer that needs the whole
 * set works); call it before awaiting a load. Returns the release (idempotent).
 */
export function pinChats(chaId: string): () => void {
    return pinKey(chaId);
}

/** Pins one chat (it is not evicted while a consumer works with it); call it before awaiting its load. */
export function pinChat(ref: ChatRef): () => void {
    return pinKey(keyOf(ref.chaId, ref.chatId));
}

/** Whether a consumer pinned a character's chats (`pinChats`). */
export function isChatPinned(chaId: string): boolean {
    return (pins.get(chaId)?.count ?? 0) > 0;
}

/** Whether a loaded chat may be evicted (`trimLoadedChats`). */
function isEvictable(ref: ChatRef, current: ChatRef | null): boolean {
    const key = keyOf(ref.chaId, ref.chatId);
    return (
        chatRevisions.has(key) &&
        !(current !== null && current.chaId === ref.chaId && current.chatId === ref.chatId) &&
        (pins.get(ref.chaId)?.count ?? 0) === 0 &&
        (pins.get(key)?.count ?? 0) === 0 &&
        !isBusy(key) &&
        !isChatGenerating(ref) &&
        !staleChats.has(key) &&
        !noticedChats.has(key) &&
        streamingChats[key] === undefined
    );
}

/**
 * Evicts the least recently used idle loaded chats beyond `MAX_LOADED_CHATS`: each is kept as its
 * summary, with its revision and version. Never the selected chat, a pinned one (or one of a pinned
 * character), one with local work or a protection, a generating one, one waiting for a refresh, or
 * one not saved yet. Nothing is written.
 */
export function trimLoadedChats() {
    if (loadedKeys.size <= MAX_LOADED_CHATS) {
        return;
    }
    untrack(() => {
        const current = currentChatRef();
        const candidates: { chaId: string; id: string; use: number }[] = [];
        for (const key of [...loadedKeys]) {
            const [chaId, id] = key.split("\u0000");
            const ref = { chaId, chatId: id };
            if (!heldChat(ref) || !isMember(ref)) {
                dropMessagePositions(key);
                loadedKeys.delete(key);
                continue;
            }
            if (isEvictable(ref, current) && findCharacter(chaId)) {
                candidates.push({ chaId, id, use: lastUse.get(key) ?? 0 });
            }
        }
        if (candidates.length <= MAX_LOADED_CHATS) {
            return;
        }
        candidates.sort((a, b) => a.use - b.use);
        for (const { chaId, id } of candidates.slice(0, candidates.length - MAX_LOADED_CHATS)) {
            const holding = holdingAt(chaId)!;
            holding.summaries[slot(id)] = metaOf(holding.chats[slot(id)]);
            dropMessagePositions(keyOf(chaId, id));
            delete holding.chats[slot(id)];
            loadedKeys.delete(keyOf(chaId, id));
        }
        mutationToken += 1;
    });
}

/** Schedules `trimLoadedChats` once, after the current task (a caller reading right after a release still finds its chat). */
export function scheduleTrim() {
    if (trimTimer !== null) {
        return;
    }
    trimTimer = setTimeout(() => {
        trimTimer = null;
        trimLoadedChats();
    }, 0);
}

/**
 * The compatibility view of a character's chats (a character wrapper's `chats`/`chatPage`) for the
 * shared CBS host and evaluator, which read that legacy shape: the loaded chats in order and the selected chat's index among them (-1 when it is not loaded). Those
 * readers find a chat by its ref's id or the selected one; an unloaded chat is not found. Read-only
 * by contract; not enforced.
 */
setCharacterChatView({
    chats: (chaId) => chatsOf(chaId),
    chatPage: (chaId) => compatChatPage(chaId),
});

/** Deferred chats whose server job has ended: their reload can run. */
export function deferredReloads(): ChatRef[] {
    return [...deferred]
        .map((key) => {
            const [chaId, chatId] = key.split("\u0000");
            return { chaId, chatId };
        })
        .filter((ref) => !isChatStreamedHere(ref) && !inflight.has(keyOf(ref.chaId, ref.chatId)));
}

/** Applies a deferred chat's reload (after a successful read) and ends its deferral. */
export function finishDeferredReload(server: RemoteChat): string | null {
    const key = keyOf(server.characterId, server.id);
    const ref = { chaId: server.characterId, chatId: server.id };
    // A new job may have locked the chat while the read was in flight.
    if (!deferred.has(key) || isChatStreamedHere(ref) || inflight.has(key)) {
        return null;
    }
    deferred.delete(key);
    if (server.revision === null) {
        const entry = pending.get(key);
        if (entry?.create || isCreateResend(entry)) {
            quarantineRefusedCreate({ key, seq: workSeq(key), ops: [] });
        } else {
            captureChatConflict(key, { gone: true });
            discardChatWork(key, 0);
        }
        dropChatRevision(key);
        return server.characterId;
    }
    acceptRemoteChat(server);
    return null;
}

/** Work tracked by `flushResources`; a refused order is skipped while checking settlement. */
export function captureChatObligations(): { chats: Map<string, number>; orders: Map<string, number> } {
    const chats = new Map<string, number>();
    for (const key of new Set([...pending.keys(), ...inflight.keys()])) {
        chats.set(key, workSeq(key));
    }
    const orders = new Map(pendingOrders);
    for (const [chaId, order] of inflightOrders) {
        orders.set(chaId, Math.max(orders.get(chaId) ?? 0, order.seq));
    }
    for (const [chaId, order] of recoveringOrders) {
        orders.set(chaId, Math.max(orders.get(chaId) ?? 0, order.seq));
    }
    return { chats, orders };
}

export function unsettledChatObligations(obligations: ReturnType<typeof captureChatObligations>): string[] {
    const open: string[] = [];
    for (const [key, seq] of obligations.chats) {
        if ((settled.get(key) ?? 0) < seq) {
            open.push(key);
        }
    }
    for (const [chaId, seq] of obligations.orders) {
        if (!isOrderQuarantined(chaId) && (ordersSettled.get(chaId) ?? 0) < seq) {
            open.push(chaId);
        }
    }
    return open;
}

/**
 * Whether an obligation waits on a deferred chat a server job still streams into, or on a chat the
 * server refused for a generating message (until its retry).
 */
export function isChatDeferred(key: string): boolean {
    if (!key.includes("\u0000")) {
        // A reorder obligation (by character): it waits on a chat of it refused for a generating message.
        return [...jobBlocked.keys()].some((chatKey) => chatKey.startsWith(`${key}\u0000`) && isJobBlocked(chatKey));
    }
    if (isJobBlocked(key)) {
        return true;
    }
    if (!deferred.has(key)) {
        return false;
    }
    const [chaId, chatId] = key.split("\u0000");
    return isChatStreamedHere({ chaId, chatId });
}

/** Chat keys discarded after `sequence` (for `flushResources`' report). */
export function chatDiscardsSince(sequence: number): string[] {
    return [...discarded].filter(([, value]) => value > sequence).map(([key]) => key.replace("\u0000", "/"));
}

export function chatDiscardSequence(): number {
    return discardSequence;
}

const DRIFT_CHECK_INTERVAL_MS = 2000;

/**
 * Development check: a write into the selected character's chats that did not come through this
 * module is logged (it would not be saved). Never saves anything.
 */
export function startChatDriftCheck() {
    if (!import.meta.env.DEV) {
        return () => {};
    }
    // Polled, not an effect: a deep snapshot on every change makes a long stream quadratic. A
    // change outside the module in the same interval as a module write goes unnoticed (a dev aid).
    let lastCharacter: string | undefined;
    let lastText: string | undefined;
    let lastToken = -1;
    const interval = setInterval(() => {
        const id = selection.characterId ?? undefined;
        const text = JSON.stringify($state.snapshot(id === undefined ? undefined : holdingAt(id)));
        if (id === lastCharacter && lastText !== undefined && text !== lastText && mutationToken === lastToken) {
            console.error(
                "[Chat] The chats of the selected character changed outside the chat module; the change is not saved",
            );
        }
        lastCharacter = id;
        lastText = text;
        lastToken = mutationToken;
    }, DRIFT_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
}

/** Tells the drift check that a mirror change outside the module is expected (hydration, restore). */
export function noteMirrorReplaced() {
    mutationToken += 1;
}

// The settings views read the selected chat's binding first:
// the selected chat as `currentChatRef` names it (also while it loads; a summary has the list fields).
// Only the four binding fields are read, so a view does not track the chat's other fields.
setOpenChatBindingSource(() => {
    const ref = currentChatRef();
    const holding = ref ? holdingAt(ref.chaId) : undefined;
    if (!ref || !holding?.ids.includes(ref.chatId)) {
        return undefined;
    }
    return readChatBindingIds(holding.chats[slot(ref.chatId)] ?? holding.summaries[slot(ref.chatId)] ?? {});
});
