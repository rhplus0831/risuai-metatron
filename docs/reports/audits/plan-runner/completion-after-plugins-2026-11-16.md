# Completion Notification After Plugin Work Plan audit, 2026-11-16

- Plan: `docs/plan/completion-after-plugins.md`
- Commit audited: `f21882495` (`dev`), the commit that added the plan; its code is that of `721e6ead1`. The corrected
  plan is committed with this report
- Mode: `full`
- Model: GPT-6-Astra (`xhigh`), read-only, chosen over Sol because the plan changes `server/` and `shared/` contracts;
  report written by the session that drafted the plan (Claude Fable 5.2), before any plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 6     |
| P2         | 3     |
| P3         | 2     |
| unverified | 0     |

All eleven findings are `fixed in plan`. No P1 is open. A1 to A6 came from the first turn. The second turn read the
corrections on disk, confirmed A2 and A6, and found B1 to B4 in the corrections for A1, A3, and A4. The third turn
confirmed B1 to B3, A1, A3, and A5, and found C1 in the correction for B4. The fourth turn confirmed C1 and gave every
finding its final status, with two wording notes that are in the plan.

Astra changed no file in the repository and ran no test, type check, build, server, or browser: the audit is a reading
of the code. During the second turn the read-only check reported a changed git state with no changed path; it was
another session's branch (`claude/remote-memory-indicator-layout-7c5681`) moving, not this checkout's `HEAD` or tree.
The four turns took about 31 minutes and 15.7 M tokens.

Found consistent: the tail's order (`runChatOutputListeners` awaited at `server/src/prompt/runner.ts:2054`, the
notification at `:2424`, `done` only after `runPromptSend` returns at `:373`), the push not awaited (`:1200`), the
notification repeated per speaker and per sequence part (`:675`, `server/src/jobs/commandRunner.ts:345`) and never for a
preview (`runner.ts:1874`, `:1929`); a command sequence's part keeping unnamed context fields (`commandRunner.ts:334`);
`parseCreateBody` rebuilding the context field by field and keeping `stopOverLoreBudget` for every kind
(`server/src/routes/generations.ts:236`, `:257`), `requestFingerprint` leaving auxiliary context out
(`server/src/jobs/generationJobs.ts:396`), a retry replaying the first job before admission (`:2340`), the context
cloned whole at admission and passed whole to the runner (`:2411`, `:2054`), and no other whitelist the new field would
be lost in (receipts and statuses carry no context); `lookupRequest` covering live jobs, ended ones, kept outcomes,
cancellation marks, and receipts without cancelling or creating work (`:2594`); the cancel route's JWT, limiter, and
epoch check through the registry, and `/stop` having no creator check either (`routes/generations.ts:341`, `:391`,
`generationJobs.ts:2631`, `:2548`); `PushService.send` needing only a stored notification, its limit of four sends with
the one in delivery, and topics replacing an undelivered notification per chat (`server/src/push/pushService.ts:522`,
`:630`, `:34`, `:311`); `beginShutdown` able to close the holds before `push.close()` and the registry built before the
push service (`server/src/app.ts:670`, `:438`, `:553`); the host's request id passed unchanged to the job for a plain
send, a Continue, a reroll, and an uncertain retry (`src/ts/network/remoteHost.ts:464`,
`src/ts/process/serverGeneration.ts:142`, `src/ts/process/serverCommands.ts:1300`), `sendChat`'s result and `onEnd`'s
`settled` telling the three cases apart (`src/ts/process/index.svelte.ts:154`, `serverGeneration.ts:177`), the
generation module already in `loadTransport` (`remoteHost.ts:92`), and `remoteSend.ts` building its relay options
explicitly (`src/ts/network/remoteSend.ts:453`); `SandboxHost.isIdle` and its settlement reports for host calls,
callbacks, streams, and termination (`src/ts/plugins/apiV3/factory.ts:596`, `:1081`, `:1185`, `:849`, `:1294`), a job's
own `chatOutput` and script callbacks counted through the sandbox's callback registry
(`src/ts/plugins/apiV3/v3.svelte.ts:2578`, `factory.ts:726`), and both host-hook sites having the plugin's name
(`v3.svelte.ts:2584`, `:2719`); extra plugin fields surviving client validation, server normalization, boot, live
updates, backups, and the upstream round trip (`src/ts/storage/collectionStore.svelte.ts:383`,
`server/src/data/kinds.ts:150`, `src/ts/bootstrap.ts:267`), `loadSignature` being name, script, and `allowedIPC`
(`src/ts/plugins/plugins.svelte.ts:485`), and the whole-record conflict policy (`src/ts/storage/recordMerge.ts:73`);
`ui` as the section of the time limit, its model `contextMeterFixedWarn`, and the tripwire tests
(`shared/sections.ts:191`, `server/src/data/normalize/ui.ts:163`, `src/ts/storage/tests/presetSchema.test.ts:672`);
the settings page writing the live entry, `CheckInput`, `NumberInput`, and the declarative `"number"` item
(`src/lib/Setting/Pages/PluginSettings.svelte:186`, `src/ts/setting/types.ts:39`,
`src/ts/setting/displaySettingsData.svelte.ts:509`, `:646`); the Asset Maid claims (`save/Asset Maid 0.9.90.1.js:4`,
`:43`, `:338`, `:12403`); the mutation scope as two counters that an ordinary successful send does not move
(`src/ts/storage/resourceSync.svelte.ts:5787`, `src/ts/network/jobChannel.ts:1292`); the file lists, the guide ownership
of every touched and new path, and the Order section's claims.

