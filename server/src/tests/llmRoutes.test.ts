// @vitest-environment node
import http from "node:http";
import { serve } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmRequestEvent } from "../../../shared/llm/request.ts";
import { encodeSecretPath, type SecretPath } from "../../../shared/llmSecrets.ts";
import {
    allowListenerOrigin,
    createResourceTestClient,
    createSigner,
    json,
    sleep,
    waitFor,
    type ResourceTestClient,
} from "./testSupport.ts";

// Phase 5 slice 7a, the HTTP side of the server request layer (`server/src/routes/llm.ts` and the
// `risu-aux-op` branch of `/proxy2`, `server/src/routes/proxy.ts`) on a test server whose provider
// is a local upstream: the JWT and epoch rules, the body validation, the SSE answer, the answer
// route, a client that disconnects over a real socket, maintenance, shutdown, and the six auxiliary
// operations (JWT only, the exact endpoint, the server's credential, no redirect followed, redacted
// errors, the raw body preserved). The registry's own contracts are in `llmRequests.test.ts`.

const SECRET = {
    proxy: "sk-proxy-SENTINEL-1111",
    openai: "sk-openai-SENTINEL-2222",
    memory: "sk-memory-SENTINEL-3333",
    google: "AIza-google-SENTINEL-4444",
    step: "sk-step-SENTINEL-5555",
};

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer; closed: boolean };
const upstreamRequests: Seen[] = [];
let upstreamMode: "chat" | "stall" | "redirect" | "error" | "error-text" = "chat";
let upstream: { url: string; close(): void };
const realFetch = globalThis.fetch;

async function startProvider() {
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
            closed: false,
        };
        upstreamRequests.push(seen);
        res.on("close", () => (seen.closed = true));
        const url = req.url ?? "";
        if (
            url.startsWith("/v1/audio/speech") ||
            url.startsWith("/v1/images/") ||
            url.startsWith("/v1/embeddings") ||
            url.startsWith("/v1/completions") ||
            url.startsWith("/v1/audio/transcriptions") ||
            url.includes(":predict")
        ) {
            if (upstreamMode === "redirect") {
                res.writeHead(302, { location: "/v1/audio/speech?from=redirect" });
                res.end("moved");
                return;
            }
            if (upstreamMode === "error" || upstreamMode === "error-text") {
                // The error echoes the credential in a header and in the body: as JSON (which the
                // server refuses as a whole, 7b) or as text (which it redacts in place).
                const echo = `rejected ${req.headers.authorization} ${new URL(url, "http://x").searchParams.get("key")}`;
                res.writeHead(401, {
                    "content-type": upstreamMode === "error" ? "application/json" : "text/plain",
                    "x-provider-debug": `key was ${req.headers.authorization}`,
                });
                res.end(upstreamMode === "error" ? JSON.stringify({ error: echo }) : echo);
                return;
            }
            res.writeHead(200, { "content-type": "application/octet-stream", "x-upstream": "aux" });
            res.end(Buffer.from([0x00, 0xff, 0x10, 0x7f]));
            return;
        }
        if (upstreamMode === "stall") {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "first" } }] })}\n\n`);
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
            JSON.stringify({
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: `answer to ${JSON.parse(seen.body.toString()).messages.at(-1).content}`,
                        },
                    },
                ],
            }),
        );
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
const PROXY_CREDENTIAL_ID = "proxy-key";

async function seed() {
    client = await createResourceTestClient();
    const read = async (kind: string) =>
        (await (await client.get(kind, "main")).json()) as { revision: string; data: any };
    const write = async (kind: string, data: unknown) => {
        const current = await read(kind);
        const res = await client.put(kind, "main", { baseRevision: current.revision, data });
        expect(res.status).toBe(200);
    };
    const presets = await read("presets");
    const modelPresets = await read("modelPresets");
    const modelProfiles = await read("modelProfiles");
    const personas = await read("personas");
    const presetId = presets.data[0].id as string;
    const modelPresetId = modelPresets.data[0].id as string;
    const personaId = personas.data[0].id as string;
    // The default model preset's main slot names the default profile, which reaches the upstream
    // with a named key (`docs/plan/model-profiles.md`); the prompt preset stays default.
    expect(modelPresets.data[0].mainSlot).toEqual({ profileId: modelProfiles.data[0].id });
    modelProfiles.data[0] = {
        ...modelProfiles.data[0],
        modelId: "reverse_proxy",
        credentialId: PROXY_CREDENTIAL_ID,
        forceReplaceUrl: `${upstream.url}/v1/chat/completions`,
        customProxyRequestModel: "mock-model",
        customAPIFormat: 0,
    };
    await write("modelProfiles", modelProfiles.data);
    await write("credentials", [{ id: PROXY_CREDENTIAL_ID, name: "Proxy", type: "custom" }]);
    // The credentials go through `/api/llm-secrets/*` (Phase 5 slice 7b): the record is write-only.
    await writeSecret({ kind: "flat", field: "openAIKey" }, SECRET.openai);
    await writeSecret({ kind: "flat", field: "supaMemoryKey" }, SECRET.memory);
    await writeSecret({ kind: "nested", field: "google" }, SECRET.google);
    await writeSecret({ kind: "entry", field: "credentials", id: PROXY_CREDENTIAL_ID }, SECRET.proxy);
    return { presetId, modelPresetId, personaId };
}

/** One credential write on the record's current revision (`PUT /api/llm-secrets/<path>`). */
async function writeSecret(path: SecretPath, value: string) {
    const current = (await (await client.get("llmSecrets", "main")).json()) as { revision: string };
    const res = await client.json(
        `/api/llm-secrets/${encodeSecretPath(path)}`,
        { value, baseRevision: current.revision },
        { method: "PUT" },
    );
    expect(res.status).toBe(200);
}

