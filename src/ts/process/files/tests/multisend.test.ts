import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFlatDatabase, installFlatDatabaseWithChats } from "../../../storage/tests/installFlatDatabase";
import { FakeResourceServer } from "../../../storage/tests/fakeResourceServer";
import type { InlayResource } from "../../../../../shared/resources.ts";
import { downloadFile } from "src/ts/globalApi.svelte";
import { sendChat } from "src/ts/process/index.svelte";
import { beginLocalSend } from "src/ts/process/localSends";
import { appendMessage, findChat, selectChat, setChatMeta } from "src/ts/storage/chatStore.svelte";
import { alertError } from "src/ts/alert";
import { language } from "src/lang";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import * as assetClient from "src/ts/storage/assetClient";
import * as serverAuth from "src/ts/storage/serverAuth";
import { setResourceEpoch } from "src/ts/storage/resourceClient";
import * as util from "src/ts/util";
import { postInlayAsset } from "../inlays";

// File retrieval (`postChatFile`'s TXT and XML branches) over the tab's `HypaProcesser` with an API embedding
// model: the embedding request (`globalFetch`) and the vector store (LocalForage) are faked. The
// search must rank the file's lines, which are embedded before the query is searched.

const requests = vi.hoisted(() => [] as { input_type: string; input: string[] | string }[]);
const sends = vi.hoisted(() => [] as boolean[]);

function gate<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

vi.mock("src/ts/globalApi.svelte", async () =>
    (await import("src/ts/tests/globalApiMock")).createGlobalApiMock({
        globalFetch: async (_url: string, arg: { body: { input: string[] | string; input_type: string } }) => {
            requests.push(arg.body);
            const inputs = Array.isArray(arg.body.input) ? arg.body.input : [arg.body.input];
            return { ok: true, data: { data: inputs.map((text) => ({ embedding: [1, text.length] })) } };
        },
    }),
);
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
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
    vi.mocked(alertError).mockClear();
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

