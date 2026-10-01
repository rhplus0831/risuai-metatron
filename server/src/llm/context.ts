import type { LLMModel } from "../../../shared/llm.ts";
import type { InlaySignature, LlmInlayEvent, RPCToolCallContent, ToolCallRecord } from "../../../shared/llm/request.ts";
import type { RequestDb } from "./settings.ts";
import type { Transport } from "./transport.ts";

/**
 * Everything the ported request layer reads or calls outside its own arguments. The client
 * equivalents are module imports (`getDatabase`, `globalFetch`, `callTool`, the inlay helpers, ...);
 * on the server each request gets one context, threaded through `RequestDataArgumentExtended.ctx`.
 */
export type RequestContext = {
    db: RequestDb;
    /** `getCurrentCharacter()?.name`: the tab's selected character, `null` for none. */
    selectedCharacterName: string | null;
    /** `arg.currentChar?.name`: the replying character, `null` for none. */
    speakerName: string | null;
    /** `getUserName()`: the request persona's name. */
    userName: string;
    /** The request's own signal (the client went away, the server is shutting down). */
    signal: AbortSignal;
    transport: Transport;
    /** `alertError(message)` in the client's tab (an `Error` sends its message). */
    alertError: (message: string | Error) => void;
    /**
     * Removes the request's credentials from a text: for a provider error an adapter puts into the
     * answer text (which is otherwise sent as the model wrote it).
     */
    redactText: (text: string) => string;
    /** `tokenizeNum` with the main model's tokenizer (`db.aiModel`), as the client counts. */
    tokenizeNum: (text: string) => Promise<ArrayLike<number>>;
    /** `strongBan` (`src/ts/tokenizer.ts`), its cache on the server. */
    strongBan: (text: string, bias: { [key: number]: number }) => Promise<{ [key: number]: number }>;
    /**
     * `risuChatParser(text)` (with `{ chatRef }` when given), evaluated in the client's tab in call
     * order with the request's preset and persona.
     */
    parseCbs: (text: string, chatRef?: { chaId: string; chatId: string } | null) => Promise<string>;
    tools: {
        call: (name: string, args: unknown) => Promise<RPCToolCallContent[]>;
        encode: (record: ToolCallRecord) => Promise<string>;
        decode: (text: string) => Promise<ToolCallRecord | undefined>;
    };
    inlays: {
        /** `saveInlayedSignature`: the event is queued when called, so an unawaited call still precedes later output. */
        saveSignature: (id: string, signature: InlaySignature) => Promise<string>;
        /** `writeInlayImage` of a base64 image (the tab draws it through its canvas). */
        writeImage: (image: { id: string; mimeType: string; data: string }) => Promise<string>;
        /** `setInlayAsset` of an audio data URI. */
        setAsset: (asset: { id: string; name: string; ext: string; data: string }) => Promise<void>;
    };
    /**
     * `bodyIntercepter` (`bodyIntercepterStore`): through the job's channel when the request runs
     * inside a job callback, else the body as it is (recorded).
     */
    intercept: (body: unknown, type: string) => Promise<unknown>;
    /** `supportsInlayImage()`: whether the main model (`db.aiModel`) takes image input. */
    supportsInlayImage: () => boolean;
    /** `getModelInfo` over the static catalogue and the request's dynamic model. */
    getModelInfo: (id: string) => LLMModel;
    /** A Google service-account access token for Vertex, cached on the server. */
    vertexAccessToken: (clientEmail: string, privateKey: string) => Promise<string>;
    /** `registerClaudeObserver`. */
    registerClaudeObserver: (arg: { url: string; body: any; headers: { [key: string]: string } }) => void;
};
