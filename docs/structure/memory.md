# Long-Term Memory and Embeddings

## Scope

- Owns: per-chat memory settings, trim confirmation, the SupaMemory, HypaMemory V2/V3 and Hanurai algorithms, the
  embedding processors, the rate limiter, local Transformers.js models, the HypaV3 editor modal, the progress overlay,
  and the embedding playground.
- Start at `shared/chatMemory.ts` for settings, `server/src/prompt/memory/` for send and task execution,
  `src/ts/process/memory/` for tab algorithms, and `src/lib/Others/HypaV3Modal.svelte` for the editor and its child
  components. [Embedding processors](#embedding-processors) lists both runtimes and their caches.
- Not here:
  - The `structuredMemory` algorithm → [structured-memory](structured-memory/README.md).
  - The job around the memory step (`server/src/prompt/runner.ts`) →
    [server generation](server-generation.md#prompt-job-execution).
  - Settings UI placement → [settings](settings-i18n.md#pages) (`MemorySettings.svelte`, menu 2, `/settings/memory`).

## Files

Each module's header or the JSDoc of the identifiers named holds its rules; read it with the code.

### Algorithms

- SupaMemory, HypaV2, and Hanurai run only in the server job (`server/src/prompt/memory/`):
  `server/src/prompt/memory/{supaMemory,hypav2,hanurai}.ts` (`supaMemory`, `hypaMemoryV2`, `hanuraiMemory`), each on a
  `MemoryHost` ([Server](#server)). `supaMemory`'s JSDoc holds the `Chat.supaMemoryData` format (`asHyper`); a blank
  summarizer answer is a failed summarization, and the stored summary and cursor stay.
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

- `src/lib/SideBars/ChatMemoryPanel.svelte` reads the chat-list entry, including for unloaded chats. Both
  `OpenChatPanel.svelte` and `ChatBindingDialog.svelte` mount it. Its preset and connection pickers keep deleted ids
  visible until changed. `src/ts/storage/chatMemory.svelte.ts` supplies `chatMemorySettings`, `setChatMemoryEnabled`,
  `setChatMemoryMode`, `setChatMemoryPreset`, `setChatMemoryProfile`, and `initialChatMemory`.
- `MemorySettings.svelte` selects the algorithm for Legacy chats. Preset, budget, Structured Memory and HypaV3 controls
  apply to chats that select those modes directly. The page edits the open chat's existing preset or the default. See
  [settings UI](settings-i18n.md#pages) for import targeting. The Plugin-model warning uses the open chat's resolved
  memory connection.
- The HypaV2 chunk dialog (`src/lib/Others/AlertComp.svelte`) and the SupaMemory text areas
  (`src/lib/SideBars/CharConfig.svelte`) write the whole field with `setChatMeta`. They are read-only while
  `memoryEditorWriteFence` holds: a local send, a followed job, a message lock, a job the live feed lists (a preview
  too), or a chat update not yet read. Both dialog openers skip initializing an absent `hypaV2Data` then. A tab that has
  not heard of another device's job is not fenced.
- The server refuses such a whole-field HypaV2 or SupaMemory write when its base precedes a job's write of the same
  field (`chatMemoryWrites`, stamped in the job's transaction), and the tab rereads the chat with a notice. An edit that
  lands before the job's write stays: HypaV2 merges chunks by identity, and SupaMemory takes the job's summary.
- `src/lib/Others/HypaV3Modal.svelte` and `src/lib/Others/HypaV3Modal/` children edit the current chat's synced
  `hypaV3Data` copy; its contract owns save, refresh, and discard. Jobs and tasks write send memory.
  `getCurrentHypaV3Preset(chat)` reads its chat's preset; `summarize` captures preset and connection from its context's
  chat-list entry (else current chat) before awaiting. Legacy composition keeps its room's settings and connection
  across waits.
- In the modal, `memoryWriteFence` protects the edited copy ([memory writes](#memory-writes)). `resummarizeBulkSelected`
  and `resolveBulkTargets` fence bulk results against replacement. The component contract owns copy refresh and discard.
- While the fence holds, the modal's edit controls are read-only and keep pending input; the copy-save guard still
  restores a change that races the fence. The Structured Memory section draft and a memory receipt's Revert follow the
  same rule.
- `src/lib/Others/HypaV3Modal/taskStatusLine.ts` formats task status. The modal calls `startMemoryTask` and
  `cancelMemoryTask` in `src/ts/process/memoryTasks.svelte.ts`; `showMemoryTaskResult` handles their answers.
- `src/lib/Others/HypaV3Modal/utils.ts` `processRegexScript`: a summary's message through `risuChatParser` and the
  server transform's `editprocess` (`serverProcessScript`; `scripts-triggers.md`).
- `src/lib/Others/HypaV3Progress.svelte`: the progress overlay for the `entry` `src/App.svelte` picks
  (`memoryProgressFor` over `memoryProgressStore` and the current chat, else the legacy `hypaV3ProgressStore`;
  [ui theming](ui-theming.md)).
- `src/lib/Playground/PlaygroundEmbedding.svelte`: the embedding playground ([State](#state)).

## Flows

### Selection, in `assemblePrompt`

`shared/chatMemory.ts` supplies the same rules to assembly, task admission, exports and the tab (including unloaded list
entries). Resolve the chat at the point the algorithm or switch is needed.

- `chatMemoryAlgorithm` honors stored `memoryMode` values `structuredMemory` and `hypaV3`. Missing or malformed modes
  use `legacyMemoryAlgorithm`, in this order: explicit Structured Memory, Hanurai, HypaV2, HypaV3, SupaMemory when
  `supaModelType` differs from `none`, then none. The settings selector follows the same order.
- `chatMemoryEnabled` uses an explicit chat boolean first. Without one, `alwaysToggleOn: true` in the applied preset
  enables HypaV3 or Structured Memory. Otherwise the owner's `supaMemory` decides. A send needs both a configured
  algorithm and an enabled switch. See
  [Structured Memory selection and hand-off](structured-memory/read.md#the-read-path).

### Server

A send's memory step runs in the job (`server/src/prompt/assemble.ts`); the browser code serves the HypaV3 modal and the
playground. Server algorithms use `MemoryHost` (`server/src/prompt/memory/host.ts`), which binds their requests,
embeddings, and token counts to the job or task.

`loadJobScope` captures `chatMemoryProfileId` once, alongside the chat's preset, in `JobScope.memoryProfileId`.
`resolveScopeMemoryModel` resolves that named connection for the fingerprint, blocking reason, task start checks, and
writer's `openRun`; both hosts pass the same `profileId` on every request. Live chat refreshes cannot switch a run's
connection. This covers HypaV3, the Structured Memory writer (record now, gap runs, rebuilds, and test runs), and the
`subModel` paths of SupaMemory/HypaV2. Fixed completion models, local summarization, embeddings, and Lua's own
`memory`-mode requests keep their existing routing; the rebuild cost preview resolves no model.

A deleted named connection refuses with `missingNamedProfile`. A send that needs a new HypaV3 summary fails. A
background task admitted with the deleted connection fails on its call; one queued before deletion goes stale at the
fingerprint check. A Structured Memory gap run leaves the gap and lets the send continue.

### Server persistence

`assemblePrompt` writes returned memory as chat metadata against the chat stored at write time. SupaMemory and HypaV2
write at most once per step; Hanurai writes no memory field. HypaV3 checkpoints summaries, then writes its selection.
The merge helpers in `shared/memory.ts` own stale-write behavior. Ordinary previews can write memory before the reply
request. An [OOC preview](server-generation.md#prompt-job-execution) writes to its detached chat and refuses with
`oocMemoryAhead` when `supaMemory` (including its legacy `asHyper` variant) finds no cursor in the anchored history.
Algorithm error results use the job's `throwError`; Hanurai's alert result raises `SendError` without an inlay error
message.

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
summary attempt using a local WebLLM model throws `LOCAL_SUMMARIZATION_UNSUPPORTED`; sends needing no new summary still
work. A detached task instead skips with `localSummarization`. The source comments own the conditions and selection
details.

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

A manual start on an archived group's chat returns 409 `groupArchived`. The tab releases that attempt's fence and shows
the refusal. See [server route limits](server-generation.md#limitations) for work queued before the upgrade.

The tab's Start and Cancel (`memoryTasks.svelte.ts` `startMemoryTask`, `cancelMemoryTask`) share one request slot per
chat and wait at most 30 s for the answer and body, counted after sign-in. A timeout is the `failed` result: the slot
frees, and a failed Start leaves its `uncertain` fence until the feed reports the chat. Either may be pressed again: the
server answers `running` for a live task, and cancelling nothing is a no-op.

A task's kind must match the chat's algorithm at its start (`notHypaV3`, `notStructuredMemory`), and again before each
further window and each commit, read from the chat and the settings as stored rather than the task's scope. A mismatch
ends the task skipped with the same reasons and accepts no further result; a HypaV3 task first lets its in-flight
requests return and saves none of them. A summary save counts only when the stored value kept it, so one the
[projection](structured-memory/projection.md#the-tabs-mirror) guard dropped is not reported as saved. A mode change that
resolves to the same algorithm leaves a queued task valid: the settings fingerprint holds the resolved algorithm's
fields, never the stored mode.

### Progress and the stop control

Job memory work reports through `MemoryProgress` (`shared/jobs.ts`); detached tasks use `memoryTask` frames. The owner
tab's stop control finishes and saves the active window, then stops starting new windows. The modal overlay combines job
and legacy progress notices and clears them when [the job channel](network-jobs.md#job-channel) ends.

### Protection at the final re-check

The history entries a select-only, initial, or `writeSkipped` selection kept (its protected tail) are never removable in
the final re-check. A merged system message containing one is protected too. An `editRequest` result is removable only
when it matches a removable entry. The re-check reserves the reply and chat-reply interception messages. Sends and
`previewPrompt` also reserve offered tool schemas; a messages-only `preview` skips tool listing. With or without a
memory method and a prompt template, the re-check never clears the newest user turn or the last history entry
(`keptHistory` in `assemble.ts`), by identity or source provenance. A protected tail or kept history that still exceeds
the remaining budget fails the job. See [request accounting](llm-requests.md#limitations).

### The no-memory trim question

For input jobs, when a memory method is configured but the chat's resolved switch is off, a no-memory trim asks before
dropping chat history unless `memoryTrimAck` still applies; a trim that drops only blank history entries (no text, no
multimodals: the final re-check's rule) asks nothing. `preview` and `previewPrompt` trim without asking. The owner sees
`alertSelect` in [the job channel](network-jobs.md#job-channel): enable memory, trim once, or ignore future prompts by
recording `memoryTrimAck`. Enabling writes `memoryEnabled: true` and removes this chat's acknowledgement in one metadata
operation, leaving the owner and its count alone. The runner rechecks the chat's resolved switch before the
acknowledgement comparison. An unanswered or invalid answer ends the job. The late removable-message cleanup after
formatting still applies.

## State

- DB settings:
  - Algorithm flags: `hypaMemory`, `hypav2`, `hypaV3`, `hanuraiEnable`, `hanuraiSplit`, `hanuraiTokens`,
    `memoryAlgorithmType` (`structuredMemory` stays explicit; the settings view derives legacy values from the flags in
    server priority order on read, without saving).
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
- Chat preferences: `memoryEnabled`, `memoryMode`, `memoryPresetId`, `memoryProfileId` affect server and tab execution.
  `chatHypaV3Preset` returns the preset named by `memoryPresetId` when it exists, else `selectedHypaV3Preset`'s default.
  Absent, malformed, and deleted preset ids fall back without rewriting a chat. `chatMemoryProfileId` in
  `shared/chatMemory.ts` returns a non-empty string unchanged (no trimming or membership check); absent, non-string, and
  empty values mean the model preset's memory slot. Deleted connection ids remain named and refuse ([Server](#server)).
- `loadJobScope` applies the chat's existing preset to its own `db.hypaV3PresetId`, leaving the stored selection alone:
  budget, summarization, writer, cadence, screening, test runs, warm work, notices, and the settings fingerprint all
  follow that scope. Editing another preset does not stale this chat's queued task. The fingerprint already hashes the
  resolved memory profile, so changing the chat's connection stales queued work without a separate id field in the
  digest.
- Per-owner fields (character or archived group): `supaMemory` (the default for a chat that never chose),
  `supaMemoryOnCount` (legacy off→on count, still incremented by plugin character writes; read through
  `supaMemoryOnCount` in `shared/characters.ts`). The upstream exporter derives `supaMemory` from whether any stored
  chat resolves on. Without exported chat rows, it resolves an empty chat against the owner and settings for the
  synthetic first chat.
- New chats inherit their source chat's resolved switch and valid stored mode, preset, and connection, regardless of
  `newChatBinding`; they never inherit `memoryTrimAck`. A first chat stores no memory preferences. Copy, branch, import,
  plugin creation, and recovery carry supplied metadata. Chat-file import drops memory preset and connection ids that
  name no corresponding record here; recovery and backup restore keep ids as stored.
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

- `shared/memory.ts` owns shapes and merge identities: runtime `chatMemos` are message-id `Set`s, stored values are
  lists referencing `Message.chatId`; changing ids orphans summaries. Server readers treat missing V3 `summaries` or
  `chatMemos` and V2 `mainChunks` or `chunks` as empty at conversion, without rewriting stored metadata.
- The memory card `memo` values `supaMemory` and `hypaMemory` are special-cased in `assemblePrompt`; do not rename them.

### Memory writes

- Memory reads the selected reroll candidate and leaves the in-place carrier out
  ([server generation](server-generation.md#reroll-in-place)).
- Job and task writes merge against the chat as stored when each write occurs. `shared/memory.ts` owns V2/V3 identities;
  the [chat store](chat-store.md#server-memory-writes) owns the persistence boundary. Jobs remove orphaned V3 summaries;
  tasks prepare without cleanup.
- V3 has one summary writer per chat. After source-window validation, job and task checkpoints return `committed` only
  if raw stored `hypaV3Data` keeps the merged value; otherwise `skipped` triggers recovery.
- A local send or `generatingChatKeys()` membership (a followed job or known server lock) fences that chat's writes; the
  modal also respects `memoryTaskFenced(ref)` until its mirror reaches the task's terminal revision, while local lore
  has no task fence. Refused modal edits revert their copy and never queue for later.
- HypaV3 reset captures its chat before both confirmations and writes only if it remains selected when they return,
  subject to the same fences.

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

- Turning a chat's memory on through `setChatMemoryEnabled` or the trim answer removes its `memoryTrimAck` in the same
  metadata operation. Turning it off stores `false`; it never returns the switch to the owner's default. The ack is a
  summary field, so an unloaded chat can invalidate it too.
- `memoryTrimAck` remains effective only while it matches the owner's `supaMemoryOnCount`. Core paths no longer
  increment that count, and character selection never writes memory state.
- `applyPluginCharacter` preserves the stored count and adds one only for an off→on change to the same `chaId`; new or
  differently identified records are not counted.

## Recipes

- Add or change a top-level algorithm: the selector in `MemorySettings.svelte`, the fields in `shared/sections.ts` and
  their defaults in the server normalizer, and the branch plus persistence in the server's `assemblePrompt`. Verify the
  `chatMemoryEnabled` gate, `chatMemoryAlgorithm`, and the `legacyMemoryAlgorithm` priority order.
- Add an embedding model: `hypamemory.ts` (`HypaModel`, `localModels`, `getEmbeds`), `hypamemoryv2.ts:getAPIEmbeds`,
  `transformers.ts` `EmbeddingModel`, and the UI options. A Voyage model is one entry in `VOYAGE_EMBEDDING_MODELS` or
  `VOYAGE_CONTEXT_MODELS` plus its `HypaModel` value; the settings list both tables.
- Add a contextual provider: `contextualEmbedding.ts`, the grouped paths in `HypaProcessorV2`, and
  `HypaProcesserEx.addSummaryChunksContextual`.
- For embedding-model and contextual-provider changes, also follow the server/tab contract in
  `server/src/prompt/embeddings.ts` and the tab's `localModels` comment in `src/ts/process/memory/hypamemory.ts`; update
  the server's corresponding registries, providers, and processor dispatches.
- Change V3 behavior: the server's parts (both implementations; the job step and the task call them), the client's mains
  when the change reaches the legacy composition the fixture pins, `HypaV3Settings`, `createHypaV3Preset`, and the
  settings bindings.
  - A memory-relevant setting the task reads also joins `memorySettingsFingerprint` (`server/src/jobs/jobScope.ts`).
  - `createHypaV3Preset` owns validation and defaults, including for imports through server normalization.
    `resolveHypaV3Budget` owns the arithmetic. The tab's legacy composition keeps its own ratio expressions.
  - Extend `MemoryHost`, the runner adapter and the fixture's `hostOf` together. `MemoryHost.separatorLimits` bounds
    server regex splitting per operation and across the run. Invalid separators use double newlines and worker errors
    return before embeddings. The tab uses a synchronous separator.
- Add summary metadata: the serializable types in `shared/memory.ts` (with `HypaV3Data`, `Summary`, and `DISPLAY_MODE`),
  `HypaV3Modal/types.ts`, the modal, and its child components. Keep the modal's `$derived`/`$effect.pre` patterns.

## Tests

- `shared/tests/chatMemory.test.ts` checks fallback order. `src/lib/SideBars/ChatMemoryPanel.test.ts` exercises the
  per-chat controls against loaded and unloaded entries. Metadata and persistence checks span
  `server/src/tests/{memoryJobs,memoryTasks,assemble,chatSummaries,upstreamExport}.test.ts`,
  `src/ts/storage/tests/{chatStore,bootCache,settingsViews,chatBindingNewChat}.test.ts`, and
  `src/ts/plugins/apiV3/hostApiChats.test.ts`. UI checks include `src/ts/process/chatStatus.test.ts` and
  `src/lib/Others/StructuredMemory/StructuredMemoryPanel.test.ts`.
- Not tested: the chat memory panel at phone width, two-tab switch synchronization, the three trim answers on a real
  send, and an exported backup opened in upstream with each character's derived switch.
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
- Rate limiter: `server/src/tests/embeddings.test.ts` covers standalone cancellation, retry scheduling, and fail-fast
  behavior with fake timers.
- Not tested: Voyage models in the Playground; modal search and category editing; browser Transformers wrappers;
  real-browser overlay gating, stop control, sidebar badge, and reconnect fence.
- Not tested end to end: the runner's completion-key check or its `captionImage` and local-generation wiring.

## Known Hazards

### Issues

- Unconfirmed: `gpt2-large-conversational` is listed in `shared/llm/models.ts`, but its model files were not checked on
  the browser mirror or the server's default Transformers host. If absent, selecting it fails during model loading.
- Unconfirmed: `HypaProcesser` keeps the original comparator `a.similarity > b.similarity ? -1 : 0` (not a total order);
  whether a pathological input orders wrongly is not established. A run on 2026-11-14 found none: the comparator matched
  a stable descending sort on 10,000 generated inputs (Node 24), and three sends retrieved the right top three.

### Limitations

- A raw resource write can change an owner to `type: "group"` under the same id. A send admitted earlier can still hand
  off writer or vector warming work. Its request id keeps the normal
  [replay rules](server-generation.md#generation-admission). Decision: owner, 2026-11-23
  ([archive boundary](../../STRUCTURE.md#data-and-persistence)).
- A tab loaded before chat memory preferences were introduced keeps showing the character's switch and writes
  `supaMemory`, now only the default of a chat that never chose; a tab loaded before chat modes reached the tab shows
  the global algorithm for a chat with a stored mode. A plugin whole-chat write from such a tab can still remove a field
  its copy never held. Reloading ends these limitations. Decision: owner, 2026-11-12.
- A mode change converts nothing and asks nothing new: a chat entering Structured Memory with stored summaries shows the
  existing adopt-or-decline question, and its summaries and records stay for a later change back. Decision: Per-Chat
  Memory plan, D10.
- Writers inside a job (record now or the gap run when the tab must serve the model, and a send's own HypaV3 summaries)
  check the chat's algorithm only when admitted; a mode change during that job does not stop them. Detached tasks
  recheck at every window and commit ([Background memory task](#background-memory-task)). Decision: Per-Chat Memory
  plan, D17.
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
- The `deferStored` replay ([Deferred stored summaries](#deferred-stored-summaries)) approximates the ordinary plan in
  three ways: a lookahead window cut at the protected tail, or an edited or merged summary, is taken whole, up to one
  window early; a stored summary reaching into a grown `queryChatCount` tail is taken where the planner would summarize
  again; past lengths use the current rest-of-prompt size, so a lore swing can move summaries. Prepared summaries can so
  replace messages earlier than vanilla Hypa would. Decision: owner, 2026-10-27 (document, do not change).
- The modal and lore-draft fence knows only this tab's sends and the jobs it follows or sees locked: another tab's modal
  (no job ownership on the change feed) and a plugin's whole-chat result (`applyChatResult`) still write a whole memory
  value, and one that lands after the job's write replaces the job's summaries (`meta set` replaces the field).
  Decision: owner, 2026-11-10 (known-issues review).
- The job's own write keeps a change saved before it. A memory task's writes fence the modal of every connected tab (its
  `memoryTask` frames), but a plugin's whole-chat result that lands after a task's write still replaces its summaries.
  Decision: owner, 2026-11-10 (known-issues review).
- An edit right after a refused final job hydration can still use a stale modal or lore copy: the job fence drops before
  the idle refresh catches up, and a whole-field write can replace the job's data (`chat-store.md`, job hydration and
  idle refresh). Decision: owner, 2026-11-10 (known-issues review).
- Experimental's rate limiter is per execution: no provider-wide allowance across runs or chats. Decision: owner,
  2026-11-10 (known-issues review).
- No API embedding batch (`HypaProcesser.getEmbeds`, `HypaProcessorV2`) counts tokens before sending, so long inputs can
  exceed provider limits; contextual batches likewise count inputs and chunks, not tokens. Decision: owner, 2026-11-10
  (known-issues review): the provider reports the overflow.
- The custom embedding URL is fetched directly by the server with no local-target restriction. Only an authenticated tab
  writes `hypaCustomSettings`, no card or module supplies the URL, and a local embedding server is a supported setup.
  Decision: owner, 2026-11-10 (known-issues review): the same trust as `/proxy`.
- A cancelled recording stays counted against the shared memory-task capacity while a tracked local encode,
  script-worker regex, or Google token count settles; its automatic chapter fetch is aborted at cancel. Decision: owner,
  2026-11-24 (known-issues review): passing the task signal to the counter would also end a running local encode.
- A manual start that landed as waiting for the next send, but whose answer was lost (a timeout included), is not shown
  as waiting until Start is pressed again. Decision: Bounded Client Waits D5, [archive](../archived-plan/README.md).

### Gotchas

- `src/ts/process/transformers.ts` `registerOnnxModel` reads members lazily, but `zipFile.ts` `readZipEntry` calls
  `inflateSync` on the tab's main thread; a large deflated ONNX member can block settings interaction during inflation.
- In `server/src/prompt/memory/memoryTasks.ts`, `endRunning` can publish a pending task's `queued` status after an abort
  callback already publishes it; status consumers must tolerate duplicate `queued` events for one task id.
- The vector cache's 256 MiB default bounds vector bytes, not the SQLite file, its index, or WAL. Eviction runs
  synchronously on the server thread, at most 256 rows per `set` (`trimRowsPerSet`) in the insert's transaction,
  continuing toward 90% on later inserts; a vector that still cannot fit is skipped. Startup trims an over-bound cache
  to 90% before serving.
- On the server, HypaV3's dot products and sorts still run on the main thread, outside the CBS limits. Summary separator
  matching runs on script workers under deadlines; a task's deadline starts when a worker takes it, so queue wait can
  extend the chunking step beyond its budget.
