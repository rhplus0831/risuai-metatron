// Shared helpers for the tests that install a staged snapshot (not a test file itself).
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import type { ResourceKindRegistry } from "../data/kinds.ts";
import type { ResourceStore } from "../data/resourceStore.ts";
import { type StagedFileReport, stageValidatedSnapshot } from "../data/restore/stageValidatedSnapshot.ts";

export type StagedSnapshot = { file: string; report: StagedFileReport };

let stagedFiles = 0;

/**
 * Stages the snapshot file `source` in process, into a new file beside it (so the folder the test owns
 * removes it). `store.replaceAll(staged.file, staged.report)` installs it, once: stage again to install
 * twice. A test that restores from a listener stages before registering it.
 */
export async function stageSnapshot(source: string, kinds: ResourceKindRegistry): Promise<StagedSnapshot> {
    stagedFiles += 1;
    const file = `${source}.staged-${stagedFiles}`;
    return { file, report: await stageValidatedSnapshot(source, file, kinds) };
}

/** Stages `source` and installs it; returns the new epoch. */
export async function installSnapshot(
    store: ResourceStore,
    source: string,
    kinds: ResourceKindRegistry,
): Promise<string> {
    const { file, report } = await stageSnapshot(source, kinds);
    return store.replaceAll(file, report);
}

/** The last copy of `copyStagedCheckpoints`: by then the install has written every other copied table. */
const LATE_INSTALL_COPY = "INSERT INTO main.chatCheckpointPolicy";

/** What `withFailingInstallCopy` throws. */
export const INJECTED_COPY_FAILURE = "The install's late copy failed";

/**
 * Runs `install` with the install's late checkpoint copy failing: the real statements run inside the
 * install's transaction, then `exec` throws, so the rollback has the whole copy to undo. A constrained
 * staged store cannot hold a row that fails on its own. A test that expects the throw goes red if the
 * copy's SQL text changes and the failure stops firing.
 */
export function withFailingInstallCopy<T>(install: () => T): T {
    const exec = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
        exec.call(this, sql);
        if (sql.includes(LATE_INSTALL_COPY)) {
            throw new Error(INJECTED_COPY_FAILURE);
        }
    });
    try {
        return install();
    } finally {
        spy.mockRestore();
    }
}
