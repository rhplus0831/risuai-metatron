import { IDBDatabase, IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { tick } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftJournal, LayerWrites } from "./storage/draftJournal";
import { createFakeLockManager } from "./storage/tests/fakeLockManager";
import { StoreBackedServer } from "./storage/tests/storeBackedServer";
import { recoveryBootServer } from "./storage/tests/recoveryBootServer";
import { plain, warmModules } from "./storage/tests/mutationStoresHarness";

const io = vi.hoisted(() => ({
    fetch: null as null | ((path: string, init?: RequestInit) => Promise<Response>),
    alertError: vi.fn(),
}));
vi.mock("./storage/serverAuth", async () =>
    (await import("./tests/bootMocks")).createBootMock("serverAuth", {
        authFetch: (path, init) => io.fetch!(path, init),
    }),
);
vi.mock("./alert", async () => (await import("./tests/alertMock")).createAlertMock({ alertError: io.alertError }));
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

function latch() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const UI = "ui\0main";
const CHARACTER = "characters\0c";
const batchPath = (path: string) => path === "/api/resources/batch";
let server: StoreBackedServer;
let transport: Awaited<ReturnType<typeof recoveryBootServer>>;
let page: Awaited<ReturnType<typeof newPage>> | undefined;
let locks: ReturnType<typeof createFakeLockManager>;
let originalSw: PropertyDescriptor | undefined;
let listeners: [EventTarget, string, EventListenerOrEventListenerObject][] = [];
let visibilityStops: (() => void)[] = [];
const transactions = new Set<Promise<void>>();
const otherJournals: DraftJournal[] = [];
const releases: (() => void)[] = [];

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
    server = await StoreBackedServer.create();
    server.set("ui", "main", { ...server.record("ui", "main")!.data, didFirstSetup: true });
    server.set("modules", "main", []);
    server.set("plugins", "main", []);
    server.set("characters", "c", { chaId: "c", name: "Server character", desc: "Server description" });
    server.set("characterOrder", "main", ["c"]);
    transport = await recoveryBootServer(server);
    io.fetch = transport.fetch;
});

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

async function boot(current?: Awaited<ReturnType<typeof newPage>>) {
    page = current ?? (await newPage());
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
    // Clearing Sinon timers also resets its clock; a page reload does not age durable rows.
    const now = Date.now();
    vi.clearAllTimers();
    vi.setSystemTime(now);
    page = undefined;
}
async function reload() {
    const tab = sessionStorage.getItem("risu-journal-tab");
    const durable = await page!.journal.readOwn();
    await closePage();
    expect(locks.held().filter((name) => name.startsWith("risu-journal-owner:"))).toEqual([]);
    vi.resetModules();
    server.requests.length = 0;
    const fresh = await newPage();
    expect(await fresh.journal.start()).toBe(true);
    expect(fresh.journal.tabId).toBe(tab);
    expect(await fresh.journal.readOwn()).toEqual(durable);
    const next = await boot(fresh);
    expect(next.journal.tabId).toBe(tab);
    return next;
}
async function flush() {
    await tick();
    await page!.sync.flushResources();
    await vi.advanceTimersByTimeAsync(500);
    await drain();
}
const ops = (kind?: string) =>
    server
        .batchBodies()
        .flatMap((body) => body.ops ?? [])
        .filter((op) => !kind || op.kind === kind);
// Assert the whole outgoing value whether the normal cycle chooses data or a field patch.
function writes(kind: string, base: Record<string, unknown>) {
    return ops(kind).map((op) => {
        if (!op.patch) return op;
        const { patch, ...rest } = op;
        const data = { ...base, ...patch.set };
        for (const key of patch.remove ?? []) delete data[key];
        expect(Object.keys(patch).every((key) => key === "set" || key === "remove")).toBe(true);
        return { ...rest, data };
    });
}
const intent = (text: string | null, baseRevision: string | null) => ({
    op: text === null ? ("delete" as const) : baseRevision === null ? ("create" as const) : ("update" as const),
    text,
    baseRevision,
});
async function put(journal: DraftJournal, target: string, layers: LayerWrites<"record">, epoch = server.store.epoch()) {
    expect(await journal.write([{ epoch, scope: "record", target, version: journal.nextVersion(), layers }])).toEqual([
        "written",
    ]);
}

