import { activePreset, activePersona } from "../storage/settingsViews.svelte";
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
import { type ChatRef, currentChatRef, findChat, heldChatRevision, isMessageLocked } from "../storage/chatStore.svelte";
import { CharEmotion } from "../stores.svelte";
import { authFetch } from "../storage/serverAuth";
import { epochMismatch, getResourceEpoch } from "../storage/resourceClient";
import { checkPersonaBinded } from "../util";

/**
 * The client of the script transform (Phase 5 slice 13; `shared/transform.ts`): the `editdisplay`
 * stage of `ParseMarkdown` and the direct callers (the translator's `editdisplay`, the HypaV3
 * modal's and `parseRisuChat`'s `editprocess`) run on the server; since the cutover (slice 14)
 * there is no browser regex, Lua, or trigger stage. Without a context (`captureTransform` null: no
 * chat, a chat not saved on the server yet, no preset or persona) a caller skips the stage and shows
 * the text as the CBS pre-pass and the assets leave it; a new chat's rows render again once its
 * first save lands (`chatSaveVersion`). The browser keeps both additional-asset passes, inlays,
 * thoughts, style, Markdown, and sanitization, and the CBS pre-pass of `Chat.svelte`.
 *
 * A render captures its context before its first await (`captureTransform`; `ChatBody` once for all
 * the stages and retries of a message's render, passed down to `ParseMarkdown` and `translateHTML`):
 * the chat, the message id at `chatID`, the preset and persona ids, the plugin call context, and the
 * message's Re-render generation (the first transform sent at a Re-render's generation skips the
 * server cache, for every later stage of that render too). Calls are batched per context, mode, and
 * handler set on the next animation frame (or after 16 ms when frames are withheld). While the
 * message is locked by a generation (it streams), the transform is skipped: the text goes through
 * the browser steps raw, and the row renders again when the lock ends. Each target is answered as
 * soon as its result is known; a failed target or request leaves its text unprocessed, and a batch
 * shows one toast on its first failure; there is no browser fallback on the server path. With the
 * tab's plugin handlers for the mode, the server answers the texts before them; the tab runs each
 * text's handlers in order (with the captured plugin context), the texts side by side, and sends
 * the second call. A chunk has 28 s for both calls and the handlers (the server allows 30 s from the
 * first call's admission), each call bounded as a whole; the handlers end 5 s before that: a handler
 * still running then fails its own target (it is not stopped, but no later handler of its text is
 * started; its result is ignored), and the finished texts go out in the second call.
 *
 * `@@emo` effects are applied once per tab and result key (as the tab's process cache applies
 * them once), and only when the caller's character argument is not `simple` (today's
 * `applyScriptEffect` skips a simple one); a response older than a "Re-render" of its message
 * applies none.
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
    /**
     * Whether this render skips the server cache: claimed by its first transform sent at the generation a
     * "Re-render" marked (then every later stage with this capture skips it too).
     */
    noCache: boolean;
    locked: boolean;
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
    const presetId = options.pluginContext?.presetId || activePreset.id;
    const selectedPersonaId = activePersona.id;
    const personaId = options.pluginContext?.personaId || checkPersonaBinded(chatRef)?.id || selectedPersonaId;
    if (!presetId || !personaId || !selectedPersonaId) {
        return null;
    }
    const messageId = chatID >= 0 ? chat.message[chatID]?.chatId : undefined;
    const generation = messageId ? (generations.get(messageKey(chatRef, messageId)) ?? 0) : 0;
    return {
        chatRef: { chaId: chatRef.chaId, chatId: chatRef.chatId },
        context: { characterId: chatRef.chaId, chatId: chatRef.chatId, presetId, personaId, selectedPersonaId },
        ...(messageId ? { messageId } : {}),
        pluginContext: options.pluginContext ?? capturePluginContext(chatRef),
        generation,
        noCache: false,
        locked: isMessageLocked(chatRef, messageId),
    };
}

/** "Re-render": the next transform of the message skips the server cache; older responses apply no effects. */
export function rerenderMessage(chatRef: ChatRef, messageId: string): void {
    const key = messageKey(chatRef, messageId);
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    noCacheNext.set(key, generation);
}

/** The keys whose emotions this tab applied (cleared with the process cache, on `ReloadGUIPointer`). */
const appliedEmotions = new Set<string>();
const MAX_APPLIED = 4096;

export function resetTransformEffects(): void {
    appliedEmotions.clear();
}

type Pending = {
    target: TransformTarget;
    resolve: (result: TransformResult) => void;
};

type Batch = {
    mode: TransformMode;
    captured: CapturedTransform;
    handlers: ReturnType<typeof handlerSet>;
    pending: Pending[];
    /** Identical targets share one entry (by their inputs). */
    shared: Map<string, Promise<TransformResult>>;
    /**
     * Whether this batch's failure toast was shown (one per batch, its chunks included) or is
     * suppressed (a restore refused it: the terminal notice tells the user).
     */
    reported: boolean;
};

const batches = new Map<string, Batch>();
let scheduled = false;

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
function post(path: string, body: unknown, deadline: number): Promise<TransformResponse> {
    return beforeDeadline(postOnce(path, body, deadline), deadline, "The render took too long");
}

/** Errors of a request the server refused for another epoch (a restore replaced the data). */
const epochRefusals = new WeakSet<object>();

