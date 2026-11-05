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
            stoppedElsewhere: "stopped elsewhere",
            stopOther: {
                idle: "idle",
                confirm: "Stop {kind} ({stage}){sequence}?",
                kinds: { send: "send" },
                stages: { generating: "generating" },
                running: "running",
                lookupTimedOut: "Current job lookup timed out",
                stopTimedOut: "Stop request timed out",
            },
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

describe("review probe: boot status receipt", () => {
    it("retains a shutdown receipt discovered at boot if connectivity fails afterwards", async () => {
        const shutdown: GenerationTerminalEvent = {
            type: "error",
            epoch: EPOCH,
            status: 503,
            reason: "shutdown",
            message: "The server stopped while this job ran",
            sequence: { total: 3, sent: 1 },
        };
        stubs.saved.mockReturnValue(["j"]);
        stubs.read.mockResolvedValueOnce(kept(shutdown)).mockRejectedValue(new Error("offline after discovery"));
        stubs.attached = () => queueMicrotask(() => follows().at(-1)!.end(null));
        await commands.resumeServerJobs();
        console.log(
            "PROBE",
            JSON.stringify({
                statusReads: stubs.read.mock.calls.length,
                attaches: follows().length,
                errors: stubs.alertError.mock.calls,
                jobErrors: stubs.alertJobError.mock.calls,
                released: stubs.release.mock.calls,
            }),
        );
        expect(stubs.alertError).not.toHaveBeenCalledWith("job lost");
        expect(stubs.alertJobError).toHaveBeenCalledWith("j", shutdown);
    });
});
