# Slice: MCP RisuAccess Writers

Status: implemented (2026-09-30, on `0d7c1cd6`; record below).

Phase: [Phase 4](../../phase-4-external-contracts.md), "MCP RisuAccess" (the set and delete tools
use mutations; `getCharacter` returns no live object; the read tools are unchanged), plus the
two MCP writers the phase file does not name (`mcp.ts` and `googlesearchclient.ts`); `PLAN.md`
Invariant 2 and Decision 5 (Phase 5's `mcp-on-server` runs `internal:risuai` on the server
against server data, so its writes must already be id-addressed operations).

Depends on: `character-and-collection-mutations` (`updateCharacter`, `findCharacter`,
`updateModule`, `setModuleEnabled`, `addModule`, `addAuthRefresh`, `updateSettings`); Phase 3
`server-section-normalizers` and `client-section-mirrors` (`googleSearchCredentials` is a
`secrets` field, `authRefreshes` its own collection). Parallel with the plugin, Lua, trigger,
and import slices (disjoint source files; no docs edited here).

## Scope

Allowed files: `src/ts/process/mcp/risuaccess/{characters,modules,chats,utils}.ts`,
`src/ts/process/mcp/mcp.ts` (`registerRefresh`, `importMCPModule`),
`src/ts/process/mcp/googlesearchclient.ts` (the credential write),
`src/ts/process/mcp/risuaccess/tests/modules.test.ts` (only if its `DBState` mock needs the
module). Tests belong to the review step; the guide belongs to the closeout.

Identifiers (verified 2026-09-30 at `577c43ae`): `getCharacter(id)` (`utils.ts:4-5`: the live
`DBState.db.characters.find(...)` by `chaId` or `name`, or `getCurrentCharacter()` for an empty
id; every write handler mutates its result through that alias, which is why the rooted grep
finds zero hits in `characters.ts`). `CharacterHandler.handle` (`characters.ts:348-358`) marks
the character dirty after any `risu-(set|delete)-*` dispatch, even a refused one. Write handlers
and their live mutations: `risu-set-character-info` (553-611; `// @ts-ignore` at 592 and
`char[realField] = value` at 593 over the `fieldRemap` `name`, `greeting`→`firstMessage`,
`description`→`desc`, `replaceGlobalNote`, `alternateGreetings`, `backgroundEmbedding`→`backgroundHTML`),
`risu-set-character-lorebook` (613-701; `char.globalLore.push` 668, entry field assignments
677-692), `risu-delete-character-lorebook` (703-757; `splice` 749),
`risu-set-character-regex-scripts` (797-881; `push` 857, assignments 866-873),
`risu-delete-character-regex-scripts` (883-941; `splice` 933),
`risu-delete-character-additional-assets` (976-1034; `splice` 1026),
`risu-set-character-lua-script` (1073-1118; `firstTrigger.effect[0].code = code` 1101-1103).
Every write handler resolves the character, awaits `promptAccess`, and then mutates the object
resolved before the await. Read tools (unchanged): `risu-get-character-info`,
`risu-list-character-lorebooks`, `risu-get-character-lorebook`, `risu-get-character-regex-scripts`,
`risu-get-character-additional-assets`, `risu-get-character-lua-script`, `risu-list-characters`
(1120-1137, reads `DBState.db.characters` directly), `risu-get-chat-history` (`chats.ts:43-83`,
reads `char.chats[char.chatPage].message` and copies the array). Module handlers (`modules.ts`;
every one finds the live module with `DBState.db.modules.find` before the consent await):
`risu-set-module-info` (422-474; `DBState.db.enabledModules = Array.from(...)` 454-461,
`// @ts-ignore` at 463 and `module[key] = value` 464 over `name`, `description`,
`lowLevelAccess`, `backgroundEmbedding`, `customModuleToggle`), `risu-set-module-lorebook`
(538-618; captures `module` at 546, awaits consent at 551-555, then writes the captured object),
`risu-delete-module-lorebook` (620-666), `risu-set-module-regex-script` (694-765),
`risu-delete-module-regex-script` (767-813), `risu-set-module-lua-script` (839-872); the module
writes rely on the deep `modules` watcher. Confirmation gates: `promptAccess`
(`characters.ts:11-12`, `modules.ts:15-16`) before every write. Other MCP writers:
`mcp.ts:102-107` (`registerRefresh` pushes into `DBState.db.authRefreshes`), `mcp.ts:231-251`
(`importMCPModule` pushes a module with a `v4()` id through a live alias),
`googlesearchclient.ts:78-83` (`DBState.db.googleSearchCredentials = credentials`). Test:
`risuaccess/tests/modules.test.ts` (eight read cases; no write handler is exercised,
`alertConfirm` is mocked and never asserted). Grep residuals today (Luna fan-out C): the rooted
pattern finds `modules.ts:461`, `mcp.ts:103`, `mcp.ts:232`, `googlesearchclient.ts:83`;
`getDatabase()` at `mcp.ts:20` (unused) and `231`.

