# Metatron feature inventory (for overlap check vs PocketRisu / RisuBard)

Repo: /home/codex/risuai-metatron, branch `metatron` at 44e18f2ae (2026-10-19). Read-only survey.
Metatron forked from upstream RisuAI around 2026-09-28 (first fork commit `a82359f73` Phase 0).
Every `path:line` below was checked with `rg -n` on this tree. Guide = `docs/structure/<guide>.md`.
Status legend: **yes** / **partial** / **no**.

Architecture baseline that colors every row: the client requires the Hono/Node self-host server
(no static hosting, Tauri, Capacitor). All data lives server-side in SQLite; the tab holds resource
records only; generation, prompt assembly, Lua, triggers, regex and memory run on the server.

## 1. Server, storage, backup

| Area | Status | Metatron name | Pointers | How it works / where it stops |
|---|---|---|---|---|
| Server-side generation surviving disconnect | **yes** | server generation jobs (`send`/`continue`/`group`/`command`/preview jobs), job channel | `server/src/jobs/generationJobs.ts:364` `createGenerationJobs`; `server/src/prompt/runner.ts:262` `runPromptJob`; guide `self-host-server.md` Files (generationJobs) | One running job per chat; runs to the end on the server whether or not a tab is attached; 30 min cap (`JOB_MAX_DURATION_MS`), ended job readable 60 s (`JOB_DONE_GRACE_MS`). Server message lock published on the change feed (748746575) so every tab shows the reply locked. |
| Reconnect restore | **partial** | `resumeSavedGenerations` / `resumeServerJobs`, `followJobToEnd` | `src/ts/network/generationJobs.ts:606`; `src/ts/process/serverCommands.ts:260`, `:94` | Same tab after reload re-attaches via `sessionStorage` (`risu-generation-jobs`). Other tabs/devices see locks + final records via the live feed, not the stream. A lost follow shows a "recovery" badge (`chatStatus.svelte.ts`). No cross-device "resume watching stream" UI. |
| Unified server storage | **yes** | resource store (SQLite, `node:sqlite`, WAL), chat tables, schema v3 | `server/src/data/resourceStore.ts:280` `createResourceStore`, `:58` `SCHEMA_VERSION`, `:1745` WAL pragma; `server/src/app.ts:157` (`save/data/resources.sqlite`) | Kinds (settings sections, collections, characters, inlays, presets, modules, plugins, pluginStorage) plus chat/message rows. Separate `vectors.sqlite` (`app.ts:209`) and `request-history.sqlite` (`app.ts:223`). Assets are content-addressed files `save/assets/<sha256>.<ext>`. NOT file-native: records are not individual editable files. |
| Revisions / optimistic concurrency | **yes** | record revision + epoch, 409 conflicts, `/api/resources/revisions` | `server/src/data/resourceStore.ts:173` `nextRevision`, `:101` `ResourceConflictError`; `server/src/routes/resources.ts:267`; guide `persistence.md` Flows "Save" | Every write carries base revision; batch is one transaction, any conflict rolls back. Revision = counter only; **no per-record revision history / version browsing**. |
| Journal | **partial** | SQLite WAL; diagnostics event journal | `resourceStore.ts:1745`; guide `diagnostics.md` "Journal, reports, and support copies" | No app-level append-only write journal for user data; WAL is the engine's. Diagnostics has a content-free event journal. |
| Trash | **partial** | character trash (`trashTime`) | `src/ts/characters.ts:812` (trash), `:779` (restore); `src/ts/bootstrap.ts:367` (3-day prune) | Upstream character trash only, pruned at boot after 3 days. No trash for chats, modules, presets, lorebooks, assets. |
| Atomic saves | **yes** | batch transaction; staged-file rename | `server/src/routes/storage.ts:186` `writeStorageFile` (tmp + rename); `resourceStore.ts` batch transaction; guide `self-host-server.md` Flows "Resources and saving" | One `/api/resources/batch` per save cycle, all-or-nothing; assets written to `save/.tmp` then renamed. |
| Server-side backup/restore | **yes** | backup archive v2 export/import, snapshot restore | `server/src/routes/backups.ts:109` (export), `:292` (import); `src/ts/drive/backuplocal.ts:183`, `:213` (full / partial) | Archive = manifest.json + fresh `resources.sqlite` (llmSecrets stripped, VACUUMed) + assets. Import validates whole archive, then safety snapshot, then replace under maintenance lock; other tabs get 412 → `resourceRestored` reload notice. |
| Snapshots | **yes** | periodic resource snapshots | `server/src/data/snapshots.ts:58` `createSnapshotManager` (10 min, keep 20); `src/ts/globalApi.svelte.ts:1107` `loadInternalBackup` | Snapshot only when writes happened; restore picks from an alert list (no preview, no diff, no naming, no per-chat scope). Safety snapshot before every restore/import. |
| Storage dashboard (disk usage, reclaimable) | **no** | — | (no hits for disk usage / reclaim / orphan asset GC) | Content-addressed asset orphans are left on disk (guide `self-host-server.md` module/CharX import step 4); old `save/database`, `save/remotes`, coldstorage files also left. No usage view, no GC. |
| Request logs / request history | **yes** | durable LLM request history + tab request log + diagnostics | `server/src/data/requestHistory.ts:352`; `server/src/routes/requestHistory.ts:114`; `src/lib/Others/RequestLogs/ServerRequestHistory.svelte`; guide `diagnostics.md` | Every server LLM request captured (credentials redacted) in its own SQLite with byte cap (`RISU_REQUEST_HISTORY_MAX_BYTES`); content-off mode; failed jobs name `stage`/`requestId`/`providerCode`; "share job requests to diagnostics folder" for support (sftp-readable). |
| Session locks / multi-tab takeover guard | **partial (different model)** | revision conflicts + live change feed; generation locks; reload notice | `server/src/data/changeFeed.ts:22`; `server/src/routes/events.ts:21` (`/api/events/ws`); `src/lang/en.ts:1316` `resourceReloaded` | No single-writer lease / "another tab took over saving" prompt. Every tab writes concurrently; stale whole-record writes reload with notice "Another tab or device changed this data"; by-id message ops merge. Unload warning while unsaved work exists. Plugins get `onStorageDiscarded` (`src/ts/plugins/apiV3/risuai.d.ts:2111`). |
| Self-update from web UI | **no** | — | (no hits; only plugin version check `src/ts/plugins/plugins.svelte.ts:67`) | Update = git pull / new Docker image by hand. |
| Remote access (Quick Tunnel/QR, Tailscale) | **no** | — | `server/src/listenConfig.ts:19` (`RISU_HOST`), `server/src/main.ts:21` `getHttpsOptions` | Only bind address, optional local TLS cert, `TRUST_PROXY`, password + DPoP-JWT auth (`server/src/routes/auth.ts:140`). No tunnel, QR, or Tailscale integration. Client auth needs a secure context (localhost or HTTPS). |
| Terms-of-service gating for RisuAI servers | **no** | — | `server/src/routes/importRealm.ts:58`, `server/src/routes/proxy.ts:8` | Realm is browse+download only (upload/report removed); no ToS gate. Lua egress bans risuai domains (`server/src/lua/egress.ts:18`). |
| Asset manifest / integrity checks | **partial** | backup manifest `missing`; snapshot `PRAGMA integrity_check` | `server/src/routes/backups.ts:145` (missing list); `server/src/data/resourceStore.ts:1244` | Backup archive declares assets + missing keys; restore validates DB integrity and every row. No live scan that asset files referenced by records exist / hash-match. |
| External editing of character files | **no** | — | (data in `resources.sqlite`) | Records are JSON rows in SQLite; nothing watches files. External contracts (plugins, MCP RisuAccess, Lua) write through validated mutation modules instead. |