async function postOnce(path: string, body: unknown, deadline: number): Promise<TransformResponse> {
    const response = await authFetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", [RESOURCE_EPOCH_HEADER]: getResourceEpoch() },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    let answer: { error?: string; epoch?: string } & Partial<TransformResponse> = {};
    try {
        answer = await response.json();
    } catch {}
    if (response.status === 412 && answer.error === "EpochMismatch") {
        const error = epochMismatch(answer.epoch ?? "");
        epochRefusals.add(error);
        throw error;
    }
    if (!response.ok) {
        throw new Error(answer.error ?? `The render failed (${response.status})`);
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
function settle(batch: Batch, entry: Pending, result: TransformResult): void {
    entry.resolve(result);
    if (result.ok === false) {
        reportFailure(batch, result.error);
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
): Promise<{ id: string; text: string } | { id: string; error: string }> {
    const hooks = batch.handlers?.hooks ?? [];
    let abandoned = false;
    const timeout = { id: entry.id, error: "A plugin handler took too long" };
    const run = async (): Promise<{ id: string; text: string } | { id: string; error: string }> => {
        let text = entry.text;
        for (const hook of hooks) {
            if (abandoned || Date.now() >= deadline) {
                return timeout;
            }
            const result = await invokeHook(hook, batch.captured.pluginContext, text);
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
    const chunks: Pending[][] = [];
    let chunk: Pending[] = [];
    let bytes = 0;
    for (const entry of batch.pending) {
        const size = textBytes(entry.target.source);
        if (size > MAX_TRANSFORM_TEXT_BYTES) {
            settle(batch, entry, { id: entry.target.id, ok: false, error: "The text is too long to render" });
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
async function sendChunk(batch: Batch, entries: Pending[]): Promise<void> {
    const deadline = Date.now() + CHUNK_DEADLINE_MS;
    const open = new Map(entries.map((entry) => [entry.target.id, entry]));
    const answer = (results: TransformResult[]) => {
        for (const result of results) {
            const entry = open.get(result.id);
            if (entry) {
                open.delete(result.id);
                settle(batch, entry, result);
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
                client: {
                    viewport: { width: window.innerWidth, height: window.innerHeight },
                    browserLanguage: navigator.language,
                },
                targets: entries.map((entry) => entry.target),
                ...(batch.handlers ? { handlers: batch.handlers.id } : {}),
            },
            deadline,
        );
        answer(first.results);
        if (first.snapshotId && first.pending && first.pending.length > 0) {
            // Each text's handlers run in order; the texts run side by side, as the tab renders messages.
            // They end before the second call's reserve, so the finished texts still go out with a hung
            // one's error.
            const handlersDeadline = deadline - CONTINUE_RESERVE_MS;
            if (Date.now() >= handlersDeadline) {
                throw new Error("The render took too long");
            }
            const texts = await Promise.all(first.pending.map((entry) => runHandlers(batch, entry, handlersDeadline)));
            const second = await post(
                "/api/transform/continue",
                { clientId, snapshotId: first.snapshotId, texts },
                deadline,
            );
            answer(second.results);
        }
    } catch (error) {
        if (typeof error === "object" && error !== null && epochRefusals.has(error)) {
            // A restore replaced the data: its notice tells the user and the page reloads, so no toast.
            batch.reported = true;
        }
        const message = error instanceof Error ? error.message : String(error);
        answer([...open.keys()].map((id) => ({ id, ok: false as const, error: message })));
    }
    answer([...open.keys()].map((id) => ({ id, ok: false as const, error: "The render did not answer" })));
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
): Promise<{ data: string; emoChanged: boolean }> {
    if (captured.locked) {
        return { data, emoChanged: false };
    }
    const handlers = handlerSet(mode);
    const key = captured.messageId ? messageKey(captured.chatRef, captured.messageId) : null;
    // The bypass is taken by a transform actually sent at the marked generation (never by an older render).
    if (!captured.noCache && key !== null && noCacheNext.get(key) === captured.generation) {
        noCacheNext.delete(key);
        captured.noCache = true;
    }
    const noCache = captured.noCache;
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
    const batchKey = JSON.stringify([mode, captured.context, handlers?.id ?? null]);
    let batch = batches.get(batchKey);
    if (!batch) {
        batch = { mode, captured, handlers, pending: [], shared: new Map(), reported: false };
        batches.set(batchKey, batch);
    }
    const inputs = JSON.stringify([
        target.kind,
        target.sourceId,
        target.chatIndex,
        target.messageId ?? null,
        data,
        target.cbsConditions,
        noCache,
    ]);
    let result = batch.shared.get(inputs);
    if (!result) {
        result = new Promise<TransformResult>((resolve) => batch!.pending.push({ target, resolve }));
        batch.shared.set(inputs, result);
        schedule();
    }
    const answered = await result;
    if (answered.ok === false) {
        console.warn("[Transform]", answered.error);
        return { data, emoChanged: false };
    }
    let emoChanged = false;
    const current = key === null || (generations.get(key) ?? 0) === captured.generation;
    if (char.type !== "simple" && current && answered.emotions.length > 0 && !appliedEmotions.has(answered.key)) {
        if (appliedEmotions.size >= MAX_APPLIED) {
            appliedEmotions.clear();
        }
        appliedEmotions.add(answered.key);
        const charemotions = get(CharEmotion);
        for (const emotion of answered.emotions) {
            const list = charemotions[char.chaId] ?? [];
            if (list.length > 4) {
                list.splice(0, 1);
            }
            list.push([emotion.name, emotion.image, Date.now()]);
            charemotions[char.chaId] = list;
        }
        CharEmotion.set(charemotions);
        emoChanged = true;
    }
    return { data: answered.text, emoChanged };
}
