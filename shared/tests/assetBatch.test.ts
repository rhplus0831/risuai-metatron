// @vitest-environment node
import { describe, expect, it } from "vitest";
import { encodeRecordHeader } from "../../server/src/data/archive.ts";
import {
    AssetBatchFormatError,
    AssetRecordParser,
    encodeAssetRecordHeader,
    MAX_ASSET_BATCH_RECORDS,
} from "../assetBatch.ts";

// Independent wire fixtures: u32le name length, UTF-8 name, u32le data length, data.
function header(name: string, length: number) {
    const text = Buffer.from(name, "utf8");
    const bytes = Buffer.alloc(8 + text.length);
    bytes.writeUInt32LE(text.length, 0);
    text.copy(bytes, 4);
    bytes.writeUInt32LE(length, 4 + text.length);
    return bytes;
}

describe("asset batch codec", () => {
    it("encodes the specified little-endian framing and agrees with archive headers", () => {
        expect([...encodeAssetRecordHeader("a", 0x12345678)]).toEqual([1, 0, 0, 0, 97, 120, 86, 52, 18]);
        for (const name of ["assets/plain.bin", "\uFEFFassets/bom.bin", "é".repeat(2048)]) {
            for (const length of [0, 17, 0xffffffff]) {
                const expected = header(name, length);
                expect(Buffer.from(encodeAssetRecordHeader(name, length))).toEqual(expected);
                expect(Buffer.from(encodeRecordHeader(name, length))).toEqual(expected);
            }
        }
    });

    it("returns only completed records at one-byte and seeded random chunk boundaries", () => {
        const records = [
            { name: "assets/한글.bin", bytes: new Uint8Array([0, 255, 1, 128, 13]) },
            { name: "assets/empty.bin", bytes: new Uint8Array() },
            { name: "\uFEFFassets/bom.bin", bytes: new Uint8Array([42]) },
            { name: "é".repeat(2048), bytes: new Uint8Array([9, 8]) },
        ];
        const wire = Buffer.concat(
            records.flatMap(({ name, bytes }) => [encodeAssetRecordHeader(name, bytes.length), bytes]),
        );
        const ends: number[] = [];
        for (const record of records) {
            ends.push((ends.at(-1) ?? 0) + 8 + Buffer.byteLength(record.name) + record.bytes.length);
        }
        for (const seed of [0, 1, 42, 2026]) {
            const parser = new AssetRecordParser();
            let state = seed;
            let completed = 0;
            for (let at = 0; at < wire.length;) {
                state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
                const end = Math.min(wire.length, at + (seed === 0 ? 1 : 1 + (state % 97)));
                expect(parser.push(new Uint8Array())).toEqual([]);
                const next = ends.filter((offset) => offset <= end).length;
                expect(parser.push(wire.subarray(at, end))).toEqual(records.slice(completed, next));
                completed = next;
                at = end;
            }
            expect(completed).toBe(records.length);
            expect(() => parser.end()).not.toThrow();
        }
    });

    it("emits ordered start/data/end events whose data are views into each input chunk", () => {
        const parser = new AssetRecordParser();
        const prefix = header("assets/a", 3);
        expect([...parser.events(prefix.subarray(0, 2))]).toEqual([]);
        expect([...parser.events(prefix.subarray(2))]).toEqual([
            { type: "start", index: 0, name: "assets/a", length: 3 },
        ]);
        const backing = new Uint8Array([99, 10, 20, 30, ...header("assets/empty", 0), 99]);
        const chunks = [backing.subarray(1, 2), backing.subarray(2, backing.length - 1)];
        const first = [...parser.events(chunks[0])];
        const second = [...parser.events(chunks[1])];
        expect(first).toEqual([{ type: "data", index: 0, bytes: new Uint8Array([10]) }]);
        expect(second).toEqual([
            { type: "data", index: 0, bytes: new Uint8Array([20, 30]) },
            { type: "end", index: 0 },
            { type: "start", index: 1, name: "assets/empty", length: 0 },
            { type: "end", index: 1 },
        ]);
        for (const [index, event] of [first[0], second[0]].entries()) {
            if (event.type !== "data") throw new Error("Expected data event");
            expect(event.bytes.buffer).toBe(chunks[index].buffer);
            expect(event.bytes.byteOffset).toBe(chunks[index].byteOffset);
            chunks[index][0] = 77;
            expect(event.bytes[0]).toBe(77);
        }
        expect(() => parser.end()).not.toThrow();
    });

    it("refuses empty or over-4096-byte names and non-u32 lengths with AssetBatchFormatError", () => {
        for (const name of ["", "é".repeat(2049)]) {
            expect(() => encodeAssetRecordHeader(name, 0)).toThrow(AssetBatchFormatError);
        }
        for (const length of [-1, 0.5, 0x100000000, NaN, Infinity]) {
            expect(() => encodeAssetRecordHeader("assets/a", length)).toThrow(AssetBatchFormatError);
        }
    });

    it("refuses zero, over-cap, and non-strict-UTF-8 names through both parser APIs", () => {
        const badNames = [
            new Uint8Array([0, 0, 0, 0]),
            new Uint8Array([1, 16, 0, 0]), // 4097, rejected before allocating/reading the name
            new Uint8Array([2, 0, 0, 0, 0xc3, 0x28, 0, 0, 0, 0]),
        ];
        for (const bytes of badNames) {
            expect(() => new AssetRecordParser().push(bytes)).toThrow(AssetBatchFormatError);
            expect(() => [...new AssetRecordParser().events(bytes)]).toThrow(AssetBatchFormatError);
        }
    });

    it("end refuses every partial field or payload but accepts record boundaries", () => {
        const wire = Buffer.concat([header("assets/a", 3), Buffer.from([1, 2, 3])]);
        expect(() => new AssetRecordParser().end()).not.toThrow();
        for (let cut = 1; cut < wire.length; cut++) {
            const parser = new AssetRecordParser();
            expect(parser.push(wire.subarray(0, cut))).toEqual([]);
            expect(() => parser.end(), `cut at ${cut}`).toThrow(AssetBatchFormatError);
        }
        const parser = new AssetRecordParser();
        expect(parser.push(wire)).toEqual([{ name: "assets/a", bytes: new Uint8Array([1, 2, 3]) }]);
        expect(() => parser.end()).not.toThrow();
    });

    it("accepts exactly 2000 records and refuses record 2001", () => {
        expect(MAX_ASSET_BATCH_RECORDS).toBe(2000);
        const record = header("assets/a", 0);
        const batch = Buffer.concat(Array.from({ length: 2000 }, () => record));
        const parser = new AssetRecordParser();
        expect(parser.push(batch)).toHaveLength(2000);
        expect(() => parser.end()).not.toThrow();
        expect(() => parser.push(record)).toThrow(AssetBatchFormatError);
        const streaming = new AssetRecordParser();
        expect([...streaming.events(batch)]).toHaveLength(4000);
        expect(() => [...streaming.events(record)]).toThrow(AssetBatchFormatError);
    });
});
