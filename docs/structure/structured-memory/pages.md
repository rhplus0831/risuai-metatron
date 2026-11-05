# Structured Memory Page Tools: Trash, Merge, Split, Lorebook Export, Package Import

## Scope

- Owns what a person does to a `structuredMemory` page as a whole: the trash, merge, split, the lorebook export, and
  importing a Markdown package.
- Paths: `applyPageTool` and `parseMemoryPageTool` in `server/src/prompt/memory/structured/pages.ts`,
  `server/src/prompt/memory/structured/importPackage.ts`, the `page-tools` and `import` routes in
  `server/src/routes/structuredMemory.ts`, the tool controls of `src/lib/Others/StructuredMemory/PagesTab.svelte`, and
  the tool and import calls of `src/ts/process/structuredMemory.svelte.ts`.
- Not here:
  - The records and how the package is written, the projection, what the writer does to a page, the panel and its other
    tabs, what a copy or a chat file carries, and what a rebuild seeds → [the area README](README.md).

## Files

Read the named contract with its code; the shared modules also serve other structured-memory guides.

- `shared/structuredMemory.ts`: page-tool and import contracts; `MemoryPage.trashedAt`, `reshaped`,
  `StructuredMemoryContents.trash`, `MEMORY_HISTORY_CHANGE_KINDS`, `StructuredMemoryPageTool`,
  `StructuredMemoryPageToolAnswer`, `MEMORY_PACKAGE_VERSION`, `StructuredMemoryImportFile`, `MEMORY_IMPORT_REFUSALS`,
  `StructuredMemoryImportRefusal`, `StructuredMemoryImportAnswer`.
- `server/src/prompt/memory/structured/pages.ts`: pure page tools; `MemoryPageToolRefusal`, `parseMemoryPageTool`,
  `pageToolIds`, `PageToolRecords`, `PageToolResult`, `applyPageTool`, `mergedPages`, `joinedSection`, `withAliases`,
  `remappedEvent`, `splitPages`, `toolEntry`, `withHistory`.
- `server/src/prompt/memory/structured/importPackage.ts`: pure package grammar and admission; `parseMemoryPackage`,
  `Reader.metadata`, `readPage`, `fencedEntry`, `readTimeline`, `packageVersion`, `admitted`.
- `server/src/data/memoryStore.ts`: trash column and listing boundary; `TRASHED_PAGE_COLUMN`, `recordRow`, `listing`.
- `server/src/routes/structuredMemory.ts`: page-tool and import HTTP boundary; `registerStructuredMemoryRoutes`,
  `holdsRows`, `fenced`.
- `src/lib/Others/StructuredMemory/PagesTab.svelte`: page-tool controls and lore export; `runTool`, `exportToLore`,
  `importPackage`, `LORE_INACTIVE`.
- `src/ts/process/structuredMemory.svelte.ts`: tab's tool and package client; `structuredMemoryPageTool`,
  `packageFiles`, `importStructuredMemoryPackage`, `renderMemoryThreads`.

## Flows

### The page tools route

