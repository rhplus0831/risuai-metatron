import { createHash } from "node:crypto";
import { expect, test, type Page, type Request } from "@playwright/test";
import { clearSafeBootAttempts, openApp } from "../util/playwright/stack.mjs";

// `getFileSrc` (the uncontrolled-page fix, `global-api.md`) in the real app against the isolated
// stack of `playwright.config.ts`, with the app's own service worker. Before the fix, on a page's
// first load (the worker registered but not controlling the page yet) the worker check reached the
// network, the read answered `undefined`, and every later read of the same path waited forever; a
// refused registration still answered the worker's URL. The worker now claims every page at once,
// so the uncontrolled case is a page whose worker script failed to load (the boot continues without
// the worker). What only the browser shows:
// - on a page without a worker: an object URL (`blob:`) that displays, one storage read and one URL
//   for concurrent and later reads, a missing file answers "" and is read again once it exists;
// - on a page the worker controls, with its direct-asset capability: `/api/asset/<hex>`, signed by the
//   worker and kept in the browser's HTTP cache, so a reload loads a content-named image with no
//   server request;
// - on a page the worker controls, with the direct-asset capability off: `/sw/img/<hex>`, looked up in
//   the worker's Cache Storage from the page (no `/sw/check` request since 2fe139df4; that request is
//   only the fallback when the lookup fails) and registered once for concurrent reads; a missing file
//   is never registered; a refused registration, a registration that never answers (bounded at
//   10 s), and no worker at all fall back to an object URL that displays.
// The worker's own requests are faulted through the page's `fetch`, which `getFileSrc` and the
// storage reads call.

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Wraps the page's `fetch`: records the worker requests and the storage reads (by path), and
 * applies `window.__fileSrcFault` to a registration: `{ path, register: status }` answers it with
 * that status, `{ path, register: "stall" }` never answers it (until aborted).
 */
async function instrument(page: Page) {
    await page.evaluate(() => {
        const w = window as any;
        if (w.__fileSrcLog) return;
        w.__fileSrcLog = [] as string[];
        w.__fileSrcFault = null;
        const decode = (hex: string) =>
            new TextDecoder().decode(Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16)));
        const real = window.fetch.bind(window);
        window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
            const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            const url = new URL(href, location.href);
            const sw = url.pathname.match(/^\/sw\/(check|register)\/([0-9a-f]+)$/);
            if (sw) {
                const [, step, hex] = sw;
                const path = decode(hex);
                w.__fileSrcLog.push(`${step} ${path}`);
                const fault = w.__fileSrcFault;
                if (fault?.path === path && step === "register") {
                    if (fault.register === "stall") {
                        return new Promise<Response>((_, reject) => {
                            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
                        });
                    }
                    if (fault.register) {
                        return Promise.resolve(new Response("refused", { status: fault.register }));
                    }
                }
            }
            if (url.pathname === "/api/read") {
                const headers = new Headers(init?.headers);
                w.__fileSrcLog.push(`read ${decode(headers.get("file-path") ?? "")}`);
            }
            return real(input as RequestInfo, init);
        };
    });
}

const log = (page: Page) => page.evaluate(() => [...(window as any).__fileSrcLog] as string[]);
const count = (entries: string[], entry: string) => entries.filter((e) => e === entry).length;

/** Stores a 1x1 PNG under `assets/<id>.png` and returns that path. */
const store = (page: Page, id: string) =>
    page.evaluate(
        async ({ id, png }) => {
            const { saveAsset } = await import("/src/ts/globalApi.svelte.ts");
            return await saveAsset(
                Uint8Array.from(atob(png), (c) => c.charCodeAt(0)),
                id,
                `${id}.png`,
            );
        },
        { id, png: PNG_1X1 },
    );

/** Stores a portrait PNG with known dimensions for thumbnail and original-image decoding. */
const storePortrait = (page: Page, width: number, height: number) =>
    page.evaluate(
        async ({ width, height, id }) => {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d")!;
            context.fillStyle = "#36845a";
            context.fillRect(0, 0, width, height);
            const png = await new Promise<Blob>((resolve, reject) =>
                canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))), "image/png"),
            );
            const { saveAsset } = await import("/src/ts/globalApi.svelte.ts");
            return await saveAsset(new Uint8Array(await png.arrayBuffer()), id, `${id}.png`);
        },
        { width, height, id: id("portrait") },
    );

/** `getFileSrc` for each path, called concurrently; a read that does not settle in 20 s fails. */
const fileSrc = (page: Page, paths: string[]) =>
    page.evaluate(async (paths) => {
        const { getFileSrc } = await import("/src/ts/globalApi.svelte.ts");
        const deadline = new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error("getFileSrc did not settle in 20 s")), 20_000),
        );
        return await Promise.all(paths.map((path) => Promise.race([getFileSrc(path), deadline])));
    }, paths);

/** The width the browser decodes the URL's image at (0: it does not display). */
const displayedWidth = (page: Page, src: string) =>
    page.evaluate(async (src) => {
        const image = new Image();
        image.src = src;
        try {
            await image.decode();
        } catch {
            return 0;
        }
        return image.naturalWidth;
    }, src);

