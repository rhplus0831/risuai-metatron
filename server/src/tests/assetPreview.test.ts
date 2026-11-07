// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { ASSET_PREVIEW_PATH, ASSET_SWEEP_PATH } from "../../../shared/assetLifecycle.ts";
import { createServerContext } from "../app.ts";
import { assetLeased } from "../http/assetLeases.ts";
import type { ThumbnailOptions } from "../http/assetThumbnails.ts";
import { seedSweepAsset, sweepClock } from "./assetSweepFixtures.ts";
import { createSigner, hex, json, TEST_INDEX_HTML } from "./testSupport.ts";

const cleanups: (() => Promise<void>)[] = [];
let large: Buffer;
let small: Buffer;
beforeAll(async () => {
    const png = (width: number, height: number) =>
        sharp({ create: { width, height, channels: 3, background: "#c05030" } })
            .png()
            .toBuffer();
    large = await png(320, 480);
    // The long side exceeds 256: the original decision must use the short side, including equality.
    small = await png(256, 384);
});
beforeEach(() => {
    // Freeze JWT/rate-limit time and the process-wide lease clock; lifecycle time is injected below.
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
    for (const close of cleanups.splice(0).reverse()) await close();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

const previewUrl = (key: string) => `${ASSET_PREVIEW_PATH}/${hex(key)}`;

// The resource client helper does not expose thumbnailOptions, so use the same in-process app and signer.
async function server(thumbnailOptions: ThumbnailOptions = {}) {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "risu-asset-preview-"));
    const savePath = path.join(rootDir, "save");
    await fs.mkdir(path.join(rootDir, "dist"));
    await fs.writeFile(path.join(rootDir, "dist", "index.html"), TEST_INDEX_HTML);
    await fs.mkdir(path.join(savePath, "server"), { recursive: true });
    await fs.writeFile(path.join(savePath, "server", "password"), "pw");
    const clock = sweepClock();
    const context = createServerContext({ rootDir, assetLifecycle: clock.options, thumbnailOptions });
    cleanups.push(async () => {
        await context.dispose();
        await fs.rm(rootDir, { recursive: true, force: true });
    });
    const signer = await createSigner();
    const login = await context.app.request("/api/login", json({ password: "pw", publicKey: signer.publicJwk }));
    await login.arrayBuffer();
    expect(login.status).toBe(200);
    const request = async (url: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        headers.set("risu-auth", await signer.jwt());
        return context.app.request(url, { ...init, headers });
    };
    const { epoch } = (await (await request("/api/resources/ui")).json()) as { epoch: string };
    return {
        context,
        savePath,
        clock,
        preview: (key: string) => request(previewUrl(key)),
        sweep: (key: string) => request(ASSET_SWEEP_PATH, json({ dryRun: false, keys: [key], inlays: [] })),
        cache: (key: string) =>
            path.join(savePath, "cache", "thumbnails", createHash("sha256").update(key).digest("hex")),
        async seed(key: string, bytes = large) {
            const file = seedSweepAsset({ savePath }, key);
            await fs.writeFile(file, bytes);
            await fs.utimes(file, 1, 1);
            return file;
        },
        async create(kind: string, id: string, data: unknown) {
            const response = await request(`/api/resources/${kind}/${id}`, {
                ...json({ baseRevision: null, data }, { "x-resource-epoch": epoch }),
                method: "PUT",
            });
            await response.arrayBuffer();
            expect(response.status).toBe(200);
        },
        async mature() {
            expect((await context.assetLifecycle.scan()).complete).toBe(true);
            clock.advanceWall();
            expect((await context.assetLifecycle.scan()).complete).toBe(true);
        },
    };
}

async function previewBody(response: Response, status: number, label: string) {
    const body = Buffer.from(await response.arrayBuffer());
    expect.soft(response.status, label).toBe(status);
    expect.soft(response.headers.get("cache-control"), label).toBe("no-store");
    expect.soft(response.headers.get("content-security-policy"), label).toMatch(/^sandbox(?:;|$)/);
    expect.soft(response.headers.get("x-content-type-options"), label).toBe("nosniff");
    expect.soft(response.headers.get("location"), label).toBeNull();
    return body;
}

it("requires auth even for a past-grace image and secures the 401 response", async () => {
    const s = await server();
    const key = "assets/private.png";
    await s.seed(key);
    await s.mature();
    await previewBody(await s.context.app.request(previewUrl(key)), 401, "unauthenticated preview");
});

