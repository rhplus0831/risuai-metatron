// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CREDENTIAL_TYPES } from "../../database.ts";
import { LLMFormat, LLMProvider } from "../../llm.ts";
import { credentialSlotOf } from "../credentialSlots.ts";
import { BASE_LLM_MODELS, resolveModelInfo } from "../models.ts";

// The credential slot table: which default a model reads today and which named key types it
// accepts. The binding itself is the profile's `credentialId`.

const slotOf = (id: string) => credentialSlotOf(id, resolveModelInfo(id));
const allButVertex = CREDENTIAL_TYPES.filter((type) => type !== "vertex");

describe("credentialSlotOf", () => {
    it("gives a custom model and a reverse proxy no flat default, accepting every type but Vertex", () => {
        const noDefault = "No flat default (no key unless a named key is chosen)";
        expect(credentialSlotOf("xcustom:::m1", resolveModelInfo("x"))).toEqual({
            slot: "customModel",
            accepts: allButVertex,
            defaultDescription: noDefault,
        });
        expect(slotOf("reverse_proxy")).toEqual({
            slot: "reverseProxy",
            accepts: allButVertex,
            defaultDescription: noDefault,
        });
    });

    it("puts a keyIdentifier model (DeepSeek, DeepInfra) on its OaiCompAPIKeys entry, ahead of its provider", () => {
        const keyed = BASE_LLM_MODELS.filter((model) => model.keyIdentifier);
        expect(new Set(keyed.map((model) => model.keyIdentifier))).toEqual(new Set(["deepseek", "deepinfra"]));
        for (const model of keyed) {
            expect(credentialSlotOf(model.id, model), model.id).toEqual({
                slot: "keyIdentifier",
                accepts: ["custom"],
                defaultDescription: `OaiCompAPIKeys.${model.keyIdentifier}`,
            });
        }
    });

    it("selects the virtual providers by id: OpenRouter, NanoGPT in every format, Ollama cloud", () => {
        expect(slotOf("openrouter")).toMatchObject({ slot: "openrouter", accepts: ["openrouter", "custom"] });
        expect(slotOf("ollama-cloud")).toMatchObject({ slot: "ollama", accepts: ["ollama", "custom"] });
        const nano = resolveModelInfo("nanogpt");
        const defaults = [
            LLMFormat.NanoGPT,
            LLMFormat.NanoGPTResponses,
            LLMFormat.NanoGPTMessages,
            LLMFormat.NanoGPTLegacy,
        ].map((format) => {
            const slot = credentialSlotOf("nanogpt", { ...nano, format });
            expect(slot).toMatchObject({ slot: "nanogpt", accepts: ["nanogpt", "custom"] });
            return slot!.defaultDescription;
        });
        // Every NanoGPT adapter defaults to the NanoGPT key.
        expect(defaults).toEqual(["nanogptKey", "nanogptKey", "nanogptKey", "nanogptKey"]);
    });

    it("gives every catalogue model of a keyed provider its provider's slot", () => {
        const byProvider: Partial<Record<number, [string, readonly string[]]>> = {
            [LLMProvider.OpenAI]: ["openai", ["openai", "custom"]],
            [LLMProvider.Anthropic]: ["anthropic", ["anthropic", "custom"]],
            [LLMProvider.AWS]: ["bedrock", ["bedrock"]],
            [LLMProvider.GoogleCloud]: ["google", ["google", "custom"]],
            [LLMProvider.VertexAI]: ["vertex", ["vertex"]],
            [LLMProvider.Mistral]: ["mistral", ["mistral", "custom"]],
            [LLMProvider.Cohere]: ["cohere", ["cohere", "custom"]],
            [LLMProvider.NovelAI]: ["novelai", ["novelai", "custom"]],
        };
        const seen = new Set<number>();
        for (const model of BASE_LLM_MODELS) {
            const expected = byProvider[model.provider];
            if (!expected || model.keyIdentifier) {
                continue;
            }
            seen.add(model.provider);
            expect(credentialSlotOf(model.id, model), model.id).toMatchObject({
                slot: expected[0],
                accepts: expected[1],
            });
        }
        expect([...seen].sort((a, b) => a - b)).toEqual(
            Object.keys(byProvider)
                .map(Number)
                .sort((a, b) => a - b),
        );
    });

    it("reads the OpenAI key for an unknown, as-is OpenAI-compatible model", () => {
        expect(slotOf("some-unknown-model")).toMatchObject({ slot: "openai", defaultDescription: "openAIKey" });
    });

    it("offers no slot to the models whose adapters take no named key", () => {
        for (const id of ["mancer", "ooba", "kobold", "novellist", "ollama-hosted", "echo_model", "horde:::m"]) {
            expect(slotOf(id), id).toBeNull();
        }
        const plugin = { provider: LLMProvider.AsIs, format: LLMFormat.Plugin, keyIdentifier: undefined };
        expect(credentialSlotOf("pluginmodel:::p", plugin)).toBeNull();
        expect(
            credentialSlotOf("webllm", { ...plugin, provider: LLMProvider.WebLLM, format: LLMFormat.WebLLM }),
        ).toBeNull();
    });

    it("accepts a Vertex key only on the Vertex slot, and only known types anywhere", () => {
        const ids = [...BASE_LLM_MODELS.map((model) => model.id), "xcustom:::m1"];
        for (const id of ids) {
            const slot = credentialSlotOf(
                id,
                id.startsWith("xcustom:::") ? resolveModelInfo("x") : resolveModelInfo(id),
            );
            if (!slot) {
                continue;
            }
            for (const type of slot.accepts) {
                expect(CREDENTIAL_TYPES, id).toContain(type);
            }
            expect(slot.accepts.includes("vertex"), id).toBe(slot.slot === "vertex");
        }
    });
});
