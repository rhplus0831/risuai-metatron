# Media and Auxiliary Features: TTS, Image Generation, Translation, Playground

## Scope

- Owns:
  - text-to-speech providers and plugin TTS hooks,
  - AI image generation backends,
  - translation (providers, HTML translation, caches, presets, `edittrans` regex),
  - image type detection and compression,
  - the aux-model selector UI,
  - the playground tool screens,
  - legacy 3D and voice files.
- Paths:
  - `src/ts/process/{tts,ttsHooks,stableDiff}.ts`
  - `src/ts/translator/*`
  - `src/ts/media/*`
  - `src/ts/voice.ts` (unused)
  - `src/ts/3d/*` (unused)
  - `src/lib/UI/3DLoader.svelte` (unused)
  - `src/lib/Playground/*`, except `PlaygroundMenu` (→ `ui-theming.md`), `PlaygroundEmbedding` (→ `memory.md`), `PlaygroundMCP` (→ `plugins-mcp.md`), and `PlaygroundRegex`/`Syntax`/`Parser` (→ `scripts-triggers.md`)
  - `src/lib/Setting/Pages/Language/TranslatorPresetSettings.svelte`
  - `src/lib/Setting/Pages/Model/AuxModelSelectors.svelte`
- Not here:
  - Aux-model request routing → `llm-requests.md` (`requestChatDataMain`).
  - Inlay storage → `chat-pipeline.md` (`files/inlays.ts`).

## Files

TTS:

- `process/tts.ts`:
  - `sayTTS(character|null, text)`: provider switch on `character.ttsMode`. Providers: `webspeech`, `elevenlab`, `VOICEVOX`, `openai`, `novelai`, `huggingface`, `vits`, `gptsovits`, `fishspeech`.
  - `stopTTS`.
  - Voice lists: `getWebSpeechTTSVoices`, `getElevenTTSVoices`, `getVOICEVOXVoices`, `getNovelAIVoices`, `oaiVoices`.
  - `FixNAITTS`.
  - Internal: `playAudio`, `runPostprocessorPipeline`.
- `process/ttsHooks.ts`: `BeforeTTSContext`/`AfterTTSContext`, the pre/postprocessor register/remove/list functions, and `runHookPipeline`, which is sequential, supports `skip`, and ignores errors.

Image generation:

- `process/stableDiff.ts`:
  - `stableDiff(char, text)`: builds a prompt with `requestChatData(..., 'submodel')`, then calls `generateAIImage`.
  - `generateAIImage(prompt, char, neg, returnSdData)` dispatches on `db.sdProvider`: `webui`, `novelai` (ZIP → `processZip`), `dalle`, `stability`, `comfy`/`comfyui`, `fal`, `Imagen`, `openai-compat`, `wavespeed` (polling).

Translation:

- `translator/translator.ts`:
  - `translate`: memory cache keyed by the text alone, skipped for the LLM translator (`usesMemoryCache`, decided when `runTranslator` starts and again when it stores).
  - `runTranslator`: chunking, protects asset lines.
  - `translateMain` dispatches to LLM, DeepL, DeepLX, Bergamot, experimental Google, or direct Google GTX.
  - `translateHTML`: DOM text nodes. Skips `script`, `style`, and `translate=no`.
  - `translateLLM`: runs the selected preset's steps through `runTranslatorPipeline` (`shared/translation/pipeline.ts`), each step a `requestChatData(..., 'translate')` (the step's `model` is not read until translation slice 3.1); a failed step alerts and returns the source. Cached in LocalForage `LLMTranslateCache` (`LLMCacheStorage`) under `llm:<hash>:<source>`, the hash (`translationSourceHash`) of the pipeline signature, the languages, and the translator note, all read once into a detached context before any await (`llmTranslationContext`; `translateHTML` reads it once for both its cached-only check while generating and the translation). The model preset is not in the context: each step's chatless request resolves it when it starts (`requestChatDataMain`), so a chat switch during a multi-step run can move the later steps to another model preset. `llmTranslationCacheKey(text)` is the key as `translateHTML` translates now; the translation editors in `Chat.svelte` keep that full key and write back to it (`readLLMCacheEntry`/`writeLLMCacheEntry`). `getLLMCache(text)` and `searchLLMCache(partial)` (plugin API v3: source-text keys, current context only) read the current context. Entries keyed by the bare source (before the pipeline) are never read.
  - `applyEdittransRegex`: collects `presetRegex`, then module scripts, then character scripts, keeping `type === 'edittrans'`.
  - Also `translateVox`, `isExpTranslator`.
