# Found Issues Clearance Plan

Status: drafted 2026-11-09; the owner accepted every open question's recommendation the same day; revised the same
day after the plan-runner audit ([report](../plan-runner-audit/found-issues-clearance-2026-11-09.md)): its eight P1
corrections and the P2 and P3 corrections are applied below, with the owner's two decisions (C4 adds the setting's
control; F3's retention entry is Recorded). Landed: A3 (daca54e6b), A1 (d1a40c7ce), C1 (517e2d29c), D2 (423b5eb73), F2 (79d4f2c47), B6 (c0850c908), E3 (d48282559), B5 (6ccc14e7a), C2 (45bd82a37), A2 (b6423360e), D1 (6e9abbed2), B2 (dffdad50f), G4 (504f8d42a), E1 (79d508832), F1 (98128cebb), F7 (af549771e), A4 (0ea39e750), B4 (538eeaa20), F3 (084d57119), B3 (7ef8f4622), F5 (7aca72529), F8 (1e271629e), C3 (d855b826b), F9 (6a26398e6), A5 (000cbfd7f), F6 (279c57807), D3 (43066ebd6), G1 (9cfd74d76), G3 (529bbd582), G2 (a030fd212). Source: every
entry of [found-issues](../research/found-issues.md) at `1e55709f9` (86 entries in nine sections), re-checked
against that tree the same day by eleven read-only Luna workers whose file and line evidence the session
spot-checked. The goal differs from the three sweeps before it: when the last slice lands, the inbox is empty.
Every entry has a disposition in the **Index**: a slice here, a **Recorded** Limitation in its owning guide (slice
H1), or **Closed** (already recorded in a guide, or an identifier that no longer exists). Nothing is Deferred and
nothing Stays. This plan is also the Module Headers plan's D7 sweep (the 29 entries that run added), which that plan
left for the owner to start.

Line numbers in the slices are from the 2026-11-09 check; identifiers are the anchors. Re-verify each cited
location before editing (STRUCTURE.md protocol step 5).

Selection rules, in the order they were applied:

1. A confirmed defect whose fix is local to one file cluster and has a test: a slice, grouped with the entries that
   share its files.
2. A claim the source cannot settle (a measurement, a browser run): a slice that measures with the repository's own
   driver and acts on the result by a rule stated in the slice, or an item on the **Owner checklist** when only a
   real device can show it. The entry still leaves the inbox: the measurement is recorded in `docs/audit/`, or the
   limitation in the guide.
3. An accepted behavior, a latent path with no producer, or a design the owner chose earlier: **Recorded** by H1 in
   the owning guide's Known Hazards as a Limitation with a decision date (STRUCTURE.md Doc Maintenance).
4. An entry the guides already carry, or whose identifier is gone: **Closed**; H1's landing commit deletes it with
   the reason in the commit message.
5. A fix whose direction the owner has not chosen: an **Open question** with a recommendation; the slice that
   carries it names the question. Every slice is written for the recommended answer; an answer that differs
   revises the slice before the run.

Rules, the same as the three sweeps before it. One slice is one session, one commit, one file cluster. Each slice
names its owning guide from `STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Every slice updates the
owning guide's `Flows`, `Invariants`, or `Known Hazards` where it changes a documented contract and removes the
matching hazard entry when it fixes one. Workflow per slice: `opus-lite` for a slice marked _small_,
`opus-workflow` for one marked _hard_; routine slices name no Codex challenger. Each slice ends with its regression
test (under _Test_), `pnpm check`, `pnpm --silent test:agent` for the files it touches and then once whole, the
guide's focused checks, `pnpm format:check`, and `pnpm check:docs` for any guide edit. A slice does not edit
`found-issues.md`: the entries it closes (under _Removes_) are deleted, with the section counts in that file's
Contents list, in the landing commit that marks the slice landed here, so parallel slices never conflict on the
inbox. An entry a slice finds already fixed is removed the same way with a note in the commit message. A Limitation a
slice records carries the decision date. A guide edit respects the 40,000-byte ceiling (`pnpm check:docs`): a
sentence added to a guide near its ceiling is paid for with a trim in the same edit. A guide without a
`### Limitations` heading (`backup-sync-hub.md`, `translation.md`, `settings-i18n.md`, `build-test-platforms.md`,
`test-harness.md`, `media-aux.md`) gets one between `Issues` and `Gotchas` when a slice first records there.

## Open questions

The owner accepted every recommendation on 2026-11-09. Each gated slice carries the accepted answer only;
no slice waits on a question. A Limitation H1 records for one of these carries that date.

