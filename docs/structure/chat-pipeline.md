# Chat Pipeline: Send → Prompt → Request → Reply

## Scope

This guide owns the tab’s send and retry lifecycle, composer hooks and drafts, OOC questions, slash commands, groups,
message search and inlays. It also owns the shared lore engine, context report, and helpers for editing or previewing
prompts. Start at a topic in **Files**.

Follow [server generation](server-generation.md#prompt-job-execution) for assembly, trimming, scripts and the reply,
[LLM requests](llm-requests.md) for provider requests and token counts, and [memory](memory.md) for memory algorithms.
Rendering belongs to [CBS](cbs-rendering.md), regex and Lua to [scripts and triggers](scripts-triggers.md), TTS and
image generation to [media](media-aux.md). For message search use [UI](ui-theming.md) for the panel and
[server resources](server-resources.md) for the endpoint. For PDF conversion in MCP tools see [MCP](mcp.md).

## Files

### Send client and registries

- `src/ts/process/index.svelte.ts`: the send and preview API (`sendChat`, `previewChat`, `previewChatReport`).
- `shared/openai.ts`: shared prompt message and media types (`OpenAIChat`, `MultiModal`).
- `src/ts/process/serverGeneration.ts`: the send as a server job (`sendChatOnServer`, `ServerSendResult`).
  `ServerSendArg.localOnly` keeps host commands on this tab; `noHandoffPreference` omits the tab's preferred-handoff
  setting for that create. `reports` is a caller-owned `SendReport[]` sink that survives throws.
- `src/ts/process/serverCommands.ts`: tab job admission, follows and recovery (`runServerJob`, `followJobToEnd`,
  `refreshChatAfterPush`; `prepareServerJob` and `readRecoveringChat` also serve the remote send). A reports sink
  collects admission refusals and a newly created own-job follow's errors and completion notices. Existing follows
  retain their reporting; `reportShownElsewhere` reaches `ServerSendResult` and `sendChat.onEnd` only when that
  lifecycle actually submitted an error for display.
- `src/ts/network/generationJobs.ts`: job transport (`createGenerationJob`, `stopChatGeneration`,
  `followGenerationJob`); protocol details are in [network jobs](network-jobs.md).
- `src/ts/process/localSends.ts`: the tab's send registry (`localSends`, `beginLocalSend`, `isLocalSend`,
  `anyLocalSend`). A composer slash command takes the chat's entry before its first await and lends it to its
  `/multisend` parts; it clears the composer only while that still holds the submitted line.
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
- `shared/prompt/templateCheck.ts` owns prompt-template warnings. The client re-exports `templateCheck` from
  `src/ts/process/templates/templateCheck.ts`.
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
- `src/ts/process/lorebook.svelte.ts` hosts DevTool and slash-command activation (`loadLoreBookV3Prompt`) and the
  lorebook codecs (`importLoreBook`, `exportLoreBook`, `addLorebook`).

### Context report

