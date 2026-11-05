# Found Issues Sweep Plan

Status: drafted 2026-11-05; the owner accepted every open question's recommendation the same day; landed:
A1 (5d20f1e28), D2 (ba8849a05), F2 (4edfb27ab), C1 (c34f52416), B1 (fc21926be), J1 (406e15d19), E2 (6555c82e2), C2 (69370bec5), H2 (ded072314), E3 (3849a272f), C4 (35e64b332), D1 (dbee2cde6), H1 (5c2bef411), G1 (24b817a55), E1 (5cd2b42f9), B2 (189efd11a), C3 (bb237d142), I3 (f848dad03). Source: the 104 entries of [found-issues](../research/found-issues.md) as of `cc1fc4008`, each
re-checked against that tree the same day by eleven read-only workers whose file and line evidence was
spot-checked. Every entry has a disposition in the **Index**: a slice here, an **Open question** for the
owner, **Deferred** work for a later plan, or **Stays** (an accepted trade-off or a note that is reference
material, not a defect). Line numbers in the slices are from that check; identifiers are the anchors.
Re-verify each cited location before editing (STRUCTURE.md protocol step 5).

Selection rules, in the order they were applied:

1. A confirmed defect a user or a plugin author can meet, whose fix is local to one file cluster and has a
   test: a slice.
2. Dead code, a stale comment that states a contract, a test workaround for a bug that is gone, a red spec,
   and a mock that invariant V7 forbids: a slice, grouped with the nearest code slice or into a hygiene
   slice.
3. A guide or tooling correction the Guides To Source run could not make from a slice: a docs slice. Guide
   edits respect the byte ratchet (`pnpm check:docs`), so a sentence added to a guide at its ceiling is paid
   for with a trim in the same edit.
4. A fix whose direction the owner has not chosen: an **Open question** with a recommendation; the slice
   that would carry it says which question gates it.
5. Work that needs a design (a new protocol form, a new channel, an investigation): **Deferred**, grouped the
   way a later plan should pick it up.
6. Accepted trade-offs, latent paths with no producer, flakes seen once, and notes kept for a future review:
   **Stays**; they leave the inbox only through a Known Hazards entry or when they settle.

