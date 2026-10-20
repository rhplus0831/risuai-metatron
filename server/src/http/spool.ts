import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Upload bodies spooled to disk and streamed answers, for the routes that take a whole file as the
 * raw body (the backup import, the module import): the body goes to a staging folder under
 * `save/.tmp/` with a byte count, never into memory, and the module import answers NDJSON lines.
 */

/** A unique staging folder `<prefix>-<uuid>` under `tmpPath` (`save/.tmp`, which the storage routes empty at startup). */
export async function makeStaging(tmpPath: string, prefix: string): Promise<string> {
    const dir = path.join(tmpPath, `${prefix}-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

/**
 * Writes the request body to `file`, counting bytes; false past `limit` (the body is cancelled, and
 * the partial file is left for the caller, which removes its staging folder). An aborted `signal`
 * cancels the body and throws its reason.
 */
export async function spool(
    body: ReadableStream<Uint8Array>,
    file: string,
    limit: number,
    signal?: AbortSignal,
): Promise<boolean> {
    const out = await fs.open(file, "wx");
    const reader = body.getReader();
    const onAbort = () => void reader.cancel().catch(() => {});
    let total = 0;
    try {
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
            onAbort();
            signal.throwIfAborted();
        }
        while (true) {
            const { value, done } = await reader.read();
            signal?.throwIfAborted();
            if (done) {
                return true;
            }
            total += value.byteLength;
            if (total > limit) {
                await reader.cancel().catch(() => {});
                return false;
            }
            let written = 0;
            while (written < value.byteLength) {
                written += (await out.write(value, written, value.byteLength - written)).bytesWritten;
            }
        }
    } finally {
        signal?.removeEventListener("abort", onAbort);
        await out.close();
    }
}

/** One NDJSON line: `value` as JSON, then `\n`, in UTF-8. */
export function ndjsonLine(value: unknown): Uint8Array {
    return Buffer.from(`${JSON.stringify(value)}\n`, "utf-8");
}
