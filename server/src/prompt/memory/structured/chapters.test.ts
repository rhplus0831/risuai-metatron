// @vitest-environment node
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { ChatOp } from "../../../../../shared/chats.ts";
import { memoryChapterMark, type MemoryChapter } from "../../../../../shared/structuredMemory.ts";
import { messageSourceHash, type MemoryEventWrite } from "../../../data/memoryStore.ts";
import { createFixture } from "../../../tests/fixtures/memory/structured/harness.ts";
import { generateStory } from "../../../tests/fixtures/memory/structured/story.ts";
import { memoryRecords, writeMemory } from "../../../tests/memoryFixtures.ts";
import type { MemoryHost } from "../host.ts";
import { MemoryHostFailure } from "../memoryTaskHost.ts";
import { makeChapters, remakeChapter } from "./chapters.ts";

const story = generateStory({ language: "en", turns: 30, seed: 17 });
const text = { title: "At the harbor", synopsis: "The crew reached the harbor." };
const reply = { type: "success" as const, result: JSON.stringify(text) };
const members = (events: MemoryEventWrite[]) =>
    events.map(({ id, title, summary, storyTime }) => ({
        id,
        mark: memoryChapterMark(title, summary, storyTime.date),
    }));

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

function timeline(count: number) {
    const fixture = createFixture({ story, algorithm: "structuredMemory" });
    onTestFinished(() => fixture.dispose());
    const { store, chatRef } = fixture;
    const { chaId, chatId } = chatRef;
    const messages = fixture.messages().slice(0, count);
    const events = memoryRecords(messages.map((_, i) => `e${i}`)).events.map((event, i) => ({
        ...event,
        title: `Entry [${i}]`,
        summary: `Story detail ${i}.`,
        sources: [{ messageId: messages[i].chatId!, index: i, hash: messageSourceHash(messages[i]) }],
    }));
    const write = (...changed: MemoryEventWrite[]) => writeMemory(store, chaId, chatId, { events: changed });
    write(...events);
    const changeChat = (...ops: ChatOp[]) =>
        store.applyChanges({
            chats: [{ characterId: chaId, chatId, baseRevision: store.chatRevision(chaId, chatId), ops }],
        });

    const scope = fixture.jobScope();
    const { host } = fixture.hostOf(scope);
    const request = vi.spyOn(host, "request").mockResolvedValue(reply);
    const controller = new AbortController();
    const epoch = store.epoch();
    const generation = store.chatSourceGeneration(chaId, chatId);
    const guard = () => {
        controller.signal.throwIfAborted();
        store.assertEpoch(epoch);
        if (store.chatSourceGeneration(chaId, chatId) !== generation) throw new Error("Chat was replaced");
    };
    const arg = { store, chatRef, scope, host, epoch, guard };
    const chapters = () => {
        const list = store.memory.chapters.list(chaId, chatId);
        if (!list || list === "tooLarge") throw new Error("Expected the fixture chat's chapters");
        return list.chapters;
    };
    const add = (id: string, ...events: MemoryEventWrite[]) => {
        const old: MemoryChapter = {
            id,
            title: "Previous chapter",
            synopsis: "Previous synopsis.",
            events: members(events),
        };
        store.memory.chapters.add(chaId, chatId, epoch, old);
        return old;
    };
    const sent = () =>
        request.mock.calls.map(([prompt]) =>
            prompt.flatMap(({ content }) =>
                Array.from(content.matchAll(/Entry \[(\d+)\]/g), (match) => `e${match[1]}`),
            ),
        );
    return {
        events,
        messages,
        write,
        changeChat,
        chapters,
        add,
        store,
        request,
        controller,
        sent,
        make: (limit: number) => makeChapters({ ...arg, limit }),
        remake: (chapterId: string) => remakeChapter({ ...arg, chapterId }),
    };
}

