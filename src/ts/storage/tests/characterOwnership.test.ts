import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KINDS, bootMutations, m, plain, refK } from "./mutationStoresHarness";
import { StoreBackedServer } from "./storeBackedServer";

// The character records under the real boot (`installBootRecords`), the real save loop, and the
// real server store (`storeBackedServer.ts`), with no character watcher and no dirty mark left.
// Covered here: a wrapper write (at depth too) and an `updateCharacter` on a non-selected character
// each save one op on the held revision; a conflict reload replaces the record raw with no echo,
// and a later local write (also through a retained nested wrapper) lands on the server copy; a
// same-id replacement through the public setter (`replaceCharacterFields`) with an editor's nested
// wrapper held; the snapshot getter; the selection by index (`selectCharacterAt`, `selectedIndex`)
// both ways; the chat module's work (creation, streaming, hydration, selection, local lore) and a
// plain selection saving no character; the boot's trash pruning through `removeCharacters` writing
// the deletions once (generating characters kept) and a settled boot writing nothing. Live updates
// and job hydrations of a character are in `resourceSyncLive.test.ts` and
// `resourceSyncHydration.test.ts`.

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

const opsOf = (fake: StoreBackedServer) => fake.batchBodies().flatMap((batch: any) => batch.ops ?? []);
const characterOps = (fake: StoreBackedServer) => opsOf(fake).filter((op: any) => op.kind === "characters");

async function boot() {
    vi.resetModules();
    const booted = await bootMutations((fake) => {
        server.current = fake;
    });
    const records = await import("../records.svelte");
    return { ...booted, records };
}

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
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

describe("local writes of a character that is not selected", () => {
    it("save one op each on the held revision: a wrapper write, a nested wrapper write, and updateCharacter", async () => {
        const { fake, sync, characterStore, character, record, selectionModule } = await boot();
        expect(selectionModule.selectedIndex()).toBe(-1);
        for (const write of [
            () => (character("c").desc = "through the facade"),
            () => (character("c").alternateGreetings = ["g1"]),
            () => character("c").alternateGreetings.push("g2"),
            () => characterStore.updateCharacter("c", { name: "through updateCharacter" }),
        ]) {
            const held = sync.heldRecordRevision("characters", "c");
            expect(held).toBe(fake.record("characters", "c")!.revision);
            fake.requests.length = 0;
            write();
            await sync.flushResources();
            expect(fake.batchCount()).toBe(1);
            expect(opsOf(fake)).toEqual([expect.objectContaining({ kind: "characters", id: "c", baseRevision: held })]);
            expect(sync.heldRecordRevision("characters", "c")).toBe(fake.record("characters", "c")!.revision);
        }
        expect(record("characters", "c")).toMatchObject({
            desc: "through the facade",
            alternateGreetings: ["g1", "g2"],
            name: "through updateCharacter",
        });
        // Nothing else is owed.
        fake.requests.length = 0;
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
    });
});

