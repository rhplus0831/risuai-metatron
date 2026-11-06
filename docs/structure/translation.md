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

- `src/ts/translator/translator.ts`: tab providers and rendered translation; `translate`, `runTranslator`,
  `translateMain`, `memoryTranslationContext`, `translateVox`, `isExpTranslator`, `translateHTML`,
  `applyEdittransRegex`, `applyEdittransToStoredTranslation`; the `runTranslator` comment owns chunking, Exclude
  Chain-of-Thought, prepared-chunk cache keys and failures; the `translateHTML` comment owns signals, permits, attempt
  failure, shared flights and LLM regeneration/cache-write rules.
- `src/ts/characters.ts` `exportChat`: translated chat exports also call `translateHTML` with the export's captured
  transform ([characters-modules](characters-modules.md)).
- `server/src/data/normalize/memoryTranslateMedia.ts`: persisted translator normalization;
  `normalizeMemoryTranslateMedia`. Stored `translatorType: "bergamot"` becomes `"google"` with `translator` empty and
  `useAutoTranslateInput` off: translation and chat auto-translate remain inactive until the user enables translation
  again. `htmlTranslation` is dropped.

### LLM translation

- `src/ts/translator/translator.ts`: LLM adapter and browser cache; `translateLLM`, `llmTranslationContext`,
  `getCurrentTranslatorPreset`, `llmTranslationCacheKey`, `readLLMCacheEntry`, `writeLLMCacheEntry`, `getLLMCache`,
  `searchLLMCache`, `exportLLMCacheAsJSON`, `importLLMCacheFromJSON`, `clearLLMCache`.
- `shared/translation/hash.ts`: stored-source and cache-context hashing; `translationSourceHash`.

### Presets and `.risutl`

- `src/ts/translator/presets.ts`: selection adapter and cross-user `.risutl` codec;
  `getCurrentTranslatorPresetFromState`, `encodeTranslatorPresetFile`, `decodeTranslatorPresetFile`,
  `getTranslatorPresetDownloadName`, `translatorPresetFileExtension`, `translatorPresetImportExtensions`.
- `shared/translatorPresets.ts`: preset creation, normalization and validation; `createTranslatorPreset`,
  `createTranslatorStep`, `normalizeTranslatorSteps`, `isTranslatorPreset`, `defaultTranslatorPrompt`,
  `TRANSLATOR_PRESET_MAX_STEPS`.
- `shared/settings.ts`: persisted preset and step types; `TranslatorPreset`, `TranslatorStep`, `TranslatorStepModel`.

### Server translation

- `server/src/translation/runner.ts`: detached stored-message translator; `createTranslationRunner`, `handOff`,
  `TRANSLATION_DEADLINE_MS`, `MAX_RUNNING_TRANSLATIONS`.
- `server/src/routes/translate.ts`: authenticated HTTP boundary; `registerTranslateRoutes`
  ([server-generation](server-generation.md)).
- `shared/translation/route.ts`: tab/server request and answer contract; `TRANSLATE_MESSAGE_PATH`,
  `TranslateMessageBody`, `TranslateMessageAnswer`, `isTranslateMessageAnswer`.

### Stored translation

- `src/ts/translator/chatTranslation.svelte.ts`: tab chat settings and preset resolution; `chatTranslationSettings`,
  `chatAutoTranslate`, `chatTranslatorPreset`, `currentTranslatorPreset`, `globalTranslatorPreset`,
  `setChatTranslationSettings`, `initialChatTranslation`, `importedChatTranslation`.
- `shared/translation/chatSettings.ts`: shared chat-list fields, defaults and preset fallback;
  `CHAT_TRANSLATION_FIELD_TYPES`, `readChatTranslationSettings`, `resolveTranslatorPreset`, `selectedTranslatorPreset`.
- `src/ts/translator/storedTranslation.svelte.ts`: tab requests, display choices and edit sessions;
  `usesStoredTranslation`, `freshTranslation`, `heldMessage`, `requestStoredTranslation`, `followStoredTranslations`,
  `isStoredTranslationPending`, `storedTranslationChoice`, `setStoredTranslationChoice`, `beginStoredTranslationEdit`,
  `saveStoredTranslationEdit`.
- `shared/translation/messageTranslation.ts`: stored-record validation and freshness; `isMessageTranslation`,
  `storedTranslation`, `dropInvalidTranslation`.

`llmTranslationTarget` selects the LLM path: `"message"` stores translations on messages; `"rendered"` uses
`translateHTML` and its browser cache. The `memoryTranslateMedia` normalizer accepts both; other values default to
`"message"`.

### Chat row on the stored path

- `src/lib/ChatScreens/Chat.svelte`: row display and translation controls; `storedPath`, `storedWanted`,
  `displayMessage`, `toggleStoredTranslation`, `requestRetranslation`, `getTranslationPartialEditContext`,
  `savePartialTranslation`.
