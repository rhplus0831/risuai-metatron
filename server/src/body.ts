import type { Context } from "hono";
import type { AppEnv } from "./types.ts";

export type JsonBodyResult = { ok: true; body: Record<string, any> } | { ok: false; response: Response };

/**
 * Reads a JSON body the way Express's global `express.json()` exposed it: a non-JSON content
 * type or a zero-length body yields `{}`; malformed JSON (including whitespace only) or a top-level
 * primitive is a 400.
 */
export async function readJsonBody(c: Context<AppEnv>): Promise<JsonBodyResult> {
    const contentType = (c.req.header("content-type") || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
        return { ok: true, body: {} };
    }
    const text = await c.req.text();
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
