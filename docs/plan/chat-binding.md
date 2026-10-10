# Chat Binding Plan

Status: slice 1 done; slices 2–7 planned. Each chat binds its own **model preset**, **prompt preset**,
and **persona**, and a chat cannot be sent until all three are bound. This is
the "Later: per-chat selection" follow-up of [split-preset.md](split-preset.md),
with one deliberate change: that section sketched a fallback to the tab
selection, and this plan removes it.

Reference: `/home/codex/risuai-fastify` binds the same three per chat through a
mandatory `chat.generationSettings` record (`packages/shared-core/src/chatGenerationSettings.ts`,
`server/fastify/src/prompt/effectiveGenerationConfig.ts`). This plan takes its
fail-closed rule, and not its shape or its rehoming on delete.

## Why

The tab selection (`src/ts/storage/selection.svelte.ts`) is per tab and not
tied to any chat. Switching chats does not switch the prompt preset or the
persona, so a chat would silently send with whatever the tab last selected.
The point of this plan is that this cannot happen any more: a send names the
chat's own three ids or does not happen.

## Product decisions

1. **Fail closed.** Generation reads only the chat's bound ids. An unset id, a
   bound record that no longer exists, or an imported binding not yet
   confirmed blocks the send. The client checks this, and the server rejects
   it independently. Generation never falls back to the tab selection.
2. **The model is bound as a model preset id.** It is not bound as per-chat
   profiles or slots. Profiles stay shared through the preset's slots, so the
   three request contracts and the server loaders keep their shape.
3. **Deleting a bound record never picks a replacement.** The affected chats
   show the binding as gone and stay blocked until the user picks again.
   (fastify's `rehomeGenerationReferences` is the accident this plan exists to
   remove.)
4. **New chats start from a user setting**, `newChatBinding`:
   - `inherit` (default): copy the binding of the same character's previous
     chat, keeping only ids that still exist.
   - `empty`: start unbound.

   Copying the tab selection is not an option, since it is the fallback again.

5. **Copies and branches keep their source's binding**, whatever the setting
   says.
6. **Imported chats keep the ids that exist here, but need one confirmation**
   (`bindingReview`) before their first send.
7. **Existing chats are not migrated.** `bindedPersona` already is the persona
   binding, so chats that had it stay bound. The model and prompt presets of
   older chats cannot be guessed, so those chats ask on their first send.
8. **Pickers act on what the screen shows.** While a chat is open, the model
   and prompt preset lists, the persona list, and the Ctrl+1..9 preset hotkeys
   change that chat's binding. With no chat open (the home screen) they change
   the tab selection, as today.
9. **`presetChain` is job-local.** The server's pick re-scopes that one job
   (`prompt/runner.ts`, `setCallbackPreset`). The tab no longer calls
   `changeToPreset` on the `preset` event, and the chat's binding is not
   rewritten.
10. **Requests that have no chat are unchanged.** The playground, translating
    UI text, card tools, and other `/api/llm/request` calls without a
    `chatRef` keep using the tab selection. They are not sends.

## Data model

- `Chat` (`shared/database.ts`) gains `promptPresetId?: string` and
  `modelPresetId?: string`. They live next to the existing
  `bindedPersona?: string`, which keeps its misspelled persisted name (D3).
  It also gains `bindingReview?: boolean`, set on import and cleared by the
  user's confirmation.
- All four fields are **list fields**, so the binding of a chat that is not
  loaded resolves synchronously. The context builders read it before any
  await. They are added to:
  - `ChatSummary` (`shared/chats.ts`);
  - `chatSummary()` (`server/src/data/chatStore.ts`);
  - `ChatEntryMeta`, `metaOf`, `ChatListEntry`, and `SUMMARY_FIELD_TYPES`
    (`src/ts/storage/chatStore.svelte.ts`). `SUMMARY_FIELD_TYPES` gains a
    `"boolean"` type for `bindingReview`.
- No server normalizer change: `normalizeChatMeta` (`server/src/data/chats.ts`)
  stores chat fields as sent (D2). Readers treat a missing field as unset.
- `newChatBinding: "inherit" | "empty"` goes in the `ui` section
  (`shared/sections.ts` `SECTION_FIELDS.ui`, a type entry in `Database`). Its
  default `"inherit"` comes from the `ui` normalizer in
  `server/src/data/normalize/`. Check the section with `settings-i18n.md`
  before adding it.

