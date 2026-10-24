import { Buffer } from "buffer";
import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreBackedServer } from "./storage/tests/storeBackedServer";

// Drive loadData, observe completed startup, persisted diagnostics, and real asset routing.
// Background services are irrelevant to SW availability; records and getFileSrc stay real.
const mocks = vi.hoisted(() => ({
    server: null as StoreBackedServer | null,
    importShare: vi.fn(),
    alertError: vi.fn(),
    startRouter: vi.fn(),
    startSync: vi.fn(),
    readAsset: vi.fn(async () => Buffer.from([137, 80, 78, 71])),
}));
vi.mock("./storage/serverAuth", async () =>
    (await import("./tests/bootMocks")).createBootMock("serverAuth", {
        authFetch: (path: string, init?: RequestInit) => mocks.server!.fetch(path, init),
        getNodeServerProxyAuth: async () => "test-token",
    }),
);
vi.mock("./storage/assetClient", async () =>
    (await import("./tests/bootMocks")).createBootMock("assetClient", { readAsset: mocks.readAsset }),
);
vi.mock("./storage/resourceSync.svelte", async () =>
    (await import("./tests/bootMocks")).createBootMock("resourceSync", { startResourceSync: mocks.startSync }),
);
vi.mock("./characterCards", async () =>
    (await import("./tests/bootMocks")).createBootMock("characterCards", { characterURLImport: mocks.importShare }),
);
vi.mock("./alert", async () =>
    (await import("./tests/bootMocks")).createBootMock("alert", { alertError: mocks.alertError }),
);
vi.mock("./plugins/plugins.svelte", async () => (await import("./tests/bootMocks")).createBootMock("plugins"));
vi.mock("./plugins/apiV3/permissionStore", async () =>
    (await import("./tests/bootMocks")).createBootMock("permissionStore"),
);
vi.mock("./router/router.svelte", async () =>
    (await import("./tests/bootMocks")).createBootMock("router", { startRouter: mocks.startRouter }),
);
vi.mock("./storage/browserLocalImport", async () =>
    (await import("./tests/bootMocks")).createBootMock("browserLocalImport"),
);
vi.mock("./process/modules", async () => (await import("./tests/bootMocks")).createBootMock("modules"));
vi.mock("./parser/parser.svelte", async () => (await import("./tests/bootMocks")).createBootMock("parser"));
vi.mock("./parser/transformClient", async () => (await import("./tests/bootMocks")).createBootMock("transformClient"));
vi.mock("./process/files/inlays", async () => (await import("./tests/bootMocks")).createBootMock("inlays"));
vi.mock("./gui/animation", async () => (await import("./tests/bootMocks")).createBootMock("animation"));
vi.mock("./gui/colorscheme", async (importOriginal) =>
    (await import("./tests/bootMocks")).createBootColorSchemeMock(
        await importOriginal<typeof import("./gui/colorscheme")>(),
    ),
);
vi.mock("./gui/guisize", async () => (await import("./tests/bootMocks")).createBootMock("guisize"));
vi.mock("./observer.svelte", async () => (await import("./tests/bootMocks")).createBootMock("observer"));
vi.mock("./model/modellist", async () => (await import("./tests/bootMocks")).createBootMock("modellist"));
vi.mock("./network/eventFeed", async () => (await import("./tests/bootMocks")).createBootMock("eventFeed"));
vi.mock("./network/pushNotifications", async () =>
    (await import("./tests/bootMocks")).createBootMock("pushNotifications"),
);
vi.mock("./process/serverCommands", async () => (await import("./tests/bootMocks")).createBootMock("serverCommands"));

const marker = "risu.serviceWorker.initReload";
const asset = "assets/shared.png";
const hex = Buffer.from(asset).toString("hex");
let originalServiceWorker: PropertyDescriptor | undefined;
let listeners: [string, EventListenerOrEventListenerObject][];

beforeAll(async () => {
    await import("./stores.svelte");
    await import("./bootstrap");
}, 60_000);

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    // loadData installs error listeners on each fresh page; remove this test's listeners at teardown.
    listeners = [];
    const add = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
        listeners.push([type, listener]);
        add(type, listener, options);
    });
});

