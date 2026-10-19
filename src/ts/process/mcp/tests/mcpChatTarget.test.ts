import { beforeEach, describe, expect, it, vi } from "vitest";
import { findChat, selectChat } from "src/ts/storage/chatStore.svelte";
import { selectCharacter, selectModelPreset, selectPreset, selection } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { capturePluginContext } from "src/ts/plugins/apiV3/pluginContext";

// Open bug fixes G3 (`docs/plan/open-bug-fixes.md`): `callMCPTool` (`src/ts/process/mcp/mcp.ts`)
// hands the request's chat to the internal clients whose tools act on a chat (`callToolForChat`):
// the real registry over the real records and chat module, with the real `GraphMemClient`
// (`internal:graphmem`, enabled by a module) and `RisuAccessClient` (`internal:risuai`, call-only),
// while another chat is selected. Graph memory: a call for chat A reads and writes A's
// `graphmem_graph` while B is selected and while A's other chat is selected; the preset default is
// the context's preset when the context is for that chat, else the chat's display preset; null
// answers an error and writes nowhere, an absent chat too; no chat argument (the Playground) keeps
// the selected chat; a selection change during the registry's awaits and a concurrent call for
// another chat do not move a call. RisuAccess: an empty character id names the request chat's
// character and its history is the request's chat (not the character's selected chat), the same
// character named explicitly too; another character's history is its selected chat; null names no
// character for an empty id; a group-owned request keeps the group rejection. The embedding server
// is faked as in `graphmemHost.test.ts`. The argument contract of the other internal clients
// (`internal:fs`, `internal:googlesearch`: exactly `(name, args)`) is pinned by
// `src/ts/plugins/apiV3/mcpContext.test.ts`.

vi.mock(import("src/ts/storage/database.svelte"), () => ({ appVer: "1234.5.67" }) as never);
vi.mock("src/ts/globalApi.svelte", () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: vi.fn(() => Promise.resolve("")),
    globalFetch: vi.fn(async (url: string, arg: { body: { input: string | string[] } }) => {
        if (url !== "http://embed.test/v1/embeddings") {
            throw new Error(`unexpected globalFetch(${url})`);
        }
        const inputs = Array.isArray(arg.body.input) ? arg.body.input : [arg.body.input];
        return {
            ok: true,
            data: { data: inputs.map((text) => ({ embedding: [text.length, (text.match(/e/g) ?? []).length, 1] })) },
        };
    }),
}));
vi.mock("src/ts/network/auxFetch", () => ({
    auxFetchJson: vi.fn(async () => {
        throw new Error("no aux fetch here");
    }),
}));
vi.mock("src/ts/process/transformers", () => ({
    runEmbedding: vi.fn(async () => {
        throw new Error("no local model here");
    }),
}));
vi.mock("localforage", () => ({
    default: {
        createInstance: () => {
            const store = new Map<string, unknown>();
            return {
                getItem: async (key: string) => store.get(key) ?? null,
                setItem: async (key: string, value: unknown) => {
                    store.set(key, value);
                    return value;
                },
            };
        },
    },
}));

const A1 = { chaId: "a", chatId: "a1" };
const A2 = { chaId: "a", chatId: "a2" };
const B1 = { chaId: "b", chatId: "b1" };
const G1 = { chaId: "g", chatId: "g1" };
const entry = (name: string, summary: string, connections: string[] = []) => ({ name, summary, connections });
const presetDefault = (name: string) => `graphmem_graph=${JSON.stringify([entry(name, `from preset ${name}`)])}`;
const message = (role: "user" | "char", data: string) => ({ role, data });

/**
 * Character `a` (chats `a1`, `a2`, display preset `pa`), character `b` (chat `b1`, preset `pb`), and
 * group `g` (chat `g1`), each chat with its own messages and no graph; preset `pc` is a preset no chat
 * is bound to. The module `gm` enables `internal:graphmem` for every chat.
 */
