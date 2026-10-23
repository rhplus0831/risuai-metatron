# HypaV3 Background Memory Plan

Status: planned 2026-10-22 at `5b54332a4`, revised after three verification rounds the same
day. Landed: 2 (`4b00a0bc2`), 1a (`66b7f154c`), 5a (`84b4f67c9`), 1b (`4cdf65b6c`), 3a (`dbac134ba`), 4 (`54af2951e`), 3b (`9d1bd7355`), 5b (`2603ecd13`), 5c (`02b0ebefa`), 5d (`81804bcdb`), 6 (`c15b4fa53`), 7 (`7314d2cc0`), 8 (`efb0c8a67`). Source: the comparison with the Fastify fork
(`/home/codex/risuai-fastify`, read-only reference), whose generation selects only stored
summaries and leaves new summaries and embeddings to background jobs. This plan takes that
behavior, not that storage: summaries stay in `chats.meta` `hypaV3Data` and keep the
`mergeHypaV3Write` placement. Line numbers are approximate; the identifiers are the
anchors. Re-verify each cited location before editing.

One slice is one session, one commit, one file cluster. Each slice names its guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Workflow per slice:
`opus-lite` for a slice marked _small_, `opus-workflow` for one marked _hard_. Each slice
ends with its tests (under "Test"), `pnpm check`, `pnpm check:tests`, `pnpm format:check`,
`pnpm --silent test:agent` (`--tags-filter=slow` for the memory and job suites it touches)
and the owning guide's focused checks. Guide updates: each slice updates the guides it
names, except `docs/structure/memory.md` and `docs/structure/persistence.md`, which slice 8
updates from the contracts this plan states and each slice's commit message reports (so
parallel slices never edit the same guide).

