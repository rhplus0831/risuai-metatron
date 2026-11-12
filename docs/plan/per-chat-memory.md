# Per-Chat Memory Plan

Status: drafted 2026-11-12 at `97b64c89d` from the owner's request. D1 to D3 are the owner's, D3 as clarified the same
day: the profile is the memory preset, and the connection is wanted too if it fits. The owner accepted D5 to D8 the
same day. D4 and D9 to D20 are this plan's own, found against the code. Not audited. Landed: none.

Sources: the owner's request (2026-11-12: memory is one switch per character; move it to the chat, let each chat choose
Structured Memory, HypaV3, or Legacy, and let each chat choose the profile memory processing uses); the memory gate and
branch in `assemblePrompt` (`server/src/prompt/assemble.ts`), `loadTaskScope`, `memoryScope`, and `startChecks` in
`server/src/prompt/memory/memoryTasks.ts`, `admitRecord` in `server/src/prompt/memory/structured/recordJob.ts`,
`loadJobScope` and `memorySettingsFingerprint` in `server/src/jobs/jobScope.ts`, `structuredMemorySelected`,
`projectsChat`, and `readWriterSettings` in `server/src/data/resourceStore.ts`, `selectedHypaV3Preset` in
`shared/hypaV3Presets.ts`, `resolveSlotProfile` in `shared/llm/modelSlots.ts`, `confirmMemoryTrim` in
`server/src/prompt/runner.ts`, `Toggles.svelte`, `ChatBindingPanel.svelte`, `BindingScopeNote.svelte`, and
`MemorySettings.svelte`, read at `97b64c89d`; the [memory](../structure/memory.md),
[structured memory](../structure/structured-memory/README.md), [LLM requests](../structure/llm-requests.md), and
[chat store](../structure/chat-store.md) guides. The identifiers are the anchors. Re-verify each cited location before
editing (STRUCTURE.md protocol step 5).

## Goal

A chat decides its own memory: whether it runs, which algorithm runs, with which memory preset, and on which
connection.

- **On or off per chat.** The switch is the chat's. A chat that never chose keeps what its character's switch said, so
  nothing changes on the day this lands.
- **A mode per chat.** Structured Memory, HypaV3, or Legacy. Legacy is today's behavior: the algorithm the Memory
  settings page selects.
