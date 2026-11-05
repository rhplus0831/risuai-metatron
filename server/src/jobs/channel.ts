import { randomUUID } from "node:crypto";
import { isModelDescriptor } from "../../../shared/llm/validate.ts";
import {
    CANCELLED_CALLBACK_DRAIN_MS,
    type CallbackName,
    type CallbackPayloads,
    type CallbackResult,
    type CallbackTargets,
    type GenerationChannelEvent,
    type GenerationHooks,
    type GenerationNotice,
    type GenerationQuestion,
    type HydrationReceipt,
    MAX_PROVIDER_TEXT_CHARS,
    NO_GENERATION_HOOKS,
    type QuestionResult,
    SCRIPT_HOOK_MODES,
    type ScriptHookMode,
    TAB_MCP_IDENTIFIERS,
} from "../../../shared/jobs.ts";

/**
 * Job questions and callbacks share one client lane across jobs. The owner clock comes from
 * `server/src/jobs/generationJobs.ts` via ChannelTransport.ownerAbsentDeadline; this module applies
 * it in absenceDeadline and effectiveDeadline, using the hub's injected clock for every check.
 * Timers only wake work: answers, chunks, dispatch, attach, parent lookup and watchCallback must
 * check the current effective deadline too, so a late timer or frame cannot accept overdue work.
 * Owner transitions re-arm wakeups. Reconnection removes the absence cap without extending a
 * dispatched request's own allowance or its parent's allowance. Ownership transfer moves only
 * undelivered requests into the new owner's lane, ahead of queued work, with a fresh dispatch
 * allowance. Delivered requests and cancellation drain holds keep their recorded dispatch lane.
 * A pending transfer blocks new roots until the registry switches at an enqueue or a deferred task,
 * after settlement has allowed the runner to end a failed job.
 */

/** A question waits this long from the moment it is dispatched (not while it waits in the client's queue). */
export const QUESTION_TIMEOUT_MS = 120_000;
/**
 * A callback waits this long from the moment it is dispatched (a `provider` callback: the caller's), not
 * while it waits in the client's queue.
 */
export const CALLBACK_TIMEOUT_MS = 60_000;
/** Most requests one client may have queued. */
const MAX_QUEUED_PER_CLIENT = 256;
/** Outstanding requests one client may have: a callback and one child (an aux request's callback). */
const MAX_DEPTH = 2;

export type NoticeAudience = "owner" | "all" | "creator";

/** What the registry gives the channel of one job. */
export type ChannelTransport = {
    readonly jobId: string;
    readonly clientId: string;
    readonly epoch: string;
    readonly targets: CallbackTargets;
    readonly hooks: GenerationHooks;
    /**
     * Sends requests/cancels only to the current owner, and notices to their audience. Returns
     * whether an eligible open socket took the frame (it may have reached the client).
     */
    send(event: GenerationChannelEvent): boolean;
    /** Sends the job chat and every record the job sent, read now; returns what was sent. */
    hydrate(): HydrationReceipt[];
    /** Persists synchronous setters before a notice or request leaves the runner. */
    flushPending?(): void;
    ownerAttached(): boolean;
    /** Notice delivery groups have independent first-attach buffers. Defaults to owner. */
    noticeAudience?(notice: GenerationNotice): NoticeAudience;
    /** Runs before choosing an enqueue lane, after the previous callback's runner continued. */
    beforeEnqueue?(): void;
    /** Settlement notification: the registry must defer any ownership switch. */
    onSettled?(): void;
    /** The job's absence bound, or Infinity while an effective owner is present. */
    ownerAbsentDeadline?(): number;
};

/**
 * The runner's owner channel. Callbacks require an admitted hook, provider or MCP entry except for
 * the fixed built-ins: generateImage, inlayImage, imggen, selectedChat and MCP callbacks to
 * TAB_MCP_IDENTIFIERS. Callbacks hydrate before delivery; a notice is one way and cannot wait for
 * an answer or hold a request lane.
 */
