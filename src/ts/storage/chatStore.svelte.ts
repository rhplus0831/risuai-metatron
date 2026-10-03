import { get } from "svelte/store";
import { v4 as uuidv4 } from "uuid";
import type {
    ChatGroupResult,
    ChatOp,
    ChatOrderRecord,
    ChatOrderResult,
    ChatRecord,
    MessageAnchor,
    MessageGeneration,
} from "../../../shared/chats.ts";
import { CHAT_META_FORBIDDEN_KEYS, CHAT_META_MERGE_KEYS } from "../../../shared/chats.ts";
import type { StreamingMessage } from "../../../shared/jobs.ts";
import { compareRevision } from "../../../shared/resources.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import { language } from "src/lang";
import { alertError } from "../alert";
import { DBState, selectedCharID } from "../stores.svelte";
import type { character, Chat, groupChat, Message } from "./database.svelte";

/**
 * The chat mutation module (Phase 2 of `docs/plan/PLAN.md`). Chats are server resources of their own
 * (metadata plus one row per message, addressed by `Message.chatId`; each character's chat order is a
 * record of its own). `DBState.db.characters[].chats` stays the reactive mirror the UI reads, and this
 * module is the only code that writes it: every call updates the mirror synchronously and queues an
 * operation that the save loop (`resourceSync.svelte.ts`) sends in its next batch.
 *
 * - Addressing is by `ChatRef` (`chaId`, `chatId`) and message id, never by index.
 * - Per chat, work is unsent (`pending`) or in flight (`inflight`, immutable until the save loop
 *   acknowledges it, requeues it after a failure, or recovers it after a conflict). Unsent operations
 *   of one chat coalesce. A chat never sent is sent as it is in the mirror; a create that was sent
 *   but not acknowledged is resent exactly as sent (it may have landed), followed by later work.
 * - Each chat has a local version that every change bumps (local or from the server); a hook's
 *   baseline records it, so a whole-chat replacement never overwrites a change made meanwhile.
 * - The generating message is locked: only calls carrying its generation id may rewrite or remove it.
 *   The module checkpoints its text every three seconds, and `endGeneration` sends the final text; the
 *   lock stays until that is acknowledged or discarded. A generation the server stopped accepting
 *   (another tab took the message over, or it was closed) is rejected: writes carrying its id do
 *   nothing from then on.
 * - Final writes are retained by generation id until acknowledged or discarded, independently of
 *   the current message lock (auto-continue can supersede an ending generation). A conflict waits
 *   for producers to end, reloads, then reapplies those finals in order for surviving message ids.
 *   The current lock survives that reload until acknowledgement. Recovery keeps the original
 *   generation id and sequence: acknowledged begins are never reopened, unacknowledged begins are
 *   retried, and the server's fence history still rejects displaced or closed generations. Message
 *   id adoption renames retained finals along with queued work and locks.
 * - A stale acknowledgement keeps the old base and requests an idle refresh. Only a chat with no
 *   pending/in-flight work, lock, deferral, or quarantine may accept it; this is not a discard.
 * - The selected chat is per tab: `selectChat` records the chat id, and `chatPage` is derived from it.
 * - A server generation job (Phase 5) locks its message too: `applyServerGeneration` writes the
 *   streamed text into the mirror without queuing anything, and the job's end releases its locks.
 *   A chat `resource` event replaces the chat through `hydrateChat` (never an outgoing write). Work
 *   the server refused for a generating message (`reason: "generating"`) is kept and retried after
 *   `JOB_RETRY_MS`.
 */

export type ChatRef = { chaId: string; chatId: string };

type AnyCharacter = character | groupChat;

const CHECKPOINT_INTERVAL_MS = 3000;
/** How long a chat whose work the server refused for a generating message waits before it is retried. */
export const JOB_RETRY_MS = 5000;
const SELECTION_STORAGE_KEY = "risu-selected-chats";
const forbiddenMetaKeys = new Set(CHAT_META_FORBIDDEN_KEYS);

const keyOf = (chaId: string, chatId: string) => `${chaId}\u0000${chatId}`;
const messageKeyOf = (ref: ChatRef, messageId: string) => `${keyOf(ref.chaId, ref.chatId)}\u0000${messageId}`;

/** A chat's queued, unsent work. */
type Pending = {
    characterId: string;
    chatId: string;
    /** Never sent: sent as a `create` built from the mirror (with only its generation ops). */
    create: boolean;
    /**
     * A create group that was sent but not acknowledged (it may have landed): resent alone, exactly
     * as sent, with its own sequence; `ops` wait until it is resolved.
     */
    resend: { ops: ChatOp[]; seq: number } | null;
    /** Unsent ops, in order. */
    ops: ChatOp[];
    /** Local sequence number of the latest change. */
    seq: number;
};

/** One chat group of a batch, as sent (immutable). */
export type SentChatGroup = {
    key: string;
    characterId: string;
    chatId: string;
    baseRevision: string | null;
    ops: ChatOp[];
    seq: number;
    /** For a create: what the chat is on the server if this whole group landed (replay recognition). */
    expected?: string;
    /** Generations whose final write this group carries (released on success or discard). */
    finals: { messageKey: string; generationId: string }[];
    /** For each generation-carrying op in order: its generation id and message key. */
    generationOps: { generationId: string; messageKey: string }[];
    /** Unload work taken from the ordinary queue, rather than a synthetic generation checkpoint. */
    unloadPending?: boolean;
};

export type SentChatOrder = { characterId: string; baseRevision: string; ids: string[]; seq: number };

export type ChatWork = { groups: SentChatGroup[]; orders: SentChatOrder[] };

type Generation = {
    generationId: string;
    seq: number;
    /** Text last queued as a checkpoint. */
    queuedText: string | null;
    timer: ReturnType<typeof setInterval> | null;
    /** `endGeneration` was called; the lock goes once the final text is acknowledged or discarded. */
    ending: boolean;
    /** The server acknowledged the `begin`, so it knows the message and the generation. */
    begun: boolean;
};

type GenerationFinal = {
    messageKey: string;
    op: Extract<ChatOp, { op: "setText" }> & { generation: MessageGeneration };
    begun: boolean;
};

const chatRevisions = new Map<string, string>();
const orderRevisions = new Map<string, string>();
const pending = new Map<string, Pending>();
const inflight = new Map<string, SentChatGroup>();
const pendingOrders = new Map<string, number>();
const inflightOrders = new Map<string, SentChatOrder>();
/** Chat keys → highest local sequence settled (acknowledged or discarded). */
const settled = new Map<string, number>();
const ordersSettled = new Map<string, number>();
/** Keys whose work a conflict discarded, with the discard sequence (for `flushResources`). */
const discarded = new Map<string, number>();
let discardSequence = 0;
/** Chats whose work the server refused as invalid; nothing more is sent for them this session. */
const quarantined = new Set<string>();
/** Refused reorders wait until the ordered ids change. */
const quarantinedOrders = new Map<string, string>();
/** Chats whose conflict reload waits for the generation running in them. */
const deferred = new Set<string>();
/** Chats acknowledged on an older base, awaiting an idle read of the server's complete state. */
const staleChats = new Set<string>();
/**
 * Chats another tab of this browser announced as changed on the server (`chatChangeNotices.ts`) →
 * the sequence of the latest notice. Only an idle read that began after that notice clears it.
 */
const noticedChats = new Map<string, number>();
let noticeSeq = 0;
/** Locked messages (`messageKeyOf`) → their running generation. */
const generations = new Map<string, Generation>();
/** Finals in producer order, including generations superseded by auto-continue before their ack. */
const generationFinals = new Map<string, GenerationFinal>();
/** Bumped whenever `generations` gains or loses a lock, so the chat screen's lock reads re-run. */
const lockState = $state({ version: 0 });
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
 * Per chat: the revision of the newest job chat event whose job metadata (streaming, releases) was
 * taken, applied or not; an older event's metadata is ignored.
 */
const jobMetadataRevisions = new Map<string, string>();
/** Chats whose work the server refused for a generating message → when it may be sent again. */
const jobBlocked = new Map<string, number>();
/** Generations the server stopped accepting → their message key. */
const rejectedGenerations = new Map<string, string>();
/** Chat keys → local version, bumped by every change of the chat in the mirror. */
const versions = new Map<string, number>();
let localSeq = 0;
let workListener: (() => void) | null = null;
let remoteListener: ((ref: ChatRef) => void) | null = null;

/** Bumped by every mirror write this module makes (the development drift check compares it). */
let mutationToken = 0;

/** The message being generated, for the chat screen (client-only; replaces the persisted flags). */
export const streamingState = $state({
    chaId: null as string | null,
    chatId: null as string | null,
    messageId: null as string | null,
    mode: undefined as Chat["activeStreamingDisplayOptimizationMode"],
});

/** The selected chat id per character (this tab). */
const selectedChats = new Map<string, string>();

/** Registers the save loop's wake-up; called when new chat work is queued. */
export function setChatWorkListener(listener: (() => void) | null) {
    workListener = listener;
}

/** Registers a listener for chats replaced by a server copy (another tab or device wrote them). */
export function setRemoteChatListener(listener: ((ref: ChatRef) => void) | null) {
    remoteListener = listener;
}

function nextSeq() {
    localSeq += 1;
    return localSeq;
}

