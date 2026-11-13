# Lore Budget Send Stop Plan

Status: drafted 2026-11-13 at `fb09d2b25` from the owner's request. D1 is the owner's request; the owner accepted D2
to D6 the same day, as recommended. D7 to D18 are this plan's own, found against the code. Not audited yet.

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
  request when the budget pass rejects at least one entry. Nothing the stopped activation would have stored is stored.
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
  `meta` write. A job that fails later in assembly does not undo that write.
- **Where activation runs.** In the server job only for a real send: `assemblePrompt` calls `host.activateLore()` after
  `runCurrentChatFunction` and the description (which can embed `additionalText`), and before history, image captions,
  the start trigger, memory, tool listing, and the final recount. The runner has already run the input stage: the
  user's message is in the chat under `userMessageId` (a continue or an in-place reroll has locked its target).
- **What the user sees today.** `buildContextReport` copies the budget into the reply's `generationInfo.context`
  (`lore`, the first 8 names of at most 80 code points through `reportedLoreRejections`). `ContextMeter.svelte` shows a
  red book icon on its chip and lists the entries in its popover. The popover's toggle sets or unsets the chat's
  `loreBudgetWarnOff`, which hides the icon only.
- **A coded assembly failure.** `memoryRequiredOverCap` is the precedent: assembly returns
  `{ type: "alert", error, code }`, the runner throws `SendError` with `stage: "assembly"` and the code, `errorTerminal`
  copies the code into the `error` terminal, and the tab's `reportEnd` shows the message through `alertJobError`. An
  `alert` never takes the `inlayErrorResponse` path. The terminal has no field for structured data.
- **What a caller learns.** `runServerJob` returns the terminal, but `sendChatOnServer` drops it: `sendChat` answers a
  boolean and `onEnd` carries settlement fields only. `sendChatMain` returns `{ ran, ok, settled, blockedChats }`.
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
  comments that name a changed contract (`LoreBudget`'s comment, `GENERATION_ERROR_CODES`' comment, `runPromptJob`'s
  sequence, `reportEnd`'s comment, `sendChatMain`'s comment, and `loreBudgetWarnOff`'s in `shared/database.ts`).
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
  `stopped: boolean`. The budget pass moves ahead of the `pendingFlags` writes (D8). With `stopOverBudget` and at least
  one rejected entry, `activateLore` returns `{ actives: [], matchLog, budget, stopped: true }` and calls
  `host.setChatVar` for no flag. Otherwise it writes the flags and continues as today, with `stopped: false`.
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
  only when true and the kind is `send`, `continue`, `group`, or `reroll` (D10).
- `requestFingerprint` does not change (D11).
- `AssembleInput` gains `stopOverLoreBudget`. Right after `host.activateLore` and its `host.fence()`, a `stopped`
  activation returns `{ type: "alert", error, code: "loreOverBudget", lore }`. The `alert` variant of the assembly
  result gains optional `lore`. `error` is the English fallback a follow without a waiting caller shows (D15),
  suggested: "The lorebook token limit (8000) left out 3 entries (1240 tokens): Name (400), Name (440), Name (400)",
  with "and N more" after the eighth name.
- The runner passes `stopOverLoreBudget` to `assemblePrompt` only for the job's first assembly (`firstSpeakerRound`, not
  `rounds.count`: a later group speaker also has a zero count) and never for a preview kind (D5). Its `alert` branch
  carries `lore` into `SendError`.
- `GenerationFailure` gains `lore`, and `errorTerminal` copies it when the code is `loreOverBudget` and it parses. It
  travels wherever `code` does: finalization, the kept outcome, the receipt, and a replay. `rg -n "\bcode\b"` in
  `server/src/jobs/generationJobs.ts` and the receipt store finds each place.
- The part facade in `commandRunner.ts` removes `stopOverLoreBudget` with the fields it already removes (D10).
- No file under `src/` changes beyond what the type check needs.

**Test.**

- `server/src/tests/lore.test.ts`, beside the rejection cases:
  - With the option and a rejection: `stopped`, no `setChatVar` call for a `keep_activate_after_match` or a
    `dont_activate_after_match` entry (one rejected, one that fit), and the same `budget` as without the option.
  - With the option and no rejection: the flags are written and the result equals the one without the option.
  - Without the option: a rejected entry's flag is written, as today.