function body(
    ids: { presetId: string; modelPresetId: string; personaId: string },
    arg: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
) {
    return {
        clientId: "tab-1",
        mode: "model",
        context: {
            presetId: ids.presetId,
            modelPresetId: ids.modelPresetId,
            personaId: ids.personaId,
            selectedPersonaId: ids.personaId,
            selectedCharacterId: null,
            speakerId: null,
            mainModel: { imageInput: false },
            tokenizer: {
                aiModel: "reverse_proxy",
                currentPluginProvider: "",
                modelTokenizer: 1,
                pluginTokenizer: "none",
                customTokenizer: "",
                googleClaudeTokenizing: false,
                useTokenizerCaching: false,
            },
        },
        arg: { formated: [{ role: "user", content: "hi" }], bias: {}, ...arg },
        tools: [],
        toolRecords: {},
        ...extra,
    };
}

async function events(res: Response): Promise<LlmRequestEvent[]> {
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    return text
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice("data: ".length)));
}

beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    upstream = await startProvider();
    // The auxiliary operations fix their origins: route those to the local upstream.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        for (const origin of ["https://api.openai.com", "https://generativelanguage.googleapis.com"]) {
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
    upstreamMode = "chat";
});
afterEach(async () => {
    await client?.close();
});

describe("POST /api/llm/request", () => {
    it("runs the request with the stored settings and answers an SSE stream; the answer route settles its callbacks", async () => {
        const ids = await seed();
        const res = await client.json("/api/llm/request", body(ids));
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const got = await events(res);
        expect(got.map((event) => event.type)).toEqual(["accepted", "log", "result"]);
        expect(got[2]).toEqual({ type: "result", response: { type: "success", result: "answer to hi" } });
        expect(upstreamRequests[0].headers.authorization).toBe(`Bearer ${SECRET.proxy}`);
        expect(JSON.stringify(got)).not.toContain(SECRET.proxy);
        // The server context's request history got the row (request history slice 3), redacted.
        const row = client.context.requestHistory.get((got[0] as { id: string }).id);
        expect(row).toMatchObject({
            source: "tab",
            status: "success",
            modelId: "reverse_proxy",
            provider: "OpenAICompatible",
            httpStatus: 200,
            exchangeCount: 1,
            prompt: JSON.stringify([{ role: "user", content: "hi" }]),
        });
        expect(JSON.parse(row!.exchanges![0].header)).toMatchObject({ Authorization: "[redacted]" });
        expect(row!.exchanges![0].response).toContain("answer to hi");
        expect(JSON.stringify(row)).not.toContain(SECRET.proxy);

        const unknown = await client.json("/api/llm/request/nope/answer", {
            clientId: "tab-1",
            callbackId: "x",
            outcome: "answered",
            value: 1,
        });
        expect(unknown.status).toBe(404);
        const malformed = await client.json(`/api/llm/request/nope/answer`, {
            clientId: "tab-1",
            callbackId: "x",
            outcome: "answered",
        });
        expect(malformed.status).toBe(400);
    });

    it("requires a JWT (not the proxy password), the loaded epoch, and a well-formed body", async () => {
        const ids = await seed();
        const noAuth = await client.app.request(
            "/api/llm/request",
            json(body(ids), { "x-resource-epoch": client.epoch }),
        );
        expect(noAuth.status).toBe(400);
        // The proxy password is not a JWT: `verifyJwt` refuses it (today with its generic 500, as on every JWT-only route).
        const password = await client.app.request(
            "/api/llm/request",
            json(body(ids), { "x-resource-epoch": client.epoch, "risu-auth": "pw" }),
        );
        expect(password.status).not.toBe(200);
        expect(upstreamRequests).toHaveLength(0);
        const stale = await client.json("/api/llm/request", body(ids), {}, "stale-epoch");
        expect(stale.status).toBe(412);
        expect(await stale.json()).toEqual({ error: "EpochMismatch", epoch: client.epoch });
        for (const [bad, reason] of [
            [{ ...body(ids), mode: "nope" }, /mode must be one of/],
            [{ ...body(ids), context: { ...body(ids).context, presetId: "" } }, /context.presetId must be an id/],
            [
                { ...body(ids), context: { ...body(ids).context, modelPresetId: "" } },
                /context.modelPresetId must be an id/,
            ],
            [{ ...body(ids), context: { ...body(ids).context, tokenizer: {} } }, /tokenizer scope/],
            [body(ids, { bias: undefined }), /arg.bias/],
            [body(ids, { extra: 1 }), /arg.extra is not a request field/],
            [body(ids, { formated: [{ role: "user" }] }), /chat messages/],
            [body(ids, { chatRef: { chaId: "c" } }), /chatRef/],
            [body(ids, {}, { tools: [{ name: "x" }] }), /tools must be/],
            [body(ids, {}, { toolRecords: { a: { call: {} } } }), /toolRecords/],
            [body(ids, {}, { dynamicModel: { id: "x" } }), /dynamicModel/],
            [body(ids, {}, { channelCall: { jobId: 1 } }), /channelCall/],
        ] as [unknown, RegExp][]) {
            const res = await client.json("/api/llm/request", bad);
            expect(res.status).toBe(400);
            expect(((await res.json()) as { error: string }).error).toMatch(reason);
        }
        const parentGone = await client.json(
            "/api/llm/request",
            body(ids, {}, { channelCall: { jobId: "j", callbackId: "c" } }),
        );
        expect(parentGone.status).toBe(409);
        expect(upstreamRequests).toHaveLength(0);
    });

    // `docs/plan/translation.md` slice 3.1: `arg.profileId` names the profile the request runs on.
    it("runs a request that names a profile on that profile's connection and key, fails one naming a missing profile without an upstream call, and refuses a malformed id", async () => {
        const ids = await seed();
        const read = async (kind: string) =>
            (await (await client.get(kind, "main")).json()) as { revision: string; data: any };
        const write = async (kind: string, data: unknown) => {
            const current = await read(kind);
            const res = await client.put(kind, "main", { baseRevision: current.revision, data });
            expect(res.status).toBe(200);
        };
        // A second profile no slot names, on the same upstream under its own key and request model.
        const profiles = await read("modelProfiles");
        await write("modelProfiles", [
            ...profiles.data,
            {
                ...profiles.data[0],
                id: "step-profile",
                name: "Step",
                credentialId: "step-key",
                customProxyRequestModel: "step-model",
            },
        ]);
        await write("credentials", [
            ...(await read("credentials")).data,
            { id: "step-key", name: "Step", type: "custom" },
        ]);
        await writeSecret({ kind: "entry", field: "credentials", id: "step-key" }, SECRET.step);

        const named = await client.json("/api/llm/request", {
            ...body(ids, { profileId: "step-profile" }),
            mode: "translate",
        });
        expect(named.status).toBe(200);
        const got = await events(named);
        expect(got.at(-1)).toEqual({ type: "result", response: { type: "success", result: "answer to hi" } });
        expect(upstreamRequests).toHaveLength(1);
        expect(upstreamRequests[0].headers.authorization).toBe(`Bearer ${SECRET.step}`);
        expect(JSON.parse(upstreamRequests[0].body.toString()).model).toBe("step-model");
        expect(JSON.stringify(got)).not.toContain(SECRET.step);
        // The same request without a profile runs on the slot's profile (the proxy key, `mock-model`).
        const slot = await client.json("/api/llm/request", { ...body(ids), mode: "translate" });
        expect((await events(slot)).at(-1)).toMatchObject({ type: "result", response: { type: "success" } });
        expect(upstreamRequests).toHaveLength(2);
        expect(upstreamRequests[1].headers.authorization).toBe(`Bearer ${SECRET.proxy}`);
        expect(JSON.parse(upstreamRequests[1].body.toString()).model).toBe("mock-model");

        // A deleted profile: the request fails in the stream (no retry), nothing reaches the upstream.
        const missing = await client.json("/api/llm/request", body(ids, { profileId: "deleted-profile" }));
        expect(missing.status).toBe(200);
        expect((await events(missing)).at(-1)).toEqual({
            type: "result",
            response: {
                type: "fail",
                result: "Cannot send the request: the connection it names no longer exists.",
                noRetry: true,
            },
        });
        expect(upstreamRequests).toHaveLength(2);
        // The route takes a record id only.
        for (const profileId of ["", 5, null, {}]) {
            const res = await client.json("/api/llm/request", body(ids, { profileId }));
            expect(res.status, JSON.stringify(profileId)).toBe(400);
            expect(((await res.json()) as { error: string }).error).toMatch(/arg.profileId must be a model profile id/);
        }
        expect(upstreamRequests).toHaveLength(2);
    });

    it("answers 409 with the binding problems for a chat whose binding is not complete, and 409 mismatch for other ids (`docs/plan/chat-binding.md`)", async () => {
        const ids = await seed();
        const seeded = await client.json("/api/resources/batch", {
            ops: [{ kind: "characters", id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: null,
                    ops: [{ op: "create", chat: { name: "K", message: [] } }],
                },
                {
                    characterId: "c",
                    chatId: "b",
                    baseRevision: null,
                    ops: [
                        {
                            op: "create",
                            chat: {
                                name: "B",
                                modelPresetId: ids.modelPresetId,
                                promptPresetId: ids.presetId,
                                bindedPersona: ids.personaId,
                                message: [],
                            },
                        },
                    ],
                },
            ],
        });
        expect(seeded.status).toBe(200);
        await client.readEpoch();
        const incomplete = await client.json("/api/llm/request", body(ids, { chatRef: { chaId: "c", chatId: "k" } }));
        expect(incomplete.status).toBe(409);
        expect(await incomplete.json()).toEqual({
            error: "chatBindingIncomplete",
            problems: [
                { field: "modelPresetId", reason: "unset" },
                { field: "promptPresetId", reason: "unset" },
                { field: "personaId", reason: "unset" },
            ],
        });
        const mismatch = await client.json(
            "/api/llm/request",
            body({ ...ids, personaId: "other" }, { chatRef: { chaId: "c", chatId: "b" } }),
        );
        expect(mismatch.status).toBe(409);
        expect(await mismatch.json()).toEqual({ error: "chatBindingMismatch" });
        expect(upstreamRequests).toHaveLength(0);
        const bound = await client.json("/api/llm/request", body(ids, { chatRef: { chaId: "c", chatId: "b" } }));
        expect(bound.status).toBe(200);
        expect((await events(bound)).at(-1)).toMatchObject({ type: "result", response: { type: "success" } });
        expect(upstreamRequests).toHaveLength(1);

        // A chat that does not exist (or whose character does not): 404, nothing runs.
        const missingChat = await client.json("/api/llm/request", body(ids, { chatRef: { chaId: "c", chatId: "x" } }));
        expect(missingChat.status).toBe(404);
        expect(await missingChat.json()).toEqual({ error: "The chat this request is for no longer exists" });
        const missingChar = await client.json(
            "/api/llm/request",
            body(ids, { chatRef: { chaId: "nobody", chatId: "b" } }),
        );
        expect(missingChar.status).toBe(404);
        expect(await missingChar.json()).toEqual({ error: "The chat this request is for no longer exists" });
        expect(upstreamRequests).toHaveLength(1);
    });

    it("ends the request when the client disconnects mid-stream over a real socket, and refuses new ones after shutdown began", async () => {
        const ids = await seed();
        const read = async (kind: string) =>
            (await (await client.get(kind, "main")).json()) as { revision: string; data: any };
        const providers = await read("providers");
        expect(
            (
                await client.put("providers", "main", {
                    baseRevision: providers.revision,
                    data: { ...providers.data, useStreaming: true },
                })
            ).status,
        ).toBe(200);
        upstreamMode = "stall";
        const node = serve({ fetch: client.app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
        await new Promise<void>((resolve) => node.once("listening", () => resolve()));
        allowListenerOrigin(node);
        const { port } = node.address() as { port: number };
        try {
            const signer = await createSigner();
            await realFetch(
                `http://127.0.0.1:${port}/api/login`,
                json({ password: "pw", publicKey: signer.publicJwk }),
            );
            const controller = new AbortController();
            const res = await realFetch(`http://127.0.0.1:${port}/api/llm/request`, {
                ...json(body(ids, { useStreaming: true }), {
                    "risu-auth": await signer.jwt(),
                    "x-resource-epoch": client.epoch,
                }),
                signal: controller.signal,
            });
            expect(res.status).toBe(200);
            const reader = res.body!.getReader();
            let seen = "";
            while (!seen.includes('"type":"chunk"')) {
                const { value, done } = await reader.read();
                if (done) {
                    break;
                }
                seen += new TextDecoder().decode(value);
            }
            expect(client.context.llmRequests.liveIds()).toHaveLength(1);
            controller.abort();
            await waitFor(() => client.context.llmRequests.liveIds().length === 0);
            await waitFor(() => upstreamRequests[0]?.closed === true);

            client.context.beginShutdown();
            const refused = await realFetch(
                `http://127.0.0.1:${port}/api/llm/request`,
                json(body(ids), { "risu-auth": await signer.jwt(), "x-resource-epoch": client.epoch }),
            );
            expect(refused.status).toBe(503);
            expect(refused.headers.get("retry-after")).toBe("5");
        } finally {
            node.closeAllConnections();
            await new Promise((resolve) => node.close(resolve));
        }
    });

    it("refuses requests while the data is being replaced (maintenance) and serves them again after", async () => {
        const ids = await seed();
        const store = client.context.snapshots;
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const maintenance = store.withMaintenance(async () => {
            await held;
        });
        await sleep(20);
        const during = await client.json("/api/llm/request", body(ids));
        expect(during.status).toBe(503);
        release();
        await maintenance;
        const after = await client.json("/api/llm/request", body(ids));
        expect(after.status).toBe(200);
        expect((await events(after)).at(-1)).toMatchObject({ type: "result", response: { type: "success" } });
    });
});

describe("the auxiliary operations of /proxy2", () => {
    const auxInit = (
        name: string,
        url: string,
        init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } = {},
    ) => ({
        method: init.method ?? "POST",
        headers: {
            "risu-aux-op": name,
            "risu-url": encodeURIComponent(url),
            ...(init.headers ?? {}),
        },
        ...((init.method ?? "POST") === "GET" ? {} : { body: init.body ?? "{}" }),
    });
    const aux = (
        name: string,
        url: string,
        init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array } = {},
    ) => client.request("/proxy2", auxInit(name, url, init));

    it("injects the stored credential for each row (bearer or `key` query), replacing any the client sent, and keeps the response bytes", async () => {
        await seed();
        const rows: [string, string, string, "bearer" | "query"][] = [
            ["openai-tts", "https://api.openai.com/v1/audio/speech", SECRET.openai, "bearer"],
            ["openai-dalle", "https://api.openai.com/v1/images/generations", SECRET.openai, "bearer"],
            ["openai-whisper", "https://api.openai.com/v1/audio/transcriptions", SECRET.openai, "bearer"],
            ["openai-embeddings", "https://api.openai.com/v1/embeddings", SECRET.memory, "bearer"],
            ["openai-completions", "https://api.openai.com/v1/completions", SECRET.memory, "bearer"],
            [
                "google-imagen",
                "https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0:predict?key=client-key",
                SECRET.google,
                "query",
            ],
        ];
        for (const [name, url, secret, inject] of rows) {
            upstreamRequests.length = 0;
            const res = await aux(name, url, {
                headers: {
                    "risu-header": encodeURIComponent(
                        JSON.stringify({
                            Authorization: "Bearer client-value",
                            "x-api-key": "client",
                            "content-type": "application/json",
                            "risu-auth": "leak",
                        }),
                    ),
                },
                body: JSON.stringify({ input: name }),
            });
            expect(res.status).toBe(200);
            expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x00, 0xff, 0x10, 0x7f]));
            expect(res.headers.get("x-upstream")).toBe("aux");
            const seen = upstreamRequests[0];
            expect(seen.method).toBe("POST");
            expect(seen.body.toString()).toBe(JSON.stringify({ input: name }));
            expect(seen.headers["x-api-key"]).toBeUndefined();
            expect(seen.headers["risu-auth"]).toBeUndefined();
            expect(seen.headers["risu-aux-op"]).toBeUndefined();
            if (inject === "bearer") {
                expect(seen.headers.authorization).toBe(`Bearer ${secret}`);
            } else {
                expect(seen.headers.authorization).toBeUndefined();
                expect(new URL(seen.url, "http://x").searchParams.get("key")).toBe(secret);
                expect(seen.url).toMatch(/^\/v1beta\/models\/imagen-3\.0:predict\?key=/);
            }
        }
    });

    it("preserves a multipart body byte for byte (Whisper)", async () => {
        await seed();
        const form = new FormData();
        form.set("model", "whisper-1");
        form.set("file", new Blob([new Uint8Array([1, 2, 3, 0, 255])], { type: "audio/wav" }), "a.wav");
        const encoded = new Response(form);
        const bytes = new Uint8Array(await encoded.arrayBuffer());
        const res = await aux("openai-whisper", "https://api.openai.com/v1/audio/transcriptions", {
            headers: {
                "risu-header": encodeURIComponent(
                    JSON.stringify({ "content-type": encoded.headers.get("content-type") }),
                ),
            },
            body: bytes,
        });
        expect(res.status).toBe(200);
        expect(new Uint8Array(upstreamRequests[0].body)).toEqual(bytes);
        expect(upstreamRequests[0].headers["content-type"]).toBe(encoded.headers.get("content-type"));
    });

    it("takes the JWT only, refuses an unknown row, another origin, path, or method, and a missing credential", async () => {
        await seed();
        const password = await client.app.request("/proxy2", {
            method: "POST",
            headers: {
                "risu-auth": "pw",
                "risu-aux-op": "openai-tts",
                "risu-url": encodeURIComponent("https://api.openai.com/v1/audio/speech"),
            },
            body: "{}",
        });
        expect(password.status).not.toBe(200);
        const anonymous = await client.app.request(
            "/proxy2",
            auxInit("openai-tts", "https://api.openai.com/v1/audio/speech"),
        );
        expect(anonymous.status).toBe(400);
        expect(await anonymous.json()).toEqual({ error: "No auth header" });
        for (const [name, url, method] of [
            ["unknown-op", "https://api.openai.com/v1/audio/speech", "POST"],
            ["openai-tts", "https://evil.example/v1/audio/speech", "POST"],
            ["openai-tts", "http://api.openai.com/v1/audio/speech", "POST"],
            ["openai-tts", "https://api.openai.com/v1/audio/speech/../x", "POST"],
            ["openai-tts", "https://api.openai.com/v1/images/generations", "POST"],
            ["openai-tts", "https://user:pw@api.openai.com/v1/audio/speech", "POST"],
            ["openai-tts", "https://api.openai.com/v1/audio/speech", "GET"],
            ["google-imagen", "https://generativelanguage.googleapis.com/v1beta/models/../x:predict", "POST"],
        ]) {
            const res = await aux(name, url, { method });
            expect(res.status, `${name} ${method} ${url}`).toBe(400);
        }
        expect(upstreamRequests).toHaveLength(0);
        await writeSecret({ kind: "flat", field: "openAIKey" }, " ");
        const missing = await aux("openai-tts", "https://api.openai.com/v1/audio/speech");
        expect(missing.status).toBe(400);
        expect(await missing.json()).toEqual({ error: "No credential is stored for openai-tts" });
        expect(upstreamRequests).toHaveLength(0);
    });

    it("never follows a redirect, redacts an error body and its headers, and leaves /proxy2 without the header unchanged", async () => {
        await seed();
        upstreamMode = "redirect";
        const redirected = await aux("openai-tts", "https://api.openai.com/v1/audio/speech");
        expect(redirected.status).toBe(502);
        expect(((await redirected.json()) as { error: string }).error).toMatch(/redirect/);
        expect(upstreamRequests).toHaveLength(1);
        // A JSON error answer that carries the credential (7b): refused as a whole, under its status.
        upstreamMode = "error";
        const failed = await aux(
            "google-imagen",
            "https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0:predict",
        );
        expect(failed.status).toBe(401);
        const text = await failed.text();
        expect(JSON.parse(text)).toEqual({
            error: "The google-imagen endpoint answered 401 with the stored credential in it",
        });
        expect(text).not.toContain(SECRET.google);
        // A non-JSON error body is redacted in place, and so are its headers.
        upstreamMode = "error-text";
        const errored = await aux("openai-tts", "https://api.openai.com/v1/audio/speech");
        expect(errored.status).toBe(401);
        const erroredText = await errored.text();
        expect(erroredText).toContain("[redacted]");
        expect(erroredText).not.toContain(SECRET.openai);
        expect(errored.headers.get("x-provider-debug")).toBe("key was Bearer [redacted]");
        // Without the header, the ordinary reverse proxy: the client's own credential, any URL.
        upstreamMode = "chat";
        const plain = await client.request("/proxy2", {
            method: "POST",
            headers: {
                "risu-url": encodeURIComponent(`${upstream.url}/v1/chat/completions`),
                "risu-header": encodeURIComponent(
                    JSON.stringify({ Authorization: "Bearer client-own", "content-type": "application/json" }),
                ),
            },
            body: JSON.stringify({ messages: [{ role: "user", content: "plain" }] }),
        });
        expect(plain.status).toBe(200);
        expect(upstreamRequests.at(-1)?.headers.authorization).toBe("Bearer client-own");
    });
});
