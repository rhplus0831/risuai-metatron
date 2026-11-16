# Data-loss fixes in four forks: do the same failures exist in metatron? (2026-11-17)

Users of RisuAI and its forks still report whole-database wipes and chats that lose between one hour and three days of
history. This study read every data-loss fix that PocketRisu, RisuBard, HaejeokRisuai and RisuNest made in their own
commits, wrote each one down as a failure scenario that does not depend on the fork's code, and checked metatron
`003f367fc` for an equivalent sequence. It changed no code. It is a static review: nothing below was reproduced by a
test.

## Result in short

- 233 scenarios came out of 7,487 fork-own commits. For 152 of them metatron has a mechanism that stops the sequence,
  13 have no equivalent path, 26 match a limitation that is already written down, and 5 could not be settled by
  reading.
- The mechanisms behind the forks' large losses were not found here. That covers a stale full copy overwriting newer
  data, a failed write dropped from the pending work, a partial chat saved as a complete one, a restore that old
  writers can overwrite, a store re-created over existing data, and cleanup deleting referenced assets. The save loop
  cut (32 scenarios) and the chat loading cut (25 scenarios) returned no new finding.
- 26 findings remain. 17 are confirmed, 4 are documented design or already recorded, and 5 low-priority ones were not
  challenged. None of them loses a whole database or hours of chat. The two with the widest effect are inherited from
  upstream RisuAI: a Lua `setFullChat` call rebuilds every message from role and text only (F1), and updating a plugin
  resets its saved arguments (F2).
- Four guide statements about data safety do not match the source (see Guide mismatches).

A clean row means "this known failure was not found", not "this path is safe". The method only finds failures another
fork already hit. Failures specific to metatron's own design need a direct audit of that design, such as the wide
review of 2026-11-14.

## Method

| Stage                | Who                      | What                                                                                                                                                                                                                           |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commit lists         | Session                  | Each fork's non-merge commits minus upstream `kwaroran/main` history: PocketRisu 1,209, HaejeokRisuai 1,507, RisuNest 4,274, RisuBard 497.                                                                                     |
| 1. Extract scenarios | 5 read-only Astra agents | One per fork (RisuNest in two date ranges). Triage by subject and by storage paths, read 737 diffs, one row per failure scenario: trigger, what is lost, mechanism, the fork's fix, and a question to ask of another codebase. |
| 2. Check metatron    | 9 read-only Astra agents | One per cut of metatron (table below). Verdict per row with file:line evidence; a step sequence for every finding.                                                                                                             |
| 3. Refute            | 2 read-only Astra agents | Tried to disprove the 17 findings the reviewers rated P2.                                                                                                                                                                      |
| 4. Session check     | Session                  | Read the code for F1, F2 and F4. F3 was rated by its mechanism only.                                                                                                                                                           |

The 18 PocketRisu fixes of the [earlier cross-check](pocketrisu-fix-crosscheck.md) were skipped. Cost: 16 Astra runs
at `xhigh`, about 79 M tokens, about 45 minutes of wall time. Briefs, per-agent reports and the scenario rows are in
`/home/codex/review-reports/fork-data-loss-crosscheck-2026-11-17/` (the two refuter reports were not saved; their
verdicts are recorded below).

Verdicts: `defended` (a named mechanism stops it), `not-applicable` (no equivalent path), `recorded` (in a guide's
Limitations or the backlog), `uncertain`, `partly` (a sibling path is open), `present`.

