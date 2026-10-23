// @vitest-environment node
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { Packr } from "msgpackr";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    decodeUpstreamDatabase,
    decodeUpstreamSave,
    encodeUpstreamDatabase,
    UpstreamFormatError,
} from "../data/upstream/risuSave.ts";
import { blockSave, encodeBlockSave, encodeRawBlock } from "./fixtures/upstream/blockSave.ts";
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
                    // 64 characters and more take msgpackr's Node `Buffer.utf8Write` path, which
                    // msgpackr before 1.11.1 calls with a length Node 23 and later refuse.
                    desc: "설명".repeat(40),
                    ascii: "x".repeat(64),
                    asciiLong: "a".repeat(300),
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
    it("refuses headerless data and an unknown version, naming the format", () => {
        const packed = packr.pack({ characters: [] });
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

describe("self-contained block saves", () => {
    it("refuses directory entries outside the file and accepts entries present after the root", () => {
        const presets = [{ name: "Preset" }];
        const root = encodeRawBlock({
            type: 1,
            name: "root",
            compression: true,
            data: Buffer.from(JSON.stringify({ characters: [], botPresetsId: 0, __directory: ["root", "preset"] })),
        });
        const preset = encodeRawBlock({
            type: 4,
            name: "preset",
            compression: true,
            data: Buffer.from(JSON.stringify(presets)),
        });
        const error = formatError(() => decodeUpstreamSave(blockSave(root), LIMIT));
        expect(error.format).toBe("block");
        expect(error.message).toMatch(/live save/i);
        expect(error.message).toMatch(/outside/i);
        expect(decodeUpstreamSave(blockSave(root, preset), LIMIT)).toStrictEqual({
            database: { characters: [], botPresetsId: 0, botPresets: presets },
            kv: {},
        });
    });

    it("keeps dynamic __proto__ keys as own data properties or refuses them without prototype pollution", () => {
        const value = { polluted: true };
        const blocks = [
            {
                target: "database",
                type: 8,
                name: "component",
                data: Buffer.from(JSON.stringify({ key: "__proto__", data: value })),
            },
            { target: "kv", type: 12, name: "kv:__proto__", data: Buffer.from(JSON.stringify(value)) },
        ] as const;
        // Exercise each destination separately: refusing one must not hide pollution in the other.
        for (const { target, ...block } of blocks) {
            const bytes = Buffer.concat([
                encodeBlockSave({ characters: [], botPresets: [{ name: "Preset" }] }),
                encodeRawBlock({ ...block, compression: true }),
            ]);
            let decoded: ReturnType<typeof decodeUpstreamSave> | undefined;
            try {
                decoded = decodeUpstreamSave(bytes, LIMIT);
            } catch (error) {
                expect(error).toBeInstanceOf(UpstreamFormatError);
                expect(error).toMatchObject({ format: "block" });
            }
            const clean: Record<string, unknown> = {};
            expect(clean.polluted).toBeUndefined();
            if (decoded) {
                for (const object of [decoded.database, decoded.kv]) {
                    expect([Object.prototype, null]).toContain(Object.getPrototypeOf(object));
                    expect(object.polluted).toBeUndefined();
                }
                expect(Object.getOwnPropertyDescriptor(decoded[target], "__proto__")).toMatchObject({ value });
            }
        }
    });

    it("decodes mixed raw and gzip blocks like legacy JSON-representable data, leaving empty optional fields absent", () => {
        const db = {
            characters: [
                {
                    chaId: "캐릭터🌸",
                    name: "Character",
                    chats: [{ id: "chat", message: [{ role: "user", data: "안녕", chatId: "message" }] }],
                },
            ],
            botPresets: [{ name: "Preset", mainPrompt: "You are {{char}}." }],
            botPresetsId: 0,
            modules: [{ id: "module", name: "Lore", lorebook: [{ key: "dragon", content: "날 수 있다" }] }],
            plugins: [{ name: "Plugin", script: "// fixture" }],
            pluginCustomStorage: { plugin: { enabled: true, values: [1, null, "text"] } },
            username: "User",
        };
        const legacy = decodeUpstreamDatabase(encodeUpstreamDatabase(db), LIMIT);
        expect(legacy).toStrictEqual(db);
        const decoded = decodeUpstreamDatabase(encodeBlockSave(db, { compression: (name) => name !== "root" }), LIMIT);
        expect(decoded).toStrictEqual(legacy);
        expect(decoded).not.toHaveProperty("loadouts");
    });

    it("returns SaveKV namespaces separately, leaves legacy kv empty, and exposes only the database through decodeUpstreamDatabase", async () => {
        const db = { characters: [], botPresets: [{ name: "Preset" }], botPresetsId: 0 };
        const kv = { "plugin:notes": { greeting: "안녕" }, 설정: { enabled: true, values: [1, 2] } };
        const bytes = encodeBlockSave(db, { kv });
        expect(decodeUpstreamSave(bytes, LIMIT)).toStrictEqual({ database: db, kv });
        expect(decodeUpstreamDatabase(bytes, LIMIT)).toStrictEqual(db);
        const packed = packr.pack(db);
        for (const legacy of [save(7, packed), encodeUpstreamDatabase(db), save(9, await streamGzip(packed))]) {
            expect(decodeUpstreamSave(legacy, LIMIT)).toStrictEqual({ database: db, kv: {} });
        }
    });

    it("refuses truncated block headers, names, lengths, and data", () => {
        const block = encodeRawBlock({ type: 1, name: "root", data: Buffer.from('{"characters":[]}') });
        // Cuts within type/flag/name-length, the name, the u32 length, and the data.
        for (const end of [1, 2, 5, 9, block.length - 1]) {
            expect(formatError(() => decodeUpstreamSave(blockSave(block.subarray(0, end)), LIMIT))).toMatchObject({
                format: "block",
                message: expect.stringMatching(/truncated/i),
            });
        }
    });

    it("refuses a declared block length past the end even when the remaining bytes are valid JSON", () => {
        const block = encodeRawBlock({ type: 1, name: "root", data: Buffer.from('{"characters":[]}') });
        const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
        view.setUint32(3 + 4, view.getUint32(3 + 4, true) + 1, true);
        expect(formatError(() => decodeUpstreamSave(blockSave(block), LIMIT))).toMatchObject({
            format: "block",
            message: expect.stringMatching(/truncated|past the end/i),
        });
    });

    it("caps each gzip block and charges the whole save for framing and the larger stored or decoded data", () => {
        const db = { characters: [], botPresets: [{ name: "Preset" }], botPresetsId: 0, text: "x".repeat(4096) };
        const rootData = Buffer.from(JSON.stringify(db));
        const root = encodeRawBlock({ type: 1, name: "root", data: rootData, compression: true });
        expect(formatError(() => decodeUpstreamSave(blockSave(root), { maxDecodedBytes: 1024 }))).toMatchObject({
            format: "block",
            message: expect.stringMatching(/over the limit/i),
        });
        const configName = "설정";
        const configData = Buffer.from('{"version":1}');
        const config = encodeRawBlock({ type: 0, name: configName, data: configData, compression: true });
        const empty = encodeRawBlock({ type: 10, name: "loadouts", data: new Uint8Array(), compression: true });
        // Root costs its larger decoded content; small/empty blocks cost their larger gzip members.
        // Keeping an empty block before config makes its stored bytes count toward later blocks too.
        const charge = 7 + Buffer.byteLength("root") + rootData.length + empty.length + config.length;
        const bytes = blockSave(root, empty, config);
        expect(decodeUpstreamDatabase(bytes, { maxDecodedBytes: charge })).toStrictEqual(db);
        expect(formatError(() => decodeUpstreamSave(bytes, { maxDecodedBytes: charge - 1 }))).toMatchObject({
            format: "block",
            message: expect.stringMatching(/over the limit/i),
        });
    });

    it("refuses a REMOTE block as a live save with data outside the file, naming the block", () => {
        const name = "remote-character";
        const remote = encodeRawBlock({
            type: 6,
            name,
            compression: true,
            data: Buffer.from('"remotes/character.local.bin"'),
        });
        const bytes = Buffer.concat([encodeBlockSave({ characters: [], botPresets: [{ name: "Preset" }] }), remote]);
        const error = formatError(() => decodeUpstreamSave(bytes, LIMIT));
        expect(error.format).toBe("block");
        expect(error.message).toMatch(/live save/i);
        expect(error.message).toMatch(/outside/i);
        expect(error.message).toContain(name);
    });

    it.each([3, 13])("refuses block type %i because upstream has no reader for it", (type) => {
        const unknown = encodeRawBlock({ type, name: "unsupported", compression: true, data: Buffer.from("{}") });
        const bytes = Buffer.concat([encodeBlockSave({ characters: [], botPresets: [{ name: "Preset" }] }), unknown]);
        expect(formatError(() => decodeUpstreamSave(bytes, LIMIT))).toMatchObject({
            format: "block",
            message: expect.stringMatching(/unknown block type/i),
        });
    });
});
