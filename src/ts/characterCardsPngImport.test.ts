import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cardV3, pngWithText } from "./storage/tests/importFixtures";
import { bootMutations, plain, warmMutationGraph } from "./storage/tests/mutationStoresHarness";

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        wait: vi.fn(),
        store: { set: vi.fn(), subscribe: vi.fn() },
    },
}));
vi.mock("./storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("./alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertWait: alerts.wait,
        alertStore: alerts.store,
        alertConfirm: vi.fn(async () => true),
    }),
);
vi.mock("./parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
    parseMarkdownSafe: vi.fn(),
}));
vi.mock("./process/index.svelte", () => ({}));
vi.mock("./translator/translator", () => ({ translateHTML: vi.fn() }));
vi.mock("./process/inlayScreen", () => ({ updateInlayScreen: vi.fn() }));
vi.mock("./process/files/inlays", () => ({
    reencodeImage: vi.fn(async (img: Uint8Array) => img),
    getInlayAsset: vi.fn(),
    writeInlayImage: vi.fn(),
}));
vi.mock("./tokenizer", () => ({ tokenize: vi.fn(async () => 0) }));
// A write batch of four records, so the 32-asset stream fills batches and meets the queue's
// backpressure (a full batch waiting while one is written) before the download ends.
vi.mock("./storage/assetClient", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./storage/assetClient")>()),
    ASSET_BATCH_CLIENT_RECORDS: 4,
}));

async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const api = await import("./globalApi.svelte");
    // The portrait is one `saveAsset`; the asset chunks go through the batched save queue (keys by
    // load order, writes recorded).
    vi.spyOn(api, "saveAsset").mockResolvedValue("asset-portrait");
    const assetKey = vi.spyOn(api, "assetKey").mockImplementation(async () => `asset-${assetKey.mock.calls.length}`);
    const saveAssetBatch = vi.spyOn(api, "saveAssetBatch").mockResolvedValue(undefined);
    const util = await import("./util");
    vi.spyOn(util, "sleep").mockResolvedValue(undefined);
    const cards = await import("./characterCards");
    const { PngChunk } = await import("./pngChunk");
    const ids = () => booted.characterList().map((c) => c.chaId);
    return { ...booted, api, assetKey, saveAssetBatch, cards, PngChunk, ids };
}

/** Internal importer calls are lexical; observe the handoff at its next module boundary. */
function stubPngReader(b: Awaited<ReturnType<typeof boot>>) {
    return vi.spyOn(b.PngChunk, "readGenerator").mockImplementation(async function* (_input, options = {}) {
        yield { key: "ccv3", value: Buffer.from(JSON.stringify(cardV3("Linked"))).toString("base64") };
        if (options.returnTrimed) {
            const image = new b.api.AppendableBuffer();
            image.append(pngWithText({}));
            yield image;
        }
        return null;
    });
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

/** No source-side prefetch: every pull represents a reader request. */
function streamed(bytes: Uint8Array, size = 257) {
    let offset = 0;
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        const end = Math.min(offset + size, bytes.length);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
        if (offset === bytes.length) controller.close();
    });
    const stream = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    return { stream, pull, loaded: () => offset };
}

function fixture(count: number) {
    const values = Array.from({ length: count }, (_, i) => ({ asset: i, padding: "x".repeat(1024) }));
    const assets = values.map((_, i) => ({
        type: "x-risu-asset",
        name: `Asset ${i}`,
        uri: `__asset:${i}`,
        ext: "png",
    }));
    const chunks = {
        ccv3: cardV3("Streaming", { assets }),
        ...Object.fromEntries(values.map((value, i) => [`chara-ext-asset_${i}`, value])),
    };
    return { bytes: pngWithText(chunks), values };
}

const assetProgress = () =>
    alerts.store.set.mock.calls
        .map(([alert]) => alert)
        .filter((alert) => alert.type === "progress" && alert.msg === "Loading... (Loading Assets)");

