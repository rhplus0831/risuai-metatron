# Chat Pipeline: Send → Prompt → Request → Reply

## Scope

- Owns:
  - the tab's side of a send: the input box to the server job (`sendChat` is the job client) and the reply as the job's
    events and records bring it,
  - the prompt editor's helpers (`prompt.ts`, the templates, `templateCheck`), the lorebook codecs and the DevTool lore
    preview,
  - group membership (`group.ts`), reroll, slash commands, inlays,
  - the message-search request contract and client coordinator.
- Paths:
  - `src/ts/process/{index.svelte,serverGeneration,prompt,stringlize,group,rerollCandidates,command,infunctions,inlayScreen}.ts`
  - `src/ts/process/{lorebook.svelte.ts,templates/{chatTemplate,templateCheck,templates}.ts,files/{inlays,multisend}.ts}`
  - `shared/lore/{activation,overrides}.ts`, `shared/prompt/{chatTemplate,templateCheck}.ts`
  - `src/ts/messageSearch.svelte.ts`, `shared/messageSearch.ts`
  - `src/ts/ooc/**`
  - The send handlers in `src/lib/ChatScreens/DefaultChatScreen.svelte`
- Not here:
  - Prompt assembly, token trimming, the request, streaming, and the post-processing tail run in the server job →
    `server-generation.md` (`runPromptJob`, `assemblePrompt`).
  - Memory algorithms → `memory.md`.
  - `requestChatData` internals → `llm-requests.md`.
  - Token counting (`shared/tokenizerChoice.ts`, `shared/prompt/{chatTokens,imageTokens}.ts`, `src/ts/tokenizer.ts`,
    `src/ts/tokenCountField.ts`) → `llm-requests.md`.
  - Message-search panel presentation → `ui-theming.md`; endpoint details → `server-resources.md`.
  - PDF conversion used by MCP filesystem tools → `mcp.md`.
  - Regex and trigger internals → `scripts-triggers.md`.
  - Rendering → `cbs-rendering.md`.
  - TTS and image generation → `media-aux.md`.

## Files

### Send client and registries

- `src/ts/process/index.svelte.ts`: the send and preview API (`sendChat`, `previewChat`, `previewChatReport`).
- `shared/openai.ts`: shared prompt message and media types (`OpenAIChat`, `MultiModal`).
- `src/ts/process/serverGeneration.ts`: the send as a server job (`sendChatOnServer`, `ServerSendResult`).
- `src/ts/process/serverCommands.ts`: tab job admission, follows and recovery (`runServerJob`, `followJobToEnd`,
  `refreshChatAfterPush`).
- `src/ts/network/generationJobs.ts`: job transport (`createGenerationJob`, `stopChatGeneration`,
  `followGenerationJob`); protocol details are in [network jobs](network-jobs.md).
- `src/ts/process/localSends.ts`: the tab's send registry (`localSends`, `beginLocalSend`, `isLocalSend`,
  `anyLocalSend`).
- `src/ts/process/jobStages.ts`: job presentation stages and retry counts (`setJobStage`, `setJobRetry`, `jobRetries`,
  `dropJobStage`, `chatStageOf`).
