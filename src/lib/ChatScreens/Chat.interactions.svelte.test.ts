// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translationSourceHash } from "../../../shared/translation/hash.ts";
import type { MemoryReceipt } from "../../../shared/structuredMemory.ts";
import type { TransformRequest } from "../../../shared/transform.ts";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/process/serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock(),
);
vi.mock("src/ts/translator/translator", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/translator/translator")>()),
    translateHTML: vi.fn(async (html: string) => `<p>Translated: ${html}</p>`),
}));

import { language } from "src/lang";
import { alertToast, doingAlert } from "src/ts/alert";
import { chatFoldedStateMessageIndex, foldChatToMessage } from "src/ts/globalApi.svelte";
import { displaySettingsItems } from "src/ts/setting/displaySettingsData.svelte";
import { captureTransform, rerenderMessage, serverProcessScript } from "src/ts/parser/transformClient";
import * as serverAuth from "src/ts/storage/serverAuth";
import * as diagnostics from "src/ts/diagnostics/collector";
import { chatCheckpointsDialog } from "src/ts/checkpoints/chatCheckpoints.svelte";
import { runServerButton, runServerJob, runServerManualTrigger } from "src/ts/process/serverCommands";
import { characterList, updateCharacter } from "src/ts/storage/characterStore.svelte";
import {
    appendMessage,
    createChat,
    findChat,
    patchMessage,
    selectChat,
    seedChats,
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

function renderChat(message = markup, row: { messageId?: string; idx?: number } = {}) {
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
            ...row,
        },
    });
    mounted.push(instance);
    flushSync();
    return {
        element,
        instance,
        remove: async () => {
            mounted.splice(mounted.indexOf(instance), 1);
            await unmount(instance);
            element.remove();
        },
    };
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
    seedChats([], []);
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
        personas: [{ id: "persona", name: "User", personaPrompt: "", icon: "" }],
        botPresets: [{ id: "preset", name: "Preset" }],
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
    // Resets the page-visibility mirror and drains pending display transform retries between tests.
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("online"));
    flushSync();
    vi.clearAllTimers();
    vi.useRealTimers();
});

