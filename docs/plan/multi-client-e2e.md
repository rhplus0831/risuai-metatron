# Multi-Client Data Safety Checks Plan

Status: drafted 2026-11-06; landed: C (cd6a59c01), A (a6e31d33b), B (f53fad1f5); every slice landed. Source: the same day's review of how this app and the sibling forks (PocketRisu, RisuBard,
HaejeokRisuai, RisuNest, risuai-fastify) handle clients that write the same data, against the guides
[resource-sync](../structure/resource-sync.md), [live-updates](../structure/live-updates.md),
[chat-store](../structure/chat-store.md), [server-resources](../structure/server-resources.md),
[server-generation](../structure/server-generation.md), [draft-recovery](../structure/draft-recovery.md) and
[test-harness](../structure/test-harness.md). Owner decisions the same day: every open question's recommendation is
accepted (Q1–Q3); the server-restart scenario runs as a `util/playwright/` check with its own stack, not as an e2e
spec; the plan is implemented in separate sessions, one per
slice, after the Chat Store and Structured Memory Sweep (retired in `c0ab74a9b`). Line numbers below are from that
tree; identifiers are the anchors. Re-verify each cited location before editing (STRUCTURE.md protocol step 5).

## Purpose

The adapter's conflict, lost-answer and lock paths are tested against fakes (`FakeResourceServer`,
`StoreBackedServer`, fake timers), and the browser checks that exist prove convergence, not conflict: no test drives
two real browsers into a conflict against the real server. PocketRisu's whole-database overwrite and the community
reports of lost chat history are the failure class this plan guards against, in the one form it can take here.

The invariant every case asserts, in both of its halves:

1. **Nothing acknowledged is lost.** A change the server acknowledged to any client is still there after every other
   client's writes, whatever order they arrive in, and no chat disappears from a character.
2. **Nothing local is dropped silently.** A local change a client cannot save ends as a notice (`resourceReloaded`,
   `chatGenerating`), a recovery draft, or a refusal the client can see. Never nothing.

Documented exceptions are asserted as documented, not as bugs: a by-id `setText` applies on a stale chat revision
(STRUCTURE.md D4), so two clients editing one message converge to the later-accepted text (see Q3); a tab can edit a
generating reply before its first write's frame (live-updates Issues), so the generation cases act only after the
first checkpoint is visible in the observer. A case that finds a defect does not fix it (Q1).

## Existing coverage

The slices do not repeat these; they cite them where a case borrows a recipe.