| Cut                                             | Rows | defended | not-applicable | recorded | uncertain | partly | present | Findings |
| ----------------------------------------------- | ---- | -------- | -------------- | -------- | --------- | ------ | ------- | -------- |
| A1 Save loop, conflicts, live updates           | 32   | 20       | 1              | 10       | 1         | 0      | 0       | 0        |
| A2 Record editors and mutation tracking         | 25   | 21       | 1              | 0        | 1         | 2      | 0       | 2        |
| B1 Chat loading, identity, structure            | 25   | 23       | 1              | 1        | 0         | 0      | 0       | 0        |
| B2 Sends, generation, rerolls, drafts           | 24   | 13       | 1              | 2        | 0         | 7      | 1       | 4        |
| C1 Restore and import activation                | 25   | 20       | 1              | 1        | 0         | 3      | 0       | 3        |
| C2 Backup, export and conversion fidelity       | 32   | 21       | 2              | 2        | 2         | 5      | 0       | 4        |
| D Server store, migration, asset cleanup        | 31   | 16       | 5              | 4        | 0         | 6      | 0       | 4        |
| E Plugin and script APIs                        | 24   | 13       | 1              | 3        | 1         | 2      | 4       | 4        |
| F Memory, translation, other model-written data | 15   | 5        | 0              | 3        | 0         | 3      | 4       | 5        |
| Total                                           | 233  | 152      | 13             | 26       | 5         | 28     | 9       | 26       |

The 26 `recorded` rows are mostly the limits of a browser tab: a close or crash can beat the journal commit, a save
whose answer never arrives holds later work, and oversized unsaved work can exceed the journal. They are listed under
Limitations in `docs/structure/resource-sync.md`, `docs/structure/draft-recovery.md` and
`docs/structure/persistence.md`.

## Confirmed findings

Priority: P1 is committed data lost on an ordinary sequence, P2 is unsaved work or a narrow sequence, P3 is unlikely
or malformed input. "Rows" names the fork scenarios the finding answers (PR PocketRisu, RB RisuBard, HJ
HaejeokRisuai, RNA and RNB RisuNest). Each "Fix" line is the cheapest change the reviewers saw, not a design.

### F1. Lua `setFullChat` rebuilds every message from role and text (P1)

- Rows: HJ-31, RB-26. Checked by: session. Inherited from upstream.
- Sequence: a card's Lua button calls `getFullChat`, changes some text, and calls `setFullChat`. After the save, every
  message has a new ID and has lost its time, generation and prompt information, stored translation and reroll
  candidates.
- Code: `setFullChatMain` in `server/src/lua/bindings.ts:1535-1556` builds `{ role, data }` objects with fresh IDs
  and writes a whole-chat replace; the working-copy branch does the same without IDs.
- Recoverable: only from a chat checkpoint or snapshot taken before the call.
- Fix: carry message IDs through the getter and setter, overlay role and text on the matched existing message, and
  give a fresh ID only to a new entry.

### F2. Updating or re-importing a plugin resets its arguments and enables it (P1)

- Rows: PR-33. Checked by: session. Inherited from upstream.
- Sequence: configure a plugin's arguments (often API keys or presets), optionally disable it, then press Update or
  import the same plugin again. The arguments return to `0` or `""` and the plugin is enabled.
- Code: `importPlugin` in `src/ts/plugins/plugins.svelte.ts:263-268` and `:363-376` builds default `realArg` values
  and `enabled: true`; `upsertPlugin` in `src/ts/storage/collectionStore.svelte.ts:407-426` carries over only the two
  completion-wait settings.
- Recoverable: no, short of a snapshot.
- Fix: at replacement, keep the enabled state and every argument value whose declaration is still compatible.

### F3. A plugin's cached value overwrites a newer value from another tab or device (P2)

- Rows: RNB-33. Checked by: reviewer only (rated P1 by the reviewer; rated P2 here because it is a property of the
  plugin storage API, not a broken guard).
- Sequence: a plugin keeps its state in memory in tab A. Tab B saves a newer value for the same key, and tab A
  receives it through the live feed. The plugin in A then writes its older in-memory object. The write carries the
  new revision, so no conflict is raised and B's change is gone.
- Code: storage reads and writes carry no observation of what was read (`src/ts/plugins/apiV3/v3.svelte.ts:3666`,
  `src/ts/storage/pluginStorageStore.svelte.ts:246`).
- Fix: an observation per key that a remote update invalidates, or a change notification plugins can subscribe to.

### F4. A translation result or edit overwrites a newer translation of the same message (P2)

