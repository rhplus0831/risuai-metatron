import { createHash } from "node:crypto";
import { tick } from "svelte";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Chat, character } from "../../../../shared/database.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import {
    isSealedHypaV3Data,
    sealedHypaV3DataRevision,
    STRUCTURED_MEMORY_PATH,
} from "../../../../shared/structuredMemory.ts";
import { warmMutationGraph } from "src/ts/storage/tests/mutationStoresHarness";
import { StoreBackedServer } from "src/ts/storage/tests/storeBackedServer";

type Api = Record<string, (...args: any[]) => any>;
type Snapshot = Awaited<ReturnType<typeof import("src/ts/storage/resourceClient").readKinds>>;
const { boundary } = vi.hoisted(() => ({
    boundary: {
        api: null as Api | null,
        fetch: null as null | ((path: string, init?: RequestInit) => Promise<Response>),
        liveFeedCurrent: vi.fn<() => boolean>(() => false),
    },
}));
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({
        authFetch: (path, init, options) => {
            options?.beforeDispatch?.();
            return boundary.fetch!(path, init);
        },
    }),
);
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({ alertConfirm: vi.fn(async () => true) }),
);
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/network/eventFeed", async () =>
    (await import("src/ts/tests/bootMocks")).createBootMock("eventFeed", {
        liveFeedCurrent: boundary.liveFeedCurrent,
    }),
);
vi.mock("./factory", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./factory")>()),
    SandboxHost: class {
        constructor(api: Api) {
            boundary.api = api;
        }
        run() {}
        executeInIframe() {
            return Promise.resolve();
        }
        dispose() {}
        terminate() {}
    },
}));

const ref = (chaId: string, chatId: string) => ({ chaId, chatId });
const held = ref("c", "held");
const other = ref("c", "other");
const readPath = "/api/resources/read";
const revisionPath = `${STRUCTURED_MEMORY_PATH}/revisions`;
const projectionPath = `${STRUCTURED_MEMORY_PATH}/c/projected/projection`;
const servers: StoreBackedServer[] = [];
const cleanups: (() => void)[] = [];
const chatData = (id: string, time = 100): Chat => ({
    id,
    name: id,
    note: "",
    localLore: [],
    fmIndex: -1,
    message: [{ chatId: "message", role: "char", data: `Saved ${id}`, time }],
});
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
}
const resourceReads = (fake: StoreBackedServer) => fake.requests.filter(({ path }) => path === readPath);
const requestedChats = (fake: StoreBackedServer) => resourceReads(fake).flatMap(({ body }) => body.chats ?? []);
/** A character as a plugin receives it: its own mutable copy. */
type ReturnedCharacter = Omit<character, "chats" | "chatPage"> & { chats: Chat[]; chatPage: number };
type SummaryCharacter = Omit<ReturnedCharacter, "chats" | "chatPage"> & {
    chatSummaries: { id: string; name: string; lastMessageAt?: number }[];
};
const returnedCharacter = (value: { characters: ReturnedCharacter[] }, chaId: string) =>
    value.characters.find((entry) => entry.chaId === chaId)!;

async function fixture(
    layout: Record<string, Chat[]> = { c: [chatData("held"), chatData("other")], d: [chatData("d")] },
) {
    const fake = await StoreBackedServer.create({ lock: true });
    servers.push(fake);
    fake.set("presets", "main", [{ id: "prompt", name: "Prompt" }]);
    fake.set("modelPresets", "main", [{ id: "model", name: "Model" }]);
    fake.set("modules", "main", []);
    fake.set("plugins", "main", []);
    fake.set("pluginStorage", "main", {});
    const scriptHash = createHash("sha256").update("").digest("hex");
    fake.set("pluginPermissions", "main", {
        grants: { [`${scriptHash}_db`]: true, [`${scriptHash}_replacer`]: true },
        lastGrantTime: {
            "detached-reader_db_lastGrantTime": Date.now(),
            "detached-reader_replacer_lastGrantTime": Date.now(),
        },
    });
    fake.store.applyChanges({
        ops: Object.keys(layout).map((id) => ({
            kind: fake.kind("characters"),
            id,
            baseRevision: null,
            data: { chaId: id, name: id, lastInteraction: 17 },
        })),
        chats: Object.entries(layout).flatMap(([characterId, chats]) =>
            chats.map((chat) => ({
                characterId,
                chatId: chat.id,
                baseRevision: null,
                ops: [{ op: "create", chat }],
            })),
        ),
    });
    return fake;
}

/** Fresh client records, chat store and real save adapter; reusing a snapshot does not reuse loaded chats. */
async function boot(fake: StoreBackedServer, initial?: Snapshot) {
    vi.resetModules();
    boundary.fetch = fake.fetch;
    const client = await import("src/ts/storage/resourceClient");
    const sync = await import("src/ts/storage/resourceSync.svelte");
    const chat = await import("src/ts/storage/chatStore.svelte");
    const bootstrap = await import("src/ts/bootstrap");
    const selection = await import("src/ts/storage/selection.svelte");
    const { settings } = await import("src/ts/storage/settingsViews.svelte");
    const snapshot = initial ?? (await client.readKinds(Object.values(RESOURCE_KIND), { chatSummaries: true }));
    sync.seedResources(snapshot);
    chat.seedChats(snapshot.chatSummaries ?? [], snapshot.chatOrders ?? []);
    (await import("./permissionStore")).seedPluginPermissions(snapshot.kinds.pluginPermissions?.[0]);
    bootstrap.installBootRecords(snapshot);
    selection.selectCharacter(null);
    chat.initializeChats();
    const windowListener = vi.spyOn(window, "addEventListener").mockImplementation(() => {});
    const documentListener = vi.spyOn(document, "addEventListener").mockImplementation(() => {});
    sync.startResourceSync();
    windowListener.mockRestore();
    documentListener.mockRestore();
    cleanups.push(sync.stopResourceSync);
    await tick();
    await sync.flushResources();
    const v3 = await import("./v3.svelte");
    await v3.executePluginV3({ name: "detached-reader", script: "", version: "3.0" } as any);
    const api = boundary.api!;
    // Establish consent before tests record or hold resource requests.
    await api.getDatabase(["memoryAlgorithmType"]);
    const context = await import("./pluginContext");
    const hooks = await import("../pluginHooks");
    hooks.clearPluginHooks();
    let inHook: (() => Promise<void>) | undefined;
    await api.addRisuChatListener("output", () => inHook!());
    const [listener] = hooks.pluginHooks.chatOutput;
    const runHook = async (work: () => Promise<void>) => {
        inHook = work;
        await context.invokeHook(listener, context.capturePluginContext(held), {
            char: {},
            chat: {},
            characterIndex: 0,
            chatIndex: 0,
            messageIndex: 0,
        });
    };
    fake.requests.length = 0;
    return { fake, snapshot, api, sync, chat, settings, runHook };
}

