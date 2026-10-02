import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 5 baseline capture (`server/src/tests/fixtures/baseline/README.md`, "Defects pinned here"):
// the behavior of two confirmed defects in the MCP client code, recorded against the client
// functions themselves (they are pure, so no browser capture is needed). Each test pins the defect
// until the slice that fixes it FLIPS it to the intended behavior (implementation plan, question
// 10): `decodeToolCall` was flipped in slice 11b (`post-generation-and-plugin-callbacks`); the OAuth
// refresh flips in slice 12 (`mcp-on-server`).

const { fetchCalls, fetchAnswers } = vi.hoisted(() => ({
    fetchCalls: [] as { url: string; init: RequestInit | undefined }[],
    /** The next `fetchNative` answers, in order; a function answer is called and may throw. */
    fetchAnswers: [] as (Response | (() => Response))[],
}));

vi.mock("src/ts/globalApi.svelte", () => ({
    fetchNative: vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url, init });
        const next = fetchAnswers.shift();
        if (!next) {
            throw new Error(`unexpected fetchNative(${url})`);
        }
        return typeof next === "function" ? next() : next;
    }),
    openURL: vi.fn(),
    globalFetch: vi.fn(),
}));
vi.mock("src/ts/alert", () => ({
    alertError: vi.fn(),
    alertInput: vi.fn(async () => ""),
    alertNormal: vi.fn(),
}));
vi.mock("src/ts/storage/collectionStore.svelte", () => ({ addAuthRefresh: vi.fn(), addModule: vi.fn() }));
vi.mock("src/ts/stores.svelte", () => ({ DBState: { db: { mcpURLs: [], modules: [], enabledModules: [] } } }));
vi.mock("src/ts/process/modules", () => ({ getModuleMcps: vi.fn(() => []) }));
vi.mock("src/ts/process/mcp/pluginmcp", () => ({ registeredCustomPluginMCPs: [] }));

beforeEach(() => {
    fetchCalls.length = 0;
    fetchAnswers.length = 0;
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("Phase 5 baseline, flipped in slice 11b: decodeToolCall decodes a remembered tool call", () => {
    it("decodes the exact text encodeToolCall produced", async () => {
        const { decodeToolCall, encodeToolCall } = await import("../mcp");
        const call = {
            call: { id: "call-1", name: "lookup", arg: { q: "x" } },
            response: [{ type: "text", text: "found" }],
        } as unknown as Parameters<typeof encodeToolCall>[0];
        const encoded = await encodeToolCall(call);
        expect(encoded).toBe("<tool_call>call-1lookup</tool_call>\n\n");

        // Before slice 11b `text.slice("<tool_call>".length, 0)` emptied the text and lost the id;
        // the opening tag is now cut off and the whole marker decodes to the record.
        expect(await decodeToolCall(encoded)).toEqual({
            call: { id: "call-1", name: "lookup", arg: { q: "x" } },
            response: [{ type: "text", text: "found" }],
        });
    });

    it("decodes the same call when the opening tag is absent (the lookup itself works)", async () => {
        const { decodeToolCall, encodeToolCall } = await import("../mcp");
        const call = {
            call: { id: "call-2", name: "lookup", arg: {} },
            response: [],
        } as unknown as Parameters<typeof encodeToolCall>[0];
        await encodeToolCall(call);
        expect(await decodeToolCall("call-2lookup</tool_call>")).toMatchObject({ call: { id: "call-2" } });
    });
});

describe("Phase 5 baseline: the MCP OAuth refresh reads the token only when the status is not 200 (flip in slice 12)", () => {
    const refresh = {
        clientId: "client",
        clientSecret: "secret",
        refreshToken: "refresh",
        tokenUrl: "https://auth.example/token",
    };

    it("ignores a successful refresh (200) and falls through to discovery with no access token", async () => {
        const { MCPClient } = await import("../mcplib");
        const client = new MCPClient("https://mcp.example/sse");
        client.getRefreshToken = async () => refresh;
        fetchAnswers.push(new Response(JSON.stringify({ access_token: "fresh" }), { status: 200 }), () => {
            throw new Error("discovery reached");
        });

        await expect(client.oauthLogin()).rejects.toThrow("discovery reached");
        expect(client.accessToken).toBeNull();
        expect(fetchCalls.map((c) => c.url)).toEqual([
            refresh.tokenUrl,
            "https://mcp.example/.well-known/oauth-authorization-server",
        ]);
        expect(fetchCalls[0].init?.method).toBe("POST");
        expect(String(fetchCalls[0].init?.body)).toContain("grant_type=refresh_token");
    });

    it("stores whatever a failed refresh (not 200) answers as the access token and stops there", async () => {
        const { MCPClient } = await import("../mcplib");
        const client = new MCPClient("https://mcp.example/sse");
        client.getRefreshToken = async () => refresh;
        fetchAnswers.push(new Response(JSON.stringify({ access_token: "from-error-body" }), { status: 400 }));

        await expect(client.oauthLogin()).resolves.toBeUndefined();
        expect(client.accessToken).toBe("from-error-body");
        expect(fetchCalls.map((c) => c.url)).toEqual([refresh.tokenUrl]);
    });
});
