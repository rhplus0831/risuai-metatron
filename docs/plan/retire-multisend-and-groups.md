# Retire `/multisend` and Group Chats Plan

Status: drafted 2026-11-23 at `549dd2374` from the owner's answers of 2026-11-23 (Q1 to Q8); D1 to D14 are written to
those answers. Audited the same day by Astra in two turns
([report](../reports/audits/plan-runner/retire-multisend-and-groups-2026-11-23.md)); the corrections after the second
turn were not read again. The owner confirmed the Limitations the audit's findings A3, B2, B3, B4, B6, and B7 led to
(Q8).

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
  admits no generation job or manual memory task for them.
- **The leftover group code is declared dormant** (Q3): a repository invariant says that no tab or plugin path reaches a
  group chat, that new work need not support groups, and that dormant group branches are not extended. Deleting those
  branches is later work, not this plan.

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
  `beginLocalSend`'s borrow path; `runMultisend` is the only borrower. The `/?` help lists the command. The line is
  split on every unquoted `|` before any case runs (`processPinnedCommands`); only `send`, `sendas`, and `comment`
  (`matchTextCommand`) take the rest of the line as text, so an unquoted `/multisend a|||b` reaches the case as `a`
  followed by empty segments. A segment no case knows makes `processMultiCommand` return `false`, and the screen then
  sends the line as text. The server's `processMultiCommand` in `server/src/prompt/commands.ts` splits the same way,
  without the text-command exception.
- **Server command path.** A trigger's `v2Command` effect runs `server/src/prompt/commands.ts`, whose `multisend` case
  calls `host.multisend`. In a command job `runSetup.ts` queues the parts in `JobRunState.sequence` (at most
  `MAX_SEQUENCE_PARTS` parts of at most `MAX_SEQUENCE_PART_CHARS`), inside a send job it does nothing.
  `commandRunner.ts` runs the queued parts after the interaction, each through `RunningJob.sequence.beginPart`, and the
  registry carries `sequence` progress in the job's current state, its terminal, its receipts, and a live `sequence`
  event; the receipt store (`server/src/data/generationReceipts.ts`) also rebuilds a shutdown terminal with
  `sequence` from a stored progress blob when it reopens. A done command with an attempted part invokes the normal
  automatic-checkpoint policy once; a command without parts never does. The tab shows the progress
  (`serverCommands.ts`, `generationProgress.svelte.ts`, `GenerationProgressWindow.svelte`, the
  `serverJob.stopOther.sequence` text and its `{sequence}` placeholder) and the stop reason (`alert.ts`,
  `serverJob.sequenceStopped`, `serverJob.sequenceReasons`); the live event also counts toward the message statistic.
  The browser protocol check runs one such sequence.
