import crc32 from "crc/crc32";
import * as fflate from "fflate";

/**
 * Files for the import tests of Phase 4 slice 7 (`imports-through-the-module.md`): a PNG that
 * carries card or persona `tEXt` chunks the way `PngChunk.readGenerator` reads them, a CharX zip
 * (`card.json`, optionally `module.risum`), and minimal V2 and V3 cards. The image data is a
 * placeholder `IHDR` chunk: the readers never decode pixels, and `saveAsset` is mocked.
 */

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
    const typeBytes = new TextEncoder().encode(type);
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, data.byteLength);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, crc32(Buffer.concat([typeBytes, data])) >>> 0);
    return concat([length, typeBytes, data, crc]);
}

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

/** A PNG with one `tEXt` chunk per entry (`key` → base64 of `value`'s JSON, as the app writes cards and personas). */
export function pngWithText(chunks: Record<string, unknown>): Uint8Array {
    const parts = [PNG_SIGNATURE, pngChunk("IHDR", new Uint8Array(13))];
    for (const [key, value] of Object.entries(chunks)) {
        const text = Buffer.from(JSON.stringify(value), "utf-8").toString("base64");
        parts.push(pngChunk("tEXt", concat([new TextEncoder().encode(key), new Uint8Array([0]), Buffer.from(text)])));
    }
    parts.push(pngChunk("IEND", new Uint8Array(0)));
    return concat(parts);
}

/** A CharX archive: `card.json` plus any other files (a `module.risum`, assets). */
export function charx(card: unknown, files: Record<string, Uint8Array> = {}): Uint8Array {
    return fflate.zipSync({ "card.json": fflate.strToU8(JSON.stringify(card)), ...files });
}

/** A `chara_card_v2` card with the risuai extension present (the importer clones it). */
export function cardV2(name: string, extra: Record<string, unknown> = {}, risuai: Record<string, unknown> = {}) {
    return {
        spec: "chara_card_v2",
        spec_version: "2.0",
        data: {
            name,
            description: `${name} description`,
            personality: "",
            scenario: "",
            first_mes: `hello from ${name}`,
            mes_example: "",
            creator_notes: "",
            system_prompt: "",
            post_history_instructions: "",
            alternate_greetings: [],
            tags: [],
            creator: "",
            character_version: "1",
            extensions: { risuai },
            ...extra,
        },
    };
}

/** A `chara_card_v3` card with the risuai extension present. */
export function cardV3(name: string, extra: Record<string, unknown> = {}, risuai: Record<string, unknown> = {}) {
    const v2 = cardV2(name, extra, risuai);
    return {
        spec: "chara_card_v3",
        spec_version: "3.0",
        data: {
            ...v2.data,
            nickname: `${name} nick`,
            group_only_greetings: [],
            creation_date: 1,
            modification_date: 2,
        },
    };
}

/** A `character_book` with one entry, as V2 and V3 cards carry it. */
export function characterBook(name: string, content: string) {
    return {
        entries: [
            {
                keys: [name.toLowerCase()],
                content,
                extensions: {},
                enabled: true,
                insertion_order: 100,
                name,
                comment: name,
            },
        ],
        extensions: {},
    };
}

/** A plain object nested `depth` levels: past the JSON check's limit it makes a card `addCharacter` refuses. */
export function nested(depth: number): unknown {
    let value: unknown = "leaf";
    for (let i = 0; i < depth; i++) {
        value = { deeper: value };
    }
    return value;
}