## 2. Characters, chats, personas, lore

| Area | Status | Metatron name | Pointers | How it works / where it stops |
|---|---|---|---|---|
| Character archive / deactivate | **no** (trash only) | — ; prompt presets DO have archive | `src/lib/Setting/botpreset.svelte:123` `setArchived`; `shared/presets.ts:288` | Only prompt presets can be archived (a99657532). Characters: trash only. |
| Character folders / ordering | **yes** (upstream) | `characterOrder: (string \| folder)[]` | `shared/database.ts:200`; `src/ts/storage/characterOrder.ts:26` `checkCharOrderAtBoot`, `:157` remote repair | Sidebar folders + drag order; order repair across tabs (7b add-only). Home shows recent characters + Explore card. No "vault". |
| Character vault | **no** | — | — | — |
| Chat clone | **yes** | chat Copy (chat list menu), Branch from message | `src/lib/SideBars/SideChatList.svelte:92-99`; `src/ts/globalApi.svelte.ts:1475` `createChatCopyName`; `src/lib/ChatScreens/Chat.svelte:1525` (branch, optional "Branches of" folder) | Whole-chat copy, or branch at a message. Chat folders (`shared/database.ts:1247` `ChatFolder`). |
| Chat paged loading | **partial** | lazy chats + render window pages | `src/ts/storage/chatStore.svelte.ts:5164` `ensureChatLoaded`, `:2159` `selectedChatLoad`; `shared/database.ts:536-537` `chatLoadInitialPages`/`AdditionalPages` | Boot loads chat summaries only; a chat is fetched whole when opened; UI pages over loaded rows (newest-first staged reveal). No server-side message pagination of one long chat. |
| Chat save/load checkpoints (named restore points + preview) | **no** | — | — | Only global server snapshots (above) and reroll history. |
| Chat turn navigation | **partial** | bookmarks (`BookmarkList`, `ScrollToMessageStore`) | `src/lib/Others/BookmarkList.svelte:131` | Upstream bookmarks jump to a message; no turn-by-turn navigator. |
| Chat pinning / status | **yes (metatron)** | pinned chats rail, chat status badges | `src/lib/SideBars/pinnedChats.ts:15`; `src/ts/process/chatStatus.svelte.ts:34` | Pin chats to a rail + home; generating/recovery/unseen badges (per tab). |
| Per-chat persona | **yes** | chat binding (`bindedPersona` + model preset + prompt preset) | `shared/chatBinding.ts:21`, `:69` `resolveChatBinding`; `src/lib/SideBars/ChatBindingPanel.svelte`; guide `persistence.md` (chat bindings) | Every chat binds persona, model preset, prompt preset; send refused until complete; new-chat binding policy; imported chats get a binding review. Personas can link modules (eadaab49e). |
| AI persona builder | **no** | — | — | Persona ↔ character conversion exists (`src/ts/interchangeability.ts:122`, `:136`), no LLM builder. |
| Lorebook workspace/editor with folders and search | **partial** | LoreBook sidebar editor | `src/lib/SideBars/LoreBook/LoreBookList.svelte:365` (folder delete); `shared/database.ts:604` (`mode: ... "folder"`) | Upstream in-sidebar editor with folders + drag sort; **no search**, no standalone workspace. Global lorebook page is unreachable (memory note). |
| Lore builder | **no** | — | — | — |
| First-message studio | **no** | — | `shared/database.ts:653` `alternateGreetings`; `Chat.fmIndex` | Only upstream alternate greetings and per-chat greeting index. |

