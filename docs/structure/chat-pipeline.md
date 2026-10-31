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
  - `src/ts/process/{index.svelte,serverGeneration,prompt,stringlize,group,prereroll,command,infunctions,inlayScreen}.ts`
  - `src/ts/process/{lorebook.svelte.ts,templates/*,files/{inlays,multisend}.ts}`
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
  - Message-search panel presentation → `ui-theming.md`; endpoint implementation details → `server-resources.md`.
  - PDF conversion used by MCP filesystem tools → `plugins-mcp.md`.
  - Regex and trigger internals → `scripts-triggers.md`.
  - Rendering → `cbs-rendering.md`.
  - TTS and image generation → `media-aux.md`.

## Files

Bare paths are under `src/ts/process/`.

### Send client and registries

- `index.svelte.ts`: `sendChat(chatProcessIndex, arg)`, `previewChat(kind, target?)`, and the `OpenAIChat`/`MultiModal`
  types (declared in `shared/openai.ts`).
- `serverGeneration.ts` `sendChatOnServer(arg)`: the send as a server job (Flows).
- `localSends.ts`: the local send registry, this tab's sends, one per chat (`beginLocalSend`, `isLocalSend`). Admission
  reads the Map, not the derived `anyLocalSend`, which a subscriber may read one update late.
- `jobStages.ts`: the latest presentation stage per followed job (`setJobStage`, `dropJobStage`, `chatStageOf`).
- Both use `svelte/store`, no runes, and type-only imports, so hand-written mocks of `index.svelte` do not reach their
  readers.
- `chatStatus.svelte.ts`: per-tab generating, recovery, and unseen reply sources (State), `chatStatusKey`,
  `isChatBusy(ref)`, and the terminal hooks.
  - `isChatBusy` (a local send, a followed job, or a lock in that chat) is the busy check of `/multisend`, the DevTool
    preview and autopilot, the PO file run, the `previewRequest` hotkey, and the plugin `sendChat`.
  - It and `sendChat`/`previewChat`'s registry admission are per chat; shared resource flush (`GenerationBlockedError`),
    binding, and server refusals still apply. The plugin also refuses while any job channel callback runs.
- `sendAborts.svelte.ts` `createSendAborts`: the screen's own sends by chat, each with the `AbortController` its Stop
  aborts. Stop in one chat never aborts another chat's send.

### Prompt and templates

- `prompt.ts`: `tokenizePreset` and legacy import (`promptConvertion`).
- `shared/prompt/chatTemplate.ts`: `renderChatTemplate` (Hugging Face Jinja), `chatTemplates`;
  `templates/chatTemplate.ts` `applyChatTemplate` supplies the selected settings and names.
- `templates/templates.ts`: prebuilt presets (no id; a use goes through `normalizePreset`).
  `shared/prompt/templateCheck.ts`: prompt-template warnings.
- `stringlize.ts`: serializers for other backends and stop strings. `stringlizeChatOba` is unreferenced;
  `multiChatReplacer` is empty.
- `server/src/prompt/displayScope.ts` `createDisplayScopeLoader`: the transform's own `load`, beside generation's
  `loadJobScope`. Raw configuration is keyed by the full non-character revision vector. Raw entries are shared
  read-only; each request builds a fresh context projection, and each target gets its own writable overlay
  ([CBS rendering](cbs-rendering.md)).

### Lore

- `shared/lore/activation.ts` `activateLore(input, host)`: lore activation, shared with the server, over the merged
  owner lore, chat `localLore`, and the module lore the caller resolved. An entry the budget rejected after it recursed
  still activated what it matched. Lua `test_lorebook` returns the whole result as JSON. On the server, the regex test
  is the script worker's.
- `shared/lore/overrides.ts`: chat overrides of the owner's lore (`Chat.loreOverrides`, `ChatLoreOverride`: a frozen
  full copy linked by `entry.id`, and `off`). Off-folder membership follows the owner's current folder keys, never the
  frozen copy's. It returns references and never clones (the client passes live `$state` proxies); callers that mutate
  copy first.
