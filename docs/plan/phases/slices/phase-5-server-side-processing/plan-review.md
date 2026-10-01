# Plan review: Phase 5 implementation plan

The two reviews of the draft of [`implementation-plan.md`](implementation-plan.md), kept verbatim
so the per-slice Fable reviewers can read the testing advice and the evidence. Opus's decision on
every point is in the plan's "Plan review decisions" section. File references are to `ce43f2b9`.

## GPT-6-Astra plan review (P1 to P17)

The draft needs revision before approval. The overall extraction order and the 7a/7b split are sound, but the credential transition, callback transport, job lifecycle, and transform contracts have blocking gaps.

Reviewed against `ce43f2b9`, including the phase, all fifteen slices, planning/review notes, PLAN Decisions 1–6, STRUCTURE, relevant structure guides, and current implementation. Repository files were not changed. No build or tests were run; this is a source/design review, not runtime validation. References below are repository-relative; “plan” means the new Phase 5 `implementation-plan.md`, and slice names mean files in its directory.

### Plan findings

**P1 — Reject the `supaMemoryKey` exception; it also breaks surviving consumers at cutover.**

Problem: owner question 12 deliberately leaves an LLM credential readable through 7b–13, contrary to the requested keyless rollback seam. Moving the flip to 14 does not solve all consumers: the embedding playground and attachment preprocessing remain browser-side after cutover and still use the same processor.

Evidence: plan lines 213–216, 317–330, and slice-10/14 amendments; `hypamemory.ts:124`, `hypamemoryv2.ts:440`, `supaMemory.ts:213`, `hypav2.ts:41`; `PlaygroundEmbedding.svelte:54`; `memory-on-server.md` explicitly retains browser playground processors, while plan slice 10 retains `files/multisend.ts`. Decision 6 and `planning-notes.md`, drift item 6, require the browser assembly seam without a client-held key.

Fix: introduce credential-free server endpoints for the direct memory completion and embedding operations in 7a, and route both processors and direct summarizers through them before 7b. Keep browser orchestration/vector caches if useful. Slice 10 can reuse these services. This is recommended over moving the entire memory port earlier, which enlarges 7a substantially. Deferring the secret flip violates the stated requirement and is not an acceptable default.

**P2 — “Every read path” misses backup exports; removing settings-report filtering is independently unsafe.**

Problem: masking resource reads does not make the server's credentials write-only. The full backup route streams the database. Separately, plan slice 7b says the settings report “no longer filters, because it cannot see secrets,” despite explicitly retaining auxiliary and OAuth credentials in the mirror.

Evidence: `server/src/routes/backups.ts:110–154` exports `store.backupTo(databaseFile)`; the `partial` argument selects assets, not resource fields. `SettingsExportButtons.svelte:43–89` currently removes auxiliary secrets, `authRefreshes`, plugin storage, persona content, and other private data. Plan baseline lines 31–35 retains those readable credentials.

Fix: keep the report's existing privacy filters and add masked LLM status only deliberately. Add backup policy to 7b and an owner question: recommended, browser-downloadable archives omit LLM secrets while local server snapshots retain them; document re-entry on portable restore. An explicitly authorized encrypted credential export is an alternative with more implementation work. A plaintext backup exception requires changing the credential promise explicitly. Define intentional secret set/import traffic separately from runtime secret disclosure; otherwise “no credential in client network traffic” is impossible even when entering a new key.

**P3 — The auxiliary proxy recommendation needs an operation-level credential policy.**

Problem: “allow-listed host plus placeholder header” is insufficient specification for adding stored credentials to an arbitrary proxy. It neither restricts the call to auxiliary operations nor specifies scheme, port, redirects, or Google query-key injection.

Evidence: plan question 2; `server/src/routes/proxy.ts:141–173` accepts a caller-controlled URL and uses fetch's default redirect behavior; lines 198–205 forward the upstream response. `auth.ts:100–109` allows the stored password digest for proxy authentication. The proposed Google host also serves LLM generation, which Decision 6 says must stop using the reverse proxy.

Fix: recommended, retain `/proxy2` but add a typed auxiliary-operation selector with server-owned HTTPS origin, method/path rules, secret mapping, JWT authentication for secret injection, explicit redirect refusal/revalidation, and redacted errors. This preserves Decision 6's proxy choice. Dedicated auxiliary endpoints offer a cleaner boundary but require acknowledging that routing amendment. Duplicating the same key into readable `secrets` defeats the practical goal and should not be recommended. Add the proxy route and each auxiliary consumer to 7b's scope.

**P4 — Secret references need ownership, lifecycle, and settlement semantics.**

Problem: `additionalHeaders.<name>` conflates different custom models that use the same header name. The draft also turns a synchronous forwarding setter into an asynchronous secret-route write without specifying how `flushResources` waits for it. Preset resource changes and secret changes remain separate failure points.

Evidence: plan questions 3 and slice-7b amendments; `request/shared.ts:47–76` selects different parameter sets for global/reverse-proxy and individual custom models; lines 84–130 preserve ordering, deletion, and body parameters. `forwarding.svelte.ts:177–195` currently writes synchronously; `resourceSync.svelte.ts:1185–1242` waits only for its known obligations.

Fix: namespace references by owner/configuration and stable parameter identity, preserving order and `{{none}}`; case-normalize header names without merging different owners. Define explicit secret references for custom credential locations instead of promising arbitrary body/query secrets will be detected by header-name heuristics. Queue secret mutations with the captured owner, epoch, and revision, and include them in pre-send/callback settlement. Recommended: server compound operations for preset copy/import/delete plus its secret entry; alternatively specify recoverable partial-operation states and retries. Include custom-model copy/delete/import and stale masked clients in the lifecycle contract.

**P5 — 7a cannot become unconditional before its browser callback dependencies work.**

Problem: injecting `callTool` is not enough to preserve tools. The actual dispatcher is deferred to 12; provider plugins to 11. Aux/browser requests have no job channel, interceptors are deliberately skipped, and tool objects become names without specifying how their schemas reach the provider. Thus Stop B can pass a plain OpenAI send while the rollback path loses existing functionality.

Evidence: `request-layer-and-llm-secrets.md`, unconditional transport, catalogue, and tool-call decisions; plan slice 7a; `request.ts:232` collects tools, `request.ts:533–534` dispatches plugin providers, `request.ts:900–941` invokes the browser provider; `openAI/requests.ts:808–817` calls and remembers tools inside the adapter. Decision 5 preserves hook positions and plugin providers.

Fix: recommended, add an aux request session/callback transport in 6/7a, independent of chat job admission. Initially delegate tool execution to the existing browser MCP registry and keep plugin providers as a client branch; pass serializable tool schemas and routing identities. Later 11/12 replace these bridges for server jobs. Preserve body/metadata interceptors for aux and flag-off calls. Moving all of 11/12 before 7a creates larger dependencies; simply disabling the features makes the rollback claim false. Make complete flag-off transport parity a gate before 7b.

**P6 — Callback serialization and failure rules contradict their nested-call and barrier promises.**

Problem: exempting an aux request from the chat lock does not prevent callback deadlock. An outer callback can await an LLM request that needs another provider/tool/interceptor callback, queued behind the outer callback. Also, “chatOutput/interceptor errors continue” must not swallow failed persistence, stale epochs, or timed-out callbacks. Phase 4 mutation APIs sometimes warn and return without creating an obligation, so a successful flush alone does not prove every attempted write succeeded.

Evidence: `job-channel.md`, Serialization and Barrier; plan slice-11 failure policy; `v3.svelte.ts:1822–1848` explicitly supports `allowPlugins: true`; `v3.svelte.ts:1439–1445` catches refused chat mutations; `pluginContext.ts:79–101` uses a per-plugin context stack. `index.svelte.ts:91–105` catches listener exceptions, which is narrower than a distributed callback failure.