export type JobChannel = {
    notice(notice: GenerationNotice): void;
    ask(
        question: GenerationQuestion,
        /** `signal`: the caller withdraws the question (`aborted`, the tab told). */
        options?: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<QuestionResult>;
    callback<N extends CallbackName>(
        name: N,
        payload: CallbackPayloads[N],
        options?: {
            timeoutMs?: number;
            parentId?: string;
            /** A `provider` callback's streamed text so far (each `chunk` message of the owner). */
            onChunk?: (text: string) => void;
            /** Ends the callback (`aborted`, the tab told) when the caller's request ends first. */
            signal?: AbortSignal;
        },
    ): Promise<CallbackResult>;
};

/** Whether a callback result ends the job whatever the hook's policy (a barrier failure). */
export function isBarrierFailure(result: CallbackResult): boolean {
    return result.outcome === "failed" && result.failure === "barrier";
}

type Request = {
    id: string;
    channel: ChannelState;
    kind: "question" | "callback";
    /** Makes `build` once the deadline is known (at dispatch). */
    makeBuild: (id: string, deadline: number) => (replay: boolean) => GenerationChannelEvent;
    /** Builds the event to send; a callback hydrates first (the barrier). Set at dispatch. */
    build: ((replay: boolean) => GenerationChannelEvent) | null;
    timeoutMs: number;
    /** Its own allowance, set at dispatch (`timeoutMs` from then); `Infinity` while queued. */
    deadline: number;
    parent: Request | null;
    children: Set<Request>;
    /** It holds the client's slot (it is the outstanding request, or a child of it). */
    dispatched: boolean;
    /** When it took the client's slot; `Infinity` while queued. */
    dispatchedAt: number;
    /** Fixed before dispatch expiry; queued requests instead follow the current owner. */
    laneClientId: string | null;
    /** An open owner socket took it at least once: a later send is a replay. */
    delivered: boolean;
    settled: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    /** Called once when it settles (an aux request running inside this callback ends with it). */
    onSettled: Set<() => void>;
    /** A streaming `provider` callback: the owner's `chunk` messages (the cumulative text) go here. */
    onChunk?: (text: string) => void;
    chunkText: string;
    chunkSeq: number;
    chunkGap: boolean;
    /** Success waits until the cumulative text includes the tab's final sequence. */
    chunkAnswer: { seq: number; result: Extract<CallbackResult, { outcome: "answered" }> } | null;
    resolve: (result: QuestionResult | CallbackResult) => void;
    /** When it was asked, against the notices kept before the first attach (`earlyOrder`). */
    order: number;
};

/** Orders the notices kept before a first attach against the requests made meanwhile. */
let earlyOrder = 0;

type ChannelState = {
    transport: ChannelTransport;
    openedAt: number;
    requests: Set<Request>;
    closed: boolean;
    transferPending: boolean;
    settling: number;
    attachedAudiences: Set<NoticeAudience>;
    /**
     * Notices kept until their audience first attaches, bounded together by MAX_EARLY_NOTICE_BYTES.
     * Each audience drains independently, in original request/notice order on an owner attach.
     * Later notices for an absent audience are dropped: notices are one way.
     */
    early: { order: number; event: Extract<GenerationChannelEvent, { type: "notice" }>; bytes: number }[];
    earlyBytes: number;
};

/** The serialized size of the notices kept for an owner that has not attached yet; later ones are dropped. */
const MAX_EARLY_NOTICE_BYTES = 1024 * 1024;

/**
 * A callback the server cancelled after an owner socket took it: the tab's hook may still run, so it
 * keeps the client's lane until the tab reports it drained or `until` (server clock) passes.
 */
type Draining = { channel: ChannelState; until: number; timer: ReturnType<typeof setTimeout> | null };

type ClientLane = { queue: Request[]; stack: Request[]; draining: Map<string, Draining> };
type OrderedSend = { order: number; send: () => void };

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks a create body's `hooks`: missing is none; anything malformed is refused (the caller answers
 * 400). Provider descriptors are deep-copied (frozen at creation).
 */
export function parseGenerationHooks(raw: unknown): GenerationHooks | string {
    if (raw === undefined) {
        return structuredClone(NO_GENERATION_HOOKS);
    }
    if (!isPlainObject(raw)) {
        return "hooks must be an object";
    }
    const { replacers, scripts, interceptors, chatOutput, providers, mcpTools } = raw;
    if (
        !isPlainObject(replacers) ||
        typeof replacers.beforeRequest !== "boolean" ||
        typeof replacers.afterRequest !== "boolean"
    ) {
        return "hooks.replacers must be { beforeRequest, afterRequest } booleans";
    }
    if (!Array.isArray(scripts) || !scripts.every((mode) => SCRIPT_HOOK_MODES.includes(mode as ScriptHookMode))) {
        return "hooks.scripts must list script modes";
    }
    if (typeof interceptors !== "boolean" || typeof chatOutput !== "boolean") {
        return "hooks.interceptors and hooks.chatOutput must be booleans";
    }
    if (!Array.isArray(providers) || !providers.every(isProviderEntry)) {
        return "hooks.providers must be { name, model } entries with a model descriptor";
    }
    if (!Array.isArray(mcpTools) || !mcpTools.every((id) => typeof id === "string")) {
        return "hooks.mcpTools must be identifiers";
    }
    let copied: GenerationHooks["providers"];
    try {
        copied = JSON.parse(JSON.stringify(providers));
    } catch {
        return "hooks.providers must be JSON";
    }
    return {
        replacers: { beforeRequest: replacers.beforeRequest, afterRequest: replacers.afterRequest },
        scripts: [...new Set(scripts as ScriptHookMode[])],
        interceptors,
        chatOutput,
        providers: copied,
        mcpTools: [...new Set(mcpTools as string[])],
    };
}

