// Port of `src/ts/process/request/google.ts` (the client's dependencies are `arg.ctx`'s). The
// Vertex access token comes from the server's cache (`ctx.vertexAccessToken`), and the inlays it
// writes are written in the client's tab (`ctx.inlays`).
import { randomUUID } from "node:crypto";
import { LLMFlags, LLMFormat, type LLMModel } from "../../../shared/llm.ts";
import type { InlaySignature } from "../../../shared/llm/request.ts";
import { textifyReadableStream } from "./transport.ts";
import { simplifySchema } from "./util.ts";
import { extractJSON, getGeneralJSONSchema } from "./jsonSchema.ts";
import type { RequestDataArgumentExtended, requestDataResponse, StreamResponseChunk } from "./request.ts";
import { applyAdditionalParameters, applyParameters, getAdditionalParameters, type LLMParameter } from "./shared.ts";

type GeminiFunctionCall = {
    id?: string;
    name: string;
    args: any;
};

type GeminiFunctionResponse = {
    id?: string;
    name: string;
    response: any;
};

interface GeminiPart {
    text?: string;
    thought?: boolean;
    thoughtSignature?: string;
    inlineData?: {
        mimeType: string;
        data: string;
    };
    functionCall?: GeminiFunctionCall;
    functionResponse?: GeminiFunctionResponse;
}

interface GeminiChat {
    role: "user" | "model" | "function";
    parts: GeminiPart[];
}

