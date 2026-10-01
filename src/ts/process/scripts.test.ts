import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

// The client wrapper of the shared regex engine (Phase 5 slice 3): `processScriptFull` with the real
// evaluator, the real chat module, and the live database, so a script effect (`@@inject`, `@@emo`)
// lands where its script matched and the later scripts' CBS reads what it wrote. The engine itself
// is covered by `server/src/tests/regex.test.ts`.

const holder = vi.hoisted(() => ({
    dbState: { db: {} as any },
    selectedCharID: null as unknown as import("svelte/store").Writable<number>,
    charEmotion: null as unknown as import("svelte/store").Writable<Record<string, [string, string, number][]>>,
}));

vi.mock(import("../stores.svelte"), async () => {
    const { writable } = await vi.importActual<typeof import("svelte/store")>("svelte/store");
    holder.selectedCharID = writable(0);
    holder.charEmotion = writable({});
    return {
        DBState: holder.dbState,
        selIdState: { selId: 0 },
        selectedCharID: holder.selectedCharID,
        CurrentTriggerIdStore: writable(null),
        CharEmotion: holder.charEmotion,
    } as unknown as typeof import("../stores.svelte");
});

vi.mock(import("../storage/database.svelte"), async () => {
    const { get } = await vi.importActual<typeof import("svelte/store")>("svelte/store");
    const current = () => holder.dbState.db.characters?.[get(holder.selectedCharID)];
    return {
        appVer: "1234.5.67",
        getDatabase: () => holder.dbState.db,
        getCurrentCharacter: () => current(),
        getCurrentChat: () => current()?.chats?.[current().chatPage],
    } as unknown as typeof import("../storage/database.svelte");
});

vi.mock(import("../globalApi.svelte"), () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: () => Promise.resolve(""),
    downloadFile: vi.fn(),
    saveAsset: vi.fn(),
}));

vi.mock(import("../alert"), () => ({
    alertError: vi.fn(),
    alertNormal: vi.fn(),
}));

vi.mock(import("./modules"), () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleRegexScripts: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
    getModuleTriggers: vi.fn(() => []),
}));

// The Lua edit hook and the display trigger are the orchestration around the engine, not under test.
vi.mock(
    import("./scriptings"),
    () =>
        ({
            runLuaEditTrigger: vi.fn(async (_char: unknown, _mode: string, data: unknown) => data),
        }) as unknown as typeof import("./scriptings"),
);
vi.mock(import("./triggers"), () => ({
    runTrigger: vi.fn(async () => null),
}));

import type { character, customscript } from "../storage/database.svelte";
import { beginGeneration, endGeneration, findChat, setMessageText } from "../storage/chatStore.svelte";
import { CharEmotion, DBState, selectedCharID } from "../stores.svelte";
import { processScriptFull, resetScriptCache } from "./scripts";

const ref = { chaId: "char-a", chatId: "chat-a" };
const context = { chatRef: ref, presetId: "", personaId: "" };

const script = (fields: Partial<customscript>): customscript => ({
    comment: "",
    in: "",
    out: "",
    type: "editoutput",
    ...fields,
});

function liveDatabase(characterFields: Partial<character> = {}): any {
    return {
        username: "User",
        language: "en",
        personas: [{ id: "p", name: "User", personaPrompt: "", icon: "", note: "", largePortrait: false }],
        selectedPersona: 0,
        globalChatVariables: {},
        templateDefaultVariables: "",
        enabledModules: [],
        modules: [],
        presetRegex: [],
        dynamicAssets: false,
        characters: [
            {
                type: "character",
                chaId: "char-a",
                name: "Alpha",
                firstMessage: "greet world",
                alternateGreetings: [],
                defaultVariables: "",
                chatPage: 0,
                customscript: [],
                emotionImages: [
                    ["happy", "happy.png"],
                    ["sad", "sad.png"],
                ],
                chats: [
                    {
                        id: "chat-a",
                        name: "A",
                        note: "",
                        localLore: [],
                        fmIndex: -1,
                        scriptstate: {},
                        message: [{ chatId: "m0", role: "char", data: "OLD" }],
                    },
                ],
                ...characterFields,
            },
        ],
    };
}

