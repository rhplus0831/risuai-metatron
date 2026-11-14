# Input Hooks Plan

Status: drafted 2026-11-15 at `a089c1a16` from the owner's request to bring the input hooks of the `risuai-fastify`
fork here, then audited against the code at `86ca13331` ([report](../reports/audits/plan-runner/input-hooks-2026-11-15.md))
and corrected in the same commit as the report. D1 to D3 are the owner's answers of 2026-11-15; D4 on are this plan's
own. D6 and D14 took their present form from the audit, as did the row format of slice 4; the owner accepted those
three on 2026-11-15, after the audit. Landed: 1 (`28984cf0a`).

Sources: the fork's implementation, read at its `1df024db5` (`runInputHook`, the input hook activity store, the draft
hook translation, the hook settings page, the hook picker dialog, the chat's draft hook selector, the draft and BTW
parts of its chat screen, and its "Translation And Input Hooks" guide); here, `requestChatData` and its `chatRef`,
`tools`, and `profileId` arguments in `src/ts/process/request/request.ts`; the OOC answer request in
`src/ts/ooc/oocSession.svelte.ts`; `runTranslatorPipeline`'s request in `src/ts/translator/translator.ts`;
`collectTranslatorHistory`, `buildTranslatorHistory`, and `translatorHistoryCount` in
`shared/translation/historySlots.ts`; `fillTranslatorSlots`, `parseTranslatorChatML`, and `buildTranslatorStepMessages`
in `shared/translation/pipeline.ts`; `normalizeStepModel` in `shared/translatorPresets.ts`; `SECTION_FIELDS`,
`COLLECTION_KIND`, and `COLLECTION_FIELDS` in `shared/sections.ts`; `normalizeSection` in
`server/src/data/normalize/shared.ts` and the section projection in `src/ts/storage/resourceSync.svelte.ts`;
`settingsKind` in `server/src/data/kinds.ts`;
`METATRON_ONLY_SETTINGS` and `METATRON_CHAT_FIELDS` in `server/src/data/upstream/exportDatabase.ts`;
`CHECKPOINT_CHAT_FIELDS` in `shared/chatCheckpoints.ts`; `setChatMeta` in `src/ts/storage/chatStore.svelte.ts`;
`createComposer`, `beginSend`, `placeSend`, and `restore` in `src/ts/process/composerDrafts.svelte.ts`;
`ComposerValue` and `checkComposerValue` in `src/ts/storage/draftJournal.ts`; `SendDraft`, `composerSendText`, and
`createSendDrafts` in `src/ts/process/sendDraft.ts`; `createSendAborts` in `src/ts/process/sendAborts.svelte.ts`;
`sendMain`, `sendChatMain`, `abortChat`, and the composer menu in `src/lib/ChatScreens/DefaultChatScreen.svelte`;
`OpenChatPanel.svelte` and `ChatTranslationPanel.svelte`; `SETTINGS_PAGES` in `src/ts/router/routes.ts` and
`src/ts/settingsMenu.ts`; `GenerationContext` in `shared/jobs.ts`; `parseCreateBody` in
`server/src/routes/generations.ts`; `requestFingerprint` in `server/src/jobs/generationJobs.ts`; the input stage of
`server/src/prompt/runner.ts`; `isMessageTranslation`, `storedTranslation`, and `translationSourceHash` in
`shared/translation/`; the send hand-off in `server/src/translation/runner.ts`. The identifiers are the anchors.
Re-verify each cited location before editing (STRUCTURE.md protocol step 5).

## Goal

The user keeps a list of input hooks: prompts an auxiliary model runs over what is in the composer.

- **A Draft hook.** A chat can choose one. With a hook chosen, Send does not send: it runs the hook over the composer's
  text and puts the result in a second box under the composer, the draft. The user reads it, edits it, and sends it
  with Send Draft. The usual case is writing in one language and sending in another.
- **A BTW hook.** The user runs one on demand from the composer menu. Its result is shown in a panel over the composer
  and is never sent or stored in the chat.