- `src/lib/ChatScreens/ChatBody.svelte`: translation rendering; `markParsing`, `storedPath`, `storedTranslationShown`,
  `showTranslationLoading`.
- `src/lib/ChatScreens/PartialEditController.svelte`: partial-edit dispatch and draft retention; `translatedView`,
  `saveTranslation`, `writeTranslation`.

The stored path requires a `messageId` in the displayed chat. Greeting and bookmark previews keep the rendered path.

### Bilingual display

- `src/ts/translator/bilingualInterleave.ts`: positional Markdown pairing and rendered-pair pruning;
  `bilingualInterleave`, `BilingualInterleaveOptions`, `BILINGUAL_PAIR_CLASS`, `BILINGUAL_MUTED_CLASS`,
  `pruneEmptyBilingualPairs`, `pruneEmptyBilingualPairsIn`.
- `src/ts/parser/sentenceBreaks.ts`: sentence grouping before bilingual pairing; `insertSentenceParagraphBreaks`.
- `src/styles.css`: bilingual wrapper styling under `.chattext`; `x-risu-bilingual-muted`.

Partial edit is off on a row that shows a pair.

### Translator pipeline and slots

- `shared/translation/pipeline.ts`: shared prompt/step execution and line protection; `translatorStepsToRun`,
  `fillTranslatorSlots`, `translatorHistorySlotCounts`, `buildTranslatorStepMessages`, `parseTranslatorChatML`,
  `stripTranslatorReasoning`, `translatorPipelineSignature`, `runTranslatorPipeline`, `isProtectedTranslationLine`,
  `translateProtectingLines`.
- `shared/translation/historySlots.ts`: bounded source/translation history; `translatorHistoryCount`,
  `translatorHistoryMaxTokens`, `collectTranslatorHistory`, `translatorHistoryBlock`, `buildTranslatorHistory`.

The pure pipeline serves both tab and server, so a new slot form reaches both. Only the server builds history; the tab's
history slots fill in empty. CBS is never evaluated in a translator prompt.

### Settings

- `src/lib/Setting/Pages/Translation/TranslatorPresetSettings.svelte`: global preset list and selection editor;
  `current`, `addStep`, `setSendTextAsIs`, `setExcludeThoughts`.
- `src/lib/Setting/Pages/Translation/TranslatorStepEditor.svelte`: per-step controls and drafts; `liveStep`, `setName`,
  `setModel`, `setMaxResponse`, `setOutputKey`, `move`, `remove`, `missingProfileId`.
- `src/ts/storage/collectionStore.svelte.ts`: model-profile deletion dependencies; `translatorPresetsUsingModelProfile`
  lists translator presets with a step on the deleted profile.
- `src/lib/Setting/Pages/TranslationSettings.svelte`: Translation page composition; `translationSettingsHeader`,
  `translationSettingsSections`. Menu 21, `/settings/translation` holds all translator settings; Language keeps only the
  UI language ([settings-i18n](settings-i18n.md)).
- `src/ts/setting/translationSettingsData.ts`: Translation page items and sections; `translationSettingsItems`,
  `translationSettingsSections`. Sections: Translator, Behavior, Experimental, Cache. Behavior holds `adv.noWaitTrans`
  and `acc.showTranslationLoading`; Experimental holds `adv.exp.googleTrans`, shown while experimental features are on.

