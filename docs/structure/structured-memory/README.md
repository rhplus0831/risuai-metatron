# Structured Memory

## Scope

The `structuredMemory` algorithm keeps a chat's memory as records (events, pages with sections, threads) in tables of
`data/resources.sqlite`, written by a writer task on the server and read into the prompt by a read path, with a
projection that answers readers expecting HypaV3's `hypaV3Data`. The seven guides below own it; pick the one whose row
names the task. The design and its remaining work are in [the archive](../../archived-plan/README.md).

Not here: the other algorithms, the selection chain, the memory task service, and embeddings → [memory](../memory.md);
the resource store's connection, epoch, and transactions → [server resources](../server-resources.md).

## Guides

| Task                                                                                                                    | Guide                       |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Record shapes and limits, the tables and store, the read, edit, revert, and restore routes, the package, a memory write | [records](records.md)       |
| The HypaV3 projection: the view, the seal, the tab's mirror, a plugin read's refresh, the upstream export, the reset    | [projection](projection.md) |
| The writer: settings, windows, the task kind, a run, the gap run, prompts, admission, pages, compaction, record now     | [writer](writer.md)         |
| The read path: lanes, the card, manifest and report, receipts, the panel, prompt tuning, the test run, the health badge | [read](read.md)             |
| Lifecycle: reconciliation and repairs, retraction, checkpoints, copies and branches, chat files, adoption               | [lifecycle](lifecycle.md)   |
| Rebuild and backfill: a run, the plan, staging, the swap, the lock, the cost preview                                    | [rebuild](rebuild.md)       |
| Page tools: trash, merge, split, lorebook export, package import                                                        | [pages](pages.md)           |

## Files

Shared by the guides; each guide's `Files` names what it owns in them.

- `shared/structuredMemory.ts`: types, limits, and pure rules for tab and server; [records](records.md#files) lists the
  records, limits, and route contracts.
- `server/src/data/memoryStore.ts` and `server/src/routes/structuredMemory.ts`: the store and the routes,
  [records](records.md)'s.
- `server/src/prompt/memory/structured/`: the writer's `window`, `writer`, `prompts`, `analysis`, `patches`, `compact`,
  `recordJob`, and the planning in `pages`; the read path's `lanes`, `retrieve`, `card`, `step`, and `testRun`
  ([its run](read.md#the-test-run)); the lifecycle's `reconcile`, `inherit`, `restore`, `adopt`, and the repairs in
  `edits` (its rest is [records](records.md)'s); [rebuild](rebuild.md)'s `rebuild`; [pages](pages.md)'s `importPackage`
  and the tools and revert rules in `pages`.
- `src/ts/process/structuredMemory.svelte.ts`: the tab's client: reads, edits, and package rendering
  [records](records.md)'s; receipt and panel views [read](read.md)'s; page tool and import calls [pages](pages.md)'s;
  revision, projection, and reset calls [projection](projection.md)'s; inherit, restore, adoption, and chat-file calls
  [lifecycle](lifecycle.md)'s, as is `src/ts/process/chatMemoryInherit.svelte.ts`; cost and abandon calls
  [rebuild](rebuild.md)'s.
- `src/lib/Others/StructuredMemory/`, `src/lib/ChatScreens/MemoryReceiptLine.svelte`, and
  `src/lib/Setting/Pages/StructuredMemoryPrompts.svelte`: the panel and its pages, [read](read.md)'s, with the rebuild
  controls [rebuild](rebuild.md)'s and the page tool controls [pages](pages.md)'s.
- Outside the area: the projection parts of `src/ts/storage/chatStore.svelte.ts`, `src/ts/plugins/apiV3/v3.svelte.ts`,
  `server/src/data/resourceStore.ts`, and `server/src/data/upstream/exportDatabase.ts` are
  [projection](projection.md)'s; [lifecycle](lifecycle.md) names the memory capture in
  `server/src/data/checkpointStore.ts`, a [server resources](../server-resources.md) file.
- Shared identifiers, in [records](records.md#files): `STRUCTURED_MEMORY_ALGORITHM`, the persisted discriminator;
  `STRUCTURED_MEMORY_PATH`; the record types; the revision token `<epoch>:<chatSeq>:<revision>`.
