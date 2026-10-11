# Translation Plan

Status: slices 1.1–1.2 done (2026-10-11). No open questions.

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
  N sentences). They are not list fields: only a loaded chat is displayed,
  and the server reads the chat it translates.
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

Test: an Echo send with auto-translate stores a translation on the reply, and
a second send starts while it runs.

2.4 **Bilingual display.**

- Port `bilingualInterleave` and `sentenceBreaks` (pure).
- Interleave the source and the stored translation before the display
  transform, by line or every `bilingualSentences` sentences, with the
  emphasis.
- Port `pruneEmptyBilingualPairs` as an after-render step, and the pair and
  muted CSS.
- Tests: both helpers (pure).
- Manual check: a card whose `editdisplay` regexes and display triggers
  match whole messages. The wrappers sit between the lines the scripts see.

### Phase 3. LLM translation quality

3.1 **Step editor and step models.**

- `TranslatorPresetSettings.svelte` edits up to five steps: name, enabled,
  prompt, max response, output key, and model (the `translate` slot or a
  profile via `ProfileSlotSelect`).
- The request layer gains a per-call profile: the request names a
  `profileId`, `resolveSlotProfile` uses it, and a missing profile refuses
  (no redirect, as for slots). Input Hooks would reuse this later.
- `.risutl` writes version 2 for presets with steps and still reads version 1.

3.2 **Send Text As-Is.** A preset option: the whole source goes into
`{{slot::content}}` in one request, without line protection or style
placeholders, and the reply is stored as is.

3.3 **History slots.** `{{slot::history::N}}` (source text) and
`{{slot::historytrans::N}}` (fresh stored translations), N from 1 to 50:

- walk back from the message, skipping disabled and comment rows, and stop
  at `allBefore`;
- trim the oldest whole messages to a `translatorHistoryMaxTokens` budget
  (default 2048) with the server tokenizer.

They resolve only in the server runner, and to an empty string elsewhere.

3.4 **Chain of thought.** A preset option that also strips `<Thoughts>` and
`<think>` from the source and the history before sending. Output stripping is
always on (1.2).

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
