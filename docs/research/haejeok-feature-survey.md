# HaejeokRisuai Feature Survey for metatron (2026-10-20)

Read-only survey of `/home/codex/HaejeokRisuai` (branch `main`, tip `dea849c10`,
2026-10-19) to find features, concepts and fixes worth bringing into metatron
(branch `metatron`, tip `44e18f2ae`). No source code was changed. "H" means
Haejeok, "M" means metatron. Commit hashes are in Haejeok's history unless
the text says otherwise.

## 1. How the comparison was done

- Haejeok's `main` was fetched into `FETCH_HEAD` only, with no remote added:
  `git fetch --no-tags /home/codex/HaejeokRisuai main`.
- `git merge-base FETCH_HEAD HEAD` is `22ea4a64b` (2026-08-17, upstream
  "fix: update origin check for message event in UserSettings.svelte"). This is
  the last upstream commit both forks merged.
- Divergence since the merge-base:

  | Side | Commits | Merges | Diff from base | Main areas |
  | ---- | ------- | ------ | -------------- | ---------- |
  | H | 1647 (1581 by nevaeh5379; 0 by kwaroran) | 212 | 1610 files, +380k / −82k | `src/ts/process`, `src/ts/storage` (SQL backends), `packages/` (backup-core, protocol, storage-*, comfyui-workflow, chat-core), `server/node`, `android/`, `src-tauri/` |
  | M | 484 (437 by RH+, 17 upstream) | 18 | 1340 files, +369k / −99k | `server/src`, `shared/`, `src/ts/storage`, settings pages |

- Caveats:
  - H's own work starts on 2026-06-04. It was merged with upstream up to
    `22ea4a64b`. So `22ea4a64b..FETCH_HEAD` is almost all H's own work, plus a
    few hand ports of later upstream changes ("port upstream v2026.8.240
    compatibility changes"). `src/ts/iris.ts`, `src/ts/kei/` and `src/ts/3d/`
    already exist at the merge-base, so they are upstream, not H additions.
  - About 400 of H's commits are Tauri, Capacitor/Android, macOS, Linux CSD,
    Windows Fluent, or SQL/S3 backend plumbing (PostgreSQL, Oracle, Azure SQL,
    sqlite-wasm, RustFS). They are out of scope by M's invariants, and the
    report mentions them only to rule them out.
  - H is converging on M's direction ("offload … transport to Node",
    "durable server-side model jobs", `server/node/executors/`). It still runs
    prompt assembly and parsing in the tab. Many of its fixes, such as the
    roughly 30 "Pin X to generation targets" commits, address problems M avoids
    by design.
  - Research was split into six clusters, each read in both trees. Claims marked
    *verified* were re-checked by hand at M `44e18f2ae`. Others come from the
    cluster reads, and any uncertainty is stated.

Dependencies H added that M lacks, with what they are used for:

| Dependency | Used for | M? |
| ---------- | -------- | -- |
| `es-hangul` | Korean initial-consonant (choseong) and romanized search (`src/ts/util/koreanSearch.ts`) | no |
| `viewerjs` | Lightbox for illustrations | no |
| `@ffmpeg/ffmpeg`, `@ffmpeg/util` | WebM→WebP in the log exporter | no |
| `sharp` (server) | Server-made thumbnails, illustration re-encode | no (only an unbuilt transitive dependency) |
| `@humanspeak/svelte-json-view-lite` | ComfyUI workflow tree viewer | no |
| `valibot` | Normalization defaults and preset schema | M has hand-written `SectionSpec` normalizers |
| `@logtape/logtape` | Console logging in 5 client files | M has a server diagnostics journal |
| `@sqlite.org/sqlite-wasm`, `pg`, `mssql`, `oracledb`, `@aws-sdk/*`, `@capacitor/*`, `appium`, `webdriverio` | Storage backends, Android | not applicable |

M had already removed `@browsermt/bergamot-translator`, `pyodide`, `peerjs`,
`openid-client`, `express-rate-limit` and `acorn`. H keeps them, mostly from
upstream.

## 2. Candidate list

Fit labels: **port as-is**, **port concept** (different implementation),
**N/A** (not applicable), **M ahead** (metatron's version is already further
along). Effort: S / M / L.

### (a) User-facing features

**A1. Persistent in-chat branches and branch graph**
- **What it is:** rerolls, "edit as branch" and manual forks become timelines
  inside one chat, browsed in a git-style graph modal (tree, timeline and radial
  layouts, density modes, pinch zoom). A JSON export mode keeps the branches.
