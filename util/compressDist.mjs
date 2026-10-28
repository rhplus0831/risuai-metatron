#!/usr/bin/env node
// Write smaller Brotli and gzip siblings for production app files, excluding HTML and source maps.
// Usage: node util/compressDist.mjs [dist-directory]; defaults to the repository's dist/.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { STATIC_COMPRESSIBLE_EXTENSIONS } from "../server/src/http/staticCache.ts";

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const minBytes = 1024;
// Quality 11 above 16 MiB costs tens of seconds of build time for a few percent in size savings.
const maxQuality11Bytes = 16 * 1024 * 1024;
const concurrency = Math.min(4, availableParallelism());
const distPath = path.resolve(process.argv[2] || fileURLToPath(new URL("../dist/", import.meta.url)));

async function collectFiles(directory, files = []) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            await collectFiles(filename, files);
        } else if (entry.isFile() && STATIC_COMPRESSIBLE_EXTENSIONS.has(path.extname(filename).toLowerCase())) {
            files.push({ filename, size: (await fs.stat(filename)).size });
        }
    }
    return files;
}

async function writeSibling(filename, inputSize, output) {
    if (output.length >= inputSize) {
        await fs.rm(filename, { force: true });
        return 0;
    }
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, output, { flag: "wx" });
        await fs.rename(temporary, filename);
    } finally {
        await fs.rm(temporary, { force: true });
    }
    return output.length;
}

async function main() {
    const started = performance.now();
    const files = (await collectFiles(distPath)).sort((a, b) => b.size - a.size).values();
    let count = 0;
    let identityBytes = 0;
    let brBytes = 0;
    let gzBytes = 0;
    await Promise.all(
        Array.from({ length: concurrency }, async () => {
            for (const { filename } of files) {
                const input = await fs.readFile(filename);
                if (input.length < minBytes) {
                    await Promise.all([
                        fs.rm(`${filename}.br`, { force: true }),
                        fs.rm(`${filename}.gz`, { force: true }),
                    ]);
                    continue;
                }
                const [br, gz] = await Promise.all([
                    compressBrotli(input, {
                        params: {
                            [constants.BROTLI_PARAM_QUALITY]: input.length <= maxQuality11Bytes ? 11 : 9,
                            [constants.BROTLI_PARAM_MODE]:
                                path.extname(filename).toLowerCase() === ".wasm"
                                    ? constants.BROTLI_MODE_GENERIC
                                    : constants.BROTLI_MODE_TEXT,
                            [constants.BROTLI_PARAM_SIZE_HINT]: input.length,
                        },
                    }).then((output) => writeSibling(`${filename}.br`, input.length, output)),
                    compressGzip(input, { level: 9 }).then((output) =>
                        writeSibling(`${filename}.gz`, input.length, output),
                    ),
                ]);
                count++;
                identityBytes += input.length;
                brBytes += br;
                gzBytes += gz;
            }
        }),
    );
    console.log(
        `[compress-dist] ${count} files, identity ${identityBytes} bytes, br ${brBytes} bytes, gz ${gzBytes} bytes, ${((performance.now() - started) / 1000).toFixed(2)}s`,
    );
}

main().catch((error) => {
    console.error("[compress-dist]", error);
    process.exitCode = 1;
});
