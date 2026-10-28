import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationEvent, GenerationStatus, GenerationTerminalEvent } from "../../../shared/jobs.ts";
import type { createFollowStub } from "../network/tests/generationJobsMock";
import { warmModules } from "../storage/tests/mutationStoresHarness";

// The tab's side of a server Lua button (`serverCommands.ts`) over a stubbed transport: one
// lifecycle per job shared by every caller (a button, a busy job of this tab, the boot resume), the
// bounded reattach after a socket closed without the terminal (growing waits, a failed status read
// retried, an opened socket the transport replaced on the page's return attached again at once and
// not counted), the end read from the job's status (the
// server's kept outcome of a collected job, or the last ended status when the attaches run out), a
// job the server no longer knows (gone: no lost alert, the chat read again, then the `endedAway`
// toast) told from a server that stays unreachable (lost), the chat read again after a lost or gone
// follow with its one retry at the next visible or online, the end reported once, the boot discovery
// joining an active follow and never releasing it, and `runServerButton`'s preflight (ids before the
// flush, a discarding or rejected flush runs nothing, a saved revision, the owned-busy path). Also
// `runServerJob` itself: the send kinds with their context, the `unknown` outcome of a create
// request without an answer, the abort signal (passed to the create, which cancels by request id; a
// DELETE for a started job, for a followed busy job, and for a job the create answered as the signal
// fired, none for a job its cancel answered; nothing posted after an abort before the flush ends),
// and a plugin call's identity.

const EPOCH = "11111111-2222-4333-8444-555555555555";
const ref = { chaId: "c", chatId: "k" };

type Follow = ReturnType<typeof createFollowStub> & { onEvent: (event: GenerationEvent) => void };
type Transport = typeof import("../network/generationJobs");

const stubs = vi.hoisted(() => ({
    follows: [] as unknown[],
    attached: undefined as (() => void) | undefined,
    chat: vi.fn<() => unknown>(() => undefined),
    current: vi.fn<() => typeof ref | null>(() => null),
    create: vi.fn<Transport["createGenerationJob"]>(),
    abort: vi.fn<(jobId: string) => Promise<void>>(async () => {}),
    read: vi.fn<Transport["readGenerationJob"]>(),
    release: vi.fn(),
    saved: vi.fn<() => string[]>(() => []),
    apply: vi.fn(),
    alertError: vi.fn(),
    /** `alertJobError`: a job's error terminal with its failure fields. */
    alertJobError: vi.fn(),
    /** `alertToast`: the nonmodal notice of a gone job's chat read again. */
    alertToast: vi.fn(),
    /** `sleep`: immediate, its requested waits recorded. */
    sleep: vi.fn<(ms: number) => Promise<void>>(async () => {}),
    flush: vi.fn<() => Promise<{ discarded: string[]; refused: string[] }>>(),
    refused: vi.fn<(typeof import("../storage/resourceSync.svelte"))["refusedItems"]>(() => []),
    /** `refreshStaleChat`: the pre-send read of a chat this tab knows is behind; true once it is current. */
    refresh: vi.fn<(ref: unknown) => Promise<boolean>>(),
    /** `generatingNoticeCount`: how many times the save adapter showed `chatGenerating`. */
    notices: vi.fn<() => number>(() => 0),
    /** `watchForRestore`: whether a restore replaced the data (a job ended by `maintenance` waits on it). */
    restored: vi.fn<() => Promise<boolean>>(async () => false),
    /** `ensureChatLoaded`: the target chat, loaded; `undefined` for a chat that is not listed. */
    load: vi.fn<() => Promise<unknown>>(async () => ({})),
    /** `pinChat`: a release per pin, so the runner's pin/release pairs run as the real ones do. */
    pin: vi.fn(() => vi.fn()),
    held: vi.fn<() => string | null>(() => "e:1:1"),
    /** `markChatStale`: true for a chat this tab holds. */
    markStale: vi.fn<() => boolean>(() => true),
    /** `isChatStale`: whether the stale mark is still there when a retry fires. */
    stale: vi.fn<() => boolean>(() => true),
    /**
     * `chatEntry`: the target chat's list entry, whose binding the runner sends; `undefined` for a
     * chat that is not listed. The default binds the records installed below.
     */
    entry: vi.fn<() => Record<string, unknown> | undefined>(() => ({})),
    /** `loadChat`: the runner reads the chat again after a binding mismatch. */
    loadChat: vi.fn<() => Promise<unknown>>(async () => ({})),
    /** `recordClientEvent`: the follow's diagnostics. */
    record: vi.fn<(input: unknown) => void>(),
}));
/** The seeded chat's binding: the one prompt and model preset (`preset`) and the selected persona. */
const BOUND = { modelPresetId: "preset", promptPresetId: "preset", bindedPersona: "selected" };

/** The job transport's typed refusals (the mock's classes, which the product code's `instanceof` sees). */
let BusyError: Transport["GenerationBusyError"];
let BindingRefusedError: Transport["ChatBindingRefusedError"];
let LoreOverrideOrphanedError: Transport["ChatLoreOverrideOrphanedError"];
/** `flushResources` refused because a change it must save waits for a generation. */
class BlockedError extends Error {
    constructor(readonly chats: readonly { chaId: string; chatId: string }[] = []) {
        super("A character is still being generated; try again when it finishes");
        this.name = "GenerationBlockedError";
    }
}
/** The resource client's error: `status` 0 is a request without an answer. */
class RequestError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}
/** The resource client's 412: the server data was replaced by a restore. */
class EpochMismatchError extends Error {
    constructor(readonly epoch: string) {
        super("The server data was replaced by a restore");
        this.name = "ResourceEpochMismatchError";
    }
}

vi.mock("src/lang", () => ({
    language: {
        chatGenerating: "generating",
        serverJob: {
            lost: "job lost",
            endedAway: "ended away",
            sequenceStopped: "/multisend stopped after {sent} of {total} parts: {reason}",
            sequenceReasons: { chatBindingMismatch: "binding changed" },
            discarded: { send: "discarded: send", button: "discarded: button", trigger: "discarded: trigger" },
            saveFailed: "save failed: {0}",
            chatLoadFailed: "load failed: {0}",
            chatNotSaved: "not saved",
            refusedDraft: "the server still refuses this local draft",
        },
        chatBinding: {
            refused: "cannot send",
            fields: { modelPresetId: "Model preset", promptPresetId: "Prompt preset", personaId: "Persona" },
            unset: "not set",
            gone: "deleted",
            review: "needs a confirmation",
            mismatch: "binding changed",
        },
        chatLoreOverrides: {
            refused: "overrides lost their entries",
            fixes: "delete or move them",
        },
    },
}));
vi.mock("../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: stubs.alertError,
        alertJobError: stubs.alertJobError,
        alertToast: stubs.alertToast,
    }),
);
vi.mock("../network/generationJobs", async () => {
    const { createGenerationJobsMock, createFollowStub } = await import("../network/tests/generationJobsMock");
    return createGenerationJobsMock({
        abortGenerationJob: (jobId: string) => stubs.abort(jobId),
        applyGenerationEvent: stubs.apply,
        createGenerationJob: stubs.create,
        followGenerationJob: (jobId: string, onEvent: (event: GenerationEvent) => void) => {
            const stub = createFollowStub(jobId);
            stubs.follows.push({ ...stub, onEvent });
            stubs.attached?.();
            return stub.follow;
        },
        readGenerationJob: stubs.read,
        releaseGenerationJob: stubs.release,
        savedGenerationJobIds: stubs.saved,
    });
});
vi.mock("../storage/chatStore.svelte", () => ({
    endServerJob: vi.fn(),
    chatEntry: stubs.entry,
    /** By default no chat is open: replies land away from the open chat. */
    currentChatRef: stubs.current,
    findChat: stubs.chat,
    ensureChatLoaded: stubs.load,
    heldChatRevision: stubs.held,
    isChatStale: stubs.stale,
    loadChat: stubs.loadChat,
    markChatStale: stubs.markStale,
    pinChat: stubs.pin,
}));
vi.mock("../storage/resourceClient", () => ({
    getResourceEpoch: () => EPOCH,
    ResourceEpochMismatchError: EpochMismatchError,
    ResourceRequestError: RequestError,
}));
vi.mock("../storage/resourceSync.svelte", () => ({
    flushResources: stubs.flush,
    refusedItems: stubs.refused,
    refreshStaleChat: stubs.refresh,
    GenerationBlockedError: BlockedError,
    generatingNoticeCount: stubs.notices,
    watchForRestore: stubs.restored,
}));
vi.mock("../util", () => ({ sleep: (ms: number) => stubs.sleep(ms) }));
vi.mock("../diagnostics/collector", async () =>
    (await import("../diagnostics/tests/collectorMock")).createCollectorMock({
        recordClientEvent: (input: unknown) => stubs.record(input),
    }),
);

type Module = typeof import("./serverCommands");
let commands: Module;

const follows = () => stubs.follows as Follow[];
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const done: GenerationTerminalEvent = { type: "done", epoch: EPOCH, revision: "e:1:2" };
const failed: GenerationTerminalEvent = { type: "error", epoch: EPOCH, message: "boom", status: 500, reason: "failed" };
const status: GenerationStatus = {
    jobId: "j",
    kind: "command",
    characterId: "c",
    chatId: "k",
    epoch: EPOCH,
    state: "running",
};
/** The server's kept outcome of the collected job `j` (its status after the job was collected). */
const kept = (terminal: GenerationTerminalEvent): GenerationStatus => ({
    ...status,
    state: "ended",
    kept: true,
    terminal,
});
/** The waits `sleep` was asked for, in order. */
const sleeps = () => stubs.sleep.mock.calls.map(([ms]) => ms);
/** Delivers the terminal through the follow's events and closes its socket, as the real follow does. */
const endWith = (follow: Follow, terminal: GenerationTerminalEvent) => {
    follow.onEvent(terminal);
    follow.end(terminal);
};

beforeAll(
    () => warmModules(() => Promise.all([import("../storage/tests/installFlatDatabase"), import("./serverCommands")])),
    60_000,
);

