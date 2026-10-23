// @vitest-environment node

import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

const origin = "https://installed.example:8443";
const assetUrl = `${origin}/api/asset/${Buffer.from("assets/private.png").toString("hex")}`;
const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const issuedAt = Date.parse("2026-01-15T12:00:00Z") / 1000;

const generateKeyPair = () =>
    webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);

async function openDatabase(indexedDB: IDBFactory, createStore = true) {
    return new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("DPoPDB", 1);
        request.onupgradeneeded = () => {
            if (createStore) request.result.createObjectStore("node");
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
}

async function storeKeyPair(indexedDB: IDBFactory, keyPair: webcrypto.CryptoKeyPair) {
    const db = await openDatabase(indexedDB);
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction("node", "readwrite");
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
            tx.onerror = () => reject(tx.error);
            tx.objectStore("node").put({ privateKey: keyPair.privateKey, publicKey: keyPair.publicKey }, "dpop");
        });
    } finally {
        db.close();
    }
}

// Request constructors cannot set a subresource destination; the browser supplies it at dispatch.
function assetRequest(destination = "image", init: RequestInit = {}, url = assetUrl) {
    return Object.defineProperty(new Request(url, init), "destination", { value: destination });
}

function worker(indexedDB = new IDBFactory()) {
    let now = issuedAt * 1000;
    class WorkerDate extends Date {
        static now() {
            return now;
        }
    }
    const listeners = new Map<string, (event: unknown) => void>();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("asset bytes"));
    runInNewContext(source, {
        self: {
            location: { origin },
            addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
        },
        indexedDB,
        crypto: webcrypto,
        TextEncoder,
        btoa,
        Headers,
        Request,
        Response,
        URL,
        Uint8Array,
        Date: WorkerDate,
        fetch,
    });
    const dispatch = async (request: Request, clientId = "page-client") => {
        const respondWith = vi.fn<(response: Response | Promise<Response>) => void>();
        listeners.get("fetch")!({ request, clientId, respondWith });
        const response = await respondWith.mock.calls[0]?.[0];
        return { respondWith, response };
    };
    const respond = async (request: Request) => {
        const { respondWith, response } = await dispatch(request);
        expect(respondWith).toHaveBeenCalledTimes(1);
        return response!;
    };
    const sent = (index: number) => {
        const [input, init] = fetch.mock.calls[index];
        return new Request(input, init);
    };
    const token = (index: number) => {
        const value = sent(index).headers.get("risu-auth");
        expect(value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        return value!;
    };
    return { indexedDB, fetch, dispatch, respond, sent, token, setTime: (seconds: number) => (now = seconds * 1000) };
}

