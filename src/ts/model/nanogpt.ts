import { auxFetch } from "../network/auxFetch";
import { credentialStatusFor } from "./credentials";
import type { ModelProfile } from "../../../shared/database.ts";
import type { SecretPath } from "../../../shared/llmSecrets.ts";
import {
    NANOGPT_PERSONALIZED_MODELS_ENDPOINT,
    NANOGPT_MODELS_ENDPOINT,
    NANOGPT_BALANCE_ENDPOINT,
    NANOGPT_SUBSCRIPTION_ENDPOINT,
    NANOGPT_SUBSCRIPTION_MODELS_ENDPOINT,
    NANOGPT_MODEL_PROVIDERS_ENDPOINT,
} from "../../../shared/llm/providers/nanogpt.ts";
import type { ModelGridItem } from "./modelGrid";

/**
 * NanoGPT discovery and account reads. The account and model calls use the stored NanoGPT key on the server: they go
 * through `auxFetch` (`src/ts/network/auxFetch.ts`) with the edited profile, so the server sends that profile's bound
 * key, or the flat default key when it binds none. A refused binding does not fall back to a default or public
 * account: the server refuses the call (`server/src/llm/auxOps.ts` `planAuxOp`), and `getNanoGPTModels` answers an
 * empty list instead of the public one. Only `getNanoGPTModels` without any key set reads the public list directly.
 */

const NANOGPT_KEY: SecretPath = { kind: "flat", field: "nanogptKey" };

/** A normalized NanoGPT picker entry with capabilities and optional per-million-token prices. */
export type NanoGPTModelInfo = {
    id: string;
    name: string;
    owned_by: string;
    context_length: number;
    max_output_tokens: number;
    description: string;
    capabilities: {
        vision?: boolean;
        reasoning?: boolean;
        tool_calling?: boolean;
        [key: string]: boolean | undefined;
    };
    /** Input (prompt) price per 1M tokens in USD */
    promptPrice1M: number | undefined;
    /** Output (completion) price per 1M tokens in USD */
    completionPrice1M: number | undefined;
};

/** The NanoGPT balance response, retaining the service's string amounts and deposit address. */
export type NanoGPTBalance = {
    usd_balance: string;
    nano_balance: string;
    nanoDepositAddress: string;
};

type UsageBucket = {
    used: number;
    remaining: number;
    percentUsed: number;
    resetAt: number;
};

/** Subscription status, nullable limits and usage buckets, and the current billing-period end. */
export type NanoGPTSubscriptionUsage = {
    active: boolean;
    state: "active" | "grace" | "inactive";
    graceUntil: string | null;
    cancelAtPeriodEnd: boolean;
    limits: {
        weeklyInputTokens: number | null;
        dailyInputTokens: number | null;
        dailyImages: number | null;
    };
    weeklyInputTokens: UsageBucket | null;
    dailyInputTokens: UsageBucket | null;
    dailyImages: UsageBucket | null;
    period: { currentPeriodEnd: string };
};

