import { describe, expect, it } from "vitest";
import type { AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
import { collectHomeRecentCharacters, HOME_RECENT_CHARACTER_LIMIT, makeCharacterAgoText } from "./mainMenuProjection";

const agoFormatter = { format: (value: number, unit: Intl.RelativeTimeFormatUnit) => `${value} ${unit}` };
const now = 1_000_000_000_000;
const options = { agoFormatter, unknownText: "Unknown", now };

function char(chaId: string, fields: Partial<AnyClientCharacter> = {}): AnyClientCharacter {
    return { chaId, name: chaId, image: `${chaId}.png`, type: "character", ...fields } as AnyClientCharacter;
}

describe("makeCharacterAgoText", () => {
    it("names the largest whole unit since the stamp, and the unknown text for no stamp", () => {
        expect(makeCharacterAgoText(0, options)).toBe("Unknown");
        expect(makeCharacterAgoText(now - 5 * 60_000, options)).toBe("-5 minute");
        expect(makeCharacterAgoText(now - 3 * 3_600_000, options)).toBe("-3 hour");
        expect(makeCharacterAgoText(now - 2 * 86_400_000, options)).toBe("-2 day");
        expect(makeCharacterAgoText(now - 400 * 86_400_000, options)).toBe("-1 year");
    });
});

describe("collectHomeRecentCharacters", () => {
    it("lists the characters sent to, newest first, without the trash, the playground, or a missing stamp", () => {
        const rows = collectHomeRecentCharacters(
            [
                char("old", { lastInteraction: now - 86_400_000 }),
                char("never"),
                char("trashed", { lastInteraction: now - 1_000, trashTime: now }),
                char("§playground", { lastInteraction: now - 1_000 }),
                char("new", { lastInteraction: now - 60_000, image: undefined }),
                char("group", {
                    type: "group",
                    lastInteraction: now - 3_600_000,
                    name: "",
                } as Partial<AnyClientCharacter>),
            ],
            options,
        );
        expect(rows).toEqual([
            { chaId: "new", name: "new", image: "", agoText: "-1 minute" },
            { chaId: "group", name: "Unnamed", image: "group.png", agoText: "-1 hour" },
            { chaId: "old", name: "old", image: "old.png", agoText: "-1 day" },
        ]);
    });

    it("breaks a tie by name and keeps only the limit", () => {
        const many = Array.from({ length: HOME_RECENT_CHARACTER_LIMIT + 2 }, (_, i) =>
            char(`c${String.fromCharCode(106 - i)}`, { lastInteraction: now - 1_000 }),
        );
        const rows = collectHomeRecentCharacters(many, options);
        expect(rows).toHaveLength(HOME_RECENT_CHARACTER_LIMIT);
        expect(rows.map((row) => row.chaId)).toEqual(
            [...many.map((c) => c.chaId)].sort().slice(0, HOME_RECENT_CHARACTER_LIMIT),
        );
        expect(collectHomeRecentCharacters(many, { ...options, limit: 2 })).toHaveLength(2);
    });
});
