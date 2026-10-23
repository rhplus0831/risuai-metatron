import { describe, expect, it } from "vitest";
import type { AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
import type { ChatListEntry } from "src/ts/storage/chatStore.svelte";
import { collectPinnedChats, HOME_PINNED_CHAT_COLLAPSED_LIMIT } from "./pinnedChats";

const character = (chaId: string): AnyClientCharacter =>
    ({ chaId, name: `Character ${chaId}`, image: `${chaId}.png`, type: "character" }) as AnyClientCharacter;

describe("collectPinnedChats", () => {
    it("excludes a trashed character's pins even when character order includes it, keeping other pins", () => {
        const trashed = { ...character("trashed"), trashTime: 1234 };
        const lists: Record<string, ChatListEntry[]> = {
            trashed: [{ id: "trashed-pin", name: "Trashed pin", pinned: true, fmIndex: -1 }],
            kept: [{ id: "kept-pin", name: "Kept pin", pinned: true, fmIndex: -1 }],
        };

        for (const order of [[], ["trashed", "kept"]]) {
            const result = collectPinnedChats([trashed, character("kept")], order, (id) => lists[id], "Unnamed");
            expect(result.map(({ chaId, chatId }) => ({ chaId, chatId }))).toEqual([
                { chaId: "kept", chatId: "kept-pin" },
            ]);
        }
    });

    it("collects only true pins in character order, expanding folders and appending unordered characters", () => {
        const lists: Record<string, ChatListEntry[]> = {
            a: [{ id: "a1", name: "A one", pinned: true, fmIndex: -1 }],
            b: [
                { id: "b1", name: "B one", pinned: true, fmIndex: -1 },
                { id: "b2", name: "  ", pinned: true, fmIndex: -1 },
                { id: "b3", name: "False", pinned: false, fmIndex: -1 },
                { id: "b4", name: "Absent", fmIndex: -1 },
                { id: "b5", name: "String", pinned: "true" as unknown as boolean, fmIndex: -1 },
            ],
            c: [{ id: "c1", name: "C one", pinned: true, fmIndex: -1 }],
            d: [{ id: "d1", name: "D one", pinned: true, fmIndex: -1 }],
            e: [{ id: "e1", name: "E one", pinned: true, fmIndex: -1 }],
        };
        const chatListOf = (chaId: string) => lists[chaId];
        const result = collectPinnedChats(
            ["a", "b", "c", "d", "e"].map(character),
            ["c", "missing", { data: ["b", "also-missing", "a"] }, "b"],
            chatListOf,
            "Unnamed chat",
        );
        expect(result).toEqual([
            { chaId: "c", chatId: "c1", chatName: "C one", characterName: "Character c", characterImage: "c.png" },
            { chaId: "b", chatId: "b1", chatName: "B one", characterName: "Character b", characterImage: "b.png" },
            {
                chaId: "b",
                chatId: "b2",
                chatName: "Unnamed chat",
                characterName: "Character b",
                characterImage: "b.png",
            },
            { chaId: "a", chatId: "a1", chatName: "A one", characterName: "Character a", characterImage: "a.png" },
            { chaId: "d", chatId: "d1", chatName: "D one", characterName: "Character d", characterImage: "d.png" },
            { chaId: "e", chatId: "e1", chatName: "E one", characterName: "Character e", characterImage: "e.png" },
        ]);
    });

    it("uses a home collapsed limit of six without truncating the collector", () => {
        expect(HOME_PINNED_CHAT_COLLAPSED_LIMIT).toBe(6);
        const chats = Array.from({ length: 7 }, (_, i) => ({
            id: `k${i}`,
            name: `Chat ${i}`,
            pinned: true,
            fmIndex: -1,
        }));
        expect(collectPinnedChats([character("c")], [], () => chats, "Unnamed").map((item) => item.chatId)).toEqual([
            "k0",
            "k1",
            "k2",
            "k3",
            "k4",
            "k5",
            "k6",
        ]);
    });
});