Re-check list: the plan depends on none of the four mechanisms. `patchMessage` still reaches `closeFence`
(`server/src/data/chatStore.ts:2553`, `:2569`), which a plugin's chat write already uses; feed rows are measured whole
(`server/src/data/chatStore.ts:1911`, `:1927`); `STORE_TABLES_SQL` runs for schema version zero and a new validated
store (`server/src/data/resourceStore.ts:3856`, `:792`); `sendText` counts the sockets whose frame admission succeeds
(`server/src/jobs/generationJobs.ts:1047`, `:1062`), while the plan relies on the callback's answer, not on that
delivery.

## P1

### A1 — Goal, Slice 3: quiet plugins do not mean the phone can read their writes — fixed in plan

- Plan (Goal): "the reply the phone then opens is complete". And Slice 3: "the send returned true:
  `waitForPluginsQuiet(targets, { capMs })`, then the release".
- Code: `setChatToIndex` applies the edit to the tab's copy and returns (`src/ts/plugins/apiV3/v3.svelte.ts:3200`,
  `:3221`); the edit queues a save (`src/ts/storage/chatStore.svelte.ts:4763`, `:3947`) and the sandbox reports the
  call settled (`src/ts/plugins/apiV3/factory.ts:1185`). The save runs on its own schedule and a failed batch is put
  back with a growing wait (`src/ts/storage/resourceSync.svelte.ts:6062`, `:3122`, `:3162`, `:3037`). Two failed
  attempts leave a four-second wait, longer than the default quiet time, so the release could be sent while the server
  still has the message without the image.
- Correction, confirmed (with B1 and B2): after the quiet moment the host flushes its pending saves under a mutation
  scope taken before the send and releases only on a clean result with the plugins still quiet (Slice 3, D12).

### A2 — Slice 2, D10: the carry-over in `importPlugin` misses the plugin API's replacement — fixed in plan

- Plan (Slice 2): "`importPlugin` copies the two fields from the same-name entry it replaces into the new entry."
- Code: the plugin API's `setDatabase({ plugins })` validates the entries, asks the owner to confirm a changed script
  (`src/ts/plugins/plugins.svelte.ts:804`, `:816`), and passes the supplied object to `upsertPlugin`
  (`src/ts/plugins/apiV3/v3.svelte.ts:2496`, `:2261`), which replaces the installed entry whole
  (`src/ts/storage/collectionStore.svelte.ts:411`). `importPlugin` never runs on that path.
- Correction, confirmed: `upsertPlugin` itself gives the entry it installs the two fields of the entry it replaces and
  strips them from an entry that replaces nothing. Its two callers are the two replacement paths
  (`plugins.svelte.ts:420`, `v3.svelte.ts:2263`); backups, imports, and boot do not pass through it and keep what they
  store.

### A3 — Slice 3: after a handoff the creating host releases on the wrong sandbox — fixed in plan

- Plan (Slice 3): "the send returned true: `waitForPluginsQuiet(targets, { capMs })`, then the release".
- Code: `noHandoffPreference` only removes the preference from the create body
  (`src/ts/process/serverCommands.ts:1301`); the server still accepts a requested handoff and opens one after the
  owner's absence (`server/src/jobs/generationJobs.ts:2973`, `:1258`). `switchOwner` moves the old owner's sockets to
  viewers and the callback channel to the new owner (`:1326`, `:1335`, `:1348`). A viewer still gets the terminal
  (`:1030`), and the host's follow maps it to a successful, settled send (`src/ts/process/serverCommands.ts:867`,
  `src/ts/process/serverGeneration.ts:213`). The host would then wait on its own idle plugins and release while the new
  owner's plugin still works.
