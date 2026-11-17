# Request Interception Plan

Status: draft. Not audited, not started.

- 2026-11-17: first draft, written after a design discussion with the user. The user's answers are recorded under
  **Agreed decisions**.

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
it applies to, and whether it goes to the start or the end of the request. The rules are applied as the last step
before the request is shaped for its model, after every plugin replacer and trigger, so nothing later can remove or
reorder what they insert.

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

- **Where requests converge.** Every provider request except a tab's own plugin-provider and WebLLM requests runs
  through the server's `requestChatDataMain` (`server/src/llm/request.ts:491`): a job's requests (`runInJob`,
  `server/src/llm/requests.ts:1051`), and every tab request through `POST /api/llm/request`
  (`server/src/llm/requests.ts:1498`). It clones the prompt (`request.ts:541`), reports the model to the request
  history (`ctx.describe`, `:561`), resolves the credential, calls `reformater` (`:588`), and dispatches by format.
- **A job's plugin provider and WebLLM** also go through the server function: `requestPlugin` hands the already
  reformatted prompt to the job's tab (`request.ts:647-673`), which calls the provider directly and never enters the
  tab's `requestChatDataMain`.
- **The tab's own two formats.** The tab's `requestChatDataMain` (`src/ts/process/request/request.ts:670`) sends every
  other format to the server (`:737-740`) and runs `LLMFormat.Plugin` and `LLMFormat.WebLLM` itself: clone (`:748`),
  `reformater` (`:764`), dispatch (`:772`).
- **What runs before.** The outer loops run the plugins' `replacerbeforeRequest` hooks and the `request` trigger before
  every attempt and write the result back into the loop's own prompt (`server/src/llm/outer.ts:149-166`,
  `src/ts/process/request/request.ts:421-427`). Plugin v3's `runLLMModel` calls the tab's `requestChatDataMain`
  directly and skips the loop (`src/ts/plugins/apiV3/v3.svelte.ts:3748`).
- **Retries and tool follow-ups.** Each attempt is a new `requestChatDataMain` call on a fresh clone. The adapters
  build their provider body once and append tool calls and results to that body for a follow-up; none re-enters
  `requestChatDataMain` (`server/src/llm/openAI/requests.ts:809-887`, `server/src/llm/openAI/responses.ts:477-536`,
  `server/src/llm/anthropic.ts:1139-1219`, `server/src/llm/google.ts:776-920`).
- **Prefill.** `formated` has no prefill marker (`shared/openai.ts:8`). `promptSettings.assistantPrefill` is declared
  but never emitted. A prefill is a trailing `assistant` entry from the prompt template; only the DeepSeek `prefix`
  handling reads "the last entry is an assistant" (`server/src/llm/openAI/requests.ts:178-184`).
- **Settings a request reads.** `RequestDb` picks every `providers` section field (`server/src/llm/settings.ts:44-67`).
  A job loads it once and keeps it for all of its requests (`server/src/jobs/jobScope.ts:321-333`); a tab `POST` loads
  it per request.
- **Token budget.** Assembly's final recheck keeps `maxResponse` and the tool schema charge free
  (`server/src/prompt/assemble.ts:2578-2627`); the charge comes from `AssemblyHost.toolSchemaTokens` (`:209`), is
  subtracted from the trim headroom (`:3234`), and is reported as `ContextReport.toolSchemas`
  (`shared/contextReport.ts:132`, `assemble.ts:3040`), which the meter shows as its own row
  (`src/lib/ChatScreens/ContextMeter.svelte:1191-1200`).
- **Request history.** The row's `prompt` is the prompt the layer received, recorded before `requestChatDataMain`
  (`server/src/llm/requests.ts:792`, `:1401`); `describe` fills the model columns (`request.ts:561`,
  `server/src/data/requestHistory.ts:482`). The SQLite file refuses any version other than `"1"`
  (`requestHistory.ts:211`, `:545-548`), and every query names its columns.
- **The editor row.** `PromptDataItem.svelte` reads `editedPreset` in three places: `replacePrompt` (`:134-150`, never
  called), the `cot` option (`:318`), and the `chatAsOriginalOnSystem` checkbox (`:382`). Reordering, removal, and the
  opened state are the parent's (`PromptSettings.svelte:84-135`, `:200-276`). Its text areas use `TextAreaInput` with
  CBS highlighting and autocomplete (`:331`).
- **A settings page of this kind.** Input Hooks: a menu constant (`src/ts/settingsMenu.ts:24`), a `navGroups` entry and
  a page branch (`src/lib/Setting/Settings.svelte:130-133`, `:389`), a route slug (`src/ts/router/routes.ts:43`), a
  search page row (`src/ts/setting/searchIndex.ts:199`), and a hand-written page
  (`src/lib/Setting/Pages/InputHookSettings.svelte`).

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
- The upstream export leaves the field out: add it to `METATRON_ONLY_SETTINGS`
  (`server/src/data/upstream/exportDatabase.ts:128`), so a non-empty list is reported as not exported.
- The plugin database API stays closed to it: the field is not added to `allowedDbKeys`
  (`src/ts/plugins/plugins.svelte.ts:812-840`). A plugin that could edit the rules would undo "nothing later can
  change it".

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
  for a trailing assistant that is ordinary history: the rule cannot tell the two apart, and keeping the entry last is
  the harmless reading for both.
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
  - The Developer tool's "As Request" preview shows the inserted messages (it runs the request layer with
    `previewBody`); the plain message preview does not.

