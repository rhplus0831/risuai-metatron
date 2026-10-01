import { setChannelCallSource } from "./channelCallSource";
import { get } from "svelte/store";
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
    ScriptHookMode,
} from "../../../shared/jobs.ts";
import { SCRIPT_HOOK_MODES } from "../../../shared/jobs.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import { compareRevision } from "../../../shared/resources.ts";
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
    waitAlert,
} from "../alert";
import { registeredCustomPluginMCPs } from "../process/mcp/pluginmcp";
import { invokeHook, type PluginCallContext } from "../plugins/apiV3/pluginContext";
import { pluginHooks } from "../plugins/pluginHooks";
import { heldChatRevision } from "../storage/chatStore.svelte";
import {
    applyHydration,
    beginMutationScope,
    flushResources,
    heldRecordRevision,
    type HydrationRecord,
} from "../storage/resourceSync.svelte";
import {
    alertStore as alertState,
    bodyIntercepterStore,
    CharEmotion,
    DBState,
    hypaV3ProgressStore,
    ReloadChatPointer,
    ReloadGUIPointer,
    selectedCharID,
} from "../stores.svelte";

/**
 * The client side of the job channel (Phase 5, `job-channel`; `shared/jobs.ts`): it shows a job's
 * notices, asks its questions, and runs its plugin callbacks, answering through the job's socket.
 *
 * - Events are taken in socket order without waiting for a callback to finish, so an aux request's
 *   child callback can run while its parent waits.
 * - The UI is one queue: notices and questions are shown one at a time while a question or a modal
 *   notice is open (toasts too: a toast would replace the question in the shared alert store); a
 *   modal notice is awaited before the next. A `cancel` closes a question that is showing and drops
 *   its answer.
 * - A callback runs behind the barrier: pending local work is flushed, the newest hydration of every
 *   record the server listed is applied again, and each must be held at least as new as listed;
 *   otherwise the answer is `failed`/`barrier`. The hook set runs under the job's targets
 *   (`invokeHook`), then the changes it made are flushed in a mutation scope (also when it threw): a
 *   discarded key or a rejected flush is `failed`/`barrier`.
 * - Each request's state is kept in memory: a duplicate delivery never runs a callback twice (the
 *   cached answer is sent again), and a `replay` this page has no state for is refused
 *   (`failed`/`protocol`), since it may already have run on the page before a reload.
 */

/** Where the dispatcher sends its answers for one job (the job's current follow). */
export type ChannelTransport = { send(message: ChannelAnswer): boolean };

type Outstanding = { jobId: string; id: string; targets: CallbackTargets; cancelled: boolean };

type UiItem =
    | { type: "notice"; jobId: string; notice: GenerationNotice }
    | { type: "question"; jobId: string; event: GenerationQuestionEvent };

const MAX_REMEMBERED = 500;

const transports = new Map<string, ChannelTransport>();
/** Request id → its state; a finished one keeps its answer for a duplicate delivery. */
const requests = new Map<string, { jobId: string; answer: ChannelAnswer | null; retired?: true }>();
const outstanding: Outstanding[] = [];
const uiQueue: UiItem[] = [];
let uiBusy = false;
/** The question showing now: its job, the alert it opened (to close only its own), and its cancellation. */
let showing: { id: string; jobId: string; alert: unknown; cancelled: boolean; release: () => void } | null = null;
/** The newest hydration this client received per record (for the callback barrier). */
const hydrations = new Map<string, HydrationRecord>();

const recordKey = (kind: string, id: string, characterId?: string) =>
    kind === "chats" ? `chats\u0000${characterId ?? ""}\u0000${id}` : `${kind}\u0000${id}`;

