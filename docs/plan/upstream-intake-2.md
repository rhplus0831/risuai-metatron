# Upstream Intake 2 Plan

Status: drafted 2026-11-10 at `3cc8b2d56`; the owner accepted every decision's default and answered both open questions
the same day (Decisions, Open Questions); audited the same day
([report](../plan-runner-audit/upstream-intake-2-2026-11-10.md)); landed: 1 (`8657b12f2`), 2 (`42dabe136`), 3
(`70a6a82ab`), 7 (`43fbd918e`), 8 (`1e464cecc`), 9 (`08603a57e`), 10 (`a33d622e1`), 11 (`78ff8a290`), 12 (`dbf446dc3`),
13 (`d77de065e`). This is the second upstream intake, run by the [ledger](../research/upstream-ledger.md)'s procedure
over `f50b5942..4d87a70ff` (upstream release 2026.10.295):
53 non-merge commits and 13 merges. Nine read-only Luna workers compared the commits with Metatron by group; the
session then re-read in source every claim a slice below rests on: the two bridge callback returns and the
`Math.random` ref ids in `factory.ts`, the dropped `removedNodes` and the substring URL blocklist in `v3.svelte.ts`,
the install confirmation and its language key, `checkProxyAuth`, `formatEffectDisplay`, the three global
`document.createElement` sites, the `href` sanitizer hook, the alert overlays and the plugin frame's layer,
`getModuleMcps`, and `buildTimeoutSignal`. Line numbers are from that check; the identifiers are the anchors.
Re-verify each cited location before editing (STRUCTURE.md protocol step 5).

Most of the range does not apply: 19 commits touch code Metatron removed (the Tauri shell, `server/node/`, Google
Drive and Risu Account sign-in, Cloudflare deployment, the plugin migration guide) or are version bumps, 9 are
already covered, and 4 are deferred by a decision. The remaining 21 commits become the 13 port slices below, and
slice 14 closes the intake.

One slice is one session, one commit, one file cluster. Each slice names its guide from `STRUCTURE.md` Choose By
Task; that guide's `Invariants` apply. Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow`
for one marked _hard_; routine slices name no Codex challenger. Each slice ends with its tests (under "Test"),
`pnpm check`, `pnpm --silent test:agent` for the files it touches and then once whole, the owning guide's focused
checks, `pnpm format:check`, and `pnpm check:docs` for any guide edit, and updates the owning guide where it changes
a documented contract. A guide edit respects the 40,000-byte ceiling. Code comments and test titles describe
behavior, not this plan (`STRUCTURE.md` T5).

Upstream rules for every slice, unchanged from the first intake:

- Port behavior, not code. Read the final upstream state of a series, not only its first commit.
- Commit with a conventional title and one `Upstream-Commit: <full sha>` trailer per upstream commit ported.
- Never copy upstream `package.json`, lockfiles, version numbers, or files under upstream's `server/node/`.
- A new regression test fails without the change (V6). Mock I/O and process boundaries, not the code under test.

## Baseline

| Reference              | Value                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------- |
| Upstream head          | `4d87a70ffb325db84dd35cb1b76b31d7074da156`, the `kwaroran/main` ref, 2026-11-10    |
| Inventoried through    | `f50b5942ec6aa59aa3c56049ac687ca09667fec7` before this plan; the new head after 14 |
| Metatron head checked  | `3cc8b2d562a32ab881717e14146a4eb78ed7d12c`, `dev`                                  |
| Compatibility version  | `2026.10.220` now; `2026.10.295` after slice 14 (STRUCTURE.md R1)                  |
| Harness current target | `f50b5942`, kept (D6): no commit in the range changes the save format              |

The range was read from this repository's `kwaroran` remote, not from the upstream checkout the ledger's procedure
names: that checkout still sits at `f50b5942` with a clean tree and was not touched. `f50b5942` is an ancestor of
the new head, so no history was rewritten. Upstream paths below are paths in upstream's tree; read one with
`git show kwaroran/main:<path>` and a commit with `git show <sha>`.

Merges: 12 of the 13 match Git's automatic merge (`git show --remerge-diff` prints nothing). `5365e410d` differs
only in upstream's Tauri `main.rs`, which Metatron does not have. No merge needs a row.

## Order

- Plugins, serial (slices 1–6 share `factory.ts`, `v3.svelte.ts`, the language files, or `plugins.md`): 1 → 2 → 3 → 4 →
  5 → 6. Slice 12 may run alongside 1–3 and must land before 4, because it adds keys to the same `src/lang/en.ts` and
  `src/lang/ko.ts`.
