# Generation Progress Window Plan audit, 2026-11-14

- Plan: `docs/plan/generation-progress-window.md`
- Commit audited: `31a39b8ad` (`claude/message-send-progress-display-1fe737`, on `dev` at `d2d1a76a7`); the corrected
  plan is committed with this report
- Mode: `full`
- Model: GPT-6-Astra (`xhigh`), read-only, in place of the usual Sol session because slices 1, 2, and 4 cross the
  shared feed and job contracts, the server's registry and runner, and the tab; report written by the session that
  drafted the plan (Claude Fable 5.2), before any plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 1     |
| P2         | 4     |
| P3         | 6     |
| unverified | 0     |

All eleven are `fixed in plan`. AUD-1 to AUD-8 came from the first turn; the drafting session read each against the
code before editing. Astra then read the corrected plan in the same session: it confirmed AUD-1, AUD-3, and AUD-5 to
AUD-8 and the supplementary corrections taken from its notes, disputed the wording of AUD-2 and one omitted reset path
of AUD-4, and found AUD-9 to AUD-11 in the corrections. The AUD-2 and AUD-4 wording and AUD-9 to AUD-11 were applied
afterwards and were not read again. No P1 is open.

Two corrections are decisions, not wording. The owner accepted both on 2026-11-14, after reading these findings:

- AUD-1 is not fixed the way Astra first suggested (normalizing the string stream where the job reads it). The plan
  never forces that format to stream instead (D26), and the existing defect with Response Streaming on is filed as a
  found issue.
- AUD-2 is not fixed by reproducing the buffered reply steps after a quiet stream. The plan states that a reply Half
  Streaming streams is processed as a streamed reply (D25), which narrows "everything else is as today" for users who
  turn the setting on.

Astra changed no file in the repository (`git status` showed only the plan, edited by the drafting session; its
content hash was unchanged through the second turn). It ran existing tests through the wrapper: 417 passed and 1
skipped over seven files and 441 passed over eleven files in the first turn (the two runs overlap), and 287 and 184
passed in the second. It ran scratch probes against the current code: the real `requestOobaLegacy` adapter buffered
and forced, read by the unchanged `readReply`; the real chat store taking an `accepted` at sequence 0 and whole-row
final patches, for a new reply, a continue, and a group's second speaker; the Claude outer request path with and
without `forceStreaming`, with a tool offered and a banned script set; the plugin callback's arguments with and
without the flag; and the Claude batch path with streaming off. The probes and their output are in
`/home/codex/review-reports/generation-progress-window-audit-2026-11-14/scratch/`, with Astra's two answers beside
them. None of the probes implements the plan. The full suite, the type and format gates, anything in a browser, and
a real provider were not run. The two turns took 36 minutes and about 20.8 M tokens.

Found consistent: the four stages and their path from `reportStage` to the owner's ring (`shared/jobs.ts:216`,
`runner.ts:304`, `generationJobs.ts:2029`, `jobStages.ts:39`, `DefaultChatScreen.svelte:1447`), with the Stop-other
ring plain (`:1494`); the read-only slot lookup and the creator's identity it compares (`generationJobs.ts:2415`); the
feed's process-local frames, best-effort publication, and measured fan-out (`changeFeed.ts:41`,
`generationJobs.ts:1092`, `events.ts:102`, `:139`), with the hello samplers taken synchronously before registration
(`events.ts:207`); an unknown frame type and an unread `hello` field ignored by the current tab (`eventFeed.ts:215`,
`:394`; the existing test at `eventFeed.test.ts:191`); `retire()` as the one place every ended connection passes
(`eventFeed.ts:230`); D21, the quiet stream at sequence 0: `cover()` and `finalize` test `!== undefined`
(`runner.ts:1073`, `:1357`), only a `raw` watermark becomes a `streamed` row reference (`generationJobs.ts:1428`), the
stored watermark 0 covers the tab's held sequence 0 (`chatStore.svelte.ts:2687`, `:2735`), the final hydration retires
the generation and releases the locks (`:2664`), and no code after the stream switches on a zero sequence; the
reply-only placement of `forceStreaming` (`runner.ts:1826`, `llm/request.ts:534`), with `escape` clearing it
(`outer.ts:133`); the local count, feasible with the tokenizer choice at `tokens.ts:247` and both caches bypassed, the
runner already holding `tokenScopeFor` (`runner.ts:94`, `:1640`); the Stop-other handler reading the slot again and
confirming (`DefaultChatScreen.svelte:1488`, `serverCommands.ts:267`), and marks leaving `isChatBusy` alone
(`chatStatus.svelte.ts:79`); `generationClientId()` and `connectedClients` (`generationJobs.ts:251` in the tab,
`handoff.ts:65`); every test file and guide heading the slices name; and the serial order.