- **In H:** `src/ts/gui/branches.ts`, `src/lib/Others/BranchGraphModal.svelte`,
  `src/ts/chatExport.ts`, `src/ts/storage/sql/portableBranchRestore.ts`.
  - Session branches: `774d6e1db`, `798f27d01`, merged `875e6099f`.
  - Edit as branch: `65586e9cc`, `93b15a898` (PR #31).
  - SQL storage: `405936728`; design notes in `docs/active-branch-storage-plan.md` at that commit.
  - Old `branchState` migrated to a tree: `b8ff7e49f`.
  - Graph modal: PR #87.
- **Data model:** tables `chat_branches`, `chat_active_branches` and
  `chat_message_branch_links`, plus `Chat.activeBranchId`. Script state is
  kept per branch. A reroll only adds a branch and never rewrites history.
- **In M:** upstream's model only. "Branch" copies the whole chat into a new
  chat. `getChatBranches` in `src/ts/gui/branches.ts` rebuilds a graph across
  chats by comparing message text. Reroll history is in memory
  (`src/ts/process/rerollHistory.ts`, 16 chat slots), so it is lost on reload.
  `server/src/data/chatStore.ts` has no parent or active-branch field.
- **Fit:** port concept. It needs a message-tree schema in M's `messages` and
  `chats` tables, chatPatch ops and change-feed events, job locks per branch,
  and prompt assembly, memory and translation that read only the active path.
  This is the most valuable large feature in H.
- **Effort:** L.

**A2. Reroll from any reply**
- **What it is:** a reroll button on every reply, and on a trailing user message.
- **In H:** `src/ts/chatReroll.ts` (`resolveRerollTarget`), `76062ad13`,
  `ddd77bfe8`, `bca1a588f`.
- **In M:** reroll only on the last reply (`Chat.svelte` `rerolls()`).
- **Fit:** port concept. The real version depends on A1. A stopgap is "copy
  the chat up to this turn, then reroll", which needs no schema change.
- **Effort:** S for the stopgap; otherwise part of A1.

**A3. Message search across chats**
- **What it is:** a popup that searches message text in all chats, scoped to
  all, active or archived. A hit opens the chat and scrolls to the message.
- **In H:** `src/lib/Others/MessageSearch.svelte` (`12d6479cc`).
  `searchMessages` in `server/node/storage/postgres/postgresStorage.ts` uses
  `websearch_to_tsquery` and `ts_headline`, so it works on Postgres only.
- **In M:** nothing found (searched `searchMessages`, `messageSearch`,
  `chatSearch`).
- **Fit:** port concept. Use an SQLite FTS5 index or LIKE on M's `node:sqlite`
  `messages` table, a server route, and `scrollToMessage` with the staged
  reveal.
- **Effort:** M.

**A4. Korean-aware fuzzy matching for lists**
- **What it is:** choseong search (typing ㅎㅈ finds 해적) plus
  English↔Hangul keyboard and romanization matching.
- **In H:** `src/ts/util/koreanSearch.ts` (`86ee613c0`, `1e5f9eeed`, uses
  `es-hangul`), used in `MainMenu.svelte`.
- **In M:** plain substring filters (`GridCatalog.svelte`, asset filters).
- **Fit:** port as-is for character, chat, persona and module filters. A3's
  server search can use it later.
- **Effort:** S.

**A5. Recent chats across characters**
- **What it is:** a sidebar list of the most recent chats from all characters,
  with avatar, preview, relative time and search.
- **In H:** `src/lib/SideBars/RecentSessionsList.svelte` (`383dbe395`),
  `src/ts/recentChatActivity.ts`, PR #96. Backed by an SQL `listRecentChats`.
- **In M:** the home screen shows recent *characters* by `lastInteraction`,
  and pinned chats. `ChatSummary` (`shared/chats.ts`) has no per-chat time, and
  `Chat.lastDate` is not maintained.
- **Fit:** port concept. Stamp a per-chat time when a job commits, add it and
  a short preview to the summary projection, and build the list on the
  sidebar rail or the home screen.
- **Effort:** M.

**A6. Chat tabs**
- **What it is:** a strip of open chats with unread and loading markers, a
  draft per tab, drag reorder, a show/hide setting, and up to 2 split panes.
- **In H:** `src/ts/chatTabs.svelte.ts`, `src/lib/ChatScreens/ChatTabs.svelte`.
  `55c9aaa8f`, `43e606494`, PR #66 (`00385a500`), pruning on delete
  `f8a89e2eb`. Depends on per-chat generation tracking from the multitasking
  merge `39c02677f`.
- **In M:** none. The pinned rail, status badges and per-chat drafts cover part
  of the need. A second pane would hit the tab-wide send state: `sendChat` owns
  `doingChat` and `chatGeneratingElsewhere`.
- **Fit:** port concept. The strip alone fits M's id-addressed chatStore well.
  Split panes need per-chat send state in the tab.
- **Effort:** M for the strip; L with panes.

**A7. BTW side threads (`/btw`)**
- **What it is:** a side panel with a separate thread that sees the main
  chat up to the moment it was opened. It can use its own prompt preset,
  modules and toggles, never writes to the main chat, and threads can be
  named, switched and deleted.
- **In H:** `src/lib/ChatScreens/BtwPanel.svelte`,
  `src/ts/process/btwSession.svelte.ts`, `btwRuntime.svelte.ts`, `a91718cce`
  (generation overrides in prompt building), `58f1b4235`, `96bfd02f3`. New
  field `Chat.btwSessions` (`baseMessageCount`, messages, config).
- **In M:** nothing equivalent. `presetChain` only picks a preset per job.
- **Fit:** port concept. Add a server job kind with prompt overrides in
  `assemblePrompt`, and store the side-thread messages outside `chat.message`
  so memory, triggers and translation stay clean.
- **Effort:** M–L.

**A8. Shared author notes**
- **What it is:** named notes that many chats can point to instead of their own
  note, edited in one place, with a draft-recovery banner on conflict.
- **In H:** `src/ts/authorNote.ts`, `src/lib/SideBars/AuthorNoteEditor.svelte`,
  `src/lib/Setting/Pages/GlobalAuthorNoteSettings.svelte`,
  `AuthorNoteDraftRecovery.svelte`, `packages/protocol/src/authorNotes.ts`,
  `2e5259660`. New field `Chat.globalAuthorNoteId`.
- **In M:** per-chat note only (`ChatNoteEditor.svelte`). M's "globalNote" is
  upstream's prompt global note, which is a different thing.
- **Fit:** port concept. Add a shared-note collection; M's revisions replace
  H's content-hash checks. The server's note resolution in prompts and in Lua
  and trigger writes needs to follow the pointer.
- **Effort:** M.

**A9. Illustrations**
- **What it is:** the main prompt asks the model to place
  `<Illustration>` markers. After the reply, an auxiliary model writes image
  tags for each marker and images are generated into per-message slots. A slot
  keeps reroll history with ‹/› navigation, offers retry, regenerate and
  rewrite, makes 1–8 images per marker, opens in a lightbox, and has a width
  setting.
- **In H:**
  - Shared: `packages/protocol/src/illustration{,Runner,Storage}.ts`, `imageGeneration.ts` (one provider table for browser and Node).
  - Server: `server/node/executors/illustration{Executor,Images}.ts`.
  - Client: `src/ts/process/illustration/` (with a README), `src/lib/ChatScreens/IllustrationSlot.svelte`, `IllustrationSettings.svelte`.
  - Commits: `731ddb3e7`, `fd0331a46`, `351d0f59b`, `9e19742a5`, `fa709ebfe`, PR #215.
  - Data: `Message.illustrations[]` holds metadata; the images are stored as inlays.
- **In M:** only the `<ImgGen="…">` inlay screen
  (`server/src/prompt/postProcess.ts`, `src/ts/process/inlayScreen.ts`). The
  job calls back to the tab, which runs `stableDiff.ts:generateAIImage` there.
  There is no server-side image generation and no per-message slots.
- **Fit:** port concept. It first needs image generation moved into `shared/`
  or `server/` (H's shared provider table is a template), a server-side inlay
  writer, and a chatStore op such as `setIllustrations` keyed by message id.
  Progress would use job notices instead of H's polling.
- **Effort:** L.

**A10. ComfyUI saved workflows**
- **What it is:** several named workflows to choose from, import from the
  ComfyUI server's `/userdata`, conversion of UI-format workflows to API
  format, and a lazy JSON tree viewer.
- **In H:** `packages/comfyui-workflow/` (adapted from the MIT-licensed
  ComfyUI_frontend), `src/ts/process/comfyWorkflow.ts`,
  `ComfyWorkflowSettings.svelte`, `1cb6091cd`, `b557356c0`, `5e84bf4e6`,
  `a303890bf`. New fields `comfyConfig.workflows[]` and `selectedWorkflowId`.
- **In M:** one API-format workflow string (`stableDiff.ts`,
  `ImageGenerationSettings.svelte`).
- **Fit:** port as-is, mostly client-side. Add normalizer entries in
  `server/src/data/normalize/memoryTranslateMedia.ts`. It pairs naturally with
  A9 if image generation moves to the server.
- **Effort:** M.

**A11. Themed chat log exporter**
- **What it is:** an export modal with live preview. Formats: HTML, Markdown,
  text, and PNG/JPEG/WebP images. It offers headers and footers, avatar
  options, find-and-replace rules, range export, and WebM→WebP via ffmpeg.wasm.
  Very tall images are stitched without hitting canvas size limits.
- **In H:** `src/ts/logexporter/`, `src/lib/LogExporter/`, `7a7c72224`,
  `05e6019e6`, `904f6b77f`, `704640953`, `076d3da94` (`pngStitch.ts`).
- **In M:** upstream `exportChat` (`src/ts/characters.ts`: JSON, TXT, plain
  HTML). `screenShot()` in `DefaultChatScreen.svelte` draws everything into one
  canvas, so long chats can hit the browser's canvas size limit.
- **Fit:** port concept for the full exporter. Load rows through
  `ensureChatLoaded`, apply the server display transform, and serve the ffmpeg
  core from M's own server rather than unpkg (H loads it from unpkg at
  runtime). `pngStitch.ts` can be ported as-is to fix the screenshot limit.
- **Effort:** L for the exporter; S for `pngStitch`.

**A12. Asset manager with folders and batch editing**
- **What it is:** a floating manager for additional assets with nested
  folders, drag and drop, marquee and Shift/Ctrl selection, batch delete, and
  regex batch rename with sequence tokens (`{n:03}`).
- **In H:** `src/lib/Others/AssetManagerModal.svelte` (about 2k lines),
  `src/ts/assetManagerUtils.ts`, `1cd88e49d`, `35e6f9f05`, `7ff1eb3fd`. New
  fields `additionalAssetFolders[]` and `additionalAssetFolderAssignments`.
  These are removed from exports.
- **In M:** paged tables with name filter and lazy previews in `CharConfig`.
  No folders, multi-select or batch rename.
- **Fit:** port concept. The pure helpers port as-is. The new fields need
  normalizers, must stay out of card exports, and the UI must keep M's
  keyed-row and capture rules.
- **Effort:** M with a lighter UI; L for full parity.

**A13. Stop a generation from another tab or device**
- **What it is:** any client can stop a chat's running job.
- **In H:** `1a872b06b`, `de34819be` (lifecycle and errors shared across
  clients).
- **In M:** *verified*. `ownJob(jobId, clientId)`
  (`server/src/jobs/generationJobs.ts:1195`) requires the job's own
  `clientId` for abort. Other tabs only see `chatGeneratingElsewhere` and the
  locks.
- **Fit:** port concept. M is single-user, so an authenticated
  abort-by-chat route, or dropping the `clientId` match for abort only, is
  enough. Show Stop whenever the chat holds a feed lock. The owning tab
  already learns of the end from its channel's terminal event.
- **Effort:** S–M.

**A14. Upstream RisuAI backup import**
- **What it is:** restore a backup made by upstream RisuAI (`database.risudat`,
  msgpackr with gzip or deflate, with chats stored in cold storage).
- **In H:** `packages/backup-core/src/node/{legacyStream,legacyFormat,importService}.ts`,
  `d50db05f6`, `3def53af2`.
- **In M:** *verified*. `planImport` in `server/src/routes/backups.ts:436`
  refuses archives that contain `database.risudat`. `persistence.md` says no
  migration is planned.
- **Fit:** port concept. Decode on the server, put cold-storage chats back
  inline, run the result through `server/src/data/normalize/` (which already
  holds the old `setDatabase` migrations) and the chat import, and produce a
  `ValidatedSnapshot` for the existing `replaceAll` swap.
- **Effort:** L.

**A15. Per-module auxiliary model and request routing rules**
- **What it is:** a module can name its own auxiliary model, used by its
  trigger, Lua and plugin auxiliary calls. Rules route auxiliary requests
  whose prompt contains given phrases to a module's model. This solves issue
  #61: a shared "backend" module such as Lightboard makes `axLLM` calls for
  several owner modules, and the rules let each owner's calls go to its own
  model.
- **In H:** `src/ts/process/moduleRequestRules.ts`, `moduleRequestCapture.ts`,
  `chatRequestOrchestrator.ts`, `ModuleRequestRules.svelte`, `6d0970ea8`,
  `a264a8ea2`, PR #76, PR #106. New fields `RisuModule.subModel` and
  `subModelRequestRules[]`.
- **In M:** model profiles and slots. `resolveSlotProfile`
  (`shared/llm/modelSlots.ts`) already accepts a per-call `profileId`, but
  only the translator uses it. Lua `axLLM` is wired to the `otherAx` slot
  (`server/src/lua/bindings.ts`). Server triggers carry no module provenance
  (`server/src/jobs/runSetup.ts` `moduleTriggers` copies only
  `lowLevelAccess`).
- **Fit:** port concept. Map module id → profile id as user-local data, not a
  model id exported inside the shareable `.risum`. Attach `sourceModuleId` on
  the server and pass `profileId` through `llmMain` and `v2RunLLM`. The rule
  matcher can live in `shared/`. The capture preview can reuse request
  history.
- **Effort:** M for the per-module model; M–L with rules.

**A16. Module folders and custom order**
- **What it is:** folders (name, colour) and a user-set order for modules,
  with drag and touch moves.
- **In H:** `80d84a04d`, `984dcdcda`, `5e3b07dcd`, PR #109 (merged, reverted,
  reapplied as `eee2111fa`), `src/ts/stores/domain/moduleStore.svelte.ts`.
  The order also changes how module lore and regex entries are combined.
