// @vitest-environment node

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Exercise the installed PWA's HTTP contract, including the manifest that sends the POST.
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

function worker(windows: FakeWindow[] = []) {
    const entries = new Map<string, Response>();
    const cache = {
        match: async (url: URL) => entries.get(String(url))?.clone(),
        put: async (url: URL, response: Response) => {
            entries.set(String(url), response.clone());
        },
        delete: async (url: URL) => entries.delete(String(url)),
    };
    const open = vi.fn(async () => cache);
    const listeners = new Map<string, (event: unknown) => void>();
    const clients = {
        matchAll: vi.fn(async () => windows),
        openWindow: vi.fn(async () => null),
    };
    runInNewContext(source, {
        self: {
            location: { origin },
            clients,
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
    /** A click on a completion notification; resolves when the worker's `waitUntil` work is done. */
    const click = async (url: string) => {
        const waitUntil = vi.fn();
        listeners.get("notificationclick")!({ notification: { close: vi.fn(), data: { url } }, waitUntil });
        expect(waitUntil).toHaveBeenCalledTimes(1);
        await waitUntil.mock.calls[0][0];
    };
    return { entries, open, dispatch, post, clients, click };
}

function redirected(response: Response, path: string) {
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(origin + path);
}

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
