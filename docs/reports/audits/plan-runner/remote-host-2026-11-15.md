# Remote Host Plan audit, 2026-11-15

- Plan: `docs/plan/remote-host.md`
- Commit audited: `952c4baec` (`dev`), with the plan as an uncommitted draft in the working tree; the corrected plan is
  committed with this report. The fourth and fifth turns read the plan at `3ff7eeea0` and its corrections in the
  working tree
- Mode: `full`
- Model: GPT-6-Astra at `xhigh`, read-only, in place of the usual Sol session at the owner's request (the plan mixes
  server and tab work); report written by the session that drafted the plan (Claude Fable 5.2), before any plan-runner
  run

| Severity   | Count |
| ---------- | ----- |
| P1         | 8     |
| P2         | 15    |
| P3         | 5     |
| unverified | 1     |

Every finding is `fixed in plan`, except the parts of N4 and R4 recorded as accepted limits below. The audit ran as
five turns of two sessions (about 17.4 M tokens, 75 minutes).

1. The first read the draft and found F1 to F10.
2. The second read the corrected plan: it confirmed F3 and F5 to F10, disputed F1, F2, and F4, and found N1 to N6 in
   the corrections.
3. The third read the second round: it confirmed N1, N3, N5, N6, and F4, and found M1 to M3.
4. The fourth, a new session at the owner's request, read the corrections for M1 to M3: it confirmed M3, disputed M1
   and M2, and found R1 to R5.
5. The fifth read the corrections for R1 to R5: it closed R1, R2, and R5, and found S1 to S5, all P2, in R3 and R4.
   The corrections for S1 to S5 were applied afterwards and were not read again.

