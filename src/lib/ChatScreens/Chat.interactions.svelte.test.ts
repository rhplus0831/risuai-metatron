// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translationSourceHash } from "../../../shared/translation/hash.ts";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/process/serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock(),
);
vi.mock("src/ts/translator/translator", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/translator/translator")>()),
    translateHTML: vi.fn(async (html: string) => `<p>Translated: ${html}</p>`),
}));

import { language } from "src/lang";
import { doingAlert } from "src/ts/alert";
import { chatCheckpointsDialog } from "src/ts/checkpoints/chatCheckpoints.svelte";
import { runServerButton, runServerJob, runServerManualTrigger } from "src/ts/process/serverCommands";
import { characterList } from "src/ts/storage/characterStore.svelte";
import {
    appendMessage,
    createChat,
    findChat,
    selectChat,
    setChatMeta,
    setMessageText,
    setMessageTranslation,
    setStreamingState,
} from "src/ts/storage/chatStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import {
    bookmarkListOpen,
    chatBindingDialog,
    createSimpleCharacter,
    openModelPresetList,
    openPersonaList,
    openPresetList,
    ReloadChatPointer,
} from "src/ts/stores.svelte";
import { translateHTML } from "src/ts/translator/translator";
import BookmarkList from "../Others/BookmarkList.svelte";
import Chat from "./Chat.svelte";
import Chats from "./Chats.svelte";

const ref = { chaId: "owner", chatId: "own-chat" };
const otherRef = { chaId: "other", chatId: "other-chat" };
const mounted: ReturnType<typeof mount>[] = [];
const markup = `<input name="draft" value="initial">
    <div risu-btn="lua-action"><b>Run button</b></div>
    <span risu-trigger="manual-action"><b>Run trigger</b></span>
    <form risu-form="survey"><input name="answer" value="initial"><button>Submit</button></form>`;

function target() {
    const element = document.createElement("div");
    document.body.append(element);
    return element;
}

async function settle(ms = 0) {
    await vi.advanceTimersByTimeAsync(ms);
    flushSync();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
}

function renderChat(message = markup) {
    const element = target();
    const instance = mount(Chat, {
        target: element,
        props: {
            chatRef: ref,
            messageId: "message",
            message,
            idx: 0,
            role: "char",
            name: "Owner",
            character: createSimpleCharacter(characterList().find((character) => character.chaId === ref.chaId)),
            isLastMemory: false,
        },
    });
    mounted.push(instance);
    flushSync();
    return { element, instance };
}

function renderChats() {
    const element = target();
    const props = $state({
        messages: findChat(ref)!.message,
        currentCharacter: characterList().find((character) => character.chaId === ref.chaId)!,
        currentUsername: "User",
        userIcon: "",
        onReroll: () => {},
        unReroll: () => {},
        loadPages: 30,
        suspendTrim: false,
        hasNewUnreadMessage: false,
    });
    const instance = mount(Chats, { target: element, props });
    mounted.push(instance);
    flushSync();
    return { element, instance, props };
}

function renderBookmarks() {
    const element = target();
    bookmarkListOpen.set(true);
    mounted.push(mount(BookmarkList, { target: element }));
    flushSync();
    return element;
}

