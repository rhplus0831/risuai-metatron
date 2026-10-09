import { isRecordId } from "../../../../shared/ids.ts";
import type { LlmSecretsResource } from "../../../../shared/resources.ts";
import { ResourceValidationError } from "../resourceStore.ts";
import { isPlainObject, normalizeSection, requireObject, type SectionSpec } from "./shared.ts";

/**
 * Write-only flat provider defaults and named keys by credential record id. Retired model preset
 * and custom-model key maps are ignored and dropped, including malformed legacy entries.
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
        credentials: Object.fromEntries(credentials),
    } as LlmSecretsResource;
}
