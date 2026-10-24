import { characterList } from "../storage/characterStore.svelte";
import { settings, type PresetScope } from "../storage/settingsViews.svelte";
import { setChannelCallSource } from "./channelCallSource";
import { generationClientId, noteChannelCallbacks, reportCallbackDrained } from "./generationJobs";
import { get } from "svelte/store";
import type { ChannelChunk, ChatResyncRequest, ReplyResyncRequest } from "../../../shared/jobs.ts";
import type {
    CallbackFailure,
    CallbackTargets,
    ChannelAnswer,
    GenerationCallbackEvent,
    GenerationChannelEvent,
    GenerationHooks,
    GenerationNotice,
    GenerationQuestionEvent,
    HydrationReceipt,
    MemoryProgress,
    ScriptHookMode,
} from "../../../shared/jobs.ts";
import {
    MAX_PROVIDER_TEXT_CHARS,
    MEMORY_GAP_CHOICES,
    MEMORY_TRIM_CHOICES,
    SCRIPT_HOOK_MODES,
    TAB_MCP_IDENTIFIERS,
} from "../../../shared/jobs.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import { compareRevision, RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import {
    alertClear,
    alertConfirm,
    alertError,
    alertInput,
    alertMd,
    alertModuleSelect,
    alertNormal,
    alertSelect,
    alertSelectChar,
    alertToast,
    alertWait,
    openAlertDialog,
    type alertData,
} from "../alert";
import type { AlertDialog } from "../alertQueue";
import { language } from "../../lang";
import type { MCPClientLike } from "../process/mcp/internalmcp";
import { registeredCustomPluginMCPs } from "../process/mcp/pluginmcp";
import type { character } from "../storage/database.svelte";
import { invokeHook, type PluginCallContext } from "../plugins/apiV3/pluginContext";
import { pluginHooks } from "../plugins/pluginHooks";
import {
    chatList,
    currentChatRef,
    findChat,
    heldChatRevision,
    loadChats,
    pinChats,
    prepareChatHydrationRefresh,
    selectedChatId,
    withChatsCopy,
} from "../storage/chatStore.svelte";
import {
    applyHydration,
    beginMutationScope,
    flushResources,
    heldRecordRevision,
    type HydrationRecord,
} from "../storage/resourceSync.svelte";
import { epochMismatch, getResourceEpoch, readRefs } from "../storage/resourceClient";
import { authFetch } from "../storage/serverAuth";
import {
    alertStore,
    bodyIntercepterStore,
    CharEmotion,
    hypaV3ProgressStore,
    memoryProgressStore,
    type MemoryProgressEntry,
    type MemoryProgressState,
    ReloadChatPointer,
    ReloadGUIPointer,
    reloadChatKey,
} from "../stores.svelte";

/**
 * The client side of the job channel (`shared/jobs.ts`): it shows a job's notices, asks its
 * questions, and runs its plugin callbacks, answering through the job's socket.
 *
 * - Events are taken in socket order without waiting for a callback to finish, so an aux request's
 *   child callback can run while its parent waits.
 * - The UI is one queue across jobs, so every job's notices and questions keep their order: while a
 *   question or a modal notice is open, later notices (toasts too) and questions wait behind it, and
 *   each modal notice's own dialog is awaited before the next item. The alert store queues dialogs
 *   itself (a local alert never replaces a job's question, nor a job's question a local one), so a
 *   job's dialog may wait behind local ones. A `cancel` removes the question's dialog, shown or
 *   still queued, and drops its answer.
 * - A callback runs behind the barrier: pending local work is flushed, the newest hydration of every
 *   record the server listed is applied again. A chat copy refused only by the acknowledged floor
 *   gets one fenced whole read, retaining valid job streaming metadata. Each record must be held at
 *   least as new as listed; otherwise the answer is `failed`/`barrier`. The hook set runs under the
 *   job's targets (`invokeHook`), then its changes are flushed in a mutation scope (also when it threw): a
 *   discarded key or a rejected flush is `failed`/`barrier`.
 * - Each request's state is kept in memory: a duplicate delivery never runs a callback twice (the
 *   cached answer is sent again), and a `replay` this page has no state for is refused
 *   (`failed`/`protocol`), since it may already have run on the page before a reload.
 * - One root callback runs at a time in this tab (the server's lane per client). A `cancel` only asks
 *   a running hook to stop: the callback stays outstanding until its hook settles, and a root that
 *   arrives meanwhile is refused. The server keeps the lane for a callback it cancelled until this tab
 *   reports it drained (`reportCallbackDrained`, once the hook settled, or at once for one that had
 *   already answered) or its bound passes, so another job's root is not sent into a running hook.
 * - A hook run as a callback gets the job's targets as its call context with `channelCall` (the job
 *   and callback ids): an aux request made from it names that callback as its parent. Nothing else
 *   the tab requests does.
 */

/** Where the dispatcher sends its answers for one job (the job's current follow). */
export type ChannelTransport = {
    send(message: ChannelAnswer | ChannelChunk | ChatResyncRequest | ReplyResyncRequest): boolean;
};

type Outstanding = {
    jobId: string;
    id: string;
    parentId?: string;
    targets: CallbackTargets;
    cancelled: boolean;
    /** Aborted when the server cancels the callback or its job ends; image hooks pass its signal to their requests. */
    abort: AbortController;
    /** Called when the server cancels the callback or its job ends (a provider's request is aborted). */
    onCancel?: () => void;
};

/** Marks a callback cancelled and tells its hook. */
function cancelOutstanding(entry: Outstanding) {
    if (entry.cancelled) {
        return;
    }
    entry.cancelled = true;
    entry.abort.abort(cancelledByServer());
    try {
        entry.onCancel?.();
    } catch (error) {
        console.error("[Channel]", error);
    }
}

/** How often a streaming provider's text is sent at most (the newest text each time). */
const PROVIDER_CHUNK_INTERVAL_MS = 50;

type UiItem =
    | { type: "notice"; jobId: string; notice: GenerationNotice }
    | { type: "question"; jobId: string; event: GenerationQuestionEvent };

const MAX_REMEMBERED = 500;

/** A request's state; `callback` marks a callback delivery, run or refused (a cancel may then hold the server's lane). */
type RequestState = { jobId: string; answer: ChannelAnswer | null; retired?: true; callback?: true };

