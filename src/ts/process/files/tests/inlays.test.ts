import fc from "fast-check";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { InlayResource } from "../../../../../shared/resources.ts";
import { FakeResourceServer } from "../../../storage/tests/fakeResourceServer";
import { warmModules } from "../../../storage/tests/mutationStoresHarness";
import type { InlayAsset } from "../inlays";

// Inlays over the server: metadata in the `inlays` resource, media bytes as content-addressed
// assets. The fake resource server stands in for the routes; the `assetClient` mock is an in-memory
// asset store; `/api/read` HEAD answers from it for `verifyInlay`.

const { server, assets } = vi.hoisted(() => ({
    server: { current: null as any },
    assets: new Map<string, Uint8Array>(),
}));

vi.mock("../../../storage/serverAuth", () => ({
    authFetch: async (path: string, init: RequestInit = {}) => {
        if (path === "/api/read" && init.method === "HEAD") {
            const key = Buffer.from(new Headers(init.headers).get("file-path")!, "hex").toString("utf-8");
            const bytes = assets.get(key);
            return new Response(null, {
                status: 200,
                headers: bytes ? { "content-length": String(bytes.byteLength) } : {},
            });
        }
        return server.current.fetch(path, init);
    },
}));

vi.mock("../../../storage/assetClient", () => ({
    writeAsset: vi.fn(async (key: string, value: Uint8Array) => {
        assets.set(key, new Uint8Array(value));
    }),
    readAsset: vi.fn(async (key: string) => {
        const bytes = assets.get(key);
        return bytes ? Buffer.from(bytes) : null;
    }),
}));

vi.mock("uuid", () => ({ v4: vi.fn(() => "test-uuid-1234") }));
vi.mock(import("src/ts/media"), () => ({ getImageType: vi.fn() }));
vi.mock(import("src/ts/model/modellist"), () => ({ getModelInfo: vi.fn() }));
vi.mock(import("src/ts/util"), () => ({ asBuffer: (arr: Uint8Array) => arr }) as typeof import("src/ts/util"));

// happy-dom canvas getContext returns null
const fakeCtx = { drawImage: vi.fn() };
const origCreateElement = document.createElement.bind(document);
vi.spyOn(document, "createElement").mockImplementation((tag: string, options?: any) => {
    const el = origCreateElement(tag, options);
    if (tag === "canvas") {
        (el as HTMLCanvasElement).getContext = (() => fakeCtx) as any;
        (el as HTMLCanvasElement).toBlob = ((cb: BlobCallback) => {
            cb(new Blob([`png:${(el as HTMLCanvasElement).width}x${(el as HTMLCanvasElement).height}`]));
        }) as any;
    }
    return el;
});

// Fresh module state per test: the content-addressed blob cache would otherwise let one test's
// upload satisfy another test's write of the same bytes.
let I: typeof import("../inlays");
let client: typeof import("../../../storage/resourceClient");

function makeImage(w: number, h: number, loaded = false): HTMLImageElement {
    const img = new Image();
    Object.defineProperty(img, "width", { get: () => w });
    Object.defineProperty(img, "height", { get: () => h });
    Object.defineProperty(img, "naturalWidth", { get: () => w });
    Object.defineProperty(img, "complete", { get: () => loaded });
    Object.defineProperty(img, "onload", {
        set(fn: () => void) {
            fn?.();
        },
        get() {
            return null;
        },
    });
    return img;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
    return Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
}

const blobOf = (text: string, type = "application/octet-stream") => new Blob([text], { type });
const image = (data: string | Blob, name = "pic.png"): InlayAsset => ({
    data,
    ext: "png",
    type: "image",
    name,
    width: 4,
    height: 2,
});

let fake: FakeResourceServer;

beforeAll(
    () => warmModules(() => Promise.all([import("../../../storage/resourceClient"), import("../inlays")])),
    60_000,
);

