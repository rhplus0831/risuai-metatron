import { v4 as uuidv4 } from "uuid";
import { language } from "src/lang";
import type { ChatBindingProblem } from "../../../shared/chatBinding.ts";
import type { OrphanedOverrideEntry } from "../../../shared/lore/overrides.ts";
import {
    type ChannelDrainedBody,
    type ChatResyncRequest,
    type ReplyResyncRequest,
    type GenerationPong,
    type GenerationCreateBody,
    type GenerationCreated,
    type GenerationCancelled,
    type GenerationCurrent,
    type GenerationStopBody,
    GENERATION_KINDS,
    GENERATION_STAGES,
    GENERATION_ID_PATTERN,
    type GenerationEvent,
    type GenerationStatus,
    type GenerationTerminalEvent,
} from "../../../shared/jobs.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import {
    applyServerGeneration,
    applyServerGenerationChunk,
    type ChatRef,
    chatHydrationHold,
    endServerJob,
    isChatStale,
} from "../storage/chatStore.svelte";
import { authFetch, getNodeServerProxyAuth } from "../storage/serverAuth";
import { epochMismatch, getResourceEpoch, ResourceRequestError } from "../storage/resourceClient";
import { applyHydration, applyPatchHydration, flushResources } from "../storage/resourceSync.svelte";
import type { ChannelTransport } from "./jobChannel";
import { watchResume, watchSocket } from "./socketLiveness";
import { recordClientEvent } from "../diagnostics/collector";
import { dropJobStage, setJobStage } from "../process/jobStages";

/**
 * The client transport of server generation jobs (`shared/jobs.ts`): create, status, abort, and the
 * owner socket. `applyGenerationEvent` mirrors events into `src/ts/storage/chatStore.svelte.ts` and
 * `src/ts/storage/resourceSync.svelte.ts` without outgoing writes. Its command and send callers are
 * in `src/ts/process/serverCommands.ts`.
 *
 * The tab's client id and saved jobs (one per chat) live in `sessionStorage`. The page claims the
 * identity before reading either, marking `risu-generation-client-claim` held. A copied held claim
 * (an opener's session or a duplicated tab) mints a new id and drops the copied jobs. `pagehide`
 * releases the claim, so a reload or same-tab navigation recovers it; `document.wasDiscarded` also
 * permits recovery. `pageshow` marks it held again. This is a synchronous storage claim, not a
 * live-page handshake: a copied released marker cannot distinguish two pages, and a killed page
 * without `pagehide` or `wasDiscarded` loses recovery. If storage fails, the page keeps an in-memory
 * id without exposing copied saved jobs.
 */

/**
 * The channel dispatcher (UI, plugin registries) loads on first use, so this transport stays free of
 * the UI modules. Its work runs on one chain, in the order the socket delivered the events.
 */
let dispatcher: Promise<typeof import("./jobChannel")> | null = null;
let channelWork: Promise<unknown> = Promise.resolve();
function onChannel(work: (channel: typeof import("./jobChannel")) => void) {
    dispatcher ??= import("./jobChannel");
    const loaded = dispatcher;
    // A callback queued here is plugin work until it reaches the channel's `outstanding` (in `work`).
    queuedChannelWork++;
    channelWork = channelWork
        .then(() => loaded)
        .then(work)
        .catch((error) => console.error("[Channel]", error))
        .finally(() => {
            queuedChannelWork--;
            notifyPluginWork();
        });
}

/*
 * Plugin work of this tab's jobs (`plugin-sandbox.md`): a job calls the hooks it listed at its
 * creation until it ends, so a plugin reload waits while any of these is held. A job is held from
 * before its hooks are listed (`createGenerationJob`) or from its follow (`followGenerationJob`),
 * and while it is saved for this tab (a reload resumes it), until `releaseGenerationJob`; a busy
 * job this tab may own, until its status read answers; queued channel work; and the channel's
 * running callbacks.
 */
let creatingJobs = 0;
const liveJobs = new Set<string>();
const busyJobs = new Map<string, Set<{ reading: boolean }>>();
let queuedChannelWork = 0;
let channelCallbacks = 0;
/** Holds taken by a follow for listeners it runs after its job ended (`replaySkippedListeners`). */
let replayHolds = 0;
const pluginWorkListeners = new Set<() => void>();

function notifyPluginWork() {
    for (const listener of [...pluginWorkListeners]) {
        try {
            listener();
        } catch (error) {
            console.error("[Generation]", error);
        }
    }
}

/** Whether a job of this tab may still call a plugin hook (see above). */
export function generationPluginWorkActive(): boolean {
    return (
        creatingJobs > 0 ||
        liveJobs.size > 0 ||
        busyJobs.size > 0 ||
        queuedChannelWork > 0 ||
        channelCallbacks > 0 ||
        replayHolds > 0 ||
        savedGenerationJobIds().length > 0
    );
}

/**
 * Keeps plugin work active past a job's release, for listeners the follow runs late; returns the
 * release (idempotent). Taken before the job's terminal is applied, so no reload slips in between.
 */
export function holdGenerationPluginWork(): () => void {
    replayHolds += 1;
    notifyPluginWork();
    let released = false;
    return () => {
        if (released) {
            return;
        }
        released = true;
        replayHolds -= 1;
        notifyPluginWork();
    };
}

/** Called after any of the above may have ended; returns the unsubscribe function. */
export function onGenerationPluginWork(listener: () => void): () => void {
    pluginWorkListeners.add(listener);
    return () => {
        pluginWorkListeners.delete(listener);
    };
}

/**
 * Whether the job channel runs a callback in this tab now (a hook or a provider). The
 * channel holds the tab's lane meanwhile, so a callback that waited for a new job of this tab would
 * wait for that job's own callbacks behind itself.
 */
