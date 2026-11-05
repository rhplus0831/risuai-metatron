import { untrack } from "svelte";
import { get } from "svelte/store";
import { v4 as uuidv4 } from "uuid";
import type { CbsConditions } from "../../../shared/cbs/types.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import {
    MAX_TRANSFORM_REQUEST_TEXT_BYTES,
    MAX_TRANSFORM_TARGETS,
    MAX_TRANSFORM_TEXT_BYTES,
    TRANSFORM_SNAPSHOT_TTL_MS,
    type TransformContext,
    type TransformMode,
    type TransformResponse,
    type TransformResult,
    type TransformTarget,
    type TransformTargetKind,
} from "../../../shared/transform.ts";
import { language } from "src/lang";
import { alertToast } from "../alert";
import { generationClientId } from "../network/generationJobs";
import { capturePluginContext, invokeHook, type PluginCallContext } from "../plugins/apiV3/pluginContext";
import { pluginHooks } from "../plugins/pluginHooks";
import { chatDisplayIds } from "../storage/chatBinding.svelte";
import {
    type ChatRef,
    chatHasUnackedWork,
    chatInstallVersion,
    currentChatRef,
    findChat,
    heldChatRevision,
    isMessageLocked,
} from "../storage/chatStore.svelte";
import { CharEmotion } from "../stores.svelte";
import { authFetch } from "../storage/serverAuth";
import { epochMismatch, getResourceEpoch } from "../storage/resourceClient";
import { recordClientEvent } from "../diagnostics/collector";
import { markDisplayTransformFailed, markDisplayTransformSucceeded } from "./displayTransformRecovery.svelte";
import {
    advanceTransformResultsGeneration,
    confirmTransformResult,
    dropMessageTransformResults,
    getTransformResult,
    replaceTransformResult,
    transformResultVersion,
    transformResultsGeneration,
    type TransformResultEntry,
} from "./transformResults";

/**
 * The client of the script transform (`shared/transform.ts`): the `editdisplay` stage of
 * `ParseMarkdown` and the direct callers (the translator's `editdisplay`, the HypaV3 modal's and
 * `parseRisuChat`'s `editprocess`) run on the server; there is no browser regex, Lua, or trigger
 * stage. Without a context (`captureTransform` null: no
 * chat, a chat not saved on the server yet, no preset or persona) a caller skips the stage and shows
 * the text as the CBS pre-pass and the assets leave it; a new chat's rows render again once its
 * first save lands (`chatSaveVersion`). The browser keeps both additional-asset passes, inlays,
 * thoughts, style, Markdown, and sanitization, and the CBS pre-pass of `Chat.svelte`.
 *
 * A render captures its context before its first await (`captureTransform`; `ChatBody` once for all
 * the stages and retries of a message's render, passed down to `ParseMarkdown` and `translateHTML`):
 * the chat, the message id at `chatID`, the preset and persona ids, the plugin call context, and the
 * message's Re-render generation (the first transform sent at a Re-render's generation skips the
 * server and tab caches, for every later stage of that render too). Calls are batched per context,
 * mode, handler set, and captured viewport/language on the next animation frame (or after 16 ms
 * when frames are withheld). While the message is locked by a generation (it streams), the
 * transform is skipped: the text goes through
 * the browser steps raw, and the row renders again when the lock ends. Each target is answered as
 * soon as its result is known; a failed target or request leaves its text unprocessed, and a batch
 * shows one toast on its first failure; there is no browser fallback on the server path. A failure
 * is `permanent` (`displayTransformRecovery` does not retry it) for a source over
 * `MAX_TRANSFORM_TEXT_BYTES` (never sent), a 400 or 413 answer to either call of a chunk whose first
 * request held that target alone, and a target the server marks so.
 * With the tab's plugin handlers for the mode, the server answers the texts before them; the tab
 * runs each text's handlers in order (with the captured plugin context), the texts side by side,
 * and sends the second call. A chunk has 28 s for both calls and the handlers (the server allows 30 s from the
 * first call's admission), each call bounded as a whole; the handlers end 5 s before that: a handler
 * still running then fails its own target (it is not stopped, but no later handler of its text is
 * started; its result is ignored), and the finished texts go out in the second call.
 *
 * A bounded tab LRU keeps confirmed text. A matching target sends `knownKey` when it does not need
 * emotions; `same` confirms the retained text without downloading it. ChatBody's final display stage
 * may show this text while confirmation is pending and render again on a changed or failed answer,
 * handing a non-mixed answer or a raw failure to that correction without another request. A changed
 * mixed answer instead makes the correction request fresh state. Source hashing and enqueueing are
 * synchronous; a cache hit also requires the exact source, so a hash collision is a miss.
 * Translation inputs always wait. Re-render drops the message's entries, GUI resets keep entries,
 * and epoch changes clear them. Both the cache generation captured before any await and the message's
 * Re-render generation fence every answer's cache changes, replacement callback, and effects.
 * Overlapping answers condition their writes on the entry version they read.
 *
 * Identical inputs and capture provenance share an operation through settlement, including in flight.
 * Each caller subscribes until its completion or abort; a caller without a signal keeps its subscription.
 * Abort returns that caller's input immediately and suppresses its completion's effects. The last departure
 * withdraws a queued operation; a dispatched chunk is cancelled only when none of its open operations has
 * subscribers. One controller serves both calls, forwarding the deadline and subscriber cancellation by hand;
 * cancellation starts no further plugin hook or second call. Its `cancelled` settlements touch no cache,
 * recovery, diagnostics or provisional callback and show no toast; deadlines remain failures. Withdrawal and
 * cancellation restore any Re-render bypass the operation consumed, and remove it from the join map at once.
 *
 * `@@emo` effects apply only from full answers, once per tab and result key, and only when the
 * caller's character argument is not `simple`; cached text and `same` never apply emotions.
 */

