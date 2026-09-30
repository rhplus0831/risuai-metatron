# Slice: Trigger Effect Writers

Status: implemented (2026-10-01, on `5b177560`; record below).

Phase: [Phase 4](../../phase-4-external-contracts.md), "Lua and triggers" (the trigger half:
`v2SetVar`, `v2SetAuthorNote`, `v2SetCharacterDesc`, `v2SetPersonaDesc`, the lorebook effects,
and how `runTrigger` results are persisted); `PLAN.md` Invariant 2 and Decision 5 (triggers run
on the server from Phase 5: `trigger-runtime` maps each effect's write to an `applyChanges` op
under the job token, so every write must be an id-addressed mutation first; the execution
context is frozen to character and chat ids) and Decision 4 (whole-chat results are diffed and
applied as by-id operations).

Depends on: `character-and-collection-mutations` (`updateCharacter`, `updatePersona`); Phase 2
(`runTrigger` takes `chatRef`, writes variables and the note through `setChatMeta`, and every
caller applies the returned chat with `applyChatResult`); Phase 3 `forwarding-personas`
(`selection.personaId`; `v2GetPersonaDesc` and `v2SetPersonaDesc` rewritten to the forwarded
field). Parallel with the plugin, MCP, Lua, and import slices (disjoint source files; no docs
edited here).

## Scope

Allowed files: `src/ts/process/triggers.ts`. Tests belong to the review step; the guide edits
(`docs/structure/scripts-triggers.md`) belong to the closeout. `src/ts/process/scriptings.ts`
(`triggerlua`'s Lua side) belongs to `lua-character-setters`.

Identifiers (verified 2026-09-30 at `577c43ae`): `runTrigger(char, mode, arg)` (`triggers.ts:108-128`;
`char` is cloned with `safeStructuredClone` at 130 for normal runs, so the clone keeps `chaId`;
`contextRef = arg.chatRef ?? null` at 135, `chatTarget` null in display and request runs at 137,
`writeChatMeta` 138-146; `const db = getDatabase()` at 161 for `templateDefaultVariables` at
162). Already mutations (verify, do not change): `setVar` (284-307, the working chat plus
`writeChatMeta({ scriptstate })`), `v2SetVar` (373-411 through `setVar`), `v2SetAuthorNote`
(1801-1808, `writeChatMeta({ note })`), `v2Command` (690-697, `processMultiCommand(value, chatTarget)`:
the commands write through the chat module, `command.ts:129-178`, `224-234`), the cloned-chat
effects `v2CutChat` (637-654), `v2ModifyChat` (656-668), `v2Impersonate` (678-688) that the
caller applies, `triggerlua` (349-365), `v2RunTrigger` (606-621). The character writers, each
writing two targets today: the selected character by index through a live `getDatabase()` alias
(`db.characters[selectedCharId].<field> = ...`) and then `setCurrentCharacter(char)`, which
replaces every own field of the record with the clone's `chaId` (the trigger's character) by
the copy taken at run start (`database.svelte.ts:774-785`): `v2ModifyLorebook` (856-876; passes
the live selected record at 875 instead of the clone, so only the selected character gets the
lore), `v2SetLorebookActivation` (914-928), `v2SetCharacterDesc` (1084-1094),
`v2SetReplaceGlobalNote` (1124-1134), `v2CreateLorebook` (1625-1659), `v2ModifyLorebookByIndex`
(1661-1714), `v2DeleteLorebookByIndex` (1716-1738), `v2SetLorebookAlwaysActive` (1748-1770). The
persona writer `v2SetPersonaDesc` (1106-1115: today `DBState.db.personas[DBState.db.selectedPersona].personaPrompt = value`
and `DBState.db.personaPrompt = value`; Phase 3 `forwarding-personas` rewrites it to the
forwarded `DBState.db.personaPrompt` only, and `v2GetPersonaDesc` (1096-1104, `getDatabase()` at 1097) to read that field). The lore read effects (`v2GetLorebook*`, `v2GetAllLorebooks`,
`v2GetLorebookByName`, `v2GetLorebookByIndex`, `v2GetLorebookCountNew`) only normalize the clone
(`char.globalLore ??= []`) and write variables. `v2UpdateChatAt` (1440-1445) bumps
`ReloadChatPointer` only. The result object (2081-2089) carries no character. Callers and how
they persist the returned chat: `index.svelte.ts:1082-1091` (`start`, `applyChatResult` with the
generation id), `2088-2096` and `2200-2208` (`output`), `DefaultChatScreen.svelte:227-234`
(`input`), `command.ts:252-260` and `Chat.svelte:446-464` (`manual`); `scripts.ts:149-156` and
`request/request.ts:267-278` run display and request mode and read `displayData` only. Group
sends: `sendChat` keeps the group's `chatTarget` and passes `speakerChaId` per member
(`index.svelte.ts:439-443`); `currentChar` becomes the speaking member (458-459), so `char`
inside `runTrigger` is the member while `contextRef` is the group's chat.

