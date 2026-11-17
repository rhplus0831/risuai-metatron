# Request Interception Plan audit, 2026-11-18

- Plan: `docs/plan/request-interception.md`
- Commit audited: `10283a11d`, the commit that added the plan; its code is that of `ace54e7da`. The corrected plan is
  committed with this report
- Mode: `full`
- Model: GPT-6-Astra (`xhigh`), read-only; report written by the session that drafted the plan (Claude Fable 5.2),
  before any plan-runner run

| Severity   | Count |
| ---------- | ----- |
| P1         | 1     |
| P2         | 3     |
| P3         | 8     |
| unverified | 0     |

All twelve findings are `fixed in plan`. The first turn filed A1 to A10. The second turn read the drafted corrections,
confirmed all ten, and filed A11 and A12 against two sentences the corrections had added; those two are fixed as the
auditor suggested and were not sent back for a third turn.

Astra changed no file and ran no test or type check: the audit is a reading of the code. The read-only check reported
no violation in either turn. The two turns took about 19 minutes and 8.3 M tokens.

Found consistent: the six modes and the sub-slot fallback that leaves the mode unchanged (`shared/llm/request.ts:8`,
`shared/llm/modelSlots.ts:83`); `PromptItemPlain` (`shared/prompt.ts:19`); a `providers` field reaching `RequestDb`
with no forwarder (`server/src/llm/settings.ts:26`, `:203`) and the boot fixture coupling
(`server/src/tests/normalizeSections.test.ts:17`); `normalizeProviders` as the one place for the repair, reached by
writes, startup, and snapshot validation (`server/src/data/normalize/providers.ts:56`,
`server/src/data/resourceStore.ts:1563`, `:1037`, `:684`); nested bindings saving through the record wrapper
(`src/ts/storage/records.svelte.ts:2649`) with the list as one conflict unit (`src/ts/storage/recordMerge.ts:7`); the
upstream export's removal and report (`server/src/data/upstream/exportDatabase.ts:421`) and the closed plugin allowlist
(`src/ts/plugins/plugins.svelte.ts:816`); nothing between the clone and `reformater` reading the prompt
(`server/src/llm/request.ts:541`, `:588`), multi-generation and continue being independent of its contents (`:546`,
`:548`); fresh clones per attempt (`server/src/llm/outer.ts:172`, `src/ts/process/request/request.ts:436`) and tool
continuations that extend the built body without re-entering the request function
(`server/src/llm/openAI/requests.ts:809`, `server/src/llm/openAI/responses.ts:484`, `server/src/llm/anthropic.ts:1214`,
`server/src/llm/google.ts:778`); batching, translation, Lua, the AI Access tool, the Structured Memory writer, and
image-prompt generation all passing the request layer (`server/src/llm/anthropic.ts:661`,
`server/src/translation/runner.ts:342`, `server/src/lua/bindings.ts:1084`, `server/src/mcp/internal.ts:365`,
`server/src/prompt/memory/structured/writer.ts:183`, `src/ts/process/stableDiff.ts:72`); only Plugin and WebLLM passing
the tab's formatter and a job's plugin callback calling the provider directly
(`src/ts/process/request/request.ts:737`, `src/ts/network/jobChannel.ts:1030`); the four reservation sites and
tokenizing a message outside `formated` (`server/src/prompt/assemble.ts:2592`, `:2606`, `:2626`, `:3234`, `:1557`,
`shared/prompt/chatTokens.ts:47`); the reply request being `model` for group speakers, continues, rerolls, and command
parts (`server/src/prompt/runner.ts:668`, `:1936`, `server/src/jobs/commandRunner.ts:345`); the additive history
column with the version kept at `"1"` (every history query names its columns, `server/src/data/requestHistory.ts:469`;
pruning by stored bytes, `:207`, `:631`; the file outside resource backups, `server/src/routes/backups.ts:277`);
`describe` reaching both history paths once per attempt (`server/src/llm/requests.ts:674`, `:805`, `:1432`,
`server/src/llm/historyObserver.ts:70`); `replacePrompt` having no caller, the two `editedPreset.promptSettings` reads
being the only ones, and `TextAreaInput` without highlighting keeping the popup editor
(`src/lib/UI/PromptDataItem.svelte:318`, `:382`, `src/lib/UI/GUI/TextAreaInput.svelte:382`, `:413`); menu index 26
being free (`src/ts/settingsMenu.ts:24`) and both new files getting an owner (`docs/structure/ownership.json:448`,
`:238`).

