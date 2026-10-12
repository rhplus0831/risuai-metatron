# Translation Plan

Status: slices 1.1–1.5, 2.1–2.4, and 3.1–3.4 done (2026-10-12); phase 4 is optional. No open questions.

Bring the useful part of the Fastify fork's translation work into metatron:
translations stored on the message, per-chat translation settings, automatic
translation of generated replies on the server, bilingual display (paired by
line or by sentences), and multi-step LLM translator presets.

Reference: `/home/codex/risuai-fastify` (`docs/structure/translation-and-input-hooks.md`,
`packages/shared-core/src/translatorPipeline.ts`, `src/ts/translator/bilingualInterleave.ts`,
`src/ts/parser/sentenceBreaks.ts`, `server/fastify/src/translation/`). This plan
takes its ideas and its pure helpers, not its storage, its job registries, or
its file formats. Nothing is imported from a Fastify database or file.

## Today

- Translation is display-time and runs in the tab (`src/ts/translator/translator.ts`):
  `ChatBody.svelte` `markParsing` renders the message (the server transform,
  `parser/transformClient.ts`), then `translateHTML` translates the rendered
  HTML (or, with `translateBeforeHTMLFormatting`, an LLM translates the
  `pretranslate` text before markdown).
- Results live in the tab's LocalForage `LLMTranslateCache` keyed by the
  source text, so another device or browser does not see them.
- `autoTranslate`, the translator type, and the languages are global
  (`memoryTranslateMedia` section). The selected translator preset is the
  shared `translatorPresets.selectedId`.
- A translator preset is `{ id, name, prompt, maxResponse }`
  (`shared/settings.ts`, `shared/translatorPresets.ts`).
- LLM translation calls `requestChatData(..., "translate")`. The slot comes
  from the model preset (`shared/llm/modelSlots.ts` `resolveSlotProfile`).
  A request cannot name a profile of its own.

## Product decisions

1. **Two paths coexist.** A _stored translation_ (new) translates the
   message's source text and stores it on the message. The _rendered
   translation_ (today's HTML path) stays for the non-LLM translators (Google,
   DeepL, DeepLX) and keeps its browser cache.
2. **A stored translation goes stale only when its source changes.**
   Changing the translator, its preset, or its model keeps every stored
   translation. Retranslate is the explicit way to refresh one.
3. **Translation settings move to the chat.** The global `autoTranslate` is
   removed. Each chat holds its own settings. A new chat takes them like its
   binding: `newChatBinding: "inherit"` copies the same character's previous
   chat, and `"empty"` starts with translation off.
4. **A chat's translator preset falls back.** A chat may name a translator
   preset. When it names none, or one that was deleted, the global selection
   is used. This is not the fail-closed rule of the chat binding: translation
   is optional and never blocks a send.
5. **Bergamot is removed.** The local browser translator cannot run on the
   server, and it is not kept as a tab-only exception.
6. **Multi-step translator presets are kept.** The runtime lands in phase 1,
   so the server runner is written once. The step editor lands in phase 3.
7. **Bilingual display pairs by line or by every N sentences.** The pairing
   is positional (the k-th chunk of the source beside the k-th chunk of the
   translation), as in Fastify. A translation that merges or splits sentences
   shifts the pairs after that point. That is accepted. Exact alignment
   (translating numbered segments) is out of scope and can be added later as
   an optional field.
8. **No Fastify compatibility.** Fastify translator presets, `.risutl` v2
   files, and stored translations are not read. Users recreate their presets.
9. **The LLM translator keeps a rendered-output mode** (was Q1). Translating
   the source text does not translate text that the display scripts add
   (`editdisplay` regexes, Lua display triggers, for example a status panel);
   the rendered path does. A global option, `llmTranslationTarget`
   (`"message"` or `"rendered"`, in the `memoryTranslateMedia` section,
   default `"message"`), picks the path for the LLM translator: `"message"` is the
   stored translation, `"rendered"` is today's code and browser cache with
   its `legacyTranslation` / `translateBeforeHTMLFormatting` toggles. The
   phase 2 and 3 features that need a stored translation (server
   auto-translation, bilingual display, history slots) apply only under
   `"message"`.
10. **No migration of existing chats** (was Q2). A chat without the
    translation fields reads as translation off. There are no chats to keep
    yet, so the global `autoTranslate` is dropped without copying its value.

## Data model

```ts
// shared/database.ts
interface Message {
  // ...
  /** A stored translation of `data` (docs/plan/translation.md). Shown only while fresh. */
  translation?: MessageTranslation;
}

interface MessageTranslation {
  text: string;
  /** `translationSourceHash(data)` at translation time. */
  sourceHash: string;
  /** Informational: what produced it. Never used to decide freshness (decision 2). */
  presetId?: string;
  targetLanguage: string;
  translatedAt: number;
  /** True after the user edited the text by hand. */
  edited?: boolean;
}
```

- `translationSourceHash(text)` in `shared/translation/hash.ts`: cyrb53 with
  seed 0 over the UTF-16 code units, a 53-bit value written as 14 hex digits.
  It is synchronous and non-cryptographic. It must not use `crypto.subtle`:
  the tab runs it while rendering, and `crypto.subtle` is missing on
  plain-HTTP origins. The algorithm is pinned: changing it makes every stored
  translation stale.
