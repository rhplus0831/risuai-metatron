import type { Context } from "hono";
import type { AppEnv } from "../types.ts";

/**
 * JSON body parsing shared by server routes. Only application/json is read; empty or other media
 * types produce an empty object. Objects and arrays are accepted, while primitives, malformed JSON,
 * and failed reads produce a 400 response. Size limits belong to the calling route or
 * server/src/app.ts, rather than this parser.
 */

/** Parsed JSON container or the 400 response to return. */
export type JsonBodyResult = { ok: true; body: Record<string, any> } | { ok: false; response: Response };

/**
 * Reads a JSON body the way Express's global `express.json()` exposed it: a non-JSON content
 * type or a zero-length body yields `{}`; malformed JSON (including whitespace only) or a top-level
 * primitive or a failed body read is a 400.
 */
export async function readJsonBody(c: Context<AppEnv>): Promise<JsonBodyResult> {
    const contentType = (c.req.header("content-type") || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
        return { ok: true, body: {} };
    }
    let text: string;
    try {
        text = await c.req.text();
    } catch {
        return { ok: false, response: c.json({ error: "Invalid JSON body" }, 400) };
    }
    if (text.length === 0) {
        return { ok: true, body: {} };
    }
    const first = text.trimStart()[0];
    if (first !== "{" && first !== "[") {
        return { ok: false, response: c.json({ error: "Invalid JSON body" }, 400) };
    }
    try {
        return { ok: true, body: JSON.parse(text) };
    } catch {
        return { ok: false, response: c.json({ error: "Invalid JSON body" }, 400) };
    }
}
