import type { BlockedRealmCreator } from "../../shared/database.ts";

/**
 * Pure creator-id rules for `settings.ui.blockedRealmCreators`; names are display labels, never
 * identities. Listing cards without a creator stay visible. Downloads needing a creator lookup
 * are guarded separately in `src/ts/characterCards.ts` before any server import is prepared.
 */

export function isRealmCreatorBlocked(list: BlockedRealmCreator[], creator?: string): boolean {
    return !!creator && list.some((blocked) => blocked.id === creator);
}

/** Empty ids and duplicate ids leave the original list intact; a new creator does not mutate it. */
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

/** Keeps cards without creator metadata; callers must not treat visibility as download authorization. */
export function filterBlockedRealmCards<T extends { creator?: string }>(cards: T[], list: BlockedRealmCreator[]): T[] {
    return cards.filter((card) => !isRealmCreatorBlocked(list, card.creator));
}