Fix: specify bounded, correlated child callbacks that run while a parent is suspended, with nesting-aware context restoration; or explicitly reject nested callback-requiring requests and record that incompatibility. Recommended is the correlated child design. Distinguish hook exceptions, tool-result errors, user cancellation, transport timeout/disconnection, and mutation-barrier failure. Barrier/epoch failures must stop the job regardless of the hook's exception policy. Keep generated-message writes refused unless an explicit capability design is approved; ensure those refusals are reported rather than silently counted as successful persistence. Never put the trusted job-write token in browser payloads.

**P7 — Worker coverage misses trigger regexes and needs a nested-task scheduling rule.**

Problem: the re-baseline catches lore regexes, but the trigger port also executes arbitrary regexes synchronously. Lua/regex deadlines alone do not bound native trigger loops. Host calls from Lua can also request lore work from the same finite worker pool, causing starvation when all workers are suspended on such calls.

Evidence: plan lines 74–75 and 244–245; `triggers.ts:803–817`, `1047–1053`, `1565`, `1785`, `2019–2020`; native loop yielding at `591–595` and recursion exception for low-level triggers at `617–627`. `lua-bindings-and-buttons.md` maps `loadLoreBooks` to lore activation; `script-worker-spike.md` specifies two workers and main-thread host calls.

Fix: inventory every user-controlled regex in the moved code and route it through a bounded worker execution contract, not just customscript and lore. Give native trigger execution an aggregate operation/depth budget and abort checks, recording any new limit. Define how nested worker work executes without waiting behind its own suspended parents—e.g. execute pure nested lore in the current worker or use a separately bounded executor. Preserve lowLevelAccess checks from stored character/module provenance; limits must not imply granting capabilities. The spike should prove this scheduling contract, not defer it to assembly.

**P8 — Restore and shutdown do not currently drain generation jobs as assumed.**

Problem: `snapshots.track` makes shutdown await work; it does not make maintenance await or cancel tracked jobs. An epoch check prevents a stale database write but does not stop an old job's provider calls, callbacks, locks, or UI effects. A disconnected job can also outlive Docker's shutdown grace indefinitely.

Evidence: `snapshots.ts:205–213` tracks promises; `227–235` drains only `gate.enter` operations. `main.ts:9,49–66` allows eight seconds before disposing, and `app.ts:202–204` then awaits `snapshots.stop`. `generation-jobs.md` claims the minimal integration is sufficient. PLAN Decision 1 explicitly drains jobs on restore.

Fix: add a job-manager maintenance/shutdown lifecycle in slice 5: stop admissions, cancel jobs and pending callbacks/host calls, drain within a defined deadline, release locks, and only then replace/close storage. Define whether shutdown attempts a final checkpoint before closing writes; restore must not write old data into the replacement database. Epoch-fence all event handling and side-effect continuations, not only `resource` events. Include aux sessions and the worker pool in disposal ordering. Atomic epoch/token checking in `writeAsJob` is a good amendment, but does not replace cancellation.

**P9 — Hydration needs ordered incarnations and a complete chat-change protocol.**

Problem: the inherited “seq differs” rule accepts an older incarnation after a newer one. The event schema primarily carries generated text and generic resources, yet jobs also change metadata, history, message roles/removals, and tool calls. Those changes must be visible before callbacks. Dirty-record preservation conflicts with the guarantee that a callback sees the server's changes.

Evidence: `generation-jobs.md`, Hydration and Events; plan lines 285–290; `resourceStore.ts:161,275–284` defines ordered incarnation/revision tokens. `lua-bindings-and-buttons.md` and `trigger-runtime.md` include full-chat edits; slice 11 adds chat metadata. `resourceSync.svelte.ts:1110–1153` is a generic-record hydrator, not a complete chat hydrator.

Fix: compare `(seq, revision)` monotonically within one epoch; reject other epochs and older incarnations. Define deletion/tombstone or authoritative refetch behavior. Add a chat snapshot/op hydration envelope covering every job mutation and accepted user messages, applied without outgoing writes. Before a callback, settle/reconcile dirty target records and verify its required revisions, or fail explicitly. Keeping dirty data locally and postponing reconciliation until after the hook is insufficient. Specify reconnect discovery using the saved job id/status, not only a new send that happens to receive 409, so reload-mid-stream actually reattaches without user action.

**P10 — Frozen execution identity is not yet a complete read/write model.**

Problem: the plan knows `personaId` is unused but only fixes server Lua/lore/persona setters. Browser plugin CBS and image-generated aux calls can still consult selection. The frozen scope also contains mutable records, while later stages are supposed to observe Lua/native/plugin writes. Freezing everything and rereading everything are both wrong.

Evidence: plan baseline lines 45–47 and slice-8 amendments; Phase 4 Implementation Record, Residuals, explicitly hands persona plus memory/image hook context to Phase 5. `v3.svelte.ts:1412–1420` forwards chatRef but not preset/persona to CBS; `stableDiff.ts:32–43` omits execution context; `hypav3.ts:1480–1488` similarly omits it. `prompt-assembly.md` freezes settings/resources, while `job-channel.md` rereads acknowledged state.

Fix: define immutable identity/configuration plus a mutable job working state. State precisely which own writes and acknowledged callback changes advance that state, and which unrelated concurrent changes remain invisible. Carry frozen effective persona and preset through browser parser hosts, image callbacks, memory aux requests, and provider configuration; fail when an explicitly targeted record disappears. Add the relevant client hosts to slice scope. Keep the run-character/chat-owner split—the amendment is correct—but document both identities for group lore, request hooks, and command runs. Route settlement/context capture through the common send/command entrypoints, not only `sendMain`; plugin sends, slash commands, and file sends bypass it today.

**P11 — Transform cache identity and read-only isolation are incomplete.**

Problem: a tab-local registration counter is not the identity of its handler set: two tabs can both be at counter 1 with different handlers. The proposed key also omits effective persona identity, enabled-module selection, and explicit execution inputs such as triggerId; adding only bound-persona/module-source revisions is insufficient. Server-side isolation cannot stop a browser display plugin from calling persistent setters.

Evidence: plan slice 13; `script-transform.md`, endpoint, cache identity, and two-call protocol. `pluginHooks.ts:38–44,49–55` contains distinct mutable handler sets, including editprocess. `pluginContext.ts:25,42–47` separates effective persona identity; `v3.svelte.ts:1431–1445` exposes persistent chat writes. Decision 5 requires isolated read-only targets, and Decision 1 requires epoch-aware cache namespaces.

Fix: use a handler identity/version digest or an explicitly client-session-namespaced generation counter, covering both modes and plugin reload/unload. Include effective persona identity, relevant enabledModules/character/persona/chat module inputs, triggerId and other effective inputs, plus an epoch namespace. Deliberate persona/history/viewport staleness must be documented separately from collisions between different targets. Apply the same dependency rules to the browser LRU and reject late results from obsolete requests/epochs. Bind phase 2 to the exact snapshot, target, mode, client namespace, and handler version; refuse expired snapshots. For browser plugin setters, recommended, use a read-only callback context with an isolated overlay or explicit refusal. Alternatively narrow the Safety Contract to server stages and disclose persistent plugin effects; the current blanket read-only claim is unsupported.

**P12 — Slice 11 changes observable tail order despite claiming parity.**

Problem: recognizing the two current orders in the Baseline does not repair the slice's proposed sequence. It moves `igp` before listeners and TTS after `done`, and leaves unclear where auto-continue decides relative to `igp`. These affect what plugins/TTS observe, not just persistence.

Evidence: `index.svelte.ts:2132–2140` runs streaming listeners then TTS; `2219–2247` runs non-streaming TTS before output trigger/listeners; `2251–2276` performs auto-continue before `igp` at `2279–2298`. `post-generation-and-plugin-callbacks.md`, Persistence sequence, instead places `igp` before listeners and TTS after done. Decision 5 preserves listener position before recursion.

