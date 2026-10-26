# Server/client stabilization audit

Date: 2026-10-26 (Asia/Seoul). Source revision: `c1a1d5d6cb2e384c9da71e78cd163b682ac4295c`.

## Assessment

The migration has substantial correctness protections: transactional resource writes, revision and epoch checks, stable message identities, generation ownership, retry reconciliation, lazy chat loading, compressed reads, and verified asset caching. The most consequential remaining gaps are at the boundaries between those mechanisms:

- A persistent chat save refusal can disappear from a later flush result. Backup and generation callers can then act on an older server transcript while the UI retains an unsaved draft.
- Unsaved and conflicting edits have no durable recovery journal. Some ordinary concurrent edits are deliberately discarded, including edits to different fields of the same record.
- Background reads share the critical path of outgoing saves. One stalled refresh can hold unrelated edits in memory.
- Large reads and restore operations still materialize and process substantial data on the one serving thread.
- Some formerly cheap local work now creates avoidable token-count requests; several reactive UI paths still do unnecessary or stale asynchronous work.

This report documents findings and recommended changes; it does not modify application behavior. Several underlying limitations already appear in the structure guides. They are included where current source confirms them and where their practical consequences matter. The guides were treated as navigation aids, not proof: at least one hazard description is already stale.

## Scope and evidence

Reviewed paths include resource/chat persistence and conflicts, unload handling, backup/import, asset lifetime, generation admission and hydration, event synchronization, tokenization, search, and chat/PWA effects. The deployment model reviewed is the supported single Node process with a local save directory and one or more browser tabs/devices.

Evidence labels used below:

- **Confirmed:** the behavior follows from the current implementation, often with an existing test asserting the relevant state transition.
- **Measured:** a bounded synthetic experiment exercised the real store implementation. Measurements are illustrative, not production capacity numbers.
- **Conditional:** the necessary environment or timing is identified, but the complete browser/failure scenario was not reproduced in this audit.

P1 means a high-priority loss-of-work or misleading durability boundary. P2 means a significant conditional correctness, latency, or resource-use issue. P3 means a smaller optimization or narrower recovery gap. These priorities are recommendations, not claims that every scenario occurs frequently.

All source line references are for the revision above. Test commands and limitations are recorded at the end.

## Prioritized findings

| ID  | Priority | Finding                                                                                           | Primary impact                                         |
| --- | -------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| F01 | P1       | **Fixed 2026-10-26.** Persistent chat refusals are missing from subsequent flush readiness checks | Backup omission; generation on an older transcript     |
| F02 | P1       | Unsaved intent exists only for the lifetime of the tab                                            | Lost drafts after page loss or reload                  |
| F03 | P2       | Coarse conflict recovery discards unrelated and newer local edits                                 | Multi-tab/device data loss                             |
| F04 | P2       | Incoming refreshes block outgoing saves                                                           | Save latency and increased unsaved window              |
| F05 | P2       | A newer chat read can clear a still-active generation lock                                        | Discarded edits; possible overwrite after completion   |
| F06 | P2       | Restore/import validation and installation block the serving thread                               | Whole-server stalls and memory pressure                |
| F07 | P2       | Read limits count references rather than resulting bytes                                          | Large allocations, latency, and response amplification |
| F08 | P2       | Asset and backup retention lack a coordinated byte budget                                         | Disk growth and eventual write failures                |
| F09 | P2       | Abortable UI token counters bypass request batching                                               | Bursty requests and duplicate count work               |
| F10 | P2       | A Google count batch can become many sequential provider calls                                    | Slow counters and excessive upstream requests          |
| F11 | P2       | **Fixed 2026-10-26.** Suggestion translation effects can apply results to another chat            | Incorrect suggestion labels and wasted work            |
| F12 | P2       | Rendered streaming repeatedly processes the growing message                                       | Mobile/slow-device responsiveness                      |
| F13 | P2       | Asset fallback retains original blobs and bypasses thumbnails                                     | Browser memory and bandwidth in fallback environments  |
| F14 | P3       | PWA foreground reconciliation rewrites unchanged push subscriptions                               | Repeated requests and durable disk writes              |
| F15 | P2       | An unanswered job-create request has no durable idempotent identity                               | A retry can generate an additional reply               |
| F16 | P2       | Command follow-up work ends up owned by the page again                                            | Remaining work disappears after reload/failure         |
| F17 | P2       | Streamed request bodies are buffered before general-route authentication                          | Unnecessary pre-authentication memory and work         |

### F01 — Persistent chat refusals are missing from subsequent flush readiness checks

**Confirmed; highest-priority cross-boundary defect.**

**Fixed 2026-10-26** (commit `fix(storage): report still-refused drafts from the save barrier`): `flushResources` resolves with `refused` (every key still refused when it resolves) beside `discarded`; a refused chat order no longer makes the flush wait and is reported there too. Server job admission refuses a job whose chat or character order is refused (`serverJob.refusedDraft`), both backup exports name the refused items and say the archive lacks them, and the callback barrier does not count a locally refused chat as held at an equal revision. Left open from the recommendation: the recovery export of local drafts (deferred with F02).

`quarantineChat` retains refused operations and the local draft, removes pending work, and records a discard event. `flushResources` rejects refused resource records, but its chat discard result describes events since that call or mutation scope. It does not describe every chat that remains refused. A later flush can therefore return an empty discard list while the chat is still unsaved.

