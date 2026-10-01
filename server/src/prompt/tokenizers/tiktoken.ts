import { createRequire } from "node:module";
import type { Tiktoken } from "@dqbd/tiktoken";

const require = createRequire(import.meta.url);

type EncoderData = { bpe_ranks: string; special_tokens: Record<string, number>; pat_str: string };

/**
 * The client's `tikJS` encoders. Plain Node refuses a bare JSON import, so the encoder data comes
 * through `require`. `o200k_base` is the package's copy: the client bundles `src/etc/o200k_base.json`,
 * which the image does not ship, and the two hold the same `pat_str`, special tokens, and ranks.
 */
export async function loadTiktoken(encoding: "cl100k_base" | "o200k_base"): Promise<Tiktoken> {
    const { Tiktoken } = await import("@dqbd/tiktoken");
    const data = require(`@dqbd/tiktoken/encoders/${encoding}.json`) as EncoderData;
    return new Tiktoken(data.bpe_ranks, data.special_tokens, data.pat_str);
}
