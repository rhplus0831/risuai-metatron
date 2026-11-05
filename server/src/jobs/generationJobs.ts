import type { RerollAttemptWrite } from "../data/chatStore.ts";
import { createHash, randomUUID } from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Chat } from "../../../shared/database.ts";
import type { ChatGroup, ChatOrderChange } from "../../../shared/chats.ts";
import {
    type CallbackTargets,
    type ChatResyncRequest,
    type ReplyResyncRequest,
    type GenerationChunkEvent,
    type GenerationChatPatchEvent,
    type GenerationCommand,
    type GenerationContext,
    type GenerationCreateBody,
    type GenerationCreated,
    type GenerationCancelBody,
    type GenerationCancelled,
    type GenerationCurrent,
    type GenerationStopBody,
    type GenerationHooks,
    type GenerationNotice,
    type GenerationHandoffBody,
    type GenerationTakeoverBody,
    type GenerationTakeoverAnswer,
    type HydrationReceipt,
    GENERATION_ERROR_CODES,
    GENERATION_ERROR_STAGES,
    GENERATION_ID_PATTERN,
    type GenerationErrorCode,
    type GenerationErrorReason,
    type GenerationErrorStage,
    type GenerationEvent,
    type GenerationKind,
    type GenerationStage,
    type GenerationSequence,
    type GenerationStatus,
    type GenerationTerminalEvent,
    HIDDEN_HYDRATION_KINDS,
} from "../../../shared/jobs.ts";
import { isProviderCode } from "../../../shared/requestHistory.ts";
import { type BatchConflict, parseRevisionToken } from "../../../shared/resources.ts";
import { type ChatWriteChange, messageOrderAfterChange } from "../data/chatStore.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import {
    GENERATION_RECEIPT_MS,
    MAX_GENERATION_RECEIPTS,
    KEPT_OUTCOME_MS,
    MAX_KEPT_OUTCOMES,
    type GenerationReceipts,
} from "../data/generationReceipts.ts";
import type { ChatStreaming, ChatStreamingSnapshot, HandoffOffer } from "../../../shared/events.ts";
import {
    type AppliedChanges,
    CommittedWriteError,
    ResourceBatchConflictError,
    type ResourceBatchOperation,
    type ResourceStore,
    type WrittenChanges,
} from "../data/resourceStore.ts";
import type { MaintenanceGate, SnapshotManager } from "../data/snapshots.ts";
import { type DiagnosticsRecorder, logEvent, recordSafely } from "../diagnostics/log.ts";
import type { DiagnosticEventInput } from "../../../shared/diagnostics.ts";
import { checkChatBinding, readChatBindingState } from "./chatBinding.ts";
import { readOrphanedOverrideEntries } from "./loreOverrides.ts";
import {
    type ChannelHub,
    createChannelHub,
    type JobChannel,
    type NoticeAudience,
    parseGenerationHooks,
} from "./channel.ts";
import type { GenerationLock, MessageOwner, MessageRef } from "./generationLock.ts";

/** After its first abort, a job has this long to persist its text and end before it is ended for it. */
export const JOB_ABORT_GRACE_MS = 5000;
/** A negotiated owner socket stops counting after this long without an incoming frame. */
export const OWNER_SILENT_MS = 45_000;
/** A dispatched channel request waits at most this long while its job has no effective owner. */
export const OWNER_ABSENT_MS = 120_000;
/** Delay before an absent owner offers its running job to another client. */
export const HANDOFF_OFFER_DELAY_MS = 10_000;
/** A takeover ticket must attach within this allowance; a pending attached takeover has no expiry. */
export const HANDOFF_TICKET_MS = 10_000;
/** An ended job stays readable (status, reconnect) this long. */
export const JOB_DONE_GRACE_MS = 60_000;
/**
 * After that, its outcome (`GenerationStatus.kept`) stays readable this long, at most
 * `MAX_KEPT_OUTCOMES` of them (the oldest goes first), so an owner that comes back late still learns
 * how its job ended. The memory view expires from collection; disk receipts expire from the end.
 * An epoch change clears both.
 */
export { KEPT_OUTCOME_MS, MAX_KEPT_OUTCOMES };
/** A kept error's message is cut to this many UTF-8 bytes. */
export const MAX_KEPT_MESSAGE_BYTES = 4096;
/** A running job, or each part of a command sequence, is aborted (`timeout`) after this long. */
export const JOB_MAX_DURATION_MS = 30 * 60_000;
const JOB_GC_INTERVAL_MS = 30_000;
const JOB_HEARTBEAT_MS = 15_000;
/** Most records a job remembers for re-sending on attach. */
const MAX_TRACKED_REFS = 256;

const socketPath = /^\/api\/generations\/([^/]+)\/ws$/;

/**
 * Where a runner failed, for the terminal `error` event: the stage, the LLM request that failed when
 * it was one, its provider error code, and the failure's own code when a tab tells it apart by one.
 */
export type GenerationFailure = {
    stage?: GenerationErrorStage;
    requestId?: string;
    providerCode?: string | null;
    code?: GenerationErrorCode;
};

/** A runner's failure with an HTTP-like status for the terminal `error` event. */
export class GenerationRunnerError extends Error {
    readonly status: number;
    /** Filled by `markFailure`: the site nearest the failure sets a field first. */
    readonly failure: GenerationFailure = {};
    constructor(status: number, message: string, failure?: GenerationFailure) {
        super(message);
        this.name = "GenerationRunnerError";
        this.status = status;
        if (failure) {
            markFailure(this, failure);
        }
    }
}

/** The failure fields of any other thrown object (a `GenerationRunnerError` holds its own). */
const foreignFailures = new WeakMap<object, GenerationFailure>();

/**
 * Adds to `error`'s failure fields each field of `failure` it does not have yet (a field is had when
 * it holds a value: the site nearest the failure wins, and a later site only fills the gaps). A
 * primitive thrown value takes none. Returns `error`, so a site can `throw markFailure(error, …)`.
 *
 * Marking sites: this module's runningJob.write catch around writeAsJob marks persist;
 * `server/src/jobs/runSetup.ts` asScript marks script (including Lua, triggers and plugin hooks),
 * as do the hook wrappers in `server/src/lua/bindings.ts` runRequest. That module's request wrapper
 * marks request unless an inner site marked a stage. `server/src/prompt/runner.ts` runSpeaker
 * marks returned request failures as request, with request id/provider code; readReply distinguishes
 * request reads from persist checkpoints. Its runPromptSend catch fills an unmarked stage from
 * JobRunState.stage (setup, input, assembly, request or tail). errorTerminal copies checked fields.
 */
export function markFailure<E>(error: E, failure: GenerationFailure): E {
    if (typeof error !== "object" || error === null) {
        return error;
    }
    let target: GenerationFailure;
    if (error instanceof GenerationRunnerError) {
        target = error.failure;
    } else {
        target = foreignFailures.get(error) ?? {};
        foreignFailures.set(error, target);
    }
    for (const key of ["stage", "requestId", "providerCode", "code"] as const) {
        const value = failure[key];
        if ((target[key] === undefined || target[key] === null) && value !== undefined && value !== null) {
            (target as Record<string, unknown>)[key] = value;
        }
    }
    return error;
}

/** The failure fields `markFailure` gave `error` (a copy; empty for none), to carry to a replacement. */
export function failureOf(error: unknown): GenerationFailure {
    if (error instanceof GenerationRunnerError) {
        return { ...error.failure };
    }
    return typeof error === "object" && error !== null ? { ...foreignFailures.get(error) } : {};
}

/** A job used a capability after it ended (its token is dead; nothing more is written or sent). */
export class GenerationJobEndedError extends Error {
    constructor() {
        super("The generation job has ended");
        this.name = "GenerationJobEndedError";
    }
}

/** A job write conflicted again after its one re-read, or conflicted on a chat or order. */
export class JobWriteConflictError extends Error {
    readonly conflicts: BatchConflict[];
    constructor(conflicts: BatchConflict[]) {
        super("The job's write conflicted with another change");
        this.name = "JobWriteConflictError";
        this.conflicts = conflicts;
    }
}

/** What a job writes in one call: the batch body's parts, with typed chat groups. */
export type JobChanges = {
    ops?: readonly ResourceBatchOperation[];
    chats?: readonly ChatGroup[];
    chatOrders?: readonly ChatOrderChange[];
};

/**
 * What a job write applied (the store's `AppliedChanges`) and, when the store handed them over, its
 * own chat changes (`written`, aligned with `chats`). Without `written`, nothing is known of them.
 */
export type JobWriteResult = AppliedChanges & { written?: WrittenChanges };

type Distribute<T> = T extends unknown ? Omit<T, "epoch"> : never;
/** Runner chunks carry cumulative text; the registry computes the wire delta and adds the epoch. */
export type JobEventInput =
    | Distribute<Exclude<GenerationEvent, { type: "ping" | "chatPatch" | "chunk" }>>
    | Omit<GenerationChunkEvent, "epoch" | "base" | "keep">;
type TerminalInput = Distribute<GenerationTerminalEvent>;

/** What the injected runner gets for one job. */
export type RunningJob = {
    readonly id: string;
    readonly kind: GenerationKind;
    readonly context: Readonly<GenerationContext>;
    /** A `command` job's command (validated by the route; a copy), null for every other kind. */
    readonly command: Readonly<GenerationCommand> | null;
    /** The plugin hooks the owner registered (validated; the channel calls back only for these). */
    readonly hooks: GenerationHooks;
    /** Notices, questions, and plugin callbacks to the owner (the job channel). */
    readonly channel: JobChannel;
    /** Whether an owner socket is attached now. */
    ownerAttached(): boolean;
    /** The database epoch the job was admitted under; every write and event names it. */
    readonly epoch: string;
    /** Aborted by owner DELETE, request cancel, chat stop, the time limit, shutdown, or maintenance;
     * the job then has its abort grace
     * (`abortGraceMs`, `JOB_ABORT_GRACE_MS` by default) to persist its text and return. It may already
     * be aborted when the runner starts (check `aborted` before adding a listener). */
    readonly signal: AbortSignal;
    /**
     * Sends an event to the owner. `accepted` is preceded by the job chat's hydration; `done` and
     * `error` end the job (the chat's hydration and the terminal event go out, and every later
     * call throws `GenerationJobEndedError`). A `resource` of a hidden kind throws.
     * A `stage` equal to the job's current one is not sent; the registry keeps the latest and
     * replays it on attach while the job runs.
     */
    emit(event: JobEventInput): void;
    /**
     * Reads the named records and chats and sends them as `resource` events (missing ones are
     * skipped; the job chat goes as a `chatPatch` when one can express its change); returns what
     * was sent, at the revisions sent.
     */
    emitRecords(records: {
        refs?: readonly { kind: string; id: string }[];
        chats?: readonly { characterId: string; id: string }[];
    }): HydrationReceipt[];
    /**
     * `writeAsJob`: applies `build()` with the job's epoch and token. `build` is synchronous and
     * replay-safe: a conflict that names only resource records (a patch racing a client edit) calls
     * it again, after it re-reads, and applies once more; any other conflict, or a second one,
     * throws `JobWriteConflictError`. A `begin` op takes the message's lock first; a `final`
     * generation write whose checkpoint is `applied` releases it.
     *
     * Returns what the store applied, with `written`: each chat group's own change as stored by the
     * attempt that applied (`WrittenChanges`, from `applyChanges` with `changes: true`; undefined
     * for a group without a by-id change). The job scope adopts its chat's change from it instead of
     * reading the chat again (`refreshChatAfterWrite`).
     *
     * `covers`: for a generation write, the newest chunk `seq` its text includes (captured with
     * the text). Once that write applies, the job's chat events tell the client the stored text
     * holds that chunk, so a processed checkpoint is not overwritten by older streamed text. Every
     * applied generation write replaces the claim with its own: one without `covers` claims 0, so
     * the client keeps any streamed text over the stored one.
     * `rerollAttempt` opens provenance with a begin group or requests rollback with its final write;
     * it reaches the store as an option, separate from the wire ops.
     */
    write(
        build: () => JobChanges,
        options?: {
            covers?: readonly { messageId: string; generationId: string; seq: number }[];
            rerollAttempt?: RerollAttemptWrite;
        },
    ): JobWriteResult;
    /**
     * Throws what `write` throws before it builds anything: the job ended, or maintenance closed the
     * writes. For a runner with a write of its own to make first, in the same synchronous step
     * (available on registry jobs).
     */
    assertWritable?(): void;
    /** Sequence coordination, available on registry jobs (absent on read-only render facades). */
    sequence?: {
        /**
         * Synchronous preflight immediately before the part's write: abort, previous part deadline,
         * shutdown, maintenance/gate, epoch, chat existence, complete binding equal to the admitted
         * context, then orphaned overrides. A presetChain pick does not change that context. Neither
         * the occupied slot nor the original revision is rechecked. Refusal writes nothing; an absent
         * stop code means aborted. Success starts JOB_MAX_DURATION_MS anew for this part; an already
         * expired deadline aborts instead of resetting. Diagnostics still time from job admission.
         */
        beginPart(): { ok: true } | { ok: false; stopped?: string };
        progress(value: Pick<GenerationSequence, "total" | "sent">): void;
        /** Releases only deleted messages, keeping the job's token and slot alive. */
        releaseRemovedReplies(): void;
    };
    /** Parsed JSON messages from the owner's socket (the job channel answers through it). */
    onClientMessage(listener: (message: unknown) => void): () => void;
    /**
     * The preset the job's later callbacks name in their targets (a send's `presetChain` pick);
     * callbacks already sent keep theirs.
     */
    setCallbackPreset?(presetId: string): void;
    /** Flush synchronous metadata setters before a write, event, or callback barrier. */
    setPendingFlush?(flush: (() => void) | null): void;
    /**
     * Registers the job's initial memory summarization run `runId` (fresh for each run) for the
     * owner's stop control (`requestMemoryStop`), replacing any earlier registration. Throws
     * `GenerationJobEndedError` once the job ended. The job's end clears it.
     */
    registerMemoryControl?(runId: string): MemoryControl;
};

