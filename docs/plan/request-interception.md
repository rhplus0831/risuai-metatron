# Request Interception Plan

Status: drafted 2026-11-17 at `ace54e7da` and committed at `10283a11d`, then audited against the code at that commit
([report](../reports/audits/plan-runner/request-interception-2026-11-18.md)) and corrected in the same commit as the
report. The agreed decisions are the user's of 2026-11-17; D1 to D5 are this plan's own and open to the user's change.
The limits stated in the Goal (what rewrites the request body afterwards, the summaries outside the request layer),
the settings report exclusion, the meter's occupied total, and the slice order took their present form from the audit.
Landed: 1 (`3e872255e`), 2 (`b5d61469e`), 3 (`353cb4ac8`), 4 (`d267dbe6b`).

- 2026-11-17: first draft, written after a design discussion with the user. The user's answers are recorded under
  **Agreed decisions**.
- 2026-11-18: corrected after the audit (twelve findings, all fixed in the plan).

Sources: the code at `ace54e7da` (anchors below are from that commit; re-verify before editing) and the discussion with
the user.

Owning guides:

- [llm-requests](../structure/llm-requests.md): the rule shape and the insertion (`shared/llm/`), the server and tab
  `requestChatDataMain`.
- [settings-i18n](../structure/settings-i18n.md): the new settings page, `PromptDataItem.svelte`, strings.
- [persistence](../structure/persistence.md): the `providers` section field and its normalization.
- [chat-pipeline](../structure/chat-pipeline.md) and [server-generation](../structure/server-generation.md): assembly's
  final token recheck and the context report.
- [ui-theming](../structure/ui-theming.md): `ContextMeter.svelte`.
- [diagnostics](../structure/diagnostics.md): the request history row.
- [backup-sync-hub](../structure/backup-sync-hub.md): the upstream export.

## Goal

The user wants one place to say "put this prompt into every request", whatever built the request: the chat reply, a
Lua or trigger call, a plugin, translation, memory. Today the only ways are a prompt preset item (the chat reply only,
and per preset) or a plugin's `beforeRequest` replacer (code, and other plugins run after it).

Request interception is a list of rules in the settings. Each rule holds one prompt (role and text), the request modes
it applies to, and whether it goes to the start or the end of the request. The rules are applied as the last
prompt-level step: after every plugin `beforeRequest` replacer and the `request` trigger, and before the request is
shaped for its model.

What works on the provider body afterwards keeps its authority and can still change or drop the inserted text: the
user's own additional parameters, a plugin's body interceptor, and a plugin provider (see **Original code**). The
feature covers requests made through the request layer in one of its six modes; summaries made with a fixed
summarization model never pass it.

## Agreed decisions

The user accepted these on 2026-11-17.

1. **Scope: one global rule list.** Not per model profile, prompt preset, character, or chat. A profile filter can be
   added to a rule later without changing the stored shape of the existing fields.
2. **Targets are request modes**, not model slots: `model`, `submodel`, `memory`, `emotion`, `translate`, `otherAx`
   (`ModelModeExtended`, `shared/llm/request.ts:8`). An unset auxiliary slot falls back to the sub slot, so "the sub
   model" as a slot would silently include translation, memory, and emotion requests; a mode never does. A new rule
   targets `model` only.
3. **No CBS.** A rule's text is sent as written. Translation, playground, and plugin requests have no character or chat
   to evaluate `{{char}}` or variables against.
4. **Positions: `start` and `end` only.** No depth and no "before the last user message".
5. **The editor reuses `PromptDataItem.svelte`**, restricted to the plain item, in a new settings entry.

## Original code (baseline)

- **Where requests converge.** Every request made in one of the six modes, except a tab's own plugin-provider and
  WebLLM requests, runs through the server's `requestChatDataMain` (`server/src/llm/request.ts:491`): a job's requests
  (`runInJob`, `server/src/llm/requests.ts:1051`), and every tab request through `POST /api/llm/request`
  (`server/src/llm/requests.ts:1498`). It clones the prompt (`request.ts:541`), reports the model to the request
  history (`ctx.describe`, `:561`), resolves the credential, calls `reformater` (`:588`), and dispatches by format.
