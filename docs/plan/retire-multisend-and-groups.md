# Retire `/multisend` and Group Chats Plan

Status: drafted 2026-11-23 at `549dd2374` from the owner's answers of 2026-11-23 (Q1 to Q7); D1 to D14 are written to
those answers. Not audited.

Sources: `src/ts/process/command.ts` (`runMultisend`, `processMultiCommand`, `processPinnedCommands`,
`processCommand`, the `/?` help), `src/ts/process/index.svelte.ts` (`SendChatArg.localSendReservation`),
`src/ts/process/localSends.ts` (`beginLocalSend`, `LocalSendReservation`),
`src/lib/ChatScreens/DefaultChatScreen.svelte` (the slash-command reservation),
`server/src/prompt/commands.ts` (the `multisend` case, `CommandHost.multisend`, the `lowLevelAccess` refusal),
`server/src/jobs/runSetup.ts` (`JobRunState.sequence`, the `multisend` host), `server/src/jobs/commandRunner.ts` (the
sequence run), `server/src/jobs/generationJobs.ts` (`RunningJob.sequence`, `beginPart`, `releaseRemovedReplies`,
`sequenceAttempted`, the create admission with its `chatTrashed` refusal), `shared/jobs.ts` (`GenerationSequence`,
`MAX_SEQUENCE_PARTS`, `MAX_SEQUENCE_PART_CHARS`, the `sequence` live event), `shared/events.ts`,
`src/ts/process/serverCommands.ts`, `src/ts/alert.ts`, `src/ts/network/generationJobs.ts`,
`src/ts/process/generationProgress.svelte.ts`, `src/lib/Others/GenerationProgressWindow.svelte`,
`util/playwright/checkJobProtocol.mjs`; for groups `shared/database.ts` (`groupChat`), `shared/characters.ts` (the
normalizer), `src/ts/characters.ts` (`createNewGroup`, `addCharacter`), `src/ts/process/group.ts`,
`src/ts/storage/selection.svelte.ts` (`selectCharacter`, `selectCharacterAt`), `src/ts/hotkey.ts`,
`src/lib/SideBars/Sidebar.svelte`, `src/lib/SideBars/pinnedChats.ts`, `src/lib/Others/GridCatalog.svelte`,
`src/lib/Mobile/MobileCharacters.svelte`, `src/lib/UI/mainMenuProjection.ts`, `src/lib/Others/BookmarkList.svelte`,
`src/lib/Setting/Pages/PromptSettings.svelte`, `src/ts/storage/characterOrder.ts` (`repairCharOrder`,
`unorderedCharacters`, `appendMissingCharacters`), `src/ts/plugins/apiV3/v3.svelte.ts` (the index APIs,
`contextTarget`, `getDatabase`, `applyPluginCharacters`), `src/ts/network/jobChannel.ts` (the `chatOutput`
`characterIndex`), `src/lib/Setting/Pages/UpstreamImportReport.svelte`, `docs/backlog/upstream-ledger.md` (Intake
procedure), `server/src/routes/generations.ts`,
`server/src/prompt/memory/memoryTasks.ts`, `server/src/routes/structuredMemory.ts`,
`server/src/routes/messageSearch.ts`, `server/src/data/upstream/importCharacters.ts` and `exportDatabase.ts`, read
at `549dd2374`; the [chat pipeline](../structure/chat-pipeline.md) guide (Slash commands, groups, and search); the
multisend entry of [known issues](../backlog/known-issues.md#chat-pipeline). Identifiers are the anchors; re-verify
each cited location before editing (STRUCTURE.md protocol step 5).

## Goal

The fork stops offering two rarely used features that make other designs harder: the `/multisend` command and group
chats.

- **`/multisend` is removed everywhere** (Q2): the typed composer command and the stored trigger `v2Command` path,
  with the server's command sequence protocol it alone uses. The command name stays recognized and does nothing, so a
  typed line or an old bot card's trigger is never sent as chat text.
- **Group chats are archived** (Q1): existing group records and their chats stay stored, synced, backed up, and carried
  through upstream import and export, but the tab never lists or opens them, plugins never see them, and the server
  starts no work on them.
- **The leftover group code is declared dormant** (Q3): a repository invariant says that no group chat is reachable,
  that new work need not support groups, and that dormant group branches are not extended. Deleting those branches is
  later work, not this plan.

Not goals: deleting, converting, or exporting-out existing group records; changing the persisted `groupChat` shape or
the `type: "group"` discriminator (STRUCTURE.md D5); removing the dormant group branches in prompt assembly, memory,
CBS, Lua, MCP, plugins, and the upstream importer; the PO-file and attachment sender in
`src/ts/process/files/multisend.ts`, which shares the name only.

## Current State

### `/multisend`

- **Typed command.** `processCommand`'s `multisend` case splits on `|||`, takes a leading `clear` as the mode, and
  calls `runMultisend`, which for each part checks the chat binding, clears the chat in clear mode, appends the part as
  a user message, and calls `sendChat` while borrowing the composer's reservation. The reservation is threaded through
  `processMultiCommand`, `processPinnedCommands`, and `processCommand` into `SendChatArg.localSendReservation` and
  `beginLocalSend`'s borrow path; `runMultisend` is the only borrower. The `/?` help lists the command. Unknown commands
  make `processMultiCommand` return `false`, and the screen then sends the line as text.
- **Server command path.** A trigger's `v2Command` effect runs `server/src/prompt/commands.ts`, whose `multisend` case
  calls `host.multisend`. In a command job `runSetup.ts` queues the parts in `JobRunState.sequence` (at most
  `MAX_SEQUENCE_PARTS` parts of at most `MAX_SEQUENCE_PART_CHARS`), inside a send job it does nothing.
  `commandRunner.ts` runs the queued parts after the interaction, each through `RunningJob.sequence.beginPart`, and the
  registry carries `sequence` progress in the job's current state, its terminal, its receipts, and a live `sequence`
  event; a done sequence with an attempted part takes one automatic checkpoint. The tab shows the progress
  (`serverCommands.ts`, `GenerationProgressWindow.svelte`) and the stop reason (`alert.ts`,
  `serverJob.sequenceStopped`, `serverJob.sequenceReasons`). The browser protocol check runs one such sequence.
- **Known issue.** A clear-mode part clears and appends before the server admits its job, so a refusal only the server
  sees (another device's buffered or Half Streaming reply, a binding the tab has not learned yet) leaves the transcript
  cleared. Reproduced 2026-11-23 by an Astra review. The same append-before-admission order holds for the PO translator
  and the DevTool autopilot, which append but never clear.

### Group chats

- **Data.** A group is a `characters` resource with `type: "group"`, member ids in `characters`, and the parallel
  `characterTalks` and `characterActive` arrays (`shared/database.ts`). Boot, resource sync, backups, and the upstream
  importer and exporter handle it through the generic character path; the shared normalizer keeps it.
- **Creation.** The add-character dialog has not offered "Create Group Chat" since 2026-10-08 (`c4a8fb609`);
  `createNewGroup` and `addCharacter`'s `createGroup` answer remain but are unreachable from the UI. The upstream `.bin`
  import still creates groups.
- **Reachability.** Existing groups still appear in the sidebar rail (`settings.characterOrder`), the catalog grid,
  list, and trash, the mobile list, home recents, the pinned rail, bookmarks, message search, and the previous/next
  character hotkeys; `selectCharacter` accepts them. The order repair (`characterOrder.ts`) appends every live
  character, groups included, and drops only trashed and vanished ids. Opened, a group shows its settings in `CharConfig.svelte`, its Auto
  mode, and sends `group` jobs (`serverGeneration.ts` picks the kind from the owner's type).
- **Server.** `/api/generations` accepts every kind, `group` included, for any owner; the runner then selects
  speakers and assembles per member. Memory tasks, Structured Memory jobs, and message search also take group-owned
  chats. MCP risuaccess tools already refuse group ids.
- **Plugins.** The plugin v3 index APIs address `characterList()` by position, groups included, and `getDatabase`
  returns every character. `setDatabase`'s `characters` (`applyPluginCharacters`) removes each existing character
  the plugin's list omits and creates each new entry through `prepareNewCharacter`, so a plugin can create a group.
- **Upstream intake.** The [upstream ledger](../backlog/upstream-ledger.md) records each upstream commit as
  `integrated`, `equivalent`, `excluded`, or `deferred`; its Intake procedure has no rule for retired features.
- **Code size.** About 138 direct `type === / !== "group"` checks in production source (src 74, server 45, shared 19,
  in 58 files), plus the runner's speaker selection, the `groupTemplate` and `groupOtherBotRole` prompt settings, and
  roughly fifty test files that exercise groups.

## Decisions

### `/multisend`

- **D1. The command name is kept as a no-op.** The tab's `multisend` case and the server's `multisend` case both
  consume the line and return `""` without effect. The tab also shows a notice once per line that `/multisend` was
  removed (Q4); the server case logs nothing and leaves no notice. `multisend` leaves the `lowLevelAccess` refusal
  list, which keeps `speak`.
- **D2. The typed path is removed.** `runMultisend`, its `/?` help line, the `reservation` parameter of
  `processMultiCommand`, `processPinnedCommands`, and `processCommand`, `SendChatArg.localSendReservation`, and
  `beginLocalSend`'s borrow branch go. `LocalSendReservation` stays as the release handle `beginLocalSend` returns. The
  screen keeps its own reservation around the whole slash line and its conditional composer clear; it just no longer
  passes the reservation in.
- **D3. The server sequence protocol is removed.** `CommandHost.multisend`, `JobRunState.sequence` and its queueing,
  the sequence run in `commandRunner.ts`, `RunningJob.sequence` (`beginPart`, `progress`, `releaseRemovedReplies`),
  `sequenceAttempted` and the command clause of the automatic checkpoint rule, the `sequence` fields of the current
  state, terminal, receipts, and `shared/events.ts`, the live `sequence` event, `GenerationSequence`, and the two
  `MAX_SEQUENCE_*` limits go. A command job ends when its handlers end, as one without queued parts does today.
- **D4. The tab drops its sequence display.** The progress text in `serverCommands.ts`, `generationProgress.svelte.ts`,
  and `GenerationProgressWindow.svelte`, the stop alert in `alert.ts`, and the `sequence` validation in
  `src/ts/network/generationJobs.ts` go, with the `serverJob.sequence`, `sequenceStopped`, and `sequenceReasons`
  strings in every locale. The tab ignores a `sequence` field or event from a server of an earlier build (open tabs
  across an upgrade) rather than refusing the frame.
- **D5. The known issue narrows.** With no clear-mode part left, the known-issues entry covers only the PO translator
  and the DevTool autopilot, whose append can remain after a refusal only the server sees; no transcript is cleared.

### Group chats

- **D6. The server starts no work on a group-owned chat.** The create admission in `generationJobs.ts` refuses a job
  of any kind whose chat owner is a group with `409 { error: "groupArchived" }`, next to the `chatTrashed` refusal,
  and `parseCreateBody` refuses `kind: "group"` with `400`. Memory task admission (the enqueue path that already skips
  trashed chats and `start`) refuses the same chats with reason `groupArchived`; the Structured Memory routes that
  start a record, chapter, rebuild, or test run refuse them with `409 groupArchived`. Message search leaves
  group-owned chats out of every scope, as it does trashed chats. The owner's type is read from the record the admission
  already loads; re-verify which read that is before editing.
- **D7. The data stays as it is** (Q1). The `groupChat` type, the shared normalizer, the `characters` resource path,
  backups, and the upstream importer and exporter are unchanged, so an imported or restored group survives and an
  upstream export still carries it. Automatic checkpoints of a group chat are not refused: no work changes it.
- **D8. The tab never selects a group.** `selectCharacter` treats a group id as missing (home), so routes, a stored
  selection, and plugins land home; `selectCharacterAt` and the previous/next character hotkeys skip groups.
- **D9. The tab lists no group.** A shared predicate in `src/ts/characters.ts` (for example `isArchivedGroup`) filters
  the sidebar rail, the catalog grid, list, and trash, the mobile list, home recents, the pinned rail
  (`collectPinnedChats`), bookmarks, and the message search scope picker.
- **D9a. Group ids leave the character order** (Q5). The order repair treats a group as it treats a trashed
  character: `repairCharOrder` never appends one and removes its id from the order and from folders (at the boot repair,
  and once a repair has observed it), `unorderedCharacters` and `appendMissingCharacters` do not count one as live. A
  folder emptied this way goes on the next call, as today. The first boot after the change writes the order record
  once; an upstream import or a plugin's `characterOrder` that lists a group is cleaned by the same repair.
- **D10. Group-only settings are hidden.** `groupOtherBotRole` and `groupTemplate` leave `PromptSettings.svelte`;
  their stored values stay. `createNewGroup`, `addCharacter`'s `createGroup` answer, and its `createGroup` string go,
  since nothing reaches them.
- **D11. Plugins see no group** (Q6). One plugin view, `characterList()` without groups, backs every plugin character
  index and list: `getCharacterFromIndex` and its setter, `getChatFromIndex`, `setChatToIndex`,
  `getCurrentCharacterIndex`, the hook context's `characterIndex` (`contextTarget`, `contextMember`), the `chatOutput`
  callback's `characterIndex` in `jobChannel.ts`, and `getDatabase`'s `characters`. A plugin call that names a group by
  `chaId` treats it as missing. `characterList()` itself is unchanged: sync, the order repair, and other structural
  readers keep every record.
- **D11a. Plugin writes cannot touch a group.** `applyPluginCharacters` compares the plugin's list with the plugin view,
  so a group the list omits is never removed; an entry with `type: "group"` is refused like any other refused new entry
  (the whole list unapplied, with a warning). A plugin `sendChat` that still reaches a group chat gets the server's
  refusal (D6).
- **D11b. The upstream import report marks groups** (Q7). The report's group count reads "Group chats (kept, hidden)",
  in every locale that has the label, so a reader of the report knows the groups arrived but will not appear.

### Dormant code

- **D12. A repository invariant states the assumption** (Q3). STRUCTURE.md's Data and persistence invariants gain one
  item: group chats are archived; their records are kept and normalized, but the tab neither lists nor opens them and
  the server refuses work on them (`groupArchived`); the group branches left in prompt assembly, memory, CBS, Lua,
  MCP, and plugins are dormant; new work need not handle groups, does not extend those branches, and may delete one it
  touches when the deletion keeps D7. The `groupChat` type in `shared/database.ts` carries a one-line comment
  pointing to that invariant. No comment is added at each dormant branch.
- **D13. Tests follow the boundary.** Tests that create group jobs through the create route become refusal tests or
  are removed; tests that call the runner, memory, CBS, or Lua directly with a group stay as dormant coverage until the
  branches go. New tests need no group cases.
- **D14. Upstream intake skips the retired features** (Q7). The upstream ledger's Intake procedure gains a step: an
  upstream commit that changes only group chats or `/multisend` is `excluded` with the reason "retired in this fork"
  and a link to the STRUCTURE.md invariant; a commit that mixes them with other work ports the other work only; a
  change to how upstream's database stores groups is still read, because the `.bin` import and export keep groups
  (D7).

### Questions the owner answered

- **Q1. Existing group records.** Kept and hidden (owner, 2026-11-23). Alternatives: delete them, or convert them to
  single characters.
- **Q2. `/multisend` scope.** Removed completely, the trigger path included (owner, 2026-11-23). Alternative: remove
  only the typed command.
- **Q3. Where code removal is costly.** State in the documentation that the feature is assumed unreachable (owner,
  2026-11-23); this plan pairs that statement with the server refusals of D6 so it stays true.
- **Q4. A typed `/multisend`.** A notice that the command was removed (owner, 2026-11-23, as proposed). Alternative:
  consume it silently.
- **Q5. Group ids in the sidebar order.** Removed, since the order repair already removes trashed ids (owner,
  2026-11-23). The proposal was to keep them and skip them when drawing.
- **Q6. Plugins.** Groups are left out of the plugin character indexes (owner, 2026-11-23). The proposal was to keep
  them visible as data. This shifts the index of every character after a group for plugins that held an index across
  the upgrade.
- **Q7. Upstream.** Marked, so that later agents working with upstream are not confused (owner, 2026-11-23): the import
  report labels the groups (D11b), and the upstream intake procedure excludes retired features (D14).

## Rules For Every Slice

- Read `STRUCTURE.md`, then the guides the slice names, with `pnpm docs:read`.
- Each slice runs its focused tests, `pnpm --silent check:changed`, and `pnpm --silent format:check`; V4's `rg` covers
  every removed export (`runMultisend`, `GenerationSequence`, `MAX_SEQUENCE_PARTS`, `MAX_SEQUENCE_PART_CHARS`,
  `localSendReservation`, `createNewGroup`) across `src`, `server`, `shared`, `util`, `e2e`, and `docs`. The last code
  slice runs the whole suite (V1) and the browser specs and protocol check the change reaches.
- No change to the persisted `groupChat` shape, to the `type: "group"` discriminator, or to the dormant group branches
  beyond what a slice names.

## Slices

Order: 1, then 2; 3 alongside 1 and 2 (disjoint files); 4 after 3 (it uses 3's predicate); then 5.

### 1. Remove `/multisend` (_medium_)

- `src/ts/process/command.ts`, `src/ts/process/index.svelte.ts`, `src/ts/process/localSends.ts`,
  `src/lib/ChatScreens/DefaultChatScreen.svelte`: D1 and D2 for the tab.
- `server/src/prompt/commands.ts`, `server/src/jobs/runSetup.ts`, `server/src/jobs/commandRunner.ts`,
  `server/src/jobs/generationJobs.ts`, `shared/jobs.ts`, `shared/events.ts`: D1 and D3.
- `src/ts/process/serverCommands.ts`, `src/ts/process/generationProgress.svelte.ts`,
  `src/lib/Others/GenerationProgressWindow.svelte`, `src/ts/alert.ts`, `src/ts/network/generationJobs.ts`, `src/lang/`:
  D4; the lore-budget help in `src/lang/en.ts` stops naming multisend.
- `util/playwright/checkJobProtocol.mjs`: the sequence run is removed.
- Tests: `/multisend` typed in the composer and in a trigger's `v2Command` is consumed, sends nothing, and leaves the
  transcript unchanged, also in clear mode (V6: fails with the old case restored); the tab shows the notice once; a
  command job with a former `/multisend` effect ends after its handlers. Removed: the `runMultisend` cases of
  `command.test.ts`, the sequence cases of `manualTriggers.test.ts`, `serverCommands.test.ts`, and
  `alertQueue.test.ts`, and the `multisend` host stubs in `triggerRuntime.test.ts` and
  `chatMetadataCoalescing.test.ts`; `commandExecutor.test.ts`'s `/multisend` case becomes the no-op case.
  `server/src/tests/commandSequences.test.ts` is removed after each case that checks a send-job behavior through a
  sequence part (owner absence, a plugin provider's partial text, the per-part deadline, a start trigger that stops
  sending) is matched to a send-job test that already covers it, or moved to one. Kept: `src/ts/process/files/tests/multisend.test.ts`
  (the PO and attachment sender) and the screen's slash reservation test in `DefaultChatScreen.drafts.test.ts`.

### 2. Refuse group work on the server (_small_)

Depends on 1 (both edit `generationJobs.ts`).

- `server/src/routes/generations.ts`, `server/src/jobs/generationJobs.ts`: D6's create refusals.
- `server/src/prompt/memory/memoryTasks.ts`, `server/src/routes/structuredMemory.ts`: D6's memory refusals.
- `server/src/routes/messageSearch.ts` and its store query: group-owned chats left out.
- Tests: a create of each kind on a group-owned chat is `409 groupArchived` and `kind: "group"` is `400`, with the
  chat unchanged; a memory enqueue, a manual start, and each Structured Memory start on one are refused; a search of
  every scope skips it; a backup restore and an upstream import and export still carry a group (D7). Group cases in
  `generationJobs.test.ts` and other route-level tests that expected a group job to run become refusals (D13).

### 3. Hide groups in the tab (_medium_)

- `src/ts/storage/selection.svelte.ts`, `src/ts/hotkey.ts`: D8.
- `src/ts/storage/characterOrder.ts`: D9a.
- `src/ts/characters.ts` (the predicate, `createNewGroup` and `createGroup` removed), `src/lib/SideBars/Sidebar.svelte`,
  `src/lib/SideBars/pinnedChats.ts`, `src/lib/Others/GridCatalog.svelte`, `src/lib/Mobile/MobileCharacters.svelte`,
  `src/lib/UI/mainMenuProjection.ts`, `src/lib/Others/BookmarkList.svelte`, `src/lib/Others/MessageSearch.svelte`:
  D9.
- `src/lib/Setting/Pages/PromptSettings.svelte`, `src/lang/`: D10; the upstream import report label of D11b.
- Tests: `selectCharacter` of a group id goes home, from a route and from a stored selection; the hotkeys skip a group;
  each listed projection leaves a group out; the boot repair removes a group id from the order and from a folder,
  drops a folder left empty on the next call, and a later repair never appends a group; the prompt settings page shows
  no group fields. Existing tests of the readers (`mainMenuProjection.test.ts`, `pinnedChats.test.ts`) gain the group
  case.

### 4. Plugins see no group (_medium_)

Depends on 3.

- `src/ts/plugins/apiV3/v3.svelte.ts`, `src/ts/network/jobChannel.ts`: D11 and D11a. `src/ts/plugins/apiV3/risuai.d.ts`
  and the plugin guide say that character indexes skip group chats.
- Tests (`src/ts/plugins/apiV3/` host API tests, `src/ts/network/jobChannel.test.ts`): with a group between two
  characters, each index API, the hook context, and `chatOutput` give the second character the index after the first;
  `getDatabase` lists no group; a `setDatabase` round trip of `characters` leaves the group stored; a new entry with
  `type: "group"` leaves the list unapplied; a call naming a group's `chaId` acts as for a missing character.

### 5. The dormant-group invariant, guides, and close-out (_small_)

Depends on 2 and 4.

- `STRUCTURE.md` and `shared/database.ts`: D12. `docs/backlog/upstream-ledger.md`: D14's intake step.
- The [chat pipeline](../structure/chat-pipeline.md), [scripts and triggers](../structure/scripts-triggers.md),
  [server generation](../structure/server-generation.md), [chat store](../structure/chat-store.md),
  [memory](../structure/memory.md), [Structured Memory lifecycle](../structure/structured-memory/lifecycle.md),
  [characters and modules](../structure/characters-modules.md), [plugin sandbox](../structure/plugin-sandbox.md),
  [backups](../structure/backup-sync-hub.md), and [network and jobs](../structure/network-jobs.md) guides drop `/multisend` and the sequence protocol and describe groups as archived; `docs/structure/ownership.json`'s
  "composer slash commands and multisend" part is renamed.
- `docs/backlog/known-issues.md`: the multisend entry narrowed (D5). `docs/backlog/deferred-work.md`: one entry for
  deleting the dormant group branches, with the counts of Current State. `docs/backlog/fork-feature-ledger.md`: the
  "removing group chats" survey note points to this plan.
- The plan is retired by `docs/plan/README.md` and `docs/archived-plan/README.md`; unrun manual checks go to
  `docs/backlog/manual-checks.md`.

## Manual Checks

- Desktop browser on a data set with a group (an upstream `.bin` that has one): the group appears nowhere (rail,
  catalog, trash, home, pinned rail, bookmarks, search), its URL lands home, and the previous/next hotkeys pass over it.
  A backup made then and restored still has the group record (seen through an upstream export). The upstream import
  report labels the group count as kept and hidden.
- A plugin that lists characters by index on that data set gets no group, and a `setDatabase` round trip leaves the
  group stored.
- Type `/multisend clear|||hello` in a chat: the notice appears, the composer clears, and the transcript is unchanged.
- A bot card whose button trigger runs `/multisend` through `v2Command`: pressing the button runs the rest of the
  trigger and sends nothing.