- **A memory preset per chat.** The chat can name the HypaV3 preset (budget, summarization, and the Structured Memory
  writer's block) its memory uses, in place of the one Settings selects.
- **A connection per chat.** The chat can name the connection its memory requests run on, in place of the memory slot
  of its model preset.

Not goals: an embedding model per chat; converting one algorithm's data into the other's when a chat changes mode
(D10); removing the global selector or the global preset selection, which are what a chat that did not choose follows.

## Current State

- **The switch.** `supaMemory` on the character or group record. `supaMemoryOnCount` beside it counts off-to-on
  changes; a chat's `memoryTrimAck` holds that count when the user answered "don't ask again" to the no-memory trim
  question, and is honored while the two are equal. Writers: `setMemoryToggle` in `Toggles.svelte` (rendered by
  `CharConfig.svelte` and `OpenChatPanel.svelte`), the `alwaysToggleOn` hook in `characterStore.svelte.ts`
  (`onCharacterSelected`), the "memory" answer in `confirmMemoryTrim`, and `applyPluginCharacter`. Readers: the gate in
  `assemblePrompt` (`useMemory`), `memoryScope` (`memoryOff`), `admitRecord`, `confirmMemoryTrim`, the receipt in
  `Chat.svelte`, the Supa text editor in `CharConfig.svelte`, `CoverageTab.svelte`, `StructuredMemoryPanel.svelte`,
  and the health states in `chatStatus.svelte.ts`.
- **The algorithm.** One for every chat. `ui.memoryAlgorithmType === "structuredMemory"` wins; otherwise the server
  takes `hanuraiEnable`, `hypav2`, `hypaV3`, then SupaMemory when `supaModelType` is not `none`. No shared function
  holds that order: `assemblePrompt` has it inline, `settingsViews.svelte.ts` derives it again for the settings view,
  and the selector in `MemorySettings.svelte` shows its own order (HypaV3, HypaV2, Supa, Hanurai).
- **Who asks which algorithm is selected.** Server: `assemblePrompt`, `startChecks` and `warmWork`, `admitRecord`
  (record now and rebuild), `memorySettingsFingerprint`, `structuredMemorySelected` in the resource store (projection
  overlay on reads, projection revisions, `projectsChat` for the `hypaV3Data` write guard, the rebuild lock), and the
  upstream exporter. Tab: the panel choice in `App.svelte`, the menu row in `DefaultChatScreen.svelte`, the memory
  button in `CharConfig.svelte`, the receipt in `Chat.svelte`, `ContextMeter.svelte`, `chatStatus.svelte.ts`,
  `removeMessages`, `projectionsField`, and `installChatProjection` in `chatStore.svelte.ts`, the detached chat reads
  and their cache in `plugins/apiV3`, `journalRecovery.ts`, and `chatMemoryInherit.svelte.ts`. Each of them has the
  chat, its ref, or its row in reach.
- **What a switch of algorithm does to a chat's data.** Nothing is converted. Structured records stay in their tables
  and HypaV3 summaries stay in `hypaV3Data`. A chat with summaries and no records that enters Structured Memory waits
  for the adopt-or-decline answer (`adoptionHold`); stored summaries own `hypaV3Data`, so the projection stands aside
  until a reset. A task checks the algorithm when it starts, not at each commit.
- **The memory preset.** `hypaV3Presets` with one selected id (`hypaV3PresetId`; the `hypaV3Presets` record's
  `selectedId`). `selectedHypaV3Preset` returns that preset, or the first when the id is gone. HypaV3 and the
  Structured Memory writer and read path both take their settings from it.
  - Server readers go through a job scope's `db`: `getCurrentHypaV3Preset` (HypaV3), `writerCadence`, `writer.ts`,
    `testRun.ts`, `warmWork`, `writerNotice` in `assemblePrompt`, `memorySettingsFingerprint`, and `summarizesLocally`.
    Every scope, a job's and a task's, is built by `loadJobScope`, which has the chat. The one reader with no scope is
    `readWriterSettings` in the resource store, called by `rebuild.ts`.
  - Tab readers take `settings.hypaV3Presets.selectedId`: `getCurrentHypaV3Preset` in `src/ts/process/memory/hypav3.ts`
    (four uses there, and `modal-footer.svelte` and `modal-summary-item.svelte`), `CoverageTab.svelte`,
    `memoryRecordPress.ts`, `StructuredMemoryPanel.svelte`, `chatStatus.svelte.ts`, the `alwaysToggleOn` hook, and
    `MemorySettings.svelte`, whose preset select writes `selectedId`.
- **The model of a memory request.** The memory host (`server/src/prompt/runner.ts`, `memoryTaskHost.ts`) sends mode
  `memory`. `resolveSlotProfile` gives the `memory` slot of the chat's bound model preset when the preset separates
  auxiliary models, and its sub slot otherwise. HypaV3 summaries, the Structured Memory writer, and the `subModel`
  choice of SupaMemory and HypaV2 go that way. The other `supaModelType` values call a fixed completion model with
  `supaMemoryKey`; a local summarization model runs in the tab or not at all; embeddings follow `hypaModel`.
  `resolveSlotProfile` already takes a named `profileId`, which runs on that connection whatever the mode and refuses
  with `missingNamedProfile` when it is gone.
- **Chat fields.** `Chat` in `shared/database.ts`; a scalar is written with `setChatMeta` (the `meta` op), which
  applies on an older revision. The server keeps unknown fields as sent. A field edited on a chat that is not loaded
  must be in `ChatSummary`, `summaryFields` (`server/src/data/chatStore.ts`), and `SUMMARY_FIELD_TYPES`. Copy and
  branch carry every field; a new chat takes its bindings from `initialChatBinding`. Chats are not part of the boot
  normalization pass, and no migration reads one record to write another.
- **Settings pages and the open chat.** The Model, Prompt, and Persona pages show the open chat's bound record, with
  `BindingScopeNote` saying whose it is, and their pickers write the chat. `MemorySettings.svelte` knows no chat. It
  shows one algorithm's settings: the Structured Memory block only while Structured Memory is selected, the HypaV3
  preset only while HypaV3 is.

## Rules For Every Slice

One slice is one session and one commit. Workflow per slice: `opus-workflow` (all five are marked _hard_: each crosses
the server, the tab, and stored data).

- **Checks.** The slice's tests (under "Test"), then `pnpm check`, the focused files through the wrapper while
  iterating, `pnpm --silent test:agent` once whole after the last source edit, `pnpm format:check`, `pnpm check:docs`
  for a guide edit, and `pnpm check:tests` for an added test file. Run `pnpm check` again after the last test edit. V4
  (`rg` each changed export and wire field) and V6 (each new test shown failing once with its guarded line broken).
- **Persisted values.** The four new field names (`memoryEnabled`, `memoryMode`, `memoryPresetId`, `memoryProfileId`)
  and the two stored mode values (`"hypaV3"`, `"structuredMemory"`, the latter being `STRUCTURED_MEMORY_ALGORITHM`)
  are final once slice 1 lands. `supaMemory`, `supaMemoryOnCount`, and `memoryTrimAck` keep their spelling, type, and
  place.
- **An absent field.** Absent means today's behavior, in every reader: no stored switch reads the owner's, no stored
  mode is Legacy, no stored preset is the one Settings selects, no stored connection is the preset's slot. A value of
  the wrong type or an unknown mode reads as absent. No slice rewrites stored chats.
- **One resolver.** Every question "is this chat's memory on", "which algorithm is this chat's", and "which preset is
  this chat's" goes through `shared/chatMemory.ts` (slice 1). A slice that finds another reader of `supaMemory`,
  `memoryAlgorithmType`, or the selected preset routes it there or says in its report why that reader is about the
  global setting itself.
- **A tab loaded before a slice.** It does not know the fields. It keeps showing the character's switch and writes
  `supaMemory`, which from slice 1 on is only the default of a chat that never chose. Nothing is lost; a reload ends
  it. Slice 1 records this in `memory.md` Limitations.
- **Strings.** New text goes in `src/lang/en.ts` with its Korean in `src/lang/ko.ts` in the same slice. The settings
  UI says "connection" for a model profile and "preset" for a HypaV3 preset; the new text does too.
- **Guide.** Each slice names its guides; their `Invariants` apply, and the slice updates the sections and module
  headers that name a changed contract. A guide stays under the 40,000-byte ceiling; `structured-memory/read.md` is at
  38,472, so slice 3 trims there before it adds. Comments and test titles describe behavior, not this plan
  (STRUCTURE.md T5).
- **Manual checks.** Each slice lists the checks it cannot run. The slice report gives them to the owner as a
  checklist; what is still unrun when the plan closes moves to [manual checks](../backlog/manual-checks.md) under this
  plan's name.

## Order

Serial: 1 → 2 → 3 → 4 → 5. All five edit `shared/chatMemory.ts`, the chat memory panel, the language files, and
`memory.md`. Slice 2 gives the server the per-chat mode while nothing can store one; slice 3 gives the tab the same
and adds the control that stores it. Slices 4 and 5 each need only slice 1.

If the run stops early, each prefix stands alone: after slice 1 the switch is the chat's; after slice 2 nothing new
is visible; after slice 3 the mode works with the preset and connection every chat shares; after slice 4 the owner's
three requests are met, and slice 5 is the addition.

## Slice 1. The switch moves to the chat (_hard_, `memory.md`, `chat-store.md`, `persistence.md`)

**Change.**

- `Chat` gains `memoryEnabled?: boolean`, `memoryMode?: "hypaV3" | "structuredMemory"`, `memoryPresetId?: string`,
  and `memoryProfileId?: string`. All four join `ChatSummary`, `summaryFields` (bump `SUMMARY_PROJECTION_VERSION`),
  `SUMMARY_FIELD_TYPES`, the `keep` rows of `shared/chatCheckpoints.ts`, and `METATRON_CHAT_FIELDS` of the upstream
  exporter. Only `memoryEnabled` is read in this slice.
- `shared/chatMemory.ts`, used by the server and the tab:
  - `legacyMemoryAlgorithm(settings)`: the server's order as one function (Structured Memory, Hanurai, HypaV2, HypaV3,
    SupaMemory, none). `assemblePrompt`, `settingsViews.svelte.ts`, and the selector in `MemorySettings.svelte` take it
    from there.
  - `chatMemoryMode(chat)` and `chatMemoryAlgorithm(settings, chat)`. In this slice the second ignores the chat and
    returns the legacy algorithm, so its callers can be moved now and slice 2 changes one function.
  - `chatHypaV3Preset(presets, selectedId, chat)`. In this slice it is `selectedHypaV3Preset`; slice 4 makes it read
    the chat.
  - `chatMemoryEnabled(chat, owner, settings)`: the stored `memoryEnabled` when it is a boolean; otherwise `true` when
    the chat's preset has `alwaysToggleOn` and the chat's algorithm is HypaV3 or Structured Memory (D8); otherwise the
    owner's `supaMemory`.
