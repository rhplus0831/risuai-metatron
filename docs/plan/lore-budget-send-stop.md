# Lore Budget Send Stop Plan

Status: drafted 2026-11-13 at `fb09d2b25` from the owner's request. D1 is the owner's request; the owner accepted D2
to D6 the same day, as recommended. D7 to D18 are this plan's own, found against the code. Audited against `8bfc4ce83`
on 2026-11-13 ([report](../reports/audits/plan-runner/lore-budget-send-stop-2026-11-13.md)): no P1, three P2, and
twenty-one P3 findings, all fixed here; two claims it could not settle are under Not In This Plan. D19 comes from the
audit and narrows D1; the owner accepted it the same day. Landed: 1 (`2936260af`).

Sources: the owner's request (2026-11-13: when active lorebook entries do not fit the lorebook token limit, warn
instead of processing the message; a checkbox on the Interaction page, on by default; the user can turn the warning off
per chat, or stop and change the limit or manage the lorebook); `activateLore`, `LoreActivationInput`, `LoreBudget`,
and `LoreActivation` in `shared/lore/activation.ts`; `activateJobLore` and `setChatVar` in `server/src/lua/bindings.ts`;
the metadata queue in `server/src/jobs/jobScope.ts`; `assemblePrompt`, `AssemblyHost`, `AssembleInput`, and
`buildContextReport` in `server/src/prompt/assemble.ts`; `runPromptSend`, `SendError`, and `firstSpeakerRound` in
`server/src/prompt/runner.ts`; `parseCreateBody` in `server/src/routes/generations.ts`; `requestFingerprint`,
`errorTerminal`, and `GenerationFailure` in `server/src/jobs/generationJobs.ts`; the part facade in
`server/src/jobs/commandRunner.ts`; `GenerationContext`, `GENERATION_ERROR_CODES`, and the `error` terminal in
`shared/jobs.ts`; `reportedLoreRejections` and `ContextReport` in `shared/contextReport.ts`; `sendPinned` and
`ServerSendArg` in `src/ts/process/serverGeneration.ts`; `runServerJob`, `ServerJobRequest`, and `reportEnd` in
`src/ts/process/serverCommands.ts`; `runSend` in `src/ts/process/index.svelte.ts`; `sendMain`, `sendChatMain`, `reroll`,
and `runAutoMode` in `src/lib/ChatScreens/DefaultChatScreen.svelte`; `ContextMeter.svelte`; `chatBindingDialog` and
`ChatBindingDialog.svelte`; `interactionSettingsData.ts`; `LoreBookSetting.svelte`, read at `fb09d2b25`; the
[chat pipeline](../structure/chat-pipeline.md) and [server generation](../structure/server-generation.md) guides. The
identifiers are the anchors. Re-verify each cited location before editing (STRUCTURE.md protocol step 5).

## Goal

A send from the chat screen stops before the model request when the lore budget leaves an activated entry out, and
asks the user what to do.

- **The stop.** With the setting on, a send, a continue, or a reroll started on the chat screen ends without a model
  request when the budget pass rejects at least one entry that its author did not mark as droppable (D19). Nothing the
  stopped activation would have stored is stored.
- **The dialog.** It names the entries left out, their tokens, and the limit, and offers: turn the warning off for
  this chat and send, change the token limit, manage the lorebook, or close.
- **Per chat.** A chat that turned the warning off sends as today. The switch is the chat's existing
  `loreBudgetWarnOff`.
- **Everything else is as today.** A send with no person in front of it (a plugin, auto mode, multisend, a command
  sequence, the DevTool) is never stopped. Its reply's context report names the entries left out and the context meter
  warns, as it does now.

Not goals: a "send once anyway" choice (D4); a notice inside the message bubble (D6); stopping the later rounds of a
job (D5); checking the budget before the user's message is stored (D2).

## Current State

- **The budget pass.** `activateLore` collects the activated entries, awaits their token counts, writes the pending
  flags with `host.setChatVar`, sorts by priority, and drops every entry that does not fit `loreToken` (the owner's
  `loreSettings.tokenBudget`, else `providers.loreBookToken`, default 8000). The result carries
  `budget: { used, limit, rejectedCount, rejectedTokens, rejected }`.