beforeEach(async () => {
    vi.resetModules();
    fake = new FakeResourceServer();
    server.current = fake;
    assets.clear();
    client = await import("../../../storage/resourceClient");
    I = await import("../inlays");
    client.setResourceEpoch(fake.epoch);
    vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe("setInlayAsset", () => {
    test("stores the bytes under their content hash and the metadata under the id", async () => {
        await I.setInlayAsset("id-1", image(blobOf("hello")));
        const key = `assets/inlay_${await sha256(new TextEncoder().encode("hello"))}.png`;
        expect([...assets.keys()]).toEqual([key]);
        expect(fake.data<InlayResource>("inlays", "id-1")).toEqual({
            name: "pic.png",
            ext: "png",
            type: "image",
            width: 4,
            height: 2,
            asset: key,
            size: 5,
        });
    });

    test("accepts a data URI and sanitizes the extension in the asset key", async () => {
        await I.setInlayAsset("uri", {
            data: "data:image/png;base64,aGVsbG8=",
            ext: "p/../n g",
            type: "image",
            name: "n",
        });
        const meta = fake.data<InlayResource>("inlays", "uri")!;
        expect(meta.asset).toMatch(/^assets\/inlay_[0-9a-f]{64}\.png$/);
        expect(assets.get(meta.asset!)).toEqual(new TextEncoder().encode("hello"));
    });

    test("writes the same bytes once for two ids and skips the metadata write when nothing changed", async () => {
        await I.setInlayAsset("one", image(blobOf("same")));
        await I.setInlayAsset("two", image(blobOf("same")));
        expect(assets.size).toBe(1);
        const revision = fake.get("inlays", "one")!.revision;
        const puts = fake.requests.filter((r) => r.method === "PUT").length;
        await I.setInlayAsset("one", image(blobOf("same")));
        expect(fake.get("inlays", "one")!.revision).toBe(revision);
        expect(fake.requests.filter((r) => r.method === "PUT").length).toBe(puts);
    });

    test("stores a signature's JSON in the metadata, without an asset", async () => {
        await I.setInlayAsset("sig", { data: '{"a":1}', ext: "json", type: "signature", name: "sig" });
        expect(fake.data("inlays", "sig")).toEqual({ name: "sig", ext: "json", type: "signature", text: '{"a":1}' });
        expect(assets.size).toBe(0);
    });

    test("runs same-id writes in call order even when the earlier one prepares slowly", async () => {
        const slow = blobOf("old");
        let release!: () => void;
        const original = slow.arrayBuffer.bind(slow);
        slow.arrayBuffer = () => new Promise<ArrayBuffer>((resolve) => (release = () => resolve(original())));
        const first = I.setInlayAsset("order", image(slow, "old"));
        const second = I.setInlayAsset("order", image(blobOf("new"), "new"));
        await Promise.resolve();
        release();
        await Promise.all([first, second]);
        expect(fake.data<InlayResource>("inlays", "order")!.name).toBe("new");
    });

    test("wins a same-id conflict with another tab after one re-read (last writer wins)", async () => {
        await I.setInlayAsset("lww", image(blobOf("mine"), "mine"));
        fake.set("inlays", "lww", { name: "theirs", ext: "png", type: "image" });
        await I.setInlayAsset("lww", image(blobOf("mine again"), "mine again"));
        expect(fake.data<InlayResource>("inlays", "lww")!.name).toBe("mine again");
        expect(fake.requests.filter((r) => r.method === "PUT" && r.path.endsWith("/lww")).length).toBe(3);
    });

    test("propagates a 412 (the server was restored) instead of retrying", async () => {
        fake.restore("other-epoch");
        await expect(I.setInlayAsset("x", image(blobOf("x")))).rejects.toBeInstanceOf(
            client.ResourceEpochMismatchError,
        );
    });
});

describe("reads", () => {
    test("getInlayAsset returns a data URI with the media type; getInlayAssetBlob a typed Blob", async () => {
        await I.setInlayAsset("img", image(blobOf("hello")));
        const uri = await I.getInlayAsset("img");
        expect(uri).toMatchObject({ name: "pic.png", ext: "png", type: "image", width: 4, height: 2 });
        expect(uri!.data).toBe(`data:image/png;base64,${btoa("hello")}`);
        const blob = await I.getInlayAssetBlob("img");
        expect(blob!.data).toBeInstanceOf(Blob);
        expect(blob!.data.type).toBe("image/png");
        expect(await blob!.data.text()).toBe("hello");
    });

    test("reconstructs MIME types for audio, video, and jpg", async () => {
        await I.setInlayAsset("a", { data: blobOf("a"), ext: "mp3", type: "audio", name: "a" });
        await I.setInlayAsset("v", { data: blobOf("v"), ext: "webm", type: "video", name: "v" });
        await I.setInlayAsset("j", { data: blobOf("j"), ext: "jpg", type: "image", name: "j" });
        expect((await I.getInlayAssetBlob("a"))!.data.type).toBe("audio/mpeg");
        expect((await I.getInlayAssetBlob("v"))!.data.type).toBe("video/webm");
        expect((await I.getInlayAsset("j"))!.data.startsWith("data:image/jpeg;base64,")).toBe(true);
    });

    test("a signature reads back as its JSON text and as an application/json Blob", async () => {
        await I.saveInlayedSignature("sig", { signatures: [], sourceFormat: 0, source: "s" });
        const text = await I.getInlayAsset("sig");
        expect(JSON.parse(text!.data)).toEqual({ signatures: [], sourceFormat: 0, source: "s" });
        expect(text).toMatchObject({ type: "signature", ext: "json" });
        expect((await I.getInlayAssetBlob("sig"))!.data.type).toBe("application/json");
    });

    test("returns null for an unknown id, without width/height keys on a metadata hit that lacks them", async () => {
        expect(await I.getInlayAsset("missing")).toBeNull();
        expect(await I.getInlayAssetBlob("missing")).toBeNull();
        await I.setInlayAsset("nodims", { data: blobOf("x"), ext: "png", type: "image", name: "n" });
        expect(await I.getInlayAsset("nodims")).not.toHaveProperty("width");
    });

    test("getInlayMedia gives the type and asset key without reading bytes; null for a signature or a miss", async () => {
        // Bytes this tab has not cached: any read would reach the asset store.
        assets.set("assets/elsewhere.png", new TextEncoder().encode("hello"));
        fake.set("inlays", "img", { name: "i", ext: "png", type: "image", asset: "assets/elsewhere.png" });
        fake.set("inlays", "sig", { name: "s", ext: "json", type: "signature", text: "t" });
        const { readAsset } = await import("../../../storage/assetClient");
        expect(await I.getInlayMedia("img")).toEqual({ type: "image", asset: "assets/elsewhere.png" });
        expect(readAsset).not.toHaveBeenCalled();
        expect(await I.getInlayMedia("sig")).toBeNull();
        expect(await I.getInlayMedia("missing")).toBeNull();
    });

    test("getInlayObjectUrl makes one typed URL per asset key, shared by ids and concurrent calls", async () => {
        const created: Blob[] = [];
        const create = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
            created.push(blob as Blob);
            return `blob:test-${created.length}`;
        });
        try {
            await I.setInlayAsset("a1", { data: blobOf("sound"), ext: "mp3", type: "audio", name: "a" });
            await I.setInlayAsset("a2", { data: blobOf("sound"), ext: "mp3", type: "audio", name: "a" });
            const urls = await Promise.all([
                I.getInlayObjectUrl("a1"),
                I.getInlayObjectUrl("a2"),
                I.getInlayObjectUrl("a1"),
            ]);
            expect(new Set(urls)).toEqual(new Set(["blob:test-1"]));
            expect(created.map((blob) => blob.type)).toEqual(["audio/mpeg"]);
            expect(await I.getInlayObjectUrl("a1")).toBe("blob:test-1");

            // A same-id rewrite names new bytes, so it gets its own URL (never the old media).
            await I.setInlayAsset("a1", { data: blobOf("other"), ext: "webm", type: "video", name: "v" });
            expect(await I.getInlayObjectUrl("a1")).toBe("blob:test-2");
            expect(created[1].type).toBe("video/webm");
            expect(await I.getInlayObjectUrl("a2")).toBe("blob:test-1");

            await I.saveInlayedSignature("sig", { signatures: [], sourceFormat: 0, source: "s" });
            expect(await I.getInlayObjectUrl("sig")).toBeNull();
            expect(await I.getInlayObjectUrl("missing")).toBeNull();
            expect(create).toHaveBeenCalledTimes(2);
        } finally {
            create.mockRestore();
        }
    });

    test("returns null when the metadata exists but the media file is gone", async () => {
        await I.setInlayAsset("gone", image(blobOf("bytes")));
        assets.clear();
        // The blob cache still holds the bytes of this tab's own write; another tab's metadata
        // naming a file that is not there reads as null.
        fake.set("inlays", "gone", {
            ...fake.data<InlayResource>("inlays", "gone")!,
            asset: "assets/inlay_nowhere.png",
        });
        I.invalidateInlayCaches();
        expect(await I.getInlayAssetBlob("gone")).toBeNull();
    });

    test("getInlayObjectUrl uses canonical MIME types for fallback media blobs", async () => {
        const created: Blob[] = [];
        const create = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
            created.push(blob as Blob);
            return `blob:fallback-${created.length}`;
        });
        try {
            for (const [type, ext, mime] of [
                ["video", "mkv", "video/x-matroska"],
                ["audio", "flac", "audio/flac"],
                ["audio", "m4a", "audio/mp4"],
            ] as const) {
                const key = `assets/fallback.${ext}`;
                const bytes = `fallback ${ext} bytes`;
                assets.set(key, new TextEncoder().encode(bytes));
                fake.set("inlays", ext, { name: ext, type, ext, asset: key });

                expect(await I.getInlayObjectUrl(ext)).not.toBeNull();
                expect(created.at(-1)!.type, ext).toBe(mime);
                expect(await created.at(-1)!.text(), ext).toBe(bytes);
            }
            expect(create).toHaveBeenCalledTimes(3);
        } finally {
            create.mockRestore();
        }
    });
});

