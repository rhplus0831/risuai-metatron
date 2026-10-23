# Server Thumbnails Plan

Status: drafted 2026-10-23 at `28e7fda88` and imported into `docs/plan/` on 2026-10-23 at
`832caccf0`, after the Per-Chat Send plan was archived. Re-planned by Combined Run slice ST0
on 2026-10-23 at `4ef877f64`, over the landed Direct Asset URLs route (DA1–DA6): slices 1 and
2 now build a `?w=` variant of `/api/asset/<hex>`; no slice landed. Source: Haejeok survey
candidate B1 (`docs/research/haejeok-feature-survey.md` §2 (b) and §3 item 3; HaejeokRisuai
code at `/home/codex/HaejeokRisuai`, read-only reference). Locations were originally mapped
by a Luna fan-out (8 workers) against `28e7fda88`. The route, verification, worker, client,
and guide anchors below were re-read against the landed code. Identifiers are the anchors;
line numbers are approximate. Re-verify each cited location before editing.

One slice is one session, one commit, one file cluster. Each slice names its guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Workflow per slice:
`opus-lite` for a slice marked _small_, `opus-workflow` for one marked _hard_. Each slice
ends with its tests (under "Test"), `pnpm check`, `pnpm format:check`,
`pnpm --silent test:agent` (`--e2e` where it touches a screen an `e2e/` spec covers) and
the owning guide's focused checks, and updates the owning guide where it changes a
documented contract. Code comments and test titles describe behavior, not this plan
(`STRUCTURE.md` T5).

## Problem

Every list that shows a character, group, or persona decodes the full stored image to draw a
42–80 px icon. `getCharImage` (`src/ts/characters.ts` ~83) calls `getFileSrc(loc)`.
`getFileSrc` (`src/ts/globalApi.svelte.ts` ~133) serves the stored bytes unchanged in two
modes: a direct `/api/asset/<hex>` URL when `canUseDirectAssets()` sees a capable worker
controlling the page; otherwise the fallback `loadFileSrc` returns `/sw/img/<hex>` or a
`blob:` URL. The direct route (`storage.ts` `app.get("/api/asset/*", ...)` ~410) has no
resized form.

Card images are usually 1024×1536 or larger. A browser keeps the decoded bitmap of every image
it shows, at the source's size, not the box's (PNG has no reduced-size decode): 1024×1536 RGBA
is 6 MiB, and 100 catalog rows hold about 600 MiB. The same image at 256 px on its short side
(256×384) is 384 KiB, 16 times less. This is the largest remaining decoded-image cost on phones,
where the tab is killed first. The JS-heap work (heap memory plan, boot cache) did not touch it,
and the existing drivers do not measure it (`measureHeap.mjs` measures the JS heap;
`measureFileSources.mjs` measures Blob and object-URL bytes).

Surfaces (CSS px at `iconsize` 100 and a 16 px root):

- **Lists, 42–80 px:** `GridCatalog.svelte` (`LazyCharImage`, `BarIcon` 56) and
  `MobileCharacters.svelte` (`LazyCharImage`, 56). `Sidebar.svelte` has character, folder,
  and member rows (`LazyCharImage`, `SidebarAvatar` 56). `PinnedChatsRail.svelte`
  (`LazyCharImage`, 42). `MainMenu.svelte` home cards (`getCharImage` for
  `item.characterImage` and `item.image`, 44) load directly, without `LazyCharImage`.
  The `PersonaSettings.svelte` persona list (`LazyCharImage`, 80). The `CharConfig.svelte`
  group member icons (`getCharImage(findCharacterbyId(char).image, "css")`, 56).
  The `AlertComp.svelte` `selectChar` list (`getCharImage(char.image, "css")`, 56).
- **Larger previews, 96–170 px:** the `PersonaSettings.svelte` active persona
  (`getCharImage(activePersona.icon, ...)`, 112×112, or 112×171 with `largePortrait`).
  The `CharConfig.svelte` character and group image (`getCharImage(currentCharacter.image, ...)`
  and `getCharImage(assets.uri, ...)`, 96×96 or 96×171).
