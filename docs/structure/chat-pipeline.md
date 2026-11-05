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

Entries name the path, its role, and identifiers to look up; the rules are those identifiers' doc comments and the
module headers.

### Send client and registries

- `src/ts/process/index.svelte.ts`: the send API (`sendChat`, `previewChat`, `previewChatReport`); `OpenAIChat` and
  `MultiModal` are declared in `shared/openai.ts`.
- `src/ts/process/serverGeneration.ts`: the send as a server job (`sendChatOnServer`, `ServerSendResult`).
- `src/ts/process/localSends.ts`: this tab's sends, one per chat (`localSends`, `beginLocalSend`, `isLocalSend`,
  `anyLocalSend`).
- `src/ts/process/jobStages.ts`: the latest presentation stage per followed job (`setJobStage`, `dropJobStage`,
  `chatStageOf`).
- `src/ts/process/chatStatus.svelte.ts`: the per-tab status sources ([State](#state)), `chatStatusKey`, `isChatBusy`,
  `foreignJobs`.
  - `isChatBusy` is the busy check of `/multisend`, the DevTool preview and autopilot, the PO file run, the
    `previewRequest` hotkey, and the plugin `sendChat`. It and the registry admission are per chat; the shared resource
    flush (`GenerationBlockedError`), the binding, and the server's refusals still apply, and the plugin `sendChat` also
    refuses while any job channel callback runs (`channelCallbacksRunning`).
- `src/ts/process/sendAborts.svelte.ts`: the screen's Stop controllers by chat (`createSendAborts`).

### Prompt and templates

- `src/ts/process/prompt.ts`: `tokenizePreset` and the SillyTavern preset import (`promptConvertion`).
- `shared/prompt/chatTemplate.ts`: the instruct templates and the Jinja renderer (`chatTemplates`,
  `renderChatTemplate`); `src/ts/process/templates/chatTemplate.ts` `applyChatTemplate` supplies the tab's settings and
  names.
- `src/ts/process/templates/templates.ts`: the prebuilt presets, from `shared/presetTemplates.ts` (`PresetTemplate`).
  `shared/prompt/templateCheck.ts`: the prompt-template warnings (`templateCheck`).
- `src/ts/process/stringlize.ts`: serializers for other backends and stop strings (`stringlizeChat`, `unstringlizeChat`,
  `getStopStrings`).

### Lore

- `shared/lore/activation.ts`: lore activation, shared with the server (`activateLore`, `LoreHost`, `LoreBudget`,
  `searchMatch`); the matching rules are under [Lore matching](#lore-matching). Lua `test_lorebook` returns the whole
  result as JSON.
- `shared/lore/overrides.ts`: chat overrides of the owner's lore (module header; `mergeOwnerLore`, `offOverrideIds`,
  `orphanedOverrideEntries`).
- `src/ts/process/loreOverrides.ts`: the local refusal and the alert both refusals share (`refuseOrphanedOverrides`,
  `chatLoreOverrideRefusalText`).
- `src/ts/process/lorebook.svelte.ts`: the client's activation host (`loadLoreBookV3Prompt`) and the lorebook codecs
  (`importLoreBook`, `exportLoreBook`, `addLorebook`).

### Context report

- `shared/contextReport.ts`: what `assemblePrompt` writes to `MessageGenerationInfo.context` and the tab's context meter
  reads; the counting and coverage rules are the `ContextReport` field comments. Readers go through
  `parseContextReport`; `historyDigest` and assembly share `eligibleHistory` (`shared/eligibleHistory.ts`). Structured
  Memory's coverage: [its report](structured-memory/read.md#the-read-path).

### Composer and drafts

- `src/ts/process/sendDraft.ts`: failed sends' text and ids (`createSendDrafts`, `idsFor`, `takeUnplaced`,
  `composerSendText`).
- `src/ts/process/composerDrafts.svelte.ts`: the screen's per-chat composer and its browser journal (module header;
  `createComposer`, `beginSend`, `settleSend`, `placeSend`, `restore`).
  - The screen's `chatKey` effect runs `switchTo`, `sendDrafts.takeUnplaced`, then `restore`. Recovery loads the chat to
    check the user message id; the screen adopts both ids a `restore` returns, so the next ordinary Send of that text
    reuses the request id. Same-epoch recovery in another tab keeps the id; the server replay resolves ownership.
