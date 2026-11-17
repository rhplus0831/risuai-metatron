# Known Issues

Confirmed defects and advertised but unwired behavior, moved here on 2026-11-10 from the `Issues` headings of the focused guides' Known Hazards (95 entries from 25 guides) so they can be worked as one queue, the way [found issues](found-issues.md) was cleared. The guides keep their `Unconfirmed:` claims (reproduction comes first for those), their Limitations, and their Gotchas; a claim that is confirmed moves here. Each entry is one bullet under its owning guide, in the guide's own wording at the move, with its links pointed back at the guide; the Contents list counts each guide's entries. The entries were verified when they were written into the guides, but line numbers and identifiers drift: re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. A defect the owner decides to keep moves back to the guide as a Limitation with the decision. A new confirmed defect goes here, not into the guide.

The eleven entries left after the first two rounds were reviewed with the owner on 2026-11-10: the JWT expiry gap, the
plugin RPC lookup, key events from secret fields, and the plugin listener registry were fixed (and the hub proxy's
answers got sandbox headers, a finding of the review itself); the rest moved to their guides' Limitations with the
owner's decision, except the persistence entry below.

Seventeen entries of the fork data-loss cross-check (`cross-check F<n>`) moved here from [found issues](found-issues.md)
on 2026-11-17, after each was reproduced at `5f8b0b191`. Every entry got a probe test that drives the product code
through the entry's trigger: a defect case that states what a user would expect and fails, and a control case on the
sibling path that passes (17 probe files, 51 cases: 26 failed on their own assertion, 25 passed). The session ran each
probe a second time and read two of them. The probes are kept with the review material outside the repository. Each
bullet below says what its probe saw and where the cross-check's reading was corrected. Nothing was fixed that day.
One entry is split in two here (F11, under memory and translation).

