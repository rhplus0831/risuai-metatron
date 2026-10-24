import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `getModelInfo(id, scope)` applies the custom flags of the main profile of the model preset a request
// captured (the pair whose ids the server receives), not the selected one's; without a scope it reads the
// selection as before; a captured model preset that is gone throws `PresetTargetGoneError` (the request is
// refused, never redirected to the selection).

vi.mock("src/ts/plugins/apiV3/v3.svelte", () => ({ customV3ProviderMetaStore: [] }));
vi.mock("src/ts/network/auxFetch", () => ({ auxFetch: vi.fn() }));
vi.mock("src/ts/storage/llmSecrets.svelte", () => ({ isSecretSet: () => true }));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import { getModelInfo, LLMFlags, LLMModels, registerModelDynamic } from "../modellist";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { selectModelPreset, selection } from "src/ts/storage/selection.svelte";
import { trackedRecord } from "src/ts/storage/records.svelte";
import { PresetTargetGoneError } from "src/ts/storage/settingsViews.svelte";
import { normalizeModelPreset, normalizeModelProfile } from "../../../../shared/presets";

const CATALOGUE_FLAGS = [LLMFlags.hasFullSystemPrompt, LLMFlags.hasStreaming];

/** Model preset `flagged`'s main profile overrides the flags with `[hasImageInput]`; `plain`'s keeps the catalogue's. */
function boot() {
    installFlatDatabase({
        characters: [],
        botPresets: [
            { id: "flagged", name: "Flagged" },
            { id: "plain", name: "Plain" },
        ],
        modelPresets: [
            normalizeModelPreset({ name: "Flagged", mainSlot: { profileId: "flagged" } }, { id: "flagged" }),
            normalizeModelPreset({ name: "Plain", mainSlot: { profileId: "plain" } }, { id: "plain" }),
        ],
        modelProfiles: [
            normalizeModelProfile({
                id: "flagged",
                name: "Flagged",
                modelId: "reverse_proxy",
                enableCustomFlags: true,
                customFlags: [LLMFlags.hasImageInput],
            }),
            normalizeModelProfile({ id: "plain", name: "Plain", modelId: "reverse_proxy" }),
        ],
        personas: [{ id: "p1", name: "U" }],
    });
}

beforeEach(() => {
    boot();
});

describe("getModelInfo with a request's captured scope", () => {
    it("applies the custom flags of the captured model preset's main profile, not the selected one's", () => {
        selectModelPreset("plain");
        expect(getModelInfo("reverse_proxy").flags).toEqual(CATALOGUE_FLAGS);
        expect(getModelInfo("reverse_proxy", { presetId: "plain", modelPresetId: "plain" }).flags).toEqual(
            CATALOGUE_FLAGS,
        );
        expect(getModelInfo("reverse_proxy", { presetId: "plain", modelPresetId: "flagged" }).flags).toEqual([
            LLMFlags.hasImageInput,
        ]);

        selectModelPreset("flagged");
        expect(getModelInfo("reverse_proxy").flags).toEqual([LLMFlags.hasImageInput]);
        expect(getModelInfo("reverse_proxy", { presetId: "flagged", modelPresetId: "plain" }).flags).toEqual(
            CATALOGUE_FLAGS,
        );
        // The scope moved no selection.
        expect(selection.modelPresetId).toBe("flagged");
    });

    it("throws PresetTargetGoneError for a captured model preset that is gone, and still reads the selection without a scope", () => {
        selectModelPreset("plain");
        const modelPresets = trackedRecord<{ id: string }[]>("modelPresets")!;
        modelPresets.splice(
            modelPresets.findIndex((entry) => entry.id === "flagged"),
            1,
        );
        expect(() => getModelInfo("reverse_proxy", { presetId: "flagged", modelPresetId: "flagged" })).toThrow(
            PresetTargetGoneError,
        );
        expect(() => getModelInfo("reverse_proxy", { presetId: "nope", modelPresetId: "nope" })).toThrow(
            "The model preset this request runs with no longer exists",
        );
        expect(getModelInfo("reverse_proxy").flags).toEqual(CATALOGUE_FLAGS);
        expect(selection.modelPresetId).toBe("plain");
    });
});

import { auxFetch } from "src/ts/network/auxFetch";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { dynamicModelOf, resolveModelInfo } from "../../../../shared/llm/models.ts";
const catalogueLength = LLMModels.length;
afterEach(() => {
    LLMModels.splice(catalogueLength);
    vi.restoreAllMocks();
});

describe("dynamic registry discovery", () => {
    it("resolves a saved Anthropic id with static capabilities before registry discovery", () => {
        selectModelPreset("plain");
        settings.providers.dynamicModelRegistry = false;
        const id = "dynamic_anthropic_claude-opus-5";
        const catalogue = resolveModelInfo("claude-opus-5");
        const client = getModelInfo(id);
        expect(client).toMatchObject({
            id,
            internalID: "claude-opus-5",
            provider: catalogue.provider,
            flags: catalogue.flags,
            parameters: catalogue.parameters,
            format: catalogue.format,
            tokenizer: catalogue.tokenizer,
        });
        expect(client).toEqual(resolveModelInfo(id));
        expect(getModelInfo("dynamic_anthropic_claude-unknown").flags).not.toContain(
            LLMFlags.claudeThinkingOnByDefault,
        );
    });

    it.each([
        ["dynamic_google_gemini-future", "Gemini Future", "gemini-future", undefined],
        ["dynamic_anthropic_claude-future", "Claude Future", "claude-future", true],
        ["gpt-future", "gpt-future", "gpt-future", true],
        ["gpt-future-response-api", "gpt-future (Response API)", "gpt-future", false],
    ] as const)(
        "registers %s with the shared wire fields and provider display metadata",
        async (id, name, internalID, recommended) => {
            settings.providers.dynamicModelRegistry = true;
            vi.spyOn(console, "log").mockImplementation(() => {});
            vi.mocked(auxFetch).mockImplementation(async (op) =>
                Response.json(
                    op === "google-models"
                        ? {
                              models: [
                                  {
                                      name: "models/gemini-future",
                                      displayName: "Gemini Future",
                                      supportedGenerationMethods: ["generateContent"],
                                  },
                              ],
                          }
                        : op === "anthropic-models"
                          ? { data: [{ id: "claude-future", display_name: "Claude Future" }] }
                          : { data: [{ id: "gpt-future" }] },
                ),
            );
            await registerModelDynamic();
            const registered = getModelInfo(id, undefined, null);
            expect(registered).toMatchObject({ name, internalID });
            expect(registered.recommended).toBe(recommended);
            const template = dynamicModelOf(id)!;
            for (const field of [
                "provider",
                "format",
                "flags",
                "parameters",
                "tokenizer",
                "endpoint",
                "keyIdentifier",
            ] as const) {
                expect(registered[field], field).toEqual(template[field]);
            }
            expect(LLMModels.filter((model) => model.id === id)).toHaveLength(1);
        },
    );
});
