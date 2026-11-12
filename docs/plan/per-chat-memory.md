# Per-Chat Memory Plan

Status: drafted 2026-11-12 at `97b64c89d` from the owner's request. D1 to D3 are the owner's, D3 as clarified the same
day: the profile is the memory preset, and the connection is wanted too if it fits. The owner accepted D5 to D8 the
same day. D4 and D9 to D23 are this plan's own, found against the code. Audited against `b6d07a04a` on 2026-11-12
([report](../reports/audits/plan-runner/per-chat-memory-2026-11-12.md)): eight findings, all fixed here (D17, D18,
and D21 to D23 come from them). Landed: none.

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
  overlay on reads, the event bytes `readRefsWithinBudget` charges for it, projection revisions, `projectsChat` for
  the `hypaV3Data` write guard, the rebuild lock), and the upstream exporter. Tab: the panel choice in `App.svelte`, the menu row in `DefaultChatScreen.svelte`, the memory
  button in `CharConfig.svelte`, the receipt in `Chat.svelte`, `ContextMeter.svelte`, `chatStatus.svelte.ts`,
  `removeMessages`, `projectionsField`, and `installChatProjection` in `chatStore.svelte.ts`, the detached chat reads
  and their cache in `plugins/apiV3`, `journalRecovery.ts`, and `chatMemoryInherit.svelte.ts`. Each of them has the
  chat, its ref, or its row in reach.
- **What a switch of algorithm does to a chat's data.** Nothing is converted. Structured records stay in their tables
  and HypaV3 summaries stay in `hypaV3Data`. A chat with summaries and no records that enters Structured Memory waits
  for the adopt-or-decline answer (`adoptionHold`); stored summaries own `hypaV3Data`, so the projection stands aside
  until a reset. A task checks the algorithm when it starts, not at each window or commit. A HypaV3 summary that lands
  on a chat whose `hypaV3Data` the projection owns is dropped by the write guard (`refusesHypaV3Data`), and
  `checkpointOf` still counts it as committed.
- **The memory preset.** `hypaV3Presets` with one selected id (`hypaV3PresetId`; the `hypaV3Presets` record's
  `selectedId`). `selectedHypaV3Preset` returns that preset, or the first when the id is gone. HypaV3 and the
  Structured Memory writer and read path both take their settings from it.
  - Server readers go through a job scope's `db`: `getCurrentHypaV3Preset` (HypaV3), `writerCadence`, `writer.ts`,
    `testRun.ts`, `warmWork`, `writerNotice` in `assemblePrompt`, `memorySettingsFingerprint`, and `summarizesLocally`.
    Every scope that runs memory, a job's and a task's, is built by `loadJobScope`, which has the chat (the display
    transform builds its own and runs no memory). The one reader with no scope is `readWriterSettings` in the resource
    store, called by `memoryWorkCost` in `rebuild.ts` for the cost preview.
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
  must be in `ChatSummary`, `summaryFields` (`server/src/data/chatStore.ts`), and `SUMMARY_FIELD_TYPES`; on such a
  chat `setChatMeta` throws for any other key, set or unset, and queues an unset only for a key the summary holds.
  Copy and branch carry the chat's metadata (all but `pinned`); a new chat takes its bindings from
  `initialChatBinding`. Chats are not part of the boot normalization pass, and no migration reads one record to write
  another.
- **Plugin writes of whole chats.** `applyChatResult` compares a plugin's chat with the baseline of the plugin's read
  and unsets a key the result omits. A plugin instance keeps sixteen baselines and a write consumes one; with none
  left, `reconcileCharacterChats` takes the chat as it is now for the baseline, so a field set after the plugin read
  its copy is unset.
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
  `supaMemory`, which from slice 1 on is only the default of a chat that never chose; that switch removes no chat
  field. A plugin's whole-chat write from such a tab can still remove a field its copy never held, since D21's
  protection is in the new bundle. A reload ends both. Slice 1 records this in `memory.md` Limitations.
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

Serial: 1 → 2 → 3 → 4 → 5. Every slice edits `shared/chatMemory.ts` and `memory.md`; slices 1, 3, 4, and 5 edit the
chat memory panel and the language files. Other files more than one slice edits:

- Server: `assemble.ts` (1, 2), `memoryTasks.ts` (1, 2, 5), `recordJob.ts` (1, 2), `jobScope.ts` (2, 4, 5),
  `runner.ts` (1, 5), `resourceStore.ts` (2, 4), `server/src/data/chatStore.ts` (1 for the summary projection, 2 for
  the `hypaV3Data` write guard), the upstream exporter (1, 2).
- Tab: `chatStore.svelte.ts` (1, 3), `MemorySettings.svelte` (1, 3, 4, 5), `Chat.svelte` and `CharConfig.svelte` (1,
  3), `chatStatus.svelte.ts` (1, 3, 4), `CoverageTab.svelte` and `StructuredMemoryPanel.svelte` (1, 4),
  `src/ts/process/memory/hypav3.ts` (4, 5), `src/ts/characters.ts` (4, 5).
- Tests and guides: `memoryJobs`, `memoryTasks`, `assemble`, `upstreamExport`, `chatStatus`,
  `StructuredMemoryPanel`, `MemorySettings.*`, and `shared/tests/chatMemory.test.ts`, in the slices that name them;
  `structured-memory/projection.md` (2, 3), `writer.md` (2, 4, 5), `read.md` (3, 4), `settings-i18n.md` (3, 4).

Slice 2 gives the server the per-chat mode before any control of ours stores one; slice 3 gives the tab the same and
adds the control. The server already keeps a `memoryMode` it is sent, from a plugin, a chat file, or a recovery, so
between slices 2 and 3 such a chat runs its mode on the server while the tab still shows the global one. Slices 4 and
5 each depend only on slice 1's fields and resolver, and are written on top of whatever landed before them.

If the run stops early, each prefix supports the controls it has shipped: after slice 1 the switch is the chat's;
after slice 2 there is no new control, and a mode a chat was given some other way runs on the server alone, as said
above; after slice 3 the mode works with the preset and connection every chat shares; after slice 4 the owner's three
requests are met, and slice 5 is the addition.

## Slice 1. The switch moves to the chat (_hard_, `memory.md`, `chat-store.md`, `persistence.md`)

**Change.**

