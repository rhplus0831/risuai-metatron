# Generation Progress Window Plan

Status: drafted 2026-11-14 at `d2d1a76a7` from the owner's request. D1 is the owner's request; the owner accepted D2
to D5 the same day, as recommended. D6 to D24 are this plan's own, found against the code. Not audited yet.

Sources: the owner's request (2026-11-14: a send shows only a circle, and a send running on another client shows no
progress on the circle; a floating window at the top right with the seconds elapsed and, while streaming, the tokens
generated and the speed; Half Streaming as built in the owner's other fork); `Job`, `JobEventInput`, `RunningJob.emit`,
`current`, `handoffSnapshot`, `streamingSnapshot`, and the `publishHandoff` option in
`server/src/jobs/generationJobs.ts`; `reportStage`, `runPromptSend`, `readReply`, `CHECKPOINT_INTERVAL_MS`, `finalize`,
and `coverSeq` in `server/src/prompt/runner.ts`; the streaming gate (`forceStreaming`) in `server/src/llm/request.ts`
and `server/src/llm/outer.ts`; `createTokenCounter` in `server/src/prompt/tokens.ts`; `ChangeFeedEvent` in
`server/src/data/changeFeed.ts`; `createEventSockets` and `frameOf` in `server/src/routes/events.ts`; the feed wiring in
`server/src/app.ts`; `EventFeedFrame`, `HandoffOffer`, and `MemoryTaskEntry` in `shared/events.ts`; `GenerationStage`,
`GenerationKind`, `GenerationCurrent`, and `GenerationEvent` in `shared/jobs.ts`; `receive` in
`src/ts/network/eventFeed.ts`; `noteMemoryTaskFrame` in `src/ts/process/memoryTasks.svelte.ts`; `foreignJobs`,
`foreignJobChatKeys`, and `watchChatVisibility` in `src/ts/process/chatStatus.svelte.ts`; `jobStages.ts`;
`applyServerGeneration` and the watermark maps in `src/ts/storage/chatStore.svelte.ts`; the Stop buttons in
`src/lib/ChatScreens/DefaultChatScreen.svelte`; `HypaV3Progress.svelte`, `HandoffStatus.svelte`, and their mounts in
`src/App.svelte`; `ModelSettings.svelte`; `interactionSettingsData.ts`, read at `d2d1a76a7`; the
[server generation](../structure/server-generation.md), [live-update feed](../structure/live-update-feed.md),
[live updates](../structure/live-updates.md), and [network and jobs](../structure/network-jobs.md) guides. The
identifiers are the anchors. Re-verify each cited location before editing (STRUCTURE.md protocol step 5).

## Goal

Every tab shows what the server is generating, for how long, and how fast.

- **The window.** A small non-modal window at the top right lists every generation job running on the server: the
  character and chat, the stage, the seconds elapsed, and, while the provider streams, the tokens generated so far and
  the tokens per second. The selected chat's job is first. A row opens its chat.
- **Every client.** A job another tab or device started appears the same way, from its admission to its end. The
  chat's Stop-other spinner appears with the job and takes the stage color the owner's spinner has.
- **Half Streaming.** A setting for users who keep Response Streaming off: the provider is asked to stream, the reply
  text stays hidden until it is complete, and the window shows the token count and the speed meanwhile.
- **Everything else is as today.** The job socket, who may attach to it, the reply text another client sees (the
  3-second checkpoints), and the composer's Stop button do not change.

Not goals: live reply text on another client (D3); a per-profile Half Streaming switch (D4); exact token counts or
stored final statistics (D5); stopping a job from the window (D17).

## Current State

- **The circle.** `DefaultChatScreen.svelte` renders a `.loadmove` ring inside the Stop button while `stoppable` (this
  screen has a send controller for the chat, or follows its job). Its class `chat-process-stage-<stage>` colors it from
  `jobStages`, which `applyGenerationEvent` fills from the job socket's `stage` events. A second button
  (`foreignStoppable`) holds a plain `.loadmove` with no stage class.
- **Stages.** `GENERATION_STAGES` is `preparing`, `memory`, `generating`, `finishing`. `reportStage` emits them; the
  registry keeps `job.stage`, sends a changed stage to the job's sockets, and replays it on attach. `generating` covers
  both the wait for the first text and the stream.
