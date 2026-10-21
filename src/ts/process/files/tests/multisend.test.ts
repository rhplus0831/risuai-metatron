import { beforeEach, describe, expect, it, vi } from "vitest";
import { installFlatDatabase } from "../../../storage/tests/installFlatDatabase";

// File retrieval (`postChatFile`'s TXT and XML branches) over the tab's `HypaProcesser` with an API embedding
// model: the embedding request (`globalFetch`) and the vector store (LocalForage) are faked. The
// search must rank the file's lines, which are embedded before the query is searched.

const requests = vi.hoisted(() => [] as { input_type: string; input: string[] | string }[]);

vi.mock("src/ts/globalApi.svelte", () => ({
    globalFetch: async (_url: string, arg: { body: { input: string[] | string; input_type: string } }) => {
        requests.push(arg.body);
        const inputs = Array.isArray(arg.body.input) ? arg.body.input : [arg.body.input];
        return { ok: true, data: { data: inputs.map((text) => ({ embedding: [1, text.length] })) } };
    },
    downloadFile: vi.fn(),
    saveAsset: vi.fn(),
}));
vi.mock("localforage", () => ({
    default: { createInstance: () => ({ getItem: async () => null, setItem: async () => {} }) },
}));
// The send pipeline (the PO branch's `sendChat`) is not reached by the TXT branch.
vi.mock("src/ts/process/index.svelte", () => ({ sendChat: vi.fn() }));

beforeEach(() => {
    requests.length = 0;
    vi.spyOn(console, "log").mockImplementation(() => {});
    installFlatDatabase({ hypaModel: "voyage4", voyageApiKey: "voyage-key" }, "multisend-preset");
});

describe("postChatFile", () => {
    it("embeds a text file's lines before it searches them", async () => {
        const { postChatFile } = await import("../multisend");
        const data = new TextEncoder().encode("alpha line\nbeta");
        const [result] = await postChatFile({ name: "notes.txt", data });
        expect(requests.map((request) => request.input_type)).toEqual(["document", "query"]);
        expect(result.type).toBe("text");
        const text = Buffer.from((result as { data: string }).data, "base64").toString();
        expect(text).toContain("alpha line");
        expect(text).toContain("beta");
    });

    it("embeds an XML file's node texts before it searches them", async () => {
        const { postChatFile } = await import("../multisend");
        const data = new TextEncoder().encode("<root><item>gamma</item></root>");
        const [result] = await postChatFile({ name: "notes.xml", data });
        expect(requests.map((request) => request.input_type)).toEqual(["document", "query"]);
        const text = Buffer.from((result as { data: string }).data, "base64").toString();
        expect(text).toContain("gamma");
    });
});
