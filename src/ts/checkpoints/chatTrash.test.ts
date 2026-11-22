// @vitest-environment happy-dom
import { tick } from "svelte";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ChatTrashAction } from "../../../shared/chats.ts";
import type { Chat } from "../../../shared/database.ts";
import { StoreBackedServer } from "../storage/tests/storeBackedServer";
import { KINDS, warmMutationGraph } from "../storage/tests/mutationStoresHarness";
import { deferred } from "./tests/checkpointServer";

const mocks = vi.hoisted(() => ({
    fetch: vi.fn<typeof import("../storage/serverAuth").authFetch>(),
    error: vi.fn(),
    notice: vi.fn(),
}));
vi.mock("../storage/serverAuth", async () =>
    (await import("../storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: mocks.fetch }),
);
vi.mock("../alert", async () =>
    (await import("../tests/alertMock")).createAlertMock({ alertError: mocks.error, alertReloadNotice: mocks.notice }),
);
vi.mock("../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../globalApi.svelte", async () => (await import("../tests/globalApiMock")).createGlobalApiMock());

const ref = { chaId: "c", chatId: "story" };
const address = { characterId: "c", chatId: "story" };
const stamp = Date.UTC(2026, 0, 2);
let server: StoreBackedServer;
const afterCommit = new Map<string, () => Promise<void>>();
const savedChat = (id: string): Chat => ({
    id,
    name: id,
    note: "",
    localLore: [],
    message: [
        { role: "char", chatId: "message-" + id, data: "text of " + id, ...(id === "story" ? { time: stamp } : {}) },
    ],
    ...(id === "story" ? { folderId: "folder", pinned: true, trashedAt: 123 } : {}),
});
function seedChat(id: string) {
    server.chatBatch([
        { characterId: "c", chatId: id, baseRevision: null, ops: [{ op: "create", chat: savedChat(id) }] },
    ]);
}

async function boot(ids = ["first", "story"]) {
    vi.resetModules();
    server.set("presets", "main", [{ name: "Default" }]);
    server.set("modules", "main", []);
    server.set("plugins", "main", []);
    server.set("pluginStorage", "main", {});
    server.set("characters", "c", { chaId: "c", name: "C", chatFolders: [{ id: "folder", name: "Folder" }] });
    for (const id of ids) seedChat(id);
    const client = await import("../storage/resourceClient");
    const chat = await import("../storage/chatStore.svelte");
    const sync = await import("../storage/resourceSync.svelte");
    const bootstrap = await import("../bootstrap");
    const selection = await import("../storage/selection.svelte");
    const trash = await import("./chatTrash");
    const { language } = await import("src/lang");
    const snapshot = await client.readKinds(KINDS, { chatSummaries: true });
    sync.seedResources(snapshot);
    chat.seedChats(snapshot.chatSummaries!, snapshot.chatOrders!);
    bootstrap.installBootRecords(snapshot);
    selection.selectCharacter(null);
    chat.initializeChats();
    sync.startResourceSync();
    onTestFinished(sync.stopResourceSync);
    await tick();
    await sync.flushResources();
    server.requests.length = 0;
    server.feedEvents.length = 0;
    return { chat, sync, selection, trash, language };
}

function remote(action: ChatTrashAction, chatId = "story") {
    const result = server.store.changeChatTrash(
        action,
        {
            characterId: "c",
            chatId,
            revision: server.chat("c", chatId)!.revision,
        },
        server.store.epoch(),
        server.chatHeld,
    );
    if ("error" in result) throw new Error(result.error);
    return result;
}
function lastChange() {
    const event = server.feedEvents.at(-1);
    if (event?.type !== "change") throw new Error("Expected a committed feed change");
    return event.changes;
}
function holdAnswer(path: string) {
    const committed = deferred();
    const release = deferred();
    afterCommit.set(path, async () => {
        committed.resolve();
        await release.promise;
    });
    return { committed: committed.promise, release: release.resolve };
}
const idsOf = (list: readonly { id: string }[]) => list.map(({ id }) => id);
const reads = () => server.requests.filter((r) => r.path === "/api/resources/read").map((r) => r.body);
const settleFeed = () => vi.advanceTimersByTimeAsync(1500);

beforeAll(() => warmMutationGraph(() => import("./chatTrash")));
beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(stamp);
    localStorage.clear();
    sessionStorage.clear();
    server = await StoreBackedServer.create({ feed: true, lock: true });
    afterCommit.clear();
    mocks.fetch.mockImplementation(async (path, init, options) => {
        options?.beforeDispatch?.();
        const response = await server.fetch(path, init);
        await afterCommit.get(path)?.();
        return response;
    });
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
    server.close();
});

