import { activePreset } from "../../storage/settingsViews.svelte";
import { v4 } from "uuid";
import { getImageType } from "src/ts/media";
import { getModelInfo, LLMFlags, LLMFormat } from "src/ts/model/modellist";
import { asBuffer } from "../../util";
import {
    compareRevision,
    type InlayResource,
    RESOURCE_KIND,
    type ResourceRecord,
} from "../../../../shared/resources.ts";
import {
    deleteResource,
    getResource,
    putResource,
    ResourceConflictError,
    readKinds,
} from "../../storage/resourceClient";
import { authFetch } from "../../storage/serverAuth";
import { readAsset, writeAsset } from "../../storage/assetClient";

/**
 * Inlays (media and signatures referenced from chat text as `{{inlay::id}}`, `{{inlayed::id}}`, or
 * `{{inlayeddata::id}}`) live on the server: metadata in the `inlays` resource (id = inlay id), media
 * bytes in the `assets` namespace under a content-hash name, so writing the same bytes twice (Lua
 * `getCharacterImageMain` on every call) stores one file. Committed blobs are never deleted here:
 * retained server snapshots may still reference them.
 */

export type InlayAsset = {
    data: string | Blob;
    /** File extension */
    ext: string;
    height?: number;
    name: string;
    type: "image" | "video" | "audio" | "signature";
    width?: number;
};

const inlayImageExts = ["jpg", "jpeg", "png", "gif", "webp", "avif"];

const inlayAudioExts = ["wav", "mp3", "ogg", "flac"];

const inlayVideoExts = ["webm", "mp4", "mkv"];

const MAX_BLOB_CACHE_BYTES = 64 * 1024 * 1024;
/** How long an id is remembered as missing before it is asked for again (another tab may create it). */
const MISSING_ID_TTL_MS = 30_000;

type Meta = { revision: string; data: InlayResource };

/**
 * Metadata cache. Metadata is mutable (a same-id rewrite, a deletion), so the cache is only as fresh
 * as this tab's own writes plus `invalidateInlayCaches`, which the save adapter's remote-change
 * listener calls when a conflict brought another tab's records into the mirror; `listInlayAssets`
 * replaces the whole view. Media blobs are content-addressed and stay cached.
 */
const metaCache = new Map<string, Meta>();
/** Ids known not to exist (→ when to ask again), so a stale marker does not cost a request per render. */
const missingIds = new Map<string, number>();
const pendingMeta = new Map<string, Promise<Meta | null>>();
/** Blobs by asset key, oldest first; bounded by total bytes. */
const blobCache = new Map<string, Blob>();
let blobCacheBytes = 0;
const pendingBlobs = new Map<string, Promise<Blob | null>>();
/** Every public write to one id (preparation, upload, and metadata) runs after the previous one. */
const writeQueues = new Map<string, Promise<unknown>>();

/** Seeds the metadata cache from the boot read. */
export function seedInlays(records: readonly ResourceRecord[]) {
    metaCache.clear();
    missingIds.clear();
    for (const record of records) {
        metaCache.set(record.id, { revision: record.revision, data: record.data as InlayResource });
    }
}

/**
 * Live updates (Phase 6) invalidate cached metadata; a metadata read that began before an
 * invalidation must not put an older copy back. `changeCount` counts invalidations; `changedAt` holds
 * the count at an id's last invalidation, `reconciledAt` the count at the last reconnect (every id).
 */
let changeCount = 0;
let reconciledAt = 0;
const changedAt = new Map<string, number>();

/** Whether a read issued at `issuedAt` may still fill the cache for `id`. */
function stillCurrent(id: string, issuedAt: number): boolean {
    return reconciledAt <= issuedAt && (changedAt.get(id) ?? 0) <= issuedAt;
}

/** Records that `id`'s cached metadata changed now (a live update, or this tab's own write or delete). */
function markChanged(id: string) {
    changeCount += 1;
    changedAt.set(id, changeCount);
}

/**
 * Puts a read's answer into the cache when no invalidation or write landed since the read was issued
 * (`issuedAt`) and the cache holds nothing newer. Returns whether it did.
 */
function fillMeta(id: string, meta: Meta, issuedAt: number): boolean {
    if (!stillCurrent(id, issuedAt)) {
        return false;
    }
    const cached = metaCache.get(id);
    if (cached && (compareRevision(cached.revision, meta.revision) ?? 0) > 0) {
        return false;
    }
    metaCache.set(id, meta);
    return true;
}

