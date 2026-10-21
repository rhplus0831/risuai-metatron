import { tick } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { warmMutationGraph } from "./mutationStoresHarness";
import { type ServerFeedEvent, StoreBackedServer } from "./storeBackedServer";

// The save loop's module field-text cache (`moduleProjection` and `moduleTexts` in
// `resourceSync.svelte.ts`, `moduleItemFieldStamp` in `records.svelte.ts`; `docs/structure/persistence.md`
// save step 2) under the real boot, the real save loop, the real mutation module, and the real server
// store with its change feed (`storeBackedServer.ts`). The oracle is twofold: the server's record must
// equal the mirror's after every save, and the development comparison of the cached text with a whole
// serialization (`console.error`, reported, never repaired) must not fire once, so `console.error` is
// spied on and never mocked away here. Covered: an unchanged large asset list is not serialized again
// after an edit of another field of the same module while the edited field is, and the item patch names
// only that field; a reorder, a deletion with the UI's self-assignment, and an insertion reuse every
// text; the mutation module's writes; a list with repeated ids (sent whole, texts still reused); state
// shared between two modules (the cache off until the server's copy arrives, the edits still saved);
// and another tab's item patch applied from the feed (fresh identities, the next save a patch again).

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        terminal: vi.fn(async () => undefined),
    },
}));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: alerts.error,
        alertNormal: alerts.normal,
        alertReloadNotice: alerts.normal,
        alertNormalWait: alerts.normalWait,
        alertTerminal: alerts.terminal,
    }),
);
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored", chatGenerating: "generating" },
    changeLanguage: vi.fn(),
}));
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

const KINDS = Object.values(RESOURCE_KIND);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const DEV_REPORT = /modules: the field-text cache differs/;
/** A module's asset list: `count` entries of about 50 UTF-16 units each. */
const assets = (count: number): [string, string, string][] =>
    Array.from({ length: count }, (_, i) => [`asset-${i}`, `assets/${i}-${"x".repeat(24)}.png`, "png"]);
/** Lore entries as the tests write them (`key` and `content` only, the shape the normalizer leaves alone). */
const lore = (...contents: string[]): any[] => contents.map((content, i) => ({ key: `k${i}`, content }));
/** A module as the tests write it (no `description`: the server's normalizer refuses only a non-string one). */
const module = (id: string, extra: Record<string, unknown> = {}): any => ({ id, name: id, ...extra });

/**
 * The `loadData` sequence against a store-backed server with the change feed: modules `m1` (a large
 * asset list and a lorebook), `m2`, and `m3`, the adapter started with its boot pass done (it marks
 * every collection, so that pass projects the list and primes the cache), then the spies installed.
 */
