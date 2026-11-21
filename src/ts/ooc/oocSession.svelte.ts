import { v4 as uuid } from "uuid";
import { language } from "src/lang";
import { isOocId, oocExchangeError, oocPrune, type OocExchange, type OocLog } from "../../../shared/ooc.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import { isPlainObject } from "../../../shared/valueKinds.ts";
import { alertReloadNotice } from "../alert";
import { chatBinding } from "../storage/chatBinding.svelte";
import { characterList } from "../storage/characterStore.svelte";
import {
    chatEntry,
    chatOwnerToken,
    ensureChatLoaded,
    findChat,
    heldMessageById,
    mergeChatMeta,
    pinChat,
    setChatMeta,
    type ChatRef,
} from "../storage/chatStore.svelte";
import { chatStatusKey, isChatBusy } from "../process/chatStatus.svelte";
import { beginLocalSend } from "../process/localSends";
import { refuseOrphanedOverrides } from "../process/loreOverrides";
import { requestChatData, type requestDataResponse, type StreamResponseChunk } from "../process/request/request";
import { runServerJob } from "../process/serverCommands";

/**
 * Owns the tab's OOC questions, retries, cancellation, segment refresh, log removals, attachment
 * picks, and panel readers. Only segments and exchanges are persisted, through chat metadata.
 * Each question pins its captured chat through its final write. The server preview assembles its
 * prompt; a separate tab request streams the answer without holding the main composer's send slot.
 * Partial text stays in memory on failure or stop, and is cleared after the answer is stored.
 */

export type OocErrorKind =
    | "group"
    | "busy"
    | "inFlight"
    | "binding"
    | "loreOrphans"
    | "anchorGone"
    | "pruneFull"
    | "tooLarge"
    | "olderServer"
    | "previewFailed"
    | "oocExchangeGone"
    | "oocAnchorGone"
    | "oocMemoryAhead"
    | "requestFailed"
    | "stopped"
    | "chatGone"
    | "alreadyAnswered"
    | "retryUnavailable"
    | "attachmentUnavailable"
    | "updateFailed";

export type OocSessionError = { kind: OocErrorKind; message: string; exchangeId?: string };

export type OocSessionState = {
    streamingText: string;
    streamingExchangeId: string | null;
    busy: boolean;
    error: OocSessionError | null;
    picks: string[];
};

export type OocActionResult =
    { status: "done"; exchangeId?: string } | { status: "refused" | "failed"; error: OocSessionError };

export type OocSegmentView = {
    id: string;
    anchorMessageId: string | null;
    current: boolean;
    exchanges: readonly DeepReadonly<OocExchange>[];
};

type Flight = {
    controller: AbortController;
    exchangeId?: string;
    reader?: ReadableStreamDefaultReader<StreamResponseChunk>;
};

const states = new Map<string, OocSessionState>();
const flights = new Map<string, Flight>();
const callerErrorCodes = ["oocExchangeGone", "oocAnchorGone", "oocMemoryAhead"] as const;

function stateOf(ref: ChatRef): OocSessionState {
    const key = chatStatusKey(ref);
    const existing = states.get(key);
    if (existing) return existing;
    const state = $state<OocSessionState>({
        streamingText: "",
        streamingExchangeId: null,
        busy: false,
        error: null,
        picks: [],
    });
    states.set(key, state);
    return state;
}

/** Reactive in-memory state for this chat. Change it through the actions, never through the reader. */
export function readOocState(ref: ChatRef): DeepReadonly<OocSessionState> {
    return stateOf(ref);
}

function problem(
    state: OocSessionState,
    kind: OocErrorKind,
    status: "refused" | "failed" = "refused",
    exchangeId?: string,
    message = language.ooc[kind],
): OocActionResult {
    const error: OocSessionError = { kind, message, ...(exchangeId !== undefined ? { exchangeId } : {}) };
    state.error = error;
    return { status, error };
}

function sameChat(ref: ChatRef, owner: string): boolean {
    return chatOwnerToken(ref.chaId) === owner && !!chatEntry(ref);
}

function exchangeOf(ref: ChatRef, id: string): DeepReadonly<OocExchange> | undefined {
    const log = findChat(ref)?.oocLog;
    return log && Object.hasOwn(log, id) ? log[id] : undefined;
}

function copyExchange(exchange: DeepReadonly<OocExchange>): OocExchange {
    const { attached, ...fields } = exchange;
    return { ...fields, ...(attached ? { attached: [...attached] } : {}) };
}

