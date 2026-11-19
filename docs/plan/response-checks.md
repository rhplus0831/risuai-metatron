# Response Checks Plan

Status: drafted 2026-11-20 at `b2840a81d` from the owner's request (fail a request whose answer is shorter than N).
The owner accepted D1 to D10 as written on 2026-11-20, including the banned-script check on full streams (D6). Not
audited. Landed: none.

Sources: the owner's request and answers of 2026-11-20; `shared/llm/interception.ts`, `server/src/llm/outer.ts`,
`src/ts/process/request/request.ts`, `server/src/prompt/runner.ts` (`runSpeaker`, `readReply`),
`server/src/lua/bindings.ts`, `server/src/data/normalize/providers.ts`, and
`src/lib/Setting/Pages/RequestInterceptionSettings.svelte`, read at `b2840a81d`; the
[LLM requests](../structure/llm-requests.md), [server generation](../structure/server-generation.md), and
[settings](../structure/settings-i18n.md) guides. Nothing was run: every statement under Current State comes from
reading the code. Identifiers are the anchors; re-verify each cited location before editing (STRUCTURE.md protocol
step 5).

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
request's row in request history (the row stays a success, and the job's failure message names the reason); checks
other than length and script (a banned phrase, a pattern).

## Current State

- `requestChatDataOuter` (`server/src/llm/outer.ts`) and `requestPinnedChatData`
  (`src/ts/process/request/request.ts`) hold the same loop. After escaping and the after-request replacers, a
  `success` whose text matches a script in `providers.banCharacterset` uses one retry and the loop continues; past
  `requestRetrys` it returns `The model answered in a banned script (<set>)`.
- Both loops return a `streaming` answer as it is, before those checks, unless the request has `escape` (the stream
  is then read to its last snapshot and continues as a buffered success). A `multiline` answer is not checked either.
- The chat reply always asks for a stream (`useStreaming: true` in `runSpeaker`). It is buffered only when Response
  Streaming is off and Half Streaming is off, when the character escapes output, or when the adapter answers buffered
  anyway. So with Response Streaming or Half Streaming on, the reply is never checked for a banned script.
- Half Streaming (`quiet` in `runSpeaker`) sets `forceStreaming` on the reply request. `readReply` then publishes no
  chunk and no checkpoint and keeps sequence 0. Before the read, `runSpeaker` has appended an empty reply row and
  emitted `accepted`; an output meter reports token estimates during the read.
- A read failure of a reply stream sets `failed`, calls `finalize(stream.text, stream.seq)`, and throws a
  `GenerationRunnerError` with stage `request`. `finalize` restores an in-place reroll's previous candidate when
  `failed` is set.
- A job's requests (the reply, emotion, the memory task host, the translation runner, a Lua script's own request)
  pass through `requestChatDataOuter`; the reply's goes through `bindings.request` in `server/src/lua/bindings.ts`.
  The Structured Memory writer calls `llm.runInJob` directly, and a plugin's `runLLMModel` calls
  `requestChatDataMain` directly; neither passes an outer loop.
- A prompt preview with the request body (`previewBody`, job kind `previewPrompt`) returns the body as a `success`
  through the same loop, so the banned-script check appears to run on the request body. Not reproduced; slice 1
  tests it first (V6).
- Answer text can hold parts that are not the visible answer: a `<Thoughts>…</Thoughts>` block (the adapters prepend
  it; `stripThoughtsBlock` in `server/src/prompt/thoughts.ts` removes one), and inlay markers
  (`{{inlay::…}}`, `{{inlayed::…}}`, `{{inlayeddata::…}}`), which `server/src/llm/google.ts` appends for a thought
  signature and for an image.
- `providers.autoContinueMinTokens` already continues a reply that is under a token count. It lengthens a real
  answer; it does not fail an empty one.
- Request interception is the one per-request-kind settings list: `providers.requestInterceptions`, edited on its own
  settings page, each rule a prompt with a mode list. A rule with blank text does not apply, and the counts in
  request history and the context report are counts of inserted messages.
- The interception strings exist in `src/lang/en.ts` and `src/lang/ko.ts` only.

## Decisions

Accepted by the owner on 2026-11-20.

- **D1. A number per request kind.**
  `providers.minResponseLength` is an object from request kind to a positive integer; a missing kind is off. A shared
  normalizer keeps the known kinds in `MODEL_MODES` order, drops a value that is not a finite integer of 1 or more,
  and caps a value at 100,000. It is not a field of an interception rule: a check-only rule would have blank text,
  which means "does not apply" today, and one kind has only one effective minimum.
