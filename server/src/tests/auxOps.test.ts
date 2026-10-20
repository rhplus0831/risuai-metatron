// @vitest-environment node
import http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeSecretPath, type SecretPath } from "../../../shared/llmSecrets.ts";
import { AUX_OPS, planAuxOp, type AuxOpName } from "../llm/auxOps.ts";
import { allowListenerOrigin, createResourceTestClient, type ResourceTestClient } from "./testSupport.ts";

// Phase 5 slice 7b (`request-layer-and-llm-secrets.md`): the twelve auxiliary operations added for
// the browser's model discovery, account, and count calls (`server/src/llm/auxOps.ts`, the
// `risu-aux-op` branch of `/proxy2` in `server/src/routes/proxy.ts`), table-driven against a local
// recording upstream: each row's origin, method, path, query allowlist, injection (bearer,
// `x-api-key`, or the `key` query), a GET without a body, a missing key, no redirect followed; and
// the response policy of the slice: a successful JSON answer is checked as the tab would read it
// (text and decoded, values and property names) and refused with 502 when it carries the stored
// credential (as stored or as injected, trimmed); a JSON error carrying it is refused as a whole; a
// non-JSON body passes; a body that fails mid-read or is not JSON is a 502, never an empty success.
// The six original rows are covered in `llmRoutes.test.ts`.

const SECRET = {
    openai: "sk-openai-SENTINEL-2222",
    claude: "sk-ant-SENTINEL-3333",
    openrouter: "sk-or-SENTINEL-4444",
    nanogpt: "ng-SENTINEL-5555",
    ollama: "ol-SENTINEL-6666",
    google: "AIza-google-SENTINEL-7777",
};
const ORIGINS = [
    "https://api.openai.com",
    "https://generativelanguage.googleapis.com",
    "https://api.anthropic.com",
    "https://openrouter.ai",
    "https://nano-gpt.com",
    "https://ollama.com",
];

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };
type Mode =
    | "json"
    | "echo-plain"
    | "echo-escaped"
    | "echo-key-name"
    | "echo-header"
    | "error-json-escaped"
    | "broken"
    | "not-json"
    | "vtt"
    | "redirect";
const upstreamRequests: Seen[] = [];
let upstreamMode: Mode = "json";
let upstream: { url: string; close(): void };
const realFetch = globalThis.fetch;

/** The credential the upstream received: the bearer, the `x-api-key` header, or the `key` query. */
function credentialOf(seen: Seen): string {
    const auth = seen.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
        return auth.slice("Bearer ".length);
    }
    const key = seen.headers["x-api-key"];
    if (typeof key === "string") {
        return key;
    }
    return new URL(seen.url, "http://x").searchParams.get("key") ?? "";
}

/** Every character as a JSON `\uXXXX` escape: what a text match cannot see, and the tab decodes. */
const escaped = (text: string) =>
    [...text].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");

async function startUpstream() {
    const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(chunk as Buffer);
        }
        const seen: Seen = {
            method: req.method ?? "",
            url: req.url ?? "",
            headers: req.headers,
            body: Buffer.concat(chunks),
        };
        upstreamRequests.push(seen);
        const credential = credentialOf(seen);
        const json = { "content-type": "application/json", "x-upstream": "aux" };
        switch (upstreamMode) {
            case "redirect":
                res.writeHead(302, { location: "/elsewhere" });
                res.end("moved");
                return;
            case "echo-plain":
                res.writeHead(200, json);
                res.end(JSON.stringify({ data: [{ id: "m" }], token: credential }));
                return;
            case "echo-escaped":
                res.writeHead(200, json);
                res.end(`{"data":[{"id":"m"}],"token":"${escaped(credential)}"}`);
                return;
            case "echo-key-name":
                res.writeHead(200, json);
                res.end(`{"data":[],"${escaped(credential)}":1}`);
                return;
            case "echo-header":
                res.writeHead(200, { ...json, "x-provider-debug": `key was ${credential}` });
                res.end(JSON.stringify({ data: [{ id: "m" }] }));
                return;
            case "error-json-escaped":
                res.writeHead(401, { ...json, "x-provider-debug": `key was ${credential}` });
                res.end(`{"error":{"message":"rejected ${escaped(credential)}"}}`);
                return;
            case "broken":
                // The headers and a first chunk arrive; the socket dies before the body ends.
                res.writeHead(200, json);
                res.flushHeaders();
                res.write('{"data":[{"id":"m"},', () => setTimeout(() => res.destroy(), 20));
                return;
            case "not-json":
                res.writeHead(200, json);
                res.end("not json at all");
                return;
            case "vtt":
                res.writeHead(200, { "content-type": "text/vtt", "x-upstream": "aux" });
                res.end("WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n");
                return;
            default: {
                // The echoed path carries no `key` parameter (the query rows inject the credential there).
                const url = new URL(seen.url, "http://x");
                url.searchParams.delete("key");
                res.writeHead(200, json);
                res.end(JSON.stringify({ ok: true, path: url.pathname + url.search, method: seen.method }));
            }
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    allowListenerOrigin(server);
    const { port } = server.address() as { port: number };
    return {
        url: `http://127.0.0.1:${port}`,
        close() {
            server.closeAllConnections();
            server.close();
        },
    };
}

