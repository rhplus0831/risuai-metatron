import type { TranslatorStepModel } from "./settings.ts";
import { normalizeStepModel } from "./translatorPresets.ts";
import type { TranslatorHistory, TranslatorHistorySlot } from "./translation/historySlots.ts";
import { translatorHistoryCount } from "./translation/historySlots.ts";
import type { TranslatorChatMessage } from "./translation/pipeline.ts";
import { parseTranslatorChatML } from "./translation/pipeline.ts";
import { isPlainObject } from "./valueKinds.ts";

/**
 * Shared input hook data and pure request construction. Hook lists normalize identically in both
 * runtimes; prompts fill slots once and use the translator's ChatML and rendered history formats.
 * Stored model and chat choices are ids, with no lookup against other records here.
 */

export interface InputHook {
    id: string;
    name: string;
    type: "draft" | "btw";
    prompt: string;
    translation?: true;
    model: TranslatorStepModel;
}

export const MAX_INPUT_HOOKS = 50;

/** Fresh data for an absent hook list; an explicitly empty list needs no default. */
export function defaultInputHooks(): InputHook[] {
    return [
        {
            id: "default-translate",
            name: "Translate",
            type: "draft",
            prompt: "Translate the following user message into English. Preserve names, commands, markdown, and inlay tags. Output only the translated message.",
            model: { mode: "inherit" },
        },
    ];
}

/** Keeps the first valid entries by id, up to the limit; whitespace-only ids are malformed. */
export function normalizeInputHooks(value: unknown): InputHook[] {
    if (!Array.isArray(value)) {
        return defaultInputHooks();
    }
    const hooks: InputHook[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        if (
            !isPlainObject(entry) ||
            typeof entry.id !== "string" ||
            entry.id.trim().length === 0 ||
            seen.has(entry.id) ||
            typeof entry.name !== "string" ||
            (entry.type !== "draft" && entry.type !== "btw") ||
            typeof entry.prompt !== "string"
        ) {
            continue;
        }
        seen.add(entry.id);
        hooks.push({
            id: entry.id,
            name: entry.name,
            type: entry.type,
            prompt: entry.prompt,
            ...(entry.type === "draft" && entry.translation === true ? { translation: true as const } : {}),
            model: normalizeStepModel(entry.model),
        });
        if (hooks.length === MAX_INPUT_HOOKS) {
            break;
        }
    }
    return hooks;
}

/** A missing, malformed, stale, or BTW id selects no Draft hook. */
export function draftHookOf(hooks: readonly InputHook[], id: unknown): InputHook | null {
    if (typeof id !== "string" || id.trim().length === 0) {
        return null;
    }
    return hooks.find((hook) => hook.id === id && hook.type === "draft") ?? null;
}

/**
 * Like the translator's slots, a history count consumes any text up to the first closing braces.
 * The final alternative consumes unknown placeholders unchanged so their inner slots stay unread.
 * Groups: 1 the slot, 2 a history slot, 3 its count (invalid counts still hold a slot).
 */
const SLOT_PATTERN = /{{(slot::content|slot::draft|slot::(history|historytrans)::([^}]*))}}|{{[^}]*}}/g;

/** Valid history counts, each once, using the same one-pass match as request construction. */
export function inputHookHistoryCounts(prompt: string): number[] {
    const counts = new Set<number>();
    for (const match of prompt.matchAll(SLOT_PATTERN)) {
        const count = match[2] === undefined ? null : translatorHistoryCount(match[3]);
        if (count !== null) {
            counts.add(count);
        }
    }
    return [...counts];
}

/**
 * Fills the original template once, then parses ChatML or builds the plain prompt's request rows.
 * `history` is the rendered-text lookup returned by `buildTranslatorHistory` (slot and count → text).
 */
export function inputHookMessages(
    hook: Pick<InputHook, "prompt">,
    values: { content: string; draft: string },
    history?: TranslatorHistory,
): TranslatorChatMessage[] {
    let holdsSlot = false;
    const prompt = hook.prompt.replace(
        SLOT_PATTERN,
        (
            match: string,
            slot: string | undefined,
            historySlot: TranslatorHistorySlot | undefined,
            rawCount: string | undefined,
        ) => {
            if (slot === undefined) {
                return match;
            }
            holdsSlot = true;
            if (historySlot !== undefined) {
                const count = translatorHistoryCount(rawCount ?? "");
                return count === null ? "" : (history?.(historySlot, count) ?? "");
            }
            return slot === "slot::content" ? values.content : values.draft;
        },
    );
    const parsed = parseTranslatorChatML(prompt);
    if (parsed) {
        return parsed;
    }
    return holdsSlot
        ? [{ role: "user", content: prompt }]
        : [
              { role: "system", content: prompt },
              { role: "user", content: values.content },
          ];
}
