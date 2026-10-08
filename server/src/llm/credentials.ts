import type { LLMModel } from "../../../shared/llm.ts";
import { credentialSlotOf } from "../../../shared/llm/credentialSlots.ts";
import { messages } from "./messages.ts";
import type { RequestDb } from "./settings.ts";

export type ResolvedCredential =
    | { kind: "default" }
    | { kind: "key"; key: string }
    | { kind: "vertex"; clientEmail: string; privateKey: string; projectId?: string }
    | { kind: "refused"; message: string };

function ownBinding(record: unknown, field: string): string | undefined {
    if (!record || typeof record !== "object" || !Object.hasOwn(record, field)) {
        return undefined;
    }
    const value = (record as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
}

/** Resolve only the slot's binding; an invalid binding never redirects to a default credential. */
export function resolveCredential(db: RequestDb, aiModel: string, modelInfo: LLMModel): ResolvedCredential {
    const slot = credentialSlotOf(aiModel, modelInfo);
    let binding: string | undefined;
    switch (slot?.binding) {
        case "customModel":
            binding = ownBinding(
                db.customModels.find((model) => model.id === aiModel),
                "credentialId",
            );
            break;
        case "modelPreset":
            binding = ownBinding(db, "proxyCredentialId");
            break;
        default:
            binding = ownBinding(db.modelCredentials, aiModel);
            break;
    }
    if (binding === undefined) {
        return { kind: "default" };
    }

    const credentials = db.credentials ?? {};
    const credential = Object.hasOwn(credentials, binding) ? credentials[binding] : undefined;
    const refused = (reason: string): ResolvedCredential => ({
        kind: "refused",
        message: messages.errors.credentialRefused(
            modelInfo.name && modelInfo.name !== aiModel ? `${modelInfo.name} (${aiModel})` : aiModel,
            credential?.name,
            reason,
        ),
    });
    if (!slot) {
        return refused(messages.errors.credentialUnsupportedModel);
    }
    if (!credential) {
        return refused(messages.errors.credentialMissing);
    }
    if (!credential.key) {
        return refused(messages.errors.credentialEmpty);
    }
    if (!slot.accepts.includes(credential.type)) {
        return refused(messages.errors.credentialTypeMismatch);
    }
    if (credential.type === "vertex") {
        if (!credential.clientEmail) {
            return refused(messages.errors.credentialVertexEmailMissing);
        }
        return {
            kind: "vertex",
            clientEmail: credential.clientEmail,
            privateKey: credential.key,
            ...(credential.projectId !== undefined ? { projectId: credential.projectId } : {}),
        };
    }
    return { kind: "key", key: credential.key };
}