- `src/ts/process/inputTranslation.svelte.ts`: input auto-translation (`createInputTranslation`) and the composer keys
  (`handleMainComposerKeydown`, `handleTranslationComposerKeydown`). The screen invalidates a run at a consumed send or
  slash command, a chat switch, turning input translation off, and destroy. The partial editor's keys use the same IME
  guard.

### Reroll modules

- `src/ts/process/rerollCandidates.ts`: `switchCandidate` (op `selectCandidate`, one at a time per chat), carrier
  helpers.
- `src/ts/process/rerollHistory.ts`: the screen's per-chat bundle history (`createRerollHistory`) and the restore after
  a reroll (`restoreRerolledReplies`, Flows `Reroll`).

### Slash commands, groups, and search

- `src/ts/process/command.ts`: the chat input's slash commands (`processMultiCommand`, `processCommand`,
  `runMultisend`). `/trigger` runs on the server (`runServerManualTrigger`, `scripts-triggers.md`); a command job runs
  its queued `/multisend` parts on the server under one job id and chat slot ([generation](server-generation.md)).
- `src/ts/process/files/multisend.ts` `postChatFile`: file attachments.
- `src/ts/process/group.ts` (`addGroupChar`, `rmCharFromGroup`); `src/ts/process/infunctions.ts` `calcString`: the CBS
  calc function.
- `shared/messageSearch.ts` defines `POST /api/chats/search` shapes; `src/ts/messageSearch.svelte.ts` builds requests
  and owns the pending message-jump coordinator (module header).

### Inlays

