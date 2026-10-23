# Metatron static audit — 2026-10-23

## Scope and result

Read-only source audit of `/home/codex/risuai-metatron`, emphasizing data-loss risks, performance, and inefficient network traffic. Sol performed substantive source analysis and authored this report; Luna exploration agents at Extra High assisted with discovery. Parent independently cross-checked quarantine, lost-create recovery, live-feed retries, image polling, and media caches. No application files were changed.

Context: branch `metatron`, commit `79ae26cc4837090eb75a8b9cd90c6398b79611e8` (`docs(plan): add slice 7 for the channel hazards found in the per-chat send review`). Working tree was clean at inspection; parent reports branch ahead by five commits. References below use absolute source paths and one-based lines at that commit. Most persistence and server findings are already documented hazards; this report validates and prioritizes them, not claims they were newly discovered.

Source behavior described as **confirmed** was inspected. Impacts described as **conditional** depend on the triggering scenario; no runtime benchmark, production incident, power-loss experiment, paid provider call, or browser memory experiment was performed for this audit. Priority P1 means prioritize before relying on the affected persistence flow; P2 means a concrete reliability/resource issue worth scheduling. Severity is contextual, not a claim of exploitability.

| ID  | Priority | Category              | Finding                                                                                     |
| --- | -------- | --------------------- | ------------------------------------------------------------------------------------------- |
| D1  | P1       | Data loss             | Refused chat/record data can remain visible while unload protection excludes it             |
| D2  | P2       | Save recovery         | Lost character-create acknowledgement can leave chat writes waiting for an order revision   |
| D3  | P2       | Data loss             | Concurrent toggle-preset additions can discard a preset while its chat link survives        |
| N1  | P2       | Network               | Live feed resets backoff before reconciliation succeeds                                     |
| N2  | P2       | Network/CPU           | ComfyUI polls all retained history for one prompt                                           |
| N3  | P2       | Network/provider work | Cancellation stops consumers but leaves image/TTS producer work running                     |
| F1  | P2       | Browser memory        | Media object URLs retain bytes beyond cache eviction and chat navigation                    |
| F2  | P2       | Server latency/heap   | Upstream export validates, projects, and compresses the full database on the serving thread |
| F3  | P2       | Resource pressure     | Local-model task queue has no admission or aggregate-byte bound                             |
| F4  | P2       | Cross-job latency     | One tab's outstanding callback blocks other jobs without a queue-wait deadline              |

## D1 — Refused data remains visible but is excluded from close protection

**Confirmed behavior.** [resourceSync.svelte.ts:970](../../src/ts/storage/resourceSync.svelte.ts:970) excludes quarantined resource keys from `hasUnsavedWork`; [the beforeunload listener:3797](../../src/ts/storage/resourceSync.svelte.ts:3797) uses that predicate. [quarantineRecord:980](../../src/ts/storage/resourceSync.svelte.ts:980) retains the refused text/error and alerts, while [recordQuarantine:894](../../src/ts/storage/resourceSync.svelte.ts:894) releases the quarantine only if that record's projection changes. A client-side oversized operation is quarantined at [1224](../../src/ts/storage/resourceSync.svelte.ts:1224); indexed 400/413 refusals use the same mechanism at [1543](../../src/ts/storage/resourceSync.svelte.ts:1543).

The chat variant is more persistent: [quarantineChat:3906](../../src/ts/storage/chatStore.svelte.ts:3906) removes pending/in-flight work, marks it discarded, and keeps the chat quarantined; [takeChatWork:3518](../../src/ts/storage/chatStore.svelte.ts:3518) excludes that chat from later sends. [hasUnsavedChatWork:3074](../../src/ts/storage/chatStore.svelte.ts:3074) excludes quarantined chats and orders, including newly queued work on them. Rendered mirror content is not reverted by quarantine. Oversized chat groups are quarantined with an alert at [resourceSync:1502](../../src/ts/storage/resourceSync.svelte.ts:1502).

