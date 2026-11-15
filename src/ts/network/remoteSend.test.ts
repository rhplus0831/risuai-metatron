import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { EventFeedFrame } from "../../../shared/events.ts";
import {
    REMOTE_COMMAND_PICKUP_MS,
    type RemoteCommandPostBody,
    type RemoteCommandState,
    type RemoteSendResult,
    type SendReport,
} from "../../../shared/remoteCommands.ts";
import type { ServerSendArg, ServerSendResult } from "../process/serverGeneration";
import { loreBudgetStopFixture } from "../process/tests/loreBudgetStopFixture";
import { FakeSocket } from "./tests/eventSocket";

const EPOCH = "11111111-2222-4333-8444-555555555555";
const target = { chaId: "character", chatId: "chat" };
const hostClient = { clientId: "host", name: "Desk", worker: false, host: true };
type SendArg = NonNullable<Parameters<typeof import("../process/index.svelte").sendChat>[1]>;
type Flush = typeof import("../storage/resourceSync.svelte").flushResources;
const stubs = vi.hoisted(() => ({
    fetch: vi.fn<typeof import("../storage/serverAuth").authFetch>(),
    local: vi.fn<typeof import("../process/serverGeneration").sendChatOnServer>(),
    flush: vi.fn<Flush>(),
    refresh: vi.fn<typeof import("../storage/resourceSync.svelte").refreshStaleChat>(),
    prepare: vi.fn<typeof import("../process/serverCommands").prepareServerJob>(),
    read: vi.fn<typeof import("../process/serverCommands").readRecoveringChat>(),
    pin: vi.fn<typeof import("../storage/chatStore.svelte").pinChat>(),
    unpin: vi.fn(),
    error: vi.fn<typeof import("../alert").alertError>(),
    toast: vi.fn<typeof import("../alert").alertToast>(),
}));
vi.mock("../storage/serverAuth", async () =>
    (await import("../storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: stubs.fetch }),
);
vi.mock("./generationJobs", async () =>
    (await import("./tests/generationJobsMock")).createGenerationJobsMock({ generationClientId: () => "sender" }),
);
vi.mock("../storage/resourceClient", async () =>
    (await import("../storage/tests/resourceClientMock")).createResourceClientMock({
        getResourceEpoch: () => EPOCH,
        listRevisions: async () => ({ epoch: EPOCH, resources: [], chats: [], chatOrders: [] }),
    }),
);
vi.mock("../diagnostics/collector", async () =>
    (await import("../diagnostics/tests/collectorMock")).createCollectorMock(),
);
vi.mock("../storage/chatStore.svelte", async () =>
    (await import("../storage/tests/chatStoreMock")).createChatStoreMock({
        currentChatRef: () => target,
        chatEntry: () => ({
            id: target.chatId,
            name: "Chat",
            fmIndex: -1,
            modelPresetId: "preset",
            promptPresetId: "preset",
            bindedPersona: "persona",
        }),
        ensureChatLoaded: async () => ({ id: target.chatId, name: "Chat", note: "", localLore: [], message: [] }),
        heldChatRevision: () => "e:1:1",
        pinChat: stubs.pin,
    }),
);
vi.mock("../storage/resourceSync.svelte", async () =>
    (await import("../tests/bootMocks")).createBootMock("resourceSync", {
        flushResources: stubs.flush,
        refreshStaleChat: stubs.refresh,
        refusedItems: () => [],
        generatingNoticeCount: () => 0,
    }),
);
// Keep the extracted preflight real: the test controls its save/read I/O, not its refusal decision.
vi.mock("../process/serverCommands", async () =>
    (await import("../process/tests/serverCommandsMock")).createServerCommandsMock({
        prepareServerJob: stubs.prepare,
        readRecoveringChat: stubs.read,
    }),
);
vi.mock("../process/serverGeneration", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../process/serverGeneration")>()),
    sendChatOnServer: stubs.local,
}));
vi.mock("../alert", async () =>
    (await import("../tests/alertMock")).createAlertMock({ alertError: stubs.error, alertToast: stubs.toast }),
);

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}