Evidence: [chat quarantine](../../../src/ts/storage/chatStore.svelte.ts#L4265), [record-only quarantine rejection](../../../src/ts/storage/resourceSync.svelte.ts#L1015), [flush obligation/discard window](../../../src/ts/storage/resourceSync.svelte.ts#L3825). The existing [quarantine test](../../../src/ts/storage/tests/resourceSyncChats.test.ts#L453) demonstrates a retained draft, unchanged server value, later successful flushes, and a continuing unload warning.

Two consumers turn this into a user-visible correctness problem:

1. **Backup:** both [archive export](../../../src/ts/drive/backuplocal.ts#L111) and [upstream export](../../../src/ts/drive/backuplocal.ts#L356) check the flush result and then export server data. If autosave already quarantined a draft, a later backup can succeed without that draft and without a new discard warning. A backup that first encounters the refusal does report the discard; the gap concerns persistent refusals on subsequent calls.
2. **Generation:** [job admission](../../../src/ts/process/serverCommands.ts#L556) uses the same per-call discard check. A normal nonempty send passes its text to the server without first appending a local message ([input handoff](../../../src/lib/ChatScreens/DefaultChatScreen.svelte#L467)), so it does not inherently release the quarantine. When the refusal predates the send and the held server revision remains current, the job can run while the UI still holds the refused transcript. [Chat hydration holds](../../../src/ts/storage/chatStore.svelte.ts#L1493) protect quarantine from replacement, making the divergence persist. Continue can also hit this when it queues no local “say nothing” edit; reroll performs a local edit and follows a different path.

**Existing protection:** a refusal alert, retained draft, unload warning, explicit Retry/Discard controls, and server revision checks. [Checkpoint preparation](../../../src/ts/checkpoints/chatCheckpoints.svelte.ts#L184) already checks the refusal inventory before and after flushing. Callback receipt barriers reject a newer revision that quarantine prevents the client from adopting, but [their revision comparison](../../../src/ts/network/jobChannel.ts#L544) can pass an equal held revision despite a refused local draft. An [input-stage hook before the input append](../../../server/src/prompt/runner.ts#L428) can encounter that distinction. Include callback readiness in the same correction rather than assuming revision equality proves a clean mirror.

**Recommendation:** distinguish “no outstanding queued writes” from “all relevant state is durable.” Add a persistent refusal/unsaved result or a strict flush mode. Block a send when its target chat remains refused; make exports explicitly account for all refused drafts. Offer a recovery export of local drafts, separate from a server backup. Preserve the existing ability to save unrelated healthy records.

**Regression scenario:** quarantine a chat through a validation refusal, let the initial alert settle, then independently attempt backup and ordinary text send. Assert that neither silently treats the local transcript as saved. Also test a refusal that predates the caller's mutation scope.

### F02 — Unsaved intent exists only for the lifetime of the tab

**Confirmed durability limitation, particularly relevant to mobile/PWA use.**

Resource dirty, uncertain-acknowledgment, and refusal state lives in module Maps ([resource state](../../../src/ts/storage/resourceSync.svelte.ts#L255)); chat pending/in-flight/refused state does too ([chat state](../../../src/ts/storage/chatStore.svelte.ts#L223)). The normal scheduled save delay is 500 ms, and failures extend the window.

The unload fallback is deliberately narrower than the regular save protocol. [Chat unload collection](../../../src/ts/storage/chatStore.svelte.ts#L2031) excludes new chats, uncertain exact resends, in-flight/deferred/quarantined work, and unsupported operations. [Page lifecycle handling](../../../src/ts/storage/resourceSync.svelte.ts#L3945) starts ordinary saves when hidden and sends eligible chat operations on pagehide. The keepalive body budget is 60 KiB and requires a prepared token ([unload transport](../../../src/ts/storage/resourceClient.ts#L312)). It does not durably cover settings, character records, chat creation/replacement, or orders.

**Scenario:** a page is lost before a save acknowledgment, or a refused draft survives for a while and the user later reloads. Boot restores the server copy, not the pending local intent. The same concern applies when an epoch replacement deliberately halts saving and reloads ([restore handling](../../../src/ts/storage/resourceSync.svelte.ts#L1955)). This is distinct from SQLite losing an acknowledged transaction.

**Existing protection:** debounce, retry/backoff, hidden-page flushing, an unload warning, keepalive for eligible operations, and retention while the tab survives. These reduce loss but do not recover from the loss of the JavaScript heap.

**Recommendation:** journal non-secret pending mutations and refused/conflicting snapshots in bounded IndexedDB storage, keyed by server identity and epoch. Keep stable operation IDs for uncertain acknowledgments. On an epoch change, offer recovery/export rather than replaying stale operations automatically. Do not journal plaintext credential writes as an incidental part of this feature.

**Validation target:** terminate a browser context after making each mutation category, before its acknowledgment; reopen and verify recoverability. Include server outage, oversized chat refusal, and restore while another tab has a draft.

### F03 — Coarse conflict recovery discards unrelated and newer local edits

**Confirmed intentional conflict policy; significant loss-of-work tradeoff.**

Not all resources support a three-way merge. [Merge eligibility](../../../src/ts/storage/resourceSync.svelte.ts#L2341) excludes ordinary settings sections; character merges accept only restricted changes, and collection merging mainly preserves additions. [Item merging](../../../src/ts/storage/resourceSync.svelte.ts#L2493) refuses a substantive local edit to an existing item when it differs from both the saved and remote versions.

Recovery then [accepts the remote record](../../../src/ts/storage/resourceSync.svelte.ts#L2782), replacing the local mirror and clearing dirty state ([acceptRemote](../../../src/ts/storage/resourceSync.svelte.ts#L2038)). This settles the current local generation, including edits made after the conflicting request was dispatched.

The [live-sync test](../../../src/ts/storage/tests/resourceSyncLive.test.ts#L323) explicitly covers another tab changing `ui.zoomsize` while this tab changes `ui.iconsize`; the local icon-size edit is discarded despite touching another field. This test passed during the audit.

**Existing protection:** revision checks protect the earlier committed writer, and a reload notice/discard report makes the conflict visible. Safe additions and some dictionaries merge. By-id chat operations are more granular than these whole-record resources.

**Recommendation:** first retain conflict drafts before accepting remote data. Then add field/item-level conflict resolution for independent fields. Keep semantically coupled fields together; indiscriminate merging would create different consistency problems. Avoid making a user reconstruct a long character, preset, or lore edit from a generic reload notice.

### F04 — Incoming refreshes block outgoing saves

**Confirmed structure; stalled-network scenario not reproduced end to end.**

Every [save cycle](../../../src/ts/storage/resourceSync.svelte.ts#L1564) awaits deferred-chat reloads, character hydration, remote updates, and idle chat refreshes before collecting outgoing operations. All callers share [one in-flight cycle](../../../src/ts/storage/resourceSync.svelte.ts#L1523). Idle refreshes issue [whole-chat and summary reads](../../../src/ts/storage/resourceSync.svelte.ts#L2958).

The [resource transport](../../../src/ts/storage/resourceClient.ts#L102) and [auth fetch wrapper](../../../src/ts/storage/serverAuth.ts#L178) supply no default application deadline for these reads. A refresh that remains pending blocks independent writes and explicit flushes. A refresh that repeatedly fails can repeatedly prevent the write stage, because retries restart the cycle from its read stages.

**Scenario:** a notice requires reloading a large unrelated chat, and that response stalls. The user edits a setting or another chat, but those writes wait behind the read. Send and backup flows awaiting flush can appear hung. This also widens F02's unsaved-data window.

**Existing protection:** bounded read counts, batching, eligibility checks, and retry backoff. They limit work but do not isolate outgoing progress.

**Recommendation:** separate background refresh scheduling from outgoing saves, retaining dependencies only for records whose write requires that refresh. Add cancellable read deadlines and record the reason/time a save waits before dispatch. Test with a deferred or rejected read of chat A while a write to chat B or a settings record is ready.

### F05 — A newer chat read can clear a still-active generation lock

**Confirmed code path; complete race conditional.**

[dropFeedLocksOf](../../../src/ts/storage/chatStore.svelte.ts#L1401) treats a newer authoritative chat revision as sufficient to drop feed locks. A revision can advance because another message or chat field changed while the original generation is still active. Whole-chat adoption calls this path ([adoption](../../../src/ts/storage/chatStore.svelte.ts#L4639)).

An unlocked UI can then allow edits to the generating message. The server correctly rejects them while its lock remains active. However, [dropLockedEdits](../../../src/ts/storage/chatStore.svelte.ts#L4560) removes sent and queued edits while leaving the edited mirror visible until refresh. If every operation was dropped, recovery need not retain a retry block ([recovery](../../../src/ts/storage/chatStore.svelte.ts#L4351)). Another local edit before refresh can be based on the stale display; if the generation ends before that edit reaches the server, it can overwrite the completed answer.

**Existing protection:** the server ownership fence prevents writes during generation, and subsequent job/feed frames can restore lock information. This is not a server-side failure to enforce an active lock.

**Recommendation:** keep lock lifetime independent of general chat revision advancement. Return active-lock state with authoritative reads, or require explicit release/terminal reconciliation. After a generating conflict, block that message through authoritative refresh even when no other operations remain; preserve the refused edit separately.

**Validation target:** hold a provider response open, advance an unrelated chat field, adopt that whole read in another tab, then attempt edits before and around completion using deterministic latches.

### F06 — Restore/import validation and installation block the serving thread

**Confirmed and measured.**

[Snapshot validation](../../../server/src/data/resourceStore.ts#L337) performs integrity checking, reads resources into arrays, parses/normalizes them, then reads all chat/message/order rows ([chat snapshot reader](../../../server/src/data/chatStore.ts#L1940)). [Installation](../../../server/src/data/resourceStore.ts#L1907) synchronously inserts the replacement state in one transaction and normalizes records again.

The local archive route invokes this validation [before entering maintenance](../../../server/src/routes/backups.ts#L344); snapshot restore does it [inside maintenance](../../../server/src/routes/backups.ts#L96). Upstream conversion has a worker, but its [commit path](../../../server/src/routes/backupsUpstream.ts#L411) validates the staged store again on the serving thread. Streaming the upload does not make these later phases streaming or asynchronous.

With one synthetic chat containing 5,000 messages of 2,048 ASCII characters each, validation took **197.2 ms** and replacement **130.3 ms** in this workspace. Each is a synchronous interval; larger histories and checkpoints can increase both CPU and live allocations. These are single illustrative observations, not production latency estimates.

**Existing protection:** staged uploads, safety snapshots, maintenance admission, transactional replacement, and epoch fencing protect consistency. Moving work must retain those guarantees.

**Recommendation:** validate staged databases in a worker and avoid returning the entire validated database as a large object graph. Consider a dedicated database worker for both normal queries and replacement, or a carefully fenced staged database installation protocol. Expose restore progress and admission state. Merely adding `await` around a synchronous loop will not isolate it from the serving thread.

### F07 — Read limits count references rather than resulting bytes

**Confirmed and measured.**

`POST /api/resources/read` accepts up to 5,000 combined references/collections ([validation](../../../server/src/routes/resources.ts#L124)). It does not deduplicate references or impose a response byte budget. [readRefs](../../../server/src/data/resourceStore.ts#L1447) independently reads each requested chat, and a collection reference can expand into many chats. Even a single long chat has no message-page boundary at [readChat](../../../server/src/data/chatStore.ts#L1793).

[compressedJson](../../../server/src/http/compressedJson.ts#L64) does move compression to the zlib pool, but it first synchronously stringifies the full response and constructs an input Buffer. Compression saves wire bytes, not the preceding parsing, object allocation, or serialization.

The same synthetic chat produced:

| References to that chat | Store read | JSON stringify | Uncompressed JSON | Heap increase through serialization |
| ----------------------- | ---------- | -------------- | ----------------- | ----------------------------------- |
| 1                       | 33.5 ms    | 36.2 ms        | 10,454,174 bytes  | 31.6 MiB                            |
| 5                       | 289.8 ms   | 167.3 ms       | 52,270,510 bytes  | 113.7 MiB                           |

This exercised the store directly with inputs the route accepts; it was not an HTTP load test. Duplicate references are an API amplification case, not a claim that the normal UI routinely sends duplicates. Distinct large chats and collections still have the underlying byte-budget problem.

There is a related boot cost even without message downloads: [readSummaries](../../../server/src/data/chatStore.ts#L1758) selects every full metadata JSON value, and [chatSummary](../../../server/src/data/chatStore.ts#L734) parses it to extract a few list fields. Large memory/lore metadata is processed even though it is omitted from the wire summary. Boot's record cache does not turn that metadata read into a small indexed projection.

**Existing protection:** lazy client loading, idle-chat eviction, compressed responses, operation-count caps, boot revision/item caching, and eligible feed patches. These materially reduce typical traffic.

**Recommendation:** deduplicate references, introduce response byte budgets and pagination, and separate list projections from bulky chat metadata. Add message-window reads for ordinary display, with explicit complete reads for export/plugin contracts. Bound concurrent heavyweight reads and compression jobs. A small request body must not imply an acceptably small response.

### F08 — Asset and backup retention lack a coordinated byte budget

**Confirmed lifecycle limitation.**

The [snapshot scheduler](../../../server/src/data/snapshots.ts#L9) keeps 20 database snapshots by count and takes a new one after changed data at its interval. [Snapshot retention](../../../server/src/data/snapshots.ts#L115) removes old database files, not assets. [Inlay deletion](../../../src/ts/process/files/inlays.ts#L619) intentionally retains media because snapshots can reference it. Explicit [asset removal](../../../server/src/routes/storage.ts#L618) exists, but there is no corresponding reference-aware primary-asset collector. Thumbnail cleanup is separate and does not impose a total primary-asset budget.

**Impact:** repeated imports, image generation, deleted chats, and failed imports that already linked some assets can grow the save directory. A count cap on full database snapshots can also retain roughly 20 database copies, in addition to live data and other staging/cache storage. The eventual failure is disk exhaustion affecting future saves/backups, not immediate deletion of acknowledged chat data.

**Recommendation:** expose disk use by live database, snapshots, assets, thumbnail cache, and staging. Add configurable byte budgets and low-space admission behavior. Garbage collection must mark references from live records **and retained snapshots/checkpoints/prepared operations**, then use a grace period before sweeping. Do not implement “delete assets absent from current chats” alone.

### F09 — Abortable UI token counters bypass request batching

**Confirmed request-shape issue; magnitude depends on mounted fields and cache state.**

[countTokensInScope](../../../src/ts/tokenizer.ts#L180) batches signal-less calls in one macrotask. A call carrying an `AbortSignal` instead dispatches its own request immediately. Every [createTokenCountField execution](../../../src/ts/tokenCountField.ts#L44) supplies a signal; initial execution is immediate, while later edits debounce.

Examples include [lore fields](../../../src/lib/SideBars/LoreBook/LoreEntryFields.svelte#L24) and [the context meter](../../../src/lib/ChatScreens/ContextMeter.svelte#L231), which can separately request reply and draft counts on a cache miss. N simultaneously mounted uncached fields can therefore make N POSTs. Identical concurrent fields can also duplicate work: the ordinary client/server caches store completed results; the general [server encode path](../../../server/src/prompt/tokens.ts#L217) has no equivalent of Google's in-flight map.

**Existing protection:** per-field debounce and cancellation, completed-result caches, signal-less batching, and server body/text limits. This is not an unbounded request on every keystroke.

**Recommendation:** batch independently cancelable consumers. Detach an aborted consumer from a shared batch and abort the underlying request only when no live consumer needs it. Deduplicate by text plus tokenizer identity. Count only visible/expanded fields and avoid requesting unchanged reply text when counting an edited draft.

**Validation target:** mount several token fields together, supersede one, and assert the others share a request without losing cancellation correctness.

### F10 — A Google count batch can become many sequential provider calls

**Confirmed conditional behavior when the selected tokenizer uses Google counting.**

The client can batch up to 256 texts, but the [server route](../../../server/src/routes/tokens.ts#L97) awaits each count sequentially. A distinct uncached text in the Google branch becomes its own [provider request](../../../server/src/prompt/tokens.ts#L84). [Chat counting](../../../src/ts/tokenizer.ts#L326) counts message contents individually, so batching browser requests does not necessarily reduce upstream request count.

For N distinct cold-cache texts in one request, latency includes approximately the sum of N upstream count round trips. A batch of 256 texts can entail 256 provider calls. This is a static bound from the call structure, not a measured provider benchmark.

**Existing protection:** Google result caching and [in-flight deduplication](../../../server/src/prompt/tokens.ts#L155), an eight-active-request global limit, cancellation, and per-request timeout. These limit repeats and concurrency; they do not eliminate first-use volume or serial latency within a batch.

**Recommendation:** separate interactive estimates from exact provider budgeting. Cache counts per message/content hash and tokenizer identity, and compute exact prompt-level counts where the provider's semantics permit it. If exact independent counts remain necessary, use bounded parallelism within the existing global limit rather than an unbounded `Promise.all`. Do not concatenate texts naively: tokenization boundaries and per-message overhead must remain correct.

### F11 — Suggestion translation effects can apply results to another chat

**Fixed 2026-10-26** (commit `fix(ui): stop the LoRA editor republishing a stale draft and drop stale async results`): `translateSuggest` translates a copy of the list taken at its start, checks after every translation that its run is current and the same chat is selected, and shows the whole result only then; the effect's cleanup and unmount end the run.

**Confirmed missing async ownership guard; timing scenario conditional.**

[Suggestion translation](../../../src/lib/ChatScreens/Suggestion.svelte#L244) clears a shared output array, reads the live `suggestMessages` collection, awaits `translate`, then writes by index. Its [effect](../../../src/lib/ChatScreens/Suggestion.svelte#L296) can rerun when the list or translation toggle changes. Chat selection changes that list through [updateSuggestions](../../../src/lib/ChatScreens/Suggestion.svelte#L75).

**Scenario:** start a slow translation in chat A, then switch to B. A's completion can write into B's translated array. The loop also reads the live collection after subsequent awaits, so one run can mix lists. The [rendered button label](../../../src/lib/ChatScreens/Suggestion.svelte#L338) may then show text unrelated to the original suggestion that its click handler sends.

**Existing protection:** suggestion generation itself has request-ID/abort/chat guards. The separate display translation lacks them. This finding concerns presentation and user intent, not a proven automatic overwrite of persisted chat messages.

**Recommendation:** capture an immutable suggestion list, chat identity, and run token; ignore stale results and cancel work when supported. Invalidate the run on toggle changes and destruction. Publish a completed result only to its captured owner. Use a deferred translator to test out-of-order completion across chat selection.

### F12 — Rendered streaming repeatedly processes the growing message

**Confirmed mechanism; performance severity needs device measurements.**

Stream text updates are limited to at most one animation-frame application ([stream update](../../../src/ts/storage/chatStore.svelte.ts#L1151)). In Off/Balanced rendering, [Chat's pre-effect](../../../src/lib/ChatScreens/Chat.svelte#L673) reruns the display pre-pass, and [ChatBody's derived parse](../../../src/lib/ChatScreens/ChatBody.svelte#L419) reparses the growing message. The [completion effect](../../../src/lib/ChatScreens/ChatBody.svelte#L436) also invokes image checks before and after parsing; those checks matter when the corresponding image-handling option is enabled.

Frame throttling limits frequency, not work per update. Processing prefixes of increasing length accumulates cost proportional to the sum of their lengths. A stale parse-run guard prevents obsolete results from winning, but does not cancel all obsolete work already started. Long outputs, complex Markdown/CBS, image-heavy content, and slower/mobile CPUs are the relevant combination.

**Important exclusion:** this does **not** imply a server transform request per frame. [serverProcessScript](../../../src/ts/parser/transformClient.ts#L436) returns early for a locked streaming message. The lock-release transition enables the final transformation. Strong streaming mode also bypasses most normal rendering while showing raw stream text.

**Recommendation:** measure long tasks and input/scroll latency in each mode on target devices. Consider a render cadence lower than provider/frame cadence, a single latest pending render, incremental/stable-prefix parsing where feasible, and one final authoritative rich render. Expose or recommend Strong mode based on measured device behavior rather than changing all environments blindly.

### F13 — Asset fallback retains original blobs and bypasses thumbnails

**Confirmed conditional environment issue.**

Direct assets require a capable controlling service worker ([capability gate](../../../src/ts/globalApi.svelte.ts#L174)). Without it, [getFileSrc](../../../src/ts/globalApi.svelte.ts#L133) pins each plain-read source for the page. [getThumbSrc](../../../src/ts/globalApi.svelte.ts#L162) falls back to the original asset. [Fallback loading](../../../src/ts/globalApi.svelte.ts#L301) reads each distinct uncached asset individually and may create a Blob URL. [Release logic](../../../src/ts/globalApi.svelte.ts#L282) refuses to revoke pinned entries.

**Scenario:** a page with disabled/unavailable/failed worker support browses many characters or media-heavy chats. It downloads originals where the direct path would use thumbnails and can retain every visited original Blob for the page lifetime. N distinct uncached assets produce N backend reads; same-key requests do share work. A functioning fallback worker may serve cached URLs instead of Blobs, so indefinite Blob retention applies specifically to the object-URL branch. Worker registration/check requests intercepted by the service worker are local traffic, not additional transfers to the remote server.

**Existing protection:** direct immutable HTTP caching, server thumbnails and transform deduplication, shared same-key fallback loads, and hold/release semantics for some previews. The problem is the fallback behavior of ordinary plain reads.

**Recommendation:** extend component-owned hold/release lifetimes to ordinary visible assets, give fallback storage a byte budget, and retain thumbnail-sized delivery even without direct worker signing. Promote subsequent loads to direct URLs once the worker becomes ready. Keep authenticated asset access intact.

### F14 — PWA foreground reconciliation rewrites unchanged push subscriptions

**Confirmed; modest individually, multiplied by foregrounds/tabs.**

The [push settings effect](../../../src/lib/Others/PushPrompt.svelte#L24), boot reconciliation, and every [visible transition](../../../src/ts/network/pushNotifications.ts#L503) can invoke reconciliation. For an eligible browser, [ensureSubscribed](../../../src/ts/network/pushNotifications.ts#L272) obtains the existing subscription and still PUTs it. The server [register function](../../../server/src/push/pushService.ts#L448) updates its timestamp and commits the subscription list even when endpoint/keys are unchanged.

**Existing protection:** permission, availability, setting and opt-out gates; one start per tab; serialization/locking. Serialization does not deduplicate repeated successful reconciliations. The browser's `getSubscription()` is a local API call; the PUT is the relevant application request.

**Recommendation:** deduplicate reconciliation in flight and suppress unchanged registration for a bounded interval keyed by server public key and subscription identity. Make unchanged registration a server no-op unless an intentional last-seen refresh interval elapsed. Preserve recovery after server key rotation and subscription deletion.

### F15 — An unanswered job-create request has no durable idempotent identity

**Confirmed protocol gap; duplicate-completion scenario conditional.**

The client [remembers a generation id](../../../src/ts/network/generationJobs.ts#L328) only after the create response body arrives. If the server accepted the request but the answer was lost, [the caller reports an unknown outcome](../../../src/ts/process/serverCommands.ts#L635) and has no id to follow directly.

Retrying while that job is active is handled well: `chatBusy` identifies the job, the owner reads its status, and follows it. The stable `userMessageId` also [prevents duplicate input appends](../../../server/src/prompt/runner.ts#L416). However, once the original job has completed and the client has acquired the current chat revision, explicitly resending the same intended input can admit another generation. One route to this is a create failure that settles before the feed shows the accepted user message: [draft settlement](../../../src/lib/ChatScreens/DefaultChatScreen.svelte#L669) restores the composer text, and a later feed update does not itself clear that restored draft. Deduplicating the input message does not deduplicate producing its reply. Feed updates may reveal the first result before the user resends, which reduces the likelihood; this is not a claim that a normal socket reconnect starts another generation.

**Recommendation:** allocate a stable client request id before POST and map it to the admitted job/outcome on the server, scoped to client/epoch and retained through a documented retry window. Persist enough receipt information to resolve ambiguity across restart if that is the intended guarantee. A deliberate regenerate action should use a fresh request id.

**Validation target:** accept a create but drop its response, allow it to finish, refresh the chat, then retry with the same request id. Assert one generation and a recovered result, while a distinct regenerate request still runs.

### F16 — Command follow-up work ends up owned by the page again

**Confirmed task-completion limitation.**

After a command job's terminal event, [the client launches follow-ups](../../../src/ts/process/serverCommands.ts#L172), including `/multisend` parts, without awaiting them in the job caller. It marks the job followed-up before executing the sequence; thrown chain exceptions are caught only by `console.error`. Individual failed sends can have their own alerts, and a false result can stop the sequence. A page reload drops the remaining parts. The source explicitly records this limitation.

**Impact:** a server job can be reported done while user-requested follow-on work is only partially complete. Moving the initial command to the server has not made this whole task independent of the browser lifetime. Oversized terminal follow-ups and an unrecoverable chat do have explicit warning paths; the gap here is loss or failure after the sequence began.

**Recommendation:** represent follow-ups as a durable operation sequence with progress/receipts and an idempotency key per part. Run server-capable steps on the server; persist and explicitly resume steps that genuinely require browser callbacks. At minimum surface partial completion and which parts remain instead of logging only to the console. Test reload/failure between parts, not just their normal ordering.

### F17 — Streamed request bodies are buffered before general-route authentication

**Confirmed with a bounded in-process request probe.**

The [global 100 MiB body limiter](../../../server/src/app.ts#L637) runs before the general resource route's authentication and route limiter. [limitedBody](../../../server/src/routes/limitedBody.ts#L6) delegates to Hono's body-limit middleware. In the installed Hono 4.13.9 implementation, a body without a trusted Content-Length is read into a chunk array before the downstream handler runs. Consequently, an unauthenticated streamed request to a general resource endpoint can incur the buffering work before it is rejected.

An in-process `createServerContext` probe sent 48 chunks of 64 KiB, with no auth or Content-Length, to `POST /api/resources/read`. It consumed all **3,145,728 bytes** before returning HTTP 400 with `No auth header`. Controls using `/api/resources/boot` and `/api/resources/boot/` each pulled only one prefetched 64 KiB chunk before the same rejection: those routes use their own post-auth cap. The trailing-slash form did not bypass that control in the actual runtime.

**Impact:** unnecessary memory/work before admission, potentially multiplied by concurrent slow or large requests. The 100 MiB cap still applies; this is neither an authentication bypass nor proof of an observed production outage. The probe did not attempt a maximum-size or concurrent load.

**Recommendation:** authenticate and apply admission/rate limits before buffering ordinary protected endpoints, then enforce route-appropriate streaming size limits. Give small control/read bodies much smaller caps than bulk resource writes. Preserve independent caps for intentionally unauthenticated auth/setup routes and the existing streaming import paths.

## Additional findings and narrower risks

### Restart preserves checkpoints, not the complete running job

**P2 durability tradeoff to document and test.** Running jobs and kept outcomes live in [in-memory Maps](../../../server/src/jobs/generationJobs.ts#L449). A hard restart loses that status and any text since the last successful durable checkpoint. [Streaming checkpoints](../../../server/src/prompt/runner.ts#L1981) target a three-second interval, and normal Stop/read-error paths try to save final partial text. Three seconds is a scheduling target, not a strict crash-loss bound under event-loop stalls or persistence failures. Reconnect to an unknown job refreshes stored chat state rather than recreating it automatically ([recovery](../../../src/ts/process/serverCommands.ts#L382)).

If resumable execution is required, persist job admission/outcome metadata and distinguish interrupted from normally completed generation in the UI. Otherwise document the checkpoint guarantee explicitly and test process termination after a visible chunk but before its checkpoint.

### Job socket output has no explicit slow-consumer buffer policy

**Performance candidate, not a demonstrated failure.** The [runner emits each provider chunk](../../../server/src/prompt/runner.ts#L2040), and [socket send](../../../server/src/jobs/generationJobs.ts#L464) does not check `bufferedAmount` or await send completion. The transport already [converts text to deltas](../../../server/src/jobs/generationJobs.ts#L1060), so this is not repeated full-prefix network transfer. Client frame coalescing reduces rendering work but does not control bytes queued on the server for a slow socket.

Measure buffered bytes under a throttled connection and high-output provider. Add a bounded queue/coalescing policy or detach-and-resync behavior if needed. Any dropped/coalesced chunk must preserve the existing sequence/base protocol; simply skipping delta frames would break reconstruction.

### Backup repair preserves existing invalid asset files

**P2/P3, conditional integrity/recovery limitation.** [restoreValidated](../../../server/src/routes/backups.ts#L412) skips an existing asset path based on `lstat`, without checking file type or content hash. Newly staged assets are hashed for cache verification, but a mismatch does not reject the import. Thus importing a good backup does not repair a corrupted existing file under the same logical key. Normal UI writes derive keys from content, so the relevant trigger is disk corruption, external filesystem changes, or direct authenticated legacy storage writes—not ordinary same-content UI saves.

Use content verification for repair decisions, distinguish valid-existing from conflicting-existing assets in the report, and offer explicit repair/quarantine behavior. Do not silently overwrite an unrelated file. A database-only snapshot cannot recover missing asset bytes.

### Prepared exports hold live asset paths, not immutable asset snapshots

**P3 under direct API/external file mutation.** Upstream export can wait at a confirmation dialog between [preparing asset paths](../../../server/src/routes/backupsUpstreamExport.ts#L226) and [opening them for download](../../../server/src/routes/backupsUpstreamExport.ts#L400). Deletion or overwrite during that interval can fail the stream or change its bytes. Normal UI content-addressed writes and metadata-only deletion make this narrower than an ordinary concurrent chat-edit race. The [v2 export test](../../../server/src/tests/backups.test.ts#L593) explicitly expects stream failure if a preflighted file disappears; it does not silently produce a supposedly complete archive. The [record stream](../../../server/src/http/recordStream.ts#L21) uses one file handle once opened, avoiding mixed versions during an atomic rename.

If direct storage mutation remains supported, pin or stage export assets, or validate them against the prepared manifest at download. Account for this lifetime when designing asset garbage collection.

### Legacy browser import compares and deletes in separate operations

**P3, narrow data-loss race.** [removeIfUnchanged](../../../src/ts/storage/browserLocalImport.ts#L93) reads and compares an old LocalForage value, then deletes it separately. Another tab can replace the value after the read but before deletion; the newer value is then removed even though only the older value reached the server. Blob comparisons add an asynchronous interval. Existing tests cover a change before the comparison, not this final gap.

Use transactional compare-and-delete/versioning where possible, coordinate all writers, or retain imported entries as recoverable tombstones for a grace period.

### Message search remains a repeated scan

**P2 optimization opportunity, already bounded.** [Text search](../../../server/src/data/chatStore.ts#L717) uses `json_extract(..., '$.data') LIKE` against message rows without a text index. [Route limits](../../../server/src/routes/messageSearch.ts#L31) bound a page to 64 MiB of scan work, slices to 4 MiB or 500 units, and concurrent scans to two. [The UI](../../../src/lib/Others/MessageSearch.svelte#L71) debounces and aborts stale requests, but a new uncommon query after each pause can still scan substantial data; cancellation is observed between slices.

Evaluate an index suited to the actual substring and multilingual semantics, or a maintained search projection. An FTS conversion must first prove equivalent behavior for the supported queries; it is not a drop-in replacement for arbitrary substring search. Measure bytes scanned per useful result and latency before adding complexity.

### Lower-cost opportunities and documentation drift

- Row-specific `ReloadChatPointer` changes notify the whole writable store. [Mounted row effects](../../../src/lib/ChatScreens/Chats.svelte#L490) and the [structural effect](../../../src/lib/ChatScreens/Chats.svelte#L792) do work across the visible row window even when one row remounts. Per-key invalidation could reduce this. Ordinary stream chunks do not use that broad reload path.
- Enabled [dynamic model discovery](../../../src/ts/model/modellist.ts#L49) can make up to three sequential provider-list requests per tab boot. A short server-side cache keyed by provider/credential version could help repeated reloads without caching writes or arbitrary auxiliary operations.
- The server guide's [auth durability warning](../../structure/self-host-server.md#L463) says password/key files are written directly. Current [auth writes](../../../server/src/routes/auth.ts#L199) use [durable staging](../../../server/src/data/durableWrite.ts#L84). That clause is stale; the adjacent caveat about unsupported directory fsync remains applicable.

## Changes with the largest practical benefit

1. **Make durability state explicit.** Address F01 first, then persist recovery drafts (F02/F03). A successful save barrier must account for existing refusals, not just new discard events. Give users a reliable way to preserve unsaved work.
2. **Separate independent work.** Remove unrelated background reads from the save critical path (F04), and model generation locks independently of chat revision changes (F05).
3. **Bound server work by bytes and time.** Deduplicate/read in pages, project list metadata, and isolate bulk restore work (F06/F07). Keep transaction/epoch guarantees and apply admission limits before large allocations, including request-body buffering (F17).
4. **Reduce repeated requests at their owners.** Batch token field consumers without sacrificing cancellation, reuse per-message counts, and distinguish cheap estimates from exact remote counts (F09/F10). Avoid a generic cache around mutating or credential-sensitive requests.
5. **Budget browser rendering and asset lifetimes.** Preserve the current locked-stream network shortcut while limiting full-prefix rendering and releasing fallback assets (F11–F13). Deduplicate lifecycle reconciliation (F14).
6. **Manage storage as a shared retention graph.** Treat snapshots, checkpoints, prepared exports, and live references together before enabling asset collection (F08).

Useful measurements for follow-up: oldest unsaved mutation age; persistent refusal count; save time spent waiting on reads; bytes serialized per API request; event-loop delay during restore; token-count requests/provider calls per editing action; render time per streaming update; fallback Blob bytes; and disk bytes by retention category. These would make future stabilization work assessable without relying only on perceived responsiveness.

## Environment combinations to verify

| Environment / trigger                                          | Relevant interaction                         | Expected verification                                                 |
| -------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| Two tabs/devices edit one settings or character record         | Coarse revision conflicts                    | Both drafts remain recoverable; unrelated fields merge only when safe |
| Mobile/PWA page loss with offline or refused edits             | RAM-only queue and restricted unload path    | Recovery survives reopening; old-epoch work is not silently replayed  |
| Slow network plus a live-feed refresh                          | Read-before-write cycle                      | Independent outgoing save still dispatches                            |
| Long streaming answer on a slower device, Off/Balanced mode    | Growing-prefix CBS/Markdown/image work       | Bounded rendering cadence and responsive typing/scrolling             |
| Strong streaming mode                                          | Raw stream path                              | Reduced browser work; final rich render still correct                 |
| Worker disabled, not controlling, or failed                    | Original-asset fallback and pinned Blob URLs | Bounded retained bytes, thumbnails where possible, correct auth       |
| Granted push permission and repeated foregrounds/multiple tabs | Effect plus visibility reconciliation        | One necessary registration, no repeated unchanged durable writes      |
| Slow translation followed by chat switch                       | Async suggestion effect                      | No old-chat label or action mismatch                                  |
| Large histories/imports/checkpoints                            | Full read/validation/installation            | Admission/progress remain responsive and memory stays bounded         |

## Protections verified and issues not claimed

- Resource writes and whole-store replacement use transactions; epoch fencing prevents pre-restore writers from silently applying to the replacement store.
- File publication uses staged durable writes. Auth password/key writes are already covered by that helper.
- Normal synchronization is WebSocket-driven. Revision reconciliation happens on hello/reconnect; there is no generic tight polling loop for all resources. Memory-task status shares the event feed.
- The maintenance restore watcher is a special bounded episode, not normal idle traffic. Stable Horde's two-second status loop is provider-specific.
- Boot uses chat summaries and a revision/item cache; it does not normally download every message. Unchanged boot records are compared before saving, avoiding an unconditional database rewrite.
- Feed patches, same-key asset load sharing, immutable asset caching, thumbnails, and token result caches already reduce traffic. Recommendations above target their remaining fallbacks or granularity.
- Stream mutations update the active row and are frame-coalesced. Strong mode and the locked-transform early return are real safeguards. The audit does not claim a server transform storm on each token, nor a blanket Svelte effect loop.

## Verification performed

- `pnpm check` — passed; Svelte reported 0 errors and 0 warnings, and server TypeScript completed successfully.
- `pnpm --silent test:agent` — passed: **7,116 passed, 59 skipped, 483 files**. The wrapper reported 78.6 seconds and cached the passing result for subsequent runs.
- Focused persistence verification: `pnpm --silent test:agent src/ts/storage/tests/resourceSync.test.ts src/ts/storage/tests/resourceSyncChats.test.ts src/ts/storage/tests/browserLocalImport.test.ts` — **114 passed**.
- Focused disjoint-edit recovery verification: `pnpm --silent test:agent src/ts/storage/tests/resourceSyncLive.test.ts -t 'does not apply a copy read while this tab edited the record'` — **1 passed, 49 skipped**.
- A temporary synthetic store probe used Node **v24.21.0**, the real default kind registry, and the real resource store. It created a temporary local SQLite database, one character/chat and 5,000 uniquely identified messages, each containing 2,048 ASCII `x` characters. It timed `readSnapshot`, `replaceAll`, and `readRefs` followed by `JSON.stringify` for one/five repeated chat references. Heap deltas were sampled after explicit GC and through serialization. The temporary directory was removed in `finally`.
- A separate temporary `createServerContext` request probe compared unauthenticated streamed-body consumption on the general resource-read route and both boot path forms, as described in F17. It used `app.request` with a `Request`/`ReadableStream`, not an external network listener; the context was disposed and its temporary directory removed.

The timings are single observations on this shared workspace; other checks were running during parts of the audit. Repeated text compresses very well, so the reported JSON sizes are deliberately **pre-compression**, and do not estimate actual compressed wire traffic. The heap figures exclude any subsequent compression buffers. No saturation/OOM, power-loss, external-provider, mobile-device, or complete cross-tab browser experiment was performed. Slow and end-to-end suites were not run. Passing existing tests does not contradict findings that those tests deliberately encode or do not cover.

### Reproducing the bounded store probe

Run from the repository root with the repository dependencies installed. It uses only a new temporary directory, not an existing save directory:

```bash
node --expose-gc --input-type=module <<'EOF'
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from './server/src/data/kinds.ts';
import { createResourceStore } from './server/src/data/resourceStore.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'risu-deep-audit-'));
const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const store = createResourceStore({ file: path.join(dir, 'live.sqlite'), kinds });
const elapsed = start => +(performance.now() - start).toFixed(1);
try {
  store.applyChanges({
    ops: [{ kind: kinds.get('characters'), id: 'audit-c', baseRevision: null, data: { chaId: 'audit-c' } }],
    chats: [{
      characterId: 'audit-c', chatId: 'audit-chat', baseRevision: null,
      ops: [{ op: 'create', chat: {
        name: 'Synthetic',
        message: Array.from({ length: 5000 }, (_, i) => ({
          chatId: `m${i}`, role: 'user', data: 'x'.repeat(2048)
        }))
      } }]
    }]
  });
  await store.backupTo(path.join(dir, 'snapshot.sqlite'));
  global.gc();
  let start = performance.now();
  let snapshot = store.readSnapshot(path.join(dir, 'snapshot.sqlite'));
  console.log({ operation: 'validate', milliseconds: elapsed(start) });
  start = performance.now();
  store.replaceAll(snapshot);
  console.log({ operation: 'install', milliseconds: elapsed(start) });
  snapshot = null;
  for (const repeats of [1, 5]) {
    global.gc();
    const before = process.memoryUsage().heapUsed;
    start = performance.now();
    let answer = store.readRefs([], {
      chats: Array.from({ length: repeats }, () => ({ characterId: 'audit-c', id: 'audit-chat' }))
    });
    const readMs = elapsed(start);
    start = performance.now();
    let json = JSON.stringify(answer);
    console.log({ repeats, readMs, stringifyMs: elapsed(start), bytes: Buffer.byteLength(json),
      heapGrowthMiB: +((process.memoryUsage().heapUsed - before) / 1048576).toFixed(1) });
    answer = null;
    json = null;
  }
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
EOF
```
