# OOC Session Plan

Status: drafted 2026-11-14 at `d2d1a76a7` from the owner's brainstorm, then audited against the code at `05b4378da`
([report](../reports/audits/plan-runner/ooc-session-2026-11-14.md)) and corrected in the same commit as the report. D1
to D7 are the owner's answers of that day. D8 on are this plan's own; D14, D16, and D24 took their present form from
the audit, and D24 and the plugin limit in D14 are new choices the owner has not yet read. No slice has started.

Sources: the owner's brainstorm (2026-11-14: bring the BTW side thread of
[HaejeokRisuai A7](../reports/surveys/haejeok-feature-survey.md) here as an "OOC session"; its own toggle override; the
questions and answers are kept apart from the chat; a refresh drops the earlier exchanges from the context; the user can
attach chosen earlier exchanges to a question); `GenerationKind`, `GenerationContext`, and `GenerationPreviewResult` in
`shared/jobs.ts`; `parseCreateBody` in `server/src/routes/generations.ts`; `requestFingerprint`, `rebuildLocks`, and the
`chatBusy` gate in `server/src/jobs/generationJobs.ts`; `scopeHistoryMessages`, `scopeHistoryChat`, and
`rerollHistoryMessageId` in `server/src/jobs/jobScope.ts`; `chatView`, `characterView`, `getDatabase`, and
`getGlobalChatVar` in `server/src/jobs/cbsHost.ts`; `runOnCopy` in `server/src/jobs/runSetup.ts`; `historyNow`,
`runCurrentChatFunction`, and the `preview` return in `server/src/prompt/runner.ts`; `assemblePrompt`, its prompt-info
toggle read, `runStartTrigger`, and `writeMemory` in `server/src/prompt/assemble.ts`; `resolveGlobalChatVar` and
`toggleDefinitionsText` in `shared/prompt/toggles.ts`; `PRESET_DEFAULTS` and `PROMPT_PRESET_FIELDS` in
`shared/presets.ts`; `Chat`, `Message`, and `botPreset` in `shared/database.ts`; `CHAT_META_MERGE_KEYS` in
`shared/chats.ts`; `normalizeChatMeta` in `server/src/data/chats.ts`; `CHECKPOINT_CHAT_FIELDS` in
`shared/chatCheckpoints.ts`; `METATRON_CHAT_FIELDS` in `server/src/data/upstream/exportDatabase.ts`; `setChatMeta` and
`mergeChatMeta` in `src/ts/storage/chatStore.svelte.ts`; `previewChat` in `src/ts/process/index.svelte.ts`;
`requestChatData` in `src/ts/process/request/request.ts`; the copy in `SideChatList.svelte` and the branch in
`Chat.svelte`; `MessageSearch.svelte`, `ChatBody.svelte`, `Toggles.svelte`, `PromptSettings.svelte`, and the composer
menu of `DefaultChatScreen.svelte`, read at `d2d1a76a7`; the [chat pipeline](../structure/chat-pipeline.md) and
[server generation](../structure/server-generation.md) guides. The identifiers are the anchors. Re-verify each cited
location before editing (STRUCTURE.md protocol step 5).

## Goal

A chat has an OOC session: a side thread where the user asks about the chat and the model answers out of character,
without anything being added to the chat's messages.

- **A question.** It is sent with the prompt a send of the chat would get, with the chat's history cut at the segment's
  anchor message, the segment's earlier exchanges and the question after it, and the OOC toggle values laid over the
  chat's own. The answer streams into the panel and is stored in the chat's OOC log.
- **A segment.** Exchanges are grouped in segments. A segment is fixed to one message of the chat (its anchor). A
  follow-up question in the same segment carries the segment's earlier exchanges.
- **Refresh.** It starts a new segment anchored at the chat's newest message. The earlier exchanges stay in the log and
  are no longer sent.
- **Attach.** The user picks exchanges of earlier segments to send with a question. They stay part of the segment's
  context for its later questions.
