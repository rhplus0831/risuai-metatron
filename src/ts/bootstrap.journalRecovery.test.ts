import { IDBDatabase, IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { tick } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatOp } from "../../shared/chats.ts";
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
    it("applying a recovered ui draft repaints colors, text, custom CSS, speed, and sizes without reloading", async () => {
        const initial = plain(server.record("ui", "main")!.data);
        server.set("ui", "main", {
            ...initial,
            colorScheme: { ...initial.colorScheme, type: "dark", bgcolor: "#111111" },
            textTheme: "standard",
            customCSS: "",
            animationSpeed: 1,
            sideBarSize: 0,
        });
        const current = await boot();
        await flush();
        const css = (name: string) => document.documentElement.style.getPropertyValue(name);
        expect(css("--risu-theme-bgcolor")).toBe("#111111");
        expect(css("--FontColorStandard")).toBe("#fafafa");
        expect(get(current.stores.CustomCSSStore)).toBe("");
        expect(css("--risu-animation-speed")).toBe("1s");
        expect(css("--sidebar-size")).toBe("24rem");

        const recovered = {
            ...plain(current.settings.ui),
            colorScheme: { ...plain(current.settings.ui.colorScheme), type: "light", bgcolor: "#eeeeee" },
            customCSS: ".chattext { letter-spacing: 2px; }",
            animationSpeed: 0.7,
            sideBarSize: 3,
        };
        const id = await current.journal.putDraft({
            epoch: server.store.epoch(),
            scope: "record",
            target: UI,
            layers: { latest: intent(JSON.stringify(recovered), server.record("ui", "main")!.revision) },
        });
        expect(id).not.toBeNull();
        await current.recoveryDrafts.refresh();
        const draft = current.recoveryDrafts.entries.find((entry) => entry.id === id)!;
        expect(draft).toBeDefined();
        const { applyRecoveryDraft } = await import("./storage/journalRecovery");

        expect(await applyRecoveryDraft(draft)).toEqual({ skipped: [] });

        expect(css("--risu-theme-bgcolor")).toBe("#eeeeee");
        expect(document.documentElement.style.colorScheme).toBe("light");
        expect(css("--FontColorStandard")).toBe("#0f172a");
        expect(get(current.stores.CustomCSSStore)).toBe(".chattext { letter-spacing: 2px; }");
        expect(css("--risu-animation-speed")).toBe("0.7s");
        expect(css("--sidebar-size")).toBe("36rem");
        expect(location.reload).not.toHaveBeenCalled();
    });

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
        const chatRow = (await first.journal.readOwn()).find(
            (entry) => entry.scope === "chat" && entry.target.startsWith("new-character\0"),
        );
        // Its first chat's create is queued when the character is added, so the journal holds it either way.
        expect(chatRow).toBeDefined();
        const second = await reload();
        if (dispatched) {
            expect(second.characters.findCharacter("new-character")).toBeUndefined();
            // The dispatched create's first chat went out with it; its parent is absent, so it is a draft too.
            expect(second.recoveryDrafts.entries).toHaveLength(2);
            expect(second.recoveryDrafts.entries).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ target: row.target, layers: row.layers }),
                    expect.objectContaining({ scope: "chat", target: chatRow!.target, layers: chatRow!.layers }),
                ]),
            );
        } else {
            expect(second.characters.findCharacter("new-character")).toMatchObject({
                name: "Recovered",
                desc: "local create",
            });
            expect(second.chat.chatList("new-character").map((chat) => chat.id)).toEqual([
                chatRow!.target.split("\0")[1],
            ]);
        }
        await flush();
        expect(ops("characters")).toEqual(
            dispatched ? [] : [{ kind: "characters", id: "new-character", baseRevision: null, data: JSON.parse(text) }],
        );
        await drain();
        expect(await second.journal.readOwn()).toEqual([]);
    });
});

