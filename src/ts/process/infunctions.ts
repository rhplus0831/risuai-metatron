import { calcString as calcStringWith } from "../../../shared/cbs/calc.ts";
import { getChatVar, getGlobalChatVar } from "../parser/chatVar.svelte";

/**
 * The CBS calculator (`shared/cbs/calc.ts`) over the selected chat's variables, even in a parse for
 * another chat (a `chatRef` parse in `src/ts/parser/parser.svelte.ts`). The server's counterpart is the
 * job host's `calcString` (`server/src/jobs/cbsHost.ts`).
 */
export function calcString(text: string) {
    return calcStringWith(text, { getChatVar, getGlobalChatVar });
}