Fix: write explicit streaming/non-streaming stage tables including continue, auto-continue, resend, igp, listeners, emotion, and image callbacks. Recommended: preserve current observable order except already approved completed-text editoutput behavior, bounded recursion, and confirmed defect fixes. If consolidating TTS/order is desired, ask for that separate behavior change and amend the Safety Contract. Define per-reply completion versus terminal job completion; an imggen callback “after done” must have a live channel/lifetime, and ownership for a continued reply must remain coherent across loop iterations. Fix `igp` with response-type handling, not an unconditional append of `rq.result` when the response can be failure, streaming, or multiline.

**P13 — Golden ownership is right; capture timing and oracle independence are missing.**

Problem: Fable owning fixtures is appropriate, but capturing browser prompts at slice 9 and HTML at slice 13 is too late to prove extraction parity. By then both browser and server may use the same altered shared evaluator, lore code, and request path. Applying defect fixes on both sides can make a regression invisible to differential tests.

Evidence: plan lines 129–135; slice 3 shares CBS/regex implementations, slice 4 shares lore/templates; `prompt-assembly.md` captures browser previews for its golden test, and `script-transform.md` creates the HTML comparison late.

Fix: Fable captures immutable baseline prompts, HTML, token counts, and selected effect traces before slice 3 changes the browser implementation. Store commit/configuration/provenance with fixtures. Keep original captures and separately reviewed expected deltas for approved bug fixes and Safety Contract changes. Later differential checks supplement this oracle. Opus can write capture plumbing, but Fable should review how it controls randomness, time, provider responses, settings, and streaming modes before accepting the captures.

**P14 — Strengthen the dependency graph and stops without changing the agreed workflow.**

Problem: the linear execution is safe, but the README's dependency/parallelism claims are no longer complete: lore now needs the worker boundary; transform needs dynamic assets from memory; unconditional transport needs the callback bridges above. The largest irreversible-looking behavior transition has a stop only after masking. Docker shape checks cannot prove real-image runtime behavior.

Evidence: plan Order/Workflow; README says 4 depends on 1/3 and 13 can run parallel with 9–12; plan adds worker lore tasks and defers dynamic assets to 10. `Dockerfile` copies server/shared/dist plus production dependencies. `playwright.config.ts` uses Vite, so its e2e success does not prove the production image.

Fix: retain 7a/7b as separately reviewed commits; add an explicit transport-parity/credential-consumer gate after 7a and before 7b. Stop A should include an actual image startup/worker/tokenizer smoke, and slice 10 needs a real-image model/backend smoke before its port proceeds. Existing Docker smokes from B onward and the full pre-cutover gate are appropriate. Update the README dependency graph when finalizing, including 2→4, aux callback bridges→7a, and 10→complete transform parity; distinguish infrastructure availability from integrated behavior.

One Astra session per segment is reasonable, but segment B includes the largest extraction series. Require each handoff to include implemented commit ids, accepted deviations, Fable results, unresolved risks, and fixture provenance—not only prior challenge reports. Keep the non-negotiable user stop for every review problem. Strict-mode re-counting is useful only with a reproducible command and a count of the moved dependency closure; require zero introduced server/shared errors, and distinguish approved semantic fixes from unexpected behavior-changing type fixes.

**P15 — Owner-question disposition and remaining amendment corrections.**

The questions should not ask the owner to waive missing correctness contracts. Recommended dispositions:

| Question                   | Recommendation                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 Workflow                 | Accept with P13–P14. Opus writes no tests; Fable adapters and reviewer retain their stated roles.                                                                                                            |
| 2 Auxiliary keys           | Accept constrained proxy injection only as specified in P3; host-only injection is incomplete.                                                                                                               |
| 3 Custom/header keys       | Accept the ownership move, revise the schema/lifecycle per P4. No decision is needed on whether these are credentials.                                                                                       |
| 4 Shared runtime           | Accept and update Decision 2 when extraction starts. Shared code avoids maintenance divergence, but does not itself prove parity (P13).                                                                      |
| 5 Local models             | Accept explicit unsupported errors where the runtime measurement fails. Decide after a real-image check, state each affected capability, and preserve flag-off support until cutover.                        |
| 6 Command slot             | Accept one slot; define command accepted/done events without inventing a reply/message lock.                                                                                                                 |
| 7 `/multisend` in triggers | Accept explicit refusal as a recorded compatibility choice. Ordinary attachment processing still needs P1/P10.                                                                                               |
| 8 Lua rate                 | 30/server/minute is a product limit, not a parity-equivalent translation of six/tab/minute. Accept if desired, but show the six-call baseline, aggregate nature, fairness across jobs, and other fixed caps. |
| 9 Variable cache key       | Accept. Include both scriptstate and effective global-variable inputs and invalidate both caches; correctness should not remain an optional unresolved implementation choice.                                |
| 10 Old proxy jobs          | Keeping one phase is acceptable if Phase 6 gets an explicit removal task and existing tests remain. Removing at cutover is simpler but need not block Phase 5.                                               |
| 11 Defects                 | Accept separately documented fixes; capture before/after evidence. Moving both copies is not sufficient validation.                                                                                          |
| 12 Supa key                | Reject the exception; use P1.                                                                                                                                                                                |

Add owner decisions for portable backup secrets (P2), any intended tail-order change (P12), and any deliberate restriction of nested callbacks or display-plugin mutations (P6/P11).

Other amendments largely track the code correctly: the upgrade dispatcher, seven-argument script wrapper, section locations, effective persona correction, tool-call storage, recursive display context, and clone isolation are warranted. Tighten three details: the lore regex fix must define `/pattern/flags` parsing, not merely stop overwriting `keys[0]` (`lorebook.svelte.ts:174–181` also leaves delimiter handling to the implementation); multiple regex effects must preserve execution order rather than accidentally collapse into the singular `emotion`/`inject` schema (`scripts.ts:235–267`); and “unconfirmed defect proved by fixture” is a review stop under the agreed workflow, not automatic authorization to change behavior. Correct the statement that every display hook runs on the server: browser plugin handlers remain between the two calls.

### Testing advice, separate from plan errors

**P16 — Add the following validation beyond each slice's existing list.** These are assignments for the Fable test/review workflow, not a request for Opus to write tests.

