import type { MultiModal, OpenAIChat } from "../openai.ts";

/**
 * A prompt's token arithmetic, shared by the client (`ChatTokenizer`) and the server: each
 * message's text plus `chatAdditionalTokens`, its name, its thoughts, and the image tile formula.
 */
export type ChatTokenHost = {
    encode: (text: string) => Promise<ArrayLike<number>>;
    /** Whether the model takes inlay images (`supportsInlayImage` on the client). */
    supportsInlayImage: () => boolean;
    /** `gptVisionQuality` (`low` counts every image as 87). */
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
        let encoded = (await this.host.encode(data.content)).length + this.chatAdditionalTokens;
        if (data.name && this.useName === "name") {
            encoded += (await this.host.encode(data.name)).length + 1;
        }
        if (data.multimodals && data.multimodals.length > 0) {
            for (const multimodal of data.multimodals) {
                encoded += await this.tokenizeMultiModal(multimodal);
            }
        }
        if (data.thoughts && data.thoughts.length > 0 && args.countThoughts) {
            for (const thought of data.thoughts) {
                encoded += (await this.host.encode(thought)).length + 1;
            }
        }
        return encoded;
    }
    async tokenizeChats(data: OpenAIChat[]) {
        let encoded = 0;
        for (const chat of data) {
            encoded += await this.tokenizeChat(chat);
        }
        return encoded;
    }

    tokenizeMultiModal(data: MultiModal) {
        if (!this.host.supportsInlayImage()) {
            return this.chatAdditionalTokens;
        }
        if (this.host.gptVisionQuality() === "low") {
            return 87;
        }

        let encoded = this.chatAdditionalTokens;
        let height = data.height ?? 0;
        let width = data.width ?? 0;

        if (height === width) {
            if (height > 768) {
                height = 768;
                width = 768;
            }
        } else if (height > width) {
            if (width > 768) {
                width = 768;
                height = height * (768 / width);
            }
        } else {
            if (height > 768) {
                height = 768;
                width = width * (768 / height);
            }
        }

        const chunkSize = Math.ceil(width / 512) * Math.ceil(height / 512);
        encoded += chunkSize * 2;
        encoded += 85;

        return encoded;
    }
}