**Trigger and conditional impact.** A permanent validation refusal or an oversized write occurs; the user dismisses the initial refusal alert and continues viewing/editing that chat, then closes/reloads once unrelated work settles. The mirror can show data which was never durable, yet closing is no longer warned solely for it. Subsequent edits to a quarantined chat can remain unsent for that session. Data may be lost on reload/exit; already-committed server data is not erased by this mechanism.

**Recommendation.** Separate “cannot currently send” from “unsaved user data.” Keep quarantine in unload protection, show a persistent unsaved/refused state, and provide explicit copy/export/retry/discard recovery. Permit a validated corrected chat to leave quarantine rather than requiring session abandonment. Preserve refusals without creating an automatic infinite retry loop. Resource `flushResources` rejects quarantine; chat quarantine is marked discarded instead, so callers must retain that distinction.

**Confidence/limits.** High source confidence; no actual browser-close experiment. One-time alerts are present, so this is not a claim of entirely silent refusal. Existing documented hazard.

## D2 — Recovery adopts a lost character create without necessarily acquiring its chat-order revision

**Confirmed behavior.** A failed response is treated as possibly committed and saved in doubt at [resourceSync:1536](../../src/ts/storage/resourceSync.svelte.ts:1536). On a retry's resource conflict, [2641–2655](../../src/ts/storage/resourceSync.svelte.ts:2641) adopts matching sent/in-doubt character text and immediately continues. That branch does not enqueue character hydration; the later hydration path is at [2661](../../src/ts/storage/resourceSync.svelte.ts:2661). The server creates a character's order with its successful insert at [resourceStore.ts:953](../../server/src/data/resourceStore.ts:953), and resource conflicts prevent the retried transaction's writes at [928](../../server/src/data/resourceStore.ts:928).

However, [isCharacterKnown:3482](../../src/ts/storage/chatStore.svelte.ts:3482) requires an entry in `orderRevisions` or a character create in the current batch. [takeChatWork:3525](../../src/ts/storage/chatStore.svelte.ts:3525) skips a pending chat create/resend without either. The adopted character no longer needs creation; no order acknowledgement was received. [acceptRemoteCollection:4812](../../src/ts/storage/chatStore.svelte.ts:4812) is one route to acquire the missing revision.

**Trigger and conditional impact.** A batch creating a character and its initial chat commits, its response is lost, and recovery adopts the character while the relevant live update/order hydration has not arrived. The requeued chat resend and later edits can remain parked; a flush can exhaust its ten cycles at [resourceSync:3703](../../src/ts/storage/resourceSync.svelte.ts:3703). This blocks workflows needing a flush and puts later local edits at risk if abandoned. **The initially committed character/chat remain on the server.** An order feed notice or successful revision reconciliation can rescue this gap ([3074](../../src/ts/storage/resourceSync.svelte.ts:3074), [3092](../../src/ts/storage/resourceSync.svelte.ts:3092)); it is not unconditionally permanent. Unsaved-work close protection generally remains active here.

**Recommendation.** When adopting an in-doubt character create, acquire its chat summary/order revision as part of recovery, retaining queued by-id work and avoiding destructive collection replacement. Add a deterministic test losing the create response with no useful feed notice, then edit and flush the chat. Verify later work is saved without a reload.

**Confidence/limits.** High confidence in the recovery/gating gap, conditional confidence in duration because the live feed can repair it. No fault-injection run. Existing documented hazard.

## D3 — Toggle-preset collection conflicts can discard additions independently of chat links

**Confirmed behavior.** [saveTogglePresetFromChat:21](../../src/ts/toggles/togglePresets.svelte.ts:21) adds a preset to `settings.togglePresets`, then separately queues chat metadata with its id. `togglePresets` is a singleton collection ([sections.ts:306](../../shared/sections.ts:306)). It is absent from the addition-merge allowlist at [resourceSync:2366](../../src/ts/storage/resourceSync.svelte.ts:2366); [mergeConcurrentChange:2234](../../src/ts/storage/resourceSync.svelte.ts:2234) consequently rejects this merge and [recovery:2657](../../src/ts/storage/resourceSync.svelte.ts:2657) adopts the remote record. [acceptRemote:1935](../../src/ts/storage/resourceSync.svelte.ts:1935) overwrites the local collection and records a discard.

