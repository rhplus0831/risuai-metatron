import { Buffer } from "buffer";
import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { warmModules } from "./storage/tests/mutationStoresHarness";
import { StoreBackedServer } from "./storage/tests/storeBackedServer";
import { SAFE_BOOT_KEY, SAFE_BOOT_SETTLE_MS } from "./safeBoot";

// Safe boot through the real `loadData` (`app-shell.md` Boot and Safe boot): the attempt is counted
// at the content stage (before the theme) and not by a boot the service worker reloads, a settled
// boot clears it 10 s after loading, a rejected or silent plugin load and a failure after loading
// keep it, `?safe` and the tripped counter set `SafeModeStore` before the theme and show one
// notice, the boot's error alert carries the safe-boot address, and a throwing `localStorage` still
// boots. The boot services this does not drive are the same mocks as
// `bootstrap.serviceWorker.test.ts`; the plugin load is controlled here.
const mocks = vi.hoisted(() => ({
    server: null as StoreBackedServer | null,
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertMd: vi.fn(),
    startRouter: vi.fn(),
    loadPluginsForBoot: vi.fn(async () => ({ guestsStarted: Promise.resolve(true), stopFollowingGuests: vi.fn() })),
    updateTextThemeAndCSS: vi.fn(),
    seedInlays: vi.fn(),
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
    (await import("./tests/bootMocks")).createBootMock("resourceSync"),
);
vi.mock("./characterCards", async () => (await import("./tests/bootMocks")).createBootMock("characterCards"));
vi.mock("./alert", async () =>
    (await import("./tests/bootMocks")).createBootMock("alert", {
        alertError: mocks.alertError,
        alertNormal: mocks.alertNormal,
        alertMd: mocks.alertMd,
    }),
);
vi.mock("./plugins/plugins.svelte", async () =>
    (await import("./tests/bootMocks")).createBootMock("plugins", { loadPluginsForBoot: mocks.loadPluginsForBoot }),
);
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
vi.mock("./process/files/inlays", async () =>
    (await import("./tests/bootMocks")).createBootMock("inlays", { seedInlays: mocks.seedInlays }),
);
vi.mock("./gui/animation", async () => (await import("./tests/bootMocks")).createBootMock("animation"));
vi.mock("./gui/colorscheme", async (importOriginal) =>
    (await import("./tests/bootMocks")).createBootColorSchemeMock(
        await importOriginal<typeof import("./gui/colorscheme")>(),
        { updateTextThemeAndCSS: mocks.updateTextThemeAndCSS },
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

let originalServiceWorker: PropertyDescriptor | undefined;
let listeners: [string, EventListenerOrEventListenerObject][];

// The client graph `app` boots and the server store behind it (its modules and `node:sqlite`), once.
beforeAll(
    () =>
        warmModules(async () => {
            (await StoreBackedServer.create()).close();
            await import("./stores.svelte");
            await import("./bootstrap");
            // `loadData` imports it lazily.
            await import("./process/chatStatus.svelte");
            await import("src/lang");
            await import("./util");
        }),
    60_000,
);

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
    // `Date` too: the settle window compares the guests' start against a `Date.now()` deadline
    // (`safeBoot.ts` `deps.now`), so only the advances below may pass it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    // loadData installs error listeners on each fresh page; remove this test's listeners at teardown.
    listeners = [];
    const add = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
        listeners.push([type, listener]);
        add(type, listener, options);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
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
    vi.unstubAllEnvs();
    mocks.server?.close();
});

/** A page at `http://local/` with a working service worker, ready to `loadData`. */
async function app(options: { search?: string } = {}) {
    mocks.server = await StoreBackedServer.create();
    const ui = mocks.server.record("ui", "main")!.data;
    mocks.server.set("ui", "main", { ...ui, didFirstSetup: true });
    const stores = await import("./stores.svelte");
    const { loadData } = await import("./bootstrap");
    const { language } = await import("src/lang");
    vi.spyOn(await import("./util"), "sleep").mockResolvedValue(undefined);
    Object.defineProperty(navigator, "serviceWorker", {
        configurable: true,
        value: { register: vi.fn(async () => ({})) },
    });
    const reload = vi.fn();
    vi.stubGlobal("location", {
        origin: "http://local",
        href: `http://local/${options.search ?? ""}`,
        pathname: "/",
        search: options.search ?? "",
        hash: "",
        reload,
    });
    const fetch = vi.fn(async (url: string) => {
        if (url === "/sw/init") return new Response("v2");
        throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    // What the theme saw when it ran: whether safe mode was already set, and the counter's record.
    const atTheme = { safeMode: null as boolean | null, record: null as string | null };
    mocks.updateTextThemeAndCSS.mockImplementation(() => {
        atTheme.safeMode = get(stores.SafeModeStore);
        try {
            atTheme.record = localStorage.getItem(SAFE_BOOT_KEY);
        } catch {
            atTheme.record = "unreadable";
        }
    });
    return { stores, loadData, language, reload, fetch, atTheme };
}

const record = () => JSON.parse(localStorage.getItem(SAFE_BOOT_KEY) ?? "null");
const settleWindow = () => vi.advanceTimersByTime(SAFE_BOOT_SETTLE_MS);

describe("loadData with safe boot", () => {
    it("counts the attempt before the theme runs and clears it once the loaded page stayed up 10 s", async () => {
        const current = await app();
        await current.loadData();
        expect(get(current.stores.loadedStore)).toBe(true);
        expect(JSON.parse(current.atTheme.record!)).toMatchObject({ count: 1 });
        expect(current.atTheme.safeMode).toBe(false);
        expect(record()).toMatchObject({ count: 1 });
        expect(mocks.alertNormal).not.toHaveBeenCalled();
        expect(mocks.loadPluginsForBoot).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(SAFE_BOOT_SETTLE_MS - 1);
        expect(record()).toMatchObject({ count: 1 });
        vi.advanceTimersByTime(1);
        expect(record()).toBeNull();
    });

    it("does not count a boot the service worker reloads before user content runs", async () => {
        const current = await app();
        current.fetch.mockResolvedValueOnce(new Response("uncontrolled", { status: 404 }));
        await current.loadData();
        expect(current.reload).toHaveBeenCalledTimes(1);
        expect(mocks.updateTextThemeAndCSS).not.toHaveBeenCalled();
        expect(record()).toBeNull();
        settleWindow();
        expect(record()).toBeNull();
    });

    it("keeps the attempt counted when the plugin load rejects", async () => {
        mocks.loadPluginsForBoot.mockRejectedValueOnce(new Error("plugins broke"));
        const current = await app();
        await current.loadData();
        expect(get(current.stores.loadedStore)).toBe(true);
        expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: "plugins broke" }));
        settleWindow();
        expect(record()).toMatchObject({ count: 1 });
    });

    it("keeps the attempt counted when a plugin never reports its start, and stops following it", async () => {
        const stopFollowingGuests = vi.fn();
        mocks.loadPluginsForBoot.mockResolvedValueOnce({ guestsStarted: new Promise(() => {}), stopFollowingGuests });
        const current = await app();
        await current.loadData();
        settleWindow();
        expect(stopFollowingGuests).toHaveBeenCalledTimes(1);
        expect(record()).toMatchObject({ count: 1 });
    });

    it("keeps the attempt counted when the boot fails after loading, and the error names the safe-boot address", async () => {
        const thrown = new Error("router broke");
        mocks.startRouter.mockImplementationOnce(() => {
            throw thrown;
        });
        const current = await app();
        await current.loadData();
        expect(get(current.stores.loadedStore)).toBe(true);
        expect(mocks.alertError).toHaveBeenCalledTimes(1);
        const shown = mocks.alertError.mock.calls[0][0] as Error;
        expect(shown).toBeInstanceOf(Error);
        expect(shown.message).toContain("router broke");
        expect(shown.message).toContain("http://local/?safe");
        expect(thrown.message).toBe("router broke");
        expect(mocks.alertNormal).not.toHaveBeenCalled();
        settleWindow();
        expect(record()).toMatchObject({ count: 1 });
    });

    it("does not count a boot that fails before user content, and the catch shows the safe-boot notice", async () => {
        mocks.seedInlays.mockImplementationOnce(() => {
            throw new Error("inlays broke");
        });
        const current = await app({ search: "?safe" });
        await current.loadData();
        expect(get(current.stores.loadedStore)).toBe(false);
        expect(record()).toBeNull();
        expect(mocks.alertError).toHaveBeenCalledTimes(1);
        expect((mocks.alertError.mock.calls[0][0] as Error).message).toContain("http://local/?safe");
        expect(mocks.alertNormal).toHaveBeenCalledTimes(1);
        expect(mocks.alertNormal.mock.calls[0][0]).toContain(current.language.safeBootPlugins);
    });

    it("?safe=css sets safe mode before the theme runs, loads plugins, and shows one notice naming CSS only", async () => {
        const current = await app({ search: "?safe=css" });
        await current.loadData();
        expect(current.atTheme.safeMode).toBe(true);
        expect(mocks.loadPluginsForBoot).toHaveBeenCalledTimes(1);
        expect(mocks.alertNormal).toHaveBeenCalledTimes(1);
        const message = mocks.alertNormal.mock.calls[0][0] as string;
        expect(message).toContain(current.language.safeBootCss);
        expect(message).not.toContain(current.language.safeBootPlugins);
        expect(message).not.toContain("did not finish loading");
        settleWindow();
        expect(record()).toBeNull();
    });

    it("trips after two unsettled boots: safe mode before the theme, the notice says why, and settling clears it", async () => {
        localStorage.setItem(SAFE_BOOT_KEY, JSON.stringify({ count: 2, at: 1 }));
        const current = await app();
        await current.loadData();
        expect(current.atTheme.safeMode).toBe(true);
        expect(get(current.stores.loadedStore)).toBe(true);
        expect(record()).toMatchObject({ count: 3 });
        expect(mocks.alertNormal).toHaveBeenCalledTimes(1);
        const message = mocks.alertNormal.mock.calls[0][0] as string;
        expect(message).toContain(current.language.safeBootPlugins);
        expect(message).toContain(current.language.safeBootCss);
        expect(message).toContain(current.language.safeBootAutoReason.replace("{count}", "2"));
        settleWindow();
        expect(record()).toBeNull();
    });

    it("does not clear a newer record another tab wrote during the window", async () => {
        const current = await app();
        await current.loadData();
        const newer = JSON.stringify({ count: 2, at: 99 });
        localStorage.setItem(SAFE_BOOT_KEY, newer);
        settleWindow();
        expect(localStorage.getItem(SAFE_BOOT_KEY)).toBe(newer);
    });

    it("boots normally when localStorage throws, the nightly warning's flag included", async () => {
        vi.stubEnv("VITE_RISU_NIGHTLY_BUILD", "TRUE");
        const current = await app();
        const denied = () => {
            throw new DOMException("denied", "SecurityError");
        };
        vi.stubGlobal("localStorage", { getItem: denied, setItem: denied, removeItem: denied });
        await current.loadData();
        expect(get(current.stores.loadedStore)).toBe(true);
        expect(mocks.alertError).not.toHaveBeenCalled();
        expect(mocks.alertMd).toHaveBeenCalledWith(current.language.nightlyWarning);
        expect(current.atTheme.record).toBe("unreadable");
        settleWindow();
        expect(mocks.alertError).not.toHaveBeenCalled();
    });
});