- **D2. One shared module for both checks.** `shared/llm/responseChecks.ts` holds the normalizer, the measure (D3),
  and one function that returns the rejection message of a completed answer or `null`. Both outer loops and
  `runSpeaker` call it, so the banned-script loop exists once. Messages: the present banned-script text, and
  `The model's answer was shorter than the minimum (<length> < <minimum>)`.
- **D3. The measure.** The length is counted on the answer without its `<Thoughts>` block and without inlay markers,
  trimmed, in Unicode code points (not UTF-16 units). The banned-script check keeps reading the whole text, as today.
  The thought-block rule moves to `shared/` so that the tab and the server strip the same way.
- **D4. Where the minimum does not apply.** A request with `previewBody` (its result is a request body) skips both
  checks. A continue request (`arg.continue`) skips the minimum: its answer is only the added text, which may
  rightly be a few characters, and auto-continue rounds are continue requests.
- **D5. Buffered answers retry.** In both outer loops the minimum sits with the banned-script check: a
  rejection uses one retry and the loop continues; past `requestRetrys` the loop returns the rejection message as a
  `fail`.
- **D6. A full-stream reply fails after the read, with its text kept.** In `runSpeaker`, after `readReply` ends
  without an error or an abort, a rejected reply takes the read failure's path: `failed`,
  `finalize(stream.text, stream.seq)`, and a `GenerationRunnerError` with stage `request` and the request's id. There
  is no retry. An in-place reroll therefore gets its previous candidate back. Both checks apply: a full-stream reply
  in a banned script, accepted today, fails this way too (one rule for every stream).
- **D7. A Half Streaming reply retries in `runSpeaker`.** A rejected quiet reply is requested again while its own
  count of rejections is at most `requestRetrys`. The retry reuses the reply row and generation (no second row, no
  second `accepted`), starts a new output meter, and reports the retry as the outer loop's `reportRetry` does. A
  retry that comes back `fail` or buffered goes on as that answer does today, into the existing row. Past the budget
  the reply fails as in D6, with the last text. An abort or a deleted chat between attempts ends the send as it does
  between other awaits. Reading the stream inside the outer loop was considered and not chosen: the reply would lose
  its token estimate and the text kept on stop.
- **D8. Budgets are separate.** The count in D7 is the reply's own; each request it makes still has the outer loop's
  budget for transport failures. With `requestRetrys` at 2, a reply can be rejected three times, and each of those
  requests can itself be re-sent twice.
- **D9. Accepted limits.** A reply that is only an image is rejected when its kind has a minimum, since
  its marker is not counted. A plugin's `runLLMModel` and the Structured Memory writer are not checked. A tab request
  that streams, and any `multiline` answer, are not checked. Each is recorded in the LLM requests guide's
  Limitations with this plan as the decision.
- **D10. The page is renamed, the stored names are not.** The settings page becomes "Request Rules" ("요청 규칙")
  with two sections: "Prompt insertion" (the present list) and "Response checks" (six number fields, one per request
  kind, 0 or blank for off). The route slug `request-interception`, the field `requestInterceptions`, the menu
  constant, and the `interceptions` counts keep their names; the labels of those counts in request history and the
  context report become "Inserted prompts". "Request hooks" was the owner's first name and is not proposed: "hook"
  already names input hooks and plugin hooks, which run something. The banned-script list stays on the Advanced page.

## Rules For Every Slice

