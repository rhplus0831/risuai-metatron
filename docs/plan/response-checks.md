# Response Checks Plan

Status: drafted 2026-11-20 at `b2840a81d` from the owner's request (fail a request whose answer is shorter than N).
The owner accepted D1 to D10 on 2026-11-20 as first written, including the banned-script check on full streams (D6).
Audited the same day by GPT-6.2-Astra against `7a0591924`:
[report](../reports/audits/plan-runner/response-checks-2026-11-20.md), 21 findings (3 P1, 11 P2, 7 P3), all fixed in
this text. Three corrections changed what the owner accepted, and the owner approved them on 2026-11-20 before the run:
D1 stores six number fields in place of one object (two devices' edits then merge), D9 says the Structured Memory
writer is checked as a Memory request, and D7's retry is specified step by step. Landed: none.

Sources: the owner's request and answers of 2026-11-20; `shared/llm/interception.ts`, `server/src/llm/outer.ts`,
`src/ts/process/request/request.ts`, `server/src/prompt/runner.ts` (`runSpeaker`, `readReply`),
`server/src/lua/bindings.ts`, `server/src/data/normalize/providers.ts`, and
`src/lib/Setting/Pages/RequestInterceptionSettings.svelte`, read at `b2840a81d`; the
[LLM requests](../structure/llm-requests.md), [server generation](../structure/server-generation.md), and
[settings](../structure/settings-i18n.md) guides; the audit's reading at `7a0591924`. Nothing was run: every statement
under Current State comes from reading the code. Identifiers are the anchors; re-verify each cited location before
editing (STRUCTURE.md protocol step 5).

## Goal

An answer that the provider returned as a success but that is too short to be an answer (an empty text, a refusal
line) is treated as a failed request, per request kind.

- **Per request kind.** Each of the six request kinds (`MODEL_MODES`) has its own minimum, off by default. An emotion
  answer is one word and a translation can be one character, so one global number cannot work.
- **Retried where nothing was shown.** A rejected answer uses the existing retry budget (`requestRetrys`) whenever its
  text has not reached the user: a buffered answer, and a Half Streaming reply.
- **The same place checks the banned scripts.** The banned-script check (`banCharacterset`) runs wherever the length
  check runs, so a Half Streaming reply gets the automatic regeneration it lacks today.

Not goals: restoring text a full stream already showed and retrying it; a minimum in tokens; marking the rejected
request's row in request history (the row stays a success; the rejection message is the failure's text wherever
that request's failure is shown); a minimum for the text finally stored (D9); checks other than length and script
(a banned phrase, a pattern), so a long refusal passes.

## Current State

- `requestChatDataOuter` (`server/src/llm/outer.ts`) and `requestPinnedChatData`
  (`src/ts/process/request/request.ts`) hold the same loop. After escaping (`risuEscape`, with `escape`) and the
  after-request replacers, a `success` whose text matches a script in `providers.banCharacterset` uses one retry and
  the loop continues; past `requestRetrys` it returns `The model answered in a banned script (<set>)`. The server
  loop reads its settings from `OuterRequestDeps.db`, the tab loop from the live `settings.providers`.
- Both loops return a `streaming` answer as it is, before those checks, unless the request has `escape` (the stream
  is then read to its last snapshot and continues as a buffered success). A `multiline` answer is not checked either.
- The chat reply always asks for a stream (`useStreaming: true` in `runSpeaker`). A reply that the outer loop returns
  as `streaming` bypasses the banned-script check; a buffered `success` is checked whatever the two streaming
  toggles say (Response Streaming and Half Streaming both off, an escaped character, an adapter that answers
  buffered, such as Claude with tools).
- Half Streaming (`quiet` in `runSpeaker`) sets `forceStreaming` on the reply request. `readReply` then publishes no
  chunk and no checkpoint and keeps sequence 0. Before the read, `runSpeaker` has appended an empty reply row and
  emitted that reply's `accepted` (a continue or an in-place reroll already has its row); an output meter reports
  token estimates during the read.
- `runSpeaker` makes one reply request and dispatches its result once. Its stream branch treats an existing
  `generation` as a continue (`continuingStream`, a prefix read from the stored row).
- A read failure of a reply stream sets `failed`, calls `finalize(stream.text, stream.seq)`, and throws a
  `GenerationRunnerError` with stage `request`. `finalize` restores an in-place reroll's previous candidate when
  `failed` is set, and it does not remove an empty row. This path does not use `throwError`, so
  `inlayErrorResponse` plays no part in it. A buffered `fail` does go through `throwError`.
- A job's requests pass through `requestChatDataOuter` when they go through the job's request binding
  (`bindings.request` in `server/src/lua/bindings.ts`: the reply, foreground memory, emotion, the image-prompt
  step, a Lua script's or a native trigger's own request, the internal MCP `runLLM`) or build the loop themselves
  (the memory task host, the translation runner). The Structured Memory writer requests through a memory host, so it
  passes the loop as a `memory` request and gets the banned-script check today. A plugin's `runLLMModel` calls
  `requestChatDataMain` directly, and a stream that a Lua script or a native trigger reads itself is not checked.
- A successful request with `previewBody` (job kind `previewPrompt`) returns a `success` through the same loop: a
  redacted request body, a diagnostic, or an adapter-specific value, not an answer. The banned-script check runs on
  it today.
- The Structured Memory writer's shortest valid answers are 169 characters for an analysis, 14 for a page patch
  without changes (`{"patches":[]}`), and 12 for a compaction. When the retries of an analysis or a required patch
  run out, the recording attempt fails and commits no event (the window stays eligible for a later recording; five
  failures in a row pause automatic recording); a failed compaction adds a warning.
- The retry report of a job (`reportRetry` in `server/src/lua/bindings.ts`) is private to the binding factory and
  runs in the outer loop right before a re-sent attempt, after that loop's abort check, replacers, and trigger. The
  registry's retry publication keeps the job's output estimate, which `server/src/tests/generationJobs.test.ts`
  asserts.
- The buffered branch of `runSpeaker` passes the chat's message count to the `editoutput` scripts as the reply's
  index, which is right only while the reply row does not exist yet.
- Answer text can hold parts that are not the visible answer: `<Thoughts>…</Thoughts>` blocks (several adapters
  wrap reasoning; `stripThoughtsBlock` in `server/src/prompt/thoughts.ts` removes from the first opening tag to the
  last closing one, with any answer text between two blocks), `<tool_call>…</tool_call>` records, and inlay markers
  (`{{inlay::…}}`, `{{inlayed::…}}`, `{{inlayeddata::…}}`), which `server/src/llm/google.ts` adds for a thought
  signature and for an image. A thought outside the wrapper and an in-stream provider error are plain answer text.
- `readReply` returns `result` after `removeIncompleteResponse` trimming and `lastChunk` as it arrived; the buffered
  check runs before the runner's trimming.
- `providers.autoContinueMinTokens` already continues a reply that is under a token count. It lengthens a real
  answer; it does not fail an empty one.
- A section record merges between devices field by field, and a field's value is one unit: two devices that changed
  different members of one object-valued field conflict (`mergeUnit` in `src/ts/storage/recordMerge.ts`).
  Independent top-level fields merge.
- Request interception is the one per-request-kind settings list: `providers.requestInterceptions`, edited on its own
  settings page, each rule a prompt with a mode list. A rule with blank text does not apply. Request history shows
  how many prompts were inserted; the context report shows their estimated token cost.
- The banned-script list is edited on the Prompt page, Others tab, "Advanced prompt behavior" section (`adv.banChar`
  in `src/ts/setting/promptSettingsData.ts`).
- The interception strings exist in `src/lang/en.ts` and `src/lang/ko.ts` only.

## Decisions

Accepted by the owner on 2026-11-20.

- **D1. A number per request kind.** Six top-level `providers` fields, one per request kind in `MODEL_MODES` order:
  `minResponseLengthModel`, `minResponseLengthSubmodel`, `minResponseLengthMemory`, `minResponseLengthEmotion`,
  `minResponseLengthOtherAx`, `minResponseLengthTranslate`. Each is a number with the default 0 (off). One shared
  rule normalizes a value: not a finite number, or below 1, is 0; otherwise the fraction is cut (2.5 is 2) and the
  result is capped at 100,000. The server normalizer, the page's setter (a blank field is 0), and the shared check
  when it reads a value all use that rule, so the tab and a job enforce the same number.
  They are separate fields rather than one object so that two devices setting different kinds merge. They are not
  fields of an interception rule: a check-only rule would have blank text, which means "does not apply" today, and
  one kind has only one effective minimum.
- **D2. One shared module for both checks.** `shared/llm/responseChecks.ts` holds the field name of each request
  kind, the measure (D3), and one function that returns the rejection message of a completed answer or `null`. Both
  outer loops and `runSpeaker` call it, so the banned-script loop exists once. `runSpeaker` reads the settings from
  `requestDb`, the request's snapshot. Messages: the present banned-script text, and
  `The model's answer was shorter than the minimum (<length> < <minimum>)`.
- **D3. The measure.** The length is counted on a copy of the answer made for measuring. Every
  `<Thoughts>…</Thoughts>` pair is removed on its own (text between two blocks stays), then every
  `<tool_call>…</tool_call>` record and every inlay marker of the three spellings; the rest is trimmed and counted in
  Unicode code points (not UTF-16 units). A buffered answer may already be escaped where the check runs, so a marker is
  recognized with literal braces and with the braces `risuEscape` writes (U+E9B8, U+E9B9); the text is not unescaped
  as a whole, since that would lengthen other characters. The module has its own rule for this;
  `stripThoughtsBlock` stays where it is. The banned-script check keeps reading the whole text it is given, as
  today.
- **D4. Where the checks do not apply.** A request with `previewBody` skips both checks. A continue request
  (`arg.continue`) skips the minimum: its answer is only the added text, which may rightly be a few characters, and
  auto-continue rounds are continue requests.
- **D5. Buffered answers retry.** In both outer loops the minimum sits with the banned-script check: a rejection
  uses one retry and the loop continues; past `requestRetrys` the loop returns the rejection message as a `fail`.
  For the chat reply that `fail` goes through `throwError`, as any buffered failure does (so `inlayErrorResponse`
  applies to it).
- **D6. A full-stream reply fails after the read, with its text kept.** In `runSpeaker`, after `readReply` ends without
  an error or an abort, the answer goes through the shared check. The text checked is the last snapshot's first value as
  it arrived (`lastChunk`, or an empty text without a snapshot): before `removeIncompleteResponse` trimming and without
  a continue's prefix. It is the provider's text; the buffered check reads its text after escaping and the after-request
  replacers, which a stream does not pass. A rejected reply takes the read failure's path: `failed`,
  `finalize(stream.text, stream.seq)`, and a `GenerationRunnerError` with stage `request` and the request's id. There is
  no retry, and no `risuerror` text is added whatever `inlayErrorResponse` says. An in-place reroll therefore gets its
  previous candidate back; a continue keeps its combined text (its added text skips the minimum but not the script
  check). Both checks apply: a full-stream reply in a banned script, accepted today, fails this way too (one rule for
  every stream). A failed final write still surfaces as its own `persist` failure.
- **D7. A Half Streaming reply retries in `runSpeaker`.** A rejected quiet reply is requested again while its own
  count of rejections is at most `requestRetrys`.
  - _Shape._ The first request is dispatched as today, and the reply row is acquired only when its result is a stream
    (the append, `begin`, and that reply's `accepted`, or the existing row of a continue or reroll), so a first buffered
    failure still creates no stream placeholder row. The prefix and `continuingStream` are decided once, at that point,
    and are not derived again from the existing `generation` on a later read. The request and the read then sit in a
    loop that ends before the first write of the successful tail; the tail (`writeReplyText`, `editoutput`, the output
    trigger, listeners, candidate adoption) runs once, on the accepted answer, with that answer's `model` and `special`
    fields.
  - _A rejected read._ Its text, `lastChunk`, and samples are dropped, except that the last one is kept for the
    budget's end. Nothing is written to the row, `failed` and `coverSeq` stay unset, and no `generation.seq` is
    reused. Its meter is stopped, and the job's output estimate is cleared at once through a registry entry used
    only for this, so every other retry keeps the estimate it shows today.
  - _The next request._ `setup.check()` and the chat's existence are checked first. `services.request` is called
    with the same arguments and the prepared tool set, plus a mark that this call re-sends a rejected reply; the
    outer loop then reports a retry at its first dispatch, where it reports its own re-sends (after its abort check,
    replacers, and trigger), so the retry count rises only for a request that goes out. The call starts from the
    assembled prompt again: a replacer's or the trigger's change from the previous call is not carried over, and
    they run again. A tool call runs again only when the new answer asks for it; a tool record or an inlay that a
    rejected attempt stored stays. A new output meter starts.
  - _The next result._ A `streaming` result is read quietly with the captured prefix. A buffered `success` (the outer
    loop has checked it) is written into the existing row by the buffered branch's in-place write, and its output
    scripts get the existing row's own index, not the message count. A `multiline` result takes the buffered branch
    too, unchecked as today. A `fail` goes through `throwError`, with that function's own choice of row: with
    `inlayErrorResponse` off the send fails, the row closes as stored, and an in-place reroll gets its previous
    candidate back; with it on the `risuerror` text goes to the chat's last message when that is a reply (the
    placeholder, unless another row was added after it; a reroll's carrier for a reroll) and the send stops.
  - _The budget's end._ As D6, with the last rejected read's `text` and its request's id: `failed`,
    `finalize(text, 0)` (0 is a quiet read's chunk sequence), and the `GenerationRunnerError`. For a plain send an
    empty text leaves an empty row, as a read failure without text does today; a continue keeps its prefix with the
    rejected addition; an in-place reroll gets its previous candidate back.
  - _A stop between attempts._ The rejected text is not written: a plain send ends with its row as stored, a
    continue keeps its stored prefix without the rejected addition, and an in-place reroll gets its previous
    candidate back.

  Reading the stream inside the outer loop was considered and not chosen: the reply would lose its token estimate
  and the text kept on a stop during the read.

- **D8. Budgets are separate.** The count in D7 is the reply's own; each request it makes starts a new outer loop
  with its own budget for failures. With the fresh defaults (`requestRetrys` 2), one reply can be rejected three
  times and make nine outer dispatches, or fifteen with `antiServerOverloads` on; an adapter's own exchanges and
  tool follow-ups come on top. The retries spend none of the auto-continue round cap, and a job has no cap on its
  number of requests. The bounds are the 30-minute deadline of the job (or of the command part), which a retry does
  not renew, and the job's tool-call budget.
- **D9. Accepted limits.** A reply that is only an image is rejected when its kind has a minimum, since its marker
  is not counted. A thought outside the `<Thoughts>` wrapper and an in-stream provider error count as answer text.
  The minimum is applied to the answer as the check receives it; later trimming (`removeIncompleteResponse`) can
  still store a shorter or an empty reply. Not checked: a plugin's `runLLMModel`, a tab request that streams, a
  stream a Lua script or a native trigger reads itself, and any `multiline` answer. The Structured Memory writer is
  checked like every other `memory` request, so a Memory minimum can reject valid writer JSON: when the retries of
  an analysis or a required page patch run out, that recording attempt fails and its window stays unrecorded until a
  later recording, and a rejected compaction adds a warning. The page's notes say so. Each limit is recorded in the
  LLM requests guide's Limitations with this plan as the decision.
- **D10. The page is renamed, the stored names are not.** The settings page becomes "Request Rules" ("요청 규칙")
  with two sections: "Prompt insertion" (the present list) and "Response checks" (six number fields, one per request
  kind, 0 or blank for off). The route slug `request-interception`, the field `requestInterceptions`, the menu
  constant, and the `interceptions` keys keep their names. Their labels change: request history's count becomes
  "Inserted prompts", and the context report's token row becomes "Inserted prompts (estimate)", still in tokens.
  "Request hooks" was the owner's first name and is not used: "hook" already names input hooks and plugin hooks,
  which run something. The banned-script list stays where it is on the Prompt page.

## Rules For Every Slice

One slice is one session and one commit. Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow`
for one marked _hard_.

- **Checks.** `pnpm check`; the focused paths the slice names through `pnpm --silent test:agent <paths>` while
  iterating; `pnpm --silent test:agent` once whole after the last source edit; `pnpm format:check`;
  `pnpm check:docs` for a guide edit; `pnpm check:tests` after adding or tagging a test.
- **V6.** Each new test is shown to fail with the guarded line broken, and the report says which line.
- **Both runtimes.** A change to the response checks of one outer loop is made in the other in the same slice, and
  the two loops' comments stay in step. The retry mark of D7 is the server loop's alone: the tab has no job.
- **Guides.** The slice updates the guide statements its change makes false, in the same commit; `pnpm docs:owner
<path>` names the owning guide of a file.
- **Shared files.** The slices run one after another. Edited by more than one slice: `server/src/llm/outer.ts` and
  `server/src/tests/llmCharsetRetries.test.ts` (1 and 2), the LLM requests guide (1, 2, and 3), and the server
  generation guide (2 and 3).

## Slices

### 1. The settings, the shared check, and the buffered path (_hard_)

- `shared/llm/responseChecks.ts` (D2, D3, and the value rule of D1).
- The six fields (D1) on `Database` (`shared/database.ts`), in the `providers` list of `shared/sections.ts`, in
  `server/src/data/normalize/providers.ts` (`["number", 0]` each, with the integer and cap rule applied after
  `normalizeSection`), in `METATRON_ONLY_SETTINGS` of `server/src/data/upstream/exportDatabase.ts`, and in the fresh
  boot fixture `src/ts/storage/tests/fixtures/boot/boot-snapshot.json`. `OuterRequestDeps.db` gains them; `RequestDb`
  picks every `providers` field already.
- Both outer loops call the shared check in place of their own banned-script loop (D4, D5).
- Tests: `shared/llm/tests/responseChecks.test.ts` (the measure: thoughts with text between two blocks, a tool
  record, markers, an escaped image-only answer, whitespace, a surrogate pair);
  `server/src/tests/llmCharsetRetries.test.ts` (its helper fixes the kind to `model` and its `db` to three fields:
  both are extended; a short answer is retried and then accepted, the budget ends in the message, a kind at 0 is
  untouched, a continue is not measured, a `previewBody` result with a banned script passes, which is the regression
  test of the present preview behavior and is shown to fail first); the tab loop in
  `src/ts/process/request/tests/requestPresetScope.test.ts` or a sibling; `normalizeSections.test.ts` (default,
  repair, cap) and `upstreamExport.test.ts` for the fields.
- Guide: [LLM requests](../structure/llm-requests.md), a "Response checks" flow for the buffered path.
- Focused: `pnpm --silent test:agent shared/llm src/ts/process/request src/ts/storage/tests/bootSnapshot.test.ts
server/src/tests/{llmCharsetRetries,llmRequests,normalizeSections,upstreamExport}.test.ts`, and
  `pnpm --silent test:agent --tags-filter=slow server/src/tests/llmCharsetRetries.test.ts`.
- Done when a buffered request of a kind with a minimum is retried and then failed on both runtimes, and every
  existing banned-script test passes unchanged.

### 2. Reply streams in `runSpeaker` (_hard_)

Depends on 1.

- `server/src/prompt/runner.ts`: a full stream fails as in D6; a quiet stream retries as in D7 and D8.
- The mark of a re-sent rejected reply (D7): a field of `bindings.request`'s `meta` in `server/src/lua/bindings.ts`,
  passed to `requestChatDataOuter` through `OuterRequestDeps` in `server/src/llm/outer.ts`.
- `server/src/jobs/generationJobs.ts`: the entry that clears the job's output estimate (D7).
- Tests in `server/src/tests/promptRunner.test.ts`, beside `Half Streaming` (its `heldStream` harness answers one
  `runInJob` call without a request id; the new cases script several answers with ids): a short quiet reply is
  requested again and the second answer is stored in the one row with one `accepted` for the reply; a banned script
  does the same; the budget's end fails the send with the last text stored and the last request's id; a stop between
  attempts leaves the row as stored; a retry that answers buffered is stored and its `editoutput` script gets the
  row's index; a retry that answers `fail` ends as D7 says with `inlayErrorResponse` off and on; a short full stream
  fails with its text stored and no second request; a short in-place reroll restores the previous candidate; a
  continue is not measured. In `server/src/tests/generationJobs.test.ts`: the estimate is cleared by the new entry
  and kept by an ordinary retry. In `server/src/tests/llmCharsetRetries.test.ts`: a marked call reports a retry at
  its first dispatch, an unmarked one does not.
- Guides: [server generation](../structure/server-generation.md) "Streamed and buffered replies" (a stream no longer
  skips the checks) and [LLM requests](../structure/llm-requests.md) (the stream half of the flow, the Tests list,
  the Limitations of D9).
- Focused: `pnpm --silent test:agent server/src/tests/{promptRunner,llmCharsetRetries,generationJobs}.test.ts`.
- Done when the three reply paths (buffered, Half Streaming, full stream) behave as D5 to D7 say, shown by the tests.

### 3. The settings page and its names (_small_)

Depends on 2, so that the page's notes describe what runs.

- `RequestInterceptionSettings.svelte` gains the "Response checks" section (D10): one number field per request kind,
  labelled as the rule rows label kinds (`modeLabel`), each writing its field through the shared rule of D1.
- Strings in `src/lang/en.ts` and `src/lang/ko.ts`: the page title and navigation label, the two section headings,
  the fields, the two count labels, and notes that say: the count is of characters after trimming, without thought
  blocks, tool records, and image markers, so an image-only reply fails; a long refusal passes; a script's buffered
  request of the same kind is measured too; a Memory minimum can reject the Structured Memory writer's valid JSON
  and fail that recording (D9); a continue is not measured; a fully streamed reply fails without a retry and keeps
  its text (a reroll goes back to its previous answer); the banned-script list is on the Prompt page.
- Tests that read these strings: `RequestInterceptionSettings.test.ts` (the heading; a field edit writes its field, 0
  turns it off, the rule list is untouched), `src/ts/setting/searchIndex.test.ts` (the query and the label),
  `src/lib/Others/RequestLogs/ServerRequestHistory.test.ts` (the literal `Intercepted`), and the descriptions in
  `src/ts/router/routes.test.ts` and `e2e/settingsPages.spec.ts`; then
  `pnpm --silent test:agent --e2e e2e/settingsPages.spec.ts`.
- Guides: [settings](../structure/settings-i18n.md) Pages, and the label mentions in the LLM requests, server
  generation, chat pipeline, UI theming, and diagnostics guides.
- Done when a minimum set on the page is the one a request reads, in the English and the Korean UI.

## Manual Checks

For the owner, after slice 3; a check that is not run moves to the manual checks backlog when the plan is retired.

- With a real provider, a minimum on the chat reply above the length of a known short answer, and a prompt that
  makes the model give that answer, on a plain send: the reply is regenerated when it arrives buffered or under Half
  Streaming, and fails with its text left in place when it is streamed to the screen. A provider can answer buffered
  with Response Streaming on (Claude with tools), so judge by whether text appeared while it was generated.
- Half Streaming: the token estimate restarts on a regeneration, and stop during a retry's read keeps what had
  arrived.
- A minimum set too high on the translation kind fails a translation with a message that names the minimum; on the
  emotion kind the emotion step reports the failure and the reply stands.
- Two devices that each set a different kind's minimum while apart both keep their value after syncing.
- Phone width: the six number fields and their labels fit the page.
