# Chat Pipeline: Send → Prompt → Request → Reply

## Scope

- Owns:
  - the send path from the input box to the stored reply,
  - prompt assembly (the prompt template, legacy formatting order, lorebook placement, example messages, author note, persona),
  - token trimming,
  - streaming writes into the chat,
  - post-processing,
  - group speaker selection,
  - reroll,
  - slash commands,
  - inlays,
  - Jinja/instruct chat templates.
- Paths:
  - `src/ts/process/index.svelte.ts`
  - `src/ts/process/{prompt,stringlize,group,exampleMessages,prereroll,command,infunctions,inlayScreen}.ts`
  - `src/ts/process/lorebook.svelte.ts`, `shared/lore/activation.ts`
  - `src/ts/process/templates/*`, `shared/prompt/{chatTemplate,templateCheck}.ts`
  - `src/ts/process/files/{inlays,multisend}.ts`
  - `src/ts/process/dynamicutils/pdf.ts`
  - `src/ts/process/embedding/addinfo.ts`
  - The send handlers in `src/lib/ChatScreens/DefaultChatScreen.svelte`
- Not here:
  - Memory algorithms → `memory.md`.
  - `requestChatData` internals → `llm-requests.md`.
  - Token counting (`shared/tokenizerChoice.ts`, `shared/prompt/chatTokens.ts`) → `llm-requests.md`.
  - Regex and trigger internals → `scripts-triggers.md`.
  - Rendering → `cbs-rendering.md`.
  - TTS and image generation → `media-aux.md`.

## Files

- `index.svelte.ts`: the core pipeline.
  - Exports `sendChat(chatProcessIndex, {signal, continue, preview, ...})`, `OpenAIChat` and `MultiModal` (declared in `shared/openai.ts`), `doingChat`, `chatProcessStage`, `abortChat`, `requestTokenPart`.
  - Internal: `runCurrentChatFunction`, `positionParser`, `resolvePosition`, `systemizeChat`, `runChatOutputListeners`.
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
- `exampleMessages.ts` `exampleMessage`: parses example dialogue into `OpenAIChat[]`.
- `prereroll.ts`: `Prereroll`, `PreUnreroll`, `addRerolls`. In-memory swipe history keyed by `generationId`.
- `command.ts` `processMultiCommand`: slash commands (`/send`, `/sendas`, `/cut`, `/del`, `/multisend`, `/trigger`, variables, TTS, `?` help). With `{ fromInput: true }` (the chat input) and `risu.serverGeneration` on, `/trigger` runs on the server (Phase 5 slice 8b, `scripts-triggers.md`).
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
- `embedding/addinfo.ts` `additionalInformations`: picks the top 3 `additionalText` paragraphs by embedding similarity.
- `dynamicutils/pdf.ts`: `convertPdfToImages`, `extractPdfText`. Not used by `sendChat`.

## Flows

Send, in `DefaultChatScreen.svelte`:

