import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, Message } from "../../../shared/database.ts";
import { MAX_OOC_EXCHANGES, type OocExchange, type OocLog } from "../../../shared/ooc.ts";
import type { requestDataResponse, StreamResponseChunk } from "../process/request/request";
import type { ServerJobResult } from "../process/serverCommands";
import { plain, warmModules } from "../storage/tests/mutationStoresHarness";

const io = vi.hoisted(() => ({
    job: vi.fn<typeof import("../process/serverCommands").runServerJob>(),
    request: vi.fn<typeof import("../process/request/request").requestChatData>(),
    alertError: vi.fn<typeof import("../alert").alertError>(),
    alertJobError: vi.fn<typeof import("../alert").alertJobError>(),
}));
vi.mock("../process/serverCommands", async () =>
    (await import("../process/tests/serverCommandsMock")).createServerCommandsMock({ runServerJob: io.job }),
);
vi.mock("../process/request/request", async () =>
    (await import("../process/request/tests/requestMock")).createRequestMock({ requestChatData: io.request }),
);
vi.mock("../alert", async () =>
    (await import("../tests/alertMock")).createAlertMock({
        alertError: io.alertError,
        alertJobError: io.alertJobError,
    }),
);

const ref = { chaId: "character", chatId: "story" };
const other = { chaId: "character", chatId: "other" };
const messages: Message[] = [
    { chatId: "first", role: "user", data: "The door opens." },
    { chatId: "newest", role: "char", data: "Someone enters." },
];
const prompt = [{ role: "user" as const, content: "Server-assembled OOC context" }];
const preview = (): ServerJobResult => ({
    outcome: "started",
    terminal: { type: "done", epoch: "epoch", revision: "epoch:1:2", result: { ooc: true, messages: prompt } },
});
const exchange = (id: string, segment = "current", time = 1): OocExchange => ({
    id,
    segment,
    anchorMessageId: "newest",
    question: `Question ${id}`,
    time,
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}

async function load() {
    return {
        ooc: await import("./oocSession.svelte"),
        chat: await import("../storage/chatStore.svelte"),
        selection: await import("../storage/selection.svelte"),
        sends: await import("../process/localSends"),
        jobs: await import("../process/serverCommands"),
        fixtures: await import("../storage/tests/installFlatDatabase"),
    };
}
let m: Awaited<ReturnType<typeof load>>;
beforeAll(() => warmModules(load), 60_000);
beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    io.job.mockReset().mockImplementation(async () => preview());
    io.request.mockReset().mockResolvedValue({ type: "success", result: "Buffered answer" });
    io.alertError.mockClear();
    io.alertJobError.mockClear();
    m = await load();
    m.jobs.followedJobs.set(new Map());
    seed();
});
afterEach(() => {
    m.ooc.stopOoc(ref);
    m.ooc.stopOoc(other);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/** Real store and binding records; no save loop or provider transport runs in this tab fixture. */
function seed(patch: Partial<Chat> = {}, type = "character", extraChats = 0) {
    const chats = [ref.chatId, other.chatId, ...Array.from({ length: extraChats }, (_, i) => `idle-${i}`)].map(
        (id) => ({
            id,
            name: id,
            note: "",
            localLore: [],
            message: structuredClone(messages),
            modelPresetId: "preset",
            promptPresetId: "preset",
            bindedPersona: "persona",
            ...(id === ref.chatId ? patch : {}),
        }),
    );
    m.fixtures.installFlatDatabaseWithChats({
        botPresets: [{ id: "preset", name: "Preset" }],
        personas: [{ id: "persona", name: "Persona", personaPrompt: "", icon: "", note: "" }],
        characters: [{ chaId: ref.chaId, name: "Character", type, globalLore: [], chats }],
    });
    m.chat.seedChats(
        chats.map(({ id }) => ({ characterId: ref.chaId, id, revision: "epoch:1:1" })),
        [{ characterId: ref.chaId, ids: chats.map(({ id }) => id), revision: "epoch:1:1" }],
    );
    m.selection.selectCharacter(ref.chaId);
    m.chat.selectChat(ref.chaId, ref.chatId);
}
const stored = () => m.chat.findChat(ref)!;
const log = () => stored().oocLog ?? {};
const onlyExchange = () => {
    expect(Object.keys(log())).toHaveLength(1);
    return Object.values(log())[0];
};
// Drain ready stream/request continuations without advancing a production deadline.
const settle = () => vi.advanceTimersByTimeAsync(0);
function streamAnswer() {
    let controller!: ReadableStreamDefaultController<StreamResponseChunk>;
    const cancel = vi.fn();
    const result = new ReadableStream<StreamResponseChunk>({
        start(value) {
            controller = value;
        },
        cancel,
    });
    io.request.mockResolvedValueOnce({ type: "streaming", result });
    return { controller, cancel };
}
/** Acknowledge the real outgoing queue, so a later take sees only subsequent writes. */
function acknowledge() {
    const work = m.chat.takeChatWork(new Set());
    m.chat.ackChatWork(
        work,
        work.groups.map(({ characterId, chatId }) => ({ characterId, id: chatId, revision: "epoch:1:2" })),
        work.orders.map(({ characterId, ids }) => ({ characterId, ids, revision: "epoch:1:2" })),
    );
    return work.groups.flatMap(({ ops }) => ops);
}

describe("OOC questions", () => {
    it("stores the question before preview and saves a buffered answer from the isolated model request", async () => {
        const end = deferred<ServerJobResult>();
        io.job.mockImplementationOnce(async (_character, target, request) => {
            expect(target).toEqual(ref);
            expect(onlyExchange()).toEqual({
                id: request.context!.oocExchangeId,
                segment: stored().oocSegment!.id,
                anchorMessageId: "newest",
                question: "Why did they enter?",
                time: Date.now(),
            });
            return end.promise;
        });
        const run = m.ooc.askOoc(ref, "Why did they enter?");
        await settle();
        expect(io.job).toHaveBeenCalledTimes(1);
        const id = onlyExchange().id;
        expect(stored().oocSegment).toEqual({ id: expect.any(String), anchorMessageId: "newest" });
        expect(m.ooc.readOocState(ref)).toMatchObject({ busy: true, streamingText: "", error: null });
        expect(io.job.mock.calls[0][2]).toEqual({
            kind: "preview",
            label: "send",
            context: { oocExchangeId: id },
            callerErrorCodes: ["oocExchangeGone", "oocAnchorGone", "oocMemoryAhead"],
        });
        expect(io.request).not.toHaveBeenCalled();
        const writes = acknowledge();
        expect(writes).toContainEqual(expect.objectContaining({ merge: { oocLog: { [id]: onlyExchange() } } }));
        end.resolve(preview());
        expect(await run).toEqual({ status: "done", exchangeId: id });
        expect(io.request).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                formated: prompt,
                chatRef: ref,
                bias: {},
                tools: [],
                noMultiGen: true,
                useStreaming: true,
            }),
            "model",
            io.job.mock.calls[0][3]!.signal,
        );
        expect(io.request.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
        expect(onlyExchange().answer).toBe("Buffered answer");
        expect(stored().message).toEqual(messages);
        expect(m.ooc.readOocState(ref)).toMatchObject({ busy: false, error: null });
    });

    it("streams snapshots and stores one final answer on the pinned chat after selection changes", async () => {
        seed({}, "character", m.chat.MAX_LOADED_CHATS + 2);
        const { controller } = streamAnswer();
        const captured = { ...ref };
        const run = m.ooc.askOoc(captured, "Explain the scene");
        m.chat.selectChat(other.chaId, other.chatId);
        await settle();
        expect(io.request).toHaveBeenCalledTimes(1);
        const id = onlyExchange().id;
        acknowledge();
        captured.chatId = other.chatId;
        // Make the answering chat the oldest clean eviction candidate; only its OOC pin protects it.
        for (const { id } of m.chat.chatList(ref.chaId)) {
            const idle = { chaId: ref.chaId, chatId: id };
            if (id.startsWith("idle-") && m.chat.findChat(idle)) await m.chat.ensureChatLoaded(idle);
        }
        m.chat.trimLoadedChats();
        expect(m.chat.findChat(ref)).toBeDefined();
        expect(m.ooc.readOocState(other)).toMatchObject({ busy: false, streamingText: "", error: null, picks: [] });
        controller.enqueue({ "0": "First draft" });
        await settle();
        expect(m.ooc.readOocState(ref)).toMatchObject({ busy: true, streamingText: "First draft" });
        expect(onlyExchange()).not.toHaveProperty("answer");
        // Some providers emit legacy string snapshots despite the declared chunk type.
        controller.enqueue("Revised full answer" as unknown as StreamResponseChunk);
        await settle();
        expect(m.ooc.readOocState(ref).streamingText).toBe("Revised full answer");
        expect(acknowledge()).toEqual([]);
        controller.close();
        expect(await run).toEqual({ status: "done", exchangeId: id });
        expect(onlyExchange().answer).toBe("Revised full answer");
        expect(m.chat.findChat(other)!.oocLog).toBeUndefined();
        expect(acknowledge()).toEqual([
            { op: "meta", merge: { oocLog: { [id]: { ...onlyExchange(), answer: "Revised full answer" } } } },
        ]);
        expect(m.ooc.readOocState(ref).busy).toBe(false);
        await settle();
        expect(acknowledge()).toEqual([]);
    });

    it.each(["group", "local send", "followed job", "binding", "orphaned lore"] as const)(
        "refuses questions and retries with %s before changing chat metadata",
        async (blocker) => {
            seed(
                {
                    oocSegment: { id: "current", anchorMessageId: "newest" },
                    oocLog: { retry: exchange("retry") },
                    ...(blocker === "binding" ? { bindedPersona: "missing-persona" } : {}),
                    ...(blocker === "orphaned lore"
                        ? {
                              loreOverrides: [
                                  {
                                      off: false,
                                      entry: {
                                          id: "missing-lore",
                                          key: "door",
                                          secondkey: "",
                                          content: "Closed",
                                          comment: "Door",
                                          insertorder: 0,
                                          mode: "normal",
                                          alwaysActive: false,
                                          selective: false,
                                      },
                                  },
                              ],
                          }
                        : {}),
                },
                blocker === "group" ? "group" : "character",
            );
            const release = blocker === "local send" ? m.sends.beginLocalSend(ref) : null;
            if (blocker === "followed job") m.jobs.followedJobs.set(new Map([["job", "character\u0000story"]]));
            const before = plain(stored());
            const kind = {
                group: "group",
                "local send": "busy",
                "followed job": "busy",
                binding: "binding",
                "orphaned lore": "loreOrphans",
            }[blocker];
            try {
                expect(await m.ooc.askOoc(ref, "Blocked question")).toMatchObject({
                    status: "refused",
                    error: { kind },
                });
                expect(await m.ooc.retryOoc(ref, "retry")).toMatchObject({ status: "refused", error: { kind } });
                expect(stored()).toEqual(before);
                expect(io.job).not.toHaveBeenCalled();
                expect(io.request).not.toHaveBeenCalled();
                expect(m.ooc.readOocState(ref)).toMatchObject({ busy: false, error: { kind } });
            } finally {
                release?.();
            }
        },
    );

    it("reserves each chat during an answer while allowing an independent chat to ask", async () => {
        const answer = deferred<requestDataResponse>();
        io.request.mockReturnValueOnce(answer.promise);
        const run = m.ooc.askOoc(ref, "First question");
        await settle();
        const id = onlyExchange().id;
        expect(await m.ooc.askOoc(ref, "Duplicate")).toMatchObject({ status: "refused", error: { kind: "inFlight" } });
        expect(await m.ooc.retryOoc(ref, id)).toMatchObject({ status: "refused", error: { kind: "inFlight" } });
        expect(Object.keys(log())).toEqual([id]);
        expect(await m.ooc.askOoc(other, "Independent question")).toMatchObject({ status: "done" });
        expect(m.ooc.readOocState(ref).busy).toBe(true);
        expect(m.ooc.readOocState(other).busy).toBe(false);
        answer.resolve({ type: "success", result: "First answer" });
        await run;
        expect(onlyExchange().answer).toBe("First answer");
    });

    it.each([
        {
            name: "older server",
            result: {
                outcome: "started",
                terminal: { type: "done", epoch: "epoch", revision: "epoch:1:2", result: { messages: prompt } },
            },
            kind: "olderServer",
        },
        {
            name: "chatBusy refusal",
            result: { outcome: "refused", terminal: null, blockedChats: [ref] },
            kind: "previewFailed",
        },
        { name: "followed job", result: { ...preview(), outcome: "followed" }, kind: "previewFailed" },
        {
            name: "missing result",
            result: { outcome: "replayed", terminal: { type: "done", epoch: "epoch", revision: "epoch:1:2" } },
            kind: "previewFailed",
        },
        { name: "lost end", result: { outcome: "started", terminal: "lost" }, kind: "previewFailed" },
    ] satisfies { name: string; result: ServerJobResult; kind: string }[])(
        "keeps an unanswered exchange and makes no reply request after $name",
        async ({ result, kind }) => {
            io.job.mockResolvedValueOnce(result);
            expect(await m.ooc.askOoc(ref, "Question")).toMatchObject({ status: "failed", error: { kind } });
            expect(io.request).not.toHaveBeenCalled();
            expect(onlyExchange()).toMatchObject({ question: "Question" });
            expect(onlyExchange()).not.toHaveProperty("answer");
            expect(m.ooc.readOocState(ref)).toMatchObject({
                busy: false,
                error: { kind, exchangeId: onlyExchange().id },
            });
        },
    );

    it.each(["oocExchangeGone", "oocAnchorGone", "oocMemoryAhead"] as const)(
        "reports %s as the question error without a reply request or global alert",
        async (code) => {
            io.job.mockResolvedValueOnce({
                outcome: "started",
                terminal: {
                    type: "error",
                    epoch: "epoch",
                    message: "OOC context unavailable",
                    status: 500,
                    reason: "failed",
                    code,
                },
            });
            expect(await m.ooc.askOoc(ref, "Question")).toMatchObject({ status: "failed", error: { kind: code } });
            expect(m.ooc.readOocState(ref)).toMatchObject({
                busy: false,
                error: { kind: code, exchangeId: onlyExchange().id },
            });
            expect(onlyExchange()).not.toHaveProperty("answer");
            expect(io.request).not.toHaveBeenCalled();
            expect(io.alertError).not.toHaveBeenCalled();
            expect(io.alertJobError).not.toHaveBeenCalled();
        },
    );

    it.each(["returned failure", "thrown error", "broken stream"] as const)(
        "keeps the question unanswered and reports a %s",
        async (failure) => {
            const stream = failure === "broken stream" ? streamAnswer() : undefined;
            if (failure === "returned failure")
                io.request.mockResolvedValueOnce({ type: "fail", result: "Provider failed" });
            if (failure === "thrown error") io.request.mockRejectedValueOnce(new Error("Provider failed"));
            const run = m.ooc.askOoc(ref, "Question");
            if (stream) {
                await settle();
                stream.controller.enqueue({ "0": "Unfinished" });
                await settle();
                expect(m.ooc.readOocState(ref).streamingText).toBe("Unfinished");
                stream.controller.error(new Error("Provider failed"));
            }
            expect(await run).toMatchObject({
                status: "failed",
                error: { kind: "requestFailed", message: "Provider failed" },
            });
            expect(onlyExchange()).not.toHaveProperty("answer");
            expect(m.ooc.readOocState(ref)).toMatchObject({ busy: false, error: { kind: "requestFailed" } });
        },
    );

    it("stops a preview through its abort signal without requesting an answer", async () => {
        const end = deferred<ServerJobResult>();
        io.job.mockReturnValueOnce(end.promise);
        const run = m.ooc.askOoc(ref, "Question");
        await settle();
        const signal = io.job.mock.calls[0][3]!.signal!;
        expect(signal.aborted).toBe(false);
        m.ooc.stopOoc(ref);
        expect(signal.aborted).toBe(true);
        end.resolve(preview());
        expect(await run).toMatchObject({ status: "failed", error: { kind: "stopped" } });
        expect(io.request).not.toHaveBeenCalled();
        expect(onlyExchange()).not.toHaveProperty("answer");
        expect(m.ooc.readOocState(ref)).toMatchObject({ busy: false, error: { kind: "stopped" } });
    });

    it("aborts the reply and cancels its stream without storing partial text", async () => {
        const stream = streamAnswer();
        const run = m.ooc.askOoc(ref, "Question");
        await settle();
        stream.controller.enqueue({ "0": "Partial" });
        await settle();
        m.ooc.stopOoc(ref);
        expect(io.request.mock.calls[0][2]!.aborted).toBe(true);
        expect(await run).toMatchObject({ status: "failed", error: { kind: "stopped" } });
        expect(stream.cancel).toHaveBeenCalledTimes(1);
        expect(onlyExchange()).not.toHaveProperty("answer");
        expect(m.ooc.readOocState(ref)).toMatchObject({ busy: false, error: { kind: "stopped" } });
    });

    it("deletes an in-flight exchange before a late answer can recreate it", async () => {
        const answer = deferred<requestDataResponse>();
        io.request.mockReturnValueOnce(answer.promise);
        const run = m.ooc.askOoc(ref, "Question");
        await settle();
        const id = onlyExchange().id;
        expect(await m.ooc.deleteOocExchange(ref, id)).toEqual({ status: "done", exchangeId: id });
        expect(io.request.mock.calls[0][2]!.aborted).toBe(true);
        expect(log()).toEqual({});
        answer.resolve({ type: "success", result: "Too late" });
        await run;
        expect(log()).toEqual({});
        expect(m.ooc.readOocState(ref).busy).toBe(false);
    });

    it("does not recreate an exchange removed from the store while its answer is pending", async () => {
        const answer = deferred<requestDataResponse>();
        io.request.mockReturnValueOnce(answer.promise);
        const run = m.ooc.askOoc(ref, "Question");
        await settle();
        const id = onlyExchange().id;
        m.chat.mergeChatMeta(ref, "oocLog", {}, [id]);
        answer.resolve({ type: "success", result: "Too late" });
        await run;
        expect(log()).toEqual({});
        expect(m.ooc.readOocState(ref).busy).toBe(false);
    });

    it("retries the same unanswered exchange and joins multiline answers in order", async () => {
        seed({
            oocSegment: { id: "current", anchorMessageId: "newest" },
            oocLog: { retry: exchange("retry"), old: exchange("old", "earlier") },
        });
        io.request.mockResolvedValueOnce({ type: "fail", result: "Try again" }).mockResolvedValueOnce({
            type: "multiline",
            result: [
                ["char", "First"],
                ["user", "Second"],
                ["char", "Third"],
            ],
        });
        expect(await m.ooc.retryOoc(ref, "retry")).toMatchObject({ status: "failed" });
        expect(await m.ooc.retryOoc(ref, "retry")).toEqual({ status: "done", exchangeId: "retry" });
        expect(io.job.mock.calls.map(([, , request]) => request.context)).toEqual([
            { oocExchangeId: "retry" },
            { oocExchangeId: "retry" },
        ]);
        expect(io.request).toHaveBeenCalledTimes(2);
        expect(log().retry).toEqual({ ...exchange("retry"), answer: "First\nSecond\nThird" });
        expect(Object.keys(log())).toEqual(["retry", "old"]);
        expect(await m.ooc.retryOoc(ref, "old")).toMatchObject({
            status: "refused",
            error: { kind: "retryUnavailable" },
        });
        expect(await m.ooc.retryOoc(ref, "retry")).toMatchObject({
            status: "refused",
            error: { kind: "retryUnavailable" },
        });
        expect(io.job).toHaveBeenCalledTimes(2);
    });
});

