# Bounded Resource Writes Plan audit, 2026-11-24

- Plan: `docs/plan/bounded-resource-writes.md`
- Commit audited: `9cdbb289c`, with the plan read from the working tree before its first commit (turns 1 and 2), and
  `036c8689a` (turn 3 and the final judgment). The final plan is committed with this report
- Mode: `full`
- Model: GPT-6.2-Astra (`xhigh`), read-only, in place of the procedure's Sol because slice 2 changes `server/` routes and
  the resource store; final judgment by Claude Fable, read-only; report written by the session that drafted the plan
  (Claude Opus 5.5), before any plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 19    |
| P2         | 11    |
| P3         | 8     |
| unverified | 0     |

The first turn filed A1 to A17 against the draft (9 P1, 5 P2, 3 P3). The second turn read the corrections, confirmed
twelve, disputed A1, A4, A8, A9, and A15, and filed A18 to A29 against the corrections themselves (4 P1, 5 P2, 3 P3).
At the owner's request a third, narrow turn read only the corrections after the second: it confirmed seven, disputed
A18, A21, and A24, and filed A30 to A38 (6 P1, 1 P2, 2 P3), four of the P1 again about the writer fence. The owner then
asked Claude Fable to judge the whole history and to close the audit unless the final result, not only the
implementation method, had to change; its judgment is in "Final judgment" below, and the plan was revised to it. The
fence-related findings (A1 to A4, A10, A14, A18, A24, A28, A30, A31, A33, A36) are moot since the fence is withdrawn;
the entries below keep their first disposition for the record. Astra ran no test suite; it ran in-memory probes against
the real resource store. The three turns took about 40 minutes and 17 M tokens. `read_only_violation` was `false` after
every turn.

The plan rests on a contract pre-audit by Astra earlier the same day (every batch unit against seven delivery
timelines, findings F1 to F6 with failing probes), kept outside the repository with the review reports on this machine;
the plan's `Status:` line names its folder.

## P1

- **A1** (`fixed in plan`, by A18's correction). Decisions, D1/D4: "Every save-loop request names its writer and
  attempt", with D4 raising a whole adopted writer's fence. A writer-wide fence refuses an old batch whose units only
  that page held (record kinds the journal excludes, `journalEligibility.ts:18`; credential plaintext,
  `llmSecrets.svelte.ts:75`). Corrected: no fence across page lifetimes (D4), and a request refuses only the attempts
  it names after carrying their work (D2).
- **A2** (`fixed in plan`). D4's adoption raise could finish without any batch carrying it (`journalRecovery.ts:142`,
  the empty-batch refusal at `resources.ts:375`) and was lost across an early reload (`draftJournal.ts:1492`).
  Corrected by dropping adoption fencing (D4).
- **A3** (`fixed in plan`). D1's `Date.now()` counter is not a high-water mark for another page: one cycle dispatches
  several requests (`resourceSync.svelte.ts:3123`, `:3394`), and an adopter can start before the page it adopts.
  Corrected: a writer id per page and a counter from 1.
- **A4** (`fixed in plan`). D3 read a live `superseded` answer as "nothing was applied", wrong for a proxy duplicate
  whose first delivery committed; the generic 409 parsing (`resourceClient.ts:177`) would also catch it first.
  Corrected: decoded before conflict parsing and read as a lost answer (D3); proxy duplicates are a Limitation (A19).
- **A5** (`fixed in plan`). D8's restored-page timer requeued keepalive work while the unfenced original could still
  arrive (`chatStore.svelte.ts:3605`, `resourceClient.ts:515`), reopening F3. Corrected: D8 keeps keepalives as today.
- **A6** (`fixed in plan`). D6 moved a timed-out unit behind independent work, but sibling chat creates carry
  insertion indices computed in order (`chatStore.svelte.ts:5969`, applied at `chatStore.ts:2430`). Corrected: no unit
  is moved out of its planned order.
- **A7** (`fixed in plan`). D7's "the key is stored once" is false: a same-value retry on the fresh base advances the
  revision again (`resourceStore.ts:2780`). Corrected wording, the stored value is what slice 3 tests, and the
  cross-device case follows today's 409 retry.
