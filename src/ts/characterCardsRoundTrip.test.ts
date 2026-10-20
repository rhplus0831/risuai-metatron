import crc32 from "crc/crc32";
import * as fflate from "fflate";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cardV2, cardV3, charx } from "./storage/tests/importFixtures";
import { bootMutations } from "./storage/tests/mutationStoresHarness";

// Card export round trips (audit findings IO-01 to IO-03): a CharX archive's `embeded://` references
// name the members the zip writer actually wrote (sanitized, collision-renamed, and extensionless
// names included), a card's `depth_prompt` extension lands in the native field and the server record
// (JSON V3 and V2, CharX), and a PNG card exported from a portrait that carries other `tEXt` chunks is
// a CRC-valid PNG that keeps those chunks, drops the old card chunk, and imports back. The exporters,
// the zip writer, the PNG stream writer, the importers, and the store are real; dialogs, the asset
// store, image compression, and the RPack map fetch are isolated as in `characterCardsImport.test.ts`.

const { server, alerts, assets } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        confirm: vi.fn(async () => true),
        store: { set: vi.fn(), subscribe: vi.fn() },
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

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const GIF = new Uint8Array([71, 73, 70, 56, 57, 97]);

async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const globalApi = await import("./globalApi.svelte");
    vi.spyOn(globalApi, "saveAsset").mockImplementation((async (data: Uint8Array) => {
        assets.saved.push(data);
        return `asset-${assets.saved.length}`;
    }) as any);
    const util = await import("./util");
    vi.spyOn(util, "sleep").mockResolvedValue(undefined);
    const media = await import("./media");
    vi.spyOn(media, "compressImage").mockImplementation(async (bytes: Uint8Array) => bytes);
    const cards = await import("./characterCards");
    const ids = () => booted.characterList().map((entry: any) => entry.chaId as string);
    /** The server record of the character added since `before`, after a save cycle. */
    const saved = async (before: string[]) => {
        const chaId = ids().find((id) => !before.includes(id))!;
        expect(chaId).toBeDefined();
        await booted.sync.flushResources();
        return booted.record("characters", chaId);
    };
    return { ...booted, cards, globalApi, ids, saved };
}

/** A character as the exporters read it, with the given extra assets. */
function fixtureCharacter(extra: Record<string, unknown> = {}) {
    return {
        name: "Roundtrip",
        type: "character",
        image: "assets/icon.png",
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

function pngChunk(type: string, data: Uint8Array): Uint8Array {
    const typeBytes = new TextEncoder().encode(type);
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, data.byteLength);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, crc32(Buffer.concat([typeBytes, data])) >>> 0);
    return Buffer.concat([length, typeBytes, data, crc]);
}

/** A PNG with an `IHDR` placeholder and one raw `tEXt` chunk per entry, in order. */
function portrait(text: [string, string][]): Uint8Array {
    const encoder = new TextEncoder();
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk("IHDR", new Uint8Array(13)),
        ...text.map(([key, value]) =>
            pngChunk("tEXt", Buffer.concat([encoder.encode(key), new Uint8Array([0]), encoder.encode(value)])),
        ),
        pngChunk("IEND", new Uint8Array(0)),
    ]);
}

beforeAll(async () => {
    await import("./stores.svelte");
    await import("./storage/database.svelte");
    await import("./characterCards");
}, 60_000);

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

