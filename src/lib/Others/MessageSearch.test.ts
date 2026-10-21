// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The message search panel over a mocked `searchMessages` (fake timers): the debounce and Enter,
// superseded requests aborted and their answers ignored, "Load more" with the captured query and
// scope and the dedupe (across and within pages), the automatic re-asks (five per action), the 409
// restart (dedupe reset, re-ask budget kept, a second 409 is an error), the snippet as text with a
// `<mark>`, opening a hit, an interrupted search resumed on reopen, Escape.

const mocks = vi.hoisted(() => ({
    searchMessages: vi.fn(),
    openPinnedChat: vi.fn(),
    alertNormal: vi.fn(),
    doingAlert: vi.fn(() => false),
}));

vi.mock("src/ts/alert", async () => ({
    terminalNotice: (await import("svelte/store")).writable<string | null>(null),
    doingAlert: mocks.doingAlert,
    alertNormal: mocks.alertNormal,
    alertError: vi.fn(),
    alertConfirm: vi.fn(async () => true),
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    alertSelect: vi.fn(),
    alertToast: vi.fn(),
    alertMd: vi.fn(),
    alertStore: { set: vi.fn(), subscribe: vi.fn(() => () => {}) },
}));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/parser/transformClient", () => ({
    resetTransformEffects: vi.fn(),
    captureTransform: vi.fn(),
    serverProcessScript: vi.fn(),
}));
vi.mock("src/ts/globalApi.svelte", () => ({
    openPinnedChat: mocks.openPinnedChat,
    downloadFile: vi.fn(),
    saveAsset: vi.fn(),
    changeChatTo: vi.fn(),
    createChatCopyName: vi.fn(),
}));
vi.mock("src/ts/messageSearch.svelte", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/messageSearch.svelte")>()),
    searchMessages: mocks.searchMessages,
}));

import { language } from "src/lang";
import {
    cancelMessageJump,
    closeMessageSearch,
    messageSearchPanel,
    openMessageSearch,
    pendingMessageJump,
    type MessageSearchResult,
    type MessageSearchScope,
} from "src/ts/messageSearch.svelte";
import { gridOpenStore } from "src/ts/stores.svelte";
import { chatEntry, selectChat, type ChatRef } from "src/ts/storage/chatStore.svelte";
import { selectCharacter, setChatOpen } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import type { MessageSearchHit } from "../../../shared/messageSearch.ts";
import MessageSearch from "./MessageSearch.svelte";

type Call = {
    query: string;
    scope: MessageSearchScope;
    cursor: string | undefined;
    signal: AbortSignal | undefined;
    resolve: (result: MessageSearchResult) => void;
};
const calls: Call[] = [];
const mounted: ReturnType<typeof mount>[] = [];
/** What a bubbling document listener (the global hotkey handler's phase) sees. */
const bubbled = vi.fn();

const hit = (messageId: string, overrides: Partial<MessageSearchHit> = {}): MessageSearchHit => ({
    characterId: "c",
    chatId: "k",
    messageId,
    chatName: "Chat K",
    characterName: "C",
    role: "char",
    snippet: `hello ${messageId}`,
    matchStart: 0,
    matchLength: 5,
    ...overrides,
});
const page = (hits: MessageSearchHit[], next: string | null): MessageSearchResult => ({
    kind: "page",
    page: { hits, next, scannedBytes: 0 },
});
const EPOCH: MessageSearchResult = { kind: "epoch" };

/** Runs the pending microtasks (a resolved request's continuation) and renders. */
async function settle() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    flushSync();
}
async function answer(index: number, result: MessageSearchResult) {
    calls[index].resolve(result);
    await settle();
}

const panel = () => document.querySelector<HTMLElement>("[data-message-search]");
const field = () => panel()!.querySelector("input")!;
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-message-search-hit]")];
const more = () => document.querySelector<HTMLButtonElement>("[data-message-search-more]");
const scopeButton = (label: string) =>
    [...panel()!.querySelectorAll<HTMLButtonElement>('[role="group"] button')].find(
        (button) => button.textContent?.trim() === label,
    )!;
function type(text: string) {
    const input = field();
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
}
const key = (name: string) => new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });

function render(scope: MessageSearchScope = { kind: "all" }) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(MessageSearch, { target }));
    openMessageSearch(scope);
    flushSync();
    expect(panel()).not.toBeNull();
}

