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
import type { StreamingMessage } from "../../../shared/jobs.ts";
import { readChatBindingIds } from "../../../shared/chatBinding.ts";
import { compareRevision, parseRevisionToken } from "../../../shared/resources.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import {
    CHAT_TRANSLATION_FIELD_TYPES,
    chatTranslationSummary,
    type ChatTranslationFields,
} from "../../../shared/translation/chatSettings.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import { dropInvalidTranslation, isMessageTranslation } from "../../../shared/translation/messageTranslation.ts";
import { language } from "src/lang";
import { alertError } from "../alert";
import type { character, Chat, groupChat, Message, MessageTranslation } from "./database.svelte";
import { characterData, setCharacterChatView } from "./records.svelte";
import { readRefs } from "./resourceClient";

/**
 * The chat mutation module (Phase 2 of `docs/plan/PLAN.md`). Chats are server resources of their own
 * (metadata plus one row per message, addressed by `Message.chatId`; each character's chat order is a
 * record of its own). This module holds them (Phase 6 slice 9): per character, its chat ids in order
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
 * - A server generation job (Phase 5) locks the message it writes: nothing but the job may rewrite or
 *   remove it. `applyServerGeneration` writes the streamed text into the mirror without queuing
 *   anything, and the job's end releases its locks. A chat `resource` event replaces the chat through
 *   `hydrateChat` (never an outgoing write). Work the server refused for a generating message
 *   (`reason: "generating"`) is kept and retried after `JOB_RETRY_MS`. A conflict on a chat a job
 *   streams into is deferred: it reloads once the job ends. The streamed message is `streamingState`
 *   (the chat screen's display optimization) from its first stream update until its lock is released.
 */

export type ChatRef = { chaId: string; chatId: string };

type AnyCharacter = character | groupChat;

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
};

export type SentChatOrder = { characterId: string; baseRevision: string; ids: string[]; seq: number };

export type ChatWork = { groups: SentChatGroup[]; orders: SentChatOrder[] };

const chatRevisions = new Map<string, string>();
/**
 * Per chat (`keyOf`): bumped when this client first holds a revision for a chat it did not hold one
 * for (its first save landed or a landed create was recognized; not the boot seed or a restore), so
 * the rows rendered before it without a server transform context render again (Phase 5 cutover).
 */
const savedVersions = $state<Record<string, number>>({});

/** Records a chat's held revision (every runtime install but the seed): see `savedVersions`. */
function holdChatRevision(key: string, revision: string) {
    const first = !chatRevisions.has(key);
    chatRevisions.set(key, revision);
    if (first) {
        savedVersions[key] = (savedVersions[key] ?? 0) + 1;
    }
}

/** How many times the chat gained its first held revision (reactive; `savedVersions`). */
export function chatSaveVersion(ref: ChatRef): number {
    return savedVersions[keyOf(ref.chaId, ref.chatId)] ?? 0;
}

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
/** Chats whose conflict reload waits for the server job streaming into them. */
const deferred = new Set<string>();
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
/** Bumped whenever `serverGenerations` gains or loses a lock, so the chat screen's lock reads re-run. */
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
/** The server generation `streamingState` shows; its lock's release clears the state. */
let streamingGeneration: string | null = null;
/** Chat keys → local version, bumped by every change of the chat in the mirror. */
const versions = new Map<string, number>();
let localSeq = 0;
let workListener: (() => void) | null = null;
let remoteListener: ((ref: ChatRef) => void) | null = null;

/** Bumped by every mirror write this module makes (the development drift check compares it). */
let mutationToken = 0;

/**
 * The message a server job of this tab streams into, for the chat screen's display optimization
 * (client-only; replaces the persisted flags): set on the generation's first stream update with the
 * configured mode, cleared when its lock is released.
 */
export const streamingState = $state({
    chaId: null as string | null,
    chatId: null as string | null,
    messageId: null as string | null,
    mode: undefined as Chat["activeStreamingDisplayOptimizationMode"],
});

