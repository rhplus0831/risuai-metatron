# Plan-Runner Audits

Before the plan-runner skill schedules a plan's slices, a read-only Sol session reads the
plan against the code and the orchestrator writes its findings here as
`<plan-basename>-<YYYY-MM-DD>.md`: the plan path, the commit audited, the mode (`full`, or
`shared-files` for the slices' file lists alone), the model, a P1/P2/P3 count table, and the
findings by severity. P1 is a decision that cannot work as written against the code or loses
data; P2 a contradiction inside the plan or a wrong claim that changes a decision; P3 a stale
anchor, wording, or an unacknowledged file overlap; `unverified` is a claim the auditor could
not settle. The plan-runner halts on a P1 that is still `open` (see Dispositions) until the user
revises the plan or chooses to run anyway, and quotes the rest in the affected slice briefs.

A report is a snapshot of the plan at that commit. It stays here when the plan is revised,
runs, or retires; a plan revised after its report gets a new one on its next run.

The folder holds every audit of a plan's text made before the plan was implemented, so it
also keeps the one that predates the skill: the
[2026-11-04 design audit of five plans](plan-design-audit-2026-11-04.md), which this folder's
procedure grew out of. Its summary is that file, and the six reviewer reports behind it are in
the folder beside it. An audit of what a plan left in the code after it finished is in
[finished-plans](../finished-plans/).

Each finding carries an id, its severity, the plan sentence it is about (section named, quoted),
the code it was checked against (`file:line` and what the code does), and a suggested
correction. A claim the auditor could not settle is `unverified`, never P1.

## Reach and class

A severity says whether a decision holds against the code. It does not say whether a user ever gets
there, so a P1 or P2 also carries:

- its **trigger**: the steps from a user action, imported content, or a network request that reach
  it, or "none found" when it follows from reading alone;
- whether the code does this **today** or the plan **introduces** it;
- its **class**:
  - `outcome`: on a path an ordinary user reaches without a coincidence, the plan as written ships
    a wrong result or loses data;
  - `method`: the result the decision promises is right, and the way the plan says to build it is
    wrong against the code (a function that does not do what the plan assumes, a caller the plan
    missed, an order of writes);
  - `edge`: the trigger needs a coincidence (two independent failures at once, an intermediary
    nobody observed, a tab of an earlier build kept open across the upgrade, a clock jump, a
    hand-edited database). It is written with when it occurs, how often, what the user loses, and
    what a fix costs.

Content a user imports from a stranger and requests from the network to a public instance are never
a coincidence. The auditor proposes the class and the orchestrator decides it; a class the
orchestrator changed is recorded with a one-line reason.

A trigger that needs a coincidence and whose fix would be large goes in a short "Noted, not
recommended" list instead of P1 or P2, one line each. A P1 list longer than about six entries is a
sign that hypotheses are being filed as findings, or that one Decision's mechanism costs more than
the plan assumed: the orchestrator then asks whether that Decision should exist before it corrects
its sentences.

## Dispositions

Each finding ends as one of these, and the report says which:

- `fixed in plan`: the plan sentence was corrected, the product's behavior is what the plan
  intended, and the auditor confirmed the correction.
- `narrowed`: the promise was made smaller, or the mechanism was removed or replaced by a cheaper
  one, with the same result for an ordinary user in ordinary use. The report says what the plan no
  longer promises.
- `limitation`: an `edge` finding written in the plan's Limitations section. The plan must not
  introduce a new way to lose stored data this way; the case is today's behavior, or the user keeps
  a way to recover (a reload, a prompt, a visible copy).
- `slice note`: a `method` finding quoted in the brief of each slice it touches.
- `moot`: the sentence it was about is gone.
- `open`: none of the above. An `outcome` P1 that loses data is never closed as a `limitation` or a
  `slice note`.

`narrowed` and `limitation` are the orchestrator's calls that the owner can undo: the plan-runner
lists them in the run's confirmation, and a plan audited outside a run names them in its `Status:`
line.

## Re-check list

Mechanisms an earlier plan got wrong, which every `full` audit checks again whenever the plan
touches jobs, the feed, or the resource store, whatever the plan says about them. The auditor
cites the current `file:line` for each. Add an entry when an audit finds a plan premise a later
plan could repeat; drop one when the code no longer has the mechanism.

- `patchMessage` closes an open generation fence.
- A chat feed change is sized against `MAX_FEED_PATCH_BYTES` in three forms (whole rows with whole metadata, whole
  rows with metadata field changes, row diffs): a row travels whole unless the row-diff form is chosen, and when all
  three are over the cap only the id manifest is sent (`chatFeedChange`).
- `STORE_TABLES_SQL` runs only on a fresh database.
- `sendText` counts a frame handed to any open socket as a delivery; an open socket over its buffer limit is
  terminated and does not count.

The four above are the ones that fooled the 2026-11-04 plans.

`pnpm check:docs` does not measure this folder; `pnpm format:check` does.
