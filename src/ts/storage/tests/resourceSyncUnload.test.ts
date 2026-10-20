import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_EPOCH_HEADER, RESOURCE_KIND } from "../../../../shared/resources.ts";
import { FakeResourceServer } from "./fakeResourceServer";
import { materialize } from "./serverKinds";
import { StoreBackedServer } from "./storeBackedServer";

// The save adapter's page lifecycle handlers: a hidden page saves at once, and `beforeunload` asks
// for the browser's warning only while work is unsaved; and the answer to an unload request that
// arrives after the chat's character or work is gone (slice A3). Its own file, away from the many
// graphs `resourceSync.test.ts` boots: every test here boots one module graph and leaves it with no
// unsaved work, so the listeners earlier tests left on the shared window warn for nothing and send
// nothing, and the keepalive requests of a test are told apart by its server's epoch.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
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
    }),
);
vi.mock("src/lang", () => ({
    language: { resourceReloaded: "reloaded", resourceRestored: "restored" },
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

type Sync = typeof import("../resourceSync.svelte");
type Client = typeof import("../resourceClient");
type Bootstrap = typeof import("../../bootstrap");
type SettingsViews = typeof import("../settingsViews.svelte");
type ChatModule = typeof import("../chatStore.svelte");
type CharacterStore = typeof import("../characterStore.svelte");
type Selection = typeof import("../selection.svelte");

async function boot() {
    vi.resetModules();
    const fake = new FakeResourceServer();
    // No `root` record since slice 6: the sections and collections are the records the server
    // materializes; the sample edit is `ui.theme`.
    fake.set("presets", "main", [{ name: "p1" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    fake.set("characters", "a", { chaId: "a", name: "Alice", type: "character" });
    await materialize(fake);
    server.current = fake;

    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");
    const bootstrap: Bootstrap = await import("../../bootstrap");
    const { settings }: SettingsViews = await import("../settingsViews.svelte");

    const snapshot = await client.readKinds(Object.values(RESOURCE_KIND));
    sync.seedResources(snapshot);
    // The records and the selection (at home), as `loadData` installs them.
    bootstrap.installBootRecords(snapshot);
    fake.requests.length = 0;
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    fake.requests.length = 0;
    return { fake, sync, settings };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    server.current?.close?.();
    server.current = null;
});

const warns = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
};

describe("page lifecycle", () => {
    it("saves at once when the page is hidden, and warns before unload only while work is unsaved", async () => {
        const { fake, settings } = await boot();
        expect(warns()).toBe(false);
        settings.ui.theme = "hidden";
        await tick();
        expect(warns()).toBe(true);
        expect(fake.batchCount()).toBe(0);

        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        try {
            document.dispatchEvent(new Event("visibilitychange"));
            // The cycle runs without the 500 ms debounce (never advanced here).
            for (let i = 0; i < 10; i++) {
                await vi.advanceTimersByTimeAsync(1);
            }
        } finally {
            delete (document as any).visibilityState;
        }
        expect(fake.batchCount()).toBe(1);
        expect(fake.data("ui", "main").theme).toBe("hidden");
        expect(warns()).toBe(false);
    });
});

// Open-bug-fixes slice A3: an unload request's group leaves the in-flight set when the server
// confirms its character gone (this tab's acknowledged deletion or another writer's) or when an
// authoritative list discards its chat's work; `settleUnloadWork` then ignores the group's late
// answer instead of holding the deleted chat's revision again or queuing its work once more.
describe("a late unload answer after the chat's character or work is gone (open-bug-fixes slice A3)", () => {
    const refK = { chaId: "c", chatId: "k" };
    const m = (id: string, data: string) => ({ role: "user", data, chatId: id }) as any;
    const chatOf = (id: string, text: string) =>
        ({ id, name: id.toUpperCase(), note: "", localLore: [], message: [m(`${id}-message`, text)] }) as any;

    /**
     * Boots over the real server store with character `c` (chats `k` and `j`), the chat module, and
     * the character module, as `resourceSyncChats.test.ts` does. The keepalive request bypasses
     * `authFetch`: the raw fetch is routed to the fake, and `keepalive` holds the answers of this
     * graph's requests (by the epoch); with `keepaliveFails` set they reject after the server
     * answered (the connection dropped with the answer).
     */
    async function bootStore() {
        vi.resetModules();
        const fake = await StoreBackedServer.create();
        fake.set("presets", "main", [{ name: "p1" }]);
        fake.set("modules", "main", []);
        fake.set("plugins", "main", []);
        fake.set("pluginStorage", "main", {});
        fake.store.applyChanges({
            ops: [{ kind: fake.kind("characters"), id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
            chats: [
                { characterId: "c", chatId: "k", baseRevision: null, ops: [{ op: "create", chat: chatOf("k", "K") }] },
                { characterId: "c", chatId: "j", baseRevision: null, ops: [{ op: "create", chat: chatOf("j", "J") }] },
            ],
        });
        server.current = fake;
        const keepalive: Promise<unknown>[] = [];
        const keepaliveFails = { current: false };
        vi.stubGlobal("fetch", (path: string, init: RequestInit) => {
            const answer = fake.fetch(path, init);
            if (new Headers(init.headers).get(RESOURCE_EPOCH_HEADER) !== fake.store.epoch()) {
                return answer;
            }
            const seen = keepaliveFails.current
                ? answer.then(() => {
                      throw new TypeError("Failed to fetch");
                  })
                : answer;
            keepalive.push(seen);
            return seen;
        });

        const client: Client = await import("../resourceClient");
        const sync: Sync = await import("../resourceSync.svelte");
        const chat: ChatModule = await import("../chatStore.svelte");
        const bootstrap: Bootstrap = await import("../../bootstrap");
        const characterStore: CharacterStore = await import("../characterStore.svelte");
        const selection: Selection = await import("../selection.svelte");

        const snapshot = await client.readKinds(Object.values(RESOURCE_KIND), { chats: true });
        sync.seedResources(snapshot);
        chat.seedChats(snapshot.chats ?? [], snapshot.chatOrders ?? []);
        bootstrap.installBootRecords(snapshot);
        selection.selectCharacter(null);
        chat.initializeChats();
        sync.startResourceSync();
        await tick();
        await sync.flushResources();
        fake.requests.length = 0;
        const characters = () => characterStore.characterList() as any[];
        const mirrorIds = () => chat.chatList("c").map((entry) => entry.id);
        return { fake, sync, chat, characterStore, keepalive, keepaliveFails, characters, mirrorIds };
    }
    type Booted = Awaited<ReturnType<typeof bootStore>>;

    /** Edits `k` and lets `pagehide` send the edit: the server applies it and holds its answer. */
    async function holdUnloadAnswer(h: Booted) {
        h.chat.setMessageText(refK, "k-message", "unload write");
        h.fake.holdNextBatchResponse = true;
        window.dispatchEvent(new Event("pagehide"));
        expect(h.keepalive).toHaveLength(1);
        await vi.waitFor(() => expect(h.fake.releaseBatchResponse).not.toBeNull());
        expect(h.fake.texts("c", "k")).toEqual(["unload write"]);
        expect(h.chat.hasUnsavedChatWork()).toBe(true);
    }

    /** Lets the held answer reach the page; the request's result callback has run afterwards. */
    async function releaseUnloadAnswer(h: Booted) {
        h.fake.releaseBatchResponse!();
        await h.keepalive[0].catch(() => undefined);
        for (let i = 0; i < 10; i++) {
            await vi.advanceTimersByTimeAsync(1);
        }
    }

    /** The late answer changed nothing: no revision of `k`, no work, nothing more sent, no warning. */
    async function expectNothingLeft(h: Booted, batches: number) {
        expect(h.chat.heldChatRevision(refK)).toBeNull();
        expect(h.chat.hasChatWork()).toBe(false);
        expect(h.chat.hasUnsavedChatWork()).toBe(false);
        expect(warns()).toBe(false);
        expect(await h.sync.flushResources()).toEqual({ discarded: [] });
        expect(h.fake.batchCount()).toBe(batches);
    }

    it.each([
        ["succeeded", false],
        ["failed after the server applied it", true],
    ])(
        "ignores the answer of an unload request that %s when this tab's deletion of the character was acknowledged meanwhile: no revision held, nothing queued, and the deletion's flush not held back",
        async (_, fails) => {
            const h = await bootStore();
            h.keepaliveFails.current = fails;
            await holdUnloadAnswer(h);
            expect(warns()).toBe(true);
            expect(h.characterStore.removeCharacter("c")).toBe(true);
            // The deletion goes out and is acknowledged while the unload answer is still in transit;
            // the retired group does not hold the flush barrier.
            expect(await h.sync.flushResources()).toEqual({ discarded: [] });
            expect(h.fake.record("characters", "c")).toBeNull();
            expect(h.fake.chat("c", "k")).toBeNull();
            expect(h.chat.heldChatRevision(refK)).toBeNull();
            expect(h.chat.hasUnsavedChatWork()).toBe(false);
            expect(warns()).toBe(false);
            const batches = h.fake.batchCount();

            // Before slice A3 the answer held the deleted chat's revision again, and a failed request
            // put its ops back in front of the queue as a resend for a chat the cascade removed.
            await releaseUnloadAnswer(h);
            await expectNothingLeft(h, batches);
            expect(h.characters()).toEqual([]);
            expect(alerts.error).not.toHaveBeenCalled();
        },
    );

    it("ignores the answer when another tab's deletion of the character arrived meanwhile: the request's work was reported as discarded, and no revision comes back", async () => {
        const h = await bootStore();
        const scope = h.sync.beginMutationScope();
        await holdUnloadAnswer(h);
        h.fake.store.delete(h.fake.kind("characters"), "c", h.fake.record("characters", "c")!.revision);
        h.sync.noteRemoteChanges({
            resources: [{ kind: "characters", id: "c", revision: null }],
            chats: [],
            chatOrders: [],
        });
        await vi.advanceTimersByTimeAsync(700);
        // The in-flight group counts as discarded (the request may still answer); its answer then
        // changes nothing.
        expect(await h.sync.flushResources({ scope })).toEqual({ discarded: ["chats/c/k"] });
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        expect(h.characters()).toEqual([]);
        expect(h.chat.heldChatRevision(refK)).toBeNull();
        expect(h.chat.hasUnsavedChatWork()).toBe(false);
        const batches = h.fake.batchCount();

        await releaseUnloadAnswer(h);
        await expectNothingLeft(h, batches);
        expect(h.characters()).toEqual([]);
    });

    it("creates a chat re-added under the id while the deletion was in flight at once, without waiting for the unload answer of its deleted incarnation, which then changes nothing", async () => {
        const h = await bootStore();
        await holdUnloadAnswer(h);
        h.fake.holdNextBatch = true;
        expect(h.characterStore.removeCharacter("c")).toBe(true);
        const deleting = h.sync.flushResources();
        await vi.waitFor(() => expect(h.fake.releaseBatch).not.toBeNull());
        h.characterStore.addCharacter({
            chaId: "c",
            name: "Replacement",
            chats: [chatOf("k", "Rewritten transcript")],
        });
        h.fake.releaseBatch!();
        // The acknowledged deletion retires the old `k`'s unload group with the deleted chats, so the
        // replacement's `k` is created with the character in the follow-up cycle (before slice A3 its
        // create waited for the group in flight under the same key).
        expect(await deleting).toEqual({ discarded: [] });
        expect(h.fake.record("characters", "c")!.data.name).toBe("Replacement");
        expect(h.fake.order("c")!.ids).toEqual(["k"]);
        expect(h.fake.texts("c", "k")).toEqual(["Rewritten transcript"]);
        const created = h.fake.chat("c", "k")!.revision;
        expect(h.chat.heldChatRevision(refK)).toBe(created);
        expect(h.chat.hasUnsavedChatWork()).toBe(false);
        const batches = h.fake.batchCount();

        await releaseUnloadAnswer(h);
        expect(h.chat.heldChatRevision(refK)).toBe(created);
        expect(h.chat.hasChatWork()).toBe(false);
        expect(h.chat.hasUnsavedChatWork()).toBe(false);
        expect(warns()).toBe(false);
        expect(await h.sync.flushResources()).toEqual({ discarded: [] });
        expect(h.fake.batchCount()).toBe(batches);
        expect(h.fake.texts("c", "k")).toEqual(["Rewritten transcript"]);
        expect(h.mirrorIds()).toEqual(["k"]);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("ignores the answer when an authoritative list discarded the chat's in-flight work meanwhile (another tab deleted the chat, and a reorder's conflict read the list): the deleted chat's revision is not held again", async () => {
        const h = await bootStore();
        const scope = h.sync.beginMutationScope();
        await holdUnloadAnswer(h);
        h.fake.chatBatch([
            { characterId: "c", chatId: "k", baseRevision: h.fake.chat("c", "k")!.revision, ops: [{ op: "delete" }] },
        ]);
        h.chat.reorderChats("c", ["j", "k"]);
        expect(await h.sync.flushResources({ scope })).toEqual({ discarded: ["chats/c/k"] });
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        expect(h.mirrorIds()).toEqual(["j"]);
        expect(h.chat.heldChatRevision(refK)).toBeNull();
        expect(h.chat.hasUnsavedChatWork()).toBe(false);
        const batches = h.fake.batchCount();

        await releaseUnloadAnswer(h);
        await expectNothingLeft(h, batches);
        expect(h.mirrorIds()).toEqual(["j"]);
    });
});