/**
 * A registered memory run's stop control: `stopRequested()` turns true once the owner asked this
 * run to stop (the run saves the summary in progress, starts no further one, and the job goes on);
 * `release()` unregisters it while it is still the registered run, and does nothing after that or
 * after the job's end.
 */
export type MemoryControl = { stopRequested(): boolean; release(): void };

/** `requestMemoryStop`'s answer: the stop is recorded, or the route's status and body. */
export type MemoryStopResult = { ok: true } | { ok: false; status: 404 | 409 | 412; body: Record<string, unknown> };

/** A normal return without a terminal becomes an error; a registry abort takes precedence. */
export type GenerationRunner = (job: RunningJob) => Promise<void>;

/** Without a runner (`options.runner`), a job ends with this error. */
export const unavailableRunner: GenerationRunner = async () => {
    throw new GenerationRunnerError(501, "Server generation is not available yet");
};

/** Admission or identity replay; null replay status comes from a retained disk receipt without its outcome payload. */
export type CreateResult =
    | ({ ok: true } & GenerationCreated)
    | { ok: false; status: 400 | 404 | 409 | 412 | 503; body: Record<string, unknown> };

/** What a job refused by a chat's rebuild says: the run holds the chat until a person ends it there. */
const REBUILD_LOCK_TEXT =
    "This chat's memory is being rebuilt. Resume or abandon the rebuild in the memory panel to use the chat again.";

/**
 * Whether a chat's rebuild refuses this job. The lock is the run row, not a task, because a send on a
 * stopped run could write live records the swap would lose, so job admission, the one chokepoint, reads it.
 * A preview writes nothing, and the rebuild's own command is what ends the lock.
 */
function rebuildLocks(body: GenerationCreateBody): boolean {
    return body.kind !== "preview" && body.kind !== "previewPrompt" && body.command?.type !== "memoryRebuild";
}