- **In M:** nothing found (`moduleOrder`, `moduleFolder`). M has
  `moveRecordListItem` in `src/ts/storage/records.svelte.ts`, and
  `characters-modules.md` says aggregate order follows the DB module order.
- **Fit:** port concept. Use the `modules` record's own list order plus
  `folderId` and a small `moduleFolders` record, not a separate order setting.
- **Effort:** M.

**A17. Character list sort, favorites, context menu, Duplicate Character**
- **In H:** `f6040fa79`, `1a0aa3758`. Sort by default, name, recent or
  favorite; a favorites filter (`characterFavorites`); right-click to
  favorite or hide. `src/ts/characters.ts` duplicate (fixes `9729880ef`,
  `13104edc8`).
- **In M:** `GridCatalog.svelte` has name search only. Duplicate Chat exists;
  Duplicate Character does not.
- **Fit:** port concept, onto `GridCatalog`. Duplicate Character must create
  through `characterStore` and the mutation modules, and copy chats as new
  server records.
- **Effort:** M.

**A18. Small chat-screen items**
- **Generation stats float:** a card with model, elapsed time, time to first
  token and tokens per second (`GenerationStatsFloat.svelte`,
  `src/ts/process/chat/generationStats.ts`, `a0bfba7b6`, `03c730d5c`). M's
  request history already records `startedAt` and `firstByteAt`, but nothing
  shows them live. Port concept from job timings. S.
