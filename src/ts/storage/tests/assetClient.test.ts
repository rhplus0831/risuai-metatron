import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The asset client (`assetClient.ts`, Phase 6 slice 10: the asset half of the removed storage
// client) against a fake of the server's `/api/read` and `/api/write` routes, reached through
// `authFetch` (mocked: the authentication is `serverAuth.test.ts`'s). The wire contract is the old
// one: the key travels hex-encoded in the `file-path` header, a write is an octet-stream `POST`, a
// non-2xx answer throws the old error strings, a 2xx answer carrying `error` throws it, and a
// missing or empty file reads as `null`.

const { calls, answer } = vi.hoisted(() => ({
    calls: [] as { path: string; init: RequestInit }[],
    answer: { current: null as null | ((path: string, init: RequestInit) => Response | Promise<Response>) },
}));

vi.mock("../serverAuth", () => ({
    authFetch: vi.fn(async (path: string, init: RequestInit = {}) => {
        calls.push({ path, init });
        return answer.current!(path, init);
    }),
}));

import { readAsset, writeAsset } from "../assetClient";
import { authFetch } from "../serverAuth";

const KEY = "assets/abc.png";
const HEX = Buffer.from(KEY, "utf-8").toString("hex");
const BYTES = new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3]);

beforeEach(() => {
    calls.length = 0;
    answer.current = null;
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("writeAsset", () => {
    it("posts the bytes as an octet stream under the hex-encoded key and resolves to void", async () => {
        answer.current = () => Response.json({ success: true });
        await expect(writeAsset(KEY, BYTES)).resolves.toBeUndefined();
        expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1);
        const [{ path, init }] = calls;
        expect(path).toBe("/api/write");
        expect(init.method).toBe("POST");
        const headers = new Headers(init.headers);
        expect(headers.get("content-type")).toBe("application/octet-stream");
        expect(headers.get("file-path")).toBe(HEX);
        expect(Buffer.from(headers.get("file-path")!, "hex").toString("utf-8")).toBe(KEY);
        expect(init.body).toBe(BYTES);
    });

    it('throws "setItem Error" for a non-2xx answer, before reading its body', async () => {
        answer.current = () => new Response("nope", { status: 500 });
        await expect(writeAsset(KEY, BYTES)).rejects.toBe("setItem Error");
        answer.current = () => Response.json({ error: "ignored" }, { status: 403 });
        await expect(writeAsset(KEY, BYTES)).rejects.toBe("setItem Error");
    });

    it("throws the answer's `error` for a refused 2xx write", async () => {
        answer.current = () => Response.json({ error: "Invalid path" });
        await expect(writeAsset(KEY, BYTES)).rejects.toBe("Invalid path");
    });
});

describe("readAsset", () => {
    it("gets the bytes under the hex-encoded key as a Buffer", async () => {
        answer.current = () => new Response(BYTES, { status: 200 });
        const data = await readAsset(KEY);
        expect(Buffer.isBuffer(data)).toBe(true);
        expect([...data!]).toEqual([...BYTES]);
        const [{ path, init }] = calls;
        expect(path).toBe("/api/read");
        expect(init.method).toBe("GET");
        expect(new Headers(init.headers).get("file-path")).toBe(HEX);
    });

    it("reads a missing or empty file as null", async () => {
        answer.current = () => new Response(new Uint8Array(0), { status: 200 });
        await expect(readAsset(KEY)).resolves.toBeNull();
        answer.current = () => new Response(null, { status: 204 });
        await expect(readAsset("assets/missing.png")).resolves.toBeNull();
    });

    it('throws "getItem Error" for a non-2xx answer', async () => {
        answer.current = () => new Response("nope", { status: 404 });
        await expect(readAsset(KEY)).rejects.toBe("getItem Error");
        answer.current = () => new Response(BYTES, { status: 500 });
        await expect(readAsset(KEY)).rejects.toBe("getItem Error");
    });
});