- **The flags.** An activated entry with `keep_activate_after_match` or `dont_activate_after_match` sets
  `__internal_ka_<id>` or `__internal_da_<id>` to `"true"`, before the budget pass, so a rejected entry sets it too. On
  the server `setChatVar` queues a `scriptstate` patch on the job's metadata queue, which a microtask flushes as a chat
  `meta` write. A job that fails later in assembly does not undo that write (an in-place reroll's rollback, which
  restores the variables its attempt owned, is the one exception). An entry with `ignore_on_max_context` gets priority
  -1000 (unless a later `@@priority` replaces it), so the budget pass tries it late, and one that does not fit is
  counted as rejected like any other. An active keeps no trace of the decorator, and -1000 can also come from
  `@@priority`, the insert order, or a parent's order.
- **Where activation runs.** For a send, in the server job only (a preview kind runs the same call): `assemblePrompt`
  calls `host.activateLore()` after
  `runCurrentChatFunction` and the description (which can embed `additionalText`), and before history, image captions,
  the start trigger, memory, tool listing, and the final recount. The runner has already run the input stage: the
  user's message is in the chat under `userMessageId` (a continue or an in-place reroll has locked its target).
- **What the user sees today.** `buildContextReport` copies the budget into the reply's `generationInfo.context`
  (`lore`, the first 8 names of at most 80 code points through `reportedLoreRejections`). `ContextMeter.svelte` shows a
  red book icon on its chip and lists the entries in its popover. The popover's toggle sets or unsets the chat's
  `loreBudgetWarnOff`, which hides the icon only.
- **A coded assembly failure.** `memoryRequiredOverCap` is the precedent: assembly returns
  `{ type: "alert", error, code }`, the runner throws `SendError` with `stage: "assembly"` and the code, `markFailure`
  copies a fixed key list (`stage`, `requestId`, `providerCode`, `code`) onto the failure, `errorTerminal` copies the
  code into the `error` terminal, and the tab's `reportEnd` shows the message through `alertJobError`. An `alert` never
  takes the `inlayErrorResponse` path. The terminal has no field for a failure's own data (`sequence` is a sequence's
  progress).
- **Who reports a job's end.** `reportEnd` runs inside the follow lifecycle of `followJobToEnd`, before the terminal
  reaches the caller that created the job. Its `creator` is true for every follow without a ticket, the boot resume
  (`resumeServerJobs`) included, so it does not mean "a call is waiting for this job". A tab that only watches a chat
  returns before `reportEnd` and shows nothing.
- **What a caller learns.** `runServerJob` returns the terminal, but `sendChatOnServer` drops it: `sendChat` answers a
  boolean and `onEnd` carries settlement fields only. `sendChatMain` returns `{ ran, ok, settled, blockedChats }`.
- **The fallback reroll.** `reroll()` reads `currentChat` to pick the replies to remove and edits the chat `ref` by
  that list, with no await in between. On a chat that ends with the user's message it removes nothing, and
  `rerollHistory.restore` then answers `none`.
- **After a failed send.** The composer was cleared at dispatch. When the chat holds the user message the draft is
  dropped (`landed`), and its `requestId` is not kept. An empty send then generates for that message: the screen appends
  nothing when the last message is the user's, and the server skips its input stage for an empty input. A failed
  in-place reroll restores the previous candidate in its final write; a failed continue releases its lock with the text
  unchanged. The fallback reroll puts the removed replies back through `rerollHistory.restore`.
- **Request identity.** `requestFingerprint` hashes the kind, the chat, the command, the input, and the three message
  ids. A create with a retained `requestId` and the same fingerprint replays the earlier job, its error terminal
  included. `parseCreateBody` rebuilds `context` from a fixed property list, so an unknown field is dropped.
- **Callers of `sendChat`.** The screen's `sendChatMain` (the send and continue, the in-place reroll, the fallback
  reroll, and auto mode), `multisend.ts`, `/multisend` in `command.ts`, the DevTool, and the plugin API. All reach
  `sendPinned`. A command sequence is one job whose parts call `runPromptSend` with the job's context minus four
  fields.