- `Chat` gains `memoryEnabled?: boolean`, `memoryMode?: "hypaV3" | "structuredMemory"`, `memoryPresetId?: string`,
  and `memoryProfileId?: string`. All four, and the existing numeric `memoryTrimAck`, join `ChatSummary`,
  `summaryFields` (a stored `false` is projected; bump `SUMMARY_PROJECTION_VERSION`, which rebuilds the summary rows
  of an existing database without touching a chat's revision), and `SUMMARY_FIELD_TYPES`. The four join the `keep`
  rows of `shared/chatCheckpoints.ts` and `METATRON_CHAT_FIELDS` of the upstream exporter. Only `memoryEnabled` is
  read in this slice.
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
  when turning on, unsets `memoryTrimAck` (D9). With the ack in the summary, the unset is queued for a chat that is
  not loaded too. The "memory" answer of `confirmMemoryTrim` writes the same pair to the chat through
  `services.writeChat`, as its "ignore" answer writes the ack, instead of patching the owner. No core path increments
  `supaMemoryOnCount` any more; `applyPluginCharacter` keeps its own increment, and the comparison in
  `confirmMemoryTrim` stays.
- A new chat stores the resolved switch of the chat it is made from, next to `initialChatBinding` in both new-chat
  paths (`SideChatList.svelte` and `ChatList.svelte`), with the mode, preset, and connection that chat stores (D6). A
  first chat made for a new character or group stores nothing. Copy, branch, chat-file import, plugin creation,
  recovery, and the upstream import carry the fields a chat is given.
- When `reconcileCharacterChats` has no retained baseline of the plugin's read and takes the current chat instead, it
  keeps the four memory fields the result omits, by filling them into the incoming chat before `applyChatResult`, so
  the branch that replaces the whole chat is covered too (D21). With a retained baseline the diff is as for every
  field. The rule does not reach `setChatToIndex`, other fields, or `memoryTrimAck`.
- UI: a chat memory panel (`ChatMemoryPanel.svelte`, by `chatRef`, reading the chat's list entry so it works on a
  chat that is not loaded) under `ChatBindingPanel` in `OpenChatPanel.svelte` and `ChatBindingDialog.svelte`. In this
  slice it holds the switch alone. The checkbox leaves `Toggles.svelte`, and with it the character editor. The trim
  question's first answer reads as turning memory on for this chat.
- The upstream exporter writes a character's `supaMemory` as `true` when any of its chats resolves to on (D7). It
  resolves each chat before `upstreamChat` strips the fields, from the settings as stored: the exporter turns
  `hypaV3PresetId` into upstream's position before it reaches the characters.

**Test.** `shared/tests/chatMemory.test.ts`: the legacy order, each default of `chatMemoryEnabled`, a stored `false`
over `alwaysToggleOn`, a malformed value read as absent. `memoryJobs.test.ts`: two chats of one character, one on and
one off, send with and without memory; the "memory" answer sets the chat and leaves the owner and its count alone;
"ignore" then turning the chat on then off asks again. `memoryTasks.test.ts`: `memoryOff` follows the chat.
`Toggles.test.ts` loses its memory cases; a `ChatMemoryPanel` test covers the switch on a loaded and an unloaded chat,
and the ack removed on both. `chatSummaries.test.ts`: the five fields projected, `false` included, after a reopen at
the new version. `chatCheckpoints.test.ts`: the kept fixture holds the four. `hostApiChats.test.ts`: a write with no
retained baseline keeps the four fields, and one with a baseline unsets an omitted one. A new-chat test for the
inherited switch. `upstreamExport.test.ts`: the four fields are excluded and `supaMemory` is derived.
`chatStatus.test.ts` and `StructuredMemoryPanel.test.ts`: health and the writer notice follow the chat.

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
- `memorySettingsFingerprint` adds the Structured Memory part when the chat's algorithm is Structured Memory. A queued
  task is skipped when the chat's algorithm no longer matches its kind (`notStructuredMemory`, `notHypaV3`); a stored
  mode that resolves to the same algorithm as before does not invalidate it.
- A task also asks the chat's algorithm before each further window and before each commit, for both kinds and for a
  rebuild's staging and swap; a mismatch ends the task as skipped and writes nothing (D17). The check reads the chat
  as stored and the global selector as stored, not the task's scope, in the same synchronous step as the commit. The
  stop does not abort: `endRunning` aborts the task's controller, so the task takes the path HypaV3 already has for
  ending unsaved, which cancels queued requests and awaits the active ones. `checkpointOf` does not count a HypaV3
  summary the write guard dropped.
- The resource store asks per chat. `structuredMemorySelected()` becomes a function of a chat's stored mode and the
  global row, read once per read operation: `projectsChat` and the rebuild lock read the mode of one chat row
  (`json_extract` on its metadata, as `selectMemoryAlgorithm` does for the setting), `readProjection` and
  `readProjectionRevisions` decide per ref, and the whole-chat overlay decides per chat from the metadata it already
  parsed. `readRefsWithinBudget` charges event bytes for the chats whose algorithm is Structured Memory and for no
  other: `chatEventBytes` and `characterEventBytes` take the stored mode of each chat row in their aggregate, beside
  the global row. Charging every chat instead would bill dormant records, and a character with many of them would
  need more rounds inside the one deadline a whole read has. The projection keeps following the algorithm and not the
  switch (D11).
- The `hypaV3Data` write guard decides by the mode the operation leaves: a `meta` op that sets or unsets `memoryMode`
  and writes `hypaV3Data` is judged by the mode after its own set and unset, a malformed one reading as Legacy, not
  by the row before it.
- The upstream exporter projects a chat's records when that chat's algorithm is Structured Memory.

**Test.** `assemble.test.ts`: under each global selection, a chat with a stored mode runs that mode and its neighbor
runs the global one; a HypaV3-mode chat runs with `hypaV3` off globally; a Structured-mode chat with stored summaries
and no records reports the adoption hold. `memoryTasks.test.ts`: both task kinds are admitted by the chat's mode and
skipped with the existing reasons otherwise; a queued task is skipped on a mode change; a mode change between two
windows ends a structured task and a rebuild before the next one; a HypaV3 summary returning after the chat moved to
Structured Memory is neither stored nor counted. `structuredMemoryRoutes.test.ts`: record now and rebuild are admitted
for a Structured-mode chat under another global selection and refused for a HypaV3-mode chat under global Structured
Memory. Resource store tests: a read of two chats of one character overlays the projection on the Structured one
only, and charges that one's event bytes and not the other's, as a chat read and as a collection read; the
`hypaV3Data` write guard and the rebuild lock
follow the chat; one op that sets a mode and `hypaV3Data` is judged by that mode. `upstreamExport.test.ts`: per-chat
projection.

**Manual checks.** None reachable: no control stores a mode until slice 3.

## Slice 3. The mode in the tab, and its control (_hard_, `memory.md`, `structured-memory/read.md`, `structured-memory/projection.md`, `settings-i18n.md`, `plugin-sandbox.md`)

**Change.**

- Every tab reader of the selected algorithm under Current State takes the chat's: which panel `App.svelte` mounts for
  the selected chat, the menu row and memory button, the receipt, the context meter's estimate, health states (per
  chat key, not all-or-nothing: the state map, and the gates of the health read and of the refresh on panel close in
  `chatStatus.svelte.ts`), `removeMessages`, `projectionsField`, `installChatProjection`, and the failure notice of
  `chatMemoryInherit.svelte.ts`.
