# Chat Generation Spinner: Cause Analysis and Recovery Options

Date: 2026-10-23 (Asia/Seoul)  
Repository: `/home/codex/risuai-metatron`  
Inspected revision: `79ae26cc4`  
Scope: completed source and Git history investigation, with proposed fixes. No application changes have been implemented.

## Finding

The send/stop button's rotating circle no longer changes color because its processing-stage class is hardcoded to stage 0. The connection to the old reactive stage store was removed when browser-side generation was replaced with server jobs.

This is a regression in the progress indicator. The confirmed cause is the removed stage binding; changing theme colors or restoring CSS alone would not restore stage tracking.

## Evidence

### The spinner always receives the same stage class

In [DefaultChatScreen.svelte:1047](../../src/lib/ChatScreens/DefaultChatScreen.svelte:1047), the current markup is:

```svelte
<div class="loadmove chat-process-stage-0" class:autoload={autoMode}></div>
```

The spinner appears while the selected chat has stoppable work. Its visibility follows the send/job lifecycle, but its class does not follow the processing stage.

The source still contains these color rules at [DefaultChatScreen.svelte:1544](../../src/lib/ChatScreens/DefaultChatScreen.svelte:1544):

| Stage | Existing color             | Historical role                       |
| ----- | -------------------------- | ------------------------------------- |
| 0     | Default theme border color | Initial preparation                   |
| 1     | Blue, `#60a5fa`            | Prompt preparation                    |
| 2     | Pink, `#db2777`            | Memory processing, when applicable    |
| 3     | Mint green, `#34d399`      | Model request and response generation |
| 4     | Purple, `#8b5cf6`          | Final processing after generation     |

The historical roles above come from the stage assignments in `src/ts/process/index.svelte.ts` immediately before the removal commit. They describe the old browser pipeline, rather than an existing server progress contract.

No stage-0 override exists in this component. Consequently, the circle uses the base `.loadmove` border color, `var(--risu-theme-borderc)`, from [styles.css:429](../../src/styles.css:429).

Automatic group mode is an existing exception: `.autoload` overrides the circle with green at [DefaultChatScreen.svelte:1564](../../src/lib/ChatScreens/DefaultChatScreen.svelte:1564).

### Git history identifies the change

Commit `12ed3baecda964408562952d914cc91154722d6b`, dated 2026-10-03, is titled:

> feat(cutover): remove the browser generation path, its Lua and trigger runtimes, and the server flags

It removed the `chatProcessStage` import and changed the spinner markup as follows:

```diff
- <div class="loadmove chat-process-stage-{$chatProcessStage}" class:autoload={autoMode}></div>
+ <div class="loadmove chat-process-stage-0" class:autoload={autoMode}></div>
```

Before this change, the browser pipeline updated a writable `chatProcessStage` store as processing advanced. The server cutover removed that pipeline and its stage updates without adding an equivalent connection for this indicator.

The evidence can be reproduced from the repository with:

```bash
git blame -L 1040,1048 -- src/lib/ChatScreens/DefaultChatScreen.svelte
git show 12ed3baecd -- src/lib/ChatScreens/DefaultChatScreen.svelte
git show '12ed3baecd^:src/ts/process/index.svelte.ts' | rg -n -C 4 chatProcessStage
```

### Existing server progress is not an equivalent replacement

The current server/client contract has no dedicated live state for the old general generation stages:

- [shared/jobs.ts:291](../../shared/jobs.ts:291) defines the job notices. `progress` supports the legacy memory overlay, and `memoryProgress` describes HypaV3 memory runs.
- [jobChannel.ts:324](../../src/ts/network/jobChannel.ts:324) routes those notices into `hypaV3ProgressStore` and the job-associated memory progress state. It does not update the send spinner's stage.
- [shared/jobs.ts:646](../../shared/jobs.ts:646) includes a generic `progress` event with an unknown payload, but it does not define an authoritative generation-stage payload or connect one to this spinner.
- [shared/jobs.ts:658](../../shared/jobs.ts:658) defines `GenerationStatus` with running/ended state and reply identifiers, without a current processing stage.
- [generationJobs.ts:1251](../../server/src/jobs/generationJobs.ts:1251) rebuilds the attachment snapshot from chat/resource state, the chosen preset, the current reply, and terminal information. It does not replay a general processing stage.

The server does track failure locations internally. However, `GenerationErrorStage` and the terminal error's optional `stage` field are diagnostic data, as documented at [shared/jobs.ts:137](../../shared/jobs.ts:137) and [shared/jobs.ts:263](../../shared/jobs.ts:263). They are not live progress notifications and do not distinguish the old memory stage from general assembly.

## Recommended Fix: Server-Reported Stages

Restore the complete path from actual server work to the selected chat's indicator:

```text
Server pipeline transition
  -> typed job stage event and retained current stage
  -> client state indexed by job ID and chat
  -> selected chat's stage
  -> spinner color class
```

### Define a small presentation-stage contract

