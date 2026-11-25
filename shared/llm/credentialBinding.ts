import type { Credential, ModelProfile } from "../database.ts";
import type { LLMModel } from "../llm.ts";
import { credentialSlotOf } from "./credentialSlots.ts";

/**
 * Named-key binding decisions shared by `src/ts/model/credentials.ts` and `server/src/llm/credentials.ts`.
 * Only an own string `credentialId` binds a profile; an empty string is still a binding and can refuse. Missing or
 * invalid bindings never select another named key, and a refused binding never falls back to the provider default.
 * Key presence is supplied by each runtime so plaintext secrets stay outside this resolver.
 */

/** The common metadata of tab records and server records (which also hold a plaintext key). */
export type CredentialBindingRecord = Pick<Credential, "name" | "type" | "clientEmail" | "projectId">;

/** The first failing named-key check, as ordered by `resolveCredentialBinding`. */
export type CredentialRefusalReason = "missing" | "empty" | "typeMismatch" | "vertexEmailMissing" | "unsupportedModel";

/** A default-key choice, a valid named record, or a refusal retaining the binding and any record found. */
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

/**
 * The one named-key binding decision; the tab's state (`src/ts/model/credentials.ts`) and the server's decision
 * (`server/src/llm/credentials.ts`) both come from here, so change the rules here, not in a caller. It reads only the
 * profile's own `credentialId`: none, or no profile, is `default`. An invalid binding refuses with the first failing
 * reason, in order `unsupportedModel` (a binding on a model with no credential slot), `missing`, `empty` (`hasKey`
 * false: the plaintext on the server, the masked status in the tab), `typeMismatch`, `vertexEmailMissing`; it never
 * falls back to the default key.
 */
export function resolveCredentialBinding<T extends CredentialBindingRecord>(
    modelId: string,
    modelInfo: Pick<LLMModel, "provider" | "format" | "keyIdentifier">,
    profile: Pick<ModelProfile, "credentialId"> | undefined,
    credentials: Readonly<Record<string, T>>,
    hasKey: (credential: T) => boolean,
): CredentialBinding<T> {
    const slot = credentialSlotOf(modelId, modelInfo);
    const binding = ownBinding(profile, "credentialId");
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
