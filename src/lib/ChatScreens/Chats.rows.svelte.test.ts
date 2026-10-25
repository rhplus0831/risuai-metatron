// @vitest-environment happy-dom

import { flushSync, mount, onDestroy, unmount } from "svelte";
import { writable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_ROW_CAP } from "../../../shared/chatLoadPages.ts";

type Message = { chatId: string; data: string; role: "char" | "user"; disabled?: boolean };
type RowProps = {
    messageId: string;
    message: string;
    idx: number;
    name: string;
    img: string | Promise<string>;
    largePortrait: boolean;
};
type Row = {
    props: RowProps;
    updates: Record<string, unknown>[];
    element: HTMLElement;
    editing: boolean;
    destroyed: boolean;
    rendered: Promise<void>;
    settle: () => void;
    reject: (error: Error) => void;
};
const state = vi.hoisted(() => ({ rows: [] as Row[] }));

vi.mock("./Chat.svelte", () => ({
    default: (anchor: Node, props: RowProps) => {
        let settle!: () => void;
        let reject!: (error: Error) => void;
        const rendered = new Promise<void>((resolve, rejectRender) => {
            settle = resolve;
            reject = rejectRender;
        });
        const row: Row = {
            props,
            updates: [],
            element: anchor.parentElement!,
            editing: false,
            destroyed: false,
            rendered,
            settle,
            reject,
        };
        row.element.dataset.messageId = props.messageId;
        state.rows.push(row);
        onDestroy(() => {
            row.destroyed = true;
        });
        return {
            updateRow: (update: Record<string, unknown>) => row.updates.push(update),
            isEditing: () => row.editing,
            whenRendered: () => row.rendered,
        };
    },
}));
vi.mock("src/ts/storage/settingsViews.svelte", () => {
    const settings = $state({
        ui: {
            theme: "standard",
            autoScrollToNewMessage: false,
            alwaysScrollToNewMessage: false,
            chatLoadAdditionalPages: 15,
        },
    });
    return { settings };
});
vi.mock("src/ts/characters", () => ({
    getCharImage: vi.fn((path: string, _type: string, thumb?: number) =>
        thumb === undefined ? `image:${path}:original` : `image:${path}`,
    ),
}));
vi.mock("src/ts/stores.svelte", async () =>
    (await import("src/ts/tests/storesMock")).createStoresMock({
        createSimpleCharacter: vi.fn(() => ({ type: "simple" as const, chaId: "c", customscript: [] })),
        ReloadChatPointer: writable({}),
        reloadChatKey: (id: string | undefined, idx: number) => (id !== undefined ? `m:${id}` : `i:${idx}`),
    }),
);
vi.mock("src/ts/storage/chatStore.svelte", () => {
    const selection = $state({ chaId: "c", chatId: "chat" });
    // Chat key → the entry that chat shows as streaming.
    const streaming: Record<string, { messageId: string; mode: string }> = $state({});
    // Chat key → its messages locked by a generation, and those of them that streamed.
    const locks: Record<string, string[]> = $state({});
    const streamed: Record<string, string[]> = $state({});
    return {
        currentChatRef: () => selection,
        selectedChatId: () => selection.chatId,
        streamingEntry: (ref: { chaId: string; chatId: string } | null) =>
            (ref === null ? undefined : streaming[`${ref.chaId}/${ref.chatId}`]) ?? null,
        setStreamingState: (
            ref: { chaId: string; chatId: string },
            entry: { messageId: string; mode: string } | null,
        ) => {
            if (entry === null) delete streaming[`${ref.chaId}/${ref.chatId}`];
            else streaming[`${ref.chaId}/${ref.chatId}`] = entry;
        },
        isMessageLocked: (ref: { chaId: string; chatId: string } | null, messageId: string | undefined) =>
            ref !== null && messageId !== undefined && !!locks[`${ref.chaId}/${ref.chatId}`]?.includes(messageId),
        isMessageStreamed: (ref: { chaId: string; chatId: string } | null, messageId: string | undefined) =>
            ref !== null && messageId !== undefined && !!streamed[`${ref.chaId}/${ref.chatId}`]?.includes(messageId),
        setLockedMessages: (
            ref: { chaId: string; chatId: string },
            messageIds: string[],
            streamedIds: string[] = [],
        ) => {
            locks[`${ref.chaId}/${ref.chatId}`] = messageIds;
            streamed[`${ref.chaId}/${ref.chatId}`] = streamedIds;
        },
    };
});
vi.mock("src/ts/globalApi.svelte", () => {
    const chatFoldedStateMessageIndex = $state({ index: -1 });
    return { chatFoldedStateMessageIndex };
});

import { chatFoldedStateMessageIndex as folded } from "src/ts/globalApi.svelte";
import { getCharImage } from "src/ts/characters";
import * as chatStore from "src/ts/storage/chatStore.svelte";
import { currentChatRef, setStreamingState } from "src/ts/storage/chatStore.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { ReloadChatPointer } from "src/ts/stores.svelte";
import Chats from "./Chats.svelte";

class Observer {
    static live: Observer[] = [];
    observed = new Set<Element>();
    constructor(
        private callback: IntersectionObserverCallback,
        readonly options: IntersectionObserverInit,
    ) {
        Observer.live.push(this);
    }
    observe(element: Element) {
        this.observed.add(element);
    }
    unobserve(element: Element) {
        this.observed.delete(element);
    }
    disconnect() {
        this.observed.clear();
        Observer.live = Observer.live.filter((item) => item !== this);
    }
    deliver(element: Element, isIntersecting: boolean) {
        expect(this.observed.has(element)).toBe(true);
        this.callback(
            [
                { target: element, isIntersecting, boundingClientRect: new DOMRect(0, 0, 300, 80) },
            ] as IntersectionObserverEntry[],
            this as never,
        );
        flushSync();
    }
}
// The mock's own setter: the real module has none.
const { setLockedMessages } = chatStore as unknown as {
    setLockedMessages: (ref: { chaId: string; chatId: string }, messageIds: string[], streamedIds?: string[]) => void;
};
const instances: ReturnType<typeof mount>[] = [];
const messages = (count: number): Message[] =>
    Array.from({ length: count }, (_, i) => ({ chatId: `m${i}`, data: `text ${i}`, role: i % 2 ? "user" : "char" }));
const latest = (id: string) => state.rows.filter((row) => row.props.messageId === id).at(-1)!;
const clearUpdates = () =>
    state.rows.forEach((row) => {
        row.updates.length = 0;
    });
const rect = (top: number, bottom: number) => new DOMRect(0, top, 300, bottom - top);