**Trigger and conditional impact.** Two tabs save additions against the same collection revision. One tab's new preset can be discarded on conflict while its independent chat link later saves, leaving a link to a nonexistent preset and losing the captured preset values. A reload notice exists. Chat toggle values are not necessarily lost merely because the preset is lost.

**Recommendation.** Merge independent additions by stable id using the existing item-list conflict machinery, or use per-preset records with transactional link creation. Test two clients adding distinct presets and linking distinct chats concurrently.

**Confidence/limits.** High. Existing documentation calls this a “whole collection” save, but current `collectionProjection`/`itemProjection` at [614](../../src/ts/storage/resourceSync.svelte.ts:614) can emit item patches. The verified problem is the shared collection revision and missing conflict merge, not necessarily transmission of the entire array on every save.

## N1 — Successful WebSocket hello defeats backoff when revision reconciliation repeatedly fails

**Confirmed behavior.** [eventFeed.ts:93](../../src/ts/network/eventFeed.ts:93) resets `attempt` before `reconcile` finishes. [reconcile:59](../../src/ts/network/eventFeed.ts:59) calls `listRevisions`, closing the socket on ordinary failure. The [close listener:165](../../src/ts/network/eventFeed.ts:165) schedules reconnect; [scheduleReconnect:47](../../src/ts/network/eventFeed.ts:47) uses one second for attempt zero. Every successful hello resets it again.

**Trigger/impact.** WebSocket acceptance/hello remains healthy while `/api/resources/revisions` persistently fails, or sockets repeatedly close shortly after hello. Each tab can repeat a WebSocket handshake, auth-token acquisition, and reconciliation request at roughly one second plus request latency. It does not advance toward the intended 30-second ceiling, increasing server/proxy load during partial failure. No claim that every token acquisition necessarily produces a new key signature.

**Recommendation.** Reset the failure streak after successful reconciliation or a defined healthy connection interval. Keep backoff across brief hello/failure cycles, add jitter, and test several consecutive hello/reconciliation failures.

**Confidence/limits.** High; exact cadence depends on failures, handshake latency, and browser scheduling. Failures before hello already back off correctly. Reconciliation itself is necessary because the feed does not replay missed events.

## N2 — ComfyUI image generation polls and parses unrelated history

**Confirmed behavior.** [stableDiff.ts:562](../../src/ts/process/stableDiff.ts:562) requests `/history`, decodes the whole JSON document, then selects `[id]`. [577](../../src/ts/process/stableDiff.ts:577) waits one second and repeats while waiting for this prompt. The elapsed timeout is checked only after a response completes at [573](../../src/ts/process/stableDiff.ts:573), and the fetch has no abort signal.

**Trigger/impact.** A configured ComfyUI server retains substantial history and a generation remains pending. Network and JSON parsing cost scale with the entire retained history on each poll, not just the pending job. For illustration only, a 10 MB history read 60 times transfers approximately 600 MB before transport compression; this is arithmetic, not an observed measurement. A hung HTTP response can also outlive the configured polling deadline.

**Recommendation.** Use a prompt-scoped history/status endpoint where the deployed API supports it, or filter on the server. Add abortable request deadlines and polling backoff/jitter; consider event-driven progress. Verify configured ComfyUI API compatibility before changing endpoint shapes.

**Confidence/limits.** High source confidence. Actual history size, compression, completion time, and provider API support were not measured. Polling runs only after explicit generation and ordinarily stops at completion/configured timeout.

## N3 — Cancellation leaves auxiliary producer requests and retries alive

**Confirmed behavior.** Image cancellation is checked before provider launch in [stableDiff.ts:58](../../src/ts/process/stableDiff.ts:58), but [75](../../src/ts/process/stableDiff.ts:75) calls `generateAIImage` without a signal/check. The file explicitly documents that in-flight requests are not cancelled at [14](../../src/ts/process/stableDiff.ts:14). Lua image callbacks check only before and after generation ([jobChannel.ts:668](../../src/ts/network/jobChannel.ts:668)); imggen passes a prelaunch check ([766](../../src/ts/network/jobChannel.ts:766)).

