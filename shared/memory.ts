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
    | "voyageContext3"
    | "voyageContext4"
    | "voyage4Large"
    | "voyage4"
    | "voyage4Lite";

/**
 * The Voyage models, by `hypaModel` value: the API model id and the name the settings show. All use
 * `voyageApiKey`. The contextual ones answer `/v1/contextualizedembeddings` (a vector per chunk, with
 * the chunk's group as its context); the others `/v1/embeddings` (a vector per text, with
 * `input_type` query or document; the Voyage 4 models share one embedding space).
 */
export const VOYAGE_CONTEXT_MODELS: Record<string, { id: string; name: string }> = {
    voyageContext3: { id: "voyage-context-3", name: "Voyage Context 3" },
    voyageContext4: { id: "voyage-context-4", name: "Voyage Context 4" },
};

export const VOYAGE_EMBEDDING_MODELS: Record<string, { id: string; name: string }> = {
    voyage4Large: { id: "voyage-4-large", name: "Voyage 4 Large" },
    voyage4: { id: "voyage-4", name: "Voyage 4" },
    voyage4Lite: { id: "voyage-4-lite", name: "Voyage 4 Lite" },
};

export function isVoyageContextModel(model: string): boolean {
    return Object.hasOwn(VOYAGE_CONTEXT_MODELS, model);
}

export function isVoyageEmbeddingModel(model: string): boolean {
    return Object.hasOwn(VOYAGE_EMBEDDING_MODELS, model);
}

/** The error of a Voyage model without `voyageApiKey`. */
export function voyageKeyMissing(model: string): Error {
    const name = (VOYAGE_CONTEXT_MODELS[model] ?? VOYAGE_EMBEDDING_MODELS[model])?.name ?? "Voyage";
    return new Error(`${name} requires a Voyage API Key`);
}

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
    /** Assigned at creation (`createHypaV3Preset`); `hypaV3PresetId` selects by it. */
    id: string;
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
    /** Uncovered history tokens a send may leave without summaries before it asks first; 0 asks on any gap. */
    gapConfirmTokens: number;
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

// A job's memory write (`server/src/prompt/assemble.ts`) is built from the chat as stored at the
// write, not from the copy its algorithm read before the summarization await: a change saved
// meanwhile (the HypaV3 modal, the HypaV2 editor, another tab) is kept, and the job's own changes
// (orphaned summaries removed, new summaries appended, the selection metrics) are
// applied onto it. Where the stored value moved in a way the job's changes cannot be placed on, the
// write is skipped: the stored value stands, this send's prompt already used the job's summaries,
// and the next send summarizes again what the stored summaries do not cover.

/**
 * A summary's message ids as the algorithms read them (`new Set` of the list, a legacy `null` and
 * `undefined` as one value): duplicates once, in first-occurrence order. Never sorted: the last id
 * is where the next summary starts.
 */
function canonicalMemos(memos: unknown): (string | null)[] {
    return Array.isArray(memos) ? [...new Set(memos.map((memo) => (memo ?? null) as string | null))] : [];
}

/** A summary's identity (summaries carry no id): the message ids it covers. */
export function summaryKey(summary: { chatMemos: unknown }): string {
    return JSON.stringify(canonicalMemos(summary.chatMemos));
}

function hasDuplicates<T>(keys: readonly T[]): boolean {
    return new Set(keys).size !== keys.length;
}

/** Where the next summary starts: after the last id of the last summary ("none" without one). */
function tailOf(lastIds: readonly unknown[], present: boolean): string {
    return present ? `id:${JSON.stringify(lastIds.at(-1)) ?? "undefined"}` : "none";
}

function summaryTail(summaries: readonly SerializableSummary[]): string {
    const last = summaries.at(-1);
    return tailOf(last ? canonicalMemos(last.chatMemos) : [], last !== undefined);
}

type HypaV3Metrics = NonNullable<HypaV3Data["metrics"]>;

/** Each valid index of `metrics` through `map`; invalid or unresolved indices are dropped. */
function remapMetrics(
    metrics: HypaV3Metrics,
    summaryCount: number,
    map: (index: number) => number | undefined,
): HypaV3Metrics {
    const each = (list: unknown): number[] =>
        Array.isArray(list)
            ? list.flatMap((index) => {
                  const mapped = Number.isInteger(index) && index >= 0 && index < summaryCount ? map(index) : undefined;
                  return mapped === undefined ? [] : [mapped];
              })
            : [];
    return {
        lastImportantSummaries: each(metrics.lastImportantSummaries),
        lastRecentSummaries: each(metrics.lastRecentSummaries),
        lastSimilarSummaries: each(metrics.lastSimilarSummaries),
        lastRandomSummaries: each(metrics.lastRandomSummaries),
    };
}