- **The setting's neighbors.** `contextMeterLookahead` is the nearest boolean `ui` setting: `Database` in
  `shared/database.ts`, `SECTION_FIELDS.ui` in `shared/sections.ts`, `["boolean", true]` in
  `server/src/data/normalize/ui.ts`, an item and a section entry in `interactionSettingsData.ts`, strings in `en.ts` and
  `ko.ts`, and the boot snapshot fixture.

## Rules For Every Slice

One slice is one session and one commit. Workflow per slice: `opus-workflow` (both are marked _hard_: slice 1 changes
a `shared/` contract and the job's failure path, slice 2 the screen's send paths).

- **Checks.** The slice's tests (under "Test"), then `pnpm check`, the focused files through the wrapper while
  iterating, `pnpm --silent test:agent` once whole after the last source edit, `pnpm format:check`, `pnpm check:docs`
  for a guide edit, and `pnpm check:tests` for an added test file. Run `pnpm check` again after the last test edit. V4
  (`rg` each changed export and wire field) and V6 (each new test shown failing once with its guarded line broken).
- **Names.** Final once slice 1 lands: the request field `context.stopOverLoreBudget`, the failure code
  `loreOverBudget`, and the terminal's `lore` field. Final once slice 2 lands: the setting `loreBudgetStop`. The chat
  field `loreBudgetWarnOff` keeps its name and shape.
- **Off means today.** A request without `stopOverLoreBudget` runs exactly as at `fb09d2b25`: the same activation
  result, the same flag writes, the same context report. Slice 1 has a test for that. The one reorder inside
  `activateLore` (D8) changes no result.
- **One reader each.** Only the tab reads the setting and the chat's `loreBudgetWarnOff`, in one exported function
  (slice 2). The server reads the request field and nothing else (D9).
- **A tab or server from before a slice.** An older server drops the request field in `parseCreateBody` and replies as
  today. An older tab never sends the field. A tab loaded before slice 2 shows a `loreOverBudget` end as an ordinary
  job error, which it cannot receive because it never asks.
- **Strings.** New text goes in `src/lang/en.ts` with its Korean in `src/lang/ko.ts` in the same slice. The text says
  "left out", not "truncated": an entry is dropped whole.
- **Guide.** Each slice names its guides; their `Invariants` apply, and the slice updates the sections and module
  comments that name a changed contract: in slice 1 the module comment, `LoreBudget`'s, and `LoreActivation`'s in
  `shared/lore/activation.ts`, `GENERATION_ERROR_CODES`', `GenerationFailure`'s, `markFailure`'s, and `errorTerminal`'s
  (its fields are no longer all content-free: `lore` holds entry names), the assembly result's `alert` variant, the
  create route's comment in `server/src/routes/generations.ts`, and `runPromptJob`'s sequence; in slice 2 `reportEnd`'s,
  `sendChatMain`'s, and `loreBudgetWarnOff`'s in `shared/database.ts`.
  Comments and test titles describe behavior, not this plan (STRUCTURE.md T5).
- **Manual checks.** Each slice lists the checks it cannot run. The slice report gives them to the owner as a
  checklist; what is still unrun when the plan closes moves to [manual checks](../backlog/manual-checks.md) under this
  plan's name.

## Order

Serial: 1 → 2. Slice 2 uses slice 1's request field, failure code, and terminal field, and both edit `shared/jobs.ts`
readers and the chat pipeline guide.

If the run stops after slice 1, nothing a user can reach changes: no caller sets the field, so no job stops. The server
carries an unused request field and failure code.

## Slice 1. The stop in the job (_hard_, `chat-pipeline.md`, `server-generation.md`)

**Change.**

- `shared/lore/activation.ts`: `LoreActivationInput` gains optional `stopOverBudget`, and `LoreActivation` gains
  optional `stopped: true`, present only on a stop, so `/test_lorebook`'s JSON and the tests' typed results stay as
  they are. The budget pass moves ahead of the `pendingFlags` writes (D8). With `stopOverBudget` and at least one
  rejected entry that does not carry `ignore_on_max_context` (D19), `activateLore` returns
  `{ actives: [], matchLog, budget, stopped: true }` and calls `host.setChatVar` for no flag. Otherwise it writes the
  flags and continues as today. `budget` counts and names every rejected entry either way. Which actives carry the
  decorator is tracked from the decorator's own case, in a side set like `activeNames`: never read from the priority,
  and not a field of `LoreActive`, whose JSON `/test_lorebook` prints.