| Check                                     | Covers                                                                                                                                                        | Not covered                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `e2e/lazyChats.spec.ts`                   | A second context converges on a rename and a reply through the feed, without reads                                                                            | Any conflict                                                         |
| `e2e/terminalNotice.spec.ts`              | The restore halt's notice in one tab (a routed 412)                                                                                                           | Two tabs; data after the halt                                        |
| `e2e/perChatSends.spec.ts`                | Server sends per chat; a mock provider that holds a stream (`heldA`) or streams until stopped                                                                 | A second client                                                      |
| `util/playwright/checkLiveUpdates.mjs`    | Two-tab matrix of live updates, route writes as a third device, a restart followed by route writes, an import reloading every tab                             | Conflicting writes; writes in flight at the restart                  |
| `util/playwright/checkTwoClientSmoke.mjs` | Against Docker: two clients converge, `--restart-cmd` with a route write before reconnect, archive import and snapshot restore telling both clients           | Conflicts; dev-module observation                                    |
| `util/playwright/checkDurableDrafts.mjs`  | One client's loss: the batch cut before commit, committed with its answer dropped, or the journal held, then Chrome killed; recovery, graceful close, bfcache | The client that stays alive and resends; a second client             |
| `util/playwright/checkJobProtocol.mjs`    | `SIGKILL` during a job: the owner's job ends `shutdown`                                                                                                       | The observer; the message's lock after the restart; writes in flight |
| Adapter unit tests                        | Every path below against the fakes ([resource-sync Tests](../structure/resource-sync.md#tests))                                                               | Real sockets, real SQLite, real timing, two documents                |

## Scenarios

| Id  | Scenario                                                                          | What it proves                                                                                                      | Slice |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----- |
| S1  | A stale tab writes after another client changed the same character and chats      | Stale writes merge or are reported; nothing of the other client's is replaced (the PocketRisu class)                | A     |
| S2  | A batch's answer is lost while the client stays alive                             | The resend is recognized: exactly once on the server, no notice                                                     | A     |
| S4  | Two clients edit different messages of one chat at once                           | By-id ops on a stale revision: both land, no notice                                                                 | A     |
| S5  | Two clients edit the same message at once                                         | The documented message-level convergence (Q3); both tabs show the server's text; no error                           | A     |
| S6  | Two clients create, delete and reorder chats of one character at once             | The chat set is the exact union; an order conflict is reported, never a chat lost                                   | A     |
| S7  | A tab closes within the debounce after an edit                                    | The pagehide keepalive lands the by-id edit; the other tab sees it (Q2)                                             | A     |
| S3  | An observer edits, deletes and sends into a chat another tab is generating in     | The server lock refuses by token; other-message edits land; the finished reply is intact; the lock releases         | B     |
| S9  | The server restarts with writes and a generation in flight (`SIGTERM`, `SIGKILL`) | In-flight work lands once or is reported; the in-memory lock's loss harms nothing; both tabs reconcile              | C     |
| S8  | Two tabs during a restore or import                                               | Covered by `checkTwoClientSmoke.mjs` and `checkLiveUpdates.mjs`; the epoch rule is a server unit contract: Deferred | —     |

## Open questions

The owner accepted every recommendation on 2026-11-06. Each gated slice carries the accepted answer only; no slice
waits on a question.

| Q   | Question                                                                                                                                                                                                                                                                 | Accepted answer                                                                                                                                                                                                                                                                                   | Gates   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Q1  | When a case finds a defect, does the slice fix it, or land red?                                                                                                                                                                                                          | Neither: the slice files the defect in [found-issues](../research/found-issues.md) under "Chat store, sync, and change feeds" (or the owning section) with the case's steps as the repro, marks that one case `test.fixme(<entry heading>)`, and lands green. The fix is its own slice elsewhere. | A, B, C |
| Q2  | S7: a record edit (settings, a character field) is not sent on unload (records use normal cycles only; unload sends whole by-id chat batches), though a hidden-visibility cycle may save it first. Assert its arrival, or only the chat edit's?                          | Assert the chat edit's arrival. Observe the record edit and record what happens as a Limitation in resource-sync if it is lost: that is the documented design (Durable Drafts D7), not a defect.                                                                                                  | A       |
| Q3  | S1 and S5: a by-id `setText` applies on a stale revision, so a stale or slower tab's edit of a message replaces the other client's edit of the same message, with no notice in the replaced tab (its own work was acknowledged; the feed shows the new text). Keep that? | Keep it for now: it is what makes S4 conflict-free, and a per-message base check would turn every slow edit into a conflict. Record it in chat-store Known Hazards Limitations if no entry states it; a notice in the replaced tab is a later design.                                             | A       |

## Rules for every slice

- One slice is one session and one commit. Workflow: `opus-workflow` (every slice is _hard_: real-browser timing, two
  documents, a mock provider or a stack restart); no Codex challenger unless the session meets a disagreement with a
  guide. Each slice ends with its own run, `pnpm check:docs`, `pnpm format:check`, and the owning guides' focused unit
  checks it did not touch left alone.
- The invariant above is the assertion. Every case ends by reading the server (`POST /api/resources/read` for chats,
  `GET /api/resources/<kind>/<id>` for records) and comparing with what the case's accepted writes predict; then it
  checks both tabs' mirrors converge to that (`expect.poll` over the module instances, as `lazyChats.spec.ts` reads
  `chatStore.svelte.ts`). A refused or discarded change is asserted twice: absent from the server, and present as a
  notice or a draft (`recoveryDrafts` in `src/ts/storage/recoveryDrafts.svelte.ts`, the `alertStore` subscription of
  `terminalNotice.spec.ts` ~173).
- No sleep as synchronization (STRUCTURE.md V3 holds for specs too): `settle` for an idle save loop, `expect.poll`
  with a stated timeout for convergence, the provider's release for generation. `settle` means nothing is dirty, queued
  or in flight; a refused or quarantined item can be idle, so a refusal is asserted through the server read and the
  notice, not through `settle`.
- Edits go through the UI where a spec already has a driver (`openChat.spec.ts` ~125 edits a note, `lazyChats.spec.ts`
  renames), otherwise through the module instances (`setMessageText`, `appendMessage`, `createChat`, `deleteChat`,
  `reorderChats` in `src/ts/storage/chatStore.svelte.ts` ~3410–3970; records through their wrappers), as the existing
  specs do. A raw `POST /api/resources/batch` through a session's `api()` stands for a third device or an unguarded
  writer.
- A spec that makes its own contexts calls `clearSafeBootAttempts` before the first load (`e2e/fixtures.ts` header),
  restores every shared record it changed in `afterAll` (the `restore` object of `perChatSends.spec.ts` ~222), and
  removes its characters. The stack is shared by the run: `e2e/0-idleReload.spec.ts` runs first and
  `welcomeAndChatSettings.spec.ts` last; new spec names sort between them.
- Selection is by name (`util/agentE2e.mjs`): the spec's header comment names the source files it covers by repository
  path (`src/ts/storage/resourceSync.svelte.ts`, `src/ts/storage/chatStore.svelte.ts`, `src/ts/network/eventFeed.ts`,
  `server/src/data/chatStore.ts`, `server/src/jobs/generationLock.ts` as each applies), so a change there selects it.
- Runs: `pnpm --silent test:agent --e2e e2e/<spec>` (`--force` when the tree is clean). One e2e run or one
  `util/playwright/` check at a time per machine, and no Vitest beside a dev stack (a dependency re-optimization reloads
  the page). The human gate stays: never `HUMAN=1` to run the specs.
- Guides: each slice adds its spec or script to the owning guides' `Tests` (the `e2e:` or browser-check line) and, for
  Q2 and Q3, one Limitation. The tree ratchet has 1,293 bytes of headroom (`check:docs`, 823,707 of 825,000), so each
  such edit trims as many bytes nearby in the same guide. `test-harness.md` lists check scripts, not specs.

## Order

- A before B: B imports the two-session harness A creates. C is independent of both and may run in parallel with A.
- Shared files: A and B both touch `docs/structure/chat-store.md` and `live-updates.md` `Tests` lines (rebase); C
  touches `test-harness.md` and `server-generation.md`. No slice edits application source.
- Sessions: A, B and C are _hard_. Two at a time (A and C) is the most the e2e lock allows, and only when the second is
  the script on its own ports.

## Slices

- **A. The two-session harness and the conflict spec** (_hard_; `test-harness.md` owns the files, `resource-sync.md`,
  `chat-store.md` and `draft-recovery.md` own the behavior; Q1, Q2, Q3).
  _Files_: new `e2e/multiClient.ts` (the harness) and `e2e/multiClient.spec.ts`. The harness is the `session()` of
  `lazyChats.spec.ts` ~57–127 (page, `api`, batch and read counters, page errors) plus: a subscription to `alertStore`
  and `recoveryDrafts` that records every notice and draft with its time; `edits` that call the chat-store writers in
  the page; `serverChat(chaId, id)` and `serverRecord(kind, id)` reads; and `expectState(expected)` that compares the
  server with a predicted state built from the ops the case's accepted batches carried (a `page.on("response")` on
  `/api/resources/batch` with status 2xx), then polls both mirrors to it. Two contexts, both through
  `clearSafeBootAttempts`, both `isolateContext`. Seed as `perChatSends.spec.ts` ~203 does (flush, leave the page, seed
  through the routes, `setEpoch`), one character with chats `s1..s4` of four messages each, bound with
  `chatBindingFixture`; no provider.
  _Cases_ (each its own `test`, in this order):
  - **S1 stale tab.** A opens the character, B opens it in the other context. `A.context.setOffline(true)` (HTTP and
    the socket both drop). Offline, A edits `desc` of the character, `s1/m1`, `s1/m2` and `s2/m1`. Online, B renames
    the character, edits `s1/m2` and `s1/m3`, appends to `s1`, creates `s5`, deletes `s2`, and settles.
    `A.context.setOffline(false)`. Expected server state: B's name and A's `desc` (record merge of independent
    fields, no draft, no notice); B's `s1/m3`, append and `s5`; A's `s1/m1`; `s1/m2` with A's text (Q3: the stale by-id
    write wins, B's tab converges to it through the feed); `s2` gone, and A holds one recovery draft for
    `chats/<chaId>/s2` with the `resourceReloaded` notice (an edit of a message another writer removed answers
    `missing`, chat-store "Which ops apply"). Whether A's batch leaves before or after its `hello` reconcile is not
    controlled: both orders must give this state.
  - **S2 lost answer.** A `page.route` on `/api/resources/batch`, once: `await route.fetch({ maxRetries: 0 })`, then
    `route.abort("failed")` (the `answer-dropped` cut of `checkDurableDrafts.mjs` ~187, without the kill). Under it A
    appends to `s3` and edits the `ui` record. Expected: the append is on the server once and in B once; the next
    batch from A carries the same `groupId` with `retry: true` (`shared/chats.ts` `ChatGroup`) and the record's exact
    sent text (`resendInDoubt`); no notice, no draft, and A's batch count is exactly one more than the case's edits
    needed.
  - **S4 different messages.** Without settling between them, A edits `s3/m1` and B edits `s3/m3`. Expected: both on
    the server and in both tabs; no notice, no draft, no 409 (count responses with status 409 on both pages: zero, or
    the merge happened on the record path only).
  - **S5 same message.** Without settling, A and B edit `s3/m2`. Expected: the server holds one of the two texts, both
    tabs show it, no page error, no draft; whichever text lost is recorded in the case's output. Q3's Limitation line
    lands with this case.
  - **S6 chat set.** Without settling, A creates `x1` and `x2` then reorders `[x2, x1, ...]`; B creates `y1` and
    deletes `s4`. Expected: the character's chat id set on the server is the seed minus `s4` plus `x1, x2, y1`; the
    stored order is a permutation of it; both tabs list exactly it. A's reorder may be discarded with the
    `resourceReloaded` notice reporting `chats/<chaId>` (a conflicted reorder whose server order differs,
    resource-sync "Chat and order conflicts"): assert the notice when the order is not A's, and never a missing chat.
  - **S7 tab close.** A edits `s1/m4` and `desc`, then `A.context.close()` at once (the graceful close of
    `checkDurableDrafts.mjs`). Expected: `s1/m4` reaches the server through `sendBatchOnUnload` and B shows it; the
    `desc` edit is observed and reported per Q2.
    _Done_: the six cases pass three runs in a row on the shared stack; a case that fails for a defect is `fixme` with
    its inbox entry (Q1); the harness exports what B needs. _Guides_: `resource-sync.md` Tests `e2e:` names
    `e2e/multiClient.spec.ts` (S1, S2, S7) and its Limitations take Q2's line if observed; `chat-store.md` Tests
    `e2e:` adds it (S4–S6) and Known Hazards Limitations takes Q3's line if no entry states it; `draft-recovery.md`
    Tests adds the S1 draft case.
    _Test_: `pnpm --silent test:agent --e2e e2e/multiClient.spec.ts`.