- `storedTranslation(message)`: the text when `sourceHash` matches the
  current `data`, else `null`. This read-time check is the only freshness
  rule. No edit path has to remember to clear the field, so server-side edits
  (triggers, Lua, `editoutput`) and tab edits are covered alike. Fastify
  cleared the field on each edit path and kept missing some.
- A new chat op, `{ op: "setTranslation"; id: string; translation: MessageTranslation | null }`
  (`shared/chats.ts` `ChatOp`, `server/src/data/chatStore.ts`). It applies only
  when `translation` is null, or when its `sourceHash` matches the stored
  message's current `data`. Otherwise it is `ignored`, so a translation of a
  text that was edited meanwhile never lands. The group result reports each
  one (`translations`: `applied` or `ignored`). The tab never coalesces these
  ops, since dropping an earlier one could change the result.
- `setMessage` never changes a stored `translation`: the stored one (or its
  absence) replaces whatever the sent message carries. Only `setTranslation`
  and `replace` change it, and `create` / `append` can start one. This stops
  a tab that writes a whole message from a copy older than the translation
  from dropping it or putting an older one back. `setText` leaves it alone (it
  goes stale by hash).
- A `translation` that is not a `MessageTranslation` (including a Fastify
  one) is dropped, not refused, by the server's `normalizeMessage` and by the
  tab's chat module when it takes messages in, so both hold the same copy.
- Chat fields (phase 2), stored as sent like the binding fields (D2), and
  read as unset when missing:
  `translatorPresetId?: string`, `autoTranslate?: boolean`,
  `translateBotOnly?: boolean`, `bilingualDisplay?: boolean`,
  `bilingualEmphasis?: "original" | "translation"`,
  `bilingualSentences?: number` (0 or unset pairs by line; 1–10 pairs every
  N sentences). They are list fields (the chat summary carries them, as
  built in 2.1): a new chat inherits them from the character's selected
  chat, which may not be loaded.
- `TranslatorPreset` (phase 1) gains
  `steps: TranslatorStep[]` (1–5 steps) with
  `TranslatorStep = { id, name, enabled, prompt, maxResponse, model, outputKey? }`
  and `model: { mode: "inherit" } | { mode: "profile"; profileId: string }`.
  The `translatorPresets` normalizer (`server/src/data/normalize/collections.ts`)
  turns `{ prompt, maxResponse }` into one inherited step and drops both
  fields. `translatorPrompt` / `translatorMaxResponse` are already dropped
  root fields (`shared/sections.ts`), so nothing mirrors the first step.

## Phases and slices

### Phase 1. Stored translation (LLM)

1.1 **Schema and op.** `MessageTranslation`, `translationSourceHash`,
`storedTranslation`, the `setTranslation` op, and the `setMessage`
preservation rule. The tab's chat module gets `setMessageTranslation(ref, id, translation)`
(by chat id and message id, D1). Server tests: the op applies on a matching
hash, is ignored on a stale one, and clears with `null`; `setMessage` without
the key keeps it. Tab test: the op travels through the chat module's batch.

1.2 **Pipeline core and preset steps.** Port Fastify's pure pipeline to
`shared/translation/pipeline.ts`:

- step selection (the enabled steps, or the first step when none is enabled);
- the slots `{{slot}}`, `{{slot::from}}`, `{{slot::content}}`
  (and the `{{solt::content}}` typo), `{{slot::prev}}`, `{{slot::out::key}}`,
  and `{{slot::tnote}}`;
- the ChatML parse;
- stripping `<Thoughts>` and `<think>` from every step's output.

Add the `steps` schema and its normalizer migration. The tab's `translateLLM`
runs through the pipeline (every step on the `translate` slot until 3.1), and
its `LLMTranslateCache` key includes the pipeline signature.
`TranslatorPresetSettings.svelte` keeps editing one prompt: the first step's.
Tests: the pipeline (pure), and the normalizer migration (old shape, empty
steps, more than five).

As built:

- The pipeline evaluates no CBS. The tab's old ChatML path ran `risuChatParser`
  on every ChatML message (the substituted source included) and cut
  `<Thoughts>` out of it; both are gone. A non-ChatML prompt with an input slot
  is sent as one system message.
- The slots are filled in one pass, so text filled in is never read for slots.
- The `LLMTranslateCache` key hashes the pipeline signature, the languages, and
  the translator note. Entries keyed by the bare source are dropped without a
  migration (a browser cache, separate from decision 10). The tab's in-memory
  `translate` cache is skipped for the LLM translator.
- `.risutl` stays version 1 and holds the single step; exporting a preset with
  more than one step or a step on a profile is refused until 3.1.
- The tab's run does not pin the model preset: each step is a chatless request
  that resolves it when it starts, so switching chats during a multi-step run
  can move the later steps to another model preset. Nothing creates such a
  preset before 3.1, and the server runner (1.3) runs every step with the
  `modelPresetId` it was given. Pinning a chatless request's presets (a
  captured scope in `request.ts` and `transport.ts`) belongs with 3.1's
  per-call profile.
- Tests: `shared/tests/translatorPipeline.test.ts`,
  `shared/tests/translatorPresets.test.ts`, the migration cases in
  `server/src/tests/normalizeCollections.test.ts`,
  `src/ts/translator/translatorLLM.test.ts` (the cache key and the run), the
  export refusal in the codec tests, and the first step's editor in
  `TranslatorPresetSettings.test.ts`. The boot fixture carries the steps shape.