- The server host: `activateJobLore` and `AssemblyHost.activateLore` take the option and pass it through. The other
  callers (`/test_lorebook` in `server/src/prompt/commands.ts`, the Lua binding, the tab's `loadLoreBookV3Prompt`) pass
  nothing.
- `shared/jobs.ts`:
  - `GenerationContext` gains optional `stopOverLoreBudget: boolean`.
  - `GENERATION_ERROR_CODES` gains `loreOverBudget`.
  - The `error` terminal gains optional `lore`, present only with that code.
- `shared/contextReport.ts` exports the terminal field's type and its parser (suggested: `LoreBudgetStop`,
  `parseLoreBudgetStop`): `{ budgetUsed, budget, rejectedCount, rejectedTokens, rejected }`, the names capped by
  `reportedLoreRejections` and checked as the report's `lore.rejected` is.
- `parseCreateBody`: `stopOverLoreBudget` absent or a boolean, anything else refused like the other fields. It is kept
  only when true, whatever the kind (D10).
- `requestFingerprint` does not change (D11).
- `AssembleInput` gains `stopOverLoreBudget`. Right after `host.activateLore` and its `host.fence()`, a `stopped`
  activation returns `{ type: "alert", error, code: "loreOverBudget", lore }`. The `alert` variant of the assembly
  result gains optional `lore`. `error` is the English text every alert of a stop shows (D15),
  suggested: "The lorebook token limit (8000) left out 3 entries (1240 tokens): Name (400), Name (440), Name (400)",
  with "and N more" after the eighth name.
- The runner passes `stopOverLoreBudget` to `assemblePrompt` only for the job's first assembly (`firstSpeakerRound`, not
  `rounds.count`: a later group speaker also has a zero count) and only for the kinds `send`, `continue`, `group`, and
  `reroll`, so never for a preview kind (D5, D10). Its `alert` branch carries `lore` into `SendError`.
- `GenerationFailure` gains `lore`, `markFailure`'s key list gains it, and `errorTerminal` copies it when the code is
  `loreOverBudget` and it parses. From the terminal on it needs no code: finalization, `projectTerminal`, the kept
  outcome, the receipt, and a replay carry the terminal's JSON whole, and the tab's transport checks only the event's
  type.
- The part facade in `commandRunner.ts` removes `stopOverLoreBudget` with the fields it already removes (D10).
- No file under `src/` changes beyond what the type check needs.

**Test.**

- `server/src/tests/lore.test.ts`, beside the rejection cases:
  - With the option and a rejection: `stopped`, no `setChatVar` call for a `keep_activate_after_match` or a
    `dont_activate_after_match` entry (one rejected, one that fit), and the same `budget` as without the option.
  - With the option and no rejection: the flags are written and the result equals the one without the option.
  - Without the option: a rejected entry's flag is written, as today, and the result has no `stopped` key.
  - With the option, when every rejected entry carries `ignore_on_max_context`: not stopped, the flags are written,
    and `budget` still counts them. With one rejected entry that does not carry it: stopped.
- `server/src/tests/assemble.test.ts`: the `alert` with its code and `lore` (nine rejections name eight), and the
  host's memory, tool listing, and recount were not called. Without the input field the report holds the rejection as
  today.
- `shared/contextReport.test.ts`: the parser accepts the shape and refuses a malformed list, like the report's cases.
- `server/src/tests/generations.test.ts`, in the create-body table: a non-boolean is refused. `parseCreateBody` is
  private to the route, so what it keeps is tested through the job: the cases below for a `send`.
- Job tests in `server/src/tests/promptRunner.test.ts`, beside "a send", the group case, and "in-place reply
  candidates":
  - A send with the field on a chat whose lore exceeds the limit ends `error` with `code`, `stage: "assembly"`, and
    `lore`. The user message is stored, no provider request was made, and the chat's `scriptstate` holds no
    `$__internal_` key.
  - The same body without the field replies, and its context report names the rejection.
  - An in-place reroll with the field: the previous candidate is the selected one again.
  - A `preview` and a `previewPrompt` with the field are not stopped and return their result.
  - A group send with the field where only the second speaker's activation rejects (an entry keyed on the first
    speaker's reply): both speakers reply.
