import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationEvent, GenerationTerminalEvent } from "../../../shared/jobs.ts";
import type { ChatRef } from "../storage/chatStore.svelte";
import { warmModules } from "../storage/tests/mutationStoresHarness";

// Real chat selection and generation locks, with only the job transport and unrelated UI/network
// services stubbed. Terminal marks are produced by followJobToEnd; direct status writes below
// exercise the public sources when testing the watcher's clearing and the unseen capacity.
const EPOCH = "11111111-2222-4333-8444-555555555555";
const a: ChatRef = { chaId: "c", chatId: "k" };
const b: ChatRef = { chaId: "c", chatId: "j" };
const other: ChatRef = { chaId: "d", chatId: "k" };
const playground: ChatRef = { chaId: "§playground", chatId: "p" };
const keyA = "c\u0000k";
const keyB = "c\u0000j";
const keyOther = "d\u0000k";
const keyPlayground = "§playground\u0000p";
const done = (fields: Partial<Extract<GenerationTerminalEvent, { type: "done" }>> = {}): GenerationTerminalEvent => ({
    type: "done",
    epoch: EPOCH,
    revision: "e:1:2",
    ...fields,
});
const error: GenerationTerminalEvent = {
    type: "error",
    epoch: EPOCH,
    message: "failed",
    status: 500,
    reason: "failed",
};

type Follow = {
    jobId: string;
    end: (terminal: GenerationTerminalEvent | null) => void;
    event: (event: GenerationEvent) => void;
};
const stubs = vi.hoisted(() => ({
    follows: [] as Follow[],
    attached: undefined as (() => void) | undefined,
    closeWithoutTerminal: false,
    read: vi.fn(),
    healthFetch: vi.fn<typeof import("../storage/serverAuth").authFetch>(),
}));