TTS has the same consumer/producer split: [stopTTS:496](../../src/ts/process/tts.ts:496) invalidates playback and stops audio but does not abort fetches. In the Hugging Face branch, a 503 with `estimated_time` sleeps and continues at [342](../../src/ts/process/tts.ts:342), without checking the playback generation before another POST at [328](../../src/ts/process/tts.ts:328).

**Trigger/impact.** A job/image callback is cancelled after provider start, or Stop is pressed while TTS waits for an estimated model load. Network/polling and provider work can continue after the result is no longer wanted; TTS may initiate another request after Stop. Cost depends on provider billing, so no specific charge is asserted. Image completion may still reach local display state through its normal delivery path even if its owning callback ended.

**Recommendation.** Propagate an AbortSignal through auxiliary calls, polling, and retry sleeps; recheck cancellation before every retry and before delivery. Use provider-side cancellation only where supported. Aborting a client fetch alone does not guarantee the remote service stops billable work.

**Confidence/limits.** High. Existing post-completion checks suppress some unwanted consumption/persistence, and TTS playback invalidation is present; those do not cancel producer work. No provider calls made.

## F1 — Media object URLs retain page-lifetime bytes despite bounded caches

**Confirmed behavior.** [inlays.ts:531](../../src/ts/process/files/inlays.ts:531) intentionally retains audio/video object URLs for the page; [555](../../src/ts/process/files/inlays.ts:555) creates them and stores them in an unbounded map. This keeps blob data reachable independently of the nominal 64 MiB [blob cache:46](../../src/ts/process/files/inlays.ts:46). Audio/video rendering reaches this through [parser.svelte.ts:859](../../src/ts/parser/parser.svelte.ts:859), including with a working service worker.

Images add a conditional variant: [globalApi.svelte.ts:116](../../src/ts/globalApi.svelte.ts:116) has a per-path source map; [getFileSrc:134](../../src/ts/globalApi.svelte.ts:134) permanently pins plain reads. The [release path:177](../../src/ts/globalApi.svelte.ts:177) only revokes unpinned blobs. If no ready worker controls the page or worker access fails, [247](../../src/ts/globalApi.svelte.ts:247) creates a blob URL. Ordinary chat assets use plain reads ([parser:447](../../src/ts/parser/parser.svelte.ts:447), [625](../../src/ts/parser/parser.svelte.ts:625)).

**Trigger/impact.** A long session visits many distinct large audio/video inlays, or image-heavy chats in fallback mode. Retained media bytes can grow with total visited media even after chat eviction, potentially causing memory pressure or browser termination. The service-worker cache also has no explicit application-level eviction in [sw.js:100](../../public/sw.js:100); its max-age header is not a pruning loop. Browser quota/eviction policies remain a separate limit.

**Recommendation.** Track rendered and cached HTML ownership of object URLs; revoke only after all consumers release them. Bound retained inactive media by bytes, and coordinate eviction with parser/HTML caches to avoid revoking active URLs. Use explicit worker-cache budgets if disk growth matters.

**Confidence/limits.** High source confidence, conditional memory impact; no heap/profile measurements. URL retention is deliberate to preserve cached HTML. Reads share one load per path, so this finding does not claim normal cache hits refetch assets.

## F2 — Upstream export performs full-database work on the serving thread

**Confirmed behavior.** [backupsUpstreamExport.ts:218](../../server/src/routes/backupsUpstreamExport.ts:218) synchronously reads and validates a snapshot, projects it to a flat database, and encodes it before reaching the next await. [resourceStore.ts:1579](../../server/src/data/resourceStore.ts:1579) uses `DatabaseSync`, retrieves all resource rows, parses/normalizes/serializes them, and reads chat rows. [encodeUpstreamDatabase:187](../../server/src/data/upstream/risuSave.ts:187) packs and synchronously compresses the database. The output-size check follows encoding at [backupsUpstreamExport:225](../../server/src/routes/backupsUpstreamExport.ts:225).