/**
 * A live update: another tab or device committed inlay `id` at `revision` (null: deleted). The
 * cached metadata is dropped unless it is that revision or newer; the next read asks the server.
 */
export function noteRemoteInlay(id: string, revision: string | null) {
    const cached = metaCache.get(id);
    if (revision !== null && cached && (compareRevision(cached.revision, revision) ?? -1) >= 0) {
        return;
    }
    markChanged(id);
    metaCache.delete(id);
    missingIds.delete(id);
}

/**
 * After a reconnect: every inlay the server lists with its revision. Cached metadata older than the
 * listed revision, or of an inlay no longer listed, is dropped, and an id listed now is no longer
 * remembered as missing; reads in flight do not fill the cache.
 */
export function reconcileInlays(listed: ReadonlyMap<string, string>) {
    changeCount += 1;
    reconciledAt = changeCount;
    for (const [id, meta] of [...metaCache]) {
        const revision = listed.get(id);
        if (revision === undefined || (compareRevision(meta.revision, revision) ?? -1) < 0) {
            metaCache.delete(id);
        }
    }
    for (const id of [...missingIds.keys()]) {
        if (listed.has(id)) {
            missingIds.delete(id);
        }
    }
}

/**
 * Drops the metadata and negative caches (not the content-addressed blobs): the next read asks the
 * server, and reads in flight do not fill the cache.
 */
export function invalidateInlayCaches() {
    changeCount += 1;
    reconciledAt = changeCount;
    clearMetaCaches();
}

function clearMetaCaches() {
    metaCache.clear();
    missingIds.clear();
}

function mimeOf(meta: InlayResource): string {
    const ext = meta.ext.toLowerCase();
    if (meta.type === "image") {
        return `image/${ext === "jpg" ? "jpeg" : ext}`;
    }
    if (meta.type === "audio") {
        return `audio/${ext === "mp3" ? "mpeg" : ext}`;
    }
    if (meta.type === "video") {
        return `video/${ext}`;
    }
    return "application/json";
}

async function getMeta(id: string): Promise<Meta | null> {
    const cached = metaCache.get(id);
    if (cached) {
        return cached;
    }
    const missingUntil = missingIds.get(id);
    if (missingUntil !== undefined) {
        if (Date.now() < missingUntil) {
            return null;
        }
        missingIds.delete(id);
    }
    let pending = pendingMeta.get(id);
    if (!pending) {
        pending = (async () => {
            try {
                // A live update that lands during the read makes its answer stale: read again.
                for (let attempt = 0; ; attempt += 1) {
                    const issuedAt = changeCount;
                    const record = await getResource<InlayResource>(RESOURCE_KIND.inlays, id);
                    const current = stillCurrent(id, issuedAt);
                    if (!current && attempt < 2) {
                        continue;
                    }
                    if (!record) {
                        if (current) {
                            missingIds.set(id, Date.now() + MISSING_ID_TTL_MS);
                        }
                        return null;
                    }
                    const meta = { revision: record.revision, data: record.data };
                    if (current) {
                        fillMeta(id, meta, issuedAt);
                    }
                    return meta;
                }
            } finally {
                pendingMeta.delete(id);
            }
        })();
        pendingMeta.set(id, pending);
    }
    return pending;
}

function cacheBlob(key: string, blob: Blob) {
    if (blob.size > MAX_BLOB_CACHE_BYTES) {
        return;
    }
    if (blobCache.has(key)) {
        blobCacheBytes -= blobCache.get(key)!.size;
        blobCache.delete(key);
    }
    blobCache.set(key, blob);
    blobCacheBytes += blob.size;
    for (const [oldKey, oldBlob] of blobCache) {
        if (blobCacheBytes <= MAX_BLOB_CACHE_BYTES) {
            break;
        }
        blobCache.delete(oldKey);
        blobCacheBytes -= oldBlob.size;
    }
}

async function getBlob(meta: InlayResource): Promise<Blob | null> {
    const key = meta.asset;
    if (!key) {
        return null;
    }
    const cached = blobCache.get(key);
    if (cached) {
        // Refresh its place in the eviction order.
        blobCache.delete(key);
        blobCache.set(key, cached);
        return cached;
    }
    let pending = pendingBlobs.get(key);
    if (!pending) {
        pending = (async () => {
            try {
                const bytes = await readAsset(key);
                if (!bytes) {
                    return null;
                }
                const blob = new Blob([asBuffer(bytes)], { type: mimeOf(meta) });
                cacheBlob(key, blob);
                return blob;
            } finally {
                pendingBlobs.delete(key);
            }
        })();
        pendingBlobs.set(key, pending);
    }
    return pending;
}

function serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = writeQueues.get(id) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => {});
    writeQueues.set(id, tail);
    void tail.then(() => {
        if (writeQueues.get(id) === tail) {
            writeQueues.delete(id);
        }
    });
    return run;
}

/**
 * Writes an inlay's metadata. Same-id writes keep today's last-writer-wins semantics: a conflict
 * with another tab re-reads the record once and writes over it.
 */
/** Callers hold the id's write queue (`serialize`). `check` throws to stop before each write. */
function putMeta(id: string, data: InlayResource, check?: () => void): Promise<void> {
    return (async () => {
        let base = metaCache.get(id)?.revision ?? null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            check?.();
            try {
                const saved = await putResource(RESOURCE_KIND.inlays, id, data, base);
                markChanged(id);
                metaCache.set(id, { revision: saved.revision, data });
                missingIds.delete(id);
                return;
            } catch (error) {
                if (!(error instanceof ResourceConflictError) || attempt === 1) {
                    throw error;
                }
                const current = await getResource<InlayResource>(RESOURCE_KIND.inlays, id);
                base = current?.revision ?? null;
            }
        }
    })();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    return Buffer.from(await crypto.subtle.digest("SHA-256", asBuffer(bytes))).toString("hex");
}

/** The asset key media bytes are stored under: their content hash and a sanitized extension. */
async function mediaKey(bytes: Uint8Array, ext: string): Promise<string> {
    const safeExt = ext.replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "bin";
    return `assets/inlay_${await sha256Hex(bytes)}.${safeExt}`;
}

/** Stores media bytes under their content hash; returns the asset key. `check` throws to stop before the upload. */
async function storeMedia(
    bytes: Uint8Array,
    ext: string,
    meta: Omit<InlayResource, "asset">,
    check?: () => void,
): Promise<string> {
    const key = await mediaKey(bytes, ext);
    check?.();
    if (!blobCache.has(key)) {
        await writeAsset(key, bytes);
        cacheBlob(key, new Blob([asBuffer(bytes)], { type: mimeOf({ ...meta, asset: key }) }));
    }
    return key;
}

async function writeMedia(
    id: string,
    bytes: Uint8Array,
    meta: Omit<InlayResource, "asset" | "size">,
    check?: () => void,
) {
    check?.();
    const asset = await storeMedia(bytes, meta.ext, meta, check);
    const data: InlayResource = { ...meta, asset, size: bytes.byteLength };
    const current = metaCache.get(id)?.data;
    if (current && JSON.stringify(current) === JSON.stringify(data)) {
        return;
    }
    await putMeta(id, data, check);
}

export async function postInlayAsset(img: { name: string; data: Uint8Array }) {
    const extention = img.name.split(".").at(-1);
    const imgObj = new Image();

    if (inlayImageExts.includes(extention)) {
        imgObj.src = URL.createObjectURL(new Blob([asBuffer(img.data)], { type: `image/${extention}` }));

        return await writeInlayImage(imgObj, {
            name: img.name,
            ext: extention,
        });
    }

    if (inlayAudioExts.includes(extention)) {
        const imgid = v4();
        await serialize(imgid, () => writeMedia(imgid, img.data, { name: img.name, ext: extention, type: "audio" }));
        return `${imgid}`;
    }

    if (inlayVideoExts.includes(extention)) {
        const imgid = v4();
        await serialize(imgid, () => writeMedia(imgid, img.data, { name: img.name, ext: extention, type: "video" }));
        return `${imgid}`;
    }

    return null;
}

/**
 * Draws an image as an inlay (PNG, at most 1024² pixels). `check`, when given, throws to stop the
 * write: it runs after the wait for the id's queue, after the image loads and encodes, and before
 * the media and the metadata are written (a server job's callback that was cancelled meanwhile).
 */
export async function writeInlayImage(
    imgObj: HTMLImageElement,
    arg: { name?: string; ext?: string; id?: string; check?: () => void } = {},
) {
    const imgid = arg.id ?? v4();
    return serialize(imgid, () => drawInlayImage(imgObj, imgid, arg));
}