let client: ResourceTestClient;

async function writeSecret(target: SecretPath, value: string) {
    const current = (await (await client.get("llmSecrets", "main")).json()) as { revision: string };
    const res = await client.json(
        `/api/llm-secrets/${encodeSecretPath(target)}`,
        { value, baseRevision: current.revision },
        { method: "PUT" },
    );
    expect(res.status).toBe(200);
}

async function seed(overrides: Partial<typeof SECRET> = {}) {
    client = await createResourceTestClient();
    const values = { ...SECRET, ...overrides };
    await writeSecret({ kind: "flat", field: "openAIKey" }, values.openai);
    await writeSecret({ kind: "flat", field: "claudeAPIKey" }, values.claude);
    await writeSecret({ kind: "flat", field: "openrouterKey" }, values.openrouter);
    await writeSecret({ kind: "flat", field: "nanogptKey" }, values.nanogpt);
    await writeSecret({ kind: "flat", field: "ollamaApiKey" }, values.ollama);
    await writeSecret({ kind: "nested", field: "google" }, values.google);
}

const aux = (
    name: string,
    url: string,
    init: {
        method?: "GET" | "POST";
        headers?: Record<string, string>;
        body?: string;
        profileId?: string;
        rawHeaders?: boolean;
    } = {},
) => {
    const method = init.method ?? AUX_OPS[name as AuxOpName]?.method ?? "GET";
    return client.request("/proxy2", {
        method,
        headers: {
            "risu-aux-op": name,
            "risu-url": encodeURIComponent(url),
            ...(init.rawHeaders
                ? init.headers
                : {
                      "risu-header": encodeURIComponent(
                          JSON.stringify(init.headers ?? { "content-type": "application/json" }),
                      ),
                  }),
            ...(init.profileId !== undefined ? { "risu-aux-profile": init.profileId } : {}),
        },
        ...(method === "GET" ? {} : { body: init.body ?? JSON.stringify({ input: name }) }),
    });
};

beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    upstream = await startUpstream();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        for (const origin of ORIGINS) {
            if (url.startsWith(origin)) {
                return realFetch(upstream.url + url.slice(origin.length), init);
            }
        }
        return realFetch(input, init);
    }) as typeof fetch;
});
afterAll(() => {
    globalThis.fetch = realFetch;
    upstream.close();
    vi.restoreAllMocks();
});
beforeEach(() => {
    upstreamRequests.length = 0;
    upstreamMode = "json";
});
afterEach(async () => {
    await client?.close();
});

