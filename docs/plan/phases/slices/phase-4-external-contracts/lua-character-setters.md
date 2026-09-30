# Slice: Lua Character Setters

Status: implemented (2026-10-01, on `ff74cf2e`; record below).

Phase: [Phase 4](../../phase-4-external-contracts.md), "Lua and triggers" (the Lua half:
`setName`, `setDescription`, `setCharacterFirstMessage`, `setBackgroundEmbedding`,
`upsertLocalLoreBook`); `PLAN.md` Invariant 2 (every write ends in an explicit mutation) and
Decision 5 (Lua has one runtime, on the server, from Phase 5: the setters become id-addressed
mutations so `lua-bindings-and-buttons` can map each one to an `applyChanges` op on the job's
character record; the execution context is frozen to character and chat ids).

Depends on: `character-and-collection-mutations` (`updateCharacter`, `findCharacter`); Phase 2
(`runScripted` carries `chatRef` and `contextRef`). Parallel with the plugin, MCP, trigger, and
import slices (disjoint source files; no docs edited here).

## Scope

Allowed files: `src/ts/process/scriptings.ts`, `src/ts/process/scriptings.test.ts` (only if its
mocks need the new module). Tests belong to the review step; the guide belongs to the closeout.

Identifiers (verified 2026-09-30 at `577c43ae`): `runScripted` (`scriptings.ts:74-88`; `char`
defaults to `getCurrentCharacter()` at 89 and may be a `simpleCharacterArgument`; a live
`chatRef` or a trigger's `chat` working copy at 94-95; `contextRef = arg.chatRef ?? chatRef` at
96); the engine state (`BasicScriptingEngineState`, 51-64: `chat`, `chatRef`, `contextRef`,
`setVar`, `getVar`; engines are reused across runs, `ScriptingEngines` 70); `engineCharacter()`
(127-132: the character whose `chaId` is `contextRef.chaId`, else the selected index, so in a
group send it is the group), `engineChat()` (133-135). The four setters, all
`ScriptingSafeIds`-guarded and all writing the selected character by index: `setName`
(770-779, `DBState.db.characters[selectedChar].name = name`), `setDescription` (793-807,
`char.desc = desc` then `DBState.db.characters[selectedChar] = char`; its type check reads
`data`, the run's input, instead of `desc`: a defect), `setCharacterFirstMessage` (815-828,
same pattern through a live `getDatabase()` alias at 819), `setBackgroundEmbedding` (855-866).
Their getters read the selected index: `getName` (763-768, no guard), `getDescription`
(781-791), `getCharacterFirstMessage` (809-813, no guard), `getBackgroundEmbedding` (845-853).
Already routed by Phase 2 (verify, do not change): `upsertLocalLoreBook` (909-959:
`setChatMeta(target, { localLore })` on the live ref, `workingCopy().localLore` inside a
trigger), the chat functions `setChat`, `setChatRole`, `cutChat`, `removeChat`, `addChat`,
`insertChat` (246-327) and `setFullChatMain` (371-393, `replaceChat` on the live ref),
`setChatVar`/`setChatVarChanged` (139-152, through `setChatVarOf` → `setChatMeta`),
`loadLoreBooksMain` (961-1005, its decorator flags through `setChatVarOf`), `generateImage` and
the two image getters (489-567, inlay resources through `writeInlayImage`). Guard registration:
1204-1211. Entry points: `runLuaEditTrigger` (1511-1555), `runLuaButtonTrigger` (1566-1596),
`triggerlua` in `src/ts/process/triggers.ts:349-365` (passes the trigger's `char`, the speaking
member in a group send, `index.svelte.ts:439-459`). Grep residuals today (Luna fan-out C): the
rooted pattern finds the four writes at 778, 806, 826, 864; `getDatabase()` reads that stay:
130-131 (`engineCharacter`), 505 (`getCharacterImageMain`), 764 (`getName`, rewritten), 819
(`setCharacterFirstMessage`, rewritten), 849 (`getBackgroundEmbedding`, rewritten), 859
(`setBackgroundEmbedding`, rewritten), 870 (`getLoreBooksMain`, unused binding), 966
(`loadLoreBooksMain`, `maxContext`), 1129 and 1168 (the two `getCharacterLastMessage`
declarations).

Stopping condition: a run whose executing character cannot be resolved (a `simple` character
argument without a `chaId` and no `contextRef`): recorded, and the setters return `false` (a
defined result) without writing; never a redirect to the selected character.

## Assumptions

- `character-and-collection-mutations` landed: `updateCharacter(chaId, patch)` validates and
  clones the patch, assigns the listed own fields on the mirror record, and marks the character
  dirty; `findCharacter(chaId)` returns the read-only mirror record.
- The executing character is `arg.char` of the run (the send's `currentChar`: the speaking
  member in a group send, the character of the chat screen for buttons and edit hooks), not the
  owner of `contextRef` (the group's chat in a group send). Today the setters write the
  selected character instead of the run's character: a wrong-target write, not a lost one (the
  selected character is watched and saved); the dirty mark becomes necessary only once the
  setters target a character that may not be selected.
