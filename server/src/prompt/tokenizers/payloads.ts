import fs from "node:fs/promises";
import path from "node:path";

/**
 * The tokenizer payloads are the client's `public/token/` files. `pnpm runserver` reads them there;
 * the image has no `public/`, only the copy Vite makes in `dist/token/`. Both are relative to the
 * server's `rootDir` (the `cwd` rule of `main.ts`).
 */
export const TOKEN_PAYLOAD_DIRS = ["public/token", "dist/token"] as const;

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
