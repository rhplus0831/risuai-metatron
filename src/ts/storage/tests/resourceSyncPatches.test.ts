import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { type ServerFeedEvent, StoreBackedServer } from "./storeBackedServer";

// Audit item A1 (`docs/structure/persistence.md`, save loop steps 2, 3, 5, and 9): a held character
// or `modules` record is saved as a record patch (`updateOperation`), another tab's `modules` patch
// is applied from the change feed without a read (`applyModulesPatch`), under the real boot, the
// real save loop, the real mutation modules, and the real server store with its normalizers and
// change feed (`storeBackedServer.ts`; every commit is handed to `noteRemoteChanges` as the
// live-update socket would). The patch helpers themselves are in `shared/tests/recordPatch.test.ts`,
// the store and the route in `server/src/tests/{resourceStore,changeFeed,resourcesBatch}.test.ts`.

const { server, alerts, bodies } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        terminal: vi.fn(async () => undefined),
    },
    /** The raw text of every request body (`fake.requests` holds them parsed). */
    bodies: [] as string[],
}));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => {
        if (typeof init?.body === "string") {
            bodies.push(init.body);
        }
        return server.current.fetch(path, init);
    },
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertReloadNotice: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertTerminal: alerts.terminal,
}));
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
/** A JSON value's text with every object's keys sorted (array order kept): equal texts, equal values. */
const canonicalJson = (value: unknown): string => {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
};
const LOCAL = new Set(["chats", "chatPage", "reloadKeys"]);
/** A list of asset entries about `count * 40` bytes long (a character's or module's `additionalAssets`). */
const assets = (count: number) => Array.from({ length: count }, (_, i) => [`asset-${i}`, `assets/${i}.png`, "png"]);
const module = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, ...extra });

/**
 * The `loadData` sequence against a store-backed server with the change feed: character `c` (one
 * empty chat `k`) stored through the server's normalizer, modules `m1` (with a large asset list),
 * `m2`, and `m3`, nothing selected, the adapter started with its boot pass done. Then live delivery
 * starts, and requests can be held or hooked (`intercept`).
 */