- Phase 5's `lua-bindings-and-buttons` ports each setter as `applyChanges` on the job's character
  record addressed by the same `chaId`; the client signature `updateCharacter(chaId, { field })`
  is the contract it mirrors, and the executing-member rule is the one it inherits (the trigger
  slice applies the same rule, so the two runtimes agree).

## Proposed decisions

- Executing character (proposed; Astra P7): `runScripted` captures `arg.char.chaId` (when
  `arg.char.type !== "simple"`, else `undefined`) into a new per-run engine-state field
  `characterId`, set on every run because engines are reused; a new `engineCharacterId()`
  returns it, falling back to `contextRef.chaId` when the run had no character, and `undefined`
  otherwise. The four setters and their four getters resolve through it; chat operations keep
  `chatRef`/`contextRef` (the group's chat in a group send), so `cbs`, `getLoreBooks`, and the
  message functions are unchanged. Recorded behavior change: a Lua script writes and reads its
  own character (the speaking member in a group send; the run's character when the selection
  moved mid-send); today it writes whatever is selected. Alternative (`engineCharacter()` by
  `contextRef`) rejected: in a group send it addresses the group, which `setDescription` then
  refuses although the script belongs to a member.
- Writes (proposed): `updateCharacter(id, { name })`, `{ desc }`, `{ firstMessage }`,
  `{ backgroundHTML }`. The group guard of `setDescription` and `getDescription` stays; `setName`
  gains none (unchanged). `setDescription`'s type check tests `desc` (the defect above; recorded
  as fixed). Return values are unchanged (`setName` and `setDescription` return nothing,
  `setCharacterFirstMessage` and `setBackgroundEmbedding` return `true`/`false`); an unresolved
  character makes the two boolean setters return `false` and the other two return without
  writing.
- Reads (proposed): the getters read `findCharacter(id)` and return the primitive; the
  `getDatabase()` bindings inside the eight functions go. The other `getDatabase()` reads in the
  file (the residual list above) are reads and stay.
- Nothing else in `scriptings.ts` changes: no new Lua API, `luaCodeWrapper` untouched, the
  guards unchanged (STRUCTURE S2), the chat functions untouched.

## Validation

`pnpm check`, `pnpm test` (`scriptings.test.ts`), `pnpm format:check`. Exit check, discovery
only: the rooted pattern of the closeout over `src/ts/process/scriptings.ts` answers nothing
(today: 778, 806, 826, 864); `rg -n 'getDatabase\(\)' src/ts/process/scriptings.ts` answers
exactly the residual reads listed above minus the four rewritten ones (130-131, 505, 870, 966,
1129, 1168, by identifier: `engineCharacter`, `getCharacterImageMain`, `getLoreBooksMain`,
`loadLoreBooksMain`, `getCharacterLastMessage` twice); `rg -n 'selectedCharID' src/ts/process/scriptings.ts`
answers only `engineCharacter`'s fallback (131). Review-step tests (`scriptings.test.ts` or a new
`scriptingsSetters.test.ts` over `storeBackedServer.ts`): each setter run with a `char` that is
not selected lands in that character, marks it, and leaves the selected character unchanged;
each setter run for a group member (the member's `char`, the group's `chatRef`) lands in the
member and not in the group; a group refuses `setDescription`; a non-string `desc` throws; a
`simple` character without an id makes the setters return `false`; a run without a character
argument writes the selected character. Manual, recorded in the closeout: a Lua button that
sets the description runs from a chat, the selection is moved to another character while the
script waits (an `alertInput`), the first character's description changes and the second's does
not, and both survive a reload; the same from a group member's script.

## Residual risk

The setters still run on the client until Phase 5's cutover; the Lua runtime, its guards, and
the missing CPU limits are Phase 5's. A script run with a `simple` character argument (a
module's Lua run without a character) cannot write a character (a defined `false`, recorded).

## Implementation record

Implemented 2026-10-01 on `ff74cf2e`, by the amendments of
[`implementation-plan.md`](implementation-plan.md) (slice 5). Only `src/ts/process/scriptings.ts`
changed.

