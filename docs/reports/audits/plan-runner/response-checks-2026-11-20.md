# Response Checks Plan audit, 2026-11-20

- Plan: `docs/plan/response-checks.md`
- Commit audited: `7a0591924`, the commit that added the plan. The corrected plan is committed with this report
- Mode: `full`
- Model: GPT-6.2-Astra (`xhigh`), read-only, at the owner's request in place of the procedure's Sol because slices 1
  and 2 change `shared/` and `server/` contracts; report written by the session that drafted the plan (Claude Fable
  5.2), before any plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 3     |
| P2         | 11    |
| P3         | 7     |
| unverified | 0     |

All 21 findings are closed and `fixed in plan`. The first turn filed A1 to A11 against the draft. The second turn read
the corrections, confirmed A5 to A11, disputed A1 to A4, and filed N1 to N6 against the corrections themselves. The
third turn confirmed A1, A2, A4, and N1 to N6, disputed A3 once more, and filed N7 to N10. The fourth confirmed A3 and
N7 to N10 and found no P1 or P2 open. Astra graded A1 to A11, N1 to N7; N8 to N10 it listed as contradictions without
a grade, and the grades here are the report writer's.

Astra ran no test or type check: the audit is a reading of the code. The four turns took about 24 minutes and 17.2 M
tokens. `read_only_violation` was `false` after turns 2 to 4. After turn 1 it was `true` with no changed path and
`git_state_changed`: the branch `claude/structured-memory-ui-issues-fa5f5e` was created from `7a0591924` at 03:46:35
during the turn, with a worktree under `.claude/worktrees/`, which is how the desktop app starts a worktree session.
The working tree and `dev` did not change. The report writer did not read the agent's command log to rule the agent
out.

Three corrections change what the owner accepted on 2026-11-20 and are named in the plan's `Status:` line for the
owner's review: D1's stored shape (A1), D9's statement about the Structured Memory writer (A2), and D7's mechanism
(A3).

Re-check list: `patchMessage` takes the unowned-write branch and closes the fence
(`server/src/data/chatStore.ts:1821`, `:2580`), so D6 and D7 depend on owned `setText` and `setMessage` writes; a
whole-row patch is measured against 64 KiB (`shared/resources.ts:572`, `server/src/data/chatStore.ts:1954`), and the
plan depends on store admission, not on a row fitting one frame; `STORE_TABLES_SQL` runs for `user_version === 0`
(`server/src/data/resourceStore.ts:3891`), and D1 is normalized JSON without a table; delivery needs an eligible
socket whose send succeeds (`server/src/jobs/generationJobs.ts:1042`, `:1059`, `:1074`), so the README's `sendText`
entry is broader than the code, and D6 and D7 decide from quiet mode and the store, not from delivery.

Found consistent:

- **The two outer loops are the same loop.** Both escape first when asked, run the after-request replacers, then scan
  the whole text for a banned script, and both pass a `streaming` or `multiline` result through
  (`server/src/llm/outer.ts:178`, `:185`, `:200`, `:211`; `src/ts/process/request/request.ts:461`, `:474`, `:495`,
  `:507`).
- **Quiet mode is as described.** It needs Response Streaming off, Half Streaming on, a resolved eligible model, and a
  job that is not a body preview, and it sets `forceStreaming` (`server/src/prompt/runner.ts:1919`, `:1931`); a quiet
  read meters raw text, emits no chunk, starts no checkpoint timer, and keeps sequence 0 (`:2599`, `:2627`, `:2633`).
- **D6's path does what the plan says** for a plain send, a continue, a group send, and an in-place reroll: the final
  write with the supplied text precedes the request-stage error, and `failed` restores a reroll's previous candidate
  (`server/src/prompt/runner.ts:1386`, `:1388`, `:1437`, `:2172`).
- **`continue` and `previewBody` reach both loops** (`shared/llm/request.ts:119`, `:126`;
  `src/ts/process/request/transport.ts:199`; `server/src/prompt/runner.ts:1935`, `:1939`), and the banned-script check
  does run on a preview's body today (`server/src/llm/outer.ts:189`, `server/src/prompt/runner.ts:1953`).
- **A job's settings are a detached snapshot** taken at run setup (`server/src/jobs/jobScope.ts:205`, `:254`); the tab
  loop reads the live view. `RequestDb` picks every `providers` field (`server/src/llm/settings.ts:26`, `:44`), and
  import normalizes whatever `SECTION_FIELDS` names (`server/src/data/upstream/importDatabase.ts:214`).
- **The stable names can stay.** The route slug, menu constant 26, `requestInterceptions`, and the `interceptions` keys
  are read by identifier; only the heading, search, and history tests read the English strings.
