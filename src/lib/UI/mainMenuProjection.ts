import { characterLastChattedAt } from "src/ts/storage/chatStore.svelte";
import type { AnyClientCharacter } from "src/ts/storage/characterStore.svelte";

export const HOME_RECENT_CHARACTER_LIMIT = 8;

export interface HomeRecentCharacterItem {
    chaId: string;
    name: string;
    image: string;
    agoText: string;
}

export interface CharacterAgoTextOptions {
    agoFormatter: Pick<Intl.RelativeTimeFormat, "format">;
    unknownText: string;
    now?: number;
}

/** The "3h ago" text of the derived last-chatted time, shared by the home screen and the mobile character list. */
export function makeCharacterAgoText(
    time: number,
    { agoFormatter, unknownText, now = Date.now() }: CharacterAgoTextOptions,
) {
    if (time === 0) {
        return unknownText;
    }
    // A message time ahead of the client clock reads as "0 minutes ago", not "in 1 minute".
    const diff = Math.max(0, now - time);
    if (diff < 3600000) {
        const min = Math.floor(diff / 60000);
        return agoFormatter.format(-min, "minute");
    }
    if (diff < 86400000) {
        const hour = Math.floor(diff / 3600000);
        return agoFormatter.format(-hour, "hour");
    }
    if (diff < 604800000) {
        const day = Math.floor(diff / 86400000);
        return agoFormatter.format(-day, "day");
    }
    if (diff < 2592000000) {
        const week = Math.floor(diff / 604800000);
        return agoFormatter.format(-week, "week");
    }
    if (diff < 31536000000) {
        const month = Math.floor(diff / 2592000000);
        return agoFormatter.format(-month, "month");
    }
    const year = Math.floor(diff / 31536000000);
    return agoFormatter.format(-year, "year");
}

/**
 * The home screen's recent characters: those with a positive last-chatted time, newest first,
 * without the trash and the playground character.
 */
export function collectHomeRecentCharacters(
    characters: readonly AnyClientCharacter[],
    options: CharacterAgoTextOptions & {
        limit?: number;
        lastChattedAt?: (chaId: string, fallback?: unknown) => number;
    },
): HomeRecentCharacterItem[] {
    const limit = Math.max(0, options.limit ?? HOME_RECENT_CHARACTER_LIMIT);
    const lastChattedAt = options.lastChattedAt ?? characterLastChattedAt;
    return characters
        .filter((c) => c?.chaId && c.chaId !== "§playground" && !c.trashTime)
        .map((c) => ({ c, name: c.name || "Unnamed", interaction: lastChattedAt(c.chaId, c.lastInteraction) }))
        .filter(({ interaction }) => interaction > 0)
        .sort((a, b) =>
            a.interaction === b.interaction ? a.name.localeCompare(b.name) : b.interaction - a.interaction,
        )
        .slice(0, limit)
        .map(({ c, name, interaction }) => ({
            chaId: c.chaId,
            name,
            image: c.image ?? "",
            agoText: makeCharacterAgoText(interaction, options),
        }));
}
