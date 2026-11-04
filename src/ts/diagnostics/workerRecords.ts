import { type DiagnosticEvent, projectBrowserEvent } from "../../../shared/diagnostics.ts";

/**
 * The service worker's push records (`public/sw.js` writes them, under the same names): the last 100
 * `push` events of the worker, kept in IndexedDB so they outlive the page (an Android kill of the app's
 * process included). The diagnostic report reads them (`report.ts`).
 */
const DB_NAME = "risu-sw-diagnostics";
const STORE = "records";
const READ_WAIT_MS = 1000;

/** Checked worker push events and whether the bounded read failed; absent IndexedDB is an empty success. */
export type WorkerRecords = {
    /** The records that pass the browser's projection, in stored order (oldest first). */
    events: DiagnosticEvent[];
    /** The records could not be read (an open or read that failed, was blocked, or took too long). */
    failed: boolean;
};

/**
 * The worker's push records, each projected (`projectBrowserEvent`: storage is not trusted). Read
 * without creating the database: one that does not exist yet (its upgrade is aborted) has none. Without
 * IndexedDB there are none either and nothing failed; past `waitMs` the read is given up as failed (a
 * connection that opens later is closed). `factory` is the IndexedDB factory (tests inject one; the
 * default is the page's). Never throws.
 */
export function readWorkerRecords(waitMs: number = READ_WAIT_MS, factory?: IDBFactory): Promise<WorkerRecords> {
    return new Promise((resolve) => {
        let db: IDBDatabase | null = null;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: WorkerRecords) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            try {
                db?.close();
            } catch {}
            resolve(result);
        };
        const none = () => finish({ events: [], failed: false });
        const failed = () => finish({ events: [], failed: true });
        let request: IDBOpenDBRequest;
        try {
            const indexedDB = factory ?? globalThis.indexedDB;
            if (!indexedDB) {
                none();
                return;
            }
            request = indexedDB.open(DB_NAME, 1);
        } catch {
            failed();
            return;
        }
        timer = setTimeout(failed, waitMs);
        request.onupgradeneeded = () => {
            // No database yet: the worker has recorded nothing. Aborting leaves none behind.
            try {
                request.transaction?.abort();
            } catch {}
            none();
        };
        request.onerror = () => failed();
        request.onblocked = () => failed();
        request.onsuccess = () => {
            if (settled) {
                try {
                    request.result.close();
                } catch {}
                return;
            }
            db = request.result;
            try {
                if (!db.objectStoreNames.contains(STORE)) {
                    none();
                    return;
                }
                const transaction = db.transaction(STORE, "readonly");
                const read = transaction.objectStore(STORE).getAll();
                transaction.oncomplete = () => {
                    try {
                        const rows: unknown[] = Array.isArray(read.result) ? read.result : [];
                        finish({
                            events: rows
                                .map((row) => projectBrowserEvent(row))
                                .filter((event): event is DiagnosticEvent => event !== null && event.kind === "push"),
                            failed: false,
                        });
                    } catch {
                        failed();
                    }
                };
                transaction.onabort = () => failed();
            } catch {
                failed();
            }
        };
    });
}
