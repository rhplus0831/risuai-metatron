# Browser check and heap analysis observations — 2026-11-11

What this is: things sessions learned while writing and running `util/playwright/` checks, scratch drivers, and heap
snapshot analysis between 2026-10-16 and 2026-11-06, collected from the agents' notes on 2026-11-11. Each line was true
on the date it carries and was not run again for this report. The rules that still bind an editor are in the
[test harness guide](../../structure/test-harness.md); a driver's own header holds what that driver needs.

## Running checks

- 2026-10-16: four dev-stack checks at once on distinct ports all failed with "the app did not load" or empty resource
  reads. Every stack's Vite shares `node_modules/.vite`, and their dependency optimizations collide.
- 2026-10-16: Vite dying with `EMFILE ... watch` means the user's inotify instances are used up, mostly by other agent
  sessions. Raising `fs.inotify.max_user_instances` fixes it; `CHOKIDAR_USEPOLLING=1` works without root.
- 2026-10-16: Docker smokes. `docker build -t risu-metatron:<tag> .`, then a fresh container and volume per smoke
  (`-v <name>:/app/save`, `--add-host host.docker.internal:host-gateway`), run with
  `--base http://localhost:<port> --password <password>`. The restart smoke also takes
  `--provider-host host.docker.internal --restart-cmd "docker restart <container>"`.
- 2026-11-06: a Vite dependency re-optimization reloads every open page, so the Vitest suite beside a dev stack breaks
  the check, and a lone named-spec run on a fresh stack can reload after the first page boots. `e2e/multiClient.ts`
  redoes its preparation when a prepared document changed.
- 2026-10-17: a browser check run while a test writer does mutation runs fails the same way: each mutation is a file
  edit, and Vite reloads the page.

## Writing a driver

- 2026-10-18: a scratch driver outside the checkout resolves no package. Load Playwright with
  `createRequire(repoRoot + "/package.json")("playwright-core")`.
- 2026-10-18: a `page.evaluate` that spans the first `import("/src/...")` can die with "Execution context was destroyed"
  when Vite reloads for dependency optimization. Call `openApp` again and retry the step.
- 2026-10-19: `openApp` always calls `page.goto`, so calling it to wait after `page.reload()` loads the page a second
  time. Poll `loadedStore` in the same document instead.
- 2026-10-18: seed characters and chats in one `/api/resources/batch` request
  (`chats: [{ characterId, chatId, baseRevision: null, ops: [{ op: "create", chat }] }]`) and read a chat back with
  `POST /api/resources/read { chats: [{ characterId, id }] }`. A second `browser.newContext()` is the cheap check of a
  fresh boot from summaries.
- 2026-11-05: a v3 plugin's `db` grant can be seeded through the batch's `pluginPermissions` (key
  `<sha256 of script>_db`, plus `<name>_db_lastGrantTime`), so no consent dialog appears.
- 2026-10-18: lucide icons select as `svg.lucide-<name>`. The Home button sits inside the hamburger menu by default, a
  sidebar folder starts collapsed, and the closed-chat screen never shows the greeting, so do not wait for its text
  after switching characters.
- 2026-10-27: a chat row renders again after a message save, so an `elementHandle` taken before the edit detaches; look
  the row up again by its new text. A row in edit mode has no display text, so resolve the handle before entering edit
  mode.
- 2026-10-21: after a backup import the UI switches to the backup's language, so look labels up through `language`.
  Settings opened by URL lose the open chat; set the `settingsOpen` and `SettingsMenuIndex` stores instead.

## Measuring

- 2026-10-19: any Playwright `route`, `isolateContext` included, turns the HTTP cache off, so a reload downloads every
  script again. Block hosts with CDP `Network.setBlockedURLs` when the cache is the subject.
- 2026-10-19: Chrome keeps no response body over 10 MB (`response.text()` fails), and the dev page's module requests
  overflow the 250-entry resource-timing buffer. Count requests with `page.on("request")`.
- 2026-10-21: Playwright cannot read a response body after the page reloads. Capture it with `route.fetch`.
- 2026-10-18: Playwright's text locators run their matcher inside the page and show up in a profile as `elementText` and
  `querySelectorAll` time that grows with the DOM. Wait with `page.waitForFunction` on one element when measuring.
- 2026-10-18: CPU profile of the tab: start the dev stack for readable names, seed, open the chat, then
  `Profiler.start` and `Profiler.stop` over a CDP session; sum self time by `callFrame` and inclusive time by walking
  parents. `(program)` is native layout and style time and cannot be assigned to a function.
- 2026-10-17: `JSHeapUsedSize` leaves out ArrayBuffer external memory, so measure the renderer's RSS for file work.
  Blob and object URL bytes are outside the JS heap too; `chrome://blob-internals` lists them.
- 2026-10-17: a Playwright `route.fulfill` with a 267 MB body kills the page. Serve a big file from a local `node:http`
  server and rewrite the page's `fetch`. Clear every `setInterval` sampler in `finally`.
- 2026-11-05: Node's `fetch` hit a parser assertion reading a large fixture back from the server; `node:http` with
  `accept-encoding: identity` read it. The plugin sandbox iframe runs out of process in headless Chrome, so sample its
  heap through `context.newCDPSession(frame)`.

## Downloads and imports

- 2026-10-18: the real streamSaver download works in headless Chrome over the dev stack. Its helper page is fetched
  from a public host, so the check needs network and cannot use `isolateContext`. Open the context with
  `acceptDownloads: true`, wait for the `download` event, then read `download.failure()` and `download.path()`. The
  helper page can also be served locally and set on the app's own `/deps/streamsaver.js` instance.
- 2026-10-17: an import refused before its body is read (409, 413, 503) makes the server adapter destroy the socket, so
  the browser may report a network error and not the status. The client checks the size first and does not retry a
  network error on the import routes.
- 2026-11-10: a hand-made base64 PNG failed to decode in Firefox only. Use a real image file in a browser check.

## Asset lifecycle driver

- 2026-11-05: a fresh key needs two graces to become deletable (youth, then the ledger), and only a restart drops the
  in-memory leases. After a snapshot restore the app shows a final "server data was restored" dialog while a second OK
  button is visible; scope the click to that dialog.

## Heap snapshots

- 2026-10-20: string names in a snapshot are cut at 1,024 characters, so a group of duplicate strings is only likely.
- 2026-10-20: a JSProxy's hidden edges leave out an empty properties store; its target is the first hidden edge to a
  node that is not an `array`.
- 2026-10-20: drop WeakMap table edges before computing dominators, as DevTools' `isEssentialEdge` does, or the table
  appears to retain every value.
- 2026-10-20: `JSON.parse` with `--max-old-space-size=24000` read a 529 MB snapshot. A 568 MB one exceeds V8's longest
  string, so its nodes and edges were parsed from the Buffer by a streaming loader.
- 2026-10-20: replacing a `$state` list with a new array left a `$derived` that had not run again holding the old
  sources. The records rewrite the original array after the pending flush instead (`trimRootList` in
  `src/ts/storage/records.svelte.ts`).
