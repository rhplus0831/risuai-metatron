import { SvelteMap, SvelteSet } from "svelte/reactivity";
import type { MessageTranslation } from "../../../shared/database.ts";
import { RESOURCE_EPOCH_HEADER } from "../../../shared/resources.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import { isMessageTranslation, storedTranslation } from "../../../shared/translation/messageTranslation.ts";
import {
    isTranslateMessageAnswer,
    TRANSLATE_MESSAGE_PATH,
    type TranslateMessageBody,
} from "../../../shared/translation/route.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import { language } from "src/lang";
import { alertError } from "../alert";
import { chatDisplayIds } from "../storage/chatBinding.svelte";
import {
    type ChatRef,
    findChat,
    heldChatRevision,
    isMessageLocked,
    setMessageTranslation,
} from "../storage/chatStore.svelte";
import { epochMismatch, getResourceEpoch } from "../storage/resourceClient";
import { flushResources, GenerationBlockedError } from "../storage/resourceSync.svelte";
import { authFetch } from "../storage/serverAuth";
import { settings } from "../storage/settingsViews.svelte";
import sendSound from "../../etc/send.mp3";

/**
 * The tab side of the stored translation (`docs/plan/translation.md` slice 1.4): with the LLM
 * translator on `llmTranslationTarget: "message"`, a chat row shows its message's stored translation
 * (`Message.translation`, fresh by its source hash), asks the server runner for one
 * (`POST /api/translate/message`), and writes a hand edit (`setMessageTranslation`, `edited: true`).
 * The answer is not shown by itself: the row shows the held message, which the chat's resource
 * refresh brings up to date, and the request stays pending until it does (bounded).
 */

/**
 * How long the tab waits for an answer: the server's 10-minute deadline twice (a request for a text
 * that a run in flight no longer matches waits for that run, then translates; slice 2.3), plus
 * transport.
 */
const ANSWER_TIMEOUT_MS = 21 * 60 * 1000;
/** How long a request stays pending after its answer, waiting for the chat refresh to bring the translation. */
const SYNC_WAIT_MS = 15 * 1000;
const SYNC_POLL_MS = 100;

const messageKey = (ref: ChatRef, messageId: string) => `${ref.chaId}\u0000${ref.chatId}\u0000${messageId}`;

/** Messages with a request running in this tab (reactive: a remounted row still shows the loading state). */
const pending = new SvelteSet<string>();
const inFlight = new Map<string, Promise<boolean>>();
/**
 * Messages whose newer hand-off arrived while this tab's request was running (a Continue's, slice
 * 2.3): that request may have joined the older run, so another follows once it settles.
 */
const followAgain = new Map<string, StoredTranslationFollow>();

/** A request that follows a server hand-off (slice 2.3), and how it reports a failure. */
export interface StoredTranslationFollow {
    /** Shows a failure (the job channel queues it behind any question it shows). */
    report(message: string): void;
}
/** The rows' explicit show/hide choices by message (reactive; kept across a row's remount). */
const choices = new SvelteMap<string, boolean>();

/** Whether the LLM translator works on stored translations (`llmTranslationTarget: "message"`). Tracked. */
export function usesStoredTranslation(): boolean {
    return (
        settings.memoryTranslateMedia.translatorType === "llm" &&
        settings.memoryTranslateMedia.llmTranslationTarget === "message"
    );
}

/** The message's stored translation while it is fresh (an empty text included), else null. */
export function freshTranslation(message: {
    readonly data: string;
    readonly translation?: unknown;
}): DeepReadonly<MessageTranslation> | null {
    return storedTranslation(message) !== null && isMessageTranslation(message.translation)
        ? message.translation
        : null;
}

/** The held message (tracked: the held chats are deep state). */
export function heldMessage(ref: ChatRef, messageId: string) {
    return findChat(ref)?.message.find((entry) => entry.chatId === messageId);
}

/** Whether a translation of the message is being requested in this tab. Tracked. */
export function isStoredTranslationPending(ref: ChatRef, messageId: string): boolean {
    return pending.has(messageKey(ref, messageId));
}

/** The row's explicit choice to show (true) or hide (false) the translation; null when it made none. Tracked. */
export function storedTranslationChoice(ref: ChatRef, messageId: string): boolean | null {
    return choices.get(messageKey(ref, messageId)) ?? null;
}

export function setStoredTranslationChoice(ref: ChatRef, messageId: string, show: boolean) {
    choices.set(messageKey(ref, messageId), show);
}