describe("chat message interactions", () => {
    const memory: MemoryReceipt = { state: "recorded", pages: [], refused: [], unverified: [], warnings: [] };

    it("hides the model button for a receipt-only generation info and keeps it for a model", async () => {
        updateCharacter(ref.chaId, { supaMemory: true });
        settings.ui.memoryAlgorithmType = "structuredMemory";
        settings.ui.requestInfoInsideChat = true;
        patchMessage(ref, "message", { generationInfo: { memory } });
        const { element: transcript, instance } = renderChats();
        await settle(10);
        await instance.whenRendered();
        const element = transcript.querySelector('[data-chat-id="message"]')!;
        const buttonLabels = () => [...element.querySelectorAll("button")].map((button) => button.textContent?.trim());
        expect(element.querySelector("[data-memory-receipt]")?.textContent).toContain("Recorded");
        expect(buttonLabels()).not.toContain("Unknown");
        expect(buttonLabels()).not.toContain("GPT-4o");

        patchMessage(ref, "message", { generationInfo: { memory, model: "gpt4o" } });
        flushSync();
        await instance.whenRendered();
        expect(buttonLabels()).toContain("GPT-4o");
    });

    it.each(["mobilechat", "cardboard"])("shows a receipt-only footer in the %s theme", async (theme) => {
        updateCharacter(ref.chaId, { supaMemory: true });
        settings.ui.memoryAlgorithmType = "structuredMemory";
        settings.ui.requestInfoInsideChat = true;
        settings.memoryTranslateMedia.translatorType = "llm";
        settings.memoryTranslateMedia.translator = "ko";
        settings.memoryTranslateMedia.llmTranslationTarget = "message";
        setChatMeta(ref, { autoTranslate: true });
        patchMessage(ref, "message", { generationInfo: { memory, model: "gpt4o" } });
        setMessageTranslation(ref, "message", {
            text: "Stored translation",
            sourceHash: translationSourceHash(markup),
            targetLanguage: "ko",
            translatedAt: 1,
        });
        const { element: transcript, instance } = renderChats();
        await settle(10);
        await instance.whenRendered();
        const element = transcript.querySelector('[data-chat-id="message"]')!;
        const buttonLabels = () => [...element.querySelectorAll("button")].map((button) => button.textContent?.trim());
        expect(buttonLabels()).toContain("GPT-4o");
        expect(buttonLabels()).toContain(language.retranslate);
        expect(buttonLabels()).toContain(language.editTranslation);

        settings.ui.theme = theme;
        flushSync();
        await settle(10);
        await instance.whenRendered();
        const receipts = element.querySelectorAll("[data-memory-receipt]");
        expect(receipts).toHaveLength(1);
        expect(receipts[0].textContent).toContain("Recorded");
        expect(
            element.querySelector(".chattext")!.compareDocumentPosition(receipts[0]) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(buttonLabels()).not.toContain("GPT-4o");
        expect(buttonLabels()).not.toContain("Unknown");
        expect(buttonLabels()).not.toContain(language.retranslate);
        expect(buttonLabels()).not.toContain(language.editTranslation);
    });

    it("shows memory receipts only when Structured Memory is selected for the live assistant row", async () => {
        updateCharacter(ref.chaId, { supaMemory: true });
        settings.ui.memoryAlgorithmType = "structuredMemory";
        const { element, instance } = renderChat();
        await settle(10);
        await instance.whenRendered();
        expect(element.querySelectorAll("[data-memory-receipt]")).toHaveLength(1);

        for (const algorithm of ["none", "supaMemory", "hypaV2", "hanuraiMemory", "hypaV3"]) {
            settings.ui.memoryAlgorithmType = algorithm;
            flushSync();
            expect(element.querySelector("[data-memory-receipt]"), algorithm).toBeNull();
        }
    });

    it("switches from a folded chat with no stale fold index and opens the next chat's full window", async () => {
        appendMessage(ref, { chatId: "a-last", role: "char", data: "A last" });
        const next = createChat(ref.chaId, {
            ...findChat(ref)!,
            id: "next-chat",
            // Copied chats share message ids; leaking this fold at index 1 would hide b-last.
            message: ["b-first", "message", "b-last"].map((id) => ({ chatId: id, role: "char", data: id })),
        });
        const { element, props, instance } = renderChats();
        foldChatToMessage("message");
        flushSync();
        expect(chatFoldedStateMessageIndex.index).toBe(0);
        expect(element.querySelectorAll(".chat-message-container")).toHaveLength(1);

        selectChat(ref.chaId, next.id!);
        // No flush or await: opening the next transcript must never read the old fold.
        expect(chatFoldedStateMessageIndex.index).toBe(-1);
        props.messages = next.message;
        const observer = new MutationObserver(() => {});
        observer.observe(element, { childList: true, subtree: true });
        flushSync();
        const inserted = observer
            .takeRecords()
            .flatMap((record) => [...record.addedNodes])
            .filter(
                (node): node is HTMLElement => node instanceof HTMLElement && node.matches(".chat-message-container"),
            );
        observer.disconnect();
        expect(inserted.map((row) => row.querySelector<HTMLElement>(".risu-chat")?.dataset.chatId).sort()).toEqual([
            "b-first",
            "b-last",
            "message",
        ]);
        await settle(10);
        await instance.whenRendered();
        expect(element.textContent).toContain("b-first");
        expect(element.textContent).toContain("b-last");
    });

    it("draws the configured memory limit only on the transcript's lastMemory row and explains the setting", async () => {
        appendMessage(ref, { chatId: "newer", role: "char", data: "Newer" });
        setChatMeta(ref, { lastMemory: "message" });
        settings.ui.showMemoryLimit = true;
        settings.ui.memoryLimitThickness = 3;
        const { element } = renderChats();
        const preview = renderChat().element;
        await settle(10);
        const row = (id: string) => element.querySelector<HTMLElement>(`.risu-chat[data-chat-id="${id}"]`)!;
        expect(row("message").style.borderTopWidth).toBe("3px");
        expect(row("newer").style.borderTopWidth).toBe("");
        expect(preview.querySelector<HTMLElement>(".risu-chat")!.style.borderTopWidth).toBe("");

        settings.ui.memoryLimitThickness = 7;
        setChatMeta(ref, { lastMemory: "newer" });
        flushSync();
        expect(row("message").style.borderTopWidth).toBe("");
        expect(row("newer").style.borderTopWidth).toBe("7px");
        settings.ui.showMemoryLimit = false;
        flushSync();
        expect(row("message").style.borderTopWidth).toBe("");
        expect(row("newer").style.borderTopWidth).toBe("");
        const helpKey = displaySettingsItems.find((item) => item.id === "display.showMemoryLimit")?.helpKey;
        expect(helpKey).toEqual(expect.any(String));
        expect(language.help[helpKey as keyof typeof language.help]?.trim()).toBeTruthy();
    });

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

    it("leaves the scroll position to a jump and marks appended replies unread while it owns scrolling", async () => {
        settings.ui.autoScrollToNewMessage = true;
        settings.ui.alwaysScrollToNewMessage = true;
        const { element, props, instance } = renderChats();
        await settle(10);
        await instance.whenRendered();
        // happy-dom has no layout: every row sits 50px from the top of the page and is 400px tall,
        // and the scroller starts at 100px.
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
            return this === element ? new DOMRect(0, 100, 300, 400) : new DOMRect(0, 50, 300, 400);
        });
        appendMessage(ref, { chatId: "before-jump", role: "char", data: "Before the jump" });
        flushSync();
        // The reversed scroller moves up by the 50px the new reply's top sits above it.
        expect(element.scrollTop).toBe(-50);

        props.suspendTrim = true;
        flushSync();
        element.scrollTop = -200;
        await settle(1000);
        expect(element.scrollTop).toBe(-200);

        appendMessage(ref, { chatId: "during-jump", role: "char", data: "During the jump" });
        flushSync();
        await settle(1000);
        expect(element.scrollTop).toBe(-200);
        expect(props.hasNewUnreadMessage).toBe(true);

        props.suspendTrim = false;
        flushSync();
        appendMessage(ref, { chatId: "after-jump", role: "char", data: "After the jump" });
        flushSync();
        expect(element.scrollTop).toBe(-250);
    });
});

