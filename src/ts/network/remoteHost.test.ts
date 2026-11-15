import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
    PluginReloadOutcome,
    RemoteCommandReadAnswer,
    RemoteCommandStateBody,
} from "../../../shared/remoteCommands.ts";
import type { ServerSendArg } from "../process/serverGeneration";
import { warmModules } from "../storage/tests/mutationStoresHarness";

const EPOCH = "11111111-2222-4333-8444-555555555555";
const target = { chaId: "character", chatId: "chat" };
const savedKey = "risu-remote-host-commands";
type Send = typeof import("../process/index.svelte").sendChat;
const stubs = vi.hoisted(() => ({
    fetch: vi.fn<typeof import("../storage/serverAuth").authFetch>(),
    send: vi.fn<Send>(),
    started: vi.fn<() => Promise<void>>(),
    reloadPlugins: vi.fn<typeof import("../plugins/plugins.svelte").reloadPluginsWhenIdle>(),
    bootOutcome: Promise.resolve<PluginReloadOutcome>("applied"),
    flush: vi.fn<typeof import("../storage/resourceSync.svelte").flushResources>(),
    confirm: vi.fn<typeof import("../alert").alertConfirm>(),
    select: vi.fn<typeof import("../alert").alertSelect>(),
    hold: vi.fn<() => () => void>(),
    release: vi.fn(),
    unpin: vi.fn(),
    pin: vi.fn<typeof import("../storage/chatStore.svelte").pinChat>(),
    entry: vi.fn<typeof import("../storage/chatStore.svelte").chatEntry>(),
    selectChat: vi.fn<typeof import("../storage/chatStore.svelte").selectChat>(),
}));
vi.mock("../storage/serverAuth", async () =>
    (await import("../storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: stubs.fetch }),
);
vi.mock("./generationJobs", async () =>
    (await import("./tests/generationJobsMock")).createGenerationJobsMock({
        generationClientId: () => "host-client",
        holdGenerationPluginWork: stubs.hold,
    }),
);
vi.mock("../storage/resourceClient", async () =>
    (await import("../storage/tests/resourceClientMock")).createResourceClientMock({ getResourceEpoch: () => EPOCH }),
);
vi.mock("../storage/chatStore.svelte", async () =>
    (await import("../storage/tests/chatStoreMock")).createChatStoreMock({
        chatEntry: stubs.entry,
        pinChat: stubs.pin,
        selectChat: stubs.selectChat,
    }),
);
vi.mock("../plugins/plugins.svelte", async () => ({
    ...(await import("../tests/bootMocks")).createBootMock("plugins", {
        pluginsStarted: stubs.started,
        reloadPluginsWhenIdle: stubs.reloadPlugins,
    }),
    get bootPluginLoadOutcome() {
        return stubs.bootOutcome;
    },
}));
vi.mock("../storage/resourceSync.svelte", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../storage/resourceSync.svelte")>()),
    flushResources: stubs.flush,
}));
vi.mock("../stores.svelte", async () => (await import("../tests/storesMock")).createStoresMock());
vi.mock("../alert", async () =>
    (await import("../tests/alertMock")).createAlertMock({ alertConfirm: stubs.confirm, alertSelect: stubs.select }),
);
vi.mock("../process/serverCommands", async () =>
    (await import("../process/tests/serverCommandsMock")).createServerCommandsMock(),
);
vi.mock("../process/index.svelte", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../process/index.svelte")>()),
    sendChat: stubs.send,
}));

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}

let host: typeof import("./remoteHost");
let read: RemoteCommandReadAnswer;
let states: RemoteCommandStateBody[];
const frame = { type: "remoteCommand", epoch: EPOCH, commandId: "command-7" } as const;
const end = {
    settled: true,
    outcome: "started",
    requestUncertain: false,
    blockedChats: [],
} as const;