- Rows: RB-37, RB-38. Checked by: session (rated P1 by the reviewer; rated P2 here because it needs two tabs working
  on the same message's translation).
- Sequence: tab A starts Retranslate. Tab B edits and saves that translation. A's result arrives and replaces it. The
  same happens with two open translation editors.
- Code: `setTranslation` is fenced by the hash of the original text only (`server/src/data/chatStore.ts:2756-2790`),
  and it does not require the current chat revision. The editor's captured `base` is not compared at save
  (`src/ts/translator/storedTranslation.svelte.ts:365`).
- Fix: an expected translation version (including "none") checked in `setTranslation`.

### F5. An open message editor loses its text when its row is re-mounted (P2)

- Rows: HJ-35, RNA-45, RNB-45. Checked by: refuter (confirmed).
- Sequence: type in a message or translation editor without saving. Another tab saves a change to that message, or the
  user opens Settings and returns. The row is destroyed and the typed text is gone.
- Code: the draft is component state (`src/lib/ChatScreens/Chat.svelte:167`); the row's mount key includes the
  message text (`src/lib/ChatScreens/Chats.svelte:682`, `:728`); `src/App.svelte:259` replaces the chat screen with
  settings.
- Fix: keep editor drafts outside the row, keyed by character, chat and message.
- The `chat-store` guide says the opposite (see Guide mismatches).

### F6. A buffered reply is not stored when an output hook fails (P2, narrower)

- Rows: RNA-42. Checked by: refuter (confirmed, narrower).
- Sequence: streaming is off, and an `editoutput` plugin hook throws or a Lua output hook times out. The provider's
  answer was received but is never written to the chat.
- Code: the buffered branch runs `editoutput` at `server/src/prompt/runner.ts:2221` before the first reply write at
  `:2247`; the streaming branch stores the raw text first (`:2174`).
- Recoverable: usually, as the raw response in Request History while capture is on.
- Fix: store the buffered answer under the generation before output processing, as the streaming branch does.

### F7. A reroll of a multi-reply turn keeps the discarded replies' variable changes (P2)

- Rows: RB-42. Checked by: refuter (confirmed).
- Sequence: a group turn with two speakers whose triggers change a chat variable is rerolled. The old messages are
  removed, but `scriptstate` keeps their effects, and the new replies add theirs on top.
- Code: only a single-reply turn is a reroll carrier (`shared/rerollCandidates.ts:304`); `rerollByRemoval` changes
  messages only (`src/lib/ChatScreens/DefaultChatScreen.svelte:1035`).
- Fix: extend the before/after variable checkpoints to multi-reply bundles.

### F8. A slash-command send clears a newer composer draft and can append twice (P2)

- Rows: RB-43, RB-44, RNA-46. Checked by: refuter (confirmed).
- Sequence: submit `/speak Hello` with a network TTS mode and type a new draft while it waits: the draft is cleared
  when the command ends. Submit `/speak Hello | /send Next` and press Send again while it waits: `Next` is appended
  twice.
- Code: `src/lib/ChatScreens/DefaultChatScreen.svelte:719` awaits the command pipeline and then clears the input
  without a reservation or a text check.
- Fix: reserve the chat before the first await and clear only the unchanged submitted text.

### F9. A trigger's final reconciliation writes an earlier setter over a newer value (P2)

- Rows: RNB-40, RNB-41. Checked by: refuter (confirmed).
- Sequence: a V2 trigger sets `x` to `first`, then runs `/setvar key=x second`. When the trigger ends, `x` is `first`
  again. The author's note follows the same path.
- Code: the working copy keeps `first` (`server/src/prompt/triggers.ts:592`), the command writes the live chat
  (`server/src/prompt/commands.ts:299`), and `server/src/jobs/chatResult.ts:230` re-applies the working copy.
- Fix: do not replay setters that were already persisted, and refresh the working variables after a nested command.

### F10. Character and plugin imports report success before the save is confirmed (P2)

- Rows: RB-14. Checked by: refuter (confirmed).
- Sequence: import a character or a plugin, see success, and lose the connection or close the page before the save is
  dispatched. A character is usually replayed from the journal at the next boot; the `plugins` kind is excluded from
  the journal, so a plugin install or update is lost.
- Code: `src/ts/characterCards.ts:1496`, `src/ts/plugins/plugins.svelte.ts:420`. Module import already waits
  (`src/ts/process/modules.ts:548`).
- Fix: use the module importer's scoped flush before announcing success or starting the plugin.

### F11. An empty model answer replaces a stored summary or translation (P2)

- Rows: PR-46. Checked by: refuter (confirmed).
- Sequence: SupaMemory's submodel summarizer returns an empty success while consolidating, and the accumulated
  summary becomes empty. A translation step returns only reasoning tags, and the stored translation becomes empty and
  counts as fresh.
- Code: `server/src/prompt/memory/supaMemory.ts:294`, `:380`; `shared/translation/pipeline.ts:333`,
  `server/src/translation/runner.ts:364`. HypaV3 already validates.
- Fix: refuse a blank summary, and a blank translation of non-blank input, before publishing.

### F12. A scene rewrite in Structured Memory sees a truncated field and clips its answer (P2, narrower)

- Rows: RB-29, RB-31. Checked by: refuter (confirmed, narrower: the former text stays in page history).
- Sequence: an unlocked scene section is edited to more than 2,000 characters (the editor allows 4,000). The next
  scene update shows the model the first 2,000 characters and clips each returned field to 800.
- Code: `server/src/prompt/memory/structured/prompts.ts:320`, `analysis.ts:342`, `pages.ts:660` in the same folder.
- Fix: show whole fields when replacement is allowed, and refuse an oversized answer instead of clipping it.

### F13. A candidate whose alias is an existing page's title creates a duplicate page (P3)

- Rows: RB-36. Checked by: refuter (confirmed, narrower: no text is lost, and the two pages can be merged).
- Code: `find` in `server/src/prompt/memory/structured/pages.ts:358` matches the candidate title only.
- Fix: refuse or report a candidate whose alias collides with an existing title.

### F14. The RisuAI-compatible export leaves out Structured Memory pages and threads without saying so (P2)

- Rows: RNB-15. Checked by: refuter (confirmed).
- Sequence: create a manual note in Structured Memory, export a compatible backup and accept its report. The note is
  not in the file, and the report does not mention pages or threads.
- Code: the collector keeps only `events` (`server/src/data/resourceStore.ts:745`,
  `server/src/data/upstream/exportDatabase.ts:968`). The native backup keeps everything.
- Fix: count the omitted pages and threads in the report and point to the native backup.

### F15. The RisuAI-compatible export leaves out assets that only a plugin's custom data references (P2)

- Rows: RNA-21, RNB-21. Checked by: refuter (confirmed).
- Sequence: a plugin saves an image with `saveAsset` and stores the key only in its custom database value. The
  compatible export keeps the value but not the file, and does not list it as missing.
- Code: `server/src/data/upstream/assetReferences.ts:21` does not walk retained custom values. Asset cleanup and the
  native backup do cover plugin-held references.
- Fix: walk retained custom values for asset keys and feed them into the export's holds, selection and missing list.

### F16. Module export re-encodes images with the global compression setting (P2, narrower)

- Rows: RNA-39. Checked by: refuter (confirmed, narrower: the setting's help text warns about character exports, not
  modules; the stored original is untouched).
- Code: `src/ts/process/modules.ts:188`, `src/ts/media/compressImage/lossyCompression.ts:23`.
- Fix: say so at module export and offer the original bytes.

### F17. "Take snapshot" does not flush this tab's pending saves (P2, narrower)

- Rows: RB-15. Checked by: refuter (confirmed, narrower: file backups do flush; the pending work is not deleted).
- Sequence: an edit is waiting in retry backoff after a short connection failure; Storage → Take snapshot succeeds
  and holds the older server state, with no warning.
- Code: `src/lib/Setting/Pages/Storage/storageController.svelte.ts:204` calls `takeSnapshot` directly.
- Fix: flush and report refused work first, as the file backup does. Composer and recovery drafts live in the browser
  and are in no server backup; the snapshot and backup screens do not say that.

## Checked and not counted as defects

| Finding                                                                                                 | Rows   | Outcome                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opening Prompt → Parameters under a budget-only model writes `thinkingType: "budget"` over `"adaptive"` | RNB-07 | Design: `docs/structure/settings-i18n.md` (Invariants) specifies the reset at mount. Worth a decision, because the preference is lost for models that support both.                 |
| An unrelated preset change from another tab closes an open prompt popup editor without its text         | RB-28  | Recorded in `docs/structure/ui-theming.md` (GUI primitives), which does not mention that an unrelated preset is enough.                                                             |
| A Structured Memory `upsert` replaces a whole section, so a fact the model does not repeat is gone      | RB-30  | Design: whole-section replacement with page history (60 entries per page) and locks. The fork moved to item-level edits.                                                            |
| An upstream import can replace writes committed after its last stale-write check                        | HJ-04  | Design: the comment at `server/src/routes/backupsUpstream.ts:256` accepts the interval; the safety snapshot is taken after writes close and holds them. The dialog does not say so. |

## Low priority, not challenged

These five P3 findings come from the stage 2 reviewers only. Each needs a damaged file, hand-edited data or a value
the app does not produce.

- C1-F3: a version-2 archive whose new content-named asset fails its hash is still activated; the mismatch is
  recorded, not refused (`server/src/routes/backups.ts:651`).
- C2-F4: an upstream import that repairs an invalid message ID does not remap bookmarks that point to it
  (`server/src/data/upstream/importCharacters.ts:628`).
- D-F2: the compatible export turns a lone UTF-16 surrogate into U+FFFD (`server/src/data/upstream/risuSave.ts:379`).
- D-F3: a checkpoint page whose stored text was damaged is reused by `INSERT OR IGNORE` without comparing content
  (`server/src/data/checkpointStore.ts:212`); a damaged derived Lua image is reused because only existence is checked.
- D-F4: a resource row with unreadable JSON and no asset marker in its text is filtered out before parsing, so the
  asset scan treats it as reference-free (`server/src/data/assetLifecycle.ts:197`, `:563`).

## Uncertain

| Rows          | Question                                                                                                               | What would settle it                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| PR-08         | Can a very large character or chat write fail while its JSON text is built, after the chat work was taken into flight? | A boundary test that grows a collection, then deletes or reorders an early item, and checks the work stays retryable. |
| RNB-46        | Does text typed into a toggle text field survive an incoming update of the same chat before blur?                      | A browser check with two tabs.                                                                                        |
| PR-31         | In an upstream backup without `_coldpluginIndex`, which of an inline and a cold plugin value is the current one?       | A real backup with that layout.                                                                                       |
| HJ-10, RNA-28 | Does a StreamSaver download report success when the browser did not finish writing the file?                           | A browser check with a blocked helper, a cancelled destination and a tab close right after the success notice.        |

The two browser checks are for the owner; they are not in `docs/backlog/manual-checks.md` yet.

## Guide mismatches

The four statements were corrected on 2026-11-17, each after a session read of the source it describes.

- `docs/structure/chat-store.md` (Limitations) says an open inline editor keeps its draft when another device changes
  the message text. The source re-mounts the row and drops it (F5).
- `docs/structure/server-resources.md` ("Archive export and import") says the import validates the whole archive. The
  check covers the record list and the database; a new asset with a mismatched content hash is admitted (C1-F3).
- `docs/structure/characters-modules.md` calls V3 the full-fidelity export. Every card and module export passes asset
  bytes through the lossy compression setting, which defaults to on (F16).
- `docs/structure/draft-recovery.md` (Limitations) says server backups omit quarantined work "and say so". The manual
  snapshot button does not (F17).

## Not covered

- Fork commits that are not fixes, and fixes whose subject and touched paths gave no hint of data.
- Upstream `kwaroran/main` fixes; those come in through the upstream ledger.
- Whether a failure one fork fixed is still present in another fork.
- Anything at runtime: no test, build, server or browser was run.
- The five low-priority findings, the four design outcomes and the uncertain rows were not filed anywhere else; this
  report is their only record.

## Filed

On 2026-11-17 the 17 confirmed findings were filed in [found issues](../../backlog/found-issues.md) as its
twenty-sixth batch, each marked `cross-check F<n>`. An entry leaves that file when it is fixed or placed, so a missing
entry means the finding was dealt with.

The problems noticed in the forks themselves are in [fork-data-loss-anomalies.md](fork-data-loss-anomalies.md).