**Trigger/impact.** Exporting a large library can block unrelated HTTP/WebSocket work and require simultaneous snapshot rows, projected data, MessagePack/compression buffers, and final bytes. The async route signature does not move these operations off the main thread. A post-encoding size check cannot prevent the allocations required to reach it. Host memory exhaustion is conditional; not demonstrated here.

**Recommendation.** Run validation/projection/encoding in a worker or bounded child process over the copied snapshot; enforce admission and input/output budgets, and preserve snapshot/secret cleanup and cancellation. Prefer streaming where codec compatibility allows it.

**Confidence/limits.** High. Existing staged-export caps and asynchronous backup/file operations mitigate concurrency/I/O, not the synchronous block. Repository documentation has past measurements, but none were repeated or presented as this audit's results.

## F3 — Local-model queue retains unbounded task payloads

**Confirmed behavior.** [transformers.ts:169](../../server/src/prompt/transformers.ts:169) creates an unbounded queue. [run:314](../../server/src/prompt/transformers.ts:314) retains full task payloads and pushes without a count/byte admission limit at [328](../../server/src/prompt/transformers.ts:328). The per-task timeout starts only after dispatch at [302](../../server/src/prompt/transformers.ts:302). The child is forked without its own memory limit ([71](../../server/src/prompt/transformers.ts:71)); model generation can load default fp32 weights ([transformersWorker.ts:71](../../server/src/prompt/transformersWorker.ts:71)).

**Trigger/impact.** Calls arrive faster than the single worker can complete them, or one download/inference is slow while many large texts/base64 images queue. Main-process queued bytes and waiting time grow. A large model additionally puts host/container memory under pressure; child-process isolation does not ensure only the child is killed under OOM. Cached model files also lack a service-level disk budget.

**Recommendation.** Add queue count/byte limits and enqueue deadlines, return a clear busy response, expose queue metrics, and configure container/process resource boundaries and cache retention. Keep the one-process execution and cancellation semantics.

**Confidence/limits.** High source confidence; practical callers/job admission may reduce reachable burst size. Abort removes queued tasks, active tasks have a 15-minute timeout, idle workers exit, and only one task/model process runs at once. No OOM or model downloads attempted. Existing documented hazard.

## F4 — One outstanding client callback delays unrelated jobs without a queue-wait deadline

**Confirmed behavior.** [channel.ts:250](../../server/src/jobs/channel.ts:250) keeps one per-client root lane across jobs. An enqueued request starts with `deadline: Infinity` at [423](../../server/src/jobs/channel.ts:423); its deadline begins when dispatched at [330](../../server/src/jobs/channel.ts:330). Root requests wait while another root is outstanding. Questions allow 120 seconds and ordinary callbacks 60 seconds ([21](../../server/src/jobs/channel.ts:21)); provider callbacks can use a longer caller allowance.

**Trigger/impact.** A slow provider stream or unanswered question of one job occupies a tab's lane while another job waits for its hook/question. The later request's timeout does not include queue time, so user-visible wait is the preceding work plus its own allowance. With no attached owner, queued requests can each wait their dispatch timeout sequentially until their jobs end, holding generation slots and causing failures unrelated to provider speed.

**Recommendation.** Track an overall deadline from enqueue separately from the dispatched interaction allowance; expire/cancel obsolete queued requests, and consider lane separation only where plugin/context semantics permit. Preserve parent-child callback ancestry and ordering constraints.

**Confidence/limits.** High. Queue length is capped at **256**, supplied signals abort queued requests, and job close settles them; the registry imposes a 30-minute job lifetime ([generationJobs.ts:51](../../server/src/jobs/generationJobs.ts:51)). Thus this is head-of-line latency, not an unbounded queue or infinite job claim. Existing documented hazard and active plan work.

## Additional lower-priority observations

