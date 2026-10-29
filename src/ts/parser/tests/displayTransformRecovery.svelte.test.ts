import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ref = { chaId: "character", chatId: "chat" };
const shown = (display: string) => ({ display, bilingual: undefined });

beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
});
afterEach(() => vi.useRealTimers());

it("keeps a failure while its message shows the same source, and drops it for another source", async () => {
    const recovery = await import("../displayTransformRecovery.svelte");
    const key = recovery.displayTransformMessageKey(ref, "message");
    const row = {};
    recovery.showDisplayTransformSource(ref, "message", row, shown("Old reply"));
    recovery.markDisplayTransformFailed(ref, "message", 0);
    // The row shows it again, and a second row mounts on the same text.
    recovery.showDisplayTransformSource(ref, "message", row, shown("Old reply"));
    recovery.showDisplayTransformSource(ref, "message", {}, shown("Old reply"));
    vi.advanceTimersByTime(5_000);
    expect(recovery.displayTransformRetryRound.version).toBe(1);
    expect([...recovery.displayTransformRetryRound.keys]).toEqual([key]);

    // An edit mounts a row on the new text before the old row unmounts: the old text's failure is not
    // retried over it, and the old row's release leaves the new row's text.
    recovery.markDisplayTransformFailed(ref, "message", 1);
    recovery.showDisplayTransformSource(ref, "message", {}, shown("New reply"));
    recovery.releaseDisplayTransformSource(ref, "message", row);
    recovery.markDisplayTransformFailed(ref, "message", 1);
    recovery.showDisplayTransformSource(ref, "message", {}, shown("Third reply"));
    vi.advanceTimersByTime(60_000);
    expect(recovery.displayTransformRetryRound.version).toBe(1);
});
