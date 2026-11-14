# Manual Checks

Checks that a finished plan left to a person, a device, a real provider, or a script nobody ran. Each one came from a plan's close-out notes in the [plan archive](../archived-plan/README.md), which held them until 2026-11-11. They are grouped by what the check needs, so one sitting with a phone or a second browser can clear a whole section.

- The bold name is the plan; its text is `git show <commit>:<path>` from the archive's table. A slice id follows in parentheses where the plan named one.
- An item that names several environments appears once, under the first section that fits; the other environments are in the item.
- Every item was read against the code and the tests on 2026-11-11. A check of something that is gone, a check that an automated test now covers, and a script a later run executed were removed. No check was performed: an item that is left still needs its device, browser, provider, or server.
- Delete an item when it passes. When it fails, move it to [found issues](found-issues.md) with what was seen.

## Phones: Android Chrome and the installed PWA

- [ ] **URL Routes**: the route checks on Android Chrome and the PWA (also desktop Chrome and iOS Safari), including H1 and its fallback if those checks fail.
- [ ] **Web Push**: on an Android PWA over HTTPS (also Firefox and the iOS Home Screen app where available): permission, subscription and reload behavior; a completion with the tab hidden, closed, and visible, without duplicates; notification click routing; the insecure-LAN fallback; a service-worker update. No dedicated session has run this browser matrix (Audit Findings Phase 5).
- [ ] **Audit Findings and Performance Leftovers (4f)**: the share target and deep links on a physical device.
- [ ] **Mobile Resume Reliability**: the four Android PWA scenarios (lock the screen right after sending; switch to another app for 5+ min; airplane mode during the reply; force-stop and reopen), each followed by Settings → Advanced → Developer & diagnostics → Save to server. The plan's Verification section maps each event to the cause it shows (H1–H7).
- [ ] **Display Evaluation**: on the Android PWA over mobile data, A → B → A shows rows at once; no disturbing flicker after a send; repeated switches answer only `same`.
- [ ] **Durable Drafts**: an Android PWA killed from the task switcher (also the iOS Home Screen app, Safari including the bfcache return, and Firefox); the recovery dialog at phone width; the "Recovered changes" row shown while drafts exist (unit-tested only).
- [ ] **Job Protocol**: a kill and reopen mid-reply with a server provider and with a plugin provider; a stop from the phone while the desktop generates; airplane mode right after Send.
- [ ] **Deep Audit Fixes**: the Android Korean IME (also the desktop Japanese IME) in the composer and partial editor; the failed-transform row after a phone wakes; a real-browser push run.
- [ ] **Job Handoff**: a phone with its screen off handing a job to a PC worker; a PC worker minimized for over 5 minutes; the phone's toast, stream, Stop and "Take back"; the "Hand off to" menu across two browsers.
- [ ] **Reroll Candidates**: the phone swipe on the owner's server (the `n/m` counter, the arrows, kept across a reload).
- [ ] **Storage Settings Page**: no horizontal scroll in the Storage rows at about 360px on a real phone; the hatched outside-RisuAI segment stays visible in every theme.
- [ ] **Render Work Budget**: a phone switching chats mid-auto-translate.
- [ ] **Incremental Chat Transport**: a long reply watched from a second device; an owner reloading mid-stream on a real device (`streamed` rows and the resync).
- [ ] **Server Thumbnails**: a redirected image load through the worker on a phone (also Safari); blur at device scale 3 or more with `iconsize` 200 (ST5).
- [ ] **Small Fixes (SF8)**: alert key handling with the mobile virtual keyboard (also Firefox and Safari).
- [ ] **Static Audit Fixes (SA4)**: the refused-data banner's placement on mobile, Firefox, and Safari (checked in Chromium at 1280×800 and 390×844).
- [ ] **PocketRisu fix crosscheck (row 16)**: `share_target` on Samsung Internet, the one row of [the crosscheck](../reports/surveys/pocketrisu-fix-crosscheck.md) still waiting for a device.
- [ ] **Upstream Integration (UP22)**: Android's media notification and Chrome's tab audio indicator for the keep-alive audio.
- [ ] **Memory Panel Readability (2–8)**: at phone width (about 360px): the page read view (2), an expanded event's changes (3), the `story` view (4), the alias editor and the rename input (6), the event title and summary editor with a Korean IME (7), and the new-note and add-section forms (8); Enter on a phone keyboard starts a search (5).
- [ ] **Structured Memory Recent Timeline (1–3)**: at phone width (about 360px), the memory settings page's timeline target and key-line event inputs (1), the lane split select and its share line (2), and the key-line checkbox with its help line (3).
- [ ] **Per-Chat Memory (1, 3, 5)**: at phone width (about 360px), the chat memory panel in the sidebar and in the Chat settings dialog with its switch, mode, preset, and connection selects (1, 3, 5), and the memory settings page (3).
- [ ] **Lore Budget Send Stop (2)**: at phone width (about 360px), the lore budget stop dialog and the Interaction page's "Stop a send when lorebook entries are left out" checkbox, in English and Korean.
- [ ] **Generation Progress Window (3)**: at phone width (about 360px), the progress window starts as a pill, expands, and does not cover the chat header's buttons; with a memory run on the selected chat, the memory indicator and the window do not overlap and the memory indicator still expands and collapses.

