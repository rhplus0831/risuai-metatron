import os from "node:os";
import type { Database } from "../../../shared/database.ts";
import type { HypaModel } from "../../../shared/memory.ts";
import { type BatchResult, TaskCanceledError, TaskRateLimiter } from "../../../shared/taskRateLimiter.ts";
import type { CachedVector, VectorCache } from "../data/vectorCache.ts";
import { createRedactor } from "../llm/redact.ts";
import type { TransformersService } from "./transformers.ts";

/**
 * The server's embeddings: `HypaProcesser` (`src/ts/process/memory/hypamemory.ts`),
 * `HypaProcessorV2` (`hypamemoryv2.ts`), and the Voyage contextual provider
 * (`contextualEmbedding.ts`), ported statement for statement with an `EmbeddingEnv` in place of the
 * client's module state. One env is bound to one job (`createEmbeddings(...).forJob`).
 *
 * What differs from the tab, on purpose:
 * - The vectors are in the server's `VectorCache`, not LocalForage. The cache keys are the client's
 *   (text, `|`, the model, the custom-model suffix; the Voyage suffixes). The cache holds vectors
 *   only: a hit is rebuilt with the text it was asked for, which is what the client stored with it.
 * - The providers are called from the server: OpenAI with the stored memory key (`supaMemoryKey`, a
 *   write-only credential), Voyage and the custom URL with the keys the settings hold. The custom
 *   URL is fetched as the settings name it (the hazard recorded for provider URLs).
 * - A local model runs in the Transformers worker on the CPU; the `GPU` variants run the same model.
 * - A provider's answer is checked before it is used or stored: the expected number of vectors, each
 *   a list of finite numbers, all of one length. Anything else is an error (the client would rank
 *   with it).
 * - Every error text passes the job's embedding redactor (the three keys, in their plain,
 *   JSON-escaped, and URL-encoded forms) before it leaves this module.
 * - `HypaProcesser.testText` is not ported: nothing calls it.
 */
export type VectorArray = number[] | Float32Array;

export type memoryVector = {
    embedding: number[] | Float32Array;
    content: string;
    alreadySaved?: boolean;
};

export type EmbeddingEnv = {
    /** The job's projection: `hypaModel`, `hypaCustomSettings`, `voyageApiKey`. */
    db: Pick<Database, "hypaModel" | "hypaCustomSettings" | "voyageApiKey">;
    /** The stored memory key (`llmSecrets.supaMemoryKey`), for the OpenAI embedding models. */
    supaMemoryKey: string;
    cache: VectorCache;
    /** The cache's generation when the job bound the env: a write after a `clear` is dropped. */
    generation: number;
    transformers: TransformersService;
    signal: AbortSignal;
    fetchImpl: typeof fetch;
    /** Removes the embedding keys from a text. */
    redact(text: string): string;
    /** Whether one of the keys (in any of its forms) occurs in `value`, at any depth. */
    carries(value: unknown): boolean;
};

export type EmbeddingsService = {
    forJob(arg: { db: EmbeddingEnv["db"]; supaMemoryKey: string; signal: AbortSignal }): EmbeddingEnv;
};

export const EMBEDDING_FETCH_TIMEOUT_MS = 120 * 1000;

export function createEmbeddings(options: {
    cache: VectorCache;
    transformers: TransformersService;
    fetchImpl?: typeof fetch;
}): EmbeddingsService {
    return {
        forJob({ db, supaMemoryKey, signal }) {
            // A value of whitespace only is no credential (no request sends it), and as a secret it would
            // match every space of an answer.
            const keys = [supaMemoryKey, db.voyageApiKey, db.hypaCustomSettings?.key].filter(
                (key): key is string => typeof key === "string" && key.trim() !== "",
            );
            // The trimmed forms are what the Authorization headers carry.
            const redactor = createRedactor([...keys, ...keys.map((key) => key.trim())]);
            return {
                db,
                supaMemoryKey,
                cache: options.cache,
                generation: options.cache.generation(),
                transformers: options.transformers,
                signal,
                fetchImpl: options.fetchImpl ?? fetch,
                redact: (text) => redactor.text(text),
                carries: (value) => redactor.carries(value),
            };
        },
    };
}

