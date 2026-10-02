import { randomUUID } from "node:crypto";
import { isModelDescriptor } from "../../../shared/llm/validate.ts";
import {
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
} from "../../../shared/jobs.ts";

/** A question waits this long from the moment it is queued. */
export const QUESTION_TIMEOUT_MS = 120_000;
/** A callback waits this long from the moment it is queued (a `provider` callback: the caller's). */
export const CALLBACK_TIMEOUT_MS = 60_000;
/** Most requests one client may have queued. */
const MAX_QUEUED_PER_CLIENT = 256;
/** Outstanding requests one client may have: a callback and one child (an aux request's callback). */
const MAX_DEPTH = 2;

/** What the registry gives the channel of one job. */
export type ChannelTransport = {
    readonly jobId: string;
    readonly clientId: string;
    readonly epoch: string;
    readonly targets: CallbackTargets;
    readonly hooks: GenerationHooks;
    /**
     * Sends to the owner's current socket (works until the job's end has been sent). Returns whether
     * an open owner socket took the frame (it may have reached the client).
     */
    send(event: GenerationChannelEvent): boolean;
    /** Sends the job chat and every record the job sent, read now; returns what was sent. */
    hydrate(): HydrationReceipt[];
    ownerAttached(): boolean;
};

export type JobChannel = {
    notice(notice: GenerationNotice): void;
    ask(question: GenerationQuestion, options?: { timeoutMs?: number }): Promise<QuestionResult>;
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
    /** Builds the event to send; a callback hydrates first (the barrier). */
    build: (replay: boolean) => GenerationChannelEvent;
    deadline: number;
    parent: Request | null;
    children: Set<Request>;
    /** It holds the client's slot (it is the outstanding request, or a child of it). */
    dispatched: boolean;
    /** An open owner socket took it at least once: a later send is a replay. */
    delivered: boolean;
    settled: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    /** Called once when it settles (an aux request running inside this callback ends with it). */
    onSettled: Set<() => void>;
    /** A streaming `provider` callback: the owner's `chunk` messages (the cumulative text) go here. */
    onChunk?: (text: string) => void;
    resolve: (result: QuestionResult | CallbackResult) => void;
    /** When it was asked, against the notices kept before the first attach (`earlyOrder`). */
    order: number;
};

/** Orders the notices kept before a first attach against the requests made meanwhile. */
let earlyOrder = 0;

type ChannelState = {
    transport: ChannelTransport;
    requests: Set<Request>;
    closed: boolean;
    /**
     * Notices sent before an owner socket first attached (a job starts at once, its owner attaches
     * right after the create answer): kept, within `MAX_EARLY_NOTICE_BYTES`, and sent on that first
     * attach in their order among the requests made meanwhile, even after the job ended (the
     * registry takes them before the terminal), then null. After the first attach a notice nobody
     * receives is gone, as a notice is one way.
     */
    early: { order: number; event: GenerationChannelEvent }[] | null;
    earlyBytes: number;
};

/** The serialized size of the notices kept for an owner that has not attached yet; later ones are dropped. */
const MAX_EARLY_NOTICE_BYTES = 1024 * 1024;

type ClientLane = { queue: Request[]; stack: Request[] };

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
        case "mcpTool":
            return isPlainObject(payload) && hooks.mcpTools.includes(payload.identifier as string);
        case "generateImage":
        case "inlayImage":
        case "imggen":
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
 * The channel hub (`job-channel`): one per server, shared by every job. Per client it keeps a FIFO
 * of queued requests and a stack of outstanding ones: a request without a parent waits until the
 * client has none outstanding; a child (an aux request's callback, `parentId` = the client's
 * outstanding callback) runs at once, one level deep; anything else is refused. Notices are never
 * queued. Every request has one deadline from the moment it is queued, capped by its parent's; at
 * the deadline it is `timedOut` with an owner socket attached, else `disconnected`. A job's end
 * (`close`) settles its requests `aborted` and cancels their children.
 */
