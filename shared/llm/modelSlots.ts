import type { ModelPreset, ModelProfile, ModelSlot } from "../database.ts";
import type { ModelModeExtended } from "./request.ts";

const profileDefinitions = new Set([
    "reverse_proxy",
    "openrouter",
    "nanogpt",
    "ollama-hosted",
    "ollama-cloud",
    "ooba",
    "mancer",
    "kobold",
    "custom",
]);

/**
 * Definitions whose connection options or key choice require a profile (Model Profiles O8).
 * Only definition ids matter; catalogue descriptors and custom flags cannot change this rule.
 */
export function definitionNeedsProfile(modelId: string): boolean {
    return profileDefinitions.has(modelId) || modelId.startsWith("xcustom:::");
}

export type SlotProfileResolution =
    | { kind: "profile"; profile: ModelProfile; modelId: string }
    | { kind: "none"; modelId: string }
    | { kind: "refused"; reason: "missingProfile" | "needsProfile"; modelId?: string };

function bareModel(modelId: string): SlotProfileResolution {
    return definitionNeedsProfile(modelId)
        ? { kind: "refused", reason: "needsProfile", modelId }
        : { kind: "none", modelId };
}

/**
 * One slot-routing decision for the tab and server. A static model reuses only a matching main
 * profile (O5); auxiliary slots fall back to sub when disabled or unset, and `submodel` always
 * uses sub (O3). Dangling profile ids refuse, never redirect. A bare definition uses profile
 * field defaults and its flat default key unless it requires a profile (O8).
 *
 * Both runtimes already hold the profile collection as an array; no lookup needs to be built.
 */
export function resolveSlotProfile(
    modelPreset: ModelPreset,
    profiles: readonly ModelProfile[],
    mode: ModelModeExtended,
    staticModel?: string,
): SlotProfileResolution {
    if (staticModel !== undefined) {
        const profile = profiles.find((entry) => entry.id === modelPreset.mainSlot.profileId);
        return profile?.modelId === staticModel
            ? { kind: "profile", profile, modelId: staticModel }
            : bareModel(staticModel);
    }

    let slot: ModelSlot = mode === "model" ? modelPreset.mainSlot : modelPreset.subSlot;
    if (modelPreset.seperateModelsForAxModels && mode !== "model" && mode !== "submodel") {
        slot = modelPreset.auxSlots[mode] ?? modelPreset.subSlot;
    }
    if ("modelId" in slot) {
        return bareModel(slot.modelId);
    }
    const profileId = slot.profileId;
    const profile = profiles.find((entry) => entry.id === profileId);
    return profile
        ? { kind: "profile", profile, modelId: profile.modelId }
        : { kind: "refused", reason: "missingProfile" };
}
