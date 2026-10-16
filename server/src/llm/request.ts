// The server request layer (Phase 5, `request-layer-and-llm-secrets`): a port of
// `src/ts/process/request/request.ts`'s `requestChatDataMain` and its per-format functions. The
// client keeps the outer `requestChatData` loop (replacers, the request trigger, retries) and the
// formats that run in the tab (`Plugin`, `WebLLM`); `POST /api/llm/request` runs this for every
// other format. The client's module reads (`getDatabase`, `globalFetch`, the selected character,
// `getUserName`, `risuChatParser`, ...) are the request context's (`arg.ctx`).
import { Ollama } from "ollama";
import { LLMFlags, LLMFormat, type LLMModel } from "../../../shared/llm.ts";
import { resolveSlotProfile } from "../../../shared/llm/modelSlots.ts";
import { forwardProfileRoots, maxContextOverrideOf } from "../../../shared/sections.ts";
import type { OpenAIChat } from "../../../shared/openai.ts";
import type {
    BufferedResponse,
    ModelModeExtended,
    RequestArgs,
    RequestSpecial,
    StreamResponseChunk,
    ToolDescriptor,
} from "../../../shared/llm/request.ts";
import { applyChatTemplate } from "./chatTemplate.ts";
import type { RequestContext } from "./context.ts";
import { defaultCredentialKey, resolveCredential } from "./credentials.ts";
import { messages as language } from "./messages.ts";
import { NovelAIBadWordIds, stringlizeNAIChat } from "./nai.ts";
import { requestClaude } from "./anthropic.ts";
import { requestGoogleCloudVertex } from "./google.ts";
import { requestOpenAI, requestOpenAILegacyInstruct, requestOpenAIResponseAPI } from "./openAI/requests.ts";
import { applyAdditionalParameters, applyParameters, getAdditionalParameters } from "./shared.ts";
import { getStopStrings, stringlizeAINChat, unstringlizeAIN, unstringlizeChat } from "./stringlize.ts";
import { deferFirstByte, watchFirstByte } from "./transport.ts";
import { sleep } from "./util.ts";

export type { StreamResponseChunk };

export type ToolCall = {
    name: string;
    arguments: string;
};

/** The client's `RequestDataArgumentExtended`, built from the request body and the context. */
export interface RequestDataArgumentExtended extends RequestArgs {
    ctx: RequestContext;
    tools: ToolDescriptor[];
    aiModel: string;
    multiGen?: boolean;
    abortSignal?: AbortSignal | null;
    modelInfo: LLMModel;
    customURL?: string;
    mode: ModelModeExtended;
    key?: string;
    vertexCredential?: { clientEmail: string; privateKey: string; projectId?: string };
    additionalOutput?: string;
    saveSignatures?: boolean;
    // The client fields the adapters read but the body does not carry.
    escape?: boolean;
}

/**
 * A job's admitted request (`runInJob`, `docs/plan/request-history-diagnostics.md` slice 6): its id
 * in the request history and, for a failure, the provider's error code. Plain data.
 */
export type JobRequestInfo = { id: string; providerCode: string | null };

export type requestDataResponse = (
    | BufferedResponse
    | {
          type: "streaming";
          result: ReadableStream<StreamResponseChunk>;
          special?: RequestSpecial;
          model?: string;
      }
) & { request?: JobRequestInfo };

/** `OobaParams` of `src/ts/process/prompt.ts`. */
const OobaParams = [
    "tokenizer",
    "min_p",
    "top_k",
    "repetition_penalty",
    "repetition_penalty_range",
    "typical_p",
    "tfs",
    "top_a",
    "epsilon_cutoff",
    "eta_cutoff",
    "guidance_scale",
    "negative_prompt",
    "penalty_alpha",
    "mirostat_mode",
    "mirostat_tau",
    "mirostat_eta",
    "temperature_last",
    "do_sample",
    "seed",
    "encoder_repetition_penalty",
    "no_repeat_ngram_size",
    "min_length",
    "num_beams",
    "length_penalty",
    "early_stopping",
    "truncation_length",
    "max_tokens_second",
    "custom_token_bans",
    "auto_max_new_tokens",
    "ban_eos_token",
    "add_bos_token",
    "skip_special_tokens",
    "grammar_string",
];

/** The local stop strings, each parsed in the client's tab in order, as `risuChatParser` maps them. */
async function parseStopStrings(arg: RequestDataArgumentExtended, stopStrings: string[]): Promise<string[]> {
    const parsed: string[] = [];
    for (const v of stopStrings) {
        parsed.push(await arg.ctx.parseCbs(v.replace(/\\n/g, "\n"), arg.chatRef ?? null));
    }
    return parsed;
}

type OllamaThinkMode = boolean | "low" | "medium" | "high";

function getOllamaThinkMode(mode: string): OllamaThinkMode | undefined {
    switch (mode) {
        case "off":
            return false;
        case "on":
            return true;
        case "low":
        case "medium":
        case "high":
            return mode;
        default:
            return undefined;
    }
}

function formatThinkingOutput(thinking: string, content: string): string {
    return thinking ? `<Thoughts>\n${thinking}\n</Thoughts>\n\n${content}` : content;
}

function normalizeFetchHeaders(headers?: RequestInit["headers"]): { [key: string]: string } {
    if (!headers) {
        return {};
    }
    if (headers instanceof Headers) {
        return Object.fromEntries(headers.entries());
    }
    if (Array.isArray(headers)) {
        return Object.fromEntries(headers);
    }
    return headers as { [key: string]: string };
}

/** The client's `ollamaCloudFetch`, over the request's transport. */
const ollamaCloudFetch =
    (transport: RequestContext["transport"]) =>
    async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
        const url = input instanceof Request ? input.url : input.toString();
        const method = (init.method ?? (input instanceof Request ? input.method : "GET")) as
            "POST" | "GET" | "PUT" | "DELETE";
        const headers = normalizeFetchHeaders(init.headers ?? (input instanceof Request ? input.headers : undefined));
        const body = init.body ?? (input instanceof Request ? await input.arrayBuffer() : undefined);

        const response = await transport.fetchStream(url, {
            body: body as string | Uint8Array | ArrayBuffer | undefined,
            headers,
            method,
            signal: init.signal as AbortSignal,
            interceptor: "ollama_sdk",
        });

        return normalizeOllamaStreamResponse(response);
    };