The owner went through the ones that need a design choice on 2026-11-17 (F1, F3, F4, F5, F12, F13, F16); each of
those bullets ends with the decision. The other entries have one evident fix and no decision line. F3 (a plugin's
in-memory value overwrites a newer value from another tab or device) left this file for the
[plugin guide's Limitations](../structure/plugin-sandbox.md#limitations): the main third-party plugin in use reads a
key again before it writes its settings, refusing stale writes would fail its log key on every save, and a host-side
merge cannot see inside the JSON strings it stores.

## Contents

- [backup-sync-hub](#backup-sync-hub) (3)
- [characters-modules](#characters-modules) (1)
- [chat-pipeline](#chat-pipeline) (2)
- [chat-store](#chat-store) (1)
- [memory](#memory) (1)
- [persistence](#persistence) (1)
- [structured-memory](#structured-memory) (3)
- [translation](#translation) (2)

## backup-sync-hub

Guide: [Backups, Realm Hub](../structure/backup-sync-hub.md#known-hazards).

- The RisuAI-compatible export leaves out a chat's Structured Memory pages and threads without saying so. The export
  turns a chat's eligible events into HypaV3 summaries and carries nothing else of its memory. Reproduced on
  2026-11-17 (cross-check F14): a chat with events, a page holding a manual note, and an open thread went through the
  real snapshot collector and `stageUpstreamExport`; the decoded database held neither the page nor the thread, the
  report had `memory-projected: 1` and no line for them, and its missing list was empty. The native export held both
  records. A user who keeps only compatible backups has no copy of their pages and threads, and nothing told them.
  Suggested: count the omitted pages and threads in the export report and point to the native backup.
- The RisuAI-compatible export leaves out an asset that only a plugin's custom data references.
  `server/src/data/upstream/assetReferences.ts` does not walk the plugin custom values the export retains. Reproduced
  on 2026-11-17 (cross-check F15): an asset whose key was stored only in a retained plugin custom value; the archive
  held the value and not the file, and the report's missing list was empty, so the exported value points at a file
  the archive does not hold. A character's portrait was exported. The native full backup held the file, because it
  takes every asset on disk and not because it follows the plugin's reference; a partial backup was not checked.
  Suggested: walk the retained custom values for asset keys and feed them into the export's holds, its selection, and
  its missing list.
- "Take snapshot" does not flush this tab's pending saves. `take` in
  `src/lib/Setting/Pages/Storage/storageController.svelte.ts` calls `takeSnapshot` directly. Reproduced on 2026-11-17
  (cross-check F17): with a theme edit whose save had failed once and was waiting in retry backoff, the snapshot
  request reached the server while it still held the old value, and the action ended without an error or a notice
  (it shows no success message either: the list refreshes). The edit stayed queued and was saved by a later flush.
  The file backup flushed the same edit before it asked for its archive and named a refused chat note
  (`backupRefusedNote` in `src/ts/drive/backuplocal.ts`). Read, not run: neither the snapshot nor the backup screen
  says that composer and recovery drafts live in the browser and are in no server backup. A snapshot taken as a
  safety point before a risky action can hold an older state than the screen shows. Suggested: flush and report
  discarded and refused work before `takeSnapshot`, as the file backup does.

## characters-modules

Guide: [Characters, Cards, Modules, Personas](../structure/characters-modules.md#known-hazards).

- A module export re-encodes its images when the image compression setting is on. `exportModuleLegacy`
  (`src/ts/process/modules.ts`) passes every asset through `compressImage`, and `exportModule` reaches the same call
  through `exportCharacterCard`; `db.imageCompression` is on by default and its help text names character exports
  only. Upstream RisuAI does the same. Reproduced on 2026-11-17 (cross-check F16) in two parts. The unit probe, whose
  environment has no 2D canvas, answered at the canvas boundary with marker bytes: with the setting on, both export
  formats carried the marker in place of the stored PNG; with it off, both carried the stored bytes. Then
  `doLossyCompression` (`src/ts/media/compressImage/lossyCompression.ts`), bundled from the source, ran in headless
  Chrome 156: a 4000x2000 PNG of 8.3 MB came out as a 3000x1500 WebP of 52 KB, an 800x600 PNG kept its size and came
  out lossy (36 KB from 526 KB, pixels changed), the PNG's text chunk was gone from both, and a two-frame GIF came
  out as a one-frame WebP. Not run: the JPEG fallback for a canvas that cannot encode WebP. The stored original is
  untouched. Decision: owner, 2026-11-17: fix it by telling the author. The setting's help
  text names modules, and an export with the setting on that holds images it will re-encode says how many (character
  exports take the same call and may show the same line). The behavior and the single setting stay as upstream has
  them; no per-export choice. Not yet fixed.

## chat-pipeline

Guide: [Chat Pipeline: Send → Prompt → Request → Reply](../structure/chat-pipeline.md#known-hazards).

- A reroll of a multi-reply turn keeps the discarded replies' variable changes. Only a single-reply turn is a reroll
  carrier (`shared/rerollCandidates.ts`), and `rerollByRemoval` (`src/lib/ChatScreens/DefaultChatScreen.svelte`)
  removes messages only. Reproduced on 2026-11-17 (cross-check F7) on the mounted chat screen: a group turn of two
  replies whose output triggers each added 1 to a counter left it at `2`; the reroll button removed both replies and
  the counter was still `2` when the next job was created (the new replies' additions were not run; from the code
  they land on top). The control, a switch to a stored candidate of a single-reply turn, restored that candidate's
  value. Counters and flags of a card drift with every reroll of a group turn. Suggested: extend the before and
  after variable checkpoints to multi-reply bundles.
- A slash-command send clears a newer composer draft and can append twice. The send handler in
  `src/lib/ChatScreens/DefaultChatScreen.svelte` awaits the command pipeline and then clears the input, without a
  send reservation and without comparing the text. Reproduced on 2026-11-17 (cross-check F8) on the mounted chat
  screen with only the speech request held: after `/speak Hello`, a draft typed while the speech waited was gone
  when the command ended, and the composer's journal row goes with it at the next flush; after
  `/speak Hello | /send Next`, a second press of Send while it waited stored `Next` twice (two user messages, no
  second model request). The control, an ordinary send, kept the newer typing and refused the second Send. Suggested:
  reserve the chat before the first await and clear the input only when it still holds the submitted text.

## chat-store

Guide: [Chat Store: Chat Module, Write Protocol, Checkpoints](../structure/chat-store.md#known-hazards).

- An open message or translation editor loses its text when its row is mounted again. The editor's draft is
  component state of the row (`draft` in `src/lib/ChatScreens/Chat.svelte`), and the row's mount key holds the stored
  message text (`MountKey` in `src/lib/ChatScreens/Chats.svelte`). Reproduced on 2026-11-17 (cross-check F5) on the
  mounted chat screen, three cases: an outside change of the edited message's text replaced the typed text with the
  new stored text; destroying the chat screen and mounting it again, which is what a visit to Settings does
  (`src/App.svelte` replaces the screen; read, the probe did not mount `App`), brought the editor back with the
  stored text; and the stored-translation editor lost its text the same way. The composer's draft survived the same
  remount through its journal, and an outside change of another message left the editor alone. `isEditing` protects
  an open editor only from the row trim and from containment. A long manual edit is lost with no recovery draft.
  Suggested: keep editor drafts outside the row, keyed by character, chat and message. Leaving the text out of the
  mount key while `isEditing` is true would close only the first case. The owner's decision of 2026-11-08 accepted a
  behavior the code did not have and was made again. Decision: owner, 2026-11-17: fix it. Editor text is kept in memory
  outside the row and returns when the row is mounted again; it need not survive a reload or a closed app. When
  another device changes the edited message, the typed text stays, a notice says the message changed elsewhere, and
  a save overwrites; the translation editor shows the same notice when the stored translation changes under it
  (cross-check F4). Not yet fixed.

## memory

Guide: [Long-Term Memory and Embeddings](../structure/memory.md#known-hazards).

- An empty model answer erases a stored SupaMemory summary. Reproduced on 2026-11-17 (cross-check F11, first half):
  `supaMemory` (`server/src/prompt/memory/supaMemory.ts`) with the submodel summarizer reached the consolidation of
  a four-paragraph summary, the model answered an empty success, and the returned memory kept its cursor with a
  blank summary, which the prompt assembly stores. A non-empty answer replaced the summary as designed. Read, not
  run: SupaMemory keeps no earlier versions, so the former summary is only in a checkpoint or snapshot from before
  the send, or in Request History's copy of the consolidation prompt while capture is on. Suggested: refuse a blank
  summary before it is stored. The translation half of the entry is under [translation](#translation).

## persistence

Guide: [Persistence: Database, Records, Mutation Stores](../structure/persistence.md#known-hazards).

- The remote repair's character read and order write are not atomic: a character another client trashes or deletes
  between them, with no order change, can still be appended at the root. Reproduced on 2026-11-10: once the trash or
  deletion arrives the stale id renders nothing (the sidebar and pins skip absent and trashed characters) and stays
  through selection and idle refresh; the next local add, remove, restore, or reorder (`checkCharOrder`) or the next
  boot repair removes it. Not fixed: hidden order metadata only; the owner has not yet decided to keep it.

## structured-memory

Guide: [Structured Memory Records](../structure/structured-memory/records.md#known-hazards).

- A memory row loaded from a database snapshot, a checkpoint chunk, or a memory restore is held to less than a row the
  server wrote, and two things follow. Both were reproduced on 2026-11-12 through `tx.restoreMemory`, which checks rows
  with `checkMemoryRow` as a snapshot load does.
  - The read rounds (`/package`, `/coverage`, `/story`, `/find`, `/runs`, `/threads`) charge a row's stored bytes and
    answer the re-serialized record. Three event rows of 782 stored bytes each (arrays of `1e20`) serialized to 2,482
    bytes, and with a 1,564-byte budget `/story` answered two of them in 4,619 bytes. The overrun stays near the
    expansion of a number (about three to five times), needs a restored crafted backup, and a round's first record is
    served whatever its size. Measuring each record's serialized size inside the round cost 1.6 to 1.8 ms on a 10 to
    12 ms `/package` round of 500 ordinary events (about 18%), so it was not added.
  - `checkMemoryRow` checks a row's columns, not its record's shape, so an event without `storyTime`, `keyLines`, or
    `participants` loads, where the chat-file restore (`restore.ts`) refuses it. The server's readers take those three
    as empty by the owner's decision of 2026-11-12 (`eventBody` in `card.ts`, `eventVectorTexts` and the timeline's
    full lines in `retrieve.ts`, `remappedEvent` in `pages.ts`), and the tab's readers supply them. Still open: an
    event's other parts (`summary`, `stateChanges`, `knowledge`, `relationshipShifts`, `openThreads`, `sources`) and a
    part of the wrong type are read as written, and the tab's package export (`renderMemoryTimeline`) iterates
    `keyLines` unguarded. The server has never written such an event. A run on 2026-11-14 in a running server (wide
    review, cut X2, and a second run) restored 37 crafted events through `tx.restoreMemory`: all were admitted, all
    259 read rounds answered 200, the panel rendered, and sends in the chat failed during assembly for a missing,
    null, or wrongly typed `summary`, `knowledge`, or `sources` and for `keyLines` or `participants` of the wrong type
    (16 of 36 cases). Fixed for sends the same day (`254ed796f`): prompt selection, coverage, retrieval, vector
    warming, and the recording loop skip an event with such a field (`memoryEventHasReadableFields` in
    `shared/structuredMemory.ts`) and leave the row as stored. The restore validator still admits such a row: refusing
    it there made one row fail the memory export of every chat. The package export has no caller in the product.

  Not fixed: the byte charge, since measuring costs every round; the owner has not said whether it is a Limitation.

- A scene rewrite sees a truncated field and clips its answer
  ([writer guide](../structure/structured-memory/writer.md#known-hazards)). An unlocked scene section can be edited
  to 4,000 characters. Reproduced on 2026-11-17 (cross-check F12) through the real edit, writer, and commit: of a
  4,000-character `state` field the model was shown 1,993 characters, its 1,520-character rewrite was accepted as
  800, and 800 were stored; the run recorded no warning. The page's history held the whole former text (history
  keeps 60 entries), and a locked section was left alone with its warning. Corrected against the filed entry:
  `sceneSlot` (`server/src/prompt/memory/structured/prompts.ts`) caps the whole scene slot at 2,000 characters,
  headings and participants included, not each field; and the 800 cap is applied once, when the answer is admitted
  (`server/src/prompt/memory/structured/analysis.ts`), so `rewriteScene` in `pages.ts` stores an answer that is
  already clipped and cannot tell. Decision: owner, 2026-11-17: fix it, with a soft limit. The editor keeps 4,000 characters and shows a
  badge on a scene field over 800 (the prompts grow, and the writer may rewrite the field up to this length). The
  writer's prompt shows every scene field whole and states each field's limit: 800, or the field's current length
  while that is over 800. An answer past its limit is still clipped, now with a warning on the run. A long scene field
  must not count as over budget in the memory health figures. Not yet fixed.
- A candidate whose alias is an existing page's title creates a duplicate page
  ([writer guide](../structure/structured-memory/writer.md#known-hazards); rated P3). `find` in
  `server/src/prompt/memory/structured/pages.ts` matches the candidate's title against existing titles and aliases;
  the candidate's own aliases take no part. Reproduced on 2026-11-17 (cross-check F13): with a page `Mira`, a
  candidate `Mira Vale` with alias `Mira` became a second character page, with nothing refused and no warning; a
  candidate titled `Mira` updated the existing page. No text is lost and the pages can be merged by hand, but facts
  about one subject are split over two pages. Decision: owner, 2026-11-17: fix it by reporting. The
  page is still created, and the run records a warning that names both pages, so the merge tool can join them. An
  automatic join was not chosen: a wrong one mixes two subjects' facts and is harder to undo than a duplicate. Not
  yet fixed.

## translation

Guide:
[Translation: Providers, the LLM Translator, Presets, Server and Stored Translation, Bilingual Display](../structure/translation.md#known-hazards).

- A translation run's result overwrites a hand edit saved while the run was waiting for its model. `setTranslation`
  (`server/src/data/chatStore.ts`) is fenced by the hash of the original text; it carries a base revision but is
  accepted on an older one, so the runner (`server/src/translation/runner.ts`) writes over whatever translation is
  there. Reproduced on 2026-11-17 (cross-check F4): a Retranslate whose provider answer was held while another client
  saved a hand correction replaced that correction when it arrived; the run was refused when the original text had
  changed. Nothing keeps the overwritten text. It needs two clients on the same message's translation (the reviewer
  rated it P1, the session P2). Decision: owner, 2026-11-17: fix it on the server only: a run remembers the
  translation it started from and discards its result when the stored translation differs at the write. The entry's
  other half, two editors saving over each other, stays as it is and is a
  [Limitation of the translation guide](../structure/translation.md#limitations). Not yet fixed.
- A translation answer that holds only reasoning tags replaces a stored translation with an empty one. Reproduced
  on 2026-11-17 (cross-check F11, second half) through the real pipeline (`shared/translation/pipeline.ts`) and
  server runner (`server/src/translation/runner.ts`): on a message with a hand-edited translation, a forced run
  whose answer was `<think>…</think>` and nothing else stored an empty text as `applied`, without the edited flag,
  and the next request answered `fresh` without calling the provider. An answer with text after the tags was stored
  as designed. It needs a run that is admitted past the freshness check (Retranslate, for one). No translation
  history is written. Suggested: refuse a blank translation of non-blank input before it is published. The
  SupaMemory half of the entry is under [memory](#memory).