- **Translation mode** (a Draft hook's option). When its draft is sent, the composer's original text is stored as that
  user message's translation, so the row can show what the user actually typed.
- **The prompt.** `{{slot::content}}` is the composer's text and `{{slot::draft}}` the draft box's text.
  `{{slot::history::N}}` and `{{slot::historytrans::N}}` are the translator's history slots. A ChatML prompt is sent as
  its rows.
- **The model.** A hook runs on the chat's Other auxiliary model (`otherAx`), or on a model profile the hook names.
- **The settings page.** Settings → Input Hooks lists the hooks; a fresh server has one Draft hook that translates into
  English.

Not goals: a hook that sends without review; CBS in a hook prompt; a default hook for every chat; a BTW result kept
across a reload; the fork's floating-composer preview (D17, Not In This Plan).

## Current State

- **No input hook.** The source has no hook list, no draft box, and no BTW action. The nearest features are below.
- **Input translation.** With `useAutoTranslateInput` the composer has a second box (`composer.translate`) that
  `createInputTranslation` keeps in step with the main box while the user types, in both directions. Send serializes
  the main box only (`composerSendText`); the translation box is cleared with it.
- **OOC session.** The composer menu opens a side thread that asks the chat's own prompt a question
  (`src/ts/ooc/`). It is a job preview plus a tab request, stored in the chat's metadata. A BTW hook is lighter and
  different: one prompt of the user's own, on the auxiliary model, without the chat's prompt, its result held in the
  screen's memory only (D12).
- **The tab can request a reply itself.** `requestChatData(arg, mode, signal)` takes `formated` rows, a required
  `bias`, `useStreaming`, `noMultiGen`, a `chatRef`, `tools`, and `profileId`. A request with a `chatRef` runs on that
  chat's bound presets and is refused while the binding is incomplete or after the chat is gone; `profileId` runs it
  on that model profile instead of the mode's slot. `otherAx` is the model preset's Other auxiliary slot when
  auxiliary models are separated and that slot is set, else its sub model slot. Without `tools` it lists the chat's
  tools and stores the calls' records in the chat; the OOC request passes `tools: []`. An empty tool list does not
  isolate the request: the plugins' before and after request replacers still run with the chat's context, and the
  request is recorded in the request history and the fetch log like any tab request. The provider request itself runs
  on the server (`/api/llm/request`) except for plugin providers and WebLLM. The result is a buffered success, a
  stream, a `multiline` list, or a failure; some non-plugin providers return a stream or a list whatever
  `useStreaming` says (Claude batching, AIN).
- **History slots.** `collectTranslatorHistory(messages, messageIndex, count)` walks back from the message before
  `messageIndex` (an index equal to the list's length is accepted), skips disabled and comment rows, and stops at
  `disabled: "allBefore"`. `buildTranslatorHistory` renders both slots for the given counts under a token budget
  (`translatorHistoryMaxTokens`) with a `countTokens` the caller supplies. Only the server's translation runner calls
  it today. There is no greeting entry: a greeting is not a stored message.
- **Slot parsing is per feature.** `SLOT_PATTERN` and `translatorHistorySlotCounts` in `shared/translation/pipeline.ts`
  are tied to translator steps; `parseTranslatorChatML` is exported and pure.
- **Settings sections and collections.** A settings field is a `Database` field in one resource: a `SECTION_FIELDS`
  section, or a settings collection of its own kind (`COLLECTION_KIND`, `COLLECTION_FIELDS`; `customModels` is a plain
  list of this sort, read and written as `settings.customModels`). A setting upstream lacks is named in
  `METATRON_ONLY_SETTINGS`.
- **A tab projects only the section fields it knows.** A section's outgoing write is built from the tab's own
  `SECTION_FIELDS`, so a tab from before a field was added sends a patch that removes it (or a whole record without
  it) even after reading the current revision, and `normalizeSection` then stores the field's default. Revision and
  epoch do not stop this. A collection kind the tab does not know is never requested, installed, or written by it:
  unknown feed patches and refetch references are ignored, and its save loop walks known collections only.
- **A collection's default.** `settingsKind` materializes a missing record at server start with one write; a read
  writes nothing. `BOOT_CACHE_ELIGIBILITY` and the collection merge policy in `src/ts/storage/recordMerge.ts` are
  exhaustive over the kinds.
- **Chat metadata.** Fields are stored largely as sent. `CHECKPOINT_CHAT_FIELDS` is exhaustive over `ChatMeta`.
  `METATRON_CHAT_FIELDS` lists what the upstream export strips. `translatorPresetId` is a per-chat id of this kind,
  written with `setChatMeta` from `ChatTranslationPanel.svelte`, which `OpenChatPanel.svelte` mounts while a
  translator is set.
- **The composer.** `createComposer` keeps one `ComposerDraft` (`input`, `translate`, `files`) per chat and journals
  it (`ComposerValue`, a draft row and a send hand-off row). `sendMain` checks busy state, a slash command, the
  binding, and orphaned lore overrides, then snapshots the composer, calls `composer.beginSend`, clears the composer,
  and calls `sendChatMain` with a `SendDraft` (`input`, `userMessageId`, `requestId`); nothing awaits between consuming
  the input and the send's admission. The screen serializes the send once with `composerSendText` (main box plus
  inlay tags); `sendDrafts` and `composer.placeSend` carry that text for a failed send, placing it into an empty main
  box, and the journal's `restore` rebuilds it from the stored row with the same function.
- **Stop.** `sendAborts.begin(ref)` registers a new controller for the chat (replacing the map's entry) for the length
  of `sendChatMain`'s send; the Stop button shows while `sendAborts.has(ref)` or the tab owns a job, and `abortChat`
  aborts both. Nothing shows progress before `sendAborts.begin`. `isChatBusy` reads the tab's local sends, followed
  jobs, and locks; it does not read `sendAborts`. The screen checks it in `sendMain` (twice), in `sendChatMain` (which
  auto mode and reroll reach without `sendMain`), and before reroll, unreroll, and the other composer actions.
- **The user message is appended by the job.** The input stage of `server/src/prompt/runner.ts` runs the `input`
  trigger and `editinput` (Lua, a tab plugin, regex scripts) over `context.input` and appends
  `{ role: "user", data, time, chatId: userMessageId }`. It is skipped when the chat already holds a user message
  under that id. `parseCreateBody` rebuilds `context` from a fixed property list, and `requestFingerprint` hashes a
  fixed set of fields, adding `oocExchangeId` only when present.
- **Stored translations.** `MessageTranslation` has `text`, `sourceHash`, `targetLanguage`, and `translatedAt`, plus
  optional `presetId` and `edited`. `isMessageTranslation` is its shape check and `storedTranslation` its only
  freshness rule (`sourceHash === translationSourceHash(data)`). `targetLanguage` and `presetId` are informational. A message appended
  with a well-formed translation keeps it, through the store, the feed, and the tab. The send hand-off (LLM translator
  with the `message` target, a target language, and the chat's `autoTranslate`) asks for an unforced translation of
  each of the send's messages, which starts no run for a message that already holds a fresh stored translation;
  `translateBotOnly` leaves user messages out. `Chat.svelte` shows a stored translation only on the stored path
  (`usesStoredTranslation`: the LLM translator with the `message` target): on the row's toggle, or by the chat's
  `autoTranslate`, both of which need a target language. With another translator or the `rendered` target a stored
  translation is kept and not shown. Clearing the target language hides the toggle and turns the automatic display
  off; a row the user already chose to show in this tab can stay shown.
- **Settings pages.** A page has a `SettingsMenuIndex` (named in `src/ts/settingsMenu.ts` or a bare number), a slug in
  `SETTINGS_PAGES`, a `navGroups` entry and a render branch in `src/lib/Setting/Settings.svelte`, and a row in
  `e2e/settingsPages.spec.ts` `PAGES`. The highest index in use is 23, apart from 77.

## Rules For Every Slice

One slice is one session and one commit. Slices marked _hard_ use `opus-workflow`; the others use `opus-lite`.

- **Checks.** The slice's tests (under "Test"), then `pnpm check`, the focused files through the wrapper while
  iterating, `pnpm --silent test:agent` once whole after the last source edit, `pnpm format:check`, `pnpm check:docs`
  for a guide edit, and `pnpm check:tests` for an added test file. Run `pnpm check` again after the last test edit. V4
  (`rg` each changed export and wire field) and V6 (each new test shown failing once with its guarded line broken).
- **Names.** Suggested, final once slice 1 lands: the settings field `inputHooks`, the chat field `draftHookId`, the
  module `shared/inputHooks.ts`, the type `InputHook`. Final once slice 4 lands: the composer field `draft` and the
  journal's draft-send marker. Final once slice 6 lands: the request field `context.inputOriginal`.
- **Absent means today.** A chat without `draftHookId` (or with one that names no Draft hook) sends exactly as at
  `a089c1a16`, and a composer whose draft box is empty and that is not a draft send journals rows of today's shape and
  format. A job without `inputOriginal`
  runs as today. Slices 4 and 6 each have a test for this.
- **The feature writes the chat in two places only.** `draftHookId` (slice 2) and the user message's translation
  (slice 6), which the job writes with the message. A hook run itself appends no message and, with `tools: []`, stores
  no tool-call record. It is an ordinary tab request otherwise: plugin replacers run and may write as they may in any
  tab request, and the request history and fetch log record it. No slice adds isolation from plugins.
- **Carry the chat across awaits.** A hook run captures the chat's ref and owner before its first await, pins the chat
  for its whole length, and re-resolves it after each await (STRUCTURE.md D1). A Draft result for a chat that is gone
  or no longer shown, or whose main box or draft box was edited since the run began, is dropped without an alert: the
  user's edit wins.
- **New files.** A new source file gets its owner (`pnpm docs:owner <path>`, `docs/structure/ownership.json`) in the
  slice that adds it.
- **A tab or server from before a slice.** An older tab never writes `draftHookId` and leaves a stored one alone (a
  `meta` op names its fields). It does not know the `inputHooks` kind and so never writes the hook list (D6). It shares
  the browser's draft journal with newer tabs: slice 4 writes a composer row that holds draft text in a format the
  older reader refuses and keeps. An older server drops `inputOriginal` in `parseCreateBody` and appends the message
  without a translation, and refuses a boot that asks for a kind it does not know, so a tab of slice 1 or later needs
  a server of slice 1 or later.
- **Strings.** New text goes in `src/lang/en.ts` with its Korean in `src/lang/ko.ts` in the same slice, under one
  `inputHooks` object. The user-facing names are "Input Hooks" (Korean: "입력 훅"), "Draft" ("초안"), and "BTW". The
  fork's strings are the starting text.
- **Guide.** Each slice names its guides; their `Invariants` apply, and the slice updates the sections and module
  comments that name a changed contract. Comments and test titles describe behavior, not this plan (STRUCTURE.md T5).
- **Manual checks.** Each slice lists the checks it cannot run. The slice report gives them to the owner as a
  checklist; what is still unrun when the plan closes moves to [manual checks](../backlog/manual-checks.md) under this
  plan's name.

## Order

Serial: 1 → 2 → 3 → 4 → 5 → 6. Slices 2 and 3 share no file and can run together after slice 1: slice 3 adds no
string (the locale files are slice 2's) and no fixture. Slice 4 needs the runner (3) and the chat's choice (2). Slice 5
uses slice 4's run registry and draft box. Slice 6 extends slice 4's Send Draft and adds the option to slice 2's page.

If the run stops after slice 3, the user can edit hooks and choose one for a chat, and nothing runs. After slice 4 the
Draft flow works. Slice 5 adds BTW and slice 6 translation mode; each is independent of the other.

## Slice 1. The stored fields and the shared module (`persistence.md`, `server-resources.md`)

**Change.**

- `shared/inputHooks.ts` (new): the types, limits, defaults, and pure functions both runtimes use.
  - `InputHook`: `{ id, name, type: "draft" | "btw", prompt, translation?: true, model }`. `model` has the translator
    step's shape: `{ mode: "inherit" }` or `{ mode: "profile", profileId }` (D6). `translation` is stored only as
    `true` and only on a Draft hook.
  - `MAX_INPUT_HOOKS` (suggested 50) and `defaultInputHooks()`: one Draft hook, id `default-translate`, name
    "Translate", the fork's default prompt ("Translate the following user message into English. Preserve names,
    commands, markdown, and inlay tags. Output only the translated message."), `model: { mode: "inherit" }`.
  - `normalizeInputHooks(value)`: a list keeps its well-formed entries in order, up to the limit. An entry needs a
    nonempty string `id` not seen earlier in the list, a string `name`, a `type` of the two, and a string `prompt`;
    `model` is normalized by a translator step's rule (`normalizeStepModel` in `shared/translatorPresets.ts` is
    private: the slice exports it or repeats its rule), and `translation` as above. Anything else in an entry is
    dropped. A value that is not a list reads as `defaultInputHooks()`; an empty list stays empty.
  - `draftHookOf(hooks, id)`: the Draft hook with that id, else null (a missing id, a BTW hook's id, and a blank or
    malformed id all read as none).
  - `inputHookHistoryCounts(prompt)`: the valid history slot counts in a prompt, each once, read with the same
    one-pass match that fills the slots.
  - `inputHookMessages(hook, { content, draft }, history?)`: the request rows. The slots are filled in one pass
    (`{{slot::content}}`, `{{slot::draft}}`, the two history slots through `translatorHistoryCount`; a history slot
    without `history` or with an invalid count fills in empty; an unknown `{{...}}` is left as it is). The filled
    prompt is parsed with `parseTranslatorChatML`; when it is not ChatML, a prompt holding any of the four slots is one
    user row, and a prompt holding none is a system row followed by `content` as the user row.
- `shared/database.ts`: `Database` gains `inputHooks: InputHook[]`; `Chat` gains `draftHookId?: string`.
- The hook list is a settings collection of its own kind, a plain list as `customModels` is (D6):
  - `shared/resources.ts`: `RESOURCE_KIND.inputHooks` and its `BOOT_CACHE_ELIGIBILITY` entry (`eligible`: hook
    prompts are not credentials).
  - `shared/sections.ts`: `COLLECTION_KIND` and `COLLECTION_FIELDS`; no section field and no selection entry.
  - `server/src/data/normalize/collections.ts`: the kind's normalizer over `normalizeInputHooks`;
    `server/src/data/kinds.ts`: its `settingsKind` registration, which materializes `defaultInputHooks()` at server
    start for a store without the record.
  - `src/ts/storage/recordMerge.ts`: the collection's policy is `whole` (one list, no per-hook merge).
  - `src/ts/storage/snapshots.svelte.ts`: `inputHooks` joins `REPORT_REMOVED_KEYS` (a settings report must not carry
    prompt text).
  - The maintained boot fixture `src/ts/storage/tests/fixtures/boot/boot-snapshot.json` gains the fresh list, and the
    tests that count or list the kinds follow (`server/src/tests/kinds.test.ts`,
    `src/ts/storage/tests/presetSchema.test.ts`, `src/ts/storage/tests/resourceSyncSections.test.ts`,
    `src/ts/storage/tests/snapshots.test.ts`).
  - `src/ts/storage/journalEligibility.ts` needs no entry (its default admits the kind), and the upstream import
    follows the collection maps.
- `server/src/data/upstream/exportDatabase.ts`: `inputHooks` joins `METATRON_ONLY_SETTINGS`; `draftHookId` joins
  `METATRON_CHAT_FIELDS`.
- `shared/chatCheckpoints.ts`: `draftHookId` is `keep` (D7).
- The chat copy and the branch keep `draftHookId` (they spread the source), and the local chat import keeps it as
  unknown metadata does today; nothing validates it against the hook list (D7).

**Test.** `normalizeInputHooks` (a non-list reads as the default, an empty list stays, a duplicate id and a malformed
entry dropped, `translation` kept only as `true` on a Draft hook, a profile model kept and a malformed one read as
`inherit`, the limit); `draftHookOf`; `inputHookHistoryCounts` (repeats once, an invalid count ignored, a history slot
inside another slot not counted); `inputHookMessages` (each slot filled, a filled value not read for slots again, a
ChatML prompt, a slot prompt as one user row, a slotless prompt as system plus user); a fresh store holding the default
list after start, and a read of it writing nothing; a saved list surviving a reload, and an explicit empty list
staying empty; a write of the `memoryTranslateMedia` section built from a field list without `inputHooks` leaving the
hook list as it is; the settings report without the list; a checkpoint load leaving `draftHookId` as it is; the
upstream export leaving both fields out.

**Guide.** `persistence.md` (the collection, the chat field, the checkpoint choice), `server-resources.md` (the kind
and its normalizer).

**Manual checks.** None: nothing a user can reach changes.

## Slice 2. The settings page and the chat's choice (`settings-i18n.md`, `ui-theming.md`)

**Change.**

- `src/ts/settingsMenu.ts`: `INPUT_HOOKS_SETTINGS_MENU = 24`. `src/ts/router/routes.ts`: the slug `input-hooks`.
  `src/lib/Setting/Settings.svelte`: a `navGroups` entry next to Translation and the render branch.
  `src/ts/setting/searchIndex.ts`: the page in its own `PAGES` list, so a search finds it by title (the hook cards are
  handwritten UI and get no `SettingItem`). `e2e/settingsPages.spec.ts`: the page's row in `PAGES`.
  `src/lib/Setting/Settings.search.test.ts` stubs the new page as it stubs the other pages it does not test.
- `src/lib/Setting/Pages/InputHookSettings.svelte` (new), handwritten UI over `settings.inputHooks` (a plain list
  view: the list is reassigned on every edit; no draft layer of its own, D17):
  - A type select (Draft, BTW) and Add: a new hook with a new id, the type's name, an empty prompt, and
    `model: { mode: "inherit" }`; it opens expanded with its name focused. Add is disabled at `MAX_INPUT_HOOKS`.
  - One card per hook: name, type, model (Other auxiliary model, or a model profile; the select and its
    missing-profile entry follow the inline markup `TranslatorStepEditor.svelte` has for a step, which is not a
    reusable component), the prompt (`TextAreaInput` with the popup editor and the hook's id as `popupEditorContext`),
    and Delete behind the usual removal confirmation. Changing a Draft hook to BTW drops its `translation`. The
    Translation mode checkbox comes with slice 6.
  - A short description of the two types and of the four slots, and an empty-state line.
- `src/lib/SideBars/ChatDraftHookPanel.svelte` (new), mounted by `OpenChatPanel.svelte` for a loaded chat (the
  `selectedChat()` gate the note editor has: the field is not a list field) while the hook list holds a Draft hook or
  the chat's `draftHookId` is set: a select of None and the Draft hooks, written with `setChatMeta` (None unsets the
  field through its third argument). A stored id that names no Draft hook shows as a missing entry the user can
  clear, as the translation panel shows a missing translator preset.
- The strings under `language.inputHooks`, English and Korean.

**Test.** The page over the real settings views: add, rename, change type (the `translation` drop), change model, edit
the prompt, delete, the limit; the list written as a new array. The panel: hidden without a Draft hook and without a
stored id, the select writing and unsetting `draftHookId` for the chat ref it was given, a missing id shown and
cleared. The route table (`input-hooks` both ways). The page found by its title in the settings search. The e2e page
row (mounts, a later traversal writes nothing).

**Guide.** `settings-i18n.md` (the page, the menu index, the strings), `ui-theming.md` (the sidebar panel).

**Manual checks.** The page on a phone-width viewport; the popup prompt editor writing back to the right hook after
another hook was added or removed meanwhile.

## Slice 3. The tab's hook runner (`chat-pipeline.md`, `llm-requests.md`, `translation.md`)

**Change.**

- `src/ts/process/inputHooks.ts` (new): `runInputHook(hook, { ref, content, draft, signal })`, returning the trimmed
  result text or throwing.
  - Before any await it captures the chat's owner token (`chatOwnerToken`) and pins the chat (`pinChat`); the pin is
    released in `finally`, after the request (the request's own pin starts only inside `requestChatData`, after the
    history is built).
  - History: when `inputHookHistoryCounts(hook.prompt)` is not empty, it calls `buildTranslatorHistory` with the
    chat's messages (`findChat(ref)`, a loaded chat holds all of them), `messageIndex` equal to their count (the text
    being written comes after them), the counts, `settings.memoryTranslateMedia.translatorHistoryMaxTokens`, and the
    tab's `countTokens` under the chat's captured preset scope with the signal (D8). `findChat` returns a
    `DeepReadonly` chat and the builder takes `readonly Message[]`, which does not accept it: the builder's and
    `collectTranslatorHistory`'s message parameter is widened to the deep-readonly type (they only read). A chat that
    is not loaded is an error, not an empty history.
  - Request: `requestChatData` in mode `otherAx` with the signal, and as its argument the rows of
    `inputHookMessages` as `formated`, `bias: {}`, `chatRef: ref`, the captured `chatOwner`, `tools: []`,
    `useStreaming: false`, `noMultiGen: true`, and `profileId` only for a hook with a profile model (D5).
  - Result: a failure throws its text; a `streaming` or `multiline` result throws (a returned stream is cancelled
    first, so the transport's pin is released); a success returns `result.trim()`, an empty string included (the
    caller reports an empty result). An abort surfaces as the signal's abort, which the caller tells from a failure by
    `signal.aborted`. The runner adds no string: its errors are the request's text and existing strings.
- `shared/translation/historySlots.ts`: the widened parameter type above, and its header comment, which says only the
  server builds a history.
- `src/ts/process/inputHookRuns.svelte.ts` (new): `createInputHookRuns()`, the screen's hook runs by chat. Its `begin`
  takes the chat ref and the kind and returns null while that chat has a run, else `{ end }`; `kindOf(ref)` is
  reactive (`"draft"`, `"btw"`, or null). It holds no controller: Stop is `sendAborts`' (slice 4).

**Test.** `runInputHook` with the request mocked at `requestChatData`: the rows for a prompt with and without slots,
`otherAx`, `tools: []`, `chatRef` and `chatOwner` passed, a profile model passing `profileId` and an inheriting one
passing none, non-streaming and single output; the history built from the chat's messages with the last message
included and the budget passed; no history build for a prompt without a history slot; a failure, a stream, and a
multiline result throwing, the stream cancelled; an empty success returned as `""`; the signal passed through; the
chat pinned from the start and released after a success, a failure, and an abort. The registry: one run per chat, two
chats at once, `end` idempotent.

**Guide.** `chat-pipeline.md` (the runner and the registry), `llm-requests.md` (the new caller of `requestChatData`,
with its `tools: []` and profile override), `translation.md` (the tab builds a history for an input hook; the tab's
translator still fills the history slots in empty).

**Manual checks.** None: nothing calls the runner yet.

## Slice 4. The Draft flow (_hard_, `chat-pipeline.md`, `draft-recovery.md`, `ui-theming.md`)

**Change.**

- `src/ts/storage/draftJournal.ts`: `ComposerValue` gains `draft?: string` (absent reads as `""`) and `sent?: "draft"`
  (the draft box's text is what this row's send sent). A composer row that holds a nonempty `draft` or the `sent`
  marker, a draft row and a send hand-off row alike, is written with a row format of 2; every other composer row is
  written as today, without the new members and in today's format. The reader accepts both formats for composer rows.
  A reader from before this slice refuses a format 2 row, and the journal's handling of a row it cannot read keeps it
  on every path (read, write and takeover, swap, removal, settle, request update, chat removal, expiry, eviction): an
  older tab sharing the journal neither restores a draft send's original as the sent text nor rewrites the row without
  its draft. That tab's own typing is not journaled into a key such a row occupies while the row is there. Adding
  members to a format 1 row would not do this: `checkComposerValue` accepts unknown members. The row types, the
  validation, the writer, and `seed`'s count of supported rows all learn the second composer format, so the new
  reader does not report its own rows as `journalSkipped`. The IndexedDB version and the other row types' formats do
  not change.
- `src/ts/process/composerDrafts.svelte.ts`: `ComposerDraft` gains `draft: string`, carried by every path that copies
  a composer: the state, `snapshot`, the views' getter and setter, `switchTo`, `write`, and `empty` (a composer with
  only draft text is not empty). `beginSend` takes which box is sent and writes the hand-off with the whole raw
  snapshot and the marker. `restore` installs the whole row (both boxes, the translation box, the attachments), keeps
  the marker on the draft row that replaces the hand-off, and returns the row's sent text. `placeSend` takes the
  failed send, not a text (below).
- `src/ts/process/sendDraft.ts`: one function gives a composer's sent text for both kinds of send (main box plus
  inlay tags, or draft box plus inlay tags; the tags are serialized only here), and every reader of a row's sent text
  uses it: `restore`'s result, `write`'s `retryIdFor` lookup, and `sendDrafts`. `SendDraft` gains
  `composer?: ComposerDraft`, the raw snapshot a draft send consumed; an ordinary send has none and behaves as today.
