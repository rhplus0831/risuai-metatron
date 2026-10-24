import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { languageEnglish } from "../../lang/en";

// This browser's Web Push (`pushNotifications.ts`) over stubbed browser APIs (`Notification`,
// `PushManager`, `navigator.serviceWorker` with one registration) and a fake `authFetch`: the
// availability states (ok, insecure, server-off), the boot sync (the key fetched, never a permission
// request, the subscription registered only with the permission granted, the switch on, and this
// browser not opted out; an older server key's subscription replaced; an existing one
// re-registered), the one-time banner's conditions and its dismissal flag from either action,
// `enablePushOnThisBrowser` requesting the permission synchronously inside the click, the server
// refusing a subscription, the browser opt-out with the server removal retried at the next sync, the
// tab's notification (suppressed while subscribed or while the page is in front with the focus, the
// worker's `showNotification`, the page's `Notification` fallback with the click opening the chat),
// the foreground cleanup of the tagged notifications, and the worker's `risu-open-route` message. A
// browser unsubscribe that rejects or resolves `false` (at a disable, and for an older key's
// subscription) is reported in `error` and retried at the next sync, dropped by a re-enable, and
// repaired when another tab turns this browser on mid-retry; the failure details follow the selected
// language.

const deps = vi.hoisted(() => ({
    authFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
    openRoute: vi.fn<(path: string) => boolean>(() => true),
    settings: { ui: { notification: true } },
}));
vi.mock("../storage/serverAuth", () => ({ authFetch: deps.authFetch }));
vi.mock("../router/router.svelte", () => ({ openRoute: deps.openRoute }));
vi.mock("../storage/settingsViews.svelte", () => ({ settings: deps.settings }));

const PROMPT_DISMISSED = "risu-push-prompt-dismissed";
const BROWSER_OFF = "risu-push-browser-off";
const PENDING_REMOVAL = "risu-push-pending-removal";
const PENDING_UNSUBSCRIBE = "risu-push-pending-unsubscribe";
const TAG = "risuai-chat-completion";

function base64url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}
/** The server's VAPID public key (an uncompressed P-256 point) and an older one. */
const KEY_BYTES = Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : i));
const KEY = base64url(KEY_BYTES);
const OLD_KEY_BYTES = Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : 200 - i));

type FakeSubscription = {
    endpoint: string;
    options: { applicationServerKey: ArrayBuffer | null };
    unsubscribe: ReturnType<typeof vi.fn>;
    toJSON: () => unknown;
};
function fakeSubscription(endpoint: string, key: Uint8Array | ArrayBuffer): FakeSubscription {
    const bytes = key instanceof Uint8Array ? key : new Uint8Array(key);
    // A plain `ArrayBuffer` copy, as `PushSubscription.options.applicationServerKey` holds one.
    const applicationServerKey = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(applicationServerKey).set(bytes);
    return {
        endpoint,
        options: { applicationServerKey },
        unsubscribe: vi.fn(async () => true),
        toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "p", auth: "a" } }),
    };
}

/** The one registration: its subscription (`current`), the notifications it shows and lists. */
let current: FakeSubscription | null = null;
let shown: { tag: string; close: ReturnType<typeof vi.fn> }[] = [];
const registration = {
    pushManager: {
        getSubscription: vi.fn(async () => current),
        subscribe: vi.fn(async (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
            current = fakeSubscription("https://fcm.googleapis.com/fcm/send/new", options.applicationServerKey);
            return current;
        }),
    },
    showNotification: vi.fn(async () => {}),
    getNotifications: vi.fn(async () => shown),
};
const workerListeners: ((event: unknown) => void)[] = [];
const container = {
    ready: Promise.resolve(registration),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (type === "message") {
            workerListeners.push(listener);
        }
    },
    /** A message from the worker. */
    emit: (event: unknown) => workerListeners.forEach((listener) => listener(event)),
};

const created: FakeNotification[] = [];
class FakeNotification {
    static permission: NotificationPermission = "default";
    static requestPermission = vi.fn(async () => FakeNotification.permission);
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(
        public title: string,
        public options?: NotificationOptions,
    ) {
        created.push(this);
    }
}