const success: RemoteSendResult = {
    ok: true,
    outcome: "started",
    settled: true,
    requestUncertain: false,
    blockedChats: [],
    reports: [],
};
const noJob: ServerSendResult = {
    ok: false,
    outcome: "refused",
    settled: true,
    requestUncertain: false,
    refusal: "definite",
};
const unsettled: ServerSendResult = { ok: false, outcome: "unknown", settled: false, requestUncertain: true };
const endSuccess = { outcome: "started" as const, settled: true, requestUncertain: false, blockedChats: [] };
const endRefused = { outcome: "refused" as const, settled: true, requestUncertain: false, blockedChats: [] };
const endUncertain = { outcome: "unknown" as const, settled: false, requestUncertain: true, blockedChats: [] };
const input = {
    target,
    input: "reviewed input",
    inputOriginal: "  original\ninput  ",
    userMessageId: "message",
    requestId: "request",
    continue: false,
    stopOverLoreBudget: true,
} satisfies ServerSendArg;
const state = (value: RemoteCommandState, result?: RemoteSendResult) => ({
    state: value,
    attempted: value !== "queued",
    attempt: 1,
    stopRequested: false,
    ...(result ? { result } : {}),
});
type Answer = () => Response | Promise<Response>;
let postAnswer: Answer;
let statusAnswer: Answer;
let cancelAnswer: Answer;
let remote: typeof import("./remoteSend");
let handoff: typeof import("./handoff");
let host: typeof import("./remoteHost");
let sendChat: typeof import("../process/index.svelte").sendChat;

// Drain dynamic module loads and ready continuations without advancing a production deadline.
async function drain() {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
}
function start(extra: SendArg = {}) {
    const onEnd = vi.fn<NonNullable<SendArg["onEnd"]>>();
    const onServerRefused = vi.fn<NonNullable<SendArg["onServerRefused"]>>();
    const promise = sendChat(-1, { ...input, ...extra, onEnd, onServerRefused });
    return { promise, onEnd, onServerRefused };
}
type Sending = ReturnType<typeof start>;
async function ended(
    sending: Sending,
    ok: boolean,
    end: Parameters<NonNullable<SendArg["onEnd"]>>[0],
    refused?: boolean,
) {
    await drain();
    // Check the callback before awaiting: a broken waiter fails here, never on a real timeout.
    expect(sending.onEnd).toHaveBeenCalledExactlyOnceWith(end);
    if (refused === undefined) expect(sending.onServerRefused).not.toHaveBeenCalled();
    else expect(sending.onServerRefused).toHaveBeenCalledExactlyOnceWith(refused);
    expect(await sending.promise).toBe(ok);
}
function posts(): RemoteCommandPostBody[] {
    return stubs.fetch.mock.calls
        .filter(([url]) => url === "/api/remote-commands")
        .map(([, init]) => JSON.parse(String(init?.body)) as RemoteCommandPostBody);
}
function statusReads() {
    return stubs.fetch.mock.calls.filter(([url]) => String(url).includes("/status?"));
}
function frame(value: Extract<EventFeedFrame, { type: "remoteCommandState" }>["state"], requestId = input.requestId) {
    remote.receiveRemoteCommandState({ type: "remoteCommandState", epoch: EPOCH, commandId: requestId, state: value });
}
function clearCalls() {
    vi.clearAllMocks();
}
function silent() {
    expect(stubs.error).not.toHaveBeenCalled();
    expect(stubs.toast).not.toHaveBeenCalled();
}