const transports = new Map<string, ChannelTransport>();
/** Request id → its state; a finished one keeps its answer for a duplicate delivery. */
const requests = new Map<string, RequestState>();
const outstanding: Outstanding[] = [];
/** One replacement child waits for the cancelled hooks of its parent to finish. */
let heldChild: {
    jobId: string;
    event: GenerationCallbackEvent;
    parent: Outstanding;
    timer: ReturnType<typeof setTimeout>;
} | null = null;
const uiQueue: UiItem[] = [];
/** The status object each job installed, so ending it cannot clear a newer writer's status. */
const jobStatuses = new Map<string, alertData>();
let uiBusy = false;
/** The question asked now (its dialog shown or queued): its job, its dialog (to cancel only its own), and its cancellation. */
let showing: {
    id: string;
    jobId: string;
    dialog: AlertDialog | null;
    cancelled: boolean;
    release: () => void;
} | null = null;
/** Each live job's newest hydration per record, retained only for its callback barriers. */
const hydrations = new Map<string, Map<string, HydrationRecord>>();

const recordKey = (kind: string, id: string, characterId?: string) =>
    kind === "chats" ? `chats\u0000${characterId ?? ""}\u0000${id}` : `${kind}\u0000${id}`;

function remember(id: string, entry: RequestState) {
    requests.delete(id);
    requests.set(id, entry);
    // Only finished requests are forgotten: a running one must still be recognized on a replay.
    for (const [key, value] of requests) {
        if (requests.size <= MAX_REMEMBERED) {
            break;
        }
        if (value.answer || value.retired) {
            requests.delete(key);
        }
    }
}

/** Keeps a job's newest hydration per record (by revision) for its later callback barriers. */
export function rememberHydration(jobId: string, record: HydrationRecord) {
    let records = hydrations.get(jobId);
    if (!records) {
        records = new Map();
        hydrations.set(jobId, records);
    }
    const key = recordKey(record.kind, record.id, record.characterId);
    const held = records.get(key);
    if (!held || (compareRevision(record.revision, held.revision) ?? 1) >= 0) {
        records.set(key, record);
    }
}

/**
 * The targets of the callback `call` names while it runs here and the server has not cancelled it,
 * else null: a request a captured context attributes to it runs on these ids only while it lives.
 */
export function liveChannelCallTargets(call: { jobId: string; callbackId: string }): CallbackTargets | null {
    const entry = outstanding.find((item) => item.id === call.callbackId && item.jobId === call.jobId);
    return entry && !entry.cancelled ? entry.targets : null;
}

setChannelCallSource(liveChannelCallTargets);

function answer(jobId: string, message: ChannelAnswer) {
    const entry = requests.get(message.id);
    if (entry) {
        entry.answer = message;
    }
    try {
        transports.get(jobId)?.send(message);
    } catch (error) {
        console.error("[Channel]", error);
    }
}

// ---------------------------------------------------------------------------------------------
// Notices and questions (one UI queue)

const MODAL_NOTICES = new Set(["alertNormal", "alertError", "alertMd"]);
const QUEUED_NOTICES = new Set(["alertNormal", "alertError", "alertMd", "alertToast", "alertWait", "alertClear"]);

function showNotice(jobId: string, notice: GenerationNotice): boolean {
    switch (notice.kind) {
        case "alertNormal":
            alertNormal(notice.payload.message);
            return true;
        case "alertError":
            alertError(notice.payload.message);
            return true;
        case "alertMd":
            alertMd(notice.payload.message);
            return true;
        case "alertToast":
            alertToast(notice.payload.message, (status) => jobStatuses.set(jobId, status));
            return false;
        case "alertWait":
            alertWait(notice.payload.message, (status) => jobStatuses.set(jobId, status));
            return false;
        case "alertClear":
            alertClear();
            jobStatuses.delete(jobId);
            return false;
        default:
            return false;
    }
}

/**
 * The job whose `progress` notice left the HypaV3 overlay open. Its end closes the overlay: an abort
 * closes the job's channel at once, so the server's closing notice may never arrive.
 */
let progressJobId: string | null = null;

/** A `memoryProgress` payload as the tab shows it, or null for a malformed one. */
function readMemoryProgress(payload: unknown): MemoryProgress | null {
    if (!payload || typeof payload !== "object") {
        return null;
    }
    const { chatRef, runId, open, phase, reason, done, total, text } = payload as Record<string, unknown>;
    if (!chatRef || typeof chatRef !== "object" || typeof runId !== "string") {
        return null;
    }
    const { chaId, chatId } = chatRef as Record<string, unknown>;
    if (typeof chaId !== "string" || typeof chatId !== "string") {
        return null;
    }
    if (open === false) {
        return { chatRef: { chaId, chatId }, runId, open: false };
    }
    if (open !== true || (phase !== "blocking" && phase !== "initial" && phase !== "selection")) {
        return null;
    }
    // Counts that are not two finite numbers show the indeterminate bar.
    const counted =
        typeof done === "number" && typeof total === "number" && Number.isFinite(done) && Number.isFinite(total);
    return {
        chatRef: { chaId, chatId },
        runId,
        open: true,
        phase,
        reason: reason === "pluginModel" || reason === "requestTrigger" || reason === "gap" ? reason : null,
        ...(counted ? { done, total } : {}),
        ...(typeof text === "string" ? { text } : {}),
    };
}

/**
 * A job's memory run notice: an open one becomes the job's entry (a newer run replaces the older and
 * moves last; the same run keeps its stop state), a closing one removes the entry only while it is
 * that run's.
 */
function applyMemoryProgress(state: MemoryProgressState, jobId: string, progress: MemoryProgress): MemoryProgressState {
    const { [jobId]: held, ...runs } = state.runs;
    const chats = { ...state.chats, [jobId]: progress.chatRef };
    if (!progress.open) {
        return held?.runId === progress.runId ? { ...state, runs, chats } : { ...state, chats };
    }
    const stop = held?.runId === progress.runId ? held.stop : "idle";
    return { ...state, runs: { ...runs, [jobId]: { ...progress, jobId, stop } }, chats };
}