- Every reader of the switch listed under Current State calls `chatMemoryEnabled`. The `onCharacterSelected` hook that
  writes `supaMemory` for `alwaysToggleOn` is removed.
- Turning a chat's memory on is one tab function (`setChatMemoryEnabled`): a `meta` op that sets `memoryEnabled` and,
  when turning on, unsets `memoryTrimAck` (D9). The "memory" answer of `confirmMemoryTrim` writes the same pair to the
  chat instead of patching the owner. No core path increments `supaMemoryOnCount` any more; `applyPluginCharacter`
  keeps its own increment, and the comparison in `confirmMemoryTrim` stays.
- A new chat stores the resolved switch of the chat it is made from, next to `initialChatBinding` in both new-chat
  paths (`SideChatList.svelte` and `ChatList.svelte`), with the mode, preset, and connection that chat stores (D6). A
  character's first chat stores nothing. Copy, branch, and chat-file import already carry the fields.
- UI: a chat memory panel (`ChatMemoryPanel.svelte`, by `chatRef`, reading the chat's list entry so it works on a
  chat that is not loaded) under `ChatBindingPanel` in `OpenChatPanel.svelte` and `ChatBindingDialog.svelte`. In this
  slice it holds the switch alone. The checkbox leaves `Toggles.svelte`, and with it the character editor. The trim
  question's first answer reads as turning memory on for this chat.