type Row = [AuxOpName, "GET" | "POST", string, string, "bearer" | "x-api-key" | "query", string];
const ROWS: Row[] = [
    [
        "google-models",
        "GET",
        "https://generativelanguage.googleapis.com/v1beta/models",
        "/v1beta/models",
        "query",
        SECRET.google,
    ],
    ["anthropic-models", "GET", "https://api.anthropic.com/v1/models", "/v1/models", "x-api-key", SECRET.claude],
    ["openai-models", "GET", "https://api.openai.com/v1/models", "/v1/models", "bearer", SECRET.openai],
    [
        "openrouter-providers",
        "GET",
        "https://openrouter.ai/api/v1/providers",
        "/api/v1/providers",
        "bearer",
        SECRET.openrouter,
    ],
    ["openrouter-models", "GET", "https://openrouter.ai/api/v1/models", "/api/v1/models", "bearer", SECRET.openrouter],
    [
        "nanogpt-balance",
        "POST",
        "https://nano-gpt.com/api/check-balance",
        "/api/check-balance",
        "x-api-key",
        SECRET.nanogpt,
    ],
    [
        "nanogpt-subscription",
        "GET",
        "https://nano-gpt.com/api/subscription/v1/usage",
        "/api/subscription/v1/usage",
        "bearer",
        SECRET.nanogpt,
    ],
    [
        "nanogpt-subscription-models",
        "GET",
        "https://nano-gpt.com/api/subscription/v1/models?detailed=true",
        "/api/subscription/v1/models?detailed=true",
        "bearer",
        SECRET.nanogpt,
    ],
    [
        "nanogpt-model-providers",
        "GET",
        "https://nano-gpt.com/api/models/vendor%2Fmodel-1/providers",
        "/api/models/vendor%2Fmodel-1/providers",
        "bearer",
        SECRET.nanogpt,
    ],
    [
        "nanogpt-models",
        "GET",
        "https://nano-gpt.com/api/personalized/v1/models?detailed=true",
        "/api/personalized/v1/models?detailed=true",
        "bearer",
        SECRET.nanogpt,
    ],
    ["ollama-cloud-tags", "GET", "https://ollama.com/api/tags", "/api/tags", "bearer", SECRET.ollama],
    [
        "google-count-tokens",
        "POST",
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:countTokens",
        "/v1beta/models/gemini-2.0-flash:countTokens",
        "query",
        SECRET.google,
    ],
];

