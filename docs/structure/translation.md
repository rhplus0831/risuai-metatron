# Translation: Providers, the LLM Translator, Presets, Server and Stored Translation, Bilingual Display

## Scope

- Owns translation: the providers and the LLM translator, `translateHTML` on the rendered path and the `edittrans`
  regex, the caches, translator presets and `.risutl`, server translation and the stored translation on messages, the
  chat row on the stored path, bilingual display, the translator pipeline and its model slots, the translator settings,
  and the chat's translation settings.
- Paths: `src/ts/translator/*`, `shared/translation/`, `shared/translatorPresets.ts`, `server/src/translation/`,
  `src/lib/Setting/Pages/Translation/TranslatorPresetSettings.svelte`.
- Not here:
  - TTS, image generation, media compression, the aux-model selector, and the playground tools →
    [media-aux](media-aux.md).
  - Aux-model request routing → `llm-requests.md` (`requestChatDataMain`).
  - The settings registry behind the Translation page, and the UI language → [settings-i18n](settings-i18n.md).
  - Input translation in the composer → [chat-pipeline](chat-pipeline.md) (`inputTranslation.svelte.ts`).
  - Markdown parsing and the sentence breaks the translator calls → [cbs-rendering](cbs-rendering.md).

## Files

### Translator

`translator/translator.ts`:

- `translate`: memory cache keyed by text and `memoryTranslationContext` (the direction-independent language pair,
  including the model's `ja`/`en` choice, provider, input language, experimental Google flag, DeepLX URL, and DeepL
  free/paid option), skipped for the LLM translator (`usesMemoryCache`). Forward and reverse lookups share pairs within
  one context.
- Only `translate` writes this cache, after `runTranslator` returns and only if the current context still matches the
  captured one; direct `runTranslator` callers such as TTS and the playground do not populate it.
- `writeMemoryCache` and `dropMemoryCacheEntry` count both strings plus `MEMORY_CACHE_ENTRY_OVERHEAD` (64 UTF-16 code
  units per pair for its Set and two Map entries) toward `MEMORY_CACHE_CHARS` (4,000,000); the least recently used pairs
  across contexts leave first, so tiny entries also consume the budget.
- `runTranslator`: cuts the text with the server's `translateProtectingLines` (the lines between two empty or asset
  lines go out as one chunk joined with `\n`, the protected lines kept); for the LLM translator with a preset on Send
  Text As-Is (`sendTextAsIs`) the whole text goes to `translateLLM` in one call, its reply returned as is.
- With Exclude Chain-of-Thought (`excludeThoughts`) and without As-Is, `runTranslator` strips the LLM translator's text
  of its reasoning blocks (`stripTranslatorReasoning`) once, whole, before the line cut, and the chunks go to
  `translateLLM` as prepared (`inputPrepared`: not stripped again, the strip is not idempotent, and keyed apart from raw
  text); a chunk's failure (`translateLLM`'s `failure` flag) returns the whole text as given.
- `runTranslator`'s optional `exarg.signal` (also accepted by `translateVox`) reaches provider requests and LLM steps;
  an aborted call rejects without a translator alert. Calls without a signal retain their existing behavior.
- `translateMain` dispatches to LLM, DeepL, DeepLX, experimental Google, or direct Google GTX (any other
  `translatorType`, `"none"` included, reaches Google). Unless `noWaitForTranslate` is on, each DeepLX request takes the
  next free slot (`waitTrans`), 3 s after the one before it, and waits for it.
- `translateHTML`: collects DOM translation jobs before dispatch, keeping the `script`, `style`, and `translate=no`
  skips and combined paragraphs' span restructuring. DeepLX sends sequential `■`-joined batches up to 5,000 characters,
  including the final partial batch, and retries each chunk separately when the separator count disagrees. Other
  providers translate jobs with at most ten requests in flight. Both paths then apply the results through the same
  text/display-script/Markdown handling before `applyEdittransRegex`.
- `applyEdittransRegex`: collects `presetRegex`, then module scripts, then character scripts, keeping
  `type === 'edittrans'`.