/** A provider entry: a name and the `LLMModel` fields the server reads (`isModelDescriptor`). */
function isProviderEntry(entry: unknown): boolean {
    return (
        isPlainObject(entry) && typeof entry.name === "string" && entry.name !== "" && isModelDescriptor(entry.model)
    );
}

/** Whether the job's hook list has the hook a callback names. */
function hasHook(hooks: GenerationHooks, name: CallbackName, payload: unknown): boolean {
    switch (name) {
        case "replacerbeforeRequest":
            return hooks.replacers.beforeRequest;
        case "replacerafterRequest":
            return hooks.replacers.afterRequest;
        case "bodyIntercepter":
            return hooks.interceptors;
        case "chatOutput":
            return hooks.chatOutput;
        case "provider":
            return isPlainObject(payload) && hooks.providers.some((entry) => entry.name === payload.name);
        case "mcpList":
        case "mcpTool":
            return (
                isPlainObject(payload) &&
                (hooks.mcpTools.includes(payload.identifier as string) ||
                    TAB_MCP_IDENTIFIERS.includes(payload.identifier as string))
            );
        case "generateImage":
        case "inlayImage":
        case "imggen":
        case "selectedChat":
            // A client capability, not a plugin hook.
            return true;
        default:
            return hooks.scripts.includes(name);
    }
}

/** Maps a validated answer to a result, or null for a malformed one (ignored). */
function readAnswer(kind: Request["kind"], message: Record<string, unknown>): QuestionResult | CallbackResult | null {
    switch (message.outcome) {
        case "answered":
            if (!Object.hasOwn(message, "value")) {
                return null;
            }
            return { outcome: "answered", value: message.value };
        case "cancelled":
            return kind === "question" ? { outcome: "cancelled" } : null;
        case "failed": {
            if (
                kind !== "callback" ||
                (message.failure !== "hook" && message.failure !== "barrier" && message.failure !== "protocol") ||
                typeof message.error !== "string" ||
                (message.discarded !== undefined &&
                    !(Array.isArray(message.discarded) && message.discarded.every((key) => typeof key === "string")))
            ) {
                return null;
            }
            return {
                outcome: "failed",
                failure: message.failure,
                error: message.error,
                ...(message.discarded ? { discarded: message.discarded as string[] } : {}),
            };
        }
        default:
            return null;
    }
}

/**
 * The registry's channel hub, shared by its jobs. Per client it keeps a FIFO
 * of queued requests and a stack of outstanding ones: a request without a parent waits until the
 * client has none outstanding; a child (an aux request's callback, `parentId` = the client's
 * outstanding callback) runs at once, one level deep; anything else is refused. Notices are never
 * queued. Every request has one deadline from the moment it is dispatched (it takes the client's
 * slot, with or without an owner socket attached), capped by owner absence and its parent's
 * effective deadline; at the deadline it is
 * `timedOut` with an owner socket attached, else `disconnected`. A queued root's own timeout starts
 * at dispatch, but its job's owner-absence deadline also bounds its wait in the queue. It can also
 * end when its job ends or its signal aborts. When a dispatched
 * root expires `disconnected`, queued roots of that client whose own jobs have no owner and were
 * opened no later than that root's dispatch settle `disconnected` first. A job's end (`close`)
 * settles its requests `aborted` and cancels their children.
 *
 * A callback settled without its answer after an owner socket took it (a timeout, its caller's
 * signal, its parent's or its job's end) is cancelled on the tab, but its hook may still be running
 * there, and the tab runs one root callback at a time: it keeps the lane (no queued root is
 * dispatched, children are not held) until the tab reports it drained (`drained`, the HTTP route; or
 * a late valid answer of it on the job's socket) or `CANCELLED_CALLBACK_DRAIN_MS` after the cancel.
 * A job's end does not release it: Stop in one chat must not let the tab's next root (another chat's
 * job) arrive while the stopped hook still runs.
 * A never-dispatched root gets neither a cancel frame nor a drain hold when it settles.
 */