// Dynamic imports are part of the runner. Drain them and ready continuations without advancing deadlines.
async function drain() {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(0);
}
const sendArgs = () => stubs.send.mock.calls[0]![1]!;
async function deliver(extra: { stop?: true } = {}) {
    host.receiveHostCommand({ ...frame, ...extra });
    await drain();
}
function reports() {
    // Every emitted report, including repeated running states, must identify the attempt read over HTTP.
    for (const state of states) expect(state).toMatchObject({ clientId: "host-client", attempt: 7 });
    return states;
}

beforeAll(
    () =>
        warmModules(() =>
            Promise.all([
                import("./remoteHost"),
                import("../process/index.svelte"),
                import("../plugins/plugins.svelte"),
                import("../storage/resourceSync.svelte"),
                import("../safeBoot"),
                import("../storage/tests/installFlatDatabase"),
            ]),
        ),
    60_000,
);
beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    history.replaceState(null, "", "/");
    states = [];
    read = {
        command: {
            type: "send",
            ...target,
            input: "reviewed input",
            inputOriginal: "  original\ninput  ",
            userMessageId: "sender-message",
            requestId: "sender-request",
            stopOverLoreBudget: true,
        },
        state: "delivered",
        attempted: false,
        stopRequested: false,
        attempt: 7,
    };
    stubs.fetch.mockReset().mockImplementation(async (url, init) => {
        if (init?.method === "GET") return Response.json(read);
        expect(url).toBe(`/api/remote-commands/${frame.commandId}/state`);
        const state = JSON.parse(String(init?.body)) as RemoteCommandStateBody;
        states.push(state);
        return Response.json({ state: state.state, attempt: 7, stopRequested: false });
    });
    stubs.send.mockReset().mockImplementation(async (_index, arg) => {
        arg?.onEnd?.(end);
        return true;
    });
    stubs.started.mockReset().mockResolvedValue(undefined);
    stubs.reloadPlugins.mockReset().mockResolvedValue("applied");
    stubs.bootOutcome = Promise.resolve("applied");
    stubs.flush.mockReset().mockResolvedValue({ discarded: [], refused: [] });
    stubs.confirm.mockReset().mockResolvedValue(true);
    stubs.select.mockReset().mockResolvedValue("1");
    stubs.hold.mockReset().mockImplementation(() => stubs.release);
    stubs.pin.mockReset().mockImplementation(() => stubs.unpin);
    stubs.entry.mockReset().mockReturnValue({ id: target.chatId, name: "Chat", fmIndex: -1 });
    const { installFlatDatabase } = await import("../storage/tests/installFlatDatabase");
    installFlatDatabase({ characters: [{ chaId: target.chaId, name: "Character", type: "character" }] });
    // Warm dynamic boundaries before driving gates, including the real selection and local-send stores.
    await Promise.all([
        import("../process/index.svelte"),
        import("../plugins/plugins.svelte"),
        import("../storage/resourceSync.svelte"),
        import("../safeBoot"),
    ]);
    host = await import("./remoteHost");
    host.hostMode.set(true);
});
afterEach(async () => {
    await drain();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("remote host sends", () => {
    it("waits for plugins under a hold, selects the chat and runs the sender's local-only request once", async () => {
        const startup = deferred();
        const sending = deferred<boolean>();
        stubs.started.mockReturnValue(startup.promise);
        stubs.send.mockReturnValue(sending.promise);
        const stores = await import("../stores.svelte");
        stores.settingsOpen.set(true);
        stores.gridOpenStore.set(true);
        try {
            await deliver();
            expect(stubs.fetch).toHaveBeenCalledWith(
                "/api/remote-commands/command-7?clientId=host-client",
                expect.objectContaining({ method: "GET", headers: { "x-resource-epoch": EPOCH } }),
            );
            expect(stubs.hold).toHaveBeenCalledTimes(1);
            expect(stubs.release).not.toHaveBeenCalled();
            expect(stubs.send).not.toHaveBeenCalled();
            expect(states).toEqual([]);
            startup.resolve();
            await drain();
            expect(stubs.send).toHaveBeenCalledTimes(1);
            expect(stubs.send.mock.calls[0]![0]).toBe(-1);
            expect(sendArgs()).toMatchObject({
                target,
                input: "reviewed input",
                inputOriginal: "  original\ninput  ",
                userMessageId: "sender-message",
                requestId: "sender-request",
                stopOverLoreBudget: true,
                localOnly: true,
                noHandoffPreference: true,
                reports: [],
                signal: expect.any(AbortSignal),
            } satisfies Partial<ServerSendArg>);
            expect(sendArgs().requestUncertain).not.toBe(true);
            expect(stubs.pin).toHaveBeenCalledWith(target);
            expect(stubs.selectChat).toHaveBeenCalledWith(target.chaId, target.chatId);
            expect((await import("../storage/selection.svelte")).selection).toMatchObject({
                characterId: target.chaId,
                chatOpen: true,
            });
            expect(get(stores.settingsOpen)).toBe(false);
            expect(get(stores.gridOpenStore)).toBe(false);
            expect(stubs.unpin).not.toHaveBeenCalled();
            expect(JSON.parse(sessionStorage.getItem(savedKey)!)).toEqual([
                { commandId: "command-7", epoch: EPOCH, attempt: 7 },
            ]);
            expect(reports()).toEqual([{ clientId: "host-client", attempt: 7, state: "running" }]);
            await deliver();
            expect(stubs.send).toHaveBeenCalledTimes(1);
            expect(stubs.fetch.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(1);
            expect(reports().at(-1)?.state).toBe("running");
            sendArgs().onEnd?.(end);
        } finally {
            startup.resolve();
            sending.resolve(true);
            await drain();
        }
        expect(stubs.release).toHaveBeenCalledTimes(1);
        expect(stubs.unpin).toHaveBeenCalledTimes(1);
        expect(sessionStorage.getItem(savedKey)).toBeNull();
    });

    it.each(["stopped", "pluginsOff", "missing character", "missing chat", "busy"] as const)(
        "certifies %s only before an attempt and never starts a refused send",
        async (reason) => {
            const locals = await import("../process/localSends");
            const localCheck = vi.spyOn(locals, "isLocalSend");
            const release = reason === "busy" ? locals.beginLocalSend(target) : null;
            if (reason === "pluginsOff") {
                history.replaceState(null, "", "/?safe=plugins");
                (await import("../safeBoot")).beginSafeBoot();
            }
            if (reason === "missing character") {
                (await import("../storage/tests/installFlatDatabase")).installFlatDatabase({ characters: [] });
            }
            if (reason === "missing chat") stubs.entry.mockReturnValue(undefined);
            const code = reason.startsWith("missing") ? "chatMissing" : reason;
            try {
                read.stopRequested = reason === "stopped";
                await deliver();
                expect(reports()).toEqual([{ clientId: "host-client", attempt: 7, state: "refused", code }]);
                expect(stubs.send).not.toHaveBeenCalled();
                expect(stubs.started).not.toHaveBeenCalled();
                expect(get(host.hostCommandLog)[0]).toMatchObject({ commandId: "command-7", state: "refused", code });
                states.length = 0;
                localCheck.mockClear();
                read.attempted = true;
                await deliver();
                expect(localCheck).not.toHaveBeenCalled();
                if (reason === "busy") {
                    expect(stubs.send).toHaveBeenCalledTimes(1);
                    expect(sendArgs()).toMatchObject({ target, requestId: "sender-request", requestUncertain: true });
                    expect(reports().map(({ state }) => state)).toEqual(["running", "done"]);
                } else {
                    expect(reports()).toEqual([{ clientId: "host-client", attempt: 7, state: "uncertain" }]);
                    expect(stubs.send).not.toHaveBeenCalled();
                    expect(stubs.started).not.toHaveBeenCalled();
                }
            } finally {
                release?.();
            }
        },
    );

    it.each([true, false])(
        "reports a settled=%s end with its result, even when the send returned false",
        async (settled) => {
            const returnedEnd = {
                settled,
                outcome: "refused" as const,
                requestUncertain: !settled,
                reconciled: settled,
                blockedChats: [target],
            };
            stubs.send.mockImplementation(async (_index, arg) => {
                arg!.reports!.push({ kind: "error", text: "cannot send" });
                arg!.onServerRefused?.(!settled);
                arg!.onEnd?.(returnedEnd);
                return false;
            });
            await deliver();
            expect(reports()).toEqual([
                { clientId: "host-client", attempt: 7, state: "running" },
                {
                    clientId: "host-client",
                    attempt: 7,
                    state: settled ? "done" : "uncertain",
                    result: {
                        ...returnedEnd,
                        ok: false,
                        refusal: settled ? "definite" : "ambiguous",
                        reports: [{ kind: "error", text: "cannot send" }],
                    },
                },
            ]);
            expect(sessionStorage.getItem(savedKey)).toBeNull();
        },
    );

    it("returns an uncertain result with collected reports when the send throws", async () => {
        stubs.send.mockImplementation(async (_index, arg) => {
            arg!.reports!.push({ kind: "notice", text: "hooks skipped" });
            throw new Error("send failed");
        });
        await deliver();
        expect(reports().at(-1)).toEqual({
            clientId: "host-client",
            attempt: 7,
            state: "uncertain",
            result: {
                ok: false,
                settled: false,
                requestUncertain: true,
                outcome: "unknown",
                blockedChats: [],
                reports: [
                    { kind: "notice", text: "hooks skipped" },
                    { kind: "error", text: "send failed" },
                ],
            },
        });
    });

    it.each(["frame", "state acknowledgement"])("aborts a running send on a stop from a %s", async (source) => {
        const sending = deferred<boolean>();
        stubs.send.mockReturnValue(sending.promise);
        try {
            await deliver();
            expect(sendArgs().signal?.aborted).toBe(false);
            if (source === "state acknowledgement")
                stubs.fetch.mockResolvedValueOnce(Response.json({ state: "running", attempt: 7, stopRequested: true }));
            await deliver(source === "frame" ? { stop: true } : {});
            expect(stubs.send).toHaveBeenCalledTimes(1);
            expect(sendArgs().signal?.aborted).toBe(true);
            reports();
            sendArgs().onEnd?.(end);
        } finally {
            sending.resolve(false);
            await drain();
        }
    });

    it.each([false, true])("ends a stopped startup wait without sending when attempted=%s", async (attempted) => {
        read.attempted = attempted;
        const startup = deferred();
        stubs.started.mockReturnValue(startup.promise);
        try {
            await deliver();
            expect(stubs.started).toHaveBeenCalledTimes(1);
            expect(stubs.send).not.toHaveBeenCalled();
            await deliver({ stop: true });
            expect(reports()).toEqual([
                {
                    clientId: "host-client",
                    attempt: 7,
                    ...(attempted ? { state: "uncertain" } : { state: "refused", code: "stopped" }),
                },
            ]);
            expect(stubs.send).not.toHaveBeenCalled();
            expect(stubs.release).toHaveBeenCalledTimes(1);
        } finally {
            startup.resolve();
            await drain();
        }
    });

    it("reports the saved attempt uncertain after reload and removes it after acknowledgement", async () => {
        host.hostMode.set(false);
        sessionStorage.setItem(savedKey, JSON.stringify([{ commandId: "command-7", epoch: EPOCH, attempt: 7 }]));
        host.recoverHostCommands(EPOCH);
        await drain();
        expect(reports()).toEqual([{ clientId: "host-client", attempt: 7, state: "uncertain" }]);
        expect(stubs.send).not.toHaveBeenCalled();
        expect(stubs.fetch.mock.calls.every(([, init]) => init?.method === "POST")).toBe(true);
        expect(sessionStorage.getItem(savedKey)).toBeNull();
        expect(get(host.hostCommandLog)[0]).toMatchObject({ commandId: "command-7", state: "uncertain" });
    });
});

describe("remote host reloads", () => {
    it.each(["applied", "failed", "pluginsOff"] as const)(
        "reports running then done with %s for a plugins reload, without a work hold or duplicate execution",
        async (outcome) => {
            read.command = { type: "reload", mode: "plugins" };
            const loading = deferred<PluginReloadOutcome>();
            stubs.reloadPlugins.mockReturnValue(loading.promise);
            try {
                await deliver();
                expect(reports()).toEqual([{ clientId: "host-client", attempt: 7, state: "running" }]);
                expect(stubs.hold).not.toHaveBeenCalled();
                expect(stubs.reloadPlugins).toHaveBeenCalledTimes(1);
                await deliver();
                expect(reports()).toEqual([
                    { clientId: "host-client", attempt: 7, state: "running" },
                    { clientId: "host-client", attempt: 7, state: "running" },
                ]);
                loading.resolve(outcome);
                await drain();
                expect(reports()).toEqual([
                    { clientId: "host-client", attempt: 7, state: "running" },
                    { clientId: "host-client", attempt: 7, state: "running" },
                    { clientId: "host-client", attempt: 7, state: "done", result: { outcome } },
                ]);
                await deliver();
                expect(stubs.fetch.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(1);
                expect(stubs.reloadPlugins).toHaveBeenCalledTimes(1);
                expect(stubs.hold).not.toHaveBeenCalled();
                expect(stubs.send).not.toHaveBeenCalled();
                expect(get(host.hostCommandLog)[0]).toMatchObject({ type: "reload", state: "done" });
            } finally {
                loading.resolve(outcome);
                await drain();
            }
        },
    );

    it.each(["applied", "failed", "pluginsOff"] as const)(
        "saves a page reload across boot and reports %s once after the boot load, retaining the id until accepted",
        async (outcome) => {
            read.command = { type: "reload", mode: "page" };
            const flush = deferred<Awaited<ReturnType<typeof stubs.flush>>>();
            const boot = deferred<PluginReloadOutcome>();
            const accepted = deferred<Response>();
            const reload = vi.spyOn(location, "reload").mockImplementation(() => {});
            stubs.flush.mockReturnValue(flush.promise);
            try {
                await deliver();
                const saved = sessionStorage.getItem(savedKey);
                expect(JSON.parse(saved!)).toEqual([
                    { commandId: "command-7", epoch: EPOCH, attempt: 7, kind: "page" },
                ]);
                expect(reports()).toEqual([{ clientId: "host-client", attempt: 7, state: "running" }]);
                expect(stubs.flush).toHaveBeenCalledTimes(1);
                expect(reload).not.toHaveBeenCalled();
                expect(stubs.hold).not.toHaveBeenCalled();
                // A normal flush completes; a stuck write is bounded by the pending fake deadline.
                if (outcome === "applied") flush.resolve({ discarded: [], refused: [] });
                else await vi.runOnlyPendingTimersAsync();
                await drain();
                expect(reload).toHaveBeenCalledTimes(1);
                expect(sessionStorage.getItem(savedKey)).toBe(saved);

                // A navigation creates a new module lifetime but preserves sessionStorage.
                vi.resetModules();
                stubs.bootOutcome = boot.promise;
                host = await import("./remoteHost");
                states.length = 0;
                stubs.fetch.mockReset().mockImplementation(async (url, init) => {
                    expect(url).toBe(`/api/remote-commands/${frame.commandId}/state`);
                    expect(init?.method).toBe("POST");
                    states.push(JSON.parse(String(init?.body)) as RemoteCommandStateBody);
                    return accepted.promise;
                });
                host.hostMode.set(false);
                host.recoverHostCommands(EPOCH);
                host.hostMode.set(true);
                // Registration may immediately re-notify this id, before recovery's imports resolve.
                host.receiveHostCommand(frame);
                await drain();
                expect(reports()).toEqual([]);
                expect(stubs.fetch).not.toHaveBeenCalled();
                expect(sessionStorage.getItem(savedKey)).toBe(saved);
                boot.resolve(outcome);
                await drain();
                expect(reports()).toEqual([
                    { clientId: "host-client", attempt: 7, state: "done", result: { outcome } },
                ]);
                expect(sessionStorage.getItem(savedKey)).toBe(saved);
                accepted.resolve(Response.json({ state: "done", attempt: 7, stopRequested: false }));
                await drain();
                expect(sessionStorage.getItem(savedKey)).toBeNull();
                host.recoverHostCommands(EPOCH);
                await deliver();
                expect(stubs.fetch).toHaveBeenCalledTimes(1);
                expect(reports()).toEqual([
                    { clientId: "host-client", attempt: 7, state: "done", result: { outcome } },
                ]);
                expect(reload).toHaveBeenCalledTimes(1);
                expect(stubs.reloadPlugins).not.toHaveBeenCalled();
            } finally {
                flush.resolve({ discarded: [], refused: [] });
                boot.resolve(outcome);
                accepted.resolve(Response.json({ state: "done", attempt: 7, stopRequested: false }));
                await drain();
            }
        },
    );

    it("reports notReloaded without navigating when the page reload id cannot be saved", async () => {
        read.command = { type: "reload", mode: "page" };
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
            throw new Error("storage unavailable");
        });
        const reload = vi.spyOn(location, "reload").mockImplementation(() => {});
        await deliver();
        expect(reports()).toEqual([
            { clientId: "host-client", attempt: 7, state: "done", result: { outcome: "notReloaded" } },
        ]);
        await deliver();
        expect(stubs.fetch.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(1);
        expect(reload).not.toHaveBeenCalled();
        expect(stubs.flush).not.toHaveBeenCalled();
    });

    it.each(["page", undefined] as const)("confirms a page reload before posting with mode %s", async (mode) => {
        // No running job is required for confirmation, including when page mode comes from the chooser.
        stubs.fetch.mockImplementation(async (_url, init) =>
            Response.json(
                init?.method === "POST"
                    ? { state: "queued", attempted: false, stopRequested: false, attempt: 0 }
                    : {
                          state: "done",
                          attempted: true,
                          stopRequested: false,
                          attempt: 1,
                          result: { outcome: "applied" },
                      },
            ),
        );
        const confirmed = deferred<boolean>();
        stubs.confirm.mockReturnValueOnce(confirmed.promise);
        const targetHost = { clientId: "desk", name: "Desk" };
        const requesting = host.requestHostReload(targetHost, mode);
        try {
            await drain();
            expect(stubs.confirm).toHaveBeenCalledTimes(1);
            expect(stubs.fetch).not.toHaveBeenCalled();
            confirmed.resolve(false);
            await requesting;
            expect(stubs.fetch).not.toHaveBeenCalled();
        } finally {
            confirmed.resolve(false);
            await requesting;
        }

        await host.requestHostReload(targetHost, mode);
        expect(stubs.confirm).toHaveBeenCalledTimes(2);
        const posts = stubs.fetch.mock.calls.filter(([, init]) => init?.method === "POST");
        expect(posts).toHaveLength(1);
        expect(posts[0]![0]).toBe("/api/remote-commands");
        expect(JSON.parse(String(posts[0]![1]?.body))).toEqual({
            clientId: "host-client",
            target: "desk",
            commandId: expect.any(String),
            command: { type: "reload", mode: "page" },
        });
    });
});
