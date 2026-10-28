# Display Evaluation audit — 2026-10-28

## Scope and result

Reviewed the completed Display Evaluation plan against commit
`01ed05989b8a4c63e6cf76cfb13e855158e44cf4`. The working tree was clean when the audit began.
The final plan is available with:

```sh
git show 1db8c10a8:docs/plan/display-evaluation.md
```

The [archive entry](../archived-plan/README.md) identifies the nine slices:
`fd7f50766`, `15ed61b6c`, `6b0d485f5`, `3b0e047ff`, `cf326ef1e`, `4a1d870f3`,
`f5eda0ff6`, `aa4f2a68a`, and `31b75a1e3`. Review covered their changes and the integrated
behavior after merge `05e4be8c1`: server cache dependencies and admission, shared display
projections, snapshot accounting, regex/CBS dispatch, client result caching, provisional
corrections, and refreshes after chat saves. Luna exploration agents located the plan,
implementation, and existing test harnesses; the primary agent performed the audit and probes.

**One plan regression was reproduced. Three additional issues outside the plan were also
reproduced and are recorded separately below.** Existing type, unit, and display browser
checks pass. No product fix or permanent test change is included in this audit.

P2 denotes a correctness or persistence-boundary defect worth fixing. P3 denotes a narrower
reliability issue or a defect whose visible UI impact remains unverified. These priorities do
not imply an observed production incident or an authorization bypass.

| ID  | Priority | Relationship                         | Finding                                                                               |
| --- | -------- | ------------------------------------ | ------------------------------------------------------------------------------------- |
| DE1 | P2       | Introduced by slice 8                | A provisional correction can miss a chat install and leave stale display text mounted |
| U1  | P2       | Pre-existing; previously unconfirmed | Display plugin handlers can persist character changes                                 |
| U2  | P3       | Separate recovery change             | An obsolete failure forces another render after a newer render succeeded              |
| U3  | P3       | Pre-existing parser behavior         | Character-image expansion follows a later selection instead of the captured render    |

## Plan-related finding

### DE1 — The provisional-result handoff bypasses mixed-state detection

**Code.** [transformClient.ts](../../src/ts/parser/transformClient.ts),
`serverProcessScript`'s `captured.provisionalOutcome` branch and its later `completion` handler;
[ChatBody.svelte](../../src/lib/ChatScreens/ChatBody.svelte), `markParsing`,
`pendingTransformOutcome`, and `reportMixed`;
[parser.svelte.ts](../../src/ts/parser/parser.svelte.ts), `ParseMarkdown`'s first asset pass.

**Confirmed behavior.** A differing full answer to a provisional render is handed to the next
local render so that it need not request the same answer again. That correction captures a
new transform context, then awaits its first asset pass. When it reaches
`serverProcessScript`, a matching handed-off outcome returns immediately. This branch checks
source identity, cache generation, and Re-render generation, but never compares
`chatInstallVersion` or checks `hadUnackedWork`. Those checks occur only in the network-answer
handler, which the handoff bypasses. `mixedDisplay` consequently remains false and the mounted
row never registers with `waitForSettledRender`.

**Reproduction.** A temporary copy of the existing
[Chat.settledRender.svelte.test.ts](../../src/lib/ChatScreens/Chat.settledRender.svelte.test.ts)
harness mounted the real `Chat` and `ChatBody`, using the real chat store and controlled
transport and asset I/O:

1. Give the row an image using `{{source::char}}` and warm its confirmed transform result.
2. Unmount and remount it. Hold the confirmation while the cached text is displayed.
3. Return a different full result, `[row][intermediate history]`, so a local correction starts.
4. Hold that correction's `getFileSrc` call, after its transform context was captured.
5. Change the history message to `[saved history]` and acknowledge the chat save.
6. Release the asset read and drain both render and settled-refresh scheduling.

Observed:

```text
text: "[row][intermediate history]"
transform targets sent: 2
chat install version: 1
expected text: "[row][saved history]"
```

The two targets are the warm render and its remount confirmation. No corrective request
followed the save. An isolated transform-client probe independently returned the intermediate
text with `mixedDisplay: false` and zero new requests after the install version changed.
Both expected-correctness assertions failed again when the wrapper reran their files alone.

**Impact.** A row that is actively being corrected can remain stale until another render or
remount. This is inside the plan's intended refresh window, rather than its accepted limitation
for rows whose rendering completed before a later edit began. An asset delay makes the window
observable; it does not require a failed transform or a cache hash collision.

**Suggested fix.** Apply the same mixed-state checks when consuming a handed-off outcome.
Also carry the originating chat install version with the outcome: an install between the
original answer and the correction's capture must not make an old answer appear current merely
because the new capture starts at the newer version. Reject the stale handoff or mark the row
for a settled refresh, preserving the existing unacknowledged-work and generation rules.

