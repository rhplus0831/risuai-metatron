import { randomUUID } from "node:crypto";
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
    type GenerationHooks,
    type HydrationReceipt,
    GENERATION_ERROR_STAGES,
    GENERATION_ID_PATTERN,
    type GenerationErrorReason,
    type GenerationErrorStage,
    type GenerationEvent,
    type GenerationKind,
    type GenerationStatus,
    type GenerationTerminalEvent,
    HIDDEN_HYDRATION_KINDS,
} from "../../../shared/jobs.ts";
import { isProviderCode } from "../../../shared/requestHistory.ts";
import { type BatchConflict, parseRevisionToken } from "../../../shared/resources.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import {
    type AppliedChanges,
    ResourceBatchConflictError,
    type ResourceBatchOperation,
    type ResourceStore,
} from "../data/resourceStore.ts";
import type { MaintenanceGate, SnapshotManager } from "../data/snapshots.ts";
import { type DiagnosticsRecorder, logEvent, recordSafely } from "../diagnostics/log.ts";
import type { DiagnosticEventInput } from "../../../shared/diagnostics.ts";
import { checkChatBinding, readChatBindingState } from "./chatBinding.ts";
import { type ChannelHub, createChannelHub, type JobChannel, parseGenerationHooks } from "./channel.ts";
import type { GenerationLock, MessageOwner, MessageRef } from "./generationLock.ts";

/** After its first abort, a job has this long to persist its text and end before it is ended for it. */
export const JOB_ABORT_GRACE_MS = 5000;
/** An ended job stays readable (status, reconnect) this long. */
export const JOB_DONE_GRACE_MS = 60_000;
/** A running job is aborted (`timeout`) after this long. */
export const JOB_MAX_DURATION_MS = 30 * 60_000;
const JOB_GC_INTERVAL_MS = 30_000;
const JOB_HEARTBEAT_MS = 15_000;
/** Most records a job remembers for re-sending on attach. */
const MAX_TRACKED_REFS = 256;

const socketPath = /^\/api\/generations\/([^/]+)\/ws$/;

/**
 * Where a runner failed, for the terminal `error` event (`docs/plan/request-history-diagnostics.md`
 * slice 6): the stage, the LLM request that failed when it was one, and its provider error code.
 */
export type GenerationFailure = { stage?: GenerationErrorStage; requestId?: string; providerCode?: string | null };

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
    for (const key of ["stage", "requestId", "providerCode"] as const) {
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

/** A job write conflicted again after its one re-read (F-b), or conflicted on a chat or order. */
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
    /** Notices, questions, and plugin callbacks to the owner (`job-channel`). */
    readonly channel: JobChannel;
    /** Whether an owner socket is attached now. */
    ownerAttached(): boolean;
    /** The database epoch the job was admitted under; every write and event names it. */
    readonly epoch: string;
    /** Aborted by DELETE, the time limit, shutdown, or maintenance; the job then has
     * `JOB_ABORT_GRACE_MS` to persist its text and return. It may already be aborted when the
     * runner starts (check `aborted` before adding a listener). */
    readonly signal: AbortSignal;
    /**
     * Sends an event to the owner. `accepted` is preceded by the job chat's hydration; `done` and
     * `error` end the job (the chat's hydration and the terminal event go out, and every later
     * call throws `GenerationJobEndedError`). A `resource` of a hidden kind throws.
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
     * `covers`: for a generation write, the newest chunk `seq` its text includes (captured with
     * the text). Once that write applies, the job's chat events tell the client the stored text
     * holds that chunk, so a processed checkpoint is not overwritten by older streamed text. Every
     * applied generation write replaces the claim with its own: one without `covers` claims 0, so
     * the client keeps any streamed text over the stored one.
     */
    write(
        build: () => JobChanges,
        options?: { covers?: readonly { messageId: string; generationId: string; seq: number }[] },
    ): AppliedChanges;
    /** Parsed JSON messages from the owner's socket (the `job-channel` slice answers through it). */
    onClientMessage(listener: (message: unknown) => void): () => void;
    /**
     * The preset the job's later callbacks name in their targets (a send's `presetChain` pick,
     * Phase 5 slice 9); callbacks already sent keep theirs.
     */
    setCallbackPreset?(presetId: string): void;
    /** Flush synchronous metadata setters before a write, event, or callback barrier. */
    setPendingFlush?(flush: (() => void) | null): void;
};