/** A per-document value: the handler-set identity never repeats across reloads. */
const documentNonce = uuidv4();
/** The last handler list of each mode and its version (a new version when the ordered list changes). */
const handlerVersions = new Map<TransformMode, { hooks: unknown[]; version: number }>();
let nextHandlerVersion = 0;

/** The ordered handlers of `mode` and their identity (bounded: the document, the mode, a version), or none. */
function handlerSet(mode: TransformMode): { hooks: ((text: string) => unknown)[]; id: string } | null {
    const hooks = [...pluginHooks[mode]];
    if (hooks.length === 0) {
        return null;
    }
    const last = handlerVersions.get(mode);
    let version = last?.version;
    if (!last || last.hooks.length !== hooks.length || last.hooks.some((hook, i) => hook !== hooks[i])) {
        version = ++nextHandlerVersion;
        handlerVersions.set(mode, { hooks, version });
    }
    return { hooks, id: `${documentNonce}:${mode}:${version}` };
}

/** What a call captured before its first await. */
export type CapturedTransform = {
    chatRef: ChatRef;
    context: TransformContext;
    messageId?: string;
    pluginContext: PluginCallContext | undefined;
    /** The message's render generation when the call began ("Re-render" raises it). */
    generation: number;
    /** The tab cache's generation before the render's first await. */
    cacheGeneration: number;
    /**
     * Whether this render skips the server cache: claimed by its first transform sent at the generation a
     * "Re-render" marked (then every later stage with this capture skips it too).
     */
    noCache: boolean;
    locked: boolean;
    /** The chat's installed state and unsaved-work flag when this render began. */
    installVersion: number;
    hadUnackedWork: boolean;
    /** An editdisplay answer may have mixed the render's text with a different stored transcript. */
    mixedDisplay: boolean;
    /** Installed only for ChatBody's final display stage, never for translation inputs. */
    onProvisional?: (answer: { replaced: boolean; mixed: boolean; outcome?: TransformOutcome }) => void;
    /** Final display answers still pending; mixed reporting waits for their replacement decision. */
    pendingProvisional?: number;
    /** A provisional answer handed to the next local render, consumed at its final stage. */
    provisionalOutcome?: TransformOutcome;
};

type TransformOutcome = {
    identity: string;
    cacheGeneration: number;
    generation: number;
    /** The originating render's install version, before any of its awaits. */
    installVersion: number;
    /** The exact source also guards the handoff against a hash collision. */
    source: string;
    text: string;
};

const generations = new Map<string, number>();
/** The generation a "Re-render" asked to bypass the cache for: the first transform sent at it takes the bypass. */
const noCacheNext = new Map<string, number>();
const messageKey = (ref: ChatRef, messageId: string) => JSON.stringify([ref.chaId, ref.chatId, messageId]);