- Server: 7 is independent.
- Client, independent of each other and of the chains above: 8, 9, 10, 11, 13; and 12, apart from landing before 4.
- Close-out: 14 after every other slice landed or was dropped by a decision.

Priority when slots are short: 7, 8, 9, 10, 12 first (authorization and markup boundaries), then 4, 3, 1, 2, then
the rest.

## Slice 1. Mutation observer records cross the bridge with their removed nodes (_small_, `plugin-sandbox.md`)

Upstream `8da6d954e`, `39dbc3151`.

- `src/ts/plugins/apiV3/factory.ts`: a callback's arguments are not converted in either direction. In
  `GUEST_BRIDGE_SCRIPT` the callback path maps `data.args` and ends with `return a` (~393): return
  `deserializeResult(a)`. In `SandboxHost.deserializeArgs` the callback wrapper's `sanitizedArgs` ends with
  `return arg` (~697): return `this.serialize(arg)`. Without both, a `SafeClassArray` of `SafeMutationRecord`
  reaches the plugin's observer callback as an empty shell.
- `src/ts/plugins/apiV3/v3.svelte.ts` `SafeMutationObserver` (~603–632): `removedNodes` is computed and then
  dropped, since `SafeMutationRecord` is constructed with the added nodes only. Add the field, the constructor
  argument and `getRemovedNodes()`; declare it in `src/ts/plugins/apiV3/risuai.d.ts` beside `getAddedNodes()`.
- Keep the abort-signal mirroring, stream replacement and rollback around both sites as they are.
- `plugin-sandbox.md`: callback arguments are serialized like call arguments.
- Test:
  - `src/ts/plugins/apiV3/guestBridge.test.ts`: a host callback invoked with a remote-required instance reaches the
    guest function as a proxy whose method call answers (it fails today with the raw wire object).
  - `src/ts/plugins/apiV3/hostApi.test.ts`, beside the DOM wrapper cases: `createMutationObserver` reports an added
    and a removed element through `getAddedNodes()` and `getRemovedNodes()`.

## Slice 2. Guest proxies release their host instances (_hard_, `plugin-sandbox.md`)

Depends: 1 (`factory.ts`). Upstream `0b4eb929b`, `89efce436`, `bb49b30ca`, `1309ee299`.

- `factory.ts` guest side: the proxy cache is a strong `Map` (~67) and nothing releases an instance until the
  sandbox ends, so every `SafeElement` a plugin ever received stays in `instanceRegistry`. Hold proxies in a
  `WeakMap`, register each with a `FinalizationRegistry` whose held value is the ref id, and keep the owner proxy
  alive from the method closures `deserializeResult` hands out (~116–124).
- Release messages are batched: collect finalized ids and post one `RELEASE_INSTANCE` with `ids` per microtask;
  `RpcMessage` gains `ids?: string[]`, and the host handler (~1030) deletes `id` and every entry of `ids`.
- `SandboxHost.serialize` (~606–613): ids come from a per-host counter, not `Math.random`, so a release can never
  name a later instance.
- `SandboxHost.deserializeArgs` (~719–724): a `REMOTE_REF` whose instance is gone throws
  `Instance not found or released` instead of passing the wire object to the host API.