- **Outside the request layer.** Three summarization paths send a model request without a mode and without
  `requestChatDataMain`: the HypaV3 modal's `summarize` with a summarization model other than `subModel`
  (`src/ts/process/memory/hypav3.ts:1633`, `chatCompletion` of `src/ts/process/webllm.ts`); SupaMemory and HypaV2 with a
  fixed model, through `host.completions` (`server/src/prompt/memory/supaMemory.ts:247`,
  `server/src/prompt/memory/hypav2.ts:40`, `server/src/prompt/runner.ts:917`); and the local DistilBART summarizer.
  Token counting and embedding requests are separate too.
- **A job's plugin provider and WebLLM** also go through the server function. `requestPlugin` hands the already
  reformatted prompt to the job's tab (`request.ts:647-673`), which calls the provider directly
  (`src/ts/network/jobChannel.ts:1018-1035`) and never enters the tab's `requestChatDataMain`. `requestWebLLM` runs on
  the server through `ctx.localGeneration` (`request.ts:733-765`).
- **The tab's own two formats.** The tab's `requestChatDataMain` (`src/ts/process/request/request.ts:670`) sends every
  other format to the server (`:737-740`) and runs `LLMFormat.Plugin` and `LLMFormat.WebLLM` itself: clone (`:748`),
  `reformater` (`:764`), dispatch (`:772`).
- **What runs before.** Both outer loops run the plugins' `replacerbeforeRequest` hooks before every attempt and write
  the result back into the loop's own prompt (`server/src/llm/outer.ts:149-151`,
  `src/ts/process/request/request.ts:421-427`); only a job's server loop also runs the character's `request` trigger
  (`outer.ts:153-166`, `request.ts:434`). Plugin v3's `runLLMModel` calls the tab's `requestChatDataMain` directly and
  skips the loop (`src/ts/plugins/apiV3/v3.svelte.ts:3748`).
- **What runs after.** The adapters work on the provider body after `reformater`. Additional parameters can delete or
  replace any body field, `messages` included (`server/src/llm/openAI/requests.ts:644`, `server/src/llm/shared.ts:119`,
  `:133`). A plugin's body interceptor receives the body and may return another
  (`server/src/llm/transport.ts:437-439`, `src/ts/network/jobChannel.ts:884-890`). A plugin provider receives the
  prompt and sends what it likes.
- **Retries and tool follow-ups.** Each attempt is a new `requestChatDataMain` call on a fresh clone. The adapters
  build their provider body once and append tool calls and results to that body for a follow-up; none re-enters
  `requestChatDataMain` (`server/src/llm/openAI/requests.ts:809-887`, `server/src/llm/openAI/responses.ts:477-536`,
  `server/src/llm/anthropic.ts:1139-1219`, `server/src/llm/google.ts:776-920`).
- **Prefill.** `formated` has no prefill marker (`shared/openai.ts:8`). `promptSettings.assistantPrefill` is declared
  but never emitted. A prefill is a trailing `assistant` entry from the prompt template. Several adapters read the
  last entry: DeepSeek's `prefix` and thinking-input handling (`server/src/llm/openAI/requests.ts:178-185`), Anthropic's
  tool continuation, which extends a last assistant (`server/src/llm/anthropic.ts:1149`), Google's merge of a model turn
  into a preceding one (`server/src/llm/google.ts:801`), and Cohere, which folds the entries after the last user into
  its `message` (`server/src/llm/request.ts:1470`).
- **Settings a request reads.** `RequestDb` picks every `providers` section field (`server/src/llm/settings.ts:44-67`).
  A job loads it once and keeps it for all of its requests (`server/src/jobs/jobScope.ts:321-333`); a tab `POST` loads
  it per request.
