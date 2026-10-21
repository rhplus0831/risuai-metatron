import type {
    SummarizationOutput,
    TextToAudioPipeline,
    FeatureExtractionPipeline,
    TextGenerationConfig,
    TextGenerationOutput,
    ImageToTextOutput,
} from "@huggingface/transformers";
import { language } from "src/lang";
import { alertError, alertNormal, alertWait } from "src/ts/alert";
import { loadAsset } from "src/ts/globalApi.svelte";
import { saveAssets } from "src/ts/storage/assetQueue";
import { selectSingleFileHandle, asBuffer } from "src/ts/util";
import { readZipEntry, readZipIndex, type ZipFileIndex } from "./zipFile";
import { v4 } from "uuid";
import type { OnnxModelFiles } from "../../../shared/settings.ts";
let tfCache: Cache = null;
let tfLoaded = false;
let tfMap: { [key: string]: string } = {};
async function initTransformers() {
    if (tfLoaded) {
        return;
    }
    const { env } = await import("@huggingface/transformers");
    tfCache = await caches.open("tfCache");
    env.localModelPath = "https://sv.risuai.xyz/transformers/";
    env.useBrowserCache = false;
    env.useFSCache = false;
    env.useCustomCache = true;
    env.allowLocalModels = true;
    env.customCache = {
        put: async (url: URL | string, response: Response) => {
            await tfCache.put(url, response);
        },
        match: async (url: URL | string) => {
            if (typeof url === "string") {
                if (Object.keys(tfMap).includes(url)) {
                    const assetId = tfMap[url];
                    return new Response(asBuffer(await loadAsset(assetId)));
                }
            }
            return await tfCache.match(url);
        },
    };
    tfLoaded = true;
    console.log("transformers loaded");
}

export const runTransformers = async (
    baseText: string,
    model: string,
    config: TextGenerationConfig,
    device: "webgpu" | "wasm" = "wasm",
) => {
    await initTransformers();
    const { pipeline } = await import("@huggingface/transformers");
    let text = baseText;
    let generator = await pipeline("text-generation", model, {
        device,
    });
    let output = (await generator(text, config)) as TextGenerationOutput;
    const outputOne = output[0];
    return outputOne;
};

export const runSummarizer = async (text: string) => {
    await initTransformers();
    const { pipeline } = await import("@huggingface/transformers");
    let classifier = await pipeline("summarization", "Xenova/distilbart-cnn-6-6");
    const v = (await classifier(text)) as SummarizationOutput;
    return v[0].summary_text;
};

let extractor: FeatureExtractionPipeline = null;
let lastEmbeddingModelQuery: string = "";
type EmbeddingModel = "Xenova/all-MiniLM-L6-v2" | "nomic-ai/nomic-embed-text-v1.5";
export const runEmbedding = async (
    texts: string[],
    model: EmbeddingModel = "Xenova/all-MiniLM-L6-v2",
    device: "webgpu" | "wasm",
): Promise<Float32Array[]> => {
    await initTransformers();
    console.log("running embedding");
    let embeddingModelQuery = model + device;
    const { pipeline } = await import("@huggingface/transformers");
    if (!extractor || embeddingModelQuery !== lastEmbeddingModelQuery) {
        // Dispose old extractor
        if (extractor) {
            await extractor.dispose();
        }
        extractor = await pipeline<"feature-extraction">("feature-extraction", model, {
            // Default dtype for webgpu is fp32, so we can use q8, which is the default dtype in wasm.
            dtype: "q8",
            device: device,
            progress_callback: (progress) => {
                console.log(progress);
            },
        });
        lastEmbeddingModelQuery = embeddingModelQuery;
        console.log("extractor loaded");
    }
    let result = await extractor(texts, { pooling: "mean", normalize: true });
    console.log(texts, result);
    const data = result.data as Float32Array;
    console.log(data);
    const lenPerText = data.length / texts.length;
    let res: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
        res.push(data.subarray(i * lenPerText, (i + 1) * lenPerText));
    }
    console.log(res);
    return res ?? [];
};

export const runImageEmbedding = async (dataurl: string) => {
    await initTransformers();
    const { pipeline } = await import("@huggingface/transformers");
    const captioner = await pipeline("image-to-text", "Xenova/vit-gpt2-image-captioning");
    const output = await captioner(dataurl);
    return output as ImageToTextOutput;
};

