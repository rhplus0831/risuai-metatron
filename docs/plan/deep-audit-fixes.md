# Deep Audit Fixes Plan

Status: in progress; landed: 1 (44426ad50), 2 (2171bcb5c), 3 (d16a90ac9), 4 (95d3f8f47), 6
(cef9e9330). Planned 2026-10-26; same day the user decided the two open questions: the memory
limit line is restored (Slice 7), and whole chat reads carry the server's lock snapshot (Slice 8).

Sources: the two audits of 2026-10-26, the
[server/client stabilization audit](../research/deep-audit/server-client-stabilization.md)
(findings F01–F17, at `c1a1d5d6c`) and the
[server migration deep audit](../research/deep-audit-with-fable/server-migration-audit.md)
(findings SD/ST/TJ/CE, at `ff7cb9d20`, with probes under `probes/`); the
[found-issues list](../research/found-issues.md); and the open items the agents' project
memory still held on 2026-10-26 (listed under **Collected issues**). Code anchors below
were re-checked at `0387e120d`; re-verify before editing (STRUCTURE.md protocol step 5).

Owning guides: [chat-pipeline](../structure/chat-pipeline.md) (triggers, jobs, composer,
suggestions), [persistence](../structure/persistence.md) (flush, refusals, feed locks),
[self-host-server](../structure/self-host-server.md) (routes, vector cache, push),
[ui-theming](../structure/ui-theming.md) (chat rows), [settings-i18n](../structure/settings-i18n.md)
(image generation, persona settings), [characters-modules](../structure/characters-modules.md)
(lorebook editor), [diagnostics](../structure/diagnostics.md) (collector mock),
[global-api](../structure/global-api.md) (push reconciliation).

## Goal

Both audits inventory what the server migration left open. This plan picks the findings
that are **confirmed, bounded, and worth a fix now**, groups them into slices a session
can land independently, and records why the rest is deferred. Selection rules:

1. Every P1 of both audits: TJ01, CE01, CE02, CE03 (migration audit) and F01 (stabilization
   audit). F02 is a P1 too but is an architecture item (an IndexedDB journal); it is deferred
   with a recommended follow-up plan.
2. P2 correctness defects whose fix is local to one file cluster and has a clear test:
   F05, F11, F14, CE06, CE08, ST03 (the compression line), SD02, the explicit
   `PRAGMA synchronous`.
3. Small confirmed bugs from the found-issues list and memory with a known fix: the request
   trigger "Invalid return", the empty-history `lastChat` push, the overlapping-range token
   recheck, the lorebook local-activation check, the persona note popup language, the stale
   fold index, the failed display transform that never renders again, the memory limit line.
4. Documentation and test hygiene the notes name: the stale auth durability clause, the
   missing kept-outcome rule, two stale comments, the collector mock factory (V7).

Everything else is in **Deferred** with the grouping a later plan should use.

## Collected issues

