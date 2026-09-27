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
  - `src/lib/UI/{3DLoader,Googli}.svelte` (unused)
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
  - `translate`: memory cache.
  - `runTranslator`: chunking, protects asset lines.
  - `translateMain` dispatches to LLM, DeepL, DeepLX, Bergamot, experimental Google, or direct Google GTX.
  - `translateHTML`: DOM text nodes. Skips `script`, `style`, and `translate=no`.
  - `translateLLM`: `requestChatData(..., 'translate')`, cached in LocalForage `LLMTranslateCache` (`LLMCacheStorage`).
  - `applyEdittransRegex`: collects `presetRegex`, then module scripts, then character scripts, keeping `type === 'edittrans'`.
  - Also `translateVox`, `isExpTranslator`.
- `translator/bergamotTranslator.ts` `bergamotTranslate`: local Mozilla models, cached in IndexedDB `firefox-translations-models`.
- `translator/presets.ts`: `TranslatorPreset {name, prompt, maxResponse}`, `normalizeTranslatorPresetState`, `syncCurrentTranslatorPresetToLegacyFields`, and the `.risutl` codec (`encodeTranslatorPresetFile`/`decodeTranslatorPresetFile`: encrypted msgpack, `translatorPresetVersion: 1`, `type: 'translator-preset'`).

Media:
- `media/imageType.ts` `getImageType`: magic bytes for JPEG, PNG, GIF, BMP, AVIF, WEBP.
- `media/compressImage/*`: `compressImage`, gated by `db.imageCompression`. Leaves WEBP and AVIF untouched. `doLossyCompression` caps size at 3000 px and outputs WebP or JPEG at quality 75.

Playground (`PlaygroundMenu.svelte` maps `PlaygroundStore` IDs to components):

| Component | Purpose |
|---|---|
| `PlaygroundTokenizer` | `encodeWithTokenizer` |
| `PlaygroundJinja` | Jinja renderer |
| `PlaygroundImageGen` | `generateAIImage(...,'inlay')` |
| `PlaygroundSubtitle` | LLM, OpenAI Whisper, or local Transformers Whisper → WebVTT/SRT |
| `PlaygroundImageTrans` | multimodal image-text translation |
| `PlaygroundTranslation` | translation tool |
| `PlaygroundDocs` | live CBS docs from `registerCBS` |
| `PlaygroundInlayExplorer` | browse inlay storage |

The playground chat uses the special `§playground` character.

Settings:
- `AuxModelSelectors.svelte`: `seperateModelsForAxModels`, `doNotChangeSeperateModels`, and `seperateModels.{memory,translate,emotion,otherAx}`.
- `TranslatorPresetSettings.svelte`: `translatorPresets`, `translatorPresetId`.

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
- Display translation: `ChatBody.svelte:markParsing` switches on `autoTranslate`, `autoTranslateCachedOnly`, `translateBeforeHTMLFormatting`, and `legacyTranslation`, then calls `translateHTML`.
- Input translation: `DefaultChatScreen.updateInputTransateMessage`, when `useAutoTranslateInput`.

## State
- Per-character TTS config: `ttsMode`, `ttsSpeech`, `voicevoxConfig`, `naittsConfig`, `gptSoVitsConfig`, `fishSpeechConfig`, `oaiVoice`, `hfTTS`, `vits`.
- DB keys and URLs: `elevenLabKey`, `voicevoxUrl`, `NAIApiKey`, `huggingfaceKey`, `fishSpeechKey`, ...
- Image generation: `db.sdProvider` plus per-backend settings.
- `CharEmotion`: `{[chaId]: [img, img, ts][]}` (not persisted).
- Translator DB fields: `translatorType`, `translator`, `translatorInputLanguage`, `translatorPrompt`/`translatorMaxResponse` (legacy, kept in sync with the selected preset), `translatorPresets`, `translatorPresetId`, `autoTranslate`, `htmlTranslation`, `combineTranslation`, ...

## Coupling
- TTS depends on `database.svelte.ts`, `globalFetch`, `runTranslator` (Hugging Face non-English), `transformers.ts:runVITS`, and plugin v3 (hook registration).
- `stableDiff` depends on `requestChatData`, `CharEmotion`, `processZip`, and inlays.
- The translator depends on the parser (`ParseMarkdown`, `applyMarkdownToNode`, `postTranslationParse`, `risuChatParser`), `requestChatData`, `processScriptFull`, platform flags, and localforage.
- The media utilities are used by card import/export, modules, and inlays.

## Invariants
- Provider discriminators are literal and case-sensitive: `VOICEVOX`, `Imagen`, `openai-compat`, `comfy` vs `comfyui`. Saved `ttsMode: 'none'` is migrated to `''`.
- TTS hooks apply only on paths through `playAudio`. The GPT-SoVITS gain path must still call `runPostprocessorPipeline`.
- `generateAIImage(..., 'inlay')` does not persist its result. The caller must persist it.
- Keep the `.risutl` format constants and legacy-field syncing stable.
- `translateHTML` must preserve markup boundaries and the `translate=no`/`script`/`style` skips. It applies `edittrans` after translating.
- Aux-model keys use the persisted misspelling `seperate*`. `submodel` is not a `seperateModels` key.

## Recipes
- Add a TTS provider: `ttsMode` in `CharConfig.svelte`, the `database.svelte.ts` fields and defaults, and a `sayTTS` case that routes through `playAudio`. Verify the manual button, auto speech, `speak`, `stopTTS`, and hooks.
- Add an image backend: a branch in `generateAIImage` that handles both inlay and emotion modes, plus DB settings in `OtherBotSettings.svelte`. Verify `inlayScreen`, triggers, and the playground.
- Change translation: `translateMain`, `runTranslator`, or `translateHTML`, plus DB defaults. Verify `ChatBody`, input translation, the LLM cache, and `translateVox`.
- Change aux routing: `AuxModelSelectors.svelte`, `ModelModeExtended`, `requestChatDataMain`, and preset serialization together.
- Change media compression: `imageType.ts` first, then the compressors. Run both media tests and `inlays.test.ts`.

## Tests
- `src/ts/process/ttsHooks.test.ts`.
- `src/ts/translator/presets.test.ts`, `src/ts/translator/edittransRegex.test.ts`.
- `src/ts/media/tests/imageType.test.ts`, `src/ts/media/compressImage/tests/compressImage.test.ts`.
- Not tested: `sayTTS` providers, `stableDiff` backends, translator routing, HTML translation, Bergamot, the playground.

## Known Hazards
- `translatorType: 'none'` has no branch in `translateMain` and falls through to Google.
- The Imagen emotion path returns a data URI without updating `CharEmotion`. The fal emotion path has no final return.
- `sayTTS` passes no hook timeout, so a hanging plugin hook stalls speech.
- `compressImage` labels its input as PNG regardless of the detected type.