/**
 * The context of a call, read now (before any await): null when the server path does not apply (no
 * chat, a chat not saved on the server yet, no preset or persona). Untracked: a row's render must not
 * depend on the lock version, the selection, or other rows (a lock change on one message would
 * re-render every mounted row); a locked row, and a row of a chat whose first save landed, re-render
 * through `chatBodyRevision`.
 * It holds the chat (the plugin context's, else `chatRef`, else the selected one), the message id at `chatID`, the
 * chat's display ids (`chatDisplayIds`: per field the bound record when it exists, else the tab's; the persona sent
 * as both the effective and the selected one), the plugin call context, the message's lock and Re-render
 * generation, the tab cache's generation, `chatInstallVersion`, and `chatHasUnackedWork`. A render's later stages
 * take it as their last argument (`ParseMarkdown`, `translateHTML`): a capture, null for none (the stage is
 * skipped), or omitted to capture at that call.
 */
export function captureTransform(
    chatID: number,
    options: { chatRef?: ChatRef | null; pluginContext?: PluginCallContext } = {},
): CapturedTransform | null {
    return untrack(() => readTransformContext(chatID, options));
}

function readTransformContext(
    chatID: number,
    options: { chatRef?: ChatRef | null; pluginContext?: PluginCallContext },
): CapturedTransform | null {
    const chatRef = options.pluginContext?.chatRef ?? options.chatRef ?? currentChatRef();
    if (!chatRef) {
        return null;
    }
    const chat = findChat(chatRef);
    if (!chat || heldChatRevision(chatRef) === null) {
        return null;
    }
    // The chat's display ids: its bound ids where they exist, else the tab's. Also inside a plugin
    // hook: a job's `presetChain` pick is that job's, not the chat's render.
    const { presetId, modelPresetId, personaId } = chatDisplayIds(chatRef);
    if (!presetId || !modelPresetId || !personaId) {
        return null;
    }
    const messageId = chatID >= 0 ? chat.message[chatID]?.chatId : undefined;
    const generation = messageId ? (generations.get(messageKey(chatRef, messageId)) ?? 0) : 0;
    return {
        chatRef: { chaId: chatRef.chaId, chatId: chatRef.chatId },
        context: {
            characterId: chatRef.chaId,
            chatId: chatRef.chatId,
            presetId,
            modelPresetId,
            personaId,
            // A chat's render has one persona (the server reads `personaId` only).
            selectedPersonaId: personaId,
        },
        ...(messageId ? { messageId } : {}),
        pluginContext: options.pluginContext ?? capturePluginContext(chatRef),
        generation,
        cacheGeneration: transformResultsGeneration(),
        noCache: false,
        locked: isMessageLocked(chatRef, messageId),
        installVersion: chatInstallVersion(chatRef),
        hadUnackedWork: chatHasUnackedWork(chatRef),
        mixedDisplay: false,
    };
}

/**
 * "Re-render": the next transform of the message skips the server cache; older responses apply no effects.
 * It drops the message's tab results (every source, mode, and viewport) and raises its generation, so that
 * transform also skips the tab cache and answers captured before it change neither cache nor recovery.
 */
export function rerenderMessage(chatRef: ChatRef, messageId: string): void {
    const key = messageKey(chatRef, messageId);
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    noCacheNext.set(key, generation);
    dropMessageTransformResults(key);
}

/** The keys whose emotions this tab applied (cleared with the process cache, on `ReloadGUIPointer`). */
const appliedEmotions = new Set<string>();
const MAX_APPLIED = 4096;

/**
 * On the `ReloadGUIPointer` bump (`src/ts/stores.svelte.ts`): forgets which results' emotions were applied and
 * advances the tab cache's generation, keeping its entries, across chat switches too. A capture taken before it
 * can no longer change or confirm the cache, apply emotions, report to recovery, or schedule a provisional
 * correction.
 */
export function resetTransformEffects(): void {
    appliedEmotions.clear();
    advanceTransformResultsGeneration();
}

type Answer = TransformResult | NonNullable<TransformResponse["same"]>[number] | { id: string; cancelled: true };

type Operation = {
    key: string;
    target: TransformTarget;
    captured: CapturedTransform;
    batch: Batch;
    entry: TransformResultEntry | undefined;
    version: symbol | undefined;
    answer: Promise<Answer>;
    resolve: (result: Answer) => void;
    subscribers: number;
    settled: boolean;
    chunk?: Chunk;
    bypassKey?: string;
};

