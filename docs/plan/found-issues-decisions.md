# Found Issues Decisions Plan

Status: drafted 2026-11-08 from the owner's decisions of the same day; no slice landed. Source: the
eighteen entries of [found-issues](../research/found-issues.md) that asked for an owner decision, decided
one by one against the tree at `cc08b6afd` (the decision paragraph under each entry, `Decision (owner,
2026-11-08)`, is the record). Nine decisions are code fixes, one is a server-side feature flag, one is a
follow-up slice, and seven move into the owning guides' Known Hazards as Limitations. Line numbers below
are from that check; identifiers are the anchors. Re-verify each cited location before editing
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

| Section                            | Entry                                                                 | Disposition                                |
| ---------------------------------- | --------------------------------------------------------------------- | ------------------------------------------ |
| LLM requests and providers         | Anthropic streaming drops tool calls                                  | A1                                         |
|                                    | `escape` loses to `forceStreaming`                                    | A2                                         |
| Server jobs and prompt assembly    | An untargeted handoff offer blocks the creator's rescue               | A3                                         |
|                                    | The push send cap comment says four waiting                           | B4                                         |
|                                    | No-memory trim question gaps                                          | Recorded (`memory.md`): E1                 |
| Client and plugins                 | A multi-tab plugin removal can bring its deleted data back            | B1 (the residual window: E1)               |
|                                    | Reset permissions leaves a running plugin's capabilities              | B2                                         |
|                                    | pluginStorage.setItem changes non-JSON values without an error        | Recorded (`plugin-sandbox.md`): E1         |
|                                    | Chat disclosure and watermark checks return constants                 | C1                                         |
|                                    | Fallback media object URLs outlive the blob cache                     | Recorded (`assets.md`): E1                 |
|                                    | moveRecordListItem clamps an out-of-range target                      | B4                                         |
| Display transform                  | More than one transform chunk is in flight at a chat switch           | Recorded (`cbs-rendering.md`): E1          |
|                                    | The pair cache evicts a pair with the same translation                | B3                                         |
| Chat screen and input              | An adopted server copy drops an open inline editor's unsaved text     | Recorded (`chat-store.md`, narrowed): E1   |
| Build, drivers, and e2e            | A chat-open suggestion request bumps the chat revision                | Recorded (`cbs-rendering.md`): E1          |
| Chat store, sync, and change feeds | Parked resends leak                                                   | Recorded (`chat-store.md`): E1             |
|                                    | Phase 6 review leftovers                                              | Recorded (`chat-store.md`): E1             |
| Structured Memory                  | Evaluation findings (overhead constant)                               | D1                                         |
|                                    | Evaluation findings (checkpoint save hold)                            | D2                                         |
|                                    | Evaluation findings (`selectMemory` time, bucket cost, small-context) | Recorded (`structured-memory/read.md`): E1 |

## Order

Every slice is independent of the others' code unless listed here; the shared files are guides.

- **Shared source files.** None between code slices: A1 edits `server/src/llm/anthropic.ts`, A2 the two
  `request.ts` files and `outer.ts`, A3 `generationJobs.ts`, B1 `pluginStorageStore.svelte.ts`, B2 the
  settings page and the permission store, B3 `translator.ts`, B4 `pushService.ts` and
  `records.svelte.ts`, C1 the static index path and `globalApi.svelte.ts`, D1 `shared/structuredMemory.ts`,
  D2 `structured/writer.ts`. D2 may touch the `MemoryRun` doc comment in `shared/structuredMemory.ts`
  (~563): D2 after D1, or rebase.
- **Guides.** A1 and A2 both edit `llm-requests.md` (a Limitation vs a header sentence): rebase. B1, B2 and
  E1 edit `plugin-sandbox.md`; D1, D2 and E1 edit the `structured-memory/` pages: E1 runs last and rebases
  onto what landed. Every guide stays under its byte budget (`pnpm check:docs`); `cbs-rendering.md`
  (28.7 KB) and `llm-requests.md` (26.6 KB) have the least room.