- `server/src/tests/generationReceipts.test.ts`: a replayed terminal keeps `lore`.
- `server/src/tests/commandSequences.test.ts`: a part of a command job whose context holds the field is not stopped.

**Guide.** `chat-pipeline.md`: the Lore entry (the option and what a stopped activation leaves) and Lore matching.
`server-generation.md`: Prompt job execution (the stop, first assembly only) and Generation admission's field list if it
names context fields. `structured-memory/read.md` names `memoryRequiredOverCap` beside `noteJobDone`: add nothing
there.

**Manual checks.** None: nothing a user can reach changes.

## Slice 2. The setting, the dialog, and the resend (_hard_, `chat-pipeline.md`, `ui-theming.md`, `persistence.md`, `settings-i18n.md`)

**Change.**

- The setting `loreBudgetStop: boolean` in the `ui` section, default true, following `contextMeterLookahead` through
  the files under Current State. It is a checkbox in the Interaction page's `interaction.input` section (suggested id:
  `interaction.loreBudgetStop`). Suggested English: label "Stop a send when lorebook entries are left out"; help "When
  the lorebook token limit leaves out an activated entry, a send, continue, or reroll from the chat screen stops before
  the model is called and asks what to do. Sends from plugins, auto mode, multisend, and commands are not stopped; the
  context meter warns after them. Entries marked `@@ignore_on_max_context` never cause a stop. A chat can turn this
  off." It is added to `METATRON_ONLY_SETTINGS` in
  `server/src/data/upstream/exportDatabase.ts`, whose rule is "settings upstream's `Database` lacks", with that list's
  test. This departs from `contextMeterLookahead`, which is not in the list.
- One exported function (suggested: `wantsLoreBudgetStop(ref)` in `src/ts/process/loreOverrides.ts` or a file beside
  it): true when `settings.ui.loreBudgetStop` is on and the chat's `loreBudgetWarnOff` is not `true`.
- The request: `ServerSendArg` and `ServerJobRequest.context` gain the field, and `sendPinned` copies it into the
  context. `sendChatMain` gains an option that sets it from `wantsLoreBudgetStop`. The send and continue, the in-place
  reroll, and the fallback reroll pass that option; `runAutoMode` does not (D5). No other `sendChat` caller changes.
