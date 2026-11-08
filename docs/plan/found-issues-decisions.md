# Found Issues Decisions Plan

Status: drafted 2026-11-08 from the owner's decisions of the same day; landed: A1 (844846d9b), C1 (9deff3578), A2 (697557b4a), D2 (03f729fd4), A3 (d2f4a2596), B1 (d4b76d821), B3 (ccf6980aa), B2 (174565cde), D1 (bafa4359d), B4 (fc708d953). Source: the
eighteen entries of [found-issues](../research/found-issues.md) that asked for an owner decision, decided
one by one against the tree at `cc08b6afd` (the decision paragraph under each entry, `Decision (owner,
2026-11-08)`, is the record). Eight entries are code fixes, one is a server-side feature flag, eight move
whole into the owning guides' Known Hazards as Limitations, and one (Evaluation findings) splits into a
code fix (D1), a follow-up slice (D2) and Limitations (E1). Line numbers below are from that check,
revised after the [plan-runner audit](../plan-runner-audit/found-issues-decisions-2026-11-08.md) of the
same day; identifiers are the anchors. Re-verify each cited location before editing
(STRUCTURE.md protocol step 5).

Rules, the same as the two sweeps before it. One slice is one session, one commit, one file cluster. Each
slice names its owning guide from `STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Every
slice updates the owning guide's `Flows`, `Invariants`, or `Known Hazards` where it changes a documented
contract and removes the matching hazard entry when it fixes one. Workflow per slice: `opus-lite` for a
slice marked _small_, `opus-workflow` for one marked _hard_; routine slices name no Codex challenger. Each
slice ends with its regression test (under _Test_), `pnpm check`, `pnpm --silent test:agent` for the files
it touches and then once whole, the guide's focused checks, `pnpm format:check`, and `pnpm check:docs` for
any guide edit. A slice does not edit `found-issues.md`: the entries it closes (under _Removes_) are deleted,
with the section counts in that file's Contents list, in the landing commit that marks the slice landed
here, so parallel slices never conflict on the inbox. An entry a slice finds already fixed is removed the
same way with a note in the commit message. A Limitation a slice records carries the decision date
(STRUCTURE.md Doc Maintenance: Limitations need a recorded decision).

## Index

Every decided entry, by its heading in `found-issues.md`, with the slice that carries it.

| Section                            | Entry                                                                 | Disposition                                                 |
| ---------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| LLM requests and providers         | Anthropic streaming drops tool calls                                  | A1                                                          |
|                                    | `escape` loses to `forceStreaming`                                    | A2                                                          |
| Server jobs and prompt assembly    | An untargeted handoff offer blocks the creator's rescue               | A3                                                          |
|                                    | The push send cap comment says four waiting                           | B4                                                          |
|                                    | No-memory trim question gaps                                          | Recorded (`memory.md`): E1                                  |
| Client and plugins                 | A multi-tab plugin removal can bring its deleted data back            | B1 (with its residual-window Limitation)                    |
|                                    | Reset permissions leaves a running plugin's capabilities              | B2                                                          |
|                                    | pluginStorage.setItem changes non-JSON values without an error        | Recorded (`plugin-sandbox.md`): E1                          |
|                                    | Chat disclosure and watermark checks return constants                 | C1                                                          |
|                                    | Fallback media object URLs outlive the blob cache                     | Recorded (`assets.md`): E1                                  |
|                                    | moveRecordListItem clamps an out-of-range target                      | B4                                                          |
| Display transform                  | More than one transform chunk is in flight at a chat switch           | Recorded (`cbs-rendering.md`): E1                           |
|                                    | The pair cache evicts a pair with the same translation                | B3                                                          |
| Chat screen and input              | An adopted server copy drops an open inline editor's unsaved text     | Recorded (`chat-store.md`, narrowed): E1                    |
| Build, drivers, and e2e            | A chat-open suggestion request bumps the chat revision                | Recorded (`cbs-rendering.md`): E1                           |
| Chat store, sync, and change feeds | Parked resends leak                                                   | Recorded (`chat-store.md`): E1                              |
|                                    | Phase 6 review leftovers                                              | Recorded (`chat-store.md`): E1                              |
| Structured Memory                  | Evaluation findings (overhead constant)                               | D1                                                          |
|                                    | Evaluation findings (checkpoint save hold)                            | D2                                                          |
|                                    | Evaluation findings (`selectMemory` time, bucket cost, small-context) | Recorded (`structured-memory/read.md`, `projection.md`): E1 |

## Order

Every slice is independent of the others' code unless listed here; the shared files are guides.

- **Shared source files.** None between code slices: A1 edits `server/src/llm/anthropic.ts`, A2 the two
  `request.ts` files and `outer.ts`, A3 the server `generationJobs.ts`, B1 `pluginStorageStore.svelte.ts`
  and the v3 setter in `v3.svelte.ts`, B2 `plugins.svelte.ts` and the settings page (not `v3.svelte.ts`,
  and no new export, so not `bootMocks.ts`), B3 `translator.ts`, B4 `pushService.ts` and
  `records.svelte.ts`, C1 `server/src/app.ts`, `staticCache.ts`, `vite.config.ts`, `platform.ts`,
  `globalApi.svelte.ts`, the parser, `ChatBody.svelte` (the watermark's one caller), the three disclosure
  components and the mocks named in C1
  (`globalApiMock.ts`, `bootMocks.ts`, four `src/lib/ChatScreens/` tests), D1 `shared/structuredMemory.ts`,
  D2 `structured/writer.ts` and its commit paths, the rebuild swap in `server/src/data/memoryStore.ts`, the probe in
  `server/src/tests/fixtures/memory/structured/measure.ts` and, if the after-measurement needs it,
  `util/memoryEval.mjs`. D2 may touch the `MemoryRun` doc comment in `shared/structuredMemory.ts` (~563): D2
  after D1, or rebase.
- **Guides.** A1 and A2 both edit `llm-requests.md` (a Limitation vs a header sentence): rebase. B1, B2 and
  E1 edit `plugin-sandbox.md`; D1, D2 and E1 edit the `structured-memory/` pages: E1 runs last and rebases
  onto what landed. B1 and B4 both edit `persistence.md`, B4 and C1 `self-host-server.md`, C1 and E1
  `cbs-rendering.md`: rebase. Every guide stays under the 40,000-byte ceiling (`pnpm check:docs`);
  `persistence.md` (28.9 KB), `self-host-server.md` (28.8 KB) and `cbs-rendering.md` (28.7 KB) are the
  largest the slices touch.
- **Questions.** None: every decision is recorded in the source entries. A slice that finds its decision
  does not fit the code stops with `QUESTION` instead of choosing.
- **Sessions.** A1, A2, A3, B1, B2, B3, B4, D1 and E1 are _small_; C1 is _hard_ (server, dev server, page
  flag and client across five guides and the README) and D2 is _hard_ (durable record shape and replay). Three sessions
  at a time is the runner's default; E1 waits for every other slice.

## Slices

### A. Server and LLM

- **A1. A Claude request with tools goes buffered** (_small_, `llm-requests.md`). `server/src/llm/anthropic.ts`
  `requestClaude`: the streaming branch (~1004, `if (arg.useStreaming)`) runs an SSE parser that handles
  text, thinking, redacted thinking and error events only; `tool_use` blocks and `input_json_delta` are
  dropped, while the buffered path (~1134, `hasToolUse`) runs the tool loop. Streaming is decided in two
  places that must agree: `requestClaude` captures `arg.useStreaming` (~99) into the wire body's `stream`
  (~393), and `requestClaudeHTTP` branches on `arg.useStreaming` again (~1004); the tool follow-up sets
  `body.stream = false` but recurses with the same `arg` (~1212). Decide once, at the top of
  `requestClaude`: when `arg.tools` is non-empty the request is buffered, so `body.stream` is false and
  `requestClaudeHTTP` (the first call and every recursive tool follow-up) gets an argument whose
  `useStreaming` is false. `db.claudeBatching` (~656) bypasses `requestClaudeHTTP` and its result parser
  (~884) reads text and thinking only, so a request with tools skips batching and goes through
  `requestClaudeHTTP`. Bedrock is out of scope: its branch returns before the tool schemas are attached
  (~589, ~617), so it never offers tools. Keep the module header's description of the parser and say why
  streaming and batching are off with tools. Record a Limitation in `llm-requests.md`: Claude tool calls
  are not streamed or batched; a request that offers tools answers buffered (owner, 2026-11-08). Upstream
  has the same gap, so no tab copy changes.
  _Done_: a Claude request with MCP tools and streaming on runs its tool calls, follow-ups included, and
  streams nothing; with batching on, it is sent directly and runs its tools; one without tools streams
  (or batches) as before.
  _Test_: `server/src/tests/llmProviderAdapters.test.ts` (a tools request under `useStreaming: true` sends
  `stream: false`, takes the buffered path and calls the tool, and its follow-up is buffered too; a tools
  request under `claudeBatching` posts to the Messages URL, not `/batches`).
  _Removes_: Anthropic streaming drops tool calls.

- **A2. `escape` clears `forceStreaming`** (_small_, `llm-requests.md`). `server/src/llm/outer.ts` (~74–76)
  and `src/ts/process/request/request.ts` (~384–390) clear `useStreaming` for an escaped request, but the
  adapter argument is built with `arg.forceStreaming ? true : …` (`server/src/llm/request.ts` ~532, the tab
  file ~687), so a caller that passed both would stream unescaped text. Today no caller does: `escape` comes
  only from the runner (`server/src/prompt/runner.ts` ~1798, `escapeOutput`) and `forceStreaming` only
  from the Lua `LLM` binding (`server/src/lua/bindings.ts` ~1203). Clear `forceStreaming` beside
  `useStreaming` in both runtimes. Clearing the flags is not enough on its own: a plugin provider returns a
  stream whatever `useStreaming` says (the server adapter returns `d.stream`, `server/src/llm/request.ts`
  ~684; the tab wraps any successful `ReadableStream`, the tab file ~784), and both outer loops escape only
  a `success` answer (`outer.ts` ~114, the tab `request.ts` ~448). So when `escape` is set and an attempt
  still answers `streaming`, the outer loop reads that stream to its last snapshot (the
  `collectStreamingText` pattern of `server/src/prompt/triggers.ts` ~190) and continues with it as a
  `success`, so escaping and the after-replacers run; an abort while reading, or a stream that errors,
  ends the attempt the way a failed buffered attempt does, and a reply the tab no longer holds still
  cancels the stream as today (~442). Reword the two header sentences that describe the precedence
  (`outer.ts` ~60, the tab `request.ts` ~171). The guide invariant "`escape` disables streaming" stands.
  _Done_: a request with `escape` and `forceStreaming` both set is buffered and escaped in both runtimes,
  including a plugin provider that returns a stream anyway.
  _Test_: the server's outer-loop harness in `server/src/tests/llmCharsetRetries.test.ts` (not
  `llmServices.test.ts`, which covers redaction, Vertex tokens and the warmer) and
  `src/ts/process/request/tests/requestPresetScope.test.ts` (it drives the real `requestChatData` with a
  provider and replacer harness; `transport.test.ts` calls `requestServer` directly and bypasses the escape
  loop), its escape assertion on real escaping rather than the identity mock: an escape case with `forceStreaming: true`, and an
  escape case whose attempt answers `streaming` comes back as an escaped `success`.
  _Removes_: `escape` loses to `forceStreaming`.

- **A3. Every open offer turns absent after owner absence** (_small_, `server-generation.md`).
  `server/src/jobs/generationJobs.ts` `armOffer` (~1157–1175) returns early for any open offer that is
  not a targeted `requested` one, so an untargeted `requested` offer or the `preferred` offer opened at
  admission (~2367) outlives the owner; `reopenOffer` (~1128–1140) has the same special case, and
  `absentOfferAt` (~1117) already uses `ownerAbsentSince` for every other offer. Generalize both: once the
  owner is absent, any open offer whose reason is not `absent` becomes `absent` one offer delay after the
  absence, as `absentOfferAt` already computes for non-targeted offers (they keep no opening time:
  `openOffer` clears `requestedAt` for them, ~1102); a targeted request keeps its deadline from the later
  of `requestedAt` and the absence. The client rules (`src/ts/network/handoff.ts` `takeOffer`, ~274–287)
  and `handoff.test.ts` stay. They decide who takes an `absent` offer: `owned` is exact creator client id
  equality (`current`, ~2394), and a tab's generation identity lives in its `sessionStorage`
  (`src/ts/network/generationJobs.ts` ~208–224), so only the tab that holds the creator's identity takes it as
  its own, while another tab of the same user is a foreign worker and takes it only
  with handoff acceptance on. Update the handoff flow sentence in `server-generation.md` (~205, "an
  unclaimed targeted one turns absent") to "any open offer".
  _Done_: with `handoff: "prefer"` or an untargeted request open and no accepting worker, an owner that
  goes absent leaves an `absent` offer one offer delay after the absence, which the creator tab takes
  under its own identity, and another tab takes only with acceptance on.
  _Test_: `server/src/tests/generationJobs.test.ts` (the arming cases: preferred and untargeted offers
  turn absent one delay after owner absence; a targeted request keeps its later deadline; a reopened
  ticket follows the same rule).
  _Removes_: An untargeted handoff offer blocks the creator's rescue.

### B. Client and plugins

- **B1. Owned plugin storage refuses an uninstalled owner** (_small_, `plugin-sandbox.md` with
  `persistence.md`). `src/ts/storage/pluginStorageStore.svelte.ts` `setOwnedPluginStorageItem` (~242)
  writes for any owner name; the v3 setter (`src/ts/plugins/apiV3/v3.svelte.ts` `_setPluginStorage`,
  ~3115) goes through it. The settings page's remove button (`src/lib/Setting/Pages/PluginSettings.svelte`
  ~185–200) deletes the owner's data after this tab's unload, but another tab's deferred reload
  (`src/ts/plugins/plugins.svelte.ts` `queueDeferredCheck`, ~560) runs that plugin's `onUnload` later and
  its write comes back through the key-by-key record merge. Gate `setOwnedPluginStorageItem` on the owner
  being a current plugin name (`settings.plugins`): a write from an owner that is not installed is dropped
  (returned as refused to the v3 caller the way a JSON refusal is). `removeOwnedPluginStorageItem`,
  `clearOwnedPluginStorage` and the administrative helpers stay as they are. Record the residual window
  as a Limitation: a `setItem` that reaches the server between the deletion and the other tab's receipt of
  the plugin list change can still restore a key; the plugin data page deletes it (owner, 2026-11-08).
  _Done_: with the plugin removed from `settings.plugins`, a late `onUnload` or `setItem` write stores
  nothing; an installed plugin's writes are unchanged.
  _Test_: `src/ts/storage/tests/pluginStorageStore.test.ts` (an owner outside the plugin list),
  `src/ts/plugins/apiV3/` storage tests (the v3 setter's refusal).
  B1 does not edit `plugins.svelte.ts` or `PluginSettings.svelte` (B2 does).
  _Removes_: A multi-tab plugin removal can bring its deleted data back (the Limitation sentence goes
  into the guide in this slice, not E1).

- **B2. Reset permissions reloads the plugins** (_small_, `plugin-sandbox.md`). The reset button
  (`PluginSettings.svelte` ~150–166) awaits `resetPluginPermissions` (`v3.svelte.ts` ~827) and nothing
  else, so a running plugin keeps its `SafeDocument`, replacers and listeners until it unloads; the remove
  button (~196–200) already calls `loadPlugins()`. After the revoke, call `loadPlugins()` in this tab. In
  other tabs the reset arrives as a `resets` count change in the permission record
  (`src/ts/plugins/apiV3/permissionStore.ts` ~42–43, which today drops cached answers), reported through
  `onPermissionGrantsRemoved` (~31) as the `resetPlugins` set. The existing deferred check cannot be
  reused as it is: `queueDeferredCheck` (`src/ts/plugins/plugins.svelte.ts` ~560) is private, runs only
  when `deferredWanted` is set by the remote plugin-record listener (~530–547), and skips the reload when
  the load signature matches (~583); a reset changes none of the signature's fields (name, script,
  `allowedIPC`, `loadSignature` ~446). So B2 adds a forced reason to that machinery in `plugins.svelte.ts`:
  `plugins.svelte.ts` subscribes to `onPermissionGrantsRemoved` beside its remote record listener (at
  the first load, as `watchingRemotePlugins` does), and a non-empty `resetPlugins` that names a running
  plugin sets `deferredWanted` plus a forced flag that the chain's signature check honours once; the idle
  retries (`onPluginWorkChange`), the local-load supersession (`deferredGeneration`) and safe boot's
  cancellation stay as they are. In the resetting tab the listener fires too; the local `loadPlugins()`
  supersedes that request. B2 edits `plugins.svelte.ts`, `PluginSettings.svelte` and its tests, not
  `v3.svelte.ts` (B1 edits it) and adds no export, so `src/ts/tests/bootMocks.ts` stays. Update the
  permission bullets in `plugin-sandbox.md` (~160): a reset reloads the plugins here and defers a reload
  elsewhere.
  _Done_: after Reset permissions, the plugin's next capability use prompts again in this tab at once and
  in another tab after its deferred reload, although the plugin's signature did not change; no grant
  survives.
  _Test_: `src/ts/plugins/apiV3/permissionRevocation.test.ts` or the `plugins.svelte.ts` reload tests (a
  reload follows the reset; a remote `resets` bump for a running plugin reloads it at the next idle point
  with an unchanged signature; a bump for a plugin not running reloads nothing); no unit test covers the
  settings page's remove flow today.
  _Removes_: Reset permissions leaves a running plugin's capabilities.

- **B3. The pair cache keeps a pair that shares a translation** (_small_, `translation.md`).
  `src/ts/translator/translator.ts` `writeMemoryCache` (~81–99) drops an existing pair whose translation
  equals the new one (`memoryCacheByTrans`), so two sources with one translation evict each other and
  the next render requests one again; the by-translation map serves the input translation's reverse
  lookup (`translateShared`'s `reverse`, ~229, ~258), which can only return one origin anyway. Keep the
  older pair's by-origin entry and its byte accounting, and re-point only the by-translation slot to the
  newest pair (`dropMemoryCacheEntry`, ~70–79, already deletes a map entry only when it points at the
  entry being dropped). Reword the function's comment ("each side maps to one pair" becomes "each
  translation maps to its newest pair") and the memory-cache sentence of `translation.md` if it repeats it.
  _Done_: two paragraphs that translate to the same text both hit the cache on the next render; the
  reverse lookup of that text returns the newest origin, as before.
  _Test_: `src/ts/translator/translatorMemoryCache.test.ts`.
  _Removes_: The pair cache evicts a pair with the same translation.

- **B4. Two contracts follow their comments** (_small_, `self-host-server.md` and `persistence.md`).
  `server/src/push/pushService.ts` (~34): the `MAX_PENDING_SENDS` comment says "completions waiting
  behind the one being delivered", but `send` (~632–642) counts the delivery in flight, so the bound is
  four outstanding in total, as the module header says; reword the constant's comment, no code change.
  `src/ts/storage/records.svelte.ts` `moveRecordListItem` (~3000–3009): the doc comment promises
  "out-of-range indexes change nothing" but only `from` is checked and `to` is clamped (~3006); return
  without a change when `to` is outside `[0, length - 1]`. Its one caller
  (`src/lib/Setting/botpreset.svelte` `movePreset`, ~187–196) range-checks first, so nothing observable
  changes there.
  _Done_: `moveRecordListItem(list, 0, -1)` and `(list, 0, list.length + 5)` leave the list and its record
  untouched; the push constant's comment matches `send`.
  _Test_: `src/ts/storage/tests/records.test.ts` (two out-of-range cases for `moveRecordListItem`);
  `server/src/tests/push.test.ts` unchanged.
  _Removes_: The push send cap comment says four waiting; moveRecordListItem clamps an out-of-range
  target.

### C. Disclosure flag

- **C1. The AI disclosure is opt-in through `RISU_AI_DISCLOSURE`** (_hard_, `self-host-server.md` with
  `global-api.md`, `app-shell.md`, `build-test-platforms.md` and `cbs-rendering.md`). Today
  `src/ts/globalApi.svelte.ts` `aiLawApplies` (~1461) returns true and `aiWatermarkingLawApplies` (~1470)
  false, with an unread `countriesWithAiLaw` set above them (~1399–1458); upstream has the same code. The
  three readers of `aiLawApplies` are the empty-chat warning (`DefaultChatScreen.svelte` ~1751), the
  request-info disclaimer (`AlertComp.svelte` ~581) and the per-message model button (`Chat.svelte`
  ~1263, which the setting `requestInfoInsideChat` therefore cannot hide). The parser's
  `addMetadataToElement` (`src/ts/parser/parser.svelte.ts` ~1308) never runs its watermark. Design:
  1. `server/src/app.ts` reads `RISU_AI_DISCLOSURE` the way it reads `RISU_ASSET_GRACE_DAYS` (~295,
     `parseAssetGraceDays` ~1262): `1` or `true` turns it on, anything else or unset is off; the value is
     part of the server context and reaches `serveIndex` (~865).
  2. `server/src/http/staticCache.ts` `serveCachedIndex` (~238–253) injects the flag beside `__NODE__`
     (one script: `globalThis.__NODE__ = true; globalThis.__RISU_AI_DISCLOSURE__ = <bool>`), and the
     index's ETag takes the flag beside the file's stat, so a browser holding the page revalidates when the
     operator changes the variable. The ETag alone does not do it: `setCacheHeaders` (~32–52) answers an
     `If-Modified-Since`-only request from the file mtime, which a flag change leaves as it is. So the
     index is revalidated by ETag only: `serveCachedIndex` sends no `Last-Modified` and ignores
     `If-Modified-Since` (a request without `If-None-Match` gets the page), while the other static files
     keep `setCacheHeaders` as it is. The index case in `server/src/tests/app.test.ts` (~354, which pins a
     304 for `If-Modified-Since`) changes with it.
  3. `vite.config.ts`'s `risu-node-flag` plugin (~55–65) injects the same script from `process.env` for
     the dev server.
  4. `src/ts/platform.ts` exports the flag next to `isNodeServer`; `aiLawApplies` returns it and loses its
     TODO. `aiWatermarkingLawApplies`, `addMetadataToElement`, `encodeMetadata` and `countriesWithAiLaw`
     are deleted with their callers' branches (`src/lib/ChatScreens/ChatBody.svelte` ~28, ~567, ~573: drop
     the import and both wrappers, keeping the sanitization and `pruneEmptyBilingualPairs`);
     `src/ts/tests/globalApiMock.ts` (~63–64), the typed parser
     double in `src/ts/tests/bootMocks.ts` (~176) and the renderer test mocks that name
     `addMetadataToElement` (`ChatBody.svelte.test.ts`, `ChatBody.assets.svelte.test.ts`, `Chat.test.ts`,
     `Chat.draft.test.ts` under `src/lib/ChatScreens/`) follow.
  5. Docs: the environment list in `self-host-server.md` (~37) and the README's run section gain the
     variable; `global-api.md`'s Issue (~138) becomes a Limitation ("the disclosure is off unless the
     operator sets `RISU_AI_DISCLOSURE`; upstream shows it unconditionally", owner, 2026-11-08);
     `app-shell.md` names the second flag beside `__NODE__`; `cbs-rendering.md` drops the watermark
     mention if it has one.
     _Done_: with the variable unset, no empty-chat warning or disclaimer shows and the model button follows
     `requestInfoInsideChat`; with `RISU_AI_DISCLOSURE=1`, all three show; the index page's ETag differs
     between the two settings; the dev server behaves the same from the shell's environment.
     _Test_: `server/src/tests/app.test.ts` (the injected script and the ETag under both settings; a 304
     for the old ETag only when the flag is unchanged; an `If-Modified-Since`-only request for the index
     gets 200 with the current flag; the other static files' `If-Modified-Since` 304 is unchanged); a
     `globalApi` unit test for `aiLawApplies` reading the page flag. Only
     `DefaultChatScreen.drafts.test.ts` mounts the real screen today and no test mounts the disclaimer, so
     the three sites are the browser check below.
     _Removes_: Chat disclosure and watermark checks return constants.

### D. Structured Memory

- **D1. The call overhead constant is 3,000** (_small_, `structured-memory/rebuild.md`).
  `shared/structuredMemory.ts` `MEMORY_CALL_OVERHEAD_TOKENS` (~763) feeds only cost estimation
  (`memoryCostTokens`, ~816), which the rebuild, record-now and backfill previews share
  (`server/src/prompt/memory/structured/rebuild.ts` ~371, ~405); the 2026-11-03 fixtures measured 2,100 tokens of overhead per call in
  English and 2,800–3,700 in Korean ([audit](../audit/structured-memory-2026-11-03.md)). Set it to 3,000,
  keep the three-bytes-a-token rule, update the constant's comment with the measurement, and replace the
  "no measurement" sentence in `rebuild.md` (~218).
  _Done_: every cost preview (rebuild, record now, backfill) counts 3,000 tokens per call.
  _Test_: a numeric assertion that guards the constant: `memoryCostTokens` (or one preview route) over a
  known window count gives 3,000 tokens per call plus the text estimate. The existing assertions do not
  guard it (`server/src/tests/structuredMemoryRoutes.test.ts` ~2324 accepts any positive integer, and
  `src/ts/process/structuredMemory.test.ts` ~908 round-trips a mocked `4000`), so they stay as they are.
  _Removes_: the overhead bullet of Evaluation findings.

- **D2. Runs keep their prompt only while a retry can use it** (_hard_, `structured-memory/lifecycle.md`
  with `writer.md` and `records.md`). A `MemoryRun` (`shared/structuredMemory.ts` ~551–590) stores the
  analysis prompt (`input`) and the patch prompt (`patchInput`) so a failed window is retried with the same
  call; nothing prunes them, and a checkpoint save stringifies and hashes every record synchronously
  ([audit](../audit/structured-memory-2026-11-03.md#checkpoint-save): 494 ms for 2,000 runs, 64 of the
  79 MB being inputs; `lifecycle.md` Limitations ~284–287). Readers of the two fields:
  - `replayedInput` (`server/src/prompt/memory/structured/writer.ts` ~325–345) replays `input` only, from
    the newest run whose result is not `recorded` across the whole history (`findLast`, ~331); patch
    prompts are rebuilt, never replayed.
  - The test run's `testResult` (`server/src/prompt/memory/structured/testRun.ts` ~166) reports
    `patchCalled` from `patchInput` of the closing run its dry-run commit captures (~238), the same
    `MemoryChanges` the writer builds (`writer.ts` ~848).
  - The Log route strips `input` but keeps `patchInput` (`StructuredMemoryLogRun`, ~1057;
    `server/src/routes/structuredMemory.ts` ~665), and the JSON Log export serializes it
    (`src/ts/process/structuredMemory.svelte.ts` ~1505).

  Checkpoints and database snapshots keep run JSON and accept the fields as optional on restore; chat
  files, memory packages and inheritance exclude runs (the audit traced these; re-confirm before
  editing). Policy, from the decision, as corrected after the second
  [audit](../plan-runner-audit/found-issues-decisions-2026-11-08-2.md) (G1, owner, 2026-11-08): the replay
  target stays what `replayedInput` reads today, the newest run whose result is not `recorded` (a
  `pending` run included), but pruning keeps prompts against the settled outcome. A run keeps `input` and
  `patchInput` only while it is the newest settled run (result neither `recorded` nor `pending`) whose
  result is not `recorded`, or while it is itself `pending`; at most two runs hold them. So for failed F
  then pending P, F keeps its input while P is open, and when P records, F, again the newest unrecorded
  run, can still replay. The prune happens at the durable commit boundaries that settle a run (the live
  and the staged commit paths: failure, interruption and recorded writes, `writer.ts` ~554, ~755, ~949);
  the opening commit (~523) strips nothing from older runs. It is not done in the `MemoryChanges` the
  writer builds, so the test run's dry-run commit still sees `patchInput` and reports `patchCalled`
  correctly. Each settling commit writes the run it ends without the fields when that run does not keep
  them by the rule above, and strips them from every older run that still holds them and does not keep
  them, in the same commit. The rebuild's final swap, which appends staged runs into the live history on
  its own (`server/src/data/memoryStore.ts` ~1136), applies the same rule to the history it produces.
  Existing chats shrink at their next settling commit; no migration. The Log export of an older run loses
  its patch prompt: say so in the Log's description in `records.md`. Rewrite the lifecycle Limitation
  (only the replay target holds a prompt), the run description in `writer.md` and the field comments in
  `records.md`. The audit's second proposal (one JSON encoding less) stays out: a checkpoint format
  change.
  Measurement: the audit's probe (`writeSyntheticRuns`,
  `server/src/tests/fixtures/memory/structured/measure.ts` ~203, run by `util/memoryEval.mjs` ~722) writes
  its 2,000 prompt-bearing runs straight into the store and never runs the writer, so a writer-only change
  leaves its numbers as they are. The after-measurement first runs one production commit (a recording
  through the writer) over the seeded rows, then times the checkpoint save and reports the prompt bytes
  left beside the timing; the probe change is D2's. Record both numbers before and after in the commit
  message.
  _Done_: a failed window still replays its exact input, also after a newer run opened and recorded in
  between; after the next settling commit no run but the newest settled unrecorded one and a pending one
  holds `input` or `patchInput`; a test run still reports `patchCalled`; the 2,000-run save hold drops
  with the bytes.
  _Test_: `server/src/tests/memoryJobs.test.ts` (replay after a failure; after a recording, only the
  newest unrecorded run keeps its fields; a failed run that a newer failed run supersedes loses them), the
  replay harness in `server/src/tests/memoryTasks.test.ts` (~5197: failure, then a pending run, then its
  recording, with a restart or an interruption between, and the failed run still replays its input), a
  rebuild swap case, the test-run case that asserts `patchCalled: true` after a patch, and the checkpoint
  tests that restore memory records.
  _Removes_: the checkpoint-hold bullet of Evaluation findings.

### E. Inbox and guides

- **E1. Recorded items leave the inbox** (_small_, wide; the guides named below). For each Recorded item in
  the Index, add the Limitation sentence with its decision date to the named guide's Known Hazards,
  keeping each guide under its ceiling (E1 does not edit `found-issues.md` either; its landing commit
  deletes the entries, as the Rules say): the inline editor entry narrows into
  `chat-store.md`'s later-accepted-text-wins Limitation (an open inline editor keeps its draft across a
  remote text change and its Save replaces the other device's text without a notice); pluginStorage's JSON
  conversion into `plugin-sandbox.md` beside the local-plugin refusal; the suggestion write's re-render and
  the chunks crossing a chat switch into `cbs-rendering.md`'s transform cache hazards; the fallback media
  URLs into `assets.md`; parked resends and the two Phase 6 refresh costs into `chat-store.md`; the trim
  question's late cleanup and English error into `memory.md`, with the plugin gap narrowed to raw record
  writes; and the `selectMemory` time (520–584 ms on 1,000 turns), the `getChatFromIndex` bucket cost and
  the 16k/32k lane findings into the `structured-memory/` page that owns each path (`read.md` for the
  first and third, `projection.md` for the second). The Evaluation findings entry goes once D1 and D2 have
  taken their bullets; if E1 lands before D2, narrow it to the checkpoint bullet instead.
  B1's residual-window Limitation is B1's, not E1's.
  _Done_: every Recorded item is in its guide with its date; after E1's landing commit the eighteen
  decided entries are gone from `found-issues.md` and the Contents counts match; `pnpm check:docs` passes.
  _Test_: `pnpm check:docs`.
  _Removes_: the eight Recorded entries and the remaining Evaluation findings bullets.

## Verification

- Per slice: the `_Test_` files, `pnpm check`, `pnpm --silent test:agent` (whole, once, after the last
  edit), `pnpm format:check`, the owning guide's focused checks, and `pnpm check:docs` for any guide edit.
- Browser checks, recorded in the slice's commit message: C1 (a served page with and without the
  variable, the three disclosure sites, a reload after changing the variable gets the new page); A3
  optionally through `util/playwright/checkJobHandoff.mjs` with a `prefer` send.
- Measurement, recorded in the commit message: D2 (the checkpoint save hold and the prompt bytes left on
  the audit's 2,000-run fixture, before and after, the after-run going through one production commit
  first).