- **Jump to beginning:** `c099eefb9`. M has `scrollToMessage` and the row cap
  but no jump. Port concept on M's row window. S–M.
- **Waiting minigame above the composer:** `WaitingDinoGame.svelte`, PR #108.
  Cosmetic, port as-is if wanted. S.

### (b) Performance / memory / lazy loading

**B1. Server-made thumbnails for lists**
- **In H:** `server/node/storage/assetStorage.ts` (`readThumbnail`, sharp,
  cached as `__thumbs/<hex>_<w>x<h>.webp`). `?thumb=1` gives 128², `display`
  gives 512×768. Client batching in `ThumbnailBatchLoader`
  (`globalApi.svelte.ts`). Commits `24d2cdafb`, `4c993a5c5`, `fa6c6ba32`.
- **In M:** *verified* nothing (`rg -il "thumbnail|sharp" server/src` is
  empty). Catalog, sidebar rail and persona icons decode full-size card PNGs.
- **Fit:** port concept. Add `GET /api/assets/thumb?key=&size=` with a cache
  keyed by content hash and size. It fits hashed assets, the service-worker
  `risuCache`, and the heap-memory plan. It needs sharp (native) or a
  WASM encoder. This is probably the largest decoded-image memory win on phones.
- **Effort:** M.

**B2. Deferred and debounced token counting in CharConfig**
- **In H:** `src/ts/deferredTokenCalculator.ts` (`9021c009b`). The first
  count waits for idle time, edits are debounced by 150 ms, stale results are
  dropped by a generation number, and unchanged fields are reused.
- **In M:** the chat note is already deferred. `CharConfig.svelte`
  tokenizes description, first message and note eagerly in `$effect.pre`.
- **Fit:** port as-is. It also gives a natural place to fix the known
  CharConfig `localNote` undefined-tokenize throw.
- **Effort:** S.

**B3. Tokenizer load queue**
- **In H:** `src/ts/tokenizerQueue.ts` serializes loading and encoding of the
  shared web tokenizers.
- **In M:** `tokenizeWebTokenizers` in `src/ts/tokenizer.ts` can fetch
  multi-MB tokenizer files twice when two calls race, and a slower load can
  overwrite the faster one. This affects the client only; the server
  preloads everything.
- **Fit:** port as-is.
- **Effort:** S.

**B4. Lazy-loaded locales**
- **In H:** `src/lang/index.ts` imports English eagerly and loads the other
  languages on demand (`e2a3e9641`, which also adds an optional-runtime chunk
  group: eager JS went from 3.77 MB to 1.29 MB).
- **In M:** *verified*. `src/lang/index.ts` statically imports all 7 locales. A
  stale `dist/` suggests a `lang` chunk of about 767 KB that stays in the heap;
  measure before acting.
- **Fit:** port concept. `changeLanguage` has to become async, and the boot
  language has to load before the first render.
- **Effort:** S–M.