## The resolver

One pure function in a new `shared/chatBinding.ts` is used by both sides:

```ts
type ChatBindingField = "modelPresetId" | "promptPresetId" | "personaId";
type ChatBindingProblem = { field: ChatBindingField; reason: "unset" | "gone" } | { field: "review" };
type ChatBindingResult =
  | { ok: true; ids: { modelPresetId: string; promptPresetId: string; personaId: string } }
  | { ok: false; problems: ChatBindingProblem[] };

function resolveChatBinding(
  chat: Pick<Chat, "modelPresetId" | "promptPresetId" | "bindedPersona" | "bindingReview">,
  exists: { modelPreset(id: string): boolean; promptPreset(id: string): boolean; persona(id: string): boolean },
): ChatBindingResult;
```

It has no fallback branch. It reports every problem at once, so the UI can
list them all.

## Slices

### 1. Schema and resolver

- Add the `Chat` fields, the list-field plumbing, and the `newChatBinding`
  section field with its normalizer default.
- Add `shared/chatBinding.ts` and its tests: each problem kind, several
  problems at once, a blank string treated as unset.
- Client: add `src/ts/storage/chatBinding.svelte.ts`.
  - `chatBinding(ref)` runs `resolveChatBinding` over the list entry and the
    settings records.
  - `chatBindingPatch(ref, patch)` writes through `setChatMeta` by chat id.
  - It is its own module so that `settingsViews.svelte.ts` can read it through
    a registered getter without an import cycle with `chatStore.svelte.ts`.

### 2. Server enforcement

- **Generation jobs** (`server/src/routes/generations.ts` and `create` in
  `server/src/jobs/generationJobs.ts`). Before a job is created, read the
  chat's list fields (`store.readRefs`) and run `resolveChatBinding`.
  - Not ok: reject with 409 `chat_binding_incomplete`, carrying `problems`.
  - Ok, but `context.presetId`, `modelPresetId`, or `personaId` differ from
    the binding: reject with 409 `chat_binding_mismatch`. The tab saw an
    older binding.
  - Checking at creation keeps `job.targets`, which is built from
    `body.context`, equal to the binding.
  - This applies to every kind in `GENERATION_KINDS`, `preview` and
    `previewPrompt` included: a preview of a chat that cannot be sent would
    show a prompt that will never run.
- **`loadJobScope`** (`server/src/jobs/jobScope.ts`) repeats the check on the
  `chatRead` it already makes. This covers a job whose chat changed between
  creation and scope load. A `presetChain` re-scope changes only the prompt
  preset of its own job and is exempt.
- **Remove the selected/effective persona split for chat jobs.** For a chat
  the selected persona is the bound persona, so the server ignores
  `context.selectedPersonaId` and uses `personaId` for both.
  - This also fixes the gate in `server/src/prompt/assemble.ts`
    (`if (db.personaPrompt)`). Today it tests the _tab's_ persona prompt,
    while the content comes from the bound persona.
  - It also fixes `runSetup.ts` `selectedPersonaPrompt` and the root
    `db.username`.
  - Keep the field in the contract for requests without a chat.
- **`POST /api/transform`** (`TransformContext` has `chatId`) and
  **`POST /api/llm/request` when `args.chatRef` is set** get the same two
  checks. `loadRequestDb` itself does not change.
- **Tests** in `server/src/tests/`: unset field, gone record, review pending,
  mismatch, the `presetChain` re-scope allowed, the persona prompt gate using
  the bound persona, and a request without `chatRef` unaffected.

### 3. Client contexts and the send guard

- **Every context builder takes its ids from `chatBinding(ref)`** for the ref
  it captured, never from the views:
  - `runPinnedServerJob` (`src/ts/process/serverCommands.ts`). Drop the
    `activePreset`/`activeModelPreset`/`checkPersonaBinded` defaults.
    `options.identity`, for reruns of a held job, stays.
  - `requestChatDataServer` (`src/ts/process/request/transport.ts`). Today it
    reads `activePreset`, `activeModelPreset`, and `checkPersonaBinded()`
    _without_ the ref. When `chatRef` is null, keep the tab selection
    (decision 10).
  - `captureTransform` (`src/ts/parser/transformClient.ts`).
  - `capturePluginContext` (`src/ts/plugins/apiV3/pluginContext.ts`).
