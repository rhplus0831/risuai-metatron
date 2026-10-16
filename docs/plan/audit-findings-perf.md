# Audit Findings and Performance Leftovers Plan

Status: slices 1a (PERF-01) and 1b (MEM-01, MEM-02) landed on 2026-10-15, 1c (LLM-03), 1d (UI-01, UI-04), 2a (GEN-01, JOB-01), 2b (JOB-02), 2c (UI-02, UI-03), 2d (DATA-01, PERSIST-01), 2e (IO-01 to IO-04), 2f (EXT-01), 3a (PERF-02, the read half and the coalesced setter writes), 3b (API-01, API-02, API-03, API-05) 3c (sync traffic during generation, compression deferred) and 3d (tab retention, inlay media deferred) on 2026-10-16; the rest is planned. Five phases, each a list of slices. One
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
  Phase 6 and asset-audit leftovers. `getModules` in
  `src/ts/process/modules.ts:446` caches wrappers by the joined enabled-id
  list, so a remote `modules` replacement serves a disabled module through a
  positional wrapper or throws `DetachedWrapperError`; `checkImg` already
  side-steps it with `getModulesUncached`. Memory adds: enabling a 100k-asset
  module runs a synchronous ~1.2 s chat GUI reload inside the `moduleUpdate`
  effect; the fuzzy prefix scan runs Levenshtein over every asset per
  unresolved image; `fuzzyIndexOf` has no parser-level tests. Key the cache by
  a module-record revision and invalidate on every whole-record and item
  replacement, then move the reload off the effect, then bound the fuzzy
  scan.
- **3f. Chat rows** (_hard_, `ui-theming.md`; needs 0b). The chat rendering
  series' item 4: cap mounted rows or virtualize, decided only after 0b shows
  how many rows a long chat keeps mounted. Bundle the `Chats.svelte` minors:
  the per-frame `console.log("Updating Chats")`, the `checkIfAtBottom` layout
  read, the draft kept in a long-press-cancelled editor, and the decision on
  the dormant last-5 rerender. Untested paths to cover: reload pointer,
  portrait change, folded index.
- **3g. Remaining whole-record transport** (_small_, `persistence.md`). The
  asset audit's A1 leftovers: presets, plugins, pluginStorage and sections
  still travel whole; whole writes (jobs, MCP, imports) publish plain refs; the
  server's `patchBases` budget counts text only; a dirty tab whole-reads on 409. Lower value than 3a to 3e; do after them, or drop if 3c's measurement
  shows the traffic is small.
- **3h. Asset list usability** (_small_, `characters-modules.md`). The paged
  asset lists (`ASSET_LIST_PAGE` of 100) have no name filter, so a far-down
  asset needs many Load More clicks; the paging has no tests and was never
  checked in a browser.

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
Web Push browser matrix, the paged asset lists and `LazyFileSrc`, inlay audio
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

| Source item                                                                                          | Slice  |
| ---------------------------------------------------------------------------------------------------- | ------ |
| PERF-01                                                                                              | 1a     |
| MEM-01, MEM-02                                                                                       | 1b     |
| LLM-03                                                                                               | 1c     |
| UI-01, UI-04                                                                                         | 1d     |
| GEN-01, JOB-01                                                                                       | 2a     |
| JOB-02                                                                                               | 2b     |
| UI-02, UI-03                                                                                         | 2c     |
| DATA-01, PERSIST-01                                                                                  | 2d     |
| IO-01, IO-02, IO-03, IO-04                                                                           | 2e     |
| EXT-01                                                                                               | 2f     |
| PERF-02; memory: whole modules/sections per job, `setChatVar` double parse, deleted speaker lookup   | 3a     |
| API-01, API-02, API-03, API-05                                                                       | 3b     |
| memory: chat-patch deferrals, `hydrations` map, no compression                                       | 3c     |
| NET-01, EXT-03; memory: `getFileSrc` URLs, inlay audio/video, translator budget                      | 3d     |
| ASSET-01; memory: `getModules` stale cache, 1.2 s reload in effect, fuzzy scan, `fuzzyIndexOf` tests | 3e     |
| memory: chat rendering item 4 and `Chats.svelte` minors                                              | 3f     |
| memory: A1 leftovers (other kinds, whole writes, cache budget, 409 whole read)                       | 3g     |
| memory: asset list filter and paging tests                                                           | 3h     |
| GEN-03, GEN-04                                                                                       | 4a     |
| GEN-02, API-04, API-06                                                                               | 4b     |
| LLM-01, LLM-02                                                                                       | 4c     |
| EXT-02, EXT-04, SP-I1, NET-02                                                                        | 4d     |
| MEDIA-01 to MEDIA-05                                                                                 | 4e     |
| WEB-01, WEB-02, WEB-03                                                                               | 4f     |
| e2e first-load fixtures, `checkStreamingModes`, `measureChats`                                       | 0a, 0b |
| memory: never-checked-in-browser items, load flakes                                                  | 5      |

## Suggested start

Run 1a, 1b and 1c first, as three parallel worktree sessions: they touch
different files, they are the only items that can take the shared server
down, and 1a is small enough to land the same day. 2a next, alone, because it
is the only P1 data loss and `DefaultChatScreen.svelte` must not have two
writers. Phase 3 then starts with 3a and 3b in parallel; 3c to 3e follow in
any order. Phases 4 and 5 fill gaps between the others.
