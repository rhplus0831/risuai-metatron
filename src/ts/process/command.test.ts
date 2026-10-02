import { get, writable } from "svelte/store";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreBackedServer } from "../storage/tests/storeBackedServer";

// Slash commands (`command.ts`) over the real chat module and the real server store: every chat
// write goes through the module by id, addressed to the chat captured when the line started, and
// the CBS parser gets that chat too. The send pipeline, the parser, alerts, TTS, lore, and triggers
// are stand-ins here (their own tests cover them).

const hooks = vi.hoisted(() => ({
    sends: [] as { index: number; arg: any }[],
    sendResult: [] as boolean[],
    input: null as null | ((prompt: string) => Promise<string>),
    trigger: null as null | ((char: any, mode: string, arg: any) => Promise<any>),
    /** The client flag `risu.serverGeneration` and the manual triggers handed to the server (slice 8b). */
    serverFlag: false,
    serverRuns: [] as { char: any; name: string; ref: any }[],
}));

vi.mock("../storage/database.svelte", async () => {
    const stores = await vi.importActual<typeof import("../stores.svelte")>("../stores.svelte");
    return { getDatabase: () => stores.DBState.db };
});
vi.mock("../alert", () => ({
    alertInput: vi.fn((prompt: string) => hooks.input?.(prompt) ?? Promise.resolve("typed")),
    alertMd: vi.fn(),
    alertNormal: vi.fn(),
    alertSelect: vi.fn(async (labels: string[]) => labels[0]),
}));
vi.mock("./tts", () => ({ sayTTS: vi.fn() }));
// The parser stand-in shows which chat a parse was given: `{{chat}}` becomes that chat's id.
vi.mock("../parser/parser.svelte", () => ({
    risuChatParser: vi.fn((text: string, arg?: { chatRef?: { chatId: string } | null }) =>
        text.replace(/\{\{chat\}\}/g, arg?.chatRef?.chatId ?? "none"),
    ),
}));
vi.mock("./index.svelte", async () => {
    const { writable } = await vi.importActual<typeof import("svelte/store")>("svelte/store");
    return {
        doingChat: writable(false),
        sendChat: vi.fn(async (index: number, arg: any) => {
            hooks.sends.push({ index, arg });
            return hooks.sendResult.shift() ?? true;
        }),
    };
});
vi.mock("./lorebook.svelte", () => ({ loadLoreBookV3Prompt: vi.fn(async () => ({ actives: [] })) }));
vi.mock("./triggers", () => ({
    runTrigger: vi.fn((char: any, mode: string, arg: any) => hooks.trigger?.(char, mode, arg) ?? Promise.resolve(null)),
}));
vi.mock("./modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("./serverCommands", () => ({
    runServerManualTrigger: vi.fn(async (char: any, name: string, ref: any) => {
        hooks.serverRuns.push({ char, name, ref });
        return "started";
    }),
}));
vi.mock("../storage/clientFlags", () => ({ readClientFlag: vi.fn(() => hooks.serverFlag) }));

import { processMultiCommand } from "./command";
import { doingChat, sendChat } from "./index.svelte";
import { runTrigger } from "./triggers";
import * as chat from "../storage/chatStore.svelte";
import { DBState, selectedCharID } from "../stores.svelte";

const m = (id: string, data: string, role: "user" | "char" = "user") => ({ role, data, chatId: id }) as any;
const texts = (ref: chat.ChatRef) => chat.findChat(ref)!.message.map((message) => message.data);
const ids = (ref: chat.ChatRef) => chat.findChat(ref)!.message.map((message) => message.chatId);

let server: StoreBackedServer;
let chatNumber = 0;