`runTool` calls `structuredMemoryPageTool` through `POST STRUCTURED_MEMORY_PATH/:characterId/:chatId/page-tools`. The
route calls `applyPageTool`, checks the flagged pages with `flagUnsupportedSections`, and writes one change set at the
tab's revision. The tab selects the answered page and rereads contents. Checks and order follow
[the edit route](records.md#the-edit-route), so a running or stopped rebuild refuses it 409 `fenced`.

### The trash

`/records/pages/:id` still reads a trashed page for the panel; `/edits` page edits and `/revert` refuse it 400. Trash
preserves reference ids, so a restore reconnects them. A `purge` leaves dangling references, which readers tolerate. The
store also refuses a trashed scene independently of the tool.

### What a merge or split does to history

`mergedPages` and `splitPages` leave heading blockers without an `eventId`. The
[revert route](records.md#the-revert-route) calls `revertChange`, which refuses older entries `superseded`; the tool
entries themselves cannot be reverted. The bounded history drops oldest first, so a blocker outlives what it blocks.

`reshaped` outlives history on a merge target and both split pages. [Rebuild](rebuild.md) seeds all their sections and
history; a [branch](lifecycle.md) keeps their text and flags sections citing behind events. Without `reshaped`, a
rebuild keeps only what `seededPage` keeps for another reason, such as a lock or a person's grade, and an unseeded page
can disappear at the swap; a branch could lose the source's half of a join or the whole page.

### Lorebook export

`exportToLore` appends chat `localLore` through `setChatMeta` in `src/ts/storage/chatStore.svelte.ts`. The next writer's
`aliasSeeds` reads its title and alias keys; `shared/lore/activation.ts` calls `CCardLib.decorator.parse` to read its
inactive decorator. This chat write is outside the memory revision and fence.

### The import route

1. `importPackage` calls `importStructuredMemoryPackage`; `packageFiles` unzips with fflate in the tab, refusing
   `tooLarge` past `MEMORY_RESTORE_BODY_BYTES` (the server's `restoreBodyBytes` cap), and sends Markdown to
   `POST STRUCTURED_MEMORY_PATH/:characterId/:chatId/import`, so the server never sees a zip.
2. The route calls `parseMemoryPackage`, which reads the renderers' grammar and validates each record through
   `parseRestoredRecords` in `server/src/prompt/memory/structured/restore.ts`. File and event refusals return in
   `StructuredMemoryImportAnswer`.
3. After parsing, the route checks the epoch, fence, and emptiness, then commits what stands in one `store.memory.write`
   at the tab's revision, without yielding. Only a chat with no rows, trash and runs included, and no `chatAdoptionHold`
   can import; any other answers `imported: false` and writes nothing. The route contract holds why add-only import
   cannot bind records safely.

## State

- `trashedAt` is on the record. The `type` column of a trashed row says `trashed` and the record keeps its true type, so
  `listing` splits rows with no statement reading `data`, and `MEMORY_PAGE_TYPES` does not grow.
- `contents.trash` rows hold `id`, `title`, and `bytes`, with no type: the column holds none.
- The tab holds a tool's form state per selected page, and the import report until another chat.

## Coupling

- Trash is kept deliberately. A checkpoint, snapshot, and backup keep it, walking rows through `recordRow`. A rebuild
  leaves it live, since `rebuildChanges` removes only ids of `contents.pages`. A copy, branch, chat file, and package
  leave it behind, each built from `contents.pages`, and events keep its id, which [a restore](lifecycle.md) calls
  legal. The projection reads events.
- `/inherit`, `/restore`, and `/import` count `contents.trash` as a row, so no write reaches a trashed row by id.
  `/adopt` does not, matching `adoptionHold`, so a chat with only trash can still be adopted.
- A trashed name is unknown to the writer, which may create that name again.
- `restore.ts` checks `trashedAt` and `reshaped`, so a record type's new field cannot go unchecked.

## Invariants

- Every decision about trash reads the record's `trashedAt`. The column only lists: an older build can rewrite a row's
  column ([Limitations](#limitations)).
- A reader of pages starts from `contents.pages`. A new reader by id must refuse or show a trashed page on purpose.
- The scene page takes no tool but export. `recordRow` refuses a trashed scene, a snapshot's included.
- A tool's `merge` and `split` entries never carry an `eventId`.
- A merge writes reference changes in events, threads, and live pages in one change set, so no partial remapping is
  visible.
- A tool or import that would not fit is refused, never cut.

## Recipes

- A new page tool: add it to `StructuredMemoryPageTool`, `parseMemoryPageTool`, `pageToolIds`, and `applyPageTool`, and
  give the tab a control that calls `runTool`.
- A new field holding a page id: add it to `remappedEvent` in `pages.ts`, or a merge leaves it on the trashed source.
- A new package file: render it, read it in `parseMemoryPackage`, bump `MEMORY_PACKAGE_VERSION`, and keep the older
  version importing.

## Tests

- `server/src/tests/structuredMemoryRoutes.test.ts` drives both routes on a real app: the tools, a revert across them,
  and the fence, the revision, and the shared step, the last with a microtask queued from the fence's own read.
- `structured/importPackage.test.ts` reads `server/src/tests/fixtures/memoryPackage.json`, literal rendered files with
  bodies that hold the grammar's own delimiters. A server test cannot import the tab's renderers, so
  `src/ts/process/structuredMemory.test.ts` keeps the fixture true to them.
- `structured/rebuild.test.ts` and `structured/inherit.test.ts` drive a `reshaped` page through a seed and a branch.
- `memoryStore.test.ts` and `restoreStage.test.ts` drive trash through a checkpoint, a snapshot, and a swap.
- `src/ts/process/structuredMemory.test.ts` drives the client with `authFetch` scripted, and
  `StructuredMemoryPanel.test.ts` the controls, with `activateLore` proving the exported entry stays inactive.
- Focused command: `pnpm --silent test:agent structuredMemory memoryStore restoreStage structured/`. No `slow` or `e2e`
  membership of its own.
- Not tested: real file picking and the zip dialog in a browser.

## Known Hazards

### Limitations

- A rollback brings trash back quietly. An older build lists a `trashed` row in `contents.pages` and takes the true type
  from the record, so a trashed page reaches its sends and writer again, while its panel tree, which groups by known
  types, hides the row. A write there sets the column to the true type and keeps `trashedAt`; after rolling forward that
  page reads as live until a tool writes it, and its detail shows Restore. Decision: Structured Memory slice 7d,
  archive.
- An older build refuses a chat file holding a `merge` or `split` history entry whole, since its `restore.ts` checks the
  closed list. Decision: Structured Memory slice 7d, archive.
- Trash has no size limit or expiry: a page stays until a person deletes it forever. Decision: Structured Memory slice
  7d, archive.
- After a rebuild or a merge, a restored page can cite events that no longer exist. An id naming no event is not
  retracted, so nothing flags it. Decision: Structured Memory slice 7d, archive.
- What a person took back on a merge's source stays on the trashed source, so the writer can propose it on the target.
  Decision: Structured Memory slice 7d, archive.
- A branch keeps a reshaped page's text from past the branch point, flagged `unsupported` where a section names a behind
  event, and a send shows that text. Decision: Structured Memory slice 7d, archive.
- The lorebook entry can be lost to a stale whole-array write of `localLore` from another tab, as any lore edit can.
  Decision: Structured Memory slice 7d, archive.
- A package past `MEMORY_RESTORE_BODY_BYTES` cannot be imported, though rounds can export it. Decision: Structured
  Memory slice 7d, archive.
- Hand edits have no round-trip guarantee: a mismatched body line count refuses the file. Decision: Structured Memory
  D5, archive.