- **B. The generation lock across two clients** (_hard_; `server-generation.md` owns the lock, `live-updates.md` the
  feed locks, `chat-store.md` the lock readers; Q1).
  _Files_: new `e2e/multiClientGeneration.spec.ts`, importing `e2e/multiClient.ts`; a mock provider as
  `perChatSends.spec.ts` ~46–101 (`reverse_proxy` with `forceReplaceUrl`, model fixtures from
  `util/playwright/modelProfiles.mjs`), whose streamed reply writes its first chunk at once and holds the rest until
  the case releases it.
  _Cases_:
  - **S3a the locked message.** A sends in `s1`; B waits until the first chunk's text is visible in its own row for
    the reply (the first checkpoint's frame is in, so B's `feedLocks` name the reply). In B: `isMessageLocked` is
    true for the reply and the row shows the generating state; `setMessageText` on it refuses locally
    (`assertUnlocked`); a raw batch through `B.api` with a `setText` on the reply answers 409 with
    `reason: "generating"` and the reply's id in `messageIds` (the server's `MessageGuard`, `generationLock.ts`).
  - **S3b another message.** While the hold lasts, B edits `s1/m1` through the module. Expected: it lands (a group
    without locked ids is not a generating refusal); A shows it under the stream; no notice.
  - **S3c structural writes.** While the hold lasts, B asks to delete the character and, through a raw batch, the
    chat `s1`. Expected: the character delete is refused in B (`isCharacterGenerating`); the chat delete answers 409
    with `reason: "generating"`; both still exist.
  - **S3d release.** The provider releases; A's job ends. Expected: the server's reply text is the first chunk plus
    the rest, once; both tabs show it; B's `feedLocks` for `s1` are empty (the final write's frame, or the whole
    read); B's `setMessageText` on the reply now lands and A shows it.
  - **S3e the edit before the lock frame.** Documented Issue, asserted as documented: a B edit of the reply sent
    before its first frame is dropped with `resourceReloaded` and the reply is read back whole. Only if the case can
    hit the window deterministically (a `page.route` holding B's socket frames); otherwise `test.skip` with the Issue's
    sentence, not `fixme`.
    _Done_: S3a–S3d pass three runs in a row; S3e passes or is skipped with its reason. _Guides_: `live-updates.md`
    Tests `e2e:` adds the spec (feed locks); `server-generation.md` Tests adds it beside the browser checks;
    `chat-store.md` Tests names it for the lock readers.
    _Test_: `pnpm --silent test:agent --e2e e2e/multiClientGeneration.spec.ts`.

- **C. Restart races** (_hard_; `test-harness.md` owns the script, `server-generation.md`, `resource-sync.md` and
  `live-updates.md` the behavior; Q1).
  _Files_: new `util/playwright/checkServerRestartRaces.mjs`, its own stack through `startStack` on ports 6268/5368
  (`checkAssetLifecycle.mjs` uses 6267/5367), two contexts (`chromium` from `playwright-core`, `isolateContext`,
  `clearSafeBootAttempts`), a mock provider with a held stream as in B, `PASS`/`FAIL` lines and a non-zero exit as the
  other checks (`checkLiveUpdates.mjs` `check`). `stack.restartServer({ signal })` stops the old process and waits for
  `/api/test_auth`; it kills at once and the wait is asynchronous (`checkJobProtocol.mjs` ~671). Not under
  `offline.sh`: no plugin.
  _Cases_:
  - **R1 a committed batch whose answer the kill drops.** A `page.route` on A's batch: `route.fetch`, then
    `restartServer({ signal: "SIGKILL" })`, then `route.abort`. Expected: the group is on the server once; A's resend
    (same `groupId`, `retry: true`) is answered from the persisted group ids (`chatGroups` survives the process) and
    changes nothing; no notice.
  - **R2 a batch cut before commit.** The route delays `route.continue()` until after `SIGKILL`; the request fails.
    Expected: the resend applies once after the restart; no notice, no draft.
  - **R3 a write during graceful shutdown.** `restartServer({ signal: "SIGTERM" })` and, in the same tick, an edit in
    A. Expected: a 503 with `Retry-After` is retried by the save loop (not discarded, not quarantined); the edit is on
    the server after the restart; no notice.
  - **R4 `SIGKILL` mid-generation with an observer.** A sends with the hold; B shows the first chunk; `SIGKILL`.
    Expected: the stored reply is the first chunk (the last checkpoint), once; A's follow ends with the job error and
    no restore notice (same epoch); after the restart B's `setMessageText` on that reply lands (the in-memory lock is
    gone and the fence closes on this write) and A shows it; no second reply row appears in either tab.
  - **R5 both tabs write right after the restart.** Before the tabs' sockets are back, A edits a record and B edits
    the same record's other field and another message. Expected: the record merges, the message lands, both tabs
    reconcile through `hello` (`listChanges` or `listRevisions`); no notice.
    _Done_: R1–R5 pass twice in a row; the script's header states its cases and usage. _Guides_: `test-harness.md`
    adds the script to "Check and measurement scripts" (against the dev stack); `server-generation.md` Tests names it
    beside `checkJobProtocol.mjs`; `resource-sync.md` Known Hazards gains nothing unless a case finds a limit.
    _Test_: `node util/playwright/checkServerRestartRaces.mjs`.

