import { Buffer } from "buffer";
import { flushSync } from "svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../stores.svelte", async () => {
    const { writable } = await import("svelte/store");
    return (await import("src/ts/tests/storesMock")).createStoresMock({
        CurrentTriggerIdStore: writable(null),
        CharEmotion: writable({}),
    });
});
vi.mock("../../storage/database.svelte", () => ({ appVer: "test", defaultSdDataFunc: () => [] }));
vi.mock("../../globalApi.svelte", () => ({
    aiWatermarkingLawApplies: () => false,
    getDirectAssetSrc: vi.fn(),
    getFileSrc: vi.fn(async (path: string) => path),
}));
vi.mock("../transformClient", () => ({ captureTransform: () => null, serverProcessScript: vi.fn() }));
vi.mock("../../process/files/inlays", () => ({ getInlayMedia: vi.fn(), getInlayObjectUrl: vi.fn() }));

import { getDirectAssetSrc } from "../../globalApi.svelte";
import { getInlayMedia, getInlayObjectUrl } from "../../process/files/inlays";
import { selectedCharacter } from "../../storage/characterStore.svelte";
import { selectCharacter } from "../../storage/selection.svelte";
import { installFlatDatabase } from "../../storage/tests/installFlatDatabase";
import { ParseMarkdown } from "../parser.svelte";

const mediaCases = [
    ["video", "webm", "video/webm", "inlay"],
    ["audio", "ogg", "audio/ogg", "inlayed"],
    ["audio", "m4a", "audio/mp4", "inlayeddata"],
    ["audio", "flac", "audio/flac", "inlay"],
    ["video", "mkv", "video/x-matroska", "inlay"],
] as const;

const directAssetUrl = (key: string) => "/api/asset/" + Buffer.from(key, "utf-8").toString("hex");

async function renderSource(
    media: "video" | "audio",
    extension: string,
    tag: "inlay" | "inlayed" | "inlayeddata" = "inlay",
) {
    const id = `${media}-${extension}`;
    const asset = `assets/inlay_${"a".repeat(64)}.${extension}`;
    const objectUrl = `blob:https://risu.test/${id}`;
    vi.mocked(getInlayMedia).mockResolvedValue({ type: media, asset });
    vi.mocked(getInlayObjectUrl).mockResolvedValue(objectUrl);

    const html = await ParseMarkdown(`{{${tag}::${id}}}`, "c", "normal", -1, {}, null);
    const container = document.createElement("div");
    container.innerHTML = html;
    return { source: container.querySelector(`${media} source`), asset, objectUrl };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDirectAssetSrc).mockReturnValue(null);
    installFlatDatabase({
        legacyMediaFindings: false,
        hideAllImages: false,
        enabledModules: [],
        modules: [],
        characters: [
            { chaId: "c", type: "character", name: "C", additionalAssets: [], emotionImages: [], customscript: [] },
        ],
    });
    selectCharacter("c");
    flushSync();
});

describe("additional asset media rendering", () => {
    it("uses each asset's MIME type for media tags and omits unknown types", async () => {
        const cases = [
            ["video", "webm", "video", "video/webm"],
            ["video-img", "webm", "video", "video/webm"],
            ["audio", "ogg", "audio", "audio/ogg"],
            ["asset", "webm", "video", "video/webm"],
            ["video", "aac", "video", null],
            ["video-img", "aac", "video", null],
            ["audio", "aac", "audio", null],
            ["asset", "avi", "video", null],
        ] as const;
        const char = selectedCharacter();
        if (char?.type !== "character") throw new Error("Missing character fixture");
        char.additionalAssets = cases.map(([tag, ext], i) => [`media-${i}`, `assets/${tag}-${i}.${ext}`, ext]);

        for (const [i, [tag, ext, element, mime]] of cases.entries()) {
            const container = document.createElement("div");
            container.innerHTML = await ParseMarkdown(`{{${tag}::media-${i}}}`, "c", "normal", -1, {}, null);
            const source = container.querySelector(`${element} source`);
            expect(source, `${tag} ${ext}`).not.toBeNull();
            expect(source!.getAttribute("src"), `${tag} ${ext}`).toBe(`assets/${tag}-${i}.${ext}`);
            expect(source!.getAttribute("type"), `${tag} ${ext}`).toBe(mime);
        }
    });
});

describe("inlay media rendering", () => {
    it("uses direct asset URLs and real MIME types for video and audio without creating object URLs", async () => {
        vi.mocked(getDirectAssetSrc).mockImplementation(directAssetUrl);

        for (const [media, extension, mime, tag] of mediaCases) {
            const { source, asset } = await renderSource(media, extension, tag);
            expect(source?.getAttribute("src")).toBe(directAssetUrl(asset));
            expect(source?.getAttribute("type")).toBe(mime);
        }
        expect(getInlayObjectUrl).not.toHaveBeenCalled();
    });

    it("uses typed object URLs and real MIME types for video and audio outside direct mode", async () => {
        for (const [media, extension, mime, tag] of mediaCases) {
            const { source, objectUrl } = await renderSource(media, extension, tag);
            expect(source?.getAttribute("src")).toBe(objectUrl);
            expect(source?.getAttribute("type")).toBe(mime);
        }
    });

    it("omits the source type for unknown extensions in both modes", async () => {
        for (const directMode of [true, false]) {
            vi.mocked(getDirectAssetSrc).mockImplementation((key) => (directMode ? directAssetUrl(key) : null));
            const { source, asset, objectUrl } = await renderSource("audio", "aac");
            expect(source?.getAttribute("src")).toBe(directMode ? directAssetUrl(asset) : objectUrl);
            expect(source?.getAttribute("type")).toBeNull();
        }
    });
});