/** The search for `text`, typed and debounced: its first request is `calls[0]` and still pending. */
function search(text: string) {
    type(text);
    vi.advanceTimersByTime(300);
    expect(calls).toHaveLength(1);
}

beforeEach(() => {
    vi.useFakeTimers();
    calls.length = 0;
    mocks.searchMessages.mockReset();
    mocks.searchMessages.mockImplementation(
        (query: string, scope: MessageSearchScope, cursor: string | undefined, signal: AbortSignal | undefined) =>
            new Promise<MessageSearchResult>((resolve) => {
                calls.push({ query, scope, cursor, signal, resolve });
            }),
    );
    mocks.openPinnedChat.mockReset();
    mocks.openPinnedChat.mockImplementation((ref: ChatRef) => {
        if (!chatEntry(ref)) return;
        selectChat(ref.chaId, ref.chatId);
        selectCharacter(ref.chaId);
        setChatOpen(true);
    });
    mocks.alertNormal.mockClear();
    mocks.doingAlert.mockReturnValue(false);
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "C",
                firstMessage: "Hello",
                chatPage: 0,
                chats: [
                    {
                        id: "k",
                        name: "Chat K",
                        note: "",
                        localLore: [],
                        message: [{ role: "char", data: "hello m1", chatId: "m1" }],
                    },
                ],
            },
        ],
    } as any);
    selectCharacter(null);
    gridOpenStore.set(false);
    messageSearchPanel.open = false;
    messageSearchPanel.scope = { kind: "all" };
    document.addEventListener("keydown", bubbled);
});

afterEach(async () => {
    document.removeEventListener("keydown", bubbled);
    bubbled.mockClear();
    closeMessageSearch();
    const pending = pendingMessageJump();
    if (pending) cancelMessageJump(pending.token);
    selectCharacter(null);
    flushSync();
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
    vi.useRealTimers();
});

describe("the query", () => {
    it("runs 300 ms after typing stops, at once on Enter, and not for a too-short text", () => {
        render();
        type("he");
        vi.advanceTimersByTime(200);
        type("hel");
        vi.advanceTimersByTime(299);
        expect(calls).toHaveLength(0);
        vi.advanceTimersByTime(1);
        flushSync();
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ query: "hel", scope: { kind: "all" }, cursor: undefined });
        expect(panel()!.textContent).toContain(language.messageSearch.searching);

        type("a");
        expect(calls[0].signal?.aborted).toBe(true);
        expect(panel()!.textContent).toContain(language.messageSearch.tooShort(2));
        vi.advanceTimersByTime(300);
        expect(calls).toHaveLength(1);

        type(" abc ");
        field().dispatchEvent(key("Enter"));
        flushSync();
        expect(calls).toHaveLength(2);
        expect(calls[1].query).toBe("abc");
        vi.advanceTimersByTime(300);
        expect(calls).toHaveLength(2);
    });

    it("aborts a superseded request and ignores its answer, also one arriving in the next debounce window", async () => {
        render();
        search("abc");
        type("abcd");
        expect(calls[0].signal?.aborted).toBe(true);
        await answer(0, page([hit("m1")], "c1"));
        expect(rows()).toHaveLength(0);
        expect(more()).toBeNull();
        expect(panel()!.textContent).not.toContain(language.messageSearch.empty);

        vi.advanceTimersByTime(300);
        expect(calls).toHaveLength(2);
        expect(calls[1].query).toBe("abcd");
        await answer(1, page([hit("m2")], null));
        expect(rows().map((row) => row.textContent)).toEqual([expect.stringContaining("hello m2")]);
    });
});

