import { risuEscape, risuUnescape } from "../../../shared/cbs/evaluator.ts";
import type { ModelModeExtended, RequestArgs } from "../../../shared/llm/request.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import type { requestDataResponse } from "./request.ts";
import type { RequestDb } from "./settings.ts";

/** What the outer loop calls; every hook it lacks is skipped. */
export type OuterRequestDeps = {
    db: Pick<
        RequestDb,
        "fallbackModels" | "requestRetrys" | "antiServerOverloads" | "fallbackWhenBlankResponse" | "banCharacterset"
    >;
    signal: AbortSignal;
    /** One attempt (`requestChatDataMain`), with the model `staticModel` names ("" for the mode's own). */
    attempt: (arg: RequestArgs) => Promise<requestDataResponse>;
    /** The plugins' `replacerbeforeRequest` hooks, in order (a job's channel callback). */
    beforeRequest?: (formated: OpenAIChat[], model: ModelModeExtended) => Promise<OpenAIChat[]>;
    /** The plugins' `replacerafterRequest` hooks, in order. */
    afterRequest?: (text: string, model: ModelModeExtended) => Promise<string>;
    /** The `request` trigger over the messages (the job's trigger runtime, Phase 5 slice 9). */
    requestTrigger?: (formated: OpenAIChat[]) => Promise<OpenAIChat[]>;
    /**
     * Whether a `requestTrigger` failure ends the request (the job's fatal failure or abort) instead
     * of the client's log-and-continue.
     */
    isFatal?: (error: unknown) => boolean;
};

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        }
        signal.addEventListener("abort", done, { once: true });
    });
}

/**
 * `requestChatData` of `src/ts/process/request/request.ts` (the client's outer loop around
 * `requestChatDataMain`) for a server job: the fallback models, the retries (`requestRetrys`,
 * `antiServerOverloads` after a server error), `escape`, the plugin replacers before and after each
 * attempt, the `request` trigger, `banCharacterset`, and `fallbackWhenBlankResponse`, in the
 * client's order. Tools are the caller's (`arg.tools`).
 */
export async function requestChatDataOuter(
    input: RequestArgs & { escape?: boolean },
    model: ModelModeExtended,
    deps: OuterRequestDeps,
): Promise<requestDataResponse> {
    const { db } = deps;
    const { escape, ...rest } = input;
    const arg: RequestArgs = { ...rest };
    const fallBackModels: string[] = structuredClone(
        (db.fallbackModels as Record<string, string[]> | undefined)?.[model] ?? [],
    );
    fallBackModels.push("");
    let da: requestDataResponse | undefined;

    if (escape) {
        arg.useStreaming = false;
    }

    const originalFormated = structuredClone(arg.formated).map((message) => {
        message.content = risuUnescape(message.content);
        return message;
    });

    for (let fallbackIndex = 0; fallbackIndex < fallBackModels.length; fallbackIndex++) {
        let trys = 0;
        arg.formated = structuredClone(originalFormated);

        if (fallbackIndex !== 0 && !fallBackModels[fallbackIndex]) {
            continue;
        }

        while (true) {
            if (deps.signal.aborted) {
                return { type: "fail", result: "Aborted" };
            }

            if (deps.beforeRequest) {
                arg.formated = await deps.beforeRequest(arg.formated, model);
            }

            if (deps.requestTrigger) {
                try {
                    const got = await deps.requestTrigger(arg.formated);
                    if (!got || !Array.isArray(got)) {
                        throw new Error("Invalid return");
                    }
                    arg.formated = got;
                } catch (error) {
                    if (deps.isFatal?.(error)) {
                        throw error;
                    }
                    console.error(error);
                }
            }

            da = await deps.attempt({ ...arg, staticModel: fallBackModels[fallbackIndex] });

            if (deps.signal.aborted) {
                return { type: "fail", result: "Aborted" };
            }

            if (da.type === "success" && escape) {
                da.result = risuEscape(da.result);
            }

            if (da.type === "success" && deps.afterRequest) {
                da.result = await deps.afterRequest(da.result, model);
            }

            if (da.type === "success" && db.banCharacterset?.length > 0) {
                let failed = false;
                for (const set of db.banCharacterset) {
                    const checkRegex = new RegExp(`\\p{Script=${set}}`, "gu");
                    if (checkRegex.test(da.result)) {
                        trys += 1;
                        failed = true;
                        break;
                    }
                }
                if (failed) {
                    continue;
                }
            }

            if (da.type === "success" && fallbackIndex !== fallBackModels.length - 1 && db.fallbackWhenBlankResponse) {
                if (da.result.trim() === "") {
                    break;
                }
            }

            if (da.type !== "fail" || da.noRetry) {
                const usedModel = fallBackModels[fallbackIndex] || da.model;
                return usedModel ? { ...da, model: usedModel } : da;
            }

            if (da.failByServerError) {
                await abortableSleep(1000, deps.signal);
                if (db.antiServerOverloads) {
                    trys -= 0.5; // reduce trys by 0.5, so that it will retry twice as much
                }
            }

            trys += 1;
            if (trys > db.requestRetrys) {
                const isPluginModel = da.model === "custom" || da.model?.startsWith("pluginmodel:::");
                if (fallbackIndex === fallBackModels.length - 1 || isPluginModel) {
                    return da;
                }
                break;
            }
        }
    }

    return da ?? { type: "fail", result: "All models failed" };
}
