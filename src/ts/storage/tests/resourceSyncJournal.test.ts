import { IDBDatabase, IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_JOURNAL_ENTRY_BYTES, type DraftJournal, type RecordLayerValues } from "../draftJournal";
import { createFakeLockManager } from "./fakeLockManager";
import { bootMutations, plain, SAVE_DEBOUNCE_MS, warmMutationGraph } from "./mutationStoresHarness";
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
const pendingTransactions = new Set<Promise<void>>();
const openReleases: (() => void)[] = [];
const listeners = new Map<string, EventListenerOrEventListenerObject[]>();
const batchPath = (path: string) => path === "/api/resources/batch";
const target = (kind: string, id = "main") => `${kind}\0${id}`;
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

    it("clears discarded layers when a conflict accepts the server copy", async () => {
        const { fake, settings } = await boot();
        const base = fake.record("ui", "main")!;
        fake.set("ui", "main", { ...plain(base.data), theme: "remote" });
        fake.holdNextBatch = true;
        settings.ui.theme = "local";
        await vi.advanceTimersByTimeAsync(500);
        expect((await layers(UI)).sent).toEqual(
            sent(JSON.stringify({ ...plain(base.data), theme: "local" }), base.revision),
        );
        fake.releaseBatch!();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(500);
        expect(settings.ui.theme).toBe("remote");
        expect(await layers(UI)).toEqual({});
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
        expect(await layers(UI)).toEqual({});
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

    it("does not journal after a restore halt, even when startup was still pending", async () => {
        const held = holdOpen();
        const { fake, settings } = await boot(false);
        const transactions = writeTransactions();
        fake.failNext = {
            status: 412,
            times: 1,
            match: batchPath,
            body: { error: "EpochMismatch", epoch: "restored" },
        };
        settings.ui.theme = "old epoch";
        await vi.advanceTimersByTimeAsync(500);
        await held.opened;
        expect(fake.batchCount()).toBe(1);
        expect(location.reload).toHaveBeenCalledOnce();
        held.release();
        expect(await journal.start()).toBe(true);
        hide();
        hide("visibilitychange");
        await vi.advanceTimersByTimeAsync(5000);
        expect(await rows()).toEqual([]);
        expect(transactions()).toBe(0);
    });
});
