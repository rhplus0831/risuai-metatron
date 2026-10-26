import { vi } from "vitest";

type CollectorModule = typeof import("../collector");

/**
 * Every export of `src/ts/diagnostics/collector.ts` as a mock, for `vi.mock`. The callable exports
 * are `vi.fn()`s that record nothing and return empty lists or null. The defaults `satisfies` the
 * module's type, so a new or reshaped export fails `pnpm check` here.
 *
 * Load it inside the hoisted factory, and pass a file's own handles as `overrides`:
 *
 * ```ts
 * vi.mock("../diagnostics/collector", async () =>
 *     (await import("../diagnostics/tests/collectorMock")).createCollectorMock({ recordClientEvent: mocks.record }),
 * );
 * ```
 */
export function createCollectorMock(overrides: Partial<CollectorModule> = {}): CollectorModule {
    const defaults = {
        projectClientEvent: vi.fn<CollectorModule["projectClientEvent"]>(() => null),
        recordClientEvent: vi.fn<CollectorModule["recordClientEvent"]>(),
        clientDiagnosticEvents: vi.fn<CollectorModule["clientDiagnosticEvents"]>(() => []),
        flushClientDiagnostics: vi.fn<CollectorModule["flushClientDiagnostics"]>(),
        clientAppPath: vi.fn<CollectorModule["clientAppPath"]>(() => null),
        browserStack: vi.fn<CollectorModule["browserStack"]>(() => []),
        startDiagnosticsCollector: vi.fn<CollectorModule["startDiagnosticsCollector"]>(),
    } satisfies CollectorModule;
    return { ...defaults, ...overrides };
}
