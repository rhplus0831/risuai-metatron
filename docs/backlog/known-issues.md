# Known Issues

Confirmed defects and advertised but unwired behavior, moved here on 2026-11-10 from the `Issues` headings of the focused guides' Known Hazards (95 entries from 25 guides) so they can be worked as one queue, the way [found issues](found-issues.md) was cleared. The guides keep their `Unconfirmed:` claims (reproduction comes first for those), their Limitations, and their Gotchas; a claim that is confirmed moves here. Each entry is one bullet under its owning guide, in the guide's own wording at the move, with its links pointed back at the guide; the Contents list counts each guide's entries. The entries were verified when they were written into the guides, but line numbers and identifiers drift: re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. A defect the owner decides to keep moves back to the guide as a Limitation with the decision. A new confirmed defect goes here, not into the guide.

The eleven entries left after the first two rounds were reviewed with the owner on 2026-11-10: the JWT expiry gap, the
plugin RPC lookup, key events from secret fields, and the plugin listener registry were fixed (and the hub proxy's
answers got sandbox headers, a finding of the review itself); the rest moved to their guides' Limitations with the
owner's decision, except the persistence entry below.

## Contents

- [persistence](#persistence) (1)
- [structured-memory](#structured-memory) (1)

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
    `keyLines` unguarded. The server has never written such an event. Run on 2026-11-14 in a running server with a
    browser (wide review, cut X2, and a second run), 37 crafted events through `tx.restoreMemory`: all were admitted,
    all 259 read rounds answered 200, and the panel's Timeline, Story, and Coverage rendered. Sends in the chat
    failed during assembly, before any provider call, for a missing, null, or wrongly typed `summary`, `knowledge`,
    or `sources`, and for `keyLines` or `participants` of the wrong type (16 of 36 cases); `stateChanges`,
    `relationshipShifts`, `openThreads`, and `storyTime` sent in every case. The failing readers are
    `coveredMessages` (`shared/structuredMemory.ts:1461`) and `prepareRetrieval`, `knownFacts`, and `rankEvents` in
    `retrieve.ts`. The chat sends again with memory off; a missing `summary` is harmless while the event is recent
    or retracted, and missing `sources` fails even when retracted. Cheapest fix: refuse wrong field types in the
    common restore validator and normalize an already stored event before prompt selection. The package export has
    no caller in the product.

  Not fixed: the byte charge, since measuring costs every round; the owner has not said whether it is a Limitation.
