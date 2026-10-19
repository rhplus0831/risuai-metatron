# Heap Memory Reduction Plan

Status: M0 (measurement tooling), A1 (one string per equal record text), B1 (frozen module asset lists), B2 (frozen character asset lists) and C1 (fonts after a chat: no holder, per-row copies found) landed. Source: two Chrome heap snapshots of a production build
(`localhost:6039`) taken by the user on 2026-10-19 with large modules and characters:
`save/Heap-20261019T174051.heapsnapshot` after boot and
`save/Heap-20261019T174926.heapsnapshot` after opening several chats (both gitignored
user data: quote sizes and shapes only, never content). Analysed with the scripts slice
M0 commits (retainer paths and a dominator tree). Line numbers are approximate; the
identifiers are the anchors. Re-verify each cited location before editing.

One slice is one session, one commit, one file cluster. Each slice names its guide from
`STRUCTURE.md` Choose By Task; that guide's `Invariants` apply. Every slice updates the
owning guide where it changes a documented contract.

Workflow per slice: `opus-lite` for a slice marked _small_, `opus-workflow` for one
marked _hard_. Each slice ends with its test (under "Test"), `pnpm check`,
`pnpm --silent test:agent` (`--tags-filter=slow` for the storage suites it touches), the
guide's focused checks, and the M0 measurement with the before/after numbers recorded in
this file.

## Findings

The JS heap was 244 MB after boot and 274 MB after opening chats. Memory grows with
the size of the data, not with time: opening chats added 30 MB, and almost none of it
was JS objects.

| Holder (dominator retained size)                       | Size        | What it is                                                                                 |
| ------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------ |
| Svelte `$state` proxies of module `assets` arrays (23) | **~110 MB** | ~11k tuples per module, every `[name, path, ext]` tuple its own proxy (~700 B overhead)    |
| `persisted` (`resourceSync.svelte.ts`)                 | 41 MB       | the server's JSON text of every record: modules 31 MB, characters the rest                 |
| `moduleTexts.source` (`resourceSync.svelte.ts`)        | 31 MB       | the save loop's last modules projection: equal to `persisted`'s text, a second string      |
| `characterTexts` (`resourceSync.svelte.ts`)            | 6.6 MB      | the same duplication for the large characters                                              |
| Blink fonts and stylesheets (after opening chats)      | ~+25 MB     | `FontFace` 26 → 1,496, `CSSStyleSheet` 9 → 53 (14 via `@import`), in the document's caches |

So 31 MB of modules JSON costs roughly 62 MB of text plus ~110 MB of proxied live data.

Why the tuples are proxies: `records` is a deep `$state` (`records.svelte.ts` ~238).
Svelte 5.57's proxy `get` trap creates a source, and a child proxy, for every writable
own property it reads, and keeps both as long as the parent proxy lives. One whole read
through the proxy (`JSON.stringify` in `moduleProjection` on a field-cache miss,
`resourceSync.svelte.ts` ~669, or any UI or helper walk) therefore proxies every tuple
for good. The snapshot's retainers are the parent array's sources (`.v`) and the
`moduleTexts` field cache (`.value`). `moduleFieldPlain` already reads the raw target,
but only while a field is untouched: Svelte does not update the raw target after a write.

Not found in the snapshots, but possible from code reading (the snapshot holds no Blob
bytes, and these did not rank): record wrapper nodes are never pruned, `getFileSrc` pins
its sources, and the parser keeps an unbounded `fileSrcCache` (Phase D).

## Order

- **M0 first.** Every other slice reports its numbers with it.
- **Sequence A, the save adapter** (`src/ts/storage/resourceSync.svelte.ts`): A1.
- **Sequence B, the records layer** (`src/ts/storage/records.svelte.ts` plus the asset
  writers): B1 → B2, one at a time. A1 and B1 both touch `moduleProjection`: land A1
  first, or rebase B1 on it.
- **Independent** (any time after M0, own worktree): C1, D1, D2.
- The unmerged `boot-resource-cache` plan (branch `boot-resource-cache`) also changes how
  `persisted` texts are seeded (slice 3 caches the server texts in IndexedDB). Whichever
  lands second keeps A1's sharing rule.

