# Input Hooks Plan

Status: drafted 2026-11-15 at `a089c1a16` from the owner's request to bring the input hooks of the `risuai-fastify`
fork here. Not yet audited against the code. D1 to D3 are the owner's answers of 2026-11-15; D4 on are this plan's own.
Landed: none.

Sources: the fork's implementation, read at its `1df024db5` (`runInputHook`, the input hook activity store, the draft
hook translation, the hook settings page, the hook picker dialog, the chat's draft hook selector, the draft and BTW
parts of its chat screen, and its "Translation And Input Hooks" guide); here, `requestChatData` and its `chatRef`,
`tools`, and `profileId` arguments in `src/ts/process/request/request.ts`; the OOC answer request in
`src/ts/ooc/oocSession.svelte.ts`; `runTranslatorPipeline`'s request in `src/ts/translator/translator.ts`;
`collectTranslatorHistory`, `buildTranslatorHistory`, and `translatorHistoryCount` in
`shared/translation/historySlots.ts`; `fillTranslatorSlots`, `parseTranslatorChatML`, and `buildTranslatorStepMessages`
in `shared/translation/pipeline.ts`; `normalizeStepModel` in `shared/translatorPresets.ts`; `SECTION_FIELDS` in
`shared/sections.ts`; the `memoryTranslateMedia` spec in `server/src/data/normalize/memoryTranslateMedia.ts`;
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
  different: one prompt of the user's own, on the auxiliary model, without the chat's prompt, kept nowhere (D12).
- **The tab can request a reply itself.** `requestChatData(arg, mode, signal)` takes `formated` rows, a required
  `bias`, `useStreaming`, `noMultiGen`, a `chatRef`, `tools`, and `profileId`. A request with a `chatRef` runs on that
  chat's bound presets and is refused while the binding is incomplete or after the chat is gone; `profileId` runs it
  on that model profile instead of the mode's slot. Without `tools` it lists the chat's tools and stores the calls'
  records in the chat; the OOC request passes `tools: []`. The provider request itself runs on the server
  (`/api/llm/request`) except for plugin providers and WebLLM. The result is a buffered success, a stream, a
  `multiline` list, or a failure.