/** Seed real cold memory records; resource reads must project this event into hypaV3Data. */
function remember(fake: StoreBackedServer, characterId: string, id: string, summary = "A remembered promise") {
    const memory = fake.store.memory;
    const message = fake.chat(characterId, id)!.data.message[0];
    memory.write(
        characterId,
        id,
        {
            epoch: fake.store.epoch(),
            baseRevision: memory.readContents(characterId, id).revision,
        },
        {
            events: [
                {
                    id: "promise",
                    title: "Promise",
                    summary,
                    status: "active",
                    participants: [],
                    storyTime: { text: "Morning" },
                    keyLines: [],
                    stateChanges: [],
                    knowledge: [],
                    relationshipShifts: [],
                    openThreads: { add: [], close: [], transitions: [] },
                    writerRun: "writer",
                    sources: [
                        {
                            messageId: "message",
                            index: 0,
                            hash: createHash("sha256")
                                .update(JSON.stringify([message.role, message.data]))
                                .digest("hex"),
                        },
                    ],
                },
            ],
        },
    );
}

async function structuredFixture(chats: Chat[]) {
    const fake = await fixture({ c: chats });
    fake.structuredMemoryReads = true;
    fake.set("ui", "main", { ...fake.record("ui", "main")!.data, memoryAlgorithmType: "structuredMemory" });
    return fake;
}

beforeAll(() => warmMutationGraph(() => import("./v3.svelte")), 60_000);
beforeEach(() => {
    boundary.liveFeedCurrent.mockReturnValue(false);
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.stubGlobal("location", { reload: vi.fn(), protocol: "http:", host: "test" });
});
afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    for (const fake of servers.splice(0)) fake.close();
});

it.each(["outside a hook", "inside a hook"])(
    "returns held chat summaries without reading, flushing, pinning or loading chats %s",
    async (where) => {
        const unknown = chatData("unknown");
        delete unknown.message[0].time;
        const b = await boot(
            await fixture({ c: [chatData("other", 400), chatData("held"), unknown], d: [chatData("untimed")] }),
        );
        await b.chat.ensureChatLoaded(held);
        await b.chat.ensureChatLoaded(ref("d", "untimed"));
        b.chat.setChatMeta(held, { name: "Local name" });
        b.chat.replaceMessage(held, { chatId: "message", role: "char", data: "Unsaved", time: 900 });
        b.chat.replaceMessage(ref("d", "untimed"), { chatId: "message", role: "char", data: "No time" });
        // The tab has not heard this remote rename: its unloaded summary must remain the one it holds.
        b.fake.chatBatch([
            {
                characterId: "c",
                chatId: "other",
                baseRevision: b.fake.chat("c", "other")!.revision,
                ops: [{ op: "meta", set: { name: "Remote name" } }],
            },
        ]);
        const stored = b.fake.chat("c", "held");
        const keys = ["characters", "memoryAlgorithmType", "username", "selectedPersona", "temperature"];
        b.fake.requests.length = 0;
        let got!: { characters: SummaryCharacter[] };
        const read = async () => {
            got = await b.api.getDatabase(keys, { chats: "summaries" });
            for (const chaId of ["c", "d"]) expect(b.chat.isChatPinned(chaId)).toBe(false);
        };
        if (where === "inside a hook") await b.runHook(read);
        else await read();

        expect(b.fake.requests).toEqual([]);
        expect(b.fake.chat("c", "held")).toEqual(stored);
        expect(got.characters.map(({ chatSummaries }) => chatSummaries)).toStrictEqual([
            [
                { id: "other", name: "other", lastMessageAt: 400 },
                { id: "held", name: "Local name", lastMessageAt: 900 },
                { id: "unknown", name: "unknown" },
            ],
            [{ id: "untimed", name: "untimed" }],
        ]);
        for (const char of got.characters) {
            expect(char).not.toHaveProperty("chats");
            expect(char).not.toHaveProperty("chatPage");
        }
        expect(b.chat.chatsLoaded("c")).toBe(false);
        expect(b.chat.findChat(other)).toBeUndefined();
        expect(b.chat.findChat(ref("c", "unknown"))).toBeUndefined();
        expect(b.chat.findChat(held)?.message[0].data).toBe("Unsaved");

        const full = await b.api.getDatabase(keys);
        expect({
            ...got,
            characters: got.characters.map(({ chatSummaries: _summaries, ...fields }) => fields),
        }).toEqual({
            ...full,
            characters: full.characters.map(
                ({ chats: _chats, chatPage: _page, ...fields }: ReturnedCharacter) => fields,
            ),
        });
        expect(await b.api.getDatabase(["username"], { chats: "summaries" })).toEqual(
            await b.api.getDatabase(["username"]),
        );
    },
);

it("rejects invalid database options and chat modes", async () => {
    const b = await boot(await fixture());
    for (const options of [
        null,
        false,
        1,
        "summaries",
        { chats: null },
        { chats: false },
        { chats: [] },
        { chats: "brief" },
    ]) {
        await expect(b.api.getDatabase(["characters"], options), JSON.stringify(options)).rejects.toThrow();
    }
    expect(requestedChats(b.fake)).toEqual([]);
});

it.each(["setDatabase", "setDatabaseLite"] as const)(
    "%s applies summary character edits without reading or changing any chat or persisting summaries",
    async (setter) => {
        const b = await boot(await fixture());
        await b.chat.ensureChatLoaded(held);
        b.chat.selectChat("c", "other");
        const before = b.fake.store.readKinds([b.fake.kind("characters")], { chats: true });
        const incoming: { characters: SummaryCharacter[] } = structuredClone(
            await b.api.getDatabase(["characters"], { chats: "summaries" }),
        );
        incoming.characters[0].name = "Renamed from summaries";
        b.fake.requests.length = 0;

        await b.api[setter](incoming);
        await b.sync.flushResources();

        const after = b.fake.store.readKinds([b.fake.kind("characters")], { chats: true });
        expect(after.chats).toEqual(before.chats);
        expect(after.chatOrders).toEqual(before.chatOrders);
        expect(b.chat.selectedChatId("c")).toBe("other");
        expect(requestedChats(b.fake)).toEqual([]);
        expect(b.chat.findChat(held)).toBeDefined();
        for (const target of [other, ref("d", "d")]) expect(b.chat.findChat(target)).toBeUndefined();
        for (const chaId of ["c", "d"]) {
            expect(b.chat.chatsLoaded(chaId)).toBe(false);
            expect(b.fake.record("characters", chaId)!.data).not.toHaveProperty("chatSummaries");
        }
        expect(b.fake.record("characters", "c")!.data.name).toBe("Renamed from summaries");
    },
);

it.each(["setDatabase", "setDatabaseLite"] as const)(
    "%s still refuses a supplied non-array chats value",
    async (setter) => {
        const b = await boot(await fixture());
        const before = b.fake.store.readKinds([b.fake.kind("characters")], { chats: true });
        const incoming = await b.api.getDatabase(["characters"], { chats: "summaries" });
        const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
        for (const chats of [null, {}]) {
            warning.mockClear();
            await b.api[setter]({
                characters: incoming.characters.map((char: SummaryCharacter) => ({ ...char, name: "Refused", chats })),
            });
            await b.sync.flushResources();
            expect(b.fake.store.readKinds([b.fake.kind("characters")], { chats: true })).toEqual(before);
            expect(warning).toHaveBeenCalled();
        }
    },
);