/** Admission before loading, repeated after loading except for this call's own reservation. */
function guard(ref: ChatRef, ownFlight?: Flight): OocErrorKind | null {
    const char = characterList().find((char) => char.chaId === ref.chaId);
    if (!chatEntry(ref) || !char) return "chatGone";
    if (char.type === "group") return "group";
    if (isChatBusy(ref)) return "busy";
    const flight = flights.get(chatStatusKey(ref));
    if (flight && flight !== ownFlight) return "inFlight";
    if (!ownFlight) return null;
    if (!chatBinding(ref)?.ok) return "binding";
    if (refuseOrphanedOverrides(ref)) return "loreOrphans";
    const anchor = findChat(ref)?.oocSegment?.anchorMessageId;
    if (anchor != null && !heldMessageById(ref, anchor)) return "anchorGone";
    return null;
}

/** Stores a new question before asking the server to assemble its OOC prompt. */
export function askOoc(ref: ChatRef, question: string): Promise<OocActionResult> {
    return runQuestion({ ...ref }, { question });
}

/** Reuses an unanswered exchange of the current segment, with a fresh preview and reply request. */
export function retryOoc(ref: ChatRef, exchangeId: string): Promise<OocActionResult> {
    return runQuestion({ ...ref }, { exchangeId });
}

async function runQuestion(
    ref: ChatRef,
    input: { question: string } | { exchangeId: string },
): Promise<OocActionResult> {
    const owner = chatOwnerToken(ref.chaId);
    const state = stateOf(ref);
    const retryId = "exchangeId" in input ? input.exchangeId : undefined;
    const refusal = guard(ref);
    if (refusal) return problem(state, refusal, "refused", retryId);

    // Reserve synchronously: a second call cannot pass while the first is awaiting its chat load.
    const key = chatStatusKey(ref);
    const flight: Flight = { controller: new AbortController(), exchangeId: retryId };
    flights.set(key, flight);
    state.busy = true;
    state.error = null;
    state.streamingText = "";
    state.streamingExchangeId = retryId ?? null;
    const release = pinChat(ref);
    try {
        await ensureChatLoaded(ref);
        if (flight.controller.signal.aborted) return problem(state, "stopped", "failed", flight.exchangeId);
        if (!sameChat(ref, owner) || !findChat(ref)) return problem(state, "chatGone", "refused", retryId);
        const refusal = guard(ref, flight);
        if (refusal) return problem(state, refusal, "refused", retryId);
        const chat = findChat(ref)!;

        if ("exchangeId" in input) {
            const exchange = exchangeOf(ref, input.exchangeId);
            if (!exchange) return problem(state, "oocExchangeGone", "refused", input.exchangeId);
            if (exchange.segment !== chat.oocSegment?.id || exchange.answer !== undefined) {
                return problem(state, "retryUnavailable", "refused", input.exchangeId);
            }
        } else {
            const segment = chat.oocSegment ?? { id: uuid(), anchorMessageId: chat.message.at(-1)?.chatId ?? null };
            if (!chat.oocSegment) setChatMeta(ref, { oocSegment: segment });
            const picks = state.picks.filter((id) => {
                const exchange = exchangeOf(ref, id);
                return exchange && exchange.segment !== segment.id;
            });
            const log: OocLog = Object.fromEntries(
                Object.entries(chat.oocLog ?? {}).map(([id, exchange]) => [id, copyExchange(exchange)]),
            );
            const removals = oocPrune(log, segment, picks);
            if (removals === null) return problem(state, "pruneFull");
            const exchange: OocExchange = {
                id: uuid(),
                segment: segment.id,
                anchorMessageId: segment.anchorMessageId,
                question: input.question,
                time: Date.now(),
                ...(picks.length ? { attached: picks } : {}),
            };
            if (oocExchangeError(exchange.id, exchange)) return problem(state, "tooLarge");
            mergeChatMeta(ref, "oocLog", { [exchange.id]: exchange }, removals);
            state.picks = [];
            flight.exchangeId = exchange.id;
        }
        state.streamingExchangeId = flight.exchangeId!;
        return await answerQuestion(ref, owner, state, flight);
    } catch {
        return problem(
            state,
            flight.controller.signal.aborted ? "stopped" : !sameChat(ref, owner) ? "chatGone" : "previewFailed",
            "failed",
            flight.exchangeId,
        );
    } finally {
        flights.delete(key);
        state.busy = false;
        release();
    }
}