describe("server copies of a character", () => {
    it("a conflict reload replaces the record raw with no echo; a later write (also through a retained nested wrapper) lands on the server copy", async () => {
        const { fake, sync, characterStore, character, record } = await boot();
        characterStore.updateCharacter("c", { globalLore: [{ key: "k", content: "mine" }] });
        await sync.flushResources();
        const entry = character("c").globalLore[0];
        const element = character("c");
        fake.set("characters", "c", {
            ...record("characters", "c"),
            name: "server name",
            globalLore: [{ key: "k", content: "server" }],
        });
        element.desc = "conflicting local edit";
        const result = await sync.flushResources();
        expect(result.discarded).toEqual(["characters/c"]);
        expect(alerts.normal).toHaveBeenCalledWith("reloaded");
        expect(element.name).toBe("server name");
        // The server copy's description (its default), not the conflicting local edit.
        expect(element.desc).toBe("");
        expect(entry.content).toBe("server");
        // The chats stayed the chat module's.
        expect(element.chats.map((chat: any) => chat.id)).toEqual(["k", "j"]);

        fake.requests.length = 0;
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);

        const held = fake.record("characters", "c")!.revision;
        expect(sync.heldRecordRevision("characters", "c")).toBe(held);
        entry.content = "edited after the reload";
        await sync.flushResources();
        expect(opsOf(fake)).toEqual([expect.objectContaining({ kind: "characters", id: "c", baseRevision: held })]);
        expect(record("characters", "c")).toMatchObject({
            name: "server name",
            globalLore: [{ key: "k", content: "edited after the reload" }],
        });
    });

    it("a same-id replacement through replaceCharacterFields keeps an editor's held nested wrapper on the new record", async () => {
        const { sync, characterStore, character, record } = await boot();
        characterStore.updateCharacter("c", { globalLore: [{ key: "k", content: "old" }] });
        await sync.flushResources();
        const held = character("c").globalLore[0];
        const chats = character("c").chats;
        expect(
            characterStore.replaceCharacterFields({
                ...plain(character("c")),
                globalLore: [{ key: "k", content: "from the plugin" }],
            }),
        ).toBe(true);
        expect(held.content).toBe("from the plugin");
        // `chats` is a fresh array on every read; the chats are the same ones.
        expect(character("c").chats).toEqual(chats);
        character("c").chats.forEach((entry: unknown, index: number) => expect(entry).toBe(chats[index]));
        held.content = "edited in the editor";
        await sync.flushResources();
        expect(record("characters", "c").globalLore).toEqual([{ key: "k", content: "edited in the editor" }]);
    });
});

describe("the snapshot getter", () => {
    it("gives a detached copy (with the chats through withChatsCopy); writing into it changes and saves nothing", async () => {
        const { fake, sync, characterStore, character, selectionModule, chat } = await boot();
        selectionModule.selectCharacterAt(0);
        // Each `characterSnapshot` call is a fresh copy.
        for (const copy of [
            characterStore.characterSnapshot("c") as any,
            characterStore.characterSnapshot(characterStore.selectedCharacter()!.chaId) as any,
        ]) {
            expect(copy.chaId).toBe("c");
            // A snapshot carries no chats; the legacy shape is built with `withChatsCopy`.
            expect(copy).not.toHaveProperty("chats");
            const legacy = chat.withChatsCopy(copy) as any;
            expect(legacy.chats.map((entry: any) => entry.id)).toEqual(["k", "j"]);
            expect(copy).not.toBe(character("c"));
            expect(legacy.chats[0]).not.toBe(character("c").chats[0]);
            copy.name = "changed in the copy";
            legacy.chats[0].message.push(m("z", "Z"));
        }
        expect(character("c").name).toBe("C");
        expect(character("c").chats[0].message).toHaveLength(3);
        // The selected character's record is live.
        expect(characterStore.selectedCharacter()).toBe(character("c"));
        fake.requests.length = 0;
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
    });
});

describe("the selection by index (selectCharacterAt, selectedIndex)", () => {
    it("maps an index to the selected id and back, both ways, immediately and before a tick", async () => {
        const { characterStore, characterList, selection, selectionModule } = await boot();
        const { selectCharacterAt, selectedIndex } = selectionModule;
        selectCharacterAt(0);
        expect(selection.characterId).toBe("c");
        expect(selectedIndex()).toBe(0);
        const n = characterStore.addCharacter({ chaId: "n", name: "N" });
        selectCharacterAt(1);
        expect(selection.characterId).toBe(n);
        expect(selectedIndex()).toBe(1);
        characterStore.selectCharacter("c");
        expect(selectedIndex()).toBe(0);
        selectCharacterAt(1);
        // The selected character moves with the list: an earlier removal keeps it selected.
        characterStore.removeCharacter("c");
        expect(selection.characterId).toBe("n");
        expect(selectedIndex()).toBe(0);
        expect(characterStore.selectedCharacter()).toBe(characterList()[0]);
        // Removing the selected character selects home.
        characterStore.removeCharacter("n");
        expect(selection.characterId).toBeNull();
        expect(selectedIndex()).toBe(-1);
        expect(characterStore.selectedCharacter()).toBeUndefined();
    });
});

