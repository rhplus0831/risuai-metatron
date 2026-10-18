// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Slice 1c of `docs/plan/data-loss-concurrency.md` (audit A2), the modal's half (`docs/structure/memory.md`,
// UI and Invariants): over the real chat module, the HypaV3 modal writes nothing while a send of this
// tab (`sendingChatRef`) or a job this tab follows (`followedJobs` → `generatingChatKeys`) runs in
// the chat. A change made meanwhile is undone in the copy with the `chatGenerating` notice and is not
// replayed when the fence drops; the empty default of a chat without memory data is never written by
// the saving effect (the immediate initialization write is quietly refused while fenced and the chat
// keeps no `hypaV3Data` after the job), while an unfenced open still initializes it; the V2→V3
// conversion is offered for a chat without `hypaV3Data` and reports no success while fenced.

const mocks = vi.hoisted(() => ({ alertError: vi.fn(), alertNormalWait: vi.fn(async () => undefined) }));

vi.mock("src/ts/alert", () => ({
    alertError: mocks.alertError,
    alertNormalWait: mocks.alertNormalWait,
    alertConfirm: vi.fn(async () => false),
    alertMd: vi.fn(),
    alertNormal: vi.fn(),
    alertToast: vi.fn(),
}));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/parser/transformClient", () => ({ captureTransform: vi.fn(), serverProcessScript: vi.fn() }));
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("src/ts/translator/translator", () => ({ translateHTML: vi.fn(async (text: string) => text) }));
vi.mock("src/ts/plugins/apiV3/pluginContext", () => ({ capturePluginContext: vi.fn(() => null) }));
vi.mock("src/ts/process/memory/hypav3", () => ({
    summarize: vi.fn(),
    getCurrentHypaV3Preset: vi.fn(() => ({ settings: { processRegexScript: false } })),
}));
// The send pipeline is not under test: only its busy target store.
vi.mock("src/ts/process/index.svelte", async () => {
    const { writable } = await import("svelte/store");
    return { sendingChatRef: writable(null) };
});
vi.mock("src/ts/stores.svelte", async () => {
    const { writable } = await import("svelte/store");
    return { hypaV3ModalOpen: writable(true), settingsOpen: writable(false), SettingsMenuIndex: writable(-1) };
});

import { language } from "src/lang";
import { chatStatusKey } from "src/ts/process/chatStatus.svelte";
import { sendingChatRef } from "src/ts/process/index.svelte";
import { followedJobs } from "src/ts/process/serverCommands";
import { findChat, selectChat, setChatMeta, setChatWorkListener, type ChatRef } from "src/ts/storage/chatStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import HypaV3Modal from "./HypaV3Modal.svelte";

const withData: ChatRef = { chaId: "c", chatId: "k" };
const withoutData: ChatRef = { chaId: "c", chatId: "n" };
const summaries = () => [
    { text: "one", chatMemos: ["m0"], isImportant: false },
    { text: "two", chatMemos: ["m1"], isImportant: false },
];
const hypaV2Data = {
    lastMainChunkID: 1,
    mainChunks: [{ id: 1, text: "chunk", chatMemos: ["m0"], lastChatMemo: "m0" }],
    chunks: [{ mainChunkID: 1, text: "chunk" }],
};
const mounted: ReturnType<typeof mount>[] = [];
const chatWork = vi.fn();

function install() {
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
                        name: "K",
                        note: "",
                        localLore: [],
                        message: [
                            { role: "user", data: "first", chatId: "m0" },
                            { role: "char", data: "second", chatId: "m1" },
                        ],
                        hypaV3Data: { summaries: summaries(), categories: [] },
                    },
                    { id: "n", name: "N", note: "", localLore: [], message: [], hypaV2Data },
                ],
            },
        ],
        hypaV3: true,
    } as any);
}

function open(ref: ChatRef) {
    selectCharacter("c");
    selectChat(ref.chaId, ref.chatId);
    flushSync();
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(HypaV3Modal, { target }));
    flushSync();
    return {
        target,
        /** The first summary's text editor. */
        textarea: () => target.querySelector<HTMLTextAreaElement>("textarea")!,
        type: (text: string) => {
            const input = target.querySelector<HTMLTextAreaElement>("textarea")!;
            input.value = text;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            flushSync();
        },
        convertButton: () =>
            [...target.querySelectorAll("button")].find((button) =>
                button.parentElement?.textContent?.includes(language.hypaV3Modal.convertLabel),
            ) ?? null,
    };
}