- The upstream exporter writes a character's `supaMemory` as `true` when any of its chats resolves to on (D7).

**Test.** `shared/tests/chatMemory.test.ts`: the legacy order, each default of `chatMemoryEnabled`, a stored `false`
over `alwaysToggleOn`, a malformed value read as absent. `memoryJobs.test.ts`: two chats of one character, one on and
one off, send with and without memory; the "memory" answer sets the chat and leaves the owner and its count alone;
"ignore" then turning the chat on then off asks again. `memoryTasks.test.ts`: `memoryOff` follows the chat.
`Toggles.test.ts` loses its memory cases; a `ChatMemoryPanel` test covers the switch on a loaded and an unloaded chat
and the ack removal. A new-chat test for the inherited switch. `upstreamExport.test.ts`: the four fields are excluded
and `supaMemory` is derived. `chatStatus.test.ts` and `StructuredMemoryPanel.test.ts`: health and the writer notice
follow the chat.

**Manual checks.** The panel at phone width in the sidebar and in the Chat settings dialog; two tabs on one chat, the
switch toggled in one; the trim question's three answers on a real send; an upstream `.bin` export opened in upstream
RisuAI with memory on for the right characters.

## Slice 2. The mode on the server (_hard_, `memory.md`, `structured-memory/projection.md`, `structured-memory/writer.md`, `server-generation.md`)

**Change.**

- `chatMemoryAlgorithm` reads `memoryMode`: `"structuredMemory"` and `"hypaV3"` select those algorithms whatever the
  global flags are; absent is the legacy algorithm.
- `assemblePrompt` branches on the chat's algorithm; `memoryConfigured` is "the chat's algorithm is not none".
- `startChecks`, `warmWork`, and `admitRecord` compare the task's kind with the chat's algorithm. The skip reasons
  keep their names.
- `memorySettingsFingerprint` adds the Structured Memory part when the chat's algorithm is Structured Memory, and
  holds the chat's algorithm itself, so a task queued before a mode change is stale when it starts. A window already
  running when the mode changes finishes as it does under a global switch today (D17).
- The resource store asks per chat. `structuredMemorySelected()` becomes a function of a chat's stored mode and the
  global row: `projectsChat` and the rebuild lock read the mode of one chat row (`json_extract` on its metadata, as
  `selectMemoryAlgorithm` does for the setting), `readProjection` and `readProjectionRevisions` decide per ref, and
  the whole-chat overlay decides per chat from the metadata it already parsed. The projection keeps following the
  algorithm and not the switch (D11).
