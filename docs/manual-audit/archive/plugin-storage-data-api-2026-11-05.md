# Plugin Storage and Data API audit — 2026-11-05

## Scope and result

Reviewed the current `dev` implementation at
`65e97f91f22418df49452e76e46af7a145b144f1`, which was also `origin/dev` when the
audit began. The checkout was initially clean. Retrieve the retired plan with:

```sh
git show 58496058f69890de657d4cd3e5172bc5c1efb129^:docs/plan/plugin-storage.md
```

The audit follows the plan's implementation commits: `c140f2db7`, `d5c824f99`,
`b3e3417a8`, `c81a3fab7`, `2b778c365`, `86ac8b272`, `d7e305392`, `aab3052ef`,
`142c3920e`, `e6e02d2ba`, and the guide pass `aa6687b96`. Later changes on `dev`
were included when checking their current callers. Two Luna agents located files
and instructions; four audit agents reviewed storage/permissions, patch
transport, detached reads/cache, and scoped reads/setters. The primary review
checked the evidence and integration paths.

**Two plan-related correctness defects and seven performance opportunities were
identified.** Two pre-existing findings encountered along those paths are
recorded separately. No product fix is included. P2 denotes a correctness issue
or a material, reproducible source of avoidable work; P3 denotes a narrower
optimization supported by source analysis. Performance opportunities are not
automatically violations of the plan: several are deliberately conservative
fallbacks or costs outside its original acceptance measurements.

| ID  | Priority | Kind                  | Finding                                                                            |
| --- | -------- | --------------------- | ---------------------------------------------------------------------------------- |
| PS1 | P2       | Bug, D3               | An older consent write can restore a remotely revoked permission                   |
| PS2 | P2       | Bug, D7/D8            | Switching to Structured Memory during a detached read omits its projection         |
| PS3 | P2       | Traffic, D4           | Small writes still cause whole-record downloads in observing tabs                  |
| PS4 | P2       | CPU/allocation, D4    | A tiny nested storage patch still traverses megabytes of unchanged JSON repeatedly |
| PS5 | P2       | Traffic/cache, D8     | Structured Memory chats are retained in a cache that will not reuse them           |
| PS6 | P2       | Traffic, D7/D8        | Concurrent cold reads download the same chats independently                        |
| PS7 | P2       | CPU/allocation, D10   | A one-chat page repeatedly constructs the whole character's chat list              |
| PS8 | P2       | Traffic/memory, D10   | A blocked flush makes a loaded one-chat page fetch every other chat                |
| PS9 | P2       | CPU/allocation, D6    | Indexed storage enumeration repeatedly scans every plugin's keys                   |
| U1  | P2       | Pre-existing bug      | The sandbox drops an own `__proto__` field from a returned JSON value              |
| U2  | P3       | Pre-existing CPU cost | Character reconciliation repeatedly scans the full character list                  |

All findings below describe the audited revision and remain unfixed by this
report. Byte counts are serialized, uncompressed JSON unless otherwise stated;
they are not measurements of compressed network traffic. Operation counts are
deterministic work measurements, not browser latency benchmarks.

## Plan-related correctness findings

### PS1 — An older consent write can restore a remotely revoked permission

**Code.** [permissionStore.ts](../../../src/ts/plugins/apiV3/permissionStore.ts),
`recordPermissionGrants`, lines 99–132;
[v3.svelte.ts](../../../src/ts/plugins/apiV3/v3.svelte.ts), removal listener at
786–789 and consent completion at 903–916. D3 introduced revocation, but the
existing grant conflict loop still treats every conflict as an additive merge.

**Reproduction.** A temporary probe using the existing permission harness and
`FakeResourceServer` controlled the request order:

1. Seed an expired `db` grant so tab A needs periodic confirmation.
2. Accept that confirmation in A, but hold its grant/timestamp PUT before the
   server applies it.
3. Have tab B reset the plugin's permissions and successfully commit empty
   `grants` and `lastGrantTime` maps.
4. Release A's older PUT. It conflicts, fetches B's newer state, then retries.

