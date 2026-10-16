import { LLMFormat, type LLMModel } from "../llm.ts";
import type { MultiModal } from "../openai.ts";

const DEFAULT_IMAGE_SIZE = 512;
const TILE_SIZE = 512;
const TILE_MAX_DIMENSION = 2048;
const TILE_SHORT_SIDE = 768;
const PATCH_SIZE = 32;
const PATCH_MAX_DIMENSION = 2048;
const ASTRA_MAX_DIMENSION = 65535;
const HIGH_PATCH_BUDGET = 2500;
const LARGE_PATCH_BUDGET = 6144;
const LEGACY_PATCH_BUDGET = 1536;

/** Inherited placeholder: the app has no video, audio, or signature token formula. */
export const NON_IMAGE_TOKENS = 85;

type Detail = "low" | "high";
type TileRule = { kind: "tile"; base: number; tile: number };
type PatchLimits = { maxDimension: number; budget?: number };
type PatchRule = { kind: "patch"; multiplier: number; low: PatchLimits; high: PatchLimits };
type ImageRule = TileRule | PatchRule;

const LOW_PATCH_LIMITS: PatchLimits = { maxDimension: DEFAULT_IMAGE_SIZE };
const HIGH_PATCH_LIMITS: PatchLimits = { maxDimension: PATCH_MAX_DIMENSION, budget: HIGH_PATCH_BUDGET };
const LARGE_PATCH_LIMITS: PatchLimits = { maxDimension: PATCH_MAX_DIMENSION, budget: LARGE_PATCH_BUDGET };
const LEGACY_PATCH_LIMITS: PatchLimits = { maxDimension: PATCH_MAX_DIMENSION, budget: LEGACY_PATCH_BUDGET };
const GPT4O_RULE: TileRule = { kind: "tile", base: 85, tile: 170 };
const patchRule = (multiplier: number, low: PatchLimits, high = low): PatchRule => ({
    kind: "patch",
    multiplier,
    low,
    high,
});

// Source: https://developers.openai.com/api/docs/guides/images-vision#calculating-costs
// Match specific mini/nano and versioned families before their broader families.
const IMAGE_RULES: ReadonlyArray<{ model: RegExp; rule: ImageRule }> = [
    {
        model: /^gpt-6-astra(?:-|$)/,
        rule: patchRule(1.2, LOW_PATCH_LIMITS, { maxDimension: ASTRA_MAX_DIMENSION, budget: HIGH_PATCH_BUDGET }),
    },
    { model: /^gpt-5\.6-(?:sol|terra|luna)(?:-|$)/, rule: patchRule(1.2, LOW_PATCH_LIMITS, HIGH_PATCH_LIMITS) },
    { model: /^gpt-5\.5(?:-|$)/, rule: patchRule(1.2, LOW_PATCH_LIMITS, HIGH_PATCH_LIMITS) },
    { model: /^gpt-5\.4(?:-|$)/, rule: patchRule(1.2, LARGE_PATCH_LIMITS, HIGH_PATCH_LIMITS) },
    { model: /^gpt-5\.2(?:-|$)/, rule: patchRule(1.2, LARGE_PATCH_LIMITS) },
    { model: /^gpt-4\.1-mini(?:-|$)/, rule: patchRule(1.62, LARGE_PATCH_LIMITS) },
    // Deprecated models retain the 2025 docs' 1536-patch cap; the current page lists
    // their multipliers but no longer lists their sizing limits.
    { model: /^gpt-5-mini(?:-|$)/, rule: patchRule(1.2, LEGACY_PATCH_LIMITS) },
    { model: /^gpt-5-nano(?:-|$)/, rule: patchRule(1.5, LEGACY_PATCH_LIMITS) },
    { model: /^gpt-4\.1-nano(?:-|$)/, rule: patchRule(2.46, LEGACY_PATCH_LIMITS) },
    { model: /^o4-mini(?:-|$)/, rule: patchRule(1.72, LEGACY_PATCH_LIMITS) },
    { model: /^gpt-4o-mini(?:-|$)/, rule: { kind: "tile", base: 2833, tile: 5667 } },
    { model: /^gpt-5\.1(?:-|$)/, rule: { kind: "tile", base: 70, tile: 140 } },
    { model: /^gpt-5(?:-2025-08-07|-chat-latest)?$/, rule: { kind: "tile", base: 70, tile: 140 } },
    { model: /^(?:gpt-4o(?:-|$)|chatgpt-4o-latest$|gpt-4\.1(?:-\d{4}-\d{2}-\d{2})?$)/, rule: GPT4O_RULE },
    // Assumptions beyond the documented tile families: GPT-4.5/vision use GPT-4o's
    // rates, and o3-pro/mini/deep-research use o3's. Snapshots/aliases inherit the
    // family's rule (as do patch variants such as 5.4-pro and o4-mini-deep-research).
    { model: /^(?:gpt-4\.5-preview(?:-|$)|gpt-4-vision-preview$)/, rule: GPT4O_RULE },
    {
        model: /^(?:o1(?:-pro)?|o3(?:-pro|-mini|-deep-research)?)(?:-\d{4}-\d{2}-\d{2})?$/,
        rule: { kind: "tile", base: 75, tile: 150 },
    },
];

