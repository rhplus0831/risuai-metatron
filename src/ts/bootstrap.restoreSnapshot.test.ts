import { IDBDatabase, IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { tick } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeLockManager } from "./storage/tests/fakeLockManager";
import { StoreBackedServer } from "./storage/tests/storeBackedServer";
import { recoveryBootServer } from "./storage/tests/recoveryBootServer";
import { m, plain, refK, SAVE_DEBOUNCE_MS, warmModules } from "./storage/tests/mutationStoresHarness";

const io = vi.hoisted(() => ({
    fetch: null as null | ((path: string, init?: RequestInit) => Promise<Response>),
    alertError: vi.fn(),
    alertTerminal: vi.fn(async () => {}),
}));
vi.mock("./storage/serverAuth", async () =>
    (await import("./tests/bootMocks")).createBootMock("serverAuth", {
        authFetch: (path, init) => io.fetch!(path, init),
    }),
);
vi.mock("./alert", async () =>
    (await import("./tests/alertMock")).createAlertMock({ alertError: io.alertError, alertTerminal: io.alertTerminal }),
);
vi.mock("./plugins/plugins.svelte", async () => (await import("./tests/bootMocks")).createBootMock("plugins"));
vi.mock("./storage/browserLocalImport", async () =>
    (await import("./tests/bootMocks")).createBootMock("browserLocalImport"),
);
vi.mock("./network/eventFeed", async () => (await import("./tests/bootMocks")).createBootMock("eventFeed"));
vi.mock("./network/pushNotifications", async () =>
    (await import("./tests/bootMocks")).createBootMock("pushNotifications"),
);
vi.mock("./process/serverCommands", async () => (await import("./tests/bootMocks")).createBootMock("serverCommands"));
vi.mock("./observer.svelte", async () => (await import("./tests/bootMocks")).createBootMock("observer"));
vi.mock("./router/router.svelte", async () => (await import("./tests/bootMocks")).createBootMock("router"));

const UI = "ui\0main";
const CHARACTER = "characters\0c";
let server: StoreBackedServer;
let page: Awaited<ReturnType<typeof newPage>> | undefined;
let locks: ReturnType<typeof createFakeLockManager>;
let originalSw: PropertyDescriptor | undefined;
const listeners: [EventTarget, string, EventListenerOrEventListenerObject][] = [];
const visibilityStops: (() => void)[] = [];
const transactions = new Set<Promise<void>>();
const previousServers: StoreBackedServer[] = [];

beforeAll(() =>
    warmModules(async () => {
        const seed = await StoreBackedServer.create();
        await recoveryBootServer(seed);
        seed.close();
        await import("./bootstrap");
        await import("./process/chatStatus.svelte");
        await import("./storage/journalRecovery");
    }),
);

beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    vi.stubGlobal("requestIdleCallback", undefined);
    locks = createFakeLockManager();
    vi.spyOn(navigator, "locks", "get").mockReturnValue(locks);
    originalSw = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: undefined });
    vi.stubGlobal("location", {
        origin: "http://local",
        href: "http://local/",
        pathname: "/",
        search: "",
        hash: "",
        reload: vi.fn(),
    });
    for (const target of [window, document]) {
        const add = target.addEventListener.bind(target);
        vi.spyOn(target, "addEventListener").mockImplementation((name, listener, options) => {
            listeners.push([target, name, listener]);
            add(name, listener, options);
        });
    }
    const transaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (...args) {
        const tx = transaction.apply(this, args);
        const completion = new Promise<void>((resolve) => {
            const done = () => {
                transactions.delete(completion);
                resolve();
            };
            tx.addEventListener("complete", done);
            tx.addEventListener("abort", done);
        });
        transactions.add(completion);
        return tx;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    server = await restoredServer("original");
    io.fetch = (await recoveryBootServer(server)).fetch;
});

async function restoredServer(label: string) {
    const result = await StoreBackedServer.create();
    result.set("ui", "main", { ...result.record("ui", "main")!.data, didFirstSetup: true, theme: `${label} theme` });
    result.set("modules", "main", []);
    result.set("plugins", "main", []);
    result.set("characters", "c", { chaId: "c", name: "Server character", desc: `${label} description` });
    result.set("characterOrder", "main", ["c"]);
    result.store.applyChanges({
        chats: ["k", "j"].map((chatId) => ({
            characterId: "c",
            chatId,
            baseRevision: null,
            ops: [
                {
                    op: "create",
                    chat: { id: chatId, name: chatId, note: "", localLore: [], message: [m("a", `${label} message`)] },
                },
            ],
        })),
    });
    return result;
}

async function drain() {
    await vi.advanceTimersByTimeAsync(0);
    while (transactions.size) {
        await Promise.all([...transactions]);
        await vi.advanceTimersByTimeAsync(0);
    }
}