export async function requestGoogleCloudVertex(arg: RequestDataArgumentExtended): Promise<requestDataResponse> {
    const formated = arg.formated;
    const db = arg.ctx.db;
    const maxTokens = arg.maxTokens;

    let reformatedChat: GeminiChat[] = [];
    let systemPrompt = "";

    if (formated[0].role === "system") {
        systemPrompt = formated[0].content;
        formated.shift();
    }

    for (let i = 0; i < formated.length; i++) {
        const chat = formated[i];

        const prevChat = reformatedChat[reformatedChat.length - 1];
        const qRole = chat.role === "user" ? "user" : chat.role === "assistant" ? "model" : chat.role;

        if (chat.multimodals && chat.multimodals.length > 0) {
            let geminiParts: GeminiPart[] = [];

            geminiParts.push({
                text: chat.content,
            });

            for (const modal of chat.multimodals) {
                if (
                    (modal.type === "image" && arg.modelInfo.flags.includes(LLMFlags.hasImageInput)) ||
                    (modal.type === "audio" && arg.modelInfo.flags.includes(LLMFlags.hasAudioInput)) ||
                    (modal.type === "video" && arg.modelInfo.flags.includes(LLMFlags.hasVideoInput))
                ) {
                    const dataurl = modal.base64;
                    const base64 = dataurl.split(",")[1];
                    const mediaType = dataurl.split(";")[0].split(":")[1];

                    geminiParts.push({
                        inlineData: {
                            mimeType: mediaType,
                            data: base64,
                        },
                    });
                }

                if (modal.type === "signature" && db.saveSignatures) {
                    const sig: InlaySignature = JSON.parse(Buffer.from(modal.base64, "base64").toString("utf-8"));
                    if (sig.source === arg.modelInfo.internalID || sig.source === arg.modelInfo.id) {
                        geminiParts.push({
                            thought: true,
                            thoughtSignature: sig.signatures[0].content,
                        });
                    }
                }
            }

            reformatedChat.push({
                role: chat.role === "user" ? "user" : "model",
                parts: geminiParts,
            });
        } else if (chat.role === "system") {
            if (prevChat?.role === "user") {
                reformatedChat[reformatedChat.length - 1].parts[0].text += "\nsystem:" + chat.content;
            } else {
                reformatedChat.push({
                    role: "user",
                    parts: [
                        {
                            text: chat.role + ":" + chat.content,
                        },
                    ],
                });
            }
        } else if (chat.role === "assistant" || chat.role === "user") {
            reformatedChat.push({
                role: chat.role === "user" ? "user" : "model",
                parts: [
                    {
                        text: chat.content,
                    },
                ],
            });
        } else {
            reformatedChat.push({
                role: "user",
                parts: [
                    {
                        text: chat.role + ":" + chat.content,
                    },
                ],
            });
        }
    }

    for (let i = 0; i < reformatedChat.length; i++) {
        let chat = reformatedChat[i];
        for (let j = 0; j < chat.parts.length; j++) {
            const part = chat.parts[j];
            if (part.text && part.text.includes("<tool_call>")) {
                // Analyze the entire text to sequentially process multiple tool_calls
                const toolCallMatches = [...part.text.matchAll(/<tool_call>(.*?)<\/tool_call>/g)];
                if (toolCallMatches.length > 0) {
                    // Split the text by tool_call and reconstruct in order
                    const segments: any[] = [];
                    let lastIndex = 0;

                    for (let k = 0; k < toolCallMatches.length; k++) {
                        const match = toolCallMatches[k];
                        // Text before tool_call
                        if (match.index! > lastIndex) {
                            segments.push({
                                type: "text",
                                content: part.text.substring(lastIndex, match.index).trim(),
                                role: chat.role,
                            });
                        }

                        // Handle tool_call
                        const call = await arg.ctx.tools.decode(match[1]);
                        if (call) {
                            const tool = arg?.tools?.find((t) => t.name === call.call.name);
                            if (tool) {
                                segments.push({
                                    type: "functionCall",
                                    call: call,
                                    tool: tool,
                                });
                            }
                        }

                        lastIndex = match.index! + match[0].length;
                    }
                    // Last text after the last tool_call
                    if (lastIndex < part.text.length) {
                        segments.push({
                            type: "text",
                            content: part.text.substring(lastIndex).trim(),
                            role: chat.role,
                        });
                    }
                    // Keep the first text in the current part
                    if (segments.length > 0 && segments[0].type === "text") {
                        part.text = segments[0].content.trim() ? segments[0].content : "";
                        segments.shift();
                    } else {
                        part.text = "";
                    }

                    // Mark the current part for removal if its text is empty
                    const shouldRemoveCurrentPart = !part.text!.trim();

                    // Insert the remaining segments in order
                    let insertIndex = i + 1;
                    for (const segment of segments) {
                        if (segment.type === "text") {
                            // Insert only non-empty text
                            if (segment.content.trim()) {
                                reformatedChat.splice(insertIndex, 0, {
                                    role: segment.role,
                                    parts: [
                                        {
                                            text: segment.content,
                                        },
                                    ],
                                });
                                insertIndex++;
                            }
                        } else if (segment.type === "functionCall") {
                            // Insert functionCall
                            reformatedChat.splice(insertIndex, 0, {
                                role: "model",
                                parts: [
                                    {
                                        functionCall: {
                                            name: segment.call.call.name,
                                            args: segment.call.call.arg,
                                        },
                                    },
                                ],
                            });
                            insertIndex++;

                            // Insert functionResponse
                            reformatedChat.splice(insertIndex, 0, {
                                role: "function",
                                parts: [
                                    {
                                        functionResponse: {
                                            name: segment.call.call.name,
                                            response: {
                                                data: (() => {
                                                    const res: string[] = [];
                                                    for (const r of segment.call.response) {
                                                        if (r.type === "text") {
                                                            res.push(r.text);
                                                        }
                                                    }
                                                    return res;
                                                })(),
                                            },
                                        },
                                    },
                                ],
                            });
                            insertIndex++;
                        }
                    }
                    // Remove the current part if its text is empty
                    if (shouldRemoveCurrentPart) {
                        reformatedChat.splice(i, 1);
                        i = insertIndex - 2; // Adjust index after removal
                    } else {
                        i = insertIndex - 1; // Start from the correct position in the next loop
                    }
                }
            }
        }
    }

    // After tool parsing, merge consecutive chats with the same role
    for (let i = reformatedChat.length - 1; i >= 1; i--) {
        const currentChat = reformatedChat[i];
        const prevChat = reformatedChat[i - 1];

        if (currentChat.role === prevChat.role) {
            // If the same role is consecutive, merge the parts arrays and remove the current chat

            // If the last part of the previous chat and the first part of the current chat are both text, join with \n\n
            const prevLastPart = prevChat.parts[prevChat.parts.length - 1];
            const currentFirstPart = currentChat.parts[0];

            if (prevLastPart.text && currentFirstPart.text) {
                prevLastPart.text += "\n\n" + currentFirstPart.text;
                // Add the rest of the current chat's parts except the first
                prevChat.parts.push(...currentChat.parts.slice(1));
            } else {
                // If not text, just merge the parts arrays
                prevChat.parts.push(...currentChat.parts);
            }

            // Remove the current chat
            reformatedChat.splice(i, 1);
        }
    }

    const uncensoredCatagory = [
        {
            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            threshold: "BLOCK_NONE",
        },
        {
            category: "HARM_CATEGORY_HATE_SPEECH",
            threshold: "BLOCK_NONE",
        },
        {
            category: "HARM_CATEGORY_HARASSMENT",
            threshold: "BLOCK_NONE",
        },
        {
            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
            threshold: "BLOCK_NONE",
        },
        {
            category: "HARM_CATEGORY_CIVIC_INTEGRITY",
            threshold: "BLOCK_NONE",
        },
    ];

    if (arg.modelInfo.flags.includes(LLMFlags.noCivilIntegrity)) {
        uncensoredCatagory.splice(4, 1);
    }

    if (arg.modelInfo.flags.includes(LLMFlags.geminiBlockOff)) {
        for (let i = 0; i < uncensoredCatagory.length; i++) {
            uncensoredCatagory[i].threshold = "OFF";
        }
    }

    let para: LLMParameter[] = ["temperature", "top_p", "top_k", "presence_penalty", "frequency_penalty"];

    if (arg.modelInfo.flags.includes(LLMFlags.geminiThinking)) {
        para.push("thinking_tokens");
        para.push("reasoning_effort");
    }

    para = para.filter((v) => {
        return arg.modelInfo.parameters.includes(v);
    });

    let body: any = {
        contents: reformatedChat,
        generation_config: applyParameters(
            {
                maxOutputTokens: maxTokens,
            },
            para,
            {
                top_p: "topP",
                top_k: "topK",
                presence_penalty: "presencePenalty",
                frequency_penalty: "frequencyPenalty",
                thinking_tokens: "thinkingBudget",
                reasoning_effort: "thinkingConfig.thinkingLevel",
            },
            arg.mode,
            {
                ignoreTopKIfZero: true,
                modelId: arg.modelInfo.id,
            },
            arg.ctx.db,
        ),
        safetySettings: uncensoredCatagory,
        systemInstruction: {
            parts: [
                {
                    text: systemPrompt,
                },
            ],
        },
        tools: {
            functionDeclarations:
                arg?.tools?.map((tool, i) => {
                    return {
                        name: tool.name,
                        description: tool.description,
                        parameters: simplifySchema(tool.inputSchema),
                    };
                }) ?? [],
        },
    };

    if (arg.modelInfo.flags.includes(LLMFlags.geminiThinking)) {
        const generationConfig = body.generation_config;

        // 2.5's flat thinkingBudget is wrapped into thinkingConfig here.
        // 3.x's thinkingConfig.thinkingLevel was already set by the rename above.
        if (generationConfig.thinkingBudget !== undefined) {
            generationConfig.thinkingConfig = {
                thinkingBudget: generationConfig.thinkingBudget,
                includeThoughts: true,
            };
            delete generationConfig.thinkingBudget;
        } else if (generationConfig.thinkingConfig) {
            // Models without a `minimal` level (e.g. Gemini 3.1 Pro) — map it to `low`, as Google does.
            if (
                generationConfig.thinkingConfig.thinkingLevel === "minimal" &&
                arg.modelInfo.flags.includes(LLMFlags.geminiThinkingNoMinimal)
            ) {
                generationConfig.thinkingConfig.thinkingLevel = "low";
            }
            generationConfig.thinkingConfig.includeThoughts = true;
        }
    }

    if (systemPrompt === "") {
        delete body.systemInstruction;
    }

    if (arg.modelInfo.flags.includes(LLMFlags.hasAudioOutput)) {
        body.generation_config.responseModalities = ["TEXT", "AUDIO"];
        arg.useStreaming = false;
    }
    if (arg.imageResponse || arg.modelInfo.flags.includes(LLMFlags.hasImageOutput)) {
        body.generation_config.responseModalities = ["TEXT", "IMAGE"];
        arg.useStreaming = false;
    }

    let headers: { [key: string]: string } = {
        "Content-Type": "application/json",
    };

    if (db.gptVisionQuality === "high") {
        body.generation_config.mediaResolution = "MEDIA_RESOLUTION_MEDIUM";
    }

    const PROJECT_ID = db.google.projectId;
    const REGION = db.vertexRegion;

    const isVertexGlobalOnlyModel = (modelId: string) => {
        // Gemini 3 preview models and the 3.5/3.6/3.7/3.8 Flash family are not served from the regions
        // selectable in settings (us-central1, us-west1); route them through the global endpoint.
        return /^gemini-3-.*-preview$/.test(modelId) || /^gemini-3\.[5678]-flash/.test(modelId);
    };

    if (arg.modelInfo.format === LLMFormat.VertexAIGemini) {
        // The client reused the token it had stored until its expiry; the server keeps it in memory
        // (`vertexToken.ts`), so a token is generated on the first Vertex request after a restart.
        if (!db.vertexClientEmail || !db.vertexPrivateKey) {
            arg.ctx.alertError(
                "Vertex AI authentication information is missing or incomplete. Please check your settings.",
            );
            return {
                type: "fail",
                result: "Vertex AI authentication information is missing or incomplete. Please check your settings.",
            };
        }
        headers["Authorization"] =
            "Bearer " + (await arg.ctx.vertexAccessToken(db.vertexClientEmail, db.vertexPrivateKey));
    }

    if (db.jsonSchemaEnabled || arg.schema) {
        body.generation_config.response_mime_type = "application/json";
        body.generation_config.response_schema = await getGeneralJSONSchema(arg.ctx, arg.schema, [
            "$schema",
            "additionalProperties",
        ]);
    }

    let url = "";
    let apiKey = arg.key || db.google.accessToken;

    if (arg.customURL) {
        let baseURL = arg.customURL;
        if (!baseURL.endsWith("/")) {
            baseURL += "/";
        }
        const endpoint = arg.useStreaming ? "streamGenerateContent" : "generateContent";
        const u = new URL(`models/${arg.modelInfo.internalID}:${endpoint}`, baseURL);
        u.searchParams.set("key", apiKey);
        if (arg.useStreaming) {
            u.searchParams.set("alt", "sse");
        }
        url = u.toString();
    } else if (arg.modelInfo.format === LLMFormat.VertexAIGemini) {
        const endpoint = arg.useStreaming ? "streamGenerateContent?alt=sse" : "generateContent";

        // Some models (e.g. Gemini 3 preview) are only available via the global endpoint.
        const effectiveRegion = isVertexGlobalOnlyModel(arg.modelInfo.internalID!) ? "global" : REGION;

        url =
            effectiveRegion === "global"
                ? `https://aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${effectiveRegion}/publishers/google/models/${arg.modelInfo.internalID}:${endpoint}`
                : `https://${effectiveRegion}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${effectiveRegion}/publishers/google/models/${arg.modelInfo.internalID}:${endpoint}`;
    } else if (arg.modelInfo.format === LLMFormat.GoogleCloud && arg.useStreaming) {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${arg.modelInfo.internalID}:streamGenerateContent?key=${apiKey}&alt=sse`;
    } else {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${arg.modelInfo.internalID}:generateContent?key=${apiKey}`;
    }
    // will return error if functionDeclarations is empty
    if (body.tools?.functionDeclarations?.length === 0) {
        body.tools = undefined;
    }

    body = applyAdditionalParameters(body, headers, getAdditionalParameters(arg.ctx.db, arg.aiModel));

    if (arg.previewBody) {
        return {
            type: "success",
            result: JSON.stringify({
                url: url,
                body: body,
                headers: headers,
            }),
        };
    }

    return requestGoogle(url, body, headers, arg);
}

