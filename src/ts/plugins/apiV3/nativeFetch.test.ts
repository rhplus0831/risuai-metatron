import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Api = { nativeFetch: (url: string, options?: RequestInit) => Promise<Response> };
const captured = vi.hoisted(() => ({ api: null as Api | null }));
vi.mock("./factory", () => ({
    SandboxHost: class {
        constructor(api: Api) {
            captured.api = api;
        }
        run() {}
        terminate() {}
    },
}));
vi.mock("src/ts/globalApi.svelte", () => ({
    checkCharOrder: vi.fn(),
    getFetchLogs: vi.fn(),
    globalFetch: vi.fn(),
    fetchNative: vi.fn(),
    saveAsset: vi.fn(),
    readImage: vi.fn(),
    getFileSrc: vi.fn(),
    downloadFile: vi.fn(),
}));
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: vi.fn(async () => true),
    }),
);
vi.mock("src/ts/parser/parser.svelte", () => ({
    hasher: vi.fn(async () => "hash"),
    risuChatParser: (s: string) => s,
    risuChatParserScoped: (s: string) => s,
    risuEscape: (s: string) => s,
    risuUnescape: (s: string) => s,
}));
vi.mock("src/ts/process/modules", () => ({ moduleUpdate: vi.fn(), getModules: () => [], getModuleMcps: () => [] }));
vi.mock("./permissionStore", () => ({
    hasPermissionGrant: () => true,
    getLastGrantTime: () => Date.now(),
    recordPermissionGrants: vi.fn(),
}));

import { fetchNative } from "src/ts/globalApi.svelte";
import { executePluginV3, loadV3Plugins } from "./v3.svelte";

const url = "https://example.test/plugin";
const sent = () => vi.mocked(fetchNative).mock.calls.at(-1)![1]!;
beforeAll(async () => {
    await executePluginV3({ name: "native-fetch-contract", version: "3.0", script: "" } as never);
});
beforeEach(() => {
    vi.mocked(fetchNative).mockReset().mockResolvedValue(new Response("reply"));
});
afterEach(() => vi.restoreAllMocks());

// The real host API, captured at the sandbox seam; only the network boundary is replaced.
describe("plugin nativeFetch RequestInit adapter", () => {
    it.each([undefined, {}])("defaults options %j to GET", async (options) => {
        const response = await captured.api!.nativeFetch(url, options);
        expect(sent().method).toBe("GET");
        expect(sent().body).toBeUndefined();
        expect(await response.text()).toBe("reply");
    });
    it.each(["HEAD", "POST"])("accepts an empty %s", async (method) => {
        await captured.api!.nativeFetch(url, { method });
        expect(sent().method).toBe(method);
        expect(sent().body).toBeUndefined();
    });
    it.each(["DELETE", "PATCH"])("keeps a %s string body and supplies its default content type", async (method) => {
        await captured.api!.nativeFetch(url, { method, body: "payload α" });
        expect(sent().method).toBe(method);
        expect(sent().body).toBe("payload α");
        expect(new Headers(sent().headers).get("content-type")).toBe("text/plain;charset=UTF-8");
    });
    it.each(["ArrayBuffer", "ArrayBufferView", "Blob"])("forwards the bytes of a %s body", async (kind) => {
        const storage = new Uint8Array([99, 1, 2, 88]);
        const body =
            kind === "ArrayBuffer"
                ? new Uint8Array([1, 2]).buffer
                : kind === "ArrayBufferView"
                  ? new DataView(storage.buffer, 1, 2)
                  : new Blob([new Uint8Array([1, 2])], { type: "application/x-test" });
        await captured.api!.nativeFetch(url, { method: "POST", body });
        expect(Array.from(new Uint8Array(sent().body as ArrayBuffer))).toEqual([1, 2]);
        expect(new Headers(sent().headers).get("content-type")).toBe(kind === "Blob" ? "application/x-test" : null);
    });
    it.each(["record", "pairs"])("accepts %s headers and preserves an explicit content type", async (kind) => {
        const headers: HeadersInit =
            kind === "record"
                ? { "Content-Type": "application/custom", "X-Test": "value" }
                : [
                      ["Content-Type", "application/custom"],
                      ["X-Test", "value"],
                  ];
        for (const body of ["text", new Blob(["text"], { type: "text/plain" })]) {
            await captured.api!.nativeFetch(url, { method: "POST", headers, body });
            expect(new Headers(sent().headers).get("content-type")).toBe("application/custom");
            expect(new Headers(sent().headers).get("x-test")).toBe("value");
        }
    });
    it("passes through the abort signal", async () => {
        const controller = new AbortController();
        await captured.api!.nativeFetch(url, { signal: controller.signal });
        expect(sent().signal).toBe(controller.signal);
    });
    it("does not forward internal fetchNative options supplied by a plugin", async () => {
        const privateOptions = {
            networkRoute: "local_network",
            interceptor: "plugin",
            logFetch: false,
            useRisuTk: true,
            requestTimeoutMs: 1,
            chatId: "another-chat",
            credentials: "include",
            mode: "no-cors",
        };
        await captured.api!.nativeFetch(url, { method: "POST", body: "public", ...privateOptions } as RequestInit);
        expect(sent()).toMatchObject({ method: "POST", body: "public" });
        for (const key of Object.keys(privateOptions)) expect(sent()).not.toHaveProperty(key);
    });
    it.each(["GET", "HEAD"])("rejects a %s body with TypeError before fetching", async (method) => {
        await expect(captured.api!.nativeFetch(url, { method, body: "" })).rejects.toBeInstanceOf(TypeError);
        expect(fetchNative).not.toHaveBeenCalled();
    });
    it("rejects unsupported body types with TypeError before fetching", async () => {
        for (const body of [{ value: "object" }, [1, 2], 123, new URLSearchParams("a=b")]) {
            await expect(
                captured.api!.nativeFetch(url, { method: "POST", body: body as BodyInit }),
            ).rejects.toBeInstanceOf(TypeError);
        }
        expect(fetchNative).not.toHaveBeenCalled();
    });
});
// No pending sandbox, listener, or iframe survives this file.
afterAll(async () => {
    await loadV3Plugins([]);
    document.querySelectorAll("iframe").forEach((frame) => frame.remove());
});