- **OOC toggles.** A prompt preset holds the toggle values an OOC question forces (for most community presets: its "OOC
  mode" toggle on). A chat can replace that map with its own.

Not goals: asking while the chat is generating, and an answer that survives a page reload while it streams (D5);
reopening an earlier segment to ask in it again (D7); group chats (D23); tools in an OOC answer (D16); a built-in OOC
instruction for a preset without an OOC toggle (D22).

## Current State

- **Generation is a server job.** `GenerationKind` is `send`, `continue`, `reroll`, `group`, `preview`, `previewPrompt`,
  or `command`. A `preview` job assembles the prompt of the stored chat and returns it as the `done` result
  (`GenerationPreviewResult`: `messages`, `context`, `memoryBlock`). It appends nothing, does not include the composer's
  text, and makes no reply request.
- **A preview is not write-free.** `assemblePrompt` runs the start trigger for every kind, and `runOnCopy` applies the
  trigger's chat to the stored chat. `runCurrentChatFunction` writes a stored message whose CBS changed its text, and
  a regex script's `@@inject` writes the message it names. A CBS `setvar` queues a `scriptstate` write that the job's
  metadata flush stores. The HypaV2 and SupaMemory branches call `host.writeMemory`, the trim without a memory
  algorithm calls `host.setLastMemory`, and a job without the memory task service summarizes inside the job for every
  kind; such a request lists the job's tools and can store a tool-call record. `assemblePrompt` also runs
  `editRequest` before a preview returns; its Lua handler has safe access, so it can set chat variables and, through
  `patchCharacter`, the character's name, description, first message, and background embedding. Apart from the start
  trigger's result, the chat writes go through the bindings' `writeChat` or the job's metadata queue
  (`server/src/lua/bindings.ts`, `jobScope.ts`). A request made inside the job can also store media (an inlay a
  provider returns, an image a Lua getter draws). A tab plugin's script hook that assembly calls (`editprocess`) is
  sent the text, reads chats through the tab's store, and stores what it writes. Lore activation flags of a preview
  go to a per-job map (`previewLoreVars`), not to the chat.
- **Legacy memory needs its cursor in the history.** When the history exceeds the context limit, SupaMemory searches
  it for the first message its stored summary does not cover, and legacy Hypa for the cursor of any of its
  snapshots; each returns "chat ID not found" when none is there. HypaV2 drops summaries
  whose sources are outside the given history; HypaV3 does so unless `preserveOrphanedMemory` is set; Structured
  Memory reads the chat's current pages and threads whatever the history.
- **Admission.** Every admitted job takes the chat's slot (`chatSlots`), previews included, and a create on a busy chat
  is refused with `chatBusy`. `rebuildLocks` exempts the two preview kinds from the memory-rebuild refusal.
- **The job's chat.** A job reads its chat from its scope (`scopeChat` in `jobScope.ts`), a copy that `refreshChat`
  replaces from the store whenever the stored revision moved. Every reader takes it from there: the history
  (`scopeHistoryMessages`, `scopeHistoryChat`), the cached `chatView`, `characterView`, and `getDatabase` of
  `cbsHost.ts`, the Lua bindings, lore, memory, and the context report. A reroll lays a view over it that hides its
  carrier message (`scope.rerollHistoryMessageId`). There is no pure function that applies a chat op to a chat value:
  the store applies ops to its rows, and the scope adopts the committed change.
- **Where toggles are read.** `getGlobalChatVar` in `cbsHost.ts` reads `chatOf(ref)?.GLGlobalVariables` (CBS,
  `getglobalvar`, `#when` toggle conditions, Lua, regex scripts' CBS). `assemblePrompt` reads
  `host.chat().GLGlobalVariables` for the prompt-info record. Both resolve through `resolveGlobalChatVar`. There is no
  single getter. The display transform (`server/src/prompt/transform.ts`) is a request of its own over the stored
  chat, not part of a preview.
- **The request body.** `parseCreateBody` rebuilds `context` from a fixed property list, so an unknown field is dropped.
  `requestFingerprint` hashes the kind, the chat, the command, the input, and the three message ids. On the tab,
  `ServerJobRequest.context` in `src/ts/process/serverCommands.ts` is a fixed `Pick` of context fields, `runServerJob`
  returns the job's terminal, and `previewChat` keeps only the result's `messages`. A terminal read from a kept
  outcome or a receipt carries no `done` result. A job's error end raises the tab's global alert unless the caller
  took it over, as a send with `stopOverLoreBudget` takes a `loreOverBudget` end (`loreStopCaller`).
- **The tab can request a reply itself.** `requestChatData` takes `formated: OpenAIChat[]`, a model mode, `useStreaming`,
  a `chatRef`, and an abort signal. A request with a `chatRef` runs on that chat's bound presets (a preview's
  `presetChain` pick does not reach it). `bias` is required. Without `tools` it lists the chat's tools, runs the
  calls the model makes, and stores their records in the chat. Its result is a stream of cumulative snapshots, a
  buffered success, a `multiline` list, or a failure; whether it streams depends on the provider's setting. It is not
  a job: it holds no chat slot, runs no `request` trigger, and cannot be followed again after a reload.
- **Chat metadata.** A chat is stored as one metadata JSON value plus one row per message. A `meta` op sends the changed
  top-level fields whole; `mergeChatMeta` sends single entries of a map field named in `CHAT_META_MERGE_KEYS`
  (`toolCalls`, `GLGlobalVariables`, `scriptstate`, `bookmarkNames`), and another device's entries are kept.
  `normalizeChatMeta` copies every field that is not forbidden and validates `toolCalls` (1 MiB per entry). A field that
  is not a list field stays out of chat summaries. The server rewrites the whole metadata value on each write.
- **Prompt preset fields.** A field added to `PRESET_DEFAULTS` is normalized, exported and imported in `.risup`, copied
  with the preset, and forwarded into the job database under its root name (`FORWARDED_PRESET_KEYS`). A field outside
  the list is dropped by `normalizePreset`. A `.risup` import always creates a new preset with a new id.
- **Copy, branch, import.** The chat copy in `SideChatList.svelte` spreads the source and deletes `pinned` only. The
  branch in `Chat.svelte` spreads the source, cuts the messages after its target, and deletes `pinned`. Both keep
  message ids. The local chat import (`addChats` in `src/ts/characters.ts`) keeps unknown metadata and valid message
  ids. There is no shared list of fields a branch or an import drops.
- **Checkpoints.** `CHECKPOINT_CHAT_FIELDS` is exhaustive over `ChatMeta`: a new chat field needs `capture`, `keep`, or
  `split`.
- **Toggle UI.** `Toggles.svelte` reads and writes the chat's map by `chatRef`; it has no prop for another value map.
  The preset editor edits `customPromptTemplateToggle` in `PromptSettings.svelte`.
- **Panels.** `MessageSearch.svelte` is mounted by `App.svelte` once data is loaded and renders only while its open
  flag is set, so its input, list, and state are kept across closes. `Chat.svelte` without `messageId` still renders
  index-gated edit and delete controls; without a message id they write nothing. `ChatBody.svelte` does the Markdown
  and CBS display work. It has no chat prop (it renders in the selected chat's display context), and its `idx`
  defaults to 0, the chat's first message; `idx={-1}` makes the row a text target of its own.
- **No OOC notion.** The source has no OOC toggle convention, message marker, or command.

## Rules For Every Slice

One slice is one session and one commit. Slices marked _hard_ use `opus-workflow`; the others use `opus-lite`.

- **Checks.** The slice's tests (under "Test"), then `pnpm check`, the focused files through the wrapper while
  iterating, `pnpm --silent test:agent` once whole after the last source edit, `pnpm format:check`, `pnpm check:docs`
  for a guide edit, and `pnpm check:tests` for an added test file. Run `pnpm check` again after the last test edit. V4
  (`rg` each changed export and wire field) and V6 (each new test shown failing once with its guarded line broken).
- **Names.** Suggested, final once slice 1 lands: the chat fields `oocLog`, `oocSegment`, and `oocToggles`; the preset
  field `oocToggles`; the module `shared/ooc.ts`. Final once slice 2 lands: the request field `context.oocExchangeId`
  and the failure codes `oocExchangeGone`, `oocAnchorGone`, and `oocMemoryAhead`.
- **Absent means today.** A job without `oocExchangeId` runs exactly as at `d2d1a76a7`. A chat without the three fields
  and a preset with an empty `oocToggles` behave as today. Slice 2 has a test for the first.
- **The server side of an OOC preview never writes the stored chat or character.** The job's chat is detached (slice 2,
  D14): no message, variable, memory field, or tool-call record of the stored chat changes, and no character field.
  The chat writes of an OOC question are the tab's `oocLog` and `oocSegment`. Two things stay as in any preview: media
  a request inside the job materializes is stored, and a tab plugin's hook reads and writes through the tab's store
  (D14). No slice adds a path that appends, edits, or removes a row of `chat.message` for a question or its answer.
- **A tab or server from before a slice.** An older server drops the request field in `parseCreateBody` and runs a
  plain preview, with the writes any preview makes today; the tab therefore checks the result's echo (slice 2) before
  it requests an answer. An older tab never sends the field and leaves the stored fields alone (a `meta` op names its
  fields).
- **Strings.** New text goes in `src/lang/en.ts` with its Korean in `src/lang/ko.ts` in the same slice. The user-facing
  name is "OOC session" (Korean: "OOC 세션"); "refresh" is "최신화".
- **Guide.** Each slice names its guides; their `Invariants` apply, and the slice updates the sections and module
  comments that name a changed contract. Comments and test titles describe behavior, not this plan (STRUCTURE.md T5).
- **Manual checks.** Each slice lists the checks it cannot run. The slice report gives them to the owner as a
  checklist; what is still unrun when the plan closes moves to [manual checks](../backlog/manual-checks.md) under this
  plan's name.

## Order

Serial: 1 → 2 → 3 → 4 → 5. Slice 2 reads slice 1's fields; slice 3 uses slice 2's request field; slices 4 and 5 are the
screens over slice 3's module.

If the run stops after slice 3, nothing a user can reach changes. After slice 4 the session works with questions sent
as typed. Slice 5 adds the toggle settings.

## Slice 1. The stored fields and their policies (`chat-store.md`, `persistence.md`, `settings-i18n.md`)

**Change.**

- `shared/ooc.ts` (new): the types, limits, and pure functions both runtimes use.
  - `OocExchange`: `{ id, segment, anchorMessageId: string | null, question, answer?, time, attached?: string[] }`.
    `anchorMessageId` is the segment's anchor, repeated on each exchange; null means the chat had no stored message.
  - `OocSegment`: `{ id, anchorMessageId: string | null }`, the chat's current segment.
  - `MAX_OOC_EXCHANGE_BYTES` (suggested 256 KiB as serialized JSON) and `MAX_OOC_EXCHANGES` (suggested 200).
  - `oocTail(log, exchangeId)`: the rows a question is sent with, as `{ id, role, data }[]` (D15). For the exchange's
    segment in time order up to the exchange: each exchange's attached exchanges that still exist, have an answer, and
    were not already placed (question row, answer row), then its own question row and, when it has one, its answer row.
    An earlier exchange of the segment without an answer is left out.
  - `oocToggleValues(chatMap, presetMap)`: the forced values, as `toggle_<key>` entries. A chat map that is present
    replaces the preset's whole map (D12).
  - `oocPrune(log, currentSegment, keep)`: the ids to remove so that one more exchange fits `MAX_OOC_EXCHANGES`,
    oldest first. It never names an exchange of the current segment, one the current segment's exchanges have
    attached, or one in `keep` (the next question's picks). It reports when nothing can be removed.
  - Validators for the three chat fields.
- `shared/database.ts`: `Chat` gains `oocLog?: { [id: string]: OocExchange }`, `oocSegment?: OocSegment`, and
  `oocToggles?: Record<string, string>` (bare toggle keys, as a toggle preset's `values`). `botPreset` and the flat
  `Database` root gain `oocToggles`.
- `shared/chats.ts`: `oocLog` joins `CHAT_META_MERGE_KEYS`.
- `server/src/data/chats.ts`: `normalizeChatMeta` validates the three fields with the shared validators and refuses an
  oversized exchange and a log over the count limit, as it refuses an oversized `toolCalls` entry.
- `shared/presets.ts`: `PRESET_DEFAULTS` gains `oocToggles: {}`. The preset normalizer checks the top-level kind only,
  so the reader (`oocToggleValues`) ignores a non-string value.
- `shared/chatCheckpoints.ts`: the three fields are `keep` (D17).
- `server/src/data/upstream/exportDatabase.ts`: the three fields join `METATRON_CHAT_FIELDS`.
- The branch in `Chat.svelte` deletes `oocLog` and `oocSegment` and keeps `oocToggles` (D6). The copy changes nothing:
  it keeps all three.

**Test.** `oocTail` (order, attachments placed once, a deleted attachment skipped, an unanswered earlier exchange left
out); `oocToggleValues` (preset alone, chat replaces, an empty chat map forces nothing); `oocPrune` (oldest first, an
attached or picked exchange kept, nothing removable reported); the normalizer's
refusals; a merge of one `oocLog` entry keeping another device's entry; the preset field surviving `normalizePreset` and
a `.risup` round trip; a checkpoint load leaving the log as it is; the branch dropping the log.

**Guide.** `chat-store.md` (the merge key), `persistence.md` (the chat fields, the checkpoint choice),
`settings-i18n.md` (the preset field).

**Manual checks.** None: nothing a user can reach changes.

## Slice 2. The OOC preview job (_hard_, `server-generation.md`, `chat-pipeline.md`)

**Change.**

- `shared/jobs.ts`: `GenerationContext` gains optional `oocExchangeId`. `GENERATION_ERROR_CODES` gains
  `oocExchangeGone`, `oocAnchorGone`, and `oocMemoryAhead`. `GenerationPreviewResult` gains optional `ooc: true`, set
  when the job ran as an OOC preview.
- `parseCreateBody`: `oocExchangeId` absent or an id; kept only for the `preview` kind, refused for any other.
- `requestFingerprint` includes `oocExchangeId` when present (D11).
- `server/src/jobs/jobScope.ts`: a scope can be detached (suggested `scope.detached`). Its chat is then a copy the job
  owns: `refreshChat` leaves it as it is, the metadata queue applies a `setvar` or a note to it and registers no
  flush, and nothing puts the stored chat back into the scope before the job ends. Every flush and terminal path of
  the job stores nothing for a detached scope.
- A pure reducer of chat ops (new, beside the scope) for the ops an OOC preview can reach: `setText`, `meta`, and the
  message ops of the Lua chat setters. An op it does not cover is dropped with a warning.
- `server/src/lua/bindings.ts`: for a detached scope `writeChat` applies its ops to the copy through the reducer and
  calls no `job.write`. The reducer's result replaces the chat object and the owner's chat list, as a stored write's
  adoption does, so the caches keyed on them (the `cbsHost.ts` views, the history list) are dropped. `patchCharacter`
  answers false, as for a character that is gone. Every chat write an OOC preview can reach goes through `writeChat`
  or the metadata queue: `runCurrentChatFunction`, `@@inject`, the variable setters, `writeMemory`, `setLastMemory`,
  the Lua chat setters of an `editRequest` handler, and a tool-call record.
- `server/src/prompt/runner.ts`, for a preview with `oocExchangeId`:
  - Before assembly it reads the exchange from the stored chat. A missing exchange ends the job with `oocExchangeGone`.
    An anchor id that names no stored message ends it with `oocAnchorGone`.
  - After a `presetChain` pick has swapped the scope and before assembly, it detaches the scope and sets the copy:
    the messages after the anchor are removed (all of them for a null anchor); the rows of `oocTail` are appended
    (question rows `user`, answer rows `char`, each with a unique, valid `Message.chatId` that names no stored
    message); and the values of `oocToggleValues`, over the chat's `oocToggles` and the job database's `oocToggles`
    root (the job's preset, a `presetChain` pick included), are laid over the copy's `GLGlobalVariables`. Every
    reader on the server then gets the cut history, the tail, and the forced toggles from the scope as it gets any
    chat; the readers themselves do not change. A tab plugin's hook is outside it (D14).
  - It runs no start trigger (D13): the host's `runStartTrigger` answers null.
  - The memory step's own requests (a summary made inside the job) are made with no tool set (`toolSet: null`).
  - `editRequest` runs as in any preview, on the detached chat (D16).
  - Assembly is told the job is an OOC one (a field of its input or host).
- `server/src/prompt/memory/supaMemory.ts` and `server/src/prompt/assemble.ts`: the two "chat ID not found" returns are
  marked, and for an OOC job assembly ends with a coded alert, `oocMemoryAhead`, instead of the plain memory error
  (D24).
- The runner ends a group chat's OOC preview with a plain error before assembly (D23).

**Test.** A preview without the field returns what it returned before (the same messages for a fixture chat). With the
field, on a fixture whose template ends with the history: the returned messages end with the tail rows in order and hold
no stored message after the anchor; a toggle the preset forces changes a `#when` toggle branch and `getglobalvar` in the
prompt while the stored `GLGlobalVariables` is unchanged; the chat's own `oocToggles` replaces the preset's. The stored
chat is byte-equal after each of: a start trigger that would edit the chat; a stored message before the anchor whose CBS
gives another text under the forced toggle (the returned prompt holds the new text); an `@@inject` script naming a
stored message; a `setvar` in the template (a later `getvar` of the same assembly reads it); the trim that sets
`lastMemory`; a SupaMemory or HypaV2 chat; a taskless HypaV3 chat, whose checkpoint finds its write on the copy; an
assembly that fails after those ran. After a stored write by another writer during the job, the store holds that write
and nothing of the preview, and the returned prompt is still the copy's. An `editRequest` handler's edit is in the
returned messages and its `setDescription` leaves the stored character unchanged. A SupaMemory chat over the context
limit with no usable cursor in the cut history ends with `oocMemoryAhead`. A missing exchange and a missing anchor end
with their codes; the field on a `send` is refused; the fingerprint differs by exchange id.

**Guide.** `server-generation.md`: Prompt job execution (the detached scope, what an OOC preview skips) and the failure
codes.
`chat-pipeline.md`: Not in `sendChat`.

**Manual checks.** None: no caller sets the field yet.

## Slice 3. The tab's OOC module (_hard_, `chat-pipeline.md`, `chat-store.md`)

**Change.** A new module (suggested `src/ts/ooc/oocSession.svelte.ts`) owns every OOC action of the tab. Its state is
per chat and in memory: the streaming answer text, the busy flag, the last error, and the attachments picked for the
next question. In `src/ts/process/serverCommands.ts`, `ServerJobRequest.context` gains `oocExchangeId`, and a request
can name error codes its caller shows itself: they are registered before the job is followed, and an end with one of
them raises no global alert in `reportEnd` (the `loreStopCaller` mark covers only a `loreOverBudget` end with its
payload). A job found again by an earlier lifecycle or after a reload keeps its alert.

- The guards, shared by `askOoc` and `retryOoc`: not a group chat; no local send or followed job on the chat
  (`isChatBusy`); no OOC question in flight for the chat; a current segment whose anchor is null or names a stored
  message. A non-null anchor that names no message refuses with the "refresh" notice and is never replaced without the
  user's refresh (D10).
- `askOoc(ref, question)`:
  1. Keeps the chat loaded (`pinChat`) from here to the last write of step 6, and checks the guards. A chat without
     `oocSegment` gets a first segment at the newest message (null for a chat without messages).
  2. Prunes with `oocPrune`, protecting the picked attachments, then merges the new exchange (question, segment,
     anchor, picked attachments) into `oocLog` with `mergeChatMeta`. When nothing can be pruned, it refuses and tells
     the user to refresh or delete exchanges.
  3. Runs a `preview` job with `oocExchangeId` through `runServerJob`, which flushes pending writes first, and reads
     the terminal's result and error code. A well-formed preview result without `ooc: true` is an older server: the
     question fails with a message. A terminal without a usable result (a `followed` outcome, a kept outcome, a
     refusal) is a failed preview. In both cases no request is made and the exchange stays without an answer. An end
     with one of the three OOC codes is the module's to show (it names them in the request): it raises no global
     alert and reaches the panel as the question's error. Any other job error keeps its alert.
  4. Calls `requestChatData` with the result's `messages` as `formated`, the `chatRef`, `bias: {}`, `tools: []`,
     `noMultiGen: true`, `useStreaming: true`, and its own abort signal, in model mode.
  5. Reads the response whatever its type: the snapshots of a stream go to the module's state; a buffered success is
     the answer at once; a `multiline` result is joined in order; a returned failure, a thrown error, and a stream
     that fails midway are the question's error.
  6. On a complete answer it checks that the question was not stopped and that the exchange still exists, then merges
     the answer into the exchange. On a failure or a stop the exchange stays without an answer and the state holds the
     error.
- `retryOoc(ref, exchangeId)`: the guards, then steps 3 to 6, for an exchange of the current segment without an
  answer. Each retry is a new request.
- `stopOoc(ref)`: aborts the request and cancels the stream's reader; a preview job still running is stopped through
  the job's own stop.
- `refreshOoc(ref)`: sets `oocSegment` to a new id and the chat's newest message id (null for a chat without messages).
- `deleteOocExchange(ref, id)` and `clearOocLog(ref)` (every exchange outside the current segment): `mergeChatMeta`
  removals. Deleting the exchange in flight stops it first.
- Readers for the panel: the segments in order with their exchanges, the count of chat messages after the current
  anchor, and whether the anchor still exists.

Two devices writing the same exchange stay last-writer-wins, as any merge-key entry.

**Test.** The order of the steps with the job and the request mocked: the exchange is stored before the job is created;
a `chatBusy` refusal leaves the exchange without an answer and reports it; an older server's result and a terminal
without a result make no request; an `oocMemoryAhead` end raises no global alert and is the question's error; the
request is made with `tools: []` and `bias: {}`; a stream's snapshots reach the state and its end stores the answer
once; a buffered success stores the answer; a stream that fails midway stores none and reports; a stop stores no answer;
an exchange deleted mid-answer is not recreated; a retry reuses the exchange id, runs the guards, and is refused for an
earlier segment; a gone anchor refuses without moving the segment; a refresh moves the anchor and later questions carry
no earlier exchange; an attachment is recorded on the exchange; the prune removes the oldest exchange of an earlier
segment and never a picked one; a chat switched away mid-answer still gets its answer stored on the captured `ref`.

**Guide.** `chat-pipeline.md`: a new "OOC session" flow and the module under Files. `chat-store.md`: the callers of the
merge key.

**Manual checks.** None: no screen calls the module yet.

## Slice 4. The panel (`ui-theming.md`, `chat-pipeline.md`)

**Change.**

- `src/lib/Others/OocPanel.svelte` (suggested), following `MessageSearch.svelte`'s lifecycle: `App.svelte` mounts it
  once data is loaded, it renders only while its open flag is set, and Escape yields to dialogs. On a wide screen it
  is a column at the right edge without a dimmed backdrop, so the chat stays readable; on a narrow screen it fills the
  viewport (D19). It shows the selected chat's session and follows a chat switch.
- The panel shows the segments in order. Earlier segments are collapsed under a heading with their exchange count; the
  current segment is open. An exchange is a question row and an answer row rendered through `ChatBody.svelte` in a row
  of the panel's own, not `Chat.svelte` (D20), with the chat's character, the row's text and role, and `idx={-1}`. The
  answer row shows the streaming text while the module holds it, parsed as a stored answer is (no raw streaming
  mode), so display scripts run on it.
- Per exchange: copy the answer, delete, and for an exchange of an earlier segment an "attach" toggle that adds it to
  the next question. An exchange of the current segment without an answer shows the error and "retry"; one of an
  earlier segment shows only that it has no answer.
- The composer: a text area, send, and stop while an answer streams. The picked attachments show as removable chips
  above it. Send is disabled with a short reason while the chat is generating.
- The header: the refresh button with the count of chat messages after the anchor ("12 new messages since this segment
  began"); a notice instead when the anchor is gone or a question ended with `oocMemoryAhead`; "clear earlier
  segments"; close.
- The entry: an item in the composer menu of `DefaultChatScreen.svelte`, beside the memory item, hidden for a group
  chat.
- Strings in `en.ts` and `ko.ts`.

**Test.** A component test of the panel over a mocked module: the current segment open and earlier ones collapsed; the
streaming text shown in the newest answer row; attach toggles feeding the chips; send disabled while the chat is busy;
the refresh count; the retry row in the current segment only.

**Guide.** `ui-theming.md`: the panel under the App-mounted panels. `chat-pipeline.md`: the entry.

**Manual checks.** Ask, follow up, refresh, and attach on a real model with a community preset; the panel beside the
chat on a wide screen and over it on a phone; the answer's Markdown, code blocks, and display scripts; a send in the
main chat while an OOC answer streams; a second device showing the stored exchange after the answer ends.

## Slice 5. The OOC toggle settings (`settings-i18n.md`, `ui-theming.md`)

**Change.**

- A value editor for a forced-toggle map (suggested `OocToggleEditor.svelte`): for each value toggle of a definitions
  text, "as in the chat" or a forced value, with the control of the toggle's kind. It reads and writes a plain map
  through props, so it serves both places below. Keys the definitions no longer hold are listed as stale and can be
  removed.
- `PromptSettings.svelte`: the editor for the preset's `oocToggles`, under the toggle definitions text area.
- The panel: a settings popover with "use this chat's own OOC toggles". Turning it on copies the preset's map into
  `Chat.oocToggles`; turning it off unsets the field.
- A suggestion: when neither map forces anything and a defined toggle's key or label contains `ooc` (any case), the
  panel offers once per preset to force it on in the preset. Nothing is forced without the user's click.

**Test.** The editor's read and write of a map for each toggle kind and its stale list; the chat switch copying and
unsetting; the suggestion shown only when nothing is forced and a matching toggle exists.

**Guide.** `settings-i18n.md`: the preset editor. `ui-theming.md`: the popover.

**Manual checks.** With a community preset that has an OOC toggle: the suggestion, an answer that is out of character
with the toggle forced, and the chat's own map winning over the preset's.

## Decisions

- **D1 (owner).** The feature is named "OOC session". It is a side thread: its questions and answers are kept apart
  from the chat's messages.
- **D2 (owner).** In one segment a follow-up carries the earlier exchanges. They leave the context only when the user
  refreshes after the chat moved on.
- **D3 (owner).** The user can attach chosen earlier exchanges to a question.
- **D4 (owner).** The OOC toggle values are a default on the prompt preset, which a chat can override.
- **D5 (owner).** The first version may refuse a question while the chat generates and may lose an answer that was
  streaming when the page reloaded. Usefulness is measured first.
- **D6 (owner).** A chat copy keeps the OOC log. A branch drops it.
- **D7 (owner).** Several sessions per chat only if that is cheap. Here the stored shape is a list of segments from the
  start; asking is limited to the newest one. Reopening an earlier segment is left out.
- **D8.** The log lives in the chat's metadata. Delete, backup, the feed, and the copy then need no code. A linked
  hidden chat would need a discriminator and a filter at about 18 list, search, plugin, and export boundaries; tables
  of their own would repeat most of Structured Memory's files (over 30 under its server and panel folders). Both
  counts are estimates.
- **D9.** `oocLog` is a merge-key map of exchanges, so a write names only the changed exchanges and two devices do not
  replace each other's entries. The feed delivers such a change as the whole metadata, an entry delta, or a refetch
  manifest by its existing size limits, and storage rewrites the metadata value. The current segment is a small field
  of its own, so a refresh with no question yet survives a reload.
- **D10.** A segment's anchor is a message id, not a count: deleting or rerolling earlier messages does not move it.
  When the anchor message is gone, the segment cannot be asked in and the panel asks for a refresh; the tab never
  moves a segment by itself. A chat with no segment yet gets its first one at the first question.
- **D11.** The request names the exchange by id and the job reads it from the stored chat. The tab sends no rows and no
  toggle map, so the server validates one id. The id is part of the request fingerprint: two exchanges are two
  requests.
- **D12.** The server resolves the forced toggles from the job's preset and the chat. A chat map replaces the preset's
  map whole: a per-key merge could not express "do not force this key in this chat".
- **D13.** An OOC job runs no start trigger. `runOnCopy` would apply a chat computed from the cut copy to the stored
  chat. Prompt effects of a start trigger are therefore missing from an OOC question.
- **D14.** An OOC job's scope is detached. The cut history, the tail, and the forced toggles are set on the job's own
  copy of the chat, so no reader needs a view of its own, and what the job then computes is applied to that copy and
  never stored: message text (`runCurrentChatFunction`, `@@inject`), variables, `lastMemory`, memory data (a legacy
  summarizer would otherwise store a summary that includes OOC rows), and tool-call records. The job reads its own
  writes back, which the algorithms that check a write need. A character setter of an `editRequest` handler fails as
  for a missing character. A summarizer may still make its own requests to shape the prompt, without tools, and
  repeats them on the next question. Media such a request materializes is stored as in any preview. A tab plugin's
  hook called during assembly is outside the detached scope: it is sent the hook's text, but its own chat reads see
  the stored chat (messages after the anchor, the chat's own toggles) and its writes are stored, as in any preview.
  Skipping plugin hooks would instead drop their effect on the prompt.
- **D15.** Tail rows carry unique, valid message ids that name no stored message, so every reader of the history
  (lore, memory selection, the context report) takes them as messages. They are not what keeps the stored chat
  unwritten: the rows before the anchor keep their real ids, and D14 covers them.
- **D16.** The answer is a tab request (`requestChatData`), not a job: it needs no new job kind, stream event, or
  server-side store path. It is made without tools and without the assembly's logit bias, and it runs no `request`
  trigger and no output scripts. `editRequest` has already run in the preview. The request runs on the chat's bound
  presets and reads the stored chat: for a chat with a preset chain, the sampling settings can be those of another
  preset than the one the prompt was assembled with, and CBS the request itself parses (a JSON schema, stop strings)
  sees the chat's own toggle values. Plugin replacers run as for any tab request. Display scripts run when the row
  renders.
- **D17.** A checkpoint load keeps the log and the settings as they are: the log is a record beside the chat, not part
  of its story state. An anchor the load removed falls under D10. The upstream export strips the three fields. The
  local chat export and import keep them, as they keep `toolCalls` and bookmarks; a shared chat file therefore carries
  its OOC log.
- **D18.** An exchange is capped in bytes and the log in entries. The tab prunes the oldest exchanges of earlier
  segments before adding one, never one the current segment has attached or the next question picks; the server
  refuses a write over either limit. The user's own delete can still remove an attached exchange, which then leaves
  the context.
- **D19.** The panel is App-mounted. It sits beside the chat on a wide screen because the user reads the chat while
  asking; it is not a split pane with a chat of its own.
- **D20.** Rows render through `ChatBody.svelte` in a row of the panel's own, with `idx={-1}` so a row is never taken
  for the chat's first message. `Chat.svelte` would bring the transcript's controls (edit, delete, reroll, branch),
  none of which applies to an OOC row.
- **D21.** One entry: the composer menu. A per-message "ask about this message", a `/ooc` command, and a hotkey are
  left out.
- **D22.** With no forced toggle the question is sent as typed. A preset without an OOC toggle gets no built-in
  instruction.
- **D23.** Group chats are left out: a preview stops after its first speaker, so an OOC question would be answered
  with whichever speaker comes first.
- **D24.** The anchor cuts the message list, not the memory. An OOC question gets the chat's current memory:
  Structured Memory's pages and threads and HypaV3's kept summaries may describe messages after the anchor. When
  SupaMemory or legacy Hypa needs its stored memory and finds no usable cursor in the cut history, the question ends
  with `oocMemoryAhead` and the panel asks for a refresh, after which the segment's exchanges can be attached. These
  two may otherwise answer without loading memory (a history under the context limit) or from an older snapshot.

## Not In This Plan

- **A job of its own.** An `ooc` generation kind with server-side streaming and storage would allow an answer to
  survive a reload and show on another device while it streams. Revisit after the first version's use is known (D5).
- **Asking while the chat generates.** It needs a job outside the chat slot, or a prompt assembled without a job.
- **Reopening an earlier segment** (D7), **a per-message entry, `/ooc`, and a hotkey** (D21), **group chats** (D23).
- **Sending an exchange back to the chat**: one-shot steering of the next reply, or adding to the author's note.
- **Tools in an OOC answer**, Structured Memory's page tools included (D16).
- **A summary of a segment** made by an auxiliary model at refresh.
- **Excluding OOC-marked messages inside the chat from memory**, RisuBard's separate feature
  ([picks](../reports/surveys/pocketrisu-risubard-picks.md)).
