import { secretPathKey, type SecretPath } from "../../../shared/llmSecrets.ts";
import type { Credential, ModelProfile } from "../../../shared/database.ts";
import { resolveCredentialBinding, type CredentialRefusalReason } from "../../../shared/llm/credentialBinding.ts";
import { credentialSlotOf, type CredentialSlot } from "../../../shared/llm/credentialSlots.ts";
import { secretStatus, secretVersion } from "../storage/llmSecrets.svelte";
import { settings } from "../storage/settingsViews.svelte";
import { getModelInfo } from "./modellist";

/**
 * The tab's named-key readers over the settings views. An absent `credentials` or `modelProfiles` collection reads as
 * empty. Every binding decision is `shared/llm/credentialBinding.ts` `resolveCredentialBinding`.
 */

/** The model's accepted key slot paired with its default, bound, or refused named-key decision. */
export type ModelCredential = { slot: CredentialSlot | null } & (
    | { state: "default" }
    | { state: "bound"; credentialId: string; record: Credential }
    | { state: "refused"; credentialId: string; record?: Credential; reason: CredentialRefusalReason }
);

/**
 * A profile's binding decision: `resolveCredentialBinding` over the profile, the credential records, and
 * `secretStatus` (masked status, pending writes included).
 */
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

/**
 * Masked key gates and a refresh identity that changes on binding switches as well as key writes. The NanoGPT
 * account, subscription, and provider reads gate on `keySet` (false for a refused binding); the discovery callers
 * (OpenRouter, NanoGPT, Ollama cloud) refetch on `keyVersion`, which holds the profile, the binding path, the refusal
 * state, and that key's `secretVersion`, so switching between named keys or from the default to a bound key
 * refetches.
 */
export function credentialStatusFor(profile: ModelProfile | undefined, defaultPath: SecretPath) {
    const binding = credentialFor(profile);
    const path: SecretPath =
        binding.state === "default" ? defaultPath : { kind: "entry", field: "credentials", id: binding.credentialId };
    const keySet = binding.state !== "refused" && secretStatus(path).set;
    return {
        state: binding.state,
        keySet,
        keyVersion: JSON.stringify([
            profile?.id,
            profile?.modelId,
            binding.state,
            binding.state === "refused" ? binding.reason : null,
            secretPathKey(path),
            secretVersion(path),
            keySet,
        ]),
    };
}

/** Select options in collection order (`src/lib/UI/GUI/CredentialSelect.svelte`); a model with no slot has none. */
export function credentialsAccepted(modelId: string): Credential[] {
    const slot = credentialSlotOf(modelId, getModelInfo(modelId));
    return slot ? (settings.credentials ?? []).filter((record) => slot.accepts.includes(record.type)) : [];
}

/** A model profile to show when confirming deletion of a credential it names. */
export type CredentialUsage = {
    kind: "modelProfile";
    id: string;
    name: string;
};

/**
 * Every profile naming this credential, including profiles no preset currently uses: the delete confirmation in
 * `src/lib/Setting/Pages/ApiKeysSettings.svelte`.
 */
export function credentialsUsing(credentialId: string): CredentialUsage[] {
    return (settings.modelProfiles ?? [])
        .filter((profile) => profile.credentialId === credentialId)
        .map((profile) => ({ kind: "modelProfile", id: profile.id, name: profile.name }));
}