- **The focused commands are valid** for the test wrapper, and the serial slice order is sound
  (`docs/structure/test-harness.md:212`, `util/agentTest.mjs:137`).

## P1

### A1 — D1: two devices' minimums overwrote one another — fixed in plan

- Plan (D1, slice 1, draft): one object-valued field `providers.minResponseLength`, with "if two devices' edits of
  different kinds would overwrite each other, the slice reports it and stops for a decision."
- Code: a field's value is one merge unit (`src/ts/storage/recordMerge.ts:92`, `:115`); on a conflict the tab accepts
  the server record and queues a recovery draft (`src/ts/storage/resourceSync.svelte.ts:4101`, `:4395`). The stop
  condition was therefore already met.
- Correction, confirmed: six top-level number fields, one per request kind, default 0, which merge independently
  (`recordMerge.ts:22`, `:115`; the independent-fields test at `src/ts/storage/tests/resourceSyncMerge.test.ts:1094`).
  No name collides with an existing field.

### A2 — D9: the Structured Memory writer is checked, not exempt — fixed in plan

- Plan (Current State, D9, draft): "The Structured Memory writer calls `llm.runInJob` directly" and is not checked.
- Code: the writer calls `host.request`; `writerHostDeps` decorates the attempt inside `requestChatDataOuter`
  (`server/src/prompt/memory/structured/writer.ts:191`, `:847`; `server/src/prompt/memory/memoryTaskHost.ts:229`,
  `:245`), and a send's host reaches the same loop through `services.request` (`server/src/prompt/runner.ts:901`).
- Correction, confirmed (with N2): the writer is a `memory` request and is checked; D9 and the page notes say what a
  Memory minimum can do to it. No exemption is added.

### A3 — D7: the retry had no place in `runSpeaker` as described — fixed in plan

- Plan (D7, draft): "The retry reuses the reply row and generation … A retry that comes back `fail` or buffered goes
  on as that answer does today, into the existing row."
- Code: one request, then a one-way dispatch (`server/src/prompt/runner.ts:1926`, `:1962`); the stream branch treats
  an existing `generation` as a continue (`:2105`); `throwError` chooses its row from `inlayErrorResponse` and the
  last message (`:1222`); a new meter leaves the old estimate in the registry
  (`server/src/jobs/generationJobs.ts:2099`).
- Correction, confirmed (with N3, N4, N7): D7 is written as Shape, A rejected read, The next request, The next result,
  The budget's end, and A stop between attempts, each with the plain-send, continue, and reroll outcomes.

## P2

### A4 — D3: the measure did not see the same text at every call site — fixed in plan

- Plan (D3, draft): "counted on the answer without its `<Thoughts>` block and without inlay markers".
- Code: `risuEscape` replaces braces before the buffered check (`shared/cbs/evaluator.ts:160`,
  `server/src/llm/outer.ts:185`); `stripThoughtsBlock` removes text between two blocks
  (`server/src/prompt/thoughts.ts:15`); tool records are answer text (`server/src/llm/requests.ts:845`).
- Correction, confirmed (with N5): each thought pair is removed on its own, tool records and markers are removed, a
  marker is recognized in both brace spellings, and the stream check reads `lastChunk`.

### A5 — D8: the request count was understated — fixed in plan

- Plan (D8, draft): "each of those requests can itself be re-sent twice."
- Code: an overload failure costs half a retry with `antiServerOverloads` (`server/src/llm/outer.ts:215`), and
  adapters make further calls inside one dispatch (`server/src/llm/google.ts:558`).
- Correction, confirmed: nine outer dispatches at fresh defaults, fifteen with half-cost overloads, adapter exchanges
  on top; the bounds are the job's deadline and its tool-call budget.

### A6 — D10: the two `interceptions` numbers have different units — fixed in plan

- Plan (Current State, D10, draft): "the counts in request history and the context report are counts of inserted
  messages."
- Code: history gets `start.length + end.length` (`shared/llm/interception.ts:114`); assembly sums `tokenizeChat` of
  the inserted messages (`server/src/prompt/assemble.ts:2587`).
- Correction, confirmed: "Inserted prompts" for the history count and "Inserted prompts (estimate)", in tokens, for
  the context report.

### N1 — D1: the editing tab could enforce a different number than a job — fixed in plan