type Chunk = {
    open: Map<string, Operation>;
    controller: AbortController;
    deadline: number;
    cancelled: boolean;
};

type Batch = {
    mode: TransformMode;
    captured: CapturedTransform;
    client: { viewport: { width: number; height: number }; browserLanguage: string };
    handlers: ReturnType<typeof handlerSet>;
    pending: Operation[];
    /**
     * Whether this batch's failure toast was shown (one per batch, its chunks included) or is
     * suppressed (a restore refused it: the terminal notice tells the user).
     */
    reported: boolean;
};

const batches = new Map<string, Batch>();
const operations = new Map<string, Operation>();
let scheduled = false;

function forgetOperation(operation: Operation): void {
    if (operations.get(operation.key) === operation) operations.delete(operation.key);
}

function restoreBypass(operation: Operation): void {
    const key = operation.bypassKey;
    if (key && generations.get(key) === operation.captured.generation && !noCacheNext.has(key)) {
        noCacheNext.set(key, operation.captured.generation);
    }
}

function cancelUnobservedChunk(chunk: Chunk): void {
    if (
        chunk.controller.signal.aborted ||
        Date.now() >= chunk.deadline ||
        chunk.open.size === 0 ||
        [...chunk.open.values()].some((operation) => operation.subscribers > 0)
    )
        return;
    chunk.cancelled = true;
    // Remove joinable entries before abort listeners can enqueue replacement work.
    for (const operation of chunk.open.values()) {
        forgetOperation(operation);
        restoreBypass(operation);
    }
    chunk.controller.abort();
}

function unsubscribe(operation: Operation): void {
    operation.subscribers -= 1;
    if (operation.chunk) {
        cancelUnobservedChunk(operation.chunk);
    } else if (!operation.settled && operation.subscribers === 0) {
        const pending = operation.batch.pending;
        pending.splice(pending.indexOf(operation), 1);
        restoreBypass(operation);
        settle(operation, { id: operation.target.id, cancelled: true });
    }
}

const schedule = () => {
    if (scheduled) {
        return;
    }
    scheduled = true;
    // The next frame, or a short timer when frames are withheld (a hidden tab): whichever comes first.
    let frame: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
        if (!scheduled) {
            return;
        }
        if (frame !== null) {
            cancelAnimationFrame(frame);
        }
        if (timer !== null) {
            clearTimeout(timer);
        }
        scheduled = false;
        const all = [...batches.values()];
        batches.clear();
        for (const batch of all) {
            void sendBatch(batch);
        }
    };
    if (typeof requestAnimationFrame === "function") {
        frame = requestAnimationFrame(run);
    }
    timer = setTimeout(run, 16);
};

const textBytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * How long a chunk may take, both calls and the plugin handlers between them: within the server's
 * deadline (`TRANSFORM_SNAPSHOT_TTL_MS` from the first call's admission), which starts after this.
 */
const CHUNK_DEADLINE_MS = TRANSFORM_SNAPSHOT_TTL_MS - 2_000;
/** The part of a chunk's time kept for the second call: the plugin handlers end this much before its deadline. */
const CONTINUE_RESERVE_MS = 5_000;

/**
 * `work`, or a rejection once `deadline` passes: also when the deadline had passed already, or passed
 * before `work` settled (a timer can run late). A rejection of `work` after that stays observed; its
 * result is ignored.
 */
function beforeDeadline<T>(work: Promise<T>, deadline: number, message: string): Promise<T> {
    work.catch(() => {});
    if (Date.now() >= deadline) {
        return Promise.reject(new Error(message));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), deadline - Date.now());
    });
    const checked = work.then((value) => {
        if (Date.now() > deadline) {
            throw new Error(message);
        }
        return value;
    });
    return Promise.race([checked, expired]).finally(() => clearTimeout(timer));
}

/** One call, within `deadline` as a whole (authentication, the request, and the body). */
function post(path: string, body: unknown, chunk: Chunk): Promise<TransformResponse> {
    return beforeDeadline(postOnce(path, body, chunk.controller.signal), chunk.deadline, "The render took too long");
}

/** Errors of a request the server refused for another epoch (a restore replaced the data). */
const epochRefusals = new WeakSet<object>();
/** Errors of a request the server refused as malformed or too large: the same request fails again. */
const permanentRefusals = new WeakSet<object>();