async function boot() {
    vi.resetModules();
    const fake = await StoreBackedServer.create({ feed: true });
    server.current = fake;
    fake.set("presets", "main", [{ id: "pa", name: "p1" }]);
    fake.set("modules", "main", [
        module("m1", { assets: assets(3000), lorebook: lore("one", "two") }),
        module("m2", { lorebook: lore("m2") }),
        module("m3"),
    ]);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});

    const client = await import("../resourceClient");
    const sync = await import("../resourceSync.svelte");
    const chat = await import("../chatStore.svelte");
    const bootstrap = await import("../../bootstrap");
    const records = await import("../records.svelte");
    const collectionStore = await import("../collectionStore.svelte");
    const { settings } = await import("../settingsViews.svelte");
    const selectionModule = await import("../selection.svelte");

    const snapshot = await client.readKinds(KINDS, { chats: true });
    sync.seedResources(snapshot);
    chat.seedChats(snapshot.chats ?? [], snapshot.chatOrders ?? []);
    bootstrap.installBootRecords(snapshot);
    selectionModule.selectCharacter(null);
    chat.initializeChats();
    const adding = vi.spyOn(window, "addEventListener").mockImplementation(() => {});
    const addingDocument = vi.spyOn(document, "addEventListener").mockImplementation(() => {});
    sync.startResourceSync();
    adding.mockRestore();
    addingDocument.mockRestore();
    await tick();
    await sync.flushResources();
    expect(fake.batchBodies().flatMap((batch: any) => batch.ops.map((op: any) => `${op.kind}/${op.id}`))).toEqual([]);
    fake.requests.length = 0;
    fake.feedEvents.length = 0;
    fake.onFeed = (event: ServerFeedEvent) => {
        if (event.type === "change" && event.epoch === client.getResourceEpoch()) {
            sync.noteRemoteChanges(event.changes);
        }
    };
    // Spied, not mocked away: the development comparison reports a cache miss here, and the tests
    // assert it never fires.
    const errors = vi.spyOn(console, "error");
    const stringify = vi.spyOn(JSON, "stringify");

    const live = () => records.recordData<any[]>("modules")!;
    const byId = (id: string) => live().find((entry) => entry?.id === id)!;
    const record = () => fake.record("modules", "main")?.data as any[];
    const revision = () => fake.record("modules", "main")!.revision;
    const ops = () => fake.batchBodies().flatMap((batch: any) => batch.ops ?? []) as any[];
    const reads = () => fake.requests.filter((r) => r.path === "/api/resources/read").length;
    const reports = () => errors.mock.calls.filter((call) => DEV_REPORT.test(String(call[0]))).length;
    /** How often `JSON.stringify` was called with exactly this value (a field serialized on its own). */
    const serialized = (value: unknown) => stringify.mock.calls.filter((call) => call[0] === value).length;
    /** Whether the record's texts may be cached (one probe of one live field). */
    const cacheable = () => records.moduleItemFieldStamp(live()[0], "id") !== null;
    /** Server and mirror hold the same list, the held revision is the server's, and the comparison never fired. */
    const agree = () => {
        expect(plain(settings.modules), "server equals mirror").toEqual(record());
        expect(sync.heldRecordRevision("modules", "main"), "held revision").toBe(revision());
        expect(reports(), "DEV cache reports").toBe(0);
    };
    /** Advances past the cycle's delay and lets it finish; then asserts that nothing else follows. */
    const settle = async () => {
        await vi.advanceTimersByTimeAsync(1500);
        const before = { batches: fake.batchCount(), all: fake.requests.length };
        await vi.advanceTimersByTimeAsync(5000);
        expect({ batches: fake.batchCount(), all: fake.requests.length }, "nothing follows").toEqual(before);
        expect(await sync.flushResources()).toEqual({ discarded: [] });
        expect(fake.batchCount(), "a flush sends nothing more").toBe(before.batches);
    };
    /** Another tab's modules write: an item patch at the current revision, through the real store. */
    const patchModules = (patch: unknown) =>
        fake.store.applyChanges({
            ops: [{ kind: fake.kind("modules"), id: "main", baseRevision: revision(), patch }],
        }).results[0].revision!;
    const noNotice = () => {
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(alerts.error).not.toHaveBeenCalled();
    };
    return {
        fake,
        sync,
        records,
        collectionStore,
        settings,
        live,
        byId,
        record,
        revision,
        ops,
        reads,
        reports,
        serialized,
        cacheable,
        agree,
        settle,
        patchModules,
        noNotice,
    };
}

