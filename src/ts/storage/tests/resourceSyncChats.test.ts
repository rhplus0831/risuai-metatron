import { tick } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_EPOCH_HEADER, RESOURCE_KIND } from "../../../../shared/resources.ts";
import { SAVE_DEBOUNCE_MS, warmMutationGraph } from "./mutationStoresHarness";
import { StoreBackedServer } from "./storeBackedServer";

// The save adapter (`resourceSync.svelte.ts`) together with the chat module (`chatStore.svelte.ts`)
// against the real server store: mixed batches, the request caps, quarantine, conflicts, deferral,
// hydration, and the flush barrier. Each test boots a fresh module graph, as `resourceSync.test.ts`
// does; that file keeps the resource-only behavior.

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
type ChatModule = typeof import("../chatStore.svelte");
type Bootstrap = typeof import("../../bootstrap");
type SettingsViews = typeof import("../settingsViews.svelte");
type CharacterStore = typeof import("../characterStore.svelte");
type Selection = typeof import("../selection.svelte");

const KINDS = Object.values(RESOURCE_KIND);
const m = (id: string | undefined, data: string, role: "user" | "char" = "user") => ({ role, data, chatId: id }) as any;
const refK = { chaId: "c", chatId: "k" };
const refJ = { chaId: "c", chatId: "j" };

/**
 * Boots the adapter and the chat module the way `loadData` does: the server holds the collections
 * and a character `c` with chats `k` (messages a, b, c) and `j` (empty); read with chats, seed,
 * install the records (`installBootRecords`, the selection at home), select the chats, start, and
 * let the boot compare pass run (`bootBatches` is what it sent).
 */