- Also `translateVox`, `isExpTranslator`.
- A stored `translatorType: "bergamot"` is turned by the server normalizer into `"google"` with `translator` empty
  (translation off, which also keeps every chat's `autoTranslate` inactive) and `useAutoTranslateInput` off, so nothing
  is sent to an online translator until the user turns translation on again. `htmlTranslation` is a dropped field.

### LLM translation

`translateLLM` (`translator/translator.ts`) runs the preset's steps through `runTranslatorPipeline`
(`shared/translation/pipeline.ts`).

- The preset is `getCurrentTranslatorPreset`: the selected chat's translator preset, else the global selection.
  `runTranslator` reads it once for all its chunks, and the playground passes `globalPreset` for the global one.
- Each step is a `requestChatData(..., 'translate')` with the step's profile as `profileId` when its `model` names one
  (else the `translate` slot); a failed step alerts and returns the source unless the caller's signal has been aborted.
- Without Send Text As-Is, each `<risu-style>` block is sent as a `<style-data>` placeholder and restored in the reply;
  with it, the text and the reply are kept as they are.
- With Exclude Chain-of-Thought (`stripInput` unless the caller prepared the text), the reasoning blocks leave the text
  after the cache read and before the placeholders; a text left blank caches and returns `""` without a request, and a
  failure returns the text as given (and sets the caller's `failure` flag). On the rendered path `ParseMarkdown` has
  already turned `<Thoughts>` into `<details>`, so only raw tags (the `translateBeforeHTMLFormatting` text) are
  stripped.
- Cache: LocalForage `LLMTranslateCache` (`LLMCacheStorage`) under `llm:<hash>:<source>`. The hash
  (`translationSourceHash`) covers the pipeline signature, the languages, the translator note, and `sendTextAsIs` and
  `excludeThoughts` each when it is on, plus `inputPrepared` for `runTranslator`'s prepared chunks; keys without them
  preserve the legacy cache format. The key's text is the caller's, before any strip, except `runTranslator`'s protected
  chunks, keyed by the chunks of the stripped text.
- The hash inputs are read once into a detached context before any await (`llmTranslationContext`; `translateHTML` reads
  it once for both its cached-only check while generating and the translation).
- The context also captures the request ids every step runs with (`requestIds`: the settings views' prompt preset, model
  preset, and persona, as a chatless request would read them; `runTranslator` captures them once for all its chunks,
  with the preset), so a chat switch during a multi-step run does not move the later steps. They are not in the cache
  key.
- `llmTranslationCacheKey(text)` is the key as `translateHTML` translates now; the translation editors in `Chat.svelte`
  keep that full key and write back to it (`readLLMCacheEntry`/`writeLLMCacheEntry`).
- `getLLMCache(text)` and `searchLLMCache(partial)` (plugin API v3: source-text keys, current context only) read the
  current context (the selected chat's preset). Entries keyed by the bare source are never read.

### Presets and `.risutl`

- `translator/presets.ts`: `getCurrentTranslatorPresetFromState` (the valid preset whose id is `translatorPresetId`,
  else the first; it never writes the state) and the `.risutl` codec.
- `TranslatorPreset {id, name, steps, sendTextAsIs?, excludeThoughts?}` is declared in `shared/settings.ts`;
  `sendTextAsIs` and `excludeThoughts` are stored only as `true`. Steps are
  `TranslatorStep {id, name, enabled, prompt, maxResponse, model, outputKey?}`. `createTranslatorPreset`,
  `normalizeTranslatorSteps`, `isTranslatorPreset`, and `defaultTranslatorPrompt` live in `shared/translatorPresets.ts`.
- The `.risutl` codec (`encodeTranslatorPresetFile`/`decodeTranslatorPresetFile`) is encrypted msgpack,
  `type: 'translator-preset'`. It writes no id, and an import gets a fresh one.
- `.risutl` version 1, a payload of `name`, `prompt`, `maxResponse`, is written when it holds the preset without loss
  (Send Text As-Is and Exclude Chain-of-Thought off, one enabled step on the `translate` slot, no output key, the
  default name `Step 1`) and decodes to one step; one carrying `sendTextAsIs` or `excludeThoughts` is refused.
- `.risutl` version 2 is otherwise written: a payload of exactly `name` and `steps` (1–5, each exactly `name`,
  `enabled`, `prompt`, `maxResponse`, `model`, and an optional `outputKey`; no preset or step id) and the optional
  booleans `sendTextAsIs` and `excludeThoughts` (each written only when on).
- `.risutl` decoding checks every level and refuses another shape (a Fastify file), an invalid output key, or one used
  twice. A profile step keeps its profile id (it runs where that profile exists and shows as missing elsewhere). A blank
  name imports as "Imported Preset".

### Server translation

- `POST /api/translate/message` (`server/src/translation/runner.ts`, `server-generation.md`; the path and body/answer
  types in `shared/translation/route.ts`) translates a stored message's source text with the same pipeline and stores it
  on the message (`Message.translation`, the `setTranslation` op).
- A preset on Send Text As-Is sends the whole source through one pipeline run and stores the reply as is. Otherwise (the
  default) `translateProtectingLines` cuts the source at empty and asset lines and runs the pipeline on each other part
  in turn, under the message's one deadline, CBS budget, and write.
- Unlike `translateLLM` it sends the source without `<risu-style>` protection, and runs without the tab's plugin
  interceptor, plugin providers, and `request` trigger.
- A step on a profile sends `profileId` (a deleted profile fails the run, 502); every step runs with the run's
  `modelPresetId`.
- History slots in the prompts of the steps that run are built once per message, when the first pipeline run starts,
  from the run's chat copy (`buildTranslatorHistory`, the counts by `translatorHistorySlotCounts`), each count yielding
  a turn and checking the run before and after it; the same history serves every part and step, in both modes.
- A preset on Exclude Chain-of-Thought strips the reasoning blocks from the whole source once before the As-Is run or
  the line cut (a source left blank stores an empty translation without a request) and from each history entry's source
  and fresh translation (`transformText`, applied by `collectTranslatorHistory` after the freshness check); `sourceHash`
  stays the stored text's.

### Stored translation

- `llmTranslationTarget` (`memoryTranslateMedia`, `"message"` by default, any other value normalized to it) picks the
  LLM translator's path: `"message"` is the stored translation, `"rendered"` the `translateHTML` path with its browser
  cache.
- `translator/storedTranslation.svelte.ts`: `usesStoredTranslation()` (LLM on `"message"`), `freshTranslation(message)`
  (the whole record while its hash matches; an empty text counts), `heldMessage`.
- `requestStoredTranslation(ref, id, { force, follow? })`: one request per message per tab (a second call gets the
  running one). It captures the chat's display ids (`chatDisplayIds`) and the text's hash, saves every pending change,
  POSTs, and validates the answer (`isTranslateMessageAnswer`).
  - The save is `flushResources`. `GenerationBlockedError` alerts `chatGenerating`; a conflict that discarded this
    chat's work or a text or display id changed meanwhile stops with a retry message; a draft of this chat or its
    character's chat order an earlier save left refused stops with `serverJob.refusedDraft`: the server would translate
    its older copy.
  - The POST carries the epoch header and has a 21-minute wait for this tab only: two server deadlines for a request
    that waits on an older text's run, authentication and the body included, and nothing sent once it passed. The run
    continues on the server.
  - It maps 412 to `epochMismatch` (no other alert), 409 `generating`/`chatBindingMismatch` to their strings, `ignored`
    to `translationSourceChanged`, and anything else to `translationFailed` with the server's error or the status.
  - The answer is not displayed by itself: the request stays pending (at most 15 s) until the held message holds the
    stored translation the chat's resource refresh brings, or its text changed.
- `follow` is the server hand-off's: `followStoredTranslations` runs it for each id of a job's `translating` notice
  (`jobChannel.ts`). It skips the save barrier and the stability checks and says nothing on `ignored` or missing display
  ids; the unforced POST joins the run in flight, so the row shows loading until the translation arrives or the run's
  failure is reported.
  - Follow failures go through `follow.report`, which the job channel queues as an `alertError` notice, so one never
    replaces a question the next send shows.
  - A follow that arrives while a request for the message runs (a Continue's hand-off) follows again once it settles,
    the message pending throughout. A run that already ended answers `fresh`, or the POST starts a new run (a failed one
    is tried once more).
  - Notices are best effort: a tab that was disconnected when the job sent one shows no loading state and no failure,
    and gets the translation through its chat refresh.
- The pending set and the rows' show/hide choices are reactive maps keyed by chat and message id, so a remounted row
  keeps both.
- `beginStoredTranslationEdit` captures an edit session (the chat, the message, the source hash, a copy of the fresh
  translation). `saveStoredTranslationEdit` writes `setMessageTranslation` with that hash, the base's `presetId` and
  `targetLanguage`, `translatedAt` now, and `edited: true`, and alerts and returns false when a generation locks the
  message, it is gone, or its text changed (`translationEditStale`); true means queued.

### Chat row on the stored path

This is `Chat.svelte` for a row with a `messageId` in the displayed chat; the greeting and bookmark previews keep the
rendered path.

- The row asks for the translation by its choice, else its chat's `autoTranslate` (`chatAutoTranslate`: the flag while a
  target language is set; it shows stored translations by default; the tab never requests one automatically; the server
  translates a send's messages). It shows the fresh stored translation as `displayMessage`, which goes through
  `risuChatParser` and `ChatBody` like the text.
- The toggle hides the translation when it is on (shown, or asked for and pending); otherwise it shows it and, without a
  fresh translation or a pending request, requests one (a locked message alerts). The toggle's `translating` animation
  is the pending state there.
- Retranslate (disabled while pending) confirms (`retranslateConfirm`) with the message captured before the dialog,
  rechecks it, then requests with `force`.
- Edit translation is enabled only with a fresh translation and nothing pending; a refused save keeps the editor open,
  and an open editor keeps its Save and Cancel whatever the settings do meanwhile.
- The partial editor's translated view is the shown stored translation, edited through a captured session (`stored:<n>`
  keys). Its `saveTranslation` callback returns whether the write was taken, and a refused edit keeps its draft; a save
  that ends after a cancel or a newer edit leaves that editor alone, and saves do not overlap.
- `ChatBody` on the stored path (`storedPath`) renders `msgDisplay` without the rendered translation, applies the
  `edittrans` scripts to a shown stored translation before Markdown (`applyEdittransToStoredTranslation`, as the
  `translateBeforeHTMLFormatting` path does), and shows the loading spinner (`showTranslationLoading`) while a requested
  translation is pending.
- `PartialEditController` never falls back to editing the original from a translated view whose translation context is
  missing (both paths).

### Bilingual display

- `translator/bilingualInterleave.ts` `bilingualInterleave(source, translation, { emphasize, sentenceBreaks })` pairs
  each non-blank unit of the source (a line, or a whole code fence) with the next one of the translation, by position,
  in `x-risu-bilingual-pair` wrappers (the de-emphasized side `x-risu-bilingual-muted`).
- `parser/sentenceBreaks.ts` `insertSentenceParagraphBreaks` first splits prose lines every N sentences
  (`Intl.Segmenter`, never inside an open quote, never in code, HTML, headings, lists, quotes, tables, or rules).
- `Chat.svelte` passes `bilingualDisplay` (the stored message's text after the row's display CBS pre-pass, `displaya`,
  as the translation gets it, and the chat's emphasis and pairing) to `ChatBody` while the stored translation is shown
  and the chat's `bilingualDisplay` is on. `ChatBody` applies `edittrans` to the translation, interleaves, and renders
  through the display path, so the display scripts see the wrappers between the lines.
- Every rendered body goes through `pruneEmptyBilingualPairs` (parsed as a `<template>` fragment, so a leading `<style>`
  is kept; untouched without a pair): sides and pairs that render nothing are dropped, and a pair showing only an image
  keeps one unmuted side.
- The CSS is in `src/styles.css` under `.chattext`. Partial edit is off on a row that shows a pair.

### Translator pipeline and slots

- `shared/translation/pipeline.ts` (pure, shared by the tab and the server runner, so a new slot form reaches both):
  - `translatorStepsToRun`: the enabled steps, else the first.
  - `fillTranslatorSlots` (one pass): `{{slot}}`, `{{slot::from}}`, `{{slot::content}}`/`{{solt::content}}`,
    `{{slot::prev}}`, `{{slot::out::KEY}}` (a `Map`, empty when unset), `{{slot::tnote}}`, and the history slots
    `{{slot::history::N}}`/`{{slot::historytrans::N}}` from the caller's `history`, empty without one or for an invalid
    N.
  - `translatorHistorySlotCounts`: the valid history counts in the executed prompts, by the same one-pass match.
  - `buildTranslatorStepMessages` (with `parseTranslatorChatML`): ChatML wins; else the system prompt, plus the previous
    output as the user message unless the prompt holds an input slot.
    - `stripTranslatorReasoning`: `<Thoughts>`/`<think>` blocks out of every step's output.
  - `translatorPipelineSignature`, `runTranslatorPipeline`.
  - `isProtectedTranslationLine` and `translateProtectingLines`: the line protection without Send Text As-Is, for the
    server runner and the tab's `runTranslator`.
- `shared/translation/historySlots.ts`:
  - `translatorHistoryCount` (all digits, 1 to 50), `translatorHistoryMaxTokens` (a finite number above 0, else 2048).
  - `collectTranslatorHistory`: an optional `transformText` on each source and translation; walking back from the row
    before the message, `disabled: "allBefore"` ends the walk, comment or not, and disabled and comment rows are
    skipped. `source` is the raw `data`, `translated` the fresh `storedTranslation`, an empty one included.
  - `translatorHistoryBlock`: `role: body` then `\n\n---\n\n`, `user` or `char`.
    - `buildTranslatorHistory`: per count, the newest N entries, the oldest whole ones dropped while their source and
      translation blocks, an empty translation block for an entry without one, pass the budget; each entry counted once;
      returns `TranslatorHistory`.
- The tab passes no history, so its history slots fill in empty. CBS is never evaluated in a translator prompt.

### Settings

- `TranslatorPresetSettings.svelte`: `translatorPresets`, `translatorPresetId` (the selected preset's id), the selected
  preset's Send Text As-Is and Exclude Chain-of-Thought checks (`true`, or the field deleted), and its steps
  (`TranslatorStepEditor.svelte`, one per step): name, enabled, move up/down, remove (confirmed; not the last step),
  model (the `translate` slot, or a model profile; a deleted one shown missing), response size, output key, and prompt.
  - "Add step" works up to `TRANSLATOR_PRESET_MAX_STEPS` (`createTranslatorStep`). A note says the first step runs when
    none is enabled. Deleting a model profile lists the translator presets with a step on it
    (`translatorPresetsUsingModelProfile`, `collectionStore.svelte.ts`).
- The Translation settings page (`TranslationSettings.svelte`, menu 21, `/settings/translation`; its items in
  `src/ts/setting/translationSettingsData.ts`, sections Translator, Behavior, Experimental, Cache,
  [settings-i18n](settings-i18n.md)) holds every translator setting; the Language page keeps only the UI language.
  Behavior also holds `adv.noWaitTrans` and `acc.showTranslationLoading`, Experimental `adv.exp.googleTrans` (shown
  while experimental features are on).
  - `lang.llmTranslationTarget` (a select, LLM translator only) follows the preset editor;
    `lang.translatorHistoryMaxTokens` (a number) follows it for the LLM translator on `"message"`, and writes only a
    finite number above 0 (a cleared field writes nothing).
  - `legacyTranslation` is shown for every translator but the LLM one on `"message"`, and
    `translateBeforeHTMLFormatting` and `autoTranslateCachedOnly` only for the LLM translator on `"rendered"`. Hidden
    toggles keep their values and still drive the rows that keep the rendered path. The cache buttons stay for the LLM
    translator.
  - Auto-translate is not on this page: it is a [chat setting](#state).

## Flows

- `ChatBody.svelte` uses `translateHTML` on the rendered path when its chat settings allow it. Streaming rows show the
  original until streaming ends; the stored path renders the saved translation as text.
- Input translation: `DefaultChatScreen` through `src/ts/process/inputTranslation.svelte.ts` `createInputTranslation`
  ([chat-pipeline](chat-pipeline.md)), when `useAutoTranslateInput`.

## State

- Chat translation settings: the chat fields `translatorPresetId`, `autoTranslate`, `translateBotOnly`,
  `bilingualDisplay`, `bilingualEmphasis`, `bilingualSentences`, stored as sent and carried by the chat summary (list
  fields, `CHAT_TRANSLATION_FIELD_TYPES`), read through `shared/translation/chatSettings.ts`
  (`readChatTranslationSettings`: missing or malformed is off/unset). The global `autoTranslate` is a dropped field, not
  copied anywhere.
  - `resolveTranslatorPreset(chat, presets, selectedId)`: the chat's preset when it names one that exists, else the
    global selection (`selectedTranslatorPreset`), reporting `missing` for a deleted one; nothing is rewritten when a
    preset is deleted. The server runner resolves the translated chat's; the tab
    (`src/ts/translator/chatTranslation.svelte.ts`) the selected chat's.
  - A new chat copies the character's selected chat's six fields under `newChatBinding: "inherit"`
    (`initialChatTranslation`, a deleted preset id kept) and none under `"empty"`; copies and branches keep them;
    `importChat` keeps them but drops a `translatorPresetId` that names no preset here (`importedChatTranslation`).
  - The chat panel's `ChatTranslationPanel.svelte` (in `OpenChatPanel`, while a target language is set) edits
    auto-translate and, for the LLM translator, the chat's preset ("Global (<name>)", or "Deleted, using global").
  - With the stored translation and auto-translate on, the panel adds "bot replies only" (`translateBotOnly`: a send
    hands over only its replies; it limits the automatic requests, not what a row shows); with the stored translation,
    it adds the bilingual display check and, while it is on, its emphasis and pairing selects (line, or 1–10 sentences;
    unset is the default). The suggestions' translate toggle starts from the chat's flag.
- Translator DB fields: `translatorType`, `translator`, `translatorInputLanguage`, `translatorPresets`,
  `translatorPresetId` (an id; both travel in the `translatorPresets` record as `{ items, selectedId }`),
  `llmTranslationTarget`, `translatorHistoryMaxTokens` (2048 by default; the normalizer turns a value at or below 0 into
  it), `combineTranslation`, ...

## Coupling

- The translator depends on the parser (`ParseMarkdown`, `applyMarkdownToNode`, `postTranslationParse`,
  `risuChatParser`), `requestChatData`, the script transform (`serverProcessScript`), platform flags, and localforage.
- The Translation settings page and its items are registered by [settings-i18n](settings-i18n.md); the chat's
  translation fields travel with the chat summary ([chat-store](chat-store.md)), and the composer's input translation is
  [chat-pipeline](chat-pipeline.md)'s.

## Invariants

- Server translation preserves a failed WebLLM request's `localModelRefusal` status: 429 for a full local model queue,
  503 for an expired queue wait. Other failed provider requests remain 502 with their redacted failure text.
- Keep the `.risutl` format constants stable.
- A translator preset always has 1 to 5 steps: the server normalizer (`normalizeTranslatorSteps` through
  `createTranslatorPreset`) turns the old `{ prompt, maxResponse }` shape into one inherited step. The tab creates and
  imports presets with `createTranslatorPreset`, so what it writes is what the server stores.
- The step editor finds each step by the preset's id and the step's id at every read and write (nested steps have no
  by-id identity in the records) and writes only what the normalizer keeps as is: a blank name and an invalid or already
  used output key stay local drafts, shown with a hint and dropped for good once the stored value they were typed over
  (for a key, also the other steps' keys) changes; a cleared or invalid response size is not written, and the field
  shows the stored size again when committed. So the tab's copy stays the server's normalized text.
- `translateHTML` must preserve markup boundaries and the `translate=no`/`script`/`style` skips. It applies `edittrans`
  after translating (`applyEdittransRegex`: the one regex the tab still runs, a plain `RegExp` replacement with no Lua
  or trigger). Its `editdisplay` call runs on the server (`serverProcessScript`, target kind `translation`), with the
  context captured when `translateHTML` starts; without a context (a chat not saved on the server yet) the translated
  text stays as it is.

## Recipes

`translateMain`, `runTranslator`, or `translateHTML`, plus DB defaults. Verify `ChatBody`, input translation, the LLM
cache, and `translateVox`. A stored-path change: `storedTranslation.svelte.ts` and the `storedPath` branches of
`Chat.svelte`, `ChatBody.svelte`, and `PartialEditController.svelte`; verify the rendered path is unchanged.

## Tests

Runner, slow-test, and timing rules belong to [test-harness](test-harness.md). This area has no `slow` tests.

- `e2e`: `e2e/welcomeAndChatSettings.spec.ts` drives the auto-translate input.
- Translation in the tab and shared code:
  `pnpm --silent test:agent src/ts/translator shared/tests/translat*.test.ts shared/tests/chatTranslationSettings.test.ts`.
- Server translation: `pnpm --silent test:agent server/src/tests/translate.test.ts`.
- Chat row:
  `pnpm --silent test:agent src/lib/ChatScreens/Chat.test.ts src/lib/ChatScreens/PartialEditController.test.ts src/lib/SideBars/ChatTranslationPanel.test.ts`.
- Server translation uses `Echo`, a temporary store, and fake LLM requests and token counts.
- Not tested: mounted bilingual rendering.

## Known Hazards

### Issues

- `translatorType: 'none'` has no branch in `translateMain` and falls through to Google.
