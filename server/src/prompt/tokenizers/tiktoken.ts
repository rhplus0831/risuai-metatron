import { createRequire } from "node:module";
import type { Tiktoken } from "@dqbd/tiktoken";

const require = createRequire(import.meta.url);

type EncoderData = { bpe_ranks: string; special_tokens: Record<string, number>; pat_str: string };

const MAX_PIECE_BYTES = 512;
const letter = /\p{L}/u;
const mark = /\p{M}/u;
const number = /\p{N}/u;
const whitespace = /\p{White_Space}/u;
const unicodeKinds = new Map<number, number>();

// Node's Unicode 17 categories differ from @dqbd/tiktoken 1.0.22 at these points.
// Avoid cuts there, or in non-ASCII text on unmeasured Unicode versions, to preserve ids.
const unicodeTableDifferences =
    process.versions.unicode === "16.0" || process.versions.unicode === "17.0"
        ? new RegExp(
              "[\\u{295}\\u{88f}\\u{c5c}\\u{cdc}\\u{1acf}-\\u{1add}\\u{1ae0}-\\u{1aeb}\\u{a7ce}-\\u{a7cf}\\u{a7d2}\\u{a7d4}" +
                  "\\u{a7f1}\\u{10940}-\\u{10959}\\u{10ec5}-\\u{10ec7}\\u{10efa}-\\u{10efb}\\u{11b60}-\\u{11b67}" +
                  "\\u{11db0}-\\u{11ddb}\\u{11de0}-\\u{11de9}\\u{16ea0}-\\u{16eb8}\\u{16ebb}-\\u{16ed3}\\u{16ff2}-\\u{16ff6}" +
                  "\\u{187f8}-\\u{187ff}\\u{18d09}-\\u{18d1e}\\u{18d80}-\\u{18df2}\\u{1e6c0}-\\u{1e6de}\\u{1e6e0}-\\u{1e6f5}" +
                  "\\u{1e6fe}-\\u{1e6ff}\\u{2b73a}-\\u{2b73f}\\u{2cea2}-\\u{2cead}\\u{323b0}-\\u{33479}]",
              "u",
          )
        : /[^\x00-\x7f]/u;

// Common scripts bypass property regexes even after the small fallback cache fills.
function commonUnicodeKind(point: number): number {
    if (point >= 0xac00 && point <= 0xd7a3) return 1;
    if (point >= 0x3400 && point <= 0x9fff) return point >= 0x4dc0 && point <= 0x4dff ? 2 : 1;
    if (point >= 0x3040 && point <= 0x30ff) {
        if (point >= 0x3099 && point <= 0x309a) return 4;
        return point === 0x3040 ||
            (point >= 0x3097 && point <= 0x3098) ||
            (point >= 0x309b && point <= 0x309c) ||
            point === 0x30a0 ||
            point === 0x30fb
            ? 2
            : 1;
    }
    if (point >= 0x2000 && point <= 0x206f) {
        return point <= 0x200a || point === 0x2028 || point === 0x2029 || point === 0x202f || point === 0x205f ? 3 : 2;
    }
    if (point >= 0x3000 && point <= 0x303f) {
        if (point === 0x3000) return 3;
        if (point === 0x3007 || (point >= 0x3021 && point <= 0x3029) || (point >= 0x3038 && point <= 0x303a)) return 0;
        if (point >= 0x302a && point <= 0x302f) return 4;
        return (point >= 0x3005 && point <= 0x3006) ||
            (point >= 0x3031 && point <= 0x3035) ||
            (point >= 0x303b && point <= 0x303c)
            ? 1
            : 2;
    }
    if (point >= 0xff00 && point <= 0xffef) {
        if (point >= 0xff10 && point <= 0xff19) return 0;
        return (point >= 0xff21 && point <= 0xff3a) ||
            (point >= 0xff41 && point <= 0xff5a) ||
            (point >= 0xff66 && point <= 0xffbe) ||
            (point >= 0xffc2 && point <= 0xffc7) ||
            (point >= 0xffca && point <= 0xffcf) ||
            (point >= 0xffd2 && point <= 0xffd7) ||
            (point >= 0xffda && point <= 0xffdc)
            ? 1
            : 2;
    }
    if (
        (point >= 0x1100 && point <= 0x11ff) ||
        (point >= 0x3131 && point <= 0x318e) ||
        (point >= 0xa960 && point <= 0xa97c) ||
        (point >= 0xd7b0 && point <= 0xd7c6) ||
        (point >= 0xd7cb && point <= 0xd7fb) ||
        (point >= 0x31f0 && point <= 0x31ff) ||
        (point >= 0xf900 && point <= 0xfa6d) ||
        (point >= 0xfa70 && point <= 0xfad9)
    )
        return 1;
    if ((point >= 0xfe10 && point <= 0xfe1f) || (point >= 0xfe30 && point <= 0xfe4f)) return 2;
    return -1;
}

