# Render Work Budget code audit — 2026-11-05

## Scope and result

Audited `dev` at `65e97f91f22418df49452e76e46af7a145b144f1`, which also matched
`origin/dev` when this audit began. The working tree was initially clean. The retired plan was
read from the parent of its retirement commit:

```sh
git show 79298ddcc9beb3c0c65791ddf302513318fd7a38^:docs/plan/render-work-budget.md
```

The implementation commits recorded by the plan are `b86d2ff1f`, `b850f7a01`, `784e29d85`,
`19df4fc6f`, `5e3ad8a80`, `88f523847`, `adf3667fd`, and `ba1ad31cb`. Review covered the
current implementations of render lifetimes and retries, transform subscribers and continuations,
translation workers and shared LLM requests, CSS preparation, screenshot composition, partial-edit
hover checks, highlight cleanup, and the measurement driver's conclusions. Two Luna exploration
agents mapped the code; three specialist agents independently audited transforms, translation,
and export/style/editor behavior. The primary agent reviewed their evidence and probed the row
lifecycle and parser boundary.

**Eight findings concern the plan's features; four adjacent findings are recorded separately.**
These include existing defects in modified paths and opportunities beyond the plan's chosen scope;
they are not twelve newly introduced regressions. No product fix or permanent test change is
included. P2 means an actionable correctness, resource-use, or responsiveness problem under the
stated trigger, not an observed production incident.

Later fixes were included in the review. In particular, `189efd11a` already corrects screenshot
background filling and aborts pending parses on entry to raw streaming; `3849a272f` protects
nested nontranslatable elements; `c34f52416` corrects long highlighting offsets. Those are not
reported again.

| ID  | Priority | Relationship                                        | Finding                                                                     |
| --- | -------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| RW1 | P2       | Existing gap in D1/D2/D4's modified path            | Failed translation attempts keep dispatching and overlap their retries      |
| RW2 | P2       | Introduced by D4's global semaphore                 | Completed cache hits wait behind unrelated provider requests                |
| RW3 | P2       | Existing race at D3's subscriber/refresh boundary   | A replacement render can lose the departed render's cache bypass            |
| RW4 | P2       | D6 budget gap; explicitly allowed by implementation | A single row can exceed the screenshot page's pixel budget                  |
| RW5 | P2       | Introduced by D8's cleanup                          | Unmounting highlighted editors repeatedly rebuilds every survivor's ranges  |
| RW6 | P2       | Remaining gap in D1's cancellation coverage         | Code highlighting continues after an awaited language load outlives the row |
| RW7 | P2       | Optimization beyond D4's LLM-only deduplication     | Identical non-LLM cache misses still send duplicate provider requests       |
| RW8 | P2       | Optimization beyond D3's whole-chunk cancellation   | One surviving target keeps obsolete plugin work and continuation payloads   |
| U1  | P2       | Pre-existing provider response handling             | Google JSON errors can be cached as successful untranslated text            |
| U2  | P2       | Pre-existing server/client admission mismatch       | Concurrent chunks evict their own pending plugin snapshots                  |
| U3  | P2       | Pre-existing cached-only policy                     | A settled row's changed source can bypass the cached-only probe             |
| U4  | P2       | Pre-existing capture preparation                    | Screenshot rows repeat font preparation and accumulate imported font rules  |

## Findings in the plan's features

### RW1 — A failed translation attempt keeps taking jobs while its retry runs

**Code:** [translator.ts](../../../src/ts/translator/translator.ts), lines 675–695;
[ChatBody.svelte](../../../src/lib/ChatScreens/ChatBody.svelte), lines 411–429.

`Promise.all` rejects when one non-LLM worker fails, but the remaining workers inspect only the
render's signal. A provider failure does not abort that signal. The row's transient-error handler
then starts another `markParsing` attempt after 250 ms with the same signal, while the abandoned
attempt continues to acquire permits and take previously unrequested jobs.

A deterministic probe used twenty distinct paragraphs and deferred Google fetch responses:

1. The first attempt issued ten requests.
2. Rejecting paragraph 0 rejected `translateHTML` with a transient-marked error.
3. Resolving paragraph 1 caused the failed attempt to dispatch paragraph 10: eleven requests had
   now been issued, although its caller already had a rejection.
4. Starting the retry and resolving its paragraph 0 produced two simultaneous requests for
   paragraph 2, one belonging to each attempt.

The probe started the second `translateHTML` call directly after advancing fake time by 250 ms,
using the same signal. `ChatBody`'s automatic retry was established by source inspection, not a
mounted component in this probe.

