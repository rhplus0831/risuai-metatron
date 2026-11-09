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
| Rebuild, fresh rebuild, and backfill: a run, the plan, staging, the swap, the lock, the cost preview                    | [rebuild](rebuild.md)       |
| Page tools: trash, merge, split, lorebook export, package import                                                        | [pages](pages.md)           |

## Files

Shared contracts and entrypoints; the focused guides' `Files` sections name their owned symbols.

- `shared/structuredMemory.ts` is the shared record and route contract used by the tab and server. The
  [records guide](records.md#files) catalogs its cross-guide shapes and identifiers.
- `server/src/prompt/memory/structured/` contains the area's server modules; `src/lib/Others/StructuredMemory/` holds
  the panel and tabs. Each focused guide's `Files` section names the modules and symbols it owns.
- The server entrypoints are `server/src/data/memoryStore.ts` and `server/src/routes/structuredMemory.ts`; the tab
  entrypoints are `src/ts/process/structuredMemory.svelte.ts` and `src/ts/process/chatMemoryInherit.svelte.ts`.
- The projection also crosses `src/ts/storage/chatStore.svelte.ts`, `src/ts/plugins/apiV3/v3.svelte.ts`,
  `server/src/data/resourceStore.ts`, and `server/src/data/upstream/exportDatabase.ts` ([projection](projection.md)).
  Checkpoint capture crosses `server/src/data/checkpointStore.ts` ([server resources](../server-resources.md),
  [lifecycle](lifecycle.md#files)).
- Shared identifiers, in [records](records.md#files): `STRUCTURED_MEMORY_ALGORITHM`, the persisted discriminator;
  `STRUCTURED_MEMORY_PATH`; the record types; the revision token `<epoch>:<chatSeq>:<revision>`.
