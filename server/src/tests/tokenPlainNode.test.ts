// @vitest-environment node
/** @module-tag slow */
import { spawn } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, it } from "vitest";
import { TOKENIZER_FAMILIES, type TokenizerFamily } from "../prompt/tokenizers/index.ts";
import {
    type FixtureRecord,
    fixture,
    makeTempRoot,
    materialize,
    removeTempRoots,
    REPO_ROOT,
    SHORT_TEXT_NAMES,
    TEXT_NAMES,
    TOKENIZERS_DIR,
} from "./tokenFixtures.ts";

/**
 * The server tokenizers in a fresh plain `node` process: cold, concurrent loads from an image-layout
 * root, and the `loadAll` entry's report and exit code. Each test spawns its own process, so they
 * run concurrently (and take the test context's `expect`).
 */
afterAll(removeTempRoots);

/** A root that holds only `server/assets/token/` (the image shape), as a link to the repository payloads. */
function makeImageLayoutRoot(): string {
    const root = makeTempRoot();
    mkdirSync(path.join(root, "server/assets"), { recursive: true });
    symlinkSync(path.join(REPO_ROOT, "server/assets/token"), path.join(root, "server/assets/token"), "dir");
    return root;
}

/** Runs a script with plain `node` (no flags, no `NODE_OPTIONS`) and returns its exit and output. */
async function runNode(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    return { code, stdout, stderr };
}
describe.concurrent("plain Node", () => {
    it("loads every family cold and concurrently on two sets from an image-layout root, then encodes as the browser", async ({
        expect,
    }) => {
        // A fresh process: nothing warmed the module or the wasm binding, and Vitest's module
        // resolution (its `browser` condition) is not in the way.
        const root = makeImageLayoutRoot();
        const script = path.join(root, "race.mjs");
        writeFileSync(
            script,
            `
import { createTokenizers, TOKENIZER_FAMILIES } from ${JSON.stringify(path.join(TOKENIZERS_DIR, "index.ts"))};
const [rootDir, textsJson] = process.argv.slice(2);
const texts = JSON.parse(textsJson);
const sets = [createTokenizers({ rootDir }), createTokenizers({ rootDir })];
// Every family on both sets at once, plus duplicate requests for the same family on one set.
await Promise.all([
    ...sets.flatMap((set) => TOKENIZER_FAMILIES.map((family) => set.load(family))),
    sets[0].load("claude"),
    sets[0].load("novelai"),
    sets[1].load("GLM5"),
]);
const out = [];
for (const set of sets) {
    const bySet = {};
    for (const family of TOKENIZER_FAMILIES) {
        bySet[family] = {};
        for (const [name, text] of Object.entries(texts)) {
            try {
                bySet[family][name] = { ids: Array.from(await set.encode(family, text)) };
            } catch (error) {
                bySet[family][name] = { error: error instanceof Error ? error.message : String(error) };
            }
        }
    }
    out.push(bySet);
}
await Promise.all(sets.map((set) => set.dispose()));
console.log(JSON.stringify(out));
`,
        );
        const texts = Object.fromEntries(SHORT_TEXT_NAMES.map((name) => [name, materialize(fixture.texts[name])]));
        const result = await runNode([script, root, JSON.stringify(texts)], root);
        expect(result.code, result.stderr).toBe(0);
        const lines = result.stdout.trim().split("\n");
        const sets = JSON.parse(lines[lines.length - 1]) as Record<string, Record<string, FixtureRecord>>[];
        expect(sets).toHaveLength(2);
        for (const bySet of sets) {
            for (const family of TOKENIZER_FAMILIES) {
                for (const name of SHORT_TEXT_NAMES) {
                    const expected = fixture.families[family][name];
                    const actual = bySet[family][name];
                    if ("error" in expected) {
                        expect(actual, `${family} ${name}`).toHaveProperty("error");
                        expect((actual as { error: string }).error).toContain(expected.error);
                    } else {
                        expect(actual, `${family} ${name}`).toEqual(expected);
                    }
                }
            }
        }
    }, 120_000);

    it("the loadAll entry reports every family with the browser's counts and exits 0 from the repository root", async ({
        expect,
    }) => {
        const result = await runNode([path.join(TOKENIZERS_DIR, "loadAll.ts"), REPO_ROOT], REPO_ROOT);
        expect(result.code, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout) as { families: Record<string, unknown>[]; rssMB: number };
        expect(report.families.map((family) => family.family)).toEqual(TOKENIZER_FAMILIES);
        for (const entry of report.families) {
            expect(entry).not.toHaveProperty("error");
            const family = entry.family as TokenizerFamily;
            const expected = TEXT_NAMES.slice(0, 3).map(
                (name) => (fixture.families[family][name] as { ids: number[] }).ids.length,
            );
            expect(entry.counts, family).toEqual(expected);
            expect(entry.loadMs).toBeGreaterThanOrEqual(0);
        }
        expect(report.rssMB).toBeGreaterThan(0);
    }, 120_000);

    it("the loadAll entry reports the families whose payload is missing and exits 1, the others still counted", async ({
        expect,
    }) => {
        const root = makeTempRoot();
        const result = await runNode([path.join(TOKENIZERS_DIR, "loadAll.ts")], root);
        expect(result.code, result.stderr).toBe(1);
        const report = JSON.parse(result.stdout) as { families: Record<string, unknown>[] };
        const byFamily = new Map(report.families.map((entry) => [entry.family as TokenizerFamily, entry]));
        expect(byFamily.get("cl100k_base")).toEqual({
            family: "cl100k_base",
            loadMs: expect.any(Number),
            counts: [2, 23, 27],
        });
        expect(byFamily.get("o200k_base")).toEqual({
            family: "o200k_base",
            loadMs: expect.any(Number),
            counts: [2, 15, 27],
        });
        for (const family of TOKENIZER_FAMILIES) {
            if (family === "cl100k_base" || family === "o200k_base") {
                continue;
            }
            expect(byFamily.get(family), family).toHaveProperty("error");
            expect((byFamily.get(family) as { error: string }).error).toMatch(
                /Tokenizer payload .* not found in .*server\/assets\/token/,
            );
        }
    }, 60_000);
});