- **A8** (`limitation`, with A22). One unit whose attempts all time out still holds the work after it, including a
  second credential path (`resourceSync.svelte.ts:3245`, `:3436`). The Goal now promises a bounded wait per attempt,
  not eventual delivery of later work.
- **A9** (`fixed in plan`, with A21). Wrapping the callers' flushes in `waitForResourceFlush` abandoned new-chat memory
  inheritance or restore and reroll restoration after 30 s while a healthy save continued
  (`chatMemoryInherit.svelte.ts:45`, `rerollHistory.ts:251`). Corrected: the flushes are not wrapped (D11).
- **A18** (`fixed in plan`). The corrected Current State claimed every unit of an abandoned batch is resent by a later
  attempt of the same page; record deletes stop on a same-id re-add (`resourceSync.svelte.ts:2896`), feed echoes and
  conflict reads settle units without a resend, and credential sets wait behind every resource batch. With the
  high-water fence, an unrelated batch could refuse an abandoned credential PUT that the page then closed before
  resending. Corrected: Current State describes what each unit does, and D2 refuses only attempts a later request
  names after carrying all their still-wanted units (D6 retries an abandoned batch whole).
- **A19** (`limitation`). Admitting an equal attempt lets a proxy's duplicate apply after a permanent delete
  (`chatStore.ts:142`, `:2330`), and a duplicate's 409 read by the page can merge newer work under a committed group id
  (`chatStore.svelte.ts:6888`). Both need a proxy that delivers one request twice, which today's code does not guard
  either; the plan states this as a Limitation and a Not goal.
- **A20** (`fixed in plan`). D9's replay of a kept sent vector fails the server's permutation check after a sibling
  create (`chatStore.ts:3526`). Corrected: the kept vector only decides whether a discard is reported; a newer order is
  sent on the learned revision with a vector from current membership.
- **A21** (`fixed in plan`). A deadline elsewhere in the same flush still made `createSettled` skip memory inheritance
  and `syncRerolledChat` skip its refresh (`resourceSync.svelte.ts:5980`). Corrected: `createSettled` waits while the
  chat has unacknowledged work and lets the route's `chatGone` decide; `syncRerolledChat` refreshes even when the flush
  rejects (D11).

## P2

- **A10** (`fixed in plan`). D2 said a restore replaces the new table; `replaceAll` copies named tables only
  (`resourceStore.ts:3401`), and existing databases skip `STORE_TABLES_SQL` (`:4038`). Corrected: created on every
  open, cleared inside `replaceAll`.
- **A11** (`fixed in plan`). Slice 4's "the small edit saves before it" cannot happen with a single-flight loop
  (`resourceSync.svelte.ts:3020`), and F5's probe hard-codes the rejected formula. Corrected test timelines.
- **A12** (`fixed in plan`). A keepalive timer would have to settle the transport bookkeeping exactly once
  (`resourceSync.svelte.ts:6153`); moot after D8's withdrawal.
- **A13** (`fixed in plan`). The "signing key fetch" is local IndexedDB and WebCrypto work (`serverAuth.ts:19`), and
  `/api/crypto` hashes the password. D11 now bounds the local steps and all four routes and keeps an expired check from
  installing state.
- **A14** (`fixed in plan`). The store-backed harness calls the store directly (`storeBackedServer.ts:754`, `:434`), so
  route-only admission would go untested. Slice 2 makes the harness call the production admission function.
- **A22** (`limitation`). A server that receives every byte and never answers blocks the work planned after that unit
  on every retry. Goal and Limitations reworded.
- **A23** (`limitation`). Protection starts only when the naming request passes admission; before that an abandoned
  parent delete can still apply after a local re-add (`resourceStore.ts:1931`, `resourceSync.svelte.ts:4589`).
- **A24** (`fixed in plan`). The revised D1 dropped the header validity rules. D2 now specifies legacy admission
  without headers and a 400 before any write for a malformed pair or list.
- **A25** (`fixed in plan`). D10's "until the next acknowledged cycle" ignores a commit confirmed by a feed echo with no
  later write (`resourceSync.svelte.ts:5117`). The state now clears when the doubt settles by any means.
- **A26** (`fixed in plan`). Projecting the kept order into the journal's `sent` layer turns an automatic boot replay
  into a recovery draft (`journalRecovery.ts:610`). D9 keeps the vector in memory only.

