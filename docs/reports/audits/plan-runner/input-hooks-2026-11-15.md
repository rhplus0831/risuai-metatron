# Input Hooks Plan audit, 2026-11-15

- Plan: `docs/plan/input-hooks.md`
- Commit audited: `86ca13331` (`dev`); the corrected plan is committed with this report
- Mode: `full`
- Model: GPT-6-Astra (`xhigh`), read-only, in place of the usual Sol session because slices 1 and 6 cross `shared/` and
  the server; report written by the session that drafted the plan (Claude Fable 5.2), before any plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 3     |
| P2         | 5     |
| P3         | 8     |
| unverified | 0     |

All sixteen are `fixed in plan`. A1 to A11 came from the first turn; the drafting session read A1 and A2 against the
code before editing. The second turn settled the design of the two P1 fixes: of two candidates for A2 Astra recommended
the collection kind, and for A1 the row format over an unknown `state` value or another row type. In the third turn
Astra confirmed twelve corrections, disputed four (A1, A4, A9, A11), and found A12 to A15 in the corrections. In the
fourth turn it confirmed those four and found A16, a wording its own third-turn suggestion had made too broad. A16's
replacement text is Astra's and went into the plan without another turn. No P1 is open.

Two corrections change the plan's design and one reverses a decision, so they are the owner's to accept: the hook list
is a settings collection of its own kind, not a `memoryTranslateMedia` field (A2, D6); a composer row that holds draft
text is written in a second row format (A1); `inputOriginal` is left out of the request fingerprint (A6, D14, reversed).

