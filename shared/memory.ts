// Long-term memory shapes persisted on chats (`hypaV2Data`, `hypaV3Data`) and in settings.

export const DISPLAY_MODE = {
    All: "All",
    Range: "Range",
    Recent: "Recent",
} as const;

export type DisplayMode = (typeof DISPLAY_MODE)[keyof typeof DISPLAY_MODE];

export type HypaModel =
    | "custom"
    | "ada"
    | "openai3small"
    | "openai3large"
    | "MiniLM"
    | "MiniLMGPU"
    | "nomic"
    | "nomicGPU"
    | "bgeSmallEn"
    | "bgeSmallEnGPU"
    | "bgem3"
    | "bgem3GPU"
    | "multiMiniLM"
    | "multiMiniLMGPU"
    | "bgeM3Ko"
    | "bgeM3KoGPU"
    | "voyageContext3";

export interface HypaV2Data {
    lastMainChunkID: number; // can be removed, but exists to more readability of the code.
    mainChunks: {
        // summary itself
        id: number;
        text: string;
        chatMemos: Set<string>; // UUIDs of summarized chats
        lastChatMemo: string;
    }[];
    chunks: {
        // split mainChunks for retrieval or something. Although quite uncomfortable logic, so maybe I will delete it soon.
        mainChunkID: number;
        text: string;
    }[];
}

// Reuse HypaV2Data and override only chatMemos in mainChunks
export interface SerializableHypaV2Data extends Omit<HypaV2Data, "mainChunks"> {
    mainChunks: {
        id: number;
        text: string;
        chatMemos: string[]; // Override Set<string> with string[]
        lastChatMemo: string;
    }[];
}

export interface HypaV3Preset {
    name: string;
    settings: HypaV3Settings;
}

export interface HypaV3Settings {
    summarizationModel: string;
    summarizationPrompt: string;
    reSummarizationPrompt: string;
    memoryTokensRatio: number;
    extraSummarizationRatio: number;
    maxChatsPerSummary: number;
    recentMemoryRatio: number;
    similarMemoryRatio: number;
    enableSimilarityCorrection: boolean;
    preserveOrphanedMemory: boolean;
    processRegexScript: boolean;
    doNotSummarizeUserMessage: boolean;
    summaryChunkSeparator: string;
    // Experimental
    useExperimentalImpl: boolean;
    summarizationRequestsPerMinute: number;
    summarizationMaxConcurrent: number;
    embeddingRequestsPerMinute: number;
    embeddingMaxConcurrent: number;
    alwaysToggleOn: boolean;
    queryChatCount: number;
}

export interface HypaV3Data {
    summaries: Summary[];
    categories?: { id: string; name: string }[];
    lastSelectedSummaries?: number[]; // legacy
    metrics?: {
        lastImportantSummaries: number[];
        lastRecentSummaries: number[];
        lastSimilarSummaries: number[];
        lastRandomSummaries: number[];
    };
    modalSettings?: {
        displayMode: DisplayMode;
        displayRangeFrom: number;
        displayRangeTo: number;
        displayRecentCount: number;
        displayImportant: boolean;
        displaySelected: boolean;
    };
}

export interface SerializableHypaV3Data extends Omit<HypaV3Data, "summaries"> {
    summaries: SerializableSummary[];
}

export interface Summary {
    text: string;
    chatMemos: Set<string>;
    isImportant: boolean;
    categoryId?: string;
    tags?: string[];
}

export interface SerializableSummary extends Omit<Summary, "chatMemos"> {
    chatMemos: string[];
}