/** The effects that never touch the alert store run at once. */
function applyEffect(jobId: string, notice: GenerationNotice) {
    switch (notice.kind) {
        case "reloadDisplay":
        case "updateGUI":
            ReloadGUIPointer.set(get(ReloadGUIPointer) + 1);
            return;
        case "reloadChat": {
            const { chaId, chatId, messageId } = notice.payload;
            const selected = currentChatRef();
            const chat = selected?.chaId === chaId && selected.chatId === chatId ? findChat(selected) : undefined;
            const index = chat ? (chat.message?.findIndex((m) => m.chatId === messageId) ?? -1) : -1;
            if (index !== -1) {
                ReloadChatPointer.update((value) => {
                    const key = reloadChatKey(messageId, index);
                    value[key] = (value[key] ?? 0) + 1;
                    return value;
                });
            }
            return;
        }
        case "emotion": {
            const { chaId, name, image } = notice.payload;
            const emotions = get(CharEmotion);
            const list = [...(emotions[chaId] ?? [])];
            if (list.length > 4) {
                list.splice(0, 1);
            }
            list.push([name, image, Date.now()]);
            CharEmotion.set({ ...emotions, [chaId]: list });
            return;
        }
        case "progress": {
            // The value is remembered with its job: a job that reports memory runs shows it only in
            // its own chat (`legacyProgressShown`).
            const value = { ...notice.payload };
            hypaV3ProgressStore.set(value);
            memoryProgressStore.update((state) => ({ ...state, legacy: { value, jobId } }));
            return;
        }
        case "memoryProgress": {
            const progress = readMemoryProgress(notice.payload);
            if (progress) {
                memoryProgressStore.update((state) => applyMemoryProgress(state, jobId, progress));
            }
            return;
        }
        case "tts": {
            const { chaId, text } = notice.payload;
            const character = characterList().find((entry) => entry?.chaId === chaId);
            if (character && character.type !== "group") {
                void import("../process/tts").then(({ sayTTS }) => sayTTS(character, text)).catch(console.error);
            }
            return;
        }
        case "notification":
            // The permission is asked only from a click (`pushNotifications.ts`), never here.
            if (settings.ui.notification) {
                void import("./pushNotifications")
                    .then(({ showCompletionNotification }) => showCompletionNotification(notice.payload))
                    .catch(console.error);
            }
            return;
        case "translating": {
            // The send's messages the server translates: shown loading while the tab follows them. A
            // failure is queued like an `alertError` notice: it never replaces a question.
            const { chaId, chatId, messageIds } = notice.payload;
            const report = (message: string) =>
                enqueueUi({ type: "notice", jobId, notice: { kind: "alertError", payload: { message } } });
            if (
                typeof chaId === "string" &&
                typeof chatId === "string" &&
                Array.isArray(messageIds) &&
                messageIds.every((id) => typeof id === "string")
            ) {
                void import("../translator/storedTranslation.svelte")
                    .then(({ followStoredTranslations }) =>
                        followStoredTranslations({ chaId, chatId }, messageIds, { report }),
                    )
                    .catch(console.error);
            }
            return;
        }
        case "openURL": {
            // An MCP server's OAuth page: only a web address is opened.
            const { url } = notice.payload;
            if (typeof url === "string" && /^https?:\/\//i.test(url)) {
                void import("../globalApi.svelte").then(({ openURL }) => openURL(url)).catch(console.error);
            }
            return;
        }
    }
}

async function ask(event: GenerationQuestionEvent): Promise<unknown> {
    switch (event.kind) {
        case "alertInput":
            return await alertInput(event.payload.message, event.payload.datalist, event.payload.defaultValue);
        case "alertSelect":
            return await alertSelect(event.payload.options, event.payload.display);
        case "alertConfirm":
            return await alertConfirm(event.payload.message);
        case "alertSelectChar":
            return await alertSelectChar();
        case "alertModuleSelect":
            return await alertModuleSelect();
        case "memoryTrim": {
            // The buttons answer their index; anything else is no answer (the server ends the send).
            const picked = await alertSelect(
                [language.memoryTrimEnable, language.memoryTrimOnce, language.memoryTrimIgnore],
                language.memoryTrimWarning,
            );
            return /^[0-2]$/.test(picked) ? MEMORY_TRIM_CHOICES[Number(picked)] : null;
        }
        case "memoryGap": {
            const { gapTokens, plannedCalls, lastTaskError } = event.payload;
            let text = language.hypaV3Progress.gapQuestion(gapTokens, plannedCalls);
            if (typeof lastTaskError === "string" && lastTaskError !== "") {
                text += ` ${language.hypaV3Progress.gapLastError(lastTaskError)}`;
            }
            // The selection dialog separates its text and buttons with `||`: no pipe of the text may
            // stay one, or the buttons would shift.
            const picked = await alertSelect(
                [language.hypaV3Progress.gapGenerate, language.hypaV3Progress.gapContinue],
                text.replaceAll("|", "\u00a6"),
            );
            return /^[01]$/.test(picked) ? MEMORY_GAP_CHOICES[Number(picked)] : null;
        }
    }
}

async function drainUi() {
    if (uiBusy) {
        return;
    }
    uiBusy = true;
    try {
        while (uiQueue.length > 0) {
            const item = uiQueue.shift()!;
            if (item.type === "notice") {
                // A modal notice: its own dialog is awaited (not every local dialog queued with it).
                const { dialog } = openAlertDialog(() => showNotice(item.jobId, item.notice));
                if (dialog) {
                    await dialog.closed;
                }
                continue;
            }
            let release!: () => void;
            const released = new Promise<void>((resolve) => {
                release = resolve;
            });
            let value: unknown;
            let failed = false;
            let failure: unknown;
            // The alert functions queue their dialog synchronously: this is the dialog this question owns.
            const { value: result, dialog } = openAlertDialog(() =>
                ask(item.event).then(
                    (resolved) => {
                        value = resolved;
                    },
                    (error) => {
                        failed = true;
                        failure = error;
                    },
                ),
            );
            const current = { id: item.event.id, jobId: item.jobId, dialog, cancelled: false, release };
            showing = current;
            // A cancel (or the job's end) removes the dialog and releases the queue at once; the helper's
            // own result (the cancelled dialog closes with "") is ignored.
            await Promise.race([result, released]);
            showing = null;
            if (current.cancelled) {
                continue;
            }
            if (failed) {
                console.error("[Channel]", failure);
                continue;
            }
            answer(item.jobId, { type: "answer", id: item.event.id, outcome: "answered", value });
        }
    } finally {
        uiBusy = false;
    }
}