- **The guard goes in `runPinnedServerJob`**, before `flushResources`, so
  send, continue, reroll, group, preview, and command jobs all pass through
  it.
  - When the binding is not ok, it shows the problems (`alertError`), opens
    the chat's binding panel (slice 5), and returns `refused`.
  - The server's 409 codes map to the same message.
  - A mismatch refreshes the chat's list entry and asks for a resend.
- **`applyJobPreset`** (`src/ts/network/generationJobs.ts`) stops calling
  `changeToPreset` (decision 9).
- **Tests:**
  - extend `src/ts/process/request/tests/requestPresetScope.test.ts` and add
    `chatBinding` tests: a context names the captured chat's ids while another
    chat is open, and an unbound chat is refused before any request;
  - update the tests that seed a send (they now bind the chat).

### 4. Views follow the open chat

- **The resolvers.** `resolvePreset`, `resolveModelPreset`, and
  `resolvePersona` (`src/ts/storage/settingsViews.svelte.ts`) first try the
  open chat's bound id (`selectedChat`), then the tab selection.
  - The fallback branch keeps its write to `selection` for the tab ids only.
    It never writes a chat id there, and it never writes the chat.
  - `presetRecordForWrite`, `modelPresetRecordForWrite`, and
    `personaRecordForWrite` follow the same order, so the settings pages edit
    what the open chat uses.
- **The readers.** This brings along every reader of `activePreset`,
  `activeModelPreset`, `activeMainProfile`, `profileForSlot`, `activePersona`,
  and `resolveModelSlot` without a slot scope. The `Toggles.svelte` toggles,
  `chatVar.svelte.ts` defaults, `moduleIntergration`, the tokenizer and
  `getModelInfo`, `Suggestion.svelte`, `{{model}}`, and `DevTool.svelte` all
  follow it.
- **Persona display.** `checkPersonaBinded`, `getUserName`, `getUserIcon`, and
  `getPersonaPrompt` (`src/ts/util.ts`) and the `$derived` user name and icon
  in `DefaultChatScreen.svelte` read the same order through
  `resolvePersona`.
  - An unbound chat therefore renders with the tab's persona. This is only
    for display: it cannot send, and the binding panel shows the persona as
    unset.
- **Readers that capture a ref before an await must use the ref.** They run
  for a chat that may not be the open one, so they use
  `chatBinding(ref)`-scoped reads (`PresetScope`, `scopedPresetRoot`), not the
  views. Audit:
  - `process/memory/hypav3.ts` (`maxResponse`, `resolveModelSlot("memory")`);
  - `process/request/shared.ts` (sampling parameters);
  - `process/request/request.ts` (`activeMainProfile`);
  - `translator/translator.ts` (`activePreset.regex`);
  - `process/stringlize.ts`;
  - `files/inlays.ts`.
- **Tests** (`src/ts/storage/tests/settingsViews.test.ts`):
  - the open chat's binding wins;
  - a gone chat id falls through to the tab selection without writing it;
  - a write goes to the bound record;
  - leaving the chat restores the tab selection.

### 5. UI

- **A binding panel in `src/lib/SideBars/OpenChatPanel.svelte`**, above
  `Toggles`.
  - It has three rows (model preset, prompt preset, persona). Each shows the
    bound name or a state: unset, deleted, or needs confirmation.
  - Each row opens its picker in chat mode.
  - When `bindingReview` is set, the panel shows a confirm button that clears
    it.
  - The model and module chat menus (`ModuleChatMenu.svelte`) are the pattern
    to follow.
- **Pickers.**
  - `src/lib/Setting/botpreset.svelte` (both kinds) and
    `src/lib/Setting/listedPersona.svelte` act on the open chat when there is
    one, through `chatBindingPatch` on the captured ref. With no chat open
    they act on the tab selection (decision 8).
  - The same rule applies to `changeUserPersona` in `src/ts/persona.ts`, the
    persona selection in `PersonaSettings.svelte` (create, delete, icon
    grid), and the Ctrl+1..9 preset hotkeys in `src/ts/hotkey.ts`.
  - A deletion in `PersonaSettings.svelte` no longer selects the next persona
    for the open chat.