One slice is one session, one commit, one file cluster. Each slice names its owning guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Every slice updates the owning guide's
`Flows`, `Invariants`, or `Known Hazards` where it changes a documented contract and removes the matching
hazard entry when it fixes one. Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow`
for one marked _hard_. Each slice ends with its regression test (under _Test_), `pnpm check`,
`pnpm --silent test:agent` for the files it touches and then once whole, the guide's focused checks, and
`pnpm format:check`. A slice does not edit `found-issues.md`: the entries it closes (under _Removes_) are
deleted, with the section counts in that file's Contents list, in the landing commit that marks the slice
landed here, so parallel slices never conflict on the inbox. An entry a slice finds already fixed is removed
the same way with a note in the commit message.

## Open questions

The owner accepted every recommendation on 2026-11-05. Each gated slice carries the accepted answer only;
no slice waits on a question.

| Q   | Question                                                                                                                                                                                                                                                            | Accepted answer                                                                                                                                                                                | Gates |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Q1  | Should `{{// ...}}` be stripped from rendered and prompt text? `shared/cbs/registry.ts:2483` registers it `doc_only` and `commentMode` in the evaluator is never set true; upstream behaves the same; only lore key matching strips it.                             | Keep it literal (client/server and upstream parity, `cbs-parity.json`) and record it under cbs-rendering Known Hazards > Limitations in M2.                                                    | M2    |
| Q2  | Image compression passes `75` where the canvas API takes 0–1 (`lossyCompression.ts:37,41`), so the browser uses its default (about 0.92). Change to `0.75`? It changes exported card and module bytes.                                                              | Change it: the literal shows the intent and the setting is named compression.                                                                                                                  | J1    |
| Q3  | A V2/V3 JSON card whose `lowLevelAccess` question the user declines falls through to the off-spec import (`characterCards.ts` ~196–201). Should the decline end the import?                                                                                         | Yes: `importCharacterCardSpec` tells a decline apart from "not a V2/V3 card" and the caller returns before the off-spec path.                                                                  | A1    |
| Q4  | `CustomModelsSettings.svelte` offers every `LLMFlags` button but `poolSupported` (11). Is the flag meant for `xcustom:::` models?                                                                                                                                   | Add the button; a custom endpoint that pools should be able to say so. Otherwise E1 adds the clause to llm-requests' missing-options hazard.                                                   | E1    |
| Q5  | After an owner switch a cancelled callback's hook may still run on the old tab while the worker's lane starts the next callback (`switchOwner`, `holdDraining`). Should the switch also wait for the old lane's drain holds, or is the overlap a stated limitation? | State it as a limitation in server-generation (G1 adds the sentence); waiting on drain holds would delay every switch by up to the 60 s bound for a write that is already fenced per callback. | G1    |
| Q6  | A remote settings record replaces the settings without calling `updateColorScheme`, `updateTextThemeAndCSS`, `updateAnimationSpeed`, or `updateGuisize`; `colorscheme.ts`'s contract says so. Should the remote apply re-run them?                                  | Yes, after the two-tab confirmation D2 starts with: a theme that differs from the settings until a reload is a defect, not a design.                                                           | D2    |
| Q7  | `risuai.d.ts:1660` documents `saveSecretHeader(key, prefix, value)` and `{ secretHeader }` in `nativeFetch` headers; the host only warns and `nativeFetch` has no such branch. Keep upstream's declaration?                                                         | Keep the signature for upstream parity and mark the API not implemented in the declaration's comment (E1), so an author gets the truth where they read it.                                     | E1    |
| Q8  | The chat file picker offers `mpeg` and `avi`, which `postInlayAsset` refuses silently. Drop them from the picker, or store them (adding them to `inlayVideoExts` and `shared/assetMime.ts`)?                                                                        | Drop them: the player support for both containers is poor and storing them widens the asset MIME table.                                                                                        | B1    |
| Q9  | The feed's `removed` list includes an id the same group inserted while `ChatWriteChange.removed` filters it (`server/src/data/chatStore.ts` ~1603, ~2172). Filter the feed too, or document the asymmetry?                                                          | Filter the feed (`insertedHere`) so both faces agree; the client ignores an unknown removed id today only when the count still matches, so the filter also removes a latent mismatch.          | H2    |
| Q10 | Agent Read Protocol step 1 reads Repository-Wide Invariants on every lookup (about 9.5 KB per read-only lookup). Limit it to add and change tasks, as D9 of Guides To Source did for a guide's `Invariants`?                                                        | Yes, in M2 with the routing words.                                                                                                                                                             | M2    |
| Q11 | A transform chunk already sent before a chat switch runs to completion on the server (1 / 2 / 4 chunks at 30 / 150 / 600 rows). Does the Render Work Budget's one-chunk bound matter?                                                                               | Accept the measured behavior and record it in the audit; a per-chat cap on chunks in flight is a transport change for a bounded cost. No slice.                                                | none  |

## Index

Every entry of `found-issues.md`, by its section and heading there, with its disposition. "Stays" entries
keep their place in the inbox; "Deferred" entries are grouped under **Deferred** below.

| Section                            | Entry                                                                | Disposition                                   |
| ---------------------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| Chat store, sync, and change feeds | Parked resends leak                                                  | Stays (accepted, A3 of Open Bug Fixes)        |
|                                    | Store subscriber throw queue                                         | Stays (latent)                                |
|                                    | discardRefusedChat reads without a deadline                          | H2                                            |
|                                    | No guide states the restore floor's check order                      | M2                                            |
|                                    | Phase 6 review leftovers                                             | Stays (soft spots; move to hazards as met)    |
|                                    | The feed's removed ids include ids the same group inserted           | H2 (Q9)                                       |
|                                    | A remote settings record does not re-apply the theme                 | D2 (Q6)                                       |
|                                    | A retaken handoff job drops its live stream                          | Deferred: handoff follow-up                   |
|                                    | pluginStorage writes still reach other tabs whole                    | Deferred: feed patch forms                    |
|                                    | flushResources resolves after a restore halt                         | Stays (until a caller relies on it)           |
| Server jobs and prompt assembly    | Tool schemas are outside the assembly token budget                   | Deferred: token counting                      |
|                                    | No-memory trim question gaps                                         | Deferred: trim question design                |
|                                    | Blank history entries and the meters                                 | F2                                            |
|                                    | Unreferenced client copies of server prompt helpers                  | B2                                            |
|                                    | Server chat template comment narrows when it throws                  | E1                                            |
|                                    | `{{// ...}}` stays literal in rendered and prompt text               | M2 (Q1)                                       |
|                                    | The regex cache key runs CBS for a disabled flag                     | F1                                            |
|                                    | v2BreakLoop may stop at an inner loop's end                          | F1                                            |
|                                    | A job's current owner can take its own handoff offer                 | G1                                            |
|                                    | The handoff role event never carries the new owner's name            | G1                                            |
|                                    | A cancelled hook can overlap the worker's next callback              | G1 (Q5)                                       |
| Server routes and resource store   | Routes still measure a body the limiter already counted              | H1                                            |
|                                    | chatCheckpoints.ts keeps its own copy of the old body limiter        | H1                                            |
|                                    | The LLM answer route comment names one 404 and no cap                | E1                                            |
|                                    | The change log's bound is a row count, not 4 MB                      | Deferred: snapshot storage sizing             |
| Request history and diagnostics    | Request history accepted trade-offs                                  | Stays (review material)                       |
|                                    | Socket protocol numbers are not in Diagnostics                       | Deferred: before any `proto` floor            |
| Display transform                  | Budget-refused handler rows not re-measured                          | Deferred: transform measurements              |
|                                    | More than one transform chunk is in flight at a chat switch          | Q11 (no slice)                                |
| Chat screen and input              | Latest-message start scroll untested in DefaultChatScreen            | Deferred: mounted DefaultChatScreen harness   |
|                                    | An adopted server copy drops an open inline editor's unsaved text    | Deferred: editor drafts as refresh holds      |
|                                    | The chat file picker offers mpeg and avi, which store nothing        | B1 (Q8)                                       |
|                                    | `/?` help omits two commands                                         | B1                                            |
|                                    | The screenshot peak grows with the row count                         | Deferred: screenshot memory                   |
|                                    | The screenshot page fill is black                                    | B2                                            |
|                                    | A render run pending at raw streaming is not aborted                 | B2                                            |
|                                    | The dynamic reroll icon variant is dead                              | B2                                            |
| Client and plugins                 | Chinese browsers never match the first-boot language list            | D1                                            |
|                                    | Plugin tests cite a skip no guide records                            | K1 (product side already fixed)               |
|                                    | RPack mocks rest on a byte map fetch that is gone                    | K1                                            |
|                                    | plugins.md omits two parsed headers                                  | M2                                            |
|                                    | saveSecretHeader's declaration describes a feature that does nothing | E1 (Q7)                                       |
|                                    | Stop B leftovers                                                     | Stays (notes; capture-phase keys in hazards)  |
|                                    | Lorebook filter accepted limits                                      | C4 (the two user-visible items)               |
|                                    | A dropped .risupreset goes to the card import                        | A1                                            |
|                                    | importPreset crashes on an unknown preset version                    | A1                                            |
|                                    | CharX import error paths                                             | A1                                            |
|                                    | The card export dialog's backdrop calls window.close                 | C2                                            |
|                                    | PopupButton menus take two clicks to reopen                          | C2                                            |
|                                    | CBS highlighting stops after the 255th character                     | C1                                            |
|                                    | util and globalApi helper gaps                                       | C3                                            |
|                                    | loadFileSrc can return /sw/img on an uncontrolled page               | Deferred: needs a reproduction                |
|                                    | Image compression passes quality 75                                  | J1 (Q2)                                       |
|                                    | The inlay explorer leaks a pending preview URL                       | J1                                            |
|                                    | MCP full login stores an undefined refresh token                     | E2                                            |
|                                    | Combined-paragraph translation sends protected text                  | E3                                            |
|                                    | blockPlugins misses the legacy plugin format                         | E1                                            |
|                                    | Custom models cannot set poolSupported                               | E1 (Q4)                                       |
|                                    | Settings search lists remPunc under Structured Memory                | D1                                            |
|                                    | Switching a prompt item to chatML leaves its text unset              | D1                                            |
|                                    | getFileSrc never rejects, so asset reads are never retried           | Deferred: render failure channel              |
|                                    | Declined lowLevelAccess on a JSON card falls through                 | A1 (Q3)                                       |
|                                    | Reset permissions leaves a running plugin's capabilities             | Deferred: plugin lifecycle                    |
|                                    | A multi-tab plugin removal can bring its deleted data back           | Deferred: plugin lifecycle                    |
| Build, drivers, and e2e            | checkJobProtocol's first run after a source change fails             | Stays (not reproduced)                        |
|                                    | A chat-open suggestion request bumps the chat revision               | Deferred: transform key design                |
|                                    | terminalNotice.spec.ts's composer case fails on an unseeded chat     | K1                                            |
|                                    | Delegate profile test policy names the old guide                     | By hand (untracked file; no slice)            |
|                                    | check:docs does not measure blockquoted items                        | Stays (no guide uses one)                     |
|                                    | check:docs collapses spaces inside a row's code spans                | Stays (needs an unrealistic row)              |
|                                    | checkMcpFixes and the guide disagree on the repeated call            | Stays (settle when the check next runs)       |
|                                    | docs:contracts takes a typedef for the module header                 | L1                                            |
|                                    | docs:ledger counts broad Scope globs as named files                  | L1                                            |
|                                    | docs:read and guide-reads script gaps                                | L1 (the first two); the audit notes stay      |
|                                    | public/sw.js has an empty unused check()                             | B2                                            |
|                                    | measureChats.mjs trips safe boot and fakes its scrolled-up input     | K1                                            |
|                                    | checkServerSend once hit an alert after its mid-stream reload        | Stays (not reproduced)                        |
| Guides                             | Archive README cites a gone emotion table hazard                     | Remove: the hazard is in characters-modules   |
|                                    | Choose By Task rows missing routing words                            | M2                                            |
|                                    | Protocol step 1 reads the Invariants on every lookup                 | M2 (Q10)                                      |
|                                    | chat-pipeline links a reroll hazard to the wrong section             | M2                                            |
|                                    | docs:owner sends the asset lifecycle client to persistence           | L1                                            |
|                                    | The global-api guide misses the checkbox confirm                     | M2                                            |
|                                    | Structured Memory decision pointers name the plan                    | M1                                            |
| Test timing                        | Gate tests still racing real time                                    | Stays (control the clock when touched)        |
| Structured Memory                  | Memory task wording still says summaries                             | I2                                            |
|                                    | Record now in a job is seen by one tab                               | Deferred: structured memory follow-up         |
|                                    | Receipt on a message with no generation info                         | Deferred: structured memory follow-up         |
|                                    | Embedding refusal masks a later assembly error                       | F2                                            |
|                                    | Panel writer line and stale views                                    | Deferred: structured memory follow-up         |
|                                    | Cast slice matches substrings                                        | I1                                            |
|                                    | Lore search depth skips a short chat's first messages                | I1                                            |
|                                    | Snapshot layout check is copied                                      | I3                                            |
|                                    | Hand-written resourceSync mocks                                      | K2                                            |
|                                    | Projection refresh leftovers                                         | Deferred: structured memory follow-up         |
|                                    | Rebuild lock refusal has no code                                     | I1                                            |
|                                    | Adopted summaries                                                    | Deferred: structured memory follow-up         |
|                                    | Highlight and revert leftovers                                       | I3 (`retract`); the fingerprint item deferred |
|                                    | Prompt test run leftovers                                            | I3                                            |
|                                    | Page tool leftovers                                                  | Deferred: structured memory follow-up         |
|                                    | Health badge leftovers                                               | Deferred: structured memory follow-up         |
|                                    | Evaluation findings                                                  | Deferred: structured memory follow-up         |
|                                    | Writer and lifecycle page slips                                      | M1                                            |
|                                    | Two memory comments blur their scope                                 | I2                                            |

## Order

Every slice is independent of the others' code unless listed here; the shared files are guides and tests.

- **Guides.** C2 and C3 both edit `global-api.md`: C3 after C2, or rebase. I1–I3 edit the
  `structured-memory/` pages that M1 rewrites: M1 after I1–I3. M2 edits `STRUCTURE.md`, which no other
  slice touches. H1 edits `self-host-server.md` alone.
- **Tests.** K2 rewrites the `resourceSync` mock in 19 test files, among them `Chat.test.ts` (C2),
  `serverCommands.test.ts` (G1), `generationJobs.test.ts` (I1), and `jobChannel.test.ts` (G1): run K2
  last, alone.
- **Questions.** All answered 2026-11-05 with the recommendation (A1: Q3, B1: Q8, D2: Q6, E1: Q4 and Q7,
  G1: Q5, H2: Q9, J1: Q2, M2: Q1 and Q10); no slice waits on one.
- **Sessions.** A1, B1, B2, C1, C2, C3, C4, D1, E1, E2, E3, F1, H1, H2, I1, I2, I3, J1, K1, L1 are _small_;
  D2, F2, G1 are _hard_ (D2 for its browser confirmation and module contract, F2 for the assembly meters, G1
  for the protocol); M1, M2 and K2 are _small_ but wide. Three sessions at a time is the runner's default.

## Slices

### A. Import paths

- **A1. Import refusals say what happened** (_small_, `characters-modules.md` with `app-shell.md` and
  `persistence.md`; Q3). `src/App.svelte` (~135): route `.risupreset` with `.risup` and update the
  handler's comment. `src/ts/storage/presets.svelte.ts` `importPreset` (~201–214): when `pre` stays unset
  (a decoded `presetVersion` other than 0 or 2, or `type !== "preset"`), refuse with a
  `language.*` message instead of reaching `pre.presetVersion`. `src/ts/characterCards.ts`
  `importCharxCard` (~377): return after `readModule` gives undefined (it has alerted `noData`); the
  `.charx` branch of `importModule` in `src/ts/process/modules.ts` (~579) treats `false` (a declined
  `lowLevelAccess`) as a silent cancel, not `noData`. Q3 (accepted): `importCharacterCardSpec`
  returns a distinct value for a decline and `importCharacterProcess` (~196–201) ends the import there
  instead of trying `convertOffSpecCards`.
  _Done_: a dropped `.risupreset` imports; a `.risup` of version 1 shows the refusal; a CharX with a bad
  embedded module shows one `noData` and no TypeError; declining `lowLevelAccess` in the module dialog shows
  nothing; declining it on a JSON card imports nothing.
  _Test_: `src/ts/characterCardsCharxImport.test.ts` (dropped-file matrix: add `.risupreset`; the bad
  module and the decline), `src/ts/storage/tests/presetIds.test.ts` (unknown version), `src/ts/process/modulesImport.test.ts`
  (`false` is silent), `src/ts/characterCardsImport.test.ts` (JSON decline).
  _Removes_: A dropped .risupreset goes to the card import; importPreset crashes on an unknown preset
  version; CharX import error paths; Declined lowLevelAccess on a JSON card falls through to the off-spec
  import.

### B. Chat screen

- **B1. Commands and the file picker** (_small_, `chat-pipeline.md`; Q8). `src/ts/process/command.ts`
  `processCommand` `"?"` case (~278–334): add `/multisend` and `/test_lorebook` to the help text (U2:
  through `src/lang/en.ts` if the text lives there). `src/ts/process/files/multisend.ts` `postChatFile`
  (~241–242): drop `mpeg` and `avi` from the picker (Q8), and surface a `writeInlayImage` rejection on the
  picker and paste paths with an alert instead of a silent nothing.
  _Done_: `/?` lists both commands; the picker offers only extensions `postInlayAsset` stores; a failed
  image write shows an error.
  _Test_: `src/ts/process/command.test.ts` (the help text names every handled command: derive the list from
  the switch's cases, so a new command cannot be forgotten again), `src/ts/process/files/tests/multisend.test.ts`.
  _Removes_: The chat file picker offers mpeg and avi, which store nothing; `/?` help omits two commands.

- **B2. Screenshot fill, raw-streaming abort, dead code** (_small_, `ui-theming.md` with
  `chat-pipeline.md` and `build-test-platforms.md`). `src/lib/ChatScreens/screenshotExport.ts`
  `composeScreenshot` (:131): take the resolved background color from the caller
  (`getComputedStyle(document.documentElement).getPropertyValue("--risu-theme-bgcolor")`) instead of a
  `var()` string canvas ignores. `src/lib/ChatScreens/ChatBody.svelte` (:545–595): on the transition into
  `shouldRenderRawStreaming`, abort `parseController` and bump `parseRun` together (so the aborted run's
  `finally` cannot write `lastParsed`). Dead code, after `rg` per V4: the `"dynamic"` member of
  `rerollIcon` in `src/lib/ChatScreens/Chat.svelte` (:215, :402, the three `class:dyna-icon` at ~1869–1893)
  and the `.dyna-icon` rules in `src/styles.css` (:564–569; no theme, plugin, or guide references them,
  only stale audit text); `groupOrder` in `src/ts/process/group.ts:79`, `runInlayScreen` in
  `src/ts/process/inlayScreen.ts:16`, `stringlizeChatOba` and `multiChatReplacer` in
  `src/ts/process/stringlize.ts` and `server/src/llm/stringlize.ts` (no callers; the live copies are
  `server/src/prompt/runner.ts` and `server/src/prompt/postProcess.ts`); `async function check(){ }` in
  `public/sw.js:331`. Update `docs/archived-plan/README.md:1178` where it names `dyna-icon`.
  _Done_: a light-theme export of mixed-width rows shows no black strip; a row that enters raw streaming
  while a parse is pending runs no hidden parse to completion; `rg "dyna-icon|stringlizeChatOba|multiChatReplacer|runInlayScreen\b"`
  finds only `server/src/prompt/postProcess.ts`'s live function.
  _Test_: `src/lib/ChatScreens/screenshotExport.test.ts` (the fill color is the passed color),
  `src/lib/ChatScreens/ChatBody.svelte.test.ts` (the pending controller is aborted when raw streaming
  starts), `src/lib/ChatScreens/Chat.controls.test.ts` (boolean prop only).
  _Removes_: The screenshot page fill is black; A render run pending at raw streaming is not aborted; The
  dynamic reroll icon variant is dead; Unreferenced client copies of server prompt helpers; public/sw.js
  has an empty unused check().

### C. Editors, dialogs, helpers

- **C1. CBS highlighting past 255 characters** (_small_, `cbs-rendering.md`). `src/ts/gui/highlight.ts`
  `simpleCBSHighlightParser` (:361 `depthStarts = new Uint8Array(100)`, written at :463, read at :372):
  use an `Int32Array` (or a plain array) for the start offsets.
  _Done_: `{{char}}` after 300 characters of text is highlighted at the right place.
  _Test_: `src/ts/gui/highlight.test.ts` (a call past offset 255; the test fails on the `Uint8Array`).
  _Removes_: CBS highlighting stops after the 255th character.

- **C2. Popup menus and the card export backdrop** (_small_, `ui-theming.md` with `global-api.md`).
  Confirm the two-click reopen in `pnpm dev:agent` first (open a character menu, click outside, click the
  button again). `src/lib/UI/PopupList.svelte` `close` (:33): reset `popupStore.openId` with `children`
  (or make `PopupButton.svelte` :22–24 compare against `children` too). `src/lib/Others/AlertComp.svelte`
  `cardexport` backdrop (:952 `onclick={close}`, no local `close`): answer a cancel through `alertStore`
  the way the other dialogs' backdrops do.
  _Done_: one click reopens a menu after an outside-click close; a backdrop click on the card export dialog
  settles the waiting caller with a cancel and throws nothing.
  _Test_: `src/ts/alertCardExport.test.ts` (backdrop cancel); a component test for the
  `PopupButton`/`PopupList` sequence (new file beside them; `src/lib/ChatScreens/Chat.test.ts` mounts the
  list and is the model).
  _Removes_: PopupButton menus take two clicks to reopen; The card export dialog's backdrop calls
  window.close.

- **C3. util helpers settle and forward correctly** (_small_, `global-api.md`; after C2 for the guide).
  `src/ts/util.ts`: `replaceAsync` (:1070–1073) runs `matchAll` and `replace` with the same regexp, so a
  `/g` regexp with a non-zero `lastIndex` corrupts the output: clone the regexp (or reset `lastIndex`)
  inside the helper and drop the precondition comment. `selectFileByDom` (:175–188): add a `cancel`
  listener, remove the `<input>` on every settle, and keep the empty-change return after the cleanup.
  `selectSingleFile` (:70): return null instead of reading `file.name` of a null handle, and update its
  callers to the null. `src/ts/globalApi.svelte.ts` `toGetter` (:1413, `Reflect.set` with the proxy as
  receiver at :1448): no in-tree caller writes through it; either forward writes (drop the receiver) or
  delete the export with its mock in `src/ts/tests/globalApiMock.ts`, whichever `rg` across `src`,
  `plugins` declarations and docs supports.
  _Done_: `replaceAsync(/a/g with lastIndex 1, "aa", () => "X")` gives `"XX"`; a cancelled picker resolves
  (`[]` or null) and leaves no `<input>`; a write through `toGetter` reaches the real object or the helper
  is gone.
  _Test_: new `src/ts/util.test.ts` (the three helpers, with a fake `<input>` dispatching `cancel`); a
  `toGetter` case in `src/ts/globalApiRetention.test.ts` if it stays.
  _Removes_: util and globalApi helper gaps.

- **C4. Lorebook filter keeps the user's work visible** (_small_, `characters-modules.md`). The contract is
  `characters-modules.md` "Lorebook filter". `src/lib/SideBars/LoreBook/LoreBookList.svelte` (:133–188,
  :648) with `LoreBookData.svelte` (:77–78, :270–280): an entry added while the query is non-empty is
  blank and hidden at once (clear the query on add, or show the new entry regardless of the query until it
  has a name); a folder opened only by the filter (`filterOpens` → `forceOpen`) collapses when a later
  query stops matching it and drops a detail opened inside (keep such a folder open while it has an open
  detail). The other items of that entry (the module list's query on a remote retarget, the untested drag
  recovery) stay as the guide's limits.
  _Done_: "+" under a filter shows the new entry; changing the query while a detail is open inside a
  filter-opened folder leaves the detail open.
  _Test_: `src/lib/SideBars/LoreBook/LoreBookList.test.ts` (both cases; its clear-the-query case at
  :646–667 is the model).
  _Removes_: Lorebook filter accepted limits (rewrite the entry's remaining limits into the guide's
  Limitations and delete it).

### D. Boot and settings

- **D1. Language match, settings search, chatML text** (_small_, `app-shell.md` with
  `settings-i18n.md`). `src/ts/bootstrap.ts` (:268–279): match the browser language against
  `BROWSER_UI_LANGUAGES` through a map (`zh-CN`/`zh-SG`/`zh` → `cn`, `zh-TW`/`zh-HK`/`zh-Hant` →
  `zh-Hant`) before the base-segment compare, and reword settings-i18n's "Expose a new language" recipe so a
  code such as `zh-Hant` is added to the map, not only the list. `src/ts/setting/searchIndex.ts`
  `supaMemoryBranch` (~126): test the Structured Memory branch (`ui.memoryAlgorithmType`) first, as
  `MemorySettings.svelte` renders it. `src/lib/UI/PromptDataItem.svelte` type `onchange` (~268):
  initialize `text` (and `role` if the type has one) when the type becomes `chatML`; today the server's
  `parseChatML` throws a TypeError at `data.trim()` on the first send with such an item.
  _Done_: a `zh-TW` browser boots in `zh-Hant`; a Structured Memory record does not list `adv.remPunc`; a
  prompt item switched to chatML sends.
  _Test_: `src/ts/bootstrap.serviceWorker.test.ts` (`zh-CN`, `zh-TW` beside `ko-KR` and `fr-FR`),
  `src/ts/setting/searchIndex.test.ts` (a Structured Memory record), a `PromptDataItem` case in
  `src/lib/Setting/Pages/presetPages.test.ts` or a new component test (the item has `text` after the
  switch).
  _Removes_: Chinese browsers never match the first-boot language list; Settings search lists remPunc under
  Structured Memory; Switching a prompt item to chatML leaves its text unset.

- **D2. A remote settings record re-applies the display** (_hard_, `ui-theming.md` with
  `resource-sync.md`; Q6). First confirm with two tabs on `pnpm dev:agent`: change the theme in one, watch
  the other. Then make the remote settings apply (`src/ts/storage/resourceSync.svelte.ts` →
  `records.applyRaw` in `src/ts/storage/records.svelte.ts`, or the bootstrap remote-record listener that
  already handles inlay invalidation and character order) call `updateColorScheme`,
  `updateTextThemeAndCSS`, `updateAnimationSpeed` and `updateGuisize` when their fields changed, and rewrite
  `src/ts/gui/colorscheme.ts`'s contract comment, which today states the gap. Keep the calls idempotent for
  the tab that made the change (its own echo).
  _Done_: a theme, text theme, animation speed or GUI size changed in tab A shows in tab B without a reload;
  tab A's own echo repaints nothing twice.
  _Test_: `src/ts/storage/tests/resourceSyncSections.test.ts` (a remote `ui` replacement calls the
  updaters, with the `src/ts/gui/guiRecords.test.ts` fixtures), the two-tab check recorded in the commit.
  _Removes_: A remote settings record does not re-apply the theme.

### E. LLM requests, MCP, translation

- **E1. Plugin providers, custom model flags, declarations, two comments** (_small_, `llm-requests.md`
  with `plugin-sandbox.md`; Q4, Q7). `src/ts/process/request/request.ts` (:647): refuse a `blockPlugins`
  request by the resolved format (`LLMFormat.Plugin`, which the legacy `custom` model in
  `shared/llm/models.ts:548` and a reverse-proxy profile with that `customAPIFormat` carry) instead of the
  `pluginmodel:::` id prefix; the dispatch to `requestPlugin` is at :689–691. Q4:
  `src/lib/Setting/Pages/Advanced/CustomModelsSettings.svelte` (~183–204) gets the `poolSupported` button.
  Q7: `src/ts/plugins/apiV3/risuai.d.ts`
  (:1660–1668) says `saveSecretHeader` and `secretHeader` are not implemented in this fork (the host at
  `v3.svelte.ts:3130` warns and stores nothing). Comments: `server/src/routes/llm.ts` (:228–236) names the
  three 404 cases of `answer` (`server/src/llm/requests.ts:1585`) and `MAX_REQUESTS_PER_CLIENT` (32);
  `server/src/llm/chatTemplate.ts` (:5–8) says the renderer reads `characterName()` and `userName()` on
  every render, so any template throws with no character.
  _Done_: a v3 plugin's `runLLMModel` without `allowPlugins` cannot reach a Plugin-format provider through
  the legacy model or a proxy profile; the flag button exists; the declaration tells
  the truth; both comments match the code.
  _Test_: `src/ts/process/request/tests/requestPresetScope.test.ts` (the legacy custom model and the proxy
  profile under `blockPlugins`, :156–165 and :303–337 are the models), `src/lib/Setting/Pages/presetPages.test.ts`
  (flag 11).
  _Removes_: blockPlugins misses the legacy plugin format; Custom models cannot set poolSupported;
  saveSecretHeader's declaration describes a feature that does nothing; The LLM answer route comment names
  one 404 and no cap; Server chat template comment narrows when it throws.

- **E2. MCP refresh tokens are stored only when present** (_small_, `mcp.md`).
  `src/ts/process/mcp/mcplib.ts` `oauthLogin` full-login branch (:897–903): register `refreshToken` only
  when `tokenData.refresh_token` is a non-empty string, as the refresh branch (:770) already checks;
  `server/src/mcp/client.ts` (:699–703): skip the refresh (go to a full login) when the stored token is
  missing instead of sending `""`.
  _Done_: a server that issues no refresh token leaves no refresh entry and the next handshake is one full
  login, not a failed refresh first.
  _Test_: `src/ts/process/mcp/tests/mcplib.test.ts` (:285–325 model), `server/src/tests/mcp.test.ts`
  (:746–802 model).
  _Removes_: MCP full login stores an undefined refresh token.

- **E3. Combined-paragraph translation respects protected descendants** (_small_, `translation.md`).
  `src/ts/translator/translator.ts` `translateHTML`, the `combineTranslation` path (:599–603): check the
  blacklist (`translate="no"`, scripts, the other excluded tags) over every descendant before flattening a
  `<p>` with `getNodetextToSentence` (`src/ts/util.ts:745–771`), and fall back to the per-node path for a
  paragraph that has one. Rewrite the Invariants sentence (~253) that states the current behavior.
  _Done_: `<p>public <span translate="no">PRIVATE</span></p>` sends `public` only.
  _Test_: `src/ts/translator/translatorMedia.test.ts` (:265–287 model: the probe's input).
  _Removes_: Combined-paragraph translation sends protected text.

### F. Server prompt and scripts

- **F1. Regex cache key and the loop break** (_small_, `scripts-triggers.md` with
  `server-generation.md`). `shared/scripts/regex.ts` `regexScriptCacheKey` (:285): expand `script.in`
  through `parse` only when `script.ableFlag` is set, matching the action parse at :52; the server supplies
  `parse` from `server/src/prompt/scripts.ts:197`. `server/src/prompt/triggers.ts` `v2BreakLoop`
  (:855–858): write the nested-loop test first (a break in an outer loop placed before an inner loop); if it
  fails, match the break's indent the way the loop jump does (:811–815, `indent - 1`).
  _Done_: a disabled `<cbs>` flag evaluates no CBS during key building; a nested-loop break leaves the outer
  loop.
  _Test_: `server/src/tests/regex.test.ts` (a `setvar` side effect under `ableFlag: false`),
  `server/src/tests/triggerRuntime.test.ts` (:545–553 has sequential loops; add the nested case).
  _Removes_: The regex cache key runs CBS for a disabled flag; v2BreakLoop may stop at an inner loop's end.

- **F2. Blank entries in the meters, and the refusal that masks an assembly error** (_hard_,
  `server-generation.md` with `memory.md`). `server/src/prompt/assemble.ts`: `contextTrim` (:3051) returns
  no ledger when a queued greeting or message source is not in `kept`; a source marked `{ empty: true }`
  (:2609, `blankEntry` from `server/src/prompt/memory/structured/step.ts:194`) is absent by design, so skip
  it when building `trimLedger.next` (:2111, `TRIM_QUEUE_LENGTH` 8) or when checking `kept`.
  `server/src/prompt/memory/hypav3.ts` (:1490–1528): exclude blank entries from the history that feeds
  `gapTokens`, so a trim that drops only blank history reports no gap and asks no gap question.
  `server/src/prompt/runner.ts` (:1506–1515 keeps the latest local-model refusal; :1714 and :1719 report
  `refusal?.message ?? assembled.error`): clear a refusal the memory step survived (or scope it to the
  memory outcome) so a later assembly error is reported as itself.
  _Done_: a chat whose greeting a script blanks shows a displacement estimate; a HypaV3 trim over blank
  rows asks nothing; a send that fails on context size after a survived embedding refusal shows the
  context-size error.
  _Test_: `server/src/tests/assemble.test.ts` (:2331–2358 blank-history cases: add the first-eight ledger
  and the gap), `server/src/tests/memoryJobs.test.ts` (embedding refusal then assembly error),
  `server/src/tests/promptRunner.test.ts`.
  _Removes_: Blank history entries and the meters; Embedding refusal masks a later assembly error.

### G. Job handoff

- **G1. A ticket from the owner reattaches it; the role event names the worker** (_hard_,
  `server-generation.md` with `network-jobs.md`; Q5). `server/src/jobs/generationJobs.ts` `attach()`: when
  the ticket holder's `clientId` is the job's current `ownerClientId`, consume the ticket and treat it as a
  plain owner reattach (no `pendingTakeover`), so outstanding callbacks replay to the new socket. Refusing
  the owner with a 409 instead was dropped (owner decision 2026-11-05): a reloaded worker owner has no
  running follow (workers never save the job for boot resume), and its absent-offer ticket is its only way
  back. Check the creator's own `absent` take-back path, which `src/ts/network/handoff.ts` `takeOffer`
  still allows for its own absent offers. Role events: give the
  registry a `clientName(clientId)` dependency in `server/src/app.ts`, fed from the events route's
  `registrations` (`server/src/routes/events.ts`, keyed by socket, publishing `FeedClient[]`), and fill
  `clientName` on every role event; then make `util/playwright/checkJobHandoff.mjs`'s creator-keeps-watching
  case require the worker's name in the toast. Q5: add the single-callback sentence and the cancelled-hook
  overlap to server-generation's job handoff section as a limitation.
  _Done_: an owner that takes its own open offer reattaches as owner and keeps its outstanding callback; a
  reloaded worker owner gets its job back through its absent offer; the creator's toast names the worker; the
  driver passes with the stricter case.
  _Test_: `server/src/tests/generationJobs.test.ts` (an owner ticket reattaches and replays the outstanding
  callback; role event carries the name),
  `server/src/tests/events.test.ts` (the name lookup), `src/ts/process/serverCommands.test.ts` (the named
  toast), `src/ts/network/handoff.test.ts`; `node util/playwright/checkJobHandoff.mjs` once.
  _Removes_: A job's current owner can take its own handoff offer; The handoff role event never carries the
  new owner's name; A cancelled hook can overlap the worker's next callback.

### H. Server routes and the chat store

- **H1. One body limiter** (_small_, `self-host-server.md`). `server/src/routes/chatCheckpoints.ts`:
  replace the `hono/body-limit` copy (:2, ~37, 16 KiB) with `limitedBody(MAX_CHECKPOINT_BODY_BYTES)` from
  `routes/limitedBody.ts` and remove the guide's registration-order note about the exception. Drop the
  redundant post-read size check and its "The limiter trusts a declared length" comment in
  `messageSearch.ts` (~213), `tokens.ts` (~24), `diagnostics.ts` (~56), `requestHistory.ts` (~152) and
  `chatCheckpoints.ts` (~73), and the matching stale comments in `server/src/tests/resourcesBoot.test.ts`
  (~806) and `diagnostics.test.ts` (~1679).
  _Done_: `rg "hono/body-limit" server/src` finds only `limitedBody.ts`; every over-cap body on those routes
  is the limiter's 413.
  _Test_: the existing cap tests (`server/src/tests/chatCheckpointAuto.test.ts`, `messageSearch.test.ts`,
  `tokenRoutes.test.ts`, `requestShare.test.ts`, `diagnostics.test.ts`) still pass; a chunked over-cap body
  on the checkpoint route is refused before the handler.
  _Removes_: Routes still measure a body the limiter already counted; chatCheckpoints.ts keeps its own copy
  of the old body limiter.

- **H2. Bounded discard reads; the feed's removed ids** (_small_, `chat-store.md` with
  `live-update-feed.md` and `server-resources.md`; Q9). `src/ts/storage/chatStore.svelte.ts`
  `discardRefusedChat` (~4206, ~4215): wrap both `readRefs` calls in `deadlineChatRead`, as the other chat
  reads in the file are. Q9: `server/src/data/chatStore.ts` `applyGroup` (~2172, ~2182) passes
  `removedIds` filtered by `insertedHere`, as `chatWriteChange` does (~1603), and the
  `server/src/tests/chatFeedPatches.test.ts` case that pins the discrepancy changes to pin the agreement.
  _Done_: a stalled link ends a discard read at the deadline; an append and removal of one id in one group
  lists it in neither `removed`.
  _Test_: `src/ts/storage/tests/chatStore.test.ts` (discard with a never-answering server: the deadline
  fires), `server/src/tests/chatFeedPatches.test.ts`, `src/ts/storage/tests/resourceSyncFeedPatches.test.ts`
  (the client applies the filtered patch).
  _Removes_: discardRefusedChat reads without a deadline; The feed's removed ids include ids the same group
  inserted.

### I. Structured Memory

- **I1. Named pages, short chats, rebuild refusals** (_small_, `structured-memory/pages.md` and
  `read.md` with `server-generation.md`). `server/src/prompt/memory/structured/pages.ts` `castSlice`: use
  `searchMatch` (as `retrieve.ts` does) instead of a lower-cased substring test. `shared/lore/activation.ts`
  `searchMatch`: clamp the slice start at 0 so three messages and depth 5 include message 0 (check the
  owner with `pnpm docs:owner shared/lore/activation.ts`, compare upstream `kwaroran/main`'s copy first,
  and update `server/src/tests/fixtures/baseline/` if a pinned case moves). `server/src/jobs/generationJobs.ts`:
  give the rebuild-lock 409 a code, teach `registryRefusal` in `src/ts/network/generationJobs.ts` the code,
  and add its words to `src/lang/en.ts`.
  _Done_: alias `Al` no longer lists a page for "also"; a key only in a short chat's first message
  activates; a create retried during a rebuild shows the rebuild message, not the generic lost one.
  _Test_: `server/src/prompt/memory/structured/pages.test.ts`, `server/src/tests/lore.test.ts`,
  `server/src/tests/memoryJobs.test.ts` (the coded 409), `src/ts/network/generationJobs.test.ts` (the
  refusal matrix).
  _Removes_: Cast slice matches substrings; Lore search depth skips a short chat's first messages; Rebuild
  lock refusal has no code.

- **I2. Memory tasks are named by kind** (_small_, `structured-memory/writer.md` with `memory.md` and
  `ui-theming.md`). `src/lib/ChatScreens/ContextMeter.svelte`'s task block and chip read
  `MemoryTaskStatus.kind` and show writer wording for `structuredMemory` (new `src/lang/en.ts` strings
  beside "Background summary"); `summarizingChats` in `src/ts/process/memoryTasks.svelte.ts` keeps its
  meaning but its comment and the comments in `shared/events.ts` (~21), `src/ts/network/eventFeed.ts`
  (~38), `server/src/jobs/runSetup.ts` (~64), `server/src/app.ts` (~451, ~1007) and
  `src/lib/SideBars/chatStatus.ts` (~15) say "memory task" with both kinds. Two scope comments:
  `server/src/prompt/memory/structured/pages.ts:52` says a merge remaps live pages only (the trash keeps
  its link), and `server/src/data/resourceStore.ts` `store.memory.rebuild.rebuilding` (~2287) says
  `structuredMemorySelected()` reads the one global `memoryAlgorithmType`.
  _Done_: a writer task shows writer wording in the meter; no comment calls every memory task HypaV3.
  _Test_: `src/lib/ChatScreens/ContextMeter.svelte.test.ts` (both kinds), `src/ts/process/memoryTasks.test.ts`.
  _Removes_: Memory task wording still says summaries; Two memory comments blur their scope.

- **I3. Dead kinds, an unreachable refusal, a copied check** (_small_, `structured-memory/records.md`,
  `read.md` and `lifecycle.md` with `server-resources.md`). `shared/structuredMemory.ts`: drop `retract`
  from `MEMORY_HISTORY_CHANGE_KINDS`, `STRUCTURED_MEMORY_HIGHLIGHT_KINDS` and the default `highlightKinds`,
  with `normalizeStructuredMemorySettings` dropping a stored one (the `MemorySettings.structuredMemory.test.ts`
  case that preserves it changes to drop it); the `userCorrected` check in `compact.ts` `mayCompact` stays
  if the disputed join still reaches it (it does: say so in its comment) or goes. `testRun.ts`: remove
  `TEST_REFUSALS.gap` (unreachable: `jobMemoryBlockingReason` answers only `pluginModel` and
  `requestTrigger`), and word the result screen's outcome for a run that saved nothing
  (`StructuredMemoryPrompts.svelte`, `en.ts`); move `testRun` from writer's Scope `Paths` to read's.
  `server/src/data/memoryStore.ts` `memoryStateLayout` and `server/src/data/checkpointStore.ts`
  `walkCheckpointSnapshot`: one layout helper beside `snapshotRows` in `resourceStore.ts`.
  _Done_: no dead kind in the settings or the highlight set; no unreachable refusal row; "Outcome" on a
  test run does not read as a save; one layout check.
  _Test_: `src/lib/Setting/Pages/MemorySettings.structuredMemory.test.ts`, `server/src/tests/memoryTasks.test.ts`,
  `server/src/tests/memoryJobs.test.ts` (the test-run outcome), `server/src/tests/restoreStage.test.ts`
  (the shared helper from both callers).
  _Removes_: Highlight and revert leftovers (the fingerprint item moves to Deferred); Prompt test run
  leftovers; Snapshot layout check is copied.

### J. Media

- **J1. Compression quality and the explorer's preview URLs** (_small_, `media-aux.md`; Q2).
  `src/ts/media/compressImage/lossyCompression.ts` (:37, :41): `0.75` (Q2).
  `src/lib/Playground/PlaygroundInlayExplorer.svelte` `getPreviewURL` (:37–40): after the await, revoke
  instead of caching when the component is destroyed or the inlay was deleted meanwhile.
  _Done_: a WebP export is smaller than before at the same input; an explorer closed during a preview load
  leaves no object URL.
  _Test_: `src/ts/media/compressImage/tests/compressImage.test.ts` (assert the quality argument on a canvas
  mock), a component test for the explorer (destroy during a pending preview: `URL.createObjectURL` and
  `revokeObjectURL` counts match).
  _Removes_: Image compression passes quality 75; The inlay explorer leaks a pending preview URL.

### K. Tests and drivers

- **K1. A red spec, stale workarounds, and a driver** (_small_, `test-harness.md` with
  `plugin-sandbox.md`). `e2e/terminalNotice.spec.ts` (:124–139): seed the chat with `promptPresetId`,
  `modelPresetId` and `bindedPersona` the way `e2e/chatBinding.spec.ts` (:193–201, :274–276) does, so the
  composer case at :312 types into an editable composer. `src/ts/plugins/apiV3/pluginContext.test.ts`
  (:1287–1291) and `permissions.test.ts` (:315–320): the skipped-instance hazard is gone
  (`v3.svelte.ts:3147–3155` unloads a snapshot, recorded in plugin-sandbox.md): drop the citation and the
  repeat-until-gone workaround. RPack: of the 13 test files that mock `rpack_js`, run the real synchronous
  codec (`shared/rpack.ts`, inlined map) where the test does not need to observe the encode, and fix the
  three "fetches its byte map as a Vite asset" comments (`characterCardsImport.test.ts:59`,
  `presetIds.test.ts:46`, `presetsCodec.test.ts:33`) where a mock stays. `util/playwright/measureChats.mjs`:
  wait past `SAFE_BOOT_SETTLE_MS` (or clear the safe-boot attempts as `util/playwright/stack.mjs` offers)
  between its boots, and drive the scrolled-up case with real wheel input.
  _Done_: `terminalNotice.spec.ts` is green on a clean worktree; no test cites the gone hazard; the RPack
  mocks that remain say why; `measureChats.mjs` finishes on a fresh stack.
  _Test_: the files themselves; `pnpm --silent test:agent --tags-filter=slow` for the e2e spec through the
  wrapper's route; one `measureChats.mjs` run.
  _Removes_: terminalNotice.spec.ts's composer case fails on an unseeded chat; Plugin tests cite a skip no
  guide records; RPack mocks rest on a byte map fetch that is gone; measureChats.mjs trips safe boot and
  fakes its scrolled-up input.

- **K2. resourceSync mocks on the shared factory** (_small_ but wide, `test-harness.md`; last, alone).
  Move the 19 hand-written `vi.mock` of `src/ts/storage/resourceSync.svelte` onto `createBootMock` in
  `src/ts/tests/bootMocks.ts` (:19–95; `bootstrap.safeBoot.test.ts` and `ImageGenerationSettings.test.ts`
  are the models): `src/lib/ChatScreens/Chat.draft.test.ts`, `Chat.test.ts`,
  `src/lib/Others/HypaV3Modal.fence.test.ts`, `src/lib/UI/RefusedDataBanner.test.ts`,
  `src/ts/drive/backuplocal.test.ts`, `backuplocalSnapshot.test.ts`, `src/ts/globalApiNativeFetch.test.ts`,
  `globalApiRetention.test.ts`, `src/ts/network/auxFetch.test.ts`, `eventFeed.test.ts`,
  `generationJobs.test.ts`, `generationJobsPluginWork.test.ts`, `jobChannel.test.ts`,
  `src/ts/plugins/pluginDeferredReload.test.ts`, `src/ts/process/chatMemoryInherit.test.ts`,
  `chatStatus.test.ts`, `src/ts/process/request/tests/transport.test.ts`, `serverCommands.test.ts`,
  `src/ts/translator/storedTranslation.test.ts`. A file that overrides one export keeps the override on
  top of the factory.
  _Done_: a new `resourceSync` export breaks `pnpm check`, not a run; `rg "vi.mock\(\"src/ts/storage/resourceSync"` finds
  only factory calls.
  _Test_: the files themselves, whole suite once.
  _Removes_: Hand-written resourceSync mocks.

### L. Docs tooling

- **L1. docs:read, docs:contracts, docs:ledger, docs:owner** (_small_, `build-test-platforms.md`).
  `util/docsRead.mjs`: strip backticks from the query as from the headings (:56–62), and prefer
  `docs/structure/README.md` for `README.md` in `resolveGuide` (:14–24; `util/guideReads.mjs`
  `guideOfArgument` already rejects `README.md`, keep them consistent). `util/docsContracts.mjs`
  `headerBlock` (:94–104): skip a lone `@typedef` block and count a leading `//` block in `.mjs` scripts
  as the header. `util/docsLedger.mjs`: a `--strict` flag that ignores glob spans in `namedTargets`
  (:118–132) and `resolveNamed` (:185–201); document it in the guide's trim recipe.
  `docs/structure/ownership.json`: an assets rule for `src/ts/storage/assetLifecycleClient.ts` and its test
  beside the `assetClient`/`assetQueue` rules; `pnpm check:docs` after.
  _Done_: `pnpm docs:read chat-store 'Not in \`sendChat\`'`prints the section;`pnpm docs:read README.md`prints the structure README;`pnpm docs:contracts util/agentDataSandbox.mjs`reports the leading block;`pnpm docs:ledger --strict`finds the miss a glob hides;`pnpm docs:owner src/ts/storage/assetLifecycleClient.ts`answers assets.
_Test_:`util/docsRead.test.ts`, `util/docsContracts.test.ts`, `util/docsLedger.test.ts`,
`util/docsOwner.test.ts`if present (else a case in the manifest check).
_Removes_: docs:read and guide-reads script gaps (the two`docsRead`items; the two`guideReads` audit
  notes move to the guide's Tests as known skews); docs:contracts takes a typedef for the module header;
  docs:ledger counts broad Scope globs as named files; docs:owner sends the asset lifecycle client to
  persistence.

### M. Guides

- **M1. Structured Memory pages: pointers and slips** (_small_, `structured-memory/` pages; after
  I1–I3). Rewrite the 42 `Decision: Structured Memory …, plan` pointers to `, archive` (records.md,
  pages.md, lifecycle.md, writer.md, rebuild.md, read.md). `writer.md:72`: point the adopted-sources fact
  at `lifecycle.md#adopting-hypav3-summaries`; `writer.md:186`: "a message edit during the run";
  `writer.md:9` and `read.md:8`: `testRun.ts` in read's `Paths` only (I3 moves the file's section if it has
  not); `lifecycle.md` Files entries for `checkpointStore.ts` (~37) and `chatStore.svelte.ts` (~53): add
  `Owner:` markers. Byte-neutral or smaller; `pnpm check:docs` and `pnpm docs:ledger` for each page.
  _Done_: `rg -n "Decision: Structured Memory [^,]*, plan" docs/structure` finds nothing; the four slips
  are gone.
  _Removes_: Structured Memory decision pointers name the plan; Writer and lifecycle page slips.

- **M2. Routing words, protocol step 1, four guide corrections** (_small_, `STRUCTURE.md` with
  `chat-pipeline.md`, `chat-store.md`, `global-api.md`, `cbs-rendering.md`, `test-harness.md`,
  `plugins.md`; Q1, Q10). `STRUCTURE.md` Choose By Task: add "display transform client and retries" to
  cbs-rendering, "push diagnostics" to diagnostics, "HypaV3 job modes" to memory, "safe boot" to app-shell,
  "thumbnail HTTP responses" to self-host-server; Q10: step 1 reads the Invariants for add and change tasks.
  `docs/structure/test-harness.md` `Tests > Network guard` (~287): point Playwright egress at `egressGuard`
  in `util/playwright/stack.mjs` from the first line. `docs/structure/chat-pipeline.md:397–399`: point the
  reroll-restore hazard at server-generation's job creation and lock acquisition (or drop the "see"), and
  relabel line 284's link. `docs/structure/chat-store.md` `### Restore floor`: state the check order once,
  read from `server/src/data/chatStore.ts`, and leave server-resources' reciprocal pointer one-way (pay the
  bytes with a trim). `docs/structure/global-api.md`: `alertConfirmWithCheckbox` in the helper list and
  `alertStore.answerConfirm(confirmed, shown)` beside `answer(msg)` (paid with a trim). Q1:
  cbs-rendering Known Hazards > Limitations says `{{// ...}}` is kept literal everywhere but lore key
  matching. Root `plugins.md` (the author guide, no byte budget): document `//@allowed-ipc` and
  `//@risu-arg` with the parsing rules from `importPlugin` in `src/ts/plugins/plugins.svelte.ts`. Also
  delete the found-issues entry "Archive README cites a gone emotion table hazard": the hazard is in
  characters-modules.md under its `bind:` `list[i]` wording, so the archive's citation holds.
  _Done_: `pnpm check:docs` passes with the tree ratchet; each named sentence is in its guide.
  _Removes_: Choose By Task rows missing routing words; Protocol step 1 reads the Invariants on every
  lookup; chat-pipeline links a reroll hazard to the wrong section; No guide states the restore floor's
  check order; The global-api guide misses the checkbox confirm; `{{// ...}}` stays literal in rendered and
  prompt text; plugins.md omits two parsed headers; Archive README cites a gone emotion table hazard.

## Deferred

Each group is a later plan or a design question, with the entries it should take.

- **Feed patch forms.** The server feed still publishes a one-key `pluginStorage` write as the whole
  dictionary and a toggle as a bare ref (`feedPatch`, `diffRecordText`), and `patchedRecord` in
  `resourceSync.svelte.ts` knows neither `nested` nor `itemKey`; both sides change together with
  `checkRecordWritePatch`'s forms. Entry: pluginStorage writes still reach other tabs whole.
- **Editor drafts as refresh holds.** An adopted server copy remounts a row under edit and drops the
  inline editor's text; the fix registers open drafts as holds or keeps drafts by id across the remount.
  Entry: An adopted server copy drops an open inline editor's unsaved text.
- **Handoff follow-up.** A "detach without retiring" release for a lost takeover so a later retake streams.
  Entry: A retaken handoff job drops its live stream.
- **Plugin lifecycle.** Tear down a running plugin's capabilities on a permission reset; a tombstone or a
  removed-plugin refusal in `setOwnedPluginStorageItem` so a multi-tab removal stays removed. Entries: Reset
  permissions leaves a running plugin's capabilities; A multi-tab plugin removal can bring its deleted data
  back.
- **Render failure channel.** An opt-in failure signal from `getFileSrc` for the render path so a transient
  asset read is retried. Entry: getFileSrc never rejects, so asset reads are never retried.
- **Screenshot memory.** A heap snapshot and `VmHWM` per page during a 150-row export to find what scales
  with rows. Entry: The screenshot peak grows with the row count.
- **Token counting.** Measure tool schemas against the assembly budget with a real tokenizer; charge an
  estimate if the gap is real. Entry: Tool schemas are outside the assembly token budget.
- **Trim question design.** The late removable-message cleanup that still trims without asking, the English
  job error on an unanswered question, the `supaMemoryOnCount` not bumped by a plugin or raw write. Entry:
  No-memory trim question gaps.
- **Transform key design.** Whether a non-render chat field such as `suggestMessages` should move the
  transform key; the revision is also the key's fence. Entry: A chat-open suggestion request bumps the chat
  revision.
- **Transform measurements.** Re-measure the per-scope snapshot charge on a realistic large chat with
  handlers (`measureTransformLua.mjs`); the shared-entry exclusion is already applied. Entry:
  Budget-refused handler rows not re-measured.
- **Snapshot storage sizing.** Size the Asset Lifecycle snapshot budget as rows × id length, or add a
  VACUUM or a byte bound to the change log. Entry: The change log's bound is a row count, not 4 MB.
- **Before any `proto` floor.** A diagnostics event field and a recorder on both sockets. Entry: Socket
  protocol numbers are not in Diagnostics.
- **Mounted DefaultChatScreen harness.** The latest-message start scroll, the bookmark jump and the
  translation invalidation tests all wait on one. Entry: Latest-message start scroll untested in
  DefaultChatScreen.
- **Needs a reproduction.** A lost controller with a cached `/sw/img` entry. Entry: loadFileSrc can return
  /sw/img on an uncontrolled page.
- **Structured Memory follow-up.** The in-job record's missing task status and fence; the receipt's model
  button and the themes without a receipt line; the panel's writer line, the checkpoint-load refresh, copied
  receipts and the reset answer; `pinned` on adopted summaries; the highlight mode in the writer
  fingerprint; the page tools' test helpers and the trash bound; the health badge's shared derived, group
  exclusion and read budget; the evaluation findings (overhead constant, `selectMemory` cost, checkpoint
  save hold, `readHealth` bounds, lane starvation); the projection refresh leftovers (recovery wording, the
  stale comment, the `chatOutput` payload, the regex-read constants). Entries: Record now in a job is seen
  by one tab; Receipt on a message with no generation info; Panel writer line and stale views; Adopted
  summaries; Highlight and revert leftovers (fingerprint); Page tool leftovers; Health badge leftovers;
  Evaluation findings; Projection refresh leftovers.

## Not in this plan

- **By hand, now:** `.claude/delegate-implementation.local.md:11` (untracked, main checkout) points the
  test-policy slot at `build-test-platforms.md`; the rules are in `docs/structure/test-harness.md:246`.
- **Stays in the inbox** (reference material or accepted): Parked resends leak; Store subscriber throw
  queue; Phase 6 review leftovers; flushResources resolves after a restore halt; Request history accepted
  trade-offs; Stop B leftovers; Gate tests still racing real time; checkJobProtocol's first run;
  checkServerSend's alert; check:docs on blockquoted items and code-span spaces; checkMcpFixes and the
  guide. Each leaves through a Known Hazards entry when confirmed with an owning guide, or when it settles.
- **Q11** (transform chunks in flight at a switch) records its measurement and closes without a slice.

## Verification

- Per slice: the `_Test_` files, `pnpm check`, `pnpm --silent test:agent` (whole, once, after the last
  edit), `pnpm format:check`, the owning guide's focused checks, and `pnpm check:docs` for any guide edit
  (`pnpm docs:ledger` for a trim).
- Browser checks, recorded in the slice's commit message: C2 (menu reopen), D2 (two tabs), K1
  (`measureChats.mjs`), G1 (`checkJobHandoff.mjs`).
- At the end of the run: the whole suite with the slow tag, `pnpm check:docs`, and `found-issues.md`'s
  Contents counts matching its entries.
