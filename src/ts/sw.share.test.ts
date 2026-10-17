// @vitest-environment node

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// WEB-01: exercise the installed PWA's HTTP contract, including the manifest that sends the POST.
const origin = "https://installed.example:8443";
const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../../public/manifest.json", import.meta.url), "utf8"));

function worker() {
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
    runInNewContext(source, {
        self: {
            location: { origin },
            addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
        },
        caches: { open },
        Request,
        Response,
        FormData,
        File,
        URL,
        Uint8Array,
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
    return { entries, open, dispatch, post };
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
