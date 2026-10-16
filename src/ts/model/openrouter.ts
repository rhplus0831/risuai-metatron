import type { ModelProfile } from "../../../shared/database.ts";
import { auxFetch } from "../network/auxFetch";
import type { ModelGridItem } from "./modelGrid";

/** Per-1M-token price entry. undefined means the field is not available for this model. */
export type PriceEntry = number | undefined;

export type OpenRouterModelInfo = {
    id: string;
    /** Original name with price appended, kept for backward compatibility */
    name: string;
    /** Clean model name without price info */
    cleanName: string;
    /** Provider display name extracted from model name (e.g. "OpenAI", "Anthropic") */
    provider: string;
    /** Weighted average price used for sorting (prompt*3 + completion) / 4 */
    price: number;
    /** Human-readable weighted-average price string, e.g. "$0.01500/1k" or "Free" */
    priceDisplay: string;
    context_length: number;
    description: string;
    /** Input (prompt) price per 1M tokens in USD */
    promptPrice1M: PriceEntry;
    /** Output (completion) price per 1M tokens in USD */
    completionPrice1M: PriceEntry;
    /** Cache-read price per 1M tokens in USD (optional) */
    cacheReadPrice1M: PriceEntry;
    /** Cache-write price per 1M tokens in USD (optional) */
    cacheWritePrice1M: PriceEntry;
    /** Internal reasoning token price per 1M tokens in USD (optional) */
    internalReasoningPrice1M: PriceEntry;
};

export async function getOpenRouterProviders(profile?: ModelProfile): Promise<{ name: string; slug: string }[]> {
    try {
        // With the stored OpenRouter key, on the server (`auxFetch`, Phase 5 slice 7b).
        const providers: { data: { name: string; slug: string }[] } = await auxFetch(
            "openrouter-providers",
            "https://openrouter.ai/api/v1/providers",
            { method: "GET", profileId: profile?.id, headers: { "Content-Type": "application/json" } },
        ).then((res) => res.json());

        return providers.data.map(({ name, slug }) => ({ name, slug })).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
        return [];
    }
}

export async function getOpenRouterModels(profile?: ModelProfile): Promise<OpenRouterModelInfo[]> {
    try {
        const aim = await auxFetch("openrouter-models", "https://openrouter.ai/api/v1/models", {
            method: "GET",
            profileId: profile?.id,
            headers: { "Content-Type": "application/json" },
        }).then((res) => res.json());

        return aim.data
            .map((model: any) => {
                const price = (Number(model.pricing.prompt) * 3 + Number(model.pricing.completion)) / 4;
                const priceDisplay = price > 0 ? `$${(price * 1000).toFixed(5)}/1k` : "Free";
                const legacyName =
                    price > 0 ? `${model.name} - $${(price * 1000).toFixed(5)}/1k` : `${model.name} - Free`;

                const colonIdx = model.name.indexOf(":");
                const provider = colonIdx !== -1 ? model.name.slice(0, colonIdx).trim() : model.id.split("/")[0];
                const cleanName = colonIdx !== -1 ? model.name.slice(colonIdx + 1).trim() : model.name;

                const toPrice1M = (raw: any): PriceEntry => {
                    const n = Number(raw);
                    return raw !== undefined && raw !== null && raw !== "" && !isNaN(n) ? n * 1_000_000 : undefined;
                };

                return {
                    id: model.id,
                    name: legacyName,
                    cleanName,
                    provider,
                    price,
                    priceDisplay,
                    context_length: model.context_length,
                    description: model.description ?? "",
                    promptPrice1M: toPrice1M(model.pricing?.prompt),
                    completionPrice1M: toPrice1M(model.pricing?.completion),
                    cacheReadPrice1M: toPrice1M(model.pricing?.input_cache_read),
                    cacheWritePrice1M: toPrice1M(model.pricing?.input_cache_write),
                    internalReasoningPrice1M: toPrice1M(model.pricing?.internal_reasoning),
                };
            })
            .filter((model: OpenRouterModelInfo) => {
                return model.price >= 0;
            })
            .sort((a: OpenRouterModelInfo, b: OpenRouterModelInfo) => {
                return a.price - b.price;
            });
    } catch (error) {
        return [];
    }
}

export function toModelGridItem(m: OpenRouterModelInfo): ModelGridItem {
    const fmt = (p: PriceEntry): string | null => {
        if (p === undefined) return null;
        if (p === 0) return "Free";
        return `$${p.toFixed(2)}`;
    };

    const prices: { label: string; value: string }[] = [];
    const pairs: [string, PriceEntry][] = [
        ["In", m.promptPrice1M],
        ["Out", m.completionPrice1M],
        ["Cache In", m.cacheReadPrice1M],
        ["Cache Out", m.cacheWritePrice1M],
        ["Reasoning", m.internalReasoningPrice1M],
    ];
    for (const [label, p] of pairs) {
        const v = fmt(p);
        if (v !== null) prices.push({ label, value: v });
    }

    return {
        id: m.id,
        displayName: m.cleanName,
        providerName: m.provider,
        description: m.description,
        context_length: m.context_length,
        sortPrice: m.price,
        prices,
    };
}