function normalizeOllamaStreamResponse(response: Response): Response {
    if (!response.body) {
        return response;
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let depth = 0;
    let inString = false;
    let escaped = false;

    const stream = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                let out = "";
                const text = decoder.decode(chunk, { stream: true });

                for (const char of text) {
                    out += char;

                    if (escaped) {
                        escaped = false;
                        continue;
                    }
                    if (char === "\\" && inString) {
                        escaped = true;
                        continue;
                    }
                    if (char === '"') {
                        inString = !inString;
                        continue;
                    }
                    if (inString) {
                        continue;
                    }
                    if (char === "{") {
                        depth++;
                        continue;
                    }
                    if (char === "}") {
                        depth = Math.max(0, depth - 1);
                        if (depth === 0) {
                            out += "\n";
                        }
                    }
                }

                if (out) {
                    controller.enqueue(encoder.encode(out));
                }
            },
        }),
    );

    return new Response(stream, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
    });
}

export function reformater(
    formated: OpenAIChat[],
    modelInfo: LLMModel | LLMFlags[],
    db: Pick<RequestContext["db"], "systemContentReplacement" | "systemRoleReplacement">,
) {
    const flags = Array.isArray(modelInfo) ? modelInfo : modelInfo.flags;

    let systemPrompt: OpenAIChat | null = null;

    if (!flags.includes(LLMFlags.hasFullSystemPrompt)) {
        if (flags.includes(LLMFlags.hasFirstSystemPrompt)) {
            while (formated[0].role === "system") {
                if (systemPrompt) {
                    systemPrompt.content += "\n\n" + formated[0].content;
                } else {
                    systemPrompt = formated[0];
                }
                formated = formated.slice(1);
            }
        }

        for (let i = 0; i < formated.length; i++) {
            if (formated[i].role === "system") {
                formated[i].content = db.systemContentReplacement
                    ? db.systemContentReplacement.replace("{{slot}}", formated[i].content)
                    : `system: ${formated[i].content}`;
                formated[i].role = db.systemRoleReplacement || "user";
            }
        }
    }

    if (flags.includes(LLMFlags.requiresAlternateRole)) {
        let newFormated: OpenAIChat[] = [];
        for (let i = 0; i < formated.length; i++) {
            const m = formated[i];
            if (newFormated.length === 0) {
                newFormated.push(m);
                continue;
            }

            if (newFormated[newFormated.length - 1].role === m.role) {
                newFormated[newFormated.length - 1].content += "\n" + m.content;

                if (m.multimodals) {
                    if (!newFormated[newFormated.length - 1].multimodals) {
                        newFormated[newFormated.length - 1].multimodals = [];
                    }
                    newFormated[newFormated.length - 1].multimodals!.push(...m.multimodals);
                }

                if (m.thoughts) {
                    if (!newFormated[newFormated.length - 1].thoughts) {
                        newFormated[newFormated.length - 1].thoughts = [];
                    }
                    newFormated[newFormated.length - 1].thoughts!.push(...m.thoughts);
                }

                if (m.cachePoint) {
                    if (!newFormated[newFormated.length - 1].cachePoint) {
                        newFormated[newFormated.length - 1].cachePoint = true;
                    }
                }

                continue;
            } else {
                newFormated.push(m);
            }
        }
        formated = newFormated;
    }

    if (flags.includes(LLMFlags.mustStartWithUserInput)) {
        if (formated.length === 0 || formated[0].role !== "user") {
            formated.unshift({
                role: "user",
                content: " ",
            });
        }
    }

    if (systemPrompt) {
        formated.unshift(systemPrompt);
    }

    return formated;
}

/** An `LLMFormat` value's name (`OpenAICompatible`), or null for a value outside the list. */
function formatName(format: LLMFormat): string | null {
    for (const [name, value] of Object.entries(LLMFormat)) {
        if (value === format) {
            return name;
        }
    }
    return null;
}

/**
 * `requestChatDataMain` on the server: shared slot resolution, a request-local profile overlay,
 * argument defaults, reverse-proxy/custom-model overrides, `reformater`, then the format's function.
 * Missing or required profiles refuse before dispatch; the job's captured settings stay unchanged.
 * `Plugin` (a plugin provider model) is called in the job's tab through `ctx.pluginProvider`, and
 * `WebLLM` (a local Transformers.js model) runs on the server (`ctx.localGeneration`): both for a
 * job's request only; a tab runs them itself and its transport never sends them. Dynamic provider
 * models resolve from their ids through the shared catalogue.
 */