## iOS Safari and the Home Screen app

- [ ] **Direct Asset URLs (DA0, DA7)**: Safari, iOS, and real devices; in real Firefox, whether the control loss Playwright saw after an unanswered navigation happens.
- [ ] **Render Work Budget**: iOS Safari's canvas area against `MAX_EXPORT_PIXELS`.
- [ ] **Upstream Integration (UP17)**: the select-text fix on iOS and macOS Safari.

## Firefox, Safari, and other browsers than headless Chrome

- [ ] **Boot Resource Cache**: only headless Chrome was checked: no Firefox, Safari, mobile, or private-window run.
- [ ] **Boot Bytes**: compressed scripts, the reconnect digest, and the per-character chat collections have no Firefox, Safari, mobile, or private-window run.
- [ ] **Per-Event Server Work**: the patch-only barrier and the feed's `summary` and `delta` entries have no Firefox, Safari, or mobile run.
- [ ] **Incremental Chat Transport**: Firefox, Safari and mobile runs of the reconnect and the feed.
- [ ] **Chat Checkpoints (CC5)**: the Checkpoints dialog's layout in Firefox, Safari, and on mobile.
- [ ] **Search (3b)**: the settings search field and deep link at 390 px, in Firefox, in Safari, and in the Korean UI.
- [ ] **Audit Findings and Performance Leftovers (3f)**: far-row containment in Firefox and Safari.
- [ ] **Found Issues Clearance**: the chat list on Firefox and Safari (far-row containment, pixel anchoring, the newest-first reveal).
- [ ] **Render Work Budget**: the screenshot export's page size at Safari's canvas limit, in Firefox and Safari; far-row containment.
- [ ] **Context Usage Meter**: the plan's manual check in Firefox and Safari.
- [ ] **Upstream `.bin` Compatibility (S1)**: Firefox, Safari, and Vite's bundling of msgpackr 2.1.3 beyond `pnpm build`.

## A real desktop browser, by hand

One tab:

- [ ] **Translation**: the bilingual display.
- [ ] **Request History and Diagnostics**: the full viewer and error-alert workflow across request sources; a restore leaving history unchanged.
- [ ] **Large Asset Import and Export**: a 4,000-asset PNG import's request count and heap (3c); the lazy icons during folder drag (4b); Chrome's answer to a pre-body refusal (409/413/503) on `/api/import/module` and `/api/import/charx` (status or network error, and whether a reset keep-alive socket resends the POST).
- [ ] **Open Bug Fixes**: P1 (the banner's failure alert, a notification click from an uncontrolled window); M1 (Stop during VITS playback); C8 (a tab return); C5 (the `.risum` drop).
- [ ] **Search (1)**: the native `<select>` popup in a real desktop browser (headless Chrome does not draw it): Settings › Display on the `light` scheme with a dark OS and on `dark` with a light OS.
- [ ] **RisuNest Small Wins (P1)**: the "Unsupported API" badge and the real-iframe expiry.
- [ ] **RisuNest Small Wins (S1)**: GUI HTML gating under `SafeModeStore` (no unit test either).
- [ ] **Audit Findings and Performance Leftovers (4d)**: the plugin fixes in a real iframe.
- [ ] **HypaV3 Background Memory**: the progress overlay and "Stop here and continue"; the sidebar `memory` badge; the modal fence (including after a reconnect).
- [ ] **Per-Chat Send**: auto mode ending on Go Back; a resumed job's Stop overlapping another chat's send; a slow v3 plugin hook stopped in one chat while another chat runs; Web Push per-chat tags and their dismissal.
- [ ] **Static Audit Fixes (SA13)**: first-run setup and the damaged-password state.
- [ ] **Chat Checkpoints (CC5)**: the Checkpoints dialog's auto-policy row against the real policy routes (it was checked with an adapter stand-in before CC4 landed).
- [ ] **Small Fixes**: the light-theme prose color (SF6); a drag after switching characters with details open (SF7); the HypaV3 bulk resummarize button (SF9, mount tests only); streaming with auto-translation in Off, Balanced, and Strong modes (SF10); the 57 added Korean strings on screen (SF11).
- [ ] **Server Thumbnails (ST4)**: the bookmark-list avatars.
- [ ] **Upstream Integration**: exporting a portrait-less character as PNG to see `reencodeImage` turn WebP into PNG (UP18); module create, cancel, and edit, where opening the Trigger tab counts as content and asset bytes uploaded before a cancel stay stored (UP19).
- [ ] **Combine Audit Fixes**: a screenshot with a full-size `{{source::char}}` image; a few hundred portraits after the upgrade.
- [ ] **Chat Lore Overrides**: the plan's manual check by hand (slice 4 ran it in headless Chrome against a mock provider, reading the request body instead of the DevTool preview).
- [ ] **Chat Lore Override States**: in the narrowest sidebar a long entry name stays readable beside the control in English and Korean.
- [ ] **HypaV3 Token Budget**: after a real send, convert a ratio preset and confirm the summarize timing is unchanged; lower the max context and confirm the chip shows "memory reduced" with the applied values.
- [ ] **Render Work Budget**: a multi-page export in an image viewer; a failed export's error alert and scroll restore.
- [ ] **Asset Lifecycle**: a clicked-through check of the Storage panel beyond the driver.
- [ ] **Plugin Storage and Data API**: the plugin data page (namespaces, owners, assign, deletes); Reset permissions and a reinstall asking again; the remove dialog's checkbox (default, Enter/Space, unchecked keeps data); the reuse cache after a hidden tab.
- [ ] **Found Issues Sweep (C4)**: in the lorebook filter, press + on a host and inside a filter-expanded folder, then open an entry there and change the query: the entries stay visible and open.
- [ ] **Implementation Audit Fixes (R6)**: export a chat whose theme uses an `@import` webfont and confirm the font is fetched once and the image uses it (the 150-row driver fixture has no `@import` webfont).
- [ ] **Chat Store and Structured Memory Sweep**: in the cardboard theme an expanded receipt's details overlap the bottom-right icon box by about 3px (B3); the gray `unavailable` health badge with its help icon (B8); a follow lost to a dropped connection, then a same-page retake of that job, shows the live stream (A2, covered only by `generationJobs.test.ts`).
- [ ] **Found Issues Clearance**: Web Push in Chrome and Firefox (the enable button right after a reconcile, a service-worker upgrade during a subscribe, a `/`-route click).
- [ ] **Structured Memory**: the 69 device, browser, and real-model checks the run's final report listed per slice, among them Firefox and Safari, the Android PWA, a real V3 plugin, and real provider costs. The list is not in the repository.
- [ ] **Memory Panel Readability (1–5, 8)**: the Korean memory panel, receipt line, and chat status line read naturally (1); the page read view and an expanded event's changes in each theme, and a long page scrolls inside the panel (2, 3); a chat with several hundred events switches to `story` without a visible stall (4); a Korean query finds Korean text (5); a send after creating a note names it in the manifest when the chat mentions its title (8).
- [ ] **Structured Memory Recent Timeline (1, 2, 4)**: a real chat's Preview shows summaries for the events just outside the raw window and titles past them (1); the owner's 50,000-token preset under `auto` shows lane targets of 12,500, 22,500, 7,500, 5,000, and 2,500 in Preview's lane spend (2); on a 16,384-token model, how often the pages lane drops a page on stage in a long chat ([measured](../reports/measurements/structured-memory-timeline-2026-11-11.md#the-pages-lane-and-the-shares) on the fixture only) (4).
- [ ] **Per-Chat Memory (1, 3, 4, 5)**: the trim question's three answers on a real send (1); two chats of one character in different modes, switching between them with the panel and the health badge open (3); one chat moved HypaV3 → Structured Memory (the adoption question) → HypaV3 (summaries still used) → Structured Memory (records still there) (3); a plugin that reads chats (Asset Maid) over chats in mixed modes (3); the Structured Memory test run while the open chat's algorithm differs from the global one (3); the memory settings page with a chat that names a preset open, and at home (4); deleting a preset a chat names, then sending in that chat (4); the HypaV3 modal's manual summarize on a chat with its own preset and on one with a named connection (4, 5).
- [ ] **Structured Memory Reply-Only Recording (1, 2)**: the memory settings page's "Leave user messages out of recording" checkbox and its help line in English and Korean (1); a rebuild preview on one chat with the switch on and off (1); on a chat adopted from HypaV3 summaries written under HypaV3's `doNotSummarizeUserMessage`, Fill gaps with the new switch on shows the no-model-call confirmation, the run ends at once, the old user messages are gone from the next send's prompt, and the Coverage view shows them recorded (2); both backfill confirmations in English and Korean (2).
- [ ] **Lore Budget Send Stop (2)**: on a chat whose active lore exceeds the limit, a send shows the dialog with the right names and numbers, the message stays in the chat with no reply and no model request in request history; "Don't warn in this chat and send" replies, the meter shows its off note, the next send is not stopped, and the meter's toggle turns the stop back on; "Change the token limit" lands on the global item (on the lorebook's settings submenu for a character with its own budget) and "Manage lorebook" opens the lorebook tab, and after raising the limit an empty send replies; continue and reroll on the same chat show the dialog and leave the reply text unchanged after Close; auto mode and a plugin send are not stopped and the meter's red icon appears after the reply; a `dont_activate_after_match` entry that activates on the stopped send still activates on the resend; the dialog and the checkbox in English and Korean.
- [ ] **Generation Progress Window (3, 4)**: a send with Response Streaming on shows the window at once, the seconds tick, the stage label follows the ring's color, and the "≈" count and speed appear with the first text and look plausible against the reply's length; a buffered send shows the stage and the seconds with no count; two chats generating at once show two rows, the selected chat's first, and a row click opens its chat; a reload mid-reply brings the window back with the right elapsed time; the setting off hides the window (3). With Response Streaming off and Half Streaming on, the reply bubble is blank and locked while the window counts, and the whole reply appears at the end with display scripts and inlays (judge whether the blank bubble needs its own indicator); a stop keeps the text so far, a stopped continue keeps the earlier text and the new part, and a stopped reroll brings the previous reply back; the Half Streaming checkbox disappears when Response Streaming is turned on (4). Both settings in English and Korean.