async function newPage() {
    const sync = await import("./storage/resourceSync.svelte");
    const journal = (await import("./storage/draftJournal")).pageDraftJournal();
    const { settings } = await import("./storage/settingsViews.svelte");
    const characters = await import("./storage/characterStore.svelte");
    const chat = await import("./storage/chatStore.svelte");
    const { recoveryDrafts } = await import("./storage/recoveryDrafts.svelte");
    const cache = await import("./storage/bootCache");
    const stores = await import("./stores.svelte");
    const { loadData } = await import("./bootstrap");
    const status = await import("./process/chatStatus.svelte");
    const watch = status.watchChatVisibility;
    vi.spyOn(status, "watchChatVisibility").mockImplementation(() => {
        const stop = watch();
        visibilityStops.push(stop);
        return stop;
    });
    return { sync, journal, settings, characters, chat, recoveryDrafts, cache, stores, loadData };
}

async function boot() {
    page = await newPage();
    await page.loadData();
    expect(page.journal.enabled).toBe(true);
    expect(io.alertError).not.toHaveBeenCalled();
    expect(get(page.stores.loadedStore)).toBe(true);
    await drain();
    await page.cache.whenBootCacheSettled();
    return page;
}

async function closePage() {
    page?.sync.stopResourceSync();
    await page?.journal.close();
    visibilityStops.splice(0).forEach((stop) => stop());
    for (const [target, name, listener] of listeners.splice(0)) target.removeEventListener(name, listener);
    const now = Date.now();
    vi.clearAllTimers();
    vi.setSystemTime(now);
    page = undefined;
}

afterEach(async () => {
    for (const previous of previousServers) previous.releaseBatch?.();
    server?.releaseBatch?.();
    server?.releaseBatchResponse?.();
    await closePage();
    await drain();
    vi.clearAllTimers();
    if (originalSw) Object.defineProperty(navigator, "serviceWorker", originalSw);
    else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    server?.close();
    previousServers.splice(0).forEach((previous) => previous.close());
});

describe("boot plugin permissions", () => {
    it("installs boot grants before browser-local import without a permissions read", async () => {
        server.set("pluginPermissions", "main", {
            grants: { boot: true },
            lastGrantTime: { boot_lastGrantTime: 42 },
        });
        const permissions = await import("./plugins/apiV3/permissionStore");
        const { importBrowserLocalData } = await import("./storage/browserLocalImport");
        let beforeImport: [boolean, number | undefined] | undefined;
        vi.mocked(importBrowserLocalData).mockImplementationOnce(async () => {
            beforeImport = [permissions.hasPermissionGrant("boot"), permissions.getLastGrantTime("boot_lastGrantTime")];
        });

        await boot();
        expect(beforeImport).toEqual([true, 42]);
        expect(permissions.hasPermissionGrant("boot")).toBe(true);
        expect(permissions.getLastGrantTime("boot_lastGrantTime")).toBe(42);
        expect(
            server.requests.filter(
                ({ method, path }) => method === "GET" && path === "/api/resources/pluginPermissions/main",
            ),
        ).toEqual([]);
    });

    it("picks up a grant committed between the boot read and the first hello reconcile", async () => {
        server.set("pluginPermissions", "main", { grants: { boot: true }, lastGrantTime: {} });
        const permissions = await import("./plugins/apiV3/permissionStore");
        const { importBrowserLocalData } = await import("./storage/browserLocalImport");
        vi.mocked(importBrowserLocalData).mockImplementationOnce(async () => {
            // The boot answer has been read, but the event feed has not started yet.
            server.set("pluginPermissions", "main", {
                grants: { boot: true, remote: true },
                lastGrantTime: { remote_lastGrantTime: 99 },
            });
        });
        const current = await boot();
        expect(permissions.hasPermissionGrant("boot")).toBe(true);
        expect(permissions.hasPermissionGrant("remote")).toBe(false);
        server.requests.length = 0;

        // The first hello hands its revision listing to this public boundary. The boot has
        // registered the real permission owner; an empty write waits for its queued refresh.
        current.sync.reconcileRemote(server.store.listRevisions());
        await permissions.recordPermissionGrants({});

        expect(permissions.hasPermissionGrant("remote")).toBe(true);
        expect(permissions.getLastGrantTime("remote_lastGrantTime")).toBe(99);
        expect(
            server.requests
                .filter(({ path }) => path === "/api/resources/pluginPermissions/main")
                .map(({ method }) => method),
        ).toEqual(["GET"]);
    });
});