describe("work outside the character record", () => {
    it("saves no character for the chat module's work and a plain selection", async () => {
        const { fake, sync, chat, selectionModule, characterStore, character } = await boot();
        const revision = fake.record("characters", "c")!.revision;
        // Selection (no HypaV3 preset turns memory on here).
        selectionModule.selectCharacterAt(0);
        characterStore.selectCharacter(null);
        characterStore.selectCharacter("c");
        // Chat creation and chat selection.
        chat.createChat("c", { name: "New chat", message: [], note: "", localLore: [] } as any, { select: true });
        chat.selectChat("c", 0);
        // Local lore of a chat.
        chat.setChatMeta(refK, { localLore: [{ key: "l", content: "local lore" }] as any });
        // Messages.
        chat.appendMessage(refK, m("d", "D"));
        await sync.flushResources();
        // Streaming of a server job into a chat.
        expect(
            chat.applyServerGeneration(refK, {
                jobId: "J",
                messageId: "c",
                generationId: "g",
                text: "streamed",
                seq: 0,
            }),
        ).toBe(true);
        chat.endServerJob("J");
        // A chat another tab changed, hydrated into the mirror.
        const before = fake.chat("c", "j")!.revision;
        fake.chatBatch([
            {
                characterId: "c",
                chatId: "j",
                baseRevision: before,
                ops: [{ op: "append", messages: [m("x", "X")], anchor: { end: true } } as any],
            },
        ]);
        const copy = fake.chat("c", "j")!;
        expect(chat.hydrateChat({ characterId: "c", id: "j", revision: copy.revision, data: copy.data })).toBe(true);
        // The render key is a local field too, and the chat page is the chat module's selection
        // (a wrapper refuses a `chatPage` write).
        character("c").reloadKeys = (character("c").reloadKeys ?? 0) + 1;
        chat.selectChat("c", 0);
        await tick();
        await sync.flushResources();
        await vi.advanceTimersByTimeAsync(3000);
        expect(characterOps(fake)).toEqual([]);
        expect(fake.record("characters", "c")!.revision).toBe(revision);
        expect(fake.texts("c", "k")).toContain("D");
    });
});