- **Chat avatars:** `Chats.svelte` resolves each row's portrait with
  `getCharImage(nextImageSource, "css")` (~386). `Chat.svelte`'s `senderIcon` (~1622) is
  `iconsize × 0.56` px square (28–112 px for the slider's 50–200), and taller with
  `largePortrait`. The `cardboard` theme branch (~1858) draws it at up to 288×384. The greeting
  (`DefaultChatScreen.svelte` `getCharImage(currentCharacter.image, "css")`, ~1283) and
  `BookmarkList.svelte` (`getCharImage` for the speaker, user, or character) go through the
  same `Chat` component.

`getCharImage`'s `css` and `lgcss` forms are `background-size: cover` with the default
`background-position` (top left). A resize that keeps the aspect ratio therefore draws the same
crop as the original. A server-side crop (Haejeok crops `fit: "cover", position: "top"` to
128×128 and 512×768) would not.

## Approach

The server makes a reduced WebP of an image asset on first request, caches it on disk next to
the save data, and serves it as a `?w=256|512` variant of `GET`/`HEAD /api/asset/<hex>`.
`getThumbSrc` returns that URL in direct mode; the browser loads it through the worker.
Otherwise it returns `getFileSrc`'s original. List and avatar surfaces pass a size class.
Everything else keeps the original: editors, the emotion table, asset previews, exports,
inlays, and the parser's `{{asset}}` output.

- **Route and auth.** Extend the existing handler in `server/src/routes/storage.ts`
  (`app.get("/api/asset/*", ...)`, ~410), with the same storage limiter, `auth.checkAuth`
  before any file access, and `assetHeaders` (~306). Without `w`, behavior is unchanged.
  Exactly one `w`, whose value is exactly `256` or `512`, selects the variant; an empty,
  repeated, or other value is `400`, `no-store`. `w` names the short-side class, not the
  output width. The key stays in the path: `decodeKeyHeader` of the hex suffix from
  `c.req.path`, then `resolveStorageKey`. There is no new route or key header.
  - The worker already authenticates it (DA3). The fetch gate in `public/sw.js` checks
    `url.pathname.startsWith('/api/asset/')` (~13). `fetchSignedAsset` (~182) refetches
    `request.url`, preserving the query, with the default redirect mode `follow`.
  - `fetchFileSrc` and `withFileSrcFetch` already sign these URLs for rich copy and
    screenshots. Their `directAssetFetchUrl` test reads only `url.pathname`
    (`globalApi.svelte.ts` ~174); it returns the full URL with the query.
  - Diagnostics need no change: `shared/diagnostics.ts` `ROUTE_TEMPLATES` already has
    `/api/asset/*` (~292), and `apiRouteTemplate(pathname)` never receives the query.
    The existing `server/src/tests/diagnostics.test.ts` route-table check stays as it is.
- **Source identity.** The route opens and stats the source once, then passes
  `source: { handle, stat }` to the service. Validation, metadata, animation checks, and
  generation all describe that handle's bytes; the service never reopens the source by
  path. The route keeps the handle open until the service settles and closes it on every
  response path. An atomic overwrite after the stat cannot mix the new source's thumbnail
  with the old source's validator. Keep the landed handler's one-handle invariant
  (`storage.ts`, the comment before `handle.stat`, ~440).
- **Encoder.** `sharp` 0.34.5 is already installed (a dependency of
  `@huggingface/transformers`, `pnpm-lock.yaml`'s `@huggingface/transformers` snapshot).
  Its prebuilt `@img/sharp-linux-x64` binary loads without the install script, which
  `pnpm.neverBuiltDependencies` keeps off
  (`package.json` ~126). The drafting session measured a 1024×1536 PNG resized to 256×384
  WebP in 17 ms. The server imports it as a direct production dependency at the same version
  (Docker installs `--prod`, `self-host-server.md` Docker flow). It is loaded lazily, once.
  If the load fails, the variant redirects to the original with
  `x-risu-thumbnail: unavailable` and `no-store`.
- **Sizes.** Two classes by short side: `256` for lists, `512` for the larger previews and chat
  avatars. `resize({ width: n, height: n, fit: "outside", withoutEnlargement: true })` keeps the
  aspect ratio, so the client's crop is unchanged. Output is WebP quality 80 with alpha kept.
  EXIF orientation is applied (`rotate()`), as the browser does for the original.
- **Transform version.** The server constant `THUMBNAIL_VERSION` covers sizes, fit, quality,
  format, animation policy, caps, and encoder behavior. Every cache entry name, single-flight
  key, and both forms of WebP variant tag include it. Bump it when any of those change,
  including a sharp upgrade that changes output. The sweep drops entries of other versions.
  A version bump also needs a client URL change, such as an added `v` parameter sent by
  `getThumbSrc`, to reach browsers holding an immutable copy. Until then they keep theirs.
  A changed URL alone cannot invalidate the disk cache; the constant must change too.
- **When the original is served instead.** The variant answers `307 Temporary Redirect`
  with relative `Location: /api/asset/<hex>` (the same asset, no query) and
  `x-risu-thumbnail: original` when:
  - the source's short side is at most the size;
  - the source is animated: `metadata().pages > 1` (GIF and animated WebP), or a PNG has
    an `acTL` chunk before its first `IDAT` (APNG), checked from the open source's bytes;
  - sharp's metadata/format check positively identifies unsupported or non-image input,
    rather than the key's extension (`assetKey` defaults to `.png` whatever the bytes are,
    `globalApi.svelte.ts` ~379);
  - the source exceeds the input caps (bytes, `limitInputPixels`).

  Only these deterministic outcomes write an `.orig` marker. Other failures, including
  I/O, memory, and encoder errors, take the `error` redirect with `no-store`, a server log
  line, and no marker. Do not treat an arbitrary sharp rejection as non-image input.
  sharp 0.34.5 can report a two-frame APNG without `pages`, so the PNG chunk check is
  required. Other animated formats reported as one page remain a Known Hazard: they
  become still thumbnails.

  The `original` redirect has the variant's Cache-Control but no ETag, and ignores
  preconditions. A browser image load follows it without tab-side status handling.
  The worker's same-origin signed fetch keeps `risu-auth` across the redirect: Fetch strips
  only `Authorization`, and only across origins. The HTTP cache holds the original bytes
  under the original URL, with no second
  copy under the variant URL. D10 records this runner default and the alternatives.

  An unavailable loader, a full generation queue, or an unexpected service error also
  redirects to that original URL, with `x-risu-thumbnail: unavailable`, `busy`, or `error`
  respectively. These redirects are `no-store`; the unexpected error also gets a server
  log line. The handler's image-load errors are `400`, `401`, and `404` (missing source),
  all `no-store`; thumbnail service failures never become `5xx`. The unchanged shared
  storage limiter can still answer `429` (`createRateLimiter`).

- **HTTP caching and validators.** Reuse DA2's source verification through `contentNameHash`
  and `assetVerification.lookupVerification` (`server/src/http/assetVerification.ts`). Only
  a content name verified against the current source handle stat is immutable. Unknown
  content names stay unverified for this response and queue verification as today.
  - A verified source gives `Cache-Control: private, max-age=31536000, immutable`.
    A WebP answer uses `ETag: "sha256-<hex>-w<size>-v<version>"`, where `<hex>` is the
    source's content hash and `<version>` is `THUMBNAIL_VERSION`.
  - Any other source gives `private, no-cache`. A WebP answer uses the weak variant tag
    `W/"<source size>-<mtimeNs>-<ino>-<dev>-w<size>-v<version>"`. Only WebP `200`/`206`/`304`
    responses carry a variant tag. Neither tag can equal the original's tag, another
    size class's tag, or another transform version's tag.
  - Keep `matchesAssetEtag`'s weak comparison for concrete strong/weak forms, lists, and
    whitespace. A verified WebP source also accepts its current weak variant tag; a
    matching strong variant tag takes precedence. A `304` carries the matched tag and
    current cache policy, so a weak-tagged WebP copy can upgrade to immutable.
  - Only an exact concrete variant-tag match for this source identity and transform
    version can shortcut to `304` after auth/stat/verification, without a sharp load
    or generation. A client can hold that tag only from a WebP answer; its outcome is
    fixed for those bytes, size, and version. Transient outcomes are `no-store` and
    have no tag. A lone `If-None-Match: *` and non-matching tags go through the service.
  - RFC 9110 §13.2.1 requires ignoring preconditions when the unconditional response is
    not `2xx`. An `original` outcome is always `307`, with no ETag, even for `*`; a
    cached `original` redirect is never answered `304`. A verified redirect is immutable;
    an unverified one is `private, no-cache`, so each load re-asks the server (one source
    stat and an `.orig` marker lookup, no decode). Other redirects ignore preconditions too.
    Once the service identifies a WebP outcome, apply remaining preconditions, including
    `*`, before Range and file serving.
  - Errors use `no-store`. A `?w=` variant and its cached redirect inherit DA2's accepted
    hazard: an immutable HTTP-cache copy can answer an unsigned same-origin `fetch` without
    reaching authentication (`self-host-server.md` Known Hazards, ~669; owner accepted
    2026-10-23).
  - A verified variant is immutable for a year. Output changes require both a
    `THUMBNAIL_VERSION` bump for disk entries/tags and a URL change for browser copies,
    as described above.
- **File serving.** Factor the existing asset file-serving path so originals and cache
  files share it: one handle supplies size and bytes, a single `Range` gives `206`/`416`,
  and `HEAD` has no body (but may generate a thumbnail). Keep the current ignored-range
  rules and full-length HEAD behavior. A thumbnail byte response is `image/webp` and
  `Content-Disposition: inline`, regardless of the source extension; original responses
  keep `shared/assetMime.ts`'s MIME and active-type rules. `assetHeaders` applies to every
  variant response, including redirects, `304`, and errors.

- **Cache.** The cache lives in `save/cache/thumbnails/`, under `save/cache/` beside
  `save/models/`. It is outside `save/assets`, so `/api/list`, full v2 exports (`listAssetKeys`,
  `server/src/routes/backups.ts` ~454, top-level canonical files only), and the upstream export
  never see it. Snapshots hold only SQLite data, so a restore leaves the cache in place
  (`server/src/data/snapshots.ts` `createSnapshotManager`).
  - Entry name: `<sha256(asset key)>-w<size>-v<version>-<source size>-<mtimeNs>-<ino>-<dev>.webp`,
    or `.orig` (an empty marker for a deterministic "serve the original" decision).
    `<version>` is `THUMBNAIL_VERSION`; the full source identity is size, nanosecond mtime,
    inode, and device, as DA2's `sameFile` compares (`assetVerification.ts` ~16).
    The single-flight key uses the same asset key, size class, version, and full identity
    from the route's supplied stat. Cache lookup and generation never restat or reopen
    the source path.
  - Keying by the full source identity and transform version handles same-key overwrites
    (`/api/write` and `/api/assets/write` rename over the target; `saveAsset` with a `customId`
    reuses a key through `assetKey`), including same-size, same-mtime replacements with
    a different inode or device. A hit costs the route's one source `stat`, with no decode,
    read, or hash of the source by the thumbnail service; DA2 verification stays separate.
  - Only the deterministic outcomes listed above write `.orig`. I/O, memory, and encoder
    errors, busy, and unavailable outcomes write no marker.
  - A miss removes that key and size's older entries.
  - `/api/remove` removes the key's entries.
  - A background sweep after listen removes entries whose source is gone or whose full
    identity changed, and entries with a different `THUMBNAIL_VERSION`.
  - Cache writes are staged and renamed like `writeStorageFile` (`storage.ts` ~190). They do
    not enter the maintenance gate: the cache is derived, and a restore never rewrites an
    existing asset (`restoreValidated`, `backups.ts` ~399).
- **Load bounds.** Concurrent requests for one entry share one generation (single flight).
  Generation runs at most 2 at a time, with `sharp.concurrency(1)`. The wait queue is bounded,
  and a request over it redirects to the original with `x-risu-thumbnail: busy`, `no-store`.
  Input caps: 32 MiB and 40 MP; above either, the original is served.
- **Client.** `getThumbSrc(loc, size: 256 | 512): Promise<string>` in
  `src/ts/globalApi.svelte.ts`:
  - In direct mode (`canUseDirectAssets()`, ~166), resolve
    `/api/asset/<hex>?w=<size>` at once, built from `directAssetSrc` (~170). An empty `loc`
    resolves `""`. No read, registration, shared `FileSource`, or pin.
  - Otherwise return `getFileSrc(loc)` itself: the full image, the same promise, shared
    load, and pin as a plain read. No extra source map or thumbnail byte fetch. Server
    redirects handle direct-mode fallbacks; the fallback mode never requests a thumbnail.
  - Pages without a worker, uncontrolled pages, and first loads using the fallback get no
    decoded-memory win. The owner accepted this trade-off on 2026-10-23.
- **API for components.** `getCharImage(loc, type, thumb?: 256 | 512)` and a `thumb` prop on
  `LazyCharImage` pass the size through. `getCharImage` uses `getThumbSrc` when `thumb` is
  set. `hideAllImages` and the empty-path rules are unchanged.

## Order

1 → 2 → (3, 4) → 5.

- Slice 1 is the server: the asset variant, the cache, and the dependency.
- Slice 2 is the client source and `getCharImage`/`LazyCharImage`. It needs the variant.
- Slices 3 and 4 move surfaces to thumbnails and run in parallel with no shared file,
  guides included: 3 owns the lists, two settings previews, and their `ui-theming.md`
  update; 4 owns the chat avatar code/tests and edits no guide. Slice 2 documents the
  `LazyCharImage` prop before either begins.
- Slice 5 is measurement, the browser check, and the docs close, including the chat-avatar
  rule in `ui-theming.md` after both surface slices finish.
- Slices 1–2 build on Direct Asset URLs DA1–DA4 (landed). DA6 retired the worker's asset
  cache entries. Nothing here adds one (D9).

## Slice 1. Thumbnail variant and cache (_hard_, `self-host-server.md`)

- `package.json` and `pnpm-lock.yaml`: add `sharp` `0.34.5` to production `dependencies`
  and the lockfile's importers section. Keep `sharp` in `pnpm.neverBuiltDependencies`
  (already present).
- `server/src/http/assetThumbnails.ts` (new), beside `assetVerification.ts` and
  `contentAsset.ts`: `createThumbnailService({ savePath, assetsPath })`.
  - `get({ key, size, source: { handle, stat } })` returns
    `{ kind: "webp", path } | { kind: "original" } | { kind: "missing" }`
    or throws `ThumbnailsUnavailable` / `ThumbnailBusy`. The source handle and its bigint
    stat come from the route's single open/stat; metadata, PNG chunk checks, and encoding
    read only that handle's bytes. The service never reopens the source path. The route
    owns the handle and closes it after the service settles.
  - `removeKey(key)` and `sweep(signal)` maintain the cache.
  - Define `THUMBNAIL_VERSION` for sizes, fit, quality, format, animation policy, caps,
    and encoder. Entry names and single-flight keys use the key, size class, version,
    and the supplied stat's size, mtimeNs, ino, and dev. `sweep` compares that same full
    identity and removes other versions. Implement the lazy `sharp` import, the 2-slot
    generation limiter with a bounded queue, the input caps, and the staged write.
  - Detect animation with `metadata().pages > 1`, plus a PNG `acTL` chunk before the first
    `IDAT`, read from the supplied source bytes. The latter covers APNG even when sharp
    omits `pages`.
  - Write `.orig` only for small sources, detected animation, input caps, or a positive
    unsupported/non-image classification from sharp's metadata/format check. Other I/O,
    memory, or encoder failures propagate to the route's `error` redirect with no marker.
  - The route retains path decoding, `resolveStorageKey`, source verification, and the
    no-symlink, regular-file rules. Maintenance resolves keys for removal and sweeping;
    it must not reopen a source for a request's generation.
- `server/src/routes/storage.ts` `registerStorageRoutes` (~331): extend the same
  `app.get("/api/asset/*", ...)` handler for `GET`/`HEAD` with exactly one `w=256|512`.
  - Preserve `assetHeaders`, the storage limiter, and `auth.checkAuth` before any file
    access. Decode the hex suffix from `c.req.path` with `decodeKeyHeader`, then
    `resolveStorageKey`. Without `w`, keep the original's behavior.
  - Reject invalid, empty, or repeated `w` with `400`, `no-store`.
  - Open and stat the source once. Use that stat for DA2 verification, versioned variant
    validators, and `get({ key, size, source: { handle, stat } })`. Keep the handle alive
    through the service call; close it on every response path.
  - Shortcut to `304` before the service only for an exact concrete variant-tag match.
    A lone `*` and non-matching tags call the service. Once it identifies WebP, evaluate
    remaining preconditions before Range. Keep the WebP strong/weak matching and
    weak-to-immutable `304` upgrade from the Approach. Only WebP answers carry the tags.
  - Factor file serving for the original and WebP cache file: one handle for size and
    bytes, `Content-Length`, single Range with `206`/`416`, HEAD without a body (HEAD may
    generate). A thumbnail is `image/webp`, inline, with the same security headers.
  - Map `original` to the cacheable `307` with a relative, query-free original `Location`
    and `x-risu-thumbnail: original`, without an ETag or precondition evaluation.
    Use immutable caching for a verified source and `private, no-cache` otherwise.
    Map `missing` to `404`, `no-store`, as the original route does.
    Map `ThumbnailsUnavailable` and `ThumbnailBusy` to the same redirect with
    `unavailable` or `busy`, `no-store`. An unexpected service error redirects with
    `error`, `no-store`, and a server log line. No thumbnail service failure answers `5xx`.
  - The `/api/remove` handler calls `removeKey` for each removed key after its `fs.rm`,
    alongside the existing `assetVerification.forgetVerification` cleanup.
- `server/src/app.ts`:
  - create the service in `createServerContext` (~144) and pass it into
    `registerStorageRoutes` (~785);
  - start the background `sweep` after listen through `startBackgroundTasks`, unref'd,
    and abort/stop it on close through `beginShutdown`/`dispose`;
  - add `save/cache/thumbnails/` beside the `save/models/` cache setup (`createTransformers`,
    ~332).
- `docs/structure/self-host-server.md`: update the existing `/api/asset/*` route table row,
  the variant's headers/caching, storage paths, and the cache's place outside snapshots and
  archives. Known Hazards: input caps; `.orig` is only for deterministic outcomes;
  animated formats other than APNG that sharp reports as one page become still thumbnails.
  The transform-change rule covers sizes, fit, quality, format, animation policy, caps,
  and encoder: bump `THUMBNAIL_VERSION` to invalidate disk entries and tags, and change
  the client URL too (for example an added `v` parameter) to reach immutable browser
  copies; until then those browsers keep theirs. State that the `?w=` variant and
  its cached redirect inherit the already accepted immutable HTTP-cache hazard, nothing
  more (owner decision 2026-10-23).
- Test: `server/src/tests/assetThumbnails.test.ts` (new), with images built by sharp in the
  test, against `/api/asset/<hex>?w=256`. It covers:
  - JWT refusal (`401`, `no-store`) before any file access;
  - a 1024×1536 PNG gives a 256×384 WebP (`image/webp`, inline, the security headers);
  - a 200×300 PNG, an animated GIF, an animated WebP, a two-frame APNG without sharp
    `pages`, and positively identified non-image bytes give the `307` original redirect
    with the relative, query-free `Location`, `x-risu-thumbnail: original`, and no ETag
    (and the `.orig` marker, read back without decoding: spy on the sharp loader);
  - a replace between the route's stat and generation cannot return a thumbnail of the
    new bytes under the old validator, including a verified old source (deferred-gated,
    no timing; the same invariant as `assetRoute.test.ts`'s atomic-replace read case);
  - a same-key overwrite gives a new entry and removes the old one, including a same-size,
    same-mtime replace with a different inode; the cache identity also includes device;
  - `/api/remove` drops the entries;
  - two concurrent requests generate once (a deferred-gated fake encoder, no timing);
  - a full queue gives the busy redirect with `no-store`;
  - an unavailable loader gives the unavailable redirect with `no-store`;
  - I/O, memory, and encoder errors give the error redirect with `no-store`, a log line,
    and no `.orig` marker;
  - invalid, empty, and repeated `w` give `400`, `no-store`; a missing source gives `404`;
  - a verified WebP gives immutable caching and `"sha256-<hex>-w256-v<version>"`; an
    unverified WebP gives `no-cache` and the full-stat weak `-w256-v<version>` tag;
  - an exact variant-tag match gives `304` without a sharp load or encoder call, including
    the weak-to-immutable WebP upgrade; tags never match the original's or another version's;
  - `If-None-Match: *` on a small PNG gives `307`; a cached `original` redirect is never
    answered `304` and has no ETag (immutable when verified, `private, no-cache` otherwise);
  - Range/416 and HEAD use the thumbnail file's size and bytes; HEAD has no body;
  - a version bump bypasses both old `.webp` and `.orig` entries; `sweep` removes stale,
    orphaned, and other-version entries using the full stat identity;
  - the cache file is absent from a full v2 export (extend
    `server/src/tests/backups.test.ts`'s `POST /api/backups/export` full-export case).

- Check: `docker build` and one `/api/asset/<hex>?w=256` request in the container
  (`node:24-slim`, `--prod` install), on a fresh volume as the production-server checks in
  `build-test-platforms.md` run.

## Slice 2. Client thumbnail source (_hard_, `global-api.md`)

- `src/ts/globalApi.svelte.ts`:
  - `getThumbSrc(loc, size: 256 | 512): Promise<string>` uses `canUseDirectAssets()`;
  - in direct mode, resolve `directAssetSrc(loc) + "?w=" + size` at once for a nonempty
    `loc`, or `""` for an empty one; no read, registration, shared source, or pin;
  - otherwise return `getFileSrc(loc)` itself, preserving its promise, shared load, and
    plain-read pin. Keep the function non-`async` so this is the same promise;
  - no separate map, session disable flag, or per-call fallback. The server redirects
    direct image loads; fallback mode always asks for the original.
- `src/ts/characters.ts` `getCharImage(loc, type, thumb?: 256 | 512)`: use `getThumbSrc`
  when `thumb` is set; the existing call without it, `hideAllImages`, and empty-path
  handling stay unchanged.
- `src/lib/UI/GUI/LazyCharImage.svelte`: optional `thumb` prop, passed to `getCharImage`.
- `src/lib/UI/tests/LazyCharImageFixture.svelte`: accept and forward `thumb` so the mounted
  test can verify the prop.
- `docs/structure/global-api.md` Storage and assets (`getFileSrc`, `holdFileSrc`, ~27–30):
  document `getThumbSrc`'s two modes and the accepted lack of a decoded-memory win in the
  fallback.
- `docs/structure/ui-theming.md` `LazyCharImage` bullet: document the optional `thumb` prop
  and forwarding to `getCharImage`, with direct-mode URLs and fallback-mode pinning.
  The surface-class inventory belongs to slices 3 and 5.
- Slice 2 does not edit `public/sw.js`: the pathname gate and `fetchSignedAsset` already
  preserve the query and follow the redirect. It does not edit
  `src/ts/storage/assetClient.ts`: the client never reads thumbnail bytes. It does not edit
  `build-test-platforms.md`: there is no new worker path or registration contract.
- Test:
  - `src/ts/globalApiThumbnails.test.ts` (new): direct mode resolves
    `/api/asset/<hex>?w=256` with no `readAsset`, worker request, or pin; empty `loc` gives
    `""`. Without a controller or the capability, it returns what `getFileSrc` returns
    for the path (the same promise, one shared load, not two). `getCharImage` with `thumb`
    uses the variant; without it behavior is unchanged, as is `hideAllImages`.
  - `src/lib/UI/GUI/LazyCharImage.test.ts`: make the `getCharImage` mock forward the third
    argument, and mount the updated `LazyCharImageFixture.svelte` to assert that `thumb`
    reaches `getCharImage`.
  - Extend `e2e/storedFileSrc.spec.ts` (the controlled-page direct-asset case and the
    no-worker case): in worker mode, a stored 1024×1536 PNG through `getThumbSrc` decodes
    at `naturalWidth` 256 from `/api/asset/<hex>?w=256`; a stored 200×300 PNG through
    `?w=256` displays at `naturalWidth` 200 through the redirect. In no-worker mode,
    `getThumbSrc` resolves to `getFileSrc`'s URL and decodes at `naturalWidth` 1024.

## Slice 3. Lists and settings previews (_small_, `ui-theming.md`)

- `thumb={256}`:
  - `GridCatalog.svelte`;
  - `MobileCharacters.svelte`;
  - `Sidebar.svelte` (characters, folders, members);
  - `PinnedChatsRail.svelte`;
  - `MainMenu.svelte` (both direct `getCharImage` calls);
  - `PersonaSettings.svelte` list;
  - `CharConfig.svelte` member icons (`getCharImage(findCharacterbyId(char).image, "css")`);
  - `AlertComp.svelte` `selectChar`.
- `thumb={512}`: the `PersonaSettings.svelte` active persona (`activePersona.icon`) and the
  `CharConfig.svelte` character and group image (`currentCharacter.image`, `assets.uri`).
- `ui-theming.md` `LazyCharImage`: which surfaces use which class, and that editors, the
  emotion table, and asset previews keep originals. In fallback mode these surfaces also
  get the original through `getFileSrc`.
- Test: update the expected `getCharImage` calls in `MobileCharacters.test.ts`.
  In `PinnedChatsRail.status.test.ts`, whose mock is permissive and has no expected calls
  today, add an assertion that the 256 class reaches `getCharImage`.
  Add one `GridCatalog` mount that asserts the 256 class reaches `getCharImage`.
  `e2e/readersCharacters.spec.ts` and `e2e/personaBinding.spec.ts`
  must still pass (`--e2e`).

## Slice 4. Chat avatars (_small_, `ui-theming.md`)

- `Chats.svelte` `getCharImage(nextImageSource, "css")` (~386): pass `avatarThumb`, where
  `avatarThumb` is `512`, or `undefined` (the original) when `settings.ui.theme` is
  `cardboard`. A theme change re-resolves the portrait: add the theme to the row's image-source
  comparison so a cached `sent.img` is not reused across it.
- `DefaultChatScreen.svelte` greeting (`getCharImage(currentCharacter.image, "css")`) and
  `BookmarkList.svelte` (`getCharImage` for the speaker, user, or character): the same rule.
  In fallback mode all of these get the original through `getFileSrc`.
- Out of scope: `Chat.svelte`'s export-as-image icon path (`getFileSrc`, `fetchFileSrc`)
  reads the full icon and stays that way.
- No `ui-theming.md` edit here, so slice 4 shares no file with slice 3. Slice 5 documents
  the chat-avatar class and theme rule after both finish.
- Test: a `Chats.svelte` row test that the avatar asks for 512, and for the original under
  `cardboard`, and re-resolves on a theme change. `pnpm --silent test:agent --e2e` for the chat
  screen specs.

## Slice 5. Measurement, browser check, docs close (_small_, `build-test-platforms.md`)

- `util/playwright/measureFileSources.mjs`: a `thumb` step. Seed 100 avatars at 1024×1536
  (today `AVATARS = 20`, `AVATAR_SIDE = 400`, in `seed`). Open the catalog, scroll every row
  into view, and report:
  - the sum of `naturalWidth × naturalHeight × 4` over the decoded `<img>` and background
    images;
  - the bytes read through `/api/read` and `/api/asset/*`, split into originals and `?w=`
    variants;
  - the request count and redirect count.

  Run it in worker (direct) mode, before and after. Force `getThumbSrc` to the original
  for the baseline. Observe the worker's requests too, as the direct-asset case in
  `e2e/storedFileSrc.spec.ts` does.

- Browser check (headless Chrome, then the user's phone if available):
  - catalog, sidebar, home, persona list, and a chat at `iconsize` 50/100/200 and under
    `cardboard`;
  - the redirect path: an animated GIF and a two-frame APNG through `?w=256` stay animated,
    and a small PNG through `?w=256` displays at its original dimensions;
  - a transparent PNG keeps its alpha;
  - the crop matches the original's;
  - a worker update while a list is open;
  - the no-worker fallback shows originals;
  - Safari, if a device is available: a redirected image load through the worker.
- `build-test-platforms.md` driver row for `measureFileSources.mjs` and the measured numbers
  in the plan's archive entry.
- `docs/structure/ui-theming.md`: document the chat-avatar rule: 512, the original under
  `cardboard`, and the theme included in the row's image-source comparison so a theme
  change re-resolves the portrait. Include the greeting and bookmark avatars and the
  fallback-mode originals.
- Test: none beyond the driver run (a measurement, not a gate).

## Decisions

The runner takes each default unless the user overrides it. D9 is owner-decided; D10 is
the runner's redirect default for browser image loads.

- D1. Encoder. Options: (a) native `sharp` as a direct dependency, lazily loaded, with
  an unavailable redirect with `no-store` when it cannot load; (b) `wasm-vips` or
  `@img/sharp-wasm32` everywhere (portable to Termux, several times slower, no native binary).
  Default (a): Docker and Linux/Windows/macOS
  hosts have prebuilt binaries, and Termux hosting is not supported today
  (`docs/research/README.md` Haejeok item 6).
  A host where sharp cannot load pays one extra uncached redirect request per thumbnail
  image load; the original itself stays cached under its own policy.
- D2. Sizes and fit. Options: (a) short side 256 and 512, `fit: "outside"`, no crop; (b)
  Haejeok's cropped 128×128 and 512×768. Default (a): the client's `cover` crop stays as it
  is, and 256 covers an 80 px box at 3× density.
- D3. Format. Options: (a) WebP quality 80; (b) AVIF (smaller, slower to encode); (c) JPEG
  (no alpha). Default (a).
- D4. Animated sources. Options: (a) serve the original; (b) an animated WebP thumbnail
  (`animated: true`, with a frame cap). Default (a): animated avatars keep moving, and the
  decoded-memory win is given up only for them. Detect `metadata().pages > 1` for GIF and
  animated WebP, plus a PNG `acTL` chunk before the first `IDAT` for APNG, checked from
  the source handle's bytes. sharp 0.34.5 can omit APNG's `pages`. Other animated formats
  reported as one page become still thumbnails; record that Known Hazard in the server guide.
- D5. Cache bound. Options: (a) no byte cap, the stat-keyed names plus the background sweep
  (entries are about 5–40 KB, made only for images some surface showed); (b) a byte cap from
  `RISU_THUMBNAIL_CACHE_MB` with oldest-first eviction. Default (a).
- D6. User setting. Options: (a) none, on wherever the server can make thumbnails; (b) a
  Display toggle. Default (a). `hideAllImages` is unchanged either way.
- D7. Batching. Options: (a) one request per image, as today's `/api/asset/*`; (b) a batch route
  like Haejeok's `ThumbnailBatchLoader` (48 keys per request). Default (a): `LazyCharImage`
  already limits requests to rows near the viewport, and the storage limiter (2000 per minute)
  is shared with today's reads.
- D8. Locales. No user-visible string is expected (failures fall back silently). If one is
  added, `en.ts` only.
- D9. Route, auth, caching, and client. Owner decided on 2026-10-23; re-planned by Combined
  Run slice ST0. A `?w=256|512` variant of `/api/asset/<hex>` uses the landed handler,
  worker authentication, and DA2 caching. WebP validators carry size and transform-version
  suffixes; original redirects carry no ETag. `THUMBNAIL_VERSION` also keys the disk cache, and
  `getThumbSrc` returns the direct URL or `getFileSrc` itself in fallback mode. The owner
  accepts originals and no decoded-memory win in fallback mode, and the inherited
  immutable HTTP-cache hazard. Transform changes require a version bump and a changed URL.
  Replaced design: a separate `GET /api/assets/thumb`, a `file-path` header, and `?size=`,
  served through `/sw/img/t<size>-<hex>` `risuCache` entries with WebP-typed registrations
  (`/sw/register`, `x-risu-content-type`), plus an `assetClient.ts` `readThumbnail` read
  with `thumb:<size>:<loc>` sharing, pinning, a `501` session flag, and a per-call `503`
  fallback. None of that thumbnail cache/read machinery is added.
- D10. Original and transient outcomes. Runner default, not an owner-decided status code.
  Options:
  - (a) `307 Temporary Redirect` to the same asset's `/api/asset/<hex>`, relative `Location`,
    no query. `original` gets `x-risu-thumbnail: original`, no ETag, and DA2 Cache-Control
    (immutable for a verified source, `private, no-cache` otherwise). A redirect ignores
    preconditions, including `If-None-Match: *`; only WebP answers use variant tags and
    can become `304`. An unavailable loader (formerly `501`), a full queue (formerly `503`),
    or an unexpected service error uses the same redirect with `unavailable`, `busy`,
    or `error`, `no-store`; the unexpected error also gets a server log line. The
    service return values and exceptions stay unchanged; only the route mapping changes.
  - (b) Keep `204` and make `public/sw.js` refetch the original on any non-200 `?w=`
    answer. This keeps the old status code but moves fallback into the hand-written
    worker. Neither (a) nor (b) rescues a tab that lost its controller: a cached redirect
    cannot authenticate its target, and an already-issued URL that needs the network
    answers `401` in both, as for original direct URLs. New calls use `getFileSrc`'s fallback.
  - (c) `200` with the original bytes under the variant URL. It avoids the extra request
    and the non-2xx precondition rule, but the HTTP cache holds the same bytes twice
    when a surface also shows the original. Transient `busy`, `unavailable`, and `error`
    outcomes would re-download the full original with `no-store` under this variant URL.

  Default (a). It replaces the earlier draft's `204` answer: direct-mode `<img>` and CSS
  backgrounds load the URL themselves; the tab sees no status code, and an empty answer
  draws a broken image. Transient redirects reuse the original URL's cached bytes instead
  of downloading them again with `no-store`, as (c) would. The existing worker follows
  same-origin redirects with `risu-auth` kept, and the browser caches one copy of the
  original bytes at its original URL. No worker edit is needed.

## Open Questions

- Termux or Android hosting would need D1 (b). Decide it together with Haejeok E3, not here.
- The 64 px asset previews (`AssetInput.svelte`, `CharConfig.svelte`, `ModuleMenu.svelte`)
  and the emotion table go through `LazyFileSrc`/`holdFileSrc`, not `getCharImage`.
  A held thumbnail variant would extend the win to large asset lists. Left
  for a follow-up once slice 5's numbers are in.
- Realm hub images (`RealmHubIcon.svelte`, `RealmPopUp.svelte`) load from the hub's own URLs
  and are not covered.
- Devices above 3× density at `iconsize` 200 get a 512 image for a 112 px box (336 needed at
  3×, 448 at 4×). That is acceptable unless the browser check shows blur.
