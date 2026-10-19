import { beforeEach, describe, expect, it, vi } from "vitest";
import { characterList } from "src/ts/storage/characterStore.svelte";
import { findChat, selectChat } from "src/ts/storage/chatStore.svelte";
import { selectCharacter, selectModelPreset, selectPreset } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";

// Phase 5 Stop D fixes (slice 13d, D1) and Open bug fixes G3: the tab's graph memory host
// (`src/ts/process/mcp/graphmem.ts`) with the real `HypaProcesser` (`src/ts/process/memory/hypamemory.ts`)
// over a fake custom embedding server (a vector per text: its length, its count of the letter `e`,
// and 1) and an in-memory vector store shared by every processor (the LocalForage `hypaVector`
// store), on the real records and chat module (`installFlatDatabaseWithChats`): the variable is
// read where `getChatVar`/`getChatVarOf` read it and lands where `mergeChatMeta` writes it.
// `callTool` (no request) acts on the selected chat: a chat that never held the graph (its
// variable reads as the text `null`) gets a graph on its first write, a read ranks the stored names
// by similarity (the names stored with `addText`, then the query embedded), and a later read's new
// processor takes the names' vectors from the store and embeds only its query. `callToolForChat`
// (a request's call) acts on the request's chat by id while another chat, or another chat of the
// same character, is selected; null or a chat that is not loaded answers an error and writes nowhere;
// the preset default is the scope's preset's, else the chat's display preset's, never the selected
// preset's. The server's host is tested in `server/src/tests/mcpInternal.test.ts`.

const { embedded, vectorStore } = vi.hoisted(() => ({
    /** Every embedding request's input, in order. */
    embedded: [] as unknown[],
    vectorStore: new Map<string, unknown>(),
}));

