# Job Protocol audit — 2026-10-29

## Scope and result

Reviewed the completed Job Protocol plan against
`4a95f84bf41b83e0d08164043cbe33810dcc0918`. The final plan can be retrieved with:

```sh
git show 73c12d29c:docs/plan/job-protocol.md
```

The [archive](../archived-plan/README.md) identifies the implementation commits:
`d0b6c096c` (receipts), `b532a95e2` (request identity and cancellation), `fdf7a1235`
(composer request identity), `d4586f152` (command sequences), `31dd5c2f0` (owner liveness),
`2864a806e` (Stop from another client), and `0fb58b456` (browser verification).
The review includes their integrated state after merge `a15eaa2c4`.

Coverage: admission and replay ordering; receipt retention, restart and degraded operation;
request cancellation and draft settlement; sequence writes, progress and terminal handling;
callback deadlines and socket ownership; cross-client Stop; and client follow/recovery paths.
Luna exploration agents located the plan and implementation. The primary agent reviewed the
code and performed the probes below.

**Two new product defects were reproduced in the plan's changes. A previously recorded
absence-bound gap and a browser-driver timing problem are also documented. Two unrelated
issues appear in their own section.** No product fixes or permanent test changes are included.

The working tree already contained draft-recovery changes in storage modules, locales, tests,
diagnostics and guides. Those files were left untouched. Verification ran against that working
tree, so the gate results are not a certification of a clean checkout of the reviewed commit.
The findings below use protocol code unchanged by those local edits.

P2 denotes a correctness or recovery defect worth fixing; P3 denotes a narrower verification
or maintenance problem. No finding implies a separate-user authorization bypass: the server
uses a shared principal.

| ID  | Priority | Relationship                           | Finding                                                                                     |
| --- | -------- | -------------------------------------- | ------------------------------------------------------------------------------------------- |
| JP1 | P2       | Introduced by request-identity changes | A retry's transient refusal can discard identity while the original POST can still admit    |
| JP2 | P2       | Introduced by cross-client Stop        | A stalled lookup or stop leaves the chat's Stop operation permanently pending in the page   |
| JP3 | P3       | Known residual plan gap, reproduced    | A newer queued job can outlive the stated owner-absence bound                               |
| JP4 | P3       | Browser verification added by the plan | A global four-second absence override can kill the reload case itself                       |
| U1  | P2       | Pre-existing; outside the plan         | A same-origin window opened with an opener inherits the supposed per-tab job owner identity |
| U2  | P3       | Pre-existing; previously recorded      | An unused resume helper and its documentation describe the wrong boot path                  |

