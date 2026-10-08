import type { LLMModel } from "../../../shared/llm.ts";
import { resolveCredentialBinding, type CredentialRefusalReason } from "../../../shared/llm/credentialBinding.ts";
import { messages } from "./messages.ts";
import type { RequestDb } from "./settings.ts";

export type ResolvedCredential =
    | { kind: "default" }
    | { kind: "key"; key: string }
    | { kind: "vertex"; clientEmail: string; privateKey: string; projectId?: string }
    | { kind: "refused"; message: string };

const refusalMessages: Record<CredentialRefusalReason, string> = {
    missing: messages.errors.credentialMissing,
    empty: messages.errors.credentialEmpty,
    typeMismatch: messages.errors.credentialTypeMismatch,
    vertexEmailMissing: messages.errors.credentialVertexEmailMissing,
    unsupportedModel: messages.errors.credentialUnsupportedModel,
};

/** Resolve only the slot's binding; an invalid binding never redirects to a default credential. */
export function resolveCredential(db: RequestDb, aiModel: string, modelInfo: LLMModel): ResolvedCredential {
    const binding = resolveCredentialBinding(
        aiModel,
        modelInfo,
        db,
        db.credentials ?? {},
        (credential) => !!credential.key,
    );
    if (binding.kind === "default") {
        return { kind: "default" };
    }
    if (binding.kind === "refused") {
        return {
            kind: "refused",
            message: messages.errors.credentialRefused(
                modelInfo.name && modelInfo.name !== aiModel ? `${modelInfo.name} (${aiModel})` : aiModel,
                binding.record?.name,
                refusalMessages[binding.reason],
            ),
        };
    }
    const credential = binding.record;
    if (credential.type === "vertex") {
        return {
            kind: "vertex",
            clientEmail: credential.clientEmail!,
            privateKey: credential.key,
            ...(credential.projectId !== undefined ? { projectId: credential.projectId } : {}),
        };
    }
    return { kind: "key", key: credential.key };
}
