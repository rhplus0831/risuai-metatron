import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createStreamBody } from "@hono/node-server/utils/stream";
import type { Hono, MiddlewareHandler } from "hono";
import type { AuthStore } from "./auth.ts";
import type { AppEnv } from "./types.ts";

const hexRegex = /^[0-9a-fA-F]+$/;

/** Hex file names are the path-traversal guard; never accept raw paths. */
export function isHex(str: string): boolean {
    return hexRegex.test(str.toUpperCase().trim()) || str === "__password";
}

/**
 * `/api/*` storage routes over `save/`. Every file is named by the hex encoding of its logical
 * key, sent in the `file-path` header.
 */
export function registerStorageRoutes(
    app: Hono<AppEnv>,
    arg: { savePath: string; auth: AuthStore; limiter: MiddlewareHandler<AppEnv> },
) {
    const { savePath, auth, limiter } = arg;

    app.get("/api/read", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const filePath = c.req.header("file-path");
        if (!filePath) {
            console.log("no path");
            return c.json({ error: "File path required" }, 400);
        }
        if (!isHex(filePath)) {
            return c.json({ error: "Invaild Path" }, 400);
        }

        const fullPath = path.join(savePath, filePath);
        let size: number;
        try {
            size = (await fs.stat(fullPath)).size;
        } catch {
            // A missing file is an empty 200, which NodeStorage reads as null.
            return c.body(null, 200);
        }
        c.header("Content-Type", "application/octet-stream");
        c.header("Content-Length", String(size));
        if (c.req.method === "HEAD") {
            return c.body(null, 200);
        }
        return c.body(createStreamBody(createReadStream(fullPath)), 200);
    });

    app.get("/api/remove", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const header = c.req.header("file-path");
        if (!header) {
            return c.json({ error: "File path required" }, 400);
        }
        // Batch form: each key hex-encoded on its own, joined with `$$` (not a hex character).
        const filePaths = [...new Set(header.split("$$"))];
        for (const filePath of filePaths) {
            if (!filePath) {
                return c.json({ error: "File path required" }, 400);
            }
            if (!isHex(filePath)) {
                return c.json({ error: "Invaild Path" }, 400);
            }
        }
        // Sequential; a filesystem error (e.g. missing file) stops the batch with a 500 and
        // leaves earlier deletions in place.
        for (const filePath of filePaths) {
            await fs.rm(path.join(savePath, filePath));
        }
        return c.json({ success: true });
    });

    app.get("/api/list", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const data = (await fs.readdir(savePath)).map((v) => Buffer.from(v, "hex").toString("utf-8"));
        return c.json({ success: true, content: data });
    });

    app.post("/api/write", limiter, async (c) => {
        const denied = await auth.checkAuth(c);
        if (denied) {
            return denied;
        }
        const filePath = c.req.header("file-path");
        if (!filePath) {
            return c.json({ error: "File path required" }, 400);
        }
        if (!isHex(filePath)) {
            return c.json({ error: "Invaild Path" }, 400);
        }
        // Raw request bytes, whatever the content type; zero-length writes are allowed.
        const fileContent = new Uint8Array(await c.req.arrayBuffer());
        await fs.writeFile(path.join(savePath, filePath), fileContent);
        return c.json({ success: true });
    });
}
