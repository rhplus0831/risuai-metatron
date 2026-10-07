# Chat Pipeline: Send → Prompt → Request → Reply

## Scope

- Owns:
  - the tab's side of a send since the Phase 5 cutover: the input box to the server job (`sendChat` is the job client) and the reply as the job's events and records bring it,
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

- `index.svelte.ts`: the send's job client (Phase 5 cutover; the browser assembly path was removed).
  - Exports `sendChat(chatProcessIndex, arg)` (`arg`: `serverGeneration.ts` `ServerSendArg` plus `onServerRefused`; `chatProcessIndex` is kept for the plugin API's signature and not read), `doingChat` (the tab's busy flag: set by `sendChat`, cleared by its callers), `previewFormated`/`previewBody` (a preview's result), and the `OpenAIChat`/`MultiModal` types (declared in `shared/openai.ts`).
- `serverGeneration.ts` `sendChatOnServer(arg)`: the send as a server job (below).
- `prompt.ts`: `tokenizePreset` and legacy-preset conversion; re-exports the prompt types declared in `shared/prompt.ts`.
  - Types: `PromptItem` (discriminated union), `PromptSettings`, `PromptRole`.
  - `tokenizePreset`.
  - Legacy import: `detectPromptJSONType`, `stChatConvert`, `promptConvertion`.
- `shared/lore/activation.ts` `activateLore(input, host)`: lore activation, shared with the server (Phase 5). It merges three sources: character `globalLore`, chat `localLore`, and the module lore the caller resolved; matches keys, regex keys (`/pattern/flags`: the last `/` ends the pattern, empty flags allowed), and decorators over the scanned messages; recurses; applies the token budget and `@@inject_lore`; and returns `{ actives, matchLog }`. `LoreHost` supplies the clone, the speaker names, the chat variables (the keep and don't-activate-after-match flags), CBS, the token count, and the regex test (on the server, the script worker's).
- `lorebook.svelte.ts`: the client wrapper of lore activation and the lorebook codecs.
  - `loadLoreBookV3Prompt(chatRef?)` runs `activateLore` for the chat with `getModuleLorebooks(ref)`, `loreBookDepth`, `loreBookToken`, and `getUserName(ref)` (the bound persona's name), and the client host.
  - Also `addLorebook`, `addLorebookFolder`, `importLoreBook`, `exportLoreBook`, `convertExternalLorebook`.
- `shared/prompt/chatTemplate.ts`: `renderChatTemplate(messages, { type, jinjaTemplate, characterName, userName })` (Hugging Face Jinja), `chatTemplates` (built-in Llama/Gemma/Mistral/...), `templateEffect`. `templates/chatTemplate.ts` re-exports `chatTemplates` and `templateEffect` (not `renderChatTemplate`), and its `applyChatTemplate(messages, { type?, custom? })` supplies the selected preset's `instructChatTemplate`/`JinjaTemplate`, the selected character, and the user's name.
- `templates/templates.ts`: re-exports `prebuiltPresets` and `prebuiltNAIpresets` from `shared/presetTemplates.ts` (templates carry no id; a use goes through `normalizePreset`).
- `shared/prompt/templateCheck.ts` `templateCheck({ promptTemplate })`: prompt-template warnings (`templates/templateCheck.ts` re-exports it).
- `templates/jsonSchema.ts`: `convertInterfaceToSchema`, `getOpenAIJSONSchema`, `extractJSON`.
- `stringlize.ts`: serializers for non-chat-completion backends and stop strings.
  - `stringlizeChat`, `stringlizeAINChat`, `unstringlizeChat`, `getStopStrings`.
  - `stringlizeChatOba` is unreferenced. `multiChatReplacer` is empty.
- `group.ts`: `groupOrder` (name mentions, then shuffle and talkativeness), `addGroupChar`, `rmCharFromGroup`.
- `prereroll.ts`: `Prereroll`, `PreUnreroll`, `addRerolls`. In-memory swipe history keyed by `generationId`.
- `command.ts` `processMultiCommand(line, ref?)`: the chat input's slash commands (`/send`, `/sendas`, `/cut`, `/del`, `/multisend`, `/trigger`, variables, TTS, `?` help). `/trigger` runs on the server (`runServerManualTrigger`, Phase 5 slice 8b, `scripts-triggers.md`); a trigger's `v2Command` runs the server's command executor.
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
   1. Reject if `$doingChat`.
   2. `processMultiCommand`.
   3. Append queued `{{inlayed::id}}` tags.
   4. A nonempty input becomes the job's input with a new `userMessageId` (the job runs the input trigger, `editinput`, and appends the user message); an empty input appends "_says nothing_" when `useSayNothing` is on and the last message is not the user's (a continue from an empty input does it too).
   5. `sendChatMain`.
2. `sendChatMain` creates an `AbortController` and calls `sendChat(-1, {target, signal, continue, input, userMessageId})`, where `target` is the chat `sendMain` captured before any await (commands and multisend capture theirs the same way). A send the server refused before creating the job puts the input back in the box; after an unknown send (the create request got no answer) `sendMain` keeps the text's `userMessageId` for that chat and sends the same text again under it, which the job skips if it already appended it. The reroll bundle starts after the user message.
3. `reroll`/`unReroll` refuse with the `chatGenerating` alert while the chat holds a lock (the reply stays locked until the job's last write lands; the buttons are disabled meanwhile). They use `Prereroll`/`PreUnreroll` (`setMessageText`) and swap stored rerolls with `editChatSync`. If those have nothing, they remove the replies after the last user message (`editChatSync`) and call `sendChatMain` again.

`sendChat` in `index.svelte.ts` (Phase 5 slice 9; the only path since the cutover): the `doingChat` guard and the deleted-target check, then `serverGeneration.ts` `sendChatOnServer`, which writes `statics.messages` (`incrementStatic`) and the target's `lastInteraction`, and calls `serverCommands.ts` `runServerJob` (the ids and the client environment taken before the first await, `flushResources()` with a refusal on a rejection or a discarded change (a `GenerationBlockedError`, the chat or character waiting for another tab's job, alerts `chatGenerating` unless the adapter's conflict recovery has just shown it), the job posted as `preview`, `previewPrompt`, `group` for a group chat, `continue`, or `send` with `input`, `userMessageId`, and an explicit `continueMessageId`, an abort of `arg.signal` sent as `DELETE` also while the job is created, and the job followed to its end through `followJobToEnd`). `runServerJob` takes a plugin call's preset and effective persona from `arg.pluginContext`; a busy job of this tab is followed (and aborted with the signal) but does not count as this send; a create request without an answer is `unknown` (the job may exist). `sendChat` returns false for a refused, followed, or unknown send and for a `done` with `stopped`; `onServerRefused(ambiguous)` puts the input back. A preview's `done.result` becomes `previewFormated` or `previewBody`; a reply's `done.alternatives` go to `addRerolls` under its generation (none for a continue). The job's `preset` event switches the tab's selection once per job (`generationJobs.ts` `applyGenerationEvent`).

The job (`self-host-server.md` `runPromptJob`, `assemblePrompt`) runs the input stage, `presetChain`, the group order (one reply per active member), lore, memory, the prompt assembly and trimming, the request, and the tail on the server: `editoutput` once on the completed reply (not per chunk), the output trigger, inlays, the `chatOutput` listeners (a callback to the tab; each listener gets a fresh copy of the character and chat), TTS and notification as notices, auto-continue and a trigger's resend as rounds of the same job (at most 8 extra), `igp` on the last reply only, the emotion modes on the server with an `emotion` notice (the tab sends the emotions it showed last with the job), and the image view as an `imggen` callback. A plugin provider model answers through a `provider` callback to the tab (slice 11b); remembered tool calls are read from and written to `chat.toolCalls`; a `/multisend` of a server command job is sent by the tab after the job (`done.followUps`, `runMultisend`). The tab shows the streamed reply from the job's `chunk` events (`applyServerGeneration`, raw while the message is locked) and the stored copies from its `resource` events.

Not in `sendChat`:

- Input auto-translation happens in `DefaultChatScreen.updateInputTransateMessage`.
- Display translation happens in `ChatBody.svelte`.
- Suggestions come from `Suggestion.svelte`, which calls `requestChatData` directly.

## State

- `OpenAIChat` has `role`, `content`, `memo`, `removable`, `attr`, `multimodals`, `thoughts`, and `cachePoint`.
  - `memo` values `supaMemory`/`hypaMemory` mark memory cards.
- `PromptItem` types: `plain|jailbreak|cot`, `chatML`, typed `persona|description|lorebook|postEverything|memory`, `authornote`, `chat` (with a range), and `cache`.
- Reactive singletons: the records (through `settingsViews.svelte.ts` and `characterStore.svelte.ts`), `selection`, `doingChat`, `CharEmotion`.
- The tab never mutates the chat in place: the chats are held by `src/ts/storage/chatStore.svelte.ts` (Phase 6 slice 9a; the screen reads `selectedChat()` and the lists `chatList()`), and every write goes through it (see `persistence.md`), addressed by chat and message id. Autosave does not see chats.
- Chats load on demand (slice 9b). The chat screen renders nothing chat-dependent while the selected chat loads (`selectedChatLoad()`: a loading state, or the error with a retry). A server job's target chat is pinned and loaded before the job is created (`runServerJob`; `followJobToEnd` for a resumed or followed job, through every reconnect and the terminal's hydration; a command job's `/multisend` follow-ups), and a send's chat stays pinned until `sendChatOnServer` has read the reply's alternatives; a target that cannot be loaded runs nothing. A typed command line (`processMultiCommand`), an auxiliary LLM request (`requestServer`: its chat and its parse chat, until its event stream ends), `editChat`, and a group output listener's speaker (`chatOutput`: its chats, before each listener) pin and load what they read. The synchronous chat readers (`chatVar`, `getModules(ref)`, the CBS host, `transformClient`'s context, the MCP tool records) read loaded chats only; their chat is the selected one, a pinned job or request target, or a plugin context that awaited its load, and an unloaded chat reads as gone, never as another chat. The bound persona (`checkPersonaBinded`, `capturePluginContext`) is read from the chat's list entry, so it holds while the chat is not loaded.
- Streaming display: a server job's message is locked while it streams (`isMessageLocked`); `Chat.svelte` disables its controls and renders it without the server transform until the lock ends. The display optimization (`streamingDisplayOptimizationMode`) follows the stream: `applyServerGeneration` sets `streamingState` on the generation's first stream update with the configured mode, and its lock's release clears it (`persistence.md`). `Chats.svelte` keeps the streaming row mounted under `balanced` and `strong` (its hash leaves out the text, which `updateStreamingDisplay` passes in), and `strong` renders that text raw, without markdown (Phase 6 slice 3; `util/playwright/checkStreamingModes.mjs`).

## Coupling

- `sendChat` imports `serverGeneration.ts` (and through it `serverCommands.ts`, the job channel) and the chat module.
- Callers: `DefaultChatScreen.svelte`, `command.ts` (`/send`, `/multisend`), `files/multisend.ts`, `hotkey.ts`, `DevTool.svelte` (preview, autopilot), `plugins/apiV3` (`sendChat` permission).

## Invariants

- `chatId` is the address of every message write. Never address a message by index after an await; resolve the id again.
- A send captures its target chat before any await and passes it to the job; the job's preset and effective persona are fixed at its creation (a plugin's `sendChat` inside a hook passes `pluginContext`, so the job acts on the hook's chat and preset).
- The reply being generated is locked by its server job: the tab's writes to it are refused by the server and skipped by the chat module.
- Script modes (run by the server since the cutover):

  | Mode          | Stage                       |
  | ------------- | --------------------------- |
  | `editinput`   | user input                  |
  | `editprocess` | prompt history and greeting |
  | `editoutput`  | model output                |
  | `editdisplay` | render                      |

  Lua edit triggers skip `editprocess`. The `request` trigger runs on the server job's requests only; the tab's own requests (translation, suggestions, the HypaV3 modal, plugins) go out without it (Phase 5 cutover).

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

## Recipes

- Add a prompt card type: `shared/prompt.ts` (`PromptItem`), both template switches in `server/src/prompt/assemble.ts`, `tokenizePreset`, `templateCheck`, `PromptDataItem.svelte`, `normalizePromptTemplate` (`shared/presets.ts`). Verify the prompt preview (DevTool), token counts, and a preset reload.
- Change input processing: `DefaultChatScreen.sendMain` and the job's input stage (`server/src/prompt/runner.ts`). Verify character and group chats and slash-command fallthrough.
- Add a response command or inlay: the job's tail (`server/src/prompt/postProcess.ts` `runInlayScreen`) and `files/inlays.ts` or the parser.
- Change lore activation: `shared/lore/activation.ts` (search, decorators, budget) and the position mapping in `assemblePrompt`.
- Add a slash command: `command.ts:processCommand`, plus its `?` help text.
- Change backend prompt serialization: `shared/prompt/chatTemplate.ts` or the server's request layer (`llm-requests.md`).

## Tests

- `src/ts/process/files/tests/inlays.test.ts`: over the fake resource server (`src/ts/storage/tests/fakeResourceServer.ts`) and an in-memory asset store, one fresh module per test: content-hash naming and de-duplicated uploads, the data-URI and Blob shapes with MIME reconstruction, signatures, the seeded, negative (with expiry), and in-flight caches, `invalidateInlayCaches` and the replacing `listInlayAssets`, the per-id write order, last-writer-wins after a conflict, 412 propagation, removal, `verifyInlay`, `repairInlayMedia`, `postInlayAsset` routing, the `writeInlayImage` size properties, and its `check` (a server job's cancelled callback): stopped before anything, after hashing (no upload), or after the upload (no metadata). Phase 6 live updates ("live updates" block): a notice dropping an older cached copy and keeping an equal or newer one, a deletion dropping it; a stale answer during a notice not cached and asked again; this tab's write during a listing never losing to the listing; a listing that began before a notice not putting that inlay back; `reconcileInlays` dropping removed and older entries; an invalidation during a read keeping its answer out of the cache.
- Adjacent: `ttsHooks.test.ts`.
- The chat module and the save loop's chat paths: `src/ts/storage/tests/chatStore.test.ts`, `resourceSyncChats.test.ts` (see `persistence.md`).
- A second tab's send during another tab's job (`chatGenerating`, Phase 5 Stop D fixes) and the job's chat announcements: `src/ts/storage/tests/resourceSyncNotices.test.ts` (see `persistence.md`); the refusal's cases in `serverCommands.test.ts` (`scripts-triggers.md`).
- `src/ts/process/command.test.ts`: `/cut`, `/del`, `/send`/`/sendas`/`/comment`, the variable commands, the captured target across an await and a deleted target, `/trigger`, and `/multisend`'s busy flag, over the real chat module and server store.
- `src/ts/process/serverGeneration.test.ts` (Phase 5 slice 9): `sendChatOnServer` over a stubbed `runServerJob`: the kind (`send` with the input and its user message id; `continue` with an explicit target or with input; `group` for a group chat; the previews without input, their `result` returned), the per-send fields before the job (`incrementStatic("messages")`, the target's `lastInteraction` marked dirty at its index), the selected chat without a target, a missing target or chat refused before anything is written, the signal and a plugin call's identity handed on, the outcome mapping (`refused` and `followed` definite, `unknown` ambiguous, an error or lost terminal neither, `done { stopped }` false), and a reply's `alternatives` registered under its generation but not a continue's. `src/ts/process/serverCommands.test.ts` covers `runServerJob` itself (`scripts-triggers.md`).
- `src/ts/process/request/tests/requestChat.test.ts` (Phase 6 slice 9b, over the real chat module): `withRequestChat` loading before `run`, pinning through it, and releasing after; refusals for an unlisted, failing, deleted, or replaced target; the guarded stream passing chunks, erroring after a replacement with its source cancelled, and releasing on end, cancel, and source error. `src/ts/process/request/tests/transport.test.ts` (slice 9b cases): an unloaded alternate `cbs` target loaded for its parse and a gone one failing the callback; a deletion or replacement during the flush posts nothing; a late MCP answer after a replacement fails once; a stream handed out errors at the next chunk after a replacement and the POST is aborted.
- The server side of a send (the input stage, the streamed reply, continue, abort, group, `presetChain`, the previews) is `server/src/tests/promptRunner.test.ts`, and the assembled prompt's parity with the browser capture made before the cutover `server/src/tests/assemble.test.ts` (`self-host-server.md`).
- Browser checks (`util/playwright/`): `checkServerSend.mjs` (send, continue, abort, preview, reload mid-stream; `--base` against the built app) and `checkStopDMatrix.mjs` (reroll, group, memory, an image button, two tabs, a restore during a send; `--base` too).
- Not tested: reroll's swap logic, Jinja rendering in the tab; `sendMain`'s per-chat pending `userMessageId` map after an ambiguous send (component logic; checked by hand in `util/playwright/checkServerSend.mjs` runs).

## Known Hazards

- `disable_ui_prompt` lore decorators are collected into `disabledUIPrompts`, but that array is never consumed.
- `prereroll.ts` history is in memory only, and `DefaultChatScreen` keeps a second reroll array of its own.
- A whole-chat result (a plugin's `setChat`) is applied with last-writer semantics per message and field: a message another writer changed after the baseline keeps that change unless the result changed it too.
- `DevTool.svelte`'s autopilot sends each line as a job in the chat selected when it started; a group's speakers are chosen by the server (the browser path used the loop index).
