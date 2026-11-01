import { isRecordId, newId } from "./ids.ts";
import type { HypaV3Preset, HypaV3Settings } from "./memory.ts";
import { normalizeStructuredMemorySettings } from "./structuredMemory.ts";

/** The settings that are token amounts: integers >= 0. */
const TOKEN_AMOUNT_KEYS: ReadonlySet<string> = new Set([
    "gapConfirmTokens",
    "memoryBudgetTokens",
    "lookaheadHeadroomTokens",
    "extraSummarizationTokens",
]);

/**
 * A HypaV3 preset with every setting filled: own, known keys of `existingSettings` with the right
 * type are kept. Numbers must also be finite, `maxChatsPerSummary` and `queryChatCount` must be
 * integers >= 1, `gapConfirmTokens`, `memoryBudgetTokens`, `lookaheadHeadroomTokens`, and
 * `extraSummarizationTokens` integers >= 0, `lookaheadHeadroomRatio` in [0, 1), and `budgetMode`
 * `"ratio"` or `"tokens"`. Invalid values take their defaults; `budgetMode`'s is `"ratio"`, so a
 * stored or imported preset without one keeps its ratios. `structured` is filled field by field
 * (`normalizeStructuredMemorySettings`). `id` is kept when it is a valid record id, otherwise a new
 * one is assigned (a copy or an import passes none, so it gets a fresh id).
 */
export function createHypaV3Preset(name = "New Preset", existingSettings = {}, id?: unknown): HypaV3Preset {
    const settings: HypaV3Settings = {
        summarizationModel: "subModel",
        summarizationPrompt: "",
        reSummarizationPrompt: "",
        memoryTokensRatio: 0.2,
        extraSummarizationRatio: 0,
        lookaheadHeadroomRatio: 0.15,
        budgetMode: "ratio",
        memoryBudgetTokens: 6000,
        lookaheadHeadroomTokens: 4000,
        extraSummarizationTokens: 0,
        maxChatsPerSummary: 6,
        recentMemoryRatio: 0.4,
        similarMemoryRatio: 0.4,
        enableSimilarityCorrection: false,
        preserveOrphanedMemory: false,
        processRegexScript: false,
        doNotSummarizeUserMessage: false,
        summaryChunkSeparator: "\\n\\n",
        // Experimental
        useExperimentalImpl: false,
        summarizationRequestsPerMinute: 20,
        summarizationMaxConcurrent: 1,
        embeddingRequestsPerMinute: 100,
        embeddingMaxConcurrent: 1,
        alwaysToggleOn: false,
        queryChatCount: 3,
        gapConfirmTokens: 10000,
        structured: normalizeStructuredMemorySettings(undefined),
    };

    if (existingSettings && typeof existingSettings === "object" && !Array.isArray(existingSettings)) {
        const target = settings as unknown as Record<string, unknown>;
        for (const [key, value] of Object.entries(existingSettings)) {
            // `typeof` would let null and arrays past the object default.
            if (key === "structured") {
                settings.structured = normalizeStructuredMemorySettings(value);
                continue;
            }
            // Own keys only: `in` also matches `__proto__`, whose assignment would swap the prototype.
            if (Object.hasOwn(target, key) && typeof value === typeof target[key]) {
                if (typeof value === "number") {
                    if (!Number.isFinite(value)) {
                        continue;
                    }
                    if (
                        (key === "maxChatsPerSummary" || key === "queryChatCount") &&
                        (!Number.isInteger(value) || value < 1)
                    ) {
                        continue;
                    }
                    if (TOKEN_AMOUNT_KEYS.has(key) && (!Number.isInteger(value) || value < 0)) {
                        continue;
                    }
                    if (key === "lookaheadHeadroomRatio" && (value < 0 || value >= 1)) {
                        continue;
                    }
                }
                if (key === "budgetMode" && value !== "ratio" && value !== "tokens") {
                    continue;
                }
                target[key] = value;
            }
        }
    }

    return {
        id: isRecordId(id) ? id : newId(),
        name,
        settings,
    };
}

/** A token-mode value `resolveHypaV3Budget` reduced to fit the context. */
export type HypaV3BudgetReduction = {
    field: "memory" | "headroom" | "extra";
    /** The preset's amount: `memoryBudgetTokens`, `lookaheadHeadroomTokens`, or `extraSummarizationTokens`. */
    configured: number;
    /** The amount the step uses. */
    applied: number;
};

/**
 * The thresholds a HypaV3 step compares its count with, in that count's terms (the space of the max
 * context `C`), from either budget mode.
 */