- **Questions.** None: every decision is recorded in the source entries. A slice that finds its decision
  does not fit the code stops with `QUESTION` instead of choosing.
- **Sessions.** A1, A2, A3, B1, B2, B3, B4, D1 and E1 are _small_; C1 is _hard_ (server, dev server, page
  flag and client across four guides) and D2 is _hard_ (durable record shape and replay). Three sessions
  at a time is the runner's default; E1 waits for every other slice.

## Slices

### A. Server and LLM

- **A1. A Claude request with tools goes buffered** (_small_, `llm-requests.md`). `server/src/llm/anthropic.ts`
  `requestClaude`: the streaming branch (~1004, `if (arg.useStreaming)`) runs an SSE parser that handles
  text, thinking, redacted thinking and error events only; `tool_use` blocks and `input_json_delta` are
  dropped, while the buffered path (~1134, `hasToolUse`) runs the tool loop. Decide streaming after the
  tool schemas are attached (~617): when `arg.tools` is non-empty, take the buffered path for that
  request. Keep the module header's description of the parser and say why streaming is off with tools.
  Record a Limitation in `llm-requests.md`: Claude tool calls are not streamed; a request that offers tools
  answers buffered (owner, 2026-11-08). Upstream has the same gap, so no tab copy changes.
  _Done_: a Claude request with MCP tools and streaming on runs its tool calls and streams nothing; one
  without tools streams as before.
  _Test_: `server/src/tests/llmProviderAdapters.test.ts` (a tools request under `useStreaming: true` takes
  the buffered path and calls the tool).
  _Removes_: Anthropic streaming drops tool calls.

- **A2. `escape` clears `forceStreaming`** (_small_, `llm-requests.md`). `server/src/llm/outer.ts` (~74–76)
  and `src/ts/process/request/request.ts` (~384–390) clear `useStreaming` for an escaped request, but the
  adapter argument is built with `arg.forceStreaming ? true : …` (`server/src/llm/request.ts` ~532, the tab
  file ~687), so a caller that passed both would stream unescaped text. Today no caller does: `escape` comes
  only from the runner (`server/src/prompt/runner.ts` ~1798, `escapeOutput`) and `forceStreaming` only
  from the Lua `LLM` binding (`server/src/lua/bindings.ts` ~1203). Clear `forceStreaming` beside
  `useStreaming` in both runtimes and reword the two header sentences that describe the precedence
  (`outer.ts` ~60, the tab `request.ts` ~171). The guide invariant "`escape` disables streaming" stands.
  _Done_: a request with `escape` and `forceStreaming` both set is buffered and escaped in both runtimes.
  _Test_: `server/src/tests/llmServices.test.ts` and `src/ts/process/request/tests/transport.test.ts` (the
  escape cases gain the `forceStreaming: true` variant).
  _Removes_: `escape` loses to `forceStreaming`.

- **A3. Every open offer turns absent after owner absence** (_small_, `server-generation.md`).
  `server/src/jobs/generationJobs.ts` `armOffer` (~1157–1175) returns early for any open offer that is
  not a targeted `requested` one, so an untargeted `requested` offer or the `preferred` offer opened at
  admission (~2367) outlives the owner; `reopenOffer` (~1128–1140) has the same special case, and
  `absentOfferAt` (~1117) already uses `ownerAbsentSince` for every other offer. Generalize both: once the
  owner is absent, any open offer whose reason is not `absent` becomes `absent` one offer delay after the
  later of its opening (targeted requests keep `requestedAt`) and the absence. The client rules
  (`src/ts/network/handoff.ts` `takeOffer`, ~274–287) and `handoff.test.ts` stay: the creator's other tabs
  take the job through the `absent` offer as they do for targeted requests. Update the handoff flow
  sentence in `server-generation.md` (~205, "an unclaimed targeted one turns absent") to "any open offer".
  _Done_: with `handoff: "prefer"` or an untargeted request open and no accepting worker, an owner that
  goes absent leaves an `absent` offer after the delay, which the creator's other tab takes.
  _Test_: `server/src/tests/generationJobs.test.ts` (the arming cases: preferred and untargeted offers
  under absence; a targeted request keeps its later deadline).
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
  _Removes_: A multi-tab plugin removal can bring its deleted data back (the Limitation sentence goes
  into the guide in this slice, not E1).