let synthesizer: TextToAudioPipeline = null;
let lastSynth: string = null;

export type { OnnxModelFiles } from "../../../shared/settings.ts";

/**
 * Synthesizes `text` and returns the WAV bytes, or undefined without a model. Playback belongs to
 * `tts.ts`, whose registry `stopTTS` stops.
 */
export const runVITS = async (
    text: string,
    modelData: string | OnnxModelFiles = "Xenova/mms-tts-eng",
): Promise<ArrayBuffer | undefined> => {
    await initTransformers();
    const { WaveFile } = await import("wavefile");
    const { pipeline, env } = await import("@huggingface/transformers");
    if (modelData === null) {
        return;
    }
    if (typeof modelData === "string") {
        if (!synthesizer || lastSynth !== modelData) {
            lastSynth = modelData;
            synthesizer = await pipeline<"text-to-speech">("text-to-speech", modelData);
        }
    } else {
        if (!synthesizer || lastSynth !== modelData.id) {
            const files = modelData.files;
            const keys = Object.keys(files);
            for (const key of keys) {
                const fileURL = env.localModelPath + modelData.id + "/" + key;
                tfMap[fileURL] = files[key];
                tfMap[location.origin + fileURL] = files[key];
            }
            lastSynth = modelData.id;
            synthesizer = await pipeline<"text-to-speech">("text-to-speech", modelData.id);
        }
    }
    let out = await synthesizer(text, {});
    const wav = new WaveFile();
    wav.fromScratch(1, out.sampling_rate, "32f", out.audio);
    return asBuffer(wav.toBuffer().buffer);
};

/**
 * The largest zip member a model import stores: one record of the batch write route must fit the
 * server's 100 MiB body limit, with room for its framing.
 */
export const MAX_ONNX_MEMBER_BYTES = 100 * 1024 * 1024 - 64 * 1024;

/**
 * Imports a VITS/ONNX model zip: the picked `File` is read by its central directory (`zipFile.ts`),
 * each kept member read and inflated only when its save slot is free, and the members written in
 * batches. A member over {@link MAX_ONNX_MEMBER_BYTES} is skipped with a message. Undefined when
 * nothing is picked or the import fails (alerted).
 */
export const registerOnnxModel = async (): Promise<OnnxModelFiles> => {
    const id = v4().replace(/-/g, "");

    const modelFile = await selectSingleFileHandle(["zip"]);

    if (!modelFile) {
        return;
    }

    let index: ZipFileIndex;
    try {
        index = await readZipIndex(modelFile);
    } catch (error) {
        console.error(error);
        alertError(language.errors.onnxZipInvalid);
        return;
    }

    const members = index.entries.filter(
        (entry) =>
            !entry.directory &&
            (entry.name.endsWith(".onnx") || entry.compressedSize < 10_000_000 || entry.name.includes(".git")),
    );
    const isTooLarge = (entry: (typeof members)[number]) =>
        entry.uncompressedSize > MAX_ONNX_MEMBER_BYTES || entry.compressedSize > MAX_ONNX_MEMBER_BYTES;
    const skipped = members.filter(isTooLarge);
    const kept = members.filter((entry) => !isTooLarge(entry));

    let fids: string[];
    try {
        alertWait(language.onnxSaving);
        // Members can be large: two loaded at a time besides the batch being written.
        fids = await saveAssets(
            kept.map((entry) => ({ load: () => readZipEntry(modelFile, index, entry) })),
            { concurrency: 2 },
        );
    } catch (error) {
        console.error(error);
        alertError(`${error}`);
        return;
    }

    let fileIdMapped: { [key: string]: string } = {};
    for (let i = 0; i < kept.length; i++) {
        let url = kept[i].name;
        if (url.startsWith("/")) {
            url = url.substring(1);
        }
        fileIdMapped[url] = fids[i];
    }

    alertNormal(
        skipped.length > 0
            ? language.onnxFilesSkipped
                  .replace("{count}", String(skipped.length))
                  .replace("{names}", skipped.map((entry) => entry.name).join(", "))
            : language.successImport,
    );

    return {
        files: fileIdMapped,
        name: modelFile.name,
        id: id,
    };
};
