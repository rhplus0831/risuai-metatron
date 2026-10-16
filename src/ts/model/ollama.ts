import type { ModelProfile } from "../../../shared/database.ts";
import { globalFetch } from "../globalApi.svelte";
import { auxFetch } from "../network/auxFetch";
import type { ModelGridItem } from "./modelGrid";

export type OllamaModelSource = "local" | "cloud";

type OllamaTagModel = {
    name?: string;
    model?: string;
    remote_model?: string;
    remote_host?: string;
    modified_at?: string | Date;
    size?: number;
    digest?: string;
    details?: {
        format?: string;
        family?: string;
        families?: string[] | null;
        parameter_size?: string;
        quantization_level?: string;
    };
};

/**
 * The models of an Ollama host. The cloud list uses the stored Ollama key on the server
 * (`auxFetch`, Phase 5 slice 7b); a local host is read as before.
 */
export async function getOllamaModels(
    host: string,
    source: OllamaModelSource,
    profile?: ModelProfile,
): Promise<ModelGridItem[]> {
    try {
        let models: OllamaTagModel[];
        if (source === "cloud") {
            const response = await auxFetch("ollama-cloud-tags", "https://ollama.com/api/tags", {
                method: "GET",
                profileId: profile?.id,
                interceptor: "ollama_models",
            });
            if (!response.ok) return [];
            models = ((await response.json()) as { models?: OllamaTagModel[] })?.models ?? [];
        } else {
            const response = await globalFetch(`${host.replace(/\/$/, "")}/api/tags`, {
                method: "GET",
                headers: {},
                interceptor: "ollama_models",
            });
            if (!response.ok) return [];
            models = response.data?.models ?? [];
        }

        return models.map((model) => toModelGridItem(model, source));
    } catch {
        return [];
    }
}

export function toModelGridItem(model: OllamaTagModel, source: OllamaModelSource): ModelGridItem {
    const id = model.model || model.name || "";
    const details = model.details;
    const descriptionParts = [
        model.remote_model ? `Remote: ${model.remote_model}` : null,
        model.remote_host ? `Host: ${model.remote_host}` : null,
        details?.parameter_size,
        details?.quantization_level,
        details?.format,
        details?.family,
    ].filter(Boolean);

    return {
        id,
        displayName: model.name || id,
        providerName: source === "cloud" ? "Cloud" : "Local",
        description: descriptionParts.join(" / "),
        context_length: 0,
        sortPrice: source === "cloud" ? 1 : 0,
        prices: [],
    };
}
