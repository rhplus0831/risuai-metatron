import { language } from "src/lang";
import type { MemoryTaskStatus } from "../../../../shared/jobs.ts";

function reasonText(reason: string | undefined): string {
    return reason === undefined ? "" : (language.memoryTasks.reasons[reason] ?? reason);
}

/** The status line of a chat's memory task: running or queued, else its last notable end. */
export function memoryTaskStatusLine(status: MemoryTaskStatus | null): string | null {
    if (!status) {
        return null;
    }
    switch (status.state) {
        case "queued":
            return language.memoryTasks.queued;
        case "running":
            return language.memoryTasks.running(status.done, status.total);
        case "done":
            return status.reason || status.error
                ? language.memoryTasks.done(status.error ?? reasonText(status.reason))
                : null;
        case "failed":
            return language.memoryTasks.failed(status.error ?? reasonText(status.reason));
        case "skipped":
            return language.memoryTasks.skipped(reasonText(status.reason));
        case "cancelled":
            return status.reason && status.reason !== "cancelled"
                ? language.memoryTasks.cancelled(reasonText(status.reason))
                : null;
    }
}
