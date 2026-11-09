# Long-Term Memory and Embeddings

## Scope

- Owns: the summarization and retrieval memory algorithms (SupaMemory, HypaMemory V2, HypaMemory V3, Hanurai), the
  embedding processors, the rate limiter, local Transformers.js models, the HypaV3 editor modal, the progress overlay,
  and the embedding playground.
- Paths:
  - Tab: `src/ts/process/memory/{contextualEmbedding,hypamemory,hypamemoryv2,hypav3,taskRateLimiter}.ts`,
    `src/ts/process/{transformers,memoryTasks.svelte}.ts`
  - Modal and overlay: `src/lib/Others/{HypaV3Modal,HypaV3Progress}.svelte`,
    `src/lib/Others/HypaV3Modal/{bulk-edit-actions,bulk-resummary-result,category-manager-modal,modal-footer,modal-header,modal-summary-item,tag-manager-modal}.svelte`,
    `src/lib/Others/HypaV3Modal/{taskStatusLine,types,utils}.ts`, `src/lib/Playground/PlaygroundEmbedding.svelte`
  - Server: `server/src/prompt/memory/{supaMemory,hypav2,hypav3,hanurai,host,memoryTasks,memoryTaskHost}.ts`,
    `server/src/prompt/{embeddings,transformers,transformersWorker}.ts`, `server/src/data/vectorCache.ts`
  - Shared: `shared/{memory,hypaV3Presets,taskRateLimiter}.ts`
- Not here:
  - The `structuredMemory` algorithm → [structured-memory](structured-memory/records.md).
  - The job around the memory step (`server/src/prompt/runner.ts`) → `server-generation.md`.
  - Settings UI placement → `settings-i18n.md` (`MemorySettings.svelte`, menu 2, `/settings/memory`).

## Files

Each module's header or the JSDoc of the identifiers named holds its rules; read it with the code.

### Algorithms