| Q   | Question                                                                                                                                                                                                                                                                                                            | Accepted answer                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | `svelte/store`'s module-level `subscriber_queue` is left mid-run when a subscriber throws; no known subscriber throws. Record it, or move `localSends` (`src/ts/process/localSends.ts`) off `svelte/store` onto `$state`?                                                                                           | Record (H1, `chat-pipeline.md`): latent, and a store change touches every consumer (UI, memory fences, translation, plugin idle tracking) for no reproduced defect.                                                                 |
| Q2  | Tool schemas are not in the assembly token budget (`AssemblyHost` has no schema input; `body.tools` is added later). Charge a tokenizer estimate of the serialized descriptors in the final recheck, or record the gap?                                                                                             | Charge it (A4): a send near the budget that the provider refuses is a user-visible failure the meter contradicts. A4 measures first and keeps the charge an estimate.                                                               |
| Q3  | Lore regex keys with a comma are split on every comma, and a bound persona's embedded module resolves only when the module is installed; both pinned by tests and already in `chat-pipeline.md` and `characters-modules.md` Known Hazards. Keep them accepted (delete the inbox entry), or fix the comma split now? | Keep accepted; close the entry (H1). The fix changes activation parity with the browser path and upstream, and the owner tied it to the next lore rework.                                                                           |
| Q4  | The change log keeps 20,000 rows with no byte bound (82 MB in the 512-unit-id probe; a few MB with UUID ids). Record the worst case in `server-resources.md`, or add a byte bound or a VACUUM to `pruneChanges`?                                                                                                    | Record (H1), with the numbers: typical stores stay small, a byte bound costs a `SUM(length(id))` per prune, and `DELETE` never shrinks the file without a VACUUM that would stall every commit.                                     |
| Q5  | A version-2 export streams a custom-key asset without the per-path `claimAssetKey` lock, so a custom-key rewrite during the export can pair the database copy with later bytes. Record it, or take the lock per custom-key file while it streams?                                                                   | Record (H1, `server-resources.md`): custom keys are mutable by contract and content-hash keys cannot change; holding the asset lock across a network stream would block the writer for the export's duration.                       |
| Q6  | `requireObject` and `isPlainObject` accept a `Map`, a `Date`, or a class instance. Make both reject anything whose prototype is not `Object.prototype` or `null`, or reword the comment?                                                                                                                            | Make them strict (B4): no caller legitimately passes a non-plain object, arrays are already rejected, and a `Map` serializing as `{}` is a silent loss.                                                                             |
| Q7  | The `saveSignatures` setting does nothing on the typed path, the saved inlay holds response text instead of the provider token, and a signature-only part marks the wrong text. Fix all three so the setting works, or record that the setting is inert?                                                            | Fix all three together (C4) and give the setting the control it lacks: the schema persists it and the former browser path honored it, but no UI binds it (AUD-12); fixing only the assignment would turn it into rejected requests. |
| Q8  | Both sockets log `proto=1` to the server console only; Diagnostics carries no protocol number. Add a diagnostics field and recorders now, or record it until a protocol floor is planned?                                                                                                                           | Record (H1, `diagnostics.md` and `live-update-feed.md`): no floor is planned, and a new event field changes the closed `DIAGNOSTIC_EVENT_KINDS` schema on both sides for a number nothing reads yet.                                |
| Q9  | `MAX_SNAPSHOT_BYTES` (8 MiB) was never re-measured after the shared display entries left the per-scope charge. If D2's measurement shows a realistic scope alone over the limit, may D2 raise the constant (to at most 16 MiB), or does it only record the numbers?                                                 | Allow the raise under that rule (D2), recorded with the measurement; a scope alone over the limit stays raw forever, which is worse than a larger snapshot.                                                                         |
| Q10 | A screenshot row over `MAX_EXPORT_PIXELS` gets its own page without reducing its area (a 300 MiB canvas at DPR 2). Scale such a row down to the area budget, or tile it across pages?                                                                                                                               | Scale it (E4): one page per row stays true, the output is a smaller image of the same row, and tiling needs a seam-free capture of one row at two offsets.                                                                          |
| Q11 | `getFileSrc` never rejects (its loader resolves `""`), so the render path's transient retry never fires. Add an opt-in rejecting read for the parser's asset and inlay passes, or record that failed asset reads are not retried?                                                                                   | Add the opt-in read (F1): the recovery path exists and is tested; it only lacks a signal. The shared loader keeps resolving `""` for every other caller.                                                                            |
| Q12 | The Web Push detail strings exist in `en` and `ko`; `de`, `es`, `vi`, `cn`, `zh-Hant` show English. Add translations, or record the English fallback once as the locale rule?                                                                                                                                       | Record once (H1, `settings-i18n.md`, if the DeepPartial fallback is not stated there yet): the other locales are partial by design and every feature since 2026-10 added `en` and `ko` only.                                        |
| Q13 | Of the request-history trade-offs, two are fixable: `LogField` always shows "copied" (it ignores `copyText`'s boolean), and the viewer maps the older-copies 500 by comparing the server's English message. Fix both (D3), or record them with the rest?                                                            | Fix both (D3): a `code` field on the 500 and a failure state in `LogField` are small; the delete ordering and the double-counted state write stay recorded.                                                                         |
| Q14 | `replacePlaceholders(msg, name)` never reads `name`. Use it (falling back to the selected character), or drop the parameter?                                                                                                                                                                                        | Use it (F5): both callers already pass a name, and a caller rendering another character then gets the right one.                                                                                                                    |
| Q15 | Same-name plugins can share a popup editor target; `plugin-sandbox.md` Issues already states it (moved there 2026-11-07), and a real fix needs a plugin id in the persisted schema. Close the inbox copy, or key the editor context by a runtime identity now?                                                      | Close (H1): the guide carries it; an index key is not robust under a reorder, and a persisted id is a schema change for an unconfirmed browser sequence.                                                                            |
| Q16 | The heap D3 bullet (`Batch.previous` held by an `{#await}` closure, about 17 MB) names no identifier in the current source. Close it, or re-measure with `measureHeap.mjs`?                                                                                                                                         | Close (H1): the identifier is gone and the measurement predates the per-row effect roots; a re-measure belongs to the next heap plan if one comes.                                                                                  |
| Q17 | A tab that leaves after a Realm prepare holds a staging slot for the 10-minute TTL, and a commit refused 409 or 503 is not retried. Add a best-effort `pagehide` cancel and a bounded retry for the busy and maintenance classes, or record both?                                                                   | Fix both (B5): the cancel is one keepalive request, the retry is bounded to the two refusal texts the server already classifies, and both stay compatible with the one-time token.                                                  |

## Index

Every entry of `found-issues.md`, by its section and heading there, with its disposition.

| Section                            | Entry                                                                     | Disposition                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Chat store, sync, and change feeds | Store subscriber throw queue                                              | Recorded (`chat-pipeline.md`): H1 (Q1)                                                  |
|                                    | Feed row text diffs hash the whole base per candidate                     | A5                                                                                      |
|                                    | Two more cyrb53 copies beside `shared/textHash.ts`                        | A5                                                                                      |
|                                    | pluginStorage adoption keeps plain input objects                          | B6                                                                                      |
| Server jobs and prompt assembly    | Tool schemas are outside the assembly token budget                        | A4 (Q2)                                                                                 |
|                                    | The trim question counts blank history                                    | A1                                                                                      |
|                                    | Slash commands address stored positions during a reroll                   | A2                                                                                      |
|                                    | runTrigger copies the character before seeing no triggers                 | A1                                                                                      |
|                                    | HypaV3 summary chunks find their vectors by scan                          | A3                                                                                      |
|                                    | The context override comment is garbled                                   | A1                                                                                      |
|                                    | Asset-scale transport and job leftovers                                   | Recorded (`resource-sync.md`, `server-generation.md`): H1                               |
|                                    | HypaV3 deferred summary leftovers                                         | Recorded (`memory.md`): H1                                                              |
|                                    | Deferred lore behaviors                                                   | Closed (already in two guides): H1 (Q3)                                                 |
| Server routes and resource store   | The change log's bound is a row count, not 4 MB                           | Recorded (`server-resources.md`): H1 (Q4)                                               |
|                                    | Lua image shortcuts reuse an asset key without a claim                    | B1                                                                                      |
|                                    | The inlay recognizer is quadratic on unterminated openings                | B1                                                                                      |
|                                    | A custom-key asset can change during a version-2 export                   | Recorded (`server-resources.md`): H1 (Q5)                                               |
|                                    | Upstream swipe import edge cases                                          | B2                                                                                      |
|                                    | Upstream `.bin` import converts MessagePack-only values without a report  | B3                                                                                      |
|                                    | requireObject accepts class instances                                     | B4 (Q6)                                                                                 |
|                                    | normalizePreset can keep an `ooba` container without `formating`          | B4                                                                                      |
|                                    | normalizeChatLoadPages throws on a Symbol                                 | B4                                                                                      |
|                                    | Realm staged import leftovers                                             | B5 (Q17), its accepted bullets recorded by B5                                           |
| LLM requests and providers         | AIN prompts end in NaN                                                    | C1                                                                                      |
|                                    | reformater throws on an empty or all-system prompt                        | C1 (the Google read: C4)                                                                |
|                                    | A system-only Claude prompt loses its text                                | C2                                                                                      |
|                                    | The Claude reverse proxy keeps only a first text block                    | C2                                                                                      |
|                                    | OpenRouter free-model discovery ignores the bound key                     | C3                                                                                      |
|                                    | An empty OpenRouter free list throws a TypeError                          | C3                                                                                      |
|                                    | The OpenAI tool stream wrapper keeps only choice 0                        | C5                                                                                      |
|                                    | OpenAI in-band stream errors are ignored                                  | C5                                                                                      |
|                                    | A missing Content-Type header throws in OpenAI streaming                  | C5                                                                                      |
|                                    | Google thought signatures are never saved on the typed path               | C4 (Q7)                                                                                 |
|                                    | Saved Google signatures replay the wrong content                          | C4 (Q7)                                                                                 |
|                                    | A signature-only Google part marks the wrong text                         | C4 (Q7)                                                                                 |
|                                    | Google token counts can collide in the cache                              | C1                                                                                      |
|                                    | setObjectValue follows `__proto__` segments                               | C6                                                                                      |
| Request history and diagnostics    | Request history accepted trade-offs                                       | D3 (Q13) for two bullets; the rest Recorded (`diagnostics.md`, `llm-requests.md`): H1   |
|                                    | Socket protocol numbers are not in Diagnostics                            | Recorded (`diagnostics.md`, `live-update-feed.md`): H1 (Q8)                             |
| Display transform                  | Budget-refused handler rows not re-measured                               | D2 (Q9)                                                                                 |
|                                    | A single combined paragraph is written back as HTML                       | D1 (provider input); Recorded (`translation.md`): H1 (the Markdown pass)                |
|                                    | An aborted first transform call can leave its snapshot counted            | Recorded (`cbs-rendering.md`): H1                                                       |
|                                    | The experimental Google translator does not check the status              | D1                                                                                      |
|                                    | A provider switch during a translation caches a mixed result              | D1                                                                                      |
|                                    | A withdrawn forced refresh can leave its replacement on the old cache     | Recorded (`cbs-rendering.md`): H1                                                       |
|                                    | The MessageTranslation sourceHash comment names the wrong text            | D1                                                                                      |
| Chat screen and input              | Latest-message start scroll untested in DefaultChatScreen                 | E2                                                                                      |
|                                    | The screenshot peak grows with the row count                              | E4 (Q10)                                                                                |
|                                    | /multisend keeps its quotes                                               | E1                                                                                      |
|                                    | Repeated screenshot exports grow the live stylesheet                      | E3                                                                                      |
|                                    | Chat rendering leftovers                                                  | Recorded (`ui-theming.md`): H1; Firefox and Safari on the Owner checklist               |
|                                    | ChatBody's modelShortName no longer changes the body                      | E2                                                                                      |
| Client and plugins                 | Stop B leftovers                                                          | G4 (the flakes); the URL pinning Recorded (`assets.md`): H1; the rest Closed (settled)  |
|                                    | loadFileSrc can return /sw/img on an uncontrolled page                    | F1                                                                                      |
|                                    | getFileSrc never rejects, so asset reads are never retried                | F1 (Q11)                                                                                |
|                                    | Scheme writers skip the text theme                                        | F2                                                                                      |
|                                    | Local ui writers skip the display apply                                   | F2                                                                                      |
|                                    | #import_preset opens the settings after a refusal                         | F3                                                                                      |
|                                    | A stray }} ends CBS highlighting                                          | F4                                                                                      |
|                                    | Inlay explorer hard-codes two strings                                     | F4                                                                                      |
|                                    | JSON and V3 card imports keep base64 text until the save ends             | Recorded (`assets.md`): H1 (AUD-5, 2026-11-09)                                          |
|                                    | Bulk plugin character adds stay quadratic                                 | F7                                                                                      |
|                                    | A memory algorithm switch during a detached read omits its projection     | F7                                                                                      |
|                                    | The sandbox bridge drops an own `__proto__` key                           | F8                                                                                      |
|                                    | Duplicate plugin names can share a popup editor target                    | Closed (in `plugin-sandbox.md` Issues): H1 (Q15)                                        |
|                                    | Nested numeric settings can be stored as null                             | F6                                                                                      |
|                                    | StorageController.owners has no reader                                    | F6                                                                                      |
|                                    | AppendableBuffer can hang after a full deappend                           | F1                                                                                      |
|                                    | searchTagList never matches the OC tag by name                            | F5                                                                                      |
|                                    | replacePlaceholders ignores its name parameter                            | F5 (Q14)                                                                                |
|                                    | getCharToken rejects with no selected character                           | F5                                                                                      |
|                                    | The source map fetch timeout ends before the body                         | F5                                                                                      |
|                                    | selectLoreBookPage stores any number                                      | F5                                                                                      |
|                                    | Asset-scale client leftovers                                              | F9 (two bullets); two Recorded (`translation.md`, `assets.md`) and two Closed: H1 (Q16) |
|                                    | Web Push leftovers                                                        | F10 (two bullets); the rest Recorded (`network-jobs.md`, `settings-i18n.md`): H1 (Q12)  |
|                                    | Plugin reload deferral leftovers                                          | F8 (two bullets); the first Closed (in `plugin-sandbox.md`): H1                         |
|                                    | The plugin remove button's comment predates the owned-write refusal       | F6                                                                                      |
| Build, drivers, and e2e            | checkJobProtocol's first run after a source change fails its SIGKILL case | G3                                                                                      |
|                                    | check:docs does not measure blockquoted items                             | G1                                                                                      |
|                                    | check:docs collapses spaces inside a row's code spans                     | G1                                                                                      |
|                                    | checkServerSend once hit an alert after its mid-stream reload             | G3                                                                                      |
|                                    | docs:contracts crashes on EPIPE under head                                | G1                                                                                      |
|                                    | pnpm check does not type-check e2e specs                                  | G2                                                                                      |
|                                    | Automatic browser spec selection misses extensionless imports             | G2                                                                                      |
|                                    | An ignored path can hide a broken sibling in a guide                      | G1                                                                                      |
| Test timing                        | Gate tests still racing real time                                         | G4                                                                                      |

## Order

Every slice is independent of the others' code unless listed here.

