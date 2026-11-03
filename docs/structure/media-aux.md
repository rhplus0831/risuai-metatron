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
  - Aux-model request routing → `llm-requests.md` (`requestChatDataMain`).
  - Inlay storage → `chat-pipeline.md` (`files/inlays.ts`).

## Files

### TTS

- `process/tts.ts`:
  - `sayTTS(character|null, text)`: provider switch on `character.ttsMode`. Providers: `webspeech`, `elevenlab`,
    `VOICEVOX`, `openai`, `novelai`, `huggingface`, `vits`, `gptsovits`, `fishspeech`. Captures the Stop generation at
    entry and carries it through the playback context, including the GPT-SoVITS gain path.
  - Each `sayTTS` run registers its own `AbortController` (`activeSpeechControllers`) and passes its signal to every
    provider request (`fetch` and `auxFetch` as `signal`, `globalFetch` as `abortSignal`). The Hugging Face 503
    `estimated_time` retry waits on that signal and reuses the text translated once before the loop. VOICEVOX and
    Hugging Face pass the same signal to their translator calls, which suppress translator alerts after cancellation.
  - Because `globalFetch` answers an abort with `ok: false` instead of throwing, each branch checks the signal after its
    request and body read before it alerts or throws, and after translation and the unabortable awaits (`loadAsset`,
    `runVITS`) before going on. A run whose signal was aborted ends silently.
  - `stopTTS`: advances the generation, aborts every registered run's controller (pending provider requests and the
    Hugging Face retry wait; the provider's remote job is not cancelled), stops and retires every source in
    `activeSpeech`, closes their audio contexts and every context still decoding (`pendingContexts`), and cancels Web
    Speech. The chat menu exposes Stop for every enabled mode, VITS included.
    - Voice lists: `getWebSpeechTTSVoices`, `getElevenTTSVoices`, `getVOICEVOXVoices`, `getNovelAIVoices`, `oaiVoices`.
  - `FixNAITTS`.
  - Internal: `playAudio` runs `runPostprocessorPipeline`, then `playProcessedAudio` decodes and starts the source. The
    gain path and VITS (`runVITS` only synthesizes and returns the WAV bytes; no hooks run on them) share
    `playProcessedAudio`: it checks the captured generation before starting, tracks each source/context in
    `activeSpeech`, and retires it on `ended`; a cancelled decode or a decode failure closes the unused context, and a
    decode that rejects after Stop closed its context alerts nothing.
- `process/ttsHooks.ts`: `BeforeTTSContext`/`AfterTTSContext`, the pre/postprocessor register/remove/list functions, and
  `runHookPipeline`, which is sequential, supports `skip`, and ignores errors.

### Image generation

- `process/stableDiff.ts` `stableDiff(currentChar, prompt, target = {})`: builds a prompt with
  `requestChatData(..., 'submodel', target.signal)`, then calls `generateAIImage` with `{ signal: target.signal }`.
  `target` keeps `chatRef`, `pluginContext`, and `check`, and accepts `signal?: AbortSignal`; cancellation applies only
  when the caller supplies a signal.
- `generateAIImage(genPrompt, currentChar, neg, returnSdData, options: { signal?: AbortSignal; orientation?: "landscape" | "portrait" } = {})`
  dispatches on `settings.memoryTranslateMedia.sdProvider`: `webui`, `novelai` (ZIP → `processZip`), `dalle`,
  `stability`, `comfy`/`comfyui`, `fal`, `Imagen`, `openai-compat`, `wavespeed` (polling).
  - The optional signal reaches every request, including character-image reads through `readAsset` and their retries;
    ComfyUI's 1 s and Wavespeed's 3 s polling waits are abortable. Both entry points reject an aborted run with the
    signal's own reason, without an alert or image delivery; checks after awaits cover response bodies and image
    processing.
  - ComfyUI polls `/history/{prompt_id}` (the id URL-encoded), reading `[prompt_id]` from the answer; a 404/405 switches
    once per run to `/history` before parsing the body, and any other non-OK history answer fails. The deadline is
    checked before every history request. A non-OK `/view` response reaches the existing failure alert before its body
    can be delivered as an image.
  - Stability reads the native response's Content-Type through `headers.get` and refuses JSON error bodies.
  - NovelAI character-reference image decoding rejects on load failure (falling back to the original image) or
    cancellation, removing its handlers and abort listener when it settles.
  - `orientation` reaches only NovelAI: `applyImageOrientation` puts the longer configured side on the width for
    `landscape` and on the height for `portrait` (txt2img and img2img); the configured size is used as is without one,
    and every other provider ignores it.
  - Every success uses `deliverGeneratedImage`, which checks the signal before returning the image URI for `"inlay"` or
    updating `CharEmotion` from the store's value at write time and returning `returnSdData`.

