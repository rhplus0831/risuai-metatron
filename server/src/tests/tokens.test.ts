// @vitest-environment node
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Tiktoken } from "@dqbd/tiktoken";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTokenizers, TOKENIZER_FAMILIES, type TokenizerFamily } from "../prompt/tokenizers/index.ts";
import { loadAll, SMOKE_TEXTS } from "../prompt/tokenizers/loadAll.ts";
import { readTokenizerPayload, resolveTokenizerPayload } from "../prompt/tokenizers/payloads.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const TOKENIZERS_DIR = path.resolve(import.meta.dirname, "../prompt/tokenizers");
const FIXTURE_PATH = path.join(import.meta.dirname, "fixtures/tokens/browser-ids.json");

/** `fixtures/tokens/browser-ids.json`: the client's ids, captured in the browser (see its README). */
type FixtureText = string | { unit: string; times: number };
type FixtureRecord = { ids: number[] } | { error: string } | { count: number; hash: number };
type Fixture = {
    provenance: Record<string, string>;
    texts: Record<string, FixtureText>;
    families: Record<string, Record<string, FixtureRecord>>;
};
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
const TEXT_NAMES = Object.keys(fixture.texts);
const SHORT_TEXT_NAMES = TEXT_NAMES.filter((name) => name !== "long");

function materialize(text: FixtureText): string {
    return typeof text === "string" ? text : text.unit.repeat(text.times);
}

/** FNV-1a 32-bit over the ids joined by commas, as the capture computed it. */
function fnv(ids: ArrayLike<number>): number {
    let hash = 0x811c9dc5;
    for (const char of Array.from(ids).join(",")) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
}