- **Shared source files.** C1 and C4 both touch `server/src/llm/google.ts` only if C1 takes the `formated[0]`
  guard there; it does not: the Google read is C4's. B5 and F3 both edit `src/ts/characterCards.ts` (the Realm
  commit path and the preset hash branch): B5 first, F3 rebases. F2, F7 and F8 all edit
  `src/ts/plugins/apiV3/v3.svelte.ts` in different regions (`setColorScheme` and `applyPluginKey`;
  `applyPluginCharacters`, the chat index accessors and the detached read; `executePluginV3`): serial, in that
  order, each rebasing. F1 and F9 both touch the parser's asset passes (`src/ts/parser/parser.svelte.ts`: F1 the
  read call and the cache invalidation, F9 the cache bound): F1 first. E3 lands before E4 (E4 measures with the
  fixture E3 extends). G4 edits test files only; the ones another slice's _Test_ names are in the groups below.
  Further groups the 2026-11-09 audit found (AUD-29), each run serially in slice order with the later slice
  rebasing; a test file a slice only runs does not count: A1 and A4 (`server/src/prompt/assemble.ts`,
  `server/src/tests/assemble.test.ts`); A1 and A2 (`server/src/tests/triggerRuntime.test.ts`); A2 and E1
  (`server/src/prompt/commands.ts`); A3 and G4 (`server/src/tests/hypaV3Parts.test.ts`); A4 and A5
  (`shared/contextReport.ts`); A4 and C4 (`server/src/tests/llmRequests.test.ts`); A4, C4 and F4 (`src/lang/en.ts`
  and `ko.ts`); B2 and B3 (`server/src/tests/upstreamImportCharacters.test.ts`); B6 and F7
  (`src/ts/storage/records.svelte.ts`); C1 and C4 (`server/src/llm/request.ts`); C3 and C5
  (`server/src/llm/openAI/requests.ts`); C1 to C6, every pair (`server/src/tests/llmProviderAdapters.test.ts`);
  C4 and C5 (`server/src/tests/llmStreamParsing.test.ts`); A1 and G4 (`server/src/tests/transform.test.ts`); D2
  and G4 (`server/src/tests/transformService.test.ts`, and `server/src/prompt/transform.ts` if D2 raises the
  limit).
- **Guides.** A1, A2, A4, D2 and H1 edit `server-generation.md`; A1, A3 and H1 edit `memory.md`; A2, E1 and H1
  edit `chat-pipeline.md`; A4, C1 to C6 and H1 edit `llm-requests.md` (each a hazard removal or a header sentence;
  C4 adds the signature flow); D1 and H1 edit `translation.md`; E2 to E4, F2 and H1 edit `ui-theming.md`; C4, D2,
  F4, F9 and H1 edit `cbs-rendering.md`; F1, F9 and H1 edit `assets.md`; A5, F1 and F5 edit `global-api.md`; B1 and
  F10 edit `self-host-server.md`; B4, B6 and F7 edit `persistence.md`; B6, F7, F8 and H1 edit `plugin-sandbox.md`;
  B2, B3 and B5 edit `backup-sync-hub.md`; C4, F4, F6 and H1 edit `settings-i18n.md`; G1 and G2 edit
  `build-test-platforms.md`; G2, G3 and G4 edit `test-harness.md`: H1 runs last and rebases onto what landed; the
  others rebase in slice order. Every guide stays under the 40,000-byte ceiling (`pnpm check:docs`);
  `llm-requests.md`, `cbs-rendering.md`, `ui-theming.md`, `diagnostics.md` and `assets.md` take the most new
  sentences and may need a trim each.
- **Questions.** None open: every slice carries the accepted answer from the table above. A slice that finds
  its decision does not fit the code stops with `QUESTION` instead of choosing.
- **Sessions.** A2, A4, C4, C5, D1, E4, F1, F7 and G4 are _hard_; every other slice is _small_. Three sessions
  at a time is this plan's choice (the runner has no default); H1 waits for every other slice.

## Slices

### A. Server prompt and jobs

- **A1. Blank history, trigger copies, and a comment** (_small_, `server-generation.md` with `memory.md`).
  `server/src/prompt/assemble.ts` (~1904–1915): ask the no-memory trim question only when a dropped entry past
  `historyStart` is non-blank, with the same blank definition the final recheck uses (`keptEntry`, ~2533–2543).
  `server/src/prompt/triggers.ts` `runTrigger` (~372–396): check `hasTriggers(sourceChar)` (~367–370) before
  `triggerCopy` (~384) and the patch observer, keeping the initial `yieldTurn` and the fence; the display transform
  (`server/src/prompt/transform.ts` ~668–683) is the caller that pays today. `shared/sections.ts`
  `maxContextOverrideOf` comment (~475–477): state the rule the code implements (the size when the toggle is on
  and the size is finite and above 0, else unset).
  _Done_: a trim that drops only blanked entries asks nothing; a character with no triggers renders a row with no
  `structuredClone` of the character; the comment matches the code.
  _Test_: `server/src/tests/assemble.test.ts` (a blank-only dropped prefix asks nothing; a non-blank one asks),
  `server/src/tests/triggerRuntime.test.ts` (no copy without triggers; the copy and observer with one),
  `server/src/tests/transform.test.ts` (the display path).
  _Removes_: The trim question counts blank history; runTrigger copies the character before seeing no triggers; The
  context override comment is garbled.

- **A2. Slash commands during a reroll** (_hard_, `chat-pipeline.md` with `server-generation.md`).
  `server/src/prompt/commands.ts` `comment`, `cut`, `del` (~218–262) resolve indexes and "the last message"
  against the stored chat handed to `services.writeChat`; during reroll assembly the Lua getters and setters address
  the history view (`scopeHistoryMessages`, `server/src/jobs/jobScope.ts` ~474–496, `server/src/lua/bindings.ts`
  ~1329–1381) with the carrier hidden. Resolve the three commands through the same history view, reached by a new
  `CommandHost` callback (`server/src/prompt/commands.ts` ~7; the host carries no scope and no history accessor
  today) that `server/src/jobs/runSetup.ts` (~422, where the host is built) wires to
  `scopeHistoryMessages(scope, chat)`: the index and "last" map to stored positions through the view, the hidden carrier is never "last", and a `/cut` on the view
  removes the message the script read. Keep the carrier lock, the stored-write revision fence, and the insertion
  anchors.
  _Done_: with `scope.rerollHistoryMessageId` set, a trigger's `/cut 2` and a Lua `getChat(2)` name the same
  message; `/comment` appends after the visible last message and is not refused by the lock.
  _Test_: `server/src/tests/commandRunner.test.ts` or `commandExecutor.test.ts` (the three commands under a reroll
  scope), `server/src/tests/luaBindingsFences.test.ts` (view and command agree),
  `server/src/tests/triggerRuntime.test.ts` (`v2Command` during a reroll).
  _Removes_: Slash commands address stored positions during a reroll.

- **A3. HypaV3 chunk vectors by map** (_small_, `memory.md`). `server/src/prompt/memory/hypav3.ts`
  `addSummaryChunks` (~2672–2695): after `addText`, build one `Map` from content to the first vector carrying it and
  look each chunk up, so duplicate chunk texts share their first match as the scan does and N chunks cost N. Not a
  queue consumed per chunk: `addText` admits a cached or already-loaded text once (`server/src/prompt/embeddings.ts`
  ~632), so two equal chunks can own one vector and a queue would run dry on the second. The contextual path
  (~2697–2784) is unchanged.
  _Done_: 2,000 chunks run in linear time; two identical chunk texts, one already cached, share one vector and
  throw nothing.
  _Test_: `server/src/tests/hypaV3Parts.test.ts` (warm duplicates; a text admitted by an earlier call; a count of
  comparisons or a time bound).
  _Removes_: HypaV3 summary chunks find their vectors by scan.

- **A4. Tool schemas in the token budget** (_hard_, `server-generation.md` with `llm-requests.md`; Q2).
  Measure first: serialize a realistic tool set (the MCP descriptors a chat with two servers offers, from the
  fixtures in `server/src/tests/mcp.test.ts`) and count it with the resolved tokenizer
  (`server/src/prompt/tokens.ts` `encode`) for two models; record the counts in the commit message. Then the tool
  set moves ahead of assembly: today the runner awaits `assemblePrompt` (`server/src/prompt/runner.ts` ~1621) before
  it calls `services.request` (~1785), and the descriptors are listed only inside that request
  (`server/src/lua/bindings.ts` ~943, `jobTools.list(ctx)` once per request). The runner obtains that one listing
  before assembly, estimates its resolved provider body form once (`server/src/llm/openAI/requests.ts` ~534–545,
  not per follow-up round) with the runner's tokenizer, passes the estimate to `server/src/prompt/assemble.ts`
  `AssemblyHost` (~138–200) as an optional `toolSchemaTokens` input that the final recheck (~2503–2543) subtracts
  from the room, and hands the same set to the request, which sends it instead of listing again. Keep
  `maxContext - maxResponse` and the ledger shape; the meter (`shared/contextReport.ts`) shows the charge as its own
  row. Two commits are allowed: the host input with its meter row, then the runner and bindings wiring.
  _Done_: with tools offered, the recheck trims so that messages plus schemas fit and the request sends exactly the
  set that was estimated; without tools nothing changes; the context meter names the schema charge.
  _Test_: `server/src/tests/assemble.test.ts` (the host input shrinks the room), `server/src/tests/promptRunner.test.ts`
  (a job offering two tools assembles under the trimmed room and the request receives the listed set),
  `server/src/tests/llmRequests.test.ts` (the request reuses the set it is given), `server/src/tests/contextReport.test.ts`
  or the meter test (the row).
  _Removes_: Tool schemas are outside the assembly token budget.

- **A5. Feed row base hash and the cyrb53 copies** (_small_, `live-update-feed.md` with `global-api.md`).
  `server/src/data/chatStore.ts` `chatRowDiff` (~752–781) and the candidate build in `chatFeedChange`
  (~1855–2005): compute `textHash(before.data)` only when the row delta is the chosen form (its `base` is about 45
  encoded bytes, so the size choice can run without it), or skip it when the whole-row patch wins; the wire shape
  (`base.length`, `base.hash`, the 8 KiB threshold, the 64 KiB cap) is unchanged. `shared/textHash.ts` gains a
  radix option on its core; `shared/notifications.ts` (~120–130) and `shared/contextReport.ts` (~531–542) call it
  with base 36 and keep their outputs byte for byte.
  _Done_: a 4 MiB old row shrunk to a small final row that takes the whole-row patch hashes nothing; the notification tag and the
  `historyDigest` fixtures are unchanged.
  _Test_: `server/src/tests/chatFeedPatches.test.ts` (hash calls counted per form), `shared/tests/notifications.test.ts`,
  `shared/contextReport.test.ts` and `server/src/tests/assemble.test.ts` (existing digests stay).
  _Removes_: Feed row text diffs hash the whole base per candidate; Two more cyrb53 copies beside
  `shared/textHash.ts`.

### B. Server routes and store