/**
 * Asks the server runner to translate the message (`force`: even when a fresh translation is
 * stored). One request per message at a time in this tab: a second call returns the running one.
 * Alerts on failure; resolves true when the translation is stored (and held, unless the refresh is
 * still late).
 *
 * `follow`: the server already runs it (a send's hand-off, slice 2.3). The request joins that run
 * (an unforced request for a message in flight), so the tab gets its result or failure, reported
 * through `follow.report`. It skips the save barrier and the stability checks (the server translates
 * its own copy, which the job just wrote; the next send's job may already block a save) and says
 * nothing when the text changed. If the run ended before the request arrives, the answer is the
 * stored translation (`fresh`), or the request starts a run of its own (a failed run is tried once
 * more). A follow while a request for the message runs follows again once it settles (it may have
 * joined an older text's run); the message stays pending meanwhile.
 */
export function requestStoredTranslation(
    ref: ChatRef,
    messageId: string,
    options: { force: boolean; follow?: StoredTranslationFollow },
): Promise<boolean> {
    const key = messageKey(ref, messageId);
    const running = inFlight.get(key);
    if (running) {
        if (options.follow) {
            followAgain.set(key, options.follow);
        }
        return running;
    }
    const target = { chaId: ref.chaId, chatId: ref.chatId };
    pending.add(key);
    const work = runRequest(target, messageId, options.force, options.follow ?? null).finally(() => {
        inFlight.delete(key);
        const again = followAgain.get(key);
        followAgain.delete(key);
        if (again) {
            // Takes the message's place at once, so it stays pending.
            void requestStoredTranslation(target, messageId, { force: false, follow: again });
        } else {
            pending.delete(key);
        }
    });
    inFlight.set(key, work);
    return work;
}

const sameIds = (a: ReturnType<typeof chatDisplayIds>, b: ReturnType<typeof chatDisplayIds>) =>
    a.presetId === b.presetId && a.modelPresetId === b.modelPresetId && a.personaId === b.personaId;

async function runRequest(
    ref: ChatRef,
    messageId: string,
    force: boolean,
    follow: StoredTranslationFollow | null,
): Promise<boolean> {
    const report = follow ? (message: string) => follow.report(message) : alertError;
    // Captured before any await: the chat's display ids and the text the user asked to translate.
    const ids = chatDisplayIds(ref);
    if (!ids.presetId || !ids.modelPresetId || !ids.personaId) {
        if (!follow) {
            alertError(language.translationNoContext);
        }
        return false;
    }
    if (!follow) {
        const message = heldMessage(ref, messageId);
        if (!message) {
            return false;
        }
        const sourceHash = translationSourceHash(message.data);

        // The server translates its own copy: save this tab's changes first (the message may be new,
        // or its text edited). This saves every pending change, not only this chat's.
        try {
            const { discarded } = await flushResources();
            if (discarded.includes(`chats/${ref.chaId}/${ref.chatId}`)) {
                alertError(language.translationSourceChanged);
                return false;
            }
        } catch (error) {
            alertError(
                error instanceof GenerationBlockedError
                    ? language.chatGenerating
                    : `${language.translationFailed}: ${error instanceof Error ? error.message : error}`,
            );
            return false;
        }
        const saved = heldMessage(ref, messageId);
        if (heldChatRevision(ref) === null || !saved || translationSourceHash(saved.data) !== sourceHash) {
            alertError(language.translationSourceChanged);
            return false;
        }
        if (!sameIds(ids, chatDisplayIds(ref))) {
            alertError(language.chatBinding.mismatch);
            return false;
        }
    }

    const body: TranslateMessageBody = {
        characterId: ref.chaId,
        chatId: ref.chatId,
        messageId,
        presetId: ids.presetId,
        modelPresetId: ids.modelPresetId,
        personaId: ids.personaId,
        force,
    };
    // This tab's wait, bounded as a whole (authentication, the request, and the body): the run goes
    // on on the server. A request whose authentication ends after the deadline is not sent.
    const deadline = Date.now() + ANSWER_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("No answer in time")), ANSWER_TIMEOUT_MS);
    });
    let response: Response;
    let answer: unknown = null;
    try {
        const exchange = (async () => {
            const sent = await authFetch(
                TRANSLATE_MESSAGE_PATH,
                {
                    method: "POST",
                    headers: { "content-type": "application/json", [RESOURCE_EPOCH_HEADER]: getResourceEpoch() },
                    body: JSON.stringify(body),
                    cache: "no-store",
                    signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
                },
                {
                    beforeDispatch: () => {
                        if (Date.now() > deadline) {
                            throw new Error("No answer in time");
                        }
                    },
                },
            );
            let parsed: unknown = null;
            try {
                parsed = await sent.json();
            } catch {}
            return { sent, parsed };
        })();
        // A late failure after the deadline won the race is not reported.
        exchange.catch(() => {});
        ({ sent: response, parsed: answer } = await Promise.race([exchange, expired]));
    } catch (error) {
        report(`${language.translationFailed}: ${error instanceof Error ? error.message : error}`);
        return false;
    } finally {
        clearTimeout(timer);
    }
    const refusal = (typeof answer === "object" && answer !== null ? answer : {}) as {
        error?: unknown;
        epoch?: unknown;
    };
    if (response.status === 412 && refusal.error === "EpochMismatch") {
        // A restore replaced the data: the app's restore handling takes over.
        epochMismatch(typeof refusal.epoch === "string" ? refusal.epoch : "");
        return false;
    }
    if (!response.ok) {
        const error = typeof refusal.error === "string" ? refusal.error : "";
        if (response.status === 409 && error === "generating") {
            report(language.chatGenerating);
        } else if (response.status === 409 && error === "chatBindingMismatch") {
            report(language.chatBinding.mismatch);
        } else {
            report(`${language.translationFailed}: ${error || `HTTP ${response.status}`}`);
        }
        return false;
    }
    if (!isTranslateMessageAnswer(answer)) {
        report(`${language.translationFailed}: an unexpected answer`);
        return false;
    }
    if (answer.outcome === "ignored") {
        if (!follow) {
            report(language.translationSourceChanged);
        }
        return false;
    }
    if (answer.outcome === "applied" && settings.memoryTranslateMedia.playMessageOnTranslateEnd) {
        new Audio(sendSound).play().catch(() => {});
    }
    await heldCatchesUp(ref, messageId, answer.translation);
    return true;
}