// In a typical environment, bge-m3 is a heavy model.
export const localModels = {
    models: {
        MiniLM: "Xenova/all-MiniLM-L6-v2",
        MiniLMGPU: "Xenova/all-MiniLM-L6-v2",
        nomic: "nomic-ai/nomic-embed-text-v1.5",
        nomicGPU: "nomic-ai/nomic-embed-text-v1.5",
        bgeSmallEn: "Xenova/bge-small-en-v1.5",
        bgeSmallEnGPU: "Xenova/bge-small-en-v1.5",
        bgem3: "Xenova/bge-m3",
        bgem3GPU: "Xenova/bge-m3",
        multiMiniLM: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
        multiMiniLMGPU: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
        bgeM3Ko: "HyperBlaze/BGE-m3-ko",
        bgeM3KoGPU: "HyperBlaze/BGE-m3-ko",
    } as Record<string, string>,
    gpuModels: ["MiniLMGPU", "nomicGPU", "bgeSmallEnGPU", "bgem3GPU", "multiMiniLMGPU", "bgeM3KoGPU"],
};

const openAIModels: Record<string, string> = {
    ada: "text-embedding-ada-002",
    openai3small: "text-embedding-3-small",
    openai3large: "text-embedding-3-large",
};

/** `appendLastPath` of `src/ts/util.ts`. */
function appendLastPath(url: string, lastPath: string): string {
    url = url.replace(/\/$/, "");
    lastPath = lastPath.replace(/^\//, "");
    return url + "/" + lastPath;
}

/** Raises the job's abort (before work is started, and before a result is used). */
function checkAborted(env: EmbeddingEnv): void {
    if (env.signal.aborted) {
        throw env.signal.reason ?? new Error("request aborted");
    }
}

type FetchResult = { ok: boolean; data: any };

/**
 * The client's `globalFetch` for a JSON POST: the parsed body (the text when it is not JSON) with
 * `ok`, and `{ ok: false, data: "<error>" }` for a failure of the fetch itself. An abort of the job
 * rejects. With `strictJson` it is the client's `auxFetchJson` instead: a body that is not JSON is
 * `ok: false` with the text.
 */
export async function postJson(
    env: EmbeddingEnv,
    url: string,
    arg: { headers?: Record<string, string>; body: unknown },
    options: { strictJson?: boolean } = {},
): Promise<FetchResult> {
    checkAborted(env);
    try {
        const response = await env.fetchImpl(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(arg.headers ?? {}) },
            body: JSON.stringify(arg.body),
            signal: AbortSignal.any([env.signal, AbortSignal.timeout(EMBEDDING_FETCH_TIMEOUT_MS)]),
        });
        const text = await response.text();
        checkAborted(env);
        let data: unknown;
        try {
            data = JSON.parse(text);
        } catch {
            if (options.strictJson) {
                return { ok: false, data: text };
            }
            data = text;
        }
        return { ok: response.ok, data };
    } catch (error) {
        checkAborted(env);
        return { ok: false, data: `${error}` };
    }
}

/** A provider's answer as an error text, without the keys. */
function errorText(env: EmbeddingEnv, data: unknown): string {
    let text: string;
    try {
        text = JSON.stringify(data);
    } catch {
        text = String(data);
    }
    return env.redact(text ?? String(data));
}

/**
 * The vectors a provider or a local model answered: `count` of them, each a list of finite numbers,
 * all of one length. Checked before anything is ranked or stored.
 */
function checkVectors<T extends VectorArray>(vectors: unknown, count: number): T[] {
    const malformed = () => new Error("The embedding provider returned malformed vectors");
    if (!Array.isArray(vectors) || vectors.length !== count) {
        throw malformed();
    }
    let length = -1;
    for (const vector of vectors) {
        const isArray = Array.isArray(vector) || vector instanceof Float32Array;
        if (!isArray || vector.length === 0 || (length !== -1 && vector.length !== length)) {
            throw malformed();
        }
        length = vector.length;
        for (let i = 0; i < vector.length; i++) {
            if (typeof vector[i] !== "number" || !Number.isFinite(vector[i])) {
                throw malformed();
            }
        }
    }
    return vectors as T[];
}

