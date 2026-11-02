# Structured Memory Page Tools: Trash, Merge, Split, Lorebook Export, Package Import

## Scope

- Owns what a person does to a `structuredMemory` page as a whole: the trash, merge, split, the lorebook export, and
  importing a Markdown package.
- Paths: `applyPageTool` and `parseMemoryPageTool` in `server/src/prompt/memory/structured/pages.ts`,
  `server/src/prompt/memory/structured/importPackage.ts`, the `page-tools` and `import` routes in
  `server/src/routes/structuredMemory.ts`, the tool controls of `src/lib/Others/StructuredMemory/PagesTab.svelte`, and
  the tool and import calls of `src/ts/process/structuredMemory.svelte.ts`.
- Not here:
  - Record shapes, the tables and store, the edit and revert routes, and how the package is written →
    [structured memory](structured-memory.md).
  - What the writer does to a page → [structured memory writer](structured-memory-writer.md).
  - The panel, its other tabs, and a section's edit → [structured memory read path](structured-memory-read.md).
  - What a copy, a branch, a checkpoint, and a chat file carry →
    [structured memory lifecycle](structured-memory-lifecycle.md).
  - What a rebuild seeds → [structured memory rebuild](structured-memory-rebuild.md#what-a-rebuild-keeps).

## Files

- `shared/structuredMemory.ts`: `MemoryPage.trashedAt` and `reshaped`, `StructuredMemoryContents.trash`, the `merge` and
  `split` history kinds, `StructuredMemoryPageTool`, `StructuredMemoryPageToolAnswer`, `MEMORY_PACKAGE_VERSION`,
  `StructuredMemoryImportFile`, `MEMORY_IMPORT_REFUSALS`, `StructuredMemoryImportRefusal`,
  `StructuredMemoryImportAnswer`.
- `server/src/prompt/memory/structured/pages.ts`: `parseMemoryPageTool`, `pageToolIds`, `applyPageTool`,
  `MemoryPageToolRefusal`, all pure. `applyPageTool` takes its reads lazily (`PageToolRecords`), so only a merge reads
  events and threads, and answers the change set, the page to show, and the pages to flag.
- `server/src/prompt/memory/structured/importPackage.ts`: `parseMemoryPackage`, pure. It reads the grammar of
  `renderMemoryPage`, `renderMemoryTimeline`, and `renderMemoryThreads`.
- `server/src/data/memoryStore.ts`: `TRASHED_PAGE_COLUMN`, `recordRow`, and `listing`, the one place that tells a
  trashed row from a live one.
- `src/ts/process/structuredMemory.svelte.ts`: `structuredMemoryPageTool`, `importStructuredMemoryPackage`,
  `renderMemoryThreads`.

## Flows

### The page tools route

`POST STRUCTURED_MEMORY_PATH/:characterId/:chatId/page-tools`, `{ revision, tool }`, capped at 64 KiB, answers
`StructuredMemoryPageToolAnswer`: the page the tab shows next, null after a purge. Its checks and order are
[the edit route's](structured-memory.md#the-edit-route), so a running or stopped rebuild refuses it 409 `fenced`. A tool
that changes nothing goes through as an empty change set, so a stale one is still refused. A refusal from the pages is
400 with text, and the tab shows that text. A gone page is 404 `recordGone`.

### The trash

- `trash` sets `trashedAt` and nothing else: links, attendance, and events keep the id, so a restore brings it all back.
  The scene page is refused, by the tool and again by the store.
- `untrash` clears it and runs `flagUnsupportedSections` against the events as they stand, since some may have been
  retracted meanwhile. A name that now collides with a live page is allowed: merge settles it.
- `purge` takes only a trashed page and removes it. References to it dangle, which readers tolerate.
- `/records/pages/:id` still reads a trashed page, so the panel shows it. `/edits` page edits and `/revert` refuse
  it 400.

### Merge

`{ kind: "merge", sourceId, targetId }`: both live, of one type, neither the scene.

- The target gains the source's title and aliases as aliases, its links with any link to the source dropped, and its
  keywords, the later `lastUsed`, and the source's grade only when it has none. `contextMode` stays the target's.
  Nothing cuts the alias list: `castRow` bounds what a prompt shows.
- A heading only the source has moves whole. One both have joins: the same body stays, any other is the target's, a
  blank line, then the source's. A join past `sectionBodyChars` or a page past `sectionsPerPage` is refused, because
  nothing is cut. Evidence joins through `newestEvidence`, older section first, and every mark holds when either section
  held it.
- `events`, `threads`, other pages' `links`, and the scene's `participants` move from the source's id to the target's in
  the same write: an event's `participants`, `stateChanges`, `knowledge` and its `knowers`, `relationshipShifts`,
  `openThreads.add[].who`, and `speakerId`. Manifests, receipts, and run inputs stay as logs.
- The source goes to the trash unchanged, its history with it. Restoring it gives a plain page, and its references stay
  on the target.

### Split

`{ kind: "split", pageId, headings, title, aliases }`: `headings` a strict subset of the page's, `aliases` a subset of
its own, and no live page of the type going by `title`. The new page has the type, `contextMode`, grade, the sections as
they stand, and the aliases, untruncated. Events stay on the old page: nothing says which half they meant.

### What a merge or split does to history

- A `merge` entry stands on every heading a merge touched on the target, and a `split` entry on every heading that left
  the old page. Neither has an `eventId`, so neither can be reverted, and each is a later entry of its heading, which
  makes [`revertChange`](structured-memory.md#the-revert-route) refuse every older one `superseded`. The bounded history
  drops oldest first, so a blocker outlives what it blocks.
- The source's history does not move to the target. A moved `before` under a target heading would put the source's text
  over the target's on a branch cut.
- `reshaped` marks a merge target, an old page, and a new page, and it outlives the history. A rebuild seeds such a page
  whole, and a branch leaves it alone, flagging what names a behind event. Without it a rebuild removes an unmarked
  merged page, and a branch can lose the source's half of a join or the whole page.

### Lorebook export

`exportToLore` in `PagesTab.svelte` appends one entry to the chat's `localLore` through `setChatMeta`, never to the
character's `globalLore`. `comment` is the title and `key` the title and aliases joined by commas, which `aliasSeeds`
reads. `content` opens with `@@dont_activate` and a blank line, because a decorator line right after it, such as a
section headed `@@activate`, would win. It is a chat write: no revision and no fence, and `readOnly` only turns the
button off.

### The import route

`POST STRUCTURED_MEMORY_PATH/:characterId/:chatId/import`, `{ revision, files: { path, text }[] }`, capped at
`restoreBodyBytes`, 413 past it, answers `StructuredMemoryImportAnswer`.

1. The tab unzips with fflate, adding each `.md` entry's declared `originalSize` against `MEMORY_RESTORE_BODY_BYTES`
   before any is inflated, so the server never sees a zip.
2. `parseMemoryPackage` reads each file and refuses what it gets wrong, a timeline event alone as `timeline.md#<id>`.
3. With no await from there, the epoch and `fenced`. A chat holding a row of any kind, trash and runs included, one
   under `chatAdoptionHold`, and files with no record all answer `imported: false` and write nothing, with the refusals
   listed.
4. What stands goes in one `store.memory.write` at the client's `revision`.

Add-only is refused on purpose: ids are not unique across chats, because a copy keeps them, so an accepted page could
bind to a refused, different event of the same id. One imported page would also clear an adoption hold with no choice.

The grammar, in `parseMemoryPackage`:

- Metadata is the authority. Each line is `key: <JSON>`, a repeated key refuses the file, and fields land through
  `Object.fromEntries`, so a `__proto__` key plants nothing.
- Bodies come by position from `bodyLines` and `summaryLines`. The `##` line must be the collapsed heading or title, a
  quote line must be the metadata's key line as rendered, and a file must be read to its end.
- `parseRestoredRecords` is the one shape check, one record at a time. Before it, what the store would refuse whole is
  refused per file: an invalid id, a repeated id, a second scene, a trashed scene, a text past
  `MAX_READ_RESPONSE_BYTES`.
- Pages come back with an empty history. A `packageVersion` past `MEMORY_PACKAGE_VERSION` is `newerVersion`. A timeline
  with no readable `threads.md` keeps its events with `openThreads.close` and `transitions` emptied and lists
  `missingThreads`.

## State

- `trashedAt` is on the record. The `type` column of a trashed row says `trashed` and the record keeps its true type, so
  `listing` splits rows with no statement reading `data`, and `MEMORY_PAGE_TYPES` does not grow.
- `contents.trash` rows hold `id`, `title`, and `bytes`, with no type: the column holds none.
- The tab holds a tool's form state per selected page, and the import report until another chat.

## Coupling

- Trash is kept deliberately. A checkpoint, snapshot, and backup keep it, walking rows through `recordRow`. A rebuild
  leaves it live, since `rebuildChanges` removes only ids of `contents.pages`. A copy, branch, chat file, and package
  leave it behind, each built from `contents.pages`, and events keep its id, which
  [a restore](structured-memory-lifecycle.md) calls legal. The projection reads events.
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
- A merge writes every reference in one change set, so no state exists with some references moved.
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
  page reads as live until a tool writes it, and its detail shows Restore. Decision: Structured Memory slice 7d, plan.
- An older build refuses a chat file holding a `merge` or `split` history entry whole, since its `restore.ts` checks the
  closed list. Decision: Structured Memory slice 7d, plan.
- Trash has no size limit or expiry: a page stays until a person deletes it forever. Decision: Structured Memory slice
  7d, plan.
- After a rebuild or a merge, a restored page can cite events that no longer exist. An id naming no event is not
  retracted, so nothing flags it. Decision: Structured Memory slice 7d, plan.
- What a person took back on a merge's source stays on the trashed source, so the writer can propose it on the target.
  Decision: Structured Memory slice 7d, plan.
- A branch keeps a reshaped page's text from past the branch point, flagged `unsupported` where a section names a behind
  event, and a send shows that text. Decision: Structured Memory slice 7d, plan.
- The lorebook entry can be lost to a stale whole-array write of `localLore` from another tab, as any lore edit can.
  Decision: Structured Memory slice 7d, plan.
- A package past `MEMORY_RESTORE_BODY_BYTES` cannot be imported, though rounds can export it. Decision: Structured
  Memory slice 7d, plan.
- No round trip is promised for hand edits: a body whose line count no longer matches refuses that file. Decision:
  Structured Memory D5, plan.