Two tabs, two browsers, or a dropped connection:

- [ ] **Per-Chat Toggles and Toggle Presets**: prompt info showing the chat's values.
- [ ] **RisuNest Small Wins (P2)**: the deferred plugin reload with two tabs or devices, and a reload deferred during a generation.
- [ ] **Deep Audit Fixes**: the two-tab LoRA alternation.
- [ ] **Chat Store and Structured Memory Sweep (B1)**: with two tabs on one chat, Record now inside a job shows the same memory task in both.
- [ ] **Per-Chat Memory (1)**: two tabs on one chat, the memory switch toggled in one.
- [ ] **Generation Progress Window (3, 4)**: a second browser or device lists the first one's job from its start with that client's name, opening the chat shows the Stop-other spinner in the stage color, and the row disappears at the end (3); with Half Streaming, the second device shows no partial text during the reply and the whole reply at the end (4).

## Real providers and external services

- [ ] **Upstream `.bin` Compatibility**: a restore of an export in upstream RisuAI's own app (the owner's step: upstream's `LoadLocalBackup` reader and asset writes, `makeColdData`, `cleanChunks`, plugin loading and UI are not run by the check script); a completed send on imported data (S8 checked dispatch only; the real backup's selected model is a plugin model whose plugin is not in the backup).
- [ ] **Upstream Integration**: importing a `.bin` made by the real upstream app (UP1); real v3 plugins, including `getRootDocument()` scroll and key listeners (UP4–UP6); real Gemini and Vertex requests for the tool round trip and the 3.6/3.5 Flash entries, and the flags when an alias moves (UP9, UP12); a real NovelAI request (UP15); whether the live Realm always sends `creator` (UP20).
- [ ] **Combine Audit Fixes**: an upstream backup from a library with checkpoints, restored in upstream RisuAI; abandoned Google token counts.
- [ ] **Static Audit Fixes (SA7, SA8)**: Stop and cancel against real providers (ComfyUI, Wavespeed, a live provider request).
- [ ] **Small Fixes (SF5)**: a real Transformers.js inference for the WebLLM model fix (harness stub only).
- [ ] **Generation Stage Spinner (GS4)**: the stage colors with a real provider (`.loadmove` has a 0.5 s color transition, so a stage as short as a mock's blends).
- [ ] **Structured Memory (Q2)**: the real-model A/B from the recipe in [the evaluation](../reports/measurements/structured-memory-2026-11-03.md), which decides whether Structured Memory replaces HypaV3 by default.
- [ ] **Structured Memory Recent Timeline (3, 4)**: with a real `memory` model, the key lines of new events before and after turning on `keyLineGuidance` (3); whether replies recall recent events better with the timeline, to run with the Structured Memory A/B above (4).
- [ ] **Found Issues Clearance**: a live Realm import with a tab closed after prepare and a 503 during commit (B5); a Gemini thinking model accepting the replayed signature (C4).
- [ ] **Upstream Intake 2 (AUD-11)**: the real userscript transport cancelling a `fetchNative` body (slice 13 tested a stub).
- [ ] **Per-Chat Memory (1, 4, 5)**: an upstream `.bin` export opened in upstream RisuAI with memory on for the right characters (1); two chats on presets with different budgets, compared in the context report of a real send (4); a real send with a cheaper connection named for memory, checked in request history, then a send after deleting that connection (5).
- [ ] **Wide review request wrappers** ([found issues](found-issues.md), 2026-11-14): with real keys, through the default server route and with plain fetch on: ElevenLabs speech and its voice list, Hugging Face speech (including a 503 `estimated_time` wait), Stability image generation for each model (the multipart form and its boundary), and the Fish Speech model list in a character's TTS settings; a Chub import (`?charahub=`) and an `#import=` card link (through `fetchNative`, not run). The keyless calls (direct Google translation, the Horde and NanoGPT public model lists, the supporter list, and the plugin update check) were run against the real services on 2026-11-14, through the server proxy and with plain fetch.
- [ ] **Structured Memory Reply-Only Recording (1)**: with a real `memory` model, a send and recording on a chat whose prompt expands the user's message, with the switch on and a preset whose instructions and custom frames use no CBS: the event reads as the reply, and request history shows no user text in the writer's call.
- [ ] **Generation Progress Window (4)**: with Half Streaming on: a model with tools enabled, an image-output model, and a character with output escaping complete the send, with no count when the provider answered buffered; a plugin provider that streams is hidden and counted and one that does not is as before; a WebLLM model and a `mancer` model reply as before with no count; a plugin with an after-request replacer and a banned script set run neither for a reply Half Streaming streamed and both for a buffered one (tools on a Claude model).

## The server process, Docker, and a production deployment

- [ ] **Request History and Diagnostics**: production Docker + sftp isolation: the restricted account can read `state.json`, `events/`, `reports/`, and `shared/` but cannot read `save/data/`; pull a job share, withdraw it, and save and pull a phone browser report. The application does not configure the sftp account or chroot. Found Issues Clearance's owner checklist repeats the chroot check.
- [ ] **Upstream `.bin` Compatibility (S1, S5)**: the Docker image was not rebuilt after the msgpackr pin, so the native `msgpackr-extract` in the image is unverified. The Combined Run's later `docker build` and container smoke may cover this.
- [ ] **Asset Lifecycle**: a Docker volume on a nearly full disk: the 507 answers of the restore, the backup import, the upstream commit, the upstream export prepare, and the manual snapshot; the snapshot tick logging once and skipping.
- [ ] **Static Audit Fixes (SA12)**: durable writes on Windows, macOS, and network mounts, and under real power loss.
- [ ] **Boot Resource Cache**: the reporting user comparing DevTools Timing on their own server before and after.

## Scripts, specs, and measurements nobody ran

An agent can run these without a device.

- [ ] **Sidebar Chat Status**: the browser check's `--base` production mode was implemented but not exercised.
- [ ] **Found Issues Clearance (Q16)**: a real-browser `measureHeap.mjs` run after a module delete, if a heap plan returns.
- [ ] **Search (4b)**: the message search was not measured on a real large database (the real saves on the machine were 352 KB).
- [ ] **Heap Memory Reduction**: the user's own style and real font files were not measured.
