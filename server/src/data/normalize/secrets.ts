import type { SectionResource } from "../../../../shared/resources.ts";
import { isPlainObject, normalizeSection, type SectionSpec } from "./shared.ts";

/** The `secrets` section: credentials of image, voice, translation, and search services. */
const spec: SectionSpec<"secrets"> = {
    NAIApiKey: ["string", ""],
    elevenLabKey: ["string", ""],
    voyageApiKey: ["string", ""],
    deeplOptions: ["object", { key: "", freeApi: false }],
    deeplXOptions: ["object", { url: "", token: "" }],
    huggingfaceKey: ["string", ""],
    fishSpeechKey: ["string", ""],
    stabilityKey: ["string"],
    falToken: ["string"],
    hypaCustomSettings: ["object", { url: "", key: "", model: "" }],
    openaiCompatImage: ["object", { url: "", key: "", model: "", size: "1024x1024", quality: "auto" }],
    wavespeedImage: [
        "object",
        { key: "", model: "", loras: [], reference_mode: "", reference_image: "", reference_base64image: "" },
    ],
    googleSearchCredentials: ["object"],
};

export function normalizeSecrets(input: unknown): SectionResource<"secrets"> {
    const record = normalizeSection("secrets", spec, input);
    // `setDatabase` rebuilt this object with exactly these three strings.
    const custom = isPlainObject(record.hypaCustomSettings) ? record.hypaCustomSettings : {};
    record.hypaCustomSettings = {
        url: typeof custom.url === "string" ? custom.url : "",
        key: typeof custom.key === "string" ? custom.key : "",
        model: typeof custom.model === "string" ? custom.model : "",
    };
    return record as SectionResource<"secrets">;
}