- `src/ts/process/chatStatus.svelte.ts`: the per-tab status sources ([State](#state)), `chatStatusKey`, `isChatBusy`,
  `foreignJobs`.
  - `isChatBusy` is a per-chat preflight; the resource flush and server admission still apply.
- `src/ts/process/sendAborts.svelte.ts`: the screen's Stop controllers by chat (`createSendAborts`).
- `src/ts/process/loreBudgetStop.ts`: whether a screen send asks for the lore budget stop (`wantsLoreBudgetStop`) and
  the dialog's queue (`askLoreBudgetStop`); `src/ts/process/jobLoreStop.ts` reads a stop from a terminal.

### Prompt and templates

- `src/ts/process/prompt.ts`: `tokenizePreset` and the SillyTavern preset import (`promptConvertion`).
- `shared/prompt/chatTemplate.ts`: instruct templates and Jinja rendering (`chatTemplates`, `renderChatTemplate`).
- `src/ts/process/templates/chatTemplate.ts`: the tab's instruct-template adapter (`applyChatTemplate`).
- `src/ts/process/templates/templates.ts`: preset template re-exports (`prebuiltPresets`, `prebuiltNAIpresets`,
  `PresetTemplate`).
- `shared/presetTemplates.ts`: built-in preset data and prompt strings (`prebuiltPresets`, `prebuiltNAIpresets`,
  `PresetTemplate`).
- `shared/prompt/templateCheck.ts`: prompt-template warnings (`templateCheck`).
- `src/ts/process/stringlize.ts`: serializers for other backends and stop strings (`stringlizeChat`, `unstringlizeChat`,
  `getStopStrings`).

### Lore

- `shared/lore/activation.ts`: lore activation, shared with the server (`activateLore`, `LoreHost`, `LoreBudget`,
  `searchMatch`); the matching rules are under [Lore matching](#lore-matching). `/test_lorebook` returns the whole
  result as JSON. With `stopOverBudget`, a budget pass that leaves out an entry not marked `@@ignore_on_max_context`
  stops the activation: `stopped: true`, no actives, the full `budget`, and no keep or don't-activate flag written. Only
  a send job's first assembly asks ([server generation](server-generation.md#prompt-job-execution)).
- `shared/lore/overrides.ts`: chat overrides of the owner's lore (`mergeOwnerLore`, `offOverrideIds`,
  `orphanedOverrideEntries`).
- `src/ts/process/loreOverrides.ts`: the local refusal and the alert both refusals share (`refuseOrphanedOverrides`,
  `chatLoreOverrideRefusalText`).
- `src/ts/process/lorebook.svelte.ts`: the client's activation host (`loadLoreBookV3Prompt`) and the lorebook codecs
  (`importLoreBook`, `exportLoreBook`, `addLorebook`).

### Context report

- `shared/contextReport.ts`: generation context accounting (`ContextReport`, `parseContextReport`, `historyDigest`).
  Structured Memory's coverage: [its report](structured-memory/read.md#the-read-path).
- `shared/eligibleHistory.ts`: stored-history selection (`eligibleHistory`).

### Composer and drafts

- `src/ts/process/sendDraft.ts`: failed sends' text and ids (`createSendDrafts`, `idsFor`, `takeUnplaced`), and
  `composerSendText`, the one sent text of a composer: the main box, or the draft box for a draft send, plus the inlay
  tags. A draft send's `SendDraft` also carries the raw `composer` it consumed; the retry lookup compares only the
  retained send's own box.
- `src/ts/process/composerDrafts.svelte.ts`: the screen's per-chat composer and browser journal (`createComposer`,
  `beginSend`, `settleSend`, `placeSend`, `restore`). The composer holds four parts (`input`, `draft`, `translate`,
  `files`) and a `textRevision(key)` that advances on main or draft text changes only.
- `src/ts/process/inputTranslation.svelte.ts`: input auto-translation (`createInputTranslation`) and the composer keys
  (`handleMainComposerKeydown`, `handleTranslationComposerKeydown`).

### Reroll modules

- `src/ts/process/rerollCandidates.ts`: candidate navigation (`switchCandidate`, `rerollCarrier`,
  `neighborCandidateId`).
- `src/ts/process/rerollHistory.ts`: screen reroll history and failed-reroll restoration (`createRerollHistory`,
  `restoreRerolledReplies`).

### Slash commands, groups, and search

- `src/ts/process/command.ts`: the chat input's slash commands (`processMultiCommand`, `processCommand`,
  `runMultisend`); `|` outside double quotes pipes commands, and one pair of surrounding quotes is removed from an
  argument, so `/multisend "a|||b"` sends `a` and `b` (server twin: `server/src/prompt/commands.ts`). Manual-trigger
  internals: [scripts and triggers](scripts-triggers.md). A command job runs its queued `/multisend` parts on the server
  under one job id and chat slot ([generation](server-generation.md)).
  - In the input only, `/send`, `/sendas` and `/comment` take the rest of the input as their text (`|`, `=`, spacing and
    quotes kept), so they end a line; the server twin keeps the pipe rule for stored trigger commands.
- `src/ts/process/files/multisend.ts`: file attachments (`postChatFile`); picker and paste callers pass their captured
  chat, which the batch pins before any wait and shares across every PO file and entry. A deleted chat or replaced owner
  cancels further PO writes and downloads.
- `src/ts/process/group.ts`: group membership (`addGroupChar`, `rmCharFromGroup`); adding a member captures the group
  owner and greeting chat before either dialog, then pins and loads that chat for the greeting. A replaced group, or a
  missing destination when a greeting is requested, cancels the action before membership is added.
