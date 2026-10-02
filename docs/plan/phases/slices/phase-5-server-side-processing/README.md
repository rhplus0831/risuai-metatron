# Phase 5 Slices: Server-Side Processing

Drafted 2026-09-30 as pre-implementation planning, then refined after reviews by GPT-6-Astra (18
points) and Claude Opus (14 points); the decision on every point is in
[`review-decisions.md`](review-decisions.md), and the drift, contingent boundaries, open
questions, and cross-phase edits are in [`planning-notes.md`](planning-notes.md). Every slice is
`planned`. The phase file orders the work into nine steps; the
slices cut those steps into implementer-sized tasks and move two cut points: the Lua and trigger
runtimes come before prompt assembly (the assembly's first stages are hooks), and the server
provider transport comes before the `llmSecrets` flip and is unconditional for both pipelines
(the browser assembly path stays selectable as the rollback seam until cutover).

Slices 1 to 5 need nothing from Phases 3 and 4 and may start while those phases run. That is an
exception to the phases README's entry gate ("the dependencies named in the phase file are
complete"); the plan owner records it there (proposed edit in `planning-notes.md`). Everything from slice 7
on needs Phase 3 (`llmSecrets`, per-client preset id) and from slice 8a on Phase 4 (the mutation
API). A slice that ships routes or services before their consumer is tested infrastructure, not an
integrated stage; the stage is integrated by the slice that wires the client.

Execution follows [`implementation-plan.md`](implementation-plan.md) (final, 2026-10-01, with the
owner's answers), which wins over this file where they disagree: it splits slice 7 into 7a
(transport) and 7b (write-only secrets), adds a baseline fixture capture before slice 3, adds the
edges 2 → 4 and 10 → 13, and sets the stops.

Execution order (arrows are dependencies):

Track A: spikes and pure services (startable now)

1. `tokenizer-node-spike.md`: prove every tokenizer family loads under Node from the payloads the
   image has; fix the loading shim. (no dependency)
2. `script-worker-spike.md`: the `worker_threads` pool that runs Lua and regex with memory,
   time, and size limits, one-use pre-warmed engines inside it, CPU-only Lua budgets, and the
   egress validator; prove the limits hold. (no dependency)
3. `cbs-and-regex-services.md`: the CBS registry and evaluator and the regex engine as shared,
   host-injected runtime modules, including Phase 4's CBS read-model item. (no dependency)
4. `lore-templates-and-tokens.md`: lore activation, Jinja templates, template validation, the
   server token counter. (← 1, 3)

Track B: job infrastructure (needs Phase 2 only)

5. `generation-jobs.md`: the `/api/generations` routes and socket on one upgrade dispatcher, one
   job per chat, the server-side generation lock with `reason: "generating"`, tracking under
   maintenance and shutdown, the client transport with server-applied hydration. (← Phase 2)
6. `job-channel.md`: notices, questions with outcomes, and plugin callbacks over the job socket,
   the registered-hook list, the minimal settle barrier. (← 5)
7. `request-layer-and-llm-secrets.md`: the LLM request layer on the server as the unconditional
   provider transport for both pipelines (`aux` streaming endpoint), the secret-free projection,
   the credential-consumer inventory, then `llmSecrets` write-only. (← 6; Phase 3)

Track C: processing stages on the server (needs Phases 3 and 4)

- **8a.** `lua-bindings-and-buttons.md`: the 54 Lua host functions on the worker runtime, the
  button command endpoint. (← 2, 3, 4, 6, 7; Phase 4)
- **8b.** `trigger-runtime.md`: the trigger runtime port with its UI effects through the channel,
  `v2Command` on the server, manual triggers through the command endpoint. (← 8a)
- **9.** `prompt-assembly.md`: the body of `sendChat` up to the provider call as the job runner,
  with raw-text checkpoints, behind a client-local flag introduced here. (← 4, 7, 8b)
- **9b.** `cbs-evaluator-limits.md`: cooperative work and time limits on server CBS evaluation,
  added at Stop C. (← 9)
- **10.** `memory-on-server.md`: the four memory algorithms, the embeddings service with a
  disposable vector cache file, captioning and local Transformers.js generation. (← 9)
- **11.** `post-generation-and-plugin-callbacks.md`: the persistence sequence per path
  (`editoutput`, output trigger, inlays, `igp`, `chatOutput`, final write), the bounded resend
  loop, plugin callbacks at their positions, the provider-plugin hybrid step, tool calls persisted
  with the chat. (← 6, 9)
- **12.** `mcp-on-server.md`: the Node MCP client and the internal adapters on the server; the
  browser and plugin tools as callbacks. (← 7, 11)
- **13.** `script-transform.md`: the read-only batch transform endpoint (`editdisplay`,
  `editprocess`) with the CBS pre-pass kept at its position, its cache identity, the client
  integration behind the flag, and the "Re-render" item. (← 3, 8b)
- **14.** `cutover-and-docs.md`: remove the browser assembly path, the client Lua and trigger
  runtimes, wasmoon from the bundle, the flag; record the safety contract; docs. (← all)

Parallelism: 1, 2, 3 in parallel; 4 after 1 and 3; 5 in parallel with track A; 6 after 5; 7 after
6; 8a after 7 (and 2, 3, 4); 8b after 8a; 9 after 8b; 10, 11 after 9; 12 after 11; 13 after 8b (in
parallel with 9 to 12); 14 last.

Safety Contract behaviors, by the slice that introduces them: channel questions and plugin
callbacks fail explicitly (6); the generating message cannot be edited until its job finishes (5);
plugin tokenizers are not used for server-side counting (4); Lua globals do not survive between
turns (8a, proven by 2); `chatOutput` skipped for a disconnected client, `editoutput` on completed
text, a crash leaves raw text (11); rendering read-only, displayed CBS cached, a streaming message
raw until complete (13). Behaviors found while slicing are listed in `cutover-and-docs.md` under
"Safety Contract record".
