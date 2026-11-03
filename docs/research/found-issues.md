# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26, the third on 2026-10-30, the fourth (the Server Byte Budgets run) and the fifth (the Guide Budgets run) on 2026-11-01, the sixth (the Structured Memory run) on 2026-11-03; single entries move as they come up.

These are notes, not verified reports: this file is the inbox, and the focused guides' Known Hazards are where verified entries live. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. An entry that is re-checked and has an owning guide under `docs/structure/` moves to that guide's Known Hazards `Issues` (or `Limitations`, once the owner accepts it; STRUCTURE.md Doc Maintenance) and leaves this file. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24 (first batch), 2026-10-26 (second batch), 2026-10-27 (single entries), and 2026-10-29 (a cleanup pass that fixed eleven entries and narrowed one). Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

## Contents

- [Chat store, sync, and change feeds](#chat-store-sync-and-change-feeds) (5)
- [Server jobs and prompt assembly](#server-jobs-and-prompt-assembly) (2)
- [Server routes and resource store](#server-routes-and-resource-store) (5)
- [Display transform](#display-transform) (1)
- [Chat screen and input](#chat-screen-and-input) (2)
- [Client and plugins](#client-and-plugins) (8)
- [Build, drivers, and e2e](#build-drivers-and-e2e) (11)
- [Guides](#guides) (14)
- [Test timing](#test-timing) (1)
- [Structured Memory](#structured-memory) (17)

## Chat store, sync, and change feeds

### Parked resends leak

`src/ts/storage/chatStore.svelte.ts` `dropCharacterWork(id, false)` from `takeChatWork`'s absent-character sweep (~3505, the quarantined-create path) parks in-doubt resends (`parkResends`); no deletion acknowledgement or `forgetCharacter` ever comes for a character the server never had, so the entry stays until `seedChats` (boot) or a re-add of the same id, which would replay a harmless resend first. Accepted trade-off of open-bug-fixes slice A3 (landed on metatron 2026-10-19 via plan-runner), noted by its Fable reviewer. Still present 2026-10-21 (`parkedResends`, chatStore.svelte.ts ~180).

**Why it matters:** tiny memory leak per session; a far-later same-id re-add sends one extra replay.

**Suggested handling:** if it matters, drop parked resends once the adapter knows the abandoned character has no server incarnation and no unresolved create can still establish one, and also clean entries parked in an earlier cycle. `persisted` alone is not that proof: a removed character whose create answer was lost is resent while `persisted` lacks it (resourceSync.svelte.ts ~1387), and a same-id re-add still needs the preserved group ids (checked 2026-10-24). Parked payloads can hold whole chat snapshots, so the leak is not always tiny.

### Store subscriber throw queue

`svelte/store` `writable.set` runs all subscribers through one module-level `subscriber_queue`; if one subscriber throws, the queue is left mid-run for the whole realm, so later store updates anywhere may not notify. `src/ts/process/localSends.ts` `beginLocalSend` (added 2026-10-23, per-chat send slice 1) rolls back its own entry on a throw, but cannot repair the shared queue. Same exposure existed with the old `doingChat.set(true)`. Pre-existing, latent (no known throwing subscriber). Found by the Fable review of per-chat send slice 1; see the Per-Chat Send plan.

**Why it matters:** a single bad subscriber (plugin or component) could silently freeze unrelated store notifications.
**Suggested handling:** if store notifications mysteriously stop after an error, check for a throwing subscriber first; a fix would wrap subscribers or avoid svelte/store for hot paths.

### discardRefusedChat reads without a deadline

`discardRefusedChat` in `src/ts/storage/chatStore.svelte.ts` (the two reads near lines 4206 and 4215 on 2026-11-01) calls `readRefs` directly, with no `deadlineRead`, `deadlineChatRead` or `readWithDeadline` and no signal, while every other client read has a timer. Each read names one group, so it is one round and no regression from read continuation; it predates that work. Noticed by Server Byte Budgets slice 2 (2026-10-31).

**Why it matters:** a stalled link leaves that discard waiting without a bound.
**Suggested handling:** wrap both reads in the chat module's deadline helper.

### characterStore header still lists Lua and triggers as writers

The header comment of the character mutations in `src/ts/storage/characterStore.svelte.ts:40` names `plugins, MCP, Lua, triggers, imports` as external contracts. Scripting moved to the server, so no browser Lua or trigger caller remains. Found by Guide Budgets slice 2; re-checked 2026-11-01.

**Why it matters:** it misleads a reader about who writes characters.
**Suggested handling:** fix the comment's list; check each name against the callers first.

### No guide states the restore floor's check order

`docs/structure/chat-store.md` `### Restore floor` links to `server-resources.md#chat-writes-and-checkpoints` for the check, and `server-resources.md:424` sends floor details back to `chat-store.md#restore-floor`. Neither states the order of the checks, and `reason: "generating"` handling has no rule in any guide. Found by Guide Budgets slice 2.

**Why it matters:** a reader changing the floor finds a circular pointer instead of the rule.
**Suggested handling:** read the checks in `server/src/data/chatStore.ts`, state the order once in `chat-store.md` `### Restore floor`, paying for the bytes in the same edit, and keep the link one way.

## Server jobs and prompt assembly

### Tool schemas are outside the assembly token budget

`server/src/prompt/assemble.ts`'s final recheck counts messages; `AssemblyHost` has no tool-schema input, and the OpenAI adapter (`server/src/llm/openAI/requests.ts`) adds `body.tools` from descriptors supplied later in `server/src/llm/requests.ts`. A prompt assembled to the budget can therefore exceed the provider's context by the schemas' tokens. Traced by the [cross-plan review](../audit/cross-plan-2026-10-29.md#hypotheses-not-reproduced) (memory seam) and not reproduced with a real tokenizer; unverified.

**Why it matters:** with many or large tool definitions a send near the budget could be refused by the provider although the meter shows room.
**Suggested handling:** measure with a real tool set and tokenizer; if the gap is real, charge an estimate of the schemas in the recheck (the token-counting follow-up group of the Deep Audit Fixes plan).

### memoryTasks header says the hand-off comes after done

`server/src/prompt/memory/memoryTasks.ts:146` says a job hands the memory input "after `done`", but `server/src/prompt/runner.ts` hands off right before it emits `done`; `docs/structure/memory.md` `Background memory task` says "Right before". Found by Guide Budgets slice 5a.

**Why it matters:** the guide sends readers to this header for the task's rules, so the wrong word reads as the ordering contract.
**Suggested handling:** change the word to "before".

## Server routes and resource store

### Routes still measure a body the limiter already counted

Since `limitedBody` counts the bytes that arrive (Server Byte Budgets slice 1, `d8aac27d0`, 2026-10-31), the second size check after the read and its comment "The limiter trusts a declared length" are redundant and false in `server/src/routes/messageSearch.ts:213`, `tokens.ts:24`, `diagnostics.ts:56`, `requestHistory.ts:152` and `chatCheckpoints.ts:73`; the comments in `server/src/tests/resourcesBoot.test.ts` (~806, "the limiter trusts it, so the route measures what it read") and `diagnostics.test.ts` (~1679, "the body read is measured again") are stale the same way. The boot route's copy was removed in that slice; these files were outside it. Still present 2026-11-01.

**Why it matters:** harmless at runtime (the same 413), but the comments state behavior that is gone and the `arrayBuffer()` then `text()` pair is dead logic.
**Suggested handling:** when one of these routes is next touched, drop the check and the comment and let the limiter's 413 stand.

### chatCheckpoints.ts keeps its own copy of the old body limiter

`server/src/routes/chatCheckpoints.ts:2` imports `hono/body-limit` and builds its own `limitBody`/`limitedBody` (~37) instead of `routes/limitedBody.ts`; it is the only such import left after slice 1. It runs after authentication and caps at 16 KiB, so it is no pre-auth exposure, but a chunked body is still buffered first and a read failure past the preread takes the route's own path, not the shared post-`next()` rule. The server guide's registration-order item notes the exception.

**Why it matters:** D1 of the plan says route caps go through the shared helper; two copies drift.
**Suggested handling:** replace the copy with `limitedBody(MAX_CHECKPOINT_BODY_BYTES)` and remove the guide's note.

### checkpoints.sweep has no product caller

`store.checkpoints.sweep` (`server/src/data/resourceStore.ts` ~1756 on 2026-11-01) is called only by tests; the open-time sweep (~1181) calls the table function directly. Since `prune` and `delete` stopped sweeping the whole `checkpointPages` table (slice 7, `7d55d0189`), the pages a chat or character cascade orphans wait for the next open, so a long-running server keeps them until a restart. The plan accepted the wait; the unused wrapper was noticed in passing.

**Why it matters:** the bytes of a deleted chat's pages stay in the database file and in every snapshot's copy until a restart (a restore drops them).
**Suggested handling:** if orphan growth ever matters, call the sweep from a maintenance tick or after a chat delete; otherwise the wrapper is test-only and could move.

### Every login appends its key hash again

`server/src/routes/auth.ts` login (the `KNOWN_KEYS_KEY` operation, ~224) appends `hashJSON(body.publicKey)` to the known-key list without checking that it is already there, so a tab that logs in again with the same key adds a duplicate, the file grows without a bound, and `verifyJwt`'s `includes` (~132) scans it for every request. Noticed 2026-10-31 while slice 6 serialized logins; the serialized operation kept the behavior.

**Why it matters:** a durable write per repeat login, and a linear check on the serving path, that a set or a dedupe would avoid.
**Suggested handling:** skip the write when the hash is known; a small fix.

### Normalizer comments still say the startup pass runs on every start

`server/src/data/kinds.ts:37-39` (the `ResourceKind` doc comment) says a normalizer runs "in the store's startup pass" and that a non-idempotent one "rewrites the record on every start"; `shared/characters.ts:6`, `server/src/data/normalize/characters.ts:8` and `docs/structure/persistence.md:237` use the same wording. Since the normalization stamp (slice 4, `e743a93e3`) an open with its own stamp skips the record scan, so this holds only for a run of the pass (a new commit, a dirty or identity-less run, a `replaceAll`). Noticed by slice 4; the files were outside its list.

**Why it matters:** a non-idempotent normalizer no longer shows up as a rewrite on each restart, only on a new commit, so the comment's warning misleads.
**Suggested handling:** reword the four places to "in a run of the normalization pass" when one is next touched.

## Display transform

### Budget-refused handler rows not re-measured

`server/src/prompt/transform.ts` refuses a two-call (tab plugin handler) target whose snapshot charge passes `MAX_SNAPSHOT_BYTES` (8 MiB, :54). Since the [cross-plan review's DT1 fix](../audit/cross-plan-2026-10-29.md#dt1--a-permanent-display-failure-retries-and-toasts-every-round) (94856bdc2) a scope over the limit alone fails `permanent` (shown raw until its source or context changes), while a refusal the request's other targets caused is a plain failure that `src/ts/parser/displayTransformRecovery.svelte.ts` retries after 5 s with only the failed rows, so the earlier claim that such rows stay raw until a remount no longer holds. What is left is the measurement: when Display Evaluation Slice 3 measured it (2026-10-28), a 2,000-message chat of about 6 MiB charged about 6.7 MiB per scope, so only 30–38 of a 64-target chunk fit; Slice 4 then excluded the shared display entries from the per-snapshot charge (`exclude: entries`), so that number is likely smaller now. Not re-measured since.

**Why it matters:** users with display plugins and long chats may still see a round of raw rows before the retry, and a scope whose own charge is over the limit stays raw.
**Suggested handling:** re-measure on a realistic large chat with handlers (`util/playwright/measureTransformLua.mjs` has the shape); if a scope alone still passes the limit on realistic chats, raise the limit or charge the transcript once per scope.

## Chat screen and input

### Latest-message start scroll untested in DefaultChatScreen

In 49b046098 (2026-10-24, chat opens at the newest message's start) two pieces of `src/lib/ChatScreens/DefaultChatScreen.svelte` have no unit test, because no test mounts that screen: the reroll swipe alignment gated on `followsSwap` / `Chats.followsLatest` (read before the swap, then `scrollToLatestMessage` after a tick), and the `$effect` that consumes `ShowLatestMessageStore` (set by `openRoute` for notification clicks), and (since 2026-10-27) the scroll handler's load-more skip while `Chats.holding` is true. Only `openRoute` setting the store is tested (`src/ts/router/router.test.ts`).

**Why it matters:** a regression in either path would pass the gate.
**Suggested handling:** add coverage when `DefaultChatScreen` gets a mounted test harness (the Deep Audit Fixes bookmark-jump and translation-invalidation tests are waiting on the same harness), or when touching these paths.

### An adopted server copy drops an open inline editor's unsaved text

`src/lib/ChatScreens/Chats.svelte` mounts each row under a key that includes the message text, and `Chat.svelte` keeps an inline edit's `draft` in the component until Save (`setMessageText`). A server copy of the chat that changes an edited message's text (`applyRemoteChat`, from the live-update feed's change, the idle refresh of a stale chat, or since 2026-10-31 the completion-push read `refreshChatAfterPush`) therefore remounts that row and the typed text is gone: the chat store's local-work guards cover pending and in-flight mutations, not component drafts. Needs the inline editor (automatic popup editing off) and another device continuing or editing that same message meanwhile. Found by the Astra cross-layer review of the lost-job follow change (`/home/codex/review-reports/lost-job-follow-2026-10-31/astra-report.md`).

**Why it matters:** a few lines of a correction typed on one device vanish without a notice when another device writes the same message.
**Suggested handling:** register open editor drafts as refresh holds (the read waits until the editor closes, as pending work does), or keep drafts by chat and message id across the remount and show the changed base explicitly.

## Client and plugins

### Chinese browsers never match the first-boot language list

`src/ts/bootstrap.ts:274` compares `navigator.language?.split("-")[0]` with `BROWSER_UI_LANGUAGES` (`["de", "en", "ko", "cn", "vi", "zh-Hant"]`, :263). A `zh-CN` or `zh-TW` browser yields `zh`, so `cn` and `zh-Hant` cannot match at first boot. Read in source by Guide Budgets slice 5c, not run.

**Why it matters:** those users start in the default language although the list advertises their language.
**Suggested handling:** map `zh-*` to `cn` or `zh-Hant` before the lookup, with a bootstrap test.

### Plugin tests cite a skip no guide records

`src/ts/plugins/apiV3/pluginContext.test.ts:1285` and `src/ts/plugins/apiV3/permissions.test.ts:314` say the skipped-instance bug of `loadV3Plugins` is recorded in `plugins-mcp.md`. The guide did not record it even before Guide Budgets slice 5b, and `src/ts/plugins/apiV3/v3.svelte.ts:2412` now unloads a snapshot of the instances.

**Why it matters:** the comments send a reader to a hazard that does not exist and may justify a repeat-until-gone test workaround that is no longer needed.
**Suggested handling:** confirm the snapshot makes the skip impossible, then drop the citation and the workaround.

### mcplib test calls settled behavior a recorded hazard

`src/ts/process/mcp/tests/mcplib.test.ts:13` calls a stream ending without an answer a recorded hazard in `plugins-mcp.md`. The guide records it as settled behavior (JSON-RPC error -32000), and `mcplibStreams.test.ts` covers it. Found by Guide Budgets slice 5b.

**Why it matters:** a reader of the test looks for an open hazard that was closed.
**Suggested handling:** reword the header comment.

### RPack mocks rest on a byte map fetch that is gone

About 11 test files mock `src/ts/rpack/rpack_js.js` with a comment that the real RPack fetches its byte map as a Vite asset (`src/ts/translator/presetsCodec.test.ts:33`, `src/ts/characterCardsImport.test.ts:59`, `src/ts/storage/tests/presetIds.test.ts:46`). `rpack_js.js` now re-exports `shared/rpack.ts`, whose map is inlined and which is synchronous. Found by Guide Budgets slice 5b.

**Why it matters:** the mocks look like unneeded boundary mocks (V7), and the tests could run the real codec.
**Suggested handling:** drop the mocks where the real codec works, or fix the comments.

### plugins.md omits two parsed headers

`plugins.md` documents neither `//@allowed-ipc` nor `//@risu-arg`, though `importPlugin` in `src/ts/plugins/plugins.svelte.ts` parses both and the runtime's IPC warnings tell authors to use `//@allowed-ipc`. Found by Guide Budgets slice 5b.

**Why it matters:** an author told to use a header cannot find it in the author guide.
**Suggested handling:** add both headers to `plugins.md` with their parsing rules.

### socketLiveness says tests replace livenessClock

`src/ts/network/socketLiveness.ts:8` says stamps read `livenessClock.now()` "(tests replace it)". No test does: `socketLiveness.test.ts` fakes `Date`. Found by Guide Budgets slice 5c, which dropped the same claim from `global-api.md`.

**Why it matters:** it sends a test writer to a seam nobody uses.
**Suggested handling:** fix the comment.

### Setting keywords are called a future feature

`src/ts/setting/types.ts:172` says "Search keywords for future search feature", but settings search already reads `keywords`. Found by Guide Budgets slice 5c.

**Why it matters:** a reader may treat the field as unused and drop it.
**Suggested handling:** fix the comment.

### safeBoot header cites the wider Boot section

`src/ts/safeBoot.ts:2` cites `app-shell.md` Boot; since Guide Budgets slice 5d the guide has `### Safe boot` under `Flows`. The old citation still resolves.

**Why it matters:** the header sends a reader to the wider section first.
**Suggested handling:** change the word when `safeBoot.ts` is next touched.

## Build, drivers, and e2e

### checkJobProtocol's first run after a source change fails its SIGKILL case

`util/playwright/checkJobProtocol.mjs`: the first run after a source change failed `sigkill-before-checkpoint` with "waiting for navigation to finish" (the page rebooted about 6 s after the SIGKILL restart); the next two runs passed every case. Likely Vite's dependency-optimization reload of the dev stack. Found 2026-10-29 by the Job Protocol audit's verification; not reproduced.

**Why it matters:** a first run on a fresh tree can report a protocol failure that is the dev server's reload.
**Suggested handling:** if it recurs, have the driver wait for Vite's optimization to settle before the case (`openApp` already answers the prompt again after a reload), or run the dev stack once before the cases.

### A chat-open suggestion request bumps the chat revision

`src/lib/ChatScreens/Suggestion.svelte` `requestSuggestions`: with `useAutoSuggestions` on, opening a chat without suggestions requests them and stores the answer through `setChatMeta`. That write moves the chat's revision, which is part of the transform key (`server/src/prompt/transform.ts` `baseKey`), so the rows just rendered miss the cache on the next return to the chat: full answers instead of `same`, and a `{{random}}` row changes its text. Seen in an `e2e/serverTransform.spec.ts` trace on 2026-10-30, when `perChatSends` left the setting on; not checked by hand. An empty answer over a chat with no suggestions no longer writes, so what is left is a real answer.

**Why it matters:** with auto suggestions on, the first return to a chat after new suggestions downloads and re-runs what the tab already holds.
**Suggested handling:** decide whether a non-render chat field such as `suggestMessages` should move the transform key at all; the chat revision is also the key's fence against mixed-revision results, so this needs its own design.

### terminalNotice.spec.ts's composer case fails on an unseeded chat

`e2e/terminalNotice.spec.ts:279` ("Enter in the composer once the notice opened goes to its OK") fails since `81e5eda9e` locked the composers while a chat needs its setup: `input.fill` at `:312` times out on a readonly textarea with placeholder "Setup required", because the spec's `seed` sets no `promptPresetId`, `modelPresetId` or `bindedPersona` (`e2e/chatBinding.spec.ts` was updated for the lock, this spec was not). Reproduced 2026-10-31 at `e338911fc` on a clean worktree, and red in every Server Byte Budgets slice run.

**Why it matters:** a red spec unrelated to the change under test reads like a regression of that change, and the terminal notice's Enter handling is no longer guarded.
**Suggested handling:** seed the chat with its three bindings the way `chatBinding.spec.ts` does and check the spec passes.

### Guide-budget reflow is not in the blame ignore list

`.git-blame-ignore-revs` lists whole-repository format commits, but not `e0624f671` (`docs(structure): wrap STRUCTURE.md and the guides at 120 columns`, Guide Budgets slice 1), which rewrapped 18 Markdown files.

**Why it matters:** `git blame` on a guide lands on the reflow for most lines.
**Suggested handling:** add the hash with a comment line.

### requireHuman notice names the old guide

`util/requireHuman.mjs:19` prints `see docs/structure/build-test-platforms.md` for `test:agent`'s flags, which moved to `docs/structure/test-harness.md` in Guide Budgets slice 4.

**Why it matters:** an agent stopped by the human gate reads this notice first, and it takes one extra hop.
**Suggested handling:** change the path; check whether a test pins the notice text first.

### Delegate profile test policy names the old guide

`.claude/delegate-implementation.local.md:11` (untracked, main checkout) points the `<test policy>` slot at `docs/structure/build-test-platforms.md`. Guide Budgets slice 4 moved `### Test rules` to `docs/structure/test-harness.md`.

**Why it matters:** the slot is pasted into test-writer prompts, so a writer is sent to a guide that no longer holds the rules.
**Suggested handling:** change the slot to `docs/structure/test-harness.md`.

### check:docs does not measure blockquoted items

`util/docsBudget.mjs` `parseGuide`: `LIST_MARKER` (:54) does not see a list item behind `> `, so `> - <601 characters>` becomes a paragraph, and the length rule skips paragraphs. Found by the Guide Budgets slice 7 challenger.

**Why it matters:** low: no guide uses a blockquoted list today, but one could hold an over-long item with a passing check. The leaf and file budgets still bound it.
**Suggested handling:** strip a leading `> ` before the marker test if blockquotes appear in the guides.

### check:docs collapses spaces inside a row's code spans

`util/docsBudget.mjs:168` runs `line.replace(/\s+/g, " ")` over a whole table row to drop column padding, which also collapses spaces inside code spans, though Doc Maintenance counts code spans toward the item budget. A row with 601 spaces in a code span measures 9 characters and survives Prettier. Found by the Guide Budgets slice 7 challenger.

**Why it matters:** low: it needs an unrealistic code span.
**Suggested handling:** collapse padding outside code spans only (`replaceCodeSpans` is in the same file) if a row ever hits it.

### checkMcpFixes and the guide disagree on the repeated call

`util/playwright/checkMcpFixes.mjs:476` says the hazard recorded in `plugins-mcp.md` is "that call fails". The Gotcha on 404 and 401 records that the session resets and the request repeats once, and says nothing of a failure. Found by Guide Budgets slice 5b.

**Why it matters:** the comment and the guide disagree on what the browser check expects.
**Suggested handling:** run the check's scenario to see which holds, then fix the comment or add the failure to the Gotcha.

### personaBinding spec comment reads as plugin coverage

`e2e/personaBinding.spec.ts:250` describes a plugin's `setDatabase({ selectedPersona })`, but the test calls `selectPersona` directly. Found by Guide Budgets slice 5b.

**Why it matters:** the comment reads as e2e coverage of the plugin host's index-to-id resolution, which the spec does not drive.
**Suggested handling:** reword the comment; add a plugin-driven case only if that path needs a browser check.

### settingsPages spec header overstates first visits

`e2e/settingsPages.spec.ts:7` says each page mounts without writing anything, while the spec's own comment and the `settings-i18n.md` Issue say a first visit may save defaults. Found by Guide Budgets slice 5c.

**Why it matters:** the header overstates what the e2e proves about first-visit writes.
**Suggested handling:** fix the comment.

## Guides

### Archive README cites a gone emotion table hazard

`docs/archived-plan/README.md:824` says the emotion table's `bind:value` throw is a Known Hazard in its guide. `characters-modules.md` has no such entry and the table no longer uses `bind:value`.

**Why it matters:** the archive sends a reader to a hazard that is gone.
**Suggested handling:** a one-clause correction, only when the archive is touched anyway.

## Test timing

### Gate tests still racing real time

Untagged gate tests that depend on real wall-clock or scheduler time (invariant V3), noted by the [cross-plan review](../audit/cross-plan-2026-10-29.md#test-quality) on 2026-10-29; none failed in its runs. `src/ts/storage/tests/draftJournal.test.ts`: the start and adoption cases (the live-owner case near "leaves a live owner's rows alone" and the owner-reload case) call the real journal with its production 3 s open/seed and 5 s recovery-lock deadlines, and the file's blanket fake-timer comment does not hold for them. `server/src/tests/hypaV3Parts.test.ts`: selection and deferral cases built with `hostOf` run under the real 5,000 ms cumulative separator budget. `server/src/tests/transformService.test.ts`: `heldCount` polls with a real `setTimeout(2)` (up to 500 polls) and a 5 ms real sleep observes shutdown. `server/src/tests/transform.test.ts`: the real-worker route cases outside the cache describe's fake clock race worker, CBS, and transform deadlines (`SLOW = 60_000` is a timeout, not a `slow` tag). `src/ts/storage/tests/bootCacheServer.test.ts` (around the cases near lines 185 and 485 at that time): the real 3 s cache deadline with asynchronous IndexedDB work. Real sleeps: `server/src/tests/backups.test.ts` (`sleep(2)`/`sleep(20)` in five cases), `server/src/tests/push.test.ts` (delivery and queue synchronization), `server/src/tests/resourceStore.test.ts` (delayed continuations), `server/src/tests/diagnostics.test.ts` (successive state timestamps, a job fixture). `src/lib/ChatScreens/Chat.draft.test.ts`: the auto-popup cases wait for the first row with real `vi.waitFor` before faking timers. `src/ts/network/generationJobs.test.ts` and `src/ts/process/serverCommands.test.ts`: zero-delay real-timer flush helpers as synchronization.

**Why it matters:** each is a load-sensitive failure waiting for a slow CI runner; the timing plans' policy (`docs/structure/test-harness.md` `Tests`) asks for controlled clocks or the `slow` tag.
**Suggested handling:** when one of these files is next touched, control its clock (inject the deadline or fake the timers) or tag the case `slow`; `pnpm --silent test:agent --slow-tests` lists the ones over 1 s.

## Structured Memory

Moved from the Structured Memory plan run on 2026-11-03. Each entry was re-checked against the run's last tree that day; the guides' Known Hazards hold the limits the owner accepted, so they are not repeated here.

### Memory task wording still says summaries

The memory task service has a `structuredMemory` kind since slice 2b, yet comments still describe every task as HypaV3: `shared/events.ts` (~21), `src/ts/network/eventFeed.ts` (~38), `server/src/jobs/runSetup.ts` (~64), `server/src/app.ts` (~451, ~1007), `src/lib/SideBars/chatStatus.ts` (~15). `summarizingChats` in `src/ts/process/memoryTasks.svelte.ts` counts a writer task as summarizing, and `src/lib/ChatScreens/ContextMeter.svelte`'s task block shows "Background summary", "the new summaries are stored", and "summarizing 0/1" for the writer (seen in a browser 2026-11-02). The HypaV3 modal's status helper keeps HypaV3 wording, but Structured Memory chats open their own panel.

**Why it matters:** an agent reads a task as HypaV3, and a user who cannot verify memory is told the wrong activity.
**Suggested handling:** read `MemoryTaskStatus.kind` in the meter's task block and chip, and widen the comments.

### Record now in a job is seen by one tab

`server/src/prompt/memory/structured/recordJob.ts`: the blocking in-job path opens job-scoped progress only and sets no memory task status or `memoryTaskFenced` fence, so another tab's panel stays editable while it runs (the queued path does publish). `MemoryReceiptLine.svelte` `press` also shows "Recording requested" after any `done`, including one sent after the in-job run already finished, and a window that ends `skipped` puts its raw reason code into the English job error (`runWindows`). Slice 2d.

**Why it matters:** D3 wants every tab read-only while the writer runs; the toast and the code read oddly.
**Suggested handling:** publish a status for the in-job run, let `done` say which path ran, and map the reason through the language file.

### Receipt on a message with no generation info

`writer.ts` `commitWindow` writes `generationInfo: { memory }` on a window message that had none, so with `requestInfoInsideChat` `Chat.svelte` shows a model button labelled "Unknown". `genInfo`, which holds `MemoryReceiptLine`, is not rendered in the `mobilechat` and `cardboard` themes, so no receipt line shows there. Slice 2d.

**Why it matters:** a stray button in one setting, and no receipt at all in two themes.
**Suggested handling:** skip the model button when only `memory` is present; decide where the line goes in those themes.

### Embedding refusal masks a later assembly error

`server/src/prompt/runner.ts` (~1462, ~1466) shows `refusal?.message ?? assembled.error`. Structured Memory's retrieval catches an embedding failure and the send goes on, but the local-model refusal stays recorded, so a send that later fails on context size reports the embedding refusal. Found 2026-11-01.

**Why it matters:** the user reads the wrong reason for a failed send.
**Suggested handling:** clear or ignore a refusal the memory step already survived.

### Panel writer line and stale views

In `src/ts/process/structuredMemory.svelte.ts` and `StructuredMemoryPanel.svelte`:

- `memoryWriterNotice` reads `pluginModel` and `requestTrigger` only from the newest reply's receipt, because `jobMemoryBlockingReason` needs a job scope no route has, so before the first send the panel does not say "not recording automatically".
- A checkpoint load refreshes the chat resource but not the panel's contents, so an open panel shows the records from before the load until refreshed. A stale edit is refused 409, so nothing is lost.
- A copied or branched chat keeps `generationInfo.memory` while its runs stay behind (`structured/inherit.ts`), so a copied paused receipt can offer Resume on an empty Log.
- `pressReset` reads the chat again only on `reset: true`. When the route committed but the answer was lost, the repeat answers `reset: false`, and the tab keeps the old value until the feed's notice comes.

**Why it matters:** the panel says something untrue until a refresh or a send.
**Suggested handling:** a scope-loading status read for the first item, a refresh on the chat's change frame, stripping copied receipts (or ignoring run-less ones), and reading on any reset answer.

### Cast slice matches substrings

`castSlice` (`server/src/prompt/memory/structured/pages.ts`) lists a page when its title or alias is a case-insensitive substring of a window message, so an alias "Al" matches "also". The read path uses `searchMatch`.

**Why it matters:** an extra prompt row, never a wrong record; the writer and the read path disagree on "named".
**Suggested handling:** use `searchMatch` in `castSlice`.

### Lore search depth skips a short chat's first messages

`searchMatch` (`shared/lore/activation.ts`) slices `messages.slice(messages.length - searchDepth, messages.length)`. A negative start counts from the end, so three messages and depth 5 start at index 1 and skip message 0 (`[0,1,2].slice(-2, 3)` is `[1, 2]`). The pages lane avoids it by passing exactly the rows it wants. Found 2026-11-02.

**Why it matters:** a key only in the first messages of a short chat does not activate.
**Suggested handling:** clamp the start to 0 and update `server/src/tests/fixtures/baseline/`, after checking upstream parity.

### Snapshot layout check is copied

`memoryStateLayout` in `server/src/data/memoryStore.ts` copies the layout block at the head of `walkCheckpointSnapshot` (`server/src/data/checkpointStore.ts`): name match, ordinary table, exact columns, all or none. Slice 1c could not edit `checkpointStore.ts`.

**Why it matters:** two copies of a check on crafted snapshot files can drift apart.
**Suggested handling:** one helper beside `snapshotRows` in `resourceStore.ts`.

### Hand-written resourceSync mocks

`src/lib/ChatScreens/Chat.test.ts` keeps a hand-written `vi.mock` of `src/ts/storage/resourceSync.svelte`, and other files mock it too, though `src/ts/tests/bootMocks.ts` has a typed factory. Slice 5c met three tests failing at run time on a missing `beginMutationScope`.

**Why it matters:** STRUCTURE.md V7: a new export should break the type check, not a run.
**Suggested handling:** move those mocks onto the shared factory.

### Projection refresh leftovers

Left by slice 5g. A journal recovery that replays a real `hypaV3Data` while Structured Memory is selected is dropped (`src/ts/storage/journalRecovery.ts` `applyChatOps` through `setChatMeta`) with the plugin-worded `structuredMemory.projectionWriteRefused` notice. The body-cap comment above `limitBody` in `server/src/app.ts` omits the revisions route's 256 KiB. The `chatOutput` payload (`src/ts/network/jobChannel.ts`) copies held chats with no projection refresh. `src/ts/plugins/apiV3/hostApiMemory.test.ts` reads `MEMORY_REFRESH_DEADLINE_MS` and `MEMORY_PROJECTIONS_PER_READ` out of `v3.svelte.ts` by regular expression.

**Why it matters:** a wrong actor in a rare notice, a stale comment, a stale payload, and a brittle test.
**Suggested handling:** a recovery wording, the comment in the next `app.ts` change, and moving the constants to `shared/structuredMemory.ts`.

### Rebuild lock refusal has no code

`server/src/jobs/generationJobs.ts` refuses a job during a rebuild with a plain-text 409, and the tab's `registryRefusal` knows only coded refusals, so a create retried after a lost answer shows the generic lost message. Slice 6b, by reading.

**Why it matters:** rare, and the panel shows the run anyway.
**Suggested handling:** give the refusal a code and words in `src/lang/en.ts`.

### Adopted summaries

Left by slice 6a. An adopted summary's `pinned` selects nothing in any lane (`adopt.ts` maps `isImportant` to it; `retrieve.ts` and `step.ts` never read it). A summary over the card budget is excluded while its messages still leave the prompt. A stored-stale adopted event kept by a person reads active while retrieval answers `not-relevant`, and a copy drops any event with an unanchored source.

**Why it matters:** an important HypaV3 summary stops being sent every time.
**Suggested handling:** decide what `pinned` means for an adopted event before changing the lanes.

### Highlight and revert leftovers

Left by slice 7b. `retract` stays in `MEMORY_HISTORY_CHANGE_KINDS`, `STRUCTURED_MEMORY_HIGHLIGHT_KINDS`, and the default `highlightKinds`, though only a restored entry can carry it and the settings offer no box. `mayCompact`'s `userCorrected` check is reached only by a disputed join, which `disputed` already refuses. A new page's receipt row has no highlight and no revert. Changing a chat's highlight mode moves `memorySettingsFingerprint`, so a queued writer input ends `skipped` (`staleInput`).

**Why it matters:** dead values and checks, and one lost queued run per mode change.
**Suggested handling:** drop `retract` with `normalizeStructuredMemorySettings` dropping a stored one; leave highlight out of the fingerprint if a replay may ignore it.

### Prompt test run leftovers

Left by slice 7c. `server/src/prompt/memory/structured/testRun.ts` is missing from `STRUCTURE.md`'s Path Ownership for structured-memory-writer, though the writer guide lists it. `TEST_REFUSALS.gap` is unreachable, since `jobMemoryBlockingReason` answers only `pluginModel` and `requestTrigger`. The result screen says "Outcome: Recorded" for a test that saved nothing.

**Why it matters:** misrouted questions, dead code, and a word that reads as a save.
**Suggested handling:** add the path, drop or narrow the record, and word the outcome for a test.

### Page tool leftovers

Left by slice 7d. `splitPage` and `splitTimeline` in `src/ts/process/structuredMemory.test.ts` are not whole package readers (key-line quote lines and collapsed headings break them); `parseMemoryPackage` is. `parseMemoryPackage` accepts `trashedAt` on a non-scene page, which the package never writes. `contents.trash` has no budget or expiry and the table of contents grows with it. `pages.test.ts` has no test of the page tools; they run only through `structuredMemoryRoutes.test.ts`.

**Why it matters:** test helpers that pass by luck, and a trash that only grows.
**Suggested handling:** test through `parseMemoryPackage`, drop `trashedAt` on import, and decide on a trash bound.

### Health badge leftovers

Left by slice 7e. `memoryHealthStates` (`src/ts/process/chatStatus.svelte.ts`) walks every character's chats on each recompute in three consumers (`Sidebar`, `MainMenu`, `DefaultChatScreen`). It does not exclude group chats, so a pinned group chat can show `customPrompt` though the writer refuses group chats (unconfirmed in a browser). The contents route calls `readHealth` with no byte budget.

**Why it matters:** repeated walks, and a badge on a chat the writer never serves.
**Suggested handling:** one shared derived, a group exclusion, and a budget on the contents read; measure first.

### Evaluation findings

Measured by slice 8 on scripted fixtures (`docs/audit/structured-memory-2026-11-03.md`); nothing was changed, and Q2 stays open until a real A/B.

- `MEMORY_CALL_OVERHEAD_TOKENS` (1,500) is low: overhead was about 2,100 per call in English and 2,800–3,700 in Korean, and actual analysis input was 1.13–2.32 times the preview. Proposal: 3,000, bytes÷3 kept, after a real-model check.
- `selectMemory` takes 520–584 ms on a 1,000-turn send, mostly tokenizing (296–356 ms) and cache reads; `addText`'s quadratic scan costs 60 ms at 4,000 texts.
- An unchanged checkpoint save holds about 500 ms on a 2,000-run chat. A hash cache is not worth it; dropping `input` from recorded runs is (whole-row readers not traced).
- `getChatFromIndex` over 67 or more loaded chats spends the shared per-IP authenticated bucket, and a neighbour route was refused until the reset (loopback surrogate only).
- `readHealth`'s page-byte budget bounds neither events nor runs: 635 ms for 64 chats of 5,000 each.
- At a 16k context the `threads` lane starves once events carry three quotes, and a two-event comparison loses one event in a long chat, also at 32k.

**Why it matters:** cost previews people pay by, and stalls on long chats.
**Suggested handling:** take each as a proposal when Structured Memory is next touched, and re-run `node util/memoryEval.mjs` after a read-path change.
