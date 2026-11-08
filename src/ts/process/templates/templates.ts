/**
 * Re-exports the built-in preset data and template type from `shared/presetTemplates.ts` for tab
 * callers. Templates carry no stored id; normalization and identity assignment belong to consumers.
 */

/** Re-exports built-in prompt templates and NovelAI defaults; consumers assign preset identity. */
export { prebuiltNAIpresets, prebuiltPresets, type PresetTemplate } from "../../../../shared/presetTemplates.ts";