| Slice                   | Additional tests/manual checks and reason                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Tokenizers            | Alternate families and interleave concurrent counts; compare representative Unicode, special-token, and long inputs. Verify custom-model Llama3 fallback separately from reverse-proxy `customTokenizer=llama3` (`tokenizer.ts:130–131` versus `210–239`). Run in the actual image with no source-tree fallback. Three fixed strings alone miss routing/cache defects.                                                                                                             |
| 2 Worker                | Two suspended Lua calls both invoking lore; queued-job abort; late host reply/write after termination; malicious trigger regex; output amplification; pool disposal during startup/wait. Measure process memory as well as JS heap, since the contract includes WASM/native allocation. Verify limits without starving unrelated HTTP.                                                                                                                                             |
| 3 CBS/regex             | Use pre-extraction fixtures; multiple inject/emotion effects in order; cache-hit effect behavior; group lookup; calc variable accessors; simple/no-character callers. These exercise wrapper and side-effect parity, not merely shared evaluator equality.                                                                                                                                                                                                                         |
| 4 Lore/templates/tokens | Bound persona with embedded module, global/chat/character module enabling, delimiter/flag regex cases, recursive activation flags, and worker timeout during lore. Confirm activation-state writes versus transform-discarded state.                                                                                                                                                                                                                                               |
| 5 Jobs                  | Restore while provider, question, and worker are suspended; shutdown within real Docker grace; old-epoch chunk/done; old-incarnation hydration; metadata/removal/history hydration; dirty target before callback; reconnect without pressing Send; competing owner sockets; command jobs with no generated message.                                                                                                                                                                |
| 6 Channel               | Nested aux provider/tool/interceptor calls; two simultaneous chats in one tab; timeout with late plugin mutation; unload mid-hook; callback barrier discard unrelated to the hook; locally refused locked-message mutation; hook exception versus barrier failure. Check context restoration and no double answer/effect after reconnect.                                                                                                                                          |
| 7a Transport            | Full flag-off matrix: provider plugins, remote/internal/plugin/file MCP tools, interceptors including Gemini metadata, retries/fallback models, previews, no-chat aux calls, local models, memory completions/embeddings. Compare outbound request bodies using recording providers before secrets are masked.                                                                                                                                                                     |
| 7b Secrets              | Sentinel search across all resource responses, errors/logs/previews/callbacks, reports and downloadable backups; auxiliary proxy wrong method/path/scheme/redirect; two custom models sharing a header name; secret edit immediately followed by send or preset switch; preset copy/import/delete partial failures; stale-tab writes; all surviving embedding consumers with plaintext unavailable. Exclude deliberate credential provisioning from the runtime-capture assertion. |
| 8a Lua                  | All guards with actual character/module provenance, group speaker versus chat owner, simple/no-target runs, deleted persona/character during suspension, worker replacement and access cleanup, image callback carrying the original context. Verify setters cannot use a browser-supplied job token.                                                                                                                                                                              |
| 8b Triggers             | Native get after Lua set and the reverse; nested display/request triggers cannot persist; every regex effect under timeout; abort in native loops; same-chat command follow-ups and the approved multisend refusal. Assert both working-state results and stored records.                                                                                                                                                                                                          |
| 9 Assembly              | Golden fixtures captured before extraction; plugin/slash/file entrypoints; no duplicate user append/input hook on retry; continue locks before any await; preset-chain keep-field precedence; group speaker selection; settings/persona switched during a wait; approved multimodal failures are explicit.                                                                                                                                                                         |
| 10 Memory               | Remaining browser attachment/playground embedding callers after masking; all supported backend families in Docker; V3 standard and experimental paths; vector dimension/model/config separation; concurrent cache fill across restore; model-switch behavior of text-only caches. Compare persisted memory metadata, not only prompt strings.                                                                                                                                      |
| 11 Tail/plugins         | A stage trace for streaming, non-streaming, continue, auto-continue and resend with igp/TTS/listeners; multiple listeners with mutations; cancellation/disconnect at each checkpoint; provider stream cancellation and cumulative metadata; image callback after terminal event; remembered tools after restart and on flag-off path.                                                                                                                                              |
| 12 MCP                  | OAuth successful refresh, failed refresh, replacement and persistence across restart; remote SSE disconnect during tool execution; duplicate tool names/routing; browser-only tools via aux sessions; consent followed by target deletion; graphmem writes against current job scriptstate.                                                                                                                                                                                        |
| 13 Transform            | Two tabs with different handlers but equal counters; effective persona switches; enabled-module changes; editprocess handler reload; dirty variables; stale response after rerender/restore; phase-2 snapshot expiry/tampering; plugin persistent-setter attempt; deterministic HTML plus sanitization/XSS fixtures and both additional-asset passes.                                                                                                                              |
| 14 Cutover              | Repeat the credential capture over the full surviving-consumer matrix, not just send/translation/suggestion/discovery/DALL-E. Inspect bundle dependency/source-map evidence in addition to grepping for `wasmoon`. Verify server-only production assets and service-worker reload behavior, then rehearse reverting only the cutover commit with the server transport still active.                                                                                                |

### Finalization

**P17 — Yes, obtain Fable's evaluation of the revised draft and this review before finalizing.**

Fable should independently check the baseline-capture timing, test-adapter boundaries, meaningful per-slice gates, callback/lifecycle adversarial cases, and whether the proposed expected deltas preserve the Safety Contract. That evaluation is especially valuable because shared implementations and adapted tests can otherwise agree on the same mistake. Resolve the design points and owner decisions first; retain the required user stop for any review problem. Do not substitute Fable's evaluation for those decisions or for the later per-slice Astra challenges.

## Claude Fable evaluation of the draft and the review

Checked at `ce43f2b9` against the draft (`implementation-plan.md`), the fifteen slices, the
sixteen Luna re-baseline reports, and Astra's P1 to P17. Every file:line below was read in the
tree; nothing was run or changed. "Adopt (smaller)" means the point holds but the fix should be
narrower than Astra's.

Verdict in one paragraph: the draft's order, stops, and 7a/7b split are right. Four Astra points
are blocking as written and need a design change before Opus writes the final plan: P1 (the
`supaMemoryKey` exception breaks the browser-retained embedding consumers at cutover), P5 (7a's
unconditional transport drops plugin providers and tools from the flag-off path), P7 (native
trigger regexes and nested worker starvation), and P13 (the golden fixtures must be captured
before slice 3 or the differential tests compare shared code against itself). The rest hold but
can be settled with small, concrete amendments; two of Astra's proposals (compound secret
operations, a correlated child-callback design) are more than an alpha project owes.

### 1. Astra points P1 to P15

#### P1, `supaMemoryKey` exception: holds; adopt (smaller)

- Direct use of the key on the browser path: `src/ts/process/memory/supaMemory.ts:213` and
  `hypav2.ts:41` (OpenAI `/v1/completions` with `Bearer supaMemoryKey`); `hypamemory.ts:124` and
  `hypamemoryv2.ts:440` (OpenAI `/v1/embeddings`, falling back to `db.supaMemoryKey`).
- Consumers that stay in the browser after cutover and construct `HypaProcesser`:
  `src/lib/Playground/PlaygroundEmbedding.svelte:7,20,54`, `src/ts/process/files/multisend.ts:126,144,159`,
  `src/ts/process/embedding/addinfo.ts:9`. With owner question 12 as drafted, the key flips at
  cutover and these three break at cutover.
- Fix: do not add dedicated memory endpoints. Fold the two direct OpenAI shapes
  (`/v1/embeddings`, `/v1/completions`) into the P3 auxiliary-operation table on `/proxy2` with
  `supaMemoryKey` as the mapped secret (`openai-embeddings`, `openai-completions`). The four call
  sites change one header. `supaMemoryKey` then flips in 7b with every other field; question 12
  is withdrawn. Slice 10's server memory calls the provider directly; the proxy ops remain for
  the browser rollback path and the three browser-retained consumers. Record under Decision 6
  that memory summarization on the browser path goes through the proxy with server-side
  injection (no client-held key), which is what the decision's "auxiliary calls keep the proxy"
  already allows.

#### P2, backups and the settings report: holds; adopt

- `server/src/routes/backups.ts:110-154`: `/api/backups/export` copies the whole
  `resources.sqlite` with `store.backupTo(databaseFile)`; `partial` selects assets only. Opus
  confirmed this.
- `src/lib/Setting/Pages/Advanced/SettingsExportButtons.svelte:43-89` removes
  `googleSearchCredentials`, `authRefreshes`, `personas`, `userNote`, `hordeConfig`, `novelai`,
  `google`, `customModels`, and every key with `key`, `proxy`, or `hypa` in its name. Most of
  those stay client-readable after 7b (`secrets`, `authRefreshes` by Decision 6), so the draft's
  "it no longer filters, because it cannot see secrets" is wrong: keep the filter; the masked
  `llmSecrets` paths come out as `{ set, hint }` objects, which the existing `key` substring
  filter mostly removes; add the `llmSecrets` paths explicitly.
- Backups: new owner question 13. Recommended: a browser-downloaded archive omits the
  `llmSecrets` record (the route already stages its own sqlite copy; delete that one row before
  archiving); server-side snapshots under `save/` keep it; restoring a portable archive means
  re-entering keys (recorded; alpha). Reject the encrypted-export alternative (more work, no
  users). A plaintext archive would be an explicit exception to Decision 6 and should not be the
  default.
- Criterion wording: adopt. The cutover's credential capture excludes the `/api/llm-secrets/*`
  PUT bodies (provisioning); otherwise entering a key fails the criterion.

#### P3, auxiliary proxy injection: holds; adopt (bounded)

