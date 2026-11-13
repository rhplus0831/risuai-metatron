import type { LoreBudgetStop } from "../../../../shared/contextReport.ts";
import type { GenerationTerminalEvent } from "../../../../shared/jobs.ts";

/** An over-budget activation naming eight of ten left-out entries. */
export const loreBudgetStopFixture: LoreBudgetStop = {
    budgetUsed: 60,
    budget: 64,
    rejectedCount: 10,
    rejectedTokens: 145,
    rejected: [
        { name: "Castle || keep", tokens: 10 },
        { name: "Harbor", tokens: 11 },
        { name: "Forest", tokens: 12 },
        { name: "Tower", tokens: 13 },
        { name: "River", tokens: 14 },
        { name: "Village", tokens: 15 },
        { name: "Mountain", tokens: 16 },
        { name: "Road", tokens: 17 },
    ],
};

export const loreBudgetTerminal = (epoch: string): Extract<GenerationTerminalEvent, { type: "error" }> => ({
    type: "error",
    epoch,
    reason: "failed",
    status: 400,
    code: "loreOverBudget",
    message: "Activated lorebook entries exceeded the token limit.",
    lore: loreBudgetStopFixture,
});