async function postOnce(path: string, body: unknown, signal: AbortSignal): Promise<TransformResponse> {
    signal.throwIfAborted();
    const response = await authFetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", [RESOURCE_EPOCH_HEADER]: getResourceEpoch() },
        body: JSON.stringify(body),
        cache: "no-store",
        signal,
    });
    let answer: { error?: string; epoch?: string } & Partial<TransformResponse> = {};
    try {
        answer = await response.json();
    } catch {}
    signal.throwIfAborted();
    if (response.status === 412 && answer.error === "EpochMismatch") {
        const error = epochMismatch(answer.epoch ?? "");
        epochRefusals.add(error);
        throw error;
    }
    if (response.status === 409 && answer.error === "chatBindingMismatch") {
        // The server holds a newer binding than this tab: the text stays unprocessed, with a readable reason.
        throw new Error(language.chatBinding.mismatch);
    }
    if (!response.ok) {
        const error = new Error(answer.error ?? `The render failed (${response.status})`);
        if (response.status === 400 || response.status === 413) permanentRefusals.add(error);
        throw error;
    }
    return answer as TransformResponse;
}

/** One toast per batch, on its first failure. */
function reportFailure(batch: Batch, error: string): void {
    if (batch.reported) {
        return;
    }
    batch.reported = true;
    alertToast(`${language.serverTransformFailed}: ${error}`);
}

/** Answers a caller once; a failed target is reported. */
function settle(entry: Operation, result: Answer): void {
    if (entry.settled) return;
    entry.settled = true;
    forgetOperation(entry);
    entry.chunk?.open.delete(entry.target.id);
    entry.resolve(result);
    if ("ok" in result && result.ok === false && isCurrent(entry.captured)) {
        reportFailure(entry.batch, result.error);
    }
}

/**
 * Runs the tab's plugin handlers on one pending text, in order, until `deadline`. A handler still
 * running then is not stopped (plugin code cannot be cancelled), but no later handler is started and
 * its result is ignored.
 */
async function runHandlers(
    batch: Batch,
    entry: { id: string; text: string },
    deadline: number,
    signal: AbortSignal,
): Promise<{ id: string; text: string } | { id: string; error: string }> {
    const hooks = batch.handlers?.hooks ?? [];
    // Both transform modes are read-only, even when called from a writable job hook.
    const context: PluginCallContext = {
        chatRef: batch.captured.chatRef,
        presetId: batch.captured.context.presetId,
        modelPresetId: batch.captured.context.modelPresetId,
        personaId: batch.captured.context.personaId,
        ...batch.captured.pluginContext,
        purpose: "transform",
    };
    let abandoned = false;
    const timeout = { id: entry.id, error: "A plugin handler took too long" };
    const run = async (): Promise<{ id: string; text: string } | { id: string; error: string }> => {
        let text = entry.text;
        for (const hook of hooks) {
            signal.throwIfAborted();
            if (abandoned || Date.now() >= deadline) {
                return timeout;
            }
            const result = await invokeHook(hook, context, text);
            if (result !== null && result !== undefined) {
                text = String(result);
            }
        }
        return { id: entry.id, text };
    };
    try {
        return await beforeDeadline(run(), deadline, timeout.error);
    } catch (error) {
        abandoned = true;
        return { id: entry.id, error: error instanceof Error ? error.message : String(error) };
    }
}

async function sendBatch(batch: Batch): Promise<void> {
    // Split at the server's caps (an oversized single target fails alone, never requeued).
    const chunks: Operation[][] = [];
    let chunk: Operation[] = [];
    let bytes = 0;
    for (const entry of batch.pending) {
        const size = textBytes(entry.target.source);
        if (size > MAX_TRANSFORM_TEXT_BYTES) {
            settle(entry, {
                id: entry.target.id,
                ok: false,
                error: "The text is too long to render",
                permanent: true,
            });
            continue;
        }
        if (chunk.length >= MAX_TRANSFORM_TARGETS || bytes + size > MAX_TRANSFORM_REQUEST_TEXT_BYTES) {
            chunks.push(chunk);
            chunk = [];
            bytes = 0;
        }
        chunk.push(entry);
        bytes += size;
    }
    if (chunk.length > 0) {
        chunks.push(chunk);
    }
    await Promise.all(chunks.map((entries) => sendChunk(batch, entries)));
}