describe("paging", () => {
    it("appends the next page for the shown query and scope, dropping hits repeated across and within pages", async () => {
        render({ kind: "character", chaId: "c" });
        search("abc");
        await answer(0, page([hit("m1"), hit("m2")], "c1"));
        expect(rows()).toHaveLength(2);
        expect(more()).not.toBeNull();

        more()!.click();
        flushSync();
        expect(calls).toHaveLength(2);
        expect(calls[1]).toMatchObject({ query: "abc", scope: { kind: "character", chaId: "c" }, cursor: "c1" });
        expect(more()).toBeNull();
        expect(panel()!.textContent).toContain(language.messageSearch.searching);

        await answer(1, page([hit("m2"), hit("m3"), hit("m3"), hit("m2", { chatId: "other" })], "c2"));
        expect(rows().map((row) => row.textContent?.trim())).toEqual([
            expect.stringContaining("hello m1"),
            expect.stringContaining("hello m2"),
            expect.stringContaining("hello m3"),
            expect.stringContaining("hello m2"),
        ]);
        expect(more()).not.toBeNull();
    });

    it("offers Load more only while the field still shows the results' query, keeping the draft's debounce", async () => {
        render();
        search("abc");
        await answer(0, page([hit("m1")], "c1"));
        expect(more()).not.toBeNull();

        type("abcd");
        expect(more()).toBeNull();
        expect(rows()).toHaveLength(1);
        expect(calls).toHaveLength(1);
        vi.advanceTimersByTime(300);
        expect(calls).toHaveLength(2);
        expect(calls[1]).toMatchObject({ query: "abcd", cursor: undefined });
    });

    it("re-asks an empty page with a next up to five times per action, then offers Load more with a fresh budget", async () => {
        render();
        search("abc");
        for (let i = 0; i < 6; i++) {
            expect(calls).toHaveLength(i + 1);
            expect(calls[i].cursor).toBe(i === 0 ? undefined : `c${i}`);
            await answer(i, page([], `c${i + 1}`));
        }
        expect(calls).toHaveLength(6);
        expect(more()).not.toBeNull();
        expect(panel()!.textContent).not.toContain(language.messageSearch.empty);

        more()!.click();
        flushSync();
        expect(calls).toHaveLength(7);
        expect(calls[6].cursor).toBe("c6");
        await answer(6, page([], "c7"));
        expect(calls).toHaveLength(8);
        await answer(7, page([], null));
        expect(calls).toHaveLength(8);
        expect(more()).toBeNull();
        expect(panel()!.textContent).toContain(language.messageSearch.empty);
    });

    it("restarts once on a 409 from the first page with the dedupe reset and the re-asks left, then errors", async () => {
        render();
        search("abc");
        await answer(0, page([hit("m1")], "c1"));
        more()!.click();
        flushSync();
        expect(calls[1].cursor).toBe("c1");
        await answer(1, EPOCH);
        expect(calls).toHaveLength(3);
        expect(calls[2].cursor).toBeUndefined();
        expect(rows()).toHaveLength(0);
        // The same hit again after the restart: shown, not dropped as a repeat.
        await answer(2, page([hit("m1")], "c2"));
        expect(rows()).toHaveLength(1);

        // One action: two re-asks, a 409 restart, then only the three re-asks left (not five more).
        more()!.click();
        flushSync();
        await answer(3, page([], "c3"));
        await answer(4, page([], "c4"));
        await answer(5, EPOCH);
        expect(calls).toHaveLength(7);
        expect(calls[6].cursor).toBeUndefined();
        expect(rows()).toHaveLength(0);
        await answer(6, page([], "d1"));
        await answer(7, page([], "d2"));
        await answer(8, page([], "d3"));
        expect(calls).toHaveLength(10);
        await answer(9, page([], "d4"));
        expect(calls).toHaveLength(10);
        expect(more()).not.toBeNull();

        more()!.click();
        flushSync();
        await answer(10, EPOCH);
        expect(calls).toHaveLength(12);
        await answer(11, EPOCH);
        expect(calls).toHaveLength(12);
        expect(panel()!.textContent).toContain(language.messageSearch.error(language.messageSearch.dataChanged));
        expect(more()).toBeNull();
    });

    it("shows a failed request as an error state", async () => {
        render();
        search("abc");
        await answer(0, { kind: "error", message: "HTTP 503" });
        expect(panel()!.querySelector('[role="alert"]')?.textContent).toBe(language.messageSearch.error("HTTP 503"));
        expect(rows()).toHaveLength(0);
    });
});