async function answerQuestion(
    ref: ChatRef,
    owner: string,
    state: OocSessionState,
    flight: Flight,
): Promise<OocActionResult> {
    const id = flight.exchangeId!;
    const signal = flight.controller.signal;
    const releaseSend = beginLocalSend(ref);
    if (!releaseSend) return problem(state, "busy", "refused", id);
    let preview: Awaited<ReturnType<typeof runServerJob>>;
    try {
        preview = await runServerJob(
            characterList().find((char) => char.chaId === ref.chaId)!,
            ref,
            { kind: "preview", label: "send", context: { oocExchangeId: id }, callerErrorCodes },
            { signal },
        );
    } finally {
        releaseSend();
    }
    if (signal.aborted) return problem(state, "stopped", "failed", id);
    const { outcome, terminal } = preview;
    if (outcome !== "started" && outcome !== "replayed") return problem(state, "previewFailed", "failed", id);
    if (terminal && terminal !== "lost" && terminal.type === "error") {
        for (const code of callerErrorCodes) {
            // The state records it even when an earlier lifecycle already showed its global alert.
            if (terminal.code === code) return problem(state, code, "failed", id);
        }
    }
    if (!terminal || terminal === "lost" || terminal.type !== "done" || terminal.stopped) {
        return problem(state, "previewFailed", "failed", id);
    }
    const result = terminal.result;
    if (!isPlainObject(result) || !Array.isArray(result.messages)) return problem(state, "previewFailed", "failed", id);
    if (result.ooc !== true) return problem(state, "olderServer", "failed", id);
    if (!sameChat(ref, owner)) return problem(state, "chatGone", "failed", id);

    let answer: string;
    try {
        const response = await requestChatData(
            {
                formated: result.messages,
                chatRef: ref,
                chatOwner: owner,
                bias: {},
                tools: [],
                noMultiGen: true,
                useStreaming: true,
            },
            "model",
            signal,
        );
        answer = await readAnswer(response, state, flight);
    } catch (error) {
        if (signal.aborted) return problem(state, "stopped", "failed", id);
        if (!sameChat(ref, owner)) return problem(state, "chatGone", "failed", id);
        return problem(state, "requestFailed", "failed", id, error instanceof Error ? error.message : String(error));
    }
    if (signal.aborted) return problem(state, "stopped", "failed", id);
    if (!sameChat(ref, owner)) return problem(state, "chatGone", "failed", id);
    const stored = exchangeOf(ref, id);
    if (!stored) return problem(state, "oocExchangeGone", "failed", id);
    if (stored.answer !== undefined) {
        state.streamingText = "";
        state.streamingExchangeId = null;
        alertReloadNotice(language.ooc.alreadyAnswered);
        return problem(state, "alreadyAnswered", "refused", id);
    }
    const exchange = { ...copyExchange(stored), answer };
    if (oocExchangeError(id, exchange)) return problem(state, "tooLarge", "failed", id);
    mergeChatMeta(ref, "oocLog", { [id]: exchange }, [], id);
    state.streamingText = "";
    state.streamingExchangeId = null;
    state.error = null;
    return { status: "done", exchangeId: id };
}

async function readAnswer(response: requestDataResponse, state: OocSessionState, flight: Flight): Promise<string> {
    if (response.type === "fail") throw new Error(response.result);
    if (response.type !== "streaming") {
        const answer =
            response.type === "multiline" ? response.result.map(([, text]) => text).join("\n") : response.result;
        if (!flight.controller.signal.aborted) state.streamingText = answer;
        return answer;
    }
    const reader = response.result.getReader();
    flight.reader = reader;
    let answer = "";
    try {
        if (flight.controller.signal.aborted) void reader.cancel().catch(() => {});
        while (!flight.controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done || flight.controller.signal.aborted) break;
            // Legacy providers also send plain strings, despite the stream's declared object type.
            answer = typeof value === "string" ? value : (value[Object.keys(value)[0]] ?? "");
            state.streamingText = answer;
        }
        return answer;
    } finally {
        flight.reader = undefined;
        reader.releaseLock();
    }
}

/** Stops both the preview job and the reply request; partial text stays visible but is never stored. */
export function stopOoc(ref: ChatRef): void {
    const flight = flights.get(chatStatusKey(ref));
    if (!flight) return;
    problem(stateOf(ref), "stopped", "failed", flight.exchangeId);
    flight.controller.abort();
    void flight.reader?.cancel().catch(() => {});
}

/** Pins maintenance writes too, and refuses a chat replaced while it was being loaded. */
async function editSession(ref: ChatRef, edit: (state: OocSessionState) => OocActionResult): Promise<OocActionResult> {
    const owner = chatOwnerToken(ref.chaId);
    const state = stateOf(ref);
    const release = pinChat(ref);
    try {
        await ensureChatLoaded(ref);
        if (!sameChat(ref, owner) || !findChat(ref)) return problem(state, "chatGone");
        return edit(state);
    } catch {
        return problem(state, sameChat(ref, owner) ? "updateFailed" : "chatGone", "failed");
    } finally {
        release();
    }
}

