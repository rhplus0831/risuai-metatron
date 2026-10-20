// Writes `database-v8.risudat` the way upstream RisuAI's `encodeRisuSaveLegacy(db, "compression")`
// does (src/ts/storage/risuSave.ts), with upstream's library versions and its msgpackr entry:
//   node make-database-v8.mjs <msgpackr 1.10.1 package dir> <fflate 0.8.2 package dir> <output file>
// `Date.now` is fixed during the encode so the gzip header's mtime, and so the file, is reproducible.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { UPSTREAM_FIXTURE_DATABASE } from "./database.ts";

const FIXTURE_MTIME_MS = Date.UTC(2026, 9, 20);

const [msgpackrDir, fflateDir, output] = process.argv.slice(2);
const { Packr } = createRequire(import.meta.url)(path.resolve(msgpackrDir, "dist/index-no-eval.cjs"));
const fflate = await import(pathToFileURL(path.resolve(fflateDir, "esm/index.mjs")).href);

const packr = new Packr({ useRecords: false });
const magicCompressedHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8]);

const realNow = Date.now;
Date.now = () => FIXTURE_MTIME_MS;
let encoded = packr.encode(UPSTREAM_FIXTURE_DATABASE);
encoded = fflate.compressSync(encoded);
Date.now = realNow;
const result = new Uint8Array(encoded.length + magicCompressedHeader.length);
result.set(magicCompressedHeader, 0);
result.set(encoded, magicCompressedHeader.length);
writeFileSync(output, result);
console.log(`${output}: ${result.length} bytes`);