This wastes traffic and consumes the global ten-slot budget with work whose result cannot be
displayed. It is distinct from the intentional policy that an **already issued** non-LLM request
finishes and warms the cache. The problem is taking more jobs after the attempt failed.

**Fix direction:** give each attempt a failure state that stops new job/chunk acquisition and
removes its queued acquisitions on first failure. Keep permits for already dispatched requests
until they settle. Add a regression covering worker failure with both pending siblings and a
retry; the existing worker tests cover success and external abort instead.

**Attribution:** sibling continuation existed before this plan. D1/D2/D4 changed its lifetime,
retry policy, and resource sharing but did not close this failure path.

### RW2 — Cache hits unnecessarily wait for provider permits

**Code:** [translator.ts](../../../src/ts/translator/translator.ts), lines 126–159, 198–205,
and 675–685.

Workers acquire a global translation slot before entering `translate`, where the completed-result
cache is checked. `translateWithSlot`, used by the DeepLX batching path, has the same ordering.
Consequently, ten unrelated outstanding requests can block a render that needs no network work.

The probe warmed one translation, held ten other provider requests, then requested the warmed
text. That render stayed pending until an unrelated request released a permit. It then completed
without a provider request: the total remained eleven, comprising the warm-up and ten blockers.

This makes returning to translated content depend on slow or stalled work elsewhere in the tab.

**Fix direction:** check the completed cache before entering the network queue, then recheck the
cache or joinable request after admission. Charge the permit to the actual uncached producer.
Preserve context/direction keying and the rule that an issued request retains its permit until it
finishes. This ordering regression comes from `19df4fc6f`'s global semaphore.

### RW3 — A departed forced refresh can leave its replacement using the old server cache

**Code:** [transformClient.ts](../../../src/ts/parser/transformClient.ts), lines 306–338,
694–697, 752–761, and 826–828;
[server transform service](../../../server/src/prompt/transform.ts), lines 804–835.

Re-render's bypass is consumed when its operation is created. Withdrawal before dispatch and
cancellation of an entire chunk restore it. Withdrawal of one dispatched operation does not
restore it when another subscribed target keeps the chunk alive. A same-input replacement then
has `noCache:false`; that difference also prevents it from joining the original `noCache:true`
operation.

The deterministic client probe made a sibling keep the original chunk alive, withdrew the forced
target, and created its replacement. The replacement sent no bypass and accepted the old cached
text. A separate probe against the real `TransformService` confirmed the server-side timing:
when a forced target waits behind a deferred sibling, an ordinary concurrent request can still
read its old cache entry. Invalidation occurs when processing reaches that forced target, rather
than for the whole chunk at admission. The original forced answer later reaches an aborted caller
and its completion returns early.

**Impact:** a requested Re-render can leave the replacement showing the previous cached result,
despite having spent work obtaining a fresh result.

**Fix direction:** retain the forced-refresh intent until a live consumer receives its result, or
allow an eligible same-generation replacement to join the existing forced operation. Restoring
the bypass must not revive it for a superseded generation.

**Limit:** this was reproduced at the client API and real service boundaries, not through a
mounted Re-render button interaction. It requires a same-input replacement while a sibling keeps
the dispatched chunk alive. The consume-before-completion race predates this plan; the finding
is about the current D3 boundary, not a claim that D3 introduced it.

### RW4 — A single oversized screenshot row bypasses the page memory budget

**Code:** [screenshotExport.ts](../../../src/lib/ChatScreens/screenshotExport.ts), lines 38–64,
75–96, and 127–153.

The planner puts a row over `MAX_EXPORT_PIXELS` on its own page without reducing its area.
Measurement scales only against the 16,384-pixel side limit. The module header explicitly allows
this exception, so this is a gap against D6's bounded-page objective, not an unnoticed arithmetic
error. Releasing each source after drawing does not prevent the output and that source from
coexisting.

A direct probe of the exported planner admitted these pages:

| Single row      | Page pixels | RGBA bytes expressed as MiB, per canvas |
| --------------- | ----------: | --------------------------------------: |
| 10,000 × 10,000 | 100,000,000 |                                  381.47 |
| 4,800 × 16,384  |  78,643,200 |                                     300 |
| 16,384 × 16,384 | 268,435,456 |                                   1,024 |

