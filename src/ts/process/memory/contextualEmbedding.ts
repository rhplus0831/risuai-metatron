import { settings } from "../../storage/settingsViews.svelte";
import { globalFetch } from "src/ts/globalApi.svelte";
import { contextHash, type VectorArray } from "./hypamemory";
import { VOYAGE_CONTEXT_MODELS, isVoyageContextModel, voyageKeyMissing } from "../../../../shared/memory.ts";

export interface ContextualEmbeddingProvider {
    readonly modelId: string;
    embedDocumentGroups(groups: string[][]): Promise<VectorArray[][]>;
    embedQueries(queries: string[]): Promise<VectorArray[]>;
    getCacheKeySuffix(contextTexts?: string[]): string;
}

export function isContextModel(model: string): boolean {
    return isVoyageContextModel(model);
}

export function getContextProvider(model: string): ContextualEmbeddingProvider | null {
    return isVoyageContextModel(model) ? new VoyageContextProvider(model) : null;
}

const VOYAGE_API_URL = "https://api.voyageai.com/v1/contextualizedembeddings";
const MAX_CHUNKS_PER_REQUEST = 16000;
const MAX_INPUTS_PER_REQUEST = 1000;

class VoyageContextProvider implements ContextualEmbeddingProvider {
    readonly modelId: string;
    /** The `hypaModel` value, which names the vectors in the cache keys. */
    private readonly model: string;

    constructor(model: string) {
        this.model = model;
        this.modelId = VOYAGE_CONTEXT_MODELS[model].id;
    }

    private getApiKey(): string {
        const apiKey = settings.secrets.voyageApiKey?.trim();
        if (!apiKey) {
            throw voyageKeyMissing(this.model);
        }
        return apiKey;
    }

    async embedDocumentGroups(groups: string[][]): Promise<VectorArray[][]> {
        const apiKey = this.getApiKey();
        const batches = this.batchGroups(groups);
        const allResults: VectorArray[][] = new Array(groups.length);

        let groupOffset = 0;
        for (const batch of batches) {
            const response = await globalFetch(VOYAGE_API_URL, {
                headers: {
                    Authorization: "Bearer " + apiKey,
                    "Content-Type": "application/json",
                },
                body: {
                    model: this.modelId,
                    inputs: batch,
                    input_type: "document",
                },
            });

            if (!response.ok || !response.data.data) {
                throw new Error(JSON.stringify(response.data));
            }

            for (let i = 0; i < batch.length; i++) {
                const groupEmbeddings: VectorArray[] = response.data.data[i].data.map(
                    (item: { embedding: VectorArray }) => item.embedding,
                );
                allResults[groupOffset + i] = groupEmbeddings;
            }

            groupOffset += batch.length;
        }

        return allResults;
    }

    async embedQueries(queries: string[]): Promise<VectorArray[]> {
        const apiKey = this.getApiKey();
        const response = await globalFetch(VOYAGE_API_URL, {
            headers: {
                Authorization: "Bearer " + apiKey,
                "Content-Type": "application/json",
            },
            body: {
                inputs: queries.map((s) => [s]),
                model: this.modelId,
                input_type: "query",
            },
        });

        if (!response.ok || !response.data.data) {
            throw new Error(JSON.stringify(response.data));
        }

        return response.data.data.map((group: { data: { embedding: VectorArray }[] }) => group.data[0].embedding);
    }

    getCacheKeySuffix(contextTexts?: string[]): string {
        const ctxPart = contextTexts && contextTexts.length > 1 ? `|ctx:${contextHash(contextTexts)}` : "";
        return `|${this.model}${ctxPart}`;
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