A proposed mapping that preserves the original visual meaning is:

| Proposed stage             | UI class               | Meaning                                                |
| -------------------------- | ---------------------- | ------------------------------------------------------ |
| Unknown / not yet reported | `chat-process-stage-0` | Job creation, initial attachment, or unavailable stage |
| `preparing`                | `chat-process-stage-1` | Input handling and prompt assembly outside memory work |
| `memory`                   | `chat-process-stage-2` | Memory work performed as part of this generation job   |
| `generating`               | `chat-process-stage-3` | Main model request, including streaming                |
| `finishing`                | `chat-process-stage-4` | Remaining processing and final writes                  |

These names are a proposal, not existing API values. Define a typed event in `shared/jobs.ts` and keep the presentation stages separate from the failure-stage enum. Emit updates only when a stage changes, rather than on every streamed chunk.

### Report transitions where the work actually occurs

Instrument the generation runner in `server/src/prompt/runner.ts` and the relevant assembly boundaries in `server/src/prompt/assemble.ts`:

1. Report preparation when the job starts its input/prompt work.
2. Enter memory immediately before the job's memory operation, and return to preparation when assembly continues.
3. Enter generation before the main model request and keep it through response streaming.
4. Enter finishing when the main generation work ends and remaining processing begins.
5. Let the existing terminal lifecycle end the indicator.

Inspect the actual boundaries before implementation. Current diagnostic `state.stage` assignments do not reproduce all four historical visual stages, and some output processing already happens within the request/streaming flow.

Do not let unrelated background memory tasks change the send spinner. Preserve the separate HypaV3 overlay and memory-task indicators.

### Retain the stage for late attachment and reconnection

Keep the latest stage on the in-memory server job. Include it in the running job's attachment snapshot; expose it in `GenerationStatus` as well if status discovery seeds the client state.

A notification sent only once at a transition is insufficient: the browser can attach after that transition or reconnect during a long model request. A snapshot must restore the current stage without waiting for another transition. Terminal jobs must not restore a running spinner.

This is transient job metadata. It does not require a persisted chat field or a database migration.

### Store and render progress per job and chat

Process the typed event in `src/ts/network/generationJobs.ts`. Maintain reactive progress keyed by job ID, associated with its chat and server epoch, and derive the selected chat's displayed stage.

The application supports simultaneous sends in different chats. A single global replacement for `chatProcessStage` would allow one chat's progress to recolor another chat's spinner.

Integrate cleanup with the existing follow lifecycle in `src/ts/process/serverCommands.ts`. Remove only the ending job's progress entry on completion, failure, lost follow, or disposal. Ignore updates from superseded connections or epochs. An older job's late cleanup must not clear a newer job's state for the same chat.

Finally, replace the fixed class in `DefaultChatScreen.svelte` with the derived stage class, retaining stage 0 as the fallback. Handle local job creation before the server job is known. Make an explicit choice for command and preview jobs that do not traverse all generation stages; fallback coloring is acceptable for unreported stages.

Preserve the existing auto-mode green override unless changing that behavior is explicitly included in the implementation scope. Use the project's theme tokens for any new or revised color styling.

## Alternative: Limited Client-Side Approximation

A smaller change could derive a coarse color from existing lifecycle events: preparation while creating/following the job, generation after a reply or stream is observed, and completion at the terminal event.

This approach cannot reliably identify prompt assembly, memory processing, the model wait before its first output, or final server processing. It would provide approximate lifecycle feedback and would not fully restore the original stage behavior. It is suitable only if that reduced fidelity is an accepted requirement.

Changing the fixed stage number or animating colors on a timer would be cosmetic and would not indicate actual processing stages.

## Validation for a Future Implementation

Add focused regression coverage that verifies observable behavior:

- A controlled server run reports preparation, optional memory, generation, and finishing at their real boundaries. A send without memory skips that stage.
- Late attachment and reconnection recover the current stage, including attachment during memory or a model request.
- Two chats can report different stages simultaneously; switching chats shows the appropriate color.
- An old job's terminal event or cleanup cannot erase a newer job's progress for the same chat.
- Completion, abort, failure, lost follow, and epoch replacement remove the relevant progress state.
- The actual spinner element receives the expected stage class. Auto mode follows the chosen override rule, and a job without reported progress uses the fallback.

Use deferred operations or explicit synchronization to hold stages during tests; avoid timing-based sleeps. Show a new regression test failing with its guarded behavior broken before accepting it.

For implementation changes, follow the repository gates:

```bash
pnpm exec prettier --write <changed-files>
pnpm check
pnpm --silent test:agent
```

Run affected slow tests and browser coverage as required by `STRUCTURE.md`, including `pnpm --silent test:agent --e2e` for the covered UI change. Update the owning structure guides when the job event or lifecycle contract changes.

## Investigation Limits

The cause was confirmed through current source inspection, `git blame`, and the removal commit's diff. No browser reproduction, runtime tests, or application modifications were performed for this report. The recovery design is a proposal and requires implementation and validation.