Stopping condition: a tool whose write cannot be expressed as one field patch of a character or
module (none found: each handler replaces one own field or list), or a `DeepReadonly` consumer
in the handlers that `pnpm check` cannot satisfy without a cast (then the cast is recorded and
the consumer copies the value instead).

## Assumptions

- `character-and-collection-mutations` landed with `findCharacter(chaId)` (read-only mirror
  view), `updateCharacter(chaId, patch)`, `updateModule(id, patch)`, `setModuleEnabled(id, on)`,
  `addModule(module)`, `addAuthRefresh(entry)`, and `updateSettings(patch)` restricted to the
  section fields, all validating their values.
- After Phase 3, `googleSearchCredentials` is a `secrets` field mirrored flat in `DBState.db`
  (its watcher transports the write) and `authRefreshes` is the `authRefreshes` collection
  (client-readable; Phase 5's `mcp-on-server` moves its writes server-side, reported as
  `resource` events). If Phase 3 keeps either elsewhere, only the function's target section
  changes, not this slice.
- `DeepReadonly` is a compile-time type: the guarantee it gives is that `pnpm check` lists every
  mutation of a value typed through it, which holds only if no `@ts-ignore` or cast hides one.
- The `RisuAccessClient` is also used by Iris (`iris.ts`) and the MCP playground; both go
  through `callTool`, so no other entry needs changing.

## Proposed decisions

- `getCharacter` (proposed): returns `DeepReadonly<character | groupChat> | undefined` (the
  mirror record, read-only typed; the `name` fallback stays); the handlers' mutable
  `character | groupChat` annotations become the read-only type; the two suppressions
  (`characters.ts:592`, `modules.ts:463`) are deleted, so `pnpm check` lists every remaining
  mutation of a handler's character or module; every consumer of the view is audited (a
  consumer that needs a mutable copy clones the one field it changes). The phase file's word is
  "snapshot"; a `$state.snapshot` of a character copies all of its chats on every tool call
  (`risu-get-chat-history` reads one message list), so the read-only view is proposed instead:
  same guarantee at the type level, no copy. The alternative recorded: a snapshot of the
  character without `chats` for the character handler and the view for the chat handler.
- Re-resolution after consent (proposed; Astra P10): for characters and modules alike, a write
  handler captures the id (`chaId` or module id) before `promptAccess`, re-resolves the record by
  that id after the await, rechecks existence and type (a group for a character tool, `mcp` for a
  module), and only then copies the current list and patches it; a record replaced or removed
  while the prompt was open is patched as it is now or answers "not found".
- Character writes (proposed): each write handler computes the new value on a copy
  (`safeStructuredClone` of the one list it changes) and calls `updateCharacter(chaId, patch)`:
  `risu-set-character-info` with the remapped fields in one patch (validated before any write,
  so a rejected field changes nothing: today the loop writes the earlier fields and then returns
  the error); the lore, regex, and asset tools with `{ globalLore }`, `{ customscript }`,
  `{ additionalAssets }`; the Lua tool with `{ triggerscript }` (the copied list with
  `effect[0].code` replaced). The post-dispatch `markCharactersDirty` in `handle` goes (the module
  marks, and only on a write that happened).
- Module writes (proposed): `risu-set-module-info` calls `setModuleEnabled(id, value)` for
  `enabled` and `updateModule(id, patch)` for the rest; the lore, regex, and Lua module tools
  compute the new list on a copy and call `updateModule(id, { lorebook })`, `{ regex }`,
  `{ trigger }`. Reads keep `DBState.db.modules.find` (a read).
- `importMCPModule` → `addModule({...})` (id already `v4()`); `registerRefresh` →
  `addAuthRefresh({ url: mcp, ...arg })`; the Google credential prompt → `updateSettings({ googleSearchCredentials })`.
- Confirmation gates and tool schemas are unchanged (the safety contract: no API shape or
  permission change).

## Validation