- Keep the message-source check (~993), the teardown that clears the registry (~1203), and the callback cache.
- `plugin-sandbox.md`: the release contract, in `Invariants`.
- Test, with a fake `FinalizationRegistry` (no real garbage collection, V3):
  - `guestBridge.test.ts`: finalizing three proxies in one turn posts one message carrying three ids; the fake registry
    receives each proxy with its ref id, and each simulated finalization releases its id once. That a method taken from
    a proxy keeps its owner alive is a source-review point (the closure references the owner proxy, as upstream's does),
    not a test: a fake finalizer cannot prove reachability.
  - `sandboxActivity.test.ts`: a batched release empties those registry entries; a released ref passed as an
    argument rejects and the host API is not called; two serialized instances get distinct increasing ids.

## Slice 3. Plugin fetch blocks hosts, not substrings (_small_, `plugin-sandbox.md`)

Depends: 2 (the serial chain). Upstream `afb5918bb`.

- `v3.svelte.ts` `urlBlacklist` (~967) is applied with `url.toLowerCase().includes(blocked)` in `risuFetch`
  (~2274) and `nativeFetch` (~2293): a path or query that contains a blocked name is refused, and a URL the
  browser resolves to a blocked host by another spelling is not parsed at all.
- Add one helper beside the list: parse the URL alone and against `location.href`, lowercase the hostname and
  strip trailing dots, refuse when a hostname equals a blocked name or ends with `.` plus it, and throw
  `Invalid URL` for a non-string or unparsable value. Call it first in both functions.
- Test, in `src/ts/plugins/apiV3/nativeFetch.test.ts`, for both functions: a blocked host, a subdomain, a
  trailing-dot host and a mixed-case host are refused; a blocked name in a path or query passes; a
  protocol-relative URL naming a blocked host (`//risuai.xyz/x`) is refused; a relative path is checked against the
  page URL and passes when its resolved hostname is allowed; a non-string throws. Each transport still receives the
  caller's original string, so `risuFetch`'s handling of relative URLs is unchanged.

## Slice 4. Database writes need the `dbWrite` permission (_hard_, `plugin-sandbox.md`)

Depends: 3, and 12 (`src/lang/en.ts`, `src/lang/ko.ts`). Upstream `43e5576df`. Decision D1.

- Today a plugin holding no grant at all can call `setDatabase`, `setDatabaseLite`, `setChar`, `setCharacter`,
  `setCharacterToIndex` and `setChatToIndex` (`v3.svelte.ts` ~2341, ~2475, ~2480, ~2723, ~2854, ~2923): `db` gates
  only the readers. Upstream now asks for `dbWrite` before each of the six and skips the write on a refusal.
- Add `dbWrite` to `pluginPermissions` (~795) and its consent text to the prompt chain (~924–940; a record keyed
  by permission, as upstream did, removes the `Error` fallback). Language key `dbWriteConsent` in
  `src/lang/en.ts` and `src/lang/ko.ts`.
- One guard, asked `periodically` like `db`, placed after `refuseTransformWrite` and before validation, chat loading and
  the plugin-install confirmation. Capture the call's plugin context and settings write scope, the selected target ids
  for selection-based setters, and the ids resolved from supplied indexes for indexed setters before awaiting the guard;
  after a grant, validate and write only those captured targets. A refusal warns and changes nothing (the guide's write
  rule).
- Grants stay in Metatron's server-owned permission resource, keyed by script hash and permission. No record is
  written directly.
- A `db` grant does not count as `dbWrite`: a plugin that already reads is asked again before its first write
  (owner, 2026-11-10).
- `plugins.md` and `risuai.d.ts`: the permission and the six gated calls. `plugin-sandbox.md`: `Invariants`, and
  drop the part of the Known Hazards capability entry this closes, if any.
- Test, in `src/ts/plugins/apiV3/permissions.test.ts`: each of the six calls prompts once, writes after a grant,
  and writes nothing after a refusal; a transform continuation is refused before any prompt; a grant for one
  script hash does not cover a changed script; a plugin holding only `db` is still asked. Update
  `src/ts/plugins/apiV3/v3SetDatabase.test.ts` and `v3SetPersonas.test.ts`: their setter calls arrange a `dbWrite`
  grant with a current `lastGrantTime` (the seeded fixture holds only `db`) and await the setter.

## Slice 5. The install confirmation names the plugin and says when it replaces one (_small_, `plugin-sandbox.md`)

Depends: 4 (`src/lang/en.ts`, `src/lang/ko.ts`). Upstream `83eb7880b`.

- `src/ts/plugins/plugins.svelte.ts` `handlePluginInstallViaPlugin` (~736–756) already replaces `{plugin}`, but
  `confirmInstallPluginViaPlugin` in `src/lang/en.ts` (~3565), `src/lang/ko.ts` (~3455) and `src/lang/zh-Hant.ts`
  (~1423) has no such
  placeholder, so the dialog never names the plugin. A same-name plugin with a different script gets the same
  install wording.
- Put `{plugin}` into the install text in all three files, add `confirmReplacePluginViaPlugin` to all three, and
  pick it when `settings.plugins` already holds the name. `risuai.d.ts`: the two documentation blocks upstream reworded.
- Test (no test reads the dialog text today; `src/ts/plugins/apiV3/v3SetDatabase.test.ts` covers the setter): a
  new plugin's dialog contains its name; a changed script under an installed name gets the replace text; an
  identical plugin asks nothing.

## Slice 6. `plugins.md` examples await the API (_small_, `plugin-sandbox.md`)

Depends: 1 and 4 (`plugins.md`). Upstream `385f6a5db`, `7550a60bf`, `3eb463078`, `71983e768`, and the
`plugins.md` parts of `fc9eb42a2` and `dd585480d`.

- No upstream hunk applies as text (Metatron's examples use double quotes and have diverged), so reword by
  hand: the missing `await`s at ~383, ~1566–1569, ~1611–1624, ~1631–1641, ~1760 and ~1773–1782; Example 3's
  observer skips mutations of its own indicator (upstream marks it with an `x-dom-monitor` attribute).
- After slice 1 the removed-node text is true here: document `getRemovedNodes()` and that records carry
  `HTMLElement`s only (no text nodes, no SVG).
- Check each changed call against `risuai.d.ts`. `createAnchorElement()` is declared synchronous there but is
  asynchronous through the guest proxy: fix the declaration in this slice.
- No test; `pnpm format:check`.

## Slice 7. The proxy routes accept a JWT only (_small_, `self-host-server.md`)

Upstream `4a1ff45c6`.

- `server/src/routes/auth.ts` `checkProxyAuth` (~205) and `isAuthorizedProxyToken` (~217) accept the stored
  password digest in `risu-auth`, so a digest that leaks once opens `/proxy` and `/proxy2` forever without a
  registered key. The tab already sends a JWT there (`getNodeServerProxyAuth` in `src/ts/storage/serverAuth.ts`).
- Make `checkProxyAuth` the same rule as `checkAuth` and remove `isAuthorizedProxyToken` if nothing still calls
  it; update the module header (~22) and the comment in `server/src/routes/proxy.ts` (~160).
- `self-host-server.md`: the proxy route line and the authentication flow.
- Test: `server/src/tests/proxy.test.ts` (~32–54 pins the digest) and the matching case in
  `server/src/tests/app.test.ts`: the digest is refused with the usual authentication answer; a registered JWT
  passes; an auxiliary operation is unchanged.

## Slice 8. The trigger effect list escapes stored values (_small_, `scripts-triggers.md`)

Upstream `8a50627b1` (the `TriggerV2List.svelte` hunk).

- `src/lib/SideBars/Scripts/TriggerV2List.svelte` `formatEffectDisplay` (~2278–2325) builds markup from an
  effect's own fields and the list renders it with `{@html}` (~2982): a value such as an image tag with an error
  handler, in a trigger of an imported card or module, runs when the editor opens. `indent` is written into a
  `style` attribute unchecked.
- Escape `&`, `<`, `>`, `"` and `'` in every interpolated field and in the fallback `type`; numbers and booleans
  pass through; `indent` becomes `Number(indent) || 0`.
- Move `formatEffectDisplay`'s string building into `src/lib/SideBars/Scripts/triggerEffectDisplay.ts`, which the
  component imports, so it can be tested without mounting the editor; keep the component's existing support decision
  (~601, ~2281) by passing it in or keeping it in the component.
- Test, `src/lib/SideBars/Scripts/triggerEffectDisplay.test.ts`: a value with markup comes back as text; a quote
  cannot close an attribute; a non-numeric `indent` yields `0rem`; a plain effect's output is unchanged.

## Slice 9. Rendered Markdown is parsed in its node's own document, and external links carry `rel` (_small_, `cbs-rendering.md`)

Upstream `8a50627b1` (the parser hunk) and `2229a7f4d` (the parser hunk).

- `src/ts/parser/parser.svelte.ts` `applyMarkdownToNode` (~1641–1658) creates its span with the page's
  `document` and assigns `innerHTML`: markup assigned to an element of the live document can load resources and
  fire handlers before sanitizing, which an element of the parsed (inert) document cannot. Use
  `node.ownerDocument.createElement`.
- The `href` case of the `uponSanitizeAttribute` hook (~165–170) sets `target="_blank"` on external links and
  nothing else: add `rel="noopener noreferrer"` to those links (upstream adds a `rel` case that always writes
  that value).
- Test, in `src/ts/parser/tests/trimMarkdownStyle.test.ts` or a sibling: with the parsed document arranged first and
  then the live document's `createElement` made to throw, a node of a `DOMParser` document holding Markdown such as
  `**bold**` still gets its rendered span (ownership after insertion proves nothing: insertion adopts the node); an
  external link renders with the `rel` value and a card-supplied `rel` is
  replaced.

## Slice 10. Translated HTML is rebuilt in the parsed document (_small_, `translation.md`)

Upstream `8a50627b1` (the translator hunk).

- `src/ts/translator/translator.ts` `translateHTML` parses into `dom` (~700) but builds replacement nodes with
  the page's `document` and assigns translated text as `innerHTML` (~867; the same pattern at ~744 and ~748,
  which upstream's hunk does not reach). Create all three from `dom`.
- Test, in `src/ts/translator/translateHtmlLifetime.test.ts` or a sibling: with the global
  `document.createElement` made to throw, a translation that replaces a node still succeeds, and the replacement
  belongs to the parsed document.

## Slice 11. Alerts open above a plugin's full-screen frame (_small_, `global-api.md`)

Upstream `d5f3bc325`. Decision D5.

- A plugin's container frame is fixed to the body at `z-index: 1000` (`v3.svelte.ts` ~2948); the alert overlays
  in `src/lib/Others/AlertComp.svelte` are `z-50` (~309, ~953, ~1027, ~1048, ~1056), with the
  delegated branches at ~1036, ~1133 and ~1137 (their child overlays use layers 40 or 50). A confirmation raised while
  the frame is open, a permission prompt included, can open underneath it.
- Upstream raised its one overlay to `z-1100`. Here the overlays are `absolute` inside the app root, so first
  confirm in a browser which stacking context they sit in; raise the overlays above the frame, or wrap
  every alert branch in a real alert-only stacking wrapper (the existing `class="contents"` wrappers do not make
  one). `v3.svelte.ts` is read only here.
- Test: a browser check, since happy-dom has no layout. No spec opens a container today; in
  `e2e/pluginSandbox.spec.ts`, a plugin calls `showContainer("fullscreen")` and then a call that asks for a
  permission: `document.elementFromPoint` at the dialog's center is inside `[data-alert-dialog]`.

## Slice 12. A module file or link cannot bring an MCP server (_small_, `characters-modules.md`)

Upstream `a0598d546`. Decision D2.

- A module's `mcp.url` is used as an MCP server once the module is enabled (`getModuleMcps`,
  `src/ts/process/modules.ts` ~873). Module files, module JSON and `#import_module=` links keep an `mcp` field
  they carry, so importing one adds a tool server the user never typed in. Metatron confirms `lowLevelAccess` on
  these paths (upstream `9b1415461`, already covered) but not `mcp`.
- Delete `mcp` at the file and link import boundaries only: `readModule` (~211), `importModuleFile` (~349) and
  the JSON branch of `importModule` (~564–623) in `src/ts/process/modules.ts`, and the `#import_module=` branch
  of `characterURLImport` (~816) in `src/ts/characterCards.ts`. `importMCPModule` (`src/ts/process/mcp/mcp.ts`),
  `normalizeModule` and the stores keep the field: MCP modules stay supported, they are just not importable
  from a file.
- Say so (owner, 2026-11-10): when a module the user picked (a file, JSON, or a link) carried an `mcp` field, show
  one toast (`alertToast`, `src/ts/alert.ts`) that its tool server was not imported. Toasts share one status slot
  with the import's own progress (`src/ts/alertQueue.ts`), so carry a transient was-present flag from the strip and
  install the toast after a successful import's final status handling (`addImportedModule`, `modules.ts`
  ~520–551); keep any success dialog, after whose dismissal the toast shows. Declined or failed imports keep their
  existing error or cancellation behavior. A new language key in
  `src/lang/en.ts` and `src/lang/ko.ts`. No toast when the field was absent. `readModule` itself strips without
  a message, since it also reads modules embedded in cards.