const follow = (ref: ChatRef | null) => followedJobs.set(ref ? new Map([["job-1", chatStatusKey(ref)]]) : new Map());
const storedSummaries = (ref: ChatRef) => (findChat(ref)?.hypaV3Data as any)?.summaries?.map((s: any) => s.text);

beforeEach(() => {
    mocks.alertError.mockClear();
    mocks.alertNormalWait.mockClear();
    chatWork.mockClear();
    install();
    setChatWorkListener(chatWork);
    follow(null);
    sendingChatRef.set(null);
});

afterEach(async () => {
    setChatWorkListener(null);
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
});

describe("HypaV3Modal's write fence", () => {
    it("writes an edit through the chat module when nothing runs in the chat", () => {
        const modal = open(withData);
        modal.type("one, edited");
        expect(storedSummaries(withData)).toEqual(["one, edited", "two"]);
        expect(chatWork).toHaveBeenCalled();
        expect(mocks.alertError).not.toHaveBeenCalled();
    });

    it("undoes an edit with the notice while a job this tab follows runs in the chat, and does not replay it when the job ends", () => {
        const modal = open(withData);
        follow(withData);
        flushSync();
        chatWork.mockClear();

        modal.type("one, edited");
        expect(mocks.alertError).toHaveBeenCalledWith(language.chatGenerating);
        expect(modal.textarea().value).toBe("one");
        expect(storedSummaries(withData)).toEqual(["one", "two"]);
        expect(chatWork).not.toHaveBeenCalled();

        // The job ends: nothing pending is written.
        follow(null);
        flushSync();
        expect(storedSummaries(withData)).toEqual(["one", "two"]);
        expect(chatWork).not.toHaveBeenCalled();

        // The next edit writes again.
        modal.type("one, later");
        expect(storedSummaries(withData)).toEqual(["one, later", "two"]);
        expect(mocks.alertError).toHaveBeenCalledTimes(1);
    });

    it("is fenced by this tab's own send of the chat and not by a send of another chat", () => {
        const modal = open(withData);
        sendingChatRef.set(withoutData);
        flushSync();
        modal.type("one, edited");
        expect(storedSummaries(withData)).toEqual(["one, edited", "two"]);
        expect(mocks.alertError).not.toHaveBeenCalled();

        sendingChatRef.set(withData);
        flushSync();
        modal.type("one, again");
        expect(mocks.alertError).toHaveBeenCalledWith(language.chatGenerating);
        expect(modal.textarea().value).toBe("one, edited");
        expect(storedSummaries(withData)).toEqual(["one, edited", "two"]);
    });

    it("keeps the copy in step with a change of the chat (a job's write) made while fenced", () => {
        const modal = open(withData);
        follow(withData);
        flushSync();
        // The job's write reaching the mirror: the copy follows, nothing is written back, no notice.
        chatWork.mockClear();
        setChatMeta(withData, {
            hypaV3Data: {
                summaries: [...summaries(), { text: "three", chatMemos: ["m2"], isImportant: false }],
                categories: [],
            },
        });
        flushSync();
        expect(modal.target.querySelectorAll("textarea")).toHaveLength(3);
        expect(storedSummaries(withData)).toEqual(["one", "two", "three"]);
        expect(mocks.alertError).not.toHaveBeenCalled();
    });

    it("never writes the empty default of a chat without memory data while fenced, nor when the fence drops", () => {
        follow(withoutData);
        const modal = open(withoutData);
        expect(findChat(withoutData)?.hypaV3Data).toBeUndefined();
        expect(mocks.alertError).not.toHaveBeenCalled();
        expect(chatWork).not.toHaveBeenCalled();

        // The conversion is offered for a chat without `hypaV3Data`, and refused while fenced without a success notice.
        const convert = modal.convertButton();
        expect(convert).not.toBeNull();
        convert!.click();
        flushSync();
        expect(mocks.alertError).toHaveBeenCalledWith(language.chatGenerating);
        expect(mocks.alertNormalWait).not.toHaveBeenCalled();
        expect(findChat(withoutData)?.hypaV3Data).toBeUndefined();

        // The job ends (the mirror may not hold its write yet): the empty copy is not written over it.
        follow(null);
        flushSync();
        expect(findChat(withoutData)?.hypaV3Data).toBeUndefined();
        expect(chatWork).not.toHaveBeenCalled();
    });

    it("initializes a chat without memory data at once when nothing runs in it", () => {
        open(withoutData);
        expect((findChat(withoutData)?.hypaV3Data as any)?.summaries).toEqual([]);
        expect(mocks.alertError).not.toHaveBeenCalled();
    });
});
