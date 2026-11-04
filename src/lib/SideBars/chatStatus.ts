import { language } from "src/lang";
import type { RefusedItem } from "src/ts/storage/resourceSync.svelte";
import { MEMORY_HEALTH_STATES, type MemoryHealthState } from "../../../shared/structuredMemory.ts";

export type ChatStatus = "recovery" | "refused" | "generating" | "memory" | "unseen" | "health";

/**
 * Status priority, most urgent first: a chat shows the first status that holds for it, and a character (any of its
 * chats) or a folder (any of its members' characters) the first that holds for any of them.
 */
export const CHAT_STATUS_PRIORITY: readonly ChatStatus[] = [
    "recovery",
    "refused",
    "generating",
    "memory",
    "unseen",
    "health",
];

/** A summarizing chat's progress (`done/total`). */
export type MemoryCount = { done: number; total: number };

export type ChatStatusSets = {
    recovery: ReadonlySet<string> | ReadonlyMap<string, unknown>;
    refused?: ReadonlySet<string>;
    generating: ReadonlySet<string>;
    /** Chats whose HypaV3 memory task is queued or running (`summarizingChats`); none when absent. */
    memory?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
    unseen: ReadonlySet<string>;
    /** Chats whose Structured Memory health badge has a state (`memoryHealthStates`); none when absent. */
    health?: ReadonlyMap<string, MemoryHealthState>;
};

/**
 * Chat status keys, distinct from the save adapter's opaque refusal keys. Only `chat` refusals give a chat its
 * refused badge; a refused record or order shows in the app-level refusal list only.
 */
export function refusedChatKeys(items: readonly RefusedItem[]): ReadonlySet<string> {
    return new Set(items.filter((item) => item.kind === "chat").map((item) => `${item.chaId}\u0000${item.chatId}`));
}

export function resolveChatStatus(sets: ChatStatusSets, chatKey: string): ChatStatus | null {
    return CHAT_STATUS_PRIORITY.find((status) => sets[status]?.has(chatKey)) ?? null;
}

export function collectCharacterStatuses(sets: ChatStatusSets): ReadonlyMap<string, ChatStatus> {
    const statuses = new Map<string, ChatStatus>();
    for (const status of CHAT_STATUS_PRIORITY) {
        for (const key of sets[status]?.keys() ?? []) {
            const [chaId] = key.split("\u0000", 1);
            if (!statuses.has(chaId)) {
                statuses.set(chaId, status);
            }
        }
    }
    return statuses;
}

export function folderStatus(statuses: ReadonlyMap<string, ChatStatus>, chaIds: readonly string[]): ChatStatus | null {
    let result: ChatStatus | null = null;
    let priority = CHAT_STATUS_PRIORITY.length;
    for (const chaId of chaIds) {
        const status = statuses.get(chaId);
        if (status) {
            const nextPriority = CHAT_STATUS_PRIORITY.indexOf(status);
            if (nextPriority < priority) {
                result = status;
                priority = nextPriority;
            }
        }
    }
    return result;
}

/** Per character id: how many of its chats summarize, and the count of the first one. */
export type MemoryProgress = ReadonlyMap<string, { chats: number; count: MemoryCount | null }>;

/** Groups the summarizing chats (chat status key → count or null) by character. */
export function collectMemoryProgress(memory: ReadonlyMap<string, MemoryCount | null>): MemoryProgress {
    const progress = new Map<string, { chats: number; count: MemoryCount | null }>();
    for (const [key, count] of memory) {
        const [chaId] = key.split("\u0000", 1);
        const held = progress.get(chaId);
        progress.set(chaId, held ? { chats: held.chats + 1, count: held.count } : { chats: 1, count });
    }
    return progress;
}

/**
 * The count a character's or folder's memory badge shows: the count of its only summarizing chat
 * across `chaIds`, or null when several chats summarize (the status without a count) or the one has
 * no count yet.
 */
export function groupMemoryCount(progress: MemoryProgress, chaIds: readonly string[]): MemoryCount | null {
    let found: { chats: number; count: MemoryCount | null } | undefined;
    for (const chaId of chaIds) {
        const entry = progress.get(chaId);
        if (entry) {
            if (found || entry.chats > 1) {
                return null;
            }
            found = entry;
        }
    }
    return found?.count ?? null;
}

/** The badge text of a count (`k/n`). */
export function memoryCountText(count: MemoryCount): string {
    return `${count.done}/${count.total}`;
}

/**
 * The worst health state among the chats of `chaIds` (`MEMORY_HEALTH_STATES` order), what a character's
 * or folder's badge shows; null with none.
 */
export function groupHealthState(
    states: ReadonlyMap<string, MemoryHealthState>,
    chaIds: readonly string[],
): MemoryHealthState | null {
    const owners = new Set(chaIds);
    let worst: number = MEMORY_HEALTH_STATES.length;
    for (const [key, state] of states) {
        const [chaId] = key.split("\u0000", 1);
        if (owners.has(chaId)) {
            worst = Math.min(worst, MEMORY_HEALTH_STATES.indexOf(state));
        }
    }
    return worst === MEMORY_HEALTH_STATES.length ? null : MEMORY_HEALTH_STATES[worst];
}

/** The text of a health state, what a chat's own badge shows. */
export function memoryHealthText(state: MemoryHealthState): string {
    return language.chatStatus.healthStates[state];
}

/**
 * The status label; a memory status carries its count when it has one, and a health status its state's
 * text when the label is a chat's own (a character's or folder's label is generic).
 */
export function chatStatusLabel(
    status: ChatStatus,
    name: string,
    count: MemoryCount | null = null,
    health: MemoryHealthState | null = null,
): string {
    if (status === "memory") {
        return language.chatStatus.memory(name, count ? memoryCountText(count) : null);
    }
    if (status === "health") {
        return language.chatStatus.health(name, health ? memoryHealthText(health) : null);
    }
    return language.chatStatus[status](name);
}
