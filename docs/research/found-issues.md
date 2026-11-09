# Issues Found During Work

Bugs, latent defects, stale docs and comments, test gaps, and test flakes that agent sessions noticed while working on something else, from 2026-10-14 on. Each one was outside the scope of the change that found it, so it was recorded instead of fixed. Sessions (worktree slice sessions included) first save a finding to the agents' project memory, which every worktree shares; it is moved here from a checkout with nothing in flight (the plan-runner skill does this when a run finishes). The first batch moved on 2026-10-24, the second on 2026-10-26, the third on 2026-10-30, the fourth (the Server Byte Budgets run) and the fifth (the Guide Budgets run) on 2026-11-01, the sixth (the Structured Memory run) on 2026-11-03, six plan-leftover collections from memory the same day, the seventh (the Guides To Source run), the eighth (the Render Work Budget run), the ninth (the Incremental Chat Transport run), the tenth (the Plugin Storage and Data API run), the eleventh (the Reroll Candidates run) and the twelfth (the Found Issues Sweep run) on 2026-11-05, the thirteenth (the Implementation Audit Fixes run) and that plan's excluded and deferred audit findings at its retirement on 2026-11-06, the fourteenth (the Chat Store and Structured Memory Sweep run) and the fifteenth (the Multi-Client Data Safety Checks run) the same day, the sixteenth (the Module Headers run) on 2026-11-08, seven more plan-leftover collections from memory the same day, and the seventeenth (the Found Issues Decisions run) on 2026-11-09; single entries move as they come up.

These are notes, not verified reports: this file is the inbox, and the focused guides' Known Hazards are where verified entries live. An entry is a `###` heading under its area section, a paragraph saying what and where (`file:line`), then a **Why it matters:** line and a **Suggested handling:** line; the Contents list at the top counts each area's entries. Line numbers and identifiers were right when each entry was written; some entries may already be fixed by later work. Re-check the code before acting on one (STRUCTURE.md protocol step 5), and delete the entry in the same commit that fixes it or shows it is gone. An entry that is re-checked and has an owning guide under `docs/structure/` moves to that guide's Known Hazards `Issues` (or `Limitations`, once the owner accepts it; STRUCTURE.md Doc Maintenance) and leaves this file. "Latent" means no current caller reaches the bad path; "accepted" means the owner chose to keep the behavior.

Reviewed against the current source on 2026-10-24 (first batch), 2026-10-26 (second batch), 2026-10-27 (single entries), and 2026-10-29 (a cleanup pass that fixed eleven entries and narrowed one). Confirmed fixes have been removed, and partially fixed entries have been narrowed to the remaining gap. Entries that still need runtime reproduction are retained.

The inbox was emptied on 2026-11-09 by the Found Issues Clearance plan (retired; `git show e8758c2a8:docs/plan/found-issues-clearance.md`): every entry was fixed by one of its slices, recorded as a Limitation or Issue in its guide, or closed with a reason in slice H1's commit. The eighteenth batch, that run's own findings, moved in the same day.

## Contents