export function channelCallbacksRunning(): boolean {
    return channelCallbacks > 0;
}

/** The job channel's count of running callbacks (`jobChannel.ts` `outstanding`). */
export function noteChannelCallbacks(count: number) {
    if (count === channelCallbacks) {
        return;
    }
    channelCallbacks = count;
    notifyPluginWork();
}

const CLIENT_ID_KEY = "risu-generation-client";
const JOBS_KEY = "risu-generation-jobs";
const CLIENT_CLAIM_KEY = "risu-generation-client-claim";

/** 409 `chatBusy`: the chat has a running job; its owner can attach to `jobId`. */
export class GenerationBusyError extends Error {
    readonly jobId: string;
    constructor(jobId: string) {
        super("This chat is generating a reply");
        this.name = "GenerationBusyError";
        this.jobId = jobId;
    }
}

/** 409 `stale`: the chat changed on the server since the revision sent. */
export class GenerationStaleError extends Error {
    constructor() {
        super("The chat changed on the server; reload it and send again");
        this.name = "GenerationStaleError";
    }
}

/**
 * 409 `chatBindingIncomplete` (with the chat's binding `problems`) or `chatBindingMismatch`: the job's
 * ids are not its chat's complete binding. This attempt was refused.
 */
export class ChatBindingRefusedError extends Error {
    readonly code: "chatBindingIncomplete" | "chatBindingMismatch";
    readonly problems: readonly ChatBindingProblem[];
    constructor(code: ChatBindingRefusedError["code"], problems: readonly ChatBindingProblem[] = []) {
        super(code === "chatBindingMismatch" ? "The chat's binding changed" : "The chat's binding is incomplete");
        this.name = "ChatBindingRefusedError";
        this.code = code;
        this.problems = problems;
    }
}

/** 409 `chatLoreOverrideOrphaned`: overrides lost their original owner entries; this attempt was refused. */
export class ChatLoreOverrideOrphanedError extends Error {
    readonly entries: readonly OrphanedOverrideEntry[];
    constructor(entries: readonly OrphanedOverrideEntry[]) {
        super("chatLoreOverrideOrphaned");
        this.name = "ChatLoreOverrideOrphanedError";
        this.entries = entries;
    }
}

function storage(): Storage | null {
    try {
        return globalThis.sessionStorage ?? null;
    } catch {
        return null;
    }
}

let fallbackClientId: string | null = null;
let claimedStorage: Storage | null = null;

/** A copied live page's session belongs to a new owner; a released or discarded page can recover. */
function claimGenerationIdentity() {
    if (fallbackClientId) return;
    const store = storage();
    try {
        const copied =
            store?.getItem(CLIENT_CLAIM_KEY) === "held" &&
            !(typeof document !== "undefined" && "wasDiscarded" in document && document.wasDiscarded === true);
        fallbackClientId = (!copied && store?.getItem(CLIENT_ID_KEY)) || uuidv4();
        if (copied) store?.removeItem(JOBS_KEY);
        store?.setItem(CLIENT_ID_KEY, fallbackClientId);
        store?.setItem(CLIENT_CLAIM_KEY, "held");
        claimedStorage = store;
    } catch {
        // Failed storage must not expose copied jobs under the page's in-memory identity.
        fallbackClientId ??= uuidv4();
    }
}

function markGenerationIdentity(state: "held" | "released") {
    try {
        claimedStorage?.setItem(CLIENT_CLAIM_KEY, state);
    } catch {}
}

if (typeof window !== "undefined") {
    claimGenerationIdentity();
    window.addEventListener("pagehide", () => markGenerationIdentity("released"));
    window.addEventListener("pageshow", () => markGenerationIdentity("held"));
}

/** This tab's id, created once and kept across reloads of the tab. */
export function generationClientId(): string {
    claimGenerationIdentity();
    return fallbackClientId!;
}

/** Ids may contain `/`, so the saved key is a JSON pair. */
const chatKey = (ref: ChatRef) => JSON.stringify([ref.chaId, ref.chatId]);

function readSavedJobs(): Record<string, string> {
    claimGenerationIdentity();
    try {
        const parsed = JSON.parse(claimedStorage?.getItem(JOBS_KEY) ?? "{}") as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
    } catch {
        return {};
    }
}

function writeSavedJobs(jobs: Record<string, string>) {
    claimGenerationIdentity();
    try {
        claimedStorage?.setItem(JOBS_KEY, JSON.stringify(jobs));
    } catch {}
}

/** The saved jobs of this tab, by chat (`JSON.stringify([chaId, chatId])` → job id). */
export function savedGenerationJobs(): Record<string, string> {
    return readSavedJobs();
}

/** This tab's saved jobs (one per chat), as `rememberGenerationJob` keeps them. */
export function savedGenerationJobIds(): string[] {
    return [...new Set(Object.values(readSavedJobs()))];
}

/** Keeps one resumable job per chat of this tab; a new job replaces that chat's saved id. */
export function rememberGenerationJob(ref: ChatRef, jobId: string) {
    writeSavedJobs({ ...readSavedJobs(), [chatKey(ref)]: jobId });
}

/** Removes this job from every saved chat entry without removing a chat's replacement job. */
export function forgetGenerationJob(jobId: string) {
    const jobs = readSavedJobs();
    for (const [key, id] of Object.entries(jobs)) {
        if (id === jobId) {
            delete jobs[key];
        }
    }
    writeSavedJobs(jobs);
}

type FailureBody = {
    error?: string;
    jobId?: string;
    epoch?: string;
    problems?: ChatBindingProblem[];
    entries?: unknown;
};

async function failure(response: Response): Promise<never> {
    let body: { error?: string; jobId?: string; epoch?: string; problems?: ChatBindingProblem[]; entries?: unknown } =
        {};
    try {
        const parsed = await response.json();
        if (parsed && typeof parsed === "object") {
            body = parsed;
        }
    } catch {}
    return failAnswer(response.status, body);
}

