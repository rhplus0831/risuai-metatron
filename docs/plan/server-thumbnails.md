# Server Thumbnails Plan

Status: drafted 2026-10-23 at `28e7fda88` and imported into `docs/plan/` on 2026-10-23 at `832caccf0`, after the Per-Chat Send plan was archived. No slice landed. It overlaps the Direct Asset URLs plan (see Order). Source: Haejeok survey candidate B1
(`docs/research/haejeok-feature-survey.md` §2 (b) and §3 item 3; HaejeokRisuai code at
`/home/codex/HaejeokRisuai`, read-only reference). Locations were mapped by a Luna fan-out
(8 workers) against `28e7fda88`; the `getCharImage`, `sw.js` registration, chat avatar, and
sharp claims were re-read by the session. Line numbers are approximate; the identifiers are
the anchors. Re-verify each cited location before editing.

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
42–80 px icon. `getCharImage` (`src/ts/characters.ts` ~83–107) calls `getFileSrc(loc)`, and
`getFileSrc` (`src/ts/globalApi.svelte.ts` ~107–252) serves the stored bytes unchanged: a
`/sw/img/<hex>` Cache Storage entry when the service worker is ready, else a `blob:` URL. The
server has no resized form (`rg -il "thumbnail|sharp" server/src` is empty).

Card images are usually 1024×1536 or larger. A browser keeps the decoded bitmap of every image
it shows, at the source's size, not the box's (PNG has no reduced-size decode): 1024×1536 RGBA
is 6 MiB, and 100 catalog rows hold about 600 MiB. The same image at 256 px on its short side
(256×384) is 384 KiB, 16 times less. This is the largest remaining decoded-image cost on phones,
where the tab is killed first. The JS-heap work (heap memory plan, boot cache) did not touch it,
and the existing drivers do not measure it (`measureHeap.mjs` measures the JS heap;
`measureFileSources.mjs` measures Blob and object-URL bytes).

Surfaces (CSS px at `iconsize` 100 and a 16 px root):

- **Lists, 42–80 px:** `GridCatalog.svelte` (~125–215, `BarIcon` 56) and
  `MobileCharacters.svelte` (~52–67, 56). `Sidebar.svelte` has character and folder rows
  (~687–711) and member rows (~933–943), all `SidebarAvatar` 56. `PinnedChatsRail.svelte`
  (~62–82, 42). `MainMenu.svelte` home cards (~84–120, ~170–192, 44) call `getCharImage`
  directly, without `LazyCharImage`. The `PersonaSettings.svelte` persona list (~112–140, 80).
  The `CharConfig.svelte` group member icons (~423–439, 56). The `AlertComp.svelte`
  `selectChar` list (~418–450, 56).
- **Larger previews, 96–170 px:** the `PersonaSettings.svelte` active persona (~186–196,
  112×112, or 112×171 with `largePortrait`). The `CharConfig.svelte` character and group image
  (~532–608, 96×96 or 96×171).