| Source                                                                      | Id / name                                                   | Priority | Where in this plan |
| --------------------------------------------------------------------------- | ----------------------------------------------------------- | -------- | ------------------ |
| migration audit                                                             | TJ01 trigger reconciliation writes `scriptstate` whole      | P1       | Slice 1            |
| migration audit                                                             | CE01 LoRA effect republishes a mount draft                  | P1       | Slice 3            |
| migration audit                                                             | CE02 composer translation writes unguarded                  | P1       | Slice 2            |
| migration audit                                                             | CE03 translation composer Enter ignores `isComposing`       | P1       | Slice 2            |
| stabilization audit                                                         | F01 persistent chat refusal missing from flush readiness    | P1       | Slice 6            |
| stabilization audit                                                         | F05 newer chat read clears an active generation lock        | P2       | Slice 8            |
| found-issues "Feed lock windows", memory "feed lock survives recovery read" | the two faces of the same lock-lifetime gap                 | P2       | Slice 8            |
| stabilization audit                                                         | F11 suggestion translation applies to another chat          | P2       | Slice 3            |
| stabilization audit                                                         | F14 PWA foreground rewrites unchanged push subscriptions    | P3       | Slice 5            |
| migration audit                                                             | CE06 chat "viewed" behind settings or a hidden PWA          | P2       | Slice 7            |
| migration audit                                                             | CE08 presentation effects without owner checks              | P3       | Slice 3            |
| migration audit                                                             | ST03 revision listing uncompressed                          | P2       | Slice 5            |
| migration audit                                                             | SD02 vector eviction as separate autocommits                | P2       | Slice 5            |
| migration audit "Checked, not a problem"                                    | `PRAGMA synchronous` left to the build default              | note     | Slice 5            |
| memory "requestTrigger Invalid return"                                      | every send without trigger scripts logs `Invalid return`    | bug      | Slice 1            |
| memory "legacy lastChat undefined"                                          | empty `chats` pushes `undefined` into `lastChat`            | bug      | Slice 1            |
| memory "overlapping chat range recheck"                                     | shared object subtracted once, `inputTokens` over-reports   | bug      | Slice 1            |
| memory "local activation check too broad"                                   | `isLocallyActivated` matches any chat entry by id           | bug      | Slice 4            |
| memory "persona note leftovers"                                             | note preview tokenizes via Google; stale test comment/order | minor    | Slice 4            |
| found-issues "Stale fold index at a chat switch"                            | reproduced in a browser 2026-10-25                          | bug      | Slice 7            |
| found-issues "A failed display transform is not rendered again"             | raw row after a resume until a chat switch                  | bug      | Slice 7            |
| found-issues "Memory limit line not drawn"                                  | two settings do nothing                                     | bug      | Slice 7            |
| stabilization audit "documentation drift"                                   | server guide says auth files are written directly           | docs     | Slice 9            |
| memory "kept job outcomes not in server guide"                              | 24 h kept-outcome rule missing from the route table         | docs     | Slice 9            |
| memory "phase 6 review suggestions", "persona note leftovers"               | stale comments in `characterStore.svelte.ts`, persona test  | docs     | Slice 9            |
| memory "collector mock has no factory"                                      | ten inline collector mocks (V7)                             | tests    | Slice 9            |

Not re-targeted here, with the reason: the "Parked resends leak" and "Store subscriber
throw queue" entries (accepted trade-off; latent), the "Orphan duplicate removal conflict"
(owned by the active [Chat Lore Override States](chat-lore-override-states.md) plan), the
"shared composer across chats" note (the user keeps it as its own follow-up; Slice 2 fixes
only the translation writes), and the leftover lists that are accepted trade-offs
(request history, Realm import, lorebook filter, memory trim question, plugin reload
deferral, Web Push second round). The deferred audit findings are in **Deferred**.

## Slices

Each slice is independent of the others, touches one file cluster, lands with its own
tests, and ends by deleting or marking its findings in the source document (the audit
file, `found-issues.md`, or the memory note). Code and test names describe the behavior,
never the finding id (T5). V1 gates apply to every slice.

### Slice 1: server prompt and trigger correctness

Findings: TJ01, request trigger "Invalid return", empty-history `lastChat`, overlapping-range
recheck.

Files: `server/src/jobs/chatResult.ts`, `server/src/jobs/runSetup.ts`,
`server/src/prompt/assemble.ts`, their tests under `server/src/tests/`.

- **TJ01.** `applyTriggerChat` (`chatResult.ts:39`) compares the copy's top-level chat fields
  with the baseline and sets a differing `scriptstate` whole. Change it to reconcile
  `scriptstate` **by key** against the baseline: a key the copy changed or added is written;
  a key the copy deleted is deleted explicitly; keys unchanged in the copy are left as the
  fresh revision has them, so another writer's key survives. Keys the incremental
  `setChatVar` flush already persisted (`jobScope.ts:461`) are skipped. Same-key policy: the
  trigger's final value wins, as today. Apply the same rule to any other dictionary field the
  function reconciles whole (check `scriptstate` siblings in the field list first).
  Test: flip `chatResult.test.ts:375` ("inherited from the tab, recorded") to require `$b`
  preserved, and add a deletion case. Re-run the probe
  (`node --expose-gc docs/research/deep-audit-with-fable/probes/transform-jobs-probe.mjs`,
  label `trigger-disjoint-variable-loss`) and record the after values in the audit.
