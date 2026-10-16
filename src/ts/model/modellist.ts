import {
    activeMainProfile,
    resolveModelSlot,
    settings,
    activePreset,
    scopedPresetRoot,
    type PresetScope,
} from "../storage/settingsViews.svelte";
import {
    LLMFlags,
    LLMProvider,
    LLMFormat,
    LLMTokenizer,
    ProviderNames,
    OpenAIParameters,
    ClaudeParameters,
    type LLMModel,
} from "./types";
import { BASE_LLM_MODELS, dynamicModelOf, resolveModelInfo } from "../../../shared/llm/models.ts";
import type { ModelProfile } from "../../../shared/database.ts";
import type { ModelModeExtended } from "../../../shared/llm/request.ts";
import { presetFieldValue } from "../../../shared/presets.ts";
import { auxFetch } from "../network/auxFetch";
import { isSecretSet } from "../storage/llmSecrets.svelte";
import { customV3ProviderMetaStore } from "../plugins/apiV3/v3.svelte";

// Re-export types for backwards compatibility
export { LLMFlags, LLMProvider, LLMFormat, LLMTokenizer, ProviderNames, OpenAIParameters, ClaudeParameters };
export type { LLMModel };

/**
 * This tab's catalogue: the static list (`shared/llm/models.ts`) plus what `registerModelDynamic`
 * appends. Dynamic ids resolve through the shared builder on both runtimes; this tab keeps
 * the provider display names. Requests still carry a descriptor for compatibility.
 */
export const LLMModels: LLMModel[] = structuredClone(BASE_LLM_MODELS) as LLMModel[];
const dynamicModelIds = new Set<string>();

/** Whether `id` was appended by `registerModelDynamic` (not a static catalogue entry). */
export function isDynamicModel(id: string): boolean {
    return dynamicModelIds.has(id);
}

function pushDynamicModel(model: LLMModel) {
    LLMModels.push(model);
    dynamicModelIds.add(model.id);
}

export async function registerModelDynamic() {
    if (!settings.providers.dynamicModelRegistry) {
        return;
    }
    //google
    try {
        // The three lists use the stored keys on the server (`auxFetch`, Phase 5 slice 7b).
        if (isSecretSet({ kind: "nested", field: "google" })) {
            const res = await auxFetch("google-models", "https://generativelanguage.googleapis.com/v1beta/models", {
                method: "GET",
            });
            const json = await res.json();
            console.log("Google models response", json);
            const models = json?.models || [];
            for (let model of models) {
                if (
                    !model.supportedGenerationMethods ||
                    !model.supportedGenerationMethods.includes("generateContent")
                ) {
                    continue;
                }

                const id = model.name.startsWith("models/") ? model.name.replace("models/", "") : model.name;
                const exists = LLMModels.find((m) => m.id === id || m.internalID === id);

                if (!exists) {
                    pushDynamicModel({
                        ...dynamicModelOf("dynamic_google_" + id)!,
                        name: model.displayName || id,
                        shortName: model.displayName || id,
                        fullName: model.displayName || id,
                    });
                }
            }
        }
    } catch (error) {
        console.error("Error fetching Google models", error);
    }

    //Anthropic
    try {
        if (isSecretSet({ kind: "flat", field: "claudeAPIKey" })) {
            const res = await auxFetch("anthropic-models", "https://api.anthropic.com/v1/models", {
                method: "GET",
                headers: {
                    "anthropic-version": "2023-06-01",
                },
            });

            const json = await res.json();
            console.log("Anthropic models response", json);
            const models: {
                id: string;
                display_name: string;
            }[] = json?.data || [];

            for (let model of models) {
                const exists = LLMModels.find((m) => m.id === model.id || m.internalID === model.id);
                if (!exists) {
                    pushDynamicModel({
                        ...dynamicModelOf(`dynamic_anthropic_${model.id}`)!,
                        name: model.display_name || model.id,
                        shortName: model.display_name || model.id,
                        fullName: model.display_name || model.id,
                        recommended: true,
                    });
                }
            }
        }
    } catch (error) {
        console.error("Error fetching Anthropic models", error);
    }

    try {
        if (isSecretSet({ kind: "flat", field: "openAIKey" })) {
            const res = await auxFetch("openai-models", "https://api.openai.com/v1/models", { method: "GET" });
            const json = await res.json();
            console.log(json);
            if (!json.data) {
                throw "Invaild Openai Model Response";
            }
            let i = 0;
            for (const model of json.data) {
                const exists = LLMModels.find((m) => m.id === model.id || m.internalID === model.id);

                if (exists) {
                    continue;
                }

                if (!model.id.startsWith("gpt-")) {
                    continue;
                }
                i++;

                const a = dynamicModelOf(model.id);
                if (!a) continue;
                pushDynamicModel({ ...a, recommended: i < 8 });
                pushDynamicModel({
                    ...dynamicModelOf(`${a.id}-response-api`)!,
                    name: `${a.name} (Response API)`,
                    shortName: a.shortName,
                    fullName: `${a.fullName ?? a.name} (Response API)`,
                    recommended: false,
                });
            }
        }
    } catch (error) {}
}

