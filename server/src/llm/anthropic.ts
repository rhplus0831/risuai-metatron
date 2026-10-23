// Port of `src/ts/process/request/anthropic.ts` (the client's dependencies are `arg.ctx`'s).
import { randomUUID } from "node:crypto";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { LLMFlags, LLMFormat } from "../../../shared/llm.ts";
import { resolveClaudeThinkingType } from "../../../shared/llm/thinkingResolver.ts";
import { NANOGPT_MESSAGES_ENDPOINT } from "../../../shared/llm/providers/nanogpt.ts";
import { defaultCredentialKey } from "./credentials.ts";
import type { MultiModal } from "../../../shared/openai.ts";
import { deferFirstByte, textifyReadableStream } from "./transport.ts";
import { replaceAsync, simplifySchema, sleep } from "./util.ts";
import { extractJSON } from "./jsonSchema.ts";
import { SseLines } from "./sseLines.ts";
import type { RequestDataArgumentExtended, requestDataResponse, StreamResponseChunk } from "./request.ts";
import { applyAdditionalParameters, applyParameters, getAdditionalParameters } from "./shared.ts";

interface Claude3TextBlock {
    type: "text";
    text: string;
    cache_control?: {
        type: "ephemeral";
        ttl?: "5m" | "1h";
    };
}

interface Claude3ImageBlock {
    type: "image";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
    cache_control?: {
        type: "ephemeral";
        ttl?: "5m" | "1h";
    };
}

interface Claude3ToolUseBlock {
    type: "tool_use";
    id: string;
    name: string;
    input: any;
    cache_control?: {
        type: "ephemeral";
        ttl?: "5m" | "1h";
    };
}

interface Claude3ToolResponseBlock {
    type: "tool_result";
    tool_use_id: string;
    content: Claude3ContentBlock[];
    cache_control?: {
        type: "ephemeral";
        ttl?: "5m" | "1h";
    };
}

type Claude3ContentBlock = Claude3TextBlock | Claude3ImageBlock | Claude3ToolUseBlock | Claude3ToolResponseBlock;

interface Claude3Chat {
    role: "user" | "assistant";
    content: Claude3ContentBlock[];
}

interface Claude3ExtendedChat {
    role: "user" | "assistant";
    content: Claude3ContentBlock[] | string;
}

