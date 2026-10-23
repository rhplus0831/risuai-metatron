// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMTokenizer } from "../../../shared/llm.ts";
import { encodeSecretPath } from "../../../shared/llmSecrets.ts";
import type { TabTokenScope } from "../../../shared/tokenizerChoice.ts";
import { createServerContext } from "../app.ts";
import { createTokenizers } from "../prompt/tokenizers/index.ts";
import { createTokenCounter, type TokenCountScope } from "../prompt/tokens.ts";
import { createAuthStore } from "../routes/auth.ts";
import {
    MAX_TOKEN_BODY_BYTES,
    MAX_TOKEN_TEXTS,
    registerTokenRoutes,
    TOKEN_COUNT_PATH,
    TOKEN_ENCODE_PATH,
} from "../routes/tokens.ts";
import type { AppEnv } from "../types.ts";
import { createSigner, json } from "./testSupport.ts";
import { fixture, materialize, REPO_ROOT } from "./tokenFixtures.ts";

const tabScope: TabTokenScope = {
    aiModel: "gpt-3.5-turbo",
    currentPluginProvider: "",
    modelTokenizer: LLMTokenizer.tiktokenCl100kBase,
    pluginTokenizer: "none",
    customTokenizer: "tik",
    googleClaudeTokenizing: false,
    useTokenizerCaching: false,
};
const googleScope: TabTokenScope = {
    ...tabScope,
    aiModel: "gemini-3-flash-preview",
    modelTokenizer: LLMTokenizer.GoogleCloud,
    modelInternalID: "gemini-3-flash-preview",
    googleClaudeTokenizing: true,
};
const GOOGLE_KEY = "AIza-token-route-STORED-KEY";
const mixed = materialize(fixture.texts.mixed);
const tokenizers = createTokenizers({ rootDir: REPO_ROOT });
const counter = createTokenCounter({ tokenizers });
const fetchImpl = vi.fn<typeof fetch>();
let context: ReturnType<typeof createServerContext>;
let savePath: string;
let headers: Record<string, string>;

function browserIds(family: string, textName: string): number[] {
    const record = fixture.families[family][textName];
    if (!("ids" in record)) {
        throw new Error(`No captured ids for ${family}/${textName}`);
    }
    return record.ids;
}

// Build the oracle's scope independently of the route's wire-scope conversion.
function counterScope(scope: TabTokenScope): TokenCountScope {
    const { modelTokenizer, modelInternalID, ...settings } = scope;
    return {
        ...settings,
        model: { tokenizer: modelTokenizer, internalID: modelInternalID },
        googleAccessToken: GOOGLE_KEY,
    };
}

beforeAll(async () => {
    // Freeze only Date: JWT expiry and rate-limit windows must not race test work.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T00:00:00Z"));
    vi.stubGlobal("fetch", fetchImpl);
    savePath = mkdtempSync(path.join(os.tmpdir(), "risu-token-routes-"));
    context = createServerContext({ rootDir: REPO_ROOT, savePath });
    const signer = await createSigner();
    expect((await context.app.request("/api/set_password", json({ password: "pw" }))).status).toBe(200);
    expect(
        (await context.app.request("/api/login", json({ password: "pw", publicKey: signer.publicJwk }))).status,
    ).toBe(200);
    headers = { "risu-auth": await signer.jwt() };
    const current = await context.app.request("/api/resources/llmSecrets/main", { headers });
    expect(current.status).toBe(200);
    const { revision, epoch } = (await current.json()) as { revision: string; epoch: string };
    const stored = await context.app.request(
        `/api/llm-secrets/${encodeSecretPath({ kind: "nested", field: "google" })}`,
        {
            ...json({ value: GOOGLE_KEY, baseRevision: revision }, { ...headers, "x-resource-epoch": epoch }),
            method: "PUT",
        },
    );
    expect(stored.status).toBe(200);
});

beforeEach(() => {
    fetchImpl.mockReset();
    fetchImpl.mockImplementation(async () => Response.json({ totalTokens: 37 }));
});

afterAll(async () => {
    try {
        await context?.dispose();
        await tokenizers.dispose();
    } finally {
        if (savePath) rmSync(savePath, { recursive: true, force: true });
        vi.unstubAllGlobals();
        vi.useRealTimers();
    }
});

const routes = [
    { name: "count", route: TOKEN_COUNT_PATH, body: { scope: tabScope, texts: [mixed] } },
    { name: "encode", route: TOKEN_ENCODE_PATH, body: { tokenizer: "tik", text: mixed } },
];