describe("the discovery, account, and count rows", () => {
    it("send each row with its method to its exact endpoint, inject the stored credential in the row's way, and send no body on a GET", async () => {
        await seed();
        for (const [name, method, url, path, inject, secret] of ROWS) {
            upstreamRequests.length = 0;
            const res = await aux(name, url, {
                method,
                headers: {
                    "content-type": "application/json",
                    "anthropic-version": "2023-06-01",
                    Authorization: "Bearer client-value",
                    "x-api-key": "client-value",
                    "risu-auth": "leak",
                },
            });
            expect(res.status, name).toBe(200);
            expect(res.headers.get("x-upstream"), name).toBe("aux");
            const body = (await res.json()) as { ok: boolean; path: string; method: string };
            expect(body.ok, name).toBe(true);
            expect(upstreamRequests, name).toHaveLength(1);
            const seen = upstreamRequests[0];
            expect(seen.method, name).toBe(method);
            expect(seen.headers["risu-auth"], name).toBeUndefined();
            expect(seen.headers["risu-aux-op"], name).toBeUndefined();
            expect(seen.headers["anthropic-version"], name).toBe("2023-06-01");
            if (inject === "bearer") {
                expect(seen.url, name).toBe(path);
                expect(seen.headers.authorization, name).toBe(`Bearer ${secret}`);
                expect(seen.headers["x-api-key"], name).toBeUndefined();
            } else if (inject === "x-api-key") {
                expect(seen.url, name).toBe(path);
                expect(seen.headers["x-api-key"], name).toBe(secret);
                expect(seen.headers.authorization, name).toBeUndefined();
            } else {
                expect(seen.url, name).toBe(`${path}?key=${encodeURIComponent(secret)}`);
                expect(seen.headers.authorization, name).toBeUndefined();
                expect(seen.headers["x-api-key"], name).toBeUndefined();
            }
            if (method === "GET") {
                expect(seen.body.length, name).toBe(0);
                expect(seen.headers["content-length"], name).toBeUndefined();
                expect(seen.headers["transfer-encoding"], name).toBeUndefined();
            } else {
                expect(seen.body.toString(), name).toBe(JSON.stringify({ input: name }));
            }
            // The answer carries no credential, and no client log would either: the row is the only key holder.
            expect(JSON.stringify(body), name).not.toContain(secret);
        }
    });

    it("refuse another method, origin, path, or query parameter, a redirect, and a missing key, sending nothing or following nothing", async () => {
        await seed({ ollama: "   " });
        const refused: [string, string, "GET" | "POST"][] = [
            ["google-models", "https://generativelanguage.googleapis.com/v1beta/models", "POST"],
            ["nanogpt-balance", "https://nano-gpt.com/api/check-balance", "GET"],
            ["openai-models", "https://evil.example/v1/models", "GET"],
            ["openai-models", "http://api.openai.com/v1/models", "GET"],
            ["openai-models", "https://api.openai.com/v1/models/gpt-4", "GET"],
            ["openai-models", "https://api.openai.com/v1/models?foo=1", "GET"],
            ["nanogpt-models", "https://nano-gpt.com/api/personalized/v1/models?detailed=true&x=1", "GET"],
            ["nanogpt-model-providers", "https://nano-gpt.com/api/models/a/b/providers", "GET"],
            ["anthropic-models", "https://api.anthropic.com/v1/models/", "GET"],
            ["google-count-tokens", "https://generativelanguage.googleapis.com/v1beta/models/../x:countTokens", "POST"],
            [
                "google-count-tokens",
                "https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent",
                "POST",
            ],
            ["ollama-cloud-tags", "https://ollama.com/api/tags", "GET"],
        ];
        for (const [name, url, method] of refused) {
            const res = await aux(name, url, { method });
            expect(res.status, `${name} ${method} ${url}`).toBe(400);
            const text = await res.text();
            for (const secret of Object.values(SECRET)) {
                expect(text).not.toContain(secret);
            }
        }
        expect((await (await aux("ollama-cloud-tags", "https://ollama.com/api/tags")).json()) as unknown).toEqual({
            error: "No credential is stored for ollama-cloud-tags",
        });
        expect(upstreamRequests).toHaveLength(0);
        // A client-sent `key`, `api_key`, or `token` parameter is dropped before the row's own goes in.
        const stripped = await aux(
            "google-models",
            "https://generativelanguage.googleapis.com/v1beta/models?key=client&api_key=client&token=client",
        );
        expect(stripped.status).toBe(200);
        expect(upstreamRequests[0].url).toBe(`/v1beta/models?key=${encodeURIComponent(SECRET.google)}`);
        upstreamMode = "redirect";
        const redirected = await aux("openrouter-models", "https://openrouter.ai/api/v1/models");
        expect(redirected.status).toBe(502);
        expect(((await redirected.json()) as { error: string }).error).toMatch(/redirect/);
        expect(upstreamRequests).toHaveLength(2);
    });
});