- **B2. Reset permissions reloads the plugins** (_small_, `plugin-sandbox.md`). The reset button
  (`PluginSettings.svelte` ~150–166) awaits `resetPluginPermissions` (`v3.svelte.ts` ~827) and nothing
  else, so a running plugin keeps its `SafeDocument`, replacers and listeners until it unloads; the remove
  button (~196–200) already calls `loadPlugins()`. After the revoke, call `loadPlugins()` in this tab. In
  other tabs the reset arrives as a `resets` count change in the permission record
  (`src/ts/plugins/apiV3/permissionStore.ts` ~42–43, which today drops cached answers): queue a deferred
  reload there (`queueDeferredCheck` or the reload guard `plugins.svelte.ts` exposes), so the plugin
  restarts at the tab's next idle point. Update the permission bullets in `plugin-sandbox.md` (~160): a
  reset reloads the plugins here and defers a reload elsewhere.
  _Done_: after Reset permissions, the plugin's next capability use prompts again in this tab at once and
  in another tab after its deferred reload; no grant survives.
  _Test_: `src/ts/plugins/apiV3/permissionRevocation.test.ts` (a reload follows the reset; a remote
  `resets` bump queues the deferred reload), with the settings-page test that covers the remove flow.
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
     (one script: `globalThis.__NODE__ = true; globalThis.__RISU_AI_DISCLOSURE__ = <bool>`), and
     `setCacheHeaders` (~32–46) takes the flag into the ETag it builds from the file's stat, so a browser
     holding the page revalidates when the operator changes the variable.
  3. `vite.config.ts`'s `risu-node-flag` plugin (~55–65) injects the same script from `process.env` for
     the dev server.
  4. `src/ts/platform.ts` exports the flag next to `isNodeServer`; `aiLawApplies` returns it and loses its
     TODO. `aiWatermarkingLawApplies`, `addMetadataToElement`, `encodeMetadata` and `countriesWithAiLaw`
     are deleted with their callers' branches; `src/ts/tests/globalApiMock.ts` (~63–64) follows.
  5. Docs: the environment list in `self-host-server.md` (~37) and the README's run section gain the
     variable; `global-api.md`'s Issue (~138) becomes a Limitation ("the disclosure is off unless the
     operator sets `RISU_AI_DISCLOSURE`; upstream shows it unconditionally", owner, 2026-11-08);
     `app-shell.md` names the second flag beside `__NODE__`; `cbs-rendering.md` drops the watermark
     mention if it has one.
     _Done_: with the variable unset, no empty-chat warning or disclaimer shows and the model button follows
     `requestInfoInsideChat`; with `RISU_AI_DISCLOSURE=1`, all three show; the index page's ETag differs
     between the two settings; the dev server behaves the same from the shell's environment.
     _Test_: `server/src/tests/app.test.ts` (the injected script and the ETag under both settings, a 304 only
     when the flag is unchanged); a `globalApi` unit test for `aiLawApplies` reading the page flag. No test
     mounts `DefaultChatScreen` or the disclaimer today, so the three sites are the browser check below.
     _Removes_: Chat disclosure and watermark checks return constants.

### D. Structured Memory