beforeAll(
    () =>
        warmMutationGraph(() =>
            Promise.all([
                import("./storage/database.svelte"),
                import("./globalApi.svelte"),
                import("./util"),
                import("./characterCards"),
                import("./pngChunk"),
            ]),
        ),
    60_000,
);
beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", new URL("http://localhost/"));
    vi.stubGlobal("safeStructuredClone", (value: unknown) =>
        value === undefined ? undefined : JSON.parse(JSON.stringify(value)),
    );
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("PNG streaming entry points", () => {
    it("imports a stream once, pulls only as asset batch writes allow, and reports running asset counts", async () => {
        const b = await boot();
        const { bytes, values } = fixture(32);
        const source = streamed(bytes);
        const tee = vi.spyOn(source.stream, "tee");
        const getReader = vi.spyOn(source.stream, "getReader");
        const blocked = deferred();
        const firstSave = deferred();
        b.saveAssetBatch.mockImplementation(async () => {
            firstSave.resolve();
            await blocked.promise;
        });
        const before = b.ids();
        const importing = b.cards.importCharacterProcess({ name: "stream.png", data: source.stream });
        // Attach a rejection handler before awaiting the first save, also when testing a mutation.
        void importing.catch(() => firstSave.resolve());
        try {
            await firstSave.promise;
            await vi.advanceTimersByTimeAsync(0);
            expect(source.loaded(), "saving must start before the download finishes").toBeLessThan(bytes.length);
            const pullsWhileBlocked = source.pull.mock.calls.length;
            await vi.advanceTimersByTimeAsync(0);
            expect(source.pull).toHaveBeenCalledTimes(pullsWhileBlocked);
            expect(b.ids()).toEqual(before);
            expect(tee).not.toHaveBeenCalled();
            expect(getReader).toHaveBeenCalledTimes(1);
        } finally {
            blocked.resolve();
            await importing;
        }
        expect(source.loaded()).toBe(bytes.length);
        expect(tee).not.toHaveBeenCalled();
        expect(getReader).toHaveBeenCalledTimes(1);
        // The running count, never a percentage: the last wait alert names every asset.
        expect(alerts.wait.mock.calls.at(-1)?.[0]).toBe(`Loading... (Loaded ${values.length} Assets)`);
        expect(assetProgress()).toEqual([]);
        const id = await importing;
        expect(b.ids()).toEqual([...before, id]);
        expect(plain(b.character(id!).additionalAssets)).toEqual(
            values.map((_, i) => [`Asset ${i}`, `asset-${i + 1}`, "png"]),
        );
        // Compared as base64 text: a deep equality walks every byte of the Buffers one by one.
        const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
        expect(b.saveAssetBatch.mock.calls.flatMap(([items]) => items.map(({ bytes }) => base64(bytes)))).toEqual(
            values.map((value) => base64(Buffer.from(JSON.stringify(value)))),
        );
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it.each(["bytes", "Blob-like"])("counts a %s PNG first and imports with percentage progress", async (kind) => {
        const b = await boot();
        const { bytes, values } = fixture(3);
        const blob = {
            stream: vi.fn(() => streamed(bytes).stream),
            arrayBuffer: vi.fn(async () => {
                throw new Error("a streamable PNG must not be read whole");
            }),
        };
        const before = b.ids();
        const id = await b.cards.importCharacterProcess({
            name: "rereadable.png",
            data: kind === "bytes" ? bytes : (blob as unknown as Blob),
        });
        if (kind === "Blob-like") {
            expect(blob.stream).toHaveBeenCalledTimes(2);
            expect(blob.arrayBuffer).not.toHaveBeenCalled();
        }
        expect(b.ids()).toEqual([...before, id]);
        expect(plain(b.character(id!).additionalAssets)).toEqual(
            values.map((_, i) => [`Asset ${i}`, `asset-${i + 1}`, "png"]),
        );
        expect(assetProgress()).toEqual(
            ["0.00", "33.33", "66.67", "100.00"].map((submsg) => ({
                type: "progress",
                msg: "Loading... (Loading Assets)",
                submsg,
            })),
        );
        expect(alerts.wait).not.toHaveBeenCalled();
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("readGenerator yields the fixture's text and stripped image for bytes, Blobs, and streams", async () => {
        const { PngChunk, api } = await boot();
        const texts = { chara: cardV3("Reader"), "chara-ext-asset_0": { asset: "payload" }, Comment: "kept text" };
        const bytes = pngWithText(texts);
        const textChunks = Object.entries(texts).map(([key, value]) => ({
            key,
            value: Buffer.from(JSON.stringify(value)).toString("base64"),
        }));
        // The fixture without text has exactly the same signature, IHDR and IEND.
        const stripped = pngWithText({});
        for (const returnTrimed of [false, true]) {
            const localBlob = new Blob([new Uint8Array(bytes)]);
            // Exercise happy-dom's byte fallback explicitly, even if it gains stream().
            Object.defineProperty(localBlob, "stream", { value: undefined });
            const responseBlob = await new Response(new Uint8Array(bytes)).blob();
            const wholeRead = vi.spyOn(responseBlob, "arrayBuffer");
            const blobStream = vi.spyOn(responseBlob, "stream");
            for (const input of [bytes, localBlob, responseBlob, streamed(bytes, 7).stream]) {
                const actual = [];
                for await (const chunk of PngChunk.readGenerator(input, { returnTrimed })) {
                    actual.push(chunk instanceof api.AppendableBuffer ? chunk.buffer : chunk);
                }
                expect(actual).toEqual(returnTrimed ? [...textChunks, stripped] : textChunks);
            }
            expect(blobStream).toHaveBeenCalledTimes(1);
            expect(wholeRead).not.toHaveBeenCalled();
        }
    });

    it("readGenerator drops consumed bytes so large asset chunks keep a bounded stream window", async () => {
        const { PngChunk, api } = await boot();
        const texts = Object.fromEntries(
            // Four chunks of about 260 KB, each larger than the 200 KB drop point: about 1 MB in all, so a
            // window that keeps consumed bytes exceeds the limit below.
            Array.from({ length: 4 }, (_, i) => [`chara-ext-asset_${i}`, `${i}:` + "x".repeat(192 * 1024)]),
        );
        const expected = Object.entries(texts).map(([key, value]) => ({
            key,
            value: Buffer.from(JSON.stringify(value)).toString("base64"),
        }));
        const pullSize = 16 * 1024;
        const largestChunk = Math.max(...expected.map(({ key, value }) => key.length + value.length + 13));
        // A consumed prefix of about 200 KB, one current PNG chunk, and one source read of overshoot.
        const windowLimit = 200_000 + largestChunk + pullSize;
        let peakRetained = 0;
        const append = api.AppendableBuffer.prototype.append;
        vi.spyOn(api.AppendableBuffer.prototype, "append").mockImplementation(function (data) {
            append.call(this, data);
            peakRetained = Math.max(peakRetained, this.length() - this.deapended);
        });
        const source = streamed(pngWithText(texts), pullSize);
        let index = 0;
        for await (const chunk of PngChunk.readGenerator(source.stream)) {
            expect(chunk).toEqual(expected[index++]);
        }
        expect(index).toBe(expected.length);
        expect(peakRetained).toBeLessThanOrEqual(windowLimit);
    });

    it.each(["#import=", "launch queue"])("%s hands the PNG Blob/File itself to the importer", async (entry) => {
        const b = await boot();
        const response = new Response(new Uint8Array(pngWithText({ chara: cardV3("Linked") })), {
            headers: { "content-disposition": 'attachment; filename="linked.png"' },
        });
        const blob = await response.blob();
        vi.spyOn(response, "blob").mockResolvedValue(blob);
        const file = new File([new Uint8Array(pngWithText({ chara: cardV3("Linked") }))], "linked.png");
        const input = entry === "#import=" ? blob : file;
        const wholeRead = vi.spyOn(input, "arrayBuffer");
        const responseRead = vi.spyOn(response, "arrayBuffer");
        const fileReader = vi.spyOn(FileReader.prototype, "readAsArrayBuffer");
        const reading = stubPngReader(b);
        const before = b.ids();
        if (entry === "#import=") {
            vi.stubGlobal("location", new URL("http://localhost/#import=https://example.test/linked.png"));
            const fetch = vi.fn(async () => response);
            vi.stubGlobal("fetch", fetch);
            await b.cards.characterURLImport();
            expect(fetch).toHaveBeenCalledExactlyOnceWith("https://example.test/linked.png", { method: "GET" });
        } else {
            const setConsumer = vi.fn();
            vi.stubGlobal("launchQueue", { setConsumer });
            await b.cards.characterURLImport();
            expect(setConsumer).toHaveBeenCalledTimes(1);
            const getFile = vi.fn(async () => file);
            setConsumer.mock.calls[0][0]({ files: [{ name: file.name, getFile }] });
            await vi.advanceTimersByTimeAsync(0);
            expect(getFile).toHaveBeenCalledTimes(1);
        }
        expect(reading).toHaveBeenCalledTimes(2);
        for (const [data] of reading.mock.calls) expect(data).toBe(input);
        expect(b.ids()).toHaveLength(before.length + 1);
        expect(wholeRead).not.toHaveBeenCalled();
        expect(responseRead).not.toHaveBeenCalled();
        expect(fileReader).not.toHaveBeenCalled();
        expect(alerts.error).not.toHaveBeenCalled();
    });

    // The Realm download no longer reaches the tab's reader: the server reads it (`characterCardsRealmImport.test.ts`).
    it("Chub hands the PNG response body stream to the importer", async () => {
        const b = await boot();
        const response = new Response(streamed(pngWithText({ chara: cardV3("Downloaded") })).stream, {
            headers: { "content-type": "image/png" },
        });
        const responseRead = vi.spyOn(response, "arrayBuffer");
        const blobRead = vi.spyOn(response, "blob");
        const reading = stubPngReader(b);
        const before = b.ids();
        const fetch = vi.fn(async () => response);
        vi.stubGlobal("fetch", fetch);
        vi.stubGlobal("location", new URL("http://localhost/?charahub=author/card"));
        await b.cards.characterURLImport();
        expect(fetch).toHaveBeenCalledWith(
            "https://api.chub.ai/api/characters/download",
            expect.objectContaining({ method: "POST" }),
        );
        expect(reading.mock.calls[0]?.[0]).toBe(response.body);
        expect(reading).toHaveBeenCalledTimes(1);
        expect(b.ids()).toHaveLength(before.length + 1);
        expect(responseRead).not.toHaveBeenCalled();
        expect(blobRead).not.toHaveBeenCalled();
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("AppendableBuffer.slice uses deappended indices and the used length without copying the retained window", async () => {
        const { api } = await boot();
        const buffer = new api.AppendableBuffer();
        buffer.append(new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17]));
        buffer.deappend(3);
        buffer.append(new Uint8Array([18, 19]));
        let copiedBytes = 0;
        const slice = Uint8Array.prototype.slice;
        const copies = vi.spyOn(Uint8Array.prototype, "slice").mockImplementation(function (start, end) {
            const result = slice.call(this, start, end);
            copiedBytes += result.length;
            return result;
        });
        const slices = [buffer.slice(4, 7), buffer.slice(3, 1000), buffer.slice(1, 2), buffer.slice(1000, 2000)];
        copies.mockRestore();
        expect(slices).toEqual([
            new Uint8Array([14, 15, 16]),
            new Uint8Array([13, 14, 15, 16, 17, 18, 19]),
            new Uint8Array([18]),
            new Uint8Array(),
        ]);
        // Only the requested 3 + 7 + 1 bytes need copying, regardless of retained capacity.
        expect(copiedBytes).toBeLessThanOrEqual(11);
    });
});
