import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootMutations } from "src/ts/storage/tests/mutationStoresHarness";

// Phase 4, slice 4 (`mcp-risuaccess-writers`): the MCP writers outside RisuAccess, against the real
// save adapter and the real server store (`storeBackedServer.ts`), with the remote `MCPClient`
// stubbed. `importMCPModule` adds a module with an id through `addModule` (an invalid URL adds
// nothing); the refresh callback `initializeMCPs` installs stores the OAuth entry through
// `addAuthRefresh`; the Google credential prompt writes the trimmed values through `updateSettings`
// into `secrets`, asks nothing when credentials exist, and writes nothing for an empty input.

const { server, alerts, remote } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        /** The next `alertInput` answers, in order. */
        inputs: [] as (string | undefined)[],
    },
    remote: {
        constructed: [] as string[],
        /** What the stub's handshake registers through `registerRefreshToken`, when set. */
        refresh: null as null | { clientId: string; clientSecret: string; refreshToken: string; tokenUrl: string },
    },
}));

vi.mock("src/ts/storage/nodeStorage", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("src/ts/alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertConfirm: vi.fn(async () => true),
    alertInput: vi.fn(async () => alerts.inputs.shift()),
    alertMd: vi.fn(),
    alertStore: { set: vi.fn(), subscribe: vi.fn() },
}));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
    getModuleMcps: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async () => ""),
    risuChatParser: vi.fn((text: string) => text),
}));
vi.mock("src/ts/globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    getFetchLogs: vi.fn(() => []),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    openURL: vi.fn(),
    forageStorage: { getItem: vi.fn(), setItem: vi.fn(), keys: vi.fn(async () => []) },
    saveAsset: vi.fn(),
    readImage: vi.fn(),
    getFileSrc: vi.fn(),
    downloadFile: vi.fn(),
}));
// The remote MCP client, without a server: the handshake answers fixed server info and, when the
// test asks, registers a refresh token through the callback `initializeMCPs` installs.
vi.mock("src/ts/process/mcp/mcplib", () => {
    class MCPClient {
        url: string;
        serverInfo = {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "Remote Server", version: "2.0" },
            instructions: "Be nice",
        };
        registerRefreshToken: ((arg: unknown) => void) | null = null;
        getRefreshToken: (() => Promise<unknown>) | null = null;
        constructor(url: string) {
            this.url = url;
            remote.constructed.push(url);
        }
        async checkHandshake() {
            if (remote.refresh && this.registerRefreshToken) {
                this.registerRefreshToken(remote.refresh);
            }
            return this.serverInfo;
        }
        async getToolList() {
            return [];
        }
    }
    class MCPToolHandler {}
    return { MCPClient, MCPToolHandler };
});

