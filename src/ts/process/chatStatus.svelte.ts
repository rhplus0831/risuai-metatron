import { fromStore, get, writable } from "svelte/store";
import type { GenerationTerminalEvent } from "../../../shared/jobs.ts";
import { chatEntry, currentChatRef, findChat, lockedChatKeys, type ChatRef } from "src/ts/storage/chatStore.svelte";
import { PlaygroundStore, selection } from "src/ts/storage/selection.svelte";
import { followedJobs } from "src/ts/process/serverCommands";
import { isLocalSend, localSends } from "src/ts/process/localSends";
import { bookmarkListOpen, gridOpenStore, hypaV3ModalOpen, settingsOpen } from "src/ts/screenVisibility";
import { messageSearchPanel } from "src/ts/messageSearch.svelte";
import { popUpEditorStore } from "src/ts/popupEditorSession.svelte";
import { isPageVisible } from "src/ts/pageVisibility.svelte";

const MAX_UNSEEN_CHATS = 256;

// Lazy views avoid reading followedJobs during the serverCommands → chatStatus import cycle.
// fromStore subscribes only for reactive readers; their effects own subscription cleanup.
let followedView: { current: ReadonlyMap<string, string> } | undefined;
let playgroundView: { current: number } | undefined;
let recoveryView: { current: ReadonlyMap<string, string> } | undefined;
let unseenView: { current: ReadonlySet<string> } | undefined;
let settingsView: { current: boolean } | undefined;
let gridView: { current: boolean } | undefined;
let bookmarkView: { current: boolean } | undefined;
let hypaV3View: { current: boolean } | undefined;
let foreignView: { current: ReadonlyMap<string, string> } | undefined;

/** The per-tab status key, shared with the followed-job registry. */
export function chatStatusKey(ref: ChatRef): string {
    return `${ref.chaId}\u0000${ref.chatId}`;
}

/** Chats with a job this tab follows or a server generation lock (reactive). */
export function generatingChatKeys(): ReadonlySet<string> {
    const jobs = (followedView ??= fromStore(followedJobs)).current;
    return new Set([...jobs.values(), ...lockedChatKeys()]);
}

/**
 * Whether `ref`'s chat has work that a new send in it would collide with: a send of this tab
 * (`isLocalSend`), a job this tab follows, or a server generation lock (the change feed's included).
 * The server runs one job per chat. Read once, for an admission check.
 */
export function isChatBusy(ref: ChatRef): boolean {
    return isLocalSend(ref) || generatingChatKeys().has(chatStatusKey(ref));
}

/** Advisory only: a stale foreign mark must never block a new send. */
export const foreignJobs = writable<ReadonlyMap<string, string>>(new Map());

export function noteForeignJob(ref: ChatRef, jobId: string): void {
    const key = chatStatusKey(ref);
    const jobs = get(foreignJobs);
    if (jobs.get(key) !== jobId) foreignJobs.set(new Map(jobs).set(key, jobId));
}

export function clearForeignJob(ref: ChatRef, jobId?: string): void {
    const key = chatStatusKey(ref);
    const jobs = get(foreignJobs);
    if (!jobs.has(key) || (jobId !== undefined && jobs.get(key) !== jobId)) return;
    const next = new Map(jobs);
    next.delete(key);
    foreignJobs.set(next);
}

/** Chats with a lock or advisory job mark, excluding chats this tab follows (reactive). */
export function foreignJobChatKeys(): ReadonlySet<string> {
    const foreign = (foreignView ??= fromStore(foreignJobs)).current;
    const followed = (followedView ??= fromStore(followedJobs)).current;
    const keys = new Set([...lockedChatKeys(), ...foreign.keys()]);
    for (const key of followed.values()) keys.delete(key);
    return keys;
}

/** Lost follows, held until the chat is viewed or another job of it is followed. */
export const recoveryChatKeys = writable<ReadonlyMap<string, string>>(new Map());

/** Replies that landed away from this tab's open chat, oldest first. */
export const unseenChatKeys = writable<ReadonlySet<string>>(new Set());

/** Records a lost follow; the watcher clears its recovery mark while this chat is visible. */
export function noteJobLost(ref: ChatRef, jobId: string): void {
    const key = chatStatusKey(ref);
    const recovery = get(recoveryChatKeys);
    if (recovery.get(key) !== jobId) {
        recoveryChatKeys.set(new Map(recovery).set(key, jobId));
    }
}

