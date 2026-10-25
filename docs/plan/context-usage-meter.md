# Context Usage Meter Plan

Status: landed 1 (2eb869497), 2 (630ba6396), 3 (2febc0f44), 4 (69858ee8b). Revised 2026-10-25 after a read-only GPT-6-Astra
review of the first draft; its confirmed findings are folded in below.

Slice 1 deviations later slices rely on:

- The three `Database` UI field types were not added: the type-level partition
  check (`src/ts/storage/tests/presetSchema.test.ts` `everyDatabaseKeyIsListed`)
  fails unless `shared/sections.ts` lists them, so slice 2 adds them to
  `shared/database.ts` with their section. `ContextMeterTurnUnit` is exported
  from `shared/contextReport.ts`.
- `sections` rows have no `name` (one row per kind); `sections` and `trim.queue`
  are `readonly`. `history.droppedTokens` covers every eligible message missing
  from the final prompt (trimmed, summarized, removed by the recheck or
  `editRequest`, or outside every chat range).
- `trim` is also omitted when the new-chat marker has no recheck count or a
  queued message is no longer in the final prompt. `"beyondQueue"` means the
  known queue (at most 8 entries) ran out, not "8 or more" messages.
- `memory.coverage` is `"covered"` only on HypaV3 evidence; HypaV2, SupaMemory,
  and Hanurai are always `"unknown"`. `historyDigest` includes the `allBefore`
  reset and leaves out a continue's target.
- The runner passes `AssemblyHost.tokenScope` and `AssembleInput.continueMessageId`
  (`server/src/prompt/runner.ts`).

Slice 2 notes for slice 3: the three fields are required `Database` fields;
`CONTEXT_METER_FIXED_WARN` (`{ min: 10, max: 95, default: 60 }`) is exported
from `shared/database.ts`. The section `interaction.contextMeter` (label
`settingsSectionContextMeter`) holds `interaction.contextMeterEnabled`,
`interaction.contextMeterTurnUnit`, and `interaction.contextMeterFixedWarn`; its
first item has no condition, so a section `SettingHit` for it stays available
while the meter is off.

Slice 3 notes for slice 4:

- `ContextMeter.svelte` props are `chatRef`, `group`, and `height`; it is mounted
  after the composer textarea inside `{#key chatKey}`, so a chat switch makes a
  new instance. `source` (`$derived`) is a report or legacy source with its
  `messageId` (`Message.chatId`, optional: no id means no estimate) and scans only
  the message list and each `generationInfo`; keep the draft count and the digest
  check out of that scan.
- Extension points: a `draft` prop, a "≈ −2" suffix on the `chip` derived
  (`{ text, note, summary }`), and an estimate block under the popover's heading.
- Deviations: the memory-mode chip shows the kept count and the coverage note
  only (the memory kind is in the label and the popover; the note is hidden below
  `sm`), and memory mode shows the kept count even when all history was kept. The
  bar is scaled to the section sum when it exceeds the prompt budget. The
  section `SettingHit` is built at click time. Strings are in `language.contextUsage`.
- No real-browser check yet (placement, narrow layout, light theme); it belongs
  to the manual check after slice 4.

Slice 4 notes:

- The estimate is also hidden while any memory is configured (the next send may
  ask to run it), with a preset chain, with an incomplete binding, when the last
  message is disabled, when `replyPrefix` names another message, and on a
  continue whose overflow reaches the queue's last entry. The reply and the draft
  are counted without their `<Thoughts>` block, as the server counts them.
- The tooltip reads "18 turns kept before, 16 of them after": the next report's
  kept count also gains the new messages (kept + 2 − n in messages for a normal
  send), so the manual check below compares against that, not a plain drop. The
  "may run memory" hint was not built.
- `countTokensInScope(text, captured, signal?)` was split out of `countTokens`
  for the job-scope counts.
- Real-browser check done with a mock provider: kept count against the prompt,
  popover rows plus Other against input tokens, the estimate against the next
  report (22 + 2 − 5 = 19), the estimate hidden after an earlier edit and a model
  switch, the turn unit, light theme, and 420 px width. Not checked in a browser:
  group chats, memory mode, a continue, the unknown estimate state, the settings
  link, the warning level, Firefox and Safari.