function payload(token: string) {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

async function expectJwt(token: string, keyPair: webcrypto.CryptoKeyPair, iat: number) {
    const [header, body, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toEqual({ alg: "ES256", typ: "JWT" });
    expect(payload(token)).toEqual({
        iat,
        exp: iat + 300,
        pub: await webcrypto.subtle.exportKey("jwk", keyPair.publicKey),
    });
    expect(
        await webcrypto.subtle.verify(
            { name: "ECDSA", hash: "SHA-256" },
            keyPair.publicKey,
            Buffer.from(signature, "base64url"),
            new TextEncoder().encode(`${header}.${body}`),
        ),
    ).toBe(true);
}

describe("PWA direct asset requests", () => {
    it("signs allowed GET and HEAD subresources with fresh cacheable fetches and range headers", async () => {
        const sw = worker();
        const keyPair = await generateKeyPair();
        await storeKeyPair(sw.indexedDB, keyPair);

        for (const destination of ["image", "audio", "video", "track", "style", "font"]) {
            for (const method of ["GET", "HEAD"]) {
                const request = assetRequest(destination, {
                    method,
                    mode: "no-cors",
                    credentials: "include",
                    cache: "no-store",
                    headers: { Range: "bytes=2-5", "If-Range": '"asset-version"' },
                });
                const call = sw.fetch.mock.calls.length;
                await sw.respond(request);
                expect(sw.fetch).toHaveBeenCalledTimes(call + 1);
                const sent = sw.sent(call);
                expect(sent.url).toBe(assetUrl);
                expect(sent.method).toBe(method);
                expect(sent.mode).toBe("same-origin");
                expect(sent.credentials).toBe("omit");
                expect(sent.cache).toBe("default");
                expect(sent.headers.get("range")).toBe("bytes=2-5");
                expect(sent.headers.get("if-range")).toBe('"asset-version"');
                await expectJwt(sw.token(call), keyPair, issuedAt);
                expect(request.headers.has("risu-auth")).toBe(false);
            }
        }
    });

    it("leaves fetches, navigations, and requests outside page subresources untouched", async () => {
        const sw = worker();
        await storeKeyPair(sw.indexedDB, await generateKeyPair());
        const cases: { request: Request; clientId?: string }[] = [
            ...["", "document", "iframe", "worker"].map((destination) => ({ request: assetRequest(destination) })),
            { request: assetRequest("image", { method: "POST" }) },
            { request: assetRequest(), clientId: "" },
            { request: assetRequest("image", {}, `${origin}/api/read`) },
        ];
        for (const { request, clientId } of cases) {
            const { respondWith } = await sw.dispatch(request, clientId);
            expect(respondWith, `${request.method} ${request.url} ${request.destination}`).not.toHaveBeenCalled();
        }
        expect(sw.fetch).not.toHaveBeenCalled();
    });

    it("leaves cross-origin asset URLs untouched", async () => {
        const sw = worker();
        await storeKeyPair(sw.indexedDB, await generateKeyPair());
        const request = assetRequest("image", {}, assetUrl.replace(origin, "https://foreign.example"));
        const { respondWith } = await sw.dispatch(request);
        expect(respondWith).not.toHaveBeenCalled();
        expect(sw.fetch).not.toHaveBeenCalled();
    });

    it("reuses a token until sixty seconds before expiry and then signs a new five-minute token", async () => {
        const sw = worker();
        const keyPair = await generateKeyPair();
        await storeKeyPair(sw.indexedDB, keyPair);
        await sw.respond(assetRequest());
        const initial = sw.token(0);
        await expectJwt(initial, keyPair, issuedAt);

        sw.setTime(issuedAt + 239);
        await sw.respond(assetRequest());
        expect(sw.token(1)).toBe(initial);
        expect(payload(sw.token(1))).toMatchObject({ iat: issuedAt, exp: issuedAt + 300 });

        sw.setTime(issuedAt + 240);
        await sw.respond(assetRequest());
        await expectJwt(sw.token(2), keyPair, issuedAt + 240);
        expect(sw.fetch).toHaveBeenCalledTimes(3);
    });

    it("re-reads a replaced key on 401 and returns a second 401 without another retry", async () => {
        const sw = worker();
        const originalKey = await generateKeyPair();
        const replacementKey = await generateKeyPair();
        await storeKeyPair(sw.indexedDB, originalKey);
        sw.fetch.mockImplementationOnce(async () => {
            await storeKeyPair(sw.indexedDB, replacementKey);
            return new Response("first rejection", { status: 401 });
        });
        sw.fetch.mockResolvedValueOnce(new Response("second rejection", { status: 401 }));

        const response = await sw.respond(assetRequest("video", { headers: { Range: "bytes=4-" } }));
        expect(sw.fetch).toHaveBeenCalledTimes(2);
        expect(response.status).toBe(401);
        expect(await response.text()).toBe("second rejection");
        await expectJwt(sw.token(0), originalKey, issuedAt);
        await expectJwt(sw.token(1), replacementKey, issuedAt);
        expect(sw.sent(1).url).toBe(assetUrl);
        expect(sw.sent(1).headers.get("range")).toBe("bytes=4-");
    });

    it("passes through without a key and leaves an absent database or store uncreated", async () => {
        for (const state of ["absent database", "absent store", "empty store"] as const) {
            const sw = worker();
            if (state !== "absent database") {
                const db = await openDatabase(sw.indexedDB, state === "empty store");
                db.close();
            }
            sw.fetch.mockResolvedValue(new Response("No auth header", { status: 401 }));
            const request = assetRequest();
            const response = await sw.respond(request);
            expect(response.status, state).toBe(401);
            expect(sw.fetch).toHaveBeenCalledExactlyOnceWith(request);
            expect(sw.sent(0).headers.has("risu-auth"), state).toBe(false);

            // Opening afterwards waits for any earlier upgrade/abort to finish, without sleeps.
            let upgraded = false;
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const open = sw.indexedDB.open("DPoPDB", 1);
                open.onupgradeneeded = () => {
                    upgraded = true;
                };
                open.onsuccess = () => resolve(open.result);
                open.onerror = () => reject(open.error);
            });
            const stores = [...db.objectStoreNames];
            db.close();
            expect(upgraded, state).toBe(state === "absent database");
            expect(stores, state).toEqual(state === "empty store" ? ["node"] : []);
        }
    });

    it("advertises the v3 direct asset capability as JSON", async () => {
        const sw = worker();
        const response = await sw.respond(new Request(`${origin}/sw/init`));
        expect(response.ok).toBe(true);
        expect(response.headers.get("content-type")).toMatch(/^application\/json\b/);
        expect(await response.json()).toEqual({ version: "v3", directAssets: true });
        expect(sw.fetch).not.toHaveBeenCalled();
    });
});
