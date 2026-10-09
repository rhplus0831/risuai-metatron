// Captures the browser path's token ids for the Phase 5 tokenizer parity fixture
// (server/src/tests/fixtures/tokens/browser-ids.json; the procedure is in that folder's README):
// the client's own `encodeWithTokenizer` and `encode`, on the Vite dev stack, in a fresh headless
// Chrome context. The server tokenizers must reproduce these ids (server/src/tests/tokenParity.test.ts and tokenPlainNode.test.ts).
//
// Usage: node util/playwright/captureTokenizerIds.mjs [outFile]
import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { chromePath, openApp, repoRoot, startStack } from "./stack.mjs";

const outFile = path.resolve(
    process.argv[2] ?? path.join(repoRoot, "server/src/tests/fixtures/tokens/browser-ids.json"),
);

const TEXTS = {
    ascii: "hello world",
    mixed: "안녕하세요, 世界! Привет 👋🏽 café — naïve",
    markup: "<s>[INST] {{char}} says hi [/INST]</s>\n\n    def f(x):\n\treturn x ** 2  # done",
    empty: "",
    combining: "é ẹ́ 각‍글 שָׁלוֹם 👨‍👩‍👧‍👦 🏳️‍🌈 نّ ﷺ Ａ　​﻿",
    special: "a <|endoftext|> b <|im_start|>user<|im_end|> <s> </s> [INST] <|eot_id|>",
    long: { unit: "The quick brown fox jumps over the lazy dog. 다람쥐 헌 쳇바퀴에 타고파. ", times: 2000 },
};

const stack = await startStack({ serverPort: 6192, vitePort: 5292 });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
try {
    const context = await browser.newContext();
    await context.route("https://generativelanguage.googleapis.com/**", (route) =>
        route.fulfill({ status: 500, body: "{}" }),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
    await openApp(page, stack.baseURL);
    const families = await page.evaluate(async (texts) => {
        const tk = await import("/src/ts/tokenizer.ts");
        const { characterList } = await import("/src/ts/storage/characterStore.svelte.ts");
        const { readSettingsRoot, writeSettingsRoot } = await import("/src/ts/storage/settingsViews.svelte.ts");
        const fnv = (ids) => {
            let h = 0x811c9dc5;
            for (const ch of Array.from(ids).join(",")) {
                h ^= ch.charCodeAt(0);
                h = Math.imul(h, 0x01000193) >>> 0;
            }
            return h;
        };
        const materialize = (t) => (typeof t === "string" ? t : t.unit.repeat(t.times));
        const record = async (fn, name) => {
            try {
                const ids = await fn(materialize(texts[name]));
                return name === "long" ? { count: ids.length, hash: fnv(ids) } : { ids: Array.from(ids) };
            } catch (e) {
                return { error: e instanceof Error ? e.message : String(e) };
            }
        };
        const direct = {
            tik: "cl100k_base",
            novellist: "novellist",
            claude: "claude",
            novelai: "novelai",
            llama: "llama",
            mistral: "mistral",
            llama3: "llama3",
            gemma: "gemma",
            cohere: "cohere",
            deepseek: "DeepSeek",
            "deepseek-v4": "DeepSeekV4",
            glm4: "GLM4",
            glm5: "GLM5",
        };
        const out = {};
        for (const [type, family] of Object.entries(direct)) {
            out[family] = {};
            for (const name of Object.keys(texts))
                out[family][name] = await record((t) => tk.encodeWithTokenizer(t, type), name);
        }
        writeSettingsRoot("useTokenizerCaching", false);
        const { applyModelFixtureSettings } = await import("/util/playwright/modelProfiles.browser.mjs");
        applyModelFixtureSettings({ aiModel: "openrouter", customTokenizer: "tik" });
        out.o200k_base = {};
        for (const name of Object.keys(texts)) out.o200k_base[name] = await record((t) => tk.encode(t), name);
        applyModelFixtureSettings({ aiModel: "gemini-2.5-flash-image" });
        writeSettingsRoot("googleClaudeTokenizing", true);
        out.gemmaSentencePiece = {};
        for (const name of Object.keys(texts)) out.gemmaSentencePiece[name] = await record((t) => tk.encode(t), name);
        return out;
    }, TEXTS);
    const fixture = {
        provenance: {
            commit: execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim(),
            capturedAt: new Date().toISOString(),
            chrome: execSync(`"${chromePath}" --version`).toString().trim(),
            client: "src/ts/tokenizer.ts unchanged at the commit above, Vite dev stack (util/playwright/stack.mjs)",
            capture:
                "encodeWithTokenizer(text, type) for the thirteen tokenizerList types; encode(text) with aiModel=openrouter and customTokenizer=tik for o200k_base; encode(text) with aiModel=gemini-2.5-flash-image and googleClaudeTokenizing=true, the Google countTokens request answered 500, for gemmaSentencePiece (the client's failed-Google-count fallback); useTokenizerCaching=false",
            long: "the long text is unit.repeat(times); only its token count and the FNV-1a 32-bit hash of the ids joined by commas are recorded",
            errors: "an entry with error is what the client threw for that text",
        },
        texts: TEXTS,
        families,
    };
    await mkdir(path.dirname(outFile), { recursive: true });
    await writeFile(outFile, JSON.stringify(fixture, null, 2) + "\n");
    console.log("families", Object.keys(families).length, "pageerrors", JSON.stringify(errors));
} finally {
    await browser.close();
    await stack.stop();
}
