# Long-Term Memory and Embeddings

## Scope

- Owns: the summarization and retrieval memory algorithms (SupaMemory, HypaMemory V2, HypaMemory V3, Hanurai), the
  embedding processors, the rate limiter, local Transformers.js models, the HypaV3 editor modal, the progress overlay,
  and the embedding playground.
- Paths: `src/ts/process/memory/*`, `src/ts/process/transformers.ts`, `src/lib/Others/HypaV3Modal.svelte`,
  `src/lib/Others/HypaV3Modal/*`, `src/lib/Others/HypaV3Progress.svelte`,
  `src/lib/Playground/PlaygroundEmbedding.svelte`; the server copies in `server/src/prompt/memory/*`,
  `server/src/prompt/embeddings.ts`, `server/src/prompt/transformers.ts`, `server/src/prompt/transformersWorker.ts`,
  `server/src/data/vectorCache.ts`; `shared/taskRateLimiter.ts`.
- Not here:
  - The job around the memory step (`server/src/prompt/runner.ts`) → `server-generation.md`.
  - Settings UI placement → `settings-i18n.md` (`MemorySettings.svelte`, menu 2, `/settings/memory`).

## Files

### Algorithms

- SupaMemory, HypaV2, and Hanurai run only in the server job (`server/src/prompt/memory/`; `Server`, below). Their data
  shapes stay in `shared/memory.ts` (`HypaV2Data`, `SerializableHypaV2Data`, `convertOldToNewHypaV2Data`).
- `Chat.supaMemoryData` is `lastId + '\n' + text`, or `hypa:\n` followed by JSON `HypaData[]` (`asHyper`).
- `memory/hypav3.ts`: the V3 implementation the tab keeps for the modal (resummarize, reroll) and the oracle; a send's
  V3 step is the server's port, split into parts (`HypaV3 parts`, below).
  - Entry: `hypaMemoryV3`, the legacy composition only. Dispatches to `hypaMemoryV3Main`, or to `hypaMemoryV3MainExp`
    when the active preset has `useExperimentalImpl`; the server copy has no mains.
  - Exports: `summarize(oaiMessages, isResummarize?, context?)` (`SummarizeContext`, passed to `requestChatData`),
    `getCurrentHypaV3Preset`, `createHypaV3Preset` (re-exported from `shared/hypaV3Presets.ts`), `HypaV3Settings`,
    `SerializableHypaV3Data`, `SerializableSummary`.
  - Private: the processor subclass `HypaProcesserEx`. In both copies, contextual chunk vectors are keyed by their
    context-qualified cache key so identical paragraphs in different summary contexts keep their own vectors.

### Embedding processors

- `memory/hypamemory.ts`: the shared V1 embedding engine, used well beyond memory.
  - `HypaProcesser` has `addText`, `similaritySearchScored`, and `getEmbeds`.
  - Also exports the `HypaModel` union, the `localModels` registry, and `similarity`/`cosineSimilarity`/`contextHash`.
- `memory/hypamemoryv2.ts` `HypaProcessorV2`: the newer generic processor, used only by experimental V3. Supports
  batching, rate limits, and grouped contextual documents.
- `memory/contextualEmbedding.ts`: `ContextualEmbeddingProvider`, `isContextModel`, `getContextProvider`. The Voyage
  contextual models (Context 3 and 4, `voyageApiKey`) are the only providers.
- `shared/memory.ts` `VOYAGE_CONTEXT_MODELS` and `VOYAGE_EMBEDDING_MODELS`: the Voyage models by `hypaModel` value, with
  `isVoyageContextModel`, `isVoyageEmbeddingModel`, and `voyageKeyMissing`; both copies and the settings options read
  them.
- The `/v1/embeddings` models (Voyage 4 Large, 4, and 4 Lite) go through `voyageEmbeds` (`hypamemory.ts`, and its server
  copy) with `input_type` `document` for stored texts and `query` for a search.
- `shared/taskRateLimiter.ts` `TaskRateLimiter` (re-exported by `memory/taskRateLimiter.ts`; the server's memory code
  uses the same file): per-minute and concurrency limits, `failFast`, `TaskCanceledError`.
- `process/transformers.ts`: Transformers.js wrappers backed by Cache Storage `tfCache`.
  - `runEmbedding`: caches only the extractor, not the vectors.
  - `runSummarizer`, `runImageEmbedding` (captioning), `runVITS`, `runTransformers`.

### UI

- `HypaV3Modal.svelte` and its children in `HypaV3Modal/` edit a synced copy of the current chat's `hypaV3Data` (the
  `hypaV3Data` prop) and save every change with `setChatMeta`: search, filters, categories, tags, bulk edit,
  resummarize, reset, and V2→V3 conversion. A send's memory data is written by the job and by the background memory
  task.
