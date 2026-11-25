import { parseLoreBudgetStop, type LoreBudgetStop } from "../../../shared/contextReport.ts";
import type { GenerationTerminalEvent } from "../../../shared/jobs.ts";

/**
 * The lore budget stop a job's end carries: an `error` coded `loreOverBudget` whose `lore` parses
 * (`parseLoreBudgetStop`), with the terminal's English message. Null for every other end, a `lore`
 * that does not parse included. The end report (`reportEnd` in `serverCommands.ts`) and the send's
 * result (`sendChatOnServer`) both decide by it, so a stop is shown by exactly one of them.
 */
export function jobLoreStop(
    end: GenerationTerminalEvent | "lost" | null,
): { lore: LoreBudgetStop; message: string } | null {
    if (!end || end === "lost" || end.type !== "error" || end.code !== "loreOverBudget") {
        return null;
    }
    const lore = parseLoreBudgetStop(end.lore);
    return lore ? { lore, message: end.message } : null;
}
