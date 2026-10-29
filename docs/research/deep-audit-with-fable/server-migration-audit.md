# Server migration deep audit (Fable + Astra)

Date: 2026-10-26 (Asia/Seoul). Source revision: `ff7cb9d2051920141f81bd99636bc09ca1717f86` (branch `dev`).

How it was made: a Claude Fable 5.1 session acted as the orchestrator. It read the structure guides and the
[earlier stabilization audit](../deep-audit/server-client-stabilization.md), chose four areas that audit had not
covered, and ran one read-only GPT-6 Astra analysis per area in parallel on this checkout (server data path,
client/server traffic, generation and transform pipeline, client reactive layer). The orchestrator then re-read
every P1 and every main P2 mechanism in the current code and re-ran the three reproducible probes (see
[Verification](#verification-and-limits)). Nothing in the application changed; this document and the probe
files under [`probes/`](probes/) are the only additions.

The finding IDs keep their Astra prefixes so the probe outputs can be traced: `SD` server data path, `ST` sync and
traffic, `TJ` transform and jobs, `CE` client effects.

## Assessment

The migration's core protections hold: whole-store transactions, revision and epoch checks, by-id message
operations, record field patches, generation ownership, the lazy chat cache, and the result caches all do what the
guides say. The new defects sit one layer beyond them, where a coarse unit is used after a fine-grained one:

- One persisted-data loss path is **confirmed and reproduced**: a trigger's final reconciliation writes its copy of
  `scriptstate` whole over the current chat, erasing a variable another writer saved meanwhile (TJ01). The
  existing test records the behavior as inherited from the browser.
- Two client effects can overwrite newer intent without a conflict: the WaveSpeed LoRA effect republishes a
  mount-time draft after a remote settings replacement (CE01), and composer translation writes into the composer
  with no ownership check (CE02). The translation composer also sends on an IME commit Enter (CE03).
- The server does chat-sized work for message-sized events: a streaming checkpoint rereads the transcript twice and
  rebuilds the owner's per-message baseline (SD01); a script callback barrier sends the **whole chat** on every
  callback, so an `editprocess` hook over 500 messages moved 499 MiB over the job socket (TJ04); a transform cache
  miss loads 23 resource kinds plus the whole chat per batch (TJ03).
- The transform cache can answer a stale mixed-revision result after the save that should correct it, and it
  shares viewport-dependent output across clients (TJ02).
- Traffic that was free locally is now per-event and coarse: an unchanged mobile resume downloads a 539 KB
  uncompressed revision listing (ST03); an unloaded observer chat fetches its character's whole summary collection
  on every checkpoint, and a patch over 64 KiB turns into a whole-chat read (ST04); dictionaries without item ids
  (plugin storage, ordinary plugins, module lorebooks) still travel as megabyte fields (ST01); a completed row still
  pays a transform round trip on every remount, server cache hit or not (ST05).
- Boot still ships every character whole on a cache miss, and the once-per-send `lastInteraction` stamp invalidates
  that character's cached record (ST02).

Evidence labels: **Confirmed** follows from the current implementation (often with an existing test asserting the
transition); **Measured** means a bounded probe exercised the real functions; **Conditional** names the environment
or timing needed without reproducing the full scenario. P1 is loss of persisted or user-visible intent, or a
defect that breaks input; P2 is a significant conditional correctness, latency, memory, or traffic cost on a common
path; P3 is smaller.

## Prioritized findings

| ID   | Priority | Area    | Finding                                                                                   | Example point                 |
| ---- | -------- | ------- | ----------------------------------------------------------------------------------------- | ----------------------------- |
| TJ01 | P1       | jobs    | Fixed 2026-10-26: trigger reconciliation set `scriptstate` whole over per-key merges      | Server/client data loss       |
| CE01 | P1 fixed | client  | WaveSpeed LoRA effect republishes a mount-time draft after a remote record replacement    | Client/server data loss       |
| CE02 | P1 fixed | client  | Composer translation writes results without request, draft, chat, or destroy guards       | Client/server data loss       |
| CE03 | P1 fixed | client  | Translation composer Enter ignores `isComposing`                                          | Effects vs. environment (IME) |
| SD01 | P2       | server  | A streaming checkpoint rereads the transcript twice and rebuilds the owner baseline       | Server performance            |
| TJ04 | P2       | jobs    | Every script callback barrier hydrates the whole chat                                     | Excessive traffic             |
| TJ02 | P2       | jobs    | Transform inputs have no revision fence; the cache omits history and viewport             | Server/client correctness     |
| TJ03 | P2       | jobs    | A transform miss loads 23 kinds plus the whole chat; coarse keys invalidate every row     | Server performance            |
| ST01 | P2       | traffic | Patches stop at large nested fields; ordinary plugins and plugin storage have no ids      | Excessive traffic             |
| ST03 | P2       | traffic | Fixed 2026-10-26 (compression line): reconnects downloaded the listing uncompressed       | Excessive traffic             |
| ST04 | P2       | traffic | Feed fallbacks expand a small change into a summary collection or a whole chat            | Excessive traffic             |
| ST05 | P2       | traffic | A remounted completed row still needs a transform round trip, cache hit or not            | Structural latency            |
| ST02 | P2       | traffic | Boot hydrates characters whole on a miss; `lastInteraction` invalidates the cached record | Structural traffic            |
| SD03 | P2       | server  | Feed patches are capped per record, not per frame or per socket send                      | Server performance            |
| SD02 | P2       | server  | Fixed 2026-10-26: vector cache eviction deleted thousands of rows in separate autocommits | Server performance            |
| SD04 | P2       | server  | User checkpoints rescan and rehash the unchanged chat; pruning sweeps the global table    | Server performance            |
| TJ05 | P2       | jobs    | Transform snapshot accounting excludes the retained scope                                 | Server memory                 |
| TJ06 | P2       | jobs    | A lost plugin-provider callback holds the chat and the client's lane for up to 30 min     | Server/client (mobile)        |
| CE04 | P2       | client  | Every stream update searches the whole loaded history before frame coalescing             | Effects, slow devices         |
| CE05 | P2       | client  | Lore and memory drafts serialize and copy the whole field on every edit                   | Effects, large fields         |
| CE06 | P2 fixed | client  | Chat "visibility" ignores the settings layer and page visibility                          | Effects vs. environment (PWA) |
| CE07 | P2       | client  | Prompt token counters track whole template metadata but miss CBS expansion inputs         | Effects, avoidable requests   |
| ST06 | P2       | traffic | Content-addressed uploads do not ask whether the server already has the bytes             | Structural traffic            |
| ST07 | P2 cond. | traffic | A plugin's default `getDatabase()` loads the chat library one character at a time         | Excessive traffic (plugins)   |
| SD06 | P2 cond. | server  | Diagnostic and auxiliary disk writes run synchronously on the serving thread              | Server performance            |
| SD05 | P3       | server  | Startup renormalizes every resource record; full writes serialize whole values twice      | Server performance            |
| CE08 | P3 fixed | client  | Portrait, background, error-trace, and bookmark-jump effects publish without owner checks | Effects, stale results        |

## Data loss and correctness

### TJ01 — A trigger's final reconciliation erases another writer's variable

**Confirmed and measured. P1.**

`runOnCopy` snapshots the chat before a trigger runs and hands the trigger a copy
([runSetup.ts:349](../../../server/src/jobs/runSetup.ts#L349)). A `setvar` effect updates the copy **and** persists
that one key through `services.setChatVar` ([triggers.ts:573](../../../server/src/prompt/triggers.ts#L573)), which the
metadata flush writes as a per-key merge ([jobScope.ts:461](../../../server/src/jobs/jobScope.ts#L461)). When the
trigger ends, `applyTriggerChat` compares the copy's top-level fields with the baseline and, for a differing
`scriptstate`, sets the **entire map** from the copy on the fresh revision
([chatResult.ts:172](../../../server/src/jobs/chatResult.ts#L172)). The existing test records the loss: "re-sets the
copy's `scriptstate` over a variable written meanwhile (inherited from the tab, recorded)"
([chatResult.test.ts:375](../../../server/src/tests/chatResult.test.ts#L375)).

Interleaving: the trigger captures `$a=0`; it sets `$a=1` (persisted per key); while it awaits Lua or a callback,
a tab saves `$b`; the trigger completes, refreshes the chat, sees its copy's `scriptstate` differs from the baseline,
and writes the copy's map over the fresh revision. `$b` is gone with no 409. The probe
([transform-jobs-probe.mjs](probes/transform-jobs-probe.mjs), label `trigger-disjoint-variable-loss`) shows
`{"$a":"1","$v":"1","$b":"saved-by-another-tab"}` before and `{"$a":"1","$v":"1"}` after; a concurrent edit to an
older message survived, so message reconciliation is fine and only metadata is affected.

Existing protection: changed-message reconciliation merges only changed fields, reordering is guarded, and the
incremental setters merge per key. The final reconciliation undoes that. It applies to start/output/manual trigger
copies, not to ordinary reply writes.

Recommendation: reconcile `scriptstate` (and any other dictionary field) by key against the baseline, with explicit
deletion semantics and a same-key policy, and skip keys the incremental flush already persisted. Validation: extend
the recorded test to require `$b` preserved, with a `runOnCopy` paused between a setter and completion.

**Fixed 2026-10-26.** `applyTriggerChat` now reconciles the map fields (`CHAT_META_MERGE_KEYS`: `scriptstate`,
`GLGlobalVariables`, `toolCalls`) entry by entry with `meta.merge`/`mergeUnset`: entries the copy changed or added are
written (the trigger's final value wins), entries it removed are removed (a dropped map removes the baseline's entries),
and entries it left unchanged or that are already stored with its value are not named. Probe re-run after the fix
(`trigger-disjoint-variable-loss`): the stored map after the trigger completes is now
`{"$a":"1","$v":"1","$b":"saved-by-another-tab"}` (was `{"$a":"1","$v":"1"}`; `probes/transform-jobs-probe.output.txt`
keeps the run at `ff7cb9d20`). Regression tests: `chatResult.test.ts` (map entries against the baseline, a variable
written meanwhile) and `chatMetadataCoalescing.test.ts` (a variable saved during the trigger run).

### TJ02 — A mixed-revision transform result survives the save that should correct it

**Confirmed and measured. P2.**

The client captures identities, not the held revision or a transcript snapshot
([transformClient.ts:126](../../../src/ts/parser/transformClient.ts#L126)), and sends the row's current text with
no save barrier. The server's cache key digests `scriptstate`, note, lore, bindings and a few chat fields, and the
target's own source text ([transform.ts:378](../../../server/src/prompt/transform.ts#L378),
[:406](../../../server/src/prompt/transform.ts#L406)); it includes neither the chat revision nor message contents
nor the viewport. Lua `getChatData` reads the **stored** message ([bindings.ts:1244](../../../server/src/lua/bindings.ts#L1244)).

Measured: with message 0 edited locally to `LOCAL_NEW` but not yet saved, a display hook that appends
`getChatData(id, index)` returned and cached `LOCAL_NEW|stored=0:xxx…`. After the save committed `LOCAL_NEW`, the
same request **hit the cache** and returned the stale mix; only a `noCache` bypass returned
`LOCAL_NEW|stored=LOCAL_NEW` (probe label `mixed-revision-cache`, `sameKey: true`). A regex emitting
`{{screenwidth}}` primed by an 800-wide client answered `800` to a 320-wide client (label
`viewport-cross-client`). [transform.test.ts:489](../../../server/src/tests/transform.test.ts#L489) deliberately
asserts reuse across viewport and history changes.

Recommendation: key results by what scripts may read (chat revision or a message-content digest when history
functions are used, viewport when viewport CBS is used), and never let a pre-save mixed snapshot become the
post-save result. Do not solve this by flushing all resources before every row render.

### CE01 — The WaveSpeed LoRA effect republishes an old draft after a remote replacement

**Confirmed mechanism. P1 (two-tab alternation derived, not executed).**

**Fixed 2026-10-26** (Deep Audit Fixes plan, commit `fix(ui): stop the LoRA editor republishing a stale draft and drop stale async results`): the publishing effect is gone. The LoRA rows are an
editing copy saved only by an explicit edit (path, scale, the reset for a model without LoRA support), never on mount.
A copy without unsaved edits follows the incoming value without saving; one whose save is not yet acknowledged (a later
save cycle ended with the `secrets` revision changed) keeps its rows when a different value arrives, saves nothing, and
shows `wavespeedLoraConflict` with a button that loads the saved LoRAs; the next edit saves the rows over that change.
Tests: `src/lib/Setting/Pages/ImageGenerationSettings.test.ts`. The two-tab alternation in a real browser is still
pending.

`ImageGenerationSettings.svelte` reads the saved LoRAs once at mount into a local `$state` draft
([:43](../../../src/lib/Setting/Pages/ImageGenerationSettings.svelte#L43)) and runs an effect that writes
`settings.secrets.wavespeedImage.loras` from that draft whenever its dependencies change
([:161](../../../src/lib/Setting/Pages/ImageGenerationSettings.svelte#L161)). The effect **reads**
`settings.secrets.wavespeedImage` (tracked), so a live-sync replacement of the `secrets` record
([records.svelte.ts:668](../../../src/ts/storage/records.svelte.ts#L668)) reruns it, and it reinstalls the stale draft
on the just-accepted revision. That is a valid later save, not a conflict. Two mounted editors with different lists
can alternate saves without any user action. The effect is outside the provider-specific markup, so it runs with any
image provider while the page is mounted.

Recommendation: publish only on explicit LoRA edits; sync a clean draft from incoming values; keep a base for a
dirty draft so a remote change becomes a visible conflict. Validation: two mounted editors, alternate acknowledged
remote records; a clean editor adopts without dirtying, a dirty one preserves its draft.

### CE02 — Composer translation can overwrite a newer draft

**Confirmed missing ownership. P1 (loss depends on completion order).**

**Fixed 2026-10-26** (Deep Audit Fixes plan): `src/ts/process/inputTranslation.svelte.ts` `createInputTranslation` owns
the runs (newest run wins; source text, destination text, and chat key captured before the await and checked after it
and after the experimental debounce; invalidated on a consumed send or command, a chat switch, toggle off, and
destroy). A result that arrives while the destination composes is dropped rather than deferred: deferring would
overwrite the text the IME just committed, and a later input starts a new run. Tests:
`src/ts/process/inputTranslation.test.ts`.

`updateInputTransateMessage` awaits `translate(...)` and then assigns `messageInput` or `messageInputTranslate`
with no check that the source text, chat, or component is still the same
([DefaultChatScreen.svelte:806](../../../src/lib/ChatScreens/DefaultChatScreen.svelte#L806),
[:811](../../../src/lib/ChatScreens/DefaultChatScreen.svelte#L811),
[:828](../../../src/lib/ChatScreens/DefaultChatScreen.svelte#L828)). Expensive translators check text equality before
starting, never after; cheap translators start one call per input event. Two responses finishing B then A leave A
displayed; a result can repopulate the composer after Send or after a chat switch (the composer is shared across
chats, as the chat-pipeline guide records).

Recommendation: capture source text, destination draft version, chat key and a run token; cancel superseded work;
validate before publication; invalidate on Send, chat switch, toggle off, and destroy; defer replacement while the
destination is composing.

### CE03 — Enter in the translation composer sends during IME composition

**Confirmed handler gap; IME outcome conditional. P1.**

**Fixed 2026-10-26** (Deep Audit Fixes plan): `src/ts/ime.ts` `isImeComposing` (`isComposing`, or `keyCode` 229 for
Safari's commit key) guards the whole keydown handler of both composers (Enter send and Ctrl+M reroll) and the partial
editor (Escape, Ctrl/Meta+Enter); tests in `src/ts/process/inputTranslation.test.ts` and
`src/lib/ChatScreens/tests/PartialEditControllerIme.test.ts`. Device checks on Android Korean and desktop Japanese
are still pending.

The main composer guards `!e.isComposing`
([DefaultChatScreen.svelte:1054](../../../src/lib/ChatScreens/DefaultChatScreen.svelte#L1054)); the translation
composer does not ([:1401](../../../src/lib/ChatScreens/DefaultChatScreen.svelte#L1401)). With input translation and
`sendWithEnter` on, a Korean or Japanese candidate commit that arrives as a composing Enter takes the Send branch and
starts a generation. `PartialEditController.svelte:487` has the same gap for its modifier shortcuts, which makes it
narrower. The `TextAreaInput` highlighted branch has an unguarded Enter rewrite too, but `disableHighlight` is
`writable(true)` with no production setter, so it is dormant.

Recommendation: one composition-aware guard for every send/save/cancel shortcut. Validation: compositionstart →
composing Enter → compositionend on both composers and the partial editor; assert no Send; then a plain Enter
still sends. Device-check Android Korean and desktop Japanese separately.

### CE06 — A chat counts as "viewed" behind settings or in a hidden PWA

**Confirmed state-model omission. P2.**

**Fixed 2026-10-26** (Deep Audit Fixes plan): `visibleChatKey()` also requires a loaded chat, closed settings and grid
(`src/ts/screenVisibility.ts`), and a visible page (`src/ts/pageVisibility.svelte.ts`), so such a reply keeps its unseen
and recovery marks until the transcript is shown (`chatStatus.test.ts`).

`visibleChatKey()` is `(chatOpen || playground) && screen === …`
([chatStatus.svelte.ts:76](../../../src/ts/process/chatStatus.svelte.ts#L76)); neither `settingsOpen`,
`gridOpenStore`, nor `document.visibilityState` participates. `noteJobDone` suppresses the unseen mark for that key
([:58](../../../src/ts/process/chatStatus.svelte.ts#L58)) and the watcher deletes unseen/recovery marks for it
([:82](../../../src/ts/process/chatStatus.svelte.ts#L82)). Settings replaces the chat screen without closing the chat
([App.svelte:243](../../../src/App.svelte#L243), [router.svelte.ts:303](../../../src/ts/router/router.svelte.ts#L303)).
So a reply that completes while settings are open, or while the installed PWA is backgrounded with the socket still
delivering, is never marked unseen, and a recovery badge is removed at once. This matters for the mobile resume
work, whose user-visible symptom is exactly "I did not notice the reply."

Recommendation: derive viewed status from actual screen visibility and a reactive page-visibility signal; keep
"selected", "rendered", and "viewed" apart. Validation: complete or lose a job with settings open, grid open, and
document hidden; marks must remain until the transcript is shown.

## Server data path and per-event work

### SD01 — A streaming checkpoint does chat-sized work for a one-row write

**Measured and confirmed. P2.**

Every `CHECKPOINT_INTERVAL_MS` (3 s) the runner writes the reply with `setText` through `writeOwn`, which calls
`refreshChat` before the write, `refreshChatAfterWrite` after it, and `emitRecords`
([runner.ts:397](../../../server/src/prompt/runner.ts#L397)). The cheap adoption path applies only to meta-only ops
([jobScope.ts:588](../../../server/src/jobs/jobScope.ts#L588)); a text write rereads the whole chat. `emitRecords` then
reads the chat **again** and builds `chatBaseline`, which serializes every message, to diff a small patch
([generationJobs.ts:611](../../../server/src/jobs/generationJobs.ts#L611)).

Medians over seven iterations on a 5,000-message chat (2 KiB each, a 32 KiB reply): `applyChanges` 7.0 ms, scope
refresh 28.8 ms, owner read 19.8 ms, baseline plus diff 17.6 ms; about 80 ms per checkpoint, 149 ms for the first
([server-data-probe.results.json](probes/server-data-probe.results.json), `checkpointPhases7Runs`). Four such jobs
would spend roughly 107 ms of every second in these phases on the serving thread. The feed patch carries the whole
changed message (33,204 bytes here), not a delta, to every connected feed socket.

Recommendation: adopt acknowledged ops into the runner scope when revisions permit, advance the owner baseline from
the committed touched rows, and reuse the store's own change information instead of rediscovering the diff. Keep the
full refresh for stale or intervening writes.

**Baseline at `634bc14c7`** ([checkpoint-probe.mjs](probes/checkpoint-probe.mjs),
[checkpoint-probe.output.txt](probes/checkpoint-probe.output.txt); Node v24.21.0, `--expose-gc`): 5,000 messages of
about 2 KiB, a `char` reply begun as the runner begins one, then seven 32 KiB `setText` checkpoints with their
generation and `covers`, each through `writeOwn`'s five calls with an owner socket open. Medians: write 2.0 ms, scope
14.0 ms (before the write 0.05 ms, `refreshChatAfterWrite` 14.0 ms), `emitRecords` 31.5 ms (owner read 13.6 ms,
baseline plus diff plus send 18.1 ms); per-run total 47.6 ms, the first 49.2 ms. Two whole-transcript reads per
checkpoint at the SQL boundary (`refreshChatAfterWrite` one, `emitRecords` one, none before the write or in
`applyChanges`). Owner `chatPatch` 33,265 bytes, feed patch 32,989 bytes, feed `change` event 33,370 bytes. The
inline figures above were measured at the audit's commit with a fixture that was not recorded (a plain `setText`
without the reply's generation gives the same reads and timings and a 33,151-byte owner patch), so they are not
comparable phase by phase; compare later runs with this line.

### TJ03 — A transform miss loads the whole scope; coarse keys invalidate every row

**Measured and confirmed. P2.**

A batch whose cache probe misses one target calls `loadJobScope`, which reads all 23 non-character kinds, the whole
chat, the owner, and nine request-settings records again ([jobScope.ts:205](../../../server/src/jobs/jobScope.ts#L205),
[:275](../../../server/src/jobs/jobScope.ts#L275)); every message row is parsed
([chatStore.ts:1799](../../../server/src/data/chatStore.ts#L1799)). Measured for 500 messages of 2 KiB
([transform-jobs-probe.output.txt](probes/transform-jobs-probe.output.txt)):

| Operation                                        | SELECTs | JSON.parse |  Elapsed |
| ------------------------------------------------ | ------: | ---------: | -------: |
| One `loadJobScope`                               |      35 |        605 |   4.2 ms |
| 500 cold plain transforms, eight batches         |     480 |      4,849 |   204 ms |
| Same 500, all cache hits                         |     200 |          8 |    14 ms |
| After one committed variable change              |     480 |      4,848 |   166 ms |
| After only the owner's `lastInteraction` changed |     480 |      4,848 |   138 ms |
| 500 cold with ten non-matching regex scripts     |     480 |      4,848 | 1,079 ms |

The key is broad and incomplete at once: every loaded non-character revision participates, so an unrelated preset or
settings change, or the once-per-send `lastInteraction` stamp, invalidates every row's entry, while TJ02's real
dependencies are missing. Regex scripts run as one worker task per target, but each ordinary replacement calls CBS
on the main thread after every script even without a match: the ten-script run made 500 worker tasks and 5,000
synchronous host parses ([regex.ts:229](../../../shared/scripts/regex.ts#L229),
[worker.ts:235](../../../server/src/scripts/worker.ts#L235)). `runLuaEdit` runs one worker task per eligible Lua
trigger per uncached target even when the code registers no `editDisplay` handler
([scripts.ts:82](../../../server/src/prompt/scripts.ts#L82)).

Recommendation: share an immutable revision-addressed configuration across a render burst, load only the kinds a
display needs, separate display-relevant character revisions from timestamps, filter scripts by mode before dispatch,
and avoid the no-match host parse. Narrow invalidation only together with TJ02's missing dependencies.

### TJ04 — Every script callback barrier sends the whole chat

**Confirmed and measured over the real job socket. P2.**

Prompt assembly runs `editprocess` over every eligible history message, one callback each
([assemble.ts:1402](../../../server/src/prompt/assemble.ts#L1402)). Every callback builds its barrier with
`transport.hydrate()` ([channel.ts:637](../../../server/src/jobs/channel.ts#L637)), and `hydrateAll` delivers the chat
**whole** ([generationJobs.ts:737](../../../server/src/jobs/generationJobs.ts#L737)), reading and re-serializing it each
time. A localhost probe ([job-channel-probe.mjs](probes/job-channel-probe.mjs)) with a no-op hook over a 500-message
chat observed 500 whole-chat frames, 523,601,000 bytes, 3.5 s with immediate answers and no provider. Traffic is
H callbacks × N messages; with H ≈ N it is quadratic, plus H sequential round trips before the provider request.

Recommendation: keep the barrier's revision receipt but send only changes since the last receipt, with whole-chat
resync as the fallback; consider a batched history-transform callback where plugin ordering allows it.

**Baseline at `634bc14c7`** ([job-channel-probe.mjs](probes/job-channel-probe.mjs), second line of
[job-channel-probe.output.txt](probes/job-channel-probe.output.txt); Node v24.21.0): the same fixture (500 messages
of about 2 KiB, a no-op `editprocess` hook, 500 callbacks answered at once). 500 whole-chat frames of 523,601,000
bytes, 1,003 frames of 523,877,082 bytes in all, 2 `chatPatch` frames of 466 bytes, 275,500 bytes of `callback`
frames received and 51,000 bytes of `answer` frames sent, 3,278 ms.

### SD03 — The feed caps each patch, not the frame or the next send

**Measured and confirmed. P2.**

`MAX_FEED_PATCH_BYTES` (64 KiB) applies per record or chat patch
([resourceStore.ts:2199](../../../server/src/data/resourceStore.ts#L2199),
[chatStore.ts:883](../../../server/src/data/chatStore.ts#L883)); one publication carries every patch of a commit, and
`send` checks `bufferedAmount` of what is already queued, not plus the new frame
([events.ts:47](../../../server/src/routes/events.ts#L47)). A legal batch of 100 chat updates produced a 6,024,591-byte
frame, serialized in 14.7 ms inside a 71 ms `applyChanges`
([server-data-feed-probe.results.json](probes/server-data-feed-probe.results.json)), sent to every tab regardless of
what it has open.

Recommendation: a per-publication patch budget (drop patches, keep revisions), a per-frame bound, and admission that
counts the next frame. Preserve publication order and the lock relationship if frames are split.

### SD02 — Vector eviction is a synchronous run of autocommits

**Measured and confirmed. P2.**

`trim` deletes victims one `remove.run` at a time with no transaction
([vectorCache.ts:175](../../../server/src/data/vectorCache.ts#L175)), right after each `set`. Seeded just under the
256 MiB bound, one insert deleted 2,186 rows in **251.8 ms** on the serving thread
([server-data-aux-probe.results.json](probes/server-data-aux-probe.results.json)). Recommendation: batch deletes in
one transaction with a bounded budget per call.

**Fixed 2026-10-26** (Deep Audit Fixes plan, commit `fix(server): compress the revision listing, bound vector eviction, and stop rewriting unchanged push registrations`): each `set` evicts at most 256 rows (the
`trimRowsPerSet` option) in the same transaction as its insert and continues toward 90% on later inserts; a vector
that still cannot fit after the budget is not stored, so no write ends above the bound; startup trims an over-bound
file to 90% in batches before serving. Re-measured with the same shape (21,845 float64 vectors of 1,536 dimensions,
just under 256 MiB; Node 24.21.0): before, one insert deleted 2,186 rows in **265 ms**; after, each insert deleted at
most 256 rows in **20–28 ms**, the cache reached 90% after nine inserts, and later inserts took **0.4 ms**.

### SD04 — User checkpoints rescan the unchanged chat; pruning sweeps the global page table

**Measured and confirmed. P2.**

`autoSave` reads the whole chat to count user turns on every call, before knowing whether a checkpoint is due
([checkpointService.ts:107](../../../server/src/data/checkpointService.ts#L107)); a save parses and hashes every page
and inserts every reference even when unchanged
([checkpointStore.ts:283](../../../server/src/data/checkpointStore.ts#L283)); `prune` always runs `sweepPages` over
the whole `checkpointPages` table ([checkpointStore.ts:178](../../../server/src/data/checkpointStore.ts#L178)). Saving
the 5,000-message chat took 87.2 ms; saving it again unchanged took 71.5 ms. Automatic capture runs synchronously
after a job ends ([generationJobs.ts:847](../../../server/src/jobs/generationJobs.ts#L847)). Recommendation: keep a
cheap user-turn count, reuse page hashes keyed to committed message changes, and sweep only pages whose references
were removed.

### TJ05 — Snapshot accounting ignores the retained scope

**Measured and confirmed. P2.** `retainedBytes` counts output text and changed variables
([transform.ts:115](../../../server/src/prompt/transform.ts#L115)) while each kept snapshot retains its `TargetRun`
with the whole chat array and loaded configuration ([transform.ts:664](../../../server/src/prompt/transform.ts#L664)).
Four tiny targets awaiting a plugin continuation against a 15.6 MiB chat retained **45.86 MiB** of heap for 16
pending bytes (probe label `four-tiny-snapshots`). Recommendation: charge the shared scope once per coherent
revision and budget it.

### TJ06 — A lost plugin-provider callback holds the chat for up to 30 minutes

**Confirmed policy; mobile scenario conditional. P2.** Provider callbacks use `PROVIDER_CALLBACK_TIMEOUT_MS` of
30 minutes ([requests.ts:1660](../../../server/src/llm/requests.ts#L1660)); a socket close removes the socket without
settling the callback ([generationJobs.ts:1456](../../../server/src/jobs/generationJobs.ts#L1456)); the chat stays
`chatBusy` and the client's other root callbacks queue with `deadline: Infinity`
([channel.ts:531](../../../server/src/jobs/channel.ts#L531)). A frozen or discarded mobile tab mid-provider therefore
blocks that chat, and callbacks of that client's other jobs, until the job deadline. Recommendation: separate owner
liveness and provider-progress deadlines from total runtime, bound queue waits, and define an authenticated
abandoned-owner abort.

### SD06 — Auxiliary disk writes share the serving thread

**Confirmed mechanism; latency conditional on storage. P2.** `writeFileDurableSync` does write, fsync, rename and
directory fsync synchronously ([durableWrite.ts:99](../../../server/src/data/durableWrite.ts#L99)); the diagnostics
journal appends every event synchronously (no fsync) and publishes state durably at startup, every ten minutes, and
after errors ([journal.ts:354](../../../server/src/diagnostics/journal.ts#L354),
[:511](../../../server/src/diagnostics/journal.ts#L511)); push subscription changes publish durably. Request history
does not write per chunk. On slow storage (Docker volumes, SD cards, network shares) a 100 ms sync costs about 200 ms
of event-loop time per state write. Recommendation: a bounded ordered writer for journal, state, and history, with
explicit durable acknowledgment kept for auth and subscription changes.

### SD05 — Startup renormalizes every record

**Measured. P3.** `normalizeStoredRecords` parses, normalizes and serializes every resource of every kind before
listening ([resourceStore.ts:522](../../../server/src/data/resourceStore.ts#L522)); reopening 300 characters of
256 KiB with 3,000 chats took 760 ms and wrote nothing. Recommendation: version the normalization so unchanged
compatible records skip the pass.

## Traffic between client and server

### ST01 — Large nested values remain the unit of transfer

**Confirmed; sizes measured on a synthetic library. P2.**

Record patches compare top-level fields of objects and top-level fields of id-addressed items
([resourceSync.svelte.ts:1203](../../../src/ts/storage/resourceSync.svelte.ts#L1203),
[:1225](../../../src/ts/storage/resourceSync.svelte.ts#L1225)). Lists whose items lack unique ids send the whole
record; `plugins` has no `id` ([shared/plugins.ts:3](../../../shared/plugins.ts#L3)), and all v3 plugin keys share one
top-level dictionary ([pluginStorageStore.svelte.ts:17](../../../src/ts/storage/pluginStorageStore.svelte.ts#L17)). The
existing test records this: "keeps whole writes for lists without unique nonempty ids"
([resourceSyncPatches.test.ts:1231](../../../src/ts/storage/tests/resourceSyncPatches.test.ts#L1231)).

On the fixture ([sync-traffic-measure.mjs](probes/sync-traffic-measure.mjs): 300 characters, 3,000 chats, 50 presets,
20 modules, 10 plugins, a 2 MiB plugin history): editing one module lore entry sends its whole 316,691-byte
`lorebook`; toggling one plugin's `enabled` sends about 1.02 MB of all plugins; a counter next to the plugin history
sends about 2.05 MB. The save deadline is 500 ms and later marks do not postpone it, so a plugin that writes after
every message uploads the dictionary about twice per second while active. Renaming a preset or module sends only
ids and the name; editing a 16 KiB prompt sends that string.

Recommendation: entry-level operations for the two plugin dictionaries and for stable-id lore and translator items;
consider separating plugin code from plugin configuration. Respect D1–D4: no merge semantics for replacement ops,
no splitting of coupled arrays.

### ST03 — Every reconnect downloads the complete revision listing, uncompressed

**Confirmed and measured. P2.**

Every `hello` runs `reconcile`, which reads `GET /api/resources/revisions`
([eventFeed.ts:121](../../../src/ts/network/eventFeed.ts#L121)); the route answers with `c.json`, not
`compressedJson` ([resources.ts:269](../../../server/src/routes/resources.ts#L269)). Resumes after 30 s hidden,
`resume`, and `online` each replace the connection. For 300 characters and 3,000 chats the listing is **539,239
bytes** (gzip level 1 would be 106 KB); twenty unchanged resumes a day are about 10.8 MB per tab with no data change.
Unchanged revisions trigger no reads, so an unchanged resume does not reread chats.

Recommendation: compress the listing now; then an epoch-scoped change cursor with bounded replay and tombstones, and
an explicit full-reconcile fallback; a listing digest can answer "nothing changed" cheaply.

**Compression fixed 2026-10-26** (Deep Audit Fixes plan, commit `fix(server): compress the revision listing, bound vector eviction, and stop rewriting unchanged push registrations`): the route answers through
`compressedJson`. Measured through the real route with the probe's shape (300 characters, 3,000 chats, 322 records;
Node 24.21.0): **538,972 bytes** before for every `Accept-Encoding`; after, **81,504 bytes** with zstd (Chromium's
`gzip, deflate, br, zstd`), **106,189 bytes** with gzip (`gzip, deflate, br`), and 538,972 bytes for identity. The
change cursor and a listing digest stay open (Boot bytes plan).

### ST04 — Feed fallbacks expand a small change into a collection or a whole chat

**Confirmed; amplification from measured payloads. P2.**

An unloaded chat cannot consume a message patch ([chatStore.svelte.ts:1802](../../../src/ts/storage/chatStore.svelte.ts#L1802))
and its notice becomes a `collection` read of the character's whole summary collection and order
([:4943](../../../src/ts/storage/chatStore.svelte.ts#L4943),
[resourceSync.svelte.ts:3591](../../../src/ts/storage/resourceSync.svelte.ts#L3591)): a text-only checkpoint of a chat
the observer never opened costs one HTTP read of every sibling summary every 3 s (4,180 bytes for ten chats; about
1.2 MB for a character with 3,000 chats). A loaded chat whose patch exceeds 64 KiB gets a revision-only event and
reads the **whole chat**; a metadata change carries the entire `row.meta`
([chatStore.ts:884](../../../server/src/data/chatStore.ts#L884)), so a one-field toggle beside 100 KiB of memory data
triggers a 4.24 MB transcript read. ST01's 316 KiB lore edit makes every idle observer download the 7.31 MB modules
singleton.

Recommendation: summary deltas by changed chat id; field-level metadata and message-row delta reads before the
whole-chat fallback; keep the byte cap instead of enlarging frames.

### ST05 — A completed row still pays a transform round trip on every remount

**Confirmed mechanism. P2.**

`ParseMarkdown` calls `serverProcessScript` for every unlocked row with a context
([parser.svelte.ts:963](../../../src/ts/parser/parser.svelte.ts#L963)), uploading the source text; batches are cleared
after each flush ([transformClient.ts:214](../../../src/ts/parser/transformClient.ts#L214)) and a server cache hit
still returns the full text ([transform.ts:452](../../../server/src/prompt/transform.ts#L452)). Two fully loaded chats
therefore repeat upload and download of their visible rows on every switch (about 61 KB each way for thirty 2 KiB
rows), and the row waits a round trip before it can render.

Recommendation: a dependency-stamped render result cached in the tab across remounts, or display results delivered
with the chat read; the server must certify when the transform is a no-op (regex lists alone cannot decide, since
CBS, modules, triggers, handlers and variables matter). Preserve explicit Re-render and once-only emotion effects.

### ST02 — Boot hydrates characters whole on a miss; a timestamp invalidates the cached record

**Confirmed and measured. P2.**

`BOOT_CACHED_KINDS` are only characters, modules and presets
([shared/resources.ts:206](../../../shared/resources.ts#L206)); a missed character comes back whole with lore,
descriptions, asset and emotion lists ([resourceBoot.ts:194](../../../server/src/routes/resourceBoot.ts#L194)), and
the sidebar projects name and image only after the whole record reached the browser
([Sidebar.svelte:148](../../../src/lib/SideBars/Sidebar.svelte#L148)). Fixture sizes: cold boot 51.5 MB JSON (2.0 MB
gzip), warm boot 4.3 MB (3,000 summaries, orders, plugins, plugin storage, settings always included). The server
stamps `lastInteraction` once per send ([runner.ts:322](../../../server/src/prompt/runner.ts#L322)); that alone made
the next warm boot 128,297 bytes larger for one character. Boot also awaits a separate
`GET /api/resources/pluginPermissions/main` although the boot answer already carried that kind
([bootstrap.ts:135](../../../src/ts/bootstrap.ts#L135), [permissionStore.ts:42](../../../src/ts/plugins/apiV3/permissionStore.ts#L42)).

Recommendation: a sidebar projection plus the selected chat's resources first, full characters on demand with an
explicit partial type (D1); separate the interaction stamp from bulky content; seed permissions from boot.

### ST06 — Content-addressed uploads do not check server presence

**Confirmed. P2.** `saveAsset` hashes and then always uploads
([globalApi.svelte.ts:384](../../../src/ts/globalApi.svelte.ts#L384)); batch writes document "the server always
overwrites" ([assetClient.ts:264](../../../src/ts/storage/assetClient.ts#L264)). Reimporting 100 present 1 MiB assets
resends 100 MiB and rewrites them with fsync. Recommendation: one batched "which hashes are missing" check before
upload, with verification that distinguishes a correct existing file from a corrupt one.

### ST07 — A plugin's default `getDatabase()` loads the library one character at a time

**Conditional on plugin behavior. P2.** The default includes every character
([v3.svelte.ts:1534](../../../src/ts/plugins/apiV3/v3.svelte.ts#L1534)) and loads missing chats per character in
sequence ([:883](../../../src/ts/plugins/apiV3/v3.svelte.ts#L883)): 300 sequential `POST /api/resources/read` calls for
300 characters, repeated after idle eviction keeps only eight evictable chats. Recommendation: scoped plugin APIs
and a batched, byte-budgeted snapshot path.

## Client reactive layer

### CE04 — Every stream update searches the whole loaded history

**Confirmed complexity. P2.** `applyServerGeneration` finds the message with `message.find` before the coalescing
decision ([chatStore.svelte.ts:1164](../../../src/ts/storage/chatStore.svelte.ts#L1164),
[:1204](../../../src/ts/storage/chatStore.svelte.ts#L1204)) and `showStreamText` searches again per flush
([:1117](../../../src/ts/storage/chatStore.svelte.ts#L1117)). For N loaded messages and C chunks that is about N × C
id comparisons regardless of rendering mode or mounted rows. Recommendation: an id-to-message index or a validated
message reference re-resolved on structural changes (never an index).

### CE05 — One lore or memory edit copies the whole field twice

**Confirmed. P2.** `chatFieldDraft` serializes `$state.snapshot` of the whole field in both the incoming `.pre`
effect and the outgoing effect ([chatFieldDraft.svelte.ts:49](../../../src/ts/storage/chatFieldDraft.svelte.ts#L49),
[:59](../../../src/ts/storage/chatFieldDraft.svelte.ts#L59)), and `setChatMeta` compares and clones the whole value
([chatStore.svelte.ts:2741](../../../src/ts/storage/chatStore.svelte.ts#L2741)); the HypaV3 modal does the same for all
memory data ([HypaV3Modal.svelte:99](../../../src/lib/Others/HypaV3Modal.svelte#L99)). Each keystroke in one entry
is O(total field bytes) on the UI thread, and the saved `meta` op carries the whole field (ST04 then amplifies it
for observers). Recommendation: entry-scoped buffers with explicit commits.

### CE07 — Prompt counters depend on the wrong inputs

**Confirmed. P2.** The `.pre` effect snapshots every template property
([PromptSettings.svelte:65](../../../src/lib/Setting/Pages/PromptSettings.svelte#L65)), so renaming a card recounts
both totals, while CBS inputs read during the untracked count (persona name for `{{user}}`, variables) are not
dependencies, so an expanded total can stay stale indefinitely. The count callbacks ignore the field's abort signal
([:43](../../../src/lib/Setting/Pages/PromptSettings.svelte#L43)), so superseded `tokenizePreset` requests continue.
Recommendation: a token-relevant projection with explicit expansion dependencies; pass cancellation through to the
shared batching layer (with F09).

### CE08 — Presentation effects without owner checks

**Fixed 2026-10-26** (Deep Audit Fixes plan, commit `fix(ui): stop the LoRA editor republishing a stale draft and drop stale async results`): `TransitionImage` and the chat background drop a result
whose effect run was superseded or cleaned up; `AlertComp` drops a trace translation, its failure, and its end of
loading once the shown alert changed; the bookmark jump names its message by id when it starts and runs through
`runMessageJump` under one screen-owned jump shared with search jumps (a newer jump, a chat switch, or destroy stops it).

**Confirmed. P3.** `TransitionImage.svelte:44` awaits `src` and publishes without a token (old portrait or emotion
can replace the current); `ChatScreen.svelte:32` awaits the background asset; `AlertComp.svelte:185` can publish
error A's translated trace into error B; `DefaultChatScreen.svelte:200` scrolls to a bookmark index after awaits
that can outlive a chat switch. None writes persisted data. Recommendation: reuse the search-jump ownership protocol
(run token invalidated in cleanup).

### Persisted-write effects checked

The inventory of production effects that write records or chat metadata found no runaway loop. `CharConfig`'s four
TTS-default effects write once per character whose config is missing (one batch op, not four PUTs);
`TriggerV2List` creates one default trigger only for an empty bound list; `MemorySettings` ratio effects clamp and
settle; `SettingSelect`/`SettingSegmented` correct an invalid value once; `HypaV3Modal` initializes empty memory
metadata for an unfenced chat without memory (an existing test expects it). Record wrappers resolve writes inside
`untrack` ([records.svelte.ts:2706](../../../src/ts/storage/records.svelte.ts#L2706)), which is why CE01, with its
explicit tracked read, is the exception.

## Checked, not a problem

- **Primary SQLite durability.** The resource store sets WAL, `busy_timeout=5000` and foreign keys but not
  `synchronous`; the inspected Node 24.21.0 / SQLite 3.53.4 build defaults to FULL (compile options
  `DEFAULT_SYNCHRONOUS=2`, `DEFAULT_WAL_SYNCHRONOUS=2`). No acknowledged write returns before its sync. Setting the
  mode explicitly would remove the dependency on the build default. Request history and the vector cache choose
  NORMAL on purpose. **Set explicitly 2026-10-26** (commit `fix(server): compress the revision listing, bound vector eviction, and stop rewriting unchanged push registrations`): the resource store connection runs
  `PRAGMA synchronous = FULL`, pinned in `resourceStore.test.ts`.
- **Feed reconnect window.** `hello` is built and the socket registered synchronously before the client can request
  the listing ([events.ts:116](../../../server/src/routes/events.ts#L116)); commits after attachment arrive on the feed,
  commits before are in the listing; revision comparisons suppress older updates and patches need the exact base. No
  missed-commit or double-apply window was found; a crash between commit and publication loses only the notice.
- **Snapshots.** `backupTo` runs `sqlite3_backup_step` in Node's thread pool; a 314 MB copy took 435 ms with a maximum
  event-loop gap of 10.6 ms. It is a whole copy every changed 10 minutes, keep 20: a 500 MiB database writes about
  3 GB/hour and retains about 9.8 GiB. That quantifies F08; it is not a stall.
- **Ordinary reply writes** are fenced `setText` and `setMessage` for the generated row; the `lastInteraction` stamp
  is a field patch on the current revision; no blanket final whole-chat write reverts an older-message edit.
- **Display-time writes are local to the transform**, including `/continue`; a server display Lua variable cannot
  invalidate other rows. This is a deliberate read-only contract and a behavior change from the browser pipeline for
  scripts that relied on live mutation.
- **Chat writes are by id.** A 2 KiB edit is a 2,118-byte `setText`; a translation is a 2,222-byte `setTranslation`;
  only reordering surviving messages uses `replace` (4.24 MB for the fixture chat). Chat selection, `chatPage`,
  drafts and scroll are local; no scroll or selection write loop exists.
- **Rate limits** are 2,000/min per IP for authenticated routes, a separate 2,000/min storage bucket, and 10 logins per
  30 s. With `TRUST_PROXY` unset every client behind one proxy shares one bucket; with a numeric trust a direct peer
  can spoof the key. This is a deployment boundary, not a migration regression.
- **Tokenizers** load once into a retained promise map; **request history** writes lifecycle transitions, not chunks;
  **job retention** keeps the cumulative reply and baseline, not a chunk history; kept outcomes are capped at 500 for
  24 h with 64 KiB caps.
- **No general settings ping-pong**, no per-chunk sidebar rebuild, no context-meter count during streaming, no
  router double-open, no mount-proportional listener leak in the chat row paths. `TextAreaInput`'s `optiValue`
  effect is not the DOM binding and does not break IME; its popup bridge timers lack disposal cancellation (noted,
  not ranked).
- **Service worker** signs locally and makes no auth request per asset; inlay metadata is boot-seeded, so a rendered
  message costs zero metadata reads plus one GET per distinct uncached image (a conditional N+1 remains for a
  metadata miss, awaited sequentially at [parser.svelte.ts:856](../../../src/ts/parser/parser.svelte.ts#L856)).

## Changes with the largest practical benefit

1. **Fix the two persisted overwrites first.** TJ01 (per-key `scriptstate` reconciliation) and CE01 (explicit
   LoRA edits) are small, isolated changes with recorded tests to flip. Add the composer guards (CE02, CE03) in the
   same pass.
2. **Make display evaluation coherent before making it cheaper.** TJ02's dependency contract (revision or content
   digest, viewport) must land with or before TJ03's shared scope and narrower invalidation, and before ST05's
   tab-side result cache; otherwise caching spreads stale results further.
3. **Stop chat-sized work per message-sized event.** SD01 (adopt ops into the runner scope), TJ04 (delta barrier
   with resync fallback), ST04 (summary deltas and field-level metadata patches), SD03 (frame budget). These share
   one idea: the store already knows what changed; reuse it instead of rereading and re-diffing.
4. **Cut the fixed per-resume and per-boot bytes.** Compress the revision listing (one line), then a change cursor
   (ST03); seed permissions from boot and separate `lastInteraction` from character content (ST02).
5. **Give dictionaries ids.** Plugin storage entries, plugin records, module lore entries (ST01); entry-scoped drafts
   on the client (CE05). This also shrinks ST04's observer reads.
6. **Bound the remaining serving-thread work.** Batched vector eviction (SD02), incremental checkpoints and local
   sweeps (SD04), scope-aware snapshot budgets (TJ05), an asynchronous journal writer (SD06), explicit
   `PRAGMA synchronous`, and owner-liveness deadlines for provider callbacks (TJ06).

Useful measurements to add before and after: SQLite SELECTs and `JSON.parse` calls per checkpoint and per transform
batch; bytes per job-socket callback; feed frame bytes per publication; listing bytes per resume; batch body bytes
per nested write; event-loop delay during eviction, checkpoint capture and state publication.

## Verification and limits

- Four read-only Astra runs on this checkout; `git status --short` was empty before and after each, and the
  orchestrator confirmed the tree is clean. One run executed existing tests:
  `pnpm --silent test:agent server/src/tests/{resourceStore,events,snapshots,vectorCache,requestHistory,diagnostics}.test.ts`
  → 158 passed. The other three declined to run the wrapper (it writes `node_modules/.cache/agent-test` and uses a
  temporary git index) and relied on in-memory probes and existing test assertions read, not run. The full suite,
  slow tests, and e2e were not run; nothing in the application changed, so no gate applies to this change.
- The orchestrator re-read the code behind TJ01, TJ02, TJ03, TJ04, TJ05, TJ06, SD01–SD04, ST01–ST06, CE01–CE07 at
  HEAD, and re-ran the three probe scripts from their new location with matching results (the transform probe's
  `one-loadJobScope` ran in 2.5 ms instead of 4.2 ms; everything else matched to the millisecond or byte).
- All probes use `:memory:` SQLite or a fresh temporary directory, never a save directory. Synthetic payloads are
  repetitive ASCII; gzip figures are illustrative; timings are single observations on a shared machine. No browser
  trace, mobile device, provider, reverse proxy, power loss, or two-tab experiment was run; multi-tab outcomes
  (CE01) and IME outcomes (CE03) are derived from code and the UI Events specification.

### Reproducing the probes

Run from the repository root with dependencies installed:

```bash
node docs/research/deep-audit-with-fable/probes/sync-traffic-measure.mjs
```

```bash
node --expose-gc docs/research/deep-audit-with-fable/probes/transform-jobs-probe.mjs
```

```bash
node docs/research/deep-audit-with-fable/probes/job-channel-probe.mjs
```

```bash
node --expose-gc docs/research/deep-audit-with-fable/probes/checkpoint-probe.mjs
```

Their recorded outputs are beside them (`*.output.txt`); `PROBE_COMMIT` names the measured commit in the
checkpoint and job-channel outputs. The server-data probes ran inline and left only their
results (`server-data-*.results.json`); their setups are described in SD01–SD05 and in "Checked, not a problem".
