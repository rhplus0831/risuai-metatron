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
  - `src/ts/process/lorebook.svelte.ts`
  - `src/ts/process/templates/*`
  - `src/ts/process/files/{inlays,multisend}.ts`
  - `src/ts/process/dynamicutils/pdf.ts`
  - `src/ts/process/embedding/addinfo.ts`
  - The send handlers in `src/lib/ChatScreens/DefaultChatScreen.svelte`
- Not here:
  - Memory algorithms → `memory.md`.
  - `requestChatData` internals → `llm-requests.md`.
  - Regex and trigger internals → `scripts-triggers.md`.
  - Rendering → `cbs-rendering.md`.
  - TTS and image generation → `media-aux.md`.

## Files

- `index.svelte.ts`: the core pipeline.
  - Exports `sendChat(chatProcessIndex, {signal, continue, preview, ...})`, `OpenAIChat`, `MultiModal`, `doingChat`, `chatProcessStage`, `abortChat`, `requestTokenPart`.
  - Internal: `runCurrentChatFunction`, `positionParser`, `resolvePosition`, `systemizeChat`, `runChatOutputListeners`.
- `prompt.ts`: prompt types and legacy-preset conversion.
  - Types: `PromptItem` (discriminated union), `PromptSettings`, `PromptRole`.
  - `tokenizePreset`.
  - Legacy import: `detectPromptJSONType`, `stChatConvert`, `promptConvertion`.
- `lorebook.svelte.ts`: lore activation and the lorebook codecs.
  - `loadLoreBookV3Prompt` merges three sources: character `globalLore`, chat `localLore`, and `getModuleLorebooks()`.
  - Also `addLorebook`, `addLorebookFolder`, `importLoreBook`, `exportLoreBook`, `convertExternalLorebook`.
- `templates/chatTemplate.ts`: `applyChatTemplate` (Hugging Face Jinja), `chatTemplates` (built-in Llama/Gemma/Mistral/...), `templateEffect`.
- `templates/templates.ts`: `prebuiltPresets`, `prebuiltNAIpresets`.
- `templates/templateCheck.ts` `templateCheck`: prompt-template warnings.
- `templates/jsonSchema.ts`: `convertInterfaceToSchema`, `getOpenAIJSONSchema`, `extractJSON`.
- `stringlize.ts`: serializers for non-chat-completion backends and stop strings.
  - `stringlizeChat`, `stringlizeAINChat`, `unstringlizeChat`, `getStopStrings`.
  - `stringlizeChatOba` is unreferenced. `multiChatReplacer` is empty.
- `group.ts`: `groupOrder` (name mentions, then shuffle and talkativeness), `addGroupChar`, `rmCharFromGroup`.
- `exampleMessages.ts` `exampleMessage`: parses example dialogue into `OpenAIChat[]`.
- `prereroll.ts`: `Prereroll`, `PreUnreroll`, `addRerolls`. In-memory swipe history keyed by `generationId`.
- `command.ts` `processMultiCommand`: slash commands (`/send`, `/sendas`, `/cut`, `/del`, `/multisend`, `/trigger`, variables, TTS, `?` help).
  - Pipes are `|`.
  - Unknown commands return `false` and fall through as ordinary text.
- `infunctions.ts` `calcString`: calculator for the CBS calc function.
- `inlayScreen.ts`:
  - `runInlayScreen`: turns image/emotion commands in the output into `{{inlay::id}}` via `generateAIImage(..., 'inlay')` and `writeInlayImage`.
  - `updateInlayScreen`.
- `files/inlays.ts`: the LocalForage `inlay` store.
  - `writeInlayImage`: normalizes to PNG and caps the size at 1024² pixels.
  - `postInlayAsset`, `getInlayAsset` (base64), `getInlayAssetBlob` (migrates to Blob), `listInlayAssets`, `removeInlayAsset`.
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
   6. Push the user `Message`.
   7. `sendChatMain`.
2. `sendChatMain` creates an `AbortController` and calls `sendChat(-1, {signal, continue})`.
3. `reroll`/`unReroll` use `Prereroll`/`PreUnreroll`. If those have nothing, they remove the last reply and call `sendChatMain` again.

`sendChat` in `index.svelte.ts`:

1. Setup:
   1. Stages and abort.
   2. Optional random preset from `presetChain`.
   3. Resolve `selectedCharID` and `chatPage`.
   4. Assign missing `chatId`s.
