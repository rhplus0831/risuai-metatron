import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { readTokenizerPayload } from "./payloads.ts";

export type WebTokenizer = { encode(text: string): Int32Array; dispose(): void };

type WebTokenizersModule = {
    Tokenizer: {
        fromJSON(json: ArrayBuffer): Promise<WebTokenizer>;
        fromSentencePiece(model: ArrayBuffer): Promise<WebTokenizer>;
    };
};

const require = createRequire(import.meta.url);
let modulePromise: Promise<WebTokenizersModule> | null = null;
let factoryQueue: Promise<unknown> = Promise.resolve();

/**
 * `@mlc-ai/web-tokenizers` 0.1.6 ships a UMD bundle in a `type: module` package: an ESM import
 * fails on its `require('url')`. It is compiled here as the CommonJS function it is, with the main
 * context's loader for the `import('module')` inside it. No Node flag is needed. A version bump
 * needs a re-check of the wrapper shape.
 */
function loadWebTokenizersModule(): Promise<WebTokenizersModule> {
    modulePromise ??= (async () => {
        const filename = require.resolve("@mlc-ai/web-tokenizers");
        const source = await fs.readFile(filename, "utf8");
        const wrapper = vm.compileFunction(source, ["exports", "require", "module", "__filename", "__dirname"], {
            filename,
            importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        });
        const module = { exports: {} as Record<string, unknown> };
        wrapper.call(module.exports, module.exports, createRequire(filename), module, filename, path.dirname(filename));
        return module.exports as unknown as WebTokenizersModule;
    })().catch((error: unknown) => {
        modulePromise = null;
        throw error;
    });
    return modulePromise;
}

export async function loadWebTokenizer(
    rootDir: string,
    format: "json" | "sentencepiece",
    relPath: string,
): Promise<WebTokenizer> {
    const [{ Tokenizer }, payload] = await Promise.all([
        loadWebTokenizersModule(),
        readTokenizerPayload(rootDir, relPath),
    ]);
    // Each factory call starts the package's wasm binding while none is set; concurrent first calls
    // each start one, the last overwrites the shared binding, and the tokenizers the others built
    // fail to encode (`Expected null or instance of VectorInt`). Factory calls run one at a time.
    const tokenizer = factoryQueue.then(() =>
        format === "json" ? Tokenizer.fromJSON(payload) : Tokenizer.fromSentencePiece(payload),
    );
    factoryQueue = tokenizer.catch(() => {});
    return await tokenizer;
}