One slice is one session and one commit. Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow`
for one marked _hard_.

- **Checks.** `pnpm check`; the focused paths the slice names through `pnpm --silent test:agent <paths>` while
  iterating; `pnpm --silent test:agent` once whole after the last source edit; `pnpm format:check`;
  `pnpm check:docs` for a guide edit; `pnpm check:tests` after adding or tagging a test.
- **V6.** Each new test is shown to fail with the guarded line broken, and the report says which line.
- **Both runtimes.** A change to one outer loop is made in the other in the same slice, and the two loops' comments
  stay in step.
- **Guides.** The slice updates the guide statements its change makes false, in the same commit; `pnpm docs:owner
<path>` names the owning guide of a file.

## Slices

### 1. The setting, the shared check, and the buffered path (_hard_)

- `shared/llm/responseChecks.ts` (D2, D3), with the thought-block rule moved under `shared/` and
  `server/src/prompt/thoughts.ts` importing it.
- `minResponseLength` on `Database` (`shared/database.ts`), in the `providers` list of `shared/sections.ts`, in
  `server/src/data/normalize/providers.ts` through the shared normalizer, and in `METATRON_ONLY_SETTINGS` of
  `server/src/data/upstream/exportDatabase.ts`. `OuterRequestDeps.db` gains the field. How a settings merge treats an
  object-valued field is read in the [persistence guide](../structure/persistence.md) before the type is fixed; if
  two devices' edits of different kinds would overwrite each other, the slice reports it and stops for a decision.
- Both outer loops call the shared check in place of their own banned-script loop (D4, D5).
- Tests: `shared/llm/tests/responseChecks.test.ts` (normalizing twice changes nothing; thoughts, markers, whitespace,
  and a surrogate pair in the measure); `server/src/tests/llmCharsetRetries.test.ts` (a short answer is retried and
  then accepted, the budget ends in the message, a kind without a minimum is untouched, a continue is not measured,
  a `previewBody` result passes both checks); the tab loop in `src/ts/process/request/tests/`;
  `normalizeSections.test.ts` and `upstreamExport.test.ts` for the field.
- Focused: `pnpm --silent test:agent shared/llm src/ts/process/request
server/src/tests/{llmCharsetRetries,llmRequests,normalizeSections,upstreamExport}.test.ts`, and the `slow` cases of
  `llmCharsetRetries.test.ts`.
- Done when a buffered request of a kind with a minimum is retried and then failed on both runtimes, and every
  existing banned-script test passes unchanged.

### 2. Reply streams in `runSpeaker` (_hard_)

Depends on 1.

- After a completed read, the reply's text (`readReply`'s `result`, without a continue's prefix) goes through the
  shared check (D4 applies).
- A full stream fails as in D6. A quiet stream retries as in D7 and D8.
- Tests in `server/src/tests/promptRunner.test.ts`, beside `Half Streaming`: a short quiet reply is requested again
  and the second answer is stored in the one row with one `accepted`; a banned script does the same; the budget's
  end fails the send with the last text stored; an abort between attempts stops; a retry that answers buffered is
  stored; a short full stream fails with its text stored and no second request; a short in-place reroll restores
  the previous candidate; a continue is not measured.
- Guides: [server generation](../structure/server-generation.md) "Streamed and buffered replies" (a stream no longer
  skips the checks) and [LLM requests](../structure/llm-requests.md) (a "Response checks" flow, the Tests list, the
  Limitations of D9).
- Focused: `pnpm --silent test:agent server/src/tests/{promptRunner,llmCharsetRetries}.test.ts`.
- Done when the three reply paths (buffered, Half Streaming, full stream) behave as D5 to D7 say, shown by the tests.

### 3. The settings page and its names (_small_)

Depends on 2, so that the page's notes describe what runs.

- `RequestInterceptionSettings.svelte` gains the "Response checks" section (D10): one number field per request kind,
  labelled as the rule rows label kinds (`modeLabel`), writing a new `minResponseLength` object on each edit.
- Strings in `src/lang/en.ts` and `src/lang/ko.ts`: the page title and navigation label, the two section headings,
  the fields, the "Inserted prompts" labels, and notes that say: the count is of visible characters after trimming;
  a script's or a plugin's request of the same kind is measured too; a continue is not measured; a fully streamed
  reply fails without a retry and keeps its text; an image-only reply fails; the banned-script list is on the
  Advanced page.
- The page's search entry (`src/ts/setting/searchIndex.ts`) and `e2e/settingsPages.spec.ts` follow the new title.
- Tests: `RequestInterceptionSettings.test.ts` (an edit writes the object, 0 removes the kind, the rule list is
  untouched); `src/ts/setting/searchIndex.test.ts`; `pnpm --silent test:agent --e2e e2e/settingsPages.spec.ts`.
- Guides: [settings](../structure/settings-i18n.md) Pages.
- Done when a minimum set on the page is the one a request reads, in the English and the Korean UI.

## Manual Checks

For the owner, after slice 3; a check that is not run moves to the manual checks backlog when the plan is retired.

- With a real provider and a minimum on the chat reply: an empty or refused reply is regenerated without Response
  Streaming and with Half Streaming, and fails with its text left in place with Response Streaming.
- Half Streaming: the token estimate restarts on a regeneration, and stop during a retry keeps what had arrived.
- A minimum on the emotion or translation kind set too high fails those requests with a message that names the
  minimum.
- Phone width: the six number fields and their labels fit the page.
