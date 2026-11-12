# Per-Chat Memory Plan audit, 2026-11-12

- Plan: `docs/plan/per-chat-memory.md`
- Commit audited: `b6d07a04a` (`dev`); the corrected plan is committed with this report
- Mode: `full`
- Model: GPT-6-Astra (`xhigh`), read-only, in place of the usual Sol session because the plan crosses the server
  memory step and tasks, the resource store, the shared chat contract, and the tab; report written by the session
  that drafted the plan (Claude Fable 5.2), before any plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 2     |
| P2         | 3     |
| P3         | 3     |
| unverified | 0     |

All eight are `fixed in plan`. AUD-1 to AUD-7 came from the first turn; the drafting session read each against the
code before editing. Astra then read the corrected plan in the same session: it confirmed AUD-1, AUD-2, AUD-4, and
AUD-7, asked for narrower wording on AUD-3 and AUD-6, pointed out a cost of the AUD-5 correction, and found AUD-8 in
the correction of a coverage note. Those four were applied afterwards and were not read again. For AUD-5 the final
text takes the other of Astra's two original suggestions (charge by the per-chat rule) instead of the one it
re-checked (charge every chat). No P1 is open.

Astra changed no file in the repository (`git status` showed only the plan, edited by the drafting session). It ran
nine test files through the wrapper in the first turn (496 passed) and three in the second (104 passed), and three
scratch probes against the current code: `setChatMeta` and `applyChatResult` with stubbed dependencies, the real
resource store on an in-memory database for the late HypaV3 summary and for stored `memoryMode`, and the store with
`replayedHypaV3Data` for the recovery order. The probes and their output are in
`/home/codex/review-reports/per-chat-memory-audit-2026-11-12/scratch/`, with Astra's two answers in `audit.md` beside
them. None of the probes implements the plan. The full suite, the type and format gates, anything in a browser, and
any benchmark were not run. The two turns took 36 minutes and about 12.9 M tokens.

Found consistent: the algorithm order and its three copies (`assemble.ts:1905`, `settingsViews.svelte.ts:638`,
`MemorySettings.svelte:664`); every writer and reader of the switch the plan lists, with `recordMerge.ts:41` staying
an owner rule; the two callers of `initialChatBinding` (`SideChatList.svelte:308`, `ChatList.svelte:131`) and the
single `onCharacterSelected` registration (`characterStore.svelte.ts:426`); `SUMMARY_PROJECTION_VERSION` rebuilding
summary rows of an existing database without moving a chat's revision (`chatStore.ts:1310`); a set and an unset in
one `meta` op (`chatStore.ts:2398`) and `services.writeChat` reaching the tab (`bindings.ts:512`); D9, an old ack
staying valid only while equal to the count (`runner.ts:1195`); `keep` as the checkpoint policy, forced per field by
`Record<keyof ChatMeta, …>` (`chatCheckpoints.ts:17`); D7, with the exporter holding the owner's chats
(`exportDatabase.ts:935`); every memory scope built by `loadJobScope` on a fresh `db` (`jobScope.ts:246`), and no
consumer of a scope's `hypaV3PresetId` that persists it, compares it with the store, or sends it to a tab, a plugin,
or Lua (D13); the fingerprint covering the selected preset alone (`jobScope.ts:414`); `readWriterSettings` as the one
preset reader with no scope (`resourceStore.ts:2292`); preset ids unique after normalization
(`collections.ts:194`); a named `profileId` carried by both memory hosts to the resolver and to request history
(`runner.ts:814`, `memoryTaskHost.ts:230`, `request.ts:496`, `:550`); the four `"memory"` resolver callers, complete;
D16's exclusions (`supaMemory.ts:209`, `hypav2.ts:21`, `hypav3.ts:2328`); every test file and guide the slices name,
and `read.md` at 38,472 bytes.

Re-check list: `patchMessage` still closes an open fence (`chatStore.ts:2549`), and the writer's receipts use it
behind their locked-message check (`writer.ts:426`, `:457`); feed rows are still measured whole
(`chatStore.ts:1917`); `STORE_TABLES_SQL` still runs only on a fresh database (`resourceStore.ts:3830`), and the
summary upgrade goes through `openChatSchema` instead (`chatStore.ts:1288`). The fourth entry's wording is stale, as
the 2026-11-10 and 2026-11-11 reports found (`generationJobs.ts:1024`, `:1037`).

## P1

### AUD-1 — Slice 1: a chat that is not loaded could not drop its trim answer — fixed in plan