Re-check list: the plan relies on none of the four entries. It adds no `patchMessage` call, no feed row, no store
table (`STORE_TABLES_SQL` still runs only for `user_version === 0`, `server/src/data/resourceStore.ts:3862`; the
history store's `ALTER TABLE` is separate), and no delivery assumption. The auditor noted that two entries no longer
describe the code exactly: chat rows can now travel as field-level `rowDelta` payloads
(`server/src/data/chatStore.ts:1977`, `:2017`), and `sendText` returns false for an overloaded socket it terminates
(`server/src/jobs/generationJobs.ts:1059`, `:1074`). The list itself is not changed here.

## P1

### A1 — Goal: the insertion is not the last chance to change the request — fixed in plan

- Plan (Goal): "after every plugin replacer and trigger, so nothing later can remove or reorder what they insert." D1
  used the same claim as its reason to keep the plugin database API closed.
- Code: after `reformater` the OpenAI adapter applies additional parameters
  (`server/src/llm/openAI/requests.ts:644`), which can delete a body field or replace it with JSON
  (`server/src/llm/shared.ts:119`, `:133`): `["messages", "json::[]"]` removes every inserted message. A buffered
  request names a body interceptor (`openAI/requests.ts:740`); the transport takes the replacement body it returns
  (`server/src/llm/transport.ts:439`, the streaming path at `:525`), and for a job that is each plugin's
  `bodyIntercepter` callback (`server/src/llm/requests.ts:316`, `src/ts/network/jobChannel.ts:887`).
- Correction, confirmed: the Goal now says the rules are the last prompt-level step, after the replacers and the
  `request` trigger and before the request is shaped for its model, and that additional parameters, a plugin's body
  interceptor, and a plugin provider keep their authority. A baseline bullet "What runs after" cites the code, D1's
  reason was reworded, the settings page gains a note, and Out of scope lists the protection. The insertion mechanism
  is unchanged.

## P2

### A2 — Original code: three summarization paths do not pass the request layer — fixed in plan

- Plan (Original code): "Every provider request except a tab's own plugin-provider and WebLLM requests runs through
  the server's `requestChatDataMain`." The Goal lists memory among the covered requests.
- Code: the HypaV3 modal's `summarize` with a summarization model other than `subModel` calls `chatCompletion`
  directly (`src/lib/Others/HypaV3Modal.svelte:563`, `src/ts/process/memory/hypav3.ts:1633`,
  `src/ts/process/webllm.ts:32`). Fixed-model SupaMemory and HypaV2 call `host.completions`
  (`server/src/prompt/memory/supaMemory.ts:247`, `server/src/prompt/memory/hypav2.ts:40`), which posts to the
  completions endpoint itself (`server/src/prompt/runner.ts:917`). The local DistilBART summarizer is another host
  service (`runner.ts:936`). None has a mode, so a rule's `memory` checkbox does not reach them.
- Correction, confirmed: coverage is "every request made in one of the six modes"; a baseline bullet "Outside the
  request layer" names the three paths; the Goal, a page note, slice 1's closing sentence and guide list, and Out of
  scope say so. No interception is added to those paths.

### A3 — D1: the bug-report settings export would have carried the rule text — fixed in plan

- Plan (D1): "The upstream export leaves the field out"; slice 1 listed only `METATRON_ONLY_SETTINGS`.
- Code: a `providers` field appears in the settings views (`src/ts/storage/settingsViews.svelte.ts:657`, `:1006`), and
  `rootSnapshot` copies every settings root (`src/ts/storage/snapshots.svelte.ts:35`). `buildSettingsReport` removes
  only `REPORT_REMOVED_KEYS`, the secret sections, and names containing `key`, `proxy`, or `hypa` (`:148`).
  `requestInterceptions` matches none, so the whole list, text included, would have reached the downloaded report and
  the clipboard (`src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte:43`). Comparable authored content is
  already excluded (`snapshots.svelte.ts:121`, `:130`, `:133`).
- Correction, confirmed: D1 adds the field to `REPORT_REMOVED_KEYS` next to `inputHooks`; slice 1 lists it and
  `src/ts/storage/tests/snapshots.test.ts`. Ordinary backups and snapshots keep the field.

### A4 — D3: the meter's occupied total would have left the reservation out — fixed in plan

- Plan (D3): "validated like `toolSchemas` ... and added to the fixed share. The meter shows it as its own row next to
  the tool schema row."
- Code: `ContextReport.input` is the assembled messages alone (`server/src/prompt/assemble.ts:3039`). The meter
  computes `occupied = report.input + toolSchemas` on its own (`src/lib/ChatScreens/ContextMeter.svelte:146`), and that
  value drives the percentage (`:519`) and the displayed count (`:1122`). With an input of 600, a reservation of 100,
  and a prompt budget of 800, the meter would have shown 600 and 75% while 700 were taken.
- Correction, confirmed: D3 adds the field to the occupied total; slice 3 tests the count and the percentage, not only
  the row.

## P3

### A5 — Original code: a job's WebLLM request does not go to its tab — fixed in plan

- Plan: "A job's plugin provider and WebLLM ... `requestPlugin` hands the already reformatted prompt to the job's tab."
- Code: only Plugin takes `requestPlugin` (`server/src/llm/request.ts:632`); WebLLM takes `requestWebLLM` (`:630`),
  which calls the server's `ctx.localGeneration` (`:765`, supplied at `server/src/app.ts:514`).
- Correction, confirmed: the two are described separately; both pass the server insertion once.

### A6 — Original code: the tab's outer loop runs no request trigger — fixed in plan

- Plan: "The outer loops run the plugins' `replacerbeforeRequest` hooks and the `request` trigger before every attempt."
- Code: the server loop runs both (`server/src/llm/outer.ts:149`, `:153`); the tab runs the replacers
  (`src/ts/process/request/request.ts:421`) and states that the trigger runs only in server jobs (`:434`).
- Correction, confirmed: both loops run the replacers; only a job's server loop runs the trigger.

### A7 — Original code and D2: DeepSeek is not the only adapter that reads the last entry — fixed in plan

- Plan: "only the DeepSeek `prefix` handling reads 'the last entry is an assistant'"; D2 called keeping a trailing
  assistant last "the harmless reading".
- Code: DeepSeek's thinking-input handling (`server/src/llm/openAI/requests.ts:185`), Anthropic's tool continuation
  extending a last assistant (`server/src/llm/anthropic.ts:1149`), Google merging a model turn into the preceding one
  (`server/src/llm/google.ts:801`), and Cohere folding the entries after the last user into `message`
  (`server/src/llm/request.ts:1470`).
- Correction, confirmed: the baseline lists them, and D2 says the rule keeps the entry's position before `reformater`
  without promising a separate, unchanged last message on the wire. The auditor found no failure that needs another
  insertion rule.

### A8 — D3 and slice 3: the assembly host belongs to `runSpeaker` — fixed in plan

- Plan: "`runSend` (`server/src/prompt/runner.ts:1728-1832`) passes ..."
- Code: `runSend` calls `runSpeaker` (`server/src/prompt/runner.ts:678`), which begins at `:1076` and owns the host
  literal at `:1728`.
- Correction, confirmed: both places name `runSpeaker`.

### A9 — D5: a support share builds its summary field by field — fixed in plan

- Plan: "It is summary metadata, so it is kept with content capture off."
- Code: `sharedRecord` constructs the shared summary explicitly (`server/src/diagnostics/share.ts:224`, returned at
  `:250`, spread at `:254`); a new summary property does not enter it by itself.
- Correction, confirmed: D5 adds the count to that summary, and slice 4 lists `server/src/tests/requestShare.test.ts`.

### A10 — Slices: independent in function, not in files — fixed in plan

- Plan (slice 4): "Independent of slices 2 and 3; it can be dropped without touching them." No slice named a shared
  file.
- Code: slices 1 and 4 both edit `server/src/llm/request.ts` (`:541`, `:561`); slices 2, 3, and 4 all add strings to
  `src/lang/en.ts` and `src/lang/ko.ts` (the meter's are at `en.ts:2263`, `ko.ts:1637`; the viewer's labels are
  localized, `src/lib/Others/RequestLogs/ServerRequestHistory.svelte:268`).
- Correction, confirmed: the Slices section says the slices run in order, one at a time, and lists the shared files;
  slice 4's sentence is narrowed to "needs slice 1's count and nothing of slices 2 and 3".

### A11 — D2: a cache prefix changes with more than a rule's text — fixed in plan

- Plan (D2, added by the corrections): "a `start` rule changes the cached prefix only when its text changes."
- Code: cache points are set during assembly (`server/src/prompt/assemble.ts:2450`, `:2483`), merged by `reformater`
  (`server/src/llm/request.ts:312`, `:329`), and turned into cache controls by the adapter
  (`server/src/llm/anthropic.ts:226`). Enabling, reordering, or changing the role or modes of a `start` rule changes
  the prefix too.
- Correction, as the auditor suggested: a `start` message becomes part of the prefix before the existing cache points,
  so enabling, reordering, or editing a `start` rule can cost a cache miss.

### A12 — D1: the store's admission is serialization, not a plain-JSON check — fixed in plan

- Plan (D1, added by the corrections): "a value that is not plain JSON is a 400 before any normalizer runs."
- Code: the store serializes the input before normalizing it (`server/src/data/resourceStore.ts:3765`), applying
  `toJSON`, dropping undefined fields, and converting dates (`:3769`, `:3787`;
  `server/src/tests/resourceStore.test.ts:949`); a serialization failure is a 400
  (`server/src/routes/resources.ts:605`).
- Correction, as the auditor suggested: the admission refuses a non-finite number, an unserializable value, or
  excessive nesting with a 400, and its conversions are unchanged.

## Noted, not recommended

- Counting late reservations in the memory steps' own planning: the steps do not see tool schemas either, and the
  final recheck frees both (`server/src/prompt/assemble.ts:2016`, `:2578`).
- A per-rule merge for two tabs' concurrent edits: the one-field conflict is the existing section behavior.
- The `outputTokens` clamp after a recheck that already fits or fails is redundant today; the plan keeps its
  arithmetic in step (`assemble.ts:2599`, `:2625`).
- Byte-for-byte preservation of an inserted message on the wire: merging, prefill handling, and folding are the
  adapters' (`server/src/llm/openAI/requests.ts:142`, `server/src/llm/request.ts:303`).
