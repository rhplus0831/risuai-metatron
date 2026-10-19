# Boot Resource Cache Plan

Status: planned 2026-10-19 at `91ba3c594`; slice 1 landed (1d382e8d0). Source: a user report that a
remote server holding asset-heavy modules boots slowly, with the boot response saved
from that server (`save/New_Request-1792397488943.json` in the main checkout; ignored
by git, holds user data: read sizes from it, never commit or quote it). Line numbers
are approximate; the identifiers are the anchors. Re-verify each cited location before
editing.

One slice is one session, one commit, one file cluster. Each slice names its guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Workflow per slice:
`opus-lite` for a slice marked _small_, `opus-workflow` for one marked _hard_. Each slice
ends with its tests (under "Test"), `pnpm check`, `pnpm --silent test:agent`
(`--tags-filter=slow` for the storage suites it touches) and the guide's focused checks,
and updates the owning guide where it changes a documented contract.

## Problem

The boot read (`src/ts/bootstrap.ts:loadData` → `readKinds(Object.values(RESOURCE_KIND),
{ chatSummaries: true })` → `GET /api/resources`, `server/src/routes/resources.ts`) sends
every record of every kind in one uncompressed JSON body with `Cache-Control: no-store`.
The server has no HTTP compression anywhere (the 3c slice of
[audit-findings-perf.md](audit-findings-perf.md) deferred it "if a remote deployment
needs it"). Every boot of every tab downloads everything again, changed or not.

The reported server's boot body is 21.83 MB:

| Part                 | Bytes      | Share | Notes                                                               |
| -------------------- | ---------- | ----- | ------------------------------------------------------------------- |
| `modules` (1 record) | 16,241,775 | 74%   | 14 modules, 130,152 asset tuples, all unique; lore/trigger/regex ~0 |
| `characters` (18)    | 4,551,460  | 21%   | `additionalAssets` 1.93 MB, `globalLore` 1.39 MB, scripts 0.58 MB   |
| `presets` (1 record) | 702,380    | 3%    |                                                                     |
| everything else      | ~40,000    | <1%   | 25 small kinds, chat summaries, chat orders                         |

An asset tuple averages ~125 bytes (`[name ~38, "assets/<64 hex>.png" 75, ext 4]`); the
hex hashes are why the body compresses only ~3x. Each module is ~1.2 MB (10,659 or
11,033 assets).

Compression of that body on Node 24.21 (best of 3, synchronous):

| Codec    | Whole body (21.83 MB) | ms  | Without module `assets` (5.61 MB) | ms  |
| -------- | --------------------- | --- | --------------------------------- | --- |
| zstd 1   | 6.76 MB (3.2x)        | 51  | 1.76 MB                           | 14  |
| zstd 3   | 7.03 MB               | 114 | 1.55 MB                           | 25  |
| gzip 1   | 7.67 MB (2.8x)        | 218 | 2.02 MB                           | 52  |
| gzip 6   | 7.30 MB               | 337 | 1.84 MB                           | 97  |
| brotli 4 | 6.55 MB (3.3x)        | 609 | 1.44 MB                           | 83  |

The server already spends ~100 ms on `JSON.parse` of the rows (`readKind`) and ~100 ms
on `c.json`'s stringify for this body.

## Approach

1. Compress resource reads (slice 1): every boot and every chat load gets ~3x smaller.
   It is the only help for a browser's first boot.
2. Cache per record and per module in the browser (slices 2 and 3): a boot sends what it
   already holds; the server answers only what changed. Characters are already one
   record each with their own revision. `modules` is one singleton array record
   (`server/src/data/kinds.ts` `modules`, id `main`), so a revision cannot tell modules
   apart: its items are matched by a content hash instead. `presets` gets the same item
   treatment.

Expected on this data (from the measurements above; not measured end to end):

| Boot                                | Today    | After 1–3                          |
| ----------------------------------- | -------- | ---------------------------------- |
| Nothing changed since the last boot | 21.83 MB | tens of KB                         |
| One module changed                  | 21.83 MB | that module: ~1.2 MB, ~0.4 MB zstd |
| One character changed               | 21.83 MB | that character: ~250 KB average    |
| First boot in this browser          | 21.83 MB | 6.76 MB (compression only)         |

Rejected for now:

- Splitting `modules` into one record per module: a storage migration that touches the
  item patch path (`shared/recordPatch.ts`), the module field stamps
  (`records.svelte.ts` `moduleItemFieldStamp`), the change feed's item diffs and every
  module reader. The content hash gets the same transfer win without it.
- Leaving module `assets` out of the boot read and loading them per enabled module: the
  biggest single cut (5.61 MB raw without them), but `getModuleAssets`, the parser's
  asset index, `checkImg`, the module editor and the item patch writer all assume the
  list is present. Revisit only if slices 1–3 are not enough.
- Hashing sub-ranges of one module's `assets` so an asset rename resends less than its
  module: more protocol for ~1.2 MB per edited module.
- `brotli`: smallest output but 12x zstd 1's time on a 22 MB body; zstd 1 is within 3%.
- Hono's `compress` middleware: gzip/deflate only, through `CompressionStream`.

## Order

1 → 2 → 3 → 4. Slice 1 is independent of 2–3 and can ship alone. Slice 3 needs slice 2's
route. Slice 4 measures and closes the plan.

## Slice 1. Compress resource reads (_small_, `self-host-server.md`)

- A response helper in `server/src/http/` (for example `compressJson(c, body)`), used by
  `GET /api/resources`, `POST /api/resources/read`, `GET /api/resources/:kind[/:id]`, and
  slice 2's boot route. Not middleware over `/api/*`: the event socket, SSE/streamed
  generation responses, `/api/assets/read` (a chunked octet stream) and the proxy
  (`server/src/routes/proxy.ts` strips `content-encoding` on purpose) stay untouched.
- Codec by the request's `Accept-Encoding`: `zstd` (level 1, `zlib.zstdCompress`) when
  listed, else `gzip` (level 1), else none. Chrome and Firefox send `zstd`; Safari does
  not and gets gzip. Parse q-values (`zstd;q=0` refuses). Use the async zlib calls
  (thread pool) so a 22 MB body does not block the event loop for 50–220 ms.
- Only above a threshold (start at 32 KiB of JSON text). Set `Content-Encoding`,
  `Vary: Accept-Encoding`, the compressed `Content-Length`; keep `Cache-Control: no-store`
  (the `noStore` middleware) and the shutdown admission's `Connection: close`.
- Check the dev stack: Vite proxies `/api` to the Hono server (`vite.config.ts`); the
  proxy must pass the encoded body through, not decode it twice.
- Test (`server/src/tests/`, Node): a large read with `accept-encoding: zstd` and with
  `gzip` decodes to the same JSON as an uncompressed read; no `accept-encoding`, a body
  under the threshold, and `zstd;q=0, gzip` pick the right codec; `Vary` is set; an error
  response (400/409) is unchanged.

## Slice 2. Boot read with known revisions and item hashes (_hard_, `self-host-server.md` with `persistence.md`)

A new route, `POST /api/resources/boot`, registered next to `/api/resources/read`
(before `/api/resources/:kind`), same auth and limiter. Body:

```ts
{
    kinds: string[];              // as GET /api/resources
    chatSummaries?: true;         // as GET /api/resources
    known?: {
        records?: { kind: string; id: string; revision: string }[];  // CACHED_KINDS only
        items?: { kind: string; hashes: string[] }[];               // ITEM_KINDS only
    };
}
```

Answer: the `ResourceReadKindsResult` shape (`epoch`, `kinds`, `chatSummaries`,
`chatOrders`), except that a record of a cached kind may be

- `{ id, revision, cached: true }` (no `data`): its revision equals the one in `known`;
- `{ id, revision, items: [{ hash, data? }] }` (no `data`), for an `ITEM_KINDS` record
  whose revision is not known: one entry per array item in stored order; `data` left
  out exactly when `hash` was in `known.items` for that kind.

Rules:

- `CACHED_KINDS = characters, modules, presets` (99% of the bytes) and
  `ITEM_KINDS = modules, presets` live in `shared/resources.ts`. Every other kind is
  always answered whole: kinds with `project` (`llmSecrets`) stay out because a code
  change can change their projection without a revision change.
- A revision token embeds the epoch (`shared/resources.ts` `parseRevisionToken`), so a
  known revision from another epoch never matches; nothing else needs an epoch check.
  The startup normalization pass (`resourceStore.ts` `normalizeStoredRecords`) bumps the
  revision of every record it rewrites, so a schema migration also misses the cache.
- Item hash: SHA-256 of the UTF-8 bytes of `JSON.stringify(item)` for the item as
  `JSON.parse` of the stored record gives it (the wire-canonical item JSON, which is
  also what the client's `JSON.stringify` of the received item gives), base64url, first
  22 characters (132 bits). Never a re-serialization of a projection.
- As built (Sol plan review): no new store method and no hash cache. `readBoot`
  (`server/src/routes/resourceBoot.ts`) calls `readKindRevisions` (cached kinds, no
  parse), `readRefs` (only the stale records), and `readKinds` (the other kinds, with
  the chat summaries) in one synchronous block, which is one committed state. A stale
  item record is parsed, stringified per item and hashed on every read (~0.1–0.2 s on
  a 16 MB record); add a cache keyed by the full revision only if slice 4 shows it
  matters. Eligibility is one predicate (`BOOT_CACHED_KINDS` and no `project`) for both
  the inventory and the answer; other kinds are always whole and projected.
- The answer carries `format: BOOT_RESOURCE_FORMAT` (1).
- `known` limits: kinds, record claims plus item hashes, and item entries at most 5000
  each, counted before entries are dropped; malformed entries are a 400; the body has
  its own 2 MiB cap (413). An entry of an unknown, unrequested or uncached kind, or for
  an absent record, is ignored. A record claimed with two revisions is a miss; hash
  lists of one kind add up. `boot` is a reserved kind name.
- The answer goes through slice 1's compression.
- Test (`server/src/tests/resourcesBoot.test.ts`): no `known` equals
  `GET /api/resources` (same data after expanding `items`); a matching revision answers
  `cached` and the data is absent; a stale revision answers data; a revision of another
  epoch (after `replaceAll`) answers data; a module edit answers only that item's data
  and the other hashes bare; reordering modules answers the new order with bare hashes;
  rebuilding an item record from its items in order equals the full read's data; a record created
  or deleted since is present or absent; non-cached kinds are always whole; limits and
  malformed bodies are 400.

## Slice 3. Client boot cache (_hard_, `persistence.md`)

A new module `src/ts/storage/bootCache.ts` and its use in `bootstrap.ts:loadData`.

- Storage: one IndexedDB database (`risu-boot-cache`) with a `records` store
  (`kind/id` → `{ revision, text }` for characters, `{ revision, hashes }` for item
  kinds) and an `items` store (`kind/hash` → item text), plus a `meta` entry (`format`
  version, `appVer`). Raw `indexedDB` like `src/ts/util.ts`'s DPoP store, not
  `localforage`, so the write and its garbage collection share one transaction. Keep the
  IndexedDB calls behind a small interface so the unit tests run against an in-memory
  implementation (happy-dom has no IndexedDB; `fake-indexeddb` is not a dependency:
  adding it is the slice's call).
- Store texts, not structured clones: `text` is exactly the JSON the server sent (the
  client's `JSON.stringify` of a parsed record reproduces it). Structured clone is not
  safe here: own `__proto__` keys (see the `setChatMeta` snapshot bug fixed in A1 of
  [open-bug-fixes.md](open-bug-fixes.md)).
- Boot: read the whole cache in one read transaction (records and the items they name).
  A record whose items are not all present is dropped from `known`. Send `known` built
  only from what was actually read, and none at all when the request would pass
  `MAX_BOOT_BODY_BYTES` or 5000 entries. Accept an answer only when `format` is
  `BOOT_RESOURCE_FORMAT`; otherwise fall back. A `cached` item-kind record is rebuilt
  from the ordered hash list and item texts of the exact snapshot the request advertised
  (keep that snapshot until the background write is done). An `items` record is rebuilt
  by position (never by module id: ids may repeat or be missing), keeping repeated
  hashes, `items: []` as `[]`, and taking an item's value when `data` is present as a
  property (`null`, `false`, `0`, `""` are values). An item-kind record answered whole
  (its data was not an array) is installed as is and cached as a whole text record.
  Then expand the answer into a plain
  `ResourceReadKindsResult` (`cached` → `JSON.parse(text)`, `items` →
  `JSON.parse("[" + texts.join(",") + "]")`) before `seedResources`; nothing after
  `readKinds` changes. `checkedEpoch` still applies.
- Any cache failure (no IndexedDB, private mode, open/read error, a parse error, a
  missing item named in a `cached` answer, the boot route failing) falls back to today's
  `readKinds` call; one diagnostics event (`recordClientEvent`) per fallback, no alert.
  A bad cache is cleared.
- Write: after the boot is installed, in the background, write exactly what the server
  answered (texts captured before `installBootRecords` wraps the data; reuse the
  `JSON.stringify` texts `seedResources` already computes where possible), never the
  tab's live state, which may hold unsaved edits. One readwrite transaction: put the
  changed records and new items, delete records the answer no longer has, delete items
  no record names. A quota error clears the cache. Two tabs booting together only race
  to write the same content; a tab that loses a GC race only misses next time.
- Invalidation: `meta.format` or `appVer` (`database.svelte.ts`) differs → clear. A new
  epoch needs nothing (old revisions miss on their own; item hashes are content
  addressed and stay valid). Leaving the server (if a sign-out path exists by then)
  clears the cache.
- The live-update path is unchanged: the event feed's first reconcile (`listRevisions`)
  sees the same revisions a full read would have given.
- Privacy note for the guide: the cache keeps the same records the tab holds, in the
  browser profile, after the tab closes; credentials are never in it (`llmSecrets` is
  not a cached kind and is masked anyway).
- Test: the boot through a filled cache produces the same `ResourceReadKindsResult`
  (same record texts) as a full read; one changed module, one changed character, a
  deleted character, a reordered module list; each fallback path ends in a full read
  and installs normally; a record whose item is missing is not sent as known; the write
  stores server texts even when the tab edited a record before the write ran; GC drops
  unnamed items; `appVer` change clears.

## Slice 4. Measure and close (_small_, `build-test-platforms.md`)

- A real-browser check (`util/playwright`, see the Playwright memory notes on dev stacks)
  on a server seeded with data of the reported shape (14 modules × ~11k assets, 18
  characters; synthetic, not the user's file): first boot, a second boot, a boot after
  one module edit; record transferred bytes, time to `loadedStore`, IndexedDB read and
  write time, and check the tab's records match a full read.
- Throttled network (DevTools 10 Mbps) for the remote case; loopback numbers are not the
  target.
- Ask the reporting user to compare DevTools Timing on their server before and after.
- Archive this plan; record leftovers (for example: chats are not cached, the client's
  install cost after the read is unchanged).

## Open Questions

- `presets` in `ITEM_KINDS`: 0.7 MB here; worth it only if its items have stable ids and
  edits touch one preset at a time. Default: include it, drop it in slice 2 if it
  complicates the store read.
- The compression threshold and level: start at 32 KiB / zstd 1 / gzip 1; slice 4 may
  tune them.
