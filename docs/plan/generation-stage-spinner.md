# Generation Stage Spinner Plan

Status: planned 2026-10-23 at `b00982244`. All 4 slices landed on `metatron` through the Combined Run index (`docs/plan/combined-run.md`, plan-runner) between 2026-10-23 and 2026-10-24, one cherry-picked commit each: GS1 (`e1b49f057`), GS2 (`df489ec91`), GS3 (`54e553623`), GS4 (`34c7fe355`). The run's final checks on `b60d8fff5` passed. Source: the spinner analysis
(`docs/research/chat-generation-stage-colors-analysis.md`, inspected at `79ae26cc4`; its
recommended fix, server-reported stages). A Luna fan-out (6 workers) mapped the server
boundaries, the job contract, the client follow, the spinner, the test harnesses, and the
pre-cutover history at `b00982244`. The session re-read the spinner markup and CSS, the
`GenerationEvent` union, the attach snapshot, the runner's `state.stage` and stage timing
sites, and the assembly memory step. Line numbers are approximate; the identifiers are the
anchors. Re-verify each cited location before editing.

One slice is one session, one commit, one file cluster. Each slice names its guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Workflow per slice:
`opus-lite` for a slice marked _small_, `opus-workflow` for one marked _hard_. Each slice
ends with its tests (under "Test"), `pnpm check`, `pnpm format:check`,
`pnpm --silent test:agent` (`--e2e` where it touches a screen an `e2e/` spec covers) and
the owning guide's focused checks, and updates the owning guide where it changes a
documented contract. Code comments and test titles describe behavior, not this plan
(`STRUCTURE.md` T5).

## Problem

The send/stop button's rotating circle no longer shows what a send is doing. Its class is
fixed: `DefaultChatScreen.svelte` (~1047) renders
`<div class="loadmove chat-process-stage-0" class:autoload={autoMode}>`. The stage colors
are still in the component (~1544–1562: 1 blue `#60a5fa`, 2 pink `#db2777`, 3 green
`#34d399`, 4 purple `#8b5cf6`), but nothing selects them, so the circle always takes the
`.loadmove` border token (`src/styles.css` ~429–439).

- Cause: the cutover commit `12ed3baecd` removed the browser pipeline and its writable
  `chatProcessStage`. Before it, `src/ts/process/index.svelte.ts` set 0 at the start of a
  send, 1 for prompt assembly, 2 for memory (Hanurai, HypaV2, HypaV3, and SupaMemory alike),
  3 for the model request and the response, and 4 for the processing after it. The spinner
  was its only reader. No plugin API, Lua, or CBS read it, and nothing does now.
- Nothing replaced it on the server:
  - `GenerationErrorStage` (`shared/jobs.ts` ~137–144) is failure data only.
  - The legacy `progress` notice and `memoryProgress` drive the memory overlays, not the
    spinner.
  - `GenerationEvent`'s top-level `{ type: "progress"; payload: unknown }` (~668) has no
    server emitter and no branch in `applyGenerationEvent`.
  - `GenerationStatus` (~674–684) and the attach snapshot (`generationJobs.ts` `attach`
    ~1251–1287) carry no stage.
- The work the old stages marked is still timed on the server. `stageTimings` (assembly) and
  `stage3Start`/`stage4Start` (runner) feed `generationInfo.stageTiming.stage1`–`stage4`. The
  runner also keeps a diagnostic `state.stage`: `input` ~394, `setup` ~437/~689, `assembly`
  ~1209, `request` ~1338, `tail` ~1578/~1611. The boundaries exist; they are just not
  reported.

What the spinner can show today:

- It is shown while `stoppable` is true (~555):
  `sendAborts.has(currentChatRef()) || ownedJobIds.length > 0`. That is the selected chat's
  own local send or a followed job of that chat, never another chat's.
- Different chats of one tab send at once (Per-Chat Send, archived). A tab-wide stage would
  let one chat's progress recolor another chat's spinner.
- A local send holds its registry entry before its job id exists
  (`index.svelte.ts` ~58–78, `serverCommands.ts` ~348–459). For that time there is no stage
  to show.

## Approach

