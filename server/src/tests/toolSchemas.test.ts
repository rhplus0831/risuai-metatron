// @vitest-environment node
import { expect, it } from "vitest";
import { LLMFormat } from "../../../shared/llm.ts";
import { resolveModelInfo } from "../../../shared/llm/models.ts";
import type { ToolDescriptor } from "../../../shared/llm/request.ts";
import type { ResolvedRequestModel } from "../llm/request.ts";
import type { RequestDb } from "../llm/settings.ts";
import { serializeToolSchemas } from "../llm/toolSchemas.ts";

it("serializes the offered schemas in the resolved adapter's tools form and charges nothing when no tools are sent", () => {
    const descriptors: ToolDescriptor[] = [
        {
            name: "lookup",
            description: "Look up a term",
            inputSchema: {
                type: "object",
                properties: { term: { type: ["string", "null"] } },
                required: ["term"],
            },
        },
    ];
    const before = structuredClone(descriptors);
    const parameters = {
        type: "object",
        properties: { term: { type: "string", nullable: true } },
        required: ["term"],
    };
    const fn = { name: "lookup", description: "Look up a term", parameters };
    const resolved = (format: LLMFormat, aiModel = "test", db = {}): ResolvedRequestModel => ({
        kind: "resolved",
        aiModel,
        profile: undefined,
        db: db as RequestDb,
        modelInfo: { ...resolveModelInfo("gpt4o"), format },
    });
    const forms: [LLMFormat, unknown][] = [
        [LLMFormat.OpenAICompatible, [{ type: "function", function: fn }]],
        [LLMFormat.OpenAIResponseAPI, [{ type: "function", ...fn }]],
        [LLMFormat.Anthropic, [{ name: fn.name, description: fn.description, input_schema: parameters }]],
        [LLMFormat.GoogleCloud, { functionDeclarations: [fn] }],
    ];
    for (const [format, expected] of forms) {
        expect(serializeToolSchemas(resolved(format), descriptors), String(format)).toBe(JSON.stringify(expected));
        expect(serializeToolSchemas(resolved(format), [])).toBeNull();
    }
    for (const format of [LLMFormat.AWSBedrockClaude, LLMFormat.NovelAI, LLMFormat.Ooba]) {
        expect(serializeToolSchemas(resolved(format), descriptors)).toBeNull();
    }
    expect(serializeToolSchemas(resolved(LLMFormat.AWSBedrockClaude, "reverse_proxy"), descriptors)).toBe(
        JSON.stringify(forms[2][1]),
    );
    for (const [format, expected] of forms.slice(0, 3)) {
        expect(
            serializeToolSchemas(
                resolved(LLMFormat.Ollama, "ollama-cloud", { ollamaRequestFormat: format }),
                descriptors,
            ),
        ).toBe(JSON.stringify(expected));
    }
    expect(descriptors).toEqual(before);
});