Test rules for every slice (`STRUCTURE.md` V3, V6, V7, V8): order, concurrency, and
cancellation are driven by deferreds and latches; deadlines, rate limits, retention, and
task lifetimes by fake timers or one injected clock that the code under test reads
everywhere (no stray `Date.now`); production separator, CBS, and worker deadlines use the
existing unhurried test limits (`createServerContext` `generationHypaV3SeparatorLimits`,
`cbsTimeLimits`). No `sleep` as synchronization (the existing `memoryJobs.test.ts` abort
case's `sleep(300)` is not copied). A real-time test is tagged `slow` and added to the
slow-test table in `build-test-platforms.md` (that file then joins the slice's file set).
Each new regression test is shown to fail once with the guarded line broken. Mocks go
through the shared typed factories (`tests/` directories, `createAlertMock`), never a new
hand-written partial copy of a mocked module; a slice that adds a factory names it in its
file set. Comments and test titles describe current behavior, with no plan or slice labels
(T5).

## Problem

A send with HypaV3 on waits for every summary it needs. `assemblePrompt`
(`server/src/prompt/assemble.ts` ~1092) awaits `hypaMemoryV3`, which summarizes the oldest
uncovered history window by window (`server/src/prompt/memory/hypav3.ts`, standard ~719,
experimental ~194) before the main request starts. A chat that reaches the memory
threshold pauses for one or more summary calls; a long chat with memory turned on for the
first time can pause for dozens, inside a job capped at 30 minutes
(`generationJobs.ts` `JOB_MAX_DURATION_MS`), and an abort loses every summary made so far
because the write happens only when the algorithm returns (`assemble.ts` ~1116; an abort
thrown through `host.fence()` never reaches the returned-error save).

## Approach

### Modes of the V3 step

The V3 branch of `assemblePrompt` picks one of three paths. Select-only is **active** only
when the runner receives a memory task service (`deps.memoryTasks`), which happens in the
activation slice (7), after the tab can show task status and fence the modal (slice 6).
Until then, and in tests that disable the service, every V3 step takes the blocking path, so
no slice leaves sends trimming history with nothing to fill the gap.

Dispatch order once active:

1. `preview` and `previewPrompt` jobs: select-only, before any blocking check. No history
   summarization, no question, no hand-off; the selection write and D5's correction call
   are allowed (D7). Before activation, previews keep today's blocking behavior.
2. Input jobs (send, continue, reroll, group) take **blocking** when the summary request
   needs this job:
   - the `memory` model slot resolves to a Plugin-format model (`LLMFormat.Plugin`, called
     through the tab's `ctx.pluginProvider`, `server/src/llm/request.ts` ~396, ~500),
     whatever the main model is. The tab must stay connected. A `LLMFormat.WebLLM` slot is
     not this case: it runs on the server (`ctx.localGeneration`, ~398, ~498); or
   - the chat owner has an applicable `request` trigger. The runner installs the request
     callback for every run (`server/src/jobs/runSetup.ts` ~422), so the test is a predicate
     over the triggers `runTrigger(owner, "request", ...)` would run, not the callback's
     presence. The trigger runs on the server; the summaries stay in the job so the trigger
     applies to their requests. A group owner has none (the callback returns early).

   The progress overlay names the reason. A V3 preset whose `summarizationModel` is not
   `subModel` (browser WebLLM) stays unsupported on the server
   (`LOCAL_SUMMARIZATION_UNSUPPORTED`, thrown only when a summary is attempted,
   `hypav3.ts` ~1214): blocking and initial summarization fail, the background task cannot
   run, and a send that uses only stored summaries works.

3. Other input jobs take **select-only**: no history summarization. From the prepared state
   (below): select important → recent → similar → random as today, settle the memory
   reservation against the actual card cost, then drop uncovered raw history from its oldest
   end until the prompt fits, keeping the last `queryChatCount` history entries. The dropped
   uncovered messages are the **gap**; its size is their `tokenizeChat` total (examples, the
   new-chat marker, and the summarized prefix do not count). The protected entries stay
   protected through the final assembly re-check (`assemble.ts` ~1447): if they and the
   non-removable prompt exceed the context after formatting, the step returns the existing
   too-many-tokens error. Embedding calls can still happen (a document cache miss, the
   query). Standard's similarity correction keeps its one inline summary call per assembly
   (D5); a later `generate` answer reuses the correction query computed for the gap
   measurement instead of calling again.

   **Initial summarization** (blocking, on request): when the gap is larger than the
   preset's `gapConfirmTokens` (default 10000), the job asks the owner's tab a `memoryGap`
   question showing the gap and the planned number of summary calls:
   - "Generate the summaries now": acquire the chat's summary writer lease, re-read the
     stored memory, prepare and plan again (the gap measurement's prepared state is not
     reused), run the summarization with progress and per-summary saves, sequentially (one
     window at a time, for either implementation, D11), then select.
   - "Continue now": keep the select-only result; the background task fills the gap.

   A gap at or under the threshold is the usual case of a chat that just reached the memory
   threshold: no question, select-only. No question while the chat's background task is
   queued or running, and at most one per job (D4).

### Prepared state, plan, and execution

The V3 parts (slice 1) separate three kinds of state, for each main with its own rules
(window scan, reservation, empty-card return, error position):

- `Prepared`: immutable input and base accounting: the cleaned stored data, the
  pre-cleanup snapshot, the summarized-prefix cursor, a token ledger (incoming count,
  response correction applied once, prefix deduction applied once, the reservation as a
  separate item: standard's empty card or full budget, experimental's conditional full
  budget).
- `Plan`: the expected windows `{ scanStart, scanEnd, scannedIds, includedMemos,
removedTokens, needsLlm }[]`, the planned LLM call count, and the stop reason. It
  predicts success; it is never used as the cursor after a failure or a stop.
- `ExecutionResult`: the windows actually completed, the consecutive prefix accepted for
  saving, its token delta, the cumulative data, and the end reason: `complete`, `stopped`,
  `writeSkipped`, `sourceInvalid`, or `providerFailed`. Selection reads its cursor from
  here.

`hypaMemoryV3` stays the composition prepare → plan → execute (no hooks) → select (no trim)
with today's requests, keys, progress payloads, errors, and returned counts, including the
mains' different error positions (standard reports planning exhaustion after executing the
windows before it; experimental before executing any). It keeps
`server/src/tests/fixtures/memory/algorithms.json` unchanged (never regenerated, see its
README). Production calls the parts with hooks. The client copy
(`src/ts/process/memory/hypav3.ts`) keeps the legacy composition only (D12).

Empty-card rules stay each main's: standard returns an empty `<Past Events Summary>` card
when there are no summaries; experimental returns no card only when
`data.summaries.length === 0`, and an empty card when summaries exist but none is selected.

### Saving summaries while they are made

Every production writer of new summaries (the job's blocking and initial runs, the
background task) holds the chat's **summary writer lease** and saves each accepted summary
at once:

- Lease: `acquireSummaryWriter(chatRef, ownerId)` closes the write fence of the chat's
  running task, waits (bounded) for its last write to settle, and returns `release()`. While
  a lease is held, hand-offs and manual starts for the chat only queue; a cancelled task's
  late provider result can never write (its fence closed at acquisition, not at settle). A
  job releases in `finally`. Without a task service the lease is a no-op.
- Baseline: `algorithmBaseline` starts as the pre-cleanup snapshot and is an independent
  snapshot of the last **accepted algorithm candidate**, never the merged stored value. A
  write calls `mergeHypaV3Write(algorithmBaseline, candidate, freshlyReadStored, false)`
  and, only after the write commits, sets `algorithmBaseline = clone(candidate)`. A
  concurrent edit stays in the stored value: the next write sees stored ≠ baseline and takes
  the divergent path, which keeps it. (Adopting the merged value as the baseline while
  writing the algorithm's own cumulative data hits the fast path and restores the unedited
  text.) Each candidate's metrics are normalized by identity after cleanup, so the fast path
  (which returns the candidate as is) never leaves an index pointing at another summary.
- Checkpoint result: the hook returns `"committed" | "skipped"`. A skip (a reset, a moved
  cursor, a damaged value) ends summarization with `writeSkipped`.
- Source validation (D15) before each save, for every production writer (the job's chat
  slot is not a history lock: `generationLock.ts` locks only messages being generated):
  over each window's whole scan interval, the current chat's message id sequence equals the
  captured `scannedIds` (an inserted or re-enabled message fails it), each included message
  is enabled, after the last `allBefore`, and has the stored-text hash captured with the
  processed entry; a window containing the greeting checks `fmIndex` and the selected
  greeting text's fingerprint. The greeting's memo stays `undefined` at runtime and `null`
  when serialized, as today; a regular message without an id fails. The first failing
  window ends the savable prefix with `sourceInvalid`: it and every later window are
  dropped, so the cursor never passes uncovered history. The legacy composition runs
  without this hook.
- After `writeSkipped`, a job re-reads the stored memory and continues select-only with
  trimming (the send still makes its main request, D16); after `sourceInvalid` it ends with
  a retryable "the chat changed during summarization" error. A task ends with that reason.
- Experimental's background and blocking runs keep their concurrency and save only the
  longest consecutive successful prefix. A stop or a cancel is not a provider failure.
- The final selection write of a job uses `mergeHypaV3SelectionWrite(baseline, data,
stored, { selectionMade })` (new in `shared/memory.ts`): from the full algorithm data it
  applies only the orphan removals and, with `selectionMade`, the new metrics mapped by
  identity; without it, the stored metrics remapped past the removals. It keeps the stored
  text, categories, modal settings, and summaries appended meanwhile, never adds a summary
  or recreates one a reset removed, and returns `null` on a damaged or ambiguous value. The
  cursor rule of `mergeHypaV3Write` (which refuses when the stored tail moved) is not
  relaxed for appends.

### Background memory task

After a job ends `done`, the runner hands the chat to a detached memory task service, the
way it hands replies to the translation runner (`handOffTranslations`,
`server/src/prompt/runner.ts` ~545, before `done`), when the lookahead plan says summaries
are due. The hand-off copies data only (no job closure, signal, or services) and the task
starts after the job's terminal is enqueued. The service (new
`server/src/prompt/memory/memoryTasks.ts`) follows `server/src/translation/runner.ts`:

- Source generation (slice 5a): the store keeps a per-chat in-memory counter, advanced
  once, inside the commit, by a chat delete, a whole-chat `replace` (including a checkpoint
  load's), and a character cascade delete, and publishes an in-process invalidation notice
  after the commit (never on rollback). A task's own `meta` write and a job's `meta` or
  `append` do not advance it.
- Input (`MemoryTaskInput`, assembled just before the memory step, deep-copied): the
  processed history (`OpenAIChat[]` with message-id memos) with, per entry, the stored-text
  hash and enabled state taken from the same snapshot the entry was built from; the history
  start index; the token count before memory; `maxContext` and `maxResponse`; the token
  policy (the main model's non-secret descriptor, including an admitted Plugin descriptor's
  metadata, the tokenizer identity, the name and image policy) and a fingerprint of the
  memory-relevant settings (the Hypa preset, the `memory` slot, the embedding model); the
  admission binding ids and the effective preset ids with whether a `presetChain` produced
  them; the speaker; the epoch; the chat's admitted revision; and the **source generation
  read in the same synchronous chat read that produced the processed history's source
  snapshot** (`loadJobScope`/`refreshChat`, carried with the snapshot), never re-read at the
  memory step. If the entries came from snapshots of different generations, or the captured
  generation is no longer current when the job hands off, the input is not handed off or
  retained and does not satisfy `pendingManual`; the next send's input is used. For a group
  or an auto-continue, the last completed speaker or round's input is the chat's. The reply
  the job just wrote is not in it; the next hand-off covers it.
- Queue: one running task and one latest pending input per chat (a new hand-off replaces
  the pending one); at most 4 running tasks server-wide and 32 chats pending; retained
  inputs (running, pending, and the idle latest per chat) capped at 64 MiB in total, idle
  ones evicted least-recently-used first, running and pending ones never (a hand-off that
  would exceed the cap with no idle input to evict is dropped with a log line; the next send
  hands off again). Capacity counts work whose run ended but whose promise has not settled,
  as translation does.
- Manual start (`start(chatRef)`): reuses the chat's retained latest input when its source
  generation is current and its fingerprint matches the fresh scope; otherwise (none, stale,
  or changed) it sets `pendingManual` so the chat's next input job hands off even when not
  due, and answers so; the UI shows it (D8). An invalidation discards the retained input
  and `pendingManual`.
- Its own `MemoryHost` (a factory with explicit dependencies, slice 5b): requests through
  `requestChatDataOuter` → `llm.runInJob`, as translation does, keeping retries and the
  character-set handling, with a synthetic job id, `mode` and `source` `"memory"`, and a
  stub channel (translation's `DETACHED_CHANNEL`); the `ChatTokenCounter` built from the
  captured token policy; `tokenize` for plain text; embeddings from
  `createEmbeddings(...).forJob({ db, supaMemoryKey, signal })` on the task's signal; regex
  through the script workers with the abort and the separator limits; `parseChatML` with
  write-disabled CBS (`rootDir`, one task-wide `serverCbsLimits` budget, as translation's);
  the scope's persona name; redaction; a task fence. No request trigger, no plugin hooks, no
  tools. V3 uses neither `completions` nor `summarizer`; the factory returns them as an
  unavailable adapter.
- At start, on a fresh `loadJobScope` (with `binding: "chain"` semantics when the input's
  effective preset came from a chain, after checking the admission binding is still valid):
  the owner's memory is on, V3 wins the priority (Hanurai and V2 off), the binding is valid,
  no blocking condition holds, the preset's summarization model is `subModel`, the
  fingerprint matches, and the source generation is current; otherwise the task ends
  `skipped` with the reason (`staleInput` for the last two) (D10).
- Prepare without cleanup: the task never removes a stored summary because the input lacks
  its messages (orphan cleanup belongs to a job's selection write, which has a fresh
  source). If the stored coverage already reaches past the input's history, the task ends
  `skipped: staleInput`.
- Planning with lookahead (D6) on a ledger whose reservation counts the full memory budget
  as a planning cost only. Writes as in "Saving summaries", with the captured epoch, the
  admitted revision (the same-incarnation check; never a revision re-read later), and the
  source generation compared at each commit.
- After the summaries, it warms the document vectors of the new summaries through the
  active implementation's processor (`HypaProcesserEx.addSummaryChunks` or
  `HypaProcessorV2.addTexts`) with the same separator split, trim, and per-summary grouping.
  A warming failure keeps the summaries.
- Lifecycle: an early maintenance listener pauses and aborts tasks and clears the queue
  (as `translationRunner.pause`, registered before the jobs' listener); `beginShutdown`
  aborts and refuses hand-offs; `dispose` drains (bounded) before the stores close; an
  `epoch` feed event clears the registry; a source-generation notice cancels the chat's
  running and pending task and discards its retained input and `pendingManual`. A checkpoint
  load holds a temporary admission and write fence for the chat from before its transaction
  until a `finally` after it (success or failure), cancelling the chat's task at entry;
  the fence neither advances the generation nor publishes a notice: the load's `replace`
  advances it once in its commit (D14).
- Status: a new event-feed frame `memoryTask` (`shared/events.ts`) with chat ids, task id,
  state (`queued`, `running`, `done`, `failed`, `cancelled`, `skipped`), `done`/`total`
  summary counts, the reason or redacted error, and on every terminal state a
  `terminalRevision`: the chat's revision read in the synchronous step that closes the
  task's write fence and publishes the terminal, whether or not the task committed anything
  (or `gone` for a deleted chat), plus an optional `lastCommittedRevision`; `hello` carries a snapshot of live tasks and of terminal states kept for
  10 minutes (the "last failure"; a display policy, not a freshness bound). A late
  completion updates status only when its task id and epoch match. Routes to start a task
  for a chat and to cancel one.

### Progress and the stop control of blocking summarization

- The legacy `progress` notice (`shared/jobs.ts` ~296) and its producers stay unchanged. A
  new `memoryProgress` notice carries `chatRef`, `phase` (`blocking` | `initial` |
  `selection`), `reason` (`pluginModel` | `requestTrigger` | `gap` | `null`: an ordinary
  blocking run before activation and a selection have none), summary `done`/`total` (absent
  for an embedding queue, which carries its text instead), and a `runId` for the stop
  control. Standard gains `k/n` progress (it has none today); experimental's selection
  embedding queue reports as phase `selection`.
- The tab keeps a job-keyed `memoryProgress` map beside the existing `hypaV3ProgressStore`
  (which the client copy and the legacy notice still write). The overlay shows the job
  entry of the selected chat (`currentChatRef()`), else the legacy store; job end clears
  only its entry.
- An initial run's overlay has "Stop here and continue" (D11): the job finishes and saves
  the window in progress, starts no further window, selects from what is saved, trims the
  rest, and hands the chat to the background task; the remaining speakers and rounds of the
  job use select-only. The stop does not abort the job. The control reaches the job through
  an owner-only route and a run-scoped flag on the running job.

### Modal freshness fence

The modal writes its whole `hypaV3Data` copy (`HypaV3Modal.svelte` ~113), so it must not
write while a task can commit or before the tab holds what a task committed. The tab keeps
two things per chat: the task status (from frames and `hello`), and a **hydration-pending
fence** set when a task starts, queues, or runs, and also when the first thing the tab sees
of a task (a frame or a `hello` entry) is a terminal whose `terminalRevision` the mirror
does not yet hold (set before the refresh starts). It is cleared only when the chat mirror
holds a revision at least the `terminalRevision` (same incarnation) or the chat is gone; a
late read for an earlier task never clears a newer task's fence. A disconnect keeps
every fence; a `hello` replaces the status map but not the fences; the tab refreshes the
union of the chats it tracked and the chats in the snapshot, and clears a fence only after
that chat's mirror adopted the read (a read not adopted because of pending local work does
not count). Lore writes are not fenced by tasks (the check is direct, not through
`generatingChatKeys`).

## Order

(1a, 2) → 1b → 3a → (4, 5a) → 3b → 5b → 5c → 5d → 6 → 7 → 8.

| Slice | Product files                                                                                                                                                                                                                                                                         | Test and doc files                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a    | `server/src/prompt/memory/hypav3.ts`                                                                                                                                                                                                                                                  | new `server/src/tests/hypaV3Parts.test.ts`                                                                                                                                          |
| 2     | `shared/memory.ts` (`HypaV3Settings` only), `shared/hypaV3Presets.ts`, `MemorySettings.svelte`, `src/lang/en.ts`, `src/lang/ko.ts`                                                                                                                                                    | `hypaV3Limits.test.ts` (settings table), `normalizeCollections.test.ts`, `boot-snapshot.json`, `MemorySettings.hypaV3Export.test.ts`, new mounted settings test; `settings-i18n.md` |
| 1b    | `server/src/prompt/memory/hypav3.ts`, `shared/memory.ts` (merge helpers)                                                                                                                                                                                                              | `hypaV3Parts.test.ts`, `hypaV3MemoryWrite.test.ts`                                                                                                                                  |
| 3a    | `server/src/llm/request.ts`, `server/src/prompt/triggers.ts`, `shared/jobs.ts` (additive), `server/src/lua/bindings.ts` (optional-question ask), `server/src/jobs/generationJobs.ts` (memory-stop API), `server/src/routes/generations.ts`                                            | new predicate and route tests; `chat-pipeline.md`                                                                                                                                   |
| 3b    | `server/src/prompt/assemble.ts`, `server/src/prompt/runner.ts`, `server/src/jobs/runSetup.ts`, `server/src/jobs/jobScope.ts` (source generation with the snapshot), `server/src/app.ts` and `server/src/tests/testSupport.ts` (the `memoryTasks` override: `"disabled"` or a service) | `memoryJobs.test.ts`; `chat-pipeline.md`                                                                                                                                            |
| 4     | `src/ts/network/jobChannel.ts`, `src/ts/stores.svelte.ts`, `src/App.svelte`, `src/lib/Others/HypaV3Progress.svelte`, `src/lang/en.ts`, `src/lang/ko.ts`                                                                                                                               | `src/ts/network/jobChannel.test.ts`, new mounted progress test; `ui-theming.md`                                                                                                     |
| 5a    | `server/src/data/resourceStore.ts`, `server/src/data/chatStore.ts` (source generation and invalidation notice)                                                                                                                                                                        | new `server/src/tests/chatSourceGeneration.test.ts`; `self-host-server.md`                                                                                                          |
| 5b    | new `server/src/prompt/memory/memoryTaskHost.ts`                                                                                                                                                                                                                                      | new `server/src/tests/memoryTaskHost.test.ts`                                                                                                                                       |
| 5c    | new `server/src/prompt/memory/memoryTasks.ts`                                                                                                                                                                                                                                         | new `server/src/tests/memoryTasks.test.ts`                                                                                                                                          |
| 5d    | `server/src/app.ts`, `shared/events.ts`, `server/src/data/changeFeed.ts`, `server/src/routes/events.ts`, new `server/src/routes/memoryTasks.ts`                                                                                                                                       | `memoryTasks.test.ts`; `self-host-server.md`                                                                                                                                        |
| 6     | `src/ts/network/eventFeed.ts`, new `src/ts/process/memoryTasks.svelte.ts`, `src/lib/SideBars/chatStatus.ts`, `ChatStatusBadge.svelte`, `Sidebar.svelte`, `PinnedChatsRail.svelte`, `src/lib/UI/MainMenu.svelte`, `HypaV3Modal.svelte`, `src/lang/en.ts`, `src/lang/ko.ts`             | modal fence and badge tests; `ui-theming.md`                                                                                                                                        |
| 7     | `server/src/app.ts` (pass `deps.memoryTasks` to the runner, enable manual admission)                                                                                                                                                                                                  | `memoryJobs.test.ts`, `memoryTasks.test.ts` (activation cases)                                                                                                                      |
| 8     | none                                                                                                                                                                                                                                                                                  | `memory.md`, `persistence.md`                                                                                                                                                       |

- 1a ∥ 2: 1a edits only `hypav3.ts` and a new test file; 2 edits `HypaV3Settings` in
  `shared/memory.ts`, which 1a reads but does not edit. 1b follows both: it edits
  `shared/memory.ts` (merge helpers) and reads `gapConfirmTokens`.
- 3a defines additive, structural contracts for 3b and 5: `MemoryTaskService`
  (`handOff(input)`, `status(chatRef)`, `acquireSummaryWriter(chatRef, ownerId)`,
  `pendingManual(chatRef)`), `MemoryTaskInput`, the `memoryProgress` notice, and the
  `memoryGap` question; the legacy progress notice is untouched, so 3a passes `pnpm check`
  alone. 3b imports no module of 5b–5d.
- 5a precedes 3b: 3b captures the source generation through 5a's store accessor (no
  placeholder value to replace later).
- 3b adds the `memoryTasks` override to `createServerContext`/`createTestServer`: existing
  blocking tests run with it `"disabled"`, select-only tests pass a fake service, the
  activation tests (7) the real one. Production passes nothing until 7.
- 4 ∥ 5a: 4 is client-only; 5a edits two store files and a new test. 4 depends on 3a's
  `shared/jobs.ts` types.
- 5d constructs the service, feed, and routes, but does not pass it to the runner and keeps
  manual admission refused (`503`, "not enabled"): tasks run only in tests.
- 6 needs 5d's frame and routes and 4's progress map and locale keys (it edits the locale
  files after 4).
- 7 activates: the runner gets `deps.memoryTasks`, manual admission opens.
- 8 updates `memory.md` and `persistence.md` last.
- `docs/plan/chat-checkpoints.md` touches `generationJobs.ts` (its slice 4 `onChatJobDone`),
  `app.ts`, and the checkpoint load in a new `checkpointService.ts`. This plan's 3a, 3b,
  5d, and 7 edit the first two. Whichever plan lands second rebases on the other, and the
  second of {this plan's 5c, that plan's load slice} adds the load's temporary admission and
  write fence (D14), its tests (a successful load advances the generation once and notifies
  once; a conflict and a callback throw advance nothing, notify nothing, and reopen
  admission), and edits the other plan's text to match D14. The load's `replace` advances
  the generation through 5a's commit path with no extra call.

## Slice 1a. V3 parts, legacy parity (_hard_, `memory.md` via slice 8)

- `server/src/prompt/memory/hypav3.ts`: extract from both mains, without behavior change,
  `prepareHypaV3` (standard ~661–717, experimental ~139–192, with the `Prepared` ledger and
  the pre-cleanup snapshot), `planHypaV3Summaries` (the windows of standard ~741–808 and
  experimental ~199–276 without LLM calls, with `scannedIds`), `executeHypaV3Plan` (standard
  ~784–809 per window, experimental ~278–345 as a batch) returning `ExecutionResult`, and
  `selectHypaV3` (standard ~811–1104, experimental ~347–646). `hypaMemoryV3` composes them
  with no hooks. The prepare signature takes the `MemoryTokenizer` (`tokenizeChat`), not
  `host.tokenize`.
- The parts are exported for 1b and 3b; nothing else calls them yet.
- Test: `memoryAlgorithms.test.ts`, `memoryOracle.test.ts`, and `hypaV3Limits.test.ts` are
  not edited and pass. New `hypaV3Parts.test.ts` over the fixture world (`scenarios.ts`):
  for every V3 scenario whose outcome succeeds, the plan's `needsLlm` window count equals
  the executor's history-summary requests (the correction request of
  `v3-similarity-correction` is counted separately); for `v3-partial-then-failure` and
  `v3exp-batch-partial-failure`, the executed prefix, the unstarted windows, and the
  returned count match each main's current error position.

## Slice 2. Preset field and settings warnings (_small_, `settings-i18n.md`)

- `shared/memory.ts` `HypaV3Settings.gapConfirmTokens: number`; `shared/hypaV3Presets.ts`
  default 10000 and an integer ≥ 0 rule beside the `maxChatsPerSummary`/`queryChatCount`
  one (0: ask on any gap). The field is nested in the existing `hypaV3Presets` collection:
  no new section or root field.
- `MemorySettings.svelte`: the number input beside the preset's sizing controls (~407),
  outside the experimental-only block (~467), with label and help (`en.ts` `hypaV3Settings`
  and `help`; `ko.ts`). Warnings in the HypaV3 section:
  - the `memory` slot resolves to a Plugin model (`resolveModelSlot` and the model's
    format): "Summaries for this model run in a connected tab: keep it open; a send waits
    for them";
  - the preset's `summarizationModel` is not `subModel`: "The server cannot run this
    summarization model: summaries are not made in the background, and a send that must
    summarize fails. A send that uses stored summaries works";
  - a help line: "A character or module request trigger keeps summaries inside the send so
    the trigger applies to them."
- Test: `hypaV3Limits.test.ts` settings table gains the field (default, negative, fraction,
  NaN); `normalizeCollections.test.ts` default preset and
  `src/ts/storage/tests/fixtures/boot/boot-snapshot.json` hand-edited for the new default
  only (no recapture); `MemorySettings.hypaV3Export.test.ts` round-trips a non-default
  value; a mounted `MemorySettings` test shows each warning only under its condition.

## Slice 1b. Planner, select-only, hooks, merge helpers (_hard_, `memory.md` via slice 8)

- `planHypaV3Summaries(prepared, { lookahead })`: trigger at `C × (1 − h)`, target
  `max(0, C × (1 − h − extraSummarizationRatio))`; a target the protected tail makes
  unreachable is a normal stop reason. Capacity stays `C`; the full memory budget is
  reserved for planning even with no stored summaries (a planning cost, not a prompt cost).
- `executeHypaV3Plan(host, prepared, plan, hooks)`: hooks `progress(done, total)`,
  `checkpoint(candidate): "committed" | "skipped"` (synchronous; the executor keeps
  `algorithmBaseline` and normalizes candidate metrics as described in Approach),
  `validate(window): boolean` (D15, before each checkpoint), `shouldStop()` (between
  windows), and `sequential: true` (initial runs). End reasons as in `ExecutionResult`.
  Experimental buffers out-of-order completions and checkpoints the consecutive prefix; a
  stop or cancel cancels pending limiter tasks and lets active ones finish without saving
  past the prefix.
- `selectHypaV3(host, prepared, execution, { trimUncovered, correction })`: with
  `trimUncovered`, the ledger settles the reservation against the actual card (each main's
  empty-card rule, Approach), then drops uncovered raw history oldest first, keeping
  `queryChatCount` entries, and returns `gap: { tokens, messages, memos }`, the protected
  ids, and the correction query it used (for reuse). Fixed prompt plus protected entries
  over `C` returns the too-many-tokens error.
- `prepareHypaV3(..., { cleanup: false })` for the task (no orphan removal) and a
  `coverageAhead` flag (stored coverage past the input's history).
- `warmHypaV3Vectors(host, summaries)`.
- `shared/memory.ts`: `mergeHypaV3SelectionWrite(baseline, data, stored, { selectionMade
})` as described in Approach; `mergeHypaV3Write` unchanged.
- Test (`hypaV3Parts.test.ts`, `hypaV3MemoryWrite.test.ts`): three checkpoints with a text
  edit, a middle deletion, a category change, and modal settings saved between the first and
  second, then a third checkpoint and a final selection write with no further edit: all four
  edits and the selection metrics survive; adopting the merged value as baseline is shown to
  lose the edit; a cleanup plus append candidate with carried metrics, on the fast path,
  keeps each metric on its summary; equal metric values with `selectionMade` true and false
  map differently as specified; a skip ends with `writeSkipped`; W1 `[m1,m2]` with m2
  deleted and W2 `[m3,m4]` completed first saves nothing; a message inserted or re-enabled
  inside W1, an edited earlier message, a changed alternate greeting, and a first window
  containing the greeting follow D15; experimental out-of-order completion saves only the
  consecutive prefix; `shouldStop` after window 2 of 4 leaves two summaries and the cursor
  after window 2; select-only keeps `queryChatCount` entries, reports the gap as the dropped
  messages' tokens (not `currentTokens − C`), keeps each main's empty-card rule (including
  experimental's empty card with summaries but no selection), and errors when protected
  entries do not fit (cases: multimodal entries, a short history, a large fixed prompt,
  `memoryTokensRatio` 0); `cleanup: false` keeps a summary whose messages are absent from a
  stale input and sets `coverageAhead`; lookahead plans windows below `C` and reserves the
  budget with no stored summaries, and a large `extraSummarizationRatio` clamps the target at
  0; warming then selection with the same settings and summaries makes no document
  embedding request (standard ordinary, standard contextual, experimental); a selection
  write after a task append keeps the append and applies the metrics; a cleanup write after
  a task append removes only the orphaned identity; a selection write after a reset
  recreates nothing.

## Slice 3a. Preflight, contracts, stop control (_hard_, `chat-pipeline.md`)

- `server/src/llm/request.ts`: extract the descriptor resolution dispatch uses (slot →
  profile → `getModelInfo` with the job's `pluginmodel:::` forcing and the
  `customAPIFormat` override) into one helper; dispatch and the preflight both call it.
  A refused resolution stays a failure.
- `server/src/prompt/triggers.ts`: `hasRequestTriggers(owner, modules)`, sharing the
  selection `runTrigger` uses for mode `request` (character and module triggers through
  `moduleTriggers`/`jobModules`, the type filter with its first-effect `triggercode`/
  `triggerlua` exception, the legacy-condition skip, then the request allowlist). Groups:
  false.
- `shared/jobs.ts` (additive only): question `{ kind: "memoryGap"; payload: { gapTokens;
plannedCalls; lastTaskError? } }`, `MemoryGapChoice` `"generate" | "continue"`,
  `MEMORY_GAP_CHOICES`; the `memoryProgress` notice; `MemoryTaskService` and
  `MemoryTaskInput`.
- `server/src/lua/bindings.ts`: an optional-question `ask` that returns `timedOut` and
  `disconnected` as outcomes instead of latching; `aborted` and fatal errors still
  propagate. Lua and `memoryTrim` keep the latching `ask`.
- `server/src/jobs/generationJobs.ts`: `registerMemoryControl(job, runId)` /
  `requestMemoryStop(jobId, clientId, runId)` on the running job (owner client only; an
  ended job, another run, or no initial run answers 409; a repeat is idempotent).
  `server/src/routes/generations.ts`: `POST /api/generations/:id/memory-stop` with the
  existing auth, limiter, no-store, and epoch rules.
- Test: the preflight agrees with dispatch for a sub-slot fallback, a profile, a custom
  format, a forced `pluginmodel:::` id, a reverse-proxy format override, and a server
  `LLMFormat.WebLLM` model (not blocking); `hasRequestTriggers` agrees with `runTrigger`
  (fires or not) for character, module, legacy-condition, allowlist-filtered, and group
  cases; the optional ask returns `timedOut`/`disconnected` and rethrows `aborted`; the stop
  route refuses another client, an ended job, and another run.

## Slice 3b. Generation integration (_hard_, `chat-pipeline.md`)

- `server/src/app.ts`, `server/src/tests/testSupport.ts`: the `memoryTasks` option of
  `createServerContext`/`createTestServer` (`"disabled"` | a `MemoryTaskService`); unset
  means disabled until slice 7.
- `assemble.ts` V3 branch: the dispatch order of Approach (previews first, then
  `blockingReason` from the preflight and `hasRequestTriggers`); without a service, always
  blocking (today's composition plus progress, checkpoint, and validate hooks, under no
  lease). Blocking with a service: `acquireSummaryWriter`, then prepare/plan/execute and
  select. Select-only: prepare, select with `trimUncovered`, the gap check; on `generate`
  the lease, a fresh prepare and plan, a sequential execution with the stop hook, then
  select reusing the correction query. End reasons: `writeSkipped` → re-read stored memory,
  select-only with trimming, continue (D16); `sourceInvalid` → the retryable error. The
  final write is `mergeHypaV3SelectionWrite`. When the V3 step ran select-only or initial,
  the protected entries stay non-removable to the end: the protection is attached to the
  history entries before formatting (not looked up by `memo` at the re-check), survives
  `systemizeChat` (which drops the memo, `assemble.ts` ~279), prompt-card copies, and
  `editRequest`, and a message `pushPrompts` merges from several entries (~1258) is
  non-removable when any of them is protected; an entry whose source cannot be traced is
  treated as protected. The step assembles `MemoryTaskInput` before the memory step from the
  source snapshot (with its source generation, carried by `jobScope.ts`
  `loadJobScope`/`refreshChat`) and returns it with the assembled prompt.
- `runner.ts`: `confirmMemoryGap` beside `confirmMemoryTrim` (input kinds only, once per job
  through `JobRunState.memoryGap`, skipped while `status(chatRef)` is queued or running):
  answered `generate`/`continue`; `null` (dismissed) and `timedOut`/`disconnected` continue
  (D3); any other value is `SendError`. `handOffMemory(job, deps, input)` beside
  `handOffTranslations`: done, not aborted, an input kind, and summaries due or
  `pendingManual`; a no-op without `deps.memoryTasks`. The `memoryProgress` adapter stamps
  `chatRef`, phase, reason, and `runId`; `registerMemoryControl` around initial runs; the
  lease released in `finally`.
- Test (`memoryJobs.test.ts`): with the service disabled, every existing case runs blocking
  and keeps its meaning (the concurrent reset case ~796 still makes the main request and
  ends `done`, now through `writeSkipped`); with a fake service: a Plugin-slot run and a
  request-trigger run keep summary-before-main order and `memoryProgress` names the reason;
  both preview kinds, under a Plugin slot and under a request trigger, make no
  history-summary request and store no new summary (the correction request counted
  separately); a server-slot run with `enableSimilarityCorrection` off makes no summary
  request before the main request and selects stored summaries, and with it on makes exactly
  one correction request per assembly, also after `generate`; the protected entries survive
  the final re-check, also with `sendChatAsSystem` where an old removable entry and the
  protected tail merge into one system message, and an `editRequest` that grows the prompt
  past them ends with the too-many-tokens error; with `editprocess` held by a latch, a
  whole-chat `replace` keeping ids, texts, and the memory tail but changing `scriptstate`
  makes the job hand off nothing (an input accepted under the new generation fails the
  test), while a job's own `meta` or `append` during the same window does not block the
  hand-off; a gap under the threshold asks nothing and trims; over it asks once
  with the planned count; `generate` acquires the lease, re-prepares, and saves each summary
  before the next summary request and before the main request (cleanup and the final
  selection write classified separately); a message edited during `generate` ends with the
  retryable error and saves nothing past the valid prefix; `continue`, a dismissed question,
  and a timed-out question trim and hand off; an abort after two of four summaries keeps two;
  memory-stop after two of four keeps two, trims the rest, and a second speaker of the group
  uses select-only; continue, reroll, and auto-continue rounds hand off the last round's
  input.

## Slice 4. Tab side of the question and progress (_hard_, `ui-theming.md`)

- `src/ts/network/jobChannel.ts`: the `memoryGap` case (two buttons; the text shows the gap
  tokens, planned calls, and the last task error when present); the job-keyed
  `memoryProgress` map; job end clears its entry. The legacy `progress` handling is
  unchanged.
- `src/ts/stores.svelte.ts`, `src/App.svelte`: the overlay shows the selected chat's job
  entry, else the legacy `hypaV3ProgressStore` (still written by the legacy notice and by
  the client copy at `src/ts/process/memory/hypav3.ts` ~311, ~526, ~653, the legacy
  composition the oracle runs). `HypaV3Progress.svelte`: `k/n` or the embedding queue text,
  the reason line when there is one, and for an initial run "Stop here and continue"
  (captures job and run, disabled while its request is pending).
- `en.ts`, `ko.ts`: question, choices, phases, reasons, button.
- Test: `jobChannel.test.ts`: button mapping `0 → generate`, `1 → continue`, others null; a
  second job's entry and end do not touch the first's; a legacy notice still reaches the
  legacy store. A mounted App/progress test: a chat switch hides and restores the overlay
  without a new notice; the legacy store shows when the selected chat has no entry; a
  selection-phase embedding entry and a reason-less blocking entry render; the stop button
  posts once with the captured job and run.

## Slice 5a. Chat source generation (_hard_, `self-host-server.md`)

- `server/src/data/chatStore.ts`, `server/src/data/resourceStore.ts`: a per-chat in-memory
  source generation, advanced inside the commit of a chat delete, a whole-chat `replace`,
  and a character cascade delete (every write path that performs them, a checkpoint load's
  `replace` included, with no separate advance call); `chatSourceGeneration(chatRef)`, also
  returned with the chat in the synchronous reads `loadJobScope`/`refreshChat` use; an
  in-process `onChatInvalidated(listener)` published after commit, never on rollback. A
  `meta` op does not advance it.
- Test (`chatSourceGeneration.test.ts`, real store on a temp dir): delete, `replace` (also
  one keeping the same message ids, texts, and memory tail), a character delete, and a
  batch containing one of them advance the generation and notify once after commit; a
  rolled-back batch neither advances nor notifies; `meta`, `setText`, and `append` do not;
  an epoch change (`replaceAll`) resets the registry.

## Slice 5b. Detached memory host (_hard_, `self-host-server.md` via 5d)

- New `server/src/prompt/memory/memoryTaskHost.ts`:
  `createMemoryTaskHost({ scope, input, deps: { llm, embeddings, scriptWorkers, tokens,
rootDir, cbsTimeLimits, separatorLimits, now }, signal, fence })` returning a `MemoryHost`
  and the `MemoryTokenizer` built from the input's token policy, as Approach describes.
- Test (`memoryTaskHost.test.ts`): a summary request goes through `requestChatDataOuter`
  (a retried failure retries; `banCharacterset` applies) with source and mode `"memory"`
  and the synthetic job id, and no request trigger runs; `parseChatML` cannot write chat
  variables; the token counter equals the job's for the same policy, including a profile
  tokenizer, a `presetChain` effective preset, a Plugin main model with a server `memory`
  slot, and a group speaker; an aborted signal ends regex, embedding, and request work; key
  text is redacted from errors.

## Slice 5c. Task lifecycle and persistence (_hard_, `self-host-server.md` via 5d)

- New `server/src/prompt/memory/memoryTasks.ts` `createMemoryTasks({ store, kinds, gate,
hostDeps, now })` implementing `MemoryTaskService` plus `start`, `cancel`, `snapshot`,
  `pause`, `resume`, `beginShutdown`, `drain`: the queue and retention limits, the writer
  lease, the start checks, prepare without cleanup, lookahead planning, per-summary
  validated writes, warming, source-generation cancellation, terminal status retention, and
  late-completion rules of Approach.
- Test (`memoryTasks.test.ts`, real store on a temp dir, scripted provider, fake clock): a
  hand-off runs after the release latch, writes one summary per commit, and warms their
  vectors (a later selection with the same settings makes no document embedding request);
  a hand-off during a run replaces the pending input and reruns once; a second chat runs in
  parallel up to the cap; the pending limit and the retained-size cap drop or evict as
  specified (idle inputs first, running and pending never); a summary edit saved between
  two task writes and one after the last both survive; a reset saved meanwhile makes the
  next write skip and the task end; a deleted chat, a deleted, edited, inserted, or
  re-enabled message, a whole-chat `replace`, an epoch change, maintenance, and shutdown
  each end the task without a write past the valid prefix; `acquireSummaryWriter` closes
  the running task's fence (a late provider result writes nothing), and a manual start
  while the lease is held only queues; memory turned off, V2 enabled, a Plugin slot, a
  changed fingerprint, or stored coverage past the input ends `skipped` with the reason; a
  stale retained input is not reused by a manual start, which sets `pendingManual`; a late
  completion after a cancel does not overwrite a newer task's status; a warming failure
  keeps the summaries; every terminal carries `terminalRevision`, including a task skipped
  at start, one cancelled while queued, and one whose first request failed (no commit).

## Slice 5d. Wiring, feed, routes (_hard_, `self-host-server.md`)

- `server/src/app.ts`: construct the service beside `translationRunner`; the maintenance
  listener before the jobs' one; shutdown and drain before the stores close; subscribe to
  `epoch` and `onChatInvalidated`. Not passed to the runner yet; manual admission answers
  `503`.
- `shared/events.ts`, `server/src/data/changeFeed.ts`, `server/src/routes/events.ts`: the
  `memoryTask` frame (the event mapper treats every non-change event as `epoch` today: give
  the new type its own branch) and the `hello` snapshot.
- New `server/src/routes/memoryTasks.ts`: `POST /api/memory/tasks` (`{ characterId, chatId
}`) and `DELETE /api/memory/tasks/:characterId/:chatId`, authenticated, epoch-checked.
- Test: with a test-enabled service, frames reach a socket in order and `hello` reports a
  running task and a recent failure; maintenance and shutdown end a running task without a
  write; an invalidation notice cancels the chat's task; the routes refuse a wrong epoch,
  an unknown chat, and (production default) answer 503.

## Slice 6. Task status and freshness fence in the tab (_hard_, `ui-theming.md`)

- `src/ts/network/eventFeed.ts`: route `memoryTask` frames and the `hello` snapshot to a new
  `src/ts/process/memoryTasks.svelte.ts` with the status map (state, counts, reason, error,
  terminal revision) and the hydration-pending fences of Approach, keyed by
  `chatStatusKey`; clear on epoch mismatch; on reconnect refresh the union of tracked and
  listed chats and clear fences only after adoption.
- Sidebar: a `memory` status in `src/lib/SideBars/chatStatus.ts` (after `generating`); the
  badge and labels take the count from the map (`ChatStatusBadge.svelte`, `Sidebar.svelte`,
  `PinnedChatsRail.svelte`, `MainMenu.svelte`); a character or folder with several
  summarizing chats shows the status without a count.
- `HypaV3Modal.svelte`: `memoryWriteFenced` also holds while the chat's fence holds; a
  refused edit is undone and not replayed; "Summarize now" flushes the chat's pending local
  writes first and shows the `pendingManual` answer; a status line (running `k/n`, last
  failure); "Summarize now" and "Cancel" on the 5d routes (refused with a notice until
  activation).
- `en.ts`, `ko.ts`: status, labels, buttons, the pending-manual notice.
- Test: the modal refuses an edit while a task runs and until its terminal revision is in
  the mirror (a delayed hydration), and accepts after; with a fake clock, a disconnect,
  ten minutes, an empty `hello`, and a delayed hydration keep the fence until adoption; a
  read not adopted because of pending local work keeps it; a tab whose first sight of a task
  is a terminal (a frame or a `hello` entry, including a no-commit `skipped`) with a
  `terminalRevision` its mirror lacks fences until adoption; a late read for an earlier task
  does not clear a newer task's fence; lore writes stay open; the badge
  shows `k/n` and clears on `done`; a reconnect `hello` restores a running task's badge.

## Slice 7. Activation (_small_, `chat-pipeline.md`)

- `server/src/app.ts`: pass `deps.memoryTasks` to the runner; open manual admission.
- Test (`memoryJobs.test.ts`, `memoryTasks.test.ts`, real service): a real send over the
  lookahead line ends `done` and the task's first summary request starts only after the
  job's terminal (a latch, not arrival order); the next send selects the task's summaries
  and makes no document embedding request for them; a manual start from the route runs.

## Slice 8. Guides (_small_, `memory.md`, `persistence.md`)

- `memory.md`: the modes and dispatch order, the parts and hooks (server-only, D12: the
  legacy composition, the shared settings normalization, and the embedding keys and
  processors stay alike in both copies), the writers' lease, save rules, and D15, the task
  service, progress and stop, the final re-check protection, the tests; Invariants and
  Known Hazards updated: remove only what this plan fixed (the summaries lost to an abort,
  the single-write-per-send cost), keep the whole-memory writers outside the fence (another
  tab's modal, the HypaV2 chunk editor, a plugin's chat result).
- `persistence.md`: the source generation, the task's epoch, admitted revision, and content
  validation; per-summary merges; the modal fence until the terminal revision.
- Test: `pnpm check` (doc links), no code change.

## Decisions

The runner takes each default unless the user overrides it. U1–U5 and D11 are the user's.

- U1. A Plugin-format `memory` slot keeps blocking summarization in the job, whatever the
  main model; the settings page and the overlay say why.
- U2. A V3 preset with a local (WebLLM) summarization model stays unsupported on the server,
  with a settings warning.
- U3. An applicable `request` trigger also keeps blocking summarization.
- U4. Gap over `gapConfirmTokens` (preset field, default 10000): ask generate/continue. At
  or under it: continue without asking.
- U5. The question shows the planned summary count; the approved run shows progress only in
  its chat.
- D1. Gap measure: the job tokenizer's `tokenizeChat` total of the uncovered messages
  select-only drops, compared with `>`. History the final re-check drops beyond that is not
  added (it cannot drop the protected entries).
- D2. `gapConfirmTokens` values: integer ≥ 0, 0 asks on any gap, no "never" value.
- D3. Question outcomes: `generate` and `continue` as chosen; dismissed (`null`),
  `timedOut`, and `disconnected` continue; any other value ends the job with `SendError`;
  a job abort propagates.
- D4. Asking again: not while the chat's task is queued or running, and once per job.
- D5. Standard similarity correction: its one inline summary call per assembly stays in
  select-only; the gap measurement's correction query is reused by a `generate` run.
- D6. Lookahead headroom `h`: 15 % of `maxContext`; target clamped at 0.
- D7. Preview, once active: select-only before any blocking check; no history
  summarization, question, or hand-off; the selection write and the correction call as
  allowed. Before activation: today's behavior.
- D8. Task input: the hand-off's captured `MemoryTaskInput`; a manual start reuses the
  chat's retained input only when its source generation and fingerprint are current, else
  marks the chat for the next send. No history rebuild outside a job.
- D9. Task limits: 4 running server-wide, one running and one pending per chat, 32 chats
  pending, 64 MiB of retained inputs with idle LRU eviction, 30 minutes per task, a save
  after every summary, terminal states shown 10 minutes.
- D10. Start checks fail (memory off, V3 not the active method, binding invalid, a
  blocking condition, a local summarization preset, a changed fingerprint, a stale source
  generation, stored coverage past the input): the task ends `skipped` with the reason;
  the next send summarizes as its mode says.
- D11. "Stop here and continue" on an initial summarization: included; initial runs are
  sequential.
- D12. The client copy keeps the legacy composition (oracle parity); the parts, hooks,
  select-only, and the task are server-only. `memory.md`'s both-copies invariant is
  narrowed to that in slice 8.
- D13. Locales: `en.ts` and `ko.ts`.
- D14. Checkpoints (`chat-checkpoints.md`): the auto checkpoint captures the memory
  committed at that moment and does not wait for a task; a checkpoint load takes a temporary
  admission and write fence for the chat before its transaction (cancelling the task) and
  releases it in a `finally`; its `replace` advances the source generation once in the
  commit, which discards the retained input and `pendingManual`; a rolled-back load
  advances and notifies nothing; a later task write never edits a checkpoint.
- D15. Source validation before each summary save, for every production writer: the scan
  interval's message id sequence unchanged, included messages enabled, after the last
  `allBefore`, with the stored-text hash captured with the processed entry; a greeting
  window checks `fmIndex` and the greeting text's fingerprint; the greeting's `undefined`
  memo (serialized `null`) is kept as today. The first failure ends the savable prefix.
- D16. After a refused summary write (`writeSkipped`), a job continues select-only with the
  stored memory and makes its main request (today's concurrent-reset behavior); after a
  changed source (`sourceInvalid`), it ends with a retryable error.

## Open Questions

- A message edited after the hand-off invalidates that window and everything after it
  (D15); a chat edited often while a long backlog is summarized may restart the backlog
  more than once. Measure on a long chat after slice 5c.
- Experimental's rate limiter is per invocation; with tasks of several chats, the
  per-minute limits are per chat, not per provider.
- The memory-stop control is an HTTP route while questions and progress use the job
  channel; there is no tab-to-server control message besides answers today.
- Browser check: the overlay gating, the stop button, the sidebar badge, and the reconnect
  fence need a real-browser pass (`build-test-platforms.md` Browser tooling); until run,
  they are unverified.