function failAnswer(status: number, body: FailureBody): never {
    if (status === 409 && body.error === "chatBusy" && typeof body.jobId === "string") {
        throw new GenerationBusyError(body.jobId);
    }
    if (status === 409 && body.error === "stale") {
        throw new GenerationStaleError();
    }
    if (status === 409 && (body.error === "chatBindingIncomplete" || body.error === "chatBindingMismatch")) {
        throw new ChatBindingRefusedError(body.error, Array.isArray(body.problems) ? body.problems : []);
    }
    if (status === 409 && body.error === "chatLoreOverrideOrphaned") {
        const entries = Array.isArray(body.entries)
            ? body.entries
                  .filter(
                      (entry): entry is OrphanedOverrideEntry =>
                          entry !== null &&
                          typeof entry === "object" &&
                          typeof entry.id === "string" &&
                          typeof entry.name === "string",
                  )
                  .map(({ id, name }) => ({ id, name }))
            : [];
        throw new ChatLoreOverrideOrphanedError(entries);
    }
    if (status === 412 && body.error === "EpochMismatch") {
        // The restore notice and reload, as for any other resource request.
        throw epochMismatch(body.epoch ?? "");
    }
    throw new ResourceRequestError(status, body.error ?? `Request failed (${status})`);
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
        response = await authFetch(path, { ...init, cache: "no-store" });
    } catch (error) {
        throw new ResourceRequestError(0, error instanceof Error ? error.message : String(error));
    }
    return response.ok ? response : failure(response);
}

/** The create exchange's refusal, retaining whether an earlier dispatched attempt is unresolved. */
export class GenerationCreateError extends Error {
    readonly uncertain: boolean;
    override readonly cause: unknown;
    constructor(cause: unknown, uncertain: boolean) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = "GenerationCreateError";
        this.cause = cause;
        this.uncertain = uncertain;
    }
}

type CreateInput = GenerationCreateBody extends infer T ? (T extends unknown ? Omit<T, "clientId"> : never) : never;
/** One create exchange: a new job, a replay classified by ownership, or a confirmed cancellation. */
export type GenerationCreateResult =
    | { outcome: "created"; jobId: string }
    | { outcome: "replayed"; jobId: string; owned: boolean; status: GenerationStatus | null; cancelled?: true }
    | { outcome: "cancelled" };

type CreateOptions = { signal?: AbortSignal; requestUncertain?: boolean };
const CREATE_DELAYS_MS = [1000, 2000, 4000];
const CREATE_DEADLINE_MS = 10_000;

function noAnswer(error: unknown): ResourceRequestError {
    return new ResourceRequestError(0, error instanceof Error ? error.message : String(error));
}

/** Bounds authentication and body consumption too; a late auth completion cannot dispatch. */
async function boundedAttempt<T>(
    work: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    timeoutMessage = "The generation request timed out",
): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
        stop = () => {
            controller.abort();
            reject(noAnswer("The generation request was stopped"));
        };
        timer = setTimeout(() => {
            controller.abort();
            reject(noAnswer(timeoutMessage));
        }, CREATE_DEADLINE_MS);
        signal?.addEventListener("abort", stop, { once: true });
        if (signal?.aborted) stop();
    });
    try {
        return await Promise.race([interrupted, work(controller.signal)]);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        controller.abort();
    }
}

async function retryWait(ms: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const stop = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", stop);
            reject(noAnswer("The generation request was stopped"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", stop);
            resolve();
        }, ms);
        signal?.addEventListener("abort", stop, { once: true });
        if (signal?.aborted) stop();
    });
}

function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validStatus(value: unknown, jobId: string): value is GenerationStatus | null {
    if (value === null) return true;
    if (!object(value) || value.jobId !== jobId) return false;
    if (value.state === "running") return true;
    return (
        value.state === "ended" &&
        object(value.terminal) &&
        (value.terminal.type === "done" || value.terminal.type === "error")
    );
}

function validCreated(value: unknown): value is GenerationCreated {
    if (!object(value) || typeof value.jobId !== "string" || !GENERATION_ID_PATTERN.test(value.jobId)) return false;
    return value.replayed === true
        ? typeof value.owned === "boolean" && validStatus(value.status, value.jobId)
        : value.replayed === undefined || value.replayed === false;
}

function validCancelled(value: unknown): value is GenerationCancelled {
    return (
        object(value) &&
        (value.state === "cancelled" ||
            ((value.state === "aborted" || value.state === "ended") &&
                typeof value.jobId === "string" &&
                GENERATION_ID_PATTERN.test(value.jobId) &&
                typeof value.owned === "boolean" &&
                validStatus(value.status, value.jobId)))
    );
}

/** Registry identity evidence or a permanent chat refusal resolves earlier create uncertainty. */
function registryRefusal(status: number, body: FailureBody): boolean {
    if (status === 409) {
        return ["stale", "chatBindingMismatch", "requestIdReused", "requestCancelled"].includes(body.error ?? "");
    }
    return status === 404 && body.error === "Chat not found";
}

function validFailure(status: number, body: unknown): body is FailureBody {
    if (!object(body) || typeof body.error !== "string") return false;
    if (status === 412 && body.error === "EpochMismatch") return typeof body.epoch === "string";
    if (status === 409 && body.error === "chatBusy") {
        return typeof body.jobId === "string" && GENERATION_ID_PATTERN.test(body.jobId);
    }
    return true;
}

