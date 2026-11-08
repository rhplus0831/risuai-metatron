import fs from "node:fs/promises";
import path from "node:path";

/**
 * Resolves and reads tokenizer payload paths relative to the configured server root. Paths join the ordered
 * `TOKEN_PAYLOAD_DIRS`; only ENOENT advances to another candidate, while permission and other I/O errors propagate.
 * Reads copy the exact file bytes into an independent ArrayBuffer for the tokenizer loaders.
 */

/**
 * The tokenizer payloads are the server's `server/assets/token/` files, relative to the server's
 * `rootDir` (the `cwd` rule of `main.ts`). `pnpm runserver` and the image, which copies `server/`,
 * both read them there.
 */
export const TOKEN_PAYLOAD_DIRS = ["server/assets/token"] as const;

/** Returns the first accessible payload path, throwing after all candidates are missing or on any other access error. */
export async function resolveTokenizerPayload(rootDir: string, relPath: string): Promise<string> {
    const candidates = TOKEN_PAYLOAD_DIRS.map((dir) => path.join(rootDir, dir, relPath));
    for (const candidate of candidates) {
        try {
            await fs.access(candidate);
            return candidate;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
    }
    throw new Error(`Tokenizer payload ${relPath} not found in ${candidates.join(" or ")}`);
}

/** Reads a payload into an `ArrayBuffer` of its own (a `Buffer` may share a pooled one). */
export async function readTokenizerPayload(rootDir: string, relPath: string): Promise<ArrayBuffer> {
    const bytes = await fs.readFile(await resolveTokenizerPayload(rootDir, relPath));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
