# Slice: Post-Generation And Plugin Callbacks

Status: implemented on 2026-10-03 as two commits: 11a (the reply tail) and 11b (provider plugins,
stored tool calls, `/multisend`). The sections from "Scope" to "Residual risk" are the plan as drafted; the
amendments in `implementation-plan.md` win over them, and "11a: what landed" and "11b: what
landed" record what was built.

Phase: [Phase 5](../../phase-5-server-side-processing.md), step 9 (post-generation effects) and
the plugin, `chatOutput`, and provider-plugin parts of step 7; PLAN.md Decision 4 (the reply
persists at stream end, after the output trigger, and after inlays; the final write holds the
`editoutput` result; both orders kept) and Decision 5 (callbacks, the hybrid provider step).

Depends on: `prompt-assembly`, `job-channel`, `trigger-runtime`; `memory-on-server` only for the
embedding emotion mode.

## Scope

Allowed files: `server/src/prompt/runner.ts` (the tail), `server/src/prompt/postProcess.ts`
(new), `server/src/llm/**` (the callback seams: replacers, interceptor, `plugin` provider marker),
`server/src/data/chatStore.ts` and `shared/chats.ts` (the `toolCalls` chat field; a `meta` key),
`src/ts/network/jobChannel.ts` (the `provider`, `generateImage`, and `chatOutput` callbacks),
`src/ts/process/inlayScreen.ts` and `src/ts/process/files/inlays.ts` only if the callback needs a
new entry, `src/ts/process/mcp/mcp.ts` (`encodeToolCall`/`decodeToolCall` read the chat field).
Tests belong to the review step.

Identifiers (verified 2026-09-30): the streaming tail in `index.svelte.ts` (2082-2112:
`checkpointGeneration`, `addRerolls`, `runCurrentChatFunction`, the output trigger applied with
the generation id, `resendChat`, `runInlayScreen` and its promise, `runChatOutputListeners`,
`sayTTS`); the non-streaming tail (2125-2210: `editoutput` per result, `runInlayScreen` before the
append, the append with `generationInfo`, `sayTTS`, `runCurrentChatFunction`, the output trigger,
the listeners); auto-continue (2214-2238, no bound); `igp` (2245-2258: `requestChatData(..., 'emotion')`
on `igpPrompt`, appended to the reply with `writeText`, after auto-continue and before stage 4);
the trigger resend (2270-2288: `writeReplyGenerationInfo` then `endScopeGeneration` then
`sendChat`); notifications (2291-2303); the emotion tail (2305-2500: `req.special.emotion`
matches and sets `CharEmotion`; `emotionProcesser === "embedding"` uses `HypaProcesser`
2347-2384; the `submodel` mode calls `requestChatData(..., 'emotion')` 2442-2451 and sets
`CharEmotion` 2475-2500); `viewScreen === "imggen"` (2510-2526: `stableDiff`, client-side image
generation); `writeReplyGenerationInfo` (2539) then the outer `finally`'s `endScopeGeneration`
queues the final `setText`. `runInlayScreen` (`inlayScreen.ts:7-51`), `writeInlayImage`
(`inlays.ts:273-329`, canvas). Plugin positions: `replacerbeforeRequest` before the request
trigger and `replacerafterRequest` after (`request.ts:254-309`), `pluginHooks.editoutput` between
Lua and CBS (`scripts.ts:163-170`), `chatOutput` through `runChatOutputListeners`
(`index.svelte.ts:79-100`), `pluginHooks.providers` through `requestPlugin` (`request.ts:892-936`).
Tool calls: `encodeToolCall` stores `{ call, response }` in LocalForage `mcp-tool-calls` under the
call id and returns the marker `<tool_call>${id}${name}</tool_call>` inserted in the reply
(`mcp.ts:258-295`); `decodeToolCall` is called when building later requests by
`openAI/requests.ts:40-115`, `responses.ts:38-76`, `google.ts:137-246`, `anthropic.ts:281-369`.
Fence: `admitGeneration` ignores writes after `final` (`chatStore.ts:486-504`).

