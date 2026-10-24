import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertQueue, type AlertQueue } from "./alertQueue";

// The terminal notice (`alert.ts` `alertTerminal`, the restore notice): it lives outside
// `alertStore`, so no ordinary alert (normal, error, markdown, toast, wait, or a clear) can replace
// or resolve it; only `acknowledgeTerminalNotice` (its own OK) resolves it, once. The real module
// over the real alert queue, a fresh one per test so the dialogs one test leaves open never reach
// the next.

const { alertStore } = vi.hoisted(() => ({ alertStore: { current: null as unknown as AlertQueue } }));

vi.mock("./stores.svelte", async () =>
    (await import("src/ts/tests/storesMock")).createStoresMock({
        alertStore: new Proxy({} as AlertQueue, { get: (_target, key) => Reflect.get(alertStore.current, key) }),
    }),
);
vi.mock("./storage/database.svelte", () => ({ getDatabase: () => ({}) }));
vi.mock("../lang", () => ({ language: { errors: {} } }));

import {
    acknowledgeTerminalNotice,
    alertClear,
    alertError,
    alertMd,
    alertNormal,
    alertTerminal,
    alertToast,
    alertWait,
    terminalNotice,
} from "./alert";

/** Whether `promise` has settled, after the pending microtasks ran. */
async function settled(promise: Promise<unknown>) {
    let done = false;
    void promise.then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return done;
}

beforeEach(() => {
    alertStore.current = createAlertQueue({ type: "none", msg: "" }, { gapMs: 0 });
});
afterEach(() => {
    // Every test ends with no notice shown (the module's state is per document).
    acknowledgeTerminalNotice();
});

describe("alertTerminal", () => {
    it("shows the notice outside alertStore and stays pending through every ordinary alert", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        alertNormal("an open alert");
        const pending = alertTerminal("restored");
        expect(get(terminalNotice)).toBe("restored");
        // The ordinary alert shown before is left as it was.
        expect(get(alertStore.current)).toEqual({ type: "normal", msg: "an open alert" });
        alertToast("a toast");
        alertError("an error");
        alertMd("markdown");
        alertWait("waiting");
        alertClear();
        // The shown dialog's own close, and the queued ones after it, leave the notice alone.
        alertStore.current.answer("");
        alertStore.current.set({ type: "none", msg: "" });
        expect(await settled(pending)).toBe(false);
        expect(get(terminalNotice)).toBe("restored");
        expect(alertStore.current.hasDialogs()).toBe(true);
    });

    it("resolves once on acknowledgement and hides the notice; a repeated acknowledgement does nothing", async () => {
        const pending = alertTerminal("restored");
        let resolutions = 0;
        void pending.then(() => resolutions++);
        acknowledgeTerminalNotice();
        acknowledgeTerminalNotice();
        expect(await settled(pending)).toBe(true);
        expect(resolutions).toBe(1);
        expect(get(terminalNotice)).toBeNull();
    });

    it("does nothing on an acknowledgement with no notice shown", async () => {
        acknowledgeTerminalNotice();
        expect(get(terminalNotice)).toBeNull();
        const pending = alertTerminal("later");
        expect(await settled(pending)).toBe(false);
        expect(get(terminalNotice)).toBe("later");
    });

    it("is single-flight: a second call keeps the first message and returns the same promise", async () => {
        const first = alertTerminal("first");
        const second = alertTerminal("second");
        expect(second).toBe(first);
        expect(get(terminalNotice)).toBe("first");
        acknowledgeTerminalNotice();
        expect(await settled(first)).toBe(true);
        // After an acknowledgement a new call shows a new notice with a new promise.
        const third = alertTerminal("third");
        expect(third).not.toBe(first);
        expect(get(terminalNotice)).toBe("third");
        expect(await settled(third)).toBe(false);
    });

    it("exposes the notice read-only", () => {
        expect("set" in terminalNotice).toBe(false);
        expect("update" in terminalNotice).toBe(false);
    });
});
