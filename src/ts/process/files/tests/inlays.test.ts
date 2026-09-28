import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { InlayResource } from "../../../../../shared/resources.ts";
import { FakeResourceServer } from "../../../storage/tests/fakeResourceServer";
import type { InlayAsset } from "../inlays";

// Inlays over the server: metadata in the `inlays` resource, media bytes as content-addressed
// assets. The fake resource server stands in for the routes; `forageStorage` is an in-memory asset
// store; `/api/read` HEAD answers from it for `verifyInlay`.

const { server, assets } = vi.hoisted(() => ({
    server: { current: null as any },
    assets: new Map<string, Uint8Array>(),
}));

vi.mock("../../../storage/nodeStorage", () => ({
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

vi.mock("../../../globalApi.svelte", () => ({
    forageStorage: {
        setItem: vi.fn(async (key: string, value: Uint8Array) => {
            assets.set(key, new Uint8Array(value));
        }),
        getItem: vi.fn(async (key: string) => assets.get(key) ?? null),
    },
}));

vi.mock("uuid", () => ({ v4: vi.fn(() => "test-uuid-1234") }));
vi.mock(import("src/ts/media"), () => ({ getImageType: vi.fn() }));
vi.mock(import("src/ts/model/modellist"), () => ({ getModelInfo: vi.fn() }));
vi.mock(import("src/ts/storage/database.svelte"), () => ({ getDatabase: vi.fn() }));
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