describe("CharXImporter asset admission", () => {
    it("holds about ten decoded unsaved assets while uploads of forty 96 KiB entries are stalled", async () => {
        const { globalApi } = await boot();
        const { CharXImporter, CharXWriter } = await import("./process/processzip");
        const output = new globalApi.VirtualWriter();
        const writer = new CharXWriter(output);
        for (let i = 0; i < 40; i++) {
            // Incompressible entries exceed a 64 KiB feed slice even after compression, so a
            // single synchronous unzip push cannot complete more than one asset.
            const data = randomBytes(96 * 1024);
            data[0] = i;
            await writer.write(`assets/${i}.png`, data, 6);
        }
        await writer.write("card.json", JSON.stringify(cardV3("Backpressure")));
        await writer.end();
        let release!: () => void;
        const stalled = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.mocked(globalApi.saveAsset).mockImplementation(async (data) => {
            await stalled;
            return `assets/saved-${data[0]}.png`;
        });
        const importer = new CharXImporter();
        // Observe completed decodes at the real unzip boundary. Counting saves alone would miss
        // decoded buffers retained by items waiting for admission to the save queue.
        let decoded = 0;
        const handle = importer.unzip.onfile!;
        importer.unzip.onfile = (file) => {
            handle(file);
            if (file.ondata && file.name.startsWith("assets/")) {
                const ondata = file.ondata;
                file.ondata = (error, data, final) => {
                    if (final) decoded++;
                    ondata(error, data, final);
                };
            }
        };
        let parsed = false;
        const parsing = importer.parse(output.buf.buffer).then(() => {
            parsed = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        const beforeRelease = { decoded, saves: vi.mocked(globalApi.saveAsset).mock.calls.length, parsed };
        release();
        await parsing;
        await importer.done();
        expect(beforeRelease.saves).toBe(10);
        expect(beforeRelease.parsed).toBe(false);
        // Keep the allowance for entries completed by one synchronous feed slice.
        expect(beforeRelease.decoded).toBeLessThanOrEqual(12);
        expect(Object.keys(importer.assets)).toHaveLength(40);
        expect(JSON.parse(importer.cardData!).data.name).toBe("Backpressure");
    });

    it("skips a header-sized 50 MiB asset before decoding and lists it in excludedFiles", async () => {
        const { globalApi } = await boot();
        const { CharXImporter, CharXWriter } = await import("./process/processzip");
        const output = new globalApi.VirtualWriter();
        const writer = new CharXWriter(output);
        const name = await writer.write("assets/oversized.png", new Uint8Array(1024), 6);
        await writer.write("card.json", JSON.stringify(cardV3("Size limit")));
        await writer.end();
        const bytes = output.buf.buffer;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const central = Buffer.from(bytes).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        expect(central).toBeGreaterThan(0);
        // CharXWriter streams with a trailing size descriptor. Supply the sizes in the first
        // local header, as a non-streaming zip producer does. The deliberately small payload is
        // a tripwire: a header-rejected file must never be inflated or reach saveAsset.
        view.setUint16(6, view.getUint16(6, true) & ~8, true);
        view.setUint32(18, view.getUint32(central + 20, true), true);
        view.setUint32(22, 50 * 1024 * 1024, true);
        view.setUint32(central + 24, 50 * 1024 * 1024, true);
        const importer = new CharXImporter();
        const handle = importer.unzip.onfile!;
        const starts = vi.fn();
        const sizes: number[] = [];
        importer.unzip.onfile = (file) => {
            if (file.name === name) {
                sizes.push(file.originalSize!);
                const start = file.start.bind(file);
                file.start = () => {
                    starts();
                    start();
                };
            }
            handle(file);
        };
        await importer.parse(bytes);
        await importer.done();
        expect(sizes).toEqual([50 * 1024 * 1024]);
        expect(importer.excludedFiles).toEqual([name]);
        expect(starts).not.toHaveBeenCalled();
        expect(globalApi.saveAsset).not.toHaveBeenCalled();
        expect(importer.assets).toEqual({});
        expect(JSON.parse(importer.cardData!).data.name).toBe("Size limit");
    });
});

describe("CharX export names its assets as the zip writer wrote them", () => {
    it("sanitized, colliding, and extensionless names import back through the app's own importer", async () => {
        const app = await boot();
        // The portrait is read alone; the assets come through the batch read (large-asset-import
        // slice 3a), one record per asked key.
        vi.spyOn(app.globalApi, "readImage").mockResolvedValue(GIF);
        vi.spyOn(app.globalApi, "loadAssets").mockImplementation(async (keys) => keys.map(() => GIF));
        const char = fixtureCharacter({
            additionalAssets: [
                ["smile?", "assets/smile.gif", "gif"],
                ["a?", "assets/a.gif", "png"],
                ["a_", "assets/b.gif", "png"],
            ],
            // A CC asset keeps an empty `ext` (an extra asset's empty ext becomes `png`).
            ccAssets: [{ type: "background", uri: "assets/c.gif", name: "bare", ext: "" }],
        });
        const writer = new app.globalApi.VirtualWriter();
        await app.cards.exportCharacterCard(char, "charx", { spec: "v3", writer });
        expect(alerts.error).not.toHaveBeenCalled();
        const bytes = writer.buf.buffer;
        const zip = fflate.unzipSync(bytes);
        const card = JSON.parse(new TextDecoder().decode(zip["card.json"]));
        const uriOf = (name: string) => card.data.assets.find((asset: any) => asset.name === name)?.uri;
        expect(["smile?", "a?", "a_", "bare"].map(uriOf)).toEqual([
            "embeded://assets/other/image/smile_.gif",
            "embeded://assets/other/image/a_.png",
            "embeded://assets/other/image/a__1.png",
            "embeded://assets/background/other/bare",
        ]);
        for (const asset of card.data.assets) {
            if (asset.uri.startsWith("embeded://")) {
                expect(zip[asset.uri.slice("embeded://".length)], asset.uri).toBeDefined();
            }
        }
        const imported = await app.cards.importCharacterProcess({
            name: "roundtrip.charx",
            data: bytes,
            returnCharacter: true,
        });
        expect(imported).toMatchObject({
            name: "Roundtrip",
            additionalAssets: [
                ["smile?", expect.stringMatching(/^asset-\d+$/), "gif"],
                ["a?", expect.stringMatching(/^asset-\d+$/), "png"],
                ["a_", expect.stringMatching(/^asset-\d+$/), "png"],
            ],
        });
        expect((imported as any).ccAssets).toContainEqual({
            type: "background",
            name: "bare",
            ext: "",
            uri: expect.stringMatching(/^asset-\d+$/),
        });
    });
});

describe("a card's depth prompt survives import", () => {
    const depthPrompt = { depth: 2, prompt: "DEPTH_INSTRUCTION" };

    it("a V3 JSON card the app exported stores the prompt and depth on the server", async () => {
        const app = await boot();
        const card = app.cards.createBaseV3(fixtureCharacter({ depth_prompt: depthPrompt }));
        expect(card.data.extensions.depth_prompt).toEqual(depthPrompt);
        const before = app.ids();
        await app.cards.importCharacterProcess({ name: "depth.json", data: encode(card) });
        expect((await app.saved(before)).depth_prompt).toEqual(depthPrompt);
    });

    it("a V2 JSON card and a CharX card carry it too; only the depth and the prompt are kept", async () => {
        const app = await boot();
        let before = app.ids();
        const v2 = cardV2("DepthV2", { extensions: { depth_prompt: { ...depthPrompt, role: "system" } } });
        await app.cards.importCharacterProcess({ name: "depth-v2.json", data: encode(v2) });
        expect((await app.saved(before)).depth_prompt).toEqual(depthPrompt);
        before = app.ids();
        const v3 = cardV3("DepthCharx", { extensions: { depth_prompt: { depth: 4, prompt: "FROM_CHARX" } } });
        await app.cards.importCharacterProcess({ name: "depth.charx", data: charx(v3) });
        expect((await app.saved(before)).depth_prompt).toEqual({ depth: 4, prompt: "FROM_CHARX" });
    });

    it("a malformed extension leaves the default", async () => {
        const app = await boot();
        const before = app.ids();
        const card = cardV3("BadDepth", { extensions: { depth_prompt: { depth: "2", prompt: "x" } } });
        await app.cards.importCharacterProcess({ name: "bad-depth.json", data: encode(card) });
        expect((await app.saved(before)).depth_prompt).toEqual({ depth: 0, prompt: "" });
    });
});

describe("PNG export from a portrait with other text chunks", () => {
    const text: [string, string][] = [
        ["Comment", "Synthetic portrait"],
        ["parameters", "steps: 20, sampler: euler"],
        ["chara", Buffer.from(JSON.stringify(cardV2("Old"))).toString("base64")],
    ];

    async function exported(spec: "v2" | "v3") {
        const app = await boot();
        const { PngChunk } = await import("./pngChunk");
        vi.spyOn(app.globalApi, "readImage").mockResolvedValue(portrait(text));
        const writer = new app.globalApi.VirtualWriter();
        await app.cards.exportCharacterCard(fixtureCharacter({ name: "PNG roundtrip" }), "png", { spec, writer });
        expect(alerts.error).not.toHaveBeenCalled();
        return { ...app, PngChunk, output: writer.buf.buffer };
    }

    it("a V3 card keeps the Comment and parameters chunks, drops the old card chunk, and imports back", async () => {
        const app = await exported("v3");
        const chunks = app.PngChunk.read(app.output, ["ccv3", "chara", "Comment", "parameters"], { checkCrc: true });
        expect(Object.keys(chunks).sort()).toEqual(["Comment", "ccv3", "parameters"]);
        expect(chunks.Comment).toBe("Synthetic portrait");
        expect(chunks.parameters).toBe("steps: 20, sampler: euler");
        const before = app.ids();
        const id = await app.cards.importCharacterProcess({ name: "roundtrip.png", data: app.output });
        expect(typeof id).toBe("string");
        expect(app.ids()).toHaveLength(before.length + 1);
        expect(app.character(id!).name).toBe("PNG roundtrip");
    });

    it("a V2 card is CRC-valid with its Comment chunk kept and one chara chunk", async () => {
        const app = await exported("v2");
        const chunks = app.PngChunk.read(app.output, ["ccv3", "chara", "Comment"], { checkCrc: true });
        expect(Object.keys(chunks).sort()).toEqual(["Comment", "chara"]);
        expect(JSON.parse(Buffer.from(chunks.chara, "base64").toString("utf-8")).data.name).toBe("PNG roundtrip");
    });
});