async function boot(prepare?: (server: StoreBackedServer) => void) {
    vi.resetModules();
    const fake = await StoreBackedServer.create();
    // The store materialized the sections and collections when it opened; there is no `root` record,
    // and the sample singleton edit of these tests is `ui.theme`.
    fake.set("presets", "main", [{ name: "p1" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    fake.store.applyChanges({
        ops: [{ kind: fake.kind("characters"), id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
        chats: [
            {
                characterId: "c",
                chatId: "k",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: "k",
                            name: "K",
                            note: "",
                            localLore: [],
                            message: [m("a", "A", "char"), m("b", "B"), m("c", "C", "char")],
                        } as any,
                    },
                ],
            },
            {
                characterId: "c",
                chatId: "j",
                baseRevision: null,
                ops: [{ op: "create", chat: { id: "j", name: "J", note: "", localLore: [], message: [] } as any }],
            },
        ],
    });
    prepare?.(fake);
    server.current = fake;

    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");
    const chat: ChatModule = await import("../chatStore.svelte");
    const bootstrap: Bootstrap = await import("../../bootstrap");
    const { settings }: SettingsViews = await import("../settingsViews.svelte");
    const { characterList }: CharacterStore = await import("../characterStore.svelte");
    const selection: Selection = await import("../selection.svelte");

    const snapshot = await client.readKinds(KINDS, { chats: true });
    sync.seedResources(snapshot);
    chat.seedChats(snapshot.chats ?? [], snapshot.chatOrders ?? []);
    // `installBootRecords` also assembles the chats into the chat module.
    bootstrap.installBootRecords(snapshot);
    selection.selectCharacter(null);
    chat.initializeChats();
    fake.requests.length = 0;
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    const bootBatches = fake.batchBodies();
    fake.requests.length = 0;
    /** The character wrappers, with the chat module's compatibility view (`chats`, `chatPage`). */
    const characters = () => characterList() as any[];
    // The membership: a chat another tab created is listed as a summary until it is loaded, so the
    // compatibility view (the loaded chats only) is not the list.
    const mirrorIds = () => chat.chatList("c").map((entry) => entry.id);
    return { fake, client, sync, chat, bootBatches, settings, characters, selection, mirrorIds };
}

beforeAll(() => warmMutationGraph(() => import("./reactiveProbe.svelte")), 60_000);

beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.stubGlobal("location", { reload: vi.fn() });
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

describe("boot and mixed batches", () => {
    it("hydrates the chats without echoing anything back, and keeps chats out of the character record", async () => {
        const { fake, sync, chat, characters, bootBatches, mirrorIds } = await boot();
        expect(bootBatches).toEqual([]);
        expect(mirrorIds()).toEqual(["k", "j"]);
        expect(characters()[0].chatPage).toBe(0);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
        characters()[0].name = "renamed";
        // A wrapper refuses a `chatPage` write; the selection is the chat module's.
        chat.selectChat("c", 1);
        // The write itself queues the character's save (no mark).
        await sync.flushResources();
        const saved = fake.record("characters", "c")!.data as any;
        expect(saved.name).toBe("renamed");
        expect(saved).not.toHaveProperty("chats");
        expect(saved).not.toHaveProperty("chatPage");
    });

    it("sends resource ops, chat groups, and reorders in one request, without touching the character revision", async () => {
        const { fake, sync, chat, settings, mirrorIds } = await boot();
        const characterRevision = fake.record("characters", "c")!.revision;
        settings.ui.theme = "edited";
        chat.appendMessage(refK, m("d", "D"));
        chat.setChatMeta(refJ, { note: "j note" });
        chat.createChat("c", { id: "n", name: "N", message: [m("x", "X")] } as any, { index: 0 });
        chat.reorderChats("c", ["j", "n", "k"]);
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(fake.batchCount()).toBe(1);
        const [body] = fake.batchBodies();
        expect(body.ops.map((op: any) => op.kind)).toEqual(["ui"]);
        expect(body.chats.map((group: any) => [group.chatId, group.ops.map((op: any) => op.op)])).toEqual([
            ["n", ["create"]],
            ["k", ["append"]],
            ["j", ["meta"]],
        ]);
        expect(body.chatOrders).toHaveLength(1);
        expect(fake.record("ui", "main")!.data).toMatchObject({ theme: "edited" });
        expect(fake.texts("c", "k")).toEqual(["A", "B", "C", "D"]);
        expect(fake.texts("c", "n")).toEqual(["X"]);
        expect((fake.chat("c", "j")!.data as any).note).toBe("j note");
        expect(fake.order("c")!.ids).toEqual(["j", "n", "k"]);
        expect(mirrorIds()).toEqual(["j", "n", "k"]);
        expect(fake.record("characters", "c")!.revision).toBe(characterRevision);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(1);
    });

    it("creates a new character's chats exactly once, with the record holding none of them", async () => {
        const { fake, sync, characters } = await boot();
        const characterStore = await import("../characterStore.svelte");
        // The list changes through the character module (a push through the list wrapper is refused).
        characterStore.addCharacter({
            chaId: "d",
            name: "D",
            type: "character",
            chats: [
                { id: "d1", name: "One", message: [m("x", "X")] },
                { name: "Two", message: [] },
            ],
            chatPage: 1,
        });
        await sync.flushResources();
        expect(fake.record("characters", "d")!.data).not.toHaveProperty("chats");
        const order = fake.order("d")!;
        expect(order.ids).toHaveLength(2);
        expect(order.ids[0]).toBe("d1");
        expect(fake.texts("d", "d1")).toEqual(["X"]);
        expect(characters()[1].chats.map((entry: any) => entry.id)).toEqual(order.ids);
        const before = fake.batchCount();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(before);
        expect(fake.store.readKinds([fake.kind("characters")], { chats: true }).chats).toHaveLength(4);
    });

    it("renames a message id the server refuses and redirects the edit queued meanwhile", async () => {
        const { fake, sync, chat } = await boot();
        const ref = { chaId: "c", chatId: "n" };
        fake.holdNextBatch = true;
        chat.createChat("c", { id: "n", name: "N", message: [m("bad\tid", "old")] } as any);
        const first = sync.flushResources();
        await vi.waitFor(() => expect(fake.releaseBatch).not.toBeNull());
        chat.setMessageText(ref, "bad\tid", "edited during the create");
        fake.releaseBatch!();
        await first;
        const serverId = fake.chat("c", "n")!.data.message[0].chatId as string;
        expect(serverId).not.toBe("bad\tid");
        expect(chat.findChat(ref)!.message[0].chatId).toBe(serverId);
        // The redirected edit goes out in the next cycle: the save debounce after the batch.
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
        expect(fake.texts("c", "n")).toEqual(["edited during the create"]);
    });
});

describe("the flush barrier", () => {
    it("waits for chat work already in flight", async () => {
        const { fake, sync, chat } = await boot();
        fake.holdNextBatch = true;
        chat.setChatMeta(refK, { note: "in flight" });
        const first = sync.flushResources();
        await vi.waitFor(() => expect(fake.releaseBatch).not.toBeNull());
        let secondSettled = false;
        const second = sync.flushResources().then((result) => {
            secondSettled = true;
            return result;
        });
        await vi.advanceTimersByTimeAsync(50);
        expect(secondSettled).toBe(false);
        expect((fake.chat("c", "k")!.data as any).note).toBe("");
        fake.releaseBatch!();
        await first;
        expect((await second).discarded).toEqual([]);
        expect((fake.chat("c", "k")!.data as any).note).toBe("in flight");
    });

    it("keeps a chat edit made during a request queued and sends it in the next cycle", async () => {
        const { fake, sync, chat } = await boot();
        fake.holdNextBatch = true;
        chat.setMessageText(refK, "a", "first");
        const flushed = sync.flushResources();
        await vi.waitFor(() => expect(fake.releaseBatch).not.toBeNull());
        chat.setMessageText(refK, "a", "second");
        chat.setChatMeta(refK, { note: "meanwhile" });
        fake.releaseBatch!();
        await flushed;
        expect(fake.texts("c", "k")[0]).toBe("first");
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
        expect(fake.texts("c", "k")[0]).toBe("second");
        expect((fake.chat("c", "k")!.data as any).note).toBe("meanwhile");
        expect(fake.batchCount()).toBe(2);
    });

    it("treats a create whose answer was lost as landed", async () => {
        const { fake, sync, chat } = await boot();
        fake.dropNextBatchResponse = true;
        chat.createChat("c", { id: "n", name: "N", message: [m("x", "old")] } as any);
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        expect(fake.chat("c", "n")).not.toBeNull();
        chat.setMessageText({ chaId: "c", chatId: "n" }, "x", "newer");
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(fake.texts("c", "n")).toEqual(["newer"]);
        expect(alerts.normal).not.toHaveBeenCalled();
    });
});

// Each case needs more than the 5,000 operations one batch may carry (the server's cap), queued one
// call at a time and applied by the store: about a quarter second of CPU, so each has its own budget
// for a ninth of a CPU instead of the default timeout.
describe("request caps", () => {
    it("sends more than 5,000 unsent ops of one chat over several requests without losing any or blocking other chats", async () => {
        const { fake, sync, chat } = await boot();
        for (let index = 0; index <= 5000; index += 1) {
            if (index % 2 === 1) {
                chat.setChatMeta(refK, { note: `note ${index}` });
            } else {
                chat.setMessageText(refK, "a", `text ${index}`);
            }
        }
        chat.setChatMeta(refJ, { note: "must persist" });
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(alerts.error).not.toHaveBeenCalled();
        expect(fake.texts("c", "k")[0]).toBe("text 5000");
        expect((fake.chat("c", "k")!.data as any).note).toBe("note 4999");
        expect((fake.chat("c", "j")!.data as any).note).toBe("must persist");
        const nested = fake
            .batchBodies()
            .map((body) => body.chats.reduce((sum: number, group: any) => sum + group.ops.length, 0));
        expect(nested.length).toBeGreaterThanOrEqual(2);
        expect(Math.max(...nested)).toBeLessThanOrEqual(5000);
        expect(nested.reduce((sum, count) => sum + count, 0)).toBe(5002);
        expect(chat.hasChatWork()).toBe(false);
    }, 20_000);

    it("bases a reorder sent in a later request on the order revision its own earlier request produced", async () => {
        const { fake, sync, chat, mirrorIds } = await boot();
        chat.reorderChats("c", ["j", "k"]);
        chat.createChat("c", { id: "n", name: "N", message: [] } as any);
        for (let index = 0; index < 4999; index += 1) {
            if (index % 2 === 1) {
                chat.setChatMeta(refK, { note: `note ${index}` });
            } else {
                chat.setMessageText(refK, "a", `text ${index}`);
            }
        }
        expect(mirrorIds()).toEqual(["j", "k", "n"]);
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(alerts.normal).not.toHaveBeenCalled();
        const bodies = fake.batchBodies();
        expect(bodies.length).toBeGreaterThanOrEqual(2);
        // The create went in an earlier request than the reorder.
        const createRequest = bodies.findIndex((body) => body.chats.some((group: any) => group.chatId === "n"));
        const orderRequest = bodies.findIndex((body) => body.chatOrders.length > 0);
        expect(createRequest).toBeGreaterThanOrEqual(0);
        expect(orderRequest).toBeGreaterThan(createRequest);
        expect(fake.order("c")!.ids).toEqual(["j", "k", "n"]);
        expect(mirrorIds()).toEqual(["j", "k", "n"]);
    }, 20_000);
});

describe("one chat's trouble does not block the rest", () => {
    it("quarantines a chat whose data the server refuses and keeps saving the others and the ui section", async () => {
        // The per-chat quarantine relies on the server naming the group (`chats[i]...`) in every
        // validation error of a chat group, including one found while applying the group (a `meta`
        // patch whose merged result the normalizer refuses).
        const { fake, sync, chat, settings } = await boot();
        chat.setChatMeta(refK, { fmIndex: "not a number" as any });
        chat.setChatMeta(refJ, { note: "fine" });
        settings.ui.theme = "section edit";
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["chats/c/k"]);
        expect(alerts.error).toHaveBeenCalledTimes(1);
        expect(alerts.error.mock.calls[0][0]).toMatch(/chat k could not be saved: chats\[0\]\.ops\[0\]/);
        expect((fake.chat("c", "j")!.data as any).note).toBe("fine");
        expect(fake.record("ui", "main")!.data).toMatchObject({ theme: "section edit" });
        // The refused value did not land: the chat keeps the server's default (-1).
        expect((fake.chat("c", "k")!.data as any).fmIndex).toBe(-1);
        expect(chat.hasChatWork()).toBe(false);
        chat.setChatMeta(refJ, { note: "still saving" });
        await sync.flushResources();
        expect((fake.chat("c", "j")!.data as any).note).toBe("still saving");
    });

    it("defers the conflict of a chat a server job streams into, saves the rest on its own, and reloads the chat once the job ends", async () => {
        const { fake, sync, chat, settings } = await boot();
        chat.applyServerGeneration(refK, { jobId: "J", messageId: "a", generationId: "g", text: "streamed", seq: 0 });
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [{ op: "meta", set: { note: "remote" } }],
            },
        ]);
        chat.removeMessages(refK, ["b", "c"]);
        chat.setChatMeta(refJ, { note: "j saved" });
        settings.ui.theme = "section saved";
        await expect(sync.flushResources()).rejects.toThrow(/still being generated/);
        // The rest goes out on its own in the next cycle, the save debounce after the refusal.
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
        expect(fake.record("ui", "main")!.data).toMatchObject({ theme: "section saved" });
        expect((fake.chat("c", "j")!.data as any).note).toBe("j saved");
        expect(chat.findChat(refK)!.message.map((message) => message.data)).toEqual(["streamed"]);
        expect(chat.isMessageLocked(refK, "a")).toBe(true);

        chat.endServerJob("J");
        expect(chat.isMessageLocked(refK, "a")).toBe(false);
        const result = await sync.flushResources();
        // The bulk removal is discarded with the reload; the server's copy replaces the chat.
        expect(result.discarded).toEqual(["chats/c/k"]);
        expect(chat.findChat(refK)!.message.map((message) => message.data)).toEqual(["A", "B", "C"]);
        expect((chat.findChat(refK) as any).note).toBe("remote");
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        expect(fake.texts("c", "k")).toEqual(["A", "B", "C"]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("re-bases a chat acknowledged on an older revision once it is idle, so a later revision-bound op does not conflict", async () => {
        const { fake, sync, chat } = await boot();
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [{ op: "setText", id: "b", text: "remote" }],
            },
        ]);
        chat.setChatMeta(refK, { note: "mine" });
        const stale = await sync.flushResources();
        expect(stale.discarded).toEqual([]);
        await vi.waitFor(() => expect(chat.findChat(refK)!.message[1].data).toBe("remote"), { timeout: 5000 });
        expect(chat.idleChatRefreshes()).toEqual([]);
        expect((chat.findChat(refK) as any).note).toBe("mine");
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");

        chat.removeMessages(refK, ["b", "c"]);
        const bulk = await sync.flushResources();
        expect(bulk.discarded).toEqual([]);
        expect(fake.texts("c", "k")).toEqual(["A"]);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
    });

    it("keeps another tab's text when this tab toggles Disable on an older base, and keeps its variables when this tab merges one: the idle refresh then converges the mirror", async () => {
        const { fake, sync, chat } = await boot();
        chat.setChatMeta(refK, { scriptstate: { $c: "3" } });
        await sync.flushResources();
        // The other tab: a text edit of `a` and a variable, landed; this tab has not read them (its
        // feed is not delivered here), so its base is older when its own writes go out.
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [
                    { op: "setText", id: "a", text: "A by the other tab" },
                    { op: "meta", merge: { scriptstate: { $a: "1" } } },
                ],
            },
        ]);
        expect(chat.findChat(refK)!.message[0].data).toBe("A");
        chat.patchMessage(refK, "a", { disabled: true });
        chat.mergeChatMeta(refK, "scriptstate", { $b: "2" }, ["$c"]);
        const stale = await sync.flushResources();
        expect(stale.discarded).toEqual([]);
        const group = fake.batchBodies().at(-1).chats[0];
        expect(group.ops).toEqual([
            { op: "patchMessage", id: "a", set: { disabled: true } },
            { op: "meta", merge: { scriptstate: { $b: "2" } }, mergeUnset: { scriptstate: ["$c"] } },
        ]);
        // The server holds both tabs' changes.
        expect(fake.chat("c", "k")!.data.message[0]).toEqual({
            ...m("a", "A by the other tab", "char"),
            disabled: true,
        });
        expect((fake.chat("c", "k")!.data as any).scriptstate).toEqual({ $a: "1", $b: "2" });
        // Acknowledged as stale: the idle refresh reads the chat whole, and the mirror converges.
        await vi.waitFor(() => expect(chat.findChat(refK)!.message[0].data).toBe("A by the other tab"), {
            timeout: 5000,
        });
        expect(chat.findChat(refK)!.message[0]).toEqual({ ...m("a", "A by the other tab", "char"), disabled: true });
        expect((chat.findChat(refK) as any).scriptstate).toEqual({ $a: "1", $b: "2" });
        expect(chat.idleChatRefreshes()).toEqual([]);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
    });

    it("removes a character another tab deleted, with its chats, and moves the selection home", async () => {
        const { fake, sync, chat, characters, selection } = await boot();
        fake.store.delete(fake.kind("characters"), "c", fake.record("characters", "c")!.revision);
        selection.selectCharacterAt(0);
        await tick();
        chat.setChatMeta(refK, { note: "edit on a deleted character's chat" });
        const result = await sync.flushResources();
        expect(result.discarded.sort()).toEqual(["characters/c", "chats/c/k"]);
        expect(characters()).toEqual([]);
        expect(selection.selectedIndex()).toBe(-1);
        expect(chat.hasChatWork()).toBe(false);
        const before = fake.batchCount();
        await sync.flushResources();
        expect(fake.batchCount()).toBe(before);
    });

    it("learns about chats another tab created when its own create is acknowledged, and keeps saving", async () => {
        const { fake, sync, chat, mirrorIds } = await boot();
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "r",
                baseRevision: null,
                ops: [{ op: "create", chat: { id: "r", name: "R", message: [] } as any }],
            },
        ]);
        chat.createChat("c", { id: "local", name: "L", message: [] } as any);
        await sync.flushResources();
        chat.reorderChats("c", ["local", "k", "j"]);
        chat.setChatMeta(refJ, { note: "must save" });
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(alerts.error).not.toHaveBeenCalled();
        expect(mirrorIds()).toEqual(fake.order("c")!.ids);
        expect(mirrorIds()).toContain("r");
        expect((fake.chat("c", "j")!.data as any).note).toBe("must save");
        // The refresh after the acknowledgement keeps the reorder queued after it (this client's order
        // first, the other tab's chat after), nothing is discarded, no notice.
        expect(fake.order("c")!.ids).toEqual(["local", "k", "j", "r"]);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
        expect(chat.hasChatWork()).toBe(false);
    });

    it("discards and reports a reorder the acknowledgement's refresh cannot rebase (a kept chat with work is gone on the server), then that chat's work", async () => {
        const { fake, sync, chat, mirrorIds } = await boot();
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "r",
                baseRevision: null,
                ops: [{ op: "create", chat: { id: "r", name: "R", message: [] } as any }],
            },
        ]);
        chat.createChat("c", { id: "local", name: "L", message: [] } as any);
        await sync.flushResources();
        // Before the list is read again: another tab deletes `j`, this tab edits it and reorders.
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "j",
                baseRevision: fake.chat("c", "j")!.revision,
                ops: [{ op: "delete" } as any],
            },
        ]);
        chat.setChatMeta(refJ, { note: "edit of a chat gone on the server" });
        chat.reorderChats("c", ["local", "k", "j"]);
        const result = await sync.flushResources();
        // The refresh keeps busy `j`, so the reorder could not be a permutation of the server's list:
        // it is discarded (`chats/c`) with the notice; `j`'s edit then conflicts and is discarded too.
        expect(result.discarded.sort()).toEqual(["chats/c", "chats/c/j"]);
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        expect(alerts.error).not.toHaveBeenCalled();
        // The reorder was never sent; the server's order stands.
        expect(fake.batchBodies().flatMap((batch) => batch.chatOrders ?? [])).toEqual([]);
        expect(fake.order("c")!.ids).toEqual(["k", "local", "r"]);
        expect(mirrorIds()).toEqual(["k", "local", "r"]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("settles a reorder whose answer was lost without a discard report when the retry conflicts", async () => {
        const { fake, sync, chat, mirrorIds } = await boot();
        chat.reorderChats("c", ["j", "k"]);
        fake.dropNextBatchResponse = true;
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        expect(fake.order("c")!.ids).toEqual(["j", "k"]);
        // The resend conflicts on the old order revision; the server already holds the reorder.
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(fake.order("c")!.ids).toEqual(["j", "k"]);
        expect(mirrorIds()).toEqual(["j", "k"]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("reports the unsent work and the queued reorder of a character another tab deleted (the live update), with the notice", async () => {
        const { fake, sync, chat, characters } = await boot();
        const scope = sync.beginMutationScope();
        chat.appendMessage(refK, m("z", "unsent"));
        chat.reorderChats("c", ["j", "k"]);
        fake.store.delete(fake.kind("characters"), "c", fake.record("characters", "c")!.revision);
        sync.noteRemoteChanges({
            resources: [{ kind: "characters", id: "c", revision: null }],
            chats: [],
            chatOrders: [],
        });
        await vi.advanceTimersByTimeAsync(700);
        const result = await sync.flushResources({ scope });
        expect(result.discarded.sort()).toEqual(["chats/c", "chats/c/k"]);
        expect(alerts.normal.mock.calls.map(([value]) => value)).toEqual(["reloaded"]);
        expect(characters()).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("settles a queued chat delete that another tab's deletion of the character fulfils, without a report or notice", async () => {
        const { fake, sync, chat, characters } = await boot();
        const scope = sync.beginMutationScope();
        chat.deleteChat(refJ);
        fake.store.delete(fake.kind("characters"), "c", fake.record("characters", "c")!.revision);
        sync.noteRemoteChanges({
            resources: [{ kind: "characters", id: "c", revision: null }],
            chats: [],
            chatOrders: [],
        });
        await vi.advanceTimersByTimeAsync(700);
        const result = await sync.flushResources({ scope });
        expect(result.discarded).toEqual([]);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
        expect(characters()).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("shows one reload notice when the recovery's chat-list read fails after its discards, and none more on the loss-free retry", async () => {
        const { fake, sync, chat, settings, mirrorIds } = await boot();
        const scope = sync.beginMutationScope();
        settings.ui.theme = "mine";
        fake.set("ui", "main", { ...(fake.record("ui", "main")!.data as object), theme: "theirs" });
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "j",
                baseRevision: fake.chat("c", "j")!.revision,
                ops: [{ op: "delete" } as any],
            },
        ]);
        chat.setChatMeta(refJ, { note: "edit of a chat gone on the server" });
        // The conflict read succeeds; the chat-list read after the discards fails.
        let reads = 0;
        fake.failNext = { status: 500, times: 1, match: (path) => path === "/api/resources/read" && ++reads === 2 };
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 500 });
        expect(reads).toBe(2);
        expect(alerts.normal.mock.calls.map(([value]) => value)).toEqual(["reloaded"]);
        expect(settings.ui.theme).toBe("theirs");
        const result = await sync.flushResources({ scope });
        expect(result.discarded.sort()).toEqual(["chats/c/j", "ui/main"]);
        expect(alerts.normal).toHaveBeenCalledTimes(1);
        expect(mirrorIds()).toEqual(["k"]);
        expect(chat.hasChatWork()).toBe(false);
    });
});

describe("pagehide", () => {
    it("sends pending by-id work with keepalive requests, one per chat, and a page that survives settles its revision so a later current-revision op does not conflict with its own write", async () => {
        const { fake, sync, chat } = await boot();
        // The unload request bypasses `authFetch` (a pre-signed token, `keepalive`): the raw fetch.
        // Listeners of earlier module graphs stay on the shared window; only this graph's epoch counts.
        const keepalive: RequestInit[] = [];
        vi.stubGlobal("fetch", (path: string, init: RequestInit) => {
            if (new Headers(init.headers).get(RESOURCE_EPOCH_HEADER) === fake.store.epoch()) {
                keepalive.push(init);
            }
            return fake.fetch(path, init);
        });
        chat.setMessageText(refK, "a", "unload write");
        chat.setChatMeta(refJ, { note: "j is not held" });
        const batches = fake.batchCount();

        window.dispatchEvent(new Event("pagehide"));
        // The pending by-id work of each existing chat in its own request.
        expect(keepalive).toHaveLength(2);
        expect(keepalive.map((init) => init.keepalive)).toEqual([true, true]);
        expect(new Headers(keepalive[0].headers).get("risu-auth")).toBe("signed-token");
        // Each with its group id, as every group the tab sends.
        expect(JSON.parse(keepalive[0].body as string)).toEqual({
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: expect.any(String),
                    groupId: expect.any(String),
                    ops: [{ op: "setText", id: "a", text: "unload write" }],
                },
            ],
        });
        expect(JSON.parse(keepalive[1].body as string)).toEqual({
            chats: [
                {
                    characterId: "c",
                    chatId: "j",
                    baseRevision: expect.any(String),
                    groupId: expect.any(String),
                    ops: [{ op: "meta", set: { note: "j is not held" }, unset: [] }],
                },
            ],
        });
        expect(JSON.parse(keepalive[0].body as string).chats[0].groupId).not.toBe(
            JSON.parse(keepalive[1].body as string).chats[0].groupId,
        );
        await vi.waitFor(() => expect(fake.texts("c", "k")[0]).toBe("unload write"));
        await vi.waitFor(() => expect((fake.chat("c", "j")!.data as any).note).toBe("j is not held"));

        // The page survived (back-forward cache): the answers settle k and j, and k's later work
        // goes out on the revision the unload write produced.
        chat.setChatMeta(refK, { note: "after the page came back" });
        await vi.waitFor(() => expect(chat.hasChatWork()).toBe(true));
        await sync.flushResources();
        expect((fake.chat("c", "j")!.data as any).note).toBe("j is not held");
        expect((fake.chat("c", "k")!.data as any).note).toBe("after the page came back");
        const groupsSent = fake
            .batchBodies()
            .slice(batches)
            .flatMap((body) => body.chats ?? [])
            .filter((group: any) => group.chatId === "k");
        // The unload request's group, then the note; the text the unload request carried is not sent again.
        expect(groupsSent.map((group: any) => group.ops.map((op: any) => op.op))).toEqual([["setText"], ["meta"]]);

        // A current-revision op (a bulk removal) needs the current revision (a self-conflict would
        // reload the chat with the notice and discard its work).
        chat.removeMessages(refK, ["b", "c"]);
        const flushed = await sync.flushResources();
        expect(flushed.discarded).toEqual([]);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
        expect(fake.texts("c", "k")).toEqual(["unload write"]);
    });

    it("sends nothing without pending work, and resumes a chat's saving when the unload request fails", async () => {
        const { fake, sync, chat } = await boot();
        let calls = 0;
        vi.stubGlobal("fetch", (_path: string, init: RequestInit) => {
            if (new Headers(init.headers).get(RESOURCE_EPOCH_HEADER) === fake.store.epoch()) {
                calls += 1;
            }
            return Promise.reject(new TypeError("Failed to fetch"));
        });
        window.dispatchEvent(new Event("pagehide"));
        expect(calls).toBe(0);

        chat.setMessageText(refK, "a", "unload write");
        window.dispatchEvent(new Event("pagehide"));
        expect(calls).toBe(1);
        // A chat whose unload request is out sends nothing until the answer or the failure.
        chat.setChatMeta(refK, { note: "queued behind the unload request" });
        await vi.waitFor(() => expect(chat.hasChatWork()).toBe(true));
        await sync.flushResources();
        expect((fake.chat("c", "k")!.data as any).note).toBe("queued behind the unload request");
        expect(fake.texts("c", "k")[0]).toBe("unload write");
    });
});