export type HypaV3Budget = {
    /** The full memory budget. */
    readonly memoryTokens: number;
    /** The target of an ordinary plan (which summarizes above `C`). */
    readonly targetTokens: number;
    /** The trigger of a lookahead plan (the background summaries): it summarizes above it. */
    readonly lookaheadTrigger: number;
    /** The target of a lookahead plan. */
    readonly lookaheadTarget: number;
    /** Token mode: the amounts reduced to fit, in the order memory, headroom, extra; empty in ratio mode. */
    readonly reduced: readonly HypaV3BudgetReduction[];
};

/**
 * The thresholds of a HypaV3 step with the max context `maxContext` (`C`) and the response size
 * `maxResponse`.
 *
 * Ratio mode (any `budgetMode` but `"tokens"`) keeps the ratio expressions as written, in their
 * floating-point order: `floor(C × memoryTokensRatio)`, `C × (1 − e)`, `C × (1 − h)`, and
 * `max(0, C × (1 − h − e))`. They are returned as thresholds, never as amounts to subtract:
 * `C − C × h` can differ from `C × (1 − h)` and move a boundary such as `floor(C × (1 − h)) + 1`.
 * Nothing is reduced.
 *
 * Token mode reduces the preset's amounts to fit the prompt budget `P = max(0, C − maxResponse)`,
 * with `half = floor(P / 2)`: the memory budget to at most `half`, and the headroom and the extra
 * summarization together to at most `half`, the headroom first
 * (`headroom = min(headroom, max(0, half − extra))`, then `extra = min(extra, half − headroom)`). This
 * keeps the lookahead target `C − headroom − extra` at or above `C − half`, and half of the prompt
 * budget free of the memory card. The thresholds are `memory`, `C − extra`, `C − headroom`, and
 * `max(0, C − headroom − extra)`; `reduced` lists each amount the reduction changed. A `C` or
 * `maxResponse` that is not a positive finite number counts as 0 in `P`, and so does an amount (a
 * fraction is rounded down).
 */
export function resolveHypaV3Budget(
    settings: Readonly<
        Pick<
            HypaV3Settings,
            | "budgetMode"
            | "memoryTokensRatio"
            | "extraSummarizationRatio"
            | "lookaheadHeadroomRatio"
            | "memoryBudgetTokens"
            | "lookaheadHeadroomTokens"
            | "extraSummarizationTokens"
        >
    >,
    maxContext: number,
    maxResponse: number,
): HypaV3Budget {
    // The stored values are kept as they are (parity, the import contract); only the arithmetic is
    // guarded: a hand-edited or imported ratio outside [0, 1] or a nonfinite context would otherwise
    // plan memory with negative room or nonfinite thresholds.
    const context = positiveOrZero(maxContext);
    if (settings.budgetMode !== "tokens") {
        const headroom = unitRatio(settings.lookaheadHeadroomRatio);
        const extra = unitRatio(settings.extraSummarizationRatio);
        return {
            memoryTokens: Math.floor(context * unitRatio(settings.memoryTokensRatio)),
            targetTokens: context * (1 - extra),
            lookaheadTrigger: context * (1 - headroom),
            lookaheadTarget: Math.max(0, context * (1 - headroom - extra)),
            reduced: [],
        };
    }

    const half = Math.floor(Math.max(0, context - positiveOrZero(maxResponse)) / 2);
    const configured = {
        memory: Math.floor(positiveOrZero(settings.memoryBudgetTokens)),
        headroom: Math.floor(positiveOrZero(settings.lookaheadHeadroomTokens)),
        extra: Math.floor(positiveOrZero(settings.extraSummarizationTokens)),
    };
    const memory = Math.min(configured.memory, half);
    const headroom = Math.min(configured.headroom, Math.max(0, half - configured.extra));
    const extra = Math.min(configured.extra, half - headroom);
    const applied = { memory, headroom, extra };
    const reduced: HypaV3BudgetReduction[] = [];
    for (const field of ["memory", "headroom", "extra"] as const) {
        if (applied[field] !== configured[field]) {
            reduced.push({ field, configured: configured[field], applied: applied[field] });
        }
    }
    return {
        memoryTokens: memory,
        targetTokens: context - extra,
        lookaheadTrigger: context - headroom,
        lookaheadTarget: Math.max(0, context - headroom - extra),
        reduced,
    };
}

/** `value` when it is a positive finite number, else 0. */
function positiveOrZero(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : 0;
}

/** `value` clamped to [0, 1]; 0 when it is not a finite number. */
function unitRatio(value: number): number {
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * The selected HypaV3 preset: the one whose id is `hypaV3PresetId`, else the first (the server keeps
 * the list nonempty and the id valid; the fallback covers another client's deletion until reload).
 */
export function selectedHypaV3Preset(state: {
    hypaV3Presets?: HypaV3Preset[];
    hypaV3PresetId?: string;
}): HypaV3Preset | undefined {
    const presets = state.hypaV3Presets ?? [];
    return presets.find((preset) => preset.id === state.hypaV3PresetId) ?? presets[0];
}
