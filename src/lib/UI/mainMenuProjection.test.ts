import { afterEach, describe, expect, it } from "vitest";
import type { ChatRecord, ChatSummary } from "../../../shared/chats";
import { initializeRecords, takeRecordFields } from "src/ts/storage/records.svelte";
import * as chats from "src/ts/storage/chatStore.svelte";
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

describe("recent characters from chat activity", () => {
    afterEach(() => {
        for (const id of chats.heldOrderCharacters()) chats.forgetCharacter(id);
        chats.assembleChats([], [], []);
        initializeRecords(takeRecordFields({ characters: [] }));
    });

    function install(characters: AnyClientCharacter[], entries: (ChatRecord | ChatSummary)[]) {
        const orders = characters.map(({ chaId }) => ({
            characterId: chaId,
            revision: "order",
            ids: entries.filter((entry) => entry.characterId === chaId).map((entry) => entry.id),
        }));
        initializeRecords(takeRecordFields({ characters }));
        chats.seedChats(entries, orders);
        chats.assembleChats(characters, entries, orders);
    }
    const summary = (characterId: string, id: string, time?: number): ChatSummary => ({
        characterId,
        id,
        revision: "00000000-0000-4000-8000-000000000000:1:1",
        name: id,
        fmIndex: -1,
        ...(time === undefined ? {} : { lastMessageAt: time }),
    });

    it("orders home by loaded messages and unloaded summaries, moves back on deletion, and uses a group's own chats", () => {
        const characters = [
            char("active", { lastInteraction: now + 60_000 }),
            char("group", {
                type: "group",
                characters: ["active"],
                lastInteraction: now + 120_000,
            } as Partial<AnyClientCharacter>),
            char("legacy", { lastInteraction: now - 3 * 60_000 }),
        ];
        const ref = { chaId: "active", chatId: "loaded" };
        install(characters, [
            {
                ...summary("active", "loaded"),
                data: {
                    id: "loaded",
                    name: "Loaded",
                    note: "",
                    localLore: [],
                    message: [
                        { role: "char", data: "earlier, with a later clock", chatId: "first", time: now },
                        { role: "char", data: "last by position", chatId: "last", time: now - 6 * 60_000 },
                    ],
                },
            },
            summary("active", "unloaded", now - 4 * 60_000),
            summary("group", "own", now - 2 * 60_000),
            summary("legacy", "empty"),
        ]);
        const rows = () => collectHomeRecentCharacters(characters, options);
        expect(chats.findChat({ chaId: "active", chatId: "unloaded" })).toBeUndefined();
        expect(chats.characterLastChattedAt("active", now + 60_000)).toBe(now - 4 * 60_000);
        expect(rows().map(({ chaId }) => chaId)).toEqual(["group", "legacy", "active"]);

        // No summary refresh accompanies this local reply.
        chats.appendMessage(ref, { role: "char", data: "new reply", chatId: "reply", time: now - 60_000 });
        expect(chats.characterLastChattedAt("active", now + 60_000)).toBe(now - 60_000);
        expect(rows().map(({ chaId, agoText }) => [chaId, agoText])).toEqual([
            ["active", "-1 minute"],
            ["group", "-2 minute"],
            ["legacy", "-3 minute"],
        ]);
        chats.removeMessages(ref, ["reply"]);
        expect(chats.characterLastChattedAt("active", now + 60_000)).toBe(now - 4 * 60_000);
        expect(rows().map(({ chaId }) => chaId)).toEqual(["group", "legacy", "active"]);
    });

    it("uses the finite legacy fallback only when every chat lacks a dated final message, including an empty or undated loaded chat", () => {
        const character = char("fallback", { lastInteraction: 700 });
        const ref = { chaId: "fallback", chatId: "loaded" };
        install(
            [character],
            [
                {
                    ...summary("fallback", "loaded"),
                    data: {
                        id: "loaded",
                        name: "Loaded",
                        note: "",
                        localLore: [],
                        message: [{ role: "char", data: "dated", chatId: "dated", time: 100 }],
                    },
                },
            ],
        );
        expect(chats.characterLastChattedAt("fallback", 700)).toBe(100);
        chats.appendMessage(ref, { role: "char", data: "undated", chatId: "undated" });
        expect(chats.characterLastChattedAt("fallback", 700)).toBe(700);
        for (const fallback of [undefined, null, "700", Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(chats.characterLastChattedAt("fallback", fallback)).toBe(0);
        }
        chats.removeMessages(ref, ["dated", "undated"]);
        expect(chats.characterLastChattedAt("fallback", 700)).toBe(700);
        chats.appendMessage(ref, { role: "char", data: "epoch", chatId: "zero", time: 0 });
        expect(chats.characterLastChattedAt("fallback", 700)).toBe(0);
    });
});
