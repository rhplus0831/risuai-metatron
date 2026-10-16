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
};
const state = vi.hoisted(() => ({ rows: [] as Row[] }));

vi.mock("./Chat.svelte", () => ({
    default: (anchor: Node, props: RowProps) => {
        const row: Row = { props, updates: [], element: anchor.parentElement!, editing: false, destroyed: false };
        row.element.dataset.messageId = props.messageId;
        state.rows.push(row);
        onDestroy(() => {
            row.destroyed = true;
        });
        return {
            updateRow: (update: Record<string, unknown>) => row.updates.push(update),
            isEditing: () => row.editing,
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

function render(input = messages(6), window = input.length) {
    const props = $state({
        messages: input,
        currentCharacter: { chaId: "c", name: "Char", image: "char.png", type: "character", largePortrait: false },
        currentUsername: "User",
        userIcon: "user.png",
        userIconPortrait: false,
        onReroll: () => {},
        unReroll: () => {},
        loadPages: window,
        suspendTrim: false,
        hasNewUnreadMessage: false,
        onTrim: undefined as undefined | ((keep: number) => number | undefined),
    });
    const scroller = document.createElement("div");
    document.body.append(scroller);
    // happy-dom has no layout and clamps scroll offsets: provide a reversed scroller explicitly.
    let scrollOffset = 0;
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
    instances.push(mount(Chats, { target: scroller, props: props as never }));
    flushSync();
    const ids = () =>
        [...scroller.querySelectorAll<HTMLElement>(".chat-message-container")].map((el) => el.dataset.messageId);
    const append = (role: "char" | "user" = "char") => {
        props.messages.push({ chatId: `m${props.messages.length}`, data: "new reply", role });
        flushSync();
    };
    return { props, scroller, ids, append, scrollRead, scrollWrite };
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
