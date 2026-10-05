import { beforeEach, describe, expect, it, vi } from "vitest";

// Cold storage was removed without a migration. `setDatabase` is the single
// normalization point for every decoded or imported save, so it is where the
// leftovers of old saves are dropped: the root `coldstorage` flag and the
// orphaned `pluginCustomStorage._coldplugin` key -> uuid map, whose values are
// unreachable now. Everything else in `pluginCustomStorage`, including the v3
// `_pluginStorage` sub-object and the top-level entries written through the
// plugin `setDatabase`/`setDatabaseLite` APIs, must survive.

vi.mock("../globalApi.svelte", () => ({
    downloadFile: vi.fn(),
    saveAsset: vi.fn(),
}));

vi.mock("../alert", () => ({
    alertNormal: vi.fn(),
}));

// `stores.svelte` runs a module-level effect that calls `moduleUpdate`, which
// reaches back into `database.svelte` while it is still being evaluated, and the
// real parser module's effect reads `selIdState` before the circular
// stores <-> parser import has settled. Neither is exercised by `setDatabase`.
vi.mock("../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));

vi.mock("../parser/parser.svelte", () => ({
    risuChatParser: vi.fn((text: string) => text),
}));

import { setDatabase, type Database } from "./database.svelte";
import { DBState } from "../stores.svelte";
import { assembleChats, seedChats } from "./chatStore.svelte";

function legacySave(extra: Record<string, unknown>): Database {
    return {
        characters: [],
        ...extra,
    } as unknown as Database;
}

describe("setDatabase after cold storage removal", () => {
    beforeEach(() => {
        DBState.db = {} as Database;
    });

    it("drops the legacy coldstorage flag instead of defaulting it", () => {
        setDatabase(legacySave({ coldstorage: true }));

        expect("coldstorage" in (DBState.db as object)).toBe(false);
        expect(DBState.db.characters).toEqual([]);
    });

    it("does not reintroduce coldstorage on a save that never had it", () => {
        setDatabase(legacySave({}));

        expect("coldstorage" in (DBState.db as object)).toBe(false);
    });

    it("removes pluginCustomStorage._coldplugin and keeps every other entry", () => {
        setDatabase(
            legacySave({
                coldstorage: false,
                pluginCustomStorage: {
                    _coldplugin: { counter: "11111111-1111-1111-1111-111111111111" },
                    _pluginStorage: { counter: 5 },
                    legacySetting: "kept",
                },
            }),
        );

        expect(DBState.db.pluginCustomStorage).toEqual({
            _pluginStorage: { counter: 5 },
            legacySetting: "kept",
        });
    });

    it("tolerates a save without pluginCustomStorage", () => {
        expect(() => setDatabase(legacySave({ pluginCustomStorage: undefined }))).not.toThrow();
        expect(DBState.db.pluginCustomStorage?._coldplugin).toBeUndefined();
    });

    it("leaves stale per-character cold pointers alone; they load as ordinary data", () => {
        // Old saves may still hold a skeleton character with a stale `coldstorage`
        // field and a chat whose only message is a cold pointer. No migration reads
        // them anymore, and setDatabase must not choke on them.
        const pointer = "COLDSTORAGE" + "22222222-2222-2222-2222-222222222222";
        const characters = [
            {
                type: "character",
                name: "stub",
                chaId: "stub-id",
                chatPage: 0,
                coldstorage: "33333333-3333-3333-3333-333333333333",
                coldStoragedChats: ["22222222-2222-2222-2222-222222222222"],
                chats: [{ message: [{ role: "char", data: pointer, time: 1 }], note: "", name: "", localLore: [] }],
            },
        ];
        // Phase 6 slice 9a: the character records hold no chats; the chat module holds them, the way
        // boot assembles them (a chat record always carries its chat's id).
        const chats = characters[0].chats.map((chat, index) => ({
            characterId: "stub-id",
            id: `chat-${index}`,
            revision: "r1",
            data: { ...chat, id: `chat-${index}` } as any,
        }));
        const orders = [{ characterId: "stub-id", revision: "o1", ids: chats.map((record) => record.id) }];
        setDatabase(legacySave({ characters }));
        seedChats(chats, orders);
        assembleChats(DBState.db.characters, chats, orders);

        const char = DBState.db.characters[0] as any;
        expect(char.chats[0].message[0].data).toBe(pointer);
        // The streaming flags are client-only state of the chat module (`streamingState`) since
        // Phase 2; `setDatabase` no longer writes them into chats.
        expect(char.chats[0]).not.toHaveProperty("isStreaming");
    });
});
