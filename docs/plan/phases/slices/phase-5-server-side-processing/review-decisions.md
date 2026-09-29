# Review decisions: Phase 5 slices

Decided 2026-09-30 after verifying each point against the tree at `577c43ae` (a Luna fan-out of
eight read-only workers, direct reads of the cited files, and Node probes for the `vm` wrapper
and wasmoon). The reviews were GPT-6-Astra's (18 points) and Claude Opus's (14 points); each
line below carries the point's short title so the record reads without the reviews. The slices
were refined accordingly (14 slices plus the README: `lua-runtime-spike` became
`script-worker-spike`, `lua-and-triggers-on-server` split into `lua-bindings-and-buttons` and
`trigger-runtime`, `mcp-on-server` is new).

## Astra

- Astra P1, worker isolation is required, not a fallback: adopt — a `worker_threads` pool is the primary runtime for Lua and regex
  (`script-worker-spike`), with `resourceLimits`, `traceAllocations` + `setMemoryMax` (both
  verified in wasmoon 1.16.0's `global.d.ts:15-17`, `engine.d.ts:6-12`), `terminate()` on
  timeout, and input, output, batch, and script-count caps at the worker boundary; `executeScript`
  is confirmed synchronous `RegExp` with no timeout (`scripts.ts:184-304`).
- Astra P2, the ownership check misses ways to displace or delete the reply: adopt with changes — `reason: "generating"` is added to `ChatConflict` (verified: no
  `reason` field, `shared/chats.ts:80`), the lock gates `begin` takeover (verified:
  `chatStore.ts:724-740` takes over an open fence at the current revision), character deletion
  (`resourceStore.ts:462`, `561`), `replace`, chat `delete`, and multi-`remove`; only in-process
  writes carrying the job's token pass, a client-supplied generation id never grants ownership.
  Changed: the restore path (`replaceAll`) is not gated separately, because restore drains jobs
  first (P3), and the trigger's removals are ordinary in-process writes under the token rather
  than a new checkpoint shape.
- Astra P3, generation jobs need restore, epoch, and shutdown integration: adopt with changes — the minimal form only: runners register with `snapshots.track`
  (so `stop` and `dispose` await them) and enter the storage gate around each write (so
  `withMaintenance` drains them), a write during maintenance ends the job with `error`, and the
  job carries the epoch it was admitted under (`assertEpoch` on every write). Rejected: a separate
  runner lifecycle (close admission, drain, release, replace) beyond that; the existing tracking
  primitives already give the ordering, and a restore mid-job ending that job with an error is
  acceptable for alpha data.
- Astra P4, the tail closes the fence too early and omits durability boundaries: adopt — `post-generation-and-plugin-callbacks` now writes the persistence sequence
  per path with the fence open through every intermediate checkpoint, the final write after the
  output trigger, inlays, and `igp`, ownership released only after it, a late checkpoint after
  `final` ignored, and tests for a failure between stages and a trigger that removes the reply.
- Astra P5, header redaction does not satisfy the credential guarantee: adopt with changes — one secret-free projection (`redactRequest`) covering URLs
  (verified: the Google key travels in `?key=`, `google.ts:568-572`), headers, bodies, and nested
  metadata, used by the `requestLog` notice, errors, `previewPrompt`, and callback payloads, with
  sentinel-credential tests per provider. Changed: `additionalParams` credentials stay an open
  owner question with a proposed default (authorization `header::` values stored server-side under
  `llmSecrets.additionalHeaders` with a reference in the readable configuration) rather than a
  condition for approving the slice.
- Astra P6, the secret transition contradicts the rollback gate: adopt with changes — Opus's fix (a): the server provider transport
  (`POST /api/llm/request`) becomes unconditional for both pipelines in slice 7, then
  `llmSecrets` flips write-only in the same slice's second step; browser assembly stays the
  rollback seam; slice 7 depends on slice 6; preset `proxyKey` copy, delete, and import become
  server operations (`POST /api/llm-secrets/presets/copy`, the DELETE route); the secret routes
  carry `x-resource-epoch` and `baseRevision`; a write carrying a masked projection is refused.
  Changed from Astra's wording: enforcement is not deferred to "after every dependent consumer has
  a route" as a separate phase; the consumers are routed in the same slice before the flip.
- Astra P7, the credential-consumer audit is incomplete: adopt — the inventory now lists credential reads, not `requestChatData` callers
  (verified: `tokenizer.ts:349`, `modellist.ts:641-749`, `openrouter.ts:37, 58`, `nanogpt.ts:165`,
  `BotSettings.svelte:354-480`, `tts.ts:200`, `stableDiff.ts:419, 695`,
  `PlaygroundSubtitle.svelte:288`); discovery, account, and remote count calls get server
  endpoints; the `openAIKey` and `google.accessToken` auxiliary readers are an owner question
  with Opus's option (a) (`/proxy2` injects the key for an allow-listed host) as the proposed
  default.
- Astra P8, the auxiliary-job and provider contracts are underspecified: adopt with changes — the transport carries the full `requestDataArgument` option set
  (verified: 25 fields, `request.ts:31-58`) and an `entry` discriminator preserving
  `requestChatData` vs `requestChatDataMain` (plugin `runLLMModel` calls the latter with
  `blockPlugins`, `v3.svelte.ts:1646-1668`); provider descriptors (the `LLMModel` built at
  `v3.svelte.ts:991-1012`) are frozen in the hook list; `aux` requests are not jobs and take no
  chat lock, and a child request inside a callback is an `aux` request. Rejected: designing
  reentrant callback semantics beyond that one sentence.
- Astra P9, settling and callback hydration do not cover the frozen context: adopt with changes — the pre-send barrier is `flushResources()` (every pending write,
  settings and presets included; a rejection is a visible send failure with the discarded keys),
  not `settleChat`; the callback barrier is the minimal form: the job's changes reach the client
  as `chunk` and `resource` hydration events before the callback, and the client calls
  `flushResources()` after the callback before answering. Changed: full "resume from acknowledged
  changes" bookkeeping is not designed; the job re-reads the chat it wrote through. Scoping
  selection-dependent plugin APIs (`getChar`/`setChar`) to the job context is recorded as a
  Phase 4 boundary in the report, not done here.
- Astra P10, question failures and modal arbitration need an explicit contract: adopt with changes — question outcomes `answered`, `cancelled`, `timedOut`,
  `disconnected`, `aborted`; a question that is not `answered` fails the invoking stage (Lua
  raises, a trigger stops, a plugin callback ends the job); late answers ignored. The modal-notice
  queue is one sentence (modal notices queue behind an open question; toasts and progress do not),
  not a design.
- Astra P11, the image-generation conflict is real, but the alternatives are misstated: adopt with changes — the client `generateImage` callback stays, now justified by
  Decisions 5 and 6 together rather than as an open question (Opus), the phase-file wording
  ("through server services", "on the server") is a proposed phase-file edit, and the disconnect
  behavior is recorded (the reply persists without the image). My earlier "rejected alternative"
  wording that tied server execution to moving the keys is dropped (Astra is right that the server
  could read `secrets`).
- Astra P12, transform integration changes deterministic ordering and drops process hooks: adopt — the CBS pre-pass keeps its position (verified: `Chat.svelte:364-371` runs
  before `ParseMarkdown` and the hooks) by travelling as `prePass` options in the target; the
  two-call protocol is mode-aware (`pluginHooks[mode]` runs for `editprocess` too,
  `scripts.ts:163-170`), both calls bound to one server-side snapshot with persistent setters
  disabled; tests include a hook that distinguishes literal CBS and an `editprocess` handler.
- Astra P13, the transform cache lacks necessary identity: adopt with changes — the key gains the chat id, the target kind, the message id,
  the selected preset id (Phase 3 keeps presets in one singleton, so the collection revision
  cannot distinguish presets), `cbsConditions`, the `prePass` options, and a chat-variable hash
  (Opus P7); the viewport leaves the key (no resize invalidation, per Decision 5). Rejected: a
  per-client plugin or session namespace; a client with a different display-handler set gets a
  different transform version string instead, which the slice now says.
- Astra P14, job-local tool history breaks subsequent turns: adopt — remembered tool calls are conversation data (verified: `decodeToolCall` is
  used by all four adapters when building later requests); the job writes them as
  `chat.toolCalls[id]` through a `meta` op, deleted with the chat and carried in snapshots and
  archives; tests cover a second send after job GC and after a restart.
- Astra P15, the tokenizer spike misses a Docker payload and a VM requirement: adopt — `o200k_base` loads from `@dqbd/tiktoken/encoders/o200k_base.json` (verified
  identical: same `pat_str`, two special tokens, identical `bpe_ranks`); the `vm` wrapper is
  specified as `vm.compileFunction` with `importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`
  (verified: without it `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`, with a plain callback
  `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG`, with the constant it encodes); validation is
  actual encoding in the image's filesystem shape; the stop rule and the fallback are reconciled
  (the spike stops and reports; the `cl100k_base` fallback is the owner's choice).
- Astra P16, several processing paths still lack an implementation owner: adopt with changes — a path-to-owner table is in `post-generation-and-plugin-callbacks`;
  both previews are preserved (`preview` returns the assembled messages, `previewPrompt` the
  provider body through the projection); captioning (`runImageEmbedding`) and `requestWebLLM`
  (verified: it calls `runTransformers`, `request.ts:1514-1547`) are owned by `memory-on-server`
  behind its in-slice Node backend check; non-inlay `stableDiff` and `igp` are assigned. Changed:
  local models are not declared unsupported up front; the check decides.
- Astra P17, a vector table does not automatically integrate restore: adopt — vectors are a disposable cache in a separate `save/data/vectors.sqlite`,
  excluded from snapshots, archives, and restore, cleared after a restore, LRU-bounded (Opus
  P14's variant, which needs no `resourceStore.ts` change).
- Astra P18, keep the slice count, but repair dependencies and rollout ownership: adopt with changes — the hydration and settle primitives (`applyServerGeneration`,
  `applyHydration`) move into `generation-jobs`, before `job-channel` consumes them; slice 7
  depends on 6 and no longer needs callbacks it lacks (the browser path keeps its replacers and
  request trigger client-side); the transform keeps the client `editdisplay` path selectable
  behind the flag until cutover; the flag is client-local (`localStorage`), introduced in
  `prompt-assembly` where first used; `shared/chats.ts`, the resource-route projection, and
  `app.ts` registration are in the relevant allowed-files lists; behavior changes are recorded by
  the slice that introduces them. Changed: the README keeps a single "tested infrastructure vs
  integrated stage" sentence rather than per-slice rollout ownership sections. Also adopted from
  the same point: MCP is its own slice; the early-start gate exception is a proposed phases README
  edit in the report.
- Astra drift check: adopt — drift 2 corrected (the previous runtime declares all 54 names;
  verified with a multi-line pattern), drift 16 reworded (`flushResources` refuses only for a
  character deferred behind a client-side generation), the closeout cache claim narrowed
  (`PlaygroundEmbedding.svelte`, `registerOnnxModel`, `runVITS` keep `hypaVector` and `tfCache`
  in use), Phase 3's contracts described as the contingent drafts they are, and the missed drifts
  added.

## Opus

- Opus P1, Decision 5's bounded worker and memory limits have no owner; regex is unbounded: adopt — fix (a), as for Astra P1; the spike gains the pathological Lua pattern,
  `string.rep`, and ReDoS cases and owns the regex worker and the limits.
- Opus P2, the ported run model conflicts with channel questions, LLM host calls, and the per-target transform: adopt — the process-wide run serialization is dropped (each worker has its own wasm
  module), the per-run and aggregate budgets charge CPU time only (async host functions save the
  remaining budget and restore it with `thread.setTimeout` on resume; verified: `run` checks
  `Date.now() > this.timeout` in the resume loop, `index.js:144-180`), host waits get their own
  caps, and the spike adds the 5 s host promise, the concurrent suspended run, and the 30-target
  transform cases.
- Opus P3, the write-only llmSecrets flip breaks the flag-off browser path: adopt — fix (a), as for Astra P6; slice 7 depends on slice 6; the flag is
  client-local and introduced in `prompt-assembly`.
- Opus P4, openAIKey's non-LLM readers and the mixed containers are unhandled: adopt — redaction by credential path with the sibling fields (`google.projectId`,
  `hordeConfig.model`, `hordeConfig.softPrompt`, `novelai.model`) readable and writable;
  `authRefreshes` stays where Phase 3 puts it (verified in the Phase 3 drafts); the four
  `openAIKey` readers (verified at `tts.ts:200`, `stableDiff.ts:419`,
  `PlaygroundSubtitle.svelte:288`, `modellist.ts:745`) plus Imagen's `google.accessToken` are an
  owner question with option (a) as the proposed default.
- Opus P5, the job writes non-chat records every send; the client mirror never learns: adopt — the client writes `lastInteraction` and `statics.messages` itself in the
  pre-send settle; script-driven server writes to characters and settings reach the client as
  `resource { kind, id, revision, data }` hydration events applied without a notice and never
  queued as edits.
- Opus P6, settleChat misses what the frozen scope reads; drift 16's premise is wrong: adopt — `flushResources()` before the POST, `settleChat` dropped, drift 16 corrected
  (verified: `isBlockedKey` and `isChatDeferred` depend on a client-side generation only,
  `resourceSync.svelte.ts:215-222`, `chatStore.svelte.ts:2389-2396`).
- Opus P7, the transform cache key leaves out chat variables: adopt — the chat-variable hash, `cbsConditions`, the target kind, and the message id
  are in the key; the residual risk records that any variable change re-renders every message.
- Opus P8, the job layer is over-built; WebSocket auth is too broad: adopt with changes — one upgrade dispatcher in `app.ts` instead of a hub refactor
  (`proxyStreamJobs.ts` unchanged); `aux` is a plain streaming HTTP endpoint exempt from the chat
  lock; observers are deferred to Phase 6; the generation socket authenticates with the JWT only
  (verified: `isAuthorizedProxyToken` also accepts the stored password, `auth.ts:108-110`).
  Changed: whether `command` jobs take the chat lock is an owner question with "they do" as the
  proposed default, not decided here.
- Opus P9, slices 8, 9, and 11 are too large; the strict-mode port cost is unbudgeted: adopt — slice 8 split into `lua-bindings-and-buttons` and `trigger-runtime`; MCP is
  `mcp-on-server`; each port slice carries the strict-mode error count from the review as its
  budget; `LLMModel` and `CbsConditions` move to `shared/` in slice 3.
- Opus P10, track A is not independent of Phase 4, and the entry gate is bypassed silently: adopt — Phase 4's CBS item is folded into slice 3 (a proposed Phase 4 file edit in the
  report); the early start of slices 1 to 5 is recorded as a proposed phases README gate
  exception.
- Opus P11, the job tail omits three steps: adopt — `igp` sits before the final write (verified: it appends to the reply through
  `writeText` after auto-continue, `index.svelte.ts:2245-2258`), `imggen` is a client callback
  after `done`, the emotion modes compute on the server and reach the client as one `emotion`
  notice; the already-settled list is applied (image generation is a phase-file edit, `aux` is
  implied by Decision 6, the loop bound is an implementation detail).
- Opus P12, the o200k payload is missing in Docker; the server does not know plugin tokenizers: adopt with changes — the plugin provider's `LLMTokenizer` travels in the hook list's
  frozen descriptors; for the `o200k` payload Astra's variant (load it from the installed
  `@dqbd/tiktoken` package, verified identical) is taken instead of moving the file or editing the
  `Dockerfile`, so no packaging change is needed.
- Opus P13, the lock refusal and the owner's identity across reloads are unspecified: adopt — `reason: "generating"` in `ChatConflict` and the batch 409 body, handled by
  the client's save loop (a refusal to retry after the job, one `chatGenerating` alert; the
  existing alerts are verified to be UI pre-checks); `clientId` in `sessionStorage`; attach to a
  running job from a 409 `chatBusy { jobId }`.
- Opus P14, memory slice storage choice and the channel slice's interceptor claim: adopt — the vector cache is `save/data/vectors.sqlite` excluded from snapshots; the
  interceptor residual-risk sentence is deleted (verified: the callback receives `(body, type)`
  only, `globalApi.svelte.ts:374`, `1092`).

## Counts

Astra (18 points): adopt 7 (P1, P4, P7, P12, P14, P15, P17), adopt with changes 11 (P2, P3, P5,
P6, P8, P9, P10, P11, P13, P16, P18), reject 0. The drift-check section is adopted as written
(not a numbered point). The rejected parts are named inside P3, P5, P8, P10, P13, and P18.

Opus (14 points): adopt 12 (P1, P2, P3, P4, P5, P6, P7, P9, P10, P11, P13, P14), adopt with
changes 2 (P8, P12), reject 0.