**B5. Low-spec mode preset**
- **In H:** `e48296e3f`, setting `lowSpecMode`. It changes thumbnails for
  avatars, the number of chat load pages, cache limits, retained messages,
  reroll history, idle-release batch size and the engine cap.
- **In M:** nothing (`rg lowSpec`). The individual knobs exist (load pages,
  `MAX_LOADED_CHATS`, `CHAT_ROW_CAP`).
- **Fit:** port concept, as one preset over M's existing knobs, plus B1 if it
  lands.
- **Effort:** S–M.

**B6. Small rendering fixes**
- Keyed `{#each}` rows by `chaId` / `chat.id` (`f2cb44a37`). M still has
  unkeyed loops in `SideChatList.svelte`, `Sidebar.svelte` and
  `MobileCharacters.svelte`. Port as-is, minding the rows' local state. S.
- Create Sortable instances only in edit mode (`6ef9592ed`). M creates them at
  mount (`SideChatList.svelte`). Port as-is. S.
- Animate the mobile sidebar with `translateX` instead of `width` keyframes
  (`172ba3ce3`). M's `Sidebar.svelte` animates `width`/`min-width`. Port
  concept. S–M.
- One shared IntersectionObserver for lazy images (`1ecf1cd3a`). M's
  `LazyCharImage` and `LazyFileSrc` create one observer each. Port concept. S.
- Cap the bundles inside each reroll-history slot (H caps at 50). M's
  `rerollHistory.ts` caps slots but not the bundles in a slot. Port as-is. S.

**B7. Bounded caches (`BoundedCache`, `imageCacheLimits.ts`)**
- **In H:** an LRU by entry count and bytes, with limits tiered by device. An
  evicted blob URL is revoked (`8015825a9`, `812d56554`, `8502af5fd`).
- **In M:** the parser `fileSrcCache` is an unbounded Map. Pinned
  `getFileSrc` blobs are a known item in the heap-memory plan D2, which
  rejected "LRU then revoke" because kept HTML points at those URLs.
- **Fit:** port concept only for the parser `fileSrcCache`, which maps paths
  to strings with nothing to revoke. Revoke-on-evict would break M's kept
  HTML.
- **Effort:** S.

**B8. Releasing inactive character details and paging long chats in memory**
- **In H:** characters' details are dropped in idle batches with a warm LRU
  (`025a4ef99`). Chats are read in pages of 40 messages, keeping the newest
  200 in memory (`14be15842`, `server/node/util/messagePagination.ts`).
- **In M:** idle chats are already evicted (`MAX_LOADED_CHATS = 8`, M ahead).
  Character records are held in full. A loaded chat is held whole; only
  rendering is capped.
- **Fit:** port concept, measured first with the M0 heap tooling. Both conflict
  with the record wrappers and the whole-chat revision model.
- **Effort:** L each.

**B9. Hypa V1 query-embedding cache**
- **In H:** `59c4eb7a8`, `3a1926337` (cache queries; merge identical
  in-flight embeddings).
- **In M:** V2/V3 go through `getEmbeds` with the persistent
  `server/src/data/vectorCache.ts`, so M is ahead there. V1 `similaritySearch`
  (`server/src/prompt/embeddings.ts`) embeds the query with no cache lookup.
- **Fit:** port concept for V1 only.
- **Effort:** S.

### (c) Data / backup / storage

**C1. Chunked, resumable backup upload with progress**
- **In H:** 4 MiB chunks. A retry at the last offset is accepted only if its
  size and SHA-256 match, and idle uploads expire after one hour
  (`packages/backup-core/src/node/importUploadStore.ts`, `de787f72a`,
  `f1f114dfc`). Byte-level and multiple progress bars: `798a30c27`,
  `85276a2bd`, `d49f2e5b6`.
- **In M:** `importBackup` sends the whole `File` as one request with a
  4-hour timeout. The UI shows only `alertWait("Restoring local Backup...")`.
  The server side is already safe: it spools, validates, snapshots, hard-links
  new assets and swaps with one `replaceAll`.
- **Fit:** port concept. One-request uploads fail behind proxies that cap
  request size (the Cloudflare free plan allows about 100 MB). Restore stages
  can go over the event channel.
- **Effort:** M; S–M for progress alone.

**C2. Orphan asset report and cleanup**
- **In H:** the Storage Explorer collects every referenced key (characters,
  modules, personas, backgrounds, folder icons, thumbnails) and flags the rest
  (`StorageExplorer/utils.ts`, `b46e74865`, `1e4342cc6`, `e46c9f293`).
- **In M:** nothing. `app-shell.md` says orphaned `assets/*` files are never
  purged, and failed imports leave content-addressed orphans
  (`self-host-server.md`). `shared/backups.ts` and `backuplocal.ts` already
  compute the referenced keys.
- **Fit:** port concept, on the server. Count every kept snapshot as a
  reference so that restoring a snapshot never loses assets. Show a dry-run
  report first, then delete under `withMaintenance`.
- **Effort:** M.

**C3. Snapshot browser and per-record restore**
- **In H:** a revision-history browser with an audit drawer, diff modal and
  per-row restore (`src/lib/Setting/Pages/DbExplorer/components/DbRevision*.svelte`,
  `60489e18a`). It reads a `system_revisions` table.
- **In M:** snapshots of `resources.sqlite` every 10 minutes, 20 kept
  (`server/src/data/snapshots.ts`). Restore is all-or-nothing, and no
  per-record history exists.
- **Fit:** port concept. Compare a snapshot with the current state per
  record, and restore one character or chat from it. This needs no revision
  table.
- **Effort:** M–L.