- **Token budget.** Assembly's final recheck keeps `maxResponse` and the tool schema charge free
  (`server/src/prompt/assemble.ts:2578-2627`); the charge comes from `AssemblyHost.toolSchemaTokens` (`:209`), is
  subtracted from the trim headroom (`:3234`), and is reported as `ContextReport.toolSchemas`
  (`shared/contextReport.ts:132`, `assemble.ts:3040`). `ContextReport.input` is the assembled messages alone; the
  meter adds the tool schemas to it for its occupied total and percentage
  (`src/lib/ChatScreens/ContextMeter.svelte:146`) and shows them as their own row (`:1191-1200`). Memory steps plan
  against the context size before the recheck and do not see late reservations (`assemble.ts:2016`, `:2113`).
- **Request history.** The row's `prompt` is the prompt the layer received, recorded before `requestChatDataMain`
  (`server/src/llm/requests.ts:792`, `:1401`); `describe` fills the model columns (`request.ts:561`,
  `server/src/data/requestHistory.ts:482`). The SQLite file refuses any version other than `"1"`
  (`requestHistory.ts:211`, `:545-548`), and every query names its columns. A support share builds its summary field
  by field (`server/src/diagnostics/share.ts:224`).
- **The settings report.** The bug-report export copies every settings root and removes the keys of
  `REPORT_REMOVED_KEYS`, which lists authored content such as `promptTemplate`, `translatorPresets`, and `inputHooks`
  (`src/ts/storage/snapshots.svelte.ts:121-133`, `:148`).
- **The editor row.** `PromptDataItem.svelte` reads `editedPreset` in three places: `replacePrompt` (`:134-150`, never
  called), the `cot` option (`:318`), and the `chatAsOriginalOnSystem` checkbox (`:382`). Reordering, removal, and the
  opened state are the parent's (`PromptSettings.svelte:84-135`, `:200-276`). Its text areas use `TextAreaInput` with
  CBS highlighting and autocomplete (`:331`).
- **A settings page of this kind.** Input Hooks: a menu constant (`src/ts/settingsMenu.ts:24`), a `navGroups` entry and
  a page branch (`src/lib/Setting/Settings.svelte:130-133`, `:389`), a route slug (`src/ts/router/routes.ts:43`), a
  search page row (`src/ts/setting/searchIndex.ts:199`), and a hand-written page
  (`src/lib/Setting/Pages/InputHookSettings.svelte`). `Settings.svelte` imports the menu constants through the
  re-export in `src/ts/stores.svelte.ts:107`, and `e2e/settingsPages.spec.ts:24` lists the pages by hand.

## Design decisions (made by this plan)

### D1. Rule shape and storage

```ts
// shared/llm/interception.ts
export type RequestInterception = {
  id: string;
  enabled: boolean;
  modes: ModelModeExtended[];
  position: "start" | "end";
  /** `type: "plain"`, `type2: "normal"`; `name` is the rule's label. */
  prompt: PromptItemPlain;
};
```

- The prompt is stored as a `PromptItemPlain` so the editor binds it without a conversion (agreed decision 5). Its
  `role` is the prompt template's (`user`, `bot`, `system`); `bot` is sent as `assistant`.
- `Database.requestInterceptions: RequestInterception[]`, a `providers` section field with the default `[]`. `RequestDb`
  then carries it with no further wiring, and a job's later requests use the list the job started with.
- `normalizeRequestInterceptions(input)` in the same shared module, called from `normalizeProviders`
  (`server/src/data/normalize/providers.ts`), following `normalizeUi`'s `blockedRealmCreators` repair
  (`server/src/data/normalize/ui.ts:142-151`):
  - dropped: an entry that is not an object, has no string `id`, repeats an `id`, or whose `prompt.text` is not a
    string; entries past `MAX_REQUEST_INTERCEPTIONS` (32);
  - repaired: `enabled` that is not `true` becomes `false`; `modes` keeps known modes once each; `position` other than
    `end` becomes `start`; `prompt` is rebuilt as `{ type: "plain", type2: "normal", text, role, name? }` with an
    unknown `role` becoming `system`.

  The store's serialization admission still runs before any normalizer: a non-finite number, an unserializable value,
  or excessive nesting is refused with a 400, and its JSON conversions are unchanged.

