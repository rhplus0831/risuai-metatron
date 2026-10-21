// The CBS registry lives in `shared/cbs/`, so the server runs the same functions.
export { defaultCBSRegisterArg, registerCBS } from "../../shared/cbs/registry.ts";
export type { CBSRegisterArg, matcherArg, RegisterCallback } from "../../shared/cbs/types.ts";