/** Retries an unanswered frozen request within bounded attempts, until an answer fences delayed creates. */
async function exchange<T>(options: {
    path: string;
    body: string;
    epoch: string;
    valid: (body: unknown) => body is T;
    signal?: AbortSignal;
    dispatched?: () => void;
    uncertain: boolean;
    cancelling?: boolean;
}): Promise<T> {
    let uncertain = options.uncertain;
    for (let attempt = 0; ; attempt++) {
        let answer: { status: number; ok: boolean; body: unknown };
        try {
            if (attempt > 0) await retryWait(CREATE_DELAYS_MS[attempt - 1], options.signal);
            answer = await boundedAttempt(async (signal) => {
                const response = await authFetch(
                    options.path,
                    {
                        method: "POST",
                        cache: "no-store",
                        signal,
                        headers: { "content-type": "application/json", [RESOURCE_EPOCH_HEADER]: options.epoch },
                        body: options.body,
                    },
                    {
                        beforeDispatch: () => {
                            if (signal.aborted) throw noAnswer("The generation request was stopped");
                            options.dispatched?.();
                        },
                    },
                );
                const body: unknown = await response.json();
                if (response.ok ? !options.valid(body) : !validFailure(response.status, body)) {
                    throw noAnswer("The server returned an incomplete generation answer");
                }
                return { status: response.status, ok: response.ok, body };
            }, options.signal);
        } catch (error) {
            uncertain = true;
            if (options.signal?.aborted || attempt === CREATE_DELAYS_MS.length) {
                throw new GenerationCreateError(noAnswer(error), true);
            }
            continue;
        }
        if (answer.ok) return answer.body as T;
        const body = answer.body as FailureBody;
        try {
            failAnswer(answer.status, body);
        } catch (error) {
            if (options.cancelling || (uncertain && !registryRefusal(answer.status, body))) {
                throw new GenerationCreateError(error, true);
            }
            throw error;
        }
    }
}

/** Saves, stages and holds fresh creations and owned replays with a usable status, after classification. */
function rememberCreated(result: GenerationCreateResult, ref: ChatRef): GenerationCreateResult {
    if (result.outcome === "cancelled" || (result.outcome === "replayed" && (!result.owned || result.status === null)))
        return result;
    setJobStage(result.jobId, ref, "preparing", { onlyIfMissing: true });
    rememberGenerationJob(ref, result.jobId);
    liveJobs.add(result.jobId);
    return result;
}

/** Cancels this request with its frozen client and epoch, using an independent retry budget; an admitted job is a replay. */
async function cancelRequest(requestId: string, clientId: string, epoch: string): Promise<GenerationCreateResult> {
    const result = await exchange({
        path: "/api/generations/cancel",
        body: JSON.stringify({ requestId, clientId }),
        epoch,
        valid: validCancelled,
        uncertain: true,
        cancelling: true,
    });
    return result.state === "cancelled"
        ? { outcome: "cancelled" }
        : {
              outcome: "replayed",
              jobId: result.jobId,
              owned: result.owned,
              status: result.status,
              cancelled: true,
          };
}

/** Cancels a previously unanswered attempt, including when this invocation never dispatched a create. */
export async function cancelGenerationRequest(requestId: string, ref: ChatRef): Promise<GenerationCreateResult> {
    creatingJobs++;
    try {
        return rememberCreated(await cancelRequest(requestId, generationClientId(), getResourceEpoch()), ref);
    } finally {
        creatingJobs--;
        notifyPluginWork();
    }
}

/**
 * Creates or replays one frozen request for `body.context`'s chat, remembering only an owned job;
 * hooks default to `registeredHooks` in `src/ts/network/jobChannel.ts`.
 * Refusals distinguish `GenerationBusyError`, `GenerationStaleError`, `ChatBindingRefusedError`
 * (409 `chatBindingIncomplete` or `chatBindingMismatch`), and `ChatLoreOverrideOrphanedError`;
 * an epoch mismatch uses `epochMismatch` in `src/ts/storage/resourceClient.ts`. An uncertain
 * exchange wraps its cause in `GenerationCreateError` so the caller can resolve admission first.
 */
export async function createGenerationJob(
    body: CreateInput,
    options: CreateOptions = {},
): Promise<GenerationCreateResult> {
    creatingJobs++;
    try {
        const requestId = body.requestId ?? uuidv4();
        const clientId = generationClientId();
        const epoch = getResourceEpoch();
        const ref = { chaId: body.context.characterId, chatId: body.context.chatId };
        let dispatched = options.requestUncertain === true;
        let prepared = false;
        let result: GenerationCreateResult;
        try {
            const frozen = await boundedAttempt(async () => {
                let hooks = body.hooks;
                let context = body.context;
                if (!hooks) {
                    // The tab's own job: its registered hooks, and the emotions it showed last (the server's
                    // emotion modes penalize a recent choice as the tab's do).
                    const channel = await import("./jobChannel");
                    // The job's model preset (its chat's binding), not the settings views'.
                    const { presetId, modelPresetId } = context;
                    hooks = await channel.registeredHooks(
                        presetId !== null && modelPresetId !== null ? { presetId, modelPresetId } : undefined,
                    );
                    if (context.client && !context.client.emotions) {
                        context = {
                            ...context,
                            client: { ...context.client, emotions: channel.recentEmotions(context.characterId) },
                        };
                    }
                }
                return JSON.stringify({ ...body, context, hooks, requestId, clientId });
            }, options.signal);
            prepared = true;
            const answer = await exchange({
                path: "/api/generations",
                body: frozen,
                epoch,
                valid: validCreated,
                signal: options.signal,
                dispatched: () => {
                    dispatched = true;
                },
                uncertain: options.requestUncertain === true,
            });
            if (options.signal?.aborted) throw noAnswer("The generation request was stopped");
            result = answer.replayed ? { ...answer, outcome: "replayed" } : { outcome: "created", jobId: answer.jobId };
        } catch (error) {
            if (!options.signal?.aborted) {
                throw prepared ? error : new GenerationCreateError(error, dispatched);
            }
            result = dispatched ? await cancelRequest(requestId, clientId, epoch) : { outcome: "cancelled" };
        }
        return rememberCreated(result, ref);
    } catch (error) {
        const cause = error instanceof GenerationCreateError ? error.cause : error;
        if (cause instanceof GenerationBusyError && !(error instanceof GenerationCreateError && error.uncertain)) {
            // Maybe this tab's own job (the caller reads its status, then follows it).
            let reservations = busyJobs.get(cause.jobId);
            if (!reservations) {
                reservations = new Set();
                busyJobs.set(cause.jobId, reservations);
            }
            reservations.add({ reading: false });
        }
        throw error;
    } finally {
        creatingJobs--;
        notifyPluginWork();
    }
}

