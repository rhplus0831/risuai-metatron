// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TaskRateLimiter } from "../../../shared/taskRateLimiter.ts";
import { createVectorCache, type VectorCache } from "../data/vectorCache.ts";
import {
    contextHash,
    createEmbeddings,
    type EmbeddingEnv,
    HypaProcesser,
    HypaProcessorV2,
    postJson,
} from "../prompt/embeddings.ts";
import type { TransformersService } from "../prompt/transformers.ts";

// The server embeddings (`server/src/prompt/embeddings.ts`) over a fake `fetch`, a fake model
// process, and a real vector cache in a temporary file. The providers: the custom URL (`/embeddings`
// appended unless present, the settings' model and trimmed key, the `-<model>` key suffix), OpenAI
// (the stored memory key, or the processor's own), Voyage (document groups and queries, the
// `|voyageContext3` and `|ctx:` suffixes, the missing-key error), a local model (the model process,
// `Float32Array` vectors stored as float32). The cache: cold and warm request counts, the batches of
// 50, duplicates, a `HypaProcessorV2` hit without an `id`, a contextual group with a partial miss
// embedded whole. The checks: malformed answers refused and not cached; error texts without the keys
// in their plain, JSON-escaped, and URL-encoded forms, a whitespace-only key not a key; an abort
// before a cache write, a write of an earlier cache generation dropped, the rate limiter's waiting
// tasks ended by an abort; `postJson`'s two JSON contracts; `carries`.

type Call = { url: string; headers: Record<string, string>; body: any };

const CUSTOM_KEY = 'cust"key&x=1 y';
const VOYAGE_KEY = "voy-key";
const MEMORY_KEY = "sk-mem\\back";
const vector = (text: string): number[] => {
    // A deterministic small vector per text, with a nonzero first component.
    let h = 7;
    for (let i = 0; i < text.length; i++) {
        h = (h * 31 + text.charCodeAt(i)) % 1009;
    }
    return [1 + (h % 10) / 10, (h % 7) / 10, (h % 3) / 10];
};

function fakeFetch(options: {
    calls: Call[];
    answer?: (call: Call) => { status?: number; body: unknown } | { raw: string; status?: number } | Promise<any>;
    reject?: Error;
}): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const call: Call = {
            url: String(input),
            headers: (init?.headers as Record<string, string>) ?? {},
            body: init?.body ? JSON.parse(String(init.body)) : null,
        };
        options.calls.push(call);
        if (options.reject) {
            throw options.reject;
        }
        const answered = (await options.answer?.(call)) ?? defaultAnswer(call);
        if ("raw" in answered) {
            return new Response(answered.raw, { status: answered.status ?? 200 });
        }
        return new Response(JSON.stringify(answered.body), { status: answered.status ?? 200 });
    }) as typeof fetch;
}

/** The OpenAI-compatible shape for `input`, the Voyage shape for `inputs` (groups). */
function defaultAnswer(call: Call): { body: unknown } {
    if (Array.isArray(call.body?.inputs)) {
        return {
            body: {
                data: call.body.inputs.map((group: string[]) => ({
                    data: group.map((t) => ({ embedding: vector(t) })),
                })),
            },
        };
    }
    const inputs = Array.isArray(call.body?.input) ? call.body.input : [call.body?.input];
    return { body: { data: inputs.map((t: string) => ({ embedding: vector(t) })) } };
}

const dirs: string[] = [];
const caches: VectorCache[] = [];
function cache(): VectorCache {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-embeddings-"));
    dirs.push(dir);
    const created = createVectorCache({ file: path.join(dir, "vectors.sqlite") });
    caches.push(created);
    return created;
}
const fakeTransformers = (calls: { texts: string[]; model: string }[] = []): TransformersService => ({
    runEmbedding: async (texts, model) => {
        calls.push({ texts, model });
        return texts.map((t) => Float32Array.from(vector(t)));
    },
    runSummarizer: async () => "",
    runImageCaption: async () => "",
    runTextGeneration: async () => "",
    dispose: async () => {},
});