Stopping condition: an effect whose write cannot be expressed as a patch of the trigger's
character or the chat's fields (none found; every writer replaces one own field), or a caller
that needs the returned character (none: no caller reads a character from the result).

## Assumptions

- `character-and-collection-mutations` landed: `updateCharacter(chaId, patch)` validates the
  value, clones it, assigns the one field, and marks the character; `updatePersona(id, patch)`.
- Phase 3 landed: `selection.personaId` (`src/ts/storage/selection.svelte.ts`) is the per-client
  selected persona id and `DBState.db.personaPrompt` is a forwarding accessor over it; if the
  Phase 3 spike failed, `SelectedPersona` in `selected.svelte.ts` holds the id instead, and this
  slice reads the id from whichever exists (contingent boundary in the report).
- The trigger's character is the clone's `chaId` (`char.chaId`): the send's character, which in
  a group send is the speaking member, not the group; the chat screen's character for `input`
  and `manual`. Phase 2's residual "character-level trigger helpers still read the selected
  character" is closed here, and the Lua slice resolves the executing member the same way, so
  Phase 5's `trigger-runtime` and `lua-bindings-and-buttons` inherit one rule.
- Today's two-target behavior (the selected record's field, then the whole clone onto the
  trigger's record) means a trigger of a non-selected character also edits the selected one, and
  an edit to any other field of the trigger's character made since the run started is overwritten
  by the clone.

## Proposed decisions

- Character effects (proposed): each of the eight writers keeps editing the clone and then calls
  `updateCharacter(char.chaId, { globalLore: char.globalLore })` (the six lore writers),
  `updateCharacter(char.chaId, { desc: value })`, or `updateCharacter(char.chaId, { replaceGlobalNote: value })`;
  the `getDatabase()` alias, the `get(selectedCharID)` lookup, and the `setCurrentCharacter`
  call go. Three recorded behavior changes: the write lands on the trigger's character only
  (the selected character is untouched when it differs); in a group send that is the speaking
  member, not the group (today the group record gets the lore and the member gets the clone);
  only the changed field is written, so edits made to other fields of that character while the
  trigger ran are kept. The one-field patch is not required by Decision 5 (an unforced
  improvement) but it is what Phase 5's `applyChanges` port writes anyway. Alternative (keep
  writing the selected character) rejected: Phase 5's job has no selection.
- Persona effect (proposed): `v2SetPersonaDesc` calls `updatePersona(selection.personaId,
{ personaPrompt: value })` and writes nothing else. After Phase 3 the forwarded write
  `DBState.db.personaPrompt = value` already carries the id, so this form is optional; it is
  taken because it is the shape `trigger-runtime` ports. It stays the selected persona, not the
  chat's bound persona (`Chat.bindedPersona`): Phase 4 preserves selected-persona behavior and
  Phase 5 uses the frozen effective persona of its execution context under Decision 5 (an
  explicit handoff, recorded in the report). Under the Phase 3 fallback the same call reaches
  `SelectedPersona`'s id.
- `v2GetPersonaDesc` stays as Phase 3 leaves it (a read of the forwarded field); the
  `getDatabase()` at 1097 is a read.
- Nothing about the chat side changes: variables, the note, `v2Command`, and the returned chat
  keep Phase 2's paths. The phase file's "persisted with `replaceChat`" is `applyChatResult`
  (drift; `replaceChat` is its fallback for a reorder only).
- The `display` run in `processScriptFull` (`scripts.ts:149-156`) keeps `getCurrentCharacter()`:
  display runs never write, and Phase 5's `script-transform` replaces that path.

## Validation