beforeAll(async () => {
    await Promise.all([import("../process/index.svelte"), import("../storage/tests/installFlatDatabase")]);
    await vi.importActual("src/ts/process/serverCommands");
});
beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    stubs.local.mockReset().mockResolvedValue(success);
    stubs.flush.mockReset().mockResolvedValue({ discarded: [], refused: [] });
    stubs.refresh.mockReset().mockResolvedValue(true);
    stubs.read.mockReset().mockResolvedValue(true);
    stubs.pin.mockReset().mockImplementation(() => stubs.unpin);
    postAnswer = () => Response.json(state("queued"));
    statusAnswer = () => Response.json(state("running"));
    cancelAnswer = () => Response.json({ state: "cancelled", attempt: 1, stopRequested: true });
    stubs.fetch.mockReset().mockImplementation(async (url, init) => {
        expect(init?.headers).toMatchObject({ "x-resource-epoch": EPOCH });
        if (url === "/api/remote-commands") {
            expect(init?.method).toBe("POST");
            return postAnswer();
        }
        if (String(url).endsWith("/cancel")) {
            expect(init?.method).toBe("POST");
            return cancelAnswer();
        }
        expect(url).toMatch(/^\/api\/remote-commands\/[^/]+\/status\?clientId=sender$/);
        expect(init?.method).toBe("GET");
        return statusAnswer();
    });
    const { installFlatDatabase } = await import("../storage/tests/installFlatDatabase");
    installFlatDatabase({
        botPresets: [{ id: "preset", name: "Preset" }],
        personas: [{ id: "persona", name: "Persona", personaPrompt: "", icon: "", note: "" }],
    });
    // Load before exercising timers; bind the real preflight to this reset's record stores.
    const commands = await vi.importActual<typeof import("../process/serverCommands")>("src/ts/process/serverCommands");
    stubs.prepare.mockReset().mockImplementation(commands.prepareServerJob);
    ({ sendChat } = await import("../process/index.svelte"));
    remote = await import("./remoteSend");
    handoff = await import("./handoff");
    host = await import("./remoteHost");
    host.hostMode.set(false);
    remote.remoteSend.set(true);
    remote.remoteSendHost.set(hostClient.name);
    remote.remoteSendFallback.set(true);
    handoff.replaceConnectedClients([hostClient]);
});
afterEach(async () => {
    await drain();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

it("saves and refreshes the pinned chat before posting an eligible send with its original ids and input", async () => {
    const flush = deferred<Awaited<ReturnType<Flush>>>();
    const refresh = deferred<boolean>();
    stubs.flush.mockReturnValueOnce(flush.promise);
    stubs.refresh.mockReturnValueOnce(refresh.promise);
    const sending = start();
    await drain();
    expect(stubs.pin).toHaveBeenCalledExactlyOnceWith(target);
    expect(stubs.flush).toHaveBeenCalledTimes(1);
    expect(posts()).toEqual([]);
    expect(stubs.refresh).not.toHaveBeenCalled();
    flush.resolve({ discarded: [], refused: [] });
    await drain();
    expect(stubs.refresh).toHaveBeenCalledExactlyOnceWith(target);
    expect(posts()).toEqual([]);
    refresh.resolve(true);
    await drain();
    expect(posts()).toEqual([
        {
            clientId: "sender",
            target: "host",
            commandId: "request",
            command: {
                type: "send",
                ...target,
                input: "reviewed input",
                inputOriginal: "  original\ninput  ",
                userMessageId: "message",
                requestId: "request",
                stopOverLoreBudget: true,
            },
        },
    ]);
    expect(sending.onEnd).not.toHaveBeenCalled();
    expect(stubs.unpin).not.toHaveBeenCalled();
    statusAnswer = () => Response.json(state("done", success));
    frame("done");
    await ended(sending, true, endSuccess);
    expect(stubs.local).not.toHaveBeenCalled();
    expect(stubs.unpin).toHaveBeenCalledTimes(1);
});

it("refuses a discarded or refused write without posting or falling back", async () => {
    for (const flushed of [
        { discarded: ["settings/main"], refused: [] },
        { discarded: [], refused: ["chats/character/chat"] },
    ]) {
        clearCalls();
        stubs.flush.mockResolvedValueOnce(flushed);
        await ended(start(), false, endRefused, false);
        expect(stubs.fetch).not.toHaveBeenCalled();
        expect(stubs.local).not.toHaveBeenCalled();
        expect(stubs.error).toHaveBeenCalledTimes(1);
        expect(stubs.unpin).toHaveBeenCalledTimes(1);
    }
});

it("refuses a second send throughout the remote wait and the fallback, then releases the reservation", async () => {
    const fallback = deferred<ServerSendResult>();
    stubs.local.mockReturnValueOnce(fallback.promise);
    const first = start();
    await drain();
    expect(posts()).toHaveLength(1);
    await ended(start({ requestId: "second" }), false, endRefused, false);
    expect(stubs.local).not.toHaveBeenCalled();
    frame("expired");
    await drain();
    expect(stubs.local).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(input));
    expect(first.onEnd).not.toHaveBeenCalled();
    expect(stubs.unpin).not.toHaveBeenCalled();
    await ended(start({ requestId: "third" }), false, endRefused, false);
    expect(posts()).toHaveLength(1);
    expect(stubs.local).toHaveBeenCalledTimes(1);
    fallback.resolve(success);
    await ended(first, true, endSuccess);
    expect(stubs.unpin).toHaveBeenCalledTimes(1);
    postAnswer = () => Response.json(state("done", success));
    await ended(start({ requestId: "fourth" }), true, endSuccess);
    expect(posts().map(({ commandId }) => commandId)).toEqual(["request", "fourth"]);
});

const definiteAnswers = [
    { label: "an absent host", reason: "The chosen host is not connected.", answer: "absent" },
    { label: "404 targetUnavailable", reason: "The chosen host is not connected.", answer: "targetUnavailable" },
    { label: "409 targetFull", reason: "The host's command queue is full.", answer: "targetFull" },
    { label: "413", reason: "The send exceeds the remote command size limit.", answer: "tooLarge" },
    { label: "an expired command", reason: "The host did not pick up the send in time.", answer: "expired" },
    { label: "a host refusal", reason: "The host is busy with this chat.", answer: "refused" },
] as const;
it.each(definiteAnswers)(
    "falls back for $label, with a notice, only when enabled and the send is unmarked",
    async ({ answer, reason }) => {
        for (const fallback of [false, true])
            for (const marked of [false, true]) {
                clearCalls();
                remote.remoteSendFallback.set(fallback);
                const requestId = `${answer}-${fallback}-${marked}`;
                handoff.replaceConnectedClients(answer === "absent" ? [] : [hostClient]);
                postAnswer = () =>
                    answer === "targetUnavailable"
                        ? Response.json({ error: answer }, { status: 404 })
                        : answer === "targetFull"
                          ? Response.json({ error: answer }, { status: 409 })
                          : answer === "tooLarge"
                            ? Response.json({ error: "bodyTooLarge" }, { status: 413 })
                            : Response.json(state("queued"));
                const sending = start({ requestId, requestUncertain: marked });
                await drain();
                if (answer === "expired" || answer === "refused") {
                    statusAnswer = () =>
                        Response.json({ ...state(answer), ...(answer === "refused" ? { code: "busy" } : {}) });
                    remote.receiveRemoteCommandState({
                        type: "remoteCommandState",
                        epoch: EPOCH,
                        commandId: requestId,
                        state: answer,
                        ...(answer === "refused" ? { code: "busy" } : {}),
                    });
                }
                if (fallback && !marked) {
                    await ended(sending, true, endSuccess);
                    expect(stubs.local).toHaveBeenCalledExactlyOnceWith(
                        expect.objectContaining({ ...input, requestId, requestUncertain: false }),
                    );
                    expect(stubs.toast).toHaveBeenCalledExactlyOnceWith(
                        `Remote send through Desk: ${reason} Sending from this device instead.`,
                    );
                    expect(stubs.error).not.toHaveBeenCalled();
                } else {
                    await ended(sending, false, { ...endRefused, settled: !marked, requestUncertain: marked }, marked);
                    expect(stubs.local).not.toHaveBeenCalled();
                    expect(stubs.toast).toHaveBeenCalledExactlyOnceWith(
                        `Remote send through Desk: ${reason}${marked ? " The outcome is still unknown. Retry unchanged text to keep the same request." : ""}`,
                    );
                    expect(stubs.error).not.toHaveBeenCalled();
                }
                if (answer !== "absent") {
                    expect(posts()).toHaveLength(1);
                    expect(posts()[0]).toMatchObject({ commandId: requestId, command: { requestId } });
                    expect(posts()[0].uncertain).toBe(marked ? true : undefined);
                } else expect(posts()).toEqual([]);
            }
    },
);

it("shows commandChanged as an error and preserves uncertainty without falling back", async () => {
    for (const fallback of [false, true]) {
        clearCalls();
        remote.remoteSendFallback.set(fallback);
        postAnswer = () => Response.json({ error: "commandChanged" }, { status: 409 });
        await ended(start(), false, { ...endRefused, settled: false, requestUncertain: true }, true);
        expect(stubs.local).not.toHaveBeenCalled();
        expect(stubs.error).toHaveBeenCalledExactlyOnceWith(
            "This request id belongs to another remote action. Its outcome is unknown. Change the text before sending a new request.",
        );
        expect(stubs.toast).not.toHaveBeenCalled();
    }
});

it.each(["uncertain", "forgotten", "unknownCommand", "unanswered post", "unanswered status", "cancelled"] as const)(
    "keeps the send uncertain after %s with either fallback setting",
    async (answer) => {
        for (const fallback of [false, true]) {
            clearCalls();
            remote.remoteSendFallback.set(fallback);
            postAnswer =
                answer === "unanswered post"
                    ? () => Promise.reject(new Error("offline"))
                    : () => Response.json(state("queued"));
            statusAnswer =
                answer === "unanswered status"
                    ? () => Promise.reject(new Error("offline"))
                    : answer === "unknownCommand"
                      ? () => Response.json({ error: answer }, { status: 404 })
                      : () => Response.json(state(answer === "cancelled" ? "cancelled" : "uncertain"));
            const sending = start();
            await drain();
            if (answer !== "unanswered post")
                frame(answer === "forgotten" ? "forgotten" : answer === "cancelled" ? "cancelled" : "running");
            await ended(sending, false, endUncertain, true);
            expect(stubs.local).not.toHaveBeenCalled();
            expect(stubs.toast).toHaveBeenCalledExactlyOnceWith(
                "Remote send through Desk: The outcome is still unknown. Retry unchanged text to keep the same request.",
            );
        }
    },
);

it("halts on an epoch mismatch without a fallback", async () => {
    const resources = await import("../storage/resourceClient");
    for (const fallback of [false, true]) {
        clearCalls();
        remote.remoteSendFallback.set(fallback);
        postAnswer = () => Response.json({ epoch: "replacement-epoch" }, { status: 412 });
        await ended(start(), false, endRefused, false);
        expect(resources.epochMismatch).toHaveBeenCalledExactlyOnceWith("replacement-epoch");
        expect(stubs.local).not.toHaveBeenCalled();
        silent();
    }
});

it.each(["queued", "delivered", "running", "uncertain"] as const)(
    "waits for a host outcome when the post answers %s even with a result attached",
    async (answer) => {
        for (const fallback of [false, true]) {
            clearCalls();
            remote.remoteSendFallback.set(fallback);
            postAnswer = () => Response.json(state(answer, success));
            const sending = start();
            await drain();
            expect(posts()).toHaveLength(1);
            expect(sending.onEnd).not.toHaveBeenCalled();
            expect(stubs.read).not.toHaveBeenCalled();
            statusAnswer = () => Response.json(state("done", success));
            frame("done");
            await ended(sending, true, endSuccess);
            expect(stubs.local).not.toHaveBeenCalled();
        }
    },
);

it("ends a re-post answered uncertain after the pickup interval without a new frame", async () => {
    postAnswer = statusAnswer = () => Response.json(state("uncertain"));
    const sending = start({ requestUncertain: true });
    await drain();
    expect(posts()[0]).toMatchObject({ commandId: "request", uncertain: true, command: { requestId: "request" } });
    await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_PICKUP_MS - 1);
    expect(sending.onEnd).not.toHaveBeenCalled();
    expect(statusReads()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await ended(sending, false, endUncertain, true);
    expect(statusReads()).toHaveLength(1);
    expect(stubs.local).not.toHaveBeenCalled();
});

it("reads status after every frame, same-epoch hello and pickup interval", async () => {
    const sending = start();
    await drain();
    expect(posts()).toHaveLength(1);
    frame("delivered");
    await drain();
    expect(statusReads()).toHaveLength(1);
    frame("running");
    await drain();
    expect(statusReads()).toHaveLength(2);
    remote.reconcileRemoteSends("old-epoch");
    await drain();
    expect(statusReads()).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
        remote.reconcileRemoteSends(EPOCH);
        await drain();
        expect(statusReads()).toHaveLength(3 + i);
    }
    for (let i = 0; i < 2; i++) {
        await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_PICKUP_MS);
        expect(statusReads()).toHaveLength(5 + i);
        expect(sending.onEnd).not.toHaveBeenCalled();
    }
    statusAnswer = () => Response.json(state("done", success));
    remote.reconcileRemoteSends(EPOCH);
    await ended(sending, true, endSuccess);
    expect(statusReads()).toHaveLength(7);
    expect(stubs.local).not.toHaveBeenCalled();
});

