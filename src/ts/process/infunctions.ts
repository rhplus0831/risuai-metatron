import { calcString as calcStringWith } from "../../../shared/cbs/calc.ts";
import { getChatVar, getGlobalChatVar } from "../parser/chatVar.svelte";

// The calculator moved to `shared/cbs/calc.ts`; the client reads the selected chat's
// variables, as before.
export function calcString(text: string) {
    return calcStringWith(text, { getChatVar, getGlobalChatVar });
}