/**
 * One request (and its second call): every target is answered as soon as its result is known, and
 * each exactly once; whatever is still open when the chunk fails or its deadline passes fails.
 */
async function sendChunk(batch: Batch, entries: Operation[]): Promise<void> {
    const deadline = Date.now() + CHUNK_DEADLINE_MS;
    const open = new Map(entries.map((entry) => [entry.target.id, entry]));
    const controller = new AbortController();
    const chunk: Chunk = { open, controller, deadline, cancelled: false };
    for (const entry of entries) entry.chunk = chunk;
    const timer = setTimeout(
        () => controller.abort(new DOMException("The render took too long", "TimeoutError")),
        CHUNK_DEADLINE_MS,
    );
    const answer = (results: Answer[]) => {
        for (const received of results) {
            const result: Answer = chunk.cancelled ? { id: received.id, cancelled: true } : received;
            const entry = open.get(result.id);
            if (entry) {
                // An unrecognized confirmation leaves the target unanswered, like a missing result.
                if (!("ok" in result) && !("cancelled" in result) && result.key !== entry.target.knownKey) continue;
                settle(entry, result);
            }
        }
    };
    try {
        const clientId = generationClientId();
        const first = await post(
            "/api/transform",
            {
                clientId,
                mode: batch.mode,
                context: batch.captured.context,
                client: batch.client,
                targets: entries.map((entry) => entry.target),
                ...(batch.handlers ? { handlers: batch.handlers.id } : {}),
            },
            chunk,
        );
        controller.signal.throwIfAborted();
        answer(first.results);
        answer(first.same ?? []);
        cancelUnobservedChunk(chunk);
        controller.signal.throwIfAborted();
        if (first.snapshotId && first.pending && first.pending.length > 0) {
            // Each text's handlers run in order; the texts run side by side, as the tab renders messages.
            // They end before the second call's reserve, so the finished texts still go out with a hung
            // one's error.
            const handlersDeadline = deadline - CONTINUE_RESERVE_MS;
            if (Date.now() >= handlersDeadline) {
                throw new Error("The render took too long");
            }
            const texts = await Promise.all(
                first.pending.map((entry) => runHandlers(batch, entry, handlersDeadline, controller.signal)),
            );
            cancelUnobservedChunk(chunk);
            controller.signal.throwIfAborted();
            const second = await post(
                "/api/transform/continue",
                { clientId, snapshotId: first.snapshotId, texts },
                chunk,
            );
            controller.signal.throwIfAborted();
            answer(second.results);
        }
    } catch (error) {
        if (!chunk.cancelled && typeof error === "object" && error !== null && epochRefusals.has(error)) {
            // A restore replaced the data: its notice tells the user and the page reloads, so no toast.
            batch.reported = true;
        }
        const message = error instanceof Error ? error.message : String(error);
        // A refused request of several targets may be refused only for their sum: they retry.
        const permanent =
            entries.length === 1 && typeof error === "object" && error !== null && permanentRefusals.has(error);
        answer(
            [...open.keys()].map((id) =>
                chunk.cancelled
                    ? { id, cancelled: true as const }
                    : {
                          id,
                          ok: false as const,
                          error: message,
                          ...(permanent ? { permanent: true as const } : {}),
                      },
            ),
        );
    } finally {
        clearTimeout(timer);
    }
    answer(
        [...open.keys()].map((id) =>
            chunk.cancelled
                ? { id, cancelled: true as const }
                : { id, ok: false as const, error: "The render did not answer" },
        ),
    );
}

function isCurrent(captured: CapturedTransform): boolean {
    return (
        captured.cacheGeneration === transformResultsGeneration() &&
        (!captured.messageId ||
            (generations.get(messageKey(captured.chatRef, captured.messageId)) ?? 0) === captured.generation)
    );
}

function isMixedDisplay(mode: TransformMode, captured: CapturedTransform): boolean {
    return (
        mode === "editdisplay" &&
        !!captured.messageId &&
        (captured.hadUnackedWork || chatInstallVersion(captured.chatRef) !== captured.installVersion)
    );
}