/** Records that a chat changed in the mirror (its version, and the drift check's token). */
function changed(key: string) {
    versions.set(key, (versions.get(key) ?? 0) + 1);
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

/** JSON with object keys sorted, for comparing a chat with the server's copy whatever the key order. */
function canonical(value: unknown): string {
    return JSON.stringify(value, (_key, entry: unknown) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
            ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : entry,
    );
}

function findCharacter(chaId: string): AnyCharacter | undefined {
    return DBState.db.characters?.find((entry) => entry?.chaId === chaId);
}

function requireCharacter(chaId: string): AnyCharacter {
    const character = findCharacter(chaId);
    if (!character) {
        throw new Error(`No character ${chaId}`);
    }
    return character;
}

/** A character with its chat mirror writable: the view only this module uses. */
type WritableCharacter = Omit<AnyCharacter, "chats" | "chatPage"> & { chats: Chat[]; chatPage: number };

function writable(character: AnyCharacter): WritableCharacter {
    return character as unknown as WritableCharacter;
}

/** The mirror's chat list of a character, writable here only. */
function chatsOf(character: AnyCharacter): Chat[] {
    const target = writable(character);
    if (!Array.isArray(target.chats)) {
        target.chats = [];
    }
    return target.chats;
}

/** The mirror's chat, writable (this module only). */
function mirrorChat(ref: ChatRef): Chat | undefined {
    const character = findCharacter(ref.chaId);
    return character ? chatsOf(character).find((chat) => chat.id === ref.chatId) : undefined;
}

/** The mirror's chat; read-only (change it through this module). */
export function findChat(ref: ChatRef): DeepReadonly<Chat> | undefined {
    return mirrorChat(ref);
}

function requireChat(ref: ChatRef): Chat {
    const chat = mirrorChat(ref);
    if (!chat) {
        throw new Error(`No chat ${ref.chatId} in character ${ref.chaId}`);
    }
    return chat;
}

/** The ref of a chat in the mirror. */
export function chatRef(character: AnyCharacter, chat: DeepReadonly<Chat>): ChatRef {
    return { chaId: character.chaId, chatId: chat.id! };
}

/** The ref of the selected character's selected chat, or null. */
export function currentChatRef(): ChatRef | null {
    const character = DBState.db.characters?.[get(selectedCharID)];
    const chat = character?.chats?.[character.chatPage];
    return character && chat?.id ? { chaId: character.chaId, chatId: chat.id } : null;
}

/** A chat as sent: a plain copy without the client-only streaming flags. */
function projectChat(chat: Chat): Chat {
    const copy = snapshot(chat);
    delete copy.isStreaming;
    delete copy.activeStreamingDisplayOptimizationMode;
    copy.message ??= [];
    return copy;
}

function ensureMessageIds(messages: Message[], taken: Set<string>) {
    for (const message of messages) {
        if (!isValidId(message.chatId) || taken.has(message.chatId)) {
            message.chatId = uuidv4();
        }
        taken.add(message.chatId);
    }
}

function pendingFor(ref: ChatRef): Pending {
    const key = keyOf(ref.chaId, ref.chatId);
    let entry = pending.get(key);
    if (!entry) {
        entry = { characterId: ref.chaId, chatId: ref.chatId, create: false, resend: null, ops: [], seq: 0 };
        pending.set(key, entry);
    }
    return entry;
}

/** The highest local sequence of a chat's queued or in-flight work. */
function workSeq(key: string): number {
    const entry = pending.get(key);
    return Math.max(entry?.seq ?? 0, entry?.resend?.seq ?? 0, inflight.get(key)?.seq ?? 0);
}

/** Queues an op for a chat, coalescing it with the previous unsent op when that is safe. */
function enqueue(ref: ChatRef, op: ChatOp) {
    const entry = pendingFor(ref);
    entry.seq = nextSeq();
    const last = entry.ops[entry.ops.length - 1];
    if (!(last && coalesce(last, op))) {
        entry.ops.push(op);
    }
    notifyWork();
}

/** Folds `next` into `last` (both unsent, consecutive) when the result is the same; returns whether it did. */
function coalesce(last: ChatOp, next: ChatOp): boolean {
    const sameGeneration = (a?: MessageGeneration, b?: MessageGeneration) => a?.id === b?.id && !a?.final;
    if (last.op === "setText" && next.op === "setText" && last.id === next.id) {
        if (!sameGeneration(last.generation, next.generation)) {
            return false;
        }
        last.text = next.text;
        last.generation = next.generation;
        return true;
    }
    if (last.op === "setMessage" && next.op === "setText" && last.message.chatId === next.id) {
        if (!sameGeneration(last.generation, next.generation)) {
            return false;
        }
        last.message = { ...last.message, data: next.text };
        last.generation = next.generation;
        return true;
    }
    if (last.op === "setMessage" && next.op === "setMessage" && last.message.chatId === next.message.chatId) {
        if (!sameGeneration(last.generation, next.generation)) {
            return false;
        }
        last.message = next.message;
        last.generation = next.generation;
        return true;
    }
    if (last.op === "meta" && next.op === "meta") {
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
// Locks and generations

function lockOf(ref: ChatRef, messageId: string): Generation | undefined {
    return generations.get(messageKeyOf(ref, messageId));
}

/**
 * Whether a message is locked by a generation (its edit, delete, and regenerate are off). The lock
 * lasts until the final write is acknowledged, after the send returned. Reactive; the chat id is
 * part of the identity: a branched or copied chat keeps its source's message ids, and its copy of
 * the generating message is not locked.
 */
export function isMessageLocked(ref: ChatRef | null, messageId: string | undefined): boolean {
    void lockState.version;
    if (ref === null || messageId === undefined) {
        return false;
    }
    const key = messageKeyOf(ref, messageId);
    return generations.has(key) || serverGenerations.has(key);
}

/**
 * Whether the chat screen shows `messageId` of `ref` as the message being generated (reactive, from
 * `streamingState`). The chat id is part of the identity: a branched or copied chat keeps its
 * source's message ids, and its copy of the generating message is not locked.
 */
export function isStreamingMessage(ref: ChatRef | null, messageId: string | undefined): boolean {
    return (
        ref !== null &&
        messageId !== undefined &&
        streamingState.messageId === messageId &&
        streamingState.chatId === ref.chatId &&
        streamingState.chaId === ref.chaId
    );
}

/** Whether any message of a chat is locked (reactive). */
export function isChatGenerating(ref: ChatRef): boolean {
    void lockState.version;
    const prefix = `${keyOf(ref.chaId, ref.chatId)}\u0000`;
    return [...generations.keys(), ...serverGenerations.keys()].some((key) => key.startsWith(prefix));
}

/** Whether a producer is still generating in a chat (not only waiting for its final write's answer). */
function hasLiveGeneration(ref: ChatRef): boolean {
    const prefix = `${keyOf(ref.chaId, ref.chatId)}\u0000`;
    return (
        [...generations].some(([key, generation]) => key.startsWith(prefix) && !generation.ending) ||
        [...serverGenerations.keys()].some((key) => key.startsWith(prefix))
    );
}

/** Whether any chat of a character has a running generation. */
export function isCharacterGenerating(chaId: string): boolean {
    const prefix = `${chaId}\u0000`;
    return [...generations.keys(), ...serverGenerations.keys()].some((key) => key.startsWith(prefix));
}

/** Whether `generationId` is a generation the server stopped accepting. */
function isRejected(generationId: string | undefined): boolean {
    return generationId !== undefined && rejectedGenerations.has(generationId);
}

/** Throws unless the caller may rewrite or remove these messages (unlocked, or its own generation). */
function assertUnlocked(ref: ChatRef, messageIds: readonly (string | undefined)[], generationId?: string) {
    for (const id of messageIds) {
        if (id === undefined) {
            continue;
        }
        const lock = lockOf(ref, id);
        // A server job's message: no client generation id passes.
        if ((lock && lock.generationId !== generationId) || serverGenerations.has(messageKeyOf(ref, id))) {
            throw new Error("This message is being generated; wait until it finishes");
        }
    }
}

/**
 * Locks a message for a generation and starts persisting it: the server fences the message for this
 * generation, and its text is checkpointed every three seconds until `endGeneration`.
 */
export function beginGeneration(ref: ChatRef, messageId: string, generationId: string) {
    const messageKey = messageKeyOf(ref, messageId);
    const existing = generations.get(messageKey);
    if ((existing && !existing.ending) || serverGenerations.has(messageKey)) {
        throw new Error("This message is being generated; wait until it finishes");
    }
    requireChat(ref);
    if (existing) {
        // The previous generation already queued its final text (continue right after it ended);
        // that write still goes out before this `begin`, and its acknowledgement matches by id.
        releaseGeneration(messageKey, existing.generationId, true);
    }
    const generation: Generation = {
        generationId,
        seq: 0,
        queuedText: null,
        timer: null,
        ending: false,
        begun: false,
    };
    generations.set(messageKey, generation);
    lockState.version += 1;
    generation.timer = setInterval(() => checkpointGeneration(ref, messageId), CHECKPOINT_INTERVAL_MS);
    enqueue(ref, { op: "begin", id: messageId, generationId });
}

/**
 * Mirrors a server generation job's reply (an `accepted` or `chunk` event): locks the message for
 * the job and writes `text` into the mirror. Nothing is queued and the chat's revision does not
 * move: only a whole-chat hydration (`hydrateChat`) advances it. A chunk older than the last one
 * of its generation (`seq`) is dropped. Returns false when the chat or message is not in the mirror
 * (its hydration comes first) or the chunk is old.
 */
export function applyServerGeneration(
    ref: ChatRef,
    update: { jobId: string; messageId: string; generationId: string; text: string; seq: number },
): boolean {
    if (retiredGenerations.has(update.generationId)) {
        return false;
    }
    const message = mirrorChat(ref)?.message.find((entry) => entry.chatId === update.messageId);
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
    if (older) {
        return false;
    }
    message.data = update.text;
    changed(keyOf(ref.chaId, ref.chatId));
    return true;
}

/**
 * Releases every message a server generation job still locks (its terminal event). The terminal's
 * chat hydration normally released them already; one still locked here may hold streamed text
 * instead of the stored final, so its chat is marked for an idle refresh.
 */
export function endServerJob(jobId: string) {
    let released = false;
    for (const [messageKey, entry] of [...serverGenerations]) {
        if (entry.jobId === jobId) {
            serverGenerations.delete(messageKey);
            serverWatermarks.delete(messageKey);
            retiredGenerations.add(entry.generationId);
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
    }
}

/**
 * Applies a chat `resource` event of a server job: the server's whole chat replaces the mirror's
 * when its revision is at least the held one and the chat has no local work (pending, in flight,
 * deferred, quarantined, refused for a generating message) and no client generation; otherwise the
 * chat is marked for an idle refresh. A chat the mirror lacks, or one this client has not seen on
 * the server, is not hydrated. Nothing is queued, discarded, or settled, and no notice is shown.
 *
 * `job` (a job's chat event): its `streaming` messages are still generating, each with the newest
 * chunk the copy holds; a streamed text with a higher `seq` is put back on its message, and its lock
 * stays. Every other lock of that job in the chat is released (the reply is final in the copy; if the
 * copy could not be applied for local work, the chat is marked for an idle refresh). Another job's
 * locks and newer streamed text are kept. A copy older than the held revision, or of another epoch,
 * changes nothing, its job metadata included. Returns whether it applied.
 */
export function hydrateChat(
    server: { characterId: string; id: string; revision: string; data: Chat },
    job?: { jobId: string; streaming: readonly StreamingMessage[] },
): boolean {
    const key = keyOf(server.characterId, server.id);
    const prefix = `${key}\u0000`;
    const outcome = applyChatHydration(server);
    if (outcome === "old") {
        return false;
    }
    let released = false;
    const metadataHeld = jobMetadataRevisions.get(key);
    const metadataCurrent = !metadataHeld || (compareRevision(server.revision, metadataHeld) ?? -1) >= 0;
    if (job && metadataCurrent) {
        jobMetadataRevisions.set(key, server.revision);
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
                released = true;
            }
            if (outcome === "applied") {
                // Only a copy in the mirror holds those chunks.
                serverWatermarks.set(messageKey, { generationId: entry.generationId, seq: entry.seq });
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
            const message = mirrorChat({ chaId: server.characterId, chatId: server.id })?.message.find(
                (candidate) => candidate.chatId === messageKey.slice(prefix.length),
            );
            if (message) {
                message.data = entry.text;
            }
        }
    }
    if (released) {
        lockState.version += 1;
        if (outcome === "busy" && chatRevisions.has(key)) {
            staleChats.add(key);
        }
        notifyWork();
    }
    return outcome === "applied";
}

/** "applied"; "busy" (current, but local work keeps the mirror's copy: marked stale); "old" (older, another epoch, or unknown). */
function applyChatHydration(server: {
    characterId: string;
    id: string;
    revision: string;
    data: Chat;
}): "applied" | "busy" | "old" {
    const key = keyOf(server.characterId, server.id);
    const ref = { chaId: server.characterId, chatId: server.id };
    const character = findCharacter(server.characterId);
    const held = chatRevisions.get(key);
    if (!character || !mirrorChat(ref) || held === undefined) {
        return "old";
    }
    const order = compareRevision(server.revision, held);
    if (order === null || order < 0) {
        return "old";
    }
    const prefix = `${key}\u0000`;
    if (
        pending.has(key) ||
        inflight.has(key) ||
        deferred.has(key) ||
        quarantined.has(key) ||
        jobBlocked.has(key) ||
        [...generations.keys()].some((messageKey) => messageKey.startsWith(prefix))
    ) {
        staleChats.add(key);
        return "busy";
    }
    const chats = chatsOf(character);
    const index = chats.findIndex((chat) => chat.id === server.id);
    chats[index] = clone<Chat>(server.data);
    chatRevisions.set(key, server.revision);
    staleChats.delete(key);
    changed(key);
    syncChatPage(server.characterId);
    remoteListener?.(ref);
    return "applied";
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

function stopTimer(generation: Generation) {
    if (generation.timer !== null) {
        clearInterval(generation.timer);
        generation.timer = null;
    }
}

/** Queues the generating message's current text as a checkpoint when it changed since the last one. */
export function checkpointGeneration(ref: ChatRef, messageId: string) {
    const generation = lockOf(ref, messageId);
    if (!generation || generation.ending) {
        return;
    }
    const message = mirrorChat(ref)?.message.find((entry) => entry.chatId === messageId);
    if (!message || message.data === generation.queuedText) {
        return;
    }
    generation.seq += 1;
    generation.queuedText = message.data;
    enqueue(ref, {
        op: "setText",
        id: messageId,
        text: message.data,
        generation: { id: generation.generationId, seq: generation.seq },
    });
}

/** Queues a checkpoint for every running generation (before a flush). */
export function checkpointAllGenerations() {
    for (const key of generations.keys()) {
        const [chaId, chatId, messageId] = key.split("\u0000");
        checkpointGeneration({ chaId, chatId }, messageId);
    }
}

/** Whether a generation is running (the save loop keeps an unload request ready meanwhile). */
export function hasRunningGenerations(): boolean {
    return [...generations.values()].some((generation) => !generation.ending);
}

/**
 * A best-effort request as the page goes away (`pagehide`): the whole current text of each running
 * generation the server knows, as a checkpoint, with its groups as sent. A text goes whole or not at
 * all, and only while the body stays within `limitBytes` (the `keepalive` budget); a suffix is never
 * sent, since output scripts can rewrite the text before it. A chat with a request in flight is
 * skipped: that request already carries its latest checkpoint, and two writes of this client on one
 * base would leave its revision behind the server's if the page survives. Returns null when there is
 * nothing. Once the request is sent, `trackUnloadCheckpoint` keeps the loop from sending more for
 * these chats until `settleUnloadCheckpoint` records the answer (the page may stay: back-forward
 * cache) or its loss.
 */
export function unloadCheckpoint(limitBytes: number): { body: string; work: ChatWork } | null {
    const groups = new Map<string, SentChatGroup>();
    const encoder = new TextEncoder();
    const bodyOf = () => `{"chats":[${chatWorkBody({ groups: [...groups.values()], orders: [] }).chats.join(",")}]}`;
    for (const [messageKey, generation] of generations) {
        if (generation.ending || !generation.begun) {
            continue;
        }
        const [chaId, chatId, messageId] = messageKey.split("\u0000");
        const key = keyOf(chaId, chatId);
        const baseRevision = chatRevisions.get(key);
        const message = mirrorChat({ chaId, chatId })?.message.find((entry) => entry.chatId === messageId);
        if (
            !baseRevision ||
            !message ||
            deferred.has(key) ||
            quarantined.has(key) ||
            inflight.has(key) ||
            isJobBlocked(key)
        ) {
            continue;
        }
        const previous = groups.get(key);
        const ops: ChatOp[] = [
            ...(previous?.ops ?? []),
            {
                op: "setText",
                id: messageId,
                text: message.data,
                generation: { id: generation.generationId, seq: generation.seq + 1 },
            },
        ];
        // Sequence 0: settling it settles nothing (the chat's own work keeps its sequence).
        groups.set(key, sentGroup(key, { characterId: chaId, chatId } as Pending, baseRevision, ops, 0));
        if (encoder.encode(bodyOf()).length > limitBytes) {
            if (previous) {
                groups.set(key, previous);
            } else {
                groups.delete(key);
            }
            continue;
        }
        // The page may stay (back-forward cache): later checkpoints must still supersede this one,
        // and this text needs no checkpoint of its own again.
        generation.seq += 1;
        generation.queuedText = message.data;
    }
    if (groups.size === 0) {
        return null;
    }
    return { body: bodyOf(), work: { groups: [...groups.values()], orders: [] } };
}

/** Marks an unload checkpoint's groups in flight (the request was sent). */
export function trackUnloadCheckpoint(work: ChatWork) {
    for (const group of work.groups) {
        if (group.unloadPending) {
            const entry = pending.get(group.key);
            if (entry) {
                entry.ops = entry.ops.slice(group.ops.length);
                if (entry.ops.length === 0) {
                    pending.delete(group.key);
                }
            }
        }
        inflight.set(group.key, group);
    }
}

/**
 * Records the answer to an unload checkpoint the page survived to receive (`results` in group
 * order; null: the request failed or was refused, and the ordinary checkpoints carry on). The
 * revision rule is the acknowledgement's: a group applied on the current revision moves the base,
 * a `stale` one requests an idle refresh (the chat holds changes this client has not seen), and a
 * generation the server no longer accepts stops. The chats' queued work goes out again.
 */
export function settleUnloadCheckpoint(work: ChatWork, results: readonly ChatGroupResult[] | null) {
    work.groups.forEach((group, index) => {
        if (group.unloadPending) {
            const taken = { groups: [group], orders: [] };
            if (results?.[index]) {
                ackChatWork(taken, [results[index]], []);
            } else {
                requeueChatWork(taken);
            }
            return;
        }
        if (inflight.get(group.key) === group) {
            inflight.delete(group.key);
        }
        const result = results?.[index];
        if (!result) {
            return;
        }
        if (result.revision !== null && (!result.stale || !chatRevisions.has(group.key))) {
            chatRevisions.set(group.key, result.revision);
        }
        if (result.stale) {
            staleChats.add(group.key);
        }
        (result.checkpoints ?? []).forEach((outcome, opIndex) => {
            const op = group.generationOps[opIndex];
            if (outcome === "ignored" && op) {
                console.warn("[Chat] The server no longer accepts this generation's text; it stops saving");
                rejectGeneration(op.messageKey, op.generationId);
            }
        });
    });
    notifyWork();
}

/**
 * Pending by-id work for existing chats, one request per chat within the remaining shared budget.
 * Take only an eligible prefix: jumping past a replace/begin/delete could change its meaning.
 * Nothing leaves the queue until `trackUnloadCheckpoint` confirms the request was sent.
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
        const ops: ChatOp[] = [];
        for (const op of entry.ops) {
            if (
                op.op !== "append" &&
                op.op !== "setText" &&
                op.op !== "setMessage" &&
                op.op !== "meta" &&
                !(op.op === "remove" && op.ids.length === 1)
            ) {
                break;
            }
            if (ops.length === 5000) {
                break;
            }
            ops.push(op);
        }
        if (ops.length === 0) {
            continue;
        }
        const group = sentGroup(key, entry, base, ops, ops.length === entry.ops.length ? entry.seq : 0);
        group.unloadPending = true;
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

/**
 * Ends a generation: sends the message's current text as its final write. The lock stays until
 * that write is acknowledged or discarded, so no older checkpoint can land after it. A generation
 * whose chat reload waits retains its final text and lock: the reload reapplies the final on the
 * fresh revision before the lock can be released.
 */
export function endGeneration(ref: ChatRef, messageId: string, generationId: string) {
    const messageKey = messageKeyOf(ref, messageId);
    const generation = generations.get(messageKey);
    if (!generation || generation.generationId !== generationId || generation.ending) {
        return;
    }
    stopTimer(generation);
    const message = mirrorChat(ref)?.message.find((entry) => entry.chatId === messageId);
    if (!message) {
        releaseGeneration(messageKey, generationId);
        return;
    }
    generation.ending = true;
    generation.seq += 1;
    const op: GenerationFinal["op"] = {
        op: "setText",
        id: messageId,
        text: message.data,
        generation: { id: generationId, seq: generation.seq, final: true },
    };
    generationFinals.set(generationId, { messageKey, op: clone(op), begun: generation.begun });
    enqueue(ref, op);
}

function releaseGeneration(messageKey: string, generationId: string, keepFinal = false) {
    if (!keepFinal) {
        generationFinals.delete(generationId);
    }
    const generation = generations.get(messageKey);
    if (!generation || generation.generationId !== generationId) {
        return;
    }
    stopTimer(generation);
    generations.delete(messageKey);
    lockState.version += 1;
    const [chaId, chatId, messageId] = messageKey.split("\u0000");
    if (streamingState.chaId === chaId && streamingState.chatId === chatId && streamingState.messageId === messageId) {
        setStreamingState(null);
    }
    if (deferred.size > 0) {
        notifyWork();
    }
}

/** Stops a generation the server no longer accepts: later writes carrying its id do nothing. */
function rejectGeneration(messageKey: string, generationId: string) {
    rejectedGenerations.set(generationId, messageKey);
    releaseGeneration(messageKey, generationId);
}

/** Releases (and rejects, when still running) every generation of a chat whose work is dropped. */
function dropGenerations(key: string) {
    for (const [id, final] of generationFinals) {
        if (final.messageKey.startsWith(`${key}\u0000`)) {
            releaseGeneration(final.messageKey, id);
        }
    }
    for (const [messageKey, generation] of [...generations]) {
        if (messageKey.startsWith(`${key}\u0000`)) {
            if (generation.ending) {
                releaseGeneration(messageKey, generation.generationId);
            } else {
                rejectGeneration(messageKey, generation.generationId);
            }
        }
    }
}

/** Sets or clears the message the chat screen shows as streaming. */
export function setStreamingState(
    target: (ChatRef & { messageId: string; mode: Chat["activeStreamingDisplayOptimizationMode"] }) | null,
) {
    streamingState.chaId = target?.chaId ?? null;
    streamingState.chatId = target?.chatId ?? null;
    streamingState.messageId = target?.messageId ?? null;
    streamingState.mode = target?.mode;
}

// ---------------------------------------------------------------------------------------------
// Chat membership and selection

/**
 * Creates a chat in a character at `index` (default: the end). Missing or duplicate chat and message
 * ids are assigned. Returns the mirror's chat.
 */
export function createChat(
    chaId: string,
    input: DeepReadonly<Chat>,
    options: { index?: number; select?: boolean } = {},
): DeepReadonly<Chat> {
    const character = requireCharacter(chaId);
    const chats = chatsOf(character);
    const chat = clone<Chat>(input);
    delete chat.isStreaming;
    delete chat.activeStreamingDisplayOptimizationMode;
    if (!isValidId(chat.id) || chats.some((entry) => entry.id === chat.id)) {
        chat.id = uuidv4();
    }
    chat.message ??= [];
    ensureMessageIds(chat.message, new Set());
    const index = Math.max(0, Math.min(options.index ?? chats.length, chats.length));
    chats.splice(index, 0, chat);
    const key = keyOf(chaId, chat.id);
    changed(key);
    const entry = pendingFor({ chaId, chatId: chat.id });
    entry.create = true;
    entry.seq = nextSeq();
    syncChatPage(chaId);
    if (options.select) {
        selectChat(chaId, chat.id);
    }
    notifyWork();
    return chats[index];
}

/** Gives a character without chats its first chat. */
export function ensureChat(chaId: string) {
    const character = findCharacter(chaId);
    if (character && chatsOf(character).length === 0) {
        createChat(chaId, { message: [], note: "", name: "Chat 1", localLore: [], fmIndex: -1 }, { index: 0 });
    }
}

/** Deletes a chat. The last chat of a character and a chat being generated in cannot be deleted. */
export function deleteChat(ref: ChatRef) {
    const character = requireCharacter(ref.chaId);
    const chats = chatsOf(character);
    const index = chats.findIndex((chat) => chat.id === ref.chatId);
    if (index === -1) {
        return;
    }
    if (chats.length === 1) {
        throw new Error("A character needs at least one chat");
    }
    if (isChatGenerating(ref)) {
        throw new Error("This chat is being generated; wait until it finishes");
    }
    chats.splice(index, 1);
    const key = keyOf(ref.chaId, ref.chatId);
    changed(key);
    const entry = pending.get(key);
    const seq = nextSeq();
    if (entry?.create && !inflight.has(key)) {
        // Never sent: nothing to delete on the server.
        pending.delete(key);
        settleKey(key, seq);
    } else {
        pending.set(key, {
            characterId: ref.chaId,
            chatId: ref.chatId,
            create: false,
            resend: entry?.resend ?? null,
            ops: [{ op: "delete" }],
            seq,
        });
    }
    syncChatPage(ref.chaId);
    notifyWork();
}

/** Reorders a character's chats to `ids` (a permutation of its chat ids). */
export function reorderChats(chaId: string, ids: readonly string[]) {
    const character = requireCharacter(chaId);
    const chats = chatsOf(character);
    const byId = new Map(chats.map((chat) => [chat.id!, chat]));
    if (ids.length !== chats.length || !ids.every((id) => byId.has(id)) || new Set(ids).size !== ids.length) {
        throw new Error("reorderChats needs a permutation of the character's chat ids");
    }
    if (ids.every((id, index) => chats[index].id === id)) {
        return;
    }
    const ordered = ids.map((id) => byId.get(id)!);
    chats.splice(0, chats.length, ...ordered);
    mutationToken += 1;
    pendingOrders.set(chaId, nextSeq());
    syncChatPage(chaId);
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
    selectedChats.clear();
    for (const [chaId, chatId] of Object.entries(readSelectionPreference())) {
        if (typeof chatId === "string") {
            selectedChats.set(chaId, chatId);
        }
    }
}

/** Selects a chat of a character by id or index; `chatPage` follows. */
export function selectChat(chaId: string, idOrIndex: string | number) {
    const character = findCharacter(chaId);
    if (!character) {
        return;
    }
    const chats = chatsOf(character);
    const chat = typeof idOrIndex === "number" ? chats[idOrIndex] : chats.find((entry) => entry.id === idOrIndex);
    if (!chat?.id) {
        return;
    }
    selectedChats.set(chaId, chat.id);
    writeSelectionPreference(chaId, chat.id);
    syncChatPage(chaId);
}

/** Recomputes a character's `chatPage` from its selected chat id (falling back to the first chat). */
export function syncChatPage(chaId: string) {
    const character = findCharacter(chaId);
    if (!character) {
        return;
    }
    const chats = chatsOf(character);
    let index = chats.findIndex((chat) => chat.id === selectedChats.get(chaId));
    if (index === -1) {
        index = 0;
        if (chats[0]?.id) {
            selectedChats.set(chaId, chats[0].id);
        }
    }
    if (character.chatPage !== index) {
        writable(character).chatPage = index;
    }
}

// ---------------------------------------------------------------------------------------------
// Messages and metadata

function indexOfMessage(chat: Chat, id: string): number {
    return chat.message.findIndex((message) => message.chatId === id);
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
    ensureMessageIds(messages, new Set(chat.message.map((message) => message.chatId!)));
    const anchor = ownAnchor(options.anchor ?? { end: true });
    let position: number;
    if ("start" in anchor) {
        position = 0;
    } else if ("end" in anchor) {
        position = chat.message.length;
    } else {
        const after = indexOfMessage(chat, anchor.after);
        if (after === -1) {
            throw new Error(`No message ${anchor.after} to insert after`);
        }
        position = after + 1;
    }
    chat.message.splice(position, 0, ...messages);
    changed(keyOf(ref.chaId, ref.chatId));
    enqueue(ref, { op: "append", messages: clone(messages), anchor });
    return messages.map((message) => message.chatId!);
}

/**
 * The stamp of a write by the generation that owns a message: `undefined` for an ordinary write
 * (no `generationId`), `null` when the write must be dropped (its generation was rejected, or the
 * id is not the message's running generation).
 */
function generationWrite(
    ref: ChatRef,
    messageId: string,
    options: { generationId?: string },
): MessageGeneration | undefined | null {
    if (options.generationId === undefined) {
        return undefined;
    }
    const generation = lockOf(ref, messageId);
    if (!generation || generation.generationId !== options.generationId || generation.ending) {
        return null;
    }
    generation.seq += 1;
    return { id: generation.generationId, seq: generation.seq };
}

/**
 * Replaces one message by its id (`message.chatId`). With `generationId`, a write by the message's
 * own running generation; it does nothing when that generation no longer owns the message.
 */
export function replaceMessage(ref: ChatRef, input: DeepReadonly<Message>, options: { generationId?: string } = {}) {
    const chat = requireChat(ref);
    const message = clone<Message>(input);
    const index = indexOfMessage(chat, message.chatId!);
    if (index === -1) {
        throw new Error(`No message ${message.chatId}`);
    }
    if (options.generationId !== undefined && !isOwner(ref, message.chatId!, options.generationId)) {
        return;
    }
    assertUnlocked(ref, [message.chatId], options.generationId);
    const generation = generationWrite(ref, message.chatId!, options);
    if (generation === null) {
        return;
    }
    chat.message[index] = message;
    changed(keyOf(ref.chaId, ref.chatId));
    enqueue(ref, { op: "setMessage", message: clone(message), generation });
}

function isOwner(ref: ChatRef, messageId: string, generationId: string): boolean {
    const generation = lockOf(ref, messageId);
    return !!generation && generation.generationId === generationId && !generation.ending;
}

/**
 * Sets a message's text. A write by the message's own running generation (`generationId`) only
 * updates the mirror (its checkpoints and final write carry it); with any other `generationId` it
 * does nothing.
 */
export function setMessageText(ref: ChatRef, id: string, text: string, options: { generationId?: string } = {}) {
    const chat = requireChat(ref);
    const index = indexOfMessage(chat, id);
    if (index === -1) {
        throw new Error(`No message ${id}`);
    }
    if (options.generationId !== undefined) {
        if (!isOwner(ref, id, options.generationId)) {
            return;
        }
        if (chat.message[index].data !== text) {
            chat.message[index].data = text;
            changed(keyOf(ref.chaId, ref.chatId));
        }
        return;
    }
    assertUnlocked(ref, [id]);
    if (chat.message[index].data !== text) {
        chat.message[index].data = text;
        changed(keyOf(ref.chaId, ref.chatId));
    }
    enqueue(ref, { op: "setText", id, text });
}

/**
 * Removes messages by id. Removing several needs the chat's current revision on the server. A
 * locked message can be removed only by its own generation (`generationId`); with a rejected
 * generation id nothing happens.
 */
export function removeMessages(ref: ChatRef, ids: readonly string[], options: { generationId?: string } = {}) {
    if (isRejected(options.generationId)) {
        return;
    }
    const chat = requireChat(ref);
    const present = ids.filter((id) => indexOfMessage(chat, id) !== -1);
    if (present.length === 0) {
        return;
    }
    assertUnlocked(ref, present, options.generationId);
    applyRemoval(ref, chat, present);
}

/** Removes messages already checked against the locks, as one op (several need the current revision). */
function applyRemoval(ref: ChatRef, chat: Chat, present: readonly string[]) {
    const removing = new Set(present);
    const kept = chat.message.filter((message) => !removing.has(message.chatId!));
    chat.message.splice(0, chat.message.length, ...kept);
    changed(keyOf(ref.chaId, ref.chatId));
    enqueue(ref, { op: "remove", ids: [...removing] });
}

/**
 * Sets and removes chat fields (not `id`, `message`, or the streaming flags). Values equal to the
 * current ones are skipped, so a component can commit its whole editing copy without echo.
 */
export function setChatMeta(
    ref: ChatRef,
    set: Partial<DeepReadonly<Chat>> | Record<string, unknown>,
    unset: readonly string[] = [],
) {
    const chat = requireChat(ref) as unknown as Record<string, unknown>;
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(set)) {
        if (forbiddenMetaKeys.has(key)) {
            throw new Error(`setChatMeta cannot change ${key}`);
        }
        if (value === undefined) {
            continue;
        }
        if (JSON.stringify($state.snapshot(chat[key])) !== JSON.stringify(value)) {
            changes[key] = clone(value);
        }
    }
    const removals = unset.filter((key) => {
        if (forbiddenMetaKeys.has(key)) {
            throw new Error(`setChatMeta cannot change ${key}`);
        }
        return Object.hasOwn(chat, key) && !Object.hasOwn(changes, key);
    });
    if (Object.keys(changes).length === 0 && removals.length === 0) {
        return;
    }
    for (const [key, value] of Object.entries(changes)) {
        chat[key] = clone(value);
    }
    for (const key of removals) {
        delete chat[key];
    }
    changed(keyOf(ref.chaId, ref.chatId));
    enqueue(ref, { op: "meta", set: changes, unset: removals });
}

/**
 * Adds entries to a chat field that is a map (`toolCalls`). The server merges them into the map as
 * stored, so an entry another device added meanwhile is kept (a `meta` set would replace the map).
 */
export function mergeChatMeta(ref: ChatRef, key: string, entries: Record<string, unknown>) {
    if (!CHAT_META_MERGE_KEYS.includes(key)) {
        throw new Error(`mergeChatMeta cannot merge ${key}`);
    }
    if (Object.keys(entries).length === 0) {
        return;
    }
    const chat = requireChat(ref) as unknown as Record<string, unknown>;
    const added = clone(entries);
    chat[key] = { ...((chat[key] as Record<string, unknown> | undefined) ?? {}), ...added };
    changed(keyOf(ref.chaId, ref.chatId));
    enqueue(ref, { op: "meta", merge: { [key]: clone(entries) } });
}

/**
 * Replaces a whole chat (fields and messages); needs the chat's current revision on the server.
 * Refused while a generation runs in the chat (the server treats it as a manual write of every
 * message, which would close the generation's fence).
 */
export function replaceChat(ref: ChatRef, input: DeepReadonly<Chat>) {
    const character = requireCharacter(ref.chaId);
    const chats = chatsOf(character);
    const index = chats.findIndex((chat) => chat.id === ref.chatId);
    if (index === -1) {
        throw new Error(`No chat ${ref.chatId}`);
    }
    if (isChatGenerating(ref)) {
        throw new Error("This chat is being generated; wait until it finishes");
    }
    const chat = clone<Chat>(input);
    chat.id = ref.chatId;
    chat.message ??= [];
    ensureMessageIds(chat.message, new Set());
    delete chat.isStreaming;
    delete chat.activeStreamingDisplayOptimizationMode;
    chats[index] = chat;
    changed(keyOf(ref.chaId, ref.chatId));
    enqueue(ref, { op: "replace", chat: projectChat(chat) });
}

/** What a hook started from: a detached copy of the chat and the chat's version then. */
export type ChatBaseline = { ref: ChatRef; chat: Chat; version: number };

/** Captures a chat before a hook works on a copy of it (for `applyChatResult`). */
export function captureChatBaseline(ref: ChatRef): ChatBaseline {
    return {
        ref,
        chat: projectChat(requireChat(ref)),
        version: versions.get(keyOf(ref.chaId, ref.chatId)) ?? 0,
    };
}

const nonMetaKeys = new Set(["message", "id", "isStreaming", "activeStreamingDisplayOptimizationMode"]);

/**
 * Applies what a hook changed in its copy of a chat (`result`) against the copy it started from
 * (`baseline`), onto the chat as it is now: messages the hook removed are removed, added ones are
 * inserted after their predecessor, changed message fields are merged into the current message,
 * changed chat fields are set or removed. Changes made meanwhile by others are kept. When the hook
 * reordered surviving messages, the whole chat is replaced, but only if the chat has not changed
 * since the baseline and no generation runs in it (otherwise the order change is dropped with a
 * warning). Everything is checked against the locks before the mirror changes; `generationId` lets
 * the running generation change its own message. Changes to a message whose generation was
 * rejected are dropped.
 */
export function applyChatResult(
    baseline: ChatBaseline,
    result: DeepReadonly<Chat>,
    options: { generationId?: string } = {},
) {
    const { ref } = baseline;
    const current = mirrorChat(ref);
    if (!current) {
        return;
    }
    const rejectedMessage = isRejected(options.generationId)
        ? rejectedGenerations.get(options.generationId!)!.split("\u0000")[2]
        : null;
    const writeOptions = rejectedMessage === null ? options : {};
    const next = clone<Chat>(result);
    next.message ??= [];
    const baseMessages = new Map(baseline.chat.message.map((message) => [message.chatId!, message]));
    ensureMessageIds(next.message, new Set());
    for (const message of next.message) {
        // A new message may not reuse an id the chat already has.
        if (!baseMessages.has(message.chatId!) && indexOfMessage(current, message.chatId!) !== -1) {
            message.chatId = uuidv4();
        }
    }
    const resultIds = new Set(next.message.map((message) => message.chatId!));
    const removed = baseline.chat.message
        .map((message) => message.chatId!)
        .filter((id) => id !== rejectedMessage && !resultIds.has(id) && indexOfMessage(current, id) !== -1);
    const changedMessages = next.message.filter((message) => {
        const before = baseMessages.get(message.chatId!);
        return (
            message.chatId !== rejectedMessage &&
            before !== undefined &&
            JSON.stringify(before) !== JSON.stringify(message)
        );
    });
    const survivorsBefore = baseline.chat.message.map((message) => message.chatId!).filter((id) => resultIds.has(id));
    const survivorsAfter = next.message.map((message) => message.chatId!).filter((id) => baseMessages.has(id));
    const reordered = survivorsBefore.some((id, index) => survivorsAfter[index] !== id);
    // The capability covers only the messages its generation owns; other messages are ordinary writes.
    const optionsFor = (id: string) =>
        writeOptions.generationId !== undefined && lockOf(ref, id)?.generationId === writeOptions.generationId
            ? writeOptions
            : {};
    for (const id of [...removed, ...changedMessages.map((message) => message.chatId!)]) {
        assertUnlocked(ref, [id], optionsFor(id).generationId);
    }

    if (reordered) {
        const unchanged = baseline.version === (versions.get(keyOf(ref.chaId, ref.chatId)) ?? 0);
        if (unchanged && !isChatGenerating(ref) && rejectedMessage === null) {
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
    for (const message of changedMessages) {
        const before = baseMessages.get(message.chatId!)!;
        const index = indexOfMessage(current, message.chatId!);
        if (index === -1) {
            continue;
        }
        const merged = snapshot(current.message[index]) as unknown as Record<string, unknown>;
        const beforeFields = before as unknown as Record<string, unknown>;
        const afterFields = message as unknown as Record<string, unknown>;
        for (const key of new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])) {
            if (JSON.stringify(beforeFields[key]) !== JSON.stringify(afterFields[key])) {
                if (Object.hasOwn(afterFields, key)) {
                    merged[key] = afterFields[key];
                } else {
                    delete merged[key];
                }
            }
        }
        replaceMessage(ref, merged as unknown as Message, optionsFor(message.chatId!));
    }
    let previous: string | null = null;
    for (const message of next.message) {
        const id = message.chatId!;
        if (!baseMessages.has(id)) {
            const anchor: MessageAnchor =
                previous === null
                    ? { start: true }
                    : indexOfMessage(current, previous) !== -1
                      ? { after: previous }
                      : { end: true };
            appendMessage(ref, message, { anchor });
        }
        if (indexOfMessage(current, id) !== -1) {
            previous = id;
        }
    }

    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    const baseFields = baseline.chat as unknown as Record<string, unknown>;
    const nextFields = next as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(baseFields), ...Object.keys(nextFields)])) {
        if (nonMetaKeys.has(key) || JSON.stringify(baseFields[key]) === JSON.stringify(nextFields[key])) {
            continue;
        }
        if (Object.hasOwn(nextFields, key) && nextFields[key] !== undefined) {
            set[key] = nextFields[key];
        } else {
            unset.push(key);
        }
    }
    if (Object.keys(set).length > 0 || unset.length > 0) {
        setChatMeta(ref, set, unset);
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
        if (mirrorChat(ref)) {
            try {
                applyChatResult(captureChatBaseline(ref), chat);
            } catch (error) {
                console.warn("[Chat] Skipped a plugin change to a chat being generated", error);
            }
        } else {
            createChat(chaId, chat);
        }
    }
    const incomingIds = new Set(chats.map((chat) => chat.id!));
    for (const chat of [...chatsOf(character)]) {
        if (!incomingIds.has(chat.id!) && chatsOf(character).length > 1) {
            try {
                deleteChat({ chaId, chatId: chat.id! });
            } catch (error) {
                console.warn("[Chat] Kept a chat a plugin removed", error);
            }
        }
    }
    const order = chats.map((chat) => chat.id!).filter((id) => chatsOf(character).some((chat) => chat.id === id));
    const rest = chatsOf(character)
        .map((chat) => chat.id!)
        .filter((id) => !order.includes(id));
    reorderChats(chaId, [...order, ...rest]);
    if (typeof chatPage === "number") {
        selectChat(chaId, chatPage);
    }
}

