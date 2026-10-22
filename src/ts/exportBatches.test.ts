import * as fflate from "fflate";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { encodeAssetRecordHeader } from "../../shared/assetBatch.ts";
import { encodeRPack } from "../../shared/rpack.ts";
import { decodeModuleMain, readModuleFileHeader } from "../../shared/moduleImport.ts";
import { pngWithText } from "./storage/tests/importFixtures";
import { bootMutations, warmMutationGraph } from "./storage/tests/mutationStoresHarness";

// Real exporters, batch client, writers, and importers. Only authentication, UI, image conversion,
// and the download sink are replaced at their external boundaries.
const { server, alerts, assets } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        confirm: vi.fn(async () => true),
        store: { set: vi.fn(), subscribe: vi.fn() },
        cardExport: vi.fn(),
    },
    assets: { saved: [] as Uint8Array[] },
}));

vi.mock("./storage/serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("./alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertNormalWait: alerts.normalWait,
        alertConfirm: alerts.confirm,
        alertStore: alerts.store,
        alertCardExport: alerts.cardExport,
    }),
);
vi.mock("./parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
    parseMarkdownSafe: vi.fn(),
}));
vi.mock("./process/index.svelte", () => ({ doingChat: { set: vi.fn(), subscribe: vi.fn() } }));
vi.mock("./translator/translator", () => ({ translateHTML: vi.fn() }));
vi.mock("./process/inlayScreen", () => ({ updateInlayScreen: vi.fn() }));
// The PNG branch of the real reencoder returns the bytes unchanged; the identity here matches it.
vi.mock("./process/files/inlays", () => ({
    reencodeImage: vi.fn(async (img: Uint8Array) => img),
    getInlayAsset: vi.fn(),
    writeInlayImage: vi.fn(),
}));
vi.mock("./tokenizer", () => ({ tokenize: vi.fn(async () => 0) }));
vi.mock("./rpack/rpack_js", () => {
    const map = new Uint8Array(readFileSync(path.resolve(__dirname, "./rpack/rpack_map.bin")));
    const apply = (table: Uint8Array) => async (data: Uint8Array) => {
        const result = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
            result[i] = table[data[i]];
        }
        return result;
    };
    return { encodeRPack: apply(map.slice(0, 256)), decodeRPack: apply(map.slice(256, 512)) };
});