Planned on 2026-10-25. Sources: the code at `49b046098` (anchors below are from
that commit; re-verify before editing) and the design discussion with the user
recorded under **Agreed decisions**. Owning guides:
[chat-pipeline](../structure/chat-pipeline.md) (prompt assembly, lore activation),
[llm-requests](../structure/llm-requests.md) (token counts),
[ui-theming](../structure/ui-theming.md) (chat screen, popups),
[settings-i18n](../structure/settings-i18n.md) (settings items, strings),
[persistence](../structure/persistence.md) (the new UI settings, the message field).

## Goal

Show the user, next to the chat composer, how the model's context is being spent,
the way Codex and Claude Code show their context use, but shaped for how RisuAI
builds a prompt.

RisuAI does not grow one conversation until it is full. Every send rebuilds the
prompt and drops the oldest entries until it fits (`server/src/prompt/assemble.ts:1620-1628`),
so a plain "used / max" meter sits near 90% as soon as trimming starts and says
nothing. The useful questions are:

1. How far back does the model remember? (the history window)
2. What happens if I send this? (how many old messages it pushes out)
3. Where does the budget go? (prompt, description, lore, memory, history)
4. Is the fixed part crowding out the history? (fixed share)
5. Are the bounded sub-budgets full? (lorebook budget, HypaV3 memory budget)

## Original code (baseline)

- **Per-message token data.** `MessageGenerationInfo` (`shared/database.ts:1298-1310`)
  holds `inputTokens`, `outputTokens`, and `maxContext`, built at the end of
  `assemblePrompt` (`assemble.ts:1950-1966`) and written with the reply
  (`server/src/prompt/runner.ts:1571`, `:1724`; a continue replaces its message's
  info at `:1706`; an error reply at `:833-834`). `inputTokens` is assembly's
  tokenizer estimate; provider-reported usage is not used to fill it.
  `outputTokens` is the reserved budget (`maxResponse`, clipped), not the reply's
  length. The request info dialog draws a bar from these fields
  (`src/lib/Others/AlertComp.svelte:559-583`).
- **Where assembly counts.** `currentTokens` starts at `maxResponse + 50`
  (`assemble.ts:1039-1041`). The first template switch counts the static cards
  (`:1139-1238`), but `unformated.chats` is still empty there (initialized at
  `:800`, filled only at `:1647`) and the `memory` card only sets a flag
  (`:1230`), so that switch counts no history. Example messages are counted at
  `:1249` and pushed into `chats` ahead of history with a `NewChat` marker
  (`:1249-1261`, the marker uncounted); the greeting and each stored message are
  counted as they are pushed (`:1300-1309`, `:1460-1466`), skipping disabled
  messages and restarting at an `allBefore` message (`:1264-1277`). Trigger
  additions have their own text count (`server/src/prompt/triggers.ts:2011`,
  `assemble.ts:1319`) and land in `postEverything`/`lastChat` (`:1672-1681`).
  Depth lore is counted at `:1470-1476` and inserted after trimming (`:1663-1670`).
  The legacy no-template path counts every `unformated` key (`:1240-1247`),
  including `globalNote` (`:870`), and moves the last chat entry into `lastChat`
  (`:1642-1645`). Template `main` and `globalNote` cards are `plain` cards told
  apart by `type2` (`shared/prompt.ts:19-25`).
- **Trimming.** Without memory, the trim loop drops `chats[0]`, whatever it is
  (examples and the marker first), until the total fits (`:1620-1628`), then
  `host.setLastMemory(chats[0]?.memo)`; `memo` is the message id (`:1456`). With
  memory, the memory step reshapes `chats` (`:1501-1618`): HypaV2/HypaV3 subtract
  `maxResponse` from their incoming ledger (`server/src/prompt/memory/hypav2.ts:302`,
  `hypav3.ts:424`), add synthetic memory entries (`hypav2.ts:519`,
  `hypav3.ts:1532`), and HypaV3 can leave an uncovered gap (`hypav3.ts:1146-1191`,
  `:1502-1509`; `assemble.ts:720-730`); Hanurai prepends retrieved documents
  (`server/src/prompt/memory/hanurai.ts:74-125`).
