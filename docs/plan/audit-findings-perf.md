# Audit Findings and Performance Leftovers Plan

Status: slices 1a (PERF-01) and 1b (MEM-01, MEM-02) landed on 2026-10-15, 1c (LLM-03), 1d (UI-01, UI-04), 2a (GEN-01, JOB-01), 2b (JOB-02), 2c (UI-02, UI-03), 2d (DATA-01, PERSIST-01), 2e (IO-01 to IO-04), 2f (EXT-01), 3a (PERF-02, the read half and the coalesced setter writes), 3b (API-01, API-02, API-03, API-05) 3c (sync traffic during generation, compression deferred) 3d (tab retention, inlay media deferred) 3e (module membership/assets cache and bounded fuzzy scans) and 3f (chat row effects, offscreen containment and append-time trimming) on 2026-10-16, and 3g (remaining whole-record transport) and 3h (asset list name filters) on 2026-10-17; the rest is planned. Five phases, each a list of slices. One
slice is one session, one commit, one file cluster.

This plan merges three sources that overlap but use different vocabularies:

- The two audit reports at `/home/codex/metatron-report` (12 findings at
  `757f07da1`) and `/home/codex/metatron-report-all` (33 more findings at the
  same commit, plus a re-validation of the 12). Every finding there has a
  reproduction script under its `evidence/` folder; those scripts assert the
  _buggy_ behavior, so a passing probe confirms the bug and a failing probe
  means it is fixed.
- The "Left:" items in the performance work recorded in the session memory
  (asset scale and leak audit, chat rendering series, chat patch series, the
  Phase 6 review leftovers). Those are leftovers the user chose not to fix at
  the time, not confirmed defects.

Commits after the audited baseline (`2ef247db8` through `ab11ea9d0`) are all
storage/diagnostics work. None of them closes a report finding; the memory's
FIXED entries are already excluded below.

## How the work is sorted

Sixty-odd items from three sources do not fit one list. The plan sorts them on
three axes and then cuts by file cluster:

1. **Harm first.** A hang of the shared server (one tab stalls every tab)
   outranks data loss, which outranks CPU/memory/traffic cost, which outranks a
   compatibility or feature defect. The reports' P1/P2 follow this order
   already; the memory's leftovers are all in the third tier.
2. **Same root cause, one slice.** Several findings are one mechanism seen
   from different places: four of the five P1s are "synchronous unbounded work
   on the server event loop"; PERF-02 and three memory leftovers are "a job
   re-reads whole records per effect"; NET-01 and three memory leftovers are
   "the tab retains things for its lifetime". These share a slice.
3. **Same files, sequential; different files, parallel.** Slices that touch
   the same cluster (for example `DefaultChatScreen.svelte` in 2a and 2b, or
   `hypav3.ts` in 1b and 4a) are ordered; slices in different clusters can run
   as parallel sessions in their own worktrees.

