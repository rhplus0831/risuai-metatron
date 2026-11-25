import { assetExtension, assetMimeType } from "../../../../../shared/assetMime.ts";

export type AssetKind = "image" | "audio" | "video" | "other";

/** Both cleanup lists classify the asset key using the server's MIME mapping. */
export function cleanupAssetKind(key: string | null): AssetKind {
    const mime = assetMimeType(assetExtension(key ?? ""));
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("video/")) return "video";
    return "other";
}

/** Keep human-readable basenames intact; shorten a hexadecimal content hash. */
export function shortAssetKey(key: string): string {
    const basename = key.slice(key.lastIndexOf("/") + 1);
    const dot = basename.lastIndexOf(".");
    const stem = dot === -1 ? basename : basename.slice(0, dot);
    return /^[\da-f]{12,}$/i.test(stem) ? stem.slice(0, 12) : basename;
}