const jobPath = (jobId: string) =>
    `/api/generations/${encodeURIComponent(jobId)}?clientId=${encodeURIComponent(generationClientId())}`;

/** Reads the chat slot without following, saving, or holding the job live in this tab. */
export async function readChatGeneration(ref: ChatRef): Promise<GenerationCurrent | null> {
    const query = new URLSearchParams({ characterId: ref.chaId, chatId: ref.chatId, clientId: generationClientId() });
    try {
        const body: unknown = await boundedAttempt(
            async (signal) => (await request(`/api/generations/current?${query}`, { signal })).json(),
            undefined,
            language.serverJob.stopOther.lookupTimedOut,
        );
        if (
            !object(body) ||
            typeof body.jobId !== "string" ||
            !GENERATION_ID_PATTERN.test(body.jobId) ||
            !GENERATION_KINDS.some((kind) => kind === body.kind) ||
            typeof body.owned !== "boolean" ||
            (body.stage !== undefined && !GENERATION_STAGES.some((stage) => stage === body.stage)) ||
            (body.sequence !== undefined &&
                (!object(body.sequence) ||
                    !Number.isSafeInteger(body.sequence.total) ||
                    (body.sequence.total as number) < 1 ||
                    !Number.isSafeInteger(body.sequence.sent) ||
                    (body.sequence.sent as number) < 0 ||
                    (body.sequence.sent as number) > (body.sequence.total as number)))
        ) {
            throw new ResourceRequestError(0, language.serverJob.stopOther.invalidCurrent);
        }
        return body as GenerationCurrent;
    } catch (error) {
        if (error instanceof ResourceRequestError && error.status === 404) return null;
        throw error;
    }
}

/** Stops exactly the named current job; a changed slot requires a fresh confirmation. */
export async function stopChatGeneration(ref: ChatRef, jobId: string): Promise<"stopped" | "idle" | "changed"> {
    const body: GenerationStopBody = {
        characterId: ref.chaId,
        chatId: ref.chatId,
        jobId,
        clientId: generationClientId(),
    };
    try {
        const answer: unknown = await boundedAttempt(
            async (signal) =>
                (
                    await request("/api/generations/stop", {
                        method: "POST",
                        signal,
                        headers: { "content-type": "application/json", [RESOURCE_EPOCH_HEADER]: getResourceEpoch() },
                        body: JSON.stringify(body),
                    })
                ).json(),
            undefined,
            language.serverJob.stopOther.stopTimedOut,
        );
        if (!object(answer) || typeof answer.aborted !== "boolean") {
            throw new ResourceRequestError(0, language.serverJob.stopOther.invalidStop);
        }
        return "stopped";
    } catch (error) {
        if (error instanceof ResourceRequestError) {
            if (error.status === 404 && error.message === "idle") return "idle";
            if (error.status === 409 && error.message === "jobChanged") return "changed";
        }
        throw error;
    }
}

/**
 * This tab's job (or its kept outcome, `kept`, once the server collected it), or null when the server
 * does not know it (ended long ago, the server restarted, or another tab's). `deadlineMs` bounds the
 * whole read (authentication, request, and body): past it the request is aborted and the read fails
 * as a request without an answer (`ResourceRequestError` status 0).
 */
export async function readGenerationJob(
    jobId: string,
    options: { deadlineMs?: number } = {},
): Promise<GenerationStatus | null> {
    const reservations = busyJobs.get(jobId);
    const reservation = reservations && [...reservations].find((entry) => !entry.reading);
    if (reservation) {
        reservation.reading = true;
    }
    let status: GenerationStatus | null = null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const read = (async () =>
            (await (await request(jobPath(jobId), { signal: controller.signal })).json()) as GenerationStatus)();
        if (options.deadlineMs === undefined) {
            status = await read;
        } else {
            // A late answer after the deadline is dropped (the read already failed).
            read.catch(() => {});
            status = await Promise.race([
                read,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        controller.abort();
                        reject(new ResourceRequestError(0, "The job's status read timed out"));
                    }, options.deadlineMs);
                }),
            ]);
        }
        return status;
    } catch (error) {
        if (error instanceof ResourceRequestError && error.status === 404) {
            return null;
        }
        throw error;
    } finally {
        // Each read decides only its reservation. Release invalidates the whole set, including late reads.
        if (reservation && reservations && busyJobs.get(jobId) === reservations && reservations.delete(reservation)) {
            if (status?.state === "running" && status.epoch === getResourceEpoch()) {
                liveJobs.add(jobId);
            }
            if (reservations.size === 0) {
                busyJobs.delete(jobId);
            }
            notifyPluginWork();
        }
        clearTimeout(timer);
    }
}

/**
 * Aborts this tab's job (the server persists the text so far). Bounded like the other control
 * requests (`CREATE_DEADLINE_MS`): a Stop whose request hangs fails instead of staying pending.
 */
