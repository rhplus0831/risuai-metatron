import { IDBDatabase, IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { translationSourceHash } from "../../../../shared/translation/hash.ts";
import {
    chatTarget,
    recordTarget,
    orderTarget,
    MAX_JOURNAL_ENTRY_BYTES,
    type DraftJournal,
    type RecordLayerValues,
    type ChatLayerValues,
    type OrderLayerValues,
} from "../draftJournal";
import { createFakeLockManager } from "./fakeLockManager";
import { bootMutations, m, plain, refJ, refK, SAVE_DEBOUNCE_MS, warmMutationGraph } from "./mutationStoresHarness";
import type { StoreBackedServer } from "./storeBackedServer";

const { server, diagnostics } = vi.hoisted(() => ({
    server: { current: null as StoreBackedServer | null },
    diagnostics: { record: vi.fn() },
}));

vi.mock("../serverAuth", async () =>
    (await import("./serverAuthMock")).createServerAuthMock({
        authFetch: (path, init) => server.current!.fetch(path, init),
    }),
);
vi.mock("../../alert", async () => (await import("../../tests/alertMock")).createAlertMock());
vi.mock("../../diagnostics/collector", async () =>
    (await import("../../diagnostics/tests/collectorMock")).createCollectorMock({
        recordClientEvent: diagnostics.record,
    }),
);

let journal: DraftJournal;
let factory: IDBFactory;
let transactionCount = 0;
let onWriteTransaction: ((tx: IDBTransaction) => void) | null = null;
const pendingTransactions = new Set<Promise<void>>();
const openReleases: (() => void)[] = [];
const listeners = new Map<string, EventListenerOrEventListenerObject[]>();
const batchPath = (path: string) => path === "/api/resources/batch";
const target = (kind: string, id = "main") => recordTarget(kind, id);
const UI = target("ui");
const CHARACTER = target("characters", "c");
const latest = (text: string | null, baseRevision: string | null): RecordLayerValues["latest"] => ({
    op: text === null ? "delete" : baseRevision === null ? "create" : "update",
    baseRevision,
    text,
});
const sent = (text: string | null, baseRevision: string | null, inDoubt = false): RecordLayerValues["sent"] => ({
    ...latest(text, baseRevision),
    dispatched: true,
    inDoubt,
});

async function boot(startJournal = true) {
    vi.resetModules();
    const capture = (name: string, listener: EventListenerOrEventListenerObject | null) => {
        if (listener) listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    };
    vi.spyOn(window, "addEventListener").mockImplementation(capture);
    vi.spyOn(document, "addEventListener").mockImplementation(capture);
    const h = await bootMutations((fake) => {
        server.current = fake;
    });
    journal = (await import("../draftJournal")).pageDraftJournal();
    if (startJournal) expect(await journal.start()).toBe(true);
    return h;
}

function hide(name: "pagehide" | "visibilitychange" = "pagehide") {
    if (name === "visibilitychange") vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    for (const listener of listeners.get(name) ?? []) {
        const event = new Event(name);
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
    }
}

// A completed write can release the next serialized write. Drain real IndexedDB completion events
// without moving the fake clock, then read through the journal's public transaction barrier.
async function rows() {
    await vi.advanceTimersByTimeAsync(0);
    while (pendingTransactions.size) {
        await Promise.all([...pendingTransactions]);
        await vi.advanceTimersByTimeAsync(0);
    }
    return journal.readOwn();
}

async function layers(key: string) {
    const row = (await rows()).find((entry) => entry.scope === "record" && entry.target === key);
    return row?.scope === "record"
        ? Object.fromEntries(Object.entries(row.layers).map(([name, layer]) => [name, layer.value]))
        : {};
}

async function chatLayers(ref = refK): Promise<Partial<ChatLayerValues>> {
    const row = (await rows()).find(
        (entry) => entry.scope === "chat" && entry.target === chatTarget(ref.chaId, ref.chatId),
    );
    return row?.scope === "chat"
        ? Object.fromEntries(Object.entries(row.layers).map(([name, layer]) => [name, layer.value]))
        : {};
}

async function orderLayers(): Promise<Partial<OrderLayerValues>> {
    const row = (await rows()).find((entry) => entry.scope === "order" && entry.target === orderTarget("c"));
    return row?.scope === "order"
        ? Object.fromEntries(Object.entries(row.layers).map(([name, layer]) => [name, layer.value]))
        : {};
}

/** Inspect the dialog's public rows, including the persisted layer values Apply consumes. */
async function draft(scope: "record" | "chat" | "order", target: string, epoch: string, expected: unknown) {
    const matches = (await journal.listDrafts()).filter((row) => row.scope === scope && row.target === target);
    expect(matches).toHaveLength(1);
    const row = matches[0];
    expect(row).toMatchObject({ id: expect.any(String), epoch, scope, target });
    expect(Object.fromEntries(Object.entries(row.layers).map(([name, layer]) => [name, layer.value]))).toEqual(
        expected,
    );
    return row;
}

/** Run the cleanup and later scheduled saves, then cross the IndexedDB completion barrier again. */
async function cleanup(sync: typeof import("../resourceSync.svelte")) {
    await flushJournal();
    await vi.advanceTimersByTimeAsync(6000);
    await sync.flushResources();
    await flushJournal();
}

/** Keep a real IndexedDB transaction active until release, so no split write can commit early. */
function holdJournalCommit() {
    let released = false;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    onWriteTransaction = (tx) => {
        const keepActive = () => {
            if (released) return;
            tx.objectStore("entries").get("test-transaction-barrier").onsuccess = keepActive;
        };
        keepActive();
        entered();
    };
    return {
        started,
        release: () => {
            released = true;
        },
    };
}

async function flushJournal() {
    hide();
    return rows();
}

function writeTransactions() {
    const before = transactionCount;
    return () => transactionCount - before;
}

/** Hold delivery of the real IndexedDB open event, leaving the transport and fake clock free. */
function holdOpen() {
    let release!: () => void;
    const opened = new Promise<void>((resolve) => {
        const open = factory.open.bind(factory);
        vi.spyOn(factory, "open").mockImplementation((...args) => {
            const request = open(...args);
            return new Proxy(request, {
                get: (object, key) => Reflect.get(object, key, object),
                set(object, key, value) {
                    if (key === "onsuccess") {
                        object.onsuccess = (event) => {
                            let released = false;
                            release = () => {
                                if (!released) {
                                    released = true;
                                    value.call(object, event);
                                }
                            };
                            openReleases.push(release);
                            resolve();
                        };
                    } else Reflect.set(object, key, value, object);
                    return true;
                },
            });
        });
    });
    return { opened, release: () => release() };
}

beforeAll(() => warmMutationGraph());
beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    listeners.clear();
    pendingTransactions.clear();
    openReleases.length = 0;
    transactionCount = 0;
    onWriteTransaction = null;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    vi.stubGlobal("location", { reload: vi.fn() });
    vi.spyOn(navigator, "locks", "get").mockReturnValue(createFakeLockManager());
    vi.spyOn(console, "error").mockImplementation(() => {});
    const transaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (...args) {
        const tx = transaction.apply(this, args);
        if (args[1] === "readwrite") {
            transactionCount++;
            const completion = new Promise<void>((resolve) => {
                const done = () => {
                    pendingTransactions.delete(completion);
                    resolve();
                };
                tx.addEventListener("complete", done);
                tx.addEventListener("abort", done);
            });
            pendingTransactions.add(completion);
            const held = onWriteTransaction;
            onWriteTransaction = null;
            held?.(tx);
        }
        return tx;
    });
});
afterEach(async () => {
    openReleases.splice(0).forEach((release) => release());
    server.current?.releaseBatch?.();
    server.current?.releaseBatchResponse?.();
    await vi.advanceTimersByTimeAsync(0);
    await journal?.close();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
    server.current = null;
});

