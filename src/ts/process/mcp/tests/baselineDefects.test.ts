import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The baseline capture (`server/src/tests/fixtures/baseline/README.md`, "Defects pinned here"): the
// behavior of two confirmed defects in the MCP client code, recorded against the client functions
// themselves (they are pure, so no browser capture is needed). Each test pinned its defect until the
// fix FLIPPED it to the intended behavior; both are fixed now: `decodeToolCall` (when remembered
// tool calls moved into the chat record) and the OAuth refresh (when MCP moved to the server).

const { fetchCalls, fetchAnswers, chats } = vi.hoisted(() => ({
    fetchCalls: [] as { url: string; init: RequestInit | undefined }[],
    /** The next `fetchNative` answers, in order; a function answer is called and may throw. */
    fetchAnswers: [] as (Response | (() => Response))[],
    /** The chat module's chats by `chaId/chatId`: a remembered call is stored with its chat. */
    chats: new Map<string, { toolCalls?: Record<string, unknown> }>(),
}));

vi.mock("src/ts/storage/chatStore.svelte", () => ({
    findChat: (ref: { chaId: string; chatId: string }) => chats.get(`${ref.chaId}/${ref.chatId}`),
    mergeChatMeta: (ref: { chaId: string; chatId: string }, field: "toolCalls", value: Record<string, unknown>) => {
        const chat = chats.get(`${ref.chaId}/${ref.chatId}`)!;
        chat[field] = { ...chat[field], ...value };
    },
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
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/storage/collectionStore.svelte", () => ({ addAuthRefresh: vi.fn(), addModule: vi.fn() }));
vi.mock("src/ts/stores.svelte", () => ({}));
vi.mock("src/ts/process/modules", () => ({ getModuleMcps: vi.fn(() => []) }));
vi.mock("src/ts/process/mcp/pluginmcp", () => ({ registeredCustomPluginMCPs: [] }));

const ref = { chaId: "c", chatId: "k" };

beforeEach(() => {
    fetchCalls.length = 0;
    fetchAnswers.length = 0;
    chats.clear();
    chats.set("c/k", {});
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("baseline defect, fixed: decodeToolCall decodes a remembered tool call", () => {
    it("decodes the exact text encodeToolCall produced", async () => {
        const { decodeToolCall, encodeToolCall } = await import("../mcp");
        const call = {
            call: { id: "call-1", name: "lookup", arg: { q: "x" } },
            response: [{ type: "text", text: "found" }],
        } as unknown as Parameters<typeof encodeToolCall>[0];
        const encoded = await encodeToolCall(call, ref);
        expect(encoded).toBe("<tool_call>call-1lookup</tool_call>\n\n");

        // Before the fix `text.slice("<tool_call>".length, 0)` emptied the text and lost the id;
        // the opening tag is now cut off and the whole marker decodes to the record.
        expect(await decodeToolCall(encoded, ref)).toEqual({
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
        await encodeToolCall(call, ref);
        expect(await decodeToolCall("call-2lookup</tool_call>", ref)).toMatchObject({ call: { id: "call-2" } });
    });
});

describe("baseline defect, fixed: the MCP OAuth refresh stores the token only when the status is 200", () => {
    const refresh = {
        clientId: "client",
        clientSecret: "secret",
        refreshToken: "refresh",
        tokenUrl: "https://auth.example/token",
    };

    it("stores a successful refresh (200) as the access token and stops there", async () => {
        const { MCPClient } = await import("../mcplib");
        const client = new MCPClient("https://mcp.example/sse");
        client.getRefreshToken = async () => refresh;
        fetchAnswers.push(new Response(JSON.stringify({ access_token: "fresh" }), { status: 200 }));

        // Before the fix the status check was inverted: a 200 was ignored and the login went on
        // to discovery; now the refreshed token is stored and no discovery request is made.
        await expect(client.oauthLogin()).resolves.toBeUndefined();
        expect(client.accessToken).toBe("fresh");
        expect(fetchCalls.map((c) => c.url)).toEqual([refresh.tokenUrl]);
        expect(fetchCalls[0].init?.method).toBe("POST");
        expect(String(fetchCalls[0].init?.body)).toContain("grant_type=refresh_token");
    });

    it("ignores a failed refresh (not 200) and falls through to discovery with no access token", async () => {
        const { MCPClient } = await import("../mcplib");
        const client = new MCPClient("https://mcp.example/sse");
        client.getRefreshToken = async () => refresh;
        fetchAnswers.push(new Response(JSON.stringify({ access_token: "from-error-body" }), { status: 400 }), () => {
            throw new Error("discovery reached");
        });

        // Before the fix the error body's `access_token` was stored as the access token.
        await expect(client.oauthLogin()).rejects.toThrow("discovery reached");
        expect(client.accessToken).toBeNull();
        expect(fetchCalls.map((c) => c.url)).toEqual([
            refresh.tokenUrl,
            "https://mcp.example/.well-known/oauth-authorization-server",
        ]);
    });
});
