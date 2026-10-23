const ASSET_MIME_TYPES: Readonly<Record<string, string>> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    avif: "image/avif",
    svg: "image/svg+xml",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    webm: "video/webm",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    json: "application/json",
};

const ACTIVE_ASSET_EXTENSIONS: ReadonlySet<string> = new Set(["html", "htm", "xhtml", "xml", "js", "mjs"]);

/** The lowercase extension of the logical key's last path segment, or an empty string. */
export function assetExtension(key: string): string {
    const name = key.slice(key.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The media type for an extension, with an opaque binary fallback for unknown types. */
export function assetMimeType(extension: string): string {
    const ext = extension.toLowerCase();
    return Object.hasOwn(ASSET_MIME_TYPES, ext) ? ASSET_MIME_TYPES[ext] : "application/octet-stream";
}

/** Active document and script types are downloaded; SVG stays inline under the asset route's CSP. */
export function isActiveAssetExtension(extension: string): boolean {
    return ACTIVE_ASSET_EXTENSIONS.has(extension.toLowerCase());
}
