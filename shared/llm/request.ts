// The wire contract of `POST /api/llm/request` (Phase 5, `request-layer-and-llm-secrets`): the
// request body the client transport sends, the SSE events the server answers with, and the
// callback answers. Both runtimes compile this file; keep it free of DOM types and runes.

import type { LLMFormat, LLMModel, LLMTokenizer } from "../llm.ts";
import type { OpenAIChat } from "../openai.ts";

export type ModelModeExtended = "model" | "submodel" | "memory" | "emotion" | "otherAx" | "translate";

export const MODEL_MODES: readonly ModelModeExtended[] = [
    "model",
    "submodel",
    "memory",
    "emotion",
    "otherAx",
    "translate",
];

/** An MCP tool as the adapters send it to a provider (`MCPTool` without its annotations). */
export type ToolDescriptor = { name: string; description: string; inputSchema: unknown };

export type RPCToolCallContent =
    | { type: "text"; text: string }
    | { type: "image" | "audio"; data: string; mimeType: string }
    | { type: "resource"; resource: { uri: string; mimeType: string; text: string } };

/** A remembered tool call (`src/ts/process/mcp/mcp.ts` `toolCallData`). */
export type ToolCallRecord = {
    call: { id: string; name: string; arg: any };
    response: RPCToolCallContent[];
};

export interface StreamResponseChunk {
    [key: string]: string;
}

export type RequestSpecial = { emotion?: string };

/** `requestDataResponse` without the streaming variant's stream. */
export type BufferedResponse =
    | {
          type: "success" | "fail";
          result: string;
          noRetry?: boolean;
          special?: RequestSpecial;
          failByServerError?: boolean;
          model?: string;
      }
    | {
          type: "multiline";
          result: ["user" | "char", string][];
          special?: RequestSpecial;
          model?: string;
      };

/** The serializable fields of the client's `requestDataArgument`. */
export type RequestArgs = {
    formated: OpenAIChat[];
    bias: { [key: number]: number };
    biasString?: [string, number][];
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
    chatRef?: { chaId: string; chatId: string } | null;
    noMultiGen?: boolean;
    schema?: string;
    extractJson?: string;
    imageResponse?: boolean;
    previewBody?: boolean;
    staticModel?: string;
    rememberToolUsage?: boolean;
};

export const REQUEST_ARG_KEYS = [
    "formated",
    "bias",
    "biasString",
    "temperature",
    "maxTokens",
    "PresensePenalty",
    "frequencyPenalty",
    "useStreaming",
    "forceStreaming",
    "isGroupChat",
    "useEmotion",
    "continue",
    "chatId",
    "chatRef",
    "noMultiGen",
    "schema",
    "extractJson",
    "imageResponse",
    "previewBody",
    "staticModel",
    "rememberToolUsage",
] as const satisfies readonly (keyof RequestArgs)[];

export type LlmRequestBody = {
    clientId: string;
    mode: ModelModeExtended;
    /** The ids the request reads its settings by; the client resolved its selection fallback. */
    context: {
        presetId: string;
        /** The effective persona (bound to the chat, else selected), whose name is `getUserName()`. */
        personaId: string;
        /** The tab's selected persona. */
        selectedPersonaId: string;
        /** The tab's selected character, whose name most adapters use. */
        selectedCharacterId: string | null;
        /** `arg.currentChar` (a group's replying member), whose name Ollama uses. */
        speakerId: string | null;
        /** Whether the tab's main model (`getModelInfo(db.aiModel)`) takes images (`supportsInlayImage`). */
        mainModel: { imageInput: boolean };
        /**
         * The tab's `encode` scope when the request started (`src/ts/tokenizer.ts`): the client
         * tokenizes bias strings with its main model and its settings, whatever model and preset
         * the request uses.
         */
        tokenizer: {
            aiModel: string;
            currentPluginProvider: string;
            modelTokenizer: LLMTokenizer;
            modelInternalID?: string;
            /** The legacy plugin provider's declared tokenizer (`pluginHooks.providerOptions`), or `"none"`. */
            pluginTokenizer: string;
            customTokenizer: string;
            googleClaudeTokenizing: boolean;
            useTokenizerCaching: boolean;
        };
    };
    arg: RequestArgs;
    tools: ToolDescriptor[];
    /** `decodeToolCall(inner)` for every tool-call marker in `arg.formated`, by the marker's inner text. */
    toolRecords: Record<string, ToolCallRecord>;
    /** The descriptor of a model from the tab's dynamic registry (the server knows only the static list). */
    dynamicModel?: LLMModel;
    /** The job callback this request runs inside (`currentChannelCall()`), if any. */
    channelCall?: { jobId: string; callbackId: string };
};

/** A Gemini thought signature stored as an inlay (`src/ts/process/files/inlays.ts`). */
export type InlaySignature = {
    signatures: { type: "function" | "text"; content: string }[];
    sourceFormat: LLMFormat;
    source: string;
};

export type LlmInlayEvent =
    | { kind: "signature"; id: string; signature: InlaySignature }
    | { kind: "image"; id: string; mimeType: string; data: string }
    | { kind: "audio"; id: string; name: string; ext: string; data: string };

export type LlmCallbackName = "mcpTool" | "cbs";

export type LlmCallbackPayloads = {
    mcpTool: { name: string; args: unknown };
    /** `risuChatParser(text, chatRef ? { chatRef } : undefined)` with the request's preset and persona. */
    cbs: { text: string; chatRef: { chaId: string; chatId: string } | null };
};

/** The server's events, one JSON object per SSE `data:` line, in order. */
export type LlmRequestEvent =
    | { type: "accepted"; id: string }
    | { type: "log"; entry: unknown }
    | { type: "notice"; kind: "alertError"; message: string }
    | { type: "inlay"; inlay: LlmInlayEvent }
    | { type: "toolRecord"; record: ToolCallRecord }
    | {
          [N in LlmCallbackName]: { type: "callback"; id: string; name: N; payload: LlmCallbackPayloads[N] };
      }[LlmCallbackName]
    | { type: "result"; response: BufferedResponse }
    | { type: "streaming"; special?: RequestSpecial; model?: string }
    | { type: "chunk"; set?: Record<string, string>; append?: Record<string, string>; remove?: string[] }
    /** OobaLegacy enqueues its cumulative text as a string, not a chunk map; it travels as it is. */
    | { type: "chunkText"; value: string }
    | { type: "end" }
    | { type: "error"; message: string };

export type LlmCallbackAnswer =
    | { callbackId: string; outcome: "answered"; value: unknown }
    | { callbackId: string; outcome: "failed"; error: string };

/** How long the server waits for one callback answer (absolute, from the event). */
export const LLM_CALLBACK_TIMEOUT_MS = 60_000;
