/** Rewrites the credential-free export and selects partial assets in a worker so SQLite and parsing cannot block requests. */
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { selectPartialBackupAssets } from "../../../../shared/backups.ts";
import { RESOURCE_KIND } from "../../../../shared/resources.ts";
import type { ExportScrubInput, ExportScrubResult } from "./runner.ts";

export type ExportScrubWorkerMessage = { type: "done"; result: ExportScrubResult } | { type: "error"; message: string };

const { source, output, partial } = workerData as ExportScrubInput;
const post = (message: ExportScrubWorkerMessage) => parentPort!.postMessage(message);

try {
    const staged = new DatabaseSync(source);
    try {
        staged.prepare("DELETE FROM resources WHERE kind = ?").run(RESOURCE_KIND.llmSecrets);
        staged.prepare("VACUUM INTO ?").run(output);
    } finally {
        staged.close();
    }
    const archived = new DatabaseSync(output);
    let selectedKeys: string[] = [];
    try {
        // Like backupTo's copy, the archive is one self-contained rollback-journal database.
        archived.exec("PRAGMA journal_mode = DELETE");
        if (partial) {
            // Select from the exact copy being archived, without reading or normalizing chats.
            const rows = archived
                .prepare("SELECT kind, id, data FROM resources WHERE kind IN (?, ?, ?, ?, ?)")
                .all(
                    RESOURCE_KIND.characters,
                    RESOURCE_KIND.personas,
                    RESOURCE_KIND.ui,
                    RESOURCE_KIND.characterOrder,
                    RESOURCE_KIND.presets,
                );
            selectedKeys = selectPartialBackupAssets(
                rows.map((row) => ({ kind: row.kind as string, data: JSON.parse(row.data as string) })),
            ).map((asset) => asset.key);
        }
    } finally {
        archived.close();
    }
    post({ type: "done", result: { selectedKeys } });
} catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
}
