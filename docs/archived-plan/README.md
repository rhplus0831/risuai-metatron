# Archived Plans

Finished plans leave `docs/plan/` and are recorded here. Their files are not
kept in the tree: each entry names the commit whose tree holds their last
versions. The codebase and current architecture guides remain the source of
truth for shipped behavior; the guides and code comments may still name an
archived plan by its old path (`docs/plan/<name>.md`).

To archive a plan, delete its file and its link from `docs/plan/README.md`,
and add an entry below that names the commit holding its last version and any
open follow-ups.

## Archived

- The server-owned data plan (Phases 0–6, `STRUCTURE.md`, "Migration History")
  closed out at commit `9d09288b`; its last version, `PLAN.md` and `phases/`,
  is in that commit's tree.
- Split Preset (`split-preset.md`: the bot preset split into model and prompt
  presets) and Chat Binding (`chat-binding.md`: each chat binds its model
  preset, prompt preset, and persona, and is not sent until all three are
  bound) closed out at commit `809b35cc`; their last versions are in that
  commit's tree. The guides and code comments still name them by path (and
  Chat Binding's decisions by number).
- Shared API Keys (`shared-api-keys.md`: LLM credentials as a named key list
  each model binds to) and Model Profiles (`model-profiles.md`: the model
  preset split into model profiles and the slots that pick them) closed out at
  commit `317a97ce`; their last versions are in that commit's tree. The guides,
  code comments, and tests still name them by path (and Model Profiles'
  decisions as O1–O9). Their open follow-ups: named keys for the `/proxy2`
  auxiliary operations and `getFreeOpenRouterModels` (`llm-requests.md` "Known
  Hazards"), the `submodel` mode as its own slot (O3), and the global provider
  behavior toggles (O7: `openrouterMiddleOut`, `openrouterFallback`, the
  caching flags, `autofillRequestUrl`, `reverseProxyOobaMode`, `vertexRegion`)
  moving to the profile.
- Translation (`translation.md`: translations stored on the message, per-chat
  translation settings, server auto-translation, bilingual display, and
  multi-step translator presets; slices 1.1–1.5, 2.1–2.4, and 3.1–3.4 done)
  and URL Routes (`url-routes.md`: each screen a history-mode address kept in
  sync with the stores, closes going back in history; slices 1–5 done) closed
  out at commit `df25006f`; their last versions are in that commit's tree. The
  guides, code comments, and tests still name them by path (and Translation's
  slices and decisions, URL Routes' R and H items, by number). Their open
  follow-ups: Translation's optional phase 4 (greeting translation, bilingual
  partial edit) and the bilingual display's manual check; URL Routes' manual
  checks (Chrome desktop, Android Chrome, the Android PWA, iOS Safari), H1's
  among them, and H1's fallback if they fail.