- `translator/bergamotTranslator.ts` `bergamotTranslate`: local Mozilla models, cached in IndexedDB `firefox-translations-models`.
- `translator/presets.ts`: `TranslatorPreset {id, name, steps}` (declared in `shared/settings.ts` with `TranslatorStep {id, name, enabled, prompt, maxResponse, model, outputKey?}`; `createTranslatorPreset`, `normalizeTranslatorSteps`, `isTranslatorPreset`, and `defaultTranslatorPrompt` live in `shared/translatorPresets.ts`; the `.risutl` codec writes no id and an import gets a fresh one), `getCurrentTranslatorPresetFromState` (the valid preset whose id is `translatorPresetId`, else the first; it never writes the state), and the `.risutl` codec (`encodeTranslatorPresetFile`/`decodeTranslatorPresetFile`: encrypted msgpack, `translatorPresetVersion: 1`, `type: 'translator-preset'`, a payload of `name`, `prompt`, `maxResponse`; a decoded file is one step, and a preset with more than one step or a step on a profile is refused on export (`translatorPresetExportUnsupported`) until version 2 in slice 3.1).
- Server translation (`docs/plan/translation.md` slice 1.3): `POST /api/translate/message` (`server/src/translation/runner.ts`, `self-host-server.md`; the path and the body/answer types in `shared/translation/route.ts`) translates a stored message's source text with the same pipeline and stores it on the message (`Message.translation`, the `setTranslation` op). Unlike `translateLLM` it sends the source without `<risu-style>` protection, and runs without the tab's plugin interceptor, plugin providers, and `request` trigger.
- `llmTranslationTarget` (`memoryTranslateMedia`, `"message"` by default, any other value normalized to it; decision 9) picks the LLM translator's path: `"message"` is the stored translation, `"rendered"` today's `translateHTML` path with its browser cache.
- Stored translation in the tab (slice 1.4), `translator/storedTranslation.svelte.ts`: `usesStoredTranslation()` (LLM on `"message"`), `freshTranslation(message)` (the whole record while its hash matches; an empty text counts), `heldMessage`. `requestStoredTranslation(ref, id, { force })`: one request per message per tab (a second call gets the running one); it captures the chat's display ids (`chatDisplayIds`) and the text's hash, saves every pending change (`flushResources`; `GenerationBlockedError` alerts `chatGenerating`, a conflict that discarded this chat's work or a text or display id changed meanwhile stops with a retry message), POSTs with the epoch header (an 11-minute wait for this tab only, authentication and the body included, and nothing sent once it passed; the run continues on the server), maps 412 to `epochMismatch` (no other alert), 409 `generating`/`chatBindingMismatch` to their strings, `ignored` to `translationSourceChanged`, anything else to `translationFailed` with the server's error or the status, and validates the answer (`isTranslateMessageAnswer`). The answer is not displayed by itself: the request stays pending (at most 15 s) until the held message holds the stored translation the chat's resource refresh brings, or its text changed. Its pending set and the rows' show/hide choices are reactive maps keyed by chat and message id, so a remounted row keeps both. `beginStoredTranslationEdit` captures an edit session (the chat, the message, the source hash, a copy of the fresh translation); `saveStoredTranslationEdit` writes `setMessageTranslation` with that hash, the base's `presetId` and `targetLanguage`, `translatedAt` now, and `edited: true`, and alerts and returns false when a generation locks the message, it is gone, or its text changed (`translationEditStale`); true means queued.
- `Chat.svelte` on the stored path (a row with a `messageId` in the displayed chat; the greeting, bookmark previews, and the welcome rows keep the rendered path): the row asks for the translation by its choice, else the global `autoTranslate` (interim until phase 2: show stored translations by default; nothing is requested automatically). It shows the fresh stored translation as `displayMessage`, which goes through `risuChatParser` and `ChatBody` like the text. The toggle hides the translation when it is on (shown, or asked for and pending); otherwise it shows it and, without a fresh translation or a pending request, requests one (a locked message alerts). Retranslate (disabled while pending) confirms (`retranslateConfirm`) with the message captured before the dialog, rechecks it, then requests with `force`. Edit translation is enabled only with a fresh translation and nothing pending; a refused save keeps the editor open, and an open editor keeps its Save and Cancel whatever the settings do meanwhile. The partial editor's translated view is the shown stored translation, edited through a captured session (`stored:<n>` keys); its `saveTranslation` callback returns whether the write was taken, and a refused edit keeps its draft; a save that ends after a cancel or a newer edit leaves that editor alone, and saves do not overlap. `ChatBody` on the stored path (`storedPath`) renders `msgDisplay` without the rendered translation, applies the `edittrans` scripts to a shown stored translation before Markdown (`applyEdittransToStoredTranslation`, as the `translateBeforeHTMLFormatting` path does), and shows the loading spinner (`showTranslationLoading`) while a requested translation is pending. The toggle's `translating` animation is the pending state there. `PartialEditController` never falls back to editing the original from a translated view whose translation context is missing (both paths).
- `shared/translation/pipeline.ts` (pure, shared with the server runner): `translatorStepsToRun` (the enabled steps, else the first), `fillTranslatorSlots` (one pass: `{{slot}}`, `{{slot::from}}`, `{{slot::content}}`/`{{solt::content}}`, `{{slot::prev}}`, `{{slot::out::KEY}}` (a `Map`, empty when unset), `{{slot::tnote}}`), `parseTranslatorChatML`, `buildTranslatorStepMessages` (ChatML wins; else the system prompt, plus the previous output as the user message unless the prompt holds an input slot), `stripTranslatorReasoning` (`<Thoughts>`/`<think>` blocks out of every step's output), `translatorPipelineSignature`, `runTranslatorPipeline`. CBS is never evaluated in a translator prompt (the old `parseChatML` path ran `risuChatParser` on ChatML contents, the substituted source included).

Media:

- `media/imageType.ts` `getImageType`: magic bytes for JPEG, PNG, GIF, BMP, AVIF, WEBP.
- `media/compressImage/*`: `compressImage`, gated by `db.imageCompression`. Leaves WEBP and AVIF untouched. `doLossyCompression` caps size at 3000 px and outputs WebP or JPEG at quality 75.

Playground (`PlaygroundMenu.svelte` maps `PlaygroundStore` IDs to components):

| Component                 | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `PlaygroundTokenizer`     | `encodeWithTokenizer`                                           |
| `PlaygroundJinja`         | Jinja renderer                                                  |
| `PlaygroundImageGen`      | `generateAIImage(...,'inlay')`                                  |
| `PlaygroundSubtitle`      | LLM, OpenAI Whisper, or local Transformers Whisper → WebVTT/SRT |
| `PlaygroundImageTrans`    | multimodal image-text translation                               |
| `PlaygroundTranslation`   | translation tool                                                |
| `PlaygroundDocs`          | live CBS docs from `registerCBS`                                |
| `PlaygroundInlayExplorer` | browse and delete inlays (server metadata, sizes from `size`)   |

The playground chat uses the special `§playground` character.

Settings:

- `AuxModelSelectors.svelte`: the model preset's `seperateModelsForAxModels` toggle and the four auxiliary slots (`auxSlots.{memory,translate,emotion,otherAx}`), each a `ProfileSlotSelect` that picks a model profile, falls back to the sub slot when unset, marks a deleted profile missing, and shows a bare slot (a model id a plugin wrote) as "no profile" (`docs/plan/model-profiles.md`; routing in `llm-requests.md`).
- `TranslatorPresetSettings.svelte`: `translatorPresets`, `translatorPresetId` (the selected preset's id).
- The language page (`languageSettingsData.svelte.ts`): `lang.llmTranslationTarget` (a select, LLM translator only) follows the preset editor; `legacyTranslation` is shown for every translator but the LLM one on `"message"`, and `translateBeforeHTMLFormatting` and `autoTranslateCachedOnly` only for the LLM translator on `"rendered"`. Hidden toggles keep their values and still drive the rows that keep the rendered path. The cache buttons stay for the LLM translator.

## Flows

- TTS triggers:
  - Manual: the `Chat.svelte` button → `sayTTS(null, msg)`.
  - Automatic: `sendChat` when `db.ttsAutoSpeech`.
  - Command: `command.ts` `speak`.
- `sayTTS` steps:
  1. Strip asterisks and optionally keep only quoted text.
  2. Run the preprocessor hooks.
  3. Call the provider.
  4. `playAudio` runs the postprocessor hooks and plays. Web Speech and VITS bypass the postprocessors.
- Image generation, emotion mode: `sendChat` with `viewScreen === 'imggen'` → `stableDiff` → writes the transient `CharEmotion`.
- Image generation, inlay mode:
  1. Callers: `inlayScreen.ts`, triggers, Lua `generateImage`, the playground.
  2. `generateAIImage(...,'inlay')` returns a data URI.
  3. The caller must call `writeInlayImage` and insert `{{inlay::id}}`.
- Display translation: on the rendered path `ChatBody.svelte:markParsing` switches on `autoTranslate`, `autoTranslateCachedOnly`, `translateBeforeHTMLFormatting`, and `legacyTranslation`, then calls `translateHTML`. On the stored path `Chat.svelte` swaps in the stored translation and `ChatBody` renders it as text.
- Input translation: `DefaultChatScreen.updateInputTransateMessage`, when `useAutoTranslateInput`.

## State

- Per-character TTS config: `ttsMode`, `ttsSpeech`, `voicevoxConfig`, `naittsConfig`, `gptSoVitsConfig`, `fishSpeechConfig`, `oaiVoice`, `hfTTS`, `vits`.
- DB keys and URLs: `elevenLabKey`, `voicevoxUrl`, `NAIApiKey`, `huggingfaceKey`, `fishSpeechKey`, ...
- Image generation: `db.sdProvider` plus per-backend settings.
- `CharEmotion`: `{[chaId]: [img, img, ts][]}` (not persisted).
- Translator DB fields: `translatorType`, `translator`, `translatorInputLanguage`, `translatorPresets`, `translatorPresetId` (an id; both travel in the `translatorPresets` record as `{ items, selectedId }`), `autoTranslate`, `llmTranslationTarget`, `htmlTranslation`, `combineTranslation`, ...

## Coupling

- TTS depends on `database.svelte.ts`, `globalFetch`, `runTranslator` (Hugging Face non-English), `transformers.ts:runVITS`, and plugin v3 (hook registration).
- `stableDiff` depends on `requestChatData`, `CharEmotion`, `processZip`, and inlays.
- The translator depends on the parser (`ParseMarkdown`, `applyMarkdownToNode`, `postTranslationParse`, `risuChatParser`), `requestChatData`, the script transform (`serverProcessScript`), platform flags, and localforage.
- The media utilities are used by card import/export, modules, and inlays.

## Invariants

- Provider discriminators are literal and case-sensitive: `VOICEVOX`, `Imagen`, `openai-compat`, `comfy` vs `comfyui`. Saved `ttsMode: 'none'` is migrated to `''`.
- TTS hooks apply only on paths through `playAudio`. The GPT-SoVITS gain path must still call `runPostprocessorPipeline`.
- `generateAIImage(..., 'inlay')` does not persist its result. The caller must persist it.
- Keep the `.risutl` format constants stable.
- A translator preset always has 1 to 5 steps: the server normalizer (`normalizeTranslatorSteps` through `createTranslatorPreset`) turns the old `{ prompt, maxResponse }` shape into one inherited step. The tab creates and imports presets with `createTranslatorPreset`, so what it writes is what the server stores. The editor edits `steps[0]` through the preset at each access (nested steps have no by-id identity in the records).
- `translateHTML` must preserve markup boundaries and the `translate=no`/`script`/`style` skips. It applies `edittrans` after translating (`applyEdittransRegex`: the one regex the tab still runs, a plain `RegExp` replacement with no Lua or trigger). Its `editdisplay` call runs on the server (`serverProcessScript`, target kind `translation`), with the context captured when `translateHTML` starts; without a context (a chat not saved on the server yet) the translated text stays as it is.
- Aux-model keys use the persisted misspelling `seperate*`. `submodel` is not an auxiliary slot: it always uses the sub slot. The root `seperateModels.<mode>` is a derived model id (the slot's profile's, `""` for an unset or dangling slot), never stored.

## Recipes

- Add a TTS provider: `ttsMode` in `CharConfig.svelte`, the `database.svelte.ts` fields and defaults, and a `sayTTS` case that routes through `playAudio`. Verify the manual button, auto speech, `speak`, `stopTTS`, and hooks.
- Add an image backend: a branch in `generateAIImage` that handles both inlay and emotion modes, plus DB settings in `OtherBotSettings.svelte`. Verify `inlayScreen`, triggers, and the playground.
- Change translation: `translateMain`, `runTranslator`, or `translateHTML`, plus DB defaults. Verify `ChatBody`, input translation, the LLM cache, and `translateVox`. A stored-path change: `storedTranslation.svelte.ts` and the `storedPath` branches of `Chat.svelte`, `ChatBody.svelte`, and `PartialEditController.svelte`; verify the rendered path is unchanged.
- Change aux routing: `shared/llm/modelSlots.ts` `resolveSlotProfile` (the one routing rule), `AuxModelSelectors.svelte`, `ModelModeExtended`, and the model preset's slot normalization (`shared/presets.ts`) together.
- Change media compression: `imageType.ts` first, then the compressors. Run both media tests and `inlays.test.ts`.

## Tests

- `src/ts/process/ttsHooks.test.ts`. `src/ts/process/ttsOpenAI.test.ts`: the OpenAI TTS routing of `sayTTS`: the stored key through the server's `openai-tts` operation for the official endpoint only, a character's own key with the character's request to any base URL, a custom base URL with the stored key and no key of its own refused with `ttsCustomUrlNeedsKey`, a keyless endpoint called without a key.
- `shared/tests/translatorPipeline.test.ts` (node): the pure pipeline: step selection, the ChatML parse, the slots filled in one pass (a filled value is never read for slots or `$` patterns; a named output by its own key only, prototype names included), the embedded-input rule judged on the template, the reasoning stripper (no opening tag: unchanged; nested, unclosed, a stray closing tag kept, `<thinking>` not a tag), the signature (the steps that run by their request fields), and the run (chaining, stripping between steps, the first step alone when none is enabled, an error ends the run). `shared/tests/translatorPresets.test.ts` (node): `normalizeTranslatorSteps` (the old shape, an empty list, the first five, coercion, model modes, repeated ids and output keys, idempotence), `createTranslatorPreset` as a fixed point of itself, `isTranslatorStep`/`isTranslatorPreset`.
- `src/ts/translator/translatorLLM.test.ts` (happy-dom, `requestChatData` and LocalForage mocked): `llmTranslationCacheKey` (changes with the prompt, the size, an output key, a step toggle, the selected preset, and each language; not with a name), the pipeline run on the `translate` slot (every step's messages and size, the note in the key and the prompt), reads and `searchLLMCache` under the current context only, the in-memory `translate` cache skipped for the LLM translator, a failed step alerting and returning the source uncached, and `translateHTML` while a chat is generating (cache only, the context read once).
- `src/ts/translator/presets.test.ts` (the selection, the mocked `.risutl` round trip as one step with fresh ids, the export refused for more than one step or a profile step), `src/ts/translator/edittransRegex.test.ts`. `src/ts/translator/presetsCodec.test.ts`: the `.risutl` round trip through the real codecs (WebCrypto, the RPack map from disk, `fflate`, msgpack): the container shape, a payload of exactly `name`, `prompt`, and `maxResponse` (the single step's) with no id, fresh preset and step ids on decode, a second cycle, the export refusal, and a corrupt file rejected.
- `src/lib/Setting/Pages/Language/TranslatorPresetSettings.test.ts` (mounted under happy-dom): selection by id with the first-preset fallback, the rename and delete dialogs while a conflict reload replaces the list meanwhile (the survivor is edited, a vanished target is left alone, the selection moves only when it pointed at the deleted preset, a list reduced to one preset is kept), and the first step's editor (the prompt and size written to `steps[0]` of the selected preset, a reload that replaces the steps followed, the other steps untouched).
- `src/ts/media/tests/imageType.test.ts`, `src/ts/media/compressImage/tests/compressImage.test.ts`.
- Stored translation (slice 1.4). `shared/tests/translateRoute.test.ts` (node): the route path and `isTranslateMessageAnswer` (`applied`/`fresh` with a message translation, an empty text included; `ignored` with null; everything else refused). `src/ts/translator/storedTranslation.test.ts` (happy-dom; the real chat module and records, `authFetch` and `flushResources` scripted): the request stops with `translationNoContext` without a complete display context and silently for a message not held; the save barrier (`GenerationBlockedError` → `chatGenerating`, another failure → `translationFailed` with its message, a discard of this chat, a text edited or a display id changed meanwhile → their strings; nothing sent); the POST body (the display ids, `force`) and the epoch header, a second call joining the first, the request pending after the 200 until `hydrateChat` brings that translation (or the text changes, or 15 s pass; no alert), `fresh` resolving at once, the 11-minute bound over the whole exchange and `beforeDispatch` refusing after it; every answer mapping (412 → the epoch handler and no alert, 409 `generating`/`chatBindingMismatch`, the server's error text or `HTTP <status>`, a non-JSON body, a malformed 200, `ignored`, a transport failure) with pending cleared and no retry; `freshTranslation`, `heldMessage`, `usesStoredTranslation`, the choices map; the edit session (fresh only, a detached base) and `saveStoredTranslationEdit` (the base's `presetId` and `targetLanguage`, the captured hash, `edited: true`; refused and alerted for a changed text, a locked or a gone message, the held translation untouched). `src/lib/ChatScreens/Chat.test.ts` (happy-dom, the row mounted with the parser, transform client, translator, and transport mocked): with `autoTranslate` the stored translation a hydration brings is shown without a remount, a clear shows the original, a replacement the new text, a stale one is hidden, `applyEdittransToStoredTranslation` runs on it and `translateHTML` never; an empty translation shows as empty; the toggle shows a fresh translation without a request and hides it, and the row's choice survives a remount and wins over `autoTranslate`; the toggle requests when none is fresh (the body, the `translating` class, the spinner, Retranslate and Edit disabled, no second request while pending, the translation shown only once the held message has it); a failed request alerts, leaves nothing shown and the toggle off, and the next click retries; hiding while pending shows the original and keeps the request; Retranslate confirms (`retranslateConfirm`), requests with `force` after a yes, nothing after a no or for a message removed during the dialog; the full editor opens on the fresh text, keeps the draft when the text changed since (`translationEditStale`), cancels without writing, writes `edited: true`, and keeps its Save and Cancel when the settings switch to `rendered` meanwhile; on `rendered`, and for a row without a message id, `translateHTML` runs and the stored translation is never shown or requested. `src/lib/ChatScreens/PartialEditController.test.ts` (happy-dom, mounted over a rendered block; hover driven through a stubbed `IntersectionObserver` and `elementFromPoint`): a translation save awaits `saveTranslation`, refuses an overlapping save, and a save that ends after a cancel and a newer edit leaves the newer editor alone; a refused write keeps the draft, a throwing callback alerts and keeps it, a taken one closes without dispatching; a translated view without a translation context shows the match failure; a delete through the callback ends its confirmation either way; without the callback a translation edit is dispatched as `save` with its key; an original edit dispatches and never calls the callback; an editor closed before its 200 ms scroll timer leaves that timer nothing to do (no error). `src/ts/setting/languageSettingsData.test.ts`: the `lang.llmTranslationTarget` select (bind, help, `labelKey` options, after the preset editor) and the visibility of the select, `legacyTranslation`, `translateBeforeHTML`, and `autoTranslateCachedOnly` by translator and target, with `autoTranslate` and the cache buttons kept. The `applyEdittransToStoredTranslation` cases in `edittransRegex.test.ts`; the `llmTranslationTarget` default and fallback in `server/src/tests/normalizeSections.test.ts`.
- Not tested: the other `sayTTS` providers, `stableDiff` backends, translator routing, HTML translation, Bergamot, the playground.

## Known Hazards

- `translatorType: 'none'` has no branch in `translateMain` and falls through to Google.
- The Imagen emotion path returns a data URI without updating `CharEmotion`. The fal emotion path has no final return.
- `sayTTS` passes no hook timeout, so a hanging plugin hook stalls speech.
- `compressImage` labels its input as PNG regardless of the detected type.