beforeEach(async () => {
    vi.resetModules();
    stubs.follows.length = 0;
    stubs.attached = undefined;
    stubs.chat.mockReset().mockReturnValue(undefined);
    stubs.current.mockReset().mockReturnValue(null);
    stubs.read.mockReset();
    stubs.create.mockReset();
    stubs.saved.mockReset().mockReturnValue([]);
    stubs.held.mockReset().mockReturnValue("e:1:1");
    stubs.load.mockReset().mockResolvedValue({});
    stubs.pin.mockReset().mockImplementation(() => vi.fn());
    stubs.entry.mockReset().mockReturnValue({ ...BOUND });
    stubs.loadChat.mockReset().mockResolvedValue({});
    stubs.flush.mockReset().mockResolvedValue({ discarded: [], refused: [] });
    stubs.refused.mockReset().mockReturnValue([]);
    stubs.refresh.mockReset().mockResolvedValue(true);
    stubs.notices.mockReset().mockReturnValue(0);
    stubs.restored.mockReset().mockResolvedValue(false);
    stubs.abort.mockReset().mockResolvedValue(undefined);
    stubs.markStale.mockReset().mockReturnValue(true);
    stubs.stale.mockReset().mockReturnValue(true);
    stubs.sleep.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The records the chat's binding names (`chatBinding` checks that they exist): the prompt preset
    // `preset` (and the model preset of the same id it implies), the personas `selected` and `bound`.
    const { installFlatDatabase } = await import("../storage/tests/installFlatDatabase");
    installFlatDatabase({
        botPresets: [{ id: "preset", name: "preset" }],
        personas: [
            { id: "selected", name: "Selected", personaPrompt: "", icon: "", note: "" },
            { id: "bound", name: "Bound", personaPrompt: "", icon: "", note: "" },
        ],
    });
    commands = await import("./serverCommands");
    ({
        GenerationBusyError: BusyError,
        ChatBindingRefusedError: BindingRefusedError,
        ChatLoreOverrideOrphanedError: LoreOverrideOrphanedError,
    } = await import("../network/generationJobs"));
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

describe("followJobToEnd", () => {
    it("shares one lifecycle per job: two callers get one socket and the same terminal, applied once, with no release or alert for `done`", async () => {
        const first = commands.followJobToEnd("j", ref);
        const second = commands.followJobToEnd("j", ref);
        await flush();
        expect(follows()).toHaveLength(1);
        endWith(follows()[0], done);
        expect(await first).toEqual(done);
        expect(await second).toEqual(done);
        expect(stubs.apply).toHaveBeenCalledTimes(1);
        expect(stubs.apply).toHaveBeenCalledWith("j", ref, done, expect.anything());
        expect(stubs.release).not.toHaveBeenCalled();
        expect(stubs.alertError).not.toHaveBeenCalled();
        // The lifecycle is over: a later call starts a new one.
        void commands.followJobToEnd("j", ref);
        await flush();
        expect(follows()).toHaveLength(2);
    });

    it("attaches again after a socket closed without the terminal, retrying a failed status read, and reports an error terminal once", async () => {
        stubs.read.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(status);
        const end = commands.followJobToEnd("j", ref);
        await flush();
        follows()[0].end(null);
        await flush();
        await flush();
        expect(follows()).toHaveLength(2);
        follows()[1].end(null);
        await flush();
        await flush();
        expect(follows()).toHaveLength(3);
        endWith(follows()[2], failed);
        expect(await end).toEqual(failed);
        // A job's error goes through `alertJobError` with its id and terminal (the alert's debug actions).
        expect(stubs.alertJobError).toHaveBeenCalledTimes(1);
        expect(stubs.alertJobError).toHaveBeenCalledWith("j", failed);
        expect(stubs.alertError).not.toHaveBeenCalled();
        expect(stubs.release).not.toHaveBeenCalled();
    });

    it("releases a job the server no longer knows (or of another epoch) as gone: no lost alert, the chat marked stale and read again, then the `endedAway` toast with its `notice` event; the caller gets `lost`; an aborted end is not alerted", async () => {
        stubs.read.mockResolvedValueOnce(null);
        const gone = commands.followJobToEnd("j", ref);
        await flush();
        follows()[0].end(null);
        expect(await gone).toBe("lost");
        expect(stubs.release).toHaveBeenCalledWith("j");
        expect(stubs.alertError).not.toHaveBeenCalled();
        expect(stubs.markStale).toHaveBeenCalledWith(ref);
        expect(stubs.refresh).toHaveBeenCalledWith(ref);
        expect(stubs.alertToast).toHaveBeenCalledTimes(1);
        expect(stubs.alertToast).toHaveBeenCalledWith("ended away");
        expect(stubs.record.mock.calls.map(([input]) => input)).toEqual([
            { kind: "jobLink", phase: "gone", jobId: "j" },
            { kind: "jobLink", phase: "recovered", jobId: "j" },
            { kind: "notice", notice: "serverJobEndedAway" },
        ]);
        // Read before the toast: the toast tells of a chat already reloaded.
        expect(stubs.refresh.mock.invocationCallOrder[0]).toBeLessThan(stubs.alertToast.mock.invocationCallOrder[0]);

        stubs.read.mockResolvedValueOnce({ ...status, epoch: "other" });
        const other = commands.followJobToEnd("j2", ref);
        await flush();
        follows()[1].end(null);
        expect(await other).toBe("lost");
        expect(stubs.release).toHaveBeenCalledWith("j2");
        expect(stubs.alertToast).toHaveBeenCalledTimes(2);

        const aborted = commands.followJobToEnd("j3", ref);
        await flush();
        endWith(follows()[2], { type: "error", epoch: EPOCH, message: "stopped", status: 499, reason: "aborted" });
        await aborted;
        expect(stubs.alertError).not.toHaveBeenCalled();
        expect(stubs.alertJobError).not.toHaveBeenCalled();
        // A live end: nothing to read again.
        expect(stubs.refresh).toHaveBeenCalledTimes(2);
    });

    it("gives up after the bounded number of attaches, waiting 1, 2, 4, then 8 s between them, releases the job as lost with its alert, and reads the chat again", async () => {
        stubs.read.mockResolvedValue(status);
        const end = commands.followJobToEnd("j", ref);
        for (let attach = 0; attach < 5; attach++) {
            await flush();
            await flush();
            follows()[attach].end(null);
        }
        expect(await end).toBe("lost");
        expect(follows()).toHaveLength(5);
        expect(sleeps()).toEqual([1000, 2000, 4000, 8000]);
        // Each status read is bounded.
        expect(stubs.read).toHaveBeenCalledTimes(5);
        expect(stubs.read).toHaveBeenCalledWith("j", { deadlineMs: 10_000 });
        expect(stubs.release).toHaveBeenCalledWith("j");
        expect(stubs.alertError.mock.calls).toEqual([["job lost"]]);
        expect(stubs.markStale).toHaveBeenCalledWith(ref);
        expect(stubs.refresh).toHaveBeenCalledWith(ref);
        expect(stubs.alertToast).not.toHaveBeenCalled();
    });

    it("leaves a job a restore or import ended (`maintenance`) to the restore watch: no alert when the data was replaced, its error once when nothing was, timed at the terminal's receipt", async () => {
        const maintenance: GenerationTerminalEvent = {
            type: "error",
            epoch: EPOCH,
            message: "The server is under maintenance",
            status: 503,
            reason: "maintenance",
        };
        let answer!: (replaced: boolean) => void;
        stubs.restored.mockReturnValueOnce(
            new Promise<boolean>((resolve) => {
                answer = resolve;
            }),
        );
        const replaced = commands.followJobToEnd("j", ref);
        await flush();
        endWith(follows()[0], maintenance);
        expect(await replaced).toEqual(maintenance);
        expect(stubs.restored).toHaveBeenCalledTimes(1);
        // The watch is still reading: nothing is shown yet, and nothing once the data was replaced.
        expect(stubs.alertError).not.toHaveBeenCalled();
        expect(stubs.alertJobError).not.toHaveBeenCalled();
        answer(true);
        await flush();
        expect(stubs.alertError).not.toHaveBeenCalled();
        expect(stubs.alertJobError).not.toHaveBeenCalled();

        // Nothing replaced: the job's error, with the time the terminal arrived, not the time the
        // restore watch (up to minutes) gave up.
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            vi.setSystemTime(1_000_000);
            let giveUp!: (replaced: boolean) => void;
            stubs.restored.mockReturnValueOnce(
                new Promise<boolean>((resolve) => {
                    giveUp = resolve;
                }),
            );
            const unchanged = commands.followJobToEnd("j2", ref);
            await flush();
            endWith(follows()[1], maintenance);
            await unchanged;
            vi.setSystemTime(1_120_000);
            giveUp(false);
            await flush();
            expect(stubs.restored).toHaveBeenCalledTimes(2);
            expect(stubs.alertJobError).toHaveBeenCalledTimes(1);
            expect(stubs.alertJobError).toHaveBeenCalledWith("j2", maintenance, 1_000_000);
            expect(stubs.alertError).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("resumeServerJobs (boot)", () => {
    it("discovers a saved job's chat from its status, retrying a failed read inside the shared lifecycle with growing waits, and releases it as lost when the reads keep failing", async () => {
        stubs.saved.mockReturnValue(["j"]);
        stubs.read.mockRejectedValue(new Error("offline"));
        await commands.resumeServerJobs();
        expect(stubs.read).toHaveBeenCalledTimes(5);
        expect(stubs.read).toHaveBeenCalledWith("j", { deadlineMs: 10_000 });
        expect(sleeps()).toEqual([1000, 2000, 4000, 8000]);
        expect(follows()).toHaveLength(0);
        expect(stubs.release).toHaveBeenCalledWith("j");
        expect(stubs.alertError).toHaveBeenCalledTimes(1);
        // No chat is known: nothing to read again.
        expect(stubs.refresh).not.toHaveBeenCalled();
    });

    it("joins an active follow of the job instead of discovering it, and never releases it", async () => {
        const active = commands.followJobToEnd("j", ref);
        stubs.saved.mockReturnValue(["j"]);
        stubs.read.mockRejectedValue(new Error("would have failed"));
        const boot = commands.resumeServerJobs();
        await flush();
        expect(stubs.read).not.toHaveBeenCalled();
        expect(follows()).toHaveLength(1);
        endWith(follows()[0], done);
        expect(await active).toEqual(done);
        await boot;
        expect(stubs.release).not.toHaveBeenCalled();
        expect(stubs.alertError).not.toHaveBeenCalled();
    });

    it("lets a button caller join a discovery boot started, so one socket follows the job", async () => {
        let answer!: (value: unknown) => void;
        stubs.read.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
        stubs.saved.mockReturnValue(["j"]);
        const boot = commands.resumeServerJobs();
        const button = commands.followJobToEnd("j", ref);
        await flush();
        expect(follows()).toHaveLength(0);
        answer(status);
        await flush();
        await flush();
        expect(follows()).toHaveLength(1);
        endWith(follows()[0], done);
        expect(await button).toEqual(done);
        await boot;
        expect(stubs.read).toHaveBeenCalledTimes(1);
        expect(stubs.release).not.toHaveBeenCalled();
    });
});

describe("runServerButton", () => {
    const char = { chaId: "c", type: "character" } as never;

    it("takes the target and the chat's binding before the flush, saves first, and runs a command job it then follows", async () => {
        stubs.entry.mockReturnValue({ ...BOUND, bindedPersona: "bound" });
        stubs.create.mockResolvedValue({ outcome: "created", jobId: "j" });
        const run = commands.runServerButton(char, "go", ref);
        // The binding was read: a change before the flush ends does not move the job.
        stubs.entry.mockReturnValue({ ...BOUND });
        await flush();
        expect(stubs.create).toHaveBeenCalledTimes(1);
        const body = stubs.create.mock.calls[0][0] as {
            kind: string;
            command: unknown;
            context: Record<string, unknown>;
        };
        expect(body.kind).toBe("command");
        expect(body.command).toEqual({ type: "button", data: "go" });
        expect(body.context).toMatchObject({
            characterId: "c",
            chatId: "k",
            presetId: "preset",
            modelPresetId: "preset",
            personaId: "bound",
            mode: "button",
            chatRevision: "e:1:1",
        });
        // A chat job has one persona, the chat's: no selected persona is sent.
        expect(body.context).not.toHaveProperty("selectedPersonaId");
        expect(body.context.client).toMatchObject({ viewport: { width: expect.any(Number) } });
        expect(stubs.flush).toHaveBeenCalledTimes(1);
        expect(follows()[0]?.jobId).toBe("j");
        endWith(follows()[0], done);
        expect(await run).toBe("started");
        expect(stubs.alertError).not.toHaveBeenCalled();
    });

    it("reads a chat this tab knows is behind the server after the flush and before the create, saving and reading once more when the first read did not bring it current, and goes on after two attempts; a failed read runs nothing", async () => {
        const order = (fn: { mock: { invocationCallOrder: number[] } }, index = 0) =>
            fn.mock.invocationCallOrder[index];
        stubs.create.mockResolvedValue({ outcome: "created", jobId: "j" });
        // Behind after the first read (a change landed meanwhile): saved and read once more.
        stubs.refresh.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        let run = commands.runServerButton(char, "go", ref);
        await flush();
        expect(stubs.refresh.mock.calls).toEqual([[ref], [ref]]);
        expect(stubs.flush).toHaveBeenCalledTimes(2);
        expect(stubs.create).toHaveBeenCalledTimes(1);
        expect(order(stubs.flush, 0)).toBeLessThan(order(stubs.refresh, 0));
        expect(order(stubs.refresh, 0)).toBeLessThan(order(stubs.flush, 1));
        expect(order(stubs.flush, 1)).toBeLessThan(order(stubs.refresh, 1));
        expect(order(stubs.refresh, 1)).toBeLessThan(order(stubs.load));
        expect(order(stubs.load)).toBeLessThan(order(stubs.create));
        endWith(follows()[0], done);
        await run;
        // Current after the first read: one flush, one read.
        stubs.flush.mockClear();
        stubs.refresh.mockClear();
        stubs.create.mockClear();
        run = commands.runServerButton(char, "go", ref);
        await flush();
        expect(stubs.flush).toHaveBeenCalledTimes(1);
        expect(stubs.refresh).toHaveBeenCalledTimes(1);
        expect(stubs.create).toHaveBeenCalledTimes(1);
        endWith(follows()[1], done);
        await run;
        // Still behind after two attempts: the job goes as it is (the server refuses an old revision).
        stubs.flush.mockClear();
        stubs.refresh.mockClear();
        stubs.create.mockClear();
        stubs.refresh.mockResolvedValue(false);
        run = commands.runServerButton(char, "go", ref);
        await flush();
        expect(stubs.flush).toHaveBeenCalledTimes(2);
        expect(stubs.refresh).toHaveBeenCalledTimes(2);
        expect(stubs.create).toHaveBeenCalledTimes(1);
        endWith(follows()[2], done);
        await run;
        expect(stubs.alertError).not.toHaveBeenCalled();
        // A failed read: alerted, nothing created.
        stubs.create.mockClear();
        stubs.refresh.mockReset().mockRejectedValueOnce(new Error("offline"));
        await commands.runServerButton(char, "go", ref);
        expect(stubs.create).not.toHaveBeenCalled();
        expect(stubs.alertError).toHaveBeenCalledTimes(1);
        expect(stubs.alertError).toHaveBeenLastCalledWith("load failed: offline");
    });

    it("runs nothing for a group, a discarding or rejected flush, a chat gone meanwhile, or an unsaved chat", async () => {
        await commands.runServerButton({ chaId: "g", type: "group" } as never, "go", ref);
        stubs.flush.mockResolvedValueOnce({ discarded: ["x"], refused: [] });
        await commands.runServerButton(char, "go", ref);
        stubs.flush.mockRejectedValueOnce(new Error("offline"));
        await commands.runServerButton(char, "go", ref);
        stubs.load.mockResolvedValueOnce(undefined);
        await commands.runServerButton(char, "go", ref);
        stubs.held.mockReturnValueOnce(null);
        await commands.runServerButton(char, "go", ref);
        expect(stubs.create).not.toHaveBeenCalled();
        expect(stubs.alertError.mock.calls.map((call) => String(call[0]))).toEqual([
            "discarded: button",
            "save failed: offline",
            "not saved",
        ]);
    });

    it("follows this tab's own busy job instead of running the button again, and reports another owner's job as busy", async () => {
        stubs.create.mockRejectedValueOnce(new BusyError("mine"));
        stubs.read.mockResolvedValueOnce(status);
        const own = commands.runServerButton(char, "go", ref);
        await flush();
        await flush();
        expect(follows()[0]?.jobId).toBe("mine");
        endWith(follows()[0], done);
        await own;
        expect(stubs.alertError).not.toHaveBeenCalled();

        stubs.create.mockRejectedValueOnce(new BusyError("theirs"));
        stubs.read.mockResolvedValueOnce(null);
        await commands.runServerButton(char, "go", ref);
        expect(follows()).toHaveLength(1);
        expect(stubs.alertError).toHaveBeenCalledWith("generating");
    });
});

// A manual trigger through the same preflight and follow, with its typed outcome and `onStart` (the
// tab sets `CurrentTriggerIdStore` there: only once the job exists).
describe("runServerManualTrigger", () => {
    const char = { chaId: "c", type: "character" } as never;

    it("posts a manual command with the trigger id in the context, calls onStart once the job exists and before the follow, and reports `started`", async () => {
        stubs.create.mockResolvedValue({ outcome: "created", jobId: "j" });
        const onStart = vi.fn(() => {
            expect(stubs.create).toHaveBeenCalledTimes(1);
            expect(follows()).toHaveLength(0);
        });
        const run = commands.runServerManualTrigger(char, "greet", ref, { triggerId: "btn-1", onStart });
        await flush();
        const body = stubs.create.mock.calls[0][0] as {
            kind: string;
            command: unknown;
            context: Record<string, unknown>;
        };
        expect(body.kind).toBe("command");
        expect(body.command).toEqual({ type: "manual", name: "greet" });
        expect(body.context).toMatchObject({
            characterId: "c",
            chatId: "k",
            presetId: "preset",
            personaId: "selected",
            mode: "manual",
            chatRevision: "e:1:1",
            triggerId: "btn-1",
        });
        expect(onStart).toHaveBeenCalledTimes(1);
        expect(follows()[0]?.jobId).toBe("j");
        endWith(follows()[0], done);
        expect(await run).toBe("started");
        expect(stubs.alertError).not.toHaveBeenCalled();
    });

    it("omits an absent trigger id and reports `started` for an error terminal too (the follow alerts it)", async () => {
        stubs.create.mockResolvedValue({ outcome: "created", jobId: "j" });
        const run = commands.runServerManualTrigger(char, "greet", ref);
        await flush();
        const body = stubs.create.mock.calls[0][0] as { context: Record<string, unknown> };
        expect("triggerId" in body.context).toBe(false);
        endWith(follows()[0], failed);
        expect(await run).toBe("started");
        expect(stubs.alertJobError).toHaveBeenCalledWith("j", failed);
    });

    it("reports `refused` without onStart for a group, a discarding or rejected flush, a chat gone meanwhile, an unsaved chat, or another owner's busy job", async () => {
        const onStart = vi.fn();
        const outcomes: string[] = [];
        outcomes.push(
            await commands.runServerManualTrigger({ chaId: "g", type: "group" } as never, "greet", ref, { onStart }),
        );
        stubs.flush.mockResolvedValueOnce({ discarded: ["x"], refused: [] });
        outcomes.push(await commands.runServerManualTrigger(char, "greet", ref, { onStart }));
        stubs.flush.mockRejectedValueOnce(new Error("offline"));
        outcomes.push(await commands.runServerManualTrigger(char, "greet", ref, { onStart }));
        stubs.load.mockResolvedValueOnce(undefined);
        outcomes.push(await commands.runServerManualTrigger(char, "greet", ref, { onStart }));
        stubs.held.mockReturnValueOnce(null);
        outcomes.push(await commands.runServerManualTrigger(char, "greet", ref, { onStart }));
        stubs.create.mockRejectedValueOnce(new BusyError("theirs"));
        stubs.read.mockResolvedValueOnce(null);
        outcomes.push(await commands.runServerManualTrigger(char, "greet", ref, { onStart }));
        expect(outcomes).toEqual(["refused", "refused", "refused", "refused", "refused", "refused"]);
        expect(onStart).not.toHaveBeenCalled();
        expect(follows()).toHaveLength(0);
        expect(stubs.alertError.mock.calls.map((call) => String(call[0]))).toEqual([
            "discarded: trigger",
            "save failed: offline",
            "not saved",
            "generating",
        ]);
    });

    it("reports `followed` without onStart when this tab's own job is busy", async () => {
        const onStart = vi.fn();
        stubs.create.mockRejectedValueOnce(new BusyError("mine"));
        stubs.read.mockResolvedValueOnce(status);
        const run = commands.runServerManualTrigger(char, "greet", ref, { triggerId: "btn-1", onStart });
        await flush();
        await flush();
        expect(follows()[0]?.jobId).toBe("mine");
        endWith(follows()[0], done);
        expect(await run).toBe("followed");
        expect(onStart).not.toHaveBeenCalled();
    });
});

// The shared job runner the sends use (`sendChatOnServer` maps its outcome).
describe("runServerJob", () => {
    const char = { chaId: "c", type: "character" } as never;
    const send = (
        context: Record<string, unknown>,
        options: Parameters<Module["runServerJob"]>[3] = {},
        kind = "send" as const,
    ) => commands.runServerJob(char, ref, { kind, label: "send", context }, options);

    it("follows a running replay once and calls onStart once after a lost create answer", async () => {
        vi.useFakeTimers();
        const transport = await vi.importActual<Transport>("../network/generationJobs");
        const { NO_GENERATION_HOOKS } = await import("../../../shared/jobs.ts");
        const auth = await import("../storage/serverAuth");
        const post = vi
            .spyOn(auth, "authFetch")
            .mockRejectedValueOnce(new TypeError("answer lost"))
            .mockResolvedValueOnce(Response.json({ jobId: "j", replayed: true, owned: true, status }));
        stubs.create.mockImplementation((body, options) =>
            transport.createGenerationJob({ ...body, hooks: NO_GENERATION_HOOKS }, options),
        );
        const onStart = vi.fn();
        try {
            const run = commands.runServerJob(
                char,
                ref,
                {
                    kind: "send",
                    label: "send",
                    requestId: "send-request",
                    context: { input: "hello", userMessageId: "user-one" },
                },
                { onStart },
            );
            await vi.advanceTimersByTimeAsync(0);
            expect(post).toHaveBeenCalledTimes(1);
            expect(onStart).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1000);
            expect(post).toHaveBeenCalledTimes(2);
            expect(post.mock.calls[1][1]!.body).toBe(post.mock.calls[0][1]!.body);
            expect(JSON.parse(String(post.mock.calls[1][1]!.body)).requestId).toBe("send-request");
            expect(follows()).toHaveLength(1);
            expect(onStart).toHaveBeenCalledTimes(1);
            endWith(follows()[0], done);
            expect(await run).toEqual({ outcome: "replayed", terminal: done, requestUncertain: false });
            expect(follows()).toHaveLength(1);
            expect(onStart).toHaveBeenCalledTimes(1);
        } finally {
            transport.releaseGenerationJob("j");
            vi.useRealTimers();
        }
    });

    it("returns an owned replay terminal even when subsequent chat reads fail, and refuses a foreign running replay", async () => {
        vi.useFakeTimers();
        try {
            const terminal: GenerationTerminalEvent = { ...done, result: ["kept preview"] };
            stubs.create.mockResolvedValueOnce({
                outcome: "replayed",
                jobId: "j",
                owned: true,
                status: kept(terminal),
            });
            stubs.refresh.mockResolvedValueOnce(true).mockRejectedValue(new Error("chat read offline"));
            stubs.read.mockRejectedValue(new Error("status read offline"));
            const onStart = vi.fn();
            const result = await send({ input: "hello" }, { onStart });
            expect(result).toEqual({ outcome: "replayed", terminal, requestUncertain: false });
            expect(stubs.apply).toHaveBeenCalledWith("j", ref, terminal);
            expect(stubs.refresh).toHaveBeenCalledTimes(2);
            expect(follows()).toHaveLength(0);
            expect(onStart).not.toHaveBeenCalled();
            stubs.load.mockResolvedValue({});
            stubs.refresh.mockResolvedValue(true);
            window.dispatchEvent(new Event("online"));
            await vi.advanceTimersByTimeAsync(0);
            stubs.create.mockResolvedValueOnce({
                outcome: "replayed",
                jobId: "foreign",
                owned: false,
                status: { ...status, jobId: "foreign" },
            });
            expect(await send({ input: "hello" }, { onStart })).toMatchObject({
                outcome: "refused",
                terminal: null,
                blockedChats: [ref],
            });
            expect(follows()).toHaveLength(0);
            expect(onStart).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("blocks send, button, and trigger jobs for refused targets or orders while allowing healthy chats", async () => {
        vi.useFakeTimers();
        try {
            const { language } = await import("src/lang");
            const refusals = [
                { kind: "chat", chaId: "c", chatId: "k", key: "chats\u0000c\u0000k", reason: "invalid chat" },
                { kind: "order", chaId: "c", key: "chatOrder\u0000c", reason: "invalid order" },
            ] satisfies ReturnType<typeof stubs.refused>;
            // An unexpected create answers immediately, so a missing guard fails without waiting
            // for a job terminal that a refused caller should never need.
            stubs.create.mockRejectedValue(new RequestError(400, "unexpected job creation"));
            for (const item of refusals) {
                const key = item.kind === "chat" ? "chats/c/k" : "chats/c";
                for (const source of ["inventory", "flush"] as const) {
                    stubs.refused.mockReturnValue(source === "inventory" ? [item] : []);
                    stubs.flush.mockResolvedValue({ discarded: [], refused: source === "flush" ? [key] : [] });
                    stubs.alertError.mockClear();
                    expect(await send({ input: "hi" })).toEqual({
                        outcome: "refused",
                        terminal: null,
                        requestUncertain: false,
                    });
                    expect(await commands.runServerButton(char, "go", ref)).toBe("refused");
                    expect(await commands.runServerManualTrigger(char, "greet", ref)).toBe("refused");
                    expect(stubs.create).not.toHaveBeenCalled();
                    expect(stubs.alertError.mock.calls).toEqual([
                        [language.serverJob.refusedDraft],
                        [language.serverJob.refusedDraft],
                        [language.serverJob.refusedDraft],
                    ]);
                }
            }

            stubs.alertError.mockClear();
            for (const item of refusals) {
                // A sibling chat is healthy despite k's refusal; an order refusal belongs only
                // to its character, even when another character uses the same chat id.
                const healthy = item.kind === "chat" ? { chaId: "c", chatId: "j" } : { chaId: "other", chatId: "k" };
                stubs.refused.mockReturnValue([item]);
                stubs.flush.mockResolvedValue({
                    discarded: [],
                    refused: [item.kind === "chat" ? "chats/c/k" : "chats/c"],
                });
                stubs.create.mockReset().mockResolvedValue({ outcome: "created", jobId: `job-${item.kind}` });
                stubs.follows.length = 0;
                const run = commands.runServerJob({ chaId: healthy.chaId, type: "character" } as never, healthy, {
                    kind: "send",
                    label: "send",
                    context: { input: "hi" },
                });
                await vi.waitFor(() => expect(follows()).toHaveLength(1));
                expect(stubs.create).toHaveBeenCalledExactlyOnceWith(
                    expect.objectContaining({
                        context: expect.objectContaining({ characterId: healthy.chaId, chatId: healthy.chatId }),
                    }),
                    { signal: undefined, requestUncertain: undefined },
                );
                endWith(follows()[0], done);
                expect(await run).toEqual({ outcome: "started", terminal: done, requestUncertain: false });
            }
            expect(stubs.alertError).not.toHaveBeenCalled();
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it("posts the kind with the caller's context fields and no command, and reports `started` with the terminal", async () => {
        stubs.create.mockResolvedValue({ outcome: "created", jobId: "j" });
        const run = send({ input: "hi", userMessageId: "u1", continueMessageId: "m9" });
        await flush();
        const body = stubs.create.mock.calls[0][0] as {
            kind: string;
            command?: unknown;
            context: Record<string, unknown>;
        };
        expect(body.kind).toBe("send");
        expect("command" in body).toBe(false);
        expect(body.context).toMatchObject({
            characterId: "c",
            chatId: "k",
            presetId: "preset",
            modelPresetId: "preset",
            personaId: "selected",
            mode: "send",
            input: "hi",
            userMessageId: "u1",
            continueMessageId: "m9",
            chatRevision: "e:1:1",
        });
        endWith(follows()[0], done);
        expect(await run).toEqual({ outcome: "started", terminal: done, requestUncertain: false });
        expect(stubs.abort).not.toHaveBeenCalled();
    });

    it("takes a plugin call's captured ids as the identity instead of the binding, once the chat's binding is complete", async () => {
        stubs.create.mockResolvedValue({ outcome: "created", jobId: "j" });
        const run = send(
            { input: "" },
            { identity: { presetId: "plug-preset", modelPresetId: "plug-model", personaId: "plug-persona" } },
        );
        await flush();
        const body = stubs.create.mock.calls[0][0] as { context: Record<string, unknown> };
        expect(body.context).toMatchObject({
            presetId: "plug-preset",
            modelPresetId: "plug-model",
            personaId: "plug-persona",
        });
        expect(body.context).not.toHaveProperty("selectedPersonaId");
        endWith(follows()[0], done);
        await run;
    });

    // The send guard: a chat whose binding is not complete runs nothing, before the flush and the
    // create, never on the tab's selection; the server's 409s are shown the same way.
    it("refuses a chat whose binding is not complete before the flush, listing each problem, and never falls back to the selection", async () => {
        stubs.entry.mockReturnValue({ bindedPersona: "nope", bindingReview: true });
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null, requestUncertain: false });
        expect(
            await send(
                { input: "hi" },
                { identity: { presetId: "preset", modelPresetId: "preset", personaId: "selected" } },
            ),
        ).toEqual({ outcome: "refused", terminal: null, requestUncertain: false });
        expect(await commands.runServerButton(char, "go", ref)).toBe("refused");
        expect(await commands.runServerManualTrigger(char, "greet", ref, { triggerId: "t" })).toBe("refused");
        expect(stubs.flush).not.toHaveBeenCalled();
        expect(stubs.create).not.toHaveBeenCalled();
        expect(follows()).toHaveLength(0);
        expect(stubs.alertError).toHaveBeenCalledTimes(4);
        expect(stubs.alertError.mock.calls[0][0]).toBe(
            [
                "cannot send",
                "Model preset: not set",
                "Prompt preset: not set",
                "Persona: deleted",
                "needs a confirmation",
            ].join("\n"),
        );
        // A chat that is not listed: refused with the header alone (no fields to list).
        stubs.entry.mockReturnValue(undefined);
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null, requestUncertain: false });
        expect(stubs.alertError).toHaveBeenLastCalledWith("cannot send");
        expect(stubs.create).not.toHaveBeenCalled();
    });

    it("shows the server's 409 binding refusals: a mismatch reads the chat again and asks to send again, an incomplete binding lists its problems", async () => {
        stubs.create.mockRejectedValueOnce(new BindingRefusedError("chatBindingMismatch"));
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null, requestUncertain: false });
        expect(stubs.loadChat).toHaveBeenCalledTimes(1);
        expect(stubs.loadChat).toHaveBeenCalledWith(ref);
        expect(stubs.alertError).toHaveBeenLastCalledWith("binding changed");
        stubs.create.mockRejectedValueOnce(
            new BindingRefusedError("chatBindingIncomplete", [{ field: "promptPresetId", reason: "gone" }]),
        );
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null, requestUncertain: false });
        expect(stubs.loadChat).toHaveBeenCalledTimes(1);
        expect(stubs.alertError).toHaveBeenLastCalledWith("cannot send\nPrompt preset: deleted");
        expect(follows()).toHaveLength(0);
        expect(stubs.alertError).toHaveBeenCalledTimes(2);
        // A failed re-read is logged, not shown twice.
        stubs.loadChat.mockRejectedValueOnce(new Error("offline"));
        stubs.create.mockRejectedValueOnce(new BindingRefusedError("chatBindingMismatch"));
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null, requestUncertain: false });
        await flush();
        expect(stubs.alertError).toHaveBeenCalledTimes(3);
    });

    it("reports refused for orphaned lore overrides and alerts once with localized text naming every entry", async () => {
        const entries = [
            { id: "deleted-title", name: "Lost title" },
            { id: "deleted-key", name: "Lost key" },
            { id: "deleted-off", name: "deleted-off" },
        ];
        stubs.create.mockRejectedValueOnce(new LoreOverrideOrphanedError(entries));
        const onStart = vi.fn();

        expect(await send({ input: "hi" }, { onStart })).toEqual({
            outcome: "refused",
            terminal: null,
            requestUncertain: false,
        });
        expect(stubs.alertError).toHaveBeenCalledTimes(1);
        const [message] = stubs.alertError.mock.calls[0];
        expect(message).toContain("overrides lost their entries");
        expect(message).toContain("delete or move them");
        for (const name of ["Lost title", "Lost key", "deleted-off"]) {
            expect(message).toContain(name);
        }
        expect(onStart).not.toHaveBeenCalled();
        expect(follows()).toHaveLength(0);
    });

    it("reports `unknown` for a create request without an answer and `refused` for an answered refusal, alerting once each", async () => {
        const { GenerationCreateError, GenerationStaleError } = await import("../network/generationJobs");
        const uncertain = { outcome: "unknown", terminal: null, requestUncertain: true };
        const definite = { outcome: "refused", terminal: null, requestUncertain: false };
        // The transport's retries ended with no answer (or an answer the registry did not give).
        stubs.create.mockRejectedValueOnce(new GenerationCreateError(new RequestError(0, "fetch failed"), true));
        expect(await send({ input: "hi" })).toEqual(uncertain);
        stubs.create.mockRejectedValueOnce(new GenerationCreateError(new RequestError(429, "Too many requests"), true));
        expect(await send({ input: "hi" })).toEqual(uncertain);
        stubs.create.mockRejectedValueOnce(new TypeError("fetch failed"));
        expect(await send({ input: "hi" })).toEqual(uncertain);
        stubs.create.mockRejectedValueOnce(new RequestError(0, "The network is unreachable"));
        expect(await send({ input: "hi" })).toEqual(uncertain);
        stubs.create.mockRejectedValueOnce(new RequestError(400, "context.userMessageId must be an id"));
        expect(await send({ input: "hi" })).toEqual(definite);
        stubs.create.mockRejectedValueOnce(new RequestError(409, "stale"));
        expect(await send({ input: "hi" })).toEqual(definite);
        // The registry's stale refusal and the restore's 412 are answers too: nothing ran.
        stubs.create.mockRejectedValueOnce(new GenerationStaleError());
        expect(await send({ input: "hi" })).toEqual(definite);
        stubs.create.mockRejectedValueOnce(new EpochMismatchError("other"));
        expect(await send({ input: "hi" })).toEqual(definite);
        expect(follows()).toHaveLength(0);
        expect(stubs.alertError.mock.calls.map((call) => String(call[0]))).toEqual([
            "job lost",
            "job lost",
            "fetch failed",
            "The network is unreachable",
            "context.userMessageId must be an id",
            "stale",
            "The chat changed on the server; reload it and send again",
            "The server data was replaced by a restore",
        ]);
    });

    it("aborts the job it started when the signal fires, and one created as the signal fired as soon as it exists; a create answered by its cancel is not aborted again", async () => {
        const stopped: GenerationTerminalEvent = {
            type: "error",
            epoch: EPOCH,
            message: "stopped",
            status: 499,
            reason: "aborted",
        };
        stubs.create.mockResolvedValue({ outcome: "created", jobId: "j" });
        const controller = new AbortController();
        const run = send({ input: "hi" }, { signal: controller.signal });
        await flush();
        // The transport gets the signal: it cancels a dispatched create by its request id.
        expect(stubs.create).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ signal: controller.signal }),
        );
        expect(follows()[0]?.jobId).toBe("j");
        controller.abort();
        await flush();
        expect(stubs.abort).toHaveBeenCalledWith("j");
        endWith(follows()[0], stopped);
        expect((await run).outcome).toBe("started");

        // A job the create answered as the signal fired is aborted once it exists.
        let answer!: (result: Awaited<ReturnType<Transport["createGenerationJob"]>>) => void;
        stubs.create.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
        const during = new AbortController();
        const late = send({ input: "hi" }, { signal: during.signal });
        await flush();
        during.abort();
        answer({ outcome: "created", jobId: "j2" });
        await flush();
        expect(stubs.abort).toHaveBeenLastCalledWith("j2");
        endWith(follows()[1], stopped);
        expect((await late).outcome).toBe("started");

        // The transport's cancel found this request's own job and aborted it: followed as a replay to
        // its terminal, without onStart and without a second abort.
        stubs.abort.mockClear();
        const onStart = vi.fn();
        stubs.create.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
        const cancelling = new AbortController();
        const replayed = send({ input: "hi" }, { signal: cancelling.signal, onStart });
        await flush();
        cancelling.abort();
        answer({ outcome: "replayed", jobId: "j3", owned: true, status: { ...status, jobId: "j3" }, cancelled: true });
        await flush();
        expect(follows()[2]?.jobId).toBe("j3");
        endWith(follows()[2], stopped);
        expect(await replayed).toEqual({ outcome: "replayed", terminal: stopped, requestUncertain: false });
        expect(onStart).not.toHaveBeenCalled();
        expect(stubs.abort).not.toHaveBeenCalled();

        // The cancel answered before any job existed: nothing ran, and nothing is followed or aborted.
        stubs.create.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
        const before = new AbortController();
        const none = send({ input: "hi" }, { signal: before.signal, onStart });
        await flush();
        before.abort();
        answer({ outcome: "cancelled" });
        expect(await none).toEqual({ outcome: "refused", terminal: null, requestUncertain: false });
        expect(follows()).toHaveLength(3);
        expect(onStart).not.toHaveBeenCalled();
        expect(stubs.abort).not.toHaveBeenCalled();
    });

    it("aborts this tab's busy job it follows instead, reporting `followed` without onStart", async () => {
        stubs.create.mockRejectedValueOnce(new BusyError("mine"));
        stubs.read.mockResolvedValueOnce(status);
        const onStart = vi.fn();
        const controller = new AbortController();
        const run = send({ input: "hi" }, { signal: controller.signal, onStart });
        await flush();
        await flush();
        expect(follows()[0]?.jobId).toBe("mine");
        controller.abort();
        await flush();
        expect(stubs.abort).toHaveBeenCalledWith("mine");
        endWith(follows()[0], done);
        expect(await run).toEqual({ outcome: "followed", terminal: done, requestUncertain: false });
        expect(onStart).not.toHaveBeenCalled();
    });

    it("posts nothing for a signal already aborted when the flush ends", async () => {
        const controller = new AbortController();
        stubs.flush.mockImplementationOnce(async () => {
            controller.abort();
            return { discarded: [], refused: [] };
        });
        expect(await send({ input: "hi" }, { signal: controller.signal })).toEqual({
            outcome: "refused",
            terminal: null,
            requestUncertain: false,
        });
        expect(stubs.create).not.toHaveBeenCalled();
        expect(stubs.abort).not.toHaveBeenCalled();
    });

    // A flush refused because a change waits for a generation (another tab's job) is reported as
    // `chatGenerating`, not as a save error, and only once with the adapter's.
    it("shows chatGenerating for a flush refused for a generation unless the adapter's recovery showed it during the flush, and posts nothing", async () => {
        // Refused at once (no recovery during this flush): the send shows the notice itself.
        // The chats the flush waited on are passed on (a reroll restores its replies unless its own chat waits).
        const other = { chaId: "c2", chatId: "k2" };
        stubs.flush.mockRejectedValueOnce(new BlockedError([other]));
        expect(await send({ input: "hi" })).toEqual({
            outcome: "refused",
            terminal: null,
            blockedChats: [other],
            requestUncertain: false,
        });
        expect(stubs.alertError.mock.calls).toEqual([["generating"]]);
        // The flush's conflict recovery showed it (the count moved during the flush): no second alert.
        let count = 0;
        stubs.notices.mockImplementation(() => count);
        stubs.flush.mockImplementationOnce(async () => {
            count += 1;
            throw new BlockedError();
        });
        expect(await send({ input: "hi" })).toEqual({
            outcome: "refused",
            terminal: null,
            blockedChats: [],
            requestUncertain: false,
        });
        expect(stubs.alertError).toHaveBeenCalledTimes(1);
        // Another explicit send in the same episode (the adapter does not show it again): feedback again.
        stubs.flush.mockRejectedValueOnce(new BlockedError());
        expect(await send({ input: "hi" })).toEqual({
            outcome: "refused",
            terminal: null,
            blockedChats: [],
            requestUncertain: false,
        });
        expect(stubs.alertError.mock.calls).toEqual([["generating"], ["generating"]]);
        expect(stubs.create).not.toHaveBeenCalled();
        expect(follows()).toHaveLength(0);
    });

    it("keeps a plain Error with the generation text, and any other flush error, on the save-error path", async () => {
        stubs.flush.mockRejectedValueOnce(
            new Error("A character is still being generated; try again when it finishes"),
        );
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null, requestUncertain: false });
        stubs.flush.mockRejectedValueOnce(new Error("offline"));
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null, requestUncertain: false });
        expect(stubs.alertError.mock.calls.map((call) => String(call[0]))).toEqual([
            "save failed: A character is still being generated; try again when it finishes",
            "save failed: offline",
        ]);
        expect(stubs.create).not.toHaveBeenCalled();
    });

    it("shows a send's refusals as `language.serverJob` entries, the error's text in their `{0}` taken literally", async () => {
        stubs.flush.mockResolvedValueOnce({ discarded: ["x"], refused: [] });
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null, requestUncertain: false });
        stubs.flush.mockRejectedValueOnce(new Error("quota $& {0} $1"));
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null, requestUncertain: false });
        stubs.refresh.mockRejectedValueOnce(new Error("offline $'"));
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null, requestUncertain: false });
        stubs.held.mockReturnValueOnce(null);
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null, requestUncertain: false });
        expect(stubs.alertError.mock.calls.map((call) => String(call[0]))).toEqual([
            "discarded: send",
            "save failed: quota $& {0} $1",
            "load failed: offline $'",
            "not saved",
        ]);
        expect(stubs.create).not.toHaveBeenCalled();
    });

    it("reads the notice count before the flush: a count moved before this send started does not hide its notice", async () => {
        let count = 3;
        stubs.notices.mockImplementation(() => count);
        stubs.flush.mockRejectedValueOnce(new BlockedError());
        expect(await send({ input: "hi" })).toEqual({
            outcome: "refused",
            terminal: null,
            blockedChats: [],
            requestUncertain: false,
        });
        expect(stubs.alertError.mock.calls).toEqual([["generating"]]);
        count = 4;
        stubs.flush.mockRejectedValueOnce(new BlockedError());
        expect(await send({ input: "hi" })).toEqual({
            outcome: "refused",
            terminal: null,
            blockedChats: [],
            requestUncertain: false,
        });
        expect(stubs.alertError.mock.calls).toEqual([["generating"], ["generating"]]);
    });

    it("still reports another tab's busy job at the create as chatGenerating after a successful flush, naming the target as blocked", async () => {
        stubs.create.mockRejectedValueOnce(new BusyError("theirs"));
        stubs.read.mockResolvedValueOnce(null);
        // Its job may hold no lock this tab knows of yet: a reroll must not restore into the chat.
        expect(await send({ input: "hi" })).toEqual({
            outcome: "refused",
            terminal: null,
            blockedChats: [ref],
            requestUncertain: false,
        });
        expect(stubs.alertError.mock.calls).toEqual([["generating"]]);
        expect(follows()).toHaveLength(0);
    });
});