- `loreOverrides.ts` `refuseOrphanedOverrides(ref)`: the alert local and server refusals share.
- `lorebook.svelte.ts`: the client wrapper of lore activation (`loadLoreBookV3Prompt`) and the lorebook codecs. File
  import/export supports character (`"global"`) and chat (`"local"`) lore; persisted global lore pages have no editor or
  file-codec mode. Local export refuses an unloaded chat with `localLoreExportNotLoaded`.

### Context report

`assemblePrompt` writes `MessageGenerationInfo.context` (`shared/contextReport.ts`; field comments).

- Readers go through `parseContextReport`: a wrong shape, non-finite or negative count, duplicate section kind, or
  sparse array reads as no report. Stored reports may lack `lore.rejected`.
- `historyDigest` and assembly's history share `eligibleHistory`.
- Sections are counted where assembly already counts (`addSection`): the memory entries as sent, by their recheck
  counts, and history as pushed. The signed `adjustment` carries the rest.
- Kept history is the set of sources in the final prompt: each history-side entry's source is kept by identity across
  `systemizeChat`, `pushPrompts` merges, and copies a memory algorithm returns (matched by message id before signature).
  Memory entries never adopt history sources.
- An `editRequest` that changes the list or a recheck removal of an entry without a whole source makes
  `attributionExact` false. `trim` exists without memory only (`contextTrim`).
- `memory.coverage` is `"unknown"` for non-HypaV3 memory. HypaV3 starts `"gap"` for uncovered trim, else `"unknown"` for
  stored summaries ahead of history, else `"covered"`. Later raw-history loss demotes only `"covered"`; returned memory
  with no traced memory-only survivor, or any untraced survivor, forces `"unknown"`.

### Composer and drafts

- `sendDraft.ts` `createSendDrafts`: the screen's per-chat send drafts. `idsFor` captures a request id before dispatch.
  `composerSendText` is the shared serialization.
- `composerDrafts.svelte.ts` `createComposer`: the screen's composer. `input`, `translate`, and `files` belong to the
  shown chat; `switchTo(key)` swaps drafts, and `at(key)` routes delayed writes to their captured chat. Without a
  journal it stays in memory only.
  - Setters track edits; getters never schedule writes, and opening an empty composer is not an edit. With the screen's
    `pageDraftJournal()`, edits are journaled after 500 ms of quiet per chat, and every dirty chat flushes on page hide
    or screen destruction.
  - `beginSend` immediately journals the consumed composer as the hand-off row, with its message id and, for ordinary
    Send, its request id and current epoch; Continue carries only the message id. Typing or clearing during the send
    writes only the draft row.
  - `settleSend` on an unsuccessful, unlanded send updates request identity on both rows, even for hidden or unmounted
    chats: a known end clears it from the matching attempt, and an uncertain end adds it to a matching row that lacks
    it. A different stored request id is left alone.
  - That send's hand-off stays until `placeSend` (the screen's settlement restore and `takeUnplaced`) puts the text
    back. Active send ids outlive their screen, so a remount cannot restore a send still running.
  - The `chatKey` effect runs `switchTo`, `takeUnplaced`, then `restore`: a journal read applies only to the same
    still-empty, unchanged composer.
  - Recovery loads the chat to check the user message id, drops a landed send, and otherwise restores without sending.
    An unknown load outcome keeps the draft and message id.
  - `restore` returns a request id only when the row's `requestEpoch` matches the current epoch; the screen adopts both
    ids so the next ordinary Send of that text reuses it. Another epoch keeps text and message id, and the next Send
    mints a fresh id. Same-epoch recovery in another tab keeps the id; the server replay resolves ownership.
  - Missing inlays are dropped, failed lookups keep them, and dropping an attachment invalidates both ids.
  - A module-level `onChatRemoved` subscription clears journal rows even without a mounted screen, invalidates pending
    restores and writes, and fences late `at(key)` callbacks until the key is shown again.
- `inputTranslation.svelte.ts` `createInputTranslation`: the screen's input auto-translation. A result is published only
  while the run owns the draft (`ownsDraft`); otherwise it is dropped, not deferred. The screen invalidates at a
  consumed send or slash command, a chat switch, turning input translation off, and destroy.
- `handleMainComposerKeydown`/`handleTranslationComposerKeydown`: Enter-send and Ctrl+M reroll, skipped while composing
  (`isImeComposing`) with no `preventDefault`, so the IME keeps the key. The partial editor's keys use the same guard.