it.each([
    {
        title: "reads only a chat page's unloaded refs outside a hook and matches the ordered full database page",
        inHook: false,
    },
    {
        title: "loads the character's chats inside a hook and matches the ordered full database page",
        inHook: true,
    },
])("$title", async ({ inHook }) => {
    const b = await boot(
        await fixture({
            c: [
                chatData("z-before"),
                chatData("held"),
                chatData("a-middle"),
                chatData("z-middle"),
                chatData("a-after"),
            ],
            d: [chatData("d")],
        }),
    );
    await b.chat.ensureChatLoaded(held);
    b.chat.setMessageText(held, "message", "Local page edit");
    b.fake.requests.length = 0;
    let page!: { chats: Chat[]; total: number };
    const read = async () => {
        page = await b.api.getChats("c", { offset: 1, limit: 3 });
    };
    if (inHook) await b.runHook(read);
    else await read();

    expect(page.total).toBe(5);
    expect(page.chats.map(({ id }) => id)).toEqual(["held", "a-middle", "z-middle"]);
    expect(page.chats[0].message[0].data).toBe("Local page edit");
    if (inHook) {
        expect(b.chat.chatsLoaded("c")).toBe(true);
    } else {
        expect(requestedChats(b.fake)).toEqual([
            { characterId: "c", id: "a-middle" },
            { characterId: "c", id: "z-middle" },
        ]);
        for (const { body } of resourceReads(b.fake)) {
            expect(body.refs ?? []).toEqual([]);
            expect(body.chatCollections ?? []).toEqual([]);
        }
        for (const target of [ref("c", "z-before"), ref("c", "a-after"), ref("d", "d")]) {
            expect(b.chat.findChat(target)).toBeUndefined();
        }
    }
    const full = await b.api.getDatabase(["characters"]);
    expect(page.chats).toEqual(returnedCharacter(full, "c").chats.slice(1, 4));
});

it("defaults chat paging to the remaining chats and returns empty bounds or unknown characters without reads", async () => {
    const b = await boot(await fixture());
    const emptyPages = async () => {
        for (const options of [{ offset: 2 }, { offset: 20 }, { limit: 0 }, { offset: 1, limit: 0 }]) {
            expect(await b.api.getChats("c", options)).toEqual({ chats: [], total: 2 });
        }
        expect(await b.api.getChats("missing")).toBeNull();
    };
    await emptyPages();
    await b.runHook(emptyPages);
    expect(requestedChats(b.fake)).toEqual([]);
    expect(resourceReads(b.fake)).toEqual([]);

    const tail = await b.api.getChats("c", { offset: 1 });
    expect(tail.total).toBe(2);
    expect(tail.chats.map(({ id }: Chat) => id)).toEqual(["other"]);
    expect(requestedChats(b.fake)).toEqual([{ characterId: "c", id: "other" }]);
    const first = await b.api.getChats("c", { limit: 1 });
    expect(first.total).toBe(2);
    expect(first.chats.map(({ id }: Chat) => id)).toEqual(["held"]);
    const all = await b.api.getChats("c");
    expect(all).toEqual({ chats: [...first.chats, ...tail.chats], total: 2 });
    expect(await b.api.getChats("c", { offset: 1, limit: 20 })).toEqual(tail);
    expect(all.chats).toEqual(returnedCharacter(await b.api.getDatabase(["characters"]), "c").chats);
});

it("rejects chat offsets and limits that are not non-negative safe integers before reading chats", async () => {
    const b = await boot(await fixture());
    for (const field of ["offset", "limit"]) {
        for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", null]) {
            await expect(b.api.getChats("c", { [field]: value }), `${field}: ${String(value)}`).rejects.toThrow();
        }
    }
    expect(resourceReads(b.fake)).toEqual([]);
});

it("hints once per plugin instance only for full unscoped reads above 200 chats with developer mode on", async () => {
    const b = await boot(
        await fixture({ c: Array.from({ length: 200 }, (_, i) => ({ ...chatData(`chat-${i}`), message: [] })) }),
    );
    boundary.liveFeedCurrent.mockReturnValue(true);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    b.settings.ui.enableDevTools = true;
    expect(returnedCharacter(await b.api.getDatabase(), "c").chats).toHaveLength(200);
    expect(info).not.toHaveBeenCalled();

    b.chat.createChat("c", { ...chatData("chat-200"), message: [] });
    b.settings.ui.enableDevTools = false;
    expect(returnedCharacter(await b.api.getDatabase(), "c").chats).toHaveLength(201);
    expect(info).not.toHaveBeenCalled();
    b.settings.ui.enableDevTools = true;
    await b.api.getDatabase(undefined, { chats: "summaries" });
    await b.api.getDatabase(["characters"]);
    expect(info).not.toHaveBeenCalled();

    await b.api.getDatabase();
    await b.api.getDatabase();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0].join(" ")).toContain("getDatabase");
    await (await import("./v3.svelte")).loadV3Plugins([{ name: "detached-reader", script: "", version: "3.0" } as any]);
    await boundary.api!.getDatabase();
    await boundary.api!.getDatabase();
    expect(info).toHaveBeenCalledTimes(2);
});

it("matches a hook's loaded snapshot with local edits, structured memory and a chat gone on the server", async () => {
    const fake = await fixture({
        c: [chatData("held", 200), chatData("other", 900)],
        memory: [chatData("remembered", 400)],
        gone: [chatData("survivor", 300), chatData("deleted", 1000)],
    });
    fake.set("ui", "main", { ...fake.record("ui", "main")!.data, memoryAlgorithmType: "structuredMemory" });
    remember(fake, "memory", "remembered");
    const old = await boot(fake);
    fake.chatBatch([
        {
            characterId: "gone",
            chatId: "deleted",
            baseRevision: fake.chat("gone", "deleted")!.revision,
            ops: [{ op: "delete" }],
        },
    ]);
    const prepare = async (b: Awaited<ReturnType<typeof boot>>) => {
        await b.chat.ensureChatLoaded(held);
        b.chat.selectChat("c", "other");
        b.chat.setMessageText(held, "message", "Local unsaved edit");
        expect(b.chat.chatsLoaded("c")).toBe(false);
        expect(b.chat.findChat(other)).toBeUndefined();
    };
    await prepare(old);
    let expected!: { characters: character[] };
    await old.runHook(async () => {
        expected = await old.api.getDatabase(["characters"]);
    });
    old.sync.stopResourceSync();
    const fresh = await boot(fake, old.snapshot);
    await prepare(fresh);
    const got = await fresh.api.getDatabase(["characters"]);
    expect(got).toEqual(expected);
    expect(returnedCharacter(got, "c")).toMatchObject({
        chatPage: 1,
        lastInteraction: 900,
        chats: [{ id: "held", message: [{ data: "Local unsaved edit" }] }, { id: "other" }],
    });
    expect(returnedCharacter(got, "gone")).toMatchObject({
        chatPage: 0,
        lastInteraction: 300,
        chats: [{ id: "survivor" }],
    });
    const projected = returnedCharacter(got, "memory").chats[0].hypaV3Data;
    expect(isSealedHypaV3Data(projected)).toBe(true);
    expect(projected?.summaries).toEqual([
        { text: "A remembered promise", chatMemos: ["message"], isImportant: false },
    ]);
    expect(fresh.chat.findChat(other)).toBeUndefined();
    expect(fresh.chat.findChat(ref("memory", "remembered"))).toBeUndefined();
    expect(fresh.chat.chatsLoaded("gone")).toBe(true);
});