async function localEmbeds(env: EmbeddingEnv, model: string, inputs: string[]): Promise<Float32Array[]> {
    checkAborted(env);
    const results = await env.transformers.runEmbedding(inputs, localModels.models[model], env.signal);
    checkAborted(env);
    return checkVectors<Float32Array>(results, inputs.length);
}

/** The vector under `key`, as the object the client stored with it. */
function loadVector(env: EmbeddingEnv, key: string, content: string): memoryVector | null {
    const embedding: CachedVector | null = env.cache.get(key);
    return embedding ? { content, embedding } : null;
}

function saveVector(env: EmbeddingEnv, key: string, embedding: VectorArray): void {
    if (!env.signal.aborted) {
        env.cache.set(key, embedding, env.generation);
    }
}

export interface ContextualEmbeddingProvider {
    readonly modelId: string;
    embedDocumentGroups(groups: string[][]): Promise<VectorArray[][]>;
    embedQueries(queries: string[]): Promise<VectorArray[]>;
    getCacheKeySuffix(contextTexts?: string[]): string;
}

export function isContextModel(model: string): boolean {
    return model === "voyageContext3";
}

export function getContextProvider(env: EmbeddingEnv, model: string): ContextualEmbeddingProvider | null {
    switch (model) {
        case "voyageContext3":
            return new VoyageContext3Provider(env);
        default:
            return null;
    }
}

const VOYAGE_API_URL = "https://api.voyageai.com/v1/contextualizedembeddings";
const VOYAGE_MODEL = "voyage-context-3";
const MAX_CHUNKS_PER_REQUEST = 16000;
const MAX_INPUTS_PER_REQUEST = 1000;

class VoyageContext3Provider implements ContextualEmbeddingProvider {
    readonly modelId = VOYAGE_MODEL;
    private env: EmbeddingEnv;

    constructor(env: EmbeddingEnv) {
        this.env = env;
    }

    private getApiKey(): string {
        const apiKey = this.env.db.voyageApiKey?.trim();
        if (!apiKey) {
            throw new Error("Voyage Context 3 requires a Voyage API Key");
        }
        return apiKey;
    }

    async embedDocumentGroups(groups: string[][]): Promise<VectorArray[][]> {
        const apiKey = this.getApiKey();
        const batches = this.batchGroups(groups);
        const allResults: VectorArray[][] = new Array(groups.length);

        let groupOffset = 0;
        for (const batch of batches) {
            const response = await postJson(this.env, VOYAGE_API_URL, {
                headers: {
                    Authorization: "Bearer " + apiKey,
                },
                body: {
                    model: VOYAGE_MODEL,
                    inputs: batch,
                    input_type: "document",
                },
            });

            if (!response.ok || !response.data.data) {
                throw new Error(errorText(this.env, response.data));
            }
            if (!Array.isArray(response.data.data) || response.data.data.length !== batch.length) {
                throw new Error("The embedding provider returned malformed vectors");
            }

            for (let i = 0; i < batch.length; i++) {
                const groupEmbeddings: unknown = Array.isArray(response.data.data[i]?.data)
                    ? response.data.data[i].data.map((item: { embedding: VectorArray }) => item?.embedding)
                    : null;
                allResults[groupOffset + i] = checkVectors(groupEmbeddings, batch[i].length);
            }

            groupOffset += batch.length;
        }

        return allResults;
    }

    async embedQueries(queries: string[]): Promise<VectorArray[]> {
        const apiKey = this.getApiKey();
        const response = await postJson(this.env, VOYAGE_API_URL, {
            headers: {
                Authorization: "Bearer " + apiKey,
            },
            body: {
                inputs: queries.map((s) => [s]),
                model: VOYAGE_MODEL,
                input_type: "query",
            },
        });

        if (!response.ok || !response.data.data) {
            throw new Error(errorText(this.env, response.data));
        }

        const embeddings: unknown = Array.isArray(response.data.data)
            ? response.data.data.map((group: { data: { embedding: VectorArray }[] }) => group?.data?.[0]?.embedding)
            : null;
        return checkVectors(embeddings, queries.length);
    }