export function noteJobDone(ref: ChatRef, end: GenerationTerminalEvent): void {
    if (end.type !== "done" || typeof end.messageId !== "string" || end.messageId.length === 0) {
        return;
    }
    const key = chatStatusKey(ref);
    const unseen = get(unseenChatKeys);
    if (key === visibleChatKey() || unseen.has(key)) {
        return;
    }
    const next = new Set(unseen).add(key);
    if (next.size > MAX_UNSEEN_CHATS) {
        next.delete(next.values().next().value!);
    }
    unseenChatKeys.set(next);
}

/**
 * The loaded chat while its transcript is shown on a visible page, including the playground
 * (reactive). Settings, the grid, and the full-page panels over the transcript (bookmarks, message
 * search, HypaV3 memory, the popup editor) hide it; the smaller pickers and dialogs do not.
 */
export function visibleChatKey(): string | null {
    if (
        !isPageVisible() ||
        (settingsView ??= fromStore(settingsOpen)).current ||
        (gridView ??= fromStore(gridOpenStore)).current ||
        (bookmarkView ??= fromStore(bookmarkListOpen)).current ||
        (hypaV3View ??= fromStore(hypaV3ModalOpen)).current ||
        messageSearchPanel.open ||
        popUpEditorStore.open
    ) {
        return null;
    }
    const ref = currentChatRef();
    if (!ref || findChat(ref) === undefined) {
        return null;
    }
    const playground = ref.chaId === "§playground";
    const screen = (playgroundView ??= fromStore(PlaygroundStore)).current;
    return (selection.chatOpen || playground) && screen === (playground ? 2 : 0) ? chatStatusKey(ref) : null;
}

/** Starts the tab's visibility and new-follow cleanup; the caller owns the returned disposer. */
export function watchChatVisibility(): () => void {
    return $effect.root(() => {
        $effect(() => {
            const key = visibleChatKey();
            if (key === null) {
                return;
            }
            const unseen = (unseenView ??= fromStore(unseenChatKeys)).current;
            if (unseen.has(key)) {
                const next = new Set(unseen);
                next.delete(key);
                unseenChatKeys.set(next);
            }
            const recovery = (recoveryView ??= fromStore(recoveryChatKeys)).current;
            if (recovery.has(key)) {
                const next = new Map(recovery);
                next.delete(key);
                recoveryChatKeys.set(next);
            }
        });

        let previousLocks = lockedChatKeys();
        $effect(() => {
            const locks = lockedChatKeys();
            for (const key of previousLocks) {
                if (!locks.has(key)) {
                    const [chaId, chatId] = key.split("\u0000");
                    clearForeignJob({ chaId, chatId });
                }
            }
            previousLocks = locks;
        });

        // A subscription sees even a short follow that starts and ends between effect flushes.
        let previous: ReadonlyMap<string, string> = new Map();
        const stopFollows = followedJobs.subscribe((jobs) => {
            const recovery = get(recoveryChatKeys);
            let next: Map<string, string> | undefined;
            for (const [jobId, key] of jobs) {
                if (previous.get(jobId) !== key && recovery.has(key)) {
                    (next ??= new Map(recovery)).delete(key);
                }
            }
            previous = jobs;
            for (const key of recovery.keys()) {
                const [chaId, chatId] = key.split("\u0000");
                if (!chatEntry({ chaId, chatId })) {
                    (next ??= new Map(recovery)).delete(key);
                }
            }
            if (next) {
                recoveryChatKeys.set(next);
            }
            const foreign = get(foreignJobs);
            const remaining = new Map(foreign);
            for (const key of jobs.values()) remaining.delete(key);
            if (remaining.size !== foreign.size) foreignJobs.set(remaining);
        });
        let previousSends: ReadonlyMap<string, ChatRef | null> = new Map();
        const stopSends = localSends.subscribe((sends) => {
            for (const [key, ref] of sends) {
                if (ref && previousSends.get(key) !== ref) clearForeignJob(ref);
            }
            previousSends = sends;
        });
        return () => {
            stopFollows();
            stopSends();
        };
    });
}

export function resetChatStatusForTests(): void {
    recoveryChatKeys.set(new Map());
    unseenChatKeys.set(new Set());
    foreignJobs.set(new Map());
    foreignView = undefined;
    followedView = undefined;
    playgroundView = undefined;
    recoveryView = undefined;
    unseenView = undefined;
    settingsView = undefined;
    gridView = undefined;
}