- **"Invalid return".** `runSetup.ts:461` throws when `runTrigger` answers `null`/`undefined`
  or no `displayData` (the no-trigger early returns at `triggers.ts:447` and following). Treat
  a missing result or missing `displayData` as "unchanged" and return `formated`; keep the
  throw for a present, non-array `displayData`. Test: a send with no request trigger logs no
  script failure and keeps the messages.
- **Empty `chats`.** `assemble.ts:1760` pushes `chats[chats.length - 1]` without a length
  check. Guard with `chats.length > 0`. Test: no examples, no greeting, no eligible message,
  no template; the prompt assembles.
- **Overlapping ranges.** Two overlapping `chat` cards push the same object twice; the recheck
  subtracts its count once and empties both. Recount the emitted list after a removal
  instead of subtracting (keeps prompt identity, so the browser golden stays valid), or
  clone each occurrence if the recount changes a golden. Test: overlapping ranges, forced
  recheck removal, `inputTokens` equals a fresh count of what is sent.

### Slice 2: composer translation ownership and IME guards

Findings: CE02, CE03.

Files: `src/lib/ChatScreens/DefaultChatScreen.svelte` (`updateInputTransateMessage` at
`:793`, the main composer Enter at `:1054`, the translation composer at `:1395-1414`),
`src/lib/ChatScreens/PartialEditController.svelte:490`, `src/lib/UI/GUI/TextAreaInput.svelte`
(highlight branch, dormant).

- **CE02.** Give `updateInputTransateMessage` a run token: capture the source text, the
  destination field, and the chat key (`currentChatRef`) before `translate`; after it,
  publish only when the token is still current, the source text is unchanged, and the chat
  is the same. Invalidate the token on Send (`:482` clears the field already), on a chat
  switch (the `chatKey` effect), on toggling input translation off, and on destroy. Do not
  replace the destination while it is composing (`compositionstart`/`compositionend` flag).
  The non-experimental path gets the same check (it has none today).
- **CE03.** One composition-aware guard for every send/save/cancel shortcut: the translation
  composer's Enter (`:1401`) gets `!e.isComposing` like the main composer; the partial
  editor's modifier Enter (`PartialEditController.svelte:490`) too. Leave the dormant
  `TextAreaInput` highlight branch, but add the guard if it is touched.
