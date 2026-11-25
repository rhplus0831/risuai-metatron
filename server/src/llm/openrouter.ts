import type { RequestContext } from "./context.ts";
import { messages } from "./messages.ts";

/**
 * Resolves OpenRouter's `risu/free` alias from a buffered GET of `/api/v1/models` using the chat request's resolved key.
 * Models with zero weighted prompt/completion pricing are labeled free, and the longest-context free model wins.
 * Returns a typed failure for an empty free list or a fetch, abort, or decoding error, preserving the error's message.
 *
 * Chat request construction (`model`, `messages` or a template `prompt`, routing/transforms/provider filters) and
 * SSE parsing belong to server/src/llm/openAI/requests.ts. Its snapshots, stream endings, and buffered error text
 * from server/src/llm/messages.ts also apply to OpenRouter; discovery failures use that module's messages too.
 */

type FreeOpenRouterModelResult = { ok: true; model: string } | { ok: false; reason: string };

/**
 * Fetches with the resolved key and request signal, then selects the longest-context model whose priced name ends
 * in `Free`. Reports an unavailable model or discovery error so the caller can fail before building a chat request.
 */
export async function getFreeOpenRouterModels(
    ctx: Pick<RequestContext, "signal">,
    key: string,
): Promise<FreeOpenRouterModelResult> {
    let models: { id: string; name: string; context_length: number }[] = [];
    try {
        const response = await fetch("https://openrouter.ai/api/v1/models", {
            headers: {
                Authorization: "Bearer " + key,
                "Content-Type": "application/json",
            },
            signal: ctx.signal,
        });
        if (!response.ok) {
            const body: any = await response.json().catch(() => null);
            return {
                ok: false,
                reason: messages.errors.openrouterFreeModelDiscoveryFailed(
                    typeof body?.error?.message === "string" ? body.error.message : `HTTP ${response.status}`,
                ),
            };
        }
        const aim: any = await response.json();
        models = aim.data
            .map((model: any) => {
                const price = (Number(model.pricing.prompt) * 3 + Number(model.pricing.completion)) / 4;
                const legacyName =
                    price > 0 ? `${model.name} - $${(price * 1000).toFixed(5)}/1k` : `${model.name} - Free`;
                return { id: model.id, name: legacyName, price, context_length: model.context_length };
            })
            .filter((model: { price: number }) => model.price >= 0)
            .sort((a: { price: number }, b: { price: number }) => a.price - b.price);
    } catch (error) {
        return {
            ok: false,
            reason: messages.errors.openrouterFreeModelDiscoveryFailed(
                error instanceof Error ? error.message : String(error),
            ),
        };
    }
    const model = models
        .filter((model) => model.name.endsWith("Free"))
        .sort((a, b) => b.context_length - a.context_length)[0]?.id;
    return model ? { ok: true, model } : { ok: false, reason: messages.errors.openrouterFreeModelUnavailable };
}