async function requestGoogle(
    url: string,
    body: any,
    headers: { [key: string]: string },
    arg: RequestDataArgumentExtended,
): Promise<requestDataResponse> {
    const db = arg.ctx.db;

    const fallBackGemini = async (originalError: string): Promise<requestDataResponse> => {
        if (!db.antiServerOverloads) {
            return {
                type: "fail",
                result: originalError,
                failByServerError: true,
            };
        }

        if (arg?.abortSignal?.aborted) {
            return {
                type: "fail",
                result: originalError,
                failByServerError: true,
            };
        }
        if (arg.modelInfo.format === LLMFormat.VertexAIGemini) {
            return {
                type: "fail",
                result: originalError,
                failByServerError: true,
            };
        }

        return requestGoogle(url, body, headers, arg);
    };

    // process the text parts into a single text response
    const processTextResponse = async (rDatas: { text: string; thought?: boolean }[]) => {
        if (arg.extractJson && (db.jsonSchemaEnabled || arg.schema)) {
            for (let i = 0; i < rDatas.length; i++) {
                const extracted = await extractJSON(rDatas[i].text, arg.extractJson, arg.ctx);
                rDatas[i].text = extracted;
            }
        }
        const thoughtsArr: string[] = [];
        const contentArr: string[] = [];
        for (const d of rDatas) {
            if (d.thought) {
                thoughtsArr.push(d.text);
            } else {
                contentArr.push(d.text);
            }
        }
        const thoughts = thoughtsArr.join("\n\n");
        const content = contentArr.join("\n\n");
        return (thoughts ? `<Thoughts>\n\n${thoughts}\n\n</Thoughts>\n\n` : "") + content;
    };

    if (
        (arg.modelInfo.format === LLMFormat.GoogleCloud || arg.modelInfo.format === LLMFormat.VertexAIGemini) &&
        arg.useStreaming
    ) {
        if (arg.previewBody) {
            return {
                type: "success",
                result: JSON.stringify({
                    url: url,
                    body: body,
                    headers: headers,
                }),
            };
        }

        const f = await arg.ctx.transport.fetchStream(url, {
            headers: headers,
            body: JSON.stringify(body),
            method: "POST",
            chatId: arg.chatId,
            signal: arg.abortSignal,
            interceptor: "gemini_base_stream",
        });

        if (f.status !== 200) {
            const text = await textifyReadableStream(f.body!);
            if (text.includes("RESOURCE_EXHAUSTED")) {
                return fallBackGemini(text);
            }
            return {
                type: "fail",
                result: text,
            };
        }

        const transtream = getTranStream({
            ctx: arg.ctx,
            modelInfo: arg.modelInfo,
            saveSignature: arg.saveSignatures ?? false,
        });

        // An aborted or failed body errors the transform\'s readable side, which the reader sees;
        // unhandled, the rejected pipe would end the server process.
        f.body!.pipeTo(transtream.writable).catch(() => {});

        return {
            type: "streaming",
            result: wrapToolStream(transtream.readable, body, headers, url, arg),
        };
    }

    const res = await arg.ctx.transport.fetchStream(url, {
        headers: headers,
        body: JSON.stringify(body),
        method: "POST",
        chatId: arg.chatId,
        signal: arg.abortSignal,
        interceptor: "gemini_base",
    });

    if (!res.ok) {
        const data = await res.text();
        const text = JSON.stringify(data);
        if (text.includes("RESOURCE_EXHAUSTED")) {
            return fallBackGemini(text);
        }
        return {
            type: "fail",
            result: `${text} (status: ${res.status})`,
        };
    }

    let rDatas: { text: string; thought?: boolean }[] = [];
    const processDataItem = async (data: any): Promise<GeminiPart[]> => {
        const parts = data?.candidates?.[0]?.content?.parts as GeminiPart[];

        if (parts) {
            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];

                if (part.text) {
                    rDatas.push({
                        text: part.text,
                        thought: part.thought,
                    });
                }

                if (part.thoughtSignature && arg.saveSignatures) {
                    const sigId = randomUUID();
                    await arg.ctx.inlays.saveSignature(sigId, {
                        source: arg.modelInfo.internalID || arg.modelInfo.id,
                        sourceFormat: arg.modelInfo.format,
                        signatures: [
                            {
                                type: "text",
                                content: part.text as string,
                            },
                        ],
                    });
                    rDatas[rDatas.length - 1].text = `{{inlayeddata::${sigId}}}\n\n` + rDatas[rDatas.length - 1].text;
                }

                if (part.inlineData) {
                    const id = randomUUID();

                    if (part.inlineData.mimeType.startsWith("image/")) {
                        // The client draws the image through a canvas (`writeInlayImage`); the
                        // tab does it here too, before any later event reaches it.
                        await arg.ctx.inlays.writeImage({
                            id: id,
                            mimeType: part.inlineData.mimeType,
                            data: part.inlineData.data,
                        });
                        rDatas.push({
                            text: `{{inlayeddata::${id}}}`,
                        });
                    } else {
                        const id = randomUUID();
                        await arg.ctx.inlays.setAsset({
                            id,
                            name: "gemini-audio",
                            data: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
                            ext: part.inlineData.mimeType.split("/")[1],
                        });
                    }
                }
            }
        }

        if (data?.usageMetadata) {
            {
                try {
                    await arg.ctx.intercept(
                        {
                            usageMetadata: data.usageMetadata,
                            modelStatus: data.modelStatus,
                            promptFeedback: data.promptFeedback,
                        },
                        "meta_gemini",
                    );
                } catch (e) {
                    console.error("[LLM]", arg.ctx.redactText(String(e)));
                }
            }
        }
        return parts;
    };

    // traverse responded data if it contains multipart contents
    let parts: GeminiPart[] = [];
    const resData = await res.json();
    if (Array.isArray(resData)) {
        for (const data of resData) {
            const p = await processDataItem(data);
            parts = parts.concat(p);
        }
    } else {
        const p = await processDataItem(resData);
        parts = parts.concat(p);
    }
    parts = parts.filter((p) => p);

    const calls: GeminiFunctionCall[] = [];
    for (const p of parts) {
        if (p?.functionCall) {
            calls.push(p.functionCall as GeminiFunctionCall);
        }
    }

    // If there are function calls, handle calls and send next request
    if (calls.length > 0) {
        const chat = body.contents as GeminiChat[];

        // Add the model response part to the request content (only function calls if simplifiedToolUse is enabled)
        if (db.simplifiedToolUse) {
            chat.push({
                role: "model",
                parts: calls.map((call) => {
                    return {
                        functionCall: {
                            name: call.name,
                            args: call.args,
                        },
                    } as GeminiPart;
                }),
            });
        }
        // Add the model response part to the request content (text response and function calls)
        else {
            chat.push({
                role: "model",
                parts: parts.filter((p) => !p.thought),
            });
        }
        // If the last part is a model response, merge it with the previous model response
        if (chat[chat.length - 2]?.role === "model") {
            chat[chat.length - 2].parts = chat[chat.length - 2].parts.concat(chat[chat.length - 1].parts);
            chat.pop();
        }

        const functionParts: GeminiPart[] = [];
        const callCodes: string[] = [];
        const tools = arg?.tools ?? [];

        // Handle tool calls
        for (const call of calls) {
            const functionName = call.name;
            const functionArgs = call.args;

            const tool = tools.find((t) => t.name === functionName);
            if (tool) {
                const result = (await arg.ctx.tools.call(tool.name, functionArgs)).filter((r) => {
                    return r.type === "text";
                });
                if (result.length === 0) {
                    functionParts.push({
                        functionResponse: {
                            name: call.name,
                            response: "No response from tool.",
                        },
                    });
                }

                // Store the encoded tool call history for later use
                if (arg.rememberToolUsage) {
                    callCodes.push(
                        await arg.ctx.tools.encode({
                            call: {
                                id: call.id as string,
                                name: call.name,
                                arg: call.args,
                            },
                            response: result,
                        }),
                    );
                }

                for (let i = 0; i < result.length; i++) {
                    let response: any = result[i].text;
                    try {
                        //try json parse
                        response = {
                            data: JSON.parse(response),
                        };
                    } catch (error) {
                        response = {
                            data: response,
                        };
                    }
                    functionParts.push({
                        functionResponse: {
                            name: call.name,
                            response,
                        },
                    });
                }
            } else {
                functionParts.push({
                    functionResponse: {
                        name: call.name,
                        response: `Tool ${call.name} not found.`,
                    },
                });
            }
        }

        // Add the user response part to the request content (function responses)
        chat.push({
            role: "function",
            parts: functionParts,
        });

        body.contents = chat;

        // Send the next request recursively
        let resRec;
        let attempt = 0;
        do {
            attempt++;
            resRec = await requestGoogle(url, body, headers, arg);

            if (resRec.type != "fail") {
                break;
            }
        } while (attempt <= db.requestRetrys); // Retry up to db.requestRetrys times

        // Does not include the text response if simplifiedToolUse is enabled
        const result =
            (db.simplifiedToolUse ? "" : (await processTextResponse(rDatas)) + "\n\n") + callCodes.join("\n\n");

        // If the next request fails, only the responses so far are returned
        if (resRec.type === "fail") {
            arg.ctx.alertError(`Failed to fetch model response after tool execution`);
            return {
                type: "success",
                result: result,
            };
        } else if (resRec.type === "success") {
            return {
                type: "success",
                result: result + "\n\n" + resRec.result,
            };
        }

        return resRec;
    }

    const result = await processTextResponse(rDatas);

    // fail if the result is empty
    if (!result) {
        return {
            type: "fail",
            result: `Got empty response: ${JSON.stringify(resData)}`,
        };
    }

    return {
        type: "success",
        result: result,
    };
}

