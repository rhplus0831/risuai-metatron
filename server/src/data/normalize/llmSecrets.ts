import { isRecordId } from "../../../../shared/ids.ts";
import type { LlmSecretsResource } from "../../../../shared/resources.ts";
import { ResourceValidationError } from "../resourceStore.ts";
import { isPlainObject, normalizeSection, requireObject, type SectionSpec } from "./shared.ts";

/**
 * The `llmSecrets` section: the LLM credentials under their `Database` names, plus `modelPresets`,
 * each model preset's `proxyKey` keyed by model preset id, and `customModels`, each custom model's
 * `key` keyed by model id, and `credentials`, named keys by record id (an entry of a deleted owner
 * is harmless and is removed with it).
 * The former per-prompt-preset `presets` map is not read, so the normalizer drops it. Write-only
 * for clients (Phase 5 slice 7b): `shared/llmSecrets.ts`.
 */
const spec: SectionSpec<"llmSecrets"> = {
    openAIKey: ["string", ""],
    claudeAPIKey: ["string"],
    openrouterKey: ["string", ""],
    nanogptKey: ["string", ""],
    mistralKey: ["string"],
    cohereAPIKey: ["string"],
    ollamaApiKey: ["string", ""],
    novellistAPI: ["string"],
    mancerHeader: ["string", ""],
    supaMemoryKey: ["string", ""],
    google: ["object", { accessToken: "", projectId: "" }],
    hordeConfig: ["object", { apiKey: "", model: "", softPrompt: "" }],
    novelai: ["object", { token: "", model: "clio-v1" }],
    vertexPrivateKey: ["string", ""],
    vertexClientEmail: ["string", ""],
    vertexAccessToken: ["string", ""],
    vertexAccessTokenExpires: ["number", 0],
    OaiCompAPIKeys: ["object", {}],
};

export function normalizeLlmSecrets(input: unknown): LlmSecretsResource {
    const record = normalizeSection("llmSecrets", spec, input);
    if (isPlainObject(record.google)) {
        record.google.accessToken ??= "";
        record.google.projectId ??= "";
    }
    const source = input === undefined ? {} : requireObject(input, "llmSecrets");
    const modelPresets: [string, { proxyKey: string }][] = [];
    if (source.modelPresets !== undefined) {
        for (const [id, entry] of Object.entries(requireObject(source.modelPresets, "llmSecrets.modelPresets"))) {
            if (!isRecordId(id) || !isPlainObject(entry) || typeof entry.proxyKey !== "string") {
                throw new ResourceValidationError(
                    "llmSecrets.modelPresets must map model preset ids to { proxyKey: string }",
                );
            }
            modelPresets.push([id, { proxyKey: entry.proxyKey }]);
        }
    }
    const customModels: [string, { key: string }][] = [];
    if (source.customModels !== undefined) {
        for (const [id, entry] of Object.entries(requireObject(source.customModels, "llmSecrets.customModels"))) {
            if (!isRecordId(id) || !isPlainObject(entry) || typeof entry.key !== "string") {
                throw new ResourceValidationError("llmSecrets.customModels must map model ids to { key: string }");
            }
            customModels.push([id, { key: entry.key }]);
        }
    }
    const credentials: [string, { key: string }][] = [];
    if (source.credentials !== undefined) {
        for (const [id, entry] of Object.entries(requireObject(source.credentials, "llmSecrets.credentials"))) {
            if (!isRecordId(id) || !isPlainObject(entry) || typeof entry.key !== "string") {
                throw new ResourceValidationError("llmSecrets.credentials must map credential ids to { key: string }");
            }
            credentials.push([id, { key: entry.key }]);
        }
    }
    // `fromEntries` defines own properties, so an id such as `__proto__` stays an ordinary key.
    return {
        ...record,
        modelPresets: Object.fromEntries(modelPresets),
        customModels: Object.fromEntries(customModels),
        credentials: Object.fromEntries(credentials),
    } as LlmSecretsResource;
}