// An actual edit and unanswered network write produce the durable row on the first page.
async function unanswered(edit: () => void, landed = false) {
    if (landed) server.dropNextBatchResponse = true;
    else server.failNext = { status: 0, times: 1, match: batchPath };
    edit();
    await vi.advanceTimersByTimeAsync(500);
    await drain();
    const rows = await page!.journal.readOwn();
    expect(rows.some((row) => row.scope === "record" && row.layers.sent)).toBe(true);
    return rows;
}

afterEach(async () => {
    releases.splice(0).forEach((release) => release());
    await closePage();
    await Promise.all(otherJournals.splice(0).map((journal) => journal.close()));
    server?.releaseBatch?.();
    server?.releaseBatchResponse?.();
    await drain();
    vi.clearAllTimers();
    if (originalSw) Object.defineProperty(navigator, "serviceWorker", originalSw);
    else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    server?.close();
});

describe("boot journal recovery", () => {
    it.each(["cache hit", "fallback"] as const)(
        "resends unanswered settings and character edits once through a %s, keeping the server baseline and cache",
        async (mode) => {
            const first = await boot();
            await flush();
            const ui = plain(server.record("ui", "main"));
            const character = plain(server.record("characters", "c"));
            await unanswered(() => {
                first.settings.ui.theme = "journal theme";
                first.characters.updateCharacter("c", { desc: "journal description" });
            });
            transport.fallback = mode === "fallback";
            const second = await reload();
            expect(second.settings.ui.theme).toBe("journal theme");
            expect(second.characters.findCharacter("c")).toMatchObject({ desc: "journal description" });
            expect(second.sync.heldRecordSnapshot("ui", "main")).toEqual({
                revision: ui.revision,
                text: JSON.stringify(ui.data),
            });
            expect(second.sync.heldRecordSnapshot("characters", "c")).toEqual({
                revision: character.revision,
                text: JSON.stringify(character.data),
            });
            expect((await second.journal.readOwn()).map((row) => row.target).sort()).toEqual([CHARACTER, UI]);
            if (mode === "cache hit") {
                expect(transport.bootAnswers.at(-1)!.kinds.characters).toContainEqual({
                    id: "c",
                    revision: character.revision,
                    cached: true,
                });
                expect(server.requests.some((request) => request.path === "/api/resources")).toBe(false);
                const { appVer } = await import("./storage/database.svelte");
                const cached = await second.cache.indexedDbBootCacheStore(appVer).load();
                expect(
                    cached.records.find((record) => record.kind === "characters" && record.id === "c"),
                ).toMatchObject({
                    revision: character.revision,
                    text: JSON.stringify(character.data),
                });
            } else {
                expect(server.requests.filter((request) => request.path === "/api/resources")).toHaveLength(1);
            }
            await flush();
            expect(ops()).toEqual(
                expect.arrayContaining([
                    { kind: "ui", id: "main", baseRevision: ui.revision, data: { ...ui.data, theme: "journal theme" } },
                    {
                        kind: "characters",
                        id: "c",
                        baseRevision: character.revision,
                        data: { ...character.data, desc: "journal description" },
                    },
                ]),
            );
            expect(ops()).toHaveLength(2);
            expect(await second.journal.readOwn()).toEqual([]);
            await reload();
            await flush();
            expect(ops()).toEqual([]);
            expect(page!.recoveryDrafts.entries).toEqual([]);
        },
    );

    it.each([false, true])(
        "recognizes a landed write and cleans every old layer (newer local text: %s)",
        async (newer) => {
            const first = await boot();
            await flush();
            await unanswered(() => {
                first.settings.ui.theme = "landed";
            }, true);
            if (newer) {
                first.settings.ui.theme = "newer";
                await vi.advanceTimersByTimeAsync(500);
                await drain();
            }
            const current = plain(server.record("ui", "main"));
            const second = await reload();
            expect(second.settings.ui.theme).toBe(newer ? "newer" : "landed");
            await flush();
            expect(writes("ui", current.data)).toEqual(
                newer
                    ? [
                          {
                              kind: "ui",
                              id: "main",
                              baseRevision: current.revision,
                              data: { ...current.data, theme: "newer" },
                          },
                      ]
                    : [],
            );
            expect(await second.journal.readOwn()).toEqual([]);
            await reload();
            await flush();
            expect(ops()).toEqual([]);
            expect(page!.recoveryDrafts.entries).toEqual([]);
        },
    );

    it("resends the unresolved sent text before newer local text on the acknowledged revision", async () => {
        const first = await boot();
        await flush();
        const base = plain(server.record("ui", "main"));
        await unanswered(() => {
            first.settings.ui.theme = "sent";
        });
        first.settings.ui.theme = "newer";
        await vi.advanceTimersByTimeAsync(500);
        await drain();
        const second = await reload();
        expect(second.settings.ui.theme).toBe("newer");
        server.holdNextBatchResponse = true;
        await vi.advanceTimersByTimeAsync(500);
        await drain();
        expect(server.releaseBatchResponse).not.toBeNull();
        expect(ops("ui")).toEqual([
            { kind: "ui", id: "main", baseRevision: base.revision, data: { ...base.data, theme: "sent" } },
        ]);
        const acknowledged = server.record("ui", "main")!.revision;
        server.releaseBatchResponse!();
        await drain();
        await flush();
        expect(ops("ui")).toEqual([
            { kind: "ui", id: "main", baseRevision: base.revision, data: { ...base.data, theme: "sent" } },
            { kind: "ui", id: "main", baseRevision: acknowledged, data: { ...base.data, theme: "newer" } },
        ]);
        expect(await second.journal.readOwn()).toEqual([]);
    });

    it("keeps a moved-base edit as a draft without overwriting the server", async () => {
        const first = await boot();
        await flush();
        const rows = await unanswered(() => {
            first.settings.ui.theme = "local";
        });
        server.set("ui", "main", { ...server.record("ui", "main")!.data, theme: "remote" });
        const second = await reload();
        expect(second.settings.ui.theme).toBe("remote");
        expect(second.recoveryDrafts.entries).toMatchObject([
            { target: UI, otherEpoch: false, layers: rows.find((row) => row.target === UI)!.layers },
        ]);
        expect(await second.journal.readOwn()).toEqual([]);
        expect(await second.journal.listDrafts()).toHaveLength(1);
        await flush();
        expect(ops()).toEqual([]);
    });

    it.each([false, true])("creates only an undispatched absent character (dispatched: %s)", async (dispatched) => {
        const first = await boot();
        await flush();
        first.characters.addCharacter({ chaId: "new-character", name: "Recovered", desc: "local create" });
        if (dispatched) {
            server.failNext = { status: 0, times: 1, match: batchPath };
            await vi.advanceTimersByTimeAsync(500);
        } else {
            // The lifecycle journal captures local work before the save debounce dispatches it.
            window.dispatchEvent(new Event("pagehide"));
        }
        await drain();
        const row = (await first.journal.readOwn()).find((entry) => entry.target === "characters\0new-character")!;
        expect(row).toBeDefined();
        expect(row.scope === "record" && !!row.layers.sent).toBe(dispatched);
        const text = row.scope === "record" ? (row.layers.latest ?? row.layers.sent)!.value.text! : "";
        const second = await reload();
        if (dispatched) {
            expect(second.characters.findCharacter("new-character")).toBeUndefined();
            expect(second.recoveryDrafts.entries).toMatchObject([{ target: row.target, layers: row.layers }]);
        } else {
            expect(second.characters.findCharacter("new-character")).toMatchObject({
                name: "Recovered",
                desc: "local create",
            });
            expect(second.chat.chatCount("new-character")).toBe(1);
        }
        await flush();
        expect(ops("characters")).toEqual(
            dispatched ? [] : [{ kind: "characters", id: "new-character", baseRevision: null, data: JSON.parse(text) }],
        );
        expect(await second.journal.readOwn()).toEqual([]);
    });
});