// The tab's own `/multisend` loop: a command job's parts never reach it.
const multisendStubs = vi.hoisted(() => ({
    runMultisend: vi.fn<(ref: unknown, clear: boolean, parts: readonly string[]) => Promise<boolean>>(),
}));
vi.mock("./command", () => ({ runMultisend: multisendStubs.runMultisend }));

// After a socket closed without the terminal, the follow reads the job's status: the server's kept
// outcome of a collected job is the end (applied as the socket's terminal would be), a job the server
// no longer knows is gone, a failed read attaches again. After a lost or gone follow, and after an end
// read from the status that this tab's copy may lack, the chat is marked stale and read again within
// the step deadline, with one retry at the next visible or online.
describe("the end read from the job's status, and the chat read after the follow", () => {
    const links = () => stubs.record.mock.calls.map(([input]) => input);
    const settle = async () => {
        for (let round = 0; round < 8; round += 1) {
            await flush();
        }
    };
    /** Closes the newest follow without a terminal, so the status is read. */
    const closeLatest = async () => {
        await flush();
        follows().at(-1)!.end(null);
    };
    const unseen = async () => get((await import("src/ts/process/chatStatus.svelte")).unseenChatKeys);

    it("applies a kept `done` as the job's end: the unseen reply marked, the chat read again only when the terminal's revision is newer than the held one, no notice", async () => {
        // Real revision tokens, so the comparison is the shared one (not "incomparable, so newer").
        const held = `${EPOCH}:1:1`;
        const newer = `${EPOCH}:1:2`;
        stubs.held.mockReturnValue(held);
        const done = { type: "done", epoch: EPOCH, revision: newer } satisfies GenerationTerminalEvent;
        stubs.read.mockResolvedValueOnce(kept(done));
        const end = commands.followJobToEnd("j", ref);
        await closeLatest();
        expect(await end).toEqual(done);
        expect(follows()).toHaveLength(1);
        // Released as the socket's terminal would release it, not as a lost job.
        expect(stubs.apply).toHaveBeenCalledWith("j", ref, done);
        expect(stubs.release).not.toHaveBeenCalled();
        expect(await unseen()).toEqual(new Set());
        expect(links()).toEqual([{ kind: "jobLink", phase: "kept", jobId: "j" }]);
        // Newer than the held revision: read again, silently.
        expect(stubs.markStale).toHaveBeenCalledWith(ref);
        expect(stubs.refresh).toHaveBeenCalledWith(ref);
        expect(stubs.alertError).not.toHaveBeenCalled();
        expect(stubs.alertToast).not.toHaveBeenCalled();
        expect(stubs.alertJobError).not.toHaveBeenCalled();

        // A reply the tab did not see: the sidebar's unseen mark needs the message id.
        stubs.read.mockResolvedValueOnce(kept({ ...done, messageId: "reply" }));
        stubs.refresh.mockClear();
        const marked = commands.followJobToEnd("j2", ref);
        await closeLatest();
        await marked;
        expect(await unseen()).toEqual(new Set(["c\u0000k"]));
        expect(stubs.refresh).toHaveBeenCalledTimes(1);

        // The held revision already: nothing to read.
        stubs.refresh.mockClear();
        stubs.markStale.mockClear();
        stubs.read.mockResolvedValueOnce(kept({ ...done, revision: held }));
        const same = commands.followJobToEnd("j3", ref);
        await closeLatest();
        expect(await same).toEqual({ ...done, revision: held });
        stubs.read.mockResolvedValueOnce(kept({ ...done, revision: null }));
        const none = commands.followJobToEnd("j4", ref);
        await closeLatest();
        await none;
        expect(stubs.markStale).not.toHaveBeenCalled();
        expect(stubs.refresh).not.toHaveBeenCalled();
        expect(stubs.alertError).not.toHaveBeenCalled();
    });

    it("applies a kept `error` as the job's end: the same alert as when watched live, and the chat read again", async () => {
        stubs.read.mockResolvedValueOnce(kept(failed));
        const end = commands.followJobToEnd("j", ref);
        await closeLatest();
        expect(await end).toEqual(failed);
        expect(stubs.apply).toHaveBeenCalledWith("j", ref, failed);
        expect(stubs.alertJobError).toHaveBeenCalledTimes(1);
        expect(stubs.alertJobError).toHaveBeenCalledWith("j", failed);
        expect(stubs.alertError).not.toHaveBeenCalled();
        expect(stubs.release).not.toHaveBeenCalled();
        expect(stubs.refresh).toHaveBeenCalledWith(ref);
        expect(links()).toEqual([{ kind: "jobLink", phase: "kept", jobId: "j" }]);
    });

    it("keeps an ended status's terminal as the end when a later read finds the job unknown (the server restarted) or the attaches run out, applying it once; another epoch's terminal is not kept", async () => {
        // Ended but still live on the server (inside its grace): attached again for its final records;
        // the next read answers 404.
        stubs.read.mockResolvedValueOnce({ ...status, state: "ended", terminal: failed }).mockResolvedValueOnce(null);
        const restarted = commands.followJobToEnd("j", ref);
        await flush();
        follows()[0].end(null);
        await flush();
        await flush();
        expect(follows()).toHaveLength(2);
        follows()[1].end(null);
        expect(await restarted).toEqual(failed);
        expect(stubs.apply).toHaveBeenCalledTimes(1);
        expect(stubs.apply).toHaveBeenCalledWith("j", ref, failed);
        expect(stubs.alertJobError).toHaveBeenCalledWith("j", failed);
        expect(stubs.alertToast).not.toHaveBeenCalled();
        expect(stubs.release).not.toHaveBeenCalled();
        expect(links().filter((link) => (link as { phase: string }).phase !== "reattach")).toEqual([]);

        // Ended and live through every attach (sockets that never deliver): the last read's terminal.
        stubs.apply.mockClear();
        stubs.refresh.mockClear();
        stubs.read.mockReset().mockResolvedValue({ ...status, state: "ended", terminal: done });
        const exhausted = commands.followJobToEnd("j2", ref);
        for (let attach = 0; attach < 5; attach++) {
            await flush();
            await flush();
            follows()[2 + attach].end(null);
        }
        expect(await exhausted).toEqual(done);
        expect(stubs.apply).toHaveBeenCalledTimes(1);
        expect(stubs.apply).toHaveBeenCalledWith("j2", ref, done);
        expect(stubs.alertError).not.toHaveBeenCalled();
        expect(stubs.refresh).toHaveBeenCalledWith(ref);
        expect(links().filter((link) => (link as { phase: string }).phase === "lost")).toEqual([]);

        // The terminal read names another epoch: a 404 after it is a gone job, not that end.
        stubs.apply.mockClear();
        stubs.read
            .mockReset()
            .mockResolvedValueOnce({ ...status, state: "ended", terminal: { ...failed, epoch: "other" } })
            .mockResolvedValueOnce(null);
        const replaced = commands.followJobToEnd("j3", ref);
        await flush();
        follows()[7].end(null);
        await flush();
        await flush();
        follows()[8].end(null);
        expect(await replaced).toBe("lost");
        expect(stubs.apply).not.toHaveBeenCalled();
        expect(stubs.release).toHaveBeenCalledWith("j3");
        expect(stubs.alertToast).toHaveBeenCalledWith("ended away");
    });

    it("attaches again at once, not counting the attach, after the transport replaced an opened socket on the page's return (`resumed`); a close the transport gave up counts and waits", async () => {
        stubs.read.mockResolvedValue(status);
        const end = commands.followJobToEnd("j", ref);
        await flush();
        expect(follows()).toHaveLength(1);
        // Four replaced sockets: a status read each, no wait, nothing of the budget spent.
        for (let replaced = 0; replaced < 4; replaced += 1) {
            follows().at(-1)!.resume();
            await flush();
            await flush();
            expect(follows()).toHaveLength(2 + replaced);
        }
        expect(stubs.read).toHaveBeenCalledTimes(4);
        expect(sleeps()).toEqual([]);
        expect(links().filter((link) => (link as { phase: string }).phase === "reattach")).toEqual(
            Array(4).fill({ kind: "jobLink", phase: "reattach", jobId: "j", attempt: 0 }),
        );
        // Five closes the transport gave up spend the whole budget with the growing waits: lost.
        for (let attach = 0; attach < 5; attach += 1) {
            follows().at(-1)!.end(null);
            await flush();
            await flush();
        }
        expect(await end).toBe("lost");
        expect(follows()).toHaveLength(9);
        expect(stubs.read).toHaveBeenCalledTimes(9);
        expect(sleeps()).toEqual([1000, 2000, 4000, 8000]);
        expect(stubs.release).toHaveBeenCalledWith("j");
        expect(stubs.alertError.mock.calls).toEqual([["job lost"]]);
    });

    it("reports an unreachable server as lost and reads the chat once more at the next `online` or visible, once, unless the stale mark is gone by then", async () => {
        stubs.read.mockRejectedValue(new RequestError(0, "offline"));
        stubs.refresh.mockResolvedValueOnce(false);
        const end = commands.followJobToEnd("j", ref);
        for (let attach = 0; attach < 5; attach++) {
            await flush();
            await flush();
            follows()[attach].end(null);
        }
        expect(await end).toBe("lost");
        expect(stubs.alertError.mock.calls).toEqual([["job lost"]]);
        expect(stubs.refresh).toHaveBeenCalledTimes(1);
        expect(links()).toContainEqual({ kind: "jobLink", phase: "lost", jobId: "j" });
        expect(links()).not.toContainEqual({ kind: "jobLink", phase: "recovered", jobId: "j" });
        // Hidden: not yet.
        const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("online"));
        await flush();
        expect(stubs.refresh).toHaveBeenCalledTimes(1);
        visibility.mockReturnValue("visible");
        window.dispatchEvent(new Event("online"));
        await flush();
        expect(stubs.refresh).toHaveBeenCalledTimes(2);
        expect(links()).toContainEqual({ kind: "jobLink", phase: "recovered", jobId: "j" });
        // Once: the listeners are gone.
        window.dispatchEvent(new Event("online"));
        document.dispatchEvent(new Event("visibilitychange"));
        await flush();
        expect(stubs.refresh).toHaveBeenCalledTimes(2);
        visibility.mockRestore();

        // A gone job whose read did not take: its toast waits for the retry's read.
        stubs.refresh.mockClear();
        stubs.read.mockReset().mockResolvedValue(null);
        stubs.refresh.mockResolvedValueOnce(false);
        const gone = commands.followJobToEnd("j2", ref);
        await flush();
        follows()[5].end(null);
        expect(await gone).toBe("lost");
        expect(stubs.alertToast).not.toHaveBeenCalled();
        document.dispatchEvent(new Event("visibilitychange"));
        await flush();
        expect(stubs.refresh).toHaveBeenCalledTimes(2);
        expect(stubs.alertToast).toHaveBeenCalledWith("ended away");

        // The stale mark gone by the retry (the chat was read another way): no read, no toast.
        stubs.refresh.mockClear();
        stubs.alertToast.mockClear();
        stubs.refresh.mockResolvedValueOnce(false);
        const elsewhere = commands.followJobToEnd("j3", ref);
        await flush();
        follows()[6].end(null);
        await elsewhere;
        stubs.stale.mockReturnValue(false);
        window.dispatchEvent(new Event("online"));
        await flush();
        expect(stubs.refresh).toHaveBeenCalledTimes(1);
        expect(stubs.alertToast).not.toHaveBeenCalled();
    });

    it("does not read a chat this tab does not hold, and reads nothing twice for one chat: a newer recovery ends the older, whose late result does nothing", async () => {
        stubs.markStale.mockReturnValueOnce(false);
        stubs.read.mockResolvedValue(null);
        const unheld = commands.followJobToEnd("j", ref);
        await closeLatest();
        expect(await unheld).toBe("lost");
        expect(stubs.refresh).not.toHaveBeenCalled();
        expect(stubs.alertToast).not.toHaveBeenCalled();
        expect(links()).toEqual([{ kind: "jobLink", phase: "gone", jobId: "j" }]);

        let answerFirst!: (current: boolean) => void;
        stubs.refresh.mockReturnValueOnce(new Promise<boolean>((resolve) => (answerFirst = resolve)));
        const first = commands.followJobToEnd("j2", ref);
        await flush();
        follows()[1].end(null);
        await flush();
        await flush();
        expect(stubs.refresh).toHaveBeenCalledTimes(1);
        const second = commands.followJobToEnd("j3", ref);
        await flush();
        follows()[2].end(null);
        expect(await second).toBe("lost");
        expect(stubs.alertToast).toHaveBeenCalledTimes(1);
        expect(links()).toContainEqual({ kind: "jobLink", phase: "recovered", jobId: "j3" });
        answerFirst(true);
        expect(await first).toBe("lost");
        expect(stubs.alertToast).toHaveBeenCalledTimes(1);
        expect(links()).not.toContainEqual({ kind: "jobLink", phase: "recovered", jobId: "j2" });
    });

    it("bounds the chat's read to 10 s: a kept outcome's follow ends at the deadline while its read has not taken, a lost follow's late read still counts", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            const tick = () => vi.advanceTimersByTimeAsync(0);
            let answer!: (current: boolean) => void;
            stubs.refresh.mockReturnValueOnce(new Promise<boolean>((resolve) => (answer = resolve)));
            stubs.read.mockResolvedValueOnce(kept(done));
            const end = commands.followJobToEnd("j", ref);
            let ended = false;
            void end.then(() => (ended = true));
            await tick();
            follows()[0].end(null);
            await vi.advanceTimersByTimeAsync(9_999);
            expect(ended).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(await end).toEqual(done);
            expect(stubs.alertError).not.toHaveBeenCalled();
            answer(true);
            await tick();

            stubs.refresh.mockReset();
            let late!: (current: boolean) => void;
            stubs.refresh.mockReturnValueOnce(new Promise<boolean>((resolve) => (late = resolve)));
            stubs.read.mockReset().mockRejectedValue(new RequestError(0, "offline"));
            const lost = commands.followJobToEnd("j2", ref);
            for (let attach = 0; attach < 5; attach++) {
                await tick();
                follows()[1 + attach].end(null);
            }
            await vi.advanceTimersByTimeAsync(10_000);
            expect(await lost).toBe("lost");
            expect(links()).not.toContainEqual({ kind: "jobLink", phase: "recovered", jobId: "j2" });
            late(true);
            await tick();
            expect(links()).toContainEqual({ kind: "jobLink", phase: "recovered", jobId: "j2" });
            // Recovered: the retry listeners are gone.
            window.dispatchEvent(new Event("online"));
            await tick();
            expect(stubs.refresh).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

// The job's chat is pinned from the start and loaded after the flush, before the job is created (a
// failed load alerts and runs nothing); a followed job's chat is pinned once it is known and loaded
// before the follow attaches (retried like a status read; a load that keeps failing makes the job
// lost); the follow-ups take their own pin. Every exit releases the pin once.
describe("the job's chat", () => {
    const char = { chaId: "c", type: "character" } as never;
    /** Whether every pin taken so far was released exactly once. */
    const pinsBalanced = () =>
        stubs.pin.mock.results.every((result) => (result.value as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    const order = (fn: { mock: { invocationCallOrder: number[] } }, index = 0) => fn.mock.invocationCallOrder[index];
    const settle = async () => {
        for (let round = 0; round < 8; round += 1) {
            await flush();
        }
    };

    it("pins the target before the flush, loads it after the flush and before the create, holds the pin while the job runs, and releases it once on every exit", async () => {
        stubs.create.mockResolvedValue({ outcome: "created", jobId: "j" });
        const run = commands.runServerButton(char, "go", ref);
        await flush();
        expect(stubs.pin).toHaveBeenCalledWith(ref);
        expect(order(stubs.pin)).toBeLessThan(order(stubs.flush));
        expect(stubs.load).toHaveBeenCalledWith(ref);
        expect(order(stubs.load)).toBeGreaterThan(order(stubs.flush));
        expect(order(stubs.load)).toBeLessThan(order(stubs.create));
        // Held while the job runs (the runner's pin and the follow's).
        expect(pinsBalanced()).toBe(false);
        endWith(follows()[0], done);
        await run;
        expect(pinsBalanced()).toBe(true);

        // A failed load: alerted, nothing created, the pin released.
        stubs.load.mockRejectedValueOnce(new Error("offline"));
        await commands.runServerButton(char, "go", ref);
        expect(stubs.create).toHaveBeenCalledTimes(1);
        expect(stubs.alertError).toHaveBeenLastCalledWith("load failed: offline");
        expect(pinsBalanced()).toBe(true);
        // A refused flush and a target that is not listed: nothing created, the pin released.
        stubs.flush.mockRejectedValueOnce(new Error("offline"));
        await commands.runServerButton(char, "go", ref);
        stubs.load.mockResolvedValueOnce(undefined);
        await commands.runServerButton(char, "go", ref);
        expect(stubs.create).toHaveBeenCalledTimes(1);
        expect(stubs.pin).toHaveBeenCalledTimes(5);
        expect(pinsBalanced()).toBe(true);
    });

    it("followJobToEnd loads the job's chat before attaching, retrying a failed load; a load that keeps failing, or a chat that is not listed, releases the job as lost", async () => {
        stubs.load.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({});
        const end = commands.followJobToEnd("j", ref);
        await settle();
        expect(stubs.load).toHaveBeenCalledTimes(2);
        expect(follows()).toHaveLength(1);
        // Pinned before the load, loaded before the attach.
        expect(order(stubs.pin)).toBeLessThan(order(stubs.load));
        endWith(follows()[0], done);
        expect(await end).toEqual(done);
        expect(stubs.release).not.toHaveBeenCalled();
        expect(pinsBalanced()).toBe(true);

        stubs.load.mockReset().mockRejectedValue(new Error("offline"));
        stubs.sleep.mockClear();
        expect(await commands.followJobToEnd("j2", ref)).toBe("lost");
        expect(stubs.load).toHaveBeenCalledTimes(5);
        expect(sleeps()).toEqual([1000, 2000, 4000, 8000]);
        expect(follows()).toHaveLength(1);
        expect(stubs.release).toHaveBeenCalledWith("j2");
        expect(stubs.alertError).toHaveBeenCalledTimes(1);
        expect(stubs.alertError.mock.calls[0][0]).toBe("job lost");
        expect(pinsBalanced()).toBe(true);

        stubs.load.mockReset().mockResolvedValue(undefined);
        expect(await commands.followJobToEnd("j3", ref)).toBe("lost");
        expect(stubs.load).toHaveBeenCalledTimes(1);
        expect(stubs.release).toHaveBeenCalledWith("j3");
        expect(pinsBalanced()).toBe(true);
    });

    it("a job discovered at boot pins its chat once the status names it, and releases the pin at the end", async () => {
        stubs.read.mockResolvedValue(status);
        const end = commands.followJobToEnd("j");
        await settle();
        expect(stubs.pin).toHaveBeenCalledTimes(1);
        expect(stubs.pin).toHaveBeenCalledWith({ chaId: "c", chatId: "k" });
        expect(order(stubs.read)).toBeLessThan(order(stubs.pin));
        expect(stubs.load).toHaveBeenCalledWith({ chaId: "c", chatId: "k" });
        endWith(follows()[0], done);
        await end;
        await settle();
        expect(stubs.pin).toHaveBeenCalledTimes(1);
        expect(pinsBalanced()).toBe(true);
    });
});

describe("the follow's diagnostics", () => {
    const links = () => stubs.record.mock.calls.map(([input]) => input);

    it("records `reattach` with its attempt before every attach after the first, `lost` once when the attaches run out with the `serverJobLost` notice it alerts, and `recovered` when the chat's read after it took", async () => {
        stubs.read.mockResolvedValue(status);
        const end = commands.followJobToEnd("j", ref);
        for (let attach = 0; attach < 5; attach++) {
            await flush();
            await flush();
            follows()[attach].end(null);
        }
        expect(await end).toBe("lost");
        expect(links()).toEqual([
            { kind: "jobLink", phase: "reattach", jobId: "j", attempt: 1 },
            { kind: "jobLink", phase: "reattach", jobId: "j", attempt: 2 },
            { kind: "jobLink", phase: "reattach", jobId: "j", attempt: 3 },
            { kind: "jobLink", phase: "reattach", jobId: "j", attempt: 4 },
            { kind: "jobLink", phase: "lost", jobId: "j" },
            { kind: "notice", notice: "serverJobLost" },
            { kind: "jobLink", phase: "recovered", jobId: "j" },
        ]);
        expect(stubs.alertError).toHaveBeenCalledTimes(1);
    });

    it("records `gone` once for a job the server does not know at boot, `lost` for a chat that cannot be loaded, and nothing for a job that ends", async () => {
        stubs.read.mockResolvedValue(null);
        expect(await commands.followJobToEnd("gone")).toBe("lost");
        expect(links()).toEqual([{ kind: "jobLink", phase: "gone", jobId: "gone" }]);
        stubs.record.mockClear();
        stubs.load.mockResolvedValue(undefined);
        // A chat that could not be loaded is not held: nothing is marked or read again.
        stubs.markStale.mockReturnValueOnce(false);
        expect(await commands.followJobToEnd("unloaded", ref)).toBe("lost");
        expect(links()).toEqual([
            { kind: "jobLink", phase: "lost", jobId: "unloaded" },
            { kind: "notice", notice: "serverJobLost" },
        ]);
        expect(stubs.refresh).not.toHaveBeenCalled();
        stubs.record.mockClear();
        stubs.load.mockResolvedValue({});
        const end = commands.followJobToEnd("fine", ref);
        await flush();
        endWith(follows().at(-1)!, failed);
        expect(await end).toEqual(failed);
        expect(links()).toEqual([]);
    });

    it("records `resume` per saved job before its follow starts", async () => {
        stubs.saved.mockReturnValue(["a", "b"]);
        stubs.read.mockResolvedValue(status);
        const resumed = commands.resumeServerJobs();
        expect(links()).toEqual([
            { kind: "jobLink", phase: "resume", jobId: "a" },
            { kind: "jobLink", phase: "resume", jobId: "b" },
        ]);
        await flush();
        await flush();
        expect(follows()).toHaveLength(2);
        for (const follow of follows()) {
            endWith(follow, done);
        }
        await resumed;
        expect(links()).toHaveLength(2);
    });
});

describe("followedJobs", () => {
    const jobsOf = (chat: { chaId: string; chatId: string }) =>
        commands.followedJobsOf(get(commands.followedJobs), chat);

    it("lists a followed job under its chat from the follow's start until its end, for done and for an error, and drops its stage with it", async () => {
        const { jobStages, setJobStage } = await import("./jobStages");
        const end = commands.followJobToEnd("j", ref);
        await flush();
        setJobStage("j", ref, "finishing");
        expect(jobsOf(ref)).toEqual(["j"]);
        expect(jobsOf({ chaId: "c", chatId: "other" })).toEqual([]);
        endWith(follows()[0], done);
        expect(await end).toEqual(done);
        expect(jobsOf(ref)).toEqual([]);
        expect(get(jobStages).has("j")).toBe(false);

        const failing = commands.followJobToEnd("j2", ref);
        await flush();
        setJobStage("j2", ref, "generating");
        expect(jobsOf(ref)).toEqual(["j2"]);
        endWith(follows()[1], failed);
        await failing;
        expect(jobsOf(ref)).toEqual([]);
        expect(get(jobStages).has("j2")).toBe(false);
    });

    it("lists a job resumed at boot under the chat its status names, and drops it and its stage when the job is lost", async () => {
        const { jobStages, setJobStage } = await import("./jobStages");
        stubs.saved.mockReturnValue(["j"]);
        stubs.read.mockResolvedValue(status);
        const boot = commands.resumeServerJobs();
        await flush();
        await flush();
        setJobStage("j", ref, "memory");
        expect(jobsOf({ chaId: status.characterId, chatId: status.chatId })).toEqual(["j"]);
        // The socket closes without a terminal and the server no longer knows the job: gone.
        stubs.read.mockResolvedValue(null);
        follows()[0].end(null);
        await boot;
        expect(jobsOf({ chaId: status.characterId, chatId: status.chatId })).toEqual([]);
        expect(get(jobStages).has("j")).toBe(false);
    });

    it("keeps a newer job of the same chat listed, with its stage, when the older follow ends after it started", async () => {
        const { jobStages, setJobStage, chatStageOf } = await import("./jobStages");
        const older = commands.followJobToEnd("old", ref);
        await flush();
        setJobStage("old", ref, "finishing");
        const newer = commands.followJobToEnd("new", ref);
        await flush();
        setJobStage("new", ref, "generating");
        expect(jobsOf(ref).sort()).toEqual(["new", "old"]);
        endWith(follows()[0], done);
        await older;
        expect(jobsOf(ref)).toEqual(["new"]);
        expect([...get(jobStages)]).toEqual([["new", { chatKey: "c\u0000k", stage: "generating" }]]);
        expect(chatStageOf(get(jobStages), ref)).toBe("generating");
        endWith(follows()[1], done);
        await newer;
        expect(jobsOf(ref)).toEqual([]);
        expect(get(jobStages).size).toBe(0);
    });

    it("drops a job whose chat cannot be loaded, and its stage, once the follow ends as lost, and never keeps a job the server does not know", async () => {
        const { jobStages, setJobStage } = await import("./jobStages");
        stubs.load.mockReset().mockRejectedValue(new Error("offline"));
        const end = commands.followJobToEnd("j", ref);
        setJobStage("j", ref, "preparing");
        expect(await end).toBe("lost");
        expect(jobsOf(ref)).toEqual([]);
        expect(get(jobStages).has("j")).toBe(false);

        stubs.saved.mockReturnValue(["gone"]);
        stubs.read.mockResolvedValue(null);
        const boot = commands.resumeServerJobs();
        setJobStage("gone", ref, "memory");
        await boot;
        expect(get(commands.followedJobs).size).toBe(0);
        expect(get(jobStages).has("gone")).toBe(false);
    });
});

describe("server sequence events", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }));
    afterEach(() => vi.useRealTimers());
    function attached() {
        return new Promise<void>((resolve) => {
            stubs.attached = resolve;
        });
    }

    it("installs every part's alternatives and counts each received part once while following one job", async () => {
        const { settings } = await import("../storage/settingsViews.svelte");
        const { Prereroll } = await import("./prereroll");
        settings.statics = { imports: 0, messages: 7 };
        stubs.current.mockReturnValue(ref);
        stubs.chat.mockReturnValue({
            message: [
                { role: "char", chatId: "r1", data: "first", generationInfo: { generationId: "g1" } },
                { role: "char", chatId: "r2", data: "second", generationInfo: { generationId: "g2" } },
            ],
        });
        stubs.create.mockResolvedValue({ outcome: "created", jobId: "sequence" });
        const ready = attached();
        const run = commands.runServerJob({ chaId: "c", type: "character" } as never, ref, {
            kind: "command",
            label: "button",
            command: { type: "button", data: "go" },
        });
        await ready;
        const follow = follows()[0];
        follow.onEvent({
            type: "sequence",
            epoch: EPOCH,
            index: 0,
            total: 2,
            sent: 1,
            messageId: "r1",
            alternatives: ["first", "first alternative"],
        });
        expect(settings.statics.messages).toBe(8);
        expect(Prereroll("g1")).toBe("first alternative");
        expect(get(commands.followedJobs).has("sequence")).toBe(true);
        follow.onEvent({
            type: "sequence",
            epoch: EPOCH,
            index: 1,
            total: 2,
            sent: 2,
            messageId: "r2",
            alternatives: ["second", "second alternative"],
        });
        expect(settings.statics.messages).toBe(9);
        expect(Prereroll("g2")).toBe("second alternative");
        endWith(follow, { ...done, messageId: "r2", sequence: { total: 2, sent: 2 } });
        expect((await run).terminal).toMatchObject({ type: "done", sequence: { total: 2, sent: 2 } });
        expect(settings.statics.messages).toBe(9);
        expect(stubs.create).toHaveBeenCalledTimes(1);
        expect(multisendStubs.runMultisend).not.toHaveBeenCalled();
    });

    it.each(["live", "kept"])("shows the stopped sequence notice from a %s terminal", async (source) => {
        const terminal: GenerationTerminalEvent = {
            ...done,
            sequence: { total: 3, sent: 1, stopped: "chatBindingMismatch" },
        };
        const ready = attached();
        const end = commands.followJobToEnd("sequence", ref);
        await ready;
        if (source === "kept") {
            stubs.read.mockResolvedValue(kept(terminal));
            follows()[0].end(null);
        } else endWith(follows()[0], terminal);
        expect(await end).toEqual(terminal);
        expect(stubs.alertError.mock.calls).toEqual([["/multisend stopped after 1 of 3 parts: binding changed"]]);
        expect(multisendStubs.runMultisend).not.toHaveBeenCalled();
    });

    it("a done without sequence or queued parts starts no tab send", async () => {
        const ready = attached();
        const end = commands.followJobToEnd("old", ref);
        await ready;
        endWith(follows()[0], done);
        expect(await end).toEqual(done);
        await vi.dynamicImportSettled();
        expect(stubs.create).not.toHaveBeenCalled();
        expect(multisendStubs.runMultisend).not.toHaveBeenCalled();
        expect(stubs.alertError).not.toHaveBeenCalled();
    });
});
