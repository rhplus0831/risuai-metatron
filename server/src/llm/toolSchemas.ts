import { LLMFormat } from "../../../shared/llm.ts";
import type { ToolDescriptor } from "../../../shared/llm/request.ts";
import type { ResolvedRequestModel } from "./request.ts";
import { simplifySchema } from "./util.ts";

/**
 * The offered MCP schemas in the resolved adapter's tools value, for a token estimate. Formats
 * that send no descriptors and empty lists have no charge. Responses' built-in search is separate.
 */
export function serializeToolSchemas(
    resolved: ResolvedRequestModel,
    descriptors: readonly ToolDescriptor[],
): string | null {
    if (resolved.kind !== "resolved" || descriptors.length === 0) {
        return null;
    }
    let format = resolved.modelInfo.format;
    // Native Bedrock returns before anthropic.ts assigns body.tools; its proxy does not.
    if (format === LLMFormat.AWSBedrockClaude && resolved.aiModel !== "reverse_proxy") {
        return null;
    }
    // request.ts requestOllama dispatches only these three Cloud formats to tool-capable adapters.
    if (format === LLMFormat.Ollama && resolved.aiModel === "ollama-cloud") {
        const cloudFormat = resolved.db.ollamaRequestFormat;
        if (
            cloudFormat === LLMFormat.OpenAICompatible ||
            cloudFormat === LLMFormat.OpenAIResponseAPI ||
            cloudFormat === LLMFormat.Anthropic
        ) {
            format = cloudFormat;
        }
    }
    // simplifySchema normalizes array-valued types in place; never change the prepared descriptors.
    const parameters = (tool: ToolDescriptor) => simplifySchema(structuredClone(tool.inputSchema));
    switch (format) {
        case LLMFormat.OpenAICompatible:
        case LLMFormat.Mistral:
        case LLMFormat.NanoGPT:
            // Mirrors openAI/requests.ts requestOpenAI's body.tools assignment.
            return JSON.stringify(
                descriptors.map((tool) => ({
                    type: "function",
                    function: { name: tool.name, description: tool.description, parameters: parameters(tool) },
                })),
            );
        case LLMFormat.OpenAIResponseAPI:
        case LLMFormat.NanoGPTResponses:
            // Mirrors openAI/responses.ts buildResponsesBody's function tools.
            return JSON.stringify(
                descriptors.map((tool) => ({
                    type: "function",
                    name: tool.name,
                    description: tool.description,
                    parameters: parameters(tool),
                })),
            );
        case LLMFormat.AWSBedrockClaude:
        case LLMFormat.Anthropic:
        case LLMFormat.AnthropicLegacy:
        case LLMFormat.NanoGPTMessages:
            // Mirrors anthropic.ts requestClaude's body.tools = arg.tools.map(...) assignment.
            return JSON.stringify(
                descriptors.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    input_schema: parameters(tool),
                })),
            );
        case LLMFormat.VertexAIGemini:
        case LLMFormat.GoogleCloud:
            // Mirrors google.ts requestGoogleCloudVertex's tools.functionDeclarations value.
            return JSON.stringify({
                functionDeclarations: descriptors.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: parameters(tool),
                })),
            });
        default:
            return null;
    }
}
