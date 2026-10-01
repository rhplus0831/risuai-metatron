// @vitest-environment node
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Tiktoken } from "@dqbd/tiktoken";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createTokenizers,
    TOKENIZER_FAMILIES,
    type TokenizerFamily,
    type Tokenizers,
} from "../prompt/tokenizers/index.ts";
import { loadAll, SMOKE_TEXTS } from "../prompt/tokenizers/loadAll.ts";
import { readTokenizerPayload, resolveTokenizerPayload } from "../prompt/tokenizers/payloads.ts";
import { createTokenCounter, TOKEN_CACHE_SIZE, type TokenCountScope } from "../prompt/tokens.ts";
import { LLMTokenizer } from "../../../shared/llm.ts";
import { ChatTokenCounter } from "../../../shared/prompt/chatTokens.ts";
import { selectTokenizer, type TokenizerChoice } from "../../../shared/tokenizerChoice.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const TOKENIZERS_DIR = path.resolve(import.meta.dirname, "../prompt/tokenizers");
const FIXTURE_PATH = path.join(import.meta.dirname, "fixtures/tokens/browser-ids.json");
const BASELINE_DIR = path.join(import.meta.dirname, "fixtures/baseline");

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

// ---------------------------------------------------------------------------------------------
// Phase 5 slice 4: the shared routing (`selectTokenizer`), the server counter
// (`createTokenCounter`), and the shared token arithmetic (`ChatTokenCounter`).
// ---------------------------------------------------------------------------------------------

type BaselineRouting = Record<
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
type BaselineTokenCounts = {
    routing: BaselineRouting;
    prompts: Record<string, Record<string, { perMessage: number[]; total: number }>>;
};
const baselineScenario = JSON.parse(readFileSync(path.join(BASELINE_DIR, "scenario.json"), "utf8")) as {
    tokens: { texts: Record<string, FixtureText>; promptFamilies: Record<string, unknown> };
};
const baselineCounts = JSON.parse(
    readFileSync(path.join(BASELINE_DIR, "token-counts.json"), "utf8"),
) as BaselineTokenCounts;