function install() {
    installFlatDatabaseWithChats({
        botPresets: [
            { id: "pa", name: "A", templateDefaultVariables: presetDefault("PresetA") },
            { id: "pb", name: "B", templateDefaultVariables: presetDefault("PresetB") },
            { id: "pc", name: "C", templateDefaultVariables: presetDefault("PresetC") },
        ],
        hypaModel: "custom",
        hypaCustomSettings: { url: "http://embed.test/v1", model: "emb" },
        globalChatVariables: {},
        modules: [{ id: "gm", name: "Graph memory", namespace: "gm", lorebook: [], mcp: { url: "internal:graphmem" } }],
        enabledModules: ["gm"],
        characters: [
            {
                chaId: "a",
                name: "A",
                type: "character",
                chatPage: 0,
                defaultVariables: "",
                chats: [
                    {
                        id: "a1",
                        message: [message("user", "a1 first"), message("char", "a1 second")],
                        scriptstate: {},
                        promptPresetId: "pa",
                        modelPresetId: "pa",
                    },
                    {
                        id: "a2",
                        message: [message("user", "a2 only")],
                        scriptstate: {},
                        promptPresetId: "pa",
                        modelPresetId: "pa",
                    },
                ],
            },
            {
                chaId: "b",
                name: "B",
                type: "character",
                chatPage: 0,
                defaultVariables: "",
                chats: [
                    {
                        id: "b1",
                        message: [message("user", "b1 only")],
                        scriptstate: {},
                        promptPresetId: "pb",
                        modelPresetId: "pb",
                    },
                ],
            },
            {
                chaId: "g",
                name: "G",
                type: "group",
                characters: ["a", "b"],
                chatPage: 0,
                chats: [{ id: "g1", message: [message("user", "g1 only")], scriptstate: {} }],
            },
        ],
        characterOrder: ["a", "b", "g"],
    });
}

/** The graph a chat holds, parsed; undefined for a chat without the variable. */
const graphOf = (ref: { chaId: string; chatId: string }) => {
    const stored = findChat(ref)?.scriptstate?.$graphmem_graph;
    return stored === undefined ? undefined : JSON.parse(stored as string);
};
const text = (result: unknown) => (result as { type: string; text: string }[])[0].text;
/** The history a `risu-get-chat-history` answer lists, newest first, as `Speaker: text`. */
const history = (result: unknown) => (JSON.parse(text(result)) as { text: string }[]).map((line) => line.text);
const noGraphAnywhere = () => {
    for (const ref of [A1, A2, B1, G1]) {
        expect(graphOf(ref)).toBeUndefined();
    }
};

type Mcp = typeof import("../mcp");
let mcp: Mcp;

beforeEach(async () => {
    install();
    // Character B's chat is the selection; the selected preset is B's.
    selectCharacter("b");
    selectChat("b", "b1");
    selectPreset("pb");
    selectModelPreset("pb");
    mcp = await import("../mcp");
});

