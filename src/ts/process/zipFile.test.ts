import { strToU8, Zip, ZipDeflate, ZipPassThrough, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharxFileError } from "../../../shared/charxImport.ts";
import { readZipEntry, readZipIndex } from "./zipFile";

vi.mock("src/ts/alert", () => ({ alertError: vi.fn(), alertNormal: vi.fn(), alertWait: vi.fn() }));
vi.mock("src/ts/globalApi.svelte", () => ({
    loadAsset: vi.fn(),
    saveAsset: vi.fn(),
    loadAssets: vi.fn(),
    assetKey: vi.fn(async (data: Uint8Array) => `assets/${data.length}-${data[0]}.png`),
    saveAssetBatch: vi.fn(async () => {}),
}));
vi.mock("src/ts/util", () => ({ selectSingleFileHandle: vi.fn(), asBuffer: vi.fn() }));

afterEach(() => {
    vi.clearAllMocks();
});

/** Bytes holding the three signatures fflate's streaming `Unzip` scans for. */
function trapBytes(length: number) {
    const bytes = new Uint8Array(length).map((_, i) => (i * 31) % 251);
    bytes.set([0x50, 0x4b, 0x03, 0x04], 100);
    bytes.set([0x50, 0x4b, 0x07, 0x08], 200);
    bytes.set([0x50, 0x4b, 0x01, 0x02], 300);
    return bytes;
}

/** A streamed zip (fflate `Zip`): every entry has a data descriptor and no sizes in its local header. */
function streamedZip(entries: { name: string; data: Uint8Array; stored: boolean }[]) {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((error, chunk) => {
        if (error) throw error;
        chunks.push(chunk);
    });
    for (const { name, data, stored } of entries) {
        const file = stored ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 });
        zip.add(file);
        file.push(data, true);
    }
    zip.end();
    return new Blob(chunks as BlobPart[]);
}

describe("readZipIndex / readZipEntry", () => {
    it("reads stored and deflated entries, directories, and a prefixed archive by the central directory", async () => {
        const model = trapBytes(5000);
        const zipped = zipSync({
            "dir/": new Uint8Array(0),
            "dir/model.onnx": [model, { level: 0 }],
            "config.json": [strToU8('{"a":1}'), { level: 9 }],
        });
        for (const prefix of [new Uint8Array(0), new Uint8Array(777).fill(0xff)]) {
            const file = new Blob([prefix, zipped] as BlobPart[]);
            const index = await readZipIndex(file);
            expect(index.prefix).toBe(prefix.length);
            expect(index.entries.map((entry) => [entry.name, entry.directory])).toEqual([
                ["dir/", true],
                ["dir/model.onnx", false],
                ["config.json", false],
            ]);
            const [, onnx, config] = index.entries;
            expect(await readZipEntry(file, index, onnx)).toEqual(model);
            expect(new TextDecoder().decode(await readZipEntry(file, index, config))).toBe('{"a":1}');
        }
    });

    it("reads data-descriptor entries whole although their bytes hold zip signatures", async () => {
        const stored = trapBytes(4096);
        const deflated = trapBytes(9000);
        const file = streamedZip([
            { name: "a.onnx", data: stored, stored: true },
            { name: "b.onnx", data: deflated, stored: false },
        ]);
        const index = await readZipIndex(file);
        expect(index.entries.map((entry) => entry.name)).toEqual(["a.onnx", "b.onnx"]);
        expect(await readZipEntry(file, index, index.entries[0])).toEqual(stored);
        expect(await readZipEntry(file, index, index.entries[1])).toEqual(deflated);
    });

    it("refuses a file that is not a zip, a declared size the bytes do not match, and a mismatched local header", async () => {
        await expect(readZipIndex(new Blob([new Uint8Array(100)]))).rejects.toBeInstanceOf(CharxFileError);

        const zipped = zipSync({ "m.onnx": [trapBytes(3000), { level: 6 }] });
        const index = await readZipIndex(new Blob([zipped] as BlobPart[]));
        const file = new Blob([zipped] as BlobPart[]);
        for (const uncompressedSize of [2999, 3001]) {
            const entry = { ...index.entries[0], uncompressedSize };
            await expect(readZipEntry(file, index, entry)).rejects.toBeInstanceOf(CharxFileError);
        }
        const renamed = { ...index.entries[0], record: { ...index.entries[0].record, name: strToU8("x.onnx") } };
        await expect(readZipEntry(file, index, renamed)).rejects.toBeInstanceOf(CharxFileError);
    });
});

describe("registerOnnxModel", () => {
    /** Rewrites the central-directory uncompressed size of the entry named `name`. */
    function declareSize(zipped: Uint8Array, name: string, size: number) {
        const bytes = zipped.slice();
        const view = new DataView(bytes.buffer);
        const encoded = strToU8(name);
        for (let i = 0; i + 46 <= bytes.length; i++) {
            if (view.getUint32(i, true) !== 0x02014b50) continue;
            const nameLength = view.getUint16(i + 28, true);
            const entryName = bytes.subarray(i + 46, i + 46 + nameLength);
            if (entryName.length === encoded.length && entryName.every((b, k) => b === encoded[k])) {
                view.setUint32(i + 24, size, true);
            }
        }
        return bytes;
    }

    it("saves the kept members in batches, maps their names, and names the oversized ones", async () => {
        const util = await import("src/ts/util");
        const api = await import("src/ts/globalApi.svelte");
        const alert = await import("src/ts/alert");
        const { registerOnnxModel, MAX_ONNX_MEMBER_BYTES } = await import("./transformers");
        const model = trapBytes(2048);
        const zipped = declareSize(
            zipSync({
                "voice/": new Uint8Array(0),
                "/voice/model.onnx": [model, { level: 6 }],
                "voice/config.json": strToU8("{}"),
                "huge.onnx": [new Uint8Array(10), { level: 0 }],
            }),
            "huge.onnx",
            MAX_ONNX_MEMBER_BYTES + 1,
        );
        vi.mocked(util.selectSingleFileHandle).mockResolvedValue(new File([zipped as BlobPart], "voice.zip"));

        const result = await registerOnnxModel();

        expect(result.name).toBe("voice.zip");
        expect(result.files).toEqual({
            "voice/model.onnx": `assets/${model.length}-${model[0]}.png`,
            "voice/config.json": "assets/2-123.png",
        });
        expect(api.saveAssetBatch).toHaveBeenCalledTimes(1);
        expect(vi.mocked(api.saveAssetBatch).mock.calls[0][0].map((item) => item.bytes)).toEqual([
            model,
            strToU8("{}"),
        ]);
        expect(alert.alertError).not.toHaveBeenCalled();
        expect(vi.mocked(alert.alertNormal).mock.calls.at(-1)?.[0]).toContain("huge.onnx");
    });

    it("alerts and returns nothing for an unreadable zip, without saving", async () => {
        const util = await import("src/ts/util");
        const api = await import("src/ts/globalApi.svelte");
        const alert = await import("src/ts/alert");
        const { registerOnnxModel } = await import("./transformers");
        vi.mocked(util.selectSingleFileHandle).mockResolvedValue(new File([new Uint8Array(64)], "broken.zip"));
        vi.spyOn(console, "error").mockImplementation(() => {});

        await expect(registerOnnxModel()).resolves.toBeUndefined();

        expect(alert.alertError).toHaveBeenCalledTimes(1);
        expect(api.saveAssetBatch).not.toHaveBeenCalled();
    });
});