- Tests: a mounted `DefaultChatScreen` is not available (see memory "latest message start
  scroll"); extract the translation runner into a `.svelte.ts` helper with an injected
  translator so the ordering test (B finishes before A, A must not publish) and the
  invalidation cases run in Vitest. The Enter guard is tested on the extracted keydown
  handler with a synthetic `isComposing: true` event. Device checks (Android Korean, desktop
  Japanese) are listed as pending in the slice's landing note, not claimed.

### Slice 3: effects that publish without an owner

Findings: CE01, F11, CE08.

Files: `src/lib/Setting/Pages/ImageGenerationSettings.svelte` (`:43`, `:161`),
`src/lib/ChatScreens/Suggestion.svelte` (`:244-253`, `:299`),
`src/lib/UI/TransitionImage.svelte:44`, `src/lib/ChatScreens/ChatScreen.svelte:32`,
`src/lib/Others/AlertComp.svelte:185`, `src/lib/ChatScreens/DefaultChatScreen.svelte:200`
(bookmark jump).

- **CE01.** Remove the tracked read of `settings.secrets.wavespeedImage` from the publishing
  effect. Publish `loras` only from explicit edits (add, remove, URL/strength change) through
  a function, never from an effect; a `.pre` effect syncs a **clean** draft from incoming
  values; a dirty draft keeps its base so an incoming change shows as a conflict notice
  instead of being overwritten or republished. Test: two mounted editors fed alternating
  acknowledged remote records; the clean one adopts without saving, the dirty one keeps its
  draft and saves nothing until the user edits.
- **F11.** `translateSuggest` captures an immutable copy of `suggestMessages`, the chat key,
  and a run token; writes to a fresh array and publishes it whole only when the token is
  current; the effect's cleanup invalidates the token; destroy too. Test with a deferred
  translator: start in chat A, switch to B, resolve A; B's labels are untouched.
- **CE08.** The same pattern (token captured before the await, checked after, invalidated in
  cleanup) for the four presentation effects. No persisted data is involved, so one test per
  site with a deferred source is enough.

### Slice 4: lorebook and persona small fixes

Findings: lorebook local-activation check, persona note popup language, persona test order
and comment.

Files: `src/lib/SideBars/LoreBook/LoreBookData.svelte` (`:66`, `:87`),
`src/lib/Setting/Pages/PersonaSettings.svelte` (`:204-220`), `PersonaSettings.test.ts`,
`src/lib/SideBars/ChatBindingPanel.test.ts`.

- `isLocallyActivated` and `deactivateLocally` match `entry.mode === "child" && entry.id ===
book.id` only, so a plain chat entry sharing an id (an import that kept ids) is neither
  shown as linked nor deleted by unchecking. Test in a `LoreBookData` test: a plain chat entry
  with the same id stays after unchecking.
- The persona note `TextAreaInput` gets `popupLanguage="plaintext"`, so its preview does not
  tokenize the note (and never sends it to Google with `googleClaudeTokenizing`).
- `ChatBindingPanel.test.ts`'s note test unbinds a live persona before deleting it;
  `PersonaSettings.test.ts:55`'s comment no longer mentions the removed toggle.
- Out of scope here: the popup write-back resolving `activePersona` at close time (memory
  item 2) stays a separate card.

### Slice 5: server quick wins and push reconciliation

Findings: ST03, SD02, explicit `PRAGMA synchronous`, F14.

Files: `server/src/routes/resources.ts:264`, `server/src/data/vectorCache.ts:176`,
`server/src/data/resourceStore.ts` (store open), `server/src/push/pushService.ts`
(`register`), `src/ts/network/pushNotifications.ts` (`ensureSubscribed` `:273`,
`reconcilePush`), `src/lib/Others/PushPrompt.svelte:24`.

- **ST03.** `GET /api/resources/revisions` answers through `compressedJson`. Measure before and
  after with the sync traffic probe's fixture (listing bytes per resume) and record the
  numbers in the audit. The change cursor is deferred (see **Deferred**).
- **SD02.** `trim` deletes victims inside one transaction with a bounded number of rows per
  call (the rest on the next `set`), so one insert never spends 250 ms on the serving thread.
  Test: seeded just under the bound, one insert deletes within the budget and the cache ends
  under the bound after a bounded number of inserts.
- **`PRAGMA synchronous`.** Set it explicitly to FULL on the resource store so acknowledged
  writes do not depend on the build default; request history and the vector cache keep
  NORMAL. Pin it in `resourceStore.test.ts`.
- **F14.** Client: `reconcilePush` skips the PUT when the subscription (endpoint, keys,
  server public key) equals the one it last registered within a bounded interval (for
  example 24 h, kept in `localStorage` beside the existing push keys), and folds concurrent
  reconciliations into one. Server: `register` with an unchanged endpoint and keys does not
  rewrite the file unless the last-seen stamp is older than the same interval. Keep recovery
  after a key rotation (a different server public key always registers) and after a deleted
  subscription (a 404/410 or a server listing miss registers again). Tests on both sides.

### Slice 6: durability state is explicit (F01)

Finding: F01.

Files: `src/ts/storage/resourceSync.svelte.ts` (`flushResources` `:1564-1600`,
`refusedItems` `:1044`), `src/ts/storage/chatStore.svelte.ts` (`refusedChatItems` `:3307`,
`hasRefusedChatWork` `:3325`), `src/ts/process/serverCommands.ts:560`,
`src/ts/drive/backuplocal.ts` (`:118`, `:361`), `src/ts/network/jobChannel.ts` (`holds`
`:544`), `src/lang/en.ts`, `src/lang/ko.ts`.

- `flushResources` returns, beside `discarded`, the keys **still refused** after the flush
  (`refused: string[]`, built from `refusedItems()` and `refusedChatItems()`), so "no new
  discard" and "everything is durable" are different answers. Existing callers that ignore
  the field are unchanged.
- **Send admission** (`serverCommands.ts:560`): a send whose target chat (or its character's
  order) is in `refused` is refused with a new alert string (`serverJob.refusedDraft`, en and
  ko: the chat has an unsaved draft the server refused; Retry or Discard it first) and the
  existing Retry/Discard controls are pointed at. The checkpoint code's `localRefusal`
  (`chatCheckpoints.svelte.ts:184`) already does this check; reuse its shape.
- **Export** (`backuplocal.ts`): both exports treat `refused` like `discarded`: the warning
  names the refused chats and the archive is still produced (the user may want the server
  copy), with the note that those chats' drafts are not in it. A recovery export of local
  drafts is deferred (F02).
- **Callback readiness** (`jobChannel.ts:544` `holds`): a receipt for a chat that is refused
  locally does not count as held even when revisions are equal, so an input-stage hook does
  not run on a mirror the tab knows is not the server's.
- Tests (`resourceSyncChats.test.ts`, `serverCommands.test.ts`, `backuplocal` test): quarantine
  a chat through a validation refusal, let the alert settle, then (a) a later flush reports it
  in `refused` with an empty `discarded`; (b) a send to it is refused with the new alert and
  a send to another chat proceeds; (c) an export warns and names it; (d) `holds` is false for
  its receipt at an equal revision.

### Slice 7: chat screen state and rendering bugs

Findings: CE06, stale fold index, failed display transform, memory limit line.

Files: `src/ts/process/chatStatus.svelte.ts:70-90`, `src/ts/stores.svelte.ts:31-32`,
`src/lib/ChatScreens/Chats.svelte`, `src/ts/globalApi.svelte.ts:1493-1536`,
`src/ts/parser/transformClient.ts` (`serverProcessScript` ~`:489`),
`src/lib/ChatScreens/Chat.svelte` (~`:296`), `src/ts/setting/displaySettingsData.svelte.ts:294-305`,
the three `Chats*.svelte.test.ts` files.

- **CE06.** `visibleChatKey()` also requires `!settingsOpen`, `!gridOpenStore`, and a reactive
  page-visibility signal (`document.visibilityState === "visible"`, mirrored into a rune by
  the existing visibility listener). A reply that completes with settings open, the grid
  open, or the PWA hidden keeps its unseen mark and its recovery badge until the transcript is
  actually shown. Test each of the three in `chatStatus.test.ts`.
- **Stale fold index.** `Chats.svelte` reads the fold index only while `chatFoldedState.data`
  targets the shown chat (character and chat ids), so the opening diff of the next chat never
  stages a window that ends at the previous chat's fold. The three `Chats*.svelte.test.ts`
  files mock `src/ts/globalApi.svelte` inline and need `chatFoldedState` in the mock. Test:
  fold chat A at an index, switch to chat B of the same character, the opening window is B's
  full window on the first run (no second structural run that arms every row).
- **Failed transform.** When `serverProcessScript` returns the unprocessed text because the
  request did not answer, the row stays re-renderable: bump that row's `generations` entry
  (`rerenderMessage`) when the page becomes `visible` or `online` and the chat is shown, and
  record a `notice`-style diagnostics event (`transformFailed`, content-free) so a report
  shows it. Test needs a mounted `Chat.svelte` with the transform stubbed to fail, then
  answer; if no such harness exists, test the client helper (fail → mark → next render
  retries) and record the mounted check as pending.
- **Memory limit line.** Restore the line: `Chats.svelte` draws it before the first message the
  model still sees, from `Chat.lastMemory`, honoring `showMemoryLimit` and
  `memoryLimitThickness`. `lastMemory` is set before the final recheck (`assemble.ts:1940`),
  so the line can be off by the entries the recheck removed; the context usage report's kept
  ids are the exact source if it is extended later. Help text says so. **Decided 2026-10-26:**
  restore the line; removing the two settings was offered and declined.

### Slice 8: lock lifetime independent of chat revision (F05)

Findings: F05, found-issues "Feed lock windows", memory "feed lock survives recovery read".

Files: `server/src/data/chatStore.ts` (chat read answer), `server/src/routes/resources.ts`
(`POST /api/resources/read`), `shared/resources.ts` (read answer type),
`src/ts/storage/chatStore.svelte.ts` (`dropFeedLocksOf` `:1408`, `:4642`, `:5551`,
`replaceFeedLocks`), `docs/structure/persistence.md`, `docs/structure/self-host-server.md`.

Owner decision 2026-10-24 was "a lock snapshot with chat reads only if needed". Both audits
and both notes now show the two failure directions of deciding lock life by revision: a newer
whole read **drops** a live lock (F05: edits land on the generating reply and are dropped
later), and a whole read **cannot release** a stale lock when the release frame was missed
(the reply stays locked until the next `hello`). **Decided 2026-10-26:** the user accepted
the read contract change below; the slice goes ahead and makes the read authoritative for
locks:

- A whole chat read (`readRefs` chats, `readChat`) carries the server's current lock
  snapshot for that chat (the streaming message ids and the sampled revision, the same shape
  `hello` sends per chat).
- `dropFeedLocksOf` on a whole read replaces that chat's feed locks with the read's snapshot
  instead of comparing revisions; a read without a snapshot (older server) keeps today's
  rule. `hello` keeps replacing the whole set.
- Collection removals that drop revisions still clear feed locks (audit the paths the
  found-issues entry names).
- Tests: a lock announced at revision r1, an unrelated field advances to r2, the whole read
  at r2 carries the lock, it stays; the same read without the lock releases it; the recovery
  read after a lost follow unlocks the reply when the job ended. Server: the read snapshot
  equals `hello`'s for the same chat.
- The guides' lock sections (persistence, self-host-server) are updated with the read
  contract: the read answer type in `shared/resources.ts` gains the per-chat lock snapshot
  field, optional for compatibility with reads that lack it.

### Slice 9: documentation and test hygiene

Findings: stale auth durability clause, kept-outcome rule, stale comments, collector mock
factory.

Files: `docs/structure/self-host-server.md:467` and the generation route row (`:112`) plus
the job lifecycle text, `src/ts/storage/characterStore.svelte.ts:6`,
`src/lib/Setting/Pages/PersonaSettings.test.ts:55` (if Slice 4 has not landed),
`src/ts/diagnostics/tests/collectorMock.ts` (new), the ten test files from
`rg -ln 'diagnostics/collector"' src --glob '*.test.ts'`.

- Replace "known-key files are written directly rather than through atomic staging" with the
  current staged durable write (`durableWrite.ts:84`), keeping the directory-fsync caveat.
- Add the kept-outcome rule to the server guide: after the 60 s grace the owner's
  `GET /api/generations/:id` still answers `state: "ended"`, `kept: true` with a trimmed
  terminal for 24 h, at most 500 records, cleared on epoch change, lost on restart.
- Drop the stale "Before `../stores.svelte`" comment (the file no longer imports it).
- `createCollectorMock(overrides)` whose defaults `satisfies` the collector module's export
  type, in the style of `src/ts/tests/alertMock.ts` and
  `src/ts/network/tests/generationJobsMock.ts`; migrate the inline mocks. `pnpm check` then
  breaks when the collector gains an export the mocks miss.

## Recommended order

1. Slices 1, 2, 3: the P1 overwrites and the IME send (small, isolated, recorded tests to
   flip). Slice 1 is server-only and Slices 2 and 3 are client-only, so they can run in
   parallel sessions (one owner per file: Slice 2 owns `DefaultChatScreen.svelte`, so Slice
   3's bookmark-jump token waits for Slice 2 or is done in Slice 2).
2. Slices 6 and 7: durability state and the chat-screen state bugs the mobile resume work
   depends on (CE06 is the "I did not notice the reply" symptom; the failed transform is the
   "raw reply until a chat switch" symptom).
3. Slices 4, 5, 9: small fixes, quick wins, hygiene; any order, parallel.
4. Slice 8 last: it changes a read contract (accepted 2026-10-26) and its guide updates
   should land after Slice 6's flush-result change to the same persistence guide.

## Deferred

These confirmed findings stay open. Each line gives the reason and the plan it belongs to;
none should be fixed piecemeal inside the slices above.

| Finding                                                          | Reason deferred                                                                     | Belongs to                                                                                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| F02 unsaved intent lives only in the tab                         | Needs an IndexedDB journal keyed by server identity and epoch, with recovery UI     | **Durable drafts plan**: F02, F03 (retain conflict drafts, then field-level merge), F04 (background reads off the save critical path)         |
| F03 coarse conflict recovery                                     | Field-level merge policy per record kind; coupled fields must stay together         | Durable drafts plan                                                                                                                           |
| F04 refreshes block saves                                        | Save cycle restructuring with read deadlines                                        | Durable drafts plan                                                                                                                           |
| F15 no idempotent job-create id, F16 page-owned follow-ups       | Server protocol additions (request ids, durable follow-up sequence)                 | **Job protocol plan**: F15, F16, TJ06 (owner-liveness deadlines for provider callbacks), restart-preserves-checkpoints note                   |
| TJ02 transform inputs have no revision fence                     | Must land with or before TJ03 and ST05; a dependency contract for scripts           | **Display evaluation plan**: TJ02 first, then TJ03 (shared scope, narrow invalidation), ST05 (tab-side result cache), TJ05                    |
| TJ03, ST05, TJ05                                                 | Caching before TJ02 spreads stale results further                                   | Display evaluation plan                                                                                                                       |
| SD01 checkpoint rereads, TJ04 whole-chat barrier, ST04, SD03     | One idea: reuse the store's change information instead of rereading and re-diffing  | **Per-event server work plan**: SD01, TJ04 (delta barrier with resync fallback), ST04 (summary deltas, field-level meta), SD03                |
| ST01 dictionaries without ids, CE05 whole-field drafts           | Needs entry ids for plugin storage, plugin records, module lore (D1–D4 constraints) | **Dictionary ids plan**: ST01, CE05; shrinks ST04's observer reads                                                                            |
| ST02 boot hydrates characters whole, `lastInteraction` stamp     | Sidebar projection and a partial record type (D1)                                   | **Boot bytes plan**: ST02, ST03's change cursor (after the compression line in Slice 5), permissions seeded from boot                         |
| F06 restore blocks the serving thread, F07 reads count refs      | Worker database or paged reads; keep transaction and epoch guarantees               | **Server byte budgets plan**: F06, F07, F17 (auth before body buffering), SD06 (asynchronous journal writer), SD04, SD05                      |
| F08 no asset/backup byte budget                                  | Needs a reference graph over live records, snapshots, checkpoints, prepared exports | **Retention plan**: F08, backup repair of invalid assets, prepared export pinning, Blob fallback budget (F13)                                 |
| F09 abortable counters bypass batching, F10 Google serial counts | Shared batching with per-consumer cancellation; CE07's projection belongs with it   | **Token counting plan**: F09, F10, CE07                                                                                                       |
| F12 streaming reparses the growing message, CE04 stream search   | Needs device measurements first (see the rendering investigation)                   | **Rendering follow-up**: F12, CE04 (id index), with [rendering-performance-investigation](../research/rendering-performance-investigation.md) |
| ST06 uploads never ask presence, ST07 plugin `getDatabase()`     | New batch endpoint; plugin API scope                                                | Boot bytes plan (ST06), plugins (ST07)                                                                                                        |
| Message search as a repeated scan, legacy import compare/delete  | Index semantics unproven; narrow race                                               | Later, on report                                                                                                                              |
| shared composer across chats (memory)                            | Per-chat composer state; the user keeps it as its own follow-up                     | Its own card after Slice 2                                                                                                                    |

## Verification

- Per slice: V1 (`pnpm check`, `pnpm --silent test:agent`, affected `slow` and `e2e` sets),
  V6 (each new regression test shown failing once with the line it guards broken), V4 (`rg`
  each changed export), prettier on changed files.
- Probes as before/after measurements where one exists: Slice 1 the transform-jobs probe's
  `trigger-disjoint-variable-loss`; Slice 5 the sync traffic probe's listing bytes and the
  vector cache timing from the server-data aux results.
- Browser checks the slices cannot cover in Vitest are listed in each landing note as
  pending, never as passed (V5): Slice 2's IME on Android Korean and desktop Japanese, Slice
  7's failed-transform row and memory limit line, Slice 3's two-tab LoRA alternation.
- Close-out per slice: delete the fixed entries from `found-issues.md`, mark the finding in
  the audit's table as fixed with the commit, delete the memory note or narrow it to what is
  left, and update the owning guide where a contract changed (Slices 6, 8, 9).
