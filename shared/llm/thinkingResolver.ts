import { LLMFlags } from "../llm.ts";

/**
 * Resolves Claude thinking modes from catalogue capabilities without changing persisted preferences.
 * Budget mode becomes adaptive only when budget thinking is absent and adaptive thinking is present; all other
 * values, including undefined and unsupported selections, pass through for request and display callers.
 */

/** The stored Claude thinking preference. */
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
