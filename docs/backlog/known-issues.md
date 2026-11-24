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

- Second fix round of 2026-11-22: no report; the implementers' and reviewers' reports and probes are kept with the review
  material outside the repository.
- Reproduction round of 2026-11-24: no report in the repository; the probes, named by repository path, and the agents'
  reports are kept with the review material outside the repository.

## Contents

- [assets](#assets) (1)
- [backup-sync-hub](#backup-sync-hub) (1)
- [characters-modules](#characters-modules) (2)
- [chat-pipeline](#chat-pipeline) (1)
- [chat-store](#chat-store) (1)
- [draft-recovery](#draft-recovery) (1)
- [mcp](#mcp) (1)
- [memory](#memory) (2)
- [network-jobs](#network-jobs) (1)
- [plugin-sandbox](#plugin-sandbox) (1)
- [structured-memory](#structured-memory) (1)
- [translation](#translation) (2)

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

- A chat lorebook or lore override prompt whose expanded popup is open loses the text typed in it when the write fence
  rises. `src/lib/SideBars/LoreBook/LoreEntryFields.svelte` replaces the editable field with another text area while
  the chat is fenced (`loreWriteFenced`), and the destroyed field's popup drops its pending hand-back
  (`src/lib/UI/GUI/TextAreaInput.svelte`). Reproduced on 2026-11-22 in scratch component tests at `924542c39` (the
  fence rising from this tab's own send and from a message lock) and at `5121ee5a4` (from a job the live feed lists):
  the popup closed, the stored entry kept its old prompt, and reopening showed the old prompt. Since `2e0402cbd` the
  fence also rises for a job or preview another device runs, so the loss has one more trigger. Not fixed. The message
  editor keeps such text through a lock (read-only popup, text handed back); these fields have no draft to hand to.
  - A fix attempt of 2026-11-22 (held text handed back when the fence falls) was withdrawn after two reviews found
    reproduced losses on its own paths: a handback must wait while the chat is behind, and after a feed retirement
    until the job and chat are reconciled; held text must survive a chat switch or a reload (unsaved-work
    registration, or a recoverable draft or copy path); an older handback must not close a newer popup.
  - The server accepts a whole lore-list write from a stale base, which can erase a job's lore change, so a reliable
    fix starts with a server refusal like the one for the HypaV2 and SupaMemory fields (`chatMemoryWrites`). The
    attempt's reproduction and the reviewers' probes are kept with the review material outside the repository.
    [Field switch](../../src/lib/SideBars/LoreBook/LoreEntryFields.svelte#L94) ·
    [Popup teardown](../../src/lib/UI/GUI/TextAreaInput.svelte#L265)

- Module, CharX and Realm imports wait on the streaming import transport with no deadline. `serverImportClient` awaits
  headers and the body to its end, also after a result line, so an import whose answer never comes stays at its upload
  or download status; the client sends a second import, which the server refuses with 409 "Another import is running"
  only while it still processes the first (see [server-resources](#server-resources)). Reproduced on 2026-11-24 at
  `4c84cd229` by the reproduction round's probe `src/ts/storage/tests/pluginImportAssets.probe.test.ts` (all four
  actions unsettled after ten minutes). Realm's upstream hop has its own deadlines.
  [Transport](../../src/ts/storage/serverImportClient.ts#L80)

## chat-pipeline

Guide: [Chat Pipeline: Send → Prompt → Request → Reply](../structure/chat-pipeline.md#known-hazards).

- The PO translator and DevTool autopilot check the tab's chat binding with `checkServerJobBinding` before appending
  a user message, and the append is saved before the job is created. A refusal only the server's admission finds, such
  as a binding mismatch, leaves the appended message in the transcript. Reproduced on 2026-11-24 in a scratch test
  (a 409 binding mismatch after the append was saved). Removing it by id is not safe: another tab can edit the saved
  row first, and the server's single-id remove neither checks the base revision nor the stored text, so a fix needs a
  conditional remove (the row still holds the appended text) in the chat write protocol, or the append moved into
  admission. [PO translator](../../src/ts/process/files/multisend.ts#L76) ·
  [DevTool autopilot](../../src/lib/SideBars/DevTool.svelte#L293) ·
  [Server remove](../../server/src/data/chatStore.ts#L2781)

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

## draft-recovery

Guide: [Draft Recovery: Journal, Composer Rows, Recovery Drafts](../structure/draft-recovery.md#known-hazards).

- A second recovery Apply replays the ops the first one saved, over edits made since. When the server refuses part of
  a draft (a memory field edit after a job's write, an OOC answer another tab already stored), `applyRecoveryDraft`
  keeps the whole draft, and a later Apply rebuilds every op, so a note the first Apply saved and another tab edited
  since is set back to the draft's text. The same happens when the first Apply's wait ends at its 30-second bound and
  the save commits later: the draft stays, Apply is enabled again, and a second Apply after a newer edit replays it
  and reports success. Reproduced on 2026-11-24 at `4c84cd229` by rerunning the reviewer probes of the second fix
  round of 2026-11-22: "a retry of memoryNote / mixedNote preserves a subsequent revision of the already-saved note"
  failed with `Expected: "Newer saved note"`, `Received: "Original local note"`, and the timed-out case stored
  "Recovered B" over "New edit B". A fix records which ops the acknowledgement refused (the group result needs a
  field or exchange identity) and retries only those.
  [Apply](../../src/ts/storage/journalRecovery.ts#L1148)

## mcp

Guide: [MCP: Client Registry, Remote and Internal Clients, RisuAccess, Tool Dispatch](../structure/mcp.md#known-hazards).

- MCP OAuth discovery, client registration and token exchange (`mcplib.ts`) have no request deadline or signal, so a
  remote tool listing that meets a 401 waits for as long as one of them is unanswered; another caller of the same remote
  client can proceed. The internal clients' shared handshake (`readyTabClient`, the filesystem picker and the Google
  credentials step) is held by the user's own interactive step. Reproduced on 2026-11-24 at `4c84cd229` by the
  reproduction round's probe `src/ts/network/renderedTranslationMcpPush.probe.test.ts` (the listing had not ended after
  ten minutes). The refresh token branch has no deadline either, by reading.
  [OAuth](../../src/ts/process/mcp/mcplib.ts#L889) · [Handshake](../../src/ts/process/mcp/mcp.ts#L56)

## memory

Guide: [Long-Term Memory and Embeddings](../structure/memory.md#known-hazards).

- Memory task Start and Cancel share one request slot per character and chat in the tab, held until fetch and body
  settle with no deadline: while a start's answer is held, Cancel in the same chat answers `busy`, and while a cancel's
  answer is held, Start does; another chat proceeds. An outstanding start also fences local memory edits. Reproduced on
  2026-11-24 at `4c84cd229` by the reproduction round's probe `src/lib/Others/checkpointMemoryControls.probe.test.ts`
  (`{ outcome: 'busy' }` where `cancelled` and `queued` were expected). [Request
  slot](../../src/ts/process/memoryTasks.svelte.ts#L410)

- A cancelled Structured Memory recording keeps its place in the server's shared memory-task capacity until its tracked
  host calls settle (`memoryTasks.ts` charges a task once while any call remains), so a host call that never answers (a
  held token count) holds that capacity across chats and warmers. Cancel publishes the cancelled terminal at once and
  fences the task's commits; a late result adds nothing. Reproduced on 2026-11-24 at `4c84cd229` by the reproduction
  round's probe `server/src/tests/serviceCapacity.probe.test.ts` (one unsettled task ten minutes after cancellation).
  [Capacity](../../server/src/prompt/memory/memoryTasks.ts#L892)

## network-jobs

Guide: [Network and Jobs: Fetch Routing, Aux Fetch, Generation Job Client, Job Channel, Web Push](../structure/network-jobs.md#known-hazards).

- Web Push reconciliation and Enable or Disable run in one queue, and with Web Locks the queued unit also holds the
  origin's `risu-push` lock across tabs; the key, registration and removal requests have no deadline, so one unanswered
  registration keeps Disable from starting in every tab of the browser. The browser permission prompt runs on the click,
  before the queue. Reproduced on 2026-11-24 at `4c84cd229` by the reproduction round's probe
  `src/ts/network/renderedTranslationMcpPush.probe.test.ts` (no Disable completed in two tabs after ten minutes).
  [Queue](../../src/ts/network/pushNotifications.ts#L418)

## plugin-sandbox

Guide: [Plugins: v3 Sandbox, Host API, Hooks, Storage, Permissions](../structure/plugin-sandbox.md#known-hazards).

- A plugin permission refresh whose answer never comes holds every later grant, revocation and permission-list save of
  the tab: `refreshPluginPermissions` runs in the store's promise queue and submits its resource read without a deadline
  or signal. Synchronous lookups still read the mirror, and other tabs have their own queues. Reproduced on 2026-11-24
  at `4c84cd229` by the reproduction round's probe `src/ts/storage/tests/pluginImportAssets.probe.test.ts` (neither the
  grant nor the revoke written after ten minutes). [Queue](../../src/ts/plugins/apiV3/permissionStore.ts#L166)

## structured-memory

Guide: [Structured Memory Records](../structure/structured-memory/records.md#known-hazards).

- A Timeline edit whose answer never comes disables the mounted Timeline's edit and repair controls, the open editor's
  Cancel and every other event's Edit included: `editStructuredMemory` calls `readAnswer` without `deadlineMs`, and
  `repairing` clears `sending` only after the write and its reads settle. Opening another event and the panel's tab
  selector still work. Reproduced on 2026-11-24 at `4c84cd229` by the reproduction round's probe
  `src/lib/Others/checkpointMemoryControls.probe.test.ts` (another event's Edit still disabled after ten minutes).
  [Edit](../../src/lib/Others/StructuredMemory/TimelineTab.svelte#L504) ·
  [Request](../../src/ts/process/structuredMemory.svelte.ts#L286)

## translation

Guide: [Translation: Providers, the LLM Translator, Presets, Server and Stored Translation, Bilingual Display](../structure/translation.md#known-hazards).

- Rendered translation has ten permits for new work across the tab's chats, and an admitted producer keeps its permit
  until its work settles; the Google producer has no deadline, so ten unanswered translations stop every other message's
  new translation (the row keeps its spinner with Show Translation Loading on). Cache hits, joins and the composer's
  translation bypass the queue. Reproduced on 2026-11-24 at `4c84cd229` by the reproduction round's probe
  `src/ts/network/renderedTranslationMcpPush.probe.test.ts` (ten provider requests where eleven were expected).
  [Permits](../../src/ts/translator/translator.ts#L112)

- Server translation counts a run's underlying provider work against capacity after the caller's deadline: the caller
  gets 504 "The translation took too long", and the work stays counted until the provider answers, so enough of them
  make the route answer 429 for every user. A late answer is not applied over a newer translation. Reproduced on
  2026-11-24 at `4c84cd229` by the reproduction round's probe `server/src/tests/serviceCapacity.probe.test.ts` (one unit
  of provider work still counted after the deadline and a completed retry).
  [Capacity](../../server/src/translation/runner.ts#L503)