it("reconciles a waiting send on every feed hello and receives its outcome from a feed frame", async () => {
    const browserSocket = globalThis.WebSocket;
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    const feed = await import("./eventFeed");
    try {
        feed.startEventFeed();
        await drain();
        const socket = FakeSocket.instances.at(-1)!;
        expect(socket).toBeDefined();
        socket.open();
        const hello = { type: "hello", epoch: EPOCH, clients: [hostClient] };
        socket.frame(hello);
        await drain();
        const sending = start();
        await drain();
        expect(posts()).toHaveLength(1);
        expect(statusReads()).toHaveLength(0);
        for (let i = 1; i <= 2; i++) {
            socket.frame(hello);
            await drain();
            expect(statusReads()).toHaveLength(i);
            expect(sending.onEnd).not.toHaveBeenCalled();
        }
        statusAnswer = () => Response.json(state("done", success));
        socket.frame({ type: "remoteCommandState", epoch: EPOCH, commandId: "request", state: "done" });
        await ended(sending, true, endSuccess);
        expect(statusReads()).toHaveLength(3);
        expect(stubs.local).not.toHaveBeenCalled();
    } finally {
        feed.stopEventFeed();
        vi.stubGlobal("WebSocket", browserSocket);
    }
});

it("keeps an uncertain frame uncertain when its status read or a later frame says done", async () => {
    const post = deferred<Response>();
    postAnswer = () => post.promise;
    statusAnswer = () => Response.json(state("done", success));
    const sending = start();
    await drain();
    expect(posts()).toHaveLength(1);
    frame("uncertain");
    frame("done");
    post.resolve(Response.json(state("queued")));
    await ended(sending, false, endUncertain, true);
    expect(statusReads()).toHaveLength(2);
    frame("done");
    remote.reconcileRemoteSends(EPOCH);
    await drain();
    expect(sending.onEnd).toHaveBeenCalledTimes(1);
    expect(stubs.read).not.toHaveBeenCalled();
    expect(stubs.local).not.toHaveBeenCalled();
});

