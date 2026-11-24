# Known Issues

Confirmed defects and advertised but unwired behavior, kept as one queue across the focused guides. The guides keep
their `Unconfirmed:` claims (reproduction comes first for those), their Limitations, and their Gotchas; a claim that
is confirmed moves here, and so does a [found issues](found-issues.md) entry once it is reproduced. Each entry is one
bullet under its owning guide, with its links pointed back at the guide, and says how it was reproduced; the Contents
list counts each guide's entries. Line numbers and identifiers drift: re-check the code before acting on an entry
(STRUCTURE.md protocol step 5), and delete it in the same commit that fixes it or shows it is gone. A defect the owner
decides to keep moves back to the guide as a Limitation with the decision. A new confirmed defect goes here, not into
the guide.

This file holds open entries only, written in the present tense. Do not add history here: which entries moved in
when, who fixed what and how, and what the owner decided about an entry that has left belong in the commit message of
the commit that moves, fixes, or closes it (`git log -- docs/backlog/known-issues.md`), and in the guide's Limitation
when the owner keeps the behavior. When a fix closes part of an entry, rewrite the entry to what is left.

Sources the entries name (drop a line when no entry names it any more):

- Reproduction round of 2026-11-24: no report in the repository; the probes, named by repository path, and the agents'
  reports are kept with the review material outside the repository.

## Contents

- [assets](#assets) (1)
- [backup-sync-hub](#backup-sync-hub) (1)
- [characters-modules](#characters-modules) (1)
- [chat-store](#chat-store) (1)
- [memory](#memory) (1)
- [network-jobs](#network-jobs) (1)
- [translation](#translation) (1)

## assets

Guide: [Assets: Sources, Client, Queues, Batch Codec](../structure/assets.md#known-hazards).

- The in-tab asset queues hold their slots while a transfer is unanswered: ten unanswered writes hold the next item of a
  `CharXImporter`'s save queue (reached for CharX bytes and streams; a file-picker CharX takes the server path), and
  four unanswered preview bodies hold the fifth preview of the storage report. Slots free when the transfer settles or a
  preview is released. Reproduced on 2026-11-24 at `4c84cd229` by the reproduction round's probe
  `src/ts/storage/tests/pluginImportAssets.probe.test.ts` (ten writes started of eleven; four previews of five). [Save
  queue](../../src/ts/storage/assetQueue.ts#L202) · [Preview queue](../../src/ts/storage/assetLifecycleClient.ts#L62)

## backup-sync-hub

Guide: [Backups, Realm Hub](../structure/backup-sync-hub.md#known-hazards).

- An upstream backup prepare whose answer never comes leaves the tab at its upload status with no review: the prepare
  uses the import transport without a deadline. The server's backup slot is released before the prepare result is sent.
  Reproduced on 2026-11-24 at `4c84cd229` by the reproduction round's probe
  `src/ts/storage/tests/pluginImportAssets.probe.test.ts` (prepare unfinished after ten minutes).
  [Prepare](../../src/ts/drive/upstreamBackupClient.ts#L83)

## characters-modules

Guide: [Characters, Cards, Modules, Personas](../structure/characters-modules.md#known-hazards).

- Module, CharX and Realm imports wait on the streaming import transport with no deadline. `serverImportClient` awaits
  headers and the body to its end, also after a result line, so an import whose answer never comes stays at its upload
  or download status; the client sends a second import, which the server refuses with 409 "Another import is running"
  only while it still processes the first (see [server-resources](#server-resources)). Reproduced on 2026-11-24 at
  `4c84cd229` by the reproduction round's probe `src/ts/storage/tests/pluginImportAssets.probe.test.ts` (all four
  actions unsettled after ten minutes). Realm's upstream hop has its own deadlines.
  [Transport](../../src/ts/storage/serverImportClient.ts#L80)

## chat-store

Guide: [Chat Store: Chat Module, Write Protocol, Checkpoints](../structure/chat-store.md#known-hazards).

- An unanswered checkpoint restore holds the tab-wide checkpoint guard. `loadCheckpoint` keeps `checkpointLoadBusy`
  through preparation, the request and the chat read, and `chatRequest` waits on `authFetch` and the body with no
  deadline, so Restore and Save As in every chat of the tab answer `busy`, and the dialog's Close and Escape stay
  disabled until reload. A silent list or policy read holds only its own dialog, which can be closed. A restore may
  commit before its answer is seen; a success or a recognized lost answer reads the chat again. Reproduced on 2026-11-24
  at `4c84cd229` by the reproduction round's probe `src/lib/Others/checkpointMemoryControls.probe.test.ts` (a save in
  another chat after ten minutes answered `{ status: 'not-sent', reason: 'busy' }`). Checkpoint preparation is bounded
  by `SEND_FLUSH_DEADLINE_MS` (30 s). [Restore guard](../../src/ts/checkpoints/chatCheckpoints.svelte.ts#L224) ·
  [Request](../../src/ts/checkpoints/chatRequest.ts#L20)

## memory

Guide: [Long-Term Memory and Embeddings](../structure/memory.md#known-hazards).

- Memory task Start and Cancel share one request slot per character and chat in the tab, held until fetch and body
  settle with no deadline: while a start's answer is held, Cancel in the same chat answers `busy`, and while a cancel's
  answer is held, Start does; another chat proceeds. An outstanding start also fences local memory edits. Reproduced on
  2026-11-24 at `4c84cd229` by the reproduction round's probe `src/lib/Others/checkpointMemoryControls.probe.test.ts`
  (`{ outcome: 'busy' }` where `cancelled` and `queued` were expected). [Request
  slot](../../src/ts/process/memoryTasks.svelte.ts#L410)

## network-jobs

Guide: [Network and Jobs: Fetch Routing, Aux Fetch, Generation Job Client, Job Channel, Web Push](../structure/network-jobs.md#known-hazards).

- Web Push reconciliation and Enable or Disable run in one queue, and with Web Locks the queued unit also holds the
  origin's `risu-push` lock across tabs; the key, registration and removal requests have no deadline, so one unanswered
  registration keeps Disable from starting in every tab of the browser. The browser permission prompt runs on the click,
  before the queue. Reproduced on 2026-11-24 at `4c84cd229` by the reproduction round's probe
  `src/ts/network/renderedTranslationMcpPush.probe.test.ts` (no Disable completed in two tabs after ten minutes).
  [Queue](../../src/ts/network/pushNotifications.ts#L418)

## translation

Guide: [Translation: Providers, the LLM Translator, Presets, Server and Stored Translation, Bilingual Display](../structure/translation.md#known-hazards).

- Rendered translation has ten permits for new work across the tab's chats, and an admitted producer keeps its permit
  until its work settles; the Google producer has no deadline, so ten unanswered translations stop every other message's
  new translation (the row keeps its spinner with Show Translation Loading on). Cache hits, joins and the composer's
  translation bypass the queue. Reproduced on 2026-11-24 at `4c84cd229` by the reproduction round's probe
  `src/ts/network/renderedTranslationMcpPush.probe.test.ts` (ten provider requests where eleven were expected).
  [Permits](../../src/ts/translator/translator.ts#L112)