it("returns 404 for referenced, young, non-image, active-extension, and unknown keys", async () => {
    const s = await server();
    const cases = [
        ["referenced", "assets/referenced.png"],
        ["young", "assets/young.png"],
        ["non-image", "assets/audio.mp3"],
        // assetMime.ts lists HTML as active; SVG is intentionally allowed inline under CSP.
        ["active-extension", "assets/document.html"],
        ["unknown", "assets/unknown.png"],
    ] as const;
    for (const [label, key] of cases) {
        // Valid PNG bytes make a missing MIME/admission check observable even under the other extensions.
        if (label !== "young" && label !== "unknown") await s.seed(key);
    }
    await s.create("pluginStorage", "main", { image: "assets/referenced.png" });
    await s.mature();
    await s.seed("assets/young.png");
    expect((await s.context.assetLifecycle.scan()).complete).toBe(true);
    for (const [label, key] of cases) {
        await previewBody(await s.preview(key), 404, label);
        await expect(fs.stat(s.cache(key)), label).rejects.toMatchObject({ code: "ENOENT" });
    }
});

it("serves WebP for mature candidates and orphan-inlay images, and exact bytes for small images", async () => {
    const s = await server();
    const candidate = "assets/그림.png";
    const orphan = "assets/orphan.png";
    const original = "assets/small.png";
    await s.seed(candidate);
    await s.seed(orphan);
    await s.seed(original, small);
    await s.create("inlays", "orphan", { asset: orphan, type: "image", name: "Orphan", ext: "png" });
    await s.mature();
    // The inlay's asset is referenced by its record, so this exercises the separate orphan admission path.
    const report = s.context.assetLifecycle.report();
    expect(report.unreferenced.candidates.map(({ key }) => key).sort()).toEqual([candidate, original].sort());
    expect(report.orphanInlays.records).toEqual([expect.objectContaining({ id: "orphan", asset: orphan })]);
    for (const key of [candidate, orphan, original]) {
        const response = await s.preview(key);
        const body = await previewBody(response, 200, key);
        expect.soft(response.headers.get("content-disposition"), key).toBe("inline");
        expect.soft(response.headers.get("content-type"), key).toBe(key === original ? "image/png" : "image/webp");
        if (key === original) {
            expect(body).toEqual(small);
        } else {
            expect(await sharp(body).metadata()).toMatchObject({ format: "webp", width: 256, height: 384 });
        }
    }
});

it("returns 404 without redirecting when thumbnails are unavailable or fail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const failure of ["unavailable", "error"] as const) {
        const s = await server({
            loadSharp: async () => {
                if (failure === "unavailable") throw new Error("native encoder unavailable");
                return sharp;
            },
        });
        const key = `assets/${failure}.png`;
        // A truncated PNG reaches the real decoder and fails metadata inspection.
        await s.seed(key, failure === "error" ? large.subarray(0, 8) : large);
        await s.mature();
        await previewBody(await s.preview(key), 404, failure);
        await expect(fs.stat(s.cache(key)), failure).rejects.toMatchObject({ code: "ENOENT" });
    }
});

it("never leases a preview and leaves no thumbnail cache after preview and sweep in either order", async () => {
    for (const order of ["preview then sweep", "sweep then preview"] as const) {
        const s = await server();
        const key = "assets/sweep.png";
        const file = await s.seed(key);
        await s.mature();
        expect(assetLeased(file), order).toBe(false);
        if (order === "preview then sweep") {
            await previewBody(await s.preview(key), 200, order);
            expect.soft(assetLeased(file), order).toBe(false);
            expect(await fs.readdir(s.cache(key))).not.toEqual([]);
        }
        // Do not advance either clock: this must be deletable immediately after the preview.
        const swept = await s.sweep(key);
        expect(swept.status, order).toBe(200);
        expect(await swept.json(), order).toMatchObject({ deleted: [key], skipped: [], freedBytes: large.length });
        await expect(fs.stat(file), order).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(s.cache(key)), order).rejects.toMatchObject({ code: "ENOENT" });
        await previewBody(await s.preview(key), 404, `${order}: swept key`);
        expect(assetLeased(file), order).toBe(false);
        await expect(fs.stat(s.cache(key)), order).rejects.toMatchObject({ code: "ENOENT" });
    }
});
