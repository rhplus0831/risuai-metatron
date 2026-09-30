import type { SectionResource } from "../../../../shared/resources.ts";
import { isPlainObject, normalizeSection, type SectionSpec } from "./shared.ts";

/**
 * The `memoryTranslateMedia` section: memory, translation, TTS, emotion, and image generation
 * options.
 */
const spec: SectionSpec<"memoryTranslateMedia"> = {
    loreBookDepth: ["number", 5],
    supaMemoryPrompt: ["string", ""],
    translator: ["string", ""],
    autoTranslate: ["boolean", false],
    sdProvider: ["string", ""],
    webUiUrl: ["string", "http://127.0.0.1:7860/"],
    sdSteps: ["number", 30],
    sdCFG: ["number", 7],
    sdConfig: [
        "object",
        {
            width: 512,
            height: 512,
            sampler_name: "Euler a",
            script_name: "",
            denoising_strength: 0.7,
            enable_hr: false,
            hr_scale: 1.25,
            hr_upscaler: "Latent",
        },
    ],
    NAIImgUrl: ["string", "https://image.novelai.net/ai/generate-image"],
    NAIImgModel: ["string", "nai-diffusion-4-5-full"],
    NAII2I: ["boolean", false],
    NAIImgConfig: [
        "object",
        {
            width: 1024,
            height: 1024,
            sampler: "k_euler_ancestral",
            noise_schedule: "karras",
            steps: 28,
            scale: 5,
            cfg_rescale: 0,
            sm: true,
            sm_dyn: false,
            noise: 0,
            strength: 0.6,
            image: "",
            base64image: "",
            InfoExtracted: 1,
            autoSmea: false,
            legacy_uc: false,
            use_coords: false,
            v4_prompt: { caption: { base_caption: "", char_captions: [] }, use_coords: false, use_order: true },
            v4_negative_prompt: { caption: { base_caption: "", char_captions: [] }, legacy_uc: false },
            variety_plus: false,
            decrisp: false,
            reference_mode: "",
            character_image: "",
            character_base64image: "",
            style_aware: false,
        },
    ],
    ttsAutoSpeech: ["boolean", false],
    emotionPrompt2: ["string", ""],
    voicevoxUrl: ["string", ""],
    supaModelType: ["string", "none"],
    useAutoTranslateInput: ["boolean"],
    imageCompression: ["boolean", true],
    hypaMemory: ["boolean"],
    hypav2: ["boolean"],
    hypaModel: ["string", "MiniLM"],
    emotionProcesser: ["string", "submodel"],
    translatorType: ["string", "google"],
    translatorInputLanguage: ["string", "auto"],
    htmlTranslation: ["boolean", false],
    removePunctuationHypa: ["boolean", true],
    noWaitForTranslate: ["boolean"],
    maxSupaChunkSize: ["number", 1200],
    hanuraiTokens: ["number", 1000],
    hanuraiSplit: ["boolean", false],
    hanuraiEnable: ["boolean", false],
    combineTranslation: ["boolean", false],
    dynamicAssets: ["boolean"],
    hypaAllocatedTokens: ["number", 3000],
    hypaChunkSize: ["number", 3000],
    dallEQuality: ["string", "standard"],
    stabilityModel: ["string", "sd3-large"],
    stabllityStyle: ["string", ""],
    legacyTranslation: ["boolean", false],
    comfyConfig: [
        "object",
        { workflow: "", posNodeID: "", posInputName: "text", negNodeID: "", negInputName: "text", timeout: 30 },
    ],
    comfyUiUrl: ["string", "http://localhost:8188"],
    falModel: ["string", "fal-ai/flux/dev"],
    falLora: ["string"],
    falLoraScale: ["number", 1],
    translateBeforeHTMLFormatting: ["boolean"],
    autoTranslateCachedOnly: ["boolean"],
    hypaV3: ["boolean"],
    useExperimentalGoogleTranslator: ["boolean", false],
    playMessageOnTranslateEnd: ["boolean"],
    newImageHandlingBeta: ["boolean"],
    ImagenModel: ["string", "imagen-4.0-generate-001"],
    ImagenImageSize: ["string", "1K"],
    ImagenAspectRatio: ["string", "1:1"],
    ImagenPersonGeneration: ["string", "allow_all"],
};

export function normalizeMemoryTranslateMedia(input: unknown): SectionResource<"memoryTranslateMedia"> {
    const record = normalizeSection("memoryTranslateMedia", spec, input);
    // The NAI v4 fields, added to a config saved before them (the `setDatabase` migration).
    const nai = record.NAIImgConfig;
    if (isPlainObject(nai) && (nai.v4_prompt === undefined || nai.v4_prompt === null)) {
        nai.autoSmea = false;
        nai.use_coords = false;
        nai.legacy_uc = false;
        nai.v4_prompt = { caption: { base_caption: "", char_captions: [] }, use_coords: false, use_order: true };
        nai.v4_negative_prompt = { caption: { base_caption: "", char_captions: [] }, legacy_uc: false };
    }
    return record as SectionResource<"memoryTranslateMedia">;
}
