# Job Handoff implementation audit — 2026-11-05

## Scope and result

Reviewed local `dev` at `65e97f91f22418df49452e76e46af7a145b144f1`, also the local
`origin/dev` reference at the start of this audit. The checkout initially had no changes.
The retired plan was read in full using:

```sh
git show fa03c7458bee05f4cd57a19d227380012a028d01^:docs/plan/job-handoff.md
```

The implementation commits are `d60741baf` (server ownership, tickets and offers),
`5ea1222a4` (worker policy and client follows), `c9344075d` (presence and manual handoff),
and `0a9c56d20` (browser verification). This review includes their current integrations,
especially Incremental Chat Transport, and subsequent fixes. The owner taking its own ticket
and missing owner names were fixed in `24b817a55`; neither is reported as an open defect.

Two Luna exploration agents mapped the implementation; four audit agents reviewed the server
registry, callback lanes, client lifecycle, and presence/traffic. Findings were checked against
current source, focused tests, and temporary runtime probes. Coverage includes pending
takeovers, participant authority, queued and delivered callbacks, skipped/missed listeners,
creator viewing, worker selection, reconnects, and checkpoint traffic.

**Four correctness/recovery defects and three performance/resource issues remain in the plan's
scope.** JH3 extends an already recorded defect with a newly reproduced traffic consequence.
Two unrelated performance issues are documented separately. This change adds the report only;
it contains no product fixes or permanent regression tests.

P2 means a concrete correctness, recovery, resource-use, or substantial efficiency issue;
P3 means a narrower optimization. Measurements below are synthetic observations on this host,
not estimates of typical production latency or traffic.

| ID  | Priority | Classification                        | Finding                                                                     |
| --- | -------- | ------------------------------------- | --------------------------------------------------------------------------- |
| JH1 | P2       | Recovery defect                       | A stale targeted offer blocks automatic absent-owner rescue                 |
| JH2 | P2       | Recovery defect                       | One transient HTTP failure suppresses further attempts at an open offer     |
| JH3 | P2       | Known defect with additional impact   | Retaking a lost takeover can repeatedly download the whole chat             |
| JH4 | P2       | Lifecycle defect                      | A former worker reports a running job as ended after reconnecting           |
| JH5 | P2       | Resource-use defect                   | A slow creator-viewer has no outbound queue bound                           |
| JH6 | P2       | Traffic optimization                  | Keeping the creator as a viewer disables compact checkpoints for the worker |
| JH7 | P3       | CPU optimization                      | Early-notice audience partitioning is quadratic                             |
| U1  | P2       | Unrelated, pre-existing CPU issue     | Attaching repeatedly sorts the entire remaining notice queue                |
| U2  | P2       | Unrelated, pre-existing traffic issue | Plugin-provider streams upload the full prefix at every update              |

## Plan-related correctness and recovery findings

### JH1 — A stale targeted offer blocks automatic absent-owner rescue

**Evidence:** [server generation registry](../../../server/src/jobs/generationJobs.ts),
`armOffer`, lines 1023–1029; `reopenOffer`/`expireTicket`, lines 1004–1019; and `takeover`,
lines 2709–2716.

`armOffer` returns whenever `job.offer` already exists. A requested offer has no expiration,
and its target is preserved when a claim ticket expires or a pending takeover drops. If the
chosen worker disappears, subsequently losing the current owner never replaces the targeted
request with an untargeted `absent` offer. Every other worker remains ineligible.

**Reproduction:** with the production registry, resource store, channel hub, and a real
creator WebSocket, attach the creator, request a handoff to B, and let B never claim it.
Disconnect the creator and advance the injected clock by 60 seconds. The snapshot still
contains `reason: "requested", target: B`; healthy worker C gets
`409 handoffUnavailable`. Manually replacing it with an untargeted offer immediately lets C
claim successfully.

This can happen when B closes between appearing in the menu and receiving the offer.
Presence also retains registrations until socket close/error; a frozen tab with a still-open
transport can remain selectable. The ten-second reminder is only a toast and does not release
the target. A failed manual handoff therefore disables the automatic rescue the user expected,
and subsequent callbacks can expire despite a healthy worker being available.

