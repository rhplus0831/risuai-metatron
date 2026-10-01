import { randomUUID } from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { ChatGroup, ChatOrderChange } from "../../../shared/chats.ts";
import {
    type GenerationContext,
    type GenerationCreateBody,
    type GenerationHooks,
    type HydrationReceipt,
    type GenerationErrorReason,
    type GenerationEvent,
    type GenerationKind,
    type GenerationStatus,
    type GenerationTerminalEvent,
    HIDDEN_HYDRATION_KINDS,
} from "../../../shared/jobs.ts";
import type { BatchConflict } from "../../../shared/resources.ts";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import {
    type AppliedChanges,
    ResourceBatchConflictError,
    type ResourceBatchOperation,
    type ResourceStore,
} from "../data/resourceStore.ts";
import type { MaintenanceGate, SnapshotManager } from "../data/snapshots.ts";
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

/** A runner's failure with an HTTP-like status for the terminal `error` event. */
export class GenerationRunnerError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.name = "GenerationRunnerError";
        this.status = status;
    }
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
/** An event as a runner emits it: the registry adds the epoch. */
export type JobEventInput = Distribute<Exclude<GenerationEvent, { type: "ping" }>>;
type TerminalInput = Distribute<GenerationTerminalEvent>;

/** What the injected runner gets for one job. */
export type RunningJob = {
    readonly id: string;
    readonly kind: GenerationKind;
    readonly context: Readonly<GenerationContext>;
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
     * skipped); returns what was sent, at the revisions sent.
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
    /** Records the job sent (`kind\0id`, or `chats\0characterId\0id`), re-sent fresh on attach. */
    refs: Map<string, { kind: string; id: string; characterId?: string }>;
    terminal: GenerationTerminalEvent | null;
    listeners: Set<(message: unknown) => void>;
    finished: Promise<void>;
    resolveFinished: () => void;
};

const chatKey = (characterId: string, chatId: string) => `${characterId}\u0000${chatId}`;

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
}) {
    const { store, kinds, gate, snapshots, lock, authorize } = options;
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
                console.error("[Generation]", error);
            }
        }
        return taken;
    }

    /** The chat's current server copy as a `resource` event, or null (gone, or another epoch). */
    function chatEvent(job: Job, characterId: string, id: string): GenerationEvent | null {
        try {
            if (store.epoch() !== job.epoch) {
                return null;
            }
            const chat = store.readRefs([], { chats: [{ characterId, id }] }).chats[0];
            if (!chat || chat.revision === null) {
                return null;
            }
            // The job's messages still generating in this chat: the client keeps their streamed text
            // over this copy, and takes the stored text of every other message of the job.
            const streaming = lock
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
            return {
                type: "resource",
                epoch: job.epoch,
                kind: "chats",
                characterId,
                id,
                revision: chat.revision,
                data: chat.data,
                streaming,
            };
        } catch {
            // The store closed during shutdown: nothing more to hydrate.
            return null;
        }
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
        const event = chatEvent(job, job.context.characterId, job.context.chatId);
        if (event) {
            send(job, event);
        }
    }

    function receiptOf(event: GenerationEvent): HydrationReceipt {
        const resource = event as Extract<GenerationEvent, { type: "resource" }>;
        return {
            kind: resource.kind,
            id: resource.id,
            ...(resource.characterId !== undefined ? { characterId: resource.characterId } : {}),
            revision: resource.revision,
        };
    }

    /** The job chat and every other record the job sent, read now (attach and the callback barrier). */
    function freshRecords(job: Job): GenerationEvent[] {
        const chat = chatEvent(job, job.context.characterId, job.context.chatId);
        const events: GenerationEvent[] = chat ? [chat] : [];
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

    /** Sends `freshRecords` and returns their receipts (synchronously: each receipt names the copy sent). */
    function hydrateAll(job: Job): HydrationReceipt[] {
        const events = freshRecords(job);
        for (const event of events) {
            send(job, event);
        }
        return events.map(receiptOf);
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
            console.error("[Generation]", error);
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
            console.error("[Generation]", error);
        } finally {
            job.resolveFinished();
        }
    }

    function abortTerminal(reason: GenerationErrorReason): TerminalInput {
        return { type: "error", reason, ...abortMessages[reason] };
    }

    function errorTerminal(error: unknown): TerminalInput {
        const status =
            error instanceof GenerationRunnerError && error.status >= 400 && error.status <= 599 ? error.status : 500;
        return {
            type: "error",
            reason: "failed",
            status,
            message: error instanceof Error ? error.message : String(error),
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
            hooks: job.hooks,
            channel: job.channelLink.channel,
            ownerAttached: () => job.sockets.size > 0,
            epoch: job.epoch,
            signal: job.controller.signal,
            emit(input) {
                assertLive(job);
                if (input.type === "done" || input.type === "error") {
                    finalize(job, input);
                    return;
                }
                if (input.type === "resource" && HIDDEN_HYDRATION_KINDS.includes(input.kind)) {
                    throw new Error(`${input.kind} records are never sent to the client`);
                }
                const event = { ...input, epoch: job.epoch } as GenerationEvent;
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
                        job.current.text = event.text;
                        job.current.seq = event.seq;
                        break;
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
                    const event = chatEvent(job, ref.characterId, ref.id);
                    track(job, `chats\u0000${ref.characterId}\u0000${ref.id}`, { kind: "chats", ...ref });
                    if (event) {
                        send(job, event);
                        receipts.push(receiptOf(event));
                    }
                }
                return receipts;
            },
            write: (build, options) => writeAsJob(job, build, options?.covers),
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
        ).catch((error) => console.error("[Generation]", error));
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
        let resolveFinished!: () => void;
        const finished = new Promise<void>((resolve) => {
            resolveFinished = resolve;
        });
        const job: Job = {
            id: randomUUID(),
            clientId: body.clientId,
            kind: body.kind,
            context: structuredClone(body.context),
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
            refs: new Map(),
            terminal: null,
            listeners: new Set(),
            finished,
            resolveFinished,
        };
        job.channelLink = hub.open({
            jobId: job.id,
            clientId: job.clientId,
            epoch: job.epoch,
            targets: {
                chatRef: { chaId: characterId, chatId },
                presetId: job.context.presetId ?? "",
                personaId: job.context.personaId ?? "",
            },
            hooks,
            send: (event) => !job.ended && send(job, event),
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
        // What the owner needs to resume: the job chat and every record the job sent, read fresh,
        // the chosen preset, the current reply with its text, and the result if it ended.
        const events: GenerationEvent[] = freshRecords(job);
        if (job.preset) {
            events.push(job.preset);
        }
        // Only a reply still generating: a final one is in the fresh chat above, and its streamed
        // text would be older.
        const current = job.current;
        if (current?.messageId && !job.ended) {
            const owner = lock.ownerOf({
                characterId: job.context.characterId,
                chatId: job.context.chatId,
                messageId: current.messageId,
            });
            if (owner?.token === job.token && owner.generationId === current.generationId) {
                events.push(current);
            }
        } else if (current && !job.ended) {
            // A command job's `accepted` has no message.
            events.push(current);
        }
        if (job.terminal) {
            events.push(job.terminal);
        }
        for (const event of events) {
            ws.send(JSON.stringify(event));
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
            job.channelLink.handleMessage(message);
            for (const listener of [...job.listeners]) {
                try {
                    listener(message);
                } catch (error) {
                    console.error("[Generation]", error);
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