beforeAll(() => warmMutationGraph(), 60_000);

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn(), protocol: "http:", host: "test" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("cache reuse", () => {
    it("does not serialize an unchanged asset list again after an edit of the same module's lorebook, and patches only that field", async () => {
        const { fake, settings, byId, ops, serialized, agree, settle, noNotice } = await boot();
        // The boot pass primed the cache: the edit under `lorebook` serializes that field and nothing else.
        settings.modules[0].lorebook[0].content = "edited once";
        await settle();
        const m1 = byId("m1");
        expect(serialized(m1.assets)).toBe(0);
        expect(serialized(m1.lorebook)).toBe(1);
        expect(ops()[0].patch.changes.map((change: any) => Object.keys(change.set))).toEqual([["lorebook"]]);
        agree();
        fake.requests.length = 0;

        settings.modules[0].lorebook[1].content = "edited twice";
        await settle();
        expect(serialized(m1.assets)).toBe(0);
        expect(serialized(m1.lorebook)).toBe(2);
        expect(serialized(byId("m2").lorebook)).toBe(0);
        expect(ops()).toHaveLength(1);
        expect(ops()[0].patch).toEqual({
            items: [],
            changes: [{ id: "m1", set: { lorebook: lore("edited once", "edited twice") }, remove: [] }],
        });
        agree();
        fake.requests.length = 0;

        // `ModuleMenu.svelte`'s pattern: a push, then the field assigned to itself.
        settings.modules[0].lorebook.push({ key: "k2", content: "pushed" } as any);
        settings.modules[0].lorebook = settings.modules[0].lorebook;
        settings.modules[1].name = "M2";
        await settle();
        expect(serialized(m1.assets)).toBe(0);
        expect(ops()[0].patch.changes).toEqual([
            { id: "m1", set: { lorebook: lore("edited once", "edited twice", "pushed") }, remove: [] },
            { id: "m2", set: { name: "M2" }, remove: [] },
        ]);
        agree();
        noNotice();
    }, 20_000);

    it("a reorder, a deletion with the self-assignment, and an insertion reuse every text and send the order", async () => {
        const { fake, settings, records, byId, ops, serialized, agree, settle, noNotice } = await boot();
        const m1 = byId("m1");
        settings.modules.reverse();
        await settle();
        expect(serialized(m1.assets)).toBe(0);
        expect(ops()[0].patch).toEqual({ items: [], changes: [], order: ["m3", "m2", "m1"] });
        agree();
        fake.requests.length = 0;

        // `ModuleSettings.svelte`'s delete: a splice and `settings.modules = settings.modules`.
        settings.modules.splice(1, 1);
        settings.modules = settings.modules;
        await settle();
        expect(serialized(m1.assets)).toBe(0);
        expect(ops()[0].patch).toEqual({ items: [], changes: [], order: ["m3", "m1"] });
        agree();
        fake.requests.length = 0;

        settings.modules.unshift(module("m0", { lorebook: lore("new") }));
        await settle();
        expect(serialized(m1.assets)).toBe(0);
        expect(ops()[0].patch).toEqual({
            items: [module("m0", { lorebook: lore("new") })],
            changes: [],
            order: ["m0", "m3", "m1"],
        });
        agree();
        fake.requests.length = 0;

        // An indexed swap through retained wrappers (`records.test.ts`): identities move, texts stay.
        const list = records.trackedRecord<any[]>("modules")!;
        const [first, second] = [list[0], list[1]];
        list[0] = second;
        list[1] = first;
        await settle();
        expect(serialized(m1.assets)).toBe(0);
        expect(ops()[0].patch).toEqual({ items: [], changes: [], order: ["m3", "m0", "m1"] });
        agree();
        noNotice();
    }, 20_000);

    it("the mutation module's writes: updateModule patches one field, addModule sends the new module whole, setModules copies the list once", async () => {
        const { fake, collectionStore, byId, ops, serialized, cacheable, agree, settle, noNotice } = await boot();
        collectionStore.updateModule("m1", { name: "renamed" });
        await settle();
        const m1 = byId("m1");
        expect(serialized(m1.assets)).toBe(0);
        expect(ops()[0].patch.changes).toEqual([{ id: "m1", set: { name: "renamed" }, remove: [] }]);
        agree();
        fake.requests.length = 0;

        collectionStore.updateModule("m1", { description: "described" });
        collectionStore.addModule(module("m4"));
        await settle();
        expect(serialized(m1.assets)).toBe(0);
        expect(ops()[0].patch.changes).toEqual([{ id: "m1", set: { description: "described" }, remove: [] }]);
        expect(ops()[0].patch.items).toEqual([module("m4")]);
        agree();
        fake.requests.length = 0;

        collectionStore.removeModule("m4");
        await settle();
        expect(serialized(m1.assets)).toBe(0);
        expect(ops()[0].patch).toEqual({ items: [], changes: [], order: ["m1", "m2", "m3"] });
        agree();
        fake.requests.length = 0;

        // A whole replacement with plain data: copied in, every field serialized once, then cached.
        const replacement = plain(record());
        replacement[2].name = "M3";
        collectionStore.setModules(replacement);
        await settle();
        expect(cacheable()).toBe(true);
        const fresh = byId("m1");
        expect(fresh).not.toBe(m1);
        expect(serialized(fresh.assets)).toBe(1);
        expect(ops()[0].patch.changes).toEqual([{ id: "m3", set: { name: "M3" }, remove: [] }]);
        agree();
        fake.requests.length = 0;

        collectionStore.updateModule("m2", { name: "M2" });
        await settle();
        expect(serialized(fresh.assets)).toBe(1);
        agree();
        noNotice();

        function record() {
            return fake.record("modules", "main")!.data as any[];
        }
    }, 20_000);

    it("a list whose ids repeat is sent whole, and its texts are still reused", async () => {
        const { fake, collectionStore, settings, byId, ops, serialized, agree, settle, noNotice } = await boot();
        collectionStore.setModules([module("dup", { assets: assets(2000) }), module("dup"), module("x")]);
        await settle();
        const dup = byId("dup");
        expect(serialized(dup.assets)).toBe(1);
        expect(ops()[0]).not.toHaveProperty("patch");
        agree();
        fake.requests.length = 0;

        settings.modules[2].name = "X";
        await settle();
        expect(serialized(dup.assets)).toBe(1);
        expect(ops()[0]).toMatchObject({ kind: "modules", data: expect.any(Array) });
        expect(ops()[0]).not.toHaveProperty("patch");
        agree();
        noNotice();
    }, 20_000);
});