/** A synchronous 53-bit UTF-16 hash (cyrb53); exact-source checks disambiguate collisions. */
function sourceHash(source: string): string {
    let first = 0xdeadbeef;
    let second = 0x41c6ce57;
    for (let i = 0; i < source.length; i++) {
        const code = source.charCodeAt(i);
        first = Math.imul(first ^ code, 2654435761);
        second = Math.imul(second ^ code, 1597334677);
    }
    first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
    second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
    return (4294967296 * (second & 0x1fffff) + (first >>> 0)).toString(36);
}

/**
 * `processScriptFull(char, data, mode, chatID, cbsConditions)` on the server for a captured call:
 * `{ data, emoChanged }`. A locked message, a failed request, or a failed target answers the text as
 * it came in.
 */
export async function serverProcessScript(
    char: { chaId: string; type?: string },
    data: string,
    mode: TransformMode,
    chatID: number,
    cbsConditions: CbsConditions,
    captured: CapturedTransform,
    kind: TransformTargetKind,
    signal?: AbortSignal,
): Promise<{ data: string; emoChanged: boolean }> {
    signal?.throwIfAborted();
    if (captured.locked) {
        return { data, emoChanged: false };
    }
    const handlers = handlerSet(mode);
    const key = captured.messageId ? messageKey(captured.chatRef, captured.messageId) : null;
    let consumedBypass = false;
    // The bypass is taken by a transform actually sent at the marked generation (never by an older render).
    if (!captured.noCache && key !== null && isCurrent(captured) && noCacheNext.get(key) === captured.generation) {
        noCacheNext.delete(key);
        captured.noCache = true;
        consumedBypass = true;
    }
    const noCache = captured.noCache;
    const client = {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        browserLanguage: navigator.language,
    };
    const onProvisional = captured.onProvisional;
    const target: TransformTarget = {
        id: uuidv4(),
        kind: kind === "message" && !captured.messageId ? "text" : kind,
        sourceId: char.chaId,
        chatIndex: chatID,
        ...(kind === "message" && captured.messageId ? { messageId: captured.messageId } : {}),
        source: data,
        cbsConditions: Object.fromEntries(
            Object.entries(cbsConditions ?? {}).filter(([, value]) => value !== null && value !== undefined),
        ),
        ...(noCache ? { noCache: true } : {}),
    };
    const identity = JSON.stringify([
        captured.chatRef,
        mode,
        target.kind,
        captured.messageId ?? null,
        target.chatIndex,
        target.sourceId,
        sourceHash(data),
        target.cbsConditions,
        captured.context,
        handlers?.id ?? null,
        client,
    ]);
    const outcome = captured.provisionalOutcome;
    if (onProvisional && outcome) {
        delete captured.provisionalOutcome;
        if (
            outcome.identity === identity &&
            outcome.source === data &&
            outcome.cacheGeneration === captured.cacheGeneration &&
            outcome.generation === captured.generation &&
            isCurrent(captured)
        ) {
            if (isMixedDisplay(mode, captured) || outcome.installVersion !== captured.installVersion) {
                captured.mixedDisplay = true;
            }
            return { data: outcome.text, emoChanged: false };
        }
    }
    // No await between this lookup and enqueue: a frame may flush and remove the batch at any await.
    const entry = noCache ? undefined : getTransformResult(identity, data);
    const version = entry?.version ?? transformResultVersion(identity);
    if (entry && (char.type === "simple" || appliedEmotions.has(entry.key))) target.knownKey = entry.key;
    // A batch reuses its first plugin context; purpose, owner and job parent must also agree.
    const batchKey = JSON.stringify([mode, captured.context, captured.pluginContext, handlers?.id ?? null, client]);
    const inputs = JSON.stringify([
        identity,
        data,
        noCache,
        captured.cacheGeneration,
        captured.generation,
        target.knownKey ?? null,
    ]);
    const operationKey = JSON.stringify([batchKey, inputs, captured.installVersion, captured.hadUnackedWork]);
    let operation = operations.get(operationKey);
    if (!operation) {
        let batch = batches.get(batchKey);
        if (!batch) {
            batch = { mode, captured, client, handlers, pending: [], reported: false };
            batches.set(batchKey, batch);
        }
        let resolve: Operation["resolve"];
        const answer = new Promise<Answer>((done) => {
            resolve = done;
        });
        operation = {
            key: operationKey,
            target,
            captured,
            batch,
            entry,
            version,
            answer,
            resolve: resolve!,
            subscribers: 0,
            settled: false,
        };
        operations.set(operationKey, operation);
        batch.pending.push(operation);
        schedule();
    }
    const shared = operation;
    if (consumedBypass) shared.bypassKey = key!;
    shared.subscribers += 1;
    const provisional =
        onProvisional &&
        shared.entry &&
        shared.target.kind === "message" &&
        mode === "editdisplay" &&
        !captured.hadUnackedWork &&
        isCurrent(captured);
    if (provisional) captured.pendingProvisional = (captured.pendingProvisional ?? 0) + 1;
    let provisionalPending = !!provisional;
    const giveBackProvisional = () => {
        if (!provisionalPending) return;
        provisionalPending = false;
        captured.pendingProvisional! -= 1;
    };
    let subscribed = true;
    let aborted = false;
    const original = { data, emoChanged: false };
    let resolveAbort: (value: typeof original) => void;
    const departed = new Promise<typeof original>((resolve) => {
        resolveAbort = resolve;
    });
    const leave = () => {
        if (!subscribed) return;
        subscribed = false;
        signal?.removeEventListener("abort", onAbort);
        unsubscribe(shared);
    };
    const onAbort = () => {
        aborted = true;
        giveBackProvisional();
        leave();
        resolveAbort(original);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const completion = shared.answer.then((answered) => {
        try {
            if (aborted || "cancelled" in answered) return original;
            const current = isCurrent(captured);
            const mixed = isMixedDisplay(mode, captured);
            if (current && mixed) captured.mixedDisplay = true;
            const failed = "ok" in answered && !answered.ok;
            let text = data;
            let emoChanged = false;
            if (!("ok" in answered)) {
                // The response belongs to the shared operation's dispatched target, not this caller's id.
                text = shared.entry!.text;
                if (current) confirmTransformResult(identity, shared.entry!.version);
            } else if (answered.ok === false) {
                console.warn("[Transform]", answered.error);
                if (current) {
                    replaceTransformResult(identity, shared.version, key);
                }
                if (mode === "editdisplay") {
                    recordClientEvent({ kind: "notice", notice: "transformFailed" });
                    // A permanent failure waits for a changed source or context, a remount, or a Re-render; like
                    // a success, it ends an older generation's pending retry.
                    if (captured.messageId && current) {
                        if (answered.permanent) {
                            markDisplayTransformSucceeded(captured.chatRef, captured.messageId, captured.generation);
                        } else {
                            markDisplayTransformFailed(captured.chatRef, captured.messageId, captured.generation);
                        }
                    }
                }
            } else {
                text = answered.text;
                if (current) replaceTransformResult(identity, shared.version, key, { ...answered, source: data });
                if (
                    char.type !== "simple" &&
                    current &&
                    answered.emotions.length > 0 &&
                    !appliedEmotions.has(answered.key)
                ) {
                    if (appliedEmotions.size >= MAX_APPLIED) appliedEmotions.clear();
                    appliedEmotions.add(answered.key);
                    const charemotions = get(CharEmotion);
                    for (const emotion of answered.emotions) {
                        const list = charemotions[char.chaId] ?? [];
                        if (list.length > 4) list.splice(0, 1);
                        list.push([emotion.name, emotion.image, Date.now()]);
                        charemotions[char.chaId] = list;
                    }
                    CharEmotion.set(charemotions);
                    emoChanged = true;
                }
            }
            if (!failed && current && mode === "editdisplay" && captured.messageId) {
                markDisplayTransformSucceeded(captured.chatRef, captured.messageId, captured.generation);
            }
            if (provisional && current) {
                giveBackProvisional();
                const replaced = failed || text !== shared.entry!.text;
                onProvisional({
                    replaced,
                    mixed,
                    ...(replaced && (!mixed || failed)
                        ? {
                              outcome: {
                                  identity,
                                  cacheGeneration: captured.cacheGeneration,
                                  generation: captured.generation,
                                  installVersion: captured.installVersion,
                                  source: data,
                                  text,
                              },
                          }
                        : {}),
                });
            }
            return { data: text, emoChanged };
        } finally {
            giveBackProvisional();
            leave();
        }
    });
    if (provisional) {
        // The row settles without waiting for confirmation; the callback schedules any correction.
        void completion.catch((error) => console.error("[Transform]", error));
        return aborted ? original : { data: shared.entry!.text, emoChanged: false };
    }
    return Promise.race([completion, departed]);
}
