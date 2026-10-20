import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("src/ts/network/auxFetch", () => ({ auxFetch: vi.fn() }));
vi.mock("src/ts/plugins/apiV3/v3.svelte", () => ({ customV3ProviderMetaStore: [] }));
vi.mock("src/ts/globalApi.svelte", () => ({ globalFetch: vi.fn(), saveAsset: vi.fn() }));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import type { ModelProfile } from "../../../../shared/database.ts";
import { auxFetch } from "src/ts/network/auxFetch";
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

beforeEach(() => {
    installFlatDatabase({ credentials: [{ id: "named", name: "Named", type: "custom" }] });
    setMaskedSecrets(maskLlmSecrets({ credentials: { named: { key: "named-key" } } }), "all");
    vi.mocked(auxFetch).mockImplementation(async () =>
        Response.json({
            data: [{ id: "private-model", name: "Private", pricing: { prompt: "0", completion: "0" } }],
            models: [{ name: "private-model" }],
        }),
    );
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ data: [{ id: "public-model" }] })),
    );
});
afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
});

describe("profile discovery calls", () => {
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