### Reroll modules

- `prereroll.ts`: in-memory swipe history keyed by `generationId`, working only while the selected chat is the one the
  reply was generated in. The screen applies every candidate that is not null, so an empty one shows like any other.
- `rerollHistory.ts`: `restoreRerolledReplies` (Flows `Reroll`) and `createRerollHistory`, the screen's per-chat bundle
  history, up to 16 chats by last use.

### Slash commands, groups, and search

- `command.ts` `processMultiCommand(line, ref?)`: the chat input's slash commands. A new command goes in
  `processCommand`'s switch, with its `?` help text. Pipes are `|`. Unknown commands return `false` and fall through as
  ordinary text.
  - `/trigger` runs on the server (`runServerManualTrigger`, `scripts-triggers.md`).
  - `/send` only appends a user message. The typed `/multisend`'s page-owned loop `runMultisend` sends each part with
    `sendChat(-1, { target: ref })`. A command job runs its queued `/multisend` parts on the server under one job id and
    chat slot ([generation](server-generation.md)).
- `files/multisend.ts` `postChatFile`: file attachments. The PDF branch is unreachable from the picker.
- `group.ts`: `groupOrder`, `addGroupChar`, `rmCharFromGroup`. `infunctions.ts` `calcString`: the CBS calc function.
- `shared/messageSearch.ts` defines `POST /api/chats/search` shapes; `src/ts/messageSearch.svelte.ts` builds requests
  and owns the pending message-jump coordinator.

### Inlays

- `inlayScreen.ts` `runInlayScreen` turns image/emotion commands in the output into `{{inlay::id}}`.
- `files/inlays.ts`: inlays on the server (header comment): `writeInlayImage`, `setInlayAsset`, `getInlayAsset`,
  `listInlayAssets`, `removeInlayAsset`, `getInlayMedia`, `verifyInlay`, `repairInlayMedia`.
  - `src/ts/bootstrap.ts` wires inlay feed changes to `noteRemoteInlay`, reconnects to `reconcileInlays`, and remote
    record or chat reloads (`onRemoteRecordApplied`, `setRemoteChatListener`) to `invalidateInlayCaches`.
  - Rendering: [CBS rendering](cbs-rendering.md) `parseInlayAssets`. The `<source>` type comes from
    `shared/assetMime.ts`. `getInlayObjectUrl`'s URLs are never revoked: rendered and cached HTML holds them.

## Flows

### Send, in `DefaultChatScreen.svelte`

1. `send`/`sendContinue` → `sendMain`:
   1. Capture the selected chat and its composer draft. If it has work of its own (`isChatBusy`), alert `chatGenerating`
      and stop before the text, translation draft, attachments, or reroll history are consumed. Other chats are not
      checked: switching chats or characters mid-send is allowed.
   2. `processMultiCommand`; a line that is not a command checks the chat again after it.
   3. An incomplete binding (`chatBinding(ref)`, [chat bindings](persistence.md)) opens `chatBindingDialog` and stops
      before anything is consumed (also for Continue). The send button then reads "Set up this chat" (it keeps
      `button-icon-send`, so the send hotkey opens the setup too), and both composers are read-only.
   4. Orphaned lore overrides refuse locally, before anything is consumed (also for Continue).
   5. Append queued `{{inlayed::id}}` tags.
   6. A nonempty input becomes the job's input with a new `userMessageId` (the job runs the input trigger, `editinput`,
      and appends the user message); an empty input, or a continue from one, appends "_says nothing_" when
      `useSayNothing` is on and the last message is not the user's.
   7. `sendChatMain`, with no await between consuming the input and the send's admission.
2. `sendChatMain` rechecks the captured chat's busy state, creates its Stop controller, and calls `sendChat` with the
   captured target and input ids.
   - Stop aborts the selected chat's controller and followed jobs.
   - Auto mode stays with its starting chat and ends on Stop, an unsuccessful round (`ok` false: refused, failed, or
     stopped), toggling it off, or leaving/closing that chat.
   - Failed input drafts return only to an empty composer for their chat and keep the same `userMessageId` for a safe
     retry.

### Reroll