/** Reads the profile's balance through `auxFetch`; HTTP, network, and JSON failures return null. */
export async function getNanoGPTBalance(profile?: ModelProfile): Promise<NanoGPTBalance | null> {
    try {
        const res = await auxFetch("nanogpt-balance", NANOGPT_BALANCE_ENDPOINT, {
            method: "POST",
            profileId: profile?.id,
            headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

/** Reads the profile's subscription through `auxFetch`; HTTP, network, and JSON failures return null. */
export async function getNanoGPTSubscription(profile?: ModelProfile): Promise<NanoGPTSubscriptionUsage | null> {
    try {
        const res = await auxFetch("nanogpt-subscription", NANOGPT_SUBSCRIPTION_ENDPOINT, {
            method: "GET",
            profileId: profile?.id,
        });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

type NanoGPTPriceComparison = {
    platformVsOfficial: {
        inputDiscountPct: number;
        outputDiscountPct: number;
        inputDirection: "less" | "more";
        outputDirection: "less" | "more";
    };
    hasUserDiscount: boolean;
};

/** A model's provider option with per-thousand-token prices, availability, and optional comparison data. */
export type NanoGPTModelProvider = {
    provider: string;
    pricing: {
        inputPer1kTokens: number;
        outputPer1kTokens: number;
        cacheReadInputPer1kTokens?: number;
    };
    available: boolean;
    supportsPromptCaching?: boolean;
    quantization?: string;
    comparison?: NanoGPTPriceComparison;
};

/** Provider-selection metadata and automatic-route metrics for one canonical NanoGPT model. */
export type NanoGPTModelProviders = {
    canonicalId: string;
    displayName: string;
    supportsProviderSelection: boolean;
    defaultPrice: { inputPer1kTokens: number; outputPer1kTokens: number };
    providers: NanoGPTModelProvider[];
    autoTps?: number;
    autoTtftMs?: number;
    autoComparison?: NanoGPTPriceComparison;
    officialBaseline?: {
        provider: string;
        label: string;
        officialModelId: string;
        pricing: { inputPer1kTokens: number; outputPer1kTokens: number };
    };
};

/** Reads provider options for the URL-encoded model id; HTTP, network, and JSON failures return null. */
export async function getNanoGPTModelProviders(
    modelId: string,
    profile?: ModelProfile,
): Promise<NanoGPTModelProviders | null> {
    try {
        const res = await auxFetch(
            "nanogpt-model-providers",
            `${NANOGPT_MODEL_PROVIDERS_ENDPOINT}/${encodeURIComponent(modelId)}/providers`,
            { method: "GET", profileId: profile?.id },
        );
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

/**
 * Reads and normalizes the detailed subscription list using the profile's key. An unset or refused key, non-OK
 * response, or fetch/parsing/mapping failure returns an empty list; the public list is never substituted.
 */
export async function getNanoGPTSubscriptionModels(profile?: ModelProfile): Promise<NanoGPTModelInfo[]> {
    if (!credentialStatusFor(profile, NANOGPT_KEY).keySet) return [];
    try {
        const res = await auxFetch(
            "nanogpt-subscription-models",
            NANOGPT_SUBSCRIPTION_MODELS_ENDPOINT + "?detailed=true",
            {
                method: "GET",
                profileId: profile?.id,
            },
        );
        if (!res.ok) return [];
        const json = await res.json();
        const models: any[] = json?.data ?? [];
        return models.map((m) => ({
            id: m.id,
            name: m.name || m.id,
            owned_by: m.owned_by ?? "",
            context_length: m.context_length ?? 0,
            max_output_tokens: m.max_output_tokens ?? 0,
            description: m.description ?? "",
            capabilities: m.capabilities ?? {},
            promptPrice1M: parsePrice(m.pricing?.prompt),
            completionPrice1M: parsePrice(m.pricing?.completion),
        }));
    } catch {
        return [];
    }
}

/**
 * Reads the personalized list through `auxFetch` when a key is set, otherwise the public list with browser fetch.
 * Refused bindings return an empty list. JSON is mapped without checking HTTP status; absent data or a
 * fetch/parsing/mapping failure also yields an empty list, with no public fallback after a personalized failure.
 */
export async function getNanoGPTModels(profile?: ModelProfile): Promise<NanoGPTModelInfo[]> {
    try {
        // With a stored key, the personalized list through the server; without one, the public list.
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const status = credentialStatusFor(profile, NANOGPT_KEY);
        if (status.state === "refused") return [];
        const res = status.keySet
            ? await auxFetch("nanogpt-models", NANOGPT_PERSONALIZED_MODELS_ENDPOINT + "?detailed=true", {
                  method: "GET",
                  profileId: profile?.id,
                  headers,
              })
            : await fetch(NANOGPT_MODELS_ENDPOINT + "?detailed=true", { headers });
        const json = await res.json();

        const models: any[] = json?.data ?? [];

        return models.map((m) => ({
            id: m.id,
            name: m.name || m.id,
            owned_by: m.owned_by ?? "",
            context_length: m.context_length ?? 0,
            max_output_tokens: m.max_output_tokens ?? 0,
            description: m.description ?? "",
            capabilities: m.capabilities ?? {},
            promptPrice1M: parsePrice(m.pricing?.prompt),
            completionPrice1M: parsePrice(m.pricing?.completion),
        }));
    } catch (e) {
        return [];
    }
}

/** Formats available per-million prices for the grid; zero is Free and an unknown input price sorts last. */
export function toModelGridItem(m: NanoGPTModelInfo): ModelGridItem {
    const fmt = (p: number | undefined): string | null => {
        if (p === undefined) return null;
        if (p === 0) return "Free";
        return `$${p.toFixed(2)}`;
    };

    const prices: { label: string; value: string }[] = [];
    const pairs: [string, number | undefined][] = [
        ["In", m.promptPrice1M],
        ["Out", m.completionPrice1M],
    ];
    for (const [label, p] of pairs) {
        const v = fmt(p);
        if (v !== null) prices.push({ label, value: v });
    }

    return {
        id: m.id,
        displayName: m.name,
        providerName: m.owned_by,
        description: m.description,
        context_length: m.context_length,
        sortPrice: m.promptPrice1M ?? Infinity,
        prices,
    };
}

function parsePrice(raw: any): number | undefined {
    const n = Number(raw);
    return raw != null && raw !== "" && !isNaN(n) ? n : undefined;
}
