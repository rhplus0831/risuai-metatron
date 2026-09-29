import { flushSync } from "svelte";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreBackedServer } from "./storeBackedServer";

// The chat module's lock readers are reactive (`lockState`): an `$effect` over `isMessageLocked` or
// `isChatGenerating` re-evaluates when a generation begins, when its final write is acknowledged,
// and when the server stops accepting it. This file is `.svelte.test.ts` so it can use runes the
// way `Chat.svelte` does; the module is imported once (a reset module graph would get its own Svelte
// runtime instance, and the effect would not see the module's state).

vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

import * as chat from "../chatStore.svelte";
import { DBState } from "../../stores.svelte";

const m = (id: string, data: string, role: "user" | "char" = "user") => ({ role, data, chatId: id }) as any;
const ref = { chaId: "c", chatId: "k" };
let server: StoreBackedServer;

function commit() {
    const work = chat.takeChatWork(new Set());
    const result =
        work.groups.length === 0
            ? { chats: [], chatOrders: [] }
            : server.store.applyChanges({
                  chats: work.groups.map(({ characterId, chatId, baseRevision, ops }) => ({
                      characterId,
                      chatId,
                      baseRevision,
                      ops,
                  })),
              });
    chat.ackChatWork(work, result.chats as any, result.chatOrders as any);
    return result;
}

beforeAll(async () => {
    server = await StoreBackedServer.create();
    const characters = server.kind("characters");
    server.store.applyChanges({
        ops: [{ kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
        chats: [
            {
                characterId: "c",
                chatId: "k",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: "k",
                            name: "K",
                            note: "",
                            localLore: [],
                            message: [m("a", "A", "char"), m("b", "B")],
                        } as any,
                    },
                ],
            },
        ],
    });
    const read = server.store.readKinds([characters], { chats: true });
    DBState.db = { characters: read.kinds.characters.map((record) => record.data) } as any;
    chat.seedChats(read.chats!, read.chatOrders!);
    chat.assembleChats(DBState.db.characters as any, read.chats!, read.chatOrders!);
    chat.initializeChats();
});

afterAll(() => {
    server.close();
});

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("reactive lock readers", () => {
    it("re-evaluates an effect over isMessageLocked and isChatGenerating when a generation begins and when its final write is acknowledged", () => {
        const branch = chat.createChat("c", {
            id: "branch",
            name: "Branch",
            note: "",
            localLore: [],
            message: [m("a", "A", "char")],
        } as any);
        const refBranch = { chaId: "c", chatId: branch.id! };
        commit();
        const seen: string[] = [];
        const stop = $effect.root(() => {
            $effect(() => {
                seen.push(
                    [
                        chat.isMessageLocked(ref, "a") ? "a" : "-",
                        chat.isMessageLocked(ref, "b") ? "b" : "-",
                        chat.isMessageLocked(refBranch, "a") ? "branch" : "-",
                        chat.isChatGenerating(ref) ? "chat" : "-",
                    ].join(""),
                );
            });
        });
        flushSync();
        expect(seen).toEqual(["----"]);

        chat.beginGeneration(ref, "a", "g");
        flushSync();
        expect(seen.at(-1)).toBe("a--chat");
        commit();
        chat.setMessageText(ref, "a", "streamed", { generationId: "g" });
        flushSync();
        // Text writes do not touch the lock set: no re-evaluation.
        expect(seen).toHaveLength(2);

        // Ending keeps the lock until the final write is acknowledged.
        chat.endGeneration(ref, "a", "g");
        flushSync();
        expect(seen).toHaveLength(2);
        expect(chat.isMessageLocked(ref, "a")).toBe(true);
        commit();
        flushSync();
        expect(seen.at(-1)).toBe("----");
        expect(seen).toHaveLength(3);
        stop();
    });

    it("re-evaluates when the server stops accepting a generation (another tab took the message over)", () => {
        chat.beginGeneration(ref, "b", "g2");
        commit();
        let lockedId: string | null = null;
        const stop = $effect.root(() => {
            $effect(() => {
                lockedId =
                    chat.findChat(ref)!.message.find((message) => chat.isMessageLocked(ref, message.chatId))?.chatId ??
                    null;
            });
        });
        flushSync();
        expect(lockedId).toBe("b");

        server.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: server.chat("c", "k")!.revision,
                ops: [{ op: "begin", id: "b", generationId: "other" }],
            },
        ]);
        chat.setMessageText(ref, "b", "more", { generationId: "g2" });
        vi.advanceTimersByTime(3000);
        const result = commit();
        expect(result.chats[0].checkpoints).toEqual(["ignored"]);
        flushSync();
        expect(lockedId).toBeNull();
        expect(chat.isChatGenerating(ref)).toBe(false);
        stop();
    });
});