it("reads the chat before showing each error from a failed done", async () => {
    for (const fallback of [false, true]) {
        clearCalls();
        remote.remoteSendFallback.set(fallback);
        const read = deferred<boolean>();
        stubs.read.mockReturnValueOnce(read.promise);
        postAnswer = () =>
            Response.json(
                state("done", {
                    ...success,
                    ok: false,
                    reports: [
                        { kind: "error", text: "Provider failed" },
                        { kind: "error", text: "Hook failed" },
                    ],
                }),
            );
        const sending = start();
        await drain();
        expect(stubs.read).toHaveBeenCalledExactlyOnceWith(target);
        expect(sending.onEnd).not.toHaveBeenCalled();
        expect(stubs.unpin).not.toHaveBeenCalled();
        expect(stubs.error).not.toHaveBeenCalled();
        read.resolve(true);
        await ended(sending, false, endSuccess);
        expect(stubs.error.mock.calls).toEqual([["Provider failed"], ["Hook failed"]]);
        expect(stubs.local).not.toHaveBeenCalled();
    }
});

it("leaves a failed done unsettled if its chat read cannot be adopted", async () => {
    stubs.read.mockResolvedValue(false);
    postAnswer = () =>
        Response.json(state("done", { ...success, ok: false, reports: [{ kind: "error", text: "Provider failed" }] }));
    await ended(start(), false, { ...endSuccess, settled: false, requestUncertain: true });
    expect(stubs.read).toHaveBeenCalledExactlyOnceWith(target);
    expect(stubs.error).toHaveBeenCalledExactlyOnceWith("Provider failed");
    expect(stubs.local).not.toHaveBeenCalled();
});

