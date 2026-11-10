# Known Issues

Confirmed defects and advertised but unwired behavior, moved here on 2026-11-10 from the `Issues` headings of the focused guides' Known Hazards (95 entries from 25 guides) so they can be worked as one queue, the way [found issues](found-issues.md) was cleared. The guides keep their `Unconfirmed:` claims (reproduction comes first for those), their Limitations, and their Gotchas; a claim that is confirmed moves here. Each entry is one bullet under its owning guide, in the guide's own wording at the move, with its links pointed back at the guide; the Contents list counts each guide's entries. The entries were verified when they were written into the guides, but line numbers and identifiers drift: re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. A defect the owner decides to keep moves back to the guide as a Limitation with the decision. A new confirmed defect goes here, not into the guide.

The eleven entries left after the first two rounds were reviewed with the owner on 2026-11-10: the JWT expiry gap, the
plugin RPC lookup, key events from secret fields, and the plugin listener registry were fixed (and the hub proxy's
answers got sandbox headers, a finding of the review itself); the rest moved to their guides' Limitations with the
owner's decision, except the persistence entry below.

## Contents

- [persistence](#persistence) (1)

## persistence

Guide: [Persistence: Database, Records, Mutation Stores](../structure/persistence.md#known-hazards).

- The remote repair's character read and order write are not atomic: a character another client trashes or deletes
  between them, with no order change, can still be appended at the root. Reproduced on 2026-11-10: once the trash or
  deletion arrives the stale id renders nothing (the sidebar and pins skip absent and trashed characters) and stays
  through selection and idle refresh; the next local add, remove, restore, or reorder (`checkCharOrder`) or the next
  boot repair removes it. Not fixed: hidden order metadata only; the owner has not yet decided to keep it.