// ---------------------------------------------------------------------------------------------
// Boot

/** Records what the server holds (boot read), before anything queues work. */
export function seedChats(chats: readonly ChatRecord[], orders: readonly ChatOrderRecord[]) {
    chatRevisions.clear();
    orderRevisions.clear();
    staleChats.clear();
    noticedChats.clear();
    for (const chat of chats) {
        chatRevisions.set(keyOf(chat.characterId, chat.id), chat.revision);
    }
    for (const order of orders) {
        orderRevisions.set(order.characterId, order.revision);
    }
}

/**
 * Puts each character's chats into the assembled database in their server order (a boot read).
 * Chats missing from the order go last and ids without a chat are skipped, each reported.
 */
export function assembleChats(
    characters: AnyCharacter[],
    chats: readonly ChatRecord[],
    orders: readonly ChatOrderRecord[],
) {
    const byCharacter = new Map<string, Map<string, Chat>>();
    for (const record of chats) {
        let map = byCharacter.get(record.characterId);
        if (!map) {
            map = new Map();
            byCharacter.set(record.characterId, map);
        }
        map.set(record.id, record.data);
    }
    const orderOf = new Map(orders.map((order) => [order.characterId, order.ids]));
    for (const character of characters) {
        if (!character) {
            continue;
        }
        const available = byCharacter.get(character.chaId) ?? new Map<string, Chat>();
        const ordered: Chat[] = [];
        for (const id of orderOf.get(character.chaId) ?? []) {
            const chat = available.get(id);
            if (chat) {
                ordered.push(chat);
                available.delete(id);
            } else {
                console.error(`[Chat] The chat order of ${character.chaId} names a missing chat ${id}`);
            }
        }
        for (const chat of available.values()) {
            console.error(`[Chat] Chat ${chat.id} of ${character.chaId} is missing from its chat order`);
            ordered.push(chat);
        }
        writable(character).chats = ordered;
        writable(character).chatPage = 0;
    }
}