Each slice names its guide from `STRUCTURE.md` Choose By Task. The fix
direction is the report's unless stated otherwise; re-verify the cited lines
before editing, since the reports are at `757f07da1`.

Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow`
or `delegate-implementation` for one marked _hard_. Each slice ends with the
report's probe now failing (or a regression test replacing it), `pnpm check`,
and the guide's tests.

## Phase 0: Make the checks green

The reports and the memory agree that some checks fail on unchanged code.
These block "the probe now fails" as a done criterion, so they go first.

- **0a. Service-worker first-load fixtures** (_small_,
  `build-test-platforms.md`). `e2e/storedFileSrc.spec.ts:108` and
  `e2e/transformGolden.spec.ts:500` expect an uncontrolled first load, but the
  worker calls `skipWaiting()` and `clients.claim()`. Repair the fixture
  precondition (an uncontrolled page or an explicit unregister), not the
  worker. (`util/playwright/checkStreamingModes.mjs`, which failed right after
  seeding, runs again since 2026-10-16: it opens its bound chat from the
  closed-chat screen.)
- **0b. Chat measurement harness** (_small_, `ui-theming.md`).
  `util/playwright/measureChats.mjs` sends chunks every 20 ms, so it cannot
  show the per-frame change. Add a fast-chunk mode and a row-count report;
  slice 3f depends on this number.

## Phase 1: Stop one input from stalling the shared server

All P1 availability findings. Each is a synchronous loop or regex on the
server's event loop; cancellation timers cannot interrupt any of them.

- **1a. Thoughts-tag regex** (_small_, `self-host-server.md`). PERF-01.
  `server/src/prompt/assemble.ts:968` and `server/src/prompt/triggers.ts:173`
  run `/<Thoughts>(.+)<\/Thoughts>/gms`; unmatched openings are quadratic
  (2.35 s for 200 KB). Replace with one linear scan helper shared by both
  sites, with tests for unmatched, nested, and repeated openings. Independent
  of every other slice: the best first commit.
- **1b. HypaV3 limits** (_hard_, `memory.md`). MEM-01 and MEM-02.
  `shared/hypaV3Presets.ts` accepts `maxChatsPerSummary: 0` and both loops in
  `server/src/prompt/memory/hypav3.ts` (lines 196 and 693) then never advance;
  `splitBySeparator` (line 49) runs a user-supplied regex synchronously.
  Validate the batch size as a positive integer in the shared constructor and
  the server normalizer, add a no-progress guard to both loops, and bound the
  separator (a worker with a deadline, or a non-regex separator language;
  decide at the slice). Regression tests must run in a bounded child process
  so a failed test cannot hang Vitest.
- **1c. Charset retries** (_hard_, `self-host-server.md` with
  `llm-requests.md`). LLM-03. `server/src/llm/outer.ts:117` continues past the
  retry budget on a banned script, and the group request-trigger hook in
  `server/src/jobs/runSetup.ts` returns without yielding. Count charset
  rejections against `requestRetrys`, yield an event-loop turn before every
  attempt (the translation runner already does this), and check the job
  deadline in the loop. Regression: a group send with Echo plus `Latn` ban
  observes a scheduled stop.
- **1d. Client CBS budgets** (_small_, `cbs-rendering.md`). UI-01 and UI-04.
  Same family, but it freezes a tab, not the server. `shared/cbs/registry.ts:1687`
  accepts a zero step; `shared/cbs/evaluator.ts:759` increments `callStack`
  on a shared object and never restores it, so twenty sibling calls or a
  25-message `{{history}}` hit the "recursion" limit. Reject non-advancing
  ranges, derive depth per child, and give the client host in
  `src/ts/parser/parser.svelte.ts` a work/time budget with the error handled
  at the row boundary.

## Phase 2: Stop losing or misdirecting user data

- **2a. The send's captured target** (_hard_, `chat-pipeline.md`). GEN-01 and
  JOB-01, both in `src/lib/ChatScreens/DefaultChatScreen.svelte`. The reroll
  history is component-scoped and reset only on character change, so Undo
  Reroll in chat B can persist chat A's answer and message id. The composer
  clears before the server's input stage, and an accepted job that fails
  before the user message is appended has no refusal, so the draft is gone.
  Key the reroll history by `{ chaId, chatId }`; keep the draft keyed by chat
  and `userMessageId` until the append is acknowledged, and restore it when
  the terminal hydration shows the id never landed.
- **2b. Stop after reload** (_small_, `chat-pipeline.md`). JOB-02.
  `resumeServerJobs` in `src/ts/process/serverCommands.ts` follows the job but
  leaves `doingChat` false and no cancellation owner, so the composer shows
  Send. Same component as 2a; run after it.
- **2c. Partial edit targeting** (_small_, `cbs-rendering.md`). UI-02 and
  UI-03 in `src/ts/parser/partialEdit.ts`: `deduplicateByLine` drops a second
  identical match on the same line, and the `…` expansion maps its third dot
  to the next source character. Deduplicate by source range; map all three
  dots to the ellipsis.
- **2d. Save-loop and singleton adoption** (_hard_, `persistence.md`).
  DATA-01 and PERSIST-01, both in `src/ts/storage/resourceSync.svelte.ts`.
  Removing and recreating a character id before the save cycle drops the
  replacement's chats from every batch; a tab that booted without
  `pluginStorage/main` ignores its first remote creation even after reconnect.
- **2e. Card round trips and backups** (_small_ each, `characters-modules.md`
  and `backup-sync-hub.md`). IO-01 (CharX `?` in asset names), IO-02 (V3
  `depth_prompt` lost on import), IO-03 (PNG `Comment` chunk corrupts the
  exported card), IO-04 (partial backup omits a concurrently replaced image
  and reports success). Four independent small fixes; one session.
- **2f. Provider permission denial** (_small_, `plugins-mcp.md`). EXT-01: a
  plugin provider still receives the prompt after its permission is denied.

## Phase 3: Performance

This is where the memory's leftovers live. Each slice bundles the report's
P2 with the memory items that share its mechanism.

- **3a. Job read amplification** (_hard_, `self-host-server.md` with
  `scripts-triggers.md`). PERF-02 plus three memory leftovers.
  `server/src/prompt/triggers.ts:330` `writeChatMeta` persists every `setVar`
  through `services.writeChat`, which calls `refreshAll` twice and re-reads
  the whole transcript (308 full reads and 101 transactions for 100 setters on
  a 1 MB chat). Memory adds: every job still parses the whole `modules` array
  record and every section and preset; Lua `setChatVar` reparses the character
  twice; a deleted speaker id is looked up again on every `refreshChat`. Keep
  a live metadata overlay in the job scope, coalesce persistence at effect or
  await boundaries, and read only what the job touches. The probe
  `performance-server-probe.mjs` with `PERF_TRACE_SQL=1` is the before/after
  measurement.
  Landed 2026-10-16 (the read half): revision-checked `refreshChat`/`refreshCharacter`,
  the job's own metadata write adopted without a transcript read, no redundant final
  reapply, hydration built only for an open socket and from the metadata for a
  metadata-only write, the owner and speaker names reused by `loadRequestDb` (100
  setters on a 1 MB message: 308 reads and 686 ms to 4 reads and 37 ms; 101 to 100
  transactions). **3a leftovers** landed in part on 2026-10-16: the setter writes of one synchronous stretch (a native trigger's effects between its yields, several `{{setvar}}` in one CBS evaluation, one Lua host call) coalesce into one write, one `chatMeta` adoption and one `chatPatch` (`jobScope.ts` `chatMetadataFor`; the pending keys are laid over every refresh, flushed by a microtask, before anything leaves the job and before any other write of the job's chat, ignoring the fatal latch). A 4 MB `hypaV3Data` chat with 100 setters: 2,367 ms and 100 transactions to 152 ms and 1; the audit probe's 1 MB x 100 case 36 ms to 29 ms. Still per batch at a trigger yield, a Lua host call, an awaited command or callback: one metadata-sized transaction. Still open (their own slice, measure first): reading only the resolvable `modules` and the job's presets and sections (`cutRecord` parses the whole record first and `modulesByIds` matches `namespace`, so this needs a process-wide parsed cache keyed by revision, not a by-id read); `loadRequestDb` still re-reads every settings record per job and per `presetChain` pick; the Lua character setters (`patchCharacter`) still parse the record about five times per call instead of a field patch. (The agent test reporter's throw on a non-string `actual`/`expected`/`message` was fixed on 2026-10-16.)
- **3b. Stream parsing** (_hard_, `llm-requests.md`). API-05 with API-01,
  API-02 and API-03, all in the server adapters. OpenAI
  (`server/src/llm/openAI/requests.ts`) and Google (`server/src/llm/google.ts`)
  reparse the whole accumulated buffer per chunk (320k parses for 800 events);
  Google and Anthropic decode UTF-8 per chunk and corrupt a split character;
  OpenAI treats an overlapping delta as cumulative; Anthropic swallows a reader
  failure and leaves the job pending. One rewrite per adapter: keep only the
  unparsed suffix, a streaming `TextDecoder`, each event parsed once, and
  reader errors surfaced. Regression: parse counts linear in events under
  arbitrary byte boundaries.
  Landed 2026-10-16: `server/src/llm/sseLines.ts` (one streaming decoder, only the
  unparsed line suffix kept) under the OpenAI Chat, Gemini and Anthropic parsers,
  each with persistent state, one parse per event, a malformed line skipped alone,
  one fresh snapshot per read that applied an event; OpenAI deltas concatenated
  (the overlap heuristic of eb0005eeb removed; no provider needed it); Anthropic
  as a `TransformStream` fed by `pipeTo`, so a body failure errors the stream and
  a cancel reaches the body, and its dead in-stream overload retry (it read `db`
  before the declaration, so an overload event vanished) removed: the event is
  `Error:` text and the outer loop owns the retry. Also fixed on the way: Gemini's
  signature saved once instead of per reparse, a `[DONE]` read's earlier events
  kept, `extractJson` no longer blanking `__tool_calls`, a DeepSeek tool-only
  answer no longer dropped, Anthropic's `</Thoughts>` lost at a read boundary.
  800 events one per read: OpenAI 321,200 parses and 310 ms to 800 and 8 ms,
  Gemini 320,400 and 318 ms to 800 and 11 ms; one byte per read, 200 events:
  about 30 ms. Not done: a bounded Anthropic in-stream overload retry (a feature,
  if wanted); the Responses API parser still runs `extractJSON` per event.
- **3c. Sync traffic during generation** (_hard_, `persistence.md` with
  `chat-pipeline.md`). The chat-patch series' deferrals plus one Phase 6
  leftover: other tabs viewing the same chat still re-read it whole over HTTP
  on every change-feed notice (`idleChatRefreshes`); `chunk` events carry the
  whole reply so far; `hydrateAll` and `resync` send the whole chat; the tab's
  `hydrations` map (`src/ts/network/jobChannel.ts` `rememberHydration`) keeps
  every job's whole-chat copy for the tab's lifetime; no WebSocket
  `perMessageDeflate` or HTTP compression. Order inside the slice: free the
  hydrations map (a leak), then prefix-length chunks, then patch delivery to
  idle tabs, then compression last (measure first; it may not be worth it on
  loopback).
  Landed 2026-10-16: the tab keeps job hydrations per job and frees them at
  the job's end (`rememberHydration(jobId, record)`, `endJobChannel`); a job's
  `chunk` event is a delta (`base`, `keep`, `text`) computed in the registry's
  `emit` against `job.current.text`, rebuilt by `applyServerGenerationChunk`
  from the stream buffer, with a reply-only recovery (`resyncReply`, answered
  with the full-text `accepted`, once per follow until an `accepted` arrives; a
  missing message or a retired generation is dropped silently); the change feed
  carries a `ChatPatchBody` for a chat written with by-id ops (`chatFeedPatch`,
  the 64 KiB cap, plain refs for whole ops, no-ops, a remove-and-reappend, a
  chat recorded twice), applied by `noteRemoteChat` to a loaded idle chat held
  at exactly the base (`applyRemoteChatPatch`), the notice and whole read
  otherwise; feed frames serialized once per publish. Measured (302 messages,
  464 KB chat; an 8,000-char reply as 400 chunks with 10 checkpoints): the
  owner socket's chunk bytes 1.65 MB to 65 KB (206x to 8x the reply), the idle
  tab's 12 notices 5.6 MB of whole reads to 46 KB of patches. Compression
  deferred: after the above the large payloads left are whole chat reads (load,
  reconcile, patch misses), `hydrateAll` (the whole chat per callback barrier,
  464 KB here) and `resync`; gzip of that whole read was 4 KB on filler text,
  so an HTTP `compress` scoped to `/api/resources/read` is the candidate if a
  remote deployment needs it; ws `perMessageDeflate` is not worth its per-socket
  zlib memory now that the socket carries deltas. Also not done: the barrier
  still ships the whole chat (`hydrateAll`); the owner tab can apply its own
  job's feed patch in an unlocked window, and a job patch spanning two writes
  then mismatches into the existing whole-chat resync (rare); the client-to-
  server provider `ChannelChunk` stays cumulative; `retiredGenerations` in the
  chat module is never pruned.
- **3d. Tab retention** (_small_ each, `global-api.md` and `plugins-mcp.md`).
  NET-01 plus the Stop B and inlay leftovers and EXT-03. `addFetchLog` and
  `appendFetchLog` in `src/ts/globalApi.svelte.ts:306` never prune (128 entries
  held 16 MiB of text); the 20-entry rule lives only in the globalFetch path.
  `getFileSrc` fallback object URLs are never revoked; inlay audio and video
  object URLs are pinned for the page; the translator cache budget counts
  string length only. The tab MCP client (`src/ts/process/mcp/mcplib.ts:148`)
  keeps every completed stream's locked reader and never settles a request
  whose stream ends without an answer. One bounded log writer, revocation
  where the parser's retained HTML cannot hold the URL, and a `finally` on the
  MCP read.
  Landed 2026-10-16: one private `writeFetchLog` behind the three writers
  (`FETCH_LOG_MAX_ENTRIES` 20, `FETCH_LOG_MAX_CHARS` 16 Mi UTF-16 units over
  body, header and response, the newest entry always kept, trimmed in place so
  the viewer's and plugins' array identity holds; the dead `pipeFetchLog`
  removed): the audit's 128 x 128 KiB entries now keep 20 / 2.6 M chars instead
  of 128 / 16.8 M. `holdFileSrc` beside `getFileSrc` (a shared entry with
  `pinned`/`holders`; an unpinned `blob:` URL is revoked and dropped 100 ms
  after its last release, a hold or plain read within the grace cancels it, a
  release before the load resolves applies after it); `LazyFileSrc` (the asset
  lists) holds and releases; every other caller pins as before. The translator
  cache charges `MEMORY_CACHE_ENTRY_OVERHEAD` (64) per pair. The tab
  `MCPClient` settles instead of hanging (mirroring the server's client, with
  JSON-RPC errors, not rejections, so `getToolList`/`callTool` keep their
  error convention): `waitFor`/`pending`/`failPending`, `connectSSE` releases
  its reader and drops its `sses` entry in `finally`, an answered stream is
  aborted, the legacy GET has a controller and only the current session's
  stream may reset, a throwing POST removes its listener, a ping reply no
  longer blocks the reader; the audit probe's EOF request now settles and 20
  completed streams leave 0 locked readers. Deferred (the Opus challenge):
  inlay audio/video object URLs stay pinned (a mounted-row refcount breaks on
  the translation loading placeholder and on the other renderers of parser
  output, and costs LLM translation cache hits); the recorded design is a
  URL-free placeholder from the parser (`<source data-inlay-src="<key>">`)
  filled by a DOM post-pass like `checkImg`, with the lifetime owned by the
  DOM, which also needs the post-pass in BackgroundDom, MultiLangDisplay,
  AlertComp, Suggestion, PlaygroundParser and the rich copy. Also not done: no
  MCP request timeout and no abort propagation from `getTools` (recorded
  hazards); inlay images without the worker stay pinned through the parser;
  the 100 ms grace was not driven in a browser.
- **3e. Module cache** (_hard_, `characters-modules.md`). ASSET-01 plus the
  Phase 6 and asset-audit leftovers: stale module wrappers after replacement,
  repeated wrapper walks over 100k assets, duplicate row reloads per toggle,
  and unbounded fuzzy scans.

  Landed 2026-10-16: `getModules` keeps its enabled-id/persona-link memo and
  reads a synchronous tracked membership revision from `records.svelte.ts`
  on every call. Whole replacements (remote item patches included), list
  writes/reorders, rebuilt elements, `id`/`namespace`/`mcp` edits, installation
  and reset invalidate it before any effect flush; content edits do not.
  Removed `getModulesUncached`, `refreshModules` and the settings teardown
  call. `moduleFieldPlain` shares plain asset tuples by live element proxy and
  field stamp, using the raw target only for untouched, cacheable fields;
  changed fields walk the live proxy once. A separate assets revision and
  stable aggregates keep parser/ChatBody readers tracked without cascading
  disabled-module or lorebook edits. Parser input keys also make a parse
  current before the root effect runs; maps build lazily on the next parse,
  and an explicit `resetAssetsCache` wins until live inputs change. The effect
  retains its GUI reload, and the menu's
  duplicate bumps are gone: every toggle that changes the effective elements
  is covered, while another enable source can make a toggle visually redundant
  for the rows. The id comparison uses JSON to avoid hyphen collisions and
  also compares wrappers: duplicate ids may switch which element resolves.
  Both fuzzy scans use strict best-so-far cutoffs, UTF-16 length pruning and
  reusable two-row banded distance with row-minimum termination. Parser
  misses remember their cutoff (a larger threshold rescans); `checkImg` caches
  names on its asset value. Legacy Int16 overflow above 32,767 code units
  requires an unpruned two-row compatibility path; `getDistance` is unchanged.
  Temporary Vitest dev probe, real stores and parser root live, 100k assets:
  enable flush 3,796 → 8.74 ms (current copies), `getModuleAssets` 924 → 0.196 ms,
  asset rename plus flush 3,116 → 1,459 ms (one proxy copy, then shared).
  The first parse after enabling, including the deferred plain path map, takes
  128 ms; re-enabling flushes in 3.95 ms. The 201-module cached `getModules`
  call remains cheap (0.089 → 0.102 ms; uncached baseline 2.87 ms).
  Parser 100k-name hit/miss scans 6,471/2,869 → 0.55/6.23 ms;
  `checkImg` no-prefix/common-prefix scans 3,524/8,011 → 298/19.3 ms.
  Asset edits still pay Svelte's first property-source creation cost once;
  enable/disable reuses the copies. The probe is removed; permanent tests
  belong to the separate verification follow-up.

- **3f. Chat rows** (_hard_, `ui-theming.md`; needs 0b). The chat rendering
  series' item 4: cap mounted rows or virtualize, decided only after 0b shows
  how many rows a long chat keeps mounted. Bundle the `Chats.svelte` minors:
  the per-frame `console.log("Updating Chats")`, the `checkIfAtBottom` layout
  read, the draft kept in a long-press-cancelled editor, and the decision on
  the dormant last-5 rerender. Untested paths to cover: reload pointer,
  portrait change, folded index.

  Landed 2026-10-16: the structural row diff tracks message identities/order,
  streaming state, the loaded/folded window, reload store and character/user
  props; each mounted row owns a disposable effect for its text and mount key.
  Stream chunks update only that row through `Chat.updateRow`; its display-only
  `name`/`img` fields also refresh names and image sources without remounting or
  resetting the body key. Callback identity changes do not remount rows. The streaming-id scan
  is cached separately. Image promises are reused until their source changes;
  simple character props and callbacks are captured at mount. An observer marks only
  rows beyond two viewport heights `far` for `content-visibility: auto`; changed
  content is remeasured after async markdown so empty-body sizes do not cause
  scroll jumps. Near rows stay uncontained for fixed overlays and highlights.
  After a same-chat append at the bottom, keep at least 150 rows or the visible
  rows plus a load page. Screenshots, scroll-to-message, folds and open editors
  block trimming. The tail detaches once; component disposal runs in 4 ms frame
  budgets (a first synchronous teardown took 235 ms). The at-bottom read is
  gated and precedes DOM changes; the update/unmount logs and dead last-five
  key are gone. Both message editors use a separate draft, and unfolding keeps
  the old lower window boundary. Screenshots wait for all rows' current parses,
  disable containment, then restore the previous window/scroll offset.

  Production Chrome, 2,000-message Long, 200 chunks at 20 ms: streaming frame
  p95 500 -> 16.8 ms, max 700 -> 99.9 ms; 18 long tasks / about 1,500 ms ->
  one / 91 ms (the first-second trim). Mounted rows after sending: 2,000 ->
  150; retained JS heap 228.4 -> 44.3 MB. Before the trim, explicitly loading
  all 2,000 still uses 230.7 MB (30 rows 30.3 MB, 510 rows 79.1 MB). Later
  load-more task latency fell from median 125 / max 250 ms to 58 / 78.3 ms.
  Streaming while scrolled up with 600 rows initially mounted (615 afterward)
  has frame p95 33.4 ms and no long tasks. With `CHUNK_MS=0 MAX_ROWS=600`,
  the send trims 600 -> 150 rows (43.1 MB); frame p95 is 16.7 ms at the bottom
  and 33.3 ms scrolled up (615 rows afterward), with no long tasks in either
  stream. Both harness runs pass all eight checks. The fast run's load-more
  samples still include a 233.7 ms task, so history mounting is not a bounded
  task guarantee. The harness uses 250 ms newest-row
  text checks tied to the new reply, avoiding whole-DOM text-engine scans.
  Manual Chrome checks: zero anchor drift through 400 rows; partial-edit modal
  covered the 1280 x 800 viewport; cancelled drafts stayed hidden/unsaved and
  reopened intact; an offscreen editor blocked trimming; a bottom append
  retained scrollTop 0; unfolding retained indices 70–100; a screenshot from
  a one-row window captured 40 rendered messages plus the greeting and restored
  the original window. Tests: `Chats.rows.svelte.test.ts`, `Chat.draft.test.ts`,
  `observer.markers.test.ts` (chunk isolation, remount rules, the trim and its
  guards, far marking, the editor draft, the BGM scan filter). Remaining: full history browsing can still mount all
  requested rows until a bottom append; far custom fixed/overflowing content
  remains contained, and older length-dependent CBS waits for its next render.
  Firefox/Safari behavior and permanent coverage of these observer/trim guards
  remain to be verified separately.

- **3g. Remaining whole-record transport** (_small_, `persistence.md`). The
  asset audit's A1 leftovers: presets, plugins, pluginStorage and sections
  still travel whole; whole writes (jobs, MCP, imports) publish plain refs; the
  server's `patchBases` budget counts text only; a dirty tab whole-reads on 409. Lower value than 3a to 3e; do after them, or drop if 3c's measurement
  shows the traffic is small.

  Landed 2026-10-17: all mirrored object records except `llmSecrets` and all
  arrays accepted by `itemIds` now save smaller record patches and apply eligible
  feed patches without a read. MCP character/module edits, Lua character/persona
  edits, and the runner's memory-trim edit use patch ops; ambiguous module/persona
  ids retain the whole-write fallback. `pluginStorage` opts into `shallowNormalize`;
  cloning preset/persona normalizers stay on the slow path, whose feed diff now
  compares stored text parts (reusing already parsed item ids) and parses only
  changed parts. A dirty tab's 409 reuses an exact-base waiting feed patch or an
  exact-revision deferred hydration before falling back to a whole read.
  Measurements on Node 24.21.0, uncompressed UTF-8, a one-op batch including its
  envelope: renaming one of 30 presets with 100 KB of nested prompt text each
  (3,157,851-byte record) went from 3,157,984 to 206 bytes/edit; changing a counter
  beside 2 MB of plugin storage went from 2,000,165 to 173 bytes/edit. Eligible
  observers use the 130/91-byte feed patch bodies instead of fetching those
  records. With in-memory SQLite, 5 warmups and median of 25 GC-separated edits,
  presets patch CPU went from 42.04 to 34.74 ms (wall 40.64 to 34.55 ms);
  whole-write CPU was 27.74/27.46 ms before/after. Feed-diff CPU fell from 8.58 to
  2.66 ms (wall 7.41 to 1.44 ms); the slow patch still pays for parsing the old
  record. Seven `--expose-gc` heap samples of a cut 10,017,827-unit character with
  20,000 lore entries retained about 31.0 MB in ASCII or 59.8 MB with two-byte text;
  its parsed graph alone retained 11.0/19.8 MB. The cache now charges
  `text.length * 4` (2 for text/parts, 2 for the parsed graph with headroom) against
  its existing 64 Mi-unit/four-record limit. Still whole: creates, unpatchable
  lists (`plugins`, `loreBook`, `globalscript` without unique ids), `llmSecrets`,
  patches no smaller than the record, changed top-level `__proto__`/unsupported
  serialization hooks, server `enabledModules`/`authRefreshes` writes, and job
  owners' `resource` events. Imports and other whole-write callers still publish
  plain refs; feed patches remain capped at 64 KiB. Tests:
  `resourceSyncPatches.test.ts` ("patches of the other mirrored records": the
  per-kind save and feed-apply cases, the whole-write exceptions, the malformed
  and wrong-base fallbacks, the 409 rebuild from a feed patch or a deferred
  hydration and its fallbacks), `resourcePatchParts.test.ts` ("general record
  patch writes": the `pluginStorage` fast path, the slow-path text diff and the
  feed cap, the `__proto__` omission, the cache budget), `recordPatchText.test.ts`
  (whitespace and scan fallback), `mcpInternal.test.ts` ("server writers publish
  record patches") and the memory-trim case in `memoryJobs.test.ts` (slow). Five
  stale assertions of whole payloads or a whole read were updated in
  `resourceSync`, `resourceSyncLive`, `resourceSyncPatches`, `resourceSyncSecrets`
  and `resourceSyncSections` tests.

- **3h. Asset list usability** (_small_, `characters-modules.md`). The paged
  asset lists (`ASSET_LIST_PAGE` of 100) have no name filter, so a far-down
  asset needs many Load More clicks; the paging has no tests and was never
  checked in a browser.

  **Landed 2026-10-17.** `CharConfig`, `ModuleMenu` and `AssetInput` now have
  a name search (trimmed, case-insensitive substring of `asset[0]` only),
  a localized no-match message, and pages of 100 matching source indices.
  Search resets per owner; paging resets per owner/query. Empty search skips
  the cache/scan and builds only the visible indices. Rows read and write
  the live record at their source index, retaining previews, delete,
  prebuilt-exclude and sticker selection. Matching tracks the owner, query,
  field read and length, with names read untracked: a rename cannot remove
  its row mid-edit; the next query or structural list change refreshes matches.
  `assetList.ts` caches lowercase names, shared between the character editor
  and picker by wrapper/stamp, and for modules by the shared plain field
  copy's identity. Plain create-mode modules and uncacheable lists rebuild.
  The character wrapper-only prototype took 1,219.14 ms fresh and 589.57 ms
  after a rename (cached 1.28 ms), exceeding the 300 ms rebuild threshold,
  so `characterFieldPlain` now mirrors the module accessor: detached,
  read-only-by-contract copies by live character identity and field stamp,
  reading the raw target only while the field is untouched. UI edits still
  go through the record wrappers, never the shared copies.
  A temporary stdin Node script (`pnpm exec node --conditions=browser