- The answer (D15):
  - `followJobToEnd` gains an option, stored on the `FollowLifecycle` it creates, that says a call is waiting for a
    lore stop. `runPinnedServerJob` sets it when its request context had the field and the create outcome is `started`
    or an owned `replayed`; never for `followed` (another action's job, whose terminal `sendPinned` does not get) and
    never for the follow it starts after `onStart` threw. A lifecycle that already existed keeps what it has:
    `followJobToEnd` returns the existing promise, so the call checks `following.has(jobId)` before it follows and
    carries the answer on `ServerJobResult`.
  - With that mark, an `error` end coded `loreOverBudget` whose `lore` parses (`parseLoreBudgetStop`) raises no alert
    in `reportEnd`. Every other end goes to `alertJobError` as today: a `lore` that does not parse, a lifecycle without
    the mark, and the boot resume (`resumeServerJobs`), which is a `creator` follow with no caller.
  - The call hands the stop up only when its own follow carried the mark, so this tab shows a stop once, as the dialog
    or as the alert: `ServerSendResult.loreStop` (the parsed `lore` and the terminal's `message`), built from that
    answer on the job result and not from the terminal alone, through `runSend`'s `onEnd`, to `sendChatMain`'s result.
- The dialog: a store beside `chatBindingDialog` in `src/ts/stores.svelte.ts` (suggested: `loreBudgetStopDialog`), a
  component beside `ChatBindingDialog.svelte` (suggested: `LoreBudgetStopDialog.svelte`) mounted in `App.svelte`, and
  one function that opens it and resolves with the choice (D13). Unlike `chatBindingDialog`, which holds a `ChatRef`
  and answers nothing, the store holds the stop and its resolver.
  - It follows the binding dialog's layer rules: `src/ts/gui/dialogLayers.ts`, `closeBindingLayer` in
    `src/ts/hotkey.ts`, and the mock in `src/ts/tests/storesMock.ts`. Escape and an unmount resolve as Close, and so
    does the chat leaving the list while the dialog is open (`chatEntry(ref)` gone), as the binding dialog closes
    itself.
  - Chats send at the same time, so two stops can be due at once: the dialogs open one at a time, in the order the
    stops arrived.
  - It shows a title; the meter's `loreBudget` row with used and limit; `loreRejected` with the count and tokens;
    whether the limit is the chat owner's own (`loreSettings.tokenBudget`, on a character or a group) or the global
    one; the named entries with their tokens, then `loreRejectedMore` for the rest; and a sentence that the model was
    not called and, for a send, that the message is in the chat.
- The buttons:
  - **Don't warn in this chat and send.** `setChatMeta(ref, { loreBudgetWarnOff: true })`, then the resend below.
    `setChatMeta` refuses this field on a chat that is not loaded, so the site pins the chat (`pinChat`) from the stop
    until the resend's job is created or the dialog closes.
  - **Change the token limit.** With an owner budget: the owner's lorebook tab on its settings submenu. Otherwise the
    settings item `adv.lbToken`, opened with `openSetting` on a `kind: "item"` hit built from
    `settingLocation("adv.lbToken")` (the meter's `openSettings` builds a section hit; this one names the item).
  - **Manage lorebook.** The sidebar's character editor on its lorebook tab: `sideBarStore`, `botMakerMode`, and
    `CharConfigSubMenu` 3, with the settings closed first (`settingsOpen`), since the sidebar shows no editor over them.
  - **Close.**
  - The two navigation buttons are shown only while the stopped chat is the selected one (D14) and its lorebook tab
    can show: not for `§playground`, and not for a card whose `private` license hides the tab.
  - `Sidebar.svelte`'s local DevTool view wins over `botMakerMode`, and `LoreBookSetting.svelte`'s `submenu` is local
    state. Each reads a one-shot request (suggested: stores beside `CharConfigSubMenu`), reactively, so that a mounted
    panel follows it too, and clears it when taken.
- When the dialog opens: each of the three call sites finishes its own failure handling first.
  - The send and continue: when the chat holds the send's user message, or there was no input. A draft that was put
    back in the composer (the message has not reached this tab's chat) gets the terminal's `message` as an alert.
  - The in-place reroll: always.
  - The fallback reroll: when the send settled and `rerollHistory.restore` answered `restored`, or nothing had been
    removed (a chat that ends with the user's message, the state a stopped send leaves). An `unsafe` restoration
    shows the terminal's `message` and then its own alert, as today; any other answer shows the terminal's `message`
    as an alert.
- The resend (D12): on the first button the site repeats its own request on the chat as the stop left it, with no
  field (the chat now has the flag) and a fresh `requestId`:
  - the send and continue: `sendChatMain` again with the same `input` and `userMessageId`. The server skips the input
    stage for a message the chat already holds and still hands that id to the reply's auto-translation; an empty
    input would lose that. A send that had no input repeats with none.
  - the in-place reroll: the same `rerollMessageId` and speaker.
  - the fallback reroll: its removal and send again. That block becomes a function of `ref` that reads the chat
    through `findChat(ref)`, never `currentChat`, and the first run and the repeat both call it: after the dialog the
    selected chat can be another one, and a list built from it would remove every message of `ref`. The function makes
    `reroll()`'s two checks itself before it removes anything (`isChatBusy`, `refuseOrphanedOverrides`). The repeat
    does not go through `reroll()` again, so the next candidate and the bundle history are not tried.
- `ContextMeter.svelte`: no logic change. `loreWarnOffNote` and the toggle's labels say that the chat's switch also
  stops the send stop. `loreBudgetWarnOff`'s comment in `shared/database.ts` says the same.

**Test.**

- `server/src/tests/normalizeSections.test.ts`: the default and an explicit false.
  `src/ts/setting/settingsPageSections.test.ts`: the checkbox, its binding, and its section. The boot snapshot fixture
  gains the key. `server/src/tests/upstreamExport.test.ts`: the key is not exported.
- A unit test of `wantsLoreBudgetStop`: the setting off, the chat flag set, and neither.
- `src/ts/process/serverGeneration.test.ts`: the field reaches the request context, and a job result that carries the
  stop becomes `loreStop`, while the same terminal without it does not.
- `src/ts/process/serverCommands.test.ts`: no alert for the marked follow's coded end; the ordinary job error for the
  boot resume's follow, for a lifecycle that existed before the call, for a `followed` outcome, and for an unparseable
  `lore`, with no stop on the job result in those cases.
- `src/lib/ChatScreens/DefaultChatScreen.drafts.test.ts`, beside the failed-send cases:
  - A stopped send opens the dialog; the first button sets the chat flag and sends again with the same input and
    `userMessageId`, no field, and another `requestId`; Close sends nothing and leaves the flag unset.
  - A stopped send whose draft was put back shows the alert and no dialog.
  - A stopped in-place reroll repeats with the same message id.
  - A fallback reroll on a chat that ends with the user's message opens the dialog. Its repeat, after another chat was
    selected while the dialog was open, removes the stopped chat's replies only and leaves the selected chat alone.
  - Auto mode's request has no field.
  - With the setting off, or the chat flag set, the request has no field.
- A component test of the dialog: the names and tokens, "more" past eight, the limit's source, the navigation buttons
  absent for a chat that is not selected, each button's effect (the stores, `openSetting`'s item hit), Escape as Close,
  and a second stop waiting for the first dialog.
- `src/lib/ChatScreens/ContextMeter.svelte.test.ts` only if a changed string is asserted there.

**Guide.** `chat-pipeline.md`: Send (the option, the dialog, the resend rule) and Create refusal and request identity
(a stop is a terminal, not a refusal). `ui-theming.md` and `persistence.md`: `loreBudgetWarnOff` now also turns the stop
off. `ui-theming.md` and `app-shell.md`, where they give the dialog layers' Escape order: the new dialog's place in it.
`settings-i18n.md` only where it lists Interaction's sections.

**Manual checks.**

- On a chat whose active lore exceeds the limit: send text, see the dialog with the right names and numbers, and see
  the message in the chat with no reply and no model request in the request history.
- "Don't warn in this chat and send" replies, the meter shows its off note, and the next send is not stopped. The
  meter's toggle turns the stop back on.
- "Change the token limit" lands on the global item, and on the lorebook's settings submenu for a character with its
  own budget. "Manage lorebook" opens the lorebook tab. After raising the limit an empty send replies.
- Continue and reroll on the same chat: the dialog appears, the reply text is unchanged after Close.
- Auto mode and a plugin send on the same chat are not stopped, and the meter's red icon appears after the reply.
- An entry with `dont_activate_after_match` that activates on the stopped send still activates on the resend.
- The dialog and the checkbox in English and Korean, on a phone-width screen.

## Decisions

D1 is the owner's request of 2026-11-13. The owner accepted D2 to D6 the same day. The rest are this plan's; D12 and
D15 are as the audit of 2026-11-13 left them. D19 comes from the audit, and the owner accepted it, with the narrowing
of D1 it brings, the same day.

- D1. A checkbox on the Interaction page, on by default. While it is on, a send whose activated lore does not fit the
  lorebook token limit warns instead of processing the message. The user can turn the warning off per chat, or stop and
  change the limit or manage the lorebook.
- D2. The job stops, not the tab: after lore activation and before any model request. The user's message is already in
  the chat, as after any failed send, and a resend does not append it twice. Checking in the tab before the send would
  run assembly twice per send and could not see what the input trigger and `editinput` make of the message.
- D3. The per-chat switch is the existing `loreBudgetWarnOff`. One flag says "this chat accepts lore being left out",
  for the meter's icon and for the stop.
- D4. No "send once anyway" button. The choices are to turn the warning off for the chat or to stop.
- D5. Only a send, a continue, or a reroll started on the chat screen asks for the stop, and only the job's first
  assembly honors it. A plugin send, auto mode, multisend, a command sequence, and the DevTool are not stopped. A later
  round (an auto-continue, a trigger's resend, a later group speaker) is not stopped: a reply already exists.
- D6. A send that is not stopped needs nothing new. The reply's context report names the entries left out and the
  context meter warns, when the meter is on and the chat has not turned the warning off. There is no notice in the
  message bubble.
- D7. The stop is opt-in per request (`context.stopOverLoreBudget`). The caller that can show the dialog asks; a caller
  that does not ask gets today's behavior with no change of its own.
- D8. A stopped activation writes no flag, so `activateLore` decides the stop itself: the budget pass runs before the
  `pendingFlags` writes. The pass reads only the entries' tokens and priorities, so moving it changes no result.
  Deciding in `assemblePrompt` instead would be too late: the flags are queued during activation and the metadata queue
  flushes them in a microtask, so a `dont_activate_after_match` entry would stay off on the resend.
- D9. The server reads neither the setting nor the chat flag. The tab decides and the request says so. A second reader
  could disagree with the first when a device's chat mirror is stale.
- D10. The field is honored for `send`, `continue`, `group`, and `reroll` only. The runner checks the kind, and the
  sequence part facade removes the field because a part runs under a `send` view of its command job. So a preview and
  a command sequence cannot be stopped by a field that reached them by mistake. The route keeps the field for any kind:
  a second kind check there could not be shown failing, since the runner's already holds.
- D11. The field is not part of `requestFingerprint`. A retry of an uncertain create resends its frozen body, field
  included. The resend after a stop takes a fresh `requestId`, because the same id would replay the stopped terminal.
- D12. The resend is the call site's own request again, not a new path. Each site already knows how to put the chat
  back after a failed send, and the chat is in that state when the dialog opens. The dialog is awaited, so nothing the
  repeat reads may come from the selected chat: it reads the chat it was given.
- D13. The dialog is its own component, like the chat binding dialog. `alertSelect` splits its message on `||` and
  shows the text in one unbroken block, so an entry name could break it and a list would not read as one.
- D14. The navigation buttons appear only while the stopped chat is the selected one. They open the selected
  character's panels; for another chat the dialog still offers the first button and Close.
- D15. The creating tab shows a stop once: as the dialog when the call that created the job is still waiting for it,
  else as the terminal's English `message` in an ordinary job error. A tab that took the job over also shows the
  ordinary error. The second case is a tab reloaded mid-job (the boot resume)
  and a follow that was already running. `reportEnd`'s `creator` cannot tell them apart, so the creating call marks its
  own follow. A tab that only watches the chat shows nothing, as for any failed job today. The user message is in the
  chat, so an empty send from the screen asks again and gets the dialog.
- D16. The terminal carries the entries as data (`lore`), not only as text. The tab words the dialog in its own
  language and reuses the meter's strings.
- D17. What ran before activation stays: the input stage, `runCurrentChatFunction`, and an `additionalText` embedding.
  That is what any assembly failure leaves today, and the resend runs on that chat.
- D18. The setting lives in the `ui` section beside the context meter's, because only the tab reads it. It sits in the
  Interaction page's input section, not the meter's: the stop works with the meter off.
- D19. An entry with `ignore_on_max_context` never causes a stop. The decorator is the card author saying the entry may
  be dropped when the budget is short, and a card that uses it as meant would otherwise stop every send. Such an entry
  is still counted and named in `budget`, in the dialog when another entry causes the stop, and in the meter.

## Not In This Plan

- A place to turn a chat's warning back on while the context meter is off. The toggle is in the meter's popover; with
  the meter off, a chat that turned the warning off stays off until the meter is on again.
- A "send once anyway" button (D4), and a notice in the message bubble (D6).
- Stopping a later round or a later group speaker (D5), and stopping a plugin, auto mode, multisend, command, or
  DevTool send.
- Checking the budget in the tab before the message is stored (D2).
- A localized text for the alerts of a stop: a follow without a waiting caller, a draft that was put back, and a
  reroll whose replies could not be put back (D15).
- What a preview's activation stores. A preview kind runs the same activation without the option, and the runner
  flushes the job's chat metadata after it, so a preview between a stop and its resend may set a flag the stop left
  unset. Whether it is stored is not settled; it is today's behavior either way.
- The `max` of 4096 on both token limit inputs (`adv.lbToken` and the lorebook's own), under a default of 8000.
- A limit that the terminal's parser refuses, such as a negative one: that chat gets the alert, never the dialog.
- Any change to how the budget pass picks entries, or to the lorebook token limit's default.

## Open Questions

None open. The owner accepted the stop point, the per-chat flag, the two choices, and the scope on 2026-11-13, and D19
the same day after the audit: an entry marked `@@ignore_on_max_context` never causes a stop.