**Suggested correction:** define an absence fallback for an unclaimed targeted request.
Once the owner has been absent for the normal offer delay, expire or replace that request
with an `absent` offer. Handle already reserved tickets and pending takeovers explicitly rather
than invalidating them accidentally. Add the attached-owner → requested target → owner close
→ different-worker claim sequence to `server/src/tests/generationJobs.test.ts`.

### JH2 — One transient HTTP failure suppresses further attempts at an open offer

**Evidence:** [handoff policy](../../../src/ts/network/handoff.ts), `evaluateOffers`, lines
208–220, and `takeOffer`, lines 225–259; [client generation transport](../../../src/ts/network/generationJobs.ts),
`readChatGeneration`, lines 673–701, and `takeoverGenerationJob`, lines 769–790.

An offer is marked evaluated before its asynchronous ownership lookup and claim. An exception
is only logged; the evaluation marker remains. The finalizer retries only if the offer object
or acceptance revision changed. A temporary failure of `/current`, or a takeover failure that
never reserved a ticket, can therefore leave an eligible offer open but permanently ignored
by this worker while its live-update connection remains healthy. Unrelated feed traffic does
not make it retry.

**Reproduction:** execute the production `handoff.ts` module with real Svelte stores and
stubbed network/plugin boundaries. Deliver a self-targeted offer and reject its first
`readChatGeneration` with a temporary HTTP 503. Restore HTTP success, then deliver an unrelated
offer. Results: one lookup, zero claims, original offer still open. Changing acceptance to
enabled advances the revision and produces the second lookup and first successful claim.

This is distinct from a lost claim response after the server reserved a ticket: ticket expiry
can republish that offer. It also does not affect the intended 404/409 drop behavior. The
failure here occurs before any server-side state change produces a new offer.

**Suggested correction:** distinguish transient failure from evaluated ineligibility and
terminal refusal. Retry transient failures with bounded backoff while the same offer, epoch,
and eligibility remain current; cancel retries on offer closure. Cover recovery without a
WebSocket reconnect or preference toggle in `src/ts/network/handoff.test.ts`.

### JH3 — Retaking a lost takeover can repeatedly download the whole chat

**Evidence:** [follow lifecycle](../../../src/ts/process/serverCommands.ts), lines 418–420;
[client generation transport](../../../src/ts/network/generationJobs.ts), lines 1371–1377 and
1316–1317; [chat store](../../../src/ts/storage/chatStore.svelte.ts), lines 1969–1970,
2033–2034, 2071–2075, and 2675–2685.

