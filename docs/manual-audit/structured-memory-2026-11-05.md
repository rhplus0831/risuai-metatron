# Structured Memory implementation audit — 2026-11-05

## Scope and result

Audited `dev` at **`65e97f91f22418df49452e76e46af7a145b144f1`** against the final Structured Memory plan
deleted by `78dbb078f78a9e5018360857a37944752208721f`. The plan was read from its parent:

```bash
git show 78dbb078f78a9e5018360857a37944752208721f^:docs/plan/structured-memory.md
```

The audit covers the writer and its task scheduling, retrieval and prompt budgets, evidence reconciliation,
adoption/import/copy/checkpoint behavior, rebuilds, page tools, projection compatibility, and the inspection UI.
It includes later changes on the audited branch, particularly the fixes for short-chat matching, character-section
growth, and nested `(was: …)` text. The [current guides](../structure/structured-memory/README.md) supplied the
ownership map; source code and executed reproductions supplied the findings.

During verification, `dev` advanced to `1e3c65fe5` (`docs(manual-audit): archive audits`) in concurrent work.
The diff contains documentation changes only, so the product implementation and source references audited here
remain unchanged. Its effect on the final documentation check is recorded below.

**The highest-priority defect is historical re-recording overwriting the current scene.** Other confirmed problems
affect thread provenance, group-speaker corrections, evidence retrieval, and locked patch targets. The largest
cost opportunities are foreground embedding work, repeated transcript downloads, and quadratic rebuild estimates.

There are **13 plan-related findings** below: seven correctness/reliability findings and six performance/traffic
opportunities. A separate section records **two pre-existing shared-embedding issues** encountered during the audit.
Related symptoms are grouped rather than counted twice. This report does not implement fixes.

Priority means: **P1** should be fixed first because ordinary use can overwrite newer canonical state; **P2** is an
actionable correctness defect or substantial avoidable work; **P3** is a narrower edge case or smaller improvement.
Performance findings are explicitly identified as opportunities, not necessarily broken behavior.

| ID  | Priority | Finding                                                                                |
| --- | -------- | -------------------------------------------------------------------------------------- |
| C1  | P1       | Re-recording an old event replaces the current scene with historical state             |
| C2  | P2       | Locked sections consume patch budget and can prevent editable pages from being updated |
| C3  | P2       | Retracting evidence leaves the threads it opened or completed unchanged                |
| C4  | P2       | Correcting a group message's speaker does not invalidate its memory                    |
| C5  | P2       | Evidence fallback ignores uncovered history that the same send trims                   |
| C6  | P3       | Rebuild preserves imported threads but loses their participant identities              |
| C7  | P3       | An older health response can overwrite a newer post-repair badge                       |
| E1  | P2       | Retrieval caps apply after potentially large foreground embedding work                 |
| E2  | P2       | Rebuild/backfill cost estimation scans the transcript once per window                  |
| E3  | P2       | One source edit reads every nonretracted event body                                    |
| E4  | P2       | Unchanged unloaded structured chats are downloaded again on every plugin read          |
| E5  | P3       | Each log page enumerates and sorts the complete record lists again                     |
| E6  | P3       | Pages and Threads refresh duplicate the parent's contents request                      |
| U1  | P2       | Custom embedding endpoints collide in the shared vector cache                          |
| U2  | P2       | Warm vector admission performs quadratic duplicate scans                               |

## Method and evidence

Two Luna agents mapped source ownership and integration paths. Five audit agents reviewed the writer, retrieval,
lifecycle, rebuild/page tools, and client/projection areas independently. The primary reviewer read the recovered
plan, inspected the cited implementations, reproduced the storage-pagination behavior, and independently reran the
lifecycle, retrieval, embedding, rebuild-cost, and retained-thread probes. Overlapping findings were consolidated.

Reproductions used production functions, real temporary SQLite databases where indicated, and scripted model or
network boundaries. No paid provider calls or user data were used. Operation counts and request counts below are
measured; they are not estimates of production latency, compressed wire bytes, or real-model recall. Temporary
repository probe tests were removed. Each finding includes a trigger, observed behavior, and a regression case for
a future fix.