- The upstream exporter projects a chat's records when that chat's algorithm is Structured Memory.

**Test.** `assemble.test.ts`: under each global selection, a chat with a stored mode runs that mode and its neighbor
runs the global one; a HypaV3-mode chat runs with `hypaV3` off globally; a Structured-mode chat with stored summaries
and no records reports the adoption hold. `memoryTasks.test.ts`: both task kinds are admitted by the chat's mode and
skipped with the existing reasons otherwise; a queued task goes stale on a mode change.
`structuredMemoryRoutes.test.ts`: record now and rebuild are admitted for a Structured-mode chat under another global
selection and refused for a HypaV3-mode chat under global Structured Memory. Resource store tests: a read of two chats
of one character overlays the projection on the Structured one only; the `hypaV3Data` write guard and the rebuild lock
follow the chat. `upstreamExport.test.ts`: per-chat projection.

**Manual checks.** None reachable: no control stores a mode until slice 3.

## Slice 3. The mode in the tab, and its control (_hard_, `memory.md`, `structured-memory/read.md`, `structured-memory/projection.md`, `settings-i18n.md`, `plugin-sandbox.md`)

**Change.**

- Every tab reader of the selected algorithm under Current State takes the chat's: which panel `App.svelte` mounts for
  the selected chat, the menu row and memory button, the receipt, the context meter's estimate, health states (per
  chat key, not all-or-nothing), `removeMessages`, `projectionsField`, `installChatProjection`, and the failure notice
  of `chatMemoryInherit.svelte.ts`.
- Plugin reads: `refreshChatProjections`, `detachedPluginChat`, `readSharedDetachedChats`, and `detachedChatCache.ts`
  hold "this chat is under Structured Memory" per ref instead of one boolean per batch. A mode change of one chat
  invalidates that chat's entries only.
- `journalRecovery.ts` decides per replayed chat: its held or replayed mode over the held or replayed global setting.
- The panel gains the mode select: Legacy (with the name of the algorithm Settings selects now), HypaV3, Structured
  Memory. Choosing Legacy unsets the field.
- `MemorySettings.svelte`: the selector says it is what chats on Legacy use. The HypaV3 preset and the Structured
  Memory block are reachable whatever it selects, since a chat can use either; the legacy algorithm's own settings
  stay under the selector. `searchIndex.ts` follows.
- A chat entering Structured Memory with stored summaries shows the existing adopt-or-decline question; nothing new is
  asked on a mode change.

**Test.** `chatStatus.test.ts`: health for a Structured-mode chat under global HypaV3, none for a HypaV3-mode chat
under global Structured Memory. `chatStore` tests: projection install and the held-field rule per chat; message
removal asks only in a Structured chat. `hostApi.test.ts` and the detached cache tests: two refs of different modes in
one read, and a mode change dropping one entry. A journal recovery test with a replayed mode change.
`ChatMemoryPanel`: the select stores and unsets, on a loaded and an unloaded chat. `MemorySettings` tests: both blocks
reachable under a legacy selection. An `App` or screen test: the panel mounted follows the chat.

**Manual checks.** Two chats of one character in different modes, switching between them with the panel and the
health badge open; a chat moved HypaV3 → Structured (adoption question) → HypaV3 (summaries still used) → Structured
(records still there); a plugin that reads chats (Asset Maid) with mixed modes; the settings page at phone width.

## Slice 4. The memory preset (_hard_, `memory.md`, `structured-memory/writer.md`, `structured-memory/read.md`, `settings-i18n.md`)

**Change.**

- `chatHypaV3Preset` reads the chat: the preset whose id is the chat's `memoryPresetId` when one exists, otherwise
  what `selectedHypaV3Preset` returns (D12).
- Server: `loadJobScope` sets the `hypaV3PresetId` of the scope's `db` to the chat's preset when that preset exists.
  The scope's `db` is already the job's own view (the bound prompt preset and model preset are forwarded onto it the
  same way), every job and task scope is built there, and every server reader under Current State reads through it, so
  none of them changes (D13). `readWriterSettings` takes the chat's stored id from its caller in `rebuild.ts`.
- `memorySettingsFingerprint` needs no change: it fingerprints the scope's preset, so a task goes stale when its
  chat's preset is edited or replaced, and no longer when another preset is.