- `src/lib/ChatScreens/DefaultChatScreen.svelte`:
  - **Send with a hook chosen.** In `sendMain`, after the slash command, binding, and orphaned-override checks and
    before the snapshot: when this is not Continue, the chat is not the playground chat, the main box is not blank,
    and `draftHookOf(hooks, chat.draftHookId)` is a hook, the screen runs it and returns without consuming anything
    (D4). An empty main box, Continue, and a slash command keep today's path. The hook is looked up at the press, not
    at mount.
  - **The run.** It refuses when the chat is busy or already has a hook run (`inputHookRuns.begin`), registers a
    controller in the screen's Stop registry (`sendAborts.begin`, so the existing Stop button shows and `abortChat`
    aborts it; the registration is released when the run ends), and calls `runInputHook` with the main box's text and
    the draft box's text. On return it re-resolves the chat; the result is applied only when the chat is still shown
    and an edit revision that advances with every change of the main box or the draft box is the one captured at the
    start (comparing the two texts at the end is not enough: an edit that was undone still counts). A nonblank result
    replaces the draft box's text through the composer view (journaled as any edit). An empty result alerts `language.errors.emptyText`; a failure alerts its text; an abort and a dropped stale
    result alert nothing. The composer stays as it was in all four. Both boxes stay editable during a run.
  - **Busy during a run.** One screen predicate, the chat is busy or has a hook run, replaces `isChatBusy` at every
    admission check of the screen: both checks in `sendMain`, the one in `sendChatMain` (auto mode and reroll reach
    it without `sendMain`), reroll, unreroll, the other composer actions that check it today, Send Draft, and the two
    hook entries. A send therefore never starts during a run and never registers a second controller for the chat.
    The run's own start checks the registry, not `sendAborts.has`, so it does not refuse itself.
  - **The draft box.** Under the composer, shown for a chat with a Draft hook chosen or a nonempty draft (never for
    the playground chat, and read-only while the binding is incomplete, as the composers are): a labelled textarea
    bound to `composer.draft`, and Send Draft, disabled while the draft is blank, the chat is busy, or a hook runs.
    The Stop button carries a status label while a Draft hook runs.
  - **Send Draft.** The same checks as `sendMain` (busy, binding, orphaned overrides; no slash command handling), then
    the ordinary send path with the draft box's text plus the inlay tags as `input`: `sendDrafts.idsFor` on that text,
    `composer.beginSend` with the whole composer as the snapshot and the draft marked as the sent text, the whole
    composer cleared (main box, translation box, draft box, attachments), and `sendChatMain`. No await sits between
    consuming the composer and the send's admission, as today. The lore-stop repeat carries the same `SendDraft`,
    its `composer` snapshot included (the repeat is built field by field today).
  - **A failed draft send.** Its composer comes back as it was consumed: the main box's original text, the draft
    box's text, the translation box, and the attachments as attachments (not as tags appended to a text). On a reload
    the journal's `restore` does it from the hand-off row; in the running screen `composer.placeSend` does it from the
    `SendDraft`'s `composer` snapshot, at both of its call sites (the settle in `sendChatMain` and the placement of an
    unplaced send when its chat is shown again). A draft send's snapshot is placed only into a composer whose four
    parts are all empty (main box, draft box, translation box, attachments): the user can type and attach during a
    send, and a whole snapshot placed over that would replace it. The settle's `composerEmpty` and the switch-back
    check, which read the main box alone today, read all four for a draft send, as the composer module's `empty` does
    for the journal's `restore`. A draft send that cannot be placed stays unplaced with its hand-off row, and
    `takeUnplaced` does not mark it placed until the gate passes. An ordinary failed send comes back as today: its
    text into an empty main box, leaving attachments queued meanwhile alone.
  - **Retry identity.** `sendDrafts` and the journal keep a failed send's ids by its sent text, as today. Send Draft
    pressed again on the restored composer with the draft unchanged keeps the send's `userMessageId` (and, after an
    uncertain end, its request id); an edited draft is a new send. The marker stays on the restored row while its ids
    do and goes with them.