function env(options: {
    cache?: VectorCache;
    fetch?: typeof fetch;
    transformers?: TransformersService;
    db?: Partial<EmbeddingEnv["db"]>;
    supaMemoryKey?: string;
    signal?: AbortSignal;
}): EmbeddingEnv {
    const service = createEmbeddings({
        cache: options.cache ?? cache(),
        transformers: options.transformers ?? fakeTransformers(),
        fetchImpl: options.fetch ?? fakeFetch({ calls: [] }),
    });
    return service.forJob({
        db: {
            hypaModel: "custom",
            hypaCustomSettings: { url: "http://embed.test/v1/", key: ` ${CUSTOM_KEY} `, model: " emb-model " },
            voyageApiKey: ` ${VOYAGE_KEY} `,
            ...options.db,
        } as EmbeddingEnv["db"],
        supaMemoryKey: options.supaMemoryKey ?? MEMORY_KEY,
        signal: options.signal ?? new AbortController().signal,
    });
}

beforeAll(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
    for (const created of caches.splice(0)) {
        created.close();
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("HypaProcesser over the providers", () => {
    it("calls the custom server with the settings' model and trimmed key, caches under the model suffix, and reuses the vectors", async () => {
        const calls: Call[] = [];
        const shared = cache();
        const e = env({ cache: shared, fetch: fakeFetch({ calls }) });
        const first = new HypaProcesser(e);
        await first.addText(["near", "far", "near"]);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("http://embed.test/v1/embeddings");
        expect(calls[0].headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${CUSTOM_KEY}` });
        // The duplicate is sent as the client sends it (both copies), and both land in `vectors`.
        expect(calls[0].body).toEqual({ input: ["near", "far", "near"], model: "emb-model" });
        expect(first.vectors.map((v) => v.content)).toEqual(["near", "far", "near"]);
        expect(shared.get("near|custom-emb-model")).toEqual(vector("near"));
        expect(shared.get("near|custom")).toBeNull();
        expect(shared.stats().rows).toBe(2);
        // The query is sent as a string, and the ranking follows the dot product.
        const ranked = await first.similaritySearch("q");
        expect(calls[1].body).toEqual({ input: "q", model: "emb-model" });
        const q = vector("q");
        const dot = (t: string) => vector(t).reduce((sum, x, i) => sum + x * q[i], 0);
        expect(ranked.slice(0, 1)).toEqual([dot("near") >= dot("far") ? "near" : "far"]);
        expect(ranked).toHaveLength(3);
        // Warm: another processor of the same job finds every text, and sends nothing.
        const second = new HypaProcesser(e);
        await second.addText(["far", "near"]);
        expect(calls).toHaveLength(2);
        expect(second.vectors.map((v) => [v.content, v.alreadySaved])).toEqual([
            ["far", true],
            ["near", true],
        ]);
        // Partly warm: only the new text is sent.
        await second.addText(["far", "new"]);
        expect(calls[2].body.input).toEqual(["new"]);
    });

    it("keeps a custom URL that already ends with /embeddings, and refuses an empty one", async () => {
        const calls: Call[] = [];
        const e = env({
            fetch: fakeFetch({ calls }),
            db: { hypaCustomSettings: { url: "http://embed.test/x/embeddings", key: "", model: "" } },
        });
        await new HypaProcesser(e).addText(["t"]);
        expect(calls[0].url).toBe("http://embed.test/x/embeddings");
        // No key, no model: neither is sent; the key suffix is absent.
        expect(calls[0].headers).toEqual({ "Content-Type": "application/json" });
        expect(calls[0].body).toEqual({ input: ["t"] });
        expect(e.cache.get("t|custom")).toEqual(vector("t"));
        const empty = env({ fetch: fakeFetch({ calls }), db: { hypaCustomSettings: { url: "", key: "", model: "" } } });
        await expect(new HypaProcesser(empty).addText(["t2"])).rejects.toThrow(
            "Custom model requires a Custom Server URL",
        );
    });

    it("sends OpenAI requests with the stored memory key, or the processor's own key, in batches of 50", async () => {
        const calls: Call[] = [];
        const e = env({ fetch: fakeFetch({ calls }) });
        const processer = new HypaProcesser(e, "openai3small");
        const texts = Array.from({ length: 101 }, (_, i) => `text ${i}`);
        await processer.addText(texts);
        expect(calls.map((call) => call.body.input.length)).toEqual([50, 50, 1]);
        expect(calls.every((call) => call.url === "https://api.openai.com/v1/embeddings")).toBe(true);
        expect(calls.every((call) => call.headers.Authorization === `Bearer ${MEMORY_KEY}`)).toBe(true);
        expect(calls.every((call) => call.body.model === "text-embedding-3-small")).toBe(true);
        expect(processer.vectors).toHaveLength(101);
        expect(e.cache.get("text 100|openai3small")).toEqual(vector("text 100"));
        const own = new HypaProcesser(e, "ada");
        own.oaikey = " own-key ";
        await own.addText(["mine"]);
        expect(calls.at(-1)!.headers.Authorization).toBe("Bearer own-key");
        expect(calls.at(-1)!.body.model).toBe("text-embedding-ada-002");
    });

    it("calls Voyage with document groups and query inputs, the trimmed key, and the contextual key suffix", async () => {
        const calls: Call[] = [];
        const e = env({ fetch: fakeFetch({ calls }), db: { hypaModel: "voyageContext3" } });
        const processer = new HypaProcesser(e);
        await processer.addText(["a", "b"]);
        expect(calls[0].url).toBe("https://api.voyageai.com/v1/contextualizedembeddings");
        expect(calls[0].headers.Authorization).toBe(`Bearer ${VOYAGE_KEY}`);
        expect(calls[0].body).toEqual({ model: "voyage-context-3", inputs: [["a"], ["b"]], input_type: "document" });
        expect(e.cache.get("a|voyageContext3")).toEqual(vector("a"));
        await processer.similaritySearch("q");
        expect(calls[1].body).toEqual({ inputs: [["q"]], model: "voyage-context-3", input_type: "query" });
        const keyless = env({ fetch: fakeFetch({ calls }), db: { hypaModel: "voyageContext3", voyageApiKey: "  " } });
        await expect(new HypaProcesser(keyless).addText(["c"])).rejects.toThrow(
            "Voyage Context 3 requires a Voyage API Key",
        );
    });

    it("runs a local model in the model process (the GPU variant on the same model) and stores Float32Array vectors as float32", async () => {
        const runs: { texts: string[]; model: string }[] = [];
        const shared = cache();
        const e = env({ cache: shared, transformers: fakeTransformers(runs), db: { hypaModel: "MiniLMGPU" } });
        const processer = new HypaProcesser(e);
        await processer.addText(["x", "y"]);
        expect(runs).toEqual([{ texts: ["x", "y"], model: "Xenova/all-MiniLM-L6-v2" }]);
        expect(processer.vectors[0].embedding).toBeInstanceOf(Float32Array);
        const stored = shared.get("x|MiniLMGPU");
        expect(stored).toBeInstanceOf(Float32Array);
        expect(Array.from(stored as Float32Array)).toEqual(Array.from(Float32Array.from(vector("x"))));
        // The hit comes back as a Float32Array too, and the query runs the model.
        const again = new HypaProcesser(e, "MiniLMGPU");
        await again.addText(["x"]);
        expect(runs).toHaveLength(1);
        expect(again.vectors[0].embedding).toBeInstanceOf(Float32Array);
        await again.similaritySearch("q");
        expect(runs[1]).toEqual({ texts: ["q"], model: "Xenova/all-MiniLM-L6-v2" });
    });

    it("refuses a model without a provider", async () => {
        const e = env({ db: { hypaModel: "nothing" as never } });
        await expect(new HypaProcesser(e).addText(["t"])).rejects.toThrow("Unsupported model: nothing");
    });
});

describe("what a provider answers", () => {
    const malformed = [
        ["fewer vectors than inputs", { data: [{ embedding: [1, 2] }] }],
        ["a non-finite number", { data: [{ embedding: [1, NaN] }, { embedding: [1, 2] }] }],
        ["mixed lengths", { data: [{ embedding: [1, 2] }, { embedding: [1, 2, 3] }] }],
        ["a missing embedding", { data: [{ embedding: [1, 2] }, {}] }],
        ["an empty vector", { data: [{ embedding: [] }, { embedding: [] }] }],
        ["data that is not a list", { data: "nope" }],
        ["a string in a vector", { data: [{ embedding: [1, "2"] }, { embedding: [1, 2] }] }],
    ] as const;

    for (const [label, body] of malformed) {
        it(`refuses ${label} and caches nothing`, async () => {
            const calls: Call[] = [];
            const shared = cache();
            const e = env({ cache: shared, fetch: fakeFetch({ calls, answer: () => ({ body }) }) });
            await expect(new HypaProcesser(e).addText(["a", "b"])).rejects.toThrow(
                "The embedding provider returned malformed vectors",
            );
            expect(shared.stats().rows).toBe(0);
            // The next processor asks again.
            await new HypaProcesser(e).addText(["a", "b"]).catch(() => {});
            expect(calls).toHaveLength(2);
        });
    }

    it("refuses malformed Voyage answers (a group with the wrong count, a missing query vector)", async () => {
        const calls: Call[] = [];
        const e = env({
            fetch: fakeFetch({
                calls,
                answer: (call) =>
                    call.body.input_type === "document"
                        ? { body: { data: [{ data: [{ embedding: [1, 0] }] }] } }
                        : { body: { data: [{ data: [] }] } },
            }),
            db: { hypaModel: "voyageContext3" },
        });
        await expect(new HypaProcesser(e).addText(["a", "b"])).rejects.toThrow("malformed vectors");
        await expect(new HypaProcesser(e).similaritySearch("q")).rejects.toThrow("malformed vectors");
        expect(e.cache.stats().rows).toBe(0);
    });

    it("leaves the keys out of an error text: plain, JSON-escaped, and URL-encoded; a whitespace-only key is not one", async () => {
        const echo = (key: string) =>
            `bad key ${key} / ${JSON.stringify(key).slice(1, -1)} / ${encodeURIComponent(key)} / unrelated text`;
        const custom = env({
            fetch: fakeFetch({ calls: [], answer: () => ({ status: 401, body: { error: echo(CUSTOM_KEY) } }) }),
        });
        const customError = await new HypaProcesser(custom).addText(["t"]).then(
            () => "",
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        expect(customError).not.toContain(CUSTOM_KEY);
        expect(customError).not.toContain(encodeURIComponent(CUSTOM_KEY));
        expect(customError).toContain("[redacted]");
        expect(customError).toContain("unrelated text");
        const memory = env({
            fetch: fakeFetch({ calls: [], answer: () => ({ status: 401, body: { error: echo(MEMORY_KEY) } }) }),
        });
        const memoryError = await new HypaProcesser(memory, "ada").addText(["t"]).then(
            () => "",
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        expect(memoryError).not.toContain(MEMORY_KEY);
        expect(memoryError).not.toContain(JSON.stringify(MEMORY_KEY).slice(1, -1));
        expect(memoryError).toContain("[redacted]");
        const voyage = env({
            fetch: fakeFetch({ calls: [], answer: () => ({ status: 401, body: { error: echo(VOYAGE_KEY) } }) }),
            db: { hypaModel: "voyageContext3" },
        });
        await expect(new HypaProcesser(voyage).addText(["t"])).rejects.not.toThrow(VOYAGE_KEY);
        // A whitespace-only unused key: the spaces of an ordinary text survive, and `carries` is false.
        const spaces = env({
            db: { voyageApiKey: " ", hypaCustomSettings: { url: "http://e.test", key: "  ", model: "" } },
        });
        expect(spaces.redact("a legitimate summary.")).toBe("a legitimate summary.");
        expect(spaces.carries({ choices: [{ text: "a legitimate summary." }] })).toBe(false);
        // The usable key in any depth or form is carried.
        expect(spaces.carries({ choices: [{ text: `x ${MEMORY_KEY} y` }] })).toBe(true);
        expect(spaces.carries(JSON.stringify({ k: MEMORY_KEY }))).toBe(true);
        expect(spaces.carries({ [MEMORY_KEY]: 1 })).toBe(true);
        expect(spaces.redact(`k=${encodeURIComponent(MEMORY_KEY)}`)).toBe("k=[redacted]");
    });

    it("postJson: strictJson makes a body that is not JSON a failure with the text; otherwise the text is the data with the response's ok", async () => {
        const text = env({ fetch: fakeFetch({ calls: [], answer: () => ({ raw: "not json" }) }) });
        expect(await postJson(text, "http://x.test", { body: {} }, { strictJson: true })).toEqual({
            ok: false,
            data: "not json",
        });
        expect(await postJson(text, "http://x.test", { body: {} })).toEqual({ ok: true, data: "not json" });
        const failing = env({ fetch: fakeFetch({ calls: [], answer: () => ({ raw: "down", status: 503 }) }) });
        expect(await postJson(failing, "http://x.test", { body: {} })).toEqual({ ok: false, data: "down" });
        const rejecting = env({ fetch: fakeFetch({ calls: [], reject: new Error("ECONNREFUSED") }) });
        expect(await postJson(rejecting, "http://x.test", { body: {} })).toEqual({
            ok: false,
            data: "Error: ECONNREFUSED",
        });
        const calls: Call[] = [];
        const ok = env({ fetch: fakeFetch({ calls, answer: () => ({ body: { fine: 1 } }) }) });
        expect(await postJson(ok, "http://x.test", { headers: { Authorization: "Bearer k" }, body: { a: 1 } })).toEqual(
            { ok: true, data: { fine: 1 } },
        );
        expect(calls[0].headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer k" });
        expect(calls[0].body).toEqual({ a: 1 });
    });
});

describe("the job's end and the cache's generation", () => {
    it("an abort before the answer is used rejects with the reason and stores nothing", async () => {
        const controller = new AbortController();
        const shared = cache();
        const e = env({
            cache: shared,
            signal: controller.signal,
            fetch: fakeFetch({
                calls: [],
                answer: async (call) => {
                    controller.abort(new Error("the job ended"));
                    return defaultAnswer(call);
                },
            }),
        });
        await expect(new HypaProcesser(e).addText(["t"])).rejects.toThrow("the job ended");
        expect(shared.stats().rows).toBe(0);
        // Already aborted: nothing is sent.
        const calls: Call[] = [];
        const aborted = env({ cache: shared, signal: controller.signal, fetch: fakeFetch({ calls }) });
        await expect(new HypaProcesser(aborted).addText(["u"])).rejects.toThrow("the job ended");
        expect(calls).toHaveLength(0);
        await expect(postJson(aborted, "http://x.test", { body: {} })).rejects.toThrow("the job ended");
    });

    it("drops a cache write of a job bound before the cache was cleared, so the next job asks again", async () => {
        const calls: Call[] = [];
        const shared = cache();
        const service = createEmbeddings({
            cache: shared,
            transformers: fakeTransformers(),
            fetchImpl: fakeFetch({ calls }),
        });
        const db = {
            hypaModel: "custom",
            hypaCustomSettings: { url: "http://e.test", key: "", model: "" },
            voyageApiKey: "",
        };
        const early = service.forJob({ db: db as never, supaMemoryKey: "", signal: new AbortController().signal });
        shared.clear();
        await new HypaProcesser(early).addText(["t"]);
        expect(shared.stats().rows).toBe(0);
        const late = service.forJob({ db: db as never, supaMemoryKey: "", signal: new AbortController().signal });
        await new HypaProcesser(late).addText(["t"]);
        expect(calls).toHaveLength(2);
        expect(shared.stats().rows).toBe(1);
    });
});

describe("HypaProcessorV2", () => {
    type Meta = { group: string };

    it("embeds API texts in chunks of 50 through the rate limiter, keeps metadata, and gives a cache hit the client's shape (no id)", async () => {
        const calls: Call[] = [];
        const shared = cache();
        const e = env({ cache: shared, fetch: fakeFetch({ calls }) });
        const processor = new HypaProcessorV2<Meta>(e, {
            rateLimiter: new TaskRateLimiter({ tasksPerMinute: 1000, maxConcurrentTasks: 4 }),
        });
        const progress: number[] = [];
        processor.progressCallback = (n) => progress.push(n);
        const items = Array.from({ length: 60 }, (_, i) => ({
            id: `s${i}`,
            content: `text ${i}`,
            metadata: { group: "g" },
        }));
        await processor.addTexts(items);
        expect(calls.map((call) => call.body.input.length).sort()).toEqual([10, 50]);
        expect(processor.vectors.size).toBe(60);
        expect(processor.vectors.get("s3")).toEqual({
            id: "s3",
            content: "text 3",
            embedding: vector("text 3"),
            metadata: { group: "g" },
        });
        expect(shared.get("text 3|custom-emb-model")).toEqual(vector("text 3"));
        // A hit of another processor: the cached object with the new metadata, and no `id` of its own.
        const warm = new HypaProcessorV2<Meta>(e);
        await warm.addTexts([{ id: "other", content: "text 3", metadata: { group: "h" } }]);
        expect(calls).toHaveLength(2);
        expect(warm.vectors.get("other")).toEqual({
            content: "text 3",
            embedding: vector("text 3"),
            metadata: { group: "h" },
        });
        // The queries: duplicates sent once, each answered with a ranking by cosine, in the asked order.
        const results = await warm.similaritySearchScoredBatch(["q1", "q2", "q1"]);
        expect(calls.at(-1)!.body.input).toEqual(["q1", "q2"]);
        expect(results).toHaveLength(3);
        expect(results[0]).toBe(results[2]);
        expect(results[0][0][0].content).toBe("text 3");
        const cosine = (a: number[], b: number[]) =>
            a.reduce((s, x, i) => s + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b));
        expect(results[0][0][1]).toBeCloseTo(cosine(vector("q1"), vector("text 3")), 12);
        expect(results[1][0][1]).toBeCloseTo(cosine(vector("q2"), vector("text 3")), 12);
        expect(warm.vectors.size).toBe(1);
        expect(await warm.similaritySearchScoredBatch([])).toEqual([]);
    });

    it("runs a local model one chunk at a time with the progress callback and float32 vectors", async () => {
        const runs: { texts: string[]; model: string }[] = [];
        const e = env({ transformers: fakeTransformers(runs), db: { hypaModel: "nomic" } });
        const processor = new HypaProcessorV2<Meta>(e);
        const progress: number[] = [];
        processor.progressCallback = (n) => progress.push(n);
        const items = Array.from({ length: 25 }, (_, i) => ({ id: `l${i}`, content: `local ${i}` }));
        await processor.addTexts(items);
        expect(runs.every((run) => run.model === "nomic-ai/nomic-embed-text-v1.5")).toBe(true);
        expect(runs.reduce((n, run) => n + run.texts.length, 0)).toBe(25);
        expect(progress).toEqual(runs.map((_, i) => runs.length - i - 1));
        expect(processor.vectors.get("l0")!.embedding).toBeInstanceOf(Float32Array);
        expect(e.cache.get("local 0|nomic")).toBeInstanceOf(Float32Array);
    });

    it("groups contextual documents by metadata identity, keys them with the group hash, and embeds a group whole on a partial miss", async () => {
        const calls: Call[] = [];
        const shared = cache();
        const e = env({ cache: shared, fetch: fakeFetch({ calls }), db: { hypaModel: "voyageContext3" } });
        const groupA = { group: "a" };
        const groupB = { group: "b" };
        const first = new HypaProcessorV2<Meta>(e);
        await first.addTexts([
            { id: "a1", content: "alpha one", metadata: groupA },
            { id: "b1", content: "beta one", metadata: groupB },
            { id: "a2", content: "alpha two", metadata: groupA },
        ]);
        expect(calls[0].body).toEqual({
            model: "voyage-context-3",
            inputs: [["alpha one", "alpha two"], ["beta one"]],
            input_type: "document",
        });
        // The client's V2 key: `<text>|<model>` plus the provider's suffix, which names the model again,
        // plus `|ctx:<hash>` for a group of more than one text.
        const hashA = contextHash(["alpha one", "alpha two"]);
        expect(shared.get(`alpha one|voyageContext3|voyageContext3|ctx:${hashA}`)).toEqual(vector("alpha one"));
        expect(shared.get(`alpha one|voyageContext3|ctx:${hashA}`)).toBeNull();
        // A group of one has no `|ctx:` part.
        expect(shared.get("beta one|voyageContext3|voyageContext3")).toEqual(vector("beta one"));
        // Warm, the same groups: no request.
        const warm = new HypaProcessorV2<Meta>(e);
        const again = { group: "a" };
        await warm.addTexts([
            { id: "a1", content: "alpha one", metadata: again },
            { id: "a2", content: "alpha two", metadata: again },
        ]);
        expect(calls).toHaveLength(1);
        // A group with a new member: the cached members are dropped and the whole group is embedded.
        const grown = new HypaProcessorV2<Meta>(e);
        const groupC = { group: "c" };
        await grown.addTexts([
            { id: "a1", content: "alpha one", metadata: groupC },
            { id: "a2", content: "alpha two", metadata: groupC },
            { id: "a3", content: "alpha three", metadata: groupC },
        ]);
        expect(calls[1].body.inputs).toEqual([["alpha one", "alpha two", "alpha three"]]);
        expect(grown.vectors.size).toBe(3);
        expect(
            shared.get(
                `alpha one|voyageContext3|voyageContext3|ctx:${contextHash(["alpha one", "alpha two", "alpha three"])}`,
            ),
        ).toEqual(vector("alpha one"));
        // A query has no group: `input_type: "query"`, the plain suffix.
        await grown.similaritySearchScored("find alpha");
        expect(calls[2].body).toEqual({ inputs: [["find alpha"]], model: "voyage-context-3", input_type: "query" });
    });

    it("an abort during a rate-limited batch ends the waiting tasks and rejects with the reason", async () => {
        const controller = new AbortController();
        const calls: Call[] = [];
        const shared = cache();
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const e = env({
            cache: shared,
            signal: controller.signal,
            fetch: fakeFetch({
                calls,
                answer: async (call) => {
                    await held;
                    return defaultAnswer(call);
                },
            }),
        });
        const processor = new HypaProcessorV2<Meta>(e, {
            // One request per minute: the second chunk would wait a minute for the window.
            rateLimiter: new TaskRateLimiter({ tasksPerMinute: 1, maxConcurrentTasks: 1 }),
        });
        const items = Array.from({ length: 51 }, (_, i) => ({ id: `r${i}`, content: `rate ${i}` }));
        const pending = processor.addTexts(items);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(calls).toHaveLength(1);
        controller.abort(new Error("the job ended"));
        release();
        await expect(pending).rejects.toThrow("the job ended");
        // The second chunk never went out, and nothing was stored.
        expect(calls).toHaveLength(1);
        expect(shared.stats().rows).toBe(0);
    });
});
