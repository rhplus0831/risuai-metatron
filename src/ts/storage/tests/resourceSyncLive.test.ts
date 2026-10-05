import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { secretPathKey } from "../../../../shared/llmSecrets.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { type ServerFeedEvent, StoreBackedServer } from "./storeBackedServer";

// Phase 6 slice 2 (live updates) over the real server store and its real change feed: every commit
// "another tab" (or a server job) makes is published by the store and handed to the client's
// `noteRemoteChanges` the way `network/eventFeed.ts` hands it a `change` frame of the loaded epoch
// (synchronously by default, right after the commit, so an echo of this tab's own save arrives
// before its acknowledgement; paused where a test needs a delay). The save adapter, the chat module,
// and the selection module run for real; the socket is in `network/eventFeed.test.ts`. Every case
// checks that a remote change becomes neither an outgoing write nor a discard: a local edit is lost
// only through a 409 with its notice.

const { server, alerts, dispatch } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: {
        error: vi.fn(),
        normal: vi.fn(),
        normalWait: vi.fn(async () => undefined),
        terminal: vi.fn(async () => undefined),
    },
    /** When set, a request waits here after authentication and before `beforeDispatch`. */
    dispatch: { gate: null as Promise<void> | null },
}));

vi.mock("../nodeStorage", () => ({
    // `authFetch`'s contract: `beforeDispatch` runs after authentication and signing, right before the request.
    authFetch: async (path: string, init?: RequestInit, options: { beforeDispatch?: () => void } = {}) => {
        if (dispatch.gate) {
            await dispatch.gate;
        }
        options.beforeDispatch?.();
        return server.current.fetch(path, init);
    },
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
    alertTerminal: alerts.terminal,
}));
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored", chatGenerating: "generating" },
}));
vi.mock("../../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

type Sync = typeof import("../resourceSync.svelte");
type Client = typeof import("../resourceClient");
type Stores = typeof import("../../stores.svelte");
type ChatModule = typeof import("../chatStore.svelte");
type Bootstrap = typeof import("../../bootstrap");
type DatabaseModule = typeof import("../database.svelte");
type Selection = typeof import("../selection.svelte");
type Secrets = typeof import("../llmSecrets.svelte");

const KINDS = Object.values(RESOURCE_KIND);
const m = (id: string, data: string, role: "user" | "char" = "user") => ({ role, data, chatId: id }) as any;
const chat = (id: string, messages: any[] = []) =>
    ({ id, name: id, note: "", localLore: [], message: messages }) as any;
const create = (characterId: string, id: string, messages: any[] = []) => ({
    characterId,
    chatId: id,
    baseRevision: null,
    ops: [{ op: "create", chat: chat(id, messages) }],
});
const refK = { chaId: "c", chatId: "k" };
const STORED_KEY = "sk-first-credential-1234";

/**
 * Boots the adapter and the chat module the way `loadData` does, against a store-backed server
 * with the change feed: presets `pa` and `pb`, character `c` (chats `k` with messages a, b, c and
 * `j`, empty) and character `d` (chat `m`), `c` selected. Then live delivery starts.
 */
async function boot(options: { secret?: boolean } = {}) {
    vi.resetModules();
    const fake = await StoreBackedServer.create({ lock: true, feed: true });
    fake.set("presets", "main", [
        { id: "pa", name: "p1" },
        { id: "pb", name: "p2" },
    ]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    if (options.secret) {
        fake.set("llmSecrets", "main", { ...fake.record("llmSecrets", "main")!.data, openAIKey: STORED_KEY });
    }
    fake.store.applyChanges({
        ops: [
            { kind: fake.kind("characters"), id: "c", baseRevision: null, data: { chaId: "c", name: "C" } },
            { kind: fake.kind("characters"), id: "d", baseRevision: null, data: { chaId: "d", name: "D" } },
        ],
        chats: [
            create("c", "k", [m("a", "A", "char"), m("b", "B", "char"), m("c", "C")]),
            create("c", "j"),
            create("d", "m", [m("x", "X")]),
        ],
    });
    server.current = fake;

    const stores: Stores = await import("../../stores.svelte");
    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");
    const chatModule: ChatModule = await import("../chatStore.svelte");
    const bootstrap: Bootstrap = await import("../../bootstrap");
    const database: DatabaseModule = await import("../database.svelte");
    const selection: Selection = await import("../selection.svelte");
    const secrets: Secrets = await import("../llmSecrets.svelte");

    const snapshot = await client.readKinds(KINDS, { chats: true });
    sync.seedResources(snapshot);
    chatModule.seedChats(snapshot.chats ?? [], snapshot.chatOrders ?? []);
    database.setDatabaseLite(bootstrap.assembleDatabase(snapshot));
    stores.selectedCharID.set(0);
    chatModule.initializeChats();
    const adding = vi.spyOn(window, "addEventListener").mockImplementation(() => {});
    const addingDocument = vi.spyOn(document, "addEventListener").mockImplementation(() => {});
    sync.startResourceSync();
    adding.mockRestore();
    addingDocument.mockRestore();
    await tick();
    await sync.flushResources();
    expect(fake.batchCount()).toBe(0);
    fake.requests.length = 0;
    fake.feedEvents.length = 0;

    // The live-update socket's stand-in: each `change` of the loaded epoch goes to `noteRemoteChanges`.
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

    // Holds the next request matching `hold` after the server answered it (the answer is a snapshot
    // of that moment); `afterApply` runs right after a request was applied, before its answer returns.
    const intercept = {
        hold: null as null | ((path: string) => boolean),
        release: null as null | (() => void),
        afterApply: null as null | ((path: string) => void),
        beforeRequest: null as null | ((path: string) => void),
    };
    const real = fake.fetch;
    server.current = Object.assign(Object.create(fake), {
        fetch: async (path: string, init?: RequestInit) => {
            intercept.beforeRequest?.(path);
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

    const db = () => stores.DBState.db as any;
    const character = (id = "c") => db().characters.find((entry: any) => entry.chaId === id);
    const chatIds = (id = "c") => character(id).chats.map((entry: any) => entry.id);
    // The chat module's own read (Phase 6 slice 9a): the facade's `chats` builds a fresh list on
    // every read, which a check over a thousand chats would rebuild once per chat.
    const texts = (chaId: string, chatId: string) =>
        chatModule.findChat({ chaId, chatId })!.message.map((message: any) => message.data);
    return {
        fake,
        sync,
        client,
        stores,
        chat: chatModule,
        selection,
        secrets,
        live,
        flushFeed,
        intercept,
        db,
        character,
        chatIds,
        texts,
    };
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    dispatch.gate = null;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
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

const reads = (fake: StoreBackedServer) => fake.requests.filter((r) => r.path === "/api/resources/read").length;
const characterKind = (fake: StoreBackedServer) => fake.kind("characters");
/** Another tab edits the `ui` section. */
const editUi = (fake: StoreBackedServer, patch: Record<string, unknown>) =>
    fake.set("ui", "main", { ...fake.record("ui", "main")!.data, ...patch });
/** Advances past the cycle's delay and lets it finish; then asserts that nothing else follows. */
async function settle(fake: StoreBackedServer) {
    await vi.advanceTimersByTimeAsync(1500);
    const before = { reads: reads(fake), batches: fake.batchCount(), all: fake.requests.length };
    await vi.advanceTimersByTimeAsync(5000);
    expect({ reads: reads(fake), batches: fake.batchCount(), all: fake.requests.length }).toEqual(before);
}
const noNotice = () => {
    expect(alerts.normal).not.toHaveBeenCalled();
    expect(alerts.error).not.toHaveBeenCalled();
};

describe("records another writer committed", () => {
    it("applies an idle record's change without a write, a notice, or a discard entry", async () => {
        const { fake, sync, db } = await boot();
        editUi(fake, { zoomsize: 150 });
        await settle(fake);
        expect(db().zoomsize).toBe(150);
        expect(sync.heldRecordRevision("ui", "main")).toBe(fake.record("ui", "main")!.revision);
        expect(reads(fake)).toBe(1);
        expect(fake.batchCount()).toBe(0);
        noNotice();
        expect(await sync.flushResources()).toEqual({ discarded: [] });
    });

    it("applies another writer's character update raw, without a write; the element and a retained nested wrapper then write into the applied copy on its revision (Phase 6 slice 5a)", async () => {
        const { fake, sync, stores, character } = await boot();
        // `d` is not selected (`c` is): its record's own writes are saved all the same.
        expect(stores.DBState.db.characters[0].chaId).toBe("c");
        character("d").globalLore = [{ key: "k", content: "mine" }];
        await tick();
        await sync.flushResources();
        expect(fake.record("characters", "d")!.data.globalLore).toEqual([{ key: "k", content: "mine" }]);
        await settle(fake);
        const element = character("d");
        const entry = element.globalLore[0];
        const chats = element.chats;
        const batches = fake.batchCount();
        fake.set("characters", "d", {
            ...fake.record("characters", "d")!.data,
            name: "D remote",
            globalLore: [{ key: "k", content: "remote" }],
        });
        await settle(fake);
        expect(element.name).toBe("D remote");
        expect(entry.content).toBe("remote");
        // Phase 6 slice 9a: `chats` is a fresh array on every read; the chats are the same ones.
        expect(element.chats).toEqual(chats);
        element.chats.forEach((entry: unknown, index: number) => expect(entry).toBe(chats[index]));
        expect(fake.batchCount()).toBe(batches);
        noNotice();
        const held = fake.record("characters", "d")!.revision;
        expect(sync.heldRecordRevision("characters", "d")).toBe(held);
        entry.content = "edited after the update";
        await tick();
        await sync.flushResources();
        const last = fake.batchBodies().at(-1) as any;
        expect(last.ops).toEqual([expect.objectContaining({ kind: "characters", id: "d", baseRevision: held })]);
        expect(fake.record("characters", "d")!.data).toMatchObject({
            name: "D remote",
            globalLore: [{ key: "k", content: "edited after the update" }],
        });
        noNotice();
    });

    it("drops the echo of this tab's own save that arrives before its acknowledgement, and keeps the acknowledged revision", async () => {
        const { fake, sync, db } = await boot();
        db().zoomsize = 120;
        await tick();
        await sync.flushResources();
        // The feed delivered the commit inside the batch request, before its answer.
        expect(fake.feedEvents).toHaveLength(1);
        expect(sync.heldRecordRevision("ui", "main")).toBe(fake.record("ui", "main")!.revision);
        await settle(fake);
        expect(reads(fake)).toBe(0);
        expect(fake.batchCount()).toBe(1);
        expect(db().zoomsize).toBe(120);
        noNotice();
    });

    it("does not apply a copy read while this tab edited the record; its save then conflicts through the 409 path with the notice", async () => {
        const { fake, sync, db, intercept } = await boot();
        const iconsize = db().iconsize;
        intercept.hold = (path) => path === "/api/resources/read";
        editUi(fake, { zoomsize: 200 });
        await vi.advanceTimersByTimeAsync(100);
        expect(intercept.release).not.toBeNull();
        // The local edit lands while the read is out.
        db().iconsize = 77;
        intercept.release!();
        await vi.advanceTimersByTimeAsync(0);
        // The fetched copy was not applied over the edit: the edit was still in the mirror when the batch left.
        const batch = fake.batchBodies()[0];
        expect(batch?.ops?.[0]?.data?.iconsize).toBe(77);
        await vi.advanceTimersByTimeAsync(3000);
        // Two tabs edited one whole-record section: the later saver's edit goes, with the notice.
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        expect(db().zoomsize).toBe(200);
        expect(db().iconsize).toBe(iconsize);
        expect(fake.record("ui", "main")!.data.iconsize).toBe(iconsize);
    });

    it("leaves a record alone while its save is in flight and applies a later commit after the acknowledgement", async () => {
        const { fake, db, intercept } = await boot();
        intercept.afterApply = (path) => {
            expect(path).toBe("/api/resources/batch");
            // Another tab commits right after this tab's save, before its answer arrives.
            editUi(fake, { iconsize: 55 });
        };
        db().zoomsize = 111;
        await settle(fake);
        expect(db().zoomsize).toBe(111);
        expect(db().iconsize).toBe(55);
        expect(fake.record("ui", "main")!.data).toMatchObject({ zoomsize: 111, iconsize: 55 });
        expect(fake.batchCount()).toBe(1);
        expect(reads(fake)).toBe(1);
        noNotice();
    });

    it("does not apply a read answer older than a job's hydration that landed meanwhile", async () => {
        const { fake, sync, db, intercept } = await boot();
        intercept.hold = (path) => path === "/api/resources/read";
        editUi(fake, { zoomsize: 201 });
        await vi.advanceTimersByTimeAsync(100);
        expect(intercept.release).not.toBeNull();
        editUi(fake, { zoomsize: 202 });
        const newest = fake.record("ui", "main")!;
        expect(sync.applyHydration({ kind: "ui", id: "main", revision: newest.revision, data: newest.data })).toBe(
            true,
        );
        intercept.release!();
        await settle(fake);
        expect(db().zoomsize).toBe(202);
        expect(sync.heldRecordRevision("ui", "main")).toBe(newest.revision);
        expect(fake.batchCount()).toBe(0);
        noNotice();
    });

    it("resolves this tab's preset selection after a presets replacement removed the selected one, without a write", async () => {
        const { fake, db, selection } = await boot();
        const ids = (fake.record("presets", "main")!.data as { id: string }[]).map((preset) => preset.id);
        selection.selectPreset(ids[1]);
        fake.set("presets", "main", [fake.record("presets", "main")!.data[0]]);
        await settle(fake);
        expect(db().botPresets.map((preset: any) => preset.id)).toEqual([ids[0]]);
        expect(selection.selection.presetId).toBe(ids[0]);
        expect(fake.batchCount()).toBe(0);
        noNotice();
    });

    it("brings an `authRefreshes` entry a server job wrote to this tab (the job socket never carries that kind)", async () => {
        const { fake, sync, db } = await boot();
        fake.lock!.addToken("T");
        const kind = fake.kind("authRefreshes");
        const entries = [{ url: "https://mcp.test", refreshToken: "refresh-1" }];
        fake.store.applyChanges(
            {
                ops: [
                    { kind, id: "main", baseRevision: fake.record("authRefreshes", "main")!.revision, data: entries },
                ],
            },
            { epoch: fake.store.epoch(), jobToken: "T" },
        );
        const stored = fake.record("authRefreshes", "main")!;
        expect(
            sync.applyHydration({ kind: "authRefreshes", id: "main", revision: stored.revision, data: stored.data }),
        ).toBe(false);
        await settle(fake);
        expect(db().authRefreshes).toEqual(entries);
        expect(fake.batchCount()).toBe(0);
        noNotice();
    });

    it("adopts another credential with the same hint: the masked status is the same, every credential cache is invalidated, nothing is written", async () => {
        const { fake, db, secrets } = await boot({ secret: true });
        const path = secretPathKey({ kind: "flat", field: "openAIKey" });
        expect(secrets.llmSecretState.masked?.openAIKey).toEqual({ set: true, hint: "1234" });
        const before = secrets.llmSecretState.versions[path] ?? 0;
        fake.set("llmSecrets", "main", {
            ...fake.record("llmSecrets", "main")!.data,
            openAIKey: "sk-other-credential-xx1234",
        });
        await settle(fake);
        expect(secrets.llmSecretState.masked?.openAIKey).toEqual({ set: true, hint: "1234" });
        expect(secrets.llmSecretState.versions[path]).toBe(before + 1);
        expect(db().openAIKey).toBe("");
        expect(JSON.stringify(fake.feedEvents)).not.toContain("credential");
        expect(fake.batchCount()).toBe(0);
        expect(fake.secretRequests()).toEqual([]);
        noNotice();
    });
});

describe("characters another writer created or deleted", () => {
    it("inserts a new character with its chats, without a write", async () => {
        const { fake, character, chatIds, texts } = await boot();
        fake.store.applyChanges({
            ops: [{ kind: characterKind(fake), id: "n", baseRevision: null, data: { chaId: "n", name: "N" } }],
            chats: [create("n", "q", [m("y", "Y")])],
        });
        await settle(fake);
        expect(character("n").name).toBe("N");
        expect(chatIds("n")).toEqual(["q"]);
        expect(texts("n", "q")).toEqual(["Y"]);
        expect(fake.batchCount()).toBe(0);
        noNotice();
    });

    it("holds the empty chat order of a new character created without chats, so this tab's first chat for it is saved without a reload (Stop B fix)", async () => {
        // Before the fix the empty list left the order unheld: the character never counted as known
        // to the server, and its first chat's create waited forever (nothing saved, no notice).
        const { fake, chat, sync, character, chatIds } = await boot();
        fake.store.applyChanges({
            ops: [{ kind: characterKind(fake), id: "e", baseRevision: null, data: { chaId: "e", name: "E" } }],
        });
        await settle(fake);
        expect(character("e").name).toBe("E");
        expect(chatIds("e")).toEqual([]);
        expect(fake.order("e")!.ids).toEqual([]);
        expect(chat.heldOrderRevision("e")).toBe(fake.order("e")!.revision);
        expect(fake.batchCount()).toBe(0);

        // Opening it gives it its first chat: saved with the order on the next cycle.
        chat.ensureChat("e");
        const [first] = chatIds("e");
        await sync.flushResources();
        await settle(fake);
        expect(fake.chat("e", first)).not.toBeNull();
        expect(fake.order("e")!.ids).toEqual([first]);
        expect(chat.heldChatRevision({ chaId: "e", chatId: first })).toBe(fake.chat("e", first)!.revision);
        expect(chatIds("e")).toEqual([first]);
        noNotice();
    });

    it("removes a deleted selected character and moves the selection home; a recreation (a new incarnation) is inserted", async () => {
        const { fake, stores, db, character, chatIds } = await boot();
        fake.store.delete(characterKind(fake), "c", fake.record("characters", "c")!.revision);
        await settle(fake);
        expect(character("c")).toBeUndefined();
        expect(db().characters.map((entry: any) => entry.chaId)).toEqual(["d"]);
        expect(stores.selectedCharID).toBeDefined();
        let selected = 0;
        stores.selectedCharID.subscribe((value) => (selected = value))();
        expect(selected).toBe(-1);
        fake.store.applyChanges({
            ops: [{ kind: characterKind(fake), id: "c", baseRevision: null, data: { chaId: "c", name: "C2" } }],
            chats: [create("c", "k2")],
        });
        await settle(fake);
        expect(character("c").name).toBe("C2");
        expect(chatIds("c")).toEqual(["k2"]);
        expect(fake.batchCount()).toBe(0);
        noNotice();
    });

    it("applies a cascaded deletion (the character, its chats, and its order) of a non-selected character", async () => {
        const { fake, db } = await boot();
        fake.store.delete(characterKind(fake), "d", fake.record("characters", "d")!.revision);
        const event = fake.feedEvents.at(-1) as Extract<ServerFeedEvent, { type: "change" }>;
        expect(event.changes.chats).toEqual([{ characterId: "d", id: "m", revision: null }]);
        await settle(fake);
        expect(db().characters.map((entry: any) => entry.chaId)).toEqual(["c"]);
        expect(fake.batchCount()).toBe(0);
        noNotice();
    });

    it("applies a delayed deletion and then the recreation that followed it", async () => {
        const { fake, character, chatIds, intercept } = await boot();
        intercept.hold = (path) => path === "/api/resources/read";
        fake.store.delete(characterKind(fake), "d", fake.record("characters", "d")!.revision);
        await vi.advanceTimersByTimeAsync(100);
        expect(intercept.release).not.toBeNull();
        fake.store.applyChanges({
            ops: [{ kind: characterKind(fake), id: "d", baseRevision: null, data: { chaId: "d", name: "D2" } }],
            chats: [create("d", "m2")],
        });
        intercept.release!();
        await settle(fake);
        expect(character("d").name).toBe("D2");
        expect(chatIds("d")).toEqual(["m2"]);
        expect(fake.batchCount()).toBe(0);
        noNotice();
    });

    it("does not let a delayed deletion answer remove a newer incarnation a job installed meanwhile (finding 4)", async () => {
        const { fake, sync, live, character, intercept } = await boot();
        intercept.hold = (path) => path === "/api/resources/read";
        fake.store.delete(characterKind(fake), "d", fake.record("characters", "d")!.revision);
        await vi.advanceTimersByTimeAsync(100);
        expect(intercept.release).not.toBeNull();
        live.paused = true;
        fake.set("characters", "d", { chaId: "d", name: "D again" });
        const recreated = fake.record("characters", "d")!;
        expect(
            sync.applyHydration({ kind: "characters", id: "d", revision: recreated.revision, data: recreated.data }),
        ).toBe(true);
        intercept.release!();
        await vi.advanceTimersByTimeAsync(0);
        expect(character("d")?.name).toBe("D again");
        live.paused = false;
        live.queue.length = 0;
        await settle(fake);
        expect(character("d")?.name).toBe("D again");
        expect(fake.batchCount()).toBe(0);
    });

    it("keeps a deletion announced while an older update's read was out (finding 1)", async () => {
        const { fake, character, intercept } = await boot();
        intercept.hold = (path) => path === "/api/resources/read";
        fake.set("characters", "d", { chaId: "d", name: "D1" });
        await vi.advanceTimersByTimeAsync(100);
        expect(intercept.release).not.toBeNull();
        fake.store.delete(characterKind(fake), "d", fake.record("characters", "d")!.revision);
        intercept.release!();
        await settle(fake);
        expect(character("d")).toBeUndefined();
        expect(fake.batchCount()).toBe(0);
    });

    it("reads the chat list again for a chat created while a new character's first read was out (finding 1)", async () => {
        const { fake, chatIds, intercept } = await boot();
        intercept.hold = (path) => path === "/api/resources/read";
        fake.store.applyChanges({
            ops: [{ kind: characterKind(fake), id: "e", baseRevision: null, data: { chaId: "e", name: "E" } }],
            chats: [create("e", "e1")],
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(intercept.release).not.toBeNull();
        fake.store.applyChanges({ chats: [create("e", "e2")] });
        intercept.release!();
        await settle(fake);
        expect(chatIds("e")).toEqual(["e1", "e2"]);
        expect(fake.batchCount()).toBe(0);
    });

    it("refreshes a chat edited while its new character's first read was out (finding 1)", async () => {
        const { fake, texts, intercept } = await boot();
        intercept.hold = (path) => path === "/api/resources/read";
        fake.store.applyChanges({
            ops: [{ kind: characterKind(fake), id: "e", baseRevision: null, data: { chaId: "e", name: "E" } }],
            chats: [create("e", "e1", [m("t", "first")])],
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(intercept.release).not.toBeNull();
        // A message edit: a chat ref only, the order unchanged.
        fake.chatBatch([
            {
                characterId: "e",
                chatId: "e1",
                baseRevision: fake.chat("e", "e1")!.revision,
                ops: [{ op: "setText", id: "t", text: "second" } as any],
            },
        ]);
        intercept.release!();
        await settle(fake);
        expect(texts("e", "e1")).toEqual(["second"]);
        expect(fake.batchCount()).toBe(0);
    });

    it("settles a character created and deleted before this tab read it: no endless reads (finding 5)", async () => {
        const { fake, live, flushFeed, character } = await boot();
        live.paused = true;
        fake.set("characters", "x", { chaId: "x", name: "X" });
        fake.store.delete(characterKind(fake), "x", fake.record("characters", "x")!.revision);
        flushFeed();
        live.paused = false;
        await settle(fake);
        expect(reads(fake)).toBeLessThanOrEqual(1);
        expect(character("x")).toBeUndefined();
        expect(fake.batchCount()).toBe(0);
    });

    it("does not insert a character whose deletion was announced while its first read was out (finding 5)", async () => {
        const { fake, character, intercept } = await boot();
        intercept.hold = (path) => path === "/api/resources/read";
        fake.store.applyChanges({
            ops: [{ kind: characterKind(fake), id: "y", baseRevision: null, data: { chaId: "y", name: "Y" } }],
            chats: [create("y", "y1")],
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(intercept.release).not.toBeNull();
        // Its answer still holds the character; the deletion arrives before it.
        fake.store.delete(characterKind(fake), "y", fake.record("characters", "y")!.revision);
        intercept.release!();
        await settle(fake);
        expect(character("y")).toBeUndefined();
        expect(fake.batchCount()).toBe(0);
    });

    it("keeps the selected character after an earlier one is removed without running the selection's side effects (finding 6)", async () => {
        const { fake, sync, stores, db, character } = await boot();
        db().hypaV3 = true;
        db().hypaV3Presets = [
            { ...(db().hypaV3Presets?.[0] ?? {}), id: "h", name: "H", settings: { alwaysToggleOn: true } },
        ];
        db().hypaV3PresetId = "h";
        stores.selectedCharID.set(1);
        // Selecting `d` is a selection: it switches its memory on (a write).
        expect(character("d").supaMemory).toBe(true);
        character("d").supaMemory = false;
        await tick();
        await sync.flushResources();
        expect(fake.record("characters", "d")!.data.supaMemory).toBe(false);
        const batches = fake.batchCount();
        fake.store.delete(characterKind(fake), "c", fake.record("characters", "c")!.revision);
        await settle(fake);
        let selected = -2;
        stores.selectedCharID.subscribe((value) => (selected = value))();
        expect(selected).toBe(0);
        expect(db().characters[0].chaId).toBe("d");
        expect(character("d").supaMemory).toBe(false);
        expect(fake.batchCount()).toBe(batches);
    });
});

describe("chats and chat lists another writer changed", () => {
    it("refreshes an idle chat on another tab's message edit", async () => {
        const { fake, texts } = await boot();
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [{ op: "setText", id: "b", text: "B2" } as any],
            },
        ]);
        await settle(fake);
        expect(texts("c", "k")).toEqual(["A", "B2", "C"]);
        expect(fake.batchCount()).toBe(0);
        noNotice();
    });

    it("applies another writer's reorder after this tab's own reorder settles", async () => {
        const { fake, chat, chatIds, intercept } = await boot();
        intercept.afterApply = () => {
            fake.store.applyChanges({
                chatOrders: [{ characterId: "c", baseRevision: fake.order("c")!.revision, ids: ["k", "j"] }],
            });
        };
        chat.reorderChats("c", ["j", "k"]);
        await settle(fake);
        expect(fake.order("c")!.ids).toEqual(["k", "j"]);
        expect(chatIds()).toEqual(["k", "j"]);
        expect(fake.batchCount()).toBe(1);
        noNotice();
    });

    it("reads a chat list again when a reorder is announced while the list's read was out (finding 1)", async () => {
        const { fake, chatIds, intercept } = await boot();
        intercept.hold = (path) => path === "/api/resources/read";
        fake.store.applyChanges({ chats: [create("c", "y")] });
        await vi.advanceTimersByTimeAsync(100);
        expect(intercept.release).not.toBeNull();
        fake.store.applyChanges({
            chatOrders: [{ characterId: "c", baseRevision: fake.order("c")!.revision, ids: ["y", "k", "j"] }],
        });
        intercept.release!();
        await settle(fake);
        expect(chatIds()).toEqual(["y", "k", "j"]);
        expect(fake.batchCount()).toBe(0);
    });

    it("keeps a chat deleted here out of the mirror while another writer's new chat brings the list in (finding 2)", async () => {
        const { fake, chat, chatIds, intercept } = await boot();
        const seen: string[][] = [];
        intercept.beforeRequest = (path) => {
            if (path === "/api/resources/batch") {
                seen.push(chatIds());
            }
        };
        // Both before the cycle: the list is read and applied while the delete is still queued.
        chat.deleteChat({ chaId: "c", chatId: "j" });
        fake.store.applyChanges({ chats: [create("c", "y")] });
        await settle(fake);
        expect(seen[0]).not.toContain("j");
        expect(chatIds()).toEqual(["k", "y"]);
        expect(fake.chat("c", "j")).toBeNull();
        expect(fake.order("c")!.ids).toEqual(["k", "y"]);
        noNotice();
    });

    it("never writes when another writer deletes a character's only chat; its replacement then takes its place (finding 3)", async () => {
        const { fake, chatIds } = await boot();
        fake.chatBatch([
            {
                characterId: "d",
                chatId: "m",
                baseRevision: fake.chat("d", "m")!.revision,
                ops: [{ op: "delete" } as any],
            },
        ]);
        await settle(fake);
        expect(chatIds("d")).toEqual(["m"]);
        expect(fake.batchCount()).toBe(0);
        fake.store.applyChanges({ chats: [create("d", "n")] });
        await settle(fake);
        expect(chatIds("d")).toEqual(["n"]);
        expect(fake.batchCount()).toBe(0);
        noNotice();
    });

    it("does not let a delayed chat-list answer remove a newer copy a job installed meanwhile (finding 4)", async () => {
        const { fake, sync, live, flushFeed, chatIds, texts, intercept } = await boot();
        intercept.hold = (path) => path === "/api/resources/read";
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "j",
                baseRevision: fake.chat("c", "j")!.revision,
                ops: [{ op: "delete" } as any],
            },
        ]);
        await vi.advanceTimersByTimeAsync(600);
        expect(intercept.release).not.toBeNull();
        // While the read (its answer: deleted) is out, the chat is created again and a job's event installs it.
        live.paused = true;
        fake.store.applyChanges({ chats: [create("c", "j", [m("r", "again", "char")])] });
        const recreated = fake.chat("c", "j")!;
        expect(
            sync.applyHydration({
                kind: "chats",
                characterId: "c",
                id: "j",
                revision: recreated.revision,
                data: recreated.data,
            }),
        ).toBe(true);
        intercept.release!();
        // Right after the answer (before any later cycle could read the list again): the copy stays.
        await vi.advanceTimersByTimeAsync(0);
        expect(chatIds()).toContain("j");
        expect(texts("c", "j")).toEqual(["again"]);
        await vi.advanceTimersByTimeAsync(1000);
        expect(chatIds()).toContain("j");
        flushFeed();
        live.paused = false;
        await settle(fake);
        expect(chatIds()).toContain("j");
        expect(texts("c", "j")).toEqual(["again"]);
        expect(fake.batchCount()).toBe(0);
    });

    it("does not let a delayed idle read's deletion answer remove a newer copy a job installed meanwhile (finding 4)", async () => {
        const { fake, sync, live, chatIds, texts, intercept } = await boot();
        live.paused = true;
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "j",
                baseRevision: fake.chat("c", "j")!.revision,
                ops: [{ op: "delete" } as any],
            },
        ]);
        // Only the chat's ref arrives (its order's ref is later): the chat's idle read is the one held.
        intercept.hold = (path) => path === "/api/resources/read";
        sync.noteRemoteChanges({
            resources: [],
            chats: [{ characterId: "c", id: "j", revision: null }],
            chatOrders: [],
        });
        await vi.advanceTimersByTimeAsync(600);
        expect(intercept.release).not.toBeNull();
        expect(fake.requests.filter((r) => r.path === "/api/resources/read").at(-1)!.body.chats).toEqual([
            { characterId: "c", id: "j" },
        ]);
        fake.store.applyChanges({ chats: [create("c", "j", [m("r", "again", "char")])] });
        const recreated = fake.chat("c", "j")!;
        expect(
            sync.applyHydration({
                kind: "chats",
                characterId: "c",
                id: "j",
                revision: recreated.revision,
                data: recreated.data,
            }),
        ).toBe(true);
        intercept.release!();
        await vi.advanceTimersByTimeAsync(0);
        expect(chatIds()).toContain("j");
        expect(texts("c", "j")).toEqual(["again"]);
        live.paused = false;
        live.queue.length = 0;
        await settle(fake);
        expect(texts("c", "j")).toEqual(["again"]);
        expect(fake.batchCount()).toBe(0);
    });

    it("applies a job's chat once whichever comes first, the job event or the feed, and keeps the job's metadata at the same revision", async () => {
        for (const order of ["job first", "feed first"] as const) {
            const { fake, sync, chat, live, flushFeed, texts } = await boot();
            live.paused = true;
            fake.chatBatch([
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: fake.chat("c", "k")!.revision,
                    ops: [{ op: "setText", id: "b", text: "B1" } as any],
                },
            ]);
            const committed = fake.chat("c", "k")!;
            const event = {
                kind: "chats",
                characterId: "c",
                id: "k",
                revision: committed.revision,
                data: committed.data,
                job: { jobId: "J", streaming: [{ messageId: "b", generationId: "g1", seq: 0 }] },
            };
            if (order === "job first") {
                sync.applyHydration(event);
                flushFeed();
                await vi.advanceTimersByTimeAsync(1500);
                expect(reads(fake), order).toBe(0);
            } else {
                flushFeed();
                await vi.advanceTimersByTimeAsync(1500);
                expect(reads(fake), order).toBe(1);
                sync.applyHydration(event);
            }
            expect(texts("c", "k"), order).toEqual(["A", "B1", "C"]);
            expect(chat.isMessageLocked(refK, "b"), order).toBe(true);
            expect(fake.batchCount(), order).toBe(0);
            server.current.close();
        }
    });
});

describe("work that waits", () => {
    it("applies a generating character's update at once, without a write (the generation deferral is gone)", async () => {
        const { fake, sync, chat, character } = await boot();
        // A server job of this tab streams into `d`'s chat: `d` is generating. Since Phase 6 slice 5
        // nothing holds a generating character's record back; the job keeps its chat locked.
        chat.applyServerGeneration(
            { chaId: "d", chatId: "m" },
            { jobId: "J", messageId: "x", generationId: "g1", text: "X", seq: 0 },
        );
        expect(chat.isCharacterGenerating("d")).toBe(true);
        try {
            fake.set("characters", "d", { chaId: "d", name: "D remote" });
            await settle(fake);
            expect(reads(fake)).toBe(1);
            expect(character("d").name).toBe("D remote");
            expect(sync.heldRecordRevision("characters", "d")).toBe(fake.record("characters", "d")!.revision);
            expect(fake.batchCount()).toBe(0);
            noNotice();
        } finally {
            chat.endServerJob("J");
        }
        // The generation's end changes nothing more.
        await settle(fake);
        expect(fake.batchCount()).toBe(0);
    });

    it("reads at most 1,000 announced chats per request and reaches every one", async () => {
        const { fake, live, flushFeed, character, texts } = await boot();
        const ids = Array.from({ length: 1001 }, (_, index) => `n${index}`);
        fake.store.applyChanges({ chats: ids.map((id) => create("d", id, [m(`${id}-m`, "old")])) });
        await settle(fake);
        expect(character("d").chats).toHaveLength(1002);
        fake.requests.length = 0;
        live.paused = true;
        fake.store.applyChanges({
            chats: ids.map((id) => ({
                characterId: "d",
                chatId: id,
                baseRevision: fake.chat("d", id)!.revision,
                ops: [{ op: "setText", id: `${id}-m`, text: "new" }],
            })),
        });
        flushFeed();
        live.paused = false;
        await settle(fake);
        const sizes = fake.requests
            .filter((r) => r.path === "/api/resources/read")
            .map((r) => (r.body.chats ?? []).length as number);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(1000);
        expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(1001);
        expect(ids.every((id) => texts("d", id)[0] === "new")).toBe(true);
        expect(fake.batchCount()).toBe(0);
    });
});

describe("the reconcile after a `hello`", () => {
    it("reads every record that differs, drops a removed one, and reads nothing when nothing differs", async () => {
        const { fake, sync, live, db, character, chatIds } = await boot();
        live.paused = true;
        editUi(fake, { zoomsize: 175 });
        fake.store.delete(characterKind(fake), "d", fake.record("characters", "d")!.revision);
        fake.store.applyChanges({ chats: [create("c", "z")] });
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [{ op: "setText", id: "a", text: "A9" } as any],
            },
        ]);
        // The disconnected tab missed every event; its reconnect lists the revisions.
        live.queue.length = 0;
        live.paused = false;
        sync.reconcileRemote(fake.store.listRevisions());
        await settle(fake);
        expect(db().zoomsize).toBe(175);
        expect(character("d")).toBeUndefined();
        expect(chatIds()).toEqual(["k", "j", "z"]);
        expect(character().chats[0].message[0].data).toBe("A9");
        expect(fake.batchCount()).toBe(0);
        noNotice();
        const before = reads(fake);
        sync.reconcileRemote(fake.store.listRevisions());
        await settle(fake);
        expect(reads(fake)).toBe(before);
    });
});

