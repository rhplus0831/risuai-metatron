import { createTokenizers, TOKENIZER_FAMILIES, type TokenizerFamily } from "./index.ts";

/** The spike's fixed strings: plain ASCII, mixed scripts with emoji, and chat markup with code. */
export const SMOKE_TEXTS = [
    "hello world",
    "안녕하세요, 世界! Привет 👋🏽 café — naïve",
    "<s>[INST] {{char}} says hi [/INST]</s>\n\n    def f(x):\n\treturn x ** 2  # done",
] as const;

export type FamilyReport =
    { family: TokenizerFamily; loadMs: number; counts: number[] } | { family: TokenizerFamily; error: string };

/**
 * Loads every family from `rootDir` in turn and counts the smoke strings. A family that fails is
 * reported with its error; the others still run. `rssMB` is the resident set after all loads.
 */
export async function loadAll(rootDir: string): Promise<{ families: FamilyReport[]; rssMB: number }> {
    const tokenizers = createTokenizers({ rootDir });
    const families: FamilyReport[] = [];
    try {
        for (const family of TOKENIZER_FAMILIES) {
            const start = performance.now();
            try {
                await tokenizers.load(family);
                const loadMs = Math.round(performance.now() - start);
                const counts: number[] = [];
                for (const text of SMOKE_TEXTS) {
                    counts.push(await tokenizers.count(family, text));
                }
                families.push({ family, loadMs, counts });
            } catch (error) {
                families.push({ family, error: error instanceof Error ? error.message : String(error) });
            }
        }
        return { families, rssMB: Math.round(process.memoryUsage().rss / 2 ** 20) };
    } finally {
        await tokenizers.dispose();
    }
}

// `node server/src/prompt/tokenizers/loadAll.ts [rootDir]`: prints the report as JSON and exits 1
// when a family failed.
if (import.meta.main) {
    const report = await loadAll(process.argv[2] ?? process.cwd());
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.families.some((family) => "error" in family) ? 1 : 0;
}
