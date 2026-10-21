// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The modal's half of the generation fence (`docs/structure/memory.md`, UI and Invariants): over the real
// chat module, the HypaV3 modal writes nothing while a send of this tab (`sendingChatRef`) or a job this
// tab follows (`followedJobs` → `generatingChatKeys`) runs in the chat. A change made meanwhile is undone
// in the copy with the `chatGenerating` notice and is not replayed when the fence drops; the empty default
// of a chat without memory data is never written by the saving effect (the immediate initialization write
// is quietly refused while fenced and the chat keeps no `hypaV3Data` after the job), while an unfenced open
// still initializes it; the V2→V3 conversion is offered for a chat without `hypaV3Data` and reports no
// success while fenced.

const mocks = vi.hoisted(() => ({ alertError: vi.fn(), alertNormalWait: vi.fn(async () => undefined) }));

vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: mocks.alertError,
        alertNormalWait: mocks.alertNormalWait,
    }),
);
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
import { summarize } from "src/ts/process/memory/hypav3";
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
    vi.mocked(summarize).mockReset();
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

// A bulk resummary resolves its selection by summary identity (`summaryKey`) in the copy at Retry and
// Apply, so a change of the chat that replaces the copy during the summarization await merges the
// selected summaries or is refused, never others.
describe("HypaV3Modal's bulk resummary", () => {
    const three = () => [...summaries(), { text: "three", chatMemos: ["m2"], isImportant: false }];

    // Two summaries without message ids share one identity (`summaryKey` "[]"), as legacy ones can.
    const sharedKey = () => [
        { text: "one", chatMemos: [], isImportant: false },
        { text: "two", chatMemos: [], isImportant: false },
        { text: "three", chatMemos: ["m2"], isImportant: false },
    ];

    async function resummarizeFirstAndLast(initial = three()) {
        setChatMeta(withData, { hypaV3Data: { summaries: initial, categories: [] } });
        const modal = open(withData);
        const button = (match: (button: HTMLButtonElement) => boolean) =>
            [...modal.target.querySelectorAll("button")].find(match)!;
        button((b) => b.querySelector(".lucide-square-pen") !== null).click();
        flushSync();
        const boxes = modal.target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
        expect(boxes).toHaveLength(3);
        boxes[0].click();
        boxes[2].click();
        flushSync();

        let finish!: (text: string) => void;
        vi.mocked(summarize).mockImplementation(() => new Promise<string>((resolve) => (finish = resolve)));
        button((b) => b.textContent?.trim() === language.hypaV3Modal.reSummarize).click();
        flushSync();
        expect(vi.mocked(summarize).mock.calls[0][0].map((m: any) => m.content)).toEqual(["one", "three"]);
        return {
            modal,
            finish: async (text: string) => {
                finish(text);
                await Promise.resolve();
                await Promise.resolve();
                flushSync();
            },
            apply: () => {
                button((b) => b.title === language.apply).click();
                flushSync();
            },
            retry: () => {
                button((b) => b.title === language.hypaV3Modal.retry).click();
                flushSync();
            },
        };
    }

    it("merges the selected summaries after a write shifted them during the summarization", async () => {
        const run = await resummarizeFirstAndLast();
        // A memory write lands meanwhile: a summary placed before the selected ones replaces the copy.
        setChatMeta(withData, {
            hypaV3Data: {
                summaries: [{ text: "zero", chatMemos: ["m9"], isImportant: false }, ...three()],
                categories: [],
            },
        });
        flushSync();
        await run.finish("merged");

        run.apply();
        expect(mocks.alertError).not.toHaveBeenCalled();
        const stored = (findChat(withData)?.hypaV3Data as any).summaries;
        expect(stored.map((s: any) => s.text)).toEqual(["zero", "merged", "two"]);
        expect(stored[1].chatMemos).toEqual(["m0", "m2"]);
    });

    it("retries with the selected summaries' texts after the copy was replaced", async () => {
        const run = await resummarizeFirstAndLast();
        await run.finish("first");
        setChatMeta(withData, {
            hypaV3Data: {
                summaries: [{ text: "zero", chatMemos: ["m9"], isImportant: false }, ...three()],
                categories: [],
            },
        });
        flushSync();

        vi.mocked(summarize).mockResolvedValue("second");
        run.retry();
        expect(vi.mocked(summarize).mock.calls[1][0].map((m: any) => m.content)).toEqual(["one", "three"]);
        await Promise.resolve();
        await Promise.resolve();
        flushSync();
        run.apply();
        expect(storedSummaries(withData)).toEqual(["zero", "second", "two"]);
    });

    it("refuses with the notice when a selected summary is gone, and writes nothing", async () => {
        const run = await resummarizeFirstAndLast();
        // A write removes a selected summary meanwhile (another tab's delete, a job's orphan cleanup).
        setChatMeta(withData, { hypaV3Data: { summaries: summaries(), categories: [] } });
        flushSync();
        await run.finish("merged");
        chatWork.mockClear();

        run.apply();
        expect(mocks.alertError).toHaveBeenCalledWith(language.hypaV3Modal.bulkResummaryTargetsGone);
        expect(storedSummaries(withData)).toEqual(["one", "two"]);
        expect(chatWork).not.toHaveBeenCalled();

        mocks.alertError.mockClear();
        run.retry();
        expect(mocks.alertError).toHaveBeenCalledWith(language.hypaV3Modal.bulkResummaryTargetsGone);
        expect(vi.mocked(summarize)).toHaveBeenCalledTimes(1);
    });

    it("merges summaries that share an identity with another while the copy is not replaced", async () => {
        const run = await resummarizeFirstAndLast(sharedKey());
        await run.finish("merged");

        run.apply();
        expect(mocks.alertError).not.toHaveBeenCalled();
        expect(storedSummaries(withData)).toEqual(["merged", "two"]);
    });

    it("refuses a target whose identity was shared once the copy is replaced, rather than merging the other one", async () => {
        const run = await resummarizeFirstAndLast(sharedKey());
        // The selected "one" is removed meanwhile; the unselected "two" now has its identity alone.
        setChatMeta(withData, { hypaV3Data: { summaries: sharedKey().slice(1), categories: [] } });
        flushSync();
        await run.finish("merged");

        run.apply();
        expect(mocks.alertError).toHaveBeenCalledWith(language.hypaV3Modal.bulkResummaryTargetsGone);
        expect(storedSummaries(withData)).toEqual(["two", "three"]);
    });
});