describe("the response policy", () => {
    const succeeded = async (name: AuxOpName, url: string) => {
        const res = await aux(name, url);
        expect(res.status, name).toBe(502);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ error: `The ${name} answer carried the stored credential; it is not sent` });
        return text;
    };

    it("refuses a successful JSON answer that carries the credential as text, Unicode-escaped, or as a property name, and passes clean JSON with its headers", async () => {
        await seed();
        for (const mode of ["echo-plain", "echo-escaped", "echo-key-name"] as const) {
            upstreamMode = mode;
            for (const [name, url, secret] of [
                ["openai-models", "https://api.openai.com/v1/models", SECRET.openai],
                ["anthropic-models", "https://api.anthropic.com/v1/models", SECRET.claude],
                ["google-models", "https://generativelanguage.googleapis.com/v1beta/models", SECRET.google],
            ] as const) {
                const text = await succeeded(name, url);
                expect(text, `${mode} ${name}`).not.toContain(secret);
                expect(text, `${mode} ${name}`).not.toContain(escaped(secret));
            }
        }
        upstreamMode = "json";
        const clean = await aux("openai-models", "https://api.openai.com/v1/models");
        expect(clean.status).toBe(200);
        expect(clean.headers.get("content-type")).toContain("application/json");
        expect(clean.headers.get("x-upstream")).toBe("aux");
        expect(await clean.json()).toEqual({ ok: true, path: "/v1/models", method: "GET" });
    });

    it("knows the credential as injected: a padded stored key echoed trimmed is refused in a body and redacted in a header", async () => {
        const padded = "  sk-padded-SENTINEL-8888  ";
        await seed({ openai: padded });
        upstreamMode = "echo-plain";
        const res = await aux("openai-models", "https://api.openai.com/v1/models");
        expect(res.status).toBe(502);
        expect(upstreamRequests[0].headers.authorization).toBe(`Bearer ${padded.trim()}`);
        const text = await res.text();
        expect(text).not.toContain(padded.trim());
        upstreamMode = "echo-header";
        const header = await aux("openai-models", "https://api.openai.com/v1/models");
        expect(header.status).toBe(200);
        expect(header.headers.get("x-provider-debug")).toBe("key was [redacted]");
        expect(await header.json()).toEqual({ data: [{ id: "m" }] });
        // The same for a trimmed `x-api-key` and for the untrimmed query key.
        upstreamMode = "echo-escaped";
        await seed({ claude: "  sk-ant-padded-SENTINEL-9999 " });
        expect((await aux("anthropic-models", "https://api.anthropic.com/v1/models")).status).toBe(502);
        expect(upstreamRequests.at(-1)!.headers["x-api-key"]).toBe("sk-ant-padded-SENTINEL-9999");
        await seed({ google: " AIza-padded-SENTINEL-0000 " });
        expect((await aux("google-models", "https://generativelanguage.googleapis.com/v1beta/models")).status).toBe(
            502,
        );
    });

    it("refuses a JSON error carrying the credential, escaped or not, as a whole under its status, with its headers redacted", async () => {
        await seed();
        upstreamMode = "error-json-escaped";
        const res = await aux("nanogpt-subscription", "https://nano-gpt.com/api/subscription/v1/usage");
        expect(res.status).toBe(401);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({
            error: "The nanogpt-subscription endpoint answered 401 with the stored credential in it",
        });
        expect(text).not.toContain(SECRET.nanogpt);
        expect(text).not.toContain(escaped(SECRET.nanogpt));
        expect(res.headers.get("x-provider-debug")).toBeNull();
    });

    it("answers 502 for a body that fails mid-read or is not JSON, never an empty success, and passes a non-JSON body through", async () => {
        await seed();
        upstreamMode = "broken";
        const broken = await aux("openrouter-models", "https://openrouter.ai/api/v1/models");
        expect(broken.status).toBe(502);
        expect(await broken.json()).toEqual({ error: "The openrouter-models answer could not be read" });
        upstreamMode = "not-json";
        const notJson = await aux("openrouter-models", "https://openrouter.ai/api/v1/models");
        expect(notJson.status).toBe(502);
        expect(await notJson.json()).toEqual({ error: "The openrouter-models answer is not valid JSON" });
        upstreamMode = "vtt";
        const vtt = await aux("openai-whisper", "https://api.openai.com/v1/audio/transcriptions", {
            method: "POST",
            headers: { "content-type": "multipart/form-data; boundary=x" },
            body: "--x--",
        });
        expect(vtt.status).toBe(200);
        expect(vtt.headers.get("content-type")).toBe("text/vtt");
        expect(await vtt.text()).toBe("WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n");
    });
});

describe("planAuxOp", () => {
    it("answers both forms of the credential for the redactor, the injected one trimmed for a header and as stored for a query", () => {
        const secrets = { openAIKey: " sk-1 ", google: { accessToken: " g-1 " }, claudeAPIKey: "\tc-1\n" };
        const bearer = planAuxOp("openai-models", "https://api.openai.com/v1/models", "GET", new Headers(), secrets);
        expect(bearer).toMatchObject({ ok: true, secrets: [" sk-1 ", "sk-1"] });
        expect((bearer as { headers: Headers }).headers.get("authorization")).toBe("Bearer sk-1");
        const apiKey = planAuxOp(
            "anthropic-models",
            "https://api.anthropic.com/v1/models",
            "GET",
            new Headers(),
            secrets,
        );
        expect(apiKey).toMatchObject({ ok: true, secrets: ["\tc-1\n", "c-1"] });
        expect((apiKey as { headers: Headers }).headers.get("x-api-key")).toBe("c-1");
        const query = planAuxOp(
            "google-models",
            "https://generativelanguage.googleapis.com/v1beta/models",
            "GET",
            new Headers(),
            secrets,
        );
        expect(query).toMatchObject({
            ok: true,
            secrets: [" g-1 ", " g-1 "],
            url: expect.stringContaining("key=+g-1+"),
        });
        // Every row names a fixed HTTPS origin and a method.
        for (const [name, op] of Object.entries(AUX_OPS)) {
            expect(op.origin, name).toMatch(/^https:\/\/[^/]+$/);
            expect(["GET", "POST"], name).toContain(op.method);
        }
    });
});