- **B1. Asset key claims and the inlay recognizer** (_small_, `self-host-server.md` with `scripts-triggers.md`).
  `server/src/lua/bindings.ts` `isImageInlay` (~793–805): replace the unlocked `storageFileExists` check with
  `claimAssetKey(savePath, meta.asset, { verify })` (the lock in `server/src/routes/storage.ts` ~241–282 is
  non-reentrant: the callback claims nothing else), keeping the inlay-id claim and the post-await fence.
  `server/src/data/assetLifecycle.ts` `recognize` (~151–170): one linear pass that matches the three prefixes and
  their `}}` terminators, stops when the remaining suffix has no terminator, and truncates no real reference; the
  recheck path (~1098–1123) uses the same function.
  _Done_: the self-host-server invariant has no exception; `"{{inlay::".repeat(20000)` recognizes in linear time
  and the three syntaxes still resolve.
  _Test_: `server/src/tests/luaBindings.test.ts` (the claim is taken; the sweep cannot delete during the check),
  `server/src/tests/assetLifecycle.test.ts` (the three syntaxes, escaped forms, and a time bound on the malformed
  string).
  _Removes_: Lua image shortcuts reuse an asset key without a claim; The inlay recognizer is quadratic on
  unterminated openings.

- **B2. Upstream swipe import** (_small_, `backup-sync-hub.md`). `server/src/data/upstream/importCharacters.ts`:
  the missing-inlay report (~523–525) scans the converted candidates' `data` once per chat as well as
  `message.data`; the conversion (~617–700) keeps the selected entry plus the newest window of the live ring's size
  before building candidates, so `trimCandidates` runs over a bounded list; the native-`candidates` check
  (~623–640) tests the normalized field (a non-empty, valid array) before refusing swipe conversion.
  `shared/rerollCandidates.ts` `trimCandidates` (~245–255): one `splice` of the oldest run instead of one per
  element.
  _Done_: an alternate-only missing image is in the report; 1,000 swipes on one message import in linear time;
  `candidates: []` beside valid `swipes` converts the swipes.
  _Test_: `server/src/tests/upstreamImportCharacters.test.ts` (the three cases),
  `shared/tests/rerollCandidates.test.ts` (trim result unchanged).
  _Removes_: Upstream swipe import edge cases.

- **B3. Upstream MessagePack values in the report** (_small_, `backup-sync-hub.md`).
  `server/src/data/upstream/importRecords.ts` `storedValue`/`storedForm` (~83–119): report a value whose JSON form
  differs in kind from its decoded form (a typed array, a `Date`, a `Map` or `Set`, an `undefined` property) with a
  report code in `shared/upstreamBackup.ts`; `server/src/data/upstream/importDatabase.ts`'s settings loop
  (~214–228) reports `copied`; `importCollections.ts` (~258–273) keeps its fallback report. Block saves and
  JSON-like upstream fields are unchanged.
  _Done_: a legacy save whose `pluginCustomStorage` holds a `Uint8Array` imports with a report line naming the key
  and the conversion; a plain JSON save reports nothing new.
  _Test_: `server/src/tests/upstreamImportSettings.test.ts` and `upstreamImportCharacters.test.ts` (a `Date`, a
  typed array and a `Map` through the converter with the report asserted), `server/src/tests/upstreamRisuSave.test.ts`
  (decoding unchanged).
  _Removes_: Upstream `.bin` import converts MessagePack-only values without a report.

- **B4. Shared normalization** (_small_, `persistence.md`; Q6). `shared/valueKinds.ts` `isPlainObject` (~26–28):
  also require a prototype of `Object.prototype` or `null`; `shared/mutationValidation.ts` `requireObject`
  (~89–94) uses it, so a `Map`, a `Date` or a class instance is refused with the existing error class; audit the
  other `isPlainObject` consumers (`server/src/data/normalize/shared.ts` ~9–14 and its callers) for one that passes
  a non-plain object on purpose (none is known). `shared/presets.ts` `normalizeFields` (~550–606): fill the `ooba`
  container's defaults as it does for `NAISettings`, so `normalizePreset({ ooba: {} })` has `ooba.formating`; the
  doc comment (~628–640) then holds. `shared/chatLoadPages.ts` (~17–30): a `symbol` returns the fallback instead of
  throwing.
  _Done_: a mutation carrying a `Map` is refused; `normalizePreset({ ooba: {} }).ooba.formating` exists and
  normalization stays a fixed point; `normalizeChatLoadPages(Symbol(), 3)` is 3.
  _Test_: `shared/tests/valueKinds.test.ts` or `mutationValidation.test.ts` (a `Map`, a `Date`, a class instance, a
  null-prototype object accepted), `server/src/tests/kinds.test.ts`, `src/ts/storage/tests/presetSchema.test.ts`
  (`ooba: {}`), `src/ts/chatLoadPages.test.ts`.
  _Removes_: requireObject accepts class instances; normalizePreset can keep an `ooba` container without
  `formating`; normalizeChatLoadPages throws on a Symbol.

- **B5. Realm staging cancel and retry** (_small_, `backup-sync-hub.md`; Q17). `src/ts/characterCards.ts` and
  `src/ts/storage/realmImportClient.ts`: a `pagehide` listener registered while a prepare is staged sends the
  cancel the way the unload transport in `src/ts/storage/resourceClient.ts` (~461) does: the authentication token
  is prepared ahead and the request is a direct `keepalive` fetch, because `cancelRealmImport` (~50) goes through
  `authFetch`, which awaits authentication and signing (`src/ts/storage/serverAuth.ts` ~196) that `pagehide`
  cannot wait for; the TTL stays the fallback (best effort); `commitRealmCard` (~2391–2402) retries once after a short wait when the
  server's refusal text is the busy or maintenance class (`server/src/tests/importRealm.test.ts` names both), and
  cancels as today otherwise. Record in `backup-sync-hub.md` Limitations (adding the heading), with the date: the
  legacy JSON hub resources are fetched by the tab, `readModule` stores a CharX module's assets in the tab, and
  `planPngFile` reads one prefix per tEXt key; the live Realm check is on the Owner checklist.
  _Done_: closing the tab after a prepare frees the slot before the TTL; a 503 maintenance refusal on commit
  retries once and then imports or cancels; the guide names the three kept behaviors.
  _Test_: `src/ts/characterCardsRealmImport.test.ts` (the `pagehide` cancel; the retry on the two classes and not
  on 409 conflict), `pnpm check:docs`.
  _Removes_: Realm staged import leftovers.

- **B6. pluginStorage adoption detaches** (_small_, `persistence.md` with `plugin-sandbox.md`).
  `src/ts/storage/records.svelte.ts` wrapper adoption (~1494–1534, `unwrap`): a plain object assigned through the
  `pluginStorage` wrapper is copied, as characters and modules are, and same-record aliasing
  (`custom = _ownedPluginStorage`) is detached too; the revision bump and the reserved dictionaries are unchanged.
  _Done_: mutating a caller-owned object after assigning it to `pluginStorage` changes nothing in the record and
  the next save carries the assigned value.
  _Test_: `src/ts/storage/tests/records.test.ts` (the post-assignment mutation), `src/ts/storage/tests/pluginStorageStore.test.ts`
  (public paths unchanged).
  _Removes_: pluginStorage adoption keeps plain input objects.

### C. LLM adapters

- **C1. Request layer small fixes** (_small_, `llm-requests.md`). `server/src/llm/stringlize.ts`
  `stringlizeAINChat` (~152) and the tab copy `src/ts/process/stringlize.ts` (~159): drop the stray unary `+`, or
  delete the tab export (no non-test importer; `unstringlizeChat` is the only import from that file). `reformater`
  in `server/src/llm/request.ts` (~282) and `src/ts/process/request/request.ts` (~573): guard `formated.length` in
  the `hasFirstSystemPrompt` loop so an empty or all-system prompt throws no `TypeError`: `reformater` then
  restores the collected system prompt (~351) and the adapter handles the request as it does any other. `server/src/prompt/tokens.ts`
  `countWithGoogle` (~175): key the cache and the in-flight map by a serialized tuple of text and model id.
  _Done_: a non-continued AIN prompt ends in `\n\n<char> 「`; an all-system prompt reaches the adapter with its system
  prompt restored and no TypeError; `ab`+`c` and `a`+`bc` count separately.
  _Test_: `server/src/tests/llmLegacyFormats.test.ts` (the tail), `server/src/tests/llmProviderAdapters.test.ts`
  (empty and all-system input on the server reformater), a tab request test under
  `src/ts/process/request/tests/` (the tab copy), `server/src/tests/tokens.test.ts` (the collision pair).
  _Removes_: AIN prompts end in NaN; reformater throws on an empty or all-system prompt; Google token counts can
  collide in the cache.

- **C2. Claude adapter edge cases** (_small_, `llm-requests.md`). `server/src/llm/anthropic.ts` `requestClaude`:
  a system-only prompt (~289–299) moves the system text into the inserted user turn instead of clearing it; the
  `reverse_proxy` mapping (~380–391) joins every text block of a message and skips non-text blocks instead of
  reading `content[0]`.
  _Done_: a system-only prompt reaches the model as its text; a multimodal message through the reverse proxy keeps
  all of its text.
  _Test_: `server/src/tests/llmProviderAdapters.test.ts` (the body for both cases).
  _Removes_: A system-only Claude prompt loses its text; The Claude reverse proxy keeps only a first text block.

