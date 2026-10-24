import { flushSync } from "svelte";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreBackedServer } from "./storeBackedServer";

// The chat module's lock readers are reactive (`lockState`): an `$effect` over `isMessageLocked` or
// `isChatGenerating` re-evaluates when a server generation job locks a message and when the job
// releases it. This file is `.svelte.test.ts` so it can use runes the
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
import { characterList } from "../characterStore.svelte";
import { initializeRecords, takeRecordFields } from "../records.svelte";

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
    // The chat module checks a character through the records: installed as `loadData` installs them.
    initializeRecords(takeRecordFields({ characters: read.kinds.characters.map((record) => record.data) }));
    chat.seedChats(read.chats!, read.chatOrders!);
    chat.assembleChats(characterList() as any, read.chats!, read.chatOrders!);
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
    it("re-evaluates an effect over isMessageLocked and isChatGenerating when a server job locks a message and when the job ends", () => {
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

        chat.applyServerGeneration(ref, { jobId: "J", messageId: "a", generationId: "g", text: "", seq: 0 });
        flushSync();
        expect(seen.at(-1)).toBe("a--chat");
        chat.applyServerGeneration(ref, { jobId: "J", messageId: "a", generationId: "g", text: "streamed", seq: 1 });
        flushSync();
        // Text writes do not touch the lock set: no re-evaluation.
        expect(seen).toHaveLength(2);

        // The lock lasts until the job ends.
        expect(chat.isMessageLocked(ref, "a")).toBe(true);
        chat.endServerJob("J");
        flushSync();
        expect(seen.at(-1)).toBe("----");
        expect(seen).toHaveLength(3);
        stop();
    });
});

describe("isMessageStreamed", () => {
    it("is true only once a chunk of this tab's job arrives, re-evaluating once per generation", () => {
        const seen: boolean[] = [];
        const stop = $effect.root(() => {
            $effect(() => {
                seen.push(chat.isMessageStreamed(ref, "a"));
            });
        });
        flushSync();
        // A continue's `accepted` locks the message before any text: not streamed.
        chat.applyServerGeneration(ref, { jobId: "J2", messageId: "a", generationId: "g2", text: "A", seq: 0 });
        flushSync();
        expect(chat.isMessageLocked(ref, "a")).toBe(true);
        expect(seen).toEqual([false, false]);
        chat.applyServerGeneration(ref, { jobId: "J2", messageId: "a", generationId: "g2", text: "A b", seq: 1 });
        flushSync();
        chat.applyServerGeneration(ref, { jobId: "J2", messageId: "a", generationId: "g2", text: "A b c", seq: 2 });
        flushSync();
        expect(seen).toEqual([false, false, true]);
        chat.endServerJob("J2");
        flushSync();
        expect(seen).toEqual([false, false, true, false]);
        stop();
    });

    it("follows the change feed's announced chunk for another tab's generation", () => {
        const announce = (generationId: string, seq: number) =>
            chat.noteRemoteStreaming([
                { characterId: "c", id: "k", streaming: [{ messageId: "b", generationId, seq }] },
            ]);
        announce("f1", 0);
        expect(chat.isMessageLocked(ref, "b")).toBe(true);
        expect(chat.isMessageStreamed(ref, "b")).toBe(false);
        announce("f1", 3);
        expect(chat.isMessageStreamed(ref, "b")).toBe(true);
        // A later announcement of the same generation keeps it; a new generation starts over.
        announce("f1", 0);
        expect(chat.isMessageStreamed(ref, "b")).toBe(true);
        announce("f2", 0);
        expect(chat.isMessageStreamed(ref, "b")).toBe(false);
        chat.replaceFeedLocks([
            {
                characterId: "c",
                id: "k",
                revision: null,
                streaming: [{ messageId: "b", generationId: "f2", seq: 1 }],
            },
        ]);
        expect(chat.isMessageStreamed(ref, "b")).toBe(true);
        chat.noteRemoteStreaming([{ characterId: "c", id: "k", streaming: [] }]);
        expect(chat.isMessageLocked(ref, "b")).toBe(false);
        expect(chat.isMessageStreamed(ref, "b")).toBe(false);
    });
});
