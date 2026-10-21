import { promisify } from "node:util";
import zlib from "node:zlib";
import type { Context } from "hono";

/**
 * JSON answers compressed for the client: the resource reads, whose boot read reaches tens of MB
 * on asset-heavy modules. zstd level 1 when the request accepts it, else gzip level 1, both on
 * the zlib thread pool so a large body does not block the event loop. Streams, the event socket
 * and the proxies never go through here.
 */

/** JSON text shorter than this in UTF-8 bytes is sent as is: compressing it saves little. */
export const COMPRESS_MIN_BYTES = 32 * 1024;

export type ResponseEncoding = "zstd" | "gzip";

const zstdCompress = promisify(zlib.zstdCompress);
const gzipCompress = promisify(zlib.gzip);
const zstdOptions = { params: { [zlib.constants.ZSTD_c_compressionLevel]: 1 } };
const gzipOptions = { level: 1 };

/**
 * The coding for an `Accept-Encoding` header: `zstd` when accepted and not ranked below `gzip`, else
 * `gzip` when accepted, else null (identity). A coding's quality is its own entry's, else `*`'s, else
 * 0; `q=0` refuses one, and the first entry of a coding named twice wins. With neither coding
 * acceptable the answer is identity even when `identity;q=0` refuses it: RFC 9110 §12.1 lets a
 * server disregard the field instead of answering 406.
 */
export function pickEncoding(header: string | undefined): ResponseEncoding | null {
    if (!header) {
        return null;
    }
    const quality = new Map<string, number>();
    for (const entry of header.split(",")) {
        const [name, ...params] = entry.split(";").map((part) => part.trim());
        const coding = name.toLowerCase();
        if (coding === "" || quality.has(coding)) {
            continue;
        }
        let q = 1;
        for (const param of params) {
            const match = /^q\s*=\s*(\S+)$/i.exec(param);
            if (match) {
                const value = Number(match[1]);
                q = Number.isFinite(value) ? value : 0;
            }
        }
        quality.set(coding, q);
    }
    const wildcard = quality.get("*") ?? 0;
    const zstd = quality.get("zstd") ?? wildcard;
    const gzip = quality.get("gzip") ?? wildcard;
    if (zstd > 0 && zstd >= gzip) {
        return "zstd";
    }
    return gzip > 0 ? "gzip" : null;
}

/**
 * `c.json(value)` (status 200, `application/json`), compressed per the request's `Accept-Encoding`
 * when the text reaches `COMPRESS_MIN_BYTES`. Always adds `Vary: Accept-Encoding`; headers other
 * middleware sets after the handler (`Cache-Control`, rate limits, `Connection`) are kept.
 */
export async function compressedJson(c: Context, value: unknown): Promise<Response> {
    c.header("Vary", "Accept-Encoding", { append: true });
    const text = JSON.stringify(value);
    // UTF-8 never takes fewer bytes than UTF-16 code units, so only a short text needs counting.
    const large = text.length >= COMPRESS_MIN_BYTES || Buffer.byteLength(text) >= COMPRESS_MIN_BYTES;
    const encoding = large ? pickEncoding(c.req.header("accept-encoding")) : null;
    if (encoding === null) {
        return c.body(text, 200, { "Content-Type": "application/json" });
    }
    const input = Buffer.from(text);
    const output =
        encoding === "zstd" ? await zstdCompress(input, zstdOptions) : await gzipCompress(input, gzipOptions);
    return c.body(new Uint8Array(output.buffer, output.byteOffset, output.byteLength), 200, {
        "Content-Type": "application/json",
        "Content-Encoding": encoding,
        "Content-Length": String(output.byteLength),
    });
}