- The list is one field of the section, so it is one conflict unit: two tabs that edit different rules at the same time
  conflict as any section array does, and the losing tab takes the server's list. No per-rule merge is added.
- The upstream export leaves the field out: add it to `METATRON_ONLY_SETTINGS`
  (`server/src/data/upstream/exportDatabase.ts:128`), so a non-empty list is reported as not exported.
- The settings report for a bug report leaves it out too: add it to `REPORT_REMOVED_KEYS`
  (`src/ts/storage/snapshots.svelte.ts`), next to `inputHooks`. The rule text is the user's own prompt. Ordinary
  backups and snapshots keep the field, as they keep every `providers` field.
- The plugin database API stays closed to it: the field is not added to `allowedDbKeys`
  (`src/ts/plugins/plugins.svelte.ts:812-840`). A plugin with the list would hold the user's prompt text and a lasting
  way to change every request, and nothing in this feature needs it.

### D2. The insertion

```ts
// shared/llm/interception.ts
export function interceptionMessages(
  rules: readonly RequestInterception[] | undefined,
  mode: ModelModeExtended,
): { start: OpenAIChat[]; end: OpenAIChat[] };

export function applyRequestInterceptions(
  formated: OpenAIChat[],
  rules: readonly RequestInterception[] | undefined,
  mode: ModelModeExtended,
): { formated: OpenAIChat[]; applied: number };
```

- A rule applies when it is enabled, lists the request's mode, and its text is not blank. It yields one message:
  `{ role, content: text }`.
- `start` messages go to the front in list order; `end` messages go to the back in list order. When the last entry of
  the prompt is an `assistant`, the `end` messages go immediately before it, so a prefill stays last. This also holds
  for a trailing assistant that is ordinary history: the rule cannot tell the two apart. The rule keeps the entry's
  position before `reformater`; it does not promise a separate, unchanged last message on the wire, since
  `reformater` and the adapters merge and fold entries as they do today.
- The function returns a new array and does not mutate its input or the rules. `applied` is the number of messages
  inserted.
- **Server:** in `requestChatDataMain`, at the clone (`server/src/llm/request.ts:541`):
  `applyRequestInterceptions(structuredClone(arg.formated), db.requestInterceptions, model)`. Nothing between the clone
  and `reformater` reads the prompt, so this is the step before `reformater`, and the count is known before
  `ctx.describe` (D5). `reformater` then treats an inserted message as any other: a leading `system` joins the first
  system block, other `system` messages become the replacement role on models without full system support, and
  same-role neighbours merge under `requiresAlternateRole`.
- **Tab:** the same call before `reformater` in the tab's `requestChatDataMain`
  (`src/ts/process/request/request.ts:764`), reading `settings.providers.requestInterceptions`. Only the tab's own
  Plugin and WebLLM requests reach it; a job's plugin request is already covered by the server and must not be
  inserted into again in `src/ts/network/jobChannel.ts`.
- Consequences, all intended:
  - A retry does not accumulate copies (each attempt inserts into a fresh clone).
  - A tool follow-up keeps the inserted messages; tool calls and results come after an `end` message.
  - The `model` mode is more than the chat reply: Lua `LLMMain`, a trigger's `runLLM`, the OOC answer, the subtitle
    playground, the AI Access tool, and a plugin's `runLLMModel` all pass it. That is the feature ("every request").
  - The Developer tool's "As Request" preview shows the inserted messages for the adapters that support it (it runs
    the request layer with `previewBody`; Plugin and WebLLM answer that they cannot preview). The plain message
    preview does not show them.
  - Cache points are set during assembly (`assemble.ts:2450`), before the insertion, and an inserted message gets none
    of its own. A `start` message becomes part of the prefix before the existing cache points, so enabling, reordering,
    or editing a `start` rule (its role, modes, or text) can cost a cache miss.

