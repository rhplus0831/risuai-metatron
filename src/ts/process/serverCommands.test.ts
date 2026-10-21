import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationEvent, GenerationTerminalEvent } from "../../../shared/jobs.ts";

// The tab's side of a server Lua button (`serverCommands.ts`) over a stubbed transport: one
// lifecycle per job shared by every caller (a button, a busy job of this tab, the boot resume), the
// bounded reattach after a socket closed without the terminal (a failed status read retried, a job
// the server no longer knows released as lost), the end reported once, the boot discovery joining
// an active follow and never releasing it, and `runServerButton`'s preflight (ids before the flush,
// a discarding or rejected flush runs nothing, a saved revision, the owned-busy path). Also
// `runServerJob` itself: the send kinds with their context, the `unknown` outcome of a create
// request without an answer, the abort signal (a DELETE for a started job, for a followed busy job,
// and for a signal that fired during the create; nothing posted after an abort before the flush
// ends), and a plugin call's identity.

const EPOCH = "11111111-2222-4333-8444-555555555555";
const ref = { chaId: "c", chatId: "k" };

type Follow = {
    jobId: string;
    onEvent: (event: GenerationEvent) => void;
    end: (terminal: GenerationTerminalEvent | null) => void;
};

const stubs = vi.hoisted(() => ({
    follows: [] as unknown[],
    create: vi.fn<(body: unknown) => Promise<string>>(),
    abort: vi.fn<(jobId: string) => Promise<void>>(async () => {}),
    read: vi.fn<(jobId: string) => Promise<unknown>>(),
    release: vi.fn(),
    saved: vi.fn<() => string[]>(() => []),
    apply: vi.fn(),
    alertError: vi.fn(),
    /** `alertJobError`: a job's error terminal with its failure fields. */
    alertJobError: vi.fn(),
    flush: vi.fn<() => Promise<{ discarded: string[] }>>(),
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

class BusyError extends Error {
    constructor(readonly jobId: string) {
        super("busy");
    }
}
/** The job transport's 409 `chatBindingIncomplete` / `chatBindingMismatch` (`ChatBindingRefusedError`). */
class BindingRefusedError extends Error {
    constructor(
        readonly code: "chatBindingIncomplete" | "chatBindingMismatch",
        readonly problems: { field: string; reason?: string }[] = [],
    ) {
        super(code);
    }
}
/** `flushResources` refused because a change it must save waits for a generation. */
class BlockedError extends Error {
    constructor() {
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

vi.mock("src/lang", () => ({
    language: {
        chatGenerating: "generating",
        serverJob: {
            lost: "job lost",
            discarded: { send: "discarded: send", button: "discarded: button", trigger: "discarded: trigger" },
            saveFailed: "save failed: {0}",
            chatLoadFailed: "load failed: {0}",
            chatNotSaved: "not saved",
        },
        chatBinding: {
            refused: "cannot send",
            fields: { modelPresetId: "Model preset", promptPresetId: "Prompt preset", personaId: "Persona" },
            unset: "not set",
            gone: "deleted",
            review: "needs a confirmation",
            mismatch: "binding changed",
        },
    },
}));
vi.mock("../alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: stubs.alertError,
        alertJobError: stubs.alertJobError,
    }),
);
vi.mock("../network/generationJobs", () => ({
    abortGenerationJob: (jobId: string) => stubs.abort(jobId),
    applyGenerationEvent: stubs.apply,
    createGenerationJob: stubs.create,
    followGenerationJob: (jobId: string, onEvent: (event: GenerationEvent) => void) => {
        let end!: (terminal: GenerationTerminalEvent | null) => void;
        const closed = new Promise<{ terminal: GenerationTerminalEvent | null }>((resolve) => {
            end = (terminal) => resolve({ terminal });
        });
        stubs.follows.push({ jobId, onEvent, end });
        return { closed, send: () => true, close() {} };
    },
    ChatBindingRefusedError: BindingRefusedError,
    GenerationBusyError: BusyError,
    readGenerationJob: stubs.read,
    releaseGenerationJob: stubs.release,
    savedGenerationJobIds: stubs.saved,
}));
vi.mock("../storage/chatStore.svelte", () => ({
    chatEntry: stubs.entry,
    ensureChatLoaded: stubs.load,
    heldChatRevision: stubs.held,
    loadChat: stubs.loadChat,
    pinChat: stubs.pin,
}));
vi.mock("../storage/resourceClient", () => ({ getResourceEpoch: () => EPOCH, ResourceRequestError: RequestError }));
vi.mock("../storage/resourceSync.svelte", () => ({
    flushResources: stubs.flush,
    refreshStaleChat: stubs.refresh,
    GenerationBlockedError: BlockedError,
    generatingNoticeCount: stubs.notices,
    watchForRestore: stubs.restored,
}));
vi.mock("../util", () => ({ sleep: async () => {} }));
vi.mock("../diagnostics/collector", () => ({ recordClientEvent: (input: unknown) => stubs.record(input) }));

type Module = typeof import("./serverCommands");
let commands: Module;

const follows = () => stubs.follows as Follow[];
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const done: GenerationTerminalEvent = { type: "done", epoch: EPOCH, revision: "e:1:2" };
const failed: GenerationTerminalEvent = { type: "error", epoch: EPOCH, message: "boom", status: 500, reason: "failed" };
const status = { jobId: "j", kind: "command", characterId: "c", chatId: "k", epoch: EPOCH, state: "running" };
/** Delivers the terminal through the follow's events and closes its socket, as the real follow does. */
const endWith = (follow: Follow, terminal: GenerationTerminalEvent) => {
    follow.onEvent(terminal);
    follow.end(terminal);
};

beforeEach(async () => {
    vi.resetModules();
    stubs.follows.length = 0;
    stubs.read.mockReset();
    stubs.create.mockReset();
    stubs.saved.mockReset().mockReturnValue([]);
    stubs.held.mockReset().mockReturnValue("e:1:1");
    stubs.load.mockReset().mockResolvedValue({});
    stubs.pin.mockReset().mockImplementation(() => vi.fn());
    stubs.entry.mockReset().mockReturnValue({ ...BOUND });
    stubs.loadChat.mockReset().mockResolvedValue({});
    stubs.flush.mockReset().mockResolvedValue({ discarded: [] });
    stubs.refresh.mockReset().mockResolvedValue(true);
    stubs.notices.mockReset().mockReturnValue(0);
    stubs.restored.mockReset().mockResolvedValue(false);
    stubs.abort.mockReset().mockResolvedValue(undefined);
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

    it("releases a job the server no longer knows (or of another epoch) as lost, with one alert, and does not alert an aborted end", async () => {
        stubs.read.mockResolvedValueOnce(null);
        const lost = commands.followJobToEnd("j", ref);
        await flush();
        follows()[0].end(null);
        expect(await lost).toBe("lost");
        expect(stubs.release).toHaveBeenCalledWith("j");
        expect(stubs.alertError).toHaveBeenCalledTimes(1);
        expect(stubs.alertError.mock.calls[0][0]).toBe("job lost");

        stubs.read.mockResolvedValueOnce({ ...status, epoch: "other" });
        const other = commands.followJobToEnd("j2", ref);
        await flush();
        follows()[1].end(null);
        expect(await other).toBe("lost");
        expect(stubs.release).toHaveBeenCalledWith("j2");

        const aborted = commands.followJobToEnd("j3", ref);
        await flush();
        endWith(follows()[2], { type: "error", epoch: EPOCH, message: "stopped", status: 499, reason: "aborted" });
        await aborted;
        expect(stubs.alertError).toHaveBeenCalledTimes(2);
        expect(stubs.alertJobError).not.toHaveBeenCalled();
    });

    it("gives up after the bounded number of attaches and releases the job", async () => {
        stubs.read.mockResolvedValue(status);
        const end = commands.followJobToEnd("j", ref);
        for (let attach = 0; attach < 5; attach++) {
            await flush();
            await flush();
            follows()[attach].end(null);
        }
        expect(await end).toBe("lost");
        expect(follows()).toHaveLength(5);
        expect(stubs.release).toHaveBeenCalledWith("j");
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
    it("discovers a saved job's chat from its status, retrying a failed read inside the shared lifecycle, and releases it as lost when the reads keep failing", async () => {
        stubs.saved.mockReturnValue(["j"]);
        stubs.read.mockRejectedValue(new Error("offline"));
        await commands.resumeServerJobs();
        expect(stubs.read).toHaveBeenCalledTimes(5);
        expect(follows()).toHaveLength(0);
        expect(stubs.release).toHaveBeenCalledWith("j");
        expect(stubs.alertError).toHaveBeenCalledTimes(1);
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
        stubs.create.mockResolvedValue("j");
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
        await run;
        expect(stubs.alertError).not.toHaveBeenCalled();
    });

    it("reads a chat this tab knows is behind the server after the flush and before the create, saving and reading once more when the first read did not bring it current, and goes on after two attempts; a failed read runs nothing", async () => {
        const order = (fn: { mock: { invocationCallOrder: number[] } }, index = 0) =>
            fn.mock.invocationCallOrder[index];
        stubs.create.mockResolvedValue("j");
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
        stubs.flush.mockResolvedValueOnce({ discarded: ["x"] });
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
        stubs.create.mockResolvedValue("j");
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
        stubs.create.mockResolvedValue("j");
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
        stubs.flush.mockResolvedValueOnce({ discarded: ["x"] });
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

    it("posts the kind with the caller's context fields and no command, and reports `started` with the terminal", async () => {
        stubs.create.mockResolvedValue("j");
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
        expect(await run).toEqual({ outcome: "started", terminal: done });
        expect(stubs.abort).not.toHaveBeenCalled();
    });

    it("takes a plugin call's captured ids as the identity instead of the binding, once the chat's binding is complete", async () => {
        stubs.create.mockResolvedValue("j");
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
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        expect(
            await send(
                { input: "hi" },
                { identity: { presetId: "preset", modelPresetId: "preset", personaId: "selected" } },
            ),
        ).toEqual({ outcome: "refused", terminal: null });
        expect(await commands.runServerButton(char, "go", ref)).toBeUndefined();
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
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        expect(stubs.alertError).toHaveBeenLastCalledWith("cannot send");
        expect(stubs.create).not.toHaveBeenCalled();
    });

    it("shows the server's 409 binding refusals: a mismatch reads the chat again and asks to send again, an incomplete binding lists its problems", async () => {
        stubs.create.mockRejectedValueOnce(new BindingRefusedError("chatBindingMismatch"));
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        expect(stubs.loadChat).toHaveBeenCalledTimes(1);
        expect(stubs.loadChat).toHaveBeenCalledWith(ref);
        expect(stubs.alertError).toHaveBeenLastCalledWith("binding changed");
        stubs.create.mockRejectedValueOnce(
            new BindingRefusedError("chatBindingIncomplete", [{ field: "promptPresetId", reason: "gone" }]),
        );
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        expect(stubs.loadChat).toHaveBeenCalledTimes(1);
        expect(stubs.alertError).toHaveBeenLastCalledWith("cannot send\nPrompt preset: deleted");
        expect(follows()).toHaveLength(0);
        expect(stubs.alertError).toHaveBeenCalledTimes(2);
        // A failed re-read is logged, not shown twice.
        stubs.loadChat.mockRejectedValueOnce(new Error("offline"));
        stubs.create.mockRejectedValueOnce(new BindingRefusedError("chatBindingMismatch"));
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        await flush();
        expect(stubs.alertError).toHaveBeenCalledTimes(3);
    });

    it("reports `unknown` for a create request without an answer and `refused` for an answered refusal, alerting once each", async () => {
        stubs.create.mockRejectedValueOnce(new TypeError("fetch failed"));
        expect(await send({ input: "hi" })).toEqual({ outcome: "unknown", terminal: null });
        stubs.create.mockRejectedValueOnce(new RequestError(0, "The network is unreachable"));
        expect(await send({ input: "hi" })).toEqual({ outcome: "unknown", terminal: null });
        stubs.create.mockRejectedValueOnce(new RequestError(400, "context.userMessageId must be an id"));
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        stubs.create.mockRejectedValueOnce(new RequestError(409, "stale"));
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        expect(follows()).toHaveLength(0);
        expect(stubs.alertError.mock.calls.map((call) => String(call[0]))).toEqual([
            "fetch failed",
            "The network is unreachable",
            "context.userMessageId must be an id",
            "stale",
        ]);
    });

    it("aborts the job it started when the signal fires, and one aborted during the create as soon as it exists", async () => {
        stubs.create.mockResolvedValue("j");
        const controller = new AbortController();
        const run = send({ input: "hi" }, { signal: controller.signal });
        await flush();
        expect(follows()[0]?.jobId).toBe("j");
        controller.abort();
        await flush();
        expect(stubs.abort).toHaveBeenCalledWith("j");
        endWith(follows()[0], { type: "error", epoch: EPOCH, message: "stopped", status: 499, reason: "aborted" });
        expect((await run).outcome).toBe("started");

        let answer!: (jobId: string) => void;
        stubs.create.mockReturnValueOnce(new Promise<string>((resolve) => (answer = resolve)));
        const during = new AbortController();
        const late = send({ input: "hi" }, { signal: during.signal });
        await flush();
        during.abort();
        answer("j2");
        await flush();
        expect(stubs.abort).toHaveBeenLastCalledWith("j2");
        endWith(follows()[1], { type: "error", epoch: EPOCH, message: "stopped", status: 499, reason: "aborted" });
        expect((await late).outcome).toBe("started");
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
        expect(await run).toEqual({ outcome: "followed", terminal: done });
        expect(onStart).not.toHaveBeenCalled();
    });

    it("posts nothing for a signal already aborted when the flush ends", async () => {
        const controller = new AbortController();
        stubs.flush.mockImplementationOnce(async () => {
            controller.abort();
            return { discarded: [] };
        });
        expect(await send({ input: "hi" }, { signal: controller.signal })).toEqual({
            outcome: "refused",
            terminal: null,
        });
        expect(stubs.create).not.toHaveBeenCalled();
        expect(stubs.abort).not.toHaveBeenCalled();
    });

    // A flush refused because a change waits for a generation (another tab's job) is reported as
    // `chatGenerating`, not as a save error, and only once with the adapter's.
    it("shows chatGenerating for a flush refused for a generation unless the adapter's recovery showed it during the flush, and posts nothing", async () => {
        // Refused at once (no recovery during this flush): the send shows the notice itself.
        stubs.flush.mockRejectedValueOnce(new BlockedError());
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        expect(stubs.alertError.mock.calls).toEqual([["generating"]]);
        // The flush's conflict recovery showed it (the count moved during the flush): no second alert.
        let count = 0;
        stubs.notices.mockImplementation(() => count);
        stubs.flush.mockImplementationOnce(async () => {
            count += 1;
            throw new BlockedError();
        });
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        expect(stubs.alertError).toHaveBeenCalledTimes(1);
        // Another explicit send in the same episode (the adapter does not show it again): feedback again.
        stubs.flush.mockRejectedValueOnce(new BlockedError());
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        expect(stubs.alertError.mock.calls).toEqual([["generating"], ["generating"]]);
        expect(stubs.create).not.toHaveBeenCalled();
        expect(follows()).toHaveLength(0);
    });

    it("keeps a plain Error with the generation text, and any other flush error, on the save-error path", async () => {
        stubs.flush.mockRejectedValueOnce(
            new Error("A character is still being generated; try again when it finishes"),
        );
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        stubs.flush.mockRejectedValueOnce(new Error("offline"));
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        expect(stubs.alertError.mock.calls.map((call) => String(call[0]))).toEqual([
            "save failed: A character is still being generated; try again when it finishes",
            "save failed: offline",
        ]);
        expect(stubs.create).not.toHaveBeenCalled();
    });

    it("shows a send's refusals as `language.serverJob` entries, the error's text in their `{0}` taken literally", async () => {
        stubs.flush.mockResolvedValueOnce({ discarded: ["x"] });
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        stubs.flush.mockRejectedValueOnce(new Error("quota $& {0} $1"));
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        stubs.refresh.mockRejectedValueOnce(new Error("offline $'"));
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        stubs.held.mockReturnValueOnce(null);
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
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
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        expect(stubs.alertError.mock.calls).toEqual([["generating"]]);
        count = 4;
        stubs.flush.mockRejectedValueOnce(new BlockedError());
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        expect(stubs.alertError.mock.calls).toEqual([["generating"], ["generating"]]);
    });

    it("still reports another tab's busy job at the create as chatGenerating after a successful flush", async () => {
        stubs.create.mockRejectedValueOnce(new BusyError("theirs"));
        stubs.read.mockResolvedValueOnce(null);
        expect(await send({ input: "hi" })).toEqual({ outcome: "refused", terminal: null });
        expect(stubs.alertError.mock.calls).toEqual([["generating"]]);
        expect(follows()).toHaveLength(0);
    });
});

const followUpStubs = vi.hoisted(() => ({
    runMultisend: vi.fn<(ref: unknown, clear: boolean, parts: readonly string[]) => Promise<boolean>>(),
}));
vi.mock("./command", () => ({ runMultisend: followUpStubs.runMultisend }));

describe("`/multisend` follow-ups of a command job", () => {
    /** Lets the follow-up chain (a dynamic import, one await per part) run out. */
    const settle = async () => {
        for (let round = 0; round < 8; round += 1) {
            await flush();
        }
    };
    const withParts = (...followUps: { clear: boolean; parts: string[] }[]): GenerationTerminalEvent => ({
        ...done,
        followUps,
    });

    beforeEach(() => {
        followUpStubs.runMultisend.mockReset().mockResolvedValue(true);
    });

    it("sends a done terminal's follow-ups through the tab's `/multisend` in order on the job's chat, stopping at the first that does not send, and hands the terminal to the caller unchanged", async () => {
        const terminal = withParts(
            { clear: false, parts: ["one", "two"] },
            { clear: true, parts: ["three"] },
            { clear: false, parts: ["never"] },
        );
        followUpStubs.runMultisend.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const end = commands.followJobToEnd("j", ref);
        await flush();
        endWith(follows()[0], terminal);
        expect(await end).toEqual(terminal);
        await settle();
        expect(followUpStubs.runMultisend.mock.calls).toEqual([
            [ref, false, ["one", "two"]],
            [ref, true, ["three"]],
        ]);
        expect(stubs.alertError).not.toHaveBeenCalled();
    });

    it("starts a job's follow-ups once per tab: the same terminal seen again (a later follow of the job) does not send them again, another job's do; none for a done without follow-ups", async () => {
        const terminal = withParts({ clear: false, parts: ["a"] });
        const first = commands.followJobToEnd("j", ref);
        await flush();
        endWith(follows()[0], terminal);
        await first;
        await settle();
        // The job is followed again (its terminal is retained on the server): nothing is resent.
        const again = commands.followJobToEnd("j", ref);
        await flush();
        endWith(follows()[1], terminal);
        expect(await again).toEqual(terminal);
        await settle();
        expect(followUpStubs.runMultisend).toHaveBeenCalledTimes(1);
        // Two callers of one follow share the one start.
        const shared = commands.followJobToEnd("j2", ref);
        const sharing = commands.followJobToEnd("j2", ref);
        await flush();
        endWith(follows()[2], withParts({ clear: true, parts: ["b"] }));
        await Promise.all([shared, sharing]);
        await settle();
        expect(followUpStubs.runMultisend).toHaveBeenCalledTimes(2);
        expect(followUpStubs.runMultisend).toHaveBeenLastCalledWith(ref, true, ["b"]);
        const plain = commands.followJobToEnd("j3", ref);
        await flush();
        endWith(follows()[3], done);
        await plain;
        const errored = commands.followJobToEnd("j4", ref);
        await flush();
        endWith(follows()[4], failed);
        await errored;
        await settle();
        expect(followUpStubs.runMultisend).toHaveBeenCalledTimes(2);
    });

    it("runs the follow-ups of a job discovered at boot on the chat its status names, and logs a send that throws", async () => {
        stubs.read.mockResolvedValue(status);
        followUpStubs.runMultisend.mockRejectedValueOnce(new Error("send broke"));
        const end = commands.followJobToEnd("j");
        await flush();
        await flush();
        endWith(follows()[0], withParts({ clear: false, parts: ["x"] }, { clear: false, parts: ["y"] }));
        expect(await end).toMatchObject({ type: "done" });
        await settle();
        expect(followUpStubs.runMultisend).toHaveBeenCalledTimes(1);
        expect(followUpStubs.runMultisend).toHaveBeenCalledWith({ chaId: "c", chatId: "k" }, false, ["x"]);
        expect(console.error).toHaveBeenCalledWith("[Generation]", expect.any(Error));
        expect(stubs.release).not.toHaveBeenCalled();
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
        stubs.create.mockResolvedValue("j");
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
        expect(await commands.followJobToEnd("j2", ref)).toBe("lost");
        expect(stubs.load).toHaveBeenCalledTimes(5);
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

    it("a job discovered at boot pins its chat once the status names it; the follow-ups take their own pin, released after they ran", async () => {
        stubs.read.mockResolvedValue(status);
        followUpStubs.runMultisend.mockReset().mockResolvedValue(true);
        const end = commands.followJobToEnd("j");
        await settle();
        expect(stubs.pin).toHaveBeenCalledTimes(1);
        expect(stubs.pin).toHaveBeenCalledWith({ chaId: "c", chatId: "k" });
        expect(order(stubs.read)).toBeLessThan(order(stubs.pin));
        expect(stubs.load).toHaveBeenCalledWith({ chaId: "c", chatId: "k" });
        endWith(follows()[0], { ...done, followUps: [{ clear: false, parts: ["x"] }] });
        await end;
        await settle();
        expect(followUpStubs.runMultisend).toHaveBeenCalledTimes(1);
        // The follow's pin and the follow-ups' pin, both released.
        expect(stubs.pin).toHaveBeenCalledTimes(2);
        expect(pinsBalanced()).toBe(true);
    });
});

describe("the follow's diagnostics", () => {
    const links = () => stubs.record.mock.calls.map(([input]) => input);

    it("records `reattach` with its attempt before every attach after the first, and `lost` once when the attaches run out", async () => {
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
        ]);
    });

    it("records `lost` once for a job the server does not know and for a chat that cannot be loaded, and nothing for a job that ends", async () => {
        stubs.read.mockResolvedValue(null);
        expect(await commands.followJobToEnd("gone")).toBe("lost");
        expect(links()).toEqual([{ kind: "jobLink", phase: "lost", jobId: "gone" }]);
        stubs.record.mockClear();
        stubs.load.mockResolvedValue(undefined);
        expect(await commands.followJobToEnd("unloaded", ref)).toBe("lost");
        expect(links()).toEqual([{ kind: "jobLink", phase: "lost", jobId: "unloaded" }]);
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

    it("lists a followed job under its chat from the follow's start until its end, for done and for an error", async () => {
        const end = commands.followJobToEnd("j", ref);
        await flush();
        expect(jobsOf(ref)).toEqual(["j"]);
        expect(jobsOf({ chaId: "c", chatId: "other" })).toEqual([]);
        endWith(follows()[0], done);
        expect(await end).toEqual(done);
        expect(jobsOf(ref)).toEqual([]);

        const failing = commands.followJobToEnd("j2", ref);
        await flush();
        expect(jobsOf(ref)).toEqual(["j2"]);
        endWith(follows()[1], failed);
        await failing;
        expect(jobsOf(ref)).toEqual([]);
    });

    it("lists a job resumed at boot under the chat its status names, and drops it when the job is lost", async () => {
        stubs.saved.mockReturnValue(["j"]);
        stubs.read.mockResolvedValue(status);
        const boot = commands.resumeServerJobs();
        await flush();
        await flush();
        expect(jobsOf({ chaId: status.characterId, chatId: status.chatId })).toEqual(["j"]);
        // The socket closes without a terminal and the server no longer knows the job: lost.
        stubs.read.mockResolvedValue(null);
        follows()[0].end(null);
        await boot;
        expect(jobsOf({ chaId: status.characterId, chatId: status.chatId })).toEqual([]);
    });

    it("keeps a newer job of the same chat listed when the older follow ends after it started", async () => {
        const older = commands.followJobToEnd("old", ref);
        await flush();
        const newer = commands.followJobToEnd("new", ref);
        await flush();
        expect(jobsOf(ref).sort()).toEqual(["new", "old"]);
        endWith(follows()[0], done);
        await older;
        expect(jobsOf(ref)).toEqual(["new"]);
        endWith(follows()[1], done);
        await newer;
        expect(jobsOf(ref)).toEqual([]);
    });

    it("drops a job whose chat cannot be loaded once the follow ends as lost, and never lists a job the server does not know", async () => {
        stubs.load.mockReset().mockRejectedValue(new Error("offline"));
        expect(await commands.followJobToEnd("j", ref)).toBe("lost");
        expect(jobsOf(ref)).toEqual([]);

        stubs.saved.mockReturnValue(["gone"]);
        stubs.read.mockResolvedValue(null);
        await commands.resumeServerJobs();
        expect(get(commands.followedJobs).size).toBe(0);
    });
});
