import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Keep the real API and its caches; replace unrelated application boot and storage/network I/O.
vi.mock("./storage/characterStore.svelte", () => ({ selectedCharacter: () => null }));
vi.mock("./storage/settingsViews.svelte", () => ({ settings: { providers: {} } }));
vi.mock("./util", () => ({ checkNullish: (x: unknown) => x == null, sleep: async () => {} }));
vi.mock("streamsaver", () => ({ default: {} }));
vi.mock("./storage/database.svelte", () => ({}));
vi.mock("./stores.svelte", () => ({ bodyIntercepterStore: [] }));
vi.mock("./plugins/plugins.svelte", () => ({}));
vi.mock("./alert", () => ({}));
vi.mock("./parser/parser.svelte", () => ({}));
vi.mock("./characterCards", () => ({}));
vi.mock("./storage/chatStore.svelte", () => ({}));
vi.mock("./storage/selection.svelte", () => ({}));
vi.mock("./storage/resourceClient", () => ({}));
vi.mock("./storage/resourceSync.svelte", () => ({ saving: false }));
vi.mock("./storage/characterOrder", () => ({}));
vi.mock("./storage/assetClient", () => ({ readAsset: vi.fn(), writeAsset: vi.fn() }));
vi.mock("./gui/animation", () => ({}));
vi.mock("./gui/colorscheme", () => ({}));
vi.mock("src/lang", () => ({}));
vi.mock("./gui/guisize", () => ({}));
vi.mock("./process/modules", () => ({}));
vi.mock("./storage/serverAuth", () => ({}));

import { fetchNative } from "./globalApi.svelte";
const fetchStub = vi.fn<typeof fetch>();
const url = "https://example.test/internal";
const sent = () => fetchStub.mock.calls.at(-1)![1]!;
beforeEach(() => {
    fetchStub.mockReset().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("internal fetchNative body contract", () => {
    it("keeps POST as its default for internal callers", async () => {
        await fetchNative(url);
        expect(sent().method).toBe("POST");
        expect(sent().body).toBeUndefined();
    });
    it("sends bodyless requests for every method including HEAD, POST and PUT", async () => {
        for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"]) {
            await fetchNative(url, { method });
            expect(sent().method).toBe(method);
            expect(sent().body).toBeUndefined();
        }
    });
    it.each(["DELETE", "PATCH"])("preserves %s request bodies", async (method) => {
        await fetchNative(url, { method, body: "retained α" });
        expect(sent().method).toBe(method);
        expect(Array.from(sent().body as Uint8Array)).toEqual(Array.from(new TextEncoder().encode("retained α")));
    });
    it("does not print request body contents to the console", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        await fetchNative(url, { method: "POST", body: "private-body-sentinel" });
        expect(log.mock.calls.flat().join(" ")).not.toContain("private-body-sentinel");
    });
});