- SupaMemory, HypaV2, and Hanurai run only in the server job (`server/src/prompt/memory/`):
  `server/src/prompt/memory/{supaMemory,hypav2,hanurai}.ts` (`supaMemory`, `hypaMemoryV2`, `hanuraiMemory`), each on a
  `MemoryHost` ([Server](#server)). `supaMemory`'s JSDoc holds the `Chat.supaMemoryData` format (`asHyper`).
- `shared/memory.ts`: the shapes both copies share (`HypaV2Data`, `SerializableHypaV2Data`, `HypaV3Data`,
  `SerializableHypaV3Data`, `Summary`, `summaryKey`), the Voyage model tables, and the merge helpers
  (`mergeHypaV2Write`, `mergeHypaV3Write`, `mergeHypaV3SelectionWrite`). The converters are private to each algorithm
  module (`convertOldToNewHypaV2Data` in `server/src/prompt/memory/hypav2.ts`).
- `src/ts/process/memory/hypav3.ts`: the V3 implementation the tab keeps for the modal (resummarize, reroll) and the
  oracle; a send's V3 step is the server's port, split into parts ([HypaV3 parts](#hypav3-parts)). Its header holds the
  standard flow. Entry `hypaMemoryV3` (`hypaMemoryV3Main`, `hypaMemoryV3MainExp`), `summarize` (`SummarizeContext`),
  `getCurrentHypaV3Preset`, `HypaV3Settings`, `SerializableSummary`, the private `HypaProcesserEx`.
- `shared/hypaV3Presets.ts`: `createHypaV3Preset` (re-exported by the tab's `hypav3.ts`), `selectedHypaV3Preset`,
  `resolveHypaV3Budget` ([State](#state)).

### Embedding processors

- `src/ts/process/memory/hypamemory.ts`: the tab's V1 embedding engine, used beyond memory ([Coupling](#coupling)):
  `HypaProcesser` (`addText`, `similaritySearchScored`, `getEmbeds`), `HypaModel`, `localModels`, `voyageEmbeds`,
  `similarity`, `cosineSimilarity`, `contextHash`.
- `src/ts/process/memory/hypamemoryv2.ts`: `HypaProcessorV2`, used only by experimental V3.
- `src/ts/process/memory/contextualEmbedding.ts`: `ContextualEmbeddingProvider`, `isContextModel`, `getContextProvider`.
- `shared/memory.ts` `VOYAGE_CONTEXT_MODELS` and `VOYAGE_EMBEDDING_MODELS` (by `hypaModel` value), with
  `isVoyageContextModel`, `isVoyageEmbeddingModel`, and `voyageKeyMissing`: both copies and the settings options read
  them.
- `shared/taskRateLimiter.ts`: `TaskRateLimiter` and `TaskCanceledError`, re-exported by
  `src/ts/process/memory/taskRateLimiter.ts`; the server's memory code uses the same file.
- `src/ts/process/transformers.ts`: the tab's Transformers.js wrappers (`runEmbedding`, `runSummarizer`,
  `runImageEmbedding`, `runVITS`, `runTransformers`).
- `server/src/prompt/embeddings.ts`: the server's embedding port on a per-run `EmbeddingEnv`; its header owns cache,
  provider, and redaction differences from the tab.
- `server/src/data/vectorCache.ts`: the server's shared, rebuildable SQLite vector cache (`createVectorCache`).
- `server/src/prompt/{transformers,transformersWorker}.ts`: server-side local models in one child process; their headers
  define queue, loading, and memory limits.

### UI

- `src/lib/Others/HypaV3Modal.svelte` and its children in `src/lib/Others/HypaV3Modal/` edit a synced copy of the
  current chat's `hypaV3Data`; the modal's contract holds its save, refresh, and discard rules. A send's memory data is
  written by the job and by the background memory task.
- `memoryWriteFence` applies the per-chat fence ([Memory writes](#memory-writes)): `isLocalSend` and
  `generatingChatKeys` with the `chatGenerating` notice, plus `memoryTaskFenced`
  (`src/ts/process/memoryTasks.svelte.ts`) with the `memoryTasks.editFenced` notice. See [ui theming](ui-theming.md) for
  fence states and [chat store](chat-store.md#server-memory-writes) for the rule.
- Bulk resummary, in `src/lib/Others/HypaV3Modal.svelte`: `resummarizeBulkSelected` and `resolveBulkTargets`
  (`BulkResummaryState.targets`, `hypaV3Modal.bulkResummaryTargetsGone`); the modal's contract says what a replacement
  of the copy clears.
- Task status, "Summarize now", and "Cancel": rendered by the modal itself below its header
  (`src/lib/Others/HypaV3Modal/taskStatusLine.ts`, `showMemoryTaskResult`), calling `startMemoryTask` and
  `cancelMemoryTask` in `src/ts/process/memoryTasks.svelte.ts`. Lore writes are not fenced by tasks.
- `src/lib/Others/HypaV3Modal/utils.ts` `processRegexScript`: a summary's message through `risuChatParser` and the
  server transform's `editprocess` (`serverProcessScript`; `scripts-triggers.md`).
- `src/lib/Others/HypaV3Progress.svelte`: the progress overlay for the `entry` `src/App.svelte` picks
  (`memoryProgressFor` over `memoryProgressStore` and the current chat, else the legacy `hypaV3ProgressStore`;
  [ui theming](ui-theming.md)).
- `src/lib/Playground/PlaygroundEmbedding.svelte`: the embedding playground ([State](#state)).

## Flows

### Selection, in `assemblePrompt`

- Memory runs only when `nowChatroom.supaMemory` is set on the character or group.
- The priority order is `db.hanuraiEnable` → `db.hypav2` → `db.hypaV3` → otherwise `supaMemory` (as selected by
  `supaModelType`).
- The selected result is written to the current chat's algorithm field.
- `memoryAlgorithmType`'s `structuredMemory` selects [its step](structured-memory/writer.md#the-writer-task) ahead of
  that order; no other value is read.

### Server

A send's memory step runs in the job (`server/src/prompt/assemble.ts`); the browser code serves the HypaV3 modal and the
playground. Server algorithms use `MemoryHost` (`server/src/prompt/memory/host.ts`), which binds their requests,
embeddings, and token counts to the job or task.

### Server persistence

`assemblePrompt` writes memory as chat metadata against the chat stored at write time. SupaMemory, HypaV2, and Hanurai
write once per run; HypaV3 checkpoints summaries, then writes its selection. The merge helpers in `shared/memory.ts` own
stale-write behavior. Previews write memory too, before their provider request; algorithm errors become the job's
`throwError`.

### HypaV3 parts

The server splits V3 into `prepareHypaV3`, `planHypaV3Summaries`, `executeHypaV3Plan`, `selectHypaV3`, `forecastHypaV3`,
and `warmHypaV3Vectors` (`server/src/prompt/memory/hypav3.ts`). Their doc comments own the ledger, planning, checkpoint,
selection, and task-vector contracts. The server's `hypaMemoryV3` composition keeps the legacy fixture results;
production calls the parts. Source validation before a summary save is described under
[summary writers](#summary-writers).

### HypaV3 job modes

`hypaV3Step` dispatches the send-time step; `confirmMemoryGap` asks the owner tab. In production, previews select only,
ordinary input jobs select and hand due work to the detached task service, and a job summarizes synchronously only when
the required summary request needs the tab (a Plugin `memory` model or an applicable `request` trigger). `generate` runs
an initial summary pass. Without the task service, input V3 work stays in the job instead of handing off. A server
summary attempt using a local WebLLM model fails with `localSummarization`; sends needing no new summary still work. The
source comments own the conditions and selection details.

### Summary writers

Jobs and tasks share one per-chat summary writer lease. Each accepted V3 summary is committed separately after checking
its source window against the chat as stored; a failed window and later windows are dropped. The source comments own the
write-skipped and retry outcomes. Decision: HypaV3 Background Memory D15 and D16, [archive](../archived-plan/README.md).

### Background memory task

`server/src/prompt/memory/memoryTasks.ts` `createMemoryTasks` runs detached on `memoryTaskHost.ts`. Before `done`, the
runner hands it due V3 work or a pending manual start; the task persists through the
[chat store](chat-store.md#server-memory-writes) and warms saved vectors. The module comments own the queue, freshness,
start checks, caps, and terminal reasons. Task routes and feed frames are in [server generation](server-generation.md)
and [live-update feed](live-update-feed.md); the other task kind is the
[Structured Memory writer](structured-memory/writer.md#the-writer-task), which also runs
[chat rebuilds](structured-memory/rebuild.md#a-run).

### Progress and the stop control

Job memory work reports through `MemoryProgress` (`shared/jobs.ts`); detached tasks use `memoryTask` frames. The owner
tab's stop control finishes and saves the active window, then stops starting new windows. The modal overlay combines job
and legacy progress notices and clears them when [the job channel](network-jobs.md#job-channel) ends.

### Protection at the final re-check

The history entries a select-only, initial, or `writeSkipped` selection kept (its protected tail) are never removable in
the later token re-check (nor is a merged system message containing one; an `editRequest` result is removable only when
it matches a removable entry), so a prompt still over the context with them ends with the too-many-tokens error.

### The no-memory trim question

When a memory method is configured but the owner's `supaMemory` is off, a no-memory trim asks before dropping chat
history; a trim that drops only blank history entries (no text, no multimodals: the final re-check's rule) asks nothing.
The owner sees `alertSelect` in [the job channel](network-jobs.md#job-channel): enable memory, trim once, or ignore
future prompts by recording `memoryTrimAck`. An unanswered or invalid answer ends the job. The late removable-message
cleanup after formatting still applies.

## State

- DB settings:
  - Algorithm flags: `hypaMemory`, `hypav2`, `hypaV3`, `hanuraiEnable`, `hanuraiSplit`, `hanuraiTokens`,
    `memoryAlgorithmType` (only `structuredMemory` is read).
  - Models and keys: `hypaModel`, `supaModelType`, `supaMemoryKey`, `voyageApiKey`. `supaMemoryKey` is edited only on
    the Memory page, one input for summarization and embeddings; the Playground embedding tool shows its status, links
    there ([settings-i18n](settings-i18n.md)), and keeps its draft (model, query, data, results) in module state across
    that round trip.
  - Sizing: `hypaChunkSize`, `hypaAllocatedTokens`, `hypaCustomSettings`.
  - Presets: `hypaV3Presets`, `hypaV3PresetId` (the selected preset's id; `selectedHypaV3Preset` in
    `shared/hypaV3Presets.ts` resolves it). Both travel in the `hypaV3Presets` record as `{ items, selectedId }`.
    - Each preset uses ratio or token amounts for its budget, headroom, and extra summarization; the shared
      `resolveHypaV3Budget` comment owns the arithmetic. The server normalizer seeds an empty list with a token-mode
      preset, while imported presets without `budgetMode` stay in ratio mode. Upstream export converts token amounts to
      ratios ([upstream export](backup-sync-hub.md#upstream-database-export)).
- Per-chat fields: `supaMemoryData`, `hypaV2Data`, `hypaV3Data`, `lastMemory`, `memoryTrimAck` (the owner's
  `supaMemoryOnCount` when the user answered "don't ask again" to the trim question).
- Per-owner fields (character or group): `supaMemory` (the toggle), `supaMemoryOnCount` (its off→on transitions; read
  through `supaMemoryOnCount` in `shared/characters.ts`).
- Stores: `hypaV3ModalOpen`, `hypaV3ProgressStore`, and `memoryProgressStore` (per job). The tab's task status and fence
  mirror is module state in `src/ts/process/memoryTasks.svelte.ts`. Server task state and source generations are
  volatile; a restart drops queued work for the next send to find again.

## Coupling

- The tab's HypaV3 depends on `requestChatData`, `webllm`, `ChatTokenizer`, `parseChatML`, `risuChatParser`,
  `inlayTokenRegex`, localforage, and Transformers.js. The server ports depend on `MemoryHost` only.
- Users of the tab's `HypaProcesser`: `files/multisend.ts`, `mcp/graphmem.ts` (the tab's graph memory host), HypaV3, and
  the playground. The rest use the server's (`server/src/prompt/embeddings.ts`).
- Other users of the server embeddings: `additionalInformations` in `assemblePrompt`, the dynamic-asset step of
  `server/src/prompt/scripts.ts` (`editoutput` and the display transform's `editdisplay` with
  `dynamicAssetsEditDisplay`, with or without regex scripts; embeddings start only for an uncached unknown marker), Lua
  `similarity` and `v2CheckSimilarity` (`LuaBindingServices.similarity`), and the similarity effects.

## Invariants

### Data and memo values

- Shared shapes and merge identities live in `shared/memory.ts`: runtime summaries use message-id `Set`s, stored
  summaries use lists, and `chatMemos` reference `Message.chatId`; rewriting chat ids orphans summaries.
- The memory card `memo` values `supaMemory` and `hypaMemory` are special-cased in `assemblePrompt`; do not rename them.

### Memory writes

- Memory reads the selected reroll candidate and leaves the in-place carrier out
  ([server generation](server-generation.md#reroll-in-place)).
- Job and task writes merge against the chat as stored when each write occurs. `shared/memory.ts` owns V2/V3 identities;
  the [chat store](chat-store.md#server-memory-writes) owns the persistence boundary. Jobs remove orphaned V3 summaries;
  tasks prepare without cleanup.
- V3 has one summary writer per chat. Writers checkpoint accepted summaries only after validating their source window;
  details are in the server V3 and task contracts.
- These are chat-scoped guards: a local send or `generatingChatKeys()` membership (a followed job or a server lock known
  to this tab) fences writes to that chat. The modal also respects `memoryTaskFenced(ref)` until the mirror reaches the
  task's terminal revision; the local lore draft has no task fence. A refused modal edit is reverted in its copy, never
  queued to write after the fence.

### Deferred stored summaries

With the task service, `deferStored` applies prepared summaries only when the ordinary plan reaches their windows;
replay is approximate, so edits, merges, or later context changes can bring raw history back into the prompt. The task's
lookahead starts at stored coverage and does not defer summaries.

### Token accounting

- Production V3 and its task plan, select, and trim within `maxContext − maxResponse`; the context meter uses the same
  response-corrected budget. HypaV2 and the legacy V3 composition keep their older count, so the job's final recheck
  preserves the response budget and never removes HypaV2's protected tail. SupaMemory and Hanurai count from the main
  prompt total. A prompt still over context after removable entries are gone ends with the too-many-tokens error.

### Server and tab copies

- Send-time algorithms run on the server, while embeddings also have tab callers. The tab's V3 copy serves the modal and
  frozen oracle fixture, uses ratio-mode settings, and does not run send-time embedding; detached tasks, V3 parts,
  source validation, leases, and token-mode budgets are server-only. Keep server V3 implementations aligned where they
  share a contract. Decision: HypaV3 Background Memory D12, [archive](../archived-plan/README.md).

### Embedding credentials

- Embedding provider credentials stay inside the server embedding layer and its `MemoryHost` boundary; module comments
  own redaction and cache-key rules. Never expose credentials in CBS or Lua values, notices, errors, logs, or cache
  rows.

### The memory toggle count

- Every core path that turns `supaMemory` on increments `supaMemoryOnCount`; `memoryTrimAck` stays effective only while
  it matches that count. The tab owns those increments (the runner also increments for its own trim answer), so moving
  the count server-side alone would double-count.
- `applyPluginCharacter` preserves the stored count and adds one only for an off→on change to the same `chaId`; new or
  differently identified records are not counted.

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
    1), `budgetMode` `"ratio"` or `"tokens"`; `structured` as
    [the structured memory writer](structured-memory/writer.md) says), including through the server normalizer.
  - A setting that sizes the budget goes through `resolveHypaV3Budget`, never a site's own formula (the tab's legacy
    copy keeps its own ratio expressions).
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
  browser Transformers wrappers; real-browser overlay gating, stop control, sidebar badge, and reconnect fence.
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
- Experimental's rate limiter is per execution: no provider-wide allowance across runs or chats.
- Ordinary API document batches (`HypaProcesser.embedDocuments`, `HypaProcessorV2`) are capped at 50 texts, a direct
  `getEmbeds` call is not, and none counts tokens before sending; long inputs can exceed provider limits. Contextual
  batches likewise count inputs and chunks, not tokens.
- The Voyage group hash is a 32-bit hash of the group's texts (joined with `\0`), so two different groups can still
  share a key.
- A cancelled `TaskRateLimiter` batch leaves its retry timer alive until the window advances (up to 60 s); it starts no
  task.
- The custom embedding URL is fetched directly by the server with no local-target restriction.
- Unconfirmed: `gpt2-large-conversational` is listed in `shared/llm/models.ts`, but its model files were not checked on
  the browser mirror or the server's default Transformers host. If absent, selecting it fails during model loading.
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
- The catalogued Transformers.js generation models use Node's `fp32` weights and do not load in the browser because they
  publish no `model_quantized.onnx`. Decision: `server/src/prompt/transformersWorker.ts` header.
- `voyageApiKey` and `hypaCustomSettings.key` are in the client-readable `secrets` section: the tab reads them, and the
  job's settings projection holds them. Only `supaMemoryKey` is write-only. Decision: `shared/sections.ts` `secrets`.
- The server and the tab do not share vectors or model files, and their local models can differ in weights revision and
  kernels: a ranking near a tie can differ between the two paths. Decision: `server/src/prompt/embeddings.ts` header.
- The Transformers.js child process has no memory limit of its own; queue caps do not bound running model allocations.
  Decision: `server/src/prompt/transformers.ts` header.
- The no-memory trim question has gaps: the late removable-message cleanup in `assemblePrompt` (`removable`) runs after
  formatting and can still drop history without asking; an unanswered question (a timeout, a lost owner) ends the job
  with an English error, since the server has no localized channel for terminal errors; and a raw record write that
  turns `supaMemory` on does not bump `supaMemoryOnCount`, so a chat's "don't ask again" survives it. Decision: Found
  Issues Decisions (owner, 2026-11-08).

### Gotchas

- The vector cache's 256 MiB default bounds vector bytes, not the SQLite file, its index, or WAL. Eviction runs
  synchronously on the server thread, at most 256 rows per `set` (`trimRowsPerSet`) in the insert's transaction,
  continuing toward 90% on later inserts; a vector that still cannot fit is skipped. Startup trims an over-bound cache
  to 90% before serving.
- On the server, HypaV3's dot products and sorts still run on the main thread, outside the CBS limits. Summary separator
  matching runs on script workers under deadlines; a task's deadline starts when a worker takes it, so queue wait can
  extend the chunking step beyond its budget.