export async function requestChatDataMain(
    arg: RequestArgs & { tools: ToolDescriptor[] },
    model: ModelModeExtended,
    ctx: RequestContext,
): Promise<requestDataResponse> {
    const resolved = resolveSlotProfile(
        ctx.db.modelPreset,
        ctx.db.modelProfiles,
        model,
        arg.staticModel,
        arg.profileId,
    );
    if (resolved.kind === "refused") {
        return {
            type: "fail",
            result:
                resolved.reason === "missingProfile"
                    ? language.errors.modelProfileMissing(model)
                    : resolved.reason === "missingNamedProfile"
                      ? language.errors.modelProfileNamedMissing
                      : language.errors.modelProfileRequired(resolved.modelId!),
            noRetry: true,
        };
    }
    const profile = resolved.kind === "profile" ? resolved.profile : undefined;
    const db = { ...ctx.db, aiModel: resolved.modelId };
    forwardProfileRoots(db, profile);
    // The prompt preset's context size override is the main slot's only: a named profile, the sub
    // and auxiliary slots (even on the main profile), and another static model keep their own.
    if (
        model === "model" &&
        arg.profileId === undefined &&
        profile !== undefined &&
        profile.id === ctx.db.modelPreset.mainSlot.profileId
    ) {
        db.maxContext = maxContextOverrideOf(ctx.db as unknown as Record<string, unknown>) ?? db.maxContext;
    }
    const getModelInfo = ctx.getModelInfo;
    ctx = {
        ...ctx,
        db,
        // Dynamic and plugin descriptors keep the context's resolution rules. Clone the result
        // before adapters change its format, internal id, or flags, including a captured plugin model.
        getModelInfo: (id) => structuredClone(getModelInfo(id, db)),
    };
    const aiModel = resolved.modelId;
    const targ: RequestDataArgumentExtended = {
        ...arg,
        ctx,
        aiModel,
        modelInfo: ctx.getModelInfo(aiModel),
        mode: model,
    };

    if (
        (targ.modelInfo.format === LLMFormat.Plugin && !ctx.pluginProvider) ||
        (targ.modelInfo.format === LLMFormat.WebLLM && !ctx.localGeneration)
    ) {
        return {
            type: "fail",
            result: `${targ.modelInfo.name} runs in the browser, not on the server.`,
            noRetry: true,
        };
    }

    targ.formated = structuredClone(arg.formated);
    targ.maxTokens = arg.maxTokens ?? db.maxResponse;
    targ.temperature = arg.temperature ?? db.temperature / 100;
    targ.bias = arg.bias;
    targ.useStreaming = arg.forceStreaming ? true : db.useStreaming && arg.useStreaming;
    targ.continue = arg.continue ?? false;
    targ.biasString = arg.biasString ?? [];
    targ.multiGen = db.genTime > 1 && targ.aiModel.startsWith("gpt") && !arg.continue && !arg.noMultiGen;
    targ.abortSignal = ctx.signal;
    targ.mode = model;
    targ.extractJson = arg.extractJson ?? db.extractJson;
    if (targ.aiModel === "reverse_proxy") {
        targ.modelInfo.internalID = db.customProxyRequestModel;
        targ.modelInfo.format = db.customAPIFormat;
        targ.customURL = db.forceReplaceUrl;
    }
    if (targ.aiModel.startsWith("xcustom:::")) {
        const found = db.customModels.find((m) => m.id === targ.aiModel);
        targ.customURL = found?.url;
    }

    // The request history's model (`docs/plan/request-history-diagnostics.md`), with its final format.
    ctx.describe?.({
        modelId: aiModel,
        profileId: profile?.id ?? null,
        profileName: profile?.name ?? null,
        provider: formatName(targ.modelInfo.format),
    });

    const credential = resolveCredential(db, targ.aiModel, targ.modelInfo, profile);
    switch (credential.kind) {
        case "refused":
            return { type: "fail", result: credential.message, noRetry: true };
        case "key":
            targ.key = credential.key;
            break;
        case "vertex":
            targ.vertexCredential = {
                clientEmail: credential.clientEmail,
                privateKey: credential.privateKey,
                ...(credential.projectId !== undefined ? { projectId: credential.projectId } : {}),
            };
            break;
        case "default":
            break;
    }

    const format = targ.modelInfo.format;

    targ.formated = reformater(targ.formated, targ.modelInfo, db);

    switch (format) {
        case LLMFormat.OpenAICompatible:
        case LLMFormat.Mistral:
        case LLMFormat.NanoGPT:
            return requestOpenAI(targ);
        case LLMFormat.NanoGPTResponses:
            return requestOpenAIResponseAPI(targ);
        case LLMFormat.NanoGPTMessages:
            return requestClaude(targ);
        case LLMFormat.NanoGPTLegacy:
            return requestOpenAILegacyInstruct(targ);
        case LLMFormat.OpenAILegacyInstruct:
            return requestOpenAILegacyInstruct(targ);
        case LLMFormat.NovelAI:
            return requestNovelAI(targ);
        case LLMFormat.OobaLegacy:
            return requestOobaLegacy(targ);
        case LLMFormat.Ooba:
            return requestOoba(targ);
        case LLMFormat.VertexAIGemini:
        case LLMFormat.GoogleCloud:
            return requestGoogleCloudVertex(targ);
        case LLMFormat.Kobold:
            return requestKobold(targ);
        case LLMFormat.NovelList:
            return requestNovelList(targ);
        case LLMFormat.Ollama:
            return requestOllama(targ);
        case LLMFormat.Cohere:
            return requestCohere(targ);
        case LLMFormat.Anthropic:
        case LLMFormat.AnthropicLegacy:
        case LLMFormat.AWSBedrockClaude:
            return requestClaude(targ);
        case LLMFormat.Horde:
            return requestHorde(targ);
        case LLMFormat.OpenAIResponseAPI:
            return requestOpenAIResponseAPI(targ);
        case LLMFormat.Echo:
            return requestEcho(targ);
        case LLMFormat.WebLLM:
            return requestWebLLM(targ);
        case LLMFormat.Plugin:
            return requestPlugin(targ);
    }

    return {
        type: "fail",
        result: language.errors.unknownModel,
    };
}

/**
 * The client's `requestPlugin`: a plugin provider (`pluginmodel:::<name>`, or the legacy `custom`
 * model with `currentPluginProvider`), called in the job's tab with the prompt and the seven
 * parameters applied from the job's settings. The provider's stream arrives as cumulative text.
 */
async function requestPlugin(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const db = arg.ctx.db;
    const isV3Model = arg.aiModel.startsWith("pluginmodel:::");
    const responseModel = isV3Model ? arg.aiModel : "custom";
    try {
        const formated = arg.formated;
        const maxTokens = arg.maxTokens;
        const model = isV3Model ? arg.aiModel.replace("pluginmodel:::", "") : db.currentPluginProvider;

        if (arg.previewBody) {
            return {
                type: "success",
                result: JSON.stringify({
                    error: "Plugin is not supported in preview mode",
                }),
            };
        }

        const d = await arg.ctx.pluginProvider!(
            model,
            applyParameters(
                {
                    prompt_chat: formated,
                    mode: arg.mode,
                    bias: [],
                    max_tokens: maxTokens,
                },
                [
                    "frequency_penalty",
                    "min_p",
                    "presence_penalty",
                    "repetition_penalty",
                    "top_k",
                    "top_p",
                    "temperature",
                ],
                {},
                {
                    modelId: arg.aiModel,
                },
                db,
            ),
        );

        if ("none" in d) {
            return {
                type: "fail",
                result: language.errors.unknownModel,
                model: responseModel,
            };
        } else if ("stream" in d) {
            return {
                type: "streaming",
                result: d.stream,
                model: responseModel,
            };
        } else if (!d.success) {
            return {
                type: "fail",
                result: d.content,
                model: responseModel,
            };
        } else {
            return {
                type: "success",
                result: d.content ?? "",
                model: responseModel,
            };
        }
    } catch (error) {
        if (arg.ctx.signal.aborted) {
            throw error;
        }
        return {
            type: "fail",
            result:
                `Plugin Error from ${db.currentPluginProvider}: ` +
                (error instanceof Error ? error.message : JSON.stringify(error)),
            model: responseModel,
        };
    }
}

/**
 * The client's `requestWebLLM`: a Transformers.js text-generation model (`hf:::<model>`), run by the
 * server's local model process. The generated text is the pipeline's (the prompt included), trimmed
 * by `unstringlizeChat` with the selected character's name, as on the client.
 */
