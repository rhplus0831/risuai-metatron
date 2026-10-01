import type { RequestContext } from "./context.ts";

/**
 * The client's `getFreeOpenRouterModels` (`src/ts/model/openrouter.ts`) on the server: the
 * OpenRouter list fetched with the stored key, the longest-context model whose priced name ends in
 * `Free`. The client's `getOpenRouterModels` swallows every error into an empty list, so with no
 * free model this throws reading `[0].id`, as the client does.
 */
export async function getFreeOpenRouterModels(ctx: Pick<RequestContext, "db" | "signal">): Promise<string> {
    let models: { id: string; name: string; context_length: number }[] = [];
    try {
        const aim: any = await fetch("https://openrouter.ai/api/v1/models", {
            headers: {
                Authorization: "Bearer " + ctx.db.openrouterKey,
                "Content-Type": "application/json",
            },
            signal: ctx.signal,
        }).then((res) => res.json());
        models = aim.data
            .map((model: any) => {
                const price = (Number(model.pricing.prompt) * 3 + Number(model.pricing.completion)) / 4;
                const legacyName =
                    price > 0 ? `${model.name} - $${(price * 1000).toFixed(5)}/1k` : `${model.name} - Free`;
                return { id: model.id, name: legacyName, price, context_length: model.context_length };
            })
            .filter((model: { price: number }) => model.price >= 0)
            .sort((a: { price: number }, b: { price: number }) => a.price - b.price);
    } catch {
        models = [];
    }
    return (
        models.filter((model) => model.name.endsWith("Free")).sort((a, b) => b.context_length - a.context_length)[0]
            .id ?? ""
    );
}