it("re-reads the oldest unit after each add, stores the marks sent and leaves the rest at the limit", async () => {
    const t = timeline(50);
    // Forty old events on one day initially divide into four tens. After the first ten,
    // two undated events precede the next explicit date. Its 28 events divide 10/9/9,
    // so the next whole unit contains twelve. The newest ten never enter a request.
    for (const i of [0, 12]) {
        t.events[i].storyTime = { text: "Festival day", date: { year: 2026, month: 4, day: 3 } };
        t.write(t.events[i]);
    }
    expect(await t.make(2)).toEqual({ made: 2, failed: 0, left: 1 });
    const units = [t.events.slice(0, 10), t.events.slice(10, 22)];
    expect(t.sent()).toEqual(units.map((events) => events.map(({ id }) => id)));
    expect(t.chapters()).toEqual(units.map((events) => ({ id: expect.any(String), ...text, events: members(events) })));
});

it("counts each unusable reply once and leaves its unit unwritten", async () => {
    const t = timeline(60);
    const responses: Awaited<ReturnType<MemoryHost["request"]>>[] = [
        { type: "success", result: "  \n " },
        { type: "success", result: "Here is a story without JSON." },
        { type: "success", result: JSON.stringify({ ...text, synopsis: " " }) },
        { type: "fail", result: JSON.stringify(text) },
        { type: "multiline", result: [["char", JSON.stringify(text)]] },
    ];
    for (const response of responses) t.request.mockResolvedValueOnce(response);
    const writes = t.store.writeCount();
    expect(await t.make(20)).toEqual({ made: 0, failed: 5, left: 5 });
    expect(t.sent()).toEqual(responses.map((_, i) => t.events.slice(i * 10, i * 10 + 10).map(({ id }) => id)));
    expect(t.chapters()).toEqual([]);
    expect(t.store.writeCount()).toBe(writes);
});

it.each(["a member is edited", "a member is retracted", "a newest-ten event is retracted"] as const)(
    "discards a chapter answer when %s during the request",
    async (change) => {
        const t = timeline(20);
        t.request.mockImplementationOnce(async () => {
            const event = t.events[change === "a newest-ten event is retracted" ? 19 : 0];
            t.write(
                change === "a member is edited"
                    ? { ...event, summary: "A different ending." }
                    : { ...event, status: "retracted" },
            );
            return reply;
        });
        expect(await t.make(1)).toEqual({ made: 0, failed: 1, left: change === "a member is edited" ? 1 : 0 });
        expect(t.sent()).toEqual([t.events.slice(0, 10).map(({ id }) => id)]);
        expect(t.chapters()).toEqual([]);
    },
);

it.each(["make", "remake"] as const)(
    "refuses a %s answer after a whole-chat replacement with identical messages",
    async (operation) => {
        const t = timeline(20);
        const before = operation === "remake" ? [t.add("old", t.events[0])] : [];
        t.request.mockImplementationOnce(async () => {
            t.changeChat({ op: "replace", chat: t.store.readChatSource("c", "k").data! });
            return reply;
        });
        await expect(operation === "make" ? t.make(1) : t.remake("old")).rejects.toThrow("Chat was replaced");
        expect(t.request).toHaveBeenCalledTimes(1);
        expect(t.chapters()).toEqual(before);
    },
);

it("removes an orphan before requesting and preserves earlier work when the host throws", async () => {
    const t = timeline(33);
    const [unplaced, retracted, gone] = t.events.slice(30);
    const kept = t.add("kept", unplaced, retracted);
    t.add("orphan", gone);
    t.changeChat({ op: "remove", ids: [unplaced.sources[0].messageId] });
    t.write({ ...retracted, status: "retracted" }, { ...gone, status: "retracted" });

    let atFirstRequest: string[] = [];
    t.request
        .mockImplementationOnce(async () => {
            atFirstRequest = t.chapters().map(({ id }) => id);
            return reply;
        })
        .mockRejectedValueOnce(new MemoryHostFailure("Host stopped"));
    await expect(t.make(3)).rejects.toThrow("Host stopped");
    expect(t.request).toHaveBeenCalledTimes(2);
    expect(atFirstRequest).toEqual([kept.id]);
    expect(t.chapters()).toEqual([kept, { ...text, id: expect.any(String), events: members(t.events.slice(0, 10)) }]);
});