function click(element: Element, selector: string) {
    const control = element.querySelector<HTMLElement>(selector);
    expect(control).not.toBeNull();
    control!.click();
    flushSync();
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(doingAlert).mockReturnValue(false);
    vi.mocked(runServerButton).mockResolvedValue("refused");
    vi.mocked(runServerManualTrigger).mockResolvedValue("refused");
    ReloadChatPointer.set({});
    bookmarkListOpen.set(false);
    chatBindingDialog.set(null);
    chatCheckpointsDialog.set(null);
    openPresetList.set(false);
    openModelPresetList.set(false);
    openPersonaList.set(false);
    installFlatDatabaseWithChats({
        characters: [ref, otherRef].map((address) => ({
            chaId: address.chaId,
            type: "character",
            name: address.chaId,
            image: "",
            firstMessage: "Hello",
            alternateGreetings: [],
            customscript: [],
            emotionImages: [],
            additionalAssets: [],
            triggerscript: [],
            chats: [
                {
                    id: address.chatId,
                    name: address.chatId,
                    note: "",
                    localLore: [],
                    message: [{ role: "char", chatId: "message", data: markup }],
                },
            ],
        })),
        personas: [],
        translator: "",
        theme: "standard",
        zoomsize: 100,
        lineHeight: 1.25,
        iconsize: 100,
        clickToEdit: false,
        enableBlockPartialEdit: false,
        enableDragPartialEdit: false,
        autoScrollToNewMessage: false,
        alwaysScrollToNewMessage: false,
    });
    selectChat(ref.chaId, ref.chatId);
    selectChat(otherRef.chaId, otherRef.chatId);
    selectCharacter(ref.chaId);
});

afterEach(async () => {
    for (const instance of mounted.splice(0)) await unmount(instance);
    setStreamingState(ref, null);
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("chat message interactions", () => {
    it("sends a mounted row's button, manual trigger, and form to its owning chat after selection changes", async () => {
        const nextChat = createChat(otherRef.chaId, { ...findChat(otherRef)!, id: "next-chat" });
        selectChat(otherRef.chaId, otherRef.chatId);
        selectCharacter(otherRef.chaId);
        const { element, instance } = renderChats();
        await settle(10);
        await instance.whenRendered();
        const row = element.querySelector(".chat-message-container");

        selectChat(otherRef.chaId, nextChat.id);
        flushSync();
        await settle(10);
        await instance.whenRendered();
        expect(element.querySelector(".chat-message-container")).toBe(row);
        const form = element.querySelector<HTMLFormElement>("form[risu-form]")!;
        form.querySelector<HTMLInputElement>("input")!.value = "my answer";
        click(element, "[risu-btn] b");
        click(element, "[risu-trigger] b");
        form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
        await settle();

        expect(runServerButton).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ chaId: ref.chaId }),
            "lua-action",
            ref,
        );
        expect(runServerManualTrigger).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ chaId: ref.chaId }),
            "manual-action",
            ref,
            expect.anything(),
        );
        expect(runServerJob).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ chaId: ref.chaId }),
            ref,
            expect.objectContaining({ command: { type: "form", key: "survey", values: { answer: "my answer" } } }),
        );
    });

    it("keeps typed input after a refused Lua button and reloads the row after a started button", async () => {
        const { element, instance } = renderChats();
        await settle(10);
        await instance.whenRendered();
        const input = element.querySelector<HTMLInputElement>('input[name="draft"]')!;
        input.value = "keep my typing";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        for (const outcome of ["refused", "followed", "unknown"] as const) {
            vi.mocked(runServerButton).mockResolvedValueOnce(outcome);
            click(element, "[risu-btn]");
            await settle(10);
            await instance.whenRendered();
            expect(element.querySelector<HTMLInputElement>('input[name="draft"]')?.value, outcome).toBe(
                "keep my typing",
            );
            expect(element.querySelector('input[name="draft"]'), outcome).toBe(input);
        }
        expect(runServerButton).toHaveBeenCalledTimes(3);

        vi.mocked(runServerButton).mockResolvedValueOnce("started");
        click(element, "[risu-btn]");
        await settle(10);
        await instance.whenRendered();
        expect(runServerButton).toHaveBeenCalledTimes(4);
        const replacement = element.querySelector<HTMLInputElement>('input[name="draft"]');
        expect(replacement).not.toBe(input);
        expect(replacement?.value).toBe("initial");
    });

    it("runs div buttons and span triggers without opening the click-to-edit message editor", async () => {
        settings.ui.clickToEdit = true;
        const { element, instance } = renderChat();
        await settle(10);
        await instance.whenRendered();
        click(element, "div[risu-btn] b");
        await settle();
        expect(runServerButton).toHaveBeenCalledTimes(1);
        expect(element.querySelector(".message-edit-area")).toBeNull();
        click(element, "span[risu-trigger] b");
        await settle();
        expect(runServerManualTrigger).toHaveBeenCalledTimes(1);
        expect(element.querySelector(".message-edit-area")).toBeNull();
    });

    it("cancels pending auto-scroll and marks appended replies unread while a jump owns scrolling", async () => {
        settings.ui.autoScrollToNewMessage = true;
        settings.ui.alwaysScrollToNewMessage = true;
        const { element, props, instance } = renderChats();
        await settle(10);
        await instance.whenRendered();
        const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
        appendMessage(ref, { chatId: "before-jump", role: "char", data: "Before the jump" });
        flushSync();

        props.suspendTrim = true;
        flushSync();
        element.scrollTop = -200;
        await settle(1000);
        expect(scroll).not.toHaveBeenCalled();
        expect(element.scrollTop).toBe(-200);

        appendMessage(ref, { chatId: "during-jump", role: "char", data: "During the jump" });
        flushSync();
        await settle(1000);
        expect(scroll).not.toHaveBeenCalled();
        expect(element.scrollTop).toBe(-200);
        expect(props.hasNewUnreadMessage).toBe(true);

        props.suspendTrim = false;
        flushSync();
        appendMessage(ref, { chatId: "after-jump", role: "char", data: "After the jump" });
        flushSync();
        await settle(1000);
        expect(scroll).toHaveBeenCalledOnce();
    });
});