/** A `TokenCountScope` with the fields the client's `encode` read, defaulted as the capture's base settings. */
function scope(fields: Partial<TokenCountScope> = {}): TokenCountScope {
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

/** A recording stand-in for the server tokenizers: the ids are the family's name length and the text's length. */
function stubTokenizers() {
    const calls: [string, string][] = [];
    const tokenizers = {
        encode: vi.fn(async (family: string, text: string) => {
            calls.push([family, text]);
            return [family.length, text.length];
        }),
    } as unknown as Tokenizers;
    return { tokenizers, calls };
}

const family = (name: string): TokenizerChoice => ({ kind: "family", family: name as TokenizerFamily });

describe("selectTokenizer (the shared routing)", () => {
    const base = { aiModel: "gpt-5.5", customTokenizer: "tik", pluginTokenizer: "none", googleClaudeTokenizing: false };

    it("routes openrouter and reverse_proxy by customTokenizer, llama3 to the llama model, unknown names to o200k_base", () => {
        const byName: Record<string, string> = {
            mistral: "mistral",
            llama: "llama",
            llama3: "llama",
            novelai: "novelai",
            claude: "claude",
            novellist: "novellist",
            gemma: "gemma",
            cohere: "cohere",
            deepseek: "DeepSeek",
            "deepseek-v4": "DeepSeekV4",
            glm4: "GLM4",
            glm5: "GLM5",
            tik: "o200k_base",
            "": "o200k_base",
            nope: "o200k_base",
        };
        for (const aiModel of ["openrouter", "reverse_proxy"]) {
            for (const [name, expected] of Object.entries(byName)) {
                // The catalogue family and the Google toggle are ignored on this branch.
                expect(
                    selectTokenizer({
                        ...base,
                        aiModel,
                        customTokenizer: name,
                        modelTokenizer: LLMTokenizer.Claude,
                        googleClaudeTokenizing: true,
                    }),
                    `${aiModel} ${name}`,
                ).toEqual(family(expected));
            }
        }
    });

    it("routes a legacy plugin model (custom) by the provider's declared tokenizer; a missing provider counts with o200k_base", () => {
        const custom = (pluginTokenizer: string) =>
            selectTokenizer({ ...base, aiModel: "custom", pluginTokenizer, modelTokenizer: LLMTokenizer.Claude });
        expect(custom("none")).toEqual(family("o200k_base"));
        expect(custom("o200k_base")).toEqual(family("o200k_base"));
        expect(custom("cl100k_base")).toEqual(family("cl100k_base"));
        expect(custom("llama3")).toEqual(family("llama"));
        expect(custom("claude")).toEqual(family("claude"));
        expect(custom("deepseek-v4")).toEqual(family("DeepSeekV4"));
        expect(custom("whatever")).toEqual(family("o200k_base"));
        expect(custom("custom")).toEqual({ kind: "pluginFunction" });
        // An empty declared tokenizer falls through to the catalogue family (as the client's `&& pluginTokenizer` did).
        expect(custom("")).toEqual(family("claude"));
        // A `pluginmodel:::` model is not `custom`: the catalogue family decides.
        expect(
            selectTokenizer({
                ...base,
                aiModel: "pluginmodel:::p",
                pluginTokenizer: "claude",
                modelTokenizer: LLMTokenizer.Unknown,
            }),
        ).toEqual(family("cl100k_base"));
    });

    it("routes every catalogue family; GoogleCloud counts remotely only with googleClaudeTokenizing", () => {
        const byFamily: [LLMTokenizer, string][] = [
            [LLMTokenizer.NovelList, "novellist"],
            [LLMTokenizer.Claude, "claude"],
            [LLMTokenizer.NovelAI, "novelai"],
            [LLMTokenizer.Mistral, "mistral"],
            [LLMTokenizer.Llama, "llama"],
            [LLMTokenizer.tiktokenO200Base, "o200k_base"],
            [LLMTokenizer.Gemma, "gemma"],
            [LLMTokenizer.GoogleCloud, "gemma"],
            [LLMTokenizer.DeepSeek, "DeepSeek"],
            [LLMTokenizer.DeepSeekV4, "DeepSeekV4"],
            [LLMTokenizer.GLM4, "GLM4"],
            [LLMTokenizer.GLM5, "GLM5"],
            [LLMTokenizer.Cohere, "cohere"],
            [LLMTokenizer.Unknown, "cl100k_base"],
            [LLMTokenizer.tiktokenCl100kBase, "cl100k_base"],
            [LLMTokenizer.Llama3, "cl100k_base"],
            [LLMTokenizer.Local, "cl100k_base"],
        ];
        expect(byFamily.map(([value]) => value).sort((a, b) => a - b)).toEqual(
            Object.values(LLMTokenizer).sort((a, b) => a - b),
        );
        for (const [modelTokenizer, expected] of byFamily) {
            expect(selectTokenizer({ ...base, modelTokenizer }), String(modelTokenizer)).toEqual(family(expected));
            expect(selectTokenizer({ ...base, modelTokenizer, googleClaudeTokenizing: true })).toEqual(
                modelTokenizer === LLMTokenizer.GoogleCloud ? { kind: "googleCloud" } : family(expected),
            );
        }
    });
});

describe("createTokenCounter", () => {
    it("encodes with the routed family and counts the ids; caching off asks the tokenizers every time", async () => {
        const { tokenizers, calls } = stubTokenizers();
        const counter = createTokenCounter({ tokenizers });
        expect(Array.from(await counter.encode("abc", scope({ model: { tokenizer: LLMTokenizer.Claude } })))).toEqual([
            6, 3,
        ]);
        expect(await counter.count("abcd", scope({ aiModel: "reverse_proxy", customTokenizer: "glm5" }))).toBe(2);
        expect(await counter.count("abcd", scope({ aiModel: "reverse_proxy", customTokenizer: "glm5" }))).toBe(2);
        expect(calls).toEqual([
            ["claude", "abc"],
            ["GLM5", "abcd"],
            ["GLM5", "abcd"],
        ]);
    });

    it("never calls a legacy plugin's tokenizer function: a `custom` tokenizer counts with cl100k_base", async () => {
        const { tokenizers, calls } = stubTokenizers();
        const counter = createTokenCounter({ tokenizers });
        await counter.encode(
            "plugin text",
            scope({ aiModel: "custom", currentPluginProvider: "p", pluginTokenizer: "custom" }),
        );
        expect(calls).toEqual([["cl100k_base", "plugin text"]]);
    });

    it("a plugin provider is counted by its declared family; an absent provider by o200k_base", async () => {
        const { tokenizers, calls } = stubTokenizers();
        const counter = createTokenCounter({ tokenizers });
        await counter.encode("t", scope({ aiModel: "custom", currentPluginProvider: "p", pluginTokenizer: "mistral" }));
        await counter.encode("t", scope({ aiModel: "custom", currentPluginProvider: "gone", pluginTokenizer: "none" }));
        expect(calls).toEqual([
            ["mistral", "t"],
            ["o200k_base", "t"],
        ]);
    });

    describe("with useTokenizerCaching", () => {
        it("answers a repeated text of the same scope from the cache and separates the scopes by every field", async () => {
            const { tokenizers, calls } = stubTokenizers();
            const counter = createTokenCounter({ tokenizers });
            const cached = scope({
                useTokenizerCaching: true,
                model: { tokenizer: LLMTokenizer.Claude, internalID: "a" },
            });
            const first = await counter.encode("same", cached);
            expect(await counter.encode("same", cached)).toBe(first);
            expect(calls).toHaveLength(1);
            // Each of these differs from `cached` in one key field: none hits.
            const variants: Partial<TokenCountScope>[] = [
                { aiModel: "other" },
                { customTokenizer: "claude" },
                { currentPluginProvider: "p" },
                { googleClaudeTokenizing: true },
                { model: { tokenizer: LLMTokenizer.Mistral, internalID: "a" } },
                { model: { tokenizer: LLMTokenizer.Claude, internalID: "b" } },
                { model: { tokenizer: LLMTokenizer.Claude } },
                { pluginTokenizer: "mistral" },
            ];
            for (const variant of variants) {
                await counter.encode("same", { ...cached, ...variant });
            }
            expect(calls).toHaveLength(1 + variants.length);
            // The text is part of the key too, and a different text of the same scope is cached on its own.
            await counter.encode("other", cached);
            await counter.encode("other", cached);
            expect(calls).toHaveLength(2 + variants.length);
        });

        it("keeps the last 1,500 entries (an LRU): the oldest is evicted and encoded again", async () => {
            const { tokenizers, calls } = stubTokenizers();
            const counter = createTokenCounter({ tokenizers });
            const cached = scope({ useTokenizerCaching: true });
            for (let i = 0; i < TOKEN_CACHE_SIZE; i++) {
                await counter.encode(`t${i}`, cached);
            }
            await counter.encode("t0", cached);
            expect(calls).toHaveLength(TOKEN_CACHE_SIZE);
            // One more distinct text evicts the least recently used (`t1`, since `t0` was just read).
            await counter.encode("overflow", cached);
            await counter.encode("t0", cached);
            expect(calls).toHaveLength(TOKEN_CACHE_SIZE + 1);
            await counter.encode("t1", cached);
            expect(calls).toHaveLength(TOKEN_CACHE_SIZE + 2);
        });

        it("serves concurrent scopes each from its own route", async () => {
            const { tokenizers, calls } = stubTokenizers();
            const counter = createTokenCounter({ tokenizers });
            const claude = scope({ useTokenizerCaching: true, model: { tokenizer: LLMTokenizer.Claude } });
            const mistral = scope({ useTokenizerCaching: true, model: { tokenizer: LLMTokenizer.Mistral } });
            const results = await Promise.all([
                counter.count("x", claude),
                counter.count("x", mistral),
                counter.count("x", claude),
                counter.count("xy", mistral),
            ]);
            expect(results).toEqual([2, 2, 2, 2]);
            expect(calls.map(([family, text]) => `${family}:${text}`).sort()).toEqual([
                "claude:x",
                "claude:x",
                "mistral:x",
                "mistral:xy",
            ]);
        });
    });

    describe("Google's countTokens", () => {
        const google = (fields: Partial<TokenCountScope> = {}) =>
            scope({
                aiModel: "gemini-3-flash-preview",
                model: { tokenizer: LLMTokenizer.GoogleCloud, internalID: "gemini-3-flash-preview" },
                googleClaudeTokenizing: true,
                googleAccessToken: "secret-token",
                ...fields,
            });
        const ok = (totalTokens: number) => new Response(JSON.stringify({ totalTokens }), { status: 200 });

        it("posts the text to the model's countTokens endpoint with the server token and counts totalTokens", async () => {
            const { tokenizers, calls } = stubTokenizers();
            const fetchImpl = vi.fn(async () => ok(7));
            const counter = createTokenCounter({ tokenizers, fetchImpl: fetchImpl as unknown as typeof fetch });
            const ids = await counter.encode("count me", google());
            expect(ids).toBeInstanceOf(Uint32Array);
            expect(ids).toHaveLength(7);
            expect(calls).toEqual([]);
            expect(fetchImpl).toHaveBeenCalledTimes(1);
            const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
            expect(url).toBe(
                "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:countTokens?key=secret-token",
            );
            expect(init).toEqual({
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text: "count me" }] }] }),
            });
        });

        it("falls back to the Gemma SentencePiece tokenizer on a non-200 answer, without caching it", async () => {
            const { tokenizers, calls } = stubTokenizers();
            const fetchImpl = vi.fn(async () => new Response("quota", { status: 429 }));
            const counter = createTokenCounter({ tokenizers, fetchImpl: fetchImpl as unknown as typeof fetch });
            expect(await counter.count("fallback", google())).toBe(2);
            expect(await counter.count("fallback", google())).toBe(2);
            expect(calls).toEqual([
                ["gemmaSentencePiece", "fallback"],
                ["gemmaSentencePiece", "fallback"],
            ]);
            expect(fetchImpl).toHaveBeenCalledTimes(2);
        });

        it("rejects on a network error, as the client did", async () => {
            const { tokenizers } = stubTokenizers();
            const counter = createTokenCounter({
                tokenizers,
                fetchImpl: (async () => {
                    throw new TypeError("fetch failed");
                }) as unknown as typeof fetch,
            });
            await expect(counter.count("x", google())).rejects.toThrow("fetch failed");
        });

        it("does not count remotely without googleClaudeTokenizing (the gemma family counts)", async () => {
            const { tokenizers, calls } = stubTokenizers();
            const fetchImpl = vi.fn();
            const counter = createTokenCounter({ tokenizers, fetchImpl: fetchImpl as unknown as typeof fetch });
            await counter.encode("local", google({ googleClaudeTokenizing: false }));
            expect(calls).toEqual([["gemma", "local"]]);
            expect(fetchImpl).not.toHaveBeenCalled();
        });

        it("caches a successful count by text and model, with the tokenizer cache on or off", async () => {
            const { tokenizers } = stubTokenizers();
            const fetchImpl = vi.fn(async (url: string) => ok(url.includes("model-A") ? 7 : 19));
            const counter = createTokenCounter({ tokenizers, fetchImpl: fetchImpl as unknown as typeof fetch });
            const a = google({ model: { tokenizer: LLMTokenizer.GoogleCloud, internalID: "model-A" } });
            expect(await counter.count("same text", a)).toBe(7);
            expect(await counter.count("same text", a)).toBe(7);
            expect(await counter.count("same text", { ...a, useTokenizerCaching: true })).toBe(7);
            expect(fetchImpl).toHaveBeenCalledTimes(1);
        });

        it("two scopes that resolve one aiModel to different models count separately, cached or not", async () => {
            // The challenge's two-scope case: the cache key carries the model's internalID.
            const { tokenizers } = stubTokenizers();
            const fetchImpl = vi.fn(async (url: string) => ok(url.includes("model-A") ? 7 : 19));
            const counter = createTokenCounter({ tokenizers, fetchImpl: fetchImpl as unknown as typeof fetch });
            const a = google({
                aiModel: "xcustom:::same",
                model: { tokenizer: LLMTokenizer.GoogleCloud, internalID: "model-A" },
                useTokenizerCaching: true,
            });
            const b = { ...a, model: { tokenizer: LLMTokenizer.GoogleCloud, internalID: "model-B" } };
            expect(await counter.count("same text", a)).toBe(7);
            expect(await counter.count("same text", b)).toBe(19);
            expect(await counter.count("same text", { ...b, useTokenizerCaching: false })).toBe(19);
            expect(await counter.count("same text", a)).toBe(7);
            expect(fetchImpl.mock.calls.map(([url]) => new URL(url as string).pathname)).toEqual([
                "/v1beta/models/model-A:countTokens",
                "/v1beta/models/model-B:countTokens",
            ]);
        });
    });

    describe("against the browser's routing capture (token-counts.json `routing`)", () => {
        const tokenizers = createTokenizers({ rootDir: REPO_ROOT });
        afterAll(() => tokenizers.dispose());
        const counter = createTokenCounter({ tokenizers });
        const routing = baselineCounts.routing;
        const texts = baselineScenario.tokens.texts;

        /** The scope the capture's settings resolve to (the client resolved the catalogue family itself). */
        function scopeOf(name: string): TokenCountScope {
            const entry = routing[name];
            return scope({
                aiModel: entry.settings.aiModel,
                currentPluginProvider: entry.settings.currentPluginProvider ?? "",
                model: {
                    tokenizer: LLMTokenizer[entry.resolvedTokenizer],
                    internalID: entry.settings.customModels?.[0]?.internalId,
                },
                pluginTokenizer: entry.providerOptions?.tokenizer ?? "none",
                customTokenizer: entry.settings.customTokenizer ?? "tik",
                googleClaudeTokenizing: entry.settings.googleClaudeTokenizing ?? false,
            });
        }

        it("the capture covers the plugin branches and the Google toggle", () => {
            expect(Object.keys(routing)).toContain("plugin-legacy-custom-func");
            expect(Object.keys(routing)).toContain("plugin-legacy-no-options");
            expect(routing["gemini-no-google-count"].settings.googleClaudeTokenizing).toBe(false);
        });

        it.each(Object.keys(baselineCounts.routing).filter((name) => name !== "plugin-legacy-custom-func"))(
            "%s gives the browser's ids for every captured text",
            async (name) => {
                const entry = routing[name];
                for (const [textName, record] of Object.entries(entry.texts)) {
                    await expectBrowserRecord(
                        () => counter.encode(materialize(texts[textName]), scopeOf(name)),
                        record,
                    );
                }
            },
            60_000,
        );

        it("plugin-legacy-custom-func counts with cl100k_base instead of the plugin's function (the recorded difference)", async () => {
            const name = "plugin-legacy-custom-func";
            expect(routing[name].providerOptions?.tokenizer).toBe("custom");
            // The browser answered the plugin's own `tokenizerFunc` (three ids per text).
            expect((routing[name].texts.ascii as { ids: number[] }).ids).toHaveLength(3);
            const expected = routing["plugin-legacy-cl100k"].texts;
            for (const [textName, record] of Object.entries(expected)) {
                await expectBrowserRecord(() => counter.encode(materialize(texts[textName]), scopeOf(name)), record);
            }
        }, 60_000);
    });

    describe("the lore prompt's token delta (deltas/lore-regex-fix-token-counts.json)", () => {
        const tokenizers = createTokenizers({ rootDir: REPO_ROOT });
        afterAll(() => tokenizers.dispose());
        const delta = JSON.parse(
            readFileSync(path.join(BASELINE_DIR, "deltas/lore-regex-fix-token-counts.json"), "utf8"),
        ) as {
            prompts: {
                lore: {
                    insertAt: number;
                    inserted: { role: string; content: string }[];
                    families: Record<string, { inserted: number[]; perMessage: number[]; total: number }>;
                };
            };
        };
        const promptsDelta = JSON.parse(
            readFileSync(path.join(BASELINE_DIR, "deltas/lore-regex-fix-prompts.json"), "utf8"),
        ) as {
            fixtures: { lore: { insertAt: number; inserted: { role: string; content: string }[] } };
        };
        const lore = delta.prompts.lore;

        it("inserts the same two messages at the same index as the prompts delta, for every captured family", () => {
            expect(lore.inserted).toEqual(promptsDelta.fixtures.lore.inserted);
            expect(lore.insertAt).toBe(promptsDelta.fixtures.lore.insertAt);
            expect(Object.keys(lore.families).sort()).toEqual(Object.keys(baselineCounts.prompts.lore).sort());
            for (const [family, after] of Object.entries(lore.families)) {
                const before = baselineCounts.prompts.lore[family];
                expect(after.perMessage, family).toEqual([
                    ...before.perMessage.slice(0, lore.insertAt),
                    ...after.inserted,
                    ...before.perMessage.slice(lore.insertAt),
                ]);
                expect(after.total, family).toBe(before.total + after.inserted[0] + after.inserted[1]);
                expect(
                    after.perMessage.reduce((a, b) => a + b, 0),
                    family,
                ).toBe(after.total);
            }
        });

        it("the server's tokenizers count the two inserted messages as the delta records, per family", async () => {
            for (const [family, after] of Object.entries(lore.families)) {
                const counts = [];
                for (const message of lore.inserted) {
                    counts.push(await tokenizers.count(family as TokenizerFamily, message.content));
                }
                expect(counts, family).toEqual(after.inserted);
            }
        }, 60_000);
    });
});

