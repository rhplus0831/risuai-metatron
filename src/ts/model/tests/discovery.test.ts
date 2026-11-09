import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("src/ts/plugins/apiV3/v3.svelte", () => ({ customV3ProviderMetaStore: [] }));
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import type { ModelProfile } from "../../../../shared/database.ts";
import { auxFetch } from "src/ts/network/auxFetch";
import * as auxRequests from "src/ts/network/auxFetch";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { setMaskedSecrets } from "src/ts/storage/llmSecrets.svelte";
import { maskLlmSecrets } from "../../../../shared/llmSecrets.ts";
import { normalizeModelProfile } from "../../../../shared/presets.ts";
import {
    getNanoGPTBalance,
    getNanoGPTModelProviders,
    getNanoGPTModels,
    getNanoGPTSubscription,
    getNanoGPTSubscriptionModels,
} from "../nanogpt";
import { getOpenRouterModels, getOpenRouterProviders } from "../openrouter";
import { getOllamaModels } from "../ollama";
import { getModelList, LLMModels, registerModelDynamic } from "../modellist";
import { settings } from "src/ts/storage/settingsViews.svelte";

const originalFetch = globalThis.fetch;
const catalogueLength = LLMModels.length;

beforeEach(() => {
    installFlatDatabase({ credentials: [{ id: "named", name: "Named", type: "custom" }] });
    setMaskedSecrets(maskLlmSecrets({ credentials: { named: { key: "named-key" } } }), "all");
    vi.spyOn(auxRequests, "auxFetch").mockImplementation(async () =>
        Response.json({
            data: [{ id: "private-model", name: "Private", pricing: { prompt: "0", completion: "0" } }],
            models: [{ name: "private-model" }],
        }),
    );
    vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "public-model" }] })),
    );
});
afterEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = originalFetch;
    LLMModels.splice(catalogueLength);
    vi.restoreAllMocks();
});

describe("profile discovery calls", () => {
    it.each([
        [
            "google-models",
            "gemini-4-argon",
            "google",
            "dynamic_google_gemini-private",
            "Gemini Private",
            {
                models: [
                    {
                        name: "models/gemini-private",
                        displayName: "Gemini Private",
                        supportedGenerationMethods: ["generateContent"],
                    },
                ],
            },
        ],
        [
            "anthropic-models",
            "claude-opus-5",
            "anthropic",
            "dynamic_anthropic_claude-private",
            "Claude Private",
            {
                data: [{ id: "claude-private", display_name: "Claude Private" }],
            },
        ],
        ["openai-models", "gpt-5.5", "openai", "gpt-private", "gpt-private", { data: [{ id: "gpt-private" }] }],
    ] as const)(
        "registers %s models through the named profile without any default key",
        async (op, modelId, type, id, name, answer) => {
            settings.credentials = [{ id: "named", name: "Named", type }];
            settings.modelProfiles = [normalizeModelProfile({ id: "edited", modelId, credentialId: "named" })];
            settings.providers.dynamicModelRegistry = true;
            vi.spyOn(console, "log").mockImplementation(() => {});
            vi.mocked(auxFetch).mockResolvedValueOnce(Response.json(answer));

            await registerModelDynamic("edited");

            expect(auxFetch).toHaveBeenCalledExactlyOnceWith(
                op,
                expect.any(String),
                expect.objectContaining({ method: "GET", profileId: "edited" }),
            );
            expect(getModelList({ groupedByProvider: false })).toContainEqual(expect.objectContaining({ id, name }));
            expect(fetch).not.toHaveBeenCalled();
        },
    );
    it.each([
        ["nanogpt-models", "nanogpt", getNanoGPTModels],
        ["nanogpt-subscription-models", "nanogpt", getNanoGPTSubscriptionModels],
        ["nanogpt-balance", "nanogpt", getNanoGPTBalance],
        ["nanogpt-subscription", "nanogpt", getNanoGPTSubscription],
        [
            "nanogpt-model-providers",
            "nanogpt",
            (profile: ModelProfile) => getNanoGPTModelProviders("vendor/model", profile),
        ],
        ["openrouter-models", "openrouter", getOpenRouterModels],
        ["openrouter-providers", "openrouter", getOpenRouterProviders],
        ["ollama-cloud-tags", "ollama-cloud", (profile: ModelProfile) => getOllamaModels("", "cloud", profile)],
    ] as const)("passes the edited profile to %s", async (op, modelId, call) => {
        const profile = normalizeModelProfile({ id: "edited", modelId, credentialId: "named" });
        await call(profile);
        expect(auxFetch).toHaveBeenCalledExactlyOnceWith(
            op,
            expect.any(String),
            expect.objectContaining({ profileId: "edited" }),
        );
        expect(fetch).not.toHaveBeenCalled();
    });
    it.each([
        ["personalized", getNanoGPTModels],
        ["subscription", getNanoGPTSubscriptionModels],
    ] as const)("%s returns the named account's models without a flat key", async (_list, call) => {
        const profile = normalizeModelProfile({ id: "edited", modelId: "nanogpt", credentialId: "named" });
        expect(await call(profile)).toEqual([expect.objectContaining({ id: "private-model" })]);
        expect(fetch).not.toHaveBeenCalled();
    });
    it.each([
        ["personalized", getNanoGPTModels],
        ["subscription", getNanoGPTSubscriptionModels],
    ] as const)("%s refuses a missing binding without the default or public list", async (_list, call) => {
        setMaskedSecrets(maskLlmSecrets({ nanogptKey: "flat-key" }), "all");
        const profile = normalizeModelProfile({ id: "edited", modelId: "nanogpt", credentialId: "gone" });
        expect(await call(profile)).toEqual([]);
        expect(auxFetch).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
    it("keeps public discovery for an unbound profile without a default key", async () => {
        const profile = normalizeModelProfile({ id: "edited", modelId: "nanogpt" });
        expect(await getNanoGPTModels(profile)).toEqual([expect.objectContaining({ id: "public-model" })]);
        expect(auxFetch).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