vi.mock(import("src/ts/storage/database.svelte"), () => ({ appVer: "1234.5.67" }) as never);
vi.mock("src/ts/globalApi.svelte", () => ({
    aiWatermarkingLawApplies: () => false,
    getFileSrc: vi.fn(() => Promise.resolve("")),
    globalFetch: vi.fn(async (url: string, arg: { body: { input: string | string[] } }) => {
        if (url !== "http://embed.test/v1/embeddings") {
            throw new Error(`unexpected globalFetch(${url})`);
        }
        embedded.push(arg.body.input);
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
        createInstance: () => ({
            getItem: async (key: string) => vectorStore.get(key) ?? null,
            setItem: async (key: string, value: unknown) => {
                vectorStore.set(key, value);
                return value;
            },
        }),
    },
}));

const A1 = { chaId: "a", chatId: "a1" };
const A2 = { chaId: "a", chatId: "a2" };
const B1 = { chaId: "b", chatId: "b1" };
const entry = (name: string, summary: string, connections: string[] = []) => ({ name, summary, connections });
const presetDefault = (name: string) => `graphmem_graph=${JSON.stringify([entry(name, `from preset ${name}`)])}`;

/**
 * Character `a` with chats `a1` (display preset `pa`) and `a2`, character `b` with chat `b1`
 * (display preset `pb`); every chat without the variable. Presets `pa`, `pb`, and `pc` each carry a
 * different default graph, so a read without the variable shows which preset it took. The
 * embedding settings are the fake custom server's.
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
        characters: [
            {
                chaId: "a",
                name: "A",
                type: "character",
                chatPage: 0,
                defaultVariables: "",
                chats: [
                    { id: "a1", message: [], scriptstate: {}, promptPresetId: "pa", modelPresetId: "pa" },
                    { id: "a2", message: [], scriptstate: {}, promptPresetId: "pa", modelPresetId: "pa" },
                ],
            },
            {
                chaId: "b",
                name: "B",
                type: "character",
                chatPage: 0,
                defaultVariables: "",
                chats: [{ id: "b1", message: [], scriptstate: {}, promptPresetId: "pb", modelPresetId: "pb" }],
            },
        ],
        characterOrder: ["a", "b"],
    });
}

/** The graph a chat holds, parsed; undefined for a chat without the variable. */
const graphOf = (ref: { chaId: string; chatId: string }) => {
    const stored = findChat(ref)?.scriptstate?.$graphmem_graph;
    return stored === undefined ? undefined : JSON.parse(stored as string);
};
const text = (result: unknown) => (result as { type: string; text: string }[])[0].text;

beforeEach(() => {
    embedded.length = 0;
    vectorStore.clear();
    install();
    // Character B's chat is the selection; the selected preset is B's.
    selectCharacter("b");
    selectChat("b", "b1");
    selectPreset("pb");
    selectModelPreset("pb");
    expect(characterList().map((c) => c.chaId)).toEqual(["a", "b"]);
});

describe("the tab's graph memory host without a request (`callTool`: the selected chat)", () => {
    it("writes on the selected chat without the graph, then a read ranks the stored names by similarity", async () => {
        const { GraphMemClient } = await import("../graphmem");
        const client = new GraphMemClient();
        // The selected chat has no graph: the write starts from the selected preset's default.
        expect(text(await client.callTool("writeMemory", { name: "Bo", summary: "short" }))).toBe(
            'Memory entry "Bo" written successfully.',
        );
        expect(
            text(await client.callTool("writeMemory", { name: "Genevieve", summary: "long", connections: ["Bo"] })),
        ).toBe('Memory entry "Genevieve" written successfully.');
        expect(graphOf(B1)).toEqual([
            entry("PresetB", "from preset PresetB"),
            entry("Bo", "short"),
            entry("Genevieve", "long", ["Bo"]),
        ]);
        expect(graphOf(A1)).toBeUndefined();
        expect(graphOf(A2)).toBeUndefined();

        // The query is closest to the long name: it ranks first.
        const read = JSON.parse(text(await client.callTool("readMemory", { query: ["Eleventeen"], search_depth: 1 })));
        expect(read).toEqual([
            {
                queryTerm: "Eleventeen",
                entries: [
                    entry("Genevieve", "long", ["Bo"]),
                    entry("PresetB", "from preset PresetB"),
                    entry("Bo", "short"),
                ],
            },
        ]);
        // The names were embedded as documents (and stored), then the query.
        expect(embedded).toEqual([["PresetB", "Bo", "Genevieve"], "Eleventeen"]);
        expect([...vectorStore.keys()].sort()).toEqual(["Bo|custom-emb", "Genevieve|custom-emb", "PresetB|custom-emb"]);
    });

    it("takes the names' vectors from the store for a later read: only the query is embedded", async () => {
        const { GraphMemClient } = await import("../graphmem");
        const client = new GraphMemClient();
        await client.callTool("writeMemory", { name: "Alice", summary: "tea" });
        await client.callTool("writeMemory", { name: "Bob", summary: "coffee" });
        await client.callTool("readMemory", { query: ["first"], search_depth: 1 });
        expect(embedded).toEqual([["PresetB", "Alice", "Bob"], "first"]);

        embedded.length = 0;
        const read = JSON.parse(text(await client.callTool("readMemory", { query: ["second"], search_depth: 1 })));
        expect(read[0].entries.map((e: { name: string }) => e.name).sort()).toEqual(["Alice", "Bob", "PresetB"]);
        expect(embedded).toEqual(["second"]);
    });
});

describe("the tab's graph memory host for a request's chat (`callToolForChat`)", () => {
    it("reads and writes chat A's graph while chat B is selected: B's chat and preset are never touched", async () => {
        const { GraphMemClient } = await import("../graphmem");
        const client = new GraphMemClient();
        // The request's chat has no graph: the write starts from its display preset's default (`pa`,
        // not the selected `pb`).
        expect(text(await client.callToolForChat(A1, "writeMemory", { name: "Bo", summary: "short" }))).toBe(
            'Memory entry "Bo" written successfully.',
        );
        expect(
            text(
                await client.callToolForChat(A1, "writeMemory", {
                    name: "Genevieve",
                    summary: "long",
                    connections: ["Bo"],
                }),
            ),
        ).toBe('Memory entry "Genevieve" written successfully.');
        expect(graphOf(A1)).toEqual([
            entry("PresetA", "from preset PresetA"),
            entry("Bo", "short"),
            entry("Genevieve", "long", ["Bo"]),
        ]);
        expect(graphOf(A2)).toBeUndefined();
        expect(graphOf(B1)).toBeUndefined();

        const read = JSON.parse(
            text(await client.callToolForChat(A1, "readMemory", { query: ["Eleventeen"], search_depth: 1 })),
        );
        expect(read[0].entries).toEqual([
            entry("Genevieve", "long", ["Bo"]),
            entry("PresetA", "from preset PresetA"),
            entry("Bo", "short"),
        ]);
        expect(embedded).toEqual([["PresetA", "Bo", "Genevieve"], "Eleventeen"]);

        // The selected chat still has no graph: its own read sees only the selected preset's default,
        // none of A's entries.
        const selectedRead = JSON.parse(text(await client.callTool("readMemory", { query: ["Eleventeen"] })));
        expect(selectedRead[0].entries).toEqual([entry("PresetB", "from preset PresetB")]);
    });

    it("writes the request's chat of the selected character, not the character's selected chat (two chats of one character)", async () => {
        const { GraphMemClient } = await import("../graphmem");
        const client = new GraphMemClient();
        selectCharacter("a");
        selectChat("a", "a2");
        selectPreset("pa");
        selectModelPreset("pa");

        await client.callToolForChat(A1, "writeMemory", { name: "ForA1", summary: "request" });
        expect(graphOf(A1)).toEqual([entry("PresetA", "from preset PresetA"), entry("ForA1", "request")]);
        expect(graphOf(A2)).toBeUndefined();

        // The no-request call is the selection's: the character's selected chat `a2`.
        await client.callTool("writeMemory", { name: "ForA2", summary: "selection" });
        expect(graphOf(A2)).toEqual([entry("PresetA", "from preset PresetA"), entry("ForA2", "selection")]);
        expect(graphOf(A1)).toEqual([entry("PresetA", "from preset PresetA"), entry("ForA1", "request")]);

        // A later request read for `a1` sees only `a1`'s entries.
        const read = JSON.parse(
            text(await client.callToolForChat(A1, "readMemory", { query: ["ForA"], search_depth: 1 })),
        );
        expect(read[0].entries.map((e: { name: string }) => e.name).sort()).toEqual(["ForA1", "PresetA"]);
    });

    it("answers an error and writes nowhere for a request without a chat (null) or for a chat that is not loaded", async () => {
        const { GraphMemClient } = await import("../graphmem");
        const client = new GraphMemClient();
        const args = { name: "Lost", summary: "nowhere" };
        expect(text(await client.callToolForChat(null, "writeMemory", args))).toBe(
            "Error: The graph memory needs a chat, and this request has none.",
        );
        expect(text(await client.callToolForChat(null, "readMemory", { query: ["Lost"] }))).toBe(
            "Error: The graph memory needs a chat, and this request has none.",
        );
        expect(text(await client.callToolForChat({ chaId: "a", chatId: "gone" }, "writeMemory", args))).toBe(
            "Error: The chat this request is for is not loaded.",
        );
        expect(text(await client.callToolForChat({ chaId: "nobody", chatId: "a1" }, "writeMemory", args))).toBe(
            "Error: The chat this request is for is not loaded.",
        );
        for (const ref of [A1, A2, B1]) {
            expect(graphOf(ref)).toBeUndefined();
        }
        expect(embedded).toEqual([]);
    });

    it("takes the preset default from the scope's preset when one is given, else from the chat's display preset", async () => {
        const { GraphMemClient } = await import("../graphmem");
        const client = new GraphMemClient();
        // The request captured preset `pc` for chat `a1`: its default graph is the base.
        await client.callToolForChat(
            A1,
            "writeMemory",
            { name: "Scoped", summary: "c" },
            { presetId: "pc", modelPresetId: "pc" },
        );
        expect(graphOf(A1)).toEqual([entry("PresetC", "from preset PresetC"), entry("Scoped", "c")]);
        // Once the chat holds the graph, the scope's default is no longer read.
        await client.callToolForChat(
            A1,
            "writeMemory",
            { name: "Again", summary: "c" },
            { presetId: "pb", modelPresetId: "pb" },
        );
        expect(graphOf(A1)).toEqual([
            entry("PresetC", "from preset PresetC"),
            entry("Scoped", "c"),
            entry("Again", "c"),
        ]);
        // Without a scope, chat `a2` (bound to `pa`) starts from `pa`'s default while `pb` is selected.
        await client.callToolForChat(A2, "writeMemory", { name: "Display", summary: "a" });
        expect(graphOf(A2)).toEqual([entry("PresetA", "from preset PresetA"), entry("Display", "a")]);
        expect(graphOf(B1)).toBeUndefined();
    });
});