- **C3. OpenRouter free discovery** (_small_, `llm-requests.md`). `server/src/llm/openrouter.ts`
  `getFreeOpenRouterModels` (~19–44) takes the resolved key as a parameter (the `risu/free` caller in
  `server/src/llm/openAI/requests.ts` ~241–252 passes `getOpenAIRequestKey`'s result), optional-chains the first
  element, and returns an empty result the caller turns into a request failure with the cause (no free model, or the
  network error) instead of a TypeError. Remove the matching `Issues` sentence in `llm-requests.md` Known Hazards.
  _Done_: a profile bound to a named OpenRouter key discovers with that key; an empty list fails with "no free
  model".
  _Test_: `server/src/tests/llmProviderAdapters.test.ts` (the key on the discovery request; the empty list).
  _Removes_: OpenRouter free-model discovery ignores the bound key; An empty OpenRouter free list throws a
  TypeError.

- **C4. Google thought signatures** (_hard_, `llm-requests.md` with `settings-i18n.md` and `cbs-rendering.md`; Q7).
  `server/src/llm/request.ts` (~508–515): set `targ.saveSignatures` from the request-local `db.saveSignatures`
  (never from a client field; the allowlist in `server/src/routes/llm.ts` ~54–61 is unchanged), and only for the
  `model` mode (main chat replies and Lua `LLMMain`): translation, memory and the other auxiliary modes never save,
  because their hosts' `saveSignature` throws (`server/src/translation/runner.ts` ~245,
  `server/src/prompt/memory/memoryTaskHost.ts` ~192) and the awaited buffered save would fail the job (owner
  decision 2026-11-09, after C4 found this).
  `server/src/llm/google.ts`: the buffered save (~684–695) and the streaming saves (~989–1001) store the provider's
  `thoughtSignature` token in `signatures[].content`; replay (~113–120) parses the inlay's raw JSON text, which is
  what both stores hold (`src/ts/process/files/inlays.ts` ~477 writes `JSON.stringify(signature)`,
  `server/src/lua/bindings.ts` ~846 returns `meta.text` unchanged, and `server/src/prompt/assemble.ts` ~1794 passes
  it on as `multimodals[].base64`), so the `Buffer.from(…, "base64")` step is the mismatch and goes; a stored value
  that does not parse skips the part instead of failing the request; a signature-only buffered part (~696) keeps
  its marker on a text part of its own or is skipped when none exists; the `formated[0]` read (~77) is guarded for
  an empty prompt. The streaming collection (~979–1001) also saves a signature on a part with empty text, which
  today falls outside both the `part.text` and the `part.functionCall` branch. The buffered marker is appended after
  JSON extraction (~576), so `extractJson` never sees it. The live streaming tool follow-up (~1077–1131) keeps its
  raw tokens as today, and its text parts (~1115) drop signature markers. Chat rendering hides the marker:
  `getInlayMedia` (`src/ts/process/files/inlays.ts` ~533) tells a signature inlay apart from a missing one, and
  `parseInlayAssets` (`src/ts/parser/parser.svelte.ts` ~956) removes a signature inlay's marker instead of leaving
  it as text; `cbs-rendering.md` says so. The setting gets its control: a `Check` bound to
  `settings.providers.saveSignatures` in `src/lib/Setting/Pages/ModelSettings.svelte` (~63–70, beside
  `streamGeminiThoughts`, shown for a model with the `geminiThinking` flag) with a `language.modelProfiles` key in
  `src/lang/en.ts` (~1216) and `ko.ts` (~1150). Add the signature flow to the guide's `Flows`.
  _Done_: with the setting on, a Gemini thinking reply stores the token and the next request's body carries it as
  `thoughtSignature`; with it off nothing is stored and nothing is replayed; a signature-only part throws nothing
  and marks nothing unrelated; a translation or memory job on a signed reply succeeds and stores nothing; a chat
  message carrying a signature marker renders without it; the control appears for a Gemini thinking model. Whether
  the provider accepts the replayed token is on the Owner checklist.
  _Test_: `server/src/tests/llmProviderAdapters.test.ts` (the typed path saves; the stored content is the token;
  the signature-only part; the replayed body after a save-then-load through assembly),
  `server/src/tests/llmStreamParsing.test.ts` (the streaming saves store the token; the follow-up is unchanged),
  `server/src/tests/llmRequests.test.ts` (the setting reaches the adapter, for the `model` mode only), a parser or
  inlay test (a signature marker renders as nothing, a missing inlay's marker stays), a `ModelSettings` test beside
  the component (the control and its binding).
  _Removes_: Google thought signatures are never saved on the typed path; Saved Google signatures replay the wrong
  content; A signature-only Google part marks the wrong text.

- **C5. OpenAI stream wrapper** (_hard_, `llm-requests.md`). `server/src/llm/openAI/requests.ts`:
  `wrapToolStream` (~1205–1210, ~1349–1359) carries every choice key `getTranStream` accumulates (~1101–1107)
  instead of rebuilding `{ 0: ... }`; `getTranStream` (~1099–1128) turns a JSON event carrying `error` and no
  `choices` into a stream failure with the provider's message, in both parser instances (the initial stream and the
  tool follow-up ~1310–1347); the `Content-Type` reads (~681–686, ~1321–1328) default a missing header to `""` so
  the initial response's unsupported-response path returns the body (~681) and the tool follow-up (~1321) fails the
  stream with the body text instead of a generic alert and a retry. Update the module header's two stated behaviors.
  _Done_: a streamed `n: 3` request yields three candidates; a mid-stream `error` event fails the request with its
  message; a 200 without `Content-Type` fails with the body text, on the initial response and on the tool follow-up.
  _Test_: `server/src/tests/llmStreamParsing.test.ts` (three choices through the wrapper; an error-only event),
  `server/src/tests/llmProviderAdapters.test.ts` (no header), `src/ts/process/request/tests/transport.test.ts`
  (the tab receives every key, unchanged).
  _Removes_: The OpenAI tool stream wrapper keeps only choice 0; OpenAI in-band stream errors are ignored; A missing
  Content-Type header throws in OpenAI streaming.

- **C6. setObjectValue segments** (_small_, `llm-requests.md`). `server/src/llm/shared.ts` (~38–51) and the
  tab copy `src/ts/process/request/shared.ts` (~34–52): refuse a path segment of `__proto__`, `constructor` or
  `prototype` (skip the parameter with a console warning) and create intermediate objects as own properties only.
  _Done_: an additional parameter `__proto__.x=1` writes nothing to `Object.prototype` on server or tab; ordinary
  dotted paths still apply.
  _Test_: `server/src/tests/llmProviderAdapters.test.ts` (the server setter), `src/ts/process/request/tests/additionalParams.test.ts`
  (the tab setter).
  _Removes_: setObjectValue follows `__proto__` segments.

### D. Translation, transform, diagnostics

