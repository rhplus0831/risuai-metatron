# Chat Pipeline: Send → Prompt → Request → Reply

## Scope

- Owns:
  - the tab's side of a send: the input box to the server job (`sendChat` is the job client) and the reply as the job's events and records bring it,
  - the prompt editor's helpers (`prompt.ts`, the templates, `templateCheck`), the lorebook codecs and the DevTool lore preview,
  - group membership (`group.ts`),
  - reroll,
  - slash commands,
  - inlays.
- Paths:
  - `src/ts/process/index.svelte.ts`, `src/ts/process/serverGeneration.ts`
  - `src/ts/process/{prompt,stringlize,group,prereroll,command,infunctions,inlayScreen}.ts`
  - `src/ts/process/lorebook.svelte.ts`, `shared/lore/activation.ts`
  - `src/ts/process/templates/*`, `shared/prompt/{chatTemplate,templateCheck}.ts`
  - `src/ts/process/files/{inlays,multisend}.ts`
  - `src/ts/process/dynamicutils/pdf.ts`
  - The send handlers in `src/lib/ChatScreens/DefaultChatScreen.svelte`
- Not here:
  - Prompt assembly, token trimming, the request, streaming, and the post-processing tail run in the server job → `self-host-server.md` (`runPromptJob`, `assemblePrompt`).
  - Memory algorithms → `memory.md`.
  - `requestChatData` internals → `llm-requests.md`.
  - Token counting (`shared/tokenizerChoice.ts`, `shared/prompt/chatTokens.ts`) → `llm-requests.md`.
  - Regex and trigger internals → `scripts-triggers.md`.
  - Rendering → `cbs-rendering.md`.
  - TTS and image generation → `media-aux.md`.

## Files

