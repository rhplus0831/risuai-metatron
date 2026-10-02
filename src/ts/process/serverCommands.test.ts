import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationEvent, GenerationTerminalEvent } from "../../../shared/jobs.ts";

// Phase 5 slice 8a, the tab's side of a server Lua button (`serverCommands.ts`) over a stubbed
// transport: one lifecycle per job shared by every caller (a button, a busy job of this tab, the
// boot resume), the bounded reattach after a socket closed without the terminal (a failed status
// read retried, a job the server no longer knows released as lost), the end reported once, the
// boot discovery joining an active follow and never releasing it, and `runServerButton`'s
// preflight (ids before the flush, a discarding or rejected flush runs nothing, a saved revision,
// the owned-busy path).

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
    read: vi.fn<(jobId: string) => Promise<unknown>>(),
    release: vi.fn(),
    saved: vi.fn<() => string[]>(() => []),
    apply: vi.fn(),
    alertError: vi.fn(),
    flush: vi.fn<() => Promise<{ discarded: string[] }>>(),
    findChat: vi.fn(() => ({})),
    held: vi.fn<() => string | null>(() => "e:1:1"),
    bound: vi.fn<() => { id: string } | null>(() => null),
}));

class BusyError extends Error {
    constructor(readonly jobId: string) {
        super("busy");
    }
}

vi.mock("src/lang", () => ({ language: { chatGenerating: "generating" } }));
vi.mock("../alert", () => ({ alertError: stubs.alertError }));
vi.mock("../network/generationJobs", () => ({
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
    GenerationBusyError: BusyError,
    readGenerationJob: stubs.read,
    releaseGenerationJob: stubs.release,
    savedGenerationJobIds: stubs.saved,
}));
vi.mock("../storage/chatStore.svelte", () => ({ findChat: stubs.findChat, heldChatRevision: stubs.held }));
vi.mock("../storage/resourceClient", () => ({ getResourceEpoch: () => EPOCH }));
vi.mock("../storage/database.svelte", () => ({ getDatabase: () => ({}) }));
vi.mock("../storage/forwarding.svelte", () => ({
    selectedPersona: () => ({ id: "selected" }),
    selectedPreset: () => ({ id: "preset" }),
}));
vi.mock("../storage/resourceSync.svelte", () => ({ flushResources: stubs.flush }));
vi.mock("../util", () => ({ checkPersonaBinded: stubs.bound, sleep: async () => {} }));

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
    stubs.bound.mockReset().mockReturnValue(null);
    stubs.flush.mockReset().mockResolvedValue({ discarded: [] });
    vi.spyOn(console, "error").mockImplementation(() => {});
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
        expect(stubs.alertError).toHaveBeenCalledTimes(1);
        expect(stubs.alertError).toHaveBeenCalledWith("boom");
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
        expect(stubs.alertError.mock.calls[0][0]).toMatch(/lost/);

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

    it("takes the target and settings ids before the flush, saves first, and runs a command job it then follows", async () => {
        stubs.bound.mockReturnValue({ id: "bound" });
        stubs.create.mockResolvedValue("j");
        const run = commands.runServerButton(char, "go", ref);
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
            personaId: "bound",
            selectedPersonaId: "selected",
            mode: "button",
            chatRevision: "e:1:1",
        });
        expect(body.context.client).toMatchObject({ viewport: { width: expect.any(Number) } });
        expect(stubs.flush).toHaveBeenCalledTimes(1);
        expect(follows()[0]?.jobId).toBe("j");
        endWith(follows()[0], done);
        await run;
        expect(stubs.alertError).not.toHaveBeenCalled();
    });

    it("runs nothing for a group, a discarding or rejected flush, a chat gone meanwhile, or an unsaved chat", async () => {
        await commands.runServerButton({ chaId: "g", type: "group" } as never, "go", ref);
        stubs.flush.mockResolvedValueOnce({ discarded: ["x"] });
        await commands.runServerButton(char, "go", ref);
        stubs.flush.mockRejectedValueOnce(new Error("offline"));
        await commands.runServerButton(char, "go", ref);
        stubs.findChat.mockReturnValueOnce(undefined as never);
        await commands.runServerButton(char, "go", ref);
        stubs.held.mockReturnValueOnce(null);
        await commands.runServerButton(char, "go", ref);
        expect(stubs.create).not.toHaveBeenCalled();
        expect(stubs.alertError.mock.calls.map((call) => String(call[0]))).toEqual([
            expect.stringMatching(/discarded/),
            expect.stringMatching(/offline/),
            expect.stringMatching(/not saved/),
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

// Phase 5 slice 8b: a manual trigger through the same preflight and follow, with its typed outcome
// and `onStart` (the tab sets `CurrentTriggerIdStore` there: only once the job exists).
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
        expect(stubs.alertError).toHaveBeenCalledWith("boom");
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
        stubs.findChat.mockReturnValueOnce(undefined as never);
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
            "A conflict discarded local changes; the trigger did not run",
            expect.stringMatching(/offline/),
            expect.stringMatching(/not saved/),
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
