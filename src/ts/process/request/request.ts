import { type ClientCharacter, characterList, selectedCharacter } from "../../storage/characterStore.svelte";
import {
    settings,
    activeMainProfile,
    resolveModelSlot,
    activePreset,
    missingScopeTarget,
    scopedPresetRoot,
    activeModelPreset,
    type PresetScope,
} from "../../storage/settingsViews.svelte";
import { plainClone, presetFieldValue } from "../../../../shared/presets.ts";
import { credentialFor } from "../../model/credentials";
import { language } from "../../../lang";
import { getModelInfo, LLMFlags, LLMFormat, type LLMModel } from "../../model/modellist";
import { risuEscape, risuUnescape } from "../../parser/parser.svelte";
import { capturePluginContext, invokeHook, type PluginCallContext } from "../../plugins/apiV3/pluginContext";
import { pluginHooks } from "../../plugins/pluginHooks";
import { type character, type ModelProfile } from "../../storage/database.svelte";
import { type ChatRef, chatEntry, chatOwnerToken, ensureChatLoaded, pinChat } from "../../storage/chatStore.svelte";
import {
    chatBinding,
    chatBindingProblems,
    chatBindingRefusalText,
    chatContextIds,
    type ChatContextIds,
} from "../../storage/chatBinding.svelte";
import { activeChannelCallTargets } from "../../network/channelCallSource";
import { getUserName, sleep } from "../../util";
import type { OpenAIChat } from "../index.svelte";
import { getTools } from "../mcp/mcp";
import type { MCPTool } from "../mcp/mcplib";
import { unstringlizeChat } from "../stringlize";
import { applyChatTemplate } from "../templates/chatTemplate";
import { runTransformers } from "../transformers";
import { applyAdditionalParameters, applyParameters, getAdditionalParameters, type ModelModeExtended } from "./shared";
import { requestServer } from "./transport";

export type ToolCall = {
    name: string;
    arguments: string;
};

interface requestDataArgument {
    formated: OpenAIChat[];
    bias: { [key: number]: number };
    biasString?: [string, number][];
    currentChar?: ClientCharacter;
    temperature?: number;
    maxTokens?: number;
    PresensePenalty?: number;
    frequencyPenalty?: number;
    useStreaming?: boolean;
    forceStreaming?: boolean;
    isGroupChat?: boolean;
    useEmotion?: boolean;
    continue?: boolean;
    chatId?: string;
    /** The chat the request is for (request triggers run on it; default: the selected chat). */
    chatRef?: ChatRef | null;
    /**
     * The plugin call context the request's replacers and plugin provider get: the caller's (a send's,
     * or a plugin hook's own), else `requestChatData` captures one from `chatRef` at its start.
     */
    pluginContext?: PluginCallContext;
    /**
     * The owner lifetime of the request's chat when the request began (`chatOwnerToken`; set by
     * `requestChatData`): every later stage, the transport included, refuses a chat replaced meanwhile.
     */
    chatOwner?: string;
    noMultiGen?: boolean;
    schema?: string;
    extractJson?: string;
    imageResponse?: boolean;
    previewBody?: boolean;
    staticModel?: string;
    /** A model profile the request runs on instead of its mode's slot (`RequestArgs.profileId`). */
    profileId?: string;
    /**
     * The ids a request without a chat runs with, captured by a caller that sends several requests as
     * one run (the tab's translator pipeline, `docs/plan/translation.md` slice 3.1), so a selection
     * change between them does not move the later ones. A captured preset that is gone refuses the
     * request, as a plugin context's does. Without it a request without a chat reads the settings
     * views at its start; a request with a chat (its `chatRef` or plugin context) never reads it.
     */
    requestIds?: ChatContextIds;
    escape?: boolean;
    tools?: MCPTool[];
    rememberToolUsage?: boolean;
    blockPlugins?: boolean;
}