it("batches unloaded chats across characters in at most 500 refs without pinning, installing or evicting them", async () => {
    const layout = Object.fromEntries(
        Array.from({ length: 12 }, (_, c) => [`c${c}`, Array.from({ length: 84 }, (_, k) => chatData(`k${k}`))]),
    );
    const b = await boot(await fixture(layout));
    const entered = deferred();
    const release = deferred();
    const observed: { pinned: string[]; loaded: string[] }[] = [];
    let first = true;
    boundary.fetch = async (path, init) => {
        if (path === readPath && first) {
            first = false;
            entered.resolve();
            await release.promise;
        }
        if (path === readPath) {
            observed.push({
                pinned: Object.keys(layout).filter((chaId) => b.chat.isChatPinned(chaId)),
                loaded: Object.entries(layout).flatMap(([chaId, chats]) =>
                    chats.filter(({ id }) => b.chat.findChat(ref(chaId, id!))).map(({ id }) => `${chaId}/${id}`),
                ),
            });
        }
        return b.fake.fetch(path, init);
    };
    const reading = b.api.getDatabase();
    try {
        await entered.promise;
        b.chat.trimLoadedChats();
        expect(resourceReads(b.fake)).toEqual([]);
    } finally {
        release.resolve();
    }
    const got = await reading;
    for (const duringRead of observed) {
        expect(duringRead.pinned).toEqual([]);
        expect(duringRead.loaded).toEqual([]);
    }
    const requests = resourceReads(b.fake);
    expect(requests.map(({ body }) => body.chats.length)).toEqual([500, 500, 8]);
    expect(requests.every(({ body }) => body.continue === true && body.refs.length === 0)).toBe(true);
    expect(requests.flatMap(({ body }) => body.chats)).toEqual(
        Object.entries(layout).flatMap(([characterId, chats]) => chats.map(({ id }) => ({ characterId, id }))),
    );
    expect(got.characters).toHaveLength(12);
    b.chat.trimLoadedChats();
    for (const [chaId, chats] of Object.entries(layout)) {
        expect(returnedCharacter(got, chaId).chats.map(({ id }) => id)).toEqual(chats.map(({ id }) => id));
        expect(b.chat.chatsLoaded(chaId)).toBe(false);
        expect(b.chat.isChatPinned(chaId)).toBe(false);
        for (const { id } of chats) expect(b.chat.findChat(ref(chaId, id!))).toBeUndefined();
    }
});

it("settles queued writes before detached reads and includes loaded edits made while the read is pending", async () => {
    const b = await boot(await fixture());
    await b.chat.ensureChatLoaded(held);
    b.fake.requests.length = 0;
    b.chat.setMessageText(held, "message", "Queued before read");
    const entered = deferred();
    const release = deferred();
    const savedAtRead: string[][] = [];
    boundary.fetch = async (path, init) => {
        if (path === readPath) {
            savedAtRead.push(b.fake.texts("c", "held"));
            entered.resolve();
            await release.promise;
        }
        return b.fake.fetch(path, init);
    };
    const reading = b.api.getDatabase(["characters"]);
    try {
        await entered.promise;
        b.chat.setMessageText(held, "message", "Edited during read");
    } finally {
        release.resolve();
    }
    const got = await reading;
    expect(savedAtRead).toEqual([["Queued before read"]]);
    expect(returnedCharacter(got, "c").chats[0].message[0].data).toBe("Edited during read");
    expect(b.fake.texts("c", "held")).toEqual(["Queued before read"]);
    expect(b.chat.findChat(other)).toBeUndefined();
});

it("rejects a detached database answer across a restore halt and later database or held chat reads while the notice is open", async () => {
    const b = await boot(await fixture({ c: [chatData("held"), chatData("other")] }));
    await b.chat.ensureChatLoaded(held);
    const client = await import("src/ts/storage/resourceClient");
    const { alertTerminal } = await import("src/ts/alert");
    const notice = deferred();
    vi.mocked(alertTerminal).mockImplementationOnce(() => notice.promise);
    const entered = deferred();
    const release = deferred();
    let first = true;
    boundary.fetch = async (path, init) => {
        // Capture an old-epoch success before the halt, then delay only its delivery.
        const response = await b.fake.fetch(path, init);
        if (path === readPath && first) {
            first = false;
            entered.resolve();
            await release.promise;
        }
        return response;
    };
    const reading = b.api.getDatabase(["characters"]);
    const rejected = expect(reading).rejects.toThrow(/restored/);
    try {
        await entered.promise;
        // A complete held copy is available if the plugin incorrectly falls back after the halt.
        await b.chat.ensureChatLoaded(other);
        b.fake.failNext = {
            status: 412,
            body: { error: "EpochMismatch", epoch: "restored-epoch" },
            times: 1,
            match: (path) => path === "/api/resources/ui/main",
        };
        await expect(client.getResource("ui", "main")).rejects.toBeInstanceOf(client.ResourceEpochMismatchError);
        expect(alertTerminal).toHaveBeenCalledTimes(1);
        expect(location.reload).not.toHaveBeenCalled();

        release.resolve();
        await rejected;
        await expect(b.api.getDatabase(["characters"])).rejects.toThrow(/restored/);
        await expect(b.api.getChats("c", { limit: 1 })).rejects.toThrow(/restored/);
        expect(b.chat.findChat(held)?.message[0].data).toBe("Saved held");
        expect(location.reload).not.toHaveBeenCalled();
    } finally {
        release.resolve();
        await Promise.allSettled([rejected]);
        notice.resolve();
    }
});

it("uses the loaded path inside a hook without flushing queued work", async () => {
    const b = await boot(await fixture());
    await b.chat.ensureChatLoaded(held);
    b.chat.setMessageText(held, "message", "Hook's unsaved edit");
    b.fake.requests.length = 0;
    boundary.fetch = async (path, init) => {
        if (path === readPath) expect(b.chat.isChatPinned("c")).toBe(true);
        return b.fake.fetch(path, init);
    };
    let got!: { characters: ReturnedCharacter[] };
    await b.runHook(async () => {
        got = await b.api.getDatabase(["characters"]);
    });
    expect(returnedCharacter(got, "c").chats[0].message[0].data).toBe("Hook's unsaved edit");
    expect(b.fake.texts("c", "held")).toEqual(["Saved held"]);
    expect(b.fake.batchCount()).toBe(0);
    expect(b.chat.chatsLoaded("c")).toBe(true);
    expect(b.chat.chatsLoaded("d")).toBe(true);
});

it("falls back for the whole call when generation rejects the flush", async () => {
    const editable = chatData("held");
    editable.message.push({ chatId: "editable", role: "user", data: "Before generation" });
    const b = await boot(await fixture({ c: [editable, chatData("other")], d: [chatData("d")] }));
    await b.chat.ensureChatLoaded(held);
    b.fake.lock!.addToken("token");
    b.fake.lock!.acquire(
        { characterId: "c", chatId: "held", messageId: "message" },
        { jobId: "job", generationId: "generation", token: "token" },
    );
    b.chat.setMessageText(held, "message", "Blocked edit of the generating message");
    b.chat.setMessageText(held, "editable", "Local edit during generation");
    const got = await b.api.getDatabase(["characters"]);
    expect(returnedCharacter(got, "c").chats[0].message[1].data).toBe("Local edit during generation");
    await expect(b.sync.flushResources()).rejects.toBeInstanceOf(b.sync.GenerationBlockedError);
    expect(b.fake.texts("c", "held")).toEqual(["Saved held", "Before generation"]);
    expect(b.chat.chatsLoaded("c")).toBe(true);
    expect(b.chat.chatsLoaded("d")).toBe(true);
});