const controlled = (page: Page) => page.evaluate(() => navigator.serviceWorker.controller !== null);
const hex = (path: string) => Buffer.from(path, "utf-8").toString("hex");

let unique = 0;
const id = (name: string) => `filesrc-${name}-${Date.now().toString(36)}-${unique++}`;

test("a controlled page displays a content-named direct asset and reloads it from the HTTP cache without a server request", async ({
    page,
    context,
    baseURL,
    browserName,
}) => {
    test.skip(browserName !== "chromium", "This cache check uses Chromium's service-worker network events.");
    await clearSafeBootAttempts(page);
    await openApp(page, baseURL!);
    await page.reload();
    await openApp(page, baseURL!);
    await expect.poll(() => controlled(page)).toBe(true);

    const path = await page.evaluate(async (png) => {
        const { saveAsset } = await import("/src/ts/globalApi.svelte.ts");
        return await saveAsset(Uint8Array.from(atob(png), (c) => c.charCodeAt(0)));
    }, PNG_1X1);
    expect(path).toBe(`assets/${createHash("sha256").update(Buffer.from(PNG_1X1, "base64")).digest("hex")}.png`);
    const expectedSrc = `/api/asset/${hex(path)}`;
    const url = new URL(expectedSrc, baseURL).href;
    const requests: Request[] = [];
    // Context events include the worker's signed fetch. Page fetch instrumentation cannot see it.
    context.on("request", (request) => {
        if (request.url() === url) requests.push(request);
    });
    const serverRequests = async () => {
        const reachedServer = await Promise.all(
            requests.map(async (request) => {
                const response = await request.response();
                expect(response).not.toBeNull();
                await response!.finished();
                if (response!.fromServiceWorker()) return false;
                // Chromium can retain send timings on disk-cache hits. Transferred bytes are zero
                // for those hits; a server response (even a 304) transfers at least its headers.
                const sizes = await request.sizes();
                return sizes.responseHeadersSize + sizes.responseBodySize > 0;
            }),
        );
        return reachedServer.filter(Boolean).length;
    };
    const display = async () => {
        const src = await page.evaluate(async (key) => {
            const { getFileSrc } = await import("/src/ts/globalApi.svelte.ts");
            return await getFileSrc(key);
        }, path);
        expect(src).toBe(expectedSrc);
        const finished = context.waitForEvent("requestfinished", {
            predicate: (request) => request.url() === url && request.serviceWorker() === null,
        });
        const width = await page.evaluate(async (src) => {
            const image = document.createElement("img");
            image.src = src;
            document.body.append(image);
            await image.decode();
            return image.naturalWidth;
        }, src);
        expect(width).toBe(1);
        return await finished;
    };

    const first = await display();
    expect((await first.response())!.fromServiceWorker()).toBe(true);
    expect(requests.some((request) => request.serviceWorker() !== null)).toBe(true);
    // A cold first load proves that the observer sees real server requests, including the worker's.
    expect(await serverRequests()).toBe(1);
    expect((await first.response())!.headers()["cache-control"]).toContain("immutable");

    requests.length = 0;
    await page.reload();
    await openApp(page, baseURL!);
    expect(await controlled(page)).toBe(true);
    await display();
    expect(await serverRequests()).toBe(0);

    for (const [width, height, displayed, status] of [
        [1024, 1536, 256, 200],
        [200, 300, 200, 307],
    ]) {
        const portrait = await storePortrait(page, width, height);
        const thumbnail = await page.evaluate(async (path) => {
            const { getThumbSrc } = await import("/src/ts/globalApi.svelte.ts");
            return await getThumbSrc(path, 256);
        }, portrait);
        const original = `/api/asset/${hex(portrait)}`;
        expect(thumbnail).toBe(`${original}?w=256`);
        const response = context.waitForEvent("response", {
            predicate: (response) =>
                response.url() === new URL(thumbnail, baseURL).href && response.request().serviceWorker() !== null,
        });
        expect(await displayedWidth(page, thumbnail)).toBe(displayed);
        const signed = await response;
        expect(signed.status()).toBe(status);
        if (status === 307) {
            expect(signed.headers()["location"]).toBe(original);
        } else {
            expect(signed.headers()["content-type"]).toBe("image/webp");
        }
    }
});

