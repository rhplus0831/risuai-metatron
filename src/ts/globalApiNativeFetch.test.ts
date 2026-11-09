import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Keep the real API and its caches; replace unrelated application boot and storage/network I/O.
vi.mock("./storage/characterStore.svelte", () => ({ selectedCharacter: () => null }));
vi.mock("./storage/settingsViews.svelte", () => ({ settings: { providers: {} } }));
vi.mock("./util", () => ({ checkNullish: (x: unknown) => x == null, sleep: async () => {} }));
vi.mock("streamsaver", () => ({ default: {} }));
vi.mock("./storage/database.svelte", () => ({}));
vi.mock("./stores.svelte", async () =>
    (await import("src/ts/tests/storesMock")).createStoresMock({ bodyIntercepterStore: [] }),
);
vi.mock("./plugins/plugins.svelte", () => ({}));
vi.mock("./alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("./parser/parser.svelte", () => ({}));
vi.mock("./characterCards", () => ({}));
vi.mock("./storage/chatStore.svelte", async () =>
    (await import("./storage/tests/chatStoreMock")).createChatStoreMock(),
);
vi.mock("./storage/selection.svelte", () => ({}));
vi.mock("./storage/resourceClient", async () =>
    (await import("./storage/tests/resourceClientMock")).createResourceClientMock(),
);
vi.mock("./storage/resourceSync.svelte", async () =>
    (await import("./tests/bootMocks")).createBootMock("resourceSync"),
);
vi.mock("./storage/characterOrder", () => ({}));
vi.mock("./storage/assetClient", async () => (await import("./storage/tests/assetClientMock")).createAssetClientMock());
vi.mock("./gui/animation", () => ({}));
vi.mock("./gui/colorscheme", () => ({}));
vi.mock("src/lang", () => ({}));
vi.mock("./gui/guisize", () => ({}));
vi.mock("./process/modules", () => ({}));
vi.mock("./storage/serverAuth", () => ({ getNodeServerProxyAuth: async () => "" }));

import { fetchNative } from "./globalApi.svelte";
const fetchStub = vi.fn<typeof fetch>();
const url = "https://example.test/internal";
const sent = () => fetchStub.mock.calls.at(-1)![1]!;
beforeEach(() => {
    fetchStub.mockReset().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchStub);
    vi.stubGlobal("userScriptFetch", undefined);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function abortAwareTransport(transport: typeof fetchStub) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
        start(streamController) {
            controller = streamController;
        },
    });
    transport.mockImplementationOnce(async (_url, options) => {
        options!.signal!.addEventListener(
            "abort",
            () => controller.error(new DOMException("Request aborted", "AbortError")),
            { once: true },
        );
        return new Response(body);
    });
    return controller;
}

function observeCallerAbort(signal: AbortSignal) {
    const added = vi.spyOn(signal, "addEventListener");
    const removed = vi.spyOn(signal, "removeEventListener");
    return {
        expectAttached() {
            const listeners = added.mock.calls.filter(([event]) => event === "abort");
            expect(listeners.length).toBeGreaterThan(0);
            for (const [, listener] of listeners) {
                expect(removed).not.toHaveBeenCalledWith("abort", listener);
            }
        },
        expectDetached() {
            for (const [event, listener] of added.mock.calls) {
                if (event === "abort") {
                    expect(removed).toHaveBeenCalledWith("abort", listener);
                }
            }
        },
    };
}

describe.each(["direct fetch", "userscript", "/proxy2"] as const)("fetchNative via %s", (branch) => {
    const requestTimeoutMs = 1_000;
    const requestUrl = branch === "/proxy2" ? "http://127.0.0.1:1234/x" : url;
    let transport: typeof fetchStub;

    beforeEach(() => {
        vi.useFakeTimers();
        const userscript = vi.fn<typeof fetch>();
        if (branch !== "direct fetch") {
            vi.stubGlobal("userScriptFetch", userscript);
        }
        transport = branch === "userscript" ? userscript : fetchStub;
    });

    const request = (signal: AbortSignal, timeoutMs?: number) =>
        fetchNative(requestUrl, {
            method: "GET",
            signal,
            requestTimeoutMs: timeoutMs,
            networkRoute: branch === "/proxy2" ? "local_network" : "auto",
        });
    const transportSignal = () => transport.mock.calls.at(-1)![1]!.signal!;

    it("stops the header timeout while forwarding caller abort to a pending body read", async () => {
        const caller = new AbortController();
        abortAwareTransport(transport);
        const response = await request(caller.signal, requestTimeoutMs);
        const signal = transportSignal();
        const [target, options] = transport.mock.calls.at(-1)!;
        expect(target).toBe(branch === "/proxy2" ? "/proxy2" : requestUrl);
        if (branch === "/proxy2") {
            expect(new Headers(options!.headers).get("risu-timeout-ms")).toBe("1000");
        }

        const readError = response
            .body!.getReader()
            .read()
            .then(
                () => undefined,
                (error: unknown) => error,
            );
        await vi.advanceTimersByTimeAsync(requestTimeoutMs + 1);
        expect(signal.aborted).toBe(false);

        caller.abort();
        expect(signal.aborted).toBe(true);
        await expect(readError).resolves.toMatchObject({ name: "AbortError" });
    });

    it.each(["read to the end", "errored", "cancelled"] as const)(
        "detaches caller abort after the body is %s",
        async (ending) => {
            const caller = new AbortController();
            const listener = observeCallerAbort(caller.signal);
            const controller = abortAwareTransport(transport);
            controller.enqueue(new TextEncoder().encode("streamed body"));
            const response = await request(caller.signal, requestTimeoutMs);
            const signal = transportSignal();
            listener.expectAttached();

            if (ending === "read to the end") {
                controller.close();
                await expect(response.text()).resolves.toBe("streamed body");
            } else if (ending === "errored") {
                // Fill the returned stream's queue before failing the transport: cleanup must
                // also happen while the consumer is idle, without another body read.
                await vi.advanceTimersByTimeAsync(0);
                const failure = new Error("Body transport failed");
                controller.error(failure);
                await vi.advanceTimersByTimeAsync(0);
                listener.expectDetached();
                await expect(response.text()).rejects.toThrow();
            } else {
                await response.body!.cancel("consumer finished");
            }

            listener.expectDetached();
            caller.abort();
            expect(signal.aborted).toBe(false);
        },
    );

    it.each(["rejects", "returns a null body"] as const)(
        "detaches caller abort when the transport %s",
        async (outcome) => {
            const caller = new AbortController();
            const listener = observeCallerAbort(caller.signal);
            const failure = new Error("Transport failed before headers");
            transport.mockImplementationOnce(async () => {
                listener.expectAttached();
                if (outcome === "rejects") {
                    throw failure;
                }
                return new Response(null);
            });

            const result = request(caller.signal, requestTimeoutMs);
            if (outcome === "rejects") {
                await expect(result).rejects.toBe(failure);
            } else {
                expect((await result).body).toBeNull();
            }

            listener.expectDetached();
            const signal = transportSignal();
            await vi.advanceTimersByTimeAsync(requestTimeoutMs + 1);
            caller.abort();
            expect(signal.aborted).toBe(false);
        },
    );

    it("passes the caller signal unchanged when no request timeout is set", async () => {
        const caller = new AbortController();
        abortAwareTransport(transport);
        const response = await request(caller.signal);
        expect(transportSignal()).toBe(caller.signal);
        await response.body!.cancel();
    });
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
