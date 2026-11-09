# Upstream Intake 2 Plan audit, 2026-11-10

- Plan: `docs/plan/upstream-intake-2.md`
- Commit audited: `78086423f` (`dev`)
- Mode: `full`
- Model: GPT-6.1-Sol (`xhigh`), read-only; report written by the plan-runner orchestrator (Claude Opus 5.5)

| Severity   | Count |
| ---------- | ----- |
| P1         | 0     |
| P2         | 8     |
| P3         | 2     |
| unverified | 1     |

Tests and browser behavior were not run. Every P2 and P3 below is `fixed in plan` in the commit that adds this
report; Sol confirmed each corrected sentence against the code (several in Sol's own wording) and that the product's
behavior stays what the plan intended. AUD-11 stays open and is quoted in slice 13's brief.

Found consistent: the Baseline refs (53 non-merges, 13 merges, only `5365e410d` with a remerge difference, in
upstream's Tauri code); both unconverted callback returns (`factory.ts:393`, `:697`); the dropped removed nodes
(`v3.svelte.ts:623`, `:629`); the strong proxy map, random ids, missing-ref fallthrough and single-id release
(`factory.ts:67`, `:611`, `:719`, `:1030`); the substring blacklist (`v3.svelte.ts:967`, `:2274`, `:2293`); the six
ungated setters and the grant store keyed by script hash and permission (`permissionStore.ts:117`); proxy digest
acceptance with every product caller already sending a JWT (`server/src/routes/auth.ts:205`, `:217`;
`src/ts/storage/serverAuth.ts:169`); the markup gaps of slices 8 to 10; the frame layer and the alert layers; the
module import paths keeping `mcp`, with embedded-card reads ignoring it (`src/ts/characterCards.ts:492`); the
client abort-listener cleanup (`src/ts/globalApi.svelte.ts:643`); and the D3, D4, D6 and D7 premises.

Re-check list (the grants reach the resource store): `patchMessage` closes an open fence
(`server/src/data/chatStore.ts:2517`, `:2549`); feed rows and record patches are measured whole
(`chatStore.ts:1917`, `server/src/data/resourceStore.ts:3674`); `STORE_TABLES_SQL` runs on version-zero
initialization or an exclusively created staging database (`resourceStore.ts:3826`, `:792`). The fourth entry's
wording is stale: `sendText` counts eligible successful sends, subject to audience and buffer admission
(`server/src/jobs/generationJobs.ts:1017`, `:1032`), not any open socket.

## P2

### AUD-1 — Slice 4: the permission await can retarget a write — fixed in plan

Plan, slice 4: "One guard, … placed after `refuseTransformWrite` and before validation, chat loading and the
plugin-install confirmation."

Code: the setters capture their targets after that point: the preset scope (`v3.svelte.ts:2167`, `:2184`), the
selected character (`:1685`), and the indexed ids (`:2726`, `:2858`); `currentContext` reads the innermost hook
(`pluginContext.ts:131`). An await before those captures lets a selection change during consent retarget the write.

New sentence: "Capture the call's plugin context and settings write scope, the selected target ids for
selection-based setters, and the ids resolved from supplied indexes for indexed setters before awaiting the guard;
after a grant, validate and write only those captured targets."

### AUD-2 — Slice 3: the relative-URL test cannot pass through `risuFetch` — fixed in plan

Plan, slice 3 Test: "a relative URL resolves against the page".

Code: `risuFetch` forwards the original string (`v3.svelte.ts:2289`) to `globalFetch`, which parses it without a
base (`globalApi.svelte.ts:755`) and fails. The test file mocks the transport (`nativeFetch.test.ts:16`).

New sentence: "a protocol-relative URL naming a blocked host (`//risuai.xyz/x`) is refused; a relative path is
checked against the page URL and passes when its resolved hostname is allowed … Each transport still receives the
caller's original string, so `risuFetch`'s handling of relative URLs is unchanged."

### AUD-3 — D1: the three-day re-ask happens only on an uncached check — fixed in plan

Plan, D1: "Every installed plugin that writes is asked once after this lands, and again after three days, like
`db`."

Code: `getPluginPermission` returns the page-cached answer first (`v3.svelte.ts:895`); the three-day comparison
runs only uncached (`:903`); reset and revocation invalidate earlier (`:814`, `:840`).

New sentence: "asked at its first gated write after this lands; like `db`, the answer stays cached until unload or
an earlier permission invalidation, and a grant older than three days is asked again on the next uncached check.
Reset and revocation stay as they are."

### AUD-4 — Slice 5: Korean overrides the install text too — fixed in plan

Plan, slice 5: "`confirmInstallPluginViaPlugin` in `src/lang/en.ts` (~3565) and `src/lang/zh-Hant.ts` (~1423)".

Code: `src/lang/ko.ts:3455` has the key without `{plugin}` and overrides English (`src/lang/index.ts:25`).

New sentence: the three files `en.ts`, `ko.ts` and `zh-Hant.ts`; the placeholder and `confirmReplacePluginViaPlugin`
in all three; Depends names `src/lang/ko.ts` too.

### AUD-5 — Slice 9: span ownership after insertion proves nothing — fixed in plan

Plan, slice 9 Test: "a node of a `DOMParser` document gets a span owned by that document".

Code: the span is created in the live document (`parser.svelte.ts:1647`) and inserted with `replaceWith` (`:1657`),
which adopts it (`happy-dom` `Node.js:765`), so the check passes today.

New sentence: "with the parsed document arranged first and then the live document's `createElement` made to
throw, a node of a `DOMParser` document holding Markdown such as `**bold**` still gets its rendered span".

### AUD-6 — Slice 12: the toast would be replaced by the import's own status — fixed in plan

Plan, slice 12: "show one toast (`alertToast`, `src/ts/alert.ts`) that its tool server was not imported".

Code: toasts and progress share one status slot (`alertQueue.ts:16`, `:189`); `importModuleFile` and
`addImportedModule` set and clear status afterwards (`modules.ts:365`, `:384`, `:520`, `:544`); the success notice
is a queued dialog that takes precedence (`alert.ts:282`, `alertQueue.ts:108`).

New sentence: carry a transient was-present flag and install the toast after a successful import's final status
handling, keeping any success dialog, after whose dismissal the toast shows; the test checks the status slot and,
after dismissing the dialog, the visible alert.

### AUD-7 — Slice 13: the server timer and the three return branches — fixed in plan

Plan, slice 13: "clear only the timer when the headers arrive (the timeout stays a limit on the wait for headers,
as now)".

Code: `fetchNative` sends `risu-timeout-ms` to `/proxy2` (`globalApi.svelte.ts:1269`, `:1278`), whose server timer
covers the body (`server/src/routes/proxy.ts:386`); the client returns at `:1251`, `:1287` and `:1292`.

New sentence: clear only the client timer; the `/proxy2` server timer keeps covering the body, unchanged; drop the
listener on all three return branches, a rejected fetch and a response without a body included.

### AUD-8 — Slice 2: a fake finalizer cannot prove an extracted method keeps its owner — fixed in plan

Plan, slice 2 Test: "a method taken from a proxy keeps its owner registered."

Code: the closure references `val`, not the proxy (`factory.ts:116`); the strong map retains it today (`:67`,
`:124`). Upstream captures the owner explicitly.

New sentence: the fake registry receives each proxy with its ref id and each simulated finalization releases its id
once; owner retention by an extracted method is a source-review point, not a test.

## P3

### AUD-9 — Slices 4 and 8: unnamed test fixtures and paths — fixed in plan

Slice 4 must update `v3SetDatabase.test.ts` (unanswered confirmation at `:27`, `db`-only seed at `:159`) and
`v3SetPersonas.test.ts` (a discarded setter promise at `:116`), seeding `dbWrite` with a current `lastGrantTime`
(`v3.svelte.ts:903`). Slice 8 now names `src/lib/SideBars/Scripts/triggerEffectDisplay.ts` and its test, and keeps
the component's support decision (`TriggerV2List.svelte:601`, `:2281`).

### AUD-10 — Order: slice 12 shares the language files with slices 4 and 5 — fixed in plan

Slice 12 adds keys to `src/lang/en.ts` and `src/lang/ko.ts`, as slices 4 and 5 do. The Order now has slice 12 land
before slice 4 (slice 4 depends on it); Sol found no other dependency (`v3.svelte.ts:1976`,
`plugins.svelte.ts:736`). Slice 11 reads `v3.svelte.ts` only, and now also names the delegated alert branches
(`AlertComp.svelte:1036`, `:1133`, `:1137`) and that a common root must be a real alert-only stacking wrapper.

## Unverified

### AUD-11 — Slice 13: userscript cancellation

Plan, slice 13: "Without a timeout the caller's signal is passed through and works"; Test: "aborts the underlying
request".

Code: the userscript branch passes the signal (`globalApi.svelte.ts:1252`), but `userScriptFetch` is an external
function (`src/vite-env.d.ts:6`) with no implementation here. Verify the wrapper with an abort-aware transport
stub; real userscript cancellation stays unverified.