- `server/src/routes/proxy.ts:141-173`: the target URL is caller-controlled (`risu-url` or
  `?url=`), headers come from `risu-header`, `fetch` follows redirects by default; 198-205
  forwards the upstream response as is. `server/src/routes/auth.ts:100-109`: proxy routes accept
  the stored password itself. "Allow-listed host plus placeholder header" would inject the key
  for any path on `api.openai.com` (including `/v1/chat/completions`, which Decision 6 says must
  leave the proxy) and would follow a redirect with the injected header.
- Fix: a `risu-aux-op` header naming one row of a server table
  `{ op: { origin, method, pathPattern, secretPath, inject: "header" | "query" } }` with the
  rows `openai-tts`, `openai-dalle`, `openai-whisper`, `openai-embeddings`, `openai-completions`
  (P1), `google-imagen` (query injection; `stableDiff.ts:695` sends the token in the query).
  Injected calls use `checkAuth` (JWT only), `redirect: "error"`, and errors go through
  `redactRequest`. No general policy engine. Add `proxy.ts` and the six consumers to 7b's scope.
  Reject option (b) (a second copy of the key in `secrets`). Note that `tts.ts:197-205` prefers a
  per-character `oaiTTSConfig.apiKey`; that stays client-side by Decision 6 and only the
  `db.openAIKey` fallback becomes the op.

#### P4, secret references and settlement: holds in part; adopt (smaller), change question 3

- `src/ts/process/request/shared.ts:47-76` selects global `additionalParams` for
  `reverse_proxy` and per-model `params` for `xcustom:::`; 84-130 applies `header::` lines in
  order with `{{none}}` deletion. `src/ts/storage/forwarding.svelte.ts:177-195`: the `proxyKey`
  setter is synchronous (`setPresetSecret`). `src/ts/storage/resourceSync.svelte.ts:1185-1242`:
  `flushResources` waits only for dirty records and chat obligations.
- Schema: `additionalHeaders.<name>` would merge different owners that use the same header
  name. Rather than Astra's owner-namespaced references with ordering and `{{none}}` semantics,
  shrink question 3: move only the structured `customModels[].key` to
  `llmSecrets.customModels.<id>.key` (its entry is deleted with the model:
  `CustomModelsSettings.svelte:93` splices; there is no copy), and leave free-form `header::`
  values in `additionalParams` and custom-model `params` client-readable as user configuration,
  recorded as outside the credential criterion the way Decision 6 already treats plugin-managed
  credentials. A `{{secret:name}}` placeholder scheme is a follow-up if wanted. This removes the
  whole `additionalHeaders` surface from 7b.
- Settlement: adopt. The `db.proxyKey` setter and the preset copy, delete, and import secret
  calls register their in-flight write as an obligation that `flushResources` awaits (a small
  pending set in `resourceSync`), so "edit the key, send" lands.
- Compound server operations for preset copy/import/delete plus the secret entry: reject. Keep
  the two routes in the order resource then secret and record the residual (an orphan secret
  entry or a preset without its proxy key after a partial failure; re-entering the key fixes
  it). Alpha data.

#### P5, 7a cannot be unconditional without the browser bridges: holds; adopt in two parts

- `src/ts/process/request/request.ts:232`: `requestChatData` collects browser tool clients
  (`getTools()`); 533-534 dispatches `LLMFormat.Plugin` to `requestPlugin`; 900-945 runs the
  browser provider through `invokeHook`; `openAI/requests.ts:808-817` calls `callTool` and
  `encodeToolCall` inside the adapter. With 7a's unconditional transport, a flag-off send with a
  `pluginmodel:::` model or with MCP tools has no path until 11 and 12, so the rollback seam is
  incomplete in between.
- Part (a), plugin providers and WebLLM: a local branch in the client transport before the POST
  (resolve `modelInfo.format`; `Plugin` and `WebLLM` run the client adapter as today). The draft
  already does this for `requestWebLLM`; extend it to `Plugin`. Cheap, and the hybrid step in 11
  replaces it for jobs.
- Part (b), tools: the aux request carries serializable tool descriptors (name, description,
  input schema) so provider bodies are complete. For execution during 7a to 11, new owner
  question 14 with two options: (i) a minimal aux callback leg: the aux SSE response may emit
  `callback { id, name: "mcpTool", ... }` and the client answers with
  `POST /api/llm/request/:id/answer`; slice 12 then moves remote and internal tools server-side
  and keeps plugin, filesystem, and Google-search tools on that leg (the same leg a job uses
  over its socket); (ii) a recorded gap: MCP tools on the flag-off path are unavailable until
  slice 12. Recommended: (i), because 12 needs the plugin-tool callback anyway and the leg is
  reused; (ii) is acceptable if the owner wants fewer moving parts, since tools are not in the
  exit-criteria scenario list (send, continue, reroll, group, memory, image generation).
- Reject "preserve body and metadata interceptors for aux and flag-off calls". The planning
  notes already record that `bodyIntercepter` registrations are not applied to browser-path
  calls without a job; the only built-in use is Gemini usage metadata to plugins
  (`src/ts/process/request/google.ts:777-787`). Keep the record.
- Adopt "complete flag-off transport parity as a gate before 7b" (see P14 and section 5).

#### P6, nested callbacks and failure rules: holds narrowly; adopt (smaller)

- `job-channel.md` serializes to one outstanding callback per client and queues the rest. A
  plugin calling `runLLMModel({ allowPlugins: true })` from inside a callback
  (`src/ts/plugins/apiV3/v3.svelte.ts:1822-1851`) with a `pluginmodel:::` model needs a
  `provider` callback, which queues behind its own parent: deadlock. Tools do not nest:
  `requestChatDataMain` takes only `arg.tools` (`request.ts:464-470`) and `runLLMModel` passes
  none.
- Fix: an aux request issued from inside a callback carries the parent callback id; its
  callbacks dispatch as children of that parent (a per-client stack of outstanding callbacks,
  depth capped at 2; deeper is refused with an explicit error). The client side already nests
  per plugin (`src/ts/plugins/apiV3/pluginContext.ts:83-101`). Reject the fuller "correlated
  child design" specification.
- Failure taxonomy: adopt the distinction. Hook exception: `chatOutput` and interceptors
  continue as today (`src/ts/process/index.svelte.ts:91-105`); barrier failure (discarded keys
  or a rejected flush) ends the job regardless of the hook's policy; timeout or disconnect ends
  the job; a tool-result error returns to the model. Slice 11's policy paragraph should say the
  barrier overrides the hook policy.
- "Refused generated-message writes look like success": `v3.svelte.ts:1439-1445` catches and
  warns, so the flush has nothing to discard. Record it; do not add a reporting channel (alpha).
  "Never put the job token in browser payloads": the draft already says only in-process writes
  carry it; restate in slice 5.

#### P7, worker coverage and nested scheduling: holds; adopt

- User-controlled synchronous regexes in the native trigger runtime:
  `src/ts/process/triggers.ts:803-817` (`v2ExtractRegex`), `1047-1053` (split by regex), `1565`
  (regex condition), `1785` (regex test), `2019-2020` (regex replace). `591-595` is a yield
  (`sleep(1)` after 100 loop iterations), not a bound; `617-627` caps `v2RunTrigger` recursion
  at 10 unless `lowLevelAccess`.
- Starvation: Lua `loadLoreBooks` is a host call; lore activation's regexes become a worker task
  while the calling Lua worker sits suspended; two suspended Lua runs on a two-worker pool wait
  for each other forever.
- Fixes: (i) the five native regex sites call the worker regex boundary as a micro-task
  (op, pattern, flags, input; the 1,000 ms deadline); (ii) a task spawned by a worker's host call
  is posted back to the same worker, never to the pool queue (the worker's JS event loop is free
  while the Lua thread awaits a promise), and the spike proves it with "two suspended Lua runs
  both invoking lore"; (iii) native trigger runs check the job's abort signal per effect and get
  an effect-count cap per run (proposed 100,000; recorded) instead of a second time budget.
  `lowLevelAccess` from stored provenance is already in the draft (the frozen scope).