- `src/ts/process/files/inlays.ts`: inlays on the server (module header; `writeInlayImage`, `setInlayAsset`,
  `getInlayAsset`, `listInlayAssets`, `removeInlayAsset`, `getInlayMedia`, `getInlayObjectUrl`, `verifyInlay`,
  `repairInlayMedia`).
  - `src/ts/bootstrap.ts` wires inlay feed changes to `noteRemoteInlay`, reconnects to `reconcileInlays`, and remote
    record or chat reloads (`onRemoteRecordApplied`, `setRemoteChatListener`) to `invalidateInlayCaches`.
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
  (which can meet another chat's generation) and the server's admission still refuse after it.
- A nonempty input becomes the job's input with its `userMessageId` (`idsFor`: retried identical text keeps its id): the
  job runs the input trigger, `editinput`, and appends the user message.
- Stop aborts the selected chat's controller and followed jobs. Failed input drafts keep the same `userMessageId` for a
  safe retry.

### Reroll

- `reroll`/`unReroll` (their comments) switch the newest reply's `candidates`, then the bundle history; past the last, a
  one-reply tail rerolls [in place](server-generation.md#reroll-in-place) while the current `hello` allows it
  (`serverRerollsInPlace`), else the tail is removed and sent again.
- A send that brought no reply puts the removed tail back (`restoreRerolledReplies`; its comment has the conditions). A
  refusal first withdraws the matching removal while it still owns the end of the save queue; after an ambiguous
  response that restoration is provisional ([store](chat-store.md#chat-writes)).
- Otherwise the tail is written back only once the send settled (`sendChatMain`'s `settled`, from `sendChat`'s `onEnd`,
  false when it threw): it did not run or its job ended, not after an unanswered create or a lost follow, when the job
  may still write. When that cannot be told, it stays removed, with `rerollRepliesNotRestored`.

### Job client and reply

`sendChat` refuses a deleted target and takes its local send entry before its first await. `serverCommands.ts`
`runServerJob` flushes pending writes, creates the job, follows it, and maps its outcome. Admission and job lifecycle:
[generation](server-generation.md).

Creation and `accepted` seed `preparing` only when that job has no stage yet; a later `accepted` never resets a known
stage.

### Job creation and Stop

- `createGenerationJob` freezes its request body (including hooks, client id and request id) and epoch, and retries an
  unanswered create on `CREATE_DELAYS_MS`.
- Each attempt races authentication, dispatch and response decoding against 10 s; a late authentication result cannot
  dispatch. `creatingJobs` stays held across preparation and retries.
- Stop before dispatch sends nothing; after dispatch it immediately sends request-id cancel with an independent 10 s per
  attempt and the same retry schedule.
- A retained uncertain id is cancelled even if this invocation stops before dispatch. A known owned job still uses
  participant-scoped DELETE while followed.

### Stop for a job this tab does not follow

- A chat with a server lock or a known job this tab does not follow shows an extra Stop beside Send (or chat setup). The
  advisory `foreignJobs` mark never participates in `isChatBusy` or removes the Send hotkey.
- `stopChatJob(ref)` admits one confirmation flow per chat, even across screen remounts. It uses `readChatGeneration`
  and `stopChatGeneration` (their comments). Each exchange has a 10 s deadline; a timeout ends the flow. The
  confirmation wait is not bounded.
- A 409 `jobChanged` reads and confirms the replacement; 404 clears the mark and stops nothing.
- A successful stop leaves the mark through abort grace; a later idle lookup, an owned/followed lookup, the release of
  that chat's server lock, or a new local send/follow clears it.
- Creator viewers and current workers use the followed-job Stop, with `HandoffControls.svelte` beside it (Take back for
  `viewingJobs`, Hand off to a worker); pending/former workers use the foreign-job Stop. Participant and chat stops
  attribute the stopper; request-id cancel remains an ordinary silent abort.

### Replays and uncertain creates

- Classify a replay before saving or following it; only a handoff ticket starts a foreign follow. A known terminal
  survives failed reads. Foreign running jobs retain their id for chat Stop; other foreign or malformed outcomes
  reconcile the chat and report whether that read succeeded.
- After an unanswered create, keep the request uncertain until a decoded result fences a delayed copy of the POST:
  success, replay, or a `registryRefusal` for the same frozen body. `503`, `chatBusy`, `chatBindingIncomplete`, and
  `chatLoreOverrideOrphaned` may change on retry, so they do not fence it; pre-lookup and undecodable failures also
  remain uncertain. An uncertain `chatBusy` is not followed, because a job with this request id would replay.
- A cancel with an owned job id follows its terminal. A foreign cancel reconciles the chat and remains uncertain while
  the job is running. Server receipt and replay rules: [generation](server-generation.md).

### Request id retention

- The ordinary composer's draft keeps its request id only for an unanswered create, a lost follow, an unsuccessful
  replay reconciliation, an unfenced refusal of an uncertain create, or a local preflight refusal of an already
  uncertain attempt.
- A known terminal (error, stopped or aborted included) or definite refusal drops the request id while preserving an
  unlanded input's message id.
- Continue, reroll, commands and page-owned loops mint a new id per action.
- Dispatch does not await IndexedDB: if the page dies after the POST but before the hand-off write commits, recovery may
  have only the earlier text without the request id. A crash before a settlement update commits can likewise leave the
  previous identity in the journal.

### Reply tail and sequences

- Before a completed send ends, the server can hand off the replies and input for detached translation
  ([translation](translation.md)). Job event and callback contract: [generation](server-generation.md). HypaV3 work
  during a send: [memory](memory.md).
- The tab's barrier reads the job chat whole once when it still does not hold the receipt (no or an older remembered
  copy, an unapplied patch, or a copy refused by the acknowledged floor), admitting it with the job's held streaming
  metadata before running the hook ([store](chat-store.md#callback-hydration)).
- A live `sequence` event counts one `messages` statistic; it keeps the job followed and its channel open. A
  `done.sequence.stopped` shows `serverJob.sequenceStopped`.
- A failed terminal goes through `alertJobError` with checked debug fields ([diagnostics](diagnostics.md)); sequence
  errors prefix the shown message with the progress and leave those fields intact.
- An abort with `abortedBy: "other"` shows `serverJob.stoppedElsewhere`; every other abort stays silent.

### Reconnect and status reads

`followJobToEnd` / `followOnce` (`serverCommands.ts`) document reconnect budgets, status reads, ticket wakes, lost
takeovers, viewer boot resume and creator warnings. Kept receipts and shutdown outcomes belong to
[generation](server-generation.md#job-receipts).

### Recovery reads

- After a lost or gone follow, and after a status end this tab's copy may lack, `recoverJobChat` marks the chat stale
  and awaits `refreshStaleChat` while the chat is still pinned (`followJobToEnd`'s comment). The read never discards
  local work.
- The whole read carries the chat's lock list, so a feed lock whose release frame was missed is released once the job
  has ended; only a feed frame or `hello` that arrived while the read was out keeps the feed's locks instead
  ([locks](live-updates.md#feed-locks)).
- A lost job may still be writing: `readChatAgain` reads the chat when it is viewed (`watchChatVisibility`) and for a
  completion push (`refreshChatAfterPush`), one at a time per chat (`readRecoveringChat`). The idle refresh's own read
  may overlap them; a copy that takes while a later idle read is out leaves the stale mark for that read's copy
  ([store](chat-store.md#job-hydration), `noteIdleChatRead`).

### Not in `sendChat`

- Input auto-translation: `createInputTranslation` (Files). Display translation: `ChatBody.svelte`.
- Suggestions: `Suggestion.svelte` calls `requestChatData` directly and follows the local send registry per chat: an
  entry taken for a chat cancels and clears only that chat's suggestions.
  - An entry's release requests suggestions if that chat is selected (or the send had no chat), else queues its chat key
    for when it is selected and loaded (only if suggestions are empty). A new send or deletion drops the queued key.
  - Opened while no send runs, it requests for the selected chat. Other selection changes request nothing.
- A continue on a group runs the group speaker loop like a send (`continueSend` false): the continue target is not
  passed to each speaker.
- The chat screen renders a window over the selected chat's loaded messages (`chatLoadInitialPages`,
  `chatLoadAdditionalPages`); paging never fetches.

## State

- `chatStatus.svelte.ts` holds per-tab sources keyed by `${chaId}\u0000${chatId}`: `generatingChatKeys()`
  (`followedJobs` plus `lockedChatKeys()`), `recoveryChatKeys` (lost chat → job id), and `unseenChatKeys` (up to 256
  chats whose reply ended while not visible). The memory health facts and the over-cap mark sit there too
  ([the health badge](structured-memory/read.md#the-health-badge)).
- `watchChatVisibility`, started once from `bootstrap.ts`, clears recovery and unseen for the chat whose transcript is
  shown (`visibleChatKey`), even when a lost follow adds a mark without a visibility change. New follows clear that
  chat's recovery; deleted chats' recovery is pruned.
- `anyLocalSend` is the tab-wide view for plugin reload deferral and translator cache-only mode; screen controls and
  suggestions follow the selected chat's own work.
- `followedJobs` (`serverCommands.ts`): job id → chat key. `jobStages` entries leave with it at the follow's end.
- `chatStore.svelte.ts` owns loaded chats and every write ([chat store](chat-store.md)); autosave does not.
- Chats load on demand. The chat screen renders nothing chat-dependent while the selected chat loads
  (`selectedChatLoad()`: a loading state, or the error with a retry).
- Operations that await chat state pin and load their captured targets; an unavailable target runs nothing
  ([pins and eviction](chat-store.md#pins-and-eviction), send and follow lifetimes included).
- The synchronous chat readers (`chatVar`, `getModules(ref)`, the CBS host, `transformClient`'s context, the MCP tool
  records) read loaded chats only; their chat is the selected one, a pinned job or request target, or a plugin context
  that awaited its load, and an unloaded chat reads as gone, never as another chat.
- The bound persona (`checkPersonaBinded`, `capturePluginContext`) is read from the chat's list entry, so it holds while
  the chat is not loaded.
- A streamed reply stays locked until the server releases its generation; the mirror batches text updates once per
  frame; hydration, rendering, and edit rules: [chat store](chat-store.md#locks-and-streaming).
- `refreshChatAfterWrite` adopts an eligible server by-id write into the job scope; otherwise the server reloads the
  chat. Its preconditions and immutable-copy contract are in [generation](live-update-feed.md#own-chat-changes).

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
- Every context builder takes its ids from the captured chat, never from the views: a job or chat request from
  `chatBinding(ref)` (`runPinnedServerJob`, `requestServer`), a render or plugin context from `chatDisplayIds(ref)`
  (`captureTransform`, `capturePluginContext`).
- The tab's chat LLM requests have the same guard (`requestChatData` before its hooks and tools, again at
  `requestChatDataMain`; a request inside a job callback is compared with the job's targets). A request without a chat
  is not a send: it carries no `chatRef`, is never refused by a binding, and runs on the settings views, read once
  before any await.
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
- Script modes, run by the server: `editinput` (user input), `editprocess` (prompt history and greeting), `editoutput`
  (model output), `editdisplay` (render). Lua edit triggers skip `editprocess`.
- The `request` trigger runs on the server job's requests only; the tab's own requests (translation, suggestions, the
  HypaV3 modal, plugins) go out without it.
- The prompt budget is `maxContext − maxResponse`: `assemblePrompt` counts from `maxResponse + 50`, and its no-memory
  trim, the HypaV3 step (`responseCorrection: false`, [memory](memory.md)), and the final token recheck after formatting
  (removable entries first, then the too-many-tokens error) all keep the response budget free, as the context meter
  assumes.
- SupaMemory and Hanurai count from the same total; HypaV2 keeps its legacy subtraction, so its recheck frees the
  response budget, with its last two chats protected.
- A new `PromptItem` type needs the `Recipes` entry's places, plus import conversion.
- Inlays are not stored in chat text. Removing an inlay (`removeInlayAsset`, the Inlay Explorer) breaks the
  `{{inlay::id}}` tags that name it; it removes metadata only; the asset sweep reclaims the blob. Deleting messages
  never removes inlays.
- Images become `MultiModal` input only when the model has `LLMFlags.hasImageInput`. Otherwise the job captions them
  (`captionImage`, `memory.md`).
- Built-in Jinja templates enforce roles: Gemma has no system role, and Mistral requires alternating roles.
- A suggestion result is applied only while its request token and the captured character and chat ids still match
  (`Suggestion.svelte`), never by a chat index.
- The suggestions' display translation works on a copy of the list and shows the whole result only while its run is
  current and the same chat is selected; a newer list, toggle, chat, or unmount ends it.

### Lore matching

In `shared/lore/activation.ts`.

- Only the last `scanDepth` messages are scanned; keys starting with `/` are regex; selective secondary keys, negative
  keys, and all-key mode are supported; decorators are parsed with `CCardLib.decorator.parse`.
- Recursion is controlled by `recursiveScanning` and `@@recursive`/`@@unrecursive`/`@@no_recursive_search`, with no
  explicit depth counter.
- Overrides apply to the chat owner's `globalLore` only, never to module lore. Activation drops orphans silently; the
  merged view is for chat-scoped readers, while editors, token estimates, and import/export read the raw character lore.
- A `child` entry ("Always active in this chat") activates from the first earlier entry with its id when that entry did
  not activate, copying its `comment` and `content` and taking its `insertorder` as order and priority (`@@priority`
  still wins).
- A child whose id is turned off by the chat's overrides (`offOverrideIds`, off-folder members included) never
  activates, even when another entry shares the id or its content has `@@activate`.
- `@@keep_activate_after_match` and `@@dont_activate_after_match` are per entry: an activated entry writes
  `__internal_ka_<id>`/`__internal_da_<id>` (its `id`, else `pickHashRand(5555, content)`) only for its own decorator.
  Later, a set `__internal_ka_` activates the entry without a key match, and a set `__internal_da_` keeps it off.

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
  for the tab; `pnpm --silent test:agent server/src/tests/{promptRunner,assemble,promptTail,lore}.test.ts` for the job.
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
- Not tested: in-tab Jinja rendering; mounted screen wiring for the paste write, input translation invalidation, and
  auto mode closing the chat; IME behavior on real devices (Android Korean, desktop Japanese); Stop on a resumed job
  beside another chat's send.
- Not tested: the DevTool preview and autopilot beyond `src/lib/SideBars/DevTool.test.ts`; check by hand.

## Known Hazards

### Issues

- A reroll's restore cannot see another tab's job that holds no lock yet and was not met at this tab's create: the
  restored replies land while that job runs, like any other edit (see
  [own chat changes](live-update-feed.md#own-chat-changes)).
- Stop stays visible between a followed job's `done` and its socket close, when an abort does nothing.
- A boot resume that discovers its chat but cannot load it shows Stop during the load retries, until the follow ends as
  lost.
- `disable_ui_prompt` lore decorators fill `disabledUIPrompts`, which nothing consumes.
- `renderChatTemplate` calls Jinja's `Template.render` synchronously with no work or time limit; a costly custom
  template occupies its caller's thread.
- The screen's per-chat reroll history (multi-reply tails) is in memory only.
- Composer recovery depends on the browser journal. The hide flush lands only while the page lives on after it: Chrome
  aborts IndexedDB writes begun in `pagehide` when the page unloads, so a reload, close, or navigation within 500 ms of
  the last edit loses that edit.
- In-page send recovery restores the serialized send text without its translation draft; journal recovery restores the
  pre-consumption composer. Neither restores a send whose job ended `done` (`ok`) after a script removed its user
  message.
- Lore keys keep the inherited grammar: every key is split on commas before the `/pattern/flags` parse, so `/a{1,2}/`
  becomes two malformed keys; the last slash closes a pattern, and a bare or unclosed slash, an invalid flag, or a
  malformed later entry ends that key search instead of being skipped. Kept for parity as a candidate for a later fix.

### Limitations

- Sequence events are live-only: parts completed without an attached socket do not count statistics in that tab. Server
  chat writes and receipt counts are authoritative. Decision: [generation](server-generation.md) command sequences.
- Accepted limits of sends in different chats at once (each chat has one local send and one server job; different chats
  of a tab run together). Decision: Per-Chat Send D1 and D6, [archive](../archived-plan/README.md).
  - Ordinary send, continue, reroll, and group jobs leave the character revision unchanged: last-chatted activity is
    derived from the chats' final-message times (`ChatSummary.lastMessageAt` for unloaded chats). Streamed continue
    refreshes the message time in its existing final write; previews move neither.
  - Explicit character effects (memory enable, triggers, Lua setters) patch the character without a character lock:
    simultaneous writes of the same field are last writer wins, and a group job and a member's own chat can patch that
    member the same way.
  - `CharEmotion` (`stores.svelte.ts`) is keyed by character, so two chats of one character share its emotion history;
    `stopTTS()` (`tts.ts`) stops every chat's speech; `alertWait`'s single status slot and the legacy `progress` overlay
    (`jobChannel.ts` `progressJobId`) show the newest job.
  - Plugin hooks and providers of one tab stay serialized by the server's per-client channel lane
    (`server-generation.md`): a slow provider in one chat delays the other chat's hooks. A queued callback's deadline
    starts at its dispatch, so the wait does not time it out.
- The server's `refreshChat` (`server/src/jobs/jobScope.ts`) reloads the stored chat after job writes and callbacks that
  may write, so an unrelated edit to that chat while the job runs can enter a later prompt stage. Decision: that file's
  header.

### Gotchas

- A foreign-job mark of a job this tab never saw a lock for (a command without a generation lock, or a feed that lagged)
  stays until a click looks the chat up. It only shows the extra Stop and never blocks Send.
- `editChat`/`editChatSync` (`src/ts/storage/chatEdits.ts`) capture the baseline before their edit works on its copy, so
  they keep another writer's change to a field the edit left alone; where both changed one field, the edit's value wins.
  A plugin's whole-chat setter captures its baseline only at the call ([plugins](plugin-sandbox.md)).
- `DevTool.svelte`'s autopilot sends each line as a job in the chat selected when it started; a group's speakers are
  chosen by the server.
- Group prompt assembly names a speaker it cannot resolve (`host.findCharacter`) `Unknown Character` in the group
  wrapper.
- Group lore activation takes the group as the character: its own `globalLore`, the chat's, and the modules'; the
  members' `globalLore` is not included, even with the group's `useCharacterLore`.
