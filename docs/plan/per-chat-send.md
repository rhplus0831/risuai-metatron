# Per-Chat Send Plan

Status: planned 2026-10-23 at `fc4d52c5e`. Landed: 1 (`2d9d63b41`), 2 (`bf6146918`), 3 (`aa99e20ca`), 4 (`bd0cddb4c`), 5 (`371c01767`). Line numbers are approximate;
the identifiers are the anchors. Re-verify each cited location before editing.

One slice is one session, one commit, one file cluster. Each slice names its guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Workflow per slice:
`opus-lite` for a slice marked _small_, `opus-workflow` for one marked _hard_. Each slice
ends with its tests (under "Test"), `pnpm check`, `pnpm format:check`,
`pnpm --silent test:agent` (`--e2e` where it touches a screen an `e2e/` spec covers) and
the owning guide's focused checks, and updates the owning guide where it changes a
documented contract.

## Problem

The server runs one generation job per chat and jobs of different chats at the same time:
`server/src/jobs/generationJobs.ts` `create` (~1149) refuses only a second job of the same
chat (`chatSlots`, 409 `chatBusy`). The tab refuses a send in any chat while one of its
own sends runs anywhere: `doingChat` in `src/ts/process/index.svelte.ts` (~14) is one
boolean for the tab, set by `sendChat` (~35–43) for the whole job (it awaits
`sendChatOnServer` → `runServerJob` → `followJobToEnd`) and cleared in its `finally`
(~54–56). The chat screen checks it before every send, reroll and unreroll
(`DefaultChatScreen.svelte` `sendMain` ~398, `reroll` ~463, `unReroll` ~529,
`sendChatMain` ~580) and shows `chatGeneratingElsewhere` for a send in another chat.

The flag dates from the browser pipeline, where it kept overlapping sends off the shared
selection and database. The server-job cutover (416145ac, 12ed3bae) kept it as the send
entry guard, and ddd6748 made `sendChat` its owner and added `sendingChatRef`. No plan
records a decision against concurrent sends in different chats.

Several readers rely on there being at most one local send per tab, so removing the
check alone breaks them:

- `sendChat`'s `finally` resets `sendingChatRef` and `doingChat` unconditionally: the
  first of two sends to end clears the other's state.
- `Suggestion.svelte` (~189–218) keeps one `sendingChat` and treats the flag's falling
  edge as that chat's end: a second send overwrites the first's target, the first end
  requests suggestions for a chat still generating, and the second end may request none.
- The local lore and memory write fences compare one `sendingChatRef`
  (`lorebook.svelte.ts` `localLoreWriteFenced` ~37, `localLoreDraft.svelte.ts`
  `loreWriteFenced` ~29, `HypaV3Modal.svelte` `memoryWriteFence` ~74). After the job is
  followed `generatingChatKeys()` covers the chat, but before that (pin, flush, create)
  only the last send's chat is fenced.
- The chat screen keeps one `abortController`/`abortTarget` (~555–611): Stop reaches only
  the latest local send. Auto mode (`runAutoMode` ~646) sends to whatever chat is
  selected at each round.
- `previewFormated`/`previewBody` (`index.svelte.ts` ~16–17, written ~47–51) are single
  slots read after the await by `DevTool.svelte` `preview` (~36–64) and the
  `previewRequest` hotkey (`hotkey.ts` ~160–175).
- `/multisend` (`command.ts` `runMultisend` ~27, also run for a command job's
  `done.followUps` by `serverCommands.ts` `runFollowUps` ~177), DevTool autopilot
  (~251), and the plugin `sendChat` (`v3.svelte.ts` ~2231) refuse on the tab-wide flag
  and append before their send; file multisend (`files/multisend.ts` ~40–55) relies on
  `sendChat` serializing its "last message" read.