    getCacheKeySuffix(contextTexts?: string[]): string {
        const ctxPart = contextTexts && contextTexts.length > 1 ? `|ctx:${contextHash(contextTexts)}` : "";
        return `|voyageContext3${ctxPart}`;
    }

    private batchGroups(groups: string[][]): string[][][] {
        const batches: string[][][] = [];
        let currentBatch: string[][] = [];
        let currentChunkCount = 0;

        for (const group of groups) {
            if (
                currentBatch.length > 0 &&
                (currentBatch.length + 1 > MAX_INPUTS_PER_REQUEST ||
                    currentChunkCount + group.length > MAX_CHUNKS_PER_REQUEST)
            ) {
                batches.push(currentBatch);
                currentBatch = [];
                currentChunkCount = 0;
            }
            currentBatch.push(group);
            currentChunkCount += group.length;
        }

        if (currentBatch.length > 0) {
            batches.push(currentBatch);
        }

        return batches;
    }
}

/** The custom embedding server's request (`hypaCustomSettings`), shared by both processors. */
async function customEmbeds(env: EmbeddingEnv, customEmbeddingUrl: string, input: string[] | string) {
    if (!customEmbeddingUrl) {
        throw new Error("Custom model requires a Custom Server URL");
    }
    const replaceUrl = customEmbeddingUrl.endsWith("/embeddings")
        ? customEmbeddingUrl
        : appendLastPath(customEmbeddingUrl, "embeddings");
    const settings = env.db.hypaCustomSettings;
    return await postJson(env, replaceUrl, {
        headers: {
            ...(settings?.key?.trim() ? { Authorization: "Bearer " + settings.key.trim() } : {}),
        },
        body: {
            input: input,
            ...(settings?.model?.trim() ? { model: settings.model.trim() } : {}),
        },
    });
}

/**
 * The OpenAI embedding request: with the processor's own key when it has one, else the stored
 * memory key (the client's `auxFetch` op `openai-embeddings` injects the same one).
 */
async function openAIEmbeds(env: EmbeddingEnv, model: string, input: string[] | string, ownKey?: string) {
    const key = ownKey?.trim() ? ownKey.trim() : env.supaMemoryKey;
    return await postJson(env, "https://api.openai.com/v1/embeddings", {
        headers: { Authorization: "Bearer " + key },
        body: {
            input: input,
            model: openAIModels[model],
        },
    });
}

export class HypaProcesser {
    oaikey: string | undefined;
    vectors: memoryVector[];
    env: EmbeddingEnv;
    model: HypaModel;
    customEmbeddingUrl: string;

    constructor(env: EmbeddingEnv, model: HypaModel | "auto" = "auto", customEmbeddingUrl?: string) {
        this.env = env;
        this.vectors = [];
        const db = env.db;
        if (model === "auto") {
            this.model = db.hypaModel || "MiniLM";
        } else {
            this.model = model;
        }
        this.customEmbeddingUrl = customEmbeddingUrl?.trim() || db.hypaCustomSettings?.url?.trim() || "";
    }

    async embedDocuments(texts: string[]): Promise<VectorArray[]> {
        const subPrompts = chunkArray(texts, 50);

        const embeddings: VectorArray[] = [];

        for (let i = 0; i < subPrompts.length; i += 1) {
            const input = subPrompts[i];

            const data = await this.getEmbeds(input, "document");

            embeddings.push(...data);
        }

        return embeddings;
    }