const PORTRAIT = pngWithText({});
const PAYLOAD = new Uint8Array([71, 73, 70, 56, 57, 97, 42]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const flush = () => vi.advanceTimersByTimeAsync(0);
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function character(extra: Record<string, unknown> = {}) {
    return {
        name: "Batched",
        type: "character",
        image: "assets/portrait.png",
        desc: "description",
        firstMessage: "hello",
        globalLore: [],
        emotionImages: [],
        additionalAssets: [],
        customscript: [],
        triggerscript: [],
        bias: [],
        viewScreen: "none",
        utilityBot: false,
        sdData: {},
        additionalData: { creator: "test", character_version: "1" },
        ...extra,
    } as any;
}

function moduleFixture(keys: string[]) {
    return {
        id: "module-id",
        name: "Batched",
        description: "",
        icon: "assets/portrait.png",
        assets: keys.map((key, i) => [`asset-${i}`, key, "png"] as [string, string, string]),
    };
}

function batchResponse(keys: readonly string[], data: Map<string, Uint8Array>) {
    return new Response(
        Buffer.concat(
            keys.flatMap((key) => {
                const bytes = data.get(key) ?? new Uint8Array(0);
                return [encodeAssetRecordHeader(key, bytes.length), bytes];
            }),
        ),
    );
}

async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const api = await import("./globalApi.svelte");
    vi.spyOn(api, "saveAsset").mockImplementation(async (bytes) => {
        assets.saved.push(bytes);
        return `assets/saved-${assets.saved.length}.png`;
    });
    // The bulk importers' batched writes (`saveAssets`): one key per item, every item recorded.
    let batched = 0;
    vi.spyOn(api, "assetKey").mockImplementation(async () => `assets/batched-${++batched}.png`);
    vi.spyOn(api, "saveAssetBatch").mockImplementation(async (items) => {
        for (const { bytes } of items) assets.saved.push(bytes);
    });
    vi.spyOn(api, "readImage").mockResolvedValue(PORTRAIT);
    const download = vi.spyOn(api, "downloadFile").mockResolvedValue(undefined);
    const util = await import("./util");
    vi.spyOn(util, "sleep").mockResolvedValue(undefined);
    const media = await import("./media");
    const compress = vi.spyOn(media, "compressImage").mockImplementation(async (bytes) => bytes);
    const cards = await import("./characterCards");
    const modules = await import("./process/modules");
    const { PngChunk } = await import("./pngChunk");
    const { CharXWriter } = await import("./process/processzip");
    const data = new Map<string, Uint8Array>();
    const requests: { keys: string[]; signal: AbortSignal }[] = [];
    const realFetch = booted.fake.fetch.bind(booted.fake);
    const transport = vi.spyOn(booted.fake, "fetch").mockImplementation(async (url, init: RequestInit) => {
        if (url !== "/api/assets/read") return realFetch(url, init);
        expect(init.method).toBe("POST");
        const keys = JSON.parse(init.body as string).keys;
        requests.push({ keys, signal: init.signal! });
        return batchResponse(keys, data);
    });
    const chunks: Uint8Array[] = [];
    const sink = {
        write: vi.fn((bytes: Uint8Array) => {
            chunks.push(bytes.slice());
        }),
        close: vi.fn(),
        abort: vi.fn(),
    };
    const init = vi.spyOn(api.LocalWriter.prototype, "init").mockImplementation(async function () {
        this.writer = new WritableStream<Uint8Array>(sink).getWriter();
        return true;
    });
    const abort = vi.spyOn(api.LocalWriter.prototype, "abort");
    return {
        ...booted,
        api,
        cards,
        modules,
        PngChunk,
        CharXWriter,
        data,
        requests,
        transport,
        chunks,
        sink,
        init,
        abort,
        download,
        downloaded: () => {
            const bytes = download.mock.calls[0][1];
            expect(bytes).toBeInstanceOf(Uint8Array);
            return bytes as Uint8Array;
        },
        compress,
        output: () => Buffer.concat(chunks),
    };
}