- **Final formatting.** The second switch emits history from `chat` cards (ranges
  may overlap, `:1822-1846`), `systemizeChat` changes roles and drops `memo`
  (`:352-364`), `pushPrompts` merges adjacent system entries (`:1701-1730`),
  `depth_prompt` and continue text are added (`:1891`, `:1691-1699`),
  `editRequest` may rewrite the list (`:1903`), and the recheck counts `formated`
  and clears any entry still marked removable until it fits the full
  `maxContext` (`:1925-1948`).
- **Lore budget.** `activateLore` merges character, chat, and module lore under one
  limit, `char.loreSettings?.tokenBudget ?? input.loreBookToken`
  (`shared/lore/activation.ts:92-100`). Recursion runs before the budget pass
  (`:635-660`), which keeps actives by priority while
  `usedTokens + act.tokens <= loreToken` (`:661-673`). Accepted `@@inject_lore`
  entries count toward the budget, are removed from the returned actives, and
  change another entry without a recount (`:680-710`). `LoreActivation` is
  `{ actives, matchLog }` (`:61`); Lua `test_lorebook` serializes the whole
  result (`server/src/prompt/commands.ts:310-317`).
- **HypaV3 budget** is `floor(maxContextTokens × memoryTokensRatio)`
  (`hypav3.ts:474`).
- **Tokenizer scopes differ.** The server's job scope sets
  `pluginTokenizer: "none"` (`server/src/llm/settings.ts:292-305`); the tab's
  `tabTokenScope` uses the plugin provider's declared tokenizer
  (`src/ts/tokenizer.ts:37-65`), and `tokenizerIdentityKey` includes that field
  (`shared/tokenizerChoice.ts:61-69`). Per-message overhead
  (`chatAdditionalTokens`, `shared/prompt/chatTokens.ts:38`) is 5 for GPT-prefixed
  model ids and 3 otherwise (`runner.ts:472`).
- **Tab-side counting.** `countTokens` batches and caches through
  `/api/tokens/count`. `createTokenCountField` (`src/ts/tokenCountField.ts`)
  injects only its first-run scheduler (`:6-12`); later runs use the global
  `setTimeout` (`:73`), and its reset does not clear a caller's shown value
  (`:77-80`).
- **Message edits keep the report.** `setText` changes only `message.data` and
  keeps `generationInfo` (`server/src/data/chatStore.ts:1280-1284`).
- **Persistence.** Message normalization keeps unknown nested fields
  (`server/src/data/chats.ts:138-156`). The field travels into checkpoints
  (`server/src/data/checkpointStore.ts:283-307`), chat JSON/HTML exports
  (`src/ts/characters.ts:304-314`, `:384`), backups
  (`server/src/routes/backups.ts:163-172`), and upstream export, which strips only
  translations (`server/src/data/upstream/exportDatabase.ts:947-965`). Generation
  patches always carry the generated message (`server/src/jobs/generationJobs.ts:323-367`).
- **Preview jobs are not side-effect free.** A `preview` still runs
  `runCurrentChatFunction`, which writes changed message text (`assemble.ts:792`,
  `runner.ts:1013-1040`); runs start triggers and commits their chat
  (`assemble.ts:1312`, `server/src/jobs/runSetup.ts:343-372`); writes lore flags
  (`activation.ts:656-660`) and `lastMemory` (`runner.ts:1286-1294`); runs memory
  writes and possibly a HypaV3 summary request (`assemble.ts:521-536`, `:733-738`,
  `:1547`, `:1607`; `hypav3.ts:1386-1393`). The tab increments the persisted
  message counter before choosing the preview kind
  (`src/ts/process/serverGeneration.ts:65`). `previewChat("preview")` promises an
  `OpenAIChat[]` (`src/ts/process/index.svelte.ts:40-55`), which the DevTool reads
  (`src/lib/SideBars/DevTool.svelte:61-63`).
