import { CREDENTIAL_TYPES, type CredentialType } from "../database.ts";
import { LLMFormat, LLMProvider, type LLMModel } from "../llm.ts";

export type CredentialSlotName =
    | "openai"
    | "anthropic"
    | "bedrock"
    | "google"
    | "vertex"
    | "mistral"
    | "cohere"
    | "novelai"
    | "openrouter"
    | "nanogpt"
    | "ollama"
    | "keyIdentifier"
    | "customModel"
    | "reverseProxy";

export type CredentialSlot = {
    slot: CredentialSlotName;
    /** `providers.modelCredentials`, `CustomModel.credentialId`, or `ModelPreset.proxyCredentialId`. */
    binding: "global" | "customModel" | "modelPreset";
    accepts: readonly CredentialType[];
    /** The default read by the current server adapter, before any binding is resolved. */
    defaultDescription: string;
};

const stringCredentialTypes = CREDENTIAL_TYPES.filter((type) => type !== "vertex");

function slot(
    name: CredentialSlotName,
    binding: CredentialSlot["binding"],
    accepts: readonly CredentialType[],
    defaultDescription: string,
): CredentialSlot {
    return { slot: name, binding, accepts, defaultDescription };
}

/**
 * Credential metadata for the client and the future server resolver. Keep the defaults aligned
 * with the adapters: NanoGPT Messages and Legacy currently read the Anthropic and OpenAI keys,
 * respectively. This describes routing only; it neither resolves a binding nor changes a request.
 */
export function credentialSlotOf(
    modelId: string,
    modelInfo: Pick<LLMModel, "provider" | "format" | "keyIdentifier">,
): CredentialSlot | null {
    // These bindings live beside the configurable URL, before catalogue/provider routing.
    if (modelId.startsWith("xcustom:::")) {
        return slot("customModel", "customModel", stringCredentialTypes, `llmSecrets.customModels.${modelId}.key`);
    }
    if (modelId === "reverse_proxy") {
        return slot("reverseProxy", "modelPreset", stringCredentialTypes, "llmSecrets.modelPresets.<id>.proxyKey");
    }
    // Chat and Responses override their Authorization header with this map entry.
    if (modelInfo.keyIdentifier) {
        return slot("keyIdentifier", "global", ["custom"], `OaiCompAPIKeys.${modelInfo.keyIdentifier}`);
    }
    // These virtual catalogue entries select their key by id, not provider.
    if (modelId === "openrouter") {
        return slot("openrouter", "global", ["openrouter", "custom"], "openrouterKey");
    }
    if (modelId === "nanogpt") {
        const defaultKey =
            modelInfo.format === LLMFormat.NanoGPTMessages
                ? "claudeAPIKey"
                : modelInfo.format === LLMFormat.NanoGPTLegacy
                  ? "openAIKey"
                  : "nanogptKey";
        return slot("nanogpt", "global", ["nanogpt", "custom"], defaultKey);
    }
    if (modelId === "ollama-cloud") {
        return slot("ollama", "global", ["ollama", "custom"], "ollamaApiKey");
    }

    switch (modelInfo.provider) {
        case LLMProvider.OpenAI:
            return slot("openai", "global", ["openai", "custom"], "openAIKey");
        case LLMProvider.Anthropic:
            return slot("anthropic", "global", ["anthropic", "custom"], "claudeAPIKey");
        case LLMProvider.AWS:
            return slot("bedrock", "global", ["bedrock"], "claudeAPIKey (accessKeyId:secretAccessKey:region)");
        case LLMProvider.GoogleCloud:
            return slot("google", "global", ["google", "custom"], "google.accessToken");
        case LLMProvider.VertexAI:
            return slot("vertex", "global", ["vertex"], "vertexClientEmail + vertexPrivateKey");
        case LLMProvider.Mistral:
            return slot("mistral", "global", ["mistral", "custom"], "mistralKey");
        case LLMProvider.Cohere:
            return slot("cohere", "global", ["cohere", "custom"], "cohereAPIKey");
        case LLMProvider.NovelAI:
            return slot("novelai", "global", ["novelai", "custom"], "novelai.token");
        case LLMProvider.AsIs:
        case LLMProvider.DeepSeek:
        case LLMProvider.DeepInfra:
            // Unknown/as-is OpenAI models, or descriptors without a keyIdentifier, read openAIKey.
            if (
                modelInfo.format === LLMFormat.OpenAICompatible ||
                modelInfo.format === LLMFormat.OpenAIResponseAPI ||
                modelInfo.format === LLMFormat.OpenAILegacyInstruct
            ) {
                return slot("openai", "global", ["openai", "custom"], "openAIKey");
            }
            return null;
        default:
            // Mancer, NovelList, Horde, local servers, plugin, WebLLM, and Echo have no named-key slot.
            return null;
    }
}