The last dimensions imply approximately 2 GiB for source and output backing stores alone if both
allocations succeed. These are dimension calculations, not measured allocations or a reproduced
browser crash. A conditional practical trigger is a wide transcript with a tall rich row:
2,400 CSS pixels wide and 8,192 high at DPR 2 produces the 300 MiB case. Ordinary narrow columns
are less exposed.

**Fix direction:** enforce area as well as side limits before capturing the source, using the
same scale in planning and capture; alternatively tile oversized rows. Merely limiting the output
after capture would still allocate the oversized source. Existing tests cover accumulated page
area and narrow oversized rows, not an individual row over the area budget.

### RW5 — Highlight cleanup adds quadratic work to bulk editor teardown

**Code:** [highlight.ts](../../../src/ts/gui/highlight.ts), lines 124–160;
[TextAreaInput.svelte](../../../src/lib/UI/GUI/TextAreaInput.svelte), lines 260–267.

Each `removeHighlight(id)` now calls `runHighlight()`, which traverses all remaining editors'
ranges and recreates the category `Highlight` objects. Removing N highlighted editors in one turn
therefore copies N(N−1)/2 ranges even when each editor has only one range.

A direct Node/happy-dom probe against the current highlighter counted 435 range copies for 30
synthetic editors, 11,175 for 150, and 179,700 for 600. The registry correctly emptied; these are
operation counts, not UI timing measurements. The current correctness test with two editors
does not detect this scaling.

There is a real multi-editor caller: [PromptSettings.svelte](../../../src/lib/Setting/Pages/PromptSettings.svelte),
lines 194–205, mounts the template under `{#key sorted}`;
[PromptDataItem.svelte](../../../src/lib/UI/PromptDataItem.svelte), lines 262, 314, 324, and 399,
mounts highlighted fields in expanded rows. Leaving that settings page or recreating the keyed
template tears down those fields together.

**Fix direction:** remove the departing editor's ranges from maintained category sets, or reconcile
once per microtask after a group of removals. Preserve the new guarantee that stale registry
categories disappear. The repeated teardown rebuild was introduced by D8's cleanup change.

### RW6 — Cancellation stops after highlighting, rather than inside its asynchronous work

**Code:** [parser.svelte.ts](../../../src/ts/parser/parser.svelte.ts), lines 250–448,
1108–1110, and 1319–1330;
[ChatBody.svelte](../../../src/lib/ChatScreens/ChatBody.svelte), lines 383–387.

`ParseMarkdown` checks its signal before and after `renderHighlightableMarkdown`, but that helper
does not receive a signal. If the row is superseded while a language module is loading, the
helper resumes, highlights the block, visits every remaining fence, and may load more language
modules. Only then does the outer checkpoint reject the obsolete result. The post-translation
path calls the same helper without an internal cancellation boundary.

A source-extraction probe ran the current helper with controlled language-import I/O. It held
the first `bash` load, aborted the outer render, then released it. Both `bash` and `javascript`
were highlighted after the abort, and the second language load was still started. The outer
pipeline eventually returned `AbortError`, so this is wasted work, not stale output reaching the
screen. The extraction preserved the helper body and replaced its dynamic imports and rendering
dependencies with controlled boundaries; it was not a browser performance measurement.

**Fix direction:** pass the lifetime signal through this helper and `postTranslationParse`, check
it after language imports and between fences, and ensure cancellation escapes the helper's empty
catch. Already synchronous highlighting need not become interruptible. This is smaller than the
explicitly deferred incremental streaming-renderer project.

### RW7 — Concurrent identical non-LLM translations still duplicate requests

**Code:** [translator.ts](../../../src/ts/translator/translator.ts), lines 198–212 and 675–695.

The pair cache stores only completed translations. Several workers that read the same missing
text each start `runTranslator`; the new shared-request map covers the LLM path only. A deferred
Google-provider probe rendered ten identical paragraphs and observed ten simultaneous requests
with exactly the same input text.

**Impact:** repeated dialogue, status labels, or simultaneous rows spend redundant traffic and
provider capacity. The global cap limits concurrency, but does not remove duplicate work.

**Fix direction:** share a non-LLM producer by the existing configuration key, direction, and exact
text, charging it one global permit. Keep the intended behavior that an issued request may finish
and warm the cache after its row leaves. This is a concrete improvement beyond D4's explicitly
LLM-only deduplication requirement, not a failure to implement that requirement.

### RW8 — One live target retains obsolete plugin hooks and continuation text for the whole chunk

**Code:** [transformClient.ts](../../../src/ts/parser/transformClient.ts), lines 313–327
and 595–603.