afterEach(() => {
    for (const [type, listener] of listeners) window.removeEventListener(type, listener);
    if (originalServiceWorker) Object.defineProperty(navigator, "serviceWorker", originalServiceWorker);
    else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mocks.server?.close();
});

async function app(options: { firstBoot?: boolean } = {}) {
    mocks.server = await StoreBackedServer.create();
    const ui = mocks.server.record("ui", "main")!.data;
    mocks.server.set("ui", "main", { ...ui, didFirstSetup: !options.firstBoot });
    const stores = await import("./stores.svelte");
    const { loadData } = await import("./bootstrap");
    const globalApi = await import("./globalApi.svelte");
    const diagnostics = await import("./diagnostics/collector");
    vi.spyOn(await import("./util"), "sleep").mockResolvedValue(undefined);
    const register = vi.fn(async () => ({}));
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register } });
    const reload = vi.fn();
    vi.stubGlobal("location", {
        origin: "http://local",
        href: "http://local/",
        pathname: "/",
        search: "",
        hash: "",
        reload,
    });
    const fetch = vi.fn(async (url: string) => {
        if (url === "/sw/init") return new Response("v2");
        if (url === `/sw/check/${hex}`) return Response.json({ able: true });
        throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    // Prove failure actively disables a previously enabled worker path.
    globalApi.setUsingSw(true);
    return { stores, loadData, globalApi, diagnostics, register, reload, fetch };
}

function expectEvent(current: Awaited<ReturnType<typeof app>>, phase: string) {
    expect(current.diagnostics.clientDiagnosticEvents()).toContainEqual(
        expect.objectContaining({ kind: "serviceWorker", phase }),
    );
}

async function expectFallback(current: Awaited<ReturnType<typeof app>>, phase: string) {
    expectEvent(current, phase);
    expect(get(current.stores.loadedStore)).toBe(true);
    expect(mocks.importShare).toHaveBeenCalledTimes(1);
    expect(mocks.startRouter).toHaveBeenCalledTimes(1);
    expect(current.reload).not.toHaveBeenCalled();
    const src = await current.globalApi.getFileSrc(asset);
    expect(src).toMatch(/^blob:/);
    expect(mocks.readAsset).toHaveBeenCalledWith(asset);
    expect(current.fetch.mock.calls.map(([url]) => url)).not.toContain(`/sw/check/${hex}`);
    URL.revokeObjectURL(src);
}

describe("loadData on a store's first boot", () => {
    async function firstBoot(browserLanguage: string) {
        const current = await app({ firstBoot: true });
        vi.spyOn(navigator, "language", "get").mockReturnValue(browserLanguage);
        await current.loadData();
        const { settings } = await import("./storage/settingsViews.svelte");
        const { language } = await import("src/lang");
        return { current, settings, language };
    }

    it("takes the browser's language when the UI has it and marks the setup done", async () => {
        const { current, settings, language } = await firstBoot("ko-KR");
        expect(get(current.stores.loadedStore)).toBe(true);
        expect(settings.ui).toMatchObject({ didFirstSetup: true, language: "ko" });
        expect(language.settings).toBe("설정");
        expect(mocks.importShare).toHaveBeenCalledTimes(1);
    });

    it("keeps the default language for a browser language the UI lacks", async () => {
        const { settings } = await firstBoot("fr-FR");
        expect(settings.ui).toMatchObject({ didFirstSetup: true, language: "en" });
    });
});

describe("loadData with a controlling service worker", () => {
    it.each([
        { body: '{"directAssets":true}', direct: true, behavior: "enables direct URLs from the JSON capability" },
        { body: "v2", direct: false, behavior: "leaves direct URLs off for the older worker's text response" },
    ])("$behavior", async ({ body, direct }) => {
        const current = await app();
        Object.defineProperty(navigator, "serviceWorker", {
            configurable: true,
            value: { register: current.register, controller: {} },
        });
        current.globalApi.setUsingSw(false);
        // Text must clear a previous capability; JSON must enable it from the disabled state.
        current.globalApi.setDirectAssets(!direct);
        current.fetch.mockResolvedValueOnce(new Response(body));
        await current.loadData();
        expect(get(current.stores.loadedStore)).toBe(true);
        expect(await current.globalApi.getFileSrc(asset)).toBe(direct ? `/api/asset/${hex}` : `/sw/img/${hex}`);
        expect(current.fetch.mock.calls.map(([url]) => url)).toEqual(
            direct ? ["/sw/init"] : ["/sw/init", `/sw/check/${hex}`],
        );
        expect(mocks.readAsset).not.toHaveBeenCalled();
    });
});

describe("loadData with service worker failures", () => {
    it("finishes boot with blob assets and registerFailed when registration rejects", async () => {
        const current = await app();
        current.register.mockRejectedValueOnce(new Error("registration denied"));
        await current.loadData();
        await expectFallback(current, "registerFailed");
        expect(current.fetch).not.toHaveBeenCalled();
    });

    it("finishes boot with blob assets and initFailed when init fetch rejects", async () => {
        const current = await app();
        current.fetch.mockRejectedValueOnce(new Error("offline"));
        await current.loadData();
        await expectFallback(current, "initFailed");
        expect(current.fetch).toHaveBeenCalledExactlyOnceWith("/sw/init");
    });

    it("flushes diagnostics and reloads once on a first 404, leaving startup suspended", async () => {
        const current = await app();
        current.fetch.mockResolvedValueOnce(new Response("uncontrolled", { status: 404 }));
        let markerAtReload: string | null = null;
        let diagnosticsAtReload: unknown;
        current.reload.mockImplementation(() => {
            markerAtReload = sessionStorage.getItem(marker);
            diagnosticsAtReload = JSON.parse(sessionStorage.getItem("risu-diagnostics")!);
        });
        await current.loadData();
        expect(current.reload).toHaveBeenCalledTimes(1);
        expect(markerAtReload).not.toBeNull();
        expect(diagnosticsAtReload).toContainEqual(
            expect.objectContaining({ kind: "serviceWorker", phase: "initFailed" }),
        );
        expect(diagnosticsAtReload).toContainEqual(
            expect.objectContaining({ kind: "sync", phase: "reload", reason: "serviceWorker" }),
        );
        expect(sessionStorage.getItem(marker)).not.toBeNull();
        expect(get(current.stores.loadedStore)).toBe(false);
        expect(mocks.importShare).not.toHaveBeenCalled();
        expect(mocks.startSync).not.toHaveBeenCalled();
        expect(mocks.startRouter).not.toHaveBeenCalled();
    });

    it("finishes boot without reloading on 404 when this tab already retried", async () => {
        const current = await app();
        sessionStorage.setItem(marker, "1");
        current.fetch.mockResolvedValueOnce(new Response("uncontrolled", { status: 404 }));
        await current.loadData();
        await expectFallback(current, "initFailed");
        expect(sessionStorage.getItem(marker)).toBe("1");
    });

    it("clears the reload marker and enables worker asset URLs after a 200 init", async () => {
        const current = await app();
        current.globalApi.setUsingSw(false);
        sessionStorage.setItem(marker, "1");
        await current.loadData();
        expect(get(current.stores.loadedStore)).toBe(true);
        expect(current.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
        expectEvent(current, "registered");
        expect(sessionStorage.getItem(marker)).toBeNull();
        expect(await current.globalApi.getFileSrc(asset)).toBe(`/sw/img/${hex}`);
        expect(current.fetch).toHaveBeenCalledWith(`/sw/check/${hex}`, expect.any(Object));
        expect(current.reload).not.toHaveBeenCalled();
        expect(mocks.importShare).toHaveBeenCalledTimes(1);
    });

    it.each(["getItem", "setItem"] as const)(
        "finishes boot without reloading when sessionStorage.%s throws",
        async (method) => {
            const current = await app();
            const storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
            storage[method].mockImplementation(() => {
                throw new DOMException("denied", "SecurityError");
            });
            vi.stubGlobal("sessionStorage", storage);
            current.fetch.mockResolvedValueOnce(new Response("uncontrolled", { status: 404 }));
            await current.loadData();
            await expectFallback(current, "initFailed");
        },
    );

    it("keeps the unsupported-browser fallback working", async () => {
        const current = await app();
        delete (navigator as { serviceWorker?: unknown }).serviceWorker;
        await current.loadData();
        await expectFallback(current, "unsupported");
        expect(current.register).not.toHaveBeenCalled();
        expect(current.fetch).not.toHaveBeenCalled();
    });
});