describe("OOC segments and attachments", () => {
    it("refuses a gone anchor until refresh, then starts a separate segment at the newest message", async () => {
        const old = { ...exchange("old", "earlier", 1), anchorMessageId: "first", answer: "Old answer" };
        const recent = { ...exchange("recent", "current", 2), answer: "Recent answer" };
        seed({ oocSegment: { id: "current", anchorMessageId: "newest" }, oocLog: { recent, old } });
        m.chat.appendMessage(ref, { chatId: "latest", role: "user", data: "Next scene" });
        expect(m.ooc.oocAnchorExists(ref)).toBe(true);
        expect(m.ooc.oocMessagesAfterAnchor(ref)).toBe(1);
        m.chat.removeMessages(ref, ["newest"]);
        expect(m.ooc.oocAnchorExists(ref)).toBe(false);
        expect(m.ooc.oocMessagesAfterAnchor(ref)).toBe(0);
        expect(await m.ooc.askOoc(ref, "Blocked")).toMatchObject({ status: "refused", error: { kind: "anchorGone" } });
        expect(await m.ooc.retryOoc(ref, "recent")).toMatchObject({ status: "refused", error: { kind: "anchorGone" } });
        expect(stored().oocSegment).toEqual({ id: "current", anchorMessageId: "newest" });
        expect(io.job).not.toHaveBeenCalled();
        expect(await m.ooc.refreshOoc(ref)).toEqual({ status: "done" });
        const segment = stored().oocSegment!;
        expect(segment.id).not.toBe("current");
        expect(segment.anchorMessageId).toBe("latest");
        expect(m.ooc.oocAnchorExists(ref)).toBe(true);
        expect(m.ooc.oocMessagesAfterAnchor(ref)).toBe(0);
        await m.ooc.askOoc(ref, "Fresh question");
        const fresh = Object.values(log()).find(({ id }) => id !== "old" && id !== "recent")!;
        expect(fresh).toMatchObject({ segment: segment.id, anchorMessageId: "latest", question: "Fresh question" });
        expect(fresh.attached ?? []).toEqual([]);
        expect(m.ooc.readOocSegments(ref)).toEqual([
            { id: "earlier", anchorMessageId: "first", current: false, exchanges: [old] },
            { id: "current", anchorMessageId: "newest", current: false, exchanges: [recent] },
            { ...segment, current: true, exchanges: [fresh] },
        ]);
        expect(await m.ooc.clearOocLog(ref)).toEqual({ status: "done" });
        expect(log()).toEqual({ [fresh.id]: fresh });
    });

    it("uses a valid null anchor in an empty chat and counts messages added after it", async () => {
        seed({ message: [] });
        await m.ooc.askOoc(ref, "Before the story");
        expect(stored().oocSegment).toEqual({ id: expect.any(String), anchorMessageId: null });
        expect(onlyExchange().anchorMessageId).toBeNull();
        m.chat.appendMessage(ref, messages[0]);
        expect(m.ooc.oocAnchorExists(ref)).toBe(true);
        expect(m.ooc.oocMessagesAfterAnchor(ref)).toBe(1);
        await m.ooc.askOoc(ref, "Still this segment");
        expect(Object.values(log()).map(({ anchorMessageId }) => anchorMessageId)).toEqual([null, null]);
    });

    it("records picked attachments and prunes the oldest unpicked earlier exchange", async () => {
        const entries = Array.from({ length: MAX_OOC_EXCHANGES }, (_, i) => ({
            ...exchange(`old-${i}`, "earlier", i),
            answer: `Answer ${i}`,
        }));
        seed({
            oocSegment: { id: "current", anchorMessageId: "newest" },
            oocLog: Object.fromEntries(entries.map((entry) => [entry.id, entry])),
        });
        expect(m.ooc.toggleOocAttachment(ref, "old-0").status).toBe("done");
        expect(m.ooc.readOocState(ref).picks).toEqual(["old-0"]);
        expect(m.ooc.readOocState(other).picks).toEqual([]);
        m.ooc.toggleOocAttachment(ref, "old-0");
        expect(m.ooc.readOocState(ref).picks).toEqual([]);
        m.ooc.toggleOocAttachment(ref, "old-0");
        await m.ooc.askOoc(ref, "With attachment");
        const fresh = Object.values(log()).find(({ segment }) => segment === "current")!;
        expect(fresh.attached).toEqual(["old-0"]);
        expect(log()["old-0"]).toEqual(entries[0]);
        expect(log()).not.toHaveProperty("old-1");
        expect(log()["old-2"]).toEqual(entries[2]);
        expect(Object.keys(log())).toHaveLength(MAX_OOC_EXCHANGES);
        expect(m.ooc.readOocState(ref).picks).toEqual([]);
        m.ooc.toggleOocAttachment(ref, "old-2");
        await m.ooc.deleteOocExchange(ref, "old-2");
        expect(log()).not.toHaveProperty("old-2");
        expect(m.ooc.readOocState(ref).picks).toEqual([]);
        m.ooc.toggleOocAttachment(ref, "old-0");
        await m.ooc.clearOocLog(ref);
        expect(log()).toEqual({ [fresh.id]: fresh });
        expect(m.ooc.readOocState(ref).picks).toEqual([]);
    });

    it("prunes a stored log above 200 for a new question and refuses it when no entries are removable", async () => {
        const entries: OocLog = Object.fromEntries(
            Array.from({ length: MAX_OOC_EXCHANGES + 1 }, (_, i) => {
                const entry = exchange(`old-${i}`, "earlier", i);
                return [entry.id, entry];
            }),
        );
        const segment = { id: "current", anchorMessageId: "newest" };
        seed({ oocSegment: segment, oocLog: entries });
        const result = await m.ooc.askOoc(ref, "Next question");
        expect(result).toMatchObject({ status: "done" });
        if (result.status !== "done") throw new Error("Question did not finish");
        expect(log()).toEqual({
            ...Object.fromEntries(Object.entries(entries).slice(2)),
            [result.exchangeId!]: expect.objectContaining({
                question: "Next question",
                answer: "Buffered answer",
                segment: "current",
            }),
        });
        expect(Object.keys(log())).toHaveLength(MAX_OOC_EXCHANGES);
        expect(io.job).toHaveBeenCalledTimes(1);
        expect(io.request).toHaveBeenCalledTimes(1);
        acknowledge();

        const protectedEntries = Object.fromEntries(
            Object.entries(entries).map(([id, entry]) => [id, { ...entry, segment: "current" }]),
        );
        seed({ oocSegment: segment, oocLog: protectedEntries });
        io.job.mockClear();
        io.request.mockClear();
        expect(await m.ooc.askOoc(ref, "No room")).toMatchObject({ status: "refused", error: { kind: "pruneFull" } });
        expect(log()).toEqual(protectedEntries);
        expect(m.chat.takeChatWork(new Set()).groups).toEqual([]);
        expect(m.ooc.readOocState(ref)).toMatchObject({ busy: false, error: { kind: "pruneFull" } });
        expect(io.job).not.toHaveBeenCalled();
        expect(io.request).not.toHaveBeenCalled();
    });

    it("refuses a full log when every earlier exchange is picked and the rest are current", async () => {
        const entries: OocLog = Object.fromEntries(
            Array.from({ length: MAX_OOC_EXCHANGES - 1 }, (_, i) => {
                const entry = exchange(`current-${i}`);
                return [entry.id, entry];
            }),
        );
        entries.picked = exchange("picked", "earlier");
        seed({ oocSegment: { id: "current", anchorMessageId: "newest" }, oocLog: entries });
        m.ooc.toggleOocAttachment(ref, "picked");
        expect(await m.ooc.askOoc(ref, "No room")).toMatchObject({ status: "refused", error: { kind: "pruneFull" } });
        expect(log()).toEqual(entries);
        expect(m.ooc.readOocState(ref)).toMatchObject({ busy: false, picks: ["picked"], error: { kind: "pruneFull" } });
        expect(io.job).not.toHaveBeenCalled();
        expect(io.request).not.toHaveBeenCalled();
    });
});
