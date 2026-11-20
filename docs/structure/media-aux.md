# Media and Auxiliary Features: TTS, Image Generation, Media, Playground

## Scope

- Owns:
  - text-to-speech providers and plugin TTS hooks,
  - AI image generation backends,
  - image type detection and compression,
  - the aux-model selector UI,
  - the playground tool screens,
  - legacy 3D and voice files.
- Paths:
  - `src/ts/process/{tts,ttsHooks,stableDiff}.ts`
  - `src/ts/media/*`
  - `src/ts/voice.ts` (unused)
  - `src/ts/3d/*` (unused)
  - `src/lib/UI/3DLoader.svelte` (unused)
  - `src/lib/Playground/*`, except `PlaygroundMenu` (→ `ui-theming.md`), `PlaygroundEmbedding` (→ `memory.md`),
    `PlaygroundMCP` (→ `mcp.md`), and `PlaygroundRegex`/`Syntax`/`Parser` (→ `scripts-triggers.md`)
  - `src/lib/Setting/Pages/Model/AuxModelSelectors.svelte`
- Not here:
  - Translation, its presets and settings, the stored translation, and bilingual display →
    [translation](translation.md).
  - Aux-model request routing → [model preset slots](llm-requests.md#model-preset-slots).
  - Inlay storage → [chat pipeline](chat-pipeline.md) (`files/inlays.ts`).

## Files

### TTS

- `src/ts/process/tts.ts`: character speech; its module header holds the cancellation model and the hook order.
  `sayTTS(character|null, text)` (provider switch on `character.ttsMode`), `stopTTS`, the voice lists for
  `src/lib/SideBars/CharConfig.svelte` (`getWebSpeechTTSVoices`, `getElevenTTSVoices`, `getVOICEVOXVoices`,
  `getNovelAIVoices`, `oaiVoices`), `FixNAITTS` (no callers); internal `playAudio`, `playProcessedAudio`,
  `runPostprocessorPipeline`, `retryDelay`, `activeSpeech`, `activeSpeechControllers`, `pendingContexts`.
- `src/ts/process/ttsHooks.ts`: the plugin TTS hook registry (`src/ts/plugins/apiV3/v3.svelte.ts` registers):
  `BeforeTTSContext`/`AfterTTSContext`, `registerTTSPreprocessor`/`registerTTSPostprocessor`, their `unregister*` and
  `get*` snapshots, `runHookPipeline`.

### Image generation

- `src/ts/process/stableDiff.ts`: image generation; its module header holds the provider list and the cancellation rule,
  and each provider's request rules sit at its branch of `generateAIImageForProvider` (ComfyUI's history polling,
  Stability's content type, NovelAI's character reference). `stableDiff(currentChar, prompt, target)` (the emotion
  entry: `chatRef`, `pluginContext`, `check`, `signal`),
  `generateAIImage(genPrompt, currentChar, neg, returnSdData, { signal, orientation })`, `deliverGeneratedImage`,
  `pollingDelay`, `applyImageOrientation`.

### Media

- `src/ts/media/index.ts`: the entry, naming its consumers. `src/ts/media/imageType.ts` `getImageType`;
  `src/ts/media/compressImage/compressImage.ts` `compressImage`; `src/ts/media/compressImage/lossyCompression.ts`
  `doLossyCompression`.

### Playground