## Deferred

- **S8 two tabs during a restore.** `checkTwoClientSmoke.mjs` (import and snapshot restore, both clients told, reload,
  state shown) and `checkLiveUpdates.mjs` (import reloads every tab) cover the tabs; the rule that a write admitted
  before the gate closes is in the safety snapshot and replaced by the install is server-resources' contract, tested
  in process. Revisit only if a defect report names the window.
- **Two server processes on one data directory.** One port forbids it in the stack; a second server on another port
  over the same `save/` is unsupported and undocumented. If it is ever supported, the memory-only state (generation
  lock, feed subscribers, memory tasks) is what a check would target. RisuBard's `.risubard-server.lock` is the
  reference for a process lock and for its PID-reuse pitfall in containers.
- **The open inline-editor draft loss** ("An adopted server copy drops an open inline editor's unsaved text",
  found-issues): a case for A once the fix lands (B continues a message A is editing inline; A's typed text survives
  or is offered). Not asserted before: it would be red by design.
- **A notice for a replaced same-message edit** (Q3) and a per-message base: a design, not a test.
- **Other browsers.** The stack is Chrome (`RISU_CHROME`); Firefox and Safari stay out.
- **`pnpm test:e2e` runtime.** Two more spec files add two to four minutes; if the people's run grows past its budget,
  the slow cases move to a `util/playwright/` check as C did.

## Verification

- A: `pnpm --silent test:agent --e2e e2e/multiClient.spec.ts`; B: `… e2e/multiClientGeneration.spec.ts`; C:
  `node util/playwright/checkServerRestartRaces.mjs`. Three green runs in a row for a spec, two for the script, with no
  `flaky.jsonl` line from them.
- Each slice: `pnpm check:docs` (tree under the ratchet), `pnpm format:check`, and the specs it named in
  `util/agentE2e.mjs` terms (a change to the harness file selects both specs).
- The plan retires when A, B and C are landed and the found-issues entries a case filed (Q1) each have a slice in
  another plan or a Known Hazards line.