describe("display transform recovery", () => {
    let requests: TransformRequest[];
    let respond: (body: TransformRequest) => Response | Promise<Response>;
    const success = (body: TransformRequest) =>
        Response.json({
            results: body.targets.map((target) => ({
                id: target.id,
                ok: true,
                text: `Rendered: ${target.source}`,
                emotions: [],
                key: target.id,
                cached: false,
            })),
        });
    const setVisible = (visible: boolean) => {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue(visible ? "visible" : "hidden");
        document.dispatchEvent(new Event("visibilitychange"));
        flushSync();
    };
    const generation = () => captureTransform(0)!.generation;

    beforeEach(() => {
        requests = [];
        respond = success;
        // Keep batching on its 16ms fallback so retry boundaries do not depend on frame alignment.
        vi.spyOn(globalThis, "requestAnimationFrame").mockReturnValue(0);
        setVisible(true);
        window.dispatchEvent(new Event("online"));
        flushSync();
        seedChats([{ characterId: ref.chaId, id: ref.chatId, revision: "r1" }], []);
        vi.spyOn(serverAuth, "authFetch").mockImplementation(async (path, init) => {
            expect(path).toBe("/api/transform");
            const body = JSON.parse(init!.body as string) as TransformRequest;
            requests.push(body);
            return respond(body);
        });
    });

    it("keeps a newer successful render and its cached result when another failed row retries", async () => {
        const source = 'Raw reply <input name="draft" value="initial">';
        appendMessage(ref, { chatId: "pending", role: "char", data: "Still failed" });
        const targets = (messageId: string) =>
            requests.flatMap((request) => request.targets).filter((target) => target.messageId === messageId);
        respond = () => Response.json({ error: "Unavailable" }, { status: 503 });
        const failed = renderChat(source);
        const pending = renderChat("Still failed", { messageId: "pending", idx: 1 });
        await settle(16);
        expect(targets("message")).toHaveLength(1);
        expect(targets("pending")).toHaveLength(1);
        expect(failed.element.querySelector(".chattext")!.textContent).not.toContain("Rendered:");

        rerenderMessage(ref, "message");
        await failed.remove();
        respond = success;
        const current = renderChat(source);
        await settle(16);
        expect(current.element.querySelector(".chattext")!.textContent).toContain("Rendered: Raw reply");
        expect(targets("message").map((target) => !!target.noCache)).toEqual([false, true]);
        const goodKey = targets("message")[1].id;
        const input = current.element.querySelector<HTMLInputElement>('input[name="draft"]')!;
        input.value = "keep my typing";

        // The other row still needs recovery, so this must exercise an actual retry round.
        await settle(5_000);
        await settle(16);
        expect(targets("pending").map((target) => !!target.noCache)).toEqual([false, true]);
        expect(pending.element.querySelector(".chattext")!.textContent).toContain("Rendered: Still failed");
        expect(targets("message").map((target) => !!target.noCache)).toEqual([false, true]);
        expect(current.element.querySelector('input[name="draft"]')).toBe(input);
        expect(input.value).toBe("keep my typing");

        // A later ordinary mount must still confirm the good result through the tab cache.
        await current.remove();
        respond = (body) =>
            Response.json({
                results: [],
                same: body.targets.map((target) => ({ id: target.id, key: target.knownKey })),
            });
        const remounted = renderChat(source);
        await settle(16);
        expect(targets("message")).toHaveLength(3);
        expect(targets("message")[2]).toMatchObject({ knownKey: goodKey });
        expect(targets("message")[2].noCache).toBeUndefined();
        expect(remounted.element.querySelector(".chattext")!.textContent).toContain("Rendered: Raw reply");
    });

    it("retries a failed target after a different target of the same row succeeds in the same generation", async () => {
        const targets = (source: string) =>
            requests.flatMap((request) => request.targets).filter((target) => target.source === source);
        respond = (body) =>
            Response.json({
                results: body.targets.map((target) => ({ id: target.id, ok: false, error: "Unavailable" })),
            });
        const failed = renderChat("Failed display");
        await settle(16);
        expect(failed.element.querySelector(".chattext")!.textContent).toContain("Failed display");
        expect(failed.element.querySelector(".chattext")!.textContent).not.toContain("Rendered:");

        // A later translation target belongs to this message, without a Re-render.
        respond = success;
        const sibling = serverProcessScript(
            { chaId: ref.chaId, type: "simple" },
            "Successful display",
            "editdisplay",
            0,
            {},
            captureTransform(0)!,
            "translation",
        );
        await settle(16);
        expect((await sibling).data).toBe("Rendered: Successful display");
        expect(targets("Failed display").map((target) => !!target.noCache)).toEqual([false]);
        expect(targets("Successful display").map((target) => !!target.noCache)).toEqual([false]);

        await settle(5_000);
        await settle(16);
        expect(targets("Failed display").map((target) => !!target.noCache)).toEqual([false, true]);
        expect(failed.element.querySelector(".chattext")!.textContent).toContain("Rendered: Failed display");
    });

    it("drops a failed source's retry once an edited source renders, and still retries the edit's failure", async () => {
        const unavailable = () => Response.json({ error: "Unavailable" }, { status: 503 });
        respond = unavailable;
        const old = renderChat("Old reply");
        await settle(16);
        expect(requests).toHaveLength(1);

        // An edit, or a saved edit from another tab, mounts the transcript row again with the new text.
        await old.remove();
        respond = success;
        const row = renderChat('New reply <input name="draft" value="initial">');
        await settle(16);
        expect(requests).toHaveLength(2);
        const input = row.element.querySelector<HTMLInputElement>('input[name="draft"]')!;
        input.value = "keep my typing";
        await settle(5_000);
        await settle(16);
        expect(requests).toHaveLength(2);
        expect(row.element.querySelector('input[name="draft"]')).toBe(input);
        expect(input.value).toBe("keep my typing");

        respond = unavailable;
        row.instance.updateRow({ message: "Third reply" });
        flushSync();
        await settle(16);
        expect(requests).toHaveLength(3);
        respond = success;
        await settle(5_000);
        await settle(16);
        expect(requests).toHaveLength(4);
        expect(row.element.querySelector(".chattext")!.textContent).toContain("Rendered: Third reply");
    });

    it("retries only failed mounted rows once per round with 5s doubling backoff capped at 60s", async () => {
        appendMessage(ref, { chatId: "unaffected", role: "char", data: "Untouched" });
        const unaffected = renderChat("Untouched", { idx: 1, messageId: "unaffected" });
        await settle(16);
        await settle();
        const unaffectedBody = unaffected.element.querySelector(".chattext")!.innerHTML;
        const initialGeneration = generation();
        const notice = vi.spyOn(diagnostics, "recordClientEvent");
        respond = async () => {
            throw new TypeError("No transform response");
        };
        const row = renderChat("Raw reply");
        await settle(16);
        await settle();
        expect(row.element.querySelector(".chattext")!.textContent).toContain("Raw reply");
        expect(row.element.querySelector(".chattext")!.textContent).not.toContain("Rendered:");
        expect(notice).toHaveBeenCalledExactlyOnceWith({ kind: "notice", notice: "transformFailed" });
        expect(requests).toHaveLength(2);

        const delays = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000];
        for (const [round, delay] of delays.entries()) {
            if (round === delays.length - 1) respond = success;
            await settle(delay - 1);
            expect(generation(), `before retry ${round + 1}`).toBe(initialGeneration + round);
            expect(requests).toHaveLength(2 + round);
            await settle(1);
            expect(generation(), `at retry ${round + 1}`).toBe(initialGeneration + round + 1);
            await settle(16);
            await settle();
            expect(requests).toHaveLength(3 + round);
            expect(requests.at(-1)!.targets).toEqual([expect.objectContaining({ messageId: "message" })]);
            expect(unaffected.element.querySelector(".chattext")!.innerHTML).toBe(unaffectedBody);
        }
        expect(row.element.querySelector(".chattext")!.textContent).toContain("Rendered: Raw reply");
        await settle(120_000);
        window.dispatchEvent(new Event("online"));
        await settle(16);
        expect(requests).toHaveLength(8);
        expect(generation()).toBe(initialGeneration + delays.length);
    });

    it.each([
        ["a source over the size limit", "x".repeat(512 * 1024 + 1), success],
        ["a 400", "Malformed reply", () => Response.json({ error: "Malformed" }, { status: 400 })],
        [
            "a target the server marks permanent",
            "Huge transcript reply",
            (body: TransformRequest) =>
                Response.json({
                    results: body.targets.map((target) => ({
                        id: target.id,
                        ok: false,
                        error: "Over the limit",
                        permanent: true,
                    })),
                }),
        ],
    ])("does not retry %s while the row stays mounted; a later mount renders it again", async (_, source, refuse) => {
        vi.mocked(alertToast).mockClear();
        respond = refuse;
        const row = renderChat(source);
        await settle(16);
        await settle();
        const sent = requests.length;
        const initialGeneration = generation();
        expect(row.element.querySelector(".chattext")!.textContent).not.toContain("Rendered:");
        expect(alertToast).toHaveBeenCalledOnce();

        await settle(5 * 60_000);
        expect(requests).toHaveLength(sent);
        expect(generation()).toBe(initialGeneration);
        expect(alertToast).toHaveBeenCalledOnce();

        await row.remove();
        renderChat(source);
        await settle(16);
        await settle();
        expect(alertToast).toHaveBeenCalledTimes(2);
    });

    it("retries the rows of a refused request of several targets, which may fit apart", async () => {
        appendMessage(ref, { chatId: "second", role: "char", data: "Second reply" });
        respond = () => Response.json({ error: "Request body too large" }, { status: 413 });
        renderChat("First reply");
        renderChat("Second reply", { messageId: "second", idx: 1 });
        await settle(16);
        await settle();
        expect(requests.map((request) => request.targets.length)).toEqual([2]);
        respond = success;
        await settle(5_000);
        await settle(16);
        await settle();
        expect(requests.slice(1).flatMap((request) => request.targets.map((target) => target.source))).toEqual(
            expect.arrayContaining(["First reply", "Second reply"]),
        );
    });

    it("ends an older generation's pending retry when the newer render fails permanently", async () => {
        respond = () => Response.json({ error: "Unavailable" }, { status: 503 });
        const row = renderChat("Raw reply");
        await settle(16);
        await settle();
        rerenderMessage(ref, "message");
        await row.remove();
        respond = () => Response.json({ error: "Malformed" }, { status: 400 });
        renderChat("Raw reply");
        await settle(16);
        await settle();
        const sent = requests.length;
        await settle(5 * 60_000);
        expect(requests).toHaveLength(sent);
    });

    it("does not retry stale display failures, editprocess failures, or failures without a captured message id", async () => {
        const row = renderChat("Current reply");
        await settle(16);
        await settle();
        let rejectOld!: (error: Error) => void;
        respond = () =>
            new Promise<Response>((_resolve, reject) => {
                rejectOld = reject;
            });
        const old = serverProcessScript(
            { chaId: ref.chaId },
            "Old reply",
            "editdisplay",
            0,
            {},
            captureTransform(0)!,
            "message",
        );
        await settle(16);
        rerenderMessage(ref, "message");
        const currentGeneration = generation();
        rejectOld(new TypeError("No old transform response"));
        await old;
        respond = async () => {
            throw new TypeError("No transform response");
        };
        const process = serverProcessScript(
            { chaId: ref.chaId },
            "Process text",
            "editprocess",
            0,
            {},
            captureTransform(0)!,
            "message",
        );
        const anonymous = serverProcessScript(
            { chaId: ref.chaId },
            "Greeting",
            "editdisplay",
            -1,
            {},
            captureTransform(-1)!,
            "text",
        );
        await settle(16);
        await Promise.all([process, anonymous]);
        expect(requests).toHaveLength(4);
        respond = success;
        await settle(60_000);
        window.dispatchEvent(new Event("online"));
        await settle(16);
        expect(requests).toHaveLength(4);
        expect(generation()).toBe(currentGeneration);
        expect(row.element.querySelector(".chattext")!.textContent).toContain("Rendered: Current reply");
    });

    it.each(["visible again", "online"])("retries pending rows immediately when the page is %s", async (recovery) => {
        respond = async () => {
            throw new TypeError("No transform response");
        };
        const row = renderChat("Interrupted reply");
        await settle(16);
        await settle();
        const initialGeneration = generation();
        expect(requests).toHaveLength(1);
        respond = success;
        if (recovery === "visible again") {
            setVisible(false);
            await settle(120_000);
            expect(requests).toHaveLength(1);
            expect(generation()).toBe(initialGeneration);
            setVisible(true);
        } else {
            window.dispatchEvent(new Event("online"));
            flushSync();
        }
        // The row starts a new render now; only the transform batch waits for its 16ms dispatch.
        expect(generation()).toBe(initialGeneration + 1);
        await settle(16);
        await settle();
        expect(requests).toHaveLength(2);
        expect(row.element.querySelector(".chattext")!.textContent).toContain("Rendered: Interrupted reply");
        await settle(60_000);
        expect(requests).toHaveLength(2);
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