**Test.** The journal: a row with draft text or the marker written in format 2 and read back; a composer without
either written exactly as before this slice; a reader that accepts format 1 only (the check as it is at `a089c1a16`)
refusing a format 2 row, and that row surviving the older reader's write, takeover, removal, settle, chat removal, and
expiry. The composer: `draft` journaled after an edit and restored on a reload; a row without `draft` read as an empty
draft; a composer with only draft text not treated as empty; a draft send's hand-off row holding the whole snapshot
and the marker; the restore of a failed draft send returning both boxes, the translation box, the attachments, and
the draft-based sent text; `placeSend` restoring the same from the `SendDraft`; an ordinary failed send restored as
today; the retry lookup finding a draft send's ids by its draft text; a landed draft send dropping its row; a draft
typed during a send winning over the hand-off, as today. The screen: Send with a hook chosen runs the hook and sends nothing; the result lands in the draft
box and the main box is unchanged; an empty result, a failure, and an abort leave the composer and alert as stated; a
result for a main box or a draft box edited meanwhile, or for a chat left meanwhile, is dropped without an alert; Stop
aborts the run; a second press during a run does nothing; auto mode, reroll, and Send Draft are refused during a run;
Continue, a slash command, an empty main box, and the playground chat keep today's path;
Send Draft sends the draft text with the attachments and clears all four parts; a failed Send Draft restores both
boxes and retries under the same message id; a chat without a hook sends exactly as before (the unchanged existing
send tests, plus one for a stored id that names no hook).

