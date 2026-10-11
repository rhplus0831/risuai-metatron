# Active Plans

Temporary implementation plans live here only while their changes are in
progress. The codebase and current architecture guides remain the source of
truth for shipped behavior.

Keep only links to plans whose work is actively in progress in this README.
Remove a plan's link as soon as it is completed, retired, or no longer active.
When no plans are active, keep the list below set to `None`.

Active planning and implementation:

- [URL Routes](url-routes.md): give each screen a history-mode address kept in
  sync with the existing stores, with closes going back in history (slices 1–5
  done; the manual checks, H1's among them, are open).
- [Translation](translation.md): translations stored on the message, per-chat
  translation settings, server auto-translation, bilingual display, and
  multi-step translator presets (slice 1.1 done).

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