describe("callMCPTool and internal:graphmem", () => {
    it("writes and reads chat A's graph (from A's display preset default) while chat B is selected", async () => {
        const write = { name: "Bo", summary: "short" };
        expect(text(await mcp.callMCPTool("writeMemory", write, A1, capturePluginContext(A1)))).toBe(
            'Memory entry "Bo" written successfully.',
        );
        expect(graphOf(A1)).toEqual([entry("PresetA", "from preset PresetA"), entry("Bo", "short")]);
        expect(graphOf(A2)).toBeUndefined();
        expect(graphOf(B1)).toBeUndefined();
        expect(selection.characterId).toBe("b");

        const read = JSON.parse(
            text(await mcp.callMCPTool("readMemory", { query: ["Bo"], search_depth: 1 }, A1, capturePluginContext(A1))),
        );
        expect(read[0].entries.map((e: { name: string }) => e.name).sort()).toEqual(["Bo", "PresetA"]);
    });

    it("writes the request's chat while another chat of the same character is selected", async () => {
        selectCharacter("a");
        selectChat("a", "a2");
        selectPreset("pa");
        selectModelPreset("pa");
        await mcp.callMCPTool("writeMemory", { name: "ForA1", summary: "request" }, A1, capturePluginContext(A1));
        expect(graphOf(A1)).toEqual([entry("PresetA", "from preset PresetA"), entry("ForA1", "request")]);
        expect(graphOf(A2)).toBeUndefined();
        expect(graphOf(B1)).toBeUndefined();
    });

    it("takes the preset default from the context's preset only when the context is for the request's chat", async () => {
        // A context for `a1` carrying preset `pc` (a captured `presetChain` pick): `pc`'s default.
        const forA1 = { chatRef: A1, presetId: "pc", modelPresetId: "pc", personaId: "" };
        await mcp.callMCPTool("writeMemory", { name: "Scoped", summary: "c" }, A1, forA1);
        expect(graphOf(A1)).toEqual([entry("PresetC", "from preset PresetC"), entry("Scoped", "c")]);
        // A context for another chat is not this chat's preset: `a2`'s display preset `pa` applies.
        const forB1 = { chatRef: B1, presetId: "pc", modelPresetId: "pc", personaId: "" };
        await mcp.callMCPTool("writeMemory", { name: "Display", summary: "a" }, A2, forB1);
        expect(graphOf(A2)).toEqual([entry("PresetA", "from preset PresetA"), entry("Display", "a")]);
        expect(graphOf(B1)).toBeUndefined();
    });

    it("answers an error and writes nowhere for a request without a chat (null) or an absent chat; no chat argument keeps the selected chat", async () => {
        const write = { name: "Lost", summary: "nowhere" };
        expect(text(await mcp.callMCPTool("writeMemory", write, null))).toBe(
            "Error: The graph memory needs a chat, and this request has none.",
        );
        expect(text(await mcp.callMCPTool("writeMemory", write, { chaId: "a", chatId: "gone" }))).toBe(
            "Error: The chat this request is for is not loaded.",
        );
        noGraphAnywhere();

        // The Playground's call names no chat: the selected chat `b1`, from the selected preset's default.
        expect(text(await mcp.callMCPTool("writeMemory", { name: "Played", summary: "selected" }))).toBe(
            'Memory entry "Played" written successfully.',
        );
        expect(graphOf(B1)).toEqual([entry("PresetB", "from preset PresetB"), entry("Played", "selected")]);
        expect(graphOf(A1)).toBeUndefined();
    });

    it("keeps a call on its chat through a selection change during the registry's awaits and beside a concurrent call for another chat", async () => {
        selectCharacter("a");
        selectChat("a", "a1");
        const pending = mcp.callMCPTool("writeMemory", { name: "Moved", summary: "a" }, A1, capturePluginContext(A1));
        // The selection moves to B before the registry's awaits (the module import, the handshake, the
        // listing) end.
        selectCharacter("b");
        selectChat("b", "b1");
        expect(text(await pending)).toBe('Memory entry "Moved" written successfully.');
        expect(graphOf(A1)).toEqual([entry("PresetA", "from preset PresetA"), entry("Moved", "a")]);
        expect(graphOf(B1)).toBeUndefined();

        const [forA, forB] = await Promise.all([
            mcp.callMCPTool("writeMemory", { name: "ConcurrentA", summary: "a" }, A1, capturePluginContext(A1)),
            mcp.callMCPTool("writeMemory", { name: "ConcurrentB", summary: "b" }, B1, capturePluginContext(B1)),
        ]);
        expect(text(forA)).toBe('Memory entry "ConcurrentA" written successfully.');
        expect(text(forB)).toBe('Memory entry "ConcurrentB" written successfully.');
        expect(graphOf(A1)).toEqual([
            entry("PresetA", "from preset PresetA"),
            entry("Moved", "a"),
            entry("ConcurrentA", "a"),
        ]);
        expect(graphOf(B1)).toEqual([entry("PresetB", "from preset PresetB"), entry("ConcurrentB", "b")]);
        expect(graphOf(A2)).toBeUndefined();
    });
});