Each correction round until the fourth added mechanisms and brought new defects with them. The fourth round's
corrections removed mechanisms instead (the host's own cancel, the relay's `fenced` entry, every branch on the
relay's cancel answer), and the fifth turn found no P1.

What the audit changed in the design:

- The draft put the remote branch in the chat screen (`sendChatMain`) and returned four result fields. The corrected
  plan puts it in `runSend`, under the local send reservation, with the sender's own flush before the post and the
  send's whole end returned (F1).
- The draft's relay had no way back into a command after `running`. The corrected relay keeps the body readable,
  notifies the target again on a re-post and on its registration, and treats a lost or forgotten command as uncertain
  (F2, N2, M2).
- Stop no longer depends on the host or on the relay. At every Stop the sender posts the relay cancel and, without
  waiting for it, resolves the request id through the local send path with an aborted signal, which cancels the
  generation by its request id and consumes the answer. The relay's cancel answer certifies nothing and is not read;
  an unknown-id cancel stores nothing; a late post is refused by the generation's tombstone at the host's create (N2,
  M1, M2, R1 to R3, S1, S2).
- The host returns a send's reports, not only its job's error: the refusals before and at admission, the job's error,
  and the notices of a `done` (skipped hooks, missed listeners), with a settled and with an unsettled end (N4, M3,
  R4, R5, S3 to S5).
- The sender's post carries its own uncertainty, so a relay that forgot a command cannot make a retry look like a
  first attempt (R2).
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
  `stopped`; the sender cancels by request id itself (`cancelGenerationRequest`,
  `src/ts/network/generationJobs.ts:578`). The first correction also sent the host on to `sendChat` with its aborted
  signal; R1 withdrew that.
- **M2. Forgetting an open command made an unknown-id cancel falsely definite.** Plan (Slice 1, third draft): an open
  command "is dropped" after 10 minutes, and a cancel of an unknown id leaves a `cancelled` entry. Code: a job runs up
  to `JOB_MAX_DURATION_MS`, 30 minutes (`server/src/jobs/generationJobs.ts:108`). Correction: the drop is at 40 minutes
  and tells the sender `forgotten`; an unknown-id cancel certifies nothing. The first correction kept a `fenced` entry
  for it; R3 removed the entry, and the answer is a 404 `unknownCommand`.
- **R1. The host's promised cancel sits behind guards that return without cancelling.** Plan (Slice 3, fourth draft):
  an attempted command "goes on to step 6 with its aborted signal, and `runServerJob` cancels the earlier request".
  Code: `runSend` returns at a chat that is not listed and at a send of this tab in the chat before
  `sendChatOnServer` (`src/ts/process/index.svelte.ts:111`, `:123`), and the cancel is installed only inside
  `runPinnedServerJob` (`src/ts/process/serverCommands.ts:1110`). Correction: the host promises no cancel. An attempted
  command gets no certificate and, when stopped, starts nothing; the sender's two Stop requests start at once.
- **R2. A forgotten command posted again loses its attempt, and a queued cancel then certifies "nothing ran".** Plan
  (Slice 1 and Slice 4, fourth draft): "the read's answer carries `attempted`"; "An answer of `cancelled` ends the send
  as definitely not run". Code: a job's 30 minutes count from its admission, not from the relay's last state change
  (`server/src/jobs/generationJobs.ts:2400`, `:2421`), and the local path keeps an earlier uncertainty only through
  `requestUncertain` (`src/ts/process/index.svelte.ts:112`, `src/ts/process/serverCommands.ts:1120`). Correction: the
  post carries `uncertain`, which sets `attempted`; Stop does not read the relay's answer; the 40 minutes are named as
  housekeeping.

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
- **R3. A `fenced` id had no retry outcome and no lifetime.** Plan (Slice 1 and Slice 4, fourth draft): an unknown-id
  cancel "leaves a `fenced` entry"; the sender "waits for the host's closed state". Code: the generation cancel already
  answers what the relay could not: no job leaves a tombstone and a settled refusal, after which the draft takes a new
  request id (`server/src/jobs/generationJobs.ts:2651`, `src/ts/process/serverCommands.ts:1247`,
  `src/ts/process/sendDraft.ts:102`), and a create behind the tombstone answers 409 `requestCancelled` (`:2347`).
  Correction: no `fenced` entry; Slice 4's Stop takes the local path's result as the send's end.
- **R4. Only a follow's error was returned, so a refusal before or at admission was silent on the phone.** Plan
  (Slice 3, fourth draft): "A send gains an option that returns that text in its end". Code: `runServerJob` alerts
  those refusals itself (`src/ts/process/serverCommands.ts:1129` to `:1201`, `:1283` to `:1336`). Correction: Slice
  3's "Reports come back instead of being shown"; a refusal inside `done` restores the draft and never starts the
  fallback. Accepted limit, in Slice 3's "A job of another creator": the replay of an ended job that another client
  created returns no terminal (`:1257`), so it has no report.
- **R5. Skipped-hook and missed-listener notices had no way to the phone.** Plan (Slice 4, fourth draft): "With `ok`
  true it is passed on at once". Code: `reportEnd` raises them as one toast on a `done`
  (`src/ts/process/serverCommands.ts:984`). Correction: reports are `error` or `notice`, and the sender shows the
  notices first, whatever `ok` is.
- **S1. A Send after an uncertain Stop could get the retained `cancelled` state, which no branch handled.** Code: an
  unanswered cancel leaves the draft its request id (`src/ts/process/serverGeneration.ts:177`,
  `src/ts/process/sendDraft.ts:111`). Correction: a post of a command closed as `expired`, `cancelled`, or `refused`
  replaces it as a new command.
- **S2. The Stop text told a running job from an ended one, which the local path's result does not.** Code: a foreign
  replay returns `requestUncertain` for "not reconciled or running" alike (`src/ts/process/serverCommands.ts:1260`).
  Correction: the adapter takes `settled` and `requestUncertain` as returned; anything unsettled waits for the host's
  closed state.
- **S3. The reports of an unsettled end were collected and never shown.** Code: an attempted send's preflight refusal
  is unsettled (`src/ts/process/serverCommands.ts:1120`, `src/ts/process/serverGeneration.ts:163`). Correction: the
  `uncertain` state carries the result, and the sender shows its reports once without settling the send.
- **S4. A blocked flush shows its notice below `runServerJob`, which then alerts nothing.** Code:
  `showGeneratingNotice` (`src/ts/storage/resourceSync.svelte.ts:4324`) and the skipped alert
  (`src/ts/process/serverCommands.ts:1167`). Correction: the option returns the blocked flush as an error anyway; the
  save layer's notice stays on the host.
- **S5. Dropping the "stopped elsewhere" toast hid a stop by a third device.** Code: a foreign Stop is attributed to
  its device (`server/src/jobs/generationJobs.ts:2548`), and a cancel by request id sets no such attribution
  (`:2635`). Correction: the toast is collected as a notice, and the sender does not show the host's notices for a
  send it stopped itself.

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