- `server/src/tests/assemble.test.ts`: the `alert` with its code and `lore` (nine rejections name eight), and the
  host's memory, tool listing, and recount were not called. Without the input field the report holds the rejection as
  today.
- `shared/contextReport.test.ts`: the parser accepts the shape and refuses a malformed list, like the report's cases.
- `server/src/tests/generations.test.ts`, in the create-body table: a non-boolean is refused; `true` is kept for a
  `send`; it is dropped for a `preview` and for a command job.
- A job test beside the `memoryRequiredOverCap` cases in `server/src/tests/memoryJobs.test.ts` (or in
  `promptRunner.test.ts`):
  - A send with the field on a chat whose lore exceeds the limit ends `error` with `code`, `stage: "assembly"`, and
    `lore`. The user message is stored, no provider request was made, and the chat's `scriptstate` holds no
    `$__internal_` key.
  - The same body without the field replies, and its context report names the rejection.
  - An in-place reroll with the field: the previous candidate is the selected one again.
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
  context meter warns after them. A chat can turn this off." It is added to `METATRON_ONLY_SETTINGS` in
  `server/src/data/upstream/exportDatabase.ts`, whose rule is "settings upstream's `Database` lacks", with that list's
  test.
- One exported function (suggested: `wantsLoreBudgetStop(ref)` in `src/ts/process/loreOverrides.ts` or a file beside
  it): true when `settings.ui.loreBudgetStop` is on and the chat's `loreBudgetWarnOff` is not `true`.
- The request: `ServerSendArg` and `ServerJobRequest.context` gain the field, and `sendPinned` copies it into the
  context. `sendChatMain` gains an option that sets it from `wantsLoreBudgetStop`. The send and continue, the in-place
  reroll, and the fallback reroll pass that option; `runAutoMode` does not (D5). No other `sendChat` caller changes.
- The answer: for a job this call created with the field, a `loreOverBudget` end raises no alert in `reportEnd`, and
  its `lore` (through `parseLoreBudgetStop`) goes back as `ServerSendResult.loreStop`, through `runSend`'s `onEnd`, to
  `sendChatMain`'s result. A terminal whose `lore` does not parse, and any follow with no waiting caller (a reloaded
  tab, another tab or device), goes to `alertJobError` as today (D15).
- The dialog: a store beside `chatBindingDialog` in `src/ts/stores.svelte.ts` (suggested: `loreBudgetStopDialog`), a
  component beside `ChatBindingDialog.svelte` (suggested: `LoreBudgetStopDialog.svelte`) mounted in `App.svelte`, and
  one function that opens it and resolves with the choice (D13). It shows:
  - a title, and the line the meter uses (`language.contextUsage.loreRejected`) with used and limit;
  - whether the limit is the chat owner's own (`loreSettings.tokenBudget`) or the global one;
  - the named entries with their tokens, then `loreRejectedMore` for the rest;
  - a sentence that the model was not called and, for a send, that the message is in the chat.
- The buttons:
  - **Don't warn in this chat and send.** `setChatMeta(ref, { loreBudgetWarnOff: true })`, then the resend below.
  - **Change the token limit.** With an owner budget: the owner's lorebook tab on its settings submenu. Otherwise the
    settings item `adv.lbToken`, opened with `openSetting` as `ContextMeter.svelte`'s `openSettings` builds its hit.
  - **Manage lorebook.** The sidebar's character editor on its lorebook tab (`sideBarStore`, `botMakerMode`,
    `CharConfigSubMenu`).
  - **Close.**
  - The two navigation buttons are shown only while the stopped chat is the selected one (D14). `LoreBookSetting.svelte`
    reads a one-shot request for its settings submenu (suggested: a store beside `CharConfigSubMenu`), cleared when
    taken.
- The resend (D12): each of the three call sites finishes its own failure handling first, then opens the dialog. On
  the first button it repeats its own request on the chat as the stop left it, with no field (the chat now has the
  flag) and a fresh `requestId`:
  - the send and continue: `sendChatMain` again without the input once the chat holds its user message (the draft
    settled as `landed`, or there was none);
  - the in-place reroll: the same `rerollMessageId` and speaker;
  - the fallback reroll: its removal and send again, only after `rerollHistory.restore` answered `restored`. An
    `unsafe` restoration shows its alert and no dialog.