- Correction, confirmed (with B3): the server refuses the release of a job that ever changed owner; its notification
  goes out at the deadline (Slice 1, D13).

### B1 — Slice 3 (correction for A1): work can start during the flush without a report — fixed in plan

- Plan (first correction): "Resolved with nothing `refused` and no activity report of a target since the quiet moment:
  the release."
- Code: a host call raises the pending count when it starts (`src/ts/plugins/apiV3/factory.ts:1135`) and reports only
  when it settles (`:1161`, `:1185`). A call that starts while the flush awaits a batch
  (`src/ts/storage/resourceSync.svelte.ts:5922`) and is still pending at its end leaves no report, with `isIdle` false
  (`factory.ts:596`).
- Correction, confirmed: the listener stays on through the flush, and the release also needs every target not busy at
  that moment; otherwise the wait goes back to the quiet wait with what is left of the time limit.

### B2 — Slice 3 (correction for A1): a clean-looking flush can have discarded the write — fixed in plan

- Plan (first correction): "`flushResources` resolves once the changes pending at its call are saved" and "Resolved
  with nothing `refused` … the release."
- Code: a plugin's message rewrite is a queued `patchMessage` (`src/ts/storage/chatStore.svelte.ts:3940`). When the
  server owns that message for another generation, conflict recovery drops the edit and records it as discarded
  (`src/ts/storage/resourceSync.svelte.ts:4271`, `:4312`, `chatStore.svelte.ts:6465`, `:6651`, `:6683`), and the flush
  resolves with the key in `discarded` and nothing in `refused` (`resourceSync.svelte.ts:6000`;
  `src/ts/storage/tests/resourceSyncHydration.test.ts:1235`). A flush without a scope does not report a discard from
  before its call.
- Correction, confirmed: the run takes a `beginMutationScope()` mark before `sendChat`, the flush gets it, and an
  early release needs `discarded` and `refused` both empty. An ordinary successful send moves neither counter
  (`resourceSync.svelte.ts:5787`, `src/ts/network/jobChannel.ts:1292`, `:1305`,
  `src/ts/process/serverCommands.ts:1198`), so the time limit stays the exception.

### B3 — Slice 1 (correction for A3): the current owner does not say whether the job ever left — fixed in plan

- Plan (first correction): "`handedOff` being an `ownerClientId` that is not the creator".
- Code: the creator can take a job back (`server/src/jobs/generationJobs.ts:2715`;
  `server/src/tests/generationJobs.test.ts:2672`), after which `ownerClientId` equals `clientId` and the status no
  longer says `handedOff`, while the other owner's detached plugin work may still run. Kept outcomes are capped at 500
  (`generationJobs.ts:2677`); past the cap the lookup falls back to a receipt, which has no owner
  (`server/src/data/generationReceipts.ts:28`).
- Correction, confirmed: the registry latches `everHandedOff` in `switchOwner`, the one place the owner changes
  (`generationJobs.ts:1335`), keeps it in the kept outcome (`:2667`), and answers a receipt-only lookup with null. The
  statuses' current-owner `handedOff` (`:2702`) is left as it is.

## P2

### A4 — Slice 3, D5, D7: the timing claims contradict the tail and the host's cleanup — fixed in plan

- Plan (Slice 3): "The run reports `done` or `uncertain` and releases its holds exactly as today. Then, detached from
  the run…". D5: "a slow tail may send a few seconds before the host's own cap". D7: "Every held notification is
  therefore late by at least the longest quiet time".
- Code: the notification precedes the image-view callback, which has 300 s (`server/src/prompt/runner.ts:2424`,
  `:2492`, `:1070`), so a deadline counted from the notification could pass before the send returned. The run's
  `finally` awaits the report pump before it releases the chat pin (`src/ts/network/remoteHost.ts:499`, `:232`), and
  the pump retries for the open-command lifetime (`:299`, `shared/remoteCommands.ts:16`), so a wait started after that
  cleanup would not start at the send's end. A time limit shorter than a quiet time and the failed-and-settled branch
  also break D7's "every".
- Correction, confirmed (with B4 and C1): the wait starts where the terminal report is queued and waits for no report;
  the deadline counts from the job's end in the registry; D5 and D7 are reworded.