async function putCollection(kind: string, data: unknown) {
    const current = (await (await client.get(kind, "main")).json()) as { revision: string | null };
    expect((await client.put(kind, "main", { baseRevision: current.revision, data })).status).toBe(200);
}
const NAMED = "named-key-SENTINEL-9999";
async function profileRecords(
    modelId = "nanogpt",
    credentialId: string | undefined = "named",
    type = "custom",
    key = NAMED,
) {
    await putCollection("modelProfiles", [{ id: "edited", name: "Edited connection", modelId, credentialId }]);
    await putCollection("credentials", [{ id: "named", name: "Named key", type }]);
    if (key) await writeSecret({ kind: "entry", field: "credentials", id: "named" }, key);
}
const PROFILE_ROWS = [
    ["nanogpt-models", "nanogpt", "https://nano-gpt.com/api/personalized/v1/models?detailed=true", SECRET.nanogpt],
    [
        "nanogpt-subscription-models",
        "nanogpt",
        "https://nano-gpt.com/api/subscription/v1/models?detailed=true",
        SECRET.nanogpt,
    ],
    ["nanogpt-balance", "nanogpt", "https://nano-gpt.com/api/check-balance", SECRET.nanogpt],
    ["nanogpt-subscription", "nanogpt", "https://nano-gpt.com/api/subscription/v1/usage", SECRET.nanogpt],
    ["nanogpt-model-providers", "nanogpt", "https://nano-gpt.com/api/models/vendor%2Fmodel/providers", SECRET.nanogpt],
    ["ollama-cloud-tags", "ollama-cloud", "https://ollama.com/api/tags", SECRET.ollama],
    ["openrouter-models", "openrouter", "https://openrouter.ai/api/v1/models", SECRET.openrouter],
    ["openrouter-providers", "openrouter", "https://openrouter.ai/api/v1/providers", SECRET.openrouter],
] as const;