`pnpm check`, `pnpm test` (`command.test.ts` covers `/trigger` through `applyChatResult`),
`pnpm format:check`. Exit check for this file, discovery only (the rooted pattern of the
closeout): `rg -n --pcre2 '\b(db|DBState\.db)(\.[\w$]+|\[[^\]]+\])+\s*(=(?!=)|\+=|-=|\?\?=|\|\|=)' src/ts/process/triggers.ts`
answers nothing (today the rooted pattern finds eight hits: the six `globalLore` alias writes
and the two persona writes at 1112-1113; the two cast writes `(db.characters[i] as character).desc`
at 1092 and `.replaceGlobalNote` at 1132 escape it through the parenthesized cast, one more
reason the grep is discovery, not proof);
`rg -n 'getDatabase\(\)' src/ts/process/triggers.ts` answers exactly the two reads at 161
(`templateDefaultVariables`) and 1097 (`v2GetPersonaDesc`); `rg -n 'setCurrentCharacter|selectedCharID' src/ts/process/triggers.ts`
answers nothing. Review-step tests (`triggers.test.ts`, new, over `storeBackedServer.ts` with a
fixture character, a fixture group with two members, and a v2 trigger list): each lore writer,
`v2SetCharacterDesc`, and `v2SetReplaceGlobalNote` run with `chatRef` of a character that is not
selected land in that character, mark it dirty, leave the selected character unchanged, and
leave an unrelated field of the trigger's character edited meanwhile intact; the same effects
run for a group member during a group send (the member's `char`, the group's `chatRef`) land in
the member and not in the group; `v2SetPersonaDesc` writes the selected persona record and the
forwarded field reads it back; the display and request runs write nothing. Manual, recorded
here: a card whose output trigger creates a lore entry, sent while another character is selected
mid-stream, lands the entry in the sending character after a reload and the selected character
is unchanged; the same in a group.

## Residual risk

