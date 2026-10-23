import { LLMFlags } from "../llm.ts";

export type ClaudeThinkingType = "off" | "budget" | "adaptive";

/** Resolves the request and display mode; the stored value is never rewritten. */
export function resolveClaudeThinkingType(
    flags: readonly LLMFlags[],
    thinkingType: ClaudeThinkingType | undefined,
): ClaudeThinkingType | undefined {
    if (
        thinkingType === "budget" &&
        !flags.includes(LLMFlags.claudeThinking) &&
        flags.includes(LLMFlags.claudeAdaptiveThinking)
    ) {
        return "adaptive";
    }
    return thinkingType;
}