The server reports a coarse presentation stage per job, retains the latest one on the job,
and replays it on attach. The tab keeps it per job id with its chat, and the selected chat's
spinner takes its class from it. No persisted field and no migration.

The contract, in `shared/jobs.ts`:

- `GENERATION_STAGES = ["preparing", "memory", "generating", "finishing"] as const` and
  `GenerationStage`. Kept apart from `GENERATION_ERROR_STAGES`.
- A new `GenerationEvent` member `{ type: "stage"; epoch: string; stage: GenerationStage }`.
  It is a top-level event, like `preset`, not a channel notice. The registry retains it and
  replays it in the snapshot, and channel notices have no retained state (D1).

| Stage        | Class                  | From (server)                                                                    |
| ------------ | ---------------------- | -------------------------------------------------------------------------------- |
| none yet     | `chat-process-stage-0` | a local send before its job exists, a command job, a job with no stage event     |
| `preparing`  | `chat-process-stage-1` | job start; each speaker or round's setup; prompt assembly; after the memory step |
| `memory`     | `chat-process-stage-2` | the assembly memory step (`useMemory`, ~1498 to its `finally` ~1610)             |
| `generating` | `chat-process-stage-3` | the main model request (`state.stage = "request"`) through the stream's end      |
| `finishing`  | `chat-process-stage-4` | the tail (`state.stage = "tail"`) until the terminal                             |

Rules:

- The registry sends a `stage` only when it differs from the job's current one, and drops
  it on `finalize`. An ended job's snapshot carries no stage, so it can never restore a
  running spinner.
- A stage emit never fails the run: it is skipped once the job has ended.
- Detached memory tasks (`memoryTasks.ts`, after the terminal) are not the job's work and
  send nothing. The HypaV3 overlay and the memory task indicators are unchanged.
- Previews: `preview` and `previewPrompt` report `preparing` and, when memory runs, `memory`.
  They never report `generating` (no reply is made). Command jobs report nothing (D2).
- Groups and rounds: each `runSpeaker` call goes through `preparing` again, so a group's
  second speaker or an auto-continue round cycles the colors. That matches the work (D3).
- The tab keeps `jobId → { chatKey, stage }`. It removes an entry by job id when that job's
  follow ends: terminal, lost, chat load failure, or a `gone` discovery. An older job's
  cleanup can therefore never clear a newer job of the same chat, the same rule
  `followedJobs` follows. Events of another epoch or a superseded follow are already dropped
  by `followGenerationJob` (`generationJobs.ts` ~437–456).
- The spinner shows the stage of the selected chat's newest staged followed job, else 0. The
  `.autoload` green still wins in auto mode (D4). The class names stay, since users' custom
  CSS (`display.customCSS`) can target them.

## Order

1 → (2, 3) → 4.

- Slice 1 is the contract and the registry (retain, de-duplicate, snapshot, finalize).
- Slice 2 (server runner) and slice 3 (tab store and follow cleanup) both need only slice 1,
  and share no file, so they run in parallel.
- Slice 4 binds the spinner. It needs slice 3 for the store and slice 2 for the e2e check.

## Slice 1. Stage contract and its retention in the job registry (_small_, `self-host-server.md`)

- `shared/jobs.ts`:
  - `GENERATION_STAGES`, `GenerationStage`, and the `stage` member of `GenerationEvent`
    (~662–671), with a doc comment: a presentation stage, retained, replayed on attach,
    never a failure stage.
  - `GenerationStatus` gets no field: the attach snapshot is what restores the stage, and
    discovery reads only the epoch and the chat (`serverCommands.ts` ~190–236).
- `server/src/jobs/generationJobs.ts`:
  - `Job.stage: GenerationStage | null` (beside `preset` ~260, initialized in `create`
    ~1187).
  - In `RunningJob.emit`'s switch (~1023): a `stage` equal to `job.stage` returns without a
    send; otherwise it is stored and sent.
  - In `attach` (~1266): a running job pushes `{ type: "stage", epoch, stage }` after the
    preset and before the current reply. An ended job pushes none.
  - `finalize` (~709) sets `job.stage = null`.
  - The `RunningJob.emit` doc comment names the `stage` rule.
