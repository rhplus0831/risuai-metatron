import type { MultiModal, OpenAIChat } from "../openai.ts";
import type { LLMModel } from "../llm.ts";
import { imageTokens, NON_IMAGE_TOKENS } from "./imageTokens.ts";

/**
 * A prompt's token arithmetic, shared by the client (`ChatTokenizer`) and the server: each
 * message's text plus `chatAdditionalTokens`, its name, its thoughts, and model-specific images.
 */
export type ChatTokenHost = {
    count: (text: string) => Promise<number>;
    /** Whether the model takes inlay images (`supportsInlayImage` on the client). */
    supportsInlayImage: () => boolean;
    /** Main model metadata; omitted by count-only hosts, which use the unknown-model fallback. */
    mainModel?: () => LLMModel;
    /** OpenRouter/NanoGPT's selected wire id, otherwise undefined. Both production hosts supply this. */
    requestModel?: () => string | undefined;
    /** `low` selects the model's low rule only for formats that send detail; everything else is high. */
    gptVisionQuality: () => string | undefined;
};

export class ChatTokenCounter {
    private host: ChatTokenHost;

    private chatAdditionalTokens: number;
    private useName: "name" | "noName";

    constructor(chatAdditionalTokens: number, useName: "name" | "noName", host: ChatTokenHost) {
        this.chatAdditionalTokens = chatAdditionalTokens;
        this.useName = useName;
        this.host = host;
    }
    async tokenizeChat(
        data: OpenAIChat,
        args: {
            countThoughts?: boolean;
        } = {},
    ) {
        let tokens = (await this.host.count(data.content)) + this.chatAdditionalTokens;
        if (data.name && this.useName === "name") {
            tokens += (await this.host.count(data.name)) + 1;
        }
        if (data.multimodals && data.multimodals.length > 0) {
            for (const multimodal of data.multimodals) {
                tokens += await this.tokenizeMultiModal(multimodal);
            }
        }
        if (data.thoughts && data.thoughts.length > 0 && args.countThoughts) {
            for (const thought of data.thoughts) {
                tokens += (await this.host.count(thought)) + 1;
            }
        }
        return tokens;
    }
    async tokenizeChats(data: OpenAIChat[]) {
        let tokens = 0;
        for (const chat of data) {
            tokens += await this.tokenizeChat(chat);
        }
        return tokens;
    }

    tokenizeMultiModal(data: MultiModal) {
        if (!this.host.supportsInlayImage()) {
            return this.chatAdditionalTokens;
        }
        if (data.type !== "image") {
            return NON_IMAGE_TOKENS;
        }
        return imageTokens(data, this.host.mainModel?.(), this.host.requestModel?.(), this.host.gptVisionQuality());
    }
}