/** These formats send image `detail` through the OpenAI Chat or Responses adapters. */
function sendsImageDetail(format: LLMFormat): boolean {
    return (
        format === LLMFormat.OpenAICompatible ||
        format === LLMFormat.OpenAIResponseAPI ||
        format === LLMFormat.Mistral ||
        format === LLMFormat.NanoGPT ||
        format === LLMFormat.NanoGPTResponses
    );
}

function fitWithin(width: number, height: number, maxDimension: number): [number, number] {
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    return [width * scale, height * scale];
}

function countTiles(width: number, height: number, detail: Detail, rule: TileRule): number {
    if (detail === "low") return rule.base;
    [width, height] = fitWithin(width, height, TILE_MAX_DIMENSION);
    const shortSide = Math.min(width, height);
    if (shortSide > TILE_SHORT_SIDE) {
        const scale = TILE_SHORT_SIDE / shortSide;
        width = Math.floor(width * scale);
        height = Math.floor(height * scale);
    }
    const tiles = Math.ceil(width / TILE_SIZE) * Math.ceil(height / TILE_SIZE);
    return rule.base + rule.tile * tiles;
}

function countPatches(width: number, height: number, detail: Detail, rule: PatchRule): number {
    const { maxDimension, budget } = rule[detail];
    [width, height] = fitWithin(width, height, maxDimension);
    width = Math.max(1, Math.floor(width));
    height = Math.max(1, Math.floor(height));
    let patches = Math.ceil(width / PATCH_SIZE) * Math.ceil(height / PATCH_SIZE);
    if (budget !== undefined && patches > budget) {
        const shrink = Math.sqrt((PATCH_SIZE ** 2 * budget) / (width * height));
        const scaledWidth = (width * shrink) / PATCH_SIZE;
        const scaledHeight = (height * shrink) / PATCH_SIZE;
        const adjustment = Math.min(Math.floor(scaledWidth) / scaledWidth, Math.floor(scaledHeight) / scaledHeight);
        width = Math.floor(width * shrink * adjustment);
        height = Math.floor(height * shrink * adjustment);
        patches = Math.ceil(width / PATCH_SIZE) * Math.ceil(height / PATCH_SIZE);
    }
    return Math.ceil(patches * rule.multiplier);
}

/** One image's estimate, excluding the message overhead that ChatTokenCounter already adds. */
export function imageTokens(
    image: Pick<MultiModal, "width" | "height">,
    model: LLMModel | undefined,
    requestModel: string | undefined,
    quality: string | undefined,
): number {
    const wireId = (requestModel ?? model?.internalID ?? model?.id ?? "").replace(/^openai\//, "");
    // Explicit fallback for every unknown wire id, including other vendors and custom models.
    const rule = IMAGE_RULES.find(({ model }) => model.test(wireId))?.rule ?? GPT4O_RULE;
    // The app treats auto/unspecified as high. Formats without detail always count as high.
    const detail = quality === "low" && sendsImageDetail(model?.format ?? LLMFormat.OpenAICompatible) ? "low" : "high";
    let { width = DEFAULT_IMAGE_SIZE, height = DEFAULT_IMAGE_SIZE } = image;
    // Missing (or invalid) dimensions represent a 512x512 image, not zero tiles/patches.
    if (
        image.width === undefined ||
        image.height === undefined ||
        !(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))
    ) {
        width = DEFAULT_IMAGE_SIZE;
        height = DEFAULT_IMAGE_SIZE;
    }
    return rule.kind === "tile" ? countTiles(width, height, detail, rule) : countPatches(width, height, detail, rule);
}
