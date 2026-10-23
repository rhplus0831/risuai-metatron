import { beforeEach, describe, expect, it, vi } from "vitest";
import { installFlatDatabase, installFlatDatabaseWithChats } from "../../../storage/tests/installFlatDatabase";
import { downloadFile } from "src/ts/globalApi.svelte";
import { sendChat } from "src/ts/process/index.svelte";
import { beginLocalSend } from "src/ts/process/localSends";
import { findChat, selectChat } from "src/ts/storage/chatStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";

// File retrieval (`postChatFile`'s TXT and XML branches) over the tab's `HypaProcesser` with an API embedding
// model: the embedding request (`globalFetch`) and the vector store (LocalForage) are faked. The
// search must rank the file's lines, which are embedded before the query is searched.

const requests = vi.hoisted(() => [] as { input_type: string; input: string[] | string }[]);
const sends = vi.hoisted(() => [] as boolean[]);

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
// The send pipeline is a stand-in: the PO run's `sendChat` answers `sends` in order (true: the entry
// was sent; false: the send did not run); the TXT and XML branches never reach it.
vi.mock("src/ts/process/index.svelte", () => ({ sendChat: vi.fn(async () => sends.shift() ?? true) }));

beforeEach(() => {
    requests.length = 0;
    sends.length = 0;
    vi.mocked(sendChat).mockClear();
    vi.mocked(downloadFile).mockClear();
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

// The PO run (`sendPofile`): each entry is appended to the chat selected at the start and sent; the
// run stops, downloading no `translated.po`, when that chat is busy before an entry or an entry's
// send does not run (it used to read the last message of a send that never ran).
describe("postChatFile with a PO file", () => {
    const ref = { chaId: "c", chatId: "k" };
    const po = new TextEncoder().encode('msgid "hello"\nmsgstr ""\n\nmsgid "world"\nmsgstr ""\n\n');
    const texts = () => findChat(ref)!.message.map((message) => message.data);

    beforeEach(() => {
        installFlatDatabaseWithChats(
            {
                characters: [
                    {
                        chaId: "c",
                        type: "character",
                        name: "C",
                        chatPage: 0,
                        chats: [{ id: "k", name: "K", note: "", localLore: [], message: [] }],
                    },
                ],
                hypaModel: "voyage4",
                voyageApiKey: "voyage-key",
            },
            "multisend-po-preset",
        );
        selectCharacter("c");
        selectChat("c", "k");
    });

    it("sends every entry in the selected chat and downloads the translation", async () => {
        const { postChatFile } = await import("../multisend");
        await postChatFile({ name: "lines.po", data: po });
        expect(vi.mocked(sendChat).mock.calls).toEqual([
            [-1, { target: ref }],
            [-1, { target: ref }],
        ]);
        expect(texts()).toEqual(["hello", "world"]);
        expect(downloadFile).toHaveBeenCalledTimes(1);
        expect(vi.mocked(downloadFile).mock.calls[0][0]).toBe("translated.po");
    });

    it("stops at an entry whose send did not run, appending nothing more and downloading nothing", async () => {
        const { postChatFile } = await import("../multisend");
        sends.push(true, false);
        await postChatFile({ name: "lines.po", data: po });
        expect(sendChat).toHaveBeenCalledTimes(2);
        expect(texts()).toEqual(["hello", "world"]);
        expect(downloadFile).not.toHaveBeenCalled();
    });

    it("stops before an entry while the chat has a send of its own, appending nothing", async () => {
        const { postChatFile } = await import("../multisend");
        const release = beginLocalSend(ref)!;
        try {
            await postChatFile({ name: "lines.po", data: po });
        } finally {
            release();
        }
        expect(sendChat).not.toHaveBeenCalled();
        expect(texts()).toEqual([]);
        expect(downloadFile).not.toHaveBeenCalled();
    });
});