test("on a page without a worker: an object URL that displays, one read for concurrent and later reads, and a missing file read again", async ({
    page,
    baseURL,
}) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 300)));
    // The worker claims every page at once (`clients.claim`), so a page it does not control is made
    // by failing its script (a context route: the page's routes do not see the worker script
    // request); the boot records the failure and continues without it.
    await page
        .context()
        .route("**/sw.js", (route) => route.fulfill({ status: 503, contentType: "text/javascript", body: "" }));
    await openApp(page, baseURL!);
    expect(await controlled(page)).toBe(false);
    await instrument(page);

    const path = await store(page, id("first"));
    const concurrent = await fileSrc(page, [path, path, path]);
    expect(concurrent[0]).toMatch(/^blob:/);
    expect(new Set(concurrent).size).toBe(1);
    expect(await displayedWidth(page, concurrent[0])).toBe(1);
    // A later read of the same path answers the same URL without reading again.
    expect(await fileSrc(page, [path])).toEqual([concurrent[0]]);
    expect(count(await log(page), `read ${path}`)).toBe(1);

    const portrait = await storePortrait(page, 1024, 1536);
    const [thumbnail, original] = await page.evaluate(async (path) => {
        const { getThumbSrc, getFileSrc } = await import("/src/ts/globalApi.svelte.ts");
        return await Promise.all([getThumbSrc(path, 256), getFileSrc(path)]);
    }, portrait);
    expect(thumbnail).toBe(original);
    expect(thumbnail).toMatch(/^blob:/);
    expect(await displayedWidth(page, thumbnail)).toBe(1024);
    expect(count(await log(page), `read ${portrait}`)).toBe(1);

    // A missing file answers "" and is not kept: once it exists, the next read answers it.
    const missingId = id("missing");
    const missing = `assets/${missingId}.png`;
    expect(await fileSrc(page, [missing])).toEqual([""]);
    expect(await store(page, missingId)).toBe(missing);
    const [found] = await fileSrc(page, [missing]);
    expect(found).toMatch(/^blob:/);
    expect(await displayedWidth(page, found)).toBe(1);
    expect(count(await log(page), `read ${missing}`)).toBe(2);
    expect(errors).toEqual([]);
});

test("on a page the worker controls with direct assets off: its URL, registered once; a missing file never registered; every worker failure and no worker fall back to an object URL", async ({
    page,
    baseURL,
}) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 300)));
    await openApp(page, baseURL!);
    await page.reload();
    await openApp(page, baseURL!);
    await expect.poll(() => controlled(page), { timeout: 20_000 }).toBe(true);
    await instrument(page);
    // The worker reports the direct-asset capability; without it a controlled page uses the worker's
    // Cache Storage path below.
    await page.evaluate(async () => (await import("/src/ts/globalApi.svelte.ts")).setDirectAssets(false));

    // Concurrent reads: a page-side cache miss (no worker check), one registration, one storage read,
    // one URL that displays.
    const path = await store(page, id("controlled"));
    const concurrent = await fileSrc(page, [path, path, path]);
    expect(concurrent).toEqual(Array(3).fill(`/sw/img/${hex(path)}`));
    expect(await displayedWidth(page, concurrent[0])).toBe(1);
    expect(await fileSrc(page, [path])).toEqual([concurrent[0]]);
    let entries = await log(page);
    expect([
        count(entries, `check ${path}`),
        count(entries, `register ${path}`),
        count(entries, `read ${path}`),
    ]).toEqual([0, 1, 1]);

    // A missing file: "" and nothing registered in the worker's cache; once it exists, its URL.
    const missingId = id("missing");
    const missing = `assets/${missingId}.png`;
    expect(await fileSrc(page, [missing])).toEqual([""]);
    entries = await log(page);
    expect(count(entries, `register ${missing}`)).toBe(0);
    const cached = (target: string) =>
        page.evaluate(async (url) => !!(await (await caches.open("risuCache")).match(url)), target);
    expect(await cached(`/sw/img/${hex(missing)}`)).toBe(false);
    await store(page, missingId);
    const [found] = await fileSrc(page, [missing]);
    expect(found).toBe(`/sw/img/${hex(missing)}`);
    expect(await displayedWidth(page, found)).toBe(1);

    // The worker refuses the registration: an object URL, not the worker's URL of a file it lacks.
    const refused = await store(page, id("refused"));
    await page.evaluate((path) => ((window as any).__fileSrcFault = { path, register: 500 }), refused);
    const [refusedSrc] = await fileSrc(page, [refused]);
    expect(refusedSrc).toMatch(/^blob:/);
    expect(await displayedWidth(page, refusedSrc)).toBe(1);

    // The worker's registration never answers: after its 10 s bound, an object URL.
    const stalled = await store(page, id("stalled"));
    await page.evaluate((path) => ((window as any).__fileSrcFault = { path, register: "stall" }), stalled);
    const started = Date.now();
    const [stalledSrc] = await fileSrc(page, [stalled]);
    const waited = Date.now() - started;
    expect(stalledSrc).toMatch(/^blob:/);
    expect(waited).toBeGreaterThanOrEqual(9_000);
    expect(await displayedWidth(page, stalledSrc)).toBe(1);
    await page.evaluate(() => ((window as any).__fileSrcFault = null));

    // No worker at all: an object URL, and no worker request.
    const plain = await store(page, id("no-worker"));
    const [plainSrc] = await page.evaluate(async (path) => {
        const api = await import("/src/ts/globalApi.svelte.ts");
        api.setUsingSw(false);
        try {
            return [await api.getFileSrc(path)];
        } finally {
            api.setUsingSw(true);
        }
    }, plain);
    expect(plainSrc).toMatch(/^blob:/);
    expect(await displayedWidth(page, plainSrc)).toBe(1);
    entries = await log(page);
    expect(entries.filter((entry) => entry.endsWith(` ${plain}`))).toEqual([`read ${plain}`]);
    expect(errors).toEqual([]);
});