**C4. Plugin storage explorer and per-key plugin storage patches**
- **In H:** `PluginStorageExplorerSettings.svelte` (`63ff15238`): list keys
  with search, type and size; edit, add and delete. Plugin custom storage
  syncs per key (`9931dbb84`, PR #179).
- **In M:** one `pluginStorage` record, merged by key across tabs, so M is
  ahead on sync. But a record patch re-sends the whole `_pluginStorage`
  dictionary on every `setItem`, and the `plugins` list is sent whole,
  scripts included, on every toggle.
- **Fit:** the explorer ports as-is (S). Per-key patches are a concept port (M).

**C5. Batched plugin `getDatabase` transfer**
- **In H:** PR #200 (`d1c568c85`, `019af3e9a`,
  `src/ts/plugins/apiV3/databaseSnapshot.svelte.ts`, `databaseTransfer.ts`).
  Object, array and set operations stream into a receiver inside the iframe,
  so the host never deep-copies the whole character and chat graph.
- **In M:** `plugins-mcp.md` notes that `getDatabase` with characters loads
  and copies every chat.
- **Fit:** port concept. It fits the heap-memory plan.
- **Effort:** M.

### (d) Plugin / scripting / API

**D1. Plugin safe mode**
- **In H:** `src/ts/safeMode.ts`, `2f8b6ef2a`, `e2e/safe-mode.spec.ts`.
  `?safe=1` makes `loadPlugins()` return early; plugins and their settings are
  untouched.
- **In M:** `SafeModeStore` only turns off custom CSS, from a hotkey. There is
  no way to boot without plugins.
- **Fit:** port as-is. Read `?safe=1` in `loadPlugins` and set
  `SafeModeStore` from it too.
- **Effort:** S.

**D2. Browser crash guard for plugins**
- **In H:** PR #181, `src/ts/plugins/pluginCrashGuard.ts`. It blames and
  disables the plugin that crashed boot, but uses a native Capacitor plugin.
- **In M:** none.
- **Fit:** port concept. Mark "loading plugin X" in storage before each sandbox
  starts. If the next boot finds the mark, offer to disable X.
- **Effort:** S–M.

**D3. `{{trigger_id}}` read from a global in the tab parser**
- **In H:** the pinning series passes `matcherArg.triggerId` explicitly
  (`19569195b`..`fc7228af2`).
- **In M:** `parser.svelte.ts` reads the global `CurrentTriggerIdStore`, so
  any other chat the tab renders in the 100 ms after a manual trigger sees that
  id. This was found by the cluster read and not re-verified.
- **Fit:** port concept. It is the only part of the pinning series M still
  needs; the rest (preset-chain gate, MCP isolation, trigger ID scoping) M
  solved with server jobs.
- **Effort:** S.

### (e) Ops / deployment / tooling / testing

**E1. Health endpoint, Docker HEALTHCHECK, and a Caddy HTTPS compose file**
- **In H:** `docker-compose.rustfs.caddy.yml` with a two-line Caddyfile for
  automatic HTTPS, plus DDNS updaters for Cloudflare and dynv6.
- **In M:** a `Dockerfile` (node:24-slim, no HEALTHCHECK), `server.sh`, and a
  local-CA script. No compose file and no health route (searched
  health/healthz/status).
- **Fit:** port concept. A secure context is what PWA install and Web Push
  need. Use `TRUST_PROXY=1` and bind the app to 127.0.0.1.
- **Effort:** S.

**E2. Degraded recovery mode when the store will not open**
- **In H:** `77e778d37` keeps HTTP up with a repair UI when SQL is down.
- **In M:** a failed store open or integrity check makes `main.ts` exit(1).
- **Fit:** port concept. Serve a minimal authenticated page that lists
  `save/backups/*.sqlite` and restores one.
- **Effort:** M.

**E3. Termux self-host on Android, one-line installer, off-host backups**
- **In H:**
  - `deploy/termux/{install.sh,haejeok.sh}`: runit services and `haejeok open|start|stop|logs|update`.
  - `install.sh`: umask 077, generated credentials.
  - `risuai.sh`: install, rebuild and dev commands, Podman, credential preservation.
  - `deploy/quick/backup.sh`: encrypted restic backups.
- **In M:** none.
- **Fit:** port concept.
  - Termux is simpler for M (Node ≥ 24 plus `node:sqlite`, no Postgres). Risk: `onnxruntime-node`, used for local embeddings and the Gemma tokenizer, probably has no Android build. Unverified.
  - The restic helper should copy the latest snapshot file (or use `store.backupTo`) together with `save/assets`.
- **Effort:** M each.

**E4. Runtime-dependency check**
- **In H:** `tooling/check-node-runtime-dependencies.ts` walks the server's
  import graph and fails on any import that is not a declared dependency.
- **In M:** `self-host-server.md` says server dependencies must be prod
  dependencies because the Docker runtime installs with `--prod`, but nothing
  checks it.
- **Fit:** port concept, over `server/src` and `shared/`.
- **Effort:** S.

**E5. E2E specs worth adding**
- Backup round trip, including the streamSaver download (H
  `e2e/local-backup.spec.ts`). `backup-sync-hub.md` lists `LocalWriter` as
  untested.
- Job reattach after a dropped stream (`model-job-mobile-reattach.spec.ts`).
- Opening a lazily loaded chat must not save an empty `scriptstate`
  (`chat-variable-hydration.spec.ts`).
- Port concept, written to M's two-gate test rule. S–M each.

### (f) UI / UX details

**F1. Settings search**
- **In H:** `src/ts/setting/searchIndex.ts`, `SettingsSearch.svelte`,
  `94885b492`. Results are ranked by label then keywords then help text, in
  both the current language and English. The page scrolls to
  `[data-setting-id]` and flashes an outline.
- **In M:** no UI. But `getFullSettingsData(searchTerm)` exists in
  `src/ts/setting/utils.ts`, and the `keywords` field in `types.ts` is marked
  "for future search feature".
- **Fit:** port concept. Build the index from M's sections and URL router,
  not from H's fixed menu numbers.
- **Effort:** S–M.