describe("boot recovery ownership and isolation", () => {
    it("recovers closed-tab work but leaves a live owner and current chat/order rows alone", async () => {
        const { createDraftJournal } = await import("./storage/draftJournal");
        const makeOwner = (id: string) => {
            const memory = new Map([["risu-journal-tab", id]]);
            const owner = createDraftJournal({
                storage: () => ({
                    getItem: (key) => memory.get(key) ?? null,
                    setItem: (key, value) => {
                        memory.set(key, value);
                    },
                    removeItem: (key) => {
                        memory.delete(key);
                    },
                    clear: () => memory.clear(),
                    key: (index) => [...memory.keys()][index] ?? null,
                    get length() {
                        return memory.size;
                    },
                }),
            });
            otherJournals.push(owner);
            return owner;
        };
        const orphan = makeOwner("closed-tab");
        const live = makeOwner("live-tab");
        expect(await orphan.start()).toBe(true);
        expect(await live.start()).toBe(true);
        const ui = plain(server.record("ui", "main"));
        const character = plain(server.record("characters", "c"));
        await put(orphan, UI, { latest: intent(JSON.stringify({ ...ui.data, theme: "orphan theme" }), ui.revision) });
        await put(live, CHARACTER, {
            latest: intent(JSON.stringify({ ...character.data, desc: "live owner text" }), character.revision),
        });
        const liveRows = await live.readOwn();
        const createdAt = (await orphan.readOwn())[0].createdAt;
        await orphan.close();
        page = await newPage();
        expect(await page.journal.start()).toBe(true);
        expect(
            await page.journal.write([
                {
                    epoch: server.store.epoch(),
                    scope: "chat",
                    target: "c\0chat",
                    version: page.journal.nextVersion(),
                    layers: { pending: { ops: [], baseRevision: "chat-base", groupId: "unsent-group" } },
                },
                {
                    epoch: server.store.epoch(),
                    scope: "order",
                    target: "c",
                    version: page.journal.nextVersion(),
                    layers: { latest: { ids: ["chat"], baseRevision: "order-base" } },
                },
            ]),
        ).toEqual(["written", "written"]);
        const untouched = await page.journal.readOwn();
        await page.loadData();
        expect(io.alertError).not.toHaveBeenCalled();
        expect(get(page.stores.loadedStore)).toBe(true);
        expect(page.settings.ui.theme).toBe("orphan theme");
        expect(page.characters.findCharacter("c")).toMatchObject({ desc: "Server description" });
        expect((await page.journal.readOwn()).find((row) => row.target === UI)).toMatchObject({
            tabId: page.journal.tabId,
            createdAt,
        });
        await flush();
        expect(writes("ui", ui.data)).toEqual([
            { kind: "ui", id: "main", baseRevision: ui.revision, data: { ...ui.data, theme: "orphan theme" } },
        ]);
        expect(await page.journal.readOwn()).toEqual(untouched);
        expect(await live.readOwn()).toEqual(liveRows);
        expect(page.recoveryDrafts.entries).toEqual([]);
    });

    it("lists other epochs, refused records and malformed records as durable drafts without replay", async () => {
        page = await newPage();
        expect(await page.journal.start()).toBe(true);
        const ui = plain(server.record("ui", "main"));
        const character = plain(server.record("characters", "c"));
        await put(
            page.journal,
            UI,
            { latest: intent(JSON.stringify({ ...ui.data, theme: "old epoch" }), ui.revision) },
            "previous-epoch",
        );
        await put(page.journal, CHARACTER, {
            refused: {
                op: "update",
                text: JSON.stringify({ ...character.data, desc: "refused" }),
                reason: "validation",
            },
        });
        await put(page.journal, "modules\0main", {
            latest: intent('{"wrong":"shape"}', server.record("modules", "main")!.revision),
        });
        expect(
            await page.journal.write([
                {
                    epoch: "previous-epoch",
                    scope: "chat",
                    target: "c\0old-chat",
                    version: page.journal.nextVersion(),
                    layers: { pending: { ops: [], baseRevision: "old-chat-base", groupId: "old-group" } },
                },
                {
                    epoch: "previous-epoch",
                    scope: "order",
                    target: "c",
                    version: page.journal.nextVersion(),
                    layers: { latest: { ids: ["old-chat"], baseRevision: "old-order-base" } },
                },
            ]),
        ).toEqual(["written", "written"]);
        const before = await page.journal.readOwn();
        await page.loadData();
        expect(get(page.stores.loadedStore)).toBe(true);
        expect(io.alertError).not.toHaveBeenCalled();
        expect(page.recoveryDrafts.entries).toHaveLength(5);
        for (const row of before) {
            expect(page.recoveryDrafts.entries).toContainEqual(
                expect.objectContaining({
                    target: row.target,
                    epoch: row.epoch,
                    layers: row.layers,
                    otherEpoch: row.epoch === "previous-epoch",
                }),
            );
        }
        expect(await page.journal.listDrafts()).toHaveLength(5);
        expect(await page.journal.readOwn()).toEqual([]);
        expect(page.settings.ui.theme).toBe(ui.data.theme);
        expect(page.characters.findCharacter("c")).toMatchObject({ desc: character.data.desc });
        await flush();
        expect(ops("ui")).toEqual([]);
        expect(ops("characters")).toEqual([]);
        expect(ops("modules")).toEqual([]);
    });

    it("applies a recovered character deletion before repairing its order and initializing chats", async () => {
        page = await newPage();
        expect(await page.journal.start()).toBe(true);
        const base = server.record("characters", "c")!.revision;
        await put(page.journal, CHARACTER, { latest: intent(null, base) });
        await page.loadData();
        expect(get(page.stores.loadedStore)).toBe(true);
        expect(io.alertError).not.toHaveBeenCalled();
        expect(page.characters.findCharacter("c")).toBeUndefined();
        expect((await import("./storage/records.svelte")).recordData("characterOrder")).toEqual([]);
        expect(page.chat.chatCount("c")).toBe(0);
        await flush();
        expect(ops("characters")).toEqual([{ kind: "characters", id: "c", baseRevision: base, delete: true }]);
        expect(server.batchBodies().flatMap((body) => body.chats ?? [])).toEqual([]);
        expect(await page.journal.readOwn()).toEqual([]);
    });

    it("awaits recovery before the service worker and lets recovered intent override first-boot defaults", async () => {
        server.set("ui", "main", { ...server.record("ui", "main")!.data, didFirstSetup: false });
        page = await newPage();
        expect(await page.journal.start()).toBe(true);
        const ui = plain(server.record("ui", "main"));
        await put(page.journal, UI, { latest: intent(JSON.stringify({ ...ui.data, language: "ko" }), ui.revision) });
        const drafts = page.journal.listDrafts.bind(page.journal);
        const reached = latch();
        const release = latch();
        releases.push(() => release.resolve());
        vi.spyOn(page.journal, "listDrafts").mockImplementation(async () => {
            const rows = await drafts();
            reached.resolve();
            await release.promise;
            return rows;
        });
        const sw = vi.fn(() => undefined);
        Object.defineProperty(navigator, "serviceWorker", { configurable: true, get: sw });
        const loading = page.loadData();
        await reached.promise;
        expect(sw).not.toHaveBeenCalled();
        expect(get(page.stores.loadedStore)).toBe(false);
        release.resolve();
        await loading;
        expect(get(page.stores.loadedStore)).toBe(true);
        expect(page.settings.ui).toMatchObject({ language: "ko" });
        expect(sw).toHaveBeenCalled();
        await flush();
        expect(writes("ui", ui.data)).toEqual([
            { kind: "ui", id: "main", baseRevision: ui.revision, data: { ...ui.data, language: "ko" } },
        ]);
    });

    it("continues boot at the recovery deadline, closes the journal and rejects a late installation", async () => {
        page = await newPage();
        expect(await page.journal.start()).toBe(true);
        const ui = plain(server.record("ui", "main"));
        await put(page.journal, UI, { latest: intent(JSON.stringify({ ...ui.data, theme: "too late" }), ui.revision) });
        const list = page.journal.listDrafts.bind(page.journal);
        const reached = latch();
        const release = latch();
        releases.push(() => release.resolve());
        vi.spyOn(page.journal, "listDrafts").mockImplementation(async () => {
            const rows = await list();
            reached.resolve();
            await release.promise;
            return rows;
        });
        const loading = page.loadData();
        await reached.promise;
        await vi.advanceTimersByTimeAsync(4999);
        expect(get(page.stores.loadedStore)).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await loading;
        expect(get(page.stores.loadedStore)).toBe(true);
        expect(page.journal.enabled).toBe(false);
        expect(locks.held()).toEqual([]);
        expect(page.settings.ui.theme).toBe(ui.data.theme);
        release.resolve();
        await drain();
        expect(page.settings.ui.theme).toBe(ui.data.theme);
        expect(page.recoveryDrafts.entries).toEqual([]);
        await flush();
        expect(ops("ui")).toEqual([]);
    });
});