export async function abortGenerationJob(jobId: string): Promise<void> {
    try {
        await boundedAttempt(
            (signal) => request(jobPath(jobId), { method: "DELETE", signal }),
            undefined,
            "The stop request timed out",
        );
    } catch (error) {
        if (!(error instanceof ResourceRequestError && error.status === 404)) {
            throw error;
        }
    }
}

/**
 * Tells the server that the callback `callbackId` of this tab's job `jobId`, which the server
 * cancelled, no longer runs here: the channel lane it kept for this tab is free (`ChannelDrainedBody`).
 * Over HTTP, since the job's socket closes at its end. A failure is only logged: the server's bound
 * (`CANCELLED_CALLBACK_DRAIN_MS`) frees the lane without it.
 */
export async function reportCallbackDrained(jobId: string, callbackId: string): Promise<void> {
    const body: ChannelDrainedBody = { callbackId };
    try {
        await request(
            `/api/generations/${encodeURIComponent(jobId)}/drained?clientId=${encodeURIComponent(generationClientId())}`,
            { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
        );
    } catch (error) {
        if (!(error instanceof ResourceRequestError && error.status === 404)) {
            console.error("[Channel]", error);
        }
    }
}

/** One owner-socket attachment, with separate open and close outcomes; closing does not release the job. */
export type GenerationFollow = {
    /** Sends a JSON message to the job (`src/ts/network/jobChannel.ts` answers); false while closed or not yet open. */
    send(message: unknown): boolean;
    close(): void;
    /**
     * Resolves when the socket closes, with the terminal event if one arrived. `resumed`: the follow
     * gave up a socket that had opened because the page came back (`watchResume`), not because the
     * link failed. `received`: the socket delivered at least one frame (a ping included), so the
     * server was reached through it.
     */
    closed: Promise<{ terminal: GenerationTerminalEvent | null; resumed?: boolean; received?: boolean }>;
    /** True once the socket opened; false when the follow settled before it opened. */
    opened: Promise<boolean>;
};

/** The newest follow of each job: a newer follow cancels the older one (its socket, events, and sends). */
const currentFollows = new Map<string, { cancel(): void }>();

/** Orders this tab's attaches across reloads (a later page's stamp is higher): the server keeps the newest. */
let lastStamp = 0;
function attachStamp(): number {
    const now = performance.timeOrigin + performance.now();
    lastStamp = Math.max(now, lastStamp + 0.001);
    return lastStamp;
}

/**
 * Follows a job over its owner socket with a fresh JWT: on every attach the server sends the job
 * chat and the records it changed (fresh), the chosen preset, the current reply with its text,
 * and the result if the job ended. Pings are answered with pongs before events of another epoch
 * than the loaded one are dropped. The follow gives its socket up, as its own `close()` would
 * (the job is not released), when it has not opened within
 * 10 s of the follow's start (authentication included), when it has had no frame (pings included)
 * for 45 s while the page is visible, and when the page comes back
 * (`src/ts/network/socketLiveness.ts`); a terminal that arrived stands. The caller attaches again.
 * A newer follow cancels the older socket (even while connecting), events, and sends immediately;
 * its higher `attach` stamp also orders ownership across reloads on the server. `send` carries the
 * channel's answers; `closed` retains any terminal, and distinguishes a resumed page from a lost link.
 */
export function followGenerationJob(jobId: string, onEvent: (event: GenerationEvent) => void): GenerationFollow {
    liveJobs.add(jobId);
    let ws: WebSocket | null = null;
    let cancelled = false;
    let terminal: GenerationTerminalEvent | null = null;
    type Closed = { terminal: GenerationTerminalEvent | null; resumed?: boolean; received?: boolean };
    // Settles on the socket's close or on cancellation, whichever comes first (even before auth).
    let resolveClosed!: (value: Closed) => void;
    const closed = new Promise<Closed>((resolve) => {
        resolveClosed = resolve;
    });
    let wasOpened = false;
    let received = false;
    let resumed = false;
    let resolveOpened!: (value: boolean) => void;
    const opened = new Promise<boolean>((resolve) => {
        resolveOpened = resolve;
    });
    const finish = () => {
        watch.stop();
        stopResume();
        resolveOpened(false);
        resolveClosed({ terminal, ...(resumed ? { resumed } : {}), ...(received ? { received } : {}) });
    };
    const handle = {
        cancel() {
            cancelled = true;
            // Closing a CONNECTING socket aborts its handshake; a socket not built yet never is.
            ws?.close();
            finish();
        },
    };
    /** Gives the socket up (as `close()`), unless the follow ended or its terminal already arrived. */
    const abandon = (phase: "connectTimeout" | "stale" | "resumeReconnect") => {
        if (cancelled || terminal) {
            return;
        }
        recordClientEvent({ kind: "jobLink", phase, jobId });
        resumed = phase === "resumeReconnect" && wasOpened;
        follow.close();
    };
    const watch = watchSocket({
        onConnectTimeout: () => abandon("connectTimeout"),
        onStale: () => abandon("stale"),
    });
    const stopResume = watchResume(() => abandon("resumeReconnect"));
    // A newer follow of the job supersedes this one at once (its events, sends, and connection).
    currentFollows.get(jobId)?.cancel();
    currentFollows.set(jobId, handle);
    const stamp = attachStamp();
    void (async () => {
        const auth = await getNodeServerProxyAuth();
        if (cancelled) {
            return;
        }
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        // `liveness=1`: this tab answers pings. `hydration=patch`: its callback barrier reads the job
        // chat itself for a receipt it does not hold, so the server may send that chat only as it
        // changed (`jobChannel.ts` `barrier`). `rows=streamed`: it rebuilds raw checkpoint rows from
        // the stream buffer. `proto=1` is recorded and logged by the server, never enforced.
        const url =
            `${protocol}//${location.host}/api/generations/${encodeURIComponent(jobId)}/ws` +
            `?risu-auth=${encodeURIComponent(auth)}&clientId=${encodeURIComponent(generationClientId())}` +
            `&attach=${stamp}&liveness=1&hydration=patch&rows=streamed&proto=1`;
        const socket = new WebSocket(url);
        ws = socket;
        socket.onopen = () => {
            if (!cancelled) {
                wasOpened = true;
                watch.opened();
                resolveOpened(true);
                recordClientEvent({ kind: "jobLink", phase: "attach", jobId });
            }
        };
        socket.onmessage = (message) => {
            if (cancelled) {
                return;
            }
            received = true;
            watch.frame();
            let event: GenerationEvent;
            try {
                event = JSON.parse(String(message.data)) as GenerationEvent;
            } catch {
                return;
            }
            if (!event || typeof event !== "object") {
                return;
            }
            if (event.type === "ping") {
                const pong: GenerationPong = { type: "pong", ts: event.ts };
                if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(pong));
                return;
            }
            if (event.epoch !== getResourceEpoch()) {
                return;
            }
            if (event.type === "done" || event.type === "error") {
                terminal = event;
            }
            onEvent(event);
            if (terminal) {
                socket.close();
            }
        };
        socket.onerror = () => {};
        socket.onclose = (event) => {
            // The tab's own close (a newer follow, the caller) and the close after the job's end are not
            // a lost link; a close before the socket opened is an attach that failed.
            if (!cancelled && !terminal) {
                recordClientEvent({
                    kind: "jobLink",
                    phase: wasOpened ? "detach" : "attachFailed",
                    jobId,
                    code: event.code,
                });
            }
            if (currentFollows.get(jobId) === handle) {
                currentFollows.delete(jobId);
            }
            finish();
        };
    })().catch((error) => {
        // Authentication failed (or the socket could not be built): no socket; the follow is over.
        console.error("[Generation]", error);
        if (!cancelled) {
            recordClientEvent({ kind: "jobLink", phase: "attachFailed", jobId });
        }
        if (currentFollows.get(jobId) === handle) {
            currentFollows.delete(jobId);
        }
        finish();
    });
    const follow: GenerationFollow = {
        send(message) {
            const socket = ws as WebSocket | null;
            if (cancelled || !socket || socket.readyState !== WebSocket.OPEN) {
                return false;
            }
            socket.send(JSON.stringify(message));
            return true;
        },
        close() {
            if (currentFollows.get(jobId) === handle) {
                currentFollows.delete(jobId);
            }
            handle.cancel();
        },
        closed,
        opened,
    };
    // A closed or superseded follow asks nothing more of its job.
    void closed.then(() => endFollowRecovery(follow));
    return follow;
}