export interface RequestDataArgumentExtended extends requestDataArgument {
    aiModel?: string;
    multiGen?: boolean;
    abortSignal?: AbortSignal;
    modelInfo?: LLMModel;
    /** Detached slot profile; undefined uses schema defaults for a bare/static request. */
    modelProfile?: ModelProfile;
    customURL?: string;
    mode?: ModelModeExtended;
    key?: string;
    additionalOutput?: string;
    saveSignatures?: boolean;
    /**
     * The presets the request runs with (set by `requestChatDataMain`): its plugin context's, else
     * the settings views' (a request without a chat, decision 10 of `docs/plan/chat-binding.md`).
     */
    presetScope?: PresetScope;
}

export type requestDataResponse =
    | {
          type: "success" | "fail";
          result: string;
          noRetry?: boolean;
          special?: {
              emotion?: string;
          };
          failByServerError?: boolean;
          model?: string;
      }
    | {
          type: "streaming";
          result: ReadableStream<StreamResponseChunk>;
          special?: {
              emotion?: string;
          };
          model?: string;
      }
    | {
          type: "multiline";
          result: ["user" | "char", string][];
          special?: {
              emotion?: string;
          };
          model?: string;
      };

export interface StreamResponseChunk {
    [key: string]: string;
}

/**
 * Requests a reply for the tab (translation, suggestions, the HypaV3 modal, plugins). The request's
 * chat (its `chatRef`, else its plugin context's) is pinned and loaded from the start, before tool
 * discovery and the plugin hooks, until the request and its after-request hooks end (a streamed
 * reply keeps the transport's own pin until its stream ends). A chat that is gone fails the request.
 */
export async function requestChatData(
    arg: requestDataArgument,
    model: ModelModeExtended,
    abortSignal: AbortSignal = null,
): Promise<requestDataResponse> {
    // Before the chat is pinned, the tools are discovered, and any hook runs.
    const refusal = chatRequestRefusal(arg);
    if (refusal) {
        return refusal;
    }
    arg.pluginContext ??= capturePluginContext(arg.chatRef);
    const target = arg.chatRef ?? arg.pluginContext?.chatRef ?? null;
    arg.chatOwner ??= target ? chatOwnerToken(target.chaId) : undefined;
    return await withRequestChat(target, () => requestPinnedChatData(arg, model, abortSignal), arg.chatOwner);
}

/** Whether a request's chat is still the one it began with (listed, same owner); true without a chat. */
export function requestChatHeld(target: ChatRef | null | undefined, owner: string | undefined): boolean {
    return (
        !target || (chatEntry(target) !== undefined && (owner === undefined || chatOwnerToken(target.chaId) === owner))
    );
}

const sameChat = (a: ChatRef, b: ChatRef) => a.chaId === b.chaId && a.chatId === b.chatId;

const sameIds = (a: ChatContextIds, b: ChatContextIds) =>
    a.presetId === b.presetId && a.modelPresetId === b.modelPresetId && a.personaId === b.personaId;

/**
 * The send guard of a chat's request (`docs/plan/chat-binding.md`): a request for a chat (its
 * `chatRef`, else its plugin context's) runs on that chat's ids, never on the tab's selection.
 *
 * - Inside a callback of that chat's job, the ids are the job's (its `presetChain` pick included):
 *   a captured context must name them.
 * - Otherwise the chat's binding must be complete, and a captured context must name the binding as
 *   it is now (a chat rebound since the capture is refused, not run on the old ids).
 * - A `chatRef` and a plugin context naming two chats are refused.
 *
 * A chat that is not listed is refused as gone; a request without a chat is not checked
 * (decision 10). Checked at `requestChatData`'s start and again where a request enters
 * `requestChatDataMain` (a plugin's direct call, the tab-run models, after the hooks); the server
 * checks the requests it runs too.
 */
function chatRequestRefusal(arg: requestDataArgument): requestDataResponse | undefined {
    const context = arg.pluginContext;
    if (arg.chatRef && context && !sameChat(arg.chatRef, context.chatRef)) {
        return { type: "fail", noRetry: true, result: language.chatBinding.mismatch };
    }
    const target = arg.chatRef ?? context?.chatRef;
    if (!target) {
        return undefined;
    }
    const mismatch = (ids: ChatContextIds): requestDataResponse | undefined =>
        context && !sameIds(context, ids)
            ? { type: "fail", noRetry: true, result: language.chatBinding.mismatch }
            : undefined;
    const call = activeChannelCallTargets();
    if (call && sameChat(call.chatRef, target)) {
        return mismatch(call);
    }
    const binding = chatBinding(target);
    if (!binding) {
        // Not listed (deleted, or its character's chats replaced): nothing runs for it.
        return requestChatGone();
    }
    if (!binding.ok) {
        return { type: "fail", noRetry: true, result: chatBindingRefusalText(chatBindingProblems(binding)) };
    }
    return mismatch(chatContextIds(binding.ids));
}

