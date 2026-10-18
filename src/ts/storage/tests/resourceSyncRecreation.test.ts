import { tick } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { StoreBackedServer } from "./storeBackedServer";

// A character removed and added again under the same id before the save cycle runs (a plugin's
// `setDatabase` twice within the debounce; audit DATA-01, `docs/plan/audit-findings-perf.md` slice
// 2d) over the real server store: the server's chat collection must end up equal to the replacement's
// list (old chats deleted, new ones created, a reused id replaced, the order the new list's), saved
// with the character's fields and reported as saved, so a fresh boot reads the replacement transcript.
// Before the fix the id was persisted and present, so the loop saved only the fields and the old
// chats stayed on the server behind a `discarded: []`.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
}));

vi.mock("../serverAuth", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertReloadNotice: alerts.normal,
    alertNormalWait: alerts.normalWait,
}));
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
type CharacterStore = typeof import("../characterStore.svelte");
type Selection = typeof import("../selection.svelte");

const KINDS = Object.values(RESOURCE_KIND);
const m = (id: string, data: string) => ({ role: "user", data, chatId: id }) as any;
const chatOf = (id: string, text: string) =>
    ({ id, name: id.toUpperCase(), note: "", localLore: [], message: [m(`${id}-message`, text)] }) as any;
/** The replacement: the same id, a new name, the chats given. */
const replacement = (chats: any[]) => ({ chaId: "c", name: "Replacement", chats });

/**
 * Boots the adapter and the chat module the way `loadData` does against a store that holds character
 * `c` ("Original") with chats `k` ("Original transcript") and `j`, then lets the boot compare pass run.
 */
async function boot(fake?: StoreBackedServer) {
    vi.resetModules();
    fake ??= await StoreBackedServer.create();
    if (!fake.record("characters", "c")) {
        fake.set("presets", "main", [{ name: "p1" }]);
        fake.set("modules", "main", []);
        fake.set("plugins", "main", []);
        fake.set("pluginStorage", "main", {});
        fake.store.applyChanges({
            ops: [
                { kind: fake.kind("characters"), id: "c", baseRevision: null, data: { chaId: "c", name: "Original" } },
            ],
            chats: [
                {
                    characterId: "c",
                    chatId: "k",
                    baseRevision: null,
                    ops: [{ op: "create", chat: chatOf("k", "Original transcript") }],
                },
                {
                    characterId: "c",
                    chatId: "j",
                    baseRevision: null,
                    ops: [{ op: "create", chat: chatOf("j", "Second transcript") }],
                },
            ],
        });
    }
    server.current = fake;

    const client: Client = await import("../resourceClient");
    const sync: Sync = await import("../resourceSync.svelte");
    const chat: ChatModule = await import("../chatStore.svelte");
    const bootstrap: Bootstrap = await import("../../bootstrap");
    const characterStore: CharacterStore = await import("../characterStore.svelte");
    const selection: Selection = await import("../selection.svelte");

    const snapshot = await client.readKinds(KINDS, { chats: true });
    sync.seedResources(snapshot);
    chat.seedChats(snapshot.chats ?? [], snapshot.chatOrders ?? []);
    bootstrap.installBootRecords(snapshot);
    selection.selectCharacter(null);
    chat.initializeChats();
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    fake.requests.length = 0;

    /** What the server holds for `c`: the order's ids and each chat's first message. */
    const stored = () => {
        const collection = fake!.store.readRefs([], { chatCollections: ["c"] }).chatCollections[0];
        return {
            ids: collection.order?.ids,
            texts: Object.fromEntries(collection.chats.map((entry) => [entry.id, entry.data.message[0]?.data])),
            name: fake!.record("characters", "c")?.data.name,
        };
    };
    /** The chat groups sent for `c`, in order: `[chatId, op kinds]`. */
    const sentGroups = () =>
        fake!
            .batchBodies()
            .flatMap((body) => body.chats ?? [])
            .map((group: any) => [group.chatId, group.ops.map((op: any) => op.op)]);
    return { fake, sync, chat, characterStore, stored, sentGroups };
}

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
    server.current = null;
});

it("a same-id recreation saves the replacement's chats with its fields in one batch, and a fresh boot reads them", async () => {
    const h = await boot();
    expect(h.characterStore.removeCharacter("c")).toBe(true);
    expect(h.characterStore.addCharacter(replacement([chatOf("new-chat", "Replacement transcript")]))).toBe("c");
    expect(h.chat.chatList("c").map((entry) => entry.id)).toEqual(["new-chat"]);

    expect(await h.sync.flushResources()).toEqual({ discarded: [] });
    expect(h.stored()).toEqual({
        ids: ["new-chat"],
        texts: { "new-chat": "Replacement transcript" },
        name: "Replacement",
    });
    expect(h.chat.heldChatRevision({ chaId: "c", chatId: "new-chat" })).not.toBeNull();
    // One batch: the field update of the persisted record, the old chats' deletes, the new chat's create.
    const [first] = h.fake.batchBodies();
    const characterOps = first.ops.filter((op: any) => op.kind === "characters");
    expect(characterOps.map((op: any) => [op.id, op.baseRevision === null])).toEqual([["c", false]]);
    expect(h.sentGroups().sort()).toEqual([
        ["j", ["delete"]],
        ["k", ["delete"]],
        ["new-chat", ["create"]],
    ]);
    expect(alerts.error).not.toHaveBeenCalled();

    // Another boot of the same store reads the replacement, not the old transcript.
    const again = await boot(h.fake);
    expect(again.chat.chatList("c").map((entry) => entry.id)).toEqual(["new-chat"]);
    expect(again.chat.findChat({ chaId: "c", chatId: "new-chat" })?.message[0]?.data).toBe("Replacement transcript");
    expect(again.fake.batchCount()).toBe(0);
});