- **D1. Translator provider capture and write-back** (_hard_, `translation.md`). `src/ts/translator/translator.ts`:
  the single-sentence combine branch (~701–727) collects the source through `textContent`, as the multi-sentence
  branch does, so the provider receives escaped markup as text (the replacement-node branch ~814–843 keeps
  `innerHTML` because it carries HTML a display script (`editdisplay`) produced; note why in the code). Owner
  decision 2026-11-09 (after D1's run found it): the write-back's Markdown pass (`applyMarkdownToNode`,
  `src/ts/parser/parser.svelte.ts` ~1613–1630, markdown-it with `html: true`) turns escaped text back into tags on
  both paths, and escaping before it breaks code spans, angle-bracket links and KaTeX, so that pass is unchanged
  and H1 records it; the experimental Google branch (~496–520) requests the raw response, checks `d.ok`, and treats
  a non-2xx as the transient failure the direct adapter raises, so the error page is not cached and the fallback
  still runs; `runTranslator` (~344–371) and
  `translateMain` (~412–520) read the provider settings (type, DeepLX URL, experimental mode, the LLM selection)
  once per producer from a snapshot `translateShared` (~214–267) takes with its key, and every chunk and the cache
  key use that snapshot. `shared/database.ts` `MessageTranslation.sourceHash` comment (~1410–1419): "of the
  source `data`".
  _Done_: for `<p>&lt;b&gt;x&lt;/b&gt;</p>` the provider receives the text `<b>x</b>`, not a tag; an experimental
  429 page is not cached;
  switching DeepL to DeepLX during a three-chunk producer yields one provider's result or a failure, never a mix.
  _Test_: `src/ts/translator/translatorMedia.test.ts` (the three cases), `src/ts/translator/translateHtmlLifetime.test.ts`
  (the fallback still runs).
  _Removes_: The experimental Google translator does not check the status; A provider switch during a translation caches a mixed result; The MessageTranslation sourceHash comment
  names the wrong text.

- **D2. Transform snapshot measurement** (_small_, `cbs-rendering.md` with `server-generation.md`; Q9). Extend
  `util/playwright/measureTransformLua.mjs` first: its fixture is fixed at 200 messages (~31) and it sends no
  `handlers` (~177), while snapshots are charged only when `handlers` is present (`server/src/prompt/transform.ts`
  ~824); give it a message-count option, a display handler, and the continuation path, and print the scope and
  target charges. Then run it on a 2,000-message chat of about 6 MiB with that handler (the shape the Display
  Evaluation run used) and record, per scope, the snapshot charge after the shared-entry exclusion
  (`server/src/prompt/transform.ts` ~824–851) and how many targets of a 64-target chunk fit under
  `MAX_SNAPSHOT_BYTES` (~51–54), in `docs/audit/transform-snapshot-2026-11.md` (dated to the run). Rule: if a
  realistic scope alone passes the limit, raise the constant to the smallest power of two that admits it, at most 16
  MiB, and name the measurement in the constant's comment; otherwise change nothing. Record the measured capacity
  in the guide's transform section.
  _Done_: the audit file holds the numbers; the constant matches the rule; the guide names the capacity.
  _Test_: `server/src/tests/transformService.test.ts` (the limit, if changed), `pnpm check:docs`.
  _Removes_: Budget-refused handler rows not re-measured.

- **D3. Request history viewer and share robustness** (_small_, `diagnostics.md`; Q13).
  `src/lib/Others/RequestLogs/LogField.svelte` (~29–35): show a failure state when `copyText` returns false.
  the older-copies refusal starts in `server/src/diagnostics/share.ts` (~125): its outcome type carries a stable
  `code` that `server/src/routes/requestHistory.ts` (~171) forwards on the 500 body; the client transport
  `src/ts/network/requestHistory.ts` (~41), which keeps only the status and the error text today, puts the code on
  `RequestHistoryError`; `src/lib/Others/RequestLogs/ServerRequestHistory.svelte` (~119–127) maps by that code, not
  the English message.
  _Done_: a failed copy says so; the older-copies refusal is localized through its code.
  _Test_: a `LogField` test beside the component (both branches), `src/lib/Others/RequestLogs/ServerRequestHistory.test.ts`
  (the code mapping), a test of `src/ts/network/requestHistory.ts` (the code survives the client parse),
  `server/src/tests/requestHistoryRoutes.test.ts` (the code on the response).
  _Removes_: the Viewer `copyText` bullet and the older-copy mapping bullet of Request history accepted trade-offs
  (the entry itself leaves with H1).

### E. Chat screen

- **E1. Slash command quotes** (_small_, `chat-pipeline.md`). `src/ts/process/command.ts` (~87–97 the quote-aware
  `|` split, ~243–251 the `|||` split, ~352–372 `commandParser`) and its server twin `server/src/prompt/commands.ts`
  (~95–105, ~273–281, ~339–359): strip one pair of surrounding double quotes from a command argument after the
  pipeline split, on both sides, so `/multisend "one|||two"` sends `one` and `two`; `clear`, `{{pipe}}`, `{{slot}}`
  and the part-size limits are unchanged. Update the pinned expectations.
  _Done_: the documented example sends no quote characters; an argument with an inner quote keeps it.
  _Test_: `src/ts/process/command.test.ts` (~474–480), `server/src/tests/commandExecutor.test.ts` (~300–312),
  `server/src/tests/commandSequences.test.ts` (integration unchanged).
  _Removes_: /multisend keeps its quotes.

- **E2. A dead model prop and DefaultChatScreen coverage** (_small_, `ui-theming.md`).
  `src/lib/ChatScreens/ChatBody.svelte` (~56–58, ~88, ~128, ~571–593): drop `modelShortName` from the props and
  the pending memo key; `src/lib/ChatScreens/Chat.svelte` (~1422–1424): drop the per-row `getModelInfo` call that
  fed it (the visible label at ~1282 and ~1684 stays); remove the `modelShortName: ""` lines and the model-change
  case (~710–737) from the ChatBody tests and `tests/ChatStyleProviderFixture.svelte`.
  `src/ts/process/rerollCandidates.test.ts` and `src/lib/ChatScreens/Chat.settledRender.svelte.test.ts` lose
  their `modelShortName` references too. `src/lib/ChatScreens/DefaultChatScreen.drafts.test.ts` (the chosen
  harness, with `Chats` mocked) gains a `Chats`
  stub exposing `followsLatest`, `scrollToLatestMessage` and bindable `holding`, and three cases: the
  `ShowLatestMessageStore` effect (~318–322) scrolls once and clears the store; the reroll swap (~624–637) scrolls
  after a tick only when the view followed the latest message; the scroll handler (~1139–1144) skips load-more
  while `holding`.
  _Done_: no `modelShortName` reference remains in `src/`; the three paths have a mounted test.
  _Test_: `src/lib/ChatScreens/ChatBody.svelte.test.ts`, `src/lib/ChatScreens/DefaultChatScreen.drafts.test.ts`.
  _Removes_: ChatBody's modelShortName no longer changes the body; Latest-message start scroll untested in
  DefaultChatScreen.

- **E3. Screenshot font CSS** (_small_, `ui-theming.md`). `src/lib/ChatScreens/screenshotCapture.ts`
  `prepareScreenshotCapture` (~8–26): before `getFontEmbedCSS`, inline the stylesheet's `@import` rules into the
  prepared CSS (fetch once, as html-to-image does) and pass the library a stylesheet set without them, or record the
  rule count before the call and remove the rules html-to-image appended after the export; either way a second
  export adds no rules. `util/playwright/measureRenderWork.mjs` (~109–134): the fixture's stylesheet gets an
  `@import` webfont so E4 and later runs measure it.
  _Done_: five exports in one session leave the document's rule count where one export left it; the fixture
  imports a webfont.
  _Test_: `src/lib/ChatScreens/screenshotCapture.test.ts` (the rule count across two preparations with a fake
  `@import`).
  _Removes_: Repeated screenshot exports grow the live stylesheet.

- **E4. Screenshot memory** (_hard_, `ui-theming.md`; Q10; after E3). Investigate first: extend
  `util/playwright/measureRenderWork.mjs` (~577 samples once around the whole export and reads the heap after it)
  to sample the renderer's `VmHWM` after each page and take a heap snapshot after the export, then run it on the
  150-row fixture to name what grows with rows (the per-row captures under `src/lib/ChatScreens/`, the
  DOM-to-canvas clones, the page canvases); record in `docs/audit/screenshot-memory-2026-11.md`. Then release that
  per page in `src/lib/ChatScreens/screenshotExport.ts` and `DefaultChatScreen.svelte` (~983–1019), and in the
  planner (~79–96) scale a row over `MAX_EXPORT_PIXELS` to the area budget with the same scale in planning and
  capture (Q10). Rule: the peak after the change is under one page plus the largest row, or the audit says by how
  much it misses and why.
  _Done_: the 600-row export's `VmHWM` rise is bounded by one page plus one row, or the audit file states the
  measured miss and its cause (that completes the slice too); a 2,400 × 8,192 CSS-pixel row at DPR 2 exports as
  one page under the pixel budget.
  _Test_: `src/lib/ChatScreens/screenshotExport.test.ts` (the oversized row is scaled; per-page release), the
  driver run recorded in the commit message.
  _Removes_: The screenshot peak grows with the row count.

### F. Client and plugins

- **F1. File sources and the appendable buffer** (_hard_, `assets.md` with `global-api.md`; Q11).
  `src/ts/globalApi.svelte.ts`: `loadFileSrc` (~368–420) returns a `/sw/img` URL only while
  `navigator.serviceWorker.controller` is set, else takes the `blob:` fallback, and a `controllerchange` that leaves
  the controller null (the listener in `src/ts/bootstrap.ts` ~371–380) clears `knownSwPaths` and the `fileSources`
  map (~316, which returns a cached promise without calling the loader) and, through an exported invalidation, the
  parser's `fileSrcCache` (`src/ts/parser/parser.svelte.ts` ~482), so the next read takes the `blob:` path; a
  controller that appears mid-page needs no invalidation, since the `blob:` URLs made before it stay valid. A new
  opt-in read (an option on `getFileSrc`, or a sibling `getFileSrcOrFail`) rejects on a read failure while the
  shared loader keeps resolving `""`, and the parser's asset and inlay passes (`src/ts/parser/parser.svelte.ts`
  ~681–770, ~934–942, through `readRenderIO`) use it so a transient failure takes the parser's local retries
  (`src/lib/ChatScreens/ChatBody.svelte` ~454: 250 ms, then 1 s; the five-second `displayTransformRecovery` rounds
  belong to reported `editdisplay` failures and are not involved); `AppendableBuffer.append`
  (~1046–1058) starts growth from `Math.max(this.#buffer.byteLength, 128)`, so a full `deappend` cannot leave a
  zero-length backing array that never grows.
  _Done_: after a controller loss, a path cached as `/sw/img` is read again and yields a `blob:` URL; a failing
  asset read in a row is retried locally twice and then surfaces as a render failure; `deappend` of the whole
  buffer followed by `append` returns.
  _Test_: `src/ts/globalApiRetention.test.ts` or `globalApiThumbnails.test.ts` (the controller check; the
  invalidation after a controller loss; the rejecting read), `src/ts/parser/tests/parseMarkdownLifetime.test.ts`
  (the retry classification),
  `src/ts/characterCardsPngImport.test.ts` (the full deappend).
  _Removes_: loadFileSrc can return /sw/img on an uncontrolled page; getFileSrc never rejects, so asset reads are
  never retried; AppendableBuffer can hang after a full deappend.

- **F2. Display apply after local ui writes** (_small_, `ui-theming.md`). Extract the four-call apply step of
  `src/ts/bootstrap.ts` `watchRemoteRecords` (~327–338: `updateColorScheme`, `updateTextThemeAndCSS`,
  `updateAnimationSpeed`, `updateGuisize`) into `src/ts/gui/colorscheme.ts` (or a sibling) and call it from the
  recovered-`ui`-draft apply in `src/ts/storage/journalRecovery.ts` (~682–703, ~997–1015, after `changeLanguage`)
  and from `applyPluginKey` in `src/ts/plugins/apiV3/v3.svelte.ts` (~1844–1888) when a display key changes;
  `changeColorScheme` and `updateCustomColorScheme` (`colorscheme.ts` ~217–230) and the plugin `setColorScheme`
  (`v3.svelte.ts` ~2481–2505) call `updateTextThemeAndCSS()` after `updateColorScheme()`, as `changeColorSchemeType`
  does.
  _Done_: a light preset applied from a dark one shows dark text at once; a recovered `ui` draft and a plugin
  `textTheme` write change the page without a reload.
  _Test_: `src/ts/gui/guiRecords.test.ts` (text CSS after the writers), `src/ts/bootstrap.journalRecovery.test.ts`
  (the apply after recovery), `src/ts/plugins/apiV3/hostApiRouting.test.ts` (the plugin paths),
  `src/ts/storage/tests/resourceSyncLive.test.ts` (remote unchanged).
  _Removes_: Scheme writers skip the text theme; Local ui writers skip the display apply.

- **F3. Card import preset hash** (_small_, `characters-modules.md`; after B5).
  `src/ts/characterCards.ts`: the `#import_preset=` branch (~829–838) opens the settings only when `importPreset`
  returns an id, like the drop and `#share_preset` paths. The retained-text entry that shared this slice is Recorded
  instead (H1, `assets.md`, beside the PNG Limitation; decided 2026-11-09, AUD-5): `saveAssets` calls an item's
  `load` again to repair a missing file at completion (`src/ts/storage/assetQueue.ts` ~71, ~480) and the card
  hand-off keeps and calls it again (`characterCards.ts` ~110), so a JSON or V3 card's asset payloads stay
  reachable until the hand-off ends whatever their encoding; decoding up front would hold the bytes of every asset
  (a quarter less than the text) rather than one asset at a time, and a re-readable source would mean re-parsing
  the JSON per asset.
  _Done_: a refused `.risup` from the hash opens no settings.
  _Test_: `src/ts/characterCards.share.test.ts` (the hash path).
  _Removes_: #import_preset opens the settings after a refusal.

- **F4. Editor highlighting and playground strings** (_small_, `cbs-rendering.md` with `settings-i18n.md`).
  `src/ts/gui/highlight.ts` `simpleCBSHighlightParser` (~470–489): an unmatched `}}` leaves `depth` at 0.
  `src/lib/Playground/PlaygroundInlayExplorer.svelte` (~254, ~260–264): the `Delete` and `Loading...` literals
  become `language.playground` keys in `src/lang/en.ts` (and `ko.ts`); the test lookup follows.
  _Done_: `}} {{char}}` highlights `{{char}}`; the two strings come from the language table.
  _Test_: `src/ts/gui/highlight.test.ts`, `src/lib/Playground/PlaygroundInlayExplorer.test.ts`.
  _Removes_: A stray }} ends CBS highlighting; Inlay explorer hard-codes two strings.

- **F5. Small client utilities** (_small_, `global-api.md`; Q14). `src/ts/util.ts`: `searchTagList` (~1050–1053)
  compares lowercased values and aliases; `replacePlaceholders` (~119–125) uses `name`, falling back to the
  selected character and never throwing without one. `src/ts/tokenizer.ts` `getCharToken` (~312–328) returns zero
  counts with no character. `src/ts/sourcemap.ts` `translateStackTrace` (~65–103) keeps its timer until the body
  is read. `src/ts/storage/selection.svelte.ts` `selectLoreBookPage` (~134–140) applies `loadSelection`'s
  nonnegative-integer check and falls back to 0.
  _Done_: "oc" suggests `OC`; the placeholders use the passed name; the three guards hold.
  _Test_: `src/ts/util.test.ts` (the tag and the placeholders), `src/ts/tokenizer.test.ts`,
  `src/ts/sourcemap.test.ts` (a stalled body ends at 10 s), `src/ts/storage/tests/selection.test.ts`.
  _Removes_: searchTagList never matches the OC tag by name; replacePlaceholders ignores its name parameter;
  getCharToken rejects with no selected character; The source map fetch timeout ends before the body;
  selectLoreBookPage stores any number.