- **Settings headers.** `ModelSettings.svelte`, `PromptPresetSettings.svelte`,
  and `QuickSettingsGUI.svelte` mark the shown preset as "this chat's" while a
  chat is open.
- **Send area.** In `DefaultChatScreen.svelte`, an unbound chat's send button
  reads "set up this chat" and opens the panel. The guard in slice 3 still
  covers every other path.
- **Chat lists.**
  - `SideChatList.svelte` rows get an incomplete-binding marker.
  - The `chatOptions` "Bind Persona" item (`AlertComp.svelte`
    `chatOptions`, `alertChatOptions`) becomes "Chat settings". It opens the
    same three pickers for that row's ref, which works for a chat that is not
    loaded because the fields are list fields.
- **Deletion.** Deleting a model preset (`removeModelPreset`), a prompt preset
  (`botpreset.svelte` `removeListed`), or a persona does not touch chats.
  - Where the client already has the list entries, the confirmation names how
    many chats use the record.
- **i18n.** Add strings to `src/lang/en.ts` and `ko.ts`. Retire the
  `bindPersona`/`doYouWantTo(Un)BindCurrentPersona` strings once nothing uses
  them.

### 6. New-chat defaults and imports

- **`initialChatBinding(chaId)`** in `chatBinding.svelte.ts`.
  - With `newChatBinding === "inherit"`, it copies the binding of the
    character's selected chat (`chatPage`/selection at the time of the click),
    else of the first chat in the character's order. It keeps only ids that
    still exist, and never copies `bindingReview`.
  - With `"empty"`, or when the character has no chat, it returns nothing.
- **Callers that create a fresh chat:**
  - the new-chat buttons in `SideChatList.svelte` and
    `src/lib/Others/ChatList.svelte`, group chats included;
  - `ensureChat` in `chatStore.svelte.ts`, a character's first chat, which is
    therefore empty.
- **Callers that are not fresh chats** spread their source and so keep its
  binding:
  - the copy (`chatCopySource`) in `SideChatList.svelte`;
  - the branch in `Chat.svelte`.
  - Plugin `setChats` keeps what the plugin passes.
- **`importChat`** (`src/ts/characters.ts`) clears ids that do not exist here
  and sets `bindingReview: true` on every imported chat. A backup restore
  replaces the whole database on the same instance and needs no review.
- **The setting** goes in the chat behaviour page (`settings-i18n.md`
  registry), as a two-way choice.
- **Tests:** inherit copies the previous chat's ids and drops gone ones; empty
  starts unbound; copy and branch keep the source binding; import sets
  review and drops gone ids.

### 7. E2E and docs

- **E2E.** Every spec that sends must bind its chat. Do that in the shared
  seed next to the mock-provider model profile and slot setup
  (`d53e52ab test(e2e): seed the mock provider through model profiles and slots`),
  not spec by spec.
  - Extend `e2e/personaBinding.spec.ts`.
  - Add specs for:
    - an unbound chat that refuses to send and opens the panel;
    - inherit on a new chat;
    - an imported chat that needs a confirmation;
    - two tabs showing two bound chats that send with their own presets.
- **Docs.**
  - [split-preset.md](split-preset.md): point "Later: per-chat selection" at
    this plan and drop the fallback sentence.
  - `docs/plan/README.md`: add this plan.
  - Guides:
    - `persistence.md`: the chat list fields;
    - `chat-pipeline.md`: the send guard and contexts;
    - `settings-i18n.md`: the pickers and views, and `newChatBinding`;
    - `self-host-server.md`: the 409 codes and the persona split removal;
    - `STRUCTURE.md` D2: views read the open chat's binding first.

## Order and risk

- **Order.** Slices 1–3 make sending safe on their own and can ship first.
  Slices 4–6 make the client show and edit what a chat uses.
- **Slices 2 and 3 land together.** Otherwise the server rejects what the
  client still sends with tab ids.
- **Risks.**
  - **Readers that capture a ref (slice 4 audit).** One that keeps reading
    the views would use the open chat's preset for a background chat's
    request. The server still blocks a wrong id for jobs, transforms, and
    chat requests, but not wrong _parameters_ computed on the client. Those
    come only from `request/shared.ts` and the tokenizer, which the audit
    covers.
  - **Old chats ask on their first send.** That is intended (decision 7). The
    panel makes it a three-click fix.
