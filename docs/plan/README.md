# Active Plans

Temporary implementation plans live here only while their changes are in
progress. The codebase and current architecture guides remain the source of
truth for shipped behavior.

Keep only links to plans whose work is actively in progress in this README.
Remove a plan's link as soon as it is completed, retired, or no longer active.
When no plans are active, keep the list below set to `None`.

Active planning and implementation:

- [Split Preset](split-preset.md): split the bot preset into model and prompt
  presets (done; its per-chat selection follow-up is done in
  [Chat Binding](chat-binding.md)).
- [Chat Binding](chat-binding.md): bind each chat's model preset, prompt
  preset, and persona, and refuse to send until all three are bound
  (done, slices 1–7).
- [Shared API Keys](shared-api-keys.md): move LLM credentials into a named key
  list that each model binds to (done; named keys for the auxiliary
  operations are the open follow-up).
- [Model Profiles](model-profiles.md): split the model preset into model
  profiles (model, key, connection options) and the slots that pick them,
  so each auxiliary model has its own key and endpoint (done; the `submodel`
  slot and the remaining global provider toggles are the open follow-ups).
- [URL Routes](url-routes.md): give each screen a history-mode address kept in
  sync with the existing stores, with closes going back in history (slices 1–5
  done; the manual checks, H1's among them, are open).

## Archived

- The server-owned data plan (Phases 0–6, `STRUCTURE.md`, "Migration History")
  closed out at commit `9d09288b`; its last version, `PLAN.md` and `phases/`,
  is in that commit's tree.