describe("resource save journal", () => {
    it.each([false, true])("keeps A and newer B through acknowledgement (lost answer: %s)", async (lost) => {
        const { fake, settings } = await boot();
        const base = fake.record("ui", "main")!;
        const a = JSON.stringify({ ...plain(base.data), theme: "A" });
        const b = JSON.stringify({ ...plain(base.data), theme: "B" });
        fake.holdNextBatch = true;
        fake.dropNextBatchResponse = lost;
        settings.ui.theme = "A";
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
        expect(fake.releaseBatch).not.toBeNull();
        expect(await layers(UI)).toEqual({ sent: sent(a, base.revision) });
        expect((await rows()).find((row) => row.target === UI)?.epoch).toBe(fake.store.epoch());

        settings.ui.theme = "B";
        await vi.advanceTimersByTimeAsync(500);
        expect(await layers(UI)).toEqual({ sent: sent(a, base.revision), latest: latest(b, base.revision) });
        fake.releaseBatch!();
        await vi.advanceTimersByTimeAsync(0);
        const acknowledged = fake.record("ui", "main")!.revision;
        if (lost) {
            await vi.advanceTimersByTimeAsync(500);
            expect(await layers(UI)).toEqual({ sent: sent(a, base.revision, true), latest: latest(b, base.revision) });
            // The exact resend conflicts with A already on the server; recognizing A advances B's base.
            await vi.advanceTimersByTimeAsync(1500);
        }
        await flushJournal();
        expect(await layers(UI)).toEqual({ latest: latest(b, acknowledged) });
        fake.holdNextBatchResponse = true;
        await vi.advanceTimersByTimeAsync(500);
        expect(await layers(UI)).toEqual({ sent: sent(b, acknowledged) });
        fake.releaseBatchResponse!();
        await vi.advanceTimersByTimeAsync(500);
        expect(await layers(UI)).toEqual({});
    });

    it("keeps a revert behind an in-doubt write without rewriting unchanged resends", async () => {
        const { fake, settings } = await boot();
        const base = fake.record("ui", "main")!;
        const original = JSON.stringify(base.data);
        const a = JSON.stringify({ ...plain(base.data), theme: "lost" });
        fake.dropNextBatchResponse = true;
        settings.ui.theme = "lost";
        await vi.advanceTimersByTimeAsync(500);
        settings.ui.theme = base.data.theme;
        await vi.advanceTimersByTimeAsync(500);
        expect(await layers(UI)).toEqual({
            sent: sent(a, base.revision, true),
            latest: latest(original, base.revision),
        });
        const before = await rows();
        const transactions = writeTransactions();
        fake.failNext = { status: 0, times: 2, match: batchPath };
        await vi.advanceTimersByTimeAsync(2000);
        await flushJournal();
        expect(await rows()).toEqual(before);
        expect(transactions()).toBe(0);
    });

    it("keeps a removed character's delete behind its lost create and rebases it after recognition", async () => {
        const { fake, characterStore } = await boot();
        fake.holdNextBatch = true;
        fake.dropNextBatchResponse = true;
        characterStore.addCharacter({ chaId: "new", name: "New", chats: [] });
        await vi.advanceTimersByTimeAsync(500);
        await rows();
        const key = target("characters", "new");
        const creating = await layers(key);
        expect(creating.sent).toMatchObject({ op: "create", baseRevision: null, dispatched: true, inDoubt: false });
        expect(JSON.parse(creating.sent.text)).toMatchObject({ chaId: "new", name: "New" });
        characterStore.removeCharacter("new");
        fake.releaseBatch!();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(500);
        await flushJournal();
        expect(await layers(key)).toEqual({ sent: { ...creating.sent, inDoubt: true }, latest: latest(null, null) });
        await vi.advanceTimersByTimeAsync(1500);
        await flushJournal();
        expect(await layers(key)).toEqual({ latest: latest(null, fake.record("characters", "new")!.revision) });
        await vi.advanceTimersByTimeAsync(1000);
        expect(fake.record("characters", "new")).toBeNull();
        expect(await layers(key)).toEqual({});
    });

    it("journals a delete and a same-id re-add on the base that will be sent", async () => {
        const { fake, characterStore } = await boot();
        const base = fake.record("characters", "c")!.revision;
        fake.holdNextBatchResponse = true;
        characterStore.removeCharacter("c");
        await vi.advanceTimersByTimeAsync(500);
        expect(await layers(CHARACTER)).toEqual({ sent: sent(null, base) });
        characterStore.addCharacter({ chaId: "c", name: "Re-added", chats: [] });
        await vi.advanceTimersByTimeAsync(500);
        const during = await layers(CHARACTER);
        expect(during.sent).toEqual(sent(null, base));
        expect(during.latest).toMatchObject({ op: "update", baseRevision: base });
        expect(JSON.parse(during.latest.text).name).toBe("Re-added");
        fake.releaseBatchResponse!();
        await vi.advanceTimersByTimeAsync(0);
        await flushJournal();
        expect(await layers(CHARACTER)).toEqual({ latest: latest(during.latest.text, null) });
        await vi.advanceTimersByTimeAsync(1000);
        expect(fake.record("characters", "c")!.data.name).toBe("Re-added");
        await flushJournal();
        expect(await layers(CHARACTER)).toEqual({});
    });

    it.each(["lost answer", "generation job"])("keeps a character delete as latest after a %s", async (reason) => {
        const { fake, characterStore } = await boot();
        const base = fake.record("characters", "c")!.revision;
        if (reason === "lost answer") fake.dropNextBatchResponse = true;
        else
            fake.failNext = {
                status: 409,
                times: 1,
                match: batchPath,
                body: {
                    error: "ResourceConflict",
                    conflicts: [{ kind: "characters", id: "c", revision: base, reason: "generating" }],
                },
            };
        characterStore.removeCharacter("c");
        await vi.advanceTimersByTimeAsync(1000);
        expect(await layers(CHARACTER)).toEqual({ latest: latest(null, base) });
    });

    it("keeps the sent and newer local record text as a draft after accepting the server copy and cleaning up", async () => {
        const { fake, settings, sync } = await boot();
        const base = fake.record("ui", "main")!;
        const text = (theme: string) => JSON.stringify({ ...plain(base.data), theme });
        fake.set("ui", "main", { ...plain(base.data), theme: "remote" });
        fake.holdNextBatch = true;
        settings.ui.theme = "sent local";
        await vi.advanceTimersByTimeAsync(500);
        expect((await layers(UI)).sent).toEqual(sent(text("sent local"), base.revision));
        settings.ui.theme = "newer local";
        await flushJournal();
        fake.releaseBatch!();
        await vi.advanceTimersByTimeAsync(0);
        await flushJournal();
        const expected = {
            sent: sent(text("sent local"), base.revision),
            latest: latest(text("newer local"), base.revision),
        };
        const captured = await draft("record", UI, fake.store.epoch(), expected);
        await cleanup(sync);
        expect(await draft("record", UI, fake.store.epoch(), expected)).toEqual(captured);
        expect(settings.ui.theme).toBe("remote");
        expect(await layers(UI)).toEqual({});
    });

    it("keeps a conflicting chat group and its queued operations after replacing the chat and cleaning up", async () => {
        const { fake, chat, sync } = await boot();
        const base = fake.chat("c", "k")!.revision;
        fake.chatBatch([
            { characterId: "c", chatId: "k", baseRevision: base, ops: [{ op: "setText", id: "a", text: "remote" }] },
        ]);
        fake.holdNextBatch = true;
        chat.removeMessages(refK, ["b", "c"]);
        await vi.advanceTimersByTimeAsync(500);
        const groupId = fake.batchBodies()[0].chats[0].groupId;
        chat.setChatMeta(refK, { note: "queued local note" });
        await flushJournal();
        const pendingId = (await chatLayers()).pending!.groupId;
        fake.releaseBatch!();
        await vi.advanceTimersByTimeAsync(0);
        await flushJournal();
        const expected = {
            resend: {
                ops: [{ op: "remove", ids: ["b", "c"] }],
                baseRevision: base,
                groupId,
                seq: expect.any(Number),
                inDoubt: false,
            },
            pending: {
                ops: [
                    {
                        op: { op: "meta", set: { note: "queued local note" }, unset: [] },
                        before: { value: { note: "" } },
                    },
                ],
                baseRevision: base,
                groupId: pendingId,
            },
        };
        const captured = await draft("chat", chatTarget("c", "k"), fake.store.epoch(), expected);
        await cleanup(sync);
        expect(await draft("chat", chatTarget("c", "k"), fake.store.epoch(), expected)).toEqual(captured);
        expect(await chatLayers()).toEqual({});
        expect(chat.findChat(refK)!.message.map((message) => message.data)).toEqual(["remote", "B", "C"]);
        expect(chat.findChat(refK)!.note).toBe("");
    });

    it("keeps a gone chat's sent and queued work with its local snapshot after discard and collection cleanup", async () => {
        const { fake, chat, sync } = await boot();
        const base = fake.chat("c", "k")!;
        fake.chatBatch([{ characterId: "c", chatId: "k", baseRevision: base.revision, ops: [{ op: "delete" }] }]);
        fake.holdNextBatch = true;
        chat.setMessageText(refK, "a", "sent local text");
        await vi.advanceTimersByTimeAsync(500);
        const groupId = fake.batchBodies()[0].chats[0].groupId;
        chat.setMessageText(refK, "b", "queued local text");
        await flushJournal();
        const pendingId = (await chatLayers()).pending!.groupId;
        const snapshot = {
            ...plain(base.data),
            message: [m("a", "sent local text", "char"), m("b", "queued local text"), m("c", "C", "char")],
        };
        fake.releaseBatch!();
        await vi.advanceTimersByTimeAsync(0);
        await flushJournal();
        const expected = {
            resend: {
                ops: [{ op: "setText", id: "a", text: "sent local text" }],
                baseRevision: base.revision,
                groupId,
                seq: expect.any(Number),
                inDoubt: false,
            },
            pending: {
                ops: [{ op: { op: "setText", id: "b", text: "queued local text" }, before: { value: "B" } }],
                baseRevision: base.revision,
                groupId: pendingId,
                createSnapshot: snapshot,
            },
        };
        const captured = await draft("chat", chatTarget("c", "k"), fake.store.epoch(), expected);
        await cleanup(sync);
        expect(await draft("chat", chatTarget("c", "k"), fake.store.epoch(), expected)).toEqual(captured);
        expect(await chatLayers()).toEqual({});
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(["j"]);
    });

    it("drafts the discarded order during collection recovery while a newer reorder survives", async () => {
        const { fake, chat, sync } = await boot();
        const base = fake.order("c")!.revision;
        // Move the revision twice so the server ends at the original order on a newer base.
        fake.store.applyChanges({ chatOrders: [{ characterId: "c", baseRevision: base, ids: ["j", "k"] }] });
        fake.store.applyChanges({
            chatOrders: [{ characterId: "c", baseRevision: fake.order("c")!.revision, ids: ["k", "j"] }],
        });
        fake.holdNextBatch = true;
        chat.reorderChats("c", ["j", "k"]);
        await vi.advanceTimersByTimeAsync(500);
        expect(await orderLayers()).toEqual({ sent: { baseRevision: base, ids: ["j", "k"] } });
        chat.reorderChats("c", ["k", "j"]);
        await flushJournal();
        fake.releaseBatch!();
        await vi.advanceTimersByTimeAsync(0);
        await flushJournal();
        const expected = { sent: { baseRevision: base, ids: ["j", "k"] } };
        const captured = await draft("order", orderTarget("c"), fake.store.epoch(), expected);
        await cleanup(sync);
        expect(await draft("order", orderTarget("c"), fake.store.epoch(), expected)).toEqual(captured);
        expect(await orderLayers()).toEqual({});
        expect(fake.order("c")!.ids).toEqual(["k", "j"]);
        expect(chat.chatList("c").map((entry) => entry.id)).toEqual(["k", "j"]);
    });

    it("drafts only the sent and queued edits removed by a generating refusal and saves the retained edits", async () => {
        const { fake, chat, sync } = await boot();
        const base = fake.chat("c", "k")!.revision;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const fetch = fake.fetch.bind(fake);
        let sentGroup: { groupId: string } | undefined;
        vi.spyOn(fake, "fetch").mockImplementation(async (path, init) => {
            if (batchPath(path) && !sentGroup) {
                sentGroup = JSON.parse(String(init?.body)).chats[0];
                await gate;
                return Response.json(
                    {
                        error: "ResourceConflict",
                        conflicts: [
                            {
                                kind: "chat",
                                characterId: "c",
                                id: "k",
                                revision: base,
                                reason: "generating",
                                messageIds: ["a"],
                            },
                        ],
                    },
                    { status: 409 },
                );
            }
            return fetch(path, init);
        });
        chat.setMessageText(refK, "a", "removed sent edit");
        chat.setMessageText(refK, "b", "retained sent edit");
        await vi.advanceTimersByTimeAsync(500);
        expect(sentGroup).toBeDefined();
        chat.setMessageText(refK, "a", "removed queued edit");
        chat.setChatMeta(refK, { note: "retained queued note" });
        await flushJournal();
        const pendingId = (await chatLayers()).pending!.groupId;
        release();
        await vi.advanceTimersByTimeAsync(0);
        await flushJournal();
        const expected = {
            resend: {
                ops: [{ op: "setText", id: "a", text: "removed sent edit" }],
                baseRevision: base,
                groupId: sentGroup!.groupId,
                seq: expect.any(Number),
                inDoubt: false,
            },
            pending: {
                ops: [
                    {
                        op: { op: "setText", id: "a", text: "removed queued edit" },
                        before: { value: "removed sent edit" },
                    },
                ],
                baseRevision: base,
                groupId: pendingId,
            },
        };
        const captured = await draft("chat", chatTarget("c", "k"), fake.store.epoch(), expected);
        expect((await chatLayers()).pending!.ops.map(({ op }) => op)).toEqual([
            { op: "setText", id: "b", text: "retained sent edit" },
            { op: "meta", set: { note: "retained queued note" }, unset: [] },
        ]);
        await cleanup(sync);
        expect(await draft("chat", chatTarget("c", "k"), fake.store.epoch(), expected)).toEqual(captured);
        expect(await chatLayers()).toEqual({});
        expect(fake.texts("c", "k")).toEqual(["A", "retained sent edit", "C"]);
        expect(fake.chat("c", "k")!.data.note).toBe("retained queued note");
    });

    it("keeps queued chat work and order as drafts when another writer removes their character", async () => {
        const { fake, chat, sync, characterList } = await boot();
        const base = fake.chat("c", "k")!;
        const orderBase = fake.order("c")!.revision;
        chat.setMessageText(refK, "a", "unsent local text");
        chat.reorderChats("c", ["j", "k"]);
        const groupId = expect.any(String);
        fake.store.delete(fake.kind("characters"), "c", fake.record("characters", "c")!.revision);
        sync.noteRemoteChanges({
            resources: [{ kind: "characters", id: "c", revision: null }],
            chats: [],
            chatOrders: [],
        });
        await vi.advanceTimersByTimeAsync(100);
        await flushJournal();
        const chatExpected = {
            pending: {
                ops: [{ op: { op: "setText", id: "a", text: "unsent local text" }, before: { value: "A" } }],
                baseRevision: base.revision,
                groupId,
                createSnapshot: {
                    ...plain(base.data),
                    message: [m("a", "unsent local text", "char"), m("b", "B"), m("c", "C", "char")],
                },
            },
        };
        const orderExpected = { latest: { baseRevision: orderBase, ids: ["j", "k"] } };
        const captured = await draft("chat", chatTarget("c", "k"), fake.store.epoch(), chatExpected);
        const order = await draft("order", orderTarget("c"), fake.store.epoch(), orderExpected);
        await cleanup(sync);
        expect(await draft("chat", chatTarget("c", "k"), fake.store.epoch(), chatExpected)).toEqual(captured);
        expect(await draft("order", orderTarget("c"), fake.store.epoch(), orderExpected)).toEqual(order);
        expect(await chatLayers()).toEqual({});
        expect(await orderLayers()).toEqual({});
        expect(characterList()).toEqual([]);
        expect(fake.batchCount()).toBe(0);
    });

    it("preserves the exact refused record text when a gone chat's recovery removes its character", async () => {
        const { fake, characterStore, chat, sync, characterList } = await boot();
        const base = fake.record("characters", "c")!;
        const text = JSON.stringify({ ...plain(base.data), desc: "refused local description" });
        fake.failNext = { status: 400, times: 1, match: batchPath, body: { error: "ops[0] is refused" } };
        characterStore.updateCharacter("c", { desc: "refused local description" });
        await vi.advanceTimersByTimeAsync(1000);
        const expected = { refused: { op: "update", text, reason: "ops[0] is refused" } };
        expect(await layers(CHARACTER)).toEqual(expected);
        fake.store.delete(fake.kind("characters"), "c", base.revision);
        chat.setChatMeta(refK, { note: "local note" });
        await vi.advanceTimersByTimeAsync(1500);
        await cleanup(sync);
        await draft("record", CHARACTER, fake.store.epoch(), expected);
        expect(await layers(CHARACTER)).toEqual({});
        expect(characterList()).toEqual([]);
    });

    it("does not draft credential-bearing character text discarded by a conflict", async () => {
        const { fake, characterStore, sync, character } = await boot();
        const base = fake.record("characters", "c")!;
        fake.set("characters", "c", { ...plain(base.data), desc: "remote description" });
        characterStore.updateCharacter("c", {
            desc: "local description",
            oaiTTSConfig: { apiKey: "never-draft-this-key", voice: "alloy" },
        });
        expect((await sync.flushResources()).discarded).toContain("characters/c");
        await cleanup(sync);
        expect(character("c").desc).toBe("remote description");
        expect(await journal.listDrafts()).toEqual([]);
        expect(await layers(CHARACTER)).toEqual({});
    });

    it("releases refusals on edit and Retry and removes them on Discard", async () => {
        const { fake, sync, settings } = await boot();
        const base = fake.record("ui", "main")!;
        const text = (theme: string) => JSON.stringify({ ...plain(base.data), theme });
        const refuse = async (theme: string, status: number) => {
            fake.failNext = { status, times: 1, match: batchPath, body: { error: "ops[0] is refused" } };
            settings.ui.theme = theme;
            await vi.advanceTimersByTimeAsync(1000);
            expect(await layers(UI)).toEqual({
                refused: { op: "update", text: text(theme), reason: "ops[0] is refused" },
            });
        };
        await refuse("refused A", 400);
        fake.holdNextBatch = true;
        settings.ui.theme = "edited B";
        await vi.advanceTimersByTimeAsync(500);
        expect(await layers(UI)).toEqual({ sent: sent(text("edited B"), base.revision) });
        fake.releaseBatch!();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(500);
        expect(await layers(UI)).toEqual({});
        await refuse("refused C", 413);
        fake.holdNextBatch = true;
        sync.retryRefused(sync.refusedItems()[0].key);
        await vi.advanceTimersByTimeAsync(500);
        expect(await layers(UI)).toEqual({ sent: sent(text("refused C"), fake.record("ui", "main")!.revision) });
        fake.releaseBatch!();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(500);
        await refuse("refused D", 400);
        await sync.discardRefused(sync.refusedItems()[0].key);
        await vi.advanceTimersByTimeAsync(500);
        expect(settings.ui.theme).toBe("refused C");
        await cleanup(sync);
        expect(await layers(UI)).toEqual({});
        expect(await journal.listDrafts()).toEqual([]);
    });

    it("excludes credential-bearing records while keeping ordinary free text", async () => {
        const { fake, settings, characterStore, collectionStore, pluginStorageStore } = await boot();
        const secret = "journal-exclusion-sentinel";
        fake.holdNextBatch = true;
        settings.llmSecrets.vertexAccessTokenExpires = 12345;
        settings.secrets.elevenLabKey = secret;
        collectionStore.addAuthRefresh({ url: "https://example.test", refreshToken: secret });
        collectionStore.setPluginArgument("plug", "a", secret);
        pluginStorageStore.setPluginStorageItem("key", secret);
        settings.providers.additionalParams = [["header::Authorization", secret]];
        settings.customModels = [{ id: "custom", name: "Custom", params: `header::Authorization=${secret}` }] as any;
        characterStore.updateCharacter("c", { oaiTTSConfig: { apiKey: secret, voice: "alloy" } });
        settings.ui.theme = secret;
        await vi.advanceTimersByTimeAsync(500);
        const own = await rows();
        expect(own.map((row) => row.target)).toEqual([UI]);
        expect((await layers(UI)).sent.text).toContain(secret);
        expect(fake.batchBodies()[0].ops.map((op: any) => op.kind)).toEqual(
            expect.arrayContaining([
                "llmSecrets",
                "secrets",
                "authRefreshes",
                "plugins",
                "pluginStorage",
                "providers",
                "customModels",
                "characters",
                "ui",
            ]),
        );
    });

    it("coalesces changed records before dispatch and defers acknowledgement cleanup for 500 ms", async () => {
        const { fake, settings, characterStore } = await boot();
        const transactions = writeTransactions();
        fake.holdNextBatchResponse = true;
        settings.ui.theme = "coalesced";
        characterStore.updateCharacter("c", { name: "Coalesced" });
        await vi.advanceTimersByTimeAsync(500);
        expect((await rows()).map((row) => row.target).sort()).toEqual([CHARACTER, UI].sort());
        expect(transactions()).toBe(1);
        fake.releaseBatchResponse!();
        await vi.advanceTimersByTimeAsync(499);
        expect(await rows()).toHaveLength(2);
        expect(transactions()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await rows()).toEqual([]);
        expect(transactions()).toBe(2);
    });

    it("acknowledges only captured layer versions, preserving a newer journal writer", async () => {
        const { fake, settings } = await boot();
        fake.holdNextBatchResponse = true;
        settings.ui.theme = "A";
        await vi.advanceTimersByTimeAsync(500);
        const [captured] = await rows();
        const newer = sent(JSON.stringify({ theme: "newer writer" }), fake.record("ui", "main")!.revision);
        await journal.write([
            {
                epoch: captured.epoch,
                scope: "record",
                target: UI,
                version: journal.nextVersion(),
                layers: { sent: newer },
            },
        ]);
        fake.releaseBatchResponse!();
        await vi.advanceTimersByTimeAsync(500);
        expect(await layers(UI)).toEqual({ sent: newer });
    });

    it.each(["pagehide", "visibilitychange"] as const)(
        "throttles large UTF-8 records for 5 s, keeping the older layer until %s",
        async (event) => {
            const { fake, settings } = await boot();
            const base = fake.record("ui", "main")!;
            // Under 256 Ki characters but over 256 KiB: the whole record's UTF-8 size controls throttling.
            const large = "한".repeat(90_000);
            const text = (suffix: string) => JSON.stringify({ ...plain(base.data), theme: large + suffix });
            fake.holdNextBatch = true;
            settings.ui.theme = large + "A";
            await vi.advanceTimersByTimeAsync(500);
            expect(await layers(UI)).toEqual({ sent: sent(text("A"), base.revision) });
            settings.ui.theme = large + "B";
            await vi.advanceTimersByTimeAsync(4999);
            expect(await layers(UI)).toEqual({ sent: sent(text("A"), base.revision) });
            await vi.advanceTimersByTimeAsync(1);
            expect(await layers(UI)).toEqual({
                sent: sent(text("A"), base.revision),
                latest: latest(text("B"), base.revision),
            });
            settings.ui.theme = large + "C";
            await vi.advanceTimersByTimeAsync(500);
            expect((await layers(UI)).latest).toEqual(latest(text("B"), base.revision));
            hide(event);
            expect((await layers(UI)).latest).toEqual(latest(text("C"), base.revision));
        },
    );

    it.each(["ASCII", "UTF-8"])(
        "keeps unchanged sent and removes older latest when its replacement exceeds the entry budget (%s)",
        async (encoding) => {
            const { fake, settings } = await boot();
            const base = fake.record("ui", "main")!;
            const text = (theme: string) => JSON.stringify({ ...plain(base.data), theme });
            const inFlight = sent(text("small"), base.revision);
            fake.holdNextBatch = true;
            settings.ui.theme = "small";
            await vi.advanceTimersByTimeAsync(500);
            expect(await layers(UI)).toEqual({ sent: inFlight });

            settings.ui.theme = "older pending edit";
            await vi.advanceTimersByTimeAsync(500);
            expect(await layers(UI)).toEqual({
                sent: inFlight,
                latest: latest(text("older pending edit"), base.revision),
            });

            // UTF-8: under the budget in UTF-16 units, over it in bytes (three per character).
            settings.ui.theme =
                encoding === "ASCII"
                    ? "x".repeat(MAX_JOURNAL_ENTRY_BYTES + 1)
                    : "한".repeat(Math.ceil(MAX_JOURNAL_ENTRY_BYTES / 3) + 1);
            await vi.advanceTimersByTimeAsync(500);
            const remaining = await layers(UI);
            expect(diagnostics.record).toHaveBeenCalledWith({
                kind: "sync",
                phase: "journalSkipped",
                reason: "tooLarge",
                entries: 1,
            });
            expect(remaining).toEqual({ sent: inFlight });
        },
    );

    it("waits at most 200 ms for a create's stalled journal, then sends anyway", async () => {
        const held = holdOpen();
        const { fake, characterStore } = await boot(false);
        fake.holdNextBatchResponse = true;
        characterStore.addCharacter({ chaId: "new", name: "New", chats: [] });
        await vi.advanceTimersByTimeAsync(500);
        await held.opened;
        expect(fake.batchCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(199);
        expect(fake.batchCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(fake.batchCount()).toBe(1);
        held.release();
        expect(await journal.start()).toBe(true);
        expect((await layers(target("characters", "new"))).sent).toMatchObject({
            op: "create",
            baseRevision: null,
            dispatched: true,
            inDoubt: false,
        });
    });

    it("does not throttle a newer large create behind an in-flight create", async () => {
        const { fake, characterStore } = await boot();
        const large = "x".repeat(270_000);
        fake.holdNextBatch = true;
        characterStore.addCharacter({ chaId: "new", name: "New", desc: large, chats: [] });
        await vi.advanceTimersByTimeAsync(500);
        const key = target("characters", "new");
        const initial = (await layers(key)).sent;
        characterStore.updateCharacter("new", { desc: large + "B" });
        await vi.advanceTimersByTimeAsync(500);
        const next = await layers(key);
        expect(next.sent).toEqual(initial);
        expect(next.latest).toMatchObject({ op: "create", baseRevision: null });
        expect(JSON.parse(next.latest.text).desc).toBe(large + "B");
    });

    it("snapshots live restore intent atomically under the loaded epoch and freezes it after halt", async () => {
        const { fake, sync, settings, characterStore, chat } = await boot();
        const client = await import("../resourceClient");
        const { alertTerminal } = await import("../../alert");
        const { language } = await import("../../../lang");
        const oldEpoch = fake.store.epoch();
        const ui = plain(fake.record("ui", "main"));
        const character = plain(fake.record("characters", "c"));
        const chatBase = fake.chat("c", "k")!.revision;
        const orderBase = fake.order("c")!.revision;
        const refusedText = JSON.stringify({ ...character.data, desc: "refused description" });
        const uiText = (theme: string) => JSON.stringify({ ...ui.data, theme });
        const reason = "ops[0]: characters c: refused description";
        fake.failNext = { status: 400, times: 1, match: batchPath, body: { error: reason } };
        characterStore.updateCharacter("c", { desc: "refused description" });
        await vi.advanceTimersByTimeAsync(1000);
        expect(await layers(CHARACTER)).toEqual({ refused: { op: "update", text: refusedText, reason } });

        fake.holdNextBatch = true;
        settings.ui.theme = "sent settings";
        chat.setMessageText(refK, "a", "sent chat");
        chat.reorderChats("c", ["j", "k"]);
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
        expect(fake.releaseBatch).not.toBeNull();
        await rows();
        const dispatched = fake.batchBodies().at(-1)!;
        const sentId = dispatched.chats[0].groupId;
        // These edits have never reached a debounce or a hide flush when the restore arrives.
        settings.ui.theme = "unsent settings";
        chat.setMessageText(refK, "a", "unsent chat");
        chat.reorderChats("c", ["k", "j"]);

        const order: string[] = [];
        let acknowledge!: () => void;
        const notice = new Promise<void>((resolve) => {
            acknowledge = resolve;
        });
        sync.beforeRestoreReload(() => order.push("hook"));
        vi.mocked(alertTerminal).mockImplementationOnce(() => {
            order.push("notice");
            return notice;
        });
        vi.mocked(location.reload).mockImplementation(() => {
            order.push("reload");
        });
        const transactions = writeTransactions();
        const commit = holdJournalCommit();
        try {
            client.epochMismatch("restored-epoch");
            // The selection hook and notice must run within the listener call, even with IDB held.
            expect(order).toEqual(["hook", "notice"]);
            expect(alertTerminal).toHaveBeenCalledExactlyOnceWith(language.resourceRestored);
            await vi.advanceTimersByTimeAsync(0);
            expect(transactions()).toBe(1);
            await commit.started;
            expect(location.reload).not.toHaveBeenCalled();
            commit.release();
            const snapshot = await rows();
            expect(snapshot.map(({ scope, target }) => [scope, target]).sort()).toEqual([
                ["chat", chatTarget("c", "k")],
                ["order", orderTarget("c")],
                ["record", CHARACTER],
                ["record", UI],
            ]);
            expect(snapshot.every((row) => row.epoch === oldEpoch)).toBe(true);
            expect(await layers(CHARACTER)).toEqual({ refused: { op: "update", text: refusedText, reason } });
            expect(await layers(UI)).toEqual({
                sent: sent(uiText("sent settings"), ui.revision),
                latest: latest(uiText("unsent settings"), ui.revision),
            });
            expect(await chatLayers()).toEqual({
                resend: {
                    ops: [{ op: "setText", id: "a", text: "sent chat" }],
                    baseRevision: chatBase,
                    groupId: sentId,
                    seq: expect.any(Number),
                    inDoubt: false,
                },
                pending: {
                    ops: [{ op: { op: "setText", id: "a", text: "unsent chat" }, before: { value: "sent chat" } }],
                    baseRevision: chatBase,
                    groupId: expect.any(String),
                },
            });
            expect((await chatLayers()).pending!.groupId).not.toBe(sentId);
            expect(await orderLayers()).toEqual({
                sent: { ids: ["j", "k"], baseRevision: orderBase },
                latest: { ids: ["k", "j"], baseRevision: orderBase },
            });
            expect(transactions()).toBe(1);
            expect(location.reload).not.toHaveBeenCalled();
            acknowledge();
            await vi.advanceTimersByTimeAsync(0);
            expect(order).toEqual(["hook", "notice", "reload"]);
            const batches = fake.batchCount();
            fake.releaseBatch!();
            await vi.advanceTimersByTimeAsync(0);
            expect(await rows()).toEqual(snapshot);
            hide();
            hide("visibilitychange");
            await vi.advanceTimersByTimeAsync(5000);
            await sync.flushResources().catch(() => {});
            expect(await rows()).toEqual(snapshot);
            expect(transactions()).toBe(1);
            expect(fake.batchCount()).toBe(batches);
            expect(location.reload).toHaveBeenCalledOnce();
        } finally {
            acknowledge();
            commit.release();
        }
    });

    it("reloads after acknowledgement within one second when the restore journal is stalled", async () => {
        const held = holdOpen();
        const { fake, settings } = await boot(false);
        const { alertTerminal } = await import("../../alert");
        let acknowledge!: () => void;
        vi.mocked(alertTerminal).mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    acknowledge = resolve;
                }),
        );
        const oldEpoch = fake.store.epoch();
        const base = plain(fake.record("ui", "main"));
        const transactions = writeTransactions();
        fake.failNext = {
            status: 412,
            times: 1,
            match: batchPath,
            body: { error: "EpochMismatch", epoch: "restored-epoch" },
        };
        settings.ui.theme = "unacknowledged before restore";
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
        await held.opened;
        expect(alertTerminal).toHaveBeenCalledOnce();
        expect(location.reload).not.toHaveBeenCalled();
        acknowledge();
        await vi.advanceTimersByTimeAsync(999);
        expect(location.reload).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(location.reload).toHaveBeenCalledOnce();
        expect(transactions()).toBe(0);

        // Opening late permits only the restore snapshot, never the pre-halt queued flush.
        held.release();
        expect(await journal.start()).toBe(true);
        const snapshot = await rows();
        expect(snapshot).toHaveLength(1);
        expect(snapshot[0].epoch).toBe(oldEpoch);
        expect(await layers(UI)).toEqual({
            sent: sent(JSON.stringify({ ...base.data, theme: "unacknowledged before restore" }), base.revision),
        });
        hide();
        hide("visibilitychange");
        await vi.advanceTimersByTimeAsync(5000);
        expect(await rows()).toEqual(snapshot);
        expect(transactions()).toBe(1);
        expect(location.reload).toHaveBeenCalledOnce();
    });
});