Re-check list: `patchMessage` still closes an open fence (`chatStore.ts:2568`), so a quiet stream's final write must
stay a generation-authorized `setText` or `setMessage`; feed rows are still measured whole (`chatStore.ts:1908`);
`STORE_TABLES_SQL` still runs only on a fresh database (`resourceStore.ts:3860`), the other use being a new staging
database (`:798`), and this plan adds no table. The fourth entry's wording is stale, as earlier reports found:
`sendText` is true when a socket took the frame (`generationJobs.ts:1024`, `:1042`), which is queueing and not an
acknowledgment.

## P1

### AUD-1. Forcing the legacy Ooba adapter to stream loses the reply (fixed in plan, D26, which the owner accepted)

- Plan (slice 4, as audited): "A quiet send passes `forceStreaming: true` with the reply request."
- Code: `mancer` resolves to `LLMFormat.OobaLegacy` (`shared/llm/models.ts:175`). Forcing reaches its streaming branch
  (`server/src/llm/request.ts:534`, `:958`), which enqueues its cumulative text as a string (`:1022`); the job's
  wrapper forwards it unchanged (`requests.ts:1114`). `readReply` indexes the value's first key (`runner.ts:2489`), so
  `"Hello world."` reads as `"H"`, the tail writes that (`:2077`), and the other characters become alternative samples
  (`:2080`, stored at `:1340`). The probe showed exactly this with the real adapter and reader. The same misread
  happens today with Response Streaming on; Half Streaming would have brought it to users who keep streaming off.
- Old: "a send is quiet when `db.useStreaming` is off, `db.halfStreaming` is on, and the job is not a `previewPrompt`."
- New: "... the job is not a `previewPrompt`, and the reply's model (`resolveJobRequestModel`) is not of
  `LLMFormat.OobaLegacy` (D26)." Current State records the string stream, D26 the decision, Not In This Plan the
  deferred fix, and slice 4 a test that such a reply never sets `forceStreaming`.
- Re-check: confirmed. `resolveJobRequestModel` is already called before the request (`runner.ts:1639`, `:1821`) and
  its result carries the format when resolution succeeds. Every other stream a forced reply can reach is a keyed map
  (OpenAI Chat and Responses with their tool wrappers, Google and Vertex, Claude HTTP and batch, Ollama, and the plugin
  bridge, which converts text to a one-key map at `requests.ts:874`). No string stream is newly exposed with Response
  Streaming off.

## P2

### AUD-2. Forcing a stream changes how the reply is processed (fixed in plan, D25, which the owner accepted)

- Plan (Goal, as audited): "Everything else is as today."
- Code: `requestChatDataOuter` runs the after-request hook and the banned-character-set check and retry only on a
  buffered `success` (`outer.ts:189`, `:193`). The buffered branch processes every alternative sample
  (`runner.ts:2117` to `:2186`); the streaming branch copies them from the last chunk (`:2080`). Claude's buffered JSON
  extraction (`anthropic.ts:1252`) has no counterpart in its streaming parser. The probe returned `HOOK:Reply` buffered
  and `Reply` forced.
- New: D25 and a Current State entry say a reply Half Streaming streams is a streamed reply in everything but its
  visible partial text; the setting's help text names the replacers and the retry.
- Re-check: mechanism supported, wording disputed (AUD-10), and the list not exhaustive. D25 now also names: no request
  restart after the stream is returned and stream errors that become reply text (`outer.ts:211`, `runner.ts:2053`,
  `anthropic.ts:1064`, `openAI/responses.ts:685`); trimming before the output scripts and a continue processed once as
  the combined text (`runner.ts:2490`, `:2083`, `:2121`); and reasoning wrapped as the streaming parsers do
  (`openAI/requests.ts:1165`, `:759`). Not read again.

