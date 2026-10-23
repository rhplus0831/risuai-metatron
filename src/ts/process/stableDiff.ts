import { settings } from "../storage/settingsViews.svelte";
import { type character } from "../storage/database.svelte";
import type { ImageOrientation } from "../../../shared/jobs.ts";
import { requestChatData } from "./request/request";
import type { PluginCallContext } from "../plugins/apiV3/pluginContext";
import type { ChatRef } from "../storage/chatStore.svelte";
import { alertError } from "../alert";
import { fetchNative, globalFetch } from "../globalApi.svelte";
import { readAsset } from "../storage/assetClient";
import { auxFetchJson } from "../network/auxFetch";
import { CharEmotion } from "../stores.svelte";
import type { OpenAIChat } from "./index.svelte";
import { processZip } from "./processzip";
import random from "lodash/random";

/**
 * `chatRef` and `pluginContext` are the send's: the prompt request runs for that chat and that
 * frozen preset and persona, not the tab's selection when it starts. `check` (a server job's image
 * callback) throws once the job no longer wants the image: no image request is started after that.
 * When supplied, `signal` cancels the prompt and image requests, polling, and delivery.
 */
export async function stableDiff(
    currentChar: character,
    prompt: string,
    target: {
        chatRef?: ChatRef | null;
        pluginContext?: PluginCallContext;
        check?: () => void;
        signal?: AbortSignal;
    } = {},
) {
    const { signal } = target;
    signal?.throwIfAborted();
    try {
        if (settings.memoryTranslateMedia.sdProvider === "") {
            alertError("Stable diffusion is not set in settings.");
            return false;
        }

        const promptItem = `Chat:\n${prompt}`;

        const promptbody: OpenAIChat[] = [
            {
                role: "system",
                content: currentChar.newGenData.instructions,
            },
            {
                role: "user",
                content: promptItem,
            },
        ];

        const rq = await requestChatData(
            {
                formated: promptbody,
                currentChar: currentChar,
                temperature: 0.2,
                maxTokens: 300,
                bias: {},
                useStreaming: false,
                noMultiGen: true,
                chatRef: target.chatRef ?? null,
                pluginContext: target.pluginContext,
            },
            "submodel",
            signal,
        );
        signal?.throwIfAborted();

        // A cancelled job callback stops here: no alert for a request its cancellation ended, no image.
        target.check?.();

        if (rq.type === "fail") {
            alertError(rq.result);
            return false;
        }
        if (rq.type === "streaming" || rq.type === "multiline") {
            alertError("Unexpected response type");
            return false;
        }

        const r = rq.result.replace(/<Thoughts>[\s\S]*?<\/Thoughts>/g, "").trim();

        const genPrompt = currentChar.newGenData.prompt.replaceAll("{{slot}}", r);
        const neg = currentChar.newGenData.negative;

        const result = await generateAIImage(genPrompt, currentChar, neg, "", { signal });
        signal?.throwIfAborted();
        return result;
    } catch (error) {
        signal?.throwIfAborted();
        throw error;
    }
}

function deliverGeneratedImage(
    img: string,
    currentChar: character,
    returnSdData: string,
    signal?: AbortSignal,
): string {
    signal?.throwIfAborted();
    if (returnSdData === "inlay") return img;
    CharEmotion.update((emotions) => ({
        ...emotions,
        [currentChar.chaId]: [[img, img, Date.now()]],
    }));
    return returnSdData;
}

/** Waits between polls, releasing the timer and listener on completion or cancellation. */
function pollingDelay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
            cleanup();
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

export async function generateAIImage(
    genPrompt: string,
    currentChar: character,
    neg: string,
    returnSdData: string,
    options: { signal?: AbortSignal; orientation?: ImageOrientation } = {},
): Promise<string | false> {
    const { signal, orientation } = options;
    signal?.throwIfAborted();
    try {
        const result = await generateAIImageForProvider(genPrompt, currentChar, neg, returnSdData, signal, orientation);
        signal?.throwIfAborted();
        return result;
    } catch (error) {
        signal?.throwIfAborted();
        throw error;
    }
}