### D3. Keeping the tokens free

Assembly finishes its budget before the request layer inserts anything, so the reply request's insertions get the same
treatment as tool schemas.

- `AssemblyHost.insertedMessages?: readonly OpenAIChat[]`: the messages the reply request will insert. `runSend`
  (`server/src/prompt/runner.ts:1728-1832`) passes the `start` and `end` lists of
  `interceptionMessages(requestDb.requestInterceptions, "model")` for every job kind, `preview` included (unlike tool
  schemas, nothing is listed over the network).
- Just before the final recheck (`assemble.ts:2578`), assembly counts them with its own `tokenizeChat` and adds the sum
  to the reserved amount everywhere `toolSchemaTokens` is used: `promptBudget` (`:2592`), the required-tokens error
  (`:2606`), the `outputTokens` clamp (`:2626-2627`), and the trim headroom (`:3234`).
- `ContextReport.interceptions?: number` (present only when positive), validated like `toolSchemas`
  (`shared/contextReport.ts:337`) and added to the fixed share (`:614`). The meter shows it as its own row next to the
  tool schema row.
- Auxiliary requests (memory, translation, emotion, and the rest) have no assembly budget and get no reservation. A
  rule that targets them can push such a request over its model's context; the page says so (D4).

### D4. The settings page

- A new entry "Request interception" in the same nav group as Input Hooks: `REQUEST_INTERCEPTION_SETTINGS_MENU` (the
  next free index; 26 at the baseline), a `navGroups` entry and page branch in `Settings.svelte`, the route slug
  `request-interception`, and a page row in `searchIndex.ts`, each next to the Input Hooks line.
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
  - `popupEditorContext` is the rule `id`.
- Notes on the page, as plain text under the list:
  - the text is sent as written, without CBS;
  - `memory` and `emotion` answers are parsed (the Structured Memory writer expects JSON, the emotion step one word), so
    a rule there can break them;
  - only the chat reply reserves context for the inserted text.
- Strings: a `requestInterception` namespace in `src/lang/en.ts` with Korean overrides in `src/lang/ko.ts`.

### D5. The request history count

- `describe`'s model gains an optional `interceptions?: number` (`server/src/llm/context.ts:51`, the `RequestModel` type
  in `server/src/llm/requests.ts:87-94`); `requestChatDataMain` passes `applied` when it is positive.
- The store adds a nullable `interceptions INTEGER` column: in the `CREATE TABLE` for a new file, and by
  `ALTER TABLE requests ADD COLUMN` when `PRAGMA table_info(requests)` lacks it. The schema version stays `"1"`: an
  older server names its columns in every query and keeps working on the file, where a version bump would make it run
  without a history.
- `RequestHistorySummary.interceptions: number | null` (`shared/requestHistory.ts:28`), shown in the expanded row of
  `src/lib/Others/RequestLogs/ServerRequestHistory.svelte` only when positive ("Intercepted: N prompts"). It is summary
  metadata, so it is kept with content capture off.
- The row's `prompt` keeps its meaning (what the layer received). With content capture on, the exchange body shows the
  request as sent.
- A tab's own Plugin and WebLLM requests have no server history row and record nothing.

## Slices

Each slice updates its guides in the same commit and ends with V1 (`pnpm check`, `pnpm --silent test:agent`),
`pnpm format:check`, and `pnpm check:docs`.

### 1. Rule shape, storage, and insertion (_medium_)

- `shared/llm/interception.ts` (D1, D2) and `shared/database.ts`, `shared/sections.ts`
  (`SECTION_FIELDS.providers`), `server/src/data/normalize/providers.ts`.
- The two call sites (D2), `METATRON_ONLY_SETTINGS` (D1).
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
- Guides: llm-requests (`Files`, `Flows`), persistence, backup-sync-hub.
- After this slice the feature works for a list written into the settings by hand; there is no page yet.

### 2. Settings page (_medium_)

- `PromptDataItem.svelte` and `PromptSettings.svelte` (D4), the new page, menu constant, nav entry, route, search row,
  strings.
- Tests: `src/lib/UI/popupRowContext.svelte.test.ts` still passes unchanged; a page test beside
  `InputHookSettings.test.ts` (add, edit a mode, reorder, remove, each writing the list); `PromptDataItem` with
  `allowedTypes` of one type shows no type select and with `cbs` off renders a plain text area; the settings search
  and route tests that enumerate pages.
- Guides: settings-i18n (`Pages`, `Prompt editors`).

### 3. Token reservation and the context meter (_medium_)

- `AssemblyHost.insertedMessages`, the four uses in `assemble.ts`, `runSend`, `ContextReport.interceptions`, the meter
  row and its string (D3).
- Tests: `server/src/tests/assemble.test.ts` (the recheck removes history to keep the reservation free; the error
  total and the `outputTokens` clamp include it; a rule for another mode reserves nothing); the context report parser
  and fixed share; the meter row.
- Guides: chat-pipeline, server-generation (`Prompt job execution`), ui-theming.

### 4. Request history count (_small_)

- D5. Independent of slices 2 and 3; it can be dropped without touching them.
- Tests: `server/src/tests/requestHistory.test.ts` (a file created before the column gains it on open and keeps its
  rows; the count reads back), `server/src/tests/requestCapture.test.ts` (a real request's row holds the count),
  `server/src/tests/requestHistoryRoutes.test.ts` (the wire shape), the viewer.
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