- `pluginWorkIdle` (`v3.svelte.ts` ~688) defers a remote plugin reload while the flag is
  set. `generationPluginWorkActive()` (`network/generationJobs.ts` ~72) already counts
  several jobs, but starts at `createGenerationJob`; the pin and `flushResources` before
  it (`serverCommands.ts` ~310–396) are covered only by the flag.
- `translateHTML` (`translator.ts` ~402) serves cache-only translations while the flag
  is set.
- `streamingState`/`streamingGeneration` (`chatStore.svelte.ts` ~277–298, set ~1127,
  cleared by `releaseStreaming` ~1076) name one streaming message: a newer job's first
  update takes it, and when that job ends the older one is not shown again.
  `Chats.svelte` (~478–486, ~651) and `isStreamingMessage` (~963) read it.
- Completion notifications all carry `COMPLETION_NOTIFICATION_TAG`
  (`shared/notifications.ts` ~6, ~109), so the second chat's notice replaces the first.

The server side is ready except for one queue. `server/src/jobs/channel.ts`
`createChannelHub` (~243) keeps one FIFO lane per client: a root question or callback is
dispatched only when the client has none outstanding, and its deadline runs from the
moment it is queued (`enqueue` ~396: `now() + timeoutMs`). One job's provider callback
may hold the lane for `PROVIDER_CALLBACK_TIMEOUT_MS` (30 min, `server/src/llm/requests.ts`
~1672), and a question waits for the user up to `QUESTION_TIMEOUT_MS` (120 s). A second
job's hook callback (`CALLBACK_TIMEOUT_MS`, 60 s) queued behind it times out without ever
being sent. Jobs a tab resumes at boot can already overlap a local send, so this exists
today, rarely.

## Approach

A per-chat local send registry replaces the tab-wide flag. A chat refuses a second local
send of its own (as the server refuses a second job); different chats send at the same
time. The tab keeps one callback lane on the server (plugin hooks and providers of all
its jobs still run one at a time), but a queued request's deadline starts when it is
dispatched.

- `src/ts/process/localSends.ts` (new, `svelte/store`, no runes; imports only
  `chatStore.svelte.ts` types): a readable map of chat key → `ChatRef` for the sends this
  tab runs; `beginLocalSend(ref)` returns a release function (idempotent) or `null` when
  that chat already has one; `isLocalSend(ref)`; `anyLocalSend` (a derived readable
  boolean). A send without a chat (no selection) holds one tab entry that counts only for
  `anyLocalSend`. A separate module, so readers that import it are not reached by the
  ~30 hand-written `vi.mock`s of `src/ts/process/index.svelte` (`STRUCTURE.md` V7: a
  new export of a hand-mocked module breaks those tests at run time, not in
  `pnpm check`). The mocks that only stub `doingChat`/`sendingChatRef` keep working
  while slices 1–4 run; slice 5 removes the stubs with the exports.
