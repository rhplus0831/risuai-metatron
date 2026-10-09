import type { Credential, ModelProfile } from "../../../shared/database.ts";
import { resolveCredentialBinding, type CredentialRefusalReason } from "../../../shared/llm/credentialBinding.ts";
import { credentialSlotOf, type CredentialSlot } from "../../../shared/llm/credentialSlots.ts";
import { secretStatus } from "../storage/llmSecrets.svelte";
import { settings } from "../storage/settingsViews.svelte";
import { getModelInfo } from "./modellist";

export type ModelCredential = { slot: CredentialSlot | null } & (
    | { state: "default" }
    | { state: "bound"; credentialId: string; record: Credential }
    | { state: "refused"; credentialId: string; record?: Credential; reason: CredentialRefusalReason }
);

/** A profile's binding decision, using metadata and masked (including pending) named-key status. */
export function credentialFor(profile: ModelProfile | undefined, modelId = profile?.modelId ?? ""): ModelCredential {
    const modelInfo = getModelInfo(modelId, undefined, profile ?? null);
    const slot = credentialSlotOf(modelId, modelInfo);
    const binding = resolveCredentialBinding(
        modelId,
        modelInfo,
        profile,
        Object.fromEntries((settings.credentials ?? []).map((record) => [record.id, record])),
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
    return slot ? (settings.credentials ?? []).filter((record) => slot.accepts.includes(record.type)) : [];
}

export type CredentialUsage = {
    kind: "modelProfile";
    id: string;
    name: string;
};

/** Every profile naming this credential, including profiles no preset currently uses. */
export function credentialsUsing(credentialId: string): CredentialUsage[] {
    return (settings.modelProfiles ?? [])
        .filter((profile) => profile.credentialId === credentialId)
        .map((profile) => ({ kind: "modelProfile", id: profile.id, name: profile.name }));
}