- Plugin reads: `refreshChatProjections`, `detachedPluginChat`, `readSharedDetachedChats`, the batch's comparison
  after its flush, and `detachedChatCache.ts` hold "this chat is under Structured Memory" per ref instead of one
  boolean per batch. A mode change of one chat invalidates that chat's entries only: it moves the chat's revision,
  which the cache already checks.
- `journalRecovery.ts` decides per replayed write, not per chat. It walks the chat's replayed ops in order and judges
  each real `hypaV3Data` write by the mode in force at that op: the held chat's or its summary's, then every earlier
  replayed op, then that op's own `memoryMode` set or unset, with the held or replayed global setting where no mode
  is stored. A value the projection guard may refuse is kept as a recovery draft, and a later mode change in the same
  replay does not cancel that. Where the stored ownership is unknown it protects, as the global rule does today. The
  replayed ops and their retry identity are unchanged.
- The tab's own guard on a held `hypaV3Data` (`keepsHeldHypaV3Data` in `setChatMeta` and the plugin diff) uses the
  same rule as the server's: the mode the write leaves.
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
one read, and a mode change dropping one entry. `journalRecovery.test.ts`: a replayed summary written under Structured
Memory, an append, then a replayed change to HypaV3 keeps the summary as a draft; the same summary after the mode
change is replayed without one.
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
  a caller that awaits resolves the preset from the chat it captured, not from the selection after the await.
  `CoverageTab.svelte`, `memoryRecordPress.ts`, `StructuredMemoryPanel.svelte`, and the health states (per chat key)
  call `chatHypaV3Preset`, as `chatMemoryEnabled` already does for `alwaysToggleOn`. The cost preview's screening
  follows the chat's preset through `readWriterSettings`.
- The panel gains the preset select: Default (with the name of the preset Settings selects now), then each preset by
  name. Default unsets the field. A stored id that names no preset shows as deleted, and the chat runs on the default
  (D12).
