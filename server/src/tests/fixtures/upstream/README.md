# Upstream RisuAI save fixtures

Used by `server/src/tests/upstreamRisuSave.test.ts`.

## `database.ts`

Hand-written, synthetic input: a small upstream-shaped flat `Database` (a character with a chat, a
group, a preset, a persona) with `undefined` fields, integers past 32 bits, and non-ASCII text.
Every value is made up for the test. It holds no user data and no real API key, and it was not taken
from any backup.

## `database-v8.risudat`

A frozen capture of `database.ts` encoded as upstream RisuAI writes `database.risudat` in a `.bin`
backup: `encodeRisuSaveLegacy(db, "compression")` in upstream's `src/ts/storage/risuSave.ts` at
upstream commit `669b12ce` (MessagePack with `Packr({ useRecords: false })`, then
`fflate.compressSync`, then the `\0RISUSAVE\0\x08` header). `make-database-v8.mjs` is the script that
wrote it, with upstream's locked library versions and upstream's msgpackr entry
(`msgpackr/index-no-eval`):

```bash
node server/src/tests/fixtures/upstream/make-database-v8.mjs <msgpackr@1.10.1 package dir> <fflate@0.8.2 package dir> server/src/tests/fixtures/upstream/database-v8.risudat
```

The packages came from a local pnpm install of another checkout (unpatched msgpackr). The script fixes
`Date.now` to 2026-10-20T00:00:00Z while encoding, so the gzip header's mtime, and so the file, is
reproducible; the test sets the same time to compare `encodeUpstreamDatabase`'s output byte for byte.
Captured 2026-10-20 (SHA-256 `3a2afdfdbaedda101e34ba025a32c2d63b55b1133c0f9ff521be23f562f26097`).

The file is upstream's behavior, not metatron's. Do not regenerate it with metatron's encoder. A
change to `database.ts` needs a new capture with the script above, in the same commit.