Plan, slice 1: "All four join `ChatSummary`, `summaryFields` (bump `SUMMARY_PROJECTION_VERSION`),
`SUMMARY_FIELD_TYPES`"; "a `meta` op that sets `memoryEnabled` and, when turning on, unsets `memoryTrimAck`."

Code: on a chat that is not loaded, `setChatMeta` throws for a set or unset key that `SUMMARY_FIELD_TYPES` lacks
(`chatStore.svelte.ts:4401`), and queues an unset only for a key the summary holds (`:4451`). `memoryTrimAck` is in
none of the three summary places (`shared/chats.ts:210`, `server/src/data/chatStore.ts:657`). Astra's probe on the
function's body: with the four fields alone it throws; with the ack allowed but not projected the op carries no
unset; with it projected the op is `{ set: { memoryEnabled: true }, unset: ["memoryTrimAck"] }`.

New text: `memoryTrimAck` joins the summary with the four (D18), a stored `false` is projected, and the server's
"memory" answer writes the pair through `services.writeChat`. `chatSummaries.test.ts` joins the slice's tests.

### AUD-8 — Slice 3: the mode at the end of a replay hid a summary the server had dropped — fixed in plan

Plan, slice 3, as first corrected: "It folds the chat's replayed create, replace, and `meta` ops in order to the mode
they leave".

Code: the server guards and applies each op in turn (`chatStore.ts:2391`), recovery replays the retained ops
unchanged (`journalRecovery.ts:525`), and only adjacent compatible ops are coalesced
(`chatStore.svelte.ts:1756`). Astra's probe on the real store: a chat under Structured Memory with events and no
summaries replays a summary, an append, then `memoryMode: "hypaV3"`; the summary is not stored, the batch is
accepted, and a rule that reads the final mode keeps no draft.

New text: recovery judges each replayed `hypaV3Data` write by the mode in force at that op, keeps what the guard may
refuse as a draft whatever a later op does, and protects where ownership is unknown (D22). The tab's own guard on a
held value uses the same rule. A `journalRecovery.test.ts` case covers both orders. Not read again by Astra.

## P2

### AUD-2 — Slice 2, D17: "finishes" let a dropped summary count as saved — fixed in plan

Plan: "A window already running when the mode changes finishes as it does under a global switch today"; "The
fingerprint stops the next start."

Code: `startChecks` runs once per task (`memoryTasks.ts:1326`), and the loops over further windows (`:1135`, `:1261`)
and the commits (`:875`, `:1050`) ask nothing about the algorithm. A `meta` op moves the chat's revision and not its
source generation (`chatStore.ts:2433`, `resourceStore.ts:1191`). The write guard removes `hypaV3Data` from an
incoming set when the projection owns the field (`chatStore.ts:2395`), and `checkpointOf` still increments `done`
and returns `committed` (`memoryTasks.ts:913`, `:929`). Astra's probe and `memoryStore.test.ts:1131`: the callback
runs, the revision is acknowledged, and no summary is stored. The guard also runs before the op's own metadata is
applied (`chatStore.ts:2401`), so one op that changes the mode and writes summaries is judged by the old mode.