export function createChannelHub(options: { now?: () => number } = {}) {
    const now = options.now ?? Date.now;
    const lanes = new Map<string, ClientLane>();

    function laneOf(clientId: string): ClientLane {
        let lane = lanes.get(clientId);
        if (!lane) {
            lane = { queue: [], stack: [] };
            lanes.set(clientId, lane);
        }
        return lane;
    }

    function settle(request: Request, result: QuestionResult | CallbackResult, notifyClient: boolean) {
        if (request.settled) {
            return;
        }
        request.settled = true;
        if (request.timer) {
            clearTimeout(request.timer);
            request.timer = null;
        }
        for (const child of [...request.children]) {
            settle(child, { outcome: "aborted", error: "The callback it ran inside ended" }, true);
        }
        const lane = laneOf(request.channel.transport.clientId);
        lane.queue = lane.queue.filter((entry) => entry !== request);
        lane.stack = lane.stack.filter((entry) => entry !== request);
        request.parent?.children.delete(request);
        request.channel.requests.delete(request);
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
        pump(request.channel.transport.clientId);
    }

    /** The deadline decides, not the timer: an expired request settles as its timer would. */
    function expireIfDue(request: Request): boolean {
        if (request.settled || now() < request.deadline) {
            return request.settled;
        }
        settle(
            request,
            request.channel.transport.ownerAttached()
                ? { outcome: "timedOut", error: "No answer before the deadline" }
                : { outcome: "disconnected", error: "No owner was connected before the deadline" },
            true,
        );
        return true;
    }

    function dispatch(request: Request, lane: ClientLane) {
        // Every dispatch path (a queued root, a child) stops here when the deadline passed: an
        // expired request never hydrates or sends.
        if (expireIfDue(request)) {
            return;
        }
        request.dispatched = true;
        lane.stack.push(request);
        try {
            // Without an owner socket nothing was delivered: the attach sends it as a first delivery.
            request.delivered = request.channel.transport.send(request.build(false));
        } catch (error) {
            settle(
                request,
                request.kind === "callback"
                    ? { outcome: "aborted", error: `The callback could not be sent: ${String(error)}` }
                    : { outcome: "aborted", error: `The question could not be sent: ${String(error)}` },
                false,
            );
        }
    }

    function pump(clientId: string) {
        const lane = laneOf(clientId);
        while (lane.stack.length === 0 && lane.queue.length > 0) {
            const next = lane.queue.shift()!;
            if (!next.settled && !next.channel.closed && !expireIfDue(next)) {
                dispatch(next, lane);
            }
        }
        if (lane.stack.length === 0 && lane.queue.length === 0) {
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
            const id = randomUUID();
            const deadline = Math.min(now() + timeoutMs, parent?.deadline ?? Infinity);
            const request: Request = {
                id,
                channel,
                kind,
                build: build(id, deadline),
                deadline,
                parent,
                children: new Set(),
                dispatched: false,
                delivered: false,
                settled: false,
                timer: null,
                onSettled: new Set(),
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
            // A wakeup only: `expireIfDue` compares the clock, so a late timer and an early one agree.
            const wake = () => {
                if (!expireIfDue(request)) {
                    request.timer = setTimeout(wake, Math.max(1, request.deadline - now()));
                }
            };
            request.timer = setTimeout(wake, Math.max(0, deadline - now()));
            if (parent) {
                dispatch(request, lane);
            } else {
                lane.queue.push(request);
                pump(transport.clientId);
            }
        });
    }

    return {
        /** Opens the channel of one job. The registry passes answers, attaches, and the job's end to it. */
        open(transport: ChannelTransport) {
            const state: ChannelState = { transport, requests: new Set(), closed: false, early: [], earlyBytes: 0 };

            const channel: JobChannel = {
                notice(notice) {
                    if (state.closed) {
                        return;
                    }
                    const event = { type: "notice", epoch: transport.epoch, ...notice } as GenerationChannelEvent;
                    if (state.early && !transport.ownerAttached()) {
                        const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
                        if (state.earlyBytes + bytes <= MAX_EARLY_NOTICE_BYTES) {
                            state.early.push({ order: ++earlyOrder, event });
                            state.earlyBytes += bytes;
                        }
                        return;
                    }
                    transport.send(event);
                },
                ask(question, options = {}) {
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
                    ) as Promise<QuestionResult>;
                },
                callback(name, payload, options = {}) {
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
                            deadline,
                            ...(replay ? { replay: true as const } : {}),
                        }),
                        options.timeoutMs ?? CALLBACK_TIMEOUT_MS,
                        options.parentId,
                        { onChunk: options.onChunk, signal: options.signal },
                    ) as Promise<CallbackResult>;
                },
            };

            return {
                channel,

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
                        return;
                    }
                    if (message.type === "chunk") {
                        // A streaming provider's text so far: only for a callback that takes chunks,
                        // and bounded (anything else is ignored; a text too long fails the callback).
                        if (!request.onChunk || typeof message.text !== "string") {
                            return;
                        }
                        if (message.text.length > MAX_PROVIDER_TEXT_CHARS) {
                            settle(
                                request,
                                { outcome: "failed", failure: "protocol", error: "The provider's text is too long" },
                                true,
                            );
                            return;
                        }
                        try {
                            request.onChunk(message.text);
                        } catch (error) {
                            console.error("[Channel]", error);
                        }
                        return;
                    }
                    const result = readAnswer(request.kind, message);
                    if (result) {
                        settle(request, result, false);
                    }
                },

                /**
                 * The owner attached: every outstanding request is sent, marked as a replay only when an
                 * owner socket took it before (it may have run on a page that is gone).
                 */
                handleAttach() {
                    const early = state.early ?? [];
                    state.early = null;
                    state.earlyBytes = 0;
                    // The first attach: the kept notices and the waiting requests in the order made.
                    const sends: { order: number; send: () => void }[] = early.map(({ order, event }) => ({
                        order,
                        send: () => {
                            transport.send(event);
                        },
                    }));
                    for (const request of [...state.requests]) {
                        if (!request.dispatched || request.settled || expireIfDue(request)) {
                            continue;
                        }
                        sends.push({
                            order: request.order,
                            send: () => {
                                const sent = transport.send(request.build(request.delivered));
                                request.delivered ||= sent;
                            },
                        });
                    }
                    sends.sort((a, b) => a.order - b.order);
                    for (const entry of sends) {
                        try {
                            entry.send();
                        } catch (error) {
                            console.error("[Channel]", error);
                        }
                    }
                },

                /**
                 * The notices kept for an owner that never attached while the job ran (the registry
                 * sends them before the terminal of an ended job's first attach); empties the buffer.
                 */
                takeEarly(): GenerationChannelEvent[] {
                    const early = state.early ?? [];
                    state.early = null;
                    state.earlyBytes = 0;
                    return early.map(({ event }) => event);
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

export type ChannelHub = ReturnType<typeof createChannelHub>;
