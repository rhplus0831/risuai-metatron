import { authFetch } from "./serverAuth";

/**
 * The asset files on the self-host server (Phase 6 slice 10, split out of the old storage client):
 * bytes under a logical key (`assets/<id>.<ext>`), read with `GET /api/read` and written with `POST /api/write`.
 * The key travels hex-encoded (UTF-8) in the `file-path` header; the request is authenticated
 * (`authFetch`). The routes are the server's (`server/src/routes/storage.ts`).
 */

function encodedPath(key: string) {
    return Buffer.from(key, "utf-8").toString("hex");
}

/** Writes `value` under `key`. Throws `"setItem Error"` for a non-2xx answer and the answer's `error` for a refused one. */
export async function writeAsset(key: string, value: Uint8Array): Promise<void> {
    const da = await authFetch("/api/write", {
        method: "POST",
        body: value as any,
        headers: {
            "content-type": "application/octet-stream",
            "file-path": encodedPath(key),
        },
    });
    if (da.status < 200 || da.status >= 300) {
        throw "setItem Error";
    }
    const data = await da.json();
    if (data.error) {
        throw data.error;
    }
}

/** Reads the bytes under `key`: `null` when there are none (a missing or empty file). Throws `"getItem Error"` for a non-2xx answer. */
export async function readAsset(key: string): Promise<Buffer | null> {
    const da = await authFetch("/api/read", {
        method: "GET",
        headers: {
            "file-path": encodedPath(key),
        },
    });
    if (da.status < 200 || da.status >= 300) {
        throw "getItem Error";
    }

    const data = Buffer.from(await da.arrayBuffer());
    if (data.length == 0) {
        return null;
    }
    return data;
}
