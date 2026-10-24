// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/ts/tokenizer", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/tokenizer")>()),
    tokenizeAccurate: vi.fn(),
}));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
// Keep the real input, but exclude highlighting, hotkeys and unrelated application effects.
vi.mock("src/ts/util", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/util")>()),
    getAuthorNoteDefaultText: () => "",
    sleep: () => Promise.resolve(),
}));
vi.mock("src/ts/hotkey", () => ({ hotkeyMatches: vi.fn(() => false) }));
vi.mock("src/ts/gui/highlight", () => ({
    highlighter: vi.fn(),
    getNewHighlightId: () => 1,
    removeHighlight: vi.fn(),
    AllCBS: [],
}));
vi.mock("src/ts/stores.svelte", async () => {
    const { writable } = await import("svelte/store");
    return (await import("src/ts/tests/storesMock")).createStoresMock({
        disableHighlight: writable(true),
        popUpEditorStore: { open: false, value: "", mode: "default", language: "markdown" },
    });
});

import { language } from "src/lang";
import { findChat, type ChatRef } from "src/ts/storage/chatStore.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { activeMainProfile } from "src/ts/storage/settingsViews.svelte";
import { tokenizeAccurate } from "src/ts/tokenizer";
import ChatNoteEditor from "./ChatNoteEditor.svelte";

const chat: ChatRef = { chaId: "c", chatId: "k" };
const mounted = new Set<ReturnType<typeof mount>>();
const tokenize = vi.mocked(tokenizeAccurate);

function renderEditor(note: string) {
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: chat.chaId,
                type: "character",
                name: "C",
                chatPage: 0,
                chats: [{ id: chat.chatId, name: "Chat K", note, localLore: [], message: [] }],
            },
        ],
    });
    activeMainProfile.modelId = "gpt-3.5-turbo";
    const target = document.createElement("div");
    document.body.appendChild(target);
    const instance = mount(ChatNoteEditor, { target, props: { chat } });
    mounted.add(instance);
    flushSync();
    return {
        tokens: () => target.querySelector("span.text-textcolor2")?.textContent?.trim(),
        edit: (text: string) => {
            const input = target.querySelector("textarea")!;
            input.value = text;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            flushSync();
            expect(findChat(chat)?.note).toBe(text);
        },
        destroy: async () => {
            await unmount(instance);
            mounted.delete(instance);
        },
    };
}

/** The browser owns idle delivery; fake timers alone must never trigger these callbacks. */
function installIdleCallbacks() {
    let nextId = 0;
    const pending = new Map<number, IdleRequestCallback>();
    const request = vi.fn((callback: IdleRequestCallback, _options?: IdleRequestOptions) => {
        const id = ++nextId;
        pending.set(id, callback);
        return id;
    });
    vi.stubGlobal("requestIdleCallback", request);
    vi.stubGlobal(
        "cancelIdleCallback",
        vi.fn((id: number) => pending.delete(id)),
    );
    return {
        request,
        fire: () => {
            for (const [id, callback] of [...pending]) {
                pending.delete(id);
                callback({ didTimeout: false, timeRemaining: () => 50 });
            }
        },
    };
}

async function settle() {
    // A few microtasks: the count resolves through the field's async scope check.
    for (let i = 0; i < 3; i++) await Promise.resolve();
    flushSync();
}

async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    flushSync();
}

function deferredCount() {
    let resolve!: (count: number) => void;
    const promise = new Promise<number>((done) => (resolve = done));
    return { promise, resolve };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    vi.stubGlobal("cancelIdleCallback", undefined);
    tokenize.mockReset().mockResolvedValue(37);
    sessionStorage.clear();
    localStorage.clear();
});

