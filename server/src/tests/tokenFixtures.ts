import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import type { TokenCountScope } from "../prompt/tokens.ts";
import { LLMTokenizer } from "../../../shared/llm.ts";

/**
 * Shared by the tokenizer tests (`tokens.test.ts`, `tokenParity.test.ts`, `tokenPlainNode.test.ts`):
 * the repository paths, the browser's captured ids, the baseline token counts, and temp roots.
 */

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
export const TOKENIZERS_DIR = path.resolve(import.meta.dirname, "../prompt/tokenizers");
export const FIXTURE_PATH = path.join(import.meta.dirname, "fixtures/tokens/browser-ids.json");
export const BASELINE_DIR = path.join(import.meta.dirname, "fixtures/baseline");

/** `fixtures/tokens/browser-ids.json`: the client's ids, captured in the browser (see its README). */
export type FixtureText = string | { unit: string; times: number };
export type FixtureRecord = { ids: number[] } | { error: string } | { count: number; hash: number };
export type Fixture = {
    provenance: Record<string, string>;
    texts: Record<string, FixtureText>;
    families: Record<string, Record<string, FixtureRecord>>;
};
export const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
export const TEXT_NAMES = Object.keys(fixture.texts);
export const SHORT_TEXT_NAMES = TEXT_NAMES.filter((name) => name !== "long");

export function materialize(text: FixtureText): string {
    return typeof text === "string" ? text : text.unit.repeat(text.times);
}

/** FNV-1a 32-bit over the ids joined by commas, as the capture computed it. */
export function fnv(ids: ArrayLike<number>): number {
    let hash = 0x811c9dc5;
    for (const char of Array.from(ids).join(",")) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
}

/** Compares one encode outcome with the fixture record of that family and text. */
export async function expectBrowserRecord(run: () => Promise<ArrayLike<number>>, record: FixtureRecord): Promise<void> {
    if ("error" in record) {
        await expect(run()).rejects.toThrow(record.error);
        return;
    }
    const ids = await run();
    if ("ids" in record) {
        expect(Array.from(ids)).toEqual(record.ids);
    } else {
        expect({ count: ids.length, hash: fnv(ids) }).toEqual(record);
    }
}

const tempDirs: string[] = [];
export function makeTempRoot(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-tokens-"));
    tempDirs.push(dir);
    return dir;
}

/** Removes the roots `makeTempRoot` made; each test file calls it from `afterAll`. */
export function removeTempRoots(): void {
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
}

export type BaselineRouting = Record<
    string,
    {
        settings: {
            aiModel: string;
            customTokenizer?: string;
            currentPluginProvider?: string;
            googleClaudeTokenizing?: boolean;
            customModels?: { internalId: string; tokenizer: number }[];
        };
        resolvedTokenizer: keyof typeof LLMTokenizer;
        texts: Record<string, FixtureRecord>;
        providerOptions?: { tokenizer: string; tokenizerFunc?: string };
    }
>;
export type BaselineTokenCounts = {
    routing: BaselineRouting;
    prompts: Record<string, Record<string, { perMessage: number[]; total: number }>>;
};
export const baselineScenario = JSON.parse(readFileSync(path.join(BASELINE_DIR, "scenario.json"), "utf8")) as {
    tokens: { texts: Record<string, FixtureText>; promptFamilies: Record<string, unknown> };
};
export const baselineCounts = JSON.parse(
    readFileSync(path.join(BASELINE_DIR, "token-counts.json"), "utf8"),
) as BaselineTokenCounts;

/** A `TokenCountScope` with the fields the client's `encode` read, defaulted as the capture's base settings. */
export function scope(fields: Partial<TokenCountScope> = {}): TokenCountScope {
    return {
        aiModel: "gpt-5.5",
        currentPluginProvider: "",
        model: { tokenizer: LLMTokenizer.tiktokenO200Base },
        pluginTokenizer: "none",
        customTokenizer: "tik",
        googleClaudeTokenizing: false,
        useTokenizerCaching: false,
        ...fields,
    };
}
