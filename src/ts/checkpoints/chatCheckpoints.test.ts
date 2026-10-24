// @vitest-environment happy-dom
import { tick } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatOp } from "../../../shared/chats.ts";
import type { Chat } from "../../../shared/database.ts";
import { KINDS, warmMutationGraph } from "../storage/tests/mutationStoresHarness";
import { CheckpointServer, deferred } from "./tests/checkpointServer";

const mocks = vi.hoisted(() => ({
    authFetch: vi.fn<typeof import("../storage/serverAuth").authFetch>(),
    reloadNotice: vi.fn(),
    terminal: vi.fn<(message: string) => Promise<void>>(),
}));
vi.mock("../storage/serverAuth", async () =>
    (await import("../storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: mocks.authFetch }),
);
vi.mock("../alert", async () =>
    (await import("../tests/alertMock")).createAlertMock({
        alertReloadNotice: mocks.reloadNotice,
        alertTerminal: mocks.terminal,
    }),
);
vi.mock("../process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("../globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));

const ref = { chaId: "character/one", chatId: "chat/one" };
const address = { characterId: ref.chaId, chatId: ref.chatId };
const savedStory = {
    message: [{ chatId: "reply", role: "char", data: "At the fork" }],
    note: "Before the journey",
    localLore: [
        {
            key: "gate",
            secondkey: "",
            content: "The gate is closed",
            comment: "Gate",
            alwaysActive: true,
            insertorder: 1,
            mode: "normal",
            selective: false,
        },
    ],
    scriptstate: { stage: "fork" },
    hypaV3Data: { summaries: [{ text: "Reached the fork", chatMemos: ["reply"], isImportant: false }], categories: [] },
} satisfies Partial<Chat>;
const initialChat: Chat = {
    id: ref.chatId,
    name: "Journey",
    ...savedStory,
    bindedPersona: "old-persona",
    promptPresetId: "old-prompt",
    modelPresetId: "old-model",
    togglePresetId: "old-toggles",
    GLGlobalVariables: { bonus: "saved", toggle_light: "0" },
};
const currentBinding = {
    bindedPersona: "current-persona",
    promptPresetId: "current-prompt",
    modelPresetId: "current-model",
    togglePresetId: "current-toggles",
};
let server: CheckpointServer;
let tab: Awaited<ReturnType<typeof bootTab>>;

/** Independent module instances represent tabs, while both transports share the same server. */
async function bootTab() {
    vi.resetModules();
    const client = await import("../storage/resourceClient");
    const sync = await import("../storage/resourceSync.svelte");
    const chat = await import("../storage/chatStore.svelte");
    const bootstrap = await import("../bootstrap");
    const selection = await import("../storage/selection.svelte");
    const checkpoints = await import("./chatCheckpoints.svelte");
    const { language } = await import("src/lang");
    const snapshot = await client.readKinds(KINDS, { chats: true });
    sync.seedResources(snapshot);
    chat.seedChats(snapshot.chats ?? [], snapshot.chatOrders ?? []);
    bootstrap.installBootRecords(snapshot);
    selection.selectCharacter(null);
    chat.initializeChats();
    sync.startResourceSync();
    await tick();
    await sync.flushResources();
    return { client, sync, chat, checkpoints, language };
}

function remoteEdit(ops: ChatOp[]) {
    return server.resources.chatBatch([
        { ...address, baseRevision: server.resources.chat(ref.chaId, ref.chatId)!.revision, ops },
    ]);
}

async function checkpointThenChange() {
    const saved = await tab.checkpoints.saveCheckpoint(ref, "Fork");
    expect(saved.status).toBe("ok");
    if (saved.status !== "ok") throw new Error("Checkpoint setup failed");
    tab.chat.setMessageText(ref, "reply", "Past the fork");
    tab.chat.setChatMeta(ref, {
        ...currentBinding,
        note: "After the journey",
        localLore: [],
        scriptstate: { stage: "ending" },
        hypaV3Data: { summaries: [], categories: [] },
        GLGlobalVariables: { bonus: "later", ephemeral: "remove on load", toggle_light: "1", toggle_new: "kept" },
    });
    await tab.sync.flushResources();
    return saved.checkpoint;
}

const checkpointRequests = (operation: string) => server.requests.filter((r) => r.path.endsWith(`/${operation}`));
const loadAnswer = () => server.answers.findLast((r) => r.path.endsWith("/load"))!.result;
const texts = (client = tab) => client.chat.findChat(ref)!.message.map((message) => message.data);

beforeAll(() => warmMutationGraph(() => import("./chatCheckpoints.svelte")), 60_000);
beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.stubGlobal("location", { reload: vi.fn() });
    mocks.authFetch.mockReset();
    mocks.reloadNotice.mockReset();
    mocks.terminal.mockReset().mockResolvedValue();
    server = await CheckpointServer.create();
    mocks.authFetch.mockImplementation((path, init, options) => {
        options?.beforeDispatch?.();
        return server.fetch(path, init);
    });
    const resources = server.resources;
    resources.set("presets", "main", [{ name: "Default" }]);
    resources.set("modules", "main", []);
    resources.set("plugins", "main", []);
    resources.set("pluginStorage", "main", {});
    resources.store.applyChanges({
        ops: [{ kind: resources.kind("characters"), id: ref.chaId, baseRevision: null, data: { chaId: ref.chaId } }],
        chats: [
            { ...address, baseRevision: null, ops: [{ op: "create", chat: initialChat }] },
            ...["second", "third"].map((chatId) => ({
                characterId: ref.chaId,
                chatId,
                baseRevision: null,
                ops: [{ op: "create", chat: { name: chatId, message: [], note: "", localLore: [] } }],
            })),
        ],
    });
    tab = await bootTab();
    resources.requests.length = 0;
    mocks.authFetch.mockClear();
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    server?.close();
});