- **Another client.** A tab that did not create a job cannot attach to its socket (creator, owner, or a handoff ticket
  only). It learns of the job for the visible chat through `GET /api/generations/current` (`watchChatVisibility`: on
  show, on a feed lock list naming the chat, and every 15 s while a mark has no lock), which marks `foreignJobs` with
  the job id only. The feed tells it the chat's locks with each job write; a job's admission publishes nothing. The
  reply text reaches it as raw checkpoints, `CHECKPOINT_INTERVAL_MS` (3 s) apart.
- **Time and tokens.** `Job.startedAt` exists on the server and is sent nowhere while the job runs. No output token
  count, first-text time, or speed exists in any type. Request history holds byte counts and `firstByteAt`; the reply's
  `generationInfo.stageTiming` is written at the end.
- **The stream on the server.** `runPromptSend` always passes `useStreaming: true`; `server/src/llm/request.ts` turns
  it into `arg.forceStreaming ? true : db.useStreaming && arg.useStreaming`. For a `streaming` answer the runner
  appends the empty reply with its `begin` lock, emits `accepted`, and calls `readReply`: each read's first value
  (trimmed by `removeIncompleteResponse`) becomes a `chunk`, and a timer writes a raw checkpoint (`raw: true`). After
  the stream `coverSeq = stream.seq` and the tail runs. An abort or a read failure writes the text so far
  (`finalize(stream.text, stream.seq)`). A buffered answer takes the other branch: no reply row exists until the reply
  is written, and an abort leaves no text.
- **Chunks are snapshots.** A provider stream yields cumulative text, and the request layer keeps at most one pending
  snapshot, so a slow reader sees fewer, larger steps.
- **Token counting.** `createTokenCounter`'s `encode` picks the tokenizer for a scope, caches by text when
  `useTokenizerCaching` is on, and calls Google's count endpoint for a `googleCloud` choice (falling back to
  `gemmaSentencePiece`).
- **The feed's process-local frames.** `memoryTask` and `handoff` frames describe process-local transitions, each with
  a `hello` snapshot that replaces the tab's whole set (`memoryTasks`, `handoffs`). The registry publishes offers
  through its `publishHandoff` option and answers `handoffSnapshot()`; `server/src/app.ts` wires both. A tab's `receive`
  ignores a frame type it does not know.
- **The top right.** `HypaV3Progress.svelte` is `fixed top-4 right-4 z-40`, shown for the selected chat's memory run.
  `HandoffStatus.svelte` is at the bottom right.
- **The settings' neighbors.** `useStreaming` is a boolean of the `providers` section (`shared/database.ts`,
  `shared/sections.ts`, `server/src/data/normalize/providers.ts`), bound in `ModelSettings.svelte` and
  `ModelProfileEditor.svelte`. `contextMeterLookahead` and `loreBudgetStop` are the nearest boolean `ui` settings on
  the Interaction page.

## Rules For Every Slice