## M0: measurement tooling

- **M0. Heap analysis scripts and a large-data scenario** (_small_,
  `build-test-platforms.md`). Commit the analysis under `util/heap/`:
  - a streaming `.heapsnapshot` loader (files over V8's 512 MiB string limit; numbers
    parsed from the Buffer, strings one at a time);
  - a summary by type and constructor, and a diff of two snapshots by node id;
  - shortest retainer paths (BFS from the root over strong edges);
  - dominator retained sizes (Cooper-Harvey-Kennedy over postorder; a WeakMap value is
    charged to its key, not its table, as in Chrome DevTools).

  Add a Playwright driver (`util/playwright/`) that seeds a fixture shaped like the user's
  data, without their content: 12 modules × 11k `[name, path, "avif"]` assets, two
  characters of ~2 MB with a few hundred `additionalAssets`, and chats whose messages
  carry `<style>` and `@import`ed web fonts. The driver takes CDP heap snapshots along a
  session (boot, the character asset list, five chats, the module asset list, a module
  edit and its save, home) and prints the counts each slice checks: `JSProxy` total and
  asset-tuple proxies, large proxies, likely duplicate large strings,
  `FontFace`/`CSSStyleSheet`, and total self size. Per-holder attribution is
  `analyze.mjs paths`/`top` on a kept snapshot (`HEAP_OUT`).

  _Done_: the driver reproduces the table above in shape (proxies ∝ assets, doubled
  texts), and its baseline numbers are recorded here.
  _Test_: a unit test of the loader and the dominator code on a small handmade snapshot.

  **Baseline** (`node util/playwright/measureHeap.mjs` on `heap-memory-reduction` before
  any fix; reruns agree to 0.1–1 MB). The driver goes boot → character settings → chats →
  module editor → home with no reload after boot. A chat's style has 120 inline
  `@font-face` rules and an `@import` (a `data:` URL, no egress) of 120 more. The big
  characters' bulk is in lorebook entries; see M0-2 below for why.

  | Step               | JS self MB | Proxies | Asset tuple proxies | Large proxies (n / outermost MB) | Likely duplicate large strings (n / extra MB) | FontFace | Sheets |
  | ------------------ | ---------- | ------- | ------------------- | -------------------------------- | --------------------------------------------- | -------- | ------ |
  | `boot`             | 191.3      | 133,765 | 132,600             | 26 / 99.4                        | 3 / 15.6                                      | 0        | 9      |
  | `character-assets` | 242.9      | 134,151 | 132,600             | 26 / 99.4                        | 2 / 13.1                                      | 0        | 9      |
  | `chats`            | 249.1      | 134,297 | 132,600             | 26 / 99.4                        | 2 / 13.1                                      | 240      | 10     |
  | `module-assets`    | 240.4      | 134,622 | 132,600             | 26 / 99.8                        | 1 / 2.4                                       | 0        | 9      |
  | `module-edit`      | 236.1      | 134,326 | 132,600             | 26 / 99.8                        | 1 / 2.4                                       | 0        | 9      |
  | `home`             | 236.8      | 134,388 | 132,600             | 25 / 99.3                        | 1 / 2.4                                       | 0        | 9      |

  The same report on the user's snapshots: 150,487 / 153,306 proxies, 147,085 asset
  tuple proxies, ~110 MB retained by the outermost large proxies, 3 likely duplicate
  groups costing 34.6 MB.

  A snapshot keeps only a string's first 1,024 characters, so "likely duplicate" means
  the same size and the same first 1,024 characters. That the user's 31 MB pair is one
  text rests on the code (`persisted` and `moduleTexts` both hold the modules JSON), not
  on the snapshot alone.

  What the baseline adds to the findings:
  - Every asset tuple (12 × 11,000 module + 2 × 300 character) is already a proxy at
    boot, before any edit or asset list. The full read happens during load, not only in
    a save cycle (B1 should find which reader does it first).
  - The doubled texts shrink after the first save cycles (3 → 1 groups), as A1
    describes: an acknowledged write shares the op's string.
  - **M0-1.** Opening a character's settings loads a tokenizer BPE model on the main
    thread: a `merges` table of ~280k arrays, ~49 MB retained, kept to the end (the
    +52 MB at `character-assets` that `home` still holds). Not sliced yet: a candidate
    for a worker or an on-demand release (see the chat-open notes on the tokenizer
    thread).
  - **M0-2.** The character settings tokenize the description and first message on the
    main thread. With a 1.7 MB description the "Character" tab click took 17–22 s.
    Not sliced yet.
  - **M0-3** (bug). With the character settings open on a closed-chat screen, selecting
    another character alerts `TypeError: Cannot read properties of undefined (reading
'replace')`: `CharConfig.svelte` `loadTokenize` passes `currentChat?.note`
    (undefined without a chat) to `tokenizeAccurate`. The driver goes back to the
    "Chat" tab first. Belongs in the open bug fixes plan.
  - Both kinds of font faces, inline and `@import`ed, leave with their chat (240 → 0
    after the module editor replaced the chat screen). The user's 1,496 faces were
    either still on screen or come from something the fixture lacks (a remote font
    service's stylesheet, a background HTML, a shadow root). C1 starts from that.

  M0 leftovers (accepted): the loader/dominator unit test above is not written. The
  driver's readiness and cleanup checks read `server.exitCode` only, so a server child
  killed by a signal (`exitCode` null, `signalCode` set) between the listen handshake and
  a later probe could let another responder on port 6264 pass, and cleanup could wait on
  an exit already emitted. The fix is one exit flag set at spawn that also checks
  `signalCode`.

## Sequence A: save adapter

- **A1. One string per equal record text** (_small_, `persistence.md`).
  `seedResources` (~357) stores `recordText(kind, record.data)`. The first projection of
  the same data (`moduleProjection` ~641, `characterProjection` ~715) builds an equal but
  separate string, and `moduleTexts`/`characterTexts` keep it as their `source`. Where
  `collectOperations` finds `projection.text === current.text` (~1216 collections, ~1243
  characters), make the cache's `source` (and the returned projection) use `current.text`,
  so the projection's string can be freed. Spans stay valid because the texts are equal.
  Check the other `persisted.set` paths (remote apply ~1619/~3279, conflict reads) for
  the same pairing: after an ack the op's text already is the cache's source.
  _Done_: in M0's scenario, no likely duplicate large (>1 MB) strings at `boot` (before
  any save cycle) either. Saves are unchanged, and the field-text cache still hits.
  _Test_: `src/ts/storage/tests/resourceSyncModuleCache.test.ts` and
  `resourceSyncFieldCache.test.ts`: after a no-op cycle, `moduleTexts.source` is the
  persisted string (identity, through a test hook); after an edit both caches still
  reuse unchanged field spans.

  **Landed.** `shareSavedText` in `resourceSync.svelte.ts` rebinds the cache's `source` to
  the held string where a projection equals it: a collection or character equal to its
  saved text (after `canonicalCharacter` too), an in-doubt resend equal to the live text
  (the acknowledgement saves `doubt.text`), and a quarantined text checked unchanged. The
  live-update, hydration and merge paths already save the projection's own string. M0
  driver after A1 (before → after):

  | Step               | JS self MB    | Likely duplicate large strings (n / extra MB) |
  | ------------------ | ------------- | --------------------------------------------- |
  | `boot`             | 191.3 → 175.7 | 3 / 15.6 → 0                                  |
  | `character-assets` | 242.9 → 229.8 | 2 / 13.1 → 0                                  |
  | `chats`            | 249.1 → 236.0 | 2 / 13.1 → 0                                  |
  | `module-assets`    | 240.4 → 237.9 | 1 / 2.4 → 0                                   |
  | `module-edit`      | 236.1 → 233.7 | 1 / 2.4 → 0                                   |
  | `home`             | 236.8 → 234.5 | 1 / 2.4 → 0                                   |

  Proxies, FontFace and sheet counts are unchanged. The planned identity test was not
  written: string identity is not observable from JavaScript without V8 natives syntax,
  so the driver's duplicate count is the check; the existing cache tests cover that the
  field-text cache still hits.

