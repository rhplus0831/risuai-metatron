// Prompt message shapes persisted on messages (`MessagePresetInfo.promptText`).

export interface OpenAIChat {
    role: "system" | "user" | "assistant" | "function";
    content: string;
    memo?: string;
    name?: string;
    removable?: boolean;
    attr?: string[];
    multimodals?: MultiModal[];
    thoughts?: string[];
    cachePoint?: boolean;
}

export interface MultiModal {
    type: "image" | "video" | "audio" | "signature";
    base64: string;
    height?: number;
    width?: number;
}