/** What the fake server answers: the key route, the PUT, the DELETE. */
const server = { publicKey: KEY as string | null, put: 204, delete: 204 };
const requests: { method: string; path: string; body?: unknown }[] = [];
let visibility: DocumentVisibilityState = "visible";
/** `document.hasFocus()`: off by default, so the tab's notification is shown. */
let focused = false;
/** The module's `visibilitychange` listeners (captured, so an earlier module instance's never fire). */
const visibilityListeners: EventListener[] = [];

/** `localStorage` under test control: its reads or writes can be made to throw (a blocked or full storage). */
const storage = {
    map: new Map<string, string>(),
    throwReads: false,
    throwWrites: false,
    getItem(key: string): string | null {
        if (storage.throwReads) {
            throw new DOMException("blocked", "SecurityError");
        }
        return storage.map.get(key) ?? null;
    },
    setItem(key: string, value: string) {
        if (storage.throwWrites) {
            throw new DOMException("full", "QuotaExceededError");
        }
        storage.map.set(key, value);
    },
    removeItem(key: string) {
        if (storage.throwWrites) {
            throw new DOMException("blocked", "SecurityError");
        }
        storage.map.delete(key);
    },
    clear() {
        storage.map.clear();
    },
};

function secure(value: boolean) {
    Object.defineProperty(window, "isSecureContext", { value, configurable: true });
}
/** Lets the boot's promise chain (the key, the registration, the subscription, the PUT) settle. */
async function settle() {
    for (let i = 0; i < 12; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}
async function boot() {
    const module = await import("./pushNotifications");
    module.startPushNotifications();
    await settle();
    return module;
}
const state = (module: Awaited<ReturnType<typeof boot>>) => get(module.pushBrowserState);
const calls = (method: string) => requests.filter((request) => request.method === method);
function visibilityChange(to: DocumentVisibilityState) {
    visibility = to;
    for (const listener of visibilityListeners) {
        listener(new Event("visibilitychange"));
    }
}
const showPage = () => visibilityChange("visible");

beforeEach(() => {
    vi.resetModules();
    storage.map.clear();
    storage.throwReads = false;
    storage.throwWrites = false;
    vi.stubGlobal("localStorage", storage);
    requests.length = 0;
    created.length = 0;
    workerListeners.length = 0;
    current = null;
    shown = [];
    visibility = "visible";
    focused = false;
    server.publicKey = KEY;
    server.put = 204;
    server.delete = 204;
    deps.settings.ui.notification = true;
    deps.openRoute.mockClear().mockReturnValue(true);
    registration.pushManager.getSubscription.mockClear();
    registration.pushManager.subscribe.mockClear();
    registration.showNotification.mockClear();
    registration.getNotifications.mockClear();
    FakeNotification.permission = "default";
    FakeNotification.requestPermission.mockReset().mockImplementation(async () => FakeNotification.permission);
    deps.authFetch.mockReset().mockImplementation(async (path, init) => {
        const method = init?.method ?? "GET";
        requests.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        if (path === "/api/push/key") {
            return { ok: true, status: 200, json: async () => ({ publicKey: server.publicKey }) } as Response;
        }
        const status = method === "PUT" ? server.put : server.delete;
        return { ok: status < 300, status } as Response;
    });
    vi.stubGlobal("Notification", FakeNotification);
    Object.defineProperty(window, "PushManager", { value: class {}, configurable: true });
    Object.defineProperty(navigator, "serviceWorker", { value: container, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => visibility, configurable: true });
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    visibilityListeners.length = 0;
    vi.spyOn(document, "addEventListener").mockImplementation(((type: string, listener: EventListener) => {
        if (type === "visibilitychange") {
            visibilityListeners.push(listener);
        }
    }) as typeof document.addEventListener);
    secure(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("startPushNotifications", () => {
    it("reads the availability, fetches the key once, and asks nothing: the banner's conditions hold with the permission at default", async () => {
        const module = await boot();
        expect(state(module)).toEqual({
            availability: "ok",
            permission: "default",
            subscribed: false,
            optedOut: false,
            promptDismissed: false,
            busy: false,
            error: null,
        });
        expect(requests).toEqual([{ method: "GET", path: "/api/push/key" }]);
        expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
        expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
        // Shown again: no second key request, still nothing asked.
        showPage();
        await settle();
        expect(calls("GET")).toHaveLength(1);
        expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    });

    it("is `insecure` off HTTPS and asks the server nothing", async () => {
        secure(false);
        FakeNotification.permission = "granted";
        const module = await boot();
        expect(state(module).availability).toBe("insecure");
        expect(requests).toEqual([]);
        expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    });

    it("is `unsupported` without the push APIs", async () => {
        delete (window as unknown as Record<string, unknown>).PushManager;
        const module = await boot();
        expect(state(module).availability).toBe("unsupported");
        expect(requests).toEqual([]);
    });

    it("is `server-off` when the server has no key, and registers nothing even with the permission granted", async () => {
        server.publicKey = null;
        FakeNotification.permission = "granted";
        const module = await boot();
        expect(state(module).availability).toBe("server-off");
        expect(state(module).subscribed).toBe(false);
        expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
        expect(calls("PUT")).toEqual([]);
    });

    it("with the permission granted, subscribes with the server's key (user-visible only) and registers the subscription", async () => {
        FakeNotification.permission = "granted";
        const module = await boot();
        expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
        expect(registration.pushManager.subscribe.mock.calls[0][0]).toEqual({
            userVisibleOnly: true,
            applicationServerKey: KEY_BYTES,
        });
        expect(calls("PUT")).toEqual([
            { method: "PUT", path: "/api/push/subscription", body: { subscription: current!.toJSON() } },
        ]);
        expect(state(module)).toMatchObject({
            availability: "ok",
            permission: "granted",
            subscribed: true,
            error: null,
        });
        expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    });

    it("re-registers an existing subscription for the current key without subscribing again", async () => {
        FakeNotification.permission = "granted";
        const existing = fakeSubscription("https://fcm.googleapis.com/fcm/send/existing", KEY_BYTES);
        current = existing;
        const module = await boot();
        expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
        expect(existing.unsubscribe).not.toHaveBeenCalled();
        expect(calls("PUT")).toEqual([
            { method: "PUT", path: "/api/push/subscription", body: { subscription: existing.toJSON() } },
        ]);
        expect(state(module).subscribed).toBe(true);
    });

    it("replaces a subscription made for an older server key: unsubscribed, removed on the server, subscribed anew", async () => {
        FakeNotification.permission = "granted";
        const stale = fakeSubscription("https://fcm.googleapis.com/fcm/send/stale", OLD_KEY_BYTES);
        current = stale;
        const module = await boot();
        expect(stale.unsubscribe).toHaveBeenCalledTimes(1);
        expect(calls("DELETE")).toEqual([
            { method: "DELETE", path: "/api/push/subscription", body: { endpoint: stale.endpoint } },
        ]);
        expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
        expect(current!.endpoint).toBe("https://fcm.googleapis.com/fcm/send/new");
        expect(calls("PUT")).toEqual([
            { method: "PUT", path: "/api/push/subscription", body: { subscription: current!.toJSON() } },
        ]);
        expect(state(module).subscribed).toBe(true);
    });

    it("a browser that keeps a subscription for an older key fails the sync with the error, removes it on the server, and retries at the next sync", async () => {
        FakeNotification.permission = "granted";
        const stale = fakeSubscription("https://fcm.googleapis.com/fcm/send/stale", OLD_KEY_BYTES);
        stale.unsubscribe.mockResolvedValue(false);
        current = stale;
        const module = await boot();
        expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
        expect(calls("DELETE")).toEqual([
            { method: "DELETE", path: "/api/push/subscription", body: { endpoint: stale.endpoint } },
        ]);
        expect(calls("PUT")).toEqual([]);
        expect(state(module)).toMatchObject({
            subscribed: false,
            error: languageEnglish.pushNotifications.unsubscribeFailed,
        });
        stale.unsubscribe.mockImplementation(async () => {
            current = null;
            return true;
        });
        showPage();
        await settle();
        expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
        expect(calls("PUT")).toHaveLength(1);
        expect(state(module)).toMatchObject({ subscribed: true, error: null });
    });

    it("registers nothing while this browser is opted out or the synced switch is off", async () => {
        FakeNotification.permission = "granted";
        localStorage.setItem(BROWSER_OFF, "1");
        let module = await boot();
        expect(state(module)).toMatchObject({ optedOut: true, subscribed: false, availability: "ok" });
        expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
        expect(calls("PUT")).toEqual([]);

        vi.resetModules();
        localStorage.clear();
        requests.length = 0;
        deps.settings.ui.notification = false;
        module = await boot();
        expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
        expect(calls("PUT")).toEqual([]);
        expect(state(module)).toMatchObject({ optedOut: false, subscribed: false, availability: "ok" });
        // The key is still known for a later click.
        expect(calls("GET")).toHaveLength(1);
    });

    it("a refused registration leaves this browser not subscribed with the failure recorded", async () => {
        FakeNotification.permission = "granted";
        server.put = 400;
        const module = await boot();
        expect(state(module)).toMatchObject({ subscribed: false, error: expect.stringContaining("400") });
    });
});

describe("localized failure details", () => {
    it("records the server's refusal and a kept subscription in the selected language", async () => {
        // `afterEach` unstubs the setup's clone as well; `changeLanguage` needs it.
        vi.stubGlobal("safeStructuredClone", (value: unknown) => JSON.parse(JSON.stringify(value)));
        const lang = await import("../../lang");
        lang.changeLanguage("ko");
        try {
            FakeNotification.permission = "granted";
            server.put = 400;
            const module = await boot();
            expect(state(module).error).toBe("서버가 이 브라우저의 구독을 거부했습니다 (400)");
            server.put = 204;
            await expect(module.enablePushOnThisBrowser()).resolves.toBe(true);
            current!.unsubscribe.mockResolvedValue(false);
            await module.disablePushOnThisBrowser();
            expect(state(module).error).toBe(lang.language.pushNotifications.unsubscribeFailed);
            expect(state(module).error).toMatch(/^브라우저가 푸시 구독을 해제하지 않았습니다/);
        } finally {
            lang.changeLanguage("en");
        }
    });
});

describe("the banner and the click", () => {
    it("`Later` dismisses the banner for good without asking anything", async () => {
        const module = await boot();
        module.declinePushPrompt();
        expect(localStorage.getItem(PROMPT_DISMISSED)).toBe("1");
        expect(state(module).promptDismissed).toBe(true);
        expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
        vi.resetModules();
        const again = await boot();
        expect(state(again).promptDismissed).toBe(true);
    });

    it("`Receive` requests the permission synchronously inside the click, dismisses the banner, and subscribes once granted", async () => {
        const module = await boot();
        FakeNotification.requestPermission.mockImplementation(async () => {
            FakeNotification.permission = "granted";
            return "granted";
        });
        localStorage.setItem(BROWSER_OFF, "1");
        const result = module.enablePushOnThisBrowser();
        // Before any await: the request is the click's own.
        expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem(PROMPT_DISMISSED)).toBe("1");
        await expect(result).resolves.toBe(true);
        expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
        expect(calls("PUT")).toHaveLength(1);
        expect(localStorage.getItem(BROWSER_OFF)).toBeNull();
        expect(state(module)).toMatchObject({
            permission: "granted",
            subscribed: true,
            optedOut: false,
            promptDismissed: true,
            busy: false,
            error: null,
        });
    });

    it("a denied permission resolves false, subscribes nothing, and never flips the synced switch", async () => {
        const module = await boot();
        FakeNotification.requestPermission.mockImplementation(async () => {
            FakeNotification.permission = "denied";
            return "denied";
        });
        await expect(module.enablePushOnThisBrowser()).resolves.toBe(false);
        expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
        expect(calls("PUT")).toEqual([]);
        expect(state(module)).toMatchObject({ permission: "denied", subscribed: false, promptDismissed: true });
        expect(deps.settings.ui.notification).toBe(true);
    });

    it("a permission already granted skips the request and registers; a refused registration resolves false with the error", async () => {
        FakeNotification.permission = "granted";
        localStorage.setItem(BROWSER_OFF, "1");
        const module = await boot();
        expect(calls("PUT")).toEqual([]);
        server.put = 503;
        await expect(module.enablePushOnThisBrowser()).resolves.toBe(false);
        expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
        expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
        expect(state(module)).toMatchObject({ subscribed: false, error: expect.stringContaining("503"), busy: false });
        server.put = 204;
        await expect(module.enablePushOnThisBrowser()).resolves.toBe(true);
        expect(state(module)).toMatchObject({ subscribed: true, error: null });
    });
});

describe("disablePushOnThisBrowser", () => {
    it("opts this browser out, unsubscribes, and removes the endpoint on the server; the boot sync then leaves it alone", async () => {
        FakeNotification.permission = "granted";
        const module = await boot();
        const endpoint = current!.endpoint;
        const subscription = current!;
        await module.disablePushOnThisBrowser();
        expect(localStorage.getItem(BROWSER_OFF)).toBe("1");
        expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
        expect(calls("DELETE")).toEqual([{ method: "DELETE", path: "/api/push/subscription", body: { endpoint } }]);
        expect(state(module)).toMatchObject({ optedOut: true, subscribed: false, busy: false });
        requests.length = 0;
        current = null;
        showPage();
        await settle();
        expect(calls("PUT")).toEqual([]);
        expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    });

    it("keeps a failed server removal and retries it at the next sync", async () => {
        FakeNotification.permission = "granted";
        const module = await boot();
        const endpoint = current!.endpoint;
        server.delete = 500;
        await module.disablePushOnThisBrowser();
        expect(localStorage.getItem(PENDING_REMOVAL)).toBe(endpoint);
        expect(state(module)).toMatchObject({ optedOut: true, subscribed: false });
        server.delete = 204;
        requests.length = 0;
        current = null;
        showPage();
        await settle();
        expect(calls("DELETE")).toEqual([{ method: "DELETE", path: "/api/push/subscription", body: { endpoint } }]);
        expect(localStorage.getItem(PENDING_REMOVAL)).toBeNull();
        expect(calls("PUT")).toEqual([]);
    });

    it.each([
        { case: "rejects", fail: () => Promise.reject(new DOMException("failed", "AbortError")) },
        { case: "resolves false", fail: () => Promise.resolve(false) },
    ])(
        "reports a browser unsubscribe that $case, keeps the opt-out, and retries it at the next sync",
        async ({ fail }) => {
            FakeNotification.permission = "granted";
            const module = await boot();
            const subscription = current!;
            const endpoint = subscription.endpoint;
            subscription.unsubscribe.mockImplementation(fail);
            await module.disablePushOnThisBrowser();
            expect(localStorage.getItem(BROWSER_OFF)).toBe("1");
            expect(localStorage.getItem(PENDING_UNSUBSCRIBE)).toBe("1");
            // The server still stops sending to it.
            expect(calls("DELETE")).toEqual([{ method: "DELETE", path: "/api/push/subscription", body: { endpoint } }]);
            expect(state(module)).toMatchObject({
                optedOut: true,
                subscribed: false,
                busy: false,
                error: languageEnglish.pushNotifications.unsubscribeFailed,
            });

            // Failing again keeps the flag and the error.
            showPage();
            await settle();
            expect(subscription.unsubscribe).toHaveBeenCalledTimes(2);
            expect(localStorage.getItem(PENDING_UNSUBSCRIBE)).toBe("1");
            expect(state(module).error).toBe(languageEnglish.pushNotifications.unsubscribeFailed);

            subscription.unsubscribe.mockImplementation(async () => {
                current = null;
                return true;
            });
            showPage();
            await settle();
            expect(subscription.unsubscribe).toHaveBeenCalledTimes(3);
            expect(localStorage.getItem(PENDING_UNSUBSCRIBE)).toBeNull();
            expect(state(module)).toMatchObject({ optedOut: true, subscribed: false, error: null });
            expect(calls("PUT")).toHaveLength(1);
        },
    );

    it("drops a pending unsubscribe once this browser is turned on again, keeping its subscription", async () => {
        FakeNotification.permission = "granted";
        const module = await boot();
        const subscription = current!;
        subscription.unsubscribe.mockResolvedValue(false);
        await module.disablePushOnThisBrowser();
        expect(localStorage.getItem(PENDING_UNSUBSCRIBE)).toBe("1");
        requests.length = 0;
        await expect(module.enablePushOnThisBrowser()).resolves.toBe(true);
        expect(localStorage.getItem(PENDING_UNSUBSCRIBE)).toBeNull();
        expect(calls("PUT")).toEqual([
            { method: "PUT", path: "/api/push/subscription", body: { subscription: subscription.toJSON() } },
        ]);
        showPage();
        await settle();
        expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
        expect(current).toBe(subscription);
        expect(state(module)).toMatchObject({ subscribed: true, optedOut: false, error: null });
    });

    it("subscribes again when another tab turns this browser on while the retried unsubscribe runs", async () => {
        FakeNotification.permission = "granted";
        const module = await boot();
        const subscription = current!;
        subscription.unsubscribe.mockResolvedValue(false);
        await module.disablePushOnThisBrowser();
        let finish!: () => void;
        subscription.unsubscribe.mockImplementation(
            () =>
                new Promise<boolean>((resolve) => {
                    finish = () => {
                        current = null;
                        resolve(true);
                    };
                }),
        );
        requests.length = 0;
        showPage();
        await settle();
        expect(subscription.unsubscribe).toHaveBeenCalledTimes(2);
        // The other tab's enable: both flags cleared in the shared storage, its subscription registered.
        storage.map.delete(BROWSER_OFF);
        storage.map.delete(PENDING_UNSUBSCRIBE);
        finish();
        await settle();
        expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(2);
        expect(calls("PUT")).toEqual([
            { method: "PUT", path: "/api/push/subscription", body: { subscription: current!.toJSON() } },
        ]);
        expect(state(module)).toMatchObject({ optedOut: false, subscribed: true, error: null });
    });

    // A readable storage is the truth, also when another tab removed a flag.
    it("reads a flag another tab removed from storage as removed", async () => {
        FakeNotification.permission = "granted";
        const module = await boot();
        await module.disablePushOnThisBrowser();
        expect(state(module).optedOut).toBe(true);
        // Another tab turned this browser on again.
        storage.map.delete(BROWSER_OFF);
        showPage();
        await settle();
        expect(state(module).optedOut).toBe(false);
    });

    it("keeps a flag whose storage write failed for this page, until a later write of it succeeds", async () => {
        FakeNotification.permission = "granted";
        const module = await boot();
        storage.throwWrites = true;
        await module.disablePushOnThisBrowser();
        expect(storage.map.has(BROWSER_OFF)).toBe(false);
        showPage();
        await settle();
        expect(state(module)).toMatchObject({ optedOut: true, subscribed: false });
        expect(calls("PUT")).toHaveLength(1);
        // Another tab cannot clear what was never written; this page's intent stands.
        storage.map.delete(BROWSER_OFF);
        showPage();
        await settle();
        expect(state(module).optedOut).toBe(true);
        // Storage works again: the next write lands and storage is the truth again.
        storage.throwWrites = false;
        FakeNotification.requestPermission.mockImplementation(async () => "granted");
        await expect(module.enablePushOnThisBrowser()).resolves.toBe(true);
        expect(storage.map.has(BROWSER_OFF)).toBe(false);
        storage.map.set(BROWSER_OFF, "1");
        showPage();
        await settle();
        expect(state(module).optedOut).toBe(true);
    });

    it("answers a throwing storage read with the last value read or written", async () => {
        FakeNotification.permission = "granted";
        const module = await boot();
        await module.disablePushOnThisBrowser();
        expect(storage.map.get(BROWSER_OFF)).toBe("1");
        storage.throwReads = true;
        showPage();
        await settle();
        expect(state(module).optedOut).toBe(true);
        // Removed by another tab, read once, then the reads throw: the removal is what was last read.
        storage.throwReads = false;
        storage.map.delete(BROWSER_OFF);
        showPage();
        await settle();
        expect(state(module).optedOut).toBe(false);
        storage.throwReads = true;
        showPage();
        await settle();
        expect(state(module).optedOut).toBe(false);
    });
});

describe("showCompletionNotification", () => {
    const payload = { title: "Risuai", body: "Ann's message has been processed.", url: "/chat/a/k", tag: TAG };

    it("shows nothing and asks nothing without the permission", async () => {
        const module = await boot();
        await module.showCompletionNotification(payload);
        expect(registration.showNotification).not.toHaveBeenCalled();
        expect(created).toEqual([]);
        expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    });

    it("shows nothing while this browser is subscribed (the push shows it)", async () => {
        FakeNotification.permission = "granted";
        const module = await boot();
        expect(state(module).subscribed).toBe(true);
        await module.showCompletionNotification(payload);
        expect(registration.showNotification).not.toHaveBeenCalled();
        expect(created).toEqual([]);
    });

    it("shows the worker's notification with the tag, the logo, and the chat's url when not subscribed", async () => {
        FakeNotification.permission = "granted";
        localStorage.setItem(BROWSER_OFF, "1");
        const module = await boot();
        await module.showCompletionNotification(payload);
        expect(registration.showNotification).toHaveBeenCalledWith("Risuai", {
            body: payload.body,
            tag: TAG,
            icon: "/logo_192.png",
            badge: "/logo_192.png",
            data: { url: "/chat/a/k" },
        });
        expect(created).toEqual([]);
    });

    it("shows nothing while the page is in front with the focus, and shows it when the page is hidden", async () => {
        FakeNotification.permission = "granted";
        localStorage.setItem(BROWSER_OFF, "1");
        const module = await boot();
        focused = true;
        await module.showCompletionNotification(payload);
        expect(registration.showNotification).not.toHaveBeenCalled();
        expect(created).toEqual([]);
        visibility = "hidden";
        await module.showCompletionNotification(payload);
        expect(registration.showNotification).toHaveBeenCalledTimes(1);
    });

    it("falls back to the page's Notification without a worker, and its click focuses the window and opens the chat", async () => {
        FakeNotification.permission = "granted";
        Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true });
        // (`"serviceWorker" in navigator` is false once the property is gone.)
        delete (navigator as unknown as Record<string, unknown>).serviceWorker;
        const module = await boot();
        const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
        await module.showCompletionNotification(payload);
        expect(created).toHaveLength(1);
        expect(created[0].title).toBe("Risuai");
        expect(created[0].options).toEqual({
            body: payload.body,
            tag: TAG,
            icon: "/logo_192.png",
            badge: "/logo_192.png",
        });
        created[0].onclick!();
        expect(focus).toHaveBeenCalled();
        expect(deps.openRoute).toHaveBeenCalledWith("/chat/a/k");
        expect(created[0].close).toHaveBeenCalled();
    });
});

describe("the page shown and the worker's messages", () => {
    it("closes the tagged notifications when the page is shown", async () => {
        const first = { tag: TAG, close: vi.fn() };
        shown = [first];
        await boot();
        expect(registration.getNotifications).toHaveBeenCalledWith();
        expect(first.close).toHaveBeenCalledTimes(1);
        const later = { tag: TAG, close: vi.fn() };
        shown = [later];
        visibilityChange("hidden");
        await settle();
        expect(later.close).not.toHaveBeenCalled();
        showPage();
        await settle();
        expect(later.close).toHaveBeenCalledTimes(1);
    });

    it("closes every chat's completion notifications and the bare prefix, and leaves other notifications", async () => {
        const chatA = { tag: `${TAG}:a1`, close: vi.fn() };
        const chatB = { tag: `${TAG}:b2`, close: vi.fn() };
        const older = { tag: TAG, close: vi.fn() };
        const other = { tag: "another-notice", close: vi.fn() };
        const untagged = { tag: "", close: vi.fn() };
        shown = [chatA, other, chatB, untagged, older];
        await boot();
        for (const closed of [chatA, chatB, older]) {
            expect(closed.close).toHaveBeenCalledTimes(1);
        }
        expect(other.close).not.toHaveBeenCalled();
        expect(untagged.close).not.toHaveBeenCalled();
    });

    it("opens the chat of a `risu-open-route` message and answers the worker; other messages are ignored", async () => {
        await boot();
        const port = { postMessage: vi.fn() };
        container.emit({ data: { type: "risu-open-route", url: "/chat/a/b" }, ports: [port] });
        expect(deps.openRoute).toHaveBeenCalledWith("/chat/a/b");
        expect(port.postMessage).toHaveBeenCalledWith({ opened: true });
        deps.openRoute.mockReturnValue(false);
        container.emit({ data: { type: "risu-open-route", url: "/settings" }, ports: [port] });
        expect(port.postMessage).toHaveBeenLastCalledWith({ opened: false });
        deps.openRoute.mockClear();
        container.emit({ data: { type: "other", url: "/chat/a/b" }, ports: [port] });
        container.emit({ data: { type: "risu-open-route", url: 7 }, ports: [port] });
        container.emit({ data: null, ports: [] });
        expect(deps.openRoute).not.toHaveBeenCalled();
    });
});