describe("token routes", () => {
    it.each(routes)("$name authenticates before reading the body or tokenizing", async ({ route, body }) => {
        const count = vi.fn(counter.count);
        const encode = vi.fn(tokenizers.encode);
        const app = new Hono<AppEnv>();
        registerTokenRoutes(app, {
            counter: { ...counter, count },
            tokenizers: { ...tokenizers, encode },
            googleAccessToken: () => GOOGLE_KEY,
            auth: createAuthStore(savePath),
            limiter: async (_c, next) => next(),
            maintenance: context.snapshots.gate,
            shuttingDown: () => false,
        });
        // Exercise the full app's middleware too: a global body limiter must not preread these routes.
        for (const boundary of [context.app, app]) {
            const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
                controller.enqueue(Buffer.from(JSON.stringify(body)));
                controller.close();
            });
            const request = new Request(`http://localhost${route}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 }),
                duplex: "half",
            } as RequestInit);
            const response = await boundary.request(request);
            expect(response.status).toBe(400);
            expect(await response.json()).toEqual({ error: "No auth header" });
            expect(pull).not.toHaveBeenCalled();
            expect(count).not.toHaveBeenCalled();
            expect(encode).not.toHaveBeenCalled();
        }
    });

    it.each(routes)("$name rejects malformed JSON and request fields with 400", async ({ name, route }) => {
        const invalid =
            name === "count"
                ? [
                      {},
                      { scope: {}, texts: [mixed] },
                      { scope: { ...tabScope, modelInternalID: null }, texts: [mixed] },
                      { scope: { ...tabScope, useTokenizerCaching: undefined }, texts: [mixed] },
                      { scope: tabScope, texts: mixed },
                      { scope: tabScope, texts: [mixed, null] },
                  ]
                : [{}, { tokenizer: 1, text: mixed }, { tokenizer: "tik", text: [mixed] }];
        for (const body of ["{", "null", "[]", ...invalid.map((value) => JSON.stringify(value))]) {
            const response = await context.app.request(route, {
                method: "POST",
                headers: { ...headers, "content-type": "application/json" },
                body,
            });
            expect(response.status, body).toBe(400);
        }
    });

    it.each(routes)("$name caps received body bytes at MAX_TOKEN_BODY_BYTES", async ({ name, route, body }) => {
        const encoded = JSON.stringify(body);
        const atLimit = " ".repeat(MAX_TOKEN_BODY_BYTES - Buffer.byteLength(encoded)) + encoded;
        const expected =
            name === "count"
                ? { counts: [browserIds("cl100k_base", "mixed").length] }
                : { ids: browserIds("cl100k_base", "mixed") };
        // Multibyte text makes the byte cap distinct from a JavaScript string-length cap.
        // An understated Content-Length must not bypass the received-byte check.
        for (const extraHeaders of [{}, { "content-length": "1" }]) {
            const init = {
                method: "POST",
                headers: { ...headers, "content-type": "application/json", ...extraHeaders },
            };
            const accepted = await context.app.request(route, { ...init, body: atLimit });
            expect(accepted.status).toBe(200);
            expect(await accepted.json()).toEqual(expected);
            const refused = await context.app.request(route, { ...init, body: " " + atLimit });
            expect(refused.status).toBe(413);
        }
    });

    it("count accepts MAX_TOKEN_TEXTS texts and refuses one more with 413", async () => {
        const texts = Array<string>(MAX_TOKEN_TEXTS).fill("");
        const accepted = await context.app.request(TOKEN_COUNT_PATH, json({ scope: tabScope, texts }, headers));
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toEqual({ counts: texts.map(() => browserIds("cl100k_base", "empty").length) });
        const refused = await context.app.request(
            TOKEN_COUNT_PATH,
            json({ scope: tabScope, texts: [...texts, ""] }, headers),
        );
        expect(refused.status).toBe(413);
    });

    it.each([
        { family: "cl100k_base", aiModel: "gpt-3.5-turbo", modelTokenizer: LLMTokenizer.tiktokenCl100kBase },
        { family: "claude", aiModel: "claude-3-sonnet", modelTokenizer: LLMTokenizer.Claude },
    ])("count matches the counter for the tab's $family scope", async ({ aiModel, modelTokenizer }) => {
        const scope: TabTokenScope = { ...tabScope, aiModel, modelTokenizer };
        const texts = [mixed, "", materialize(fixture.texts.ascii)];
        const counts = await Promise.all(texts.map((text) => counter.count(text, counterScope(scope))));
        const response = await context.app.request(TOKEN_COUNT_PATH, json({ scope, texts }, headers));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ counts });
    });

    it("count returns null only for the refused text and continues counting its neighbors", async () => {
        const response = await context.app.request(
            TOKEN_COUNT_PATH,
            json({ scope: tabScope, texts: [materialize(fixture.texts.ascii), "<|endoftext|>", mixed] }, headers),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            counts: [browserIds("cl100k_base", "ascii").length, null, browserIds("cl100k_base", "mixed").length],
        });
    });

    it("count does not turn a Google transport failure into a null text count", async () => {
        fetchImpl.mockRejectedValueOnce(new TypeError("countTokens transport failed"));
        const response = await context.app.request(
            TOKEN_COUNT_PATH,
            json({ scope: googleScope, texts: ["transport failure"] }, headers),
        );
        expect(response.status).toBe(500);
    });

    it("count uses cl100k_base for a legacy plugin custom tokenizer", async () => {
        const response = await context.app.request(
            TOKEN_COUNT_PATH,
            json(
                {
                    scope: {
                        ...tabScope,
                        aiModel: "custom",
                        currentPluginProvider: "legacy-provider",
                        pluginTokenizer: "custom",
                        modelTokenizer: LLMTokenizer.Claude,
                    },
                    texts: [mixed],
                },
                headers,
            ),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ counts: [browserIds("cl100k_base", "mixed").length] });
    });

    it("count sends the stored Google key and the tab's model and text to countTokens", async () => {
        const text = "count this with Google";
        const googleCounter = createTokenCounter({ tokenizers, fetchImpl });
        const expected = await googleCounter.count(text, counterScope(googleScope));
        fetchImpl.mockClear();
        const response = await context.app.request(
            TOKEN_COUNT_PATH,
            json({ scope: googleScope, texts: [text] }, headers),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ counts: [expected] });
        expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:countTokens?key=${GOOGLE_KEY}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
                signal: expect.any(AbortSignal),
            },
        );
    });

    it.each([
        { tokenizer: "tik", family: "cl100k_base" },
        { tokenizer: "llama3", family: "llama3" },
    ])("encode returns the captured browser ids for $tokenizer", async ({ tokenizer, family }) => {
        const response = await context.app.request(TOKEN_ENCODE_PATH, json({ tokenizer, text: mixed }, headers));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ids: browserIds(family, "mixed") });
    });
});
