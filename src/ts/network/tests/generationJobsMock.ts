import { vi } from "vitest";
import type { ChatBindingProblem } from "../../../../shared/chatBinding.ts";
import type { GenerationTerminalEvent } from "../../../../shared/jobs.ts";
import type { OrphanedOverrideEntry } from "../../../../shared/lore/overrides.ts";

type GenerationJobsModule = typeof import("../generationJobs");

/** The 409 `chatBusy` refusal, as the transport throws it (`jobId`: the job the owner can attach to). */
export class GenerationBusyError extends Error {
    readonly jobId: string;
    constructor(jobId: string) {
        super("This chat is generating a reply");
        this.name = "GenerationBusyError";
        this.jobId = jobId;
    }
}

export class GenerationStaleError extends Error {
    constructor() {
        super("The chat changed on the server; reload it and send again");
        this.name = "GenerationStaleError";
    }
}

export class ChatBindingRefusedError extends Error {
    readonly code: "chatBindingIncomplete" | "chatBindingMismatch";
    readonly problems: readonly ChatBindingProblem[];
    constructor(code: ChatBindingRefusedError["code"], problems: readonly ChatBindingProblem[] = []) {
        super(code);
        this.name = "ChatBindingRefusedError";
        this.code = code;
        this.problems = problems;
    }
}

export class ChatLoreOverrideOrphanedError extends Error {
    readonly entries: readonly OrphanedOverrideEntry[];
    constructor(entries: readonly OrphanedOverrideEntry[]) {
        super("chatLoreOverrideOrphaned");
        this.name = "ChatLoreOverrideOrphanedError";
        this.entries = entries;
    }
}

export class GenerationCreateError extends Error {
    readonly uncertain: boolean;
    override readonly cause: unknown;
    constructor(cause: unknown, uncertain: boolean) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = "GenerationCreateError";
        this.cause = cause;
        this.uncertain = uncertain;
    }
}

/**
 * A `GenerationFollow` a test settles: `open()` resolves `opened` true (the socket opened), `end`
 * closes it with the terminal given (null: closed before the job's end), `resume()` closes it as the
 * transport does when it gives an opened socket up on the page's return (`resumed`), and `close()`
 * is the caller's close (closed without a terminal), as the real follow settles them. It never times
 * out or watches the page on its own: the test drives every settlement.
 */
export function createFollowStub(jobId: string) {
    type Closed = { terminal: GenerationTerminalEvent | null; resumed?: boolean; received?: boolean };
    let settleClosed!: (value: Closed) => void;
    let settleOpened!: (value: boolean) => void;
    const closed = new Promise<Closed>((resolve) => {
        settleClosed = resolve;
    });
    const opened = new Promise<boolean>((resolve) => {
        settleOpened = resolve;
    });
    let received = false;
    const end = (terminal: GenerationTerminalEvent | null) => {
        settleOpened(false);
        settleClosed({ terminal, ...(received ? { received } : {}) });
    };
    return {
        jobId,
        open: () => settleOpened(true),
        /** A frame arrived through the socket (the server was reached): its close reports `received`. */
        frame: () => {
            received = true;
        },
        end,
        resume: () => {
            settleOpened(false);
            settleClosed({ terminal: null, resumed: true, ...(received ? { received } : {}) });
        },
        follow: {
            role: null,
            viewing: () => false,
            send: () => true,
            close: () => end(null),
            closed,
            opened,
        } satisfies ReturnType<GenerationJobsModule["followGenerationJob"]>,
    };
}

/**
 * Every export of `src/ts/network/generationJobs.ts` as a mock, for `vi.mock`. The callable exports
 * are `vi.fn()`s that answer as a server with no jobs would (no saved jobs, an unknown status, a
 * follow that stays open until the test closes it); the error classes have the real ones' shape, so
 * a test throws them from the stubs and the product code's `instanceof` checks see them. The
 * defaults `satisfies` the module's type, so a new or reshaped export fails `pnpm check` here instead
 * of a test that reaches it under load.
 *
 * Load it inside the hoisted factory, and pass a file's own handles as `overrides`:
 *
 * ```ts
 * vi.mock("../network/generationJobs", async () =>
 *     (await import("src/ts/network/tests/generationJobsMock")).createGenerationJobsMock({
 *         readGenerationJob: stubs.read,
 *     }),
 * );
 * ```
 */
export function createGenerationJobsMock(overrides: Partial<GenerationJobsModule> = {}): GenerationJobsModule {
    const defaults = {
        generationPluginWorkActive: vi.fn<GenerationJobsModule["generationPluginWorkActive"]>(() => false),
        holdGenerationPluginWork: vi.fn<GenerationJobsModule["holdGenerationPluginWork"]>(() => () => {}),
        onGenerationPluginWork: vi.fn<GenerationJobsModule["onGenerationPluginWork"]>(() => () => {}),
        channelCallbacksRunning: vi.fn<GenerationJobsModule["channelCallbacksRunning"]>(() => false),
        noteChannelCallbacks: vi.fn<GenerationJobsModule["noteChannelCallbacks"]>(),
        GenerationBusyError,
        GenerationCreateError,
        GenerationStaleError,
        ChatBindingRefusedError,
        ChatLoreOverrideOrphanedError,
        generationClientId: vi.fn<GenerationJobsModule["generationClientId"]>(() => "client"),
        savedGenerationJobs: vi.fn<GenerationJobsModule["savedGenerationJobs"]>(() => ({})),
        savedGenerationJobIds: vi.fn<GenerationJobsModule["savedGenerationJobIds"]>(() => []),
        rememberGenerationJob: vi.fn<GenerationJobsModule["rememberGenerationJob"]>(),
        forgetGenerationJob: vi.fn<GenerationJobsModule["forgetGenerationJob"]>(),
        createGenerationJob: vi.fn<GenerationJobsModule["createGenerationJob"]>(async () => ({
            outcome: "created",
            jobId: "job",
        })),
        cancelGenerationRequest: vi.fn<GenerationJobsModule["cancelGenerationRequest"]>(async () => ({
            outcome: "cancelled",
        })),
        readGenerationJob: vi.fn<GenerationJobsModule["readGenerationJob"]>(async () => null),
        readChatGeneration: vi.fn<GenerationJobsModule["readChatGeneration"]>(async () => null),
        takeoverGenerationJob: vi.fn<GenerationJobsModule["takeoverGenerationJob"]>(async () => null),
        stopChatGeneration: vi.fn<GenerationJobsModule["stopChatGeneration"]>(async () => "idle"),
        abortGenerationJob: vi.fn<GenerationJobsModule["abortGenerationJob"]>(async () => {}),
        reportCallbackDrained: vi.fn<GenerationJobsModule["reportCallbackDrained"]>(async () => {}),
        followGenerationJob: vi.fn<GenerationJobsModule["followGenerationJob"]>(
            (jobId) => createFollowStub(jobId).follow,
        ),
        applyGenerationEvent: vi.fn<GenerationJobsModule["applyGenerationEvent"]>(),
        releaseGenerationJob: vi.fn<GenerationJobsModule["releaseGenerationJob"]>(),
    } satisfies GenerationJobsModule;
    return { ...defaults, ...overrides };
}