**Countercheck and limits.** Temporarily adding the existing mixed-state comparison before
the early return made the mounted reproduction pass; that change was restored immediately.
This verifies the missing branch check for the tested interleaving, not the completeness of
that small change as a fix. The original-answer-to-new-capture interleaving should receive its
own regression test. No production-frequency estimate was attempted.

## Issues outside the plan

### U1 — A display plugin handler can write persistent character data

**Code.** [v3.svelte.ts](../../src/ts/plugins/apiV3/v3.svelte.ts),
`makeRisuaiAPIV3`, `withContext`, `addRisuScriptHandler`, `setCharacter`, and `setChar`;
[pluginContext.ts](../../src/ts/plugins/apiV3/pluginContext.ts), `PluginCallContext` and
`invokeHook`; [transformClient.ts](../../src/ts/parser/transformClient.ts), `runHandlers`.

**Confirmed behavior.** The server transform refuses persistent writes, but its client plugin
continuation invokes the normal plugin API with a chat context that has no display/read-only
capability. `setCharacter` reaches `applyPluginCharacter` and the save adapter normally.

**Reproduction.** Adapted
[pluginContextSaved.test.ts](../../src/ts/plugins/apiV3/pluginContextSaved.test.ts)'s `boot`
helper to register a `display` script handler instead of a chat-output listener. Inside the
registered, context-wrapped handler:

```ts
const character = await api.getCharacter();
await api.setCharacter({ ...character, desc: "persisted by display" });
return text;
```

Invoking it with the same `capturePluginContext`/`invokeHook` path used by transforms, then
calling `sync.flushResources()`, changed the real harness server's `characters/c` record to
`desc: "persisted by display"`. The probe passed its assertion of that persisted change. It
used the existing sandbox transport double, real host API, real save adapter, and store-backed
server; it did not execute a plugin iframe in Chromium.

**Impact.** Automatic display work can change durable character data. Rendering, remounting,
cache misses, and retries therefore are not necessarily free of persistent side effects when
a handler uses this API. A handler with non-idempotent writes can repeat those writes. This
does not demonstrate a plugin permission bypass: the issue is the absence of a display-specific
write boundary for an already-running plugin.

**Suggested fix.** Define and enforce the display-handler write contract at the host API.
For a text-only contract, propagate a display capability through `PluginCallContext` and refuse
persistent mutations from it, including alternate setters and variable writes. Preserve writes
from hooks whose purpose permits them. If persistent display writes are intentionally supported,
document that exception and test its interaction with automatic retries and settled refreshes.

**Attribution.** This confirms the existing unconfirmed plugin-setter hazard in the
[CBS/rendering guide](../structure/cbs-rendering.md). The ordinary setter/context path predates
Display Evaluation (`0d7c1cd642` already wired `setCharacter` through `currentContext`). The
plan's accepted caching of opaque plugin output is not evidence that persistent display writes
were reviewed or accepted. No render/save feedback loop was measured in this audit.

### U2 — Recovery ignores the generation of a failure after a successful retry

**Code.** [displayTransformRecovery.svelte.ts](../../src/ts/parser/displayTransformRecovery.svelte.ts),
`failures`, `markDisplayTransformFailed`, and `publishRetryRound`;
[Chat.svelte](../../src/lib/ChatScreens/Chat.svelte), the `displayTransformRetryRound` effect;
[transformClient.ts](../../src/ts/parser/transformClient.ts), `rerenderMessage`.

**Confirmed behavior.** Recovery stores a failure's Re-render generation, but publishes only
its message key. The generation is never used to reject an obsolete failure, and a newer
successful render does not retire it. Every mounted row named by the retry round calls
`rerenderMessage`, which drops its tab result and forces a server cache bypass.

**Reproduction.** Using the real mounted-row harness and fake timers:

1. Fail the first transform with HTTP 503, registering recovery.
2. Before the five-second retry fires, call `rerenderMessage` and remount the row.
3. Let that newer render succeed and display the correct text.
4. Advance the timer and drain the scheduled render.

The target count increased from two to three; their `noCache` flags were
`[false, true, true]`. The expected assertion that the count remained two failed on both runs.

**Impact.** Recovery needlessly discards a good result and recomputes it. For clock, random, or
stateful plugin output, this can also change the displayed result again after the successful
retry. The reproduction demonstrates one extra render, not an endless loop.

**Suggested fix.** Retire failures superseded by a newer successful render generation, or
filter them before publication. Keep the existing protection that one successful target must
not clear a different failed target in the same row and generation.

**Attribution.** The recovery module and retry behavior came from `223e1fea3`, a separate chat
recovery change, not a Display Evaluation slice.

### U3 — Character-image expansion can switch characters after an await

**Code.** [parser.svelte.ts](../../src/ts/parser/parser.svelte.ts),
`parseAdditionalAssets`'s `needsSourceAccess` block.