describe("caches", () => {
    test("serves a seeded id without a request and a miss from the negative cache until it expires", async () => {
        fake.set("inlays", "seeded", { name: "s", ext: "json", type: "signature", text: "t" });
        I.seedInlays((await client.readKinds(["inlays"])).kinds.inlays);
        fake.requests.length = 0;
        expect((await I.getInlayAsset("seeded"))!.data).toBe("t");
        expect(fake.requests).toHaveLength(0);

        expect(await I.getInlayMetadata("absent")).toBeNull();
        expect(await I.getInlayMetadata("absent")).toBeNull();
        expect(fake.requests.filter((r) => r.path.endsWith("/absent"))).toHaveLength(1);
        fake.set("inlays", "absent", { name: "now", ext: "json", type: "signature", text: "now" });
        expect(await I.getInlayMetadata("absent")).toBeNull();
        vi.setSystemTime(Date.now() + 31_000);
        expect((await I.getInlayMetadata("absent"))?.text).toBe("now");
    });

    test("de-duplicates concurrent reads of one id", async () => {
        fake.set("inlays", "dup", { name: "d", ext: "json", type: "signature", text: "d" });
        await Promise.all([I.getInlayMetadata("dup"), I.getInlayMetadata("dup"), I.getInlayMetadata("dup")]);
        expect(fake.requests.filter((r) => r.path.endsWith("/dup"))).toHaveLength(1);
    });

    test("invalidateInlayCaches makes the next read see another tab's create and update", async () => {
        expect(await I.getInlayMetadata("late")).toBeNull();
        await I.saveInlayedSignature("sig", { signatures: [], sourceFormat: 0, source: "before" });
        fake.set("inlays", "late", { name: "l", ext: "json", type: "signature", text: "created" });
        fake.set("inlays", "sig", { name: "sig", ext: "json", type: "signature", text: "after" });
        expect(await I.getInlayMetadata("late")).toBeNull();
        expect(JSON.parse((await I.getInlayAsset("sig"))!.data).source).toBe("before");
        I.invalidateInlayCaches();
        expect((await I.getInlayMetadata("late"))?.text).toBe("created");
        expect((await I.getInlayAsset("sig"))!.data).toBe("after");
    });

    test("listInlayAssets returns fresh metadata and replaces the cached view", async () => {
        expect(await I.listInlayAssets()).toEqual([]);
        await I.setInlayAsset("a", image(blobOf("a"), "a.png"));
        await I.saveInlayedSignature("b", { signatures: [], sourceFormat: 0, source: "b" });
        expect(await I.getInlayMetadata("stale-miss")).toBeNull();
        fake.set("inlays", "stale-miss", { name: "m", ext: "json", type: "signature", text: "m" });
        fake.delete("inlays", "b");
        const listed = await I.listInlayAssets();
        expect(listed.map(([id, meta]) => [id, meta.name]).sort()).toEqual([
            ["a", "a.png"],
            ["stale-miss", "m"],
        ]);
        expect(listed.find(([id]) => id === "a")![1]).not.toHaveProperty("data");
        expect(await I.getInlayMetadata("b")).toBeNull();
        expect((await I.getInlayMetadata("stale-miss"))?.text).toBe("m");
    });
});