describe("halting for a restore", () => {
    it("applies nothing and sends nothing once an epoch change lands during a live read (finding 9)", async () => {
        const { fake, client, db, character, intercept } = await boot();
        intercept.hold = (path) => path === "/api/resources/read";
        editUi(fake, { zoomsize: 190 });
        // A local edit of another record waits for this cycle's batch, after the live read.
        character().name = "C local";
        await vi.advanceTimersByTimeAsync(100);
        expect(intercept.release).not.toBeNull();
        expect(fake.batchCount()).toBe(0);
        client.epochMismatch("restored-epoch");
        intercept.release!();
        await vi.advanceTimersByTimeAsync(5000);
        expect(fake.batchCount()).toBe(0);
        expect(db().zoomsize).not.toBe(190);
        expect(fake.record("characters", "c")!.data.name).toBe("C");
        expect(alerts.terminal).toHaveBeenCalledWith("restored");
    });

    it("refuses a batch at dispatch when saving halted after it was captured (finding 9)", async () => {
        const { fake, sync, client, db, chat } = await boot();
        let open!: () => void;
        dispatch.gate = new Promise<void>((resolve) => (open = resolve));
        db().iconsize = 44;
        chat.setMessageText(refK, "a", "local");
        const flushing = sync.flushResources().catch((error) => error);
        await vi.advanceTimersByTimeAsync(0);
        client.epochMismatch("restored-epoch");
        open();
        dispatch.gate = null;
        await flushing;
        await vi.advanceTimersByTimeAsync(5000);
        expect(fake.batchCount()).toBe(0);
        expect(fake.record("ui", "main")!.data.iconsize).not.toBe(44);
        expect(fake.texts("c", "k")[0]).toBe("A");
    });
});