export async function requestClaude(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const formated = arg.formated;
    const db = arg.ctx.db;
    const aiModel = arg.aiModel;
    const useStreaming = arg.useStreaming;
    const nanogpt = aiModel === "nanogpt";
    const ollamaCloudAnthropic = aiModel === "ollama-cloud";
    // NanoGPT does not expose a subscription Messages endpoint.
    let replacerURL = nanogpt ? NANOGPT_MESSAGES_ENDPOINT : (arg.customURL ?? "https://api.anthropic.com/v1/messages");
    let apiKey = arg.key ?? defaultCredentialKey(aiModel, nanogpt ? db.nanogptKey : db.claudeAPIKey);
    const maxTokens = arg.maxTokens;
    if (aiModel === "reverse_proxy" && db.autofillRequestUrl) {
        if (replacerURL.endsWith("v1")) {
            replacerURL += "/messages";
        } else if (replacerURL.endsWith("v1/")) {
            replacerURL += "messages";
        } else if (!(replacerURL.endsWith("messages") || replacerURL.endsWith("messages/"))) {
            if (replacerURL.endsWith("/")) {
                replacerURL += "v1/messages";
            } else {
                replacerURL += "/v1/messages";
            }
        }
    }

    let claudeChat: Claude3Chat[] = [];
    let systemPrompt: string = "";

    const addClaudeChat = (
        chat: {
            role: "user" | "assistant";
            content: string;
            cache: boolean;
        },
        multimodals?: MultiModal[],
    ) => {
        if (claudeChat.length > 0 && claudeChat[claudeChat.length - 1].role === chat.role) {
            let content = claudeChat[claudeChat.length - 1].content;
            if (multimodals && multimodals.length > 0 && !Array.isArray(content)) {
                content = [
                    {
                        type: "text",
                        text: content,
                    },
                ];
            }

            if (Array.isArray(content)) {
                let lastContent = content[content.length - 1];
                if (lastContent?.type === "text") {
                    lastContent.text += "\n\n" + chat.content;
                    content[content.length - 1] = lastContent;
                } else {
                    content.push({
                        type: "text",
                        text: chat.content,
                    });
                }

                if (multimodals && multimodals.length > 0) {
                    for (const modal of multimodals) {
                        if (modal.type === "image") {
                            const dataurl = modal.base64;
                            const base64 = dataurl.split(",")[1];
                            const mediaType = dataurl.split(";")[0].split(":")[1];

                            content.unshift({
                                type: "image",
                                source: {
                                    type: "base64",
                                    media_type: mediaType,
                                    data: base64,
                                },
                            });
                        }
                    }
                }
            }
            if (chat.cache) {
                if (db.claude1HourCaching) {
                    content[content.length - 1].cache_control = {
                        type: "ephemeral",
                        ttl: "1h",
                    };
                } else {
                    content[content.length - 1].cache_control = {
                        type: "ephemeral",
                    };
                }
            }
            claudeChat[claudeChat.length - 1].content = content;
        } else {
            let formatedChat: Claude3Chat = {
                role: chat.role,
                content: [
                    {
                        type: "text",
                        text: chat.content,
                    },
                ],
            };
            if (multimodals && multimodals.length > 0) {
                formatedChat.content = [
                    {
                        type: "text",
                        text: chat.content,
                    },
                ];
                for (const modal of multimodals) {
                    if (modal.type === "image") {
                        const dataurl = modal.base64;
                        const base64 = dataurl.split(",")[1];
                        const mediaType = dataurl.split(";")[0].split(":")[1];

                        formatedChat.content.unshift({
                            type: "image",
                            source: {
                                type: "base64",
                                media_type: mediaType,
                                data: base64,
                            },
                        });
                    }
                }
            }
            if (chat.cache) {
                if (db.claude1HourCaching) {
                    formatedChat.content[0].cache_control = {
                        type: "ephemeral",
                        ttl: "1h",
                    };
                } else {
                    formatedChat.content[0].cache_control = {
                        type: "ephemeral",
                    };
                }
            }
            claudeChat.push(formatedChat);
        }
    };
    for (const chat of formated) {
        switch (chat.role) {
            case "user": {
                addClaudeChat(
                    {
                        role: "user",
                        content: chat.content,
                        cache: chat.cachePoint!,
                    },
                    chat.multimodals,
                );
                break;
            }
            case "assistant": {
                addClaudeChat(
                    {
                        role: "assistant",
                        content: chat.content,
                        cache: chat.cachePoint!,
                    },
                    chat.multimodals,
                );
                break;
            }
            case "system": {
                if (claudeChat.length === 0) {
                    systemPrompt += "\n\n" + chat.content;
                } else {
                    addClaudeChat({
                        role: "user",
                        content: "System: " + chat.content,
                        cache: chat.cachePoint!,
                    });
                }
                break;
            }
            case "function": {
                //ignore function for now
                break;
            }
        }
    }
    if (claudeChat.length === 0 && systemPrompt === "") {
        return {
            type: "fail",
            result: "No input",
        };
    }
    if (claudeChat.length === 0 && systemPrompt !== "") {
        claudeChat.push({
            role: "user",
            content: [
                {
                    type: "text",
                    text: "Start",
                },
            ],
        });
        systemPrompt = "";
    }
    if (claudeChat[0].role !== "user") {
        claudeChat.unshift({
            role: "user",
            content: [
                {
                    type: "text",
                    text: "Start",
                },
            ],
        });
    }

    //check for tool calls
    for (let j = 0; j < claudeChat.length; j++) {
        let chat = claudeChat[j];
        for (let i = 0; i < chat.content.length; i++) {
            let content = chat.content[i];
            if (content.type === "text") {
                content.text = await replaceAsync(
                    content.text,
                    /<tool_call>(.*?)<\/tool_call>/g,
                    async (match: string, p1: string) => {
                        try {
                            const parsed = await arg.ctx.tools.decode(p1);
                            if (parsed?.call && parsed?.response) {
                                const toolUse: Claude3ToolUseBlock = {
                                    type: "tool_use",
                                    id: parsed.call.id,
                                    name: parsed.call.name,
                                    input: parsed.call.arg,
                                };
                                const toolResponse: Claude3ToolResponseBlock = {
                                    type: "tool_result",
                                    tool_use_id: parsed.call.id,
                                    content: parsed.response.map((v: any) => {
                                        if (v.type === "text") {
                                            return {
                                                type: "text",
                                                text: v.text,
                                            };
                                        }
                                        if (v.type === "image") {
                                            return {
                                                type: "image",
                                                source: {
                                                    type: "base64",
                                                    media_type: v.mimeType,
                                                    data: v.data,
                                                },
                                            };
                                        }
                                        return {
                                            type: "text",
                                            text: `Unsupported tool response type: ${v.type}`,
                                        };
                                    }),
                                };
                                claudeChat.splice(j, 0, {
                                    role: "assistant",
                                    content: [toolUse],
                                });

                                claudeChat.splice(j + 1, 0, {
                                    role: "user",
                                    content: [toolResponse],
                                });
                                j += 2;
                                chat = claudeChat[j];
                                return "";
                            }
                        } catch (error) {}

                        return "";
                    },
                );
            }
        }
    }

    let finalChat: Claude3ExtendedChat[] = claudeChat;

    if (aiModel === "reverse_proxy") {
        finalChat = claudeChat.map((v): any => {
            if (v.content.length > 0 && v.content[0].type === "text") {
                return {
                    role: v.role,
                    content: v.content[0].text,
                };
            }
        });
    }

    let body = applyParameters(
        {
            model: nanogpt ? db.nanogptRequestModel || arg.modelInfo.internalID : arg.modelInfo.internalID,
            messages: finalChat,
            system: systemPrompt.trim(),
            max_tokens: maxTokens,
            stream: useStreaming ?? false,
        },
        arg.modelInfo.parameters,
        {
            thinking_tokens: "thinking.budget_tokens",
        },
        {
            modelId: arg.modelInfo.id,
        },
        arg.ctx.db,
    );

    // Handle thinking mode: off, adaptive, or budget
    const thinkingType = resolveClaudeThinkingType(arg.modelInfo.flags, db.thinkingType);
    if (thinkingType === "off") {
        if (arg.modelInfo.flags.includes(LLMFlags.claudeThinkingOnByDefault)) {
            body.thinking = { type: "disabled" };
        } else {
            delete body.thinking;
        }
    } else if (thinkingType === "adaptive" && arg.modelInfo.flags.includes(LLMFlags.claudeAdaptiveThinking)) {
        // Adaptive thinking mode
        delete body.thinking;
        body.thinking = { type: "adaptive", display: "summarized" };
        let effort = db.adaptiveThinkingEffort ?? "high";
        if (effort === "xhigh" && !arg.modelInfo.flags.includes(LLMFlags.claudeXHighEffort)) {
            effort = "high";
        }
        body.output_config = { effort };
    } else if (body?.thinking?.budget_tokens === 0) {
        delete body.thinking;
    } else if (body?.thinking?.budget_tokens && body?.thinking?.budget_tokens > 0) {
        body.thinking.type = "enabled";
        body.thinking.display = "summarized";
    } else if (body?.thinking?.budget_tokens === null) {
        delete body.thinking;
    }

    // `body.system` is the trimmed prompt: a whitespace-only one would be sent as `""`, which the API refuses.
    if (systemPrompt.trim() === "") {
        delete body.system;
    }

    const bedrock = arg.modelInfo.format === LLMFormat.AWSBedrockClaude;
    const additionalParams = getAdditionalParameters(arg.ctx.db, aiModel);
    const hasCustomAnthropicBeta = additionalParams.some(([key]) => {
        return key.startsWith("header::") && key.slice("header::".length).toLocaleLowerCase() === "anthropic-beta";
    });

    if (bedrock && aiModel !== "reverse_proxy") {
        function getCredentialParts(key: string) {
            const [accessKeyId, secretAccessKey, region] = key.split(":");

            if (!accessKeyId || !secretAccessKey || !region) {
                throw new Error("The key assigned to this request is invalid.");
            }

            return { accessKeyId, secretAccessKey, region };
        }
        const { accessKeyId, secretAccessKey, region } = getCredentialParts(apiKey);

        const AMZ_HOST = "bedrock-runtime.%REGION%.amazonaws.com";
        const host = AMZ_HOST.replace("%REGION%", region);
        const stream = false; // todo?

        // https://docs.claude.com/en/api/claude-on-amazon-bedrock#global-vs-regional-endpoints
        let useGlobal = false;

        const datePart = Number(arg.modelInfo.internalID!.match(/(\d{8})/)?.[0]);
        const versionMatch = arg.modelInfo.internalID!.match(/claude-(?:opus-|sonnet-|haiku-)?(\d+)-(\d+)/);

        if (datePart && !isNaN(datePart)) {
            useGlobal = datePart >= 20250929;
        } else if (versionMatch) {
            const majorVersion = Number(versionMatch[1]);
            const minorVersion = Number(versionMatch[2]);
            useGlobal = majorVersion > 4 || (majorVersion === 4 && minorVersion >= 5);
        }

        const awsModel = useGlobal ? "global." + arg.modelInfo.internalID : "us." + arg.modelInfo.internalID;

        const url = `https://${host}/model/${awsModel}/invoke${stream ? "-with-response-stream" : ""}`;

        let params = { ...body };
        params.anthropic_version = "bedrock-2023-05-31";
        delete params.model;
        delete params.stream;
        if (params.thinking?.type === "enabled" || params.thinking?.type === "adaptive") {
            params.temperature = 1.0;
            delete params.top_k;
            delete params.top_p;
        }

        let bedrockHeaders: Record<string, string> = {
            ["Host"]: host,
            ["Content-Type"]: "application/json",
            ["accept"]: "application/json",
        };

        if (additionalParams.length > 0) {
            params = applyAdditionalParameters(params, bedrockHeaders, additionalParams);
        }

        const rq = new HttpRequest({
            method: "POST",
            protocol: "https:",
            hostname: host,
            path: `/model/${awsModel}/invoke${stream ? "-with-response-stream" : ""}`,
            headers: bedrockHeaders,
            body: JSON.stringify(params),
        });

        const signer = new SignatureV4({
            sha256: Sha256,
            credentials: { accessKeyId, secretAccessKey },
            region,
            service: "bedrock",
        });

        const signed = await signer.sign(rq);

        if (arg.previewBody) {
            return {
                type: "success",
                result: JSON.stringify({
                    url: url,
                    body: params,
                    headers: signed.headers,
                }),
            };
        }

        const res = await arg.ctx.transport.fetchBuffered(url, {
            method: "POST",
            body: params,
            headers: signed.headers,
            plainFetchForce: true,
            chatId: arg.chatId,
            interceptor: "anthropic_bedrock",
        });

        if (!res.ok) {
            return {
                type: "fail",
                result: JSON.stringify(res.data),
            };
        }
        if (res.data.error) {
            return {
                type: "fail",
                result: JSON.stringify(res.data.error),
            };
        }
        const contents = res?.data?.content;
        if (!contents || contents.length === 0) {
            return {
                type: "fail",
                result: JSON.stringify(res.data),
            };
        }
        let resText = "";
        let thinking = false;
        for (const content of contents) {
            if (content.type === "text") {
                if (thinking) {
                    resText += "</Thoughts>\n\n";
                    thinking = false;
                }
                resText += content.text;
            }
            if (content.type === "thinking") {
                if (!thinking) {
                    resText += "<Thoughts>\n";
                    thinking = true;
                }
                resText += content.thinking ?? "";
            }
            if (content.type === "redacted_thinking") {
                if (!thinking) {
                    resText += "<Thoughts>\n";
                    thinking = true;
                }
                resText += "\n{{redacted_thinking}}\n";
            }
        }

        if (thinking) {
            resText += "</Thoughts>\n\n";
        }

        if (arg.extractJson && db.jsonSchemaEnabled) {
            return {
                type: "success",
                result: await extractJSON(resText, db.jsonSchema, arg.ctx),
            };
        }
        return {
            type: "success",
            result: resText,
        };
    }

    let headers: {
        [key: string]: string;
    } = {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        accept: "application/json",
    };

    if (ollamaCloudAnthropic) {
        headers["Authorization"] = "Bearer " + apiKey;
        delete headers["x-api-key"];
    }

    if (nanogpt && db.nanogptProvider) {
        headers["X-Provider"] = db.nanogptProvider;
    }

    if (db.usePlainFetch) {
        headers["anthropic-dangerous-direct-browser-access"] = "true";
    }

    if (arg.tools && arg.tools.length > 0) {
        body.tools = arg.tools.map((v) => {
            return {
                name: v.name,
                description: v.description,
                input_schema: simplifySchema(v.inputSchema),
            };
        });
    }

    if (additionalParams.length > 0) {
        body = applyAdditionalParameters(body, headers, additionalParams);
    }

    let betas: string[] = [];

    if (body.max_tokens > 8192) {
        betas.push("output-128k-2025-02-19");
    }

    if (db.claude1HourCaching) {
        betas.push("extended-cache-ttl-2025-04-11");
    }

    if (betas.length > 0 && !hasCustomAnthropicBeta) {
        headers["anthropic-beta"] = betas.join(",");
    }

    if (arg.previewBody) {
        return {
            type: "success",
            result: JSON.stringify({
                url: replacerURL,
                body: body,
                headers: headers,
            }),
        };
    }

    if (db.claudeBatching && !ollamaCloudAnthropic && !nanogpt) {
        if (body.stream !== undefined) {
            delete body.stream;
        }
        const id = randomUUID();
        const batchRequestUrl = replacerURL + "/batches";
        const batchRequestBody = {
            requests: [
                {
                    custom_id: id,
                    params: body,
                },
            ],
        };

        const resp = await arg.ctx.transport.fetchStream(batchRequestUrl, {
            body: JSON.stringify(batchRequestBody),
            method: "POST",
            signal: arg.abortSignal,
            headers: headers,
            interceptor: "anthropic_batching",
            logFetch: false,
            // The acknowledgement is not the answer: the request's first byte is the results'.
            firstByte: false,
        });
        // ...unless the submit ends the request: then its first byte is the answer's.
        const submitted = deferFirstByte(resp, arg.ctx.firstByte);

        if (resp.status !== 200) {
            let responseText: string;
            try {
                responseText = await textifyReadableStream(submitted.response.body!);
            } catch (error) {
                arg.ctx.transport.addLog({
                    body: batchRequestBody,
                    headers: headers,
                    response: `The refused batch's answer could not be read: ${error instanceof Error ? error.message : String(error)}`,
                    success: false,
                    url: batchRequestUrl,
                    chatId: arg.chatId,
                    status: resp.status,
                });
                throw error;
            } finally {
                submitted.answered();
            }
            arg.ctx.transport.addLog({
                body: batchRequestBody,
                headers: headers,
                response: responseText,
                success: false,
                url: batchRequestUrl,
                chatId: arg.chatId,
                status: resp.status,
            });
            return {
                type: "fail",
                result: responseText,
            };
        }

        let r: any;
        try {
            r = await submitted.response.json();
        } catch (error) {
            submitted.answered();
            arg.ctx.transport.addLog({
                body: batchRequestBody,
                headers: headers,
                response: `The batch acknowledgement could not be read: ${error instanceof Error ? error.message : String(error)}`,
                success: false,
                url: batchRequestUrl,
                chatId: arg.chatId,
                status: resp.status,
            });
            throw error;
        }

        // The poll URLs are built from it: an acknowledgement without one ends the request here.
        if (typeof r?.id !== "string" || r.id === "") {
            submitted.answered();
            arg.ctx.transport.addLog({
                body: batchRequestBody,
                headers: headers,
                response: r,
                success: false,
                url: batchRequestUrl,
                chatId: arg.chatId,
                status: resp.status,
            });
            return {
                type: "fail",
                result: "No results URL returned from Claude batch request",
            };
        }

        arg.ctx.transport.addLog({
            body: batchRequestBody,
            headers: headers,
            response: r,
            success: true,
            url: batchRequestUrl,
            chatId: arg.chatId,
            status: resp.status,
        });

        const statusUrl = replacerURL + `/batches/${r.id}`;
        const resultsUrl = replacerURL + `/batches/${r.id}/results`;
        const cancelUrl = replacerURL + `/batches/${r.id}/cancel`;
        const abortSignal = arg.abortSignal;

        // Streaming is used in batch API to apply successful response even after abortSignal is fired
        // In order to do otherwise, `request.ts` and `index.svelte.ts` should be edited to bypass abort signal check
        const stream = new ReadableStream<StreamResponseChunk>({
            async start(controller) {
                const batchStartTime = Date.now();
                const BATCH_TIMEOUT = 24 * 60 * 60 * 1000 + 600 * 1000; // 24 hours + 10 minutes
                let cancelRequested = false;

                while (true) {
                    try {
                        await sleep(3000);
                        if (abortSignal?.aborted && !cancelRequested) {
                            cancelRequested = true;
                            try {
                                await arg.ctx.transport.fetchStream(cancelUrl, {
                                    body: "{}",
                                    method: "POST",
                                    headers: headers,
                                    interceptor: "anthropic_batching_cancel",
                                    logFetch: false,
                                    firstByte: false,
                                });
                            } catch (e) {
                                // ignore cancel request errors
                            }
                        }
                        if (Date.now() - batchStartTime > BATCH_TIMEOUT) {
                            controller.error(new Error("Claude batch request timed out after 24 hours"));
                            return;
                        }

                        const statusRes = await arg.ctx.transport.fetchStream(statusUrl, {
                            method: "GET",
                            headers: headers,
                            signal: cancelRequested ? undefined : abortSignal,
                            interceptor: "anthropic_batching_status",
                            logFetch: false,
                            firstByte: false,
                        });

                        if (statusRes.status !== 200) {
                            // A refused poll ends the request: its first byte is the answer's.
                            const refused = deferFirstByte(statusRes, arg.ctx.firstByte);
                            const statusResponseText = await textifyReadableStream(refused.response.body!);
                            refused.answered();
                            arg.ctx.transport.addLog({
                                body: "",
                                headers: headers,
                                response: statusResponseText,
                                success: false,
                                url: statusUrl,
                                chatId: arg.chatId,
                                status: statusRes.status,
                            });
                            controller.error(new Error(statusResponseText));
                            return;
                        }

                        const statusData: any = await statusRes.json();

                        if (statusData.processing_status !== "ended") {
                            continue;
                        }
                        // Only the poll that saw the end is logged (a batch can poll for a day).
                        arg.ctx.transport.addLog({
                            body: "",
                            headers: headers,
                            response: statusData,
                            success: true,
                            url: statusUrl,
                            chatId: arg.chatId,
                            status: statusRes.status,
                        });

                        const batchRes = await arg.ctx.transport.fetchStream(resultsUrl, {
                            method: "GET",
                            headers: headers,
                            signal: cancelRequested ? undefined : abortSignal,
                            interceptor: "anthropic_batching_results",
                            logFetch: false,
                        });

                        if (batchRes.status !== 200) {
                            const resultResponseText = await textifyReadableStream(batchRes.body!);
                            arg.ctx.transport.addLog({
                                body: "",
                                headers: headers,
                                response: resultResponseText,
                                success: false,
                                url: resultsUrl,
                                chatId: arg.chatId,
                                status: batchRes.status,
                            });
                            controller.error(new Error(resultResponseText));
                            return;
                        }

                        //since jsonl
                        const batchResultRawText = await batchRes.text();
                        const batchTextData = batchResultRawText
                            .split("\n")
                            .filter((v) => v.trim() !== "")
                            .map((v) => {
                                try {
                                    return JSON.parse(v);
                                } catch (error) {
                                    return null;
                                }
                            })
                            .filter((v) => v !== null);

                        for (const batchData of batchTextData) {
                            const type = batchData?.result?.type;
                            if (batchData?.result?.type === "succeeded") {
                                const contents = batchData.result.message.content ?? [];
                                let resText = "";
                                let thinking = false;
                                for (const content of contents) {
                                    if (content.type === "text") {
                                        if (thinking) {
                                            resText += "</Thoughts>\n\n";
                                            thinking = false;
                                        }
                                        resText += content.text;
                                    }
                                    if (content.type === "thinking") {
                                        if (!thinking) {
                                            resText += "<Thoughts>\n";
                                            thinking = true;
                                        }
                                        resText += content.thinking ?? "";
                                    }
                                    if (content.type === "redacted_thinking") {
                                        if (!thinking) {
                                            resText += "<Thoughts>\n";
                                            thinking = true;
                                        }
                                        resText += "\n{{redacted_thinking}}\n";
                                    }
                                }

                                if (thinking) {
                                    resText += "</Thoughts>\n\n";
                                    thinking = false;
                                }

                                controller.enqueue({ "0": resText });
                                arg.ctx.transport.addLog({
                                    body: "",
                                    headers: headers,
                                    response: batchData,
                                    success: true,
                                    url: resultsUrl,
                                    chatId: arg.chatId,
                                    status: batchRes.status,
                                });
                                controller.close();
                                return;
                            }
                            if (batchData?.result?.type === "errored") {
                                const batchError = batchData.result.error;

                                const message = arg.ctx.redactText(
                                    batchError?.error?.message
                                        ? `${batchError.error.type}: ${batchError.error.message}`
                                        : JSON.stringify(batchError),
                                );

                                arg.ctx.transport.addLog({
                                    body: "",
                                    headers: headers,
                                    response: batchData,
                                    success: false,
                                    url: resultsUrl,
                                    chatId: arg.chatId,
                                    status: batchRes.status,
                                });
                                controller.error(new Error(message));
                                return;
                            }
                            if (batchData?.result?.type === "canceled") {
                                arg.ctx.transport.addLog({
                                    body: "",
                                    headers: headers,
                                    response: batchData,
                                    success: false,
                                    url: resultsUrl,
                                    chatId: arg.chatId,
                                    status: batchRes.status,
                                });
                                controller.close();
                                return;
                            }
                            if (batchData?.result?.type === "expired") {
                                arg.ctx.transport.addLog({
                                    body: "",
                                    headers: headers,
                                    response: batchData,
                                    success: false,
                                    url: resultsUrl,
                                    chatId: arg.chatId,
                                    status: batchRes.status,
                                });
                                controller.error(new Error("Claude batch request expired"));
                                return;
                            }
                        }
                    } catch (error) {
                        console.error("[LLM] Claude batch results:", arg.ctx.redactText(String(error)));
                    }
                }
            },
        });

        return {
            type: "streaming",
            result: stream,
        };
    }

    if (db.claudeRetrivalCaching) {
        arg.ctx.registerClaudeObserver({
            url: replacerURL,
            body: body,
            headers: headers,
        });
    }

    return requestClaudeHTTP(replacerURL, headers, body, arg);
}