async function requestWebLLM(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const formated = arg.formated;
    const db = arg.ctx.db;
    const aiModel = arg.aiModel;
    const maxTokens = arg.maxTokens;
    const temperature = arg.temperature;
    const realModel = aiModel.split(":::")[1];
    const prompt = applyChatTemplate(formated, arg.ctx);

    if (arg.previewBody) {
        return {
            type: "success",
            result: JSON.stringify({
                error: "Preview body is not supported for WebLLM",
            }),
        };
    }
    const transformersParams = {
        temperature: temperature,
        max_new_tokens: maxTokens,
        top_k: db.ooba.top_k,
        top_p: db.ooba.top_p,
        repetition_penalty: db.ooba.repetition_penalty,
        typical_p: db.ooba.typical_p,
    } as Record<string, unknown>;

    const finalParams = applyAdditionalParameters(transformersParams, {}, getAdditionalParameters(db, arg.aiModel));

    let generated: string;
    try {
        generated = await arg.ctx.localGeneration!(prompt, realModel, finalParams);
        arg.ctx.firstByte?.mark();
    } catch (error) {
        if (arg.ctx.signal.aborted) {
            throw error;
        }
        return {
            type: "fail",
            result: `${error}`,
        };
    }
    return {
        type: "success",
        result: unstringlizeChat(generated ?? "", formated, arg.ctx, arg.ctx.selectedCharacterName ?? ""),
    };
}

async function requestNovelAI(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const formated = arg.formated;
    const db = arg.ctx.db;
    const aiModel = arg.aiModel;
    const temperature = arg.temperature;
    const maxTokens = arg.maxTokens;
    const biasString = arg.biasString;
    const prompt = stringlizeNAIChat(formated, arg.ctx.selectedCharacterName ?? "", arg.continue ?? false, arg.ctx);
    const abortSignal = arg.abortSignal;
    let logit_bias_exp: {
        sequence: number[];
        bias: number;
        ensure_sequence_finish: false;
        generate_once: true;
    }[] = [];

    if (arg.previewBody) {
        return {
            type: "success",
            result: JSON.stringify({
                error: "This model is not supported in preview mode",
            }),
        };
    }

    for (let i = 0; i < biasString!.length; i++) {
        const bia = biasString![i];
        const tokens = Array.from(await arg.ctx.tokenizeNum(bia[0]));

        const tokensInNumberArray: number[] = [];

        for (const token of tokens) {
            tokensInNumberArray.push(token);
        }
        logit_bias_exp.push({
            sequence: tokensInNumberArray,
            bias: bia[1],
            ensure_sequence_finish: false,
            generate_once: true,
        });
    }

    let prefix = "vanilla";

    if (db.NAIadventure) {
        prefix = "theme_textadventure";
    }

    const gen = db.NAIsettings;
    const payload = {
        temperature: temperature,
        max_length: maxTokens,
        min_length: 1,
        top_k: gen.topK,
        top_p: gen.topP,
        top_a: gen.topA,
        tail_free_sampling: gen.tailFreeSampling,
        repetition_penalty: gen.repetitionPenalty,
        repetition_penalty_range: gen.repetitionPenaltyRange,
        repetition_penalty_slope: gen.repetitionPenaltySlope,
        repetition_penalty_frequency: gen.frequencyPenalty,
        repetition_penalty_presence: gen.presencePenalty,
        generate_until_sentence: true,
        use_cache: false,
        use_string: true,
        return_full_text: false,
        prefix: prefix,
        order: [6, 2, 3, 0, 4, 1, 5, 8],
        typical_p: gen.typicalp,
        repetition_penalty_whitelist: [
            49256, 49264, 49231, 49230, 49287, 85, 49255, 49399, 49262, 336, 333, 432, 363, 468, 492, 745, 401, 426,
            623, 794, 1096, 2919, 2072, 7379, 1259, 2110, 620, 526, 487, 16562, 603, 805, 761, 2681, 942, 8917, 653,
            3513, 506, 5301, 562, 5010, 614, 10942, 539, 2976, 462, 5189, 567, 2032, 123, 124, 125, 126, 127, 128, 129,
            130, 131, 132, 588, 803, 1040, 49209, 4, 5, 6, 7, 8, 9, 10, 11, 12,
        ],
        stop_sequences: [[49287], [49405]],
        bad_words_ids: NovelAIBadWordIds,
        logit_bias_exp: logit_bias_exp,
        mirostat_lr: gen.mirostat_lr ?? 1,
        mirostat_tau: gen.mirostat_tau ?? 0,
        cfg_scale: gen.cfg_scale ?? 1,
        cfg_uc: "",
    };

    let body = {
        input: prompt,
        model: aiModel === "novelai_kayra" ? "kayra-v1" : "clio-v1",
        parameters: payload,
    };

    let headers = {
        Authorization: "Bearer " + (arg.key ?? defaultCredentialKey(aiModel, db.novelai.token)),
    };

    body = applyAdditionalParameters(body, headers, getAdditionalParameters(arg.ctx.db, aiModel));

    const da = await arg.ctx.transport.fetchBuffered(
        aiModel === "novelai_kayra" ? "https://text.novelai.net/ai/generate" : "https://api.novelai.net/ai/generate",
        {
            body: body,
            headers: headers,
            abortSignal,
            chatId: arg.chatId,
        },
    );

    if (!da.ok || !da.data.output) {
        return {
            type: "fail",
            result: language.errors.httpError + `${JSON.stringify(da.data)}`,
        };
    }
    return {
        type: "success",
        result: unstringlizeChat(da.data.output, formated, arg.ctx, arg.ctx.selectedCharacterName ?? ""),
    };
}

