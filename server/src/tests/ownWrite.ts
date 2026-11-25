// A job's own write for tests that stand in for `RunningJob.write` (not a test file itself).
import type { ResourceStore, WrittenChanges } from "../data/resourceStore.ts";
import type { JobWriteResult } from "../jobs/generationJobs.ts";

/**
 * `store.applyChanges` as the registry's job write applies it: with the write's own chat changes
 * (`changes: true`) returned beside the result as `written`, so the job scope can adopt them.
 */
export function applyOwnWrite(
    store: ResourceStore,
    batch: Parameters<ResourceStore["applyChanges"]>[0],
    options: { epoch?: string } = {},
): JobWriteResult {
    let written: WrittenChanges | undefined;
    const applied = store.applyChanges(batch, {
        ...options,
        changes: true,
        committed: (_applied, changes) => {
            written = changes;
            return [];
        },
    });
    return written ? { ...applied, written } : applied;
}