- `shared/contextReport.ts`: generation context accounting (`ContextReport`, `parseContextReport`, `historyDigest`).
  `input` is the assembled messages alone; `toolSchemas` and `interceptions` (the reply's request interception messages)
  are the final recheck's reservations, kept apart and added to `fixedShare`. Structured Memory's coverage:
  [its report](structured-memory/read.md#the-read-path).
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

- `src/ts/process/command.ts` handles typed slash commands. See `processMultiCommand` for pipes, quoting and the literal
  text consumed by `/send`, `/sendas` and `/comment`. `processCommand` dispatches and `runMultisend` sends sequentially
  under the composer's reservation. Stored trigger commands use `server/src/prompt/commands.ts` with different pipe
  rules. A server command job keeps all its queued parts under one chat slot
  ([scripts and triggers](scripts-triggers.md#flows)).
- `src/ts/process/files/multisend.ts` converts attachments. `postChatFile` pins the captured chat across the picker and
  every PO translation in the batch. `sendPofile` checks that owner before further writes or downloads.
- `src/ts/process/group.ts` owns `addGroupChar` and `rmCharFromGroup`. A greeting goes to the captured group's pinned
  chat, with the owner rechecked after the dialogs.
- `src/ts/process/infunctions.ts` binds the shared CBS calculator (`calcString`) to tab variables.

- `shared/messageSearch.ts`: message-search wire contract (`MESSAGE_SEARCH_PATH`, `MessageSearchQuery`,
  `MessageSearchPage`).
- `src/ts/messageSearch.svelte.ts`: search requests, panel state, and message jumps (`searchMessages`,
  `messageSearchPanel`, `requestMessageJump`, `claimMessageJump`). The screen consumes a jump by stable message id or
  `{ greeting: true }`. `src/lib/ChatScreens/messageJump.ts` (`runMessageJump`) grows the rendered window and rechecks
  ownership after each await.

### OOC session

- `src/ts/ooc/oocSession.svelte.ts` owns the tab's per-chat state and actions. Start with `askOoc`, `retryOoc` and
  `stopOoc` for a question, `refreshOoc` for its segment and `readOocSegments` for panel order. See
  [OOC question](#ooc-question) for persistence and the two requests.
- The composer menu opens `src/lib/Others/OocPanel.svelte` through `src/ts/ooc/oocPanel.svelte.ts` for individual chats.
  `src/ts/ooc/oocToggleSettings.svelte.ts` resolves the chat's display preset. A chat's own toggle map replaces the
  preset's even when empty. Checkbox suggestions are remembered per preset on this device.
- `shared/ooc.ts` defines stored exchanges, segments, limits and pruning for both runtimes
  ([persistence](persistence.md)).

### Input hooks

- `src/ts/process/inputHooks.ts` runs `runInputHook` with the captured chat and tokenizer scope. It pins the chat
  through the request and stream cancellation. History slots use
  [translator history](translation.md#translator-pipeline-and-slots) through the latest loaded message. The result is
  one trimmed, buffered reply on `otherAx` or the hook's model profile.
- `src/ts/process/inputHookRuns.svelte.ts` tracks one Draft or BTW run per chat (`createInputHookRuns`). `sendAborts`
  owns Stop. `shared/inputHooks.ts` defines the hook list, limits and request rows (`inputHookMessages`).
- `src/lib/ChatScreens/DefaultChatScreen.svelte` owns the result. `runDraftHook` guards the draft box with the chat's
  display lifetime and text revision. `runBtwHook` reads both boxes and keeps the last successful nonblank answer in the
  screen's per-chat `btwResults` across edits and chat switches. The composer menu uses `InputHookPicker.svelte` when
  there are several BTW hooks.

### Inlays

- `src/ts/process/inlayScreen.ts` (`updateInlayScreen`) derives character generation data from the view settings. For
  the reply-side inlay operation see `server/src/prompt/postProcess.ts` (`runInlayScreen`).
- `src/ts/process/files/inlays.ts`: server-backed inlays (`writeInlayImage`, `setInlayAsset`, `getInlayAsset`,
  `listInlayAssets`, `removeInlayAsset`, `getInlayMedia`, `getInlayObjectUrl`, `verifyInlay`, `repairInlayMedia`).
  - `src/ts/bootstrap.ts`: boot wiring (`watchRemoteRecords`, `loadData`); remote changes connect through
    `setRemoteChatListener` to `invalidateInlayCaches`.
  - Rendering: [CBS rendering](cbs-rendering.md) `parseInlayAssets`. The `<source>` type comes from
    `shared/assetMime.ts`.

## Flows

### Send

The ordinary send runs from `DefaultChatScreen.svelte` (`send` or `sendContinue`, then `sendMain`, `sendChatMain`)
through `sendChat`, `sendChatOnServer`, and `runServerJob`. `runSend` may route an eligible send through another host
tab under the same reservation ([remote send](network-jobs.md#remote-send)).

1. The screen checks this chat's busy state, including hook runs (`isScreenBusy`). It processes a slash command before
   checking the chat binding and orphaned overrides for generation. An ordinary send keeps the composer intact up to
   admission on the screen. The later flush and server admission can still refuse it.
2. When `draftHookId` selects a Draft hook, Send on nonblank main text runs the hook and consumes nothing. Continue, the
   playground and Send Draft bypass that hook. `sendDraftMessage` sends the draft text and attachments, retains the
   whole composer for recovery, and restores it only into four empty parts. With hook translation enabled, it forwards
   the raw main box as `inputOriginal` ([translation](translation.md#send-hand-off)).
3. The server appends processed input under the supplied `userMessageId`. Retrying the same input preserves that id. The
   create request id lasts only while the outcome is uncertain ([Create refusal](#create-refusal-and-request-identity)).
   Stop targets the captured chat's controller and followed jobs.
4. When `wantsLoreBudgetStop` is true, Send, Continue and either reroll set `context.stopOverLoreBudget` on the first
   assembly. Auto mode skips it. The caller handles its own `loreStop` after failed-send or reroll recovery.
   `offerLoreStop` queues the dialog for the pinned chat. If recovery returned input to the composer or could not
   restore the removed replies, the screen shows the job's error instead.
5. Choosing to send again sets `loreBudgetWarnOff` and repeats the same operation with a fresh request id. An input
   repeat keeps its text, original translation and message id. The owner token and chat entry must still match. A later
   manual draft retry reads the main box and translation option again.

### Reroll

- `reroll`/`unReroll` switch the newest reply's `candidates`, then the bundle history; past the last, a one-reply tail
  rerolls [in place](server-generation.md#reroll-in-place) while the current `hello` allows it (`serverRerollsInPlace`),
  else the tail is removed and sent again.
- With remote sending on, the in-place reroll and Continue go through the host (a fresh request id per press; a Continue
  without input names the message it continues); the removal reroll always runs on this tab, since its bundle history
  cannot be kept through a host ([remote send](network-jobs.md#remote-send)).
- A removal reroll puts back, per key, the variables its removed tail changed before it sends again, and a recovered
  tail brings them back; the newest reply of a job carries the baseline of that tail (`rerollTurnStart`,
  `shared/rerollCandidates.ts`). Legacy replies without that baseline keep their values.
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
- `stale` and `chatBindingMismatch` fence only this tab's frozen request. A send already marked uncertain keeps its
  request id through one (`registryRefusal`): a remote host may still create under that id.
- An ordinary composer’s request id survives only while the create or follow outcome is uncertain. Draft and message-id
  recovery rules live in `composerDrafts.svelte.ts` and [draft recovery](draft-recovery.md).
- A lore budget stop is a job's `error` terminal (`loreOverBudget`), not a create refusal. Its repeat takes a fresh
  `requestId`, since the stopped one replays the stop.
- Returned reports use `alert.ts`'s `jobErrorText` and `errorReportText`, without debug info or network hints.
  Caller-owned lore stops still return `loreStop`. Maintenance restore alerts, handoff/recovery notices, save-layer
  notices and dialogs during the job remain on the executing tab.

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

`OocPanel.svelte` calls `askOoc` or `retryOoc`. A question reserves its chat in this tab and pins it through its last
write. Admission requires an individual chat with a complete binding, no conflicting generation, no orphaned overrides
and a valid segment anchor. Only `refreshOoc` moves a missing anchor to the newest message.

1. The first question anchors a segment at the latest message. `oocPrune` protects picked attachments. The question is
   merged into `oocLog` before creating the job.
2. A server `preview` job with `context.oocExchangeId` assembles the question on a detached chat. The caller holds the
   local send slot through this preview and handles its own OOC refusal codes. Only a preview result with `ooc: true`
   can launch the answer ([server generation](server-generation.md#prompt-job-execution)).
3. The tab releases that slot, so the main chat can send while the answer streams. It calls `requestChatData` with the
   captured owner and an empty tool list. On success it merges the answer into the existing exchange. Stop or failure
   leaves partial text in this tab. An unanswered exchange in the current segment can be retried.

### Not in `sendChat`

- Input auto-translation (`createInputTranslation`) and suggestions call the tab request layer; the `previewRequest`
  hotkey calls `previewChat("previewPrompt")` for a server preview job. Display translation is a UI concern. Group
  continues use the server speaker loop.
- An OOC question's prompt and answer: [OOC question](#ooc-question).
- An input hook run ([Input hooks](#input-hooks)): a tab request on the auxiliary model, not a job.
- Chat paging renders loaded messages only (`chatLoadInitialPages`, `chatLoadAdditionalPages`); it does not fetch
  history.

## State

- `chatStatus.svelte.ts` combines local sends, followed jobs and message locks for per-chat admission (`isChatBusy`).
  `anyLocalSend` is the tab-wide signal for plugin reload deferral and translator cache-only mode. The module also
  exposes [memory health](structured-memory/read.md#the-health-badge), recovery and unseen markers.
- `followedJobs`, `loadingJobChats`, `jobStages` and `jobRetries` drive the selected chat's Stop control, loading status
  and retry count. A socket snapshot restores the retry count on reconnect. Ending the follow drops the stage.
- `watchChatVisibility` checks the visible chat's server slot and rechecks a foreign job without a message lock.
  `foreignJobs` and the feed's `foreignGeneration` can show a spinner and Stop before a reply locks a message. Both are
  advisory. `generatingBadgeKeys` also counts non-preview feed jobs for sidebar and home badges. Keep
  `generatingChatKeys` for writes and busy checks ([feed connection](live-updates.md#feed-connection)).
- `chatStore.svelte.ts` owns chat writes, pins, job hydration and the streaming lock
  ([chat store](chat-store.md#pins-and-eviction)). For adoption of a job's own stored writes see
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
- Add a slash command in `command.ts` (`processCommand` and its `?` help). If trigger commands should support it, update
  the server dispatcher too. Cover the input and stored-command grammars separately.
- Change backend prompt serialization: `shared/prompt/chatTemplate.ts` or the server's request layer
  (`llm-requests.md`).

## Tests

- Focused:
  `pnpm --silent test:agent src/ts/process src/ts/messageSearch.test.ts src/lib/ChatScreens/DefaultChatScreen.drafts.test.ts`
  for the tab, `pnpm --silent test:agent shared/contextReport.test.ts` for reporting,
  `pnpm --silent test:agent src/ts/ooc` for the OOC module (real chat store, the job and the request mocked);
  `pnpm --silent test:agent server/src/tests/{promptRunner,assemble,promptTail,lore}.test.ts` for the job. Memory jobs:
  [memory](memory.md).
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

- A hook prompt fills only `{{slot::content}}`, `{{slot::draft}}`, `{{slot::history::N}}`, and
  `{{slot::historytrans::N}}`, with CBS left literal. The hook editor has no import or export. See the
  [decision in the archive](../archived-plan/README.md) at `00e88ceba`.
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
- `svelte/store` runs every `writable.set` subscriber through one module-level subscriber queue: a subscriber that
  throws leaves the queue mid-run for the whole page, so later store updates anywhere may not notify. `beginLocalSend`
  (`src/ts/process/localSends.ts`) rolls back its own entry on a throw but cannot repair the queue; no known subscriber
  throws. Decision: Found Issues Clearance Q1 (owner, 2026-11-09): moving `localSends` to `$state` touches every
  consumer for no reproduced defect.
- A reroll's restore cannot see another tab's job that holds no lock yet and was not met at this tab's create: the
  restored replies land while that job runs, like any other edit. Decision: owner, 2026-11-10 (known-issues review),
  together with the live-updates reservation window.
- OOC questions ([OOC question](#ooc-question)): a question is refused while its chat generates, and an answer that is
  streaming when the page reloads is lost (Decision: OOC Session D5, owner, 2026-11-14). The answer request passes
  `tools: []`, so no tool call is dispatched and no configured web search is added ([LLM requests](llm-requests.md)); a
  provider that adds tools of its own is not stopped, and one that appends a midway error to its stream text is stored
  as an answer.
- Two devices that each prune a full `oocLog` and add an exchange at once store more than `MAX_OOC_EXCHANGES`: the
  validator accepts `OOC_LOG_CONCURRENCY_SLACK` more, and the next question prunes back to the limit or is refused as
  full when nothing is removable.
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
- In-page recovery restores serialized text for an ordinary send, or the whole composer for a Send Draft. Journal
  recovery restores the pre-consumption composer. A successful job that removed its own user message restores nothing.
  Decision: owner, 2026-11-10 (known-issues review).
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