## Correctness and reliability in the plan's features

### C1 — P1: historical re-recording overwrites the present scene

**Trigger.** Record an earlier turn whose scene is “Old farm,” then a later turn whose scene is “Castle.” Edit the
earlier reply and allow the next task to re-record the affected event.

**Cause.** The normal task loop passes the old window to the writer without its historical safeguards
([memoryTasks.ts, lines 1076–1084](../../server/src/prompt/memory/memoryTasks.ts#L1076)). The manual job path does the
same ([recordJob.ts, lines 229–237](../../server/src/prompt/memory/structured/recordJob.ts#L229)). The writer strips
historical scene/thread effects only when `arg.historical` is present
([writer.ts, line 789](../../server/src/prompt/memory/structured/writer.ts#L789)); otherwise `commitPages` rewrites
the scene normally ([patches.ts, lines 391–392](../../server/src/prompt/memory/structured/patches.ts#L391)).

**Observed.** A reproduction using the real task service, writer, source-change reconciliation, and SQLite store
changed the current scene from **`Castle` to `Red old farm`** after repairing the old event. An assertion retaining
`Castle` failed. This is persisted memory regression, not only a stale UI display. The missing historical argument
also bypasses frozen-page handling and historical thread suppression; those additional effects were established
by inspection, whereas the scene overwrite was executed.

**Recommendation.** Identify repair windows preceding later committed events and protect later scene/page/thread
state, using the existing historical path where appropriate. If an edit should change later state, replay the
dependent later history explicitly instead of applying an old scene as the present one. Cover both automatic and
manual repair of an old event after a newer scene has committed. This concerns the plan's D3/D4 re-recording contract.

### C2 — P2: locked targets spend calls and starve editable targets

**Trigger.** The analysis selects a character whose fixed section slots all exist and are locked. A second case
places a large such character before an editable page in the patch targets.

**Cause.** `showTargets` includes full locked bodies and charges them against the same 12,000-character budget used
for writable sections ([patches.ts, lines 119–148](../../server/src/prompt/memory/structured/patches.ts#L119)). A
nonempty list of shown target rows causes a patch call ([writer.ts, lines 812–815](../../server/src/prompt/memory/structured/writer.ts#L812)),
although patch admission rejects every change to a locked section
([patches.ts, lines 243–245](../../server/src/prompt/memory/structured/patches.ts#L243)).

**Observed.** With every character slot locked, the real writer made **two model requests**, analysis plus an
unusable patch request, and left the target unchanged. In a second probe, seven locked 4,000-character sections
consumed the patch budget; the only shown target was the locked character, and a following page containing a short
editable fact was refused as `overBudget`. Assertions requiring one call and preserving room for the editable page
both failed.

**Impact and recommendation.** Locks are enforced, but their full bodies can prevent legitimate page updates while
the event itself is recorded. Repeated mentions can keep paying for ineffective calls. Drop targets with no writable
sections or available character slots before deciding whether to call the model. Prioritize editable bodies in the
patch budget and provide only compact locked context when necessary. Regression cases should cover both the fully
locked character and an editable target following it. This affects D3's bounded writer cost and D1's section locks.

### C3 — P2: source retraction does not reconcile thread provenance

**Trigger.** An event opens a promise and a later event completes it. Delete the completion's source message with
the normal confirmed retraction option, or retract that event in Timeline.

**Cause.** Source reconciliation retracts events and flags unsupported page sections, but does not update threads
that name those events in `openedBy` or `closedBy`
([reconcile.ts, lines 154–172](../../server/src/prompt/memory/structured/reconcile.ts#L154)). The thread lane checks
stored state and participant relevance, without checking that provenance
([retrieve.ts, lines 474–481](../../server/src/prompt/memory/structured/retrieve.ts#L474)).

**Observed.** A real-store deletion through `{ op: "remove", ids: ["a2"], retract: true }` retracted event `e2` but
left its thread at `{ state: "done", openedBy: "e1", closedBy: "e2" }`. It therefore remains omitted from retrieval.
A second executed case retracted a thread's opening event and left the unsupported thread `open` and eligible for
retrieval.

**Recommendation.** Reconcile thread creation and transitions against surviving evidence. Preserve deliberate user
state overrides, but do not let invalid creation or closure evidence silently control the thread lane. Add deletion
and Timeline-retraction cases for both opening and closing events, asserting final retrieval as well as stored
event status. The current event/page checks do not cover this D4 lifecycle gap.

### C4 — P2: speaker-only corrections leave group memory attributed to the wrong person

**Trigger.** A V3 plugin corrects a group message's `saying` from Alice's ID to Bob's ID and saves it through
`setChatToIndex`. The message text is unchanged.

**Cause.** The evidence hash includes only role and text
([memoryStore.ts, lines 1197–1201](../../server/src/data/memoryStore.ts#L1197)). Server source-change detection also
omits `saying` ([chatStore.ts, lines 2338–2345](../../server/src/data/chatStore.ts#L2338)), although the writer uses it
for group-speaker attribution ([writer.ts, lines 240–248](../../server/src/prompt/memory/structured/writer.ts#L240)).
This is reachable: the plugin API forwards the chat to `applyChatResult`
([v3.svelte.ts, lines 2508–2522](../../src/ts/plugins/apiV3/v3.svelte.ts#L2508)), whose message-field diff accepts
the correction ([chatStore.svelte.ts, lines 4379–4437](../../src/ts/storage/chatStore.svelte.ts#L4379)).

**Observed.** With production reconciliation subscribed to a real SQLite store, patching only `saying` produced:

```json
{ "newSpeaker": "bob", "notices": 0, "hashChanged": false, "eventStatus": "active", "rerecord": false }
```

Even explicitly setting the event's re-record mark did not make it eligible for automatic repair, which still saw
an unchanged source hash. Actions and knowledge can stay assigned to the wrong group member indefinitely.

**Recommendation.** Include semantic speaker identity in source-change detection and evidence validation, with a
versioned anchor or migration for existing hashes. Continue excluding receipts and other generation metadata. The
plan narrowed hashes to role/text to avoid metadata-induced invalidation; this case exposes an omission in that
design, not a reason to hash all message metadata. Add a speaker-only plugin-save regression for a recorded group turn.

### C5 — P2: the evidence fallback misses uncovered messages that are about to be trimmed

**Trigger.** An older, unrecorded message contains the exact answer to the latest question. Context pressure removes
that message's raw text, while the evidence lane has room for a short excerpt.

**Cause.** The fallback's lexical pool comes exclusively from `window.dropped`
([retrieve.ts, lines 445–448](../../server/src/prompt/memory/structured/retrieve.ts#L445)), which contains history
already covered by active events. Uncovered raw history is trimmed later, after evidence selection
([step.ts, line 284](../../server/src/prompt/memory/structured/step.ts#L284)). The fallback never considers those
additional messages leaving the prompt.

**Observed.** Production `selectMemory` was given an old message saying “The bronze key code is 4712,” a latest
question asking for that code, and a sufficient evidence budget. Without a covering event, the old message was
trimmed, the manifest contained no memory items, and `4712` was absent. Adding an active event covering the same
message made the evidence lane preserve the answer, even with the events and flow lanes disabled. The probe used
a deterministic character-count tokenizer; its 1,480 trimmed units are not claimed as real-model tokens.

**Recommendation.** Make the older-message fallback aware of the final raw-history trim, or search older eligible
messages and suppress excerpts whose full raw messages survive. Keep the protected tail and screening semantics.
The current send correctly reports a coverage gap; the defect is missed retrieval, not a false coverage claim.
Add a test with an exact lexical answer in uncovered history under context pressure. This addresses D6's
older-message evidence fallback.

### C6 — P3: retained imported threads lose their participant identities during rebuild

**Trigger.** Import a valid thread with no `openedBy`, `who: ["alice"]`, and an ordinary unmarked `auto` page for
Alice. Rebuild successfully recreates that character under a new ID.

**Cause.** The original unmarked page is omitted from the rebuild seed, while the thread is retained verbatim
([rebuild.ts, lines 144–179](../../server/src/prompt/memory/structured/rebuild.ts#L144)). The swap removes the old
page without remapping the retained thread's `who`
([rebuild.ts, lines 310–314](../../server/src/prompt/memory/structured/rebuild.ts#L310)). Participant relevance then
rejects the thread ([retrieve.ts, lines 479–481](../../server/src/prompt/memory/structured/retrieve.ts#L479)).

**Observed.** A probe passed the data through `parseRestoredRecords`, `rebuildSeed`, `rebuildChanges`, and
`retrieveLanes`. Import succeeded. Before rebuilding the thread was an `onStage` candidate; afterward it was
`not-relevant`, still naming `alice` while the live page was `alice-new`.

**Qualification and recommendation.** This requires imported/manual thread data; the UI does not currently create
threads. However, that shape is accepted by import, and thread editing only exposes state, so the panel cannot
repair its `who`. Preserve identities required by retained threads or remap their references at replacement. Test
retained threads with nonempty participant lists; the existing preservation case uses `who: []`. The documented
tolerance for dangling references on carried events does not explain this loss of preserved personal threads.

### C7 — P3: a delayed health response can undo a newer post-repair badge

**Trigger.** A boot/chat-open health request is delayed. The user repairs memory and closes the panel, causing a
newer request to return healthy facts. The older request then returns its stale facts.

**Cause.** `readHealth` accepts every answer without a request generation check
([chatStatus.svelte.ts, lines 220–230](../../src/ts/process/chatStatus.svelte.ts#L220)).

**Observed.** A focused test using the existing UI fixture followed that ordering. The badge became healthy after
the second request, then incorrectly returned to `staleEvents`; the assertion retaining healthy status failed on
the initial run and isolated rerun. Since sends and task completion intentionally do not refresh this badge, it
can remain wrong until another eligible refresh.

**Recommendation.** Fence responses per chat with a request generation and the relevant epoch/incarnation; optionally
coalesce equivalent in-flight reads. Add a reordered-response test. This is a race between observations, distinct
from the plan's intentional decision to show a periodically refreshed, advisory health badge.

## Performance and traffic opportunities in the plan's features

### E1 — P2: foreground embedding work is not bounded by retrieval candidate caps

**Cause.** The events path embeds every eligible summary and key line before limiting event candidates
([retrieve.ts, line 332](../../server/src/prompt/memory/structured/retrieve.ts#L332)). The pages path similarly
embeds every shown section of every automatic page before its cap
([retrieve.ts, lines 734–761](../../server/src/prompt/memory/structured/retrieve.ts#L734)). Document batches contain
50 texts and are awaited sequentially ([embeddings.ts, lines 498–509](../../server/src/prompt/embeddings.ts#L498)).

**Measured.** With 1,000 events, each holding one unique summary and five unique key lines, a cold real SQLite vector
cache, and a scripted embedding provider, production retrieval offered **48 event candidates** after making
**121 provider requests**: 120 document batches and one query batch, **6,004 submitted texts** in total. Repeating
the identical warm selection still submitted the same four query texts again; the query cache lasts only for that
selection. No network latency or provider price was assumed.

**Impact.** An import, adoption, changed embedding configuration, lost cache, or unsuccessful warm-up can move bulk
index construction into the next send. Overall memory-budget calculation and required-page refusal also happen
after retrieval ([step.ts, lines 247–258](../../server/src/prompt/memory/structured/step.ts#L247)), so a send with no
usable memory capacity can do unnecessary embedding work before returning empty or refusing.

**Recommendation.** Preflight overall capacity and required pages; bound foreground cache misses and warm remaining
records in background; consider indexed vector search. Cache reusable queries under a namespace distinct from
documents and their input type. Evaluate recall before introducing a lexical-only shortlist, which would remove
independent semantic matches. Add deterministic assertions on calls/texts for cold and warm large histories.

### E2 — P2: cost preview performs quadratic transcript work before confirmation

**Cause.** Rebuild/backfill cost estimation maps every planned window through `rebuildWindow(chat.message, …)`
([rebuild.ts, lines 377–383](../../server/src/prompt/memory/structured/rebuild.ts#L377)). Each call constructs and
filters anchored entries for the entire transcript before selecting that window
([rebuild.ts, lines 196–200](../../server/src/prompt/memory/structured/rebuild.ts#L196)). This is synchronous work
on the server event loop, even though it only estimates call counts and text bytes.

**Measured.** Instrumenting message eligibility reads in production `memoryWorkCost`, with empty records and
short messages, produced:

| Assistant turns / planned windows | Transcript messages | Message-wrapper reads |
| --------------------------------: | ------------------: | --------------------: |
|                               100 |                 200 |                20,200 |
|                             1,000 |               2,000 |             2,002,000 |
|                             2,000 |               4,000 |             8,004,000 |

These are `messages × (windows + 1)` reads. The primary reviewer reproduced the counts. This unnecessary work
occurs while opening the cost confirmation, before the person has authorized model work.

**Recommendation.** Build eligible entries and an ID lookup once, or accumulate the byte estimate while building
the plan. Avoid source hashes and full window objects when only counting bytes. Protect the linear behavior with
an operation-count test rather than a timing assertion.

### E3 — P2: a one-message edit parses every nonretracted event

**Cause.** `reactToMessageChanges` reads the complete contents list and then calls `readRecord` for every
nonretracted event merely to discover which source IDs it cites
([reconcile.ts, lines 150–168](../../server/src/prompt/memory/structured/reconcile.ts#L150)). During rebuild it repeats
the reaction against staged records ([reconcile.ts, lines 190–192](../../server/src/prompt/memory/structured/reconcile.ts#L190)).

**Measured.** Real-store probes seeded distinct events citing distinct messages, then edited only the final message:

| Stored events | Edited messages | Event bodies read and parsed |
| ------------: | --------------: | ---------------------------: |
|            10 |               1 |                           10 |
|           100 |               1 |                          100 |
|         1,000 |               1 |                        1,000 |

Only one event was correctly marked in each case. Thus a local edit adds N record lookups and O(total event bytes)
JSON work to synchronous source-change handling; a staged rebuild can add a second such scan.

**Recommendation.** Maintain a source-to-event relation indexed by chat incarnation and message ID alongside event
writes. Read and update only affected events, with corresponding restore/import/rebuild maintenance. A bulk read of
compact source metadata would be a smaller intermediate improvement. Test lookup counts for one changed source.

### E4 — P2: unchanged unloaded structured chats are redownloaded on each plugin read

**Cause.** The detached chat cache accepts a Structured Memory entry only if it holds real, unsealed HypaV3 summaries;
ordinary projected chats always miss
([detachedChatCache.ts, lines 122–137](../../src/ts/plugins/apiV3/detachedChatCache.ts#L122)). Plugin database reads
therefore request each missing whole chat again
([v3.svelte.ts, lines 1280–1302](../../src/ts/plugins/apiV3/v3.svelte.ts#L1280)), then serialize and cache it again at
line 1316 despite the next read being unable to reuse it.

**Measured.** With a current change feed and an unchanged unloaded structured chat containing **1 MiB of raw message
text**, two consecutive `getDatabase(["characters"])` calls each requested that whole chat through
`/api/resources/read`. The focused characterization test passed. This measures full-read count and raw-content size,
not compressed bytes on the wire.

**Recommendation.** Keep transcript bodies keyed by chat revision, and check batched memory revisions separately to
refresh changed projections. Retain the existing epoch, ownership, pending-work, and feed-freshness checks. This
preserves correctness while extending the plan's projection-only refresh benefit to unloaded chats. Add a repeated
unchanged read case and a projection-only change case; the current behavior is conservative but unnecessarily costly.

### E5 — P3: pagination repeatedly enumerates and sorts the whole memory store

**Cause.** Every package/coverage/log/threads round calls `readContents` before selecting its page
([structuredMemory.ts, lines 532–541](../../server/src/routes/structuredMemory.ts#L532)). That reads all four record
listings ([memoryStore.ts, lines 493–515](../../server/src/data/memoryStore.ts#L493)); the log handler reverses the
entire run list before applying its 50-row cap
([structuredMemory.ts, lines 602–605](../../server/src/routes/structuredMemory.ts#L602)). The underlying query orders
by `seq` while the available uniqueness index starts with `(chatSeq, id)`
([memoryStore.ts, lines 224–229](../../server/src/data/memoryStore.ts#L224)).

**Measured.** A real Hono route and SQLite store with 1,000 events and 1,000 runs needed 20 log requests to return
the 1,000 runs. Across those requests it materialized **40,000 metadata rows**: the same 2,000 rows for every page.
`EXPLAIN QUERY PLAN` for the run listing reported **`USE TEMP B-TREE FOR ORDER BY`**. The 20 JSON responses totaled
113,650 uncompressed bytes; that does not include the much larger run inputs, which the endpoint correctly omits.

**Recommendation.** Query only the requested kind with a `seq` cursor and byte/row admission, backed by an appropriate
`(chatSeq, seq)` index. Read the revision separately and retain the existing cross-round revision check. Do not fetch
every other kind merely to serve the next 50 log rows. Test metadata rows visited, not just response size.

### E6 — P3: child tabs duplicate the panel's contents read

**Cause.** A panel refresh independently fetches contents
([StructuredMemoryPanel.svelte, line 184](../../src/lib/Others/StructuredMemory/StructuredMemoryPanel.svelte#L184)),
as do Pages ([PagesTab.svelte, line 245](../../src/lib/Others/StructuredMemory/PagesTab.svelte#L245)) and Threads
([ThreadsTab.svelte, line 107](../../src/lib/Others/StructuredMemory/ThreadsTab.svelte#L107)). The client wrapper does
not share the in-flight request.

**Measured.** Mounting the real panel with its existing I/O fixtures, selecting Pages, and refreshing once caused
**two identical contents requests** for the same chat. The focused characterization test passed. Both responses
carry the complete contents lists and both requests perform the associated server reads/health scans.

**Recommendation.** Let the parent own contents and pass them into the tabs, or share equivalent in-flight reads
with revision-aware invalidation. This reduces traffic and avoids the parent and tab displaying different revisions.
Assert one contents request per refresh with both Pages and Threads active in separate cases.

## Issues outside the plan's implementation

These are existing shared embedding mechanisms, not defects introduced by the Structured Memory writer or records.
They were retained because the audited feature exercises them heavily.

### U1 — P2: custom embedding endpoints collide in the persistent cache

**Trigger.** Populate document vectors through endpoint A, then select endpoint B using the same custom model name
but a different embedding space.

**Cause.** `HypaProcesser.addText` keys vectors by text, model discriminator, and optional custom model name, omitting
the endpoint ([embeddings.ts, lines 560–568](../../server/src/prompt/embeddings.ts#L560)). Requests use the configured
URL ([embeddings.ts, lines 495 and 530–532](../../server/src/prompt/embeddings.ts#L495)). Production cache sync clears
on resource-epoch changes, not endpoint-setting changes
([vectorCache.ts, lines 329–345](../../server/src/data/vectorCache.ts#L329)). The settings fingerprint fences tasks;
it does not give cached vectors a new identity.

**Observed.** With production retrieval and a real SQLite cache, endpoint A supplied document vectors `[1, 0]` and
endpoint B supplied query vectors `[0, 1]`. After switching endpoints under the same model name, retrieval requested
only B's queries and reused all A document vectors. The controlled fixture changed from **48 offered events to zero**.
The unchanged vector dimensions made this a silent relevance failure. A follow-up source search found no production
settings-change invalidation to prevent it.

**Recommendation.** Use versioned keys that include normalized endpoint identity and all settings that change the
embedding space, without storing credential values in the key. Test a provider switch that retains the model string.

### U2 — P2: cache hits still trigger quadratic vector deduplication

**Cause.** After loading cached vectors, `addText` filters every input text by scanning the vector array from its
beginning ([embeddings.ts, lines 567–582](../../server/src/prompt/embeddings.ts#L567)). Structured Memory sends all
eligible summaries/key lines/sections through that method on a read, making this shared inefficiency particularly
visible on long chats.

**Measured.** Instrumenting the actual method's content comparisons on a warm cache produced **500,500 comparisons
for 1,000 unique texts** and **2,001,000 for 2,000**: exactly `N × (N + 1) / 2`. A 1,000-event chat with six distinct
texts per event implies **18,003,000 comparisons** for 6,000 texts; that last number is an arithmetic extrapolation
of the verified loop, not a latency measurement.

**Recommendation.** Maintain a `Set` or `Map` keyed by text for vector admission, and avoid appending already-held
vectors when multiple lanes reuse a processor. Preserve input-to-vector association. A warm-cache operation-count
test should fail if quadratic scans return. This is separate from E1: fixing the duplicate scan does not bound
cold-cache provider traffic.

## Checks, rejected hypotheses, and limits

The following suspected problems were checked and excluded from the findings:

- **Compaction omitted from cost preview:** current UI and shared contract explicitly present a lower bound and
  mention additional patch/compaction calls. The finding is inefficient calculation of the estimate, not its scope.
- **Manifest length invalidates the whole report:** exclusions are bounded to 32 with their total retained, and the
  parser deliberately accepts the included-item count. No such report-loss defect was reproduced.
- **Projection revision for a chat with no events:** the server's existence check returns no projection revision;
  this was not treated as a stale-projection bug.
- **Removal of custom-prompt health warnings and the recent section-growth/`(was: …)` changes:** these are current
  intentional behavior or already-fixed issues, not audit findings.
- **Known branch-history limits and async inherit/restore failure boundaries:** these were reviewed against the
  documented contracts and not relabeled as new defects. The inspected checkpoint, adoption, and import validation
  paths otherwise matched those contracts; this is not a proof that every possible input is correct.

Executed reproduction coverage:

- Real task service/writer/SQLite: C1 and the all-locked writer case in C2. Three distinct desired-behavior assertions
  failed as expected for C1/C2; no fixes were applied to make them pass.
- Real source-change notifications and SQLite: C3, C4, and E3; independently rerun by the primary reviewer.
- Production selection/retrieval with deterministic tokenization and scripted embeddings: C5, E1, and U1;
  independently rerun by the primary reviewer.
- Production `HypaProcesser.addText` with a scripted all-hit cache and access instrumentation: U2; independently
  rerun. The comparison-count measurement itself did not require SQLite.
- Production import/rebuild/retrieval helpers: C6; production cost calculation: E2. Both independently rerun.
- Existing UI/plugin fixtures: C7 failed as expected; E4 and E6 passed as characterizations of current excess work.
- Real Hono routes and SQLite: E5, executed by the primary reviewer.
- Existing focused rebuild/import tests: **7 passed across 2 files**.

Repository-wide verification on the unchanged product implementation:

| Check                                                                          | Result                                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `pnpm check`                                                                   | Passed; Svelte reported 0 errors and 0 warnings, and server TypeScript passed |
| `pnpm --silent test:agent`                                                     | **9,191 passed, 66 skipped, 577 files**                                       |
| `pnpm check:docs`                                                              | Passed initially; final run failed after the concurrent documentation commit  |
| `pnpm exec prettier --check docs/manual-audit/structured-memory-2026-11-05.md` | Passed                                                                        |

The passing existing suite does not contradict the deliberately failing temporary regression probes above:
those exercise cases missing from the current suite and were removed before the full run.

The final documentation check reported three findings outside this report's changes: `docs/structure/chat-store.md:277`
still links to the moved `durable-drafts-2026-10-29.md`; `docs/structure/ui-theming.md:306` still links to the moved
`cross-plan-2026-10-29.md`; and the guides plus `STRUCTURE.md` total 825,009 bytes against the 825,000-byte ratchet.
These are verification failures after the documentation-only archive commit, not product-test failures. The
concurrent files were left untouched.

No real-provider quality evaluation, browser/device end-to-end run, or production-scale latency/load test was
performed. The report makes no recall percentage or provider-cost claim. Recommended tests above describe cases
for subsequent fixes; this audit adds no persistent test or product-code changes.