describe("auxiliary profile credentials", () => {
    it.each(PROFILE_ROWS)(
        "uses the stored binding for %s and the flat key when unbound",
        async (name, modelId, url, defaultKey) => {
            await seed();
            await profileRecords(modelId);
            expect((await aux(name, url, { profileId: "edited" })).status).toBe(200);
            expect(credentialOf(upstreamRequests[0])).toBe(NAMED);
            await putCollection("modelProfiles", [{ id: "edited", name: "Edited", modelId }]);
            expect((await aux(name, url, { profileId: "edited" })).status).toBe(200);
            expect(credentialOf(upstreamRequests[1])).toBe(defaultKey);
        },
    );
    it.each(["echo-escaped", "echo-header", "error-json-escaped"] as const)(
        "redacts the named credential from %s",
        async (mode) => {
            await seed();
            await profileRecords();
            upstreamMode = mode;
            const response = await aux("nanogpt-models", PROFILE_ROWS[0][2], { profileId: "edited" });
            expect(credentialOf(upstreamRequests[0])).toBe(NAMED);
            expect(response.status).toBe(mode === "echo-header" ? 200 : mode === "error-json-escaped" ? 401 : 502);
            const text = await response.text();
            expect(text).not.toContain(NAMED);
            expect(text).not.toContain(escaped(NAMED));
            if (mode === "echo-header") expect(response.headers.get("x-provider-debug")).toBe("key was [redacted]");
        },
    );
    it.each([false, true])("strips the profile header with rawHeaders=%s", async (rawHeaders) => {
        await seed();
        await profileRecords();
        const response = await aux("nanogpt-models", PROFILE_ROWS[0][2], {
            profileId: "edited",
            rawHeaders,
            headers: { "risu-aux-profile": "embedded-profile" },
        });
        expect(response.status).toBe(200);
        expect(credentialOf(upstreamRequests[0])).toBe(NAMED);
        expect(upstreamRequests[0].headers["risu-aux-profile"]).toBeUndefined();
    });
    it.each(["", "deleted-profile"])(
        "rejects the invalid or missing profile %j before forwarding",
        async (profileId) => {
            await seed();
            const response = await aux("nanogpt-models", PROFILE_ROWS[0][2], { profileId });
            expect(response.status).toBe(400);
            expect(upstreamRequests).toHaveLength(0);
        },
    );
    it.each([
        [
            "missing",
            "nanogpt",
            "gone",
            "custom",
            NAMED,
            'Cannot request model "NanoGPT (nanogpt)": The bound credential no longer exists.',
        ],
        [
            "empty",
            "nanogpt",
            "named",
            "custom",
            "",
            'Cannot request model "NanoGPT (nanogpt)" with credential "Named key": The bound credential has no key.',
        ],
        [
            "whitespace",
            "nanogpt",
            "named",
            "custom",
            "   ",
            'Cannot request model "NanoGPT (nanogpt)" with credential "Named key": The bound credential has no key.',
        ],
        [
            "type mismatch",
            "nanogpt",
            "named",
            "openai",
            NAMED,
            'Cannot request model "NanoGPT (nanogpt)" with credential "Named key": The bound credential\'s type is not accepted by this model.',
        ],
        [
            "unsupported model",
            "echo_model",
            "named",
            "custom",
            NAMED,
            'Cannot request model "Echo (echo_model)" with credential "Named key": This model does not accept a credential binding.',
        ],
    ])(
        "refuses %s with the generation message and no default fallback",
        async (_reason, modelId, credentialId, type, key, error) => {
            await seed();
            await profileRecords(modelId, credentialId, type, key);
            const response = await aux("nanogpt-models", PROFILE_ROWS[0][2], { profileId: "edited" });
            expect(response.status).toBe(400);
            expect(await response.json()).toEqual({ error });
            expect(upstreamRequests).toHaveLength(0);
        },
    );
    it.each([true, false])("rejects a different profile slot even when bound=%s", async (bound) => {
        await seed();
        await profileRecords("openrouter");
        if (!bound) await putCollection("modelProfiles", [{ id: "edited", name: "Edited", modelId: "openrouter" }]);
        expect((await aux("nanogpt-models", PROFILE_ROWS[0][2], { profileId: "edited" })).status).toBe(400);
        expect(upstreamRequests).toHaveLength(0);
    });
    it.each([
        ["openai-tts", "https://api.openai.com/v1/audio/speech"],
        ["openai-embeddings", "https://api.openai.com/v1/embeddings"],
        ["openai-models", "https://api.openai.com/v1/models"],
        ["google-count-tokens", "https://generativelanguage.googleapis.com/v1beta/models/gemini:countTokens"],
    ])("rejects a profile on the slotless %s row (a media, memory, provider-list, or count row)", async (name, url) => {
        await seed();
        await profileRecords();
        expect((await aux(name, url, { profileId: "edited" })).status).toBe(400);
        expect(upstreamRequests).toHaveLength(0);
    });
    it("plans a bound key with both redaction forms and strips an embedded profile header", () => {
        const plan = planAuxOp(
            "nanogpt-models",
            PROFILE_ROWS[0][2],
            "GET",
            new Headers({ "risu-aux-profile": "embedded" }),
            { nanogptKey: SECRET.nanogpt },
            { slot: "nanogpt", credential: { kind: "key", key: `  ${NAMED}  ` } },
        );
        expect(plan).toMatchObject({ ok: true, secrets: [`  ${NAMED}  `, NAMED] });
        if (!plan.ok) throw new Error(plan.error);
        expect(plan.headers.get("authorization")).toBe(`Bearer ${NAMED}`);
        expect(plan.headers.has("risu-aux-profile")).toBe(false);
    });
});