function initStreamState(state?: { [key: string]: string }): { [key: string]: string } {
    if (!state) {
        return {
            __sign_text: "",
            __sign_function: "",
            __last_thought: "",
            __thoughts: "",
            __tool_calls: "[]",
            "0": "",
        };
    }
    state["__sign_text"] = state["__sign_text"] || "";
    state["__sign_function"] = state["__sign_function"] || "";
    state["__last_thought"] = state["__last_thought"] || "";
    state["__thoughts"] = state["__thoughts"] || "";
    state["__tool_calls"] = state["__tool_calls"] || "[]";
    state["0"] = state["0"] || "";
    return state;
}

function getTranStream(args: {
    modelInfo: LLMModel;
    saveSignature: boolean;
    ctx: RequestDataArgumentExtended["ctx"];
}): TransformStream<Uint8Array, StreamResponseChunk> {
    let buffer = "";
    const { modelInfo, saveSignature, ctx } = args;
    return new TransformStream<Uint8Array, StreamResponseChunk>({
        transform(chunk, control) {
            buffer += new TextDecoder().decode(chunk);
            const lines = buffer.split("\n");

            let readed = initStreamState();

            try {
                for (const line of lines) {
                    if (line.startsWith("data: ")) {
                        const dataStr = line.slice(6).trim();
                        if (dataStr === "[DONE]") return;

                        const jsonData = JSON.parse(dataStr);

                        if (jsonData.candidates?.[0]?.content?.parts) {
                            const parts = jsonData.candidates[0].content.parts;
                            for (const part of parts) {
                                if (part.text) {
                                    readed["__thoughts"] += readed["__last_thought"];
                                    readed["__last_thought"] = "";
                                    if (part.thought) {
                                        readed["__last_thought"] = part.text;
                                    } else {
                                        readed["0"] += part.text;
                                    }
                                    if (part.thoughtSignature) {
                                        readed["__sign_text"] = part.thoughtSignature;
                                        if (saveSignature) {
                                            //Its a promise, but we don't need to await it here
                                            const sigId = randomUUID();
                                            ctx.inlays.saveSignature(sigId, {
                                                source: modelInfo.internalID || modelInfo.id,
                                                sourceFormat: modelInfo.format,
                                                signatures: [
                                                    {
                                                        type: "text",
                                                        content: part.text as string,
                                                    },
                                                ],
                                            });
                                            readed["0"] += `{{inlayeddata::${sigId}}}`;
                                        }
                                    }
                                }
                                if (part.functionCall) {
                                    const toolCallsData = JSON.parse(readed["__tool_calls"]);
                                    toolCallsData.push(part.functionCall);
                                    readed["__tool_calls"] = JSON.stringify(toolCallsData);
                                    if (part.thoughtSignature) {
                                        readed["__sign_function"] = part.thoughtSignature;
                                        const sigId = randomUUID();

                                        if (saveSignature) {
                                            //Its a promise, but we don't need to await it here
                                            ctx.inlays.saveSignature(sigId, {
                                                source: modelInfo.internalID || modelInfo.id,
                                                sourceFormat: modelInfo.format,
                                                signatures: [
                                                    {
                                                        type: "function",
                                                        content: `${part.functionCall.name}(${JSON.stringify(part.functionCall.args)})`,
                                                    },
                                                ],
                                            });
                                            readed["0"] += `{{inlayeddata::${sigId}}}`;
                                        }
                                    }
                                }
                            }
                        }

                        if (jsonData.usageMetadata) {
                            readed["__usageMetadata"] = JSON.stringify(jsonData.usageMetadata);
                        }
                        if (jsonData.modelStatus) {
                            readed["__modelStatus"] = JSON.stringify(jsonData.modelStatus);
                        }
                    }
                }
                control.enqueue(readed);
            } catch (error) {}
        },
    });
}