- **F6. Settings page writers** (_small_, `settings-i18n.md` with `media-aux.md`).
  `src/lib/Setting/Pages/PluginSettings.svelte`: the radio suffix parse (~291–301) stores the parsed number only
  when `Number.isFinite`, else the option's default; the remove button's comment (~191–208) says that owned writes
  are refused once the plugin leaves `settings.plugins` and that the delete-after-`loadPlugins()` order protects
  legacy and custom keys. `src/lib/Setting/Pages/ImageGenerationSettings.svelte` (~463–471, ~522–539): a vibe
  file's `information_extracted` is stored only when finite. `src/lib/SideBars/CharConfig.svelte` VOICEVOX
  inputs (~1193–1203): an emptied `NumberInput` writes the field default, not `null`.
  `src/lib/Setting/Pages/Storage/storageController.svelte.ts` (~54–58): remove the unread `owners` derived.
  _Done_: a malformed plugin radio suffix, a malformed vibe file and an emptied VOICEVOX field store finite numbers;
  no `owners` on the controller.
  _Test_: `src/lib/Setting/Pages/ImageGenerationSettings.test.ts`, a `PluginSettings` test beside the existing
  permissions test (the radio parse), `src/lib/SideBars/CharConfig` or `src/ts/process/ttsPlayback.test.ts` (the
  default on empty), `src/lib/Setting/Pages/Storage/storageController.test.ts`.
  _Removes_: Nested numeric settings can be stored as null; StorageController.owners has no reader; The plugin
  remove button's comment predates the owned-write refusal.

- **F7. Plugin database reads and bulk adds** (_hard_, `plugin-sandbox.md` with `persistence.md`; after F2).
  `src/ts/plugins/apiV3/v3.svelte.ts` `applyPluginCharacters` (~1724–1745): new characters go through one
  `addPreparedCharacters` that builds its index once, checks new ids against a `Set`, and inserts through a batch
  path in `src/ts/storage/records.svelte.ts` that carries that uniqueness past `requireNewId` (~3120–3131; a
  caller's pre-check does not help, since every `insertCharacterRecord` ~3212 still runs its `.some` scan), then
  runs `checkCharOrder()` once (`src/ts/storage/characterStore.svelte.ts` ~237–249,
  `src/ts/storage/characterOrder.ts` ~45–85); `getChatFromIndex` (~2603–2606) and `setChatToIndex` (~2714–2719)
  require a nonnegative integer index and then resolve one id through `chatMemberPage(chaId, i, i + 1)` instead of
  `chatList(chaId)` (`chatMemberPage` slices, so an unchecked `1.5` would reach chat 1 where today it resolves
  nothing). The detached read (~1280–1328): a fresh response
  is fenced by the algorithm captured before its await the way cache hits are (`src/ts/plugins/apiV3/detachedChatCache.ts`
  ~146–168); when the algorithm changed, the read refreshes once with the new one, in both directions.
  _Done_: `setDatabase` appending 300 characters does 300 index visits and one order repair, not 300 × list;
  `setChatToIndex(0, 1.5, chat)` writes nothing; a plugin reading across a switch into Structured Memory gets the
  projection for an unloaded chat.
  _Test_: `src/ts/plugins/apiV3/v3SetDatabase.test.ts` (visit and record-scan counts through the insertion
  boundary), `src/ts/plugins/apiV3/hostApiChats.test.ts`
  (the index accessors), `src/ts/plugins/apiV3/getDatabaseDetached.test.ts` (fresh switch-in and switch-out).
  _Removes_: Bulk plugin character adds stay quadratic; A memory algorithm switch during a detached read omits its
  projection.

- **F8. Sandbox host lifecycle** (_small_, `plugin-sandbox.md`; after F7). `src/ts/plugins/apiV3/factory.ts`: the
  guest and host copy helpers (~229–235, ~279–283, ~821–827, ~903–908) define own properties (a null-prototype
  object or `Object.defineProperty`) so an own `__proto__` key round-trips; the CALL handler (~1009–1034) creates a
  host-side `AbortController` per call that `terminate` (~1147–1175) aborts along with the guest-signal controllers,
  so an unsignalled `nativeFetch` ends with its plugin. `src/ts/plugins/apiV3/v3.svelte.ts` `executePluginV3`
  (~3383–3407): register the instance after `host.run` returns (it is synchronous, `factory.ts` ~946), and when
  `run` throws terminate the partly started host so no iframe stays in the DOM without a list entry. Update the
  guide's abort invariant for the per-call controller; the unload-window and deferred-reload hazards
  (`plugin-sandbox.md` ~289, ~297) stay true and stay.
  _Done_: `pluginStorage.getItem` returns an object stored with a `__proto__` key intact; a terminated plugin's
  pending `nativeFetch` is aborted; a plugin whose `run` throws is not listed as loaded and its iframe is gone.
  _Test_: `src/ts/plugins/apiV3/guestBridge.test.ts` (the round trip), `src/ts/plugins/apiV3/nativeFetchAbort.test.ts`
  (the unsignalled fetch), `src/ts/plugins/pluginLifecycle.test.ts` (the failed start).
  _Removes_: The sandbox bridge drops an own `__proto__` key; the `executePluginV3` and `terminate` bullets of
  Plugin reload deferral leftovers (the entry itself leaves with H1).

- **F9. Parser caches and imported chat data** (_small_, `cbs-rendering.md` with `chat-store.md`; after F1).
  `src/ts/parser/parser.svelte.ts` `fileSrcCache` (~482–492): bound it (a count-bounded map that evicts the oldest
  entry not in flight, say 2,000) and list the bound in the guide's parser caches. `src/ts/storage/chatStore.svelte.ts`
  `prepareMessages` (~1592–1605): refuse a message whose `data` is not a string with a plain `Error` carrying a message, as
  the client's own `patchMessage` check does (~3789; the server's `ResourceValidationError` stays server-side), so
  a JSON chat import cannot store one.
  _Done_: rendering 3,000 distinct assets keeps at most 2,000 cached sources; an imported chat with a numeric `data`
  is refused with a message.
  _Test_: `src/ts/parser/tests/parseMarkdownLifetime.test.ts` (the bound), `src/ts/storage/tests/chatStore.test.ts`
  (the refusal), `src/ts/charactersImportChat.test.ts` (a JSON chat import with bad data, through
  `src/ts/characters.ts` ~530).
  _Removes_: the `fileSrcCache` and JSON-import bullets of Asset-scale client leftovers (the entry itself leaves
  with H1).