export type GenerationRunner = (job: RunningJob) => Promise<void>;

/** Until prompt assembly (Phase 5 slice 9), a job ends with this error. */
export const unavailableRunner: GenerationRunner = async () => {
    throw new GenerationRunnerError(501, "Server generation is not available yet");
};

export type CreateResult =
    { ok: true; jobId: string } | { ok: false; status: 400 | 404 | 409 | 412 | 503; body: Record<string, unknown> };

type Job = {
    id: string;
    clientId: string;
    kind: GenerationKind;
    context: GenerationContext;
    command: GenerationCommand | null;
    hooks: GenerationHooks;
    channelLink: ReturnType<ChannelHub["open"]>;
    epoch: string;
    token: string;
    controller: AbortController;
    abortReason: GenerationErrorReason | null;
    abortTimer: ReturnType<typeof setTimeout> | null;
    startedAt: number;
    ended: boolean;
    endedAt: number;
    sockets: Set<WebSocket>;
    /** The latest `accepted`, its text kept current by `chunk`; null once its final write applied. */
    current: Extract<GenerationEvent, { type: "accepted" }> | null;
    /** Per message id: the newest chunk the stored text includes (the last applied write's `covers`). */
    watermarks: Map<string, { generationId: string; seq: number }>;
    /** The newest attach stamp admitted (the client's `attach` query); an older handshake is refused. */
    attachStamp: number;
    preset: Extract<GenerationEvent, { type: "preset" }> | null;
    /** What the job's callbacks act on (its preset can change once: `setCallbackPreset`). */
    targets: CallbackTargets;
    /** Records the job sent (`kind\0id`, or `chats\0characterId\0id`), re-sent fresh on attach. */
    refs: Map<string, { kind: string; id: string; characterId?: string }>;
    /**
     * The job chat as last handed to an owner socket (a stored state, read at its `revision`): the
     * base of the next `chatPatch`. Null once the job ended. It is not what the owner holds: the
     * owner applies a patch only at exactly its base or its revision, and asks for a resync otherwise.
     */
    sentChat: ChatBaseline | null;
    /** The last own-chat write, only if it changed metadata on exactly its base revision. */
    metaWrite?: { baseRevision: string; revision: string };
    pendingFlush?: (() => void) | null;
    /** The job chat's messages this job began a generation on: every patch carries their stored rows. */
    generated: Set<string>;
    terminal: GenerationTerminalEvent | null;
    listeners: Set<(message: unknown) => void>;
    finished: Promise<void>;
    resolveFinished: () => void;
};

const chatKey = (characterId: string, chatId: string) => `${characterId}\u0000${chatId}`;

function isResyncRequest(message: unknown): message is ChatResyncRequest {
    return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "resync";
}

function isReplyResyncRequest(message: unknown): message is ReplyResyncRequest {
    return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "resyncReply";
}

/** A stored chat as a patch base: its revision, its fields without `message`, and its messages by id. */
export type ChatBaseline = { revision: string; meta: string; ids: string[]; texts: Map<string, string> };

/** The fields of a stored chat without `message`. */
function chatMeta(data: Chat): Record<string, unknown> {
    const { message: _message, ...meta } = data as Chat & Record<string, unknown>;
    return meta;
}

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
 * The change from `base` to the stored chat `data` (`next` is its baseline), as a `chatPatch` body, or null when
 * a patch cannot express it and the chat goes whole: another incarnation or epoch, an older revision,
 * a message without an id or with a repeated one, or surviving messages in another order (a `replace`
 * that reordered them). `generated` messages are always carried (see `GenerationChatPatchEvent`).
 */
