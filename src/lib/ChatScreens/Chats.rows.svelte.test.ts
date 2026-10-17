// @vitest-environment happy-dom

import { flushSync, mount, onDestroy, unmount } from "svelte";
import { writable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_ROW_CAP } from "../../../shared/chatLoadPages.ts";

type Message = { chatId: string; data: string; role: "char" | "user"; disabled?: boolean };
type RowProps = { messageId: string; message: string; idx: number; name: string; largePortrait: boolean };
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
        ui: { autoScrollToNewMessage: false, alwaysScrollToNewMessage: false, chatLoadAdditionalPages: 15 },
    });
    return { settings };
});
vi.mock("src/ts/characters", () => ({ getCharImage: vi.fn((path: string) => `image:${path}`) }));
vi.mock("src/ts/stores.svelte", () => ({
    createSimpleCharacter: vi.fn(() => ({})),
    ReloadChatPointer: writable({}),
    reloadChatKey: (id: string | undefined, idx: number) => (id !== undefined ? `m:${id}` : `i:${idx}`),
}));
vi.mock("src/ts/storage/chatStore.svelte", () => {
    const selection = $state({ chaId: "c", chatId: "chat" });
    const streamingState = $state({ chaId: null, chatId: null, messageId: null, mode: "off" });
    return {
        currentChatRef: () => selection,
        selectedChatId: () => selection.chatId,
        streamingState,
    };
});
vi.mock("src/ts/globalApi.svelte", () => {
    const chatFoldedStateMessageIndex = $state({ index: -1 });
    return { chatFoldedStateMessageIndex };
});

import { chatFoldedStateMessageIndex as folded } from "src/ts/globalApi.svelte";
import { currentChatRef, streamingState } from "src/ts/storage/chatStore.svelte";
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
const instances: ReturnType<typeof mount>[] = [];
const messages = (count: number): Message[] =>
    Array.from({ length: count }, (_, i) => ({ chatId: `m${i}`, data: `text ${i}`, role: i % 2 ? "user" : "char" }));
const latest = (id: string) => state.rows.filter((row) => row.props.messageId === id).at(-1)!;
const clearUpdates = () =>
    state.rows.forEach((row) => {
        row.updates.length = 0;
    });
const rect = (top: number, bottom: number) => new DOMRect(0, top, 300, bottom - top);

function render(input = messages(6), window = input.length, options = { suspendTrim: false, scrollTop: 0 }) {
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
        clientHeight: { value: 400 },
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
    Object.assign(streamingState, { chaId: null, chatId: null, messageId: null, mode: "off" });
    Object.assign(currentChatRef()!, { chaId: "c", chatId: "chat" });
    Object.assign(settings.ui, {
        autoScrollToNewMessage: false,
        alwaysScrollToNewMessage: false,
        chatLoadAdditionalPages: 15,
    });
    folded.index = -1;
    ReloadChatPointer.set({});
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
    it.each(["off", "balanced", "strong"] as const)("isolates streamed chunks with mode %s", (mode) => {
        Object.assign(streamingState, { chaId: "c", chatId: "chat", messageId: "m4", mode });
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
        await vi.waitFor(() => expect(retired.every((row) => row.destroyed)).toBe(true));
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