- `reroll`/`unReroll` refuse while the selected chat is busy. Swipe candidates are tried first, then the per-chat bundle
  history. A new user send clears that chat's bundle history.
- A history swap uses `editChatSync` only while its anchor and tail message ids still match.
- A new reroll refuses orphaned lore overrides with the same alert before removing the captured tail; otherwise it
  removes it and sends in the captured chat.
- A send that brought no reply puts the removed tail back (`rerollHistory.ts` `restoreRerolledReplies`; its comment has
  the conditions). A refusal first withdraws the matching removal while it still owns the end of the save queue; after
  an ambiguous response that restoration is provisional ([persistence](persistence.md)).
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
  owner-scoped DELETE while followed.

### Stop for a job this tab does not follow

- A chat with a server lock or a known job this tab does not follow shows an extra Stop beside Send (or chat setup). The
  advisory `foreignJobs` mark never participates in `isChatBusy` or removes the Send hotkey.
- `stopChatJob(ref)` admits one confirmation flow per chat, even across screen remounts. `readChatGeneration` looks up
  the current slot without attaching or holding plugin work; `stopChatGeneration` sends that exact job id. Each exchange
  has a 10 s deadline; a timeout ends the flow. The confirmation wait is not bounded.
- A 409 `jobChanged` reads and confirms the replacement; 404 clears the mark and stops nothing.
- A successful stop leaves the mark through abort grace; a later idle lookup, an owned/followed lookup, the release of
  that chat's server lock, or a new local send/follow clears it.
- Only the explicit chat stop attributes another client; request-id cancel remains an ordinary silent abort.

### Replays and uncertain creates

- A replay is classified before saving a job, setting its stage or holding it live. Unowned jobs are never saved or held
  live.
- An owned running replay is followed as this action (`outcome: "replayed"`), with `onStart` once.
- An owned ended replay feeds its terminal into the shared follow lifecycle; a failed later read cannot turn that known
  terminal into a lost follow.
- Non-owned running replays refuse as busy and retain the job id in `foreignJobs`, as does a `chatBusy` refusal whose
  owner status cannot be read.
- Non-owned ended replays and missing status payloads reconcile the chat and expose whether that read succeeded, never
  fabricating a successful terminal or starting success-driven loops.
- A cancel naming an owned job follows it to its terminal; a foreign cancel reconciles its chat and remains uncertain
  while still running.
- After an unanswered create, a decoded answer resolves the exchange only when it fences a delayed copy of the original
  POST: success, replay, or a `registryRefusal`, which stays true for the same frozen body.
- Refusals the original could still pass later (both 503s, `chatBusy`, `chatBindingIncomplete`,
  `chatLoreOverrideOrphaned`) show their usual message but keep the request uncertain. An uncertain `chatBusy` is not
  followed, since a job of this request id would have been replayed.
- Failures before lookup (auth, rate limit, body limit, epoch mismatch) and generic/undecodable errors also leave it
  uncertain; the epoch notice still runs.

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
  ([media and auxiliary work](media-aux.md)). Job event and callback contract: [generation](server-generation.md).
  HypaV3 work during a send: [memory](memory.md).
- The tab's barrier reads the job chat whole once when it still does not hold the receipt (no or an older remembered
  copy, an unapplied patch, or a copy refused by the acknowledged floor), admitting it with the job's held streaming
  metadata before running the hook ([persistence](persistence.md)).
- A live `sequence` event counts one `messages` statistic and installs the part's alternatives
  (`installReplyAlternatives`); it keeps the job followed and its channel open. A `done.sequence.stopped` shows
  `serverJob.sequenceStopped`.
- A failed terminal goes through `alertJobError` with checked debug fields ([diagnostics](diagnostics.md)); sequence
  errors prefix the shown message with the progress and leave those fields intact.
- An abort with `abortedBy: "other"` shows `serverJob.stoppedElsewhere`; every other abort stays silent.

### Reconnect and status reads

`followJobToEnd` and `followOnce` (`serverCommands.ts`) state this cycle in their comments; `socketLiveness.ts` gives up
and replaces attaches.

- Only links that failed in a row spend `MAX_ATTACHES`: `closed` `resumed` and a close while the page is away (`jobLink`
  `closedAway`) are not counted, and `closed` `received` starts the count again.