export function diffChat(
    base: ChatBaseline,
    next: ChatBaseline,
    data: Chat,
    generated: ReadonlySet<string>,
): Pick<GenerationChatPatchEvent, "meta" | "removed" | "messages" | "count"> | null {
    const from = parseRevisionToken(base.revision);
    const to = parseRevisionToken(next.revision);
    if (!from || !to || from.epoch !== to.epoch || from.seq !== to.seq || from.revision > to.revision) {
        return null;
    }
    const messages = data.message ?? [];
    const ids: string[] = [];
    const present = new Set<string>();
    for (const message of messages) {
        const id = message.chatId;
        if (typeof id !== "string" || present.has(id)) {
            return null;
        }
        ids.push(id);
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
    messages.forEach((message, index) => {
        const id = ids[index];
        if (generated.has(id) || base.texts.get(id) !== next.texts.get(id)) {
            changed.push({ after: index > 0 ? ids[index - 1] : null, message });
        }
    });
    return {
        ...(next.meta !== base.meta ? { meta: chatMeta(data) } : {}),
        ...(removed.length > 0 ? { removed } : {}),
        ...(changed.length > 0 ? { messages: changed } : {}),
        count: messages.length,
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
 * The generation job registry (Phase 5, `generation-jobs`): admission (one running job per chat),
 * the owner socket, the job's writes (`writeAsJob` with the generation lock), and the lifecycle.
 * Every abort fixes one deadline (`JOB_ABORT_GRACE_MS`); a job is finalized once: its token dies,
 * its locks and chat slot are released, its chat's hydration and one terminal event are sent, and
 * `finished` resolves. Shutdown aborts every job at `beginShutdown`; a restore or import aborts
 * them from `withMaintenance` and waits for their end while writes are still open, so an abort
 * checkpoint lands before the data is replaced and no old job can write afterwards.
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
    /** The channel hub (tests inject one with a fake clock). */
    hub?: ChannelHub;
    /** The diagnostics journal: a `job` event at admission and at the end, and the caught faults. */
    diagnostics?: DiagnosticsRecorder;
}) {
    const { store, kinds, gate, snapshots, lock, authorize, diagnostics } = options;
    const runner = options.runner ?? unavailableRunner;
    const hub = options.hub ?? createChannelHub();
    const jobs = new Map<string, Job>();
    /** Chat → its running job. */
    const chatSlots = new Map<string, string>();
    const wsServer = new WebSocketServer({ noServer: true });
    let closed = false;
    let disposed = false;
    let maintenancePending = 0;
    let gcTimer: ReturnType<typeof setInterval> | null = null;

    /** A `job` event to the journal; a recorder's throw never reaches the job. */
    const record = (input: DiagnosticEventInput) => recordSafely(diagnostics, input);

    function send(job: Job, event: GenerationEvent): boolean {
        return sendText(job, JSON.stringify(event));
    }

    /** Sends to every open owner socket; one failing socket never stops the others. Whether one took it. */
    function sendText(job: Job, text: string): boolean {
        let taken = false;
        for (const ws of job.sockets) {
            try {
                if (ws.readyState === ws.OPEN) {
                    ws.send(text);
                    taken = true;
                }
            } catch (error) {
                logEvent("generation.socketSend", { job: job.id }, error, diagnostics);
            }
        }
        return taken;
    }

    /** The chat as stored now, or null (gone, another epoch, or the store closed during shutdown). */
    function readChat(
        job: Job,
        characterId: string,
        id: string,
        metadataOnly = false,
    ): { revision: string; data: Chat } | null {
        try {
            if (store.epoch() !== job.epoch) {
                return null;
            }
            const chat = metadataOnly
                ? store.chatMeta(characterId, id)
                : store.readRefs([], { chats: [{ characterId, id }] }).chats[0];
            return chat && chat.revision !== null ? { revision: chat.revision, data: chat.data as Chat } : null;
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
     */
    function jobChatEvent(
        job: Job,
        mode: "patch" | "whole",
        metadataOnly = false,
    ): { event: GenerationEvent; baseline: ChatBaseline } | null {
        const { characterId, chatId } = job.context;
        const base = mode === "patch" ? job.sentChat : null;
        if (metadataOnly && base && job.metaWrite?.baseRevision === base.revision) {
            const chat = readChat(job, characterId, chatId, true);
            if (chat?.revision === job.metaWrite.revision) {
                const meta = chatMeta(chat.data as Chat);
                const baseline = { ...base, revision: chat.revision, meta: JSON.stringify(meta) };
                // Only metadata changed since this baseline, so its stored generated rows are still
                // exact. Carry them as diffChat does, without parsing any other message.
                const messages: { after: string | null; message: unknown }[] = [];
                base.ids.forEach((id, index) => {
                    if (job.generated.has(id)) {
                        messages.push({
                            after: index > 0 ? base.ids[index - 1] : null,
                            message: JSON.parse(base.texts.get(id)!),
                        });
                    }
                });
                return {
                    baseline,
                    event: {
                        type: "chatPatch",
                        epoch: job.epoch,
                        characterId,
                        id: chatId,
                        baseRevision: base.revision,
                        revision: chat.revision,
                        ...(baseline.meta !== base.meta ? { meta } : {}),
                        ...(messages.length > 0 ? { messages } : {}),
                        count: base.ids.length,
                        streaming: streamingIn(job, characterId, chatId),
                    },
                };
            }
        }
        const chat = readChat(job, characterId, chatId);
        if (!chat) {
            return null;
        }
        const baseline = chatBaseline(chat.revision, chat.data);
        const diff = base ? diffChat(base, baseline, chat.data, job.generated) : null;
        const event: GenerationEvent =
            base && diff
                ? {
                      type: "chatPatch",
                      epoch: job.epoch,
                      characterId,
                      id: chatId,
                      baseRevision: base.revision,
                      revision: chat.revision,
                      ...diff,
                      streaming: streamingIn(job, characterId, chatId),
                  }
                : wholeChatEvent(job, characterId, chatId, chat);
        return { event, baseline };
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
    function deliverJobChat(job: Job, mode: "patch" | "whole", metadataOnly = false): GenerationEvent | null {
        const built = jobChatEvent(job, mode, metadataOnly);
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
     * The callback barrier: the job chat whole (the client's barrier applies a remembered whole copy
     * again once its local work settled; a patch cannot be applied that late) and `freshRecords`.
     * Returns their receipts (synchronously: each receipt names the copy sent).
     */
    function hydrateAll(job: Job): HydrationReceipt[] {
        job.pendingFlush?.();
        const chat = deliverJobChat(job, "whole");
        const events = freshRecords(job);
        for (const event of events) {
            send(job, event);
        }
        return (chat ? [chat, ...events] : events).map(receiptOf);
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
        // Before anything dies: the channel's requests settle `aborted` and the owner gets their `cancel`.
        try {
            job.channelLink.close("The job has ended");
        } catch (error) {
            logEvent("generation.channelClose", { job: job.id }, error, diagnostics);
        }
        let terminal = { ...(job.abortReason ? abortTerminal(job.abortReason) : requested), epoch: job.epoch };
        let text: string;
        try {
            text = JSON.stringify(terminal);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            terminal = {
                ...errorTerminal(new Error(`The job's result could not be sent: ${reason}`)),
                epoch: job.epoch,
            };
            text = JSON.stringify(terminal);
        }
        job.ended = true;
        job.endedAt = Date.now();
        job.terminal = terminal as GenerationTerminalEvent;
        record({
            kind: "job",
            phase: terminal.type === "error" ? "error" : "done",
            jobId: job.id,
            jobKind: job.kind,
            durationMs: job.endedAt - job.startedAt,
            ...(terminal.type === "error"
                ? {
                      reason: terminal.reason,
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
            const key = chatKey(job.context.characterId, job.context.chatId);
            if (chatSlots.get(key) === job.id) {
                chatSlots.delete(key);
            }
            job.listeners.clear();
            sendChat(job);
            sendText(job, text);
        } catch (error) {
            logEvent("generation.endDelivery", { job: job.id }, error, diagnostics);
        } finally {
            // An attach after the end gets the chat whole: the base is no longer needed.
            job.sentChat = null;
            job.resolveFinished();
        }
    }

    function abortTerminal(reason: GenerationErrorReason): TerminalInput {
        return { type: "error", reason, ...abortMessages[reason] };
    }

    function errorTerminal(error: unknown): TerminalInput {
        const status =
            error instanceof GenerationRunnerError && error.status >= 400 && error.status <= 599 ? error.status : 500;
        // Only checked values: the event's failure fields are content-free (decision 9).
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
        };
    }

    function abort(job: Job, reason: GenerationErrorReason): boolean {
        if (job.ended || job.abortReason) {
            return false;
        }
        job.abortReason = reason;
        // One deadline per job, set before the signal's listeners run (one may end the job at once);
        // later aborts do not extend it.
        job.abortTimer = setTimeout(() => finalize(job, abortTerminal(reason)), JOB_ABORT_GRACE_MS);
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
    ): AppliedChanges {
        for (let attempt = 0; ; attempt += 1) {
            assertLive(job);
            gate.assertOpen();
            const changes = build();
            // Every acquisition in op order with what it replaced, undone in reverse on failure.
            const acquired: { ref: MessageRef; previous: MessageOwner | null }[] = [];
            try {
                for (const group of changes.chats ?? []) {
                    for (const op of group.ops) {
                        if (op.op === "begin") {
                            const ref = { characterId: group.characterId, chatId: group.chatId, messageId: op.id };
                            const owner = { jobId: job.id, generationId: op.generationId, token: job.token };
                            acquired.push({ ref, previous: lock.acquire(ref, owner) });
                        }
                    }
                }
                const applied = store.applyChanges(changes, { epoch: job.epoch, jobToken: job.token });
                (changes.chats ?? []).forEach((group, index) => {
                    const outcomes = applied.chats[index]?.checkpoints ?? [];
                    let checkpoint = 0;
                    if (group.characterId === job.context.characterId && group.chatId === job.context.chatId) {
                        const result = applied.chats[index];
                        job.metaWrite =
                            group.baseRevision &&
                            result?.revision &&
                            !result.stale &&
                            group.ops.every((op) => op.op === "meta")
                                ? { baseRevision: group.baseRevision, revision: result.revision }
                                : undefined;
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
                                (entry) => entry.messageId === written && entry.generationId === op.generation!.id,
                            );
                            if (outcome === "applied") {
                                // The stored text is this write's: its claim (none: 0) replaces the last.
                                job.watermarks.set(written, { generationId: op.generation.id, seq: cover?.seq ?? 0 });
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
                                lock.release(
                                    { characterId: group.characterId, chatId: group.chatId, messageId },
                                    job.token,
                                    op.generation.id,
                                );
                            }
                        }
                    }
                });
                return applied;
            } catch (error) {
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
            ownerAttached: () => job.sockets.size > 0,
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
                        // Nothing is buffered here. Leave sentChat alone; attach rebuilds from it.
                        if (![...job.sockets].some((ws) => ws.readyState === ws.OPEN)) {
                            continue;
                        }
                        // The job chat: what changed since the last copy a socket took.
                        const event = deliverJobChat(job, "patch", true);
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
                    return writeAsJob(job, build, options?.covers);
                } catch (error) {
                    // Every job write fails here: a conflict, a refused write, a storage failure.
                    throw markFailure(error, { stage: "persist" });
                }
            },
            setCallbackPreset(presetId) {
                job.targets.presetId = presetId;
            },
            setPendingFlush(flush) {
                job.pendingFlush = flush;
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

    function create(body: GenerationCreateBody, epoch: string | undefined): CreateResult {
        if (closed || maintenancePending > 0 || gate.active) {
            return { ok: false, status: 503, body: { error: "The server is not accepting generations now" } };
        }
        if (epoch !== store.epoch()) {
            return { ok: false, status: 412, body: { error: "EpochMismatch", epoch: store.epoch() } };
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
        if (revision !== body.context.chatRevision) {
            return { ok: false, status: 409, body: { error: "stale" } };
        }
        // The job runs on its chat's binding or not at all (`docs/plan/chat-binding.md`), whatever its
        // kind (a preview too): `targets` below is then the binding. `loadJobScope` checks it again.
        const binding = readChatBindingState(store, kinds, { characterId, chatId });
        const refusal = binding.chat && checkChatBinding(binding.chat, binding.lookup, body.context, "send");
        if (refusal) {
            return { ok: false, status: 409, body: refusal };
        }
        let resolveFinished!: () => void;
        const finished = new Promise<void>((resolve) => {
            resolveFinished = resolve;
        });
        const job: Job = {
            id: randomUUID(),
            clientId: body.clientId,
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
            startedAt: Date.now(),
            ended: false,
            endedAt: 0,
            sockets: new Set(),
            current: null,
            watermarks: new Map(),
            attachStamp: -1,
            preset: null,
            targets: {
                chatRef: { chaId: characterId, chatId },
                presetId: body.context.presetId ?? "",
                modelPresetId: body.context.modelPresetId ?? "",
                personaId: body.context.personaId ?? "",
            },
            refs: new Map(),
            // The chat at the revision the owner named (checked above): the first patch's base.
            sentChat: admittedChat(characterId, chatId),
            generated: new Set(),
            terminal: null,
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
            send: (event) => {
                job.pendingFlush?.();
                return !job.ended && send(job, event);
            },
            hydrate: () => hydrateAll(job),
            ownerAttached: () => job.sockets.size > 0,
        });
        try {
            snapshots.track(() => finished);
        } catch {
            return { ok: false, status: 503, body: { error: "The server is shutting down" } };
        }
        lock.addToken(job.token);
        jobs.set(job.id, job);
        chatSlots.set(chatKey(characterId, chatId), job.id);
        record({ kind: "job", phase: "accepted", jobId: job.id, jobKind: job.kind });
        start(job);
        return { ok: true, jobId: job.id };
    }

    function ownJob(jobId: string, clientId: string | undefined): Job | null {
        const job = jobs.get(jobId);
        return job && job.clientId === clientId ? job : null;
    }

    function status(job: Job): GenerationStatus {
        return {
            jobId: job.id,
            kind: job.kind,
            characterId: job.context.characterId,
            chatId: job.context.chatId,
            epoch: job.epoch,
            state: job.ended ? "ended" : "running",
            ...(job.current?.messageId ? { messageId: job.current.messageId } : {}),
            ...(job.current?.generationId ? { generationId: job.current.generationId } : {}),
            ...(job.terminal ? { terminal: job.terminal } : {}),
        };
    }

    function attach(job: Job, ws: WebSocket) {
        // One delivery stream per job: a new attach of the owner replaces the older sockets, so a
        // chunk still queued on one cannot arrive after this one's snapshot.
        for (const old of job.sockets) {
            old.close(4001, "Superseded by a newer connection");
        }
        job.sockets.clear();
        job.sockets.add(ws);
        // What the owner needs to resume: the job chat (what changed since the last copy a socket
        // took while the job runs: the owner applies it only at exactly that copy's revision or the
        // current one, and asks for the chat whole otherwise; whole once it ended) and every record
        // the job sent, read fresh, the chosen preset, the current reply with its text, and the
        // result if it ended.
        const chat = jobChatEvent(job, job.ended ? "whole" : "patch");
        const events: GenerationEvent[] = [...(chat ? [chat.event] : []), ...freshRecords(job)];
        if (job.preset) {
            events.push(job.preset);
        }
        const current = currentReply(job);
        if (current) {
            events.push(current);
        }
        if (job.terminal) {
            // A job that ended before its owner first attached: the notices it sent meanwhile first.
            events.push(...(job.channelLink.takeEarly() as GenerationEvent[]));
            events.push(job.terminal);
        }
        for (const event of events) {
            ws.send(JSON.stringify(event));
        }
        if (chat && !job.ended) {
            job.sentChat = chat.baseline;
        }
        if (!job.ended) {
            // Then every request still waiting for an answer, marked as a replay.
            job.channelLink.handleAttach();
        }
        const ping = setInterval(() => {
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
            }
        }, JOB_HEARTBEAT_MS);
        ws.on("message", (data) => {
            // Only the job's current socket speaks for the owner (a superseded one may still deliver).
            if (!job.sockets.has(ws)) {
                return;
            }
            let message: unknown;
            try {
                message = JSON.parse(String(data));
            } catch {
                return;
            }
            if (isReplyResyncRequest(message)) {
                // Recovery needs the stream base even during a lock handoff. The client drops a
                // retired generation; unlike currentReply, this does not require lock ownership.
                if (!job.ended && job.current?.messageId) {
                    send(job, job.current);
                }
                return;
            }
            if (isResyncRequest(message)) {
                // A `chatPatch` did not apply on the owner: the job chat whole, as the next base, and
                // the current reply again (its stream update may have been dropped for a missing message).
                if (!job.ended && deliverJobChat(job, "whole")) {
                    const current = currentReply(job);
                    if (current) {
                        send(job, current);
                    }
                }
                return;
            }
            job.channelLink.handleMessage(message);
            for (const listener of [...job.listeners]) {
                try {
                    listener(message);
                } catch (error) {
                    logEvent("generation.listener", { job: job.id }, error, diagnostics);
                }
            }
        });
        ws.on("close", () => {
            clearInterval(ping);
            job.sockets.delete(ws);
        });
        ws.on("error", () => {
            clearInterval(ping);
        });
    }

    /**
     * The `upgrade` handler for `/api/generations/:id/ws` (the server's one dispatcher calls it).
     * False, leaving the socket untouched, for any other path. The handshake needs a JWT (`risu-auth`
     * query or header) and the job's `clientId` query; another client's or an unknown job is a 404.
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
                const job = disposed
                    ? null
                    : ownJob(decodeURIComponent(match[1]), url.searchParams.get("clientId") ?? undefined);
                if (!job) {
                    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                    socket.destroy();
                    return;
                }
                // Handshakes finish in any order: an older follow (a lower stamp) never displaces a newer one.
                const stamp = Number(url.searchParams.get("attach") ?? 0);
                if (!Number.isFinite(stamp) || stamp < job.attachStamp || socket.destroyed) {
                    socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
                    socket.destroy();
                    return;
                }
                job.attachStamp = stamp;
                wsServer.handleUpgrade(req, socket, head, (ws) => {
                    if (disposed || stamp < job.attachStamp) {
                        ws.close();
                        return;
                    }
                    attach(job, ws);
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

    return {
        create,

        /** The owner's view of its job, or null for an unknown job or another client's. */
        /**
         * The job callback an aux request runs inside (`POST /api/llm/request` with `channelCall`),
         * when the job is `clientId`'s, has not ended, and that callback is outstanding: its channel,
         * a copy of the job's targets as they are now (a `presetChain` pick included), and an unwatch
         * for `onSettled`, which runs once when the callback settles. Else `null`.
         */
        parentCallback(
            jobId: string,
            clientId: string | undefined,
            callbackId: string,
            onSettled: () => void,
        ): { channel: JobChannel; targets: CallbackTargets; unwatch: () => void; endJob: () => void } | null {
            const job = ownJob(jobId, clientId);
            if (!job || job.ended) {
                return null;
            }
            const unwatch = job.channelLink.watchCallback(callbackId, onSettled);
            // A child callback's barrier failure, timeout, or disconnect ends the job (`job-channel`).
            return unwatch
                ? {
                      channel: job.channelLink.channel,
                      targets: structuredClone(job.targets),
                      unwatch,
                      endJob: () => abort(job, "failed"),
                  }
                : null;
        },

        status(jobId: string, clientId: string | undefined): GenerationStatus | null {
            const job = ownJob(jobId, clientId);
            return job ? status(job) : null;
        },

        /** Aborts the owner's job (the text so far is persisted by the runner). Null: no such job. */
        abort(jobId: string, clientId: string | undefined): boolean | null {
            const job = ownJob(jobId, clientId);
            return job ? abort(job, "aborted") : null;
        },

        handleUpgrade,

        startGc() {
            if (gcTimer || closed) {
                return;
            }
            gcTimer = setInterval(() => {
                const now = Date.now();
                for (const [id, job] of jobs) {
                    if (job.ended && now - job.endedAt >= JOB_DONE_GRACE_MS) {
                        for (const ws of job.sockets) {
                            ws.close();
                        }
                        jobs.delete(id);
                    } else if (!job.ended && now - job.startedAt >= JOB_MAX_DURATION_MS) {
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
                for (const ws of job.sockets) {
                    ws.close();
                }
            }
            wsServer.close();
        },
    };
}

export type GenerationJobs = ReturnType<typeof createGenerationJobs>;