/** Selects each character's remembered chat after boot (and gives chatless characters a chat). */
export function initializeChats() {
    loadSelectionPreference();
    for (const character of DBState.db.characters ?? []) {
        if (!character) {
            continue;
        }
        ensureChat(character.chaId);
        syncChatPage(character.chaId);
    }
}

// ---------------------------------------------------------------------------------------------
// Save loop

/** Whether any chat work waits to be sent or a deferred reload can run. */
export function hasChatWork(canSaveCharacter: (id: string) => boolean = () => true): boolean {
    for (const [key, entry] of pending) {
        if (
            !quarantined.has(key) &&
            !deferred.has(key) &&
            !inflight.has(key) &&
            !isJobBlocked(key) &&
            canSaveCharacter(entry.characterId) &&
            (entry.create || entry.resend || entry.ops.length > 0)
        ) {
            return true;
        }
    }
    return (
        [...pendingOrders.keys()].some(
            (id) => canSaveCharacter(id) && !isOrderQuarantined(id) && orderMembershipReady(id),
        ) ||
        deferredReloads().length > 0 ||
        idleChatRefreshes().length > 0
    );
}

/**
 * Whether a reorder of `chaId` could go out now: every chat the server holds is in the mirror, or
 * its delete can be sent (not blocked, deferred, quarantined, or in flight). `takeChatWork` holds a
 * reorder back otherwise, so it is unsaved but not runnable (a delete refused for a generating
 * message makes the reorder wait for the same retry).
 */