describe("callMCPTool and internal:risuai", () => {
    const chatHistory = (id: string, chatRef?: { chaId: string; chatId: string } | null) =>
        chatRef === undefined
            ? mcp.callMCPTool("risu-get-chat-history", { id }, undefined)
            : mcp.callMCPTool("risu-get-chat-history", { id }, chatRef, capturePluginContext(chatRef));

    it("resolves an empty id to the request chat's character and its history to the request's chat while B is selected", async () => {
        expect(history(await chatHistory("", A1))).toEqual(["A: a1 second", "User: a1 first"]);
        // The same character named explicitly (by id, by name): still the request's chat.
        expect(history(await chatHistory("a", A1))).toEqual(["A: a1 second", "User: a1 first"]);
        expect(history(await chatHistory("A", A1))).toEqual(["A: a1 second", "User: a1 first"]);
        // Another character: its selected chat in this tab.
        expect(history(await chatHistory("b", A1))).toEqual(["User: b1 only"]);
        expect(selection.characterId).toBe("b");

        const info = await mcp.callMCPTool(
            "risu-get-character-info",
            { id: "", fields: ["id", "name"] },
            A1,
            capturePluginContext(A1),
        );
        expect(JSON.parse(text(info))).toEqual({ id: "a", name: "A" });
    });

    it("reads the request's chat while the character's other chat is selected", async () => {
        selectCharacter("a");
        selectChat("a", "a2");
        expect(history(await chatHistory("", A1))).toEqual(["A: a1 second", "User: a1 first"]);
        expect(history(await chatHistory("a", A1))).toEqual(["A: a1 second", "User: a1 first"]);
        // A request for `a2` reads `a2`; another character's request reads A's selected chat `a2`.
        expect(history(await chatHistory("", A2))).toEqual(["User: a2 only"]);
        expect(history(await chatHistory("a", B1))).toEqual(["User: a2 only"]);
    });

    it("names no character for an empty id without a chat (null), keeps named characters, and keeps the selection without a chat argument", async () => {
        // Character A's selected chat (not the selected character's) is `a2`.
        selectChat("a", "a2");
        expect(text(await chatHistory("", null))).toBe("Error: Character with ID  not found.");
        expect(history(await chatHistory("a", null))).toEqual(["User: a2 only"]);
        expect(history(await chatHistory("b", null))).toEqual(["User: b1 only"]);
        // The Playground's call: the selected character `b` and its selected chat.
        expect(history(await chatHistory(""))).toEqual(["User: b1 only"]);
        expect(history(await chatHistory("a"))).toEqual(["User: a2 only"]);
    });

    it("keeps the group rejection for a group-owned request's empty id", async () => {
        selectChat("a", "a2");
        expect(text(await chatHistory("", G1))).toBe("Error: The id pointed to a group chat, not a character.");
        expect(
            text(
                await mcp.callMCPTool(
                    "risu-get-character-info",
                    { id: "", fields: ["name"] },
                    G1,
                    capturePluginContext(G1),
                ),
            ),
        ).toBe("Error: The id pointed to a group chat, not a character.");
        // A member named from the group's request: its own selected chat.
        expect(history(await chatHistory("a", G1))).toEqual(["User: a2 only"]);
        // The group's graph is the group chat's.
        await mcp.callMCPTool("writeMemory", { name: "Group", summary: "g" }, G1, capturePluginContext(G1));
        expect(graphOf(G1)?.map((e: { name: string }) => e.name)).toContain("Group");
        expect(graphOf(A1)).toBeUndefined();
        expect(graphOf(B1)).toBeUndefined();
    });
});