Stopping condition: a tail effect whose order cannot be kept for both paths, or a plugin callback
position the request layer's port cannot expose; recorded and reported.

## Assumptions

- The channel provides `callback` envelopes with the barrier; `prompt-assembly` provides the
  runner with raw checkpoints; `lua-bindings-and-buttons` settled the `generateImage` callback.
- Chats are diffed (Phase 2 `applyChatResult`); a plugin `setCharacter` replaces the
  character's own fields whole (Phase 4 `plugin-host-setters`: `replaceCharacterFields(chaId, fields)`
  then `reconcileCharacterChats`), so a `chatOutput` listener's chat writes reach the server as
  by-id ops and its character writes as whole-record writes of that character.

## Proposed decisions

- Persistence sequence, streaming (proposed): stream end → checkpoint (raw, fence open) →
  `editoutput` on the completed text (regex, Lua, plugin callback if listed) → checkpoint →
  `runCurrentChatFunction` → output trigger (its changes applied with the job token; a trigger
  that removes the reply ends the sequence with the removal) → checkpoint (Decision 4: after the
  output trigger) → inlays (`generateImage` callback per image command) → checkpoint (after
  inlays) → `igp` (an `aux` request appended to the reply) → `chatOutput` callback (acknowledged;
  skipped when the owner is disconnected, Safety Contract) → final write (`final: true`, the
  reply as it stands with `generationInfo`) → ownership released → `done` → notices (`tts` when
  `ttsAutoSpeech`, `notification`, `emotion`) and the `imggen` callback (client-side `stableDiff`
  after `done`, Decision 6). Non-streaming: `editoutput` → inlays → append (fence open) → output
  trigger → checkpoint → `igp` → listeners → final write → `done`. Every intermediate write
  keeps the fence open; a late checkpoint after `final` is `ignored` by the fence, as today; a
  failure between stages leaves the last checkpoint. `editoutput` per chunk (today with
  optimization off) is gone: the Safety Contract items "`editoutput` applies to completed text"
  and "a crash mid-stream leaves raw text".
- Emotion (proposed): `req.special.emotion` and the `submodel` and embedding modes compute on
  the server (request layer, embeddings service) and reach the client as one `emotion` notice
  (`CharEmotion` is a client store); the image-based `imggen` view stays a client callback.
- Path-to-owner table (recorded here for the parity matrix):

  | Path                                  | Owner                                  |
  | ------------------------------------- | -------------------------------------- |
  | `editoutput`, output trigger, inlays  | this slice (server)                    |
  | `igp` append                          | this slice (server, `aux` request)     |
  | `chatOutput`, `generationInfo`, final | this slice (server)                    |
  | `sendAIprompt` resend, auto-continue  | this slice (bounded loop)              |
  | emotion modes                         | this slice (server) + `emotion` notice |
  | `imggen` (`stableDiff`)               | client callback after `done`           |
  | TTS, notifications                    | client notices                         |
  | captioning, `requestWebLLM`           | `memory-on-server`                     |
  | `preview`, `previewPrompt`            | `prompt-assembly`                      |
  | reroll history (`prereroll.ts`)       | client (`done.alternatives`)           |

- Bounded loop (proposed): `sendAIprompt` resends and auto-continue run inside the job, capped
  (proposed 8 iterations per job; an implementation detail the phase already requires to be
  bounded); each iteration continues under the same job and lock.
- Inlay bytes: the client's `generateImage` callback uploads through the existing inlay path and
  answers with the inlay id and dimensions; the server never re-encodes images.
- Provider plugins (proposed): for a `pluginmodel:::` model the runner sends a `provider`
  callback with the assembled prompt and the frozen descriptor; the client runs
  `pluginHooks.providers` and streams the result back as `providerChunk { text }` and
  `providerDone`; the job persists and runs the tail as for any provider. `bodyIntercepter`
  callbacks receive `(body, type)` as today.
