import { chatHypaV3Preset, chatMemoryAlgorithm, chatMemoryEnabled } from "../../../shared/chatMemory.ts";
import { chatMemorySettings } from "src/ts/storage/chatMemory.svelte";
import { untrack } from "svelte";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import { fromStore, get, writable } from "svelte/store";
import { parseContextReport, type ContextReport } from "../../../shared/contextReport.ts";
import type { Message } from "../../../shared/database.ts";
import type { GenerationTerminalEvent } from "../../../shared/jobs.ts";
import type { DeepReadonly } from "../../../shared/readonly.ts";
import {
    MEMORY_HEALTH_CHATS_MAX,
    memoryHealthState,
    STRUCTURED_MEMORY_ALGORITHM,
    type MemoryHealthState,
    type StructuredMemoryHealthEntry,
    type StructuredMemoryHealthFacts,
} from "../../../shared/structuredMemory.ts";
import { characterList, findCharacter } from "src/ts/storage/characterStore.svelte";
import {
    chatEntry,
    chatList,
    currentChatRef,
    findChat,
    lockedChatKeys,
    onRemoteStreaming,
    type ChatRef,
} from "src/ts/storage/chatStore.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { PlaygroundStore, selection } from "src/ts/storage/selection.svelte";
import { followedJobs, readChatAgain } from "src/ts/process/serverCommands";
import { isLocalSend, localSends } from "src/ts/process/localSends";
import { memoryTaskStatus } from "src/ts/process/memoryTasks.svelte";
import { readStructuredMemoryHealth } from "src/ts/process/structuredMemory.svelte";
import { bookmarkListOpen, gridOpenStore, hypaV3ModalOpen, settingsOpen } from "src/ts/screenVisibility";
import { messageSearchPanel } from "src/ts/messageSearch.svelte";
import { popUpEditorStore } from "src/ts/popupEditorSession.svelte";
import { readChatGeneration } from "src/ts/network/generationJobs";
import { runningGenerations } from "src/ts/process/generationProgress.svelte";
import { isPageVisible, pageRecoveryVersion } from "src/ts/pageVisibility.svelte";

/**
 * Projects per-chat generation, visibility, unseen-reply, recovery, and memory-health status.
 * Busy admission combines `src/ts/process/localSends.ts`, followed jobs from
 * `src/ts/process/serverCommands.ts`, and chat-store locks; foreign-job marks are advisory.
 * The generating badge also counts the feed's running jobs (`generatingBadgeKeys`).
 * Store subscriptions are acquired lazily to avoid reading followed jobs during the import cycle.
 * `watchChatVisibility` owns effects and subscriptions: visibility clears badges and schedules
 * recovery reads. Visible chats discover foreign jobs on show, page recovery, and feed writes;
 * lockless marks are rechecked while shown. These marks and health facts never gate a send.
 */

const MAX_UNSEEN_CHATS = 256;

/** How long after a read of every chat's health a page return waits before it reads them again. */
const HEALTH_REREAD_MS = 60_000;

/** How often a visible foreign job without a message lock is checked for completion. */
export const FOREIGN_JOB_RECHECK_MS = 15_000;

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
 * Chats that show the generating badge (reactive): `generatingChatKeys` plus the chat of every running
 * job the live-update feed lists, previews excluded. A new send holds no message lock until its first
 * `begin`, which follows the provider's response, so a tab that does not follow the job (another
 * device, another tab) would otherwise show nothing until then; the feed lists the job from its
 * admission. Display only: `isChatBusy` and the write fences keep `generatingChatKeys`.
 */