it.each(["refused", "noticed"] as const)(
    "loads a %s chat's character while leaving other characters detached",
    async (condition) => {
        const b = await boot(await fixture());
        await b.chat.ensureChatLoaded(held);
        if (condition === "refused") {
            b.chat.setMessageText(held, "message", "Refused local edit");
            b.chat.setChatMeta(held, { fmIndex: "invalid" as unknown as number });
            await b.sync.flushResources();
            expect((await b.sync.flushResources()).refused).toEqual(["chats/c/held"]);
        } else {
            b.fake.chatBatch([
                {
                    characterId: "c",
                    chatId: "other",
                    baseRevision: b.fake.chat("c", "other")!.revision,
                    ops: [{ op: "meta", set: { name: "Remote name" }, unset: [] }],
                },
            ]);
            b.chat.noteRemoteChat(other, b.fake.chat("c", "other")!.revision);
            expect(b.chat.isChatBehind(other)).toBe(true);
        }
        b.fake.requests.length = 0;
        const got = await b.api.getDatabase(["characters"]);
        expect(b.chat.chatsLoaded("c")).toBe(true);
        expect(b.chat.findChat(other)?.id).toBe("other");
        expect(b.chat.chatsLoaded("d")).toBe(false);
        expect(b.chat.findChat(ref("d", "d"))).toBeUndefined();
        if (condition === "refused")
            expect(returnedCharacter(got, "c").chats[0].message[0].data).toBe("Refused local edit");
        else expect(returnedCharacter(got, "c").chats[1].name).toBe("Remote name");
    },
);

it("falls back for the whole call when the detached read fails", async () => {
    const b = await boot(await fixture());
    b.fake.failNext = { status: 503, times: 1, match: (path) => path === readPath };
    const got = await b.api.getDatabase(["characters"]);
    expect(returnedCharacter(got, "c").chats.map(({ id }) => id)).toEqual(["held", "other"]);
    expect(returnedCharacter(got, "d").chats.map(({ id }) => id)).toEqual(["d"]);
    expect(b.chat.chatsLoaded("c")).toBe(true);
    expect(b.chat.chatsLoaded("d")).toBe(true);
});

it("drops sealed projections from both loaded and detached chats after leaving structured memory", async () => {
    const fake = await fixture();
    fake.set("ui", "main", { ...fake.record("ui", "main")!.data, memoryAlgorithmType: "structuredMemory" });
    remember(fake, "c", "held");
    remember(fake, "c", "other");
    const b = await boot(fake);
    await b.chat.ensureChatLoaded(held);
    expect(isSealedHypaV3Data(b.chat.findChat(held)!.hypaV3Data)).toBe(true);
    let projectedResponse = false;
    boundary.fetch = async (path, init) => {
        const response = await fake.fetch(path, init);
        if (path === readPath) {
            const read = await response.clone().json();
            expect(
                isSealedHypaV3Data(read.chats.find((entry: { id: string }) => entry.id === "other").data.hypaV3Data),
            ).toBe(true);
            projectedResponse = true;
            b.settings.ui.memoryAlgorithmType = "hypaV3";
        }
        return response;
    };
    const got = await b.api.getDatabase(["characters"]);
    expect(projectedResponse).toBe(true);
    expect(returnedCharacter(got, "c").chats.map((chat) => chat.hypaV3Data)).toEqual([undefined, undefined]);
    expect(b.chat.findChat(other)).toBeUndefined();
});

it("reuses unchanged unloaded chats on a current feed and returns the same database", async () => {
    boundary.liveFeedCurrent.mockReturnValue(true);
    const b = await boot(await fixture());
    // Retain the answer as the iframe receives it, independent of any later cache work.
    const first = structuredClone(await b.api.getDatabase(["characters"]));
    expect(requestedChats(b.fake)).toEqual([
        { characterId: "c", id: "held" },
        { characterId: "c", id: "other" },
        { characterId: "d", id: "d" },
    ]);
    b.fake.requests.length = 0;

    expect(await b.api.getDatabase(["characters"])).toEqual(first);
    expect(b.fake.requests).toEqual([]);
    for (const target of [held, other, ref("d", "d")]) expect(b.chat.findChat(target)).toBeUndefined();
});

it.each(["setDatabase", "setDatabaseLite"] as const)(
    "%s skips unchanged loaded and cached chats while applying character fields and chatPage",
    async (setter) => {
        boundary.liveFeedCurrent.mockReturnValue(true);
        const b = await boot(await fixture());
        await b.chat.ensureChatLoaded(held);
        const storedChats = [
            b.fake.chat("c", "held")!.data,
            b.fake.chat("c", "other")!.data,
            b.fake.chat("d", "d")!.data,
        ];
        // The iframe receives its own copy, separate from the host's detached cache.
        const incoming = structuredClone(await b.api.getDatabase(["characters"]));
        returnedCharacter(incoming, "c").name = "Renamed by plugin";
        returnedCharacter(incoming, "c").chatPage = 1;
        expect(b.chat.findChat(held)).toBeDefined();
        expect(b.chat.findChat(other)).toBeUndefined();
        expect(b.chat.findChat(ref("d", "d"))).toBeUndefined();
        b.fake.requests.length = 0;

        await b.api[setter](incoming);
        await b.sync.flushResources();

        expect([b.fake.chat("c", "held")!.data, b.fake.chat("c", "other")!.data, b.fake.chat("d", "d")!.data]).toEqual(
            storedChats,
        );
        expect(requestedChats(b.fake)).toEqual([]);
        expect(b.chat.findChat(other)).toBeUndefined();
        expect(b.chat.findChat(ref("d", "d"))).toBeUndefined();
        expect(b.fake.record("characters", "c")!.data.name).toBe("Renamed by plugin");
        expect(await b.api.getDatabase(["characters"])).toEqual(incoming);
        expect(resourceReads(b.fake)).toEqual([]);
    },
);

it("loads the whole unloaded character and saves a changed chat", async () => {
    boundary.liveFeedCurrent.mockReturnValue(true);
    const b = await boot(await fixture());
    const incoming = structuredClone(await b.api.getDatabase(["characters"]));
    returnedCharacter(incoming, "c").chats[0].message[0].data = "Changed by plugin";
    expect(b.chat.chatsLoaded("c")).toBe(false);
    b.fake.requests.length = 0;

    await b.api.setDatabase(incoming);
    await b.sync.flushResources();

    expect(requestedChats(b.fake)).toEqual([
        { characterId: "c", id: "held" },
        { characterId: "c", id: "other" },
    ]);
    expect(b.chat.chatsLoaded("c")).toBe(true);
    expect(b.fake.texts("c", "held")).toEqual(["Changed by plugin"]);
    expect(b.fake.chat("c", "other")!.data).toEqual(returnedCharacter(incoming, "c").chats[1]);
    expect(await b.api.getDatabase(["characters"])).toEqual(incoming);
});

it("loads the whole unloaded character and deletes a chat omitted by the plugin", async () => {
    boundary.liveFeedCurrent.mockReturnValue(true);
    const b = await boot(await fixture());
    const incoming = structuredClone(await b.api.getDatabase(["characters"]));
    returnedCharacter(incoming, "c").chats.pop();
    expect(b.chat.chatsLoaded("c")).toBe(false);
    b.fake.requests.length = 0;

    await b.api.setDatabase(incoming);
    await b.sync.flushResources();

    expect(requestedChats(b.fake)).toEqual([
        { characterId: "c", id: "held" },
        { characterId: "c", id: "other" },
    ]);
    expect(b.chat.chatsLoaded("c")).toBe(true);
    expect(b.fake.chat("c", "other")).toBeNull();
    expect(b.fake.chat("c", "held")!.data).toEqual(returnedCharacter(incoming, "c").chats[0]);
    expect(b.fake.order("c")!.ids).toEqual(["held"]);
    expect(await b.api.getDatabase(["characters"])).toEqual(incoming);
});