### AUD-3. The stop and restart description did not hold for rerolls and continues (fixed in plan)

- Plan (D23, as audited): "A stop during a quiet stream keeps the text so far, as a stream does. A server restart
  during one leaves the empty reply row and loses the text."
- Code: an in-place reroll restores its previous candidate when interrupted (`runner.ts:1410`, `:2058`, `:1307` to
  `:1317`; the existing test at `promptRunner.test.ts:2745`). A continue accepts its stored text first (`:1481`) and
  reuses it as the prefix (`:2003`). A graceful shutdown aborts and drains the jobs (`main.ts:115`, `app.ts:668`,
  `:1227`), so the ordinary finalization runs inside the grace.
- New: Current State, slice 4's branch text and tests, the manual checks, and D23 distinguish a new reply, a continue,
  and an in-place reroll, and a graceful shutdown from a process lost without its grace.
- Re-check: confirmed.

### AUD-9. An epoch mismatch found by a reconciliation read cleared nothing (fixed in plan)

- Plan (slice 3, after the first corrections): "The set is cleared where the memory tasks are reset for a `hello` or
  `epoch` frame of another epoch, and in `retire()`."
- Code: a reconciliation read can find another epoch (`resourceClient.ts:104`, `:325`). `reconcile` catches
  `ResourceEpochMismatchError`, clears the advertised map and the memory tasks, and returns (`eventFeed.ts:376` to
  `:379`) without retiring the socket; the restore halt waits before it reloads (`resourceSync.svelte.ts:3574`). A set
  filled by the `hello` would keep counting until then. Existing tests show the socket stays open
  (`eventFeed.test.ts:412`) and that a replaced connection's late read still resets (`:635`).
- New: "The set is cleared at every place the memory tasks are reset for another epoch (`resetMemoryTasks`: the
  `hello` and `epoch` frames of another epoch, and the `ResourceEpochMismatchError` catch in `reconcile` ...), and in
  `retire()`", with a test of that read in `eventFeed.test.ts`. Not read again.

### AUD-10. The help text and a manual check contradicted the buffered fallbacks (fixed in plan)

- Plan (slice 4, after the first corrections): help "... is handled as a streamed reply: plugins' after-request
  replacers and the banned-script retry do not run"; manual check "with Half Streaming on neither runs".
- Code: a forced request that answers buffered keeps its processing. Claude with tools overrides streaming
  (`anthropic.ts:104`), returns a buffered success (`:1258`), and runs the hook and the retry (`outer.ts:189` to
  `:207`); the runner takes the buffered branch (`runner.ts:2110`). The probe saw two buffered requests, two hook
  calls, and a retry.
- New: the help says a streamed reply is handled like one with Response Streaming on and a model that answers without
  streaming is handled as usual; the manual check verifies both; D25 opens with the same distinction; slice 4 tests a
  quiet send whose request answers buffered. Not read again.

## P3

### AUD-4. Registry publication points and the epoch rule were imprecise (fixed in plan)

- Plan (slice 1, as audited): "when a job is admitted (the step that sets `startedAt`) ... (where it sends the job
  socket's `stage`, `retry`, and `sequence` events) ... an epoch change clears the registry's memory."
- Code: admission samples the time at `generationJobs.ts:2292` and registers at `:2378`; a repeated stage returns
  early (`:2030`) and a changed one clears the retry count after its send (`:2035`); sequence state changes in
  `sequence.progress` (`:2126`), first set from `commandRunner.ts:302`; an epoch change clears kept outcomes and the
  request index (`:2455`), not the `jobs` map (the test at `generationJobs.test.ts:1726` keeps an old-epoch ended job).
- New: publish once registered and before the runner starts; one publication per stage report after its retry clear;
  one per sequence change; the snapshot and publications limited to jobs not ended and of the store's current epoch.
- Re-check: registry part confirmed (`job.ended` is already true before `endedAt` is set, `:1670` to `:1674`, and the
  plan's `ended` publication does not depend on the snapshot's filter); the tab's clearing list was short by one path,
  which is AUD-9.