//testing purpose only, not used in production
globalThis.registerModelDynamic = registerModelDynamic;

/**
 * A definition with the main profile's flags (the captured pair when supplied), or an explicit
 * profile's flags. Null means no profile and uses schema defaults, never the active main profile.
 */
export function getModelInfo(id?: string | null, scope?: PresetScope, profile?: ModelProfile | null): LLMModel {
    const field = (name: "enableCustomFlags" | "customFlags") =>
        profile === undefined
            ? scope
                ? scopedPresetRoot(scope, name)
                : activeMainProfile[name]
            : presetFieldValue((profile ?? undefined) as unknown as Record<string, unknown> | undefined, name);
    return resolveModelInfo(id, {
        enableCustomFlags: field("enableCustomFlags") as boolean,
        customFlags: field("customFlags") as LLMFlags[],
        customModels: settings.customModels,
        extraModels: LLMModels,
        pluginModels: customV3ProviderMetaStore,
    });
}

/** Catalogue metadata for a mode, using the same profile routing as requests on both runtimes. */
export function getModelInfoForMode(mode: ModelModeExtended, scope?: PresetScope): LLMModel {
    const resolved = resolveModelSlot(mode, scope);
    return getModelInfo(resolved.modelId ?? "", scope, resolved.kind === "profile" ? resolved.profile : null);
}

interface GetModelListGroup {
    providerName: string;
    models: LLMModel[];
}

export function getModelList<T extends boolean>(
    arg: {
        recommendedOnly?: boolean;
        groupedByProvider?: T;
    } = {},
): T extends true ? GetModelListGroup[] : LLMModel[] {
    let models = LLMModels;
    if (arg.recommendedOnly) {
        models = models.filter((model) => model.recommended);
    }
    const pluginGroup: GetModelListGroup = {
        providerName: "Plugins",
        models: customV3ProviderMetaStore,
    };

    if (arg.groupedByProvider) {
        let group: GetModelListGroup[] = [];
        for (let model of models) {
            if (model.provider === LLMProvider.AsIs || model.provider === LLMProvider.NanoGPT) {
                group.push({
                    providerName: "@as-is",
                    models: [model],
                });
                continue;
            }

            let providerName = ProviderNames.get(model.provider) || "Unknown";
            let groupIndex = group.findIndex((g) => g.providerName === providerName);
            if (groupIndex === -1) {
                group.push({
                    providerName,
                    models: [model],
                });
            } else {
                group[groupIndex].models.push(model);
            }
        }

        if (pluginGroup.models.length > 0) {
            group.push(pluginGroup);
        }
        return group as any;
    } else {
        for (const model of pluginGroup.models) {
            models.push(model);
        }
    }

    return models as any;
}
