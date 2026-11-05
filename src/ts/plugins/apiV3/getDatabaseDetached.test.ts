import { createHash } from "node:crypto";
import { tick } from "svelte";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Chat, character } from "../../../../shared/database.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import { isSealedHypaV3Data } from "../../../../shared/structuredMemory.ts";
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
const servers: StoreBackedServer[] = [];
const cleanups: (() => void)[] = [];
const chatData = (id: string, time = 100): Chat => ({
    id,
    name: id,
    note: "",
    localLore: [],
    message: [{ chatId: "message", role: "char", data: `Saved ${id}`, time }],
});
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
}
const resourceReads = (fake: StoreBackedServer) => fake.requests.filter(({ path }) => path === readPath);
const requestedChats = (fake: StoreBackedServer) => resourceReads(fake).flatMap(({ body }) => body.chats ?? []);
const returnedCharacter = (value: { characters: character[] }, chaId: string) =>
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
    const memory = (
        fake.store as unknown as {
            memory: {
                readContents(chaId: string, chatId: string): { revision: string };
                write(
                    chaId: string,
                    chatId: string,
                    options: { epoch: string; baseRevision: string },
                    changes: unknown,
                ): string;
            };
        }
    ).memory;
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

it("uses the loaded path inside a hook without flushing queued work", async () => {
    const b = await boot(await fixture());
    await b.chat.ensureChatLoaded(held);
    b.chat.setMessageText(held, "message", "Hook's unsaved edit");
    b.fake.requests.length = 0;
    boundary.fetch = async (path, init) => {
        if (path === readPath) expect(b.chat.isChatPinned("c")).toBe(true);
        return b.fake.fetch(path, init);
    };
    let got!: { characters: character[] };
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
