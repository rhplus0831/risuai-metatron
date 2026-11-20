# Direct assets browser control — 2026-10-24

What was observed: whether a browser keeps service worker control after a navigation the worker
does not answer (`public/sw.js` lets every non-`/sw/` request fall through).

How: by hand, on 2026-10-24. `util/playwright/probeDirectAssets.mjs` reports the Playwright case as
a failed check.

| Browser                      | After the unanswered navigation                                                   |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Chrome                       | keeps control                                                                     |
| A real Firefox build         | keeps control                                                                     |
| Playwright's bundled Firefox | drops control: `navigator.serviceWorker.controller === null` on the next document |
