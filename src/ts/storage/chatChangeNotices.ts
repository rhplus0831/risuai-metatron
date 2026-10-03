import { type ChatRef, markChatNoticed } from "./chatStore.svelte";
import { getResourceEpoch } from "./resourceClient";

/**
 * Notices between the tabs of one browser (same origin and storage partition) that a server job
 * changed a chat (Phase 5, Stop D fixes): the job's owner tab announces each chat the job wrote
 * (its `resource` events: committed copies) and the job's end; another tab marks the chat to be
 * read again when it is idle there (`markChatNoticed`). Read-only: a notice writes nothing and
 * owns nothing. Other devices and browsers converge through Phase 6's live updates. Without
 * `BroadcastChannel` nothing is announced or received (the chat shows the reply after a reload).
 */

const CHANNEL = "risu-chat-changes";
/** At most one notice per chat in this window (leading and trailing); a final notice goes at once. */
export const NOTICE_INTERVAL_MS = 1000;

type Notice = { epoch: string; chaId: string; chatId: string };

let channel: BroadcastChannel | null = null;
let unavailable = false;
let stopReceiving: (() => void) | null = null;
/**
 * Chats announced within the last interval → whether another notice waits for the interval's end.
 * An entry is dropped when an interval passes with nothing waiting.
 */
const throttles = new Map<string, { waiting: boolean; timer: ReturnType<typeof setTimeout> }>();

function openChannel(): BroadcastChannel | null {
    if (channel || unavailable) {
        return channel;
    }
    try {
        if (typeof BroadcastChannel !== "function") {
            unavailable = true;
            return null;
        }
        channel = new BroadcastChannel(CHANNEL);
    } catch {
        unavailable = true;
        channel = null;
    }
    return channel;
}

function post(ref: ChatRef) {
    const target = openChannel();
    const epoch = getResourceEpoch();
    if (!target || !epoch) {
        return;
    }
    try {
        target.postMessage({ epoch, chaId: ref.chaId, chatId: ref.chatId } satisfies Notice);
    } catch {
        // A closed or failing channel: the other tabs show the change after a reload.
    }
}

/** Announces that a server job changed `ref`'s chat; `final` (the job ended) goes out at once. */
export function announceChatChange(ref: ChatRef, final = false) {
    const key = `${ref.chaId}\u0000${ref.chatId}`;
    const state = throttles.get(key);
    if (final) {
        if (state) {
            clearTimeout(state.timer);
            throttles.delete(key);
        }
        post(ref);
        return;
    }
    if (state) {
        state.waiting = true;
        return;
    }
    post(ref);
    const cooled = () => {
        const current = throttles.get(key);
        if (!current?.waiting) {
            throttles.delete(key);
            return;
        }
        post(ref);
        current.waiting = false;
        current.timer = setTimeout(cooled, NOTICE_INTERVAL_MS);
    };
    throttles.set(key, { waiting: false, timer: setTimeout(cooled, NOTICE_INTERVAL_MS) });
}

function isNotice(data: unknown): data is Notice {
    if (typeof data !== "object" || data === null) {
        return false;
    }
    const notice = data as Record<string, unknown>;
    return (
        typeof notice.epoch === "string" &&
        typeof notice.chaId === "string" &&
        notice.chaId.length > 0 &&
        typeof notice.chatId === "string" &&
        notice.chatId.length > 0
    );
}

/** Starts receiving notices (from `startResourceSync`; a second call keeps the first receiver). Returns the stop function. */
export function startChatChangeNotices(): () => void {
    if (stopReceiving) {
        return stopReceiving;
    }
    const target = openChannel();
    if (!target) {
        return () => {};
    }
    const receive = (event: MessageEvent) => {
        const data: unknown = event.data;
        // A notice from a page of another epoch (before a restore) is not about these chats.
        if (!isNotice(data) || data.epoch !== getResourceEpoch()) {
            return;
        }
        markChatNoticed({ chaId: data.chaId, chatId: data.chatId });
    };
    target.addEventListener("message", receive);
    stopReceiving = () => {
        target.removeEventListener("message", receive);
        stopReceiving = null;
    };
    return stopReceiving;
}

/** Closes the channel and drops pending notices (tests). */
export function resetChatChangeNotices() {
    stopReceiving?.();
    for (const state of throttles.values()) {
        clearTimeout(state.timer);
    }
    throttles.clear();
    channel?.close();
    channel = null;
    unavailable = false;
}