- **F10. Web Push client race and server no-store** (_small_, `network-jobs.md` with `self-host-server.md`).
  `src/ts/network/pushNotifications.ts` `ensureSubscribed` (~353–400): after `pushManager.subscribe` returns (~383),
  read the opt-out flag once more and, when it is set, unsubscribe the new subscription and return without a
  stamp. The re-read before the call already exists inside `serial` (~468): with Web Locks a disable waits behind
  the reconcile, but without them `serial` is module-local (~206) and tab B can disable during the awaits before
  `subscribe`, which only a check after it closes. `server/src/routes/push.ts` (~24–47): the limiter, JWT and
  body-cap rejections answer with `no-store` (a middleware that sets it first, or the push family added to
  `server/src/app.ts`'s no-store families ~742–814), so the header comment holds.
  _Done_: without Web Locks, a disable in tab B during tab A's awaits before `subscribe` leaves no subscription;
  a 429, 400 and 413 from `/api/push/*` carry `Cache-Control: no-store` (a JWT failure answers 400,
  `server/src/routes/auth.ts` ~21).
  _Test_: `src/ts/network/pushNotifications.test.ts` (the race with two modules and no `navigator.locks`),
  `server/src/tests/push.test.ts` (the three rejections' headers).
  _Removes_: the opt-out race and `no-store` bullets of Web Push leftovers (the entry itself leaves with H1).

### G. Build and test tooling

- **G1. Docs tools** (_small_, `build-test-platforms.md`). `util/docsBudget.mjs`: the list-marker test (~76,
  ~182–211) strips a leading `> ` so a blockquoted item is measured; the table-row collapse (~194–200) collapses
  whitespace outside code spans only (`replaceCodeSpans` ~90–103); `pathProblem` (~378–391) checks every brace
  alternative and returns success only when each is present or ignored. The command-line blocks of
  `util/docsBudget.mjs` (~853–859), `util/docsContracts.mjs` (~403–407), `util/docsLedger.mjs` (~389–431),
  `util/docsOwner.mjs` (~207–209) and `util/docsRead.mjs` (~97–103) ignore `EPIPE` on `process.stdout` and keep
  every other error and exit code.
  _Done_: `> - <601 chars>` is reported; a row with 601 spaces in a code span is reported; `src/{ignored.local,missing.ts}`
  reports `missing.ts`; `pnpm --silent docs:contracts <file> | head -3` prints no stack.
  _Test_: `util/docsBudget.test.ts` (the three cases); the EPIPE behavior checked by hand in the commit message
  (the CLI blocks are untested by design, `build-test-platforms.md`).
  _Removes_: check:docs does not measure blockquoted items; check:docs collapses spaces inside a row's code spans;
  An ignored path can hide a broken sibling in a guide; docs:contracts crashes on EPIPE under head.

- **G2. e2e type check and spec selection** (_small_, `test-harness.md` with `build-test-platforms.md`). Add
  `e2e/tsconfig.json` extending the root config with `include: ["**/*.ts"]` (resolved from the config's own
  directory; `e2e/**/*.ts` there would look for `e2e/e2e/` and find nothing), Node and Playwright types, and a
  type-only `paths` mapping `/src/*` to `src/*` over the inherited root `baseUrl`; wire
  `tsc -p e2e/tsconfig.json --noEmit` into the `check` script (`package.json` ~13); fix the narrowing at
  `e2e/multiClient.spec.ts` (~391–397) with the `isChatOrderConflict` predicate from `shared/resources.ts` (~182):
  the `kind === "chatOrder"` comparison already there cannot exclude `ResourceConflict`, whose `kind` is `string`. `util/agentE2e.mjs` `staticImports` (~68–80): resolve a relative import to its on-disk path (the exact
  path, then `.ts`, `.svelte.ts`, then `index.ts`) with the supplied read function before recording it, so a helper
  change selects the specs that import it.
  _Done_: `pnpm check` reports a type error planted in a spec; `selectSpecs` for `e2e/multiClient.ts` selects the two
  multi-client specs. Update the test-harness guide's two commands.
  _Test_: `util/agentE2e.test.ts` (extensionless imports), the `pnpm check` run in the commit message.
  _Removes_: pnpm check does not type-check e2e specs; Automatic browser spec selection misses extensionless
  imports.

- **G3. Manual drivers** (_small_, `test-harness.md`). `util/playwright/checkJobProtocol.mjs` (~648–672): every
  case already opens the app through `fixture()` (~380), and the recorded failure was a page reboot about 6 s into
  the `sigkill-before-checkpoint` case, so a warm-up does nothing (G3's run found this; decided 2026-11-09). Instead,
  record the owner page's main-frame navigations (`framenavigated`) and the stack log's Vite "optimized dependencies
  changed. reloading" line during each case; a failing case that saw a navigation names the reload as its cause, and
  when the Vite line is present it reruns that case once on a fresh fixture, so a dependency-optimization reload
  cannot be read as the protocol failing.
  `util/playwright/checkServerSend.mjs` (~335–351, ~376–404): clear the safe-boot attempts
  (`clearSafeBootAttempts`, `stack.mjs` ~230–234) before the reload cases and print any `[data-alert-dialog]` text
  before `openCharacterChat`, so a recurrence names its alert.
  _Done_: both drivers pass on a fresh tree twice in a row (recorded in the commit message); a planted alert is
  printed; a planted mid-case reload is named as the cause.
  _Test_: the two driver runs.
  _Removes_: checkJobProtocol's first run after a source change fails its SIGKILL case; checkServerSend once hit an
  alert after its mid-stream reload.

- **G4. Gate tests on controlled clocks** (_hard_, `test-harness.md`). Test-only, one file at a time, without
  weakening a production deadline: `src/ts/storage/tests/draftJournal.test.ts` (~357–384, ~1394–1420) fakes
  timers around the journal start and adoption; `server/src/tests/hypaV3Parts.test.ts` (~1366–1387, ~1751–1770)
  passes a controlled separator budget or fakes `performance.now`; `server/src/tests/transformService.test.ts`
  (~128–134, ~201–213) replaces the `setTimeout(2)` poll and the 5 ms sleep with latches;
  `server/src/tests/transform.test.ts` (~225–452, ~910–1099) separates real-worker cases from deadline cases and
  tags the production-limit cases `slow` (a clock injection in `server/src/prompt/transform.ts` ~276–304 only if a
  latch cannot do it); `src/ts/storage/tests/bootCacheServer.test.ts` (~184–270, ~485–516) overrides the 3 s cache
  deadline for the test; `src/lib/ChatScreens/Chat.draft.test.ts` (~335–400) moves the auto-popup cases onto fake
  timers; `src/ts/network/generationJobs.test.ts` (~872–1025) fakes the connect timeout for the follow cases as the
  liveness block does (~1813–1830); `src/ts/process/serverCommands.test.ts` (~220–231) replaces the
  `realSetTimeout(0)` flush with a latch on the condition each case awaits, keeping a real-timer turn where a case
  needs a full event-loop turn and saying so. `server/src/tests/push.test.ts` needs nothing. Also
  warm or latch the two `cbsLimitsHost.test.ts` (~557–568) and `lore.test.ts` (~1147–1186) cases the Stop B entry
  names, or tag them `slow`. `pnpm --silent test:agent --slow-tests` before and after, in the commit message.
  _Done_: each named case passes under `taskset -c 0` with the suite's load, three runs; no production constant
  changed.
  _Test_: the files above; `pnpm check:tests` if the slow-test table changes.
  _Removes_: Gate tests still racing real time; the load-flake bullet of Stop B leftovers (the entry itself leaves
  with H1).

### H. Inbox and guides

- **H1. Recorded and closed items leave the inbox** (_small_, wide; the guides named below; after every other
  slice; Q1, Q3, Q4, Q5, Q8, Q12, Q15, Q16). For each Recorded item in the Index, add the Limitation sentence with
  the decision date to the named guide's Known Hazards (adding a `### Limitations` heading where the guide has
  none), under the ceiling, verifying each identifier first:
  `chat-pipeline.md`: a throwing `svelte/store` subscriber leaves the shared queue mid-run (`localSends`; no known
  thrower).
  `resource-sync.md` and `server-generation.md`: `loreBook` and `globalscript` travel whole (no item ids), creates
  and `ChatPatchBody.meta` travel whole, the sockets have no compression (HTTP reads do), the `ChannelChunk`
  recovery snapshot and legacy cumulative fallback remain beside the sequenced appends (`shared/jobs.ts` ~873),
  `emitRecords` sends non-job records whole, every job parses its whole scope; the fixed bullets (plugins by name
  key, HTTP compression, the settling `flushResources`, the deleted-speaker lookup, the Lua reparse, the
  cumulative-only transport) are deleted with a note; the real-browser chatPatch check goes to the Owner checklist.
  `memory.md` (Deferred stored summaries): the three replay approximations, as accepted on 2026-10-27.
  `server-resources.md`: the change log's worst case (20,000 rows × up to 512-unit ids, 82 MB in the probe, no
  VACUUM on prune) and the snapshot budget that counts it (Q4); a custom-key asset rewritten during a version-2
  export may pair the database copy with later bytes (Q5).
  `diagnostics.md`: the request-history capture, store, structured-failure, journal, browser-collector and
  report-sharing trade-offs that are not there yet (one sentence each, the settled ones deleted with a note), and
  that the sockets' protocol numbers reach the server console only (Q8).
  `llm-requests.md`: the capture trade-offs the LLM transport owns (an aborted capture's untrimmed credential
  prefix, logged text versus wire bytes, completion order) and the Responses stream error as answer text.
  `live-update-feed.md`: `proto` is logged, not recorded (Q8).
  `cbs-rendering.md`: the aborted first transform call's snapshot (R4) and the withdrawn forced refresh (RW3), as
  accepted on 2026-11-05 and 2026-11-06.
  `ui-theming.md`: pixel anchoring across far and near rows has no kept browser test; Firefox and Safari were never
  driven for the chat list.
  `assets.md`: every plain `getFileSrc` read pins its URL for the page (D2b, 2026-10-23) if the guide does not say
  so; the asset UIs' first filter after an edit copies the live state once; beside the PNG Limitation, a JSON or
  V3 card's embedded asset payloads stay reachable until the import's hand-off ends, because `saveAssets` and the
  hand-off replay an item's `load` (F3's former entry; 2026-11-09).
  `translation.md`: the experimental Google translator translates per stream frame (upstream behavior); the
  write-back's Markdown pass (`applyMarkdownToNode`, `html: true`) turns escaped markup in a translated paragraph
  back into tags on the single- and multi-sentence paths (owner decision 2026-11-09, D1; `ChatBody` sanitizes the
  result, and escaping before the pass breaks code spans, angle-bracket links and KaTeX).
  `network-jobs.md`: a notification click whose route is `/` only focuses the window; the enable button's user
  activation and `navigator.serviceWorker.ready` during an upgrade are browser behaviors the tests cannot show
  (Owner checklist).
  `settings-i18n.md`: locales other than `en` and `ko` are partial overrides that fall back to English (Q12), if
  not stated.
  Closed with a reason in the commit message: Deferred lore behaviors (both bullets in `chat-pipeline.md` and
  `characters-modules.md`; Q3), Duplicate plugin names can share a popup editor target (`plugin-sandbox.md` Issues;
  Q15; its link at ~271 to the deleted research heading is replaced by the conditions stated in place), the heap D3 bullet (no identifier; Q16), the parser fuzzy-lookup test-gap bullet (a test inventory, not a
  defect), the unload-fence bullet of Plugin reload deferral leftovers (`plugin-sandbox.md`), and the settled Stop B
  bullets (capture listeners, `creation_date`). The push dedupe bullet is already in `network-jobs.md`.
  _Done_: every Recorded item is in its guide with its date; after H1's landing commit `found-issues.md` has no
  entries, its Contents list is empty, and its intro says the inbox was emptied on that date by this plan;
  `pnpm check:docs` passes.
  _Test_: `pnpm check:docs`, `pnpm docs:ledger` for each guide that lost a sentence to a trim.
  _Removes_: every entry the Index marks Recorded or Closed, and the collection entries whose code bullets D3, F8,
  F9, F10 and G4 took.

## Owner checklist

Checks only a real device or deployment can show; each is listed where its slice or guide names it, and none blocks
a slice. The owner runs them when convenient and records the result in the guide's Known Hazards or deletes the
line.

- Chat list on Firefox and Safari: far-row containment, pixel anchoring across far and near toggles, the newest-first
  reveal (H1 records the gap in `ui-theming.md`).
- A live Realm import: prepare, commit, a tab closed after prepare (B5's cancel), a 503 during commit (B5's retry).
- Docker with a chrooted sftp account: the account reads `shared/` and not `save/data/` (`diagnostics.md`).
- Web Push in Chrome and Firefox: the enable button right after a reconcile (user activation), a service-worker
  upgrade during a subscribe, a notification click whose route is `/`.
- The chatPatch transport in a real browser (a long reply watched with DevTools' socket frames).
- A `/sw/img` URL after a lost controller (F1 adds the guard and the invalidation; the reproduction is still
  unconfirmed).
- A Gemini thinking model with `saveSignatures` on: the second request of a chat replays the stored token and the
  provider accepts it (C4 can only check the body).
- A real-browser run of `util/playwright/measureHeap.mjs` after a module delete, if a heap plan returns (Q16).

## Verification

- Per slice: the `_Test_` files, `pnpm check`, `pnpm --silent test:agent` (whole, once, after the last edit),
  `pnpm format:check`, the owning guide's focused checks, and `pnpm check:docs` for any guide edit
  (`pnpm docs:ledger` for a trim).
- Measurements, recorded in `docs/audit/` and the commit message: A4 (schema token counts), D2 (snapshot charges and
  capacity), E4 (`VmHWM` per page before and after).
- Driver runs, recorded in the commit message: E3 and E4 (`measureRenderWork.mjs`), G3 (both drivers twice), G4
  (`--slow-tests` before and after).
- At the end of the run: the whole suite with the slow tag, the e2e specs the changed files select (G2's selector),
  `pnpm check:docs`, and `found-issues.md` with no entries and an empty Contents list.