/**
 * Cancels the question asked now: removes its own dialog, whether shown or still queued behind
 * another, and releases the queue.
 */
function cancelShowing() {
    const current = showing;
    if (!current || current.cancelled) {
        return;
    }
    current.cancelled = true;
    current.dialog?.cancel();
    current.release();
}

function enqueueUi(item: UiItem) {
    uiQueue.push(item);
    void drainUi();
}

// ---------------------------------------------------------------------------------------------
// Callbacks

class CallbackFailed extends Error {
    readonly failure: CallbackFailure;
    readonly discarded: string[] | undefined;
    constructor(failure: CallbackFailure, message: string, discarded?: string[]) {
        super(message);
        this.failure = failure;
        this.discarded = discarded;
    }
}

const cancelledByServer = () => new CallbackFailed("protocol", "The server cancelled this callback");

/** Whether this client holds `receipt`'s record at its revision or a newer one. */
function holds(receipt: HydrationReceipt): boolean {
    const held =
        receipt.kind === "chats"
            ? heldChatRevision({ chaId: receipt.characterId ?? "", chatId: receipt.id })
            : heldRecordRevision(receipt.kind, receipt.id);
    return held !== null && (compareRevision(held, receipt.revision) ?? -1) >= 0;
}

async function barrier(entry: Outstanding, event: GenerationCallbackEvent) {
    let discarded: string[];
    try {
        ({ discarded } = await flushResources());
    } catch (error) {
        throw new CallbackFailed("barrier", `Local changes could not be saved: ${errorText(error)}`);
    }
    if (discarded.length > 0) {
        throw new CallbackFailed("barrier", "A conflict discarded local changes before the callback", discarded);
    }
    for (const receipt of event.revisions) {
        const key = recordKey(receipt.kind, receipt.id, receipt.characterId);
        const record = hydrations.get(entry.jobId)?.get(key);
        if (record && !entry.cancelled && !holds(receipt)) {
            applyHydration(record);
        }
        if (
            !entry.cancelled &&
            record?.kind === "chats" &&
            record.characterId !== undefined &&
            record.job?.jobId === entry.jobId &&
            (compareRevision(record.revision, receipt.revision) ?? -1) >= 0 &&
            !holds(receipt)
        ) {
            const canApply = prepareChatHydrationRefresh(
                { chaId: record.characterId, chatId: record.id },
                record.revision,
            );
            if (canApply) {
                const epoch = getResourceEpoch();
                if (entry.cancelled) {
                    throw cancelledByServer();
                }
                if (epoch !== event.epoch) {
                    throw new CallbackFailed("barrier", "The callback's resource epoch changed");
                }
                const result = await readRefs([], { chats: [{ characterId: record.characterId, id: record.id }] });
                if (entry.cancelled || !outstanding.includes(entry)) {
                    throw cancelledByServer();
                }
                if (getResourceEpoch() !== epoch || result.epoch !== epoch) {
                    throw new CallbackFailed("barrier", "The callback's resource epoch changed");
                }
                // A job resync may have satisfied the receipt while this read was in flight.
                if (!holds(receipt)) {
                    const fresh = result.chats?.find(
                        (chat) => chat.characterId === record.characterId && chat.id === record.id,
                    );
                    if (
                        hydrations.get(entry.jobId)?.get(key) === record &&
                        fresh?.revision != null &&
                        fresh.data != null &&
                        canApply(fresh)
                    ) {
                        applyHydration({ ...record, revision: fresh.revision, data: fresh.data });
                    }
                }
            }
        }
        if (!holds(receipt)) {
            throw new CallbackFailed(
                "barrier",
                `The ${receipt.kind} record ${receipt.id} the job changed is not applied on this client`,
            );
        }
    }
    // A later receipt's read can outlive a reset of an earlier record.
    if (event.revisions.some((receipt) => !holds(receipt))) {
        throw new CallbackFailed("barrier", "A record the job changed is no longer applied on this client");
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Runs the hook set a callback names, in order, under the job's targets. */
async function runHook(event: GenerationCallbackEvent, entry: Outstanding): Promise<unknown> {
    // The job's targets, and this callback as the parent of any aux request the hook makes.
    const context: PluginCallContext = { ...event.targets, channelCall: { jobId: entry.jobId, callbackId: event.id } };
    const payload = event.payload as Record<string, unknown>;
    const stillWanted = () => {
        if (entry.cancelled) {
            throw cancelledByServer();
        }
    };
    const unavailable = () => new CallbackFailed("protocol", `The ${event.name} hook is not registered any more`);
    // Nothing starts once the server cancelled the callback (during the barrier, say).
    stillWanted();
    switch (event.name) {
        case "replacerbeforeRequest": {
            if (pluginHooks.replacerbeforeRequest.size === 0) {
                throw unavailable();
            }
            let messages = payload.messages as OpenAIChat[];
            for (const replacer of pluginHooks.replacerbeforeRequest) {
                stillWanted();
                messages = await invokeHook(replacer, context, messages, String(payload.model));
            }
            return messages;
        }
        case "replacerafterRequest": {
            if (pluginHooks.replacerafterRequest.size === 0) {
                throw unavailable();
            }
            let text = String(payload.text);
            for (const replacer of pluginHooks.replacerafterRequest) {
                stillWanted();
                text = await invokeHook(replacer, context, text, String(payload.model));
            }
            return text;
        }
        case "editinput":
        case "editprocess":
        case "editoutput":
        case "editdisplay": {
            const hooks = pluginHooks[event.name as ScriptHookMode];
            if (hooks.size === 0) {
                throw unavailable();
            }
            let text = String(payload.text);
            for (const hook of hooks) {
                stillWanted();
                const result = await invokeHook(hook, context, text);
                if (result !== null && result !== undefined) {
                    text = result;
                }
            }
            return text;
        }
        case "bodyIntercepter": {
            if (bodyIntercepterStore.length === 0) {
                throw unavailable();
            }
            // As the browser path: each interceptor's throw is logged and the body so far kept. The
            // interceptors run without the hook context, as they do today (recorded residual).
            let body = payload.body;
            for (const interceptor of bodyIntercepterStore) {
                stillWanted();
                try {
                    body = (await interceptor.callback(body, String(payload.type))) || body;
                } catch (error) {
                    console.error(error);
                }
            }
            return body;
        }
        case "mcpList":
        case "mcpTool": {
            // A plugin MCP as it is registered now, or one of the two internal MCPs that live in the
            // tab (handshaken here: a directory picker, a credential prompt), shared with the
            // browser path's registry.
            const identifier = String(payload.identifier);
            const isTabClient = TAB_MCP_IDENTIFIERS.includes(identifier);
            let client: MCPClientLike | undefined;
            if (isTabClient) {
                const registry = await import("../process/mcp/mcp");
                // No picker or prompt is started for a callback the server already cancelled.
                stillWanted();
                client = await registry.readyTabClient(identifier);
            } else {
                client = registeredCustomPluginMCPs.get(identifier);
            }
            if (!client) {
                throw unavailable();
            }
            stillWanted();
            if (event.name === "mcpList") {
                const tools = await (isTabClient ? client.getToolList() : client.getToolList(context));
                stillWanted();
                return tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                }));
            }
            const content = await (isTabClient
                ? client.callTool(String(payload.tool), payload.args)
                : client.callTool(String(payload.tool), payload.args, context));
            stillWanted();
            return content;
        }
        case "selectedChat": {
            // The chat of a character this tab has selected (the selection is the tab's own).
            const target = characterList().find((entry) => entry?.chaId === String(payload.characterId));
            const chatId = target ? selectedChatId(target.chaId) : null;
            return typeof chatId === "string" ? { chatId } : null;
        }
        case "generateImage": {
            // Lua `generateImage` on the server: generated here with the tab's image settings and keys,
            // written as an inlay, answered with its id.
            const characterId = String(payload.characterId);
            const target = characterList().find((entry) => entry?.chaId === characterId);
            if (!target || target.type === "group") {
                throw new CallbackFailed("hook", "The character to generate for is gone");
            }
            const { generateAIImage } = await import("../process/stableDiff");
            const { writeInlayImage } = await import("../process/files/inlays");
            stillWanted();
            const generated = await generateAIImage(
                String(payload.prompt),
                target as character,
                String(payload.negative ?? ""),
                "inlay",
                {
                    signal: entry.abort.signal,
                    ...(payload.orientation === "landscape" || payload.orientation === "portrait"
                        ? { orientation: payload.orientation }
                        : {}),
                },
            );
            stillWanted();
            if (!generated) {
                throw new CallbackFailed("hook", "Image generation failed");
            }
            const image = new Image();
            image.src = generated;
            return { id: await writeInlayImage(image, { check: stillWanted }) };
        }
        case "inlayImage": {
            // An image the server cannot draw (no canvas there): a stored asset (Lua
            // `getCharacterImage`/`getPersonaImage`, under the asset key) or a model's image.
            const id = String(payload.id);
            const { writeInlayImage } = await import("../process/files/inlays");
            const image = new Image();
            let options: { id: string; name?: string; ext?: string; check: () => void } = { id, check: stillWanted };
            // An asset's object URL is read only by the draw; released once the write is done or failed.
            let objectUrl: string | null = null;
            try {
                if (typeof payload.asset === "string") {
                    const asset = payload.asset;
                    const { readImage } = await import("../globalApi.svelte");
                    const bytes = await readImage(asset);
                    const ext = asset.split(".").at(-1);
                    objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: `image/${ext}` }));
                    image.src = objectUrl;
                    stillWanted();
                    options = { id, name: asset, ext, check: stillWanted };
                } else {
                    image.src = `data:${String(payload.mimeType)};base64,${String(payload.data)}`;
                }
                return { id: await writeInlayImage(image, options) };
            } finally {
                if (objectUrl) URL.revokeObjectURL(objectUrl);
            }
        }
        case "chatOutput": {
            // The `chatOutput` listeners of a server send's reply, in order. Each gets the speaker and
            // the chat as they are now (a plain copy) and indices looked up again: an earlier listener
            // may have changed, reordered, or deleted them. A listener's throw is logged and the next
            // one runs, as in the tab's own send.
            const { chaId, chatId } = context.chatRef;
            const messageId = String(payload.messageId);
            const speakerId = String(payload.speakerId);
            const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
            // The speaker's chats (another character in a group) are pinned and loaded before each
            // listener: its copy carries them all, and an earlier listener may have changed them.
            const releaseSpeaker = pinChats(speakerId);
            try {
                // The live set, as the tab's own send walks it: a listener an earlier one removed does not
                // run, one it added does.
                for (const listener of pluginHooks.chatOutput) {
                    stillWanted();
                    await loadChats(speakerId);
                    stillWanted();
                    // The plugin's `characterIndex` is the list position (the plugin index API's mapping).
                    const characterIndex = characterList().findIndex((entry) => entry?.chaId === chaId);
                    const owner = characterList()[characterIndex];
                    const chatIndex = owner ? chatList(owner.chaId).findIndex((entry) => entry.id === chatId) : -1;
                    const chat = chatIndex === -1 ? undefined : findChat({ chaId, chatId });
                    const speaker = characterList().find((entry) => entry?.chaId === speakerId);
                    if (!owner || !chat || !speaker) {
                        throw new CallbackFailed("hook", "The chat the output listeners run for is gone");
                    }
                    try {
                        await invokeHook(listener, context, {
                            // The legacy shape a plugin listener gets: the speaker with its chats.
                            char: withChatsCopy(plain(speaker)),
                            chat: plain(chat),
                            characterIndex,
                            chatIndex,
                            messageIndex: chat.message.findIndex((message) => message.chatId === messageId),
                        });
                    } catch (error) {
                        console.error(error);
                    }
                }
            } finally {
                releaseSpeaker();
            }
            return true;
        }
        case "imggen": {
            // The image view of a server send's reply: `stableDiff` with the tab's image settings and
            // keys; its prompt request runs for the job's chat, preset, and persona.
            const characterId = String(payload.characterId);
            const target = characterList().find((entry) => entry?.chaId === characterId);
            if (!target || target.type === "group") {
                throw new CallbackFailed("hook", "The character to generate for is gone");
            }
            const { stableDiff } = await import("../process/stableDiff");
            stillWanted();
            const shown = await stableDiff(target as character, String(payload.text), {
                chatRef: context.chatRef,
                pluginContext: context,
                check: stillWanted,
                signal: entry.abort.signal,
            });
            stillWanted();
            return shown !== false;
        }
        case "provider": {
            // A plugin provider model of a server job: the provider runs here with the argument the
            // server built from the job's settings, as the tab's own `requestPlugin` calls it. An
            // unloaded provider fails the callback (the job's request fails).
            const name = String(payload.name);
            const provider = pluginHooks.providers.get(name);
            if (!provider) {
                throw new CallbackFailed("hook", `The plugin provider ${name} is not loaded any more`);
            }
            const abort = new AbortController();
            entry.onCancel = () => abort.abort();
            stillWanted();
            const answered = await invokeHook(
                provider,
                context,
                payload.argument as Parameters<typeof provider>[0],
                abort.signal,
            );
            const content = answered?.content;
            if (!(content instanceof ReadableStream)) {
                stillWanted();
                if (!answered) {
                    return { none: true };
                }
                const text = content ?? "";
                if (text.length > MAX_PROVIDER_TEXT_CHARS) {
                    throw new CallbackFailed("hook", "The provider's text is too long");
                }
                return { success: !!answered.success, content: text };
            }
            // A stream, of an answer or of a failure: read here, and released whenever the callback
            // ends first (the server's cancel, the job's end, a text too long), also when the provider
            // returned it after the cancel.
            const reader = content.getReader();
            let timer: ReturnType<typeof setTimeout> | null = null;
            const release = () => {
                if (timer !== null) {
                    clearTimeout(timer);
                    timer = null;
                }
                void reader.cancel().catch(() => {});
            };
            entry.onCancel = () => {
                abort.abort();
                release();
            };
            try {
                stillWanted();
                let fullText = "";
                const decoder = new TextDecoder();
                const add = (text: string) => {
                    fullText += text;
                    if (fullText.length > MAX_PROVIDER_TEXT_CHARS) {
                        throw new CallbackFailed("hook", "The provider's text is too long");
                    }
                };
                // A provider's stream carries text; bytes are decoded as `new Response(stream).text()`
                // decodes them (the tab's own path for a failed stream), an unfinished sequence at the
                // end included (`finish`).
                const take = (value: unknown) =>
                    add(typeof value === "string" ? value : decoder.decode(value as Uint8Array, { stream: true }));
                const finish = () => add(decoder.decode());
                if (!answered.success) {
                    for (;;) {
                        const read = await reader.read();
                        stillWanted();
                        if (read.value !== undefined) {
                            take(read.value);
                        }
                        if (read.done) {
                            break;
                        }
                    }
                    finish();
                    return { success: false, content: fullText };
                }
                // The text so far goes out as `chunk` messages: the first at once, so the server knows
                // it is a stream; then the newest text at most every 50 ms and at the end.
                let sent: string | null = null;
                let lastSent = 0;
                const flush = () => {
                    if (timer !== null) {
                        clearTimeout(timer);
                        timer = null;
                    }
                    if (entry.cancelled || sent === fullText) {
                        return;
                    }
                    sent = fullText;
                    lastSent = Date.now();
                    transports.get(entry.jobId)?.send({ type: "chunk", id: entry.id, text: fullText });
                };
                flush();
                for (;;) {
                    const read = await reader.read();
                    stillWanted();
                    if (read.value !== undefined) {
                        take(read.value);
                        const wait = PROVIDER_CHUNK_INTERVAL_MS - (Date.now() - lastSent);
                        if (wait <= 0) {
                            flush();
                        } else if (timer === null) {
                            // Text that waits for the interval goes out when it has passed, whether
                            // or not the provider sends more.
                            timer = setTimeout(flush, wait);
                        }
                    }
                    if (read.done) {
                        break;
                    }
                }
                finish();
                flush();
                return { success: true, streamed: true };
            } catch (error) {
                release();
                throw error;
            } finally {
                if (timer !== null) {
                    clearTimeout(timer);
                    timer = null;
                }
                // The reads are over: the stream is the provider's again.
                try {
                    reader.releaseLock();
                } catch {}
            }
        }
    }
}