- **History slots.** `collectTranslatorHistory(messages, messageIndex, count)` walks back from the message before
  `messageIndex` (an index equal to the list's length is accepted), skips disabled and comment rows, and stops at
  `disabled: "allBefore"`. `buildTranslatorHistory` renders both slots for the given counts under a token budget
  (`translatorHistoryMaxTokens`) with a `countTokens` the caller supplies. Only the server's translation runner calls
  it today. There is no greeting entry: a greeting is not a stored message.
- **Slot parsing is per feature.** `SLOT_PATTERN` and `translatorHistorySlotCounts` in `shared/translation/pipeline.ts`
  are tied to translator steps; `parseTranslatorChatML` is exported and pure.
- **Settings sections.** A settings field is a `Database` field listed in one `SECTION_FIELDS` section, with its kind
  and fresh-boot default in that section's `SectionSpec` (the type makes a missing entry an error). `irisDialogue` is a
  section field holding a list of records (`["array"]`). A setting upstream lacks is named in `METATRON_ONLY_SETTINGS`.
- **Chat metadata.** Fields are stored largely as sent. `CHECKPOINT_CHAT_FIELDS` is exhaustive over `ChatMeta`.
  `METATRON_CHAT_FIELDS` lists what the upstream export strips. `translatorPresetId` is a per-chat id of this kind,
  written with `setChatMeta` from `ChatTranslationPanel.svelte`, which `OpenChatPanel.svelte` mounts while a
  translator is set.
- **The composer.** `createComposer` keeps one `ComposerDraft` (`input`, `translate`, `files`) per chat and journals
  it (`ComposerValue`, a draft row and a send hand-off row). `sendMain` checks busy state, a slash command, the
  binding, and orphaned lore overrides, then snapshots the composer, calls `composer.beginSend`, clears the composer,
  and calls `sendChatMain` with a `SendDraft` (`input`, `userMessageId`, `requestId`); nothing awaits between consuming
  the input and the send's admission. A failed send's text returns through `sendDrafts.settle`, `composer.placeSend`,
  or the journal's `restore`, all of which derive the sent text with `composerSendText` (main box plus inlay tags).
- **Stop.** `sendAborts.begin(ref)` registers the chat's controller for the length of `sendChatMain`'s send; the Stop
  button shows while `sendAborts.has(ref)` or the tab owns a job, and `abortChat` aborts both. Nothing shows progress
  before `sendAborts.begin`.
- **The user message is appended by the job.** The input stage of `server/src/prompt/runner.ts` runs the `input`
  trigger and `editinput` (Lua, a tab plugin, regex scripts) over `context.input` and appends
  `{ role: "user", data, time, chatId: userMessageId }`. It is skipped when the chat already holds a user message
  under that id. `parseCreateBody` rebuilds `context` from a fixed property list, and `requestFingerprint` hashes a
  fixed set of fields, adding `oocExchangeId` only when present.
- **Stored translations.** `MessageTranslation` has `text`, `sourceHash`, `targetLanguage`, and `translatedAt`, plus
  optional `presetId` and `edited`. `isMessageTranslation` is its shape check and `storedTranslation` its only
  freshness rule (`sourceHash === translationSourceHash(data)`). `targetLanguage` and `presetId` are informational. A message appended
  with a well-formed translation keeps it. The send hand-off translates a send's messages after the reply and returns
  a message that already holds a fresh stored translation without a run; `translateBotOnly` leaves user messages out.
  `Chat.svelte` shows a fresh stored translation on an explicit toggle, or by the chat's `autoTranslate` while a target
  language is set.
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
  journal marker `sent`. Final once slice 6 lands: the request field `context.inputOriginal`.
- **Absent means today.** A chat without `draftHookId` (or with one that names no Draft hook) sends exactly as at
  `a089c1a16`, and a composer whose draft box is empty journals rows of today's shape. A job without `inputOriginal`
  runs as today. Slices 4 and 6 each have a test for this.
- **A hook never writes the chat.** A hook run is a tab request with `tools: []`: it appends no message and stores no
  tool-call record. The only chat writes of this plan are `draftHookId` (slice 2) and the user message's translation
  (slice 6), which the job writes with the message.
- **Carry the chat across awaits.** A hook run captures the chat's ref and owner before its first await and re-resolves
  them after each one (STRUCTURE.md D1). A result for a chat that is gone, no longer shown, or whose composer text
  changed since the run began is dropped.
- **New files.** A new source file gets its owner (`pnpm docs:owner <path>`, `docs/structure/ownership.json`) in the
  slice that adds it.
- **A tab or server from before a slice.** An older tab never writes `draftHookId` and leaves a stored one alone (a
  `meta` op names its fields). A section write that lacks `inputHooks` stores the default list (`normalizeSection`),
  as with every section field added before; resource writes carry revision and epoch (STRUCTURE.md D4), and this plan
  adds no further guard. An older server drops `inputOriginal` in `parseCreateBody` and appends the message without a
  translation.
- **Strings.** New text goes in `src/lang/en.ts` with its Korean in `src/lang/ko.ts` in the same slice, under one
  `inputHooks` object. The user-facing names are "Input Hooks" (Korean: "입력 훅"), "Draft" ("초안"), and "BTW". The
  fork's strings are the starting text.
- **Guide.** Each slice names its guides; their `Invariants` apply, and the slice updates the sections and module
  comments that name a changed contract. Comments and test titles describe behavior, not this plan (STRUCTURE.md T5).
- **Manual checks.** Each slice lists the checks it cannot run. The slice report gives them to the owner as a
  checklist; what is still unrun when the plan closes moves to [manual checks](../backlog/manual-checks.md) under this
  plan's name.

## Order

Serial: 1 → 2 → 3 → 4 → 5 → 6. Slices 2 and 3 share no file and can run together after slice 1. Slice 4 needs the
runner (3) and the chat's choice (2). Slice 5 uses slice 4's run registry and draft box. Slice 6 extends slice 4's
Send Draft.

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
    `model` is normalized as a translator step's is, and `translation` as above. Anything else in an entry is dropped.
    A value that is not a list reads as `defaultInputHooks()`; an empty list stays empty.
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
- `shared/sections.ts`: `inputHooks` joins `SECTION_FIELDS.memoryTranslateMedia` (beside `useAutoTranslateInput`).
- `server/src/data/normalize/memoryTranslateMedia.ts`: the spec entry (`["array", defaultInputHooks()]`) and a
  `normalizeInputHooks` pass in `normalizeMemoryTranslateMedia`.
- `server/src/data/upstream/exportDatabase.ts`: `inputHooks` joins `METATRON_ONLY_SETTINGS`; `draftHookId` joins
  `METATRON_CHAT_FIELDS`.
- `shared/chatCheckpoints.ts`: `draftHookId` is `keep` (D7).
- The chat copy and the branch keep `draftHookId` (they spread the source), and the local chat import keeps it as
  unknown metadata does today; nothing validates it against the hook list (D7).

**Test.** `normalizeInputHooks` (a non-list reads as the default, an empty list stays, a duplicate id and a malformed
entry dropped, `translation` kept only as `true` on a Draft hook, a profile model kept and a malformed one read as
`inherit`, the limit); `draftHookOf`; `inputHookHistoryCounts` (repeats once, an invalid count ignored, a history slot
inside another slot not counted); `inputHookMessages` (each slot filled, a filled value not read for slots again, a
ChatML prompt, a slot prompt as one user row, a slotless prompt as system plus user); a fresh section holding the
default hook; the field surviving a section normalize; a checkpoint load leaving `draftHookId` as it is; the upstream
export leaving both fields out.

**Guide.** `persistence.md` (the settings field, the chat field, the checkpoint choice), `server-resources.md` (the
section's normalizer).

**Manual checks.** None: nothing a user can reach changes.

## Slice 2. The settings page and the chat's choice (`settings-i18n.md`, `ui-theming.md`)

**Change.**

- `src/ts/settingsMenu.ts`: `INPUT_HOOKS_SETTINGS_MENU = 24`. `src/ts/router/routes.ts`: the slug `input-hooks`.
  `src/lib/Setting/Settings.svelte`: a `navGroups` entry next to Translation and the render branch.
  `e2e/settingsPages.spec.ts`: the page's row in `PAGES`.
- `src/lib/Setting/Pages/InputHookSettings.svelte` (new), handwritten UI over `settings.memoryTranslateMedia.inputHooks`
  (the list is reassigned on every edit; no draft layer of its own, D17):
  - A type select (Draft, BTW) and Add: a new hook with a new id, the type's name, an empty prompt, and
    `model: { mode: "inherit" }`; it opens expanded with its name focused. Add is disabled at `MAX_INPUT_HOOKS`.
  - One card per hook: name, type, model (Other auxiliary model, or a model profile, with the profile select
    `TranslatorStepEditor.svelte` uses for a step), the prompt (`TextAreaInput` with the popup editor and the hook's id
    as `popupEditorContext`), a Translation mode checkbox on a Draft hook, and Delete behind the usual removal
    confirmation. Changing a Draft hook to BTW drops its `translation`.
  - A short description of the two types and of the four slots, and an empty-state line.
- `src/lib/SideBars/ChatDraftHookPanel.svelte` (new), mounted by `OpenChatPanel.svelte` beside the translation panel
  while the hook list holds a Draft hook or the chat's `draftHookId` is set: a select of None and the Draft hooks,
  written with `setChatMeta` (None unsets the field). A stored id that names no Draft hook shows as a missing entry the
  user can clear, as the translation panel shows a missing translator preset.
- The strings under `language.inputHooks`, English and Korean.

**Test.** The page over the real settings views: add, rename, change type (the `translation` drop), change model, edit
the prompt, delete, the limit; the list written as a new array. The panel: hidden without a Draft hook and without a
stored id, the select writing and unsetting `draftHookId` for the chat ref it was given, a missing id shown and
cleared. The route table (`input-hooks` both ways). The e2e page row (mounts, a later traversal writes nothing).

**Guide.** `settings-i18n.md` (the page, the menu index, the strings), `ui-theming.md` (the sidebar panel).

**Manual checks.** The page on a phone-width viewport; the popup prompt editor writing back to the right hook after
another hook was added or removed meanwhile.

## Slice 3. The tab's hook runner (`chat-pipeline.md`, `llm-requests.md`)

**Change.**

- `src/ts/process/inputHooks.ts` (new): `runInputHook(hook, { ref, content, draft, signal })`, returning the trimmed
  result text or throwing.
  - Before any await it captures the chat's owner token (`chatOwnerToken`) and reads the chat's messages
    (`findChat(ref)`).
  - History: when `inputHookHistoryCounts(hook.prompt)` is not empty, it calls `buildTranslatorHistory` with the
    chat's messages, `messageIndex` equal to their count (the text being written comes after them), the counts,
    `settings.memoryTranslateMedia.translatorHistoryMaxTokens`, and the tab's token counter under the chat's preset
    scope (D8). A chat that is not loaded is an error, not an empty history.
  - Request: `requestChatData` in mode `otherAx` with the signal, and as its argument the rows of
    `inputHookMessages` as `formated`, `bias: {}`, `chatRef: ref`, the captured `chatOwner`, `tools: []`,
    `useStreaming: false`, `noMultiGen: true`, and `profileId` only for a hook with a profile model (D5).
  - Result: a failure throws its text; a `streaming` or `multiline` result throws; a success returns `result.trim()`,
    an empty string included (the caller reports an empty result). An abort surfaces as the signal's abort, which the
    caller tells from a failure by `signal.aborted`.
- `src/ts/process/inputHookRuns.svelte.ts` (new): `createInputHookRuns()`, the screen's hook runs by chat. Its `begin`
  takes the chat ref and the kind and returns null while that chat has a run, else `{ end }`; `kindOf(ref)` is
  reactive (`"draft"`, `"btw"`, or null). It holds no controller: Stop is `sendAborts`' (slice 4).

**Test.** `runInputHook` with the request mocked at `requestChatData`: the rows for a prompt with and without slots,
`otherAx`, `tools: []`, `chatRef` and `chatOwner` passed, a profile model passing `profileId` and an inheriting one
passing none, non-streaming and single output; the history built from the chat's messages with the last message
included and the budget passed; no history build for a prompt without a history slot; a failure, a stream, and a
multiline result throwing; an empty success returned as `""`; the signal passed through. The registry: one run per
chat, two chats at once, `end` idempotent.

**Guide.** `chat-pipeline.md` (the runner and the registry), `llm-requests.md` (the new caller of `requestChatData`,
with its `tools: []` and profile override).

**Manual checks.** None: nothing calls the runner yet.

## Slice 4. The Draft flow (_hard_, `chat-pipeline.md`, `draft-recovery.md`, `ui-theming.md`)

**Change.**

- `src/ts/process/composerDrafts.svelte.ts`: `ComposerDraft` gains `draft: string` (the view's getter and setter, the
  snapshot, the empty check, the journal write). `beginSend` takes which text is sent.
- `src/ts/storage/draftJournal.ts`: `ComposerValue` gains `draft?: string` (absent reads as `""`) and `sent?: "draft"`.
  A row without either is today's row, written and read as today; `checkComposerValue` accepts both shapes, so a row
  from before this slice stays readable and a tab from before it keeps reading rows whose draft is empty.
- `src/ts/process/sendDraft.ts`: one function gives a composer's sent text for both kinds of send (main box plus
  inlay tags, or draft box plus inlay tags), and every reader of a stored row's sent text uses it: the journal's
  `restore` result, the `retryIdFor` lookup, and `sendDrafts`. `SendDraft` gains `draftOf?: { original: string }`,
  set for a draft send.
- `src/lib/ChatScreens/DefaultChatScreen.svelte`:
  - **Send with a hook chosen.** In `sendMain`, after the slash command, binding, and orphaned-override checks and
    before the snapshot: when this is not Continue, the chat is not the playground chat, the main box is not blank,
    and `draftHookOf(hooks, chat.draftHookId)` is a hook, the screen runs it and returns without consuming anything
    (D4). An empty main box, Continue, and a slash command keep today's path. The hook is looked up at the press, not
    at mount.
  - **The run.** It refuses when the chat is busy or already has a hook run (`inputHookRuns.begin`), takes the chat's
    Stop controller (`sendAborts.begin`, so the existing Stop button shows and `abortChat` aborts it), and calls
    `runInputHook` with the main box's text and the draft box's text. On return it re-resolves the chat; the result is
    applied only when the chat is still shown and its main box still holds the text the run began with. A nonblank
    result replaces the draft box's text through the composer view (journaled as any edit). An empty result alerts
    `language.errors.emptyText`; a failure alerts its text; an abort alerts nothing. The composer stays as it was in
    all three. While a run is in flight the chat counts as busy for Send, Send Draft, Continue, reroll, and BTW.
  - **The draft box.** Under the composer, shown for a chat with a Draft hook chosen or a nonempty draft (never for
    the playground chat, and read-only while the binding is incomplete, as the composers are): a labelled textarea
    bound to `composer.draft`, and Send Draft, disabled while the draft is blank, the chat is busy, or a hook runs.
    The Stop button carries a status label while a Draft hook runs.
  - **Send Draft.** The same checks as `sendMain` (busy, binding, orphaned overrides; no slash command handling), then
    the ordinary send path with the draft box's text plus the inlay tags as `input`: `sendDrafts.idsFor` on that text,
    `composer.beginSend` with the whole composer as the snapshot and the draft marked as the sent text, the whole
    composer cleared (main box, translation box, draft box, attachments), and `sendChatMain`. No await sits between
    consuming the composer and the send's admission, as today. The lore-stop repeat carries the same `SendDraft`.
  - **A failed draft send.** Its composer comes back whole: the main box's original text and the draft box's text,
    by the journal's `restore` (the hand-off row holds both) or by `composer.placeSend`, which takes the `SendDraft`
    and restores both boxes from its `draftOf`. The empty-composer condition that gates a restore reads both boxes.
    Send Draft pressed again on the restored composer keeps the send's `userMessageId`, as an unchanged ordinary retry
    does.

**Test.** The composer: `draft` journaled after an edit and restored on a reload; an empty draft writing today's row
shape; a row without `draft` read as an empty draft; a draft send's hand-off row holding both boxes and `sent`; the
restore of a failed draft send returning both boxes and the draft-based sent text; the retry lookup finding a draft
send's ids by its draft text; a landed draft send dropping its row; a draft typed during a send winning over the
hand-off, as today. The screen: Send with a hook chosen runs the hook and sends nothing; the result lands in the draft
box and the main box is unchanged; an empty result, a failure, and an abort leave the composer and alert as stated; a
result for a main box edited meanwhile, or for a chat left meanwhile, is dropped; Stop aborts the run; a second press
during a run does nothing; Continue, a slash command, an empty main box, and the playground chat keep today's path;
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
  - The run uses slice 4's run: the same busy rules, registry (`kind: "btw"`), Stop controller, re-resolve, and alerts.
    `content` is the main box's text and `draft` the draft box's text; an empty main box is allowed (a BTW prompt may
    need only the history). It consumes nothing.
  - The result is kept per chat in the screen's memory and shown in a panel over the composer with a dismiss button.
    A later run replaces it. It is not journaled, not stored in the chat, and gone after a reload (D9). The panel
    renders the text as plain text (`whitespace-pre-wrap`), not as HTML.

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
- `server/src/jobs/generationJobs.ts`: `requestFingerprint` adds `inputOriginal` only when present, as it does
  `oocExchangeId`, so existing receipts keep their hashes (D14).
- `server/src/prompt/runner.ts`: when the input stage appends the user message and the context holds
  `inputOriginal`, the message carries a `translation` whose `text` is `inputOriginal`, whose `sourceHash` is
  `translationSourceHash(data)` with `data` as it is after `editinput`, whose `targetLanguage` is `"original"`, and
  whose `translatedAt` is the append time (D13). An input stage that is skipped because the message already exists
  writes nothing.
- `src/ts/process/serverCommands.ts`: `ServerJobRequest.context` picks `inputOriginal`; `sendChat` forwards it from the
  `SendDraft`.
- `src/lib/ChatScreens/DefaultChatScreen.svelte`: Send Draft sets `inputOriginal` to the main box's text when the
  chat's Draft hook, looked up at the press, has `translation` and the main box is not blank. The lore-stop repeat and
  a retry of a restored draft send carry it again.

**Test.** The route: the field accepted, refused for a kind without an input stage, refused without `userMessageId`,
absent from a parsed context that did not send it; the fingerprint unchanged for a body without it and different with
it. The runner: the appended message holding a translation that `storedTranslation` reads as fresh, also when
`editinput` changed the text; no translation without the field; a second job under the same `userMessageId` leaving
the stored message as it is. The hand-off: a user message appended this way is returned as fresh and not translated
again. The tab: Send Draft passing the field only for a hook with translation mode, a hook without it and an ordinary
send passing none.

**Guide.** `server-generation.md` (the request field and the input stage), `translation.md` (a stored translation
written by a send; the send hand-off skipping it), `chat-pipeline.md` (Send Draft's field).

**Manual checks.** A real provider: the sent row's translation toggle shows the typed text; with the chat's
auto-translate on and a target language set it shows without a toggle, and bilingual display pairs the two; editing
the message makes the translation stale; `translateBotOnly` on and off.

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
  not a job: it holds no chat slot and does not survive a reload. `tools: []` keeps tool records out of the chat.
- **D6.** `inputHooks` is a section field of `memoryTranslateMedia`, not a collection: a list this small needs no
  per-item merge, selection, or file format. A hook's `model` uses the translator step's stored shape, not the fork's
  (`inheritOtherAx`, `modelProfile`); no data moves between the two forks.
- **D7.** A chat's choice is one optional id on the chat. It is not a list field: the panel shows for a loaded chat,
  and a new chat starts with none. Checkpoints keep the current value, a copy and a branch keep it, the upstream export
  strips it. Nothing validates it against the hook list: a stale id reads as no hook, so deleting a hook needs no
  sweep over chats.
- **D8.** The history slots are the translator's: the same builder, the same budget setting, the same block format. The
  tab counts tokens with its own counter under the chat's preset scope, where the server's translator uses the job
  database's. The fork's greeting entry is not brought: this repository's translator history has none.
- **D9.** The draft box's text is the user's writing and is journaled with the composer. A BTW result is a model's
  answer the user can ask for again; it stays in memory.
- **D10.** A hook run takes the chat's existing Stop controller, not a second stop path, and counts as the chat being
  busy. It is screen-local: leaving the screen ends nothing by itself, and a result for a chat no longer shown is
  dropped.
- **D11.** Continue, a slash command, and an empty main box bypass the Draft hook, as in the fork. Groups are included:
  a hook runs before the send and does not depend on the speaker. The playground chat is excluded.
- **D12.** BTW sits in the composer menu, next to the OOC session, and does not depend on a Draft hook being chosen
  (in the fork its button is inside the draft area). The two differ in weight: the OOC session asks the chat's whole
  prompt and keeps a log; a BTW hook sends one prompt of the user's to the auxiliary model and keeps nothing.
- **D13.** The stored translation is `{ text, sourceHash, targetLanguage: "original", translatedAt }`, without
  `presetId` or `edited`: it is not a translator's output and not a hand edit. The fork's `settingsHash` has no field
  here and freshness never read it.
- **D14.** `inputOriginal` joins the request fingerprint when present: a retry of the same draft send carries the same
  original, and a body under the same request id with another original is a different request.
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