it("shows successful done notices together and awaits the chat read without making a failed read uncertain", async () => {
    for (const fallback of [false, true])
        for (const adopted of [false, true]) {
            clearCalls();
            remote.remoteSendFallback.set(fallback);
            const read = deferred<boolean>();
            stubs.read.mockReturnValueOnce(read.promise);
            postAnswer = () =>
                Response.json(
                    state("done", {
                        ...success,
                        reports: [
                            { kind: "notice", text: "Hook skipped" },
                            { kind: "notice", text: "Used cached context" },
                        ],
                    }),
                );
            const sending = start();
            await drain();
            expect(stubs.toast).toHaveBeenCalledExactlyOnceWith("Hook skipped\nUsed cached context");
            expect(stubs.read).toHaveBeenCalledExactlyOnceWith(target);
            expect(sending.onEnd).not.toHaveBeenCalled();
            read.resolve(adopted);
            await ended(sending, true, endSuccess);
            expect(stubs.error).not.toHaveBeenCalled();
            expect(stubs.local).not.toHaveBeenCalled();
        }
});

it("passes a definite refusal inside done to the screen without falling back", async () => {
    for (const fallback of [false, true]) {
        clearCalls();
        remote.remoteSendFallback.set(fallback);
        postAnswer = () =>
            Response.json(
                state("done", {
                    ...success,
                    ...noJob,
                    requestUncertain: false,
                    blockedChats: [target],
                    reconciled: true,
                    reports: [{ kind: "error", text: "Write refused" }],
                }),
            );
        await ended(start(), false, { ...endRefused, blockedChats: [target], reconciled: true }, false);
        expect(stubs.read).toHaveBeenCalledExactlyOnceWith(target);
        expect(stubs.error).toHaveBeenCalledExactlyOnceWith("Write refused");
        expect(stubs.local).not.toHaveBeenCalled();
    }
});

it("passes a lore stop to onEnd without showing an error or falling back", async () => {
    const loreStop = { lore: loreBudgetStopFixture, message: "Activated lorebook entries exceeded the token limit." };
    postAnswer = () =>
        Response.json(
            state("done", {
                ...success,
                ok: false,
                loreStop,
                reportShownElsewhere: true,
                reports: [{ kind: "error", text: loreStop.message }],
            }),
        );
    await ended(start(), false, { ...endSuccess, loreStop, reportShownElsewhere: true });
    expect(stubs.read).toHaveBeenCalledExactlyOnceWith(target);
    expect(stubs.local).not.toHaveBeenCalled();
    silent();
});

it("shows a host's elsewhere report but infers no error from an unreported failed done", async () => {
    for (const elsewhere of [false, true]) {
        clearCalls();
        postAnswer = () =>
            Response.json(
                state("done", { ...success, ok: false, ...(elsewhere ? { reportShownElsewhere: true } : {}) }),
            );
        await ended(start(), false, { ...endSuccess, ...(elsewhere ? { reportShownElsewhere: true as const } : {}) });
        expect(stubs.error.mock.calls).toEqual(elsewhere ? [["The send's error was shown on host Desk."]] : []);
        expect(stubs.local).not.toHaveBeenCalled();
    }
});

