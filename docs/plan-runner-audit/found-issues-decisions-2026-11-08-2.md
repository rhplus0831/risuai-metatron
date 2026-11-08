# Found Issues Decisions Plan audit, 2026-11-08 (second)

- Plan: [docs/plan/found-issues-decisions.md](../plan/found-issues-decisions.md)
- Commit audited: `38329666b` (`dev`), the plan as revised after the
  [first audit](found-issues-decisions-2026-11-08.md)
- Mode: `full`
- Model: GPT-6.1-Sol (`xhigh`), read-only; report written by the plan-runner orchestrator (Claude Opus 5.5)

| Severity   | Count |
| ---------- | ----- |
| P1         | 1     |
| P2         | 0     |
| P3         | 2     |
| unverified | 0     |

Tests, browser behavior, and timings were not run. The first audit's corrections are applied in the plan;
G1 comes from the revised D2 policy. G2 and G3 were applied to the plan in the commit that adds this
report; G1 stands as found.

## P1

### G1 — D2: pruning at the opening commit deletes the input a later recording exposes again

Plan, D2: "a failed run followed by a recording keeps its input while it is still that newest unrecorded
run", and "The prune happens at the durable commit boundaries (... opening, failure, interruption and
recorded writes ...)", which strips the fields from every older run that is not the replay target.

Code: `replayedInput` picks the newest run whose result is not `recorded`, a `pending` run included
(`server/src/prompt/memory/structured/writer.ts:331`). The opening commit durably inserts the new pending
run before its model call (`writer.ts:539`), and the recorded write later turns that same run into
`recorded` (`writer.ts:949`); an updated run keeps its storage position (`server/src/data/memoryStore.ts:783`).
So for failed F then pending P, the opening commit makes P the replay target and strips F; when P records,
F is the newest unrecorded run again, but its input is gone. Both promises cannot hold.

Suggested correction: let the previous replay candidate keep its prompts while a newer run is pending
(prune against the settled outcome), and say so in _Done_. Cover failure → pending → success, with a
restart or interruption, through the replay harness at `server/src/tests/memoryTasks.test.ts:5197`. Apply
the same policy to the final rebuild swap, which appends staged runs into the live history on its own
(`memoryStore.ts:1136`).

## P3

### G2 — A2: the client test file exercises the transport, not the escape loop

Plan, A2 _Test_: "`src/ts/process/request/tests/transport.test.ts`: an escape case with
`forceStreaming: true`".

Code: `transport.test.ts:129` imports `requestServer` and the cases call it directly (`:337`), bypassing the
flag clearing and success escaping (`src/ts/process/request/request.ts:384`, `:448`); its plugin-hooks mock
(`:91`) has no provider or replacer registries. `requestPresetScope.test.ts:71` imports the real
`requestChatData`, with a provider and replacer harness from `:15`.

Correction (applied): name `requestPresetScope.test.ts`, its escape assertion on real escaping rather than
its identity mock.

### G3 — C1: the file inventory leaves out the watermark helper's caller

Plan, Order: "the parser, the three disclosure components and the mocks named in C1".

Code: `src/lib/ChatScreens/ChatBody.svelte:28` imports `addMetadataToElement` and calls it at `:567` and
`:573`; removing the parser export needs this file too.

Correction (applied): name `ChatBody.svelte` in the Order inventory and in C1 point 4 (drop the import and
both wrappers, keeping the sanitization and `pruneEmptyBilingualPairs`).

## Checked and found correct

- The eighteen decisions and their dispositions; every named _Test_ file exists; no `~N` anchor is far
  from its code.
- A1: the streaming controls, the batching bypass, and the tool recursion as the revised text states them.
- A2: the stream-collection design for a plugin provider in both runtimes.
- A3: the absence timing and the creator-identity rules.
- B1 refusal, B2 forced deferral, B3 cache accounting, B4 contracts.
- C1: the env parsing, the default, the index routes, the ETag-only revalidation, and the mocks.
- D1: the estimate paths; D2: the readers, the dry-run commit, the Log route and export, restore, and the
  probe correction.
- E1: the narrowed Limitations and the counts.
- Order: apart from G3 no missing source file and no other source or test overlap; D1/D2's
  `shared/structuredMemory.ts` overlap is already acknowledged; the guide overlaps are complete. Largest
  guides touched: `persistence.md` 28,866, `self-host-server.md` 28,771, `cbs-rendering.md` 28,724 bytes.
- The four mechanisms: `patchMessage` closes a fence (`server/src/data/chatStore.ts:2532`; D2's receipt
  path checks locks first, `writer.ts:413`); feed rows are measured whole against 65,536 bytes
  (`chatStore.ts:1969`, `shared/resources.ts:540`) and D2's memory writes publish no chat change;
  `STORE_TABLES_SQL` runs at version zero and for a restore's new output database
  (`server/src/data/resourceStore.ts:3815`, `:792`), and neither A3 nor D2 needs a schema change;
  `sendText` counts a socket only after a buffer-admitted send (`server/src/jobs/generationJobs.ts:1023`,
  `:1034`), which A3 keeps.