// A row rendered before its chat's first save has no transform context, so the chat module counts
// the first revision it holds for a chat (`chatSaveVersion`, reactive), and `Chat.svelte` renders
// the chat's rows again when that count moves.
describe("a chat's first save (chatSaveVersion)", () => {
    const refN = { chaId: "c", chatId: "n" };

    it("moves once when a new chat's create is acknowledged (a reactive change), never for the boot seed, a later save, or another chat", async () => {
        const { fake, sync, chat } = await boot();
        // Loaded after the boot's module reset, so the probe and the chat module share one Svelte runtime.
        const { createProbe } = await import("./reactiveProbe.svelte");
        const { flushSync } = await import("svelte");
        expect(chat.chatSaveVersion(refK)).toBe(0);
        chat.setChatMeta(refK, { note: "saved again" });
        await sync.flushResources();
        expect(chat.chatSaveVersion(refK)).toBe(0);

        const probe = createProbe(() => chat.chatSaveVersion(refN));
        fake.holdNextBatch = true;
        chat.createChat("c", { id: "n", name: "N", message: [m("x", "X")] } as any);
        const first = sync.flushResources();
        await vi.waitFor(() => expect(fake.releaseBatch).not.toBeNull());
        expect(chat.heldChatRevision(refN)).toBeNull();
        expect(chat.chatSaveVersion(refN)).toBe(0);
        fake.releaseBatch!();
        await first;
        flushSync();
        expect(chat.heldChatRevision(refN)).not.toBeNull();
        expect(probe.seen).toEqual([0, 1]);

        chat.setMessageText(refN, "x", "Y");
        chat.setChatMeta(refK, { note: "and again" });
        await sync.flushResources();
        flushSync();
        expect(fake.texts("c", "n")).toEqual(["Y"]);
        expect(probe.seen).toEqual([0, 1]);
        expect(chat.chatSaveVersion(refK)).toBe(0);
        expect(chat.chatSaveVersion({ chaId: "c", chatId: "j" })).toBe(0);
        probe.dispose();
    });

    it("moves once for a create whose answer was lost, when the next flush recognizes it as landed", async () => {
        const { fake, sync, chat } = await boot();
        fake.dropNextBatchResponse = true;
        chat.createChat("c", { id: "n", name: "N", message: [m("x", "X")] } as any);
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        expect(fake.chat("c", "n")).not.toBeNull();
        expect(chat.chatSaveVersion(refN)).toBe(0);
        chat.setMessageText(refN, "x", "after the lost answer");
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.texts("c", "n")).toEqual(["after the lost answer"]);
        expect(chat.chatSaveVersion(refN)).toBe(1);
        chat.setMessageText(refN, "x", "later");
        await sync.flushResources();
        expect(chat.chatSaveVersion(refN)).toBe(1);
    });
});