describe("boot after a restore snapshot", () => {
    it("lists every old-epoch snapshot entry as an export-only draft without replaying its intent", async () => {
        const first = await boot();
        await tick();
        await first.sync.flushResources();
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
        await drain();
        await first.chat.ensureChatLoaded(refK);
        const oldEpoch = server.store.epoch();
        const tabId = first.journal.tabId;
        const ui = plain(server.record("ui", "main"));
        const character = plain(server.record("characters", "c"));
        const chatBase = server.chat("c", "k")!.revision;
        const orderBase = server.order("c")!.revision;
        server.failNext = {
            status: 400,
            times: 1,
            match: (path) => path === "/api/resources/batch",
            body: { error: "ops[0]: refused description" },
        };
        first.characters.updateCharacter("c", { desc: "refused description" });
        await vi.advanceTimersByTimeAsync(1000);
        await drain();
        expect(first.sync.refusedItems()).toEqual([
            expect.objectContaining({ resourceKind: "characters", id: "c", reason: "ops[0]: refused description" }),
        ]);
        io.alertError.mockClear();
        server.holdNextBatch = true;
        first.settings.ui.theme = "sent theme";
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
        expect(server.releaseBatch).not.toBeNull();
        await drain();
        first.settings.ui.theme = "unsent theme";
        first.chat.setMessageText(refK, "a", "unsent message");
        first.chat.reorderChats("c", ["j", "k"]);

        // A restore replaces the server's entire store. A subsequent read announces its new epoch.
        const previous = server;
        previousServers.push(previous);
        server = await restoredServer("restored");
        io.fetch = (await recoveryBootServer(server)).fetch;
        expect(server.store.epoch()).not.toBe(oldEpoch);
        const client = await import("./storage/resourceClient");
        await expect(client.getResource("ui", "main")).rejects.toBeInstanceOf(client.ResourceEpochMismatchError);
        await drain();
        expect(io.alertTerminal).toHaveBeenCalledOnce();
        expect(location.reload).toHaveBeenCalledOnce();
        const snapshot = await first.journal.readOwn();
        expect(snapshot).toHaveLength(4);
        // Assert the live edits, not merely whichever rows the implementation happened to retain.
        const intent = (theme: string) => ({
            op: "update",
            baseRevision: ui.revision,
            text: JSON.stringify({ ...ui.data, theme }),
        });
        expect(
            snapshot.map(({ scope, target, epoch, layers }) => ({
                scope,
                target,
                epoch,
                layers: Object.fromEntries(Object.entries(layers).map(([name, layer]) => [name, layer.value])),
            })),
        ).toEqual(
            expect.arrayContaining([
                {
                    scope: "record",
                    target: UI,
                    epoch: oldEpoch,
                    layers: {
                        sent: { ...intent("sent theme"), dispatched: true, inDoubt: false },
                        latest: intent("unsent theme"),
                    },
                },
                {
                    scope: "record",
                    target: CHARACTER,
                    epoch: oldEpoch,
                    layers: {
                        refused: {
                            op: "update",
                            text: JSON.stringify({ ...character.data, desc: "refused description" }),
                            reason: "ops[0]: refused description",
                        },
                    },
                },
                {
                    scope: "chat",
                    target: "c\0k",
                    epoch: oldEpoch,
                    layers: {
                        pending: {
                            ops: [
                                {
                                    op: { op: "setText", id: "a", text: "unsent message" },
                                    before: { value: "original message" },
                                },
                            ],
                            baseRevision: chatBase,
                            groupId: expect.any(String),
                        },
                    },
                },
                {
                    scope: "order",
                    target: "c",
                    epoch: oldEpoch,
                    layers: { latest: { ids: ["j", "k"], baseRevision: orderBase } },
                },
            ]),
        );
        previous.releaseBatch!();
        await drain();
        expect(await first.journal.readOwn()).toEqual(snapshot);
        await closePage();
        expect(locks.held().filter((name) => name.startsWith("risu-journal-owner:"))).toEqual([]);
        vi.resetModules();
        server.requests.length = 0;

        const second = await boot();
        expect(second.journal.tabId).toBe(tabId);
        const { recoveryDraftDetails } = await import("./storage/journalRecovery");
        const { language } = await import("../lang");
        const drafts = await second.journal.listDrafts();
        expect(drafts).toHaveLength(4);
        expect(second.recoveryDrafts.entries).toHaveLength(4);
        for (const row of snapshot) {
            const expected = { scope: row.scope, target: row.target, epoch: oldEpoch, layers: row.layers };
            expect(drafts).toContainEqual(expect.objectContaining(expected));
            expect(second.recoveryDrafts.entries).toContainEqual(
                expect.objectContaining({ ...expected, otherEpoch: true }),
            );
        }
        for (const draft of drafts) {
            expect(recoveryDraftDetails(draft)).toMatchObject({
                canApply: false,
                reason: language.recoveryDrafts.otherEpoch,
            });
        }
        expect(await second.journal.readOwn()).toEqual([]);
        expect(second.settings.ui.theme).toBe("restored theme");
        expect(second.characters.findCharacter("c")).toMatchObject({ desc: "restored description" });
        expect((await second.chat.ensureChatLoaded(refK))!.message).toEqual([m("a", "restored message")]);
        expect(second.chat.chatList("c").map((chat) => chat.id)).toEqual(["k", "j"]);
        await tick();
        await second.sync.flushResources();
        await vi.advanceTimersByTimeAsync(5000);
        await drain();
        expect(server.batchBodies()).toEqual([]);
        expect(await second.journal.listDrafts()).toEqual(drafts);
        expect(await second.journal.readOwn()).toEqual([]);
    });
});