--input-type=module`, Node 24.21.0, Svelte 5.57.1 client/dev compilation)
  seeded one character and one module with 100,000 `[Asset N.png, path, png]`
  tuples through `initializeRecords` and timed the helper plus match scan:
  fresh query / first query after renaming row 99,999 / later cached query
  were **59.66 / 578.74 / 1.43 ms** for the character and
  **56.47 / 578.31 / 1.29 ms** for the module. Queries were `asset 9`,
  `renamed`, and `renamed target`, returning 11,111 / 1 / 1 matches.
  The first post-edit copy still pays Svelte's live property-source cost
  once; subsequent keystrokes scan only plain lowercase names. Timings
  exclude DOM rendering and the rename itself. Browser check (headless Chrome
  over the dev stack, a scratch Playwright driver, a character and a module
  seeded with 100,000 assets through the records API, previews off): all 47
  checks passed (paging, the filter and its resets per query and per owner,
  the no-match message, a rename and a delete under a filter landing on the
  right entry in the tab and on the server, the sticker pick inserting its
  name). Main-thread long tasks: the first filter keystroke one task of about
  340-400 ms (the field had just been written, so the plain copy walked the
  live state once; module 54 + 301 ms), later keystrokes none, the first
  query after a rename about 320-330 ms, the picker's keystroke none since it
  shares the character's cache. Tests: `src/ts/assetList.test.ts` (the name
  caches over real records: reuse until a write under the field, rebuild
  after one, a remote patch and a replacement, an uncacheable character and
  a plain create-mode module, 100k cached scans) and
  `src/lib/Setting/Pages/Module/ModuleMenu.assets.test.ts` (`ModuleMenu` and
  `AssetInput` mounted: paging with and without a filter, the name-only
  trimmed case-insensitive match, the query and owner resets, the no-match
  message, a rename kept visible mid-edit and a delete hitting the right
  source entry, membership changes refreshing the matches, `onSelect`
  receiving the live tuple). No stale tests.

## Phase 4: Compatibility and feature defects

Independent P2s with no shared mechanism. Group by guide, one session per
group; order within the phase is free.

- **4a. Memory correctness** (`memory.md`; after 1b, same files). GEN-03
  (standard HypaV3 keys the combined vector map by chunk text, losing the
  context-qualified vector) and GEN-04 (Hanurai's `substring(16)` against a
  17-character prefix defeats duplicate suppression).
- **4b. Token accounting** (`llm-requests.md` and `self-host-server.md`).
  GEN-02 (final trim subtracts an image's tokens but keeps the image), API-06
  (image token estimates use the wrong tile cost), API-04 (the strong-ban
  cache restores a previous request's biases and tokenizer ids).
- **4c. Dynamic models and named keys** (`llm-requests.md`). LLM-01 (dynamic
  descriptors dropped from the job contract) and LLM-02 (named NanoGPT and
  Ollama keys do not reach discovery).
- **4d. Plugins and MCP** (`plugins-mcp.md`). EXT-02 (multi-plugin reload
  skips an instance), EXT-04 (Dynamic Assets needs an unrelated regex script
  to exist), SP-I1 (an MCP callback acts on the selected chat, not its job's),
  NET-02 (`nativeFetch` rejects omitted options and HEAD).
- **4e. Media and translation** (`media-aux.md`). MEDIA-01 (DeepLX batch
  deadlock), MEDIA-02 (non-LLM cache ignores language and provider), MEDIA-03
  (VOICEVOX text not URL-encoded), MEDIA-04 (Stop TTS stops only the newest
  source), MEDIA-05 (Imagen result discarded in image-view mode).
- **4f. Browser and PWA** (`app-shell.md`, `build-test-platforms.md`). WEB-01
  (share target POST is 404), WEB-02 (a 503 on `/sw.js` blocks startup),
  WEB-03 (Hotkey settings blank below 768 px).

## Phase 5: Verification debt

The memory lists features that shipped without a real-browser pass. These are
not defects, but each is a place a defect could hide. One session with a
browser, one checklist: the request-history viewer and diagnostics panel, the
Web Push browser matrix, `LazyFileSrc` with real files (the asset lists'
paging and filters were checked on 2026-10-17 with previews off), inlay audio
and video, the service worker's MIME and Range handling (everything is served
as `image/png`), and the two load-only test flakes (`cbsLimitsHost.test.ts`
"does not yield between quick effects", `checkStopDMatrix.mjs` setup).

## Not in this plan

- Items the reports list as intentional or unconfirmed: CPU-only server
  embeddings, WebLLM summaries unsupported in jobs, the OpenAI TTS key routing,
  the grayscale-alpha PNG decode lead, the `requestTimeoutMs` helper with no
  caller, the group-bundle reroll lead, the never-settling plugin callback.
- Memory leftovers that are not performance work: the model menu tabs, memory
  trim question, deferred lore behaviors, per-chat binding, and the request
  history trade-offs (still in memory; raise when working nearby).
- Rewriting the audit probes into the repository. Each slice adds its own
  regression test; the probes stay where they are as before/after evidence.

## Index: where each item went

| Source item                                                                                        | Slice  |
| -------------------------------------------------------------------------------------------------- | ------ |
| PERF-01                                                                                            | 1a     |
| MEM-01, MEM-02                                                                                     | 1b     |
| LLM-03                                                                                             | 1c     |
| UI-01, UI-04                                                                                       | 1d     |
| GEN-01, JOB-01                                                                                     | 2a     |
| JOB-02                                                                                             | 2b     |
| UI-02, UI-03                                                                                       | 2c     |
| DATA-01, PERSIST-01                                                                                | 2d     |
| IO-01, IO-02, IO-03, IO-04                                                                         | 2e     |
| EXT-01                                                                                             | 2f     |
| PERF-02; memory: whole modules/sections per job, `setChatVar` double parse, deleted speaker lookup | 3a     |
| API-01, API-02, API-03, API-05                                                                     | 3b     |
| memory: chat-patch deferrals, `hydrations` map, no compression                                     | 3c     |
| NET-01, EXT-03; memory: `getFileSrc` URLs, inlay audio/video, translator budget                    | 3d     |
| ASSET-01; module membership revision, shared plain assets, bounded fuzzy scans (landed 2026-10-16) | 3e     |
| memory: chat rendering item 4 and `Chats.svelte` minors                                            | 3f     |
| memory: A1 leftovers (other kinds, whole writes, cache budget, 409 whole read)                     | 3g     |
| memory: asset list filter and paging tests                                                         | 3h     |
| GEN-03, GEN-04                                                                                     | 4a     |
| GEN-02, API-04, API-06                                                                             | 4b     |
| LLM-01, LLM-02                                                                                     | 4c     |
| EXT-02, EXT-04, SP-I1, NET-02                                                                      | 4d     |
| MEDIA-01 to MEDIA-05                                                                               | 4e     |
| WEB-01, WEB-02, WEB-03                                                                             | 4f     |
| e2e first-load fixtures, `checkStreamingModes`, `measureChats`                                     | 0a, 0b |
| memory: never-checked-in-browser items, load flakes                                                | 5      |

## Suggested start

Run 1a, 1b and 1c first, as three parallel worktree sessions: they touch
different files, they are the only items that can take the shared server
down, and 1a is small enough to land the same day. 2a next, alone, because it
is the only P1 data loss and `DefaultChatScreen.svelte` must not have two
writers. Phase 3 then starts with 3a and 3b in parallel; 3c to 3e follow in
any order. Phases 4 and 5 fill gaps between the others.
