// @vitest-environment node
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { Packr } from "msgpackr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeUpstreamDatabase, encodeUpstreamDatabase, UpstreamFormatError } from "../data/upstream/risuSave.ts";
import { UPSTREAM_FIXTURE_DATABASE } from "./fixtures/upstream/database.ts";

// See fixtures/upstream/README.md: upstream's encoder with upstream's library versions, at this mtime.
const FIXTURE = new Uint8Array(readFileSync(new URL("./fixtures/upstream/database-v8.risudat", import.meta.url)));
const FIXTURE_MTIME_MS = Date.UTC(2026, 9, 20);
const LIMIT = { maxDecodedBytes: 64 * 1024 * 1024 };
const packr = new Packr({ useRecords: false });

function save(version: number, payload: Uint8Array): Uint8Array {
    const bytes = new Uint8Array(11 + payload.length);
    bytes.set([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, version]);
    bytes.set(payload, 11);
    return bytes;
}

function formatError(run: () => unknown): UpstreamFormatError {
    try {
        run();
    } catch (error) {
        expect(error).toBeInstanceOf(UpstreamFormatError);
        return error as UpstreamFormatError;
    }
    throw new Error("expected an UpstreamFormatError");
}

async function streamGzip(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

afterEach(() => {
    vi.useRealTimers();
});

describe("encodeUpstreamDatabase and decodeUpstreamDatabase", () => {
    it("round-trips undefined, large integers, binary values, and long non-ASCII strings", () => {
        const db = {
            characters: [
                {
                    name: "캐릭터 ✓ 🌸",
                    // 64 characters and more take msgpackr's Node `utf8Write` path (the patched length).
                    desc: "설명".repeat(40),
                    long: `${"가".repeat(70_000)}end`,
                    image: undefined,
                    nested: { list: [1, -1, 0.5, null, undefined, [true, false]], empty: {} },
                },
            ],
            account: undefined,
            timestamp: 2 ** 40 + 3,
            negative: -5_000_000_000,
            bytes: new Uint8Array([0, 128, 255]),
        };
        const encoded = encodeUpstreamDatabase(db);

        expect([...encoded.subarray(0, 14)]).toEqual([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8, 0x1f, 0x8b, 8]);
        const decoded = decodeUpstreamDatabase(encoded, LIMIT);
        expect(decoded).toStrictEqual(db);
        expect(Object.getPrototypeOf(decoded.bytes)).toBe(Uint8Array.prototype);
    });

    it("decodes the frozen upstream \\x08 fixture, and encodes it to the same bytes", () => {
        expect(decodeUpstreamDatabase(FIXTURE, LIMIT)).toStrictEqual(UPSTREAM_FIXTURE_DATABASE);

        vi.useFakeTimers({ now: FIXTURE_MTIME_MS, toFake: ["Date"] });
        expect(encodeUpstreamDatabase(UPSTREAM_FIXTURE_DATABASE)).toEqual(FIXTURE);
    });

    it("decodes \\x07 (raw MessagePack), reading 64-bit integers as numbers", () => {
        const db = { characters: [{ name: "raw" }], account: undefined, big: 2n ** 40n, small: -(2n ** 40n) };
        // msgpackr writes a BigInt as int64 (0xd3), which its default decode would return as a BigInt.
        expect(decodeUpstreamDatabase(save(7, packr.pack(db)), LIMIT)).toStrictEqual({
            characters: [{ name: "raw" }],
            account: undefined,
            big: 2 ** 40,
            small: -(2 ** 40),
        });
    });

    it("decodes \\x09 (gzip from a CompressionStream)", async () => {
        const db = { characters: [{ name: "stream", chats: [{ message: [{ role: "user", data: "안녕" }] }] }] };

        expect(decodeUpstreamDatabase(save(9, await streamGzip(packr.pack(db))), LIMIT)).toStrictEqual(db);
    });
});

describe("decodeUpstreamDatabase refusals", () => {
    it("refuses the block format, headerless data, and an unknown version, naming the format", () => {
        const packed = packr.pack({ characters: [] });
        const block = new Uint8Array([...new TextEncoder().encode("RISUSAVE\0"), 0, 0, 0, 0, ...packed]);

        expect(formatError(() => decodeUpstreamDatabase(block, LIMIT))).toMatchObject({
            format: "block",
            message: expect.stringContaining("RisuAI block save"),
        });
        expect(formatError(() => decodeUpstreamDatabase(packed, LIMIT)).format).toBe("headerless");
        expect(formatError(() => decodeUpstreamDatabase(new Uint8Array(0), LIMIT)).format).toBe("headerless");
        expect(formatError(() => decodeUpstreamDatabase(save(10, packed), LIMIT)).format).toBe("unknownVersion");
    });

    it("refuses a truncated or corrupted gzip payload", () => {
        const truncated = FIXTURE.subarray(0, FIXTURE.length - 20);
        const badCrc = FIXTURE.slice();
        badCrc[badCrc.length - 8] ^= 1;

        expect(formatError(() => decodeUpstreamDatabase(truncated, LIMIT)).format).toBe("gzip");
        expect(formatError(() => decodeUpstreamDatabase(badCrc, LIMIT)).message).toContain("damaged");
        expect(
            formatError(() => decodeUpstreamDatabase(save(8, packr.pack({ characters: [] })), LIMIT)).message,
        ).toContain("not gzip");
    });

    it("refuses a gzip payload whose ISIZE understates a stream that decodes to a database prefix", () => {
        const packed = packr.pack({ characters: [] });
        const gzip = gzipSync(new Uint8Array([...packed, ...new Uint8Array(1024 * 1024)]));
        gzip.writeUInt32LE(packed.length, gzip.length - 4);

        expect(
            formatError(() => decodeUpstreamDatabase(save(8, gzip), { maxDecodedBytes: packed.length })).format,
        ).toBe("gzip");
    });

    it("refuses a database over the decoded-size cap, and accepts one at it", () => {
        const decodedBytes = packr.pack(UPSTREAM_FIXTURE_DATABASE).length;
        const raw = save(7, packr.pack(UPSTREAM_FIXTURE_DATABASE));

        expect(decodeUpstreamDatabase(FIXTURE, { maxDecodedBytes: decodedBytes }).characters).toHaveLength(2);
        expect(
            formatError(() => decodeUpstreamDatabase(FIXTURE, { maxDecodedBytes: decodedBytes - 1 })).message,
        ).toContain("over the limit");
        expect(decodeUpstreamDatabase(raw, { maxDecodedBytes: decodedBytes }).characters).toHaveLength(2);
        expect(formatError(() => decodeUpstreamDatabase(raw, { maxDecodedBytes: decodedBytes - 1 })).format).toBe(
            "raw",
        );
    });

    it("refuses damaged MessagePack and a root that is not an object with a characters list", () => {
        const packed = packr.pack({ characters: [] });

        expect(
            formatError(() => decodeUpstreamDatabase(save(7, packed.subarray(0, packed.length - 1)), LIMIT)).message,
        ).toContain("MessagePack");
        for (const root of [[{ characters: [] }], { characters: {} }, { name: "no list" }, "text"]) {
            expect(formatError(() => decodeUpstreamDatabase(save(7, packr.pack(root)), LIMIT)).message).toContain(
                "not a RisuAI database",
            );
        }
    });
});