### Media

- `media/imageType.ts` `getImageType`: magic bytes for JPEG, PNG, GIF, BMP, AVIF, WEBP.
- `media/compressImage/*`: `compressImage`, gated by `db.imageCompression`. Leaves WEBP and AVIF untouched.
  `doLossyCompression` caps size at 3000 px and outputs WebP or JPEG at quality 75.

### Playground

`PlaygroundMenu.svelte` maps `PlaygroundStore` IDs to components:

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

The playground chat uses the special `§playground` character. `PlaygroundImageGen` clears its generating state in
`finally`, including when generation rejects.

### Settings

- `AuxModelSelectors.svelte`: the model preset's `seperateModelsForAxModels` toggle and the four auxiliary slots
  (`auxSlots.{memory,translate,emotion,otherAx}`), each a `ProfileSlotSelect` that picks a model profile, falls back to
  the sub slot when unset, marks a deleted profile missing, and shows a bare slot (a model id a plugin wrote) as "no
  profile" ([model profiles and slots](llm-requests.md); routing in `llm-requests.md`).

## Flows

- TTS entry points are the `Chat.svelte` button (`sayTTS(null, msg)`), `sendChat` when `db.ttsAutoSpeech`, and
  `command.ts` `speak`. `sayTTS` preprocesses before the provider; playback postprocesses before audio decoding.
- Emotion image generation runs from the server job's `imggen` callback through `stableDiff` and
  `generateAIImage(..., "")`, which updates `CharEmotion`; the callback answers `shown !== false`.
- Inlay generation callers (`inlayScreen.ts`, triggers, Lua `generateImage`, and the playground) persist the returned
  data URI with `writeInlayImage` and insert `{{inlay::id}}`. Lua may pass `orientation`, but the tab forwards only
  `landscape` or `portrait`.

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
- The VITS model import (`transformers.ts` `registerOnnxModel`, the character's TTS settings) takes the picked zip as a
  `File` and reads it by its central directory (`process/zipFile.ts` over `shared/charxImport.ts`'s parsers), never
  scanning entry bytes for signatures.
  - Each kept member (`.onnx`, under 10 MB compressed, or a `.git` path; no directories) is read and inflated only when
    its `saveAssets` slot is free (two at once) and the members are written in batches; a member over
    `MAX_ONNX_MEMBER_BYTES` (100 MiB less 64 KiB, so its record fits the server's body limit) is skipped and named in
    the closing message. An unreadable zip or a failed save alerts and returns nothing.
- `stableDiff` depends on `requestChatData`, `CharEmotion`, `processZip`, and inlays.
- The media utilities are used by card import/export, modules, and inlays.

## Invariants

- Provider discriminators are literal and case-sensitive: `VOICEVOX`, `Imagen`, `openai-compat`, `comfy` vs `comfyui`.
  Saved `ttsMode: 'none'` is migrated to `''`.
- TTS postprocessors run through `playAudio`; the GPT-SoVITS non-default-gain path calls `runPostprocessorPipeline`
  before `playProcessedAudio`. Web Speech and VITS bypass postprocessors.
- `generateAIImage(..., 'inlay')` does not persist its result. The caller must persist it.
- Aux-model keys use the persisted misspelling `seperate*`. `submodel` is not an auxiliary slot: it always uses the sub
  slot. The root `seperateModels.<mode>` is a derived model id (the slot's profile's, `""` for an unset or dangling
  slot), never stored.

## Recipes

### Add a TTS provider

`ttsMode` in `CharConfig.svelte`, the `database.svelte.ts` fields and defaults, and a `sayTTS` case that routes through
`playAudio`. Verify the manual button, auto speech, `speak`, `stopTTS`, and hooks.

### Add an image backend

A branch in `generateAIImage` that handles both inlay and emotion modes, plus DB settings in
`ImageGenerationSettings.svelte` (menu 19, `/settings/image-generation`). Verify `inlayScreen`, triggers, and the
playground.

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
- Not tested: `auxFetchJson` abort, other provider request bodies/integration, real audio decoding, Stop-menu
  visibility, and interactive playground flows.

## Known Hazards

### Issues

- `sayTTS` passes no hook timeout, so a hanging plugin hook stalls speech.
- `compressImage` labels its input as PNG regardless of the detected type.

### Gotchas

- `src/lib/UI/3DLoader.svelte`, `src/ts/3d/threeload.ts`, and `src/ts/voice.ts` have no importers; confirm intent before
  wiring them into a feature.
