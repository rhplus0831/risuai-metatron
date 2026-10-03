import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 5 Stop D fixes (slice 13d, D1): the tab's graph memory host (`src/ts/process/mcp/graphmem.ts`)
// with the real `HypaProcesser` (`src/ts/process/memory/hypamemory.ts`) over a fake custom embedding
// server (a vector per text: its length, its count of the letter `e`, and 1) and an in-memory vector
// store shared by every processor (the LocalForage `hypaVector` store). A chat that never held the
// graph (its variable reads as the text `null`) gets a graph on its first write, a read ranks the
// stored names by similarity (the names stored with `addText`, then the query embedded), and a later
// read's new processor takes the names' vectors from the store and embeds only its query. The
// server's host is tested in `server/src/tests/mcpInternal.test.ts`.

const { vars, embedded, vectorStore } = vi.hoisted(() => ({
    vars: {} as Record<string, string>,
    /** Every embedding request's input, in order. */
    embedded: [] as unknown[],
    vectorStore: new Map<string, unknown>(),
}));

vi.mock("src/ts/parser/chatVar.svelte", () => ({
    getChatVar: (key: string) => vars[key] ?? "null",
    setChatVar: (key: string, value: string) => {
        vars[key] = value;
    },
}));
vi.mock("src/ts/storage/database.svelte", () => ({
    getDatabase: () => ({ hypaModel: "custom", hypaCustomSettings: { url: "http://embed.test/v1", model: "emb" } }),
}));
vi.mock("src/ts/globalApi.svelte", () => ({
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
vi.mock("src/ts/util", () => ({
    appendLastPath: (url: string, last: string) => url.replace(/\/$/, "") + "/" + last,
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

beforeEach(() => {
    for (const key of Object.keys(vars)) {
        delete vars[key];
    }
    embedded.length = 0;
    vectorStore.clear();
});

const text = (result: unknown) => (result as { type: string; text: string }[])[0].text;

describe("the tab's graph memory host (Stop D fixes)", () => {
    it("writes on a chat without the graph, then a read ranks the stored names by similarity", async () => {
        const { GraphMemClient } = await import("../graphmem");
        const client = new GraphMemClient();
        expect(text(await client.callTool("writeMemory", { name: "Bo", summary: "short" }))).toBe(
            'Memory entry "Bo" written successfully.',
        );
        expect(
            text(await client.callTool("writeMemory", { name: "Genevieve", summary: "long", connections: ["Bo"] })),
        ).toBe('Memory entry "Genevieve" written successfully.');
        expect(JSON.parse(vars.graphmem_graph)).toEqual([
            { name: "Bo", summary: "short", connections: [] },
            { name: "Genevieve", summary: "long", connections: ["Bo"] },
        ]);

        // The query is closer to the long name: it ranks first.
        const read = JSON.parse(text(await client.callTool("readMemory", { query: ["Eleventeen"], search_depth: 1 })));
        expect(read).toEqual([
            {
                queryTerm: "Eleventeen",
                entries: [
                    { name: "Genevieve", summary: "long", connections: ["Bo"] },
                    { name: "Bo", summary: "short", connections: [] },
                ],
            },
        ]);
        // The names were embedded as documents (and stored), then the query.
        expect(embedded).toEqual([["Bo", "Genevieve"], "Eleventeen"]);
        expect([...vectorStore.keys()].sort()).toEqual(["Bo|custom-emb", "Genevieve|custom-emb"]);
    });

    it("takes the names' vectors from the store for a later read: only the query is embedded", async () => {
        const { GraphMemClient } = await import("../graphmem");
        const client = new GraphMemClient();
        vars.graphmem_graph = JSON.stringify([
            { name: "Alice", summary: "tea", connections: [] },
            { name: "Bob", summary: "coffee", connections: [] },
        ]);
        await client.callTool("readMemory", { query: ["first"], search_depth: 1 });
        expect(embedded).toEqual([["Alice", "Bob"], "first"]);

        embedded.length = 0;
        const read = JSON.parse(text(await client.callTool("readMemory", { query: ["second"], search_depth: 1 })));
        expect(read[0].entries.map((entry: { name: string }) => entry.name).sort()).toEqual(["Alice", "Bob"]);
        expect(embedded).toEqual(["second"]);
    });
});
