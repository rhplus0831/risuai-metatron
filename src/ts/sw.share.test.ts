// @vitest-environment node

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { COMPLETION_NOTIFICATION_TAG, completionNotificationTag } from "../../shared/notifications.ts";

// Exercise the installed PWA's HTTP contract, including the manifest that sends the POST, and the
// worker's content-free push records (IndexedDB `risu-sw-diagnostics`, over `fake-indexeddb`).
const origin = "https://installed.example:8443";
const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../../public/manifest.json", import.meta.url), "utf8"));

type FakeWindow = {
    url: string;
    focused: boolean;
    visibilityState: string;
    focus: ReturnType<typeof vi.fn>;
    navigate: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
};

/**
 * What the worker's context gets beyond the fixed globals: an IndexedDB factory (none: the worker has
 * no `indexedDB`, as the tests without records run), a clock, and timers under the test's control.
 */
type WorkerGlobals = {
    indexedDB?: unknown;
    Date?: typeof Date;
    setTimeout?: (fn: () => void, ms: number) => unknown;
    clearTimeout?: (id: unknown) => void;
};

function worker(windows: FakeWindow[] = [], globals: WorkerGlobals = {}) {
    const entries = new Map<string, Response>();
    const cacheKey = (url: Request | URL | string) => (url instanceof Request ? url.url : String(url));
    const cache = {
        match: async (url: Request | URL | string) => entries.get(cacheKey(url))?.clone(),
        put: async (url: Request | URL | string, response: Response) => {
            entries.set(cacheKey(url), response.clone());
        },
        delete: async (url: Request | URL | string) => entries.delete(cacheKey(url)),
        keys: async () => [...entries.keys()].map((url) => new Request(url)),
    };
    const open = vi.fn(async () => cache);
    const listeners = new Map<string, (event: unknown) => void>();
    const clients = {
        claim: vi.fn(async () => {}),
        matchAll: vi.fn(async () => windows),
        openWindow: vi.fn(async () => null),
    };
    /** The notifications on screen, as `getNotifications` lists them; a later one replaces its tag's. */
    const shown: { tag: string; data?: unknown; close: ReturnType<typeof vi.fn> }[] = [];
    const registration = {
        showNotification: vi.fn(async (_title: string, options: { tag?: string; silent?: boolean; data?: unknown }) => {
            const tag = options.tag ?? "";
            const replaced = shown.findIndex((notification) => notification.tag === tag);
            if (replaced >= 0) shown.splice(replaced, 1);
            shown.push({ tag, data: options.data, close: vi.fn() });
        }),
        getNotifications: vi.fn(async (filter?: { tag?: string }) =>
            shown.filter((notification) => filter?.tag === undefined || notification.tag === filter.tag),
        ),
    };
    runInNewContext(source, {
        self: {
            location: { origin },
            clients,
            registration,
            addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
        },
        caches: { open },
        Request,
        Response,
        FormData,
        File,
        URL,
        Uint8Array,
        MessageChannel,
        setTimeout,
        clearTimeout,
        ...(globals.indexedDB !== undefined ? { indexedDB: globals.indexedDB, IDBKeyRange } : {}),
        ...(globals.Date ? { Date: globals.Date } : {}),
        ...(globals.setTimeout ? { setTimeout: globals.setTimeout } : {}),
        ...(globals.clearTimeout ? { clearTimeout: globals.clearTimeout } : {}),
    });
    const dispatch = async (request: Request): Promise<Response> => {
        const respondWith = vi.fn();
        listeners.get("fetch")!({ request, respondWith });
        expect(respondWith).toHaveBeenCalledTimes(1);
        return await respondWith.mock.calls[0][0];
    };
    const post = (files: string[]) => {
        const body = new FormData();
        for (const kind of files) body.append(kind, new File([`${kind} bytes\u0000`], `${kind}.bin`));
        return dispatch(new Request(new URL(manifest.share_target.action, origin), { method: "POST", body }));
    };
    const activate = async () => {
        const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
        listeners.get("activate")!({ waitUntil });
        expect(waitUntil).toHaveBeenCalledTimes(1);
        await waitUntil.mock.calls[0][0];
    };
    /** A click on a completion notification; the worker's `waitUntil` promise. */
    const clicked = (url: string): Promise<unknown> => {
        const waitUntil = vi.fn();
        listeners.get("notificationclick")!({ notification: { close: vi.fn(), data: { url } }, waitUntil });
        expect(waitUntil).toHaveBeenCalledTimes(1);
        return waitUntil.mock.calls[0][0];
    };
    /** A click on a completion notification; resolves when the worker's `waitUntil` work is done. */
    const click = async (url: string) => {
        await clicked(url);
    };
    /** A push with `payload` as its JSON data; the worker's `waitUntil` promise. */
    const pushed = (payload: unknown): Promise<unknown> => {
        const waitUntil = vi.fn();
        listeners.get("push")!({ data: { json: () => payload }, waitUntil });
        expect(waitUntil).toHaveBeenCalledTimes(1);
        return waitUntil.mock.calls[0][0];
    };
    /** A push with `payload` as its JSON data; resolves when the worker's `waitUntil` work is done. */
    const push = async (payload: unknown) => {
        await pushed(payload);
    };
    return { entries, open, dispatch, post, activate, clients, click, clicked, push, pushed, registration, shown };
}

