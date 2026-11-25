import type { CompletionNotification } from "../../../shared/notifications.ts";
import type { PushService } from "./pushService.ts";

/**
 * Process-local Web Push holds, one notification per job. A replacement keeps the job's position
 * in the bound and replaces its notification and duration. No deadline runs until jobEnded; once
 * armed, it is never restarted, even by a replacement. Release and expiry send at most once, and
 * overflow sends the oldest hold even if its job is still running. Shutdown drops all holds.
 *
 * End state belongs only to a held entry: jobEnded with no hold remembers nothing, and release or
 * eviction forgets it. A fresh hold after an earlier end therefore waits for another jobEnded or
 * release (or overflow). The runner's abort guard prevents such late holds on ordinary paths. A
 * release before the end does not release future notifications: a later hold gets its own wait.
 */

export const MAX_COMPLETION_HOLDS = 64;

export type CompletionHolds = {
    hold(jobId: string, notification: CompletionNotification, holdMs: number): void;
    jobEnded(jobId: string): void;
    release(jobId: string): boolean;
    close(): void;
};

type HeldCompletion = {
    notification: CompletionNotification;
    holdMs: number;
    timer: ReturnType<typeof setTimeout> | null;
};

export function createCompletionHolds(options: {
    push: Pick<PushService, "send">;
    timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}): CompletionHolds {
    const { push } = options;
    const timers = options.timers ?? { setTimeout, clearTimeout };
    const held = new Map<string, HeldCompletion>();
    let closed = false;

    function release(jobId: string): boolean {
        const entry = held.get(jobId);
        if (!entry) return false;
        held.delete(jobId);
        if (entry.timer !== null) timers.clearTimeout(entry.timer);
        push.send(entry.notification, { jobId }).catch((error) => console.error("[Push]", error));
        return true;
    }

    return {
        hold(jobId, notification, holdMs) {
            if (closed) return;
            const entry = held.get(jobId);
            if (entry) {
                entry.notification = notification;
                entry.holdMs = holdMs;
            } else {
                held.set(jobId, { notification, holdMs, timer: null });
            }
            if (held.size > MAX_COMPLETION_HOLDS) {
                release(held.keys().next().value!);
            }
        },
        jobEnded(jobId) {
            const entry = held.get(jobId);
            if (!entry || entry.timer !== null) return;
            entry.timer = timers.setTimeout(() => release(jobId), entry.holdMs);
            entry.timer.unref?.();
        },
        release,
        close() {
            closed = true;
            for (const entry of held.values()) {
                if (entry.timer !== null) timers.clearTimeout(entry.timer);
            }
            held.clear();
        },
    };
}