describe("boot recovery ownership and isolation", () => {
    it("recovers closed-tab work, leaves a live owner alone, and drafts chat/order rows naming a chat the server lacks", async () => {
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
        const chatRows = await page.journal.readOwn();
        expect(chatRows).toHaveLength(2);
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
        // The server holds no chat "chat": its pending row and the order naming it become drafts with
        // their layers as journaled, and nothing is sent for them.
        const chatWork = server
            .batchBodies()
            .flatMap((body: { chats?: { chatId: string }[]; chatOrders?: unknown[] }) => [
                ...(body.chats ?? []).filter((group) => group.chatId === "chat"),
                ...(body.chatOrders ?? []),
            ]);
        expect(chatWork).toEqual([]);
        expect(await page.journal.readOwn()).toEqual([]);
        expect(await live.readOwn()).toEqual(liveRows);
        expect(page.recoveryDrafts.entries).toHaveLength(2);
        expect(page.recoveryDrafts.entries).toEqual(
            expect.arrayContaining(
                chatRows.map((row) =>
                    expect.objectContaining({ scope: row.scope, target: row.target, layers: row.layers }),
                ),
            ),
        );
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

const ref = (chatId = "chat") => ({ chaId: "c", chatId });
const chatGroups = () => server.batchBodies().flatMap((body) => body.chats ?? []);
const chatOrders = () => server.batchBodies().flatMap((body) => body.chatOrders ?? []);
const chatReads = () =>
    server.requests.flatMap((request) => (request.path === "/api/resources/read" ? (request.body?.chats ?? []) : []));
function seedChats(ids = ["chat", "untouched"]) {
    for (const id of ids) {
        server.chatBatch([
            {
                characterId: "c",
                chatId: id,
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id,
                            name: id,
                            note: "",
                            localLore: [],
                            message: [
                                { chatId: "m", role: "user", data: "before" },
                                { chatId: "n", role: "char", data: "second" },
                            ],
                        },
                    },
                ],
            },
        ]);
    }
}
function remoteChat(ops: import("../../shared/chats").ChatOp[], chatId = "chat", groupId?: string) {
    return server.chatBatch([
        {
            characterId: "c",
            chatId,
            baseRevision: server.chat("c", chatId)!.revision,
            ops,
            ...(groupId ? { groupId } : {}),
        },
    ]);
}
async function hideUnsent() {
    // A synchronous transport failure leaves the pending batch undispatched, with its before values.
    vi.stubGlobal(
        "fetch",
        vi.fn(() => {
            throw new TypeError("Page closed before keepalive dispatch");
        }),
    );
    window.dispatchEvent(new Event("pagehide"));
    await drain();
    return page!.journal.readOwn();
}

describe("Apply preserves refused recovery memory", () => {
    const hypaV3Data = {
        summaries: [{ text: "Memory from the recovery draft", chatMemos: ["m"], isImportant: false }],
    };
    const memoryOp = { op: "meta", set: { hypaV3Data } } satisfies ChatOp;
    const mixedOp = { op: "meta", set: { note: "Recovered note", hypaV3Data } } satisfies ChatOp;

    async function setupDraft(ops: ChatOp[], chatId = "chat") {
        seedChats();
        server.set("ui", "main", { ...server.record("ui", "main")!.data, memoryAlgorithmType: "structuredMemory" });
        const current = await boot();
        await flush();
        const id = await current.journal.putDraft({
            epoch: server.store.epoch(),
            scope: "chat",
            target: `c\0${chatId}`,
            createdAt: Date.now() - 60_000,
            layers: {
                pending: {
                    baseRevision: server.chat("c", chatId)?.revision ?? null,
                    groupId: "recovered-memory-group",
                    ops: ops.map((op) => ({ op })),
                },
            },
        });
        expect(id).not.toBeNull();
        await current.recoveryDrafts.refresh();
        const draft = (await current.journal.listDrafts()).find((entry) => entry.id === id)!;
        expect(draft).toBeDefined();
        const { applyRecoveryDraft } = await import("./storage/journalRecovery");
        const { alertToast } = await import("./alert");
        const toast = vi.mocked(alertToast).mockClear();
        server.requests.length = 0;
        return { current, draft, applyRecoveryDraft, toast };
    }

    it("files refused memory before saving the other edits and can apply it after switching to HypaV3", async () => {
        const { current, draft, applyRecoveryDraft, toast } = await setupDraft([mixedOp]);
        await current.chat.ensureChatLoaded(ref());
        const heldMemory = current.chat.findChat(ref())!.hypaV3Data;
        let draftsAtFlush: Awaited<ReturnType<DraftJournal["listDrafts"]>> | undefined;
        io.fetch = async (path, init) => {
            if (batchPath(path)) draftsAtFlush = await current.journal.listDrafts();
            return transport.fetch(path, init);
        };

        expect(await applyRecoveryDraft(draft)).toEqual({ skipped: [], memoryKept: "filed" });
        expect(current.chat.findChat(ref())!.note).toBe("Recovered note");
        expect(current.chat.findChat(ref())!.hypaV3Data).toEqual(heldMemory);
        expect(server.chat("c", "chat")!.data.note).toBe("Recovered note");
        expect(server.chat("c", "chat")!.data).not.toHaveProperty("hypaV3Data");
        expect(toast).not.toHaveBeenCalled();

        const drafts = await current.journal.listDrafts();
        expect(drafts).toHaveLength(1);
        const [filed] = drafts;
        expect(filed.id).not.toBe(draft.id);
        expect(filed).toMatchObject({
            scope: "chat",
            target: "c\0chat",
            epoch: draft.epoch,
            createdAt: draft.createdAt,
            layers: { pending: { value: { ops: [{ op: memoryOp }] } } },
        });
        expect(draftsAtFlush).toHaveLength(2);
        expect(draftsAtFlush).toEqual(expect.arrayContaining([draft, filed]));

        current.settings.ui.memoryAlgorithmType = "hypaMemoryV3";
        expect(await applyRecoveryDraft(filed)).toEqual({ skipped: [] });
        expect(current.chat.findChat(ref())!.hypaV3Data).toEqual(hypaV3Data);
        expect(server.chat("c", "chat")!.data).toMatchObject({ note: "Recovered note", hypaV3Data });
        expect(await current.journal.listDrafts()).toEqual([]);
    });

    it("keeps a memory-only refusal as the original durable draft", async () => {
        const { current, draft, applyRecoveryDraft } = await setupDraft([memoryOp]);
        const before = plain(server.chat("c", "chat"));

        expect(await applyRecoveryDraft(draft)).toEqual({ skipped: [], memoryKept: "kept" });
        expect(await current.journal.listDrafts()).toEqual([draft]);
        expect(server.chat("c", "chat")).toEqual(before);
        expect(current.chat.findChat(ref())!.hypaV3Data).not.toEqual(hypaV3Data);
        expect(chatGroups()).toEqual([]);
    });

    it.each(["existing", "recreated"] as const)(
        "retries Apply after a lost save response without duplicating refused memory (%s chat)",
        async (kind) => {
            const ops: ChatOp[] =
                kind === "existing"
                    ? [mixedOp]
                    : [
                          {
                              op: "create",
                              chat: { id: "gone", name: "Recovered chat", note: "", localLore: [], message: [] },
                          },
                          mixedOp,
                      ];
            const { current, draft, applyRecoveryDraft } = await setupDraft(ops, kind === "existing" ? "chat" : "gone");
            server.dropNextBatchResponse = true;

            await expect(applyRecoveryDraft(draft)).rejects.toThrow();
            await drain();
            const drafts = await current.journal.listDrafts();
            expect(drafts).toHaveLength(2);
            expect(drafts).toContainEqual(draft);
            const filed = drafts.find((entry) => entry.id !== draft.id)!;
            const chatId = kind === "existing" ? "chat" : draft.id;
            expect(filed).toMatchObject({
                scope: "chat",
                target: `c\0${chatId}`,
                epoch: draft.epoch,
                createdAt: draft.createdAt,
                layers: { pending: { value: { ops: [{ op: memoryOp }] } } },
            });
            expect(server.chat("c", chatId)!.data.note).toBe("Recovered note");
            expect(server.chat("c", chatId)!.data).not.toHaveProperty("hypaV3Data");

            const second = await reload();
            const retained = second.recoveryDrafts.entries.find((entry) => entry.id === draft.id)!;
            expect(retained).toBeDefined();
            const freshRecovery = await import("./storage/journalRecovery");
            expect(await freshRecovery.applyRecoveryDraft(retained)).toEqual({ skipped: [], memoryKept: "filed" });
            expect(await second.journal.listDrafts()).toEqual([filed]);
            expect(server.chat("c", chatId)!.data.note).toBe("Recovered note");
            expect(server.chat("c", chatId)!.data).not.toHaveProperty("hypaV3Data");
        },
    );

    it("rejects Apply and keeps the source when refused memory cannot be filed", async () => {
        const { current, draft, applyRecoveryDraft } = await setupDraft([mixedOp]);
        vi.spyOn(current.journal, "putDraft").mockResolvedValueOnce(null);
        const { language } = await import("../lang");

        await expect(applyRecoveryDraft(draft)).rejects.toThrow(language.recoveryDrafts.memoryDraftFailed);
        expect(await current.journal.listDrafts()).toEqual([draft]);
        expect(server.chat("c", "chat")!.data).not.toHaveProperty("hypaV3Data");
    });
});

describe("boot recovery of chat work", () => {
    it("retries a remembered group with its original request and hands the settled chat to the new journal", async () => {
        seedChats();
        const first = await boot();
        await flush();
        await first.chat.ensureChatLoaded(ref());
        const baseRevision = server.chat("c", "chat")!.revision;
        const edit = { op: "setText" as const, id: "m", text: "sent text" };
        server.requests.length = 0;
        let earlierAnswer: unknown;
        io.fetch = async (path, init) => {
            const answer = await transport.fetch(path, init);
            if (batchPath(path)) {
                earlierAnswer = await answer.json();
                throw new TypeError("Lost committed answer");
            }
            return answer;
        };
        first.chat.setMessageText(ref(), "m", edit.text);
        await vi.advanceTimersByTimeAsync(500);
        await drain();
        const original = plain(chatGroups()[0]);
        expect(original).toEqual({
            characterId: "c",
            chatId: "chat",
            groupId: expect.any(String),
            baseRevision,
            ops: [edit],
        });
        expect(await first.journal.readOwn()).toMatchObject([
            {
                scope: "chat",
                layers: {
                    resend: {
                        value: {
                            groupId: original.groupId,
                            baseRevision,
                            ops: [edit],
                        },
                    },
                },
            },
        ]);
        // Applying this setText a second time would clobber a later edit; an append would not prove deduplication.
        remoteChat([{ op: "setText", id: "m", text: "remote after commit" }]);
        const current = plain(server.chat("c", "chat"));
        const answers: unknown[] = [];
        io.fetch = async (path, init) => {
            const answer = await transport.fetch(path, init);
            if (batchPath(path)) answers.push(await answer.clone().json());
            return answer;
        };
        const second = await reload();
        expect(chatReads()).toEqual([]);
        await flush();
        expect(chatGroups()).toEqual([{ ...original, retry: true }]);
        expect(answers).toEqual([earlierAnswer]);
        expect(server.chat("c", "chat")).toEqual(current);
        expect(await second.journal.readOwn()).toEqual([]);
        expect(second.recoveryDrafts.entries).toEqual([]);

        await second.chat.ensureChatLoaded(ref());
        second.chat.setMessageText(ref(), "m", "edited on the new page");
        const rows = await hideUnsent();
        expect(rows).toMatchObject([
            {
                scope: "chat",
                target: "c\0chat",
                layers: {
                    pending: {
                        value: {
                            baseRevision: current!.revision,
                            ops: [
                                {
                                    op: { op: "setText", id: "m", text: "edited on the new page" },
                                    before: { value: "remote after commit" },
                                },
                            ],
                        },
                    },
                },
            },
        ]);
    });

    it.each(["before", "landed", "remote", "stale message", "missing message"] as const)(
        "checks an unloaded chat's by-id target at boot: %s",
        async (outcome) => {
            seedChats();
            const first = await boot();
            await flush();
            expect(first.chat.findChat(ref())).toBeUndefined();
            await first.chat.ensureChatLoaded(ref());
            const baseRevision = server.chat("c", "chat")!.revision;
            if (outcome === "stale message") {
                first.chat.replaceMessage(ref(), { chatId: "m", role: "user", data: "local" });
            } else first.chat.setMessageText(ref(), "m", "local");
            const rows = await hideUnsent();
            const row = rows.find((entry) => entry.scope === "chat")!;
            expect(row.scope).toBe("chat");
            if (row.scope !== "chat") throw new Error("Missing chat journal row");
            const pending = row.layers.pending!.value;
            expect(row.layers.resend).toBeUndefined();
            if (outcome === "before") remoteChat([{ op: "meta", set: { note: "unrelated remote edit" } }]);
            if (outcome === "landed") remoteChat([{ op: "setText", id: "m", text: "local" }]);
            if (outcome === "remote") remoteChat([{ op: "setText", id: "m", text: "remote" }]);
            if (outcome === "stale message")
                remoteChat([{ op: "patchMessage", id: "m", set: { saying: "remote speaker" } }]);
            if (outcome === "missing message") remoteChat([{ op: "remove", ids: ["m"] }]);
            const current = plain(server.chat("c", "chat"));
            const second = await reload();
            expect(chatReads()).toEqual([{ characterId: "c", id: "chat" }]);
            expect(second.chat.findChat(ref("untouched"))).toBeUndefined();
            await flush();
            if (outcome === "before") {
                expect(chatGroups()).toEqual([
                    {
                        characterId: "c",
                        chatId: "chat",
                        groupId: pending.groupId,
                        baseRevision,
                        ops: [{ op: "setText", id: "m", text: "local" }],
                        retry: true,
                    },
                ]);
                expect(server.texts("c", "chat")).toEqual(["local", "second"]);
                expect(second.chat.findChat(ref())?.message[0].data).toBe("local");
                expect(second.recoveryDrafts.entries).toEqual([]);
            } else {
                expect(chatGroups()).toEqual([]);
                expect(server.chat("c", "chat")).toEqual(current);
                if (outcome === "landed") {
                    expect(second.recoveryDrafts.entries).toEqual([]);
                    expect(await second.journal.listDrafts()).toEqual([]);
                } else {
                    expect(second.recoveryDrafts.entries).toMatchObject([
                        {
                            scope: "chat",
                            target: row.target,
                            otherEpoch: false,
                            layers: row.layers,
                        },
                    ]);
                    expect(await second.journal.listDrafts()).toMatchObject([{ scope: "chat", layers: row.layers }]);
                    const recovery = await import("./storage/journalRecovery");
                    const draft = second.recoveryDrafts.entries[0];
                    expect(recovery.recoveryDraftDetails(draft).canApply).toBe(true);
                    if (outcome === "remote") {
                        await recovery.applyRecoveryDraft(draft);
                        await flush();
                        expect(server.texts("c", "chat")).toEqual(["local", "second"]);
                        expect(await second.journal.listDrafts()).toEqual([]);
                    }
                }
            }
            expect(await second.journal.readOwn()).toEqual([]);
        },
    );

    it.each([false, true])("recovers an order only if no remote reorder intervened (remote: %s)", async (remote) => {
        seedChats(["a", "b", "c"]);
        const first = await boot();
        await flush();
        const baseRevision = server.order("c")!.revision;
        const localIds = ["b", "a", "c"];
        first.chat.reorderChats("c", localIds);
        const row = (await hideUnsent()).find((entry) => entry.scope === "order")!;
        expect(row).toBeDefined();
        if (remote)
            server.store.applyChanges({
                chatOrders: [{ characterId: "c", baseRevision, ids: ["c", "b", "a"] }],
            });
        const second = await reload();
        expect(second.chat.chatList("c").map((chat) => chat.id)).toEqual(remote ? ["c", "b", "a"] : localIds);
        const drafts = remote ? [{ scope: "order", layers: row.layers }] : [];
        expect(second.recoveryDrafts.entries).toMatchObject(drafts);
        expect(await second.journal.listDrafts()).toMatchObject(drafts);
        await flush();
        expect(chatOrders()).toEqual(remote ? [] : [{ characterId: "c", baseRevision, ids: localIds }]);
        expect(chatReads()).toEqual([]);
        expect(await second.journal.readOwn()).toEqual([]);
    });

    it("journals imported history while another save is outstanding and recovers the original chat after reload", async () => {
        seedChats();
        const first = await boot();
        await flush();
        server.requests.length = 0;
        server.holdNextBatchResponse = true;
        first.settings.ui.theme = "unrelated outstanding save";
        await vi.advanceTimersByTimeAsync(500);
        await drain();
        expect(server.releaseBatchResponse).not.toBeNull();

        first.characters.addCharacter({
            chaId: "new-parent",
            name: "Imported character",
            chats: [
                {
                    id: "original-chat",
                    name: "Imported chat",
                    message: [{ chatId: "imported-message", role: "char", data: "Imported history" }],
                },
            ],
        });
        const rows = await hideUnsent();
        // No save collection for the character can run while the unrelated answer is outstanding.
        expect(ops("characters")).toEqual([]);
        expect(chatGroups()).toEqual([]);
        expect(rows).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ scope: "record", target: "characters\0new-parent" }),
                expect.objectContaining({ scope: "chat", target: "new-parent\0original-chat" }),
            ]),
        );
        expect(server.record("characters", "new-parent")).toBeNull();

        first.sync.stopResourceSync();
        server.releaseBatchResponse!();
        await drain();
        const second = await reload();
        expect(second.chat.chatList("new-parent").map((chat) => chat.id)).toEqual(["original-chat"]);
        await flush();
        expect(server.record("characters", "new-parent")!.data).toMatchObject({ name: "Imported character" });
        expect(server.order("new-parent")!.ids).toEqual(["original-chat"]);
        expect(server.chat("new-parent", "original-chat")!.data.message).toEqual([
            { chatId: "imported-message", role: "char", data: "Imported history" },
        ]);
        // Resource operations precede chat groups within a batch, as on the real wire.
        const creates = server
            .batchBodies()
            .flatMap((body) => [
                ...(body.ops ?? [])
                    .filter((op) => op.kind === "characters" && op.id === "new-parent")
                    .map((op) => ({ kind: "character", id: op.id, baseRevision: op.baseRevision })),
                ...(body.chats ?? [])
                    .filter((group) => group.characterId === "new-parent")
                    .map((group) => ({ kind: "chat", id: group.chatId, baseRevision: group.baseRevision })),
            ]);
        expect(creates).toEqual([
            { kind: "character", id: "new-parent", baseRevision: null },
            { kind: "chat", id: "original-chat", baseRevision: null },
        ]);
        expect(second.recoveryDrafts.entries).toEqual([]);
        expect(await second.journal.readOwn()).toEqual([]);
    });

    it("applies a missing chat's snapshot and every newer journaled edit after reload", async () => {
        seedChats();
        const first = await boot();
        await flush();
        const created = first.chat.createChat("c", {
            id: "lost-create",
            name: "Original name",
            note: "Original note",
            localLore: [],
            message: [{ chatId: "original-message", role: "user", data: "Original snapshot" }],
        });
        server.failNext = { status: 0, times: 1, match: batchPath };
        await vi.advanceTimersByTimeAsync(500);
        await drain();
        const target = ref(created.id);
        first.chat.setMessageText(target, "original-message", "Newest edit");
        first.chat.appendMessage(target, { chatId: "appended-message", role: "char", data: "New appended message" });
        first.chat.setChatMeta(target, { name: "Newest name", note: "Newest note" });
        const rows = await hideUnsent();
        expect(rows).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    scope: "chat",
                    target: "c\0lost-create",
                    layers: expect.objectContaining({ resend: expect.any(Object), pending: expect.any(Object) }),
                }),
            ]),
        );
        expect(server.chat("c", "lost-create")).toBeNull();

        const second = await reload();
        const draft = second.recoveryDrafts.entries.find(
            (entry) => entry.scope === "chat" && entry.target === "c\0lost-create",
        )!;
        expect(draft).toBeDefined();
        const { applyRecoveryDraft } = await import("./storage/journalRecovery");
        expect(await applyRecoveryDraft(draft)).toEqual({ skipped: [] });
        const recoveredIds = server.order("c")!.ids.filter((id) => !["chat", "untouched"].includes(id));
        expect(recoveredIds).toHaveLength(1);
        expect(server.chat("c", recoveredIds[0])!.data).toMatchObject({
            name: "Newest name",
            note: "Newest note",
            message: [
                { chatId: "original-message", role: "user", data: "Newest edit" },
                { chatId: "appended-message", role: "char", data: "New appended message" },
            ],
        });
        expect(await second.journal.listDrafts()).toEqual([]);
        expect(second.recoveryDrafts.entries).toEqual([]);
    });

    it("retries a missing-chat Apply after reload without duplicating its committed create", async () => {
        seedChats();
        const first = await boot();
        await flush();
        const snapshot = {
            id: "gone",
            name: "Recovered story",
            note: "",
            localLore: [],
            message: [{ chatId: "saved-message", role: "char" as const, data: "Saved history" }],
        };
        const id = await first.journal.putDraft({
            epoch: server.store.epoch(),
            scope: "chat",
            target: "c\0gone",
            layers: { pending: { baseRevision: null, groupId: "abandoned-group", ops: [], createSnapshot: snapshot } },
        });
        await first.recoveryDrafts.refresh();
        const draft = first.recoveryDrafts.entries.find((entry) => entry.id === id)!;
        const recovery = await import("./storage/journalRecovery");
        server.dropNextBatchResponse = true;
        await expect(recovery.applyRecoveryDraft(draft)).rejects.toThrow();
        await drain();
        const recoveredIds = server.order("c")!.ids.filter((chatId) => !["chat", "untouched"].includes(chatId));
        expect(recoveredIds).toHaveLength(1);
        expect(server.texts("c", recoveredIds[0])).toEqual(["Saved history"]);
        expect((await first.journal.listDrafts()).map((entry) => entry.id)).toEqual([id]);

        const second = await reload();
        const retained = second.recoveryDrafts.entries.find((entry) => entry.id === id)!;
        expect(retained).toBeDefined();
        const freshRecovery = await import("./storage/journalRecovery");
        await freshRecovery.applyRecoveryDraft(retained);
        expect(server.order("c")!.ids.filter((chatId) => !["chat", "untouched"].includes(chatId))).toEqual(
            recoveredIds,
        );
        expect(server.texts("c", recoveredIds[0])).toEqual(["Saved history"]);
        expect(await second.journal.listDrafts()).toEqual([]);
        expect(second.recoveryDrafts.entries).toEqual([]);
    });

    it("times out a stalled on-demand chat load after 60 seconds and lets a fresh read succeed", async () => {
        seedChats();
        const current = await boot();
        await flush();
        expect(current.chat.findChat(ref())).toBeUndefined();
        let reads = 0;
        io.fetch = (path, init) => {
            if (
                path === "/api/resources/read" &&
                JSON.parse(init!.body as string).chats?.some((chat) => chat.id === "chat")
            ) {
                reads += 1;
                // This transport deliberately ignores aborts and never settles the first read.
                if (reads === 1) return new Promise<Response>(() => {});
            }
            return transport.fetch(path, init);
        };
        let outcome: unknown = "pending";
        const stalled = current.chat.ensureChatLoaded(ref()).then(
            () => {
                outcome = "resolved";
            },
            (error: unknown) => {
                outcome = error;
            },
        );
        await vi.advanceTimersByTimeAsync(59_999);
        expect(reads).toBe(1);
        expect(outcome).toBe("pending");
        await vi.advanceTimersByTimeAsync(1);
        expect(outcome).toBeInstanceOf(Error);
        await stalled;
        expect(current.chat.findChat(ref())).toBeUndefined();
        const loaded = await current.chat.loadChat(ref());
        expect(reads).toBe(2);
        expect(loaded?.message.map((message) => message.data)).toEqual(["before", "second"]);
    });

    it.each(["dispatched create", "gone chat", "gone parent"] as const)(
        "preserves work as a draft without inventing a create: %s",
        async (outcome) => {
            seedChats();
            const first = await boot();
            await flush();
            let target = "c\0chat";
            if (outcome === "dispatched create") {
                first.chat.createChat("c", {
                    id: "new-chat",
                    name: "Unanswered",
                    note: "",
                    localLore: [],
                    message: [],
                });
                target = "c\0new-chat";
                server.failNext = { status: 0, times: 1, match: batchPath };
                await vi.advanceTimersByTimeAsync(500);
                await drain();
            } else {
                await first.chat.ensureChatLoaded(ref());
                first.chat.setMessageText(ref(), "m", "local");
                await hideUnsent();
                if (outcome === "gone chat") remoteChat([{ op: "delete" }]);
                else server.store.delete(server.kind("characters"), "c", server.record("characters", "c")!.revision);
            }
            const row = (await first.journal.readOwn()).find(
                (entry) => entry.scope === "chat" && entry.target === target,
            )!;
            expect(row).toBeDefined();
            if (outcome === "dispatched create") {
                expect(row).toMatchObject({
                    scope: "chat",
                    layers: {
                        resend: {
                            value: {
                                baseRevision: null,
                                ops: [
                                    expect.objectContaining({
                                        op: "create",
                                        chat: expect.objectContaining({ id: "new-chat" }),
                                    }),
                                ],
                            },
                        },
                    },
                });
                expect(server.chat("c", "new-chat")).toBeNull();
            }
            const second = await reload();
            expect(second.recoveryDrafts.entries).toEqual(
                expect.arrayContaining([expect.objectContaining({ scope: "chat", target, layers: row.layers })]),
            );
            expect(await second.journal.listDrafts()).toEqual(
                expect.arrayContaining([expect.objectContaining({ scope: "chat", target, layers: row.layers })]),
            );
            await flush();
            expect(chatGroups()).toEqual([]);
            expect(await second.journal.readOwn()).toEqual([]);
        },
    );

    it("keeps an expired recovered group as refused work and drafts it on the next boot", async () => {
        seedChats();
        const first = await boot();
        await flush();
        await first.chat.ensureChatLoaded(ref());
        const baseRevision = server.chat("c", "chat")!.revision;
        const edit = { op: "setText" as const, id: "m", text: "lost local text" };
        server.requests.length = 0;
        server.dropNextBatchResponse = true;
        first.chat.setMessageText(ref(), "m", edit.text);
        await vi.advanceTimersByTimeAsync(500);
        await drain();
        const original = plain(chatGroups()[0]);
        expect(original).toMatchObject({ baseRevision, ops: [edit] });
        // The real server retains the last 100 group results for this chat.
        for (let index = 0; index < 101; index++) {
            remoteChat([{ op: "setText", id: "m", text: `remote ${index}` }], "chat", `remote-group-${index}`);
        }
        const current = plain(server.chat("c", "chat"));
        const second = await reload();
        await flush();
        expect(chatGroups()).toEqual([{ ...original, retry: true }]);
        expect(server.chat("c", "chat")).toEqual(current);
        expect(second.chat.refusedChatItems()).toHaveLength(1);
        const rows = await second.journal.readOwn();
        expect(rows).toMatchObject([
            {
                scope: "chat",
                target: "c\0chat",
                layers: {
                    refused: {
                        value: {
                            ops: [edit],
                            create: false,
                            delete: false,
                            reason: expect.any(String),
                        },
                    },
                },
            },
        ]);
        io.alertError.mockClear();
        const third = await reload();
        expect(third.recoveryDrafts.entries).toMatchObject([
            { scope: "chat", target: "c\0chat", layers: rows[0].layers },
        ]);
        expect(await third.journal.listDrafts()).toMatchObject([{ scope: "chat", layers: rows[0].layers }]);
        await flush();
        expect(chatGroups()).toEqual([]);
        expect(await third.journal.readOwn()).toEqual([]);
    });
});