- Tool calls (proposed): remembered calls are conversation data: the job writes each new call
  as `chat.toolCalls[id] = { call, response }` through a `meta` op (a chat field stored as sent,
  D2's chat exception; deleted with the chat; carried in snapshots and archives with the chat);
  `decodeToolCall` on the server reads the job's chat, and the client's `mcp.ts` reads the chat
  field for the browser assembly path (its LocalForage store is used only for entries created
  before this slice; no migration owed).

## Validation

`pnpm check`, `pnpm test`, `pnpm build`, `pnpm format:check`; the review step extends
`generations.test.ts` with the tail on a fake provider: `editoutput` applied once at the end, the
output trigger's changes merged and checkpointed, an output trigger that removes the reply, an
inlay command answered by a fake callback and one left unanswered, `igp` appended before the final
write, `chatOutput` acknowledged and skipped when the owner socket is closed, a late checkpoint
after `final` ignored, a failure between stages leaving the last checkpoint, the 8-iteration cap,
a `provider` callback round trip, and a tool-using reply followed by a second send after job GC
and after a server restart. Manual: with the flag on, a card with an output trigger and an image
command sends; a plugin with `chatOutput` and an `editoutput` handler runs; a `pluginmodel:::`
provider plugin answers.

## Residual risk

A reply that completes while its client is disconnected skips `chatOutput` and any image callback
(recorded). The TTS notice plays only on the owner client.

## 11a: what landed

The slice is built as two commits. 11a is the tail of a reply in the job
(`server/src/prompt/runner.ts`, `postProcess.ts`, `scripts.ts`), as `docs/structure/self-host-server.md`
(`runPromptJob`) describes it. Files beyond the drafted list: `server/src/prompt/scripts.ts`,
`server/src/jobs/{runSetup,chatResult,channel}.ts`, `server/src/lua/bindings.ts`,
`server/src/routes/generations.ts`, `shared/jobs.ts`, `src/ts/network/generationJobs.ts`,
`src/ts/process/stableDiff.ts`, `src/ts/process/index.svelte.ts` (the `igp` fix).

Decisions that differ from the draft above:

- The order is the tab's on each path (the amendment), not the draft's single sequence: TTS and the
  listeners stay inside each round; `igp` runs only on the reply no further round follows.
- The loop cap is 8 extra rounds per job across its speakers (`MAX_SEND_ROUNDS`); past it the reply
  is finished with its whole terminal tail and a toast.
- The completed raw text is stored before the first hook of the tail, and every later write of the
  reply claims the stream's last chunk, so a tab never shows streamed text over a processed write.
- A reply the output trigger removed ends the turn.
- The emotion modes run on the server with the tab's recent emotions sent at job creation
  (`context.client.emotions`); the image view is a new `imggen` callback, before `done`.
- Tail callbacks: no tab attached, skipped; a hook's failure, the effect left out; a timeout (60 s
  for listeners, 5 minutes for an image), a barrier or protocol failure, or an abort ends the job.
- An inlay image command is generated for the reply only, one after the other.
- `igp` with a prompt that is not ChatML is an error notice on the server; the tab is unchanged
  there.

Plan review (GPT-6-Astra, 18 points): adopted, with two changes: `stableDiff` checks for
cancellation after its prompt request and does not cancel a running image request (point 9), and
the plugin `editoutput` hook keeps slice 9's policy for a hook unloaded during a job (point 10).
Points 11 to 16 are 11b's.

Challenge (one round, four findings, all fixed): the `chatOutput` handler walked a copy of the
listener set (the tab walks the live set); a cached empty script result was a cache hit on the
server (the tab computes it again, with its effects); a cancelled image callback could still alert
its prompt request's failure; an emotion choice that failed did not drop the oldest of five recent
emotions as the tab's store does. The submodel emotion mode matched the client's code on 36 cases
after the fix.

Live check (a fresh server with a mock provider, 27 checks): Lua `editOutput`, a plugin
`editoutput` hook, and an `editoutput` regex applied once to the completed reply while raw chunks
stream; the output trigger; a `chatOutput` listener with the processed reply; `tts` and
`notification` notices; timings; the same without streaming; auto-continue; the cap; a resend with
`igp` on the last reply only; a failing `igp`; both emotion modes; the inlay emotion rewrite; an
inlay image the tab could not make.

