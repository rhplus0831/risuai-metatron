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
| The writer: settings, windows, the task kind, a run, prompts, admission, pages, compaction, record now                  | [writer](writer.md)         |
| The read path: lanes, the card, manifest and report, receipts, the memory panel, prompt fine-tuning, the health badge   | [read](read.md)             |
| Lifecycle: reconciliation and repairs, retraction, checkpoints, copies and branches, chat files, adoption               | [lifecycle](lifecycle.md)   |
| Rebuild and backfill: a run, the plan, staging, the swap, the lock, the cost preview                                    | [rebuild](rebuild.md)       |
| Page tools: trash, merge, split, lorebook export, package import                                                        | [pages](pages.md)           |

## Files

Shared by the guides; each guide's `Files` names what it owns in them.

- `shared/structuredMemory.ts`: types, limits, and pure rules, safe in the tab and on the server.
  [records](records.md#files) lists them; the reconciliation rules are [lifecycle](lifecycle.md)'s and the projection
  and seal rules [projection](projection.md)'s.
- `server/src/data/memoryStore.ts` and `server/src/routes/structuredMemory.ts`: the store and the routes.
  [records](records.md) owns them, and each other guide names its route or surface in its `Files`.
- `server/src/prompt/memory/structured/`: the writer's `window`, `writer`, `prompts`, `analysis`, `pages`, `patches`,
  `compact`, `recordJob`, `testRun`; the read path's `lanes`, `retrieve`, `card`, `step`; the lifecycle's `reconcile`,
  `inherit`, `restore`, `adopt`, and the repair rules of `edits.ts` (the rest of it is [records](records.md)'s);
  `rebuild.ts`; the page tools of `pages.ts` and `importPackage.ts`, [pages](pages.md)'s.
- `src/ts/process/structuredMemory.svelte.ts`: the tab's client. Its reads and edits are [records](records.md)'s, the
  receipt and panel parts [read](read.md)'s, the page tool and import calls [pages](pages.md)'s, and the revision and
  projection reads [projection](projection.md)'s.
- `src/lib/Others/StructuredMemory/`, `src/lib/ChatScreens/MemoryReceiptLine.svelte`, and
  `src/lib/Setting/Pages/StructuredMemoryPrompts.svelte`: the panel and its pages, [read](read.md)'s, with the rebuild
  controls [rebuild](rebuild.md)'s and the page tool controls [pages](pages.md)'s.
- Outside the area: the projection parts of `src/ts/storage/chatStore.svelte.ts`, `src/ts/plugins/apiV3/v3.svelte.ts`,
  `server/src/data/resourceStore.ts`, and `server/src/data/upstream/exportDatabase.ts` are
  [projection](projection.md)'s; `src/ts/process/chatMemoryInherit.svelte.ts` and the memory parts of
  `server/src/data/checkpointStore.ts` are [lifecycle](lifecycle.md)'s.
- Shared identifiers: `STRUCTURED_MEMORY_ALGORITHM`, the persisted discriminator; `STRUCTURED_MEMORY_PATH`, the routes'
  path; the records `MemoryEvent`, `MemoryPage`, `MemorySection`, `MemoryThread`, `MemoryRun`, `MemoryReceipt`; and the
  memory revision token `<epoch>:<chatSeq>:<revision>`.