/** One save cycle by hand (take, apply on the server, acknowledge). */
function commit() {
    const work = chat.takeChatWork(new Set());
    const result =
        work.groups.length + work.orders.length === 0
            ? { chats: [], chatOrders: [] }
            : server.store.applyChanges({
                  chats: work.groups.map(({ characterId, chatId, baseRevision, ops }) => ({
                      characterId,
                      chatId,
                      baseRevision,
                      ops,
                  })),
                  chatOrders: work.orders.map(({ characterId, baseRevision, ids }) => ({
                      characterId,
                      baseRevision,
                      ids,
                  })),
              });
    chat.ackChatWork(work, result.chats as any, result.chatOrders as any);
    return { work, result };
}

/** A fresh chat of character `c` with messages a, b, c, d, saved and selected. */
function freshChat(): chat.ChatRef {
    chatNumber += 1;
    const created = chat.createChat(
        "c",
        {
            id: `chat${chatNumber}`,
            name: `Chat ${chatNumber}`,
            note: "",
            localLore: [],
            message: [m("a", "A", "char"), m("b", "B"), m("c", "C", "char"), m("d", "D")],
        } as any,
        { select: true },
    );
    commit();
    return { chaId: "c", chatId: created.id! };
}

beforeAll(async () => {
    server = await StoreBackedServer.create();
    const characters = server.kind("characters");
    server.store.applyChanges({
        ops: [{ kind: characters, id: "c", baseRevision: null, data: { chaId: "c", name: "C", type: "character" } }],
        chats: [
            {
                characterId: "c",
                chatId: "first",
                baseRevision: null,
                ops: [
                    { op: "create", chat: { id: "first", name: "First", note: "", localLore: [], message: [] } as any },
                ],
            },
        ],
    });
    const read = server.store.readKinds([characters], { chats: true });
    DBState.db = { characters: read.kinds.characters.map((record) => record.data) } as any;
    chat.seedChats(read.chats!, read.chatOrders!);
    chat.assembleChats(DBState.db.characters as any, read.chats!, read.chatOrders!);
    chat.initializeChats();
    selectedCharID.set(0);
});

afterAll(() => {
    server.close();
});