async function runCallback(event: GenerationCallbackEvent, entry: Outstanding): Promise<ChannelAnswer> {
    const failedAnswer = (failure: CallbackFailure, error: string, discarded?: string[]): ChannelAnswer => ({
        type: "answer",
        id: event.id,
        outcome: "failed",
        failure,
        error,
        ...(discarded ? { discarded } : {}),
    });
    try {
        await barrier(entry, event);
    } catch (error) {
        return error instanceof CallbackFailed
            ? failedAnswer(error.failure, error.message, error.discarded)
            : failedAnswer("barrier", errorText(error));
    }
    const scope = beginMutationScope();
    let value: unknown;
    // Whether the hook threw, whatever it threw (`0` and `undefined` included).
    let threw = false;
    let hookError: unknown;
    try {
        value = await runHook(event, entry);
    } catch (error) {
        threw = true;
        hookError = error;
    }
    // The hook's changes are settled even when it threw: a barrier failure wins over its error.
    try {
        const { discarded } = await flushResources({ scope });
        if (discarded.length > 0) {
            return failedAnswer("barrier", "A conflict discarded changes the callback made", discarded);
        }
    } catch (error) {
        return failedAnswer("barrier", `The callback's changes could not be saved: ${errorText(error)}`);
    }
    if (threw) {
        return failedAnswer(hookError instanceof CallbackFailed ? hookError.failure : "hook", errorText(hookError));
    }
    // The result must survive the wire as JSON (`undefined`, a function, a bigint, or a cycle does not).
    let wire: string | undefined;
    try {
        wire = JSON.stringify(value);
    } catch (error) {
        return failedAnswer("protocol", `The ${event.name} result is not JSON: ${errorText(error)}`);
    }
    if (wire === undefined) {
        return failedAnswer("protocol", `The ${event.name} hook returned no JSON value`);
    }
    return { type: "answer", id: event.id, outcome: "answered", value: JSON.parse(wire) };
}

