import type { OpenAIChat } from "../openai.ts";
import type { PromptItemPlain, PromptRole } from "../prompt.ts";
import { isPlainObject } from "../valueKinds.ts";
import { MODEL_MODES, type ModelModeExtended } from "./request.ts";

/**
 * Request interception rules: the global list (`Database.requestInterceptions`) whose prompts the
 * request layer inserts into every request of the listed modes, before `reformater`. Both runtimes
 * normalize and insert with this module, so a rule reads the same on the server and in the tab.
 */

export type RequestInterception = {
    id: string;
    enabled: boolean;
    modes: ModelModeExtended[];
    position: "start" | "end";
    /** `type: "plain"`, `type2: "normal"`; `name` is the rule's label. */
    prompt: PromptItemPlain;
};

export const MAX_REQUEST_INTERCEPTIONS = 32;

const PROMPT_ROLES: readonly PromptRole[] = ["user", "bot", "system"];

/**
 * Keeps the first valid entries by id, up to the limit, and rebuilds each with a fixed key order,
 * so normalizing a normalized list changes nothing (its JSON text included). An entry is dropped
 * when it is not an object, its id is missing, blank, or already kept, or its prompt has no string
 * text; every other field is repaired to its default. The input is left untouched.
 */
export function normalizeRequestInterceptions(input: unknown): RequestInterception[] {
    if (!Array.isArray(input)) {
        return [];
    }
    const rules: RequestInterception[] = [];
    const seen = new Set<string>();
    for (const entry of input) {
        if (
            !isPlainObject(entry) ||
            typeof entry.id !== "string" ||
            entry.id.trim().length === 0 ||
            seen.has(entry.id) ||
            !isPlainObject(entry.prompt)
        ) {
            continue;
        }
        const { modes, prompt } = entry;
        const { text, name } = prompt;
        if (typeof text !== "string") {
            continue;
        }
        seen.add(entry.id);
        const role = PROMPT_ROLES.find((known) => known === prompt.role) ?? "system";
        rules.push({
            id: entry.id,
            enabled: entry.enabled === true,
            modes: Array.isArray(modes) ? MODEL_MODES.filter((mode) => modes.includes(mode)) : [],
            position: entry.position === "end" ? "end" : "start",
            prompt: {
                type: "plain",
                type2: "normal",
                text,
                role,
                ...(typeof name === "string" ? { name } : {}),
            },
        });
        if (rules.length === MAX_REQUEST_INTERCEPTIONS) {
            break;
        }
    }
    return rules;
}

/**
 * The messages of the rules that apply to a request of `mode`, by position and in list order. A
 * rule applies when it is enabled, lists the mode, and its text is not blank. Each call builds new
 * messages, since `reformater` changes messages in place and must not reach the stored rules. The
 * rule's `name` is a label and is left out: a message's `name` is sent as the speaker's name.
 */
export function interceptionMessages(
    rules: readonly RequestInterception[] | undefined,
    mode: ModelModeExtended,
): { start: OpenAIChat[]; end: OpenAIChat[] } {
    const start: OpenAIChat[] = [];
    const end: OpenAIChat[] = [];
    for (const rule of rules ?? []) {
        if (rule.enabled !== true || !rule.modes.includes(mode) || rule.prompt.text.trim() === "") {
            continue;
        }
        const { role, text } = rule.prompt;
        const message: OpenAIChat = {
            role: role === "bot" ? "assistant" : role === "user" ? "user" : "system",
            content: text,
        };
        (rule.position === "end" ? end : start).push(message);
    }
    return { start, end };
}

/**
 * `formated` with the applying rules' messages inserted, as a new array holding the input's own
 * messages; `applied` counts the inserted ones. `start` messages lead the prompt and `end` messages
 * close it, except that a last `assistant` entry stays last (a prefill must end the prompt), so the
 * `end` messages go right before it.
 */
export function applyRequestInterceptions(
    formated: OpenAIChat[],
    rules: readonly RequestInterception[] | undefined,
    mode: ModelModeExtended,
): { formated: OpenAIChat[]; applied: number } {
    const { start, end } = interceptionMessages(rules, mode);
    const last = formated[formated.length - 1];
    const body = last?.role === "assistant" ? [...formated.slice(0, -1), ...end, last] : [...formated, ...end];
    return { formated: [...start, ...body], applied: start.length + end.length };
}