describe("soundness", () => {
    it("state shared between two modules turns the cache off, the edits through either path still save, and the server's copy turns it on again", async () => {
        const { fake, settings, byId, reads, cacheable, agree, settle, patchModules, noNotice } = await boot();
        settings.modules[0].lorebook[0].content = "primed";
        await settle();
        fake.requests.length = 0;

        // The same lorebook under two modules: a write through one changes the other's text.
        settings.modules[1].lorebook = settings.modules[0].lorebook;
        expect(cacheable()).toBe(false);
        settings.modules[0].lorebook[0].content = "written through m1";
        await settle();
        expect(byId("m2").lorebook[0].content).toBe("written through m1");
        agree();
        fake.requests.length = 0;

        settings.modules[1].lorebook[1].content = "written through m2";
        await settle();
        expect(cacheable()).toBe(false);
        expect(byId("m1").lorebook[1].content).toBe("written through m2");
        agree();
        fake.requests.length = 0;

        // Another tab's write arrives from the feed: the server's copy is fresh detached data.
        patchModules({ changes: [{ id: "m3", set: { name: "Remote" } }] });
        await settle();
        expect(reads()).toBe(0);
        expect(cacheable()).toBe(true);
        expect(plain(settings.modules[2])).toEqual(module("m3", { name: "Remote" }));
        agree();
        fake.requests.length = 0;

        settings.modules[0].lorebook[0].content = "after the reload";
        await settle();
        expect(byId("m2").lorebook[0].content).toBe("written through m1");
        agree();
        noNotice();
    }, 20_000);

    it("another tab's item patch gives the list fresh identities; the next local save is a patch of the edited field only", async () => {
        const { fake, settings, byId, ops, reads, serialized, agree, settle, patchModules, noNotice } = await boot();
        const before = byId("m1");
        patchModules({ changes: [{ id: "m2", set: { name: "Remote" } }] });
        await settle();
        expect(reads()).toBe(0);
        expect(fake.batchCount()).toBe(0);
        const after = byId("m1");
        expect(after).not.toBe(before);
        agree();

        // The replaced list was projected once when the patch was applied (its new identities): the
        // save after the edit serializes only `lorebook`.
        settings.modules[0].lorebook[0].content = "after remote";
        await settle();
        expect(serialized(before.assets)).toBe(0);
        expect(serialized(after.assets)).toBe(1);
        expect(ops()[0].patch).toEqual({
            items: [],
            changes: [{ id: "m1", set: { lorebook: lore("after remote", "two") }, remove: [] }],
        });
        agree();
        fake.requests.length = 0;

        settings.modules[0].name = "M1";
        await settle();
        expect(serialized(after.assets)).toBe(1);
        expect(ops()[0].patch.changes).toEqual([{ id: "m1", set: { name: "M1" }, remove: [] }]);
        agree();
        noNotice();
    }, 20_000);

    it("an asset rename, addition and deletion replace the frozen list whole, each an item patch of assets; another tab's assets patch arrives frozen", async () => {
        const { fake, settings, records, byId, ops, reads, agree, settle, patchModules, noNotice } = await boot();
        const m1 = byId("m1");
        const original = settings.modules[0].assets!;
        expect(Object.isFrozen(original)).toBe(true);
        expect(records.isRecordWrapper(original)).toBe(false);
        const assetsPatch = () => {
            expect(ops()).toHaveLength(1);
            expect(ops()[0].patch.items).toEqual([]);
            expect(ops()[0].patch.changes.map((change: any) => [change.id, Object.keys(change.set)])).toEqual([
                ["m1", ["assets"]],
            ]);
            return ops()[0].patch.changes[0].set.assets as string[][];
        };
        // A rename (`ModuleMenu`'s per-keystroke replacement): the tuple copied, index 0 written.
        settings.modules[0].assets = original.map((asset, i) => {
            if (i !== 1) return asset;
            const renamed: [string, string, string] = [...asset];
            renamed[0] = "renamed";
            return renamed;
        });
        await settle();
        expect(assetsPatch()[1]).toEqual(["renamed", original[1][1], "png"]);
        expect(byId("m1")).toBe(m1);
        expect(settings.modules[0].assets![0]).toBe(original[0]);
        agree();
        fake.requests.length = 0;

        settings.modules[0].assets = [...settings.modules[0].assets!, ["added", "assets/added.png", "png"]];
        await settle();
        expect(assetsPatch()).toHaveLength(3001);
        agree();
        fake.requests.length = 0;

        settings.modules[0].assets = settings.modules[0].assets!.filter((_, i) => i !== 0);
        await settle();
        expect(assetsPatch()).toHaveLength(3000);
        expect(fake.record("modules", "main")!.data[0].assets[0]).toEqual(["renamed", original[1][1], "png"]);
        expect(Object.isFrozen(settings.modules[0].assets)).toBe(true);
        agree();
        fake.requests.length = 0;

        // Another tab's item patch of `assets`: applied from the feed as a frozen list, no read, no
        // save; the next local rename is again a patch of `assets` alone.
        patchModules({ changes: [{ id: "m1", set: { assets: [["remote", "assets/remote.png", "png"]] } }] });
        await settle();
        expect(reads()).toBe(0);
        expect(fake.batchCount()).toBe(0);
        const remote = settings.modules[0].assets!;
        expect(plain(remote)).toEqual([["remote", "assets/remote.png", "png"]]);
        expect(Object.isFrozen(remote)).toBe(true);
        expect(Object.isFrozen(remote[0])).toBe(true);
        expect(records.isRecordWrapper(remote)).toBe(false);
        agree();
        settings.modules[0].assets = [["remote renamed", "assets/remote.png", "png"]];
        await settle();
        expect(ops()[0].patch).toEqual({
            items: [],
            changes: [{ id: "m1", set: { assets: [["remote renamed", "assets/remote.png", "png"]] }, remove: [] }],
        });
        agree();
        noNotice();
    }, 20_000);
});