const character = () => DBState.db.characters[0] as character;
/** The character for test setup writes into the chat mirror (read-only to the app outside the chat module). */
const setup = () => DBState.db.characters[0] as any;
const stored = (id = "m0", at = ref) => findChat(at)!.message.find((message) => message.chatId === id)!.data;
const emotions = () => (get(CharEmotion)["char-a"] ?? []).map((entry) => entry[0]);

/** `processScriptFull` for the character's scripts over `data`, in `editoutput` for message `chatID`. */
async function process(
    data: string,
    scripts: customscript[],
    chatID = 0,
    mode: "editoutput" | "editinput" = "editoutput",
    at = ref,
) {
    character().customscript = scripts;
    return processScriptFull(character(), data, mode, chatID, {}, at, { ...context, chatRef: at });
}

beforeEach(() => {
    DBState.db = liveDatabase();
    selectedCharID.set(0);
    CharEmotion.set({});
    resetScriptCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("@@inject", () => {
    const scripts = [
        script({ in: "X", out: "@@inject" }),
        script({ in: "Y", out: "{{lastmessage}}" }),
        script({ in: "{{lastmessage}}", out: "[seen:$&]", ableFlag: true, flag: "g<cbs>" }),
    ];

    it("writes the message where its script matched: the later scripts' CBS and <cbs> patterns read it", async () => {
        const result = await process("XY", scripts);
        expect(result).toEqual({ data: "[seen:XY]", emoChanged: false });
        expect(stored()).toBe("XY");
    });

    it("the cache key expands <cbs> patterns before the run: a changed chat is a miss, an unchanged one a hit", async () => {
        const withEmotion = [script({ in: "A", out: "@@emo happy" }), ...scripts];
        expect((await process("AXY", withEmotion)).data).toBe("A[seen:AXY]");
        expect(stored()).toBe("AXY");
        expect(emotions()).toEqual(["happy"]);
        // The first key expanded `{{lastmessage}}` to `OLD`; the chat now says `AXY`: a miss, run again.
        expect((await process("AXY", withEmotion)).data).toBe("A[seen:AXY]");
        expect(emotions()).toEqual(["happy", "happy"]);
        // The chat is unchanged since: the same key, a hit, no effect.
        expect((await process("AXY", withEmotion)).data).toBe("A[seen:AXY]");
        expect(emotions()).toEqual(["happy", "happy"]);
    });

    it("quirk: a cache hit returns the first run's text and applies no effect", async () => {
        const plain = [
            script({ in: "A", out: "@@emo happy" }),
            script({ in: "X", out: "@@inject" }),
            script({ in: "Y", out: "{{lastmessage}}" }),
        ];
        expect(await process("AXY", plain)).toEqual({ data: "AAXY", emoChanged: true });
        expect(stored()).toBe("AXY");
        expect(emotions()).toEqual(["happy"]);

        setMessageText(ref, "m0", "OLD");
        expect(await process("AXY", plain)).toEqual({ data: "AAXY", emoChanged: false });
        expect(stored()).toBe("OLD");
        expect(emotions()).toEqual(["happy"]);
    });

    it("removes the match but writes nothing when the message index has no message", async () => {
        const result = await process("XY", scripts.slice(0, 2), 5);
        expect(result.data).toBe("OLD");
        expect(stored()).toBe("OLD");
    });

    it("quirk: without a message index the directive text replaces the match and nothing is written", async () => {
        const result = await process("XY", scripts.slice(0, 2), -1);
        expect(result.data).toBe("@@injectOLD");
        expect(stored()).toBe("OLD");
    });

    it("a rejected write (the message is being generated) is skipped: the match is removed, later CBS reads the unchanged chat", async () => {
        // The lock outlives `endGeneration` (until the final write is acknowledged): its own chat id.
        const lockedRef = { chaId: "char-a", chatId: "chat-locked" };
        setup().chats[0].id = "chat-locked";
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        beginGeneration(lockedRef, "m0", "gen");
        try {
            const result = await process("XY", scripts.slice(0, 2), 0, "editoutput", lockedRef);
            expect(result.data).toBe("OLD");
            expect(stored("m0", lockedRef)).toBe("OLD");
            expect(console.warn).toHaveBeenCalledWith(
                "[Script] @@inject skipped a message being generated",
                expect.any(Error),
            );
        } finally {
            endGeneration(lockedRef, "m0", "gen");
        }
    });
});

describe("@@emo", () => {
    it("records interleaved emotions and injections in script order", async () => {
        const scripts = [
            script({ in: "A", out: "@@emo happy" }),
            script({ in: "B", out: "@@inject" }),
            script({ in: "C", out: "@@emo sad" }),
            script({ in: "D", out: "{{lastmessage}}" }),
        ];
        const result = await process("ABCD", scripts);
        expect(result).toEqual({ data: "ACABCD", emoChanged: true });
        expect(stored()).toBe("ABCD");
        expect(emotions()).toEqual(["happy", "sad"]);
        expect(get(CharEmotion)["char-a"][0][1]).toBe("happy.png");
    });

    it("ignores an emotion the character does not have", async () => {
        const result = await process("A", [script({ in: "A", out: "@@emo angry" })]);
        expect(result).toEqual({ data: "A", emoChanged: false });
        expect(emotions()).toEqual([]);
    });

    it("a failing effect skips its script only; the later scripts still run", async () => {
        DBState.db = liveDatabase({ emotionImages: undefined });
        const scripts = [script({ in: "A", out: "@@emo happy" }), script({ in: "B", out: "b!" })];
        const result = await process("AB", scripts);
        expect(result).toEqual({ data: "Ab!", emoChanged: false });
        expect(console.error).toHaveBeenCalledTimes(1);
    });
});

describe("@@repeat_back through the client's lookup", () => {
    it("reads the previous message of the same role, or the greeting when there is none", async () => {
        setup().chats[0].message = [
            { chatId: "m0", role: "user", data: "hello world" },
            { chatId: "m1", role: "char", data: "x" },
            { chatId: "m2", role: "user", data: "say" },
        ];
        const scripts = [script({ in: "world", out: "@@repeat_back start_nl" })];
        expect((await process("say", scripts, 2)).data).toBe("world\nsay");
        // Message 1 is the first `char` message: the greeting is the previous one.
        expect((await process("x", scripts, 1)).data).toBe("world\nx");
    });

    it("quirk: a previous message without the match skips the script", async () => {
        setup().chats[0].message = [
            { chatId: "m0", role: "user", data: "hello" },
            { chatId: "m1", role: "user", data: "say" },
        ];
        const scripts = [script({ in: "zzz", out: "@@repeat_back" }), script({ in: "say", out: "said" })];
        expect((await process("say", scripts, 1)).data).toBe("said");
        expect(console.error).toHaveBeenCalledTimes(1);
    });
});

describe("the wrapper", () => {
    it("returns the CBS-expanded text when the character has no scripts, and caches it", async () => {
        expect(await process("{{char}} and {{user}}", [])).toEqual({ data: "Alpha and User", emoChanged: false });
    });

    it("runs editinput scripts for editinput only", async () => {
        const scripts = [script({ in: "a", out: "b", type: "editinput" }), script({ in: "a", out: "c" })];
        expect((await process("a", scripts, -1, "editinput")).data).toBe("b");
        expect((await process("a", scripts, -1, "editoutput")).data).toBe("c");
    });
});