- `sendChat` takes its entry before its first await and releases it in `finally`. Until
  slice 5 it still refuses while `anyLocalSend` is set (today's behavior); slice 5 changes
  that to `isLocalSend(target)`.
- Every reader that means "this chat" moves to `isLocalSend(ref)`; every reader that
  means "this tab is busy" (plugin reload deferral, translator cache-only mode) moves to
  `anyLocalSend`. `doingChat` and `sendingChatRef` go once no reader is left.

Accepted limits (decided 2026-10-23, documented in `chat-pipeline.md` by slice 6, not
fixed):

- Two chats of one character write the character record without a character lock.
  Field patches keep unrelated fields, but the same field (`lastInteraction`, a field a
  trigger or Lua writes) is last writer wins. A group chat job and a job in one of its
  members' own chats can patch the same member the same way.
- `CharEmotion` is keyed by character, so two chats of one character share its emotion
  history; `stopTTS()` stops every chat's speech; `alertWait`'s single status slot and
  the legacy `progress` overlay (`jobChannel.ts` `progressJobId` ~242) show the newest
  job.
- Plugin hooks and providers of one tab stay serialized by the channel lane: a slow
  provider in one chat delays the other chat's hooks (now without timing them out).

Out of scope: the composer (`messageInput`, `messageInputTranslate`, `fileInput`) is one
component state for every chat, and writes after an await (`processMultiCommand`, input
translation, image paste, the file button) land in whichever chat is selected then. It
exists today and is tracked separately.

## Order

(1, 2, 3) → 4 → 5 → (6, 7).

- Slices 1, 2 and 3 share no file: 1 is the registry and its readers (`src/ts/process/`,
  `Suggestion.svelte`, the fences, translator, `pluginWorkIdle`), 2 is
  `server/src/jobs/channel.ts`, 3 is `chatStore.svelte.ts` streaming and `Chats.svelte`.
  They run in parallel.
- Slice 4 moves the other send callers to the registry and changes the preview result
  path in `index.svelte.ts`; it needs slice 1.
- Slice 5 is the only slice that lets two chats send at once (`sendChat`'s check and the
  chat screen). It needs 1–4: before it, every hazard above is unreachable.
- Slice 6 is notifications, docs, and the end-to-end check, after 5.
- Slice 7 (added 2026-10-23 after slice 5's review) fixes two channel hazards slice 5
  makes reachable; it shares no source file with 6, so they run in parallel.

## Slice 1. Local send registry, behavior unchanged (_hard_, `chat-pipeline.md`)

- `src/ts/process/localSends.ts` (above).
- `index.svelte.ts` `sendChat`: refuse while `get(anyLocalSend)` or the target is gone
  (unchanged rule); take `beginLocalSend(target)` (null target: the tab entry) before
  the first await, release it in `finally`. `doingChat` becomes a re-export of
  `anyLocalSend` (readable) for the callers slice 4 moves; `sendingChatRef` goes.
- Fences: `localLoreWriteFenced`, `loreWriteFenced`, and `memoryWriteFence` test
  `isLocalSend(ref)` in place of the `sendingChatRef` comparison (the
  `generatingChatKeys()` half stays). `loreWriteFenced` and `memoryWriteFence` stay
  reactive (subscribe to the registry, as they do to `sendingChatRef` today).
- `Suggestion.svelte`: follow registry entries per chat. An entry added for a chat does
  what the `sendingChatRef` subscriber does now (drop it from `pendingChatKeys`, cancel a
  request for that chat, clear its `suggestMessages`); an entry removed does what the
  `doingChat` falling edge does now for that chat (request when selected, else queue its
  key). `sendingSelectedChat` becomes `isLocalSend(selected)`. The `$effect.pre` that
  clears a background send's suggestions runs for every entry.
- `translator.ts` (~402) and `v3.svelte.ts` `pluginWorkIdle`/`onPluginWorkChange`
  (~688–705) read `anyLocalSend`.
- `chat-pipeline.md`: replace the `doingChat`/`sendingChatRef` text (~32, ~82, ~98, ~109)
  with the registry; `plugins-mcp.md` where it names `doingChat` for reload deferral.
- Test: `src/ts/process/localSends.test.ts` (begin/release per chat, a second begin of
  the same chat is null, release is idempotent, `anyLocalSend` over two entries and the
  tab entry). Update `src/ts/process/index.test.ts` (`sendChat owns the tab's send
state`: the entry is held from before the first await to the end on success, refusal,
  and throw; chat B is still refused while A runs), `command.test.ts` (resets the
  registry instead of `doingChat.set(false)`), `pluginWorkIdle.test.ts` (drives the
  registry instead of `doingChat.set`), the translator tests that mock `doingChat` to
  reach cache-only mode (`translatorLLM`, `translatorMedia`, `translatorMemoryCache`,
  `translatorMemoryOverhead`), and `HypaV3Modal.fence.test.ts`,
  `localLoreDraft.fence.test.ts`, `lorebook.svelte.test.ts` (fence from a registry
  entry). `Suggestion.svelte` has no test today: add one with two entries ending in
  either order, where each chat's end requests or queues for that chat only (it fails on
  today's single `sendingChat`).

## Slice 2. Channel deadlines start at dispatch (_hard_, `self-host-server.md`)

- `server/src/jobs/channel.ts` `enqueue`/`dispatch`: a root request queued behind another
  gets its deadline when it is dispatched (`now() + timeoutMs`, recorded on the request),
  not when queued. A child keeps its rule (dispatched at once, capped by its parent's
  deadline). The `build(id, deadline)` event carries the dispatch deadline, so the tab
  sees the real one; check what the tab does with it (`jobChannel.ts`).
- A queued request still ends with its job (`close` → `aborted`), its caller's signal,
  and the 256-request lane cap. Decide D2's bound on queue wait.
- Update `QUESTION_TIMEOUT_MS`/`CALLBACK_TIMEOUT_MS` comments ("from the moment it is
  queued") and `self-host-server.md` where it describes the hub.
- Test (`server/src/tests/jobChannel.test.ts`, injected `now`): two jobs of one
  client; job A's provider callback outstanding past 60 s; job B's hook callback queued
  meanwhile is dispatched after A's settles with a full `CALLBACK_TIMEOUT_MS` (fails on
  today's queue-time deadline); B's question likewise; a queued request whose job closes
  settles `aborted`; a child's deadline is still capped by its parent; D2's bound.

## Slice 3. Streaming display per chat (_small_, `ui-theming.md`)

- `chatStore.svelte.ts`: `streamingState`/`streamingGeneration` become a map of chat key
  → `{ messageId, mode, generationId }`; the first stream update of a generation sets its
  chat's entry, `releaseStreaming(generationId)` clears only the entry holding that
  generation. `isStreamingMessage(ref, id)` reads the entry of `ref`'s chat. Export a
  reader for one chat's entry.
- `Chats.svelte` (~478–486, ~651–654): read the selected chat's entry.
- `chat-pipeline.md`/`ui-theming.md` where they describe `streamingState`.
- Test (`src/ts/storage/tests/chatStore.test.ts`; update the `Chats.*.svelte.test.ts`
  files that set `streamingState`): streams in chats A and B; B's start leaves A's entry;
  B's release leaves A's; A's message stays `isStreamingMessage` throughout (fails on
  today's single state).

## Slice 4. Other send callers and previews (_hard_, `chat-pipeline.md`)

Depends: 1.

- Previews: a preview returns its result to its caller instead of through
  `previewFormated`/`previewBody`. Add `previewChat(kind, target?)` in `index.svelte.ts`
  (or `sendChat`'s result type) and move `DevTool.svelte` `preview` and the
  `previewRequest` hotkey to it; a refused preview shows nothing (today the hotkey parses
  a stale `previewBody`). Remove the two exports and the `previewFormated`/`previewBody`
  wording in `chat-pipeline.md`.
- `command.ts` `runMultisend`: refuse while `isLocalSend(ref)` or the chat has a followed
  job or lock (`isChatGenerating(ref)`), checked before every part's clear/append, not
  only at the start; a part whose send is refused stops the run. `runFollowUps` inherits
  it.
- `DevTool.svelte` autopilot: the same per-chat check before each append.
- `files/multisend.ts` (PO): check the captured chat before each append and stop when
  `sendChat` returns false, instead of reading the last message of a send that did not
  run.
- `v3.svelte.ts` plugin `sendChat` (~2231): refuse when the target chat (the hook's, else
  the selected one, resolved as today) has a local send, a followed job, or a lock;
  check again after `ensureChatLoaded` and before the append; return `sendChat`'s result
  instead of `true`.
- `hotkey.ts` (~161): the preview check is per chat.
- Test: `command.test.ts` (`/multisend` refused in a chat with a local send; another chat
  runs; a refusal mid-run appends nothing more), `hotkey.test.ts` (a refused preview
  shows no stale body), `files/tests/multisend.test.ts` (a refused send stops the PO
  run), a plugin `sendChat` test (refused for a busy chat without appending; `false`
  for a send that did not run).

## Slice 5. Different chats send at once (_hard_, `chat-pipeline.md`)

Depends: 1, 2, 3, 4.

- `index.svelte.ts` `sendChat`: refuse when `isLocalSend(target)`, not `anyLocalSend`.
  Remove the `doingChat` re-export and the `doingChat`/`sendingChatRef` stubs in the
  hand-written mocks of `src/ts/process/index.svelte` (`rg -l "doingChat|sendingChatRef"
-g '*.test.ts' src`).
- `DefaultChatScreen.svelte`:
  - `sendMain`, `reroll`, `unReroll`, `sendChatMain`: refuse with `chatGenerating` when
    the chat has a local send (`isLocalSend(ref)`), a followed job (`ownedJobIds`), or a
    lock (`isChatGenerating`, as reroll does now); other chats are not checked.
  - Stop: a map of chat key → `AbortController` for this screen's sends, set before
    `sendChat` and removed when that send ends (only if it is still that send's
    controller). `abortChat` aborts the selected chat's controller and its followed jobs.
    The Stop condition (~1019) reads the selected chat's entry.
  - Auto mode (D4).
  - Remove `localSendRunning`, `alertChatBusy`, and `chatGeneratingElsewhere` (`en.ts`
    ~1514, `ko.ts` ~972, any other locale), and the dead `doingChatInputTranslate`.
- `chat-pipeline.md` steps 1–3 (~73–80): the per-chat rule.
- Test: `index.test.ts` (A and B run together; a second send in A is refused while A
  runs; each `finally` releases only its own chat). A chat screen test if one exists for
  Stop (Stop in A aborts A only; switching to B and pressing Stop aborts B only), else a
  focused unit over the controller map. Remove tests of the cross-chat refusal.

## Slice 6. Notifications, limits, end-to-end (_small_, `chat-pipeline.md`)

Depends: 5.

- Notification tag per chat (D5): `completionNotification` builds
  `COMPLETION_NOTIFICATION_TAG` plus the chat (within the payload budget);
  `pushNotifications.ts` `dismissCompletionNotifications` (~427) closes every
  notification whose tag starts with the prefix. Web Push and the tab notice use the same
  builder.
- `chat-pipeline.md`: an "Accepted limits" list (Approach above); `persistence.md` if it
  states one send per tab.
- `e2e/`: one spec with two chats in one tab and a slow fake reply: send in A, switch,
  send in B, both replies land in their own chats, Stop in B leaves A running,
  suggestions appear per chat (if the fixture enables them). Use the existing fake
  provider setup the other generation specs use (`build-test-platforms.md`).
- Test: `shared/notifications` tests (two chats get different tags; the budget still
  holds), `pushNotifications` dismissal test.

## Slice 7. Channel lane and callback parentage across chats (_hard_, `plugins-mcp.md`)

Depends: 5. Added 2026-10-23: the Sol review of slice 5 found two hazards that per-chat
sends make reachable (pre-existing for boot-resumed jobs). Both must be fixed before the
run ends; D1 (one root callback at a time per tab) still holds.

- Stop in one chat ends another chat's job. `src/ts/network/jobChannel.ts`
  `handleCallback` (~973) refuses a root callback while `outstanding` is non-empty
  (`failure: "protocol"`); a server `cancel` only marks the entry `cancelled` (~118), and
  it leaves `outstanding` when the plugin hook's promise settles (~986). The server
  (`server/src/jobs/channel.ts` `settle` ~286) frees the lane at once and dispatches the
  next queued root, so Stop in chat A while A's slow hook runs lets chat B's next hook or
  provider callback be refused, which can end B's job (`server/src/prompt/runner.ts`
  ~1444). Fix: the server keeps the lane held after cancelling a dispatched callback until
  the tab reports that callback drained (an explicit message in `shared/jobs.ts`), with a
  bound so a hook that never settles does not hold the lane forever (the cancelled
  callback's own remaining deadline, or `CALLBACK_TIMEOUT_MS` from the cancel). The tab
  must not run a new root while a cancelled one is still running (D1). Check whether
  `channelCallbacksRunning()` (`generationJobs.ts`, plugin `sendChat`'s guard) should then
  follow lane occupancy; a never-settling hook keeping plugin `sendChat` refused after its
  job ended is the same root.
- UI requests become another job's callback children. `src/ts/process/request/transport.ts`
  (~239) sets `body.channelCall = activeChannelCall()` for every auxiliary LLM request,
  and `src/ts/network/channelCallSource.ts` returns the top of the tab's outstanding
  callbacks, not the request's own origin. A request the UI starts while another job's
  callback runs (a suggestion request when chat A's send ends while chat B's hook runs, a
  message translation during a plugin-provider reply) becomes that callback's child: it is
  aborted when the callback settles, refused if it settles before the POST
  (`server/src/llm/requests.ts` ~1165), and may get B's interceptors. Fix: carry callback
  provenance explicitly from plugin code that runs inside a callback; UI-originated
  requests (suggestions, translation, memory, the composer) carry none. Check
  `request.ts` `activeChannelCallTargets` (~205) the same way. Also pass
  `Suggestion.svelte`'s captured `requestChatRef` to its request (~149).
- `plugins-mcp.md` and `self-host-server.md` where they describe the lane and callback
  parentage.
- Test: `server/src/tests/jobChannel.test.ts` (a cancelled dispatched callback holds the
  lane until the tab's drain message, then the next root dispatches; the bound releases a
  never-drained one), a `jobChannel.ts` test (Stop in A while A's hook runs; B's next root
  callback is not refused), `transport.test.ts` / `request` tests (a UI request made while
  another job's callback is outstanding carries no `channelCall`; a request from plugin
  code inside the callback still does).

## Decisions

The runner takes each default unless the user overrides it.

- D1. Plugin callbacks (decided 2026-10-23, not an option). The per-tab channel lane
  stays: one root hook or provider callback at a time per tab. No job-scoped plugin
  context.
- D2. Bound on queue wait (slice 2). Options: (a) none beyond the job's life, its
  caller's signal, and the lane cap; (b) a request queued longer than its own timeout
  plus `PROVIDER_CALLBACK_TIMEOUT_MS` settles `timedOut`. Default (a).
- D3. Translator cache-only mode. Options: (a) while any local send runs (`anyLocalSend`,
  today's meaning); (b) only while the chat being rendered has one (needs the render's
  chat passed to `translateHTML`). Default (a).
- D4. Auto mode (slice 5). Options: (a) bound to the chat it started in; a switch away
  ends the loop after the current round; (b) keeps running in its chat in the
  background, stoppable when that chat is selected again. Default (a).
- D5. Completion notifications (slice 6). Options: (a) one tag per chat; (b) keep one
  tag (a later chat's notice replaces the earlier one). Default (a).
- D6. Accepted limits (decided 2026-10-23, not an option): the Approach list is
  documented, not fixed.
- D7. Locales. `chatGeneratingElsewhere` is removed from every locale; no new strings
  are expected. If one is, `en.ts` only.
- D8. Channel hazards found in slice 5's review (decided 2026-10-23): land slice 5,
  fix both in slice 7 within this run.

## Open Questions

- Server load: two long jobs of one tab double its LLM requests. In-job requests bypass
  the per-client `/api/llm` cap by design; no per-client job cap exists. Add one only if
  a run shows a problem.
- A plugin `sendChat` inside a hook targets the hook's chat, which is generating, so
  slice 4 refuses it. One from a plugin timer or UI callback (the ambient context, or
  the selected chat) may start a job in another chat; if a hook callback awaits such a
  send, the new job's callbacks wait on the lane the hook holds until the hook's
  deadline. Confirm in slice 4's plugin `sendChat` test that no hook path awaits a send
  in another chat.