- `memoryWriteFence` applies the fence (`Memory writes`, Invariants): `isLocalSend` and `generatingChatKeys` with the
  `chatGenerating` notice, `memoryTaskFenced` (`src/ts/process/memoryTasks.svelte.ts`) with the `memoryTasks.editFenced`
  notice. See [ui theming](ui-theming.md) for the fence states and [chat store](chat-store.md#server-memory-writes) for
  the rule.
- A refused conversion reports no success. The saving effect never writes the empty default of a chat without memory
  data; the immediate initialization write is quietly refused while fenced.
- Under the header the modal shows the chat's task status (queued, running `k/n`, the last notable end with its reason),
  "Summarize now" (`startMemoryTask`, its refusals include the `discarded` and `serverJob.refusedDraft` notices; a
  `pendingManual` answer says the next send hands the chat off), and "Cancel" (`cancelMemoryTask`). Lore writes are not
  fenced by tasks.
- The modal's resummarize and reroll actions capture the open chat (`currentChatRef`) and its plugin context
  (`capturePluginContext`) when the action begins and pass them to `summarize`.
- The bulk resummary (`resummarizeBulkSelected`) keeps its selection as `BulkResummaryState.targets`, and Retry and
  Apply resolve them in the copy as it is then (`resolveBulkTargets`). When that fails they refuse with
  `hypaV3Modal.bulkResummaryTargetsGone` and change nothing; the result stays shown until Cancel.
- Cancel, Apply, Retry, and a new run discard earlier requests, so late summary or translation results and failures show
  nothing.
- A sync replacement from another writer or a fenced edit's undo clears the bulk-edit selection and closes the tag
  manager. Bulk resummary Apply also closes it.
- Local summary deletions drop deleted selection indexes and shift later indexes down; a tag manager whose target is
  deleted or shifts closes and resets its editing state.
- Tag handlers and rendering ignore a missing summary, and delete confirmations resolve the captured summary by object
  identity before removing anything.
- `HypaV3Modal/utils.ts` `processRegexScript`: routes messages through `risuChatParser` and the server transform's
  `editprocess` (`serverProcessScript`; `scripts-triggers.md`); without a context (a chat not saved on the server yet)
  the CBS-parsed text stays.
- `HypaV3Progress.svelte` renders the selected chat's `memoryProgress` entry (`memoryProgressStore`, with "Stop here and
  continue" for an initial run), else the legacy `hypaV3ProgressStore` ([ui theming](ui-theming.md)).

## Flows

### Selection, in `assemblePrompt`

- Memory runs only when `nowChatroom.supaMemory` is set on the character or group.
- The priority order is `db.hanuraiEnable` → `db.hypav2` → `db.hypaV3` → otherwise `supaMemory` (as selected by
  `supaModelType`).
- The result is written back to the current chat: `hypaV2Data`, `hypaV3Data`, or `supaMemoryData`.
- `memoryAlgorithmType` is written by the UI and never read.

### V3 standard flow

1. Summarize the oldest eligible chats into `Summary {text, chatMemos:Set<string>, isImportant, categoryId?, tags?}`.
2. Select summaries within the memory token budget, in the order important → recent → similar (embeddings) → random.
3. Record the selection in `metrics`.
4. Prepend a `<Past Events Summary>` card with `memo:'supaMemory'`.

### V3 `summarize`

1. Replaces inlay tokens with `[Image]`.
2. Expands `{{slot}}` and runs `parseChatML`.
3. Calls `requestChatData(..., 'memory')` for the submodel, or WebLLM `chatCompletion` for local models.
4. Strips thought blocks from the result.

### Tab embedding routing

- `HypaProcesser.getEmbeds` tries, in order: contextual Voyage, then `localModels` (Transformers.js), then custom,
  OpenAI, or Voyage `/v1/embeddings` APIs through `globalFetch`.
- Vector records are cached in LocalForage `hypaVector`.

### Server

A send's memory step runs in the job (`server/src/prompt/assemble.ts`). The browser code above serves the HypaV3 modal
and the playground.

- `server/src/prompt/memory/{supaMemory,hypav2,hypav3,hanurai}.ts`: the four algorithms. Each takes a `MemoryHost`
  (`memory/host.ts`) first; the type's comments say what each member stands for.
- `MemoryHost.completions`: an answer that is not JSON is a failure, and a successful one that carries the stored memory
  key is refused.

### Server persistence

- `assemblePrompt` writes memory as `meta` operations on the chat as stored then (`AssemblyHost.writeMemory`).
- HypaV2, SupaMemory, and Hanurai write once, what the algorithm returns: `hypaV2Data` on success; `supaMemoryData` and
  `lastMemory` with the stored values as fallbacks; nothing for Hanurai.
- HypaV3 writes each new summary at its checkpoint (`mergeHypaV3Write` through the checkpoint's `merge`) and then,
  unless the step ended with an error, the selection (`mergeHypaV3SelectionWrite`). A provider failure keeps the
  summaries already saved and writes nothing more (an orphan cleanup with no checkpoint before the failure is not
  saved).
- The V3 and V2 values are placed onto the stored value, since a change can be saved during the summarization await: the
  doc comments of `mergeHypaV3Write` and `mergeHypaV2Write` (`shared/memory.ts`) have the matching (`summaryKey`) and
  the skip conditions.
- The checkpoints pass `metricsRecomputed` false, so the selection's metrics arrive with the selection write.
- A skipped write leaves a server warning, and the stored value stands. A skipped V2 write costs that send's summaries.
  A skipped V3 checkpoint ends the summarization with `writeSkipped`, keeping the summaries committed before it
  (experimental can also discard later summaries whose requests had already started).
- The writes happen before the provider request, and a preview makes them too.
- An algorithm's error is the send's `throwError`; Hanurai's "too many tokens" is the job's error without the inlay
  error message.

### HypaV3 parts

`server/src/prompt/memory/hypav3.ts`, server only; each export's doc comment holds its contract.

- `prepareHypaV3` (`HypaV3PrepareOptions`): the immutable `HypaV3Prepared`, with its `HypaV3Ledger` token accounting,
  `budget`, and `coverageAhead`.
- `planHypaV3Summaries`: the windows and a stop reason, without a request; a prediction, never a cursor after a failure.
  `{ lookahead: true }` plans what the next sends will need.
- `executeHypaV3Plan` (`HypaV3ExecutionHooks`): `HypaV3ExecutionResult`, with its end reason and the last committed
  `baseline`. `emptyHypaV3Execution` is the state before any window.
- `selectHypaV3`: each main's selection, from `appliedHypaV3Summaries` only. Deferred summaries stay in the returned
  memory, with their indices in `metrics.lastDeferredSummaries`, which the HypaV3 modal marks as ready. `trimUncovered`
  reports the `gap` and the `protected` tail; `correction` reuses a similarity-correction query.
- `warmHypaV3Vectors`: a task's new summaries' document vectors through the active processor.
- `forecastHypaV3`: for the context meter, after a step's execution: `reserved`, `summarizeIn`, `lookaheadIn`; it shares
  the plan's `scanHypaV3Window`.
- `hypaV3SourceHash` and `createHypaV3SourceValidator`: source validation (`Summary writers`, below).
- The server's `hypaMemoryV3` composes the parts with no options or hooks and keeps the fixture's results and each
  main's error position (standard reports a planning exhaustion after summarizing the windows before it, experimental
  before any request); production calls the parts.

### HypaV3 job modes

`server/src/prompt/assemble.ts` `hypaV3Step` dispatches, and the runner's `confirmMemoryGap`
(`server/src/prompt/runner.ts`) asks; the doc comments of both hold the rules. With the server's memory task service
(production):

- A `preview`/`previewPrompt` selects only: no history summary, question, or hand-off; the selection write and
  standard's one similarity-correction call stay.
- An input job blocks (summarizes in the job, under the chat's writer lease) when its summary requests need the job: the
  `memory` slot resolves to `LLMFormat.Plugin` (`pluginModel`; the tab must stay connected) or the owner has an
  applicable `request` trigger (`requestTrigger`).
- Any other input job selects only: the stored summaries, then the uncovered history trimmed behind the protected tail.
- A gap (the trimmed history's `tokenizeChat` total) over the preset's `gapConfirmTokens` asks `memoryGap` with the
  planned call count. The answer serves the job's later speakers and rounds.
- `generate` runs an initial summarization: a fresh prepare and plan on the memory stored now, windows one at a time
  with the stop control, then a trimmed selection.

Without a service every step blocks.

A preset using a local WebLLM `summarizationModel` (anything other than `subModel`) fails wherever a summary is
attempted, and a background task ends `skipped` with `localSummarization`; a send that needs no new summary still works.

### Summary writers

- Every production writer of new summaries saves each accepted summary at its checkpoint, so a blocking or initial run
  holds the chat's summary writer lease (`MemoryTaskService.acquireSummaryWriter`; a select-only job writes no summary),
  and a task starts only while no lease is held.
- Taking the lease ends the chat's running task (`cancelled`, reason `writerLease`; its write fence closes at once, so a
  late provider result writes nothing) and makes hand-offs and manual starts only queue until `release()`.
- The checkpoint merges onto the stored value from the executor's `baseline`, never the merged stored value: a
  concurrent edit stays stored and keeps the next merge on the divergent path.
- Before each save the executor revalidates the accepted prefix and the window against the chat as stored now
  (`createHypaV3SourceValidator`, whose doc comment has the checks). The first failing window ends with `sourceInvalid`
  and is dropped with every later one. Decision: HypaV3 Background Memory D15, archive.
- A job then ends with the retryable "the chat changed during summarization" error and no selection write; after
  `writeSkipped` (a reset or a moved cursor saved meanwhile) it selects only from the memory stored now and makes its
  main request. Decision: HypaV3 Background Memory D16, archive.
- The job's last write is `mergeHypaV3SelectionWrite` (`shared/memory.ts`), which adds no summary and recreates none
  after a reset.

### Background memory task

`server/src/prompt/memory/memoryTasks.ts` `createMemoryTasks`, on the detached host `memoryTaskHost.ts` (their doc
comments hold the queue, start checks, ends, and the host's requests; `MEMORY_TASK_LIMITS` the caps). Wiring, routes,
and the feed frame are in [server generation](server-generation.md).

- Right before a job emits `done`, the runner hands the service the job's `MemoryTaskInput` (`shared/jobs.ts`) when a
  lookahead plan says summaries are due or a manual start waits (`pendingManual`).
- A task writes through the [persistence rules](chat-store.md#server-memory-writes), then warms the saved summaries'
  vectors (a failure is `done` with reason `warmingFailed`).
- A failed start check ends the task `skipped` with a reason (`localSummarization` for a local summarization model,
  `staleInput`, and the rest in `createMemoryTasks`'s doc comment); the modal's task status (`UI`, above) shows it as
  the last notable end.
- A manual start (`POST /api/memory/tasks`) reuses the chat's retained input when its epoch, source generation, and
  fingerprint are current, else answers `pendingManual` and the next input job hands off even when nothing is due.

### Progress and the stop control

- Every run also sends a `memoryProgress` notice (`shared/jobs.ts` `MemoryProgress`), opened before any legacy
  `progress` notice of the same work.
- An initial run registers its stop control (`RunningJob.registerMemoryControl`,
  `POST /api/generations/:id/memory-stop`, the owner client only): the window in progress finishes and is saved, no
  further window starts, the selection trims the rest, the chat is handed off, and the job's later speakers and rounds
  select only.
- A task reports through its `memoryTask` status frames, not `memoryProgress`.
- HypaV3's progress overlay is fed by `progress` notices and, per job and chat, by `memoryProgress` notices
  (`memoryProgressStore` in `stores.svelte.ts`, kept by `jobChannel.ts`). The tab closes an overlay a job left open and
  drops the job's entry when that job ends (`endJobChannel`), since an abort closes the job's channel before a closing
  notice can arrive.

### Protection at the final re-check

The history entries a select-only, initial, or `writeSkipped` selection kept (its protected tail) are never removable in
the later token re-check (nor is a merged system message containing one; an `editRequest` result is removable only when
it matches a removable entry), so a prompt still over the context with them ends with the too-many-tokens error.

### The no-memory trim question

- When a memory method is set (the gate's second half), the owner's `supaMemory` is off, and the no-memory trim would
  drop chat history (not only the example dialogue or the new-chat marker), `assemblePrompt` calls
  `AssemblyHost.memoryTrim.confirm()` before trimming.
- The runner's `confirmMemoryTrim` (its doc comment has when it skips the question) asks the owner's tab a `memoryTrim`
  channel question (`shared/jobs.ts`; the tab shows its localized `alertSelect` in `jobChannel.ts`).
- On the `MemoryTrimChoice`, `memory` turns the owner's toggle on in the store, `once` trims, `ignore` trims and writes
  `memoryTrimAck`. One answer serves the job (`JobRunState.memoryTrim`, `memoryTrim.enabled()`).
- An unanswered question (timeout, a lost owner) ends the job like a Lua question; an invalid answer ends it with
  `SendError`.
- The late removable-message cleanup after formatting is not covered: it is a safety net that also runs with memory on.

### Server embeddings and local models

- `server/src/prompt/embeddings.ts`: `HypaProcesser`, `HypaProcessorV2`, and the Voyage providers on an `EmbeddingEnv`
  bound to one job (`createEmbeddings(...).forJob`). Its header lists what differs from the tab.
- A contextual answer whose group count or a group's vector count differs from what was sent is a
  `ContextualEmbeddingCountError`, checked for the whole answer before any vector of it is stored.
- `server/src/data/vectorCache.ts`: the vectors, in `save/data/vectors.sqlite`. One cache for all clients; browser
  vectors are not migrated.
- `server/src/prompt/transformers.ts` (its header) and `transformersWorker.ts`: the local models in one child process.
- Other users of the server embeddings: `additionalInformations` and image captions in `assemblePrompt`, the
  dynamic-asset step of `server/src/prompt/scripts.ts` (`editoutput` and the display transform's `editdisplay` with
  `dynamicAssetsEditDisplay`, with or without regex scripts; embeddings start only for an uncached unknown marker), Lua
  `similarity` and `v2CheckSimilarity` (`LuaBindingServices.similarity`), and the similarity effects.

## State

- DB settings:
  - Algorithm flags: `hypaMemory`, `hypav2`, `hypaV3`, `hanuraiEnable`, `hanuraiSplit`, `hanuraiTokens`,
    `memoryAlgorithmType` (unused).
  - Models and keys: `hypaModel`, `supaModelType`, `supaMemoryKey`, `voyageApiKey`. `supaMemoryKey` is edited only on
    the Memory page, one input for summarization and embeddings; the Playground embedding tool shows its status and
    links there ([settings-i18n](settings-i18n.md)), and keeps its draft (model, query, data, results) in module state,
    so the round trip through the settings keeps it.
  - Sizing: `hypaChunkSize`, `hypaAllocatedTokens`, `hypaCustomSettings`.
  - Presets: `hypaV3Presets`, `hypaV3PresetId` (the selected preset's id; `selectedHypaV3Preset` in
    `shared/hypaV3Presets.ts` resolves it). Both travel in the `hypaV3Presets` record as `{ items, selectedId }`.
    - Budget mode: `budgetMode` (`"ratio"` or `"tokens"`) says how the memory budget, the background summary headroom,
      and the extra summarization are given. Ratio mode reads `memoryTokensRatio`, `lookaheadHeadroomRatio`,
      `extraSummarizationRatio`; token mode reads `memoryBudgetTokens`, `lookaheadHeadroomTokens`,
      `extraSummarizationTokens`. Both share `hypaV3Data`; `recentMemoryRatio` and `similarMemoryRatio` split the memory
      budget in both.
    - `resolveHypaV3Budget(settings, C, maxResponse)` (`shared/hypaV3Presets.ts`) gives the step's thresholds, and its
      doc comment the arithmetic of both modes. A token mode amount that does not fit is reduced, never refused:
      `reduced` lists each one, and the server reports it as `ContextReport.memory.budgetReduced`
      ([chat pipeline](chat-pipeline.md)).
    - The server seeds a missing or empty list with one token-mode preset (`normalizeHypaV3Presets`); a stored or
      imported preset without `budgetMode` stays in ratio mode. The upstream export writes token-mode presets as ratios
      ([upstream export](backup-sync-hub.md#upstream-database-export)).
- Per-chat fields: `supaMemoryData`, `hypaV2Data`, `hypaV3Data`, `lastMemory`, `memoryTrimAck` (the owner's
  `supaMemoryOnCount` when the user answered "don't ask again" to the trim question).
- Per-owner fields (character or group): `supaMemory` (the toggle), `supaMemoryOnCount` (its off→on transitions; read
  through `supaMemoryOnCount` in `shared/characters.ts`).
- Stores: `hypaV3ModalOpen`, `hypaV3ProgressStore`, `memoryProgressStore` (per job). The tab's task statuses and fences:
  `src/ts/process/memoryTasks.svelte.ts` (module state, keyed by `chatStatusKey`).
- Server process memory: the memory task registry (running, queued, and retained inputs, `pendingManual`, terminal
  statuses, leases) and the chats' source generations; neither survives a restart.

## Coupling

- The tab's HypaV3 depends on `requestChatData`, `webllm`, `ChatTokenizer`, `parseChatML`, `risuChatParser`,
  `inlayTokenRegex`, localforage, and Transformers.js. The server ports depend on `MemoryHost` only.
- Users of the tab's `HypaProcesser`: `files/multisend.ts`, `mcp/graphmem.ts` (the tab's graph memory host), HypaV3, and
  the playground. The rest use the server's (`server/src/prompt/embeddings.ts`).

## Invariants

### Data and memo values

- Never persist a runtime `Set`. Use the `toSerializable*` and `to*Data` converters in both directions.
- `chatMemos` reference `Message.chatId` values. Rewriting chat IDs orphans summaries, which get cleaned unless
  `preserveOrphanedMemory` is set.
- The memory card `memo` values `supaMemory` and `hypaMemory` are special-cased later in prompt assembly
  (`assemblePrompt`). Do not rename them.

### Memory writes

- A memory write is built from the chat as stored at the write (`writeMemory`'s builder argument, a task's `chatMeta`
  read in its checkpoint), never from the copy the algorithm read before an await: the fields go through the merges of
  `Server persistence`, and the others fall back to the stored values.
- A new summary algorithm or summary field keeps that rule (and `summaryKey`'s order: the last message id is where the
  next summary starts).
- A chat has one writer of new HypaV3 summaries at a time. Every such writer validates each window's source before its
  save and saves each summary on its own; the cursor never passes history whose summary was not saved.
- Only a job removes orphaned summaries (its checkpoints and selection write carry its cleanup, from a fresh source); a
  task prepares without cleanup.
- The HypaV3 modal and the local lore draft (`localLoreDraft.svelte.ts`) write nothing while a send of this tab or a job
  this tab knows of runs in the chat, and the modal nothing while the chat's memory task fence holds (from a task's
  start or queueing until the chat mirror holds its `terminalRevision`); a refused change is undone in the copy, never
  kept to be written after the job or task.

### Deferred stored summaries

- The job (with a task service) prepares with `deferStored`, so a summary a task made ahead of need replaces its
  messages only once the original rules would have summarized them. The task prepares without it: its lookahead plan,
  like the job's, starts at the stored coverage.
- `deferredSteps` turns the stored summaries into windows, and `deferredStepCount` replays the original rules over them
  as the history grew; their doc comments hold the window and stop rules.
- While the ordinary plan from that cursor would request a summary, the next stored summary comes in, so no stored
  history is summarized again; it can reach into the protected tail (after `queryChatCount` grew).
- A step makes summaries only once every stored one is in.
- The result is close to, not the same as, the original rules: a stored window differs from the one the ordinary plan
  would scan when a lookahead plan cut it at the protected tail, or after an edit or merge, and the replay then takes
  the stored window whole (up to one window earlier than the original rules).
- The replay is stateless (message deletion, a larger context, or a lore swing in the rest of the prompt can bring
  messages back raw) and keeps the original rules' pause between the target and `C`.

### Token accounting

- V3 token accounting reserves memory tokens, keeps `queryChatCount` recent chats, and in production keeps the response
  budget: the job (with a task service) and the task prepare with `responseCorrection: false`, so memory plans, selects,
  and trims within `maxContext − maxResponse`, the prompt budget of the no-memory trim, the final recheck, and the
  context meter.
- A blocking run whose plan reaches the protected tail over the context (`cannotSummarizeFurther`) runs its windows and
  then selects with `trimUncovered`, as an initial run does; the too-many-tokens error comes only when the real card and
  the protected tail do not fit.
- The no-option compositions (the fixture, the `memoryTasks: "disabled"` test override) and HypaV2 keep the legacy
  subtraction in their own count, which can plan up to the whole context; the job's final recheck then drops removable
  entries to keep the response budget free, never HypaV2's last two chats (the job protects them, so the recheck ends
  with the too-many-tokens error instead).

### Server and tab copies

- A behavioral change covers both implementations, standard and experimental, in the server's parts where it applies;
  the client's `hypaMemoryV3Main` and `hypaMemoryV3MainExp` change only with the legacy behavior both copies share.
- Only the legacy composition, the shared settings normalization (`createHypaV3Preset`), and the embedding keys and
  processors stay alike in both copies (`src/ts/process/memory/` and `server/src/prompt/memory/` with
  `server/src/prompt/embeddings.ts`); a change to them is made in both.
- One exception: the server's contextual document keys carry the chunk's position and a key version, and its processors
  embed a partially cached group whole, check each group call's vector count, send each contextual request through the
  processor's rate limiter (`embeddingRequestsPerMinute`, `embeddingMaxConcurrent`, abort, progress), and take an
  in-memory contextual hit by its cache key, not the item id.
- The tab's copies keep the old key and grouping because their embedding path does not run in production (the HypaV3
  modal uses only `summarize`). A later change to the tab's copies adopts the server's key.
- The parts, hooks, select-only, the lease, source validation, and the task are server-only. Decision: HypaV3 Background
  Memory D12, archive.
- So is the token budget mode: the tab's copy reads the ratio fields only and never `budgetMode`, so its parity with the
  legacy composition holds for ratio mode.
- SupaMemory, HypaV2, and Hanurai exist only on the server. The server copies' statements and texts are the captured
  algorithms', except for Hanurai's corrected prefix length and kept-document duplicate check;
  `server/src/tests/fixtures/memory/algorithms.json` is never regenerated.

### Embedding cache keys and limits

- The embedding keys stay inside `embeddings.ts` and the runner's `MemoryHost`: no CBS text, Lua value, notice, error,
  log line, or cache row carries one.
- Embedding cache keys must include the model identity. Voyage contextual keys also include the group hash; their suffix
  names the `hypaModel` value, so Context 3 keeps its `|voyageContext3` keys.
- On the server a contextual document key ends with `|chunk-cache-v2|index:<n>` (`contextualChunkCacheKey`, the chunk's
  0-based position in its group, a group of one included), so the same text at two positions of a group never shares a
  vector; vectors cached under the earlier keys miss once and are embedded again.
- A group is taken from the cache only when every member hits; otherwise it is embedded whole, in its original order,
  and the results map to the chunks by identity, never by text.
- `HypaProcessorV2` keeps the query vectors of the Voyage models (both kinds) under `|query`: a query is embedded with
  `input_type: "query"` and differs from the document vector of the same text. `HypaProcesser` caches no query.
  `testText` caches by raw text only.
- Adding a local embedding model means updating `HypaModel`, `localModels.models`, `localModels.gpuModels`, the narrower
  `EmbeddingModel` union in `transformers.ts`, and the options in both settings and the playground.
- `TaskRateLimiter` rejects `maxConcurrentTasks > tasksPerMinute`.

### The memory toggle count

- Every core-app path that turns `supaMemory` on bumps `supaMemoryOnCount` (the sidebar toggle in `Toggles.svelte`,
  HypaV3's `alwaysToggleOn` in `characterStore.svelte.ts`, the trim question's `memory` answer in the runner, a plugin
  character applied over the same `chaId` in `applyPluginCharacter`); otherwise a chat's "don't ask again" outlives the
  turn-on.
- The count stays in the tab (the server only reads it, except the runner's own answer): a server-side count would
  double-count the tab's bumps unless every one of them moved.
- A plugin's copy never replaces the stored count (`applyPluginCharacter` writes the stored value, plus one on a
  turn-on). Other raw record writes (a plugin character with another `chaId`, a new character) are not counted.

## Recipes

- Add or change a top-level algorithm: the selector in `MemorySettings.svelte`, the fields in `shared/sections.ts` and
  their defaults in the server normalizer, and the branch plus persistence in the server's `assemblePrompt`. Verify the
  `supaMemory` gate and the priority order.
- Add an embedding model: `hypamemory.ts` (`HypaModel`, `localModels`, `getEmbeds`), `hypamemoryv2.ts:getAPIEmbeds`,
  `transformers.ts` `EmbeddingModel`, and the UI options. A Voyage model is one entry in `VOYAGE_EMBEDDING_MODELS` or
  `VOYAGE_CONTEXT_MODELS` plus its `HypaModel` value; the settings list both tables.
- Add a contextual provider: `contextualEmbedding.ts`, the grouped paths in `HypaProcessorV2`, and
  `HypaProcesserEx.addSummaryChunksContextual`.
- Change V3 behavior: the server's parts (both implementations; the job step and the task call them), the client's mains
  when the change reaches the legacy composition the fixture pins, `HypaV3Settings`, `createHypaV3Preset`, and the
  settings bindings.
  - A memory-relevant setting the task reads also joins `memorySettingsFingerprint` (`server/src/jobs/jobScope.ts`).
  - The shared constructor defaults invalid settings (numbers must be finite; `maxChatsPerSummary` and `queryChatCount`
    must be integers >= 1, `gapConfirmTokens` and the three token amounts integers >= 0, `lookaheadHeadroomRatio` in [0,
    1), `budgetMode` `"ratio"` or `"tokens"`), including through the server normalizer.
  - A setting that sizes the budget goes through `resolveHypaV3Budget`, never a site's own formula.
  - Server host capabilities also need `MemoryHost`, the runner adapter, and the fixture's `hostOf`.
  - The server alone runs valid summary separators through `MemoryHost.regex`, sequentially with at most 1,000 ms per
    operation and a 5,000 ms cumulative chunking budget (the production `MemoryHost.separatorLimits`); invalid patterns
    keep the double-newline fallback. Worker errors return memory before embedding work starts. The tab keeps its
    synchronous separator.
- Add summary metadata: the serializable types in `shared/memory.ts` (with `HypaV3Data`, `Summary`, and `DISPLAY_MODE`),
  `HypaV3Modal/types.ts`, the modal, and its child components. Keep the modal's `$derived`/`$effect.pre` patterns.

## Tests

- Focused:
  `pnpm --silent test:agent src/ts/process/memory src/ts/process/memoryTasks.test.ts src/lib/Others/HypaV3*.test.ts src/lib/Setting/Pages/MemorySettings.*.test.ts`
  for the tab; `pnpm --silent test:agent server/src/tests/{memory*,hypaV3*,embeddings,vectorCache,transformers}.test.ts`
  for the server.
- `slow`: `pnpm --silent test:agent --tags-filter=slow server/src/tests/{hypaV3Limits,transformers}.test.ts`
  ([test-harness](test-harness.md) `Slow-test table`).
- `e2e`: `e2e/perChatSends.spec.ts` (held SupaMemory step), `e2e/lazyChats.spec.ts` (modal cold-switch smoke),
  `e2e/welcomeAndChatSettings.spec.ts` (custom embedding controls).
- Oracle fixture: `server/src/tests/fixtures/memory/algorithms.json`, never regenerated (its `README.md`).
  `src/ts/process/memory/memoryOracle.test.ts` runs the client against it, `server/src/tests/memoryAlgorithms.test.ts`
  the server ports over a fake host (`hostOf`).
- `createServerContext` overrides: `generationHypaV3SeparatorLimits` lengthens the separator limits;
  `memoryTasks: "disabled"` removes the task service.
- `createFakeMemoryTasks` (`server/src/tests/memoryJobs.test.ts`) stands in for the service: hand-offs and leases
  recorded, status and `pendingManual` set by the test.
- Fences: `src/lib/Others/HypaV3Modal.fence.test.ts`; `src/ts/storage/tests/localLoreDraft.fence.test.ts`, over the real
  chat module.
- Not tested: Voyage models in the Playground; modal search and category editing; standalone rate-limiter behavior;
  browser Transformers wrappers.
- Not tested end to end: the runner's completion-key check or its `captionImage` and local-generation wiring.

## Known Hazards

### Issues

- `memoryAlgorithmType` can disagree with the actual boolean flags on old saves.
- The modal and lore-draft fence knows only this tab's sends and the jobs it follows or sees locked: another tab's modal
  (no job ownership on the change feed), the HypaV2 chunk editor (`AlertComp.svelte` `setHypaV2ChunkText`), and a
  plugin's whole-chat result (`applyChatResult`) still write a whole memory value, and one that lands after the job's
  write replaces the job's summaries (`meta set` replaces the field).
- The job's own write keeps a change saved before it. A memory task's writes fence the modal of every connected tab (its
  `memoryTask` frames), but a plugin's whole-chat result that lands after a task's write still replaces its summaries.
- An edit right after a refused final job hydration can still use a stale modal or lore copy: the job fence drops before
  the idle refresh catches up, and a whole-field write can replace the job's data (`chat-store.md`, job hydration and
  idle refresh).
- Experimental's rate limiter is per execution: successive runs of one chat and simultaneous runs of several chats share
  no provider-wide allowance.
- Not checked in a real browser: the overlay's per-chat gating, the stop button, the sidebar memory badge, and the
  reconnect fence.
- Voyage `/v1/embeddings` batches are 50 texts per request, with no per-request token count: 50 long texts can pass
  Voyage 4 Large's 120K-token request limit and fail.
- The contextual batching counts inputs and chunks, not tokens either (Voyage's API reference gives 120K total tokens;
  its newer contextual guide 32K without `enable_auto_chunking`, which these requests do not set).
- The Voyage group hash is a 32-bit hash of the group's texts (joined with `\0`), so two different groups can still
  share a key.
- A cancelled `TaskRateLimiter` batch leaves an already scheduled rate-window retry timer alive until the window
  advances (up to 60 seconds); that timer starts no task.
- The custom embedding URL is fetched directly by the server with no local-target restriction.
- The catalogue's Transformers.js generation models publish no 8-bit `model_quantized.onnx`: they do not load in the
  browser. The server loads their `fp32` weights, so a job can use `opt-350m` and `tiny-random-mistral`;
  `gpt2-large-conversational` has no usable file in either place.
- The Transformers `EmbeddingModel` union names only MiniLM and nomic, while `localModels` lists more models.
- Unconfirmed: `HypaProcesser` keeps the original comparator `a.similarity > b.similarity ? -1 : 0` (not a total order);
  whether a pathological input orders wrongly is not established.

### Limitations

- A message edited after a hand-off invalidates its window and every later one: a chat edited often while a long backlog
  is summarized can restart the backlog more than once (not measured). Decision: HypaV3 Background Memory D15 and D16,
  [archive](../archived-plan/README.md).
- A select-only send leaves out the oldest uncovered history that does not fit the context (the protected tail always
  stays) until a task covers it; a task that fails or is skipped (shown in the modal; a failure also as the gap
  question's `lastTaskError`) leaves the gap for the next send's hand-off or question. Decision: HypaV3 Background
  Memory, "Modes of the V3 step" and D10, [archive](../archived-plan/README.md).
- `voyageApiKey` and `hypaCustomSettings.key` are in the client-readable `secrets` section: the tab reads them, and the
  job's settings projection holds them. Only `supaMemoryKey` is write-only. Decision: `shared/sections.ts` `secrets`.
- The embedding cache key names the model, not the endpoint: a custom server changed under the same model name reuses
  the old vectors. Decision: `server/src/prompt/embeddings.ts` header.
- The server and the tab do not share vectors or model files, and their local models can differ in weights revision and
  kernels: a ranking near a tie can differ between the two paths. Decision: `server/src/prompt/embeddings.ts` header.
- The Transformers.js child process has no memory limit of its own. The queue bounds admitted task count and queued
  payload size, but not a running task's inputs or model allocations; system or container memory pressure can still end
  the server. Decision: `server/src/prompt/transformers.ts` header.

### Gotchas

- The vector cache's 256 MiB default bounds vector bytes, not the SQLite file, its index, or WAL. Eviction runs
  synchronously on the server thread, at most 256 rows per `set` (`trimRowsPerSet`) in the insert's transaction,
  continuing toward 90% on later inserts; a vector that still cannot fit is skipped. Startup trims an over-bound cache
  to 90% before serving.
- On the server, HypaV3's dot products and sorts still run on the main thread, outside the CBS limits. Summary separator
  matching runs on script workers under deadlines; a task's deadline starts when a worker takes it, so queue wait can
  extend the chunking step beyond its budget.