**Resolution (2026-10-29).** All six are fixed, each with regression tests except JP4 (a browser
driver, rerun instead): JP1 in `9bfd29b73`, JP2 in `035a76416`, U1 in `0afb40afe`, U2 in
`32bb411d2`, JP3 in `df393fcc0`, and JP4 in `72b221a26`. JP1 also keeps uncertainty for
`chatBusy`, `chatBindingIncomplete` and `chatLoreOverrideOrphaned`, which a later probe showed
the delayed original can pass as well. JP3 was fixed rather than scoped: a queued root now
expires at its own job's absence deadline. The inbox's second absence-bound path (a provider
disconnect ended through `endWith`, not bounded by the abort grace) remains unreproduced and is
an `Unconfirmed` issue in the [self-host server guide](../structure/self-host-server.md#issues).
U1 uses a synchronous live-page claim in `sessionStorage`, not a coordinated lease, because
`generationClientId` is read synchronously; its accepted gaps are in the
[global API guide](../structure/global-api.md#limitations).

## Plan-related findings

### JP1 — A negative lookup does not settle an earlier POST that has not reached admission

**Code.** [Client generationJobs.ts](../../src/ts/network/generationJobs.ts),
`registryRefusal`, `exchange` and `createGenerationJob`;
[serverCommands.ts](../../src/ts/process/serverCommands.ts), `runPinnedServerJob`'s create-error
handling; [sendDraft.ts](../../src/ts/process/sendDraft.ts), `settle` and `idsFor`;
[server generations.ts](../../server/src/routes/generations.ts), the POST handler;
[server generationJobs.ts](../../server/src/jobs/generationJobs.ts), `create`.

**Confirmed behavior.** After an unanswered POST, `exchange` preserves uncertainty for generic
errors, but treats recognized registry refusals as definite. This includes the registry's
503 `The server is not accepting generations now`. `runPinnedServerJob` then reports
`requestUncertain: false`, and settlement drops the draft's request ID.

The server only looks up identities already admitted or cancelled. A refusal installs no
identity or tombstone. Another copy of the POST can still be awaiting authentication, request
processing or delivery before `jobs.create`. A negative lookup in the retry says nothing about
that earlier copy's future admission. The POST handler has asynchronous work before admission
and does not fence a request whose client stopped waiting.

**Reproduction.** Two temporary probes adapted the existing client transport and server
receipt/HTTP harnesses:

1. Leave the client's first POST unanswered. Advance fake time through its 10-second deadline
   and one-second retry delay. Return the exact registry maintenance refusal to the retry.
2. Observe a plain `ResourceRequestError`, status 503, with no `uncertain` flag, after two
   attempts. An assertion requiring uncertainty fails.
3. Separately, hold an original HTTP request in middleware before admission. During a real
   `snapshots.withMaintenance` interval, submit the identical retry: it receives that 503.
4. Finish maintenance without changing the epoch and release the original request. It admits
   successfully and its controlled runner appends a reply.
5. Submit a fresh request ID at the current revision, as the next explicit Send does after
   definite settlement. A second job runs and appends a second reply.

Observed server result:

```text
retry: 503 "The server is not accepting generations now"
delayed original: new job A
next explicit send: new job B
runner invocations: 2
stored replies: ["reply 1", "reply 2"]
```

Both expected-correctness assertions failed again when their files ran alone. The server probe
uses real routing, admission, maintenance and SQLite with a controlled runner. It deliberately
models a request still pending on the server after the browser stops waiting; it is not a
measurement of how often a particular proxy or network produces that ordering.
The unchanged-epoch condition matters: for example, maintenance can fail before replacing the
store. A completed restore that changes the epoch would instead reject the old POST with 412.

**Impact.** A restored composer can lose its deduplication identity before the original action
runs. Retrying it after that job ends can generate another reply, even though the user intended
to recover the unanswered send. Input-message deduplication only prevents another user-message
append; it does not prevent another generation. A job can also start after the UI reported a
definite refusal.

**Suggested fix.** Keep the request uncertain across a negative lookup unless the server also
fences all late creates for that identity. Success/replay and an explicit cancellation tombstone
provide such evidence; a transient admission refusal alone does not. Add an overlapping-request
test where the first request reaches admission after the retry's refusal, preserving the
existing same-ID replay and explicit-cancellation semantics.

### JP2 — The new Stop exchange has no deadline and prevents another attempt

**Code.** [Client generationJobs.ts](../../src/ts/network/generationJobs.ts), `request`,
`readChatGeneration` and `stopChatGeneration`;
[serverCommands.ts](../../src/ts/process/serverCommands.ts), `stoppingChats` and `stopChatJob`;
[serverAuth.ts](../../src/ts/storage/serverAuth.ts), `authFetch`.

**Confirmed behavior.** Both new network methods call `request` without an abort signal or a
deadline. Authentication, fetch, and response-body consumption can therefore remain pending.
`stopChatJob` reserves the chat in `stoppingChats` before the first await and releases it only
in `finally`; another click returns immediately while that reservation remains.

**Reproduction.** In a temporary transport probe, hold `authFetch` unresolved for both the
current-job lookup and stop POST, then advance fake time by 30 minutes:

```text
lookup settled: false
stop POST settled: false
requests supplied an AbortSignal: [false, false]
```

The assertion that the requests finish with an outcome or error failed on the initial run and
the isolated rerun. The permanent reservation follows directly from the caller's `finally`;
the probe exercised the real transport methods rather than mounting the button.

**Impact.** A half-open connection can disable Stop in that page for the very chat the user is
trying to recover. A stalled lookup sends no abort; a stalled POST leaves its outcome unknown.
The user gets no timeout error and cannot retry through this control without reloading.

**Suggested fix.** Bound the entire exchange, including authentication and body parsing, as
the create exchange and bounded job-status reads already do. Release the UI reservation on
timeout. Keep cancellation addressed to the confirmed job ID; a retry must retain the
`jobChanged` lookup and confirmation behavior.

### JP3 — A newer queued job still misses the absence bound

**Code.** [channel.ts](../../server/src/jobs/channel.ts), `expireIfDue`, `expireOverdue`,
`holdDraining` and `dispatch`.

This is a revalidation of **Owner absence bound is not universal** in the
findings inbox (since moved to the [self-host server guide](../structure/self-host-server.md#issues)), also noted
in the plan's archive. It is not a newly discovered regression.

**Reproduction.** An injected-clock probe used the real channel hub with two jobs of the same
client. Job A dispatched a long callback. Job B opened afterwards and queued its callback.
Both owners then disappeared. At 120 seconds of absence, A settled `disconnected`; B remained
pending because its channel opened after A's dispatch. A's delivered callback kept the lane
for the additional 60-second drain allowance. B was still pending at 170 seconds of absence
and settled only when the lane was released at 180 seconds.

`expireOverdue` checks dispatched requests only. The queued-root sweep deliberately excludes
newer channels (`openedAt > dispatchedAt`), and the absence deadline is checked for B only
when it finally dispatches. Socket silence detection can precede this interval as well.

**Impact and handling.** The original D6 expression, 45 + 120 + 5 seconds, is not a universal
chat-release bound. The archive acknowledges this and the current guide does not promise it.
If that bound is required, give queued ownerless work an independently enforced absence
deadline while preserving the lane's drain protection. Otherwise retain the narrower contract
and test this queue case explicitly. The separate inbox concern about unbounded cleanup after
a disconnected provider was inspected in source but not independently reproduced here.

### JP4 — The browser driver's absence override can invalidate its reload scenario

**Code.** [checkJobProtocol.mjs](../../util/playwright/checkJobProtocol.mjs), `ABSENT_MS`,
the loader hook, and the `reload-mid-sequence` case.

**Observed failure.** The unchanged browser driver passed `lost-create-answer`, then failed
`reload-mid-sequence`. The job ended after one of three parts with:

```text
The provider callback disconnected: No owner was connected before the deadline
sequence: { total: 3, sent: 1 }
```

The driver subsequently timed out waiting for the next provider callback. The three remaining
cases were not run. Its loader changes the production 120-second owner-absence allowance to
four seconds globally, including the case that navigates and boots a new page before attaching.
That case also deliberately pauses native execution for six seconds between parts. A reload
that takes longer than the shortened allowance can correctly expire the next callback before
the test regains its owner connection. Concurrent machine load was present during this run.

**Impact and handling.** This failure is not evidence that the production 120-second allowance
breaks ordinary reloads. It makes the verification driver sensitive to boot time and prevents
the later recovery cases from running. Separate the shortened absence fixture from the reload
scenario, or explicitly control the absence transition instead of requiring navigation to
win a four-second race. Verification below distinguishes the unchanged driver from the
temporary run with a longer test allowance. With only the temporary driver's allowance changed
to 20 seconds, all five cases and the egress check passed. That countercheck is consistent with
the observed absence expiry; differing machine load and warmed caches mean it does not measure
the unchanged driver's failure rate.

## Issues outside the plan

### U1 — Opening a window with an opener duplicates the job owner's identity

**Code.** [Client generationJobs.ts](../../src/ts/network/generationJobs.ts),
`generationClientId`, `readSavedJobs` and `followGenerationJob`;
[bootstrap.ts](../../src/ts/bootstrap.ts), `resumeServerJobs` call;
[serverCommands.ts](../../src/ts/process/serverCommands.ts), `resumeServerJobs` and `followOnce`;
[server generationJobs.ts](../../server/src/jobs/generationJobs.ts), `attach`;
[jobChannel.ts](../../src/ts/network/jobChannel.ts), `handleCallback`.

**Confirmed behavior.** The implementation treats `sessionStorage` as unique per tab, but a
same-origin window opened with an opener inherits a copy. `generationClientId` accepts the
copied `risu-generation-client` without checking for another live page, and the copied
`risu-generation-jobs` causes both pages to resume the same job as its owner.

**Reproduction.** An isolated Chrome probe served the actual storage/identity functions
extracted from the production module. After recording an active job, the parent opened a
same-origin window with `window.open(location.href)`. Both pages returned the identical client
UUID and `{ '["c","k"]': 'active-job' }`. No production storage was used.

A separate real-WebSocket probe against the registry attached twice with the same owner ID,
then attached the first logical owner again with a newer stamp. Each new connection displaced
the preceding one with close code 4001. The existing client treats that close as a disconnect
and retries it through `followOnce`, so the two pages can compete until a follow exhausts its
retry budget. This continuation is established by source inspection; the whole application's
two-window retry loop was not driven in the browser probe.

**Impact.** Opening such a window can interrupt the original page's follow. A new page also
refuses a replayed callback whose ID it does not know (`handleCallback`), which can fail a
plugin-provider job that the original page was still serving. The callback-failure consequence
is code-traced, not separately reproduced end to end. This is an ownership/reliability issue
within the same authenticated principal.

**Suggested fix.** Distinguish a legitimate reload from a second live page claiming the same
session identity, for example with a coordinated live-page lease. A newly minted owner must
also discard copied owner-only saved jobs. Preserve reload recovery. Using `noopener` for
app-created windows helps, but does not by itself establish uniqueness for every way a browser
can clone a tab.

### U2 — The unused resume helper still describes itself as the boot path

**Code.** [generationJobs.ts](../../src/ts/network/generationJobs.ts), its module comment and
`resumeSavedGenerations`; [bootstrap.ts](../../src/ts/bootstrap.ts);
[persistence guide](../structure/persistence.md) and [global API guide](../structure/global-api.md).

**Confirmed by reference search.** Product boot invokes `resumeServerJobs`, which uses
`followJobToEnd`. The only callers of `resumeSavedGenerations` are tests; the other reference
in code is its shared mock. The obsolete helper attaches even for a kept receipt, although that
job can no longer be attached. Its module comment and two guides still name it as reload recovery.

This was already recorded in the
findings inbox (deleted when U2 was fixed).
It has no demonstrated current product effect, since it is unused. It can misdirect future
maintenance and gives tests of a dead path the appearance of boot coverage. Remove the unused
export and its dedicated tests, or explicitly repurpose it; point current guidance at the
actual boot coordinator.

## Verification and limits

- `pnpm check`: passed; Svelte reported zero errors and zero warnings, and server TypeScript
  completed successfully.
- `pnpm --silent test:agent`: passed, 7,739 tests and 60 skipped across 514 files.
- Temporary expected-correctness probes: three assertions failed, then failed again in
  isolated reruns, establishing JP1's client and server halves and JP2. Their sources reused
  the existing `generationJobs.test.ts` and `generationReceipts.test.ts` fixtures. A separate
  real-socket ownership probe passed. Probe scaffolding errors were corrected before drawing
  conclusions; they are not reported as product failures.
- Injected-clock channel probe: reproduced JP3 without sleeping for the production deadlines.
- Isolated Chrome storage probe: reproduced U1's copied client ID and saved job map.
- Unchanged `util/playwright/offline.sh node util/playwright/checkJobProtocol.mjs`: failed as
  described in JP4; 1/5 cases passed, one failed, and three were not run. Egress check passed.
- Browser countercheck with only the temporary driver's `ABSENT_MS` changed from 4,000 to
  20,000 ms: all five cases and the egress check passed. This is a diagnostic variant, not a
  pass of the unchanged driver.

No claim is made about Android PWA process kills, power-loss durability, a physically
throttled disk, or a real network's frequency of the delayed-original ordering. The archived
create-to-journal crash window, legacy sockets without liveness negotiation, best-effort
sequence events, bounded receipt retention, degraded receipt storage, and restart loss since
the last checkpoint remain explicit limitations; they were not counted as new defects.

Temporary probe files were removed after verification. The deliverable is this audit only.