/** Starts a new segment at the newest stored message; earlier exchanges remain in the log. */
export async function refreshOoc(ref: ChatRef): Promise<OocActionResult> {
    ref = { ...ref };
    if (flights.has(chatStatusKey(ref))) return problem(stateOf(ref), "inFlight");
    return editSession(ref, (state) => {
        if (flights.has(chatStatusKey(ref))) return problem(state, "inFlight");
        setChatMeta(ref, {
            oocSegment: { id: uuid(), anchorMessageId: findChat(ref)!.message.at(-1)?.chatId ?? null },
        });
        state.error = null;
        return { status: "done" };
    });
}

/** Removes one exchange, including an attached one, and stops it first if this tab is answering it. */
export function deleteOocExchange(ref: ChatRef, id: string): Promise<OocActionResult> {
    ref = { ...ref };
    if (flights.get(chatStatusKey(ref))?.exchangeId === id) stopOoc(ref);
    return editSession(ref, (state) => {
        if (!isOocId(id)) return problem(state, "oocExchangeGone", "refused", id);
        if (flights.get(chatStatusKey(ref))?.exchangeId === id) stopOoc(ref);
        mergeChatMeta(ref, "oocLog", {}, [id]);
        state.picks = state.picks.filter((pick) => pick !== id);
        return { status: "done", exchangeId: id };
    });
}

/** Removes every exchange outside the current segment, including picked or attached exchanges. */
export function clearOocLog(ref: ChatRef): Promise<OocActionResult> {
    ref = { ...ref };
    return editSession(ref, (state) => {
        const chat = findChat(ref)!;
        const removals = Object.values(chat.oocLog ?? {})
            .filter((exchange) => exchange.segment !== chat.oocSegment?.id)
            .map((exchange) => exchange.id);
        const activeId = flights.get(chatStatusKey(ref))?.exchangeId;
        if (activeId && removals.includes(activeId)) stopOoc(ref);
        mergeChatMeta(ref, "oocLog", {}, removals);
        state.picks = state.picks.filter((id) => !removals.includes(id));
        return { status: "done" };
    });
}

/** Toggles a loaded earlier-segment exchange as an attachment for the next question. */
export function toggleOocAttachment(ref: ChatRef, id: string): OocActionResult {
    const state = stateOf(ref);
    const exchange = exchangeOf(ref, id);
    if (!exchange || exchange.segment === findChat(ref)?.oocSegment?.id) {
        return problem(state, "attachmentUnavailable", "refused", id);
    }
    state.picks = state.picks.includes(id) ? state.picks.filter((pick) => pick !== id) : [...state.picks, id];
    return { status: "done", exchangeId: id };
}

/** Earlier segments by their first exchange time, current last (even empty); exchanges by time then id. */
export function readOocSegments(ref: ChatRef): OocSegmentView[] {
    const chat = findChat(ref);
    const current = chat?.oocSegment;
    const groups = new Map<string, OocSegmentView & { exchanges: DeepReadonly<OocExchange>[] }>();
    const exchanges = Object.values(chat?.oocLog ?? {}).sort(
        (a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    for (const exchange of exchanges) {
        let group = groups.get(exchange.segment);
        if (!group) {
            group = { id: exchange.segment, anchorMessageId: exchange.anchorMessageId, current: false, exchanges: [] };
            groups.set(exchange.segment, group);
        }
        group.exchanges.push(exchange);
    }
    const segments = [...groups.values()].filter((segment) => segment.id !== current?.id);
    if (current) segments.push({ ...current, current: true, exchanges: groups.get(current.id)?.exchanges ?? [] });
    return segments;
}

/** A null anchor (or no segment yet) is valid; an unloaded or missing chat is not. */
export function oocAnchorExists(ref: ChatRef): boolean {
    const chat = findChat(ref);
    const anchor = chat?.oocSegment?.anchorMessageId;
    return !!chat && (anchor == null || !!heldMessageById(ref, anchor));
}

/** Counts all messages for a null anchor; a missing non-null anchor reports zero and needs refresh. */
export function oocMessagesAfterAnchor(ref: ChatRef): number {
    const chat = findChat(ref);
    if (!chat) return 0;
    const anchor = chat.oocSegment?.anchorMessageId;
    if (anchor == null) return chat.message.length;
    const index = chat.message.findIndex((message) => message.chatId === anchor);
    return index < 0 ? 0 : chat.message.length - index - 1;
}