/** Compares one encode outcome with the fixture record of that family and text. */
async function expectBrowserRecord(run: () => Promise<ArrayLike<number>>, record: FixtureRecord): Promise<void> {
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
function makeTempRoot(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-tokens-"));
    tempDirs.push(dir);
    return dir;
}
afterAll(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A root that holds only `dist/token/` (the image shape), as a link to the repository payloads. */
function makeDistOnlyRoot(): string {
    const root = makeTempRoot();
    mkdirSync(path.join(root, "dist"));
    symlinkSync(path.join(REPO_ROOT, "public/token"), path.join(root, "dist/token"), "dir");
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

describe("the fixture", () => {
    it("covers exactly the server's families and the smoke strings", () => {
        expect(Object.keys(fixture.families).sort()).toEqual([...TOKENIZER_FAMILIES].sort());
        expect(TEXT_NAMES).toContain("empty");
        expect(TEXT_NAMES).toContain("special");
        expect(TEXT_NAMES).toContain("long");
        expect(fixture.texts.empty).toBe("");
        // `loadAll`'s smoke strings are the fixture's first three texts, so its counts are checkable.
        expect(TEXT_NAMES.slice(0, 3).map((name) => materialize(fixture.texts[name]))).toEqual([...SMOKE_TEXTS]);
        for (const family of TOKENIZER_FAMILIES) {
            expect(Object.keys(fixture.families[family]).sort()).toEqual([...TEXT_NAMES].sort());
        }
    });
});

describe("browser parity in process", () => {
    const tokenizers = createTokenizers({ rootDir: REPO_ROOT });
    afterAll(() => tokenizers.dispose());

    it.each(TOKENIZER_FAMILIES)(
        "%s gives the browser's ids for every fixture text",
        async (family) => {
            for (const name of TEXT_NAMES) {
                const text = materialize(fixture.texts[name]);
                await expectBrowserRecord(() => tokenizers.encode(family, text), fixture.families[family][name]);
            }
        },
        60_000,
    );

    it("count is the id count, and empty input counts zero everywhere", async () => {
        for (const family of TOKENIZER_FAMILIES) {
            expect(await tokenizers.count(family, "")).toBe(0);
            const record = fixture.families[family].mixed as { ids: number[] };
            expect(await tokenizers.count(family, materialize(fixture.texts.mixed))).toBe(record.ids.length);
        }
    });

    it("the tiktoken families reject special-token text as the client does, and stay usable", async () => {
        for (const family of ["cl100k_base", "o200k_base"] as const) {
            await expect(tokenizers.count(family, "a <|endoftext|> b")).rejects.toThrow("special token");
            expect(await tokenizers.count(family, "hello world")).toBe(2);
        }
    });
});

describe("plain Node", () => {
    it("loads every family cold and concurrently on two sets from a dist-only root, then encodes as the browser", async () => {
        // A fresh process: nothing warmed the module or the wasm binding, and Vitest's module
        // resolution (its `browser` condition) is not in the way.
        const root = makeDistOnlyRoot();
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

    it("the loadAll entry reports every family with the browser's counts and exits 0 from the repository root", async () => {
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

    it("the loadAll entry reports the families whose payload is missing and exits 1, the others still counted", async () => {
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
                /Tokenizer payload .* not found in .*public\/token.* or .*dist\/token/,
            );
        }
    }, 60_000);
});

describe("loadAll in process", () => {
    it("counts the smoke strings for every family as the browser does", async () => {
        const report = await loadAll(REPO_ROOT);
        expect(report.families).toHaveLength(TOKENIZER_FAMILIES.length);
        for (const entry of report.families) {
            expect(entry).not.toHaveProperty("error");
            if ("counts" in entry) {
                const expected = TEXT_NAMES.slice(0, 3).map(
                    (name) => (fixture.families[entry.family][name] as { ids: number[] }).ids.length,
                );
                expect(entry.counts, entry.family).toEqual(expected);
            }
        }
    }, 60_000);
});

describe("the dispose contract", () => {
    const freeSpy = vi.spyOn(Tiktoken.prototype, "free");
    // Earlier describes dispose their sets after the spy exists, so the count starts at zero per test.
    beforeEach(() => {
        freeSpy.mockClear();
    });
    afterAll(() => freeSpy.mockRestore());

    it("concurrent dispose calls share one promise and free each loaded encoder once", async () => {
        const tokenizers = createTokenizers({ rootDir: REPO_ROOT });
        await tokenizers.load("cl100k_base");
        await tokenizers.load("claude");
        const first = tokenizers.dispose();
        const second = tokenizers.dispose();
        expect(second).toBe(first);
        // A second free of the web tokenizer would reject the disposal (`Tokenizer instance already deleted`).
        await expect(first).resolves.toBeUndefined();
        expect(freeSpy).toHaveBeenCalledTimes(1);
        expect(tokenizers.dispose()).toBe(first);
    });

    it("waits for a load that was pending when dispose began and frees its encoder once; the call is refused", async () => {
        const tokenizers = createTokenizers({ rootDir: REPO_ROOT });
        const pending = tokenizers.load("o200k_base");
        const disposal = tokenizers.dispose();
        await expect(pending).rejects.toThrow("The tokenizers are disposed");
        await expect(disposal).resolves.toBeUndefined();
        expect(freeSpy).toHaveBeenCalledTimes(1);
    });

    it("refuses every admission during and after dispose, constructing nothing", async () => {
        const tokenizers = createTokenizers({ rootDir: REPO_ROOT });
        await tokenizers.load("cl100k_base");
        const disposal = tokenizers.dispose();
        await expect(tokenizers.load("o200k_base")).rejects.toThrow("The tokenizers are disposed");
        await expect(tokenizers.count("cl100k_base", "x")).rejects.toThrow("The tokenizers are disposed");
        await disposal;
        await expect(tokenizers.encode("claude", "x")).rejects.toThrow("The tokenizers are disposed");
        await expect(tokenizers.load("cl100k_base")).rejects.toThrow("The tokenizers are disposed");
        expect(freeSpy).toHaveBeenCalledTimes(1);
    });

    it("an encode that resumes after dispose began is refused", async () => {
        const tokenizers = createTokenizers({ rootDir: REPO_ROOT });
        const encode = tokenizers.encode("cl100k_base", "hello world");
        const disposal = tokenizers.dispose();
        await expect(encode).rejects.toThrow("The tokenizers are disposed");
        await disposal;
        expect(freeSpy).toHaveBeenCalledTimes(1);
    });

    it("a failed load is not cached, does not poison the other families, and a retry succeeds", async () => {
        const root = makeTempRoot();
        const tokenizers = createTokenizers({ rootDir: root });
        const failure = tokenizers.load("claude");
        await expect(failure).rejects.toThrow(/Tokenizer payload claude\/claude\.json not found/);
        // The same rejected promise is not handed out again.
        await expect(tokenizers.load("claude")).rejects.toThrow(/not found/);
        // Another family and the module-wide factory queue are unaffected.
        expect(await tokenizers.count("cl100k_base", "hello world")).toBe(2);
        mkdirSync(path.join(root, "public"));
        symlinkSync(path.join(REPO_ROOT, "public/token"), path.join(root, "public/token"), "dir");
        const claude = fixture.families.claude.ascii as { ids: number[] };
        expect(Array.from(await tokenizers.encode("claude", "hello world"))).toEqual(claude.ids);
        expect(await tokenizers.count("llama", "hello world")).toBe(2);
        await expect(tokenizers.dispose()).resolves.toBeUndefined();
        expect(freeSpy).toHaveBeenCalledTimes(1);
    });

    it("dispose resolves when a load failed and nothing else was loaded", async () => {
        const tokenizers = createTokenizers({ rootDir: makeTempRoot() });
        await expect(tokenizers.load("GLM4")).rejects.toThrow(/not found/);
        await expect(tokenizers.dispose()).resolves.toBeUndefined();
        expect(freeSpy).not.toHaveBeenCalled();
    });
});

describe("payload resolution", () => {
    function makePayloadRoot(): string {
        const root = makeTempRoot();
        mkdirSync(path.join(root, "public/token/x"), { recursive: true });
        mkdirSync(path.join(root, "dist/token/x"), { recursive: true });
        writeFileSync(path.join(root, "public/token/x/y.bin"), Buffer.from([0, 1, 2, 255, 254, 3, 7]));
        writeFileSync(path.join(root, "dist/token/x/y.bin"), Buffer.from([9, 9, 9]));
        return root;
    }

    it("prefers public/token and falls through to dist/token only when the file is missing", async () => {
        const root = makePayloadRoot();
        expect(await resolveTokenizerPayload(root, "x/y.bin")).toBe(path.join(root, "public/token/x/y.bin"));
        rmSync(path.join(root, "public"), { recursive: true });
        expect(await resolveTokenizerPayload(root, "x/y.bin")).toBe(path.join(root, "dist/token/x/y.bin"));
    });

    it("reads the exact bytes into an ArrayBuffer of their own", async () => {
        const root = makePayloadRoot();
        const fromPublic = await readTokenizerPayload(root, "x/y.bin");
        expect(fromPublic).toBeInstanceOf(ArrayBuffer);
        expect(fromPublic.byteLength).toBe(7);
        expect(Array.from(new Uint8Array(fromPublic))).toEqual([0, 1, 2, 255, 254, 3, 7]);
        new Uint8Array(fromPublic).fill(42);
        expect(Array.from(new Uint8Array(await readTokenizerPayload(root, "x/y.bin")))).toEqual([
            0, 1, 2, 255, 254, 3, 7,
        ]);
        rmSync(path.join(root, "public"), { recursive: true });
        const fromDist = await readTokenizerPayload(root, "x/y.bin");
        expect(fromDist.byteLength).toBe(3);
        expect(Array.from(new Uint8Array(fromDist))).toEqual([9, 9, 9]);
    });

    it("names both candidates when the payload is missing everywhere", async () => {
        const root = makeTempRoot();
        await expect(resolveTokenizerPayload(root, "x/y.bin")).rejects.toThrow(
            `Tokenizer payload x/y.bin not found in ${path.join(root, "public/token/x/y.bin")} or ${path.join(root, "dist/token/x/y.bin")}`,
        );
        await expect(readTokenizerPayload(root, "x/y.bin")).rejects.toThrow("not found");
    });

    it.skipIf(process.getuid?.() === 0)(
        "an access error other than a missing file is reported, not read as missing",
        async () => {
            const root = makePayloadRoot();
            const locked = path.join(root, "public/token/x");
            chmodSync(locked, 0o000);
            try {
                await expect(resolveTokenizerPayload(root, "x/y.bin")).rejects.toMatchObject({ code: "EACCES" });
            } finally {
                chmodSync(locked, 0o755);
            }
        },
    );
});