- **Chat avatars:** `Chats.svelte` (~385) resolves each row's portrait with
  `getCharImage(nextImageSource, "css")`. `Chat.svelte`'s `senderIcon` (~1621–1666) is
  `iconsize × 0.56` px square (28–112 px for the slider's 50–200), and taller with
  `largePortrait`. The `cardboard` theme (~1857) draws it at up to 288×384. The greeting
  (`DefaultChatScreen.svelte` ~1249–1260) and `BookmarkList.svelte` (~219–246) go through
  the same `Chat` component.

`getCharImage`'s `css` and `lgcss` forms are `background-size: cover` with the default
`background-position` (top left). A resize that keeps the aspect ratio therefore draws the same
crop as the original. A server-side crop (Haejeok crops `fit: "cover", position: "top"` to
128×128 and 512×768) would not.

## Approach

The server makes a reduced WebP of an image asset on first request, caches it on disk next to
the save data, and serves it from a new authenticated route. The tab asks for it through a
thumbnail variant of `getFileSrc` and falls back to the original on any refusal. List and
avatar surfaces pass a size class. Everything else keeps the original: editors, the emotion
table, asset previews, exports, inlays, and the parser's `{{asset}}` output.

- **Encoder.** `sharp` 0.34.5 is already installed (a dependency of
  `@huggingface/transformers`, `pnpm-lock.yaml` ~2763). Its prebuilt `@img/sharp-linux-x64`
  binary loads without the install script, which `pnpm.neverBuiltDependencies` keeps off
  (`package.json` ~125). Checked by the session: a 1024×1536 PNG resized to 256×384 WebP in
  17 ms. The server imports it as a direct production dependency at the same version (Docker
  installs `--prod`, `self-host-server.md` ~346–351). It is loaded lazily, once. If the load
  fails, the route answers 501 and the tab stops asking.
- **Sizes.** Two classes by short side: `256` for lists, `512` for the larger previews and chat
  avatars. `resize({ width: n, height: n, fit: "outside", withoutEnlargement: true })` keeps the
  aspect ratio, so the client's crop is unchanged. Output is WebP quality 80 with alpha kept.
  EXIF orientation is applied (`rotate()`), as the browser does for the original.
- **When the original is served instead.** The route answers `204` with
  `x-risu-thumbnail: original`, and the tab uses the original's `getFileSrc` entry (one cached
  copy, not two), when:
  - the source's short side is at most the size;
  - the source is animated (`metadata().pages > 1`);
  - the source is not a decodable image (sniffed by sharp, not by the key's extension, since
    keys default to `.png` whatever the bytes are, `globalApi.svelte.ts` ~273–304);
  - the source exceeds the input caps (bytes, `limitInputPixels`).

  A missing asset is `404`.

- **Cache.** The cache lives in `save/cache/thumbnails/`, a sibling of `save/models/`. It is
  outside `save/assets`, so `/api/list`, full v2 exports (`listAssetKeys`,
  `backups.ts` ~433–451, top-level canonical files only), and the upstream export never see it.
  Snapshots hold only SQLite data, so a restore leaves the cache in place (`snapshots.ts`
  ~51–56).
  - Entry name: `<sha256(asset key)>-<size>-<source size>-<source mtimeNs>.webp`, or `.orig` (an
    empty marker for "serve the original", so an animated GIF is not decoded on every request).
  - Keying by the source's stat, not only the asset key, handles same-key overwrites
    (`/api/write` and `/api/assets/write` rename over the target; `saveAsset` with a `customId`
    reuses a key, `storage.ts` ~389–541). A hit costs one `stat`, with no read or hash of the
    source.
  - A miss removes that key and size's older entries.
  - `/api/remove` removes the key's entries.
  - A background sweep after listen removes entries whose source is gone or changed.
  - Cache writes are staged and renamed like `writeStorageFile` (`storage.ts` ~141–202). They do
    not enter the maintenance gate: the cache is derived, and a restore never rewrites an
    existing asset (`restoreValidated`, `backups.ts` ~396–430).
- **Load bounds.** Concurrent requests for one entry share one generation (single flight).
  Generation runs at most 2 at a time, with `sharp.concurrency(1)`. The wait queue is bounded,
  and a request over it is `503`, which the tab answers with the original, not a retry. Input
  caps: 32 MiB and 40 MP; above either, the original is served.
- **Client.** `getThumbSrc(loc, size)` in `globalApi.svelte.ts` mirrors `getFileSrc`: shared
  `FileSource` per `thumb:<size>:<loc>`, pinned, with the same service-worker path and blob
  fallback. The service-worker URL is `/sw/img/t<size>-<hex>`, which `/sw/img/*` already
  covers (`shared/diagnostics.ts` ~318). Rules:
  - `204 original` resolves to `getFileSrc(loc)`.
  - `501` sets a session flag that sends every later call straight to `getFileSrc`.
  - Any other failure (network, `503`, a decode error) resolves to `getFileSrc(loc)` for that
    call.

  `sw.js` `registerCache` (~99–121) stores every entry as `image/png`. It takes the type from
  the registration request instead, defaulting to `image/png`, so a WebP entry is labeled
  `image/webp`. The blob fallback uses the response's type.