- Tab: `getCurrentHypaV3Preset` takes the chat, for its four uses in `hypav3.ts` and the two HypaV3 modal components;
  `CoverageTab.svelte`, `memoryRecordPress.ts`, `StructuredMemoryPanel.svelte`, and the health states (per chat key)
  call `chatHypaV3Preset`, as `chatMemoryEnabled` already does for `alwaysToggleOn`.
- The panel gains the preset select: Default (with the name of the preset Settings selects now), then each preset by
  name. Default unsets the field. A stored id that names no preset shows as deleted, and the chat runs on the default
  (D12).
- `MemorySettings.svelte` follows the open chat as the Model and Prompt pages do (D14). While the open chat stores a
  preset that exists, the page shows and edits that preset, marks it as this chat's, and its preset select writes the
  chat. Otherwise, and at home, it shows the default and its select writes `selectedId` as today. Creating, importing,
  and deleting presets are unchanged; a deleted preset leaves chats that named it on the default.
- Chat-file import drops a `memoryPresetId` that names no preset here, where `addChats` sanitizes bindings.

**Test.** `shared/tests/chatMemory.test.ts`: stored, absent, and gone. A `jobScope` test: the scope of a chat with a
stored preset reads that preset through `selectedHypaV3Preset(scope.db)`, and the stored `selectedId` is untouched.
`assemble.test.ts`: two chats of one character on presets with different budgets get different memory budgets, under
HypaV3 and under Structured Memory. `memoryTasks.test.ts`: editing the chat's preset stales its queued task; editing
the default preset does not. A rebuild test: screening follows the chat's preset. `StructuredMemoryPanel.test.ts` and
`chatStatus.test.ts`: cadence and health follow the chat's preset. `MemorySettings` tests: with an open chat that
stores a preset the page edits that preset and the select writes the chat; without one it writes `selectedId`.
`ChatMemoryPanel`: select, unset, deleted state. An import test for the dropped id.

**Manual checks.** Two chats on presets with different budgets, compared in the context report of a real send; the
settings page with such a chat open and at home; deleting a preset a chat names, then sending in that chat; the HypaV3
modal's manual summarize on a chat with its own preset.

## Slice 5. The memory connection (_hard_, `llm-requests.md`, `memory.md`, `structured-memory/writer.md`)

**Change.**

- One server function resolves a scope's memory model: the chat's `memoryProfileId` as the named `profileId` of
  `resolveJobRequestModel(…, "memory", { profileId })` when it is a non-empty string, the slot otherwise. Its callers
  are the four that resolve `"memory"` today (`memorySettingsFingerprint`, `jobMemoryBlockingReason`, `startChecks`,
  `openRun` in the writer) and the two memory hosts, which pass the same `profileId` on their request. The fingerprint
  already holds the resolved profile, so a change of connection stales queued tasks.
- The tab's HypaV3 summarize (`src/ts/process/memory/hypav3.ts`) passes the chat's `profileId` the same way.
- Covered: every request of the memory host, in a job or a task, including record now, the gap run, rebuild and its
  cost preview, and the writer's test run. Not covered, and said so under the control: a fixed-model `supaModelType`,
  a local summarization model, embeddings (D16). Lua's own `memory`-mode request (`server/src/lua/bindings.ts`) is not
  a memory host request and keeps the slot.
- A named connection that is gone refuses, as every named profile does (D15). The panel shows it as deleted, in the
  way `ChatBindingPanel` shows a deleted binding.
- The panel gains the connection select: the preset's memory slot (default, unsets the field) and each connection by
  name. Chat-file import drops a `memoryProfileId` that names no connection here.

**Test.** `server/src/tests` for the resolver: named, absent, gone. `memoryJobs.test.ts` and `memoryTasks.test.ts`: a
chat's memory request runs on the named connection while the main request stays on the preset's; a gone connection
fails the memory step with the named-profile message; a connection change stales a queued task; a Plugin-format
connection gives `pluginModel`. A writer test: `openRun` records the named model. `ChatMemoryPanel`: select, unset,
deleted state. An import test for the dropped id.

**Manual checks.** A real send with a cheaper connection named for memory, checked in request history; deleting the
named connection and sending; the HypaV3 modal's manual summarize on a chat with a named connection.

