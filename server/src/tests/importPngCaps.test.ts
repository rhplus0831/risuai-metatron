// @vitest-environment node
/** @module-tag slow */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_CHARX_ENTRIES } from "../../../shared/charxImport.ts";
import { planPngFile } from "../routes/importPng.ts";

/**
 * The server PNG reader's asset-chunk cap (`planPngFile`, `routes/importPng.ts`) on both sides of its
 * boundary. Slow because the validation reads each `tEXt` chunk's key with its own file read: 200,000
 * chunks take about 17 s per plan on this machine.
 */

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type: string, data: Uint8Array): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    // The reader never checks a CRC.
    return Buffer.concat([length, Buffer.from(type, "latin1"), Buffer.from(data), Buffer.alloc(4)]);
}
const text = (key: string, value: string) =>
    chunk("tEXt", Buffer.concat([Buffer.from(key, "utf-8"), Buffer.from([0]), Buffer.from(value, "utf-8")]));
const png = (...chunks: Uint8Array[]) => Buffer.concat([PNG_SIGNATURE, ...chunks]);
const ihdr = chunk("IHDR", Buffer.alloc(13));
const iend = chunk("IEND", Buffer.alloc(0));

describe("planPngFile asset-chunk cap", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-png-caps-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    async function plan(image: Buffer) {
        const file = path.join(dir, `${randomBytes(4).toString("hex")}.png`);
        writeFileSync(file, image);
        const handle = await fs.open(file, "r");
        try {
            return await planPngFile(handle, new AbortController().signal);
        } finally {
            await handle.close();
            rmSync(file, { force: true });
        }
    }

    it("accepts MAX_CHARX_ENTRIES asset chunks and refuses one more", async () => {
        const asset = text("chara-ext-asset_0", "");
        const assets = Buffer.concat(Array<Buffer>(MAX_CHARX_ENTRIES + 1).fill(asset));
        await expect(plan(png(ihdr, text("ccv3", "x"), assets, iend))).rejects.toThrow("too many asset chunks");
        await expect(
            plan(png(ihdr, text("ccv3", "x"), assets.subarray(0, MAX_CHARX_ENTRIES * asset.length), iend)),
        ).resolves.toEqual({ total: MAX_CHARX_ENTRIES, card: "x" });
    }, 120_000);
});