describe("removeInlayAsset", () => {
    test("deletes the metadata, keeps the media file, and tolerates an unknown id", async () => {
        await I.setInlayAsset("rm", image(blobOf("keep me")));
        await I.removeInlayAsset("rm");
        expect(fake.get("inlays", "rm")).toBeNull();
        expect(assets.size).toBe(1);
        expect(await I.getInlayAsset("rm")).toBeNull();
        await expect(I.removeInlayAsset("never")).resolves.toBeUndefined();
    });

    test("retries once after another tab's write and then deletes", async () => {
        await I.setInlayAsset("rm2", image(blobOf("x")));
        fake.set("inlays", "rm2", { name: "theirs", ext: "png", type: "image" });
        await I.removeInlayAsset("rm2");
        expect(fake.get("inlays", "rm2")).toBeNull();
    });
});

describe("verifyInlay and repairInlayMedia (browser-local import)", () => {
    test("verifies metadata and the media size on the server", async () => {
        await I.setInlayAsset("v", image(blobOf("bytes")));
        const meta = fake.data<InlayResource>("inlays", "v")!;
        expect(await I.verifyInlay("v", meta)).toBe(true);
        expect(await I.verifyInlay("v", { ...meta, name: "other" })).toBe(false);
        assets.clear();
        expect(await I.verifyInlay("v", meta)).toBe(false);
        expect(await I.verifyInlay("nothing", meta)).toBe(false);
    });

    test("repairs a missing media file only when the local bytes are the file the metadata names", async () => {
        const key = `assets/inlay_${await sha256(new TextEncoder().encode("abc"))}.wav`;
        fake.set("inlays", "partial", { name: "s", ext: "wav", type: "audio", asset: key, size: 3 });
        expect(await I.repairInlayMedia("partial", { data: blobOf("xyz"), ext: "wav", type: "audio", name: "s" })).toBe(
            false,
        );
        expect(assets.size).toBe(0);
        expect(await I.repairInlayMedia("partial", { data: blobOf("abc"), ext: "wav", type: "audio", name: "s" })).toBe(
            true,
        );
        expect(assets.get(key)).toEqual(new TextEncoder().encode("abc"));
        expect(await I.verifyInlay("partial", fake.data<InlayResource>("inlays", "partial")!)).toBe(true);
        expect(await I.repairInlayMedia("nothing", { data: blobOf("abc"), ext: "wav", type: "audio", name: "s" })).toBe(
            false,
        );
        expect(await I.repairInlayMedia("partial", { data: "{}", ext: "json", type: "signature", name: "s" })).toBe(
            false,
        );
    });
});