function takeHeldChild() {
    const held = heldChild;
    if (held) {
        clearTimeout(held.timer);
        heldChild = null;
    }
    return held;
}

function retireHeldChild() {
    const held = takeHeldChild();
    const state = held && requests.get(held.event.id);
    if (state) {
        state.retired = true;
    }
}

function resumeHeldChild() {
    if (!heldChild) {
        return;
    }
    const { parent, event } = heldChild;
    if (parent.cancelled || !outstanding.includes(parent) || Date.now() >= event.deadline) {
        // The server owns timeout outcomes and sends the cancellation; an expired child never starts.
        retireHeldChild();
        return;
    }
    if (outstanding.some((entry) => entry !== parent)) {
        return;
    }
    const held = takeHeldChild()!;
    startCallback(held.jobId, held.event);
}

function holdChild(jobId: string, event: GenerationCallbackEvent, parent: Outstanding) {
    const expire = () => {
        if (heldChild?.event !== event) {
            return;
        }
        if (Date.now() < event.deadline) {
            heldChild.timer = setTimeout(expire, event.deadline - Date.now());
            return;
        }
        retireHeldChild();
    };
    heldChild = { jobId, event, parent, timer: setTimeout(expire, Math.max(0, event.deadline - Date.now())) };
}

function handleCallback(jobId: string, event: GenerationCallbackEvent) {
    const known = requests.get(event.id);
    if (known) {
        // A duplicate (a reattach): never run twice; the answer goes out when it exists.
        if (known.answer) {
            answer(jobId, known.answer);
        }
        return;
    }
    const refuse = (error: string) => {
        remember(event.id, { jobId, answer: null, callback: true });
        answer(jobId, { type: "answer", id: event.id, outcome: "failed", failure: "protocol", error });
    };
    if (event.replay) {
        refuse("The callback may already have run before this page loaded; it is not run again");
        return;
    }
    const live = outstanding.filter((entry) => !entry.cancelled);
    const top = live[live.length - 1];
    if (
        event.parentId === undefined
            ? outstanding.length > 0
            : !top ||
              top.id !== event.parentId ||
              top.parentId !== undefined ||
              heldChild !== null ||
              outstanding.some((entry) => entry !== top && (!entry.cancelled || entry.parentId !== top.id))
    ) {
        refuse("A callback may run only inside the outstanding one, one level deep");
        return;
    }
    remember(event.id, { jobId, answer: null, callback: true });
    if (event.parentId !== undefined && outstanding.length > 1) {
        holdChild(jobId, event, top);
        return;
    }
    startCallback(jobId, event);
}