it("shows uncertain reports once across retries without settling or accepting a later done", async () => {
    for (const fallback of [false, true]) {
        clearCalls();
        remote.remoteSendFallback.set(fallback);
        const requestId = `reports-${fallback}`;
        const result: RemoteSendResult = {
            ...success,
            ok: false,
            reports: [
                { kind: "notice", text: "Host notice" },
                { kind: "error", text: "Host error" },
            ],
        };
        statusAnswer = () => Response.json(state("uncertain", result));
        const first = start({ requestId });
        await drain();
        frame("uncertain", requestId);
        await ended(first, false, { ...endSuccess, settled: false, requestUncertain: true });
        expect(stubs.error.mock.calls).toEqual([["Host error"]]);
        expect(stubs.toast.mock.calls).toEqual([["Host notice"]]);
        frame("done", requestId);
        await drain();
        expect(first.onEnd).toHaveBeenCalledTimes(1);
        const retry = start({ requestId, requestUncertain: true });
        await drain();
        expect(posts()[1]).toMatchObject({ commandId: requestId, uncertain: true });
        frame("uncertain", requestId);
        await ended(retry, false, { ...endSuccess, settled: false, requestUncertain: true });
        expect(stubs.error.mock.calls).toEqual([["Host error"]]);
        expect(stubs.toast.mock.calls).toEqual([["Host notice"]]);
        expect(stubs.local).not.toHaveBeenCalled();
    }
});

it.each(["cancelled", "stopRequested", "404", "unanswered"] as const)(
    "cancels the relay and generation independently when relay cancel answers %s",
    async (answer) => {
        for (const fallback of [false, true]) {
            clearCalls();
            remote.remoteSendFallback.set(fallback);
            const relay = deferred<Response>();
            cancelAnswer = () => relay.promise;
            const callerReports: SendReport[] = [];
            let initialReports: SendReport[] | undefined;
            stubs.local.mockImplementationOnce(async (arg) => {
                initialReports = arg.reports?.slice();
                arg.reports?.push({ kind: "error", text: "discarded cancellation report" });
                return noJob;
            });
            const controller = new AbortController();
            const sending = start({ signal: controller.signal, reports: callerReports });
            await drain();
            expect(posts()).toHaveLength(1);
            controller.abort();
            await ended(sending, false, endRefused, false);
            expect(stubs.local).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({
                    ...input,
                    signal: controller.signal,
                    requestUncertain: true,
                    reports: [{ kind: "error", text: "discarded cancellation report" }],
                }),
            );
            expect(stubs.local.mock.calls[0][0].signal?.aborted).toBe(true);
            expect(initialReports).toEqual([]);
            expect(stubs.local.mock.calls[0][0].reports).not.toBe(callerReports);
            expect(stubs.fetch).toHaveBeenCalledWith(
                "/api/remote-commands/request/cancel",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({ clientId: "sender" }),
                }),
            );
            expect(callerReports).toEqual([]);
            silent();
            if (answer === "unanswered") await vi.advanceTimersByTimeAsync(15_000);
            else
                relay.resolve(
                    Response.json(
                        answer === "404"
                            ? { error: "unknownCommand" }
                            : {
                                  state: answer === "cancelled" ? "cancelled" : "running",
                                  stopRequested: true,
                                  attempt: 1,
                              },
                        { status: answer === "404" ? 404 : 200 },
                    ),
                );
            statusAnswer = () =>
                Response.json(state("done", { ...success, reports: [{ kind: "notice", text: "late host notice" }] }));
            frame("done");
            await drain();
            expect(sending.onEnd).toHaveBeenCalledTimes(1);
            expect(stubs.local).toHaveBeenCalledTimes(1);
            silent();
        }
    },
);

it("waits for the host's closed state after an unsettled generation cancel and suppresses its reports", async () => {
    stubs.local.mockResolvedValue(unsettled);
    const controller = new AbortController();
    const sending = start({ signal: controller.signal });
    await drain();
    controller.abort();
    await drain();
    expect(stubs.local).toHaveBeenCalledTimes(1);
    expect(sending.onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_PICKUP_MS);
    expect(sending.onEnd).not.toHaveBeenCalled();
    statusAnswer = () =>
        Response.json(
            state("done", {
                ...success,
                ok: false,
                reports: [
                    { kind: "notice", text: "Stopped notice" },
                    { kind: "error", text: "Stopped error" },
                ],
            }),
        );
    frame("done");
    await ended(sending, false, endSuccess);
    expect(stubs.local).toHaveBeenCalledTimes(1);
    silent();
});

