// The CBS registry moved to `shared/cbs/` (Phase 5), so the server runs the same functions.
export { defaultCBSRegisterArg, registerCBS } from "../../shared/cbs/registry.ts";
export type { CBSRegisterArg, matcherArg, RegisterCallback } from "../../shared/cbs/types.ts";