function startCallback(jobId: string, event: GenerationCallbackEvent) {
    const entry: Outstanding = {
        jobId,
        id: event.id,
        parentId: event.parentId,
        targets: event.targets,
        cancelled: false,
        abort: new AbortController(),
    };
    outstanding.push(entry);
    // A running callback is plugin work: a plugin reload waits for it (`generationJobs.ts`).
    noteChannelCallbacks(outstanding.length);
    const settle = () => {
        const index = outstanding.indexOf(entry);
        if (index !== -1) {
            outstanding.splice(index, 1);
        }
        resumeHeldChild();
        noteChannelCallbacks(outstanding.length);
        // The server kept the lane for a callback it cancelled until its hook is over (this point).
        if (entry.cancelled) {
            void reportCallbackDrained(jobId, event.id);
        }
    };
    void runCallback(event, entry)
        .then((message) => {
            settle();
            if (entry.cancelled) {
                const state = requests.get(event.id);
                if (state) {
                    state.answer = message;
                }
                return;
            }
            answer(jobId, message);
        })
        .catch((error) => {
            settle();
            console.error("[Channel]", error);
        });
}

/**
 * The plugin hooks registered now (`GenerationHooks`), from the active registries: each provider
 * with a copy of its model descriptor (with the custom flags of `scope`'s model preset, the job's;
 * else of the settings views'), the body interceptors, and the plugin MCP identifiers.
 */
export async function registeredHooks(scope?: PresetScope): Promise<GenerationHooks> {
    const { getModelInfo } = await import("../model/modellist");
    return {
        replacers: {
            beforeRequest: pluginHooks.replacerbeforeRequest.size > 0,
            afterRequest: pluginHooks.replacerafterRequest.size > 0,
        },
        scripts: SCRIPT_HOOK_MODES.filter((mode) => pluginHooks[mode].size > 0),
        interceptors: bodyIntercepterStore.length > 0,
        chatOutput: pluginHooks.chatOutput.size > 0,
        providers: [...pluginHooks.providers.keys()].map((name) => ({
            name,
            model: JSON.parse(JSON.stringify(getModelInfo(`pluginmodel:::${name}`, scope))),
        })),
        mcpTools: [...registeredCustomPluginMCPs.keys()],
    };
}

/**
 * The emotions this tab showed last (`CharEmotion`) for the chat's character, or for each member of
 * its group, oldest first (`GenerationClientEnv.emotions`).
 */
export function recentEmotions(chaId: string): Record<string, string[]> {
    const owner = characterList().find((entry) => entry?.chaId === chaId);
    const ids = owner?.type === "group" ? owner.characters : [chaId];
    const shown = get(CharEmotion);
    const emotions: Record<string, string[]> = {};
    for (const id of ids.slice(0, 256)) {
        const names = (shown[id] ?? []).map((entry) => entry[0]).filter((name) => name.length <= 256);
        if (names.length > 0) {
            emotions[id] = names.slice(-5);
        }
    }
    return emotions;
}

// ---------------------------------------------------------------------------------------------
// Entry points