/** What a chat list shows of a chat (`ChatListEntry` without the id): its summary while it is not loaded. */
type ChatEntryMeta = {
    name: string;
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
const loading = new Map<string, { lifetime: string; promise: Promise<DeepReadonly<Chat> | undefined> }>();
/** How many times a load reads a chat again when the server answers older than the held revision. */
const MAX_LOAD_READS = 3;
/** Chats per read request of a load (well inside the server's per-request cap). */
const LOAD_CHUNK = 500;

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

/** Whether a member chat is loaded (its whole chat is held, not only its summary). */
function isLoaded(ref: ChatRef): boolean {
    return heldChat(ref) !== undefined;
}

/** Whether every member chat of a character is loaded (true when it holds none). */
export function chatsLoaded(chaId: string): boolean {
    const holding = holdingAt(chaId);
    return !holding || holding.ids.every((id) => holding.chats[slot(id)] !== undefined);
}

/** The list fields of a chat or of a summary (the server's summary rule: `name` "", `fmIndex` -1). */
function metaOf(source: {
    name?: unknown;
    folderId?: unknown;
    bindedPersona?: unknown;
    promptPresetId?: unknown;
    modelPresetId?: unknown;
    bindingReview?: unknown;
    fmIndex?: unknown;
}): ChatEntryMeta {
    const meta: ChatEntryMeta = {
        name: typeof source.name === "string" ? source.name : "",
        fmIndex: typeof source.fmIndex === "number" ? source.fmIndex : -1,
    };
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
    loadedKeys.add(keyOf(chaId, chat.id!));
    holding.chats[slot(chat.id!)] = chat;
    delete holding.summaries[slot(chat.id!)];
    holding.ids.splice(index, 0, chat.id!);
    return holding.chats[slot(chat.id!)];
}

/** Puts a chat into a character's list at `index` as its summary (not loaded). */
function insertSummary(chaId: string, index: number, id: string, meta: ChatEntryMeta) {
    const holding = holdingOf(chaId);
    loadedKeys.delete(keyOf(chaId, id));
    holding.summaries[slot(id)] = meta;
    delete holding.chats[slot(id)];
    holding.ids.splice(index, 0, id);
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
    delete holding.chats[slot(chatId)];
    delete holding.summaries[slot(chatId)];
}

/** Drops everything held for a character (its list, loaded chats, and summaries). */
function dropHeld(chaId: string) {
    for (const id of holdingAt(chaId)?.ids ?? []) {
        loadedKeys.delete(keyOf(chaId, id));
    }
    delete held[slot(chaId)];
}

/** Replaces a character's whole list (membership, order, loaded chats, and summaries) with `entries`. */
function setChatList(chaId: string, entries: readonly ChatEntry[]) {
    const holding = holdingOf(chaId);
    for (const id of holding.ids) {
        loadedKeys.delete(keyOf(chaId, id));
    }
    const chats: Record<string, Chat> = {};
    const summaries: Record<string, ChatEntryMeta> = {};
    for (const entry of entries) {
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
}

/** Loaded chats as list entries. */
function loadedEntries(chats: readonly Chat[]): ChatEntry[] {
    return chats.map((chat) => ({ id: chat.id!, chat }));
}

/** The loaded chat; read-only (change it through this module). Tracked when read reactively. */
export function findChat(ref: ChatRef): DeepReadonly<Chat> | undefined {
    return heldChat(ref);
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
 */
export function withChatsCopy<T extends { chaId: string }>(
    copy: T,
    chatId?: string,
): T & { chats: Chat[]; chatPage: number } {
    if (!chatsLoaded(copy.chaId)) {
        throw new Error(`The chats of ${copy.chaId} are not loaded`);
    }
    const chats = clone<Chat[]>($state.snapshot(chatsOf(copy.chaId)) as Chat[]);
    const listed = chatId === undefined ? -1 : chats.findIndex((chat) => chat.id === chatId);
    return { ...copy, chats, chatPage: listed !== -1 ? listed : selectedChatIndex(copy.chaId) };
}

/**
 * A character in the legacy shape the shared CBS evaluator reads (until `aggregate-removal`): a live
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

/** One entry of a character's chat list (`chatList`): what a chat list shows, never a whole chat. */
export type ChatListEntry = { id: string } & ChatEntryMeta;

/**
 * A character's chats as list entries, in order (reactive over the listed fields and the
 * membership only, so a streamed message does not recompute it): from the loaded chat, or from the
 * summary of a chat that is not loaded. A summary is never a `Chat`.
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
    return { id, ...(chat ? metaOf(chat) : (holding.summaries[slot(id)] ?? metaOf({}))) };
}

/** A chat as sent: a plain copy without the client-only streaming flags. */
function projectChat(chat: Chat): Chat {
    const copy = snapshot(chat);
    delete copy.isStreaming;
    delete copy.activeStreamingDisplayOptimizationMode;
    copy.message ??= [];
    return copy;
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
    if (last.op === "setText" && next.op === "setText" && last.id === next.id) {
        last.text = next.text;
        return true;
    }
    if (last.op === "setMessage" && next.op === "setText" && last.message.chatId === next.id) {
        last.message = { ...last.message, data: next.text };
        return true;
    }
    if (last.op === "setMessage" && next.op === "setMessage" && last.message.chatId === next.message.chatId) {
        last.message = next.message;
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
    return serverGenerations.has(messageKeyOf(ref, messageId));
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
    return [...serverGenerations.keys()].some((key) => key.startsWith(prefix));
}

/** Whether any chat of a character has a running generation. */
export function isCharacterGenerating(chaId: string): boolean {
    const prefix = `${chaId}\u0000`;
    return [...serverGenerations.keys()].some((key) => key.startsWith(prefix));
}

/** Throws when a server job locks any of these messages. */
function assertUnlocked(ref: ChatRef, messageIds: readonly (string | undefined)[]) {
    for (const id of messageIds) {
        if (id !== undefined && serverGenerations.has(messageKeyOf(ref, id))) {
            throw new Error("This message is being generated; wait until it finishes");
        }
    }
}

/**
 * Streamed messages whose newest text waits for the next frame: the mirror takes at most one
 * stream update per frame, so the chat screen parses a streaming message once per frame, not once
 * per chunk. The text itself is the message's stream buffer (`serverGenerations`).
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
    const message = heldChat(target)?.message.find((candidate) => candidate.chatId === target.messageId);
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

/** Clears `streamingState` when it shows `generationId` (its lock was released). */
function releaseStreaming(generationId: string) {
    if (streamingGeneration === generationId) {
        setStreamingState(null);
    }
}

/**
 * Mirrors a server generation job's reply (an `accepted` or `chunk` event): locks the message for
 * the job and writes `text` into the mirror. Nothing is queued and the chat's revision does not
 * move: only a whole-chat hydration (`hydrateChat`) advances it. A chunk older than the last one
 * of its generation (`seq`) is dropped. The generation's first stream update makes its message the
 * streaming one (`streamingState`, with the configured display optimization mode). The mirror takes
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
    const message = heldChat(ref)?.message.find((entry) => entry.chatId === update.messageId);
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
    if (firstUpdate) {
        setStreamingState({
            ...ref,
            messageId: update.messageId,
            mode: settings.ui.streamingDisplayOptimizationMode ?? "off",
        });
        streamingGeneration = update.generationId;
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
 * Applies a chat `resource` event of a server job: the server's whole chat replaces the mirror's
 * when its revision is at least the held one and the chat has no local work (pending, in flight,
 * deferred, quarantined, refused for a generating message); otherwise the chat is marked for an
 * idle refresh. A chat the mirror lacks, or one this client has not seen on
 * the server, is not hydrated; a member that is not loaded takes the copy's revision and summary only
 * (a server copy never loads a chat). Nothing is queued, discarded, or settled, and no notice is shown.
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

/** The body of a job's `chatPatch` (`GenerationChatPatchEvent` without its event fields). */
export type ChatPatch = {
    characterId: string;
    id: string;
    baseRevision: string;
    revision: string;
    meta?: Record<string, unknown>;
    removed?: readonly string[];
    messages?: readonly { after: string | null; message: unknown }[];
    count: number;
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
            const message = heldChat({ chaId: server.characterId, chatId: server.id })?.message.find(
                (candidate) => candidate.chatId === entry.messageId,
            );
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
            const message = heldChat({ chaId: server.characterId, chatId: server.id })?.message.find(
                (candidate) => candidate.chatId === messageKey.slice(prefix.length),
            );
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
    if (pending.has(key) || inflight.has(key) || deferred.has(key) || quarantined.has(key) || jobBlocked.has(key)) {
        staleChats.add(key);
        return "busy";
    }
    if (isLoaded(ref)) {
        holdingOf(server.characterId).chats[slot(server.id)] = clone<Chat>(server.data);
    } else {
        holdingOf(server.characterId).summaries[slot(server.id)] = metaOf(server.data);
    }
    holdChatRevision(key, server.revision);
    staleChats.delete(key);
    changed(key);
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
    if (pending.has(key) || inflight.has(key) || deferred.has(key) || quarantined.has(key) || jobBlocked.has(key)) {
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
    // Only the positions that changed are written (an append writes one; a removal or insertion
    // writes the positions after it), never the whole list as call arguments.
    const { start, tail } = patched;
    for (let index = 0; index < tail.length; index++) {
        if (chat.message[start + index] !== tail[index]) {
            chat.message[start + index] = tail[index];
        }
    }
    if (chat.message.length !== start + tail.length) {
        chat.message.length = start + tail.length;
    }
    if (patch.meta) {
        // The chat's fields become the stored ones, as a whole copy replaces them.
        const fields = chat as unknown as Record<string, unknown>;
        for (const field of Object.keys(fields)) {
            if (field !== "message" && !Object.hasOwn(patch.meta, field)) {
                delete fields[field];
            }
        }
        for (const [field, value] of Object.entries(patch.meta)) {
            if (field !== "message") {
                fields[field] = clone(value);
            }
        }
    }
    holdChatRevision(key, patch.revision);
    staleChats.delete(key);
    changed(key);
    remoteListener?.(ref);
    return "applied";
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
        const entry = pending.get(group.key);
        if (entry) {
            entry.ops = entry.ops.slice(group.ops.length);
            if (entry.ops.length === 0) {
                pending.delete(group.key);
            }
        }
        inflight.set(group.key, group);
    }
}

/**
 * Records the answer to an unload request the page survived to receive (`results` in group order;
 * null: the request failed or was refused, and its ops go back in front of the queue). An answer is
 * an ordinary acknowledgement.
 */
export function settleUnloadWork(work: ChatWork, results: readonly ChatGroupResult[] | null) {
    work.groups.forEach((group, index) => {
        const taken = { groups: [group], orders: [] };
        if (results?.[index]) {
            ackChatWork(taken, [results[index]], []);
        } else {
            requeueChatWork(taken);
        }
    });
    notifyWork();
}

/**
 * Pending by-id work for existing chats, one request per chat within the remaining shared budget.
 * Take only an eligible prefix: jumping past a replace or delete could change its meaning.
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
        const ops: ChatOp[] = [];
        for (const op of entry.ops) {
            if (
                op.op !== "append" &&
                op.op !== "setText" &&
                op.op !== "setMessage" &&
                op.op !== "setTranslation" &&
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

/** Sets or clears the message the chat screen shows as streaming. */
export function setStreamingState(
    target: (ChatRef & { messageId: string; mode: Chat["activeStreamingDisplayOptimizationMode"] }) | null,
) {
    streamingState.chaId = target?.chaId ?? null;
    streamingState.chatId = target?.chatId ?? null;
    streamingState.messageId = target?.messageId ?? null;
    streamingState.mode = target?.mode;
    // A server generation that owns the state records itself after this call.
    streamingGeneration = null;
}

// ---------------------------------------------------------------------------------------------
// Chat membership and selection

/**
 * A chat's defaults that come from its character (Phase 6 slice 5b): `fmIndex`, the greeting the chat
 * starts from, is the character's `firstMsgIndex` (-1: the first message) when absent, and `localLore`
 * is `[]` when absent. An explicit `fmIndex` (also 0 or -1) is kept. Changes `chat` in place.
 */
export function prepareChatInput(chat: Chat, character: { firstMsgIndex?: unknown }) {
    if (chat.fmIndex === undefined || chat.fmIndex === null) {
        chat.fmIndex = typeof character.firstMsgIndex === "number" ? character.firstMsgIndex : -1;
    }
    chat.localLore ??= [];
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
    const index = Math.max(0, Math.min(options.index ?? ids.length, ids.length));
    const created = insertChat(chaId, index, chat);
    const key = keyOf(chaId, chat.id);
    changed(key);
    const entry = pendingFor({ chaId, chatId: chat.id });
    entry.create = true;
    entry.seq = nextSeq();
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
    prepareMessages(messages, new Set(chat.message.map((message) => message.chatId!)));
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

/** Replaces one message by its id (`message.chatId`). */
export function replaceMessage(ref: ChatRef, input: DeepReadonly<Message>) {
    const chat = requireChat(ref);
    const message = clone<Message>(input);
    const index = indexOfMessage(chat, message.chatId!);
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
    chat.message[index] = message;
    changed(keyOf(ref.chaId, ref.chatId));
    enqueue(ref, { op: "setMessage", message: clone(message) });
}

/** Sets a message's text. */
export function setMessageText(ref: ChatRef, id: string, text: string) {
    const chat = requireChat(ref);
    const index = indexOfMessage(chat, id);
    if (index === -1) {
        throw new Error(`No message ${id}`);
    }
    assertUnlocked(ref, [id]);
    if (chat.message[index].data !== text) {
        chat.message[index].data = text;
        changed(keyOf(ref.chaId, ref.chatId));
    }
    enqueue(ref, { op: "setText", id, text });
}

/**
 * Sets (or with `null` clears) a message's stored translation (`docs/plan/translation.md`). A
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
    const index = indexOfMessage(chat, id);
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
    if (value === null) {
        delete message.translation;
    } else {
        message.translation = clone(value);
    }
    changed(keyOf(ref.chaId, ref.chatId));
    // Never coalesced: a set lands only on a matching text, so dropping an earlier op could change the result.
    enqueue(ref, { op: "setTranslation", id, translation: value });
    return true;
}

/** Removes messages by id. Removing several needs the chat's current revision on the server. */
export function removeMessages(ref: ChatRef, ids: readonly string[]) {
    const chat = requireChat(ref);
    const present = ids.filter((id) => indexOfMessage(chat, id) !== -1);
    if (present.length === 0) {
        return;
    }
    assertUnlocked(ref, present);
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
 * The chat fields the server's chat normalizer (`normalizeChatMeta`) defaults: removing one, or setting
 * it to `null`, stores the default, so the client writes the default itself and holds what the server
 * holds (Phase 6 slice 5b).
 */
const SERVER_META_DEFAULTS: Readonly<Record<string, () => unknown>> = {
    name: () => "",
    note: () => "",
    localLore: () => [],
    fmIndex: () => -1,
};

/**
 * The chat fields a chat list writes (`ChatListEntry`'s): `setChatMeta` changes them also in a chat
 * that is not loaded (its summary), with the type the summary holds.
 */
const SUMMARY_FIELD_TYPES: Readonly<Record<string, "string" | "number" | "boolean">> = {
    name: "string",
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
 * before anything changes.
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
        const value = entry === null && Object.hasOwn(SERVER_META_DEFAULTS, key) ? SERVER_META_DEFAULTS[key]() : entry;
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
        // A field the server defaults is never removed: the loop above set it to its default.
        return Object.hasOwn(chat, key) && !Object.hasOwn(changes, key) && !Object.hasOwn(SERVER_META_DEFAULTS, key);
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
    holdingOf(ref.chaId).chats[slot(ref.chatId)] = chat;
    changed(keyOf(ref.chaId, ref.chatId));
    enqueue(ref, { op: "replace", chat: projectChat(chat) });
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
 * inserted after their predecessor, changed message fields are merged into the current message,
 * changed chat fields are set or removed. Changes made meanwhile by others are kept. When the hook
 * reordered surviving messages, the whole chat is replaced, but only if the chat has not changed
 * since the baseline and no generation runs in it (otherwise the order change is dropped with a
 * warning). Everything is checked against the locks before the mirror changes.
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
        if (!baseMessages.has(message.chatId!) && indexOfMessage(current, message.chatId!) !== -1) {
            message.chatId = uuidv4();
        }
    }
    const resultIds = new Set(next.message.map((message) => message.chatId!));
    const removed = baseline.chat.message
        .map((message) => message.chatId!)
        .filter((id) => !resultIds.has(id) && indexOfMessage(current, id) !== -1);
    const changedMessages = next.message.filter((message) => {
        const before = baseMessages.get(message.chatId!);
        return before !== undefined && JSON.stringify(before) !== JSON.stringify(message);
    });
    const survivorsBefore = baseline.chat.message.map((message) => message.chatId!).filter((id) => resultIds.has(id));
    const survivorsAfter = next.message.map((message) => message.chatId!).filter((id) => baseMessages.has(id));
    const reordered = survivorsBefore.some((id, index) => survivorsAfter[index] !== id);
    assertUnlocked(ref, [...removed, ...changedMessages.map((message) => message.chatId!)]);

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
        replaceMessage(ref, merged as unknown as Message);
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
                console.warn("[Chat] Skipped a plugin change to a chat being generated", error);
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

/** Records what the server holds (boot read: chats or their summaries), before anything queues work. */
export function seedChats(
    chats: readonly { characterId: string; id: string; revision: string }[],
    orders: readonly ChatOrderRecord[],
) {
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

/** Unsaved user work, including requests in flight. */
export function hasUnsavedChatWork(canSaveCharacter: (id: string) => boolean = () => true): boolean {
    for (const key of new Set([...pending.keys(), ...inflight.keys()])) {
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
    const ids = memberIds(chaId).filter((id) => chatRevisions.has(keyOf(chaId, id)));
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
 * A new character leaves its creates to the save loop's `adoptCharacter`. A reused character id
 * reconciles the chats the server holds or may receive from earlier work: its character record
 * stays an update, so the save loop will not adopt its replacement chats. Unsent work is superseded,
 * but an unacknowledged create keeps its payload for replay before the replacement or deletion.
 * The caller has finished every check that can refuse the character first, and drops the held chats
 * (`forgetCharacterChats`) if insertion throws; the save loop then forgets the absent owner's work.
 *
 * A replacement based on a revision another tab changed follows the usual conflict reload, which
 * discards that chat's replacement with a notice. A chat another tab created that this client never
 * saw survives on the server; reconciliation can delete only chats this client knows about.
 */
export function installCharacterChats(chaId: string, chats: Chat[], character: { firstMsgIndex?: unknown }) {
    const prefix = `${chaId}\u0000`;
    const known = new Set(
        [
            ...chatRevisions.keys(),
            ...inflight.keys(),
            ...[...pending].filter(([, entry]) => entry.create || entry.resend).map(([key]) => key),
        ].filter((key) => key.startsWith(prefix)),
    );
    const reconcile =
        known.size > 0 || orderRevisions.has(chaId) || pendingOrders.has(chaId) || inflightOrders.has(chaId);
    renewLifetime(chaId);
    dropLoadState(chaId);
    setChatList(chaId, loadedEntries(prepareCharacterChats(chats, character)));
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
            const entry = pendingFor({ chaId, chatId: chat.id! });
            const sending = inflight.get(key);
            // A delete in flight will remove the base, so the reused id needs a create after it settles.
            entry.create = sending?.ops[0]?.op === "delete" || (!chatRevisions.has(key) && !sending && !entry.resend);
            entry.ops = entry.create ? [] : [{ op: "replace", chat: projectChat(chat) }];
            entry.seq = nextSeq();
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
 * Drops the chats held for a character that left the list (a local removal or replacement), or did
 * not enter it after all (its insertion threw): its chats, selection, and pins. The save loop's
 * `forgetCharacter` settles its chat work when the character's deletion is saved.
 */
export function forgetCharacterChats(chaId: string) {
    dropHeld(chaId);
    delete chosen[slot(chaId)];
    dropLoadState(chaId);
    renewLifetime(chaId);
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
 * ids and defaults, without queuing anything (the save loop's `adoptCharacter` queues the creates).
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
        prepareChatInput(chat, character);
        chat.message ??= [];
        prepareMessages(chat.message, new Set());
    }
    mutationToken += 1;
    syncSelection(chaId);
}

/** Queues creates for a new character's chats (the save loop found it in the list, unsaved). */
export function adoptCharacter(chaId: string) {
    if (!findCharacter(chaId)) {
        return;
    }
    normalizeNewCharacter(chaId);
    for (const chatId of memberIds(chaId)) {
        const key = keyOf(chaId, chatId);
        const entry = pending.get(key);
        if (!chatRevisions.has(key) && !entry?.create && !entry?.resend && !inflight.has(key)) {
            const created = pendingFor({ chaId, chatId });
            created.create = true;
            created.seq = nextSeq();
        }
    }
}

/** Drops all chat state of a character that is deleted (the server deletes its chats with it). */
export function forgetCharacter(chaId: string) {
    const prefix = `${chaId}\u0000`;
    for (const key of [...staleChats, ...deferred, ...noticedChats.keys()]) {
        if (key.startsWith(prefix)) {
            staleChats.delete(key);
            noticedChats.delete(key);
            deferred.delete(key);
        }
    }
    for (const key of [...pending.keys()]) {
        if (key.startsWith(prefix)) {
            settleKey(key, workSeq(key));
            pending.delete(key);
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
    dropHeld(chaId);
    delete chosen[slot(chaId)];
    dropLoadState(chaId);
    renewLifetime(chaId);
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
            a.characterId === b.characterId ? memberIndex(a) - memberIndex(b) : a.characterId < b.characterId ? -1 : 1,
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
        const chat = isMember(ref) ? heldChat(ref) : undefined;
        if (!chat) {
            pending.delete(key);
            settleKey(key, entry.seq);
            continue;
        }
        const ids = memberIds(entry.characterId);
        const index = ids.slice(0, ids.indexOf(entry.chatId)).filter((otherId) => {
            const otherKey = keyOf(entry.characterId, otherId);
            return chatRevisions.has(otherKey) || createdHere.has(otherKey);
        }).length;
        // The mirror copy already holds every queued change.
        const group = sentGroup(key, entry, null, [{ op: "create", chat: projectChat(chat), index }]);
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
        if (base === undefined || !findCharacter(chaId) || inflightOrders.has(chaId) || isOrderQuarantined(chaId)) {
            continue;
        }
        const visible = new Set(memberIds(chaId));
        const prefix = `${chaId}\u0000`;
        const serverAfter = [...new Set([...chatRevisions.keys(), ...createdHere])].filter(
            (key) => key.startsWith(prefix) && !deletedHere.has(key),
        );
        if (serverAfter.some((key) => !visible.has(key.slice(prefix.length)))) {
            // The server will still hold a chat the mirror no longer shows (its delete is not in
            // this batch): the reorder waits until the list can be a permutation of the server's.
            continue;
        }
        const ids = memberIds(chaId).filter((id) => {
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
    const create = ops[0]?.op === "create" ? ops[0] : null;
    return {
        key,
        characterId: entry.characterId,
        chatId: entry.chatId,
        baseRevision,
        ops,
        seq,
        // The chat as it is on the server if the create landed.
        ...(create ? { expected: canonicalChat(create.chat) } : {}),
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
            } else if (
                (!result.stale || !chatRevisions.has(group.key)) &&
                (compareRevision(result.revision, chatRevisions.get(group.key) ?? result.revision) ?? 1) >= 0
            ) {
                // A group applied on an older revision leaves the older base: this client has not
                // seen every change up to the new revision. A newer revision held already (a load
                // installed a later read while the group was in flight) is not moved back.
                holdChatRevision(group.key, result.revision);
            }
            if (result.stale && result.revision !== null) {
                staleChats.add(group.key);
            }
            if (result.messageIds) {
                adoptMessageIds(group, result.messageIds);
            }
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
 * duplicate id): rename them in the mirror (all at once, by occurrence), in queued ops, and in the
 * streaming state.
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
        if (op.op === "setText" || op.op === "setTranslation") {
            op.id = rename(op.id);
        } else if (op.op === "setMessage") {
            op.message = { ...op.message, chatId: rename(op.message.chatId!) };
        } else if (op.op === "remove") {
            op.ids = op.ids.map(rename);
        } else if (op.op === "append" && "after" in op.anchor) {
            op.anchor = { after: rename(op.anchor.after) };
        }
    }
    const streamed = streamingState.messageId;
    if (streamed !== null && streamingState.chaId === ref.chaId && streamingState.chatId === ref.chatId) {
        streamingState.messageId = rename(streamed);
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

/** Stops sending a chat whose work the server refused as invalid. */
export function quarantineChat(group: Pick<SentChatGroup, "key" | "seq">) {
    inflight.delete(group.key);
    jobBlocked.delete(group.key);
    quarantined.add(group.key);
    deferred.delete(group.key);
    staleChats.delete(group.key);
    const seq = Math.max(group.seq, workSeq(group.key));
    pending.delete(group.key);
    markDiscarded(group.key, seq);
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
 * server job locks is deferred (excluded from batches, reloaded when the job ends); a chat that is
 * gone is dropped and its character's chat list is to be refreshed (`refresh`); any other
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
            holdChatRevision(group.key, server.revision);
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
            // A server job streams into it: replacing the chat now would drop the streamed text.
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
        if (!isMember(ref)) {
            // Deleted here but kept on the server (the delete conflicted): the character's list is
            // read again, which puts the chat back at its server position.
            discardChatWork(group.key, group.seq);
            holdChatRevision(group.key, server.revision);
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
export function acceptRemoteChat(server: RemoteChat, seq = 0) {
    const key = keyOf(server.characterId, server.id);
    discardChatWork(key, seq);
    applyRemoteChat(server);
}

/**
 * Applies a server copy without settling or discarding any work (callers establish eligibility). A
 * loaded chat takes the copy; a member that is not loaded, or a chat new to the list, takes its
 * summary only (a server copy never loads a chat).
 */
function applyRemoteChat(server: RemoteChat) {
    const key = keyOf(server.characterId, server.id);
    staleChats.delete(key);
    if (findCharacter(server.characterId)) {
        const ref = { chaId: server.characterId, chatId: server.id };
        if (server.revision === null || !server.data) {
            removeChat(server.characterId, server.id);
        } else if (!isMember(ref)) {
            insertSummary(server.characterId, memberIds(server.characterId).length, server.id, metaOf(server.data));
        } else if (isLoaded(ref)) {
            holdingOf(server.characterId).chats[slot(server.id)] = server.data;
        } else {
            holdingOf(server.characterId).summaries[slot(server.id)] = metaOf(server.data);
        }
        changed(key);
        ensureChat(server.characterId);
        syncSelection(server.characterId);
    }
    if (server.revision === null) {
        chatRevisions.delete(key);
    } else {
        holdChatRevision(key, server.revision);
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
        if (record && !covers(record.revision)) {
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
        return false;
    }
    return adoptChatRead(server, notice, issued);
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
    const ids = findCharacter(chaId) ? memberIds(chaId) : [];
    const index = ids.indexOf(chatId);
    if (index !== -1 && ids.length === 1) {
        return;
    }
    if (index !== -1) {
        removeChat(chaId, chatId);
        changed(key);
        syncSelection(chaId);
    }
    chatRevisions.delete(key);
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
    return (
        !!pending.get(key)?.ops.some((op) => op.op === "delete") ||
        !!inflight.get(key)?.ops.some((op) => op.op === "delete")
    );
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
 * A live update says the server committed this chat at `revision` (null: deleted). A chat the mirror
 * holds at an older revision is read again once it is idle here (no local work, generation, retry
 * block, deferral, or quarantine; `idleChatRefreshes`); a notice at or below the held revision is
 * dropped (this tab's own save, or a job's chat event that applied it first). A chat the mirror does
 * not hold, of a character it holds, is a new chat: `"collection"` asks for the character's chat list
 * (`applyRemoteCollection`). A member that is not loaded is noticed too and also answers
 * `"collection"`: its summary comes with that list (never a whole-chat read). Nothing is written and
 * nothing is discarded.
 */
export function noteRemoteChat(ref: ChatRef, revision: string | null): "noticed" | "collection" | "ignored" {
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
    return !pendingOrders.has(chaId) && !inflightOrders.has(chaId);
}

/**
 * Applies a character's chat list from a live update (another writer created, deleted, or reordered
 * its chats), never discarding local work: callers check `canApplyRemoteCollection` first, and an
 * older order than the held one is ignored. The list's chats are whole chats or summaries (the save
 * loop reads summaries). A chat with unsent or in-flight work, a running generation, a deferral, or a
 * quarantine keeps its local copy; a chat deleted here and not yet on the server stays out; a local
 * chat not on the server yet stays (after the server's); an idle local chat the server no longer has
 * is removed, only while its held revision is the one in `issued` (the revisions held when the list
 * was read). A newer server chat that is not loaded here (or new to the list) takes the summary and
 * revision; a loaded one takes a whole chat when the list has it, else keeps its copy and held
 * revision and is marked stale (the next cycle reads it whole). A chat's notice is dropped only when
 * the adopted state covers it. Nothing is queued. Returns false when the character's order work is
 * busy or a removal was fenced (the caller reads the list again later).
 */
export function applyRemoteCollection(
    collection: {
        characterId: string;
        order: ChatOrderRecord | null;
        chats: readonly ListedChat[];
    },
    issued?: ReadonlyMap<string, string>,
): boolean {
    const chaId = collection.characterId;
    if (!canApplyRemoteCollection(chaId)) {
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
    const adopted: { key: string; revision: string }[] = [];
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
        if (mine && heldRevision !== undefined && (compareRevision(record.revision, heldRevision) ?? 0) <= 0) {
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
        adopted.push({ key, revision: record.revision });
    }
    const removed: string[] = [];
    for (const id of localIds) {
        if (placed.has(id)) {
            continue;
        }
        const key = keyOf(chaId, id);
        if (!chatRevisions.has(key) || !canRefreshChat({ chaId, chatId: id })) {
            // Not on the server yet, or busy here: kept; its own save (or a conflict) settles it.
            next.push(entryAt(chaId, id)!);
            continue;
        }
        if (issued && issued.get(key) !== chatRevisions.get(key)) {
            // A newer copy arrived while the list was read (a job's chat event): read the list again.
            return false;
        }
        removed.push(key);
    }
    if (next.length === 0) {
        // Every chat is gone on the server (the writer's own new chat follows in a later change):
        // the list is left as it is rather than creating a chat here, which would be a write. A
        // character with no chats on either side (another writer created it without one) has its
        // empty order held, so the chat this client gives it can be saved.
        if (localIds.length === 0) {
            orderRevisions.set(chaId, collection.order.revision);
        }
        return true;
    }
    orderRevisions.set(chaId, collection.order.revision);
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
        chatRevisions.delete(key);
        staleChats.delete(key);
        noticedChats.delete(key);
        changed(key);
    }
    setChatList(chaId, next);
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
 * chat with unsent or in-flight work or a running generation keeps its local copy; a local create the
 * server already holds counts as landed; a never-sent local chat stays (after the server's); a local
 * chat the server no longer has is dropped with its work, unless a generation runs in it (its reload
 * waits). An idle chat takes the server's state: a whole chat when it is loaded and the list has one,
 * the summary and revision when it is not loaded (or new to the list); a loaded chat the list gives
 * only a newer summary of keeps its copy and held revision and is marked stale (read whole next).
 */
export function acceptRemoteCollection(collection: {
    characterId: string;
    order: ChatOrderRecord | null;
    chats: readonly ListedChat[];
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
    const localIds = memberIds(chaId);
    const next: ChatEntry[] = [];
    const placed = new Set<string>();
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
        if (entry?.resend || entry?.create) {
            // Our create landed (its answer was lost): the rest of its group and later work
            // continue on this revision.
            entry.ops = [...(entry.resend?.ops.slice(1) ?? []), ...entry.ops];
            entry.seq = Math.max(entry.seq, entry.resend?.seq ?? 0);
            entry.resend = null;
            entry.create = false;
            holdChatRevision(key, record.revision);
        }
        if (entry?.ops.some((op) => op.op === "delete")) {
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
        } else {
            next.push(mine?.chat && data ? { id, chat: data } : { id, meta: listedMeta(record) });
            holdChatRevision(key, record.revision);
            staleChats.delete(key);
            changed(key);
        }
    }
    for (const id of localIds) {
        if (placed.has(id)) {
            continue;
        }
        const key = keyOf(chaId, id);
        const entry = pending.get(key);
        const mine = entryAt(chaId, id)!;
        if (quarantined.has(key) || entry?.create || entry?.resend || inflight.get(key)?.ops[0]?.op === "create") {
            // Not on the server yet (never sent, or a create whose attempt was rolled back or is
            // unresolved): it stays and its create goes out.
            next.push(mine);
        } else if (isChatGenerating({ chaId, chatId: id })) {
            next.push(mine);
            deferred.add(key);
        } else {
            discardChatWork(key, 0);
            chatRevisions.delete(key);
            changed(key);
        }
    }
    setChatList(chaId, next);
    mutationToken += 1;
    if (next.some((chat) => !chatRevisions.has(keyOf(chaId, chat.id)) && !quarantined.has(keyOf(chaId, chat.id)))) {
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
}

// ---------------------------------------------------------------------------------------------
// Loading and eviction (Phase 6 slice 9b: chats load on demand; idle loaded chats are evicted)

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
    const read = await readRefs([], { chats: [{ characterId: ref.chaId, id: ref.chatId }] });
    const server = read.chats?.find((chat) => chat.characterId === ref.chaId && chat.id === ref.chatId);
    if (lifetimeOf(ref.chaId) !== lifetime) {
        return undefined;
    }
    if (server && findCharacter(ref.chaId) && isMember(ref)) {
        if (isLoaded(ref)) {
            adoptChatRead(server as RemoteChat, notice, issued);
        } else {
            // Evicted during the read: loaded again as an unloaded chat is.
            return await loadUnloaded(ref, lifetime);
        }
    }
    return heldChat(ref);
}

/** Reads a character's summary list and applies it as a live update (fenced on the owner's lifetime). */
async function readSummaryList(chaId: string, lifetime: string) {
    const revisions = heldChatRevisionsOf(chaId);
    const read = await readRefs([], { chatSummaryCollections: [chaId] });
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
            const read = await readRefs([], {
                chats: wanted.slice(start, start + LOAD_CHUNK).map((id) => ({ characterId: chaId, id })),
            });
            if (lifetimeOf(chaId) !== lifetime) {
                return;
            }
            for (const chat of read.chats ?? []) {
                if (chat.characterId === chaId) {
                    records.set(chat.id, chat as RemoteChat);
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
 * older than the held revision, or an overtaken deletion). A chat with local work keeps its list
 * fields: an unloaded chat's summary is the local truth of those fields, laid over the read.
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
    if (heldRevision !== undefined && (compareRevision(server.revision, heldRevision) ?? -1) < 0) {
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
    holding.chats[slot(id)] = chat;
    delete holding.summaries[slot(id)];
    loadedKeys.add(key);
    holdChatRevision(key, server.revision);
    if (!busy) {
        settleNotice(key, server.revision);
    }
    changed(key);
    touch(key);
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
        !(streamingState.chaId === ref.chaId && streamingState.chatId === ref.chatId)
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
        .filter((ref) => !isChatGenerating(ref) && !inflight.has(keyOf(ref.chaId, ref.chatId)));
}

/** Applies a deferred chat's reload (after a successful read) and ends its deferral. */
export function finishDeferredReload(server: RemoteChat): string | null {
    const key = keyOf(server.characterId, server.id);
    const ref = { chaId: server.characterId, chatId: server.id };
    // A new job may have locked the chat while the read was in flight.
    if (!deferred.has(key) || isChatGenerating(ref) || inflight.has(key)) {
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
    acceptRemoteChat(server);
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
    return isChatGenerating({ chaId, chatId });
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
}

/** Tells the drift check that a mirror change outside the module is expected (hydration, restore). */
export function noteMirrorReplaced() {
    mutationToken += 1;
}

// The settings views read the selected chat's binding first (`docs/plan/chat-binding.md`, slice 4):
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
