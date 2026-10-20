import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6 slice 9b (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/chat-projection-and-lazy-loading.md`,
// "After the challenge, 9b", the second re-check): MCP tool listings and calls work on the clients
// of the call's chat (`syncMCPs`), leased while they are used. An initialization for another chat
// (or an ambient one) that prunes a client in use defers its destruction to the end of the last
// lease; no call reads another chat's client set; the same tool name on two servers resolves on
// the server of the call's chat. The remote `MCPClient` is a fake with gated listings and calls.

const { fakes, urls } = vi.hoisted(() => {
    class FakeClient {
        static all: FakeClient[] = [];
        /** Per URL: a promise `getToolList` awaits before answering (a slow listing). */
        static listGates = new Map<string, Promise<void>>();
        destroyed = false;
        handshakes = 0;
        calls: string[] = [];
        registerRefreshToken: unknown;
        getRefreshToken: unknown;
        constructor(public readonly url: string) {
            FakeClient.all.push(this);
        }
        async checkHandshake() {
            this.handshakes += 1;
        }
        async getToolList() {
            await FakeClient.listGates.get(this.url);
            return [{ name: "roll", description: `roll at ${this.url}`, inputSchema: { type: "object" } }];
        }
        async callTool(name: string, _args: unknown) {
            this.calls.push(name);
            return [{ type: "text", text: `${name} at ${this.url}` }];
        }
        destroy() {
            this.destroyed = true;
        }
    }
    return {
        fakes: {
            FakeClient,
            byUrl: (url: string) => FakeClient.all.filter((client) => client.url === url),
        },
        /** The module MCP servers per chat (`chaId/chatId`; "ambient" for a call without a chat). */
        urls: new Map<string, string[]>(),
    };
});

vi.mock("src/ts/process/mcp/mcplib", () => ({ MCPClient: fakes.FakeClient }));
// The registry always adds `internal:risuai` (`callOnlyMCPUrls`): its client is the fake too (the
// directory import and its index, whichever the dynamic import resolves to).
vi.mock("src/ts/process/mcp/risuaccess", () => ({ RisuAccessClient: fakes.FakeClient }));
vi.mock("src/ts/process/mcp/risuaccess/index", () => ({ RisuAccessClient: fakes.FakeClient }));
vi.mock("src/ts/process/mcp/risuaccess/client", () => ({ RisuAccessClient: fakes.FakeClient }));
vi.mock("src/ts/process/mcp/pluginmcp", () => ({ registeredCustomPluginMCPs: new Map() }));
vi.mock("src/ts/process/modules", () => ({
    getModuleMcps: (chatRef?: { chaId: string; chatId: string }) => [
        ...(urls.get(chatRef ? `${chatRef.chaId}/${chatRef.chatId}` : "ambient") ?? []),
    ],
}));
vi.mock("src/ts/storage/settingsViews.svelte", () => ({ settings: { authRefreshes: [] } }));
vi.mock("src/ts/storage/collectionStore.svelte", () => ({ addAuthRefresh: vi.fn(), addModule: vi.fn() }));
vi.mock("src/ts/storage/chatStore.svelte", () => ({ findChat: vi.fn(), mergeChatMeta: vi.fn() }));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

type Mcp = typeof import("../mcp");
let mcp: Mcp;

const refA = { chaId: "a", chatId: "1" };
const refB = { chaId: "b", chatId: "1" };
const X = "http://x.test/mcp";
const Y = "http://y.test/mcp";
const settleMicrotasks = async () => {
    for (let i = 0; i < 50; i++) {
        await Promise.resolve();
    }
};
/** Holds `url`'s tool listing until the returned function is called. */
function holdListing(url: string) {
    let release!: () => void;
    fakes.FakeClient.listGates.set(url, new Promise<void>((resolve) => (release = resolve)));
    return () => {
        fakes.FakeClient.listGates.delete(url);
        release();
    };
}
const live = (url: string) => fakes.byUrl(url).filter((client) => !client.destroyed);

beforeEach(async () => {
    vi.resetModules();
    fakes.FakeClient.all.length = 0;
    fakes.FakeClient.listGates.clear();
    urls.clear();
    urls.set("a/1", [X]);
    urls.set("b/1", [Y]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    mcp = await import("../mcp");
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("the leased MCP clients", () => {
    it("a listing for chat A (server X) and a call for chat B (server Y) keep their own clients: B's initialization prunes X from the registry but destroys it only when A's listing ends; the same tool name resolves on the server of the call's chat", async () => {
        const releaseX = holdListing(X);
        const listing = mcp.getMCPTools(undefined, refA);
        await settleMicrotasks();
        expect(live(X)).toHaveLength(1);
        const [x] = live(X);
        expect(mcp.MCPs[X]).toBe(x);

        // B's call while A's listing waits: Y connected, X pruned from the registry, not destroyed (leased).
        expect(await mcp.callMCPTool("roll", { sides: 6 }, refB)).toEqual([{ type: "text", text: `roll at ${Y}` }]);
        expect(x.destroyed).toBe(false);
        expect(x.calls).toEqual([]);
        expect(mcp.MCPs[X]).toBeUndefined();
        expect(live(Y)).toHaveLength(1);
        expect(live(Y)[0].calls).toEqual(["roll"]);

        // A's listing answers X's tools, then X's lease ends and it is destroyed.
        releaseX();
        const tools = await listing;
        expect(tools.map((tool) => [tool.name, tool.mcpURL])).toEqual([["roll", X]]);
        expect(x.destroyed).toBe(true);
        // Y, pruned by nothing, stays; a call for A afterwards connects X again and prunes Y.
        expect(live(Y)).toHaveLength(1);
        expect(await mcp.callMCPTool("roll", {}, refA)).toEqual([{ type: "text", text: `roll at ${X}` }]);
        expect(live(X)).toHaveLength(1);
        expect(live(X)[0]).not.toBe(x);
        expect(live(Y)).toHaveLength(0);
    });

    it("the other order: B's call runs while A's listing is out, and an ambient initialization (no chat) in between destroys neither client in use", async () => {
        const releaseX = holdListing(X);
        const releaseY = holdListing(Y);
        const listingA = mcp.getMCPTools(undefined, refA);
        await settleMicrotasks();
        const callB = mcp.callMCPTool("roll", {}, refB);
        await settleMicrotasks();
        const [x] = live(X);
        const [y] = live(Y);
        expect(x).toBeDefined();
        expect(y).toBeDefined();
        // The playground's ambient initialization: no module servers; both leased clients survive it.
        await mcp.initializeMCPs();
        expect(x.destroyed).toBe(false);
        expect(y.destroyed).toBe(false);
        expect(mcp.MCPs[X]).toBeUndefined();
        expect(mcp.MCPs[Y]).toBeUndefined();
        releaseY();
        expect(await callB).toEqual([{ type: "text", text: `roll at ${Y}` }]);
        expect(y.destroyed).toBe(true);
        expect(x.destroyed).toBe(false);
        releaseX();
        expect((await listingA).map((tool) => tool.mcpURL)).toEqual([X]);
        expect(x.destroyed).toBe(true);
        // An unleased client the prune meets is destroyed at once.
        await mcp.initializeMCPs(undefined, refA);
        const [again] = live(X);
        await mcp.initializeMCPs(undefined, refB);
        expect(again.destroyed).toBe(true);
    });

    it("two initializations of one server at once share one client (the duplicate is destroyed), and a listing's leases are released on a failure too", async () => {
        const first = mcp.getMCPTools(undefined, refA);
        const second = mcp.getMCPTools(undefined, refA);
        expect((await first).map((tool) => tool.mcpURL)).toEqual([X]);
        expect((await second).map((tool) => tool.mcpURL)).toEqual([X]);
        expect(live(X)).toHaveLength(1);
        expect(fakes.byUrl(X).length).toBeGreaterThanOrEqual(1);
        const [x] = live(X);
        // A failed listing releases its lease: the next prune destroys the client at once.
        vi.spyOn(x, "getToolList").mockRejectedValueOnce(new Error("boom"));
        await expect(mcp.getMCPTools(undefined, refA)).rejects.toThrow("boom");
        await mcp.initializeMCPs(undefined, refB);
        expect(x.destroyed).toBe(true);
    });
});