function canonicalJson(value: unknown): string {
    if (value === undefined || value === null) return "null";
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value === "object") {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

/**
 * SHA-256 of exactly kind, characterId, chatId, command, input, userMessageId, continueMessageId and rerollMessageId,
 * with recursively sorted JSON object keys, array order kept, and absent fields encoded as null.
 * Revision, binding ids, hooks and client id are excluded: retry identity follows the action and
 * input even after its owner's stored revision or connection changed.
 */
function requestFingerprint(body: GenerationCreateBody): string {
    const { characterId, chatId, input, userMessageId, continueMessageId, rerollMessageId } = body.context;
    return createHash("sha256")
        .update(
            canonicalJson({
                kind: body.kind,
                characterId,
                chatId,
                command: body.command,
                input,
                userMessageId,
                continueMessageId,
                rerollMessageId,
            }),
        )
        .digest("hex");
}

/** Frozen terminal routing survives collection; disk receipts already contain the creator's view. */
type TerminalReaders = {
    clientId: string | null;
    ownerClientId?: string;
    skippedRecipient?: string;
    stoppedBy?: string;
};

type RequestIdentity =
    | { cancelled: true }
    | {
          cancelled: false;
          jobId: string;
          clientId: string | null;
          ownerClientId?: string;
          skippedRecipient?: string;
          stoppedBy?: string;
          fingerprint: string | null;
          status: GenerationStatus | null;
      };

/** Each view keeps the canonical terminal intact; only its frozen recipient runs late listeners. */
function projectTerminal(
    terminal: GenerationTerminalEvent,
    readers: TerminalReaders,
    clientId: string | undefined,
): GenerationTerminalEvent {
    if (terminal.type === "done") {
        return terminal.skipped === undefined || clientId === (readers.skippedRecipient ?? readers.clientId)
            ? { ...terminal }
            : { ...terminal, skipped: [] };
    }
    if (terminal.reason !== "aborted" || !readers.stoppedBy) return { ...terminal };
    const { abortedBy, ...rest } = terminal;
    return {
        ...rest,
        ...(clientId !== readers.stoppedBy && (clientId === readers.clientId || clientId === readers.ownerClientId)
            ? { abortedBy: "other" as const }
            : {}),
    };
}

function projectStatus(
    status: GenerationStatus | null,
    readers: TerminalReaders,
    clientId: string | undefined,
): GenerationStatus | null {
    return status?.terminal ? { ...status, terminal: projectTerminal(status.terminal, readers, clientId) } : status;
}

/** Replays also omit another client's preview result, independently of late-listener routing. */
function replayStatus(
    identity: Exclude<RequestIdentity, { cancelled: true }>,
    clientId: string,
): GenerationStatus | null {
    const status = projectStatus(identity.status, identity, clientId);
    if (identity.clientId === clientId || status?.terminal?.type !== "done") return status;
    const { result, ...terminal } = status.terminal;
    return { ...status, terminal };
}

type Job = {
    id: string;
    /** Immutable creator: receipts, owned, and device notices keep this identity. */
    clientId: string;
    /** Current callback authority and request-lane identity. */
    ownerClientId: string;
    requestId?: string;
    fingerprint: string | null;
    kind: GenerationKind;
    context: GenerationContext;
    command: GenerationCommand | null;
    hooks: GenerationHooks;
    channelLink: ReturnType<ChannelHub["open"]>;
    epoch: string;
    token: string;
    controller: AbortController;
    abortReason: GenerationErrorReason | null;
    /** First explicit Stop participant (or the foreign client of a chat-slot Stop). */
    stoppedBy?: string;
    /** Frozen at finalize: owner if present, otherwise creator. */
    skippedRecipient?: string;
    abortTimer: ReturnType<typeof setTimeout> | null;
    startedAt: number;
    /** The duration limit starts anew for each sequence part; diagnostics use startedAt. */
    deadlineFrom: number;
    sequence?: Pick<GenerationSequence, "total" | "sent">;
    sequenceAttempted: boolean;
    ended: boolean;
    endedAt: number;
    /** Only the current owner's sockets can answer callbacks or count as owner presence. */
    sockets: Set<WebSocket>;
    /** Creator, former owners, and a pending takeover watch the same chat baseline. */
    viewers: Set<WebSocket>;
    offer: HandoffOffer | null;
    offerTimer: ReturnType<typeof setTimeout> | null;
    ticket: {
        value: string;
        clientId: string;
        until: number;
        offer: HandoffOffer;
        timer: ReturnType<typeof setTimeout> | null;
    } | null;
    pendingTakeover: { clientId: string; ws: WebSocket; offer: HandoffOffer } | null;
    switchTimer: ReturnType<typeof setTimeout> | null;
    /** Admission or the last effective owner's departure; null while an owner is present. */
    ownerAbsentSince: number | null;
    /** The latest `accepted`, its text kept current by `chunk`; null once its final write applied. */
    current: Extract<GenerationEvent, { type: "accepted" }> | null;
    /** Per message id: the newest chunk the stored text includes (the last applied write's `covers`). */
    watermarks: Map<string, { generationId: string; seq: number }>;
    /** Attach stamps are ordered only within one client, never across devices. */
    attachStamps: Map<string, number>;
    preset: Extract<GenerationEvent, { type: "preset" }> | null;
    /** The current presentation stage, retained for attach while the job runs. */
    stage: GenerationStage | null;
    /** What the job's callbacks act on (each send can pick a preset: `setCallbackPreset`). */
    targets: CallbackTargets;
    /** Records the job sent (`kind\0id`, or `chats\0characterId\0id`), re-sent fresh on attach. */
    refs: Map<string, { kind: string; id: string; characterId?: string }>;
    /**
     * The job chat as last handed to every attached socket (seeded at admission, then advanced when send
     * succeeds, without a tab acknowledgement; a stored state at its `revision`: a read, or
     * `workingChat`): the base of the next `chatPatch`. Null once the job ended. It is not what the
     * owner holds: the owner applies a patch only at exactly its base or its revision, and asks for a
     * whole-chat resync otherwise. While the stored revision is still this one's, the callback barrier sends a
     * socket that advertised `hydration=patch` no chat at all (`hydrateAll`); that tab reads the chat
     * itself when it does not hold the revision.
     */
    sentChat: ChatBaseline | null;
    /**
     * The job chat as stored at its `revision`: the chat's last read (at admission, or by a job chat
     * event that read it, `jobChatEvent`), advanced by each own write whose stored change starts at
     * that revision (`writeAsJob`'s `committed`). While the stored revision is still its own, the next
     * `chatPatch` is `sentChat` diffed against it without reading the chat, however many writes no
     * socket took. Own writes use applyChanges with changes: true, adopting ChatWriteChange via
     * advanceChatBaseline and `server/src/data/chatStore.ts` messageOrderAfterChange. A checkpoint
     * with no open socket advances only this baseline, so the next attach includes all such writes.
     * Null when unknown: an own write of the chat without a by-id change (a whole-chat
     * write, a remove and reappend, a group that applied nothing), one whose change starts at another
     * revision (another writer's change landed first), or a change that did not fit; the next chat
     * event then reads the chat. Behind the stored revision after another writer's change alone, which
     * that event finds the same way. Null once the job ended. No baseline is changed in place, so this
     * one shares its unchanged message strings with the baseline it was advanced from.
     */
    workingChat: ChatBaseline | null;
    pendingFlush?: (() => void) | null;
    /** The job chat's messages this job began a generation on: every patch carries their stored rows. */
    generated: Set<string>;
    /** Every chat this job locked a message in (`chatKey`): the job's end publishes their locks again. */
    lockChats: Map<string, { characterId: string; chatId: string }>;
    /**
     * The generations this job released (`retiredKey`: a final write applied, or the message was gone
     * at a refresh): a replayed `begin` of one changes nothing in the store and takes no lock again.
     */
    retired: Set<string>;
    terminal: GenerationTerminalEvent | null;
    /** The registered memory run (`registerMemoryControl`) and whether its stop was asked; null for none. */
    memoryControl: { runId: string; stopRequested: boolean } | null;
    listeners: Set<(message: unknown) => void>;
    finished: Promise<void>;
    resolveFinished: () => void;
};

const chatKey = (characterId: string, chatId: string) => `${characterId}\u0000${chatId}`;
/** A released generation of a message (`Job.retired`). */
const retiredKey = (ref: MessageRef, generationId: string) =>
    `${ref.characterId}\u0000${ref.chatId}\u0000${ref.messageId}\u0000${generationId}`;

/** `text` cut to at most `bytes` UTF-8 bytes, never inside a code point. */
function cutUtf8(text: string, bytes: number): string {
    const encoded = Buffer.from(text);
    if (encoded.length <= bytes) {
        return text;
    }
    // A code point the limit cuts decodes as one U+FFFD at the end: dropped.
    return encoded
        .subarray(0, bytes)
        .toString()
        .replace(/\uFFFD$/, "");
}

/** A terminal as an outcome keeps it: small, whatever the job produced (`MAX_KEPT_*`). */
function keptTerminal(terminal: GenerationTerminalEvent): GenerationTerminalEvent {
    if (terminal.type === "error") {
        return { ...terminal, message: cutUtf8(terminal.message, MAX_KEPT_MESSAGE_BYTES) };
    }
    const { result: _result, ...rest } = terminal;
    // Retained outcomes cannot carry request samples from an older in-process emitter.
    delete (rest as Record<string, unknown>).alternatives;
    return rest;
}

/** The same trimmed outcome for memory and disk. */
function keptStatus(job: Job, terminal: GenerationTerminalEvent): GenerationStatus {
    return {
        jobId: job.id,
        kind: job.kind,
        characterId: job.context.characterId,
        chatId: job.context.chatId,
        epoch: job.epoch,
        state: "ended",
        ...(job.ownerClientId !== job.clientId ? { handedOff: true as const } : {}),
        ...(job.current?.messageId ? { messageId: job.current.messageId } : {}),
        terminal: keptTerminal(terminal),
        kept: true,
    };
}

function isResyncRequest(message: unknown): message is ChatResyncRequest {
    return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "resync";
}

function isReplyResyncRequest(message: unknown): message is ReplyResyncRequest {
    return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "resyncReply";
}

/**
 * A stored chat as a patch base: its revision, its fields without `message` (as JSON), and its
 * message ids in order with each message's JSON. Never changed in place: a baseline advanced from
 * another shares its unchanged parts.
 */
export type ChatBaseline = {
    revision: string;
    meta: string;
    ids: readonly string[];
    texts: ReadonlyMap<string, string>;
};

/** The fields of a stored chat without `message`. */
function chatMeta(data: Chat): Record<string, unknown> {
    const { message: _message, ...meta } = data as Chat & Record<string, unknown>;
    return meta;
}

/**
 * The baseline of a chat read at `revision`. A message without an id is still listed in `ids`
 * (as `undefined`), so `diffChat` gives up on the copy.
 */
export function chatBaseline(revision: string, data: Chat): ChatBaseline {
    const texts = new Map<string, string>();
    const ids: string[] = [];
    for (const message of data.message ?? []) {
        const id = message.chatId!;
        ids.push(id);
        texts.set(id, JSON.stringify(message));
    }
    return { revision, meta: JSON.stringify(chatMeta(data)), ids, texts };
}

/**
 * `base` (the stored chat at `change.baseRevision`) with the change a write stored laid onto it: the
 * stored chat at `change.revision`, equal to `chatBaseline` of a read there. The removed ids leave,
 * and each touched row is placed after its anchor (`messageOrderAfterChange`) with its stored JSON,
 * which is what a read's `JSON.stringify` of the parsed row gives (a row is stored as the JSON of a
 * parsed value). The other messages keep their strings. The metadata is the change's only when the
 * group changed it. Null when the change does not fit `base`.
 */
export function advanceChatBaseline(base: ChatBaseline, change: ChatWriteChange): ChatBaseline | null {
    let { ids, texts } = base;
    if (change.rows.length > 0 || change.removed.length > 0) {
        const order = messageOrderAfterChange(ids, change);
        if (!order) {
            return null;
        }
        ids = order.map((entry) => (typeof entry === "number" ? change.rows[entry].id : entry));
        const next = new Map(texts);
        for (const id of change.removed) {
            next.delete(id);
        }
        for (const row of change.rows) {
            next.set(row.id, row.data);
        }
        texts = next;
    }
    if (ids.length !== change.count) {
        return null;
    }
    return {
        revision: change.revision,
        // Projected as a read projects it: the stored string may differ (an in-process writer's
        // `toJSON` or `JSON.rawJSON` can store a `message` field or a number in another spelling).
        meta: change.meta === undefined ? base.meta : JSON.stringify(chatMeta(JSON.parse(change.meta) as Chat)),
        ids,
        texts,
    };
}

/**
 * The change from the stored chat `base` to the stored chat `next` (a read's baseline, or the job's
 * working baseline), as a `chatPatch` body, or null when a patch cannot express it and the chat goes
 * whole: another incarnation or epoch, an older revision, a message of `next` without an id or with a
 * repeated one, or surviving messages in another order (a `replace` that reordered them).
 * `generated` messages are always carried (see `GenerationChatPatchEvent`). Only the carried rows,
 * and the metadata when it changed, are parsed (from `next`).
 */
export function diffChat(
    base: ChatBaseline,
    next: ChatBaseline,
    generated: ReadonlySet<string>,
): Pick<GenerationChatPatchEvent, "meta" | "removed" | "messages" | "count"> | null {
    const from = parseRevisionToken(base.revision);
    const to = parseRevisionToken(next.revision);
    if (!from || !to || from.epoch !== to.epoch || from.seq !== to.seq || from.revision > to.revision) {
        return null;
    }
    const ids = next.ids;
    const present = new Set<string>();
    for (const id of ids) {
        if (typeof id !== "string" || present.has(id)) {
            return null;
        }
        present.add(id);
    }
    const removed = base.ids.filter((id) => !present.has(id));
    // The surviving messages in the same relative order: a patch never moves a message.
    const survivorsBefore = base.ids.filter((id) => present.has(id));
    const survivorsAfter = ids.filter((id) => base.texts.has(id));
    if (survivorsBefore.some((id, index) => survivorsAfter[index] !== id)) {
        return null;
    }
    const changed: { after: string | null; message: unknown }[] = [];
    ids.forEach((id, index) => {
        const text = next.texts.get(id)!;
        if (generated.has(id) || base.texts.get(id) !== text) {
            changed.push({ after: index > 0 ? ids[index - 1] : null, message: JSON.parse(text) });
        }
    });
    return {
        ...(next.meta !== base.meta ? { meta: JSON.parse(next.meta) as Record<string, unknown> } : {}),
        ...(removed.length > 0 ? { removed } : {}),
        ...(changed.length > 0 ? { messages: changed } : {}),
        count: ids.length,
    };
}

const abortMessages: Record<GenerationErrorReason, { status: number; message: string }> = {
    aborted: { status: 499, message: "The generation was aborted" },
    shutdown: { status: 503, message: "The server is shutting down" },
    maintenance: { status: 503, message: "A restore or import is replacing the data" },
    timeout: { status: 504, message: "The generation took too long" },
    failed: { status: 500, message: "The generation failed" },
};

/**
 * The generation job registry: admission (one running job per chat), the owner and viewer sockets, the job's
 * writes (`writeAsJob` with the generation lock), and the lifecycle. Every abort fixes one
 * deadline (`abortGraceMs`, `JOB_ABORT_GRACE_MS` by default); a job is finalized once: its token dies,
 * its locks and chat slot are released, its chat's hydration and one terminal event are sent, and `finished`
 * resolves. Shutdown aborts every job at `beginShutdown`; a restore or import aborts them from
 * `withMaintenance` and waits for their end while writes are still open, so an abort checkpoint
 * lands before the data is replaced and no old job can write afterwards.
 * The default `server/src/jobs/channel.ts` hub shares `now` with the registry's owner clock.
 */
export function createGenerationJobs(options: {
    store: ResourceStore;
    kinds: ResourceKindRegistry;
    gate: MaintenanceGate;
    snapshots: SnapshotManager;
    lock: GenerationLock;
    /** The JWT check for the socket handshake. */
    authorize: (token: string | undefined) => Promise<boolean>;
    runner?: GenerationRunner;
    /** Runs after a send or an attempted command sequence ends done; a throw is only logged. */
    onChatJobDone?: (characterId: string, chatId: string, kind: GenerationKind) => void;
    /** The channel hub (tests inject one with a fake clock). */
    hub?: ChannelHub;
    /** The diagnostics journal: a `job` event at admission and at the end, and the caught faults. */
    diagnostics?: DiagnosticsRecorder;
    /** Best-effort disk receipts; memory remains authoritative. */
    receipts?: GenerationReceipts;
    /**
     * How long an aborted runner may take before the job is ended for it (default JOB_ABORT_GRACE_MS;
     * tests raise it).
     */
    abortGraceMs?: number;
    /**
     * Owner absence allowance (default OWNER_ABSENT_MS); `server/src/app.ts` forwards the test option
     * generationOwnerAbsentMs.
     */
    ownerAbsentMs?: number;
    /**
     * Negotiated socket silence allowance (default OWNER_SILENT_MS); `server/src/app.ts` forwards the
     * test option generationOwnerSilentMs.
     */
    ownerSilentMs?: number;
    handoffOfferDelayMs?: number;
    handoffTicketMs?: number;
    /** Publishes content-free open/closed offers to the live-update feed. */
    publishHandoff?: (event: { type: "handoff" } & HandoffOffer) => void;
    /** Clock for job timestamps, owner liveness, channel deadlines and identity retention (defaults to Date.now). */
    now?: () => number;
}) {
    const { store, kinds, gate, snapshots, lock, authorize, diagnostics, receipts } = options;
    const abortGraceMs = options.abortGraceMs ?? JOB_ABORT_GRACE_MS;
    const ownerAbsentMs = options.ownerAbsentMs ?? OWNER_ABSENT_MS;
    const ownerSilentMs = options.ownerSilentMs ?? OWNER_SILENT_MS;
    const handoffOfferDelayMs = options.handoffOfferDelayMs ?? HANDOFF_OFFER_DELAY_MS;
    const handoffTicketMs = options.handoffTicketMs ?? HANDOFF_TICKET_MS;
    const clock = options.now ?? (() => Date.now());
    const runner = options.runner ?? unavailableRunner;
    const hub = options.hub ?? createChannelHub({ now: clock });
    const jobs = new Map<string, Job>();
    const liveness = new WeakMap<WebSocket, { lastFrameAt: number; timer: ReturnType<typeof setTimeout> | null }>();
    /**
     * Owner sockets that advertised `hydration=patch` (the `hydration` query): their tab reads the job
     * chat itself when a callback's receipt names a revision it does not hold, so the callback
     * barrier sends them the chat only as it changed (`hydrateAll`).
     */
    const patchHydration = new WeakSet<WebSocket>();
    const socketClients = new WeakMap<WebSocket, string>();
    /** Chat → its running job. */
    const chatSlots = new Map<string, string>();
    const wsServer = new WebSocketServer({ noServer: true });
    let closed = false;
    let disposed = false;
    let maintenancePending = 0;
    let gcTimer: ReturnType<typeof setInterval> | null = null;
    /** The kept outcomes of collected jobs, oldest first (`KEPT_OUTCOME_MS`), all of `keptEpoch`. */
    const kept = new Map<
        string,
        TerminalReaders & { keptAt: number; status: GenerationStatus; requestId?: string; fingerprint: string | null }
    >();
    /** Request id → current-epoch job id, including ended jobs until collection moves their identity to kept. */
    const requestJobs = new Map<string, string>();
    /** Cancelled request id → first cancellation time, oldest first; bounded and cleared on epoch changes. */
    const cancelledRequests = new Map<string, number>();
    let keptEpoch = store.epoch();

    /** A `job` event to the journal; a recorder's throw never reaches the job. */
    const record = (input: DiagnosticEventInput) => recordSafely(diagnostics, input);

    /**
     * Starts absence only when the last effective socket leaves; a superseded socket's close
     * changes nothing. The channel is re-armed, without aborting callback-free work in the job.
     */
    function removeOwner(job: Job, ws: WebSocket, at: number) {
        const live = liveness.get(ws);
        if (live?.timer) clearTimeout(live.timer);
        if (!job.sockets.delete(ws)) return;
        if (job.sockets.size === 0) {
            job.ownerAbsentSince = at;
            job.channelLink.ownerChanged();
            armOffer(job);
        }
    }

    /**
     * Silence ends ownership and starts absence at its deadline, even when detection is late.
     * Socket events, sends and owner-presence reads (including MCP's) check it too: a late frame
     * cannot revive an expired socket while its timer is delayed.
     */
    function expireSilentOwners(job: Job) {
        let dropped = false;
        for (const ws of job.sockets) {
            const live = liveness.get(ws);
            if (live && clock() >= live.lastFrameAt + ownerSilentMs) {
                removeOwner(job, ws, live.lastFrameAt + ownerSilentMs);
                dropped = true;
                ws.close();
            }
        }
        if (dropped) job.channelLink.expireOverdue();
    }

    function ownerAttached(job: Job): boolean {
        expireSilentOwners(job);
        return job.sockets.size > 0;
    }

    function armSilence(job: Job, ws: WebSocket) {
        const live = liveness.get(ws);
        if (!live || !job.sockets.has(ws)) return;
        if (live.timer) clearTimeout(live.timer);
        live.timer = setTimeout(
            () => {
                live.timer = null;
                expireSilentOwners(job);
                armSilence(job, ws);
            },
            Math.max(1, live.lastFrameAt + ownerSilentMs - clock()),
        );
        live.timer.unref?.();
    }

    const noticeAudience: Record<GenerationNotice["kind"], NoticeAudience> = {
        alertNormal: "owner",
        alertError: "owner",
        alertToast: "owner",
        alertMd: "owner",
        alertWait: "owner",
        alertClear: "owner",
        openURL: "owner",
        emotion: "all",
        progress: "all",
        memoryProgress: "all",
        translating: "all",
        reloadChat: "all",
        reloadDisplay: "all",
        updateGUI: "all",
        tts: "creator",
        notification: "creator",
    };

    const allSockets = (job: Job) => [...job.sockets, ...job.viewers];

    function send(job: Job, event: GenerationEvent): boolean {
        const audience =
            event.type === "notice"
                ? noticeAudience[event.kind]
                : event.type === "callback" || event.type === "question" || event.type === "cancel"
                  ? "owner"
                  : "all";
        return sendText(job, JSON.stringify(event), audience);
    }

    /** A failing socket never stops the others; the result says whether an eligible socket took it. */
    function sendText(job: Job, text: string, audience: NoticeAudience = "all"): boolean {
        expireSilentOwners(job);
        let taken = false;
        for (const ws of audience === "owner" ? job.sockets : allSockets(job)) {
            if (audience === "creator" && socketClients.get(ws) !== job.clientId) continue;
            taken = sendSocket(job, ws, text) || taken;
        }
        return taken;
    }

    function sendSocket(job: Job, ws: WebSocket, text: string): boolean {
        try {
            if (ws.readyState === ws.OPEN) {
                ws.send(text);
                return true;
            }
        } catch (error) {
            logEvent("generation.socketSend", { job: job.id }, error, diagnostics);
        }
        return false;
    }

    function roleEvent(job: Job, ws: WebSocket): GenerationEvent {
        return {
            type: "handoff",
            epoch: job.epoch,
            owner: job.sockets.has(ws) ? "self" : "other",
            ...(job.pendingTakeover?.ws === ws ? { pending: true as const } : {}),
        };
    }

    function sendRoles(job: Job) {
        for (const ws of allSockets(job)) sendSocket(job, ws, JSON.stringify(roleEvent(job, ws)));
    }

    function canHandoff(job: Job): boolean {
        return (
            !closed &&
            !disposed &&
            !maintenancePending &&
            !gate.active &&
            !job.abortReason &&
            !job.ended &&
            !job.channelLink.closed &&
            job.epoch === store.epoch()
        );
    }

    function publishOffer(offer: HandoffOffer) {
        try {
            options.publishHandoff?.({ type: "handoff", ...offer });
        } catch (error) {
            logEvent("generation.handoffPublish", { job: offer.jobId }, error, diagnostics);
        }
    }

    function closeOffer(job: Job) {
        const offer = job.offer;
        job.offer = null;
        if (offer) publishOffer({ ...offer, state: "closed" });
    }

    function openOffer(job: Job, reason: HandoffOffer["reason"], target?: string) {
        if (!canHandoff(job) || job.ticket || job.pendingTakeover) return;
        closeOffer(job);
        job.offer = {
            epoch: job.epoch,
            jobId: job.id,
            characterId: job.context.characterId,
            chatId: job.context.chatId,
            state: "open",
            reason,
            ...(target ? { target } : {}),
        };
        publishOffer(job.offer);
    }

    function reopenOffer(job: Job, offer: HandoffOffer) {
        const reasonHolds =
            offer.reason !== "absent" ||
            (job.ownerAbsentSince !== null && clock() >= job.ownerAbsentSince + handoffOfferDelayMs);
        if (canHandoff(job) && reasonHolds) {
            openOffer(job, offer.reason, offer.target);
        }
        armOffer(job);
    }

    function expireTicket(job: Job) {
        const ticket = job.ticket;
        if (!ticket || clock() < ticket.until) return;
        if (ticket.timer) clearTimeout(ticket.timer);
        job.ticket = null;
        reopenOffer(job, ticket.offer);
    }

    /** Timers only wake checks; absence starts at the effective removal time, even if detected late. */
    function armOffer(job: Job) {
        if (job.offerTimer) clearTimeout(job.offerTimer);
        job.offerTimer = null;
        if (!canHandoff(job) || job.ownerAbsentSince === null || job.offer || job.ticket || job.pendingTakeover) return;
        const remaining = job.ownerAbsentSince + handoffOfferDelayMs - clock();
        if (remaining <= 0) {
            openOffer(job, "absent");
            return;
        }
        job.offerTimer = setTimeout(() => {
            job.offerTimer = null;
            armOffer(job);
        }, remaining);
        job.offerTimer.unref?.();
    }

    function clearHandoff(job: Job) {
        if (job.offerTimer) clearTimeout(job.offerTimer);
        if (job.ticket?.timer) clearTimeout(job.ticket.timer);
        if (job.switchTimer) clearTimeout(job.switchTimer);
        job.offerTimer = null;
        job.ticket = null;
        job.switchTimer = null;
        job.pendingTakeover = null;
        closeOffer(job);
    }

    function attachedAudiences(job: Job): NoticeAudience[] {
        return [
            "all",
            ...(job.sockets.size ? ["owner" as const] : []),
            ...(allSockets(job).some((ws) => socketClients.get(ws) === job.clientId && ws.readyState === ws.OPEN)
                ? ["creator" as const]
                : []),
        ];
    }

    /**
     * Never switch inside settlement: its promise continuation must first keep the reply or end
     * the job. The next enqueue switches before selecting a lane; otherwise a timer after the
     * continuation does it. Queued roots stay paused meanwhile, including settlement's own pump.
     */
    function scheduleSwitch(job: Job) {
        // Arm after the settlement stack unwinds, including when a clock batches timer wakeups.
        queueMicrotask(() => {
            if (!job.pendingTakeover || job.switchTimer || !canHandoff(job)) return;
            job.switchTimer = setTimeout(() => {
                job.switchTimer = null;
                switchOwner(job);
            }, 0);
            job.switchTimer.unref?.();
        });
    }

    function switchOwner(job: Job, snapshot?: () => void): boolean {
        const pending = job.pendingTakeover;
        if (
            !pending ||
            !canHandoff(job) ||
            job.channelLink.settling ||
            job.channelLink.hasDeliveredRequests() ||
            pending.ws.readyState !== pending.ws.OPEN
        )
            return false;
        if (job.switchTimer) clearTimeout(job.switchTimer);
        job.switchTimer = null;
        for (const ws of job.sockets) {
            const live = liveness.get(ws);
            if (live?.timer) clearTimeout(live.timer);
            if (live) live.timer = null;
            job.viewers.add(ws);
        }
        job.sockets.clear();
        job.viewers.delete(pending.ws);
        job.sockets.add(pending.ws);
        job.ownerClientId = pending.clientId;
        job.ownerAbsentSince = null;
        job.pendingTakeover = null;
        const live = liveness.get(pending.ws);
        if (live) {
            live.lastFrameAt = clock();
            armSilence(job, pending.ws);
        }
        armOffer(job);
        sendRoles(job);
        deliverJobChat(job, "whole");
        snapshot?.();
        // Transfer pumps both lanes only after roles and the shared whole-chat baseline are sent.
        job.channelLink.transferOwner(pending.clientId, attachedAudiences(job));
        job.channelLink.ownerChanged();
        return true;
    }

    /** The chat as stored now, or null (gone, another epoch, or the store closed during shutdown). */
    function readChat(job: Job, characterId: string, id: string): { revision: string; data: Chat } | null {
        try {
            if (store.epoch() !== job.epoch) {
                return null;
            }
            const chat = store.readRefs([], { chats: [{ characterId, id }] }).chats[0];
            return chat && chat.revision !== null ? { revision: chat.revision, data: chat.data as Chat } : null;
        } catch {
            // The store closed during shutdown: nothing more to hydrate.
            return null;
        }
    }

    /** The chat's stored revision (no metadata or message read), or null as `readChat`. */
    function readChatRevision(job: Job, characterId: string, id: string): string | null {
        try {
            return store.epoch() === job.epoch ? store.chatRevision(characterId, id) : null;
        } catch {
            // The store closed during shutdown: nothing more to hydrate.
            return null;
        }
    }

    /**
     * The job's messages still generating in a chat: the client keeps their streamed text over a
     * copy, and takes the stored text of every other message of the job.
     */
    function streamingIn(job: Job, characterId: string, id: string) {
        return lock
            .ownedBy(job.token)
            .filter((ref) => ref.characterId === characterId && ref.chatId === id)
            .map((ref) => {
                const mark = job.watermarks.get(ref.messageId);
                return {
                    messageId: ref.messageId,
                    generationId: ref.generationId,
                    seq: mark?.generationId === ref.generationId ? mark.seq : 0,
                };
            });
    }

    /**
     * Every message of a chat a generation job owns (any job, as the change feed announces them), each
     * with the newest chunk its owner's stored text includes (as `streamingIn`).
     */
    function chatStreaming(characterId: string, chatId: string): ChatStreaming {
        return {
            characterId,
            id: chatId,
            streaming: lock.ownedIn(characterId, chatId).map((owner) => {
                const mark = jobs.get(owner.jobId)?.watermarks.get(owner.messageId);
                return {
                    messageId: owner.messageId,
                    generationId: owner.generationId,
                    seq: mark?.generationId === owner.generationId ? mark.seq : 0,
                };
            }),
        };
    }

    /** The chat's current server copy as a `resource` event, or null (gone, or another epoch). */
    function chatEvent(job: Job, characterId: string, id: string): GenerationEvent | null {
        const chat = readChat(job, characterId, id);
        return chat ? wholeChatEvent(job, characterId, id, chat) : null;
    }

    function wholeChatEvent(
        job: Job,
        characterId: string,
        id: string,
        chat: { revision: string; data: Chat },
    ): GenerationEvent {
        return {
            type: "resource",
            epoch: job.epoch,
            kind: "chats",
            characterId,
            id,
            revision: chat.revision,
            data: chat.data,
            streaming: streamingIn(job, characterId, id),
        };
    }

    /**
     * The job chat as an event, with the baseline it becomes once a socket takes it: a `chatPatch`
     * from `sentChat` when `mode` is `patch` and a patch can express the change (`diffChat`), else
     * the whole chat. Null when the chat is gone.
     *
     * A patch while the stored revision is still the working baseline's (`workingChat`) is diffed
     * against that baseline: one revision read (none when the caller passes the `stored` revision it
     * just read), and only the carried rows parsed. Otherwise the chat is read whole, and that read
     * becomes the working baseline while the job runs.
     */
    function jobChatEvent(
        job: Job,
        mode: "patch" | "whole",
        stored?: string,
    ): { event: GenerationEvent; baseline: ChatBaseline } | null {
        const { characterId, chatId } = job.context;
        const base = mode === "patch" ? job.sentChat : null;
        const working = job.workingChat;
        if (base && working) {
            const revision = stored ?? readChatRevision(job, characterId, chatId);
            if (revision === null) {
                return null;
            }
            // A diff that cannot be a patch (survivors reordered) goes whole from the read below.
            const diff = revision === working.revision ? diffChat(base, working, job.generated) : null;
            if (diff) {
                return { event: chatPatchEvent(job, base, working.revision, diff), baseline: working };
            }
        }
        const chat = readChat(job, characterId, chatId);
        if (!chat) {
            return null;
        }
        const baseline = chatBaseline(chat.revision, chat.data);
        if (!job.ended) {
            job.workingChat = baseline;
        }
        const diff = base ? diffChat(base, baseline, job.generated) : null;
        const event =
            base && diff
                ? chatPatchEvent(job, base, chat.revision, diff)
                : wholeChatEvent(job, characterId, chatId, chat);
        return { event, baseline };
    }

    function chatPatchEvent(
        job: Job,
        base: ChatBaseline,
        revision: string,
        diff: NonNullable<ReturnType<typeof diffChat>>,
    ): GenerationEvent {
        const { characterId, chatId } = job.context;
        return {
            type: "chatPatch",
            epoch: job.epoch,
            characterId,
            id: chatId,
            baseRevision: base.revision,
            revision,
            ...diff,
            streaming: streamingIn(job, characterId, chatId),
        };
    }

    /**
     * The current `accepted` with the newest chunk's text, while its generation still owns the message
     * (a final reply is in the job chat, and its streamed text would be older); a command job's,
     * which has no message; null once the job ended.
     */
    function currentReply(job: Job): GenerationEvent | null {
        const current = job.current;
        if (!current || job.ended) {
            return null;
        }
        if (!current.messageId) {
            return current;
        }
        const owner = lock.ownerOf({
            characterId: job.context.characterId,
            chatId: job.context.chatId,
            messageId: current.messageId,
        });
        return owner?.token === job.token && owner.generationId === current.generationId ? current : null;
    }

    /** Sends the job chat (`jobChatEvent`); a socket taking it makes its copy the next patch's base. */
    function deliverJobChat(job: Job, mode: "patch" | "whole", stored?: string): GenerationEvent | null {
        const built = jobChatEvent(job, mode, stored);
        if (!built) {
            return null;
        }
        if (send(job, built.event)) {
            job.sentChat = built.baseline;
        }
        return built.event;
    }

    function recordEvent(job: Job, kindName: string, id: string): GenerationEvent | null {
        const kind = kinds.get(kindName);
        if (!kind || HIDDEN_HYDRATION_KINDS.includes(kindName)) {
            throw new Error(`${kindName} records are never sent to the client`);
        }
        try {
            if (store.epoch() !== job.epoch) {
                return null;
            }
            const item = store.readRefs([{ kind, id }]).items[0];
            if (!item || item.revision === null) {
                return null;
            }
            return { type: "resource", epoch: job.epoch, kind: kindName, id, revision: item.revision, data: item.data };
        } catch (error) {
            if (error instanceof Error && error.name === "ResourceStoreClosedError") {
                return null;
            }
            throw error;
        }
    }

    function track(job: Job, key: string, ref: { kind: string; id: string; characterId?: string }) {
        job.refs.delete(key);
        job.refs.set(key, ref);
        if (job.refs.size > MAX_TRACKED_REFS) {
            job.refs.delete(job.refs.keys().next().value!);
        }
    }

    function sendChat(job: Job) {
        deliverJobChat(job, "patch");
    }

    function receiptOf(event: GenerationEvent): HydrationReceipt {
        if (event.type === "chatPatch") {
            return { kind: "chats", id: event.id, characterId: event.characterId, revision: event.revision };
        }
        const resource = event as Extract<GenerationEvent, { type: "resource" }>;
        return {
            kind: resource.kind,
            id: resource.id,
            ...(resource.characterId !== undefined ? { characterId: resource.characterId } : {}),
            revision: resource.revision,
        };
    }

    /**
     * Every record the job sent other than its chat, read now (attach and the callback barrier send
     * them after the job chat).
     */
    function freshRecords(job: Job): GenerationEvent[] {
        const events: GenerationEvent[] = [];
        for (const ref of job.refs.values()) {
            if (ref.kind === "chats" && ref.characterId === job.context.characterId && ref.id === job.context.chatId) {
                continue;
            }
            const event =
                ref.kind === "chats" ? chatEvent(job, ref.characterId!, ref.id) : recordEvent(job, ref.kind, ref.id);
            if (event) {
                events.push(event);
            }
        }
        return events;
    }

    /**
     * The callback barrier: the job chat (`hydrateJobChat`), then `freshRecords`, after a pending own
     * write is written (its chat event, or this barrier's, carries it). Returns their receipts, the
     * job chat's first (synchronously: each receipt names the copy sent, or the job chat's last copy
     * a socket took when nothing was sent).
     * `server/src/jobs/channel.ts` calls it when building callback events, replays included.
     */
    function hydrateAll(job: Job): HydrationReceipt[] {
        job.pendingFlush?.();
        const chat = hydrateJobChat(job);
        const events = freshRecords(job);
        for (const event of events) {
            send(job, event);
        }
        const receipts = events.map(receiptOf);
        return chat ? [chat, ...receipts] : receipts;
    }

    /**
     * The job chat's part of the callback barrier, as its receipt; null when the chat is gone.
     *
     * When every attached socket advertised `hydration=patch` and a socket took a copy (`sentChat`), the
     * chat goes only as it changed since that copy: nothing while the stored revision is still its
     * revision (the receipt names it), else a `chatPatch` from it, or the chat whole when no patch can
     * express the change. Such a tab reads the chat itself when it does not hold the receipt. Without
     * an owner socket, or for a socket that did not advertise it (an older tab, which can only apply
     * a remembered whole copy again once its local work settled: a patch cannot be applied that
     * late), the chat goes whole.
     * The revision is read once and reused for the patch event. Skipping relies on streaming locks
     * and watermarks staying fixed at that revision: checkpoint watermarks move only when applied;
     * releaseRemovedReplies is followed by the end or the next part's writes before its callbacks.
     */
    function hydrateJobChat(job: Job): HydrationReceipt | null {
        const base = job.sentChat;
        const sockets = allSockets(job);
        if (!base || sockets.length === 0 || !sockets.every((ws) => patchHydration.has(ws))) {
            const event = deliverJobChat(job, "whole");
            return event ? receiptOf(event) : null;
        }
        const { characterId, chatId } = job.context;
        const revision = readChatRevision(job, characterId, chatId);
        if (revision === null) {
            return null;
        }
        if (revision === base.revision) {
            return { kind: "chats", id: chatId, characterId, revision };
        }
        const event = deliverJobChat(job, "patch", revision);
        return event ? receiptOf(event) : null;
    }

    function assertLive(job: Job) {
        if (job.ended) {
            throw new GenerationJobEndedError();
        }
    }

    /**
     * Ends a job once. The first abort decides the outcome (a runner's `done` after it is an abort
     * error). A terminal that cannot be serialized becomes an error. The lifetime always ends:
     * `finished` resolves whatever delivery does.
     */
    function finalize(job: Job, requested: TerminalInput) {
        if (job.ended) {
            return;
        }
        job.skippedRecipient = ownerAttached(job) ? job.ownerClientId : job.clientId;
        // Before anything dies: the channel's requests settle `aborted` and the owner gets their `cancel`.
        try {
            job.channelLink.close("The job has ended");
        } catch (error) {
            logEvent("generation.channelClose", { job: job.id }, error, diagnostics);
        }
        let terminal: GenerationTerminalEvent = {
            ...(job.abortReason ? abortTerminal(job.abortReason) : requested),
            epoch: job.epoch,
        };
        if (terminal.type === "error" && job.sequence) {
            terminal.sequence = { ...job.sequence };
        }
        try {
            // Freeze the wire value once: role projections must not rerun a result's toJSON
            // or getters independently and strand later sockets after an earlier send.
            terminal = JSON.parse(JSON.stringify(terminal)) as GenerationTerminalEvent;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            terminal = {
                ...errorTerminal(new Error(`The job's result could not be sent: ${reason}`)),
                epoch: job.epoch,
                ...(job.sequence ? { sequence: { ...job.sequence } } : {}),
            };
            JSON.stringify(terminal);
        }
        job.ended = true;
        clearHandoff(job);
        job.stage = null;
        job.endedAt = clock();
        job.terminal = terminal as GenerationTerminalEvent;
        job.memoryControl = null;
        try {
            if (receipts) {
                receipts.end(job.id, job.endedAt, keptStatus(job, projectTerminal(job.terminal, job, job.clientId)));
            }
        } catch (error) {
            // Even building a receipt must never strand the job's locks, slot, or finished promise.
            logEvent("generation.endDelivery", { job: job.id }, error, diagnostics);
        }
        record({
            kind: "job",
            phase: terminal.type === "error" ? "error" : "done",
            jobId: job.id,
            jobKind: job.kind,
            durationMs: job.endedAt - job.startedAt,
            ...(terminal.type === "error"
                ? {
                      reason: terminal.reason,
                      ...(job.stoppedBy && job.stoppedBy !== job.clientId ? { stoppedBy: "otherClient" } : {}),
                      status: terminal.status,
                      stage: terminal.stage,
                      requestId: terminal.requestId,
                      providerCode: terminal.providerCode,
                  }
                : {}),
        });
        if (terminal.type === "error" && terminal.reason !== "aborted") {
            logEvent("generation.failed", {
                job: job.id,
                kind: job.kind,
                reason: terminal.reason,
                status: terminal.status,
                stage: terminal.stage,
                request: terminal.requestId,
                providerCode: terminal.providerCode,
            });
        }
        if (job.abortTimer) {
            clearTimeout(job.abortTimer);
            job.abortTimer = null;
        }
        try {
            lock.endJob(job.token);
            store.dropRerollAttempts(job.token);
            try {
                // Every chat the job ever locked, with its locks now: a final write normally published
                // the same already; this covers a release that write could not publish and a job that
                // ended without a final write.
                store.publishStreaming(
                    [...job.lockChats.values()].map(({ characterId, chatId }) => chatStreaming(characterId, chatId)),
                );
            } catch (error) {
                logEvent("generation.endDelivery", { job: job.id }, error, diagnostics);
            }
            const key = chatKey(job.context.characterId, job.context.chatId);
            if (chatSlots.get(key) === job.id) {
                chatSlots.delete(key);
            }
            job.listeners.clear();
            sendChat(job);
            for (const ws of allSockets(job)) {
                sendSocket(job, ws, JSON.stringify(projectTerminal(terminal, job, socketClients.get(ws))));
            }
        } catch (error) {
            logEvent("generation.endDelivery", { job: job.id }, error, diagnostics);
        } finally {
            // An attach after the end gets the chat whole: neither baseline is needed any more.
            job.sentChat = null;
            job.workingChat = null;
            job.resolveFinished();
        }
        if (
            terminal.type === "done" &&
            (job.kind === "send" ||
                job.kind === "continue" ||
                job.kind === "reroll" ||
                job.kind === "group" ||
                (job.kind === "command" && terminal.sequence && job.sequenceAttempted))
        ) {
            try {
                options.onChatJobDone?.(job.context.characterId, job.context.chatId, job.kind);
            } catch (error) {
                logEvent("checkpoint.auto", { job: job.id, kind: job.kind }, error, diagnostics);
            }
        }
    }

    function abortTerminal(reason: GenerationErrorReason): TerminalInput {
        return { type: "error", reason, ...abortMessages[reason] };
    }

    /**
     * Copies markFailure/failureOf metadata into the failed terminal, admitting only checked
     * stages, request ids, provider codes and error codes. It does not infer a stage: the nearest
     * marking site, or `server/src/prompt/runner.ts` runPromptSend's current-stage fallback, owns it.
     */
    function errorTerminal(error: unknown): TerminalInput {
        const status =
            error instanceof GenerationRunnerError && error.status >= 400 && error.status <= 599 ? error.status : 500;
        // Only checked values: the event's failure fields are content-free.
        const failure = failureOf(error);
        return {
            type: "error",
            reason: "failed",
            status,
            message: error instanceof Error ? error.message : String(error),
            ...(failure.stage && GENERATION_ERROR_STAGES.includes(failure.stage) ? { stage: failure.stage } : {}),
            ...(typeof failure.requestId === "string" && GENERATION_ID_PATTERN.test(failure.requestId)
                ? { requestId: failure.requestId }
                : {}),
            ...(isProviderCode(failure.providerCode) ? { providerCode: failure.providerCode } : {}),
            ...(failure.code !== undefined && GENERATION_ERROR_CODES.includes(failure.code)
                ? { code: failure.code }
                : {}),
        };
    }

    function abort(job: Job, reason: GenerationErrorReason): boolean {
        if (job.ended || job.abortReason) {
            return false;
        }
        job.abortReason = reason;
        clearHandoff(job);
        // One deadline per job, set before the signal's listeners run (one may end the job at once);
        // later aborts do not extend it.
        job.abortTimer = setTimeout(() => finalize(job, abortTerminal(reason)), abortGraceMs);
        try {
            // A runner waiting on a question or callback gets `aborted` now, not at the deadline.
            job.channelLink.close(abortMessages[reason].message);
            job.controller.abort(reason);
        } finally {
            if (job.ended && job.abortTimer) {
                clearTimeout(job.abortTimer);
                job.abortTimer = null;
            }
        }
        return true;
    }

    function writeAsJob(
        job: Job,
        build: () => JobChanges,
        covers: readonly { messageId: string; generationId: string; seq: number }[] = [],
        rerollAttempt?: RerollAttemptWrite,
    ): JobWriteResult {
        for (let attempt = 0; ; attempt += 1) {
            assertLive(job);
            gate.assertOpen();
            const changes = build();
            // Every acquisition in op order with what it replaced, undone in reverse on failure.
            const acquired: { ref: MessageRef; previous: MessageOwner | null }[] = [];
            // This attempt's own chat changes, as the store hands them to `committed`.
            let ownChanges: WrittenChanges | undefined;
            try {
                for (const group of changes.chats ?? []) {
                    for (const op of group.ops) {
                        if (op.op === "begin") {
                            const ref = { characterId: group.characterId, chatId: group.chatId, messageId: op.id };
                            if (job.retired.has(retiredKey(ref, op.generationId))) {
                                // A replay of a generation this job already released: the store keeps
                                // the message as it is, so the lock must not come back either.
                                continue;
                            }
                            const owner = { jobId: job.id, generationId: op.generationId, token: job.token };
                            acquired.push({ ref, previous: lock.acquire(ref, owner) });
                            job.lockChats.set(chatKey(group.characterId, group.chatId), {
                                characterId: group.characterId,
                                chatId: group.chatId,
                            });
                        }
                    }
                }
                const applied = store.applyChanges(changes, {
                    epoch: job.epoch,
                    jobToken: job.token,
                    rerollAttempt,
                    changes: true,
                    // After the commit and before the change is published, so the published locks
                    // already show a final write's release and a `begin`'s new owner.
                    committed: (result, changesWritten) => {
                        ownChanges = changesWritten;
                        (changes.chats ?? []).forEach((group, index) => {
                            const outcomes = result.chats[index]?.checkpoints ?? [];
                            let checkpoint = 0;
                            if (group.characterId === job.context.characterId && group.chatId === job.context.chatId) {
                                // The working baseline follows the chat only through a change that
                                // starts at its revision (the stored base, also for a stale group).
                                const change = changesWritten?.chats[index];
                                const working = job.workingChat;
                                job.workingChat =
                                    working && change && change.baseRevision === working.revision
                                        ? advanceChatBaseline(working, change)
                                        : null;
                                for (const op of group.ops) {
                                    if (op.op === "begin") {
                                        // The client's copy of it can hold streamed text: patches carry its row.
                                        job.generated.add(op.id);
                                    }
                                }
                            }
                            for (const op of group.ops) {
                                if ((op.op === "setText" || op.op === "setMessage") && op.generation) {
                                    const outcome = outcomes[checkpoint];
                                    checkpoint += 1;
                                    const written = op.op === "setText" ? op.id : op.message.chatId!;
                                    const cover = covers.find(
                                        (entry) =>
                                            entry.messageId === written && entry.generationId === op.generation!.id,
                                    );
                                    if (outcome === "applied") {
                                        // The stored text is this write's: its claim (none: 0) replaces the last.
                                        job.watermarks.set(written, {
                                            generationId: op.generation.id,
                                            seq: cover?.seq ?? 0,
                                        });
                                    }
                                    if (
                                        op.generation.final &&
                                        outcome === "applied" &&
                                        job.current?.messageId === written &&
                                        job.current.generationId === op.generation.id
                                    ) {
                                        // That reply is final: a reconnect gets it from the chat, not the stream.
                                        job.current = null;
                                    }
                                    if (op.generation.final && outcome === "applied") {
                                        // Only the generation that owns the message now: a `begin` later in
                                        // the same write keeps its new generation locked.
                                        const messageId = op.op === "setText" ? op.id : op.message.chatId!;
                                        const ref = { characterId: group.characterId, chatId: group.chatId, messageId };
                                        lock.release(ref, job.token, op.generation.id);
                                        job.retired.add(retiredKey(ref, op.generation.id));
                                    }
                                }
                            }
                        });
                        const chats = new Map(
                            (changes.chats ?? []).map((group) => [
                                chatKey(group.characterId, group.chatId),
                                chatStreaming(group.characterId, group.chatId),
                            ]),
                        );
                        return [...chats.values()];
                    },
                });
                return ownChanges ? { ...applied, written: ownChanges } : applied;
            } catch (error) {
                if (error instanceof CommittedWriteError) {
                    // The write is in the store and was published: nothing to restore or retry.
                    throw error;
                }
                for (const { ref, previous } of acquired.reverse()) {
                    lock.restore(ref, previous);
                }
                if (error instanceof ResourceBatchConflictError) {
                    const resourceOnly = error.conflicts.every(
                        (conflict) =>
                            conflict.kind !== "chat" &&
                            conflict.kind !== "chatOrder" &&
                            !("reason" in conflict && conflict.reason),
                    );
                    if (resourceOnly && attempt === 0) {
                        continue;
                    }
                    throw new JobWriteConflictError(error.conflicts);
                }
                throw error;
            }
        }
    }

    function runningJob(job: Job): RunningJob {
        return {
            id: job.id,
            kind: job.kind,
            context: job.context,
            command: job.command,
            hooks: job.hooks,
            channel: job.channelLink.channel,
            ownerAttached: () => ownerAttached(job),
            epoch: job.epoch,
            signal: job.controller.signal,
            emit(input) {
                job.pendingFlush?.();
                assertLive(job);
                if (input.type === "done" || input.type === "error") {
                    finalize(job, input);
                    return;
                }
                if (input.type === "resource" && HIDDEN_HYDRATION_KINDS.includes(input.kind)) {
                    throw new Error(`${input.kind} records are never sent to the client`);
                }
                const event = { ...input, epoch: job.epoch };
                switch (event.type) {
                    case "accepted":
                        // The reply (and the user message) must exist in the client's mirror first.
                        sendChat(job);
                        // Always sequenced, so the client orders it against chunks.
                        event.seq ??= 0;
                        job.current = { ...event };
                        break;
                    case "chunk": {
                        // Only the current reply's generation, in order: an older or foreign chunk is dropped.
                        if (
                            !job.current ||
                            job.current.messageId !== event.messageId ||
                            job.current.generationId !== event.generationId ||
                            event.seq <= (job.current.seq ?? 0)
                        ) {
                            return;
                        }
                        const previous = job.current.text;
                        let keep = previous.length;
                        if (!event.text.startsWith(previous)) {
                            keep = 0;
                            while (
                                keep < previous.length &&
                                keep < event.text.length &&
                                previous[keep] === event.text[keep]
                            ) {
                                keep += 1;
                            }
                        }
                        const chunk: GenerationChunkEvent = {
                            ...event,
                            base: job.current.seq ?? 0,
                            keep,
                            text: event.text.slice(keep),
                        };
                        job.current.text = event.text;
                        job.current.seq = event.seq;
                        send(job, chunk);
                        return;
                    }
                    case "preset":
                        job.preset = event;
                        break;
                    case "stage":
                        if (event.stage === job.stage) {
                            return;
                        }
                        job.stage = event.stage;
                        break;
                    case "resource":
                        track(
                            job,
                            event.kind === "chats"
                                ? `chats\u0000${event.characterId}\u0000${event.id}`
                                : `${event.kind}\u0000${event.id}`,
                            { kind: event.kind, id: event.id, characterId: event.characterId },
                        );
                        break;
                }
                send(job, event);
            },
            emitRecords(records) {
                job.pendingFlush?.();
                assertLive(job);
                const receipts: HydrationReceipt[] = [];
                for (const ref of records.refs ?? []) {
                    const event = recordEvent(job, ref.kind, ref.id);
                    track(job, `${ref.kind}\u0000${ref.id}`, ref);
                    if (event) {
                        send(job, event);
                        receipts.push(receiptOf(event));
                    }
                }
                for (const ref of records.chats ?? []) {
                    track(job, `chats\u0000${ref.characterId}\u0000${ref.id}`, { kind: "chats", ...ref });
                    if (ref.characterId === job.context.characterId && ref.id === job.context.chatId) {
                        // Nothing is buffered here. Leave sentChat alone: the working baseline keeps
                        // following the job's own writes, so the next attach's patch carries this one.
                        expireSilentOwners(job);
                        if (!allSockets(job).some((ws) => ws.readyState === ws.OPEN)) {
                            continue;
                        }
                        // The job chat: what changed since the last copy a socket took.
                        const event = deliverJobChat(job, "patch");
                        if (event) {
                            receipts.push(receiptOf(event));
                        }
                        continue;
                    }
                    const event = chatEvent(job, ref.characterId, ref.id);
                    if (event) {
                        send(job, event);
                        receipts.push(receiptOf(event));
                    }
                }
                return receipts;
            },
            write: (build, options) => {
                try {
                    // Before build/applyChanges: never flush inside another write's transaction.
                    job.pendingFlush?.();
                    return writeAsJob(job, build, options?.covers, options?.rerollAttempt);
                } catch (error) {
                    // Every job write fails here: a conflict, a refused write, a storage failure.
                    throw markFailure(error, { stage: "persist" });
                }
            },
            assertWritable() {
                assertLive(job);
                gate.assertOpen();
            },
            sequence: {
                beginPart() {
                    if (job.ended || job.controller.signal.aborted) return { ok: false };
                    if (clock() - job.deadlineFrom >= JOB_MAX_DURATION_MS) {
                        abort(job, "timeout");
                        return { ok: false };
                    }
                    if (closed) return { ok: false, stopped: "shutdown" };
                    if (maintenancePending > 0 || gate.active) return { ok: false, stopped: "maintenance" };
                    if (job.epoch !== store.epoch()) return { ok: false, stopped: "EpochMismatch" };
                    const { characterId, chatId } = job.context;
                    const binding = readChatBindingState(store, kinds, { characterId, chatId });
                    if (!binding.chat) return { ok: false, stopped: "chatNotFound" };
                    const refusal = checkChatBinding(binding.chat, binding.lookup, job.context, "send");
                    if (refusal) return { ok: false, stopped: refusal.error };
                    if (readOrphanedOverrideEntries(store, kinds, { characterId, chatId }).length > 0) {
                        return { ok: false, stopped: "chatLoreOverrideOrphaned" };
                    }
                    job.deadlineFrom = clock();
                    job.sequenceAttempted = true;
                    job.targets.presetId = job.context.presetId ?? "";
                    job.preset = null;
                    return { ok: true };
                },
                progress(value) {
                    assertLive(job);
                    job.sequence = { total: value.total, sent: value.sent };
                    try {
                        receipts?.progress(job.id, job.sequence);
                    } catch (error) {
                        logEvent("generation.endDelivery", { job: job.id }, error, diagnostics);
                    }
                },
                releaseRemovedReplies() {
                    assertLive(job);
                    const chats = new Map<
                        string,
                        { characterId: string; chatId: string; ids: Set<string | undefined> }
                    >();
                    for (const ref of lock.ownedBy(job.token)) {
                        const key = chatKey(ref.characterId, ref.chatId);
                        let chat = chats.get(key);
                        if (!chat) {
                            const stored = store.readChatSource(ref.characterId, ref.chatId);
                            chat = {
                                characterId: ref.characterId,
                                chatId: ref.chatId,
                                ids: new Set(
                                    (stored.data as Chat | null)?.message.map((message) => message.chatId) ?? [],
                                ),
                            };
                            chats.set(key, chat);
                        }
                        if (!chat.ids.has(ref.messageId)) {
                            lock.release(ref, job.token, ref.generationId);
                            store.dropRerollAttempts(job.token);
                            job.retired.add(retiredKey(ref, ref.generationId));
                            if (
                                job.current?.messageId === ref.messageId &&
                                job.current.generationId === ref.generationId
                            ) {
                                job.current = null;
                            }
                        }
                    }
                    store.publishStreaming(
                        [...chats.values()].map(({ characterId, chatId }) => chatStreaming(characterId, chatId)),
                    );
                },
            },
            setCallbackPreset(presetId) {
                job.targets.presetId = presetId;
            },
            setPendingFlush(flush) {
                job.pendingFlush = flush;
            },
            registerMemoryControl(runId) {
                assertLive(job);
                const control = { runId, stopRequested: false };
                job.memoryControl = control;
                return {
                    stopRequested: () => control.stopRequested,
                    release: () => {
                        if (job.memoryControl === control) {
                            job.memoryControl = null;
                        }
                    },
                };
            },
            onClientMessage(listener) {
                assertLive(job);
                job.listeners.add(listener);
                return () => {
                    job.listeners.delete(listener);
                };
            },
        };
    }

    function start(job: Job) {
        // Not tracked itself: `stop` waits for `finished`, which the abort deadline bounds even for
        // a runner that ignores its signal.
        const run = Promise.resolve().then(() => runner(runningJob(job)));
        run.then(
            () =>
                finalize(job, {
                    type: "error",
                    reason: "failed",
                    status: 500,
                    message: "The job ended without a result",
                }),
            (error) => finalize(job, errorTerminal(error)),
        ).catch((error) => logEvent("generation.runnerSettle", { job: job.id }, error, diagnostics));
    }

    /** The chat as stored now, as a patch base (null when it cannot be read). */
    function admittedChat(characterId: string, chatId: string): ChatBaseline | null {
        const chat = store.readRefs([], { chats: [{ characterId, id: chatId }] }).chats[0];
        return chat && chat.revision !== null ? chatBaseline(chat.revision, chat.data as Chat) : null;
    }

    /**
     * Epoch first, then synchronize identity maps/receipts and look up requestId before shutdown,
     * maintenance/gate, hooks, chat existence, occupied slot, rebuild lock, revision, binding and
     * orphaned overrides. Matching identity replays the original job/status even if those later
     * gates would now refuse; another fingerprint is requestIdReused, a tombstone requestCancelled.
     * No requestId admits normally without deduplication; its epoch still precedes the gates.
     * Lookup through slot and request-index installation is synchronous, with the runner deferred
     * to a later microtask: identical simultaneous requests admit once. Refusals install no identity.
     */
    function create(body: GenerationCreateBody, epoch: string | undefined): CreateResult {
        if (epoch !== store.epoch()) {
            return { ok: false, status: 412, body: { error: "EpochMismatch", epoch: store.epoch() } };
        }
        keptOutcomes();
        const fingerprint = body.requestId ? requestFingerprint(body) : null;
        const identity = body.requestId ? lookupRequest(body.requestId) : null;
        if (identity?.cancelled) {
            return { ok: false, status: 409, body: { error: "requestCancelled" } };
        }
        if (identity) {
            if (identity.fingerprint !== fingerprint) {
                return { ok: false, status: 409, body: { error: "requestIdReused" } };
            }
            const owned = identity.clientId === body.clientId;
            return {
                ok: true,
                jobId: identity.jobId,
                replayed: true,
                owned,
                status: replayStatus(identity, body.clientId),
            };
        }
        if (closed || maintenancePending > 0 || gate.active) {
            return { ok: false, status: 503, body: { error: "The server is not accepting generations now" } };
        }
        const hooks = parseGenerationHooks(body.hooks);
        if (typeof hooks === "string") {
            return { ok: false, status: 400, body: { error: hooks } };
        }
        const { characterId, chatId } = body.context;
        const revision = store.chatRevision(characterId, chatId);
        if (revision === null) {
            return { ok: false, status: 404, body: { error: "Chat not found" } };
        }
        const busy = chatSlots.get(chatKey(characterId, chatId));
        if (busy) {
            return { ok: false, status: 409, body: { error: "chatBusy", jobId: busy } };
        }
        if (rebuildLocks(body) && store.memory.rebuild.rebuilding(characterId, chatId)) {
            return { ok: false, status: 409, body: { error: REBUILD_LOCK_TEXT } };
        }
        if (revision !== body.context.chatRevision) {
            return { ok: false, status: 409, body: { error: "stale" } };
        }
        // The job runs on its chat's binding or not at all, whatever its kind (a preview too):
        // `targets` below is then the binding. `loadJobScope` checks it again.
        const binding = readChatBindingState(store, kinds, { characterId, chatId });
        const refusal = binding.chat && checkChatBinding(binding.chat, binding.lookup, body.context, "send");
        if (refusal) {
            return { ok: false, status: 409, body: refusal };
        }
        const entries = readOrphanedOverrideEntries(store, kinds, { characterId, chatId });
        if (entries.length > 0) {
            return { ok: false, status: 409, body: { error: "chatLoreOverrideOrphaned", entries } };
        }
        let resolveFinished!: () => void;
        const finished = new Promise<void>((resolve) => {
            resolveFinished = resolve;
        });
        const startedAt = clock();
        // The chat at the revision the owner named (checked above): the first patch's base, and
        // the state the job's own writes advance from.
        const admitted = admittedChat(characterId, chatId);
        const job: Job = {
            id: randomUUID(),
            clientId: body.clientId,
            ownerClientId: body.clientId,
            requestId: body.requestId,
            fingerprint,
            kind: body.kind,
            context: structuredClone(body.context),
            command: body.command ? structuredClone(body.command) : null,
            hooks,
            channelLink: null as unknown as Job["channelLink"],
            epoch: store.epoch(),
            token: randomUUID(),
            controller: new AbortController(),
            abortReason: null,
            abortTimer: null,
            startedAt,
            deadlineFrom: startedAt,
            sequenceAttempted: false,
            ended: false,
            endedAt: 0,
            sockets: new Set(),
            viewers: new Set(),
            offer: null,
            offerTimer: null,
            ticket: null,
            pendingTakeover: null,
            switchTimer: null,
            ownerAbsentSince: startedAt,
            current: null,
            watermarks: new Map(),
            retired: new Set(),
            attachStamps: new Map(),
            preset: null,
            stage: null,
            targets: {
                chatRef: { chaId: characterId, chatId },
                presetId: body.context.presetId ?? "",
                modelPresetId: body.context.modelPresetId ?? "",
                personaId: body.context.personaId ?? "",
            },
            refs: new Map(),
            sentChat: admitted,
            workingChat: admitted,
            generated: new Set(),
            lockChats: new Map(),
            terminal: null,
            memoryControl: null,
            listeners: new Set(),
            finished,
            resolveFinished,
        };
        job.channelLink = hub.open({
            jobId: job.id,
            clientId: job.clientId,
            epoch: job.epoch,
            targets: job.targets,
            hooks,
            flushPending: () => job.pendingFlush?.(),
            noticeAudience: (notice) => noticeAudience[notice.kind],
            beforeEnqueue: () => {
                switchOwner(job);
            },
            onSettled: () => scheduleSwitch(job),
            send: (event) => {
                job.pendingFlush?.();
                return !job.ended && send(job, event);
            },
            hydrate: () => hydrateAll(job),
            ownerAttached: () => ownerAttached(job),
            ownerAbsentDeadline: () => {
                expireSilentOwners(job);
                return job.ownerAbsentSince === null ? Infinity : job.ownerAbsentSince + ownerAbsentMs;
            },
        });
        try {
            snapshots.track(() => finished);
        } catch {
            return { ok: false, status: 503, body: { error: "The server is shutting down" } };
        }
        lock.addToken(job.token);
        jobs.set(job.id, job);
        chatSlots.set(chatKey(characterId, chatId), job.id);
        if (job.requestId) requestJobs.set(job.requestId, job.id);
        receipts?.admit({
            jobId: job.id,
            clientId: job.clientId,
            epoch: job.epoch,
            kind: job.kind,
            characterId,
            chatId,
            admittedAt: job.startedAt,
            requestId: job.requestId,
            fingerprint: job.fingerprint,
        });
        record({ kind: "job", phase: "accepted", jobId: job.id, jobKind: job.kind });
        if (body.handoff === "prefer") openOffer(job, "preferred");
        armOffer(job);
        start(job);
        return { ok: true, jobId: job.id };
    }

    function participantJob(jobId: string, clientId: string | undefined): Job | null {
        const job = jobs.get(jobId);
        return job && (job.clientId === clientId || job.ownerClientId === clientId) ? job : null;
    }

    function currentJob(characterId: string, chatId: string): Job | null {
        const id = chatSlots.get(chatKey(characterId, chatId));
        const job = id ? jobs.get(id) : undefined;
        return job && !job.ended ? job : null;
    }

    /**
     * Read-only slot lookup covering every kind, even a command before it acquires a generation
     * lock. clientId only computes owned; no attachment, ownership change or callback authority.
     */
    function current(characterId: string, chatId: string, clientId: string | undefined): GenerationCurrent | null {
        const job = currentJob(characterId, chatId);
        return job
            ? {
                  jobId: job.id,
                  kind: job.kind,
                  owned: job.clientId === clientId,
                  ...(job.ownerClientId !== job.clientId ? { handedOff: true as const } : {}),
                  ...(job.stage ? { stage: job.stage } : {}),
                  ...(job.sequence ? { sequence: { ...job.sequence } } : {}),
              }
            : null;
    }

    /**
     * Checks the epoch, compares the confirmed job id with the current slot and aborts synchronously:
     * a replacement is never stopped. After jobChanged, look up and confirm the replacement again.
     * First abort wins: its stopping client is frozen for participant-relative abortedBy: "other"
     * projection and creator-relative stoppedBy: "otherClient" diagnostics. Request-id cancel
     * remains unattributed. The abort ends the whole sequence, whose progress and attribution
     * survive in kept outcomes.
     */
    function stop(
        body: GenerationStopBody,
        epoch: string | undefined,
    ):
        | { ok: true; body: { aborted: boolean } }
        | { ok: false; status: 404 | 409 | 412; body: Record<string, unknown> } {
        if (epoch !== store.epoch()) {
            return { ok: false, status: 412, body: { error: "EpochMismatch", epoch: store.epoch() } };
        }
        const job = currentJob(body.characterId, body.chatId);
        if (!job) return { ok: false, status: 404, body: { error: "idle" } };
        if (job.id !== body.jobId) return { ok: false, status: 409, body: { error: "jobChanged" } };
        // Signal listeners can finalize synchronously; only the first abort decides attribution.
        if (!job.abortReason) job.stoppedBy = body.clientId;
        return { ok: true, body: { aborted: abort(job, "aborted") } };
    }

    /** The kept outcomes, cleared first when the epoch changed (a restore or import replaced the data). */
    function keptOutcomes(): typeof kept {
        const epoch = store.epoch();
        if (epoch !== keptEpoch) {
            for (const job of jobs.values()) if (job.epoch !== epoch) clearHandoff(job);
            kept.clear();
            requestJobs.clear();
            cancelledRequests.clear();
            keptEpoch = epoch;
            receipts?.sync(epoch);
        }
        return kept;
    }

    /** Drops the oldest cancellation tombstones past the time or count limit. */
    function expireCancelled(now: number) {
        for (const [id, at] of cancelledRequests) {
            if (now - at < GENERATION_RECEIPT_MS && cancelledRequests.size <= MAX_GENERATION_RECEIPTS) break;
            cancelledRequests.delete(id);
        }
    }

    /**
     * Current-epoch lookup order: live jobs (ended jobs in grace included), kept outcomes,
     * cancellation tombstones, then disk. Kept memory drops identity and payload together at the
     * MAX_KEPT_OUTCOMES cap or after KEPT_OUTCOME_MS. Only a retained disk receipt from a healthy
     * receipts store can return identity after payload pruning (status: null). create compares the
     * fingerprint before considering ordinary admission refusals.
     */
    function lookupRequest(requestId: string): RequestIdentity | null {
        expireOutcomes(clock());
        expireCancelled(clock());
        const jobId = requestJobs.get(requestId);
        const job = jobId ? jobs.get(jobId) : undefined;
        if (job && job.epoch === keptEpoch) {
            return {
                cancelled: false,
                jobId: job.id,
                clientId: job.clientId,
                fingerprint: job.fingerprint,
                ownerClientId: job.ownerClientId,
                skippedRecipient: job.skippedRecipient,
                stoppedBy: job.stoppedBy,
                status: status(job),
            };
        }
        for (const [id, outcome] of kept) {
            if (outcome.requestId === requestId) {
                return { cancelled: false, jobId: id, ...outcome };
            }
        }
        if (cancelledRequests.has(requestId)) return { cancelled: true };
        return receipts?.readByRequest(requestId) ?? null;
    }

    /**
     * Idempotent across ownership: aborts a running request, leaves an ended one intact, or installs
     * an unknown request's tombstone in memory before its best-effort disk write. Repeated cancel
     * keeps the first timestamp. An abort acknowledgement is not a terminal: the runner retains its
     * abort grace to save and end. Epoch-checked, but available during maintenance and shutdown;
     * never targets another job that later took the same chat slot.
     */
    function cancel(
        body: GenerationCancelBody,
        epoch: string | undefined,
    ): { ok: true; body: GenerationCancelled } | { ok: false; status: 412; body: Record<string, unknown> } {
        if (epoch !== store.epoch()) {
            return { ok: false, status: 412, body: { error: "EpochMismatch", epoch: store.epoch() } };
        }
        keptOutcomes();
        const identity = lookupRequest(body.requestId);
        if (identity && !identity.cancelled) {
            const job = jobs.get(identity.jobId);
            const running = job && job.epoch === keptEpoch && !job.ended;
            if (running) abort(job, "aborted");
            const owned = identity.clientId === body.clientId;
            return {
                ok: true,
                body: {
                    state: running ? "aborted" : "ended",
                    jobId: identity.jobId,
                    owned,
                    status: replayStatus(identity, body.clientId),
                },
            };
        }
        if (!identity) {
            const at = clock();
            cancelledRequests.set(body.requestId, at);
            expireCancelled(at);
            receipts?.cancel(body.requestId, body.clientId, at);
        }
        return { ok: true, body: { state: "cancelled" } };
    }

    /** Keeps a collected job's outcome; a job of an older epoch keeps none. */
    function keepOutcome(job: Job, now: number) {
        const outcomes = keptOutcomes();
        if (!job.terminal || job.epoch !== keptEpoch) {
            return;
        }
        outcomes.delete(job.id);
        outcomes.set(job.id, {
            clientId: job.clientId,
            ownerClientId: job.ownerClientId,
            skippedRecipient: job.skippedRecipient,
            stoppedBy: job.stoppedBy,
            keptAt: now,
            requestId: job.requestId,
            fingerprint: job.fingerprint,
            status: keptStatus(job, job.terminal),
        });
        for (const id of outcomes.keys()) {
            if (outcomes.size <= MAX_KEPT_OUTCOMES) {
                break;
            }
            outcomes.delete(id);
        }
    }

    function expireOutcomes(now: number) {
        for (const [id, outcome] of keptOutcomes()) {
            if (now - outcome.keptAt < KEPT_OUTCOME_MS) {
                break;
            }
            kept.delete(id);
        }
    }

    function status(job: Job): GenerationStatus {
        return {
            jobId: job.id,
            kind: job.kind,
            characterId: job.context.characterId,
            chatId: job.context.chatId,
            epoch: job.epoch,
            state: job.ended ? "ended" : "running",
            ...(job.ownerClientId !== job.clientId ? { handedOff: true as const } : {}),
            ...(job.current?.messageId ? { messageId: job.current.messageId } : {}),
            ...(job.current?.generationId ? { generationId: job.current.generationId } : {}),
            ...(job.terminal ? { terminal: job.terminal } : {}),
        };
    }

    /**
     * Every attach begins with its role and a chat copy shared by all sockets, keeping one baseline.
     * Ordinary reconnects replace only this client's sockets. Only an owner attach clears absence
     * and replays requests; a ticket attaches as a pending viewer until a safe boundary promotes it.
     * Viewers accept only chat/reply resync; pings reach them but their silence does not affect work.
     */
    function attach(
        job: Job,
        ws: WebSocket,
        clientId: string,
        negotiated: boolean,
        hydratesByPatch: boolean,
        viewer: boolean,
        ticket: Job["ticket"],
    ) {
        const deliveredBeforeExpiry = job.channelLink.hasDeliveredRequests();
        expireSilentOwners(job);
        job.channelLink.expireOverdue();
        if (ticket) {
            if (ticket.timer) clearTimeout(ticket.timer);
            job.ticket = null;
            job.pendingTakeover = { clientId, ws, offer: ticket.offer };
            job.channelLink.deferTransfer(true);
        }
        for (const old of allSockets(job)) {
            if (socketClients.get(old) !== clientId) continue;
            removeOwner(job, old, clock());
            job.viewers.delete(old);
            old.close(4001, "Superseded by a newer connection");
        }
        socketClients.set(ws, clientId);
        if (negotiated) liveness.set(ws, { lastFrameAt: clock(), timer: null });
        if (hydratesByPatch) patchHydration.add(ws);
        const owner = !ticket && !viewer && clientId === job.ownerClientId;
        (owner ? job.sockets : job.viewers).add(ws);
        if (owner) {
            job.ownerAbsentSince = null;
            armSilence(job, ws);
            if (job.offer?.reason === "absent") closeOffer(job);
            armOffer(job);
            job.channelLink.ownerChanged();
        }
        const snapshot = () => {
            const events: GenerationEvent[] = freshRecords(job);
            if (job.preset) events.push(job.preset);
            if (!job.ended && job.stage !== null) events.push({ type: "stage", epoch: job.epoch, stage: job.stage });
            const current = currentReply(job);
            if (current) events.push(current);
            for (const event of events) sendSocket(job, ws, JSON.stringify(event));
        };
        const switched = !!ticket && !deliveredBeforeExpiry && switchOwner(job, snapshot);
        if (ticket && !switched) scheduleSwitch(job);
        if (!switched) {
            sendSocket(job, ws, JSON.stringify(roleEvent(job, ws)));
            deliverJobChat(job, job.ended ? "whole" : "patch");
            snapshot();
            if (!job.ended && owner) {
                job.channelLink.handleAttach(attachedAudiences(job));
            } else {
                // A viewer must not replay the owner's requests or consume its dialog buffer.
                const audiences: NoticeAudience[] = attachedAudiences(job).filter((audience) => audience !== "owner");
                if (job.ended && owner) audiences.push("owner");
                for (const event of job.channelLink.takeEarly(audiences)) send(job, event);
            }
        }
        if (job.terminal) sendSocket(job, ws, JSON.stringify(projectTerminal(job.terminal, job, clientId)));
        const ping = setInterval(() => {
            expireSilentOwners(job);
            if (job.sockets.has(ws) || job.viewers.has(ws)) {
                sendSocket(job, ws, JSON.stringify({ type: "ping", ts: clock() }));
            }
        }, JOB_HEARTBEAT_MS);
        const frame = () => {
            expireSilentOwners(job);
            if (!job.sockets.has(ws)) return false;
            const live = liveness.get(ws);
            if (live) {
                live.lastFrameAt = clock();
                armSilence(job, ws);
            }
            return true;
        };
        ws.on("ping", frame);
        ws.on("pong", frame);
        ws.on("message", (data) => {
            const ownerFrame = frame();
            if (!ownerFrame && !job.viewers.has(ws)) return;
            let message: unknown;
            try {
                message = JSON.parse(String(data));
            } catch {
                return;
            }
            if (isReplyResyncRequest(message)) {
                if (!job.ended && job.current?.messageId) send(job, job.current);
                return;
            }
            if (isResyncRequest(message)) {
                if (!job.ended && deliverJobChat(job, "whole")) {
                    const current = currentReply(job);
                    if (current) send(job, current);
                }
                return;
            }
            if (!ownerFrame) return;
            job.channelLink.handleMessage(message);
            for (const listener of [...job.listeners]) {
                try {
                    listener(message);
                } catch (error) {
                    logEvent("generation.listener", { job: job.id }, error, diagnostics);
                }
            }
        });
        const drop = () => {
            clearInterval(ping);
            expireSilentOwners(job);
            removeOwner(job, ws, clock());
            job.viewers.delete(ws);
            if (job.pendingTakeover?.ws === ws) {
                const offer = job.pendingTakeover.offer;
                job.pendingTakeover = null;
                if (job.switchTimer) clearTimeout(job.switchTimer);
                job.switchTimer = null;
                job.channelLink.deferTransfer(false);
                reopenOffer(job, offer);
                sendRoles(job);
            }
        };
        ws.on("close", drop);
        ws.on("error", drop);
    }

    /**
     * JWT-protected job socket. A participant attaches with clientId and optional role=viewer;
     * a valid ticket authorizes its bound client instead. The creator cannot reclaim ownership
     * without a ticket. Attach stamps are compared within each client only (a lower one is 409).
     * liveness=1 negotiates owner silence; hydration=patch negotiates callback barrier patches.
     */
    function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
        let url: URL;
        try {
            url = new URL(req.url ?? "", "http://localhost");
        } catch {
            return false;
        }
        const match = socketPath.exec(url.pathname);
        if (!match) {
            return false;
        }
        void (async () => {
            try {
                const headerAuth = req.headers["risu-auth"];
                const token =
                    url.searchParams.get("risu-auth") || (Array.isArray(headerAuth) ? headerAuth[0] : headerAuth);
                if (!(await authorize(token))) {
                    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                    socket.destroy();
                    return;
                }
                const jobId = decodeURIComponent(match[1]);
                const clientId = url.searchParams.get("clientId") ?? undefined;
                const ticketValue = url.searchParams.get("ticket");
                const job = jobs.get(jobId);
                const refuse = (status: 404 | 409) => {
                    socket.write(`HTTP/1.1 ${status} ${status === 404 ? "Not Found" : "Conflict"}\r\n\r\n`);
                    socket.destroy();
                };
                if (!job || !clientId) {
                    refuse(404);
                    return;
                }
                expireTicket(job);
                const ticket =
                    ticketValue && job.ticket?.value === ticketValue && job.ticket.clientId === clientId
                        ? job.ticket
                        : null;
                if (ticketValue && (!canHandoff(job) || !ticket)) {
                    refuse(409);
                    return;
                }
                if (disposed || (!ticket && !participantJob(jobId, clientId))) {
                    refuse(404);
                    return;
                }
                const stamp = Number(url.searchParams.get("attach") ?? 0);
                const role = url.searchParams.get("role") ?? "owner";
                if (
                    !Number.isFinite(stamp) ||
                    stamp < (job.attachStamps.get(clientId) ?? -1) ||
                    socket.destroyed ||
                    (role !== "owner" && role !== "viewer")
                ) {
                    refuse(409);
                    return;
                }
                job.attachStamps.set(clientId, stamp);
                wsServer.handleUpgrade(req, socket, head, (ws) => {
                    if (
                        disposed ||
                        stamp < (job.attachStamps.get(clientId) ?? -1) ||
                        (ticket && (job.ticket !== ticket || !canHandoff(job) || clock() >= ticket.until))
                    ) {
                        ws.close();
                        return;
                    }
                    attach(
                        job,
                        ws,
                        clientId,
                        url.searchParams.get("liveness") === "1",
                        url.searchParams.get("hydration") === "patch",
                        role === "viewer",
                        ticket,
                    );
                });
            } catch {
                socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
                socket.destroy();
            }
        })();
        return true;
    }

    const runningJobs = () => [...jobs.values()].filter((job) => !job.ended);

    snapshots.onMaintenance(async () => {
        maintenancePending += 1;
        const running = runningJobs();
        for (const job of running) {
            abort(job, "maintenance");
        }
        await Promise.all(running.map((job) => job.finished));
        return () => {
            maintenancePending -= 1;
        };
    });

    type HandoffResult<T> =
        { ok: true; body: T } | { ok: false; status: 404 | 409 | 412; body: Record<string, unknown> };

    function handoff(
        jobId: string,
        body: GenerationHandoffBody,
        epoch: string | undefined,
    ): HandoffResult<{ offered: true }> {
        if (epoch !== store.epoch())
            return { ok: false, status: 412, body: { error: "EpochMismatch", epoch: store.epoch() } };
        const job = participantJob(jobId, body.clientId);
        if (!job || job.epoch !== store.epoch())
            return { ok: false, status: 404, body: { error: "Generation not found" } };
        // A ticket attach by the current owner would supersede its own callback-answering socket.
        if (body.target === job.ownerClientId) return { ok: false, status: 409, body: { error: "alreadyOwner" } };
        expireTicket(job);
        if (!canHandoff(job) || job.ticket || job.pendingTakeover)
            return { ok: false, status: 409, body: { error: "handoffUnavailable" } };
        openOffer(job, "requested", body.target);
        return { ok: true, body: { offered: true } };
    }

    function takeover(
        jobId: string,
        body: GenerationTakeoverBody,
        epoch: string | undefined,
    ): HandoffResult<GenerationTakeoverAnswer> {
        if (epoch !== store.epoch())
            return { ok: false, status: 412, body: { error: "EpochMismatch", epoch: store.epoch() } };
        const job = jobs.get(jobId);
        if (!job) {
            expireOutcomes(clock());
            const receipt = receipts?.read(jobId);
            if (kept.has(jobId) || (receipt && receipt.epoch === store.epoch())) {
                return { ok: false, status: 409, body: { error: "jobEnded" } };
            }
            return { ok: false, status: 404, body: { error: "Generation not found" } };
        }
        if (job.epoch !== store.epoch()) return { ok: false, status: 404, body: { error: "Generation not found" } };
        expireSilentOwners(job);
        expireTicket(job);
        armOffer(job);
        if (
            !canHandoff(job) ||
            !job.offer ||
            job.ticket ||
            job.pendingTakeover ||
            (job.offer.target && job.offer.target !== body.clientId)
        ) {
            return { ok: false, status: 409, body: { error: "handoffUnavailable" } };
        }
        const ticket: NonNullable<Job["ticket"]> = {
            value: randomUUID(),
            clientId: body.clientId,
            until: clock() + handoffTicketMs,
            offer: job.offer,
            timer: null,
        };
        job.ticket = ticket;
        closeOffer(job);
        const wake = () => {
            if (job.ticket !== ticket) return;
            expireTicket(job);
            if (job.ticket === ticket) {
                ticket.timer = setTimeout(wake, Math.max(1, ticket.until - clock()));
                ticket.timer.unref?.();
            }
        };
        ticket.timer = setTimeout(wake, Math.max(1, handoffTicketMs));
        ticket.timer.unref?.();
        return { ok: true, body: { ticket: ticket.value } };
    }

    return {
        create,
        handoff,
        takeover,
        handoffSnapshot(): HandoffOffer[] {
            keptOutcomes();
            for (const job of jobs.values()) {
                expireSilentOwners(job);
                expireTicket(job);
                armOffer(job);
            }
            return [...jobs.values()].flatMap((job) => (job.offer && canHandoff(job) ? [{ ...job.offer }] : []));
        },
        cancel,
        current,
        stop,

        /** The change feed's whole lock snapshot, with stored chat revisions sampled synchronously. */
        streamingSnapshot(): ChatStreamingSnapshot[] {
            return lock.ownedChats().map(({ characterId, chatId }) => ({
                ...chatStreaming(characterId, chatId),
                revision: store.chatRevision(characterId, chatId),
            }));
        },

        /** A job of any kind holds the chat from admission, before it owns any message. */
        chatBusy(characterId: string, chatId: string): boolean {
            return chatSlots.has(chatKey(characterId, chatId));
        },

        /**
         * The job callback an aux request runs inside (`POST /api/llm/request` with `channelCall`),
         * when `clientId` is the current owner, the job has not ended, and that callback is outstanding: its channel,
         * a copy of the job's targets as they are now (a `presetChain` pick included), and an unwatch
         * for `onSettled`, which runs once when the callback settles. Else `null`.
         */
        parentCallback(
            jobId: string,
            clientId: string | undefined,
            callbackId: string,
            onSettled: () => void,
        ): { channel: JobChannel; targets: CallbackTargets; unwatch: () => void; endJob: () => void } | null {
            const job = jobs.get(jobId);
            if (!job || job.ownerClientId !== clientId || job.ended) {
                return null;
            }
            const unwatch = job.channelLink.watchCallback(callbackId, onSettled);
            // A child callback's barrier failure, timeout, or disconnect ends the job.
            return unwatch
                ? {
                      channel: job.channelLink.channel,
                      targets: structuredClone(job.targets),
                      unwatch,
                      endJob: () => abort(job, "failed"),
                  }
                : null;
        },

        /**
         * A participant's job, also readable by a valid ticket or pending takeover holder. Kept
         * outcomes retain the creator and final owner; disk receipts remain creator-only.
         */
        status(jobId: string, clientId: string | undefined): GenerationStatus | null {
            keptOutcomes();
            const job = jobs.get(jobId);
            if (job) {
                expireTicket(job);
                if (
                    !clientId ||
                    (!participantJob(jobId, clientId) &&
                        job.ticket?.clientId !== clientId &&
                        job.pendingTakeover?.clientId !== clientId)
                )
                    return null;
                return projectStatus(status(job), job, clientId);
            }
            expireOutcomes(clock());
            const outcome = kept.get(jobId);
            if (outcome) {
                return outcome.clientId === clientId || outcome.ownerClientId === clientId
                    ? projectStatus(outcome.status, outcome, clientId)
                    : null;
            }
            const receipt = receipts?.read(jobId);
            return receipt && receipt.clientId === clientId && receipt.epoch === store.epoch() ? receipt.status : null;
        },

        /**
         * The dispatched client reports its cancelled callback drained, including after a handoff:
         * the client's lane it kept is free (`server/src/jobs/channel.ts` createChannelHub). Also for
         * an ended job still in the registry, not a collected outcome; false when the callback holds
         * no lane. Null: no such job, or a non-participant without that dispatched hold.
         */
        callbackDrained(jobId: string, clientId: string | undefined, callbackId: string): boolean | null {
            const job = jobs.get(jobId);
            if (!job || !clientId) return null;
            const drained = job.channelLink.drained(callbackId, clientId);
            return drained || participantJob(jobId, clientId) ? drained : null;
        },

        /** A participant stops its job; the first stopper determines the other participant's terminal. */
        abort(jobId: string, clientId: string | undefined): boolean | null {
            const job = participantJob(jobId, clientId);
            if (!job) return null;
            if (!job.ended && !job.abortReason) job.stoppedBy = clientId;
            return abort(job, "aborted");
        },

        /**
         * A participant's stop of the job's registered initial memory run `runId`: the run stops after the
         * summary in progress, the job goes on. 412 for another epoch, 404 for an unknown job or
         * another client's, 409 for an ended job (`jobEnded`), no registered run (`noMemoryRun`), or
         * another run (`otherMemoryRun`). Asking again while the run is registered succeeds again.
         */
        requestMemoryStop(
            jobId: string,
            clientId: string | undefined,
            runId: string,
            epoch: string | undefined,
        ): MemoryStopResult {
            if (epoch !== store.epoch()) {
                return { ok: false, status: 412, body: { error: "EpochMismatch", epoch: store.epoch() } };
            }
            const job = participantJob(jobId, clientId);
            if (!job) {
                return { ok: false, status: 404, body: { error: "Generation not found" } };
            }
            if (job.ended) {
                return { ok: false, status: 409, body: { error: "jobEnded" } };
            }
            if (!job.memoryControl) {
                return { ok: false, status: 409, body: { error: "noMemoryRun" } };
            }
            if (job.memoryControl.runId !== runId) {
                return { ok: false, status: 409, body: { error: "otherMemoryRun" } };
            }
            job.memoryControl.stopRequested = true;
            return { ok: true };
        },

        handleUpgrade,

        startGc() {
            if (gcTimer || closed) {
                return;
            }
            gcTimer = setInterval(() => {
                const now = clock();
                expireOutcomes(now);
                expireCancelled(now);
                receipts?.prune(now);
                for (const [id, job] of jobs) {
                    if (job.ended && now - job.endedAt >= JOB_DONE_GRACE_MS) {
                        for (const ws of allSockets(job)) {
                            ws.close();
                        }
                        keepOutcome(job, now);
                        if (job.requestId && requestJobs.get(job.requestId) === id) requestJobs.delete(job.requestId);
                        jobs.delete(id);
                    } else if (!job.ended && now - job.deadlineFrom >= JOB_MAX_DURATION_MS) {
                        abort(job, "timeout");
                    }
                }
            }, JOB_GC_INTERVAL_MS);
            gcTimer.unref();
        },

        /** Refuses new jobs and aborts every running one (their deadline starts now). */
        beginShutdown() {
            closed = true;
            if (gcTimer) {
                clearInterval(gcTimer);
                gcTimer = null;
            }
            for (const job of runningJobs()) {
                abort(job, "shutdown");
            }
        },

        /** Resolves once every job has ended (bounded by the abort deadline after `beginShutdown`). */
        drain(): Promise<void> {
            return Promise.all(runningJobs().map((job) => job.finished)).then(() => {});
        },

        /** The jobs not ended yet (`state.json`). */
        live(): number {
            let live = 0;
            for (const job of jobs.values()) {
                if (!job.ended) {
                    live++;
                }
            }
            return live;
        },
        /** Closes every socket; call after `drain`. */
        dispose() {
            disposed = true;
            for (const job of jobs.values()) {
                clearHandoff(job);
                for (const ws of allSockets(job)) {
                    const live = liveness.get(ws);
                    if (live?.timer) clearTimeout(live.timer);
                    ws.close();
                }
            }
            wsServer.close();
        },
    };
}

/**
 * Registry capabilities: job-id controls are participant-scoped; current/stop and request-id cancel
 * cross owners.
 */
export type GenerationJobs = ReturnType<typeof createGenerationJobs>;