New text (D17): a task asks the chat's algorithm, as stored, before each further window and each commit, for both
kinds and for a rebuild's staging and swap, and ends as skipped without aborting the calls in flight
(`endRunning` aborts, `:657`; HypaV3's unsaved ending does not, `hypav3.ts:1394`); `checkpointOf` does not count a
dropped summary; the guard judges an op by the mode it leaves. The sentence that put the algorithm into the
fingerprint is gone: only HypaV3 and Structured Memory have tasks (`shared/jobs.ts:624`), the kind check rejects
first (`memoryTasks.ts:790`), and `warmWork` has its own gate (`:1427`). Astra confirmed all of it and supplied the
two implementation sentences.

### AUD-3 — Rules, slice 1: a plugin write without a baseline unsets the new fields — fixed in plan

Plan, Rules: "Nothing is lost; a reload ends it."

Code: a plugin instance keeps sixteen chat baselines and a write consumes one (`v3.svelte.ts:1684`, `:1710`); with
none, `reconcileCharacterChats` takes the current chat (`chatStore.svelte.ts:4781`), and `applyChatResult` unsets a
key the result omits (`:4738`). Astra's probe on that body: with the retained read nothing is unset; without it all
four fields are. `hostApiChats.test.ts:381` and `:439` establish the consumption and the eviction.

New text (D21): in that fallback alone, `reconcileCharacterChats` fills the four omitted fields into the incoming
chat before `applyChatResult`, which also covers the whole-chat replacement branch (`:4663`). `memoryTrimAck`,
`setChatToIndex` (`v3.svelte.ts:2999`), and other fields are outside the rule. The Rules sentence now says what a tab
loaded before the slice can still do. Astra confirmed the mechanism and gave the narrower wording, which was applied
and not read again.

### AUD-4 — Slice 4, D14: Create and Import still moved the global selection — fixed in plan

Plan: "its preset select writes the chat"; "Creating, importing, and deleting presets are unchanged."

Code: Create and Import both push the new preset and assign `settings.hypaV3Presets.selectedId`
(`MemorySettings.svelte:351`, `:461`). With the page showing the chat's preset, they would change the default of
every other chat and leave the editor where it was. Delete's repair of `selectedId` (`:404`) is still needed.

New text: one action serves the select, Create, and Import; with an open chat that names a preset it writes the
chat, otherwise `selectedId`; Import captures its target before the file chooser's await (`:451`). Astra confirmed.

## P3

### AUD-5 — Slice 2: the byte budget of a projecting read was not in the inventory — fixed in plan

Plan, Current State and slice 2: the store's readers of the global algorithm, without `readRefsWithinBudget`.

Code: it computes the global gate itself and charges a chat's and a collection's event bytes before any metadata is
parsed (`resourceStore.ts:2571`, `:2597`, `:2606`).

New text (D23): the two aggregates take each chat row's stored mode, so only chats under Structured Memory are
charged. The first correction charged every chat; Astra found that this cannot refuse a read (the first group is
always served, `:2617`) but adds SQL work and rounds inside the one deadline a whole read has
(`resourceClient.ts:310`, `chatStore.svelte.ts:7717`), which would reach characters with dormant records. The final
text was not read again.

### AUD-6 — Order: storage was not gated, and shared files were missing — fixed in plan

Plan, Order: "Slice 2 gives the server the per-chat mode while nothing can store one"; "All five edit … the chat
memory panel, the language files".

Code: the server keeps unknown chat metadata (`chats.ts:38`), and plugin creation, chat-file import, recovery, and
the upstream import carry what they are given (`chatStore.svelte.ts:4789`, `characters.ts:539`,
`importCharacters.ts:430`). Slice 2 edits no panel or string.

New text: the Order section lists the files more than one slice edits, `server/src/data/chatStore.ts` included, and
says what a stored mode does between slices 2 and 3. The "each prefix stands alone" sentence was reworded after
Astra's second reading.

### AUD-7 — Slice 5: the cost preview resolves no model — fixed in plan

Plan, slice 5: "Covered … rebuild and its cost preview".

Code: `memoryWorkCost` reads the chat, the screening setting, and message bytes, and makes no request
(`rebuild.ts:441`, `:446`, `:459`).

New text: the preview stays a model-independent estimate; slice 4 makes its screening follow the chat's preset.
Astra confirmed.

## Coverage notes folded into the plan

Not findings; each changed a sentence, and Astra confirmed the wording except where AUD-8 replaced it.

- The upstream exporter resolves each chat before `upstreamChat` strips the fields and from the settings as stored:
  `hypaV3PresetId` becomes upstream's position first (`exportDatabase.ts:366`, `:1094`).
- `chatCheckpoints.test.ts:587` compares every metadata key, so its kept fixture changes in slice 1.
- Health needs its read gate and its panel-close gate changed, not only the state map
  (`chatStatus.svelte.ts:449`, `:473`); plugin reads compare one boolean per batch after the flush
  (`v3.svelte.ts:1588`).
- The tab's preset helper resolves from the chat a caller captured before its awaits
  (`modal-summary-item.svelte:177`, `hypav3.ts:1523`).
- `MemorySettings.svelte` reads the open chat itself, because the binding views carry binding ids only
  (`chatStore.svelte.ts:8198`), and edits the stored preset record in place (`:96`, `:113`, `:264`).
- A refused memory request fails a send that needs a new HypaV3 summary (`assemble.ts:969`), fails a task
  (`memoryTasks.ts:1023`, `writer.ts:780`), and lets a Structured Memory gap run continue (`recordJob.ts:359`).
- The Plugin-model warning and the model name the tab reports follow the chat's connection
  (`MemorySettings.svelte:134`, `hypav3.ts:1554`).

## Noted, not recommended

- An owner-count migration: the exact comparison already keeps old answers valid (`runner.ts:1195`).
- Invalidating tasks on the preset collection's revision: the fingerprint isolates the selected preset on purpose.
- Routing the health and coverage reads through a job scope: they report stored facts.
- Building the display scope through `loadJobScope`: it runs no memory (`displayKinds.ts:34`).
- An upstream export cannot carry different switches for the chats of one character; D7 accepts that.