### B4 — Slice 1 (correction for A4): the safety deadline took a per-part limit for a total — fixed in plan

- Plan (first correction): "a safety deadline of `maxRunMs + holdMs` from its first hold".
- Code: `JOB_MAX_DURATION_MS` bounds a job or each part of a command sequence
  (`server/src/jobs/generationJobs.ts:107`); `beginPart` resets the clock (`:2226`, `:3214`). Two later parts of twenty
  minutes each outlast the safety deadline while the sequence still runs (`server/src/jobs/commandRunner.ts:345`); 64
  parts are allowed (`shared/jobs.ts:454`).
- Correction, confirmed: no timer runs while the job does.

### C1 — Slice 1 (correction for B4): the runner's `finally` is not the job's end — fixed in plan

- Plan (second correction): "`createGenerationRunner` calls it in a `finally` around the job's run … No timer runs
  before it: the run always ends".
- Code: the registry invokes the runner as a separate promise (`server/src/jobs/generationJobs.ts:2312`) and ends a job
  by force after an abort's grace (`:1897`, `:1760`, `:1837`), for the time limit and for maintenance too (`:3214`,
  `:2957`), without settling the runner (`server/src/tests/generationJobs.test.ts:1577`). In the default runner an
  Echo request sleeps without the signal (`server/src/llm/request.ts:1165`, `server/src/llm/util.ts:4`), so a runner
  can outlive its ended job by the rest of that delay, and a hold would have no deadline meanwhile.
- Correction, confirmed: the registry's `finalize`, which every end reaches and which ignores a second call (`:1729`,
  `:2074`, `:2313`), starts the deadline through a new option (not `onChatJobDone`, `:1839`); `jobEnded` does not
  restart on a second call. A forced end follows an abort (`:1897`, `:1901`), and the runner holds only while the
  job's signal is not aborted. A Stop before the notification ends the tail at its abort check
  (`server/src/jobs/runSetup.ts:333`, `server/src/prompt/runner.ts:2371`), so that guard has no ordinary path and the
  plan's test sentence says what such a Stop does instead.

## P3

### A5 — Slices 1 to 3: files and test homes the lists left out — fixed in plan

- Plan: the slices' Existing lists and test sentences.
- Code: the typed mock of the generation module needs the new export
  (`src/ts/network/tests/generationJobsMock.ts:119`, `:156`); the plugin API declares its own `RisuPlugin`
  (`src/ts/plugins/apiV3/risuai.d.ts:290`); the normalization table's ordinary number `7` is below the new minimum
  (`server/src/tests/normalizeSections.test.ts:140`); the prompt-tail job helper has no top-level `requestId`
  (`server/src/tests/promptTail.test.ts:373`, `:394`); `serverGeneration.test.ts` mocks `runServerJob` (`:40`), so the
  create body is asserted in `src/ts/network/generationJobs.test.ts`; `plugins.test.ts` mocks the v3 API (`:45`), so
  the `setDatabase` regression belongs in `src/ts/plugins/apiV3/v3SetDatabase.test.ts` (`:57`).
- Correction, confirmed: the lists and test sentences name these. `remoteHost.test.ts` already mocks the resource-sync
  module in part (`:59`), so the flush needs no new factory, and slices 1 and 2 still share no file.

### A6 — Current State: `setChatToIndex` is not synchronous — fixed in plan

- Plan: "A synchronous host call (`setChatToIndex`) counts only while it runs."
- Code: it is `async` and awaits the write permission and the chat's load before the edit
  (`src/ts/plugins/apiV3/v3.svelte.ts:3200`, `:3210`, `:3216`); the sandbox awaits its result
  (`src/ts/plugins/apiV3/factory.ts:1161`).
- Correction, confirmed: Current State says what the call's settlement covers and that the save is separate.

## Noted, not changed

- A release may precede a later speaker's hold; that hold waits for another release or its deadline, as the plan says.
- More than four sends at once are dropped by the push service; a burst of releases shares that limit (Not In This
  Plan).
- A held notification can outlive a restore: maintenance does not close the push service
  (`server/src/jobs/generationJobs.ts:2957`, `server/src/app.ts:686`). D5 already sends at the deadline after a host's
  epoch loss.
- A halt found by the feed or the save loop does not set the host's own `epochHalted`
  (`src/ts/network/remoteHost.ts:165`); the wait then lives until the flush rejects or the time limit passes, and its
  release carries the old epoch, which the server refuses.