## Decisions

D1 to D3 are the owner's request of 2026-11-12; the owner accepted D5 to D8 the same day. The rest are this plan's and
wait for the audit.

- D1. Whether memory runs is chosen per chat.
- D2. Each chat chooses Structured Memory, HypaV3, or Legacy; Legacy follows the globally configured memory as today.
- D3. Each chat can choose the profile memory processing uses. The profile is the HypaV3 preset (slice 4). The
  connection that holds the model, key, and endpoint is included as well (slice 5), as the owner asked for it if it
  fits.
- D4. The two are separate fields, `memoryPresetId` and `memoryProfileId`, each with its own control. A preset says
  how memory works and a connection says where its requests go; the model preset already separates them the same way.
- D5. No stored chat is rewritten. Chats are outside the boot normalization pass, a pass that wrote every chat would
  move every chat's revision under open tabs, and D2 of STRUCTURE.md already makes chat readers supply defaults. So a
  chat with no stored switch reads its owner's `supaMemory`.
- D6. A new chat stores the switch, mode, preset, and connection of the chat it is made from, as bindings do under
  `inherit`. Without this a character whose `supaMemory` is unset would need the switch turned on in every new chat.
- D7. `supaMemory` stays on the character and group record, because upstream cards, upstream backups, and plugins
  carry it. Core UI no longer writes it. A write from a plugin or an import changes the default of chats that never
  chose. The upstream export derives it: on when any chat of the owner is on.
- D8. `alwaysToggleOn` stops writing. It makes a chat with no stored switch read as on under HypaV3 or Structured
  Memory; a stored off wins. Today it turns the character back on at every selection, which per chat would make "off"
  impossible to keep. It is read from the chat's preset.
- D9. `memoryTrimAck` keeps its number and its comparison with the owner's count. Turning a chat's memory on removes
  it, which is what the count did for every chat of the character at once.
- D10. A mode change converts nothing and asks nothing new. It does to one chat what a change of the global selector
  does to every chat today: records and summaries both stay, the adoption question appears where it would, and a
  projection stands aside while summaries are stored.
- D11. Projection of structured records onto `hypaV3Data` follows the chat's algorithm, not its switch, as today.
- D12. A stored preset id that names no preset reads as the default. `selectedHypaV3Preset` already falls back when
  the selected id is gone, a preset holds settings and no credential, and a refusal would stop sends over a deleted
  preset.
- D13. The server applies the chat's preset once, in `loadJobScope`, on the scope's `db`. The alternative, passing the
  chat to each of some ten readers, changes more code for the same result and leaves the next reader free to forget.
  The audit confirms that nothing reads a scope's `hypaV3PresetId` as the stored selection.
- D14. The Memory settings page edits the open chat's preset when the chat stores one, as the Model and Prompt pages
  edit the open chat's bound record. Without this, editing a preset only one chat uses would first make it the default
  of every chat.
- D15. A named connection that was deleted refuses the memory request. No fallback to the slot: `resolveSlotProfile`'s
  rule is that a dangling id refuses and never redirects, since another connection can mean another provider and
  another bill.
- D16. The connection covers the memory host's requests only.
- D17. A task window already running when a chat's mode changes finishes. The fingerprint stops the next start. This
  is the fence a global switch has today; a check at each commit is left to the audit to ask for.
- D18. The four fields are summary fields, so the Chat settings dialog can edit a chat that is not loaded.
- D19. A malformed stored value reads as absent in the resolver; the server normalizer does not reject it. The server
  keeps unknown chat fields as sent today, and a refusal would fail a chat-file import over a setting.
- D20. The embedding model stays one setting. Stored vectors are tied to the model that made them, so a model per chat
  is its own design.

## Not In This Plan

- An embedding model per chat.
- A character-level default for new chats, or "apply to every chat of this character". Legacy plus the global
  selector and the default preset move every chat that did not choose.
- Converting records to summaries or summaries to records on a mode change, beyond the existing adoption.
- Removing `supaMemory` or `supaMemoryOnCount` from stored records.
- Hanurai, HypaV2, or SupaMemory as per-chat modes of their own; they are reachable through Legacy.
- Preset fields that only some chats override. A chat names a whole preset.

## Open Questions

None open. The owner answered the profile question and accepted D5 to D8 on 2026-11-12.