function wrapToolStream(
    stream: ReadableStream<StreamResponseChunk>,
    body: any,
    headers: Record<string, string>,
    url: string,
    arg: RequestDataArgumentExtended,
): ReadableStream<StreamResponseChunk> {
    return new ReadableStream<StreamResponseChunk>({
        async start(controller) {
            const db = arg.ctx.db;
            let reader = stream.getReader();
            let prefix = "";
            let lastValue = initStreamState();

            while (true) {
                let { done, value } = await reader.read();

                value = initStreamState(value);

                if (arg.extractJson && (db.jsonSchemaEnabled || arg.schema)) {
                    value["0"] = await extractJSON(value["0"], arg.extractJson, arg.ctx);
                }

                let content = value["0"];
                let thoughts = value["__thoughts"];
                let lastThought = value["__last_thought"];
                let signText = value["__sign_text"];
                let signFunction = value["__sign_function"];

                if (done) {
                    value = initStreamState(lastValue);

                    content = value["0"];
                    thoughts = value["__thoughts"];
                    lastThought = value["__last_thought"];

                    // thoughtSignatures
                    signText = value["__sign_text"];
                    signFunction = value["__sign_function"];

                    const calls = JSON.parse(value["__tool_calls"]) as GeminiFunctionCall[];
                    if (calls && calls.length > 0) {
                        const chat = body.contents as GeminiChat[];

                        // Add the model response part to the request content (only function calls if simplifiedToolUse is enabled)
                        if (db.simplifiedToolUse) {
                            chat.push({
                                role: "model",
                                parts: calls.map((call) => {
                                    return {
                                        functionCall: {
                                            name: call.name,
                                            args: call.args,
                                        },
                                    } as GeminiPart;
                                }),
                            });
                        }
                        // Add the model response part to the request content (text response and function calls)
                        else {
                            chat.push({
                                role: "model",
                                parts: [
                                    {
                                        text: content,
                                        ...(signText ? { thoughtSignature: signText } : {}),
                                    } as GeminiPart,
                                ].concat(
                                    calls.map(
                                        (call, index) =>
                                            ({
                                                functionCall: {
                                                    name: call.name,
                                                    args: call.args,
                                                },
                                                ...(index === 0 && signFunction
                                                    ? { thoughtSignature: signFunction }
                                                    : {}),
                                            }) as GeminiPart,
                                    ),
                                ),
                            });
                        }
                        // If the last part is a model response, merge it with the previous model response
                        if (chat[chat.length - 2]?.role === "model") {
                            chat[chat.length - 2].parts = chat[chat.length - 2].parts.concat(
                                chat[chat.length - 1].parts,
                            );
                            chat.pop();
                        }
                        const parts: GeminiPart[] = [];
                        const callCodes: string[] = [];
                        const tools = arg?.tools ?? [];
                        // Handle tool calls
                        for (const call of calls) {
                            const functionName = call.name;
                            const functionArgs = call.args;
                            const tool = tools.find((t) => t.name === functionName);
                            if (tool) {
                                const result = (await arg.ctx.tools.call(tool.name, functionArgs)).filter((r) => {
                                    return r.type === "text";
                                });
                                if (result.length === 0) {
                                    parts.push({
                                        functionResponse: {
                                            name: call.name,
                                            response: "No response from tool.",
                                        },
                                    });
                                }
                                // Store the encoded tool call history for later use
                                if (arg.rememberToolUsage) {
                                    callCodes.push(
                                        await arg.ctx.tools.encode({
                                            call: {
                                                id: call.id as string,
                                                name: call.name,
                                                arg: call.args,
                                            },
                                            response: result,
                                        }),
                                    );
                                }
                                for (let i = 0; i < result.length; i++) {
                                    let response: any = result[i].text;
                                    try {
                                        //try json parse
                                        response = {
                                            data: JSON.parse(response),
                                        };
                                    } catch (error) {
                                        response = {
                                            data: response,
                                        };
                                    }
                                    parts.push({
                                        functionResponse: {
                                            name: call.name,
                                            response,
                                        },
                                    });
                                }
                            } else {
                                parts.push({
                                    functionResponse: {
                                        name: call.name,
                                        response: `Tool ${call.name} not found.`,
                                    },
                                });
                            }
                        }
                        // Add the user response part to the request content (function responses)
                        chat.push({
                            role: "function",
                            parts: parts,
                        });

                        body.contents = chat;

                        headers["Content-Type"] = "application/json";

                        let resRec;
                        let attempt = 0;
                        let errorFlag = true;

                        do {
                            attempt++;
                            resRec = await arg.ctx.transport.fetchStream(url, {
                                headers: headers,
                                body: JSON.stringify(body),
                                method: "POST",
                                chatId: arg.chatId,
                                signal: arg.abortSignal,
                                interceptor: "gemini_tool",
                            });

                            if (resRec.status == 200) {
                                arg.ctx.transport.addLog({
                                    body: body,
                                    response: "Streaming",
                                    success: true,
                                    url: url,
                                    status: resRec.status,
                                });

                                errorFlag = false;
                                break;
                            }
                        } while (attempt <= db.requestRetrys); // Retry up to db.requestRetrys times

                        if (errorFlag) {
                            arg.ctx.alertError(`Failed to fetch model response after tool execution`);
                            return controller.close();
                        }

                        const transtream = getTranStream({
                            ctx: arg.ctx,
                            modelInfo: arg.modelInfo,
                            saveSignature: arg.saveSignatures ?? false,
                        });
                        // An aborted or failed body errors the transform\'s readable side, which the reader sees;
                        // unhandled, the rejected pipe would end the server process.
                        resRec.body!.pipeTo(transtream.writable).catch(() => {});

                        reader = transtream.readable.getReader();

                        if (db.simplifiedToolUse) {
                            prefix += callCodes.join("\n\n");
                        } else {
                            prefix +=
                                (thoughts + lastThought
                                    ? `<Thoughts>\n\n${thoughts + lastThought}\n\n</Thoughts>\n\n`
                                    : "") +
                                (content ? content + "\n\n" : "") +
                                callCodes.join("\n\n");
                        }

                        controller.enqueue({ "0": prefix });

                        continue;
                    }

                    try {
                        await arg.ctx.intercept(value, "meta_gemini_stream");
                    } catch (e) {
                        console.error("[LLM]", arg.ctx.redactText(String(e)));
                    }
                    return controller.close();
                }

                lastValue = value;

                if (db.streamGeminiThoughts) {
                    controller.enqueue({
                        "0":
                            (prefix ? prefix + "\n\n" : "") +
                            (thoughts ? `<Thoughts>\n\n${thoughts}\n\n</Thoughts>\n\n` : "") +
                            (lastThought ? lastThought + "\n\n" : "") +
                            content,
                    });
                } else {
                    controller.enqueue({
                        "0":
                            (prefix ? prefix + "\n\n" : "") +
                            (thoughts + lastThought
                                ? `<Thoughts>\n\n${thoughts + lastThought}\n\n</Thoughts>\n\n`
                                : "") +
                            content,
                    });
                }
            }
        },
    });
}
