import type { GemmaTokenizer } from "@huggingface/transformers";
import { readTokenizerPayload } from "./payloads.ts";

/**
 * The former client tokenizer's `gemmaTokenize`: Transformers.js's `GemmaTokenizer` over
 * `llama/llama3.json`, not a Gemma vocabulary. Kept for parity with the frozen browser ids captured
 * from it (`server/src/tests/fixtures/tokens/browser-ids.json`); a known hazard.
 */
export async function loadGemmaTokenizer(rootDir: string): Promise<GemmaTokenizer> {
    const [{ GemmaTokenizer }, payload] = await Promise.all([
        import("@huggingface/transformers"),
        readTokenizerPayload(rootDir, "llama/llama3.json"),
    ]);
    return new GemmaTokenizer(JSON.parse(new TextDecoder().decode(payload)), {});
}