- **The memory boundary line is not drawn.** `showMemoryLimit` and
  `memoryLimitThickness` are still settings (`src/ts/setting/displaySettingsData.svelte.ts:294-305`)
  and `Chat.lastMemory` is still written, but no chat renderer reads them: the
  `isLastMemory` prop was removed in `29f53d3f6` (2025-06-07, "New chat
  loading"). Recorded in [found issues](../research/found-issues.md).
- **Tab anchors.** D1 reads through `currentChatRef`/`findChat`/`selectedChat`
  (`src/ts/storage/chatStore.svelte.ts:657`, `:698`, `:708`). The effective
  context size is `maxContextOverrideOf` (`shared/sections.ts:468`) over the bound
  main profile's `maxContext`. The composer textarea is at
  `src/lib/ChatScreens/DefaultChatScreen.svelte:1047`; its text is shared across
  chats (`:124`); group chats are `currentCharacter.type === "group"` (`:1035`).
  `Portal` (`src/lib/UI/GUI/Portal.svelte:16`) hosts popups. `openSetting(hit)`
  (`src/ts/setting/settingJump.svelte.ts:47`) opens a section from a complete
  `SettingHit` (`src/ts/setting/searchIndex.ts:60-74`).
- **Settings normalization** checks JSON kinds only
  (`server/src/data/normalize/shared.ts:31-57`); enums and ranges are enforced in
  `normalizeUi` (`server/src/data/normalize/ui.ts:147-158`). Fresh defaults are
  pinned by `src/ts/storage/tests/fixtures/boot/boot-snapshot.json`
  (`normalize/shared.ts:25-29`) and `server/src/tests/normalizeSections.test.ts:71-78`.

## Agreed decisions

These were settled with the user on 2026-10-25.

1. **No ring meter.** A total-use ring turns red as soon as a chat is long and
   stays red. The always-visible element is the history window instead.
2. **The combination**: a composer chip showing the history window ("18 turns"),
   or the plain percentage while the whole chat still fits; while typing, the
   number of old messages this send would push out; on click, a popover with the
   per-section breakdown of the last request, the excluded-history row, the
   lorebook and HypaV3 sub-budget meters, and the fixed share. A manual
   "Recalculate" was also agreed, then deferred by the user on 2026-10-25 after the review found that `preview` writes; see **Deferred**.
3. **Group chats are out of scope.** The chip is not shown in a group chat.
4. **Turn unit**: default is kept user messages ("turns"); a setting switches to
   all kept messages.
5. **Fixed-share warning**: default 60%; a setting changes it.
6. **Settings are surfaced, not hidden**: the popover names the current basis
   (turn unit, warning level) with a link that jumps to the settings section.
7. **The existing `showMemoryLimit` setting stays unchanged.** (It draws nothing
   today; restoring the line is separate work.)

## Design decisions (made by this plan)

### The report

`MessageGenerationInfo.context?: ContextReport`, written by `assemblePrompt`.
Types, a reader validator, and the pure helpers live in `shared/contextReport.ts`
(new, T2 rules):

```ts
export type ContextSectionKind =
  | "main"
  | "globalNote"
  | "jailbreak"
  | "cot"
  | "plain"
  | "chatML"
  | "persona"
  | "description"
  | "authornote"
  | "lorebook"
  | "postEverything"
  | "memory"
  | "examples"
  | "triggers"
  | "history";

export type ContextReport = {
  v: 1;
  /** Effective context size and the response reservation the request used. */
  maxContext: number;
  maxResponse: number;
  /** Final counted input (= generationInfo.inputTokens). */
  input: number;
  sections: { kind: ContextSectionKind; name?: string; tokens: number }[];
  /** input − sum(sections); signed. */
  adjustment: number;
  /** False when editRequest changed the list or a recheck removal could not be traced. */
  attributionExact: boolean;
  history: {
    /** Eligible stored messages (not disabled, from the last allBefore); the greeting counts as one. */
    total: number;
    kept: number;
    totalUser: number;
    keptUser: number;
    /** Tokens of eligible stored messages left out, by the trim loop or the recheck. */
    droppedTokens: number;
  };
  /** No-memory path only: the trim ledger after trimming, for the displacement estimate. */
  trim?: {
    /** maxContext − currentTokens after the trim loop. */
    headroom: number;
    /** The next entries the loop would drop, in order, at most 8: examples, the marker, then messages. */
    queue: { tokens: number; kind: "example" | "marker" | "message"; user: boolean }[];
    /** Tokens of this request's own reply prefix already in the ledger (a continue). */
    replyPrefix?: { messageId: string; tokens: number };
    perMessage: number;
  };
  memory?: {
    kind: "hypaV3" | "hypaV2" | "supa" | "hanurai";
    tokens: number;
    budget?: number;
    /** "gap" when HypaV3 left uncovered history; "unknown" when it cannot tell. */
    coverage: "covered" | "gap" | "unknown";
  };
  lore: {
    /** The budget pass total, before @@inject_lore edits; not the emitted lore tokens. */
    budgetUsed: number;
    budget: number;
    rejectedCount: number;
    rejectedTokens: number;
    /** Returned actives (injectors excluded). */
    active: number;
  };
  /** tokenizerIdentityKey of the job scope (pluginTokenizer "none"). */
  tokenScope: string;
  /** historyDigest() of the eligible messages as assembled. */
  historyDigest: string;
};
```

Helpers: `parseContextReport(value: unknown): ContextReport | null` (shape and
finite-number checks; imported or old data that fails reads as no report),
`historyDigest(messages)` (a fast non-cryptographic hash over each eligible
message's id, role, `disabled`, and `data`, computed the same way on both sides),
`turnCount(report, unit)`, `fixedShare(report)`, and
`displacement(report, added)` → `{ messages, userMessages } | "beyondQueue" | "unavailable"`.

### Attribution: count at the real sites

- Record each count where assembly already makes it: static cards in the first
  switch (`plain` by `type2` → `main`/`globalNote`/`plain`), examples (`:1249`),
  the greeting and each stored message (`:1300-1309`, `:1460-1466`) with its id
  and original role, trigger additions (`:1319`), depth lore (`:1470`), and the
  memory step's result. The legacy path maps each `unformated` key to a kind and
  keeps `lastChat` in `history`.
- History is the sum of kept stored-message counts, after the trim loop and after
  the recheck. A recheck removal comes off a row only when its entry traces to a
  source (a stored message by `memo`, an example by its `name`); otherwise
  `attributionExact` is false and the removal stays in `adjustment`.
- Assistant depth-0 and other lore pushed into `postEverything` (`:1013`, `:1023`)
  stay in `postEverything`; description- and position-embedded lore (`:974`,
  `:1044`) stay in their host section. Continue text and `depth_prompt` are
  uncounted before the recheck and land in `adjustment`.
- `adjustment` is signed. The popover shows it as an "Other" row with its sign and
  never as a bar segment; with `attributionExact` false the popover says the
  breakdown is approximate.
- New token work: none beyond the counts assembly already makes (the queue reuses
  the per-entry counts). Slice 1 verifies this by counting `tokenizeChat` calls in
  a test.

### Displacement estimate

- Available only when `trim` is present (no memory), the report is the latest
  report in the chat, its message is the last message, `historyDigest` still
  matches the chat's eligible messages minus that last reply, the token scope and
  `maxContext`/`maxResponse` still match, and the chat is not generating.
  Otherwise the chip shows the report as "as of the last reply" without an
  estimate.
- Added tokens = (the last reply's tokens − `replyPrefix.tokens` when the report
  is the reply's own continue) + the draft's tokens, each plus `perMessage`.
  Both counts use the job-equivalent scope (below).
- `displacement` pops `trim.queue` while `added > headroom`. Past the queue it
  answers `"beyondQueue"` (more than the known queue covers). The tooltip's "18 → 17 turns" uses the
  popped entries' `user` flags.
- Known misses (shown as "≈"): lore the draft would activate, CBS randomness and
  scripts that change text, inlays and media, a translation sent instead of the
  typed draft, and a recheck that removes more than the trim loop.

### Memory mode

The chip reports raw history kept plus the memory kind; it says "summarized" only
when `coverage` is `"covered"`, "gap" when HypaV3 left one, and neutral "memory
on" otherwise. No displacement estimate; the chip may say "may run memory" when a
long draft is typed, without a number.

### Freshness and scope

- The tab compares `tokenScope` with a job-equivalent key: `tokenScopeKey()` over
  `tabTokenScope()` with `pluginTokenizer: "none"` (a new `jobTokenScope()` in
  `src/ts/tokenizer.ts`). Draft counts use the same scope, so they count like the
  server.
- Character, persona, lore, and preset edits are not detected; the chip says
  "as of the last reply", which stays true. Only the displacement estimate needs
  the stricter check above.

### Settings

UI section (D2): `contextMeter: boolean` (default `true`),
`contextMeterTurnUnit: "user" | "message"` (default `"user"`; anything else
normalizes to `"user"`), `contextMeterFixedWarn: number` (default `60`; clamped to
10–95, non-finite → 60). Both rules go in `normalizeUi`. They are shown on the
Interaction page in a new section `interaction.contextMeter`; the turn unit and
warning level are conditional on `contextMeter`.

## Slices

One slice is one session, one commit, one file cluster. The slices run in order:
slice 1 owns the `shared/database.ts` message field and slice 2 the three
settings fields, so slice 2 starts after it.

### 1. Context report on the server (_large_)

Guides: chat-pipeline, llm-requests, persistence.

- `shared/contextReport.ts` (new): types, `parseContextReport`, `historyDigest`,
  and the helpers.
- `shared/database.ts`: `MessageGenerationInfo.context?` and the three `Database`
  UI fields (types only; slice 2 adds their defaults and UI).
- `shared/lore/activation.ts`: return `budget: { used, limit, rejectedCount, rejectedTokens }`
  beside `actives` and `matchLog`. Update its consumers, including the typed
  `AssemblyHost` fixture (`server/src/tests/assemble.test.ts:430`); Lua
  `test_lorebook` output gains the field (additive).
- `server/src/prompt/assemble.ts`: the counting sites, provenance (id, original
  role, kind) carried on a side table keyed by entry identity and copied across
  `clone`/`systemizeChat`/merge, the trim queue, the recheck tracing, memory kind
  and coverage from the branch actually run, and the report into `generationInfo`.
- Tests (independent expected values, not only the sum):
  `server/src/tests/assemble.test.ts` for a template prompt with full history,
  a trimmed history with examples (queue order: examples, marker, messages),
  overlapping `chat` ranges, `sendChatAsSystem`, a recheck removal, an
  `editRequest` rewrite (`attributionExact` false), the legacy path with
  `globalNote` and `lastChat`, a continue (`replyPrefix`), a HypaV3 gap, and the
  `tokenizeChat` call count; `server/src/tests/lore.test.ts` for the budget fields
  with a rejected entry that recursed and an injector; a colocated test for
  `shared/contextReport.ts` (`parseContextReport` rejects bad shapes,
  `historyDigest` changes on an edit or a disabled flag, `displacement` within,
  at, and past the queue, both turn units).
- Docs: chat-pipeline (assembly output, lore result), llm-requests (count
  consumers), persistence (the message field travels in checkpoints, exports,
  backups, upstream export, and every generation patch).

### 2. Settings (_small_)

Guides: settings-i18n, persistence.

- `shared/database.ts`: the three `Database` UI fields (slice 1 left them out;
  see its deviations).
- `shared/sections.ts` (UI section), `server/src/data/normalize/ui.ts` (kinds,
  defaults, the enum and clamp rules in `normalizeUi`),
  `src/ts/storage/tests/fixtures/boot/boot-snapshot.json`.
- `src/ts/setting/interactionSettingsData.ts`: three `SettingItem`s and the
  `interaction.contextMeter` section.
- `src/lang/en.ts`: labels and help text (what a "turn" is, what the fixed share is).
- Tests: `server/src/tests/normalizeSections.test.ts` (defaults, a bad enum, an
  out-of-range and a non-finite warning level), `src/ts/setting/settingsPageSections.test.ts`.

### 3. Chip and popover (_large_)

Guides: ui-theming, chat-pipeline.

- `src/lib/ChatScreens/ContextMeter.svelte` (new), beside the composer textarea;
  hidden for group chats and when `contextMeter` is off.
- State: the open chat's latest message whose `generationInfo.context` passes
  `parseContextReport`, read by chat id and message id (D1). Chip states: full
  send (percentage of `maxContext − maxResponse`), trimmed ("18 turns" by
  `contextMeterTurnUnit`), memory (per **Memory mode**), fixed share over
  `contextMeterFixedWarn` (danger tone), no report (legacy
  `inputTokens / maxContext`, or hidden when that is missing too).
- Popover: rows by section, largest first, the signed "Other" row last and outside
  the bar; the excluded-history row; the lorebook budget meter labelled as the
  activation budget (warning tone when anything was rejected); the HypaV3 meter
  when present; the fixed share; the basis line with a link that calls
  `openSetting` with a complete `SettingHit` for `interaction.contextMeter`. Tap
  opens it on mobile. `Portal` and U1 tokens; strings in `src/lang/en.ts`.
- Tests: component tests for each chip state, both turn units, the warning level,
  and an invalid report reading as none.
- Docs: ui-theming (chat screen component index).

### 4. Displacement preview (_medium_)

Guides: ui-theming, llm-requests.

- `src/ts/tokenizer.ts`: `jobTokenScope()`.
- `ContextMeter.svelte`: a `createTokenCountField` over the draft and the last
  reply; `displacement` turns the result into "≈ −2" with the tooltip. The
  composer text is shared across chats, so on a chat switch reset both the field
  and the shown value.
- Tests: fake timers and deferred counts for the debounce (V3; the field injects
  only its first run), each availability condition, the three outcomes, and a
  continue report not double-counting its prefix.

## Deferred

- **Recalculate** (agreed decision 2) needs a preview that writes nothing: no
  `runCurrentChatFunction` writes, triggers, Lua, lore flags, `lastMemory`, memory
  writes or summary requests, and no message counter. That is its own design, not
  a flag on today's `preview`. If it is built, keep `previewChat("preview")`'s
  array contract for the DevTool and return the report through a separate typed
  result. Until then the chip's "as of the last reply" state needs no action.
- Restoring the `showMemoryLimit` line (could read the report's kept ids instead
  of `lastMemory`, which is set before the recheck).

## Out of scope

- Group chats (agreed decision 3).
- Provider-reported usage for calibration.
- A turn-by-turn trend graph of the sections.
- A prompt-cache view (which prefix stays cacheable after a trim).

## Accepted limits

- Counts are the server tokenizer's estimates; Claude and Gemini images use the
  GPT-4o fallback, and some families count with `cl100k_base`
  ([llm-requests](../structure/llm-requests.md) `Known Hazards`).
- The breakdown is approximate whenever `editRequest` rewrites the prompt or a
  removal cannot be traced; the "Other" row carries the difference.
- The lorebook meter shows the activation budget, not the lore tokens finally sent.
- The report is repeated in every generation patch of its message and kept in
  checkpoints, exports, backups, and upstream export; its size is bounded by the
  fixed section list and the 8-entry queue.

## Verification

Per slice (V1): `pnpm check`, `pnpm --silent test:agent`, affected slow tests
with `--tags-filter=slow`, `pnpm check:tests` after adding tests, and
`pnpm --silent test:agent --e2e` for slices touching e2e-covered chat screen UI
(name the specs if selection misses them). Run `pnpm exec prettier --write` on
changed files (T4). A new regression test is shown to fail once with its guarded
line broken (V6).

Manual check after slice 4: in a real browser, on a short chat confirm the chip
shows a percentage; on a long chat confirm it shows turns and that the kept count
matches the history in the request's prompt (request history; not the DevTool preview, which writes); confirm the popover's rows match
the request info dialog's input tokens; type a long draft, note the estimate,
send, and confirm the next report's kept count dropped by that many; edit an
earlier message and confirm the estimate disappears; change the turn unit and
warning level from the popover link and confirm the chip follows; switch the
model and confirm the scope mismatch hides the estimate; open a group chat and
confirm the chip is absent.