// A by-id edit of a message another tab removed is reported `missing` per op while the rest of its
// group commits (no discard, no notice; the idle read drops the message from the mirror), and an
// append after a removed anchor is re-anchored to the end after the read-back instead of discarding
// the chat's work.
describe("missing targets and gone anchors", () => {
    const texts = (chat: ChatModule, ref = refK) => chat.findChat(ref)!.message.map((message) => message.data);
    /** Another tab removes `ids` from `k` on the current revision. */
    const removeElsewhere = (fake: StoreBackedServer, ids: string[]) =>
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [{ op: "remove", ids }],
            },
        ]);
    /** The groups of `k` the server received, in order (as sent). */
    const sentGroups = (fake: StoreBackedServer) =>
        fake
            .batchBodies()
            .flatMap((body) => body.chats ?? [])
            .filter((group: any) => group.chatId === "k");
    /** The groups of `k` the server received, in order (their ops). */
    const sentOps = (fake: StoreBackedServer) => sentGroups(fake).map((group: any) => group.ops);

    it("saves the append of a group whose edit names a message another tab removed, with no discard or notice, and the idle read removes the message from the mirror", async () => {
        const { fake, sync, chat } = await boot();
        removeElsewhere(fake, ["b"]);
        chat.setMessageText(refK, "b", "edit of a removed message");
        chat.appendMessage(refK, m("d", "D"));
        expect(texts(chat)).toEqual(["A", "edit of a removed message", "C", "D"]);
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(sentOps(fake)).toEqual([
            [
                { op: "setText", id: "b", text: "edit of a removed message" },
                { op: "append", messages: [m("d", "D")], anchor: { end: true } },
            ],
        ]);
        expect(fake.texts("c", "k")).toEqual(["A", "C", "D"]);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
        expect(alerts.error).not.toHaveBeenCalled();
        // Acknowledged with `b` missing: the chat is stale, and the idle read drops `b`.
        await vi.waitFor(() => expect(texts(chat)).toEqual(["A", "C", "D"]), { timeout: 5000 });
        expect(chat.idleChatRefreshes()).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
        expect(chat.chatDiscardsSince(0)).toEqual([]);
    });

    it("re-anchors an append after a message another tab removed to the end, keeps a later append anchored on it, and retries with no discard or notice", async () => {
        const { fake, sync, chat } = await boot();
        removeElsewhere(fake, ["b"]);
        chat.appendMessage(refK, m("d", "D"), { anchor: { after: "b" } });
        chat.appendMessage(refK, m("e", "E"), { anchor: { after: "d" } });
        expect(texts(chat)).toEqual(["A", "B", "D", "E", "C"]);
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        // The refused group, then the retry: `d` at the end, `e` still after `d`.
        expect(sentOps(fake).map((ops) => ops.map((op: any) => op.anchor))).toEqual([
            [{ after: "b" }, { after: "d" }],
            [{ end: true }, { after: "d" }],
        ]);
        expect(fake.texts("c", "k")).toEqual(["A", "C", "D", "E"]);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
        expect(alerts.error).not.toHaveBeenCalled();
        expect(chat.chatDiscardsSince(0)).toEqual([]);
        // The idle read puts the mirror in the server's order.
        await vi.waitFor(() => expect(texts(chat)).toEqual(["A", "C", "D", "E"]), { timeout: 5000 });
        expect(chat.idleChatRefreshes()).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("re-anchors the appends queued during the conflict's read-back as well, in order, and sends them after the repaired group in their own group", async () => {
        const { fake, sync, chat } = await boot();
        removeElsewhere(fake, ["b"]);
        chat.appendMessage(refK, m("d", "D"), { anchor: { after: "b" } });
        let queued = false;
        fake.failNext = {
            status: 500,
            times: 1,
            match: (path) => {
                if (path === "/api/resources/read" && !queued) {
                    // While the server copy is read back: another append after the gone anchor, and
                    // one after the message the first append inserts.
                    queued = true;
                    chat.appendMessage(refK, m("e", "E"), { anchor: { after: "b" } });
                    chat.appendMessage(refK, m("f", "F"), { anchor: { after: "e" } });
                }
                return false;
            },
        };
        const result = await sync.flushResources();
        fake.failNext = null;
        expect(queued).toBe(true);
        expect(result.discarded).toEqual([]);
        // The refused group, then its repair alone as the chat's resend (a new group id, on the same
        // base); the appends queued during the read-back were re-anchored too and wait behind it.
        const anchors = () => sentOps(fake).map((ops) => ops.map((op: any) => [op.messages[0].chatId, op.anchor]));
        expect(anchors().slice(0, 2)).toEqual([[["d", { after: "b" }]], [["d", { end: true }]]]);
        const [refused, repaired] = sentGroups(fake);
        expect(repaired.groupId).not.toBe(refused.groupId);
        expect(repaired.retry).toBeUndefined();
        expect(repaired.baseRevision).toBe(refused.baseRevision);
        expect(fake.texts("c", "k")).toEqual(["A", "C", "D"]);
        // The flush captured its obligations before those appends were queued: the next one sends
        // them, in order, in their own group.
        const later = await sync.flushResources();
        expect(later.discarded).toEqual([]);
        expect(anchors()).toEqual([
            [["d", { after: "b" }]],
            [["d", { end: true }]],
            [
                ["e", { end: true }],
                ["f", { after: "e" }],
            ],
        ]);
        expect(fake.texts("c", "k")).toEqual(["A", "C", "D", "E", "F"]);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
        expect(chat.chatDiscardsSince(0)).toEqual([]);
        await vi.waitFor(() => expect(texts(chat)).toEqual(["A", "C", "D", "E", "F"]), { timeout: 5000 });
        expect(chat.hasChatWork()).toBe(false);
    });

    it("repairs the refused append even when the work queued meanwhile needs the current revision (a bulk removal): that work conflicts on its own later, and only it is discarded with the notice", async () => {
        const { fake, sync, chat } = await boot();
        removeElsewhere(fake, ["b"]);
        chat.appendMessage(refK, m("d", "D"), { anchor: { after: "b" } });
        let queued = false;
        fake.failNext = {
            status: 500,
            times: 1,
            match: (path) => {
                if (path === "/api/resources/read" && !queued) {
                    queued = true;
                    chat.removeMessages(refK, ["a", "c"]);
                }
                return false;
            },
        };
        const result = await sync.flushResources();
        fake.failNext = null;
        expect(queued).toBe(true);
        // The repaired append is resent alone and lands; nothing is discarded by it.
        expect(result.discarded).toEqual([]);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
        expect(
            sentOps(fake)
                .slice(0, 2)
                .map((ops) => ops.map((op: any) => op.op)),
        ).toEqual([["append"], ["append"]]);
        expect(fake.texts("c", "k")).toEqual(["A", "C", "D"]);
        // The removal goes out in its own group on the revision this tab holds, which is not the
        // current one (the repair's answer was stale): it conflicts, the chat is replaced by the
        // server copy, and only the removal is discarded.
        const later = await sync.flushResources();
        expect(later.discarded).toEqual(["chats/c/k"]);
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        expect(sentOps(fake)).toHaveLength(3);
        expect(sentOps(fake)[2]).toEqual([{ op: "remove", ids: ["a", "c"] }]);
        expect(fake.texts("c", "k")).toEqual(["A", "C", "D"]);
        expect(texts(chat)).toEqual(["A", "C", "D"]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("repairs a gone anchor once: a retry that conflicts for another reason (an existing id with other content) takes the ordinary recovery", async () => {
        const { fake, sync, chat } = await boot();
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: fake.chat("c", "k")!.revision,
                ops: [
                    { op: "remove", ids: ["b"] },
                    { op: "append", messages: [m("d", "theirs")], anchor: { end: true } },
                ],
            },
        ]);
        chat.appendMessage(refK, m("d", "mine"), { anchor: { after: "b" } });
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["chats/c/k"]);
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        expect(sentOps(fake).map((ops) => ops.map((op: any) => op.anchor))).toEqual([
            [{ after: "b" }],
            [{ end: true }],
        ]);
        expect(fake.texts("c", "k")).toEqual(["A", "C", "theirs"]);
        expect(texts(chat)).toEqual(["A", "C", "theirs"]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("takes the ordinary recovery when the chat was replaced by another of the same id meanwhile", async () => {
        const { fake, sync, chat } = await boot();
        const revision = fake.chat("c", "k")!.revision;
        fake.chatBatch([{ characterId: "c", chatId: "k", baseRevision: revision, ops: [{ op: "delete" }] }]);
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "k",
                baseRevision: null,
                ops: [{ op: "create", chat: { id: "k", name: "K2", message: [m("a", "A"), m("c", "C")] } as any }],
            },
        ]);
        chat.appendMessage(refK, m("d", "D"), { anchor: { after: "b" } });
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["chats/c/k"]);
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        expect(sentOps(fake)).toHaveLength(1);
        expect(fake.texts("c", "k")).toEqual(["A", "C"]);
        expect(texts(chat)).toEqual(["A", "C"]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("re-anchors the append of a chat a server job streams into instead of deferring it, keeping the streamed text", async () => {
        const { fake, sync, chat } = await boot();
        chat.applyServerGeneration(refK, { jobId: "J", messageId: "a", generationId: "g", text: "streamed", seq: 0 });
        removeElsewhere(fake, ["b"]);
        chat.appendMessage(refK, m("d", "D"), { anchor: { after: "b" } });
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(sentOps(fake).map((ops) => ops.map((op: any) => op.anchor))).toEqual([
            [{ after: "b" }],
            [{ end: true }],
        ]);
        expect(fake.texts("c", "k")).toEqual(["A", "C", "D"]);
        // The chat was not replaced: the streamed text and the local order stay until the job ends.
        expect(texts(chat)).toEqual(["streamed", "B", "D", "C"]);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
        expect(chat.chatDiscardsSince(0)).toEqual([]);
        chat.endServerJob("J");
        expect((await sync.flushResources()).discarded).toEqual([]);
        // The job's end leaves the chat for the idle read in the next cycle.
        await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
        expect(texts(chat)).toEqual(["A", "C", "D"]);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
        expect(chat.hasChatWork()).toBe(false);
    });

    it("settles a missing target of the unload request as a no-op, and the page that survives removes the message with the idle read", async () => {
        const { fake, sync, chat } = await boot();
        const keepalive: RequestInit[] = [];
        vi.stubGlobal("fetch", (path: string, init: RequestInit) => {
            if (new Headers(init.headers).get(RESOURCE_EPOCH_HEADER) === fake.store.epoch()) {
                keepalive.push(init);
            }
            return fake.fetch(path, init);
        });
        removeElsewhere(fake, ["b"]);
        chat.setMessageText(refK, "b", "unload write of a removed message");
        chat.setChatMeta(refK, { note: "with it" });
        window.dispatchEvent(new Event("pagehide"));
        expect(keepalive).toHaveLength(1);
        await vi.waitFor(() => expect((fake.chat("c", "k")!.data as any).note).toBe("with it"));
        expect(fake.texts("c", "k")).toEqual(["A", "C"]);
        // The page survived: the answer settles the group, nothing is discarded, and the chat is read.
        expect((await sync.flushResources()).discarded).toEqual([]);
        await vi.waitFor(() => expect(texts(chat)).toEqual(["A", "C"]), { timeout: 5000 });
        expect((chat.findChat(refK) as any).note).toBe("with it");
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
        expect(chat.chatDiscardsSince(0)).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
    });
});

describe("group idempotency ids", () => {
    /** The groups of `chatId` the server received, in order (as sent). */
    const groupsOf = (fake: StoreBackedServer, chatId = "k") =>
        fake
            .batchBodies()
            .flatMap((body) => body.chats ?? [])
            .filter((group: any) => group.chatId === chatId);
    const texts = (chat: ChatModule, ref = refK) => chat.findChat(ref)!.message.map((message) => message.data);
    const note = (value: string) => ({ op: "meta", set: { note: value }, unset: [] });
    /** Another tab's write on the current revision of `k`, with its own group id. */
    const elsewhere = (fake: StoreBackedServer, ops: any[], groupId: string) =>
        fake.chatBatch([{ characterId: "c", chatId: "k", baseRevision: fake.chat("c", "k")!.revision, ops, groupId }]);

    it("resends a lost group alone, exactly as sent with its id and retry, answered as the duplicate it is; the work typed meanwhile follows in its own group with a new id", async () => {
        const { fake, sync, chat } = await boot();
        chat.appendMessage(refK, m("d", "D"));
        chat.setMessageText(refK, "d", "edited");
        fake.dropNextBatchResponse = true;
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        expect(fake.texts("c", "k")).toEqual(["A", "B", "C", "edited"]);
        const [lost] = groupsOf(fake);
        expect(lost.groupId).toEqual(expect.any(String));
        expect(lost.retry).toBeUndefined();
        const landed = fake.chat("c", "k")!.revision;
        chat.setChatMeta(refK, { note: "typed during the flight" });
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        const sent = groupsOf(fake);
        expect(sent).toHaveLength(3);
        expect(sent[1]).toEqual({ ...lost, retry: true });
        // On the revision the duplicate answer reported (the lost group's), with a fresh id.
        expect(sent[2]).toEqual({
            characterId: "c",
            chatId: "k",
            baseRevision: landed,
            groupId: expect.any(String),
            ops: [note("typed during the flight")],
        });
        expect(sent[2].groupId).not.toBe(lost.groupId);
        expect(fake.texts("c", "k")).toEqual(["A", "B", "C", "edited"]);
        expect((fake.chat("c", "k")!.data as any).note).toBe("typed during the flight");
        expect(texts(chat)).toEqual(["A", "B", "C", "edited"]);
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(alerts.error).not.toHaveBeenCalled();
        expect(chat.chatDiscardsSince(0)).toEqual([]);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("does not revert another tab's later edit with a replayed setText", async () => {
        const { fake, sync, chat } = await boot();
        chat.setMessageText(refK, "a", "mine");
        fake.dropNextBatchResponse = true;
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        elsewhere(fake, [{ op: "setText", id: "a", text: "theirs" }], "other");
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        expect(fake.texts("c", "k")[0]).toBe("theirs");
        expect(groupsOf(fake).map((group: any) => [group.ops[0].text, group.retry])).toEqual([
            ["mine", undefined],
            ["mine", true],
        ]);
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(chat.hasChatWork()).toBe(false);
    });

    it("keeps the same id, base, and ops over repeated losses", async () => {
        const { fake, sync, chat } = await boot();
        chat.setMessageText(refK, "a", "mine");
        for (let attempt = 0; attempt < 2; attempt += 1) {
            fake.dropNextBatchResponse = true;
            await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        }
        expect((await sync.flushResources()).discarded).toEqual([]);
        const sent = groupsOf(fake);
        expect(sent.map((group: any) => group.retry)).toEqual([undefined, true, true]);
        expect(
            new Set(sent.map((group: any) => JSON.stringify([group.groupId, group.baseRevision, group.ops]))).size,
        ).toBe(1);
        expect(fake.texts("c", "k")[0]).toBe("mine");
        // Written once: the revision moved by one.
        expect(fake.chat("c", "k")!.revision).toBe(
            sent[0].baseRevision.replace(/:\d+$/, (end: string) => `:${Number(end.slice(1)) + 1}`),
        );
        expect(chat.hasChatWork()).toBe(false);
    });

    it("keeps a lost group's doubt through a failed recovery read and through another chat's conflict that rolls the batch back", async () => {
        const { fake, sync, chat, mirrorIds } = await boot();
        chat.setMessageText(refK, "a", "mine");
        fake.dropNextBatchResponse = true;
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        // Another tab deletes `j`; this tab edits it: its group conflicts, and the batch (k's resend
        // with it) rolls back. The conflict's read fails the first time.
        fake.chatBatch([
            { characterId: "c", chatId: "j", baseRevision: fake.chat("c", "j")!.revision, ops: [{ op: "delete" }] },
        ]);
        chat.setChatMeta(refJ, { note: "edit of a chat gone on the server" });
        fake.failNext = { status: 500, times: 1, match: (path) => path === "/api/resources/read" };
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 500 });
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["chats/c/j"]);
        expect(mirrorIds()).toEqual(["k"]);
        const sent = groupsOf(fake);
        // The first attempt, the one rolled back with the failed read, the one rolled back with j's
        // conflict, and the one answered: the same group every time, in doubt after the loss.
        expect(sent.map((group: any) => group.retry)).toEqual([undefined, true, true, true]);
        expect(
            new Set(sent.map((group: any) => JSON.stringify([group.groupId, group.baseRevision, group.ops]))).size,
        ).toBe(1);
        expect(fake.texts("c", "k")[0]).toBe("mine");
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        expect(chat.hasChatWork()).toBe(false);
    });

    it("resends a pagehide request the page saw fail after the server applied it, answered as a duplicate, and newer work follows on its revision", async () => {
        const { fake, sync, chat } = await boot();
        vi.stubGlobal("fetch", (path: string, init: RequestInit) => fake.fetch(path, init));
        chat.setMessageText(refK, "a", "unload write");
        fake.dropNextBatchResponse = true;
        window.dispatchEvent(new Event("pagehide"));
        await vi.waitFor(() => expect(fake.texts("c", "k")[0]).toBe("unload write"));
        // The failure puts the group back as the chat's resend.
        await vi.waitFor(() => expect(chat.hasChatWork()).toBe(true));
        chat.setChatMeta(refK, { note: "after the page came back" });
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        const sent = groupsOf(fake);
        expect(sent).toHaveLength(3);
        expect(sent[0].ops).toEqual([{ op: "setText", id: "a", text: "unload write" }]);
        expect(sent[1]).toEqual({ ...sent[0], retry: true });
        expect(sent[2].ops).toEqual([note("after the page came back")]);
        expect(sent[2].groupId).not.toBe(sent[0].groupId);
        expect((fake.chat("c", "k")!.data as any).note).toBe("after the page came back");
        // The tab holds the revision its writes produced: a current-revision op does not conflict.
        chat.removeMessages(refK, ["b", "c"]);
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(fake.texts("c", "k")).toEqual(["unload write"]);
    });

    it("settles a lost create recognized by its content together with the rest of its group, resending none of it", async () => {
        const { fake, sync, chat } = await boot();
        const refN = { chaId: "c", chatId: "n" };
        chat.createChat("c", { id: "n", name: "N", message: [m("x", "X")] } as any);
        const sent = chat.takeChatWork(new Set());
        const [group] = sent.groups;
        expect(group.ops.map((op) => op.op)).toEqual(["create"]);
        // A create group that carries more ops (no producer builds one today): they land with it.
        group.ops.push({ op: "setText", id: "x", text: "X" });
        // Landed, but not remembered by its id: the resend meets the ordinary checks and conflicts.
        fake.chatBatch(
            chat.chatWorkBody(sent).chats.map((text) => {
                const { groupId: _groupId, ...landed } = JSON.parse(text);
                return landed;
            }),
        );
        const landed = fake.chat("c", "n")!.revision;
        chat.requeueChatWork(sent, { lost: true });
        const result = await sync.flushResources();
        expect(result.discarded).toEqual([]);
        // The server got the resend alone and applied nothing more: the setText is not sent again.
        const groups = groupsOf(fake, "n");
        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({ groupId: group.groupId, retry: true, ops: group.ops });
        expect(fake.chat("c", "n")!.revision).toBe(landed);
        expect(fake.texts("c", "n")).toEqual(["X"]);
        expect(chat.chatSaveVersion(refN)).toBe(1);
        expect(chat.hasChatWork()).toBe(false);
        expect(alerts.normal).not.toHaveBeenCalled();
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("takes the ordinary recovery, with the notice, for a retry whose id the chat no longer remembers (expired), instead of repairing its anchor and applying it again", async () => {
        const { fake, sync, chat } = await boot();
        chat.appendMessage(refK, m("d", "D"), { anchor: { after: "b" } });
        chat.setChatMeta(refK, { note: "old" });
        fake.dropNextBatchResponse = true;
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        expect(fake.texts("c", "k")).toEqual(["A", "B", "D", "C"]);
        // Another tab removes the anchor and changes the note, then writes enough identified groups
        // for the chat to forget this tab's id.
        elsewhere(fake, [{ op: "remove", ids: ["b"] }, note("theirs")], "other-0");
        for (let index = 1; index <= 100; index += 1) {
            elsewhere(fake, [{ op: "setText", id: "a", text: `a${index}` }], `other-${index}`);
        }
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["chats/c/k"]);
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        const sent = groupsOf(fake);
        expect(sent).toHaveLength(2);
        expect(sent[1]).toEqual({ ...sent[0], retry: true });
        // Neither re-applied nor repaired under a new id: the server keeps the other tab's note, and
        // the mirror shows the server copy.
        expect((fake.chat("c", "k")!.data as any).note).toBe("theirs");
        expect(fake.texts("c", "k")).toEqual(["a100", "D", "C"]);
        expect(texts(chat)).toEqual(["a100", "D", "C"]);
        expect((chat.findChat(refK) as any).note).toBe("theirs");
        expect(chat.hasChatWork()).toBe(false);
    });
});

// A kept chat (quarantined, deleted here with a delete that cannot run) that an authoritative chat
// list shows gone on the server keeps its draft and held revision but leaves the reorders and
// create indices (`absentChats`), so the server accepts them as permutations.
describe("kept absent chats leave the order", () => {
    /** Boots with a third chat `r` the other tab created: the server order is `k, j, r`. */
    const bootWithR = () =>
        boot((fake) =>
            fake.chatBatch([
                {
                    characterId: "c",
                    chatId: "r",
                    baseRevision: null,
                    ops: [{ op: "create", chat: { id: "r", name: "R", message: [] } as any }],
                },
            ]),
        );
    /** The other tab deletes `j` on its current revision. */
    const deleteElsewhere = (fake: StoreBackedServer) =>
        fake.chatBatch([
            { characterId: "c", chatId: "j", baseRevision: fake.chat("c", "j")!.revision, ops: [{ op: "delete" }] },
        ]);
    /** The live update of a change the other tab made to `j` and the order (the socket's frames). */
    const announce = (sync: Sync, fake: StoreBackedServer) =>
        sync.noteRemoteChanges({
            resources: [],
            chats: [{ characterId: "c", id: "j", revision: fake.chat("c", "j")?.revision ?? null }],
            chatOrders: [{ characterId: "c", revision: fake.order("c")!.revision }],
        });
    /** Every reorder the server received, in order (as sent). */
    const sentOrders = (fake: StoreBackedServer) => fake.batchBodies().flatMap((body) => body.chatOrders ?? []);
    const reads = (fake: StoreBackedServer) =>
        fake.requests.filter((request) => request.path === "/api/resources/read");
    /** Quarantines `j` (a meta patch the server refuses); returns a scope begun before the refusal. */
    async function quarantineJ(sync: Sync, chat: ChatModule) {
        const scope = sync.beginMutationScope();
        chat.setChatMeta(refJ, { fmIndex: "not a number" as any });
        const refused = await sync.flushResources({ scope });
        expect(refused.discarded).toEqual(["chats/c/j"]);
        expect(alerts.error).toHaveBeenCalledTimes(1);
        expect(alerts.error.mock.calls[0][0]).toMatch(/chat j could not be saved/);
        return scope;
    }

    it("leaves a quarantined chat another tab deleted out of the reorders and create indices once the live update lists the deletion, keeps its draft, and keeps reporting it; a list that places it again lets it back in", async () => {
        const { fake, sync, chat, mirrorIds } = await bootWithR();
        expect(mirrorIds()).toEqual(["k", "j", "r"]);
        const scope = await quarantineJ(sync, chat);
        deleteElsewhere(fake);
        const afterDelete = fake.order("c")!.revision;
        announce(sync, fake);
        await vi.advanceTimersByTimeAsync(700);
        // The list (`applyRemoteCollection`) keeps the quarantined draft after the server's chats.
        expect(mirrorIds()).toEqual(["k", "r", "j"]);
        expect((chat.findChat(refJ) as any).fmIndex).toBe("not a number");
        expect(fake.chat("c", "j")).toBeNull();

        chat.reorderChats("c", ["r", "k", "j"]);
        const first = await sync.flushResources({ scope });
        // The reorder lands without `j`, on the order revision the deletion produced; the quarantine
        // is still the only report, and nothing was reloaded.
        expect(first.discarded).toEqual(["chats/c/j"]);
        expect(sentOrders(fake)).toEqual([{ characterId: "c", baseRevision: afterDelete, ids: ["r", "k"] }]);
        expect(fake.order("c")!.ids).toEqual(["r", "k"]);
        expect(mirrorIds()).toEqual(["r", "k", "j"]);
        expect(alerts.error).toHaveBeenCalledTimes(1);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");

        // A second reorder, on the revision the first produced.
        const afterFirst = fake.order("c")!.revision;
        chat.reorderChats("c", ["k", "j", "r"]);
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(sentOrders(fake).at(-1)).toEqual({ characterId: "c", baseRevision: afterFirst, ids: ["k", "r"] });
        expect(fake.order("c")!.ids).toEqual(["k", "r"]);

        // A create placed after the absent chat counts only the chats the server holds before it, and
        // its acknowledgement's order (without `j`) is adopted without a list refresh.
        const readsBefore = reads(fake).length;
        chat.createChat("c", { id: "n", name: "N", message: [] } as any, { index: 2 });
        expect(mirrorIds()).toEqual(["k", "j", "n", "r"]);
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(fake.batchBodies().at(-1).chats[0].ops[0].index).toBe(1);
        expect(fake.order("c")!.ids).toEqual(["k", "n", "r"]);
        expect(reads(fake).length).toBe(readsBefore);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");

        // The other tab creates `j` again under its id: the list places it, so the next reorder
        // includes it (the quarantined draft keeps its copy).
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "j",
                baseRevision: null,
                ops: [{ op: "create", chat: { id: "j", name: "J again", message: [] } as any }],
            },
        ]);
        expect(fake.order("c")!.ids).toEqual(["k", "n", "r", "j"]);
        announce(sync, fake);
        await vi.advanceTimersByTimeAsync(700);
        expect(mirrorIds()).toEqual(["k", "n", "r", "j"]);
        expect((chat.findChat(refJ) as any).fmIndex).toBe("not a number");
        const afterRecreate = fake.order("c")!.revision;
        chat.reorderChats("c", ["j", "k", "n", "r"]);
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(sentOrders(fake).at(-1)).toEqual({
            characterId: "c",
            baseRevision: afterRecreate,
            ids: ["j", "k", "n", "r"],
        });
        expect(fake.order("c")!.ids).toEqual(["j", "k", "n", "r"]);
        expect(alerts.error).toHaveBeenCalledTimes(1);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
        expect(chat.hasChatWork()).toBe(false);
    });

    it("sends a reorder queued before the deletion is known with the quarantined chat, which conflicts on the order revision; the recovery's list marks it, and the next reorder lands without it", async () => {
        const { fake, sync, chat, mirrorIds } = await bootWithR();
        const scope = await quarantineJ(sync, chat);
        deleteElsewhere(fake);
        const afterDelete = fake.order("c")!.revision;
        // Not told yet (the live update is not delivered here): the reorder goes out with `j`.
        chat.reorderChats("c", ["r", "k", "j"]);
        const first = await sync.flushResources({ scope });
        // The sent reorder conflicts (409 on the order revision, never the permutation 400) and is
        // settled with the notice but without a discard report; `acceptRemoteCollection` keeps the
        // quarantined draft after the server's chats.
        expect(first.discarded).toEqual(["chats/c/j"]);
        expect(sentOrders(fake)).toEqual([
            { characterId: "c", baseRevision: expect.any(String), ids: ["r", "k", "j"] },
        ]);
        expect(sentOrders(fake)[0].baseRevision).not.toBe(afterDelete);
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        expect(alerts.error).toHaveBeenCalledTimes(1);
        expect(fake.order("c")!.ids).toEqual(["k", "r"]);
        expect(fake.order("c")!.revision).toBe(afterDelete);
        expect(mirrorIds()).toEqual(["k", "r", "j"]);
        expect((chat.findChat(refJ) as any).fmIndex).toBe("not a number");

        chat.reorderChats("c", ["r", "k", "j"]);
        const second = await sync.flushResources({ scope });
        expect(second.discarded).toEqual(["chats/c/j"]);
        expect(sentOrders(fake).at(-1)).toEqual({ characterId: "c", baseRevision: afterDelete, ids: ["r", "k"] });
        expect(fake.order("c")!.ids).toEqual(["r", "k"]);
        expect(mirrorIds()).toEqual(["r", "k", "j"]);
        // No order quarantine (`chatOrderRefused`): the one alert is the chat's.
        expect(alerts.error).toHaveBeenCalledTimes(1);
        expect(chat.hasChatWork()).toBe(false);
    });

    it("no longer holds a reorder for the delete of a quarantined chat deleted here once the list shows another tab deleted it", async () => {
        const { fake, sync, chat, mirrorIds } = await bootWithR();
        await quarantineJ(sync, chat);
        // Deleted here too: the delete can never go out (quarantined), and `j` stays held.
        chat.deleteChat(refJ);
        expect(mirrorIds()).toEqual(["k", "r"]);
        expect(chat.heldChatRevision(refJ)).not.toBeNull();
        deleteElsewhere(fake);
        const afterDelete = fake.order("c")!.revision;
        announce(sync, fake);
        await vi.advanceTimersByTimeAsync(700);
        chat.reorderChats("c", ["r", "k"]);
        // The quarantined chat's unsendable delete stays an open obligation of this flush; the
        // reorder itself no longer waits for it.
        await expect(sync.flushResources()).rejects.toThrow(/Could not save every change/);
        expect(sentOrders(fake)).toEqual([{ characterId: "c", baseRevision: afterDelete, ids: ["r", "k"] }]);
        expect(fake.order("c")!.ids).toEqual(["r", "k"]);
        expect(mirrorIds()).toEqual(["r", "k"]);
        expect(alerts.error).toHaveBeenCalledTimes(1);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
    });

    it("keeps the absence mark when a replayed create's answer (no order result) arrives after an overlapping list read saw the chat deleted, reads the list again, and reorders without it", async () => {
        const { fake, sync, chat, mirrorIds } = await bootWithR();
        // Deleted here, then created again under its id while the old revision is still held.
        chat.deleteChat(refJ);
        chat.createChat("c", { id: "j", name: "J again", message: [] } as any);
        expect(mirrorIds()).toEqual(["k", "r", "j"]);
        const oldRevision = chat.heldChatRevision(refJ);
        expect(oldRevision).not.toBeNull();
        // The other tab deletes the old `j` first, so this tab's create lands; its answer is lost.
        deleteElsewhere(fake);
        fake.dropNextBatchResponse = true;
        await expect(sync.flushResources()).rejects.toMatchObject({ status: 0 });
        expect(fake.chat("c", "j")!.data.name).toBe("J again");
        expect(fake.order("c")!.ids).toEqual(["k", "r", "j"]);
        expect(chat.heldChatRevision(refJ)).toBe(oldRevision);
        const beforeReplay = fake.order("c")!.revision;

        // The resend is answered as a duplicate while `j` exists (no order result); its answer is
        // held in transit ...
        fake.holdNextBatchResponse = true;
        const flight = sync.flushResources();
        await vi.waitFor(() => expect(fake.releaseBatchResponse).not.toBeNull());
        expect(fake.batchBodies().at(-1).chats).toEqual([expect.objectContaining({ chatId: "j", retry: true })]);
        expect(fake.order("c")!.revision).toBe(beforeReplay);
        // ... while the other tab deletes the recreated `j`, and an on-demand summary read (a load
        // of a chat the list does not have) applies that list: `j` is kept (in flight) and marked.
        deleteElsewhere(fake);
        const afterDelete = fake.order("c")!.revision;
        expect(afterDelete).not.toBe(beforeReplay);
        expect(await chat.loadChat({ chaId: "c", chatId: "not-a-chat" })).toBeUndefined();
        expect(chat.heldOrderRevision("c")).toBe(afterDelete);
        expect(mirrorIds()).toEqual(["k", "r", "j"]);
        fake.releaseBatchResponse!();
        expect((await flight).discarded).toEqual([]);
        // The replay's answer holds the create's revision but carries no order listing `j`: the
        // adopted order revision stays the deletion's.
        expect(chat.heldChatRevision(refJ)).not.toBe(oldRevision);
        expect(chat.heldOrderRevision("c")).toBe(afterDelete);
        expect(fake.order("c")!.revision).toBe(afterDelete);

        // The mark stays: the list is read again before the reorder, which leaves `j` out (the
        // refresh removes the idle chat the server no longer has) and lands, never refused.
        const readsBefore = reads(fake).length;
        chat.reorderChats("c", ["r", "k", "j"]);
        expect((await sync.flushResources()).discarded).toEqual([]);
        expect(reads(fake).length).toBe(readsBefore + 1);
        expect(reads(fake).at(-1)!.body.chatSummaryCollections).toEqual(["c"]);
        expect(sentOrders(fake)).toEqual([{ characterId: "c", baseRevision: afterDelete, ids: ["r", "k"] }]);
        expect(fake.order("c")!.ids).toEqual(["r", "k"]);
        expect(mirrorIds()).toEqual(["r", "k"]);
        expect(alerts.error).not.toHaveBeenCalled();
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
        expect(chat.hasChatWork()).toBe(false);
    });
});