function redirected(response: Response, path: string) {
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(origin + path);
}

describe("PWA worker activation", () => {
    it("removes stored assets while preserving pending shares and other cache entries, then claims clients", async () => {
        const sw = worker();
        sw.entries.set(`${origin}/sw/img/6162`, new Response("first asset"));
        sw.entries.set(`${origin}/sw/img/6364?version=old`, new Response("second asset"));
        sw.entries.set(`${origin}/sw/share/module`, new Response("pending module bytes\u0000"));
        sw.entries.set(`${origin}/other`, new Response("other bytes"));

        await sw.activate();

        expect(sw.open).toHaveBeenCalledWith("risuCache");
        expect(new Set(sw.entries.keys())).toEqual(new Set([`${origin}/sw/share/module`, `${origin}/other`]));
        expect(await sw.entries.get(`${origin}/sw/share/module`)!.text()).toBe("pending module bytes\u0000");
        expect(await sw.entries.get(`${origin}/other`)!.text()).toBe("other bytes");
        expect(sw.clients.claim).toHaveBeenCalledTimes(1);
    });

    it("settles activation and claims clients when the cache cannot be opened", async () => {
        const sw = worker();
        sw.open.mockRejectedValueOnce(new Error("cache unavailable"));

        await expect(sw.activate()).resolves.toBeUndefined();

        expect(sw.open).toHaveBeenCalledWith("risuCache");
        expect(sw.clients.claim).toHaveBeenCalledTimes(1);
    });
});

describe("PWA share receiver", () => {
    it("receives the manifest's multipart module POST at an absolute cache URL", async () => {
        expect(manifest.share_target).toEqual({
            action: "/sw/share",
            method: "POST",
            enctype: "multipart/form-data",
            params: {
                files: [
                    { name: "character", accept: [".charx"] },
                    { name: "preset", accept: [".risup"] },
                    { name: "module", accept: [".risum"] },
                ],
            },
        });
        const sw = worker();
        redirected(await sw.post(["module"]), "/#share_module");
        expect(sw.open).toHaveBeenCalledWith("risuCache");
        expect([...sw.entries.keys()]).toEqual([origin + "/sw/share/module"]);
        const stored = sw.entries.get(origin + "/sw/share/module")!;
        expect(new Uint8Array(await stored.arrayBuffer())).toEqual(new TextEncoder().encode("module bytes\u0000"));
        expect(stored.headers.has("content-type")).toBe(false);
    });

    it.each([
        { files: ["module", "preset", "character"], winner: "character" },
        { files: ["module", "preset"], winner: "preset" },
    ])("prefers $winner regardless of multipart field order", async ({ files, winner }) => {
        const sw = worker();
        redirected(await sw.post(files), `/#share_${winner}`);
        expect([...sw.entries.keys()]).toEqual([`${origin}/sw/share/${winner}`]);
        expect(await sw.entries.get(`${origin}/sw/share/${winner}`)!.text()).toBe(`${winner} bytes\u0000`);
    });

    it("redirects a POST without a supported file home without caching it", async () => {
        const sw = worker();
        redirected(await sw.post(["unrelated"]), "/");
        expect(sw.entries.size).toBe(0);
    });

    it("redirects GET share URLs home without reading form data", async () => {
        const sw = worker();
        const request = new Request(origin + "/sw/share/module");
        const formData = vi.spyOn(request, "formData");
        redirected(await sw.dispatch(request), "/");
        expect(formData).not.toHaveBeenCalled();
        expect(sw.entries.size).toBe(0);
    });

    it("still registers asset bytes when the caller supplies a URL object", async () => {
        const sw = worker();
        const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
        const response = await sw.dispatch(new Request(origin + "/sw/register/6162", { method: "POST", body: bytes }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ done: true });
        const stored = await sw.dispatch(new Request(origin + "/sw/img/6162"));
        expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
    });
});