function orderMembershipReady(chaId: string): boolean {
    const character = findCharacter(chaId);
    if (!character) {
        return false;
    }
    const visible = new Set(chatsOf(character).map((chat) => chat.id!));
    const prefix = `${chaId}\u0000`;
    return [...chatRevisions.keys()].every((key) => {
        if (!key.startsWith(prefix) || visible.has(key.slice(prefix.length))) {
            return true;
        }
        const entry = pending.get(key);
        return (
            !!entry?.ops.some((op) => op.op === "delete") &&
            !quarantined.has(key) &&
            !deferred.has(key) &&
            !inflight.has(key) &&
            !isJobBlocked(key)
        );
    });
}

/** Unsaved user work, including requests in flight and live text between checkpoints. */
export function hasUnsavedChatWork(canSaveCharacter: (id: string) => boolean = () => true): boolean {
    for (const key of new Set(
        [...pending.keys(), ...inflight.keys(), ...generations.keys()].map((key) =>
            key.split("\u0000").slice(0, 2).join("\u0000"),
        ),
    )) {
        if (!quarantined.has(key) && canSaveCharacter(key.split("\u0000")[0])) {
            return true;
        }
    }
    return [...pendingOrders.keys(), ...inflightOrders.keys()].some(
        (id) => canSaveCharacter(id) && !isOrderQuarantined(id),
    );
}