### AUD-5. Snapshot coalescing and monotonic text were overstated (fixed in plan)

- Plan (Current State and D10, as audited): "the request layer keeps at most one pending snapshot"; "the text trimmed
  by `removeIncompleteResponse` is not monotonic."
- Code: only the plugin bridge replaces a pending snapshot with the newest (`requests.ts:856` to `:911`); the general
  wrapper forwards each read (`:1098` to `:1133`). An adapter can rewrite its own snapshot: OpenAI rebuilds the
  reasoning wrapper and applies extraction before each emission (`openAI/requests.ts:1154` to `:1171`). The continue
  prefix is added after trimming (`runner.ts:2494`).
- New: Current State's "Chunks are snapshots", D10, and slice 2 (`onRaw` before trimming and before the prefix; the
  counted baseline moves only when a count succeeds).
- Re-check: confirmed.

### AUD-6. The sidebar's navigation is scoped to the selected character (fixed in plan)

- Plan (slice 3, as audited): "A row opens its chat through the navigation the sidebar's chat rows use."
- Code: the rows call `changeChatTo` (`SideChatList.svelte:493`), which uses the selected character
  (`globalApi.svelte.ts:1534`); `openPinnedChat(ref)` selects the chat and its character (`:1548`).
- New: "through `openPinnedChat` or what it does", with a test of a chat of another character. Re-check: confirmed; an
  entry whose transcript is not loaded still opens, which the plan now says.

### AUD-7. The memory indicator has an expanded overlay as well as a pill (fixed in plan)

- Plan (slice 3, as audited): "one fixed top-right column ... with `HypaV3Progress` giving up its own
  `fixed top-4 right-4`."
- Code: only the collapsed button has that position (`HypaV3Progress.svelte:122`); the expanded branch is a full-size
  absolute container with a centered panel (`:68`).
- New: only the collapsed button shares the column; the expanded branch keeps its container (slice 3, D16, and a
  manual check). Re-check: confirmed.

### AUD-8. The settings lists left out the section entry and one fixture (fixed in plan)

- Plan (slices 3 and 4, as audited): "an item in `interactionSettingsData.ts`"; "following `useStreaming` through its
  files".
- Code: `loreBudgetStop` has a leaf item (`interactionSettingsData.ts:30`) and a section entry (`:216`), and the
  search index reads the section (`searchIndex.ts:144`). The fresh defaults are checked against the boot fixture
  (`normalizeSections.test.ts:18`, `bootSnapshot.test.ts:65`). The Response Streaming checkboxes are hand-written
  (`ModelSettings.svelte:64`, `ModelProfileEditor.svelte:196`), so `settingsPageSections.test.ts` does not reach them.
- New: slice 3 names the section's `itemsById` list and the fixture; slice 4 names the fixture and a component test of
  `ModelSettings.svelte`. Re-check: confirmed.

### AUD-11. Two checks inferred the response type from the settings (fixed in plan)

- Plan (after the first corrections): slice 3's manual check "A send with Response Streaming off: ... with no count";
  slice 4's test "Both off: no `forceStreaming`, the buffered branch."
- Code: a plugin provider can stream on its own (`llm/request.ts:686`), and the Claude batch path returns a keyed
  stream whatever `useStreaming` says (`anthropic.ts:661`, `:918`, `:987`); the probe got one with streaming off.
- New: the manual check names a provider that answers buffered; the test says a provider that streams on its own is
  read with chunks and checkpoints; Order names the Claude batch. Not read again.

## Noted, not acted on

- The blank, locked reply bubble during a quiet stream has no indicator of its own (`Chat.svelte:999`,
  `ChatBody.svelte:304`). The plan keeps it as a manual check and a Not In This Plan entry.
- The count is of the adapter's first reply value: reasoning wrappers, signatures, and tool markers in it are counted.
  D10 calls the count approximate and not the provider's billed usage.
- After slices 1 and 2 the server publishes frames and counts streamed tokens before any tab reads them; the plan's
  Order now says so.
- The found issue behind AUD-1 (a streamed `OobaLegacy` reply stored as its first character) is filed separately and
  is not in the backlog files yet.