- `src/ts/process/infunctions.ts`: the tab's CBS calculator adapter (`calcString`).
- `shared/messageSearch.ts`: message-search wire contract (`MESSAGE_SEARCH_PATH`, `MessageSearchQuery`,
  `MessageSearchPage`).
- `src/ts/messageSearch.svelte.ts`: search requests, panel state, and message jumps (`searchMessages`,
  `messageSearchPanel`, `requestMessageJump`, `claimMessageJump`).

### OOC session

- `src/ts/ooc/oocSession.svelte.ts`: every OOC action of the tab and its per-chat in-memory state (`askOoc`, `retryOoc`,
  `stopOoc`, `refreshOoc`, `deleteOocExchange`, `clearOocLog`, `toggleOocAttachment`; readers `readOocState`,
  `readOocSegments`, `oocAnchorExists`, `oocMessagesAfterAnchor`). The flow is under [OOC question](#ooc-question).
- `src/lib/Others/OocPanel.svelte` and its open flag `src/ts/ooc/oocPanel.svelte.ts` (`openOocPanel`, `closeOocPanel`):
  the screen over the module ([ui theming](ui-theming.md#dialogs-popovers-and-portals)). Its one entry is the composer
  menu item of `DefaultChatScreen.svelte`, beside the memory item and hidden for a group chat.
- `src/ts/ooc/oocToggleSettings.svelte.ts`: the OOC toggle settings the panel edits. The preset is the chat's display
  preset (`chatDisplayIds`). `useOwnOocToggles` copies its `oocToggles` into the chat's own (on) or unsets the chat's
  field (off). `oocToggleSuggestion` and `answerOocToggleOffer` make the one offer per preset to force an `ooc` checkbox
  toggle on, never for a chat with its own map (even an empty one), which ignores the preset's; the offered preset ids
  are kept in this browser's `localStorage`, not in settings.
- The stored shapes, limits, and pure helpers both runtimes use are in `shared/ooc.ts` ([persistence](persistence.md)).

### Input hooks

- `src/ts/process/inputHooks.ts` `runInputHook`: one hook run over the composer's text, a tab request
  ([LLM requests](llm-requests.md#flows)) that returns the trimmed reply or throws. Before its first await it captures
  the chat's owner token and preset scope and pins the chat until the request returns. It appends no message.
  - A prompt with a history slot builds the translator's history from the loaded chat's messages, the last one included
    ([translation](translation.md#translator-pipeline-and-slots)); a chat that is not loaded is an error.
  - A failure, a stream (cancelled first), and a `multiline` result throw; an empty reply returns `""`. An abort
    surfaces as the signal's, which the caller tells from a failure by `signal.aborted`.
- `src/ts/process/inputHookRuns.svelte.ts` `createInputHookRuns`: the screen's hook runs by chat, one per chat
  (`begin(ref, kind)` returns null while the chat has one; `end` is idempotent), with a reactive `kindOf(ref)`. It holds
  no controller: Stop is `sendAborts`'.
- The hook list, its limits, and the request rows (`inputHookMessages`) are in `shared/inputHooks.ts`
  ([persistence](persistence.md)).
- BTW hook: the composer menu's BTW entry (a BTW hook in the list, not the playground) runs the one BTW hook, or the one
  chosen in `InputHookPicker.svelte`, on the chat captured at the click. `runBtwHook` shares the Draft run's busy check,
  `inputHookRuns` (`"btw"`) and `sendAborts` registration, and alerts. It reads the main box (blank allowed) and the
  draft box and writes neither.
- A nonblank BTW result is kept per chat in the screen's memory (`btwResults`) while that chat exists, also after a
  composer edit or a chat switch, and replaces the chat's earlier result; a failure, an empty result, and an abort leave
  it. It is never journaled, sent, or stored in the chat, and a reload loses it.

### Inlays

- `src/ts/process/files/inlays.ts`: server-backed inlays (`writeInlayImage`, `setInlayAsset`, `getInlayAsset`,
  `listInlayAssets`, `removeInlayAsset`, `getInlayMedia`, `getInlayObjectUrl`, `verifyInlay`, `repairInlayMedia`).
  - `src/ts/bootstrap.ts`: boot wiring (`watchRemoteRecords`, `loadData`); remote changes connect through
    `setRemoteChatListener` to `invalidateInlayCaches`.
  - Rendering: [CBS rendering](cbs-rendering.md) `parseInlayAssets`. The `<source>` type comes from
    `shared/assetMime.ts`.

## Flows

### Send

In `DefaultChatScreen.svelte`: `send`/`sendContinue` → `sendMain` → `sendChatMain` → `sendChat` → `sendChatOnServer` →
`runServerJob` (`serverCommands.ts`). The screen functions' comments hold the order of the checks and the auto mode
(`runAutoMode`).

- The screen checks only the target chat's own work (`isChatBusy`, alert `chatGenerating`): switching chats or
  characters mid-send is allowed. Its checks, an incomplete binding (`chatBinding(ref)`,
  [chat bindings](persistence.md)) and orphaned lore overrides included, come before the composer is consumed; the flush
  and server admission can still refuse it afterward. The generation-create refusal list is below.
- Draft hook: with the chat's `draftHookId` naming a Draft hook (`draftHookOf`, read at the press), Send of nonblank
  main text (not Continue, not the playground) runs `runInputHook` after the slash command, binding, and override checks
  and consumes nothing. The run registers in `inputHookRuns` and `sendAborts` (Stop aborts it). Every admission check of
  the screen reads `isScreenBusy` (`isChatBusy` or a hook run).
- The run's result replaces the draft box only while the chat is still shown, not switched away and back, and its main
  and draft text unchanged (`textRevision`); otherwise it is dropped without an alert. An empty result alerts
  `errors.emptyText`, a failure its text.
- Send Draft (`sendDraftMessage`) makes Send's checks, sends the draft box's sent text with the attachments, clears all
  four parts, and shares Send's lore-stop handling (`sendConsumed`). A failed draft send comes back whole, only into a
  composer whose four parts are empty (`composerEmptyFor`, `takeUnplaced`'s gate); an unchanged retry keeps its ids.
- A nonempty input carries its `userMessageId`; retries of the same draft preserve it. The server job runs input
  processing and appends the message; Stop targets the captured chat's controller and followed jobs.
- Lore budget stop: with the Interaction setting `loreBudgetStop` on and the chat's `loreBudgetWarnOff` unset
  (`wantsLoreBudgetStop`, their one reader), Send, Continue, and both rerolls ask the job to stop before the model
  request (`context.stopOverLoreBudget`, [server generation](server-generation.md#prompt-job-execution)). Auto mode and
  the other `sendChat` callers never ask. The creating call's own follow raises no alert for the stop (`reportEnd`);
  `sendChatMain` returns it as `loreStop`.
  - After its own failure handling, the call site opens `LoreBudgetStopDialog.svelte`: one at a time, in the order
    asked. A send whose text went back to the composer, or a removal reroll whose replies did not come back, shows the
    job's English message as an alert instead, as does a follow with no waiting call (the boot resume, a follow that
    already existed).
  - "Don't warn in this chat and send" sets `loreBudgetWarnOff`, then repeats the site's own request on that chat with a
    fresh `requestId`: the same input and `userMessageId`, the same in-place target, or the removal reroll again
    (`rerollByRemoval`, which reads the chat by ref). It is dropped when the chat left the list or its owner's chats
    were replaced (`chatOwnerToken`).

### Reroll

- `reroll`/`unReroll` switch the newest reply's `candidates`, then the bundle history; past the last, a one-reply tail
  rerolls [in place](server-generation.md#reroll-in-place) while the current `hello` allows it (`serverRerollsInPlace`),
  else the tail is removed and sent again.
- `rerollHistory.ts` owns guarded tab restoration; [chat store](chat-store.md#by-id-ops) owns by-id writes; the
  [server job](server-generation.md#reroll-in-place) commits an in-place reroll.

### Job client and reply

`sendChat` refuses a deleted target and takes its local send entry before its first await. `serverCommands.ts`
`runServerJob` flushes pending writes, creates the job, follows it, and maps its outcome. A received terminal settles
the follow without waiting for the socket close handshake, so that handshake cannot keep Stop visible. The server
generation flow is in [server generation](server-generation.md#prompt-job-execution); tab job transport and recovery are
in [network jobs](network-jobs.md#job-recovery).

### Create refusal and request identity

- An unanswered create remains uncertain until a decoded result fences a delayed POST. Success, replay, or a refusal
  tied to the same frozen body can fence it. State-dependent refusals do not: `503`, `chatBusy`,
  `chatBindingIncomplete`, `chatLoreOverrideOrphaned`, and `409 memoryRebuilding`. See `serverCommands.ts`
  `admissionRefused`; the server admission codes are listed in [generation](server-generation.md#generation-admission).
- The ordinary composer's request id survives only while the create or follow outcome is uncertain. Draft and message-id
  recovery rules live in `composerDrafts.svelte.ts` and [draft recovery](draft-recovery.md).
- A lore budget stop is a job's `error` terminal (`loreOverBudget`), not a create refusal. Its repeat takes a fresh
  `requestId`, since the stopped one replays the stop.

### Reply and recovery

- A completed job hands translation and due memory work to detached services before `done`
  ([server prompt job](server-generation.md#prompt-job-execution), [translation](translation.md), [memory](memory.md)).
  Reply events and kept outcomes are in [generation channels](server-generation.md#generation-channels) and
  [job receipts](server-generation.md#job-receipts); callback hydration is in
  [chat store](chat-store.md#callback-hydration).
- A lost follow may still be writing. `serverCommands.ts` rereads the chat after loss or a completion push;
  [job recovery](network-jobs.md#job-recovery), [chat recovery](chat-store.md#job-hydration), and
  [feed locks](live-updates.md#feed-locks) own those boundaries.

### OOC question

An OOC question asks the model about the chat without adding a message: its exchanges live in the chat's metadata
(`oocLog`, a merge key, and `oocSegment`), and `oocSession.svelte.ts` owns every step. The OOC panel (`OocPanel.svelte`,
opened from the composer menu) calls it.

- Guards, shared by `askOoc` and `retryOoc`: not a group chat; no local send or followed job (`isChatBusy`); no OOC
  question in flight for the chat (reserved before the first await); a complete binding and no orphaned lore overrides
  (checked before the exchange is written, as the send's checks are); the current segment's anchor is null or a stored
  message. A gone anchor refuses and never moves the segment; only `refreshOoc` does.
- `askOoc` pins the chat until its last write and captures `chatOwnerToken`. A chat without `oocSegment` gets one at its
  newest message. `oocPrune` makes room, never removing the picked attachments, and the new exchange is merged before
  the job is created.
- The prompt is a `preview` job with `context.oocExchangeId` that writes nothing to the stored chat
  ([Prompt job execution](server-generation.md#prompt-job-execution)) and appends no message. It holds the chat's local
  send entry while the job runs, as `previewChat` does, so a send of this tab is refused locally instead of following
  the OOC job. A done result without `ooc: true` is an older server's plain preview: no reply is requested.
  - The job names `oocExchangeGone`, `oocAnchorGone`, and `oocMemoryAhead` as its caller's (`callerErrorCodes`): the
    follow lifecycle this call creates raises no alert for them (`reportEnd`); an earlier lifecycle keeps its alert.
- The answer is a tab request (`requestChatData` with `tools: []`, `bias: {}`, the captured owner), not a job: the main
  chat can send while it streams. The answer is merged into the exchange once, on the captured ref, when the question
  was not stopped and the exchange still exists. A failure or a stop leaves the exchange without an answer; `retryOoc`
  runs the job and request again for an unanswered exchange of the current segment.

### Not in `sendChat`

- Input auto-translation (`createInputTranslation`) and suggestions call the tab request layer; the `previewRequest`
  hotkey calls `previewChat("previewPrompt")` for a server preview job. Display translation is a UI concern. Group
  continues use the server speaker loop.
- An OOC question's prompt and answer: [OOC question](#ooc-question).
- An input hook run ([Input hooks](#input-hooks)): a tab request on the auxiliary model, not a job.
- Chat paging renders loaded messages only (`chatLoadInitialPages`, `chatLoadAdditionalPages`); it does not fetch
  history.

## State

- `chatStatus.svelte.ts` holds per-tab status keyed by character and chat: local/followed generation state, advisory
  foreign jobs, recovery and unseen markers. Structured Memory's health facts are also exposed there
  ([the health badge](structured-memory/read.md#the-health-badge)).
- `anyLocalSend` is the tab-wide view for plugin reload deferral and translator cache-only mode; screen controls and
  suggestions follow the selected chat's own work.
- `followedJobs` (`serverCommands.ts`) and `jobStages` describe current follows; stages leave when the follow ends.
  `loadingJobChats` marks a discovered job while `loadJobChat` runs (retries included): the screen shows
  `serverJob.chatLoading` beside Stop, which stays usable.
- `jobRetries` counts the provider requests a followed job re-sent since its stage last changed: the screen shows
  `serverJob.retried` beside Stop for the selected chat's newest job with a count. The server's `retry` event sets and
  clears it; a follow's socket opening drops it before the snapshot restores a count, and the follow's end removes it.
- A foreign mark (`foreignJobs`) is a job in the chat that this tab neither started nor follows: the screen shows the
  spinner with its extra Stop, and a send is never refused for it. `watchChatVisibility` asks the chat slot
  (`readChatGeneration`) for the visible chat when it is shown, on page recovery, and when a feed lock list names it,
  skipping a chat that is locked, followed, or in a local send. A job holds no message lock until its first `begin`, so
  a visible mark without a lock is asked again every `FOREIGN_JOB_RECHECK_MS` until the job is gone or locks a message.
- The live-update feed's running job of another client for the chat (`foreignGeneration`,
  [live updates](live-updates.md#feed-connection)) shows the same spinner and extra Stop from the job's admission, in
  its stage's color. Like a mark it is advisory: neither makes `isChatBusy` true, and the server still refuses a
  competing send.
- `chatStore.svelte.ts` owns loaded chats and every write ([chat store](chat-store.md)); autosave does not.
- Chats load on demand. Async operations pin and load their captured targets; unavailable chats are gone to synchronous
  readers, never an excuse to use another selection ([pins and eviction](chat-store.md#pins-and-eviction)).
- Streaming locks, hydration, and rendering are owned by [chat store](chat-store.md#locks-and-streaming).
- The job's own writes are adopted through the feed or reloaded by the server; eligibility is in
  [own chat changes](live-update-feed.md#own-chat-changes).

## Coupling

- `sendChat` imports `serverGeneration.ts` (and through it `serverCommands.ts`, the job channel) and the chat module.
- Callers: `DefaultChatScreen.svelte`, `command.ts` (`/multisend`), `files/multisend.ts`, `hotkey.ts`, `DevTool.svelte`
  (preview, autopilot), `plugins/apiV3` (`sendChat` permission).

## Invariants

- `chatId` is the address of every message write. Never address a message by index after an await; resolve the id again.
- A send captures its target chat before any await and passes it to the job; the job's prompt and model presets and
  persona are the chat's binding, fixed at its creation (a plugin's `sendChat` inside a hook passes `pluginContext`, so
  the job acts on the hook's chat and preset). Nothing falls back to the tab's selection: a chat whose binding is
  incomplete is not sent, and the server refuses it independently ([chat bindings](persistence.md)).
- Requests, transforms, and plugin contexts derive ids from their captured chat, never current views. A request without
  a chat is a settings-view request, not a send ([LLM requests](llm-requests.md)).
- The reply being generated is locked by its server job: the tab's writes to it are refused by the server and skipped by
  the chat module.
- The server refuses every generation job for a chat with orphaned lore overrides at admission with 409
  `chatLoreOverrideOrphaned` and `entries: [{ id, name }]`.
- The tab refuses first, with the same alert, wherever a send would write the chat before that admission: Send,
  Continue, Reroll, `/multisend` (its clear too), the PO file run, DevTool autopilot, and plugin `sendChat`. The DevTool
  lore preview and token counting do not refuse.
- Requests that are not generation jobs run for such a chat: `/api/llm/request` with a `chatRef` (suggestions, MCP
  AIAccess), the detached memory and translation tasks, and the tab's plugin-provider and WebLLM requests. Most of them
  do not activate lore. Decision: Chat Lore Overrides, [archive](../archived-plan/README.md).
- Lore activation uses the captured chat and owner's lore ([Lore matching](#lore-matching)). The generation job owns
  script stages, prompt budgets, and image captioning ([server generation](server-generation.md)); memory owns its token
  accounting.
- Inlay tags live in chat text while metadata and media live in server resources; removing an inlay does not rewrite
  messages ([inlays](#inlays)).

### Lore matching

`shared/lore/activation.ts` owns matching, recursion, budgeting, and decorators; read `searchMatch` and `activateLore`
with the implementation. Overrides apply only to the chat owner's `globalLore`, not module lore. Orphans are dropped
during activation and refused at generation admission. Child entries and keep/don't-activate decorators use
matched-entry identities. The budget pass runs before those flags are written, so a stopped activation writes none; an
`@@ignore_on_max_context` entry is tracked by its decorator, never by its priority, and is counted in `budget` but never
stops it.

Server `preview` and `previewPrompt` jobs keep lore activation flags in a detached bindings-local overlay; repeated
activations read those flags without writing chat metadata. The tab's `loadLoreBookV3Prompt` uses a fresh overlay per
activation for DevTool and `/test_lorebook`, so previews preserve stored flags and real sends can still consume one-shot
lore.

## Recipes

- Add a prompt card type: `shared/prompt.ts` (`PromptItem`), both template switches in `server/src/prompt/assemble.ts`,
  `tokenizePreset`, `templateCheck`, `PromptDataItem.svelte`, `normalizePromptTemplate` (`shared/presets.ts`). Verify
  the prompt preview (DevTool), token counts, and a preset reload.
- Change input processing: `DefaultChatScreen.sendMain` and the job's input stage (`server/src/prompt/runner.ts`).
  Verify character and group chats and slash-command fallthrough.
- Add a response command or inlay: the job's tail (`server/src/prompt/postProcess.ts` `runInlayScreen`) and
  `files/inlays.ts` or the parser.
- Change lore activation: `shared/lore/activation.ts` (search, decorators, budget) and the position mapping in
  `assemblePrompt`.
- Add a slash command: `command.ts:processCommand`, plus its `?` help text.
- Change backend prompt serialization: `shared/prompt/chatTemplate.ts` or the server's request layer
  (`llm-requests.md`).

## Tests

- Focused:
  `pnpm --silent test:agent src/ts/process src/ts/messageSearch.test.ts src/lib/ChatScreens/DefaultChatScreen.drafts.test.ts`
  for the tab, `pnpm --silent test:agent src/ts/ooc` for the OOC module (real chat store, the job and the request
  mocked); `pnpm --silent test:agent server/src/tests/{promptRunner,assemble,promptTail,lore}.test.ts` for the job.
  Memory jobs: [memory](memory.md).
- `slow`: `pnpm --silent test:agent --tags-filter=slow server/src/tests/{promptRunner,lore}.test.ts`
  ([test-harness](test-harness.md) `Slow-test table`).
- `e2e`: `e2e/perChatSends.spec.ts`, `e2e/rerollCandidates.spec.ts`, `e2e/chatLoreOverrides.spec.ts`,
  `e2e/chatBinding.spec.ts`.
- `promptRunner.test.ts` runs the send with real Lua/regex workers, a plugin hook, and a fake provider.
- `DefaultChatScreen.drafts.test.ts`: real stores; `mountComposer` controls the clock, job creation, and resource I/O
  (`FakeResourceServer`), with fake IndexedDB and Web Locks and stubbed children.
- Browser checks: `util/playwright/checkServerSend.mjs`, `checkServerJobMatrix.mjs`, `checkSidebarChatStatus.mjs`, and
  `checkStreamingModes.mjs`. `checkJobProtocol.mjs` drives the job client with a real plugin provider
  ([test-harness](test-harness.md)).
- Not tested: mounted screen wiring for the paste write, input translation invalidation, and auto mode ending when
  `selection.chatOpen` becomes false; IME behavior on real devices (Android Korean, desktop Japanese); Stop on a resumed
  job beside another chat's send.
- Not tested: the DevTool preview and autopilot beyond `src/lib/SideBars/DevTool.test.ts`; check by hand.
- Not tested: killing the page after job creation but before `composerDrafts.svelte.ts` `beginSend`'s `putComposerSend`
  commits; `DefaultChatScreen.drafts.test.ts` checks recovery only after the handoff is persisted.

## Known Hazards

### Limitations

- `src/ts/process/chatStatus.svelte.ts` keeps `unseenChatKeys` and `recoveryChatKeys` only in this tab's memory, so
  reloading clears both marks; they are not durable unread or recovery records. Decision: Sidebar Chat Status 4,
  [archive](../archived-plan/README.md).
- Sequence events are live-only: parts completed without an attached socket do not count statistics in that tab. Server
  chat writes and receipt counts are authoritative. Decision: [generation](server-generation.md) command sequences.
- Accepted limits of sends in different chats at once (each chat has one local send and one server job; different chats
  of a tab run together). Decision: Per-Chat Send D1 and D6, [archive](../archived-plan/README.md).
  - Ordinary send, continue, reroll, and group jobs leave the character revision unchanged: last-chatted activity is
    derived from the chats' final-message times (`ChatSummary.lastMessageAt` for unloaded chats).
  - Explicit character effects (memory enable, triggers, Lua setters) patch the character without a character lock:
    simultaneous writes of the same field are last writer wins, and a group job and a member's own chat can patch that
    member the same way.
  - `CharEmotion` (`stores.svelte.ts`) is keyed by character, so two chats of one character share its emotion history;
    `stopTTS()` (`tts.ts`) stops every chat's speech; `alertWait`'s single status slot and the legacy `progress` overlay
    (`jobChannel.ts` `progressJobId`) show the newest job.
  - Plugin hooks and providers of one tab stay serialized by the server's per-client channel lane
    (`server-generation.md`): a slow provider in one chat delays another chat's hooks; a queued callback's deadline
    starts at dispatch.
- The job's chat stays live: `refreshChat` (`server/src/jobs/jobScope.ts`) reads a changed revision before writes and
  after callbacks that may write; `refreshChatAfterWrite` adopts an eligible own change and otherwise refreshes.
  Unrelated edits can therefore enter a later prompt stage. Decision: that file's header.
- `svelte/store` runs every `writable.set` subscriber through one module-level `subscriber_queue`: a subscriber that
  throws leaves the queue mid-run for the whole page, so later store updates anywhere may not notify. `beginLocalSend`
  (`src/ts/process/localSends.ts`) rolls back its own entry on a throw but cannot repair the queue; no known subscriber
  throws. Decision: Found Issues Clearance Q1 (owner, 2026-11-09): moving `localSends` to `$state` touches every
  consumer for no reproduced defect.
- A reroll's restore cannot see another tab's job that holds no lock yet and was not met at this tab's create: the
  restored replies land while that job runs, like any other edit. Decision: owner, 2026-11-10 (known-issues review),
  together with the live-updates reservation window.
- OOC questions ([OOC question](#ooc-question)): a question is refused while its chat generates, and an answer that is
  streaming when the page reloads is lost (Decision: OOC Session D5, owner, 2026-11-14). The answer request passes
  `tools: []` but cannot stop a provider that adds its own tools or runs a call it was not offered, and a provider that
  appends a midway error to its stream text is stored as an answer. Two devices that each prune a full `oocLog`
  (`MAX_OOC_EXCHANGES`) and add an exchange at once can exceed the limit; the server refuses the later merge.
- `disable_ui_prompt` lore decorators fill `disabledUIPrompts`, which nothing consumes. Decision: owner, 2026-11-10
  (known-issues review): upstream has no consumer either; the decorator is accepted and ignored.
- `renderChatTemplate` calls Jinja's `Template.render` synchronously with no work or time limit; a costly custom
  template occupies its caller's thread. Decision: owner, 2026-11-10 (known-issues review): worker isolation would be
  designed together with the server CBS thread (server-generation).
- The screen's per-chat reroll history (the bundles of multi-reply tails) is in memory only; a single reply's reroll
  keeps the previous reply as that message's `candidates` on the server. Decision: owner, 2026-11-10 (known-issues
  review).
- Composer recovery depends on the browser journal. Chrome aborts IndexedDB writes begun in `pagehide` on unload, so a
  reload, close, or navigation within 500 ms of the last edit loses it. Decision: owner, 2026-11-10 (known-issues
  review).
- In-page send recovery restores the serialized send text without its translation draft; journal recovery restores the
  pre-consumption composer. Neither restores a send whose job ended `done` (`ok`) after a script removed its user
  message. Decision: owner, 2026-11-10 (known-issues review).
- Lore keys keep the inherited grammar: every key is split on commas before the `/pattern/flags` parse, so `/a{1,2}/`
  becomes two malformed keys; the last slash closes a pattern, and a bare or unclosed slash, an invalid flag, or a
  malformed later entry ends that key search instead of being skipped. Kept for parity. Decision: owner, 2026-11-10
  (known-issues review).

### Gotchas

- `editChat`/`editChatSync` (`src/ts/storage/chatEdits.ts`) capture the baseline before their edit works on its copy, so
  they keep another writer's change to a field the edit left alone; where both changed one field, the edit's value wins.
  A plugin's whole-chat setter diffs against the baseline its instance's last read of that chat retained, else against
  the chat at the call ([plugins](plugin-sandbox.md)).
- `DevTool.svelte`'s autopilot sends each line as a job in the chat selected when it started; a group's speakers are
  chosen by the server.
- Group prompt assembly names a speaker it cannot resolve (`host.findCharacter`) `Unknown Character` in the group
  wrapper.
- Group lore activation takes the group as the character: its own `globalLore`, the chat's, and the modules'; the
  members' `globalLore` is not included, even with the group's `useCharacterLore`.