`lang.llmTranslationTarget` follows the preset editor for the LLM translator; `lang.translatorHistoryMaxTokens` follows
it on `"message"`. `legacyTranslation` shows except for LLM on `"message"`; `translateBeforeHTMLFormatting` and
`autoTranslateCachedOnly` show only for LLM on `"rendered"`. Hidden toggles retain their values and still drive previews
on the rendered path; cache buttons remain for LLM. Auto-translate is a [chat setting](#state).

## Flows

### Rendered translation

1. `src/lib/ChatScreens/ChatBody.svelte` calls `translateHTML` according to chat settings. Streaming rows show the
   original until streaming ends. Normally `ParseMarkdown` runs first; LLM's `translateBeforeHTMLFormatting` sends raw
   text first. `src/ts/characters.ts` `exportChat` also translates parsed chat text with a captured export transform.
2. `src/ts/translator/translator.ts` uses the selected chat's preset, falling back to global; the playground passes
   `globalPreset`. Its LLM adapter runs `shared/translation/pipeline.ts` through `requestChatData` in translate mode.
   With a captured context, combined paragraphs rerun `editdisplay` through `serverProcessScript` (target `translation`)
   before Markdown. DOM jobs finish before `applyEdittransRegex`. LLM results go directly to that regex. See
   `translateHTML` for traversal, cancellation, queue, and cache rules.
3. The translation editors in `src/lib/ChatScreens/Chat.svelte` capture `llmTranslationCacheKey(text)`, then read and
   write that full key with `readLLMCacheEntry`/`writeLLMCacheEntry`, so a later settings switch cannot redirect the
   edit.

### Stored request and refresh

1. `src/ts/translator/storedTranslation.svelte.ts` `requestStoredTranslation` captures `chatDisplayIds` and the source
   hash, then saves all pending changes through `flushResources`: the server must translate this tab's text. Generation
   locks (`GenerationBlockedError`), discarded chat work, and refused chat/chat-order drafts stop the request.
2. After saving, a changed source reports `translationSourceChanged`; changed display ids report `chatBinding.mismatch`.
   The epoch-bearing POST to `/api/translate/message` enters `server/src/routes/translate.ts`, then
   `server/src/translation/runner.ts`, using the body/answer contract in `shared/translation/route.ts`.
3. The runner translates the stored source and writes `Message.translation` with `setTranslation`. Its `chats` resource
   event refreshes the tab's held chat. `isTranslateMessageAnswer` validates the HTTP answer; the answer is never shown
   directly. The request remains pending until the held message contains it, disappears, or changes source, bounded by a
   15-second refresh wait.

### Send hand-off

1. A finished send hands its messages to `server/src/translation/runner.ts` `handOff` without waiting for translation;
   `translateBotOnly` limits this to replies. The job's `translating` notice reaches `src/ts/network/jobChannel.ts`,
   which calls `followStoredTranslations` in `src/ts/translator/storedTranslation.svelte.ts` for the handed-off ids.
2. Following skips the save barrier and stability checks: the server just wrote its copy and the next send may already
   block a save. An unforced POST joins the run; the row stays loading until the held translation arrives or failure is
   reported. `follow.report` queues an `alertError` notice behind any question, so it cannot replace the next send's
   question.
3. Notices are best effort: a tab disconnected when the job sent one has no loading state or failure notice, but still
   gets the stored translation through its chat refresh.

### Stored display and edits

- `src/lib/ChatScreens/Chat.svelte` chooses explicit show/hide, else `chatAutoTranslate` while a target language is set.
  It shows a fresh stored record as `displayMessage`, through `risuChatParser` and `ChatBody`; it never automatically
  requests translation. `ChatBody`'s `storedPath` renders `msgDisplay` without `translateHTML`, applies
  `applyEdittransToStoredTranslation` before Markdown when shown, and shows the pending spinner only with
  `settings.ui.showTranslationLoading` on (settings item `acc.showTranslationLoading`).
- A fresh translation with nothing pending enables editing. `beginStoredTranslationEdit` captures the session;
  `saveStoredTranslationEdit` queues `setMessageTranslation`. Refusal keeps the editor open, and an open editor retains
  Save and Cancel across settings changes.
- `src/lib/ChatScreens/PartialEditController.svelte` uses `Chat.svelte`'s `saveTranslation` callback for the shown
  stored translation. A false result retains its draft; saves do not overlap, and a completion after cancel or a newer
  edit leaves that editor alone. Both translation paths refuse a missing translation context instead of editing the
  original.

### Bilingual rendering

1. With a stored translation shown and chat `bilingualDisplay` on, `src/lib/ChatScreens/Chat.svelte` passes the stored
   source after the row's display CBS pre-pass (`displaya`), plus the chat's emphasis and pairing, to `ChatBody`.
2. `src/lib/ChatScreens/ChatBody.svelte` applies `edittrans` to the translation, calls `bilingualInterleave` (sentence
   grouping via `src/ts/parser/sentenceBreaks.ts`), then renders through the display path. Display scripts see the pair
   wrappers between the lines.
3. Every rendered body is pruned: `pruneEmptyBilingualPairs` on the string path, `pruneEmptyBilingualPairsIn` on the
   parsed-tree/style-sharing path, from `src/ts/translator/bilingualInterleave.ts`.

### Input translation

`DefaultChatScreen` uses `src/ts/process/inputTranslation.svelte.ts` `createInputTranslation` when
`useAutoTranslateInput` ([chat-pipeline](chat-pipeline.md)).

## State

- Browser LLM cache: LocalForage `LLMTranslateCache` (`LLMCacheStorage` in `src/ts/translator/translator.ts`) uses
  `llm:<hash>:<source>` keys, separate from stored `Message.translation`. See `llmCacheKeyPrefix` for hash inputs and
  legacy-key compatibility. Beside it: `llmInFlight` and `llmGenerations`, per key in flight.
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
- Plugin API v3 cache lookups (`getLLMCache`, `searchLLMCache`) take source text in the current translation context.
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
- Both `translateHTML` paths apply `edittrans` last (`applyEdittransRegex`: the one regex the tab still runs, a plain
  `RegExp` replacement with no Lua or trigger); the DOM skip rules are the `translateHTML` comment.

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
- `translateHtmlLifetime.test.ts` and `translateHtmlWorkers.test.ts` stub the Google `fetch`; the workers test holds
  each answer, reading the open-request count at its peak.
- Not tested: mounted bilingual rendering.

## Known Hazards

### Issues

- `src/ts/translator/translator.ts` `translateMain` has no `translatorType: "none"` branch, so an older save retaining
  that accepted value falls through to Google (`shared/database.ts` still includes `"none"` in the field type).
