# Lore Budget Send Stop Plan audit, 2026-11-13

- Plan: `docs/plan/lore-budget-send-stop.md`, archived: `git show 85494cb19:docs/plan/lore-budget-send-stop.md`
- Commit audited: `8bfc4ce83` (`dev`); the corrected plan is committed with this report
- Mode: `full`
- Model: Claude Fable 5.2, a read-only sub-agent with no part in the drafting, in place of the usual Sol session at the
  owner's request; report written by the session that drafted the plan (Claude Fable 5.2), before any plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 0     |
| P2         | 3     |
| P3         | 21    |
| unverified | 2     |

All three P2 and all twenty-one P3 are `fixed in plan`. F1 to F16, U1, and U2 came from the first turn; the drafting
session read F1, F2, F4, F6, F9, F11, and F15 against the code before editing and took the rest from the auditor's
line references. The auditor then read the corrected plan in the same session: it confirmed every fix, disputed none,
and found N1 to N8 in the corrections. N1 to N8 were applied afterwards and were not read again. One of them changes a
mechanism: D10's kind check moved from the route to the runner (N7). The two `unverified` claims are recorded in the
plan's Not In This Plan and in [found issues](../../../backlog/found-issues.md).

F15 is a product question, not a wording fix: an entry marked `@@ignore_on_max_context` is rejected like any other, so
a card that uses the decorator as meant would stop every send. The plan carries the recommended answer as D19 (such
an entry never causes a stop). The owner accepted D19 on 2026-11-13, after reading this finding.

The slice 1 half held against the code as drafted. The three P2 are all on the tab side of slice 2.

The auditor changed no file (`git status` showed only the plan, edited by the drafting session) and ran no test. The
two turns took about 21 minutes and 0.4 M tokens.

Found consistent: D8, the budget pass reading only `tokens` and `priority` after the counts are awaited
(`shared/lore/activation.ts:730`); activation storing nothing but the flags, since `parseCBS` runs without `runVar`
(`server/src/lua/bindings.ts:1309`, `shared/cbs/registry.ts:874`); the flags reaching the chat through a microtask
flush (`bindings.ts:572`, `server/src/jobs/jobScope.ts:629`); `actives: []` being safe, as only `assemblePrompt` would
pass the option (`server/src/prompt/assemble.ts:1300`); the alert path throwing `SendError` with `stage: "assembly"`
and never taking the inlay path (`server/src/prompt/runner.ts:1760`); a terminal field traveling whole through
finalization, `projectTerminal`, the kept outcome, receipts, and the tab's transport
(`server/src/jobs/generationJobs.ts:1656`, `:417`, `:590`, `server/src/data/generationReceipts.ts:294`,
`src/ts/network/generationJobs.ts:440`); `firstSpeakerRound` (`runner.ts:577`, `:615`); the chat's state at the stop
for each kind (`runner.ts:510`, `:1457`, `:2391`, `:1291`); D10's fixed property list and the part facade
(`server/src/routes/generations.ts:210`, `server/src/jobs/commandRunner.ts:333`); D11, the fingerprint and the replay
(`generationJobs.ts:377`, `:2234`); the flush before a create (`src/ts/process/serverCommands.ts:1095`); the callers of
`sendChatMain` and `sendChat`; the setting's files; `alertSelect` joining on `||` (`src/ts/alert.ts:318`); the limit's
source on a character and a group (`activation.ts:329`, `shared/database.ts:719`, `:891`); and every test file, guide,
and section the plan names.

Re-check list: `patchMessage` still closes an open fence (`server/src/data/chatStore.ts:2543`); feed rows are still
measured whole (`shared/resources.ts:540`, `server/src/data/resourceStore.ts:3636`); `STORE_TABLES_SQL` still runs only
on a fresh database (`resourceStore.ts:3857`); `sendText` still counts an open socket (`generationJobs.ts:1020`). The
plan depends on none of them.

## P2

### F1. `reportEnd` cannot tell the creating call from a recovered follow

