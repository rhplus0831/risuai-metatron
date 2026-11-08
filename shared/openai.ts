/**
 * Prompt message and multimodal shapes shared by the tab and server, including prompt snapshots
 * stored in `MessagePresetInfo.promptText` in `shared/database.ts`. Provider-specific conversion
 * belongs to callers; these interfaces perform no validation or media loading.
 */

/** A prompt message with optional names, assembly metadata, media, thoughts, and cache hints. */
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

/** One base64 media or signature payload with optional image dimensions. */
export interface MultiModal {
    type: "image" | "video" | "audio" | "signature";
    base64: string;
    height?: number;
    width?: number;
}
