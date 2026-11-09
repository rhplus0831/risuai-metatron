import { settings } from "../../storage/settingsViews.svelte";
import { getImageType } from "../imageType";
import { doLossyCompression } from "./lossyCompression";

/**
 * Compresses recognized JPEG/PNG/GIF/BMP only when the persisted `db.imageCompression`
 * setting (`settings.memoryTranslateMedia.imageCompression`) is enabled. WEBP, AVIF,
 * and Unknown pass through untouched. `doLossyCompression` in
 * `src/ts/media/compressImage/lossyCompression.ts` labels the input with its detected MIME type.
 */
export async function compressImage(data: Uint8Array) {
    if (!settings.memoryTranslateMedia.imageCompression) {
        return data;
    }

    const type = getImageType(data);
    if (type !== "Unknown" && type !== "WEBP" && type !== "AVIF") {
        return await doLossyCompression(data);
    }

    return data;
}
