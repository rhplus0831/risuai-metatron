# Remote Host Plan audit, 2026-11-15

- Plan: `docs/plan/remote-host.md`
- Commit audited: `952c4baec` (`dev`), with the plan as an uncommitted draft in the working tree; the corrected plan is
  committed with this report
- Mode: `full`
- Model: GPT-6-Astra at `xhigh`, read-only, in place of the usual Sol session at the owner's request (the plan mixes
  server and tab work); report written by the session that drafted the plan (Claude Fable 5.2), before any plan-runner
  run

| Severity   | Count |
| ---------- | ----- |
| P1         | 6     |
| P2         | 7     |
| P3         | 5     |
| unverified | 1     |

Every finding is `fixed in plan`, except the part of N4 recorded as an accepted limit below. The audit ran as three
turns of one session (about 12.4 M tokens, 45 minutes). The first read the draft and found F1 to F10. The second read
the corrected plan: it confirmed F3 and F5 to F10, disputed F1, F2, and F4, and found N1 to N6 in the corrections. The
third read the second round: it confirmed N1, N3, N5, N6, and F4, and found M1 to M3. M1 to M3 were applied afterwards
and were not read again.

What the audit changed in the design:

- The draft put the remote branch in the chat screen (`sendChatMain`) and returned four result fields. The corrected
  plan puts it in `runSend`, under the local send reservation, with the sender's own flush before the post and the
  send's whole end returned (F1).
- The draft's relay had no way back into a command after `running`. The corrected relay keeps the body readable,
  notifies the target again on a re-post and on its registration, and treats a lost or forgotten command as uncertain
  (F2, N2, M2).
- Stop no longer depends on the host: the sender cancels the generation by its request id whenever the relay cannot
  certify that nothing ran (N2, M1).
- "No owner switch" became "no handoff is asked for": the absent-owner offer stays for host jobs (F4, N5). The
  auditor's suggested server-enforced no-handoff policy was not taken; it is in the plan's Not In This Plan.

The auditor's first-turn create matrix (a create by the host and one by the phone under the same request id, in each
order) found no path that appends the user message twice or reports a success that did not happen. The plan's Current
State cites it.

## P1

- **F1. The remote send needs the sender's whole send lifecycle.** Plan (Slice 4, draft): "`sendChatMain` then calls a
  remote send in place of `sendChat`" with its `finally` unchanged. Code: the duties being replaced sit below that
  call: `beginLocalSend` (`src/ts/process/index.svelte.ts:123`), the flush and the stale-chat refresh before a create
  (`src/ts/process/serverCommands.ts:1154`, `:1178`), the abort signal that hides the foreign Stop control
  (`src/lib/ChatScreens/DefaultChatScreen.svelte:1097`, `:1118`), `stopOverLoreBudget` and `loreStop` (`:1203`,
  `:837`), and a landed check that is not ordered against another tab's "ended" (`:867`). Correction: Slice 4's
  "The branch is in `runSend`", "Before posting", "What the adapter answers", and "Stop".
- **F2. The relay cannot reach its promised replay after `running` or an uncertain end.** Plan (Slice 1, draft): the
  body is readable "once the state is `queued` or `delivered`"; (Slice 3) a re-sent command "is a replay". Code: an
  unanswered create ends a send as `unknown`, unsettled, and uncertain (`src/ts/process/serverGeneration.ts:177`), which
  the draft stored as a final `ended`; `createSendDrafts` flips `requestUncertain` on a retry
  (`src/ts/process/sendDraft.ts:95`), so "the same body" could not hold. Correction: Slice 1's states (`uncertain`,
  the closed states, `attempted`), the readable body, the re-post, and Slice 3's "After a reload".
- **N1. The host's own run re-enters the remote adapter.** Plan (Slice 4, second draft): an eligible send "takes the
  remote path whenever remote sending is on"; Slice 3 calls `sendChat` with exactly the eligible fields. Code:
  `sendChat` always goes through `runSend` (`src/ts/process/index.svelte.ts:52`), and the two preferences are
  independent. Correction: Slice 3's "A local-only send" and the host-mode exclusion in Slice 4's "Eligible".
- **N2. A stop is stored, but nothing delivers it reliably.** Plan (Slice 1, second draft): a cancel after the read
  "gets `stopRequested`, and the target is notified". Code: a frame to a closed feed socket is dropped
  (`server/src/routes/events.ts:89`), `hello` replays no command, and the job socket is separate
  (`src/ts/network/generationJobs.ts:1003`), so the job goes on; a stop during the startup wait had no controller to
  abort. Correction: Slice 1's "Cancellation is sticky" and "On a host's registration", Slice 3's steps 1 to 4.
- **M1. The `stopped` refusal skips the cancel of an earlier attempt.** Plan (Slice 3, third draft): "`stopped` when
  the controller is already aborted". Code: for an attempted command the job may already run under a resumed follow
  that the new controller does not reach (`src/ts/process/serverCommands.ts:995`); `runServerJob` cancels by request id
  only when it is called with the aborted signal (`:1110`). Correction: an attempted command is never refused as
  `stopped` and goes on to `sendChat` with its aborted signal; the sender cancels by request id itself
  (`cancelGenerationRequest`, `src/ts/network/generationJobs.ts:578`).