**Confirmed behavior.** The asset pass receives a character and captured chat ref, but after
awaiting `replaceAsync` it resolves `{{source::char}}` through `selectedCharacter()` again.
It can therefore use the image of a character selected after this parse began.

**Reproduction.** In the existing
[assetFuzzy.test.ts](../../src/ts/parser/tests/assetFuzzy.test.ts) harness, install characters
A and B with distinct images, select A, and run:

```ts
const pending = ParseMarkdown('<img src="{{source::char}}">', characterA, "normal", -1, {}, null);
selectCharacter("b");
const html = await pending;
```

Observed HTML was `<img src="assets/b.png" loading="lazy" decoding="async">`, although the
parse was started with A. The assertion expecting `assets/a.png` failed on both runs. File URL
resolution was the harness's I/O double; the parser and selection state were real.

**Impact and limits.** The parser can return an internally inconsistent render across a
selection change. This was reproduced at the parser boundary, not as a visible chat-switch
incident: `ChatBody`'s destruction and newest-render guards can discard an obsolete result.
Callers that retain a parse result independently of the selected screen remain the concern.

**Suggested fix.** Resolve and capture the intended character image before the first await,
using the render's character identity or captured context. Do not reselect it while expanding
the source placeholders.

**Attribution.** The selected-character read predates the plan; blame identifies `1ab264df31`
(2026-10-05), with the surrounding expansion inherited from older parser code.

## Other inspected concerns and accepted limits

- **Server keys and admission:** no additional defect was confirmed in the reviewed revision,
  viewport, earlier-speaker, character-identity, or kept/dropped-kind paths. The tests exercise
  both modes, continuations, absent/reappearing characters, and binding refusals. This is not
  exhaustive proof that every possible script read is keyed.
- **Shared reads and accounting:** inspected the raw configuration/transcript caches, target
  overlays, reservation accounting, and pin-release paths, together with their existing tests.
  The duplicated character-reading helpers in `displayScope.ts` and `jobScope.ts` remain
  maintenance debt already recorded in [found-issues](../research/found-issues.md); no current
  behavioral divergence was established here.
- **Budget-refused targets:** the plan explicitly accepts raw text on snapshot-budget refusal.
  The existing note that rows stay raw _until remount_ omits the subsequently integrated
  recovery scheduler. Mounted failed rows can now retry automatically, although an unchanged
  oversized request may still fail. The older numerical refusal rate was not remeasured.
- **Input keys are not output hashes:** a random/clock/plugin result refilled under the same
  server key can differ while `same` confirms older tab text. This was explicitly recorded at
  plan completion, so it is not presented as a newly discovered regression.
- **Other accepted exclusions:** plugin-private state, inlay records/file existence, viewport
  changes without a render, and history-dependent rows that completed before the mixed-state
  window retain the plan's documented limits. DE1 concerns a correction still in progress.
- **Measurement probe:** the known heap-delta noise and unchecked pending-result access in
  `transform-jobs-probe.mjs` remain recorded follow-ups. The plan's performance/heap numbers
  were not independently repeated or treated as results of this audit.

## Verification and reproduction record

Checks run against the original audited product tree:

| Check                                                                            | Result                                                                                       |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm check`                                                                     | Passed; Svelte reported zero errors and zero warnings, server TypeScript exited successfully |
| `pnpm --silent test:agent`                                                       | 7,529 passed, 59 skipped, 504 files                                                          |
| `pnpm --silent test:agent --e2e serverTransform.spec.ts transformGolden.spec.ts` | 10 passed                                                                                    |

Targeted probes used temporary copies of existing harnesses, selected by test title through
`pnpm --silent test:agent`. Expected-correctness assertions for DE1, U2, and U3 failed on the
audited implementation and failed again when automatically rerun alone. U1 instead asserted
the undesired persistent write and passed. DE1's temporary guard countercheck passed its
mounted-row test. All temporary test copies and the temporary product change were removed;
only this report is retained. The intentional probe failures are separate from the passing
existing test suite.

After removing the probes, `pnpm check:tests` passed for 522 test files, the slow-test table,
and product imports. The report passed its targeted Prettier check, and `git diff --check`
reported no whitespace errors. Final status contained only this new audit document.

To retain regression coverage when fixing these findings, extend the existing harnesses named
in each finding with the documented sequence. For DE1, cover both an install during the
correction's asset wait and one between the original answer and the correction's capture.
For U2, retain a same-generation multi-target failure case alongside the superseded-generation
case. For U1, exercise the actual display-handler registration wrapper and check the saved
record, not just the returned text. For U3, hold or cross the asset-pass await explicitly.

No affected slow-tagged test was identified in the changed transform/regex/component files.
The unrelated slow suite, a production build, production-size heap benchmarks, and a manual
plugin-iframe scenario were not run. The final deliverable is documentation only.
