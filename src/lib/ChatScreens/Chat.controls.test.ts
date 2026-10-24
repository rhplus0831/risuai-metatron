// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StreamingDisplayOptimizationMode } from "../../../shared/database.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";

vi.mock("src/ts/alert", async (importOriginal) => {
    const { alertWait, alertClear } = await importOriginal<typeof import("src/ts/alert")>();
    return (await import("src/ts/tests/alertMock")).createAlertMock({ alertWait, alertClear });
});
vi.mock("src/ts/process/serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock(),
);
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock(),
);

import { language } from "src/lang";
import { characterList } from "src/ts/storage/characterStore.svelte";
import { selectChat, setChatMeta, setStreamingState } from "src/ts/storage/chatStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { alertStore, createSimpleCharacter } from "src/ts/stores.svelte";
import Chat from "./Chat.svelte";

const ref = { chaId: "owner", chatId: "chat" };
const message = "A complete sentence.";
let target: HTMLDivElement;
let instance: ReturnType<typeof mount>;

beforeEach(() => {
    vi.useFakeTimers();
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: ref.chaId,
                type: "character",
                name: "Owner",
                image: "",
                firstMessage: "Hello",
                customscript: [],
                emotionImages: [],
                additionalAssets: [],
                triggerscript: [],
                chats: [
                    {
                        id: ref.chatId,
                        name: "Chat",
                        note: "",
                        localLore: [],
                        autoTranslate: false,
                        message: [
                            {
                                role: "char",
                                chatId: "message",
                                data: message,
                                translation: {
                                    text: "번역",
                                    sourceHash: translationSourceHash(message),
                                    targetLanguage: "ko",
                                    translatedAt: 1,
                                },
                            },
                        ],
                    },
                ],
            },
        ],
        personas: [],
        translator: "ko",
        translatorType: "llm",
        llmTranslationTarget: "message",
        theme: "standard",
        zoomsize: 100,
        lineHeight: 1.25,
        iconsize: 100,
        enableBlockPartialEdit: false,
        enableDragPartialEdit: false,
        useChatCopy: true,
    });
    selectChat(ref.chaId, ref.chatId);
    selectCharacter(ref.chaId);
    alertStore.clearStatus();
    target = document.createElement("div");
    document.body.append(target);
});
afterEach(async () => {
    if (instance) await unmount(instance);
    setStreamingState(ref, null);
    target.remove();
    alertStore.clearStatus();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

async function render(mode: StreamingDisplayOptimizationMode = "off") {
    instance = mount(Chat, {
        target,
        props: {
            chatRef: ref,
            messageId: "message",
            message,
            idx: 0,
            role: "char",
            name: "Owner",
            img: "",
            character: createSimpleCharacter(characterList()[0]),
            isLastMemory: false,
            streamingOptimizationMode: mode,
        },
    });
    flushSync();
    await instance.whenRendered();
    flushSync();
}

it.each(["off", "balanced", "strong"] as const)(
    "hides translate and retranslate while the message streams in %s mode and restores them afterwards",
    async (mode) => {
        setChatMeta(ref, { autoTranslate: true });
        await render(mode);
        const translate = () => target.querySelector(".button-icon-translate");
        const retranslate = () =>
            [...target.querySelectorAll("button")].find((button) => button.textContent?.includes(language.retranslate));
        expect(translate()).not.toBeNull();
        expect(retranslate()).toBeDefined();

        setStreamingState(ref, { messageId: "message", mode });
        instance.updateRow({ isOptimizedStreamingMessage: mode !== "off" });
        flushSync();
        expect(translate()).toBeNull();
        expect(retranslate()).toBeUndefined();

        setStreamingState(ref, null);
        instance.updateRow({ isOptimizedStreamingMessage: false });
        flushSync();
        await instance.whenRendered();
        expect(translate()).not.toBeNull();
        expect(retranslate()).toBeDefined();
    },
);

it.each(["own wait", "newer wait", "newer progress"] as const)(
    "rich-copy fallback clears only the copy's status (%s)",
    async (statusCase) => {
        await render();
        let rejectWrite!: (error: unknown) => void;
        const richWrite = vi.spyOn(navigator.clipboard, "write").mockImplementation(
            () =>
                new Promise<void>((_resolve, reject) => {
                    rejectWrite = reject;
                }),
        );
        const plainWrite = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
        target.querySelector<HTMLButtonElement>(".button-icon-copy")!.click();
        await vi.advanceTimersByTimeAsync(0);
        expect(richWrite).toHaveBeenCalledOnce();
        const owned = alertStore.status();
        expect(owned?.type).toBe("wait");
        const newer =
            statusCase === "own wait"
                ? null
                : ({
                      type: statusCase === "newer wait" ? "wait" : "progress",
                      msg: owned!.msg,
                  } as const);
        if (newer) alertStore.set(newer);
        rejectWrite(new Error("Clipboard rich content denied"));
        await vi.advanceTimersByTimeAsync(0);
        expect(plainWrite).toHaveBeenCalledWith(message);
        expect(alertStore.status()).toBe(newer);
    },
);