`pnpm check` (the type-level check above), `pnpm test` (`risuaccess/tests/modules.test.ts`),
`pnpm format:check`. Exit check, discovery only: the rooted pattern of the closeout over
`src/ts/process/mcp/risuaccess`, `mcp.ts`, and `googlesearchclient.ts` answers nothing (today:
the four hits above; the `characters.ts` writes are alias writes the grep never saw, which the
type-level check covers); `rg -n 'getDatabase\(\)' src/ts/process/mcp` answers only `mcp.ts:20`
(an unused binding, removed or left; classified); `rg -n 'markCharactersDirty|@ts-ignore' src/ts/process/mcp/risuaccess`
answers nothing. Review-step tests (`risuaccess/tests/characters.test.ts`, new, over
`storeBackedServer.ts`, `alertConfirm` mocked to `true` and once to `false`): every character
write tool on a character that is not selected lands by `chaId` and is sent by the next cycle;
a refused confirmation changes nothing and marks nothing; `risu-set-character-info` with one bad
field changes nothing; a character or module replaced (a conflict reload) or removed while the
consent prompt is open is patched as it is now or answers "not found"; the read tools return the
same output as the snapshot file; every module write tool on a fixture module; `importMCPModule`
adds a module with an id. Manual, recorded in the closeout: Iris asked to add a lorebook entry
to a character that is not selected; the entry survives a reload.

## Residual risk

The read tools still walk the eagerly loaded mirror (lazy loading is Phase 6, as the plan says).
`risu-list-characters` and `risu-get-chat-history` read `chatPage` (the per-tab selection), so
another tab's selection is not what the tool sees; unchanged and expected. Iris runs these tools
in the client until Phase 5's `mcp-on-server`.

## Implementation record

Implemented 2026-09-30 on `0d7c1cd6`, by the amendments of
[`implementation-plan.md`](implementation-plan.md) (slice 4).

- **`risuaccess/utils.ts`**: `getCharacter` returns the mirror record typed
  `DeepReadonly<character | groupChat> | undefined`. The name fallback and the empty-id selection
  stay.
- **`risuaccess/characters.ts`**:
  - `writeConfirmed(id, tool, action, write)` resolves the character, refuses a group, asks for
    consent, then resolves it again by the captured `chaId` through `findCharacter` and checks
    it again. It then runs `write`, which is synchronous, on that record, so no await falls
    between the last lookup and the write (Astra challenge 1). A character removed while the
    prompt was open answers "not found".
  - Each write tool's `write` builds the one list or field set it changes from that record, then
    calls `updateCharacter(chaId, patch)` through `patchCharacter`. That helper answers a
    `MutationValidationError` as an `Error:` text, and a character gone by then as "not found".
    - `risu-set-character-info`: the remapped fields in one patch. An unknown field is answered
      before anything is written, so one bad field changes nothing (it wrote the fields before it
      before). Only the remap's own keys are fields: `constructor`, `toString`, or a parsed
      `__proto__` is an unknown field (challenge 2; they passed the lookup before).
    - The lorebook, regex, and asset tools patch `globalLore`, `customscript`, or
      `additionalAssets`. A character without `globalLore` reads as an empty lorebook
      (challenge 4; the lore tools threw on it).
    - The Lua tool patches `triggerscript`, with `effect[0].code` replaced in a copy.
  - The post-dispatch `markCharactersDirty` in `handle` is gone: `updateCharacter` marks, and
    only when it wrote. The `@ts-ignore` is gone.
- **`risuaccess/chats.ts`**: the read-only annotation (a read; unchanged otherwise).
- **`risuaccess/modules.ts`**:
  - Every handler reads through `findModule(id)`.
  - `writeConfirmed(id, tool, action, write)` finds the module, refuses an MCP module, asks for
    consent, finds it again by the same id (never by name), checks it again, and runs the
    synchronous `write` on it.
  - The lorebook, regex, and Lua tools patch `lorebook`, `regex`, or `trigger` through
    `updateModule`.
  - `risu-set-module-info` checks each field against the type its schema declares (challenge 3),
    writes the other fields through `updateModule`, then calls `setModuleEnabled` for `enabled`,
    so a refused value changes neither. Unknown keys are still skipped, as before.
  - The `@ts-ignore` is gone.
- **`mcp.ts`**: `registerRefresh` calls `addAuthRefresh`; `importMCPModule` calls `addModule`; the
  unused `getDatabase()` binding in `initializeMCPs` is removed.
- **`googlesearchclient.ts`**: the credential prompt writes through
  `updateSettings({ googleSearchCredentials })` (a `secrets` field).

Recorded behavior changes:

- A refused `risu-set-character-info` field changes nothing. Before, the fields ahead of it were
  written.
- A write tool builds its patch from the record as it is after consent.
- `risu-set-module-info` refuses a value of the wrong type. `enabled: "false"` enabled the module
  before (a truthiness test); `name: 5` was stored.
