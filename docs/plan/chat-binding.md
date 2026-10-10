# Chat Binding Plan

Status: slices 1–6 done; slice 7 (e2e and docs) planned. Each chat
binds its own **model preset**, **prompt preset**,
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
10. **Requests that have no chat are not sends.** The playground, translating
    UI text, card tools, and other `/api/llm/request` calls without a
    `chatRef` are never refused by a binding and carry no `chatRef`. They run
    on the settings views: the selected chat's bound ids where they exist,
    else the tab selection, i.e. what the screen shows. (Amended in slice 4:
    with decision 8 the tab selection is visible only at home, so a chatless
    request on it would run on settings the screen does not show.)

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
  - Not ok: reject with 409 `chatBindingIncomplete`, carrying `problems`.
  - Ok, but `context.presetId`, `modelPresetId`, or `personaId` differ from
    the binding: reject with 409 `chatBindingMismatch`. The tab saw an
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
- **`POST /api/llm/request` when `args.chatRef` is set** gets the same two
  checks; inside a callback of that chat's job it is compared with the job's
  targets instead (a `presetChain` pick included). `loadRequestDb` itself
  does not change.
- **`POST /api/transform`** is a read-only render and uses the **display
  rule** (decided while implementing): per field, the bound id when it names
  a record that exists, else the tab's. The server rejects (409
  `chatBindingMismatch`) only a field bound to an existing record that is
  sent differently; `bindingReview` does not matter.
- **Tests** in `server/src/tests/`: unset field, gone record, review pending,
  mismatch, the `presetChain` re-scope allowed, the persona prompt gate using
  the bound persona, and a request without `chatRef` unaffected.

### 3. Client contexts and the send guard

- **Every context builder takes its ids from `chatBinding(ref)`** for the ref
  it captured, never from the views (renders and plugin contexts use the
  display rule, `chatDisplayIds(ref)`):
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
  - When the binding is not ok, it shows the problems (`alertError`) and
    returns `refused`; opening the binding panel comes with slice 5.
  - Chat LLM requests have the same guard in `requestChatData` (before hooks
    and tools) and at `requestChatDataMain` (a plugin's direct call, the
    browser-run models); a request inside a job callback is exempt.
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

- **The open chat** is the selected chat (`currentChatRef()`): the selected
  character's selected chat, also on its closed-chat screen and while it
  loads. Only home has none.
- **The resolvers.** `resolvePreset`, `resolveModelPreset`, and
  `resolvePersona` (`src/ts/storage/settingsViews.svelte.ts`) first try the
  open chat's bound id (`selectedChat`), then the tab selection.
  - Per field, as the display rule: a bound id whose record exists wins; an
    unset or deleted one falls through; `bindingReview` does not matter.
  - `chatStore.svelte.ts` registers the reader of the selected chat's binding
    fields (`setOpenChatBindingSource`), since it imports the views; the
    reader is held in state, so a view read before the registration reruns.
  - `chatDisplayIds` falls back to the tab selection proper
    (`tabSelectionIds`), never to the open chat's binding.
  - The fallback branch keeps its write to `selection` for the tab ids only.
    It never writes a chat id there, and it never writes the chat.
  - `presetRecordForWrite`, `modelPresetRecordForWrite`, and
    `personaRecordForWrite` follow the same order, so the settings pages edit
    what the open chat uses. The view setters, `writeModelRoot`, and a
    plugin's `updateSettings` without captured ids write there too.
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
  - `translator/translator.ts` (`activePreset.regex`, the module scripts,
    and their CBS read the captured transform's chat; its LLM translation of
    chat text goes out without the chat's ref, a chatless request on the
    views per decision 10);
  - `process/stringlize.ts`;
  - `files/inlays.ts`.
  - Also found and fixed: a CBS parse with a `chatRef` (`risuChatParser`)
    reads that chat's display ids, which covers commands, lore activation,
    and `parseChatML` (HypaV3 summaries); lore activation tokenizes with the
    chat's model preset; `getModules(chatRef)` and `getChatVarOf` read the
    chat's preset; the WebLLM path, `exportChat`, the rich message copy, and
    the asset pass of `ParseMarkdown` read their chat's names and icon before
    their awaits; job hooks describe plugin models with the job's model
    preset.
  - Persona helpers (`getUserName(ref)` and the others) fall back to the
    tab's persona, not the open chat's.
- **Requests without a chat** (decision 10) run on the views, read once
  before any await: `requestChatDataMain` scopes them to a bare preset pair
  (no `chatRef`, so no binding refuses them) and the transport sends the same
  ids, its persona `activePersona`. Their plugin settings calls, CBS, and
  translator prompts read the same views.