describe("the rows", () => {
    it("renders the snippet as text around a mark, clamped to the snippet; HTML in it stays text", async () => {
        render();
        search("img");
        const snippet = 'see <img src=x onerror="alert(1)"> now';
        await answer(
            0,
            page(
                [
                    hit("m1", { snippet, matchStart: 4, matchLength: 4, characterName: "<b>C</b>" }),
                    hit("m2", { snippet: "short", matchStart: 100, matchLength: 5 }),
                ],
                null,
            ),
        );
        const [first, second] = rows();
        expect(first.querySelector("img")).toBeNull();
        expect(first.querySelector("b")).toBeNull();
        expect(first.textContent).toContain("<b>C</b>");
        const marked = first.querySelector("[data-message-search-snippet]")!;
        expect(marked.textContent).toBe(snippet);
        expect(marked.children).toHaveLength(1);
        expect(marked.querySelector("mark")!.textContent).toBe("<img");
        expect(second.querySelector("[data-message-search-snippet]")!.textContent).toBe("short");
        expect(second.querySelector("mark")!.textContent).toBe("");
    });

    it("opening a hit closes the panel, leaves the catalog, opens the chat and requests the jump", async () => {
        render();
        gridOpenStore.set(true);
        search("abc");
        await answer(0, page([hit("m1")], null));
        rows()[0].click();
        expect(get(gridOpenStore)).toBe(false);
        expect(mocks.openPinnedChat).toHaveBeenCalledWith({ chaId: "c", chatId: "k" });
        expect(pendingMessageJump()).toMatchObject({
            ref: { chaId: "c", chatId: "k" },
            messageId: "m1",
            state: "pending",
        });
        expect(mocks.alertNormal).not.toHaveBeenCalled();
        flushSync();
        expect(messageSearchPanel.open).toBe(false);
        expect(panel()).toBeNull();
    });

    it("opening a hit whose chat is gone alerts instead of requesting a jump", async () => {
        render();
        search("abc");
        await answer(0, page([hit("m1", { chatId: "gone" })], null));
        rows()[0].click();
        expect(mocks.openPinnedChat).toHaveBeenCalledWith({ chaId: "c", chatId: "gone" });
        expect(pendingMessageJump()).toBeNull();
        expect(mocks.alertNormal).toHaveBeenCalledWith(language.messageSearch.chatGone);
    });
});

describe("the panel", () => {
    it("resumes an interrupted search on reopen, keeps finished results, and searches again for another scope", async () => {
        render();
        search("needle");
        type("needle ");
        expect(calls[0].signal?.aborted).toBe(true);
        closeMessageSearch();
        flushSync();
        vi.advanceTimersByTime(300);
        expect(calls).toHaveLength(1);

        openMessageSearch({ kind: "all" });
        flushSync();
        expect(calls).toHaveLength(2);
        expect(calls[1]).toMatchObject({ query: "needle", scope: { kind: "all" }, cursor: undefined });
        await answer(1, page([hit("m1")], null));
        expect(rows()).toHaveLength(1);

        closeMessageSearch();
        flushSync();
        openMessageSearch({ kind: "all" });
        flushSync();
        expect(calls).toHaveLength(2);
        expect(rows()).toHaveLength(1);

        expect(scopeButton(language.messageSearch.scopeChat).disabled).toBe(true);
        openMessageSearch({ kind: "character", chaId: "c" });
        flushSync();
        expect(calls).toHaveLength(3);
        expect(calls[2]).toMatchObject({ query: "needle", scope: { kind: "character", chaId: "c" } });
        expect(rows()).toHaveLength(0);

        selectChat("c", "k");
        selectCharacter("c");
        flushSync();
        expect(scopeButton(language.messageSearch.scopeChat).disabled).toBe(false);
        scopeButton(language.messageSearch.scopeChat).click();
        flushSync();
        expect(calls).toHaveLength(4);
        expect(calls[3].scope).toEqual({ kind: "chat", ref: { chaId: "c", chatId: "k" } });
    });

    it("closes on Escape before the bubbling listener, and yields to an alert above it", () => {
        render();
        const event = key("Escape");
        field().dispatchEvent(event);
        flushSync();
        expect(messageSearchPanel.open).toBe(false);
        expect(event.defaultPrevented).toBe(true);
        expect(bubbled).not.toHaveBeenCalled();

        openMessageSearch({ kind: "all" });
        flushSync();
        mocks.doingAlert.mockReturnValue(true);
        field().dispatchEvent(key("Escape"));
        flushSync();
        expect(messageSearchPanel.open).toBe(true);
        expect(bubbled).toHaveBeenCalledTimes(1);
    });
});