- **M2. Forgetting an open command made an unknown-id cancel falsely definite.** Plan (Slice 1, third draft): an open
  command "is dropped" after 10 minutes, and a cancel of an unknown id leaves a `cancelled` entry. Code: a job runs up
  to `JOB_MAX_DURATION_MS`, 30 minutes (`server/src/jobs/generationJobs.ts:108`). Correction: the drop is at 40 minutes
  and tells the sender `forgotten`; an unknown-id cancel answers `fenced`, which certifies nothing.

## P2

- **F3. Fallback-off was bypassed with no host connected, and "definite" had two definitions.** Plan (Slice 4, draft):
  the branch ran only when "a host of that name is connected"; D3 allowed the fallback only when "the host never read
  the command", while Slice 3 refused after the read. Code: the non-remote path is the plain `sendChat`
  (`src/lib/ChatScreens/DefaultChatScreen.svelte:1197`). Correction: Slice 4's "Eligible" and "Definitely not run",
  and D3.
- **F4. Suppressing the preferred offer does not keep the job on the host.** Plan (Slice 2 and D1, draft): "a worker
  must not take a host's job". Code: `create` calls `armOffer` for every job
  (`server/src/jobs/generationJobs.ts:2505`, `:1258`), and absence counts from admission (`:2433`). Correction: D1 and
  the Current State entry "Absent offers do not depend on the preference".
- **F5. The exported deferred reload reports no completion.** Plan (Slice 5, draft): the host reports the end "when the
  load has applied". Code: `requestDeferredReload` returns nothing (`src/ts/plugins/plugins.svelte.ts:600`), a failed
  load is caught (`:652`), and `pluginsStarted` does not wait for a deferred load (`:673`). Correction: Slice 6's
  promise resolved by the satisfying load.
- **F6. Permission prompts do not inherit the job deadlines.** Plan (D9, draft): a prompt "expires by today's
  deadlines". Code: plugin consent awaits `alertConfirm` with no timer (`src/ts/plugins/apiV3/v3.svelte.ts:1118`,
  `src/ts/alert.ts:392`). Correction: D9 and the Current State entry "Dialogs".
- **N3. One request id can have two command bodies.** Plan (Slice 1, second draft): "another body is a 409". Code: the
  screen reads `inputOriginal` and `stopOverLoreBudget` again at each press
  (`src/lib/ChatScreens/DefaultChatScreen.svelte:816`, `:1203`) while the request id follows the text only
  (`src/ts/process/sendDraft.ts:95`); the auditor reproduced both with the real draft registry. Correction: Slice 1's
  "Identity".
- **N4. The send's end carries no error, and a joined resumed follow owns the reporting.** Plan (Slice 3, second
  draft): "the send's whole end". Code: `reportEnd` shows a job's error as a side effect
  (`src/ts/process/serverCommands.ts:982`), and `runServerJob` leaves `loreStopFollow` off when a follow already exists
  (`:1364`). Correction: Slice 3's "The failure comes back instead of a dialog". Accepted limit, stated in Slice 3's
  "After a reload": a re-run that joins a follow resumed after a host reload returns neither the failure text nor
  `loreStop`. Carrying the reporting into an existing follow would change every caller's follow for a case that needs a
  host reload during a job.
- **M3. A generic error on every result that is not `ok`.** Plan (Slice 4, third draft): show the failure text "or a
  line naming the host when the result has none". Code: a lore stop and a user's stop are not errors
  (`src/ts/process/serverCommands.ts:967`, `:979`). Correction: Slice 4's `done` branch shows an error only for a
  returned failure or the "shown by another follow" mark.

## P3

- **F7.** The slices named guides, not files, and 5 and 6 were called independent. Correction: each slice lists its
  files, Order lists the shared ones, and `shared/remoteCommands.ts` gets an ownership rule.
- **F8.** "A feed frame never carries chat text" is false for `change` frames (`shared/events.ts:112`), and the
  4096-byte cap is the incoming one (`server/src/routes/events.ts:76`). Correction: the Rules' first entry and the
  Current State entry on the feed.
- **F9.** "A host has no page state" (D10, draft): it has pending writes, job follows, and callbacks. Correction: D10.
- **N5.** "Answers its plugin callbacks from the first one" (Goal): a worker can take the job before the host's first
  attach. Correction: the Goal and D1; a manual check was added.
- **N6.** Two Sources paths were wrong (`src/ts/setting/displaySettingsData.svelte.ts`,
  `src/ts/setting/customComponents.ts`). Corrected.

## Unverified

- **F10.** The plan's account of the owner's lost plugin work. The code paths exist
  (`server/src/prompt/scripts.ts:305`, `server/src/prompt/runner.ts:2003`, `src/ts/network/jobChannel.ts:1245`), but
  the incidents were not reproduced and the plugin's source was not read. The Current State now says so, and the real
  plugin stays in the plan's Manual Checks.

## Re-check list

- `patchMessage` closes an open generation fence (`server/src/data/chatStore.ts:2537`, `:2568`): the plan patches no
  generated row.
- Feed rows are measured whole against `MAX_FEED_PATCH_BYTES`: an observer cannot assume a row arrives inline, which is
  why the sender reads the chat before answering a failed end.
- `STORE_TABLES_SQL` runs only on a fresh database (`server/src/data/resourceStore.ts:3855`): the plan adds no table.
- `sendText` counts any open socket as a delivery (`server/src/jobs/generationJobs.ts:1047`): the plan's rule that a
  command is `delivered` only by its target's read follows from it.