## Sequence B: records layer

- **B1. Module asset lists as immutable values** (_hard_, `persistence.md`, coupled
  `characters-modules.md`). Store each module's `assets` as a frozen array of frozen
  tuples. Svelte's `get` trap creates no source for a non-writable property, so a
  frozen list costs one proxy instead of one per tuple. Edits replace the whole list:
  copy, change, freeze, assign. Assigning `module.assets` stays reactive through the
  module's own source.
  Work:
  - Freeze at every install and adopt path: `applyRaw` (~631), the boot install,
    `adoptModuleValue`/`moduleInertCopy`, the remote item patch (`applyRemotePatch`), the
    import paths (`modules.ts` ~105, `.risum`/CharX imports).
  - Treat frozen values as leaves in the wrapper layer: `childWrapper` must not wrap
    them, and the stand-in proxy's `getOwnPropertyDescriptor` must not report a
    non-configurable property the stand-in lacks (a Proxy invariant `TypeError`).
  - Rewrite the in-place writers as replacements:
    - `ModuleMenu.svelte` push (~343) and `bind:value={currentModule.assets[index][0]}`
      (~394, which becomes `value` + `oninput` replacing the tuple);
    - `modules.ts` ~258 `module.assets[index][1] = key`;
    - the MCP `risuaccess` module tools;
    - any Lua or plugin API that edits module assets.
  - Change `RisuModule.assets` (`shared/modules.ts` ~21) to
    `readonly (readonly [string, string, string])[]` so `pnpm check` finds every
    remaining writer. The server keeps its own mutable copies where it builds lists.
  - `moduleFieldPlain` and `getModuleAssets` may then return the frozen list itself, with
    no JSON copy. Measure before keeping that.
  - Decide in the slice whether `moduleItemFieldStamp` needs a stamp change for a whole
    list replacement (it should already: an assignment through the wrapper stamps).
    _Done_: in M0's scenario, the `JSProxy` count under module assets is O(modules), not
    O(assets), after boot, a save cycle and a full walk of the module asset list. Retained
    size drops by ≥ 80 MB. Add, rename (typing), delete, import, and the asset key fill
    (`modules.ts` ~258) still save, re-render, and reach another tab as an item patch.
    _Test_: `src/ts/storage/tests/moduleFieldStamps.test.ts` and `moduleCache.test.ts`
    (frozen after install, adopt and remote patch; a replacement stamps and saves);
    `records.test.ts` (no wrapper for a frozen leaf, no invariant error from
    `Object.getOwnPropertyDescriptor` or spread on a wrapper); a component test of the
    `ModuleMenu` rename row.

  **Landed.** `records.svelte.ts` freezes a module's `assets` (a list of plain JSON tuples,
  validated through descriptors) at `applyRaw` and in `adoptModuleValue`, remembers verified
  lists and tuples in two WeakSets (`frozenLists`/`frozenTuples`), returns them from the
  wrappers as leaves, and refuses an in-place write through every trap, mutator and bulk helper
  (`refuseFrozen`). Edits replace the list and reuse the unchanged tuples; `moduleFieldPlain`
  returns the frozen list itself. `RisuModule.assets` is readonly; `ModuleMenu` add, rename
  (per keystroke) and delete replace the list and keep a tuple's length and other elements; the
  import key fills copy tuples. The driver gained `module-asset-edit` (rename by typing, timed;
  delete; server copy checked). M0 driver after B1 (A1 → B1):

  | Step                | JS self MB    | Proxies         | Asset tuple proxies | Large proxies (n / outermost MB) |
  | ------------------- | ------------- | --------------- | ------------------- | -------------------------------- |
  | `boot`              | 175.7 → 62.1  | 133,765 → 1,765 | 132,600 → 600       | 26 / 99.4 → 2 / 0.6              |
  | `character-assets`  | 229.8 → 116.3 | 134,151 → 2,151 | 132,600 → 600       | 26 / 99.4 → 2 / 0.6              |
  | `chats`             | 236.0 → 122.4 | 134,297 → 2,297 | 132,600 → 600       | 26 / 99.4 → 2 / 0.6              |
  | `module-assets`     | 237.9 → 124.4 | 134,622 → 2,521 | 132,600 → 600       | 26 / 99.8 → 3 / 1.1              |
  | `module-asset-edit` | (new) 125.7   | 2,521           | 600                 | 3 / 1.1                          |
  | `module-edit`       | 233.7 → 121.3 | 134,326 → 2,225 | 132,600 → 600       | 26 / 99.8 → 3 / 1.1              |
  | `home`              | 234.5 → 121.5 | 134,388 → 2,287 | 132,600 → 600       | 25 / 99.3 → 2 / 0.6              |

  The 600 tuple proxies left are the two big characters' `additionalAssets` (B2). A rename
  keystroke over 11,000 assets took 33–43 ms (keystroke, frame and task, production build).
  Leftovers: in DEV a repeated `module.assets = module.assets` nests Svelte's
  `inspectable_array` proxies (production stores the raw list); a DEV wrapper read and
  `moduleFieldPlain` of an untouched field return different aliases of one frozen list.