it("loads the whole unloaded character and creates a chat added by the plugin", async () => {
    boundary.liveFeedCurrent.mockReturnValue(true);
    const b = await boot(await fixture());
    const incoming = structuredClone(await b.api.getDatabase(["characters"]));
    returnedCharacter(incoming, "c").chats.push(chatData("new"));
    expect(b.chat.chatsLoaded("c")).toBe(false);
    b.fake.requests.length = 0;

    await b.api.setDatabase(incoming);
    await b.sync.flushResources();

    expect(requestedChats(b.fake)).toEqual([
        { characterId: "c", id: "held" },
        { characterId: "c", id: "other" },
    ]);
    expect(b.chat.chatsLoaded("c")).toBe(true);
    expect(b.fake.chat("c", "new")?.data).toMatchObject(chatData("new"));
    expect(b.fake.chat("c", "held")!.data).toEqual(returnedCharacter(incoming, "c").chats[0]);
    expect(b.fake.chat("c", "other")!.data).toEqual(returnedCharacter(incoming, "c").chats[1]);
    expect(b.fake.order("c")!.ids).toEqual(["held", "other", "new"]);
    expect(returnedCharacter(await b.api.getDatabase(["characters"]), "c").chats).toMatchObject([
        chatData("held"),
        chatData("other"),
        chatData("new"),
    ]);
});

it.each(["revision move", "notice"] as const)("re-reads a cached chat after a %s", async (change) => {
    boundary.liveFeedCurrent.mockReturnValue(true);
    const b = await boot(await fixture({ c: [chatData("other")], d: [chatData("d")] }));
    const first = structuredClone(await b.api.getDatabase(["characters"]));
    expect(returnedCharacter(first, "c").chats[0].note).toBe("");
    const before = b.chat.heldChatRevision(other)!;
    b.fake.chatBatch([
        {
            characterId: "c",
            chatId: "other",
            baseRevision: before,
            ops: [{ op: "meta", set: { note: "Changed on the server" }, unset: [] }],
        },
    ]);
    const revision = b.fake.chat("c", "other")!.revision;
    expect(revision).not.toBe(before);
    b.chat.noteRemoteChat(other, revision, undefined, change === "revision move" ? { summaryBase: before } : undefined);
    expect(b.chat.heldChatRevision(other)).toBe(change === "revision move" ? revision : before);
    expect(b.chat.isChatBehind(other)).toBe(change === "notice");
    expect(b.chat.findChat(other)).toBeUndefined();
    b.fake.requests.length = 0;

    const second = await b.api.getDatabase(["characters"]);
    expect(requestedChats(b.fake)).toEqual([{ characterId: "c", id: "other" }]);
    expect(returnedCharacter(second, "c").chats[0].note).toBe("Changed on the server");
    expect(returnedCharacter(second, "d")).toEqual(returnedCharacter(first, "d"));
});

it("re-reads every unloaded chat while the feed is not current", async () => {
    boundary.liveFeedCurrent.mockReturnValue(true);
    const b = await boot(await fixture());
    const first = structuredClone(await b.api.getDatabase(["characters"]));
    boundary.liveFeedCurrent.mockReturnValue(false);

    for (let call = 0; call < 2; call++) {
        b.fake.requests.length = 0;
        expect(await b.api.getDatabase(["characters"])).toEqual(first);
        expect(requestedChats(b.fake)).toEqual([
            { characterId: "c", id: "held" },
            { characterId: "c", id: "other" },
            { characterId: "d", id: "d" },
        ]);
    }
});

it("drops cached chats after five minutes without a characters read", async () => {
    boundary.liveFeedCurrent.mockReturnValue(true);
    const b = await boot(await fixture({ c: [chatData("other")] }));
    const first = structuredClone(await b.api.getDatabase(["characters"]));
    b.fake.requests.length = 0;

    for (let call = 0; call < 2; call++) {
        await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
        expect(await b.api.getDatabase(["characters"])).toEqual(first);
        expect(resourceReads(b.fake)).toEqual([]);
    }

    // A characters read starts a new idle interval; a settings-only read does not extend it.
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    await b.api.getDatabase(["memoryAlgorithmType"]);
    expect(resourceReads(b.fake)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await b.api.getDatabase(["characters"])).toEqual(first);
    expect(requestedChats(b.fake)).toEqual([{ characterId: "c", id: "other" }]);
});

it("evicts the oldest insertion above 64 MiB of JSON UTF-8 even if it was recently reused", async () => {
    boundary.liveFeedCurrent.mockReturnValue(true);
    const ids = Array.from({ length: 65 }, (_, index) => String(index).padStart(2, "0"));
    const b = await boot(await fixture({ c: ids.map((id) => chatData(id)) }));
    const cache = await import("./detachedChatCache");
    // All entries share one string; the server fixture stays small. Each JSON value is exactly
    // 1 MiB in UTF-8 (less in code units), so 64 fit and the 65th evicts one. Equal-length ids
    // keep the JSON overhead identical without mocking the byte count or a repository module.
    const noteBytes = 1024 * 1024 - new TextEncoder().encode(JSON.stringify(chatData(ids[0]))).byteLength;
    const note = "한".repeat(Math.floor(noteBytes / 3)) + "x".repeat(noteBytes % 3);
    const insert = (id: string) => {
        const target = ref("c", id);
        const data = { ...chatData(id), note };
        cache.rememberDetachedChat(
            target,
            { revision: b.chat.heldChatRevision(target)!, data },
            false,
            cache.detachedChatCacheGeneration(),
        );
    };
    const retained = (id: string) => cache.cachedDetachedChat(ref("c", id)) !== undefined;
    for (const id of ids.slice(0, 64)) insert(id);
    expect(cache.detachedChatCacheSize()).toBe(64);
    expect(retained(ids[63])).toBe(true);
    expect(retained(ids[0])).toBe(true);
    insert(ids[64]);
    expect(cache.detachedChatCacheSize()).toBe(64);
    expect(retained(ids[0])).toBe(false);
    expect(retained(ids[1])).toBe(true);
    expect(retained(ids[63])).toBe(true);
    expect(retained(ids[64])).toBe(true);
});