const requestChatGone = (): requestDataResponse => ({
    type: "fail",
    result: "The chat this request is for no longer exists",
});

/** The presets a request captured: its plugin context's, else (without a chat) its `requestIds`. */
function capturedPresetScope(arg: requestDataArgument): PresetScope | undefined {
    if (arg.pluginContext) {
        return arg.pluginContext;
    }
    return arg.chatRef ? undefined : arg.requestIds;
}

/** A refusal of a request whose captured `scope` lost a preset, or `undefined` while both exist (or without a scope). */
function requestPresetGone(scope: PresetScope | undefined): requestDataResponse | undefined {
    const missing = scope ? missingScopeTarget(scope) : undefined;
    return missing ? { type: "fail", result: `The ${missing} this request runs with no longer exists` } : undefined;
}

/**
 * Runs a request of `target`'s chat with that chat pinned and loaded from the start until `run`
 * ends: a chat that is gone, could not be loaded, or was replaced meanwhile (even under the same
 * ids) fails the request instead. Without a target `run` runs as it is.
 */
export async function withRequestChat(
    target: ChatRef | null,
    run: () => Promise<requestDataResponse>,
    owner: string = target ? chatOwnerToken(target.chaId) : "",
): Promise<requestDataResponse> {
    if (!target) {
        return await run();
    }
    const release = pinChat(target);
    // A stream handed out keeps the chat pinned until it ends (`guardStream` releases it then).
    let handedOff = false;
    try {
        let loaded;
        try {
            loaded = await ensureChatLoaded(target);
        } catch (error) {
            return {
                type: "fail",
                result: `The chat could not be loaded: ${error instanceof Error ? error.message : error}`,
            };
        }
        if (!loaded || chatOwnerToken(target.chaId) !== owner) {
            return requestChatGone();
        }
        const result = await run();
        if (!requestChatHeld(target, owner)) {
            // Its chat was deleted or replaced while the reply came: the reply is not accepted.
            if (result.type === "streaming") {
                result.result.cancel().catch(() => {});
            }
            return requestChatGone();
        }
        if (result.type === "streaming") {
            handedOff = true;
            return { ...result, result: guardStream(result.result, target, owner, release) };
        }
        return result;
    } finally {
        if (!handedOff) {
            release();
        }
    }
}

/**
 * A streamed reply that is accepted only while its request's chat is the one it began with: a chunk
 * or the end after the chat was deleted or replaced errors the stream (and cancels the source). The
 * chat stays pinned until the stream ends, fails, or is cancelled (`release`).
 */
function guardStream<T>(
    source: ReadableStream<T>,
    target: ChatRef,
    owner: string,
    release: () => void,
): ReadableStream<T> {
    const reader = source.getReader();
    let done = false;
    const finish = () => {
        if (!done) {
            done = true;
            release();
        }
    };
    return new ReadableStream<T>({
        async pull(controller) {
            try {
                const { done: ended, value } = await reader.read();
                if (!requestChatHeld(target, owner)) {
                    reader.cancel().catch(() => {});
                    controller.error(new Error("The chat this request is for no longer exists"));
                    finish();
                    return;
                }
                if (ended) {
                    controller.close();
                    finish();
                    return;
                }
                controller.enqueue(value);
            } catch (error) {
                controller.error(error);
                finish();
            }
        },
        cancel(reason) {
            finish();
            return reader.cancel(reason);
        },
    });
}