/** Routes one channel event of `jobId`'s socket; answers go out through `transport`. */
export function handleChannelEvent(jobId: string, event: GenerationChannelEvent, transport: ChannelTransport) {
    transports.set(jobId, transport);
    switch (event.type) {
        case "notice": {
            const notice = event as unknown as GenerationNotice;
            if (QUEUED_NOTICES.has(notice.kind)) {
                if (uiBusy || uiQueue.length > 0) {
                    enqueueUi({ type: "notice", jobId, notice });
                } else if (MODAL_NOTICES.has(notice.kind)) {
                    enqueueUi({ type: "notice", jobId, notice });
                } else {
                    showNotice(jobId, notice);
                }
            } else {
                if (notice.kind === "progress") {
                    if (notice.payload.open) {
                        progressJobId = jobId;
                    } else if (progressJobId === jobId) {
                        progressJobId = null;
                    } else if (progressJobId !== null) {
                        // Another job's overlay is showing: this job's closing notice is not for it.
                        return;
                    }
                }
                applyEffect(jobId, notice);
            }
            return;
        }
        case "question": {
            const known = requests.get(event.id);
            if (known?.answer) {
                answer(jobId, known.answer);
                return;
            }
            if (
                known ||
                showing?.id === event.id ||
                uiQueue.some((item) => item.type === "question" && item.event.id === event.id)
            ) {
                return;
            }
            remember(event.id, { jobId, answer: null });
            enqueueUi({ type: "question", jobId, event });
            return;
        }
        case "callback":
            handleCallback(jobId, event);
            return;
        case "cancel": {
            if (heldChild?.event.id === event.id) {
                retireHeldChild();
            }
            const index = uiQueue.findIndex((item) => item.type === "question" && item.event.id === event.id);
            if (index !== -1) {
                uiQueue.splice(index, 1);
            }
            if (showing?.id === event.id) {
                cancelShowing();
            }
            // A cancelled request is finished: it can be forgotten, and a late duplicate stays dropped.
            const state = requests.get(event.id);
            const running = outstanding.some((entry) => entry.id === event.id);
            if (state && !state.answer && !running) {
                state.retired = true;
            }
            // A callback that runs no more when the cancel comes (its answer or refusal crossed it, or could
            // not leave a socket that was closing): the lane the server kept for it is free now.
            if (state?.callback && !running) {
                void reportCallbackDrained(state.jobId, event.id);
            }
            for (const entry of outstanding) {
                if (entry.id === event.id) {
                    cancelOutstanding(entry);
                }
            }
            resumeHeldChild();
            return;
        }
    }
}

/** The memory-stop route's answers for a run that cannot be stopped any more (ended, absent, or replaced). */
const ENDED_MEMORY_RUN = new Set(["jobEnded", "noMemoryRun", "otherMemoryRun"]);

/**
 * "Stop here and continue" for the initial memory run `runId` of `jobId` (`POST
 * /api/generations/:id/memory-stop`): asked once while the run is the job's entry; the entry's
 * `stop` follows the request. A failure is reported only while the run is still shown.
 */
export async function stopMemoryRun(jobId: string, runId: string): Promise<void> {
    const current = (): MemoryProgressEntry | null => {
        const entry = get(memoryProgressStore).runs[jobId];
        return entry?.runId === runId ? entry : null;
    };
    const setStop = (stop: MemoryProgressEntry["stop"]) =>
        memoryProgressStore.update((state) => {
            const held = state.runs[jobId];
            return held?.runId === runId ? { ...state, runs: { ...state.runs, [jobId]: { ...held, stop } } } : state;
        });
    const entry = current();
    if (!entry || entry.phase !== "initial" || entry.stop !== "idle") {
        return;
    }
    setStop("pending");
    let failure: string;
    try {
        const response = await authFetch(
            `/api/generations/${encodeURIComponent(jobId)}/memory-stop?clientId=${encodeURIComponent(generationClientId())}`,
            {
                method: "POST",
                cache: "no-store",
                headers: { "content-type": "application/json", [RESOURCE_EPOCH_HEADER]: getResourceEpoch() },
                body: JSON.stringify({ runId }),
            },
        );
        if (response.ok) {
            setStop("requested");
            return;
        }
        let body: { error?: unknown; epoch?: unknown } = {};
        try {
            const parsed: unknown = await response.json();
            if (parsed && typeof parsed === "object") {
                body = parsed;
            }
        } catch {}
        if (response.status === 412 && body.error === "EpochMismatch") {
            // The restore notice and reload, as for any other request to the server.
            epochMismatch(typeof body.epoch === "string" ? body.epoch : "");
            setStop("unavailable");
            return;
        }
        if (response.status === 409 && typeof body.error === "string" && ENDED_MEMORY_RUN.has(body.error)) {
            setStop("unavailable");
            return;
        }
        failure = typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
    } catch (error) {
        failure = errorText(error);
    }
    if (current()) {
        setStop("idle");
        alertError(language.hypaV3Progress.stopFailed(failure));
    }
}

/** The job ended: its questions and statuses are dropped; modal notices stay and callbacks stop starting hooks. */
export function endJobChannel(jobId: string) {
    hydrations.delete(jobId);
    const status = jobStatuses.get(jobId);
    jobStatuses.delete(jobId);
    if (status) {
        alertStore.clearStatus(status);
    }
    // A cancel the socket lost (a disconnect) must not leave the job's question open.
    if (showing?.jobId === jobId) {
        cancelShowing();
    }
    if (progressJobId === jobId) {
        progressJobId = null;
        hypaV3ProgressStore.set({ open: false, miniMsg: "", msg: "", subMsg: "" });
    }
    memoryProgressStore.update((state) => {
        if (!(jobId in state.runs) && !(jobId in state.chats) && state.legacy?.jobId !== jobId) {
            return state;
        }
        const { [jobId]: _run, ...runs } = state.runs;
        const { [jobId]: _chat, ...chats } = state.chats;
        return { runs, chats, legacy: state.legacy?.jobId === jobId ? null : state.legacy };
    });
    for (let index = uiQueue.length - 1; index >= 0; index -= 1) {
        const item = uiQueue[index];
        if (item.jobId === jobId && (item.type === "question" || !MODAL_NOTICES.has(item.notice.kind))) {
            uiQueue.splice(index, 1);
        }
    }
    for (const entry of outstanding) {
        if (entry.jobId === jobId) {
            cancelOutstanding(entry);
        }
    }
    if (heldChild?.jobId === jobId) {
        retireHeldChild();
    }
    resumeHeldChild();
    for (const [id, state] of requests) {
        if (state.jobId === jobId && !state.answer && !outstanding.some((entry) => entry.id === id)) {
            state.retired = true;
        }
    }
    transports.delete(jobId);
}