Whole-chunk cancellation correctly preserves a request while any target still has a subscriber.
However, the subsequent plugin/continuation loop does not exclude targets whose subscriber count
has become zero. A probe dispatched 64 targets, aborted 63 before the first response, and left one
live. Releasing the response still ran 64 plugin hooks and uploaded 64 continuation texts.

**Impact:** obsolete targets retain plugin CPU work, any requests those hooks initiate, continuation
payload bytes, and the remaining server transform work. The probe counted hooks and targets; it
did not measure arbitrary plugin traffic or transferred bytes.

**Fix direction:** suppress hooks for departed targets and add an explicit cancelled-target
representation to the continuation protocol. Account for a target acquiring a new subscriber
before settlement. Do not simply drop required protocol fields or cancel the survivor's request.
This is an opportunity beyond the plan's deliberate whole-chunk policy.

## Adjacent issues outside the plan

### U1 — A resolved Google HTTP error can poison the successful translation cache

**Code:** [translator.ts](../../../src/ts/translator/translator.ts), lines 430–447 and 208–212.

The direct Google adapter parses JSON without checking `Response.ok`. An error object lacks
`res[0]`, so the adapter returns the source text. No failure is recorded, and `translate` stores
that unchanged text as a successful pair. D2 marks rejected `fetch` promises; a resolved HTTP
error never takes that rejection path.

A controlled response of HTTP 429 with
`{"error":{"code":429,"message":"Quota exceeded"}}` produced untranslated text on both the
initial and subsequent renders. The second render issued no request: total provider calls stayed
at one. This confirms handling of that response shape, not that a live Google endpoint returned
it during the audit.

**Impact:** a temporary provider failure suppresses recovery until cache eviction, configuration
change, or reload. **Fix direction:** validate HTTP status and response shape before reporting
success; mark/report appropriate failures and never populate the successful pair cache from an
error response. This behavior predates the plan.

### U2 — Unbounded concurrent chunks can evict their own plugin snapshots

**Code:** [transformClient.ts](../../../src/ts/parser/transformClient.ts), lines 513–540;
[server transform service](../../../server/src/prompt/transform.ts), lines 51 and 887–890;
[transformService.test.ts](../../../server/src/tests/transformService.test.ts), lines 401–418.

The client dispatches all chunks concurrently. The server retains only four pending plugin
snapshots per client, evicting the oldest when a fifth is created. These limits cover different
lifetimes: the first HTTP response is complete while its plugin hook and second call still need
the snapshot.

A deterministic client probe queued 320 uncached targets in five 64-target chunks with plugin
hooks held. Five first calls arrived before any continuation. A server boundary implementing the
actual four-snapshot policy yielded 64 raw/untransformed results and one `SnapshotExpired` toast.
The real service's existing four-snapshot eviction test was also run successfully. The 320-target
client scenario used the policy stub; it was not a full browser/server round trip.

**Impact:** large mounts or screenshot expansion can create avoidable failures and recovery
traffic. **Fix direction:** cap concurrent two-call chunks globally per tab and retain each permit
through the continuation. Throttling only active first-call HTTP requests is insufficient. This
pre-existing client/server admission mismatch sits outside the plan's server-admission scope.

### U3 — The cached-only probe ignores a settled row's changed source

**Code:** [ChatBody.svelte](../../../src/lib/ChatScreens/ChatBody.svelte), lines 301–328
and 365–394; [translator.ts](../../../src/ts/translator/translator.ts), lines 553–556 and 971–978.

The probe remembers character, chat index, and the auto-translate flag, but not its source/cache
key. Once the first probe has completed with a cache hit and `translated` is true, an in-place
source update with those same inputs skips the probe. The normal translation branch then accepts
the new text, although it has no cached translation.

A temporary mounted `ChatBody` probe first settled a cached source, then changed `msgDisplay` to
uncached text. It recorded one cache probe (the old source) and two translation invocations (old
and new). The expected-correctness assertion requiring a second cache probe failed. The translator
was mocked in this component probe; the real translator's ordinary cache-miss path would issue
the request, so new provider traffic is a code-path consequence rather than a measured bill.

The trigger is a retained row whose display text changes, for example through a same-ID update
or display reevaluation. A full remount reprobes and avoids it. The plan repairs probes superseded
before completion, but the omission after completion predates that repair.

**Fix direction:** associate automatic cached-only decisions with the effective translation key
and re-evaluate when it changes, while preserving explicit user translation choices separately.
Do not turn an automatic cached-only decision into permission for a new cache-miss request.