- [Chat store, sync, and change feeds](#chat-store-sync-and-change-feeds) (2)
- [Server jobs and prompt assembly](#server-jobs-and-prompt-assembly) (1)
- [LLM requests and providers](#llm-requests-and-providers) (1)
- [Display transform](#display-transform) (2)
- [Client and plugins](#client-and-plugins) (2)

## Chat store, sync, and change feeds

### The save loop adopts each new character with a list scan

`src/ts/storage/resourceSync.svelte.ts` (~2826, the flush's op loop) calls `adoptCharacter(op.id)` for every character create op; `adoptCharacter` (`src/ts/storage/chatStore.svelte.ts` ~5392) runs `findCharacter` without an index hint, and `normalizeNewCharacter` scans again. A flush carrying N new characters (a plugin `setDatabase` appending 300) costs N list scans there, after Found Issues Clearance F7 made the insertion itself linear. Found 2026-11-09 by F7; outside its files.

**Why it matters:** the bulk-add path is linear only up to the insertion; the first save repeats the quadratic scan once.
**Suggested handling:** build one id-to-index map per flush and pass the hint to `adoptCharacter`.

### A refused later chat leaves a multi-chat import partly applied

`src/ts/characters.ts` `importChat` `addChats` (~530) calls `createChat` per chat in a loop; when a later chat is refused (for example a non-string message `data`, which `prepareMessages` refuses since Found Issues Clearance F9), the earlier chats stay created, so the user sees the error alert but part of the import landed. The v2 path also changes folders before any chat is created. `installCharacterChats` (`src/ts/storage/chatStore.svelte.ts` ~5217) and `normalizeNewCharacter` (~5388) have the same order, but only for malformed data already in the mirror. Found 2026-11-09 by F9.

**Why it matters:** an import that reports a refusal while keeping some of its chats is surprising and hard to undo.
**Suggested handling:** validate every chat before the first `createChat` (and before the folder change).

## Server jobs and prompt assembly

### Server /cut with a dashed id removes every message

`server/src/prompt/commands.ts` `cut` (~232): any argument containing `-` takes the range branch first, so `/cut abc-def` or a UUID chat id (the by-id fallback's input) becomes `slice(NaN, NaN)`, keeps nothing, and removes every message of the history view (during a reroll the hidden carrier survives; outside one the whole chat goes). A numeric-prefixed id (`12abc`) takes the index branch through `parseInt`. Found 2026-11-09 by the A2 challenger; out of A2's scope.

**Why it matters:** a script passing a chat id to `/cut` wipes the chat instead of removing one message.
**Suggested handling:** take the range branch only for numeric bounds (for example `/^-?\d*-\d*$/`) and let other arguments reach the by-id branch; compare with the client's `src/ts/process/command.ts` first.

## LLM requests and providers

### Gemini streaming JSON extraction sees the signature markers

`server/src/llm/google.ts` `wrapToolStream` (~1087) runs `extractJSON(value["0"], …)` on the streaming snapshot text, and `getTranStream` appends the `{{inlayeddata::<id>}}` signature markers to that same text. With `saveSignatures` on (a `model`-mode request since Found Issues Clearance C4), `extractJson` and a JSON schema, a signed streamed reply's extraction sees the JSON followed by the marker and returns both instead of the extracted value. C4 fixed the buffered path and the tool follow-up only. Found 2026-11-09 by the C4 challenger.

**Why it matters:** structured output from a Gemini thinking model with signature saving on comes back unextracted when streaming.
**Suggested handling:** split the markers off before `extractJSON` in `wrapToolStream` and append them after; test in `server/src/tests/llmStreamParsing.test.ts`.

## Display transform

### The LLM translator note is read again for each chunk

`src/ts/translator/translator.ts` `runTranslator` (~387) translates chunk by chunk through `translateMain`, which builds `llmTranslationContext` per chunk (~435); without an explicit note, `resolveTranslatorNote` (~908) reads the selected character's `translatorNote` live each time. A character switch during a multi-chunk LLM translation sends the later chunks with the other character's note, and the cache key mixes contexts. Found 2026-11-09 by the D1 challenger's probe; D1 snapshots only the provider.

**Why it matters:** one translation can mix two characters' notes, the same class as the provider switch D1 fixed.
**Suggested handling:** resolve the note once in `runTranslator` and pass it in `chunkArg` beside `preset` and `requestIds`.

### Rendered translation may strip quotes inside a message style (unverified)

Reported 2026-11-09 by the Found Issues Clearance E3 implementer: a driver message `<style>` with `@import url("…")` and `font-family:"…"` never requested its imported CSS with rendered translation on, and it concluded that markdown-it's typographer quotes (`src/ts/parser/parser.svelte.ts` ~89, ~187–237) run over the inline CSS on the translated-HTML path (`markParsing`, `translateHTML`, `postTranslationParse`). The driver now uses unquoted values. Not reproduced: the `<style>` to `<risu-style>` encoding is meant to protect CSS from Markdown, so the leak may be specific to the translated path or not real.

**Why it matters:** a quoted `url("…")`, `content: "…"` or font family in a card or message style would stop applying for users with auto-translate on.
**Suggested handling:** reproduce with `<style>.x{font-family:"A B"}</style>` in a chat with rendered auto-translate on and compare the scoped CSS with translation off before changing anything.

## Client and plugins

### readAsset throws a bare string for every non-2xx answer

`src/ts/storage/assetClient.ts` `readAsset` (~324) throws `"getItem Error"` for any non-2xx answer (401, 403, 400 and 500 alike) with no status. Since Found Issues Clearance F1, ChatBody's rejecting read (`getFileSrc(loc, { rejectFailedReads: true })`) treats every failure as transient: a persistent 401 or 400 is retried twice and then alerts, after `requestWithRetry` has already spent up to eight attempts on network, 429 and 503 failures. Found 2026-11-09 by F1.

**Why it matters:** permanent failures cost retries and an alert instead of failing fast, and the status is lost at the asset-client boundary, so `globalApi` cannot classify them.
**Suggested handling:** throw an Error carrying the HTTP status from `readAsset` and let `loadFileSrc` record only retryable statuses as failures.

### searchTagList has no production caller

`src/ts/util.ts` `searchTagList` (~1041) and the `TagList` it reads (~818) have no caller in `src/`, `server/` or `shared/`; only `src/ts/util.test.ts` uses it. Found Issues Clearance F5 fixed its OC match as its plan said. Found 2026-11-09 by F5.

**Why it matters:** dead exported code that slices keep fixing and documenting.
**Suggested handling:** remove both (after `rg TagList`) or wire them into the tag input they were meant for.