- `index.svelte.ts`: the send's job client (the browser assembly path was removed).
  - Exports `sendChat(chatProcessIndex, arg)` (`arg`: `serverGeneration.ts` `ServerSendArg` plus `onServerRefused`; `chatProcessIndex` is kept for the plugin API's signature and not read), `doingChat` (the tab's busy flag: set by `sendChat`, cleared by its callers), `previewFormated`/`previewBody` (a preview's result), and the `OpenAIChat`/`MultiModal` types (declared in `shared/openai.ts`).
- `serverGeneration.ts` `sendChatOnServer(arg)`: the send as a server job (below).
- `prompt.ts`: `tokenizePreset` and legacy-preset conversion; re-exports the prompt types declared in `shared/prompt.ts`.
  - Types: `PromptItem` (discriminated union), `PromptSettings`, `PromptRole`.
  - `tokenizePreset`.
  - Legacy import: `detectPromptJSONType`, `stChatConvert`, `promptConvertion`.
- `shared/lore/activation.ts` `activateLore(input, host)`: lore activation, shared with the server. It merges three sources: character `globalLore`, chat `localLore`, and the module lore the caller resolved; matches keys, regex keys (`/pattern/flags`: the last `/` ends the pattern, empty flags allowed), and decorators over the scanned messages; recurses; applies the token budget and `@@inject_lore`; and returns `{ actives, matchLog }`. `LoreHost` supplies the clone, the speaker names, the chat variables (the keep and don't-activate-after-match flags), CBS, the token count, and the regex test (on the server, the script worker's).
- `lorebook.svelte.ts`: the client wrapper of lore activation and the lorebook codecs.
  - `loadLoreBookV3Prompt(chatRef?)` runs `activateLore` for the chat with `getModuleLorebooks(ref)`, `loreBookDepth`, `loreBookToken`, and `getUserName(ref)` (the bound persona's name), and the client host.
  - Also `addLorebook`, `addLorebookFolder`, `importLoreBook`, `exportLoreBook`, `convertExternalLorebook`.
- `shared/prompt/chatTemplate.ts`: `renderChatTemplate(messages, { type, jinjaTemplate, characterName, userName })` (Hugging Face Jinja), `chatTemplates` (built-in Llama/Gemma/Mistral/...), `templateEffect`. `templates/chatTemplate.ts` re-exports `chatTemplates` and `templateEffect` (not `renderChatTemplate`), and its `applyChatTemplate(messages, { type?, custom? })` supplies the selected model preset's `instructChatTemplate`/`JinjaTemplate`, the selected character, and the user's name.
- `templates/templates.ts`: re-exports `prebuiltPresets` and `prebuiltNAIpresets` from `shared/presetTemplates.ts` (templates carry no id; a use goes through `normalizePreset`).
- `shared/prompt/templateCheck.ts` `templateCheck({ promptTemplate })`: prompt-template warnings (`templates/templateCheck.ts` re-exports it).
- `stringlize.ts`: serializers for non-chat-completion backends and stop strings.
  - `stringlizeChat`, `stringlizeAINChat`, `unstringlizeChat`, `getStopStrings`.
  - `stringlizeChatOba` is unreferenced. `multiChatReplacer` is empty.
- `group.ts`: `groupOrder` (name mentions, then shuffle and talkativeness), `addGroupChar`, `rmCharFromGroup`.
- `prereroll.ts`: `Prereroll`, `PreUnreroll`, `addRerolls`. In-memory swipe history keyed by `generationId`.
- `rerollHistory.ts` `createRerollHistory`: the screen's per-chat bundle history (`record`, `begin`, `canForward`, `forward`, `back`, `clear`), up to 16 chats by last use; owned copies with an anchor message id and a cursor, swapped through `editChatSync` only while the anchor and current tail ids still match.
- `sendDraft.ts` `createSendDrafts`: the screen's per-chat send drafts (`idFor`, `settle`, `takeUnplaced`); failed sends keep their text and `userMessageId` until restored, and keep the id after restoration for a safe retry.
- `command.ts` `processMultiCommand(line, ref?)`: the chat input's slash commands (`/send`, `/sendas`, `/cut`, `/del`, `/multisend`, `/trigger`, variables, TTS, `?` help). `/trigger` runs on the server (`runServerManualTrigger`, `scripts-triggers.md`); a trigger's `v2Command` runs the server's command executor.
  - Pipes are `|`.
  - Unknown commands return `false` and fall through as ordinary text.
- `infunctions.ts` `calcString`: calculator for the CBS calc function.
- `inlayScreen.ts`:
  - `runInlayScreen`: turns image/emotion commands in the output into `{{inlay::id}}` via `generateAIImage(..., 'inlay')` and `writeInlayImage`.
  - `updateInlayScreen`.
- `files/inlays.ts`: inlays on the server. Metadata is the `inlays` resource (id = inlay id, `InlayResource` in `shared/resources.ts`); media bytes are assets named by content hash (`assets/inlay_<sha256>.<ext>`), so the same bytes are stored once; a signature keeps its JSON in the metadata `text`.
  - `writeInlayImage`: normalizes to PNG and caps the size at 1024² pixels.
  - `postInlayAsset`, `setInlayAsset` (Blob or data URI), `saveInlayedSignature`, `getInlayAsset` (base64 data URI), `getInlayAssetBlob` (Blob), `listInlayAssets` (metadata only, read fresh; replaces the cached view), `removeInlayAsset` (metadata only; the blob stays because retained snapshots may reference it), `getInlayMetadata`, `verifyInlay` and `repairInlayMedia` (the browser-local import), `invalidateInlayCaches`.
  - Caches: metadata seeded at boot (`seedInlays`) plus a GET on a miss, a negative cache for unknown ids that expires after 30 s, a 64 MiB blob cache (content-addressed, so never stale), and in-flight de-duplication. Metadata is only as fresh as this tab's own writes plus `invalidateInlayCaches`, which `bootstrap.ts` runs whenever the save adapter brought another tab's records into the mirror (`onRemoteRecordApplied`). Every public write to one id (preparation, upload, and metadata) runs after the previous one; a conflict with another tab re-reads once and writes over it (last writer wins, as before).
  - `supportsInlayImage`.
- `files/multisend.ts` `postChatFile`: file attachments (PO, TXT, XML retrieval, media → inlays). The PDF branch is unreachable from the picker.
- `dynamicutils/pdf.ts`: `convertPdfToImages`, `extractPdfText`. Not used by `sendChat`.

## Flows

Send, in `DefaultChatScreen.svelte`:

1. `send`/`sendContinue` → `sendMain`:
   1. Reject if `$doingChat`; a followed job of the selected chat (`ownedJobIds`, from `followedJobsOf`) alerts `chatGenerating` and stops before the text, translation draft, attachments, or reroll history are consumed.
   2. `processMultiCommand`.
   3. An incomplete binding (`chatBinding(ref)`, `docs/plan/chat-binding.md`) opens the chat's binding dialog (`chatBindingDialog`) and stops before anything is consumed (also for Continue): the text, the translation draft, and the attachments stay. The send button reads "Set up this chat" meanwhile (it keeps `button-icon-send`, so the send hotkey opens the setup too).
   4. Append queued `{{inlayed::id}}` tags.
   5. A nonempty input becomes the job's input with a new `userMessageId` (the job runs the input trigger, `editinput`, and appends the user message); an empty input appends "_says nothing_" when `useSayNothing` is on and the last message is not the user's (a continue from an empty input does it too).
   6. `sendChatMain`.
2. `sendChatMain` creates an `AbortController` and calls `sendChat(-1, {target, signal, continue, input, userMessageId})`, where `target` is the chat `sendMain` captured before any await (commands and multisend capture theirs the same way). Stop shows for `$doingChat`, input translation, or any followed job of the selected chat; `abortChat` aborts the local controller (including during job creation or a local send in another chat) and every followed job of the selected chat (`abortGenerationJob`). The controller is cleared when its send ends, only if it is still that send's controller. This also makes a selected chat's Lua button or manual trigger command job stoppable, and a plugin's `sendChat`, autopilot, `/multisend`, or DevTool preview once its job exists and is followed; Stop cannot abort those callers during job creation. Auto mode checks `ownedJobIds` before each `sendChatMain`, alerts `chatGenerating`, and ends its loop when that chat has a followed job. After the send resolves or throws, `sendDrafts.settle` drops a draft whose user message landed or whose job ended `done` (`ok`). Otherwise the text returns to the composer when that chat is still selected and the composer is empty; an unplaced draft returns when the user switches back to the chat with an empty composer (`takeUnplaced`). The text keeps its `userMessageId` even after a refusal or error: an absent message may be a hydration gap, and retrying the same text under the same id makes the job skip an input it already appended. Only `sendMain` clears the composer; reroll and auto-mode sends leave a draft being typed alone. The reroll bundle starts after the captured anchor (the user message id for a typed send), resolved by id after the await.
3. `reroll`/`unReroll` refuse with the `chatGenerating` alert while the chat holds a lock (the reply stays locked until the job's last write lands; the buttons are disabled meanwhile). They try `Prereroll`/`PreUnreroll` (`setMessageText`) first, then the screen's history keyed by both character and chat id (`rerollHistory`). A stored bundle replaces the tail through `editChatSync` only if its anchor still exists (null means the start) and every current tail id matches the bundle at the cursor in order; a mismatch clears that chat's history and writes nothing. Without a forward bundle, `reroll` captures every removed reply in order with `begin`, removes those replies (`editChatSync`), and calls `sendChatMain` with the captured chat. `sendChatMain` records the new bundle under that chat and anchor; a new user send clears that chat's history.

`sendChat` in `index.svelte.ts` (the only path since the cutover): the `doingChat` guard and the deleted-target check, then `serverGeneration.ts` `sendChatOnServer`, which writes `statics.messages` (`incrementStatic`; the target's `lastInteraction` is the server job's to stamp, `self-host-server.md`), and calls `serverCommands.ts` `runServerJob` (the send guard first: a chat whose binding is not complete (an unset or deleted field, or an import's pending review) shows its problems (`chatBindingRefusalText`) and runs nothing, for every job of a chat (send, continue, reroll, group, preview, command); the job's ids are the chat's bound ids (`chatContextIds`), or a held job's own (`options.identity`) for a rerun; the client environment taken before the first await; `flushResources()` with a refusal on a rejection or a discarded change (a `GenerationBlockedError`, the chat or character waiting for another tab's job, alerts `chatGenerating` unless the adapter's conflict recovery has just shown it), the job posted as `preview`, `previewPrompt`, `group` for a group chat, `continue`, or `send` with `input`, `userMessageId`, and an explicit `continueMessageId`, an abort of `arg.signal` sent as `DELETE` also while the job is created, and the job followed to its end through `followJobToEnd`). That one lifecycle per job registers it in `followedJobs` as soon as its chat is known (the caller's `ref` or the boot discovery, before the chat load), and removes it in `finally` at the lifecycle's end (terminal, lost, or load failure). Each update replaces the Map; entries are keyed by job id because the server frees the chat slot before sending the terminal, so an older follow's cleanup or a late boot discovery cannot hide a newer job of that chat. `runServerJob` takes a plugin call's prompt and model presets and effective persona from `arg.pluginContext`; a busy job of this tab is followed (and aborted with the signal) but does not count as this send; a create request without an answer is `unknown` (the job may exist). `sendChat` returns false for a refused, followed, or unknown send and for a `done` with `stopped`; `onServerRefused(ambiguous)` reports a refusal, and the screen settles its draft after the send. A preview's `done.result` becomes `previewFormated` or `previewBody`; a reply's `done.alternatives` go to `addRerolls` under its generation (none for a continue). A server refusal of the binding (409 `chatBindingIncomplete` with its problems, or `chatBindingMismatch` when the server holds a newer binding, which reads the chat again) shows the same message. The job's `preset` event (a `presetChain` pick) changes nothing in the tab: the pick is the job's own, neither the tab's selection nor the chat's binding (`generationJobs.ts` `applyGenerationEvent`).

The job (`self-host-server.md` `runPromptJob`, `assemblePrompt`) runs the input stage, `presetChain` (it picks a prompt preset only; the job keeps its model preset), the group order (one reply per active member), lore, memory, the prompt assembly and trimming, the request, and the tail on the server: `editoutput` once on the completed reply (not per chunk), the output trigger, inlays, the `chatOutput` listeners (a callback to the tab; each listener gets a fresh copy of the character and chat), TTS and notification as notices, auto-continue and a trigger's resend as rounds of the same job (at most 8 extra), `igp` on the last reply only, the emotion modes on the server with an `emotion` notice (the tab sends the emotions it showed last with the job), and the image view as an `imggen` callback. Before `done`, a send that was not aborted hands its replies (every reply of its speakers and rounds still in the chat) and then its user message to the translation runner (`handOffTranslations`, `docs/plan/translation.md` slice 2.3), which translates them detached from the job when the chat auto-translates; the job sends a `translating` notice for the ids handed over, and the tab follows them (`followStoredTranslations`). A plugin provider model answers through a `provider` callback to the tab; remembered tool calls are read from and written to `chat.toolCalls`; a `/multisend` of a server command job is sent by the tab after the job (`done.followUps`, `runMultisend`). The tab reconstructs the job's `chunk` deltas (`base`, a sequence; `keep`, a UTF-16 prefix length; `text`, the new tail) from its raw stream buffer (`applyServerGenerationChunk`), then shows them through `applyServerGeneration` while the message is locked. A missing base asks for `resyncReply`, answered only with the current full-text `accepted`; it never requests a chat or marks it stale (`persistence.md`). Stored copies arrive through `chatPatch` or `resource` events.

A failed job's `error` terminal says where it failed (`docs/plan/request-history-diagnostics.md` slice 6): `stage` (`setup`, `input`, `assembly`, `request`, `script`, `persist`, `tail`), `requestId` (the LLM request that failed, the request history's id), and `providerCode`, each optional and only on a runner's failure (an abort, a timeout, shutdown, or maintenance has none). The tab shows it with `alertJobError` (`src/ts/alert.ts`, from `serverCommands.ts` `reportEnd`): the error alert with "Copy debug info" (`src/ts/diagnostics/jobDebugInfo.ts`: a content-free block of the version, the time the tab received the end, the job, request, stage, status, reason, and provider code, each checked; never the message) and "Open in request history" (`alertRequestLogs({ jobId })`: the viewer filtered to the job; the popup keeps the filter across its tabs).

Not in `sendChat`:

- Input auto-translation happens in `DefaultChatScreen.updateInputTransateMessage`.
- Display translation happens in `ChatBody.svelte`.
- Suggestions come from `Suggestion.svelte`, which calls `requestChatData` directly.
- `writeInlayImage` rejects when the image has no pixels or fails to load; its per-id queue moves on to the next write, so a caller handles the rejection.
- A continue on a group runs the group speaker loop like a send (`continueSend` false): the continue target is not passed to each speaker.
- The chat screen renders a window over the selected chat's loaded messages (`chatLoadInitialPages`, `chatLoadAdditionalPages`); paging never fetches, and selecting a chat that is not loaded shows the loading state (or the error with a retry) until it is.

## State

- `OpenAIChat` has `role`, `content`, `memo`, `removable`, `attr`, `multimodals`, `thoughts`, and `cachePoint`.
  - `memo` values `supaMemory`/`hypaMemory` mark memory cards.
- `PromptItem` types: `plain|jailbreak|cot`, `chatML`, typed `persona|description|lorebook|postEverything|memory`, `authornote`, `chat` (with a range), and `cache`.
- Reactive singletons: the records (through `settingsViews.svelte.ts` and `characterStore.svelte.ts`), `selection`, `doingChat` (the tab-wide send busy flag), `followedJobs` (`serverCommands.ts`: the jobs this tab follows, job id → `${chaId}\u0000${chatId}`; `followedJobsOf` selects a chat's job ids), `CharEmotion`.
- The tab never mutates the chat in place: the chats are held by `src/ts/storage/chatStore.svelte.ts` (the screen reads `selectedChat()` and the lists `chatList()`), and every write goes through it (see `persistence.md`), addressed by chat and message id. Autosave does not see chats.
- Chats load on demand. The chat screen renders nothing chat-dependent while the selected chat loads (`selectedChatLoad()`: a loading state, or the error with a retry). A server job's target chat is pinned and loaded before the job is created (`runServerJob`; `followJobToEnd` for a resumed or followed job, through every reconnect and the terminal's hydration; a command job's `/multisend` follow-ups), and a send's chat stays pinned until `sendChatOnServer` has read the reply's alternatives; a target that cannot be loaded runs nothing. A typed command line (`processMultiCommand`), an auxiliary LLM request (`requestServer`: its chat and its parse chat, until its event stream ends), `editChat`, and a group output listener's speaker (`chatOutput`: its chats, before each listener) pin and load what they read. The synchronous chat readers (`chatVar`, `getModules(ref)`, the CBS host, `transformClient`'s context, the MCP tool records) read loaded chats only; their chat is the selected one, a pinned job or request target, or a plugin context that awaited its load, and an unloaded chat reads as gone, never as another chat. The bound persona (`checkPersonaBinded`, `capturePluginContext`) is read from the chat's list entry, so it holds while the chat is not loaded.
- Streaming display: a server job's message is locked while it streams (`isMessageLocked`); `Chat.svelte` disables its controls and renders it without the server transform until the lock ends. The display optimization (`streamingDisplayOptimizationMode`) follows the stream: `applyServerGeneration` sets `streamingState` on the generation's first stream update with the configured mode, and its lock's release clears it (`persistence.md`). `Chats.svelte` keeps the streaming row mounted in every mode while it streams (rows are keyed by message id; `Chat.updateRow` passes the text in) and mounts it again when it ends, `off` parses it like any message, and `strong` renders that text raw, without markdown (`util/playwright/checkStreamingModes.mjs`). Whatever the mode, the chat module writes the streamed text into the mirror at most once per frame (`persistence.md`), so a streaming row parses once per frame, not once per chunk.

## Coupling

- `sendChat` imports `serverGeneration.ts` (and through it `serverCommands.ts`, the job channel) and the chat module.
- Callers: `DefaultChatScreen.svelte`, `command.ts` (`/send`, `/multisend`), `files/multisend.ts`, `hotkey.ts`, `DevTool.svelte` (preview, autopilot), `plugins/apiV3` (`sendChat` permission).

## Invariants

- `chatId` is the address of every message write. Never address a message by index after an await; resolve the id again.
- A send captures its target chat before any await and passes it to the job; the job's prompt and model presets and persona are the chat's binding, fixed at its creation (a plugin's `sendChat` inside a hook passes `pluginContext`, so the job acts on the hook's chat and preset). Nothing falls back to the tab's selection: a chat whose binding is incomplete is not sent, and the server refuses it independently (`docs/plan/chat-binding.md`).
- Every context builder takes its ids from the captured chat, never from the views: a job or chat request from `chatBinding(ref)` (`runPinnedServerJob`, `requestChatDataServer`), a render or plugin context from `chatDisplayIds(ref)` (`captureTransform`, `capturePluginContext`). The tab's chat LLM requests have the same guard (`requestChatData` before its hooks and tools, again at `requestChatDataMain`; a request inside a job callback is compared with the job's targets). A request without a chat is not a send: it carries no `chatRef`, is never refused by a binding, and runs on the settings views, read once before any await.
- The reply being generated is locked by its server job: the tab's writes to it are refused by the server and skipped by the chat module.
- Script modes (run by the server since the cutover):

  | Mode          | Stage                       |
  | ------------- | --------------------------- |
  | `editinput`   | user input                  |
  | `editprocess` | prompt history and greeting |
  | `editoutput`  | model output                |
  | `editdisplay` | render                      |

  Lua edit triggers skip `editprocess`. The `request` trigger runs on the server job's requests only; the tab's own requests (translation, suggestions, the HypaV3 modal, plugins) go out without it.

- A new `PromptItem` type needs handling in both template switches of the server's `assemblePrompt`, plus `tokenizePreset`, `templateCheck`, import conversion, `PromptDataItem.svelte`, and `normalizePromptTemplate` (`shared/presets.ts`).
- Lore matching (`shared/lore/activation.ts`):
  - Only the last `scanDepth` messages are scanned.
  - Keys starting with `/` are regex.
  - Supports selective secondary keys, negative keys, and all-key mode.
  - Recursion is controlled by `recursiveScanning` and `@@recursive`/`@@unrecursive`/`@@no_recursive_search`, with no explicit depth counter.
  - Decorators are parsed with `CCardLib.decorator.parse`.
- Inlays are not stored in chat text. Removing an inlay (`removeInlayAsset`, the Inlay Explorer) breaks the `{{inlay::id}}` tags that name it; deleting messages never removes inlays.
- Images become `MultiModal` input only when the model has `LLMFlags.hasImageInput`. Otherwise the job captions them (`captionImage`, `memory.md`).
- Built-in Jinja templates enforce role rules: Gemma has no system role, and Mistral requires alternating roles.
- A suggestion result is applied only while its request token and the captured character and chat ids still match (`Suggestion.svelte`), never by the old chat index.

## Recipes

- Add a prompt card type: `shared/prompt.ts` (`PromptItem`), both template switches in `server/src/prompt/assemble.ts`, `tokenizePreset`, `templateCheck`, `PromptDataItem.svelte`, `normalizePromptTemplate` (`shared/presets.ts`). Verify the prompt preview (DevTool), token counts, and a preset reload.
- Change input processing: `DefaultChatScreen.sendMain` and the job's input stage (`server/src/prompt/runner.ts`). Verify character and group chats and slash-command fallthrough.
- Add a response command or inlay: the job's tail (`server/src/prompt/postProcess.ts` `runInlayScreen`) and `files/inlays.ts` or the parser.
- Change lore activation: `shared/lore/activation.ts` (search, decorators, budget) and the position mapping in `assemblePrompt`.
- Add a slash command: `command.ts:processCommand`, plus its `?` help text.
- Change backend prompt serialization: `shared/prompt/chatTemplate.ts` or the server's request layer (`llm-requests.md`).

## Tests

- `src/ts/process/files/tests/inlays.test.ts`: over the fake resource server (`src/ts/storage/tests/fakeResourceServer.ts`) and an in-memory asset store, one fresh module per test: content-hash naming and de-duplicated uploads, the data-URI and Blob shapes with MIME reconstruction, signatures, the seeded, negative (with expiry), and in-flight caches, `invalidateInlayCaches` and the replacing `listInlayAssets`, the per-id write order, last-writer-wins after a conflict, 412 propagation, removal, `verifyInlay`, `repairInlayMedia`, `postInlayAsset` routing, the `writeInlayImage` size properties, and its `check` (a server job's cancelled callback): stopped before anything, after hashing (no upload), or after the upload (no metadata). Live updates (the "live updates" block): a notice dropping an older cached copy and keeping an equal or newer one, a deletion dropping it; a stale answer during a notice not cached and asked again; this tab's write during a listing never losing to the listing; a listing that began before a notice not putting that inlay back; `reconcileInlays` dropping removed and older entries; an invalidation during a read keeping its answer out of the cache.
- Adjacent: `ttsHooks.test.ts`.
- The chat module and the save loop's chat paths: `src/ts/storage/tests/chatStore.test.ts`, `resourceSyncChats.test.ts` (see `persistence.md`).
- A second tab's send during another tab's job (`chatGenerating`) and the job's chat announcements: `src/ts/storage/tests/resourceSyncNotices.test.ts` (see `persistence.md`); the refusal's cases in `serverCommands.test.ts` (`scripts-triggers.md`).
- `src/ts/process/command.test.ts`: `/cut`, `/del`, `/send`/`/sendas`/`/comment`, the variable commands, the captured target across an await and a deleted target, `/trigger`, and `/multisend`'s busy flag, over the real chat module and server store.
- `src/ts/process/rerollHistory.test.ts` (over the real chat module and server store; audit GEN-01, `docs/plan/audit-findings-perf.md` slice 2a): undo in chat B after a reroll in chat A leaves B's reply and ids alone while A's own undo still works; back and forward swap the stored bundles and persist; a bundle under another anchor starts a new slot (auto mode); a changed tail (a `/send` in between) or a deleted anchor drops the chat's history and writes nothing; group bundles of different lengths swapped whole; a bundle at the start of the chat (no anchor); `begin` keeping or restarting the slot; the 16-chat bound; `clear`. `src/ts/process/sendDraft.test.ts` (audit JOB-01): a job that failed before the append restores the text and keeps its id for the retry; a failure after the append or a `done` end drops the draft; a refusal keeps the same id through retries; a draft is not placed over typed text or into another chat and waits for an empty composer on its chat (`takeUnplaced`, once); a send in flight is never handed out; drafts are per chat. The screen's wiring of both modules was checked with the audit's browser reproductions.
- The send guard and the contexts: `src/ts/process/serverCommands.test.ts` (a refused job, the 409 codes), `src/ts/process/request/tests/{requestBindingGuard,requestPresetScope,transport}.test.ts`, `src/ts/plugins/apiV3/pluginContext.test.ts`, `src/ts/parser/tests/transformClient.test.ts`; the binding itself in `persistence.md`.
- A job's error alert: `serverCommands.test.ts` (`alertJobError` with the job id, the maintenance branch's receipt time), `src/ts/diagnostics/jobDebugInfo.test.ts` (the copied block: named, checked fields only, never the message). The alert's buttons and the popup's job filter are checked by hand.
- `src/ts/process/serverGeneration.test.ts`: `sendChatOnServer` over a stubbed `runServerJob`: the kind (`send` with the input and its user message id; `continue` with an explicit target or with input; `group` for a group chat; the previews without input, their `result` returned), the one per-send field before the job (`incrementStatic("messages")`; no character record is touched, the target's `lastInteraction` being the server job's to stamp, audit item A2), the selected chat without a target, a missing target or chat refused before anything is written, the signal and a plugin call's identity handed on, the outcome mapping (`refused` and `followed` definite, `unknown` ambiguous, an error or lost terminal neither, `done { stopped }` false), and a reply's `alternatives` registered under its generation but not a continue's. `src/ts/process/serverCommands.test.ts` covers `runServerJob` itself (`scripts-triggers.md`).
- `src/ts/process/request/tests/requestChat.test.ts` (over the real chat module): `withRequestChat` loading before `run`, pinning through it, and releasing after; refusals for an unlisted, failing, deleted, or replaced target; the guarded stream passing chunks, erroring after a replacement with its source cancelled, and releasing on end, cancel, and source error. `src/ts/process/request/tests/transport.test.ts` (the lazy-chat cases): an unloaded alternate `cbs` target loaded for its parse and a gone one failing the callback; a deletion or replacement during the flush posts nothing; a late MCP answer after a replacement fails once; a stream handed out errors at the next chunk after a replacement and the POST is aborted.
- The server side of a send (the input stage, the streamed reply, continue, abort, group, `presetChain`, the previews, the automatic translation hand-off and its `translating` notice) is `server/src/tests/promptRunner.test.ts`, and the assembled prompt's parity with the browser capture made before the cutover `server/src/tests/assemble.test.ts` (`self-host-server.md`).
- Browser checks (`util/playwright/`): `checkServerSend.mjs` (send, continue, abort, preview, reload mid-stream, and Stop after a reload mid-stream ending the resumed job with the text so far kept (audit JOB-02); it seeds a bound chat and opens it from the closed-chat screen; `--base` against the built app) and `checkStopDMatrix.mjs` (reroll, group, memory, an image button, two tabs, a restore during a send; `--base` too).
- Not tested: Jinja rendering in the tab; the component's own wiring of per-chat reroll history and send draft recovery (checked by hand in `util/playwright/checkServerSend.mjs` runs). The screen's Stop for a followed job is covered by the `checkServerSend.mjs` reload case; the registry itself by `serverCommands.test.ts` (`followedJobs`).

## Known Hazards

- Stop stays visible between a followed job's `done` and its socket close, when aborting the ended job does nothing. A boot resume that discovers its chat but cannot load it shows Stop during the load retries, until the follow ends as lost.
- `disable_ui_prompt` lore decorators are collected into `disabledUIPrompts`, but that array is never consumed.
- `prereroll.ts` history is in memory only; the per-chat history and drafts live in `DefaultChatScreen`'s module instances and a remount loses them. Send recovery restores no translation draft, and does not restore a draft whose job ended `done` (`ok`) after a script removed its user message.
- A whole-chat result (a plugin's `setChat`) is applied with last-writer semantics per message and field: a message another writer changed after the baseline keeps that change unless the result changed it too.
- `DevTool.svelte`'s autopilot sends each line as a job in the chat selected when it started; a group's speakers are chosen by the server (the browser path used the loop index).
- The PO import (`process/files/multisend.ts`) clears `doingChat` before awaiting `sendChat`, with no `finally`: a throw can leave the tab busy until something else resets the flag.
- The DevTool preview resets `doingChat` only on its success paths; a send, JSON parse, or render error before that leaves the preview and the tab busy.
- Group prompt assembly names a speaker it cannot resolve (`host.findCharacter`) `Unknown Character` in the group wrapper.
- Group lore activation takes the group as the character: its own `globalLore`, the chat's, and the modules'; the members' `globalLore` is not included, even with the group's `useCharacterLore`.
- Lore keys keep the inherited grammar: every key is split on commas before the `/pattern/flags` parse, so `/a{1,2}/` becomes two malformed keys; the last slash closes a pattern, and a bare or unclosed slash, an invalid flag, or a malformed later entry ends that key search instead of being skipped.
- `activateLore`'s `keepActivateAfterMatch` and `dontActivateAfterMatch` are function-wide, not per entry: once a decorator raises one, every later activated entry also gets the matching `__internal_ka_`/`__internal_da_` chat variable write.
- `exportLoreBook("local")` dereferences `selectedChat()` without waiting, so while the selected chat loads it alerts a `TypeError` instead of refusing; `exportLoreBook("sglobal")` takes the same path with no chat and also alerts an error instead of exporting.
