import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 5 slice 11b: where a remembered tool call lives (`mcp.ts` `encodeToolCall`/`decodeToolCall`).
// With the request's chat it is stored with that chat (`mergeChatMeta` onto `chat.toolCalls`) and
// read from it first; without a chat, or with one that is gone, it stays in this browser's
// LocalForage store, which also serves calls remembered before the slice. Both marker forms (the
// whole `<tool_call>` marker, its inner text) decode. The `decodeToolCall` defect itself is pinned
// in `phase5BaselineDefects.test.ts`.

const chatStore = vi.hoisted(() => ({
    chats: new Map<string, { toolCalls?: Record<string, unknown> }>(),
    mergeChatMeta: vi.fn(),
}));

vi.mock("src/ts/storage/chatStore.svelte", () => ({
    findChat: (ref: { chaId: string; chatId: string }) => chatStore.chats.get(`${ref.chaId}/${ref.chatId}`),
    mergeChatMeta: chatStore.mergeChatMeta,
}));
vi.mock("src/ts/globalApi.svelte", () => ({ fetchNative: vi.fn(), openURL: vi.fn(), globalFetch: vi.fn() }));
vi.mock("src/ts/alert", () => ({ alertError: vi.fn(), alertInput: vi.fn(async () => ""), alertNormal: vi.fn() }));
vi.mock("src/ts/storage/collectionStore.svelte", () => ({ addAuthRefresh: vi.fn(), addModule: vi.fn() }));
vi.mock("src/ts/stores.svelte", () => ({ DBState: { db: { mcpURLs: [], modules: [], enabledModules: [] } } }));
vi.mock("src/ts/process/modules", () => ({ getModuleMcps: vi.fn(() => []) }));
vi.mock("src/ts/process/mcp/pluginmcp", () => ({ registeredCustomPluginMCPs: [] }));

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ref = { chaId: "c", chatId: "k" };
const call = (id: string) => ({
    call: { id, name: "lookup", arg: { q: id } },
    response: [{ type: "text" as const, text: `found ${id}` }],
});

beforeEach(() => {
    chatStore.chats.clear();
    chatStore.chats.set("c/k", {});
    chatStore.mergeChatMeta.mockReset();
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("encodeToolCall", () => {
    it("stores a call with the request's chat (and only there), gives it an id when it has none, and keeps it in the browser store without a chat or with one that is gone", async () => {
        const { encodeToolCall, decodeToolCall } = await import("../mcp");
        const marker = await encodeToolCall(call("c1"), ref);
        expect(marker).toBe("<tool_call>c1lookup</tool_call>\n\n");
        expect(chatStore.mergeChatMeta).toHaveBeenCalledWith(ref, "toolCalls", { c1: call("c1") });
        // Not in the browser store: a decode without the chat finds nothing.
        expect(await decodeToolCall("c1lookup")).toBeUndefined();

        const generated = await encodeToolCall({ call: { id: "", name: "lookup", arg: {} }, response: [] }, ref);
        const id = generated.slice("<tool_call>".length, generated.indexOf(""));
        expect(id).toMatch(uuid);
        expect(chatStore.mergeChatMeta).toHaveBeenLastCalledWith(ref, "toolCalls", {
            [id]: { call: { id, name: "lookup", arg: {} }, response: [] },
        });

        chatStore.mergeChatMeta.mockClear();
        await encodeToolCall(call("local"), null);
        await encodeToolCall(call("gone"), { chaId: "c", chatId: "deleted" });
        expect(chatStore.mergeChatMeta).not.toHaveBeenCalled();
        expect(await decodeToolCall("locallookup")).toEqual(call("local"));
        expect(await decodeToolCall("gonelookup", { chaId: "c", chatId: "deleted" })).toEqual(call("gone"));
    });
});

describe("decodeToolCall", () => {
    it("reads the chat's record first (as a copy), in both marker forms, then the browser store for a call the chat does not hold", async () => {
        const { encodeToolCall, decodeToolCall } = await import("../mcp");
        chatStore.chats.set("c/k", { toolCalls: { c1: call("c1") } });
        // An older browser copy of the same id: the chat's record wins when the chat is given.
        await encodeToolCall({ ...call("c1"), response: [{ type: "text", text: "older browser copy" }] }, null);
        const fromChat = await decodeToolCall("<tool_call>c1lookup</tool_call>\n\n", ref);
        expect(fromChat).toEqual(call("c1"));
        expect(fromChat).not.toBe(chatStore.chats.get("c/k")!.toolCalls!.c1);
        expect(await decodeToolCall("  c1lookup ", ref)).toEqual(call("c1"));
        expect(await decodeToolCall("c1lookup")).toEqual({
            ...call("c1"),
            response: [{ type: "text", text: "older browser copy" }],
        });
        // A call the chat does not hold (remembered before the slice): the browser store.
        await encodeToolCall(call("legacy"), null);
        expect(await decodeToolCall("<tool_call>legacylookup</tool_call>", ref)).toEqual(call("legacy"));
        expect(await decodeToolCall("<tool_call>nopelookup</tool_call>", ref)).toBeUndefined();
        expect(await decodeToolCall("", ref)).toBeUndefined();
        // Prototype names are looked up as own entries only.
        expect(await decodeToolCall("constructorx", ref)).toBeUndefined();
    });
});
