// The Transformers.js worker process: model loading, tokenization, image decoding, and ONNX inference
// run here, outside the server's process (`onnxruntime-node` runs its native load and run calls
// synchronously on the thread that asked, and ending a worker thread in the middle of one aborts the
// whole process; a child process can be killed). One task at a time, sent by `transformers.ts` over
// the IPC channel (`serialization: "advanced"`, so vectors cross as typed arrays).

import type { TransformersRequest, TransformersResponse, TransformersTask } from "./transformers.ts";

type Disposable = { dispose(): Promise<unknown> };
type Extractor = Disposable &
    ((texts: string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{ data: Float32Array }>);

const SUMMARIZER_MODEL = "Xenova/distilbart-cnn-6-6";
const CAPTION_MODEL = "Xenova/vit-gpt2-image-captioning";

/** The model directory is the first argument (`transformers.ts` forks with it). */
const cacheDir = process.argv[2];

type TransformersModule = typeof import("@huggingface/transformers");
let loaded: Promise<TransformersModule> | null = null;
/** The package, configured once: files from its default host into the save folder, no local model path. */
function transformers(): Promise<TransformersModule> {
    loaded ??= import("@huggingface/transformers").then((module) => {
        module.env.cacheDir = cacheDir;
        module.env.allowLocalModels = false;
        return module;
    });
    return loaded;
}

// The embedding pipeline stays loaded between calls and is replaced when the model changes, as the
// client's `runEmbedding` keeps it.
let extractor: Extractor | null = null;
let extractorModel = "";

async function disposeExtractor(): Promise<void> {
    const current = extractor;
    extractor = null;
    extractorModel = "";
    if (current) {
        await current.dispose();
    }
}

/**
 * The weights are the 8-bit ones (`dtype: "q8"`): the browser's default on its `wasm` device and what
 * the client's `runEmbedding` asks for; Node's default is `fp32`, about three times the memory.
 */
async function embed(texts: string[], model: string): Promise<Float32Array[]> {
    const { pipeline } = await transformers();
    if (!extractor || extractorModel !== model) {
        await disposeExtractor();
        extractor = (await pipeline("feature-extraction", model, { dtype: "q8" })) as unknown as Extractor;
        extractorModel = model;
    }
    const result = await extractor(texts, { pooling: "mean", normalize: true });
    const data = result.data;
    const lenPerText = data.length / texts.length;
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
        // A copy with its own buffer (the pipeline's tensor is one buffer for all texts).
        vectors.push(data.slice(i * lenPerText, (i + 1) * lenPerText));
    }
    return vectors;
}

/**
 * A summarization, captioning, or generation pipeline is made for one call and disposed after it (the
 * client makes one per call too), and the embedding pipeline is disposed first: two models are not
 * held at once. The summarizer and the captioner load their 8-bit weights. A generation model loads
 * the package's default for Node (`fp32`, `onnx/model.onnx`): the catalogue's generation models
 * publish no `model_quantized.onnx`, which is why they do not load in the browser at all.
 */
async function withPipeline<T>(
    task: "summarization" | "image-to-text" | "text-generation",
    model: string,
    run: (pipe: (...args: unknown[]) => Promise<unknown>, module: TransformersModule) => Promise<T>,
): Promise<T> {
    const module = await transformers();
    await disposeExtractor();
    const pipe = (await module.pipeline(
        task,
        model,
        task === "text-generation" ? {} : { dtype: "q8" },
    )) as unknown as Disposable & ((...args: unknown[]) => Promise<unknown>);
    try {
        return await run(pipe, module);
    } finally {
        await pipe.dispose();
    }
}

async function handle(task: TransformersTask): Promise<Omit<TransformersResponse & { ok: true }, "id" | "ok">> {
    switch (task.kind) {
        case "embed":
            return { vectors: await embed(task.texts, task.model) };
        case "summarize":
            return {
                text: await withPipeline("summarization", SUMMARIZER_MODEL, async (pipe) => {
                    const output = (await pipe(task.text)) as { summary_text: string }[];
                    return output[0].summary_text;
                }),
            };
        case "caption":
            return {
                text: await withPipeline("image-to-text", CAPTION_MODEL, async (pipe, module) => {
                    // The image is decoded here from the data URI (no network read of a `data:` URL).
                    const comma = task.dataUrl.indexOf(",");
                    const mime = /^data:([^;,]*)/.exec(task.dataUrl)?.[1] || "image/png";
                    const bytes = Buffer.from(task.dataUrl.slice(comma + 1), "base64");
                    const image = await module.RawImage.fromBlob(new Blob([bytes], { type: mime }));
                    const output = (await pipe(image)) as { generated_text: string }[];
                    return output[0].generated_text;
                }),
            };
        case "generate":
            return {
                text: await withPipeline("text-generation", task.model, async (pipe) => {
                    const output = (await pipe(task.text, task.config)) as { generated_text: unknown }[];
                    const text = output[0]?.generated_text;
                    return typeof text === "string" ? text : "";
                }),
            };
    }
}

const send = (response: TransformersResponse) => {
    // The server went away between the task and its answer: nothing to tell.
    if (process.connected) {
        process.send!(response);
    }
};

process.on("message", (request: TransformersRequest) => {
    handle(request.task).then(
        (result) => send({ id: request.id, ok: true, ...result }),
        (error: unknown) =>
            send({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
});
// The server ended (or closed the channel): so does this process.
process.on("disconnect", () => process.exit(0));
