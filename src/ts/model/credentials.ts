import type { Credential } from "../../../shared/database.ts";
import { resolveCredentialBinding, type CredentialRefusalReason } from "../../../shared/llm/credentialBinding.ts";
import { credentialSlotOf, type CredentialSlot } from "../../../shared/llm/credentialSlots.ts";
import { secretStatus } from "../storage/llmSecrets.svelte";
import { activeModelPreset, scopedPresetRoot, settings, type PresetScope } from "../storage/settingsViews.svelte";
import { getModelInfo } from "./modellist";

export type ModelCredential = { slot: CredentialSlot | null } & (
    | { state: "default" }
    | { state: "bound"; credentialId: string; record: Credential }
    | { state: "refused"; credentialId: string; record?: Credential; reason: CredentialRefusalReason }
);

/** The model's binding decision, using only metadata and masked (including pending) key status. */
export function credentialFor(modelId: string, scope?: PresetScope): ModelCredential {
    const modelInfo = getModelInfo(modelId, scope);
    const slot = credentialSlotOf(modelId, modelInfo);
    const binding = resolveCredentialBinding(
        modelId,
        modelInfo,
        {
            modelCredentials: settings.providers.modelCredentials,
            customModels: settings.customModels,
            proxyCredentialId: (scope
                ? scopedPresetRoot(scope, "proxyCredentialId")
                : activeModelPreset.proxyCredentialId) as string | undefined,
        },
        Object.fromEntries(settings.credentials.map((record) => [record.id, record])),
        (record) => secretStatus({ kind: "entry", field: "credentials", id: record.id }).set,
    );
    if (binding.kind === "default") {
        return { slot, state: "default" };
    }
    if (binding.kind === "refused") {
        return {
            slot,
            state: "refused",
            credentialId: binding.credentialId,
            record: binding.record,
            reason: binding.reason,
        };
    }
    return { slot, state: "bound", credentialId: binding.credentialId, record: binding.record };
}

/** Select options in collection order; a model with no slot has no options. */
export function credentialsAccepted(modelId: string): Credential[] {
    const slot = credentialSlotOf(modelId, getModelInfo(modelId));
    return slot ? settings.credentials.filter((record) => slot.accepts.includes(record.type)) : [];
}

export type CredentialUsage = {
    kind: "model" | "customModel" | "modelPreset";
    id: string;
    name: string;
};

/** Every stored binding naming this id, including ignored global entries and inactive model presets. */
export function credentialsUsing(credentialId: string): CredentialUsage[] {
    const uses: CredentialUsage[] = [];
    for (const [modelId, binding] of Object.entries(settings.providers.modelCredentials)) {
        if (binding === credentialId) {
            uses.push({ kind: "model", id: modelId, name: getModelInfo(modelId).name });
        }
    }
    for (const model of settings.customModels) {
        if (Object.hasOwn(model, "credentialId") && model.credentialId === credentialId) {
            uses.push({ kind: "customModel", id: model.id, name: model.name });
        }
    }
    for (const preset of settings.modelPresets) {
        if (Object.hasOwn(preset, "proxyCredentialId") && preset.proxyCredentialId === credentialId) {
            uses.push({ kind: "modelPreset", id: preset.id, name: preset.name });
        }
    }
    return uses;
}