/**
 * The follows that asked their job for its chat whole (`resync`) and have not received it yet: one
 * request at a time per follow (a new follow starts without one).
 */
const resyncing = new WeakSet<ChannelTransport>();

/** One reply-only recovery at a time per follow, cleared by any full-text accepted event. */
const resyncingReplies = new WeakSet<ChannelTransport>();

/** The follows whose job ended or that closed: nothing more is asked through them. */
const endedFollows = new WeakSet<ChannelTransport>();

/** The first wait before a recovery tries again (doubled each time, up to `MAX_RESYNC_WAIT_MS`). */
const RESYNC_RETRY_MS = 1000;
const MAX_RESYNC_WAIT_MS = 15_000;

/** A follow's recovery of its chat after a copy refused for local work (`resyncAfterLocalWork`). */
type Recovery = { ref: ChatRef; attempt: number; timer: ReturnType<typeof setTimeout> | null };

/** One recovery per follow, from a refused copy until it asks for the chat whole or gives way. */
const recoveries = new WeakMap<ChannelTransport, Recovery>();

/** Ends a follow's recovery and its asking: its job ended, or the follow closed. */
function endFollowRecovery(transport: ChannelTransport) {
    const recovery = recoveries.get(transport);
    if (recovery?.timer) {
        clearTimeout(recovery.timer);
    }
    recoveries.delete(transport);
    resyncing.delete(transport);
    resyncingReplies.delete(transport);
    endedFollows.add(transport);
}

function requestReplyResync(transport: ChannelTransport) {
    if (endedFollows.has(transport) || resyncingReplies.has(transport)) {
        return;
    }
    const request: ReplyResyncRequest = { type: "resyncReply" };
    if (transport.send(request)) {
        resyncingReplies.add(transport);
    }
}

/**
 * Asks the follow's job for its chat whole, once at a time, while the chat is still stale and
 * nothing local would refuse the copy (`chatHydrationHold`).
 */
function requestResync(transport: ChannelTransport, ref: ChatRef) {
    if (
        endedFollows.has(transport) ||
        resyncing.has(transport) ||
        !isChatStale(ref) ||
        chatHydrationHold(ref) !== "none"
    ) {
        return;
    }
    const request: ChatResyncRequest = { type: "resync" };
    if (transport.send(request)) {
        resyncing.add(transport);
    }
}

/**
 * A job chat copy refused for local work (`busy`): once the chat's queued or in-flight work is saved
 * (`flushResources`), the chat still stale asks for its chat whole, since a stalled stream may send
 * no other patch. A failed save, or new local work meanwhile, is tried again with a growing wait,
 * for as long as the follow lasts; one recovery per follow at a time. A chat held by work no save
 * settles (deferred, quarantined, refused for a generating message) asks nothing: the job's end
 * (the idle refresh) or the next send reads it.
 */
function resyncAfterLocalWork(transport: ChannelTransport, ref: ChatRef) {
    if (recoveries.has(transport) || endedFollows.has(transport) || chatHydrationHold(ref) === "held") {
        return;
    }
    const recovery: Recovery = { ref, attempt: 0, timer: null };
    recoveries.set(transport, recovery);
    runRecovery(transport, recovery);
}

