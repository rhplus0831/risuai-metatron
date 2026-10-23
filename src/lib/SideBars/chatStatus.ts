import { language } from "src/lang";

export type ChatStatus = "recovery" | "generating" | "memory" | "unseen";

export const CHAT_STATUS_PRIORITY: readonly ChatStatus[] = ["recovery", "generating", "memory", "unseen"];

/** A summarizing chat's progress (`done/total`). */
export type MemoryCount = { done: number; total: number };

export type ChatStatusSets = {
    recovery: ReadonlySet<string> | ReadonlyMap<string, unknown>;
    generating: ReadonlySet<string>;
    /** Chats whose HypaV3 memory task is queued or running (`summarizingChats`); none when absent. */
    memory?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
    unseen: ReadonlySet<string>;
};

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

/** The status label; a memory status carries its count when it has one. */
export function chatStatusLabel(status: ChatStatus, name: string, count: MemoryCount | null = null): string {
    return status === "memory"
        ? language.chatStatus.memory(name, count ? memoryCountText(count) : null)
        : language.chatStatus[status](name);
}