One slice is one session and one commit. Workflow per slice: `opus-workflow` for the _hard_ slices (1, 2, and 4 change
`shared/` contracts or the job's reply path), `opus-lite` for the _small_ one (3).

- **Checks.** The slice's tests (under "Test"), then `pnpm check`, the focused files through the wrapper while
  iterating, `pnpm --silent test:agent` once whole after the last source edit, `pnpm format:check`, `pnpm check:docs`
  for a guide edit, and `pnpm check:tests` for an added test file. Run `pnpm check` again after the last test edit. V4
  (`rg` each changed export and wire field) and V6 (each new test shown failing once with its guarded line broken).
- **Names.** Final once slice 1 lands: the frame type `generation`, `hello.generations`, and the entry's field names.
  Final once slice 2 lands: the entry's `output`. Final once slice 3 lands: the setting `generationProgressWindow`.
  Final once slice 4 lands: the setting `halfStreaming`. Type, function, and file names marked "suggested" are the
  slice's to choose.
- **Content-free.** The new frame and snapshot carry ids, times, a stage, and counts. They never carry reply text,
  prompt text, a character or chat name, or a model id (D7).
- **Never the job's failure.** Publishing progress and counting tokens cannot fail, delay, or reorder a job: a throw in
  either is logged and dropped, and no reply write waits for a count (D11).
- **One reader each.** The server never reads `generationProgressWindow`. Only the runner reads `halfStreaming`,
  beside its read of `useStreaming`.
- **A tab or server from before a slice.** An older tab ignores the `generation` frame and `hello.generations`. A tab
  on an older server gets neither and shows no window; the Stop-other spinner works as today. A server without slice 2
  sends entries with no `output`. A server without slice 4 ignores `halfStreaming`.
- **Strings.** New text goes in `src/lang/en.ts` with its Korean in `src/lang/ko.ts` in the same slice.
- **Guide.** Each slice names its guides; their `Invariants` apply, and the slice updates the sections and module
  comments that name a changed contract (`EventFeedFrame`'s comment, `ChangeFeedEvent`'s, `JobEventInput`'s,
  `RunningJob.emit`'s, `readReply`'s, and `runPromptJob`'s sequence). Comments and test titles describe behavior, not
  this plan (STRUCTURE.md T5).
- **Manual checks.** Each slice lists the checks it cannot run. The slice report gives them to the owner as a
  checklist; what is still unrun when the plan closes moves to [manual checks](../backlog/manual-checks.md) under this
  plan's name.

## Order

Serial: 1 → 2 → 3 → 4. Slice 2 fills a field of slice 1's entry. Slice 3 reads the entry and the field. Slice 4 uses
slice 2's meter, and slices 2 and 4 both edit `readReply` and its caller.

If the run stops after slice 1 or 2, nothing a user can reach changes: the server publishes frames no tab reads. After
slice 3 the window works for every send, with token counts only while Response Streaming is on.

## Slice 1. Job progress on the feed (_hard_, `server-generation.md`, `live-update-feed.md`)

**Change.**

- `shared/events.ts`:
  - A running job's entry (suggested: `GenerationProgressEntry`): `jobId`, `characterId`, `chatId`, `kind`
    (`GenerationKind`), `clientId` (the job's creating client, the one `GenerationCurrent.owned` compares),
    `startedAt` and `at` (server clock, ms: the job's admission and this entry's sampling), and optional `stage`,
    `retry`, and `sequence` (`total`, `sent`), each as the registry holds it.
  - `EventFeedFrame` gains `{ type: "generation"; epoch }` with either `state: "running"` and the entry's fields, or
    `state: "ended"` and `jobId`, `characterId`, `chatId` only.
  - `hello` gains optional `generations`, the running entries, sampled with the other snapshots. It replaces the tab's
    whole set.
- `server/src/data/changeFeed.ts`: `ChangeFeedEvent` gains the same `generation` variant.
  `server/src/routes/events.ts`: `frameOf` maps it, `createEventSockets` takes a `generations` sampler like `handoffs`,
  and the frame goes through `send` so frame admission measures it.
- `server/src/jobs/generationJobs.ts`:
  - An option beside `publishHandoff` (suggested: `publishGeneration`) and a snapshot beside `handoffSnapshot`
    (suggested: `generationSnapshot`), wired in `server/src/app.ts` the same way.
  - The registry publishes a `running` entry when a job is admitted (the step that sets `startedAt`), when `job.stage`,
    `job.retry`, or `job.sequence` changes (where it sends the job socket's `stage`, `retry`, and `sequence` events),
    and an `ended` entry where it sets `job.endedAt`.
  - Every kind is published, a preview included (D13). A job of another epoch is never in a snapshot: an epoch change
    clears the registry's memory.
  - A publication that throws is caught and logged (`logEvent`), and the job goes on.
- No file under `src/` changes beyond what the type check needs.

**Test.**

- `server/src/tests/generationJobs.test.ts`: an admitted job publishes `running` with its ids, `kind`, `clientId`, and
  `startedAt` from the registry's clock; a stage report publishes the stage once (a repeated stage publishes nothing);
  a retry report and the stage after it publish the count and then no count; a sequence part publishes `sent`; the
  terminal publishes `ended`; the snapshot lists a running job and not an ended one; a throwing publisher leaves the job
  running and its terminal unchanged.
- `server/src/tests/events.test.ts`: the `hello` carries `generations` from the sampler, a published event reaches a
  socket as the `generation` frame, and a frame too large for a socket's budget closes it like any other.

**Guide.** `live-update-feed.md`: Files (the frame list), Live-update hello (the snapshot), and Invariants (a third
process-local frame). `server-generation.md`: Generation channels (what the registry publishes and when) and Process
memory.

**Manual checks.** None: nothing a user can reach changes.

## Slice 2. The output count (_hard_, `server-generation.md`, `llm-requests.md`)

**Change.**

- `shared/events.ts`: the entry gains optional `output`: `tokens` (the count so far), `since` (server clock of the
  first counted text), and `at` (server clock of this count). It describes the reply being generated now.
- `server/src/prompt/tokens.ts`: the counter gains a local count (suggested: `countLocal(text, scope)`): the same
  tokenizer choice as `encode`, except that a `googleCloud` choice uses `gemmaSentencePiece`, and it never reads or
  writes the encode cache (D10).
- A meter beside the runner (suggested: `createOutputMeter` in `outputMeter.ts` under `server/src/prompt/`):
  - `note(raw)` keeps the newest raw text. A count starts when none is in flight and `OUTPUT_COUNT_INTERVAL_MS` (500)
    has passed since the last one started.
  - A count takes the text the last count did not cover when the newest text starts with the counted text, and the
    whole text otherwise (a provider that rewrote its answer). It adds to, or replaces, the total and reports
    `{ tokens, since, at }`.
  - `stop()` ends it; a count still in flight reports nothing after it. A failed count is logged once per meter and
    the meter stops counting.
- `readReply` gains an option (suggested: `onRaw`) called with each read's first value before
  `removeIncompleteResponse` trims it, because the trimmed text can shrink (D10). The streaming branch of
  `runPromptSend` creates one meter per stream with the reply request's token scope (`tokenScopeFor`), passes
  `onRaw: meter.note`, and stops it when `readReply` returns.
- `JobEventInput` gains a registry-only report (suggested: `{ type: "output"; tokens; since; at }`), like
  `{ type: "retry" }`: it is not a `GenerationEvent` and no job socket receives it. The registry keeps it as
  `job.output` and clears it on the next `accepted`.
- Publication of an `output` report is throttled per job (suggested: `GENERATION_PROGRESS_INTERVAL_MS`, 1000): at once
  when that long has passed since the job's last `running` publication, otherwise once on a timer for the newest
  report. A stage, retry, or sequence publication carries the newest `output` and cancels the timer. The timer is
  cleared when the job ends (D9).
- A buffered answer has no meter and no `output`.

**Test.**

- `server/src/tests/tokens.test.ts`: `countLocal` for a `googleCloud` scope makes no fetch and fills no cache; for a
  family scope it equals `count`.
- A unit test of the meter with a fake clock and counter: two notes inside the interval make one count; a text that
  extends the counted one counts only the new part; a text that does not extend it replaces the total; a count that
  throws stops the meter and never rejects; nothing is reported after `stop()`.
- `server/src/tests/promptRunner.test.ts`: a streamed reply reports `output` with a growing count, the raw text is
  what is counted when `removeIncompleteResponse` trims the chunk, and a buffered reply reports none.
- `server/src/tests/generationJobs.test.ts`: reports inside the interval publish once with the newest count; a stage
  change publishes at once with the newest count; an `accepted` clears `output`; no publication follows the terminal.

**Guide.** `server-generation.md`: Prompt job execution (the meter and its report) and Generation channels (the
throttle). `llm-requests.md`: Tokenizer selection and server counting, for the local count.

**Manual checks.** None: nothing a user can reach changes.

## Slice 3. The window and the Stop-other spinner (_small_, `live-updates.md`, `ui-theming.md`, `settings-i18n.md`, `persistence.md`)

**Change.**

- A store module beside `memoryTasks.svelte.ts` (suggested: `generationProgress.svelte.ts`):
  - The running entries by `jobId`, validated field by field as `noteMemoryTaskFrame` validates its frame; a malformed
    frame is dropped.
  - The server clock offset, from the newest frame's `at` against the tab's clock (D8).
  - Per job, the `output` samples of the last 5 s by their own `at`.
  - Two pure exported functions: the elapsed time of an entry, and the tokens per second of a sample list (the first to
    the last sample of the window; with one sample, the count over the time since `output.since`).
- `src/ts/network/eventFeed.ts` `receive`: a `hello` of the loaded epoch replaces the set with `generations` (absent:
  empty); a `generation` frame of the loaded epoch upserts or removes one job; an epoch mismatch and a closed socket
  clear the set, so a stale job never keeps counting (D12).
- The window (suggested: `GenerationProgressWindow.svelte` under `src/lib/Others/`), mounted in `src/App.svelte`:
  - Shown while the setting is on and at least one entry is listed. `preview` and `previewPrompt` jobs are not listed
    (D13).
  - One row per job, the selected chat's first, then by `startedAt`: the character and chat names from the tab's own
    data (a generic label when the tab does not hold them), the stage's label, the elapsed time ticking once a second,
    the retry count and `sent/total` when present, a mark with the client's name from `connectedClients` when
    `clientId` is not this tab's, and, with `output`, the count with "≈" and the tokens per second.
  - A row opens its chat through the navigation the sidebar's chat rows use. The window has no Stop button (D17).
  - It can be collapsed to a pill (the job count and the first row's elapsed time). It starts collapsed on a
    phone-width screen. The collapsed state lives in the tab's memory only.
  - It is non-modal and takes pointer events only on itself.
- The top right: the window and `HypaV3Progress` never overlap (D16). Suggested: one fixed top-right column in
  `src/App.svelte` that holds both, with `HypaV3Progress` giving up its own `fixed top-4 right-4`.
- `DefaultChatScreen.svelte`: `foreignStoppable` is also true while the store lists a running job for the chat whose
  `clientId` is not this tab's, and the Stop-other ring takes `chat-process-stage-<stage>` from that entry. The
  button's handler is unchanged: it reads the chat's slot again and confirms before stopping. `foreignJobs`, its
  discovery, and `isChatBusy` do not change (D18).
- The setting `generationProgressWindow: boolean` in the `ui` section, default true, following `loreBudgetStop` through
  its files: `shared/database.ts`, `shared/sections.ts`, `server/src/data/normalize/ui.ts`, an item in
  `interactionSettingsData.ts`, the strings, the boot snapshot fixture, and `METATRON_ONLY_SETTINGS` in
  `server/src/data/upstream/exportDatabase.ts`. Suggested English: label "Show the generation progress window"; help
  "A small window at the top right lists every reply being generated on the server, with its stage, the time elapsed,
  and, while the model streams, the tokens generated and the speed."

**Test.**

- A unit test of the store: a `hello` replaces the set; a `running` frame upserts and an `ended` frame removes; a
  frame of another epoch and a malformed frame change nothing; a closed socket clears the set; the elapsed time uses
  the server offset; the speed of a sample window, of one sample, and of none.
- `src/ts/network/eventFeed.test.ts`: the three `receive` paths reach the store.
- A component test of the window: hidden with no entry and with the setting off; a preview is not listed; the selected
  chat's row is first; a row without `output` shows no count; the "≈" count and speed with `output`; another client's
  mark; a row click selects its chat; the collapsed pill.
- A `DefaultChatScreen` test beside `DefaultChatScreen.drafts.test.ts`, or `src/ts/process/chatStatus.test.ts` if the
  rule moves into `chatStatus.svelte.ts`: a listed job of another client shows the
  button with the stage class; this tab's own job does not; the entry's removal hides it.
- `server/src/tests/normalizeSections.test.ts`, `src/ts/setting/settingsPageSections.test.ts`, and
  `server/src/tests/upstreamExport.test.ts`: the setting's default, its checkbox, and its absence from the export.

**Guide.** `live-updates.md`: Feed connection (the frame, the snapshot, and the clear on close). `ui-theming.md`: the
window, its place beside `HypaV3Progress`, and the Stop-other spinner's stage color. `persistence.md` and
`settings-i18n.md`: the setting, where they list its neighbors.

**Manual checks.**

- A send with Response Streaming on: the window appears at once, the seconds tick, the stage label follows the ring's
  color, and the count and speed appear with the first text and look plausible against the reply's length.
- A send with Response Streaming off: the window shows the stage and the seconds, with no count.
- A second browser or device on the same server: the window lists the first one's job from its start, with that
  client's name; opening the chat shows the Stop-other spinner in the stage color; the row disappears at the end.
- Two chats generating at once: two rows, the selected chat's first; a row click opens its chat.
- A memory run on the selected chat while a reply generates: the two indicators do not overlap.
- A reload mid-reply: the window comes back with the right elapsed time.
- A phone-width screen: the pill, expanding it, and that it does not cover the chat's header buttons.
- The setting off hides the window; English and Korean.

## Slice 4. Half Streaming (_hard_, `server-generation.md`, `llm-requests.md`, `settings-i18n.md`, `persistence.md`)

**Change.**

- The setting `halfStreaming: boolean` in the `providers` section, default false, following `useStreaming` through its
  files, with the strings and `METATRON_ONLY_SETTINGS`. Its checkbox sits under Response Streaming wherever that is
  bound (`ModelSettings.svelte`, `ModelProfileEditor.svelte`) and is shown only while Response Streaming is off (D19).
  Suggested English: label "Half Streaming"; help "With Response Streaming off, still ask the model to stream so the
  progress window can show the tokens generated and the speed. The reply appears when it is complete."
- `runPromptSend`: a send is quiet when `db.useStreaming` is off, `db.halfStreaming` is on, and the job is not a
  `previewPrompt`. A quiet send passes `forceStreaming: true` with the reply request. No other request of the job
  changes (D22).
- The streaming branch for a quiet send:
  - The reply row, its `begin` lock, and `accepted` (empty text) are as for any stream.
  - `readReply` gains an option (suggested: `quiet`): it calls neither `emitChunk` nor `checkpoint` and reports
    sequence 0, so no `chunk` event, no raw checkpoint, and no chunk sequence a tab was never sent (D21). `onRaw` and
    the meter run as in slice 2.
  - The tail is the stream's own: `writeReplyText(stream.text)` and what follows. An abort or a read failure writes
    the text so far, as for any stream (D23).
- When the request answers buffered although the send is quiet (the cases under D22), the buffered branch runs as
  today.

**Test.**

- `server/src/tests/promptRunner.test.ts`:
  - A quiet send: the request carries `forceStreaming`; `accepted` is emitted with empty text; no `chunk` event and no
    checkpoint write happen during the stream; `output` reports arrive; the final write holds the whole reply and
    `done` names it.
  - A quiet send aborted mid-stream stores the text so far.
  - Response Streaming on with `halfStreaming` on is an ordinary stream (chunks and checkpoints).
  - Both off: no `forceStreaming`, the buffered branch.
  - A `previewPrompt` job never sets `forceStreaming`.
- `src/ts/storage/tests/chatStore.test.ts`, beside the `applyServerGeneration` cases: a tab holding an `accepted` with empty
  text and sequence 0 shows the stored reply once the job's final chat event arrives, with no resync request.
- `server/src/tests/normalizeSections.test.ts`, `src/ts/setting/settingsPageSections.test.ts`, and
  `server/src/tests/upstreamExport.test.ts`: the default, the checkbox and its condition, and the export.

**Guide.** `server-generation.md`: Prompt job execution (the quiet stream) and Limitations (a restart during a quiet
stream, D23). `llm-requests.md`: Server request layer (the streaming decision) and Settings pages. `persistence.md` and `settings-i18n.md`: the setting.

**Manual checks.**

- Response Streaming off, Half Streaming on: the reply bubble appears empty with its generating state, the window
  counts tokens and shows a speed, and the whole reply appears at the end, processed as a streamed reply is (display
  scripts, inlays).
- Stop mid-reply keeps the text generated so far.
- A second device shows no partial text during the reply and the whole reply at the end.
- A model with tools enabled, an image-output model, and a character with output escaping: the send completes, with
  no count when the provider answered buffered.
- A plugin provider and a WebLLM model with Half Streaming on.
- The checkbox disappears when Response Streaming is turned on; English and Korean.

## Decisions

D1 is the owner's request of 2026-11-14. The owner accepted D2 to D5 the same day. The rest are this plan's.

- D1. A floating window at the top right shows how many seconds a send has run and, while the model streams, the
  tokens generated and the speed. A send another client started shows its progress too. Half Streaming provides the
  token count for users who keep streaming off.
- D2. The window lists every job running on the server, not only the selected chat's. The selected chat's row is
  first, and a row opens its chat.
- D3. Another client gets statistics, not text. Its reply text stays the 3-second checkpoints. Token-by-token text on
  a client that did not start the job needs a read-only attach to the job socket, which is a separate piece of work.
- D4. Half Streaming is one global setting. Response Streaming is global too, so a per-profile switch would have no
  neighbor to follow.
- D5. Token counts are approximate and shown with "≈". No final statistics are stored on the reply.
- D6. Progress travels on the live-update feed, for the owner and for everyone else. Every tab holds that socket, it
  already carries two process-local frames with `hello` snapshots, and the job socket's access rule stays as it is. The
  owner's ring keeps reading the job socket's `stage`.
- D7. The frame is content-free, like a handoff offer. Every authenticated socket receives it, so it names no text, no
  title, and no model.
- D8. Times are the server's. Each entry carries `at`, the tab derives one clock offset from it, and the speed is
  computed from the samples' own `at`. The owner's other fork computed speed from arrival times in the browser and
  needed follow-up fixes for gateway buffering and smoothing.
- D9. A job publishes at once for admission, a stage, a retry, a sequence part, and its end, and at most once a second
  for output counts. A frame is a few hundred bytes to every socket; one second is the window's own tick.
- D10. The count is the local tokenizer's, on the part of the raw text the last count did not cover, without the
  encode cache and without a remote endpoint. A cumulative count would tokenize the whole reply at every step; the
  cache would fill with fragments nothing reads again; Google's endpoint would add a request per step. The raw text is
  counted because the text trimmed by `removeIncompleteResponse` is not monotonic. Counting fragments misjudges a token
  that spans two of them, which D5 allows.
- D11. Progress is telemetry. A failed publication or count is logged and dropped, and no reply write waits for a
  count, so the final count of a reply may be missing from the last frame before the job ends.
- D12. A tab clears its set when the feed socket closes and takes the next `hello`'s snapshot. A missed `ended` frame
  therefore cannot leave a row counting.
- D13. The registry publishes every kind and the window hides previews. What to show is the window's decision, and a
  preview's entry costs two frames.
- D14. An entry names the creating client (`clientId`), the one `GenerationCurrent.owned` compares. After a handoff
  the tab that took the job over follows it, and its own Stop button outranks the Stop-other one.
- D15. `output` describes the reply being generated now. A new `accepted` (a group's next speaker, an auto-continue)
  starts from none.
- D16. The window and the memory progress pill share the top right and must not overlap. One container that holds
  both is suggested; the slice may choose another layout that keeps the rule.
- D17. The window shows and navigates; it does not stop a job. Stopping another client's job already asks for
  confirmation on the chat screen, and a list of Stop buttons over every chat invites a wrong click.
- D18. The Stop-other button reads the store beside `foreignJobs`; the marks and their discovery stay. A mark is
  advisory and a store entry is too: neither makes `isChatBusy` true, and the server still refuses a competing send
  with `chatBusy`.
- D19. Half Streaming applies only while Response Streaming is off, and its checkbox is shown only then. With
  streaming on there is nothing for it to add.
- D20. A quiet send runs the stream's own path, not the buffered one with a side channel. The stream path already
  appends the reply, holds its lock, keeps the text so far on a stop, and runs `editoutput` once on the completed text.
- D21. A quiet stream reports sequence 0 and writes no raw checkpoint. Only a raw checkpoint can become a `streamed`
  row reference, which a tab rebuilds from chunks it holds; and a claimed sequence above 0 would tell a tab its stored
  text includes chunks it was never sent. This was read in `generationJobs.ts` and `chatStore.svelte.ts`, not run:
  slice 4's chat-store test is the proof.
- D22. Only the reply request of `runPromptSend` is forced to stream. Auxiliary requests keep passing
  `useStreaming: false`. Where the request layer or an adapter answers buffered anyway (`escape`, which clears
  `forceStreaming` in `server/src/llm/outer.ts`; an adapter that overrides streaming, such as a Claude request with
  tools or Gemini audio or image output), the send completes on the buffered branch with no count.
- D23. A stop during a quiet stream keeps the text so far, as a stream does. A server restart during one leaves the
  empty reply row and loses the text: without checkpoints nothing was stored. A checkpoint would show the hidden text
  on every client through the feed, which is what the setting turns off.
- D24. The window's setting is in the `ui` section and on the Interaction page, because only the tab reads it. Half
  Streaming is in `providers` beside `useStreaming`, because the server's runner reads it.

## Not In This Plan

- Live reply text on a client that did not start the job (D3).
- A per-profile or per-preset Half Streaming switch (D4).
- Final statistics on the reply (total time, tokens, average speed), provider-reported usage, and exact counts (D5).
- A "waiting for the first token" label. `generating` covers the wait and the stream; `output.since` would allow it
  later.
- The sidebar's generating badge from the feed entry. It still appears with the chat's first lock.
- Replacing `foreignJobs` discovery (`GET /api/generations/current`) with the feed entry (D18).
- A Stop button in the window (D17), dragging the window, and remembering its collapsed state across reloads.
- Any change to the owner's ring, the job socket's events, or who may attach to it.
- Checkpoints for a quiet stream (D23).

## Open Questions

None open. The owner accepted the window's scope, statistics-only for other clients, the global Half Streaming switch,
and approximate counts on 2026-11-14.