/** Whether the summaries and message-id lists can be used for a divergent V3 write. */
function isHypaV3DataShape(data: unknown): data is SerializableHypaV3Data {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        return false;
    }
    const { summaries } = data as Partial<SerializableHypaV3Data>;
    return (
        Array.isArray(summaries) &&
        summaries.every(
            (summary) =>
                typeof summary === "object" &&
                summary !== null &&
                !Array.isArray(summary) &&
                Array.isArray(summary.chatMemos),
        )
    );
}

/**
 * The `hypaV3Data` a job writes: its algorithm's `result`, computed from `baseline` (the chat's
 * value as the algorithm read it), placed onto `stored` (the chat's value now). Null: skip the
 * write.
 *
 * - Unchanged since the read (`stored` equals `baseline`): `result` as it is.
 * - Otherwise summaries are matched by `summaryKey`. `result` is the baseline's summaries the
 *   algorithm kept (orphan cleanup only removes) followed by the ones it added. The removed ones
 *   leave `stored` too (their messages are absent from the algorithm's input, including disabled
 *   messages, so an edit made meanwhile goes with them); every other stored summary stays as stored
 *   (text, importance, category and tag edits survive, as do deletions and merges in the middle);
 *   the added ones are appended.
 * - Skipped when the placement is not sound: damaged summary containers or items, duplicate keys in
 *   `baseline` or `stored` (no identity), a stored last summary that ends at another message than the
 *   kept one (a reset, "delete after", tail deletion or conversion only when it moves that cursor), or an
 *   added summary covering a message a stored summary already covers.
 * - `metrics` (indices into the summaries): when the algorithm recomputed them
 *   (`metricsRecomputed`: a successful run that ended with summaries), the result's selection is
 *   carried to the merged positions; otherwise the stored selection is shifted past the removals.
 * - The other fields (`categories`, `modalSettings`) are the stored ones; the legacy
 *   `lastSelectedSummaries` goes when the result dropped it, as a write of the result would.
 */
export function mergeHypaV3Write(
    baseline: SerializableHypaV3Data | undefined,
    result: SerializableHypaV3Data,
    stored: SerializableHypaV3Data | undefined,
    metricsRecomputed: boolean,
): SerializableHypaV3Data | null {
    if (JSON.stringify(stored) === JSON.stringify(baseline)) {
        return result;
    }
    if (
        (baseline !== undefined && !isHypaV3DataShape(baseline)) ||
        (stored !== undefined && !isHypaV3DataShape(stored)) ||
        !isHypaV3DataShape(result)
    ) {
        return null;
    }
    const baseKeys = (baseline?.summaries ?? []).map(summaryKey);
    const storedSummaries = stored?.summaries ?? [];
    const storedKeys = storedSummaries.map(summaryKey);
    if (hasDuplicates(baseKeys) || hasDuplicates(storedKeys)) {
        return null;
    }
    const baseSet = new Set(baseKeys);
    let keptCount = 0;
    while (keptCount < result.summaries.length && baseSet.has(summaryKey(result.summaries[keptCount]))) {
        keptCount++;
    }
    const kept = result.summaries.slice(0, keptCount);
    const added = result.summaries.slice(keptCount);
    if (added.some((summary) => baseSet.has(summaryKey(summary)))) {
        return null;
    }
    const keptKeys = new Set(kept.map(summaryKey));
    const removed = new Set(baseKeys.filter((key) => !keptKeys.has(key)));

    const summaries: SerializableSummary[] = [];
    const storedToMerged = new Map<number, number>();
    storedSummaries.forEach((summary, index) => {
        if (!removed.has(storedKeys[index])) {
            storedToMerged.set(index, summaries.length);
            summaries.push(summary);
        }
    });
    if (summaryTail(summaries) !== summaryTail(kept)) {
        return null;
    }
    const covered = new Set(summaries.flatMap((summary) => canonicalMemos(summary.chatMemos)));
    if (added.some((summary) => canonicalMemos(summary.chatMemos).some((memo) => covered.has(memo)))) {
        return null;
    }
    const mergedIndexOf = new Map(summaries.map((summary, index) => [summaryKey(summary), index]));
    const addedStart = summaries.length;
    summaries.push(...added);

    let metrics: HypaV3Metrics | undefined;
    if (metricsRecomputed && result.metrics) {
        metrics = remapMetrics(result.metrics, result.summaries.length, (index) =>
            index < keptCount ? mergedIndexOf.get(summaryKey(result.summaries[index])) : addedStart + index - keptCount,
        );
    } else if (stored?.metrics) {
        metrics = remapMetrics(stored.metrics, storedSummaries.length, (index) => storedToMerged.get(index));
    }

    const merged: SerializableHypaV3Data = { ...stored, summaries };
    if (metrics) {
        merged.metrics = metrics;
    } else {
        delete merged.metrics;
    }
    if (!("lastSelectedSummaries" in result)) {
        delete merged.lastSelectedSummaries;
    }
    return merged;
}