- **B2. Character asset lists as immutable values** (_hard_, `persistence.md`, coupled
  `characters-modules.md`). The same rule for `additionalAssets`, `emotionImages` and
  `ccAssets` (`shared/database.ts` ~635/720/810/858), using B1's helpers. Writers:
  - `CharConfig.svelte`: `ccAssets.splice` ~541, the `additionalAssets` assignments
    ~718–884, and the `bind:value` rows ~659 and ~871;
  - `AssetInput.svelte` ~56–69;
  - `characters.ts`: `ccAssets` ~175/190, `emotionImages` ~208/222;
  - `interchangeability.ts` ~22;
  - the character card import (`characterCards.ts` ~1486 edits a card copy: keep it
    mutable until it is installed).

  Also stop `ChatBody.svelte`'s module-level `imageAssets` (~10) from walking
  `selectedCharacter()?.additionalAssets` through the wrapper: with a frozen list it
  reads plain tuples.
  _Done_: in M0's scenario, opening the character asset list and five chats adds no
  proxy per character asset. Edits through every writer above save and re-render.
  _Test_: `characterFieldStamps.test.ts` (frozen after install/adopt; replacement
  stamps), `ChatBody.assets.svelte.test.ts`, a `CharConfig` rename-row component test.

  **Landed.** `records.svelte.ts` freezes `additionalAssets`, `emotionImages` (tuples) and
  `ccAssets` (flat records) at `initializeRecords`, `applyRawCharacter` and `patchRawCharacter`
  (handed-over data), and stores a whole field written or stored as a verified frozen list or a
  wholly owned frozen copy (`freshAssetList`: wrappers and `$state` detached first, so no live
  record object is frozen). Verified provenance is kept per shape (tuples, records).
  `characterFieldPlain` returns the frozen list; `characterAssetNames` and the parser's fuzzy index
  key their caches by a frozen list's identity (`isFrozenAssetList`). The character asset types
  are readonly. `CharConfig` add/rename (per keystroke, with ModuleMenu's search hold)/delete, the
  emotion rename, the `ccAssets` removal, `AssetInput`'s add and `characters.ts` replace lists;
  the adds re-resolve the character after their awaits. `ChatBody` needed no change. The driver
  seeds 24 `ccAssets` per big character and gained `character-asset-edit` (rename by typing,
  timed; delete; server copy checked). Same driver, B1 build → B2 build:

  | Step                   | JS self MB    | Proxies       | Asset tuple proxies |
  | ---------------------- | ------------- | ------------- | ------------------- |
  | `boot`                 | 62.2 → 61.6   | 1,815 → 1,047 | 600 → 0             |
  | `character-assets`     | 116.6 → 115.6 | 2,226 → 1,071 | 600 → 0             |
  | `character-asset-edit` | 121.4 → 120.3 | 2,521 → 1,368 | 599 → 0             |
  | `chats`                | 122.7 → 121.8 | 2,370 → 1,212 | 599 → 0             |
  | `module-assets`        | 124.7 → 123.8 | 2,594 → 1,436 | 599 → 0             |
  | `module-asset-edit`    | 126.0 → 125.1 | 2,594 → 1,436 | 599 → 0             |
  | `module-edit`          | 121.6 → 120.7 | 2,298 → 1,140 | 599 → 0             |
  | `home`                 | 121.7 → 120.8 | 2,360 → 1,202 | 599 → 0             |

  The boot drop (768 proxies) is the 600 tuples, 120 emotion pairs and 48 `ccAssets` entries.
  A character rename keystroke over 300 assets took 16–29 ms (B1, in place: 25–39 ms).
  Leftovers: B1's module path still freezes a same-record unproxied list or tuple (one a
  `defineProperty` installed) when it is assigned to `assets`, so later edits through its source
  wrapper throw (no production writer does this; B2's descriptor-validated owned copy is the fix
  to reuse); a same-id `replaceCharacterRecordAt` passing the character's own frozen list back
  re-stamps that field (its `$state` proxy never `Object.is` the raw list), costing one extra
  serialization.