it("stops before writing an answer received after cancellation", async () => {
    const t = timeline(30);
    t.request.mockImplementationOnce(async () => {
        t.controller.abort(new Error("Cancelled in request"));
        return reply;
    });
    await expect(t.make(2)).rejects.toThrow("Cancelled in request");
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.chapters()).toEqual([]);
});

it("stops before the next request when cancelled after a chapter commits", async () => {
    const t = timeline(30);
    const add = t.store.memory.chapters.add.bind(t.store.memory.chapters);
    vi.spyOn(t.store.memory.chapters, "add").mockImplementationOnce((...args) => {
        add(...args);
        t.controller.abort(new Error("Cancelled after commit"));
    });
    await expect(t.make(2)).rejects.toThrow("Cancelled after commit");
    expect(t.request).toHaveBeenCalledTimes(1);
    expect(t.chapters()).toEqual([{ ...text, id: expect.any(String), events: members(t.events.slice(0, 10)) }]);
});

it("remakes only listed, placed survivors in current order even if their absolute positions shift", async () => {
    const t = timeline(6);
    const [first, , third, unplaced, retracted] = t.events;
    const old = t.add("old", third, unplaced, retracted, first);
    t.write({ ...retracted, status: "retracted" });
    t.changeChat({ op: "remove", ids: [unplaced.sources[0].messageId] });
    t.request.mockImplementationOnce(async () => {
        t.changeChat({
            op: "append",
            anchor: { start: true },
            messages: [{ chatId: "earlier", role: "user", data: "Earlier scene" }],
        });
        return reply;
    });
    expect(await t.remake(old.id)).toBe("replaced");
    expect(t.sent()).toEqual([[first.id, third.id]]);
    expect(t.chapters()).toEqual([{ ...text, id: expect.any(String), events: members([first, third]) }]);
    expect(t.chapters()[0].id).not.toBe(old.id);
});

it.each(["failed reply", "no placed member", "lost placement", "changed member order", "edited member"] as const)(
    "keeps the old chapter on remake with %s",
    async (change) => {
        const t = timeline(3);
        const old = t.add("old", t.events[0], t.events[1]);
        const first = t.messages[0];
        if (change === "no placed member") {
            t.changeChat({ op: "remove", ids: [first.chatId!, t.messages[1].chatId!] });
        }
        t.request.mockImplementationOnce(async () => {
            if (change === "failed reply") return { type: "fail", result: "Provider unavailable" };
            if (change === "lost placement") t.changeChat({ op: "remove", ids: [first.chatId!] });
            if (change === "changed member order") {
                t.changeChat(
                    { op: "remove", ids: [first.chatId!] },
                    { op: "append", anchor: { end: true }, messages: [first] },
                );
            }
            if (change === "edited member") t.write({ ...t.events[0], title: "Renamed" });
            return reply;
        });
        expect(await t.remake(old.id)).toBe("kept");
        expect(t.sent()).toEqual(change === "no placed member" ? [] : [["e0", "e1"]]);
        expect(t.chapters()).toEqual([old]);
    },
);

it("removes a remake with no surviving member and repeats without a write or request", async () => {
    const t = timeline(2);
    const old = t.add("old", ...t.events);
    t.write(...t.events.map((event) => ({ ...event, status: "retracted" as const })));
    expect(await t.remake(old.id)).toBe("removed");
    expect(t.chapters()).toEqual([]);
    const writes = t.store.writeCount();
    expect(await t.remake(old.id)).toBe("removed");
    expect(t.store.writeCount()).toBe(writes);
    expect(t.request).not.toHaveBeenCalled();
});