function isOrderQuarantined(chaId: string): boolean {
    const refused = quarantinedOrders.get(chaId);
    if (refused === undefined) {
        return false;
    }
    const ids = (findCharacter(chaId)?.chats ?? [])
        .map((chat) => chat.id)
        .filter((id) => chatRevisions.has(keyOf(chaId, id!)));
    if (JSON.stringify(ids) === refused) {
        return true;
    }
    quarantinedOrders.delete(chaId);
    return false;
}

export function quarantineChatOrder(order: SentChatOrder) {
    inflightOrders.delete(order.characterId);
    quarantinedOrders.set(order.characterId, JSON.stringify(order.ids));
    if (!pendingOrders.has(order.characterId)) {
        pendingOrders.set(order.characterId, order.seq);
    }
}

/**
 * Gives a character new to the mirror its chat and message ids (and one chat when it has none),
 * without queuing anything: the save loop's `adoptCharacter` queues the creates with the character.
 * Writers that put a whole character into the mirror call it so its chats are addressable at once.
 */
export function normalizeNewCharacter(chaId: string) {
    const character = findCharacter(chaId);
    if (!character) {
        return;
    }
    const chats = chatsOf(character);
    if (chats.length === 0) {
        chats.push({ id: uuidv4(), message: [], note: "", name: "Chat 1", localLore: [], fmIndex: -1 });
    }
    const ids = new Set<string>();
    for (const chat of chats) {
        if (!isValidId(chat.id) || ids.has(chat.id)) {
            chat.id = uuidv4();
        }
        ids.add(chat.id);
        chat.message ??= [];
        ensureMessageIds(chat.message, new Set());
    }
    mutationToken += 1;
    syncChatPage(chaId);
}

/** Queues creates for a new character's chats (the save loop found it in the mirror, unsaved). */
export function adoptCharacter(chaId: string) {
    const character = findCharacter(chaId);
    if (!character) {
        return;
    }
    normalizeNewCharacter(chaId);
    for (const chat of chatsOf(character)) {
        const key = keyOf(chaId, chat.id);
        const entry = pending.get(key);
        if (!chatRevisions.has(key) && !entry?.create && !entry?.resend && !inflight.has(key)) {
            const created = pendingFor({ chaId, chatId: chat.id });
            created.create = true;
            created.seq = nextSeq();
        }
    }
    syncChatPage(chaId);
}

/** Drops all chat state of a character that is deleted (the server deletes its chats with it). */
export function forgetCharacter(chaId: string) {
    const prefix = `${chaId}\u0000`;
    for (const key of [...staleChats, ...deferred, ...noticedChats.keys()]) {
        if (key.startsWith(prefix)) {
            staleChats.delete(key);
            noticedChats.delete(key);
            deferred.delete(key);
            dropGenerations(key);
        }
    }
    for (const key of [...pending.keys()]) {
        if (key.startsWith(prefix)) {
            settleKey(key, workSeq(key));
            pending.delete(key);
            dropGenerations(key);
        }
    }
    for (const key of [...chatRevisions.keys(), ...jobBlocked.keys()]) {
        if (key.startsWith(prefix)) {
            chatRevisions.delete(key);
            jobBlocked.delete(key);
        }
    }
    const orderSeq = pendingOrders.get(chaId);
    if (orderSeq !== undefined) {
        settleOrder(chaId, orderSeq);
    }
    pendingOrders.delete(chaId);
    orderRevisions.delete(chaId);
    quarantinedOrders.delete(chaId);
}

/** Whether the server knows a character's chats (its order exists) or this batch creates it. */
function isCharacterKnown(chaId: string, creating: ReadonlySet<string>): boolean {
    return orderRevisions.has(chaId) || creating.has(chaId);
}

function mirrorIndex(entry: Pending): number {
    const character = findCharacter(entry.characterId);
    return character ? chatsOf(character).findIndex((chat) => chat.id === entry.chatId) : -1;
}

/**
 * Takes the chat work for one batch and marks it in flight: first creates (never-sent chats as they
 * are in the mirror, per character in mirror order; sent-but-unacknowledged creates exactly as
 * sent), then every other chat with unsent work, then reorders. `creating` names characters the
 * same batch creates; chat work of characters not yet on the server waits. A chat with more unsent
 * ops than `maxOps` (the server's cap on one request) sends the first `maxOps` now and the rest
 * once those are acknowledged, on the revision they produce; its work counts as saved only when the
 * last part is.
 */