Trigger lines are not atomic (Phase 2's known limit): effects before a refused write stay
applied. The clone is still taken at run start, so a lore list edited by the user during a long
trigger is overwritten by the trigger's list (one field, not the whole character; unchanged
from today's semantics for that field). `v2SetPersonaDesc` writes the selected persona; the
effective persona is Phase 5's.

## Implementation record

Implemented 2026-10-01 on `5b177560`, by the amendments of
[`implementation-plan.md`](implementation-plan.md) (slice 6). Only `src/ts/process/triggers.ts`
changed.

- **`writeCharacter(patch)`** (in `runTrigger`) calls `updateCharacter(char.chaId, patch)`: the
  trigger's character (the working copy keeps its `chaId`; in a group send, the speaking member).
  - It does nothing in display and request runs (F-b), like `writeChatMeta`.
  - A character that is gone, or a refused patch, is warned about and skipped, never thrown inside
    the effect switch.
- **The eight character effects** keep editing the working copy and then write one field through
  it:
  - `globalLore`: `v2ModifyLorebook`, `v2SetLorebookActivation`, `v2CreateLorebook`,
    `v2ModifyLorebookByIndex`, `v2DeleteLorebookByIndex`, `v2SetLorebookAlwaysActive`;
  - `desc`: `v2SetCharacterDesc`;
  - `replaceGlobalNote`: `v2SetReplaceGlobalNote`.
  - The selected-index writes through `getDatabase()` and the whole-copy `setCurrentCharacter`
    calls are gone. `v2ModifyLorebook` now writes the trigger's character, not the selected one.
- **`v2SetPersonaDesc`** (F-c): `updatePersona(selectedPersonaForWrite(DBState.db).id,
{ personaPrompt })`. It warns and skips when no persona is selected or the write is refused, and
  writes nothing in display and request runs. It stays the selected persona (the effective persona
  is Phase 5's).
- `v2SetLorebookActivation` skips, with a warning, an index that names no entry (a non-integer,
  negative, or out-of-range index threw and aborted the trigger; challenge 2).
- The `setCurrentCharacter` and `selectedCharID` imports are removed. Nothing on the chat side
  changed.

Recorded behavior changes:

- A trigger's character effect lands on the trigger's character only. The selected character is
  untouched when it differs. Before, the selected record got the field and the trigger's record
  got the whole copy.
- In a group send, the lore and description effects land on the speaking member, not the group.
- Only the changed field is written. Other fields of that character edited while the trigger ran
  are kept, including a Lua script's edit through slice 5's setters earlier in the same trigger
  (Astra's slice 5 note).
- Display and request runs make no character or persona mutation call. Their lore effects still
  edit the live `globalLore` in place until Phase 5 isolates those runs (F-b, recorded).
- `v2SetPersonaDesc` in a display or request run no longer writes. Before, the forwarded write ran
  in every mode that reached it.

No stopping condition was met.

Exit checks:

- The rooted pattern over `triggers.ts` answers nothing.
- `getDatabase()` answers `templateDefaultVariables` and `v2GetPersonaDesc`.
- `setCurrentCharacter|selectedCharID` answers nothing.

No existing test was invalidated, so no test adapter ran; `triggers.test.ts` does not exist yet.

Checks:

- `pnpm check`, `pnpm format:check`, and `pnpm build` pass.
- `pnpm test`: 92 files, 958 passed, 3 skipped.
- `pnpm test:e2e`: 5 passed.

Manual check (Playwright, scratchpad `checkP4Slice6.mjs`). Alpha and a group member each carry an
output trigger that creates a lore entry and sets the description. A plugin provider answers after
3 s, and the selection moves to Beta a second into the send.

- **Alpha's send:** Alpha got the entry and the description, and Beta was unchanged.
- **The group's send:** the member got the entry and the description, and neither the group nor
  Beta changed.
- Both held after a reload, and there were no page errors.

## Tests

Written by the Fable review (verdict: no problem): `src/ts/process/triggers.test.ts`, 18 tests
over the real save adapter and server store, with real wasmoon for the Lua case.

- All eight character effects on object-shaped lore. Each writes a one-key patch to the trigger's
  character (a member's copy on the group's chat, with the group selected). Unrelated fields, the
  group, the other member, and the selection are left alone, and only that character's record is
  sent. The two deprecated effects are pinned as they behave today (see the Astra challenge,
  point 1).
- Invalid activation indices (`-1`, `0.5`, a non-number, unset, out of range, empty list) are
  warned about and skipped, and the later effects are written.
- A Lua `setDescription`, then a native lore creation and a global-note write: all three land.
  The stale native getter (challenge 3) is characterized.
- A trigger suspended on an input:
  - selection moves and a rename meanwhile are kept;
  - a character deleted meanwhile warns, writes nothing, and is not recreated;
  - a refused write warns and the next effect is written.
- `v2SetPersonaDesc`:
  - it writes the persona selected at effect time, not the chat's bound persona, and the
    forwarded field reads it back;
  - a missing selection or a refusal warns and writes nothing.
- Display and request runs, and an `output` run with `displayMode`, make no mutation call and send
  nothing.

The file fails 17 of 18 against the pre-slice `triggers.ts`; the passing one is the allowlist
case, which predates the slice. `pnpm test`: 93 files, 976 passed, 3 skipped. `pnpm check` and
`pnpm format:check` pass.

## Astra challenge

Astra (the open plan-review session) challenged the implementation. Report:
`astra-p4-slice6-challenge.md` (scratchpad). It found no new defect in the diff. It confirmed that
the slice 5 case is fixed: a native lore patch holds only `globalLore`, so it cannot overwrite a Lua
edit of another field. Decisions:

1. **Medium, pre-existing: two deprecated lore effects use an array entry shape.**
   `v2ModifyLorebook` matches `entry[0]` and writes `entry[1]`, so it never matches an object entry
   and writes the list unchanged. `v2SetLorebookActivation` writes `entry[2]`, adding a junk field
   instead of `alwaysActive`. Their paired reads share the shape. **Rejected for this slice:** it
   predates Phase 4, the slice changes where the writes go and not what the effects do, and the
   repair changes deprecated effect semantics, which is an owner decision. Recorded, and raised as a
   separate task (repair them as aliases over the object schema, or retire them). Until then, "six
   lore writers" means six routed writes, not six working effects.
2. **Medium, pre-existing: `v2SetLorebookActivation` threw on a bad index** before the guarded
   write, aborting the rest of the trigger. **Adopted:** an integer index naming an existing entry
   is required, and anything else is warned about and skipped.
3. **Low: native getters read the working copy after a Lua write.** A Lua setter writes the live
   record, while `v2GetCharacterDesc` reads the copy taken at run start. So Lua `setDescription`
   followed by a native get returns the old value, and a native set fed from it restores that value.
   **Recorded, not fixed:** it follows the retained working-copy design. The fix, Lua returning its
   character changes into the working copy (preferred) or native getters reading the live record,
   belongs to Phase 5's `trigger-runtime`.

Astra's testing advice goes to the Fable review with Opus's judgement.
