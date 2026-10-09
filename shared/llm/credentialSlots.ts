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
    accepts: readonly CredentialType[];
    /** The default read by the current server adapter, before any binding is resolved. */
    defaultDescription: string;
};

const stringCredentialTypes = CREDENTIAL_TYPES.filter((type) => type !== "vertex");

function slot(
    name: CredentialSlotName,
    accepts: readonly CredentialType[],
    defaultDescription: string,
): CredentialSlot {
    return { slot: name, accepts, defaultDescription };
}

/**
 * Credential metadata for the client and server resolver. Bindings live on model profiles.
 * Keep the defaults aligned with the adapters: every NanoGPT format reads the NanoGPT key by
 * default. This describes routing only; it neither resolves a binding nor changes a request.
 */
export function credentialSlotOf(
    modelId: string,
    modelInfo: Pick<LLMModel, "provider" | "format" | "keyIdentifier">,
): CredentialSlot | null {
    // Custom definitions and reverse proxies have no flat default key (Model Profiles O2).
    if (modelId.startsWith("xcustom:::")) {
        return slot("customModel", stringCredentialTypes, "No flat default (no key unless a named key is chosen)");
    }
    if (modelId === "reverse_proxy") {
        return slot("reverseProxy", stringCredentialTypes, "No flat default (no key unless a named key is chosen)");
    }
    // Chat and Responses override their Authorization header with this map entry.
    if (modelInfo.keyIdentifier) {
        return slot("keyIdentifier", ["custom"], `OaiCompAPIKeys.${modelInfo.keyIdentifier}`);
    }
    // These virtual catalogue entries select their key by id, not provider.
    if (modelId === "openrouter") {
        return slot("openrouter", ["openrouter", "custom"], "openrouterKey");
    }
    if (modelId === "nanogpt") {
        return slot("nanogpt", ["nanogpt", "custom"], "nanogptKey");
    }
    if (modelId === "ollama-cloud") {
        return slot("ollama", ["ollama", "custom"], "ollamaApiKey");
    }

    switch (modelInfo.provider) {
        case LLMProvider.OpenAI:
            return slot("openai", ["openai", "custom"], "openAIKey");
        case LLMProvider.Anthropic:
            return slot("anthropic", ["anthropic", "custom"], "claudeAPIKey");
        case LLMProvider.AWS:
            return slot("bedrock", ["bedrock"], "claudeAPIKey (accessKeyId:secretAccessKey:region)");
        case LLMProvider.GoogleCloud:
            return slot("google", ["google", "custom"], "google.accessToken");
        case LLMProvider.VertexAI:
            return slot("vertex", ["vertex"], "vertexClientEmail + vertexPrivateKey");
        case LLMProvider.Mistral:
            return slot("mistral", ["mistral", "custom"], "mistralKey");
        case LLMProvider.Cohere:
            return slot("cohere", ["cohere", "custom"], "cohereAPIKey");
        case LLMProvider.NovelAI:
            return slot("novelai", ["novelai", "custom"], "novelai.token");
        case LLMProvider.AsIs:
        case LLMProvider.DeepSeek:
        case LLMProvider.DeepInfra:
            // Unknown/as-is OpenAI models, or descriptors without a keyIdentifier, read openAIKey.
            if (
                modelInfo.format === LLMFormat.OpenAICompatible ||
                modelInfo.format === LLMFormat.OpenAIResponseAPI ||
                modelInfo.format === LLMFormat.OpenAILegacyInstruct
            ) {
                return slot("openai", ["openai", "custom"], "openAIKey");
            }
            return null;
        default:
            // Mancer, NovelList, Horde, local servers, plugin, WebLLM, and Echo have no named-key slot.
            return null;
    }
}