beforeAll(
    () =>
        warmMutationGraph(() =>
            Promise.all([
                import("./storage/database.svelte"),
                import("./globalApi.svelte"),
                import("./util"),
                import("./media"),
                import("./characterCards"),
                import("./process/modules"),
                import("./pngChunk"),
                import("./process/processzip"),
            ]),
        ),
    60_000,
);

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    vi.stubGlobal("safeStructuredClone", (value: unknown) =>
        value === undefined ? undefined : JSON.parse(JSON.stringify(value)),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    assets.saved.length = 0;
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("batched exports", () => {
    it.each(["risum", "png", "charx", "json", "v2 VITS"] as const)(
        "%s consumes a batch while the next 200-key POST is pending",
        async (format) => {
            const h = await boot();
            const keys = Array.from({ length: 401 }, (_, i) => `assets/${i}.png`);
            keys[1] = keys[0];
            keys.forEach((key) => h.data.set(key, PAYLOAD));
            const gates = Array.from({ length: 3 }, () => deferred<Response>());
            let active = 0;
            let peak = 0;
            const original = h.transport.getMockImplementation()!;
            h.transport.mockImplementation(async (url, init) => {
                if (url !== "/api/assets/read") return original(url, init);
                const index = h.requests.length;
                h.requests.push({ keys: JSON.parse(init.body as string).keys, signal: init.signal! });
                peak = Math.max(peak, ++active);
                try {
                    return await gates[index].promise;
                } finally {
                    active--;
                }
            });
            let finished = false;
            const exporting = (
                format === "risum"
                    ? h.modules.exportModuleLegacy(moduleFixture(keys))
                    : h.cards.exportCharacterCard(
                          character(
                              format === "v2 VITS"
                                  ? {
                                        ttsMode: "vits",
                                        vits: { files: Object.fromEntries(keys.map((key, i) => [`voice-${i}`, key])) },
                                    }
                                  : { additionalAssets: moduleFixture(keys).assets },
                          ),
                          format === "v2 VITS" ? "png" : format,
                          { spec: format === "v2 VITS" ? "v2" : "v3" },
                      )
            ).finally(() => {
                finished = true;
            });
            await flush();
            expect(h.requests.map((r) => r.keys)).toEqual([keys.slice(0, 200)]);
            const beforeAssets = h.output().length;
            // The next POST is already pending when the first asset of a batch is used (compressed
            // for the JSON card, written out otherwise), not only once the batch is consumed.
            let requestsAtFirstUse: number | undefined;
            const noteFirstUse = () => {
                requestsAtFirstUse ??= h.requests.length;
            };
            if (format === "json") {
                h.compress.mockImplementation(async (bytes) => {
                    noteFirstUse();
                    return bytes;
                });
            } else {
                const write = h.sink.write.getMockImplementation()!;
                h.sink.write.mockImplementation((bytes) => {
                    noteFirstUse();
                    return write(bytes);
                });
            }
            gates[0].resolve(batchResponse(keys.slice(0, 200), h.data));
            await flush();
            expect(h.requests.map((r) => r.keys)).toEqual([keys.slice(0, 200), keys.slice(200, 400)]);
            expect(requestsAtFirstUse).toBe(2);
            expect(active).toBe(1);
            expect(finished).toBe(false);
            if (format === "json") expect(h.compress).toHaveBeenCalledTimes(200);
            else expect(h.output().length).toBeGreaterThan(beforeAssets);
            expect(h.sink.close).not.toHaveBeenCalled();
            gates[1].resolve(batchResponse(keys.slice(200, 400), h.data));
            await flush();
            expect(h.requests.map((r) => r.keys)).toEqual([keys.slice(0, 200), keys.slice(200, 400), keys.slice(400)]);
            gates[2].resolve(batchResponse(keys.slice(400), h.data));
            await exporting;
            expect(peak).toBe(1);
            expect(h.transport.mock.calls.some(([url]) => url === "/api/read")).toBe(false);
            expect(alerts.normal).toHaveBeenCalledExactlyOnceWith(language.successExport);
            expect(alerts.error).not.toHaveBeenCalled();
        },
    );

    it.each([true, false])("risum preserves framing and both readers with saveData=%s", async (saveData) => {
        const h = await boot();
        h.data.set("assets/a.png", PAYLOAD);
        // Real image conversion is a separate contract. This sentinel proves rpack follows it.
        const compressed = new Uint8Array([99, ...PAYLOAD]);
        h.compress.mockResolvedValue(compressed);
        const module = moduleFixture(["assets/a.png", "assets/a.png"]);
        const main = encodeRPack(
            Buffer.from(
                JSON.stringify(
                    {
                        module: {
                            ...module,
                            assets: [
                                ["asset-0", "", "png"],
                                ["asset-1", "", "png"],
                            ],
                        },
                        type: "risuModule",
                    },
                    null,
                    2,
                ),
            ),
        );
        const length = (n: number) => {
            const bytes = Buffer.alloc(4);
            bytes.writeUInt32LE(n);
            return bytes;
        };
        const packed = encodeRPack(compressed);
        const expected = Buffer.concat([
            new Uint8Array([111, 0]),
            length(main.length),
            main,
            new Uint8Array([1]),
            length(packed.length),
            packed,
            new Uint8Array([1]),
            length(packed.length),
            packed,
            new Uint8Array([0]),
        ]);
        const result = await h.modules.exportModuleLegacy(module, { saveData, alertEnd: false });
        if (saveData) {
            expect(result).toBeUndefined();
            expect(h.init).toHaveBeenCalledExactlyOnceWith("Batched", ["risum"]);
            expect(h.sink.close).toHaveBeenCalledOnce();
        } else {
            expect(result).toBeInstanceOf(Uint8Array);
            expect(h.init).not.toHaveBeenCalled();
        }
        const bytes = saveData ? h.output() : Buffer.from(result!);
        expect(bytes).toEqual(expected);
        expect(module.assets.map((a) => a[1])).toEqual(["assets/a.png", "assets/a.png"]);
        const { mainLength } = readModuleFileHeader(bytes);
        expect(decodeModuleMain(Uint8Array.from(bytes.subarray(6, 6 + mainLength)))).toMatchObject({
            assets: [
                ["asset-0", "", "png"],
                ["asset-1", "", "png"],
            ],
        });
        const read = await h.modules.readModule(Buffer.from(bytes));
        expect(read.assets.map((a) => a[0])).toEqual(["asset-0", "asset-1"]);
        expect(assets.saved).toEqual([compressed, compressed]);
        expect(alerts.normal).not.toHaveBeenCalled();
    });

    it.each(["png", "charx", "json"] as const)(
        "v3 %s preserves original-list URI skips, portrait numbering, and duplicate payloads",
        async (format) => {
            const h = await boot();
            h.data.set("assets/a.png", PAYLOAD);
            const known = "https://example.test/remote.png";
            const skipped = "http://example.test/another.png";
            const input = character({
                ccAssets: [
                    { type: "icon", uri: known, name: "remote", ext: "png" },
                    { type: "icon", uri: "ccdefault:", name: "early", ext: "png" },
                    { type: "emotion", uri: "assets/a.png", name: "", ext: "png" },
                    { type: "icon", uri: skipped, name: "remote-again", ext: "png" },
                    { type: "emotion", uri: "assets/a.png", name: "duplicate", ext: "png" },
                ],
            });
            await h.cards.exportCharacterCard(input, format, { spec: "v3" });
            expect(h.requests.map((r) => r.keys)).toEqual([["assets/a.png", "assets/a.png"]]);
            let card: any;
            if (format === "png") {
                const chunks = h.PngChunk.read(
                    h.output(),
                    ["ccv3", "chara-ext-asset_:1", "chara-ext-asset_:2", "chara-ext-asset_:3"],
                    { checkCrc: true },
                );
                card = JSON.parse(Buffer.from(chunks.ccv3, "base64").toString());
                expect(chunks["chara-ext-asset_:1"]).toBe(b64(PAYLOAD));
                expect(chunks["chara-ext-asset_:2"]).toBe(b64(PAYLOAD));
                expect(chunks).not.toHaveProperty("chara-ext-asset_:3");
                expect(card.data.assets.map((a: any) => a.uri)).toEqual([
                    known,
                    "ccdefault:",
                    "__asset:1",
                    skipped,
                    "__asset:2",
                    "ccdefault:",
                ]);
            } else if (format === "charx") {
                const zip = fflate.unzipSync(h.output());
                card = JSON.parse(Buffer.from(zip["card.json"]).toString());
                const paths = [
                    "assets/icon/image/early.png",
                    "assets/emotion/image/asset_2.png",
                    "assets/emotion/image/duplicate.png",
                    "assets/icon/image/main.png",
                ];
                expect(card.data.assets.map((a: any) => a.uri)).toEqual([
                    known,
                    `embeded://${paths[0]}`,
                    `embeded://${paths[1]}`,
                    skipped,
                    `embeded://${paths[2]}`,
                    `embeded://${paths[3]}`,
                ]);
                paths.forEach((name, i) =>
                    expect(Array.from(zip[name])).toEqual(Array.from(i === 0 || i === 3 ? PORTRAIT : PAYLOAD)),
                );
                expect(zip["module.risum"]).toBeDefined();
            } else {
                card = JSON.parse(Buffer.from(h.downloaded()).toString());
                const uri = (bytes: Uint8Array) => `data:application/octet-stream;base64,${b64(bytes)}`;
                expect(card.data.assets.map((a: any) => a.uri)).toEqual([
                    known,
                    uri(PORTRAIT),
                    uri(PAYLOAD),
                    skipped,
                    uri(PAYLOAD),
                    uri(PORTRAIT),
                ]);
            }
            // Import the actual exported bytes, including the skipped remote URI fixtures.
            const file =
                format === "json"
                    ? { name: "export.json", data: h.downloaded() }
                    : { name: `export.${format}`, data: h.output() };
            const before = h.characterList().length;
            await h.cards.importCharacterProcess(file);
            expect(h.characterList()).toHaveLength(before + 1);
            expect(assets.saved.some((bytes) => b64(bytes) === b64(PAYLOAD))).toBe(true);
            expect(alerts.error).not.toHaveBeenCalled();
        },
    );

    it("v2 writes VITS positions as uncompressed PNG chunks and __asset references", async () => {
        const h = await boot();
        h.data.set("assets/voice.bin", PAYLOAD);
        h.compress.mockResolvedValue(new Uint8Array([255]));
        await h.cards.exportCharacterCard(
            character({
                ttsMode: "vits",
                vits: {
                    files: {
                        "model.onnx": "assets/voice.bin",
                        "config.json": "assets/voice.bin",
                    },
                },
            }),
            "png",
            { spec: "v2" },
        );
        const chunks = h.PngChunk.read(h.output(), ["chara", "chara-ext-asset_:1", "chara-ext-asset_:2"], {
            checkCrc: true,
        });
        expect(JSON.parse(Buffer.from(chunks.chara, "base64").toString()).data.extensions.risuai.vits).toEqual({
            "model.onnx": "__asset:1",
            "config.json": "__asset:2",
        });
        expect(chunks["chara-ext-asset_:1"]).toBe(b64(PAYLOAD));
        expect(chunks["chara-ext-asset_:2"]).toBe(b64(PAYLOAD));
        expect(h.compress).not.toHaveBeenCalled();
        expect(h.requests.map((r) => r.keys)).toEqual([["assets/voice.bin", "assets/voice.bin"]]);
    });

    it.each(["risum", "virtual risum", "png", "charx", "json", "v2 VITS", "module"] as const)(
        "%s writes empty records for missing and zero-length assets and reports their position count",
        async (format) => {
            const h = await boot();
            h.data.set("assets/empty.png", new Uint8Array(0));
            const keys = ["assets/missing.png", "assets/empty.png", "assets/missing.png"];
            if (format === "risum" || format === "virtual risum") {
                const result = await h.modules.exportModuleLegacy(moduleFixture(keys), {
                    saveData: format === "risum",
                });
                const read = await h.modules.readModule(format === "risum" ? h.output() : Buffer.from(result));
                expect(read.assets).toHaveLength(3);
                expect(assets.saved.map((b) => b.length)).toEqual([0, 0, 0]);
            } else if (format === "module") {
                await h.modules.exportModule(moduleFixture(keys));
            } else {
                await h.cards.exportCharacterCard(
                    character(
                        format === "v2 VITS"
                            ? {
                                  ttsMode: "vits",
                                  vits: { files: Object.fromEntries(keys.map((key, i) => [`voice-${i}`, key])) },
                              }
                            : { additionalAssets: moduleFixture(keys).assets },
                    ),
                    format === "v2 VITS" ? "png" : format,
                    { spec: format === "v2 VITS" ? "v2" : "v3" },
                );
            }
            if (["png", "v2 VITS"].includes(format)) {
                expect(
                    h.PngChunk.read(h.output(), ["chara-ext-asset_:1", "chara-ext-asset_:2", "chara-ext-asset_:3"]),
                ).toEqual({
                    "chara-ext-asset_:1": "",
                    "chara-ext-asset_:2": "",
                    "chara-ext-asset_:3": "",
                });
            } else if (format === "charx" || format === "module") {
                const zip = fflate.unzipSync(h.output());
                const card = JSON.parse(Buffer.from(zip["card.json"]).toString());
                expect(
                    card.data.assets.slice(0, 3).map((a: any) => zip[a.uri.replace("embeded://", "")].length),
                ).toEqual([0, 0, 0]);
            } else if (format === "json") {
                const card = JSON.parse(Buffer.from(h.downloaded()).toString());
                expect(card.data.assets.slice(0, 3).map((a: any) => a.uri)).toEqual(
                    Array(3).fill("data:application/octet-stream;base64,"),
                );
            }
            expect(alerts.normal).toHaveBeenCalledExactlyOnceWith(language.exportMissingAssets.replace("{count}", "3"));
            expect(alerts.error).not.toHaveBeenCalled();
        },
    );

    it.each(["owned", "borrowed"])("a missing portrait fails the %s card export", async (ownership) => {
        const h = await boot();
        vi.mocked(h.api.readImage).mockResolvedValue(null);
        const writer = ownership === "borrowed" ? new h.api.LocalWriter() : undefined;
        if (writer) await writer.init("caller", ["png"]);
        const exporting = h.cards.exportCharacterCard(character(), "png", { spec: "v3", writer });
        if (writer) await expect(exporting).rejects.toBeInstanceOf(Error);
        else await exporting;
        expect(h.abort).toHaveBeenCalledOnce();
        expect(h.requests).toHaveLength(0);
        expect(h.sink.close).not.toHaveBeenCalled();
        expect(alerts.normal).not.toHaveBeenCalled();
        if (writer) expect(alerts.error).not.toHaveBeenCalled();
        else expect(alerts.error).toHaveBeenCalledOnce();
    });
});

describe("export failure ownership", () => {
    const owners = [
        "risum",
        "embedded risum",
        "exportChar png",
        "exportChar v2",
        "exportChar charx",
        "borrowed png",
        "borrowed charx",
        "module",
    ] as const;
    const cases = owners.flatMap((owner) =>
        ["read", "write", "close", ...(owner.includes("charx") || owner === "module" ? ["zip"] : [])].map(
            (failure) => ({ owner, failure }),
        ),
    );

    it.each(cases)(
        "$owner aborts on $failure, cancels prefetch, and reports at its owning boundary",
        async ({ owner, failure }) => {
            const h = await boot();
            const error = new Error(`failed ${failure}`);
            // Read, write and zip fail while the next batch is prefetched: three batches. A close fails
            // after every batch, so one batch of three assets reaches it the same way.
            const keys = Array.from({ length: failure === "close" ? 3 : 401 }, (_, i) => `assets/${i}.png`);
            keys.forEach((key) => h.data.set(key, PAYLOAD));
            const original = h.transport.getMockImplementation()!;
            const cancelled = vi.fn();
            h.transport.mockImplementation(async (url, init) => {
                if (url !== "/api/assets/read" || h.requests.length !== 1 || failure === "close")
                    return original(url, init);
                h.requests.push({ keys: JSON.parse(init.body as string).keys, signal: init.signal! });
                if (failure === "read") return new Response("failed read", { status: 500 });
                return new Promise<Response>((_resolve, reject) => {
                    init.signal!.addEventListener(
                        "abort",
                        () => {
                            cancelled();
                            reject(init.signal!.reason);
                        },
                        { once: true },
                    );
                });
            });
            const virtualAbort = vi.spyOn(h.api.VirtualWriter.prototype, "abort");
            const Writer = owner === "embedded risum" ? h.api.VirtualWriter : h.api.LocalWriter;
            if (failure === "write") {
                const write = Writer.prototype.write;
                vi.spyOn(Writer.prototype, "write").mockImplementation(function (bytes) {
                    // Fail inside batch consumption, after the prefetch is pending, not at the header.
                    if (h.requests.length >= 2) return Promise.reject(error);
                    return write.call(this, bytes);
                });
            } else if (failure === "close") {
                vi.spyOn(Writer.prototype, "close").mockRejectedValue(error);
            } else if (failure === "zip") {
                const add = fflate.Zip.prototype.add;
                vi.spyOn(fflate.Zip.prototype, "add").mockImplementation(function (file) {
                    add.call(this, file);
                    this.ondata!(error, new Uint8Array(0), false);
                });
            }
            const writer = owner.startsWith("borrowed") ? new h.api.LocalWriter() : undefined;
            if (writer) await writer.init("caller", [owner.endsWith("charx") ? "charx" : "png"]);
            const input = character(
                owner === "exportChar v2"
                    ? {
                          ttsMode: "vits",
                          vits: { files: Object.fromEntries(keys.map((key, i) => [`voice-${i}`, key])) },
                      }
                    : { additionalAssets: moduleFixture(keys).assets },
            );
            let exporting: Promise<unknown>;
            if (owner === "risum" || owner === "embedded risum") {
                exporting = h.modules.exportModuleLegacy(moduleFixture(keys), {
                    saveData: owner === "risum",
                    alertEnd: owner === "risum",
                });
            } else if (owner === "module") {
                exporting = h.modules.exportModule(moduleFixture(keys));
            } else if (owner.startsWith("exportChar")) {
                const id = h.characterStore.addCharacter(input);
                alerts.cardExport.mockResolvedValue({
                    type: owner === "exportChar v2" ? "ccv2" : "",
                    type2: owner.endsWith("charx") ? "charx" : "png",
                });
                exporting = h.cards.exportChar(id);
            } else {
                exporting = h.cards.exportCharacterCard(input, owner.endsWith("charx") ? "charx" : "png", {
                    spec: "v3",
                    writer,
                });
            }
            // Attach immediately: borrowed errors must not be handled by the callee's UI.
            const outcome = exporting.then(
                (value) => ({ value }),
                (reason) => ({ reason }),
            );
            await flush();
            const result = await outcome;
            const expectedError = failure === "read" ? "getItem Error" : error;
            if (owner.startsWith("borrowed") || owner === "embedded risum") {
                expect(result).toEqual({ reason: expectedError });
                expect(alerts.error).not.toHaveBeenCalled();
            } else {
                expect(alerts.error).toHaveBeenCalledExactlyOnceWith(expectedError);
            }
            expect(alerts.normal).not.toHaveBeenCalled();
            expect(owner === "embedded risum" ? virtualAbort : h.abort).toHaveBeenCalledWith(expectedError);
            if (owner !== "embedded risum") expect(h.sink.abort).toHaveBeenCalledExactlyOnceWith(expectedError);
            expect(h.sink.close).not.toHaveBeenCalled();
            if (failure === "write" || failure === "zip") {
                expect(cancelled).toHaveBeenCalledOnce();
                expect(h.requests[1].signal.aborted).toBe(true);
            }
            expect(h.requests).toHaveLength(failure === "close" ? 1 : 2);
            // Even across retry timers, a stopped export cannot send another batch.
            await vi.advanceTimersByTimeAsync(180_000);
            expect(h.requests).toHaveLength(failure === "close" ? 1 : 2);
            expect(h.transport.mock.calls.some(([url]) => url === "/api/read")).toBe(false);
        },
    );
});

describe("export writer completion", () => {
    it.each(["resolve", "reject"] as const)("PNG end waits for close to %s", async (completion) => {
        const h = await boot();
        const gate = deferred<void>();
        const failure = new Error("close failed");
        const output = new h.api.LocalWriter();
        output.writer = new WritableStream<Uint8Array>({ close: () => gate.promise }).getWriter();
        const writer = new h.PngChunk.streamWriter(PORTRAIT, output);
        await writer.init();
        let settled = false;
        const ending = writer.end().then(
            (value) => {
                settled = true;
                return value;
            },
            (error) => {
                settled = true;
                return error;
            },
        );
        await flush();
        const beforeClose = settled;
        if (completion === "resolve") gate.resolve();
        else gate.reject(failure);
        const result = await ending;
        expect(beforeClose).toBe(false);
        expect(result).toBe(completion === "resolve" ? undefined : failure);
    });

    it.each(["write", "end"] as const)("CharX rethrows a callback error at the next %s", async (operation) => {
        const h = await boot();
        const output = new h.api.VirtualWriter();
        const write = vi.spyOn(output, "write");
        const close = vi.spyOn(output, "close");
        const writer = new h.CharXWriter(output);
        const failure = Object.assign(new Error("zip callback failed"), { code: 1 as const });
        // Inject through fflate's public callback, the same boundary used for async zip errors.
        expect(() => writer.zip.ondata!(failure, new Uint8Array(0), false)).not.toThrow();
        await expect(operation === "write" ? writer.write("asset.png", PAYLOAD) : writer.end()).rejects.toBe(failure);
        expect(write).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
    });

    it.each(["before init", "after close", "twice", "rejecting sink"] as const)(
        "LocalWriter abort never throws: %s",
        async (state) => {
            const { LocalWriter } = await import("./globalApi.svelte");
            const writer = new LocalWriter();
            const failure = new Error("abort failed");
            const abort = vi.fn(() => (state === "rejecting sink" ? Promise.reject(failure) : undefined));
            if (state !== "before init") writer.writer = new WritableStream<Uint8Array>({ abort }).getWriter();
            if (state === "after close") await writer.close();
            await expect(writer.abort(failure)).resolves.toBeUndefined();
            await expect(writer.abort(failure)).resolves.toBeUndefined();
            expect(abort).toHaveBeenCalledTimes(state === "twice" || state === "rejecting sink" ? 1 : 0);
        },
    );
});

// A JSON card embeds every asset as a data URI, so past the cap it refuses before
// `JSON.stringify`. Reads go through a `loadAssets` spy to avoid encoding 64 MiB batch bodies.
describe("JSON export asset cap", () => {
    async function capped(sizes: (Uint8Array | "pending")[], compressed?: Uint8Array) {
        const h = await boot();
        if (compressed) h.compress.mockResolvedValue(compressed);
        const keys = sizes.map((_, i) => `assets/${i}.png`);
        const reads: { keys: readonly string[]; signal: AbortSignal }[] = [];
        const cancelled = vi.fn();
        vi.spyOn(h.api, "loadAssets").mockImplementation(async (batch, { signal } = {}) => {
            reads.push({ keys: batch, signal: signal! });
            const start = keys.indexOf(batch[0]);
            const values = sizes.slice(start, start + batch.length);
            if (values.includes("pending")) {
                return new Promise((_resolve, reject) =>
                    signal!.addEventListener(
                        "abort",
                        () => {
                            cancelled();
                            reject(signal!.reason);
                        },
                        { once: true },
                    ),
                );
            }
            return values as Uint8Array[];
        });
        const input = character({ additionalAssets: moduleFixture(keys).assets });
        const stringify = vi.spyOn(JSON, "stringify");
        const result = await h.cards.exportCharacterCard(input, "json", { spec: "v3" });
        return { h, reads, cancelled, stringify, result };
    }
    const half = () => new Uint8Array(32 * 1024 * 1024);

    it("exports a card whose assets, portrait included, total exactly 64 MiB", async () => {
        const { h, result } = await capped([half(), half().subarray(PORTRAIT.length)], PAYLOAD);
        expect(h.cards.JSON_EXPORT_ASSET_LIMIT).toBe(64 * 1024 * 1024);
        expect(result).toEqual({ missingAssets: 0 });
        expect(h.download).toHaveBeenCalledOnce();
        const card = JSON.parse(Buffer.from(h.downloaded()).toString());
        expect(card.data.assets.map((asset: { uri: string }) => asset.uri)).toEqual(
            Array(3).fill(`data:application/octet-stream;base64,${b64(PAYLOAD)}`),
        );
        expect(alerts.normal).toHaveBeenCalledExactlyOnceWith(language.successExport);
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("refuses at the embedded portrait one byte over, before stringifying", async () => {
        const { h, stringify, result } = await capped([half(), half().subarray(PORTRAIT.length - 1)], PAYLOAD);
        expect(result).toBeUndefined();
        expect(alerts.error).toHaveBeenCalledExactlyOnceWith(new Error(language.jsonExportTooLarge));
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(h.download).not.toHaveBeenCalled();
        // Only the two assets were compressed; the portrait that crossed the cap was not.
        expect(h.compress).toHaveBeenCalledTimes(2);
        expect(stringify.mock.calls.some(([value]) => value?.spec === "chara_card_v3")).toBe(false);
    });

    it("refuses as the over-cap batch arrives and cancels the pending read", async () => {
        // The first batch crosses the cap at its third asset; the second batch is still pending.
        const sizes: (Uint8Array | "pending")[] = [half(), half(), new Uint8Array(1)];
        sizes.push(...Array.from({ length: 197 }, () => PAYLOAD), ...Array<"pending">(3).fill("pending"));
        // The cap counts the bytes read, not the encoded ones: compressing to a few bytes keeps the
        // halves from being base64-encoded, which only cost time.
        const { h, reads, cancelled, result } = await capped(sizes, PAYLOAD);
        expect(result).toBeUndefined();
        expect(reads.map((read) => read.keys.length)).toEqual([200, 3]);
        expect(cancelled).toHaveBeenCalledOnce();
        expect(reads[1].signal.aborted).toBe(true);
        expect(h.compress).toHaveBeenCalledTimes(2);
        expect(alerts.error).toHaveBeenCalledExactlyOnceWith(new Error(language.jsonExportTooLarge));
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(h.download).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(180_000);
        expect(reads).toHaveLength(2);
    });
});
