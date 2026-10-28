# Display Evaluation Plan

Status: landed 1 (fd7f50766), 6 (15ed61b6c), 3 (6b0d485f5), 4 (3b0e047ff), 5 (cf326ef1e), 2 (4a1d870f3). The user answered Q1–Q3 on 2026-10-28, all as recommended (see
**Answered questions**). A Sol review of the first draft is folded in (see **Review record**).
Probe numbers are under **Measurements**.

Sources: findings TJ02, TJ03, TJ05 and ST05 of the
[server migration deep audit](../research/deep-audit-with-fable/server-migration-audit.md)
(at `ff7cb9d20`), which the archived Deep Audit Fixes plan deferred here with the order "TJ02
first, then TJ03, ST05, TJ05" (`git show ca5b656fa:docs/plan/deep-audit-fixes.md`, **Deferred**).
The audit's probe is `docs/research/deep-audit-with-fable/probes/transform-jobs-probe.mjs` (labels
`mixed-revision-cache`, `viewport-cross-client`, `four-tiny-snapshots`, and the TJ03 table); run
it with `node --expose-gc` from the repository root. Code anchors were checked at `3a331550d`;
verify them again before editing (STRUCTURE.md protocol step 5).

Owning guides: [cbs-rendering](../structure/cbs-rendering.md) (the transform client, the render
flow, the CBS evaluator), [scripts-triggers](../structure/scripts-triggers.md) (regex dispatch),
[self-host-server](../structure/self-host-server.md) (`/api/transform`),
[chat-pipeline](../structure/chat-pipeline.md) (`loadJobScope`, which generation jobs share),
[persistence](../structure/persistence.md) (the chat module's new reactive read, Slice 2).

## Goal

A cached display transform result is never served once the stored transcript or the viewport it
was computed from has changed; in particular, a result computed from a mix of the tab's unsaved
text and the stored transcript is not served after the save that should correct it, and the row
that showed it renders again once the save lands. A render burst reads its configuration and
transcript once, and the once-per-send `lastInteraction` stamp no longer re-renders every row. A
kept two-call snapshot is charged for what it holds. A row that remounts unchanged shows its last
confirmed result without downloading the text again.

The guarantee covers the server's own reads (CBS, regex, Lua, the display trigger). It does not
cover the tab's plugin handlers (D2), nor inlay records and file existence read by Lua's image
getters (a known limit, **Out of scope**).

Not goals: a per-function dependency key (deferred behind a measurement, **Later**); omitting
the source upload on a remount; delivering display results with the chat read; the client's CBS
pre-pass and translation caches; per-event generation work (TJ04, SD01).

## Current state

- **Client** (`src/ts/parser/transformClient.ts`). `captureTransform` (`:113-156`) captures the
  chat ref, the message id, the display ids, the plugin context, the lock and the Re-render
  generation; it reads `heldChatRevision` only to refuse a chat the server has not stored, and
  needs both preset ids and a persona. No revision or digest is captured or sent.
  `serverProcessScript` sends the row's current text as `source`; the viewport
  (`window.innerWidth/innerHeight`) and `browserLanguage` are sampled at dispatch (`:389-418`).
  Calls join a per-frame batch keyed by mode, context and handler set; batches clear at each
  flush (`:175-226`). `rerenderMessage` marks the next sent capture `noCache` (`:159-165`). The
  generation fences effects only: a late answer still returns its text, and `ChatBody`'s
  `parseRun` guard (`ChatBody.svelte:335-341`) keeps a superseded parse from committing. Emotions
  apply once per result `key` (`appliedEmotions`, 4,096 keys, cleared by
  `resetTransformEffects`, `stores.svelte.ts:259-270`).
- **No tab-side result cache.** `ChatBody.svelte` starts `markParsing` on every mount
  (`:419-423`); `lastParsed` is one slot per mounted row. `Chats.svelte` reuses row components
  only while they stay shown (`:769-838`). Switching between two loaded chats re-sends every
  visible row.
- **Server cache** (`server/src/prompt/transformCache.ts`): one process-wide LRU of
  `{ text, emotions }`, 512 entries, 16 MiB, 512 KiB per entry, with per-key generations so an
  invalidated fill cannot land (`:62-93`). The key (`server/src/prompt/transform.ts:352-411`) is
  the epoch, mode, context, browser language, handler set, every loaded non-character revision,
  the owner's and members' revisions, a digest of chat metadata (`scriptstate`,
  `GLGlobalVariables`, `note`, `localLore`, `loreOverrides`, `name`, `modules`, `bindedPersona`,
  both preset ids, `fmIndex`), and per target its kind, message id, index, source id, source
  character revision, `cbsConditions` and `sha256(source)`. It leaves out the chat revision, the
  stored messages, the viewport, and the characters of earlier speakers that the load reads
  (`jobScope.ts:129-179`; a group's evaluator resolves the last speaker,
  `shared/cbs/evaluator.ts:705-715`). `transform.test.ts:489` ("… not for the viewport or the
  other messages") pins the first two omissions. `editdisplay` and `editprocess` share this key.
- **Admission.** A full load checks the chat binding and requires the named presets and persona
  (`jobScope.ts:225-258`, `chatBinding.ts:60-68`). `cachedResults` (`transform.ts:414-454`)
  answers an all-cached request from revisions, chat metadata (`chatMeta`, which carries the chat
  revision, `resourceStore.ts:1612-1615`) and the remembered owner members, without the load and
  without the binding check: it relies on an admitted entry existing under a key that holds
  every loaded revision.
- **Reads that change a result besides its key.** History (CBS `previouscharchat`,
  `previoususerchat`, `userhistory`, `charhistory`, `lastmessage`, `lastmessageid`,
  `previouschatlog`, `history`, the message time functions, `idleduration` (history and the
  clock), `role`, the seeded `pick`/`rollp`; Lua `getChat*`, `getChatData`, `getFullChat*`,
  `getChatLength`, `get*LastMessage`; regex `repeat_back`); viewport (`screenwidth`,
  `screenheight`); the clock and `Math.random`. Nested parses (`history`, `mainprompt`, `call`)
  reach the same functions. The tab's plugin handlers run between the two calls of a snapshot
  (`transformClient.ts:318-337`) and can read any chat or permitted record; the server caches
  their output under the handler set's identity (`transform.ts:566-569,740-748`).
- **Load on a miss** (`server/src/jobs/jobScope.ts`). `loadJobScope` reads every record of 23
  non-character kinds (`:116-125`), the whole chat with every message row parsed
  (`server/src/data/chatStore.ts:1793-1802`), the owner, members, speakers and target sources;
  `loadRequestDb` rereads nine settings records (`server/src/llm/settings.ts:92-129`). Nothing is
  shared between the batches of a burst. Generation jobs use the same loader.
- **Timestamps.** A character revision is an opaque token (`shared/resources.ts:117-123`). The
  send job patches `lastInteraction` once per send, continue, reroll or group job
  (`server/src/prompt/runner.ts:321-349`), which advances the owner's revision and so every row's
  key. No display read exposes `lastInteraction`.
- **Dispatch.** `runScriptTail` sends the combined preset, character and module regex list to a
  worker when the list is non-empty, even when no script has the stage's type
  (`server/src/prompt/scripts.ts:187-216`; the engine checks the type later,
  `shared/scripts/regex.ts:107`). Each ordinary replacement passes its result through the CBS
  host parse even when nothing matched (`regex.ts:228-230`).
- **Snapshots** (two-call renders with tab plugin handlers). A `TargetRun` keeps its frozen-binding
  `RunSetup`, the target's source, a full `scriptstate` copy, per-target wrappers and caches
  (`transform.ts:58-89,457-499`). `retainedBytes` counts only the pending text and changed
  variables against an 8 MiB budget (`:47-49,115-125`). At most 4 snapshots per client and 16 in
  all, 30 s each (`:682-690`). The audit measured 45.86 MiB retained for 16 pending bytes.
- **Invalidation.** `noCache` (Re-render) replaces one key (`:620-624`); maintenance (restore,
  import) clears the cache (`:762-780`); everything else relies on the key changing.

## Decisions

### D1. A conservative correctness key

Every key, in both modes, gains the stored chat revision and the request's viewport
(`width×height`), and every character the load read (owner, members, earlier speakers, target
sources) enters by its display identity (D6). The chat revision is the one the run's load read;
a result is stored under it even if the chat has moved on, and `cachedResults` reads the current
one from the chat metadata it already reads. This makes the audit's two cases miss: the pre-save
mix stays under the old revision, and an 800-wide result is not offered to a 320-wide client.

Nothing is narrowed here, so the admission argument of `cachedResults` stands. The price: after
any save of a chat, its rows' entries are unreachable, so a remount after a send renders every
row on the server again (cheap once D5 shares the load). Narrowing by what a run actually read is
**Later**.

### D2. Plugin handler output

The tab's handlers are opaque to the server. Their output stays cached as today, under D1's key
and the handler set's identity, so it is refreshed by a chat change, a viewport change or
Re-render, but not by a plugin's private state or by records the server key does not hold
(Q3).

### D3. Clock and random reads

Cached as today: a row keeps its value until its key changes or Re-render. Under D1 the key
changes with every save of the chat, so a `{{random}}` row may re-roll when it remounts after the
chat changed (Q1).

### D4. The row that saw a mix renders again

A row renders again, once, through the cache, when its render may have mixed unsaved and stored
text:

- its render began while its chat had unacknowledged work, or
- its chat's installed state moved between the render's start and its answer (each render
  captures the chat's version at start and compares when the answer arrives).

The render waits until the chat settles: no pending or in-flight work for it and no locked
message in it. The wait is held per chat and drained once for every affected mounted row when
the chat-wide condition turns false. Rows that did not render in that window do not render
again. Refused, quarantined or deferred work does not settle the chat; the version moves when
that work is resolved (a discard installs the remote chat).

The chat module gains one reactive, O(1) per-chat read: a version bumped when an
acknowledgment empties the chat's pending and in-flight work (`ackChatWork`,
`chatStore.svelte.ts:4147-4208`), when a remote chat is installed (`applyRemoteChat`, `:4717`),
and when an authoritative patch lands (`installChatPatch`, `:1828`); and a reactive "has
unacknowledged work" flag. A stale acknowledgment that only marks a refresh does not bump it.

This guarantees only the server-side refresh. The browser CBS pre-pass (`Chat.svelte:835-889`)
keeps its own reactivity, and rows that read history but rendered before the window stay as
today (they update on remount).

### D5. One load per render burst

The transform gets its own loader (`loadDisplayScope`); `loadJobScope` and generation are
unchanged. It caches the raw configuration records by epoch and their revision vector, and the
raw transcript by chat revision, as immutable entries. Each request builds a fresh context
projection (the forwarded preset and persona roots, the target sources, the request settings)
and each target its overlay (`scriptstate`, tempVars, regex and dynamic-asset caches) as today.
No deep freeze or clone: the bindings are already frozen for writes (`runtime.ts:647-655`,
`bindings.ts:471-489,616-618`), and a test drives every write a display run allows (Lua variable
writes, trigger locals, nested CBS writes) across targets, requests and continuations and checks
the shared entries are unchanged.

Both caches are bounded by entries and by an estimated size (the UTF-8 length of the rows read),
starting at two configuration entries and 64 MiB of transcripts, adjusted after the Slice 4
measurement.

### D6. Display identity of a character

A character enters the key by a digest of its stored record without `lastInteraction`, computed
before the runtime chats are attached, memoized by revision token in an LRU bounded by entries.
A missing character has a fixed `missing` identity, so a speaker that comes back changes the
key. The earlier speakers of a chat are memoized by chat revision at load time so
`cachedResults` can still answer without loading messages; with no memo it misses. Excluding
another field needs a demonstration that no display read reaches it.

A kind no display read reaches may leave the key, one by one, each with its reason written beside
the table (candidates: `hotkeys`, `characterOrder`, `authRefreshes`, `translatorPresets`,
`hypaV3Presets`, `providers`, `credentials`). The kinds admission depends on (`presets`,
`modelPresets`, `personas`) and `globalChatVariables` (the toggle resolver's legacy fallback,
`shared/prompt/toggles.ts:131-159`) never leave it. A guard test fails on a kind the table does
not classify.

### D7. Dispatch

- `runScriptTail` filters the regex list by the stage's type before deciding to dispatch; the
  dynamic-asset tail stays outside that early exit.
- An ordinary replacement that did not match skips the host parse when the would-be parse input
  cannot change under CBS. The predicate lives beside the evaluator, so the scanners cannot
  diverge: no `{{`, no `{#` (the legacy conditional), and no `<user>`, `<char>` or `<bot>` in any
  case (`shared/cbs/evaluator.ts:786,797-821`). `<cbs>` parsing of regex inputs and the cache key
  is unchanged.
- No Lua filtering: code can register an edit listener without the literal `listenEdit`.

### D8. Snapshot accounting

A snapshot is charged a conservative estimate of what it holds: for each target its source (when
distinct from its text), its `scriptstate` copy, its text and changed variables, plus a fixed
overhead; and the scope it pins. Before D5, that scope is charged per snapshot. After D5, it is
charged once per shared entry, by reference count, against a global retained budget. A pin is
released on every end path: success, target error, expiry, replacement, abort, queue refusal,
maintenance and shutdown. The continuation keeps its pin until it finishes, even after the
snapshot left the map. A first call over budget keeps no snapshot; its targets fail and show raw,
as an over-budget target does today. The budgets start at today's 8 MiB per snapshot and 64 MiB
global, confirmed by the Slice 3 and Slice 4 measurements.

### D9. Reuse a confirmed result across remounts

The tab keeps confirmed answers in an LRU bounded by entries and estimated bytes (identity strings
and emotions included). The key holds every dimension the server key uses on the tab side: chat
ref, mode, kind, message id, index, source id, `sha256(source)`, conditions, capture context,
handler set and viewport. The value is `{ key, text }`.

On a remount the row sends its full target as today, with `knownKey`. The server answers `same`
(no text) only when its cache holds that exact key, the same admission as an ordinary cache
hit. Otherwise it answers with the full result. The row shows the cached text at once and
replaces it if the full result differs (Q2), so the switch neither waits nor downloads unchanged
text. The upload stays.

Lifecycle fences:

- **Generation.** The cache carries a generation (epoch, `ReloadGUIPointer` reset). Every
  insertion and every `same` confirmation must match the generation, the message's render
  generation and the target identity, so a completion that started before a reset is inert.
- **Re-render** drops the row's entry and bypasses both caches.
- **Epoch change** clears the cache through a hook beside `setResourceEpoch`
  (`resourceClient.ts:64-70`), without touching the restore listener.
- **Sign-out** has no product flow yet; the cache registers with the same future hook as
  `clearBootCache` (`bootCache.ts:748`).

A cached text goes through the same later stages (`ParseMarkdown` after the transform,
DOMPurify) as a fresh one. Emotions apply only from a confirmed answer, once per key as today.

## Answered questions

Answered by the user on 2026-10-28.

- **Q1. Random and time rows.** Accepted: under D1 a `{{random}}` or clock row may change when it
  remounts after its chat changed. The dependency key in **Later** would make such rows stable
  again.
- **Q2. Chat switch.** The tab cache's text shows at once and is replaced when the answer
  differs, so the switch has no wait. A row can show a brief correction after a change made
  elsewhere.
- **Q3. Plugin handler output.** It stays cached as today (D2): a chat or viewport change and
  Re-render refresh it, a plugin's own state does not.

## Slices

### Slice 1: the conservative key (TJ02 server; needs nothing)

Files: `server/src/prompt/transform.ts`, `server/src/prompt/transformCache.ts` if the key helper
moves.

- Before any change, run the probe and record its numbers in this plan (baseline).
- D1 without D6's character identity (that lands in Slice 5); the earlier speakers enter by
  revision until then.
- `transform.test.ts:489` changes: another message or another viewport now renders again. New:
  the probe's `mixed-revision-cache` case (a result computed before the save is not served after
  it), `viewport-cross-client`, an earlier speaker's rename, a run that loaded an old revision
  storing under it while a newer probe misses, the same cases for `editprocess` and for a
  two-call render. Refusal tests (`transformService.test.ts:475-629`) keep passing.

### Slice 2: the row that saw a mix renders again (TJ02 client; needs 1)

Files: `src/ts/storage/chatStore.svelte.ts` (the version and flag only),
`src/ts/parser/transformClient.ts` (the start capture), `src/lib/ChatScreens/Chat.svelte`,
`src/lib/ChatScreens/ChatBody.svelte`, a small per-chat scheduler beside them.

- D4. Slices 1 and 2 together are the TJ02 fix; Slice 1 alone stops new stale hits but leaves a
  shown row as it was.
- Tests use a server-only history reader (a Lua `getChatData` or regex `repeat_back` script), so
  the browser pre-pass cannot satisfy them: an unsaved edit rendered, then acknowledged, renders
  once more with the stored text; an acknowledgment and a remote append held between the load
  and the first answer (also across the two-call gap) cause one more render; a completed row
  waiting while another row streams renders once on unlock with no further append; several
  events in one frame cause one render; a quarantined chat does not render until resolved; a row
  rendered before the window does not render again.

### Slice 3: snapshot accounting (TJ05; needs nothing)

Files: `server/src/prompt/transform.ts`.

- D8's per-target estimate and per-snapshot scope charge.
- Tests: the probe's `four-tiny-snapshots` charges the chat; many targets with a large unchanged
  `scriptstate`; a large source with a tiny head result; an over-budget first call keeps no
  snapshot and fails its targets. Record the probe's retained heap.

### Slice 4: one load per render burst (TJ03; needs 1, 3)

Files: new `server/src/prompt/displayScope.ts` (`loadDisplayScope`, its caches, the projection),
`server/src/prompt/transform.ts`, `server/src/jobs/runSetup.ts` and `server/src/jobs/cbsHost.ts`
only if the overlay boundary moves there, `server/src/llm/settings.ts` (a revision-memoized request
projection, if the measurement asks for it).

- D5, and D8's shared-entry reference count.
- Tests: eight consecutive batches of one chat load configuration and transcript once (counted on
  a store wrapper); an append reloads only the transcript; a preset edit only the configuration;
  the write-isolation test; both bounds evict; pins survive eviction and are released on every end
  path; generation's reads, live refresh and writes are unchanged. Measure the TJ03 table again.

### Slice 5: narrow invalidation (TJ03; needs 4)

Files: `server/src/prompt/displayScope.ts`, a new `server/src/prompt/displayKinds.ts` (D6's table),
`server/src/prompt/transform.ts`.

- D6. Tests: a `lastInteraction` patch keeps every row's entry; a description or lore edit
  changes it; a removed group member who is still the last speaker is keyed; a deleted then
  restored speaker; each dropped kind's change keeps entries; a deleted selected model preset
  still refuses a cold request and an all-cached one; the guard test. Measure the digest's cost on
  a large character after a stamp.

### Slice 6: dispatch (TJ03; needs nothing)

Files: `server/src/prompt/scripts.ts`, `shared/scripts/regex.ts`, `shared/cbs/evaluator.ts` (the
predicate).

- D7. Tests: a list holding only other stages' scripts starts no worker task, while the
  dynamic-asset tail still runs; a non-matching replacement over plain text makes no host parse;
  over `{{`, `{#if …#}`, `<USER>` or `<Char>` it still parses; a previous script that introduced a
  legacy block still parses; `transformGolden.spec.ts` matches. Record the ten-regex timing.

### Slice 7: `same` answers (ST05 server; needs 1)

Files: `shared/transform.ts`, `server/src/routes/transform.ts`, `server/src/prompt/transform.ts`.

- D9's server side: `knownKey` on a target (bounded hex), `same` on an exact cache hit, a full
  result otherwise; mixed requests answer each target on its own.
- Tests: `same` for an unchanged row; a full result after a variable change, an append, or another
  viewport; an evicted entry gives a full result; a malformed `knownKey` is a 400; refusals
  (epoch, binding, authentication) match a request without it.

### Slice 8: the tab result cache (ST05 client; needs 2, 7)

Files: `src/ts/parser/transformClient.ts`, a new `src/ts/parser/transformResults.ts` (the LRU and its
generation), `src/lib/ChatScreens/ChatBody.svelte`, `src/ts/stores.svelte.ts` (the reset),
`src/ts/storage/resourceClient.ts` (the epoch hook).

- D9's client side, showing the cached text before the answer (Q2).
- Tests: a remount sends `knownKey` and renders the cached text on `same`; a full answer replaces
  it; Re-render bypasses and replaces the entry; a late `same` or full answer after Re-render, a GUI
  reset or an epoch change is inert; emotions never apply from a cached text and stay once per
  key; empty results and repeated source edits respect both bounds. `e2e/serverTransform.spec.ts`
  gains a chat switch where unchanged rows download no text.

### Slice 9: docs close and measurement (needs all)

- Guides: cbs-rendering (D1's key, D4's refresh, the tab cache, and a Known Hazards entry for the
  inlay omission and the plugin policy), scripts-triggers (D7), self-host-server (`knownKey`,
  `same`), chat-pipeline (the display loader beside `loadJobScope`), persistence (the chat
  module's version and flag). Rewrite the cache comment at `transform.ts:147-153`.
- Run the probe and the TJ03 table again and record before and after numbers in the archive entry.
  Measure how often a remount after a send misses (D1's price) and state whether **Later** is
  needed.
- Device checks (a chat switch on the Android PWA over a mobile network) go to the user as a
  checklist.

## Recommended order

1 → 2 → 3 → 4 → 5 → 7 → 8 → 9. Slice 6 may run any time; it touches no file of the others.
Slices 1, 3, 4, 5 and 7 all edit `server/src/prompt/transform.ts` and must not run in parallel.

Overlap with the Durable Drafts plan:

- `chatStore.svelte.ts`: Slice 2 here, and Durable Drafts Slices 6, 7, 9 and 10. Land Slice 2
  when none of those is in flight, or rebase onto them.
- `resourceClient.ts`: Slice 8 here, and Durable Drafts Slice 2.
- Guides: chat-pipeline and persistence, in Slice 9 here and Durable Drafts Slice 12.

## Measurements

Probe (`transform-jobs-probe.mjs`), baseline at `2f38c2e7b` and after Slice 1. Times vary by run;
select and parse counts are exact.

| Label | Baseline | After Slice 1 |
|---|---|---|
| `cold-500-plain-8-batches` | 205.54 ms, 480 selects, 4,849 parses | 215.16 ms, 480, 4,849 |
| `hit-500-plain-8-batches` | 13.8 ms, 200 selects, 8 parses, 500 hits | 14.6 ms, 200, 8, 500 |
| `after-variable-500-8-batches` | 159.82 ms, 480, 4,848 | 168 ms, 480, 4,848 |
| `after-stamp-500-8-batches` | 138.67 ms, 480, 4,848 | 148.49 ms, 480, 4,848 |
| `one-loadJobScope` | 2.32 ms, 35 selects, 605 parses | 2.69 ms, 35, 605 |
| `500-whole-chat-hydrations-local-model` | 2,094.15 ms, 1,000 selects, 250,500 parses | 2,480.51 ms, 1,000, 250,500 |
| `worker-warmup` | 139.22 ms | 153.84 ms |
| `500-targets-10-no-match-regex` | 1,044.6 ms, 500 regex tasks, 5,000 host parses | 1,071.54 ms, 500, 5,000 |
| `mixed-revision-cache` | after the save: cached, old text, same key | after the save: not cached, stored text, new key |
| `viewport-cross-client` | narrow client gets the `800` result, cached | narrow client gets `320`, not cached |
| `four-tiny-snapshots` | 45.86 MiB heap for 16 pending bytes | 45.83 MiB, 16 B |

Slice 1 notes: the probe memo became `chatCharacters` (group members and message speakers, by owner
and chat revisions); a missing speaker enters the key as `null`; other targets' sources stay out of
the shared key so a row's key does not depend on its batch. Known limit (challenger): a batch that
loaded revision R and is still waiting on its first target can still serve R-keyed hits to later
targets after a save; a request that arrives after the save misses. This follows D1 (store under
the loaded revision); Slice 2 re-renders the shown row.

Slice 6 (three runs each, low load; the `other-stage` row is a scratch variant of the probe with
ten `editinput`-only scripts):

| Label | Before | After Slice 6 |
|---|---|---|
| `500-targets-10-no-match-regex` | 1,036–1,049 ms, 500 regex tasks, 5,000 host parses | 293–351 ms, 500, 0 |
| `500-targets-10-other-stage-regex` | 253–269 ms, 500 regex tasks | 138–143 ms, 0 |
| `cold-500-plain-8-batches` | 199–204 ms | 198–205 ms |
| `four-tiny-snapshots` | 45.86 MiB | 45.86 MiB |

Slice 6 notes: "did not match" is tested as an unchanged result (`replaced === data`), so a match
that replaces with the same string also skips the parse; a skipped parse also skips the CBS budget
check. Two prompt-runner tests that observed stages through the first worker call gained a
never-matching `editprocess` script, since an `editinput`-only list no longer reaches the worker.

Slice 3 (the stock probe throws at `r.pending[0]` once no snapshot is kept; the after numbers come
from a copy guarded with `?.`, and later runs need the same guard):

| Label | Before | After Slice 3 |
|---|---|---|
| `four-tiny-snapshots` | 45.83 MiB, 4 snapshots, 16 B counted | no snapshot kept, all 4 targets fail raw; +0.12 MiB measured alone |
| `cold-500-plain-8-batches` | 206.02 ms, 480, 4,849 | 200.31 ms, 480, 4,849 |
| `hit-500-plain-8-batches` | 13.83 ms, 200, 8 | 15.92 ms, 200, 8 |

Charged against measured retained heap per snapshot (Node 24.21, four snapshots, three runs): no
scripts, 64 targets: 3.23 MB charged, 1.70 MB held; CBS calls, 64 targets: 3.23 / 2.80 MB; 10,000
defaults, 8 targets: 8.13 / 6.06 MB; 10,000 `scriptstate` entries, 8 targets: 5.98 / 3.79 MB. The
scope walk takes a median of 2.54 ms (p95 2.88 ms) over 2,000 messages (6.1 MB).

Slice 3 notes: per target the charge is a 48 KiB setup overhead, the text, the source when it
differs, 64 B per `scriptstate` entry plus changed variables, the character list copy, and 12× the
largest default-variable text (the last two beyond D8's list, after the challenger's measurement).
A scope over the budget fails every uncached target before its Lua runs and keeps no snapshot; a
single target over the budget fails alone, as before. Over-budget failures reuse the existing
error text. The 64 MiB global budget and the pin release paths are left to Slice 4 (D8's
shared-entry reference count); until then only the 4-per-client and 16-total counts bound the
total.

Slice 4 (three alternating runs against the Slice 3 tree; counts exact, times as ranges):

| Label | Before | After Slice 4 |
|---|---|---|
| `cold-500-plain-8-batches` | 203–211 ms, 480 selects, 4,849 parses | 177–182 ms, 425, 1,116 |
| `hit-500-plain-8-batches` | 13.5–14.4 ms, 200, 8 | 14.3–14.8 ms, 200, 8 |
| `after-variable-500-8-batches` | 153–155 ms, 480, 4,848 | 127–134 ms, 402, 1,093 |
| `after-stamp-500-8-batches` | 145–148 ms, 480, 4,848 | 139–144 ms, 400, 592 |
| `500-targets-10-no-match-regex` | 293–300 ms, 480, 4,848 | 273–274 ms, 400, 592 |
| `one-loadJobScope` | 35, 605 | 35, 605 (generation unchanged) |
| `four-tiny-snapshots` | no snapshot kept, 4 targets fail raw | 4 snapshots kept, 2 shared entries pinned, the 15.6 MiB chat charged once (16,898,012 B); +16.44 MiB measured alone |

About 74 parses per batch remain, from the per-request projection (`forwardPresetRoots` copies) and
the character reads. Time falls only 10–15 %: per-target runs dominate.

Slice 4 bounds: configuration cache 2 entries / 32 MiB (the plan gave no byte start), transcript
cache 8 entries / 64 MiB, global retained budget 64 MiB, 8 MiB per snapshot for request-owned bytes
only. Slice 4 notes: sizes use Slice 3's object walk (renamed `retainedBytes`) instead of UTF-8 row
lengths, since the store returns parsed data; the projection walk excludes the shared objects so
nothing is charged twice. Over the global budget the oldest waiting snapshots give way (this
client's first), then the target fails with the existing error; that loop can drop every waiting
snapshot when a running continuation holds the budget (accepted as rare). `loadRequestDb` now
delegates to a pure `buildRequestDb`; generation's reads are unchanged.

Slice 5 (three runs each):

| Label | Before | After Slice 5 |
|---|---|---|
| `after-stamp-500-8-batches` | 141–152 ms, 400 selects, 592 parses, 0 hits | 10.6–11.4 ms, 201, 9, 500 hits |
| `cold-500-plain-8-batches` | 178–185 ms, 425, 1,116 | 175–180 ms, 425, 1,116 |
| `after-variable-500-8-batches` | 129–133 ms, 402, 1,093 | 127–159 ms, 402, 1,093 |
| `500-targets-10-no-match-regex` | 271–279 ms, 400, 592 | 274–283 ms, 401, 593 |

Digest cost on a large character after a stamp (median of 30, one target, no scripts): 1 MiB
description 5.38 ms (miss and render) → 4.25 ms (one read and digest, then a hit), 0.31 ms on the
same revision; 4 MiB 17.9 → 15.7 ms, 0.33 ms. The challenger's 4.75 MB record with 10,000 lore
entries: 10.3 ms to read, 18.2 ms (p95 19.0) to stringify and hash.

Slice 5 notes: kinds dropped from the key, with reasons in `displayKinds.ts`: `providers`,
`loreBook`, `globalscript`, `hotkeys`, `characterOrder`, `authRefreshes`, `translatorPresets`,
`hypaV3Presets`, `togglePresets`, `credentials`, `statics` (four beyond D6's candidates; no display
path reads their fields). An unclassified kind stays keyed; the configuration cache key is not
narrowed. The digest is plain `JSON.stringify` (property order kept), because CBS `{{lorebook}}`
output depends on it (`shared/cbs/registry.ts:312`). The speaker memo is keyed by owner, chat and
chat revision and holds the owner's identity, so a membership change misses. The tab's plugin
handlers can still read `lastInteraction` through `getCharacter()` (D2, outside the guarantee).

Slice 2 notes: the install version also moves on job hydration, whole-chat collection installs
(two paths) and `installRead`, besides D4's three points; a job patch or hydration that re-delivers
the revision the tab already holds does not move it (a job's end sends its chat again; without
this a send transformed its reply twice). `applyRemoteChat` always moves it. The unacknowledged
flag counts pending, in-flight, quarantined, deferred and job-blocked work. The scheduler is
`src/lib/ChatScreens/settledRender.svelte.ts`. `e2e/serverTransform.spec.ts`'s send test allows the
new user row two renders (its mount, and once more when the reply's install lands during it).

## Verification

- Per slice: V1 (`pnpm check`, `pnpm --silent test:agent`, the affected `slow` and `e2e` sets,
  including `e2e/serverTransform.spec.ts` and `e2e/transformGolden.spec.ts` for Slices 1, 4, 6
  and 8), V6 (each new regression test shown failing once), V4 (`rg` each changed export),
  V8/V9 for new tests, prettier on changed files.
- Key tests assert which inputs change the key, not its bytes. Races use deferred latches and
  fake clocks (V3), not timing.
- The probe runs before Slice 1 and after Slices 3, 4, 5, 6 and 9; the numbers go into this plan.
- Device checks are reported as not run until the user runs them (V5).

## Later

A key narrowed by what each run read, so that a row that reads no history keeps its entry across
saves. Start it only if Slice 9 shows D1's misses cost too much. The review's requirements for it:

- Reads are recorded as a set of flags, not one class per function: `idleduration` reads history
  and the clock.
- The collector follows nested parses, wrapper hosts, the group evaluator's implicit speaker
  read, and direct pipeline work such as dynamic-asset matching and its embedding settings.
- Lua and plugin output count as reading everything unless they opt in.
- The key has a descriptor with a defined publication, widening and eviction contract.
- A render takes the union of its stages' dependencies.
- Admission inputs (context records and the existence of bound records) are never narrowed.

## Out of scope

- Omitting the source upload on a remount (a validate target without `source`): it needs its own
  admission path for a cold cache, and saves only the upload.
- Results delivered with the chat read, or pushed by the server.
- Inlay records and file existence for Lua `getCharacterImage`/`getPersonaImage`.
- Re-rendering rows on resize or rotation (they update on the next remount, as today).
- Skipping Lua edit triggers without a listener, and selected-record digests for collections
  (another preset's edit still re-renders, as today).
- TJ04, SD01 and other per-event generation work; the job protocol (F15, F16, TJ06).

## Review record

The Sol review of the first draft (2026-10-28) raised 21 points; all were taken. The first draft
keyed results by per-function read classes with a descriptor. The cheaper choices:

- **Correctness key** (R1, R2, R3, R6, R7, R14, R16): the conservative key D1 instead of read
  classes. The class design moved to **Later** with the review's requirements, and the plugin
  policy is D2, which the user confirmed (Q3).
- **Narrowing** (R4, R5, R8): only volatile character fields and unreachable kinds are narrowed
  (D6); admission kinds and `globalChatVariables` stay. Selected-record digests are out of scope.
- **Shared reads** (R9): D5 shares the raw reads and builds a fresh projection per request.
- **Dispatch** (R10, R11): the Lua filter is dropped. Regex gains a mode filter that keeps
  behavior, and the predicate covers `{#` and tags in any case.
- **Snapshots** (R12): D8 accounts conservatively, starting before D5 (Slice 3).
- **Refresh** (R13, R15): D4 drains the wait chat-wide and defines the version's bump points; its
  guarantee is limited to the server refresh.
- **Tab cache** (R17, R18): `same` only on an exact server hit, instead of a validate target
  without source, and lifecycle fences on insertion and confirmation.
- **Plan accuracy** (R19, R20, R21): slice dependencies and files are fixed, the Durable Drafts
  overlap is corrected, and the guarantee is qualified.