async function boot() {
    vi.resetModules();
    alerts.inputs.length = 0;
    remote.constructed.length = 0;
    remote.refresh = null;
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    /** Runs `act`, then checks that neither the mirror nor the server changed and nothing was sent. */
    const unchanged = async (act: () => Promise<unknown>) => {
        const mirror = booted.mirrorText();
        const serverBefore = booted.serverText();
        const batches = booted.fake.batchCount();
        await act();
        expect(booted.mirrorText()).toBe(mirror);
        await booted.sync.flushResources();
        expect(booted.serverText()).toBe(serverBefore);
        expect(booted.fake.batchCount()).toBe(batches);
    };
    return { ...booted, unchanged };
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("importMCPModule", () => {
    it("adds a module with an id and the MCP url from the server's info, saved by the next cycle", async () => {
        const { sync, record, db } = await boot();
        const mcp = await import("../mcp");
        alerts.inputs.push("https://mcp.example/sse");
        await mcp.importMCPModule();
        expect(remote.constructed).toEqual(["https://mcp.example/sse"]);
        expect(alerts.error).not.toHaveBeenCalled();
        expect(alerts.normal).toHaveBeenCalledWith(expect.stringContaining("Remote Server"));
        expect(db().modules).toHaveLength(1);
        const added = db().modules[0];
        expect(added.id).toEqual(expect.any(String));
        expect(added.id).not.toBe("");
        expect(added).toMatchObject({ name: "Remote Server", description: "MCP from https://mcp.example/sse" });
        await sync.flushResources();
        expect(record("modules")).toEqual([
            {
                id: added.id,
                name: "Remote Server",
                description: "MCP from https://mcp.example/sse",
                mcp: { url: "https://mcp.example/sse" },
                lorebook: [
                    {
                        comment: "MCP Info",
                        content: "@@mcp\n\n<MCP Info>Name:Remote Server\nVersion:2.0\nInst:Be nice</MCP Info>",
                        key: "",
                        alwaysActive: true,
                        secondkey: "",
                        insertorder: 0,
                        mode: "normal",
                        selective: false,
                    },
                ],
            },
        ]);
    });

    it("adds nothing for an invalid url", async () => {
        const { unchanged, db } = await boot();
        const mcp = await import("../mcp");
        alerts.inputs.push("ftp://mcp.example");
        await unchanged(() => mcp.importMCPModule());
        expect(alerts.error).toHaveBeenCalledWith("Invalid URL");
        expect(db().modules).toEqual([]);
        expect(remote.constructed).toEqual([]);
    });
});

describe("initializeMCPs", () => {
    it("stores the refresh token a remote server registers as an authRefreshes entry under the server's url", async () => {
        const { sync, record, db } = await boot();
        const mcp = await import("../mcp");
        remote.refresh = {
            clientId: "id",
            clientSecret: "secret",
            refreshToken: "r",
            tokenUrl: "https://mcp.example/token",
        };
        await mcp.initializeMCPs(["https://mcp.example/sse"]);
        expect(db().authRefreshes).toEqual([{ url: "https://mcp.example/sse", ...remote.refresh }]);
        expect(await (mcp.MCPs["https://mcp.example/sse"] as any).getRefreshToken()).toMatchObject({
            refreshToken: "r",
        });
        await sync.flushResources();
        expect(record("authRefreshes")).toEqual([{ url: "https://mcp.example/sse", ...remote.refresh }]);
    });
});

describe("GoogleSearchClient credentials", () => {
    it("asks nothing when credentials exist", async () => {
        const { collectionStore, unchanged, sync } = await boot();
        collectionStore.updateSettings({ googleSearchCredentials: { apiKey: "k", searchEngineId: "e" } });
        await sync.flushResources();
        const { GoogleSearchClient } = await import("../googlesearchclient");
        const client = new GoogleSearchClient();
        await unchanged(() => client.checkHandshake());
        const { alertInput } = await import("src/ts/alert");
        expect(alertInput).not.toHaveBeenCalled();
    });

    it("writes the trimmed inputs into the secrets section", async () => {
        const { sync, record, db } = await boot();
        const { GoogleSearchClient } = await import("../googlesearchclient");
        const client = new GoogleSearchClient();
        alerts.inputs.push("  key  ", " cx ");
        await client.checkHandshake();
        expect(db().googleSearchCredentials).toEqual({ apiKey: "key", searchEngineId: "cx" });
        await sync.flushResources();
        expect(record("secrets").googleSearchCredentials).toEqual({ apiKey: "key", searchEngineId: "cx" });
        // Initialized once: a second handshake asks nothing more.
        await client.checkHandshake();
        expect(alerts.inputs).toEqual([]);
        const { alertInput } = await import("src/ts/alert");
        expect(alertInput).toHaveBeenCalledTimes(2);
    });

    it("writes nothing for a cancelled or blank input, and asks again on the next handshake", async () => {
        const { unchanged, db } = await boot();
        const { GoogleSearchClient } = await import("../googlesearchclient");
        const client = new GoogleSearchClient();
        alerts.inputs.push(undefined);
        await unchanged(() => expect(client.checkHandshake()).rejects.toThrow("API Key is required"));
        alerts.inputs.push("key", "   ");
        await unchanged(() => expect(client.checkHandshake()).rejects.toThrow("Engine ID is required"));
        expect(db().googleSearchCredentials).toBeUndefined();
        alerts.inputs.push("key", "cx");
        await client.checkHandshake();
        expect(db().googleSearchCredentials).toEqual({ apiKey: "key", searchEngineId: "cx" });
    });
});