2. Groups: `sendChat(-1)` computes `groupOrder`, then recursively calls `sendChat(index)` once per selected speaker.
3. `runCurrentChatFunction` runs CBS with `runVar: true` over the history. The prompt buckets are `main`, `jailbreak`, `chats`, `lorebook`, `globalNote`, `authorNote`, `lastChat`, `description`, `postEverything`, and `personaPrompt`.
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
6. Memory: the first enabled of `hanuraiMemory` → `hypaMemoryV2` → `hypaMemoryV3` → `supaMemory` (see `memory.md`). Without memory, drop the oldest chats until under `maxContext`.
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
   1. Create or reuse the reply `Message` and set `Chat.isStreaming`.
   2. For each chunk: apply `processScriptFull(...,'editoutput')` and write the cumulative text to `message.data`.
   3. Then: `runTrigger('output')`, `runInlayScreen`, `runChatOutputListeners` (plugins), and `sayTTS` if `ttsAutoSpeech`.
   4. Non-streaming replies take the same path. Extra `multiline` outputs become reroll alternatives.
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
- The pipeline mutates `DBState.db.characters[i].chats[j]` in place and relies on autosave.

## Coupling

- Imports: tokenizer, parser (`risuChatParser`), `lorebook`, `scripts`, `triggers`, memory, `request`, `tts`, `stableDiff`, inlays, modules, plugins, model info.
- Callers: `DefaultChatScreen.svelte`, `command.ts` (`/send`, `/multisend`), `DevTool.svelte` (preview), `plugins/apiV3` (`sendChat` permission).

## Invariants

- `chatId` is the identity used to relocate a reply after triggers and inlays run. Never replace message arrays without preserving `chatId`.
- Script modes are distinct:

  | Mode          | Stage                       |
  | ------------- | --------------------------- |
  | `editinput`   | user input                  |
  | `editprocess` | prompt history and greeting |
  | `editoutput`  | model output                |
  | `editdisplay` | render                      |

  Lua edit triggers skip `editprocess`. Request triggers run inside `requestChatData`.

- A new `PromptItem` type needs handling in both template switches in `sendChat`, plus `tokenizePreset`, `templateCheck`, import conversion, `PromptDataItem.svelte`, and `normalizePromptTemplate`.
- `formatingOrder` is the legacy fallback. `postEverything` is auto-appended when missing.
- Trimming happens in layers: the lore token budget, then memory or oldest-first dropping, then a final `removable`-only blanking. Custom Lua `editRequest` edits happen before the final recount.
- Lore matching:
  - Only the last `scanDepth` messages are scanned.
  - Keys starting with `/` are regex.
  - Supports selective secondary keys, negative keys, and all-key mode.
  - Recursion is controlled by `recursiveScanning` and `@@recursive`/`@@unrecursive`/`@@no_recursive_search`, with no explicit depth counter.
  - Decorators are parsed with `CCardLib.decorator.parse`.
- Inlays are not stored in chat text. Deleting LocalForage `inlay` entries breaks the `{{inlay::id}}` tags.
- Images become `MultiModal` input only when the model has `LLMFlags.hasImageInput`. Otherwise `runImageEmbedding` generates a caption instead.
- Built-in Jinja templates enforce role rules: Gemma has no system role, and Mistral requires alternating roles.

## Recipes

- Add a prompt card type: `prompt.ts` (`PromptItem`), both `sendChat` switches, `tokenizePreset`, `templateCheck`, `PromptDataItem.svelte`, `normalizePromptTemplate`. Verify the prompt preview (DevTool), token counts, and a preset reload.
- Change input processing: `DefaultChatScreen.sendMain`, plus `scripts.ts` or `triggers.ts` input handling. Verify character and group chats and slash-command fallthrough.
- Add a response command or inlay: `inlayScreen.ts:runInlayScreen`, both the streaming and non-streaming branches in `sendChat`, and `files/inlays.ts` or the parser.
- Change lore activation: `lorebook.svelte.ts` (search, decorators, budget) and the position mapping in `sendChat`.
- Add a slash command: `command.ts:processCommand`, plus its `?` help text.
- Change backend prompt serialization: `templates/chatTemplate.ts` or `stringlize.ts`, plus the matching `request.ts` branch.

## Tests

- `src/ts/process/files/tests/inlays.test.ts`.
- Adjacent: `scriptings.test.ts`, `request/openAI/requests.responses.test.ts`, `ttsHooks.test.ts`.
- Not tested: `sendChat` assembly and trimming, lore activation, group order, commands, multisend, `runInlayScreen`, Jinja rendering, reroll.

## Known Hazards

- `disable_ui_prompt` lore decorators are collected into `disabledUIPrompts`, but that array is never consumed.
- `prereroll.ts` history is in memory only, and `DefaultChatScreen` keeps a second reroll array of its own.