### D3. Keeping the tokens free

Assembly finishes its budget before the request layer inserts anything, so the reply request's insertions get the same
treatment as tool schemas.

- `AssemblyHost.insertedMessages?: readonly OpenAIChat[]`: the messages the reply request will insert. `runSpeaker`
  (reached from `runSend`; the host literal is at `server/src/prompt/runner.ts:1728-1832`) passes the `start` and `end`
  lists of `interceptionMessages(requestDb.requestInterceptions, "model")` for every job kind, `preview` included
  (unlike tool schemas, nothing is listed over the network). The reply request is always mode `model`
  (`runner.ts:1936`), for group speakers, continues, rerolls, and command parts too.
- Just before the final recheck (`assemble.ts:2578`), assembly counts them with its own `tokenizeChat` and adds the sum
  to the reserved amount everywhere `toolSchemaTokens` is used: `promptBudget` (`:2592`), the required-tokens error
  (`:2606`), the `outputTokens` clamp (`:2626-2627`), and the trim headroom (`:3234`).
- `ContextReport.interceptions?: number` (present only when positive), validated like `toolSchemas`
  (`shared/contextReport.ts:337`) and added to the fixed share (`:614`). `ContextReport.input` stays the assembled
  messages alone, so the meter adds the field to its occupied total (`ContextMeter.svelte:146`, which drives the
  percentage and the displayed count) and shows it as its own row next to the tool schema row.
- Memory steps that plan against the context size before the recheck do not see the reservation, exactly as they do
  not see tool schemas: the final recheck frees it by removing removable history, and refuses when only protected
  content is left. This plan does not change that policy.
- Auxiliary requests (memory, translation, emotion, and the rest) have no assembly budget and get no reservation. A
  rule that targets them can push such a request over its model's context; the page says so (D4).

### D4. The settings page

- A new entry "Request interception" in the same nav group as Input Hooks: `REQUEST_INTERCEPTION_SETTINGS_MENU` (the
  next free index; 26 at the baseline) with its re-export in `src/ts/stores.svelte.ts`, a `navGroups` entry and page
  branch in `Settings.svelte`, the route slug `request-interception`, a page row in `searchIndex.ts`, and a row in the
  page list of `e2e/settingsPages.spec.ts`, each next to the Input Hooks line. The page is hand-written, so it adds no
  catalog items (`settingsPageSections.test.ts` does not apply).
- `src/lib/Setting/Pages/RequestInterceptionSettings.svelte`: a short description, the rule list, and an add button.
  A new rule is enabled, targets `model`, has the position `start`, and holds an empty plain prompt with the role
  `system`; its `id` comes from `newId()`. The list is `settings.providers.requestInterceptions`; rows are keyed by
  rule `id`, and reordering, removal, and the opened set follow `PromptSettings.svelte`'s index handling, because list
  order is insertion order.
- Each rule is one `PromptDataItem` row bound to `rule.prompt`, with the rule's own controls passed in:
  - an enabled toggle,
  - six mode checkboxes, labelled with the existing `language.model`, `language.submodel`, and
    `language.modelProfiles.auxModes[mode]`,
  - the position select (start, end).
- `PromptDataItem.svelte` changes, all with defaults that keep the prompt template page as it is:
  - delete the unused `replacePrompt`;
  - `allowedTypes?: readonly PromptType[]`: the type select offers only these, and is hidden when there is one;
  - `promptSettings?: Pick<PromptSettings, "customChainOfThought" | "sendChatAsSystem">`: replaces the two
    `editedPreset.promptSettings` reads; `PromptSettings.svelte` passes the preset's, and the component no longer
    imports `editedPreset`;
  - `showType2?: boolean` (default true): the interception page hides the normal/main/global-note select;
  - `cbs?: boolean` (default true): off, the text area is plain, without CBS highlighting or autocomplete (agreed
    decision 3: a highlighted `{{user}}` would promise an evaluation that does not happen);
  - `extra?: Snippet`: rendered at the top of the opened row, for the rule's controls;
  - `popupEditorContext` is the rule `id`; the row's own identity guard (`:54`) stays.
