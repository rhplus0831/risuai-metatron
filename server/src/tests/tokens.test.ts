// @vitest-environment node
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Tiktoken } from "@dqbd/tiktoken";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createTokenizers,
    TOKENIZER_FAMILIES,
    type TokenizerFamily,
    type Tokenizers,
} from "../prompt/tokenizers/index.ts";
import { SMOKE_TEXTS } from "../prompt/tokenizers/loadAll.ts";
import { readTokenizerPayload, resolveTokenizerPayload } from "../prompt/tokenizers/payloads.ts";
import {
    createTokenCounter,
    GOOGLE_COUNT_TIMEOUT_MS,
    TOKEN_CACHE_SIZE,
    type TokenCountScope,
} from "../prompt/tokens.ts";
import { LLMTokenizer } from "../../../shared/llm.ts";
import { ChatTokenCounter } from "../../../shared/prompt/chatTokens.ts";
import { selectTokenizer, type TokenizerChoice } from "../../../shared/tokenizerChoice.ts";
import { fixture, makeTempRoot, materialize, removeTempRoots, REPO_ROOT, scope, TEXT_NAMES } from "./tokenFixtures.ts";

/**
 * The server tokenizers' contracts that need no family's payload (or one small one): the fixture's
 * shape, dispose, payload resolution, the shared routing, the counter against a stub, and the shared
 * token arithmetic. The browser parity is `tokenParity.test.ts`; the fresh-process loads are
 * `tokenPlainNode.test.ts`.
 */
afterAll(removeTempRoots);

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

