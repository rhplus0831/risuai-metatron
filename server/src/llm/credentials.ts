import type { LLMModel } from "../../../shared/llm.ts";
import type { ModelProfile } from "../../../shared/database.ts";
import { resolveCredentialBinding, type CredentialRefusalReason } from "../../../shared/llm/credentialBinding.ts";
import { messages } from "./messages.ts";
import type { RequestDb } from "./settings.ts";

/**
 * Resolves server-side credential bindings through shared/llm/credentialBinding.ts and translates refusal reasons
 * with server/src/llm/messages.ts. A missing binding leaves key selection to the adapter; an invalid binding refuses
 * without falling back. Bound keys retain their stored spelling, and Vertex accounts carry their email and optional
 * project id separately. Custom definitions and reverse proxies receive no flat default key.
 */

/** A binding's outcome; `default` carries no key and leaves the choice to the adapter. */
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

/** Custom definitions and reverse proxies have no flat default key: the profile binds one. */
export function defaultCredentialKey(modelId: string | undefined, defaultKey: string | undefined): string {
    return modelId === "reverse_proxy" || modelId?.startsWith("xcustom:::") ? "" : (defaultKey ?? "");
}

/**
 * Resolve only the profile's binding; an invalid binding never redirects to a default credential. It is
 * `shared/llm/credentialBinding.ts` `resolveCredentialBinding` over the resolved profile and the plaintext keys (a
 * key counts when it is nonblank), answered as `default`, `key`, `vertex` (`clientEmail`, `privateKey`,
 * `projectId?`), or `refused` with an English message (`server/src/llm/messages.ts` `errors.credential*`) that names
 * the model and, when a record exists, the key's name, never its value.
 */
export function resolveCredential(
    db: Pick<RequestDb, "credentials">,
    aiModel: string,
    modelInfo: LLMModel,
    profile: Pick<ModelProfile, "credentialId"> | undefined,
): ResolvedCredential {
    const binding = resolveCredentialBinding(
        aiModel,
        modelInfo,
        profile,
        db.credentials ?? {},
        (credential) => credential.key.trim() !== "",
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