describe("chat trash in the tab", () => {
    it.each([
        { state: "loaded", early: "answer" },
        { state: "loaded", early: "echo" },
        { state: "unloaded", early: "answer" },
        { state: "unloaded", early: "echo" },
    ])("flushes before trash and installs the first delivery ($state, $early first)", async ({ state, early }) => {
        const { chat, sync, trash } = await boot();
        chat.selectChat("c", "story");
        if (state === "loaded") await chat.ensureChatLoaded(ref);
        expect(!!chat.findChat(ref)).toBe(state === "loaded");
        const captured = chat.chatTrashRevision(ref);
        // A legacy custom metadata value in the saved transcript is unrelated to the server mark.
        expect(server.chat("c", "story")!.data).toHaveProperty("trashedAt", 123);
        expect(idsOf(chat.activeChatList("c"))).toEqual(["first", "story"]);
        const drafts = await import("../storage/messageEditorDrafts.svelte");
        drafts.openMessageEditorDraft(ref, "message-story", "message", {
            base: "text of story",
            text: "unsaved draft",
        });
        const { createComposer } = await import("../process/composerDrafts.svelte");
        const composer = createComposer();
        onTestFinished(() => composer.destroy());
        const input = composer.at("c\u0000story");
        input.input = "unsent message";
        chat.setChatMeta(ref, { name: "edited before trash" });
        const batch = holdAnswer("/api/resources/batch");
        const gate = holdAnswer("/api/chat-trash/trash");
        const pending = trash.trashChat(ref, captured);
        try {
            await Promise.race([batch.committed, gate.committed]);
            expect(server.requests.some((r) => r.path === "/api/chat-trash/trash")).toBe(false);
        } finally {
            batch.release();
        }
        await gate.committed;
        const echo = lastChange();
        try {
            expect(
                server.requests
                    .filter((r) => r.method === "POST" && r.path !== "/api/resources/read")
                    .map((r) => r.path),
            ).toEqual(["/api/resources/batch", "/api/chat-trash/trash"]);
            expect(server.chat("c", "story")!.data.name).toBe("edited before trash");
            expect(server.requests.at(-1)?.body).toEqual({ ...address, revision: captured });
            expect(chat.activeChatCount("c")).toBe(2);
            if (early === "echo") {
                sync.noteRemoteChanges(echo);
                expect(chat.chatEntry(ref)?.trashedAt).toBe(stamp);
            }
        } finally {
            gate.release();
        }
        expect(await pending).toBe(true);
        expect(chat.trashedChatList("c")).toMatchObject([
            { id: "story", name: "edited before trash", trashedAt: stamp },
        ]);
        if (early === "answer") sync.noteRemoteChanges(echo);
        await tick();
        expect(idsOf(chat.chatList("c"))).toEqual(["first", "story"]);
        expect(chat.activeChatCount("c")).toBe(1);
        expect(chat.selectedChatId("c")).toBe("first");
        expect(drafts.findMessageEditorDraft(ref, "message-story", "message")?.text).toBe("unsaved draft");
        expect(input.input).toBe("unsent message");
        expect(chat.chatTrashRevision(ref)).toBe(server.chat("c", "story")!.revision);
    });

    it("keeps the mark across eviction and reload and restores the folder, pin and activity", async () => {
        const others = Array.from({ length: 10 }, (_, i) => "other-" + i);
        const { chat, sync, trash } = await boot(["first", "story", ...others]);
        const { collectPinnedChats } = await import("src/lib/SideBars/pinnedChats");
        const { collectHomeRecentCharacters } = await import("src/lib/UI/mainMenuProjection");
        const { characterList } = await import("../storage/characterStore.svelte");
        const pins = () => collectPinnedChats(characterList(), [], chat.chatList, "Unnamed").map((pin) => pin.chatId);
        const recent = () =>
            collectHomeRecentCharacters(characterList(), {
                now: stamp,
                agoFormatter: new Intl.RelativeTimeFormat("en"),
                unknownText: "unknown",
            }).map((item) => item.chaId);
        await chat.ensureChatLoaded(ref);
        expect(pins()).toEqual(["story"]);
        expect(recent()).toEqual(["c"]);
        expect(await trash.trashChat(ref, chat.chatTrashRevision(ref))).toBe(true);
        const delayedTrashEcho = lastChange();
        await settleFeed();
        for (const chatId of others) await chat.ensureChatLoaded({ chaId: "c", chatId });
        chat.trimLoadedChats();
        expect(chat.findChat(ref)).toBeUndefined();
        expect(idsOf(chat.trashedChatList("c"))).toEqual(["story"]);
        await chat.ensureChatLoaded(ref);
        expect(chat.findChat(ref)?.message[0].data).toBe("text of story");
        expect(chat.isActiveChat(ref)).toBe(false);
        expect(pins()).toEqual([]);
        expect(recent()).toEqual([]);
        expect(await trash.restoreChat(ref, chat.chatTrashRevision(ref))).toBe(true);
        sync.noteRemoteChanges(delayedTrashEcho);
        expect(chat.activeChatList("c").find((entry) => entry.id === "story")).toMatchObject({
            folderId: "folder",
            pinned: true,
        });
        expect(pins()).toEqual(["story"]);
        expect(recent()).toEqual(["c"]);
    });

    it("re-reads the last active chat and shows the one-chat notice", async () => {
        const { chat, trash, language } = await boot(["story"]);
        const captured = chat.chatTrashRevision(ref);
        server.chatBatch([
            { ...address, baseRevision: captured, ops: [{ op: "meta", set: { name: "renamed elsewhere" } }] },
        ]);
        expect(await trash.trashChat(ref, captured)).toBe(false);
        expect(chat.activeChatList("c")).toMatchObject([{ id: "story", name: "renamed elsewhere" }]);
        expect(mocks.error).toHaveBeenCalledExactlyOnceWith(language.errors.onlyOneChat);
    });

    it("sends the captured delete token and re-reads a stale refusal", async () => {
        const { chat, trash, language } = await boot();
        const old = remote("trash");
        remote("restore");
        const newer = remote("trash");
        chat.installChatTrashState(ref, newer.revision, newer.trashedAt);
        remote("restore"); // The read after the 409 is the tab's first news of this restore.
        expect(await trash.deleteChatForever(ref, old.revision)).toBe(false);
        expect(server.requests.find((r) => r.path === "/api/chat-trash/delete")?.body).toEqual({
            ...address,
            revision: old.revision,
        });
        expect(chat.isActiveChat(ref)).toBe(true);
        expect(chat.chatTrashRevision(ref)).toBe(server.chat("c", "story")!.revision);
        expect(mocks.error).toHaveBeenCalledExactlyOnceWith(language.chatTrash.changed);
    });

    it("re-reads a committed trash after a lost answer and reports an unknown outcome", async () => {
        const { chat, trash, language } = await boot();
        await chat.ensureChatLoaded(ref);
        afterCommit.set("/api/chat-trash/trash", async () => {
            throw new TypeError("connection lost");
        });
        expect(await trash.trashChat(ref, chat.chatTrashRevision(ref))).toBe(false);
        expect(chat.chatEntry(ref)?.trashedAt).toBe(stamp);
        expect(mocks.error).toHaveBeenCalledExactlyOnceWith(language.chatTrash.unknown);
    });

    it("leaves an unacknowledged create unsent", async () => {
        const { chat, trash, language } = await boot();
        chat.createChat("c", savedChat("new"));
        const newRef = { chaId: "c", chatId: "new" };
        expect(await trash.confirmTrashChat(newRef, "new")).toBe(false);
        expect(server.requests).toEqual([]);
        expect(mocks.error).toHaveBeenCalledExactlyOnceWith(language.chatTrash.saving);
    });

    it("closes an open chat on a summary-free feed mark and selects the first active chat", async () => {
        const { chat, sync, selection, language } = await boot();
        await chat.ensureChatLoaded(ref);
        selection.selectCharacter("c");
        chat.selectChat("c", "story");
        selection.setChatOpen(true);
        const { characterId, id, revision, trashedAt } = remote("trash");
        sync.noteRemoteChanges({ resources: [], chatOrders: [], chats: [{ characterId, id, revision, trashedAt }] });
        expect(selection.selection.chatOpen).toBe(false);
        expect(chat.selectedChatId("c")).toBe("first");
        expect(chat.selectChat("c", "story")).toBe(false);
        expect(mocks.notice).toHaveBeenCalledExactlyOnceWith(language.chatTrash.closed);
        await settleFeed();
    });

    it("reconciles the listing mark and reads back a newer cursor-only revision", async () => {
        const { chat, sync, trash } = await boot();
        remote("trash");
        sync.reconcileRemote(server.store.listRevisions());
        expect(chat.chatEntry(ref)?.trashedAt).toBe(stamp);
        await settleFeed();
        server.requests.length = 0;
        const { characterId, id, revision } = remote("restore");
        sync.noteRemoteChanges({ resources: [], chatOrders: [], chats: [{ characterId, id, revision }] });
        await settleFeed();
        expect(reads()).toContainEqual(expect.objectContaining({ chatSummaryCollections: ["c"] }));
        expect(chat.isActiveChat(ref)).toBe(true);
        expect(chat.chatTrashRevision(ref)).toBe(revision);
        expect(await trash.trashChat(ref, chat.chatTrashRevision(ref))).toBe(true);
        expect(chat.chatEntry(ref)?.trashedAt).toBe(server.chat("c", "story")!.trashedAt);
    });

    // The server sends every job chat event with its `streaming` list (empty when nothing streams).
    it("applies the job's own whole chat without reading its mark back", async () => {
        const { chat } = await boot();
        await chat.ensureChatLoaded(ref);
        server.writeJobChatMeta("c", "story", { name: "job result" });
        const { characterId, id, data, revision } = server.chat("c", "story")!;
        server.requests.length = 0;
        const jobs = await import("../network/generationJobs");
        jobs.applyGenerationEvent("job", ref, {
            type: "resource",
            kind: "chats",
            epoch: server.store.epoch(),
            characterId,
            id,
            data,
            revision,
            streaming: [],
        });
        await settleFeed();
        expect(chat.findChat(ref)?.name).toBe("job result");
        expect(reads()).toEqual([]);
        expect(chat.chatTrashRevision(ref)).toBe(revision);
    });

    it.each(["answer", "tombstone"])("settles deletion once and keeps the recreated id (%s first)", async (early) => {
        const { chat, sync, trash } = await boot();
        const marked = remote("trash");
        sync.noteRemoteChanges(lastChange());
        await settleFeed();
        const removed = vi.fn();
        const off = chat.onChatRemoved(removed);
        const gate = holdAnswer("/api/chat-trash/delete");
        const pending = trash.deleteChatForever(ref, marked.revision);
        await gate.committed;
        const tombstone = lastChange();
        const recreate = async () => {
            chat.createChat("c", { ...savedChat("story"), name: "new incarnation" });
            expect(await sync.flushResources()).toEqual({ discarded: [], refused: [] });
        };
        try {
            if (early === "tombstone") {
                sync.noteRemoteChanges(tombstone);
                await settleFeed();
                expect(idsOf(chat.chatList("c"))).toEqual(["first"]);
                expect(removed).toHaveBeenCalledExactlyOnceWith(ref);
                await recreate();
            }
        } finally {
            gate.release();
        }
        expect(await pending).toBe(true);
        if (early === "answer") {
            expect(idsOf(chat.chatList("c"))).toEqual(["first"]);
            expect(removed).toHaveBeenCalledExactlyOnceWith(ref);
            await recreate();
            sync.noteRemoteChanges(tombstone);
        }
        await settleFeed();
        expect(removed).toHaveBeenCalledExactlyOnceWith(ref);
        expect(chat.activeChatList("c")).toMatchObject([{ id: "first" }, { id: "story", name: "new incarnation" }]);
        expect(chat.chatTrashRevision(ref)).toBe(server.chat("c", "story")!.revision);
        off();
    });

    it("reads the collection when permanent deletion removes its only held member", async () => {
        const { chat, trash } = await boot(["story"]);
        const removed = vi.fn();
        onTestFinished(chat.onChatRemoved(removed));
        seedChat("replacement"); // Its create and order change have not reached the tab.
        const marked = remote("trash");
        chat.installChatTrashState(ref, marked.revision, marked.trashedAt);
        expect(await trash.deleteChatForever(ref, marked.revision)).toBe(true);
        await settleFeed();
        expect(
            reads().some((read) =>
                [...(read.chatSummaryCollections ?? []), ...(read.chatCollections ?? [])].includes("c"),
            ),
        ).toBe(true);
        expect(idsOf(chat.chatList("c"))).toEqual(["replacement"]);
        expect(removed).toHaveBeenCalledExactlyOnceWith(ref);
    });

    it("saves a same-id character update with its replacement chats before omitted server members", async () => {
        const { chat, sync } = await boot();
        remote("trash");
        sync.noteRemoteChanges(lastChange());
        await settleFeed();
        const { removeCharacter, addCharacter } = await import("../storage/characterStore.svelte");
        server.requests.length = 0;
        removeCharacter("c");
        addCharacter({ chaId: "c", name: "Replacement", chats: [savedChat("new")] });
        const report = await sync.flushResources();
        const batches = server.batchBodies();
        expect(batches.flatMap((b) => b.chats ?? []).map((g) => [g.chatId, g.ops.map((op) => op.op)])).toEqual([
            ["new", ["create"]],
        ]);
        const order = ["new", "first", "story"];
        const submittedOrders = batches.flatMap((batch) => batch.chatOrders ?? []);
        expect(submittedOrders.length).toBeGreaterThan(0);
        for (const submitted of submittedOrders) expect(submitted.ids).toEqual(order);
        expect(report).toEqual({ discarded: [], refused: [] });
        expect(server.record("characters", "c")?.data.name).toBe("Replacement");
        expect(server.order("c")?.ids).toEqual(order);
        expect(idsOf(chat.chatList("c"))).toEqual(order);
        expect(idsOf(chat.trashedChatList("c"))).toEqual(["story"]);
    });
});