- `self-host-server.md`: the registry line (~56) and the "Change generation jobs" recipe
  (~411) name the retained stage.
- Test, in `server/src/tests/generationJobs.test.ts` (fake runner, ~103–111):
  - A repeated stage is sent once; a changed one is sent.
  - A late attach to a running job gets the current stage in its snapshot, after the preset.
  - A job that ended before its owner attached sends no stage before its terminal.
  - In `generations.test.ts` (~323, where the fake runner emits `preset`): a reattach mid-job
    (the existing attach-stamp case) receives the latest stage. Synchronize with the `follow()`
    ping fence, not `sleep`.

## Slice 2. The runner reports its stages (_hard_, `self-host-server.md`)

Depends: 1.

- `server/src/prompt/runner.ts`:
  - A `reportStage(stage)` helper over `job.emit({ type: "stage", stage })`. It is skipped
    once the job ended (catch `GenerationJobEndedError` only).
  - `preparing`: right after the job's `accepted` (~344–350), so the input stage counts;
    and at each `runSpeaker` setup (~688–690).
  - `generating`: where `state.stage = "request"` (~1338), except for `previewPrompt`.
    `preview` returns before it (~1333).
  - `finishing`: where `state.stage = "tail"` (~1578 streaming, ~1611 not).
  - The assembly host gets `stage(stage)`, wired to `reportStage`.
- `server/src/prompt/assemble.ts`:
  - The host type (~118–140) gets `stage(stage: GenerationStage): void`.
  - The memory step calls `host.stage("memory")` after `stage2Start` (~1500) and
    `host.stage("preparing")` in its `finally` (~1610), beside `host.endMemoryProgress()`.
  - The test host in `server/src/tests/assemble.test.ts` (the other `endMemoryProgress`
    implementer) gains the method.