describe("postInlayAsset", () => {
    test("stores audio and video under a new id and returns it", async () => {
        expect(await I.postInlayAsset({ name: "clip.mp3", data: new Uint8Array([0xff, 0xfb]) })).toBe("test-uuid-1234");
        expect(fake.data("inlays", "test-uuid-1234")).toMatchObject({
            ext: "mp3",
            name: "clip.mp3",
            type: "audio",
            size: 2,
        });
        expect(await I.postInlayAsset({ name: "video.webm", data: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]) })).toBe(
            "test-uuid-1234",
        );
        expect(fake.data("inlays", "test-uuid-1234")).toMatchObject({ ext: "webm", type: "video", size: 4 });
    });

    test("returns null for any unsupported extension", async () => {
        const supported = [
            "wav",
            "mp3",
            "ogg",
            "flac",
            "webm",
            "mp4",
            "mkv",
            "jpg",
            "jpeg",
            "png",
            "gif",
            "webp",
            "avif",
        ];
        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 1, maxLength: 10 }).filter((ext) => !supported.includes(ext)),
                async (ext) => {
                    expect(await I.postInlayAsset({ name: `file.${ext}`, data: new Uint8Array([0x00]) })).toBeNull();
                },
            ),
        );
    });
});

describe("one-shot decode URLs", () => {
    // The image the code under test creates with `new Image()`.
    function stubImage(img: HTMLImageElement) {
        vi.stubGlobal("Image", function () {
            return img;
        } as unknown as typeof Image);
    }

    let create: ReturnType<typeof vi.spyOn>;
    let revoke: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:decode-1");
        revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        fakeCtx.drawImage.mockClear();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        create.mockRestore();
        revoke.mockRestore();
    });

    test("postInlayAsset revokes an image's URL once it is drawn and stored", async () => {
        const img = makeImage(30, 20, true);
        stubImage(img);
        revoke.mockImplementation(() => {
            // Released only after the draw and the write.
            expect(fakeCtx.drawImage).toHaveBeenCalledTimes(1);
            expect(fake.data("inlays", "test-uuid-1234")).toMatchObject({ type: "image", name: "pic.png" });
        });
        expect(await I.postInlayAsset({ name: "pic.png", data: new Uint8Array([1, 2, 3]) })).toBe("test-uuid-1234");
        expect(img.src).toBe("blob:decode-1");
        expect(revoke).toHaveBeenCalledTimes(1);
        expect(revoke).toHaveBeenCalledWith("blob:decode-1");
    });

    test("postInlayAsset revokes the URL of an image that fails to load", async () => {
        const img = makeImage(0, 0, true);
        stubImage(img);
        await expect(I.postInlayAsset({ name: "broken.webp", data: new Uint8Array([0]) })).rejects.toThrow(
            "could not be loaded",
        );
        expect(revoke).toHaveBeenCalledWith("blob:decode-1");
        expect(fake.data("inlays", "test-uuid-1234")).toBeNull();
    });

    test("reencodeImage revokes its URL after the decode, before drawing, and also when the decode fails", async () => {
        const toDataURL = vi
            .spyOn(HTMLCanvasElement.prototype, "toDataURL")
            .mockReturnValue(`data:image/png;base64,${Buffer.from("png").toString("base64")}`);
        try {
            // Both made before the stub replaces `Image`.
            const img = makeImage(8, 4, true);
            const failing = makeImage(8, 4, false);
            img.decode = vi.fn(async () => {
                expect(revoke).not.toHaveBeenCalled();
            });
            stubImage(img);
            const out = await I.reencodeImage(new Uint8Array([0xff, 0xd8]));
            expect(Buffer.from(out).toString()).toBe("png");
            expect(revoke).toHaveBeenCalledWith("blob:decode-1");
            expect(revoke.mock.invocationCallOrder[0]).toBeLessThan(fakeCtx.drawImage.mock.invocationCallOrder[0]);

            revoke.mockClear();
            failing.decode = vi.fn(async () => {
                throw new Error("EncodingError");
            });
            stubImage(failing);
            await expect(I.reencodeImage(new Uint8Array([0xff, 0xd8]))).rejects.toThrow("EncodingError");
            expect(revoke).toHaveBeenCalledWith("blob:decode-1");
        } finally {
            toDataURL.mockRestore();
        }
    });
});