it("posts nothing when an unmarked send is stopped during preflight", async () => {
    const flush = deferred<Awaited<ReturnType<Flush>>>();
    stubs.flush.mockReturnValueOnce(flush.promise);
    const controller = new AbortController();
    const sending = start({ signal: controller.signal });
    await drain();
    expect(stubs.flush).toHaveBeenCalledTimes(1);
    controller.abort();
    flush.resolve({ discarded: [], refused: [] });
    await ended(sending, false, endRefused, false);
    expect(stubs.fetch).not.toHaveBeenCalled();
    expect(stubs.local).not.toHaveBeenCalled();
    silent();
});

it("cancels the relay and generation when a marked send stops before its post", async () => {
    const flush = deferred<Awaited<ReturnType<Flush>>>();
    stubs.flush.mockReturnValueOnce(flush.promise);
    stubs.local.mockResolvedValue(noJob);
    const controller = new AbortController();
    const sending = start({ signal: controller.signal, requestUncertain: true });
    await drain();
    expect(stubs.flush).toHaveBeenCalledTimes(1);
    controller.abort();
    await drain();
    expect(stubs.fetch).toHaveBeenCalledExactlyOnceWith(
        "/api/remote-commands/request/cancel",
        expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ clientId: "sender" }),
        }),
    );
    expect(stubs.local).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
            requestId: "request",
            signal: controller.signal,
            requestUncertain: true,
            reports: [],
        }),
    );
    flush.resolve({ discarded: [], refused: [] });
    await ended(sending, false, endRefused, false);
    expect(posts()).toEqual([]);
    silent();
});

it("re-posts the same request as uncertain to its original connected host after an uncertain Stop", async () => {
    stubs.local.mockResolvedValue(unsettled);
    const controller = new AbortController();
    const first = start({ signal: controller.signal });
    await drain();
    controller.abort();
    await drain();
    expect(first.onEnd).not.toHaveBeenCalled();
    statusAnswer = () => Promise.reject(new Error("offline"));
    remote.reconcileRemoteSends(EPOCH);
    await ended(first, false, endUncertain, true);
    silent();
    handoff.replaceConnectedClients([
        { ...hostClient, clientId: "newer-host" },
        hostClient,
        { ...hostClient, clientId: "other-host", name: "Other" },
    ]);
    remote.remoteSendHost.set("Other");
    const retry = start({ requestUncertain: true });
    await drain();
    expect(posts()).toHaveLength(2);
    expect(posts()[0]).not.toHaveProperty("uncertain");
    expect(posts()[1]).toEqual({ ...posts()[0], uncertain: true });
    expect(posts()[1]).toMatchObject({ target: "host", commandId: "request", command: { requestId: "request" } });
    statusAnswer = () => Response.json(state("done", success));
    frame("done");
    await ended(retry, true, endSuccess);
    expect(stubs.local).toHaveBeenCalledTimes(1);
});

it("ends uncertain only after the host has been continuously absent for sixty seconds", async () => {
    for (const fallback of [false, true]) {
        clearCalls();
        remote.remoteSendFallback.set(fallback);
        handoff.replaceConnectedClients([hostClient]);
        const sending = start();
        await drain();
        expect(posts()).toHaveLength(1);
        handoff.replaceConnectedClients([]);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(sending.onEnd).not.toHaveBeenCalled();
        handoff.replaceConnectedClients([hostClient]);
        await vi.advanceTimersByTimeAsync(1);
        expect(sending.onEnd).not.toHaveBeenCalled();
        handoff.replaceConnectedClients([]);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(sending.onEnd).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await ended(sending, false, endUncertain, true);
        expect(stubs.local).not.toHaveBeenCalled();
    }
});

it("keeps host, local-only and non-composer sends on the server path", async () => {
    const excluded: [string, SendArg][] = [
        ["localOnly", { localOnly: true }],
        ["continue", { continue: true }],
        ["continueMessageId", { continueMessageId: "previous" }],
        ["rerollMessageId", { rerollMessageId: "previous" }],
        ["speakerChaId", { speakerChaId: "speaker" }],
        ["preview", { preview: true }],
        ["previewPrompt", { previewPrompt: true }],
        [
            "pluginContext",
            {
                pluginContext: {
                    chatRef: target,
                    presetId: "preset",
                    modelPresetId: "preset",
                    personaId: "persona",
                },
            },
        ],
        ["input", { input: undefined }],
        ["userMessageId", { userMessageId: undefined }],
        ["requestId", { requestId: undefined }],
        ["host mode", {}],
        ["remote sending off", {}],
    ];
    for (const [label, overrides] of excluded) {
        clearCalls();
        host.hostMode.set(label === "host mode");
        remote.remoteSend.set(label !== "remote sending off");
        await ended(start(overrides), true, endSuccess);
        expect(stubs.local, label).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ...input, ...overrides }));
        expect(stubs.fetch, label).not.toHaveBeenCalled();
        expect(stubs.flush, label).not.toHaveBeenCalled();
    }
});