**Guide.** `chat-pipeline.md` (the send order with a hook, Send Draft, the sent-text function), `draft-recovery.md`
(the composer row's two new fields and the restore of a draft send), `ui-theming.md` (the draft box).

**Manual checks.** A real provider: Send converts, the draft is edited, Send Draft sends. A reload with text in both
boxes brings both back. Stop during a slow hook. A phone: the draft box with the on-screen keyboard open, and the
composer's height after a long result. An IME (Korean, Japanese) composing in the draft box when Enter is pressed.

## Slice 5. BTW (`chat-pipeline.md`, `ui-theming.md`)

**Change.**

- `src/lib/ChatScreens/InputHookPicker.svelte` (new): a dialog listing the BTW hooks by name; choosing one closes it
  and runs the hook, Escape and the backdrop close it.
- `src/lib/ChatScreens/DefaultChatScreen.svelte`:
  - A composer menu entry "BTW", shown while the hook list holds a BTW hook and the chat is not the playground chat
    (D12). With one BTW hook it runs that hook; with several it opens the picker.
  - The run uses slice 4's run: the same busy predicate, registry (`kind: "btw"`), Stop registration, re-resolve, and
    alerts. `content` is the main box's text and `draft` the draft box's text; an empty main box is allowed (a BTW
    prompt may need only the history). It consumes nothing and writes no box, so an edit of the composer during the
    run does not drop the result: it is kept for the chat it ran in while that chat still exists.
  - The result is kept per chat in the screen's memory and shown in a panel over the composer with a dismiss button.
    A later run replaces it. The feature does not journal it or store it in the chat, and it is gone after a reload
    (D9); the request history keeps the request as it keeps any tab request. The panel renders the text as plain text
    (`whitespace-pre-wrap`), not as HTML.

**Test.** The menu entry hidden without a BTW hook; one hook run directly and several through the picker; the run's
slots; the result shown for the chat it ran in and not for another chat; a second run replacing it; dismiss; a failure,
an empty result, and an abort leaving the previous result; nothing written to the composer, the journal, or the chat.

**Guide.** `chat-pipeline.md` (the BTW run), `ui-theming.md` (the menu entry, the picker, the panel).

**Manual checks.** A real provider with a history slot prompt. The panel on a phone with a long result.

## Slice 6. Translation mode (_hard_, `server-generation.md`, `translation.md`, `chat-pipeline.md`)

**Change.**

- `shared/jobs.ts`: `GenerationContext` gains `inputOriginal?: string`: the text the user typed for a send whose
  `input` is a reviewed draft.
- `server/src/routes/generations.ts`: `parseCreateBody` accepts a string `inputOriginal` for the kinds that run the
  input stage, only together with `userMessageId` and a nonempty `input`, and copies it into the parsed context.
- `server/src/jobs/generationJobs.ts`: `requestFingerprint` is unchanged: `inputOriginal` is not part of a request's
  identity (D14).
- `server/src/prompt/runner.ts`: when the input stage appends the user message and the context holds
  `inputOriginal`, the message carries a `translation` whose `text` is `inputOriginal`, whose `sourceHash` is
  `translationSourceHash(data)` with `data` as it is after `editinput`, whose `targetLanguage` is `"original"`, and
  whose `translatedAt` is the append time (D13). An input stage that is skipped because the message already exists
  writes nothing.
- The tab's path from the send to the job: `ServerSendArg` and the explicit context construction in
  `src/ts/process/serverGeneration.ts` (a field it does not name is dropped there), the `Pick` of
  `ServerJobRequest.context` in `src/ts/process/serverCommands.ts`, and `SendDraft`, from which `sendChat`
  (`src/ts/process/index.svelte.ts`) forwards it.
- `src/lib/ChatScreens/DefaultChatScreen.svelte`: Send Draft sets `inputOriginal` to the main box's text when the
  chat's Draft hook, looked up at the press, has `translation` and the main box is not blank. The lore-stop repeat
  carries the same value; a retry of a restored draft send reads the main box and the hook's option again at its
  press (D14).
- `src/lib/Setting/Pages/InputHookSettings.svelte`: the Translation mode checkbox on a Draft hook, with a description
  that says when the stored original is shown: with the LLM translator on the `message` target and a target language
  set, on the row's translation toggle or by the chat's auto-translate.

**Test.** The route: the field accepted, refused for a kind without an input stage, refused without `userMessageId`,
absent from a parsed context that did not send it; the fingerprint the same with and without it, and a second create
under the same request id with another original replayed, not refused. The tab's path: the field reaching
`runServerJob` for a send, a group send, and Continue with text, and absent for a preview and a reroll. The runner:
the appended message holding a translation that `storedTranslation` reads as fresh, also when `editinput` changed the
text; no translation without the field; a second job under the same `userMessageId` leaving the stored message and
its translation as they are. The hand-off: with the stored path's conditions met and `translateBotOnly` off, no run
starts for a user message appended this way; with `translateBotOnly` on the message keeps its translation. The tab:
Send Draft passing the field only for a hook with translation mode, a hook without it and an ordinary send passing
none. The page: the checkbox writing `translation: true` and removing it.

**Guide.** `server-generation.md` (the request field and the input stage), `translation.md` (a stored translation
written by a send; when it is shown; the send hand-off starting no run for it), `chat-pipeline.md` (Send Draft's
field), `settings-i18n.md` (the option).

**Manual checks.** A real provider, with the LLM translator on the `message` target and a target language set: the
sent row's translation toggle shows the typed text; with the chat's auto-translate on it shows without a toggle, and
bilingual display pairs the two; editing the message makes the translation stale; `translateBotOnly` on and off. With
another translator or the `rendered` target the row shows no stored original.

## Decisions

- **D1 (owner).** Everything comes over: Draft hooks, BTW hooks, and translation mode.
- **D2 (owner).** Translation mode stores the original at the server: the send carries it and the job writes it with
  the user message. The hash is then of the text as stored, after `editinput`, and the send hand-off finds the message
  already translated. A tab writing it after the message lands would need the tab to stay open and would race the
  hand-off.
- **D3 (owner).** `useAutoTranslateInput` stays as it is. The draft box shows only for a chat with a Draft hook chosen
  (or with draft text left in it).
- **D4.** The fork's two-box flow is kept: with a hook chosen Send converts and Send Draft sends, and the main box keeps
  what the user typed, so a second Send converts the edited original again. A hook never sends by itself.
- **D5.** A hook runs in the tab through `requestChatData` with the chat's `chatRef`, as the OOC answer does: it runs
  on the chat's bound model preset, is refused while the binding is incomplete, and needs no new server route. It is
  not a job: it holds no chat slot and does not survive a reload. `tools: []` keeps tool records out of the chat; it
  does not keep plugins out of the request, and this plan does not try to.
- **D6.** `inputHooks` is a settings collection of its own kind, merged whole, not a section field. A tab from before
  the field would erase a section field it does not know with any edit of that section, and the list is the user's
  writing; a kind an older tab does not know is never written by it. Keeping the stored list on the server when a
  section write lacks the field was the alternative: it needs a new rule at every write boundary of the store, where
  `prepareWrite` would make the section refuse field patches. A hook's `model` uses the translator step's stored
  shape, not the fork's (`inheritOtherAx`, `modelProfile`); no data moves between the two forks.
- **D7.** A chat's choice is one optional id on the chat. It is not a list field: the panel shows for a loaded chat,
  and a new chat starts with none. Checkpoints keep the current value, a copy and a branch keep it, the upstream export
  strips it. Nothing validates it against the hook list: a stale id reads as no hook, so deleting a hook needs no
  sweep over chats.
- **D8.** The history slots are the translator's: the same builder, the same budget setting, the same block format. The
  tab counts tokens with its own counter under the chat's preset scope, where the server's translator uses the job
  database's. The fork's greeting entry is not brought: this repository's translator history has none.
- **D9.** The draft box's text is the user's writing and is journaled with the composer. A BTW result is a model's
  answer the user can ask for again; it stays in memory.
- **D10.** A hook run registers in the screen's existing Stop registry, not a second stop path, and counts as the chat
  being busy at every admission check of the screen. It is screen-local: another tab, another device, or a plugin can
  still send to the chat during a run (a hook holds no chat slot, D5); leaving the screen ends nothing by itself, and a
  Draft result for a chat no longer shown is dropped.
- **D11.** Continue, a slash command, and an empty main box bypass the Draft hook, as in the fork. Groups are included:
  a hook runs before the send and does not depend on the speaker. The playground chat is excluded.
- **D12.** BTW sits in the composer menu, next to the OOC session, and does not depend on a Draft hook being chosen
  (in the fork its button is inside the draft area). The two differ in weight: the OOC session asks the chat's whole
  prompt and keeps a log; a BTW hook sends one prompt of the user's to the auxiliary model, and the feature keeps its
  result in the screen's memory only, with no chat entry and no journal row. The request history and plugins see the
  request as they see any tab request.
- **D13.** The stored translation is `{ text, sourceHash, targetLanguage: "original", translatedAt }`, without
  `presetId` or `edited`: it is not a translator's output and not a hand edit. The fork's `settingsHash` has no field
  here and freshness never read it.
- **D14.** `inputOriginal` is not part of the request fingerprint, like the revision and the binding ids: retry
  identity follows the action and the sent text. The tab keeps a failed send's ids by its sent text alone, so a retry
  of the same draft after the main box or the hook's option changed carries another original under the same request
  id; with the field in the fingerprint the server would refuse that retry as `requestIdReused`. A replayed request
  keeps what its first attempt stored.
- **D15.** An older server drops the field, so the message has no translation; the tab does not check for that. The
  send still works, and the loss is the option's effect only.
- **D16.** A hook's result that is empty after trimming is an error to the user (`language.errors.emptyText`), not a
  cleared draft.
- **D17.** Not brought from the fork: its writer and session fence (this repository carries the chat ref and owner
  token across awaits instead), the floating composer's Convert preview (there is no floating composer here), the
  settings page's own save-state indicators (settings here save through the settings views), and the per-hook loading
  stage number (the Stop button's label says a hook runs).

## Not In This Plan

- **A hook that sends without review**, and a Draft hook applied to Continue or to a slash command's text.
- **A default Draft hook for new chats**, a character's own choice, or `draftHookId` as a list field a new chat
  inherits.
- **CBS in a hook prompt** (`{{user}}`, `{{char}}`, variables). The prompt takes the four slots only.
- **A greeting entry in the history slots**, for hooks and for the translator alike.
- **A BTW result that survives a reload, is stored with the chat, or can be sent to the chat.** The OOC session is the
  stored side thread.
- **Retiring `useAutoTranslateInput`** in favor of a Draft hook (D3).
- **Hook import and export**, and moving hooks between this fork and `risuai-fastify`.
- **A hook as a server job**, so that a run survives a reload or shows on another device.