function hasLongRun(text: string): boolean {
    let letters = 0;
    let nonLetters = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        let kind: number;
        if (code > 0x7f) {
            const point = text.codePointAt(i)!;
            i += point > 0xffff ? 1 : 0;
            kind = commonUnicodeKind(point);
            if (kind === -1) kind = unicodeKinds.get(point) ?? -1;
            if (kind === -1) {
                const char = String.fromCodePoint(point);
                kind = letter.test(char)
                    ? 1
                    : mark.test(char)
                      ? 4
                      : number.test(char)
                        ? 0
                        : whitespace.test(char)
                          ? 3
                          : 2;
                if (unicodeKinds.size < 256) unicodeKinds.set(point, kind);
            }
        } else {
            kind =
                (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
                    ? 1
                    : code >= 48 && code <= 57
                      ? 0
                      : code === 32 || (code >= 9 && code <= 13)
                        ? 3
                        : 2;
        }
        letters = kind === 1 || kind === 4 ? letters + 1 : 0;
        nonLetters = kind !== 0 && kind !== 1 ? nonLetters + 1 : 0;
        // Marks belong to both letter cores and punctuation runs; whitespace can extend punctuation tails.
        if (letters >= 102 || nonLetters >= 102) return true;
    }
    return false;
}

/**
 * `require` keeps encoder JSON usable in plain Node. Splitting long native pieces bounds quadratic
 * BPE work; their ids may differ by a few tokens per cut.
 */
export async function loadTiktoken(
    encoding: "cl100k_base" | "o200k_base",
): Promise<{ encode(text: string): Uint32Array; free(): void }> {
    const { Tiktoken } = await import("@dqbd/tiktoken");
    const data = require(`@dqbd/tiktoken/encoders/${encoding}.json`) as EncoderData;
    const tokenizer: Tiktoken = new Tiktoken(data.bpe_ranks, data.special_tokens, data.pat_str);
    let pattern: RegExp;
    try {
        // Rust's whitespace class includes NEL and excludes BOM, unlike JavaScript's \s.
        pattern = new RegExp(
            data.pat_str.replaceAll("\\s", "\\p{White_Space}").replaceAll("\\S", "\\P{White_Space}"),
            "gu",
        );
    } catch {
        // Package updates may use Rust regex syntax JavaScript cannot compile.
        return tokenizer;
    }
    const specialTokens = Object.keys(data.special_tokens);

    return {
        encode(text) {
            if (
                (text.length <= MAX_PIECE_BYTES && Buffer.byteLength(text) <= MAX_PIECE_BYTES) ||
                !hasLongRun(text) ||
                unicodeTableDifferences.test(text)
            ) {
                return tokenizer.encode(text);
            }
            const cuts: number[] = [];
            for (const match of text.matchAll(pattern)) {
                if (Buffer.byteLength(match[0]) <= MAX_PIECE_BYTES) continue;
                let bytes = 0;
                for (let i = match.index; i < match.index + match[0].length;) {
                    const point = text.codePointAt(i)!;
                    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
                    if (bytes + size > MAX_PIECE_BYTES) {
                        cuts.push(i);
                        bytes = 0;
                    }
                    bytes += size;
                    i += point > 0xffff ? 2 : 1;
                }
            }
            if (cuts.length === 0) return tokenizer.encode(text);
            // Validate the whole text before a cut can hide a special token from the package.
            for (const special of specialTokens) {
                if (text.includes(special)) tokenizer.encode(special);
            }
            cuts.push(text.length);
            let start = 0;
            const pieces = cuts.map((end) => {
                const ids = tokenizer.encode_ordinary(text.slice(start, end));
                start = end;
                return ids;
            });
            const ids = new Uint32Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
            let offset = 0;
            for (const piece of pieces) {
                ids.set(piece, offset);
                offset += piece.length;
            }
            return ids;
        },
        free: () => tokenizer.free(),
    };
}