Review: no problem found; the reviewer added `server/src/tests/promptTail.test.ts`,
`postProcess.test.ts`, and three cases in `src/ts/network/jobChannel.test.ts`. Not pinned: multiline
answers and a two-speaker group through the tail, an abort at each tail stage (no seam to pause a
stage), and an unmatched `special.emotion`. Note: the channel decides "no tab attached" at a
callback's deadline, so a reply that completes while its tab is away waits up to 60 s for the
listeners and 5 minutes per image before they are skipped.

## 11b: what landed

As `docs/structure/self-host-server.md` ("Slice 11b"), `plugins-mcp.md`, `persistence.md`, and
`global-api.md` describe it. Files beyond the drafted list: `server/src/jobs/{jobScope,runSetup,
commandRunner,cbsHost}.ts`, `server/src/llm/settings.ts`, `server/src/lua/bindings.ts`,
`server/src/prompt/commands.ts`, `server/src/data/chats.ts`, `shared/{database,jobs}.ts`,
`shared/llm/validate.ts`, `src/ts/storage/chatStore.svelte.ts`, `src/ts/process/request/transport.ts`,
`src/ts/process/{command,serverCommands}.ts`.

- **Provider plugins.** A job's request to a plugin provider model is a `provider` callback to the
  job's tab. The first owner message decides: a `chunk` (the cumulative text) makes the answer a
  stream, an answer makes it text. The server's stream holds only the newest text not yet read; the
  tab sends at most one chunk every 50 ms; a text over 4 MiB characters fails the request; the
  request's abort or the reader's cancel reaches the plugin as its abort signal and cancels its
  stream. The providers are the ones registered when the job was created (their descriptors, as
  registered); the argument is built on the server and is not sent when it carries a stored
  credential.
- **Tool calls.** `chat.toolCalls` holds the remembered calls; a `meta` op's `merge` adds entries
  to the map as stored, so writers on a stale revision keep each other's; entries are validated
  wherever a chat is written. The tab stores a call with the request's chat and reads the chat
  first; the `decodeToolCall` defect (question 10) is fixed. A job decodes from its chat; it calls
  no tool until slice 12.
- **`/multisend`.** A command job queues the parts (`done.followUps`), and its tab sends them after
  the job, once per job in a tab; in a send job the command does nothing, as in the tab while a
  send runs. A reload or a closed tab drops the parts not sent.

Challenge (two rounds, ten findings; nine fixed, one kept): a provider's stream was not cancelled
on every ending; the server kept every cumulative chunk; the text limit skipped answers; an admitted
plugin model took custom flags the tab does not apply to it; a job followed again sent its
follow-ups again; a tool record's response pieces were not validated; a byte stream's last
incomplete character was dropped; the stream's reader lock was kept; the follow-up marker was
evicted after 500 jobs. Kept: a provider that throws is reported with its message
(`Plugin Error from <provider>: <message>`), where the tab's own path prints `{}` for an `Error`.

Live check (a fresh server, 21 checks): a text and a streaming provider as the job's main model,
a provider that fails, one that throws, a model without a provider, an abort during a slow stream;
a `meta` merge, a second one on a stale revision, a malformed record refused, a remembered call
sent as tool messages by a job; a manual trigger's `/multisend` sent by the tab in order.

Review: no problem found; the reviewer added `server/src/tests/providerModels.test.ts`,
`src/ts/process/mcp/tests/toolCallStore.test.ts`, and cases in `llmRequests.test.ts`,
`jobChannel.test.ts` (both), `chats.test.ts`, `chatStore.test.ts` (both), `manualTriggers.test.ts`,
and `serverCommands.test.ts`. Not pinned: the credential check of a job's remembered record (a job
calls no tool until slice 12, so `tools.encode` is unreachable), and a `presetChain` pick's or a
group speaker's admitted providers (read in `runner.ts`). Residuals: a provider answering a
`content` that is neither text nor a stream ends the job as a malformed answer (the tab's own path
passes it on); a socket lost between the first `chunk` and the replayed `streamed` answer ends the
job the same way; an unloaded provider is reported as `Plugin Error from <provider>: ...`, not as
the unknown-plugin message; a provider callback holds the tab's callback lane while it streams.
