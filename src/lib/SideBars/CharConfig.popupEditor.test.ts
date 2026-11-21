// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";

// `CharConfig`'s fields follow the selected character, which the previous/next character hotkeys
// change while a popup editor stays open. Each field passes its character as the popup's context,
// so a popup opened on one character is discarded after a switch instead of landing in the next
// one, even when both hold the same text. Mounted over the real records, selection, and popup
// editor; unrelated panels and file loading are doubled.

vi.mock("src/ts/globalApi.svelte", async () =>
    (await import("src/ts/tests/globalApiMock")).createGlobalApiMock({
        holdFileSrc: () => ({ src: Promise.resolve(""), release: () => {} }),
        getFileSrc: vi.fn(async () => ""),
    }),
);
vi.mock("src/ts/characters", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/characters")>()),
    getCharImage: vi.fn(async () => ""),
}));
vi.mock("src/ts/tokenizer", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/tokenizer")>()),
    countTokens: vi.fn(async () => 0),
}));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/lib/SideBars/LoreBook/LoreBookSetting.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/SideBars/Scripts/RegexList.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/SideBars/Scripts/TriggerList.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/SideBars/Toggles.svelte", () => ({ default: () => {} }));

import CharConfig from "./CharConfig.svelte";
import { normalizeCharacter } from "../../../shared/characters";
import { language } from "src/lang";
import { showHypaV2Alert } from "src/ts/alert";
import { noteGenerationFrame, resetGenerationProgress } from "src/ts/process/generationProgress.svelte";
import { beginLocalSend } from "src/ts/process/localSends";
import { CharConfigSubMenu, closePopupEditorSession, popUpEditorStore } from "src/ts/stores.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { characterList } from "src/ts/storage/characterStore.svelte";
import {
    captureChatBaseline,
    chatNoticeSeq,
    findChat,
    finishIdleChatRefresh,
    hasUnsavedChatWork,
    noteRemoteChat,
    seedChats,
    selectChat,
} from "src/ts/storage/chatStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";

let instance: ReturnType<typeof mount> | null = null;

afterEach(() => {
    if (instance) unmount(instance);
    instance = null;
    resetGenerationProgress();
    document.body.replaceChildren();
    vi.useRealTimers();
});

it("a field's popup writes the character it opened on; a character switch while it is open discards it", async () => {
    vi.useFakeTimers();
    const previousPopup = { ...popUpEditorStore };
    try {
        installFlatDatabaseWithChats({
            characters: ["c1", "c2"].map((chaId) => ({
                chaId,
                type: "character",
                name: chaId,
                desc: "",
                chatPage: 0,
                chats: [{ id: `${chaId}-chat`, name: "K", note: "", localLore: [], message: [] }],
            })),
        });
        settings.ui.longPressToPopupEditor = true;
        selectCharacter("c1");
        CharConfigSubMenu.set(0);
        const target = document.createElement("div");
        document.body.append(target);
        instance = mount(CharConfig, { target });
        flushSync();
        // The description is the tab's first field.
        const openDescriptionPopup = () => {
            target
                .querySelector("textarea")!
                .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
            expect(popUpEditorStore).toMatchObject({ open: true, value: "" });
        };
        const closePopupWith = async (text: string) => {
            popUpEditorStore.value = text;
            closePopupEditorSession(popUpEditorStore.sessionId);
            await vi.advanceTimersByTimeAsync(100);
            flushSync();
            await vi.advanceTimersByTimeAsync(0);
            flushSync();
        };
        const descriptions = () => characterList().map((entry) => (entry as { desc: string }).desc);

        openDescriptionPopup();
        popUpEditorStore.value = "typed for c1";
        selectCharacter("c2");
        flushSync();
        await vi.advanceTimersByTimeAsync(100);
        flushSync();
        expect(popUpEditorStore.open).toBe(false);
        expect(descriptions()).toEqual(["", ""]);

        openDescriptionPopup();
        await closePopupWith("typed for c2");
        expect(descriptions()).toEqual(["", "typed for c2"]);
    } finally {
        popUpEditorStore.open = false;
        await vi.advanceTimersByTimeAsync(100);
        Object.assign(popUpEditorStore, previousPopup);
    }
});

const originalSummary = "old-message\nOriginal summary";
const generatedSummary = "latest-message\nGenerated summary";
const initialRevision = "11111111-2222-4333-8444-555555555555:1:1";
const jobRevision = "11111111-2222-4333-8444-555555555555:1:2";