afterEach(async () => {
    await Promise.all([...mounted].map((instance) => unmount(instance)));
    mounted.clear();
    document.body.replaceChildren();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("ChatNoteEditor token counting", () => {
    it("keeps the first count idle and recounts an unchanged note after a main model change", async () => {
        const idle = installIdleCallbacks();
        tokenize.mockImplementation(async () => (activeMainProfile.modelId === "gpt4om" ? 29 : 11));
        const note = "Remember the moon.";
        const editor = renderEditor(note);
        await advance(1000);
        expect(tokenize).not.toHaveBeenCalled();
        expect(editor.tokens()).toBe(`0 ${language.tokens}`);

        idle.fire();
        await settle();
        expect(editor.tokens()).toBe(`11 ${language.tokens}`);

        activeMainProfile.modelId = "gpt4om";
        flushSync();
        await advance(400);
        expect(editor.tokens()).toBe(`29 ${language.tokens}`);
        expect(findChat(chat)?.note).toBe(note);
    });

    it("shows zero for an empty note without ever tokenizing it", async () => {
        const idle = installIdleCallbacks();
        const editor = renderEditor("");
        expect(editor.tokens()).toBe(`0 ${language.tokens}`);
        expect(tokenize).not.toHaveBeenCalled();
        idle.fire();
        await advance(3000);
        expect(editor.tokens()).toBe(`0 ${language.tokens}`);
        expect(tokenize).not.toHaveBeenCalled();
    });

    it("defers the first non-empty count to idle with a 2000 ms timeout and displays the exact result", async () => {
        const idle = installIdleCallbacks();
        const note = "  Remember the moon.\nKeep this spacing.  ";
        const editor = renderEditor(note);
        await settle();
        expect(tokenize).not.toHaveBeenCalled();
        expect(idle.request).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { timeout: 2000 });
        await advance(1000);
        expect(tokenize).not.toHaveBeenCalled();

        idle.fire();
        await settle();
        expect(tokenize).toHaveBeenCalledExactlyOnceWith(note, undefined, expect.any(AbortSignal));
        expect(editor.tokens()).toBe(`37 ${language.tokens}`);
    });

    it("falls back to a 1000 ms delay without idle callbacks, including for a whitespace-only note", async () => {
        const note = " \n ";
        const editor = renderEditor(note);
        await settle();
        expect(tokenize).not.toHaveBeenCalled();
        await advance(999);
        expect(tokenize).not.toHaveBeenCalled();
        await advance(1);
        expect(tokenize).toHaveBeenCalledExactlyOnceWith(note, undefined, expect.any(AbortSignal));
        expect(editor.tokens()).toBe(`37 ${language.tokens}`);
    });

    it("debounces later edits for 400 ms from the latest edit and counts only that text", async () => {
        const idle = installIdleCallbacks();
        tokenize.mockResolvedValueOnce(13).mockResolvedValueOnce(73);
        const editor = renderEditor("Original");
        idle.fire();
        await settle();
        expect(editor.tokens()).toBe(`13 ${language.tokens}`);

        editor.edit("Intermediate");
        await advance(399);
        expect(tokenize).toHaveBeenCalledTimes(1);
        editor.edit("Latest text");
        await advance(1);
        expect(tokenize).toHaveBeenCalledTimes(1);
        await advance(398);
        expect(tokenize).toHaveBeenCalledTimes(1);
        await advance(1);
        expect(tokenize.mock.calls.map(([text]) => text)).toEqual(["Original", "Latest text"]);
        expect(editor.tokens()).toBe(`73 ${language.tokens}`);
    });

    it("supersedes the pending first count on an edit", async () => {
        const idle = installIdleCallbacks();
        const editor = renderEditor("Before editing");
        await advance(100);
        editor.edit("After editing");
        await advance(399);
        expect(tokenize).not.toHaveBeenCalled();
        await advance(1);
        expect(tokenize).toHaveBeenCalledExactlyOnceWith("After editing", undefined, expect.any(AbortSignal));
        expect(editor.tokens()).toBe(`37 ${language.tokens}`);

        idle.fire();
        await advance(2000);
        expect(tokenize).toHaveBeenCalledOnce();
    });

    it("aborts and discards a superseded count while the replacement count is still debouncing", async () => {
        const idle = installIdleCallbacks();
        const older = deferredCount();
        tokenize.mockReturnValueOnce(older.promise).mockResolvedValueOnce(29);
        const editor = renderEditor("Older note");
        idle.fire();
        editor.edit("Current note");
        expect(tokenize).toHaveBeenCalledExactlyOnceWith("Older note", undefined, expect.any(AbortSignal));
        expect(tokenize.mock.calls[0][2]?.aborted).toBe(true);
        older.resolve(999);
        await advance(399);
        expect(editor.tokens()).toBe(`0 ${language.tokens}`);
        expect(tokenize).toHaveBeenCalledOnce();
        await advance(1);
        expect(tokenize.mock.calls.map(([text]) => text)).toEqual(["Older note", "Current note"]);
        expect(editor.tokens()).toBe(`29 ${language.tokens}`);
    });

    it.each(["idle", "fallback"] as const)(
        "never tokenizes after unmount before the first count (%s)",
        async (scheduler) => {
            const idle = scheduler === "idle" ? installIdleCallbacks() : undefined;
            const editor = renderEditor("Unmounted note");
            await advance(100);
            await editor.destroy();
            idle?.fire();
            await advance(3000);
            expect(tokenize).not.toHaveBeenCalled();
        },
    );
});