describe("bookmark list interactions", () => {
    it("keeps bookmarks open on Escape under an alert, picker, binding dialog, or checkpoints dialog", () => {
        const element = renderBookmarks();
        const escape = () => {
            element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
            flushSync();
        };
        const layers: [string, (open: boolean) => unknown][] = [
            ["alert", (open) => vi.mocked(doingAlert).mockReturnValue(open)],
            ["prompt preset picker", (open) => openPresetList.set(open)],
            ["model preset picker", (open) => openModelPresetList.set(open)],
            ["persona picker", (open) => openPersonaList.set(open)],
            ["chat binding dialog", (open) => chatBindingDialog.set(open ? ref : null)],
            ["checkpoints dialog", (open) => chatCheckpointsDialog.set(open ? ref : null)],
        ];
        for (const [name, layer] of layers) {
            layer(true);
            escape();
            expect(get(bookmarkListOpen), name).toBe(true);
            layer(false);
        }
        escape();
        expect(get(bookmarkListOpen)).toBe(false);
    });

    it("shows streaming bookmark chunks without auto-translating until the stream ends", async () => {
        settings.memoryTranslateMedia.translatorType = "llm";
        settings.memoryTranslateMedia.translator = "ko";
        settings.memoryTranslateMedia.llmTranslationTarget = "message";
        settings.memoryTranslateMedia.autoTranslateCachedOnly = false;
        setChatMeta(ref, { bookmarks: ["message"], autoTranslate: true });
        const chunk = (text: string) => {
            setMessageText(ref, "message", text);
            setMessageTranslation(ref, "message", {
                text: "Stored translation",
                sourceHash: translationSourceHash(text),
                targetLanguage: "ko",
                translatedAt: 1,
            });
        };
        chunk("First chunk");
        setStreamingState(ref, { messageId: "message", mode: "off" });
        const element = renderBookmarks();
        click(element, `button[title="${language.expandAll}"]`);
        await settle(1000);
        expect(element.querySelector(".chattext")?.textContent).toContain("First chunk");
        expect(translateHTML).not.toHaveBeenCalled();

        chunk("Final chunk");
        flushSync();
        await settle(1000);
        expect(element.querySelector(".chattext")?.textContent).toContain("Final chunk");
        expect(translateHTML).not.toHaveBeenCalled();

        setStreamingState(ref, null);
        flushSync();
        await settle(1000);
        expect(translateHTML).toHaveBeenCalledOnce();
        expect(element.querySelector(".chattext")?.textContent).toContain("Translated:");
    });
});