async function requestOobaLegacy(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const formated = arg.formated;
    const db = arg.ctx.db;
    const aiModel = arg.aiModel;
    const maxTokens = arg.maxTokens;
    const useStreaming = arg.useStreaming;
    const abortSignal = arg.abortSignal;
    let streamUrl = db.textgenWebUIStreamURL.replace(/\/api.*/, "/api/v1/stream");
    let blockingUrl = db.textgenWebUIBlockingURL.replace(/\/api.*/, "/api/v1/generate");
    let bodyTemplate: { [key: string]: any } = {};
    const prompt = applyChatTemplate(formated, arg.ctx);
    let stopStrings = getStopStrings(arg.ctx, false);
    if (db.localStopStrings) {
        stopStrings = await parseStopStrings(arg, db.localStopStrings);
    }

    bodyTemplate = {
        max_new_tokens: db.maxResponse,
        do_sample: db.ooba.do_sample,
        temperature: db.temperature / 100,
        top_p: db.ooba.top_p,
        typical_p: db.ooba.typical_p,
        repetition_penalty: db.ooba.repetition_penalty,
        encoder_repetition_penalty: db.ooba.encoder_repetition_penalty,
        top_k: db.ooba.top_k,
        min_length: db.ooba.min_length,
        no_repeat_ngram_size: db.ooba.no_repeat_ngram_size,
        num_beams: db.ooba.num_beams,
        penalty_alpha: db.ooba.penalty_alpha,
        length_penalty: db.ooba.length_penalty,
        early_stopping: false,
        truncation_length: maxTokens,
        ban_eos_token: db.ooba.ban_eos_token,
        stopping_strings: stopStrings,
        seed: -1,
        add_bos_token: db.ooba.add_bos_token,
        topP: db.top_p,
        prompt: prompt,
    };

    let headers: Record<string, string> =
        aiModel === "textgen_webui"
            ? {}
            : {
                  "X-API-KEY": arg.key ?? defaultCredentialKey(aiModel, db.mancerHeader),
              };

    bodyTemplate = applyAdditionalParameters(bodyTemplate, headers, getAdditionalParameters(arg.ctx.db, aiModel));

    if (arg.previewBody) {
        return {
            type: "success",
            result: JSON.stringify({
                url: blockingUrl,
                body: bodyTemplate,
                headers: headers,
            }),
        };
    }

    if (useStreaming) {
        if (abortSignal?.aborted) {
            return { type: "fail", result: "Aborted" };
        }
        const oobaboogaSocket = new WebSocket(streamUrl);
        const statusCode = await new Promise((resolve) => {
            oobaboogaSocket.onopen = () => resolve(0);
            oobaboogaSocket.onerror = () => resolve(1001);
            oobaboogaSocket.onclose = ({ code }) => resolve(code);
            // The client waits for the handshake whatever the signal does; here an ended request
            // stops waiting.
            abortSignal?.addEventListener("abort", () => resolve(1000), { once: true });
        });
        if (abortSignal?.aborted || statusCode !== 0) {
            oobaboogaSocket.close();
            return {
                type: "fail",
                result: abortSignal?.reason || `WebSocket connection failed to '${streamUrl}' failed!`,
            };
        }

        // One terminal for the socket and the stream. In the browser a bad frame or an
        // unexpected close only logged and left the stream open; here a throw in a socket handler
        // would end the server process, so a bad frame or a close before `stream_end` errors the
        // stream, and nothing is handled after the end.
        let ended = false;
        let streamController: ReadableStreamDefaultController<any> | null = null;
        const end = (error?: Error) => {
            if (ended) {
                return;
            }
            ended = true;
            const ignore = () => {};
            oobaboogaSocket.onmessage = ignore;
            oobaboogaSocket.onerror = ignore;
            oobaboogaSocket.onclose = ignore;
            try {
                oobaboogaSocket.close();
            } catch {}
            try {
                if (error) {
                    streamController?.error(error);
                } else {
                    streamController?.close();
                }
            } catch {}
        };
        const stream = new ReadableStream({
            start(controller) {
                streamController = controller;
                let readed = "";
                oobaboogaSocket.onmessage = (event) => {
                    if (ended) {
                        return;
                    }
                    try {
                        arg.ctx.firstByte?.mark();
                        const json = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
                        if (json.event === "stream_end") {
                            end();
                            return;
                        }
                        if (json.event !== "text_stream") return;
                        readed += json.text;
                        controller.enqueue(readed);
                    } catch (error) {
                        end(error instanceof Error ? error : new Error(String(error)));
                    }
                };
                try {
                    oobaboogaSocket.send(JSON.stringify(bodyTemplate));
                } catch (error) {
                    end(error instanceof Error ? error : new Error(String(error)));
                }
            },
            cancel() {
                end();
            },
        });
        oobaboogaSocket.onerror = () => end(new Error(`The WebSocket to '${streamUrl}' failed`));
        oobaboogaSocket.onclose = () =>
            end(new Error(`The WebSocket to '${streamUrl}' closed before the stream ended`));
        abortSignal?.addEventListener("abort", () => end(new Error("Aborted")), { once: true });

        return {
            type: "streaming",
            result: stream,
        };
    }

    const res = await arg.ctx.transport.fetchBuffered(blockingUrl, {
        body: bodyTemplate,
        headers: headers,
        abortSignal,
        chatId: arg.chatId,
    });

    const dat = res.data as any;
    if (res.ok) {
        try {
            let result: string = dat.results[0].text ?? "";

            return {
                type: "success",
                result: unstringlizeChat(result, formated, arg.ctx, arg.ctx.selectedCharacterName ?? ""),
            };
        } catch (error) {
            return {
                type: "fail",
                result: language.errors.httpError + `${error}`,
            };
        }
    } else {
        return {
            type: "fail",
            result: language.errors.httpError + `${JSON.stringify(res.data)}`,
        };
    }
}