async function drawInlayImage(imgObj: HTMLImageElement, imgid: string, arg: { name?: string; check?: () => void }) {
    arg.check?.();
    let drawHeight = 0;
    let drawWidth = 0;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    await new Promise<void>((resolve, reject) => {
        const draw = () => {
            drawHeight = imgObj.height;
            drawWidth = imgObj.width;

            //resize image to fit inlay, if total pixels exceed 1024*1024
            const maxPixels = 1024 * 1024;
            const currentPixels = drawHeight * drawWidth;

            if (currentPixels > maxPixels) {
                const scaleFactor = Math.sqrt(maxPixels / currentPixels);
                drawWidth = Math.floor(drawWidth * scaleFactor);
                drawHeight = Math.floor(drawHeight * scaleFactor);
            }

            canvas.width = drawWidth;
            canvas.height = drawHeight;
            ctx.drawImage(imgObj, 0, 0, drawWidth, drawHeight);
            resolve();
        };
        // The write may start after the image finished loading (it waited in the id's queue).
        if (imgObj.complete) {
            if (imgObj.naturalWidth > 0) {
                draw();
            } else {
                reject(new Error("The inlay image could not be loaded"));
            }
            return;
        }
        imgObj.onload = draw;
        imgObj.onerror = () => reject(new Error("The inlay image could not be loaded"));
    });
    arg.check?.();
    const imageBlob = await new Promise<Blob>((resolve) => canvas.toBlob(resolve, "image/png"));

    await writeMedia(
        imgid,
        new Uint8Array(await imageBlob.arrayBuffer()),
        {
            name: arg.name ?? imgid,
            ext: "png",
            height: drawHeight,
            width: drawWidth,
            type: "image",
        },
        arg.check,
    );

    return `${imgid}`;
}

export type InlaySignature = {
    signatures: {
        type: "function" | "text";
        content: string;
    }[];
    sourceFormat: LLMFormat;
    source: string;
};

export async function saveInlayedSignature(sigid: string, signature: InlaySignature) {
    await serialize(sigid, () =>
        putMeta(sigid, { name: sigid, ext: "json", type: "signature", text: JSON.stringify(signature) }),
    );
    return sigid;
}

function dataUriToBytes(uri: string): Uint8Array {
    const base64 = uri.slice(uri.indexOf(",") + 1);
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function blobToBase64(blob: Blob): Promise<string> {
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    return new Promise<string>((resolve, reject) => {
        reader.onloadend = () => {
            resolve(reader.result as string);
        };
        reader.onerror = reject;
    });
}

function toAsset(meta: InlayResource, data: string | Blob): InlayAsset {
    const asset: InlayAsset = { name: meta.name, ext: meta.ext, type: meta.type, data };
    if (meta.width !== undefined) {
        asset.width = meta.width;
    }
    if (meta.height !== undefined) {
        asset.height = meta.height;
    }
    return asset;
}

// Returns with base64 data URI (a signature keeps its JSON text)
export async function getInlayAsset(id: string): Promise<(InlayAsset & { data: string }) | null> {
    const meta = await getMeta(id);
    if (!meta) {
        return null;
    }
    if (meta.data.type === "signature") {
        return toAsset(meta.data, meta.data.text ?? "") as InlayAsset & { data: string };
    }
    const blob = await getBlob(meta.data);
    if (!blob) {
        return null;
    }
    return toAsset(meta.data, await blobToBase64(blob)) as InlayAsset & { data: string };
}

// Returns with Blob
export async function getInlayAssetBlob(id: string): Promise<(InlayAsset & { data: Blob }) | null> {
    const meta = await getMeta(id);
    if (!meta) {
        return null;
    }
    if (meta.data.type === "signature") {
        return toAsset(meta.data, new Blob([meta.data.text ?? ""], { type: "application/json" })) as InlayAsset & {
            data: Blob;
        };
    }
    const blob = await getBlob(meta.data);
    if (!blob) {
        return null;
    }
    return toAsset(meta.data, blob) as InlayAsset & { data: Blob };
}

/** Every inlay's metadata (read fresh from the server; no media bytes). The listing replaces the cached view. */
export async function listInlayAssets(): Promise<[id: string, InlayResource][]> {
    const issuedAt = changeCount;
    const result = await readKinds([RESOURCE_KIND.inlays]);
    const records = result.kinds[RESOURCE_KIND.inlays] ?? [];
    if (reconciledAt <= issuedAt) {
        clearMetaCaches();
    }
    for (const record of records) {
        // A live update or a write that landed during the read keeps that id's newer state.
        fillMeta(record.id, { revision: record.revision, data: record.data as InlayResource }, issuedAt);
    }
    return records.map((record) => [record.id, record.data as InlayResource]);
}

function toBytes(data: string | Blob): Promise<Uint8Array> | Uint8Array {
    return typeof data === "string"
        ? dataUriToBytes(data)
        : data.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

/** Stores an inlay given as a Blob or a data URI (or, for a signature, its JSON text). */
export function setInlayAsset(id: string, img: InlayAsset): Promise<void> {
    return serialize(id, () => storeInlayAsset(id, img));
}

async function storeInlayAsset(id: string, img: InlayAsset) {
    if (img.type === "signature") {
        await putMeta(id, {
            name: img.name,
            ext: img.ext,
            type: "signature",
            text: typeof img.data === "string" ? img.data : await img.data.text(),
        });
        return;
    }
    const bytes = await toBytes(img.data);
    const meta: Omit<InlayResource, "asset" | "size"> = { name: img.name, ext: img.ext, type: img.type };
    if (img.width !== undefined) {
        meta.width = img.width;
    }
    if (img.height !== undefined) {
        meta.height = img.height;
    }
    await writeMedia(id, bytes, meta);
}

/** Deletes an inlay's metadata. Its media file stays (snapshots may reference it). */
export function removeInlayAsset(id: string) {
    return serialize(id, async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const meta = await getMeta(id);
            if (!meta) {
                return;
            }
            try {
                await deleteResource(RESOURCE_KIND.inlays, id, meta.revision);
                markChanged(id);
                metaCache.delete(id);
                missingIds.set(id, Date.now() + MISSING_ID_TTL_MS);
                return;
            } catch (error) {
                if (!(error instanceof ResourceConflictError) || attempt === 1) {
                    throw error;
                }
                metaCache.delete(id);
            }
        }
    });
}