- **API for components.** `getCharImage(loc, type, thumb?: 256 | 512)` and a `thumb` prop on
  `LazyCharImage` pass the size through. `hideAllImages` and the empty-path rules are
  unchanged.

## Order

1 → 2 → (3, 4) → 5.

- Slice 1 is the server: the route, the cache, and the dependency.
- Slice 2 is the client source, `getCharImage`/`LazyCharImage`, and `sw.js`. It needs the route.
- Slices 3 and 4 move surfaces to thumbnails and share no file: 3 is the lists and the two
  settings previews, 4 is the chat avatar path. They run in parallel.
- Slice 5 is measurement, the browser check, and the docs close.
- Coordination: the Direct Asset URLs plan (`direct-asset-urls.md`) retires asset entries in `risuCache` (its slice 6) and lists thumbnails as a later `?w=` variant of its asset route. Slice 2 here builds on `/sw/img/t<size>-<hex>` and `risuCache`. Decide which plan runs first before slice 2; if Direct Asset URLs lands first, rebase slices 1–2 onto its route.

## Slice 1. Thumbnail route and cache (_hard_, `self-host-server.md`)

- `package.json`: add `sharp` `0.34.5` to `dependencies`, the version the lockfile already
  resolves. Keep `neverBuiltDependencies`.
- `server/src/assets/thumbnails.ts` (new): `createThumbnailService({ savePath, assetsPath })`.
  - `get(key, size)` returns `{ kind: "webp", path } | { kind: "original" } | { kind: "missing" }`
    or throws `ThumbnailsUnavailable` / `ThumbnailBusy`.
  - `removeKey(key)` and `sweep(signal)` maintain the cache.
  - It implements the lazy `sharp` import, the entry naming, single flight, the 2-slot
    generation limiter with a bounded queue, the input caps, and the staged write.
  - Path resolution reuses `storage.ts`'s key decoding and resolution, so the route accepts
    exactly the keys `/api/read` accepts.
- `server/src/routes/storage.ts` `registerStorageRoutes` (~242): `GET /api/assets/thumb`, after
  the storage limiter and `auth.checkAuth`, as `/api/read` does (~272–319).
  - Request: the key in the `file-path` header (hex UTF-8, as `/api/read`), and
    `?size=256|512`; any other size is `400`.
  - Answers: `200 image/webp` with `Content-Length`; `204` with `x-risu-thumbnail: original`;
    `404`; `501 thumbnailsUnavailable`; `503 thumbnailBusy`.
  - `/api/remove` (~321–357) calls `removeKey` for each removed key after its `fs.rm`.
- `server/src/app.ts`:
  - create the service in `createServerContext`;
  - start `sweep` after listen, unref'd, and stop it on close;
  - add the cache directory beside the models path (~301–322).
- `shared/diagnostics.ts` `ROUTE_TEMPLATES` (~258): add `/api/assets/thumb`.
- `self-host-server.md`: route table (~152–185), storage paths, the cache's place outside
  snapshots and archives, and the Known Hazards for the input caps and the `.orig` marker.
- Test: `server/src/tests/thumbnails.test.ts`, with images built by sharp in the test. It
  covers:
  - JWT refusal before any file access;
  - a 1024×1536 PNG gives a 256×384 WebP;
  - a 200×300 PNG, an animated GIF, and non-image bytes give `204 original` (and the `.orig`
    marker, read back without decoding: spy on the sharp loader);
  - a same-key overwrite gives a new entry and removes the old one;
  - `/api/remove` drops the entries;
  - two concurrent requests generate once (a deferred-gated fake encoder, no timing);
  - a full queue is `503`;
  - an unavailable loader is `501`;
  - a bad size is `400`;
  - `sweep` removes stale and orphaned entries;
  - the cache file is absent from a full v2 export (extend `backups.test.ts` ~417–450).

  The `diagnostics.test.ts` route-table check (~1218–1232) covers the template.