describe("the boot's trash pruning (removeCharacters)", () => {
    const DAY = 1000 * 60 * 60 * 24;

    /** The `loadData` data sequence on `fake`, with `beforeStart` where `maintainCharacters` runs (before saving starts). */
    async function bootOn(fake: StoreBackedServer, beforeStart: (modules: any) => void = () => {}) {
        vi.resetModules();
        server.current = fake;
        const client = await import("../resourceClient");
        const sync = await import("../resourceSync.svelte");
        const chat = await import("../chatStore.svelte");
        const bootstrap = await import("../../bootstrap");
        const characterStore = await import("../characterStore.svelte");
        const selectionModule = await import("../selection.svelte");
        const snapshot = await client.readKinds(KINDS, { chats: true });
        sync.seedResources(snapshot);
        chat.seedChats(snapshot.chats ?? [], snapshot.chatOrders ?? []);
        bootstrap.installBootRecords(snapshot);
        selectionModule.selectCharacter(null);
        const modules = { sync, chat, characterStore, characters: () => characterStore.characterList() as any[] };
        beforeStart(modules);
        chat.initializeChats();
        fake.requests.length = 0;
        sync.startResourceSync();
        await tick();
        await sync.flushResources();
        return modules;
    }

    it("writes the expired characters' deletions once, keeps a generating one, and a settled boot then writes nothing", async () => {
        const fake = await StoreBackedServer.create();
        fake.set("presets", "main", [{ name: "p1" }]);
        fake.set("modules", "main", []);
        fake.set("plugins", "main", []);
        fake.set("pluginStorage", "main", {});
        const old = Date.now() - 4 * DAY;
        const kind = fake.kind("characters");
        fake.store.applyChanges({
            ops: [
                { kind, id: "x1", baseRevision: null, data: { chaId: "x1", name: "X1", trashTime: old } },
                { kind, id: "x2", baseRevision: null, data: { chaId: "x2", name: "X2", trashTime: old } },
                { kind, id: "gen", baseRevision: null, data: { chaId: "gen", name: "G", trashTime: old } },
                { kind, id: "recent", baseRevision: null, data: { chaId: "recent", name: "R", trashTime: Date.now() } },
                { kind, id: "keep", baseRevision: null, data: { chaId: "keep", name: "K" } },
            ],
            chats: ["x1", "x2", "gen", "recent", "keep"].map((id) => ({
                characterId: id,
                chatId: `k${id}`,
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: `k${id}`,
                            name: "K",
                            note: "",
                            localLore: [],
                            message: [m("a", "A", "char")],
                        } as any,
                    },
                ],
            })),
        });
        fake.set("characterOrder", "main", ["x1", "x2", "gen", "recent", "keep"]);

        let removed: string[] = [];
        const first = await bootOn(fake, ({ chat, characterStore, characters }) => {
            // `gen` is generating a reply: the pruning keeps it.
            expect(
                chat.applyServerGeneration(
                    { chaId: "gen", chatId: "kgen" },
                    { jobId: "J", messageId: "a", generationId: "g", text: "so far", seq: 0 },
                ),
            ).toBe(true);
            const expired = characters()
                .filter((entry: any) => entry.trashTime && entry.trashTime + 3 * DAY < Date.now())
                .map((entry: any) => entry.chaId);
            expect(expired).toEqual(["x1", "x2", "gen"]);
            removed = characterStore.removeCharacters(expired);
        });
        expect(removed).toEqual(["x1", "x2"]);
        expect(first.characters().map((entry: any) => entry.chaId)).toEqual(["gen", "recent", "keep"]);
        expect(fake.record("characters", "x1")).toBeNull();
        expect(fake.record("characters", "x2")).toBeNull();
        expect(fake.chat("x1", "kx1")).toBeNull();
        // Each deletion went out once, and no other character was written.
        expect(characterOps(fake)).toEqual([
            expect.objectContaining({ id: "x1", delete: true }),
            expect.objectContaining({ id: "x2", delete: true }),
        ]);
        first.chat.endServerJob("J");
        fake.requests.length = 0;
        await first.sync.flushResources();
        expect(fake.batchCount()).toBe(0);

        // A settled boot (the same data, nothing new to prune but `gen`, which is no longer generating
        // and is pruned now) and then one with nothing to prune write nothing more.
        const second = await bootOn(fake, ({ characterStore, characters }) => {
            characterStore.removeCharacters(
                characters()
                    .filter((entry: any) => entry.trashTime && entry.trashTime + 3 * DAY < Date.now())
                    .map((entry: any) => entry.chaId),
            );
        });
        expect(characterOps(fake)).toEqual([expect.objectContaining({ id: "gen", delete: true })]);
        fake.requests.length = 0;
        await second.sync.flushResources();
        expect(fake.batchCount()).toBe(0);
        await bootOn(fake, ({ characterStore, characters }) => {
            expect(
                characterStore.removeCharacters(
                    characters()
                        .filter((entry: any) => entry.trashTime && entry.trashTime + 3 * DAY < Date.now())
                        .map((entry: any) => entry.chaId),
                ),
            ).toEqual([]);
        });
        expect(fake.batchCount()).toBe(0);
    });
});