export function generatingBadgeKeys(): ReadonlySet<string> {
    const keys = new Set(generatingChatKeys());
    for (const entry of runningGenerations()) {
        if (entry.kind !== "preview" && entry.kind !== "previewPrompt") {
            keys.add(chatStatusKey({ chaId: entry.characterId, chatId: entry.chatId }));
        }
    }
    return keys;
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

/** Records an advisory foreign job for this chat, notifying only when its id changes. */
export function noteForeignJob(ref: ChatRef, jobId: string): void {
    const key = chatStatusKey(ref);
    const jobs = get(foreignJobs);
    if (jobs.get(key) !== jobId) foreignJobs.set(new Map(jobs).set(key, jobId));
}

/** With `jobId`, clears the mark only while it still names that job, so a late clear keeps a newer job's mark. */
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

// The memory health badge. Shared module-level deriveds select the chats (`healthChatKeys`) and compute
// their states. Entries keep the newest applied request per chat status key; late older answers are ignored.
// Reads cover the pinned chats and the open chat alone: after boot, for a chat newly pinned, for the
// open chat as it opens, when the memory panel closes, and when a memory task ends in it, and for every
// chat when the page comes back after a minute. Never on a send: the badge is a last observation. The
// task's end is read for the context meter, whose last report cannot say that a later run made good a
// failed one (`memoryHealthFacts`). The open chat adds
// what its newest report says, and this tab's mark of a send that failed because the required pages were
// over the cap, which only a reload or the chat's next good send clears. An unavailable entry supplies
// no facts; the report and over-cap mark still apply and outrank that unknown state.

/** The health entry last read per chat status key; null for a chat the server does not know. */
const healthFacts = new SvelteMap<string, StructuredMemoryHealthEntry | null>();

let healthReadGeneration = 0;
const appliedHealthGenerations = new Map<string, number>();

/** Chats whose last send failed because the required memory pages were over the cap, until their next good send. */
const requiredOverCapChats = new SvelteSet<string>();

/** When every chat with a state was last read, for the page-return reads. */
let healthReadAt = 0;

function structuredMemorySelected(ref: ChatRef): boolean {
    return chatMemoryAlgorithm(chatMemorySettings(), chatEntry(ref)) === STRUCTURED_MEMORY_ALGORITHM;
}

/** Shared derived keys for health states and reads: the open chat first, then the pinned chats. */
const healthChatKeys = $derived.by((): string[] => {
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
});

const structuredHealthChatKeys = $derived(healthChatKeys.filter((key) => structuredMemorySelected(keyRef(key))));

/**
 * Reads the health entries of `keys`, `MEMORY_HEALTH_CHATS_MAX` a request. A chat's answer applies only
 * if its request is newer than that chat's last applied request. An answer is a prefix of its request,
 * so the next request starts at the first key it left out. A failed read leaves what is held and throws nothing.
 */
async function readHealth(keys: readonly string[]): Promise<void> {
    let start = 0;
    while (start < keys.length) {
        const chunk = keys.slice(start, start + MEMORY_HEALTH_CHATS_MAX);
        const generation = ++healthReadGeneration;
        const result = await readStructuredMemoryHealth(chunk.map(keyRef));
        if (result.outcome !== "ok") {
            return;
        }
        const { health } = result.value;
        health.forEach((facts, index) => {
            const key = chunk[index];
            if (generation <= (appliedHealthGenerations.get(key) ?? 0)) {
                return;
            }
            healthFacts.set(key, facts);
            appliedHealthGenerations.set(key, generation);
        });
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

const healthStates = $derived.by(() => {
    const states = new Map<string, MemoryHealthState>();
    const open = currentChatRef();
    const openKey = open ? chatStatusKey(open) : null;
    for (const key of structuredHealthChatKeys) {
        const ref = keyRef(key);
        if (!chatMemoryEnabled(chatEntry(ref), findCharacter(ref.chaId), chatMemorySettings())) {
            continue;
        }
        const preset = chatHypaV3Preset(
            settings.hypaV3Presets.items,
            settings.hypaV3Presets.selectedId,
            chatEntry(ref),
        )?.settings;
        const entry = healthFacts.get(key) ?? null;
        const facts = entry === "unavailable" ? null : entry;
        const memory = key === openKey ? newestMemoryReport(findChat(ref)?.message ?? []) : null;
        const staleExcluded = memory?.excluded?.filter(({ reason }) => reason === "stale").length ?? 0;
        const state = memoryHealthState({
            writerPaused: memory?.writer?.state === "paused" || facts?.paused === true,
            gap: memory?.gapTokens !== undefined && preset !== undefined && memory.gapTokens > preset.gapConfirmTokens,
            staleEvents: (facts?.storedStale ?? 0) + (facts?.pendingRepairs ?? 0) + staleExcluded > 0,
            unsupportedSections: (facts?.unsupportedSections ?? 0) > 0,
            requiredOverCap: requiredOverCapChats.has(key),
            pageOverBudget: (facts?.overBudgetSections ?? 0) > 0,
            unavailable: entry === "unavailable",
        });
        if (state) {
            states.set(key, state);
        }
    }
    return states;
});

/**
 * The chat's health facts as last read (reactive): null before a read, for an unavailable entry, and
 * for a chat the server does not know. Held only for the open chat and the pinned ones.
 */
export function memoryHealthFacts(ref: ChatRef): StructuredMemoryHealthFacts | null {
    const entry = healthFacts.get(chatStatusKey(ref)) ?? null;
    return entry === "unavailable" ? null : entry;
}

/**
 * Returns the shared derived health states (`memoryHealthState`) by status key, current even outside
 * a reactive context: the pinned chats and the open chat whose own algorithm is Structured Memory and whose
 * memory switch is on. A chat not loaded is judged from its last read facts, so its stale
 * count is partial and it knows no gap; the open chat adds its newest report's gap against its own preset's
 * `gapConfirmTokens`, its writer state, and its stale exclusions. An unavailable entry contributes no
 * facts, but those report inputs and the tab's required-over-cap mark still apply and take priority.
 */
export function memoryHealthStates(): ReadonlyMap<string, MemoryHealthState> {
    return healthStates;
}

/**
 * Starts the tab's visibility and new-follow cleanup, and the health reads; the caller owns the returned disposer.
 * A visible chat discovers foreign jobs on show, page recovery, and a feed write or end naming it.
 * Reads skip locked chats and chats this tab follows or sends in. Visible lockless marks are checked
 * every `FOREIGN_JOB_RECHECK_MS`; hiding the chat or disposing stops the timer. Reads leave effects
 * first, skip overlaps, and preserve newer marks. A failed read waits for the next trigger.
 */
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

        const visibleKey = $derived(visibleChatKey());
        const readingForeignJobs = new Set<string>();
        let disposed = false;
        async function readForeignJob(key: string): Promise<void> {
            const ref = keyRef(key);
            if (
                disposed ||
                key !== visibleChatKey() ||
                readingForeignJobs.has(key) ||
                lockedChatKeys().has(key) ||
                [...get(followedJobs).values()].includes(key) ||
                isLocalSend(ref)
            ) {
                return;
            }
            const expectedJobId = get(foreignJobs).get(key);
            readingForeignJobs.add(key);
            try {
                const current = await readChatGeneration(ref);
                // An initially absent mark also needs this guard: undefined passed to clearForeignJob
                // would otherwise remove a mark discovered while this read was in flight.
                if (disposed || get(foreignJobs).get(key) !== expectedJobId) return;
                const followed = get(followedJobs);
                if (
                    !current ||
                    current.owned ||
                    followed.has(current.jobId) ||
                    [...followed.values()].includes(key) ||
                    isLocalSend(ref)
                ) {
                    clearForeignJob(ref, expectedJobId);
                } else {
                    noteForeignJob(ref, current.jobId);
                }
            } catch {
                // Keep the observation until the next show, page recovery, feed signal, or timer tick.
            } finally {
                readingForeignJobs.delete(key);
            }
        }
        $effect(() => {
            const key = visibleKey;
            pageRecoveryVersion();
            if (key !== null) queueMicrotask(() => void readForeignJob(key));
        });
        const stopStreaming = onRemoteStreaming((streaming) => {
            // The lock-release effect clears the old mark before the observation captures its id.
            queueMicrotask(() => {
                if (disposed) return;
                const key = visibleChatKey();
                if (
                    key !== null &&
                    streaming.some((chat) => chatStatusKey({ chaId: chat.characterId, chatId: chat.id }) === key)
                ) {
                    void readForeignJob(key);
                }
            });
        });
        const sendsView = fromStore(localSends);
        const foreignRecheckKey = $derived.by(() => {
            const key = visibleKey;
            if (
                key === null ||
                !(foreignView ??= fromStore(foreignJobs)).current.has(key) ||
                lockedChatKeys().has(key) ||
                [...(followedView ??= fromStore(followedJobs)).current.values()].includes(key) ||
                isLocalSend(keyRef(key), sendsView.current)
            ) {
                return null;
            }
            return key;
        });
        $effect(() => {
            const key = foreignRecheckKey;
            if (key === null) return;
            const timer = setInterval(() => void readForeignJob(key), FOREIGN_JOB_RECHECK_MS);
            return () => clearInterval(timer);
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
            const keys = structuredHealthChatKeys;
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
            if (!closed) {
                return;
            }
            const open = untrack(currentChatRef);
            if (open && open.chaId !== "§playground" && untrack(() => structuredMemorySelected(open))) {
                const key = chatStatusKey(open);
                queueMicrotask(() => void readHealth([key]));
            }
        });
        // A memory task that ends in the open chat changed what its runs say. A chat switch is no end:
        // the chat opened is read by the effect above.
        let liveTaskKey: string | null = null;
        $effect(() => {
            const open = currentChatRef();
            const key = open && open.chaId !== "§playground" ? chatStatusKey(open) : null;
            const state = open && key !== null ? memoryTaskStatus(open)?.state : undefined;
            const live = state === "queued" || state === "running";
            const ended = !live && state !== undefined && key !== null && liveTaskKey === key;
            liveTaskKey = live ? key : null;
            if (ended && open && untrack(() => structuredMemorySelected(open))) {
                queueMicrotask(() => void readHealth([key]));
            }
        });
        let pageWasVisible = isPageVisible();
        $effect(() => {
            const visible = isPageVisible();
            const returned = !pageWasVisible && visible;
            pageWasVisible = visible;
            if (!returned || Date.now() - healthReadAt < HEALTH_REREAD_MS) {
                return;
            }
            healthReadAt = Date.now();
            const keys = untrack(() => structuredHealthChatKeys);
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
            disposed = true;
            stopStreaming();
            stopFollows();
            stopSends();
        };
    });
}

/** Clears status observations, badge state, and lazy store views for test isolation. */
export function resetChatStatusForTests(): void {
    recoveryChatKeys.set(new Map());
    unseenChatKeys.set(new Set());
    foreignJobs.set(new Map());
    healthFacts.clear();
    healthReadGeneration = 0;
    appliedHealthGenerations.clear();
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
