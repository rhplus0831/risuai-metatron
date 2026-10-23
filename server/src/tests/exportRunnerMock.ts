type ExportRunnerModule = typeof import("../data/upstream/exportRunner.ts");

/** Keep both route and real-worker mocks complete when the worker boundary gains an export. */
export function createExportRunnerMock(
    original: ExportRunnerModule,
    overrides: Partial<ExportRunnerModule> = {},
): ExportRunnerModule {
    const defaults = {
        DEFAULT_UPSTREAM_EXPORT_HEAP_MB: original.DEFAULT_UPSTREAM_EXPORT_HEAP_MB,
        upstreamExportHeapMb: original.upstreamExportHeapMb,
        runUpstreamExportWorker: original.runUpstreamExportWorker,
    } satisfies ExportRunnerModule;
    return { ...defaults, ...overrides };
}
