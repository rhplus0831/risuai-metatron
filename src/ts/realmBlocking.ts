import type { BlockedRealmCreator } from "../../shared/database.ts";

export function isRealmCreatorBlocked(list: BlockedRealmCreator[], creator?: string): boolean {
    return !!creator && list.some((blocked) => blocked.id === creator);
}

export function addBlockedRealmCreator(
    list: BlockedRealmCreator[],
    creator: BlockedRealmCreator,
): BlockedRealmCreator[] {
    if (!creator.id || isRealmCreatorBlocked(list, creator.id)) {
        return list;
    }
    return [...list, creator];
}

export function removeBlockedRealmCreator(list: BlockedRealmCreator[], id: string): BlockedRealmCreator[] {
    return list.filter((creator) => creator.id !== id);
}

export function filterBlockedRealmCards<T extends { creator?: string }>(cards: T[], list: BlockedRealmCreator[]): T[] {
    return cards.filter((card) => !isRealmCreatorBlocked(list, card.creator));
}