## 3. Memory, prompt, models

| Area | Status | Metatron name | Pointers | How it works / where it stops |
|---|---|---|---|---|
| Markdown wiki long-term memory | **no** | — | — | Memory = SupaMemory / HypaV2 / HypaV3 / Hanurai, graph memory MCP. |
| Fixed-budget context compiler + request manifest (included/excluded/trimmed) | **partial** | prompt assembly + trimming on server; DevTool prompt preview; per-message `promptInfo`; request history | `server/src/prompt/assemble.ts:290` `assemblePrompt`; `shared/database.ts:1261` `promptInfo`; `src/lib/SideBars/DevTool.svelte` | Upstream-style token trim (preset max context, overridable per prompt preset d617afc7f); asks before a no-memory trim drops history (aad461e63). Request history stores the exact request. No manifest listing what was excluded/trimmed and why. |
| HypaMemory V3 | **yes** | HypaV3 (server) + HypaV3 modal | `server/src/prompt/memory/hypav3.ts:86`; `src/lib/Others/HypaV3Modal.svelte`; guide `memory.md` | Runs on the server in the job; server vector cache `vectors.sqlite`; HypaV3 presets (`shared/hypaV3Presets.ts`). Open bugs: bulk cancel resurrects, selection survives replace. |
| Model binding slots (preset vs legacy model per slot) | **yes (own design)** | model presets → slots → model profiles; named API keys | `shared/database.ts:985` `ModelSlot = {profileId} \| {modelId}`, `:988` `ModelPreset`, `:998` `ModelProfile`; `shared/llm/modelSlots.ts`; guide `llm-requests.md` | Main/sub slots must name a profile; aux slots (memory/translate/emotion/otherAx) may be a profile or a bare model id. Model preset split from prompt preset (111ba8d2d). Credentials write-only (`llmSecrets`). |
| Preset folders in picker | **no** | — (prompt preset archive instead) | `src/lib/Setting/botpreset.svelte:67` | Flat list with an Archived view. |
| Auto translation | **yes** | server translation + translator presets (multi-step) + bilingual display | `server/src/translation/runner.ts:132`; `shared/database.ts:1217` `Chat.autoTranslate`; guide `media-aux.md` | Replies translated on the server automatically, stored as `Message.translation` with source hash; per-chat settings; multi-step LLM pipeline each on its own profile. Bergamot removed. |
| TTS | **yes** (upstream, tab-side) | `sayTTS`, plugin TTS hooks | `src/ts/process/tts.ts:130`; guide `media-aux.md` | ElevenLabs, VOICEVOX, OpenAI-compatible (custom baseURL), VITS, etc.; runs in the tab. |