async function requestPinnedChatData(
    arg: requestDataArgument,
    model: ModelModeExtended,
    abortSignal: AbortSignal,
): Promise<requestDataResponse> {
    const pluginContext = arg.pluginContext;
    // The request's captured presets (its plugin context's, else a chatless caller's `requestIds`),
    // else the selected ones. A captured preset that is gone refuses the request, here and before
    // every attempt below.
    const capturedScope = capturedPresetScope(arg);
    const presetGone = requestPresetGone(capturedScope);
    if (presetGone) {
        return presetGone;
    }
    // The request's chat chooses the module MCP servers, not the selection now. After every await
    // below, the chat must still be the one the request began with.
    const target = arg.chatRef ?? pluginContext?.chatRef;
    const held = () => requestChatHeld(target, arg.chatOwner);
    const tools = arg.tools ?? (await getTools(target));
    if (!held()) {
        return requestChatGone();
    }
    let da: requestDataResponse;
    let trys = 0;

    if (arg.escape) {
        arg.useStreaming = false;
        console.warn("Escape is enabled, disabling streaming");
    }

    arg.formated = safeStructuredClone(arg.formated).map((m) => {
        m.content = risuUnescape(m.content);
        return m;
    });

    while (true) {
        if (abortSignal?.aborted) {
            return {
                type: "fail",
                result: "Aborted",
            };
        }
        if (!held()) {
            // Each attempt (a retry after a wait too) starts only for the chat the request began with.
            return requestChatGone();
        }
        const goneBefore = requestPresetGone(capturedScope);
        if (goneBefore) {
            return goneBefore;
        }

        if (pluginHooks.replacerbeforeRequest.size > 0) {
            for (const replacer of pluginHooks.replacerbeforeRequest) {
                arg.formated = await invokeHook(replacer, pluginContext, arg.formated, model);
                if (!held()) {
                    return requestChatGone();
                }
            }
            const goneAfterHooks = requestPresetGone(capturedScope);
            if (goneAfterHooks) {
                return goneAfterHooks;
            }
        }

        // The character's `request` trigger runs only in server jobs (Phase 5 cutover): the tab's own
        // requests (translation, suggestions, the HypaV3 modal, plugins) go out without it.
        da = await requestChatDataMain(
            {
                ...arg,
                tools: tools,
            },
            model,
            abortSignal,
        );

        if (abortSignal?.aborted) {
            return {
                type: "fail",
                result: "Aborted",
            };
        }
        if (!held()) {
            // Its chat was replaced or deleted while the reply came: the reply is not accepted.
            if (da.type === "streaming") {
                da.result.cancel().catch(() => {});
            }
            return requestChatGone();
        }

        if (da.type === "success" && arg.escape) {
            da.result = risuEscape(da.result);
        }

        if (da.type === "success" && pluginHooks.replacerafterRequest.size > 0) {
            for (const replacer of pluginHooks.replacerafterRequest) {
                da.result = await invokeHook(replacer, pluginContext, da.result, model);
                if (!held()) {
                    return requestChatGone();
                }
            }
        }

        if (da.type === "success" && settings.providers.banCharacterset?.length > 0) {
            let failed = false;
            for (const set of settings.providers.banCharacterset) {
                console.log(set);
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

        if (da.type !== "fail" || da.noRetry) {
            return da;
        }

        if (da.failByServerError) {
            await sleep(1000);
            if (settings.providers.antiServerOverloads) {
                trys -= 0.5; // reduce trys by 0.5, so that it will retry twice as much
            }
        }

        trys += 1;
        if (trys > settings.providers.requestRetrys) {
            return da;
        }
    }
}

export function reformater(
    formated: OpenAIChat[],
    modelInfo: LLMModel | LLMFlags[],
    profile: Pick<ModelProfile, "systemContentReplacement" | "systemRoleReplacement"> = activeMainProfile,
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
                formated[i].content = profile.systemContentReplacement
                    ? profile.systemContentReplacement.replace("{{slot}}", formated[i].content)
                    : `system: ${formated[i].content}`;
                formated[i].role = profile.systemRoleReplacement || "user";
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
                    newFormated[newFormated.length - 1].multimodals.push(...m.multimodals);
                }

                if (m.thoughts) {
                    if (!newFormated[newFormated.length - 1].thoughts) {
                        newFormated[newFormated.length - 1].thoughts = [];
                    }
                    newFormated[newFormated.length - 1].thoughts.push(...m.thoughts);
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

export async function requestChatDataMain(
    arg: requestDataArgument,
    model: ModelModeExtended,
    abortSignal: AbortSignal = null,
): Promise<requestDataResponse> {
    // A chat's request decides its model with the chat's ids, also when the caller captured none.
    if (arg.chatRef && !arg.pluginContext) {
        arg.pluginContext = capturePluginContext(arg.chatRef);
    }
    const refusal = chatRequestRefusal(arg);
    if (refusal) {
        return refusal;
    }
    // The server transport sends the caller's arguments as they are; the defaults below mutate `arg`.
    const original = { ...arg };
    const targ: RequestDataArgumentExtended = arg;

    // Model decisions follow the request's captured presets (its plugin context), else the settings
    // views (a request without a chat, decision 10 of `docs/plan/chat-binding.md`: what the screen
    // shows, the selected chat's bound presets where they exist, else the tab's selection), read once
    // now, so the tab routes and tokenizes with the model preset whose id the server receives
    // (`requestServer` reads the same ids). A bare scope: a chatless request carries no `chatRef`.
    const scope: PresetScope = capturedPresetScope(arg) ?? {
        presetId: activePreset.id ?? "",
        modelPresetId: activeModelPreset.id ?? "",
    };
    targ.presetScope = scope;
    const presetGone = requestPresetGone(scope);
    if (presetGone) {
        return presetGone;
    }
    const resolved = resolveModelSlot(model, scope, arg.staticModel, arg.profileId);
    if (resolved.kind === "refused") {
        return {
            type: "fail",
            noRetry: true,
            result:
                resolved.reason === "missingNamedProfile"
                    ? language.modelProfiles.missingNamedRequest
                    : resolved.reason === "missingProfile"
                      ? language.modelProfiles.missingRequest(
                            model === "model"
                                ? language.model
                                : model === "submodel"
                                  ? language.submodel
                                  : language.modelProfiles.auxModes[model],
                        )
                      : language.modelProfiles.requiredRequest(resolved.modelId!),
        };
    }
    targ.aiModel = resolved.modelId;
    targ.modelProfile = resolved.kind === "profile" ? plainClone(resolved.profile) : undefined;
    targ.modelInfo = safeStructuredClone(getModelInfo(targ.aiModel, scope, targ.modelProfile ?? null));

    if (arg.blockPlugins && targ.modelInfo.id.startsWith("pluginmodel:::")) {
        return {
            type: "fail",
            result: "Plugin calls are blocked by the caller.",
        };
    }

    // Phase 5: every format but the two that run in this tab goes to the server
    // (`POST /api/llm/request`), which reads the settings and credentials itself.
    if (targ.modelInfo.format !== LLMFormat.Plugin && targ.modelInfo.format !== LLMFormat.WebLLM) {
        return requestServer(original, model, abortSignal, targ.modelInfo);
    }

    const credential = credentialFor(targ.modelProfile, targ.aiModel);
    if (credential.state === "refused") {
        return { type: "fail", noRetry: true, result: language.sharedApiKeys.refused[credential.reason] };
    }

    targ.formated = safeStructuredClone(arg.formated);
    targ.maxTokens = arg.maxTokens ?? (scopedPresetRoot(scope, "maxResponse") as number);
    targ.temperature = arg.temperature ?? (scopedPresetRoot(scope, "temperature") as number) / 100;
    targ.bias = arg.bias;
    targ.currentChar = arg.currentChar;
    targ.useStreaming = arg.forceStreaming ? true : settings.providers.useStreaming && arg.useStreaming;
    targ.continue = arg.continue ?? false;
    targ.biasString = arg.biasString ?? [];
    targ.multiGen =
        settings.providers.genTime > 1 && targ.aiModel.startsWith("gpt") && !arg.continue && !arg.noMultiGen;
    targ.abortSignal = abortSignal;
    targ.mode = model;
    targ.extractJson = arg.extractJson ?? (scopedPresetRoot(scope, "extractJson") as string);

    const format = targ.modelInfo.format;

    targ.formated = reformater(targ.formated, targ.modelInfo, {
        systemContentReplacement: presetFieldValue(targ.modelProfile, "systemContentReplacement") as string,
        systemRoleReplacement: presetFieldValue(
            targ.modelProfile,
            "systemRoleReplacement",
        ) as ModelProfile["systemRoleReplacement"],
    });

    switch (format) {
        case LLMFormat.Plugin:
            return requestPlugin(targ);
        case LLMFormat.WebLLM:
            return requestWebLLM(targ);
    }

    return {
        type: "fail",
        result: language.errors.unknownModel,
    };
}

async function requestPlugin(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const isV3Model = arg.aiModel.startsWith("pluginmodel:::");
    const responseModel = isV3Model ? arg.aiModel : "custom";
    try {
        const formated = arg.formated;
        const maxTokens = arg.maxTokens;
        const model = isV3Model
            ? arg.aiModel.replace("pluginmodel:::", "")
            : (presetFieldValue(arg.modelProfile, "currentPluginProvider") as string);
        const providerFunction = pluginHooks.providers.get(model);

        if (arg.previewBody) {
            return {
                type: "success",
                result: JSON.stringify({
                    error: "Plugin is not supported in preview mode",
                }),
            };
        }

        const d = providerFunction
            ? await invokeHook(
                  providerFunction,
                  arg.pluginContext ?? capturePluginContext(arg.chatRef),
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
                          scope: arg.presetScope,
                      },
                  ) as any,
                  arg.abortSignal,
              )
            : {
                  success: false,
                  content: language.pluginProviderNotFound,
              };

        if (!d) {
            return {
                type: "fail",
                result: language.errors.unknownModel,
                model: responseModel,
            };
        } else if (!d.success) {
            return {
                type: "fail",
                result: d.content instanceof ReadableStream ? await new Response(d.content).text() : d.content,
                model: responseModel,
            };
        } else if (d.content instanceof ReadableStream) {
            let fullText = "";
            const piper = new TransformStream<string, StreamResponseChunk>({
                transform(chunk, control) {
                    fullText += chunk;
                    control.enqueue({
                        "0": fullText,
                    });
                },
            });

            return {
                type: "streaming",
                result: d.content.pipeThrough(piper),
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
        console.error(error);
        return {
            type: "fail",
            result:
                `Plugin Error from ${presetFieldValue(arg.modelProfile, "currentPluginProvider")}: ` +
                JSON.stringify(error),
            model: responseModel,
        };
    }
}

async function requestWebLLM(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const formated = arg.formated;
    const aiModel = arg.aiModel;
    // The names of the request's chat, read once now (the selected chat can change during the run):
    // its character and its persona (the captured context's), else the selected ones.
    const chatRef = arg.chatRef ?? arg.pluginContext?.chatRef;
    const currentChar = chatRef ? characterList().find((entry) => entry?.chaId === chatRef.chaId) : selectedCharacter();
    const characterName = currentChar?.name ?? "";
    const personaId = arg.pluginContext?.personaId ?? (chatRef ? undefined : arg.requestIds?.personaId);
    const userName =
        personaId !== undefined
            ? (settings.personas.find((persona) => persona?.id === personaId)?.name ?? "User")
            : getUserName();
    const maxTokens = arg.maxTokens;
    const temperature = arg.temperature;
    const realModel = aiModel.split(":::")[1];
    const prompt = applyChatTemplate(formated, { profile: arg.modelProfile ?? null, characterName, userName });

    if (arg.previewBody) {
        return {
            type: "success",
            result: JSON.stringify({
                error: "Preview body is not supported for WebLLM",
            }),
        };
    }
    const ooba = scopedPresetRoot(arg.presetScope, "ooba") as typeof activePreset.ooba;
    const transformersParams = {
        temperature: temperature,
        max_new_tokens: maxTokens,
        top_k: ooba.top_k,
        top_p: ooba.top_p,
        repetition_penalty: ooba.repetition_penalty,
        typical_p: ooba.typical_p,
    } as any;

    const finalParams = applyAdditionalParameters(transformersParams, {}, getAdditionalParameters(arg.aiModel));

    const v = await runTransformers(prompt, realModel, finalParams);
    return {
        type: "success",
        result: unstringlizeChat((v.generated_text as string) ?? "", formated, characterName, userName),
    };
}
