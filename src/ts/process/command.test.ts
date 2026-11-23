import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreBackedServer } from "../storage/tests/storeBackedServer";

// Slash commands (`command.ts`) over the real chat module and the real server store: every chat
// write goes through the module by id, addressed to the chat captured when the line started, and
// the CBS parser gets that chat too. The server send, the parser, alerts, TTS, lore, and the
// server's manual trigger are stand-ins here (their own tests cover them).

const hooks = vi.hoisted(() => ({
    sends: [] as { index: number; arg: any }[],
    input: null as null | ((prompt: string) => Promise<string>),
    /** The manual triggers handed to the server (every `/trigger`). */
    serverRuns: [] as { char: any; name: string; ref: any }[],
}));

vi.mock("../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertInput: vi.fn((prompt: string) => hooks.input?.(prompt) ?? Promise.resolve("typed")),
        alertSelect: vi.fn(async (labels: string[]) => labels[0]),
    }),
);
vi.mock("./tts", () => ({ sayTTS: vi.fn() }));
// The parser stand-in shows which chat a parse was given: `{{chat}}` becomes that chat's id.
vi.mock("../parser/parser.svelte", () => ({
    risuChatParser: vi.fn((text: string, arg?: { chatRef?: { chatId: string } | null }) =>
        text.replace(/\{\{chat\}\}/g, arg?.chatRef?.chatId ?? "none"),
    ),
}));
// The real sendChat with only the server work stubbed: a test shows that a line generated nothing.
vi.mock("./index.svelte", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./index.svelte")>();
    return {
        ...actual,
        sendChat: vi.fn((index: number, arg: any) => {
            hooks.sends.push({ index, arg });
            return actual.sendChat(index, arg);
        }),
    };
});
vi.mock("./serverGeneration", () => ({
    sendChatOnServer: vi.fn(async () => ({ ok: true, outcome: "started" })),
}));
vi.mock("./lorebook.svelte", () => ({ loadLoreBookV3Prompt: vi.fn(async () => ({ actives: [] })) }));
vi.mock("./modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../globalApi.svelte", async () => (await import("../tests/globalApiMock")).createGlobalApiMock());
vi.mock("./serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock({
        runServerManualTrigger: vi.fn(async (char: any, name: string, ref: any) => {
            hooks.serverRuns.push({ char, name, ref });
            return "started" as const;
        }),
    }),
);

import { processMultiCommand } from "./command";
import { alertConfirm, alertMd } from "../alert";
import * as chat from "../storage/chatStore.svelte";
import { characterList } from "../storage/characterStore.svelte";
import { initializeRecords, takeRecordFields } from "../storage/records.svelte";
import { selectCharacterAt } from "../storage/selection.svelte";
import { settings } from "../storage/settingsViews.svelte";

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
            promptPresetId: "prompt",
            modelPresetId: "model",
            bindedPersona: "persona",
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
    // The characters are records: installed into the records, so the selection (by id) sees them.
    const raw = {
        characters: read.kinds.characters.map((record) => record.data),
        botPresets: [{ id: "prompt", name: "Prompt" }],
        modelPresets: [{ id: "model", name: "Model" }],
        personas: [{ id: "persona", name: "Persona" }],
    };
    initializeRecords(takeRecordFields(raw));
    chat.seedChats(read.chats!, read.chatOrders!);
    chat.assembleChats(characterList(), read.chats!, read.chatOrders!);
    chat.initializeChats();
    selectCharacterAt(0);
});

afterAll(() => {
    server.close();
});