vi.mock("../storage/serverAuth", async () =>
    (await import("../storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: stubs.healthFetch }),
);

vi.mock("src/lang", () => ({
    language: { serverJob: { lost: "job lost", endedAway: "ended away" } },
}));
vi.mock("../alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("../network/generationJobs", async () => {
    const { createGenerationJobsMock, createFollowStub } = await import("../network/tests/generationJobsMock");
    return createGenerationJobsMock({
        followGenerationJob: (jobId, onEvent, options) => {
            const stub = createFollowStub(jobId);
            const end: Follow["end"] = (terminal) => {
                if (terminal) onEvent(terminal);
                stub.end(terminal);
            };
            stubs.follows.push({ jobId, end, event: onEvent });
            stubs.attached?.();
            if (stubs.closeWithoutTerminal) end(null);
            return stub.follow;
        },
        readGenerationJob: stubs.read,
    });
});
vi.mock("../storage/resourceClient", async () =>
    (await import("../storage/tests/resourceClientMock")).createResourceClientMock({
        getResourceEpoch: () => EPOCH,
    }),
);
vi.mock("../storage/resourceSync.svelte", async () =>
    (await import("../tests/bootMocks")).createBootMock("resourceSync", {
        /** The chat read after a lost follow takes at once: no retry listener outlives a test. */
        refreshStaleChat: vi.fn<typeof import("../storage/resourceSync.svelte").refreshStaleChat>(async () => true),
        generatingNoticeCount: () => 0,
    }),
);
vi.mock("../util", () => ({ sleep: async () => {} }));
vi.mock("../diagnostics/collector", async () =>
    (await import("../diagnostics/tests/collectorMock")).createCollectorMock(),
);
// The server send and the command module's unrelated services (TTS, the parser, lore) are stand-ins.
vi.mock("./serverGeneration", () => ({
    sendChatOnServer: vi.fn(async () => ({ ok: true, outcome: "started" })),
}));
vi.mock("./tts", () => ({ sayTTS: vi.fn() }));
vi.mock("../parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("./lorebook.svelte", () => ({ loadLoreBookV3Prompt: vi.fn(async () => ({ actives: [] })) }));
vi.mock("./modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));

let status: typeof import("./chatStatus.svelte");
let commands: typeof import("./serverCommands");
let chat: typeof import("../storage/chatStore.svelte");
let selection: typeof import("../storage/selection.svelte");
let flushSync: (typeof import("svelte"))["flushSync"];
const disposers: (() => void)[] = [];

function watch() {
    const dispose = status.watchChatVisibility();
    disposers.push(dispose);
    flushSync();
    return dispose;
}

function view(ref: ChatRef) {
    selection.selectCharacter(ref.chaId);
    chat.selectChat(ref.chaId, ref.chatId);
    selection.PlaygroundStore.set(ref.chaId === "§playground" ? 2 : 0);
    selection.setChatOpen(true);
}

async function attach(jobId: string, ref: ChatRef) {
    const end = commands.followJobToEnd(jobId, ref);
    await vi.waitFor(() => expect(stubs.follows.some((follow) => follow.jobId === jobId)).toBe(true));
    return { end, socket: stubs.follows.find((follow) => follow.jobId === jobId)! };
}

async function finish(jobId: string, ref: ChatRef, terminal: GenerationTerminalEvent) {
    const follow = await attach(jobId, ref);
    follow.socket.end(terminal);
    expect(await follow.end).toEqual(terminal);
}

function expectMarks(keys: string[]) {
    expect(get(status.unseenChatKeys)).toEqual(new Set(keys));
    expect(new Set(get(status.recoveryChatKeys).keys())).toEqual(new Set(keys));
}

beforeAll(
    () =>
        warmModules(() =>
            Promise.all([
                import("../storage/chatStore.svelte"),
                import("../storage/selection.svelte"),
                import("../storage/tests/installFlatDatabase"),
                import("../storage/tests/reactiveProbe.svelte"),
                import("./serverCommands"),
                import("./chatStatus.svelte"),
            ]),
        ),
    60_000,
);

beforeEach(async () => {
    vi.resetModules();
    // Use the same Svelte runtime as the fresh rune modules, including its effect queue.
    ({ flushSync } = await import("svelte"));
    localStorage.clear();
    sessionStorage.clear();
    stubs.healthFetch.mockReset();
    stubs.follows.length = 0;
    stubs.attached = undefined;
    stubs.closeWithoutTerminal = false;
    stubs.read.mockReset().mockResolvedValue({ characterId: "c", chatId: "k", epoch: EPOCH, state: "running" });
    chat = await import("../storage/chatStore.svelte");
    selection = await import("../storage/selection.svelte");
    const { installFlatDatabaseWithChats } = await import("../storage/tests/installFlatDatabase");
    const fixtureChat = (id: string) => ({
        id,
        name: id,
        note: "",
        localLore: [],
        message: [
            { chatId: "m1", role: "char", data: "one" },
            { chatId: "m2", role: "char", data: "two" },
        ],
    });
    installFlatDatabaseWithChats({
        characters: [
            { chaId: "c", name: "C", chats: [fixtureChat("k"), fixtureChat("j")] },
            { chaId: "d", name: "D", chats: [fixtureChat("k")] },
            { chaId: "§playground", name: "Playground", chats: [fixtureChat("p")] },
        ],
    });
    chat.initializeChats();
    selection.selectCharacter(null);
    selection.PlaygroundStore.set(0);
    commands = await import("./serverCommands");
    status = await import("./chatStatus.svelte");
    status.resetChatStatusForTests();
});

afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    chat.endServerJob("lock-a");
    chat.endServerJob("lock-other-1");
    chat.endServerJob("lock-other-2");
    status.resetChatStatusForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("chat status sources", () => {
    it.each([
        "settings",
        "grid",
        "bookmarks",
        "message search",
        "HypaV3 memory",
        "popup editor",
        "hidden page",
        "unloaded chat",
    ])("keeps completion and recovery marks behind %s until the transcript is shown", async (obstruction) => {
        vi.useFakeTimers();
        const { settingsOpen, gridOpenStore, bookmarkListOpen, hypaV3ModalOpen } = await import("../screenVisibility");
        const { messageSearchPanel } = await import("../messageSearch.svelte");
        const { popUpEditorStore } = await import("../popupEditorSession.svelte");
        const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
        const showPage = (visible: boolean) => {
            visibility.mockReturnValue(visible ? "visible" : "hidden");
            document.dispatchEvent(new Event("visibilitychange"));
        };
        view(a);
        watch();
        const saved = JSON.parse(JSON.stringify(chat.findChat(a)!));
        const record = { characterId: a.chaId, id: a.chatId, revision: "r1" };
        const orders = [{ characterId: a.chaId, revision: "o1", ids: [a.chatId] }];
        if (obstruction === "settings") settingsOpen.set(true);
        if (obstruction === "grid") gridOpenStore.set(true);
        if (obstruction === "bookmarks") bookmarkListOpen.set(true);
        if (obstruction === "message search") messageSearchPanel.open = true;
        if (obstruction === "HypaV3 memory") hypaV3ModalOpen.set(true);
        if (obstruction === "popup editor") popUpEditorStore.open = true;
        if (obstruction === "hidden page") showPage(false);
        if (obstruction === "unloaded chat") {
            chat.assembleChats([{ chaId: a.chaId }], [{ ...record, name: saved.name, fmIndex: -1 }], orders);
            expect(chat.currentChatRef()).toEqual(a);
            expect(chat.findChat(a)).toBeUndefined();
        }
        flushSync();
        status.noteJobDone(a, done({ messageId: "reply" }));
        expect(get(status.unseenChatKeys)).toEqual(new Set([keyA]));
        status.noteJobLost(a, "lost-behind-screen");
        flushSync();
        expectMarks([keyA]);

        settingsOpen.set(false);
        gridOpenStore.set(false);
        bookmarkListOpen.set(false);
        messageSearchPanel.open = false;
        hypaV3ModalOpen.set(false);
        popUpEditorStore.open = false;
        showPage(true);
        if (obstruction === "unloaded chat") {
            chat.assembleChats([{ chaId: a.chaId }], [{ ...record, data: saved }], orders);
        }
        flushSync();
        expectMarks([]);
        status.noteJobDone(a, done({ messageId: "visible-reply" }));
        expect(get(status.unseenChatKeys)).toEqual(new Set());
    });

    it("generating reacts to the union of followed chats and real server locks", async () => {
        expect(status.chatStatusKey(a)).toBe(keyA);
        expect(status.chatStatusKey(other)).toBe(keyOther);
        const { createProbe } = await import("../storage/tests/reactiveProbe.svelte");
        const probe = createProbe(() => status.generatingChatKeys());
        disposers.push(probe.dispose);
        const expectGenerating = (keys: string[]) => {
            flushSync();
            expect(status.generatingChatKeys()).toEqual(new Set(keys));
            expect(probe.seen.at(-1)).toEqual(new Set(keys));
        };
        expectGenerating([]);
        const first = await attach("follow-a-1", a);
        const second = await attach("follow-a-2", a);
        expectGenerating([keyA]);
        const lock = (ref: ChatRef, jobId: string, messageId: string) =>
            expect(
                chat.applyServerGeneration(ref, { jobId, messageId, generationId: jobId, text: "partial", seq: 0 }),
            ).toBe(true);
        lock(other, "lock-other-1", "m1");
        lock(other, "lock-other-2", "m2");
        lock(a, "lock-a", "m1");
        expect(chat.lockedChatKeys()).toEqual(new Set([keyA, keyOther]));
        expectGenerating([keyA, keyOther]);
        first.socket.end(done());
        await first.end;
        expectGenerating([keyA, keyOther]);
        chat.endServerJob("lock-a");
        expectGenerating([keyA, keyOther]);
        second.socket.end(done());
        await second.end;
        expectGenerating([keyOther]);
        chat.endServerJob("lock-other-1");
        expectGenerating([keyOther]);
        chat.endServerJob("lock-other-2");
        expect(chat.lockedChatKeys()).toEqual(new Set());
        expectGenerating([]);
    });

    it("clears a foreign mark when its server lock is released and retains a lockless chat's mark", () => {
        vi.useFakeTimers();
        watch();
        status.noteForeignJob(a, "foreign-reply");
        status.noteForeignJob(b, "lockless-command");
        chat.noteRemoteStreaming([
            { characterId: a.chaId, id: a.chatId, streaming: [{ messageId: "m1", generationId: "g", seq: 0 }] },
        ]);
        flushSync();
        expect(get(status.foreignJobs)).toEqual(
            new Map([
                [keyA, "foreign-reply"],
                [keyB, "lockless-command"],
            ]),
        );

        chat.releaseFeedLocks();
        flushSync();
        expect(get(status.foreignJobs)).toEqual(new Map([[keyB, "lockless-command"]]));
    });

    it("only a done reply outside the chat visible at completion becomes unseen", async () => {
        view(a);
        await finish("away", b, done({ messageId: "reply" }));
        expect(get(status.unseenChatKeys)).toEqual(new Set([keyB]));
        // This assertion does not rely on the watcher repairing an incorrect terminal mark.
        await finish("visible", a, done({ messageId: "reply" }));
        expect(get(status.unseenChatKeys)).toEqual(new Set([keyB]));
        await finish("preview", other, done());
        await finish("empty-id", other, done({ messageId: "" }));
        await finish("error", other, error);
        expect(get(status.unseenChatKeys)).toEqual(new Set([keyB]));
        expect(get(status.recoveryChatKeys)).toEqual(new Map());
        await finish("stopped-reply", other, done({ messageId: "partial-reply", stopped: true }));
        expect(get(status.unseenChatKeys)).toEqual(new Set([keyB, keyOther]));

        const switched = await attach("switched", a);
        view(b);
        switched.socket.end(done({ messageId: "late-reply" }));
        await switched.end;
        expect(get(status.unseenChatKeys)).toEqual(new Set([keyB, keyOther, keyA]));
    });

    it("lost reattaches and failed chat loads mark recovery; gone discovery marks nothing", async () => {
        watch();
        stubs.closeWithoutTerminal = true;
        expect(await commands.followJobToEnd("exhausted", a)).toBe("lost");
        expect(get(status.recoveryChatKeys)).toEqual(new Map([[keyA, "exhausted"]]));
        expect(get(status.unseenChatKeys)).toEqual(new Set());

        stubs.read.mockResolvedValue({ characterId: other.chaId, chatId: other.chatId, epoch: EPOCH });
        const load = vi.spyOn(chat, "ensureChatLoaded").mockRejectedValue(new Error("chat load failed"));
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(await commands.followJobToEnd("load-failed")).toBe("lost");
        load.mockRestore();
        log.mockRestore();
        expect(get(status.recoveryChatKeys)).toEqual(
            new Map([
                [keyA, "exhausted"],
                [keyOther, "load-failed"],
            ]),
        );
        stubs.read.mockResolvedValue(null);
        expect(await commands.followJobToEnd("gone")).toBe("lost");
        expect(get(status.recoveryChatKeys)).toEqual(
            new Map([
                [keyA, "exhausted"],
                [keyOther, "load-failed"],
            ]),
        );
        expect(get(status.unseenChatKeys)).toEqual(new Set());
        expect(status.generatingChatKeys()).toEqual(new Set());
    });

    it("viewing clears both marks only on the open chat screen, including playground screen 2", () => {
        for (const ref of [a, b, other, playground]) {
            status.noteJobDone(ref, done({ messageId: "reply" }));
            status.noteJobLost(ref, "lost");
        }
        watch();
        expect(status.visibleChatKey()).toBeNull();
        expectMarks([keyA, keyB, keyOther, keyPlayground]);
        selection.selectCharacter("c");
        chat.selectChat("c", "k");
        flushSync();
        expect(status.visibleChatKey()).toBeNull();
        expectMarks([keyA, keyB, keyOther, keyPlayground]);
        selection.setChatOpen(true);
        for (const screen of [1, 2]) {
            selection.PlaygroundStore.set(screen);
            flushSync();
            expect(status.visibleChatKey()).toBeNull();
            expectMarks([keyA, keyB, keyOther, keyPlayground]);
        }
        selection.PlaygroundStore.set(0);
        flushSync();
        expect(status.visibleChatKey()).toBe(keyA);
        expectMarks([keyB, keyOther, keyPlayground]);
        chat.selectChat("c", "j");
        flushSync();
        expect(status.visibleChatKey()).toBe(keyB);
        expectMarks([keyOther, keyPlayground]);
        selection.selectCharacter("d");
        flushSync();
        expect(status.visibleChatKey()).toBeNull();
        expectMarks([keyOther, keyPlayground]);
        selection.setChatOpen(true);
        flushSync();
        expect(status.visibleChatKey()).toBe(keyOther);
        expectMarks([keyPlayground]);
        selection.selectCharacter("§playground");
        flushSync();
        expect(selection.selection.chatOpen).toBe(false);
        expect(status.visibleChatKey()).toBeNull();
        expectMarks([keyPlayground]);
        selection.PlaygroundStore.set(2);
        flushSync();
        expect(status.visibleChatKey()).toBe(keyPlayground);
        expectMarks([]);
    });

    it("viewing a lost chat reads it again (`readChatAgain`): the chat is marked stale and refreshed, once per cleared recovery mark, and an unseen-only chat is not read", async () => {
        const { refreshStaleChat } = await import("../storage/resourceSync.svelte");
        const refresh = vi.mocked(refreshStaleChat);
        refresh.mockClear();
        // The fixture chats hold no server revision: the stale mark is taken as given.
        const stale = vi.spyOn(chat, "markChatStale").mockReturnValue(true);
        status.noteJobLost(a, "lost");
        status.noteJobDone(b, done({ messageId: "reply" }));
        watch();
        view(a);
        flushSync();
        expect(get(status.recoveryChatKeys)).toEqual(new Map());
        expect(get(status.unseenChatKeys)).toEqual(new Set([keyB]));
        await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
        expect(refresh).toHaveBeenCalledWith(a);
        expect(stale).toHaveBeenCalledWith(a);
        view(b);
        flushSync();
        expect(get(status.unseenChatKeys)).toEqual(new Set());
        await Promise.resolve();
        await Promise.resolve();
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("marks added for an already visible chat are cleared without another selection change", () => {
        view(a);
        watch();
        status.noteJobLost(a, "late-loss");
        status.noteJobLost(b, "other-loss");
        // The source is public and writable; the watcher must track its updates, even when the
        // visible key stays the same (noteJobDone itself already refuses visible replies).
        status.unseenChatKeys.set(new Set([keyA, keyB]));
        flushSync();
        expectMarks([keyB]);
    });

    it("a new follow immediately clears that chat's recovery while keeping its unseen reply", async () => {
        vi.useFakeTimers();
        const { settingsOpen } = await import("../screenVisibility");
        view(a);
        settingsOpen.set(true);
        watch();
        status.noteJobLost(a, "old-a");
        status.noteJobLost(b, "old-b");
        status.noteJobDone(a, done({ messageId: "reply" }));
        const end = commands.followJobToEnd("new-a", a);
        flushSync();
        // The follow's registration clears the recovery mark, before the job ends.
        expect(get(status.recoveryChatKeys)).toEqual(new Map([[keyB, "old-b"]]));
        expect(get(status.unseenChatKeys)).toEqual(new Set([keyA]));
        await vi.advanceTimersByTimeAsync(0);
        expect(stubs.follows).toHaveLength(1);
        stubs.follows[0].end(done());
        await end;
        flushSync();
        expect(get(status.recoveryChatKeys)).toEqual(new Map([[keyB, "old-b"]]));
        expect(get(status.unseenChatKeys)).toEqual(new Set([keyA]));
    });

    it("unseen retains at most 256 chats and drops the oldest", () => {
        const keys = Array.from({ length: 257 }, (_, i) => `c\u0000chat-${i}`);
        for (let i = 0; i < 256; i++) {
            status.noteJobDone({ chaId: "c", chatId: `chat-${i}` }, done({ messageId: "reply" }));
        }
        expect(get(status.unseenChatKeys)).toEqual(new Set(keys.slice(0, 256)));
        status.noteJobDone({ chaId: "c", chatId: "chat-256" }, done({ messageId: "reply" }));
        expect(get(status.unseenChatKeys).size).toBe(256);
        expect(get(status.unseenChatKeys)).toEqual(new Set(keys.slice(1)));
    });

    it("disposing the watcher stops visibility and new-follow clearing", async () => {
        const dispose = watch();
        for (const ref of [a, b]) {
            status.noteJobDone(ref, done({ messageId: "reply" }));
            status.noteJobLost(ref, "lost");
        }
        flushSync();
        dispose();
        view(a);
        flushSync();
        expect(status.visibleChatKey()).toBe(keyA);
        expectMarks([keyA, keyB]);
        await finish("after-disposal", b, done());
        flushSync();
        expectMarks([keyA, keyB]);
    });
});

describe("isChatBusy", () => {
    it("keeps a pending worker foreign, moves it to followed only as owner, and clears both at its end", async () => {
        vi.useFakeTimers();
        status.noteForeignJob(a, "taken-over");
        const ready = new Promise<void>((resolve) => {
            stubs.attached = resolve;
        });
        const end = commands.followJobToEnd("taken-over", a, undefined, { ticket: "worker-ticket" });
        await ready;
        const socket = stubs.follows[0];
        socket.event({ type: "handoff", epoch: EPOCH, owner: "other", pending: true });
        expect(get(status.foreignJobs)).toEqual(new Map([[keyA, "taken-over"]]));
        expect(get(commands.followedJobs).size).toBe(0);
        socket.event({ type: "handoff", epoch: EPOCH, owner: "self" });
        expect(get(status.foreignJobs).size).toBe(0);
        expect(get(commands.followedJobs)).toEqual(new Map([["taken-over", keyA]]));
        const terminal = done();
        socket.end(terminal);
        expect(await end).toEqual(terminal);
        expect(get(status.foreignJobs).size).toBe(0);
        expect(get(commands.followedJobs).size).toBe(0);
    });

    it("is true for a chat with a local send, a followed job, or a lock (this tab's or the feed's), for that chat only", async () => {
        const { beginLocalSend } = await import("./localSends");
        expect(status.isChatBusy(a)).toBe(false);
        const release = beginLocalSend(a)!;
        expect(status.isChatBusy(a)).toBe(true);
        expect(status.isChatBusy(b)).toBe(false);
        release();
        expect(status.isChatBusy(a)).toBe(false);

        const follow = await attach("follow-b", b);
        expect(status.isChatBusy(b)).toBe(true);
        expect(status.isChatBusy(a)).toBe(false);
        follow.socket.end(done());
        await follow.end;
        expect(status.isChatBusy(b)).toBe(false);

        expect(
            chat.applyServerGeneration(other, {
                jobId: "lock-other-1",
                messageId: "m1",
                generationId: "lock-other-1",
                text: "partial",
                seq: 0,
            }),
        ).toBe(true);
        expect(status.isChatBusy(other)).toBe(true);
        expect(status.isChatBusy(a)).toBe(false);
        chat.endServerJob("lock-other-1");
        expect(status.isChatBusy(other)).toBe(false);

        chat.noteRemoteStreaming([
            { characterId: "c", id: "j", streaming: [{ messageId: "m1", generationId: "g", seq: 0 }] },
        ]);
        expect(status.isChatBusy(b)).toBe(true);
        expect(status.isChatBusy(a)).toBe(false);
        chat.releaseFeedLocks();
        expect(status.isChatBusy(b)).toBe(false);
    });
});

const healthy = { paused: false, storedStale: 0, pendingRepairs: 0, unsupportedSections: 0, overBudgetSections: 0 };
async function enableMemory() {
    const { settings } = await import("../storage/settingsViews.svelte");
    const { characterList } = await import("../storage/characterStore.svelte");
    const { createHypaV3Preset } = await import("../../../shared/hypaV3Presets.ts");
    settings.ui.memoryAlgorithmType = "structuredMemory";
    settings.hypaV3Presets.items = [
        createHypaV3Preset("Memory", { gapConfirmTokens: 10, structured: { fineTuning: true } }, "memory"),
    ];
    settings.hypaV3Presets.selectedId = "memory";
    for (const character of characterList()) character.supaMemory = true;
    return settings;
}
async function settleHealth() {
    for (let i = 0; i < 50; i++) {
        await Promise.resolve();
        flushSync();
    }
}

it("reads only pinned and open health on visibility triggers, resumes prefixes and keeps facts on failure", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(100_000);
    const settings = await enableMemory();
    settings.ui.memoryAlgorithmType = "none";
    chat.setChatMeta(b, { pinned: true });
    view(a);
    const { hypaV3ModalOpen } = await import("../screenVisibility");
    hypaV3ModalOpen.set(false);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    const requests: { characterId: string; chatId: string }[][] = [];
    let release!: (response: Response) => void;
    stubs.healthFetch.mockImplementation(async (url, init) => {
        expect(url).toBe("/api/memory/structured/health");
        const refs = JSON.parse(String(init?.body)).chats;
        requests.push(refs);
        if (requests.length === 1)
            return new Promise((resolve) => {
                release = resolve;
            });
        return Response.json({
            health: refs.map((ref: { characterId: string; chatId: string }) =>
                ref.characterId === "c" && ref.chatId === "k" ? { ...healthy, storedStale: 1 } : healthy,
            ),
        });
    });
    watch();
    await settleHealth();
    expect(requests).toEqual([]);
    expect(status.memoryHealthStates().size).toBe(0);
    settings.ui.memoryAlgorithmType = "structuredMemory";
    await settleHealth();
    expect(requests).toEqual([
        [
            { characterId: "c", chatId: "k" },
            { characterId: "c", chatId: "j" },
        ],
    ]);
    // The open chat remains usable while the boot read is unanswered, and a custom writer prompt is no state.
    expect(chat.currentChatRef()).toEqual(a);
    expect(status.memoryHealthStates().size).toBe(0);
    release(Response.json({ health: [{ ...healthy, storedStale: 1 }] }));
    await settleHealth();
    expect(requests[1]).toEqual([{ characterId: "c", chatId: "j" }]);
    expect(status.memoryHealthStates().get(keyA)).toBe("staleEvents");
    chat.setChatMeta(other, { pinned: true });
    await settleHealth();
    expect(requests.at(-1)).toEqual([{ characterId: "d", chatId: "k" }]);
    const count = requests.length;
    const { beginLocalSend } = await import("./localSends");
    const endSend = beginLocalSend(a)!;
    commands.followedJobs.set(new Map([["stream", keyA]]));
    chat.setMessageText(a, "m2", "Streaming reply");
    const tasks = await import("./memoryTasks.svelte");
    tasks.noteMemoryTaskFrame({
        type: "memoryTask",
        epoch: EPOCH,
        characterId: "c",
        chatId: "k",
        status: {
            kind: "structuredMemory",
            taskId: "memory",
            state: "done",
            done: 1,
            total: 1,
            terminalRevision: null,
        },
    });
    await settleHealth();
    expect(tasks.memoryTaskStatus(a)?.state).toBe("done");
    endSend();
    commands.followedJobs.set(new Map());
    status.noteJobDone(a, done({ messageId: "m2" }));
    await settleHealth();
    expect(requests).toHaveLength(count);
    view(b);
    await settleHealth();
    expect(requests.at(-1)).toEqual([{ characterId: "c", chatId: "j" }]);
    hypaV3ModalOpen.set(true);
    await settleHealth();
    const beforeClose = requests.length;
    hypaV3ModalOpen.set(false);
    await settleHealth();
    expect(requests).toHaveLength(beforeClose + 1);
    expect(requests.at(-1)).toEqual([{ characterId: "c", chatId: "j" }]);
    const returnPage = async () => {
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
        await settleHealth();
        visibility.mockReturnValue("visible");
        document.dispatchEvent(new Event("visibilitychange"));
        await settleHealth();
    };
    vi.setSystemTime(159_999);
    await returnPage();
    expect(requests).toHaveLength(beforeClose + 1);
    vi.setSystemTime(160_000);
    await returnPage();
    expect(requests.at(-1)).toEqual([
        { characterId: "c", chatId: "j" },
        { characterId: "d", chatId: "k" },
    ]);
    const afterMinute = requests.length;
    await returnPage();
    expect(requests).toHaveLength(afterMinute);
    view(a);
    await settleHealth();
    stubs.healthFetch.mockRejectedValue(new Error("offline"));
    const held = new Map(status.memoryHealthStates());
    hypaV3ModalOpen.set(true);
    await settleHealth();
    hypaV3ModalOpen.set(false);
    await settleHealth();
    expect(status.memoryHealthStates()).toEqual(held);
    settings.ui.memoryAlgorithmType = "hypaV3";
    const calls = stubs.healthFetch.mock.calls.length;
    vi.setSystemTime(220_000);
    await returnPage();
    expect(stubs.healthFetch).toHaveBeenCalledTimes(calls);
    expect(status.memoryHealthStates().size).toBe(0);
    tasks.resetMemoryTasks();
});

it("marks required overflow and clears successful sends strictly by character and chat", async () => {
    await enableMemory();
    view(a);
    chat.setChatMeta(b, { pinned: true });
    chat.setChatMeta(other, { pinned: true });
    const overflow = { ...error, code: "memoryRequiredOverCap" as const };
    status.noteJobDone(a, overflow);
    expect(status.memoryHealthStates()).toEqual(new Map([[keyA, "requiredOverCap"]]));
    status.noteJobDone(b, error);
    status.noteJobDone(a, error);
    status.noteJobDone(other, done({ messageId: "reply" }));
    status.noteJobDone(a, done());
    expect(status.memoryHealthStates()).toEqual(new Map([[keyA, "requiredOverCap"]]));
    status.noteJobDone(other, overflow);
    status.noteJobDone(b, done({ messageId: "reply" }));
    expect(status.memoryHealthStates()).toEqual(
        new Map([
            [keyA, "requiredOverCap"],
            [keyOther, "requiredOverCap"],
        ]),
    );
    status.noteJobDone(a, done({ messageId: "reply" }));
    expect(status.memoryHealthStates()).toEqual(new Map([[keyOther, "requiredOverCap"]]));
    status.noteJobDone(other, done({ messageId: "reply" }));
    expect(status.memoryHealthStates().size).toBe(0);
    expect(stubs.healthFetch).not.toHaveBeenCalled();
});

it("uses the newest report's strict gap threshold only for memory-enabled chats, with no custom-prompt state", async () => {
    const settings = await enableMemory();
    view(a);
    chat.setChatMeta(b, { pinned: true });
    const report = (gapTokens?: number) => ({
        v: 1 as const,
        maxContext: 1000,
        maxResponse: 100,
        input: 300,
        sections: [],
        adjustment: 300,
        attributionExact: true,
        history: { total: 2, kept: 1, totalUser: 1, keptUser: 1, droppedTokens: 20 },
        lore: { budgetUsed: 0, budget: 0, rejectedCount: 0, rejectedTokens: 0, active: 0 },
        tokenScope: "scope",
        historyDigest: "digest",
        memory: {
            kind: "structuredMemory" as const,
            tokens: 0,
            coverage: "gap" as const,
            ...(gapTokens === undefined ? {} : { gapTokens }),
        },
    });
    chat.patchMessage(a, "m1", { generationInfo: { context: report(99) } });
    for (const [tokens, expected] of [
        [11, new Map([[keyA, "gap"]])],
        [10, new Map()],
        [undefined, new Map()],
    ] as const) {
        chat.patchMessage(a, "m2", { generationInfo: { context: report(tokens) } });
        expect(status.memoryHealthStates()).toEqual(expected);
    }
    chat.patchMessage(a, "m2", { generationInfo: { context: report(11) } });
    expect(status.memoryHealthStates().size).toBe(1);
    const { findCharacter } = await import("../storage/characterStore.svelte");
    Object.assign(findCharacter("c")!, { supaMemory: false });
    expect(status.memoryHealthStates().size).toBe(0);
    Object.assign(findCharacter("c")!, { supaMemory: true });
    settings.ui.memoryAlgorithmType = "none";
    expect(status.memoryHealthStates().size).toBe(0);
    expect(stubs.healthFetch).not.toHaveBeenCalled();
});