function remember(id: string, entry: { jobId: string; answer: ChannelAnswer | null; retired?: true }) {
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

/** Keeps the newest hydration of a record (by revision) for a later callback's barrier. */
export function rememberHydration(record: HydrationRecord) {
    const key = recordKey(record.kind, record.id, record.characterId);
    const held = hydrations.get(key);
    if (!held || (compareRevision(record.revision, held.revision) ?? 1) >= 0) {
        hydrations.set(key, record);
    }
}

/** The innermost callback being run (for an aux request made inside it: slice 7a), or null. */
export function currentChannelCall(): { jobId: string; callbackId: string; targets: CallbackTargets } | null {
    const top = outstanding[outstanding.length - 1];
    return top ? { jobId: top.jobId, callbackId: top.id, targets: top.targets } : null;
}

setChannelCallSource(currentChannelCall);

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

function showNotice(notice: GenerationNotice): boolean {
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
            alertToast(notice.payload.message);
            return false;
        case "alertWait":
            alertWait(notice.payload.message);
            return false;
        case "alertClear":
            alertClear();
            return false;
        default:
            return false;
    }
}

/** The effects that never touch the alert store run at once. */
function applyEffect(notice: GenerationNotice) {
    switch (notice.kind) {
        case "reloadDisplay":
        case "updateGUI":
            ReloadGUIPointer.set(get(ReloadGUIPointer) + 1);
            return;
        case "reloadChat": {
            const { chaId, chatId, messageId } = notice.payload;
            const character = DBState.db.characters?.[get(selectedCharID)];
            const chat = character?.chaId === chaId ? character.chats?.[character.chatPage] : undefined;
            const index = chat?.id === chatId ? (chat.message?.findIndex((m) => m.chatId === messageId) ?? -1) : -1;
            if (index !== -1) {
                ReloadChatPointer.update((value) => {
                    value[index] = (value[index] ?? 0) + 1;
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
        case "progress":
            hypaV3ProgressStore.set({ ...notice.payload });
            return;
        case "tts": {
            const { chaId, text } = notice.payload;
            const character = DBState.db.characters?.find((entry) => entry?.chaId === chaId);
            if (character && character.type !== "group") {
                void import("../process/tts").then(({ sayTTS }) => sayTTS(character, text)).catch(console.error);
            }
            return;
        }
        case "notification":
            if (DBState.db.notification) {
                void Notification.requestPermission()
                    .then((permission) => {
                        if (permission === "granted") {
                            const shown = new Notification("Risuai", { body: notice.payload.body });
                            shown.onclick = () => window.focus();
                        }
                    })
                    .catch(() => {});
            }
            return;
        case "requestLog":
            // Slice 7a defines the projection and where it is kept.
            console.debug("[Channel] request log", notice.payload);
            return;
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
                if (showNotice(item.notice)) {
                    await waitAlert();
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
            const result = ask(item.event).then(
                (resolved) => {
                    value = resolved;
                },
                (error) => {
                    failed = true;
                    failure = error;
                },
            );
            // The alert functions set the store synchronously: this is the alert this question owns.
            const current = { id: item.event.id, jobId: item.jobId, alert: get(alertState), cancelled: false, release };
            showing = current;
            // A cancel (or the job's end) releases the queue at once; the alert's own poller then
            // resolves later and is ignored.
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
 * Cancels the question showing: closes its alert only while that alert is still the one showing
 * (local UI may have replaced it), and releases the queue either way.
 */
function cancelShowing() {
    const current = showing;
    if (!current || current.cancelled) {
        return;
    }
    current.cancelled = true;
    if (get(alertState) === current.alert) {
        alertClear();
    }
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

/** Whether this client holds `receipt`'s record at its revision or a newer one. */
function holds(receipt: HydrationReceipt): boolean {
    const held =
        receipt.kind === "chats"
            ? heldChatRevision({ chaId: receipt.characterId ?? "", chatId: receipt.id })
            : heldRecordRevision(receipt.kind, receipt.id);
    return held !== null && (compareRevision(held, receipt.revision) ?? -1) >= 0;
}

async function barrier(event: GenerationCallbackEvent) {
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
        const record = hydrations.get(recordKey(receipt.kind, receipt.id, receipt.characterId));
        if (record && !holds(receipt)) {
            applyHydration(record);
        }
        if (!holds(receipt)) {
            throw new CallbackFailed(
                "barrier",
                `The ${receipt.kind} record ${receipt.id} the job changed is not applied on this client`,
            );
        }
    }
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Runs the hook set a callback names, in order, under the job's targets. */
async function runHook(event: GenerationCallbackEvent, entry: Outstanding): Promise<unknown> {
    const context: PluginCallContext = event.targets;
    const payload = event.payload as Record<string, unknown>;
    const stillWanted = () => {
        if (entry.cancelled) {
            throw new CallbackFailed("protocol", "The server cancelled this callback");
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
        case "mcpTool": {
            const client = registeredCustomPluginMCPs.get(String(payload.identifier));
            if (!client) {
                throw unavailable();
            }
            stillWanted();
            return await client.callTool(String(payload.tool), payload.args);
        }
        case "chatOutput":
        case "provider":
        case "generateImage":
            throw new CallbackFailed("protocol", `The ${event.name} callback is not supported yet`);
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
        await barrier(event);
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
        remember(event.id, { jobId, answer: null });
        answer(jobId, { type: "answer", id: event.id, outcome: "failed", failure: "protocol", error });
    };
    if (event.replay) {
        refuse("The callback may already have run before this page loaded; it is not run again");
        return;
    }
    const top = outstanding[outstanding.length - 1];
    if (
        event.parentId === undefined
            ? outstanding.length > 0
            : !top || top.id !== event.parentId || outstanding.length >= 2
    ) {
        refuse("A callback may run only inside the outstanding one, one level deep");
        return;
    }
    const entry: Outstanding = { jobId, id: event.id, targets: event.targets, cancelled: false };
    outstanding.push(entry);
    remember(event.id, { jobId, answer: null });
    void runCallback(event, entry)
        .then((message) => {
            const index = outstanding.indexOf(entry);
            if (index !== -1) {
                outstanding.splice(index, 1);
            }
            if (entry.cancelled) {
                const state = requests.get(event.id);
                if (state) {
                    state.answer = message;
                }
                return;
            }
            answer(jobId, message);
        })
        .catch((error) => console.error("[Channel]", error));
}

/**
 * The plugin hooks registered now (`GenerationHooks`), from the active registries: each provider
 * with a copy of its model descriptor, the body interceptors, and the plugin MCP identifiers.
 */
export async function registeredHooks(): Promise<GenerationHooks> {
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
            model: JSON.parse(JSON.stringify(getModelInfo(`pluginmodel:::${name}`))),
        })),
        mcpTools: [...registeredCustomPluginMCPs.keys()],
    };
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
                    showNotice(notice);
                }
            } else {
                applyEffect(notice);
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
            const index = uiQueue.findIndex((item) => item.type === "question" && item.event.id === event.id);
            if (index !== -1) {
                uiQueue.splice(index, 1);
            }
            if (showing?.id === event.id) {
                cancelShowing();
            }
            // A cancelled request is finished: it can be forgotten, and a late duplicate stays dropped.
            const state = requests.get(event.id);
            if (state && !state.answer && !outstanding.some((entry) => entry.id === event.id)) {
                state.retired = true;
            }
            for (const entry of outstanding) {
                if (entry.id === event.id) {
                    entry.cancelled = true;
                }
            }
            return;
        }
    }
}

/** The job ended: its queued questions are dropped and its callbacks stop starting hooks. */
export function endJobChannel(jobId: string) {
    // A cancel the socket lost (a disconnect) must not leave the job's question open.
    if (showing?.jobId === jobId) {
        cancelShowing();
    }
    for (let index = uiQueue.length - 1; index >= 0; index -= 1) {
        const item = uiQueue[index];
        if (item.type === "question" && item.jobId === jobId) {
            uiQueue.splice(index, 1);
        }
    }
    for (const entry of outstanding) {
        if (entry.jobId === jobId) {
            entry.cancelled = true;
        }
    }
    for (const [id, state] of requests) {
        if (state.jobId === jobId && !state.answer && !outstanding.some((entry) => entry.id === id)) {
            state.retired = true;
        }
    }
    transports.delete(jobId);
}