- `characters-modules.md`: the import rule.
- Test, in `src/ts/process/modulesImport.test.ts`: each of those paths yields a module without `mcp`; the three
  user-facing paths leave the toast in the status slot when the field was present (and, after the success dialog is
  dismissed where there is one, as the visible alert) and add nothing otherwise; `importMCPModule`
  still stores its URL.

## Slice 13. `fetchNative` keeps the caller's abort after the headers arrive (_small_, `network-jobs.md`)

Upstream `34f04fd76` (the behavior; its code is Tauri's).

- `src/ts/globalApi.svelte.ts` `buildTimeoutSignal` (~619–647) wraps the caller's signal when a timeout is
  given, and `fetchNative` (~1236–1303) runs its `cleanup` in `finally`, as soon as the response object exists.
  The cleanup removes the abort listener, so with `requestTimeoutMs` set an abort during the body no longer
  reaches the request and the stream keeps running. Without a timeout the caller's signal is passed through
  and works.
- Keep the abort forwarding alive until the body ends: clear only the client timer when the headers arrive
  (the client timeout stays a limit on the wait for headers, as now; the `/proxy2` server timer set from
  `risu-timeout-ms` keeps covering the body, unchanged), and drop the listener when the body finishes, errors or
  is cancelled, on all three return branches (userscript ~1251, `/proxy2` ~1287, direct ~1292), a rejected fetch
  and a response without a body included.
- `globalFetch` (~772) uses the same helper but reads the whole body before its cleanup; leave it.
- Test, in `src/ts/globalApiNativeFetch.test.ts`: with a timeout set, aborting after the headers errors the body
  read and aborts the underlying request; the timer no longer fires after the headers; no listener is left on
  the caller's signal once the body ends.

## Slice 14. Close the intake (_small_, `build-test-platforms.md`)

Depends: 1–13 (each landed, or dropped by a decision).

- [The ledger](../research/upstream-ledger.md): one row per non-merge commit from the Inventory, in
  `git rev-list --reverse --topo-order f50b5942..4d87a70ff` order, with `integrated` and the Metatron commit for
  each ported row; a Partial ports entry for every slice that ported less than the upstream commit (the three
  hunks of `8a50627b1`, the one hunk of `2229a7f4d`, the `plugins.md` halves of the documentation commits, the
  behavior-only port of `34f04fd76`); the Merges paragraph for this range; deferred rows with their triggers.
- Baseline table: observed head, inventoried-through and triaged-through move to `4d87a70ff`; "Metatron
  checked" to the commit of this slice; the harness targets stay (D6), with the reason.
- Intake procedure step 2: allow reading the range from the `kwaroran` remote of this repository, as this
  intake did, with the same ancestor check.
- Compatibility version (R1): `version.json` and `appVer` in `src/ts/storage/database.svelte.ts` to
  `2026.10.295`, in this commit.
- [Research README](../research/README.md): the ledger row's range and commit count.
- Do not archive this plan or edit `docs/plan/README.md` here: retiring the plan is the orchestrator's step
  after every slice landed, with the user's yes.

## Inventory

All 53 non-merge commits in `f50b5942..4d87a70ff`. "Slice" is a slice of this plan.

### Plugins

| Upstream                                                         | Disposition | Evidence or slice                                                                                                                                                |
| ---------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `67cc80cf4` unload every V3 plugin on reload                     | equivalent  | `loadV3Plugins` iterates a copy of `v3PluginInstances` (Metatron `6a1ef3e83`); the lifecycle tests end both old sandboxes                                        |
| `42fe0ee90` remove V3 replacers on unload                        | equivalent  | `addRisuReplacer` registers an unload callback that deletes the replacer from `pluginHooks` (`v3.svelte.ts` ~2458, Metatron `0d7c1cd64`)                         |
| `83eb7880b` plugin name in the install confirm, replace warning  | gap         | slice 5                                                                                                                                                          |
| `8da6d954e` mutation observer payloads across the bridge         | gap         | slice 1                                                                                                                                                          |
| `39dbc3151` removed nodes in mutation records                    | gap         | slice 1                                                                                                                                                          |
| `0b4eb929b` auto-release instance registry entries               | gap         | slice 2                                                                                                                                                          |
| `89efce436` monotonic instance ids                               | gap         | slice 2                                                                                                                                                          |
| `bb49b30ca` reject released remote refs                          | gap         | slice 2                                                                                                                                                          |
| `1309ee299` batch release messages                               | gap         | slice 2                                                                                                                                                          |
| `43e5576df` `dbWrite` permission                                 | gap         | slice 4                                                                                                                                                          |
| `afb5918bb` allowed URL check                                    | gap         | slice 3                                                                                                                                                          |
| `9b1415461` low level access confirmation in `readModule`        | equivalent  | `importModuleFile`, the JSON import and the module link confirm `lowLevelAccess` before any upload or write (Metatron `278ac122b`); a refusal cancels the import |
| `a0598d546` trim MCP data from modules                           | gap         | slice 12                                                                                                                                                         |
| `fc9eb42a2`, `dd585480d` removed-node and SVG notes              | gap         | slice 6, after slice 1, `plugins.md` only; the migration guide half is excluded (Metatron has no `migrationGuide.md`)                                            |
| `385f6a5db`, `7550a60bf`, `3eb463078`, `71983e768` example fixes | gap         | slice 6, `plugins.md` only                                                                                                                                       |
| `6982d982e` await `setStyle` in the migration guide              | excluded    | touches only the migration guide, which Metatron does not have                                                                                                   |

### Server, hub and markup

| Upstream                                           | Disposition | Evidence or slice                                                                                                                                                                                                                                          |
| -------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `f5c563110` node magic link                        | excluded    | A setup token printed to the log of upstream's single-file server, for the first password. Metatron's first setup is `POST /api/set_password`, unauthenticated by design and rate limited (`self-host-server.md` Limitations); D4                          |
| `49f12c8d5` `isHex` without the password exception | equivalent  | Flat hex storage is gone (Metatron `22fee141d`): storage exposes only the assets namespace and cannot resolve the password file; tests refuse `__password`                                                                                                 |
| `4a1ff45c6` JWT only on the proxy routes           | gap         | slice 7                                                                                                                                                                                                                                                    |
| `8a50627b1` escapes                                | gap         | slices 8, 9, 10. Its server hunk (a whitespace-only password) is equivalent: `readPasswordState` treats such a file as damaged and `isStoredPassword` needs a non-empty token                                                                              |
| `4b0aa2f7e` nonce in the Drive sign-in             | excluded    | Metatron has no Google Drive backup and no OAuth return path: `src/ts/drive/` holds the local and server archive clients only                                                                                                                              |
| `2229a7f4d` `isTrustedHubOrigin`                   | gap         | slice 9 for the parser hunk. The other four hunks are excluded or equivalent: no login or account `postMessage` handler and no `sionyw.ts` exist, and the hub is reached through the same-origin `/hub-proxy`, whose redirects must stay on the hub origin |
| `d5f3bc325` alert overlay layer                    | gap         | slice 11                                                                                                                                                                                                                                                   |

### Tauri and removed backends

| Upstream                                                 | Disposition | Evidence or slice                                                                                                                                                                                    |
| -------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `34f04fd76` cancel the streamed fetch on abort           | gap         | slice 13: Tauri's code is absent, but the browser path loses the caller's abort after the headers when a timeout is set                                                                              |
| `97fc3253f` keep fetches of a previous page load apart   | excluded    | Tauri IPC fetch ids; Metatron's `fetchNative` uses `fetch`, a userscript fetch or `/proxy2`                                                                                                          |
| `49ea89cf9` idle timeout instead of the 240 s cut        | excluded    | The 240 s total limit was Tauri's. Metatron's client sets no limit unless one is requested; see Not In This Plan for the idle watchdog                                                               |
| `dec7ca328` ignore a resent `streamed_fetch` invoke      | excluded    | Tauri IPC                                                                                                                                                                                            |
| `ac29c940b` do not throw on an abort before headers      | excluded    | Tauri path. Metatron's `fetchNative` deliberately follows `fetch` and rejects on abort (Metatron `6a1ef3e83`); callers check their own signal                                                        |
| `24c6e8a8b` narrow two Tauri comments                    | excluded    | Comments on code Metatron does not have                                                                                                                                                              |
| `edd60ff50` streamed fetch errors as valid JSON          | excluded    | Tauri's Rust-to-page error envelope                                                                                                                                                                  |
| `192543de2` shell permission in the capabilities file    | excluded    | Tauri capabilities                                                                                                                                                                                   |
| `7f3b2fae0`, `e7a42bd12` remove the local Python backend | equivalent  | Removed with the desktop build (Metatron `49c4eb170`); token counting is server-side, and `LLMTokenizer.Local` survives only as a stored-value mapping (`shared/tokenizerChoice.ts`)                 |
| `41ea80377` block MCP stdio                              | equivalent  | No process transport exists: an entry with a command is refused in the tab (`src/ts/process/mcp/mcp.ts`) and on the server (`server/src/mcp/jobTools.ts`), covered by `server/src/tests/mcp.test.ts` |

### Build, dependencies and versions

| Upstream                                                                                   | Disposition | Evidence or slice                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `f60061af1`, `6b81da1e5`, `6063f064a` pnpm 11                                              | deferred    | Metatron pins pnpm 10.34.1 in `package.json` and the Dockerfile and has no `pnpm-workspace.yaml`. The one policy worth having now, `minimumReleaseAge` (three days), works on pnpm 10 and was set in `.npmrc` on 2026-11-10, outside this plan. Revisit when pnpm 10 stops receiving fixes or `allowBuilds` is wanted; D3 |
| `2692fc82a` Hono runtime policy                                                            | equivalent  | Node 24 or later is required and documented, stricter than upstream's 22.13; upstream's `server/hono/` half has no target here                                                                                                                                                                                            |
| `992c8dfc2`, `883dee295`, `56bc5ce2f` nightly and Cloudflare deploy                        | excluded    | Metatron has one workflow (`ci.yml`) and no Cloudflare deployment                                                                                                                                                                                                                                                         |
| `9dfa386b0` dependency update and tests                                                    | equivalent  | Metatron keeps its own dependency set: 15 of the changed ranges match, 5 are ahead by a major or minor, 9 are behind by patch-level ranges (routine), 9 are unused. The DOMPurify 3.4.17 `nodeName` break is handled by the shim in `vitest.setup.ts`, not by a move to jsdom                                             |
| `86614d7ca` `experimental.async` and effect-order fixes                                    | deferred    | No flag is set and nothing needs it. The Hypa modal initializes its data synchronously; `CharConfig.svelte` creates its four TTS configs in `$effect.pre`, which is safe only without the flag. Revisit when a feature needs Svelte's async syntax or Svelte makes it the default; D7                                     |
| `da89a0dcb`, `f6bf8d82e`, `ea61945f9`, `5bd64e475`, `aea458b1a`, `4d87a70ff` version bumps | excluded    | `appVer` follows the triaged release (slice 14)                                                                                                                                                                                                                                                                           |

Totals: 21 gap (slices 1–13), 9 equivalent, 19 excluded, 4 deferred.

## Decisions

The owner accepted every default on 2026-11-10; the slices are written for them.

- D1. Scope of `dbWrite`. Options: (a) the six calls upstream gates; (b) those plus Metatron's other record
  writers that pass `refuseTransformWrite` (`setArg`, `saveAsset`, the theme and color-scheme setters,
  `checkCharOrder`). Default (a): the permission's name and consent text are upstream's contract, and plugins
  written for upstream expect a prompt on exactly those calls. Every installed plugin that writes is asked at its
  first gated write after this lands; like `db`, the answer stays cached until unload or an earlier permission
  invalidation, and a grant older than three days is asked again on the next uncached check. Reset and revocation
  stay as they are.
- D2. A module's `mcp` field on import. Options: (a) drop it on file and link imports, as upstream does; (b) keep
  it behind a confirmation that shows the URL. Default (a), with a toast when a field was dropped; a user adds a
  tool server through the MCP import.
- D3. pnpm 11. Options: (a) defer with the trigger in the Inventory; (b) a tooling slice now (the workspace file,
  `allowBuilds`, the Dockerfile and CI pins, STRUCTURE.md Tooling). Default (a): the release-age policy is
  already set in `.npmrc`, and nothing else in Metatron needs 11. A later move must carry the `.npmrc` settings
  into `pnpm-workspace.yaml`: pnpm 12.4.2 was seen to ignore them in `.npmrc`.
- D4. A first-setup token like upstream's magic link. Options: (a) keep first setup unauthenticated, as the
  server guide records; (b) plan a token printed at startup. Default (a), not in this plan.
- D5. Which overlays move above the plugin frame. Options: (a) every `AlertComp` overlay; (b) only the dialog
  overlay that carries confirmations and inputs. Default (a).
- D6. The save harness target. Options: (a) keep `f50b5942` as `current`; (b) update the upstream checkout and
  add `4d87a70ff`. Default (a): the range changes `database.svelte.ts` only in its version line.
- D7. `experimental.async`. Default: deferred with the trigger in the Inventory; the `CharConfig.svelte`
  readiness guard is part of that later work, not a defect today.

## Not In This Plan

- An idle watchdog for streamed requests (the idea behind `49ea89cf9`): the proxy's timer comes only from
  `risu-timeout-ms` and is not reset per chunk, and `server/src/llm/transport.ts` clears its timer after the
  headers. No stalled stream has been reported; adding one is a design of its own.
- The patch-level dependency ranges behind upstream (`@mlc-ai/web-llm`, `core-js`, `mnemonist`, `ws`,
  `@types/lodash`, `autoprefixer`, `svelte`, `svelte-check`, `tslib`): the next routine dependency round.
- The defects in [known issues](../research/known-issues.md) that sit beside these slices (JWT claim checks, the
  unauthenticated `/hub-proxy`, the reach of `mainDom` and `nativeFetch`): slice 7 and slice 4 narrow two of
  them but close none; they keep their entries.
- Updating the upstream checkout the save harness reads (D6).

## Open Questions

None open. The owner answered both on 2026-11-10; the slices carry the answers.

- Slice 4: should a grant a plugin already holds for `db` carry over to `dbWrite`? No: reading and writing are
  different consents, so each writing plugin is asked once after the update.
- Slice 12: should the import say that a tool server was removed, where upstream drops `mcp` silently? Yes, with
  a toast.
