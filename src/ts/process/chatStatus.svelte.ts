import { untrack } from "svelte";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import { fromStore, get, writable } from "svelte/store";
import { parseContextReport, type ContextReport } from "../../../shared/contextReport.ts";
import type { Message } from "../../../shared/database.ts";
import { selectedHypaV3Preset } from "../../../shared/hypaV3Presets.ts";
import type { GenerationTerminalEvent } from "../../../shared/jobs.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import {
    MEMORY_HEALTH_CHATS_MAX,
    memoryHealthState,
    normalizeStructuredMemorySettings,
    STRUCTURED_MEMORY_ALGORITHM,
    type MemoryHealthState,
    type StructuredMemoryHealthFacts,
} from "../../../shared/structuredMemory.ts";
import { characterList, findCharacter } from "src/ts/storage/characterStore.svelte";
import {
    chatEntry,
    chatList,
    currentChatRef,
    findChat,
    lockedChatKeys,
    type ChatRef,
} from "src/ts/storage/chatStore.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { PlaygroundStore, selection } from "src/ts/storage/selection.svelte";
import { followedJobs, readChatAgain } from "src/ts/process/serverCommands";
import { isLocalSend, localSends } from "src/ts/process/localSends";
import { readStructuredMemoryHealth } from "src/ts/process/structuredMemory.svelte";
import { bookmarkListOpen, gridOpenStore, hypaV3ModalOpen, settingsOpen } from "src/ts/screenVisibility";
import { messageSearchPanel } from "src/ts/messageSearch.svelte";
import { popUpEditorStore } from "src/ts/popupEditorSession.svelte";
import { isPageVisible } from "src/ts/pageVisibility.svelte";

const MAX_UNSEEN_CHATS = 256;

/** How long after a read of every chat's health a page return waits before it reads them again. */
const HEALTH_REREAD_MS = 60_000;

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