- Command jobs (`commandRunner.ts`) are unchanged (D2).
- `self-host-server.md`: in `runPromptJob`'s description, the stages it reports and where.
  `chat-pipeline.md` (~86, the job's work) names the `stage` event in one clause.
- Test:
  - `server/src/tests/promptRunner.test.ts`, with the scripted provider held
    (`holdBeforeChunk`, ~33–41, ~764–811):
    - A send without memory reports `preparing`, `generating`, `finishing`, then `done`,
      with no repeats.
    - While the provider is held, the last stage is `generating`.
    - A `preview` and a `previewPrompt` report no `generating`.
    - A group with two speakers reports `preparing` before each speaker's `generating`.
  - `server/src/tests/memoryJobs.test.ts`, with `state.holdSummary` (~46–87):
    - A send with HypaV3 reports `preparing`, `memory`, `preparing`, `generating`,
      `finishing`.
    - While the summary is held, the last stage is `memory`.
  - A command job (the existing command test in `promptRunner.test.ts` or
    `commandRunner`'s) emits no `stage`.

## Slice 3. The tab keeps each job's stage (_small_, `chat-pipeline.md`)

Depends: 1.

- `src/ts/process/jobStages.ts` (new; `svelte/store`, no runes, type-only imports, like
  `localSends.ts`, so the hand-written `stores.svelte` and `index.svelte` mocks do not reach
  it):
  - `jobStages`: a writable `Map<jobId, { chatKey; stage }>`, replaced on each change.
  - `setJobStage(jobId, chatKey, stage)`, `dropJobStage(jobId)`.
  - `chatStageOf(map, ref)`: the stage of the chat's newest entry (Map insertion order), or
    null.
  - `resetJobStagesForTests`.
- `src/ts/network/generationJobs.ts` `applyGenerationEvent` (~630–718): a `stage` branch
  calls `setJobStage(jobId, chatStatusKey(ref), event.stage)`.
- `src/ts/process/serverCommands.ts` `followJobToEnd`: `dropJobStage(jobId)` where the
  `followedJobs` entry is removed, in the shared follow's `finally` (~145–151). That covers
  terminal, lost, load failure, and the `gone` early return (~100–104).
- `chat-pipeline.md` State (~111): `jobStages` beside `followedJobs`. `global-api.md`
  (~97): the `stage` event joins the list of events the transport applies.
- Test:
  - `src/ts/process/jobStages.test.ts`:
    - Two chats hold different stages at once.
    - Dropping an older job of a chat keeps a newer job's stage.
    - `chatStageOf` with no entry is null.
  - `src/ts/network/generationJobs.test.ts` (~447): a `stage` event reaches the store under
    its job and chat; one of another epoch does not.
  - `src/ts/process/serverCommands.test.ts` (~1141–1153, the `followedJobs` keying case): the
    stage entry is gone after a terminal, a lost follow, and a chat load failure, and a newer
    job's entry for the same chat survives the older one's end.

## Slice 4. The spinner shows the selected chat's stage (_small_, `ui-theming.md`)

Depends: 2, 3.

- `DefaultChatScreen.svelte`:
  - `const processStage = $derived(...)`: `chatStageOf($jobStages, currentChatRef())` mapped
    to 1–4, else 0.
  - ~1047: `class="loadmove chat-process-stage-{processStage}"`, keeping
    `class:autoload={autoMode}`.
  - The stage CSS (~1544–1567) stays as it is (D4, D5).
- `ui-theming.md` (`DefaultChatScreen.svelte` line ~33): the spinner's color is the selected
  chat's job stage. `chat-pipeline.md` Not tested (~181) drops nothing; it adds the e2e case
  below.
- Test, in `e2e/perChatSends.spec.ts` (the mock provider holds chat A's reply after its
  first chunk, ~26–67; Stop is `button[aria-labelledby="cancel"]`, ~297):
  - While A's reply is held, A's spinner has `chat-process-stage-3`.
  - With B streaming and A selected again, A's spinner still shows its own stage.
  - In auto mode the spinner keeps `autoload` (the existing check, ~381).
  - Use the spec's existing waits. Preparing and memory are covered by the server tests, not
    the browser.
- Check by hand with `util/playwright/checkServerJobMatrix.mjs` (memory case): the circle goes
  blue, pink, blue, green, purple on a send with HypaV3.

## Decisions

The runner takes each default unless the user overrides it.

- D1. Event shape. Options: (a) a top-level `stage` event retained by the registry; (b) a
  channel notice (`GenerationNotice`), handled in `jobChannel.ts`. Default (a): only the
  registry can replay it on attach, and notices are not retained.
- D2. Command jobs (a Lua button, a manual trigger). Options: (a) no stage (the default
  circle); (b) `preparing` for the whole job. Default (a): they do none of the four kinds of
  work.
- D3. Repeated phases. Options: (a) report each speaker's and round's `preparing` again (the
  colors cycle in a group or an auto-continue); (b) report `preparing` only once per job.
  Default (a): it shows the work as it happens.
- D4. Auto mode. Options: (a) keep the `.autoload` green over every stage; (b) show the
  stage in auto mode too. Default (a): it is how auto mode is told apart today.
- D5. Colors. Options: (a) keep the hex colors and class names as they were; (b) move them
  to theme tokens (`STRUCTURE.md` U1). Default (a): this restores old behavior, and custom
  CSS may target the classes; (b) is a separate theming change.
- D6. The unused top-level `progress` event (`shared/jobs.ts` ~668). Options: (a) leave it;
  (b) remove it in slice 1. Default (a): it is out of scope, and three
  `generationJobs.test.ts` cases use it as a generic event.

## Not In This Plan

- A stage in `GenerationStatus`: no reader needs it (the snapshot restores the stage).
- Per-speaker or per-round progress text, or a progress bar.
- Stage reporting for the detached memory tasks or for the tab's own requests (suggestions,
  translation, plugin requests).
- Moving the legacy `progress` overlay or `alertWait` per chat (`chat-pipeline.md` Known
  Hazards).

## Open Questions

- Should `finishing` start where the stream ends (the tail, today's `state.stage = "tail"`),
  or where the old stage 4 timing starts (`stage4Start`, after the output trigger, inlays,
  and listeners)? The plan uses the tail, so the output trigger and inlay images show as
  finishing. Raise it if the old timing reads better.