- Check: `docker build` and one thumbnail request in the container (`node:24-slim`, `--prod`
  install), on a fresh volume as the production-server checks in `build-test-platforms.md`
  (~82) run.

## Slice 2. Client thumbnail source (_hard_, `global-api.md`)

- `src/ts/storage/assetClient.ts`: `readThumbnail(key, size)` through `requestWithRetry`
  (~109–140). It returns `{ bytes, type } | "original" | "unavailable" | null`. A `503` is
  not retried here: it is an answer, not a transient.
- `src/ts/globalApi.svelte.ts`:
  - `getThumbSrc(loc, size)`, sharing `getFileSource`'s map under `thumb:<size>:<loc>` with the
    same pinning;
  - the service-worker path `/sw/img/t<size>-<hex>` (the page `risuCache` lookup, then
    `/sw/check`, then `/sw/register` with the content type);
  - the fallbacks from the Approach;
  - the blob fallback typed from the response.
- `public/sw.js` `registerCache`: content type from the registration request's
  `x-risu-content-type` header, default `image/png`. The share path's `noContentType` is
  unchanged.
- `src/ts/characters.ts` `getCharImage`: optional `thumb`. `src/lib/UI/GUI/LazyCharImage.svelte`:
  `thumb` prop, passed through.
- `global-api.md` (~24–33) and `build-test-platforms.md` service-worker section (~98–123).
- Test:
  - `src/ts/globalApiThumbnails.test.ts`: a shared load per key and size; the service-worker
    and blob paths; `original` resolving to the same URL as `getFileSrc`; `501` turning later
    calls into `getFileSrc` without a request; `503` and a network error falling back for that
    call only; the blob typed `image/webp`.
  - `LazyCharImage.test.ts`: the prop reaches `getCharImage`.
  - Extend `e2e/storedFileSrc.spec.ts` (~112–224): a stored 1024×1536 PNG through
    `getThumbSrc` decodes at `naturalWidth` 256 in both the worker and no-worker modes.

## Slice 3. Lists and settings previews (_small_, `ui-theming.md`)

- `thumb={256}`:
  - `GridCatalog.svelte`;
  - `MobileCharacters.svelte`;
  - `Sidebar.svelte` (characters, folders, members);
  - `PinnedChatsRail.svelte`;
  - `MainMenu.svelte` (both direct `getCharImage` calls);
  - `PersonaSettings.svelte` list;
  - `CharConfig.svelte` member icons (~423–439);
  - `AlertComp.svelte` `selectChar`.
- `thumb={512}`: the `PersonaSettings.svelte` active persona (~186–196) and the
  `CharConfig.svelte` character and group image (~532–608).
- `ui-theming.md` (~76–81): which surfaces use which class, and that editors, the emotion
  table, and asset previews keep originals.
- Test: update the mocks' expected calls in `MobileCharacters.test.ts` (~82–122) and
  `PinnedChatsRail.status.test.ts`. Add one `GridCatalog` mount that asserts the 256 class
  reaches `getCharImage`. `e2e/readersCharacters.spec.ts` and `e2e/personaBinding.spec.ts`
  must still pass (`--e2e`).

## Slice 4. Chat avatars (_small_, `ui-theming.md`)

- `Chats.svelte` (~385): `getCharImage(nextImageSource, "css", avatarThumb)`, where
  `avatarThumb` is `512`, or `undefined` (the original) when `settings.ui.theme` is
  `cardboard`. A theme change re-resolves the portrait: add the theme to the row's image-source
  comparison so a cached `sent.img` is not reused across it.
- `DefaultChatScreen.svelte` greeting (~1249–1260) and `BookmarkList.svelte` (~219–246): the
  same rule.
- Out of scope: `Chat.svelte`'s export-as-image path (~1187–1208) reads `getFileSrc` for the
  full icon and stays that way.
- Test: a `Chats.svelte` row test that the avatar asks for 512, and for the original under
  `cardboard`, and re-resolves on a theme change. `pnpm --silent test:agent --e2e` for the chat
  screen specs.