/** Whether the server holds this inlay (and its media file, at the given size). For the local import. */
export async function verifyInlay(id: string, expected: InlayResource): Promise<boolean> {
    metaCache.delete(id);
    missingIds.delete(id);
    const meta = await getMeta(id);
    if (!meta || JSON.stringify(meta.data) !== JSON.stringify(expected)) {
        return false;
    }
    if (!expected.asset) {
        return true;
    }
    const response = await authFetch("/api/read", {
        method: "HEAD",
        headers: { "file-path": Buffer.from(expected.asset, "utf-8").toString("hex") },
    });
    return response.ok && Number(response.headers.get("content-length")) === expected.size;
}

/**
 * Writes the media file of an inlay whose metadata exists on the server without its bytes (a
 * partially restored archive), when the given media is exactly the file that metadata names.
 * Returns whether it matched; the metadata is left as it is either way. For the local import.
 */
export function repairInlayMedia(id: string, img: InlayAsset): Promise<boolean> {
    return serialize(id, async () => {
        if (img.type === "signature") {
            return false;
        }
        metaCache.delete(id);
        missingIds.delete(id);
        const meta = await getMeta(id);
        if (!meta?.data.asset) {
            return false;
        }
        const bytes = await toBytes(img.data);
        if ((await mediaKey(bytes, meta.data.ext)) !== meta.data.asset) {
            return false;
        }
        await writeAsset(meta.data.asset, bytes);
        cacheBlob(meta.data.asset, new Blob([asBuffer(bytes)], { type: mimeOf(meta.data) }));
        return true;
    });
}

/** The metadata an inlay has on the server, or null. */
export async function getInlayMetadata(id: string): Promise<InlayResource | null> {
    return (await getMeta(id))?.data ?? null;
}

export function supportsInlayImage() {
    return getModelInfo(activePreset.aiModel).flags.includes(LLMFlags.hasImageInput);
}

export async function reencodeImage(img: Uint8Array) {
    if (getImageType(img) === "PNG") {
        return img;
    }
    const canvas = document.createElement("canvas");
    const imgObj = new Image();
    imgObj.src = URL.createObjectURL(new Blob([asBuffer(img)], { type: `image/png` }));
    await imgObj.decode();
    let drawHeight = imgObj.height;
    let drawWidth = imgObj.width;
    canvas.width = drawWidth;
    canvas.height = drawHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(imgObj, 0, 0, drawWidth, drawHeight);
    const b64 = canvas.toDataURL("image/png").split(",")[1];
    const b = Buffer.from(b64, "base64");
    return b;
}
