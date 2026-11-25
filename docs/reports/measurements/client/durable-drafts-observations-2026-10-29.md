# Durable Drafts browser observations — 2026-10-29

Recorded during the Durable Drafts run; moved verbatim from the persistence guide's Known Hazards.

- Playwright-launched headless Chrome 156 restored this page from bfcache with the owner lock held; other Playwright
  flags remain, so this is no guarantee for headed Chrome or an installed PWA. `util/playwright/checkDurableDrafts.mjs`
  `runBfcache` reports the browser evidence after flushing; it does not exercise pending writes across a cached return.
- Chrome discards IndexedDB writes begun in `pagehide` when the page unloads. The hide flush protects a page that stays
  alive while hidden (a backgrounded PWA killed later); per-cycle writes and the separate 500 ms journal timer provide
  crash/kill protection for record, chat, and order intent. There is no localStorage fallback. Decision: the user
  accepted this Chrome platform limit without a localStorage fallback during the Durable Drafts run on 2026-10-29
  (recorded here).