- A denied or failed character tool no longer marks the character dirty.

No stopping condition was met: every tool's write is one field patch, and `pnpm check` needed no
cast for the read-only records.

Exit checks:

- `rg -n 'markCharactersDirty|@ts-ignore' src/ts/process/mcp/risuaccess` answers nothing.
- `rg -n 'getDatabase\(\)' src/ts/process/mcp` answers nothing.
- The rooted pattern over `src/ts/process/mcp` answers only the fixtures in
  `risuaccess/tests/modules.test.ts` (test files are excluded).

No existing test was invalidated: `modules.test.ts`'s harness covers `findModule` unchanged, so no
test adapter ran.

Checks:

- `pnpm check`, `pnpm format:check`, and `pnpm build` pass.
- `pnpm test`: 88 files, 921 passed, 3 skipped.
- `pnpm test:e2e`: 5 passed.
- After the challenge fixes: `pnpm check` and the MCP tests again, then the gates in full (see
  Tests).

Manual check (Playwright, scratchpad `checkP4Slice4.mjs`). The client's `callTool` stands in for
Iris, which calls the same entry. With Alpha selected:

- On Beta:
  - the lorebook, info, regex, and Lua tools landed;
  - a call with an unknown field and a refused consent each changed nothing;
  - the read tool returned the new entry.
- After the challenge fixes: `{ name, constructor }` and a module's `enabled: "false"` were
  refused and changed nothing.
- Gamma, removed while the consent prompt was open, answered "not found", and nothing was
  recreated.
- The module lorebook, info (with `enabled`), regex, and Lua tools landed.
- Everything held after a reload, and there were no page errors.
- Not driven: `importMCPModule` and `registerRefresh` (they need a live MCP server and an OAuth
  flow), and the Google credential prompt.

## Tests

Written by the Fable review (verdict: no problem), over the real save adapter and server store,
with consent mocked by a queue that can hold a prompt open:

- `risuaccess/tests/characters.test.ts` (14):
  - every character write tool on a character that is not selected, landing by id and sent in the
    next cycle;
  - a denial, a missing entry, a refused patch, a group id, and an unknown id each write nothing;
  - mixed valid and invalid info fields (`constructor`, `toString`, a parsed `__proto__`, `id`)
    write nothing;
  - the consent gap: a replacement, a change to a group, a removal, and a rename or selection
    change while the prompt is open, and Astra's microtask probe;
  - an absent `globalLore` and a missing Lua trigger;
  - the read outputs.
- `risuaccess/tests/moduleWriters.test.ts` (11):
  - every module write tool;
  - an MCP module is refused, including one that became an MCP module while the prompt was open;
  - the nested Lua copy keeps the rest of the trigger;
  - info with `enabled`, and the wrong-type policy (`enabled: "false"`, `1`, or `null`, and
    `name: 5`, each refused with nothing written);
  - absent lists, and caller data detached.
- `mcp/tests/mcpWriters.test.ts` (6):
  - `importMCPModule` adds a module with an id, and an invalid URL adds nothing;
  - the registered refresh token is stored in `authRefreshes` under the server's URL and found
    again;
  - the Google credential prompt: stored credentials ask nothing, trimmed inputs reach
    `secrets`, and cancelled or blank inputs write nothing.

`pnpm test`: 91 files, 952 passed, 3 skipped. `pnpm check` and `pnpm format:check` pass.

Found in passing and left for a separate task: `importMCPModule` throws a `TypeError` on a
cancelled URL prompt (present before this slice).

## Astra challenge

Astra (the open plan-review session) challenged the implementation. Report:
`astra-p4-slice4-challenge.md` (scratchpad). Decisions:

1. **High: an await between the helper's last lookup and the write.** The helper returned the
   record through a promise, and the caller's `await` let a replacement land before the patch was
   built. Astra's probe overwrote a fresh lore list and wrote into a module that had become an MCP
   module. **Adopted** (the recommended fix): the helper runs a synchronous `write` callback on the
   record right after its final check.
2. **Medium: inherited names passed the character field lookup.** **Adopted**: `Object.hasOwn`.
3. **Low: `setModuleInfo` took `enabled` by truthiness and checked no field types.** **Adopted**:
   each field is checked against its schema type before any write (a recorded behavior change).
   `setCharacterInfo`'s field types are left as they were: not raised, and the character fields
   keep their stored-anything behavior until the server's character kind checks them.
4. **Low: the lore tools assumed `globalLore` exists.** **Adopted**: a local `?? []` fallback in
   the reads and writes. Nothing is initialized by a read.

Astra's testing advice goes to the Fable review with Opus's judgement.