- After every close without the terminal the follow reads the job's status. Its kept outcome (`GenerationStatus.kept`,
  up to 24 h, across a server restart too through the job receipts) is the end. A job that was running when the server
  stopped reads as a kept `shutdown` error.

### Recovery reads

- After a lost or gone follow, and after a status end this tab's copy may lack, `recoverJobChat` (its comment has the
  rest) marks the chat stale and awaits `refreshStaleChat` while the chat is still pinned. The read never discards local
  work.
- The whole read carries the chat's lock list, so a feed lock whose release frame was missed is released once the job
  has ended; only a feed frame or `hello` that arrived while the read was out keeps the feed's locks instead
  ([persistence](persistence.md) Save step 9).
- A lost job may still be writing, so `readChatAgain(ref)` reads the chat when it is viewed (`watchChatVisibility`) and
  for a completion push (`refreshChatAfterPush(ref)`).
- One chat's recovery reads run one at a time (`readRecoveringChat`). The idle refresh's own read may overlap them; a
  copy that takes while a later idle read is out leaves the stale mark for that read's copy
  ([persistence](persistence.md), `noteIdleChatRead`).

### Not in `sendChat`

- Input auto-translation: `createInputTranslation` (Files). Display translation: `ChatBody.svelte`.
- Suggestions: `Suggestion.svelte` calls `requestChatData` directly and follows the local send registry per chat: an
  entry taken for a chat cancels and clears only that chat's suggestions.
  - An entry's release requests suggestions if that chat is selected (or the send had no chat), else queues its chat key
    for when it is selected and loaded (only if suggestions are empty). A new send or deletion drops the queued key.
  - Opened while no send runs, it requests for the selected chat. Other selection changes request nothing.
- `writeInlayImage` rejects when the image has no pixels or fails to load; a caller handles that.
- A continue on a group runs the group speaker loop like a send (`continueSend` false): the continue target is not
  passed to each speaker.
- The chat screen renders a window over the selected chat's loaded messages (`chatLoadInitialPages`,
  `chatLoadAdditionalPages`); paging never fetches.

## State

- `chatStatus.svelte.ts` holds per-tab sources keyed by `${chaId}\u0000${chatId}`: `generatingChatKeys()`
  (`followedJobs` plus `lockedChatKeys()`), `recoveryChatKeys` (lost chat → job id), and `unseenChatKeys` (up to 256
  chats whose reply ended while not visible).
- `watchChatVisibility`, started once from `bootstrap.ts`, clears recovery and unseen for the chat whose transcript is
  shown (`visibleChatKey`), even when a lost follow adds a mark without a visibility change. New follows clear that
  chat's recovery; deleted chats' recovery is pruned.
- `anyLocalSend` is the tab-wide view for plugin reload deferral and translator cache-only mode; screen controls and
  suggestions follow the selected chat's own work.
- `followedJobs` (`serverCommands.ts`): job id → chat key. `jobStages` entries leave with it at the follow's end.
- The tab never mutates the chat in place: `src/ts/storage/chatStore.svelte.ts` holds the chats (`selectedChat()`,
  `chatList()`), and every write goes through it (see `persistence.md`), addressed by chat and message id. Autosave does
  not see chats.
- Chats load on demand. The chat screen renders nothing chat-dependent while the selected chat loads
  (`selectedChatLoad()`: a loading state, or the error with a retry).
- A server job's target chat is pinned and loaded before the job is created (`runServerJob`; `followJobToEnd` for a
  resumed or followed job, through every reconnect, sequence part, and the terminal's hydration). A send's chat stays
  pinned until `sendChatOnServer` has read the reply's alternatives; a target that cannot be loaded runs nothing.
- A typed command line (`processMultiCommand`), an auxiliary LLM request (`requestServer`: its chat and its parse chat,
  until its event stream ends), `editChat`, and a group output listener's speaker (`chatOutput`: its chats, before each
  listener) pin and load what they read.
- The synchronous chat readers (`chatVar`, `getModules(ref)`, the CBS host, `transformClient`'s context, the MCP tool
  records) read loaded chats only; their chat is the selected one, a pinned job or request target, or a plugin context
  that awaited its load, and an unloaded chat reads as gone, never as another chat.