describe("postChatFile with inlays", () => {
    let server: FakeResourceServer;
    let assets: Map<string, Uint8Array>;

    beforeEach(() => {
        server = new FakeResourceServer();
        assets = new Map();
        setResourceEpoch(server.epoch);
        vi.spyOn(serverAuth, "authFetch").mockImplementation(server.fetch);
        vi.spyOn(assetClient, "writeAsset").mockImplementation(async (key, bytes) => {
            assets.set(key, new Uint8Array(bytes));
        });
        vi.spyOn(assetClient, "missingAssets").mockImplementation(
            async (keys) => new Set(keys.filter((key) => !assets.has(key))),
        );
        vi.spyOn(util, "selectMultipleFile").mockResolvedValue([]);

        // Image loading and canvas encoding are browser I/O; the inlay writer stays real.
        vi.stubGlobal(
            "Image",
            class {
                complete = true;
                naturalWidth = 2;
                width = 2;
                height = 2;
                src = "";
            },
        );
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:chat-attachment");
        vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
            drawImage: vi.fn(),
        } as unknown as CanvasRenderingContext2D);
        vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) =>
            callback(new Blob(["encoded image"], { type: "image/png" })),
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("offers only stored inlay extensions and text or PO files in the picker", async () => {
        const { postChatFile } = await import("../multisend");
        await postChatFile("attachment query");
        expect(util.selectMultipleFile).toHaveBeenCalledTimes(1);
        const [extensions] = vi.mocked(util.selectMultipleFile).mock.calls[0];
        expect(extensions).toEqual(expect.arrayContaining(["txt", "po"]));
        expect(extensions).not.toContain("mpeg");
        expect(extensions).not.toContain("avi");

        for (const extension of extensions.filter((extension) => !["txt", "pdf", "xml", "po"].includes(extension))) {
            const file = { name: `attachment.${extension}`, data: new TextEncoder().encode(extension) };
            const id = await postInlayAsset(file);
            expect(id, extension).toEqual(expect.any(String));
            const stored = server.data<InlayResource>("inlays", id!);
            expect(stored, extension).toMatchObject({ name: file.name, asset: expect.any(String) });
            expect(assets.has(stored!.asset!), extension).toBe(true);
        }
        expect(alertError).not.toHaveBeenCalled();
    });

    it("reports a pasted image write failure and resolves without an attachment", async () => {
        const { postChatFile } = await import("../multisend");
        const error = new Error("Image upload failed");
        vi.mocked(assetClient.writeAsset).mockRejectedValueOnce(error);

        await expect(postChatFile({ name: "pasted.png", data: new Uint8Array([1, 2, 3]) })).resolves.toEqual([]);
        expect(alertError).toHaveBeenCalledExactlyOnceWith(error);
        expect(server.records.size).toBe(0);
    });

    it("names the size limit when a media write is refused with 413", async () => {
        const { postChatFile } = await import("../multisend");
        vi.mocked(util.selectMultipleFile).mockResolvedValueOnce([{ name: "large.mp4", data: new Uint8Array([1, 2]) }]);
        vi.mocked(assetClient.writeAsset).mockRejectedValueOnce(new assetClient.AssetWriteError(413));

        await expect(postChatFile("attachment query")).resolves.toEqual([]);
        expect(alertError).toHaveBeenCalledExactlyOnceWith(language.attachmentTooLarge);
        expect(server.records.size).toBe(0);
    });

    it("reports a picked media write failure and returns attachments before and after it", async () => {
        const { postChatFile } = await import("../multisend");
        const files = [
            { name: "before.mp3", data: new Uint8Array([1, 2]) },
            { name: "broken.mp4", data: new Uint8Array([3, 4]) },
            { name: "after.webm", data: new Uint8Array([5, 6]) },
        ];
        const error = new Error("Video upload failed");
        vi.mocked(util.selectMultipleFile).mockResolvedValueOnce(files);
        vi.mocked(assetClient.writeAsset)
            .mockImplementationOnce(async (key, bytes) => {
                assets.set(key, new Uint8Array(bytes));
            })
            .mockRejectedValueOnce(error);

        const results = await postChatFile("attachment query");
        expect(results).toEqual([
            { type: "asset", data: expect.any(String) },
            { type: "asset", data: expect.any(String) },
        ]);
        const stored = results.map((result) =>
            server.data<InlayResource>("inlays", (result as { data: string }).data)!,
        );
        expect(stored.map((inlay) => inlay.name)).toEqual(["before.mp3", "after.webm"]);
        expect(stored.map((inlay) => assets.get(inlay.asset!))).toEqual([files[0].data, files[2].data]);
        expect(server.records.size).toBe(2);
        expect(alertError).toHaveBeenCalledExactlyOnceWith(error);
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
                        chats: [
                            {
                                id: "k",
                                name: "K",
                                note: "",
                                localLore: [],
                                message: [],
                                promptPresetId: "multisend-po-preset",
                                modelPresetId: "multisend-po-preset",
                                bindedPersona: "persona",
                            },
                        ],
                    },
                ],
                hypaModel: "voyage4",
                voyageApiKey: "voyage-key",
                botPresets: [{ id: "multisend-po-preset", name: "Prompt" }],
                personas: [{ id: "persona", name: "Persona" }],
            },
            "multisend-po-preset",
        );
        selectCharacter("c");
        selectChat("c", "k");
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([
        ...(["picker", "send"] as const).flatMap((wait) =>
            (["switch", "delete", "replace"] as const).map((change) => ({ wait, change })),
        ),
        { wait: "picker", change: "cancel" } as const,
        { wait: "picker", change: "fail" } as const,
    ])("uses only its captured PO batch destination across $wait ($change)", async ({ wait, change }) => {
        const { postChatFile } = await import("../multisend");
        const chatStore = await import("src/ts/storage/chatStore.svelte");
        const { addCharacter } = await import("src/ts/storage/characterStore.svelte");
        const emptyChat = (id: string) => ({ id, name: id, note: "", localLore: [], message: [] });
        chatStore.createChat("c", emptyChat("other"));
        addCharacter({ chaId: "d", name: "D", chats: [emptyChat("k")] });
        const files = ["hello", "world"].map((text) => ({
            name: `${text}.po`,
            data: new TextEncoder().encode(`msgid "${text}"\nmsgstr ""\n\n`),
        }));
        const originalPin = chatStore.pinChat;
        const releases: ReturnType<typeof vi.fn>[] = [];
        vi.spyOn(chatStore, "pinChat").mockImplementation((target) => {
            const release = vi.fn(originalPin(target));
            releases.push(release);
            return release;
        });
        const picker = gate<typeof files>();
        vi.spyOn(util, "selectMultipleFile").mockReturnValueOnce(picker.promise);
        const sending = gate<void>();
        const sent = gate<boolean>();
        if (wait === "send") {
            vi.mocked(sendChat).mockImplementationOnce(() => {
                sending.resolve();
                return sent.promise;
            });
        }
        const running = postChatFile("translate these files");
        expect(util.selectMultipleFile).toHaveBeenCalledOnce();
        if (change === "cancel" || change === "fail") {
            if (change === "cancel") {
                picker.resolve([]);
                await expect(running).resolves.toEqual([]);
            } else {
                const error = new Error("Picker failed");
                const failed = expect(running).rejects.toBe(error);
                picker.reject(error);
                await failed;
            }
            expect(texts()).toEqual([]);
            expect(sendChat).not.toHaveBeenCalled();
            expect(downloadFile).not.toHaveBeenCalled();
            expect(releases).toHaveLength(1);
            expect(releases[0]).toHaveBeenCalledExactlyOnceWith();
            return;
        }
        if (wait === "send") {
            picker.resolve(files);
            await sending.promise;
            expect(texts()).toEqual(["hello"]);
        }
        for (const release of releases) expect(release).not.toHaveBeenCalled();
        selectCharacter("d");
        // Another tab deleted the chat for good; a whole read finds it gone.
        if (change === "delete")
            chatStore.acceptRemoteChat({ characterId: ref.chaId, id: ref.chatId, revision: null, data: null });
        if (change === "replace") chatStore.installCharacterChats("c", [emptyChat("k")], {});
        picker.resolve(files);
        sent.resolve(true);
        await running;

        expect(findChat({ chaId: "d", chatId: "k" })!.message).toEqual([]);
        if (change === "switch") {
            expect(texts()).toEqual(["hello", "world"]);
            expect(vi.mocked(sendChat).mock.calls).toEqual([
                [-1, { target: ref }],
                [-1, { target: ref }],
            ]);
            expect(vi.mocked(downloadFile).mock.calls.map(([name, data]) => [name, data])).toEqual([
                ["translated.po", 'msgid "hello"\nmsgstr ""\n"hello"\n\n\n'],
                ["translated.po", 'msgid "world"\nmsgstr ""\n"world"\n\n\n'],
            ]);
        } else {
            expect(sendChat).toHaveBeenCalledTimes(wait === "send" ? 1 : 0);
            expect(downloadFile).not.toHaveBeenCalled();
            if (change === "delete") expect(findChat(ref)).toBeUndefined();
            else expect(texts()).toEqual([]);
        }
        expect(releases).toHaveLength(1);
        expect(releases[0]).toHaveBeenCalledExactlyOnceWith();
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

    it.each([
        { boundary: "CRLF blank lines", newline: "\r\n", ending: "\r\n\r\n" },
        { boundary: "the final entry ending at EOF", newline: "\n", ending: "" },
        { boundary: "an ordinary comment past line 100", newline: "\n", ending: "\n\n", comment: "# Translator note" },
    ])("downloads every translation with $boundary", async ({ newline, ending, comment }) => {
        const { postChatFile } = await import("../multisend");
        const entry = (source: string) => `msgid "${source}"${newline}msgstr ""`;
        const between = comment ? `${newline.repeat(100)}${comment}${newline}` : "";
        const catalog = [entry("hello"), `${between}${entry("world")}${ending}`].join(newline.repeat(2));
        const lastSendStarted = gate<void>();
        const finishLastSend = gate<void>();
        let downloadedBeforeLastReply = false;

        await vi.mocked(sendChat).withImplementation(
            async () => {
                const source = texts().at(-1);
                if (source === "world") {
                    lastSendStarted.resolve();
                    await finishLastSend.promise;
                }
                appendMessage(ref, { role: "char", data: source === "hello" ? "bonjour\nsalut" : "monde" });
                return true;
            },
            async () => {
                const translating = postChatFile({ name: "lines.po", data: new TextEncoder().encode(catalog) });
                await Promise.race([lastSendStarted.promise, translating]);
                downloadedBeforeLastReply = vi.mocked(downloadFile).mock.calls.length > 0;
                finishLastSend.resolve();
                await translating;
            },
        );

        expect(texts()).toEqual(["hello", "bonjour\nsalut", "world", "monde"]);
        expect(sendChat).toHaveBeenCalledTimes(2);
        expect(downloadedBeforeLastReply).toBe(false);
        expect(downloadFile).toHaveBeenCalledExactlyOnceWith("translated.po", expect.any(String));
        const output = String(vi.mocked(downloadFile).mock.calls[0][1]);
        expect(output.replaceAll(newline, "")).not.toMatch(/[\r\n]/);
        expect(output.split(newline).filter(Boolean)).toEqual([
            'msgid "hello"',
            'msgstr ""',
            '"bonjour"',
            '"salut"',
            ...(comment ? [comment] : []),
            'msgid "world"',
            'msgstr ""',
            '"monde"',
        ]);
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

    it("stops before an entry while the chat has orphaned lore overrides, appending nothing", async () => {
        const { postChatFile } = await import("../multisend");
        // An override whose owner entry is gone (the character has no lore).
        setChatMeta(ref, {
            loreOverrides: [{ entry: { id: "gone", key: "", comment: "Gone entry", content: "" }, off: false }],
        });
        await postChatFile({ name: "lines.po", data: po });
        expect(sendChat).not.toHaveBeenCalled();
        expect(texts()).toEqual([]);
        expect(downloadFile).not.toHaveBeenCalled();
        expect(vi.mocked(alertError).mock.calls).toEqual([[expect.stringContaining("Gone entry")]]);
    });

    it("checks again before each entry: an orphan made during an entry's send stops the next, downloading nothing", async () => {
        const { postChatFile } = await import("../multisend");
        vi.mocked(sendChat).mockImplementationOnce(async () => {
            setChatMeta(ref, {
                loreOverrides: [{ entry: { id: "gone", key: "", comment: "Gone entry", content: "" }, off: false }],
            });
            return true;
        });
        await postChatFile({ name: "lines.po", data: po });
        expect(sendChat).toHaveBeenCalledTimes(1);
        expect(texts()).toEqual(["hello"]);
        expect(downloadFile).not.toHaveBeenCalled();
        expect(alertError).toHaveBeenCalledTimes(1);
    });

    it("stops before appending the next entry when a PO send leaves the binding pending review", async () => {
        const { postChatFile } = await import("../multisend");
        vi.mocked(sendChat).mockImplementationOnce(async () => {
            setChatMeta(ref, { bindingReview: true });
            return true;
        });

        await postChatFile({ name: "lines.po", data: po });

        expect(texts()).toEqual(["hello"]);
        expect(sendChat).toHaveBeenCalledOnce();
        expect(downloadFile).not.toHaveBeenCalled();
        expect(alertError).toHaveBeenCalledExactlyOnceWith(
            `${language.chatBinding.refused}\n${language.chatBinding.review}`,
        );
    });
});