describe("notification click", () => {
    /** A window of the app that does not answer `risu-open-route` (its page is still loading). */
    function silentWindow(navigate: () => Promise<unknown>): FakeWindow {
        return {
            url: origin + "/",
            focused: true,
            visibilityState: "visible",
            focus: vi.fn(async () => {}),
            navigate: vi.fn(navigate),
            postMessage: vi.fn(() => {
                throw new Error("not ready");
            }),
        };
    }

    it("navigates a window that does not answer, and opens none", async () => {
        const target = silentWindow(async () => null);
        const sw = worker([target]);
        await sw.click("/chat/a/b");
        expect(target.focus).toHaveBeenCalledTimes(1);
        expect(target.navigate).toHaveBeenCalledWith("/chat/a/b");
        expect(sw.clients.openWindow).not.toHaveBeenCalled();
    });

    it("opens a window with the chat route when the navigation is refused", async () => {
        const target = silentWindow(async () => {
            throw new TypeError("This service worker is not the client's active service worker.");
        });
        const sw = worker([target]);
        await sw.click("/chat/a/b");
        expect(target.navigate).toHaveBeenCalledWith("/chat/a/b");
        expect(sw.clients.openWindow).toHaveBeenCalledWith("/chat/a/b");
    });

    it("still settles when the fallback window cannot be opened either", async () => {
        const sw = worker([silentWindow(() => Promise.reject(new TypeError("refused")))]);
        sw.clients.openWindow.mockRejectedValue(new TypeError("not allowed"));
        await expect(sw.click("/chat/a/b")).resolves.toBeUndefined();
        expect(sw.clients.openWindow).toHaveBeenCalledTimes(1);
    });
});