- **Known issue.** A clear-mode part clears and appends before the server admits its job, so a refusal only the server
  sees (another device's buffered or Half Streaming reply, a binding the tab has not learned yet) leaves the transcript
  cleared. The known-issues entry records the 2026-11-22 source read; an Astra review reproduced it on 2026-11-23 with
  probes kept outside the repository. The same append-before-admission order holds for the PO translator and the
  DevTool autopilot, which append but never clear.

### Group chats

- **Data.** A group is a `characters` resource with `type: "group"`, member ids in `characters`, and the parallel
  `characterTalks` and `characterActive` arrays (`shared/database.ts`). Boot, resource sync, backups, and the upstream
  importer and exporter handle it through the generic character path; the shared normalizer keeps it.
- **Creation.** The add-character dialog has not offered "Create Group Chat" since 2026-10-08 (`c4a8fb609`);
  `createNewGroup` and `addCharacter`'s `createGroup` answer remain but are unreachable from the UI. The upstream `.bin`
  import still creates groups.
- **Reachability.** Existing groups still appear in the sidebar rail (`settings.characterOrder`), the catalog grid,
  list, and trash, the mobile list, home recents, the pinned rail, bookmarks, message search, and the previous/next
  character hotkeys; `selectCharacter` accepts them. A route to a group runs `ensureChat` (which creates `Chat 1` for
  an owner without chats) and `selectChat` (which writes the owner's chat preference) before `selectCharacter`;
  `changeChar`, `openPinnedChat`, and the remote host's target checks (`remoteHost.ts`) also act on the chat first.
  The order repair (`characterOrder.ts`) appends every live character, groups included, and drops only trashed and
  vanished ids; the remote repair only appends, and a plugin's `characterOrder` write is assigned without a repair.
  A trashed group expires from the character trash at boot after three days, and a trashed chat of a group from the
  chat trash after `chatTrashDays`, like any other. Opened, a group shows its settings in `CharConfig.svelte`, its Auto
  mode, and sends `group` jobs (`serverGeneration.ts` picks the kind from the owner's type).
- **Server.** `/api/generations` accepts every kind, `group` included, for any owner; the runner then selects
  speakers and assembles per member. The Structured Memory record, test, chapter, and rebuild starts are command
  payloads of that same route. The admission reads no owner record unconditionally: `chatTrashState` returns the
  revision and `trashedAt`, and `readOrphanedOverrideEntries` reads the owner only for a chat with overrides. The manual
  memory task start (`server/src/routes/memoryTasks.ts`) refuses a trashed chat on its own. Message search takes
  group-owned chats. Translation, display transforms, standalone LLM requests, Structured Memory edits, manual
  checkpoints, chat trash, and resource writes are separate routes that act on any chat. MCP risuaccess's by-id tools
  refuse group ids, but `risu-list-characters` lists every owner, groups included.
- **Plugins.** The plugin v3 index APIs address `characterList()` by position, groups included, and `getDatabase`
  (through `buildDatabaseSubset` in `snapshots.svelte.ts`) returns every character. `setDatabase` and
  `setDatabaseLite`'s `characters` (`applyPluginCharacters`) removes each existing character the plugin's list omits
  and creates each new entry through `prepareNewCharacter`, so a plugin can create a group. `applyPluginCharacter`
  replaces a character with a different `chaId` by storage position (`replaceCharacterAt`). Plugin `sendChat` appends
  its message before the server admits the job.
- **Upstream intake.** The [upstream ledger](../backlog/upstream-ledger.md) records each upstream commit as
  `integrated`, `equivalent`, `excluded`, or `deferred`; its Intake procedure has no rule for retired features.
- **Code size.** About 138 direct `type === / !== "group"` checks in production source (src 74, server 45, shared 19,
  in 58 files), plus the runner's speaker selection, the `groupTemplate` and `groupOtherBotRole` prompt settings, and
  roughly fifty test files that exercise groups.

## Decisions

### `/multisend`

- **D1. The command name is kept as a no-op.** Both splitters recognize the exact token `multisend` (with an optional
  leading `/`, followed by whitespace, `|`, or the end of the line) at the start of a segment, before any argument is
  parsed or evaluated as CBS, and consume the rest of the line as one retired segment that returns `""` without
  effect; its legacy `|||` argument never becomes pipeline segments. The pipe grammar of every other command is
  unchanged. In the tab the retired segment shows one notice that `/multisend` was removed (Q4); the line is
  consumed, so the composer clears as for any handled command. On the server it logs nothing, and the trigger
  continues with its next effect. Because a trigger's `v2Command` effect evaluates its whole line as CBS before the
  command executor sees it (`server/src/prompt/triggers.ts`, the `v2Command` case's `operand`), a `value`-type effect
  whose raw text starts with the retired token is skipped there, before any CBS evaluation and without
  `runCommand` (owner, 2026-11-23); a retired segment later on such a line is consumed by the executor after the
  line's CBS ran (see Limitations). `multisend` leaves the `lowLevelAccess` refusal list, which keeps `speak`.
- **D2. The typed path is removed.** `runMultisend`, its `/?` help line, the `reservation` parameter of
  `processMultiCommand`, `processPinnedCommands`, and `processCommand`, `SendChatArg.localSendReservation`, and
  `beginLocalSend`'s borrow branch go. `LocalSendReservation` stays as the release handle `beginLocalSend` returns. The
  screen keeps its own reservation around the whole slash line and its conditional composer clear; it just no longer
  passes the reservation in.
- **D3. The server sequence protocol is removed.** `CommandHost.multisend`, `JobRunState.sequence` and its queueing,
  the sequence run in `commandRunner.ts`, `RunningJob.sequence` (`beginPart`, `progress`, `releaseRemovedReplies`),
  `sequenceAttempted` and the command clause of the automatic checkpoint rule, the `sequence` fields of the current
  state, terminal, receipts, and `shared/events.ts`, the live `sequence` event, `GenerationSequence`, and the two
  `MAX_SEQUENCE_*` limits go. A command job ends when its handlers end, as one without queued parts does today, and
  removing the checkpoint clause changes nothing for it. The receipt store stops writing command progress and no
  longer adds `sequence` to a terminal it rebuilds on reopen; an old stored progress blob or ended status with
  `sequence` is read and the field ignored, and request ids, fingerprints, tombstones, ownership, retained terminals,
  and expiry are kept across the upgrade.
- **D4. The tab drops its sequence display.** The progress text in `serverCommands.ts`, `generationProgress.svelte.ts`,
  and `GenerationProgressWindow.svelte`, the stop alert in `alert.ts`, the per-part message statistic, and the
  `sequence` validation of `/current` (`src/ts/network/generationJobs.ts`) and of the progress feed
  (`generationProgress.svelte.ts`) go, with the
  `serverJob.stopOther.sequence` text, the `{sequence}` placeholder of its confirmation, `sequenceStopped`, and
  `sequenceReasons` in every locale. The ordinary send counter and terminal reporting stay. A `sequence` field or live
  event from a server of an earlier build (open tabs across an upgrade) is ignored: the live-event switch already falls
  through on an unknown type, and terminal decoding tolerates extra fields.
- **D5. The known issue narrows.** With no clear-mode part left, the known-issues entry covers only the PO translator
  and the DevTool autopilot, whose append can remain after a refusal only the server sees; no transcript is cleared.

### Group chats

- **D6. The server admits no generation or manual memory work on a group-owned chat.** The create admission in
  `generationJobs.ts` reads the owner's `type` unconditionally after request replay and the chat's existence and trash
  checks, before a slot or receipt is installed, and refuses a job of any kind whose owner is a group with
  `409 { error: "groupArchived" }`; the lore-override check reuses that owner read. This covers sends, previews (OOC
  included), commands, and the Structured Memory record, test, chapter, and rebuild starts, which are command payloads
  of the same route. `parseCreateBody` refuses `kind: "group"` with `400` for any owner; `group` stays a decodable kind
  for receipts and old-server reads. The manual memory task start route refuses a group-owned chat with
  `409 groupArchived` next to its `chatTrashed` check. Writer hand-offs and vector warming are not guarded: they follow
  a send admitted for a non-group owner, and a record's `type` does not change in ordinary use (see Limitations).
  Message search leaves group-owned chats out of every scope, including a named character or chat. The tab shows
  `groupArchived` through the refusal path it uses for `chatTrashed`, with its own message, and keeps that path's
  handling of an earlier unanswered create; the manual-memory client (`memoryTasks.svelte.ts`) decodes it as a refused
  start, releases that attempt's fence, and shows the same message.
- **D7. The data stays as it is** (Q1). The `groupChat` type, the shared normalizer, the `characters` resource path,
  backups, and the upstream character and chat conversion and export are unchanged, so an imported or restored live
  group survives and an upstream export still carries it with its active chats; only the upstream order conversion
  changes (D9a). The routes D6 does not guard (translation, transforms, standalone LLM requests, Structured Memory
  edits, checkpoints, chat trash, resource writes) are left as they are: after D8 to D11 no tab or plugin path starts
  new work or a user action on a group-owned chat; the exceptions are in Limitations. The character trash and chat
  trash keep their schedules for groups (D9).
- **D8. The tab never opens a group.** The archived-owner check runs before any chat is touched: the router's
  `applyBase` sends a group route home before `ensureChat` and `selectChat`, so no `Chat 1` is created and no chat
  preference is written; `changeChar`, `openPinnedChat`, and the remote host's two target checks refuse a group the
  same way. `selectCharacter` also treats a group id as missing, and the selection reconcile sends the screen home when
  the selected id's record becomes a group. `selectCharacterAt` and the previous/next character hotkeys skip groups.
  Actions elsewhere that open a chat (the refused-data banner's Open chat, a recovery draft's Apply, a
  generation-progress row) go through this check; slice 3 confirms each one does and adds the check where one does
  not. Labels in request history and recovery lists may still name a group. The pinned-chat health scan
  (`chatStatus.svelte.ts`) leaves archived owners out, as the pinned displays do.
- **D9. The tab lists no group.** A shared predicate in `src/ts/characters.ts` (for example `isArchivedGroup`) filters
  the sidebar rail (roots and folder members, keeping raw positions for drag and drop), the catalog grid and list, the
  mobile list, home recents, and both pinned-chat displays (`collectPinnedChats`). The catalog trash keeps listing a
  trashed group with Restore and Delete forever until it expires; a restored group is archived at once. Bookmarks and
  message search work on the selected chat or on server results, so D6 and D8 cover them. `risu-list-characters` in
  the shared RisuAccess implementation leaves groups out before paginating, on both hosts.
- **D9a. Group ids leave the character order** (Q5). The order repair treats a group as it treats a trashed
  character while still recording it as observed: `repairCharOrder` never appends one and removes its id from the
  order and from folders (at the boot repair, and once a repair has observed it), and `unorderedCharacters` and
  `appendMissingCharacters` do not count one as live. The remote repair (`queueRemoteCharOrderRepair`) only stops
  appending groups; it does not remove ids from an
  incoming order, so an upgraded tab never rewrites another tab's order and two tab versions cannot keep undoing each
  other. A group id that stays in the stored order is still never drawn (D9) and goes at the next boot or local
  repair. A plugin's `characterOrder` write drops known group ids before it is assigned, and its `characterOrder`
  read leaves them out. The upstream import passes the order conversion only the final ids of non-group characters,
  from `library.characters` in `importDatabase.ts`, and keeps the complete id set for character and member
  conversion. Each repair assigns the order at most once, only when it changed; a folder emptied this way goes on the
  next call, as today.
- **D10. Group-only settings are hidden.** `groupOtherBotRole` and `groupTemplate` leave `PromptSettings.svelte`;
  their stored values stay. `createNewGroup`, `addCharacter`'s `createGroup` answer, and its `createGroup` string go,
  since nothing reaches them.
- **D11. Plugins see no group** (Q6). One plugin view, `characterList()` without groups, backs every plugin character
  index and list: `getCharacterFromIndex` and `setCharacterToIndex`, `getChatFromIndex`, `setChatToIndex`,
  `getCurrentCharacterIndex`, the hook context's `characterIndex` (`contextTarget`, `contextMember`), the `chatOutput`
  callback's `characterIndex` and speaker in `jobChannel.ts`, and the owners `getDatabase` prepares and
  `buildDatabaseSubset` assembles, in full, summary, and hook reads. A plugin call that names a group by `chaId`
  (`getChar`, `getCharacter`, `setChar`, `setCharacter`, `getChats`, `getCurrentChatIndex`,
  `getCurrentLorebookEntries`, `parseRisuChat`, a context-bound `runLLMModel` or `sendChat`) treats it as missing;
  `getChats` checks before loading and again when returning. `characterList()` itself is unchanged: sync, the order
  repair, and other structural readers keep every record.
- **D11a. Plugin writes cannot touch a group.** A plugin index is resolved to a visible `chaId` at API entry; after
  every wait the owner is revalidated and its current storage index looked up before any positional replacement.
  `applyPluginCharacters` (behind `setDatabase` and `setDatabaseLite`) removes only visible characters the plugin's
  list omits, so an omitted group is never removed; its collision check reserves every stored id, hidden groups
  included. A group payload, or an entry whose id is a hidden group's, is refused before any chat is prepared or
  loaded and before any character changes, in the bulk path and in the single-character setters (the whole list
  unapplied, with a warning); the full id inventory is checked again at commit. Plugin `sendChat` rechecks its
  captured target after consent and loading and refuses a group before appending.
- **D11b. The upstream import report marks groups** (Q7). The report's group count reads "Group chats (kept, hidden)",
  in every locale that has the label, so a reader of the report knows the groups arrived but will not appear.

### Dormant code

- **D12. A repository invariant states the assumption** (Q3). STRUCTURE.md's Data and persistence invariants gain one
  item: group chats are archived; their records are kept and normalized; live groups are absent from ordinary lists
  and cannot be opened, though the character trash keeps managing a trashed one and history labels may name one;
  plugins never see them; the server refuses generation jobs and manual memory starts on them (`groupArchived`); other
  chat routes are not guarded and rely on no tab or plugin path starting work on a group-owned chat. Branches that
  need an admitted or selected group (prompt assembly, memory, CBS, Lua, the group editor) are dormant: new work need
  not handle groups, does not extend those branches, and may delete one it touches when the deletion keeps D7. The
  archive checks themselves (the refusals, filters, the MCP by-id refusals, the order repair) and the preservation
  code stay active. The `groupChat` type in
  `shared/database.ts` carries a one-line comment pointing to that invariant. No comment is added at each dormant
  branch.
- **D13. Tests follow the boundary.** Tests that create group jobs through the create route (including runner tests
  that POST to it) become refusal tests or are removed; tests that call the runner, memory, CBS, or Lua directly with
  a group stay as dormant coverage until the branches go. Tests that open a group in the tab become archive-boundary
  tests. A test that uses a group only as a vehicle for another behavior (the charset retry termination, the per-chat
  scenarios of the Auto-mode browser spec) keeps that behavior with a non-group case. New tests need no group cases.
- **D14. Upstream intake skips the retired features** (Q7). The upstream ledger's Intake procedure gains a step: an
  upstream commit that changes only group chats or `/multisend` is `excluded` with the reason "retired in this fork"
  and a link to the STRUCTURE.md invariant; a commit that mixes them with other work ports the other work only; a
  change to how upstream's database stores groups is still read, because the `.bin` import and export keep groups
  (D7).

### Limitations

- Routes D6 does not guard still act on a group-owned chat when a client names one directly (a script against the
  API, or a tab of an earlier build open across the upgrade): translation, display transforms, standalone LLM
  requests, Structured Memory edits, checkpoints, chat trash, and resource writes. Background memory work queued before
  the upgrade may finish.
- Work that already existed for a group chat before the upgrade can still name it once: a saved job the tab resumes at
  boot, a handoff, a completion push's refresh, and the refused-data banner's Retry of a group chat write held from
  before. The banner's Open is refused for a group, so such a held write is exported or discarded, not opened.
- A record whose `type` changes to `"group"` under the same id (only a raw resource write does this) can still receive
  writer or warmer work from a send admitted before the change, and a request id from before the change is handled as
  today.
- An archived group with no chat gets an empty `Chat 1` from the boot pass and collection reconcile (`ensureChat`), as
  any owner does today; nothing opens it.
- A group chat trashed before the upgrade is not listed anywhere and is purged after `chatTrashDays`; a trashed group
  expires from the character trash as before.
- A tab of an earlier build open across the upgrade can append a group id to the stored order; it is not drawn, and
  the next boot or local repair of an upgraded tab removes it. An order that names a group before its record arrives
  keeps the id until such a repair.
- A stored trigger whose `v2Command` line has `/multisend` after another command (`/echo a|/multisend ...`), or
  whose line comes from a variable, still has its CBS evaluated before the executor consumes the retired segment, as
  every `v2Command` line is today; only a line that starts with the token skips CBS (D1).
- A plugin that stored a numeric character index before the upgrade can read a different character after it (Q6);
  plugins should re-resolve by `chaId`.

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
- **Q8. The audit's rare cases.** Kept as Limitations, not guarded in code (owner, 2026-11-23): the unguarded chat
  routes (A3), the empty `Chat 1` of a chatless group (B2), a group id an older tab puts back in the order (B3), work
  from before the upgrade (B7), and a same-id type change (B4, B6). Each is rare, loses no data, and would need checks
  in several places.

## Rules For Every Slice

- Read `STRUCTURE.md`, then the guides the slice names, with `pnpm docs:read`.
- Each slice runs its focused tests, `pnpm --silent check:changed`, and `pnpm --silent format:check`; V4's `rg` covers
  every removed export (`runMultisend`, `GenerationSequence`, `MAX_SEQUENCE_PARTS`, `MAX_SEQUENCE_PART_CHARS`,
  `localSendReservation`, `createNewGroup`) across `src`, `server`, `shared`, `public`, `util`, `e2e`, and `docs`. The
  last code slice runs the whole suite (V1) and the browser specs and protocol check the change reaches.
- No change to the persisted `groupChat` shape, to the `type: "group"` discriminator, or to the dormant group branches
  beyond what a slice names.

## Slices

Order: 1; then 2 and 3 side by side (2 edits `server/` and `shared/`, 3 edits `src/` and `src/lang/`); 4 after 3 (it
uses 3's predicate); then 5, whose final code gate runs after 2 and 4 are integrated. Slices 1 and 2 both edit
`server/src/jobs/generationJobs.ts`, `shared/jobs.ts`, `server/src/tests/generationJobs.test.ts`, and
`server/src/tests/promptRunner.test.ts`; slices 1 and 3 both edit `src/lang/en.ts`, `src/lang/ko.ts`,
`src/ts/network/generationJobs.ts`, `src/ts/process/serverCommands.ts`, and `GenerationProgressWindow.svelte`; slices 1
and 5 both edit `docs/structure/ownership.json`; slice 3 also edits `e2e/`. The order above keeps them apart.

### 1. Remove `/multisend` (_medium_)

- `src/ts/process/command.ts`, `src/ts/process/index.svelte.ts`, `src/ts/process/localSends.ts`,
  `src/lib/ChatScreens/DefaultChatScreen.svelte`: D1 and D2 for the tab.
- `server/src/prompt/triggers.ts` (the `v2Command` skip of D1), `server/src/prompt/commands.ts`,
  `server/src/jobs/runSetup.ts`, `server/src/jobs/commandRunner.ts`,
  `server/src/jobs/generationJobs.ts`, `server/src/data/generationReceipts.ts`, `shared/jobs.ts`, `shared/events.ts`:
  D1 and D3.
- `src/ts/process/serverCommands.ts`, `src/ts/process/generationProgress.svelte.ts`,
  `src/lib/Others/GenerationProgressWindow.svelte`, `src/ts/alert.ts`, `src/ts/network/generationJobs.ts`, `src/lang/`:
  D4; the lore-budget help in `src/lang/en.ts` stops naming multisend.
- `util/playwright/checkJobProtocol.mjs`: the sequence run is removed.
- Tests: through the composer, `/multisend clear|||hello` (unquoted), the quoted form, `/multisend|||hello`,
  `/multisend|/send hello`, two `/multisend` lines in a row, two occurrences on one line, and `/multisend a|||b`
  followed by an unknown command are each consumed, send and append nothing, leave the transcript unchanged, and show
  one notice per line (V6: fails with the old splitter); a CBS-heavy argument is never evaluated; a literal
  `/send a|b` still sends `a|b`.
  On the server, a trigger's `v2Command` `/multisend ...` is consumed and the trigger's next effect runs; a command job
  with it ends after its handlers. The receipt store reopens an old progress blob without `sequence` in the rebuilt
  terminal and keeps the request id and fingerprint. `command.test.ts`'s help test checks the advertised commands and
  a separate case checks the hidden name. Updated: the sequence fixtures of `server/src/tests/events.test.ts`,
  `generationReceipts.test.ts`, `src/ts/process/generationProgress.test.ts`, and
  `src/lib/Others/GenerationProgressWindow.test.ts`. Removed: the `runMultisend` cases of `command.test.ts`, the
  sequence cases of `manualTriggers.test.ts`, `serverCommands.test.ts`, and `alertQueue.test.ts`, and the `multisend`
  host stubs in `triggerRuntime.test.ts` and `chatMetadataCoalescing.test.ts`; `commandExecutor.test.ts`'s
  `/multisend` case becomes the no-op case.
  `server/src/tests/commandSequences.test.ts` is removed after each case that checks a send-job behavior through a
  sequence part (owner absence, a plugin provider's partial text, the per-part deadline, a start trigger that stops
  sending) is matched to a send-job test that already covers it, or moved to one; its entry in
  `docs/structure/ownership.json` goes, and `pnpm check:tests` runs after the removal (V8). Kept:
  `src/ts/process/files/tests/multisend.test.ts` (the PO and attachment sender) and the screen's slash reservation
  test in `DefaultChatScreen.drafts.test.ts`.

### 2. Refuse group work on the server (_small_)

Depends on 1.

- `server/src/routes/generations.ts`, `server/src/jobs/generationJobs.ts`, `server/src/jobs/loreOverrides.ts` (the
  owner read reused), `shared/jobs.ts` (the refusal reason): D6's create refusals.
- `server/src/routes/memoryTasks.ts`: D6's manual start refusal.
- `server/src/routes/messageSearch.ts` and its store query in `server/src/data/resourceStore.ts`: group-owned chats
  left out of the all-character scope and the named-character and named-chat branches.
- `shared/mcp/risuaccess/characters.ts`: `risu-list-characters` leaves groups out (D9).
- `server/src/data/upstream/importDatabase.ts`: the order conversion gets non-group ids only (D9a).
- Tests: a create of each valid kind on a group-owned chat **without lore overrides** is `409 groupArchived` and
  installs no slot or receipt, and `kind: "group"` is `400` for any owner, with the chat unchanged; the record, test,
  chapter, and rebuild starts on one are refused through `/api/generations`; a manual memory start on one is refused;
  every search scope skips it; `risu-list-characters` omits a group on both hosts; an upstream import keeps the group
  record and leaves its id out of the order; a backup restore and an upstream export still carry a live group (D7).
  Group cases in `generationJobs.test.ts`, `promptRunner.test.ts` (its helper POSTs to the route), and other
  route-level tests that expected a group job to run become refusals (D13); `llmCharsetRetries.test.ts` keeps its
  retry-termination case with a non-group owner.

### 3. Hide groups in the tab (_medium_)

- `src/ts/router/router.svelte.ts`, `src/ts/characters.ts` (`changeChar`), `src/ts/globalApi.svelte.ts`
  (`openPinnedChat`), `src/ts/network/remoteHost.ts`, `src/ts/storage/selection.svelte.ts`,
  `src/ts/storage/records.svelte.ts` (the selection reconcile), `src/ts/hotkey.ts`: D8; the refused-data banner,
  recovery drafts, `GenerationProgressWindow.svelte`, and `RemoteHostScreen.svelte` checked against D8.
- `src/ts/storage/characterOrder.ts`: D9a for the tab's repairs.
- `src/ts/characters.ts` (the predicate, `createNewGroup` and `createGroup` removed), `src/lib/SideBars/Sidebar.svelte`,
  `src/lib/SideBars/pinnedChats.ts`, `src/lib/UI/MainMenu.svelte`, `src/lib/Others/GridCatalog.svelte` (grid and
  list; the trash keeps groups), `src/lib/Mobile/MobileCharacters.svelte`, `src/lib/UI/mainMenuProjection.ts`: D9.
- `src/ts/network/generationJobs.ts`, `src/ts/process/serverCommands.ts`, `src/ts/process/memoryTasks.svelte.ts`:
  `groupArchived` through the existing refusal paths (D6). `src/ts/process/chatStatus.svelte.ts`: the pinned health
  scan (D8).
- `src/lib/Setting/Pages/PromptSettings.svelte`, `src/lang/`: D10; the upstream import report label of D11b; the
  `groupArchived` message.
- Tests: a route to a group without chats lands home and creates no chat from the route; a route to a group with a chat
  writes no chat preference; a stale pinned chat and a remote command naming a group do nothing; a selected record that
  becomes a group under the same id sends the screen home; the hotkeys skip a group; each listed projection leaves a
  group out, and the catalog trash still lists a trashed group; the boot repair removes a group id from the order and
  from a folder, drops a folder left empty on the next call, writes nothing for an unchanged order, and a later local or
  remote repair never appends a group and never removes an id from an incoming order; a `groupArchived` refusal of a
  send and of a manual memory start is shown as a refusal and releases the manual-start fence; the pinned health scan
  skips a pinned group chat; the prompt settings page shows no group fields. Existing tests of the readers
  (`mainMenuProjection.test.ts`, `pinnedChats.test.ts`) gain the group case; `src/ts/charactersCapture.test.ts`'s group
  cases and the browser specs that open a group (`e2e/perChatSends.spec.ts`, `e2e/rerollCandidates.spec.ts`) become
  archive-boundary cases or keep their non-group scenarios (D13).

### 4. Plugins see no group (_medium_)

Depends on 3.

- `src/ts/plugins/apiV3/v3.svelte.ts`, `src/ts/storage/snapshots.svelte.ts`, `src/ts/network/jobChannel.ts`: D11 and
  D11a, and the plugin `characterOrder` write of D9a. `src/ts/plugins/apiV3/risuai.d.ts` and the plugin author guide
  (`plugins.md`) say that character indexes skip group chats and that a stored index should be re-resolved by
  `chaId`.
- Tests (`src/ts/plugins/apiV3/` host API tests, `src/ts/network/jobChannel.test.ts`): with storage `[A, G, B]`, each
  index API, the hook context, and `chatOutput` give B index 1; `setCharacterToIndex(1, …)` with a different `chaId`
  replaces B and leaves G, its chats, and its order entry as they were; `getDatabase` in full, summary, and hook reads
  lists neither G nor its chats, loaded or not; a `setDatabase` round trip of `characters` leaves G stored; a bulk
  payload whose last new entry collides with G's id, and a group payload in bulk or through a single-character setter,
  change nothing and load none of the supplied chats; a plugin `characterOrder` write with G's id is stored without
  it, and a `characterOrder` read before any repair omits it; `getChats` with G's id returns nothing;
  a plugin `sendChat` captured on a group chat appends nothing.

### 5. The dormant-group invariant, guides, and close-out (_small_)

Depends on 2 and 4.

- `STRUCTURE.md` and `shared/database.ts`: D12. `docs/backlog/upstream-ledger.md`: D14's intake step.
- The [chat pipeline](../structure/chat-pipeline.md), [scripts and triggers](../structure/scripts-triggers.md),
  [server generation](../structure/server-generation.md), [chat store](../structure/chat-store.md),
  [memory](../structure/memory.md), [Structured Memory lifecycle](../structure/structured-memory/lifecycle.md),
  [characters and modules](../structure/characters-modules.md), [plugin sandbox](../structure/plugin-sandbox.md),
  [backups](../structure/backup-sync-hub.md), [MCP](../structure/mcp.md), and
  [network and jobs](../structure/network-jobs.md) guides drop `/multisend` and the sequence protocol, describe groups
  as archived, and carry the Limitations into their Known Hazards; `docs/structure/ownership.json`'s "composer slash
  commands and multisend" part is renamed.
- `docs/backlog/known-issues.md`: the multisend entry narrowed (D5). `docs/backlog/deferred-work.md`: one entry for
  deleting the dormant group branches, with the counts of Current State. `docs/backlog/fork-feature-ledger.md`: the
  "removing group chats" survey note points to this plan.
- The plan is retired by `docs/plan/README.md` and `docs/archived-plan/README.md`; unrun manual checks go to
  `docs/backlog/manual-checks.md`.

## Manual Checks

- Desktop browser on a data set with a group (an upstream `.bin` that has one): the group appears nowhere (rail and
  folders, catalog, home, pinned rail, search results), its URL lands home without creating a chat, and the
  previous/next hotkeys pass over it.
  A backup made then and restored still has the group record (seen through an upstream export). The upstream import
  report labels the group count as kept and hidden.
- A plugin that lists characters by index on that data set gets no group, and a `setDatabase` round trip leaves the
  group stored.
- Type `/multisend clear|||hello` in a chat: one notice appears, the composer clears, and the transcript is unchanged.
- A bot card whose button trigger runs `/multisend` through `v2Command`: pressing the button runs the rest of the
  trigger and sends nothing.
