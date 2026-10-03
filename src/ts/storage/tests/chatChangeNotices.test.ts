import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 5 Stop D fixes (C3): the notices between the tabs of one browser that a server job changed
// a chat (`chatChangeNotices.ts`): the per-chat throttle on the owner side, the receiver's epoch and
// shape filter, the lifecycle, and a missing or failing `BroadcastChannel`. The chat module and
// the epoch are stubbed; `resourceSyncNotices.test.ts` runs both sides over the real adapter.

const stubs = vi.hoisted(() => ({ marked: vi.fn(), epoch: { value: "E" as string | null } }));
vi.mock("../chatStore.svelte", () => ({ markChatNoticed: stubs.marked }));
vi.mock("../resourceClient", () => ({ getResourceEpoch: () => stubs.epoch.value }));

/** A BroadcastChannel stand-in: posts are recorded; listeners are called directly. */
class FakeChannel {
    static instances: FakeChannel[] = [];
    posted: unknown[] = [];
    listeners = new Set<(event: MessageEvent) => void>();
    closed = false;
    constructor(readonly name: string) {
        FakeChannel.instances.push(this);
    }
    postMessage(data: unknown) {
        this.posted.push(data);
    }
    addEventListener(_type: string, listener: (event: MessageEvent) => void) {
        this.listeners.add(listener);
    }
    removeEventListener(_type: string, listener: (event: MessageEvent) => void) {
        this.listeners.delete(listener);
    }
    close() {
        this.closed = true;
    }
}

type Notices = typeof import("../chatChangeNotices");
let notices: Notices;
const posts = () => FakeChannel.instances.flatMap((channel) => channel.posted);
const k = { chaId: "c", chatId: "k" };
const j = { chaId: "c", chatId: "j" };

async function load(channel: unknown) {
    notices?.resetChatChangeNotices();
    vi.stubGlobal("BroadcastChannel", channel);
    vi.resetModules();
    notices = await import("../chatChangeNotices");
}

beforeEach(async () => {
    vi.useFakeTimers();
    FakeChannel.instances.length = 0;
    stubs.epoch.value = "E";
    await load(FakeChannel);
});

afterEach(() => {
    notices.resetChatChangeNotices();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe("announceChatChange", () => {
    it("sends at most one notice per chat a second (leading and trailing), each chat on its own, on the named channel", async () => {
        notices.announceChatChange(k);
        notices.announceChatChange(k);
        notices.announceChatChange(k);
        notices.announceChatChange(j);
        expect(FakeChannel.instances.map((channel) => channel.name)).toEqual(["risu-chat-changes"]);
        expect(posts()).toEqual([
            { epoch: "E", chaId: "c", chatId: "k" },
            { epoch: "E", chaId: "c", chatId: "j" },
        ]);
        // The trailing notice for k, then nothing more: j had nothing waiting.
        await vi.advanceTimersByTimeAsync(notices.NOTICE_INTERVAL_MS);
        expect(posts()).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(notices.NOTICE_INTERVAL_MS);
        expect(posts()).toHaveLength(3);
        // An idle chat's throttle is gone: the next notice goes at once and no timer is left over.
        await vi.advanceTimersByTimeAsync(5000);
        expect(vi.getTimerCount()).toBe(0);
        notices.announceChatChange(k);
        expect(posts()).toHaveLength(4);
    });

    it("sends a final notice at once and cancels the waiting trailing one", async () => {
        notices.announceChatChange(k);
        notices.announceChatChange(k);
        notices.announceChatChange(k, true);
        expect(posts()).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(3000);
        expect(posts()).toHaveLength(2);
    });

    it("sends nothing without a loaded epoch", () => {
        stubs.epoch.value = null;
        notices.announceChatChange(k, true);
        notices.announceChatChange(j);
        expect(posts()).toEqual([]);
    });
});

describe("startChatChangeNotices", () => {
    it("hands a well-formed notice of the loaded epoch to the chat module, and nothing else", () => {
        notices.startChatChangeNotices();
        const [channel] = FakeChannel.instances;
        const receive = (data: unknown) => {
            for (const listener of channel.listeners) {
                listener({ data } as MessageEvent);
            }
        };
        receive({ epoch: "E", chaId: "c", chatId: "k" });
        receive({ epoch: "X", chaId: "c", chatId: "k" });
        receive({ epoch: "E", chaId: "c" });
        receive({ epoch: "E", chaId: "", chatId: "k" });
        receive({ epoch: "E", chaId: "c", chatId: 1 });
        receive("text");
        receive(null);
        expect(stubs.marked.mock.calls).toEqual([[{ chaId: "c", chatId: "k" }]]);
    });

    it("keeps one receiver for repeated starts, stops it, starts again, and closes the channel on reset", () => {
        const stop = notices.startChatChangeNotices();
        expect(notices.startChatChangeNotices()).toBe(stop);
        const [channel] = FakeChannel.instances;
        expect(FakeChannel.instances).toHaveLength(1);
        expect(channel.listeners.size).toBe(1);
        stop();
        expect(channel.listeners.size).toBe(0);
        notices.startChatChangeNotices();
        expect(channel.listeners.size).toBe(1);
        notices.resetChatChangeNotices();
        expect(channel.listeners.size).toBe(0);
        expect(channel.closed).toBe(true);
    });

    it.each([
        ["missing", undefined],
        [
            "throwing on construction",
            class {
                constructor() {
                    throw new Error("unavailable");
                }
            },
        ],
    ])("does nothing and never throws when BroadcastChannel is %s", async (_label, channel) => {
        await load(channel);
        expect(() => notices.announceChatChange(k, true)).not.toThrow();
        expect(() => notices.announceChatChange(j)).not.toThrow();
        expect(() => notices.startChatChangeNotices()()).not.toThrow();
        expect(stubs.marked).not.toHaveBeenCalled();
    });

    it("does not throw when posting fails (a closed channel)", async () => {
        await load(
            class extends FakeChannel {
                postMessage() {
                    throw new Error("closed");
                }
            },
        );
        expect(() => notices.announceChatChange(k, true)).not.toThrow();
        expect(() => notices.announceChatChange(j)).not.toThrow();
    });
});
