# Memory Panel Readability Plan audit, 2026-11-11

- Plan: `docs/plan/memory-panel-readability.md`
- Commit audited: `09ce72896` (`dev`), with the plan as a working-tree draft; the corrected plan is `6a72c5320`
- Mode: `full`
- Model: GPT-6-Astra (`xhigh`), read-only, in place of the usual Sol session because the plan crosses the panel, the
  shared contract, the routes, and the writer's rules; report written by the session that drafted the plan (Claude
  Fable 5.2), before any plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 0     |
| P2         | 4     |
| P3         | 5     |
| unverified | 0     |

Every finding below is `fixed in plan`. Astra read the corrected plan in the same session and confirmed AUD-1 to AUD-5,
AUD-7, and AUD-8 against the code, with the product's behavior unchanged. It disputed one sentence of the AUD-6
correction and the first wording of AUD-9 and gave the replacement for each; both were applied in Astra's wording and
were not read again after that last edit. Astra found no new P1 or P2 in the corrected text. It changed no file
(`git status` showed only the plan and its index entry) and ran four existing test files through the wrapper (rebuild,
inherit, restore, and the tab client): 53 passed. Browser behavior was not run.

Found consistent: the write boundary (authentication and body parsing before one synchronous epoch, fence, read,
apply, and write step; a no-op write still checks the revision; `server/src/routes/structuredMemory.ts:790`,
`server/src/data/memoryStore.ts:825`); `readKinds(characterId, chatId, ["events"])` and the pages listing without the
trash (`memoryStore.ts:885`, `:587`); `answerRound` and `roundOf` as the base of a new round route
(`structuredMemory.ts:577`, `:200`); rename and aliases through the lazy live-page reader, with no other exhaustive
consumer of the tool union (`server/src/prompt/memory/structured/pages.ts:846`, `:1172`,
`src/ts/process/structuredMemory.svelte.ts:887`); `namedByUser` extending `seededPage`'s `chosen`, and a seeded page
with no sections surviving the swap (`rebuild.ts:165`, `:355`); unknown optional page fields surviving restore, a copy,
and the package (`restore.ts:226`, `inherit.ts:259`, `importPackage.ts:170`); `userCorrected` on an event set by
nothing today and carried at `reconcile.ts:296` and `rebuild.ts:270`; no hash, anchor state, or kept state computed
from an event's title or summary (`shared/structuredMemory.ts:1549`); a `create` or `edit` history entry with
`before: null` and no `eventId` legal for restore, the history view, the revert route, and both rewinds
(`restore.ts:122`, `structuredMemory.svelte.ts:1905`, `pages.ts:769`, `inherit.ts:180`, `reconcile.ts:413`); a section
with empty `provenance` and `sources` accepted by the card, retrieval, compaction, and flagging (`card.ts:131`,
`retrieve.ts:651`, `compact.ts:59`, `edits.ts:316`); nothing depending on the coverage tab being first except the
panel test's own cases (`StructuredMemoryPanel.test.ts:194`, `:1445`).

Re-check list: the plan adds no fence-closing path (`retireRerecorded` feeds the existing `commitWindow`, whose
receipts use `patchMessage`, `writer.ts:449`, `chatStore.ts:2533`); memory writes publish no feed rows
(`resourceStore.ts:2185`, the whole-row measure is at `chatStore.ts:1899`); the new page field lives in record JSON, so
`STORE_TABLES_SQL` is not involved (`resourceStore.ts:3829`, `:792`); no delivery mechanism changes. The fourth entry's
wording is stale, as the 2026-11-10 report also found: `sendText` aggregates `sendSocket` successes
(`server/src/jobs/generationJobs.ts:1020`, `:1035`).

## P2

### AUD-1 — Slice 3: converting the opened event again empties its thread changes — fixed in plan

Plan, slice 3: "`TimelineTab.svelte`'s details render it under the key lines, from `memoryEventView(openEvent)`".