Observed: the retry stores `db: true` again, and A's
`getDatabase([], { chats: "summaries" })` returns `{}`. The assertion that the
reset leaves no grant fails. **No user consent occurs after the reset.** A second
probe also reproduced an already-open remote prompt regranting after reset.

**Cause and impact.** Conflict recovery blindly reapplies the original
`added.grants` to the latest state. A remote removal only clears cached granted
answers; it does not advance the `permissionResetGenerations` used to invalidate
pending consent. Reset therefore cannot reliably revoke an in-flight permission
operation in another tab. The author contract also explicitly says a prompt
open during reset answers `false`
([plugins.md](../../../plugins.md#permissions), lines 1343–1345).

**Suggested fix and regression.** Give consent operations a revocation/reset
generation that is checked across tabs and at persistence. A conflict retry must
distinguish an independent grant from removal of the grant it is trying to
renew. Invalidate pending prompts on remote reset as well. Test both the
accepted-before-reset delayed PUT and the still-open remote prompt; preserve
merging of unrelated grants.

### PS2 — Switching to Structured Memory during a detached read omits its projection

**Code.** [v3.svelte.ts](../../../src/ts/plugins/apiV3/v3.svelte.ts), fresh detached
reads at 1301–1316, final assembly at 1361–1368, and
`refreshChatProjections` at 1034–1038;
[detachedChatCache.ts](../../../src/ts/plugins/apiV3/detachedChatCache.ts), cache-hit
algorithm checks at 129–137.

**Reproduction.** A temporary `StoreBackedServer` probe used real stored memory
events and the server's projection path:

1. Store a Structured Memory event while the selected algorithm is `hypaV3`.
2. Start `getDatabase(["characters"])` for an unloaded chat and let the server
   form the response under that algorithm.
3. Before delivering the response, change the server and held UI settings to
   `structuredMemory`.
4. Compare the returned chat with an immediate read through the loaded/hook
   path.

The detached result has no `hypaV3Data`; the loaded result contains the stored
summary, `A remembered promise`.

**Cause and impact.** Cache hits are checked against the current algorithm,
but a fresh response is only tagged with the algorithm captured before the
await. It is not checked again before this call returns it. Final assembly can
remove a sealed projection when leaving Structured Memory, but cannot supply
one when entering it. Projection refresh only operates on loaded chats, so it
does not repair this unloaded result. A plugin reading across a settings change
can receive a different legacy memory view depending on whether the chat was
already loaded. This is an incorrect read, not evidence that stored memory was
deleted.

**Suggested fix and regression.** Fence fresh detached responses by the captured
algorithm, as cache hits already are. Retry or explicitly refresh detached
projections when it changes. Test both switch directions with a response held
between server preparation and client assembly.

## Performance and traffic opportunities in the audited features

### PS3 — Small writes still cause whole-record downloads in observing tabs

**Code.** [resourceStore.ts](../../../server/src/data/resourceStore.ts),
`feedPatch`, lines 3418–3434;
[recordPatch.ts](../../../shared/recordPatch.ts), `diffFields`, lines 312–326;
[recordPatchText.ts](../../../server/src/data/recordPatchText.ts), lines 155–158;
[resourceSync.svelte.ts](../../../src/ts/storage/resourceSync.svelte.ts),
`noteRemoteChanges` at 4841–4861 and full reads at 5271–5274.

The write protocol understands reserved-dictionary entry patches and plugin
names. The live-update feed still describes top-level fields and id-keyed list
items. A changed storage dictionary therefore exceeds the feed's 64 KiB patch
cap when it contains large values. Ordinary plugin lists have names rather than
ids and cannot use that list diff. Both changes publish a reference without a
patch; observing tabs then fetch the full resource.

A standalone probe used the real resource store, default kinds, in-memory
SQLite, and actual change publication:

| Mutation                                            | Write-operation JSON | Whole stored JSON | Published update |
| --------------------------------------------------- | -------------------: | ----------------: | ---------------- |
| Owned counter next to a 2 MiB history               |                173 B |       2,097,228 B | Reference only   |
| One toggle in ten plugins with 100 KiB scripts each |                170 B |       1,024,472 B | Reference only   |

The feed output and byte sizes were measured; the subsequent observing-tab
download follows the verified client path above. HTTP envelopes, compression,
and a live multi-browser transfer were not measured by this probe. Below the
cap, storage feed patches still resend the entire changed dictionary.

**Impact and direction.** Small writes can amplify downloads across every
observing tab/device. Extend feed patches and their client application to the
same nested dictionaries and explicit name-keyed items, keeping base revisions,
validation, and size caps. Verify with two clients that a counter edit or toggle
does not trigger a whole-resource read. The plan intentionally kept the feed
unchanged; this is an end-to-end efficiency opportunity, not a failure of its
outgoing-write acceptance check.

### PS4 — A tiny nested storage patch still traverses megabytes of unchanged JSON

**Code.** [resourceStore.ts](../../../server/src/data/resourceStore.ts),
`patchParts` at 3270–3279, `canonicalPart` at 3373–3375, `storedParts` at
3385–3389, and `feedPatch` at 3422–3434;
[recordPatch.ts](../../../shared/recordPatch.ts), line 319.

Although the request contains one nested key, `patchParts` treats its reserved
dictionary as a changed top-level part. It serializes and parses that whole
dictionary, canonicalizes it again, and feed comparison serializes both the old
and new dictionary. The oversized feed candidate is then serialized before
being discarded.

Instrumenting `JSON.stringify` and `JSON.parse` only around the real
`store.applyBatch` for PS3's 173-byte counter update counted:

| Server patch-base cache | Stringify results at least 2 MiB | Parses at least 2 MiB |
| ----------------------- | -------------------------------: | --------------------: |
| Warm                    |                                5 |                     1 |
| Cold                    |                                6 |                     2 |

These are synchronous traversals/allocations on the server event loop for a
history that did not change. They are not a claim about measured response time.

**Suggested improvement.** Preserve entry-level serialized parts for declared
dictionaries, canonicalize changed entries, and reuse unchanged text. Build
bounded feed patches from those changes instead of constructing an oversized
dictionary replacement. Writing the final SQLite text column is inherent in
the chosen one-record storage model; these repeated full JSON passes are not.
Retain tests for normalization, property ordering, `__proto__`, and malformed
stored dictionary fallbacks.

### PS5 — Structured Memory chats occupy a cache that will not reuse them

**Code.** [detachedChatCache.ts](../../../src/ts/plugins/apiV3/detachedChatCache.ts),
admission at 106–118 and eligibility at 129–137.

Under Structured Memory, a cache hit requires an unsealed, HypaV3-owned summary
value. A projected chat, or even a chat with no memory data, is rejected.
Nevertheless, `rememberDetachedChat` serializes and retains those same copies
against the 64 MiB budget. They can evict copies that could have been reused.

**Reproduction.** With a current live feed, Structured Memory selected, and 20
unchanged chats containing 16 KiB notes, two immediate full reads return equal
data. The second still requests all 20 bodies and transfers over 327,680 bytes
of response JSON. This used `StoreBackedServer`; the fixture is ASCII, so its
response-text length equals its UTF-8 byte count. The existing projected-chat
case in [getDatabaseDetached.test.ts](../../../src/ts/plugins/apiV3/getDatabaseDetached.test.ts)
also deliberately expects a full reread.

**Suggested improvement.** Cache the revision-stable chat body separately from
its memory projection, using memory revisions to refresh the latter. At minimum,
skip retention and sizing of entries that the cache cannot reuse under the
current algorithm. Do not simply remove the eligibility guard: memory
projections can change without advancing the chat revision, so that would
return stale data. Validate unchanged, changed-projection, and no-memory chats
separately.

### PS6 — Concurrent cold reads download the same chats independently

**Code.** [v3.svelte.ts](../../../src/ts/plugins/apiV3/v3.svelte.ts), per-call
`reads`/`cacheHits` at 1249–1250 and missing-chat preparation/read at 1280–1302.

The shared cache contains completed reads only. Two plugins, or two overlapping
calls from one plugin, can both discover the same cache miss before either
response arrives. Each call starts its own detached request and repeats the
response parsing, snapshot compatibility scan, and cache sizing.

**Reproduction.** Hold the read boundary until two cold
`getDatabase(["characters"])` calls have entered. For three unchanged chats,
the real-store probe records **six requested chat refs**; both calls return
equal results. This uses deferred promises, not elapsed-time assertions.

**Suggested improvement.** Share pending detached reads by epoch, character/chat
identity, revision, and applicable projection state. Each caller must still
perform its own final owner, membership, local-work, and freshness checks.
Test overlapping requests, invalidation while pending, and rejection cleanup.

### PS7 — A one-chat page repeatedly constructs the entire chat list

**Code.** [v3.svelte.ts](../../../src/ts/plugins/apiV3/v3.svelte.ts), page selector
at 2240–2246 and its repeated use in `withDetachedDatabaseChats`;
[chatStore.svelte.ts](../../../src/ts/storage/chatStore.svelte.ts), `chatList`,
lines 1446–1451.

`page(chatList(id))` slices only after `chatList` constructs a metadata object
for every chat. Pinning, preparation, safety checks, and final assembly each
invoke this selector.

An instrumentation wrapper that still called the real `chatList`, with a real
`StoreBackedServer`, measured a 1,000-chat character and
`getChats("c", { offset: 500, limit: 1 })`:

| Read                  | Returned chats | Requested chat refs | `chatList` calls | Constructed list entries |
| --------------------- | -------------: | ------------------: | ---------------: | -----------------------: |
| Cold                  |              1 |                   1 |               11 |                   11,000 |
| Immediate cached read |              1 |                   0 |               11 |                   11,000 |

**Impact and direction.** Paging bounds network payload but not synchronous
metadata work. Walking the full collection in pages of size P costs roughly
O(N²/P) list-entry construction. Expose a read-only member-page accessor that
slices IDs before constructing metadata, plus a count accessor. A membership
version can permit reuse across checks while preserving the existing
page-change-during-await protection. Verify work counts on cold and warm pages.

### PS8 — A blocked flush makes a loaded one-chat page fetch every other chat

**Code.** [v3.svelte.ts](../../../src/ts/plugins/apiV3/v3.svelte.ts), full-character
fallback at 1225–1239 and `getChats` dispatch at 2259–2262.

Even when the requested page is fully loaded, the detached helper first flushes
global resource work. If that flush rejects, it falls back to
`withChatsLoaded(ids)`, loading the entire target character. The result still
contains only the requested page.

**Reproduction.** In a 1,000-chat real-store fixture, load chat zero, queue a
change to its generation-locked message, then request offset zero with limit
one. The probe returned the correct local message but requested **999
unrequested chat refs in two read POSTs** and made `chatsLoaded("c")` true.

**Suggested improvement.** Give already-loaded pages a path that pins the
requested chats, checks owner/membership, refreshes their projections, and
copies held state without flushing unrelated work. For genuinely unloaded
pages, narrow the fallback where the safety requirements allow it. Verify that
a generation-blocked save does not make a loaded page read or install other
chats. The current broad fallback is documented; this is an avoidable
traffic/memory cost rather than a wrong returned value.

### PS9 — Indexed storage enumeration repeatedly scans every plugin's keys

**Code.** [pluginStorageStore.svelte.ts](../../../src/ts/storage/pluginStorageStore.svelte.ts),
`ownedPluginStorageKeys`, lines 179–186;
[v3.svelte.ts](../../../src/ts/plugins/apiV3/v3.svelte.ts), indexed key and length
calls at 2920–2927.

Both `length()` and `key(index)` build the full visible key list. Each build
enumerates the entire shared `_ownedPluginStorage` dictionary before filtering
for this owner, allocating a list and, where legacy reads are visible, a `Set`.

The conventional loop below therefore does O(K × T) key work for an owner with
K keys among T keys belonging to all plugins, as well as making repeated RPCs:

```js
for (let i = 0; i < (await risuai.pluginStorage.length()); i++) {
  const key = await risuai.pluginStorage.key(i);
  // Use key.
}
```

A deterministic probe of the actual key-enumeration implementation, substituting
only its settings/record boundaries, used 100 owners with 100 keys each.
Enumerating one owner's 100 keys caused **201 owned-dictionary enumerations and
2,010,000 key visits**. Caching `length` in the caller reduces the constant but
does not remove repeated scans by `key(i)`.

**Suggested improvement.** Keep ordered owner key lists/counts with invalidation
for owned/legacy mutations and remote record replacement. Recommending one
`keys()` call is an immediate author-side workaround. Preserve owned-before-legacy
ordering, shadowing, claim-on-write, clear markers, and arbitrary string keys.

## Issues outside the plan

### U1 — The sandbox drops an own `__proto__` field from returned JSON

**Code and attribution.** [factory.ts](../../../src/ts/plugins/apiV3/factory.ts),
host `replaceStreamsWithPorts` at 823–826, with the same assignment pattern in
the guest and reconstruction helpers. It already exists at the plan baseline
`7f0024197`; it is not introduced by owned storage or detached reads.

A stored JSON object is a valid return value of `pluginStorage.getItem`. Before
posting it, the bridge rebuilds plain objects using `const out = {}` and
`out[k] = value`. For an own `__proto__` key, that changes the temporary object's
prototype instead of defining a data property. Structured cloning then loses
the field. This is observable data loss on the return path, not evidence of
global prototype pollution.

The following standalone Node probe calls the actual bridge helper and the
structured clone that follows it; run it from the repository root:

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { SandboxHost } from './src/ts/plugins/apiV3/factory.ts';
const value = JSON.parse('{"__proto__":{"retained":true},"normal":1}');
const prepared = SandboxHost.prototype.replaceStreamsWithPorts.call({}, value).result;
const delivered = structuredClone(prepared);
assert.equal(Object.hasOwn(value, '__proto__'), true);
assert.equal(Object.hasOwn(delivered, '__proto__'), false);
console.log(JSON.stringify(delivered)); // {"normal":1}
NODE
```

The storage mutation layer explicitly preserves arbitrary JSON/string keys,
so direct API tests do not catch the bridge discrepancy. Use own-property
definition or another prototype-safe construction in every bridge copy helper,
then test a storage value round trip through the actual guest bridge. The probe
above validates the host transformation directly, not a browser end-to-end
round trip.

### U2 — Character reconciliation repeatedly scans the full character list

**Code and attribution.** [v3.svelte.ts](../../../src/ts/plugins/apiV3/v3.svelte.ts),
`applyPluginCharacters`, lines 1542–1558. Both `existing.includes(char.chaId)`
inside the preparation loop and `characterList().findIndex(...)` inside the
application loop already appear at `7f0024197`.

For C existing incoming characters, those nested linear searches make identity
lookup O(C²), even when the new D9 optimization skips every chat load. This is
source-confirmed complexity; no wall-time or allocation benchmark was run for
it. The D9 `pluginChatsMatch` loop itself uses map lookups and was not found to
have the suspected unconditional quadratic chat-membership scan.

**Suggested improvement.** Build a membership `Set` and a stable ID-to-index
map once per reconciliation, maintaining the map as new characters append.
Preserve existing ordering, duplicate rejection, vanished-target handling, and
generating-character protection. This can improve large summaries round trips
without changing the plugin API.

## Coverage and qualifications

| Plan area                                 | Review result                                                                                                                                                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 measurement driver and access recorder | Reviewed driver, guest recorder, and existing tests. Measurements in old commit messages were treated as historical, not rerun results.                                                                                                  |
| D2 inventory and D3 reset/removal         | Reviewed namespace inventory, key/namespace deletion, assignment, script hashes, loaded-script cleanup, remote refresh, and one-time browser import. PS1 is the confirmed correctness finding.                                           |
| D4 write patches                          | Reviewed client generation, shared validation, server application, malformed-dictionary and `__proto__` fallbacks, duplicate/empty names, and conflicts. No new patch-application correctness defect found; PS3/PS4 cover residual cost. |
| D5/D6 storage semantics                   | Checked absent reserved dictionaries, explicit replacement, owner isolation, legacy claim/read-through, clear markers, arbitrary string keys, discard mapping, and upstream export/import. PS9 covers enumeration cost.                  |
| D7/D8 detached reads and cache            | Reviewed local-work/notice/refusal fallbacks, owner/revision checks, cache cap/expiry/feed/epoch rules, and projection handling. PS2 and PS5/PS6 remain.                                                                                 |
| D9 unchanged setter optimization          | Rechecked cached matches after awaits, loaded-match pinning/recomparison, omitted chats, replaced owners, and duplicate validation. No new correctness defect confirmed.                                                                 |
| D10 scoped reads                          | Checked summaries round trips, paging order/bounds, and the real-store work counts in PS7/PS8. Summaries intentionally contain no count because current summaries do not hold one.                                                       |
| D11 sandbox browser check                 | Reviewed the opaque-origin, token, forged-message, RPC, and unloaded-chat assertions; browser execution status is recorded below. This is not a full capability/security audit.                                                          |

Additional residual cost: held chat reads still use
`clone($state.snapshot(...))` in
[chatStore.svelte.ts](../../../src/ts/storage/chatStore.svelte.ts), lines 1329 and
1337; `getChats` similarly calls `plainClone($state.snapshot(held))` at
`v3.svelte.ts:2249`. The D7 implementation retained two copies to preserve
snapshot/JSON behavior, including own `__proto__` handling. A single compatible
copy pass remains an optimization opportunity, especially on hook/fallback
reads; no timing gain is claimed here.

The intentional shared `safeLocalStorage`, `getLocalPluginStorage`, and custom
top-level channels were not classified as isolation bugs. Plugin names with
U+0000 intentionally retain legacy behavior. Neither the unchanged default full
database API nor the chosen one-record SQLite storage model is itself a
finding. Existing broad capability and stale whole-object setter hazards were
not reclassified as new defects from this plan.

## Verification

Temporary probes exercised the real save adapter/resource store where possible,
and controlled concurrency with deferred requests. Two permission regression
probes failed against the current behavior as expected. Three detached-read
probes and two scoped-read probes passed assertions recording the observed
defect/cost; they do not mean those behaviors are correct. Standalone real-store
probes measured feed output and server JSON work. U1 was reproduced directly
against the bridge helper. Temporary probe files created for this audit were
removed from the repository; this report is the only intended deliverable.

| Check                                                      | Result                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --silent test:agent`                                 | Passed: 9,191 tests, 66 skipped, 577 files; 81.2 seconds after obtaining the shared suite lock.                                                  |
| `pnpm --silent test:agent --e2e e2e/pluginSandbox.spec.ts` | Passed: all 3 browser tests; 1.4 minutes after obtaining the browser-test lock.                                                                  |
| `pnpm check:changed`                                       | Passed; client/server type checks correctly skipped because the only change is this Markdown report. This is not a fresh full type-check result. |
| Targeted Prettier and `pnpm check:docs`                    | Passed.                                                                                                                                          |
| Standalone feed/JSON-work and owned-key enumeration probes | Independently rerun by the primary reviewer; reproduced PS3/PS4 and PS9's counts.                                                                |

The passing existing suite does not cover the newly reproduced interleavings or
assert the work budgets above. The report underwent a separate critical review
for attribution, measurement claims, and the distinction between bugs and
documented fallbacks. No product code, permanent tests, or guide contracts were
changed.

The attempted `node util/playwright/measurePluginData.mjs` run did not produce
usable benchmark data. App startup exceeded its 120-second limit, and the page
reported `Failed to fetch dynamically imported module` for `/src/startApp.ts`.
Consequently this report makes no current-browser wall-time, heap, or compressed
traffic claim from that driver. This startup failure alone is not evidence of a
plugin storage defect.
