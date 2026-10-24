import { writable } from "svelte/store";
import { vi } from "vitest";

type ServerCommandsModule = typeof import("../serverCommands");

/**
 * Every export of `src/ts/process/serverCommands.ts` as a mock, for `vi.mock`. The callable exports
 * are `vi.fn()`s that resolve as a run that did nothing would (`refused`, `lost`, no outcome);
 * `followedJobs` is a real writable Map, so a test can register a followed job and the readers of
 * the registry (`chatStatus.svelte.ts`) see it. The defaults `satisfies` the module's type, so a new
 * export fails `pnpm check` here instead of a test that reaches it under load.
 *
 * Load it inside the hoisted factory, and pass a file's own handles as `overrides`:
 *
 * ```ts
 * vi.mock("./serverCommands", async () =>
 *     (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock({
 *         runServerManualTrigger: stubs.trigger,
 *     }),
 * );
 * ```
 */
export function createServerCommandsMock(overrides: Partial<ServerCommandsModule> = {}): ServerCommandsModule {
    const defaults = {
        followedJobs: writable<ReadonlyMap<string, string>>(new Map()),
        followedJobsOf: vi.fn<ServerCommandsModule["followedJobsOf"]>(() => []),
        followJobToEnd: vi.fn<ServerCommandsModule["followJobToEnd"]>(async () => "lost"),
        resumeServerJobs: vi.fn<ServerCommandsModule["resumeServerJobs"]>(async () => {}),
        runServerJob: vi.fn<ServerCommandsModule["runServerJob"]>(async () => ({ outcome: "refused", terminal: null })),
        runServerButton: vi.fn<ServerCommandsModule["runServerButton"]>(async () => "refused"),
        runServerManualTrigger: vi.fn<ServerCommandsModule["runServerManualTrigger"]>(async () => "refused"),
    } satisfies ServerCommandsModule;
    return { ...defaults, ...overrides };
}