#### P8, restore and shutdown: holds; adopt (smaller)

- `server/src/data/snapshots.ts:205-213`: `track` only adds to `active`, which only `stop`
  awaits; `227-235`: `withMaintenance` awaits `drained()`, which counts `gate.enter` only.
  `server/src/main.ts:9,49-66`: eight seconds, then `dispose`; `server/src/app.ts:202-204`:
  `snapshots.stop()` loops `while (active.size > 0)`. A tracked job in a long provider call
  blocks exit past Docker's ten seconds and is killed; a restore proceeds between two of a job's
  writes and the next write fails (as the draft says) while the provider call and callbacks run
  on until then.
- Fix: `beginShutdown()` and `withMaintenance` abort every live job's signal; the runner's abort
  path persists the text so far and ends with `error`; the abort cancels the job's socket
  questions and worker tasks. Dispose order: jobs aborted, pool disposed, `snapshots.stop`,
  close. Epoch-fence `chunk`, `done`, and notices as well as `resource` (one check in the client
  dispatcher). Reject a final checkpoint beyond the abort checkpoint and a separate aux-session
  disposal (aux requests are HTTP and die with the connections at the grace deadline).

#### P9, hydration ordering and chat changes: holds; adopt (smaller)

- `server/src/data/resourceStore.ts:161,275-284`: tokens are `<epoch>:<seq>:<revision>` and
  ordered; the draft's "apply when `seq` differs or revision is higher" accepts an older
  incarnation after a newer one. `src/ts/storage/resourceSync.svelte.ts:1110-1153`:
  `applyToMirror` has no chat branch (characters keep the mirror's chats); the only whole-chat
  reload is `recoverFromConflict` (918). Trigger and Lua changes to other messages, meta, and
  `toolCalls` have no hydration entry; `applyServerGeneration` covers the generated text only.
- Fixes: (i) compare `(seq, revision)` lexicographically within the epoch, drop other epochs;
  (ii) a `resource { kind: "chats", id, revision, data }` event carrying the chat as the server
  reads it, applied through the path `recoverFromConflict` uses minus the discard and the
  notice, keeping the generating message's lock state; sent before each callback and with
  `done`; (iii) reconnect: `jobId` saved beside `clientId` in `sessionStorage`; on load,
  `GET /api/generations/:id` attaches (the 409 route stays as the second entry).
- Reject settling dirty targets before a callback. The pre-send flush settles everything; a user
  edit during the job that conflicts with a callback's write is the conservative `failed`
  outcome Phase 4 already records. Alpha.

#### P10, frozen identity vs working state: holds; adopt (smaller)

- `src/ts/plugins/apiV3/v3.svelte.ts:1412-1420` passes `chatRef` but no preset or persona to the
  parser; `src/ts/process/stableDiff.ts:32-43` and `src/ts/process/memory/hypav3.ts:1480-1488`
  call `requestChatData` without `chatRef` or `pluginContext`; Phase 4's record hands persona and
  the memory/image hook context to Phase 5.
- Fix, as one paragraph in slice 9: `PromptScope` is immutable identity and configuration (ids,
  settings sections, preset, effective persona, modules, credentials) plus a mutable working
  state (the chat and the character records as the job's own writes and acknowledged callback
  writes leave them); unrelated concurrent changes are invisible. Add `pluginContext` to the
  three browser hosts above (three small edits in 7a and 10). Put the flush and the POST in
  `sendChat`'s flag branch, not `sendMain`: plugin `sendChat`, slash commands, and file sends
  reach `sendChat` without `sendMain`.

#### P11, transform cache identity: holds; adopt, narrow the read-only claim

- `src/ts/plugins/pluginHooks.ts:38-44` are plain sets; a per-tab counter is not an identity:
  two tabs with different plugins both at counter 1 collide in the shared server cache. The
  draft's key also omits `personaId` (the selected persona changes `{{user}}` output), the
  `enabledModules` revision (`shared/resources.ts:48`), and `targets[].triggerId`.
- Fix: the handler-set component is a digest of the enabled plugins that registered display or
  process handlers (the `plugins` resource revision plus their ids) plus the counter for a
  reload; add `personaId`, the `enabledModules` and `globalChatVariables` revisions, and
  `triggerId`; the epoch prefixes the server cache. Reject a per-client namespace (it kills
  cross-tab sharing for nothing). The phase-2 snapshot is already bound to one `snapshotId`; add
  the client id as its owner.
- Browser plugin setters inside `editdisplay` handlers: narrow the Safety Contract wording to
  "server stages are read-only; plugin display handlers keep today's capabilities" (recorded).
  Reject the overlay or refusal: the plugin API shape must not change.

#### P12, tail order: holds; adopt, no owner question needed

- `src/ts/process/index.svelte.ts:2105-2140`: streaming runs checkpoint, rerolls, output
  trigger, inlays, `chatOutput` listeners, TTS; `2178-2247`: non-streaming runs inlays, append,
  TTS, output trigger, listeners; `2251-2276`: auto-continue returns early; `2279-2298`: `igp`
  after auto-continue. The slice's streaming sequence puts `igp` before the listeners and TTS
  after `done`.
- Fix: preserve today's observable order with an explicit stage table per path and per loop
  iteration (listeners and the TTS notice inside each iteration at their positions; `igp` once
  after the loop, before the final write). The `igp` fix handles the response type:
  `useStreaming` is unset so the call is non-streaming (`request.ts:493`), but it can be `fail`
  or `multiline` (`multiGen` applies when `genTime > 1` and `noMultiGen` is unset): `success`
  appends `rq.result`, `multiline` appends the first result, `fail` appends nothing and emits a
  notice. The `imggen` callback runs before `done` as the last callback (the socket is alive);
  `done` then means "reply persisted". No order change is proposed, so no owner question.

#### P13, fixture capture timing: holds; adopt

- The draft captures prompt fixtures in slice 9 and HTML in 13; slices 3 and 4 make both paths
  share CBS, regex, lore, and templates, so a later differential test compares shared code
  against itself, and a defect fix applied on both sides is invisible.
- Fix: before slice 3 (at Stop A's segment start), Fable captures baseline fixtures through
  Playwright on the current tree: DevTool preview prompts for the fixture characters (plain,
  lore at every position, Jinja, `presetChain`, group), `ParseMarkdown` HTML for fixture
  messages with deterministic CBS, token counts for the fixed strings and the fixture prompts,
  and the four confirmed defects' current behavior. Stored under `server/src/tests/fixtures/`
  with the commit id and settings. Approved deltas (defect fixes, Safety Contract changes) are
  separate reviewed expected-delta files. Capture scripts may be Opus's; Fable reviews their
  control of randomness, time, viewport, the mock provider, and settings before accepting.

#### P14, dependency graph, gates, Docker: holds; adopt

- README says 4 depends on 1 and 3 and 13 can run beside 9 to 12; the draft's amendments add
  worker lore tasks (2 to 4) and defer dynamic assets to 10 (10 to 13). `Dockerfile` copies
  `server`, `shared`, `dist`, and production `node_modules`; `playwright.config.ts` runs the Vite
  dev server, not the image.
- Adopt: README graph edits (2 to 4; the P5 bridges to 7a; 10 to 13 for complete transform
  parity); Stop A builds the image and runs the spikes' `loadAll` and the worker smoke inside it
  (the Node `.ts` worker entry without a build step is part of that smoke); slice 10's backend
  check runs in the image; the 7a-to-7b gate (the flag-off matrix green with recorded provider
  bodies) is a precondition for starting 7b inside segment B; each Astra handoff lists commit
  ids, accepted deviations, Fable results, open risks, and fixture provenance; strict mode gets
  a reproducible command (a scratch tsconfig over the moved files) and "zero introduced errors in
  `server/` and `shared/`" as the criterion.

#### P15, dispositions and amendment details: mostly holds; adopt the details

- Lore `/pattern/flags`: `src/ts/process/lorebook.svelte.ts:174-181` takes the text after the
  last `/` as flags and skips the key entirely when that is empty (`if (regexFlag)`), so `/abc/`
  never matches today. The fix defines the parse (last `/` separates pattern and flags; empty
  flags allowed) and records the empty-flags change.
- Multiple regex effects: `src/ts/process/scripts.ts:233-267` applies `@@emo` and `@@inject` in
  script order; the engine's `effects` must be an ordered list, not singular fields.
- "Unconfirmed defect proved by fixture": ported as is; a fixture that proves a defect is
  reported at the next stop for the owner's decision, not fixed in the slice.
- "Every display hook runs on the server" becomes "the server stages run on the server; plugin
  display handlers run in the browser between the two calls".
- The question-by-question table is handled in section 4.

### 2. P16 testing advice, sorted

"Necessary" means the Fable reviewer of that slice writes or runs it; "not necessary" gives the
reason. Items the slices already list are not repeated.

| Slice        | Necessary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Not necessary                                                                                                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Tokenizers | Run the per-family encode in the image shape. Custom-model Llama3 fallback (`tokenizer.ts:210-239`, falls to cl100k) versus reverse-proxy `customTokenizer=llama3` (`130-131`, the llama web tokenizer): the golden pins both. Widen the fixed strings to a small set with Unicode, special tokens, and one long input.                                                                                                                                                                                 | Interleaved concurrent counts across families: the server holds one instance per family and counts are deterministic; the client's single-cache replacement is a client quirk the server does not reproduce.                                               |
| 2 Worker     | Two suspended Lua runs both invoking lore (the P7 same-worker rule). Late host reply after termination (cancel by request id). A ReDoS trigger regex through the boundary. Pool disposal during a wait. Unrelated HTTP answered during termination (listed).                                                                                                                                                                                                                                            | Output amplification (the boundary's output cap is already a listed case). Process RSS: a recorded number from the spike, not a test. Queued-job abort folds into the already-aborted-signal case.                                                         |
| 3 CBS/regex  | Pre-extraction fixtures (P13). Multiple inject and emotion effects in order (P15). Group lookup through the host callback. `calcString` with injected accessors. The `@@repeat_back` null fixture (listed).                                                                                                                                                                                                                                                                                             | Cache-hit effect behavior as its own case: one assertion in the regex test that a hit returns the same effects as a miss. Simple and no-character callers fold into the wrapper tests.                                                                     |
| 4 Lore       | Bound persona with an embedded module. Global, chat, and character module enabling. `/pattern/flags` including empty flags and a bad pattern. Worker timeout during lore activation.                                                                                                                                                                                                                                                                                                                    | "Activation-state writes versus transform-discarded state" belongs to 13's isolation test. Recursive activation flags are already listed.                                                                                                                  |
| 5 Jobs       | Restore while a provider call is suspended (job aborted with `error`, restore succeeds). Shutdown with a slow provider: an in-process `dispose()` timing test asserting the job is aborted within the grace. Old-epoch `chunk`, `done`, and `resource` dropped. Old-incarnation hydration rejected. Chat hydration (meta, removal) before a callback. Reconnect by saved job id without pressing Send. A command job with no generated message.                                                         | Competing owner sockets: define last-wins in the slice and assert it inside the reconnect test. Real-Docker shutdown timing: the Stop B smoke covers start, send, reload; the timing test runs in-process.                                                 |
| 6 Channel    | A nested aux provider callback (the P6 stack). A callback barrier discard unrelated to the hook (documents the conservative failure). A locally refused locked-message write inside a callback (assert the warning path). Hook exception versus barrier failure (the two policies). Timeout with a late answer (listed).                                                                                                                                                                                | Two simultaneous chats in one tab: two jobs, same mechanism as the stack test. Unload mid-hook: the hook's promise rejects, outcome `failed`; one assertion inside the exception case. No double effect after reconnect: "late answers ignored" covers it. |
| 7a Transport | The flag-off matrix with a recording upstream before masking (the 7a-to-7b gate): OpenAI-compatible, Anthropic, Google (query key), a plugin provider through the local branch, WebLLM through the local branch, retries and fallback models, both previews, a no-chat aux call (translator), the memory completion and embedding proxy ops. An edit immediately followed by a flag-off send lands in the provider body (F-a). One tool round trip per transport leg per question 14.                   | Each MCP tool family separately before slice 12. The Gemini metadata interceptor on flag-off calls: recorded as skipped without a job.                                                                                                                     |
| 7b Secrets   | A sentinel search across resource responses, previews, logs, callback payloads, the settings report, and a downloaded archive. Aux proxy op refusals: wrong op, path, method, scheme, redirect. Secret edit then immediate send (the P4 obligation). Deleting a custom model removes its key entry. A stale tab's masked write refused. The browser embedding consumers (playground, attachment) working with plaintext unavailable. A reload after masking shows masked status and a send still works. | Two custom models sharing a header name: question 3 as revised drops `additionalHeaders`. Preset copy/import/delete partial failures: compound ops rejected; one test that the secret follows a copy and a delete.                                         |
| 8a Lua       | Guards with stored provenance per mode. Group speaker versus chat owner (`runCharacter` versus `engineCharacter`). A no-target run: `generateImage` refuses, setters return false, including a deleted character. Worker replacement clears access state. The image callback carries the original context.                                                                                                                                                                                              | A browser-supplied job token: slice 5's "client-supplied generation id refused" covers it. Deleted persona during suspension folds into the no-target case.                                                                                                |
| 8b Triggers  | Native get after Lua set and the reverse (the Phase 4 residual). Display and request runs cannot persist (the clone). Each regex effect through the worker boundary under timeout. Abort inside a native loop. `/multisend` refused. A same-chat `/send` follow-up enqueued on the loop.                                                                                                                                                                                                                | "Assert both working-state results and stored records" is how each test is written, not a separate item.                                                                                                                                                   |
| 9 Assembly   | Golden fixtures from the pre-extraction captures (P13). `sendChat`-level entry: plugin, slash-command, and file sends reach the flag branch (P10). No duplicate user append on a retried POST (the user message id travels with the request). Continue locks before any await. Group speaker selection. Preset-chain keep-field precedence (the five `providers` fields). Explicit multimodal refusals.                                                                                                 | Settings or persona switched during a wait: one case in the golden test that a settings change after job start does not affect the prompt.                                                                                                                 |
| 10 Memory    | The browser embedding callers after masking (through the proxy op). The in-image backend check per supported local model (the slice's measurement, recorded). V3 standard and experimental paths. The `testText` raw-key hazard: decide parity or fix, pin either. Persisted metadata per algorithm (listed).                                                                                                                                                                                           | Concurrent cache fill across restore: the cache is cleared after a restore and that is already a listed assertion. Dimension and config separation: the key includes model identity (listed).                                                              |
| 11 Tail      | A stage trace per path including continue, auto-continue, and resend with `igp`, TTS, and listeners (the P12 table), and the three `igp` response types. Several listeners with writes between them (fresh hydration). Cancellation at each checkpoint. Provider stream cancellation. The `imggen` callback before `done`. Remembered tools after restart (listed) and on the flag-off path (the client reads `chat.toolCalls`).                                                                        | Cumulative provider metadata: the plugin provider contract returns content only (`pluginHooks.ts:29-36`).                                                                                                                                                  |
| 12 MCP       | OAuth refresh success (the inverted-status fix), failed refresh, replacement by URL, persistence across restart. Remote SSE disconnect during a tool call. Browser-only tools through the callback leg. Consent then target deletion (Phase 4 semantics ported). `graphmem` writes to the job's chat `scriptstate`.                                                                                                                                                                                     | Duplicate tool names: the callback carries the MCP id; one assertion in the round-trip test.                                                                                                                                                               |
| 13 Transform | Two tabs with different handlers (the digest key). Persona switch. `enabledModules` change. `editprocess` handler reload. Variable change. A stale response after rerender or restore dropped (epoch namespace). Phase-2 snapshot expiry. Deterministic HTML golden with a sanitization fixture (cheap; protects "same HTML"). Both additional-asset passes.                                                                                                                                            | Snapshot tampering: single user, JWT, same origin. A plugin persistent-setter attempt: the contract is narrowed, not enforced.                                                                                                                             |
| 14 Cutover   | The credential capture over the surviving consumers: send, translation, suggestion, model list, DALL-E, TTS, Whisper, Imagen, playground embedding, file attachment. The bundle check: `rg -l wasmoon dist/assets` plus `rg -l scriptings dist/assets` after the build. A revert rehearsal of the cutover commit with the server transport active.                                                                                                                                                      | Service-worker reload behavior unless `vite.config.ts` PWA settings change. Source-map inspection folds into the bundle grep.                                                                                                                              |

### 3. Points the draft and Astra both missed

- **F-a, the flag-off transport must flush before the POST.** Today `requestChatDataMain`
  reads the live mirror at call time (`src/ts/process/request/request.ts:464-510`) and nothing in
  `src/ts/process/` calls `flushResources` (its only production callers are backup and import:
  `src/ts/drive/backuplocal.ts:124`, `src/ts/storage/browserLocalImport.ts:162,218`). After 7a
  the server reads the resources, so a setting edited inside the save debounce window is absent
  from the request on the flag-off path, a parity regression the golden tests would not see.
  Fix: the client transport awaits `flushResources()` before `POST /api/llm/request` (the flag-on
  `sendChat` branch does the same).
- **F-b, the job's conflict rule for non-chat resource writes is undefined.** `writeAsJob`
  goes through `applyChanges`, whose record operations carry a `baseRevision`
  (`server/src/data/resourceStore.ts:106`; the routes check the epoch at
  `server/src/routes/resources.ts:26-32`). A trigger's one-field character patch
  (`src/ts/process/triggers.ts:146-159`) racing a client edit of the same character gets a 409
  inside the job. Define: re-read and reapply the patch once; a second conflict fails the stage
  with `error`. One sentence in slice 5, used by 8a, 8b, and 12.
- **F-c, two client flags, not one.** Slice 13 reuses the send flag for the transform. A defect
  in one server path then forces the browser path for both. `risu.serverGeneration` and
  `risu.serverTransform`, both read through `clientFlags.ts`, both removed at cutover. No cost.
- **F-d, the slice 5 test-adapter list over-reaches.** The lock applies to job-owned messages
  (entries in the in-memory `generationLock` map); client generations on the flag-off path keep
  today's fence semantics (`server/src/data/chatStore.ts:679-740`: an ordinary write closes an
  open fence, `begin` takes over). So `chatStore.test.ts:831-900` stays as it is and the lock
  gets new cases; only `resourcesBatch.test.ts` (the 409 body shape) needs adapting. Smaller
  adapter task, and it keeps the Phase 2 contract pinned.
- **F-e, `authRefreshes` on the flag-off path between 12 and 14.** The draft keeps it
  client-readable and not hydrated; slice 12 writes it server-side. The browser MCP path (flag
  off until 14) reads the mirror (`src/ts/process/mcp/mcp.ts:101-110`), so a server-side refresh
  leaves the mirror stale until reload and the browser path re-prompts for OAuth. One line in
  12's residual risk; nothing to build.

### 4. Owner questions

| #                                                    | Framing                                                                                                                | Final recommendation                                                                                                                                                                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Workflow                                           | Right.                                                                                                                 | Accept, with the P13 baseline capture and the P14 gate and handoff contents added.                                                                                                                                          |
| 2 Auxiliary readers                                  | Option (a) is right in direction but underspecified.                                                                   | (a) as the typed op table of P3, with the six ops including the two memory shapes of P1.                                                                                                                                    |
| 3 Custom-model and `header::` keys                   | The framing conflates a structured field with free-form parameters.                                                    | Move `customModels[].key` to `llmSecrets.customModels.<id>.key` (deleted with the model); leave `header::` values client-readable as user configuration, recorded as outside the criterion like plugin-managed credentials. |
| 4 Shared runtime                                     | Right.                                                                                                                 | Accept; note that shared code is not the parity oracle, the pre-extraction fixtures are (P13).                                                                                                                              |
| 5 Local models                                       | Right.                                                                                                                 | Accept explicit "unsupported on the server" errors, decided per capability after the in-image check; the flag-off path keeps WebLLM and browser Transformers until cutover; the cutover record lists what is lost.          |
| 6 Command slot                                       | Right.                                                                                                                 | Yes. A command job takes the chat's slot, holds no message lock (there is no generated message), and emits `accepted` and `done`.                                                                                           |
| 7 `/multisend` in triggers                           | Right.                                                                                                                 | Yes, recorded.                                                                                                                                                                                                              |
| 8 Lua request rate                                   | Right; the note that 5 would be stricter than today is correct (the client lets six through, `scriptings.ts:455-459`). | 30 per minute per server, 10 s, 2 MB; record the six-per-tab baseline and the aggregate nature.                                                                                                                             |
| 9 Variables in the cache key                         | Right.                                                                                                                 | Yes; use the `globalChatVariables` resource revision plus the chat's `scriptstate` hash rather than guessing which globals a target reads.                                                                                  |
| 10 `proxyStreamJobs`                                 | Right.                                                                                                                 | Keep one phase; Phase 6 gets an explicit removal line.                                                                                                                                                                      |
| 11 Confirmed defects                                 | Right.                                                                                                                 | Fix each in the moving slice on both paths; the P13 baseline captures are the before evidence; unconfirmed ones ported as is, and a fixture that proves a defect is reported at the next stop.                              |
| 12 `supaMemoryKey`                                   | Wrong as drafted (P1).                                                                                                 | Withdraw: it flips in 7b with the rest; the browser path and the retained consumers use the proxy op.                                                                                                                       |
| 13 new, portable backups                             |                                                                                                                        | Browser-downloaded archives omit the `llmSecrets` record; server snapshots keep it; restore from an archive re-enters keys. Alternative: keep plaintext as a recorded Decision 6 exception. Recommended: omit.              |
| 14 new, tools on the flag-off path between 7a and 12 |                                                                                                                        | The SSE callback leg (recommended; reused by 12) or a recorded gap.                                                                                                                                                         |

Astra's proposed questions on a tail-order change (P12) and on restricting nested callbacks or
display-plugin mutations (P6, P11) are not needed: the final plan preserves the tail order, caps
nesting at depth 2 as a recorded limit, and narrows the read-only wording as a recorded
limitation.

### 5. Order, stops, and the 7a/7b split

- **Order:** keep `0, 1, 2, 3, 4, 5, 6, 7a, 7b, 8a, 8b, 9, 10, 11, 12, 13, 14`. Nothing in the
  review justifies moving 11 or 12 before 7a; the P5 bridges are cheaper than a reorder.
- **Stops:** keep A to E. Stop A gains two things: the P13 baseline capture at the segment's
  start (before slice 3 touches the browser implementation) and the image smoke for both spikes
  (P14). The 7a-to-7b parity gate is a precondition inside segment B, reported in 7a's slice
  report, not a new user stop: a failing gate is a review problem and stops anyway.
- **7a/7b:** keep the split and the two commits; 7a gains the local provider branch, the tool
  descriptors, and the pre-flush (F-a); 7b gains the proxy op table, the `customModels` key
  move, the secret-write obligation, and the archive policy.
- **Astra sessions:** one per segment is fine; segment B (3 to 7b) is the heaviest, so two
  sessions there (3 to 4, then 5 to 7b) without a user stop would keep each under Phase 4's
  13M-token experience.
- **Step 0:** add questions 13 and 14 and the P12 stage tables to the phase-file edits; record
  the narrowed read-only wording (P11), the depth-2 callback cap (P6), the effect-count cap
  (P7), and the `header::` configuration exclusion (question 3) in the Safety Contract additions.