    async getEmbeds(input: string[] | string, inputType: "query" | "document" = "query"): Promise<VectorArray[]> {
        if (isContextModel(this.model)) {
            const provider = getContextProvider(this.env, this.model)!;
            const inputs: string[] = Array.isArray(input) ? input : [input];
            if (inputType === "query") {
                return await provider.embedQueries(inputs);
            }
            const groups = inputs.map((s) => [s]);
            const results = await provider.embedDocumentGroups(groups);
            return results.map((group) => group[0]);
        }
        if (Object.keys(localModels.models).includes(this.model)) {
            const inputs: string[] = Array.isArray(input) ? input : [input];
            return await localEmbeds(this.env, this.model, inputs);
        }
        let gf: FetchResult | null = null;
        if (this.model === "custom") {
            gf = await customEmbeds(this.env, this.customEmbeddingUrl, input);
        }
        if (this.model === "ada" || this.model === "openai3small" || this.model === "openai3large") {
            gf = await openAIEmbeds(this.env, this.model, input, this.oaikey);
        }
        if (!gf) {
            // The client reads `gf.data` of null here (a TypeError); the model has no provider.
            throw new Error(`Unsupported model: ${this.model}`);
        }
        const data = gf.data;

        if (!gf.ok) {
            throw errorText(this.env, gf.data);
        }

        const result: unknown[] = [];
        if (!Array.isArray(data?.data)) {
            throw new Error("The embedding provider returned malformed vectors");
        }
        for (let i = 0; i < data.data.length; i++) {
            result.push(data.data[i]?.embedding);
        }

        return checkVectors<number[]>(result, Array.isArray(input) ? input.length : 1);
    }

    async addText(texts: string[]) {
        const db = this.env.db;
        const suffix =
            this.model === "custom" && db.hypaCustomSettings?.model?.trim()
                ? `-${db.hypaCustomSettings.model.trim()}`
                : "";

        for (let i = 0; i < texts.length; i++) {
            const itm = loadVector(this.env, texts[i] + "|" + this.model + suffix, texts[i]);
            if (itm) {
                itm.alreadySaved = true;
                this.vectors.push(itm);
            }
        }

        texts = texts.filter((v) => {
            for (let i = 0; i < this.vectors.length; i++) {
                if (this.vectors[i].content === v) {
                    return false;
                }
            }
            return true;
        });

        if (texts.length === 0) {
            return;
        }
        const vectors = await this.embedDocuments(texts);

        const memoryVectors: memoryVector[] = vectors.map((embedding, idx) => ({
            content: texts[idx],
            embedding,
        }));

        for (let i = 0; i < memoryVectors.length; i++) {
            const vec = memoryVectors[i];
            if (!vec.alreadySaved) {
                saveVector(this.env, texts[i] + "|" + this.model + suffix, vec.embedding);
            }
        }

        this.vectors = memoryVectors.concat(this.vectors);
    }

    async similaritySearch(query: string) {
        const results = await this.similaritySearchVectorWithScore((await this.getEmbeds(query))[0]);
        return results.map((result) => result[0]);
    }

    async similaritySearchScored(query: string) {
        return await this.similaritySearchVectorWithScore((await this.getEmbeds(query))[0]);
    }

    private similaritySearchVectorWithScore(query: VectorArray): [string, number][] {
        const memoryVectors = this.vectors;
        const sim = similarity;
        // The client's comparator, kept as it is (it returns 0 where a comparator returns 1).
        const searches = memoryVectors
            .map((vector, index) => ({
                similarity: sim(query, vector.embedding),
                index,
            }))
            .sort((a, b) => (a.similarity > b.similarity ? -1 : 0));

        const result: [string, number][] = searches.map((search) => [
            memoryVectors[search.index].content,
            search.similarity,
        ]);

        return result;
    }

    similarityCheck(query1: number[], query2: number[]) {
        return similarity(query1, query2);
    }

    /** The vector cached under `key` (`this.forage.getItem`), for the HypaV3 subclass. */
    protected cached(key: string, content: string): memoryVector | null {
        return loadVector(this.env, key, content);
    }

    /** `this.forage.setItem(key, vector)`. */
    protected store(key: string, vector: memoryVector): void {
        saveVector(this.env, key, vector.embedding);
    }
}

export function similarity(a: VectorArray, b: VectorArray) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
    }
    return dot;
}