Code: `openEvent` is already a `MemoryRunEventView` (`TimelineTab.svelte:74`), made by `readOpen` with
`memoryEventView` (`:132`). The conversion reads the record's `openThreads` (`structuredMemory.svelte.ts:2114`) and
writes `threads` (`:2148`); a second conversion finds no `openThreads` and answers empty lists.

New sentence: "`openEvent` is already the `MemoryRunEventView` that `readOpen` made with `memoryEventView`, so it is
passed as it is, never converted again".

### AUD-2 — Slice 1: the scope leaves structured-memory task strings out — fixed in plan

Plan, slice 1: "Scope: the `structuredMemory` object of `ko.ts`, and the structured-memory-only strings outside it",
followed by the health, lock, toast, and receipt ranges.

Code: `memoryTasks.rebuilt` (`src/lang/ko.ts:2391`) and the reasons `writerPaused`, `revisionConflict`,
`awaitingAdoption`, and `memoryRebuilding` (`:2428`) say 메모리 too. The panel shows them through
`memoryTaskStatusLine` (`StructuredMemoryPanel.svelte:173`, `HypaV3Modal/taskStatusLine.ts:24`), and
`MemoryReceiptLine.svelte:83` reads the reasons. All five come from Structured Memory work
(`server/src/prompt/memory/memoryTasks.ts:789`, `:1229`, `structured/writer.ts:489`, `:565`); the HypaV3 modal can
show one after an algorithm switch, where it still describes that earlier work.

New sentence: "and, under `memoryTasks`, `rebuilt` (~2391) and the reasons `writerPaused`, `revisionConflict`,
`awaitingAdoption`, and `memoryRebuilding` (~2428) … The slice reads each string's consumers before changing it".

### AUD-3 — Slice 7: a repair's reread refreshes neither the opened event, the mark, nor the story — fixed in plan

Plan, slice 7: "It sends through `editStructuredMemory` at the coverage revision and rereads the facts, as a repair
does. … `story` shows the edited summary after the reread."

Code: `sendRepair` calls only `read()` (`TimelineTab.svelte:184`), which reads coverage (`:96`), and coverage holds
neither the summary nor `userCorrected` (`structuredMemory.ts:641`). The opened event is read again only when
`refresh` moves (`TimelineTab.svelte:140`), a memory write publishes nothing (`resourceStore.ts:2185`), and
`MemoryRunEventView` has no `userCorrected` (`structuredMemory.svelte.ts:2041`).

New sentence: "when an `eventText` or `eventRelease` settles, accepted or refused, the tab rereads coverage and the
opened event's record, and reads `/story` again when `story` is chosen, under the tab's existing chat and read-number
guards. `MemoryRunEventView` has no `userCorrected`, so the tab keeps the mark from the record it read beside the
view."

### AUD-4 — D4 promised what D7 and slice 7 do not do — fixed in plan

Plan, D4: "A person's event text outlives a re-record and a rebuild until the person releases the mark"; D7: "the
mark crosses alone, as today, and the person's text is gone."

Code: a rebuild's windows can group several turns (`rebuild.ts:145`), and the swap removes a live event once staged
events cite every one of its sources (`:335`, `:361`). Under slice 7's exact-set rule a corrected event over
`{u1, a1}` replaced by a staged event over `{u1, a1, u2, a2}` loses its text. A live event the swap does not replace
is carried with its text (`:284`), so D7's "is gone" was too wide as well. The overlap list repeats an event once per
shared message (`:340`).

New sentences: D4, "A person's event text outlives a re-record until the person releases the mark, and a rebuild's
replacement under D7's condition. A fresh rebuild discards it"; D7, "the text of a replaced event is gone, while an
event the swap carries keeps its text"; slice 7, "exactly one standing overlapping live event, counted by event id".

## P3

### AUD-5 — Current State: the Korean counts were matching lines — fixed in plan

