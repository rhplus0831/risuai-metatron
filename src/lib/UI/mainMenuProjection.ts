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

/** The "3h ago" text of a `lastInteraction` stamp, shared by the home screen and the mobile character list. */
export function makeCharacterAgoText(
    time: number,
    { agoFormatter, unknownText, now = Date.now() }: CharacterAgoTextOptions,
) {
    if (time === 0) {
        return unknownText;
    }
    // The stamp is the server's clock: a client clock behind it reads as "0 minutes ago", not "in 1 minute".
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
 * The home screen's recent characters: those sent to at least once (`lastInteraction`), newest first,
 * without the trash and the playground character.
 */
export function collectHomeRecentCharacters(
    characters: readonly AnyClientCharacter[],
    options: CharacterAgoTextOptions & { limit?: number },
): HomeRecentCharacterItem[] {
    const limit = Math.max(0, options.limit ?? HOME_RECENT_CHARACTER_LIMIT);
    return characters
        .filter((c) => c?.chaId && c.chaId !== "§playground" && !c.trashTime && (c.lastInteraction || 0) > 0)
        .map((c) => ({ c, name: c.name || "Unnamed", interaction: c.lastInteraction || 0 }))
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
