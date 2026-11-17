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
probe a second time and read the two it rated highest. The probes are kept with the review material outside the
repository. Each bullet below says what its probe saw and where the cross-check's reading was corrected. Nothing was
fixed, and the owner has not decided on any of them. One entry is split in two here (F11, under memory and
translation), so the seventeen are eighteen bullets.

## Contents

- [backup-sync-hub](#backup-sync-hub) (3)
- [characters-modules](#characters-modules) (1)
- [chat-pipeline](#chat-pipeline) (2)
- [chat-store](#chat-store) (1)
- [memory](#memory) (1)
- [persistence](#persistence) (1)
- [plugin-sandbox](#plugin-sandbox) (3)
- [scripts-triggers](#scripts-triggers) (1)
- [server-generation](#server-generation) (2)
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
  only. Reproduced on 2026-11-17 (cross-check F16), narrower than filed: the test environment has no 2D canvas, so
  the probe answered at the canvas boundary with marker bytes. With the setting on, both export formats carried the
  marker in place of the stored PNG; with it off, both carried the stored bytes. What the real encoder does to a
  picture was not run and is read from `src/ts/media/compressImage/lossyCompression.ts`: WebP at quality 0.75 (JPEG
  where the canvas cannot encode WebP), the longer side capped at 3000 px, an animated GIF drawn as a still image.
  The stored original is untouched. Suggested: say so at module export and offer the original bytes, or name
  modules in the setting's help text.

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
  behavior the code did not have, so it needs to be made again.

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

## plugin-sandbox

Guide: [Plugins: v3 Sandbox, Host API, Hooks, Storage, Permissions](../structure/plugin-sandbox.md#known-hazards).

- Updating or re-importing a plugin resets its arguments and enables it. `importPlugin`
  (`src/ts/plugins/plugins.svelte.ts`) builds default argument values (`0` or `""`) and `enabled: true` for the
  record it stores, and `upsertPlugin` (`src/ts/storage/collectionStore.svelte.ts`) carries over only
  `completionWait` and `completionQuietSeconds` from the record it replaces. Reproduced on 2026-11-17 (cross-check
  F2, rated P1) through the real importer and store: a plugin with a string argument `saved-api-key`, a number
  argument `42`, and the plugin disabled came back with `""`, `0`, and enabled, both after importing the same source
  again and after `updatePlugin` installed a newer version; the two completion fields survived. Inherited from
  upstream RisuAI. Arguments often hold API keys and long presets, an update is an ordinary action, the `plugins`
  kind is not journaled, and only a snapshot or backup from before brings the values back. Suggested: at
  replacement, keep the enabled state and every argument value whose declaration is still compatible (same name and
  type).
- A plugin's in-memory value overwrites a newer value from another tab or device. Plugin storage reads and writes
  carry no record of what the plugin read (`setOwnedPluginStorageItem` in
  `src/ts/storage/pluginStorageStore.svelte.ts`). Reproduced on 2026-11-17 (cross-check F3) with two clients on one
  store-backed server: A read a key, B saved a newer value, the change feed delivered it to A, and A's write of its
  older object was acknowledged and replaced B's value with no conflict. The revision guard itself works: the same
  write made before the feed delivered B's value was answered 409, discarded, and followed by a reload notice. What
  is missing is a link between the object a plugin holds and the store after a remote update. The reviewer rated it
  P1; the session rated it P2, as a property of the storage API. Suggested: an observation per key that a remote
  update invalidates, or a change notification that plugins can subscribe to.
- A plugin import is treated as done before its save is confirmed, and a character import announces success at the
  same point. Reproduced on 2026-11-17 (cross-check F10), each half narrower than filed. Plugin: `importPlugin`
  hands the plugin to the loader with no save dispatched; after a page hide and a fresh boot against the same server
  and journal the install was gone, because the `plugins` kind is excluded from the journal
  (`src/ts/storage/journalEligibility.ts`). There is no success notice to the user, only a console line. An install
  followed by an acknowledged flush survived. Character: `importCharacterProcess` (`src/ts/characterCards.ts`)
  showed its success alert while the server held no record, but the page-hide journal write was replayed at the next
  boot with the character and its first chat, so that path lost nothing; a close before the journal commits was not
  tested. The module import announces only after its scoped flush is acknowledged (`addImportedModule`,
  `src/ts/process/modules.ts`). Suggested: use the module importer's scoped flush before announcing success or
  starting the plugin.

## scripts-triggers

Guide: [Regex Scripts, Triggers, Lua Scripting](../structure/scripts-triggers.md#known-hazards).

- Lua `setFullChat` rebuilds every message from role and text. `setFullChatMain` (`server/src/lua/bindings.ts`) maps
  the script's list to role and text with a fresh `chatId` each and writes a whole-chat replace; the working-copy
  branch does the same without IDs (read, not run). Reproduced on 2026-11-17 (cross-check F1, rated P1) with a real
  Lua button handler that calls `getFullChat`, changes the first message's text, and calls `setFullChat`: the
  untouched reply came back with a new ID and without its time, generation and prompt information, stored
  translation, and reroll candidates (eight checked fields, none kept). The same edit through `setChat` kept all
  eight. Inherited from upstream RisuAI. One press of a card's button strips a whole chat's message data, and only a
  chat checkpoint or a snapshot from before the call brings it back. Suggested: carry message IDs through the getter
  and the setter, overlay role and text on the matched existing message, and give a fresh ID only to a new entry.

## server-generation

Guide:
[Server generation: jobs, channels, transforms, LLM and token routes](../structure/server-generation.md#known-hazards).

- A buffered reply is not stored when an output hook fails. With a buffered answer, the runner
  (`server/src/prompt/runner.ts`) runs the `editoutput` hooks before the first write of the reply; the streaming
  branch stores the raw text first. Reproduced on 2026-11-17 (cross-check F6) through the generation route with a
  loopback provider and a plugin `editoutput` callback that reports a failure: the job ended with status 500 at
  stage `script`, the chat held the user's message and no reply, and Request History held the provider's answer.
  The same failure on a streamed answer left the raw text in the chat. It applies to an answer that really arrives
  buffered: Half Streaming, or a provider that streams anyway, takes the protected path. A Lua output hook's timeout
  was not run. A paid answer disappears from the chat because of a fault in a script that only post-processes it.
  Suggested: store the buffered answer under the generation before output processing, as the streaming branch does.
- A trigger's final reconciliation writes an earlier setter over a newer value. A V2 trigger's setter changes its
  working copy (`server/src/prompt/triggers.ts`), a slash command it then runs writes the live chat
  (`server/src/prompt/commands.ts`), and when the trigger ends `server/src/jobs/chatResult.ts` applies the working
  copy again. Reproduced on 2026-11-17 (cross-check F9) through the generation route: a manual trigger that set `x`
  to `first` and then ran `/setvar key=x second` ended with `first`, and one that set the author's note to `first`
  and then ran `/trigger inner`, whose setter wrote `second`, ended with `first`; without the earlier setter both
  ended with `second`. All jobs reported `done`. A card that mixes trigger setters and slash commands ends with the
  older value, with no error. Suggested: do not replay setters that were already persisted, and refresh the working
  variables after a nested command.

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
  already clipped and cannot tell. Suggested: show whole fields when replacement is allowed, and refuse an oversized
  answer where it is admitted instead of clipping it.
- A candidate whose alias is an existing page's title creates a duplicate page
  ([writer guide](../structure/structured-memory/writer.md#known-hazards); rated P3). `find` in
  `server/src/prompt/memory/structured/pages.ts` matches the candidate's title against existing titles and aliases;
  the candidate's own aliases take no part. Reproduced on 2026-11-17 (cross-check F13): with a page `Mira`, a
  candidate `Mira Vale` with alias `Mira` became a second character page, with nothing refused and no warning; a
  candidate titled `Mira` updated the existing page. No text is lost and the pages can be merged by hand, but facts
  about one subject are split over two pages. Suggested: refuse or report a candidate whose alias collides with an
  existing title.

## translation

Guide:
[Translation: Providers, the LLM Translator, Presets, Server and Stored Translation, Bilingual Display](../structure/translation.md#known-hazards).

- A translation result or edit overwrites a newer translation of the same message. `setTranslation`
  (`server/src/data/chatStore.ts`) is fenced by the hash of the original text; it carries a base revision but is
  accepted on an older one, and the editor's captured `base` is not compared at save
  (`src/ts/translator/storedTranslation.svelte.ts`). Reproduced on 2026-11-17 (cross-check F4), both forms: a
  Retranslate whose provider answer was held while another client saved a hand correction replaced that correction
  when it arrived; and of two `StoredTranslationEdit` sessions opened before either save, the second save was
  accepted without an alert and replaced the first. Both writers were refused when the original text had changed.
  Nothing keeps the overwritten text. The reviewer rated it P1; the session rated it P2, because it needs two
  clients working on the same message's translation. Suggested: an expected translation version, "none" included,
  checked in `setTranslation`.
- A translation answer that holds only reasoning tags replaces a stored translation with an empty one. Reproduced
  on 2026-11-17 (cross-check F11, second half) through the real pipeline (`shared/translation/pipeline.ts`) and
  server runner (`server/src/translation/runner.ts`): on a message with a hand-edited translation, a forced run
  whose answer was `<think>…</think>` and nothing else stored an empty text as `applied`, without the edited flag,
  and the next request answered `fresh` without calling the provider. An answer with text after the tags was stored
  as designed. It needs a run that is admitted past the freshness check (Retranslate, for one). No translation
  history is written. Suggested: refuse a blank translation of non-blank input before it is published. The
  SupaMemory half of the entry is under [memory](#memory).