describe("completion push", () => {
    const payload = (tag: unknown) => ({ title: "Risuai", body: "Done.", url: "/chat/c/a", tag });
    const shownTags = (sw: ReturnType<typeof worker>) =>
        sw.registration.showNotification.mock.calls.map((call) => call[1].tag);

    it("shows each chat's push under that chat's tag, so another chat's notice stays", async () => {
        const sw = worker();
        const tagA = completionNotificationTag("c", "a");
        const tagB = completionNotificationTag("c", "b");
        await sw.push(payload(tagA));
        await sw.push(payload(tagB));
        await sw.push(payload(tagA));
        expect(shownTags(sw)).toEqual([tagA, tagB, tagA]);
        expect(tagA).not.toBe(tagB);
    });

    it("falls back to the bare prefix for a missing, foreign, or oversized tag", async () => {
        const sw = worker();
        await sw.push(payload(undefined));
        await sw.push(payload("someone-else"));
        await sw.push(payload(7));
        await sw.push(payload(`${COMPLETION_NOTIFICATION_TAG}:${"x".repeat(64)}`));
        expect(shownTags(sw)).toEqual(Array(4).fill(COMPLETION_NOTIFICATION_TAG));
    });

    const appWindow = (focused: boolean, url = origin + "/chat/c/a"): FakeWindow => ({
        url,
        focused,
        visibilityState: "visible",
        focus: vi.fn(async () => {}),
        navigate: vi.fn(async () => null),
        postMessage: vi.fn(),
    });
    /** Each shown notification's `silent`, or "unset" when the option is left out (the platform's default). */
    const silentFlags = (sw: ReturnType<typeof worker>) =>
        sw.registration.showNotification.mock.calls.map((call) => ("silent" in call[1] ? call[1].silent : "unset"));

    it("shows the push silently and closes it at once while a window of the app has the focus", async () => {
        const front = appWindow(false);
        const sw = worker([appWindow(false), front]);
        // Another chat's notice, shown before the window took the focus, stays.
        const other = completionNotificationTag("c", "b");
        await sw.push(payload(other));
        front.focused = true;
        sw.clients.matchAll.mockClear();
        const tag = completionNotificationTag("c", "a");
        await sw.push(payload(tag));
        expect(sw.clients.matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
        expect(silentFlags(sw)).toEqual(["unset", true]);
        expect(sw.shown.find((notification) => notification.tag === tag)!.close).toHaveBeenCalledTimes(1);
        expect(sw.shown.find((notification) => notification.tag === other)!.close).not.toHaveBeenCalled();
    });

    it("sounds and keeps the push when the app's windows are unfocused, foreign, or cannot be listed", async () => {
        const tag = completionNotificationTag("c", "a");
        for (const sw of [
            worker([appWindow(false)]),
            worker([appWindow(true, "https://elsewhere.example/chat/c/a")]),
            worker(),
        ]) {
            await sw.push(payload(tag));
            expect(silentFlags(sw)).toEqual(["unset"]);
            expect(sw.shown[0].close).not.toHaveBeenCalled();
        }
        const failing = worker([appWindow(true)]);
        failing.clients.matchAll.mockRejectedValueOnce(new Error("no clients"));
        await failing.push(payload(tag));
        expect(silentFlags(failing)).toEqual(["unset"]);
        expect(failing.shown[0].close).not.toHaveBeenCalled();
    });

    it("sounds and keeps the push when the focused window is hidden, or focus and visibility are on different windows", async () => {
        const tag = completionNotificationTag("c", "a");
        // An installed Android app left for another app keeps the focus while hidden.
        const hidden = appWindow(true);
        hidden.visibilityState = "hidden";
        const split = appWindow(true);
        split.visibilityState = "hidden";
        for (const sw of [worker([hidden]), worker([split, appWindow(false)])]) {
            await sw.push(payload(tag));
            expect(silentFlags(sw)).toEqual(["unset"]);
            expect(sw.shown[0].close).not.toHaveBeenCalled();
        }
    });

    it("keeps its silent push when the focused window is hidden while the notification is looked up", async () => {
        const tag = completionNotificationTag("c", "a");
        const front = appWindow(true);
        const sw = worker([front]);
        sw.registration.getNotifications.mockImplementationOnce(async () => {
            front.visibilityState = "hidden";
            return sw.shown;
        });
        await sw.push(payload(tag));
        expect(silentFlags(sw)).toEqual([true]);
        expect(sw.shown[0].close).not.toHaveBeenCalled();
    });

    it("keeps a later notification of the same tag, and its own when the focus left while it was shown", async () => {
        const tag = completionNotificationTag("c", "a");
        const raced = worker([appWindow(true)]);
        // A later push of the chat replaced this one before the lookup.
        raced.registration.getNotifications.mockImplementationOnce(async () => {
            raced.shown.splice(0, raced.shown.length, { tag, data: { url: "/chat/c/a", push: 99 }, close: vi.fn() });
            return raced.shown;
        });
        await raced.push(payload(tag));
        expect(raced.shown[0].close).not.toHaveBeenCalled();

        const front = appWindow(true);
        const left = worker([front]);
        // The focus leaves while the notification is looked up.
        left.registration.getNotifications.mockImplementationOnce(async () => {
            front.focused = false;
            return left.shown;
        });
        await left.push(payload(tag));
        expect(silentFlags(left)).toEqual([true]);
        expect(left.shown[0].close).not.toHaveBeenCalled();
    });

    it("shows a push only after the previous one closed its own, each under its own number", async () => {
        const tag = completionNotificationTag("c", "a");
        const sw = worker([appWindow(true)]);
        let listed!: () => void;
        sw.registration.getNotifications.mockImplementationOnce(
            () => new Promise((resolve) => (listed = () => resolve([...sw.shown]))),
        );
        const microtasks = async () => {
            for (let i = 0; i < 20; i++) await Promise.resolve();
        };
        const first = sw.push(payload(tag));
        await microtasks();
        expect(listed).toBeDefined();
        const second = sw.push(payload(tag));
        await microtasks();
        // Chromium closes by tag: the first push's close must not land on the second's notification.
        expect(sw.registration.showNotification).toHaveBeenCalledTimes(1);
        listed();
        await Promise.all([first, second]);
        const numbers = sw.registration.showNotification.mock.calls.map(
            (call) => (call[1].data as { push: number }).push,
        );
        expect(numbers).toHaveLength(2);
        expect(numbers[0]).not.toBe(numbers[1]);
    });

    it("keeps the silence on the text-only retry after a refused option", async () => {
        const sw = worker([appWindow(true)]);
        sw.registration.showNotification.mockRejectedValueOnce(new TypeError("bad icon"));
        await sw.push(payload(completionNotificationTag("c", "a")));
        expect(silentFlags(sw)).toEqual([true, true]);
        expect(sw.shown[0].close).toHaveBeenCalledTimes(1);
    });

    it("keeps the chat's tag when it shows the text alone after a refused option", async () => {
        const sw = worker();
        sw.registration.showNotification.mockRejectedValueOnce(new TypeError("bad icon"));
        const tag = completionNotificationTag("c", "a");
        await sw.push(payload(tag));
        expect(shownTags(sw)).toEqual([tag, tag]);
    });
});

describe("push records", () => {
    const RECORDS_DB = "risu-sw-diagnostics";
    const T0 = Date.UTC(2026, 9, 13, 10, 15);
    const payload = (tag = completionNotificationTag("c", "a")) => ({
        title: "Risuai",
        body: "Done.",
        url: "/chat/c/a",
        tag,
    });
    const appWindow = (focused: boolean, visibilityState = "visible"): FakeWindow => ({
        url: origin + "/chat/c/a",
        focused,
        visibilityState,
        focus: vi.fn(async () => {}),
        navigate: vi.fn(async () => null),
        postMessage: vi.fn(),
    });
    /** A clock the test moves. */
    function clock(start = T0) {
        let now = start;
        class TestDate extends Date {
            static now() {
                return now;
            }
        }
        return { Date: TestDate as unknown as typeof Date, set: (at: number) => (now = at) };
    }
    /** Timers the test fires. */
    function timers() {
        const pending = new Map<number, { fn: () => void; ms: number }>();
        let next = 1;
        return {
            pending,
            setTimeout: (fn: () => void, ms: number) => {
                pending.set(next, { fn, ms });
                return next++;
            },
            clearTimeout: (id: unknown) => void pending.delete(id as number),
            /** Fires every pending timer of `ms`. */
            fire(ms: number) {
                for (const [id, timer] of [...pending]) {
                    if (timer.ms === ms) {
                        pending.delete(id);
                        timer.fn();
                    }
                }
            },
        };
    }
    /** Every record in the store, in key order; none, without creating the database, while the worker has not. */
    async function stored(indexedDB: IDBFactory): Promise<Record<string, unknown>[]> {
        if (!(await indexedDB.databases()).some((database) => database.name === RECORDS_DB)) {
            return [];
        }
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(RECORDS_DB, 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        try {
            if (!db.objectStoreNames.contains("records")) {
                return [];
            }
            return await new Promise((resolve, reject) => {
                const read = db.transaction("records", "readonly").objectStore("records").getAll();
                read.onsuccess = () => resolve(read.result as Record<string, unknown>[]);
                read.onerror = () => reject(read.error);
            });
        } finally {
            db.close();
        }
    }
    /** The store as an earlier worker left it. */
    async function seeded(indexedDB: IDBFactory, rows: unknown[]) {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(RECORDS_DB, 1);
            request.onupgradeneeded = () => request.result.createObjectStore("records", { autoIncrement: true });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("records", "readwrite");
            for (const row of rows) tx.objectStore("records").add(row);
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
        });
        db.close();
    }
    /** Lets every settled promise chain run (no timer fires). */
    const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

    it("records each push's arrival and outcome with the window state it saw, and a click, as fixed phases and booleans only, nothing of the payload", async () => {
        const indexedDB = new IDBFactory();
        const time = clock();
        const front = appWindow(false);
        const sw = worker([front], { indexedDB, Date: time.Date });
        await sw.push(payload());
        time.set(T0 + 1000);
        front.focused = true;
        await sw.push(payload());
        time.set(T0 + 2000);
        front.visibilityState = "hidden";
        await sw.push(payload());
        time.set(T0 + 3000);
        sw.clients.openWindow.mockRejectedValueOnce(new TypeError("not allowed"));
        front.focused = false;
        await sw.click("/chat/c/a");
        const records = await stored(indexedDB);
        expect(records).toEqual([
            { at: T0, kind: "push", phase: "received", inFront: false, focusedHidden: false },
            { at: T0, kind: "push", phase: "shown", inFront: false, focusedHidden: false },
            { at: T0 + 1000, kind: "push", phase: "received", inFront: true, focusedHidden: false },
            { at: T0 + 1000, kind: "push", phase: "shownSilent", inFront: true, focusedHidden: false },
            { at: T0 + 1000, kind: "push", phase: "closedInFront", inFront: true, focusedHidden: false },
            { at: T0 + 2000, kind: "push", phase: "received", inFront: false, focusedHidden: true },
            { at: T0 + 2000, kind: "push", phase: "shown", inFront: false, focusedHidden: true },
            { at: T0 + 3000, kind: "push", phase: "clicked" },
        ]);
        expect(JSON.stringify(records)).not.toMatch(/Risuai|Done|chat|completion|not allowed/);
        expect(sw.registration.showNotification).toHaveBeenCalledTimes(3);
    });

    it("records `closedInFront` only when the second check still found the window in front, and `shown` after a text-only retry", async () => {
        const indexedDB = new IDBFactory();
        const front = appWindow(true);
        const sw = worker([front], { indexedDB, Date: clock().Date });
        sw.registration.getNotifications.mockImplementationOnce(async () => {
            front.focused = false;
            return sw.shown;
        });
        await sw.push(payload());
        sw.registration.showNotification.mockRejectedValueOnce(new TypeError("bad icon"));
        await sw.push(payload());
        // A later push of the chat replaced this one before the lookup: nothing of its own to close.
        front.focused = true;
        sw.registration.getNotifications.mockImplementationOnce(async () => {
            sw.shown.splice(0, sw.shown.length, { tag: payload().tag, data: { push: 99 }, close: vi.fn() });
            return sw.shown;
        });
        await sw.push(payload());
        expect((await stored(indexedDB)).map((record) => record.phase)).toEqual([
            "received",
            "shownSilent",
            "received",
            "shown",
            "received",
            "shownSilent",
        ]);
    });

    it("stamps `received` when the push arrives, not when its turn in the display queue comes, and writes a push's records only once its display settled", async () => {
        const indexedDB = new IDBFactory();
        const time = clock();
        const sw = worker([appWindow(true)], { indexedDB, Date: time.Date });
        let listed!: () => void;
        sw.registration.getNotifications.mockImplementationOnce(
            () => new Promise((resolve) => (listed = () => resolve([...sw.shown]))),
        );
        const first = sw.pushed(payload());
        await drain();
        expect(listed).toBeDefined();
        time.set(T0 + 500);
        const second = sw.pushed(payload());
        await drain();
        expect(sw.registration.showNotification).toHaveBeenCalledTimes(1);
        expect(await stored(indexedDB)).toEqual([]);
        time.set(T0 + 4000);
        listed();
        await Promise.all([first, second]);
        const records = await stored(indexedDB);
        expect(records.map((record) => [record.phase, record.at])).toEqual([
            ["received", T0],
            ["shownSilent", T0],
            ["closedInFront", T0 + 4000],
            ["received", T0 + 500],
            ["shownSilent", T0 + 4000],
            ["closedInFront", T0 + 4000],
        ]);
    });

    it("records `showFailed` when neither show worked, and the push still rejects with the display's error", async () => {
        const indexedDB = new IDBFactory();
        const sw = worker([appWindow(true, "hidden")], { indexedDB, Date: clock().Date });
        sw.registration.showNotification
            .mockRejectedValueOnce(new TypeError("bad icon"))
            .mockRejectedValueOnce(new TypeError("still bad"));
        await expect(sw.push(payload())).rejects.toThrow("still bad");
        expect(await stored(indexedDB)).toEqual([
            { at: T0, kind: "push", phase: "received", inFront: false, focusedHidden: true },
            { at: T0, kind: "push", phase: "showFailed", inFront: false, focusedHidden: true },
        ]);
        // The failure does not stop the next push.
        await sw.push(payload());
        expect((await stored(indexedDB)).map((record) => record.phase)).toEqual([
            "received",
            "showFailed",
            "received",
            "shown",
        ]);
    });

    it("keeps the newest 100 records, pruning the oldest in the same write as the new ones", async () => {
        const indexedDB = new IDBFactory();
        await seeded(
            indexedDB,
            Array.from({ length: 99 }, (_, i) => ({ at: i, kind: "push", phase: "shown" })),
        );
        const sw = worker([], { indexedDB, Date: clock().Date });
        await sw.push(payload());
        const records = await stored(indexedDB);
        expect(records).toHaveLength(100);
        expect(records[0]).toEqual({ at: 1, kind: "push", phase: "shown" });
        expect(records.slice(-2).map((record) => record.phase)).toEqual(["received", "shown"]);
        await sw.push(payload());
        const again = await stored(indexedDB);
        expect(again).toHaveLength(100);
        expect(again[0]).toEqual({ at: 3, kind: "push", phase: "shown" });
    });

    it("shows the notification and settles the push when the record store cannot be opened or its open fails", async () => {
        for (const indexedDB of [
            {
                open() {
                    throw new DOMException("denied", "SecurityError");
                },
            },
            {
                open() {
                    const request: { onerror?: () => void; error: unknown } = { error: new Error("quota") };
                    queueMicrotask(() => request.onerror?.());
                    return request;
                },
            },
        ]) {
            const sw = worker([], { indexedDB, Date: clock().Date });
            await expect(sw.push(payload())).resolves.toBeUndefined();
            expect(sw.registration.showNotification).toHaveBeenCalledTimes(1);
            await expect(sw.click("/chat/c/a")).resolves.toBeUndefined();
        }
    });

    it("never lets a store that does not answer delay the notification or the next push: the write is given up after 2 s, and a connection that opens later is closed unused", async () => {
        const pending: { onsuccess?: () => void; result?: unknown }[] = [];
        const indexedDB = {
            open() {
                const request = {};
                pending.push(request);
                return request;
            },
        };
        const timer = timers();
        const sw = worker([], { indexedDB, Date: clock().Date, ...timer });
        let settled = 0;
        const first = sw.pushed(payload()).then(() => settled++);
        const second = sw.pushed(payload()).then(() => settled++);
        await drain();
        expect(sw.registration.showNotification).toHaveBeenCalledTimes(2);
        expect(settled).toBe(0);
        expect([...timer.pending.values()].map((entry) => entry.ms)).toEqual([2000, 2000]);
        timer.fire(2000);
        await Promise.all([first, second]);
        expect(settled).toBe(2);
        const late = { close: vi.fn(), transaction: vi.fn() };
        for (const request of pending) {
            request.result = late;
            request.onsuccess!();
        }
        expect(late.close).toHaveBeenCalledTimes(2);
        expect(late.transaction).not.toHaveBeenCalled();
    });

    it("records a click when it happens, also when no window could be opened, and leaves that failure the event's", async () => {
        const indexedDB = new IDBFactory();
        const time = clock();
        const sw = worker([], { indexedDB, Date: time.Date });
        sw.clients.openWindow.mockImplementation(async () => {
            time.set(T0 + 9000);
            throw new TypeError("not allowed");
        });
        await expect(sw.clicked("/chat/c/a")).rejects.toThrow("not allowed");
        expect(await stored(indexedDB)).toEqual([{ at: T0, kind: "push", phase: "clicked" }]);
    });
});