Losing a pending takeover calls `releaseGenerationJob`, which calls `endServerJob` and adds
the hydrated generation IDs to `retiredGenerations`. Retaking the same still-running job
cannot rebuild its stream buffer: `accepted` is refused and subsequent chunks are silently
dropped. The [existing inbox entry](../../research/found-issues.md#a-retaken-handoff-job-drops-its-live-stream)
records this as a worker display limitation.

Current Incremental Chat Transport makes the impact larger. A compact `streamed` checkpoint
requires that buffer; the retired generation makes it fail, so the client requests the whole
chat. Installing that whole answer does not remove the retirement, and the next compact
checkpoint repeats the download.

**Reproduction:** use the real chat store, resource sync, generation-event handling, and the
existing `StoreBackedServer` fixture. Hydrate a pending follow, release it before ownership,
then reattach to the same generation with a whole chat and `accepted`. Apply three successive
`streamed` checkpoints, installing a valid whole-chat answer after each. The probe observed
**three `resync` requests for three checkpoints**; live chunks remained ignored.

**Condition:** the retaking worker is the only attached socket, as when the creator phone and
the old owner have closed. The server disables compact rows while any viewer remains
([registry](../../../server/src/jobs/generationJobs.ts), lines 1255–1260), so this particular
resync loop does not occur with a stable attached viewer. At the normal checkpoint cadence,
the lone worker can repeatedly download the complete history instead of only reply updates.

**Suggested correction:** distinguish temporary detach from terminal generation retirement.
Invalidate obsolete transport events without permanently refusing a generation that this tab
may legitimately retake. A regression should verify both resumed chunks and acceptance of
subsequent compact checkpoints after a lost pending takeover.

### JH4 — A former worker reports a running job as ended after reconnecting

**Evidence:** [follow lifecycle](../../../src/ts/process/serverCommands.ts), lines 188–190,
442–466, 605–607, and 863–866; [registry participant/status checks](../../../server/src/jobs/generationJobs.ts),
lines 2205–2207 and 2807–2813.

Worker B takes creator A's job; A then takes it back. B's existing socket becomes a viewer,
but B is no longer a participant and correctly cannot read status. When that viewer socket
closes, including during a routine visibility-resume reconnect, its status lookup returns
404/null. The client interprets this as the job being gone. `everOwner` is still true, so it
does not take the silent exit used for a worker that never acquired ownership.

**Reproduction:** run production `serverCommands` with the existing transport/I/O fixture:
ticket follow → `owner: "self"` → `owner: "other"` → visibility-resume reconnect → null
status. The follow returns `"lost"`, marks the job lost, refreshes the whole chat once, emits
a gone diagnostic, and shows `serverJob.endedAway`, although A's job is still running.

The server's authorization rule is correct. The client has confused loss of participation
with loss of the job, producing a misleading recovery notice and unnecessary traffic.

**Suggested correction:** give a noncreator viewer a normal detach outcome when it loses
participant access. Preserve the foreign-job state and avoid lost-job recovery and terminal
notifications. If the latest role is uncertain, consult the chat's `/current` view. Add the
owner → viewer → reconnect transition to `src/ts/process/serverCommands.test.ts`.

## Plan-related performance and resource findings

### JH5 — A slow creator-viewer has no outbound queue bound

**Evidence:** [server generation registry](../../../server/src/jobs/generationJobs.ts),
`sendSocket`, lines 926–930; `switchOwner`, lines 1089–1093; and `expireSilentOwners`,
lines 851–859.

Demoting the creator cancels its owner-silence timer. Viewers deliberately do not count toward
owner presence, but job sends also have no `bufferedAmount` admission limit. A viewer whose
transport stops consuming data can therefore retain subsequent resource, chat, chunk, and ping
frames in server memory while the worker continues normally. A paused JavaScript tab alone
does not necessarily stall TCP; the problematic condition is a slow or stalled transport.

**Reproduction:** use real WebSockets and the production registry, transfer ownership, and
pause the creator's TCP reads. Send 80 ordinary 256 KiB resource frames while the worker keeps
reading. Of the 20 MiB synthetic load, **17,318,004 bytes (16.5 MiB) remained queued on the open viewer**;
the worker's queue was zero. Advance the injected clock to 60 seconds, keeping the worker
fresh at 44 seconds: the viewer remains open with the same queue.

The send helper's lack of backpressure predates this use, but handoff introduces viewers that
are exempt from the owner's silence cleanup and can remain for the rest of the job. Multiple
slow viewers compound the retained data. The live-update feed already bounds queued data at
4 MiB ([events route](../../../server/src/routes/events.ts), lines 87–98).

**Suggested correction:** add per-socket queued-byte admission to generation sockets and
terminate a lagging viewer independently of owner absence. Existing reconnect/hydration can
recover that viewer. Check that disconnecting a saturated viewer leaves worker delivery and
callback authority intact. This bounds memory; it does not require viewers to affect ownership.

### JH6 — Keeping the creator as a viewer disables compact checkpoints for the worker

**Evidence:** [server generation registry](../../../server/src/jobs/generationJobs.ts),
`chatPatchEvent`, lines 1254–1261, and `deliverJobChat`, lines 1323–1329;
[existing test](../../../server/src/tests/generationJobs.test.ts), lines 1990–2020.

Every socket receives one shared wire event. As soon as any viewer exists, the server sends
complete changed message rows to the worker as well, even when the worker negotiated
`rows=streamed` and already received all chunks. The normal creator-keeps-watching handoff
therefore disables the compact checkpoint optimization on the worker. This is currently
intentional and tested behavior, not a correctness regression.

**Measurement:** production registry, real SQLite checkpoint writes and loopback sockets;
20 raw checkpoints, with ASCII reply lengths growing from 4,096 to 81,920 bytes in 4 KiB
increments. Both sockets negotiated patch hydration and streamed rows.

| Worker checkpoint delivery      | Bytes across 20 checkpoints | Compact stream references |
| ------------------------------- | --------------------------: | ------------------------: |
| Creator also attached as viewer |                     867,216 |                         0 |
| No viewer attached              |                       7,100 |                        20 |

Viewer presence added **860,116 worker bytes**, a **122.14×** increase in this fixture.
The creator also received the 20 chunks and the 20 full checkpoint frames; total checkpoint
payload across the two sockets was 1,734,432 bytes. These counts exclude WebSocket headers,
initial hydration, feed traffic, and provider traffic.

For steadily growing replies, resending the complete prefix at every checkpoint makes payload
grow with checkpoint count × average reply length. The historical plan's interaction with
Incremental Chat Transport explicitly anticipated compact owner rows and full viewer rows.

**Suggested correction:** keep one semantic `sentChat` baseline, but serialize separate owner
and viewer projections. A capable owner can receive stream references while viewers retain
safe full rows. Do not merely enable references for viewers without proving their stream
baseline. Compare serialized bytes in a deterministic regression fixture.

### JH7 — Early-notice audience partitioning is quadratic

**Evidence:** [channel hub](../../../server/src/jobs/channel.ts), `takeEarly`, lines 746–752;
the audience partition was introduced by `d60741baf`.

The function first builds `taken`, then filters every original entry with
`!taken.includes(entry)`. Draining a large audience takes quadratic reference comparisons.
The 1 MiB early-notice cap bounds bytes, but permits many short legitimate notices.

**Measurement:** invoke the production channel with 10,000 buffered
`alertNormal` notices carrying `{ message: "x" }`. The retained serialized payload was
760,000 bytes, below the cap. On three runs, partitioning alone took **25–27 ms**.
These are valid emitted notice types, and the trigger effect ceiling is 100,000
([trigger runner](../../../server/src/prompt/triggers.ts), line 103). This is a large-backlog
optimization, not a claim that ordinary handoffs incur that cost.

**Suggested correction:** partition into taken/remaining arrays and accumulate their byte
counts in one pass. This is separate from the much larger pre-existing queue-drain cost in U1.

## Unrelated findings retained from the audit

### U1 — Attaching repeatedly sorts the entire remaining notice queue

**Priority:** P2. **Relationship:** pre-existing callback-channel inefficiency; handoff uses
the same attach path but did not introduce the repeated-sort loop.

**Evidence:** [channel hub](../../../server/src/jobs/channel.ts), `handleAttach`, lines
930–932. Each iteration sorts all remaining sends, removes one with `shift()`, then repeats.
Even an already ordered notice backlog therefore performs quadratic aggregate work on the
Node serving thread.

**Measurement:** the same valid short-notice fixture as JH7, a fresh production channel per
run, an initially absent owner, and a no-op transport when `handleAttach(["owner"])` drains
it. All notices were retained and delivered. Draining 5,000 took **310–371 ms**; draining
10,000 took **1.33–1.54 seconds**. This excludes socket I/O and is enough synchronous work to
delay unrelated requests and job callbacks. These totals include JH7's audience partition;
the repeated queue sorting dominates. Timings vary under shared-host load; the queue
structure, rather than a particular millisecond threshold, establishes the issue.

**Suggested correction:** use an ordered queue/min-heap, or sort once and consume with a
cursor while correctly inserting newly promoted requests. Preserve the ordering guarantee:
callbacks can be promoted during delivery and must interleave by their original order.
Combine this with JH7's linear audience partition.

### U2 — Plugin-provider streams upload the full prefix at every update

**Priority:** P2 optimization. **Relationship:** pre-existing plugin-provider callback protocol;
handoff changes which tab runs it, not its cumulative-text wire format.

**Evidence:** [client channel](../../../src/ts/network/jobChannel.ts), lines 1030–1042 and
1058–1094; [shared callback contract](../../../shared/jobs.ts), lines 685–691;
[server channel](../../../server/src/jobs/channel.ts), lines 857–872;
[provider stream adapter](../../../server/src/llm/requests.ts), lines 835–888.

The tab appends provider bytes to `fullText` and sends the entire accumulated string. Regular
updates are throttled to 50 ms; the initial snapshot and final flush are immediate. The server
receives each complete prefix and passes it to `onChunk`. The adapter
coalesces snapshots for a slow downstream consumer, but that happens after the prefixes have
crossed the socket. The 4 Mi-character limit bounds the final text, not total transmitted bytes.
This applies to tab plugin-provider callbacks, not ordinary server-owned provider requests.

**Calculated example, not a measured provider run:** a stream that adds 64 ASCII characters
per transmitted update for 1,200 updates produces 76,800 bytes of final text (75 KiB).
The cumulative text fields alone total
`64 × 1,200 × 1,201 / 2 = 46,118,400` bytes, about **44 MiB** or **600.5×** the final text.
At the configured maximum cadence, that fits roughly one minute. JSON/frame overhead and
provider-to-tab traffic are additional; batching or a slower update cadence reduces the ratio.

**Suggested correction:** negotiate sequenced append deltas for this direction too, and
reconstruct the cumulative string on the server before the existing `onChunk` boundary.
Retain a snapshot/resynchronization path and the accumulated-size cap. Add a deterministic
serialized-byte assertion rather than a timing-sensitive throughput test.

## Verification and limits

- The plan's focused unit/integration selection passed: **465 tests in 13 files**. The wrapper
  reported 13.6 seconds. Selection: server `generationJobs`, `generations`, `jobChannel`,
  `events`, `promptTail`, and `llmRoutes`; client `handoff`, `eventFeed`, `generationJobs`,
  `jobChannel`, `serverCommands`, and `chatStatus`; and `HandoffControls.svelte.test.ts`.
  Command: `pnpm --silent test:agent` followed by those file paths.
- Two additional temporary client probes reproduced JH3 and JH4, each passing through
  `pnpm --silent test:agent --force --no-rerun`. They assert the problematic current behavior,
  not the desired corrected behavior. Their temporary repository files were removed.
- Native Node probes exercised production registry/store/channel modules for JH1, JH5, JH6,
  JH7, and U1. JH2 executed the production TypeScript module after type transpilation with
  real stores and controlled I/O. No remote provider was contacted for these probes.
- `util/playwright/offline.sh node util/playwright/checkJobHandoff.mjs` passed **10/10
  browser cases** and its egress check, in 334.62 seconds. Cases included the creator closed
  or watching, preferred/manual handoff, a hidden worker, creator take-back after worker loss,
  pending output hooks, a lost body interceptor, a missed listener, and late listener replay.
  The short hidden-worker case measured a 22 ms socket-to-answer interval.
- `pnpm check:changed` completed, with both type-check programs explicitly skipped because
  the changed paths did not reach them. This is not a fresh full type-check result.
- The full `pnpm --silent test:agent` gate passed: **9,191 passed, 66 skipped, 577 files**,
  in 80.8 seconds after waiting for the shared suite lock. Slow-tagged tests were not included.
- The report passed targeted Prettier checking. The final shared-checkout `pnpm check:docs`
  run failed after concurrent archival of older reports: unresolved links in
  `docs/structure/chat-store.md:277` and `docs/structure/ui-theming.md:306`, plus a guide-tree
  budget of 825,009 bytes against 825,000. An earlier documentation check passed before
  those archive edits. These concurrent reports, moves, and guide edits were left untouched;
  product source and the reviewed commit remained unchanged.

No phone hardware, Safari/Firefox, or PC hidden for over five minutes was tested. A short
headless hidden-worker run cannot settle the plan's real-device throttling questions.

The following remain explicit design limitations, not new audit defects: a preferred offer
does not gate the first callback; an already delivered callback is never rerun on another
device; cancellation cannot prevent all writes by an already running plugin hook; the old
lane's drain hold does not serialize that hook against the new owner's lane; and the
absence cascade can end a queued root before the advertised first-undelivered-callback
budget. The plan and current [server-generation limitations](../../structure/server-generation.md#limitations)
already record these decisions. The audit did not reproduce a new lane-transfer,
participant-authorization, or skipped/missed-list projection defect.