- `ContextMeter.svelte`: no logic change. `loreWarnOffNote` and the toggle's labels say that the chat's switch also
  stops the send stop. `loreBudgetWarnOff`'s comment in `shared/database.ts` says the same.

**Test.**

- `server/src/tests/normalizeSections.test.ts`: the default and an explicit false.
  `src/ts/setting/settingsPageSections.test.ts`: the checkbox, its binding, and its section. The boot snapshot fixture
  gains the key. `server/src/tests/upstreamExport.test.ts`: the key is not exported.
- A unit test of `wantsLoreBudgetStop`: the setting off, the chat flag set, and neither.
- `src/ts/process/serverGeneration.test.ts`: the field reaches the request context, and a `loreOverBudget` terminal
  becomes `loreStop`. `src/ts/process/serverCommands.test.ts`: no alert for the creating call's coded end; the ordinary
  job error for a follow without one and for an unparseable `lore`.
- `src/lib/ChatScreens/DefaultChatScreen.drafts.test.ts`, beside the failed-send cases:
  - A stopped send opens the dialog; the first button sets the chat flag and sends again with an empty input, no
    field, and another `requestId`; Close sends nothing and leaves the flag unset.
  - A stopped in-place reroll repeats with the same message id.
  - Auto mode's request has no field.
  - With the setting off, or the chat flag set, the request has no field.
- A component test of the dialog: the names and tokens, "more" past eight, the limit's source, the navigation buttons
  absent for a chat that is not selected, and each button's effect (the stores, `openSetting`'s item).
- `src/lib/ChatScreens/ContextMeter.svelte.test.ts` only if a changed string is asserted there.

**Guide.** `chat-pipeline.md`: Send (the option, the dialog, the resend rule) and Create refusal and request identity
(a stop is a terminal, not a refusal). `ui-theming.md` and `persistence.md`: `loreBudgetWarnOff` now also turns the stop
off. `settings-i18n.md` only where it lists Interaction's sections.

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

D1 is the owner's request of 2026-11-13. The owner accepted D2 to D6 the same day. The rest are this plan's.

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
- D10. The field is honored for `send`, `continue`, `group`, and `reroll` only. `parseCreateBody` drops it for the
  other kinds and the sequence part facade removes it, so a preview and a command sequence cannot be stopped by a field
  that reached them by mistake.
- D11. The field is not part of `requestFingerprint`. A retry of an uncertain create resends its frozen body, field
  included. The resend after a stop takes a fresh `requestId`, because the same id would replay the stopped terminal.
- D12. The resend is the call site's own request again, not a new path. Each site already knows how to put the chat
  back after a failed send, and the chat is in that state when the dialog opens.
- D13. The dialog is its own component, like the chat binding dialog. `alertSelect` splits its message on `||` and
  shows the text in one unbroken block, so an entry name could break it and a list would not read as one.
- D14. The navigation buttons appear only while the stopped chat is the selected one. They open the selected
  character's panels; for another chat the dialog still offers the first button and Close.
- D15. A follow with no waiting caller shows the terminal's English `message` as an ordinary job error. That is a tab
  reloaded mid-job, or another tab or device following the chat. The user message is in the chat, so an empty send
  from the screen asks again and gets the dialog.
- D16. The terminal carries the entries as data (`lore`), not only as text. The tab words the dialog in its own
  language and reuses the meter's strings.
- D17. What ran before activation stays: the input stage, `runCurrentChatFunction`, and an `additionalText` embedding.
  That is what any assembly failure leaves today, and the resend runs on that chat.
- D18. The setting lives in the `ui` section beside the context meter's, because only the tab reads it. It sits in the
  Interaction page's input section, not the meter's: the stop works with the meter off.

## Not In This Plan

- A place to turn a chat's warning back on while the context meter is off. The toggle is in the meter's popover; with
  the meter off, a chat that turned the warning off stays off until the meter is on again.
- A "send once anyway" button (D4), and a notice in the message bubble (D6).
- Stopping a later round or a later group speaker (D5), and stopping a plugin, auto mode, multisend, command, or
  DevTool send.
- Checking the budget in the tab before the message is stored (D2).
- A localized text for a follow without a waiting caller (D15).
- Any change to how the budget pass picks entries, or to the lorebook token limit's default.

## Open Questions

None open. The owner accepted the stop point, the per-chat flag, the two choices, and the scope on 2026-11-13.
