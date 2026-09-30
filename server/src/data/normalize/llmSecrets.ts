import { isRecordId } from "../../../../shared/ids.ts";
import type { LlmSecretsResource } from "../../../../shared/resources.ts";
import { ResourceValidationError } from "../resourceStore.ts";
import { isPlainObject, normalizeSection, requireObject, type SectionSpec } from "./shared.ts";

/**
 * The `llmSecrets` section: the LLM credentials under their `Database` names, plus `presets`, each
 * preset's `proxyKey` keyed by preset id (filled from slice 5 on; an entry of a deleted preset is
 * harmless and is removed with it).
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
    const presets: [string, { proxyKey: string }][] = [];
    if (source.presets !== undefined) {
        for (const [id, entry] of Object.entries(requireObject(source.presets, "llmSecrets.presets"))) {
            if (!isRecordId(id) || !isPlainObject(entry) || typeof entry.proxyKey !== "string") {
                throw new ResourceValidationError("llmSecrets.presets must map preset ids to { proxyKey: string }");
            }
            presets.push([id, { proxyKey: entry.proxyKey }]);
        }
    }
    // `fromEntries` defines own properties, so an id such as `__proto__` stays an ordinary key.
    return { ...record, presets: Object.fromEntries(presets) } as LlmSecretsResource;
}