describe("ChatTokenCounter (the shared token arithmetic)", () => {
    const make = (
        chatAdditionalTokens: number,
        useName: "name" | "noName",
        host: Partial<ConstructorParameters<typeof ChatTokenCounter>[2]> = {},
    ) =>
        new ChatTokenCounter(chatAdditionalTokens, useName, {
            encode: async (text) => Array.from(text, (_, i) => i),
            supportsInlayImage: () => true,
            gptVisionQuality: () => "high",
            ...host,
        });

    it("counts the content plus the additional tokens, and the name plus one when names are counted", async () => {
        const message = { role: "user" as const, content: "hello", name: "ab" };
        expect(await make(3, "name").tokenizeChat(message)).toBe(5 + 3 + 2 + 1);
        expect(await make(3, "noName").tokenizeChat(message)).toBe(5 + 3);
        expect(await make(0, "name").tokenizeChat({ role: "user", content: "" })).toBe(0);
    });

    it("counts thoughts (plus one each) only when asked", async () => {
        const message = { role: "assistant" as const, content: "hi", thoughts: ["abc", "d"] };
        expect(await make(1, "noName").tokenizeChat(message)).toBe(3);
        expect(await make(1, "noName").tokenizeChat(message, { countThoughts: true })).toBe(3 + 4 + 2);
        expect(await make(1, "noName").tokenizeChat({ ...message, thoughts: [] }, { countThoughts: true })).toBe(3);
    });

    it("counts an image by the tile formula: 85 plus two per 512-pixel tile after clamping to 768 (the inherited scaling)", () => {
        const counter = make(3, "noName");
        const image = (width?: number, height?: number) => ({ type: "image" as const, base64: "", width, height });
        expect(counter.tokenizeMultiModal(image(512, 512))).toBe(3 + 2 + 85);
        expect(counter.tokenizeMultiModal(image(1024, 1024))).toBe(3 + 2 * 2 * 2 + 85);
        expect(counter.tokenizeMultiModal(image(768, 768))).toBe(3 + 2 * 2 * 2 + 85);
        // Portrait, width within 768: no scaling (ceil(500/512) * ceil(2000/512) = 4 tiles).
        expect(counter.tokenizeMultiModal(image(500, 2000))).toBe(3 + 4 * 2 + 85);
        // Portrait, width over 768 (inherited quirk): the width is clamped to 768 before the height
        // is scaled by `768 / width`, so the height stays 2000 (2 * 4 tiles, not 2 * 3).
        expect(counter.tokenizeMultiModal(image(1000, 2000))).toBe(3 + 8 * 2 + 85);
        // Landscape, height over 768: the same quirk, the width stays 2000 (4 * 2 tiles).
        expect(counter.tokenizeMultiModal(image(2000, 1000))).toBe(3 + 8 * 2 + 85);
        // Landscape, height within 768: no scaling (4 * 1 tiles).
        expect(counter.tokenizeMultiModal(image(2000, 500))).toBe(3 + 4 * 2 + 85);
        // Missing dimensions count as zero: no tiles.
        expect(counter.tokenizeMultiModal(image())).toBe(3 + 85);
    });

    it("counts every image as 87 at low vision quality, and as the additional tokens when inlay images are unsupported", () => {
        const image = { type: "image" as const, base64: "", width: 4000, height: 4000 };
        expect(make(3, "noName", { gptVisionQuality: () => "low" }).tokenizeMultiModal(image)).toBe(87);
        expect(
            make(3, "noName", { supportsInlayImage: () => false, gptVisionQuality: () => "low" }).tokenizeMultiModal(
                image,
            ),
        ).toBe(3);
        expect(make(3, "noName", { gptVisionQuality: () => undefined }).tokenizeMultiModal(image)).toBe(3 + 8 + 85);
    });

    it("adds the images of a message and sums a list of messages (thoughts not counted there)", async () => {
        const counter = make(1, "name");
        const message = {
            role: "user" as const,
            content: "abc",
            multimodals: [
                { type: "image" as const, base64: "", width: 512, height: 512 },
                { type: "image" as const, base64: "", width: 1024, height: 1024 },
            ],
            thoughts: ["ignored"],
        };
        expect(await counter.tokenizeChat(message)).toBe(3 + 1 + (1 + 2 + 85) + (1 + 8 + 85));
        expect(await counter.tokenizeChats([message, { role: "assistant", content: "de", name: "n" }])).toBe(
            3 + 1 + (1 + 2 + 85) + (1 + 8 + 85) + (2 + 1 + 1 + 1),
        );
    });
});