## Phase C: chat styles

- **C1. Fonts and stylesheets after a chat closes** (_small_, investigation first,
  `cbs-rendering.md`). After opening chats the document held 1,496 `FontFace`s and 53
  stylesheets (22 document sheets, 14 through `@import`, the rest in shadow roots). First,
  with M0's driver, check whether they stay after returning home. If they do, find what
  keeps them: `<style>` that the parser or a background renderer puts outside the
  message rows, a shadow root kept alive, or Blink's own font cache (then nothing to
  fix). Fix only an app-side holder, and record the outcome here either way.
  _Done_: either the counts drop to near the boot values on the home screen, or the
  holder is named as Blink-internal with the evidence.
  _Test_: if code changes, a component test that the injected `<style>` leaves with its
  chat.

  **Landed** (investigation; no app code changed). No app-side holder was found: the
  message rows' faces leave with their rows. The user's after-chats snapshot was taken
  with a chat on screen:
  - All 53 sheets are active ones in the document's `StyleEngine`, and all 1,496 faces
    sit in its `CSSFontSelector`'s `FontFaceCache`. No sheet or `<style>` is detached.
  - 14 of the 31 `<style>` elements are inside mounted message rows
    (`.default-chat-screen` → `.risu-chat` → `.chattext`). One is in `BackgroundDom`'s
    layer, one is the app's own in `<body>`, and 15 belong to the browser's own shadow
    roots (`<textarea>`, `<select>`, `<option>`); the app attaches no shadow root.
  - 1,470 of the faces are one font service stylesheet of 105 faces, `@import`ed by each
    of those 14 rows. Blink parses it once per row (14 `StyleRuleImport`s,
    1,496 `StyleRuleFontFace`s), so the faces grow with the mounted rows that repeat a
    style, not with time.

  The driver now models this: every reply (three per chat) carries the same style, whose
  `@import` is a remote URL that a context route answers (no egress). Before each chat's
  snapshot it waits for the three styled replies and their faces (`document.fonts`). Three
  checks pass: the import is fetched, the chat screen holds exactly one copy of the faces
  per styled reply, and the count is back to the boot value afterwards.

  | Step            | `FontFace` | Sheets |
  | --------------- | ---------- | ------ |
  | `boot`          | 0          | 9      |
  | `chats`         | 720        | 12     |
  | `module-assets` | 0          | 9      |
  | `home`          | 0          | 9      |

  720 is 3 rows × (120 inline + 120 imported). Each row's `<style>` is its own sheet with
  its own rules (no shared `StyleSheetContents`). The per-row copies are the open chat's
  cost, a candidate for C2.

  Not covered: `BackgroundDom` (`ChatScreen.svelte`) renders the character's
  `backgroundHTML` and the modules' `backgroundEmbedding` whenever a character is
  selected, also on its closed-chat screen ("Go back" clears only the open chat). Styles
  and faces there stay until another screen or character replaces it; that is the
  feature, not a leak, and the fixture seeds neither source.