it("under structured memory reuses only stored unsealed summaries and re-reads changing projections", async () => {
    boundary.liveFeedCurrent.mockReturnValue(true);
    const owned = chatData("owned");
    owned.hypaV3Data = { summaries: [{ text: "Stored HypaV3 summary", chatMemos: ["message"], isImportant: false }] };
    const fake = await fixture({ c: [owned, chatData("projected")] });
    fake.set("ui", "main", { ...fake.record("ui", "main")!.data, memoryAlgorithmType: "structuredMemory" });
    remember(fake, "c", "projected");
    const b = await boot(fake);
    const first = structuredClone(await b.api.getDatabase(["characters"]));
    expect(returnedCharacter(first, "c").chats[0].hypaV3Data).toEqual(owned.hypaV3Data);
    expect(returnedCharacter(first, "c").chats[1].hypaV3Data?.summaries[0].text).toBe("A remembered promise");
    expect(isSealedHypaV3Data(returnedCharacter(first, "c").chats[1].hypaV3Data)).toBe(true);
    const revision = fake.chat("c", "projected")!.revision;
    remember(fake, "c", "projected", "The promise was fulfilled");
    expect(fake.chat("c", "projected")!.revision).toBe(revision);
    fake.requests.length = 0;

    const second = await b.api.getDatabase(["characters"]);
    expect(requestedChats(fake)).toEqual([{ characterId: "c", id: "projected" }]);
    expect(returnedCharacter(second, "c").chats[0]).toEqual(returnedCharacter(first, "c").chats[0]);
    expect(returnedCharacter(second, "c").chats[1].hypaV3Data?.summaries).toEqual([
        { text: "The promise was fulfilled", chatMemos: ["message"], isImportant: false },
    ]);
    expect(b.chat.chatsLoaded("c")).toBe(false);
});

it("re-reads cached summaries when the memory algorithm changes in either direction", async () => {
    boundary.liveFeedCurrent.mockReturnValue(true);
    const owned = chatData("other");
    owned.hypaV3Data = { summaries: [{ text: "Stored summary", chatMemos: ["message"], isImportant: false }] };
    const fake = await fixture({ c: [owned] });
    fake.set("ui", "main", { ...fake.record("ui", "main")!.data, memoryAlgorithmType: "hypaV3" });
    const b = await boot(fake);
    const first = structuredClone(await b.api.getDatabase(["characters"]));

    for (const algorithm of ["structuredMemory", "hypaV3"]) {
        b.settings.ui.memoryAlgorithmType = algorithm;
        fake.requests.length = 0;
        expect(await b.api.getDatabase(["characters"])).toEqual(first);
        expect(requestedChats(fake)).toEqual([{ characterId: "c", id: "other" }]);
        fake.requests.length = 0;
        expect(await b.api.getDatabase(["characters"])).toEqual(first);
        expect(resourceReads(fake)).toEqual([]);
    }
});

it("reuses a 1 MiB structured chat and a no-memory chat, refreshing only a changed projection on the next read", async () => {
    boundary.liveFeedCurrent.mockReturnValue(true);
    const projected = chatData("projected");
    projected.message[0].data = "x".repeat(1024 * 1024);
    const empty = chatData("empty");
    const fake = await structuredFixture([projected, empty]);
    remember(fake, "c", "projected");
    const b = await boot(fake);
    const first = structuredClone(await b.api.getDatabase(["characters"]));
    const firstChats = returnedCharacter(first, "c").chats;
    expect(firstChats[0]).toMatchObject(projected);
    expect(firstChats[0].hypaV3Data?.summaries).toEqual([
        { text: "A remembered promise", chatMemos: ["message"], isImportant: false },
    ]);
    expect(isSealedHypaV3Data(firstChats[0].hypaV3Data)).toBe(true);
    expect(firstChats[1]).toEqual(empty);
    expect(requestedChats(fake)).toEqual([
        { characterId: "c", id: "projected" },
        { characterId: "c", id: "empty" },
    ]);
    fake.requests.length = 0;

    expect(await b.api.getDatabase(["characters"])).toEqual(first);
    expect(fake.requests).toEqual([
        {
            method: "POST",
            path: revisionPath,
            body: {
                chats: [
                    { characterId: "c", chatId: "projected" },
                    { characterId: "c", chatId: "empty" },
                ],
            },
        },
    ]);

    const chatRevision = fake.chat("c", "projected")!.revision;
    const memoryRevision = sealedHypaV3DataRevision(firstChats[0].hypaV3Data);
    remember(fake, "c", "projected", "The promise was fulfilled");
    expect(fake.chat("c", "projected")!.revision).toBe(chatRevision);
    expect(fake.store.memory.readContents("c", "projected").revision).not.toBe(memoryRevision);
    fake.requests.length = 0;

    // No clock advance: the very next detached read must see this independent memory change.
    const changed = returnedCharacter(await b.api.getDatabase(["characters"]), "c").chats;
    expect(changed[0]).toMatchObject(projected);
    expect(changed[0].hypaV3Data?.summaries).toEqual([
        { text: "The promise was fulfilled", chatMemos: ["message"], isImportant: false },
    ]);
    expect(isSealedHypaV3Data(changed[0].hypaV3Data)).toBe(true);
    expect(changed[1]).toEqual(empty);
    expect(fake.requests.map(({ path }) => path)).toEqual([revisionPath, projectionPath]);
    expect(firstChats[0].hypaV3Data?.summaries[0].text).toBe("A remembered promise");
    for (const id of ["projected", "empty"]) expect(b.chat.findChat(ref("c", id))).toBeUndefined();
    expect(b.chat.chatsLoaded("c")).toBe(false);
});

it.each([
    { route: "revisions", outcome: "fails", path: revisionPath, status: 0 },
    { route: "revisions", outcome: "is refused", path: revisionPath, status: 404 },
    { route: "projection", outcome: "fails", path: projectionPath, status: 0 },
    { route: "projection", outcome: "is refused", path: projectionPath, status: 413 },
])("reads the whole chat when its memory $route check $outcome", async ({ path, status }) => {
    boundary.liveFeedCurrent.mockReturnValue(true);
    const stored = chatData("projected");
    const fake = await structuredFixture([stored]);
    remember(fake, "c", "projected");
    const b = await boot(fake);
    const first = await b.api.getDatabase(["characters"]);
    expect(returnedCharacter(first, "c").chats[0].hypaV3Data?.summaries[0].text).toBe("A remembered promise");
    const revision = fake.chat("c", "projected")!.revision;
    remember(fake, "c", "projected", "Checked by the whole read");
    expect(fake.chat("c", "projected")!.revision).toBe(revision);
    fake.requests.length = 0;
    fake.failNext = {
        status,
        times: 1,
        match: (asked) => asked === path,
        body: { reason: status === 413 ? "tooLarge" : "chatGone", error: "Memory check refused" },
    };

    const got = returnedCharacter(await b.api.getDatabase(["characters"]), "c").chats[0];
    expect(got).toMatchObject(stored);
    expect(got.hypaV3Data?.summaries).toEqual([
        { text: "Checked by the whole read", chatMemos: ["message"], isImportant: false },
    ]);
    expect(isSealedHypaV3Data(got.hypaV3Data)).toBe(true);
    expect(fake.requests.map(({ path }) => path)).toEqual(
        path === revisionPath ? [revisionPath, readPath] : [revisionPath, projectionPath, readPath],
    );
    expect(requestedChats(fake)).toEqual([{ characterId: "c", id: "projected" }]);
    expect(b.chat.findChat(ref("c", "projected"))).toBeUndefined();
});