it("a reused chat id takes the replacement's content, a dropped one is deleted, and the order is the new list's", async () => {
    const h = await boot();
    h.characterStore.removeCharacter("c");
    h.characterStore.addCharacter(
        replacement([chatOf("extra", "Extra transcript"), chatOf("k", "Rewritten transcript")]),
    );

    expect(await h.sync.flushResources()).toEqual({ discarded: [] });
    expect(h.stored()).toEqual({
        ids: ["extra", "k"],
        texts: { extra: "Extra transcript", k: "Rewritten transcript" },
        name: "Replacement",
    });
    expect(h.sentGroups().sort()).toEqual([
        ["extra", ["create"]],
        ["j", ["delete"]],
        ["k", ["replace"]],
    ]);
    expect(
        h.fake
            .batchBodies()
            .flatMap((body) => body.chatOrders ?? [])
            .at(-1)?.ids,
    ).toEqual(["extra", "k"]);
});

it("an unsent edit of an old chat is dropped with it: nothing of the old transcript is sent", async () => {
    const h = await boot();
    await h.chat.ensureChatLoaded({ chaId: "c", chatId: "k" });
    h.chat.replaceChat({ chaId: "c", chatId: "k" }, chatOf("k", "Edited before the removal"));
    h.characterStore.removeCharacter("c");
    h.characterStore.addCharacter(replacement([chatOf("new-chat", "Replacement transcript")]));

    expect(await h.sync.flushResources()).toEqual({ discarded: [] });
    expect(h.stored().texts).toEqual({ "new-chat": "Replacement transcript" });
    expect(h.sentGroups().filter(([id]) => id === "k")).toEqual([["k", ["delete"]]]);
});

it("a reused chat id whose old delete is in flight is created once that delete settles", async () => {
    const h = await boot();
    h.fake.holdNextBatch = true;
    h.chat.deleteChat({ chaId: "c", chatId: "k" });
    const deleting = h.sync.flushResources();
    await vi.waitFor(() => expect(h.fake.releaseBatch).not.toBeNull());
    expect(h.sentGroups()).toEqual([["k", ["delete"]]]);

    h.characterStore.removeCharacter("c");
    h.characterStore.addCharacter(replacement([chatOf("k", "Replacement transcript")]));
    h.fake.releaseBatch!();
    expect(await deleting).toEqual({ discarded: [] });
    expect(await h.sync.flushResources()).toEqual({ discarded: [] });
    expect(h.stored()).toEqual({ ids: ["k"], texts: { k: "Replacement transcript" }, name: "Replacement" });
    expect(h.sentGroups().filter(([id]) => id === "k")).toEqual([
        ["k", ["delete"]],
        ["k", ["create"]],
    ]);
});

it("a removed id placed back through replaceCharacterAt saves its chats the same way", async () => {
    const h = await boot();
    h.characterStore.removeCharacter("c");
    expect(h.characterStore.replaceCharacterAt(0, replacement([chatOf("new-chat", "Replacement transcript")]))).toBe(
        "c",
    );

    expect(await h.sync.flushResources()).toEqual({ discarded: [] });
    expect(h.stored()).toEqual({
        ids: ["new-chat"],
        texts: { "new-chat": "Replacement transcript" },
        name: "Replacement",
    });
});

it("control: a fresh id and a deletion flushed first still save their replacement transcripts", async () => {
    const h = await boot();
    h.characterStore.removeCharacter("c");
    expect(await h.sync.flushResources()).toEqual({ discarded: [] });
    expect(h.fake.record("characters", "c")).toBeNull();
    h.characterStore.addCharacter(replacement([chatOf("new-chat", "Replacement transcript")]));
    expect(await h.sync.flushResources()).toEqual({ discarded: [] });
    expect(h.stored()).toEqual({
        ids: ["new-chat"],
        texts: { "new-chat": "Replacement transcript" },
        name: "Replacement",
    });

    h.characterStore.addCharacter({ chaId: "fresh", name: "Fresh", chats: [chatOf("f", "Fresh transcript")] });
    expect(await h.sync.flushResources()).toEqual({ discarded: [] });
    const fresh = h.fake.store.readRefs([], { chatCollections: ["fresh"] }).chatCollections[0];
    expect(fresh.chats.map((entry) => entry.data.message[0].data)).toEqual(["Fresh transcript"]);
});
