import { get } from "svelte/store";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCharacter } from "../../../../shared/characters.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { type ServerFeedEvent, StoreBackedServer } from "./storeBackedServer";

// Phase 6 slice 5b (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/character-ownership.md`,
// "5b as built", "Validation") under the real boot, the real save loop, the real chat module, and the
// real server store with its change feed (`storeBackedServer.ts`; each commit is handed to
// `noteRemoteChanges` as the live-update socket would): the creation boundary (`prepareNewCharacter`
// through `addCharacter` and `replaceCharacterAt`: each creation step once, the input untouched, a
// refusal changing nothing), canonical character text (a partial same-id replacement, a deleted or
// nulled default, a group whose companion arrays no longer fit, with a retained wrapper, the own
// save's echo, another writer's partial record, a local edit during an outstanding save, and another
// tab's send stamp merged), the chat defaults at every client entry and in `setChatMeta`, a create
// whose answer was lost, and a selection (`changeChar`) that writes nothing. In every case the mirror,
// the server, and the held baseline agree and no further save follows.

const { server, alerts } = vi.hoisted(() => ({
    server: { current: null as any },
    alerts: { error: vi.fn(), normal: vi.fn(), normalWait: vi.fn(async () => undefined) },
}));

vi.mock("../nodeStorage", () => ({
    authFetch: (path: string, init?: RequestInit) => server.current.fetch(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("../../alert", () => ({
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertNormalWait: alerts.normalWait,
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
const m = (id: string, data: string, role: "user" | "char" = "user") => ({ role, data, chatId: id }) as any;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const LOCAL = new Set(["chats", "chatPage", "reloadKeys"]);
const opsOf = (fake: StoreBackedServer) => fake.batchBodies().flatMap((batch: any) => batch.ops ?? []);
const characterOps = (fake: StoreBackedServer) => opsOf(fake).filter((op: any) => op.kind === "characters");
const chatGroups = (fake: StoreBackedServer) => fake.batchBodies().flatMap((batch: any) => batch.chats ?? []);
/** A v1 lorebook entry (below `bookVersion` 2) with the old syntax the conversion rewrites. */
const oldEntry = () => ({ key: "k", comment: "old", content: "<char> meets <user>\n@@end", bookVersion: 1 });
const convertedEntry = { key: "k", comment: "old", content: "{{char}} meets {{user}}\n@@depth 0", bookVersion: 2 };

/**
 * The `loadData` sequence against a store-backed server with the change feed: character `c`
 * (chats `k`, messages a and b, and `j`, empty) stored through the server's normalizer, nothing
 * selected, the adapter started with its boot pass done. Then live delivery starts.
 */
async function boot() {
    vi.resetModules();
    const fake = await StoreBackedServer.create({ feed: true });
    server.current = fake;
    fake.set("presets", "main", [{ id: "pa", name: "p1" }]);
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
                            message: [m("a", "A", "char"), m("b", "B")],
                        },
                    } as any,
                ],
            },
            {
                characterId: "c",
                chatId: "j",
                baseRevision: null,
                ops: [{ op: "create", chat: { id: "j", name: "J", note: "", localLore: [], message: [] } } as any],
            },
        ],
    });

    const stores = await import("../../stores.svelte");
    const client = await import("../resourceClient");
    const sync = await import("../resourceSync.svelte");
    const chat = await import("../chatStore.svelte");
    const bootstrap = await import("../../bootstrap");
    const database = await import("../database.svelte");
    const characterStore = await import("../characterStore.svelte");
    const validation = await import("../mutationValidation");

    const snapshot = await client.readKinds(KINDS, { chats: true });
    sync.seedResources(snapshot);
    chat.seedChats(snapshot.chats ?? [], snapshot.chatOrders ?? []);
    database.setDatabase(bootstrap.assembleDatabase(snapshot));
    stores.selectedCharID.set(-1);
    chat.initializeChats();
    const adding = vi.spyOn(window, "addEventListener").mockImplementation(() => {});
    const addingDocument = vi.spyOn(document, "addEventListener").mockImplementation(() => {});
    sync.startResourceSync();
    adding.mockRestore();
    addingDocument.mockRestore();
    await tick();
    await sync.flushResources();
    fake.requests.length = 0;
    fake.feedEvents.length = 0;

    const live = { paused: false, queue: [] as ServerFeedEvent[] };
    const deliver = (event: ServerFeedEvent) => {
        if (event.type === "change" && event.epoch === client.getResourceEpoch()) {
            sync.noteRemoteChanges(event.changes);
        }
    };
    fake.onFeed = (event) => (live.paused ? live.queue.push(event) : deliver(event));

    const db = () => stores.DBState.db as any;
    const character = (id: string) => db().characters.find((entry: any) => entry?.chaId === id);
    const record = (id: string) => fake.record("characters", id)?.data as any;
    /** The character as the save loop projects it (own fields in their order, no local fields), as text. */
    const projected = (id: string) =>
        JSON.stringify(Object.fromEntries(Object.entries(plain(character(id))).filter(([key]) => !LOCAL.has(key))));
    /** Mirror and server hold the same character text, the server's text is its normalized form, and the held revision is the server's. */
    const agree = (id: string) => {
        expect(projected(id), `${id}: mirror and server`).toBe(JSON.stringify(record(id)));
        expect(JSON.stringify(normalizeCharacter(record(id))), `${id}: server text is canonical`).toBe(
            JSON.stringify(record(id)),
        );
        expect(sync.heldRecordRevision("characters", id), `${id}: held revision`).toBe(
            fake.record("characters", id)!.revision,
        );
    };
    /** A chat's metadata on the server (no messages). */
    const serverMeta = (chaId: string, chatId: string) => {
        const { message: _message, ...meta } = fake.chat(chaId, chatId)!.data as any;
        return meta;
    };
    /** A chat's metadata in the mirror (no messages). */
    const mirrorMeta = (chaId: string, chatId: string) => {
        const { message: _message, ...meta } = plain(chat.findChat({ chaId, chatId }));
        return meta;
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
    return {
        fake,
        live,
        stores,
        sync,
        chat,
        characterStore,
        validation,
        db,
        character,
        record,
        projected,
        agree,
        serverMeta,
        mirrorMeta,
        settle,
        noNotice,
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

describe("a character's creation (prepareNewCharacter)", () => {
    it("prepares a chatless character once: its first chat, the greeting index, the note transfer, the time, the lore, the TTS mode; the input is untouched", async () => {
        const { fake, characterStore, character, record, agree, serverMeta, mirrorMeta, settle, noNotice } =
            await boot();
        const input = {
            name: "New",
            firstMsgIndex: 2,
            alternateGreetings: ["g0", "g1", "g2"],
            postHistoryInstructions: "stay in character",
            ttsMode: "none",
            globalLore: [oldEntry()],
        };
        const before = structuredClone(input);
        const started = Date.now();
        const id = characterStore.addCharacter(input);
        expect(input).toEqual(before);
        const created = character(id);
        expect(created).toMatchObject({
            ...normalizeCharacter({ ...before, chaId: id }),
            ttsMode: "",
            postHistoryInstructions: "",
            globalLore: [convertedEntry],
        });
        // Phase 6 slice 9a: `chatPage` is the facade view, not an own key of the record.
        expect(created.chatPage).toBe(0);
        expect(created.creation_date).toBeGreaterThanOrEqual(started);
        expect(created.chats).toHaveLength(1);
        const chatId = created.chats[0].id;
        expect(mirrorMeta(id, chatId)).toEqual({
            id: chatId,
            note: "stay in character",
            name: "Chat 1",
            localLore: [],
            fmIndex: 2,
        });

        await settle();
        // One character op and one chat create, nothing else.
        expect(characterOps(fake)).toEqual([expect.objectContaining({ kind: "characters", id, baseRevision: null })]);
        expect(chatGroups(fake)).toHaveLength(1);
        agree(id);
        expect(record(id).creation_date).toBe(created.creation_date);
        expect(serverMeta(id, chatId)).toEqual(mirrorMeta(id, chatId));
        noNotice();
    });

    it("moves the note into the chat at chatPage (else the first), keeps explicit chat indexes and a supplied creation date", async () => {
        const { chat, characterStore, character, mirrorMeta, serverMeta, agree, settle, noNotice } = await boot();
        const chats = () => [
            { id: "x", name: "X", note: "first", localLore: [], message: [], fmIndex: 0 },
            { id: "y", name: "Y", note: "second", message: [] },
            { id: "z", name: "Z", note: "", localLore: [], message: [], fmIndex: -1 },
        ];
        const page = characterStore.addCharacter({
            name: "Page",
            firstMsgIndex: 1,
            chatPage: 1,
            creation_date: 42,
            postHistoryInstructions: "note",
            chats: chats(),
        });
        expect(character(page).creation_date).toBe(42);
        expect(mirrorMeta(page, "x")).toMatchObject({ note: "first", fmIndex: 0 });
        expect(mirrorMeta(page, "y")).toMatchObject({ note: "second\nnote", fmIndex: 1, localLore: [] });
        expect(mirrorMeta(page, "z")).toMatchObject({ note: "", fmIndex: -1 });
        expect(character(page).postHistoryInstructions).toBe("");
        for (const chatPage of [7, -1, "1"]) {
            const id = characterStore.addCharacter({
                name: `out of range ${chatPage}`,
                chatPage,
                postHistoryInstructions: "note",
                chats: chats(),
            });
            expect(mirrorMeta(id, character(id).chats[0].id).note, String(chatPage)).toBe("first\nnote");
            expect(mirrorMeta(id, character(id).chats[1].id).note, String(chatPage)).toBe("second");
        }
        // The fixture holds more loaded chats than the trim keeps after a save cycle (Phase 6 slice
        // 9b): `page` is pinned so the comparison below is on the mirror's copy as it was normalized
        // here, not on a copy read back from the server.
        const release = chat.pinChats(page);
        await settle();
        agree(page);
        for (const chatId of ["x", "y", "z"]) {
            expect(chat.findChat({ chaId: page, chatId }), `${chatId} stays loaded`).toBeDefined();
            expect(serverMeta(page, chatId)).toEqual(mirrorMeta(page, chatId));
        }
        release();
        noNotice();
    });

    it("refuses a creation whose lore cannot be converted, or a group whose members are not a list, and changes nothing", async () => {
        const { characterStore, validation, db, fake, sync } = await boot();
        const mirror = JSON.stringify(db());
        for (const bad of [
            { name: "bad lore", globalLore: [oldEntry(), null] },
            { name: "bad lore", globalLore: "x" },
            { name: "bad group", type: "group", characters: "c" },
        ]) {
            expect(() => characterStore.addCharacter(bad), bad.name).toThrow(validation.MutationValidationError);
            expect(() => characterStore.replaceCharacterAt(0, { ...bad, chaId: "n" }), bad.name).toThrow(
                validation.MutationValidationError,
            );
        }
        expect(JSON.stringify(db())).toBe(mirror);
        await sync.flushResources();
        expect(fake.batchCount()).toBe(0);
        expect(fake.record("characters", "n")).toBeNull();
    });

    it("prepares a group: its companion arrays per member, no single-character default; and a replacement at an index as a creation", async () => {
        const { characterStore, character, mirrorMeta, agree, settle, noNotice } = await boot();
        const group = characterStore.addCharacter({ type: "group", name: "G", characters: ["c", "c2"] });
        expect(character(group)).toMatchObject({
            characters: ["c", "c2"],
            characterTalks: [(1 / 6) * 4, (1 / 6) * 4],
            characterActive: [true, true],
            creation_date: expect.any(Number),
        });
        expect(character(group)).not.toHaveProperty("desc");
        expect(mirrorMeta(group, character(group).chats[0].id).fmIndex).toBe(-1);

        const replaced = characterStore.replaceCharacterAt(0, {
            chaId: "r",
            name: "R",
            firstMsgIndex: 0,
            postHistoryInstructions: "r note",
            globalLore: [oldEntry()],
        });
        expect(replaced).toBe("r");
        expect(character("c")).toBeUndefined();
        expect(character("r")).toMatchObject({
            desc: "",
            globalLore: [convertedEntry],
            creation_date: expect.any(Number),
        });
        expect(mirrorMeta("r", character("r").chats[0].id)).toMatchObject({ note: "r note", fmIndex: 0 });
        await settle();
        agree(group);
        agree("r");
        noNotice();
    });
});

describe("canonical character text", () => {
    it("a partial same-id replacement gets the defaults at once; the save is the server's text and nothing follows", async () => {
        const { fake, characterStore, character, agree, settle, noNotice } = await boot();
        const chats = character("c").chats;
        expect(characterStore.replaceCharacterFields({ chaId: "c", name: "Replaced", extra: 1 })).toBe(true);
        // The defaults are in the mirror before any save; the chats stay the chat module's.
        expect(character("c")).toMatchObject({ name: "Replaced", desc: "", firstMsgIndex: -1, extra: 1 });
        // Phase 6 slice 9a: `chats` is a fresh array on every read; the chats are the same ones.
        expect(character("c").chats).toEqual(chats);
        character("c").chats.forEach((entry: unknown, index: number) => expect(entry).toBe(chats[index]));
        await settle();
        expect(characterOps(fake)).toHaveLength(1);
        agree("c");
        noNotice();
    });

    it("a deleted or nulled default is written back raw before the save, the record's other wrappers stay live, and nothing follows", async () => {
        const { fake, sync, characterStore, character, record, agree, settle, noNotice } = await boot();
        characterStore.updateCharacter("c", { globalLore: [{ key: "k", content: "mine" }] });
        await settle();
        const entry = character("c").globalLore[0];
        const element = character("c");
        fake.requests.length = 0;

        delete element.desc;
        element.bias = null;
        characterStore.updateCharacter("c", { sdData: undefined, personality: null, extra: "kept" });
        expect("desc" in element).toBe(false);
        await settle();
        expect(characterOps(fake)).toHaveLength(1);
        expect(element).toMatchObject({ desc: "", bias: [], personality: "", extra: "kept" });
        expect(plain(element.sdData)).toEqual((normalizeCharacter({}) as any).sdData);
        agree("c");

        // The retained lore wrapper still writes into the record, on the held revision.
        const held = sync.heldRecordRevision("characters", "c");
        fake.requests.length = 0;
        entry.content = "edited after the repair";
        await settle();
        expect(characterOps(fake)).toEqual([expect.objectContaining({ id: "c", baseRevision: held })]);
        expect(record("c").globalLore).toEqual([{ key: "k", content: "edited after the repair" }]);
        agree("c");
        noNotice();
    });

    it("rebuilds a group's companion arrays that no longer fit its members before the save, once", async () => {
        const { fake, characterStore, character, agree, settle, noNotice } = await boot();
        const group = characterStore.addCharacter({
            type: "group",
            name: "G",
            characters: ["c"],
            characterTalks: [0.5],
            characterActive: [false],
        });
        await settle();
        expect(character(group)).toMatchObject({ characterTalks: [0.5], characterActive: [false] });
        fake.requests.length = 0;
        // A member added without its companion entries (another writer of the arrays).
        character(group).characters.push("d");
        await settle();
        expect(characterOps(fake)).toHaveLength(1);
        expect(character(group)).toMatchObject({
            characters: ["c", "d"],
            characterTalks: [(1 / 6) * 4, (1 / 6) * 4],
            characterActive: [true, true],
        });
        agree(group);
        noNotice();
    });

    it("drops the echo of a canonicalized save, applies another writer's partial record with its defaults, and writes nothing for it", async () => {
        const { fake, character, record, agree, settle, noNotice } = await boot();
        // Deleting a default alone: written back raw, the text is the held one, so nothing is sent.
        delete character("c").desc;
        await settle();
        expect(fake.batchCount()).toBe(0);
        expect(character("c").desc).toBe("");
        agree("c");
        delete character("c").desc;
        character("c").scenario = "local scenario";
        await settle();
        // The commit's echo reached the client before its acknowledgement; no read, no second write.
        expect(fake.feedEvents.filter((event) => event.type === "change")).toHaveLength(1);
        expect(fake.requests.filter((request) => request.path === "/api/resources/read")).toHaveLength(0);
        expect(fake.batchCount()).toBe(1);
        agree("c");

        // Another writer replaces the record with a partial one; the server fills its defaults.
        const element = character("c");
        fake.set("characters", "c", { chaId: "c", name: "Remote", scenario: "remote scenario" });
        await settle();
        expect(fake.batchCount()).toBe(1);
        expect(element).toMatchObject({ name: "Remote", scenario: "remote scenario", desc: "" });
        expect(record("c").desc).toBe("");
        agree("c");
        noNotice();
    });

    it("keeps a local edit made during an outstanding canonicalizing save, saves it next, and then applies another writer's change", async () => {
        const { fake, sync, character, record, agree, settle, noNotice } = await boot();
        const element = character("c");
        fake.holdNextBatch = true;
        delete element.desc;
        element.scenario = "with a real change";
        const flushing = sync.flushResources();
        await vi.waitFor(() => expect(fake.releaseBatch).not.toBeNull());
        // The held save is the canonical record (the default written back), without the edit below.
        expect(fake.batchBodies()[0].ops[0].data).toMatchObject({
            desc: "",
            scenario: "with a real change",
            personality: "",
        });
        element.personality = "typed during the save";
        fake.releaseBatch!();
        expect(await flushing).toEqual({ discarded: [] });
        expect(record("c")).toMatchObject({ desc: "", personality: "" });
        await settle();
        expect(fake.batchCount()).toBe(2);
        expect(record("c")).toMatchObject({ desc: "", personality: "typed during the save" });
        agree("c");

        fake.set("characters", "c", { ...record("c"), name: "Remote" });
        await settle();
        expect(fake.batchCount()).toBe(2);
        expect(element).toMatchObject({ name: "Remote", desc: "", personality: "typed during the save" });
        agree("c");
        noNotice();
    });

    it("merges another tab's send stamp into a local edit of a canonicalized record without a discard or a notice", async () => {
        const { fake, live, sync, character, record, agree, settle, noNotice } = await boot();
        delete character("c").desc;
        character("c").scenario = "first save";
        await settle();
        agree("c");
        // Another tab sends (its stamp), while this tab edits; the feed is late, so the save conflicts.
        live.paused = true;
        fake.set("characters", "c", { ...record("c"), lastInteraction: 5000 });
        character("c").personality = "mine";
        expect(await sync.flushResources()).toEqual({ discarded: [] });
        live.paused = false;
        await settle();
        expect(record("c")).toMatchObject({ personality: "mine", lastInteraction: 5000, desc: "" });
        expect(character("c")).toMatchObject({ personality: "mine", lastInteraction: 5000, desc: "" });
        agree("c");
        noNotice();
    });

    it("keeps own __proto__ keys, at the top level and nested, through the save, its acknowledgement, and a hydration", async () => {
        const { fake, characterStore, projected, record, agree, settle, noNotice } = await boot();
        const replacement = JSON.parse(
            '{"chaId":"c","name":"P","__proto__":{"x":1},"deep":{"__proto__":"nested","keep":2}}',
        );
        expect(characterStore.replaceCharacterFields(replacement)).toBe(true);
        await settle();
        const stored = fake.record("characters", "c")!.data as any;
        expect(Object.hasOwn(stored, "__proto__")).toBe(true);
        expect(Object.getOwnPropertyDescriptor(stored, "__proto__")!.value).toEqual({ x: 1 });
        expect(Object.hasOwn(stored.deep, "__proto__")).toBe(true);
        expect(stored.deep.keep).toBe(2);
        agree("c");

        // Another writer changes another field: the hydrated copy keeps both keys, and nothing is written.
        const batches = fake.batchCount();
        fake.set("characters", "c", { ...record("c"), name: "P remote" });
        await settle();
        expect(fake.batchCount()).toBe(batches);
        expect(projected("c")).toContain('"__proto__":{"x":1}');
        expect(projected("c")).toContain('"deep":{"__proto__":"nested","keep":2}');
        expect(JSON.parse(projected("c")).name).toBe("P remote");
        agree("c");
        noNotice();
    });

    it("leaves an update's lore as written (MCP- and Lua-style writes of a whole list)", async () => {
        const { characterStore, character, record, agree, settle } = await boot();
        characterStore.updateCharacter("c", { globalLore: [oldEntry(), { content: "<user>" }] });
        await settle();
        expect(plain(character("c").globalLore)).toEqual([oldEntry(), { content: "<user>" }]);
        expect(record("c").globalLore).toEqual([oldEntry(), { content: "<user>" }]);
        agree("c");
    });
});

describe("chat defaults on the client", () => {
    it("createChat and replaceChat give an absent fmIndex the character's greeting and keep an explicit one", async () => {
        const { chat, characterStore, mirrorMeta, serverMeta, settle, noNotice } = await boot();
        characterStore.updateCharacter("c", { firstMsgIndex: 1 });
        const created = chat.createChat("c", { name: "N", message: [], note: "" } as any);
        expect(created.fmIndex).toBe(1);
        expect(created.localLore).toEqual([]);
        const zero = chat.createChat("c", { name: "Z", message: [], note: "", localLore: [], fmIndex: 0 } as any);
        const minus = chat.createChat("c", { name: "M", message: [], note: "", localLore: [], fmIndex: -1 } as any);
        const nulled = chat.createChat("c", { name: "U", message: [], note: "", fmIndex: null } as any);
        expect([zero.fmIndex, minus.fmIndex, nulled.fmIndex]).toEqual([0, -1, 1]);

        chat.replaceChat({ chaId: "c", chatId: "k" }, { name: "K2", note: "", message: [m("a", "A", "char")] } as any);
        expect(mirrorMeta("c", "k")).toMatchObject({ name: "K2", fmIndex: 1, localLore: [] });
        chat.replaceChat({ chaId: "c", chatId: "j" }, {
            name: "J2",
            note: "",
            localLore: [],
            message: [],
            fmIndex: 0,
        } as any);
        expect(mirrorMeta("c", "j").fmIndex).toBe(0);
        await settle();
        for (const ref of [created, zero, minus, nulled]) {
            expect(serverMeta("c", ref.id)).toEqual(mirrorMeta("c", ref.id));
        }
        expect(serverMeta("c", "k")).toEqual(mirrorMeta("c", "k"));
        expect(serverMeta("c", "j")).toEqual(mirrorMeta("c", "j"));
        noNotice();
    });

    it("ensureChat gives a character another writer created without chats a first chat with its greeting (no hard-coded -1)", async () => {
        const { fake, chat, character, mirrorMeta, settle } = await boot();
        fake.set("characters", "s", { chaId: "s", name: "S", firstMsgIndex: 3 });
        await settle();
        expect(character("s").chats).toHaveLength(0);
        chat.ensureChat("s");
        expect(character("s").chats).toHaveLength(1);
        const first = character("s").chats[0].id;
        expect(mirrorMeta("s", first)).toEqual({ id: first, name: "Chat 1", note: "", localLore: [], fmIndex: 3 });
        // Its save is not asserted: a chat created for a character another writer inserted without
        // chats never leaves the queue (pre-existing, also on 139fc73b; reported separately).
    });

    it("applyChatResult (the direct plugin chat setter) gives omitted or null defaults and keeps explicit ones", async () => {
        const { chat, characterStore, mirrorMeta, serverMeta, settle, noNotice } = await boot();
        const ref = { chaId: "c", chatId: "k" };
        chat.setChatMeta(ref, { fmIndex: 2 });
        await settle();
        characterStore.updateCharacter("c", { firstMsgIndex: 1 });
        let baseline = chat.captureChatBaseline(ref);
        let result = plain(baseline.chat);
        delete result.fmIndex;
        delete result.localLore;
        chat.applyChatResult(baseline, result);
        expect(mirrorMeta("c", "k")).toMatchObject({ fmIndex: 1, localLore: [] });

        for (const fmIndex of [0, -1]) {
            baseline = chat.captureChatBaseline(ref);
            result = plain(baseline.chat);
            result.fmIndex = fmIndex;
            chat.applyChatResult(baseline, result);
            expect(mirrorMeta("c", "k").fmIndex).toBe(fmIndex);
        }
        baseline = chat.captureChatBaseline(ref);
        result = plain(baseline.chat);
        result.fmIndex = null;
        result.localLore = null;
        const input = structuredClone(result);
        chat.applyChatResult(baseline, result);
        expect(result).toEqual(input);
        expect(mirrorMeta("c", "k")).toMatchObject({ fmIndex: 1, localLore: [] });
        await settle();
        expect(serverMeta("c", "k")).toEqual(mirrorMeta("c", "k"));
        noNotice();
    });

    it("setChatMeta writes the server's default for an unset or null name, note, localLore, and fmIndex; a repeat queues nothing", async () => {
        const { fake, chat, mirrorMeta, serverMeta, settle } = await boot();
        const ref = { chaId: "c", chatId: "k" };
        chat.setChatMeta(ref, { name: "named", note: "noted", localLore: [{ key: "l" }] as any, fmIndex: 2 });
        await settle();
        fake.requests.length = 0;
        chat.setChatMeta(ref, {}, ["name", "note"]);
        chat.setChatMeta(ref, { localLore: null, fmIndex: null } as any);
        expect(mirrorMeta("c", "k")).toMatchObject({ name: "", note: "", localLore: [], fmIndex: -1 });
        await settle();
        // The two calls coalesce into one op: sets of the defaults, no unset.
        expect(chatGroups(fake).flatMap((group: any) => group.ops)).toEqual([
            { op: "meta", set: { name: "", note: "", localLore: [], fmIndex: -1 }, unset: [] },
        ]);
        expect(serverMeta("c", "k")).toEqual(mirrorMeta("c", "k"));

        fake.requests.length = 0;
        chat.setChatMeta(ref, {}, ["name", "note", "localLore", "fmIndex"]);
        chat.setChatMeta(ref, { name: null, note: null, localLore: null, fmIndex: null } as any);
        await settle();
        expect(fake.batchCount()).toBe(0);
    });

    it("setChatMeta with a field both set and unset: undefined, unchanged, and changed values for fmIndex and folderId", async () => {
        const { chat, mirrorMeta, serverMeta, settle } = await boot();
        const ref = { chaId: "c", chatId: "k" };
        const reset = async () => {
            chat.setChatMeta(ref, { fmIndex: 2, folderId: "f" } as any);
            await settle();
        };
        await reset();
        chat.setChatMeta(ref, { fmIndex: undefined, folderId: undefined } as any, ["fmIndex", "folderId"]);
        expect(mirrorMeta("c", "k").fmIndex).toBe(-1);
        expect(mirrorMeta("c", "k")).not.toHaveProperty("folderId");
        await settle();
        expect(serverMeta("c", "k")).toEqual(mirrorMeta("c", "k"));

        await reset();
        chat.setChatMeta(ref, { fmIndex: 2, folderId: "f" } as any, ["fmIndex", "folderId"]);
        expect(mirrorMeta("c", "k").fmIndex).toBe(2);
        expect(mirrorMeta("c", "k")).not.toHaveProperty("folderId");
        await settle();
        expect(serverMeta("c", "k")).toEqual(mirrorMeta("c", "k"));

        await reset();
        chat.setChatMeta(ref, { fmIndex: 3, folderId: "g" } as any, ["fmIndex", "folderId"]);
        expect(mirrorMeta("c", "k")).toMatchObject({ fmIndex: 3, folderId: "g" });
        await settle();
        expect(serverMeta("c", "k")).toEqual(mirrorMeta("c", "k"));
    });

    it("recognizes a chat create whose answer was lost (the server's defaults included) instead of a conflict", async () => {
        const { fake, sync, chat, mirrorMeta, serverMeta, settle, noNotice } = await boot();
        fake.dropNextBatchResponse = true;
        const created = chat.createChat("c", { name: "lost", message: [m("n", "N")], note: "" } as any);
        expect(created.fmIndex).toBe(-1);
        await vi.advanceTimersByTimeAsync(1500);
        expect(fake.batchCount()).toBe(1);
        // The retry finds the chat the lost answer created and takes it as acknowledged.
        expect(await sync.flushResources()).toEqual({ discarded: [] });
        await settle();
        const groups = chatGroups(fake).filter((group: any) => group.chatId === created.id);
        expect(groups.length).toBeLessThanOrEqual(2);
        expect(fake.chat("c", created.id)).not.toBeNull();
        expect(serverMeta("c", created.id)).toEqual(mirrorMeta("c", created.id));
        expect(fake.texts("c", created.id)).toEqual(["N"]);
        expect(chat.hasChatWork()).toBe(false);
        noNotice();
    });
});

describe("a selection", () => {
    it("changeChar writes nothing and stamps no lastInteraction", async () => {
        const { fake, stores, character, characterStore, record, settle, noNotice } = await boot();
        const { changeChar } = await import("../../characters");
        const added = characterStore.addCharacter({ name: "S" });
        await settle();
        fake.requests.length = 0;
        const revisions = {
            c: fake.record("characters", "c")!.revision,
            s: fake.record("characters", added)!.revision,
        };
        const indexOf = (id: string) => stores.DBState.db.characters.findIndex((entry: any) => entry.chaId === id);
        for (const id of ["c", added, "c"]) {
            await changeChar(id);
            expect(get(stores.selectedCharID)).toBe(indexOf(id));
        }
        await settle();
        expect(fake.batchCount()).toBe(0);
        for (const id of ["c", added]) {
            expect(record(id), id).not.toHaveProperty("lastInteraction");
            expect(character(id), id).not.toHaveProperty("lastInteraction");
        }
        expect(fake.record("characters", "c")!.revision).toBe(revisions.c);
        expect(fake.record("characters", added)!.revision).toBe(revisions.s);
        noNotice();
    });
});
