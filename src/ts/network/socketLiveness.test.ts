import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

// The liveness helpers of the feed and job sockets (`socketLiveness.ts`): `watchSocket` (the connect
// timeout from the watch's start, the 15 s watchdog of an open socket's last frame while the page is
// visible, each firing once, a stopped watch staying stopped, the stale check yielding to a pending
// resume fold) and `watchResume` (visible after at least 30 s hidden, measured for the page; the Page
// Lifecycle `resume`; `online`; triggers folded into one call at the end of a 250 ms window, to the
// subscribers of the first trigger still subscribed). Fake timers and `Date`; the callers' use of the
// callbacks is in `eventFeed.test.ts` and `generationJobs.test.ts`.

let liveness: typeof import("./socketLiveness");
let visibility: MockInstance<() => DocumentVisibilityState>;

const show = (state: "visible" | "hidden") => {
    visibility.mockReturnValue(state);
    document.dispatchEvent(new Event("visibilitychange"));
};
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const watched = () => {
    const handlers = { onConnectTimeout: vi.fn(), onStale: vi.fn() };
    return { ...handlers, watch: liveness.watchSocket(handlers) };
};

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.resetModules();
    visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    liveness = await import("./socketLiveness");
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("watchSocket", () => {
    it("fires the connect timeout 10 s after the watch starts unless the socket opened first, once, and never the watchdog for a socket that did not open", async () => {
        const late = watched();
        await advance(9_999);
        expect(late.onConnectTimeout).not.toHaveBeenCalled();
        await advance(1);
        expect(late.onConnectTimeout).toHaveBeenCalledTimes(1);
        // A late open of a connection already given up starts nothing.
        late.watch.opened();
        await advance(120_000);
        expect(late.onConnectTimeout).toHaveBeenCalledTimes(1);
        expect(late.onStale).not.toHaveBeenCalled();

        const inTime = watched();
        await advance(9_999);
        inTime.watch.opened();
        await advance(30_000);
        expect(inTime.onConnectTimeout).not.toHaveBeenCalled();
        inTime.watch.stop();
    });

    it("takes an open socket as stale at the first 15 s check that finds no frame for 45 s, once; every frame (a ping too) restarts the silence", async () => {
        const quiet = watched();
        quiet.watch.opened();
        await advance(44_999);
        expect(quiet.onStale).not.toHaveBeenCalled();
        await advance(1);
        expect(quiet.onStale).toHaveBeenCalledTimes(1);
        await advance(120_000);
        expect(quiet.onStale).toHaveBeenCalledTimes(1);
        expect(quiet.onConnectTimeout).not.toHaveBeenCalled();

        // Frames every 15 s keep it alive for minutes; the silence counts from the last one.
        const pinged = watched();
        pinged.watch.opened();
        for (let tick = 0; tick < 8; tick += 1) {
            await advance(15_000);
            pinged.watch.frame();
        }
        expect(pinged.onStale).not.toHaveBeenCalled();
        await advance(10_000);
        pinged.watch.frame();
        // The checks 5, 20, and 35 s after that frame see that much silence; the one 50 s after it fires.
        await advance(49_999);
        expect(pinged.onStale).not.toHaveBeenCalled();
        await advance(1);
        expect(pinged.onStale).toHaveBeenCalledTimes(1);
    });

    it("checks nothing while the page is hidden, keeps the stamp, and the first check once shown again sees the silence", async () => {
        const { watch, onStale } = watched();
        watch.opened();
        await advance(10_000);
        watch.frame();
        show("hidden");
        await advance(170_000);
        expect(onStale).not.toHaveBeenCalled();
        // Shown again right after a check: the next one, 15 s later, is the first to look.
        show("visible");
        await advance(14_999);
        expect(onStale).not.toHaveBeenCalled();
        await advance(1);
        expect(onStale).toHaveBeenCalledTimes(1);
    });

    it("stays stopped: a stop before the open clears the connect timeout, a stop after it ends the watchdog, and a late `opened()` or `frame()` restarts nothing", async () => {
        const early = watched();
        early.watch.stop();
        early.watch.stop();
        await advance(60_000);
        expect(early.onConnectTimeout).not.toHaveBeenCalled();
        early.watch.opened();
        await advance(120_000);
        expect(early.onStale).not.toHaveBeenCalled();

        const open = watched();
        open.watch.opened();
        await advance(30_000);
        open.watch.stop();
        open.watch.frame();
        open.watch.opened();
        await advance(120_000);
        expect(open.onStale).not.toHaveBeenCalled();
        expect(open.onConnectTimeout).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("yields the stale check to a pending resume fold: the resume replaces the socket at the end of its window, and a check with no fold pending fires", async () => {
        const onResume = vi.fn();
        const unsubscribe = liveness.watchResume(onResume);
        const { watch, onStale } = watched();
        watch.opened();
        // The page comes back 100 ms before the check that would find 45 s of silence.
        await advance(44_900);
        window.dispatchEvent(new Event("online"));
        await advance(100);
        expect(onStale).not.toHaveBeenCalled();
        expect(onResume).not.toHaveBeenCalled();
        await advance(150);
        expect(onResume).toHaveBeenCalledTimes(1);
        expect(onStale).not.toHaveBeenCalled();
        // The caller that keeps its socket after a resume is still watched: the next check fires.
        await advance(15_000);
        expect(onStale).toHaveBeenCalledTimes(1);
        unsubscribe();
    });
});

describe("watchResume", () => {
    it("calls back when the page becomes visible after at least 30 s hidden, measured for the page whenever a subscription started, and not after a shorter absence", async () => {
        const first = vi.fn();
        const second = vi.fn();
        const stopFirst = liveness.watchResume(first);
        show("hidden");
        await advance(10_000);
        // Subscribed 10 s into the absence: the page's hidden time counts, not the subscription's.
        const stopSecond = liveness.watchResume(second);
        await advance(20_000);
        show("visible");
        await advance(249);
        expect(first).not.toHaveBeenCalled();
        await advance(1);
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);

        show("hidden");
        await advance(29_999);
        show("visible");
        await advance(1_000);
        expect(first).toHaveBeenCalledTimes(1);
        // A visible page that is shown again (no hidden state before it) is not a return.
        show("visible");
        await advance(1_000);
        expect(first).toHaveBeenCalledTimes(1);
        stopFirst();
        stopSecond();
    });

    it("counts a page hidden when the first subscription starts from then", async () => {
        visibility.mockReturnValue("hidden");
        vi.resetModules();
        liveness = await import("./socketLiveness");
        const onResume = vi.fn();
        const unsubscribe = liveness.watchResume(onResume);
        await advance(30_000);
        show("visible");
        await advance(250);
        expect(onResume).toHaveBeenCalledTimes(1);
        unsubscribe();
    });

    it("folds `resume`, `online`, and the return to visible within 250 ms of the first trigger into one call at the end of the window, to the subscribers of the first trigger that are still subscribed; a later trigger starts a new window", async () => {
        const a = vi.fn();
        const b = vi.fn();
        const c = vi.fn();
        const stopA = liveness.watchResume(a);
        const stopB = liveness.watchResume(b);
        show("hidden");
        await advance(60_000);
        document.dispatchEvent(new Event("resume"));
        await advance(100);
        show("visible");
        window.dispatchEvent(new Event("online"));
        // Subscribed after the first trigger: not in this window. Unsubscribed before its end: not called.
        const stopC = liveness.watchResume(c);
        stopB();
        await advance(149);
        expect(a).not.toHaveBeenCalled();
        await advance(1);
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).not.toHaveBeenCalled();
        expect(c).not.toHaveBeenCalled();

        // An `online` after the window (the network came back later than the screen) is a new one.
        await advance(1_000);
        window.dispatchEvent(new Event("online"));
        await advance(250);
        expect(a).toHaveBeenCalledTimes(2);
        expect(c).toHaveBeenCalledTimes(1);
        // The same callback subscribed twice is two subscriptions; its unsubscribe removes only one.
        const stopA2 = liveness.watchResume(a);
        stopA2();
        window.dispatchEvent(new Event("online"));
        await advance(250);
        expect(a).toHaveBeenCalledTimes(3);
        expect(c).toHaveBeenCalledTimes(2);
        stopA();
        stopC();
        window.dispatchEvent(new Event("online"));
        await advance(250);
        expect(a).toHaveBeenCalledTimes(3);
        expect(c).toHaveBeenCalledTimes(2);
    });
});
