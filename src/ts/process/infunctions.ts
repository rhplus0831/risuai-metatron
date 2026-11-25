import { calcString as calcStringWith } from "../../../shared/cbs/calc.ts";
import { getChatVar, getGlobalChatVar } from "../parser/chatVar.svelte";

/**
 * Adapts `shared/cbs/calc.ts` to the tab's selected-chat variable readers. Selection is read by
 * `src/ts/parser/chatVar.svelte.ts`, so this wrapper has no captured request-chat binding of its own;
 * callers evaluating another chat still get the selected chat's variables.
 */

/**
 * The CBS calculator (`shared/cbs/calc.ts`) over the selected chat's variables, even in a parse for
 * another chat (a `chatRef` parse in `src/ts/parser/parser.svelte.ts`). The server's counterpart is the
 * job host's `calcString` (`server/src/jobs/cbsHost.ts`).
 */
export function calcString(text: string) {
    return calcStringWith(text, { getChatVar, getGlobalChatVar });
}