- **Legacy browser import has a cross-tab check/delete race.** [browserLocalImport.ts:94](../../src/ts/storage/browserLocalImport.ts:94) reads and compares a legacy value before deleting it by key. Another tab writing a newer value between that read/comparison and `removeItem` at [97](../../src/ts/storage/browserLocalImport.ts:97) can have its newer data deleted while only the older imported copy is on the server. This requires concurrent access to the same legacy store during migration and is already documented. Use a shared migration lock honored by all participating writers, or retain old entries until an explicitly safe cleanup; a comparison in one operation followed by a separate delete is not atomic. Not fault-injected in this audit.

- **Restore watcher does not cancel timed-out reads.** [resourceSync:1904](../../src/ts/storage/resourceSync.svelte.ts:1904) starts a read, races it against a 5-second timer, and repeats without aborting the loser. If reads hang, roughly 20 can remain outstanding across the two-minute watch (5-second race plus 1-second sleep), not one request at a time. The watch is single-flight and only follows maintenance termination, so this is bounded and uncommon. Pass a signal through the read API and cancel the losing request; preserve epoch-change detection. No network hang was induced.
- **Asset acknowledgement is not power-loss durability.** [storage.ts:410](../../server/src/routes/storage.ts:410) stages then renames without fsync. Atomic replacement protects against partial reads but a power loss can lose acknowledged asset bytes; database references and backups may then point at missing content. This is documented and conditional, not observed corruption. If hard durability is required, sync staged files and directories with a documented filesystem policy.
- **Bootstrap/auth has operational exposure.** [auth.ts:169](../../server/src/routes/auth.ts:169) allows the first unauthenticated caller to set an unset password; login/key files use direct synchronous writes ([151](../../server/src/routes/auth.ts:151), [179](../../server/src/routes/auth.ts:179)). A newly exposed uninitialized instance can be claimed first by another caller; interrupted auth-file writes can cause lockout/startup parse failure. This is an existing deployment contract, not an established auth bypass on an initialized instance. Initialize through a trusted channel and use atomic auth-file persistence if resilience is required.

## Coverage, counterevidence, and validation

Guidance read: root `AGENTS.md`, `STRUCTURE.md`, relevant persistence material, global API scope/invariants, self-host server scope/invariants/hazards, backup scope/invariants, and media scope/invariants. Coverage included client save batching/conflict recovery/unload, chat quarantine/order revision admission, toggle presets, live-feed reconnect/reconciliation, ComfyUI polling and image callbacks, TTS stop/retry behavior, object URL/cache lifetime, server upstream export, resource snapshot validation, local-model worker admission, channel queues/deadlines, storage atomic replacement, and auth initialization. Discovery also sampled stream framing and auxiliary retry paths.

Counterevidence retained rather than converted into findings: backups consume `flushResources().discarded` and surface discard information (`backuplocal.ts:118`, `:141`, `:361`, `:381`); ordinary asset loads deduplicate; media blobs have a bounded cache even though URL references bypass its lifetime; server streams send append deltas and skip duplicate snapshots, so no strong universal stream-amplification defect was established. Character records and chat writes use revision/epoch checks and transaction boundaries; this report does not assert general silent overwrite or non-atomic database batches.

Parent ran validation against this clean source tree and supplied these results:

- `pnpm check`: exit 0; svelte-check **0 errors / 0 warnings**, server TypeScript check passed.
- `pnpm --silent test:agent`: exit 0; **6397 passed, 52 skipped, 436 files**, 98.3 seconds. Wrapper reported 93 stderr lines withheld from the passing run and cached the result for future same-tree calls.
- No slow suite, end-to-end suite, build, provider calls, fault injection, or performance benchmarks were run for this audit.

These passing checks establish the existing checks passed; they do not reproduce, dismiss, or measure the conditional risks above. No new tests were added because no product change was requested. This was a targeted cross-subsystem audit, not an exhaustive line-by-line review of every component, dependency, ignored tokenizer payload, third-party code, deployment configuration, or security boundary. No guarantee of absence of additional issues is implied.
