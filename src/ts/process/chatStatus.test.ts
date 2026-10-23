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

type Follow = { jobId: string; end: (terminal: GenerationTerminalEvent | null) => void };
const stubs = vi.hoisted(() => ({
    follows: [] as Follow[],
    closeWithoutTerminal: false,
    read: vi.fn(),
    /** The sends `sendChat` handed to the server (a command job's follow-ups). */
    serverSends: [] as { target?: ChatRef }[],
}));

vi.mock("src/lang", () => ({ language: { serverJob: { lost: "job lost" } } }));
vi.mock("../alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("../network/generationJobs", () => ({
    abortGenerationJob: vi.fn(),
    applyGenerationEvent: vi.fn(),
    createGenerationJob: vi.fn(),
    followGenerationJob: (jobId: string, onEvent: (event: GenerationEvent) => void) => {
        let end!: Follow["end"];
        const closed = new Promise<{ terminal: GenerationTerminalEvent | null }>((resolve) => {
            end = (terminal) => {
                if (terminal) onEvent(terminal);
                resolve({ terminal });
            };
        });
        stubs.follows.push({ jobId, end });
        if (stubs.closeWithoutTerminal) end(null);
        return { closed, send: () => true, close() {} };
    },
    ChatBindingRefusedError: class extends Error {},
    GenerationBusyError: class extends Error {},
    readGenerationJob: stubs.read,
    releaseGenerationJob: vi.fn(),
    savedGenerationJobIds: () => [],
}));
vi.mock("../storage/resourceClient", () => ({
    getResourceEpoch: () => EPOCH,
    readRefs: vi.fn(),
    ResourceRequestError: class extends Error {},
}));
vi.mock("../storage/resourceSync.svelte", () => ({
    flushResources: vi.fn(),
    refreshStaleChat: vi.fn(),
    GenerationBlockedError: class extends Error {},
    generatingNoticeCount: () => 0,
    watchForRestore: vi.fn(),
}));
vi.mock("../util", () => ({ sleep: async () => {} }));
vi.mock("../diagnostics/collector", () => ({ recordClientEvent: vi.fn() }));
// A command job's follow-ups reach the real `runMultisend` and `sendChat`; only the server send and
// the command module's unrelated services (TTS, the parser, lore) are stand-ins.
vi.mock("./serverGeneration", () => ({
    sendChatOnServer: vi.fn(async (arg: { target?: ChatRef }) => {
        stubs.serverSends.push({ target: arg.target });
        return { ok: true, outcome: "started" };
    }),
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
    stubs.follows.length = 0;
    stubs.serverSends.length = 0;
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
});

describe("chat status sources", () => {
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
        watch();
        status.noteJobLost(a, "old-a");
        status.noteJobLost(b, "old-b");
        status.noteJobDone(a, done({ messageId: "reply" }));
        const end = commands.followJobToEnd("new-a", a);
        flushSync();
        // The follow's registration clears the recovery mark, before the job ends.
        expect(get(status.recoveryChatKeys)).toEqual(new Map([[keyB, "old-b"]]));
        expect(get(status.unseenChatKeys)).toEqual(new Set([keyA]));
        await vi.waitFor(() => expect(stubs.follows).toHaveLength(1));
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

describe("a command job's follow-ups", () => {
    it("pass isChatBusy once the job's own follow has ended: each part is appended to the job's chat and sent there", async () => {
        const follow = await attach("command", a);
        const terminal = done({ followUps: [{ clear: false, parts: ["first", "second"] }] });
        follow.socket.end(terminal);
        expect(await follow.end).toEqual(terminal);
        await vi.waitFor(() => expect(stubs.serverSends).toHaveLength(2));
        expect(stubs.serverSends).toEqual([{ target: a }, { target: a }]);
        expect(chat.findChat(a)!.message.map((message) => message.data)).toEqual(["one", "two", "first", "second"]);
        expect(status.isChatBusy(a)).toBe(false);
        expect(status.generatingChatKeys()).toEqual(new Set());
    });
});