## Slice 5. Measurement, browser check, docs close (_small_, `build-test-platforms.md`)

- `util/playwright/measureFileSources.mjs`: a `thumb` step. Seed 100 avatars at 1024×1536
  (today 20 at 400×400, ~205–333). Open the catalog, scroll every row into view, and report:
  - the sum of `naturalWidth × naturalHeight × 4` over the decoded `<img>` and background
    images;
  - the bytes read through `/api/read` and `/api/assets/thumb`;
  - the request count.

  Run it before and after (with `getThumbSrc` forced to the original).

- Browser check (headless Chrome, then the user's phone if available):
  - catalog, sidebar, home, persona list, and a chat at `iconsize` 50/100/200 and under
    `cardboard`;
  - an animated GIF avatar stays animated;
  - a transparent PNG keeps its alpha;
  - the crop matches the original's;
  - the no-worker fallback.
- `build-test-platforms.md` driver row (~82) and the measured numbers in the plan's archive
  entry.
- Test: none beyond the driver run (a measurement, not a gate).

## Decisions

The runner takes each default unless the user overrides it.

- D1. Encoder. Options: (a) native `sharp` as a direct dependency, lazily loaded, with
  `501` when it cannot load; (b) `wasm-vips` or `@img/sharp-wasm32` everywhere (portable to
  Termux, several times slower, no native binary). Default (a): Docker and Linux/Windows/macOS
  hosts have prebuilt binaries, and Termux hosting is not supported today
  (`docs/research/README.md` Haejeok item 6).
- D2. Sizes and fit. Options: (a) short side 256 and 512, `fit: "outside"`, no crop; (b)
  Haejeok's cropped 128×128 and 512×768. Default (a): the client's `cover` crop stays as it
  is, and 256 covers an 80 px box at 3× density.
- D3. Format. Options: (a) WebP quality 80; (b) AVIF (smaller, slower to encode); (c) JPEG
  (no alpha). Default (a).
- D4. Animated sources. Options: (a) serve the original; (b) an animated WebP thumbnail
  (`animated: true`, with a frame cap). Default (a): animated avatars keep moving, and the
  decoded-memory win is given up only for them.
- D5. Cache bound. Options: (a) no byte cap, the stat-keyed names plus the background sweep
  (entries are about 5–40 KB, made only for images some surface showed); (b) a byte cap from
  `RISU_THUMBNAIL_CACHE_MB` with oldest-first eviction. Default (a).
- D6. User setting. Options: (a) none, on wherever the server can make thumbnails; (b) a
  Display toggle. Default (a). `hideAllImages` is unchanged either way.
- D7. Batching. Options: (a) one request per image, as today's `/api/read`; (b) a batch route
  like Haejeok's `ThumbnailBatchLoader` (48 keys per request). Default (a): `LazyCharImage`
  already limits requests to rows near the viewport, and the storage limiter (2000 per minute)
  is shared with today's reads.
- D8. Locales. No user-visible string is expected (failures fall back silently). If one is
  added, `en.ts` only.

## Open Questions

- Termux or Android hosting would need D1 (b). Decide it together with Haejeok E3, not here.
- The 64 px asset previews (`AssetInput.svelte`, `CharConfig.svelte` ~899–920,
  `ModuleMenu.svelte` ~406–427) and the emotion table go through `LazyFileSrc`/`holdFileSrc`,
  not `getCharImage`. A held thumbnail variant would extend the win to large asset lists. Left
  for a follow-up once slice 5's numbers are in.
- The service worker's `risuCache` entries never expire by content: a `customId` key whose
  bytes change keeps showing the old image until the entry ages out. This holds today for
  originals and will hold the same way for thumbnails; the server side is correct.
- Realm hub images (`RealmHubIcon.svelte`, `RealmPopUp.svelte`) load from the hub's own URLs
  and are not covered.
- Devices above 3× density at `iconsize` 200 get a 512 image for a 112 px box (336 needed at
  3×, 448 at 4×). That is acceptable unless the browser check shows blur.