Plan, Current State: "says 메모리 50 times, 페이지 56, 이벤트 31, 스레드 12, and 기억 10".

Code: `src/lang/ko.ts:2439` to `:3016` has 50, 56, 31, 12, and 10 lines with those terms, and 57, 62, 32, 13, and 11
occurrences.

New sentence: "has 50 lines that say 메모리, 56 페이지, 31 이벤트, 12 스레드, and 10 기억 (57, 62, 32, 13, and 11
occurrences)".

### AUD-6 — File lists and Order: contract comments and edits misstated — fixed in plan

Plan: slice 6's and slice 8's Files; Order, "Every slice edits `src/lang/en.ts` and `src/lang/ko.ts` … slices 4, 5
and 7 edit `server/src/routes/structuredMemory.ts`. No pair is file-disjoint".

Code: the route's contract comment lists the tools (`structuredMemory.ts:344`), and so does the client's
(`structuredMemory.svelte.ts:881`); both change under V4. Slice 3 edits the language files only if a label is
missing, so slices 1 and 3 can be disjoint.

New text: slice 6's Files gain `server/src/routes/structuredMemory.ts` and
`src/ts/process/structuredMemory.svelte.ts`, slice 8's the client file; Order is restated per file and ends "The slices
run serially."

### AUD-7 — Current State: `/projection` also sends summaries in bulk — fixed in plan

Plan, Current State: "No route returns event summaries in bulk except `/package`".

Code: `/projection` answers `hypaV3Data` (`structuredMemory.ts:747`), whose entries are active events' summaries
(`shared/structuredMemory.ts:1154`).

New sentence: "No route gives the tab event summaries by event id in a light, paged form: `/package` sends whole pages
and events, and `/projection` sends HypaV3-shaped summaries of active events for plugins."

### AUD-8 — Slice 7: a re-record's replacement already carries more than marks — fixed in plan

Plan, slice 7: "Its other fields are the new recording's."

Code: `retireRerecorded` carries the trust flags (`reconcile.ts:296`), the old event's thread closes and ended
transitions (`:305`), and moves thread provenance (`:325`).

New sentence: "added to what the retirement already carries (the trust flags, the old event's thread closes and ended
transitions, and the thread provenance), which stays as it is. The remaining fields are the new recording's."

### AUD-9 — Slice 4: the story answer's bound — fixed in plan

Plan, slice 4, first draft: "what it sends of an event is at most `eventSummaryChars` of summary, a `labelChars` story
time, and `pageRefsPerItem` ids".

Code: `restore.ts:32` refuses nothing by `STRUCTURED_MEMORY_LIMITS`, so a restored event can pass those limits; a
round with no row still answers an envelope, and compression is optional (`structuredMemory.ts:200`,
`server/src/http/compressedJson.ts:65`).

New sentence: "what it sends of the records is bounded by the stored bytes it charged, plus the answer's envelope. A
writer's event sends at most …; a restored record may pass those limits … and is sent as stored, not cut."

## Notes for the slice briefs

Not findings; each is in the plan's slice text:

- Slices 6 and 8: a rebuild test's staged set needs an event, since `rebuildChanges` answers null without one
  (`rebuild.ts:312`).
- Slice 8: `create` branches before the `pageId` checks of `parseMemoryPageTool` and `applyPageTool` (`pages.ts:857`,
  `:1183`); the form sends at the contents' revision because `runTool` and `sendChange` need a held page copy
  (`PagesTab.svelte:393`, `:520`), and it shows a refusal itself.
- Slice 7: immediate vector warming uses the writer's draft, not the carried text (`writer.ts:952`, `:982`); keys hold
  the text, so the next retrieval embeds the stored summary. No change is asked.
- D2: the health badge only opens the panel (`DefaultChatScreen.svelte:1186`), so after slice 2 it lands on Pages.
  Sending it to Coverage would be a separate product change.
