import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 5 slice 11b: where a remembered tool call lives (`mcp.ts` `encodeToolCall`/`decodeToolCall`).
// With the request's chat it is stored with that chat (`mergeChatMeta` onto `chat.toolCalls`) and
// read from it; without a chat, or with one that is gone, nothing is remembered (the browser's
// LocalForage store was removed at the Phase 5 cutover, so a call remembered only there no longer
// resolves). Both marker forms (the whole `<tool_call>` marker, its inner text) decode. The
// `decodeToolCall` defect itself is pinned in `phase5BaselineDefects.test.ts`.

const chatStore = vi.hoisted(() => ({
    chats: new Map<string, { toolCalls?: Record<string, unknown> }>(),
    mergeChatMeta: vi.fn(),
}));

vi.mock("src/ts/storage/chatStore.svelte", () => ({
    findChat: (ref: { chaId: string; chatId: string }) => chatStore.chats.get(`${ref.chaId}/${ref.chatId}`),
    mergeChatMeta: chatStore.mergeChatMeta,
}));
vi.mock("src/ts/globalApi.svelte", () => ({ fetchNative: vi.fn(), openURL: vi.fn(), globalFetch: vi.fn() }));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/storage/collectionStore.svelte", () => ({ addAuthRefresh: vi.fn(), addModule: vi.fn() }));
vi.mock("src/ts/stores.svelte", () => ({}));
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
    it("stores a call with the request's chat (and only there), gives it an id when it has none, and remembers nothing without a chat or with one that is gone", async () => {
        const { encodeToolCall, decodeToolCall } = await import("../mcp");
        const marker = await encodeToolCall(call("c1"), ref);
        expect(marker).toBe("<tool_call>c1lookup</tool_call>\n\n");
        expect(chatStore.mergeChatMeta).toHaveBeenCalledWith(ref, "toolCalls", { c1: call("c1") });
        // Not in a browser store: a decode without the chat finds nothing.
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
        expect(await decodeToolCall("locallookup")).toBeUndefined();
        expect(await decodeToolCall("gonelookup", { chaId: "c", chatId: "deleted" })).toBeUndefined();
    });
});

describe("decodeToolCall", () => {
    it("reads the chat's record (as a copy), in both marker forms; without the chat, or for a call the chat does not hold, nothing", async () => {
        const { encodeToolCall, decodeToolCall } = await import("../mcp");
        chatStore.chats.set("c/k", { toolCalls: { c1: call("c1") } });
        const fromChat = await decodeToolCall("<tool_call>c1lookup</tool_call>\n\n", ref);
        expect(fromChat).toEqual(call("c1"));
        expect(fromChat).not.toBe(chatStore.chats.get("c/k")!.toolCalls!.c1);
        expect(await decodeToolCall("  c1lookup ", ref)).toEqual(call("c1"));
        // Without the chat the chat's record is not read.
        expect(await decodeToolCall("c1lookup")).toBeUndefined();
        // A call remembered without a chat (the former browser store's case) is not held anywhere.
        await encodeToolCall(call("legacy"), null);
        expect(await decodeToolCall("<tool_call>legacylookup</tool_call>", ref)).toBeUndefined();
        expect(await decodeToolCall("<tool_call>nopelookup</tool_call>", ref)).toBeUndefined();
        expect(await decodeToolCall("", ref)).toBeUndefined();
        // Prototype names are looked up as own entries only.
        expect(await decodeToolCall("constructorx", ref)).toBeUndefined();
    });
});