async function generateAIImageForProvider(
    genPrompt: string,
    currentChar: character,
    neg: string,
    returnSdData: string,
    signal?: AbortSignal,
    orientation?: ImageOrientation,
): Promise<string | false> {
    if (settings.memoryTranslateMedia.sdProvider === "webui") {
        const uri = new URL(settings.memoryTranslateMedia.webUiUrl);
        uri.pathname = "/sdapi/v1/txt2img";
        try {
            const da = await globalFetch(uri.toString(), {
                abortSignal: signal,
                body: {
                    width: settings.memoryTranslateMedia.sdConfig.width,
                    height: settings.memoryTranslateMedia.sdConfig.height,
                    seed: -1,
                    steps: settings.memoryTranslateMedia.sdSteps,
                    cfg_scale: settings.memoryTranslateMedia.sdCFG,
                    prompt: genPrompt,
                    negative_prompt: neg,
                    sampler_name: settings.memoryTranslateMedia.sdConfig.sampler_name,
                    enable_hr: settings.memoryTranslateMedia.sdConfig.enable_hr,
                    denoising_strength: settings.memoryTranslateMedia.sdConfig.denoising_strength,
                    hr_scale: settings.memoryTranslateMedia.sdConfig.hr_scale,
                    hr_upscaler: settings.memoryTranslateMedia.sdConfig.hr_upscaler,
                },
                headers: {
                    "Content-Type": "application/json",
                },
            });
            signal?.throwIfAborted();

            if (!da.ok) {
                alertError(JSON.stringify(da.data));
                return returnSdData === "inlay" ? "" : false;
            }
            return deliverGeneratedImage(
                `data:image/png;base64,${da.data.images[0]}`,
                currentChar,
                returnSdData,
                signal,
            );
        } catch (error) {
            signal?.throwIfAborted();
            alertError(error);
            return false;
        }
    }
    if (settings.memoryTranslateMedia.sdProvider === "novelai") {
        const dimensions = applyImageOrientation(
            settings.memoryTranslateMedia.NAIImgConfig.width,
            settings.memoryTranslateMedia.NAIImgConfig.height,
            orientation,
        );

        genPrompt = genPrompt
            .replaceAll("\\(", "♧")
            .replaceAll("\\)", "♤")
            .replaceAll("(", "{")
            .replaceAll(")", "}")
            .replaceAll("♧", "(")
            .replaceAll("♤", ")");

        let reqlist: any = {};

        const commonReq = {
            body: {
                input: genPrompt,
                model: settings.memoryTranslateMedia.NAIImgModel,
                parameters: {
                    params_version: 3,
                    add_original_image: true,
                    cfg_rescale: settings.memoryTranslateMedia.NAIImgConfig.cfg_rescale,
                    controlnet_strength: 1,
                    dynamic_thresholding:
                        settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-3") ||
                        settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-furry-3") ||
                        settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-2")
                            ? settings.memoryTranslateMedia.NAIImgConfig.decrisp
                            : false,
                    n_samples: 1,
                    width: dimensions.width,
                    height: dimensions.height,
                    sampler: settings.memoryTranslateMedia.NAIImgConfig.sampler,
                    steps: settings.memoryTranslateMedia.NAIImgConfig.steps,
                    scale: settings.memoryTranslateMedia.NAIImgConfig.scale,
                    negative_prompt: neg,
                    sm:
                        settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-3") ||
                        settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-furry-3") ||
                        settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-2")
                            ? settings.memoryTranslateMedia.NAIImgConfig.sm
                            : undefined,
                    sm_dyn:
                        settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-3") ||
                        settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-furry-3")
                            ? settings.memoryTranslateMedia.NAIImgConfig.sm_dyn
                            : undefined,
                    noise_schedule: settings.memoryTranslateMedia.NAIImgConfig.noise_schedule,
                    normalize_reference_strength_multiple: true,
                    ucPreset: 3,
                    uncond_scale: 1,
                    qualityToggle: false,
                    legacy_v3_extend: false,
                    legacy: false,
                    //add v4
                    autoSmea: false,
                    use_coords: false,
                    legacy_uc: settings.memoryTranslateMedia.NAIImgConfig.legacy_uc,
                    v4_prompt: {
                        caption: {
                            base_caption: genPrompt,
                            char_captions: [],
                        },
                        use_coords: false,
                        use_order: true,
                    },
                    v4_negative_prompt: {
                        caption: {
                            base_caption: neg,
                            char_captions: [],
                        },
                        legacy_uc: settings.memoryTranslateMedia.NAIImgConfig.legacy_uc,
                    },
                    reference_image_multiple: [],
                    reference_strength_multiple: [],
                    //add reference image
                    image: undefined,
                    strength: undefined,
                    noise: undefined,
                    //add additional parameters
                    seed: random(0, 2 ** 32 - 1),
                    extra_noise_seed: random(0, 2 ** 32 - 1),
                    prefer_brownian: true,
                    deliberate_euler_ancestral_bug: false,
                    skip_cfg_above_sigma: null,
                    //add character reference
                    director_reference_images: [],
                    director_reference_descriptions: [],
                    director_reference_information_extracted: [],
                    director_reference_strength_values: [],
                },
            },
            headers: {
                Authorization: "Bearer " + settings.secrets.NAIApiKey,
            },
            rawResponse: true,
        };

        // Add Variety+ option
        if (settings.memoryTranslateMedia.NAIImgConfig.variety_plus) {
            if (
                settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-4-full") ||
                settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-4-curated") ||
                settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-3") ||
                settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-furry-3")
            ) {
                commonReq.body.parameters.skip_cfg_above_sigma =
                    Math.sqrt(
                        settings.memoryTranslateMedia.NAIImgConfig.width *
                            settings.memoryTranslateMedia.NAIImgConfig.height,
                    ) * 0.01889;
            }
            if (
                settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-4-5-full") ||
                settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-4-5-curated")
            ) {
                commonReq.body.parameters.skip_cfg_above_sigma =
                    Math.sqrt(
                        settings.memoryTranslateMedia.NAIImgConfig.width *
                            settings.memoryTranslateMedia.NAIImgConfig.height,
                    ) * 0.05766;
            }
        }

        // Add vibe reference_image_multiple if exists
        if (
            settings.memoryTranslateMedia.NAIImgConfig.reference_mode === "vibe" &&
            settings.memoryTranslateMedia.NAIImgConfig.vibe_data
        ) {
            const vibeData = settings.memoryTranslateMedia.NAIImgConfig.vibe_data;
            // Determine which model to use based on vibe_model_selection or fallback to current model
            const modelKey =
                settings.memoryTranslateMedia.NAIImgConfig.vibe_model_selection ||
                (settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-4-full")
                    ? "v4full"
                    : settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-4-curated")
                      ? "v4curated"
                      : settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-4-5-full")
                        ? "v4-5full"
                        : settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-4-5-curated")
                          ? "v4-5curated"
                          : null);

            if (modelKey && vibeData.encodings && vibeData.encodings[modelKey]) {
                // Initialize arrays if they don't exist
                if (!commonReq.body.parameters.reference_image_multiple) {
                    commonReq.body.parameters.reference_image_multiple = [];
                }
                if (!commonReq.body.parameters.reference_strength_multiple) {
                    commonReq.body.parameters.reference_strength_multiple = [];
                }

                // Use selected encoding or first available
                let encodingKey = settings.memoryTranslateMedia.NAIImgConfig.vibe_model_selection
                    ? Object.keys(vibeData.encodings[modelKey]).find(
                          (key) =>
                              vibeData.encodings[modelKey][key].params.information_extracted ===
                              (settings.memoryTranslateMedia.NAIImgConfig.InfoExtracted || 1),
                      )
                    : Object.keys(vibeData.encodings[modelKey])[0];

                if (encodingKey) {
                    const encoding = vibeData.encodings[modelKey][encodingKey].encoding;
                    // Add encoding to the array
                    commonReq.body.parameters.reference_image_multiple.push(encoding);

                    // Add reference_strength_multiple if it exists
                    const strength =
                        settings.memoryTranslateMedia.NAIImgConfig.reference_strength_multiple &&
                        settings.memoryTranslateMedia.NAIImgConfig.reference_strength_multiple.length > 0
                            ? settings.memoryTranslateMedia.NAIImgConfig.reference_strength_multiple[0]
                            : 0.5;
                    commonReq.body.parameters.reference_strength_multiple.push(strength);
                }
            }
        }

        if (
            settings.memoryTranslateMedia.NAIImgConfig.reference_mode === "character" &&
            (settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-4-5-full") ||
                settings.memoryTranslateMedia.NAIImgModel.includes("nai-diffusion-4-5-curated"))
        ) {
            let base64img = "";
            if (
                !settings.memoryTranslateMedia.NAIImgConfig.character_image ||
                settings.memoryTranslateMedia.NAIImgConfig.character_image === ""
            ) {
                const charimg = currentChar.image;
                const img = await readAsset(charimg, { signal });
                signal?.throwIfAborted();
                if (img) {
                    base64img = Buffer.from(img).toString("base64");
                }
            } else {
                base64img = settings.memoryTranslateMedia.NAIImgConfig.character_base64image;
            }

            try {
                const canvas = document.createElement("canvas");
                const ctx = canvas.getContext("2d");
                const imageObj = new Image();

                await new Promise<void>((resolve) => {
                    imageObj.onload = () => resolve();
                    imageObj.src = `data:image/png;base64,${base64img}`;
                });
                signal?.throwIfAborted();

                canvas.width = 1472;
                canvas.height = 1472;

                const scale = Math.min(1472 / imageObj.width, 1472 / imageObj.height);
                const scaledWidth = Math.floor(imageObj.width * scale);
                const scaledHeight = Math.floor(imageObj.height * scale);

                const x = (1472 - scaledWidth) / 2;
                const y = (1472 - scaledHeight) / 2;

                ctx.fillStyle = "black";
                ctx.fillRect(0, 0, 1472, 1472);

                ctx.drawImage(imageObj, x, y, scaledWidth, scaledHeight);

                const blob = await new Promise<Blob>((resolve) => {
                    canvas.toBlob(resolve, "image/png");
                });
                signal?.throwIfAborted();

                if (blob) {
                    const arrayBuffer = await blob.arrayBuffer();
                    signal?.throwIfAborted();
                    base64img = Buffer.from(arrayBuffer).toString("base64");
                }
            } catch (error) {
                signal?.throwIfAborted();
                console.warn("Image resize failed, using original:", error);
            }

            if (base64img) {
                commonReq.body.parameters.director_reference_descriptions = [
                    {
                        caption: {
                            base_caption:
                                "character" + (settings.memoryTranslateMedia.NAIImgConfig.style_aware ? "&style" : ""),
                            char_captions: [],
                        },
                        legacy_uc: settings.memoryTranslateMedia.NAIImgConfig.legacy_uc,
                    },
                ];
                commonReq.body.parameters.director_reference_images = [base64img];
                commonReq.body.parameters.director_reference_information_extracted = [1];
                commonReq.body.parameters.director_reference_strength_values = [1];
            }
        }

        if (settings.memoryTranslateMedia.NAII2I) {
            let seed = random(0, 1000000000);

            let base64img = "";
            if (
                !settings.memoryTranslateMedia.NAIImgConfig.image ||
                settings.memoryTranslateMedia.NAIImgConfig.image === ""
            ) {
                const charimg = currentChar.image;

                const img = await readAsset(charimg, { signal });
                signal?.throwIfAborted();
                if (img) {
                    base64img = Buffer.from(img).toString("base64");
                }
            } else {
                base64img = settings.memoryTranslateMedia.NAIImgConfig.base64image;
            }

            if (base64img) {
                reqlist = commonReq;
                reqlist.body.action = "img2img";
                reqlist.body.parameters.image = base64img;
                reqlist.body.parameters.strength = settings.memoryTranslateMedia.NAIImgConfig.strength || 0.7;
                reqlist.body.parameters.noise = settings.memoryTranslateMedia.NAIImgConfig.noise || 0;
            }

            console.log({ img2img: reqlist });
        } else {
            reqlist = commonReq;
            reqlist.body.action = "generate";

            console.log({ nothing: reqlist });
        }
        try {
            const da = await globalFetch(settings.memoryTranslateMedia.NAIImgUrl, {
                ...reqlist,
                abortSignal: signal,
            });
            signal?.throwIfAborted();

            if (!da.ok) {
                alertError(Buffer.from(da.data).toString());
                return returnSdData === "inlay" ? "" : false;
            }
            const img = await processZip(da.data);
            signal?.throwIfAborted();
            return deliverGeneratedImage(img, currentChar, returnSdData, signal);
        } catch (error) {
            signal?.throwIfAborted();
            alertError(error);
            return false;
        }
    }
    if (settings.memoryTranslateMedia.sdProvider === "dalle") {
        // With the stored OpenAI key, on the server (`auxFetch`).
        const da = await auxFetchJson("openai-dalle", "https://api.openai.com/v1/images/generations", {
            signal,
            method: "POST",
            body: {
                prompt: genPrompt,
                model: "dall-e-3",
                response_format: "b64_json",
                style: "natural",
                quality: settings.memoryTranslateMedia.dallEQuality || "standard",
            },
        });
        signal?.throwIfAborted();

        console.log(da);

        if (returnSdData === "inlay") {
            let res = da?.data?.data?.[0]?.b64_json;
            if (!res) {
                alertError(JSON.stringify(da.data));
                return "";
            }
            return deliverGeneratedImage(`data:image/png;base64,${res}`, currentChar, returnSdData, signal);
        } else if (da.ok) {
            let img = da?.data?.data?.[0]?.b64_json;
            if (!img) {
                alertError(JSON.stringify(da.data));
                return false;
            }
            img = `data:image/png;base64,${img}`;
            return deliverGeneratedImage(img, currentChar, returnSdData, signal);
        } else {
            alertError(Buffer.from(da.data).toString());
            return false;
        }
    }
    if (settings.memoryTranslateMedia.sdProvider === "stability") {
        const formData = new FormData();
        const model = settings.memoryTranslateMedia.stabilityModel;
        formData.append("prompt", genPrompt);
        if (model !== "core" && model !== "ultra") {
            formData.append("negative_prompt", neg);
            formData.append("model", model);
        }
        if (model === "core") {
            if (settings.memoryTranslateMedia.stabllityStyle) {
                formData.append("style_preset", settings.memoryTranslateMedia.stabllityStyle);
            }
        }
        if (model === "ultra") {
            formData.append("negative_prompt", neg);
        }

        const uri = model === "core" ? "core" : model === "ultra" ? "ultra" : "sd3";
        const da = await fetch("https://api.stability.ai/v2beta/stable-image/generate/" + uri, {
            signal,
            body: formData,
            headers: {
                authorization: "Bearer " + settings.secrets.stabilityKey,
                accept: "image/*",
            },
            method: "POST",
        });
        signal?.throwIfAborted();

        const res = await da.arrayBuffer();
        signal?.throwIfAborted();
        if (!da.ok) {
            alertError(Buffer.from(res).toString());
            return false;
        }

        if ((da.headers["content-type"] ?? "").startsWith("application/json")) {
            alertError(Buffer.from(res).toString());
            return false;
        }

        const img = `data:image/png;base64,${Buffer.from(res).toString("base64")}`;
        return deliverGeneratedImage(img, currentChar, returnSdData, signal);
    }

    if (
        settings.memoryTranslateMedia.sdProvider === "comfy" ||
        settings.memoryTranslateMedia.sdProvider === "comfyui"
    ) {
        const legacy = settings.memoryTranslateMedia.sdProvider === "comfy"; // Legacy Comfy mode
        const { workflow, posNodeID, posInputName, negNodeID, negInputName } =
            settings.memoryTranslateMedia.comfyConfig;
        const baseUrl = new URL(settings.memoryTranslateMedia.comfyUiUrl);

        const createUrl = (pathname: string, params: Record<string, string> = {}) => {
            const url = settings.memoryTranslateMedia.comfyUiUrl.endsWith("/api")
                ? new URL(`${settings.memoryTranslateMedia.comfyUiUrl}${pathname}`)
                : new URL(pathname, baseUrl);
            url.search = new URLSearchParams(params).toString();
            return url.toString();
        };

        const fetchWrapper = async (url: string, options = {}) => {
            console.log(url);
            const response = await globalFetch(url, { ...options, abortSignal: signal });
            signal?.throwIfAborted();
            if (!response.ok) {
                console.log(JSON.stringify(response.data));
                throw new Error(JSON.stringify(response.data));
            }
            return response.data;
        };

        try {
            const prompt = JSON.parse(workflow);
            if (legacy) {
                prompt[posNodeID].inputs[posInputName] = genPrompt;
                prompt[negNodeID].inputs[negInputName] = neg;
            } else {
                //search all nodes for the prompt and negative prompt
                const keys = Object.keys(prompt);
                for (let i = 0; i < keys.length; i++) {
                    const node = prompt[keys[i]];
                    const inputKeys = Object.keys(node.inputs);
                    for (let j = 0; j < inputKeys.length; j++) {
                        let input = node.inputs[inputKeys[j]];
                        if (typeof input === "string") {
                            input = input.replaceAll("{{risu_prompt}}", genPrompt);
                            input = input.replaceAll("{{risu_neg}}", neg);
                        }

                        if (inputKeys[j] === "seed" && typeof input === "number") {
                            input = Math.floor(Math.random() * 1000000000);
                        }

                        node.inputs[inputKeys[j]] = input;
                    }
                }
            }

            const submitted = await fetchWrapper(createUrl("/prompt"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: { prompt: prompt },
            });
            signal?.throwIfAborted();
            const id = submitted.prompt_id;
            console.log(`prompt id: ${id}`);

            let item;
            let scopedHistory = true;

            const startTime = Date.now();
            const timeout = settings.memoryTranslateMedia.comfyConfig.timeout * 1000;
            while (true) {
                signal?.throwIfAborted();
                if (Date.now() - startTime >= timeout) {
                    alertError("Error: Image generation took longer than expected.");
                    return false;
                }
                const historyResponse = await fetchNative(
                    createUrl(scopedHistory ? `/history/${encodeURIComponent(id)}` : "/history"),
                    {
                        headers: { "Content-Type": "application/json" },
                        method: "GET",
                        signal,
                    },
                );
                signal?.throwIfAborted();
                if (scopedHistory && (historyResponse.status === 404 || historyResponse.status === 405)) {
                    scopedHistory = false;
                    continue;
                }
                if (!historyResponse.ok) {
                    throw new Error(`ComfyUI history request failed with status ${historyResponse.status}`);
                }
                const history = await historyResponse.json();
                signal?.throwIfAborted();
                item = history[id];
                if (item) {
                    break;
                }
                console.log("Checking /history...");
                await pollingDelay(1000, signal);
                signal?.throwIfAborted();
            } // Check history until the generation is complete.
            const genImgInfo = Object.values(item.outputs).flatMap((output: any) => output.images)[0];

            const imgResponse = await fetchNative(
                createUrl("/view", {
                    filename: genImgInfo.filename,
                    subfolder: genImgInfo.subfolder,
                    type: genImgInfo.type,
                }),
                {
                    headers: { "Content-Type": "application/json" },
                    method: "GET",
                    signal,
                },
            );
            signal?.throwIfAborted();
            const imageBytes = await imgResponse.arrayBuffer();
            signal?.throwIfAborted();
            const img64 = Buffer.from(imageBytes).toString("base64");

            return deliverGeneratedImage(`data:image/png;base64,${img64}`, currentChar, returnSdData, signal);
        } catch (error) {
            signal?.throwIfAborted();
            alertError(error);
            return false;
        }
    }
    if (settings.memoryTranslateMedia.sdProvider === "fal") {
        const model = settings.memoryTranslateMedia.falModel;
        const token = settings.secrets.falToken;

        let body: { [key: string]: any } = {
            prompt: genPrompt,
            enable_safety_checker: false,
            sync_mode: true,
            image_size: {
                width: settings.memoryTranslateMedia.sdConfig.width,
                height: settings.memoryTranslateMedia.sdConfig.height,
            },
        };

        if (settings.memoryTranslateMedia.falModel === "fal-ai/flux-lora") {
            let loraPath = settings.memoryTranslateMedia.falLora;
            if (loraPath.startsWith("urn:") || loraPath.startsWith("civitai:")) {
                const id = loraPath.split("@").pop();
                loraPath = `https://civitai.com/api/download/models/${id}?type=Model&format=SafeTensor`;
            }
            body.loras = [
                {
                    path: loraPath,
                    scale: settings.memoryTranslateMedia.falLoraScale,
                },
            ];
        }

        if (settings.memoryTranslateMedia.falModel === "fal-ai/flux-pro") {
            delete body.enable_safety_checker;
        }

        const res = await globalFetch("https://fal.run/" + model, {
            abortSignal: signal,
            headers: {
                Authorization: "Key " + token,
                "Content-Type": "application/json",
            },
            method: "POST",
            body: body,
        });
        signal?.throwIfAborted();

        if (!res.ok) {
            alertError(JSON.stringify(res.data));
            return false;
        }

        let image = res.data?.images?.[0]?.url;
        if (!image) {
            alertError(JSON.stringify(res.data));
            return false;
        }

        return deliverGeneratedImage(image, currentChar, returnSdData, signal);
    }
    if (settings.memoryTranslateMedia.sdProvider === "Imagen") {
        const model = settings.memoryTranslateMedia.ImagenModel;
        const size = settings.memoryTranslateMedia.ImagenImageSize;
        const aspect = settings.memoryTranslateMedia.ImagenAspectRatio;
        const person = settings.memoryTranslateMedia.ImagenPersonGeneration;

        let body: any = {
            instances: [
                {
                    prompt: genPrompt,
                },
            ],
            parameters: {
                sampleCount: 1,
                aspectRatio: aspect,
                personGeneration: person,
            },
        };

        if (model === "imagen-4.0-generate-001" || model === "imagen-4.0-ultra-generate-001") {
            body.parameters = {
                ...body.parameters,
                sampleImageSize: size,
            };
        }

        // With the stored Google key, on the server (`auxFetch`).
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict`;

        const res = await auxFetchJson("google-imagen", url, {
            signal,
            headers: {
                "Content-Type": "application/json",
            },
            method: "POST",
            body: body,
        });
        signal?.throwIfAborted();

        if (!res.ok) {
            alertError(JSON.stringify(res.data));
            return false;
        }

        const img64 = res.data?.predictions?.[0]?.bytesBase64Encoded;

        if (!img64) {
            alertError(JSON.stringify(res.data));
            return false;
        }

        const mimeType = res.data?.predictions?.[0]?.mimeType || "image/png";
        return deliverGeneratedImage(`data:${mimeType};base64,${img64}`, currentChar, returnSdData, signal);
    }
    if (settings.memoryTranslateMedia.sdProvider === "openai-compat") {
        const config = settings.secrets.openaiCompatImage;
        if (!config.url) {
            alertError("OpenAI Compatible API URL is not set");
            return false;
        }

        const body: { [key: string]: any } = {
            prompt: genPrompt,
            response_format: "b64_json",
            size: config.size || "1024x1024",
            quality: config.quality || "auto",
        };

        if (config.model) {
            body.model = config.model;
        }

        const headers: { [key: string]: string } = {
            "Content-Type": "application/json",
        };

        if (config.key) {
            headers["Authorization"] = "Bearer " + config.key;
        }

        const da = await globalFetch(config.url, {
            abortSignal: signal,
            body: body,
            headers: headers,
        });
        signal?.throwIfAborted();

        if (returnSdData === "inlay") {
            let res = da?.data?.data?.[0]?.b64_json;
            if (!res) {
                alertError(JSON.stringify(da.data));
                return "";
            }
            return deliverGeneratedImage(`data:image/png;base64,${res}`, currentChar, returnSdData, signal);
        }

        if (da.ok) {
            let img = da?.data?.data?.[0]?.b64_json;
            if (!img) {
                alertError(JSON.stringify(da.data));
                return false;
            }
            img = `data:image/png;base64,${img}`;
            return deliverGeneratedImage(img, currentChar, returnSdData, signal);
        } else {
            alertError(JSON.stringify(da.data));
            return false;
        }
    }
    if (settings.memoryTranslateMedia.sdProvider === "wavespeed") {
        const config = settings.secrets.wavespeedImage;
        if (!config.key) {
            alertError("Please enter wavespeed API key");
            return false;
        }
        const body: { [key: string]: any } = {};

        // Prompt
        body.prompt = genPrompt;

        // reference image
        let base64img = "";
        if (config.reference_mode === "image") {
            // reference: uploaded image
            base64img = config.reference_base64image;
        } else if (config.reference_mode === "character") {
            // reference: auto use the character's default image
            const charimg = currentChar.image;
            const img = await readAsset(charimg, { signal });
            signal?.throwIfAborted();
            if (img) {
                base64img = Buffer.from(img).toString("base64");
            }
        }
        if (base64img) {
            body.images = [base64img];
        }

        // LoRAs
        if (config.loras && Array.isArray(config.loras)) {
            body.loras = [];
            for (const lora of config.loras) {
                if (lora && lora.path && lora.path.trim() !== "") {
                    body.loras.push({
                        path: lora.path,
                        scale: typeof lora.scale === "number" ? lora.scale : 1.0,
                    });
                }
            }
        }

        // Request
        try {
            // First: submit task
            const requestEndpoint = `https://api.wavespeed.ai/api/v3/${config.model}`;
            const requestResponse = await globalFetch(requestEndpoint, {
                abortSignal: signal,
                body: body,
                headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + config.key,
                },
            });
            signal?.throwIfAborted();
            let requestId: string;
            if (requestResponse.ok) {
                /*
                 * submit response:
                 * {
                 *   code: number = HTTP status code (e.g., 200 for success)
                 *   message: string = Status message (e.g., “success”)
                 *   data: {
                 *     id: string = Unique identifier for the prediction, Task Id
                 *   }
                 * }
                 * */
                requestId = requestResponse.data.data.id;
            } else {
                alertError(`Submit task failed ${requestResponse.status}: ${requestResponse.data}`);
                return false;
            }

            // Second: monitor task
            const taskEndpoint = `https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`;
            let resultEndpoint: string;
            const POLL_INTERVAL = 3000; // monitor every 3 seconds
            const MAX_WAIT_TIME = 10 * 60 * 1000; // 10 minutes absolute timeout
            const startTime = Date.now();
            while (true) {
                const elapsedTime = Date.now() - startTime;
                if (elapsedTime > MAX_WAIT_TIME) {
                    alertError(`Task timeout after ${MAX_WAIT_TIME / 1000}s`);
                    break;
                }
                const taskResponse = await globalFetch(taskEndpoint, {
                    abortSignal: signal,
                    method: "GET",
                    headers: {
                        Authorization: "Bearer " + config.key,
                    },
                });
                signal?.throwIfAborted();
                if (taskResponse.ok) {
                    /*
                     * monitor response:
                     * {
                     *   code: number = HTTP status code (e.g., 200 for success)
                     *   message: string = Status message (e.g., “success”)
                     *   data: {
                     *     status: string = Status of the task: created, processing, completed, or failed
                     *     outputs: string[] = Array of URLs to the generated content (empty when status is not completed)
                     *   }
                     * }
                     * */
                    if (taskResponse.data.data.status === "completed") {
                        resultEndpoint = taskResponse.data.data.outputs[0];
                        break;
                    } else if (taskResponse.data.data.status === "failed") {
                        alertError(JSON.stringify(taskResponse.data));
                        break;
                    }
                    // else keep loop
                    await pollingDelay(POLL_INTERVAL, signal);
                    signal?.throwIfAborted();
                } else {
                    alertError(JSON.stringify(taskResponse.data));
                    break;
                }
            }
            if (!resultEndpoint) {
                alertError("Task finished but no result URL");
                return false;
            }

            // Third: get result
            const resultResponse = await globalFetch(resultEndpoint, {
                abortSignal: signal,
                method: "GET",
                headers: {
                    Authorization: "Bearer " + config.key,
                },
                rawResponse: true,
            });
            signal?.throwIfAborted();
            if (resultResponse.ok) {
                // mime-type: jpeg (default), png, webp
                const contentType = resultResponse.headers?.["content-type"] || "image/jpeg";
                const mimeType = contentType.split(";")[0]; // resolve "image/png; charset=utf-8"

                // binary image file, need to convert to base64
                const binary = resultResponse.data;
                const res = Buffer.from(binary).toString("base64");
                const img = `data:${mimeType};base64,${res}`;

                return deliverGeneratedImage(img, currentChar, returnSdData, signal);
            } else {
                alertError(JSON.stringify(resultResponse.data));
                return false;
            }
        } catch (error) {
            signal?.throwIfAborted();
            alertError(error);
            return false;
        }
    }
    return "";
}

/** Places the longer edge on the width for landscape and on the height for portrait. */
export function applyImageOrientation(width: number, height: number, orientation?: ImageOrientation) {
    if (!orientation) {
        return { height, width };
    }

    const longerEdge = Math.max(height, width);
    const shorterEdge = Math.min(height, width);

    if (orientation === "landscape") {
        return {
            height: shorterEdge,
            width: longerEdge,
        };
    }

    return {
        height: longerEdge,
        width: shorterEdge,
    };
}