it("reads the whole chat when a sealed projection disappears to recover the unknown stored value", async () => {
    boundary.liveFeedCurrent.mockReturnValue(true);
    const stored = { ...chatData("projected"), hypaV3Data: { summaries: [] } };
    const fake = await structuredFixture([stored]);
    remember(fake, "c", "projected");
    const b = await boot(fake);
    const first = await b.api.getDatabase(["characters"]);
    expect(isSealedHypaV3Data(returnedCharacter(first, "c").chats[0].hypaV3Data)).toBe(true);
    const chatRevision = fake.chat("c", "projected")!.revision;
    fake.store.memory.write(
        "c",
        "projected",
        {
            epoch: fake.store.epoch(),
            baseRevision: fake.store.memory.readContents("c", "projected").revision,
        },
        { remove: { events: ["promise"] } },
    );
    expect(fake.chat("c", "projected")!.revision).toBe(chatRevision);
    expect(fake.store.memory.readProjectionRevisions([{ characterId: "c", chatId: "projected" }])).toEqual([null]);
    fake.requests.length = 0;

    expect(returnedCharacter(await b.api.getDatabase(["characters"]), "c").chats).toEqual([stored]);
    expect(fake.requests.map(({ path }) => path)).toEqual([revisionPath, readPath]);
    expect(requestedChats(fake)).toEqual([{ characterId: "c", id: "projected" }]);
    expect(b.chat.findChat(ref("c", "projected"))).toBeUndefined();
});

it("shares three cold chat refs between overlapping detached database reads", async () => {
    boundary.liveFeedCurrent.mockReturnValue(true);
    const b = await boot(await fixture());
    const entered = deferred();
    const release = deferred();
    boundary.fetch = async (path, init) => {
        const response = await b.fake.fetch(path, init);
        if (path === readPath) {
            entered.resolve();
            await release.promise;
        }
        return response;
    };
    let completed = 0;
    const read = () =>
        b.api.getDatabase(["characters"]).then((value: { characters: ReturnedCharacter[] }) => {
            completed++;
            return value;
        });
    const readings = [read()];
    try {
        await entered.promise;
        readings.push(read());
        await vi.advanceTimersByTimeAsync(0);
        expect(completed).toBe(0);
        expect(requestedChats(b.fake)).toEqual([
            { characterId: "c", id: "held" },
            { characterId: "c", id: "other" },
            { characterId: "d", id: "d" },
        ]);
    } finally {
        release.resolve();
        await Promise.all(readings);
    }
    const [first, second] = await Promise.all(readings);
    expect(second).toEqual(first);
    for (const got of [first, second]) {
        expect(returnedCharacter(got, "c").chats).toEqual([chatData("held"), chatData("other")]);
        expect(returnedCharacter(got, "d").chats).toEqual([chatData("d")]);
    }
    expect(requestedChats(b.fake)).toHaveLength(3);
    for (const target of [held, other, ref("d", "d")]) expect(b.chat.findChat(target)).toBeUndefined();
});

it("retries detached refs after a shared read and its loaded fallback reject", async () => {
    boundary.liveFeedCurrent.mockReturnValue(true);
    const b = await boot(await fixture());
    const entered = deferred();
    const release = deferred();
    b.fake.failNext = { status: 503, times: Infinity, match: (path) => path === readPath };
    boundary.fetch = async (path, init) => {
        const response = await b.fake.fetch(path, init);
        if (path === readPath) {
            entered.resolve();
            await release.promise;
        }
        return response;
    };
    const readings = [Promise.allSettled([b.api.getDatabase(["characters"])])];
    try {
        await entered.promise;
        readings.push(Promise.allSettled([b.api.getDatabase(["characters"])]));
        await vi.advanceTimersByTimeAsync(0);
        expect(requestedChats(b.fake)).toHaveLength(3);
    } finally {
        release.resolve();
        await Promise.all(readings);
    }
    expect((await Promise.all(readings)).flat().map(({ status }) => status)).toEqual(["rejected", "rejected"]);
    b.fake.failNext = null;
    boundary.fetch = b.fake.fetch;
    b.fake.requests.length = 0;

    const retried = await b.api.getDatabase(["characters"]);
    expect(returnedCharacter(retried, "c").chats).toEqual([chatData("held"), chatData("other")]);
    expect(returnedCharacter(retried, "d").chats).toEqual([chatData("d")]);
    expect(resourceReads(b.fake)).toHaveLength(1);
    expect(requestedChats(b.fake)).toEqual([
        { characterId: "c", id: "held" },
        { characterId: "c", id: "other" },
        { characterId: "d", id: "d" },
    ]);
    // A stale rejected promise would instead send this call through the loaded fallback again.
    for (const target of [held, other, ref("d", "d")]) expect(b.chat.findChat(target)).toBeUndefined();
});

it("does not refill the detached cache with a read that was pending at pagehide", async () => {
    boundary.liveFeedCurrent.mockReturnValue(true);
    const b = await boot(await fixture({ c: [chatData("other")] }));
    const entered = deferred();
    const release = deferred();
    boundary.fetch = async (path, init) => {
        const response = await b.fake.fetch(path, init);
        if (path === readPath) {
            entered.resolve();
            await release.promise;
        }
        return response;
    };
    const pending = b.api.getDatabase(["characters"]);
    try {
        await entered.promise;
        window.dispatchEvent(new Event("pagehide"));
    } finally {
        release.resolve();
    }
    expect(returnedCharacter(await pending, "c").chats).toEqual([chatData("other")]);
    b.fake.requests.length = 0;

    expect(returnedCharacter(await b.api.getDatabase(["characters"]), "c").chats).toEqual([chatData("other")]);
    expect(requestedChats(b.fake)).toEqual([{ characterId: "c", id: "other" }]);
    b.fake.requests.length = 0;
    expect(returnedCharacter(await b.api.getDatabase(["characters"]), "c").chats).toEqual([chatData("other")]);
    expect(requestedChats(b.fake)).toEqual([]);
    expect(b.chat.findChat(other)).toBeUndefined();
});

it.each([
    { title: "serves a loaded page without flushing generation-blocked work", limit: 1 },
    { title: "loads only missing page members when generation blocks the flush", limit: 2 },
])("$title", async ({ limit }) => {
    const chats = ["held", "other", "off-page-a", "off-page-b", "off-page-c"].map((id) => chatData(id));
    chats[0].message.push({ chatId: "editable", role: "user", data: "Before generation" });
    const b = await boot(await fixture({ c: chats }));
    await b.chat.ensureChatLoaded(held);
    b.fake.lock!.addToken("token");
    b.fake.lock!.acquire(
        { characterId: "c", chatId: "held", messageId: "message" },
        { jobId: "job", generationId: "generation", token: "token" },
    );
    b.chat.setMessageText(held, "message", "Local edit of the generating message");
    b.chat.setMessageText(held, "editable", "Local edit during generation");
    b.fake.requests.length = 0;

    const page = await b.api.getChats("c", { offset: 0, limit });
    expect(page).toEqual({
        total: 5,
        chats: [
            {
                ...chats[0],
                message: [
                    { ...chats[0].message[0], data: "Local edit of the generating message" },
                    { ...chats[0].message[1], data: "Local edit during generation" },
                ],
            },
            ...chats.slice(1, limit),
        ],
    });
    expect(requestedChats(b.fake)).toEqual(limit === 1 ? [] : [{ characterId: "c", id: "other" }]);
    for (const { body } of resourceReads(b.fake)) expect(body.chatCollections ?? []).toEqual([]);
    expect(b.chat.chatsLoaded("c")).toBe(false);
    for (const { id } of chats.slice(limit)) expect(b.chat.findChat(ref("c", id!))).toBeUndefined();
    if (limit === 1) expect(b.fake.requests).toEqual([]);
    await expect(b.sync.flushResources()).rejects.toBeInstanceOf(b.sync.GenerationBlockedError);
    expect(b.fake.texts("c", "held")).toEqual(["Saved held", "Before generation"]);
});