**F2. `color-scheme` and native control theming**
- **In H:** `55efcdd8c` sets `document.documentElement.style.colorScheme`
  and styles `<option>`. `6017ae077` makes selects consistent across themes.
  `323d16328` styles checked checkboxes in light themes.
- **In M:** no `color-scheme` anywhere, although light schemes exist, so
  native dropdowns can render in the wrong theme.
- **Fit:** port as-is.
- **Effort:** S.

**F3. Prompt editor: add by type, Expand/Collapse All, taller fields**
- **In H:** `8636fae09`, `0c08e3974`.
- **In M:** Expand/Collapse is only the Ctrl+Alt+O hotkey, and Add always
  makes a plain item (`PromptSettings.svelte`).
- **Fit:** port as-is. H's labels are hard-coded, so add locale keys.
- **Effort:** S.

**F4. Chat edge fade and textarea resizing**
- **In H:** PR #197 (`d247cb166`, `def823074`): settings `chatEdgeFade`,
  `chatEdgeFadeSize`, `chatEdgeFadeCurve`, `chatEdgeFadeFromBottom`,
  `fixedChatTextareaBottomCover`. Resizable composer: `70ff40f2b`,
  `97771e17d`.
- **In M:** none; `TextAreaInput.svelte` uses `resize-none`.
- **Fit:** port as-is, checked against the Metatron theme and chat
  backgrounds. New settings need D2 ownership and defaults.
- **Effort:** S–M.

**F5. Model browser with favorites and recents**
- **In H:** `src/lib/UI/Model/ModelBrowser.svelte`,
  `src/ts/model/modelFavorites.svelte.ts` (`localStorage`), `3f1cced6c`,
  `30eb9fef9`.
- **In M:** `ModelList.svelte` (provider accordion) and `ModelGrid.svelte`.
- **Fit:** port concept. Store favorites in the synced settings, and consider
  favorite *model profiles* instead.
- **Effort:** M.

**F6. Auto-adapting card colours for light themes**
- **In H:** `src/ts/gui/colorAdapt.ts` (about 650 lines, 4 algorithms, no
  tests, `796adfc45`). It recolours inline styles and CSS in the parser.
- **In M:** nothing.
- **Fit:** port concept, opt-in, in M's parser/`transformClient` with tests.
  Keep OKLCH only, and measure the cost per message.
- **Effort:** M.

**F7. Persona list search (and optionally a two-pane editor)**
- **In H:** `DesktopPersonaSettings.svelte` (`85fc19735`, `ebf10fbbe`).
- **In M:** icon grid, with search only for linked modules.
- **Fit:** port concept.
- **Effort:** S for search; M for the layout.

## 3. Top recommendations