## P3

- **A15** (`fixed in plan`, with A27). The shared-file list was incomplete; the Slices introduction now lists every
  file two slices edit, and slice 6 uses its own auth constant.
- **A16** (`fixed in plan`). "Outside this plan" said none of those waits affects saving; a restore's maintenance gate
  and login's key registration can. Reworded.
- **A17** (`fixed in plan`). "A broken JSON answer takes the lost-answer path" holds only for a successful status
  (`resourceClient.ts:167`, `:195`). Reworded; D5 classifies a deadline abort in either body read.
- **A27** (`fixed in plan`). The dispatch moment D10 needs is visible only inside `resourceClient.send`
  (`serverAuth.ts:209`); `saving.state` turns on before signing. Slice 4 adds a dispatch notification, slice 5 uses it.
- **A28** (`fixed in plan`). The harness checks the epoch before its delay hooks (`storeBackedServer.ts:713`); slice 2
  moves the epoch check and admission after them and tests a held old-epoch request after a restore.
- **A29** (`fixed in plan`). The plan linked this report before it existed; it is committed with the plan.

## Noted, not recommended

- A clock step back together with a lost request (first turn): moot with a per-page counter.
- A request past authentication held across the 30-day pruning interval and a server restart.
- A hand-edited journal tab id, and two pages minting the same random writer id.

## Turn 3

- **A30** (P1, moot). A withdrawn parent delete (a same-id re-add stops its resend) is never named, so F6 stays open
  under the fence (`resourceSync.svelte.ts:2896`, `resourceStore.ts:1931`).
- **A31** (P1, moot; slice 4 note). The collector holds a reorder behind its in-doubt create
  (`chatStore.svelte.ts:6039`), so a whole retry cannot carry both.
- **A32** (P1, `fixed in plan`). D6's "place of the earliest" sent a rebuilt reorder before its new sibling create;
  the store rejects the vector (`chatStore.ts:3526`). D6 no longer regroups units.
- **A33** (P1, moot). The 16-name limit had no correct overflow rule.
- **A34** (P1, `fixed in plan`). `createSettled`'s wait was bound to a request allowance, not to the target create.
  D11 now lets `flushResources` continue through lost answers within its 10-attempt budget instead.
- **A35** (P1, `fixed in plan`). A refresh after a rejected flush reads nothing while the target has pending work, and
  the removed reroll replies were released. Resolved the same way as A34.
- **A36** (P2, moot). The legacy and malformed-header branches overlapped.
- **A37** (P3, `fixed in plan`). Current State said no request carries an abandoned batch's units together; the
  sentence is gone.
- **A38** (P3, `fixed in plan`). Slice 4's packing assertion contradicted the 8 MiB singleton; reworded.
- Noted, not recommended: the 13-byte `retry` flag can push a singleton at the hard cap over it on replay; carrying all
  units does not guarantee they commit.

## Final judgment

Claude Fable (read-only, with probes against the real `@hono/node-server` 2.1.5 adapter on Node 24, kept outside the
repository) judged the pre-audit's delivery model over-protective. A request whose body is incomplete when its client
leaves is refused by the body read; a complete one is applied within milliseconds of arrival, since the only awaits
before the synchronous apply are the auth check's WebCrypto calls and the body read; a stalled server handles an
original and its resends together on resume, in the order receipts and base revisions already cover. F1, F3, and F6
therefore need a transport or intermediary that holds a complete request after its client left, which the probes
produced by hand. F2, F4, and F5 are real.

Of the open findings it classed one as changing the shipped result (A32, created by the fence's whole-retry rule),
the header and naming points as implementation method, and the rest as edge cases. It rejected a server-side check of
the client connection at admission: the adapter aborts the request signal only when the response closes, a graceful
client close leaves it unaborted with the body readable, and where it fired the body read had already failed. It
recommended withdrawing the fence (D1 to D4, D6's whole retry, slice 2), stating late delivery as one Limitation,
letting `flushResources` continue through lost answers within its budget, and closing with slice notes. The plan
follows that recommendation; the owner can restore a narrower fence (naming only when the existing planner's batch
already carries every still-wanted unit) if the Goal's late-delivery guarantee is wanted back.