- **The run's character.** `runScripted` computes the id before its first await (challenge 1), and
  the engine state gains `characterId`, assigned inside the mutex on every run:
  - the run's `char.chaId`, where `char` is the argument, else the selection at entry
    (`runScripted`'s default);
  - unset for a `simple` argument (the rule goes by `type`);
  - the `runCharacter` state keeps the argument itself, for `generateImage`.
- **`runCharacter()`** (a closure over the engine state, read at call time, like
  `getPersonaDescription`) returns `findCharacter(characterId)`. None of the `declareAPI` closures
  captures the run's `char` any more (F-d); an engine reused by a later run reads that run's
  character.
- **The setters** write through `updateCharacter(chaId, { field })`: `setName` (`name`),
  `setDescription` (`desc`), `setCharacterFirstMessage` (`firstMessage`), and
  `setBackgroundEmbedding` (`backgroundHTML`).
  - The guards and type checks stay, and the type check runs first. `setDescription` now tests
    `desc`, not the run's `data` (the defect, fixed).
  - The group refusal of `setDescription` and `getDescription` stays.
  - Return shapes stay: `setName` and `setDescription` return nothing. The other two return
    `updateCharacter`'s result, which is `false` when the character is gone or unresolved.
- **The getters** (`getName`, `getDescription`, `getCharacterFirstMessage`,
  `getBackgroundEmbedding`) read `runCharacter()`. They return `""` for an unresolved character,
  and otherwise the field as it is, `nil` when missing (challenge 2). `getDescription` and
  `getBackgroundEmbedding` keep their guards (`undefined` when refused).
- **`generateImage`** passes the live record of the run's character, else the run's argument (a
  `simple` run has no record; `generateAIImage` reads its `chaId`).
- **`upsertLocalLoreBook`**'s type check reads `runCharacter()`.

Recorded behavior changes:

- A Lua script reads and writes its own character: the speaking member in a group send, and the
  run's character when the selection moved while it ran. Before, it used whatever was selected.
- A `simple` run (a translation or module run without a character) reads `""` and writes nothing
  (F-e). Before, it wrote the selected character.
- A reused engine no longer sees the first run's character in `generateImage` and
  `upsertLocalLoreBook`.
- A getter with no resolvable character returns `""`. Before, it threw on the missing record.

No stopping condition was met.

Exit checks:

- The rooted pattern over `scriptings.ts` answers nothing.
- `getDatabase()` answers `engineCharacter`, `getCharacterImageMain`, `getLoreBooksMain`,
  `loadLoreBooksMain`, and both `getCharacterLastMessage` declarations.
- `selectedCharID` answers the import, `engineCharacter`'s fallback, `getCharacterImageMain`, and
  both `getCharacterLastMessage` declarations. `runScripted`'s default is `getCurrentCharacter()`.

No existing test was invalidated: `scriptings.test.ts` exercises no character setter, so no test
adapter ran and its mocks needed no change.

Checks:

- `pnpm check`, `pnpm format:check`, and `pnpm build` pass.
- `pnpm test`: 91 files, 952 passed, 3 skipped.
- `pnpm test:e2e`: 5 passed.

Manual check (Playwright, scratchpad `checkP4Slice5.mjs`). A Lua button handler awaits
`alertInput`, then calls all four setters, with `getName` inside `setName`. The selection moves
while it waits:

- **Alpha's button:** Beta was selected while the script waited. Alpha got the name, description,
  first message, and background, and Beta was unchanged.
- **Member's script, run on the group's chat:** the group was selected. Member got all four
  writes, and the group was unchanged.
- Both held after a reload, and there were no page errors.

## Tests

Written by the Fable review (verdict: no problem): `src/ts/process/scriptingsSetters.test.ts`, six
tests on a real wasmoon engine over the real save adapter and server store. The harness points
wasmoon's glue at its `file:` build, since the glue mis-detects happy-dom; `scriptings.ts` is
untouched.

- All four getters and setters through Lua on a character that is not selected: only that
  character is sent, and the selected one is unchanged.
- A member's script on the group's chat, with the group selected, writes the member, and its lore
  lands in the group's chat. A group argument refuses the description getter and setter and the
  lore type check, and `setName` still writes a group.
- One reused engine across two real runs, a `simple` run with a real id, and a removed-record run,
  including the image routing and the lore check.
- The argument mutated while its run waits on the mutex, and an omitted `char` with the selection
  moved mid-wait: the ids captured at entry hold.
- A same-id replacement mid-wait is read and patched. A removal mid-wait gives `""` from the
  getters, `false` from the boolean setters, and no write.
- Invalid inputs and access keys; an array `data` with `setDescription` (the defect's
  regression); `nil` for a missing field.

The same file fails 6 of 6 against the pre-slice `scriptings.ts`. `pnpm test`: 92 files, 958
passed, 3 skipped. `pnpm check` and `pnpm format:check` pass.

## Astra challenge

Astra (the open plan-review session) challenged the implementation. Report:
`astra-p4-slice5-challenge.md` (scratchpad). Decisions:

1. **Medium: `characterId` was read after the run's awaits.** The run kept the argument object and
   read its `type` and `chaId` only inside the mutex, so a change to that object while the run
   waited redirected the writes (Astra's probe wrote B for a run started for A). **Adopted** (the
   recommended fix): `runScripted` computes the id before its first await and assigns it inside
   the mutex.
2. **Low: the getters defaulted a missing field to `""`.** `""` is truthy in Lua and `nil` is not.
   **Adopted:** only an unresolved character reads `""`; an existing character's missing field is
   returned as it is (`nil`), as before.

Also noted by Astra and recorded here:

- `generateImage`'s fallback to the run's argument also applies when the record was deleted
  during the run. Generation then uses the retained argument and writes no character.
- **For slice 6:** `runTrigger` clones its character, and a later native effect can write that
  copy back over a Lua field edit. This predates the slice. The trigger slice converts those
  effects and adds the mixed Lua and native-effect case.
