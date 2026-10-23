// @vitest-environment node

import { webcrypto } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createTestServer, hex, json } from "./testSupport.ts";

const source = readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8");
const origin = "https://installed.example:8443";
const fixedTime = new Date("2026-01-15T12:00:00Z");

beforeEach(() => {
    // The real auth store and the VM use the same clock, independent of machine load.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fixedTime);
});
afterEach(() => vi.useRealTimers());

it("accepts the worker's JWT for private asset bytes and rejects it after expiry", async () => {
    const keyPair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
        "verify",
    ]);
    const publicKey = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
    const indexedDB = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("DPoPDB", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("node");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction("node", "readwrite");
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onabort = tx.onerror = () => {
                db.close();
                reject(tx.error);
            };
            tx.objectStore("node").put({ privateKey: keyPair.privateKey, publicKey: keyPair.publicKey }, "dpop");
        };
    });

    const listeners = new Map<string, (event: unknown) => void>();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response());
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
        Date,
        fetch,
    });
    const url = `/api/asset/${hex("assets/private.png")}`;
    const request = Object.defineProperty(new Request(origin + url), "destination", { value: "image" });
    const respondWith = vi.fn<(response: Response | Promise<Response>) => void>();
    listeners.get("fetch")!({ request, clientId: "page-client", respondWith });
    expect(respondWith).toHaveBeenCalledTimes(1);
    await respondWith.mock.calls[0][0];
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetch.mock.calls[0];
    const token = new Request(input, init).headers.get("risu-auth");
    expect(token).toBeTruthy();

    const s = createTestServer({ password: "pw" });
    onTestFinished(() => s.close());
    // Register the worker's public key with the real auth store; no test signer supplies this JWT.
    const login = await s.app.request("/api/login", json({ password: "pw", publicKey }));
    expect(login.status).toBe(200);
    const bytes = Buffer.from([137, 80, 78, 71, 0, 255, 128]);
    mkdirSync(path.join(s.savePath, "assets"), { recursive: true });
    writeFileSync(path.join(s.savePath, "assets", "private.png"), bytes);

    const authorized = await s.app.request(url, { headers: { "risu-auth": token! } });
    expect(authorized.status).toBe(200);
    expect(Buffer.from(await authorized.arrayBuffer())).toEqual(bytes);

    const unsigned = await s.app.request(url);
    await unsigned.arrayBuffer();
    expect(unsigned.status).toBe(401);

    vi.setSystemTime(fixedTime.getTime() + 301_000);
    const expired = await s.app.request(url, { headers: { "risu-auth": token! } });
    await expired.arrayBuffer();
    expect(expired.status).toBe(401);
});