- Plan (after A1's correction): a server-side clamp, and fields "each bound to its field".
- Code: a view field stores what it is given and the acknowledgement keeps the submitted value
  (`src/ts/storage/settingsViews.svelte.ts:676`, `src/ts/storage/resourceSync.svelte.ts:3201`).
- Correction, confirmed: one shared value rule, used by the normalizer, the page's setter, and the check.

### N2 — D9: the writer's failure was overstated and missing from the notes — fixed in plan

- Plan (after A2's correction): "above the length of its shortest valid JSON answer fails its runs".
- Code: the shortest valid answers are 169 (analysis), 14 (a no-op patch), and 12 (compaction) characters
  (`server/src/prompt/memory/structured/analysis.ts:210`, `patches.ts:266`, `compact.ts:94`); a failed analysis or
  required patch fails the recording attempt without an event, and a failed compaction warns (`writer.ts:873`, `:948`,
  `:1002`).
- Correction, confirmed: D9 and slice 3's notes state those outcomes.

### N3 — D7: the retry report could not clear the estimate or tell its retries apart — fixed in plan

- Plan (after A3's correction): "that report clears the job's output estimate."
- Code: the retry publication keeps `job.output`, which a test asserts (`server/src/jobs/generationJobs.ts:2099`,
  `server/src/tests/generationJobs.test.ts:612`); the reporter runs right before a dispatch, after the loop's hooks
  (`server/src/llm/outer.ts:168`).
- Correction, confirmed: a registry entry used only for a rejected quiet read clears the estimate, and a mark on
  `services.request` makes the outer loop report the retry at its first dispatch.

### N4 — D7: the buffered fallback gave output scripts the wrong index — fixed in plan

- Plan (after A3's correction): "written into the existing row by the buffered branch's in-place write."
- Code: that branch passes the message count as the reply's index (`server/src/prompt/runner.ts:2240`, `:2290`).
- Correction, confirmed: the fallback passes the existing row's own index.

### N5 — D3 and D6: unescaping changed lengths, and two representations were called one — fixed in plan

- Plan (after A4's correction): "`risuUnescape` is applied" and "which is what the buffered check reads."
- Code: `risuUnescape` turns one private-use character into several (`shared/cbs/evaluator.ts:137`, `:152`); a stream
  skips escaping and replacers (`server/src/llm/outer.ts:178`); trimming after the check can empty a reply
  (`server/src/prompt/runner.ts:2196`, `:2628`).
- Correction, confirmed: no whole-text unescape; D6 names both inputs; D9 records the trimmed-empty case.

### N7 — D7: failure outcomes that `throwError` does not guarantee — fixed in plan

- Plan (after the second correction): "leaves no row" and "the `risuerror` text is written to the reply row".
- Code: `throwError` can append an error row, and targets the last message unless a reroll is active
  (`server/src/prompt/runner.ts:1222`, `:1230`, `:1266`).
- Correction, confirmed: "creates no stream placeholder row", `throwError`'s own choice of row, and the continue case
  of a stop between attempts.

### N8 — Rules: the both-runtimes rule contradicted slice 2 — fixed in plan

- Plan: "A change to one outer loop is made in the other in the same slice" against slice 2's server-only retry mark.
- Correction, confirmed: the rule covers the response checks; the mark is the server loop's alone.

### N10 — D6 against the notes and the manual check — fixed in plan

- Plan: the page note said a fully streamed rejection keeps its text, and the manual check derived the path from the
  toggle; a reroll restores its previous candidate, and Claude with tools answers buffered
  (`server/src/llm/anthropic.ts:103`).
- Correction, confirmed: the note names the reroll, and the check is a plain send judged by whether text appeared.

## P3

- **A7.** The banned-script list is on the Prompt page, Others tab, "Advanced prompt behavior"
  (`src/ts/setting/promptSettingsData.ts:62`, `:82`), not on the Advanced page. Fixed in plan.
- **A8.** "Never checked with Response Streaming or Half Streaming on" ignored the buffered exceptions
  (`server/src/llm/anthropic.ts:103`, `server/src/llm/google.ts:433`). Fixed in plan: the result type decides.
- **A9.** Slice 1 omitted the fresh-boot fixture and its test
  (`src/ts/storage/tests/fixtures/boot/boot-snapshot.json`, `src/ts/storage/tests/bootSnapshot.test.ts:164`). Fixed in
  plan.
- **A10.** Slice 3 omitted `ServerRequestHistory.test.ts`, which reads the literal `Intercepted` (`:176`). Fixed in
  plan, with the router and e2e descriptions.
- **A11.** A preview's result is not always a request body (`server/src/llm/request.ts:662`, `:1165`). Fixed in plan:
  the flag decides.
- **N6.** The shared-files line missed slice 3's guide edits. Fixed in plan.
- **N9.** D3 said a buffered answer is escaped; escaping is conditional (`server/src/llm/outer.ts:185`). Fixed in plan.