`src/lib/Playground/PlaygroundMenu.svelte` ([ui-theming](ui-theming.md)) mounts each tool by a `PlaygroundStore` id
(each component's contract names its id) and creates the `§playground` character the playground chat uses. The tools
here, under `src/lib/Playground/`:

| Component                 | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `PlaygroundTokenizer`     | `encodeWithTokenizer`                                           |
| `PlaygroundJinja`         | Jinja renderer                                                  |
| `PlaygroundImageGen`      | `generateAIImage(...,'inlay')` preview; stores nothing          |
| `PlaygroundSubtitle`      | LLM, OpenAI Whisper, or local Transformers Whisper → WebVTT/SRT |
| `PlaygroundImageTrans`    | multimodal image-text translation                               |
| `PlaygroundTranslation`   | translation tool                                                |
| `PlaygroundDocs`          | live CBS docs from `registerCBS`                                |
| `PlaygroundInlayExplorer` | browse and delete inlays                                        |
| `ToolConversion`          | SillyTavern prompt JSON → presets (`promptConvertion`)          |

### Settings

- `src/lib/Setting/Pages/Model/AuxModelSelectors.svelte`: the model preset's `seperateModelsForAxModels` toggle and the
  four `auxSlots` (`ProfileSlotSelect` each). Edits target `editedModelPreset`; see
  [model preset slots](llm-requests.md#model-preset-slots) for resolution at request time.

## Flows

- TTS entry points: the `src/lib/ChatScreens/Chat.svelte` button reads the original message or the raw streaming text,
  even while a translation is shown. The `speak` command in `src/ts/process/command.ts` passes its argument to `sayTTS`.
  With `db.ttsAutoSpeech`, the server send (`server/src/prompt/runner.ts`) posts a `tts` job notice, and
  `src/ts/network/jobChannel.ts` calls `sayTTS(character, text)` for a non-group character in the tab's list. Stop is
  `stopTTS`, in the `src/lib/ChatScreens/DefaultChatScreen.svelte` menu whenever the character has a `ttsMode`.
- Emotion images: the server send's `imggen` view asks the tab's `imggen` callback (`jobChannel.ts`), which runs
  `stableDiff` with the job's chat ref, plugin context, `check`, and abort signal; `generateAIImage(..., "")` updates
  `CharEmotion`, and the callback answers `shown !== false`.
- Inlay images: the server's inlay screen (`runInlayScreen` in `server/src/prompt/postProcess.ts`, from `runner.ts`),
  the `v2ImgGen` trigger effect (`server/src/prompt/triggers.ts`), and Lua `generateImage` all call `generateImageInlay`
  (`server/src/lua/bindings.ts`), the `generateImage` callback. The tab (`jobChannel.ts`) answers with
  `generateAIImage(..., "inlay")` under the job's signal, then `writeInlayImage`, and returns the inlay id.
- The server turns that id into `{{inlay::id}}`: the inlay screen puts it in the reply text, `v2ImgGen` in its output
  variable, and Lua returns it to the script. The Lua binding answers an `orientation` other than `landscape` or
  `portrait` with an error string without asking the tab, and the tab forwards only those two. A Lua `name` that is a
  non-empty string becomes the inlay's name (otherwise its id); an empty or non-string name means none. A name longer
  than `MAX_LUA_INLAY_NAME_LENGTH` (200 characters, `shared/jobs.ts`) is an error string without asking the tab, and the
  tab drops such a name.

## State

- Per-character TTS config: `ttsMode`, `ttsSpeech`, `voicevoxConfig`, `naittsConfig`, `gptSoVitsConfig`,
  `fishSpeechConfig`, `oaiVoice`, `hfTTS`, `vits`.
- DB keys and URLs: `elevenLabKey`, `voicevoxUrl`, `NAIApiKey`, `huggingfaceKey`, `fishSpeechKey`, ... The Voice &
  Emotion page shows the OpenAI key (Model › API Keys) and `NAIApiKey` (Image Generation's NovelAI block) as status and
  a link, not as inputs; DALL-E and Imagen show the OpenAI and Google keys the same way
  ([settings-i18n](settings-i18n.md)).
- Image generation: `db.sdProvider` plus per-backend settings.
- `CharEmotion`: `{[chaId]: [img, img, ts][]}` (not persisted).

## Coupling

- TTS depends on `database.svelte.ts`, `globalFetch`, `runTranslator` (Hugging Face non-English),
  `transformers.ts:runVITS` (synthesis only; it never opens an `AudioContext`), and plugin v3 (hook registration).
- OpenAI TTS's per-character `oaiTTSConfig` and stored-key path, DALL-E/Imagen, and Whisper follow
  [network jobs: Auxiliary credentials](network-jobs.md#auxiliary-credentials), including the custom TTS URL/key rule.
- ElevenLabs and Hugging Face speech use `globalFetch` for audio bytes. Stability sends multipart bytes and their
  boundary together through `fetchNative`. The [network wrappers](network-jobs.md) control routing for these calls.
- The character's VITS/ONNX model import runs `registerOnnxModel` in `src/ts/process/transformers.ts`, using
  `src/ts/process/zipFile.ts` and `shared/charxImport.ts` to read the central directory and `saveAssets` to store
  selected members. `MAX_ONNX_MEMBER_BYTES` leaves room for the server's batch framing.
- `stableDiff` depends on `requestChatData`, `CharEmotion`, `processZip`, and `readAsset` (character images).
- The media utilities are used by card import/export, modules, and inlays.

## Invariants

- Provider discriminators are literal and case-sensitive: `VOICEVOX`, `Imagen`, `openai-compat`, `comfy` vs `comfyui`.
  Character creation/import maps `ttsMode: 'none'` to `''`; normalization of an existing character preserves the
  supplied value.
- TTS postprocessors run through `playAudio`; the GPT-SoVITS non-default-gain path calls `runPostprocessorPipeline`
  before `playProcessedAudio`. Web Speech and VITS bypass postprocessors.
- `generateAIImage(..., 'inlay')` does not persist its result. The caller must persist it.
- Aux-model keys use the persisted misspelling `seperate*`. `submodel` is not an auxiliary slot: it uses the sub slot
  under normal slot routing. `seperateModels.<mode>` is derived by `shared/sections.ts` `modelIdOfSlot`: a bare slot's
  `modelId`, a profile slot's resolved model id, or `""` for an unset/dangling slot. The root is never stored; request
  routing follows [LLM requests](llm-requests.md#invariants).

## Recipes

### Add a TTS provider

- Add `ttsMode` and provider controls in `src/lib/SideBars/CharConfig.svelte`, character fields in `shared/database.ts`,
  shared defaults in `shared/characters.ts`, provider defaults in `CharConfig.svelte`, and a `sayTTS` case through
  `playAudio` in `src/ts/process/tts.ts`. Global settings follow [persistence](persistence.md#recipes). Verify the
  manual button, auto speech, `speak`, `stopTTS`, and hooks.

### Add an image backend

- Add a branch in `generateAIImageForProvider` in `src/ts/process/stableDiff.ts`, preserving `generateAIImage`'s
  cancellation boundary and `deliverGeneratedImage` for inlay/emotion delivery. Add controls in
  `src/lib/Setting/Pages/ImageGenerationSettings.svelte` (menu 19, `/settings/image-generation`); persisted fields
  follow [persistence](persistence.md#recipes). Verify `runInlayScreen`, triggers, and the playground.

### Change aux routing

`shared/llm/modelSlots.ts` `resolveSlotProfile` (the one routing rule), `AuxModelSelectors.svelte`, `ModelModeExtended`,
and the model preset's slot normalization (`shared/presets.ts`) together.

### Change media compression

`src/ts/media/imageType.ts` first, then the compressors. Run the tests under `src/ts/media` and
`src/ts/process/files/tests/inlays.test.ts` (the inlay image-type path).

## Tests

Runner, slow-test, and timing rules belong to [test-harness](test-harness.md). This area has no `slow` tests.

- `e2e`: `e2e/welcomeAndChatSettings.spec.ts` mounts the playground pages.
- TTS: `pnpm --silent test:agent src/ts/process/tts*.test.ts`.
- Image generation: `pnpm --silent test:agent src/ts/process/imageDelivery.test.ts`.
- Media: `pnpm --silent test:agent src/ts/media`.
- `ttsPlayback.test.ts` and `imageDelivery.test.ts` replace network boundaries with `fetch`/`globalFetch`/aux-fetch
  fakes; TTS also stubs `AudioContext`.
- `auxFetchJson` abort: [network tests](network-jobs.md#tests).
- Playground preview/retry and deletion: `src/ts/process/imageDelivery.test.ts` and
  `src/lib/Playground/PlaygroundInlayExplorer.test.ts`.
- Not tested: full provider request-body coverage, real audio decoding, Stop-menu visibility, and interactive playground
  flows beyond image-preview retry and inlay-preview/deletion. The
  [real-provider checks](../backlog/manual-checks.md#real-providers-and-external-services) cover pending speech and
  image requests through the server and plain-fetch routes.

## Known Hazards

### Gotchas

- `src/lib/UI/3DLoader.svelte`, `src/ts/3d/threeload.ts`, and `src/ts/voice.ts` have no importers; confirm intent before
  wiring them into a feature.