describe("chat save journal", () => {
    beforeEach(() => {
        vi.stubGlobal(
            "fetch",
            vi.fn(() => {
                throw new TypeError("Keepalive was not sent");
            }),
        );
    });
    // Identity is chosen while pending, before either transport gets the batch.
    it.each(["not sent", "failed", "lost answer"] as const)(
        "uses the journaled batch id for normal saving after keepalive was %s",
        async (outcome) => {
            const { fake, chat, sync } = await boot();
            const base = fake.chat("c", "k")!.revision;
            const op = { op: "setText", id: "a", text: "edited" };
            chat.setMessageText(refK, "a", "edited");
            // A synchronous fetch refusal leaves the built keepalive in pending.
            await vi.advanceTimersByTimeAsync(0);
            hide();
            const pending = (await chatLayers()).pending!;
            expect(pending).toEqual({
                groupId: expect.any(String),
                baseRevision: base,
                ops: [{ op, before: { value: "A" } }],
            });
            const request = JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)![1]!.body));
            expect(request.chats).toEqual([
                { characterId: "c", chatId: "k", baseRevision: base, groupId: pending.groupId, ops: [op] },
            ]);
            expect(fake.batchCount()).toBe(0);

            if (outcome !== "not sent") {
                const keepalive = vi.fn((path: string, init?: RequestInit) => fake.fetch(path, init));
                vi.stubGlobal("fetch", keepalive);
                if (outcome === "failed") fake.failNext = { status: 500, times: 1, match: batchPath };
                else fake.dropNextBatchResponse = true;
                hide();
                await rows();
                expect(keepalive).toHaveBeenCalledWith(
                    "/api/resources/batch",
                    expect.objectContaining({ keepalive: true }),
                );
                expect(fake.batchBodies()[0]).toEqual(request);
                hide();
                expect(await chatLayers()).toEqual({
                    resend: {
                        ops: [op],
                        baseRevision: base,
                        groupId: pending.groupId,
                        seq: expect.any(Number),
                        inDoubt: true,
                    },
                });
            }

            fake.holdNextBatch = true;
            const saving = sync.flushResources();
            await rows();
            const normal = fake.batchBodies().at(-1)!.chats[0];
            expect(normal).toEqual({ ...request.chats[0], ...(outcome === "not sent" ? {} : { retry: true }) });
            expect((await chatLayers()).resend).toEqual({
                ops: [op],
                baseRevision: base,
                groupId: pending.groupId,
                seq: expect.any(Number),
                inDoubt: outcome !== "not sent",
            });
            fake.releaseBatch!();
            await saving;
            await vi.advanceTimersByTimeAsync(500);
            expect(await chatLayers()).toEqual({});
        },
    );

    // A recoverable whole batch must become two durable identities before its prefix leaves.
    it("commits the split before sending its first 5000 operations, also across an ordinary save cycle, then sends the remainder under a new id", async () => {
        const { fake, chat, sync } = await boot();
        const base = fake.chat("c", "k")!.revision;
        const ops = Array.from({ length: 5001 }, (_, index) => ({
            op: "setText" as const,
            id: index % 2 === 0 ? "a" : "b",
            text: `edit-${index}`,
        }));
        for (const op of ops) chat.setMessageText(refK, op.id, op.text);
        hide();
        const whole = (await chatLayers()).pending!;
        expect(whole.ops.map((entry) => entry.op)).toEqual(ops);
        expect(chat.unloadPendingChatWork(Number.MAX_SAFE_INTEGER)).toEqual([]);
        expect(fake.batchCount()).toBe(0);

        const held = holdJournalCommit();
        const saving = sync.flushResources();
        // Observe a rejection even if an earlier assertion fails while the request is held.
        void saving.catch(() => {});
        const bodiesOfK = () =>
            fake
                .batchBodies()
                .flatMap((body) => body.chats ?? [])
                .filter((c) => c.chatId === "k");
        try {
            try {
                await held.started;
                // An ordinary save cycle runs while the split's row is uncommitted: it sends other
                // work, never the prefix.
                chat.setChatMeta(refJ, { note: "saved during the split" });
                await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
                expect(fake.batchBodies().flatMap((body) => body.chats ?? [])).toEqual([
                    expect.objectContaining({ chatId: "j" }),
                ]);
            } finally {
                fake.holdNextBatchResponse = true;
                held.release();
            }
            await rows();
            const split = await chatLayers();
            expect(split.resend).toEqual({
                ops: ops.slice(0, 5000),
                baseRevision: base,
                groupId: whole.groupId,
                seq: expect.any(Number),
                inDoubt: false,
            });
            expect(split.pending).toEqual({
                ops: [{ op: ops[5000], before: { value: "edit-4998" } }],
                baseRevision: base,
                groupId: expect.any(String),
            });
            expect(split.pending!.groupId).not.toBe(whole.groupId);
            expect(bodiesOfK()).toEqual([
                { characterId: "c", chatId: "k", baseRevision: base, groupId: whole.groupId, ops: ops.slice(0, 5000) },
            ]);
            const acknowledgedBase = fake.chat("c", "k")!.revision;
            fake.releaseBatchResponse!();
            await saving;
            expect(bodiesOfK()).toEqual([
                { characterId: "c", chatId: "k", baseRevision: base, groupId: whole.groupId, ops: ops.slice(0, 5000) },
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: acknowledgedBase,
                    groupId: split.pending!.groupId,
                    ops: ops.slice(5000),
                },
            ]);
            await vi.advanceTimersByTimeAsync(500);
            expect(await chatLayers()).toEqual({});
        } finally {
            sync.stopResourceSync();
            held.release();
            await rows();
            fake.releaseBatchResponse?.();
            await saving.catch(() => {});
        }
    });

    // Both kinds of intent coexist, rebase on acknowledgement, and clean up without another edit.
    it("keeps a text revert and a newer order behind their in-flight layers until each is acknowledged", async () => {
        const { fake, chat, settings, sync } = await boot();
        const base = fake.chat("c", "k")!.revision;
        const orderBase = fake.order("c")!.revision;
        const transactions = writeTransactions();
        fake.holdNextBatchResponse = true;
        settings.ui.theme = "same transaction";
        chat.setMessageText(refK, "a", "B");
        chat.reorderChats("c", ["j", "k"]);
        await vi.advanceTimersByTimeAsync(500);
        const first = fake.batchBodies()[0];
        const sentId = first.chats[0].groupId;
        const resend = {
            ops: [{ op: "setText", id: "a", text: "B" }],
            baseRevision: base,
            groupId: sentId,
            seq: expect.any(Number),
            inDoubt: false,
        };
        expect(first.chats).toEqual([
            { characterId: "c", chatId: "k", baseRevision: base, groupId: expect.any(String), ops: resend.ops },
        ]);
        expect(first.chatOrders).toEqual([{ characterId: "c", baseRevision: orderBase, ids: ["j", "k"] }]);
        expect(await chatLayers()).toEqual({ resend });
        expect(await orderLayers()).toEqual({ sent: { baseRevision: orderBase, ids: ["j", "k"] } });
        expect((await rows()).map((row) => row.scope).sort()).toEqual(["chat", "order", "record"]);
        expect(transactions()).toBe(1);

        chat.setMessageText(refK, "a", "A");
        chat.reorderChats("c", ["k", "j"]);
        await vi.advanceTimersByTimeAsync(500);
        const pending = {
            ops: [{ op: { op: "setText", id: "a", text: "A" }, before: { value: "B" } }],
            baseRevision: base,
            groupId: expect.any(String),
        };
        expect(await chatLayers()).toEqual({ resend, pending });
        const nextId = (await chatLayers()).pending!.groupId;
        expect(nextId).not.toBe(sentId);
        expect(await orderLayers()).toEqual({
            sent: { baseRevision: orderBase, ids: ["j", "k"] },
            latest: { baseRevision: orderBase, ids: ["k", "j"] },
        });
        const nextBase = fake.chat("c", "k")!.revision;
        const nextOrderBase = fake.order("c")!.revision;
        fake.releaseBatchResponse!();
        await vi.advanceTimersByTimeAsync(0);
        await flushJournal();
        expect(await chatLayers()).toEqual({ pending: { ...pending, groupId: nextId, baseRevision: nextBase } });
        expect(await orderLayers()).toEqual({ latest: { baseRevision: nextOrderBase, ids: ["k", "j"] } });

        fake.holdNextBatchResponse = true;
        const saving = sync.flushResources();
        await rows();
        expect(fake.batchBodies()[1].chats).toEqual([
            {
                characterId: "c",
                chatId: "k",
                groupId: nextId,
                baseRevision: nextBase,
                ops: [{ op: "setText", id: "a", text: "A" }],
            },
        ]);
        expect(fake.batchBodies()[1].chatOrders).toEqual([
            { characterId: "c", baseRevision: nextOrderBase, ids: ["k", "j"] },
        ]);
        expect(await chatLayers()).toEqual({
            resend: {
                ...resend,
                groupId: nextId,
                baseRevision: nextBase,
                ops: [{ op: "setText", id: "a", text: "A" }],
            },
        });
        expect(await orderLayers()).toEqual({ sent: { baseRevision: nextOrderBase, ids: ["k", "j"] } });
        fake.releaseBatchResponse!();
        await saving;
        await vi.advanceTimersByTimeAsync(500);
        expect(await rows()).toEqual([]);
    });

    // An old deletion acknowledgement cannot consume the new incarnation's create.
    it("preserves a recreated chat's pending snapshot when the old deletion is acknowledged", async () => {
        const { fake, chat, sync } = await boot();
        const base = fake.chat("c", "k")!.revision;
        fake.holdNextBatchResponse = true;
        chat.deleteChat(refK);
        await vi.advanceTimersByTimeAsync(500);
        const deletion = fake.batchBodies()[0].chats[0];
        expect(deletion).toEqual({
            characterId: "c",
            chatId: "k",
            baseRevision: base,
            groupId: expect.any(String),
            ops: [{ op: "delete" }],
        });
        const snapshot = {
            id: "k",
            name: "Recreated",
            note: "",
            localLore: [],
            fmIndex: -1,
            message: [m("a", "new incarnation")],
        };
        chat.createChat("c", snapshot);
        await vi.advanceTimersByTimeAsync(500);
        const beforeAck = await chatLayers();
        expect(beforeAck).toEqual({
            resend: {
                ops: [{ op: "delete" }],
                baseRevision: base,
                groupId: deletion.groupId,
                seq: expect.any(Number),
                inDoubt: false,
            },
            pending: { ops: [], baseRevision: base, groupId: expect.any(String), createSnapshot: snapshot },
        });
        expect(beforeAck.pending!.groupId).not.toBe(deletion.groupId);
        fake.releaseBatchResponse!();
        await vi.advanceTimersByTimeAsync(0);
        await flushJournal();
        expect(await chatLayers()).toEqual({ pending: { ...beforeAck.pending, baseRevision: null } });
        fake.holdNextBatchResponse = true;
        const saving = sync.flushResources();
        await rows();
        const createOps = [{ op: "create", chat: snapshot, index: 1 }];
        expect(fake.batchBodies()[1].chats).toEqual([
            { characterId: "c", chatId: "k", baseRevision: null, groupId: beforeAck.pending!.groupId, ops: createOps },
        ]);
        expect(await chatLayers()).toEqual({
            resend: {
                ops: createOps,
                baseRevision: null,
                groupId: beforeAck.pending!.groupId,
                seq: expect.any(Number),
                inDoubt: false,
            },
        });
        fake.releaseBatchResponse!();
        await saving;
        await vi.advanceTimersByTimeAsync(500);
        expect(await chatLayers()).toEqual({});
    });

    // A definite rollback can merge newer work, but the older group's identity owns the merge.
    it("journals and sends a rolled-back group merged with newer work under the older id", async () => {
        const { fake, chat, settings, sync } = await boot();
        const base = fake.chat("c", "k")!.revision;
        const ui = fake.record("ui", "main")!;
        fake.set("ui", "main", { ...plain(ui.data), theme: "remote" });
        fake.holdNextBatch = true;
        settings.ui.theme = "conflict";
        chat.setMessageText(refK, "a", "first");
        await vi.advanceTimersByTimeAsync(500);
        const first = fake.batchBodies()[0].chats[0];
        chat.setMessageText(refK, "b", "second");
        await vi.advanceTimersByTimeAsync(500);
        const newer = (await chatLayers()).pending!;
        expect(newer.groupId).not.toBe(first.groupId);
        fake.releaseBatch!();
        await vi.advanceTimersByTimeAsync(0);
        await flushJournal();
        const ops = [
            { op: "setText", id: "a", text: "first" },
            { op: "setText", id: "b", text: "second" },
        ];
        expect(await chatLayers()).toEqual({
            pending: {
                groupId: first.groupId,
                baseRevision: base,
                ops: [
                    { op: ops[0], before: { value: "A" } },
                    { op: ops[1], before: { value: "B" } },
                ],
            },
        });
        await sync.flushResources();
        expect(fake.batchBodies().at(-1)!.chats).toEqual([
            { characterId: "c", chatId: "k", baseRevision: base, groupId: first.groupId, ops },
        ]);
    });

    // Expected befores come from the fixture and the preceding edits, including absent fields.
    it("journals the first before values through coalescing and sends only the operations", async () => {
        const { fake, chat, sync } = await boot();
        const base = fake.chat("c", "k")!.revision;
        chat.setMessageText(refK, "a", "A1");
        chat.setMessageText(refK, "a", "A2");
        chat.patchMessage(refK, "a", { name: "first", data: "A3" });
        chat.patchMessage(refK, "a", { name: "second", disabled: true });
        chat.setChatMeta(refK, { note: "first", scriptstate: { $x: "1" } });
        chat.setChatMeta(refK, { note: "second", scriptstate: { $x: "2" }, name: "renamed" });
        chat.replaceMessage(refK, m("b", "B1"));
        chat.replaceMessage(refK, m("b", "B2"));
        chat.removeMessages(refK, ["c"]);
        chat.appendMessage(refK, m("new", "appended"));
        const translation = {
            text: "translated",
            sourceHash: translationSourceHash("A3"),
            targetLanguage: "ko",
            translatedAt: 1,
        };
        chat.setMessageTranslation(refK, "a", translation);
        chat.setMessageTranslation(refK, "a", null);
        const expected = [
            { op: { op: "setText", id: "a", text: "A2" }, before: { value: "A" } },
            {
                op: { op: "patchMessage", id: "a", set: { name: "second", data: "A3", disabled: true }, unset: [] },
                before: { value: { data: "A2" } },
            },
            {
                op: { op: "meta", set: { note: "second", scriptstate: { $x: "2" }, name: "renamed" }, unset: [] },
                before: { value: { note: "", name: "K" } },
            },
            { op: { op: "setMessage", message: m("b", "B2") }, before: { value: m("b", "B") } },
            { op: { op: "remove", ids: ["c"] }, before: { value: m("c", "C", "char") } },
            { op: { op: "append", messages: [m("new", "appended")], anchor: { end: true } }, before: { absent: true } },
            { op: { op: "setTranslation", id: "a", translation }, before: { absent: true } },
            { op: { op: "setTranslation", id: "a", translation: null }, before: { value: translation } },
        ];
        hide();
        const pending = (await chatLayers()).pending!;
        expect(pending).toEqual({ ops: expected, baseRevision: base, groupId: expect.any(String) });
        await sync.flushResources();
        expect(fake.batchBodies()[0].chats).toEqual([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: base,
                groupId: pending.groupId,
                ops: expected.map((entry) => entry.op),
            },
        ]);
    });

    // Neither an ineligible suffix nor the byte budget permits a keepalive prefix.
    it("keeps whole batches journaled when a multi-id removal or the byte budget prevents keepalive", async () => {
        const { fake, chat, sync } = await boot();
        chat.setMessageText(refK, "a", "eligible prefix");
        chat.removeMessages(refK, ["b", "c"]);
        chat.setChatMeta(refJ, { note: "eligible prefix" });
        chat.appendMessage(refJ, m("large", "x".repeat(70_000)));
        hide();
        expect(fetch).not.toHaveBeenCalled();
        expect(fake.batchCount()).toBe(0);
        const k = (await chatLayers()).pending!;
        const j = (await chatLayers(refJ)).pending!;
        expect(k.ops).toEqual([
            { op: { op: "setText", id: "a", text: "eligible prefix" }, before: { value: "A" } },
            { op: { op: "remove", ids: ["b", "c"] } },
        ]);
        expect(j.ops).toEqual([
            { op: { op: "meta", set: { note: "eligible prefix" }, unset: [] }, before: { value: { note: "" } } },
            {
                op: { op: "append", messages: [m("large", "x".repeat(70_000))], anchor: { end: true } },
                before: { absent: true },
            },
        ]);
        await sync.flushResources();
        expect(fake.batchBodies().flatMap((body) => body.chats ?? [])).toEqual([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: k.baseRevision,
                groupId: k.groupId,
                ops: k.ops.map((entry) => entry.op),
            },
            {
                characterId: "c",
                chatId: "j",
                baseRevision: j.baseRevision,
                groupId: j.groupId,
                ops: j.ops.map((entry) => entry.op),
            },
        ]);
    });

    // The queued remove has no remaining mirror row from which to discover the renamed id.
    it("renames a queued removal and its before when a create acknowledgement renames the removed message", async () => {
        const { fake, chat, sync } = await boot();
        const ref = { chaId: "c", chatId: "new" };
        const oldId = "invalid\tid";
        fake.holdNextBatchResponse = true;
        chat.createChat("c", { id: "new", name: "New", note: "", localLore: [], message: [m(oldId, "remove me")] });
        await vi.advanceTimersByTimeAsync(500);
        await rows();
        const create = fake.batchBodies()[0].chats[0];
        expect(create.ops[0]).toMatchObject({ op: "create", chat: { message: [m(oldId, "remove me")] } });
        const serverId = fake.chat("c", "new")!.data.message[0].chatId!;
        const base = fake.chat("c", "new")!.revision;
        expect(serverId).not.toBe(oldId);
        chat.removeMessages(ref, [oldId]);
        await vi.advanceTimersByTimeAsync(500);
        const beforeAck = await chatLayers(ref);
        expect(beforeAck.pending!.ops).toEqual([
            { op: { op: "remove", ids: [oldId] }, before: { value: m(oldId, "remove me") } },
        ]);
        fake.releaseBatchResponse!();
        await vi.advanceTimersByTimeAsync(0);
        await flushJournal();
        expect(await chatLayers(ref)).toEqual({
            pending: {
                baseRevision: base,
                groupId: beforeAck.pending!.groupId,
                ops: [{ op: { op: "remove", ids: [serverId] }, before: { value: m(serverId, "remove me") } }],
            },
        });
        await sync.flushResources();
        expect(fake.batchBodies()[1].chats).toEqual([
            {
                characterId: "c",
                chatId: "new",
                baseRevision: base,
                groupId: beforeAck.pending!.groupId,
                ops: [{ op: "remove", ids: [serverId] }],
            },
        ]);
    });
});