describe("writeInlayImage", () => {
    test("stores a PNG with the drawn size under the given id (or a new uuid) and waits for a loading image", async () => {
        expect(await I.writeInlayImage(makeImage(200, 100), { name: "photo.jpg", ext: "jpg", id: "custom-id" })).toBe(
            "custom-id",
        );
        expect(fake.data("inlays", "custom-id")).toMatchObject({
            ext: "png",
            height: 100,
            width: 200,
            name: "photo.jpg",
            type: "image",
        });
        expect(await I.writeInlayImage(makeImage(50, 50, true))).toBe("test-uuid-1234");
        expect(fake.data<InlayResource>("inlays", "test-uuid-1234")!.name).toBe("test-uuid-1234");
    });

    test("rejects an image that finished loading without pixels, and the id's queue moves on", async () => {
        const broken = makeImage(0, 0, true);
        await expect(I.writeInlayImage(broken, { id: "broken" })).rejects.toThrow(/could not be loaded/);
        await I.saveInlayedSignature("broken", { signatures: [], sourceFormat: 0, source: "after" });
        expect(fake.data<InlayResource>("inlays", "broken")!.type).toBe("signature");
    });

    test("stops where `check` throws: before anything, after hashing (no upload), or after the upload (no metadata)", async () => {
        // A server job's callback that was cancelled meanwhile: `check` runs at the start, after the
        // image loaded, before the media write (after hashing), and before the metadata write; a
        // throw there leaves nothing newer behind.
        const { writeAsset } = await import("../../../storage/assetClient");
        const setItem = writeAsset as unknown as { mock: { calls: unknown[][] } };
        const stopAt = (n: number) => {
            let calls = 0;
            return () => {
                if (++calls >= n) {
                    throw new Error("cancelled");
                }
            };
        };
        await expect(I.writeInlayImage(makeImage(4, 2, true), { id: "c1", check: stopAt(1) })).rejects.toThrow(
            "cancelled",
        );
        expect(setItem.mock.calls).toHaveLength(0);
        expect(fake.data("inlays", "c1")).toBeNull();
        // The media key is hashed before the upload starts; a cancel there uploads nothing.
        await expect(I.writeInlayImage(makeImage(4, 2, true), { id: "c2", check: stopAt(4) })).rejects.toThrow(
            "cancelled",
        );
        expect(setItem.mock.calls).toHaveLength(0);
        expect(fake.data("inlays", "c2")).toBeNull();
        // A cancel after the upload writes no metadata (the bytes are content-addressed and inert).
        await expect(I.writeInlayImage(makeImage(4, 2, true), { id: "c3", check: stopAt(5) })).rejects.toThrow(
            "cancelled",
        );
        expect(setItem.mock.calls).toHaveLength(1);
        expect(fake.data("inlays", "c3")).toBeNull();
        // Without a cancel the same image lands, and the id's queue moved on.
        expect(await I.writeInlayImage(makeImage(4, 2, true), { id: "c3", check: () => {} })).toBe("c3");
        expect(fake.data<InlayResource>("inlays", "c3")).toMatchObject({ type: "image", width: 4, height: 2 });
    });

    test("output pixels never exceed 1024 * 1024 and the aspect ratio survives downscaling", async () => {
        await fc.assert(
            fc.asyncProperty(fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 1, max: 10000 }), async (w, h) => {
                await I.writeInlayImage(makeImage(w, h), { id: "prop-img" });
                const stored = fake.data<InlayResource>("inlays", "prop-img")!;
                expect(stored.width! * stored.height!).toBeLessThanOrEqual(1024 * 1024);
                expect(stored.width).toBeGreaterThan(0);
                expect(stored.height).toBeGreaterThan(0);
                if (w * h <= 1024 * 1024) {
                    expect([stored.width, stored.height]).toEqual([w, h]);
                } else if (w > 1024 && h > 1024) {
                    expect(Math.abs(w / h - stored.width! / stored.height!) / (w / h)).toBeLessThan(0.01);
                }
            }),
            { numRuns: 40 },
        );
    });
});