/** Whether `data` is `SerializableHypaV2Data` (not the old `targetId` shape, not damaged). */
function isHypaV2DataShape(data: unknown): data is SerializableHypaV2Data {
    if (typeof data !== "object" || data === null) {
        return false;
    }
    const { mainChunks, chunks } = data as Partial<SerializableHypaV2Data>;
    return (
        Array.isArray(mainChunks) &&
        Array.isArray(chunks) &&
        mainChunks.every(
            (chunk) =>
                typeof chunk === "object" &&
                chunk !== null &&
                typeof chunk.id === "number" &&
                Array.isArray(chunk.chatMemos),
        ) &&
        chunks.every((chunk) => typeof chunk === "object" && chunk !== null && typeof chunk.mainChunkID === "number")
    );
}

/**
 * The `hypaV2Data` a job writes, by `mergeHypaV3Write`'s rule: `result` when the chat's value is
 * unchanged since the read, otherwise the job's changes placed onto `stored`, or null (skip).
 *
 * - A main chunk's identity is its `id` with its message ids: cleanup resets `lastMainChunkID` to
 *   the last kept chunk, so a new chunk can reuse a removed chunk's id.
 * - The main chunks the algorithm removed leave `stored` with their retrieval `chunks`; the stored
 *   chunks' text edits (the HypaV2 editor) stay; the added main chunks and their `chunks` are
 *   appended, and `lastMainChunkID` is the last main chunk's id (0 without one), as cleanup sets it.
 * - Skipped when either value is not the current shape (the algorithm converted an old-shape
 *   value, which cannot be replayed onto another), on duplicate numeric ids in baseline or stored
 *   (retrieval chunks resolve their parents by id alone), when the stored last main chunk ends at
 *   another message (`lastChatMemo`) than the kept one, or when an added main
 *   chunk's id or messages are already in a retained stored one.
 */
export function mergeHypaV2Write(
    baseline: SerializableHypaV2Data | undefined,
    result: SerializableHypaV2Data,
    stored: SerializableHypaV2Data | undefined,
): SerializableHypaV2Data | null {
    if (JSON.stringify(stored) === JSON.stringify(baseline)) {
        return result;
    }
    if (
        (baseline !== undefined && !isHypaV2DataShape(baseline)) ||
        (stored !== undefined && !isHypaV2DataShape(stored))
    ) {
        return null;
    }
    type MainChunk = SerializableHypaV2Data["mainChunks"][number];
    const identity = (chunk: MainChunk) => `${chunk.id}\u0000${summaryKey(chunk)}`;
    const mainTail = (chunks: readonly MainChunk[]) => {
        const last = chunks.at(-1);
        return tailOf(last ? [last.lastChatMemo] : [], last !== undefined);
    };
    const baseMain = baseline?.mainChunks ?? [];
    const baseIds = baseMain.map(identity);
    const storedMain = stored?.mainChunks ?? [];
    const storedIds = storedMain.map(identity);
    if (hasDuplicates(baseMain.map((chunk) => chunk.id)) || hasDuplicates(storedMain.map((chunk) => chunk.id))) {
        return null;
    }
    const baseSet = new Set(baseIds);
    let keptCount = 0;
    while (keptCount < result.mainChunks.length && baseSet.has(identity(result.mainChunks[keptCount]))) {
        keptCount++;
    }
    const kept = result.mainChunks.slice(0, keptCount);
    const added = result.mainChunks.slice(keptCount);
    if (added.some((chunk) => baseSet.has(identity(chunk)))) {
        return null;
    }
    const keptIds = new Set(kept.map(identity));
    const removed = new Set(baseIds.filter((id) => !keptIds.has(id)));
    const mainChunks = storedMain.filter((_, index) => !removed.has(storedIds[index]));
    if (mainTail(mainChunks) !== mainTail(kept)) {
        return null;
    }
    const mainIds = new Set(mainChunks.map((chunk) => chunk.id));
    const covered = new Set(mainChunks.flatMap((chunk) => canonicalMemos(chunk.chatMemos)));
    if (
        added.some(
            (chunk) => mainIds.has(chunk.id) || canonicalMemos(chunk.chatMemos).some((memo) => covered.has(memo)),
        )
    ) {
        return null;
    }
    const addedIds = new Set(added.map((chunk) => chunk.id));
    const chunks = [
        ...(stored?.chunks ?? []).filter((chunk) => mainIds.has(chunk.mainChunkID)),
        ...result.chunks.filter((chunk) => addedIds.has(chunk.mainChunkID)),
    ];
    mainChunks.push(...added);
    return { ...stored, lastMainChunkID: mainChunks.at(-1)?.id ?? 0, mainChunks, chunks };
}