describe("the dispose contract", () => {
    const freeSpy = vi.spyOn(Tiktoken.prototype, "free");
    // The count starts at zero per test, whatever an earlier test in this file freed.
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
        mkdirSync(path.join(root, "server/assets"), { recursive: true });
        symlinkSync(path.join(REPO_ROOT, "server/assets/token"), path.join(root, "server/assets/token"), "dir");
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
    const PAYLOAD_DIR = "server/assets/token";

    function makePayloadRoot(): string {
        const root = makeTempRoot();
        mkdirSync(path.join(root, PAYLOAD_DIR, "x"), { recursive: true });
        writeFileSync(path.join(root, PAYLOAD_DIR, "x/y.bin"), Buffer.from([0, 1, 2, 255, 254, 3, 7]));
        return root;
    }

    it("resolves a payload under server/assets/token of the root", async () => {
        const root = makePayloadRoot();
        expect(await resolveTokenizerPayload(root, "x/y.bin")).toBe(path.join(root, PAYLOAD_DIR, "x/y.bin"));
    });

    it("reads the exact bytes into an ArrayBuffer of their own", async () => {
        const root = makePayloadRoot();
        const payload = await readTokenizerPayload(root, "x/y.bin");
        expect(payload).toBeInstanceOf(ArrayBuffer);
        expect(payload.byteLength).toBe(7);
        expect(Array.from(new Uint8Array(payload))).toEqual([0, 1, 2, 255, 254, 3, 7]);
        new Uint8Array(payload).fill(42);
        expect(Array.from(new Uint8Array(await readTokenizerPayload(root, "x/y.bin")))).toEqual([
            0, 1, 2, 255, 254, 3, 7,
        ]);
    });

    it("does not read the client's former public/token or dist/token copies and names the one candidate", async () => {
        const root = makeTempRoot();
        for (const dir of ["public/token", "dist/token"]) {
            mkdirSync(path.join(root, dir, "x"), { recursive: true });
            writeFileSync(path.join(root, dir, "x/y.bin"), Buffer.from([9, 9, 9]));
        }
        await expect(resolveTokenizerPayload(root, "x/y.bin")).rejects.toThrow(
            `Tokenizer payload x/y.bin not found in ${path.join(root, PAYLOAD_DIR, "x/y.bin")}`,
        );
        await expect(readTokenizerPayload(root, "x/y.bin")).rejects.toThrow("not found");
    });

    it.skipIf(process.getuid?.() === 0)(
        "an access error other than a missing file is reported, not read as missing",
        async () => {
            const root = makePayloadRoot();
            const locked = path.join(root, PAYLOAD_DIR, "x");
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
// The shared routing (`selectTokenizer`), the server counter (`createTokenCounter`), and the
// shared token arithmetic (`ChatTokenCounter`).
// ---------------------------------------------------------------------------------------------

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
                signal: expect.any(AbortSignal),
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

        describe("the request deadline", () => {
            beforeEach(() => {
                vi.useFakeTimers();
            });
            afterEach(() => {
                vi.useRealTimers();
            });

            function heldCounts() {
                const requests: { text: string; signal: AbortSignal; resolve: (response: Response) => void }[] = [];
                const fetchImpl = vi.fn<typeof fetch>(
                    (_url, init) =>
                        new Promise<Response>((resolve, reject) => {
                            const signal = init!.signal!;
                            const body = JSON.parse(String(init!.body));
                            requests.push({ text: body.contents[0].parts[0].text, signal, resolve });
                            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                        }),
                );
                return { requests, fetchImpl };
            }

            it("shares in-flight counts by text and model and aborts the request only when its last caller aborts", async () => {
                const { tokenizers } = stubTokenizers();
                const { requests, fetchImpl } = heldCounts();
                const counter = createTokenCounter({ tokenizers, fetchImpl });
                const first = new AbortController();
                const survivor = new AbortController();
                const withdrawn = counter.count("shared", google(), first.signal);
                const surviving = counter.count("shared", google(), survivor.signal);
                const otherModel = counter.count(
                    "shared",
                    google({
                        model: { tokenizer: LLMTokenizer.GoogleCloud, internalID: "model-B" },
                    }),
                );
                const settled = Promise.allSettled([withdrawn, surviving, otherModel]);
                try {
                    expect(fetchImpl).toHaveBeenCalledTimes(2);
                    const reason = new Error("one caller left");
                    first.abort(reason);
                    await expect(withdrawn).rejects.toBe(reason);
                    expect(requests[0].signal.aborted).toBe(false);
                    requests[0].resolve(ok(7));
                    requests[1].resolve(ok(19));
                    await expect(surviving).resolves.toBe(7);
                    await expect(otherModel).resolves.toBe(19);
                } finally {
                    first.abort();
                    survivor.abort();
                    for (const request of requests) request.resolve(ok(1));
                    await settled;
                }

                const left = new AbortController();
                const right = new AbortController();
                const a = counter.count("cancel shared", google(), left.signal);
                const b = counter.count("cancel shared", google(), right.signal);
                const canceled = Promise.allSettled([a, b]);
                try {
                    expect(fetchImpl).toHaveBeenCalledTimes(3);
                    const reasonA = new Error("first left");
                    left.abort(reasonA);
                    await expect(a).rejects.toBe(reasonA);
                    expect(requests[2].signal.aborted).toBe(false);

                    const reasonB = new Error("last left");
                    right.abort(reasonB);
                    await expect(b).rejects.toBe(reasonB);
                    expect(requests[2].signal.aborted).toBe(true);
                    expect(requests[2].signal.reason).toBe(reasonB);
                } finally {
                    left.abort();
                    right.abort();
                    for (const request of requests) request.resolve(ok(1));
                    await canceled;
                }
            });

            it("keeps at most eight Google count requests outstanding and runs waiting counts as slots open", async () => {
                const { tokenizers } = stubTokenizers();
                const { requests, fetchImpl } = heldCounts();
                const counter = createTokenCounter({ tokenizers, fetchImpl });
                const caller = new AbortController();
                const counts = Array.from({ length: 10 }, (_, i) =>
                    counter.count(`item ${i}`, google(), caller.signal),
                );
                const settled = Promise.allSettled(counts);
                const answer = (request: (typeof requests)[number]) =>
                    request.resolve(ok(Number(request.text.slice(5)) + 1));
                try {
                    expect(fetchImpl).toHaveBeenCalledTimes(8);
                    answer(requests[0]);
                    await vi.advanceTimersByTimeAsync(0);
                    expect(fetchImpl).toHaveBeenCalledTimes(9);
                    answer(requests[1]);
                    await vi.advanceTimersByTimeAsync(0);
                    expect(fetchImpl).toHaveBeenCalledTimes(10);
                    for (const request of requests.slice(2)) answer(request);
                    await expect(Promise.all(counts)).resolves.toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
                } finally {
                    caller.abort();
                    for (const request of requests) answer(request);
                    await settled;
                }
            });

            it("rejects a pending count with the caller's exact abort reason without a local fallback", async () => {
                const { tokenizers, calls } = stubTokenizers();
                const fetchImpl = vi.fn<typeof fetch>(
                    (_url, init) =>
                        new Promise<Response>((_resolve, reject) => {
                            const signal = init?.signal;
                            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
                        }),
                );
                const counter = createTokenCounter({ tokenizers, fetchImpl });
                const caller = new AbortController();
                const reason = new Error("The tab edited the text");
                const count = counter.count("count me", google(), caller.signal);
                const rejected = vi.fn();
                void count.catch(rejected);
                expect(fetchImpl).toHaveBeenCalledTimes(1);

                caller.abort(reason);
                await vi.advanceTimersByTimeAsync(0);
                expect(rejected).toHaveBeenCalledTimes(1);
                await expect(count).rejects.toBe(reason);
                expect(calls).toEqual([]);
            });

            it("keeps the 30 second deadline when the caller's signal never aborts", async () => {
                const { tokenizers, calls } = stubTokenizers();
                const fetchImpl = vi.fn<typeof fetch>(
                    (_url, init) =>
                        new Promise<Response>((_resolve, reject) => {
                            const signal = init?.signal;
                            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
                        }),
                );
                const counter = createTokenCounter({ tokenizers, fetchImpl });
                const caller = new AbortController();
                const resolved = vi.fn();
                const rejected = vi.fn();
                void counter.count("count me", google(), caller.signal).then(resolved, rejected);

                await vi.advanceTimersByTimeAsync(GOOGLE_COUNT_TIMEOUT_MS - 1);
                expect(resolved).not.toHaveBeenCalled();
                expect(rejected).not.toHaveBeenCalled();

                await vi.advanceTimersByTimeAsync(1);
                expect(resolved).not.toHaveBeenCalled();
                expect(rejected).toHaveBeenCalledTimes(1);
                const [error] = rejected.mock.calls[0];
                expect(error).toBeInstanceOf(Error);
                expect(error.message).toBe("The Google token count timed out after 30 seconds");
                expect(caller.signal.aborted).toBe(false);
                expect(calls).toEqual([]);
            });

            it.each(["headers", "body"] as const)(
                "rejects count at 30 seconds without a local fallback while waiting for response %s",
                async (phase) => {
                    const { tokenizers, calls } = stubTokenizers();
                    const fetchImpl = vi.fn<typeof fetch>((_url, init) => {
                        const signal = init?.signal;
                        if (phase === "headers") {
                            return new Promise<Response>((_resolve, reject) => {
                                signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
                            });
                        }
                        // Headers arrive immediately; the body stays open until the request is aborted.
                        return Promise.resolve(
                            new Response(
                                new ReadableStream({
                                    start(controller) {
                                        signal?.addEventListener("abort", () => controller.error(signal.reason), {
                                            once: true,
                                        });
                                    },
                                }),
                            ),
                        );
                    });
                    const counter = createTokenCounter({ tokenizers, fetchImpl });
                    const resolved = vi.fn();
                    const rejected = vi.fn();
                    void counter.count("count me", google()).then(resolved, rejected);
                    const signal = fetchImpl.mock.calls[0][1]?.signal;
                    expect(signal).toBeInstanceOf(AbortSignal);
                    expect(GOOGLE_COUNT_TIMEOUT_MS).toBe(30_000);

                    await vi.advanceTimersByTimeAsync(GOOGLE_COUNT_TIMEOUT_MS - 1);
                    expect(resolved).not.toHaveBeenCalled();
                    expect(rejected).not.toHaveBeenCalled();
                    expect(signal?.aborted).toBe(false);

                    await vi.advanceTimersByTimeAsync(1);
                    expect(resolved).not.toHaveBeenCalled();
                    expect(rejected).toHaveBeenCalledTimes(1);
                    const [error] = rejected.mock.calls[0];
                    expect(error).toBeInstanceOf(Error);
                    expect(error).not.toBeInstanceOf(DOMException);
                    expect(error.message).toMatch(/Google token count timed out/i);
                    expect(error.message).not.toMatch(/timeout/i);
                    expect(signal?.aborted).toBe(true);
                    expect(calls).toEqual([]);
                },
            );

            it("does not abort a successful count after its deadline", async () => {
                const { tokenizers, calls } = stubTokenizers();
                const fetchImpl = vi.fn<typeof fetch>(async () => ok(7));
                const counter = createTokenCounter({ tokenizers, fetchImpl });
                expect(await counter.count("count me", google())).toBe(7);
                const signal = fetchImpl.mock.calls[0][1]?.signal;
                expect(signal).toBeInstanceOf(AbortSignal);

                await vi.advanceTimersByTimeAsync(GOOGLE_COUNT_TIMEOUT_MS);
                expect(signal?.aborted).toBe(false);
                expect(calls).toEqual([]);
            });
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
            // The two-scope case: the cache key carries the model's internalID.
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
});

describe("ChatTokenCounter (the shared token arithmetic)", () => {
    const make = (
        chatAdditionalTokens: number,
        useName: "name" | "noName",
        host: Partial<ConstructorParameters<typeof ChatTokenCounter>[2]> = {},
    ) =>
        new ChatTokenCounter(chatAdditionalTokens, useName, {
            count: async (text) => text.length,
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

    it("counts an image by the model's rule (the GPT-4o tile fallback for a host without a model): 85 plus 170 per 512-pixel tile after the documented downscaling, with no per-image overhead", () => {
        const counter = make(3, "noName");
        const image = (width?: number, height?: number) => ({ type: "image" as const, base64: "", width, height });
        expect(counter.tokenizeMultiModal(image(512, 512))).toBe(85 + 170);
        expect(counter.tokenizeMultiModal(image(1024, 1024))).toBe(85 + 4 * 170);
        // Over 768 on the shorter side: fit within 2048, then the shorter side to 768 and the other
        // floored (768 x 1536: six tiles), not the inherited one-side clamp that kept the height at 2000.
        expect(counter.tokenizeMultiModal(image(1000, 2000))).toBe(85 + 6 * 170);
        expect(counter.tokenizeMultiModal(image(2000, 1000))).toBe(85 + 6 * 170);
        // Missing dimensions count as a 512 x 512 image: one tile.
        expect(counter.tokenizeMultiModal(image())).toBe(85 + 170);
    });

    it("counts an image at low vision quality as the model's base tokens, and as the additional tokens when inlay images are unsupported", () => {
        const image = { type: "image" as const, base64: "", width: 4000, height: 4000 };
        expect(make(3, "noName", { gptVisionQuality: () => "low" }).tokenizeMultiModal(image)).toBe(85);
        expect(
            make(3, "noName", { supportsInlayImage: () => false, gptVisionQuality: () => "low" }).tokenizeMultiModal(
                image,
            ),
        ).toBe(3);
        // An unset quality counts as high: 4000 x 4000 fits within 2048, then 768 x 768, four tiles.
        expect(make(3, "noName", { gptVisionQuality: () => undefined }).tokenizeMultiModal(image)).toBe(85 + 4 * 170);
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
        expect(await counter.tokenizeChat(message)).toBe(3 + 1 + (85 + 170) + (85 + 4 * 170));
        expect(await counter.tokenizeChats([message, { role: "assistant", content: "de", name: "n" }])).toBe(
            3 + 1 + (85 + 170) + (85 + 4 * 170) + (2 + 1 + 1 + 1),
        );
    });
});