1. **Small fixes Haejeok already found that metatron still has** (S, port as-is):
   - **DeepLX throttle never waits** (*verified*; **fixed** in M `6d1b498bd`): `src/ts/translator/translator.ts:288-294` only sets `waitTrans` when it is already in the future. H `6bac0a3a3` (PR #343) schedules `max(now, waitTrans) + 3000`.
   - **Translated lines lose their breaks** (*verified*; **fixed** in M `7d8454782`, `runTranslator` now cuts with `translateProtectingLines` and the DeepLX HTML batches drop the separator's padding newlines): `runTranslator` at `translator.ts:195-201` joins adjacent non-empty lines without `\n`, so `"a\nb"` becomes `"ab"`. This hits client Google/DeepL/DeepLX, TTS and the playground; the server's `translateProtectingLines` is correct. H `8bcb19014`, issue #322.
   - **Unchecked greeting index** (**fixed** in M `a852016d4`: `shared/greetings.ts`, used by the chat screen, the CBS registry, `triggers.ts` and the regex `repeatBack` in `scripts.ts`; `server/src/prompt/assemble.ts`, `src/ts/characters.ts`, `src/ts/gui/branches.ts` and `src/lib/Others/HypaV3Modal/utils.ts` still index directly, the first two waiting for the heap-memory branch): `alternateGreetings[fmIndex]` in `DefaultChatScreen.svelte:1067-1092`, `shared/cbs/registry.ts` and `server/src/prompt/triggers.ts`. H `src/ts/firstMessageSelection.ts` (PR #58) normalizes out-of-range indexes to -1; put it in `shared/`. This also covers the "old fmIndex" leftover in memory.
   - **Wrong blob MIME** (open): `getFileSrc` blob URLs default to `image/png`. H `src/ts/media/mimeType.ts` (`284764fd2`) closes the "blob URL MIME" leftover. Waits for the unmerged `heap-memory-reduction` branch, which also changes the `getFileSrc` blobs.

   These are cheap, contained and confirmed in code.
2. **Stop a generation from another tab or device (A13).** It is a small change at
   `ownJob`, and it fixes a visible gap now that sends survive switching chats and
   other tabs show the reply as locked.
3. **Server-made thumbnails (B1).** It is the biggest remaining
   decoded-image memory cost on phones. It also helps the boot cache and the
   heap-memory plan, and fits hashed assets naturally.
4. **Persistent in-chat branches (A1), with reroll from any reply (A2).** Today rerolls
   are lost on reload and branching copies the whole chat. This is the
   largest user-visible improvement in H. It should be planned as a phased
   schema change.
5. **Resumable chunked backup upload with progress (C1), then upstream backup
   import (A14).** C1 removes a likely failure behind Cloudflare
   or Tunnel proxies. A14 opens a migration path from upstream RisuAI, which M
   currently refuses outright.
6. **Message search (A3) with Korean matching (A4).** The value is high for long-time
   users, FTS5 on the existing `messages` table is straightforward, and A4 is a
   drop-in for list filters too.
7. **Settings search (F1) and `color-scheme` (F2).** The hooks for F1 already exist (`keywords`,
   `getFullSettingsData`). F2 is a one-line correctness fix for the light schemes.
8. **Deferred CharConfig token count (B2), tokenizer load queue (B3) and lazy
   locales (B4).** All are small, measurable client-heap and jank wins in M's
   current focus area.
9. **Per-module auxiliary model as a module → profile mapping (A15).** It is a
   real need of library modules (issue #61). M's `profileId` per call is
   already half of it.
10. **Ops basics: health endpoint plus Caddy compose (E1), orphan asset cleanup
    (C2), plugin safe mode (D1).** Each is cheap, and each removes a real
    support or recovery dead end.

## 4. Explicitly not worth porting

- **Storage backends and sync between them:**
  - **What:** PostgreSQL, Oracle, Azure SQL, sqlite-wasm/OPFS, S3/RustFS, storage profiles, and staged resumable storage sync (`server/node/sync/storageSync*.ts`, `packages/storage-*`).
  - **Why not:** M has one store (`node:sqlite` plus content-addressed files). Moving between servers is export then import.
- **Tauri and Capacitor:**
  - **What:** multi-window tabs, native window chrome (Liquid Glass, Fluent, GTK CSD, KDE colours), Android widgets, foreground service, native backup and thumbnail plugins, the crash guard as built, deep links, the PPA and Arch packages.
  - **Why not:** M is browser and PWA only, by invariant P1.
- **The "Pin X to generation targets" series** (about 30 commits), `presetChainGenerationGate.ts`, MCP isolation per generation, and trigger ID scoping:
  - **Why not:** M's server jobs carry their own chat binding, scope and tool set. Only D3's small client parser leftover remains.
- **H's durable model jobs and journal replay:**
  - **What:** `server/node/executors/modelJobs.ts`, `durableModelJobs.ts`.
  - **Why not:** M already runs the whole generation server-side, with reattach, recovery, locks and Web Push. One difference: a server restart ends M's jobs with reason `shutdown` (the partial text is kept), whereas H recovers them. That gap is minor.
- **Realtime replay buffer** (512 events by `Last-Event-ID`, `952100adc`):
  - **Why not:** M's revision-based `listRevisions` and `reconcileRemote` after `hello` has no window limit and reloads only on an epoch change.
- **The "inactive generations" asset journal and preserving overwritten assets:**
  - **Why not:** M's assets are content-addressed and imports never overwrite them. The database swap is already one transaction.
- **Module sandbox bundles with per-bundle Lua engines** (`ModuleSandboxGroups.svelte`):
  - **Why not:** they work around H's cached shared Lua engines. M gives every run a fresh engine. Only "a bundle has a model" matters, and A15 covers it.
- **Revoke-on-evict blob LRU (B7 as built):**
  - **Why not:** M's heap-memory plan D2 rejected it because kept HTML points at those URLs.
- **Client-side lore, vector and tokenize offload helpers** (`loreMatch.ts`, `loreResolve.ts`, `tokenizeCount.ts`), the Hypa persistent vector cache, and the scripting engine cap:
  - **Why not:** M already does all of these on the server.
- **Regex compile LRU** (`regexCompileCache.ts`):
  - **Why not:** M caches regex outputs, and V8 already caches compilation by source and flags. That second point is from memory and was not measured.
- **Onboarding wizard with storage-profile and legacy SQL migration** (`WelcomeRisu*.svelte`):
  - **Why not:** M removed its wizard on purpose (`1c1a262a8` in M). A "no model profile or API key yet" card on the home screen would be the lighter alternative; that idea is this survey's suggestion, not something H built.
- **Others:**
  - **Bergamot fixes:** M removed Bergamot.
  - **LogTape, Valibot:** M has its own equivalents.
  - **Upstream Risu Account OIDC** (`openid-client`): not applicable.
  - **Permissive remote CORS:** not applicable.
  - **AirisuMascot:** H's own mascot.
  - **H's beta mobile layout** (`MobileChatList`, `MobileToggles`): M removed that layout.
  - **"⚡ Bolt" micro-optimizations:** too small to matter, except the keyed rows in B6.

## 5. Open questions

1. **Branch model scope (A1).** Should branches be true message trees inside
   one chat record, or linked chats with a parent pointer and fork message?
   - **Inside the chat:** fewer records, but every prompt, memory, translation and Lua reader must follow the active path.
   - **Linked chats:** easier, but reroll history stays chat-sized.
2. **Cross-device stop (A13).** Is dropping the `clientId` match for abort safe for
   plugin-provider jobs? Those stream through the owning tab, so another
   tab's abort would have to reach that tab's provider. This relates to the
   known guest-provider abort-mirror hazard.
3. **Thumbnails (B1).** Is a native `sharp` dependency acceptable in the Docker
   image, and on Termux if E3 is pursued? Or should a WASM encoder be used?
   What sizes are needed: icons at 128², and catalog cards at 512×768 as H uses?
4. **Upstream backup import (A14).** How old an upstream backup must be
   accepted? H handles `database.risudat` with cold-storage chats. Older
   `database.bin` layouts and the `encryption.risudat` (Risu Account) scheme
   were not checked.
5. **Whether H's "restore into inactive generations" journal survived its later
   refactors.** `5e33b9d8b` and `6c4f81fad` seem to write assets directly
   again. This was not settled, but it does not affect M.
6. **Whether `onnxruntime-node` and the transformers worker run on Termux/Android**
   (E3). If they don't, local embeddings and Gemma tokenization would need a
   graceful fallback there.
7. **Bundle and heap numbers for B4 and B8.** The lang chunk size came from a
   stale `dist/`. Character-record and long-chat heap shares should be
   measured with the M0 tooling before choosing L-sized work.
8. **H's module sandbox bundles** appear to be active in every chat
   (`getModuleTriggers` does not filter by character). This was not confirmed
   in a running app; it matters only if the bundle idea is revisited.
9. **Product decisions.** Chat tabs with split panes (A6) and BTW threads
   (A7) both need concurrent sends in one browser tab. Is that a direction
   metatron wants, given the mid-send switch design (`sendChat` owns
   `doingChat`)?