- Plan (slice 2, the answer; D15): "for a job this call created with the field, a `loreOverBudget` end raises no alert
  in `reportEnd` … any follow with no waiting caller (a reloaded tab, another tab or device), goes to `alertJobError`
  as today."
- Code: `reportEnd(end, jobId, lifecycle.creator)` runs inside the follow lifecycle
  (`src/ts/process/serverCommands.ts:459`), before the terminal reaches `runPinnedServerJob` (`:1301`). `creator` is
  `!options.ticket` (`:363`), so the boot resume (`:966`) is a creator too: suppressing on it would leave a reloaded
  tab with neither dialog nor alert. A tab that only watches returns before `reportEnd` (`:457`).
- `fixed in plan`: the creating call marks its own follow. `followJobToEnd` gains an option stored on the
  `FollowLifecycle`; `runPinnedServerJob` sets it for `started` and an owned `replayed`, never for `followed`; an
  existing lifecycle keeps what it has, and the call checks `following.has(jobId)` before it follows (N1). D15 now says
  the creating tab shows a stop once, a tab that took the job over shows the ordinary error (N2), and a watching tab
  shows nothing. Current State gained "Who reports a job's end".

### F2. A reroll with nothing to remove was stopped silently

- Plan (slice 2, the resend): "the fallback reroll: its removal and send again, only after `rerollHistory.restore`
  answered `restored`. An `unsafe` restoration shows its alert and no dialog."
- Code: on a chat that ends with a user message `rerollCarrier` is null (`shared/rerollCandidates.ts:305`), `reroll()`
  takes the fallback with `removed = []` (`src/lib/ChatScreens/DefaultChatScreen.svelte:685`), and `restore` answers
  `"none"` (`src/ts/process/rerollHistory.ts:189`). That is the state a stopped send leaves after Close.
- `fixed in plan`: the dialog opens when the send settled and `restore` answered `restored` or nothing had been
  removed. An `unsafe` restoration shows the terminal's `message` and then its own alert, as today (N3); any other
  answer shows the `message`.

### F3. The fallback reroll's repeat could empty a chat that is no longer selected

- Plan (D12, D14): "The resend is the call site's own request again"; "for another chat the dialog still offers the
  first button and Close."
- Code: the fallback block builds its lists from `currentChat.message` and filters the chat `ref` by them
  (`DefaultChatScreen.svelte:685-714`). No await separates the two today. After an awaited dialog `currentChat` can be
  another chat, and the filter would remove every message of `ref`. Re-run as it stands this would be a P1.
- `fixed in plan`: the block becomes a function of `ref` that reads through `findChat(ref)`, used by the first run and
  the repeat; it makes `reroll()`'s `isChatBusy` and `refuseOrphanedOverrides` checks itself (N4); the site pins the
  chat across the dialog, and the dialog closes when the chat leaves the list (N5). A test selects another chat while
  the dialog is open.

## P3

Each is `fixed in plan`.

- **F4.** "`GenerationFailure` gains `lore`, and `errorTerminal` copies it": `markFailure` copies a fixed key list
  (`generationJobs.ts:165`) and would drop it. The slice names the list, and the Rules' comment list names
  `errorTerminal`'s "content-free" comment.
- **F5.** "`LoreActivation` gains `stopped: boolean`": a required field changes `/test_lorebook`'s JSON
  (`server/src/prompt/commands.ts:314`, `src/ts/process/command.ts:275`) and four typed mocks. Now `stopped?: true`,
  present only on a stop.
- **F6.** "`setChatMeta(ref, { loreBudgetWarnOff: true })`": the field is not in `SUMMARY_FIELD_TYPES`, so an unloaded
  chat throws (`src/ts/storage/chatStore.svelte.ts:4424`). The site pins the chat.
- **F7.** "a store beside `chatBindingDialog`": that store answers nothing, and its Escape handling, mock, and guides
  were not named (`src/ts/gui/dialogLayers.ts:8`, `src/ts/hotkey.ts:548`, `src/ts/tests/storesMock.ts:35`). Named now,
  with Escape and unmount as Close and two stops opening one at a time.
