import type { Credential, CustomModel } from "../database.ts";
import type { LLMModel } from "../llm.ts";
import { credentialSlotOf } from "./credentialSlots.ts";

export type CredentialBindingSources = {
    modelCredentials?: Readonly<Record<string, string>>;
    customModels: readonly Pick<CustomModel, "id" | "credentialId">[];
    proxyCredentialId?: string;
};

/** The common metadata of tab records and server records (which also hold a plaintext key). */
export type CredentialBindingRecord = Pick<Credential, "name" | "type" | "clientEmail" | "projectId">;

export type CredentialRefusalReason = "missing" | "empty" | "typeMismatch" | "vertexEmailMissing" | "unsupportedModel";

export type CredentialBinding<T extends CredentialBindingRecord> =
    | { kind: "default" }
    | { kind: "bound"; credentialId: string; record: T }
    | { kind: "refused"; credentialId: string; record?: T; reason: CredentialRefusalReason };

function ownBinding(record: unknown, field: string): string | undefined {
    if (!record || typeof record !== "object" || !Object.hasOwn(record, field)) {
        return undefined;
    }
    const value = (record as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
}

/** An invalid binding refuses; only an absent binding selects the existing default. */
export function resolveCredentialBinding<T extends CredentialBindingRecord>(
    modelId: string,
    modelInfo: Pick<LLMModel, "provider" | "format" | "keyIdentifier">,
    sources: CredentialBindingSources,
    credentials: Readonly<Record<string, T>>,
    hasKey: (credential: T) => boolean,
): CredentialBinding<T> {
    const slot = credentialSlotOf(modelId, modelInfo);
    let binding: string | undefined;
    switch (slot?.binding) {
        case "customModel":
            binding = ownBinding(
                sources.customModels.find((model) => model.id === modelId),
                "credentialId",
            );
            break;
        case "modelPreset":
            binding = ownBinding(sources, "proxyCredentialId");
            break;
        default:
            binding = ownBinding(sources.modelCredentials, modelId);
            break;
    }
    if (binding === undefined) {
        return { kind: "default" };
    }

    const record = Object.hasOwn(credentials, binding) ? credentials[binding] : undefined;
    const refused = (reason: CredentialRefusalReason): CredentialBinding<T> => ({
        kind: "refused",
        credentialId: binding,
        ...(record !== undefined ? { record } : {}),
        reason,
    });
    // Order matters: both the tab and the server show the first failure, with no default fallback.
    if (!slot) {
        return refused("unsupportedModel");
    }
    if (!record) {
        return refused("missing");
    }
    if (!hasKey(record)) {
        return refused("empty");
    }
    if (!slot.accepts.includes(record.type)) {
        return refused("typeMismatch");
    }
    if (record.type === "vertex" && !record.clientEmail) {
        return refused("vertexEmailMissing");
    }
    return { kind: "bound", credentialId: binding, record };
}