### U4 — Per-row screenshot capture repeats font preparation and mutates live stylesheets

**Code:** [DefaultChatScreen.svelte](../../../src/lib/ChatScreens/DefaultChatScreen.svelte),
lines 1005–1013; [screenshotCapture.ts](../../../src/lib/ChatScreens/screenshotCapture.ts), line 4.
The installed `html-to-image@1.11.13` implementation is
`node_modules/html-to-image/es/embed-webfonts.js`, lines 76–140 and 174–192.

Every row calls `toCanvas` with only `includeQueryParams`; no `fontEmbedCSS` is reused. The library
therefore scans document stylesheets for each capture. With a surviving `@import`, it expands
the import again, fetches its fonts, and inserts duplicate rules into the live stylesheet without
removing or marking the import. This input is possible because ordinary imports survive
[parser.svelte.ts](../../../src/ts/parser/parser.svelte.ts), lines 1388–1391; only data imports are
neutralized there.

A deterministic probe of the installed dependency with stubbed I/O/CSSOM and one imported font
ran the font-preparation path thirty times. It observed one stylesheet fetch, thirty font fetch
invocations, thirty inserted font rules, and embedded CSS growing from 84 bytes on the first row
to 2,549 bytes on row thirty.

**Impact:** repeated preparation, font decoding, and rule accumulation increase export work.
Browser caching can reduce actual wire traffic; the probe does not establish transferred bytes
or identify the cause of the historical screenshot memory peak.

**Fix direction:** prepare embedded font CSS once per export, or once per distinct required font
set, and pass `fontEmbedCSS` to subsequent captures. This capture-preparation behavior predates
the plan's page-composition changes.

## Checks, counterchecks, and limits

The [original measurement report](../../audit/render-work-budget-2026-11-05.md) already records two
unmet acceptance criteria: multiple transform chunks crossing a switch and screenshot peak
memory growing with row count. Its 600-row after-run reported a 3,987 MiB renderer peak increase
with pages of about 50.8 MiB RGBA each. Those are historical measurements at the commit named in
that report, not fresh measurements of this `dev` revision. RW4 and U4 are separately established
problems; neither is claimed to explain that measurement.

Counterchecks found no new defect in CSS cache keying after CBS evaluation, entry/byte bounds,
LRU renewal, or failed-parse handling. Screenshot source/page cleanup and Blob passthrough match
their intended contracts, subject to RW4's allowed oversized page. Last-subscriber transform
cancellation distinguishes cancellation from failure. Source inspection confirmed request-abort
propagation through the installed Hono adapter; this was not a live socket-disconnect probe.
Snapshot retention after the first response is the plan's explicit TTL tradeoff. The LLM in-flight
and generation maps have identity-checked cleanup.

A fifth translation probe exercised a delayed ordinary cache miss resuming after Retranslate.
It was excluded from findings: generation ownership is deliberately claimed at producer/request
commitment, and the ordinary provider request starts later in that sequence. Existing fencing of
an already active older producer was not shown broken.

Validation performed during the audit:

- Five temporary translator probes passed while asserting the observed behaviors; four support
  RW1, RW2, RW7, and U1, and the fifth is the excluded ordering case above.
- Four transform/client/service-policy checks passed, followed by one separate real-service
  forced-refresh probe, supporting RW3, RW8, and U2.
- The mounted cached-only probe failed its expected-correctness assertion: expected two cache
  probes, observed one, with translation invoked for both sources.
- Direct deterministic probes counted highlighter range copies, admitted screenshot dimensions,
  post-abort highlighting, and imported-font preparation. These use controlled dependencies and
  counts rather than wall-clock performance assertions.
- All temporary repository probes created for this audit were removed. Unrelated temporary files
  appeared from concurrent work in the shared checkout and were left untouched.
- `pnpm --silent test:agent`: **9,191 passed, 66 skipped, 577 files**. The whole-suite run
  completed successfully after waiting for the shared test lock.
- `pnpm check:changed`: completed successfully; both type-check programs were intentionally
  skipped because the remaining changes were Markdown only. This is not a fresh full type check.
- `pnpm check:docs`: passed. The report was formatted with targeted Prettier; its relative file
  links and final whitespace were also checked directly.

No live translation provider was contacted for a reproduction. The full 30/150/600-row browser
measurement driver, mounted screenshot failure/restoration scenario, Firefox, Safari, and mobile
canvas behavior were not rerun. Device-specific failure thresholds and production incidence
remain unverified.