- **F8.** "The sidebar's character editor on its lorebook tab": not reachable over open settings, for `§playground`,
  under the local DevTool view, or for a `private` card (`src/lib/SideBars/Sidebar.svelte:1180`, `:1185`, `:1219`,
  `src/lib/SideBars/CharConfig.svelte:369`). The slice closes settings, hides the buttons where the tab cannot show,
  and adds one-shot requests read reactively.
- **F9.** "opened with `openSetting` as `ContextMeter.svelte`'s `openSettings` builds its hit": the meter builds a
  section hit (`src/lib/ChatScreens/ContextMeter.svelte:726`). Now an item hit from `settingLocation("adv.lbToken")`.
  The inputs' `max` of 4096 under a default of 8000 went to found issues.
- **F10.** "`loreRejected` with used and limit": it takes a count and tokens (`src/lang/en.ts:1961`). Both strings are
  named.
- **F11.** "`sendChatMain` again without the input": an empty resend never sets `sentUserMessageId`
  (`runner.ts:469-521`), so the user message loses its auto-translation. The resend now passes the same `input` and
  `userMessageId`; a draft that was put back gets the alert.
- **F12.** Three loose Current State sentences (a reroll's rollback, the terminal's `sequence`, previews running the
  same call) were tightened.
- **F13.** "added to `METATRON_ONLY_SETTINGS`": the `contextMeter*` settings are not in it
  (`server/src/data/upstream/exportDatabase.ts:126`). The slice says it departs from them.
- **F14.** "beside the `memoryRequiredOverCap` cases in `memoryJobs.test.ts`": every describe there is about memory.
  The job tests go to `promptRunner.test.ts`.
- **F15.** Not addressed in the draft: `@@ignore_on_max_context` sets priority -1000 (`activation.ts:544`) and the pass
  counts the entry as rejected (`:749`). D19, which the owner accepted.
- **F16.** The Rules' comment list was short; the module comment, `LoreActivation`'s, and the route's were added.
- **N1.** "The call hands the stop up only when its own follow carried the mark": `followJobToEnd` returns the existing
  promise (`serverCommands.ts:347`), so the call cannot learn it afterwards. The check and the outcomes are named, and
  the stop travels on `ServerJobResult`.
- **N2.** "A stop is shown once" holds per tab (`serverCommands.ts:457`). Reworded.
- **N3.** "An `unsafe` restoration shows its own alert" would hide the reason (`DefaultChatScreen.svelte:717`). It
  shows the `message` too, and the texts that called the English `message` a no-caller fallback were widened.
- **N4.** "The repeat does not go through `reroll()` again" skipped two checks (`DefaultChatScreen.svelte:652`, `:674`).
  The shared function makes them.
- **N5.** The pin does not cover a removed chat (`chatStore.svelte.ts:4419`). The dialog resolves as Close.
- **N6.** D19 did not say how the pass knows the decorator: an active keeps no trace of it, and -1000 is reachable
  through `@@priority`, the insert order, and a parent's order (`activation.ts:603`, `:369`, `:393`). A side set like
  `activeNames`, filled from the decorator's case.
- **N7.** "a `preview` with the field that is not stopped" could not fail for the route's drop, since the runner also
  ignores the field for a preview. The route now keeps the field for any kind and the runner alone checks the kind.
- **N8.** The Status line still said "Not audited yet".

## Unverified

- **U1.** Whether a preview's activation flags are stored: the runner flushes the job's chat metadata for a preview
  (`runner.ts:616`), while `generationJobs.ts:352` says a preview writes nothing. If they are, a preview between a stop
  and its resend sets a flag the stop left unset. Today's behavior either way; in found issues.
- **U2.** Whether a negative limit can be stored. The terminal's parser would refuse it (`shared/contextReport.ts:306`),
  so that chat would get the alert and never the dialog. In the plan's Not In This Plan.