function keyRef(key: string): ChatRef {
    const [chaId, chatId] = key.split("\u0000");
    return { chaId, chatId };
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

/** Lost follows, held until the chat is viewed (which reads it again, `readChatAgain`) or another job of it is followed. */
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

/**
 * Notes a job's end for the chat's badges: a send that failed because its required memory pages were over
 * the cap marks the chat until its next good send, which also marks the chat unseen when the reply
 * landed away from the open chat.
 */
export function noteJobDone(ref: ChatRef, end: GenerationTerminalEvent): void {
    const key = chatStatusKey(ref);
    if (end.type === "error") {
        if (end.code === "memoryRequiredOverCap") {
            requiredOverCapChats.add(key);
        }
        return;
    }
    if (typeof end.messageId !== "string" || end.messageId.length === 0) {
        return;
    }
    requiredOverCapChats.delete(key);
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

// The memory health badge. The facts are the server's last answer per chat status key, read for the
// pinned chats and the open chat alone (`healthChatKeys`): after boot, for a chat newly pinned, for the
// open chat as it opens and when the memory panel closes, and for every chat when the page comes back
// after a minute. Never on a send or a task's end: the badge is a last observation. The open chat adds
// what its newest report says, and this tab's mark of a send that failed because the required pages were
// over the cap, which only a reload or the chat's next good send clears.

/** The health facts last read per chat status key; null for a chat the server does not know. */
const healthFacts = new SvelteMap<string, StructuredMemoryHealthFacts | null>();

/** Chats whose last send failed because the required memory pages were over the cap, until their next good send. */
const requiredOverCapChats = new SvelteSet<string>();

/** When every chat with a state was last read, for the page-return reads. */
let healthReadAt = 0;

function structuredMemorySelected(): boolean {
    return settings.ui.memoryAlgorithmType === STRUCTURED_MEMORY_ALGORITHM;
}

/** The chats that have a health state: the open chat first, then the pinned chats, by status key (reactive). */
function healthChatKeys(): string[] {
    const keys: string[] = [];
    const open = currentChatRef();
    if (open && open.chaId !== "§playground") {
        keys.push(chatStatusKey(open));
    }
    for (const character of characterList()) {
        if (!character || character.trashTime) {
            continue;
        }
        for (const chat of chatList(character.chaId)) {
            const key = chatStatusKey({ chaId: character.chaId, chatId: chat.id });
            if (chat.pinned === true && !keys.includes(key)) {
                keys.push(key);
            }
        }
    }
    return keys;
}

/**
 * Reads the health facts of `keys`, `MEMORY_HEALTH_CHATS_MAX` a request, and keeps each answer as it
 * comes. An answer is a prefix of its request, so the next request starts at the first key it left out.
 * A read that does not answer leaves what is held and throws nothing.
 */
async function readHealth(keys: readonly string[]): Promise<void> {
    let start = 0;
    while (start < keys.length) {
        const chunk = keys.slice(start, start + MEMORY_HEALTH_CHATS_MAX);
        const result = await readStructuredMemoryHealth(chunk.map(keyRef));
        if (result.outcome !== "ok") {
            return;
        }
        const { health } = result.value;
        health.forEach((facts, index) => healthFacts.set(chunk[index], facts));
        start += health.length;
    }
}

/** The memory part of the newest valid report among `messages` when it is Structured Memory's, else null. */
function newestMemoryReport(messages: readonly DeepReadonly<Message>[]): NonNullable<ContextReport["memory"]> | null {
    for (let index = messages.length - 1; index >= 0; index--) {
        const report = parseContextReport(messages[index].generationInfo?.context);
        if (report) {
            return report.memory?.kind === "structuredMemory" ? report.memory : null;
        }
    }
    return null;
}

/**
 * The memory health state of each chat that has one (`memoryHealthState`), by status key: the pinned
 * chats and the open chat, while Structured Memory is the selected algorithm and the chat's character
 * has memory on (reactive). A chat not loaded is judged from its last read facts, so its stale count is
 * partial and it knows no gap; the open chat adds its newest report's gap against the preset's
 * `gapConfirmTokens`, its writer state, and its stale exclusions. `customPrompt` is the preset's and
 * needs no facts.
 */
export function memoryHealthStates(): ReadonlyMap<string, MemoryHealthState> {
    const states = new Map<string, MemoryHealthState>();
    if (!structuredMemorySelected()) {
        return states;
    }
    const preset = selectedHypaV3Preset({
        hypaV3Presets: settings.hypaV3Presets.items,
        hypaV3PresetId: settings.hypaV3Presets.selectedId,
    })?.settings;
    const customPrompt = normalizeStructuredMemorySettings(preset?.structured).fineTuning;
    const open = currentChatRef();
    const openKey = open ? chatStatusKey(open) : null;
    for (const key of healthChatKeys()) {
        const ref = keyRef(key);
        if (!findCharacter(ref.chaId)?.supaMemory) {
            continue;
        }
        const facts = healthFacts.get(key) ?? null;
        const memory = key === openKey ? newestMemoryReport(findChat(ref)?.message ?? []) : null;
        const staleExcluded = memory?.excluded?.filter(({ reason }) => reason === "stale").length ?? 0;
        const state = memoryHealthState({
            writerPaused: memory?.writer?.state === "paused" || facts?.paused === true,
            gap: memory?.gapTokens !== undefined && preset !== undefined && memory.gapTokens > preset.gapConfirmTokens,
            staleEvents: (facts?.storedStale ?? 0) + (facts?.pendingRepairs ?? 0) + staleExcluded > 0,
            unsupportedSections: (facts?.unsupportedSections ?? 0) > 0,
            requiredOverCap: requiredOverCapChats.has(key),
            pageOverBudget: (facts?.overBudgetSections ?? 0) > 0,
            customPrompt,
        });
        if (state) {
            states.set(key, state);
        }
    }
    return states;
}

/** Starts the tab's visibility and new-follow cleanup, and the health reads; the caller owns the returned disposer. */
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
                // The lost job may have written since the chat was last read: read it again now that it
                // is shown (outside the effect; `readChatAgain` writes chat state).
                queueMicrotask(() => readChatAgain(keyRef(key)));
            }
        });

        let previousLocks = lockedChatKeys();
        $effect(() => {
            const locks = lockedChatKeys();
            for (const key of previousLocks) {
                if (!locks.has(key)) {
                    clearForeignJob(keyRef(key));
                }
            }
            previousLocks = locks;
        });

        // The health reads leave their effect first and nothing waits on them, so boot and the first
        // chat render go on without them. Keys the last run saw are not read again: a chat read as it
        // opens or when the panel closes is, and a pinned chat on its way back from the pins is too.
        let known = new Set<string>();
        let previousOpen: string | null = null;
        $effect(() => {
            if (!structuredMemorySelected()) {
                known = new Set();
                previousOpen = null;
                return;
            }
            const keys = healthChatKeys();
            const ref = currentChatRef();
            const openKey = ref && ref.chaId !== "§playground" ? chatStatusKey(ref) : null;
            const opened = openKey !== null && openKey !== previousOpen ? openKey : null;
            const fresh = keys.filter((key) => !known.has(key) || key === opened);
            if (known.size === 0) {
                healthReadAt = Date.now();
            }
            known = new Set(keys);
            previousOpen = openKey;
            if (fresh.length > 0) {
                queueMicrotask(() => void readHealth(fresh));
            }
        });
        let panelWasOpen = false;
        $effect(() => {
            const panelOpen = (hypaV3View ??= fromStore(hypaV3ModalOpen)).current;
            const closed = panelWasOpen && !panelOpen;
            panelWasOpen = panelOpen;
            if (!closed || !untrack(structuredMemorySelected)) {
                return;
            }
            const open = untrack(currentChatRef);
            if (open && open.chaId !== "§playground") {
                const key = chatStatusKey(open);
                queueMicrotask(() => void readHealth([key]));
            }
        });
        let pageWasVisible = isPageVisible();
        $effect(() => {
            const visible = isPageVisible();
            const returned = !pageWasVisible && visible;
            pageWasVisible = visible;
            if (!returned || !untrack(structuredMemorySelected) || Date.now() - healthReadAt < HEALTH_REREAD_MS) {
                return;
            }
            healthReadAt = Date.now();
            const keys = untrack(healthChatKeys);
            if (keys.length > 0) {
                queueMicrotask(() => void readHealth(keys));
            }
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
                if (!chatEntry(keyRef(key))) {
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
    healthFacts.clear();
    requiredOverCapChats.clear();
    healthReadAt = 0;
    foreignView = undefined;
    followedView = undefined;
    playgroundView = undefined;
    recoveryView = undefined;
    unseenView = undefined;
    settingsView = undefined;
    gridView = undefined;
    hypaV3View = undefined;
}
