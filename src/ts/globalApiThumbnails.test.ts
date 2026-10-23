// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./storage/assetClient", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./storage/assetClient")>()),
    readAsset: vi.fn(),
}));
vi.mock("./alert", async () => (await import("./tests/alertMock")).createAlertMock());
vi.mock("./storage/serverAuth", async () => (await import("./storage/tests/serverAuthMock")).createServerAuthMock());

let api: typeof import("./globalApi.svelte");
let getCharImage: typeof import("./characters").getCharImage;
let assets: typeof import("./storage/assetClient");
let records: typeof import("./storage/records.svelte");

beforeAll(async () => {
    api = await import("./globalApi.svelte");
    ({ getCharImage } = await import("./characters"));
    assets = await import("./storage/assetClient");
    records = await import("./storage/records.svelte");
});

const worker: { controller: object | null } = { controller: {} };
const fetchMock = vi.fn();
const openCache = vi.fn();
let create: ReturnType<typeof vi.spyOn>;
let revoke: ReturnType<typeof vi.spyOn>;
let serial = 0;
const path = () => `assets/thumbnail-${++serial}.png`;
const directUrl = (loc: string) => `/api/asset/${Buffer.from(loc, "utf8").toString("hex")}`;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    worker.controller = {};
    vi.stubGlobal("navigator", { serviceWorker: worker });
    vi.stubGlobal("fetch", fetchMock.mockReset().mockRejectedValue(new Error("worker unavailable")));
    vi.stubGlobal("caches", { open: openCache.mockReset().mockRejectedValue(new Error("cache unavailable")) });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    create = vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:thumbnail-${++serial}`);
    revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.mocked(assets.readAsset)
        .mockReset()
        .mockResolvedValue(Buffer.from([1, 2, 3]));
    records.applyRaw("ui", { hideAllImages: false });
    api.setUsingSw(true);
    api.setDirectAssets(true);
});

afterEach(() => {
    api.setUsingSw(false);
    api.setDirectAssets(false);
    records.applyRaw("ui", undefined);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("thumbnail sources", () => {
    it("resolves direct variants and empty paths immediately without I/O, allocation, or a retained pin", async () => {
        const loc = "assets/한글 image.png";
        const resolved = vi.fn();
        for (const size of [256, 512] as const) {
            void api.getThumbSrc(loc, size).then((src) => resolved(size, src));
        }
        void api.getThumbSrc("", 256).then((src) => resolved("empty", src));
        await Promise.resolve();
        expect(resolved.mock.calls).toEqual([
            [256, `${directUrl(loc)}?w=256`],
            [512, `${directUrl(loc)}?w=512`],
            ["empty", ""],
        ]);
        expect(assets.readAsset).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(openCache).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();

        // A subsequent fallback hold of the same path must still be releasable.
        api.setUsingSw(false);
        const held = api.holdFileSrc(loc);
        const src = await held.src;
        expect(src).toMatch(/^blob:/);
        expect(assets.readAsset).toHaveBeenCalledExactlyOnceWith(loc);
        held.release();
        await vi.advanceTimersByTimeAsync(100);
        expect(revoke).toHaveBeenCalledExactlyOnceWith(src);
    });

    it.each(["controller is absent", "capability is absent", "worker use is off"])(
        "shares getFileSrc's promise and original load when the %s",
        async (missing) => {
            if (missing === "controller is absent") worker.controller = null;
            if (missing === "capability is absent") api.setDirectAssets(false);
            if (missing === "worker use is off") api.setUsingSw(false);

            const loc = path();
            let finish!: (bytes: Buffer) => void;
            const loading = new Promise<Buffer>((resolve) => {
                finish = resolve;
            });
            vi.mocked(assets.readAsset).mockReturnValueOnce(loading);
            const thumbnail = api.getThumbSrc(loc, 256);
            expect(thumbnail).toBe(api.getFileSrc(loc));
            expect(api.getThumbSrc(loc, 512)).toBe(thumbnail);
            finish(Buffer.from([1, 2, 3]));
            const src = await thumbnail;
            expect(src).toMatch(/^blob:/);
            expect(assets.readAsset).toHaveBeenCalledExactlyOnceWith(loc);
            expect(create).toHaveBeenCalledTimes(1);
            expect(await api.getFileSrc(loc)).toBe(src);

            // Only the thumbnail call pins this second path; getFileSrc cannot mask a missing pin.
            const pinnedPath = path();
            const held = api.holdFileSrc(pinnedPath);
            const pinned = api.getThumbSrc(pinnedPath, 256);
            expect(pinned).toBe(held.src);
            await pinned;
            held.release();
            await vi.advanceTimersByTimeAsync(100);
            expect(revoke).not.toHaveBeenCalled();
            expect(api.getFileSrc(pinnedPath)).toBe(pinned);
            expect(assets.readAsset).toHaveBeenCalledTimes(2);
            expect(create).toHaveBeenCalledTimes(2);
        },
    );
});

describe("character image thumbnails", () => {
    const types = ["plain", "css", "contain", "lgcss"] as const;

    it("uses the requested variant in every output form and the original URL when thumb is omitted", async () => {
        const loc = path();
        for (const thumb of [undefined, 256, 512] as const) {
            const expected = directUrl(loc) + (thumb === undefined ? "" : `?w=${thumb}`);
            for (const type of types) {
                const image = await getCharImage(loc, type, thumb);
                if (type === "plain") expect(image).toBe(expected);
                else expect(image).toContain(`url("${expected}")`);
            }
        }
        expect(assets.readAsset).not.toHaveBeenCalled();
    });

    it("keeps hidden-image placeholders with and without a thumbnail", async () => {
        records.applyRaw("ui", { hideAllImages: true });
        for (const thumb of [undefined, 256, 512] as const) {
            for (const loc of [path(), ""]) {
                for (const type of types) {
                    expect(await getCharImage(loc, type, thumb)).toBe(type === "plain" ? "/none.webp" : "");
                }
            }
        }
        expect(assets.readAsset).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps empty-path results with and without a thumbnail", async () => {
        for (const thumb of [undefined, 256, 512] as const) {
            for (const type of types) {
                expect(await getCharImage("", type, thumb)).toBe(type === "css" ? "" : null);
            }
        }
        expect(assets.readAsset).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