Astra changed no file in the repository. It ran seven existing test files through the wrapper in the first turn (120
passed: the request binding guard and preset scope, server generation, the send drafts, the composer drafts, the
server's translation tests, the translator history slots) and scratch scripts against the current code in every turn;
they are kept in `/home/codex/review-reports/input-hooks-plan-audit-2026-11-15/scratch/`, with Astra's own notes in
`findings.md` beside it. None of them implements the plan. The full suite, the type and format gates, a browser, and a
real provider were not run. The four turns took about 55 minutes and 25.8 M tokens.

Found consistent: the six new paths are free and already have owners by rule (`ownership.json:443`, `:446`, `:447`,
`:453`); menu index 24 and the slug `input-hooks` (`settingsMenu.ts:26`, `routes.ts:28`); a request with a `chatRef`
runs on the chat's bound presets and takes `profileId` over the mode's slot (`request.ts:217`, `:699`,
`shared/llm/modelSlots.ts:63`); `tools: []` skips tool discovery (`request.ts:378`); a loaded chat holds all its
messages and the history builder accepts an index equal to their count (`chatStore.svelte.ts:7862`,
`historySlots.ts:58`); `draftHookId` needs the checkpoint and export tables only, and `setChatMeta` unsets through its
third argument (`shared/chatCheckpoints.ts:17`, `chatStore.svelte.ts:4458`, `:4523`); the copy, the branch, and the
local chat import keep unknown metadata (`SideChatList.svelte:138`, `Chat.svelte:2009`, `characters.ts:547`); an
appended message keeps its translation through the store, the feed, and the tab (`server/src/data/chats.ts:164`,
`chatStore.ts:2477`, reproduced); the context reaches the runner by `structuredClone` and receipts hold no context
(`generationJobs.ts:2411`, `generationReceipts.ts:28`); an older route drops `inputOriginal` (`generations.ts:222`,
reproduced); a second job under the same `userMessageId` skips the input stage (`runner.ts:499`); the order 1 to 6 has
no reverse dependency, and slices 2 and 3 share no file; every claim about the fork (the default hook and its prompt,
the slots, the two-box flow, the bypasses, the BTW button inside the draft area, what D17 leaves out).

The re-check list, against the current code: `patchMessage` closes an open generation fence
(`server/src/data/chatStore.ts:2553`, `:2569`; the plan appends the translation with a new message, so it is not
reached); feed rows are measured whole against the 64 KiB cap, falling back to a refetch (`shared/resources.ts:538`,
`chatStore.ts:1896`, `:1927`, `:2008`; a long original only makes the feed row larger); `STORE_TABLES_SQL` runs only on
a fresh database (`resourceStore.ts:3855`; a new settings kind needs no table); `sendText` counts a successful send to
an eligible open socket, not an acknowledgement (`generationJobs.ts:1047`, `:1064`).

## P1

### A1. An older tab rewrites a composer row without its draft

- Plan (slice 4, as audited): "`ComposerValue` gains `draft?: string` (absent reads as `""`) and `sent?: "draft"`. A
  row without either is today's row, written and read as today; `checkComposerValue` accepts both shapes, so a row from
  before this slice stays readable and a tab from before it keeps reading rows whose draft is empty."
- Code: `checkComposerValue` checks the members it knows and accepts others (`src/ts/storage/draftJournal.ts:323`), so
  an older tab reads the new row. Its composer snapshot drops `draft` and `sent` (`composerDrafts.svelte.ts:58`), its
  `restore` returns the main box's text as the sent text under the draft send's message id (`:344`, `:360`), and its
  next write stores an old-shape value over the row (`:160`, `draftJournal.ts:1754`). Reproduced over the real journal:
  the row lost `draft: "reviewed draft"` and `sent` after one edit in the older tab.
- Fixed in plan: a composer row that holds a nonempty `draft` or the marker, draft row and hand-off row alike, is
  written with row format 2, which an older reader refuses (`draftJournal.ts:288`) and keeps on every path (read, write
  and takeover, swap, removal, settle, request update, chat removal, expiry, eviction: `:1722`, `:1740`, `:1754`,
  `:1769`, `:1804`, `:1868`, `:1912`, `:1939`, `:1956`; reproduced in the second turn). Every other composer row is
  written as today. Rules "A tab or server from before a slice" and "Absent means today" say so.

### A2. An older tab erases the hook list with any edit of its section

- Plan (Rules, as audited): "A section write that lacks `inputHooks` stores the default list (`normalizeSection`), as
  with every section field added before; resource writes carry revision and epoch (STRUCTURE.md D4), and this plan adds
  no further guard."
- Code: a tab builds a section's outgoing write from its own `SECTION_FIELDS`
  (`src/ts/storage/resourceSync.svelte.ts:1952`), so a tab from before the field removes it in its patch (`:2576`) even
  on the current revision; the store admits the write (`resourceStore.ts:1913`) and `normalizeSection` fills the
  default (`server/src/data/normalize/shared.ts:42`). Reproduced with the real store: after a save from a newer tab, an
  edit of another field from the older projection left the default hook.
- Fixed in plan: the hook list is a settings collection of its own kind, merged whole (slice 1, D6). A tab that does
  not know a kind never requests, installs, or writes it (`bootCache.ts:268`, `resourceSync.svelte.ts:2762`, `:4902`,
  `eventFeed.ts:157`). The alternative, the server keeping the stored list when a section write lacks the field, needs
  a new rule at every write boundary of the store: `prepareWrite` makes a kind refuse field patches
  (`resourceStore.ts:3307`, reproduced). Slice 1 lists the registries the kind needs (`shared/resources.ts`,
  `shared/sections.ts`, `collections.ts`, `kinds.ts`, `recordMerge.ts`, `snapshots.svelte.ts`) and the tests that count
  kinds, and tests that a section write without the field leaves the list alone. A tab of slice 1 or later needs a
  server of slice 1 or later (`server/src/routes/resourceBoot.ts:66`).

### A13. A restored draft send replaces what the user queued meanwhile

- Plan (slice 4, after the first corrections): "Its composer comes back as it was consumed … The empty-composer
  conditions that gate these … read the draft box too."
- Code: the screen's two placement gates read the main box alone (`DefaultChatScreen.svelte:281`, `:1027`), and the
  user can type and attach during a send (`:1393`, `:1432`). Today's `placeSend` writes only the main text, so an
  attachment queued meanwhile stays (`composerDrafts.svelte.ts:304`). Placing a whole snapshot through the same gates
  replaced a newly queued attachment and translation text in the reproduction. `takeUnplaced` marks a send placed
  before returning it (`sendDraft.ts:99`).
- Fixed in plan: a draft send's snapshot is placed only into a composer whose four parts are all empty, at both screen
  placements and in the journal's `restore`; otherwise it stays unplaced with its hand-off row, and `takeUnplaced` does
  not mark it placed until the gate passes. An ordinary failed send is placed as today.

## P2

### A4. `tools: []` does not make a hook request read-only

- Plan (Rules, as audited): "A hook never writes the chat." D12: "keeps nothing."
- Code: an empty tool list skips tool discovery (`request.ts:378`), but the before and after request replacers run
  with the chat's ordinary plugin context (`:420`, `:475`, `pluginContext.ts:67`), and the server tracks the request
  with the chat ref (`server/src/llm/requests.ts:1210`).
- Fixed in plan: the rule is "The feature writes the chat in two places only", and says a hook request is an ordinary
  tab request for plugins, the request history, and the fetch log. Current State, D5, D12, and slice 5 follow. A15
  below caught two summaries the first correction missed.

### A5. The stored original is shown only on the stored translation path

- Plan (Current State, as audited): "`Chat.svelte` shows a fresh stored translation on an explicit toggle, or by the
  chat's `autoTranslate` while a target language is set." Slice 6's test: "a user message appended this way is returned
  as fresh".
- Code: every stored display is behind `usesStoredTranslation()`, the LLM translator with the `message` target
  (`storedTranslation.svelte.ts:66`, `Chat.svelte:349`); the toggle needs a target language (`Chat.svelte:1832`).
  `handOff` returns the ids of runs it started, so a fresh message yields none (`server/src/translation/runner.ts:582`,
  `:642`); it is `translate` that answers `fresh` (`:532`).
- Fixed in plan: Current State states the conditions, slice 6's settings description tells the user, and its tests and
  manual checks name them. The owner's decision to store at the server (D2) stands.

### A6. A retry with another original under a kept request id would be refused

- Plan (D14, as audited): "`inputOriginal` joins the request fingerprint when present: a retry of the same draft send
  carries the same original".
- Code: `sendDrafts` keeps a failed send's ids by its sent text alone (`sendDraft.ts:47`, `:61`, `:70`, `:89`), so the
  same draft after an edit of the main box or of the hook's option reuses the request id with another body; a differing
  fingerprint is refused as `requestIdReused` (`generationJobs.ts:2351`). Reproduced.
- Fixed in plan: D14 is reversed. `inputOriginal` is not part of the fingerprint, like the revision and the binding
  ids; a replayed request keeps what its first attempt stored. Slice 6 tests the replay. Astra proposed carrying an
  immutable send descriptor instead; the reversal needs no new retained state, and Astra confirmed it in the third turn.

### A9. The stale-result guard read one of the two boxes

- Plan (slice 4, as audited): "the result is applied only when the chat is still shown and its main box still holds the
  text the run began with."
- Code: the run reads both boxes and writes the draft box, and both stay editable during a run
  (`DefaultChatScreen.svelte:1393`); the composer already counts edits (`composerDrafts.svelte.ts:129`, `:315`).
- Fixed in plan, with A14: an edit of either box since the run began drops a Draft result without an alert.

### A14. Comparing the texts at the end misses an edit that was undone

- Plan (slice 4, after the first corrections): "neither the main box nor the draft box was edited since the run began
  (the composer's edit version, or the two captured texts)."
- Code: `composerDrafts.svelte.ts:129` advances an edit version on every change, and `restore` fences on it (`:322`).
- Fixed in plan: the guard is an edit revision of the two boxes; an undone edit counts. A BTW result ignores composer
  edits, since it writes no box.

## P3

- **A3.** Slice 6 named `serverCommands.ts` alone for forwarding the field; the explicit context construction in
  `src/ts/process/serverGeneration.ts:123` drops a field it does not name, and `sendChat` is in
  `src/ts/process/index.svelte.ts:52`. Fixed in plan: slice 6 lists the whole path and tests the field at
  `runServerJob`.
- **A7.** Slice 1 lacked the maintained boot fixture (`normalize/shared.ts:25`, `bootSnapshot.test.ts:164`) and the
  settings report's exclusion list (`snapshots.svelte.ts:96`), without which a report would carry prompt text. Fixed in
  plan, with the tests that count kinds.
- **A8.** The settings search has its own page list (`src/ts/setting/searchIndex.ts:186`). Fixed in plan: slice 2
  registers the page there and stubs it in `Settings.search.test.ts`.
- **A10.** `findChat` returns a `DeepReadonly` chat, which the history builder's `readonly Message[]` parameter does
  not accept (TS2322, checked without emit); the request's own pin starts after the history is built (`request.ts:277`);
  the builder's header and the translation guide say the tab builds no history. Fixed in plan: slice 3 pins the chat for
  the runner's whole length, widens the two functions' parameter (zero diagnostics with the server caller, third turn),
  counts with the tab's `countTokens` under the captured scope, cancels a returned stream before throwing, and names
  `translation.md`.
- **A11.** "Comes back whole" could not be met from `draftOf.original` and a serialized text: the translation box and
  the attachment ids were not recoverable, and restoring tags plus files would append the tags twice. Fixed in plan:
  `SendDraft.composer` is the raw snapshot, tags are serialized only for the request, the marker survives the takeover
  and `restore`'s return, and slice 4 names every path that copies a composer.
- **A12.** `seed` counts only format 1 rows as supported (`draftJournal.ts:856`, `:876`), so the new reader would report
  its own rows as `journalSkipped`. Fixed in plan: slice 4 includes the count.
- **A15.** Current State and D12 still said a BTW result is kept nowhere. Fixed in plan: held in the screen's memory
  only, and the request history and plugins see the request.
- **A16.** "With … no target language a stored translation is kept and not shown" was too broad: a row the user chose
  to show keeps its choice after the language is cleared (`Chat.svelte:357`, `:366`,
  `storedTranslation.svelte.ts:94`). Fixed in plan with Astra's replacement, not re-checked in a further turn.

## Noted, not recommended

- A hook as a server job, or a lock across tabs, to make "busy" hold beyond the screen: D5 and D10 accept that another
  tab, device, or plugin can send during a run.
- `alertSelect` in place of the BTW picker: it joins labels with `||`, and a hook name is free text (`alert.ts:320`).
- A per-hook merge or collection items: the list is one unit, merged whole.
- A greeting entry or a tokenizer per hook profile in the history: the builder's stored-message walk and the main
  model's scope are its contract.
- A server capability check for the older-server case: D15 accepts the lost option.
- Clearing a row's explicit show choice when the target language is cleared (A16): the plan describes the behavior, it
  does not change it.
