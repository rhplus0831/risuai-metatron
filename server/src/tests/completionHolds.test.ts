// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionNotification } from "../../../shared/notifications.ts";
import { createCompletionHolds, MAX_COMPLETION_HOLDS } from "../push/completionHolds.ts";
import type { PushService } from "../push/pushService.ts";

const notification = (body: string): CompletionNotification => ({
    title: "Risuai",
    body,
    url: "/chat/c/k",
    tag: "risuai-chat-completion:test",
    icon: "/logo_192.png",
    badge: "/logo_192.png",
});
const holdMs = 1_000;

function setup() {
    const push = { send: vi.fn<PushService["send"]>().mockResolvedValue(undefined) } satisfies Pick<
        PushService,
        "send"
    >;
    const holds = createCompletionHolds({ push, timers: { setTimeout, clearTimeout } });
    return { holds, send: push.send };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe("completion holds", () => {
    it("releases a notification once and cancels its deadline", async () => {
        const { holds, send } = setup();
        const message = notification("Reply finished");
        holds.hold("job", message, holdMs);
        holds.jobEnded("job");
        await vi.advanceTimersByTimeAsync(holdMs / 2);
        expect(send).not.toHaveBeenCalled();
        expect(holds.release("job")).toBe(true);
        expect(send.mock.calls).toEqual([[message, { jobId: "job" }]]);
        expect(vi.getTimerCount()).toBe(0);
        expect(holds.release("job")).toBe(false);
        await vi.advanceTimersByTimeAsync(holdMs * 2);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it("waits for the job to end, then sends once after holdMs without restarting on another end", async () => {
        const { holds, send } = setup();
        const message = notification("Long job finished");
        holds.hold("job", message, holdMs);
        await vi.advanceTimersByTimeAsync(holdMs * 100);
        expect(send).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        holds.jobEnded("job");
        await vi.advanceTimersByTimeAsync(holdMs / 2);
        holds.jobEnded("job");
        await vi.advanceTimersByTimeAsync(holdMs / 2 - 1);
        expect(send).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(send.mock.calls).toEqual([[message, { jobId: "job" }]]);
        expect(holds.release("job")).toBe(false);
        await vi.advanceTimersByTimeAsync(holdMs * 2);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it("replaces a job's earlier notification with its latest one", () => {
        const { holds, send } = setup();
        holds.hold("job", notification("First speaker"), holdMs);
        const latest = notification("Last speaker");
        holds.hold("job", latest, holdMs);
        expect(send).not.toHaveBeenCalled();
        expect(holds.release("job")).toBe(true);
        expect(send.mock.calls).toEqual([[latest, { jobId: "job" }]]);
        expect(holds.release("job")).toBe(false);
    });

    it("keeps 64 jobs and sends the oldest when another hold exceeds the bound", () => {
        const { holds, send } = setup();
        expect(MAX_COMPLETION_HOLDS).toBe(64);
        for (let i = 0; i < MAX_COMPLETION_HOLDS; i++) {
            holds.hold(`job-${i}`, notification(`Reply ${i}`), holdMs);
        }
        expect(send).not.toHaveBeenCalled();
        holds.hold("overflow", notification("Newest reply"), holdMs);
        expect(send.mock.calls).toEqual([[notification("Reply 0"), { jobId: "job-0" }]]);
        expect(holds.release("job-0")).toBe(false);
        expect(holds.release("job-1")).toBe(true);
        expect(send.mock.calls[1]).toEqual([notification("Reply 1"), { jobId: "job-1" }]);
        holds.close();
    });

    it("drops armed and pending holds on close without sending, including after their deadlines", async () => {
        const { holds, send } = setup();
        holds.hold("ended", notification("Ended job"), holdMs);
        holds.jobEnded("ended");
        holds.hold("running", notification("Running job"), holdMs);
        holds.close();
        expect(send).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(holdMs * 2);
        expect(send).not.toHaveBeenCalled();
        expect(holds.release("ended")).toBe(false);
        expect(holds.release("running")).toBe(false);
    });
});