beforeEach(() => {
    hooks.sends.length = 0;
    hooks.sendResult.length = 0;
    hooks.input = null;
    hooks.trigger = null;
    hooks.serverFlag = false;
    hooks.serverRuns.length = 0;
    doingChat.set(false);
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("/cut and /del", () => {
    it("/cut with one index removes that message by id (it used to assign the spliced-out message as the whole list)", async () => {
        const ref = freshChat();
        expect(await processMultiCommand("/cut 1")).toBe("");
        expect(texts(ref)).toEqual(["A", "C", "D"]);
        expect(await processMultiCommand("/cut 2")).toBe("");
        expect(texts(ref)).toEqual(["A", "C"]);
        expect(await processMultiCommand("/cut 7")).toBe("");
        expect(texts(ref)).toEqual(["A", "C"]);
        const { work } = commit();
        expect(work.groups[0].ops).toEqual([
            { op: "remove", ids: ["b"] },
            { op: "remove", ids: ["d"] },
        ]);
        expect(server.texts("c", ref.chatId)).toEqual(["A", "C"]);
        // A negative number is a range with an empty start (as before): `/cut -1` keeps the first message.
        expect(await processMultiCommand("/cut -1")).toBe("");
        expect(texts(ref)).toEqual(["A"]);
    });

    it("/cut with a range keeps the messages of the range (as a slice does) and removes the rest", async () => {
        const ref = freshChat();
        expect(await processMultiCommand("/cut 1-3")).toBe("");
        expect(texts(ref)).toEqual(["B", "C"]);
        expect(ids(ref)).toEqual(["b", "c"]);
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["B", "C"]);
    });

    it("/cut with a message id removes that message", async () => {
        const ref = freshChat();
        expect(await processMultiCommand("/cut c")).toBe("");
        expect(ids(ref)).toEqual(["a", "b", "d"]);
        commit();
        expect(server.texts("c", ref.chatId)).toEqual(["A", "B", "D"]);
    });

    it("/del keeps the last N messages", async () => {
        const ref = freshChat();
        expect(await processMultiCommand("/del 2")).toBe("");
        expect(texts(ref)).toEqual(["C", "D"]);
        const { work } = commit();
        expect(work.groups[0].ops).toEqual([{ op: "remove", ids: ["a", "b"] }]);
        expect(server.texts("c", ref.chatId)).toEqual(["C", "D"]);
        expect(await processMultiCommand("/del x")).toBe("");
        expect(texts(ref)).toEqual(["C", "D"]);
        expect(await processMultiCommand("/del 0")).toBe("");
        expect(texts(ref)).toEqual([]);
        commit();
        expect(server.texts("c", ref.chatId)).toEqual([]);
    });
});

describe("messages and variables", () => {
    it("/send, /sendas, and /comment write through the module", async () => {
        const ref = freshChat();
        expect(await processMultiCommand("/send hello there")).toBe("");
        expect(await processMultiCommand("/sendas as the character")).toBe("");
        expect(await processMultiCommand("/comment a remark")).toBe("");
        const messages = chat.findChat(ref)!.message;
        expect(messages.slice(4).map((message) => [message.role, message.data])).toEqual([
            ["user", "hello there"],
            ["char", "as the character<Comment>\na remark\n</Comment>"],
        ]);
        commit();
        expect(server.texts("c", ref.chatId).slice(4)).toEqual([
            "hello there",
            "as the character<Comment>\na remark\n</Comment>",
        ]);
    });

    it("/getvar of a missing variable answers null without writing; /setvar and /addvar write the chat's scriptstate", async () => {
        const ref = freshChat();
        expect(await processMultiCommand("/getvar key=missing")).toBe("null");
        expect(chat.hasChatWork()).toBe(false);
        expect((chat.findChat(ref) as any).scriptstate).toBeUndefined();
        expect(await processMultiCommand("/setvar key=hp 5 | /getvar key=hp")).toBe("5");
        expect(await processMultiCommand("/addvar key=hp 3 | /getvar key=hp")).toBe("8");
        expect((chat.findChat(ref) as any).scriptstate).toEqual({ $hp: "8" });
        const { work } = commit();
        expect(work.groups[0].ops).toEqual([{ op: "meta", set: { scriptstate: { $hp: "8" } }, unset: [] }]);
        expect((server.chat("c", ref.chatId)!.data as any).scriptstate).toEqual({ $hp: "8" });
    });

    it("an unknown command is not a command (the line is sent as text)", async () => {
        freshChat();
        expect(await processMultiCommand("/nosuchcommand x")).toBe(false);
    });
});

describe("the chat a line started in", () => {
    it("keeps writing the chat captured at the start, with its CBS, when the selection moves while a command waits", async () => {
        const refK = freshChat();
        const refJ = freshChat();
        chat.selectChat("c", refK.chatId);
        hooks.input = async () => {
            chat.selectChat("c", refJ.chatId);
            return "typed";
        };
        expect(await processMultiCommand("/input question | /setvar key=v {{chat}} | /send in {{chat}}")).toBe("");
        expect(chat.currentChatRef()).toEqual(refJ);
        expect((chat.findChat(refK) as any).scriptstate).toEqual({ $v: refK.chatId });
        expect(texts(refK).at(-1)).toBe(`in ${refK.chatId}`);
        expect((chat.findChat(refJ) as any).scriptstate).toBeUndefined();
        expect(texts(refJ)).toEqual(["A", "B", "C", "D"]);
    });

    it("consumes the line without writing anything when its chat goes away while a command waits", async () => {
        const refK = freshChat();
        const refJ = freshChat();
        chat.selectChat("c", refK.chatId);
        hooks.input = async () => {
            chat.deleteChat(refK);
            return "typed";
        };
        expect(await processMultiCommand("/input question | /send after the wait")).toBe("");
        expect(chat.findChat(refK)).toBeUndefined();
        expect(texts(refJ)).toEqual(["A", "B", "C", "D"]);
        expect(chat.currentChatRef()).not.toBeNull();
    });

    it("/trigger runs the manual trigger on the line's chat and applies its result as a diff", async () => {
        const ref = freshChat();
        hooks.trigger = async (_char, _mode, arg) => ({
            chat: { ...arg.chat, message: [...arg.chat.message, m("t", "from the trigger", "char")] },
        });
        expect(await processMultiCommand("/trigger greet")).toBeUndefined();
        expect(runTrigger).toHaveBeenCalledWith(
            expect.objectContaining({ chaId: "c" }),
            "manual",
            expect.objectContaining({ chatRef: ref, manualName: "greet" }),
        );
        expect(texts(ref).at(-1)).toBe("from the trigger");
        const { work } = commit();
        expect(work.groups[0].ops).toEqual([
            { op: "append", messages: [m("t", "from the trigger", "char")], anchor: { after: "d" } },
        ]);
    });
});

describe("/trigger on the server (Phase 5 slice 8b)", () => {
    it("runs on the server only for a line typed in the chat input with `risu.serverGeneration` on, with the CBS'd name, and answers undefined", async () => {
        const ref = freshChat();
        vi.mocked(runTrigger).mockClear();
        hooks.serverFlag = true;
        expect(await processMultiCommand("/trigger {{chat}} greet", undefined, { fromInput: true })).toBeUndefined();
        expect(hooks.serverRuns).toEqual([
            { char: expect.objectContaining({ chaId: "c" }), name: `${ref.chatId} greet`, ref },
        ]);
        expect(runTrigger).not.toHaveBeenCalled();
        expect(texts(ref)).toEqual(["A", "B", "C", "D"]);
        expect(commit().work.groups).toEqual([]);
    });

    it("stays in the browser without the flag, and for a trigger's own command line (no `fromInput`) even with it", async () => {
        const ref = freshChat();
        vi.mocked(runTrigger).mockClear();
        await processMultiCommand("/trigger greet", undefined, { fromInput: true });
        hooks.serverFlag = true;
        await processMultiCommand("/trigger greet", ref);
        await processMultiCommand("/trigger greet");
        expect(hooks.serverRuns).toEqual([]);
        expect(runTrigger).toHaveBeenCalledTimes(3);
        expect(runTrigger).toHaveBeenLastCalledWith(
            expect.objectContaining({ chaId: "c" }),
            "manual",
            expect.objectContaining({ chatRef: ref, manualName: "greet" }),
        );
    });
});

describe("/multisend", () => {
    it("refuses to start while a send is running", async () => {
        const ref = freshChat();
        doingChat.set(true);
        expect(await processMultiCommand('/multisend "one|||two"')).toBe("");
        expect(sendChat).not.toHaveBeenCalled();
        expect(texts(ref)).toEqual(["A", "B", "C", "D"]);
        expect(get(doingChat)).toBe(true);
    });

    it("sends every segment to the line's chat, clears the busy flag after each, and stops at a failed send", async () => {
        const ref = freshChat();
        // Quoted: `|` outside quotes separates commands (the quotes stay part of the segments).
        expect(await processMultiCommand('/multisend "one|||two"')).toBe("");
        expect(hooks.sends).toEqual([
            { index: -1, arg: { target: ref } },
            { index: -1, arg: { target: ref } },
        ]);
        expect(texts(ref).slice(4)).toEqual(['"one', 'two"']);
        expect(get(doingChat)).toBe(false);

        hooks.sends.length = 0;
        hooks.sendResult.push(true, false);
        expect(await processMultiCommand('/multisend "three|||four|||five"')).toBe("");
        expect(hooks.sends).toHaveLength(2);
        expect(texts(ref).slice(6)).toEqual(['"three', "four"]);
        expect(get(doingChat)).toBe(false);
    });
});