function render(
    input = messages(6),
    window = input.length,
    options: { suspendTrim: boolean; scrollTop: number; clientHeight?: number } = { suspendTrim: false, scrollTop: 0 },
) {
    const props = $state({
        messages: input,
        currentCharacter: { chaId: "c", name: "Char", image: "char.png", type: "character", largePortrait: false },
        currentUsername: "User",
        userIcon: "user.png",
        userIconPortrait: false,
        onReroll: () => {},
        unReroll: () => {},
        loadPages: window,
        suspendTrim: options.suspendTrim,
        revealing: false,
        hasNewUnreadMessage: false,
        onTrim: undefined as undefined | ((keep: number) => number | undefined),
    });
    const scroller = document.createElement("div");
    document.body.append(scroller);
    // happy-dom has no layout and clamps scroll offsets: provide a reversed scroller explicitly.
    let scrollOffset = options.scrollTop;
    const scrollRead = vi.fn(() => scrollOffset);
    const scrollWrite = vi.fn((value: number) => {
        scrollOffset = value;
    });
    Object.defineProperties(scroller, {
        clientHeight: { get: () => options.clientHeight ?? 400, configurable: true },
        scrollTop: {
            get: scrollRead,
            set: scrollWrite,
            configurable: true,
        },
    });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(rect(100, 500));
    const instance = mount(Chats, { target: scroller, props: props as never });
    instances.push(instance);
    flushSync();
    const ids = () =>
        [...scroller.querySelectorAll<HTMLElement>(".chat-message-container")].map((el) => el.dataset.messageId);
    const append = (role: "char" | "user" = "char") => {
        props.messages.push({ chatId: `m${props.messages.length}`, data: "new reply", role });
        flushSync();
    };
    return { props, scroller, ids, append, scrollRead, scrollWrite, instance };
}

beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", Observer);
    vi.stubGlobal("ResizeObserver", undefined);
    setStreamingState({ chaId: "c", chatId: "chat" }, null);
    Object.assign(currentChatRef()!, { chaId: "c", chatId: "chat" });
    Object.assign(settings.ui, {
        theme: "standard",
        autoScrollToNewMessage: false,
        alwaysScrollToNewMessage: false,
        scrollToReplyStartAfterStreaming: true,
        chatLoadAdditionalPages: 15,
    });
    setLockedMessages({ chaId: "c", chatId: "chat" }, []);
    folded.index = -1;
    ReloadChatPointer.set({});
    vi.mocked(getCharImage).mockClear();
});
afterEach(async () => {
    for (const instance of instances.splice(0)) await unmount(instance);
    state.rows.length = 0;
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("chat row invalidation", () => {
    it("requests original row avatars when mounted under cardboard", () => {
        settings.ui.theme = "cardboard";
        const input = messages(4);
        render(input, input.length, { suspendTrim: true, scrollTop: 0 });

        // Normalize an omitted third argument and an explicit undefined to the same original-image request.
        const requests = vi.mocked(getCharImage).mock.calls.map(([path, type, thumb]) => [path, type, thumb]);
        expect(requests).toEqual(
            expect.arrayContaining([
                ["char.png", "css", undefined],
                ["user.png", "css", undefined],
            ]),
        );
        expect(state.rows).toHaveLength(4);
        for (const row of state.rows) {
            const source = input[row.props.idx].role === "user" ? "user.png" : "char.png";
            expect(row.props.img).toBe(`image:${source}:original`);
        }
    });

    it("switches every shown row between 512 px thumbnails and originals without remounting", () => {
        const input = messages(4);
        render(input, input.length, { suspendTrim: true, scrollTop: 0 });
        const shown = [...state.rows];
        expect(shown).toHaveLength(4);
        expect(getCharImage).toHaveBeenCalledWith("char.png", "css", 512);
        expect(getCharImage).toHaveBeenCalledWith("user.png", "css", 512);
        for (const row of shown) {
            const source = input[row.props.idx].role === "user" ? "user.png" : "char.png";
            expect(row.props.img).toBe(`image:${source}`);
        }

        for (const { theme, thumb, suffix } of [
            { theme: "cardboard", thumb: undefined, suffix: ":original" },
            { theme: "standard", thumb: 512, suffix: "" },
        ]) {
            clearUpdates();
            vi.mocked(getCharImage).mockClear();
            settings.ui.theme = theme;
            flushSync();

            const requests = vi.mocked(getCharImage).mock.calls.map(([path, type, size]) => [path, type, size]);
            expect(requests).toEqual(
                expect.arrayContaining([
                    ["char.png", "css", thumb],
                    ["user.png", "css", thumb],
                ]),
            );
            for (const row of shown) {
                const source = input[row.props.idx].role === "user" ? "user.png" : "char.png";
                expect(row.updates).toContainEqual(expect.objectContaining({ img: `image:${source}${suffix}` }));
                expect(row.destroyed).toBe(false);
                expect(latest(row.props.messageId)).toBe(row);
            }
            expect(state.rows).toHaveLength(shown.length);
        }
    });

    it.each(["off", "balanced", "strong"] as const)("isolates streamed chunks with mode %s", (mode) => {
        setStreamingState({ chaId: "c", chatId: "chat" }, { messageId: "m4", mode });
        const untouchedReads = vi.fn();
        const input = messages(6);
        // A prop getter observes transcript work, including a full diff which emits no updates.
        Object.defineProperty(input[0], "role", {
            enumerable: true,
            get: () => {
                untouchedReads();
                return "char";
            },
        });
        const { props, scroller } = render(input);
        const scrollRead = vi.spyOn(scroller, "scrollTop", "get").mockReturnValue(0);
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        untouchedReads.mockClear();
        clearUpdates();
        for (const text of ["stream 1", "stream 2", "stream 3"]) {
            props.messages[4].data = text;
            flushSync();
        }
        expect(latest("m4").updates).toEqual(
            ["stream 1", "stream 2", "stream 3"].map((text) => ({ message: text, rawStreamingText: text })),
        );
        expect(state.rows).toHaveLength(6);
        expect(state.rows.filter((row) => row.props.messageId !== "m4").flatMap((row) => row.updates)).toEqual([]);
        expect(untouchedReads).not.toHaveBeenCalled();
        expect(scrollRead).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
    });

    it.each(["text", "reload", "disabled"])("remounts only the row whose %s changes", (field) => {
        const { props } = render();
        const before = [...state.rows];
        if (field === "text") props.messages[2].data = "edited";
        if (field === "disabled") props.messages[2].disabled = true;
        if (field === "reload") ReloadChatPointer.set({ "m:m2": 1 });
        flushSync();
        expect(state.rows.slice(6).map((row) => row.props.messageId)).toEqual(["m2"]);
        expect(before.filter((row) => row.destroyed).map((row) => row.props.messageId)).toEqual(["m2"]);
        expect(before.flatMap((row) => row.updates)).toEqual([]);
        if (field === "text") expect(latest("m2").props.message).toBe("edited");
    });

    it.each(["character", "user"])("remounts only %s rows when their portrait mode changes", (who) => {
        const { props } = render();
        if (who === "character") props.currentCharacter.largePortrait = true;
        else props.userIconPortrait = true;
        flushSync();
        const affected = who === "character" ? ["m4", "m2", "m0"] : ["m5", "m3", "m1"];
        expect(state.rows.slice(6).map((row) => row.props.messageId)).toEqual(affected);
        expect(
            state.rows
                .slice(0, 6)
                .filter((row) => row.destroyed)
                .map((row) => row.props.messageId),
        ).toEqual(affected);
        expect(state.rows.slice(6).every((row) => row.props.largePortrait)).toBe(true);
    });

    it.each(["character", "user"])("updates %s names and images in place", (who) => {
        const { props } = render();
        if (who === "character") props.currentCharacter.name = "Renamed";
        else props.currentUsername = "Renamed";
        flushSync();
        const affected = who === "character" ? ["m4", "m2", "m0"] : ["m5", "m3", "m1"];
        for (const row of state.rows)
            expect(row.updates).toEqual(affected.includes(row.props.messageId) ? [{ name: "Renamed" }] : []);
        clearUpdates();
        if (who === "character") props.currentCharacter.image = "new.png";
        else props.userIcon = "new.png";
        flushSync();
        for (const row of state.rows)
            expect(row.updates).toEqual(affected.includes(row.props.messageId) ? [{ img: "image:new.png" }] : []);
        expect(state.rows).toHaveLength(6);
        expect(state.rows.some((row) => row.destroyed)).toBe(false);
    });

    it("reacts to the folded index and loaded window without showing newer messages", () => {
        const { props, ids } = render(messages(10), 3);
        expect(ids()).toEqual(["m9", "m8", "m7"]);
        folded.index = 2;
        flushSync();
        expect(ids()).toEqual(["m2", "m1", "m0"]);
        const retained = [latest("m2"), latest("m1"), latest("m0")];
        // The owner adds messages.length - foldedIndex when unfolding, preserving these rows.
        props.loadPages += props.messages.length - folded.index;
        folded.index = -1;
        flushSync();
        expect(ids()).toEqual(
            messages(10)
                .map((message) => message.chatId)
                .reverse(),
        );
        expect(retained.every((row) => !row.destroyed)).toBe(true);
        props.loadPages = 2;
        flushSync();
        expect(ids()).toEqual(["m9", "m8"]);
    });
});

function trimmable(visible = 5) {
    const ui = render(messages(200), 250);
    // The opening window mounts only its newest rows; scrolling up mounts the rest before the append.
    ui.scroller.dispatchEvent(new Event("wheel"));
    flushSync();
    for (const row of state.rows)
        vi.spyOn(row.element, "getBoundingClientRect").mockReturnValue(
            row.props.idx >= 200 - visible ? rect(100, 120) : rect(60, 80),
        );
    const onTrim = vi.fn((keep: number) => {
        ui.props.loadPages = keep;
        return keep;
    });
    ui.props.onTrim = onTrim;
    flushSync();
    // The opening reveal batch wrote `scrollTop = 0` once at mount; the trim itself must not scroll.
    ui.scrollWrite.mockClear();
    return { ...ui, onTrim };
}

describe("append-time window trim", () => {
    it.each([149, 150])("enforces the cap on an append from %i mounted rows", (count) => {
        const { props, append, ids } = render(messages(count), 200);
        for (const row of state.rows) vi.spyOn(row.element, "getBoundingClientRect").mockReturnValue(rect(60, 80));
        const onTrim = vi.fn((keep: number) => {
            props.loadPages = keep;
            return keep;
        });
        props.onTrim = onTrim;
        flushSync();
        append();
        expect.soft(onTrim.mock.calls).toEqual(count === 149 ? [] : [[150]]);
        expect(ids()).toHaveLength(150);
    });

    it.each([5, 160])("keeps the cap or visible rows plus a page (%i existing visible rows)", async (visible) => {
        expect(CHAT_ROW_CAP).toBe(150);
        const { props, onTrim, append, ids, scroller, scrollWrite } = trimmable(visible);
        // Include the newly appended reply in the rows at/below the viewport.
        const keep = Math.max(150, visible + 1 + 15);
        const survivors = state.rows.filter((row) => row.props.idx >= 201 - keep);
        const anchor = latest("m199").element;
        // Retired rows are disposed over animation frames, a few per frame: run the frames by hand,
        // and charge 1 ms per clock read so each frame's 4 ms budget covers a few unmounts.
        vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
        let now = 0;
        vi.spyOn(performance, "now").mockImplementation(() => ++now);
        append();
        expect(onTrim.mock.calls).toEqual([[keep]]);
        expect(props.loadPages).toBe(keep);
        expect(ids()).toEqual(Array.from({ length: keep }, (_, offset) => `m${200 - offset}`));
        expect(survivors.every((row) => row.element.isConnected && !row.destroyed)).toBe(true);
        expect(scroller.scrollTop).toBe(0);
        // happy-dom has no layout: check the stable anchor/order and no scroll offset writes.
        // Actual pixel anchoring still needs a browser.
        expect(latest("m199").element).toBe(anchor);
        expect(scrollWrite).not.toHaveBeenCalled();
        const retired = state.rows.filter((row) => row.props.idx < 201 - keep);
        expect(retired.every((row) => !row.element.isConnected)).toBe(true);
        const destroyed = () => retired.filter((row) => row.destroyed).length;
        expect(destroyed()).toBe(0);
        vi.advanceTimersToNextFrame();
        expect(destroyed()).toBeGreaterThan(0);
        expect(destroyed()).toBeLessThan(retired.length);
        for (let frame = 1; frame < retired.length && destroyed() < retired.length; frame++) {
            vi.advanceTimersToNextFrame();
        }
        expect(destroyed()).toBe(retired.length);
        expect(survivors.every((row) => !row.destroyed)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["scrolled up", "suspended", "capture", "folded", "instance editor", "message editor", "partial editor"])(
        "does not trim when %s",
        (guard) => {
            const { props, onTrim, append, scroller } = trimmable();
            if (guard === "scrolled up") scroller.scrollTop = -4;
            if (guard === "suspended") props.suspendTrim = true;
            if (guard === "capture") props.loadPages = Infinity;
            if (guard === "folded") folded.index = 190;
            if (guard === "instance editor") latest("m0").editing = true;
            if (guard === "message editor" || guard === "partial editor") {
                const editor = document.createElement("div");
                editor.className = guard === "message editor" ? "message-edit-area" : "partial-edit-overlay";
                latest("m0").element.append(editor);
            }
            flushSync();
            append();
            expect(onTrim).not.toHaveBeenCalled();
            expect(latest("m0").element.isConnected).toBe(true);
            expect(latest("m0").destroyed).toBe(false);
        },
    );

    it("allows an editor in a kept row and waits for an append in the same chat", () => {
        const { props, onTrim, append } = trimmable();
        latest("m199").editing = true;
        props.messages[0].data = "edit without append";
        flushSync();
        expect(onTrim).not.toHaveBeenCalled();
        currentChatRef()!.chatId = "other";
        append();
        expect(onTrim).not.toHaveBeenCalled();
        latest("m200").editing = true;
        append();
        expect(onTrim.mock.calls).toEqual([[150]]);
    });
});

describe("distant row containment", () => {
    it("marks only non-intersecting rows far with two scroller heights of margin", () => {
        const { scroller } = render();
        const observer = Observer.live[0];
        expect(observer.options.root).toBe(scroller);
        expect(observer.options.rootMargin).toMatch(/^800px\b/);
        expect(state.rows.some((row) => row.element.classList.contains("far"))).toBe(false);
        observer.deliver(latest("m0").element, false);
        observer.deliver(latest("m1").element, true);
        expect(latest("m0").element.classList.contains("far")).toBe(true);
        expect(latest("m1").element.classList.contains("far")).toBe(false);
        observer.deliver(latest("m0").element, true);
        expect(latest("m0").element.classList.contains("far")).toBe(false);
    });

    it("keeps instance, original and partial editors near and clears far for capture", () => {
        const { props } = render();
        latest("m0").editing = true;
        for (const [id, className] of [
            ["m1", "message-edit-area"],
            ["m2", "partial-edit-overlay"],
        ]) {
            const editor = document.createElement("div");
            editor.className = className;
            latest(id).element.append(editor);
        }
        for (const row of state.rows) Observer.live[0].deliver(row.element, false);
        expect(["m0", "m1", "m2"].map((id) => latest(id).element.classList.contains("far"))).toEqual([
            false,
            false,
            false,
        ]);
        expect(latest("m3").element.classList.contains("far")).toBe(true);
        props.loadPages = Infinity;
        flushSync();
        expect(state.rows.some((row) => row.element.classList.contains("far"))).toBe(false);
        for (const row of state.rows) Observer.live[0].deliver(row.element, false);
        expect(state.rows.some((row) => row.element.classList.contains("far"))).toBe(false);
    });

    it("does not mark rows far without IntersectionObserver", () => {
        vi.stubGlobal("IntersectionObserver", undefined);
        const { props } = render();
        props.messages[0].data = "changed";
        flushSync();
        expect(Observer.live).toHaveLength(0);
        expect(state.rows.some((row) => row.element.classList.contains("far"))).toBe(false);
    });
});

describe("new reply notification", () => {
    it("reads the bottom before a same-chat character append and marks an unread reply", () => {
        settings.ui.autoScrollToNewMessage = true;
        const { props, scroller, append, ids } = render();
        // The reader scrolls away from the newest message the opening showed.
        scroller.dispatchEvent(new Event("wheel"));
        const oldIds = ids();
        const observedIds: (string | undefined)[][] = [];
        Object.defineProperty(scroller, "scrollTop", {
            configurable: true,
            get: () => {
                observedIds.push(ids());
                return -10;
            },
        });
        append();
        expect(observedIds).toEqual([oldIds]);
        expect(props.hasNewUnreadMessage).toBe(true);
    });

    it("does not read bottom for initial mount, user append, disabled auto-scroll or chat switch", () => {
        const { scroller, append, scrollRead } = render();
        expect(scrollRead).not.toHaveBeenCalled();
        const ownRead = vi.fn(() => -10);
        Object.defineProperty(scroller, "scrollTop", { configurable: true, get: ownRead });
        append(); // auto-scroll off
        settings.ui.autoScrollToNewMessage = true;
        append("user");
        currentChatRef()!.chatId = "other";
        append();
        expect(ownRead).not.toHaveBeenCalled();
    });
});

describe("opening row reveal", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    });

    // No row fills the viewport unless a test explicitly gives it that geometry.
    function opening(input = messages(3), window = input.length, options = { suspendTrim: false, scrollTop: 0 }) {
        const ui = render(input, window, options);
        for (const row of state.rows) vi.spyOn(row.element, "getBoundingClientRect").mockReturnValue(rect(200, 280));
        return {
            ...ui,
            pending: () =>
                [...ui.scroller.querySelectorAll<HTMLElement>(".chat-row-pending")].map((el) => el.dataset.messageId),
        };
    }
    async function flushSettles() {
        await vi.advanceTimersByTimeAsync(0);
        flushSync();
    }
    async function frame() {
        await vi.advanceTimersByTimeAsync(16);
        flushSync();
    }

    it("reveals only the newest-first settled prefix in an animation frame", async () => {
        const ui = opening(messages(4));
        expect(ui.ids()).toEqual(["m3", "m2", "m1", "m0"]);
        expect(ui.pending()).toEqual(["m3", "m2", "m1", "m0"]);
        const images = ["load", "error"].map(() => {
            const img = document.createElement("img");
            Object.defineProperty(img, "complete", { value: false });
            latest("m2").element.append(img);
            return img;
        });
        await flushSettles();
        latest("m0").settle();
        latest("m2").settle();
        await frame();
        expect(ui.pending()).toEqual(["m3", "m2", "m1", "m0"]);
        latest("m3").settle();
        await flushSettles();
        expect(ui.pending()).toEqual(["m3", "m2", "m1", "m0"]);
        await frame();
        expect(ui.pending()).toEqual(["m2", "m1", "m0"]);
        images[0].dispatchEvent(new Event("load"));
        await frame();
        expect(ui.pending()).toEqual(["m2", "m1", "m0"]);
        images[1].dispatchEvent(new Event("error"));
        await flushSettles();
        expect(ui.pending()).toEqual(["m2", "m1", "m0"]);
        await frame();
        expect(ui.pending()).toEqual(["m1", "m0"]);
        latest("m1").reject(new Error("render failed"));
        await frame();
        expect(ui.pending()).toEqual([]);
        expect(ui.props.revealing).toBe(false);
    });

    it("never hides rows on append, load-more, mixed update, remount or unfold", async () => {
        const ui = opening(messages(5), 3);
        state.rows.forEach((row) => row.settle());
        await frame();
        expect(ui.pending()).toEqual([]);
        const assertVisible = () => {
            expect(ui.pending()).toEqual([]);
            expect(ui.props.revealing).toBe(false);
            expect(ui.scrollWrite.mock.calls).toEqual([[0]]);
        };
        ui.append();
        expect(ui.ids()).toEqual(["m5", "m4", "m3"]);
        assertVisible();
        ui.props.loadPages = 6;
        flushSync();
        expect(ui.ids()).toEqual(["m5", "m4", "m3", "m2", "m1", "m0"]);
        assertVisible();
        ui.props.messages = ui.props.messages.filter((message) => message.chatId !== "m1");
        ui.props.messages.push({ chatId: "replacement", role: "char", data: "new" });
        flushSync();
        expect(ui.ids()).toEqual(["replacement", "m5", "m4", "m3", "m2", "m0"]);
        assertVisible();
        ui.props.messages[0].data = "edited";
        flushSync();
        assertVisible();
        folded.index = 2;
        flushSync();
        assertVisible();
        ui.props.loadPages += ui.props.messages.length - folded.index;
        folded.index = -1;
        flushSync();
        expect(ui.ids()).toEqual(["replacement", "m5", "m4", "m3", "m2", "m0"]);
        assertVisible();
        // All newly mounted instances are still waiting, so visibility cannot be due to settling.
        await frame();
        assertVisible();
    });

    it.each(["capture", "suspendTrim"] as const)(
        "%s releases a batch immediately and skips opening gates",
        async (mode) => {
            const ui = opening(messages(3), 2);
            expect(ui.pending()).toEqual(["m2", "m1"]);
            expect(ui.props.revealing).toBe(true);
            await vi.advanceTimersByTimeAsync(400);
            if (mode === "capture") ui.props.loadPages = Infinity;
            else ui.props.suspendTrim = true;
            flushSync();
            expect(ui.pending()).toEqual([]);
            expect(ui.props.revealing).toBe(false);
            expect(vi.getTimerCount()).toBe(0);
            const skipped = opening(messages(2), mode === "capture" ? Infinity : 2, {
                suspendTrim: mode === "suspendTrim",
                scrollTop: -90,
            });
            expect(skipped.pending()).toEqual([]);
            expect(skipped.props.revealing).toBe(false);
            expect(skipped.scrollWrite).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
            // Turning the bypass off is not a new window and must not hide existing rows.
            ui.props.loadPages = 3;
            ui.props.suspendTrim = false;
            flushSync();
            state.rows.forEach((row) => row.settle());
            await frame();
            expect(ui.pending()).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it("releases every remaining row at one 1200 ms deadline from batch start", async () => {
        const ui = opening();
        await vi.advanceTimersByTimeAsync(1000);
        ui.props.messages[1].data = "remounted near the deadline";
        flushSync();
        await vi.advanceTimersByTimeAsync(199);
        expect(ui.pending()).toEqual(["m2", "m1", "m0"]);
        expect(ui.props.revealing).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(ui.pending()).toEqual([]);
        expect(ui.props.revealing).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("stops a removed unsettled row from blocking older settled rows", async () => {
        const ui = opening();
        latest("m2").settle();
        latest("m0").settle();
        await frame();
        expect(ui.pending()).toEqual(["m1", "m0"]);
        ui.props.messages.splice(1, 1);
        flushSync();
        expect(ui.ids()).toEqual(["m2", "m0"]);
        await frame();
        expect(ui.pending()).toEqual([]);
        expect(ui.props.revealing).toBe(false);
    });

    it("waits again for a hidden remount and ignores its obsolete instance settling", async () => {
        const ui = opening();
        const obsoleteNewest = latest("m2");
        latest("m1").settle();
        latest("m0").settle();
        await frame();
        ui.props.messages[1].data = "edited after settling but still hidden";
        ui.props.messages[2].data = "edited while still waiting";
        flushSync();
        expect(latest("m2")).not.toBe(obsoleteNewest);
        obsoleteNewest.settle();
        await frame();
        expect(ui.pending()).toEqual(["m2", "m1", "m0"]);
        latest("m2").settle();
        await frame();
        expect(ui.pending()).toEqual(["m1", "m0"]);
        latest("m1").settle();
        await frame();
        expect(ui.pending()).toEqual([]);
    });

    it("releases the rest when the oldest revealed top reaches the scroller top", async () => {
        const ui = opening(messages(4));
        vi.mocked(latest("m3").element.getBoundingClientRect).mockReturnValue(rect(101, 180));
        vi.mocked(latest("m2").element.getBoundingClientRect).mockReturnValue(rect(100, 101));
        latest("m3").settle();
        await frame();
        expect(ui.pending()).toEqual(["m2", "m1", "m0"]);
        latest("m2").settle();
        await flushSettles();
        expect(ui.pending()).toEqual(["m2", "m1", "m0"]);
        await frame();
        expect(ui.pending()).toEqual([]);
        expect(ui.props.revealing).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("releases the rest when the newest top sits within a pixel below the scroller top", async () => {
        // The start anchor scrolls in whole pixels, leaving a fractional row top just below the scroller's.
        const ui = opening(messages(4));
        vi.mocked(latest("m3").element.getBoundingClientRect).mockReturnValue(rect(100.391, 2309));
        latest("m3").settle();
        await frame();
        expect(ui.pending()).toEqual([]);
        expect(ui.props.revealing).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("waits only for unfinished images in the transcript's view, not lazy ones outside it", async () => {
        // A tall newest message anchored at its start: images further down stay unloaded while hidden.
        const ui = opening(messages(4));
        vi.mocked(latest("m3").element.getBoundingClientRect).mockReturnValue(rect(100, 6000));
        const [near, far] = ["near", "far"].map(() => {
            const img = document.createElement("img");
            Object.defineProperty(img, "complete", { value: false });
            latest("m3").element.append(img);
            return img;
        });
        latest("m3").settle();
        await flushSettles();
        const images = Observer.live.find((observer) => observer.observed.has(near))!;
        expect(images.options.root).toBe(ui.scroller);
        images.deliver(far, false);
        await frame();
        // The near image has no observation yet.
        expect(ui.pending()).toEqual(["m3", "m2", "m1", "m0"]);
        images.deliver(near, true);
        await frame();
        expect(ui.pending()).toEqual(["m3", "m2", "m1", "m0"]);
        near.dispatchEvent(new Event("load"));
        await frame();
        expect(ui.pending()).toEqual([]);
        expect(Observer.live).not.toContain(images);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("resets scrollTop and binds revealing for each opening, releasing on switch and destroy", async () => {
        const ui = opening([], 3, { suspendTrim: false, scrollTop: -90 });
        expect(ui.props.revealing).toBe(false);
        expect(ui.scrollWrite).not.toHaveBeenCalled();
        ui.props.messages = messages(3);
        flushSync();
        expect(ui.scrollWrite.mock.calls).toEqual([[0]]);
        expect(ui.scroller.scrollTop).toBe(0);
        expect(ui.props.revealing).toBe(true);
        expect(ui.pending()).toEqual(["m2", "m1", "m0"]);
        const oldRows = [...state.rows];
        await vi.advanceTimersByTimeAsync(600);
        ui.scroller.scrollTop = -240;
        ui.scrollWrite.mockClear();
        currentChatRef()!.chatId = "other";
        flushSync();
        expect(ui.scrollWrite.mock.calls).toEqual([[0]]);
        expect(ui.scroller.scrollTop).toBe(0);
        expect(oldRows.every((row) => !row.element.classList.contains("chat-row-pending"))).toBe(true);
        expect(ui.pending()).toEqual(["m2", "m1", "m0"]);
        expect(ui.props.revealing).toBe(true);
        // The first chat's deadline and late completions must not release the replacement batch.
        oldRows.forEach((row) => row.settle());
        await vi.advanceTimersByTimeAsync(600);
        expect(ui.pending()).toEqual(["m2", "m1", "m0"]);
        const newRows = state.rows.slice(3);
        await unmount(ui.instance);
        instances.splice(instances.indexOf(ui.instance), 1);
        expect(newRows.every((row) => !row.element.classList.contains("chat-row-pending"))).toBe(true);
        expect(ui.props.revealing).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("opening staged mounting", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    });

    const longMessages = (count = 12) => messages(count).map((message) => ({ ...message, data: "x".repeat(2400) }));
    const containers = (ui: ReturnType<typeof render>) => [
        ...ui.scroller.querySelectorAll<HTMLElement>(".chat-message-container"),
    ];
    const mountedIds = () => state.rows.filter((row) => !row.destroyed).map((row) => row.props.messageId);
    async function flushWaits(ms = 0) {
        await vi.advanceTimersByTimeAsync(ms);
        flushSync();
    }
    function staged() {
        const ui = render(longMessages(), 12, { suspendTrim: false, scrollTop: -90 });
        // Keep reveal geometry independent of happy-dom's zero-sized rectangles.
        for (const element of containers(ui))
            vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect(200, 280));
        return ui;
    }

    // Literal expectations from min(480, 48 + length * .2), independent of production helpers.
    it.each([
        { label: "exact viewport", length: 260, height: 400, count: 12, expected: 4 }, // 4 * 100
        { label: "minimum three", length: 2400, height: 400, count: 12, expected: 3 },
        { label: "maximum eight", length: 0, height: 1000, count: 12, expected: 8 },
        { label: "zero-height scroller", length: 2400, height: 0, count: 12, expected: 8 },
        { label: "short window", length: 2400, height: 400, count: 2, expected: 2 },
    ])("mounts the newest viewport estimate: $label", ({ length, height, count, expected }) => {
        const input = messages(count).map((message) => ({ ...message, data: "x".repeat(length) }));
        const ui = render(input, count, { suspendTrim: false, scrollTop: -90, clientHeight: height });
        const elements = containers(ui);
        expect(mountedIds()).toEqual(Array.from({ length: expected }, (_, i) => `m${count - 1 - i}`));
        expect(elements).toHaveLength(count);
        expect(state.rows.map((row) => row.element)).toEqual(elements.slice(0, expected));
        expect(elements.slice(expected).every((element) => element.childNodes.length === 0)).toBe(true);
        expect(elements.every((element) => element.classList.contains("chat-row-pending"))).toBe(true);
        expect(ui.props.revealing).toBe(true);
        expect(ui.scrollWrite.mock.calls).toEqual([[0]]);
        // Arming fills the existing containers, preserving newest-to-oldest DOM order.
        ui.scroller.dispatchEvent(new Event("wheel"));
        flushSync();
        expect(containers(ui)).toEqual(elements);
        expect(ui.ids()).toEqual(input.map((message) => message.chatId).reverse());
    });

    it("uses newest-row text lengths rather than older rows to fill the viewport", () => {
        const input = longMessages();
        for (const message of input.slice(-5)) message.data = "x".repeat(260); // newest four are 400px
        const ui = render(input);
        expect(mountedIds()).toEqual(["m11", "m10", "m9", "m8"]);
        expect(containers(ui)).toHaveLength(12);
    });

    it("arms after every first-stage render settles or rejects without waiting for images", async () => {
        const ui = staged();
        const first = [...state.rows];
        const image = document.createElement("img");
        Object.defineProperty(image, "complete", { value: false });
        first[0].element.append(image);
        await flushWaits();
        first[0].settle();
        first[1].reject(new Error("failed parse"));
        await flushWaits();
        expect(mountedIds()).toEqual(["m11", "m10", "m9"]);
        first[2].settle();
        await flushWaits();
        expect(ui.ids()).toEqual(
            longMessages()
                .map((message) => message.chatId)
                .reverse(),
        );
        expect(state.rows).toHaveLength(12);
        await flushWaits(16);
        // The newest image still blocks visibility, but no longer blocks mounting older rows.
        expect(containers(ui).every((element) => element.classList.contains("chat-row-pending"))).toBe(true);
        image.dispatchEvent(new Event("load"));
        await flushWaits(16);
        expect(containers(ui).filter((element) => !element.classList.contains("chat-row-pending"))).toEqual(
            first.map((row) => row.element),
        );
        latest("m0").settle();
        await flushWaits(16);
        expect(latest("m0").element.classList.contains("chat-row-pending")).toBe(true);
        for (const row of state.rows.slice(3)) row.settle();
        await flushWaits(16);
        expect(ui.scroller.querySelector(".chat-row-pending")).toBeNull();
        expect(ui.props.revealing).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("follows a pending first-stage remount instead of its obsolete render promise", async () => {
        const ui = staged();
        const obsolete = latest("m11");
        await flushWaits();
        ui.props.messages[11].data = "edited before parsing finished";
        flushSync();
        expect(obsolete.destroyed).toBe(true);
        expect(latest("m11")).not.toBe(obsolete);
        obsolete.settle();
        latest("m10").settle();
        latest("m9").settle();
        await flushWaits();
        expect(mountedIds()).toHaveLength(3);
        latest("m11").settle();
        await flushWaits();
        expect(mountedIds()).toHaveLength(12);
    });

    it("reveals at 1200ms but mounts deferred rows only at the 3000ms batch deadline", async () => {
        const ui = staged();
        await flushWaits(1199);
        expect(containers(ui).every((element) => element.classList.contains("chat-row-pending"))).toBe(true);
        await flushWaits(1);
        expect(ui.scroller.querySelector(".chat-row-pending")).toBeNull();
        expect(ui.props.revealing).toBe(false);
        expect(mountedIds()).toEqual(["m11", "m10", "m9"]);
        ui.props.messages[0].data = "edited after visibility release";
        flushSync();
        await flushWaits(1799);
        expect(mountedIds()).toHaveLength(3);
        await flushWaits(1);
        expect(mountedIds()).toHaveLength(12);
        expect(latest("m0").props.message).toBe("edited after visibility release");
        expect(latest("m0").updates).toEqual([]);
        expect(ui.scroller.querySelector(".chat-row-pending")).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("viewport-filled visibility release does not arm deferred rows", async () => {
        const ui = staged();
        vi.mocked(latest("m11").element.getBoundingClientRect).mockReturnValue(rect(100, 200));
        latest("m11").settle();
        await flushWaits(16);
        expect(ui.scroller.querySelector(".chat-row-pending")).toBeNull();
        expect(ui.props.revealing).toBe(false);
        expect(mountedIds()).toEqual(["m11", "m10", "m9"]);
        latest("m10").settle();
        latest("m9").settle();
        await flushWaits();
        expect(mountedIds()).toHaveLength(12);
    });

    it("does no component or transcript work for deferred stream chunks", async () => {
        setStreamingState({ chaId: "c", chatId: "chat" }, { messageId: "m0", mode: "off" });
        const input = longMessages();
        const structureRead = vi.fn(() => "char" as const);
        Object.defineProperty(input[2], "role", { enumerable: true, get: structureRead });
        const ui = render(input);
        const first = [...state.rows];
        const geometry = vi.spyOn(ui.scroller, "clientHeight", "get");
        structureRead.mockClear();
        clearUpdates();
        for (const text of ["chunk one", "chunk two", "latest chunk"]) {
            ui.props.messages[0].data = text;
            flushSync();
        }
        expect(state.rows).toEqual(first);
        expect(state.rows).toHaveLength(3);
        expect(state.rows.flatMap((row) => row.updates)).toEqual([]);
        expect(state.rows.some((row) => row.destroyed)).toBe(false);
        expect(structureRead).not.toHaveBeenCalled();
        expect(geometry).not.toHaveBeenCalled();
        expect(ui.scrollRead).not.toHaveBeenCalled();
        expect(ui.scrollWrite.mock.calls).toEqual([[0]]);
        first.forEach((row) => row.settle());
        await flushWaits();
        expect(latest("m0").props).toMatchObject({ message: "latest chunk", rawStreamingText: "latest chunk" });
        expect(latest("m0").updates).toEqual([]);
        expect(state.rows).toHaveLength(12);
    });

    it("applies deferred text edits only at mount and never mounts a removed deferred row", async () => {
        const ui = staged();
        const elements = containers(ui);
        ui.props.messages[0].data = "first edit";
        flushSync();
        ui.props.messages[0].data = "final edit";
        ui.props.messages[1].data = "removed before mounting";
        flushSync();
        expect(mountedIds()).toEqual(["m11", "m10", "m9"]);
        expect(state.rows.flatMap((row) => row.updates)).toEqual([]);
        ui.props.messages.splice(1, 1);
        flushSync();
        expect(state.rows.some((row) => row.props.messageId === "m1")).toBe(false);
        expect(elements[10].isConnected).toBe(false);
        expect(latest("m0").props).toMatchObject({ message: "final edit", idx: 0 });
        expect(latest("m0").updates).toEqual([]);
        expect(mountedIds()).toHaveLength(11);
        await flushWaits(3000);
        expect(state.rows.some((row) => row.props.messageId === "m1")).toBe(false);
    });

    it.each(["append", "load-more", "unfold", "name context", "image context"])(
        "%s arms all rows immediately without starting another reveal batch",
        (change) => {
            if (change === "unfold") folded.index = 8;
            const ui = render(longMessages(20), 12);
            expect(state.rows).toHaveLength(3);
            const oldElements = containers(ui);
            if (change === "append") ui.append();
            if (change === "load-more") ui.props.loadPages = 20;
            if (change === "unfold") {
                ui.props.loadPages = 20;
                folded.index = -1;
            }
            if (change === "name context") ui.props.currentUsername = "New user";
            if (change === "image context") ui.props.currentCharacter.image = "new.png";
            flushSync();
            const expected = ui.props.messages
                .slice(-ui.props.loadPages)
                .map((message) => message.chatId)
                .reverse();
            expect(ui.ids()).toEqual(expected);
            expect(mountedIds()).toHaveLength(expected.length);
            expect(ui.scrollWrite.mock.calls).toEqual([[0]]);
            for (const element of containers(ui).filter((element) => !oldElements.includes(element)))
                expect(element.classList.contains("chat-row-pending")).toBe(false);
            if (change === "name context") expect(latest("m17").updates).toEqual([{ name: "New user" }]);
            if (change === "name context") expect(latest("m9").props.name).toBe("New user");
            if (change === "image context") expect(latest("m8").props).toMatchObject({ img: "image:new.png" });
        },
    );

    it.each(["wheel", "touchmove", "pointerdown"])(
        "%s on the scroller arms rows before render waits settle",
        (event) => {
            const ui = staged();
            expect(mountedIds()).toHaveLength(3);
            ui.scroller.dispatchEvent(new Event(event));
            flushSync();
            expect(mountedIds()).toHaveLength(12);
            expect(containers(ui).every((element) => element.classList.contains("chat-row-pending"))).toBe(true);
            expect(ui.props.revealing).toBe(true);
            expect(ui.scrollWrite.mock.calls).toEqual([[0]]);
        },
    );

    it.each(["capture", "suspendTrim"])("%s arms an active batch and bypasses staging on open", (mode) => {
        const ui = staged();
        expect(mountedIds()).toHaveLength(3);
        if (mode === "capture") ui.props.loadPages = Infinity;
        else ui.props.suspendTrim = true;
        flushSync();
        expect(mountedIds()).toHaveLength(12);
        expect(ui.scroller.querySelector(".chat-row-pending")).toBeNull();
        expect(ui.props.revealing).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        const bypassed = render(longMessages(), mode === "capture" ? Infinity : 12, {
            suspendTrim: mode === "suspendTrim",
            scrollTop: -90,
        });
        expect(state.rows).toHaveLength(24);
        expect(bypassed.ids()).toEqual(
            longMessages()
                .map((message) => message.chatId)
                .reverse(),
        );
        expect(bypassed.scroller.querySelector(".chat-row-pending")).toBeNull();
        expect(bypassed.props.revealing).toBe(false);
        expect(bypassed.scrollWrite).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([false, true])(
        "whenRendered arms every row before waiting (pending opening diff: %s)",
        async (pendingDiff) => {
            const ui = staged();
            if (pendingDiff) currentChatRef()!.chatId = "switch-before-flush";
            let done = false;
            const wait = ui.instance.whenRendered().then(() => {
                done = true;
            });
            await flushWaits();
            expect(mountedIds()).toHaveLength(12);
            expect(ui.scroller.querySelector(".chat-row-pending")).toBeNull();
            expect(ui.props.revealing).toBe(false);
            expect(done).toBe(false);
            for (const row of state.rows.filter((row) => !row.destroyed && row.props.messageId !== "m0")) row.settle();
            await flushWaits();
            expect(done).toBe(false);
            latest("m0").settle();
            await wait;
            expect(done).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it("a new opening and destroy cancel old staging without mounting removed rows", async () => {
        const ui = staged();
        const oldElements = containers(ui);
        const oldRows = [...state.rows];
        await flushWaits(1000);
        currentChatRef()!.chatId = "other";
        flushSync();
        expect(state.rows).toHaveLength(6);
        expect(oldRows.every((row) => row.destroyed)).toBe(true);
        expect(
            oldElements.every((element) => !element.isConnected && !element.classList.contains("chat-row-pending")),
        ).toBe(true);
        expect(mountedIds()).toEqual(["m11", "m10", "m9"]);
        expect(ui.scrollWrite.mock.calls).toEqual([[0], [0]]);
        oldRows.forEach((row) => row.settle());
        await flushWaits(200); // old visibility deadline
        expect(ui.props.revealing).toBe(true);
        await flushWaits(1800); // old mounting deadline; replacement has only aged 2000ms
        expect(mountedIds()).toEqual(["m11", "m10", "m9"]);
        const replacementElements = containers(ui);
        await unmount(ui.instance);
        instances.splice(instances.indexOf(ui.instance), 1);
        expect(state.rows).toHaveLength(6);
        expect(state.rows.every((row) => row.destroyed)).toBe(true);
        expect(replacementElements.every((element) => !element.classList.contains("chat-row-pending"))).toBe(true);
        expect(ui.props.revealing).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        ui.scroller.dispatchEvent(new Event("wheel"));
        state.rows.forEach((row) => row.settle());
        await flushWaits(3000);
        expect(state.rows).toHaveLength(6);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe("latest message scroll anchor", () => {
    const chat = { chaId: "c", chatId: "chat" };
    let callbacks: (() => void)[] = [];
    const resize = () => {
        for (const callback of callbacks) callback();
        flushSync();
    };

    beforeEach(() => {
        callbacks = [];
        vi.stubGlobal(
            "ResizeObserver",
            class {
                callback: () => void;
                constructor(callback: ResizeObserverCallback) {
                    this.callback = () => callback([], this as never);
                    callbacks.push(this.callback);
                }
                observe() {}
                disconnect() {
                    callbacks = callbacks.filter((item) => item !== this.callback);
                }
            },
        );
    });

    // Rows are laid out in the 100..500 scroller by their top at scrollTop 0. The scroller is
    // reversed, so a more negative scrollTop moves every row down by as much.
    function anchored(input = messages(6)) {
        const natural = new Map<string, { top: number; height: number }>();
        const ui = render(input);
        const measured = new WeakSet<Element>();
        // Mounted rows only: a row is empty, so unmeasured, until its content mounts.
        const measure = () => {
            for (const row of ui.scroller.querySelectorAll<HTMLElement>(".chat-message-container")) {
                if (measured.has(row)) continue;
                measured.add(row);
                vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => {
                    const box = natural.get(row.dataset.messageId ?? "");
                    if (!box) return new DOMRect(0, 0, 300, 0);
                    return new DOMRect(0, box.top - ui.scroller.scrollTop, 300, box.height);
                });
            }
        };
        measure();
        const push = (message: Message) => {
            ui.props.messages.push(message);
            flushSync();
            measure();
        };
        return { ...ui, natural, push };
    }

    it("opens at the newest message's start, keeps it there as it renders, and lets the reader take over", () => {
        const ui = anchored();
        ui.natural.set("m5", { top: -200, height: 700 });
        resize();
        expect(ui.scroller.scrollTop).toBe(-300);
        // The message renders taller: in the reversed scroller its top moves up.
        ui.natural.set("m5", { top: -400, height: 900 });
        resize();
        expect(ui.scroller.scrollTop).toBe(-500);
        ui.scroller.dispatchEvent(new Event("wheel"));
        ui.natural.set("m5", { top: -600, height: 1100 });
        resize();
        expect(ui.scroller.scrollTop).toBe(-500);
    });

    it("keeps the bottom for a newest message shorter than the view", () => {
        const ui = anchored();
        ui.natural.set("m5", { top: 300, height: 200 });
        resize();
        expect(ui.scrollWrite.mock.calls).toEqual([[0]]);
    });

    it("does not release the anchor for a click in a row or keys typed in an input", () => {
        const ui = anchored();
        ui.natural.set("m5", { top: -200, height: 700 });
        resize();
        const row = ui.scroller.querySelector(".chat-message-container")!;
        row.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        const input = document.createElement("textarea");
        ui.scroller.append(input);
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
        ui.natural.set("m5", { top: -400, height: 900 });
        resize();
        expect(ui.scroller.scrollTop).toBe(-500);
        ui.scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
        ui.natural.set("m5", { top: -600, height: 1100 });
        resize();
        expect(ui.scroller.scrollTop).toBe(-500);
    });

    it("shows a reply that arrives whole from its start, locked or not", () => {
        settings.ui.autoScrollToNewMessage = true;
        const ui = anchored();
        ui.scroller.dispatchEvent(new Event("wheel"));
        ui.push({ chatId: "m6", data: "a whole reply", role: "char" });
        ui.natural.set("m6", { top: -100, height: 600 });
        resize();
        expect(ui.scroller.scrollTop).toBe(-200);

        // The server locks a whole reply until its tail writes; the release keeps its start.
        ui.scroller.dispatchEvent(new Event("wheel"));
        ui.scroller.scrollTop = 0;
        setLockedMessages(chat, ["m7"]);
        ui.push({ chatId: "m7", data: "another whole reply", role: "char" });
        ui.natural.set("m7", { top: -300, height: 800 });
        resize();
        expect(ui.scroller.scrollTop).toBe(-400);
        setLockedMessages(chat, []);
        flushSync();
        expect(ui.scroller.scrollTop).toBe(-400);
    });

    it("leaves a whole reply where the reader scrolled when its lock ends", () => {
        settings.ui.autoScrollToNewMessage = true;
        const ui = anchored();
        setLockedMessages(chat, ["m6"]);
        ui.push({ chatId: "m6", data: "a whole reply", role: "char" });
        ui.natural.set("m6", { top: -300, height: 800 });
        resize();
        expect(ui.scroller.scrollTop).toBe(-400);
        // The reader reads on to the bottom before the job's tail work ends.
        ui.scroller.dispatchEvent(new Event("wheel"));
        ui.scroller.scrollTop = 0;
        setLockedMessages(chat, []);
        flushSync();
        expect(ui.scroller.scrollTop).toBe(0);
    });

    it("keeps the start through a continue that never streams, the streaming setting off", () => {
        settings.ui.autoScrollToNewMessage = true;
        settings.ui.scrollToReplyStartAfterStreaming = false;
        const ui = anchored();
        ui.natural.set("m5", { top: -200, height: 700 });
        resize();
        expect(ui.scroller.scrollTop).toBe(-300);
        // The continue's `accepted` makes the message this tab's streaming entry before any text.
        setLockedMessages(chat, ["m5"]);
        setStreamingState(chat, { messageId: "m5", mode: "off" });
        flushSync();
        expect(ui.scroller.scrollTop).toBe(-300);
        ui.props.messages[5].data = "message 5, continued";
        ui.natural.set("m5", { top: -400, height: 900 });
        resize();
        setStreamingState(chat, null);
        setLockedMessages(chat, []);
        flushSync();
        expect(ui.scroller.scrollTop).toBe(-500);
    });

    it.each([
        ["this tab's stream moves to its start", true, true, -400],
        ["this tab's stream stays at the bottom with the setting off", true, false, 0],
        ["another tab's stream stays at the bottom with the setting off", false, false, 0],
    ])("follows a streamed reply at the bottom and, when it ends, %s", (_name, ownJob, enabled, expected) => {
        settings.ui.autoScrollToNewMessage = true;
        settings.ui.scrollToReplyStartAfterStreaming = enabled;
        const ui = anchored();
        ui.natural.set("m5", { top: -200, height: 700 });
        resize();
        // The reader's send moves a followed transcript to the bottom.
        ui.push({ chatId: "m6", data: "my turn", role: "user" });
        expect(ui.scroller.scrollTop).toBe(0);
        setLockedMessages(chat, ["m7"]);
        ui.push({ chatId: "m7", data: "", role: "char" });
        // Only this tab's job sets a streaming entry; another tab's shows through the feed lock.
        if (ownJob) setStreamingState(chat, { messageId: "m7", mode: "off" });
        setLockedMessages(chat, ["m7"], ["m7"]);
        flushSync();
        ui.props.messages[7].data = "a long streamed reply";
        flushSync();
        ui.natural.set("m7", { top: -300, height: 800 });
        resize();
        expect(ui.scroller.scrollTop).toBe(0);
        setStreamingState(chat, null);
        setLockedMessages(chat, []);
        flushSync();
        expect(ui.scroller.scrollTop).toBe(expected);
    });

    it("opens a chat whose newest message streams at the bottom", () => {
        setLockedMessages(chat, ["m5"], ["m5"]);
        const ui = anchored();
        ui.natural.set("m5", { top: -200, height: 700 });
        resize();
        expect(ui.scroller.scrollTop).toBe(0);
    });

    it("leaves a reader who scrolled up during the stream where they are", () => {
        settings.ui.autoScrollToNewMessage = true;
        const ui = anchored();
        setLockedMessages(chat, ["m6"], ["m6"]);
        ui.push({ chatId: "m6", data: "", role: "char" });
        ui.scroller.dispatchEvent(new Event("wheel"));
        ui.scroller.scrollTop = -120;
        ui.natural.set("m6", { top: -300, height: 800 });
        setLockedMessages(chat, []);
        flushSync();
        expect(ui.scroller.scrollTop).toBe(-120);
    });
});