1. `send`/`sendContinue` → `sendMain`:
   1. Reject if `$doingChat`.
   2. `processMultiCommand`.
   3. Append queued `{{inlayed::id}}` tags.
   4. `runTrigger(...,'input')`.
   5. `processScript(...,'editinput')`.
   6. Append the user `Message` (`appendMessage`; the input trigger's changes to the messages are applied with `applyChatResult`).
   7. `sendChatMain`.
2. `sendChatMain` creates an `AbortController` and calls `sendChat(-1, {target, signal, continue})`, where `target` is the chat `sendMain` captured before the input trigger's awaits (commands and multisend capture theirs the same way).
3. `reroll`/`unReroll` refuse with the `chatGenerating` alert while the chat holds a lock (the last reply stays locked until its final write is acknowledged, after the send returned; the buttons are disabled meanwhile). They use `Prereroll`/`PreUnreroll` (`setMessageText`) and swap stored rerolls with `editChatSync`. If those have nothing, they remove the replies after the last user message (`editChatSync`) and call `sendChatMain` again.

`sendChat` in `index.svelte.ts`:

`sendChat` wraps `sendChatInner` with a `GenerationScope` and ends the scope's generation whatever happens (return, throw, abort).

1. Setup:
   1. Stages and abort.
   2. Optional random preset from `presetChain`.
   3. Capture the chat this send runs on as `chatTarget` (a `ChatRef`): `arg.target`, or the selected chat. Every later read (`chatNow`) and write resolves the chat and its messages by id, whatever is selected, reordered, or deleted meanwhile. The code the send calls gets it too: every `risuChatParser` call (`chatRef`: CBS chat variables, per-chat global-variable overrides, `#if` variable and toggle conditions, and chat/history, persona, and module macros read that chat), `processScript`/`processScriptFull` (regex scripts and their cache key, `@@inject`, `@@repeat_back`, Lua edit hooks), triggers (`runTrigger`'s `chatRef`: the CBS in their effects, their Lua, and their `v2Command` lines; display and request runs read it but never write it), `loadLoreBookV3Prompt`, the enabled modules (`getModules(chatRef)` and its lore, trigger, regex, asset, and toggle getters), the bound persona (`getUserName`, `getPersonaPrompt`, `additionalInformations`), the `editRequest` hook and the request trigger (`requestChatData`'s `chatRef`), and output listeners (indices resolved from it before each listener). Recursive sends (group speakers by `speakerChaId`, auto-continue with `continueMessageId`, trigger resends) pass it on. A send whose chat disappears while the provider answers stops before any output hook. The reply is appended with `chatId: generationId`; other messages get their ids from the chat module.
   4. A continue locks the message it extends (`continueMessageId`, or the chat's last message) at once, before any await; the finally of `sendChat` releases it on failure or abort.
2. Groups: `sendChat(-1)` computes `groupOrder`, then recursively calls `sendChat(index)` once per selected speaker.
3. `runCurrentChatFunction` runs CBS with `runVar: true` over the history and writes changed texts with `setMessageText` (the reply with its generation's capability). The prompt buckets are `main`, `jailbreak`, `chats`, `lorebook`, `globalNote`, `authorNote`, `lastChat`, `description`, `postEverything`, and `personaPrompt`.
4. Lore: `loadLoreBookV3Prompt` returns the active entries, placed by position:
   - default → `lorebook`,
   - `before_desc`/`after_desc`/personality/scenario → description,
   - depth 0 → `postEverything`,
   - `@@inject*` → `positionParser`,
   - `{{position::name}}` expands up to 5 passes.
5. First template pass: tokenize the `PromptItem`s. Then build the history:
   1. `exampleMessage`.
   2. `[Start a new chat]`, unless NovelAI or `trimStartNewChat`.
   3. The first greeting, run through `editprocess`.
   4. Messages, skipping `disabled`, converted to `OpenAIChat` and marked `removable`.
   5. Depth lore spliced in.
6. Memory: the first enabled of `hanuraiMemory` → `hypaMemoryV2` → `hypaMemoryV3` → `supaMemory` (see `memory.md`), each given a detached copy of the chat; the memory data they return is saved with `setChatMeta` (`hypaV2Data`, `hypaV3Data` incl. the error-summary path, `supaMemoryData`, `lastMemory`). Without memory, drop the oldest chats until under `maxContext`.
7. Final template pass:
   1. Materialize the cards in order.
   2. `systemizeChat` when `sendChatAsSystem`.
   3. Merge system messages for some providers.
   4. Cache points.
   5. `depth_prompt` and trigger-added prompts.
   6. `runLuaEditTrigger(...,'editRequest')`.
   7. Retokenize and blank `removable` entries until the prompt fits.
   8. Reduce `outputTokens` to fit.
8. `requestChatData(..., 'model', abortSignal)` returns `success | fail | streaming | multiline`.
9. Streaming:
   1. Append the reply `Message` (id = the generation id), or for continue use the message locked at the start and keep its id. `startGeneration` locks it (`beginGeneration`: the server fences the message for this generation) and sets `streamingState`.
   2. For each chunk: apply `processScriptFull(...,'editoutput')` and write the cumulative text with `setMessageText(..., { generationId })` on the 125 ms display coalescer. The chat module checkpoints the text every three seconds.
   3. Then: `runTrigger('output')` (applied with `applyChatResult` and the generation's capability), `runInlayScreen`, `runChatOutputListeners` (plugins), `generationInfo`, and `sayTTS` if `ttsAutoSpeech`. The generation ends (its final text queued; the lock stays until the server acknowledges it) before the send recurses and when it returns.
   4. Non-streaming replies: inlays run before the reply is appended; then the same tail. Extra `multiline` outputs become reroll alternatives.
   5. Abort or a read failure keeps the text reached (the final write carries it; the strong display mode's deferred `editoutput` runs only on a completed stream); a tab killed mid-stream keeps the last acknowledged checkpoint, plus the best-effort `pagehide` request (see `persistence.md`).
10. Tail:
    - Trigger `sendAIprompt` can recurse into a resend. Short or incomplete replies can auto-continue.
    - Emotion/IGP or image generation (`viewScreen === 'imggen'` → `stableDiff`), notifications.

Not in `sendChat`:

- Input auto-translation happens in `DefaultChatScreen.updateInputTransateMessage`.
- Display translation happens in `ChatBody.svelte`.
- Suggestions come from `Suggestion.svelte`, which calls `requestChatData` directly.

## State

- `OpenAIChat` has `role`, `content`, `memo`, `removable`, `attr`, `multimodals`, `thoughts`, and `cachePoint`.
  - `memo` values `supaMemory`/`hypaMemory` mark memory cards.
- `PromptItem` types: `plain|jailbreak|cot`, `chatML`, typed `persona|description|lorebook|postEverything|memory`, `authornote`, `chat` (with a range), and `cache`.
- Reactive singletons: `DBState.db`, `selectedCharID`, `doingChat`, `chatProcessStage`, `CharEmotion`.
- The pipeline never mutates the chat in place: `chats` are read-only mirror fields, and every write goes through `src/ts/storage/chatStore.svelte.ts` (see `persistence.md`), addressed by chat and message id. Autosave does not see chats.
- Streaming display: `streamingState` (`chatStore.svelte.ts`: `chaId`, `chatId`, `messageId`, `mode`) drives `Chats.svelte`; `Chat.svelte` disables the controls of a message `isMessageLocked` reports.

## Coupling

- Imports: tokenizer, parser (`risuChatParser`), `lorebook`, `scripts`, `triggers`, memory, `request`, `tts`, `stableDiff`, inlays, modules, plugins, model info.
- Callers: `DefaultChatScreen.svelte`, `command.ts` (`/send`, `/multisend`), `DevTool.svelte` (preview), `plugins/apiV3` (`sendChat` permission).

## Invariants

- `chatId` is the identity used to relocate a reply after triggers and inlays run, and the address of every message write. Never address a message by index after an await; resolve the id again.
- Triggers run on a copy (`runTrigger` clones the chat; a display or request run copies only the chat and its message list and replaces messages instead of editing them). The caller captures a baseline before and applies the returned chat with `applyChatResult`. Lua outside triggers (edit hooks, buttons) writes the live chat through the module, resolving an index to an id when called.
- The send captures its plugin call context (`capturePluginContext(chatTarget)`: the chat, the selected preset, the effective persona) right after it resolves `chatTarget`, or takes the one it was given (`SendChatArg.pluginContext`, for a plugin's `sendChat` inside a hook), and passes it to every `processScript`/`processScriptFull` call, to the main, image-prompt, and emotion `requestChatData` calls, to `runChatOutputListeners` (which calls each listener through `invokeHook`), and to the group, auto-continue, and resend recursions. A plugin hook then acts on the sending chat and preset even after the user switched character or preset mid-send (`plugins-mcp.md`). A new hook call site passes the context too.
- The reply being generated is locked: only writes carrying its generation id change it. Other writers (UI, triggers, commands) skip it or get an error from the module.
- Script modes are distinct:

  | Mode          | Stage                       |
  | ------------- | --------------------------- |
  | `editinput`   | user input                  |
  | `editprocess` | prompt history and greeting |
  | `editoutput`  | model output                |
  | `editdisplay` | render                      |

  Lua edit triggers skip `editprocess`. Request triggers run inside `requestChatData`.

- A new `PromptItem` type needs handling in both template switches in `sendChat`, plus `tokenizePreset`, `templateCheck`, import conversion, `PromptDataItem.svelte`, and `normalizePromptTemplate` (`shared/presets.ts`).
- `formatingOrder` is the legacy fallback. `postEverything` is auto-appended when missing.
- Trimming happens in layers: the lore token budget, then memory or oldest-first dropping, then a final `removable`-only blanking. Custom Lua `editRequest` edits happen before the final recount.
- Lore matching:
  - Only the last `scanDepth` messages are scanned.
  - Keys starting with `/` are regex.
  - Supports selective secondary keys, negative keys, and all-key mode.
  - Recursion is controlled by `recursiveScanning` and `@@recursive`/`@@unrecursive`/`@@no_recursive_search`, with no explicit depth counter.
  - Decorators are parsed with `CCardLib.decorator.parse`.
- Inlays are not stored in chat text. Removing an inlay (`removeInlayAsset`, the Inlay Explorer) breaks the `{{inlay::id}}` tags that name it; deleting messages never removes inlays.
- Images become `MultiModal` input only when the model has `LLMFlags.hasImageInput`. Otherwise `runImageEmbedding` generates a caption instead.
- Built-in Jinja templates enforce role rules: Gemma has no system role, and Mistral requires alternating roles.

## Recipes

- Add a prompt card type: `shared/prompt.ts` (`PromptItem`), both `sendChat` switches, `tokenizePreset`, `templateCheck`, `PromptDataItem.svelte`, `normalizePromptTemplate` (`shared/presets.ts`). Verify the prompt preview (DevTool), token counts, and a preset reload.
- Change input processing: `DefaultChatScreen.sendMain`, plus `scripts.ts` or `triggers.ts` input handling. Verify character and group chats and slash-command fallthrough.
- Add a response command or inlay: `inlayScreen.ts:runInlayScreen`, both the streaming and non-streaming branches in `sendChat`, and `files/inlays.ts` or the parser.
- Change lore activation: `lorebook.svelte.ts` (search, decorators, budget) and the position mapping in `sendChat`.
- Add a slash command: `command.ts:processCommand`, plus its `?` help text.
- Change backend prompt serialization: `templates/chatTemplate.ts` or `stringlize.ts`, plus the matching `request.ts` branch.

## Tests

- `src/ts/process/files/tests/inlays.test.ts`: over the fake resource server (`src/ts/storage/tests/fakeResourceServer.ts`) and an in-memory asset store, one fresh module per test: content-hash naming and de-duplicated uploads, the data-URI and Blob shapes with MIME reconstruction, signatures, the seeded, negative (with expiry), and in-flight caches, `invalidateInlayCaches` and the replacing `listInlayAssets`, the per-id write order, last-writer-wins after a conflict, 412 propagation, removal, `verifyInlay`, `repairInlayMedia`, `postInlayAsset` routing, the `writeInlayImage` size properties, and its `check` (a server job's cancelled callback): stopped before anything, after hashing (no upload), or after the upload (no metadata).
- Adjacent: `scriptings.test.ts`, `request/openAI/requests.responses.test.ts`, `ttsHooks.test.ts`.
- The chat module and the save loop's chat paths: `src/ts/storage/tests/chatStore.test.ts`, `resourceSyncChats.test.ts` (see `persistence.md`).
- `src/ts/process/command.test.ts`: `/cut`, `/del`, `/send`/`/sendas`/`/comment`, the variable commands, the captured target across an await and a deleted target, `/trigger`, and `/multisend`'s busy flag, over the real chat module and server store.
- Not tested: `sendChat` assembly and trimming, lore activation, group order, `runInlayScreen`, Jinja rendering, reroll.

## Known Hazards

- `disable_ui_prompt` lore decorators are collected into `disabledUIPrompts`, but that array is never consumed.
- `prereroll.ts` history is in memory only, and `DefaultChatScreen` keeps a second reroll array of its own.
- A whole-chat result (trigger, plugin) is applied with last-writer semantics per message and field: a message another writer changed after the baseline keeps that change unless the result changed it too.