- `MemorySettings.svelte` follows the open chat as the Model and Prompt pages do (D14). While the open chat stores a
  preset that exists, the page shows and edits that preset and marks it as this chat's. Otherwise, and at home, it
  shows the default. The page reads the open chat itself (`currentChatRef` and the chat's list entry); the binding
  views of `settingsViews.svelte.ts` do not carry memory fields. The preset in view is the stored record, not a copy,
  because the page's effects and `setStructured` edit it in place.
- Selecting a preset on that page goes through one action for the select, Create, and Import, which all assign
  `selectedId` today: with an open chat that names an existing preset it writes the chat's `memoryPresetId`, otherwise
  `selectedId`. Import captures that target before its file chooser's await. Delete removes the record and repairs
  `selectedId` when it named the deleted one; a chat that named it runs on the default.
- Chat-file import drops a `memoryPresetId` that names no preset here, where `addChats` sanitizes bindings. Recovery
  and backup restore keep ids as stored.

**Test.** `shared/tests/chatMemory.test.ts`: stored, absent, and gone. A `jobScope` test: the scope of a chat with a
stored preset reads that preset through `selectedHypaV3Preset(scope.db)`, and the stored `selectedId` is untouched.
`assemble.test.ts`: two chats of one character on presets with different budgets get different memory budgets, under
HypaV3 and under Structured Memory. `memoryTasks.test.ts`: editing the chat's preset stales its queued task; editing
the default preset does not. A rebuild test: screening follows the chat's preset. `StructuredMemoryPanel.test.ts` and
`chatStatus.test.ts`: cadence and health follow the chat's preset. `MemorySettings` tests: with an open chat that
stores a preset the page edits that preset and the select, Create, and Import write the chat and leave `selectedId`;
without one they write `selectedId`.
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
- The tab's HypaV3 summarize (`src/ts/process/memory/hypav3.ts`) passes the chat's `profileId` the same way, and the
  model name it reports beside that request follows it. The Plugin-model warning of `MemorySettings.svelte` follows
  the open chat's connection.
- Covered: every request of the memory host, in a job or a task, including record now, the gap run, rebuild, and the
  writer's test run. Not covered, and said so under the control: a fixed-model `supaModelType`, a local summarization
  model, embeddings (D16). Lua's own `memory`-mode request (`server/src/lua/bindings.ts`) is not a memory host request
  and keeps the slot. The rebuild cost preview resolves no model and stays a model-independent estimate.
- A named connection that is gone refuses the memory request, as every named profile does (D15). What that does to a
  send is what a refused memory request does today: a send that needs a new HypaV3 summary fails, a background task
  fails, and a Structured Memory gap run lets the send continue with the gap. The panel shows the connection as
  deleted, in the way `ChatBindingPanel` shows a deleted binding.
- The panel gains the connection select: the preset's memory slot (default, unsets the field) and each connection by
  name. Chat-file import drops a `memoryProfileId` that names no connection here.

**Test.** `server/src/tests` for the resolver: named, absent, gone. `memoryJobs.test.ts` and `memoryTasks.test.ts`: a
chat's memory request runs on the named connection while the main request stays on the preset's; a gone connection
refuses the memory request with the named-profile message, with the three outcomes above; a connection change stales a
queued task; a Plugin-format
connection gives `pluginModel`. A writer test: `openRun` records the named model. `ChatMemoryPanel`: select, unset,
deleted state. An import test for the dropped id.

**Manual checks.** A real send with a cheaper connection named for memory, checked in request history; deleting the
named connection and sending; the HypaV3 modal's manual summarize on a chat with a named connection.

## Decisions

D1 to D3 are the owner's request of 2026-11-12; the owner accepted D5 to D8 the same day. The rest are this plan's;
D17, D18, and D21 to D23 are as the audit of 2026-11-12 left them.

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
- D17. A provider call already running when a chat's mode changes is left to return, and its result is not accepted:
  a task asks the chat's algorithm before each further window and before each commit, and ends as skipped on a
  mismatch. A global switch has only the start check today, and a HypaV3 summary that returns after it is dropped by
  the write guard while the task counts it. A mode is changed per chat far more casually than the global selector
  (audit AUD-2).
- D18. The four fields are summary fields, so the Chat settings dialog can edit a chat that is not loaded.
  `memoryTrimAck` joins them, because `setChatMeta` can neither name nor unset a key the summary lacks on such a chat
  (audit AUD-1).
- D19. A malformed stored value reads as absent in the resolver; the server normalizer does not reject it. The server
  keeps unknown chat fields as sent today, and a refusal would fail a chat-file import over a setting.
- D20. The embedding model stays one setting. Stored vectors are tied to the model that made them, so a model per chat
  is its own design.
- D21. When `reconcileCharacterChats` has no retained baseline of a plugin's read, it keeps the four memory fields
  the plugin's chat omits. Such a write would otherwise turn a chat's memory off, or return its mode, preset, and
  connection to the defaults, with no one having asked. `memoryTrimAck` is left out: losing it only asks the trim
  question again. The rule for every other field and for `setChatToIndex` stays; a general change to plugin writes is
  not this plan's (audit AUD-3).
- D22. Recovery judges each replayed `hypaV3Data` write by the mode in force at that write, because the server
  applies and guards each op in turn: a summary dropped under Structured Memory is not restored by a later op that
  moves the chat to HypaV3 (audit AUD-8).
- D23. `readRefsWithinBudget` charges event bytes only for chats under Structured Memory, as today's global gate does
  for all or none. Charging every chat was the simpler rule; it would add rounds for characters with dormant records
  inside a whole read's one deadline (audit AUD-5).

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