export function takeChatWork(creating: ReadonlySet<string>, options: { maxOps?: number } = {}): ChatWork {
    const maxOps = options.maxOps ?? Infinity;
    // A quarantined character create may be removed or re-keyed before ever reaching the server.
    // There is no persisted character deletion to clear its old chat obligations in that case.
    for (const id of new Set([...pending.values()].map((entry) => entry.characterId))) {
        if (!findCharacter(id)) {
            forgetCharacter(id);
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
            a.characterId === b.characterId ? mirrorIndex(a) - mirrorIndex(b) : a.characterId < b.characterId ? -1 : 1,
        );
    for (const [key, entry] of creates) {
        if (!isCharacterKnown(entry.characterId, creating)) {
            continue;
        }
        if (entry.resend) {
            // It may have landed: resend exactly what was sent, alone and with its own sequence, so
            // its replay can be recognized; later work follows once it is resolved.
            const group = sentGroup(key, entry, null, entry.resend.ops, entry.resend.seq);
            inflight.set(key, group);
            if (entry.ops.length > 0) {
                pending.set(key, { ...entry, resend: null, create: false });
            } else {
                pending.delete(key);
            }
            groups.push(group);
            createdHere.add(key);
            continue;
        }
        const ref = { chaId: entry.characterId, chatId: entry.chatId };
        const chat = mirrorChat(ref);
        if (!chat) {
            pending.delete(key);
            settleKey(key, entry.seq);
            continue;
        }
        const character = findCharacter(entry.characterId)!;
        const index = chatsOf(character)
            .slice(0, chatsOf(character).indexOf(chat))
            .filter((other) => {
                const otherKey = keyOf(entry.characterId, other.id!);
                return chatRevisions.has(otherKey) || createdHere.has(otherKey);
            }).length;
        // Only the generation ops remain: the mirror copy already holds every other change.
        const messageIds = new Set(chat.message.map((message) => message.chatId));
        const ops: ChatOp[] = [
            { op: "create", chat: projectChat(chat), index },
            ...entry.ops.filter(
                (op) => (op.op === "begin" || (op.op === "setText" && op.generation)) && messageIds.has(op.id),
            ),
        ];
        const group = sentGroup(key, entry, null, ops);
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
            if (!mirrorChat({ chaId: entry.characterId, chatId: entry.chatId }) && !inflight.has(key)) {
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
            // More than one request can carry: the first part goes now with sequence 0 (settling
            // it settles nothing), the rest stays queued behind it with the entry's sequence.
            const group = sentGroup(key, entry, base, ops.slice(0, maxOps), 0);
            inflight.set(key, group);
            pending.set(key, { ...entry, ops: ops.slice(maxOps) });
            groups.push(group);
            continue;
        }
        const group = sentGroup(key, entry, base, ops);
        inflight.set(key, group);
        pending.delete(key);
        groups.push(group);
    }
    const orders: SentChatOrder[] = [];
    for (const [chaId, seq] of pendingOrders) {
        const base = orderRevisions.get(chaId);
        const character = findCharacter(chaId);
        if (base === undefined || !character || inflightOrders.has(chaId) || isOrderQuarantined(chaId)) {
            continue;
        }
        const visible = new Set(chatsOf(character).map((chat) => chat.id!));
        const prefix = `${chaId}\u0000`;
        const serverAfter = [...new Set([...chatRevisions.keys(), ...createdHere])].filter(
            (key) => key.startsWith(prefix) && !deletedHere.has(key),
        );
        if (serverAfter.some((key) => !visible.has(key.slice(prefix.length)))) {
            // The server will still hold a chat the mirror no longer shows (its delete is not in
            // this batch): the reorder waits until the list can be a permutation of the server's.
            continue;
        }
        const ids = chatsOf(character)
            .map((chat) => chat.id!)
            .filter((id) => {
                const key = keyOf(chaId, id);
                return (chatRevisions.has(key) || createdHere.has(key)) && !deletedHere.has(key);
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
    seq = entry.seq,
): SentChatGroup {
    const ref = { chaId: entry.characterId, chatId: entry.chatId };
    const finals: SentChatGroup["finals"] = [];
    const generationOps: SentChatGroup["generationOps"] = [];
    for (const op of ops) {
        if ((op.op === "setText" || op.op === "setMessage") && op.generation) {
            const id = op.op === "setText" ? op.id : op.message.chatId!;
            const messageKey = messageKeyOf(ref, id);
            generationOps.push({ generationId: op.generation.id, messageKey });
            if (op.generation.final) {
                finals.push({ messageKey, generationId: op.generation.id });
            }
        }
    }
    let expected: string | undefined;
    const create = ops[0]?.op === "create" ? ops[0] : null;
    if (create) {
        // The chat as it is on the server if the whole group landed (texts of its checkpoints applied).
        const chat = clone(create.chat);
        for (const op of ops) {
            if (op.op === "setText") {
                const message = chat.message.find((entry) => entry.chatId === op.id);
                if (message) {
                    message.data = op.text;
                }
            }
        }
        expected = canonicalChat(chat);
    }
    return {
        key,
        characterId: entry.characterId,
        chatId: entry.chatId,
        baseRevision,
        ops,
        seq,
        expected,
        finals,
        generationOps,
    };
}

/** A chat in the form the server stores it (the defaults it adds), for comparisons. */
function canonicalChat(chat: Chat): string {
    const copy = clone(chat) as Chat;
    delete copy.isStreaming;
    delete copy.activeStreamingDisplayOptimizationMode;
    copy.name ??= "";
    copy.note ??= "";
    copy.localLore ??= [];
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
 * on the server holds chats this client does not know (another tab created or deleted them): their
 * list is to be read again before any reorder is based on the new order revision.
 */
export function ackChatWork(
    work: ChatWork,
    results: readonly ChatGroupResult[],
    orders: readonly ChatOrderResult[],
): string[] {
    work.groups.forEach((group, index) => {
        inflight.delete(group.key);
        jobBlocked.delete(group.key);
        const result = results[index];
        if (result) {
            if (result.revision === null) {
                chatRevisions.delete(group.key);
                staleChats.delete(group.key);
                noticedChats.delete(group.key);
            } else if (!result.stale || !chatRevisions.has(group.key)) {
                // A group applied on an older revision leaves the older base: this client has not
                // seen every change up to the new revision.
                chatRevisions.set(group.key, result.revision);
            }
            if (result.stale && result.revision !== null) {
                staleChats.add(group.key);
            }
            if (result.messageIds) {
                adoptMessageIds(group, result.messageIds);
            }
            for (const op of group.ops) {
                if (op.op === "begin") {
                    const final = generationFinals.get(op.generationId);
                    if (final) {
                        final.begun = true;
                    }
                    for (const generation of generations.values()) {
                        if (generation.generationId === op.generationId) {
                            generation.begun = true;
                        }
                    }
                }
            }
            (result.checkpoints ?? []).forEach((outcome, opIndex) => {
                const op = group.generationOps[opIndex];
                if (outcome === "ignored" && op) {
                    // Another tab took the message over, or a manual edit closed the generation.
                    console.warn("[Chat] The server no longer accepts this generation's text; it stops saving");
                    rejectGeneration(op.messageKey, op.generationId);
                }
            });
        }
        for (const final of group.finals) {
            releaseGeneration(final.messageKey, final.generationId);
        }
        settleKey(group.key, group.seq);
    });
    const refresh: string[] = [];
    for (const order of orders) {
        const prefix = `${order.characterId}\u0000`;
        const known = new Set(
            [...chatRevisions.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
        );
        if (order.ids.length === known.size && order.ids.every((id) => known.has(id))) {
            orderRevisions.set(order.characterId, order.revision);
        } else {
            // The older revision stays, so a reorder conflicts (and recovers) instead of being refused.
            refresh.push(order.characterId);
        }
    }
    for (const order of work.orders) {
        inflightOrders.delete(order.characterId);
        settleOrder(order.characterId, order.seq);
    }
    return refresh;
}

/**
 * The server renamed messages of the group's last create or replace (a missing, invalid, or
 * duplicate id): rename them in the mirror (all at once, by occurrence), in queued ops, and in locks.
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
    const chat = mirrorChat(ref);
    const firstRename = new Map<string, string>();
    if (chat) {
        for (const message of chat.message) {
            const list = renames.get(message.chatId!);
            const next = list?.shift();
            if (next !== undefined && next !== message.chatId) {
                firstRename.set(message.chatId!, next);
                message.chatId = next;
            }
        }
        changed(group.key);
    }
    const rename = (id: string) => firstRename.get(id) ?? id;
    const entry = pending.get(group.key);
    for (const op of entry?.ops ?? []) {
        if (op.op === "setText" || op.op === "begin") {
            op.id = rename(op.id);
        } else if (op.op === "setMessage") {
            op.message = { ...op.message, chatId: rename(op.message.chatId!) };
        } else if (op.op === "remove") {
            op.ids = op.ids.map(rename);
        } else if (op.op === "append" && "after" in op.anchor) {
            op.anchor = { after: rename(op.anchor.after) };
        }
    }
    for (const [from, to] of firstRename) {
        const fromKey = messageKeyOf(ref, from);
        const toKey = messageKeyOf(ref, to);
        for (const final of generationFinals.values()) {
            if (final.messageKey === fromKey) {
                final.messageKey = toKey;
                final.op.id = to;
            }
        }
        for (const op of [...group.finals, ...group.generationOps]) {
            if (op.messageKey === fromKey) {
                op.messageKey = toKey;
            }
        }
        const generation = generations.get(messageKeyOf(ref, from));
        if (generation) {
            generations.delete(messageKeyOf(ref, from));
            generations.set(messageKeyOf(ref, to), generation);
            lockState.version += 1;
            if (streamingState.messageId === from && streamingState.chatId === ref.chatId) {
                streamingState.messageId = to;
            }
        }
    }
}

/**
 * Puts chat work that was not saved (a failed or rolled-back request) back in front of newer work.
 * A create in it becomes a resend of exactly what was sent (the request may have landed).
 */
export function requeueChatWork(work: ChatWork) {
    for (const group of work.groups) {
        inflight.delete(group.key);
        const newer = pending.get(group.key);
        if (group.ops[0]?.op === "create") {
            // The whole create group is kept apart and resent as it was; newer work waits behind it.
            pending.set(group.key, {
                characterId: group.characterId,
                chatId: group.chatId,
                create: false,
                resend: { ops: group.ops, seq: group.seq },
                ops: newer?.ops ?? [],
                seq: newer?.seq ?? 0,
            });
            continue;
        }
        pending.set(group.key, {
            characterId: group.characterId,
            chatId: group.chatId,
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

/** Stops sending a chat whose work the server refused as invalid (its generations stop too). */
export function quarantineChat(group: Pick<SentChatGroup, "key" | "seq">) {
    inflight.delete(group.key);
    jobBlocked.delete(group.key);
    quarantined.add(group.key);
    deferred.delete(group.key);
    staleChats.delete(group.key);
    const seq = Math.max(group.seq, workSeq(group.key));
    pending.delete(group.key);
    markDiscarded(group.key, seq);
    dropGenerations(group.key);
}

function quarantineRefusedCreate(key: string, seq: number) {
    quarantineChat({ key, seq });
    alertError(language.chatCreateRefused);
}

function markDiscarded(key: string, seq: number) {
    discardSequence += 1;
    discarded.set(key, discardSequence);
    settleKey(key, seq);
}

/** The server's copy of a chat (revision and data null: it is gone), for conflict recovery. */
export type RemoteChat = { characterId: string; id: string; revision: string | null; data: Chat | null };

/**
 * Handles the chat part of a 409 (the whole batch was rolled back). Work that did not conflict is
 * queued again. For each conflicting chat, with the server's copy read back: our own create or
 * delete that already landed (a replay) keeps the local state and the rest of its work; a chat a
 * generation locks is deferred (excluded from batches, reloaded when producers end, preserving
 * their finals even if they ended during the request); a chat
 * that is gone is dropped and its character's chat list is to be refreshed (`refresh`); any other
 * is replaced by the server copy and its local work discarded. Reorders that conflicted are dropped
 * (the caller refreshes those characters). A group refused for a generating message (`generating`:
 * `reason: "generating"`) is kept and retried after `JOB_RETRY_MS`, not reloaded. Returns whether a
 * chat was reloaded and whether one was refused for a generating message.
 */
export function recoverChatConflicts(
    work: ChatWork,
    conflicted: ReadonlySet<string>,
    conflictedOrders: ReadonlySet<string>,
    remote: readonly RemoteChat[],
    generating: ReadonlySet<string> = new Set(),
): { reloaded: boolean; refresh: Set<string>; blocked: boolean } {
    const byKey = new Map(remote.map((chat) => [keyOf(chat.characterId, chat.id), chat]));
    const retry: SentChatGroup[] = [];
    const refresh = new Set<string>();
    let reloaded = false;
    let blocked = false;
    for (const group of work.groups) {
        inflight.delete(group.key);
        if (generating.has(group.key)) {
            jobBlocked.set(group.key, Date.now() + JOB_RETRY_MS);
            retry.push(group);
            blocked = true;
            continue;
        }
        const server = byKey.get(group.key);
        if (!conflicted.has(group.key) || !server) {
            retry.push(group);
            continue;
        }
        const ref = { chaId: group.characterId, chatId: group.chatId };
        const create = group.ops[0]?.op === "create";
        if (create && server.revision !== null && server.data && group.expected === canonicalChat(server.data)) {
            // Our create (and the rest of its group) landed before the answer was lost.
            chatRevisions.set(group.key, server.revision);
            const rest = group.ops.slice(1);
            if (rest.length > 0 || pending.has(group.key)) {
                retry.push({ ...group, baseRevision: server.revision, ops: rest });
            } else {
                settleKey(group.key, group.seq);
            }
            continue;
        }
        if (group.ops.some((op) => op.op === "delete") && server.revision === null) {
            chatRevisions.delete(group.key);
            settleKey(group.key, Math.max(group.seq, workSeq(group.key)));
            pending.delete(group.key);
            continue;
        }
        if (create && server.revision === null) {
            // This create never landed. Keep the local chat; a missing parent is recovered by
            // the character read, and retrying this same group would loop.
            quarantineRefusedCreate(group.key, group.seq);
            refresh.add(group.characterId);
            continue;
        }
        if (isChatGenerating(ref)) {
            // Also preserve finals whose producer ended while the request/read was in flight.
            deferred.add(group.key);
            retry.push(group);
            continue;
        }
        if (server.revision === null) {
            // Gone on the server (another tab deleted it): the character's list is read again.
            discardChatWork(group.key, group.seq);
            chatRevisions.delete(group.key);
            refresh.add(group.characterId);
            continue;
        }
        if (!mirrorChat(ref)) {
            // Deleted here but kept on the server (the delete conflicted): the character's list is
            // read again, which puts the chat back at its server position.
            discardChatWork(group.key, group.seq);
            chatRevisions.set(group.key, server.revision);
            refresh.add(group.characterId);
            reloaded = true;
            continue;
        }
        acceptRemoteChat(server, group.seq);
        reloaded = true;
    }
    requeueRecovered(retry);
    const orders = work.orders.filter((order) => !conflictedOrders.has(order.characterId));
    requeueChatWork({ groups: [], orders });
    for (const order of work.orders) {
        if (conflictedOrders.has(order.characterId)) {
            inflightOrders.delete(order.characterId);
            settleOrder(order.characterId, order.seq);
            refresh.add(order.characterId);
        }
    }
    return { reloaded, refresh, blocked };
}

/** Requeues recovered groups; a recognized create continues as ordinary work on its revision. */
function requeueRecovered(groups: readonly SentChatGroup[]) {
    for (const group of groups) {
        if (group.baseRevision !== null && group.ops[0]?.op !== "create") {
            const newer = pending.get(group.key);
            pending.set(group.key, {
                characterId: group.characterId,
                chatId: group.chatId,
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

function discardChatWork(key: string, seq: number, keepFinals = false) {
    const highest = Math.max(seq, workSeq(key));
    pending.delete(key);
    inflight.delete(key);
    staleChats.delete(key);
    jobBlocked.delete(key);
    // Recovered finals still owe an acknowledgement, including to a flush already waiting on
    // the discarded group's sequence. Their re-enqueued work will settle that sequence later.
    markDiscarded(key, keepFinals ? 0 : highest);
    if (keepFinals) {
        return;
    }
    for (const [id, final] of generationFinals) {
        if (final.messageKey.startsWith(`${key}\u0000`)) {
            releaseGeneration(final.messageKey, id);
        }
    }
    for (const [messageKey, generation] of [...generations]) {
        if (messageKey.startsWith(`${key}\u0000`) && generation.ending) {
            releaseGeneration(messageKey, generation.generationId);
        }
    }
}

/**
 * Replaces a chat in the mirror with the server's copy and discards its local work. A chat that is
 * gone on the server is removed (a character left without chats gets a new one). Deferred recovery
 * uses `keepFinals` to retain final writes and ending locks across the replacement.
 */
export function acceptRemoteChat(server: RemoteChat, seq = 0, keepFinals = false) {
    const key = keyOf(server.characterId, server.id);
    discardChatWork(key, seq, keepFinals);
    applyRemoteChat(server);
}

/** Applies a server copy without settling or discarding any work (callers establish eligibility). */
function applyRemoteChat(server: RemoteChat) {
    const key = keyOf(server.characterId, server.id);
    staleChats.delete(key);
    const character = findCharacter(server.characterId);
    if (character) {
        const chats = chatsOf(character);
        const index = chats.findIndex((chat) => chat.id === server.id);
        if (server.revision === null || !server.data) {
            if (index !== -1) {
                chats.splice(index, 1);
            }
        } else if (index === -1) {
            chats.push(server.data);
        } else {
            chats[index] = server.data;
        }
        changed(key);
        ensureChat(server.characterId);
        syncChatPage(server.characterId);
    }
    if (server.revision === null) {
        chatRevisions.delete(key);
    } else {
        chatRevisions.set(key, server.revision);
    }
    remoteListener?.({ chaId: server.characterId, chatId: server.id });
}

function canRefreshChat(ref: ChatRef): boolean {
    const key = keyOf(ref.chaId, ref.chatId);
    return (
        !pending.has(key) &&
        !inflight.has(key) &&
        !isChatGenerating(ref) &&
        !deferred.has(key) &&
        !quarantined.has(key) &&
        !isJobBlocked(key)
    );
}

/** Stale and noticed chats eligible for a read inside the save cycle, never alongside a batch. */
export function idleChatRefreshes(): ChatRef[] {
    return [...new Set([...staleChats, ...noticedChats.keys()])]
        .map((key) => {
            const [chaId, chatId] = key.split("\u0000");
            return { chaId, chatId };
        })
        .filter(canRefreshChat);
}

/** The sequence of a chat's latest notice (0 without one), taken before its read for `finishIdleChatRefresh`. */
export function chatNoticeSeq(ref: ChatRef): number {
    return noticedChats.get(keyOf(ref.chaId, ref.chatId)) ?? 0;
}

/**
 * Rechecks eligibility after the read's await; busy chats retain their refresh mark for later. A
 * notice that arrived during the read (a later sequence than `notice`) keeps its mark: the read
 * may predate the change it announced.
 */
export function finishIdleChatRefresh(server: RemoteChat, notice = 0): boolean {
    const key = keyOf(server.characterId, server.id);
    if (
        (!staleChats.has(key) && !noticedChats.has(key)) ||
        !canRefreshChat({ chaId: server.characterId, chatId: server.id })
    ) {
        return false;
    }
    const held = chatRevisions.get(key);
    if (server.revision !== null && held !== undefined && (compareRevision(server.revision, held) ?? 0) < 0) {
        // A read older than a hydration that arrived meanwhile.
        return false;
    }
    if ((noticedChats.get(key) ?? 0) <= notice || server.revision === null) {
        noticedChats.delete(key);
    }
    applyRemoteChat(server);
    return true;
}

/**
 * Another tab of this browser announced that a server job changed this chat: the chat is read
 * again once it is idle here (no local work, generation, retry block, deferral, or quarantine).
 * Ignored for a chat the mirror does not hold. Nothing is written and no job is owned.
 */
export function markChatNoticed(ref: ChatRef): boolean {
    const key = keyOf(ref.chaId, ref.chatId);
    if (!mirrorChat(ref) || !chatRevisions.has(key)) {
        return false;
    }
    noticeSeq += 1;
    noticedChats.set(key, noticeSeq);
    notifyWork();
    return true;
}

/**
 * Replaces a character's chat list with the server's (an order conflict, a chat another tab deleted,
 * or a character the mirror learns about): the server order and chats. A chat with unsent or
 * in-flight work or a running generation keeps its local copy; a local create the server already
 * holds counts as landed; a never-sent local chat stays (after the server's); a local chat the
 * server no longer has is dropped with its work, unless a generation runs in it (its reload waits).
 */
export function acceptRemoteCollection(collection: {
    characterId: string;
    order: ChatOrderRecord | null;
    chats: readonly ChatRecord[];
}) {
    const chaId = collection.characterId;
    const character = findCharacter(chaId);
    const orderSeq = pendingOrders.get(chaId);
    if (orderSeq !== undefined) {
        settleOrder(chaId, orderSeq);
    }
    pendingOrders.delete(chaId);
    if (!collection.order || !character) {
        return;
    }
    orderRevisions.set(chaId, collection.order.revision);
    const byId = new Map(collection.chats.map((chat) => [chat.id, chat]));
    const local = new Map(chatsOf(character).map((chat) => [chat.id!, chat]));
    const next: Chat[] = [];
    const placed = new Set<string>();
    for (const id of collection.order.ids) {
        const record = byId.get(id);
        if (!record || placed.has(id)) {
            continue;
        }
        placed.add(id);
        const key = keyOf(chaId, id);
        const mine = local.get(id);
        const entry = pending.get(key);
        const busy = !canRefreshChat({ chaId, chatId: id });
        if (entry?.resend || entry?.create) {
            // Our create landed (its answer was lost): the rest of its group and later work
            // continue on this revision.
            entry.ops = [...(entry.resend?.ops.slice(1) ?? []), ...entry.ops];
            entry.seq = Math.max(entry.seq, entry.resend?.seq ?? 0);
            entry.resend = null;
            entry.create = false;
            chatRevisions.set(key, record.revision);
        }
        if (entry?.ops.some((op) => op.op === "delete")) {
            // Deleted here, not yet on the server: stays out of the mirror. The delete keeps its
            // own base revision (this tab has not seen the server's copy), so it conflicts if the
            // chat changed.
            continue;
        }
        if (mine && busy) {
            next.push(mine);
            if (!chatRevisions.has(key)) {
                chatRevisions.set(key, record.revision);
            }
        } else {
            next.push(record.data);
            chatRevisions.set(key, record.revision);
            staleChats.delete(key);
            changed(key);
        }
    }
    for (const [id, chat] of local) {
        if (placed.has(id)) {
            continue;
        }
        const key = keyOf(chaId, id);
        const entry = pending.get(key);
        if (quarantined.has(key) || entry?.create || entry?.resend || inflight.get(key)?.ops[0]?.op === "create") {
            // Not on the server yet (never sent, or a create whose attempt was rolled back or is
            // unresolved): it stays and its create goes out.
            next.push(chat);
        } else if (isChatGenerating({ chaId, chatId: id })) {
            next.push(chat);
            deferred.add(key);
        } else {
            discardChatWork(key, 0);
            chatRevisions.delete(key);
            changed(key);
        }
    }
    chatsOf(character).splice(0, chatsOf(character).length, ...next);
    mutationToken += 1;
    if (next.some((chat) => !chatRevisions.has(keyOf(chaId, chat.id!)) && !quarantined.has(keyOf(chaId, chat.id!)))) {
        // Local chats still to be created were placed after the server's; a reorder sent after
        // their creates makes the server's order match the mirror.
        pendingOrders.set(chaId, nextSeq());
    }
    ensureChat(chaId);
    syncChatPage(chaId);
    remoteListener?.({ chaId, chatId: "" });
}

/** Deferred chats whose generation has ended: their reload can run. */
export function deferredReloads(): ChatRef[] {
    return [...deferred]
        .map((key) => {
            const [chaId, chatId] = key.split("\u0000");
            return { chaId, chatId };
        })
        .filter((ref) => !hasLiveGeneration(ref) && !inflight.has(keyOf(ref.chaId, ref.chatId)));
}

/** Applies a deferred chat's reload (after a successful read) and ends its deferral. */
export function finishDeferredReload(server: RemoteChat): string | null {
    const key = keyOf(server.characterId, server.id);
    const ref = { chaId: server.characterId, chatId: server.id };
    // A continue may have taken the lock while the read was in flight.
    if (!deferred.has(key) || hasLiveGeneration(ref) || inflight.has(key)) {
        return null;
    }
    deferred.delete(key);
    if (server.revision === null) {
        const entry = pending.get(key);
        if (entry?.create || entry?.resend) {
            quarantineRefusedCreate(key, workSeq(key));
        } else {
            discardChatWork(key, 0);
        }
        chatRevisions.delete(key);
        return server.characterId;
    }
    const seq = workSeq(key);
    acceptRemoteChat(server, 0, true);
    let requeued = false;
    for (const [id, final] of generationFinals) {
        if (!final.messageKey.startsWith(`${key}\u0000`)) {
            continue;
        }
        const message = mirrorChat(ref)?.message.find((entry) => entry.chatId === final.op.id);
        if (!message) {
            releaseGeneration(final.messageKey, id);
            continue;
        }
        message.data = final.op.text;
        changed(key);
        if (!final.begun) {
            enqueue(ref, { op: "begin", id: final.op.id, generationId: id });
        }
        enqueue(ref, clone(final.op));
        requeued = true;
    }
    if (!requeued) {
        settleKey(key, seq);
    }
    return null;
}

/** What `flushResources` waits for: every chat and order with work queued or in flight now. */
export function captureChatObligations(): { chats: Map<string, number>; orders: Map<string, number> } {
    const chats = new Map<string, number>();
    for (const key of new Set([...pending.keys(), ...inflight.keys()])) {
        chats.set(key, workSeq(key));
    }
    const orders = new Map(pendingOrders);
    for (const [chaId, order] of inflightOrders) {
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
        if ((ordersSettled.get(chaId) ?? 0) < seq) {
            open.push(chaId);
        }
    }
    return open;
}

/**
 * Whether an obligation waits on a deferred chat whose producer is still generating, or on a chat
 * the server refused for a generating message (until its retry).
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
    return hasLiveGeneration({ chaId, chatId });
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
        return;
    }
    // Polled, not an effect: a deep snapshot on every change makes a long stream quadratic. A
    // change outside the module in the same interval as a module write goes unnoticed (a dev aid).
    let lastCharacter: string | undefined;
    let lastText: string | undefined;
    let lastToken = -1;
    setInterval(() => {
        const character = DBState.db.characters?.[get(selectedCharID)];
        const text = JSON.stringify($state.snapshot(character?.chats));
        const id = character?.chaId;
        if (id === lastCharacter && lastText !== undefined && text !== lastText && mutationToken === lastToken) {
            console.error(
                "[Chat] The chats of the selected character changed outside the chat module; the change is not saved",
            );
        }
        lastCharacter = id;
        lastText = text;
        lastToken = mutationToken;
    }, DRIFT_CHECK_INTERVAL_MS);
}

/** Tells the drift check that a mirror change outside the module is expected (hydration, restore). */
export function noteMirrorReplaced() {
    mutationToken += 1;
}