beforeEach(() => {
    hooks.sends.length = 0;
    hooks.input = null;
    chat.releaseFeedLocks();
    hooks.serverRuns.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("/?", () => {
    it("documents every command handled by processCommand in the help dialog and no longer advertises /multisend", async () => {
        const source = readFileSync(resolve(__dirname, "command.ts"), "utf8");
        const commandSource = source.match(/^async function processCommand\b[\s\S]*?^}/m)?.[0];
        expect(commandSource).toBeDefined();
        const commands = Array.from(commandSource!.matchAll(/^\s*case\s+"([^"]+)"\s*:/gm), ([, name]) => name);
        expect(commands.length).toBeGreaterThan(0);

        vi.mocked(alertMd).mockClear();
        expect(await processMultiCommand("/?", freshChat())).toBe("help");
        expect(alertMd).toHaveBeenCalledTimes(1);
        const markdown = vi.mocked(alertMd).mock.calls[0][0];
        const headings = Array.from(markdown.matchAll(/^\s*# \/(\S+)/gm), ([, name]) => name);
        expect(headings).toEqual(expect.arrayContaining(commands));
        expect(headings).not.toContain("multisend");
        expect(markdown).not.toMatch(/multisend/i);
    });
});

it("recognizes the hidden multisend token after an earlier command and leaves its argument unevaluated", async () => {
    const ref = freshChat();
    const { risuChatParser } = await import("../parser/parser.svelte");
    const { alertNormal } = await import("../alert");
    vi.mocked(risuChatParser).mockClear();
    vi.mocked(alertNormal).mockClear();
    expect(await processMultiCommand("/echo before|  multisend {{setvar::x::1}}|/send after", ref)).toBe("");
    expect(vi.mocked(alertNormal).mock.calls).toEqual([
        ["before"],
        [expect.stringMatching(/\/multisend.*removed|removed.*\/multisend/i)],
    ]);
    expect(vi.mocked(risuChatParser).mock.calls.map(([text]) => text)).not.toContainEqual(
        expect.stringContaining("setvar"),
    );
    expect(texts(ref)).toEqual(["A", "B", "C", "D"]);
    expect(await processMultiCommand("/multisendfoo", ref)).toBe(false);
});

describe("/cut and /del", () => {
    it("removes immediately without a retraction question or mark for cut and del under structured memory", async () => {
        const previous = settings.ui.memoryAlgorithmType;
        settings.ui.memoryAlgorithmType = "structuredMemory";
        const auth = await import("../storage/serverAuth");
        const fetch = vi.spyOn(auth, "authFetch").mockResolvedValue(new Response("{}", { status: 503 }));
        vi.mocked(alertConfirm).mockClear();
        try {
            for (const command of ["/cut 1", "/cut 1-3", "/cut c", "/del 2"]) {
                const ref = freshChat();
                expect(await processMultiCommand(command, ref)).toBe("");
                const expected =
                    command === "/cut 1"
                        ? ["b"]
                        : command === "/cut 1-3"
                          ? ["a", "d"]
                          : command === "/cut c"
                            ? ["c"]
                            : ["a", "b"];
                const { work } = commit();
                expect(
                    work.groups.flatMap(({ ops }) => ops).filter(({ op }) => op === "remove"),
                    command,
                ).toEqual([{ op: "remove", ids: expected }]);
                expect(
                    server.chat("c", ref.chatId)!.data.message.every((message) => !expected.includes(message.chatId!)),
                    command,
                ).toBe(true);
            }
            expect(fetch).not.toHaveBeenCalled();
            expect(alertConfirm).not.toHaveBeenCalled();
        } finally {
            settings.ui.memoryAlgorithmType = previous;
        }
    });

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
        // A negative index removes the last message of a fresh chat.
        const negativeRef = freshChat();
        expect(await processMultiCommand("/cut -1")).toBe("");
        expect(texts(negativeRef)).toEqual(["A", "B", "C"]);
        commit();
        expect(server.texts("c", negativeRef.chatId)).toEqual(["A", "B", "C"]);
    });

    it.each(["x-y", "3f1c2b6e-1234-4abc-9def-0123456789ab"])(
        "/cut with unmatched hyphenated id %s removes nothing",
        async (id) => {
            const ref = freshChat();
            expect(await processMultiCommand(`/cut ${id}`, ref)).toBe("");
            expect(texts(ref)).toEqual(["A", "B", "C", "D"]);
            const { work } = commit();
            expect(work.groups).toEqual([]);
            expect(server.texts("c", ref.chatId)).toEqual(["A", "B", "C", "D"]);
        },
    );

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
    it("/sendas appends the whole status-window reply as one character message", async () => {
        const ref = freshChat();
        const reply =
            '<STATUS>[ DATE: 2024.05.01 | TIME: 09:08 | LOC: ROOM 6 | TIME LIMIT: 35:59:00 ]\n"Wait," she said. "Go."';

        expect(await processMultiCommand(`/sendas ${reply}`, ref)).not.toBe(false);
        expect(
            chat
                .findChat(ref)!
                .message.slice(4)
                .map(({ role, data }) => ({ role, data })),
        ).toEqual([{ role: "char", data: reply }]);
    });

    it("/send and /comment preserve literal text and trim only its edges", async () => {
        const ref = freshChat();
        const literal = '"Wait,"  she said. hp=10 | ready\n  "Go."';

        expect(await processMultiCommand(`/send\n  ${literal} \n`, ref)).not.toBe(false);
        expect(await processMultiCommand(`/comment \n  ${literal} \n`, ref)).not.toBe(false);
        expect(
            chat
                .findChat(ref)!
                .message.slice(4)
                .map(({ role, data }) => ({ role, data })),
        ).toEqual([{ role: "user", data: `${literal}<Comment>\n${literal}\n</Comment>` }]);
    });

    it("text commands after a pipe take the remaining text and substitute the piped value", async () => {
        const ref = freshChat();

        expect(await processMultiCommand("/pass piped words | /sendas", ref)).not.toBe(false);
        expect(await processMultiCommand("/pass x | /sendas a | b", ref)).not.toBe(false);
        expect(
            await processMultiCommand("/pass piped words | /sendas\n{{pipe}} / {{pipe}} / {{slot}} / {{slot}}", ref),
        ).not.toBe(false);
        expect(await processMultiCommand("/sendasSuffix ignored", ref)).toBe(false);
        expect(
            chat
                .findChat(ref)!
                .message.slice(4)
                .map(({ role, data }) => ({ role, data })),
        ).toEqual([
            { role: "char", data: "piped words" },
            { role: "char", data: "a | b" },
            { role: "char", data: "piped words / {{pipe}} / piped words / {{slot}}" },
        ]);
    });

    it("other commands still split pipes outside quotes, unquote arguments, and read named arguments", async () => {
        const ref = freshChat();

        expect(await processMultiCommand('/pass "a | b" | /setvar key=note {{pipe}} | /getvar key=note', ref)).toBe(
            "a | b",
        );
        expect(chat.findChat(ref)!.scriptstate).toEqual({ $note: "a | b" });
    });

    it("preserves inner and unmatched quotes in arguments and surrounding quotes in piped values", async () => {
        const ref = freshChat();
        expect(await processMultiCommand('/pass say "hi" now', ref)).toBe('say "hi" now');
        expect(await processMultiCommand('/pass "starts here', ref)).toBe('"starts here');
        expect(await processMultiCommand('/pass ends here"', ref)).toBe('ends here"');
        hooks.input = async () => '"quoted value"';
        expect(await processMultiCommand("/input Value? | /pass {{pipe}}", ref)).toBe('"quoted value"');
        expect(await processMultiCommand("/input Value? | /pass {{slot}}", ref)).toBe('"quoted value"');
    });

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

    it("/getvar of a missing variable answers null without writing; /setvar and /addvar merge the one variable into the chat's scriptstate", async () => {
        const ref = freshChat();
        expect(await processMultiCommand("/getvar key=missing")).toBe("null");
        expect(chat.hasChatWork()).toBe(false);
        expect((chat.findChat(ref) as any).scriptstate).toBeUndefined();
        // Another tab sets `$other` meanwhile: a whole-map write from this tab's copy would drop it.
        server.chatBatch([
            {
                characterId: "c",
                chatId: ref.chatId,
                baseRevision: server.chat("c", ref.chatId)!.revision,
                ops: [{ op: "meta", merge: { scriptstate: { $other: "kept" } } }],
            },
        ]);
        expect(await processMultiCommand("/setvar key=hp 5 | /getvar key=hp")).toBe("5");
        expect(await processMultiCommand("/addvar key=hp 3 | /getvar key=hp")).toBe("8");
        expect((chat.findChat(ref) as any).scriptstate).toEqual({ $hp: "8" });
        const { work } = commit();
        // The two merges of `$hp` folded into one (set and unset appear once a merge coalesces).
        expect(work.groups[0].ops).toEqual([{ op: "meta", set: {}, unset: [], merge: { scriptstate: { $hp: "8" } } }]);
        expect((server.chat("c", ref.chatId)!.data as any).scriptstate).toEqual({ $other: "kept", $hp: "8" });
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
            // Another tab deletes the chat for good; its chat list arrives.
            server.deleteChatForever("c", refK.chatId);
            chat.acceptRemoteCollection(server.store.readRefs([], { chatCollections: ["c"] }).chatCollections[0]);
            return "typed";
        };
        expect(await processMultiCommand("/input question | /send after the wait")).toBe("");
        expect(chat.findChat(refK)).toBeUndefined();
        expect(chat.chatList("c").map((entry) => entry.id)).not.toContain(refK.chatId);
        expect(texts(refJ)).toEqual(["A", "B", "C", "D"]);
        expect(chat.currentChatRef()).not.toBeNull();
        expect(hooks.sends).toEqual([]);
        // The line left nothing to send, and the server holds no chat under the id.
        expect(chat.takeChatWork(new Set())).toEqual({ groups: [], orders: [] });
        expect(server.chat("c", refK.chatId)).toBeNull();
        expect(server.texts("c", refJ.chatId)).toEqual(["A", "B", "C", "D"]);
    });

    it("/trigger runs the manual trigger on the server for the line's chat and writes nothing in the tab", async () => {
        const ref = freshChat();
        expect(await processMultiCommand("/trigger greet")).toBeUndefined();
        expect(hooks.serverRuns).toEqual([{ char: expect.objectContaining({ chaId: "c" }), name: "greet", ref }]);
        expect(texts(ref)).toEqual(["A", "B", "C", "D"]);
        expect(commit().work.groups).toEqual([]);
    });
});

describe("/trigger on the server", () => {
    it("runs on the server with the CBS'd name, and answers undefined", async () => {
        const ref = freshChat();
        expect(await processMultiCommand("/trigger {{chat}} greet")).toBeUndefined();
        expect(hooks.serverRuns).toEqual([
            { char: expect.objectContaining({ chaId: "c" }), name: `${ref.chatId} greet`, ref },
        ]);
        expect(texts(ref)).toEqual(["A", "B", "C", "D"]);
        expect(commit().work.groups).toEqual([]);
    });

    it("runs on the server for a line given its chat and for a line on the selected chat alike (there is no browser path)", async () => {
        const ref = freshChat();
        await processMultiCommand("/trigger greet", ref);
        await processMultiCommand("/trigger greet");
        expect(hooks.serverRuns).toEqual([
            { char: expect.objectContaining({ chaId: "c" }), name: "greet", ref },
            { char: expect.objectContaining({ chaId: "c" }), name: "greet", ref },
        ]);
        expect(texts(ref)).toEqual(["A", "B", "C", "D"]);
        expect(commit().work.groups).toEqual([]);
    });
});