export function cosineSimilarity(a: VectorArray, b: VectorArray): number {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function contextHash(texts: string[]): string {
    let h = 0x811c9dc5;
    const s = texts.join("\0");
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

const chunkArray = <T>(arr: T[], chunkSize: number) =>
    arr.reduce((chunks, elem, index) => {
        const chunkIndex = Math.floor(index / chunkSize);
        const chunk = chunks[chunkIndex] || [];
        chunks[chunkIndex] = chunk.concat([elem]);
        return chunks;
    }, [] as T[][]);

export interface HypaProcessorV2Options {
    model?: HypaModel;
    customEmbeddingUrl?: string;
    oaiKey?: string;
    rateLimiter?: TaskRateLimiter;
}

export interface EmbeddingText<TMetadata> {
    id: string;
    content: string;
    metadata?: TMetadata;
}

export interface EmbeddingResult<TMetadata> extends EmbeddingText<TMetadata> {
    embedding: EmbeddingVector;
}

export type EmbeddingVector = number[] | Float32Array;

export class HypaProcessorV2<TMetadata> {
    public readonly options: Required<HypaProcessorV2Options>;
    public progressCallback: ((queuedCount: number) => void) | null = null;
    public vectors: Map<string, EmbeddingResult<TMetadata>> = new Map();
    private env: EmbeddingEnv;

    public constructor(env: EmbeddingEnv, options?: HypaProcessorV2Options) {
        this.env = env;
        const db = env.db;

        this.options = {
            model: db.hypaModel || "MiniLM",
            customEmbeddingUrl: db.hypaCustomSettings?.url?.trim() || "",
            // No key of its own: the stored memory key is used.
            oaiKey: "",
            rateLimiter: new TaskRateLimiter(),
            ...options,
        } as Required<HypaProcessorV2Options>;
    }

    public async addTexts(ebdTexts: EmbeddingText<TMetadata>[]): Promise<void> {
        await this.getEmbeds(ebdTexts, true);
    }

    public async similaritySearchScored(query: string): Promise<[EmbeddingResult<TMetadata>, number][]> {
        const results = await this.similaritySearchScoredBatch([query]);
        return results[0];
    }

    public async similaritySearchScoredBatch(queries: string[]): Promise<[EmbeddingResult<TMetadata>, number][][]> {
        if (queries.length === 0) {
            return [];
        }

        // Remove duplicate queries
        const uniqueQueries = [...new Set(queries)];

        // Convert queries to EmbeddingText array
        const ebdTexts: EmbeddingText<TMetadata>[] = uniqueQueries.map((query, index) => ({
            id: `query-${index}`,
            content: query,
        }));

        // Get query embeddings (don't save to memory)
        const ebdResults = await this.getEmbeds(ebdTexts, false);

        const scoredResultsMap = new Map<string, [EmbeddingResult<TMetadata>, number][]>();

        // Calculate similarity for each unique query
        for (let i = 0; i < uniqueQueries.length; i++) {
            const ebdResult = ebdResults[i];

            const scoredVectors = Array.from(this.vectors.values())
                .map((vector): [EmbeddingResult<TMetadata>, number] => [
                    vector,
                    this.similarity(ebdResult.embedding, vector.embedding),
                ])
                .sort((a, b) => b[1] - a[1]);

            scoredResultsMap.set(uniqueQueries[i], scoredVectors);
        }

        return queries.map((query) => scoredResultsMap.get(query)!);
    }

    private async getEmbeds(
        ebdTexts: EmbeddingText<TMetadata>[],
        saveToMemory: boolean = true,
    ): Promise<EmbeddingResult<TMetadata>[]> {
        if (ebdTexts.length === 0) {
            return [];
        }

        const resultMap: Map<string, EmbeddingResult<TMetadata>> = new Map();
        const toEmbed: EmbeddingText<TMetadata>[] = [];

        const ctxProvider = isContextModel(this.options.model)
            ? getContextProvider(this.env, this.options.model)
            : null;
        const ctxGroups = new Map<string, string[]>();
        if (ctxProvider && saveToMemory) {
            const groups = new Map<TMetadata | undefined, EmbeddingText<TMetadata>[]>();
            for (const item of ebdTexts) {
                const g = groups.get(item.metadata) || [];
                g.push(item);
                groups.set(item.metadata, g);
            }
            for (const [, g] of groups) {
                const texts = g.map((item) => item.content);
                for (const item of g) {
                    ctxGroups.set(item.id, texts);
                }
            }
        }

        // Load cache
        for (const item of ebdTexts) {
            const { id, content, metadata } = item;

            // Use if already in memory
            if (this.vectors.has(id)) {
                resultMap.set(id, this.vectors.get(id)!);
                continue;
            }

            // The client's cached object is `{ content, embedding }`: a hit has no `id` of its own.
            const cached = loadVector(this.env, this.getCacheKey(content, ctxGroups.get(id)), content) as
                (memoryVector & { metadata?: TMetadata }) | null;

            if (cached) {
                // Add metadata
                cached.metadata = metadata;

                // Save to memory
                if (saveToMemory) {
                    this.vectors.set(id, cached as unknown as EmbeddingResult<TMetadata>);
                }

                resultMap.set(id, cached as unknown as EmbeddingResult<TMetadata>);
            } else {
                toEmbed.push(item);
            }
        }

        if (ctxProvider && toEmbed.length > 0 && saveToMemory) {
            const missMetadatas = new Set(toEmbed.map((item) => item.metadata).filter(Boolean));

            const additionalItems = ebdTexts.filter(
                (item) => item.metadata && missMetadatas.has(item.metadata) && !toEmbed.some((e) => e.id === item.id),
            );

            for (const item of additionalItems) {
                resultMap.delete(item.id);
                if (this.vectors.has(item.id)) {
                    this.vectors.delete(item.id);
                }
            }

            toEmbed.push(...additionalItems);
        }

        if (toEmbed.length === 0) {
            return ebdTexts.map((item) => resultMap.get(item.id)!);
        }

        // Chunking array
        const chunkSize = this.getOptimalChunkSize();

        const chunks = this.chunkArray(toEmbed, chunkSize);

        if (ctxProvider && saveToMemory) {
            const metadataGroups = new Map<TMetadata | undefined, EmbeddingText<TMetadata>[]>();
            for (const item of toEmbed) {
                const key = item.metadata;
                const group = metadataGroups.get(key) || [];
                group.push(item);
                metadataGroups.set(key, group);
            }

            const groupEntries = Array.from(metadataGroups.entries());
            const groups = groupEntries.map(([, group]) => group.map((item) => item.content));

            const results = await ctxProvider.embedDocumentGroups(groups);

            for (let i = 0; i < groupEntries.length; i++) {
                const [, group] = groupEntries[i];
                const embeddings = results[i];

                for (let j = 0; j < group.length; j++) {
                    const { id, content, metadata } = group[j];
                    const embedding = embeddings[j];

                    const ebdResult: EmbeddingResult<TMetadata> = {
                        id,
                        content,
                        embedding,
                        metadata,
                    };

                    saveVector(this.env, this.getCacheKey(content, ctxGroups.get(id)), embedding);

                    if (saveToMemory) {
                        this.vectors.set(id, ebdResult);
                    }

                    resultMap.set(id, ebdResult);
                }
            }
        } else if (this.isLocalModel()) {
            // Local model: Sequential processing
            for (let i = 0; i < chunks.length; i++) {
                // Progress callback
                this.progressCallback?.(chunks.length - i - 1);

                const chunk = chunks[i];
                const embeddings = await this.getLocalEmbeds(chunk.map((item) => item.content));

                embeddings.forEach((embedding, j) => {
                    const { id, content, metadata } = chunk[j];

                    const ebdResult: EmbeddingResult<TMetadata> = {
                        id,
                        content,
                        embedding,
                        metadata,
                    };

                    // Save to DB
                    saveVector(this.env, this.getCacheKey(content), embedding);

                    // Save to memory
                    if (saveToMemory) {
                        this.vectors.set(id, ebdResult);
                    }

                    resultMap.set(id, ebdResult);
                });
            }
        } else {
            // API model: Parallel processing
            const embeddingTasks = chunks.map((chunk) => {
                const contents = chunk.map((item) => item.content);

                return () => this.getAPIEmbeds(contents);
            });

            // Progress callback
            const rateLimiter = this.options.rateLimiter;
            rateLimiter.taskQueueChangeCallback = this.progressCallback;

            // An abort of the job ends the tasks still waiting (one may wait a minute for the rate window).
            const onAbort = () => rateLimiter.cancelPendingTasks("request aborted");
            this.env.signal.addEventListener("abort", onAbort, { once: true });
            let batchResult: BatchResult<EmbeddingVector[]>;
            try {
                checkAborted(this.env);
                batchResult = await rateLimiter.executeBatch<EmbeddingVector[]>(embeddingTasks);
            } finally {
                this.env.signal.removeEventListener("abort", onAbort);
            }
            checkAborted(this.env);
            const errors: Error[] = [];

            batchResult.results.forEach((result, i) => {
                if (!result.success) {
                    errors.push(result.error!);
                    return;
                }

                if (!result.data) {
                    errors.push(new Error("No embeddings found in the response."));
                    return;
                }

                const chunk = chunks[i];
                result.data.forEach((embedding, j) => {
                    const { id, content, metadata } = chunk[j];

                    const ebdResult: EmbeddingResult<TMetadata> = {
                        id,
                        content,
                        embedding,
                        metadata,
                    };

                    // Save to DB
                    saveVector(this.env, this.getCacheKey(content), embedding);

                    // Save to memory
                    if (saveToMemory) {
                        this.vectors.set(id, ebdResult);
                    }

                    resultMap.set(id, ebdResult);
                });
            });

            // Throw major error if there are errors
            if (errors.length > 0) {
                const majorError = errors.find((error) => !(error instanceof TaskCanceledError)) || errors[0];

                throw majorError;
            }
        }

        return ebdTexts.map((item) => resultMap.get(item.id)!);
    }

    private similarity(a: EmbeddingVector, b: EmbeddingVector): number {
        let dot = 0;
        let magA = 0;
        let magB = 0;

        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            magA += a[i] * a[i];
            magB += b[i] * b[i];
        }

        return dot / (Math.sqrt(magA) * Math.sqrt(magB));
    }

    private getCacheKey(content: string, contextTexts?: string[]): string {
        const db = this.env.db;
        const suffix =
            this.options.model === "custom" && db.hypaCustomSettings?.model?.trim()
                ? `-${db.hypaCustomSettings.model.trim()}`
                : "";

        const ctxProvider = isContextModel(this.options.model)
            ? getContextProvider(this.env, this.options.model)
            : null;
        const ctxSuffix = ctxProvider ? ctxProvider.getCacheKeySuffix(contextTexts) : "";

        return `${content}|${this.options.model}${suffix}${ctxSuffix}`;
    }

    /**
     * The client's sizes: 50 for an API, else the browser's WASM branch (its core count, at most 10).
     * A server has no WebGPU; the cores are this process's.
     */
    private getOptimalChunkSize(): number {
        // API
        if (!this.isLocalModel()) {
            return 50;
        }

        const cpuCores = os.availableParallelism() || 4;

        return Math.min(cpuCores, 10);
    }

    private isLocalModel(): boolean {
        return Object.keys(localModels.models).includes(this.options.model);
    }

    private chunkArray<T>(array: T[], size: number): T[][] {
        const chunks: T[][] = [];

        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }

        return chunks;
    }

    private async getLocalEmbeds(contents: string[]): Promise<EmbeddingVector[]> {
        return await localEmbeds(this.env, this.options.model, contents);
    }

    private async getAPIEmbeds(contents: string[]): Promise<EmbeddingVector[]> {
        let response: FetchResult;

        if (this.options.model === "custom") {
            response = await customEmbeds(this.env, this.options.customEmbeddingUrl, contents);
        } else if (["ada", "openai3small", "openai3large"].includes(this.options.model)) {
            response = await openAIEmbeds(this.env, this.options.model, contents, this.options.oaiKey);
        } else if (isContextModel(this.options.model)) {
            const provider = getContextProvider(this.env, this.options.model)!;
            return await provider.embedQueries(contents);
        } else {
            throw new Error(`Unsupported model: ${this.options.model}`);
        }

        if (!response.ok || !response.data.data) {
            throw new Error(errorText(this.env, response.data));
        }
        if (!Array.isArray(response.data.data)) {
            throw new Error("The embedding provider returned malformed vectors");
        }

        const embeddings: EmbeddingVector[] = response.data.data.map((item: { embedding: EmbeddingVector }) => {
            if (!item?.embedding) {
                throw new Error("No embeddings found in the response.");
            }

            return item.embedding;
        });

        return checkVectors(embeddings, contents.length);
    }
}