async function requestClaudeHTTP(
    replacerURL: string,
    headers: { [key: string]: string },
    body: any,
    arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
    if (arg.useStreaming) {
        const res = await arg.ctx.transport.fetchStream(replacerURL, {
            body: JSON.stringify(body),
            headers: headers,
            method: "POST",
            chatId: arg.chatId,
            signal: arg.abortSignal,
            interceptor: "anthropic_streaming",
        });

        if (res.status !== 200) {
            return {
                type: "fail",
                result: await textifyReadableStream(res.body!),
            };
        }
        const lines = new SseLines();
        let text = "";
        let thinking = false;

        const applyLines = (completeLines: string[]) => {
            let applied = false;
            for (const line of completeLines) {
                if (!line.startsWith("data:")) continue;
                try {
                    const parsedData = JSON.parse(line.slice(5).trim());
                    if (parsedData?.type === "content_block_delta") {
                        if (parsedData.delta?.type === "text" || parsedData.delta?.type === "text_delta") {
                            if (thinking) {
                                text += "</Thoughts>\n\n";
                                thinking = false;
                            }
                            text += parsedData.delta?.text ?? "";
                        }
                        if (parsedData.delta?.type === "thinking" || parsedData.delta?.type === "thinking_delta") {
                            if (!thinking) {
                                text += "<Thoughts>\n";
                                thinking = true;
                            }
                            text += parsedData.delta?.thinking ?? "";
                        }
                        if (parsedData.delta?.type === "redacted_thinking") {
                            if (!thinking) {
                                text += "<Thoughts>\n";
                                thinking = true;
                            }
                            text += "\n{{redacted_thinking}}\n";
                        }
                    }
                    if (parsedData?.type === "error") {
                        // Provider errors, including overloads, are redacted answer text.
                        // Retry policy belongs to requestChatDataOuter.
                        text += "Error:" + arg.ctx.redactText(`${parsedData?.error?.message}`);
                    }
                    applied = true;
                } catch {
                    // A malformed data line must not hide the following events.
                }
            }
            return applied;
        };

        const stream = new TransformStream<Uint8Array, StreamResponseChunk>({
            transform(chunk, controller) {
                if (applyLines(lines.push(chunk))) {
                    controller.enqueue({ "0": text });
                }
            },
            flush(controller) {
                let changed = applyLines(lines.end());
                if (thinking) {
                    text += "</Thoughts>\n\n";
                    thinking = false;
                    changed = true;
                }
                if (changed) {
                    controller.enqueue({ "0": text });
                }
            },
        });
        // Body errors reach the readable side; cancellation reaches the upstream body.
        res.body!.pipeTo(stream.writable).catch(() => {});

        return {
            type: "streaming",
            result: stream.readable,
        };
    }

    const db = arg.ctx.db;
    const res = await arg.ctx.transport.fetchBuffered(replacerURL, {
        body: body,
        headers: headers,
        method: "POST",
        chatId: arg.chatId,
        interceptor: "anthropic_http",
    });

    if (!res.ok) {
        const stringlified = JSON.stringify(res.data);
        return {
            type: "fail",
            result: stringlified,
            failByServerError: stringlified?.toLocaleLowerCase()?.includes("overload"),
        };
    }
    if (res.data.error) {
        const stringlified = JSON.stringify(res.data.error);
        return {
            type: "fail",
            result: stringlified,
            failByServerError: stringlified?.toLocaleLowerCase()?.includes("overload"),
        };
    }
    const contents = res?.data?.content;
    if (!contents || contents.length === 0) {
        return {
            type: "fail",
            result: JSON.stringify(res.data),
        };
    }
    let resText = "";
    let thinking = false;

    const hasToolUse = (contents as any[]).some((v) => v.type === "tool_use");

    if (hasToolUse) {
        const messages: Claude3ExtendedChat[] = body.messages;
        const response: Claude3Chat = {
            role: "user",
            content: [],
        };

        for (const content of contents as Claude3ContentBlock[]) {
            if (messages[messages.length - 1].role !== "assistant") {
                messages.push({
                    role: "assistant",
                    content: [],
                });
            }
            if (typeof messages[messages.length - 1].content === "string") {
                messages[messages.length - 1].content = [
                    {
                        type: "text",
                        text: messages[messages.length - 1].content as string,
                    },
                ];
            }

            if (content.type === "tool_use") {
                arg.ctx.tools.attempt?.();
                const used = await arg.ctx.tools.call(content.name, content.input);
                const r: Claude3ToolResponseBlock = {
                    type: "tool_result",
                    tool_use_id: content.id,
                    content: used.map((v) => {
                        switch (v.type) {
                            case "text": {
                                return {
                                    type: "text",
                                    text: v.text,
                                };
                            }
                            case "image": {
                                return {
                                    type: "image",
                                    source: {
                                        type: "base64",
                                        media_type: v.mimeType,
                                        data: v.data,
                                    },
                                };
                            }
                            default: {
                                return {
                                    type: "text",
                                    text: `Unsupported tool response type: ${v.type}`,
                                };
                            }
                        }
                    }),
                };
                response.content.push(r);
                if (arg.rememberToolUsage) {
                    arg.additionalOutput ??= "";
                    arg.additionalOutput += await arg.ctx.tools.encode({
                        call: {
                            id: content.id,
                            name: content.name,
                            arg: content.input,
                        },
                        response: used,
                    });
                }
            }

            (messages[messages.length - 1] as Claude3Chat).content.push(content);
        }

        messages.push(response);

        body.messages = messages;
        body.stream = false;

        return requestClaudeHTTP(replacerURL, headers, body, arg);
    }
    for (const content of contents) {
        if (content.type === "text") {
            if (thinking) {
                resText += "</Thoughts>\n\n";
                thinking = false;
            }
            resText += content.text;
        }
        if (content.type === "thinking") {
            if (!thinking) {
                resText += "<Thoughts>\n";
                thinking = true;
            }
            resText += content.thinking ?? "";
        }
        if (content.type === "redacted_thinking") {
            if (!thinking) {
                resText += "<Thoughts>\n";
                thinking = true;
            }
            resText += "\n{{redacted_thinking}}\n";
        }
        if (content.type === "tool_use") {
        }
    }

    if (thinking) {
        resText += "</Thoughts>\n\n";
    }

    arg.additionalOutput ??= "";
    if (arg.extractJson && db.jsonSchemaEnabled) {
        return {
            type: "success",
            result: arg.additionalOutput + (await extractJSON(resText, db.jsonSchema, arg.ctx)),
        };
    }
    return {
        type: "success",
        result: arg.additionalOutput + resText,
    };
}