- The bound persona (`checkPersonaBinded`, `capturePluginContext`) is read from the chat's list entry, so it holds while
  the chat is not loaded.
- Streaming display: a server job's message is locked while it streams (`isMessageLocked`); `Chat.svelte` disables its
  controls and renders it without the server transform until the lock ends.
  - `applyServerGeneration` sets its chat's `streamingEntry(ref)` on the generation's first stream update with the
    configured `streamingDisplayOptimizationMode`, and that generation's lock release clears only that entry
    (`persistence.md`).
  - `Chats.svelte` keeps the streaming row mounted in every mode while it streams and mounts it again when it ends.
  - The chat module writes the streamed text into the mirror at most once per frame (`persistence.md`), so a streaming
    row parses once per frame, not once per chunk.
- After a job's own by-id write, `refreshChatAfterWrite` (`server/src/jobs/jobScope.ts`) adopts that write's stored
  change ([generation](server-generation.md) "Own chat changes"), so a streaming checkpoint reads no transcript.
  - Only while the scope held exactly the change's base revision, the group was not stale, and the stored revision is
    still the change's when the write returns; any other case reads the chat whole.
  - The chat object is always new, and so is its message list unless the change moved no message, so scripts holding the
    previous copy see it unchanged.

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
  `{{inlay::id}}` tags that name it; it removes metadata only, since retained snapshots may reference the blob. Deleting
  messages never removes inlays.
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
- `e2e`: `e2e/perChatSends.spec.ts`, `e2e/chatLoreOverrides.spec.ts`, `e2e/chatBinding.spec.ts`.
- `promptRunner.test.ts` runs the send with real Lua/regex workers, a plugin hook, and a fake provider.
- `DefaultChatScreen.drafts.test.ts`: real stores; `mountComposer` controls the clock, job creation, and resource I/O
  (`FakeResourceServer`), with fake IndexedDB and Web Locks and stubbed children.
- Browser checks: `util/playwright/checkServerSend.mjs`, `checkServerJobMatrix.mjs`, `checkSidebarChatStatus.mjs`, and
  `checkStreamingModes.mjs`. `checkJobProtocol.mjs` drives the job client with a real plugin provider
  ([test-harness](test-harness.md)).
- Not tested: in-tab Jinja rendering; mounted screen wiring for per-chat reroll, the paste write, input translation
  invalidation, and auto mode closing the chat; IME behavior on real devices (Android Korean, desktop Japanese); Stop on
  a resumed job beside another chat's send.
- Not tested: the DevTool preview and autopilot beyond `src/lib/SideBars/DevTool.test.ts`; check by hand.

## Known Hazards

### Issues

- A reroll's restore cannot see another tab's job that holds no lock yet and was not met at this tab's create: the
  restored replies land while that job runs, like any other edit (see `refreshChat` below).
- Stop stays visible between a followed job's `done` and its socket close, when aborting the ended job does nothing.
- A boot resume that discovers its chat but cannot load it shows Stop during the load retries, until the follow ends as
  lost.
- `disable_ui_prompt` lore decorators are collected into `disabledUIPrompts`, but that array is never consumed.
- `renderChatTemplate` calls Jinja's `Template.render` synchronously with no work or time limit; a costly custom
  template occupies its caller's thread.
- `prereroll.ts` history and the screen's per-chat reroll history are in memory only.
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

- Sequence events are live-only: parts completed without an attached socket do not install alternatives or count
  statistics in that tab, and a received part's alternatives are not installed if the tab's chat copy lacks its reply.
  Server chat writes and receipt counts are authoritative. Decision: [generation](server-generation.md) command
  sequences.
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
  A plugin's whole-chat setter captures its baseline only at the call ([plugins and MCP](plugins-mcp.md)).
- `DevTool.svelte`'s autopilot sends each line as a job in the chat selected when it started; a group's speakers are
  chosen by the server.
- Group prompt assembly names a speaker it cannot resolve (`host.findCharacter`) `Unknown Character` in the group
  wrapper.
- Group lore activation takes the group as the character: its own `globalLore`, the chat's, and the modules'; the
  members' `globalLore` is not included, even with the group's `useCharacterLore`.