## 4. Plugins, platform, UI, performance

| Area | Status | Metatron name | Pointers | How it works / where it stops |
|---|---|---|---|---|
| Plugin storage on the server | **yes** | `pluginStorage` resource kind | `shared/resources.ts:27`; `src/ts/storage/pluginStorageStore.svelte.ts` | Saved as a server record (cross-device); `SafeLocalStorage` remains device-local by design. |
| Plugin API extensions | **yes** | v3 sandbox API | `src/ts/plugins/apiV3/risuai.d.ts:1650` `registerSetting`, `:1797` `addProvider`, `:2111` `onStorageDiscarded` | Plugin providers run for server jobs via tab callbacks; hooks get their chat/preset; MCP for server jobs. Known gap: guest provider abort not mirrored. |
| Push notifications | **yes** | Web Push chat completion | `server/src/push/pushService.ts:252`; `src/ts/network/pushNotifications.ts:355` | VAPID subscription per browser; notifies on job completion; click routes to the chat. Real-browser matrix unverified. |
| Performance: save-stage measurement | **partial** | record-patch saves, coalesced writes; no save stage timer UI | guide `persistence.md` Flows "Save"; `server/src/http/compressedJson.ts:15` | Many perf slices (field patches, delta chunks, coalesced setters), but no in-app save stage measurement. |
| Performance: boot sweep | **yes** | boot resource cache + `/api/resources/boot` + zstd/gzip | `src/ts/storage/bootCache.ts:668` `loadBootSnapshot`; `util/playwright/measureBoot.mjs` | Warm boot 18.3 s → 0.51 s at 10 Mbps (archive README). Static files still uncached (no Cache-Control). |
| Performance: composer measurement | **no** (chat-open measured instead) | `util/playwright/measureChats.mjs` | — | Chat-open reveal and streaming row isolation measured; heap work on unmerged `heap-memory-reduction` branch (M0 tooling, A1, B1, B2). |
| Export formats (arca etc.) | **partial** | chat export JSON / TXT / HTML file / HTML embed; card PNG/JSON/CharX/charxJpeg; `.risum`; dataset export | `src/ts/characters.ts:227` `exportChat`, `:601` `exportAllChats`; `src/ts/characterCards.ts:1399`; `src/ts/storage/exportAsDataset.ts:12` | No arca-specific format. |
| Theme tokens | **yes** | CSS tokens + color scheme presets + Metatron theme | `src/styles.css:6`, `:171`; `src/ts/gui/colorscheme.ts:215`; `src/ts/setting/displaySettingsData.svelte.ts:26` | Invariant U1 mandates tokens. Metatron theme ported from "the Fastify fork" (8f0f18827). |
| Mobile / LiteUI | **partial** | responsive UI + `MobileCharacters`; `isMobile` UA flag | `src/ts/platform.ts:18`; `src/lib/Mobile/MobileCharacters.svelte` | PWA installable; no separate LiteUI mode. |

