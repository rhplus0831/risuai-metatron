import { gzipSync } from "node:zlib";

type Block = { type: number; name: string; data: Uint8Array; compression?: boolean };
type BlockDatabase = {
    characters: readonly { chaId: string; [key: string]: unknown }[];
    [key: string]: unknown;
};

/**
 * Upstream `encodeRawBlock`: type u8, gzip flag u8, UTF-8 name length u8, name,
 * data length u32le, data. Compression makes the data its own gzip member.
 * Accepts arbitrary bytes and types so refusals need no production encoder.
 */
export function encodeRawBlock({ type, name, data, compression = false }: Block): Uint8Array {
    const nameBytes = Buffer.from(name, "utf8");
    if (nameBytes.length > 255) {
        throw new Error("Block names must fit in one byte");
    }
    const stored = compression ? gzipSync(data) : data;
    const block = Buffer.alloc(7 + nameBytes.length + stored.length);
    block.set([type, compression ? 1 : 0, nameBytes.length]);
    block.set(nameBytes, 3);
    block.writeUInt32LE(stored.length, 3 + nameBytes.length);
    block.set(stored, 7 + nameBytes.length);
    return block;
}

/** A block save's nine-byte magic followed by already framed blocks, including malformed ones. */
export function blockSave(...blocks: Uint8Array[]): Uint8Array {
    return Buffer.concat([Buffer.from("RISUSAVE\0"), ...blocks]);
}

/**
 * Self-contained `encodeRisuSave` / `RisuSaveEncoder.init` layout at upstream f50b5942.
 * Root omits only characters, botPresets and modules; the remaining fields are also
 * emitted in their own blocks. Undefined fields have empty content, even under gzip.
 * Backups compress every block; a per-name choice also exercises mixed saves.
 */
export function encodeBlockSave(
    database: BlockDatabase,
    options: { compression?: boolean | ((name: string) => boolean); kv?: Record<string, unknown> } = {},
): Uint8Array {
    const { characters, botPresets, modules, ...root } = database;
    const { compression = true, kv = {} } = options;
    const jsonBlock = (type: number, name: string, value: unknown) =>
        encodeRawBlock({
            type,
            name,
            data: new TextEncoder().encode(JSON.stringify(value)),
            compression: typeof compression === "function" ? compression(name) : compression,
        });
    return blockSave(
        jsonBlock(1, "root", root),
        jsonBlock(4, "preset", botPresets),
        jsonBlock(5, "modules", modules),
        jsonBlock(10, "loadouts", database.loadouts),
        jsonBlock(9, "plugins", database.plugins),
        jsonBlock(11, "pluginStorage", database.pluginCustomStorage),
        ...characters.map((character) => jsonBlock(2, character.chaId, character)),
        ...Object.entries(kv).map(([namespace, value]) => jsonBlock(12, `kv:${namespace}`, value)),
        jsonBlock(0, "config", { version: 1 }),
    );
}