- **Scoped CBS** (`risuChatParserScoped`, a plugin context or a captured
  chat) reads the preset-owned variable defaults and module integration from
  its scope too (`getChatVarOf`/`getModules` take an optional scope), so a
  `presetChain` pick's parse uses the picked preset.
- **Until slice 5** the pickers changed only the tab selection. With a
  bound field, a list highlighted the bound record and a pick changed nothing
  visible.
- **Tests** (`src/ts/storage/tests/chatBindingViews.test.ts` and
  `chatBindingReaders.test.ts`):
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
- **As built** (decided while implementing):
  - **The pick target.** `pickBinding(field, id, target?)`
    (`src/ts/storage/chatBindingPick.ts`): a `ChatRef` picks for that chat, `null` for the tab
    selection, and `undefined` for the open chat at the call, else the tab selection at home. A
    chat's pick sets only that field: the tab selection and `bindingReview` stay. It does nothing
    (returns false) for a record or chat that is gone. An action with an await before its pick
    (persona creation) captures the target first. `changeUserPersona(id, target?)` and the
    Ctrl+1..9 hotkeys go through it. `changeToPreset`/`changeToModelPreset` stay tab-only, and so
    does the plugin API's `selectedPersona` setter.
  - **The picker stores carry the chat.** `openPresetList`, `openModelPresetList`, and
    `openPersonaList` hold `true` (what the screen shows) or `{ chatRef }` (a panel row). In chat
    mode a list marks the chat's bound id that exists (`pickedId`), never the view's tab fallback,
    and names the chat. A list opened for a chat closes when that chat is gone. The PersonaSettings
    icon grid marks the same way; its editor stays on `activePersona`.
  - **The panel** (`src/lib/SideBars/ChatBindingPanel.svelte`) sits at the top of
    `OpenChatPanel.svelte` and in a dialog (`src/lib/Others/ChatBindingDialog.svelte`, store
    `chatBindingDialog`). The dialog is what the send area and the chat list's "Chat settings" open,
    since the sidebar's panel cannot be opened from code without forcing the sidebar's local state.
    It is an ordinary overlay mounted before the picker lists, so a list opened from a row paints on
    top and alerts stay above both. It closes when its chat is gone. Escape closes only the topmost
    layer (an alert, else the prompt comparison, else a picker list, else the dialog), also from a
    text field, and Ctrl+1..9 does nothing while a list or the dialog is open.
  - **The send area.** An incomplete binding turns the send button into "Set up this chat" (it keeps
    `button-icon-send`, so the send hotkey opens the setup too). `sendMain`, Continue included, checks
    the binding after the `/command` branch and before it consumes anything, so the text, the
    translation draft, and the attachments stay.
  - **Deletion** counts the chats bound to the record over every character's list entries
    (`chatsBoundTo`, an untracked snapshot), and moves only the tab selection, and only when the
    selection named the record. `removeModelPreset` keeps its tab-only repair.
  - The settings headers show `BindingScopeNote` ("This chat" or "Not set for this chat", nothing at
    home) for the model preset, the prompt preset, and the persona.
  - The prompt preset's bias import captures the preset id before its file dialog, as its icon
    import does.

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
- **As built** (decided while implementing):
  - **Inherit** reads the character's selected chat through `selectedChatId`, which already answers
    the first chat in order when none is chosen, from its list entry (an unloaded chat works). The
    new-chat buttons read it before `createChat`, since the new chat becomes the selected one.
  - **A source awaiting its confirmation** (an imported chat) gives its existing ids to a new chat
    without `bindingReview`, as the plan says: the source stays blocked, and the new chat can be
    sent. Changing that is a change of decision 4 or 6, not a fix.
  - **Imports** pass every format through `importChat`'s `addChats`, which runs
    `importedChatBinding` before `createChat`; an imported `bindingReview: false` is overwritten.
  - **Unchanged on purpose:** the first chat of a new character (`ensureChat`, character creation,
    card imports, the playground, module conversion) is built empty; chats a plugin supplies
    (`setChats`, character replacement and insertion through `installCharacterChats`) keep what
    the plugin passes. The policy lives in the callers, never in `createChat`.
  - **The setting** sits on the accessibility page next to `createFolderOnBranch` (there is no
    chat behaviour page), as a segmented choice whose value reads anything but `empty` as `inherit`,
    as the creation does, so the page never rewrites an unexpected value.

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