async function boot(prepare?: (fake: StoreBackedServer) => void) {
    vi.resetModules();
    const fake = await StoreBackedServer.create({ feed: true });
    server.current = fake;
    fake.set("presets", "main", [{ id: "pa", name: "p1" }]);
    fake.set("modules", "main", [module("m1", { additionalAssets: assets(5_000) }), module("m2"), module("m3")]);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    fake.store.applyChanges({
        ops: [{ kind: fake.kind("characters"), id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
        chats: [
            {
                characterId: "c",
                chatId: "k",
                baseRevision: null,
                ops: [{ op: "create", chat: { id: "k", name: "K", note: "", localLore: [], message: [] } } as any],
            },
        ],
    });

    prepare?.(fake);

    const client = await import("../resourceClient");
    const sync = await import("../resourceSync.svelte");
    const chat = await import("../chatStore.svelte");
    const bootstrap = await import("../../bootstrap");
    const records = await import("../records.svelte");
    const characterStore = await import("../characterStore.svelte");
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
    bodies.length = 0;
    expect(fake.batchBodies().flatMap((batch: any) => batch.ops.map((op: any) => `${op.kind}/${op.id}`))).toEqual([]);
    fake.requests.length = 0;
    fake.feedEvents.length = 0;

    const live = { paused: false, queue: [] as ServerFeedEvent[] };
    const deliver = (event: ServerFeedEvent) => {
        if (event.type === "change" && event.epoch === client.getResourceEpoch()) {
            sync.noteRemoteChanges(event.changes);
        }
    };
    fake.onFeed = (event) => (live.paused ? live.queue.push(event) : deliver(event));
    const flushFeed = () => {
        for (const event of live.queue.splice(0)) {
            deliver(event);
        }
    };

    // Holds the next request matching `hold` after the server answered it; `afterApply` runs right
    // after a request was applied, before its answer returns (as in `resourceSyncLive.test.ts`).
    const intercept = {
        hold: null as null | ((path: string) => boolean),
        release: null as null | (() => void),
        afterApply: null as null | ((path: string) => void),
    };
    const real = fake.fetch;
    server.current = Object.assign(Object.create(fake), {
        fetch: async (path: string, init?: RequestInit) => {
            const response = real(path, init);
            if (intercept.afterApply) {
                const hook = intercept.afterApply;
                intercept.afterApply = null;
                hook(path);
            }
            if (intercept.hold?.(path)) {
                intercept.hold = null;
                await new Promise<void>((resolve) => (intercept.release = resolve));
            }
            return response;
        },
        close: () => fake.close(),
    });

    const changed: string[] = [];
    sync.onRemoteRecordApplied((kind, id) => changed.push(`${kind}/${id}`));
    const character = (id = "c") => characterStore.characterList().find((entry: any) => entry?.chaId === id) as any;
    const record = (kind: string, id = "main") => fake.record(kind, id)?.data as any;
    const revision = (kind: string, id = "main") => fake.record(kind, id)!.revision;
    const ops = () => fake.batchBodies().flatMap((batch: any) => batch.ops ?? []) as any[];
    const reads = () => fake.requests.filter((r) => r.path === "/api/resources/read").length;
    /** The character as the save loop projects it (own fields in their order, no local fields). */
    const projected = (id = "c") =>
        Object.fromEntries(Object.entries(plain(character(id))).filter(([key]) => !LOCAL.has(key)));
    /** Mirror and server hold the same record as JSON values, and the held revision is the server's. */
    const agree = (kind: string, id = "main") => {
        const mirror = kind === "characters" ? projected(id) : plain(settings[kind as "modules"]);
        expect(canonicalJson(mirror), `${kind}/${id}: mirror and server`).toBe(canonicalJson(record(kind, id)));
        expect(sync.heldRecordRevision(kind, id), `${kind}/${id}: held revision`).toBe(revision(kind, id));
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
    const noNotice = () => {
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(alerts.error).not.toHaveBeenCalled();
    };
    /** The resource entries of the feed events published since the last call. */
    const published = () =>
        fake.feedEvents.splice(0).flatMap((event) => (event.type === "change" ? event.changes.resources : []));
    /** Another tab's modules write: an item patch at the current revision, through the real store. */
    const patchModules = (patch: unknown) =>
        fake.store.applyChanges({
            ops: [{ kind: fake.kind("modules"), id: "main", baseRevision: revision("modules"), patch }],
        }).results[0].revision!;
    return {
        fake,
        sync,
        records,
        characterStore,
        collectionStore,
        selection: selectionModule,
        settings,
        live,
        flushFeed,
        intercept,
        changed,
        character,
        record,
        revision,
        ops,
        reads,
        projected,
        agree,
        settle,
        noNotice,
        published,
        patchModules,
    };
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn(), protocol: "http:", host: "test" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close();
});

describe("what a save sends", () => {
    it("sends a character edit as a field patch of the changed fields only: a large unchanged asset list stays home, a removed field is named, the feed carries the same patch", async () => {
        const { fake, sync, characterStore, character, record, revision, ops, agree, settle, noNotice, published } =
            await boot();
        const list = assets(5_000);
        characterStore.updateCharacter("c", { additionalAssets: list });
        await settle();
        // The first save carries the list (a new field) and nothing else of the record.
        expect(ops()).toEqual([
            {
                kind: "characters",
                id: "c",
                baseRevision: expect.any(String),
                patch: { set: { additionalAssets: list }, remove: [] },
            },
        ]);
        const whole = JSON.stringify(record("characters", "c")).length;
        expect(whole).toBeGreaterThan(100_000);
        agree("characters", "c");
        fake.requests.length = 0;
        published();

        // Typing a name: the patch names the one field, far smaller than the record.
        const base = revision("characters", "c");
        character("c").name = "Renamed";
        characterStore.updateCharacter("c", { extra: "x" });
        await settle();
        expect(ops()).toEqual([
            {
                kind: "characters",
                id: "c",
                baseRevision: base,
                patch: { set: { name: "Renamed", extra: "x" }, remove: [] },
            },
        ]);
        expect(JSON.stringify(fake.batchBodies()[0]).length).toBeLessThan(1000);
        expect(record("characters", "c")).toMatchObject({ name: "Renamed", extra: "x", additionalAssets: list });
        agree("characters", "c");
        // The feed carried the patch of this tab's own write (an echo, dropped: no read, no write).
        expect(published()).toEqual([
            {
                kind: "characters",
                id: "c",
                revision: revision("characters", "c"),
                patch: { baseRevision: base, set: { name: "Renamed", extra: "x" }, remove: [] },
            },
        ]);
        fake.requests.length = 0;

        // A removed field; the saved text afterwards is the mirror's, the server's holds its own order.
        characterStore.updateCharacter("c", { extra: undefined, name: "Renamed again" });
        await settle();
        expect(ops()).toEqual([
            expect.objectContaining({ patch: { set: { name: "Renamed again" }, remove: ["extra"] } }),
        ]);
        expect(Object.hasOwn(record("characters", "c"), "extra")).toBe(false);
        agree("characters", "c");
        expect(sync.heldRecordRevision("characters", "c")).toBe(revision("characters", "c"));
        noNotice();
    }, 20_000);
    it("sends a modules edit as an item patch: a renamed module as its changed fields, a new one whole, the order when it changed, an empty order to clear; a large module stays home", async () => {
        const { fake, collectionStore, settings, record, revision, ops, agree, settle, noNotice, published } =
            await boot();
        expect(JSON.stringify(record("modules")).length).toBeGreaterThan(100_000);
        // A rename through the wrapper and a field removed through the mutation module.
        collectionStore.updateModule("m2", { description: "d", extra: 1 });
        settings.modules[1].name = "Two";
        collectionStore.updateModule("m2", { extra: undefined });
        let base = revision("modules");
        await settle();
        expect(ops()).toEqual([
            {
                kind: "modules",
                id: "main",
                baseRevision: base,
                patch: { items: [], changes: [{ id: "m2", set: { description: "d", name: "Two" }, remove: [] }] },
            },
        ]);
        expect(JSON.stringify(fake.batchBodies()[0]).length).toBeLessThan(1000);
        expect(record("modules").map((entry: any) => entry.name)).toEqual(["m1", "Two", "m3"]);
        expect(published()).toEqual([
            {
                kind: "modules",
                id: "main",
                revision: revision("modules"),
                patch: {
                    baseRevision: base,
                    items: [],
                    changes: [{ id: "m2", set: { description: "d", name: "Two" }, remove: [] }],
                },
            },
        ]);
        agree("modules");
        fake.requests.length = 0;

        // A new module (whole, with the order), a removal, and a move, in one save.
        base = revision("modules");
        collectionStore.addModule(module("m4", { lorebook: [] }));
        collectionStore.removeModule("m3");
        collectionStore.setModules([
            plain(settings.modules[2]),
            plain(settings.modules[0]),
            plain(settings.modules[1]),
        ]);
        await settle();
        expect(ops()).toEqual([
            {
                kind: "modules",
                id: "main",
                baseRevision: base,
                patch: { items: [module("m4", { lorebook: [] })], changes: [], order: ["m4", "m1", "m2"] },
            },
        ]);
        expect(JSON.stringify(fake.batchBodies()[0]).length).toBeLessThan(1000);
        expect(record("modules").map((entry: any) => entry.id)).toEqual(["m4", "m1", "m2"]);
        expect(record("modules")[1].additionalAssets).toHaveLength(5_000);
        agree("modules");
        fake.requests.length = 0;

        // A reorder alone, then a cleared list: its whole text (`[]`) is smaller than the patch
        // (`{ items: [], changes: [], order: [] }`), so the list goes whole.
        base = revision("modules");
        collectionStore.setModules([
            plain(settings.modules[1]),
            plain(settings.modules[0]),
            plain(settings.modules[2]),
        ]);
        await settle();
        expect(ops()).toEqual([
            {
                kind: "modules",
                id: "main",
                baseRevision: base,
                patch: { items: [], changes: [], order: ["m1", "m4", "m2"] },
            },
        ]);
        agree("modules");
        fake.requests.length = 0;
        base = revision("modules");
        collectionStore.setModules([]);
        await settle();
        expect(ops()).toEqual([{ kind: "modules", id: "main", baseRevision: base, data: [] }]);
        expect(record("modules")).toEqual([]);
        agree("modules");
        noNotice();
    }, 20_000);
    it("sends the whole record instead when the patch is not smaller in UTF-8 bytes, or when key order alone differs sends nothing", async () => {
        const { fake, sync, characterStore, character, record, revision, ops, agree, settle, noNotice } = await boot();
        // A field named with 400 Hangul syllables: 400 UTF-16 units, 1,200 UTF-8 bytes.
        const name = "가".repeat(400);
        const whole = JSON.stringify(record("characters", "c")).length;
        expect(whole).toBeGreaterThan(400 + 30);
        expect(whole).toBeLessThan(1200);
        characterStore.updateCharacter("c", { [name]: 1 });
        await settle();
        // Adding it: the patch (the name once) is smaller than the whole record (the name once too, plus the rest).
        expect(ops()).toEqual([expect.objectContaining({ patch: { set: { [name]: 1 }, remove: [] } })]);
        agree("characters", "c");
        fake.requests.length = 0;
        // Removing it: `remove` carries the name (1,200 bytes), the whole record no longer does, so
        // the whole record is the smaller operation on the wire, though not in UTF-16 units.
        const base = revision("characters", "c");
        characterStore.updateCharacter("c", { [name]: undefined });
        await settle();
        const [sent] = ops();
        expect(sent).toEqual({ kind: "characters", id: "c", baseRevision: base, data: expect.any(Object) });
        expect(Object.hasOwn(sent.data, name)).toBe(false);
        expect(Object.hasOwn(record("characters", "c"), name)).toBe(false);
        agree("characters", "c");
        fake.requests.length = 0;

        // Key order alone: the same fields replaced in another order (a Svelte proxy keeps a deleted
        // and re-added key where it was, so a replacement is the way). No field reads as changed, so
        // nothing is sent and the local text is held as saved at the same revision.
        const held = revision("characters", "c");
        const reversed = Object.fromEntries(
            Object.entries(plain(character("c")))
                .filter(([key]) => !LOCAL.has(key))
                .reverse(),
        );
        expect(characterStore.replaceCharacterFields(reversed)).toBe(true);
        const element = character("c");
        expect(Object.keys(plain(element)).at(-1)).toBe("chaId");
        expect(JSON.stringify(plain(element))).not.toBe(JSON.stringify(record("characters", "c")));
        await settle();
        expect(fake.batchCount()).toBe(0);
        expect(sync.heldRecordRevision("characters", "c")).toBe(held);
        agree("characters", "c");
        // A later edit is a patch on that same revision, naming only its field.
        element.name = "after the adoption";
        await settle();
        expect(ops()).toEqual([
            {
                kind: "characters",
                id: "c",
                baseRevision: held,
                patch: { set: { name: "after the adoption" }, remove: [] },
            },
        ]);
        agree("characters", "c");
        noNotice();
    }, 20_000);
    it("adopts a modules key-order change without a write, and applies another tab's patch on the adopted revision without a read", async () => {
        const {
            fake,
            sync,
            collectionStore,
            settings,
            record,
            revision,
            reads,
            patchModules,
            settle,
            agree,
            noNotice,
        } = await boot();
        const held = revision("modules");
        collectionStore.setModules([plain(settings.modules[0]), { name: "m2", id: "m2" }, plain(settings.modules[2])]);
        await tick();
        expect(Object.keys(plain(settings.modules[1]))).toEqual(["name", "id"]);
        await settle();
        expect(fake.batchCount()).toBe(0);
        expect(sync.heldRecordRevision("modules", "main")).toBe(held);
        // The adopted text is the base another tab's patch applies to: no read.
        const patched = patchModules({ changes: [{ id: "m2", set: { name: "Remote" } }] });
        expect(plain(settings.modules[1])).toEqual({ name: "Remote", id: "m2" });
        expect(sync.heldRecordRevision("modules", "main")).toBe(patched);
        await settle();
        expect(reads()).toBe(0);
        expect(fake.batchCount()).toBe(0);
        expect(record("modules")[1]).toEqual({ id: "m2", name: "Remote" });
        agree("modules");
        noNotice();
    }, 20_000);
    it("sends the whole record for a create, a changed top-level __proto__ of a character, a module list without unique ids, and a module whose __proto__ changed", async () => {
        const { fake, characterStore, collectionStore, settings, record, revision, ops, agree, settle, noNotice } =
            await boot();
        // A create has no base to patch against.
        const id = characterStore.addCharacter({ name: "New", chats: [] } as any);
        await settle();
        expect(ops().filter((op) => op.kind === "characters")).toEqual([
            { kind: "characters", id, baseRevision: null, data: expect.objectContaining({ chaId: id, name: "New" }) },
        ]);
        agree("characters", id);
        fake.requests.length = 0;

        // A changed top-level `__proto__` (a patch never names it): whole, and the key survives.
        let base = revision("characters", "c");
        characterStore.replaceCharacterFields(JSON.parse('{"chaId":"c","name":"P","__proto__":{"x":1}}'));
        await settle();
        let [sent] = ops();
        expect(sent).toMatchObject({ kind: "characters", id: "c", baseRevision: base });
        expect(sent).not.toHaveProperty("patch");
        expect(Object.getOwnPropertyDescriptor(sent.data, "__proto__")!.value).toEqual({ x: 1 });
        expect(Object.getOwnPropertyDescriptor(record("characters", "c"), "__proto__")!.value).toEqual({ x: 1 });
        agree("characters", "c");
        fake.requests.length = 0;
        // Unchanged afterwards: the next edit is a patch again.
        base = revision("characters", "c");
        characterStore.updateCharacter("c", { desc: "after proto" });
        await settle();
        expect(ops()).toEqual([
            { kind: "characters", id: "c", baseRevision: base, patch: { set: { desc: "after proto" }, remove: [] } },
        ]);
        expect(Object.getOwnPropertyDescriptor(record("characters", "c"), "__proto__")!.value).toEqual({ x: 1 });
        agree("characters", "c");
        fake.requests.length = 0;

        // A module list with a repeated id has no item parts: whole, now and for the next edit.
        base = revision("modules");
        collectionStore.setModules([module("dup"), module("dup", { n: 1 }), module("other")]);
        await settle();
        [sent] = ops();
        expect(sent).toEqual({
            kind: "modules",
            id: "main",
            baseRevision: base,
            data: [module("dup"), module("dup", { n: 1 }), module("other")],
        });
        agree("modules");
        fake.requests.length = 0;
        base = revision("modules");
        settings.modules[2].name = "Other";
        await settle();
        [sent] = ops();
        expect(sent).toMatchObject({ kind: "modules", id: "main", baseRevision: base, data: expect.any(Array) });
        expect(sent).not.toHaveProperty("patch");
        agree("modules");
        fake.requests.length = 0;

        // Unique ids again (whole: the base has no parts); then a module's own `__proto__` changes:
        // that module goes whole in `items`, the other as a field patch.
        const big = module("big", { additionalAssets: assets(500) });
        collectionStore.setModules([JSON.parse('{"id":"a","__proto__":1}'), module("b"), big]);
        await settle();
        expect(ops()).toEqual([expect.objectContaining({ data: expect.any(Array) })]);
        fake.requests.length = 0;
        base = revision("modules");
        collectionStore.setModules([JSON.parse('{"id":"a","__proto__":2}'), module("b", { n: 1 }), big]);
        await settle();
        [sent] = ops();
        expect(sent).toMatchObject({ kind: "modules", id: "main", baseRevision: base });
        expect(sent.patch.changes).toEqual([{ id: "b", set: { n: 1 }, remove: [] }]);
        expect(sent.patch.items).toHaveLength(1);
        expect(Object.getOwnPropertyDescriptor(sent.patch.items[0], "__proto__")!.value).toBe(2);
        expect(sent.patch).not.toHaveProperty("order");
        expect(Object.getOwnPropertyDescriptor(record("modules")[0], "__proto__")!.value).toBe(2);
        expect(record("modules")[1]).toEqual(module("b", { n: 1 }));
        agree("modules");
        noNotice();
    }, 20_000);
    it("serializes a value with a toJSON hook as the whole record always did (the hook gets its field name or index), by sending the record whole", async () => {
        const { fake, records, character, settings, record, ops, settle, noNotice } = await boot();
        const hook = (expected: string) => ({
            toJSON(key: string) {
                return key === expected ? "expected" : `WRONG (${JSON.stringify(key)})`;
            },
        });
        // A character field whose value answers by its key: installed raw (no mutation module lets a
        // function in), then an ordinary edit marks the record.
        records.applyRawCharacter("c", { ...plain(record("characters", "c")), payload: hook("payload") });
        character("c").name = "hooked";
        await settle();
        let [sent] = ops();
        expect(sent).toMatchObject({ kind: "characters", id: "c", data: { name: "hooked", payload: "expected" } });
        expect(sent).not.toHaveProperty("patch");
        expect(record("characters", "c")).toMatchObject({ name: "hooked", payload: "expected" });
        fake.requests.length = 0;

        // A module field with a hook: the element is serialized inside the list, so the hook gets
        // the field name; the list goes whole.
        records.applyRaw("modules", [module("h", { payload: hook("payload") }), module("m2")]);
        settings.modules[1].name = "edited";
        await settle();
        [sent] = ops();
        expect(sent).toMatchObject({
            kind: "modules",
            id: "main",
            data: [
                { id: "h", payload: "expected" },
                { id: "m2", name: "edited" },
            ],
        });
        expect(sent).not.toHaveProperty("patch");
        expect(record("modules")).toEqual([
            { id: "h", name: "h", payload: "expected" },
            { id: "m2", name: "edited" },
        ]);
        fake.requests.length = 0;

        // A hook on the list itself, and one on a module (the index is its key): whole as well.
        const list: any = [module("i", { name: "old" })];
        list.toJSON = () => [module("i", { name: "from the list hook" })];
        records.applyRaw("modules", list);
        settings.modules[0].name = "edited under the hook";
        await settle();
        [sent] = ops();
        expect(sent).toEqual({
            kind: "modules",
            id: "main",
            baseRevision: expect.any(String),
            data: [module("i", { name: "from the list hook" })],
        });
        expect(record("modules")).toEqual([module("i", { name: "from the list hook" })]);
        fake.requests.length = 0;
        const itemHook = {
            ...module("j"),
            toJSON: (key: string) => module("j", { name: `item under ${JSON.stringify(key)}` }),
        };
        records.applyRaw("modules", [module("m0"), itemHook]);
        settings.modules[0].name = "edited beside the hook";
        await settle();
        [sent] = ops();
        expect(sent.data).toEqual([
            module("m0", { name: "edited beside the hook" }),
            module("j", { name: 'item under "1"' }),
        ]);
        expect(sent).not.toHaveProperty("patch");
        noNotice();
    }, 20_000);
    it("saves integer keys where the record has them (a top-level one first, a nested one where the proxy holds it) and agrees with the server by value, with no echo", async () => {
        const { characterStore, character, record, ops, agree, settle, noNotice } = await boot();
        characterStore.updateCharacter("c", { deep: { a: 1 } });
        await settle();
        agree("characters", "c");
        // Through real `$state` proxies: a top-level integer key goes first in the text (an ordinary
        // object's order), a nested one stays where the proxy added it.
        character("c")["2"] = "two";
        character("c").deep["2"] = 2;
        await settle();
        const [sent] = ops().slice(-1);
        expect(sent.patch).toEqual({ set: { "2": "two", deep: { a: 1, "2": 2 } }, remove: [] });
        // The wire text (the parsed body loses the order): the top-level key first in the set, the
        // nested one after `a` as the proxy holds it.
        expect(bodies.at(-1)).toContain('"patch":{"set":{"2":"two","deep":{"a":1,"2":2}},"remove":[]}');
        expect(record("characters", "c")).toMatchObject({ "2": "two", deep: { a: 1, "2": 2 } });
        expect(Object.keys(plain(character("c")))[0]).toBe("2");
        agree("characters", "c");
        noNotice();
    }, 20_000);
});

describe("lost acknowledgements", () => {
    it("recognizes a lost acknowledgement of a character patch on the retry's 409 by JSON value (the server keeps its key order): no reload, no notice", async () => {
        const { fake, sync, character, record, revision, ops, agree, noNotice } = await boot();
        const element = character("c");
        fake.dropNextBatchResponse = true;
        // The edit moves `desc` to the end of the local record and changes `name`; the server's
        // record keeps `desc` where it was: same value, different text.
        const desc = element.desc;
        delete element.desc;
        element.desc = desc;
        element.name = "lost";
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        expect(ops()).toEqual([expect.objectContaining({ patch: { set: { name: "lost" }, remove: [] } })]);
        expect(record("characters", "c").name).toBe("lost");
        expect(Object.keys(record("characters", "c")).at(-1)).not.toBe("desc");
        // The retry: a stale base (409), read back, recognized as this tab's own write.
        expect(await sync.flushResources()).toEqual({ discarded: [] });
        expect(fake.batchCount()).toBe(2);
        expect(sync.heldRecordRevision("characters", "c")).toBe(revision("characters", "c"));
        expect(element.name).toBe("lost");
        agree("characters", "c");
        noNotice();
        // Nothing more goes out: the held text is this tab's, equal to the mirror.
        await sync.flushResources();
        await vi.advanceTimersByTimeAsync(2000);
        expect(fake.batchCount()).toBe(2);
    }, 20_000);
    it("keeps a local edit made while the answer was lost: the retry merges it without a discard and saves it", async () => {
        const { fake, sync, character, record, revision, agree, noNotice } = await boot();
        const element = character("c");
        fake.dropNextBatchResponse = true;
        element.name = "lost";
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        element.personality = "typed while the answer was lost";
        expect(await sync.flushResources()).toEqual({ discarded: [] });
        expect(record("characters", "c")).toMatchObject({
            name: "lost",
            personality: "typed while the answer was lost",
        });
        expect(element).toMatchObject({ name: "lost", personality: "typed while the answer was lost" });
        expect(sync.heldRecordRevision("characters", "c")).toBe(revision("characters", "c"));
        agree("characters", "c");
        noNotice();
    }, 20_000);
    it("recognizes a lost acknowledgement of a modules item patch on the retry, with a module's keys in another order", async () => {
        const { fake, sync, collectionStore, settings, record, revision, ops, agree, noNotice } = await boot();
        fake.dropNextBatchResponse = true;
        // The module replaced with `extra` first: locally `{ extra, id, name }`, on the server (the
        // base item with `extra` assigned) `{ id, name, extra }`.
        collectionStore.setModules([
            plain(settings.modules[0]),
            { extra: 1, id: "m2", name: "m2" },
            plain(settings.modules[2]),
        ]);
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        expect(ops()).toEqual([
            expect.objectContaining({ patch: { items: [], changes: [{ id: "m2", set: { extra: 1 }, remove: [] }] } }),
        ]);
        expect(Object.keys(record("modules")[1])).toEqual(["id", "name", "extra"]);
        expect(Object.keys(plain(settings.modules[1]))).toEqual(["extra", "id", "name"]);
        expect(await sync.flushResources()).toEqual({ discarded: [] });
        expect(fake.batchCount()).toBe(2);
        expect(sync.heldRecordRevision("modules", "main")).toBe(revision("modules"));
        agree("modules");
        noNotice();
        await sync.flushResources();
        await vi.advanceTimersByTimeAsync(2000);
        expect(fake.batchCount()).toBe(2);
    }, 20_000);
});

describe("modules item patches another tab committed", () => {
    it("applies the patch at once: no read, no write, the listeners told; a retained module wrapper keeps writing into the applied record on its revision", async () => {
        const { fake, sync, settings, changed, record, reads, patchModules, settle, agree, noNotice, ops } =
            await boot();
        const retained = settings.modules[0];
        const patched = patchModules({
            items: [module("m4")],
            changes: [{ id: "m2", set: { name: "Two", description: "d" }, remove: [] }],
            order: ["m4", "m1", "m2"],
        });
        // Applied inside the feed's delivery, before any cycle.
        expect(settings.modules.map((entry: any) => entry.id)).toEqual(["m4", "m1", "m2"]);
        expect(plain(settings.modules[2])).toEqual({ id: "m2", name: "Two", description: "d" });
        expect((settings.modules[1] as any).additionalAssets).toHaveLength(5_000);
        expect(sync.heldRecordRevision("modules", "main")).toBe(patched);
        expect(changed).toEqual(["modules/main"]);
        expect(reads()).toBe(0);
        await settle();
        expect(reads()).toBe(0);
        expect(fake.batchCount()).toBe(0);
        agree("modules");
        // The wrapper held on the first module follows its position (modules have no by-id
        // identity): it now writes into `m4`, which the next cycle saves as a patch on the new revision.
        retained.name = "written through the retained wrapper";
        await settle();
        expect(ops()).toEqual([
            {
                kind: "modules",
                id: "main",
                baseRevision: patched,
                patch: {
                    items: [],
                    changes: [{ id: "m4", set: { name: "written through the retained wrapper" }, remove: [] }],
                },
            },
        ]);
        expect(record("modules")[0]).toEqual({ id: "m4", name: "written through the retained wrapper" });
        agree("modules");
        noNotice();
    }, 20_000);
    it("reads the record whole for a patch it cannot take: a base it does not hold, a malformed patch, an unknown or omitted item, a field form on modules, an item form on a character, a patch over 64 KiB", async () => {
        const { fake, sync, live, settings, character, record, revision, reads, patchModules, settle, noNotice } =
            await boot();
        const craft = (kind: string, revision: string, patch: unknown) =>
            sync.noteRemoteChanges({
                resources: [{ kind, id: kind === "characters" ? "c" : "main", revision, patch: patch as never }],
                chats: [],
                chatOrders: [],
            });
        let expectedReads = 0;
        /** Delivers a frame, then checks that the record was read whole and the mirror holds the server's copy. */
        const readWhole = async (kind: string, patch: unknown) => {
            craft(kind, revision(kind, kind === "characters" ? "c" : "main"), patch);
            expectedReads += 1;
            await settle();
            expect(reads()).toBe(expectedReads);
            expect(sync.heldRecordRevision(kind, kind === "characters" ? "c" : "main")).toBe(
                revision(kind, kind === "characters" ? "c" : "main"),
            );
            expect(fake.batchCount()).toBe(0);
        };
        live.paused = true;
        // A missed frame: the second of two patches names a base this tab never held.
        patchModules({ changes: [{ id: "m2", set: { name: "first" } }] });
        patchModules({ changes: [{ id: "m2", set: { name: "second" } }] });
        const [, second] = live.queue.splice(0) as Extract<ServerFeedEvent, { type: "change" }>[];
        sync.noteRemoteChanges(second.changes);
        expect(plain(settings.modules[1]).name).toBe("m2");
        expectedReads += 1;
        await settle();
        expect(reads()).toBe(expectedReads);
        expect(plain(settings.modules[1]).name).toBe("second");
        expect(sync.heldRecordRevision("modules", "main")).toBe(revision("modules"));

        // One real write each, announced with a patch this tab must not apply.
        const bad: ((base: string) => unknown)[] = [
            (base) => ({ baseRevision: base, items: [], changes: [{ id: "zz", set: { name: "x" }, remove: [] }] }),
            (base) => ({ baseRevision: base, items: [module("new")], changes: [] }),
            (base) => ({ baseRevision: base, items: [module("new")], changes: [], order: ["m1", "m2", "m3"] }),
            (base) => ({ baseRevision: base, items: [], changes: [], order: ["m1", "m2", "m3", "gone"] }),
            (base) => ({ baseRevision: base, items: [], changes: [{ id: "m2", set: { id: "x" }, remove: [] }] }),
            (base) => ({
                baseRevision: base,
                items: [],
                changes: [{ id: "m2", set: JSON.parse('{"__proto__":1}'), remove: [] }],
            }),
            (base) => ({ baseRevision: base, items: [], changes: [] }),
            (base) => ({ baseRevision: base, items: "m2", changes: [] }),
            (base) => ({ baseRevision: base, set: { name: "field form" }, remove: [] }),
            (base) => ({ baseRevision: base, items: [], changes: [], order: [], set: { x: 1 } }),
            (base) => ({ baseRevision: 7, items: [], changes: [], order: [] }),
        ];
        for (const [index, make] of bad.entries()) {
            const base = revision("modules");
            fake.set("modules", "main", [...record("modules").slice(0, 2), module("m3", { n: index })]);
            live.queue.length = 0;
            await readWhole("modules", make(base));
            expect(plain(settings.modules[2])).toEqual(module("m3", { n: index }));
        }
        // An item form on a character.
        const base = revision("characters", "c");
        fake.set("characters", "c", { ...record("characters", "c"), name: "item form" });
        live.queue.length = 0;
        await readWhole("characters", { baseRevision: base, items: [], changes: [], order: [] });
        expect(character("c").name).toBe("item form");

        // A patch over 64 KiB is a plain ref (the store's cap): read whole.
        live.paused = false;
        patchModules({ changes: [{ id: "m3", set: { blob: "x".repeat(70_000) } }] });
        expectedReads += 1;
        await settle();
        expect(reads()).toBe(expectedReads);
        expect(plain(settings.modules[2]).blob).toHaveLength(70_000);
        expect(sync.heldRecordRevision("modules", "main")).toBe(revision("modules"));
        expect(fake.batchCount()).toBe(0);
        noNotice();
    }, 20_000);
    it("leaves a patch alone while this tab has an unsent module change; the save then conflicts and reloads with the notice (modules have no merge)", async () => {
        const { fake, sync, settings, changed, record, reads, patchModules, agree } = await boot();
        settings.modules[2].name = "mine";
        await tick();
        const patched = patchModules({ changes: [{ id: "m2", set: { name: "theirs" } }] });
        expect(plain(settings.modules[1]).name).toBe("m2");
        expect(changed).toEqual([]);
        expect(await sync.flushResources()).toEqual({ discarded: ["modules/main"] });
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        expect(settings.modules.map((entry: any) => entry.name)).toEqual(["m1", "theirs", "m3"]);
        expect(record("modules").map((entry: any) => entry.name)).toEqual(["m1", "theirs", "m3"]);
        expect(sync.heldRecordRevision("modules", "main")).toBe(patched);
        expect(fake.batchCount()).toBe(1);
        agree("modules");
        await vi.advanceTimersByTimeAsync(5000);
        expect(fake.batchCount()).toBe(1);
        // The waiting patch (held base, the conflict's revision) rebuilt the server's record: no read.
        expect(reads()).toBe(0);
    }, 20_000);
    it("drops the echo of this tab's own modules patch before its acknowledgement, and holds another tab's patch that lands during the save until after it, without a read", async () => {
        const { fake, sync, settings, intercept, patchModules, reads, settle, agree, revision, noNotice } =
            await boot();
        // The echo (the feed delivers right after the commit, before the answer) is dropped.
        intercept.hold = (path) => path === "/api/resources/batch";
        settings.modules[2].name = "own";
        await tick();
        const flushing = sync.flushResources();
        await vi.advanceTimersByTimeAsync(600);
        expect(intercept.release).not.toBeNull();
        expect(fake.feedEvents).toHaveLength(1);
        intercept.release!();
        await flushing;
        await settle();
        expect(reads()).toBe(0);
        expect(fake.batchCount()).toBe(1);
        agree("modules");
        fake.requests.length = 0;

        // Another tab's patch right after this tab's save, before its answer: the frame names a
        // base this tab is about to hold, so it waits and applies after the acknowledgement.
        let patched = "";
        intercept.afterApply = (path) => {
            expect(path).toBe("/api/resources/batch");
            patched = patchModules({ changes: [{ id: "m2", set: { name: "theirs, during the save" } }] });
        };
        settings.modules[2].name = "own again";
        await settle();
        expect(plain(settings.modules[1]).name).toBe("theirs, during the save");
        expect(plain(settings.modules[2]).name).toBe("own again");
        expect(sync.heldRecordRevision("modules", "main")).toBe(patched);
        expect(revision("modules")).toBe(patched);
        expect(reads()).toBe(0);
        expect(fake.batchCount()).toBe(1);
        agree("modules");
        noNotice();
    }, 20_000);
});

// General record patches (audit slice 3g). Expectations describe the wire contract, not a diff helper.
const idKinds = ["presets", "modelPresets", "modelProfiles", "personas", "credentials", "plugins"] as const;
describe("patches of the other mirrored records", () => {
    it.each(idKinds)("saves and receives %s item patches, including membership and selection changes", async (kind) => {
        const h = await boot((fake) =>
            fake.set(
                kind,
                "main",
                [
                    { id: "a", name: "A" },
                    { id: "b", name: "B" },
                    { id: "c", name: "C" },
                ].map((entry) =>
                    kind === "credentials"
                        ? { ...entry, type: "openai" }
                        : kind === "plugins"
                          ? { ...entry, keep: "x".repeat(1000) }
                          : entry,
                ),
            ),
        );
        const { fake, records, sync, ops, reads, revision, selection, settle } = h;
        const base = revision(kind);
        const list = records.trackedRecord(kind) as any;
        list[1].name = "Renamed";
        await sync.flushResources();
        expect(ops()).toEqual([
            {
                kind,
                id: "main",
                baseRevision: base,
                patch: { items: [], changes: [{ id: "b", set: { name: "Renamed" }, remove: [] }] },
            },
        ]);
        expect(new TextEncoder().encode(JSON.stringify(ops()[0].patch)).length).toBeLessThan(
            new TextEncoder().encode(JSON.stringify(h.record(kind))).length,
        );
        expect(h.record(kind)[1].name).toBe("Renamed");
        const select =
            kind === "presets"
                ? selection.selectPreset
                : kind === "personas"
                  ? selection.selectPersona
                  : kind === "modelPresets"
                    ? selection.selectModelPreset
                    : null;
        select?.("a");
        const saved = revision(kind);
        fake.store.applyChanges({
            ops: [
                {
                    kind: fake.kind(kind),
                    id: "main",
                    baseRevision: saved,
                    patch: { changes: [{ id: "b", set: { name: "Remote" } }], order: ["c", "b"] },
                },
            ],
        });
        expect(plain(records.recordData(kind)).map((entry: any) => [entry.id, entry.name])).toEqual([
            ["c", "C"],
            ["b", "Remote"],
        ]);
        if (select) {
            const key = kind === "presets" ? "presetId" : kind === "personas" ? "personaId" : "modelPresetId";
            expect(selection.selection[key]).toBe("c");
        }
        expect(sync.heldRecordRevision(kind, "main")).toBe(revision(kind));
        await settle();
        expect(reads()).toBe(0);
        expect(fake.batchCount()).toBe(1);
    });

    it.each([
        { kind: "ui", data: { zoomsize: 100 }, field: "zoomsize", value: 125, remote: 140 },
        {
            kind: "pluginStorage",
            data: { keep: "가".repeat(1000), value: 1, obsolete: true },
            field: "value",
            value: 2,
            remote: 3,
        },
        { kind: "statics", data: { messages: 1, imports: 1234567890123456 }, field: "messages", value: 2, remote: 3 },
        {
            kind: "translatorPresets",
            data: {
                items: [
                    { id: "a", name: "A" },
                    { id: "b", name: "B" },
                ],
                selectedId: "a",
            },
            field: "selectedId",
            value: "b",
            remote: "a",
        },
        {
            kind: "hypaV3Presets",
            data: {
                items: [
                    { id: "a", name: "A" },
                    { id: "b", name: "B" },
                ],
                selectedId: "a",
            },
            field: "selectedId",
            value: "b",
            remote: "a",
        },
    ])(
        "saves and receives $kind field patches without echoing the remote record",
        async ({ kind, data, field, value, remote }) => {
            const h = await boot((fake) => fake.set(kind, "main", data));
            const { records, sync, fake, revision, ops, reads, settle } = h;
            const base = revision(kind);
            const record = records.trackedRecord(kind as any) as any;
            record[field] = value;
            const remove = kind === "pluginStorage" ? ["obsolete"] : [];
            if (remove.length) delete record.obsolete;
            await sync.flushResources();
            expect(ops()).toEqual([
                { kind, id: "main", baseRevision: base, patch: { set: { [field]: value }, remove } },
            ]);
            expect(h.record(kind)[field]).toBe(value);
            expect(h.record(kind)).not.toHaveProperty("obsolete");
            fake.store.applyChanges({
                ops: [
                    {
                        kind: fake.kind(kind),
                        id: "main",
                        baseRevision: revision(kind),
                        patch: { set: { [field]: remote } },
                    },
                ],
            });
            expect(plain(records.recordData(kind as any))[field]).toBe(remote);
            expect(sync.heldRecordRevision(kind, "main")).toBe(revision(kind));
            await settle();
            expect(reads()).toBe(0);
            expect(fake.batchCount()).toBe(1);
        },
    );

    it("keeps whole writes for lists without unique nonempty ids, llmSecrets, and patches no smaller in UTF-8", async () => {
        const h = await boot((fake) => {
            fake.set("plugins", "main", [{ name: "one" }, { name: "two" }]);
            fake.set("loreBook", "main", [{ name: "one", data: [] }]);
            fake.set("globalscript", "main", [{ in: "a", out: "b", type: "editinput" }]);
            fake.set("pluginStorage", "main", { x: "a" });
        });
        const { records, sync, ops, fake } = h;
        for (const [kind, field] of [
            ["plugins", "name"],
            ["loreBook", "name"],
            ["globalscript", "out"],
        ] as const) {
            (records.trackedRecord(kind) as any)[0][field] = "changed";
        }
        (records.trackedRecord("llmSecrets") as any).vertexClientEmail = "readable@example.test";
        (records.trackedRecord("pluginStorage") as any).x = "가".repeat(30);
        await sync.flushResources();
        expect(
            ops()
                .map((op) => op.kind)
                .sort(),
        ).toEqual(["globalscript", "llmSecrets", "loreBook", "pluginStorage", "plugins"]);
        for (const op of ops()) {
            expect(op).not.toHaveProperty("patch");
            expect(op).toHaveProperty("data");
        }
        // UTF-16 length would choose the whole record here; UTF-8 correctly favors the patch.
        fake.set("pluginStorage", "main", { keep: "가".repeat(5), value: "a" });
        await h.settle();
        fake.requests.length = 0;
        (records.trackedRecord("pluginStorage") as any).value = "b";
        await sync.flushResources();
        const patch = { set: { value: "b" }, remove: [] };
        const whole = h.record("pluginStorage");
        expect(JSON.stringify(patch).length).toBeGreaterThan(JSON.stringify(whole).length);
        expect(new TextEncoder().encode(JSON.stringify(patch)).length).toBeLessThan(
            new TextEncoder().encode(JSON.stringify(whole)).length,
        );
        expect(ops()[0].patch).toEqual(patch);
        // Duplicate and empty ids also reject parts, even though these records are arrays of objects.
        for (const ids of [
            ["same", "same"],
            ["", "b"],
        ]) {
            fake.set(
                "plugins",
                "main",
                ids.map((id) => ({ id, name: "base", keep: "x".repeat(1000) })),
            );
            await h.settle();
            fake.requests.length = 0;
            const replacement = plain(records.recordData("plugins"));
            replacement[0].name = "edited";
            records.replaceRecord("plugins", replacement);
            await sync.flushResources();
            expect(ops()).toHaveLength(1);
            expect(ops()[0]).not.toHaveProperty("patch");
            expect(h.record("plugins")[0].name).toBe("edited");
        }
    });

    it("reads the whole record when an object or item feed patch is malformed or does not fit its held base", async () => {
        const h = await boot((fake) => fake.set("pluginStorage", "main", { value: "base" }));
        h.live.paused = true;
        const cases = [
            ["pluginStorage", (base: string) => ({ baseRevision: base, items: [], changes: [], order: [] })],
            ["presets", (base: string) => ({ baseRevision: base, set: { name: "wrong shape" }, remove: [] })],
            [
                "pluginStorage",
                (base: string) => ({ baseRevision: base, set: JSON.parse('{"__proto__":1}'), remove: [] }),
            ],
            [
                "presets",
                (base: string) => ({
                    baseRevision: base,
                    items: [],
                    changes: [{ id: "missing", set: { name: "x" }, remove: [] }],
                }),
            ],
            ["pluginStorage", (base: string) => ({ baseRevision: base, set: null, remove: [] })],
            [
                "pluginStorage",
                (base: string) => ({
                    baseRevision: base.replace(/:[0-9]+$/, ":0"),
                    set: { value: "wrong base" },
                    remove: [],
                }),
            ],
            [
                "pluginStorage",
                (base: string) => ({ baseRevision: "other-epoch:1:1", set: { value: "wrong epoch" }, remove: [] }),
            ],
        ] as const;
        for (const [i, [kind, make]] of cases.entries()) {
            const base = h.revision(kind);
            const data =
                kind === "presets" ? [{ ...h.record(kind)[0], name: `remote ${i}` }] : { value: `remote ${i}` };
            h.fake.set(kind, "main", data);
            h.sync.noteRemoteChanges({
                resources: [{ kind, id: "main", revision: h.revision(kind), patch: make(base) as any }],
                chats: [],
                chatOrders: [],
            });
            await h.settle();
            expect(plain(h.records.recordData(kind))).toEqual(h.record(kind));
            expect(h.reads()).toBe(i + 1);
        }
        // A held base still cannot cover two writes: the notice must be exactly base + 1.
        const base = h.revision("pluginStorage");
        h.fake.set("pluginStorage", "main", { value: "intermediate" });
        h.fake.set("pluginStorage", "main", { value: "latest" });
        h.sync.noteRemoteChanges({
            resources: [
                {
                    kind: "pluginStorage",
                    id: "main",
                    revision: h.revision("pluginStorage"),
                    patch: { baseRevision: base, set: { value: "incomplete" }, remove: [] },
                },
            ],
            chats: [],
            chatOrders: [],
        });
        await h.settle();
        expect(plain(h.records.recordData("pluginStorage"))).toEqual({ value: "latest" });
        expect(h.reads()).toBe(cases.length + 1);
        expect(h.fake.batchCount()).toBe(0);
    });

    it.each(["feed", "hydration"] as const)(
        "rebuilds a dirty tab's 409 from matching %s data, retaining merge, discard and lost-response behavior",
        async (delivery) => {
            const h = await boot((fake) => fake.set("statics", "main", { messages: 4, imports: 0 }));
            h.live.paused = true;
            const publish = (kind: string, id: string, patch: unknown) => {
                h.fake.store.applyChanges({
                    ops: [{ kind: h.fake.kind(kind), id, baseRevision: h.revision(kind, id), patch }],
                });
                if (delivery === "feed") h.flushFeed();
                else {
                    h.live.queue.length = 0;
                    const row = h.fake.record(kind, id)!;
                    expect(h.sync.applyHydration({ kind, id, ...row })).toBe(false);
                }
            };
            // An unrelated character stamp merges, and statistics add both tabs' deltas.
            h.character().desc = "local";
            (h.records.trackedRecord("statics") as any).messages = 6;
            publish("characters", "c", { set: { lastInteraction: 123 } });
            publish("statics", "main", { set: { messages: 7 } });
            expect(h.character().lastInteraction).not.toBe(123);
            expect(await h.sync.flushResources()).toEqual({ discarded: [] });
            expect(h.record("characters", "c")).toMatchObject({ desc: "local", lastInteraction: 123 });
            expect(h.record("statics")).toEqual({ messages: 9, imports: 0 });
            expect(h.reads()).toBe(0);
            expect(alerts.normal).not.toHaveBeenCalled();
            // A non-mergeable collection is discarded with the ordinary reload notice.
            h.settings.modules[1].name = "mine";
            publish("modules", "main", { changes: [{ id: "m2", set: { name: "theirs" } }] });
            expect(h.settings.modules[1].name).toBe("mine");
            expect(await h.sync.flushResources()).toEqual({ discarded: ["modules/main"] });
            expect(h.settings.modules[1].name).toBe("theirs");
            expect(alerts.normal).toHaveBeenCalledWith("reloaded");
            expect(h.reads()).toBe(0);
            alerts.normal.mockClear();
            // A lost acknowledgement is recognized from an exact copy of what this tab sent.
            h.settings.modules[1].name = "ack lost";
            h.fake.dropNextBatchResponse = true;
            await expect(h.sync.flushResources()).rejects.toThrow("Failed to fetch");
            if (delivery === "feed") h.flushFeed();
            else {
                const row = h.fake.record("modules", "main")!;
                h.sync.applyHydration({ kind: "modules", id: "main", ...row });
            }
            expect(await h.sync.flushResources()).toEqual({ discarded: [] });
            expect(h.record("modules")[1].name).toBe("ack lost");
            expect(h.reads()).toBe(0);
            expect(alerts.normal).not.toHaveBeenCalled();
        },
    );

    it.each(["missing", "older feed", "wrong base", "older hydration"])(
        "reads a conflicting record when the available copy is %s",
        async (mode) => {
            const h = await boot();
            h.live.paused = true;
            h.settings.modules[1].name = "local";
            const base = h.revision("modules");
            h.patchModules({ changes: [{ id: "m2", set: { name: "first remote" } }] });
            if (mode === "older feed") h.flushFeed();
            if (mode === "older hydration")
                h.sync.applyHydration({ kind: "modules", id: "main", ...h.fake.record("modules", "main")! });
            if (mode === "wrong base") {
                h.sync.noteRemoteChanges({
                    resources: [
                        {
                            kind: "modules",
                            id: "main",
                            revision: h.revision("modules"),
                            patch: {
                                baseRevision: base.replace(/:[0-9]+$/, ":0"),
                                items: [],
                                changes: [{ id: "m2", set: { name: "bad" }, remove: [] }],
                            },
                        },
                    ],
                    chats: [],
                    chatOrders: [],
                });
            } else h.patchModules({ changes: [{ id: "m2", set: { name: "latest remote" } }] });
            expect(await h.sync.flushResources()).toEqual({ discarded: ["modules/main"] });
            expect(h.reads()).toBe(1);
            expect(h.settings.modules[1].name).toBe(mode === "wrong base" ? "first remote" : "latest remote");
            expect(h.sync.heldRecordRevision("modules", "main")).toBe(h.revision("modules"));
            expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        },
    );
});