/**
 * Follows the server's translations of a send's messages (the job's `translating` notice, slice 2.3):
 * each shows the loading state until its stored translation arrives or its run fails (alerted).
 */
export function followStoredTranslations(ref: ChatRef, messageIds: readonly string[], follow: StoredTranslationFollow) {
    for (const messageId of messageIds) {
        void requestStoredTranslation(ref, messageId, { force: false, follow });
    }
}

/**
 * Waits (bounded) until the held message holds `translation`, or no longer can (gone, or its text
 * changed). The server publishes the write; the chat's refresh installs it when the chat is idle.
 */
async function heldCatchesUp(ref: ChatRef, messageId: string, translation: MessageTranslation) {
    const deadline = Date.now() + SYNC_WAIT_MS;
    while (Date.now() < deadline) {
        const message = heldMessage(ref, messageId);
        if (!message || translationSourceHash(message.data) !== translation.sourceHash) {
            return;
        }
        const held = message.translation;
        if (
            isMessageTranslation(held) &&
            held.sourceHash === translation.sourceHash &&
            held.translatedAt === translation.translatedAt &&
            held.text === translation.text
        ) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, SYNC_POLL_MS));
    }
}

/** A hand edit of a stored translation: the message and the fresh translation as the editor opened them. */
export interface StoredTranslationEdit {
    ref: ChatRef;
    messageId: string;
    /** The source hash when the editor opened: the edit lands only on that text. */
    sourceHash: string;
    /** The translation the editor opened (a detached copy). */
    base: MessageTranslation;
}

/** Opens an edit of the message's fresh stored translation; null when it has none. */
export function beginStoredTranslationEdit(ref: ChatRef, messageId: string): StoredTranslationEdit | null {
    const message = heldMessage(ref, messageId);
    const fresh = message ? freshTranslation(message) : null;
    if (!fresh) {
        return null;
    }
    return {
        ref: { chaId: ref.chaId, chatId: ref.chatId },
        messageId,
        sourceHash: fresh.sourceHash,
        base: JSON.parse(JSON.stringify(fresh)) as MessageTranslation,
    };
}

/**
 * Writes an edited translation (`edited: true`) for the text the editor opened. Alerts and returns
 * false when it is not taken (a generation locks the message, the message is gone, or its text
 * changed since); true means taken and queued, as `setMessageTranslation` says.
 */
export function saveStoredTranslationEdit(edit: StoredTranslationEdit, text: string): boolean {
    if (isMessageLocked(edit.ref, edit.messageId)) {
        alertError(language.chatGenerating);
        return false;
    }
    if (!heldMessage(edit.ref, edit.messageId)) {
        alertError(language.translationEditStale);
        return false;
    }
    const translation: MessageTranslation = {
        text,
        sourceHash: edit.sourceHash,
        ...(edit.base.presetId !== undefined ? { presetId: edit.base.presetId } : {}),
        targetLanguage: edit.base.targetLanguage,
        translatedAt: Date.now(),
        edited: true,
    };
    try {
        if (!setMessageTranslation(edit.ref, edit.messageId, translation)) {
            alertError(language.translationEditStale);
            return false;
        }
    } catch (error) {
        alertError(error instanceof Error ? error.message : String(error));
        return false;
    }
    return true;
}