function mountMemorySettings(chaId: string, type: "character" | "group", algorithm: "supaMemory" | "hypaV2") {
    const chat = { chaId, chatId: "memory-chat" };
    installFlatDatabaseWithChats({
        characters: [
            normalizeCharacter({
                chaId,
                type,
                name: chaId,
                chats: [
                    {
                        id: chat.chatId,
                        name: "Memory",
                        note: "",
                        localLore: [],
                        message: [],
                        supaMemoryData: originalSummary,
                    },
                ],
            }),
        ],
    });
    seedChats([{ characterId: chaId, id: chat.chatId, revision: initialRevision }], []);
    settings.ui.memoryAlgorithmType = algorithm;
    settings.memoryTranslateMedia.hypav2 = algorithm === "hypaV2";
    selectCharacter(chaId);
    selectChat(chaId, chat.chatId);
    CharConfigSubMenu.set(2);
    const target = document.createElement("div");
    document.body.append(target);
    instance = mount(CharConfig, { target });
    flushSync();
    return { chat, target, workQueued: () => hasUnsavedChatWork((id) => id === chaId) };
}

function mountSupaMemory(chaId: string, type: "character" | "group") {
    const editor = mountMemorySettings(chaId, type, "supaMemory");
    const input = [...editor.target.querySelectorAll("textarea")].find((field) => field.value === originalSummary)!;
    expect(input.value).toBe(originalSummary);
    const edit = (text: string) => {
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
    };
    return { ...editor, input, edit };
}

it.each(["character", "group"] as const)(
    "fences the %s SupaMemory editor until the generated summary and its cursor arrive",
    (type) => {
        const { chat, target, input, edit, workQueued } = mountSupaMemory(`supa-${type}`, type);
        const expectReadOnly = (notice: string) => {
            expect(input.readOnly).toBe(true);
            expect(input.disabled).toBe(false);
            expect(target.textContent).toContain(notice);
            edit("refused edit");
            expect(findChat(chat)?.supaMemoryData).toBe(originalSummary);
            expect(workQueued()).toBe(false);
        };
        expect(input.readOnly).toBe(false);
        const release = beginLocalSend(chat)!;
        try {
            flushSync();
            expectReadOnly(language.chatGenerating);
        } finally {
            release();
        }
        flushSync();
        expect(input.readOnly).toBe(false);

        const job = { jobId: "summary-job", characterId: chat.chaId, chatId: chat.chatId };
        noteGenerationFrame({
            ...job,
            state: "running",
            kind: type === "group" ? "group" : "send",
            clientId: "other-tab",
            startedAt: 1,
            at: 1,
        });
        flushSync();
        expectReadOnly(language.chatGenerating);
        expect(noteRemoteChat(chat, jobRevision)).toBe("noticed");
        noteGenerationFrame({ ...job, state: "ended" });
        flushSync();
        expectReadOnly(language.memoryTasks.awaitingSync);

        const data = { ...captureChatBaseline(chat).chat, supaMemoryData: generatedSummary };
        expect(
            finishIdleChatRefresh(
                { characterId: chat.chaId, id: chat.chatId, revision: jobRevision, data },
                chatNoticeSeq(chat),
                initialRevision,
            ),
        ).toBe(true);
        flushSync();
        expect(input.readOnly).toBe(false);
        expect(input.value).toBe(generatedSummary);
        expect(workQueued()).toBe(false);
        edit(input.value + "\nManual correction");
        expect(findChat(chat)?.supaMemoryData).toBe("latest-message\nGenerated summary\nManual correction");
        expect(workQueued()).toBe(true);
    },
);

it("opens the sidebar HypaV2 dialog during generation and initializes absent memory when idle", () => {
    const { chat, target, workQueued } = mountMemorySettings("hypa-sidebar", "character", "hypaV2");
    const open = [...target.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === language.hypaMemoryV2Modal,
    )!;
    const show = vi.mocked(showHypaV2Alert);
    show.mockClear();
    const release = beginLocalSend(chat)!;
    try {
        flushSync();
        open.click();
        expect(show).toHaveBeenCalledTimes(1);
        expect(findChat(chat)?.hypaV2Data).toBeUndefined();
        expect(workQueued()).toBe(false);
    } finally {
        release();
    }
    flushSync();
    open.click();
    expect(show).toHaveBeenCalledTimes(2);
    expect(findChat(chat)?.hypaV2Data).toEqual({ lastMainChunkID: 0, mainChunks: [], chunks: [] });
});
