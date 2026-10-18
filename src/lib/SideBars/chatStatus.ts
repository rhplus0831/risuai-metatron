import { language } from "src/lang";

export type ChatStatus = "recovery" | "generating" | "unseen";

export const CHAT_STATUS_PRIORITY: readonly ChatStatus[] = ["recovery", "generating", "unseen"];

export type ChatStatusSets = {
    recovery: ReadonlySet<string> | ReadonlyMap<string, unknown>;
    generating: ReadonlySet<string>;
    unseen: ReadonlySet<string>;
};

export function resolveChatStatus(sets: ChatStatusSets, chatKey: string): ChatStatus | null {
    return CHAT_STATUS_PRIORITY.find((status) => sets[status].has(chatKey)) ?? null;
}

export function collectCharacterStatuses(sets: ChatStatusSets): ReadonlyMap<string, ChatStatus> {
    const statuses = new Map<string, ChatStatus>();
    for (const status of CHAT_STATUS_PRIORITY) {
        for (const key of sets[status].keys()) {
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

export function chatStatusLabel(status: ChatStatus, name: string): string {
    return language.chatStatus[status](name);
}