// Live updates: another writer's inlay change reaches this tab as a feed notice
// (`noteRemoteInlay`) or a reconnect's listing (`reconcileInlays`); a read, a listing, or this tab's
// own write that overlaps one must not put an older copy back into the metadata cache. The fake's
// revisions are made real tokens here, since the cache compares them.
describe("live updates", () => {
    const EPOCH = "00000000-0000-4000-8000-000000000001";
    let counter = 0;
    /** Holds the next request whose path ends with `suffix` after it was answered (a snapshot of that moment). */
    const gate = { suffix: null as string | null, release: null as (() => void) | null };
    const sig = (text: string) => ({ name: "s", ext: "json", type: "signature" as const, text });
    const metaReads = (id: string) =>
        fake.requests.filter((r) => r.method === "GET" && r.path === `/api/resources/inlays/${id}`).length;

    beforeEach(() => {
        counter = 0;
        fake.epoch = EPOCH;
        client.setResourceEpoch(EPOCH);
        const set = fake.set.bind(fake);
        fake.set = (kind: string, id: string, data: unknown) => {
            set(kind, id, data);
            const token = `${EPOCH}:1:${++counter}`;
            fake.records.get(fake.key(kind, id))!.revision = token;
            return token;
        };
        gate.suffix = null;
        gate.release = null;
        server.current = {
            fetch: async (path: string, init?: RequestInit) => {
                const response = fake.fetch(path, init);
                if (gate.suffix !== null && path.endsWith(gate.suffix)) {
                    gate.suffix = null;
                    await new Promise<void>((resolve) => (gate.release = resolve));
                }
                return response;
            },
        };
    });

    const until = async (condition: () => boolean) => {
        for (let i = 0; i < 50 && !condition(); i += 1) {
            await Promise.resolve();
            await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
        }
        expect(condition()).toBe(true);
    };

    test("a notice drops cached metadata older than its revision, keeps one at or above it, and a deletion drops it", async () => {
        const r1 = fake.set("inlays", "a", sig("one"));
        expect((await I.getInlayMetadata("a"))?.text).toBe("one");
        I.noteRemoteInlay("a", r1);
        expect((await I.getInlayMetadata("a"))?.text).toBe("one");
        expect(metaReads("a")).toBe(1);
        const r2 = fake.set("inlays", "a", sig("two"));
        I.noteRemoteInlay("a", r2);
        expect((await I.getInlayMetadata("a"))?.text).toBe("two");
        expect(metaReads("a")).toBe(2);
        fake.delete("inlays", "a");
        I.noteRemoteInlay("a", null);
        expect(await I.getInlayMetadata("a")).toBeNull();
    });

    test("a notice during a metadata read: the read's older answer is not cached, the read asks again", async () => {
        fake.set("inlays", "a", sig("one"));
        gate.suffix = "/inlays/a";
        const reading = I.getInlayMetadata("a");
        await until(() => gate.release !== null);
        const r2 = fake.set("inlays", "a", sig("two"));
        I.noteRemoteInlay("a", r2);
        gate.release!();
        expect((await reading)?.text).toBe("two");
        expect(metaReads("a")).toBe(2);
        // The newer copy is cached.
        expect((await I.getInlayMetadata("a"))?.text).toBe("two");
        expect(metaReads("a")).toBe(2);
    });

    test("this tab's own write during a listing: the listing's older copy never replaces the written one", async () => {
        await I.saveInlayedSignature("sig", { signatures: [], sourceFormat: 0, source: "one" });
        gate.suffix = "kinds=inlays";
        const listing = I.listInlayAssets();
        await until(() => gate.release !== null);
        // The write's base is cached: it does not wait for the listing.
        await I.saveInlayedSignature("sig", { signatures: [], sourceFormat: 0, source: "two" });
        gate.release!();
        await listing;
        // The listing clears the cache it replaces and does not fill this id (it changed during the
        // listing), so the next read may ask the server again; it never serves the listed "one".
        expect(JSON.parse((await I.getInlayAsset("sig"))!.data).source).toBe("two");
    });

    test("a listing that began before a notice does not put that inlay's older copy back", async () => {
        fake.set("inlays", "a", sig("one"));
        fake.set("inlays", "b", sig("b"));
        gate.suffix = "kinds=inlays";
        const listing = I.listInlayAssets();
        await until(() => gate.release !== null);
        const r2 = fake.set("inlays", "a", sig("two"));
        I.noteRemoteInlay("a", r2);
        gate.release!();
        await listing;
        const before = metaReads("a");
        expect((await I.getInlayMetadata("a"))?.text).toBe("two");
        expect(metaReads("a")).toBe(before + 1);
        // The other inlay's listed copy was cached.
        expect((await I.getInlayMetadata("b"))?.text).toBe("b");
        expect(metaReads("b")).toBe(0);
    });

    test("a reconnect's listing drops metadata of removed and older inlays, keeps current ones, and forgets a listed miss", async () => {
        const ra = fake.set("inlays", "a", sig("a"));
        fake.set("inlays", "b", sig("b1"));
        fake.set("inlays", "gone", sig("gone"));
        for (const id of ["a", "b", "gone"]) {
            await I.getInlayMetadata(id);
        }
        expect(await I.getInlayMetadata("new")).toBeNull();
        const rb = fake.set("inlays", "b", sig("b2"));
        fake.delete("inlays", "gone");
        const rn = fake.set("inlays", "new", sig("new"));
        fake.requests.length = 0;
        I.reconcileInlays(
            new Map([
                ["a", ra],
                ["b", rb],
                ["new", rn],
            ]),
        );
        expect((await I.getInlayMetadata("a"))?.text).toBe("a");
        expect(metaReads("a")).toBe(0);
        expect((await I.getInlayMetadata("b"))?.text).toBe("b2");
        expect(await I.getInlayMetadata("gone")).toBeNull();
        expect((await I.getInlayMetadata("new"))?.text).toBe("new");
    });

    test("an invalidation during a metadata read keeps that read's answer out of the cache", async () => {
        fake.set("inlays", "a", sig("one"));
        gate.suffix = "/inlays/a";
        const reading = I.getInlayMetadata("a");
        await until(() => gate.release !== null);
        fake.set("inlays", "a", sig("two"));
        I.invalidateInlayCaches();
        gate.release!();
        expect((await reading)?.text).toBe("two");
        expect((await I.getInlayMetadata("a"))?.text).toBe("two");
    });
});