## 5. Metatron features a sibling fork likely lacks (porting direction: metatron → sibling)

- **Thin client / server-owned everything** (Phases 0–6, archive README chronology): SQLite resource store with per-record revisions and epoch, explicit chat mutation API (by-id ops `append`/`setMessage`/`patchMessage`/`meta` merge), no whole-database object on the client.
- **Server-side prompt pipeline**: prompt assembly, lore activation, memory, Lua (wasmoon in terminable worker threads, `server/src/scripts/workerPool.ts:226`), triggers v2, regex, CBS with time limits, script transform for display (`server/src/routes/transform.ts`), inlays, group chats — all in the job.
- **Live multi-device sync**: change feed over WebSocket (`server/src/data/changeFeed.ts:22`) with record field patches, chat patches, delta stream chunks; generation locks on the feed.
- **Chat bindings** (model preset + prompt preset + persona per chat; binding dialog; new-chat binding policy; import review).
- **Split model/prompt presets, model profiles, named API keys** with write-only secrets (`src/ts/model/credentials.ts:16`).
- **Per-chat prompt toggles + toggle presets** (`shared/togglePresets.ts:14`).
- **Pinned chats rail and chat status badges** (generating / recovery / unseen).
- **Diagnostics**: content-free server/browser event journals, Diagnostics panel, combined reports, job support shares readable by an sftp account (`server/src/diagnostics/share.ts:56`).
- **Server-side imports**: `.risum` (`/api/import/module`), CharX (`/api/import/charx`), PNG card reader, Realm two-step staged import (prepare/commit/cancel); batch asset routes; streamed exports.
- **Boot resource cache** (IndexedDB) and compressed boot read.
- **Translator presets** (multi-step pipeline, per-step model profile, Exclude CoT, Send As-Is) with server translation and bilingual display.
- **URL router** (`src/ts/router/routes.ts`) with server-side client route table.
- **Settings UI reorganization** (grouped sidebar, Interaction/Memory/Image/Voice/Translation pages; quick settings panel removed).
- **Server MCP** (remote MCP, dice, internal aiaccess / RisuAccess / graph memory) for jobs (`server/src/mcp/`); Iris assistant (`src/ts/iris.ts`).
- **Server embeddings/vector cache** (`server/src/data/vectorCache.ts:69`) and Transformers worker.
- **Local-network streaming proxy jobs** over WebSocket (`shared/localNetwork.ts:79`).
- **Dev tooling**: `pnpm test:agent` wrapper, `dev:agent`/`dev:human` full-stack runner (`util/agentDev.mjs`), Playwright measure/check scripts, timing-test inventory (`docs/audit/timing-dependent-tests-2026-10-19.md`).

Removed from metatron (a sibling may still have these; porting them in would conflict with metatron's design):
Google Drive sync, Risu Account sync, Kei auto-backup, cold storage, block save format (`database.bin`), PeerJS multiuser, browser-side generation (cutover 12ed3baec), Custom Sidebar, Loadout, Risuai Pro Tools / Easy Panel, Related Links, first-run welcome wizard, quick settings panel, Bergamot translator, Realm upload/report, Tauri/Capacitor/static hosting, fallback models, per-role separate parameters, Local Toggles.

## 6. Notes for the overlap pass

- Storage model is the biggest divergence: metatron = single SQLite + content-addressed asset files + optimistic revisions. Any sibling "file-native with journal / atomic per-file saves / external editing" design is architecturally incompatible, not just missing.
- Multi-tab: metatron deliberately allows concurrent writers (revisions, merges, reload notices) rather than a session lease. A "takeover" prompt would be a new UX layer over the existing 409/feed machinery, not a replacement.
- Generation durability is already server-side; the sibling's reconnect UX could add cross-device stream attach (metatron re-attaches only the same tab via `sessionStorage`).
- Clear gaps that could be ported in without design conflict: storage dashboard + asset GC, named per-chat checkpoints with preview, chat turn navigator, lorebook search/workspace, lore builder, first-message studio, AI persona builder, markdown wiki memory + context manifest, preset folders, character archive/vault, self-update, remote access (tunnel/QR/Tailscale), ToS gating, LiteUI, arca export, save/composer measurement UI.