// This tab's deletion of a character settles its chats' work when the deletion is collected
// (`settleCharacterDelete`), but keeps the resends whose group may have landed (`parkedResends`)
// until the server confirms the character gone. A deletion that fails and a re-add of the id then
// reconcile those chats like any the client knows: a landed create is deleted or replaced behind
// its replay instead of being forgotten (before the fix it survived on the server, or a reused id
// conflicted), and a lost edit's replay keeps the replacement's replace off a stale base.
describe("a deletion that fails after a lost chat group keeps the group for a same-id re-add", () => {
    type CharacterStoreModule = typeof import("../characterStore.svelte");
    const refX = { chaId: "c", chatId: "x" };
    const batchPath = (path: string) => path === "/api/resources/batch";
    const chatOf = (id: string, text: string) =>
        ({ id, name: id.toUpperCase(), note: "", localLore: [], message: [m(`${id}-message`, text)] }) as any;
    /** The replacement: the same id, a new name, the chats given. */
    const replacement = (chats: any[]) => ({ chaId: "c", name: "Replacement", chats });
    /** Every chat group the server received, in order (as sent). */
    const groups = (fake: StoreBackedServer) => fake.batchBodies().flatMap((body) => body.chats ?? []);
    /** The op kinds of each group of `chatId`, in order. */
    const opsOf = (fake: StoreBackedServer, chatId: string) =>
        groups(fake)
            .filter((group: any) => group.chatId === chatId)
            .map((group: any) => group.ops.map((op: any) => op.op));
    /** What the server holds for `c`: the order's ids and each stored chat's first message. */
    const stored = (fake: StoreBackedServer) => {
        const collection = fake.store.readRefs([], { chatCollections: ["c"] }).chatCollections[0];
        return {
            ids: collection.order?.ids,
            texts: Object.fromEntries(collection.chats.map((entry: any) => [entry.id, entry.data.message[0]?.data])),
        };
    };
    /** Boots with the character module (the list changes go through it). */
    async function bootWithCharacters() {
        const h = await boot();
        const characterStore: CharacterStoreModule = await import("../characterStore.svelte");
        return { ...h, characterStore };
    }
    /** Creates `x` and loses the answer of its create (the server applied it); returns the group as sent. */
    async function loseCreateOfX(h: { fake: StoreBackedServer; sync: Sync; chat: ChatModule }) {
        h.chat.createChat("c", chatOf("x", "Lost create"));
        h.fake.dropNextBatchResponse = true;
        await expect(h.sync.flushResources()).rejects.toMatchObject({ status: 0 });
        expect(h.fake.texts("c", "x")).toEqual(["Lost create"]);
        const lost = groups(h.fake).find((group: any) => group.chatId === "x");
        expect(lost.ops.map((op: any) => op.op)).toEqual(["create"]);
        h.fake.requests.length = 0;
        return lost;
    }
    /** Removes `c`; the server fails its deletion (a 500), so the record and its chats stay. */
    async function failDeletion(h: { fake: StoreBackedServer; sync: Sync; characterStore: CharacterStoreModule }) {
        h.fake.failNext = { status: 500, times: 1, match: batchPath };
        expect(h.characterStore.removeCharacter("c")).toBe(true);
        await expect(h.sync.flushResources()).rejects.toMatchObject({ status: 500 });
        expect(h.fake.record("characters", "c")).not.toBeNull();
        h.fake.requests.length = 0;
    }

    it("replays a lost chat create and then deletes the chat when the id is re-added without it: the server ends with exactly the replacement's chats", async () => {
        const h = await bootWithCharacters();
        const lost = await loseCreateOfX(h);
        await failDeletion(h);
        h.characterStore.addCharacter(replacement([chatOf("r", "Replacement transcript")]));
        expect(await h.sync.flushResources()).toEqual({ discarded: [] });
        expect(stored(h.fake)).toEqual({ ids: ["r"], texts: { r: "Replacement transcript" } });
        expect(h.fake.record("characters", "c")!.data.name).toBe("Replacement");
        // The lost create first, exactly as sent with its id and `retry` (answered as the duplicate it
        // is), then the delete on the revision that answer reports; the chats held before as usual.
        expect(groups(h.fake).find((group: any) => group.chatId === "x")).toEqual({ ...lost, retry: true });
        expect(opsOf(h.fake, "x")).toEqual([["create"], ["delete"]]);
        expect(opsOf(h.fake, "k")).toEqual([["delete"]]);
        expect(opsOf(h.fake, "j")).toEqual([["delete"]]);
        expect(opsOf(h.fake, "r")).toEqual([["create"]]);
        expect(h.chat.heldChatRevision(refX)).toBeNull();
        expect(h.chat.hasUnsavedChatWork()).toBe(false);
        expect(alerts.error).not.toHaveBeenCalled();
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
    });

    it("replays a lost chat create and then replaces the chat when the id is re-added with it, on the revision the duplicate answer reports, without a conflict", async () => {
        const h = await bootWithCharacters();
        const lost = await loseCreateOfX(h);
        const landed = h.fake.chat("c", "x")!.revision;
        await failDeletion(h);
        h.characterStore.addCharacter(replacement([chatOf("x", "Rewritten transcript")]));
        expect(await h.sync.flushResources()).toEqual({ discarded: [] });
        expect(stored(h.fake)).toEqual({ ids: ["x"], texts: { x: "Rewritten transcript" } });
        const [replay, replace] = groups(h.fake).filter((group: any) => group.chatId === "x");
        expect(replay).toEqual({ ...lost, retry: true });
        expect(replace).toEqual({
            characterId: "c",
            chatId: "x",
            baseRevision: landed,
            groupId: expect.any(String),
            ops: [{ op: "replace", chat: expect.objectContaining({ id: "x" }) }],
        });
        expect(opsOf(h.fake, "x")).toEqual([["create"], ["replace"]]);
        expect(h.chat.heldChatRevision(refX)).toBe(h.fake.chat("c", "x")!.revision);
        expect(h.chat.hasUnsavedChatWork()).toBe(false);
        expect(alerts.error).not.toHaveBeenCalled();
        // The re-add's reorder (`[x]`, nothing held it back) went out in the replay's batch on the
        // order base the lost create had moved, so that batch conflicted and the recovery read the
        // list: one reload notice, nothing discarded. The same happens to any reorder sent beside an
        // in-doubt create replay, with or without the deletion fix; it is not of the re-add.
        expect(alerts.normal.mock.calls.map(([value]) => value)).toEqual(["reloaded"]);
    });

    it("keeps the lost groups of chats the server holds too: the re-add replays them, then replaces the reused chat and deletes the other on the revisions they report, without a conflict", async () => {
        const h = await bootWithCharacters();
        h.chat.setMessageText(refK, "a", "lost edit");
        h.chat.setChatMeta(refJ, { note: "lost note" });
        h.fake.dropNextBatchResponse = true;
        await expect(h.sync.flushResources()).rejects.toMatchObject({ status: 0 });
        expect(h.fake.texts("c", "k")[0]).toBe("lost edit");
        const lostK = groups(h.fake).find((group: any) => group.chatId === "k");
        const lostJ = groups(h.fake).find((group: any) => group.chatId === "j");
        const landedK = h.fake.chat("c", "k")!.revision;
        h.fake.requests.length = 0;
        await failDeletion(h);
        h.characterStore.addCharacter(replacement([chatOf("k", "Rewritten transcript")]));
        expect(await h.sync.flushResources()).toEqual({ discarded: [] });
        expect(stored(h.fake)).toEqual({ ids: ["k"], texts: { k: "Rewritten transcript" } });
        // Before the fix the settled resends were forgotten and the replace went out on the base the
        // lost edit had moved: a conflict, the notice, and the server's copy over the replacement.
        const [replayK, replaceK] = groups(h.fake).filter((group: any) => group.chatId === "k");
        expect(replayK).toEqual({ ...lostK, retry: true });
        expect(replaceK.baseRevision).toBe(landedK);
        expect(opsOf(h.fake, "k")).toEqual([["setText"], ["replace"]]);
        expect(groups(h.fake).find((group: any) => group.chatId === "j")).toEqual({ ...lostJ, retry: true });
        expect(opsOf(h.fake, "j")).toEqual([["meta"], ["delete"]]);
        expect(h.chat.heldChatRevision(refK)).toBe(h.fake.chat("c", "k")!.revision);
        expect(h.chat.hasUnsavedChatWork()).toBe(false);
        expect(alerts.error).not.toHaveBeenCalled();
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
    });

    it("does not keep a create the server rolled back unanswered (never in doubt, no revision held): the re-add creates the reused id afresh", async () => {
        const h = await bootWithCharacters();
        // Another tab deletes `j`; this tab's edit of it conflicts and rolls the batch back with x's
        // create, and the conflict's read fails: the create is kept apart, never in doubt.
        h.fake.chatBatch([
            { characterId: "c", chatId: "j", baseRevision: h.fake.chat("c", "j")!.revision, ops: [{ op: "delete" }] },
        ]);
        h.chat.setChatMeta(refJ, { note: "edit of a chat gone on the server" });
        h.chat.createChat("c", chatOf("x", "Rolled back"));
        h.fake.failNext = { status: 500, times: 1, match: (path) => path === "/api/resources/read" };
        await expect(h.sync.flushResources()).rejects.toMatchObject({ status: 500 });
        expect(h.fake.chat("c", "x")).toBeNull();
        const rolledBack = groups(h.fake).find((group: any) => group.chatId === "x");
        h.fake.requests.length = 0;
        await failDeletion(h);
        h.characterStore.addCharacter(replacement([chatOf("x", "Rewritten transcript")]));
        expect(await h.sync.flushResources()).toEqual({ discarded: [] });
        expect(stored(h.fake)).toEqual({ ids: ["x"], texts: { x: "Rewritten transcript" } });
        // A fresh create of the replacement's chat, never the rolled-back payload or its id.
        const creates = groups(h.fake).filter((group: any) => group.chatId === "x");
        expect(creates.length).toBeGreaterThan(0);
        for (const create of creates) {
            expect(create.retry).toBeUndefined();
            expect(create.groupId).not.toBe(rolledBack.groupId);
            expect(create.ops).toEqual([
                expect.objectContaining({
                    op: "create",
                    chat: expect.objectContaining({
                        message: [expect.objectContaining({ data: "Rewritten transcript" })],
                    }),
                }),
            ]);
        }
        expect(h.chat.heldChatRevision(refX)).toBe(h.fake.chat("c", "x")!.revision);
        expect(h.chat.hasUnsavedChatWork()).toBe(false);
    });

    it("drops the kept group when the deletion is acknowledged: a re-add afterwards sends nothing for the deleted chat", async () => {
        const h = await bootWithCharacters();
        const lost = await loseCreateOfX(h);
        expect(h.characterStore.removeCharacter("c")).toBe(true);
        expect(await h.sync.flushResources()).toEqual({ discarded: [] });
        expect(h.fake.record("characters", "c")).toBeNull();
        expect(h.fake.chat("c", "x")).toBeNull();
        h.characterStore.addCharacter(replacement([chatOf("r", "Replacement transcript")]));
        expect(await h.sync.flushResources()).toEqual({ discarded: [] });
        expect(stored(h.fake)).toEqual({ ids: ["r"], texts: { r: "Replacement transcript" } });
        expect(opsOf(h.fake, "x")).toEqual([]);
        expect(groups(h.fake).some((group: any) => group.groupId === lost.groupId)).toBe(false);
        expect(h.chat.hasUnsavedChatWork()).toBe(false);
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("drops the kept group when a conflicting deletion restores the character from the server (its list is authoritative): a later re-add deletes the landed chat without replaying its create", async () => {
        const h = await bootWithCharacters();
        const lost = await loseCreateOfX(h);
        // Another tab edits the character; this tab's deletion conflicts, and the recovery puts the
        // server's character back with its chats, the landed `x` among them.
        h.fake.set("characters", "c", { chaId: "c", name: "Edited elsewhere" });
        expect(h.characterStore.removeCharacter("c")).toBe(true);
        await h.sync.flushResources().catch(() => undefined);
        expect(h.characters().map((character) => character.name)).toEqual(["Edited elsewhere"]);
        expect(h.mirrorIds().sort()).toEqual(["j", "k", "x"]);
        expect(h.chat.heldChatRevision(refX)).toBe(h.fake.chat("c", "x")!.revision);
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        alerts.normal.mockClear();
        h.fake.requests.length = 0;

        await failDeletion(h);
        h.characterStore.addCharacter(replacement([chatOf("r", "Replacement transcript")]));
        expect(await h.sync.flushResources()).toEqual({ discarded: [] });
        expect(stored(h.fake)).toEqual({ ids: ["r"], texts: { r: "Replacement transcript" } });
        expect(opsOf(h.fake, "x")).toEqual([["delete"]]);
        expect(groups(h.fake).some((group: any) => group.groupId === lost.groupId)).toBe(false);
        expect(h.chat.hasUnsavedChatWork()).toBe(false);
        expect(alerts.normal).not.toHaveBeenCalledWith("reloaded");
    });
});