- **D1. The call overhead constant is 3,000** (_small_, `structured-memory/rebuild.md`).
  `shared/structuredMemory.ts` `MEMORY_CALL_OVERHEAD_TOKENS` (~763) feeds only the rebuild cost preview
  (`memoryCostTokens`, ~816); the 2026-11-03 fixtures measured 2,100 tokens of overhead per call in
  English and 2,800–3,700 in Korean ([audit](../audit/structured-memory-2026-11-03.md)). Set it to 3,000,
  keep the three-bytes-a-token rule, update the constant's comment with the measurement, and replace the
  "no measurement" sentence in `rebuild.md` (~218).
  _Done_: the preview of a rebuild counts 3,000 tokens per call.
  _Test_: the estimate assertions in `server/src/tests/structuredMemoryRoutes.test.ts` and
  `src/ts/process/structuredMemory.test.ts`.
  _Removes_: the overhead bullet of Evaluation findings.

- **D2. Runs keep their prompt only while a retry can use it** (_hard_, `structured-memory/lifecycle.md`
  with `writer.md` and `records.md`). A `MemoryRun` (`shared/structuredMemory.ts` ~551–590) stores the
  analysis prompt (`input`) and the patch prompt (`patchInput`) so a failed window is retried with the same
  call; nothing prunes them, and a checkpoint save stringifies and hashes every record synchronously
  ([audit](../audit/structured-memory-2026-11-03.md#checkpoint-save): 494 ms for 2,000 runs, 64 of the
  79 MB being inputs; `lifecycle.md` Limitations ~284–287). The only reader is `replayedInput`
  (`server/src/prompt/memory/structured/writer.ts` ~325–345), which reads the newest run whose result is
  not `recorded`; the Log route already strips `input` (`StructuredMemoryLogRun`, ~1057); exported chat
  JSON never carries runs. First trace the whole-row paths the audit did not (checkpoint snapshot and
  restore, the memory package import and export, chat copies) and confirm none reads the two fields.
  Then: a run that ends `recorded` is written without `input` and `patchInput`; when a new run is written,
  every older run still holding them loses them unless it is the newest unrecorded one (the replay
  target). Existing chats shrink at their next recording; no migration. Re-measure the save with the
  audit's probe and record the number in the commit message. Rewrite the lifecycle Limitation (runs hold a
  prompt only until the next recording), the run description in `writer.md` and the field comments in
  `records.md`. The audit's second proposal (one JSON encoding less) stays out: a checkpoint format change.
  _Done_: a failed window still replays its exact input; after the next recording no run but the newest
  unrecorded one holds `input` or `patchInput`; the 2,000-run save hold drops with the bytes.
  _Test_: `server/src/tests/memoryJobs.test.ts` (replay after a failure; the strip after a recording; a
  failed run older than a later recording loses its input), the checkpoint tests that restore memory
  records.
  _Removes_: the checkpoint-hold bullet of Evaluation findings.

### E. Inbox and guides

- **E1. Recorded items leave the inbox** (_small_, wide; the guides named below). For each Recorded item in
  the Index, add the Limitation sentence with its decision date to the named guide's Known Hazards and
  delete the entry, keeping each guide under its ceiling: the inline editor entry narrows into
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
  _Done_: every Recorded item is in its guide with its date; the eighteen decided entries are gone from
  `found-issues.md` and the Contents counts match; `pnpm check:docs` passes.
  _Test_: `pnpm check:docs`.
  _Removes_: the seven Recorded entries and the remaining Evaluation findings bullets.

## Verification

- Per slice: the `_Test_` files, `pnpm check`, `pnpm --silent test:agent` (whole, once, after the last
  edit), `pnpm format:check`, the owning guide's focused checks, and `pnpm check:docs` for any guide edit.
- Browser checks, recorded in the slice's commit message: C1 (a served page with and without the
  variable, the three disclosure sites, a reload after changing the variable gets the new page); A3
  optionally through `util/playwright/checkJobHandoff.mjs` with a `prefer` send.
- Measurement, recorded in the commit message: D2 (the checkpoint save hold on the audit's 2,000-run
  fixture before and after).