describe("chat checkpoints over the server store", () => {
    it("persists policy changes through the service and refuses a missing chat", async () => {
        const policy = { autoEvery: 2, autoKeep: 3 };
        expect(await tab.checkpoints.readCheckpointPolicy(ref)).toEqual({ status: "available", policy: null });
        expect(await tab.checkpoints.writeCheckpointPolicy(ref, policy)).toEqual({ status: "ok", policy });
        expect(server.service.readPolicy({ body: address })).toEqual({
            status: 200,
            body: { epoch: server.store.epoch(), policy },
        });
        expect(await tab.checkpoints.readCheckpointPolicy(ref)).toEqual({ status: "available", policy });
        expect(await tab.checkpoints.writeCheckpointPolicy(ref, null)).toEqual({ status: "ok", policy: null });
        expect(server.service.readPolicy({ body: address }).body.policy).toBeNull();

        const missing = { ...address, chatId: "missing" };
        const query = new URLSearchParams(missing);
        const read = await server.fetch(`/api/chat-checkpoints/policy?${query}`);
        expect(read.status).toBe(404);
        expect(await read.json()).toEqual({ error: "Chat or checkpoint not found" });
        const write = await server.fetch("/api/chat-checkpoints/policy", {
            method: "PUT",
            headers: { "x-resource-epoch": server.store.epoch() },
            body: JSON.stringify({ ...missing, ...policy }),
        });
        expect(write.status).toBe(404);
        expect(await write.json()).toEqual({ error: "Chat or checkpoint not found" });
    });

    it("saves pending message edits before capturing the checkpoint", async () => {
        tab.chat.setMessageText(ref, "reply", "Unsaved draft at the fork");
        expect(server.resources.texts(ref.chaId, ref.chatId)).toEqual(["At the fork"]);
        const result = await tab.checkpoints.saveCheckpoint(ref, "My draft");
        expect(result.status).toBe("ok");
        if (result.status !== "ok") throw new Error("Save failed");
        expect(server.store.checkpoints.compose(ref.chaId, ref.chatId, result.checkpoint.id)?.message).toEqual([
            { chatId: "reply", role: "char", data: "Unsaved draft at the fork" },
        ]);
        expect(checkpointRequests("save")).toHaveLength(1);
        expect(checkpointRequests("save")[0]).toMatchObject({
            method: "POST",
            epoch: server.store.epoch(),
            body: { ...address, name: "My draft" },
        });
    });

    it("does not save a checkpoint when the flush discards this chat", async () => {
        tab.chat.replaceChat(ref, { ...initialChat, note: "Local replacement" });
        remoteEdit([{ op: "setText", id: "reply", text: "Changed elsewhere" }]);
        const result = await tab.checkpoints.saveCheckpoint(ref, "Must not capture discarded work");
        expect(mocks.reloadNotice).toHaveBeenCalledWith(tab.language.resourceReloaded);
        expect(result).toEqual({ status: "not-sent", reason: "discarded" });
        expect(checkpointRequests("save")).toHaveLength(0);
        expect(server.store.checkpoints.list(ref.chaId, ref.chatId)).toEqual([]);
    });

    it("loads story state into the mirror while retaining current bindings and toggles and adopting the answer revision", async () => {
        const checkpoint = await checkpointThenChange();
        const result = await tab.checkpoints.loadCheckpoint(ref, checkpoint.id);
        expect(result).toMatchObject({ status: "loaded", chatRevision: loadAnswer().body.chatRevision });
        expect(tab.chat.findChat(ref)).toMatchObject({
            ...savedStory,
            ...currentBinding,
            GLGlobalVariables: { bonus: "saved", toggle_light: "1", toggle_new: "kept" },
        });
        expect(tab.chat.findChat(ref)!.GLGlobalVariables).not.toHaveProperty("ephemeral");
        expect(tab.chat.heldChatRevision(ref)).toBe(loadAnswer().body.chatRevision);
        expect(checkpointRequests("load")).toHaveLength(1);
    });

    it("discards another tab's queued pre-load text edit with a reload notice and shows the loaded chat", async () => {
        const checkpoint = await checkpointThenChange();
        const olderTab = tab;
        const oldRevision = olderTab.chat.heldChatRevision(ref);
        olderTab.chat.setMessageText(ref, "reply", "Queued in the other tab");
        const loadingTab = await bootTab();
        const loaded = await loadingTab.checkpoints.loadCheckpoint(ref, checkpoint.id);
        expect(loaded.status).toBe("loaded");
        expect(texts(loadingTab)).toEqual(["At the fork"]);
        expect(olderTab.chat.heldChatRevision(ref)).toBe(oldRevision);
        const flushed = await olderTab.sync.flushResources();
        expect(flushed.discarded).toContain(`chats/${ref.chaId}/${ref.chatId}`);
        expect(server.resources.batchBodies().at(-1).chats[0]).toMatchObject({
            ...address,
            baseRevision: oldRevision,
            ops: [{ op: "setText", id: "reply", text: "Queued in the other tab" }],
        });
        expect(mocks.reloadNotice).toHaveBeenCalledWith(olderTab.language.resourceReloaded);
        expect(texts(olderTab)).toEqual(["At the fork"]);
        expect(server.resources.texts(ref.chaId, ref.chatId)).toEqual(["At the fork"]);
        expect(olderTab.chat.heldChatRevision(ref)).toBe(loadAnswer().body.chatRevision);
    });

    it("reports a committed load as refresh pending until an edit made during the held answer is discarded", async () => {
        const checkpoint = await checkpointThenChange();
        const oldRevision = tab.chat.heldChatRevision(ref);
        const held = server.holdLoad("answer");
        const loading = tab.checkpoints.loadCheckpoint(ref, checkpoint.id);
        try {
            await held.entered;
            expect(loadAnswer().status).toBe(200);
            expect(server.resources.texts(ref.chaId, ref.chatId)).toEqual(["At the fork"]);
            expect(get(tab.checkpoints.checkpointLoadBusy)).toBe(true);
            tab.chat.setMessageText(ref, "reply", "Typed while the answer was delayed");
        } finally {
            held.release();
        }
        expect(await loading).toMatchObject({
            status: "refresh-pending",
            chatRevision: loadAnswer().body.chatRevision,
        });
        expect(tab.chat.heldChatRevision(ref)).toBe(oldRevision);
        expect(texts()).toEqual(["Typed while the answer was delayed"]);
        expect(mocks.reloadNotice).not.toHaveBeenCalled();
        const flushed = await tab.sync.flushResources();
        expect(flushed.discarded).toContain(`chats/${ref.chaId}/${ref.chatId}`);
        expect(mocks.reloadNotice).toHaveBeenCalledWith(tab.language.resourceReloaded);
        expect(texts()).toEqual(["At the fork"]);
        expect(tab.chat.heldChatRevision(ref)).toBe(loadAnswer().body.chatRevision);
        expect(checkpointRequests("load")).toHaveLength(1);
        expect(get(tab.checkpoints.checkpointLoadBusy)).toBe(false);
    });

    it("reports a conflict and keeps an edit that commits before the held load request", async () => {
        const checkpoint = await checkpointThenChange();
        const held = server.holdLoad("request");
        const loading = tab.checkpoints.loadCheckpoint(ref, checkpoint.id);
        try {
            await held.entered;
            remoteEdit([{ op: "setText", id: "reply", text: "Won the race" }]);
        } finally {
            held.release();
        }
        expect(await loading).toEqual({ status: "error", reason: "conflict" });
        expect(loadAnswer().status).toBe(409);
        expect(texts()).toEqual(["Won the race"]);
        expect(server.resources.texts(ref.chaId, ref.chatId)).toEqual(["Won the race"]);
        expect(server.store.checkpoints.list(ref.chaId, ref.chatId)?.map((row) => row.kind)).toEqual(["manual"]);
        expect(checkpointRequests("load")).toHaveLength(1);
    });

    it("halts on an epoch mismatch and sends nothing after the reload notice", async () => {
        const acknowledge = deferred();
        mocks.terminal.mockReturnValue(acknowledge.promise);
        const beforeReload = vi.fn();
        tab.sync.beforeRestoreReload(beforeReload);
        tab.client.setResourceEpoch("obsolete-epoch");
        await expect(tab.checkpoints.saveCheckpoint(ref, "Wrong epoch")).rejects.toBeInstanceOf(
            tab.client.ResourceEpochMismatchError,
        );
        expect(server.answers.at(-1)?.result.status).toBe(412);
        expect(beforeReload).toHaveBeenCalledOnce();
        expect(mocks.terminal).toHaveBeenCalledExactlyOnceWith(tab.language.resourceRestored);
        expect(location.reload).not.toHaveBeenCalled();
        const sent = server.requests.length + server.resources.requests.length;
        expect(await tab.checkpoints.saveCheckpoint(ref, "After halt")).toMatchObject({ status: "not-sent" });
        expect(server.requests.length + server.resources.requests.length).toBe(sent);
        expect(server.store.checkpoints.list(ref.chaId, ref.chatId)).toEqual([]);
        acknowledge.resolve();
        await tick();
        expect(location.reload).toHaveBeenCalledOnce();
    });

    it("re-reads after a lost load answer and reports an unknown outcome without retrying", async () => {
        const checkpoint = await checkpointThenChange();
        server.dropLoadAnswer = true;
        expect(await tab.checkpoints.loadCheckpoint(ref, checkpoint.id)).toEqual({ status: "unknown" });
        expect(checkpointRequests("load")).toHaveLength(1);
        expect(texts()).toEqual(["At the fork"]);
        expect(tab.chat.heldChatRevision(ref)).toBe(loadAnswer().body.chatRevision);
        expect(
            server.store.checkpoints.list(ref.chaId, ref.chatId)?.filter((row) => row.kind === "safety"),
        ).toHaveLength(1);
    });
});