async function requestOoba(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const formated = arg.formated;
    const db = arg.ctx.db;
    const aiModel = arg.aiModel;
    const maxTokens = arg.maxTokens;
    const temperature = arg.temperature;
    const prompt = applyChatTemplate(formated, arg.ctx);
    let stopStrings = getStopStrings(arg.ctx, false);
    if (db.localStopStrings) {
        stopStrings = await parseStopStrings(arg, db.localStopStrings);
    }
    let bodyTemplate: Record<string, any> = {
        prompt: prompt,
        presence_penalty: arg.PresensePenalty || db.PresensePenalty / 100,
        frequency_penalty: arg.frequencyPenalty || db.frequencyPenalty / 100,
        logit_bias: {},
        max_tokens: maxTokens,
        stop: stopStrings,
        temperature: temperature,
        top_p: db.top_p,
    };

    const url = new URL(db.textgenWebUIBlockingURL);
    url.pathname = "/v1/completions";
    const urlStr = url.toString();

    const OobaBodyTemplate = db.reverseProxyOobaArgs as Record<string, any>;
    const keys = Object.keys(OobaBodyTemplate);
    for (const key of keys) {
        if (OobaBodyTemplate[key] !== undefined && OobaBodyTemplate[key] !== null && OobaParams.includes(key)) {
            bodyTemplate[key] = OobaBodyTemplate[key];
        } else if (bodyTemplate[key]) {
            delete bodyTemplate[key];
        }
    }

    let headers: Record<string, string> = {};
    bodyTemplate = applyAdditionalParameters(bodyTemplate, headers, getAdditionalParameters(arg.ctx.db, aiModel));

    if (arg.previewBody) {
        return {
            type: "success",
            result: JSON.stringify({
                url: urlStr,
                body: bodyTemplate,
                headers: headers,
            }),
        };
    }

    const response = await arg.ctx.transport.fetchBuffered(urlStr, {
        body: bodyTemplate,
        headers: headers,
        chatId: arg.chatId,
        abortSignal: arg.abortSignal,
    });

    if (!response.ok) {
        return {
            type: "fail",
            result: language.errors.httpError + `${JSON.stringify(response.data)}`,
        };
    }
    const text: string = response.data.choices[0].text ?? "";
    return {
        type: "success",
        result: text.replace(/##\n/g, ""),
    };
}

async function requestEcho(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const db = arg.ctx.db;
    const delay = db.echoDelay ?? 0;
    const message = db.echoMessage ?? "Echo Message";

    if (delay > 0) {
        await sleep(delay * 1000);
    }

    return {
        type: "success",
        result: message,
    };
}

async function requestKobold(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const formated = arg.formated;
    const db = arg.ctx.db;
    const maxTokens = arg.maxTokens;
    const abortSignal = arg.abortSignal;

    const prompt = applyChatTemplate(formated, arg.ctx);
    const url = new URL(db.koboldURL);
    if (url.pathname.length < 3) {
        url.pathname = "api/v1/generate";
    }

    let body = applyParameters(
        {
            prompt: prompt,
            max_length: maxTokens,
            max_context_length: db.maxContext,
            n: 1,
        },
        ["temperature", "top_p", "repetition_penalty", "top_k", "top_a"],
        {
            repetition_penalty: "rep_pen",
        },
        {
            modelId: arg.aiModel,
        },
        arg.ctx.db,
    ) as KoboldGenerationInputSchema;

    let headers: Record<string, string> = {
        "content-type": "application/json",
    };

    body = applyAdditionalParameters(
        body,
        headers,
        getAdditionalParameters(arg.ctx.db, arg.aiModel),
    ) as KoboldGenerationInputSchema;

    if (arg.previewBody) {
        return {
            type: "success",
            result: JSON.stringify({
                url: url.toString(),
                body: body,
                headers: headers,
            }),
        };
    }

    const da = await arg.ctx.transport.fetchBuffered(url.toString(), {
        method: "POST",
        body: body,
        headers: headers,
        abortSignal,
        chatId: arg.chatId,
    });

    if (!da.ok) {
        return {
            type: "fail",
            result: typeof da.data === "string" ? da.data : JSON.stringify(da.data),
            noRetry: true,
        };
    }

    const data = da.data;
    return {
        type: "success",
        result: data.results[0].text,
    };
}

async function requestNovelList(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const formated = arg.formated;
    const db = arg.ctx.db;
    const maxTokens = arg.maxTokens;
    const temperature = arg.temperature;
    const biasString = arg.biasString;
    const aiModel = arg.aiModel;
    const auth_key = arg.key ?? defaultCredentialKey(aiModel, db.novellistAPI);
    const api_server_url = "https://api.tringpt.com/";
    const logit_bias: string[] = [];
    const logit_bias_values: string[] = [];
    for (let i = 0; i < biasString!.length; i++) {
        const bia = biasString![i];
        logit_bias.push(bia[0]);
        logit_bias_values.push(bia[1].toString());
    }

    let headers: Record<string, string> = {
        Authorization: `Bearer ${auth_key}`,
        "Content-Type": "application/json",
    };

    let send_body: Record<string, any> = {
        text: stringlizeAINChat(formated, arg.ctx.selectedCharacterName ?? "", arg.continue ?? false, arg.ctx),
        length: maxTokens,
        temperature: temperature,
        top_p: db.ainconfig.top_p,
        top_k: db.ainconfig.top_k,
        rep_pen: db.ainconfig.rep_pen,
        top_a: db.ainconfig.top_a,
        rep_pen_slope: db.ainconfig.rep_pen_slope,
        rep_pen_range: db.ainconfig.rep_pen_range,
        typical_p: db.ainconfig.typical_p,
        badwords: db.ainconfig.badwords,
        model: aiModel === "novellist_damsel" ? "damsel" : "supertrin",
        stoptokens: ["「"].join("<<|>>") + db.ainconfig.stoptokens,
        logit_bias: logit_bias.length > 0 ? logit_bias.join("<<|>>") : undefined,
        logit_bias_values: logit_bias_values.length > 0 ? logit_bias_values.join("|") : undefined,
    };

    send_body = applyAdditionalParameters(send_body, headers, getAdditionalParameters(arg.ctx.db, arg.aiModel));

    if (arg.previewBody) {
        return {
            type: "success",
            result: JSON.stringify({
                url: api_server_url + "/api",
                body: send_body,
                headers: headers,
            }),
        };
    }
    const response = await arg.ctx.transport.fetchBuffered(arg.customURL ?? api_server_url + "/api", {
        method: "POST",
        headers: headers,
        body: send_body,
        chatId: arg.chatId,
        abortSignal: arg.abortSignal,
    });

    if (!response.ok) {
        return {
            type: "fail",
            result: response.data,
        };
    }

    if (response.data.error) {
        return {
            type: "fail",
            result: `${response.data.error.replace("token", "api key")}`,
        };
    }

    const result = response.data.data[0];
    const unstr = unstringlizeAIN(result, formated, arg.ctx, arg.ctx.selectedCharacterName ?? "");
    return {
        type: "multiline",
        result: unstr,
    };
}

async function requestOllama(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const formated = arg.formated;
    const db = arg.ctx.db;
    const isCloud = arg.aiModel === "ollama-cloud";
    const requestFormat = isCloud ? db.ollamaRequestFormat : LLMFormat.Ollama;
    const ollamaModel = isCloud ? db.ollamaCloudModel : db.ollamaModel;
    const ollamaThinkMode = getOllamaThinkMode(db.ollamaThinkingMode);

    if (isCloud && requestFormat === LLMFormat.OpenAICompatible) {
        arg.customURL = "https://ollama.com/v1/chat/completions";
        arg.key ??= defaultCredentialKey(arg.aiModel, db.ollamaApiKey);
        arg.modelInfo.internalID = ollamaModel;
        return requestOpenAI(arg);
    }

    if (isCloud && requestFormat === LLMFormat.OpenAIResponseAPI) {
        arg.customURL = "https://ollama.com/v1/responses";
        arg.key ??= defaultCredentialKey(arg.aiModel, db.ollamaApiKey);
        arg.modelInfo.internalID = ollamaModel;
        return requestOpenAIResponseAPI(arg);
    }

    if (isCloud && requestFormat === LLMFormat.Anthropic) {
        arg.customURL = "https://ollama.com/v1/messages";
        arg.key ??= defaultCredentialKey(arg.aiModel, db.ollamaApiKey);
        arg.modelInfo = {
            ...arg.modelInfo,
            internalID: ollamaModel,
            parameters: ["temperature", "top_k", "top_p"],
        };
        return requestClaude(arg);
    }

    const messages: any[] = [];
    for (const v of formated) {
        if (v.role === "assistant" || v.role === "user" || v.role === "system") {
            messages.push({
                role: v.role,
                content: v.content,
            });
        }
    }

    const apiKey = arg.key ?? defaultCredentialKey(arg.aiModel, db.ollamaApiKey);
    let customHeaders: Record<string, string> = isCloud && apiKey ? { Authorization: "Bearer " + apiKey } : {};

    let requestBody: any = {
        model: ollamaModel,
        messages: messages,
        stream: arg.useStreaming,
        think: ollamaThinkMode,
    };

    requestBody = applyAdditionalParameters(
        requestBody,
        customHeaders,
        getAdditionalParameters(arg.ctx.db, arg.aiModel),
    );

    if (arg.previewBody) {
        return {
            type: "success",
            result: JSON.stringify({
                url: isCloud ? "https://ollama.com/api/chat" : `${db.ollamaURL}/api/chat`,
                model: ollamaModel,
                source: db.ollamaModelSource,
                stream: arg.useStreaming,
                think: ollamaThinkMode,
                headers: Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
                body: requestBody,
            }),
        };
    }

    const ollama = new Ollama({
        host: isCloud ? "https://ollama.com" : db.ollamaURL,
        headers: Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
        // The browser's local Ollama used the page's fetch directly; here it is the server's,
        // aborted with the request (the SDK's `abort()` reaches only streams it has registered).
        fetch: isCloud
            ? ollamaCloudFetch(arg.ctx.transport)
            : (input: string | URL | Request, init: RequestInit = {}) =>
                  fetch(input, {
                      ...init,
                      signal: init.signal ? AbortSignal.any([init.signal, arg.ctx.signal]) : arg.ctx.signal,
                  }).then((response) => {
                      const hook = arg.ctx.firstByte;
                      return hook ? watchFirstByte(response, () => hook.mark()) : response;
                  }),
    });
    // The SDK takes no signal; `abort()` ends its open requests when the request ends.
    if (arg.ctx.signal.aborted) {
        return { type: "fail", result: "Aborted" };
    }
    arg.ctx.signal.addEventListener("abort", () => ollama.abort(), { once: true });

    if (!arg.useStreaming) {
        requestBody.stream = false;
        const response: any = await ollama.chat(requestBody);

        const result = formatThinkingOutput(response.message?.thinking ?? "", response.message?.content ?? "");
        return {
            type: "success",
            result: unstringlizeChat(result, formated, arg.ctx, arg.ctx.speakerName ?? ""),
            model: arg.aiModel,
        };
    }

    requestBody.stream = true;
    const response: any = await ollama.chat(requestBody);

    const readableStream = new ReadableStream<StreamResponseChunk>({
        async start(controller) {
            let content = "";
            let thinking = "";
            for await (const chunk of response) {
                thinking += chunk.message?.thinking ?? "";
                content += chunk.message?.content ?? "";
                controller.enqueue({
                    "0": formatThinkingOutput(thinking, content),
                });
            }
            controller.close();
        },
    });

    return {
        type: "streaming",
        result: readableStream,
        model: arg.aiModel,
    };
}

async function requestCohere(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const formated = arg.formated;
    const db = arg.ctx.db;
    const aiModel = arg.aiModel;

    let lastChatPrompt = "";
    let preamble = "";

    let lastChat = formated[formated.length - 1];
    if (lastChat.role === "user") {
        lastChatPrompt = lastChat.content;
        formated.pop();
    } else {
        while (lastChat.role !== "user") {
            lastChat = formated.pop()!;
            if (!lastChat) {
                return {
                    type: "fail",
                    result: "Cohere requires a user message to generate a response",
                };
            }
            lastChatPrompt =
                (lastChat.role === "user" ? "" : `${lastChat.role}: `) + "\n" + lastChat.content + lastChatPrompt;
        }
    }

    const firstChat = formated[0];
    if (firstChat.role === "system") {
        preamble = firstChat.content;
        formated.shift();
    }

    //reformat chat

    let body = applyParameters(
        {
            message: lastChatPrompt,
            chat_history: formated
                .map((v) => {
                    if (v.role === "assistant") {
                        return {
                            role: "CHATBOT",
                            message: v.content,
                        };
                    }
                    if (v.role === "system") {
                        return {
                            role: "SYSTEM",
                            message: v.content,
                        };
                    }
                    if (v.role === "user") {
                        return {
                            role: "USER",
                            message: v.content,
                        };
                    }
                    return null;
                })
                .filter((v) => v !== null)
                .filter((v) => {
                    return v.message;
                }),
        },
        ["temperature", "top_k", "top_p", "presence_penalty", "frequency_penalty"],
        {
            top_k: "k",
            top_p: "p",
        },
        {
            modelId: arg.aiModel,
        },
        arg.ctx.db,
    );

    if (aiModel !== "cohere-command-r-03-2024" && aiModel !== "cohere-command-r-plus-04-2024") {
        body.safety_mode = "NONE";
    }

    if (preamble) {
        if (body.chat_history.length > 0) {
            body.preamble = preamble;
        } else {
            body.message = `system: ${preamble}`;
        }
    }

    let headers: Record<string, string> = {
        Authorization: "Bearer " + (arg.key ?? defaultCredentialKey(aiModel, db.cohereAPIKey)),
        "Content-Type": "application/json",
    };

    body = applyAdditionalParameters(body, headers, getAdditionalParameters(arg.ctx.db, arg.aiModel));

    if (arg.previewBody) {
        return {
            type: "success",
            result: JSON.stringify({
                url: arg.customURL ?? "https://api.cohere.com/v1/chat",
                body: body,
                headers: headers,
            }),
        };
    }

    const res = await arg.ctx.transport.fetchBuffered(arg.customURL ?? "https://api.cohere.com/v1/chat", {
        method: "POST",
        headers: headers,
        body: body,
        abortSignal: arg.abortSignal,
    });

    if (!res.ok) {
        return {
            type: "fail",
            result: JSON.stringify(res.data),
        };
    }

    const result = res?.data?.text;
    if (!result) {
        return {
            type: "fail",
            result: JSON.stringify(res.data),
        };
    }

    return {
        type: "success",
        result: result,
    };
}

async function requestHorde(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const formated = arg.formated;
    const db = arg.ctx.db;
    const aiModel = arg.aiModel;
    const abortSignal = arg.abortSignal;

    if (arg.previewBody) {
        return {
            type: "success",
            result: JSON.stringify({
                error: "Preview body is not supported for Horde",
            }),
        };
    }

    const prompt = applyChatTemplate(formated, arg.ctx);

    const realModel = aiModel.split(":::")[1];

    const argument = {
        prompt: prompt,
        params: {
            n: 1,
            max_context_length: db.maxContext + 100,
            max_length: db.maxResponse,
            singleline: false,
            temperature: db.temperature / 100,
            top_k: db.top_k,
            top_p: db.top_p,
        },
        trusted_workers: false,
        workerslow_workers: true,
        _blacklist: false,
        dry_run: false,
        models: [realModel, realModel.trim(), " " + realModel, realModel + " "],
    };

    if (realModel === "auto") {
        delete (argument as { models?: string[] }).models;
    }

    let apiKey = "0000000000";
    if (db.hordeConfig.apiKey.length > 2) {
        apiKey = db.hordeConfig.apiKey;
    }
    apiKey = arg.key ?? defaultCredentialKey(aiModel, apiKey);

    let headers: Record<string, string> = {
        "content-type": "application/json",
        apikey: apiKey,
    };

    let finalBody = applyAdditionalParameters(argument, headers, getAdditionalParameters(arg.ctx.db, arg.aiModel));

    const hook = arg.ctx.firstByte;
    /**
     * The first byte of Horde's answer: Horde answers only in a response that ends the request (a
     * refused submit, an impossible or finished poll, or one whose body cannot be read as such), so
     * a response whose role its body decides keeps its first chunk's time (the layer's clock) and
     * reports it once that body ended the request. Nothing is reported for a body that failed
     * before its first chunk, nor after the request ended while it was being read (cancelled).
     */
    const watchHorde = (response: Response) => deferFirstByte(response, hook);

    const submitResponse = await fetch("https://stablehorde.net/api/v2/generate/text/async", {
        body: JSON.stringify(finalBody),
        method: "POST",
        headers: headers,
        signal: abortSignal,
    });

    if (submitResponse.status !== 202) {
        // A refused submit is the answer from its first chunk on.
        const refused = hook ? watchFirstByte(submitResponse, () => hook.mark()) : submitResponse;
        return {
            type: "fail",
            result: await refused.text(),
        };
    }

    const submitted = watchHorde(submitResponse);
    let json: {
        id: string;
        kudos: number;
        message: string;
    };
    let warnMessage = "";
    try {
        json = (await submitted.response.json()) as any;
        if (json.message) {
            warnMessage = "with " + json.message;
        }
        // The poll URL is built from it: an id that is not one ends the request here, with its answer.
        if (typeof json.id !== "string" || json.id === "") {
            throw new Error("Horde did not return a request id");
        }
    } catch (error) {
        // An accepted submit whose body cannot be read ends the request.
        submitted.answered();
        throw error;
    }

    // The client polls until Horde answers; here a request that ended (the client went away, the
    // server shuts down) stops polling.
    while (true) {
        await sleep(2000, arg.ctx.signal);
        if (arg.ctx.signal.aborted) {
            return {
                type: "fail",
                result: "Aborted",
            };
        }
        const poll = watchHorde(
            await fetch("https://stablehorde.net/api/v2/generate/text/status/" + json.id, { signal: arg.ctx.signal }),
        );
        try {
            const data: any = await poll.response.json();
            if (!data.is_possible) {
                poll.answered();
                // Fire and forget, as the client does; a failure must not become an unhandled rejection here.
                fetch("https://stablehorde.net/api/v2/generate/text/status/" + json.id, {
                    method: "DELETE",
                }).catch(() => {});
                return {
                    type: "fail",
                    result: "Response not possible" + warnMessage,
                    noRetry: true,
                };
            }
            if (data.done && Array.isArray(data.generations) && data.generations.length > 0) {
                poll.answered();
                const generations: { text: string }[] = data.generations;
                if (generations && generations.length > 0) {
                    return {
                        type: "success",
                        result: unstringlizeChat(
                            generations[0].text ?? "",
                            formated,
                            arg.ctx,
                            arg.ctx.selectedCharacterName ?? "",
                        ),
                    };
                }
                return {
                    type: "fail",
                    result: "No Generations when done",
                    noRetry: true,
                };
            }
        } catch (error) {
            // A poll whose body cannot be read or interpreted ends the request.
            poll.answered();
            throw error;
        }
    }
}

export interface KoboldSamplerSettingsSchema {
    rep_pen?: number;
    rep_pen_range?: number;
    rep_pen_slope?: number;
    top_k?: number;
    top_a?: number;
    top_p?: number;
    tfs?: number;
    typical?: number;
    temperature?: number;
}

export interface KoboldGenerationInputSchema extends KoboldSamplerSettingsSchema {
    prompt: string;
    use_memory?: boolean;
    use_story?: boolean;
    use_authors_note?: boolean;
    use_world_info?: boolean;
    use_userscripts?: boolean;
    soft_prompt?: string;
    max_length?: number;
    max_context_length?: number;
    n: number;
    disable_output_formatting?: boolean;
    frmttriminc?: boolean;
    frmtrmblln?: boolean;
    frmtrmspch?: boolean;
    singleline?: boolean;
    disable_input_formatting?: boolean;
    frmtadsnsp?: boolean;
    quiet?: boolean;
    sampler_order?: number[];
    sampler_seed?: number;
    sampler_full_determinism?: boolean;
}