1.3 **Server translation runner.** `POST /api/translate/message`
`{ characterId, chatId, messageId, modelPresetId, force? }`:

- `modelPresetId` is what the tab shows, as chat-binding decision 10 does
  for chatless requests: the chat's bound model preset where it exists, else
  the tab's.
- The server:
  1. reads the message;
  2. refuses while the message is locked by a generation;
  3. resolves the translator preset (the chat's, else the global one), the
     languages, and the character's `translatorNote`;
  4. runs the pipeline through the in-process request layer on the
     `translate` slot;
  5. writes `setTranslation` with the source hash it read in step 1.
- There is one in-flight translation per message (a server map). A second
  request for the same message joins it. `force` is the retranslate.
- The work runs to its end even if the tab disconnects (bounded by a
  deadline), and the tab sees the result through its `chats` resource event.
- Shutdown and maintenance abort it like a job.

Server tests use the `Echo` model: a stored write, a stale source (edited
during the request) ignored, a join, a locked message refused.

As built:

- The body is `{ characterId, chatId, messageId, presetId, modelPresetId,
personaId, force? }`: the server's request settings also need a prompt
  preset and a persona, so the tab sends the chat's three display ids
  (`chatDisplayIds`), as for a script transform. The runner loads the chat
  under the display rule: a field bound to an existing record must be sent as
  bound (409 `chatBindingMismatch`); an unset or deleted one takes the sent id,
  whose record must exist (404). Slice 1.4's caller sends these ids.
- The answer is `{ outcome, translation }`: `applied`, `ignored` (the text
  changed during the run; `translation: null`, translate again), or `fresh` (a
  fresh stored translation, not forced). Errors: 404, 409 `generating` or
  `chatBindingMismatch` or a replaced chat, 429 (16 running), 502 (the request
  failed), 503 (maintenance, shutdown), 504 (10-minute deadline).
- A request for a message in flight joins its run after its own ids pass the
  display rule; `force` neither cancels nor queues behind it.
- The run is a detached in-process job without a tab: no plugin interceptor,
  plugin provider, `request` trigger, tool, or inlay. Its CBS (stop strings)
  runs over the chat with one budget and writes nothing. The source is sent
  without the tab's `<risu-style>` protection.
- At most 16 runs' work may be unsettled (429), ended runs whose request has
  not stopped included. The 10-minute deadline is read from the clock at every
  check, and each attempt yields to the event loop first.
- An ended run (deadline, maintenance, shutdown) settles its callers at once
  and never writes: the write checks the run's signal, shutdown, the
  maintenance gate, and the epoch in the call that applies it.
- Tests: `server/src/tests/translate.test.ts` (the four `Echo` cases of the
  slice text, the route's admission, maintenance, shutdown, a disconnected
  tab, and the runner's lifecycle over a fake request layer).

1.4 **Display and controls.**

- Add `llmTranslationTarget` (decision 9): the `memoryTranslateMedia`
  section field, its normalizer default `"message"`, and a select on the
  language settings page shown for the LLM translator, which shows the
  `legacyTranslation` / `translateBeforeHTMLFormatting` toggles only under
  `"rendered"`.
- With the LLM translator on `"message"`, the translate toggle in `Chat.svelte` shows the
  stored translation: the message renders through the normal display path
  with `storedTranslation(message)` as its text.
- With no fresh stored translation, the toggle calls the runner and shows the
  loading state.
- Retranslate asks for confirmation first, then calls the runner with `force`.
- "Edit translation" edits the stored text and writes it with `edited: true`.
- The partial editor's translated view (`PartialEditController.svelte`) edits
  the stored text.

The non-LLM translators, and the LLM translator on `"rendered"`, keep the
rendered path unchanged.

As built:

- The stored path is per row: a row of a stored message (`Chat.svelte` with a
  `messageId` in the displayed chat). The greeting (no stored message until
  phase 4), the bookmark previews, and the welcome rows keep the rendered path
  under `"message"` too; the toggles hidden on the language page keep their
  values for them.
- The global `autoTranslate` reads, on the stored path, as "show stored
  translations by default" and never requests one (interim until 2.1 and 2.3).
  A row's own show/hide choice wins and survives its remount (kept by chat and
  message id in `src/ts/translator/storedTranslation.svelte.ts`, as is the
  pending state).
- The toggle: on (shown, or asked for and pending) → off; otherwise on, and a
  request when there is no fresh translation and none pending. A failed
  request leaves nothing shown, so the next click retries.
- The runner's answer is not displayed by itself: the request stays pending
  until the held message holds the translation (the chat's resource refresh),
  at most 15 s. Before the POST the tab saves every pending change
  (`flushResources`), so a translation can wait on unrelated work; a
  generation blocking that save alerts `chatGenerating`.
- Edit translation needs a fresh stored translation and nothing pending. Both
  editors capture the edit session (chat, message, source hash, base
  translation) when they open; the write keeps the base's `presetId` and
  `targetLanguage` and sets `translatedAt` and `edited: true`. A refused write
  (locked, gone, the text changed) keeps the draft. Same-source edits from two
  places are last-writer-wins, as is a runner result that lands after an edit.
- The `edittrans` scripts apply to a shown stored translation before Markdown,
  as on the `translateBeforeHTMLFormatting` path.
- The partial editor never edits the original from a translated view whose
  translation context is missing (both paths): it shows the match failure.
- Tests: `shared/tests/translateRoute.test.ts`,
  `src/ts/translator/storedTranslation.test.ts` (the request, the barrier,
  the wait, the answers, the edit session),
  `src/lib/ChatScreens/Chat.test.ts` (the mounted row: display, toggle,
  requests, Retranslate, the full editor, the rendered path kept),
  `src/lib/ChatScreens/PartialEditController.test.ts` (the session-guarded
  translation writes), `src/ts/setting/languageSettingsData.test.ts`, the
  `applyEdittransToStoredTranslation` cases in `edittransRegex.test.ts`, and
  the normalizer case in `server/src/tests/normalizeSections.test.ts`. The
  boot fixture carries `llmTranslationTarget: "message"`.

1.5 **Remove Bergamot.** Remove:

- `src/ts/translator/bergamotTranslator.ts` and its branch in `translator.ts`;
- the `@browsermt/bergamot-translator` dependency and its `vite.config.ts`
  exclude;
- `public/assets/bergamot-translator-worker.js` and
  `public/assets/translator-worker.js` (confirm nothing else loads it);
- the language settings option.

The `memoryTranslateMedia` normalizer maps `translatorType: "bergamot"` to
`"none"`. Update `media-aux.md` and `persistence.md` (the
`firefox-translations-models` store; deleting it once at boot is optional).

As built:

- The normalizer maps `"bergamot"` to `"google"`, not `"none"`: `"none"` has
  no branch in `translateMain` and reaches Google too, with a blank select.
  It also empties `translator` (translation off) and turns off
  `autoTranslate` and `useAutoTranslateInput`, because those two run
  without checking the target language. A user who chose a local translator
  sends nothing to an online one until they turn translation on again. The
  server normalizes and persists the section at startup, and the tab writes
  the whole record, so the mapping does not run again once the user picks a
  translator.
- `htmlTranslation` (Bergamot's HTML option, no other reader) is a
  `DROPPED_FIELDS` entry; its settings item and label are removed. The boot
  fixture keeps its old value as legacy input.
- All of `public/assets/` is removed (the two workers and the 5 MB wasm),
  with its `.ignore` and `STRUCTURE.md` entries.
- `importBrowserLocalData` attempts
  `indexedDB.deleteDatabase("firefox-translations-models")` at every boot
  without waiting for it (another open tab can block it).
- Tests: the migration in `server/src/tests/normalizeSections.test.ts`,
  the boot deletion in `src/ts/storage/tests/browserLocalImport.test.ts`,
  the select without Bergamot in `src/ts/setting/languageSettingsData.test.ts`.

### Phase 2. Per-chat settings and automatic translation

2.1 **Chat translation settings.**

- Add the chat fields and a translation section in the chat panel
  (`ChatBindingPanel.svelte` or a sibling): auto-translate, bot replies only,
  the translator preset (with "global" and a "deleted, using global" state),
  and bilingual display with its emphasis and pairing.
- `newChatBinding` copies the fields under `inherit`; `empty` leaves them
  unset.
- Copies and branches keep them. Imports keep them, except a
  `translatorPresetId` that does not exist here.
- Remove the global `autoTranslate` (`SECTION_FIELDS`, the language settings
  page, the normalizer, `DROPPED_FIELDS`). Its value is not copied anywhere
  (decision 10).
- The rendered path's auto-translate reads the chat's flag.

2.2 **Preset resolution.** `resolveTranslatorPreset(chat, presets)` in
`shared/translation/`: the chat's preset when it exists, else the global
selection. Deleting a preset rewrites nothing (decision 4).

As built (2.1 and 2.2 together):

- The six fields are list fields (`ChatSummary`, the tab's list entry,
  `SUMMARY_FIELD_TYPES`), so `inherit` reads a source chat that is not
  loaded and the panel shows while a chat loads. `shared/translation/chatSettings.ts`
  holds the field types, `readChatTranslationSettings` (missing or
  malformed is off), `selectedTranslatorPreset` (the global rule, now
  shared by the tab and the server), and
  `resolveTranslatorPreset(chat, presets, selectedId)` (`missing` for a
  deleted preset).
- `inherit` copies the six fields as stored, a deleted preset id included
  (it falls back as it did in the source chat); `empty` and a character
  without chats start with none. `importChat` drops a preset id that names
  no preset here. Copies and branches already spread the whole chat.
- The panel (`ChatTranslationPanel.svelte`, in the open chat's sidebar
  below the binding, while a target language is set) has auto-translate
  and, for the LLM translator, the preset. The `translateBotOnly` and
  bilingual rows move to 2.3 and 2.4, so no control does nothing yet.
- A chat's `autoTranslate` counts only while a target language is set
  (`chatAutoTranslate`). The rendered path takes it as a `ChatBody` prop
  and restarts the row when it changes; the suggestions' toggle starts
  from it per chat.
- The tab resolves against the selected chat (its list entry, so also
  while it loads), read once per `runTranslator` call; the translation
  playground uses the global preset (`globalPreset`). The server runner
  resolves the chat it translates.
- The global `autoTranslate` is a `DROPPED_FIELDS` entry; the language page
  item and the slice 1.5 Bergamot migration's `autoTranslate = false` are
  gone. The first-run wizard's "English Processing" no longer turns on
  output translation (there is no chat yet); its en/ko description says to
  turn on auto-translate in a chat's settings.

2.3 **Automatic translation of replies.**

- After a send's reply is written and its lock released, the job hands the
  reply to the runner of 1.3 when all of these hold: the chat's
  `autoTranslate` is on, the translator is LLM, and `llmTranslationTarget` is
  `"message"`. With `translateBotOnly` off, the new user message is handed over too.
- The hand-off does not hold the chat or the job: the next send is not
  blocked by a running translation. It is not a job round.
- The job emits a `translating` notice for the message ids. The tab shows the
  loading state for them until the stored translation arrives or the runner
  reports a failure.
- `autoTranslateCachedOnly` keeps its meaning for the rendered path only.
- The chat panel gets its "bot replies only" row (`translateBotOnly`),
  moved here from 2.1.

Test: an Echo send with auto-translate stores a translation on the reply, and
a second send starts while it runs.

As built:

- `runSend` collects every reply its speakers and rounds wrote (an
  auto-continue extends one; a resend or a group member adds one) and the
  user message of its input stage. Before `done` (each final write already
  released its lock), unless the job was aborted, it calls the runner's
  `handOff` with the job's context ids, replies first. The runner reads the
  current settings and chat (not the job's scope) and decides; every message
  gets an unforced `translate`, detached from the job.
- The `translating` notice lists the ids with a run started or in flight. A
  refused one (lock, binding, capacity) or a fresh stored translation is
  left out, and nothing is retried: auto-translation is best effort.
- The tab follows each id with an unforced POST (`follow`: no save barrier,
  no stability checks, silent on `ignored`) that joins the run, so it gets
  the run's own result or failure. A run that ended before the POST arrives
  answers `fresh`, or the POST starts a new run (a failed run is tried once
  more). Its failures are queued in the job channel's alert queue, so they
  never replace the next send's question. A hand-off that arrives while the
  tab's request for that message runs is followed again once it settles.
  The tab waits 21 minutes (two server deadlines, for the wait below). Other
  tabs and a tab disconnected at the notice show no loading state; they get
  the translation through the chat refresh.
- A request for a message whose text is no longer the one its run in flight
  translates (a Continue extended the reply) waits for that run and then
  translates the current text, so a Continue's hand-off is not lost.
- A cached reroll alternative chosen in the tab is not a send: it is not
  translated automatically.
- The panel's "bot replies only" row shows with the stored translation and
  auto-translate on. It limits the automatic requests only: a user message's
  fresh translation still shows by the chat's flag.
- Tests: `server/src/tests/promptRunner.test.ts` (the send's hand-off end to
  end with the translation requests held: the notice before `done`, a second
  send meanwhile, continue, group, bot-only, off, abort),
  `server/src/tests/translate.test.ts` (`handOff` and the stale-source chain),
  `src/ts/translator/storedTranslation.test.ts` (the follow mode, the
  follow-again, the 21-minute bound), `src/ts/network/jobChannel.test.ts`
  (the notice and the queued failure), and
  `src/lib/SideBars/ChatTranslationPanel.test.ts` (the bot-only row).

2.4 **Bilingual display.**

- Port `bilingualInterleave` and `sentenceBreaks` (pure).
- Interleave the source and the stored translation before the display
  transform, by line or every `bilingualSentences` sentences, with the
  emphasis.
- Port `pruneEmptyBilingualPairs` as an after-render step, and the pair and
  muted CSS.
- The chat panel gets the bilingual display row with its emphasis and
  pairing, moved here from 2.1.
- Tests: both helpers (pure).
- Manual check: a card whose `editdisplay` regexes and display triggers
  match whole messages. The wrappers sit between the lines the scripts see.

As built:

- `src/ts/translator/bilingualInterleave.ts` (`bilingualInterleave`,
  `pruneEmptyBilingualPairs`) and `src/ts/parser/sentenceBreaks.ts`
  (`insertSentenceParagraphBreaks`, capped at `MAX_BILINGUAL_SENTENCES`) are
  the Fastify helpers. The pruning parses a `<template>` fragment (Fastify's
  document parse dropped a leading `<style>`), so both stay in the tab.
- `Chat.svelte` passes the pairing (`bilingualDisplay`: the stored message's
  text after the row's display CBS pre-pass, as the translation gets it, the
  emphasis, and the sentence count) to `ChatBody` while the stored
  translation is shown and the chat's `bilingualDisplay` is on. `ChatBody`
  applies the `edittrans` scripts to the translation, interleaves it with the
  source, then runs the display path, and prunes empty pairs on every
  rendered body. The pair classes carry the sanitizer's `x-risu-` prefix,
  and their CSS is in `src/styles.css` under `.chattext`.
- Partial edit is off on a row that shows a bilingual pair, until the
  phase 4 "Bilingual partial edit". The full translation editor still edits
  the translation alone.
- The panel shows the bilingual check with the stored translation (LLM on
  `"message"`), and its emphasis and pairing selects (line, or 1–10
  sentences) while it is on. The defaults are unset fields.
- Tests: `src/ts/translator/bilingualInterleave.test.ts` (Fastify's pairing
  cases, and the pruning: no pair, an empty side, an empty pair, an
  image-only pair, a leading `<style>` kept),
  `src/ts/parser/tests/sentenceBreaks.test.ts`, and the bilingual rows in
  `src/lib/SideBars/ChatTranslationPanel.test.ts`. The row's render through
  `Chat.svelte` and `ChatBody` has no test.
- The manual check is not done yet.

### Phase 3. LLM translation quality

3.1 **Step editor and step models.**

- `TranslatorPresetSettings.svelte` edits up to five steps: name, enabled,
  prompt, max response, output key, and model (the `translate` slot or a
  profile via `ProfileSlotSelect`).
- The request layer gains a per-call profile: the request names a
  `profileId`, `resolveSlotProfile` uses it, and a missing profile refuses
  (no redirect, as for slots). Input Hooks would reuse this later.
- `.risutl` writes version 2 for presets with steps and still reads version 1.

As built:

- The request layer's per-call profile is `RequestArgs.profileId` (in `REQUEST_ARG_KEYS`, so the
  tab's transport forwards it; the route accepts a record id). `resolveSlotProfile` takes it as a
  fifth parameter and checks it first: the profile whatever the mode (`staticModel` included), else
  `{ kind: "refused", reason: "missingNamedProfile" }`. Both translator runs send a profile step's
  id and keep the `translate` mode. Tokenization does not follow the profile: a request's tokenizer
  scope stays the main model's (translation sends no biases).
- The tab's run now pins its ids (the 1.2 note): `llmTranslationContext` captures the prompt
  preset, model preset, and persona a chatless request would read (`requestIds`), and every step's
  request runs with them (the preset-gone checks, the slot routing, the transport's ids). A chat
  switch during a multi-step run no longer moves the later steps.
- The editor is `TranslatorStepEditor.svelte`, one per step, found by the preset's and the step's
  ids at every access. It writes only what the normalizer keeps as is: a blank name and an invalid
  or used output key stay local drafts with a hint (dropped once the stored value, or for a key the
  other steps' keys, change), and a cleared response size is not written (the field shows the
  stored size again when committed).
- `runTranslator` captures the ids once for all its chunks, as it does the preset.
- Deleting a model profile lists the translator presets with a step on it; their steps refuse
  (`missingNamedProfile`) and show the connection missing until another is chosen.
- `.risutl`: version 1 when it holds the preset without loss (one enabled `inherit` step, no output
  key, the name `Step 1`), else version 2 `{ name, steps }` with no ids. Decoding checks every level
  (exact keys, finite sizes, model shapes, valid and unique output keys) and refuses anything else,
  including a Fastify-shaped payload; a profile step keeps its profile id.
- Tests: `shared/llm/tests/modelSlots.test.ts` (`profileId`), `shared/tests/translatorPresets.test.ts`
  (`createTranslatorStep`), `server/src/tests/llmProviderAdapters.test.ts` "model profiles" (a named
  profile's connection, key, model, and flags; a missing one refused), `server/src/tests/llmRoutes.test.ts`
  (the route's `profileId`), `server/src/tests/translate.test.ts` (a profile step over the app and the
  fake request layer), `src/ts/process/request/tests/requestPresetScope.test.ts` and
  `transport.test.ts` (`requestIds` and `profileId` in the tab), `src/ts/translator/translatorLLM.test.ts`
  (the ids captured once per call, the step's profile), `src/ts/translator/presets.test.ts` and
  `presetsCodec.test.ts` (the version 2 codec and the lossless rule),
  `src/lib/Setting/Pages/Language/TranslatorPresetSettings.test.ts` (the step editor), and
  `src/lib/Setting/Pages/presetPages.test.ts` (the delete confirmation).

3.2 **Send Text As-Is.** A preset option: the whole source goes into
`{{slot::content}}` in one request, without line protection or style
placeholders, and the reply is stored as is.

As built:

- `TranslatorPreset.sendTextAsIs`: only `true` is stored (`createTranslatorPreset`, the server's
  normalizer, drops anything else), so every existing preset reads as off. The preset page's check
  writes `true` or deletes the field.
- The server runner, decided with the user (Fastify parity): with the option on, the whole
  `message.data` goes through one pipeline run (one request per step that runs) and its reply is
  stored as is (what 1.3 built). With it off, the default, the runner protects lines as Fastify's
  server did (`translateProtectingLines`, `shared/translation/pipeline.ts`): the text is cut at
  exactly empty lines and at asset lines (`{{img`, `{{raw`, `{{video`, `{{audio …}}`), each other part
  is trimmed and goes through its own pipeline run, and the parts are joined with `\n` (an empty part
  follows each protected line, so two protected lines in a row get an extra blank line between
  them) and trimmed. So the default stored path
  now sends one run per paragraph. The parts run one after another under the message's one
  controller, deadline, CBS budget, and write; any failure stores nothing. The server's automatic
  translation (2.3) uses the same run.
- The tab: on, `translateLLM` sends no `<risu-style>` placeholders and returns the reply as is, and
  `runTranslator` (input, suggestion, TTS, and playground translation) sends the whole text in one
  call without its own line chunking. `translateHTML`'s LLM branch (the rendered path and the summary
  translation) already sent the whole text; only the placeholders change there. Off keeps both as
  before. The `LLMTranslateCache` key
  gains the flag only when it is on, so the keys of presets without it did not change.
- "As is" means without the line splitting and style substitution: the reasoning blocks are still
  removed from every step's output, a ChatML prompt still trims its messages, and the `edittrans`
  scripts still apply at display on both paths (Fastify skipped them on its rendered path; here the
  stored path applies them at display, and the two paths stay alike).
- `.risutl`: version 1 only with the option off; version 2 carries an optional boolean
  `sendTextAsIs`, written only when on. A version 1 payload carrying `sendTextAsIs` is refused.
- Tests: `shared/tests/translatorPipeline.test.ts` (`isProtectedTranslationLine`,
  `translateProtectingLines`: the parts, the whitespace examples, a protected-only text, the order
  and the first error), `shared/tests/translatorPresets.test.ts` and
  `server/src/tests/normalizeCollections.test.ts` (`true` only, a preset without it unchanged),
  `server/src/tests/translate.test.ts` (one run per part under one job id with its own named
  outputs, the As-Is run stored untrimmed, a later part's failure and the deadline during a later
  part storing nothing, the hand-off in both modes), `src/ts/translator/translatorLLM.test.ts`
  (the off-mode key unchanged, the on-mode key apart, the As-Is run and `translateHTML` in both
  modes, the mode captured when a call starts), `src/ts/translator/presets.test.ts` and
  `presetsCodec.test.ts` (the codec and its refusals), and
  `src/lib/Setting/Pages/Language/TranslatorPresetSettings.test.ts` (the check's writes).

3.3 **History slots.** `{{slot::history::N}}` (source text) and
`{{slot::historytrans::N}}` (fresh stored translations), N from 1 to 50:

- walk back from the message, skipping disabled and comment rows, and stop
  at `allBefore`;
- trim the oldest whole messages to a `translatorHistoryMaxTokens` budget
  (default 2048) with the server tokenizer.

They resolve only in the server runner, and to an empty string elsewhere.

As built:

- `shared/translation/historySlots.ts` holds the pure rules; `fillTranslatorSlots` fills both slots
  in its one pass (a filled-in history is never read for slots again), from the caller's `history`,
  and an invalid N (`0`, `51`, `abc`) fills in empty. A history slot is not an input slot: a prompt
  holding only it still sends the source as the user message. The tab passes no history, so its
  history slots are empty there; its `LLMTranslateCache` key did not change (a key cached with a
  literal history slot in its prompt is not told apart; Retranslate replaces it).
- The walk starts at the row before the message (the message and the rows after it are not
  history): a `disabled: "allBefore"` row ends it and is not taken, comment or not; disabled and
  comment rows are skipped. An entry is `user: <text>` or `char: <text>` followed by
  `\n\n---\n\n`; `history` shows the raw `data` (no CBS), `historytrans` the fresh stored
  translation of the same entries, an empty block for an entry without one, so both slots list the
  same rows in the same order.
- The budget is per N and covers the history blocks only: an entry costs its source block plus its
  translation block (an empty one included, unlike Fastify, which did not count the empty
  blocks it showed), and the oldest whole entries are dropped while the sum passes
  `translatorHistoryMaxTokens` (`memoryTranslateMedia`, 2048 by default; the normalizer turns a
  value at or below 0 into 2048; the language page shows it for the LLM translator on `"message"`
  and writes only a finite number above 0). A newest entry alone over the budget leaves the slot
  empty.
- The server runner counts with the main model's tokenizer (`tokenScopeFor`, the app's token
  counter, a new `tokens` dependency), not a profile step's. It builds the history from the run's
  chat copy once, when the first pipeline run starts (a protected-only text counts nothing), and
  shares it across every part and step, with or without Send Text As-Is (Fastify filled history
  slots only on its As-Is path). Each count yields a turn and checks the run before and after it; a
  Google count cannot be aborted, so one in flight may outlive an ended run (its work still counts
  against capacity). A tokenizer error fails the run (500) and stores nothing.
- No greeting: Fastify appended the chat's greeting source when the walk ran out of rows; here the
  greeting is the character's `firstMessage` or alternate greeting, which prompt assembly runs
  through CBS and `editprocess`, and greeting translation is a phase 4 item.
- Tests: `shared/tests/translatorHistorySlots.test.ts` (the count, the budget, the walk, the block,
  the build), the history-slot cases of `shared/tests/translatorPipeline.test.ts` (the one-pass fill,
  the counts of the executed steps, the nested malformed tokens of the challenge, not an input
  slot, the run), `server/src/tests/translate.test.ts` (the runner: built once per run for every
  part and step in both modes in the main model's token scope, nothing counted for a prompt
  without a valid slot or a protected-only text, the budget as stored, the run's chat copy, and a
  count held past the deadline, maintenance, or shutdown, a tokenizer failure), the normalizer's
  default in `server/src/tests/normalizeSections.test.ts`, the language page item in
  `src/ts/setting/languageSettingsData.test.ts`, the tab's empty slots and unchanged key in
  `src/ts/translator/translatorLLM.test.ts`, and the `.risutl` round trip in
  `src/ts/translator/presetsCodec.test.ts`.

3.4 **Chain of thought.** A preset option that also strips `<Thoughts>` and
`<think>` from the source and the history before sending. Output stripping is
always on (1.2).

As built:

- `TranslatorPreset.excludeThoughts` (Exclude Chain-of-Thought), stored only as `true` like
  `sendTextAsIs`; the preset page's second check writes `true` or deletes it. It does not depend on
  Send Text As-Is (Fastify's `translatorExcludeThoughts` was a global setting that applied only with
  it): without As-Is the strip runs on the whole text before the line cut, so a block spanning
  paragraphs leaves whole.
- The strip is `stripTranslatorReasoning`, the output strip's rule: any case, attributes allowed,
  nested blocks counted, an unclosed block hidden to the end, a stray closing tag kept; a text with no
  opening tag is unchanged, else the rest is trimmed. Each text is stripped once (the rule is not
  idempotent: removing a block can join two fragments into a new tag). A source the strip leaves
  blank sends nothing: the server stores an empty translation; the tab's `translateLLM` (As-Is
  `runTranslator`, `translateHTML`) caches and returns `""` under the original text's key, and the
  protected `runTranslator` returns `""` without a request or a cache entry (no part is left).
- The server runner strips `message.data` once, before the As-Is run or `translateProtectingLines`,
  and each history entry's source and fresh translation (`collectTranslatorHistory`'s
  `transformText`, after the freshness check, so the budget counts the stripped blocks).
  `sourceHash` stays the stored text's.
- The tab: `translateLLM` strips after its cache read and before the `<risu-style>` placeholders
  (As-Is `runTranslator`, `translateHTML`); the protected `runTranslator` strips the whole text
  before its line cut and passes the chunks as prepared. A failure returns the text as given:
  `translateLLM` returns its own text and reports the failure to the protected `runTranslator`
  (`failure`), which then returns its whole text unstripped (without the option, a chunk failure
  keeps the old behavior). The `LLMTranslateCache` key gains `excludeThoughts: true` only when on,
  after the existing fields, and `inputPrepared: true` for the protected chunks (a prepared text and
  the same raw text, which would be stripped first, never share an entry); its text is the caller's
  (before the strip), the protected chunks' being the chunks of the stripped text.
- Limits, in the help: on the rendered path the markdown step has already turned `<Thoughts>` into
  `<details>`, so their text is translated (only `translateBeforeHTMLFormatting`'s raw text is
  stripped); the playground's bulk mode strips each of its parts on its own, and its Keep Context
  notes carry the earlier parts as typed, thought blocks included.
- `.risutl`: version 1 only with the option off (a version 1 payload carrying `excludeThoughts` is
  refused); version 2 carries an optional boolean `excludeThoughts`, written only when on.
- Tests: `src/ts/translator/translatorLLM.test.ts` (the keys: the off-mode formula unchanged,
  `excludeThoughts: true` appended after `sendTextAsIs`, `inputPrepared: true` for the protected
  chunks; a prepared chunk and the same raw text kept apart in both population orders, the request
  text of each path asserted; the As-Is call stripped exactly once under the original text's key;
  the protected call stripped whole before the line cut; `translateHTML` stripping before the
  `<risu-style>` placeholders and keeping a rendered `<details>`; a chunk's failure returning the
  whole text as given; a blank text cached as `""` on the As-Is and direct paths and returned
  without a request or an entry by the protected path; the option captured when a call starts;
  DeepL untouched), `server/src/tests/translate.test.ts` (the source stripped once before the line
  cut or the As-Is run, a blank source stored empty under the stored text's hash without a request
  or a count, the history entries stripped after the freshness check and counted once),
  `shared/tests/translatorHistorySlots.test.ts` (`transformText`), `shared/tests/translatorPresets.test.ts`,
  `server/src/tests/normalizeCollections.test.ts`, `src/ts/translator/presets.test.ts`,
  `src/ts/translator/presetsCodec.test.ts` (the field kept only as `true` after `sendTextAsIs`, the
  `.risutl` rules), and `src/lib/Setting/Pages/Language/TranslatorPresetSettings.test.ts` (the check).

### Phase 4. Optional

- **Greeting translation.** `chat.greetingTranslation?: { index, sourceHash, text }`
  (the chat's own greeting, one per chat), set by the runner on request. It
  is not a character-wide store.
- **Bilingual partial edit.** Route an edited block to the layer it renders
  from (the source, the translation, or one side of a pair).

## Not ported

- Fastify's message and greeting job registries, bootstrap recovery
  projections, writer/reader fences, and durable preset outbox. The runner's
  in-flight map, the chat revision checks, and the resource events cover
  this.
- Web Push deferral of completion notifications (metatron has no Web Push).
- The model-profile "Strip CoT" runtime option (a separate model-profile
  feature).
- Input translation hooks and Draft Translation mode (the Input Hooks track).
- The touch long-press trigger for partial edit (a separate UX feature).
- Fastify `.risutl` v2 and any import of Fastify translation data
  (decision 8).

## Docs

Each slice updates its guides in the same change:

- `media-aux.md` (the translator, the pipeline, the runner);
- `chat-pipeline.md` (the job's hand-off);
- `persistence.md` (`Message.translation`, the chat fields, the op,
  `LLMTranslateCache`);
- `self-host-server.md` (the route);
- `settings-i18n.md` (the language page).

New strings get `en` and `ko` entries.