- **C2. One stylesheet per distinct chat style** (_candidate_, not sliced; `cbs-rendering.md`).
  `trimMarkdown` (`parser.svelte.ts` ~1024) turns each row's `<risu-style>` into a `<style>`
  inside that row's HTML. N mounted rows that repeat a style therefore cost N sheets, N
  imports and N × faces (the user's chat: 14 × 105). A chat-screen registry could keep one
  `<style>` per distinct CSS text, counted by the rows that use it, and remove it when the
  last of those rows unmounts. `decodeStyleRule` already prefixes the inline rules'
  selectors with `.chattext` and has no per-row scope; `@font-face` rules and imported
  sheets are global either way. So the selectors stay the same.
  - What changes: the cascade order between different styles. Today, with rows styled
    A, B, A, the later A wins a conflict with B; with one shared A placed first, B would win.
  - The `{@html}` rows (and their PartialEdit/translation re-renders) would need to stop
    owning their `<style>`.
  - The driver's route answered 12 stylesheet requests for the 15 styled rows it opened.
    Playwright routing turns off the HTTP cache, so this count says nothing about a real
    font service's caching.
  - Measure first, with a controlled comparison (the same build and fixture, one styled
    reply against three). The only number so far is an aggregate across runs: at `chats`,
    B2's driver (240 faces, `data:` imports) had 121.8 MB of JS self size and this one
    (720 faces) 125.4 MB; the other steps also moved by up to ~0.9 MB.

## Phase D: leaks from code reading (measure, then fix)

- **D1. Prune record wrapper nodes** (_hard_, `persistence.md`). `TrackedNode` children
  (`records.svelte.ts` ~1157) are strong `Map`s that only `moveIndexChild` and
  `resetRecords` shrink. A deleted character's `idChildren` entry keeps its old `$state`
  object, and a removed module's tail index node keeps the old module. Drop a
  character's node at its acknowledged delete (or on a failed id resolve), and the
  module index nodes past the list's length at a raw replacement or a shrink. Measure
  first: M0's driver deletes and re-imports a 2 MB character three times and compares.
  _Done_: the heap returns to within a few MB after the deletes; old wrappers still throw
  `DetachedWrapperError` as today.
  _Test_: `records.test.ts` (a deleted character's node is gone from `idChildren`; a
  retained old wrapper throws).

- **D2. Pinned file sources** (_hard_, `global-api.md`). `getFileSrc` (~134) pins every
  source. Without the service worker that is a never-revoked image Blob URL. The
  parser's `fileSrcCache` (`parser.svelte.ts` ~444) never evicts. `inlays.ts`
  `mediaObjectUrls` (~530) and the `createObjectURL` calls in `postInlayAsset`,
  `reencodeImage` and `jobChannel.ts` (~603) never revoke. Measure Blob memory first
  (`chrome://blob-internals` or `performance.measureUserAgentSpecificMemory`), with and
  without the service worker. The earlier LRU-revoke design was rejected because
  retained HTML (`lastParsed`, the PartialEdit restore, the translation cache) would
  point at revoked URLs. Keep that constraint: the one-shot decode URLs can be revoked
  after `decode()`, and a pinned source needs a URL-free placeholder design (see the
  audit plan's 3d entry) before any revoke.
  _Done_: the one-shot URLs are revoked, and the pinned-source growth is measured and
  either fixed or recorded as accepted.
  _Test_: `src/ts/globalApiRetention.test.ts`.

## Out of scope

- Dropping `persisted` texts (hash-only change detection). They are the patch bases and
  the 409 comparison; a separate design, if A1 and B1 are not enough.
- Server memory: `patchBases` (4 entries / 64 MiB) and per-job module parses are bounded
  or transient, and the user's symptom is the browser.