function runRecovery(transport: ChannelTransport, recovery: Recovery) {
    recovery.timer = null;
    const again = () => {
        recovery.timer = setTimeout(
            () => runRecovery(transport, recovery),
            Math.min(RESYNC_RETRY_MS * 2 ** recovery.attempt, MAX_RESYNC_WAIT_MS),
        );
        recovery.attempt += 1;
    };
    void flushResources().then(
        () => {
            if (recoveries.get(transport) !== recovery) {
                return;
            }
            const hold = isChatStale(recovery.ref) ? chatHydrationHold(recovery.ref) : null;
            if (hold === "saving") {
                again();
                return;
            }
            recoveries.delete(transport);
            if (hold === "none") {
                requestResync(transport, recovery.ref);
            }
        },
        () => {
            if (recoveries.get(transport) === recovery) {
                again();
            }
        },
    );
}

/**
 * Mirrors one event of a job on `ref`'s chat: its presentation stage (`stage`), the reply's text and
 * lock (`accepted`, `chunk`), the records the job changed (`resource`, through `applyHydration`;
 * the job chat's changes as `chatPatch`, through `applyPatchHydration`), and the end (`done`,
 * `error`: every lock of the job is released and the saved job is forgotten). A patch the mirror
 * cannot take asks the job for its chat whole through `transport` (`resync`); a missing chunk base
 * asks only for the reply (`resyncReply`).
 * Creation and the first `accepted` seed `preparing` only without a known stage; `stage` replaces
 * it in `src/ts/process/jobStages.ts` until release. A `preset` event is a job-local `presetChain`
 * pick: neither the tab's selection nor the chat's binding changes.
 */
export function applyGenerationEvent(
    jobId: string,
    ref: ChatRef,
    event: GenerationEvent,
    transport?: ChannelTransport,
) {
    switch (event.type) {
        case "accepted":
            setJobStage(jobId, ref, "preparing", { onlyIfMissing: true });
            if (transport) {
                resyncingReplies.delete(transport);
            }
            if (event.messageId && event.generationId) {
                applyServerGeneration(ref, {
                    jobId,
                    messageId: event.messageId,
                    generationId: event.generationId,
                    text: event.text,
                    seq: event.seq ?? 0,
                });
            }
            return;
        case "chunk":
            if (!applyServerGenerationChunk(ref, jobId, event) && transport) {
                requestReplyResync(transport);
            }
            return;
        case "resource": {
            const record = {
                kind: event.kind,
                id: event.id,
                characterId: event.characterId,
                revision: event.revision,
                data: event.data,
                ...("streaming" in event && event.streaming ? { job: { jobId, streaming: event.streaming } } : {}),
            };
            const applied = applyHydration(record);
            const jobChat = event.kind === "chats" && event.characterId === ref.chaId && event.id === ref.chatId;
            // Kept for a later callback's barrier, which applies it again after local work settles; the
            // job chat's streaming list also goes with a read of that chat the barrier installs.
            onChannel((channel) => {
                channel.rememberHydration(jobId, record);
                if (jobChat && record.job) {
                    channel.rememberJobStreaming(jobId, {
                        characterId: ref.chaId,
                        id: ref.chatId,
                        revision: record.revision,
                        streaming: record.job.streaming,
                    });
                }
            });
            if (transport && jobChat) {
                resyncing.delete(transport);
                if (!applied && isChatStale(ref)) {
                    // A whole copy refused for local work: asked for again once that work is saved.
                    resyncAfterLocalWork(transport, ref);
                }
            }
            return;
        }
        case "chatPatch": {
            const outcome = applyPatchHydration(
                {
                    characterId: event.characterId,
                    id: event.id,
                    baseRevision: event.baseRevision,
                    revision: event.revision,
                    meta: event.meta,
                    removed: event.removed,
                    messages: event.messages,
                    count: event.count,
                },
                { jobId, streaming: event.streaming },
            );
            // The patch is not kept for the barrier (it fits only the copy it was made against); its
            // streaming list is, for a read of the job chat the barrier installs.
            if (event.characterId === ref.chaId && event.id === ref.chatId) {
                const held = {
                    characterId: ref.chaId,
                    id: ref.chatId,
                    revision: event.revision,
                    streaming: event.streaming,
                };
                onChannel((channel) => channel.rememberJobStreaming(jobId, held));
            }
            if (transport && outcome === "mismatch") {
                requestResync(transport, ref);
            } else if (transport && outcome === "busy") {
                resyncAfterLocalWork(transport, ref);
            }
            return;
        }
        case "notice":
        case "question":
        case "callback":
        case "cancel":
            if (transport) {
                onChannel((channel) => channel.handleChannelEvent(jobId, event, transport));
            }
            return;
        case "stage":
            // The job's latest presentation stage, kept per job for the selected chat's spinner.
            setJobStage(jobId, ref, event.stage);
            return;
        case "preset":
            // A `presetChain` pick is the job's own: neither the tab's selection nor the chat's binding
            // changes.
            return;
        case "done":
        case "error":
            if (transport) {
                endFollowRecovery(transport);
            }
            releaseGenerationJob(jobId);
            return;
    }
}

/**
 * Everything this tab holds for a job, released as its end releases it: the channel's outstanding
 * questions and callbacks (cancelled), the job's message locks, saved job, and presentation stage.
 * Also for a job the tab stopped following without its end (lost).
 */
export function releaseGenerationJob(jobId: string) {
    dropJobStage(jobId);
    if (dispatcher) {
        onChannel((channel) => channel.endJobChannel(jobId));
    }
    endServerJob(jobId);
    forgetGenerationJob(jobId);
    liveJobs.delete(jobId);
    busyJobs.delete(jobId);
    notifyPluginWork();
}