export function createChannelHub(options: { now?: () => number } = {}) {
    const now = options.now ?? Date.now;
    const lanes = new Map<string, ClientLane>();
    const attachSends = new Map<string, OrderedSend[]>();
    const deferredPumps = new Set<string>();

    function laneOf(clientId: string): ClientLane {
        let lane = lanes.get(clientId);
        if (!lane) {
            lane = { queue: [], stack: [], draining: new Map() };
            lanes.set(clientId, lane);
        }
        return lane;
    }

    function settle(request: Request, result: QuestionResult | CallbackResult, notifyClient: boolean) {
        if (request.settled) {
            return;
        }
        request.channel.settling += 1;
        try {
            request.settled = true;
            request.chunkText = "";
            request.chunkAnswer = null;
            if (request.timer) {
                clearTimeout(request.timer);
                request.timer = null;
            }
            for (const child of [...request.children]) {
                settle(child, { outcome: "aborted", error: "The callback it ran inside ended" }, true);
            }
            const lane = laneOf(request.laneClientId ?? request.channel.transport.clientId);
            lane.queue = lane.queue.filter((entry) => entry !== request);
            lane.stack = lane.stack.filter((entry) => entry !== request);
            request.parent?.children.delete(request);
            request.channel.requests.delete(request);
            if (notifyClient && request.dispatched && request.delivered && request.kind === "callback") {
                holdDraining(lane, request);
            }
            if (notifyClient && request.dispatched) {
                try {
                    request.channel.transport.send({
                        type: "cancel",
                        epoch: request.channel.transport.epoch,
                        id: request.id,
                    });
                } catch (error) {
                    console.error("[Channel]", error);
                }
            }
            request.resolve(result);
            for (const listener of request.onSettled) {
                try {
                    listener();
                } catch (error) {
                    console.error("[Channel]", error);
                }
            }
            request.onSettled.clear();
            request.channel.transport.onSettled?.();
            pump(request.laneClientId ?? request.channel.transport.clientId);
        } finally {
            request.channel.settling -= 1;
        }
    }

    /** A gap or a held answer needs a snapshot from the owner, including after its reader finished. */
    function resyncChunks(request: Request) {
        try {
            request.channel.transport.send({
                type: "chunkResync",
                epoch: request.channel.transport.epoch,
                id: request.id,
            });
        } catch (error) {
            console.error("[Channel]", error);
        }
    }

    /** Keeps the lane for a cancelled callback the tab may still run (see the hub's comment). */
    function holdDraining(lane: ClientLane, request: Request) {
        const clientId = request.laneClientId!;
        const entry: Draining = { channel: request.channel, until: now() + CANCELLED_CALLBACK_DRAIN_MS, timer: null };
        lane.draining.set(request.id, entry);
        // A wakeup only, as for a deadline: `releaseDue` compares the clock.
        const wake = () => {
            entry.timer = null;
            if (lane.draining.get(request.id) !== entry) {
                return;
            }
            if (now() >= entry.until) {
                pump(clientId);
                return;
            }
            entry.timer = setTimeout(wake, Math.max(1, entry.until - now()));
            entry.timer.unref?.();
        };
        entry.timer = setTimeout(wake, CANCELLED_CALLBACK_DRAIN_MS);
        entry.timer.unref?.();
    }

    /** Drops the draining holds whose bound passed; true while one still holds the lane. */
    function releaseDue(lane: ClientLane): boolean {
        for (const [id, entry] of lane.draining) {
            if (now() >= entry.until) {
                if (entry.timer) {
                    clearTimeout(entry.timer);
                }
                lane.draining.delete(id);
            }
        }
        return lane.draining.size > 0;
    }

    /** The tab reports the cancelled callback `id` of `channel` drained: it no longer holds the lane. */
    function releaseDraining(channel: ChannelState, id: string, clientId: string): boolean {
        const lane = lanes.get(clientId);
        const entry = lane?.draining.get(id);
        if (!lane || !entry || entry.channel !== channel) {
            return false;
        }
        if (entry.timer) {
            clearTimeout(entry.timer);
        }
        lane.draining.delete(id);
        pump(clientId);
        return true;
    }

    function absenceDeadline(request: Request): number {
        return Math.min(
            request.channel.transport.ownerAbsentDeadline?.() ?? Infinity,
            request.parent ? absenceDeadline(request.parent) : Infinity,
        );
    }

    function effectiveDeadline(request: Request): number {
        return Math.min(
            request.deadline,
            absenceDeadline(request),
            request.parent ? effectiveDeadline(request.parent) : Infinity,
        );
    }

    /** A wakeup only: every deadline check reads the clock and current owner absence again. */
    function armDeadline(request: Request) {
        const deadline = effectiveDeadline(request);
        if (request.timer) clearTimeout(request.timer);
        request.timer = null;
        if (request.settled || !Number.isFinite(deadline)) return;
        request.timer = setTimeout(
            () => {
                request.timer = null;
                if (!expireIfDue(request)) armDeadline(request);
            },
            Math.max(1, deadline - now()),
        );
    }

    /** The deadline decides, not the timer: an expired request settles as its timer would. */
    function expireIfDue(request: Request): boolean {
        if (request.settled) return true;
        const deadline = effectiveDeadline(request);
        if (request.settled || now() < deadline) {
            return request.settled;
        }
        const attached = request.channel.transport.ownerAttached();
        const disconnected = !attached || now() >= absenceDeadline(request);
        if (!attached && request.parent === null && request.dispatchedAt !== Infinity) {
            const lane = laneOf(request.laneClientId ?? request.channel.transport.clientId);
            const queued = lane.queue.filter(
                (entry) =>
                    !entry.settled &&
                    !entry.channel.closed &&
                    entry.channel.openedAt <= request.dispatchedAt &&
                    !entry.channel.transport.ownerAttached(),
            );
            // The expired root keeps the slot while these queued roots settle.
            for (const entry of queued) {
                settle(
                    entry,
                    { outcome: "disconnected", error: "No owner was connected when the request ahead of it expired" },
                    true,
                );
            }
        }
        settle(
            request,
            disconnected
                ? {
                      outcome: "disconnected",
                      error: "No owner was connected before the deadline",
                      ...(request.delivered ? { delivered: true as const } : {}),
                  }
                : { outcome: "timedOut", error: "No answer before the deadline" },
            true,
        );
        return true;
    }

    function dispatch(request: Request, lane: ClientLane, clientId: string) {
        request.laneClientId = clientId;
        // The deadline starts now: time spent behind other requests in the queue is not counted.
        request.dispatchedAt = now();
        request.deadline = request.dispatchedAt + request.timeoutMs;
        // Keep the slot through initial expiry, including settlement of ownerless queued roots.
        lane.stack.push(request);
        // Every dispatch path (a queued root, a child) stops here when the deadline passed (a zero
        // timeout, an overdue parent): an expired request never hydrates or sends.
        if (expireIfDue(request)) {
            return;
        }
        request.dispatched = true;
        const build = (replay: boolean) => request.makeBuild(request.id, effectiveDeadline(request))(replay);
        request.build = build;
        armDeadline(request);
        const send = () => {
            if (request.settled || request.build !== build || expireIfDue(request)) {
                return;
            }
            try {
                // Without an owner socket nothing was delivered: the attach sends it as a first delivery.
                request.delivered = request.channel.transport.send(build(false));
            } catch (error) {
                settle(
                    request,
                    request.kind === "callback"
                        ? { outcome: "aborted", error: `The callback could not be sent: ${String(error)}` }
                        : { outcome: "aborted", error: `The question could not be sent: ${String(error)}` },
                    false,
                );
            }
        };
        const sends = attachSends.get(clientId);
        if (sends) {
            sends.push({ order: request.order, send });
        } else {
            send();
        }
    }

    function pump(clientId: string) {
        if (deferredPumps.has(clientId)) return;
        const lane = laneOf(clientId);
        const draining = releaseDue(lane);
        while (!draining && lane.stack.length === 0 && lane.queue.length > 0) {
            if (lane.queue[0].channel.transferPending) break;
            const next = lane.queue.shift()!;
            if (!next.settled && !next.channel.closed) {
                dispatch(next, lane, clientId);
            }
        }
        if (lane.stack.length === 0 && lane.queue.length === 0 && lane.draining.size === 0) {
            lanes.delete(clientId);
        }
    }

    function enqueue(
        channel: ChannelState,
        kind: Request["kind"],
        build: (id: string, deadline: number) => (replay: boolean) => GenerationChannelEvent,
        timeoutMs: number,
        parentId: string | undefined,
        extra: { onChunk?: (text: string) => void; signal?: AbortSignal } = {},
    ): Promise<QuestionResult | CallbackResult> {
        return new Promise((resolve) => {
            channel.transport.beforeEnqueue?.();
            const { transport } = channel;
            if (channel.closed) {
                resolve({ outcome: "aborted", error: "The job has ended" });
                return;
            }
            const lane = laneOf(transport.clientId);
            let parent: Request | null = null;
            if (parentId !== undefined) {
                let top = lane.stack[lane.stack.length - 1];
                if (top && expireIfDue(top)) {
                    // An overdue parent is settled first; the child then has no parent to run in.
                    top = lane.stack[lane.stack.length - 1];
                }
                if (!top || top.id !== parentId || top.kind !== "callback" || lane.stack.length >= MAX_DEPTH) {
                    resolve({
                        outcome: "refused",
                        refusal: "nesting",
                        error: "A callback may run only inside the outstanding one, one level deep",
                    });
                    pump(transport.clientId);
                    return;
                }
                parent = top;
            } else if (lane.queue.length >= MAX_QUEUED_PER_CLIENT) {
                resolve({
                    outcome: "refused",
                    refusal: "queue",
                    error: "Too many requests are queued for this client",
                });
                return;
            }
            const request: Request = {
                id: randomUUID(),
                channel,
                kind,
                makeBuild: build,
                build: null,
                timeoutMs,
                deadline: Infinity,
                parent,
                children: new Set(),
                dispatched: false,
                dispatchedAt: Infinity,
                laneClientId: null,
                delivered: false,
                settled: false,
                timer: null,
                onSettled: new Set(),
                chunkText: "",
                chunkSeq: 0,
                chunkGap: false,
                chunkAnswer: null,
                resolve,
                order: ++earlyOrder,
                ...(extra.onChunk ? { onChunk: extra.onChunk } : {}),
            };
            channel.requests.add(request);
            parent?.children.add(request);
            if (extra.signal) {
                // The caller gave up (its request ended): the callback ends and the tab is told.
                const signal = extra.signal;
                const onAbort = () => settle(request, { outcome: "aborted", error: "The request ended" }, true);
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
                request.onSettled.add(() => signal.removeEventListener("abort", onAbort));
            }
            if (parent) {
                dispatch(request, lane, transport.clientId);
            } else {
                lane.queue.push(request);
                armDeadline(request);
                pump(transport.clientId);
            }
        });
    }

    return {
        /** Opens the channel of one job. The registry passes answers, attaches, and the job's end to it. */
        open(initialTransport: ChannelTransport) {
            let ownerClientId = initialTransport.clientId;
            // Private mutable identity: callers transfer through the link, never by mutating a transport.
            const transport: ChannelTransport = {
                ...initialTransport,
                get clientId() {
                    return ownerClientId;
                },
            };
            const state: ChannelState = {
                transport,
                openedAt: now(),
                requests: new Set(),
                closed: false,
                transferPending: false,
                settling: 0,
                attachedAudiences: new Set(),
                early: [],
                earlyBytes: 0,
            };

            const channel: JobChannel = {
                notice(notice) {
                    transport.flushPending?.();
                    if (state.closed) {
                        return;
                    }
                    const event = { type: "notice", epoch: transport.epoch, ...notice } as Extract<
                        GenerationChannelEvent,
                        { type: "notice" }
                    >;
                    const audience = transport.noticeAudience?.(notice) ?? "owner";
                    if (
                        !state.attachedAudiences.has(audience) &&
                        (transport.noticeAudience || !transport.ownerAttached())
                    ) {
                        const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
                        if (state.earlyBytes + bytes <= MAX_EARLY_NOTICE_BYTES) {
                            state.early.push({ order: ++earlyOrder, event, bytes });
                            state.earlyBytes += bytes;
                        }
                        return;
                    }
                    transport.send(event);
                },
                ask(question, options = {}) {
                    transport.flushPending?.();
                    // Serialized now, so an unsendable payload throws here and never occupies a slot.
                    JSON.stringify(question);
                    return enqueue(
                        state,
                        "question",
                        (id, deadline) => (replay) => ({
                            type: "question",
                            epoch: transport.epoch,
                            id,
                            deadline,
                            ...(replay ? { replay: true as const } : {}),
                            ...question,
                        }),
                        options.timeoutMs ?? QUESTION_TIMEOUT_MS,
                        undefined,
                        options.signal ? { signal: options.signal } : undefined,
                    ) as Promise<QuestionResult>;
                },
                callback(name, payload, options = {}) {
                    transport.flushPending?.();
                    JSON.stringify(payload);
                    if (!hasHook(transport.hooks, name, payload)) {
                        return Promise.resolve({
                            outcome: "refused",
                            refusal: "unregistered",
                            error: `The client did not register ${name} for this job`,
                        });
                    }
                    return enqueue(
                        state,
                        "callback",
                        (id, deadline) => (replay) => ({
                            type: "callback",
                            epoch: transport.epoch,
                            id,
                            jobId: transport.jobId,
                            ...(options.parentId ? { parentId: options.parentId } : {}),
                            name,
                            targets: transport.targets,
                            // The barrier: the job's changes so far reach the client first.
                            revisions: transport.hydrate(),
                            payload,
                            ...(options.onChunk ? { chunks: "append" as const } : {}),
                            deadline,
                            ...(replay ? { replay: true as const } : {}),
                        }),
                        options.timeoutMs ?? CALLBACK_TIMEOUT_MS,
                        options.parentId,
                        { onChunk: options.onChunk, signal: options.signal },
                    ) as Promise<CallbackResult>;
                },
            };

            function takeEarly(audiences: NoticeAudience[]) {
                for (const audience of audiences) state.attachedAudiences.add(audience);
                const taken: ChannelState["early"] = [];
                const remaining: ChannelState["early"] = [];
                let takenBytes = 0;
                for (const entry of state.early) {
                    if (audiences.includes(transport.noticeAudience?.(entry.event) ?? "owner")) {
                        taken.push(entry);
                        takenBytes += entry.bytes;
                    } else {
                        remaining.push(entry);
                    }
                }
                state.early = remaining;
                state.earlyBytes -= takenBytes;
                return taken;
            }

            return {
                channel,
                get closed() {
                    return state.closed;
                },
                /** Includes listener calls and child settlement, before any runner continuation. */
                get settling() {
                    return state.settling > 0;
                },
                hasDeliveredRequests() {
                    return [...state.requests].some((request) => request.delivered && !request.settled);
                },
                deferTransfer(pending: boolean) {
                    state.transferPending = pending;
                    if (!pending) pump(transport.clientId);
                },
                /**
                 * Called only at a safe boundary. Migration is synchronous: neither lane pumps
                 * until all undelivered dispatches and queued requests have changed lanes. Build
                 * identity invalidates sends collected by an attach before this move.
                 */
                transferOwner(clientId: string, audiences?: NoticeAudience[]): boolean {
                    if (
                        state.closed ||
                        state.settling > 0 ||
                        [...state.requests].some((request) => request.delivered && !request.settled)
                    )
                        return false;
                    const oldId = transport.clientId;
                    const oldLane = laneOf(oldId);
                    const moving = [...state.requests]
                        .filter((request) => !request.settled && !request.delivered)
                        .sort((a, b) => Number(b.dispatched) - Number(a.dispatched) || a.order - b.order);
                    const moved = new Set(moving);
                    oldLane.stack = oldLane.stack.filter((request) => !moved.has(request));
                    oldLane.queue = oldLane.queue.filter((request) => !moved.has(request));
                    for (const request of moving) {
                        if (request.timer) clearTimeout(request.timer);
                        request.timer = null;
                        request.dispatched = false;
                        request.dispatchedAt = Infinity;
                        request.deadline = Infinity;
                        request.laneClientId = null;
                        request.build = null;
                    }
                    ownerClientId = clientId;
                    state.transferPending = false;
                    laneOf(clientId).queue.unshift(...moving);
                    for (const request of moving) armDeadline(request);
                    if (clientId !== oldId) pump(oldId);
                    if (audiences) this.handleAttach(audiences);
                    else pump(clientId);
                    return true;
                },

                /** Owner presence changed: children also inherit the parent's new absence bound. */
                ownerChanged() {
                    const lane = lanes.get(transport.clientId);
                    if (!lane) return;
                    for (const request of [...lane.stack, ...lane.queue]) {
                        if (!request.settled) armDeadline(request);
                    }
                },

                /** Settle before an attach clears absence, without consuming notices or replaying. */
                expireOverdue() {
                    const clientId = transport.clientId;
                    const deferred = deferredPumps.has(clientId);
                    deferredPumps.add(clientId);
                    try {
                        for (const request of [...state.requests]) {
                            expireIfDue(request);
                        }
                    } finally {
                        if (!deferred) {
                            deferredPumps.delete(clientId);
                            queueMicrotask(() => pump(clientId));
                        }
                    }
                },

                /** An owner message: an answer to an outstanding request of this job (anything else is ignored). */
                handleMessage(message: unknown) {
                    if (
                        !isPlainObject(message) ||
                        (message.type !== "answer" && message.type !== "chunk") ||
                        typeof message.id !== "string"
                    ) {
                        return;
                    }
                    const request = [...state.requests].find(
                        (entry) => entry.id === message.id && entry.dispatched && !entry.settled,
                    );
                    if (!request || expireIfDue(request)) {
                        // A valid answer of a callback the server stopped waiting for (now or before):
                        // its hook is over, so its draining hold (if any) ends.
                        if (message.type === "answer" && readAnswer("callback", message)) {
                            releaseDraining(state, message.id, transport.clientId);
                        }
                        return;
                    }
                    if (message.type === "chunk") {
                        // Validate the entire frame before changing reconstruction or gap state.
                        const snapshot = Object.hasOwn(message, "text");
                        const append = Object.hasOwn(message, "append");
                        const sequenced = Object.hasOwn(message, "seq");
                        if (
                            !request.onChunk ||
                            snapshot === append ||
                            (snapshot ? typeof message.text !== "string" : typeof message.append !== "string") ||
                            (append && !sequenced) ||
                            (sequenced &&
                                (typeof message.seq !== "number" ||
                                    !Number.isSafeInteger(message.seq) ||
                                    message.seq < 0))
                        ) {
                            return;
                        }
                        const seq = sequenced ? (message.seq as number) : request.chunkSeq;
                        if (snapshot && seq < request.chunkSeq) return;
                        if (append && (request.chunkGap || seq !== request.chunkSeq + 1)) {
                            if (!request.chunkGap) {
                                request.chunkGap = true;
                                resyncChunks(request);
                            }
                            return;
                        }
                        const text = (snapshot ? message.text : message.append) as string;
                        if ((snapshot ? 0 : request.chunkText.length) + text.length > MAX_PROVIDER_TEXT_CHARS) {
                            settle(
                                request,
                                { outcome: "failed", failure: "protocol", error: "The provider's text is too long" },
                                true,
                            );
                            return;
                        }
                        request.chunkText = snapshot ? text : request.chunkText + text;
                        request.chunkSeq = seq;
                        request.chunkGap = false;
                        try {
                            request.onChunk(request.chunkText);
                        } catch (error) {
                            console.error("[Channel]", error);
                        }
                        if (request.chunkAnswer?.seq === request.chunkSeq) {
                            settle(request, request.chunkAnswer.result, false);
                        }
                        return;
                    }
                    const result = readAnswer(request.kind, message);
                    if (result) {
                        if (
                            request.onChunk &&
                            result.outcome === "answered" &&
                            isPlainObject(result.value) &&
                            result.value.success === true &&
                            result.value.streamed === true &&
                            Object.hasOwn(result.value, "seq")
                        ) {
                            const seq = result.value.seq;
                            if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return;
                            if (request.chunkGap || seq !== request.chunkSeq) {
                                request.chunkAnswer = { seq, result };
                                resyncChunks(request);
                                return;
                            }
                        }
                        settle(request, result, false);
                    }
                },

                /**
                 * The owner attached: every outstanding request is sent, marked as a replay only when an
                 * owner socket took it before (it may have run on a page that is gone).
                 * Buffered notices, replays, and first deliveries promoted by expiry share the original
                 * request/notice order. A promoted request joins this batch once, through dispatch,
                 * rather than also being collected as an outstanding replay.
                 * Sort once, then insert arrivals into the unsent portion after any equal orders.
                 */
                handleAttach(audiences: NoticeAudience[] = ["owner", "all", "creator"]) {
                    const clientId = transport.clientId;
                    const early = takeEarly(audiences);
                    const active = attachSends.get(clientId);
                    const sends = active ?? [];
                    attachSends.set(clientId, sends);
                    try {
                        // Promotions during collection or delivery join the kept notices and replays.
                        sends.push(
                            ...early.map(({ order, event }) => ({
                                order,
                                send: () => {
                                    transport.send(event);
                                },
                            })),
                        );
                        // A promoted request is collected by dispatch, so snapshot before any expiry.
                        const outstanding = [...state.requests].filter((request) => request.dispatched);
                        for (const request of outstanding) {
                            if (request.settled || expireIfDue(request)) {
                                continue;
                            }
                            const build = request.build!;
                            sends.push({
                                order: request.order,
                                send: () => {
                                    // An earlier send may have settled it, or used up its time.
                                    if (request.settled || request.build !== build || expireIfDue(request)) {
                                        return;
                                    }
                                    const sent = transport.send(build(request.delivered));
                                    request.delivered ||= sent;
                                },
                            });
                        }
                        pump(clientId);
                        if (active) {
                            return;
                        }
                        sends.sort((a, b) => a.order - b.order);
                        for (let cursor = 0, sortedLength = sends.length; cursor < sends.length; cursor++) {
                            // Dispatch or a nested attach may append sends while the previous one runs.
                            while (sortedLength < sends.length) {
                                const entry = sends[sortedLength];
                                let low = cursor;
                                let high = sortedLength;
                                while (low < high) {
                                    const middle = low + Math.floor((high - low) / 2);
                                    if (sends[middle].order <= entry.order) low = middle + 1;
                                    else high = middle;
                                }
                                sends.splice(sortedLength, 1);
                                sends.splice(low, 0, entry);
                                sortedLength++;
                            }
                            const entry = sends[cursor];
                            try {
                                entry.send();
                            } catch (error) {
                                console.error("[Channel]", error);
                            }
                        }
                    } finally {
                        if (!active) {
                            attachSends.delete(clientId);
                        }
                    }
                },

                /** Drains only audiences present on this attach, retaining notices for the others. */
                takeEarly(audiences: NoticeAudience[] = ["owner", "all", "creator"]): GenerationChannelEvent[] {
                    return takeEarly(audiences).map(({ event }) => event);
                },

                /**
                 * `onSettled` runs once when the outstanding callback `id` of this job settles (an aux
                 * request from inside it, `POST /api/llm/request`, ends with it). Returns the
                 * unsubscribe, or `null` when no such callback is outstanding.
                 */
                watchCallback(id: string, onSettled: () => void): (() => void) | null {
                    const request = [...state.requests].find(
                        (entry) => entry.id === id && entry.kind === "callback" && entry.dispatched && !entry.settled,
                    );
                    if (!request || expireIfDue(request)) {
                        return null;
                    }
                    request.onSettled.add(onSettled);
                    return () => request.onSettled.delete(onSettled);
                },

                /**
                 * The tab reports the cancelled callback `id` of this job drained (`POST
                 * /api/generations/:id/drained`): the lane it kept is free. False when it holds none
                 * (answered, never delivered, released by its bound, or reported before).
                 */
                drained(id: string, clientId = transport.clientId): boolean {
                    return releaseDraining(state, id, clientId);
                },

                /** The job ends: every request of it is settled `aborted`. Idempotent. */
                close(reason: string) {
                    if (state.closed) {
                        return;
                    }
                    state.closed = true;
                    for (const request of [...state.requests]) {
                        settle(request, { outcome: "aborted", error: reason }, true);
                    }
                },
            };
        },
    };
}

/**
 * Shared by a registry's jobs (`server/src/jobs/generationJobs.ts`; the app has one registry in
 * `server/src/app.ts`), with one outstanding root per client in this hub. Drain holds are bounded
 * by CANCELLED_CALLBACK_DRAIN_MS and can expire without proof that the tab's callback finished.
 */
export type ChannelHub = ReturnType<typeof createChannelHub>;