- Notes on the page, as plain text under the list:
  - the text is sent as written, without CBS;
  - `memory` and `emotion` answers are parsed (the Structured Memory writer expects JSON, the emotion step one word), so
    a rule there can break them;
  - a summary made with a fixed summarization model is not a `memory` request and is not intercepted;
  - only the chat reply reserves context for the inserted text;
  - additional parameters and plugins that rewrite the request body run afterwards and can change the inserted text.
- Strings: a `requestInterception` namespace in `src/lang/en.ts` with Korean overrides in `src/lang/ko.ts`.

### D5. The request history count

- `describe`'s model gains an optional `interceptions?: number` (`server/src/llm/context.ts:51`, the `RequestModel` type
  in `server/src/llm/requests.ts:87-94`); `requestChatDataMain` passes `applied` when it is positive. `describe` runs
  once per attempt that reaches the insertion, for a job and for a tab `POST` alike (`requests.ts:674`); a request
  refused before it (a missing profile, a browser-only format) keeps a null count.
- The store adds a nullable `interceptions INTEGER` column: in the `CREATE TABLE` for a new file, and by
  `ALTER TABLE requests ADD COLUMN` when `PRAGMA table_info(requests)` lacks it, inside the opening transaction and
  before the statements are prepared (`requestHistory.ts:557`, `:592`). The schema version stays `"1"`: an
  older server names its columns in every query and keeps working on the file, where a version bump would make it run
  without a history.
- `RequestHistorySummary.interceptions: number | null` (`shared/requestHistory.ts:28`), shown in the expanded row of
  `src/lib/Others/RequestLogs/ServerRequestHistory.svelte` only when positive ("Intercepted: N prompts"). It is summary
  metadata, so it is kept with content capture off.
- A support share carries the count: add it to the summary `sharedRecord` builds
  (`server/src/diagnostics/share.ts:224`). It is a number, not prompt text.
- The row's `prompt` keeps its meaning (what the layer received). With content capture on, the exchange body shows the
  request as sent.
- A tab's own Plugin and WebLLM requests have no server history row and record nothing.

## Slices

Each slice updates its guides in the same commit and ends with V1 (`pnpm check`, `pnpm --silent test:agent`),
`pnpm format:check`, and `pnpm check:docs`.

The slices run in order, one at a time. Slices 2, 3, and 4 each depend on slice 1 only, but they share files and
cannot run in parallel:

- 1 and 4: `server/src/llm/request.ts` (the insertion and the `describe` call).
- 2, 3, and 4: `src/lang/en.ts` and `src/lang/ko.ts` (the page's strings, the meter row's, the viewer's).

### 1. Rule shape, storage, and insertion (_medium_)

- `shared/llm/interception.ts` (D1, D2) and `shared/database.ts`, `shared/sections.ts`
  (`SECTION_FIELDS.providers`), `server/src/data/normalize/providers.ts`.
- The two call sites (D2), `METATRON_ONLY_SETTINGS` and `REPORT_REMOVED_KEYS` (D1).
- Fixture: the new default in `src/ts/storage/tests/fixtures/boot/boot-snapshot.json`.
- Tests:
  - `shared/llm/tests/`: list order for both positions, the mode filter, disabled and blank rules, the trailing
    assistant, `bot` sent as `assistant`, no mutation of the input.
  - `server/src/tests/normalizeSections.test.ts`: each drop and repair of D1.
  - `server/src/tests/llmRequests.test.ts`: a request in a targeted mode is sent with the messages and one in another
    mode without; a `start` system message joins the first system block of a `hasFirstSystemPrompt` model; a retried
    request holds one copy.
  - `src/ts/process/request/tests/`: the tab's plugin-provider request receives the messages.
  - `server/src/tests/upstreamExport.test.ts`: the field is left out and reported.
  - `src/ts/storage/tests/snapshots.test.ts`: the settings report holds no rule list.
- Guides: llm-requests (`Files`, `Flows`, and the requests outside the layer under `Limitations`), persistence,
  backup-sync-hub.
- After this slice a list written into the settings by hand is applied to every request that passes the request layer;
  there is no page yet.

### 2. Settings page (_medium_)

- `PromptDataItem.svelte` and `PromptSettings.svelte` (D4), the new page, menu constant and its re-export, nav entry,
  route, search row, strings.
- Tests: `src/lib/UI/popupRowContext.svelte.test.ts` still passes unchanged; a page test beside
  `InputHookSettings.test.ts` (add, edit a mode, reorder, remove, each writing the list); `PromptDataItem` with
  `allowedTypes` of one type shows no type select and with `cbs` off renders a plain text area; the tests that
  enumerate pages (`src/ts/router/routes.test.ts`, `src/ts/setting/searchIndex.test.ts`,
  `src/lib/Setting/Settings.search.test.ts`) and the page list of `e2e/settingsPages.spec.ts`.
- Guides: settings-i18n (`Pages`, `Prompt editors`).

### 3. Token reservation and the context meter (_medium_)

- `AssemblyHost.insertedMessages`, the four uses in `assemble.ts`, `runSpeaker`, `ContextReport.interceptions`, the
  meter's occupied total, its row, and the row's string (D3).
- Tests: `server/src/tests/assemble.test.ts` (the recheck removes history to keep the reservation free; the error
  total and the `outputTokens` clamp include it; a rule for another mode reserves nothing); the context report parser
  and fixed share; the meter's occupied count and percentage with a reservation, and its row.
- Guides: chat-pipeline, server-generation (`Prompt job execution`), ui-theming.

### 4. Request history count (_small_)

- D5. It needs slice 1's count and nothing of slices 2 and 3: dropping it changes neither.
- Tests: `server/src/tests/requestHistory.test.ts` (a file created before the column gains it on open and keeps its
  rows; the count reads back), `server/src/tests/requestCapture.test.ts` (a real request's row holds the count),
  `server/src/tests/requestHistoryRoutes.test.ts` (the wire shape), `server/src/tests/requestShare.test.ts` (a share
  carries the count), the viewer.
- Guides: diagnostics.

## Verification

Per slice: the gate above, V6 for each new test (it fails with the guarded line broken), and V4 for the new exports.

Manual checks, for the user after slice 2 (unrun ones go to the manual checks backlog when the plan closes):

- A `start` system rule for `model`: the Developer tool's "As Request" preview shows the text in the system prompt, and
  a real reply follows it.
- An `end` rule with a prompt preset that ends in an assistant prefill: the prefill is still the last message.
- A rule for `translate` only: a chat reply is unchanged and a translation request carries the text.
- Reorder two `start` rules: the request follows the new order.
- A reply that calls an MCP tool: the follow-up request still carries the text once.
- The context meter shows the interception row after slice 3, and the server history shows the count after slice 4.
- The upstream export reports the rule list as not exported.

## Out of scope

- CBS or variables in a rule's text.
- Targeting by model profile, prompt preset, character, or chat.
- Positions other than start and end.
- Changing or removing existing messages, and anything on the response side.
- Plugin access to the rules.
- A context reservation for auxiliary requests.
- Image generation, TTS, and embedding requests: they do not pass `requestChatDataMain`.
- Protecting the inserted text from what rewrites the provider body afterwards: additional parameters, plugin body
  interceptors, plugin providers.
- Summaries made outside the request layer: the HypaV3 modal with a fixed summarization model, fixed-model SupaMemory
  and HypaV2, the local summarizer.
- A per-rule merge of two tabs' concurrent edits.
- Counting the reservation in the memory steps' own planning.
