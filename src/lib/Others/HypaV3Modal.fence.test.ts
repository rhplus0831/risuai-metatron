// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The modal's half of the generation fence (`docs/structure/memory.md`, UI and Invariants): over the real
// chat module, the HypaV3 modal writes nothing while a send of this tab (a `localSends` entry) or a job this
// tab follows (`followedJobs` → `generatingChatKeys`) runs in the chat. A change made meanwhile is undone
// in the copy with the `chatGenerating` notice and is not replayed when the fence drops; the empty default
// of a chat without memory data is never written by the saving effect (the immediate initialization write
// is quietly refused while fenced and the chat keeps no `hypaV3Data` after the job), while an unfenced open
// still initializes it; the V2→V3 conversion is offered for a chat without `hypaV3Data` and reports no
// success while fenced.

const mocks = vi.hoisted(() => ({
    alertError: vi.fn(),
    alertNormal: vi.fn(),
    alertNormalWait: vi.fn(async () => undefined),
    alertConfirm: vi.fn(async (_message: string) => true),
    /** The save loop's flush, as "Summarize now" awaits it (the loop itself is not under test here). */
    flushResources: vi.fn(async () => ({ discarded: [] as string[] })),
    /** The memory task routes' answers. */
    authFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: mocks.alertError,
        alertNormal: mocks.alertNormal,
        alertNormalWait: mocks.alertNormalWait,
        alertConfirm: mocks.alertConfirm,
    }),
);
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: mocks.authFetch }),
);
vi.mock("src/ts/storage/resourceSync.svelte", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/storage/resourceSync.svelte")>()),
    flushResources: mocks.flushResources,
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
vi.mock("src/ts/stores.svelte", async () => {
    const { writable } = await import("svelte/store");
    return (await import("src/ts/tests/storesMock")).createStoresMock({
        hypaV3ModalOpen: writable(true),
        settingsOpen: writable(false),
        SettingsMenuIndex: writable(-1),
    });
});

import { MEMORY_TASKS_PATH } from "../../../shared/events.ts";
import type { MemoryTaskStatus } from "../../../shared/jobs.ts";
import { language } from "src/lang";
import { summarize } from "src/ts/process/memory/hypav3";
import { chatStatusKey, generatingChatKeys } from "src/ts/process/chatStatus.svelte";
import { beginLocalSend } from "src/ts/process/localSends";
import { noteMemoryTaskFrame, resetMemoryTasks } from "src/ts/process/memoryTasks.svelte";
import { followedJobs } from "src/ts/process/serverCommands";
import {
    ackChatWork,
    findChat,
    hydrateChat,
    seedChats,
    takeChatWork,
    selectChat,
    setChatMeta,
    setChatWorkListener,
    type ChatRef,
} from "src/ts/storage/chatStore.svelte";
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
/** The sends begun on the registry, released at the test's end at the latest. */
const releases: (() => void)[] = [];
const send = (ref: ChatRef) => {
    const release = beginLocalSend(ref)!;
    expect(release).not.toBeNull();
    releases.push(release);
    flushSync();
    return release;
};

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
    mocks.alertConfirm.mockReset().mockResolvedValue(true);
    mocks.alertError.mockClear();
    mocks.alertNormalWait.mockClear();
    vi.mocked(summarize).mockReset();
    chatWork.mockClear();
    install();
    setChatWorkListener(chatWork);
    follow(null);
});

describe("HypaV3Modal's summary identity after deletion", () => {
    const four = () => [
        ...summaries(),
        { text: "three", chatMemos: ["m2"], isImportant: false },
        { text: "four", chatMemos: ["m3"], isImportant: false },
    ];
    function openFour() {
        setChatMeta(withData, { hypaV3Data: { summaries: four(), categories: [] } });
        return open(withData).target;
    }
    const buttonWithIcon = (root: HTMLElement, icon: string) =>
        root.querySelector<HTMLButtonElement>(`button:has(.lucide-${icon})`)!;
    const row = (target: HTMLElement, text: string) =>
        [...target.querySelectorAll("textarea")].find((textarea) => textarea.value === text)!.parentElement!
            .parentElement!;
    const boxes = (target: HTMLElement) => [...target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    const selectedTexts = (target: HTMLElement) =>
        boxes(target)
            .filter((box) => box.checked)
            .map((box) => box.closest("div.flex-col")!.querySelector("textarea")!.value);
    function selectFirstAndThird(target: HTMLElement) {
        buttonWithIcon(target, "square-pen").click();
        flushSync();
        boxes(target)[0].click();
        boxes(target)[2].click();
        flushSync();
        expect(selectedTexts(target)).toEqual(["one", "three"]);
    }
    async function deleteFrom(target: HTMLElement, text: string, after: boolean) {
        buttonWithIcon(row(target, text), after ? "scissors-line-dashed" : "trash-2").click();
        // Drain the resolved dialog answers and Svelte's update, including Delete after's second confirmation.
        await tick();
        await tick();
        flushSync();
    }
    function bulkImportant(target: HTMLElement) {
        target.querySelector<HTMLButtonElement>("button.border-yellow-600")!.click();
        flushSync();
    }

    it("keeps later selections on their summaries and drops a deleted selection after Delete this", async () => {
        const target = openFour();
        selectFirstAndThird(target);
        await deleteFrom(target, "one", false);

        expect(mocks.alertConfirm).toHaveBeenCalledWith(language.hypaV3Modal.deleteThisConfirmMessage);
        expect(storedSummaries(withData)).toEqual(["two", "three", "four"]);
        expect(selectedTexts(target)).toEqual(["three"]);
        bulkImportant(target);
        expect(
            findChat(withData)?.hypaV3Data?.summaries.map(({ text, isImportant }) => ({ text, isImportant })),
        ).toEqual([
            { text: "two", isImportant: false },
            { text: "three", isImportant: true },
            { text: "four", isImportant: false },
        ]);
    });

    it("drops deleted selections after Delete after and applies a bulk action only to the surviving selection", async () => {
        const target = openFour();
        selectFirstAndThird(target);
        await deleteFrom(target, "two", true);

        expect(mocks.alertConfirm.mock.calls.map(([message]) => message)).toEqual([
            language.hypaV3Modal.deleteAfterConfirmMessage,
            language.hypaV3Modal.deleteAfterConfirmSecondMessage,
        ]);
        expect(storedSummaries(withData)).toEqual(["one", "two"]);
        expect(selectedTexts(target)).toEqual(["one"]);
        bulkImportant(target);
        expect(
            findChat(withData)?.hypaV3Data?.summaries.map(({ text, isImportant }) => ({ text, isImportant })),
        ).toEqual([
            { text: "one", isImportant: true },
            { text: "two", isImportant: false },
        ]);
    });

    const tagInput = (target: HTMLElement) =>
        target.querySelector<HTMLInputElement>(`input[placeholder="${language.hypaV3Modal.newTagName}"]`);
    function openTags(target: HTMLElement, text: string) {
        [...row(target, text).querySelectorAll("button")]
            .find((button) => button.title === language.hypaV3Modal.tagManager)!
            .click();
        flushSync();
        const input = tagInput(target)!;
        expect(input).not.toBeNull();
        expect(input.value).toBe("");
        input.value = "unfinished tag";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
        return input;
    }

    it.each(["shifted", "deleted"])(
        "closes the tag manager when a local delete leaves its summary %s",
        async (change) => {
            const target = openFour();
            openTags(target, change === "shifted" ? "two" : "four");
            await deleteFrom(target, change === "shifted" ? "one" : "two", change === "deleted");

            expect(tagInput(target)).toBeNull();
            expect(storedSummaries(withData)).toEqual(change === "shifted" ? ["two", "three", "four"] : ["one", "two"]);
            openTags(target, change === "shifted" ? "three" : "two");
            // Reopening starts clean and cannot apply the former summary's pending edit.
            expect(findChat(withData)?.hypaV3Data?.summaries.every((summary) => !summary.tags?.length)).toBe(true);
        },
    );

    it.each(["replacement", "missing"])(
        "closes the tag manager safely when another writer leaves a %s target",
        (change) => {
            const target = openFour();
            openTags(target, "four");
            const replacement =
                change === "missing"
                    ? summaries()
                    : four().map((summary) => ({ ...summary, text: `${summary.text} remote` }));
            setChatMeta(withData, { hypaV3Data: { summaries: replacement, categories: [] } });
            expect(() => flushSync()).not.toThrow();

            expect(tagInput(target)).toBeNull();
            expect(storedSummaries(withData)).toEqual(
                change === "missing" ? ["one", "two"] : ["one remote", "two remote", "three remote", "four remote"],
            );
            expect(findChat(withData)?.hypaV3Data?.summaries.every((summary) => !summary.tags?.length)).toBe(true);
        },
    );
});

afterEach(async () => {
    setChatWorkListener(null);
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    for (const release of releases.splice(0)) {
        release();
    }
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
        send(withoutData);
        modal.type("one, edited");
        expect(storedSummaries(withData)).toEqual(["one, edited", "two"]);
        expect(mocks.alertError).not.toHaveBeenCalled();

        const release = send(withData);
        modal.type("one, again");
        expect(mocks.alertError).toHaveBeenCalledWith(language.chatGenerating);
        expect(modal.textarea().value).toBe("one, edited");
        expect(storedSummaries(withData)).toEqual(["one, edited", "two"]);

        // The send's end replays nothing and opens the fence; the other chat's send still does not fence.
        release();
        flushSync();
        expect(storedSummaries(withData)).toEqual(["one, edited", "two"]);
        modal.type("one, after");
        expect(storedSummaries(withData)).toEqual(["one, after", "two"]);
        expect(mocks.alertError).toHaveBeenCalledTimes(1);
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

    it("keeps a cancelled bulk resummary hidden when its pending request resolves", async () => {
        const run = await resummarizeFirstAndLast();
        const target = run.modal.target;
        expect(target.textContent).toContain(language.hypaV3Modal.reSummarizeResult);

        [...target.querySelectorAll("button")].find((button) => button.title === language.cancel)!.click();
        flushSync();
        expect(target.textContent).not.toContain(language.hypaV3Modal.reSummarizeResult);

        await run.finish("late summary");

        expect(target.textContent).not.toContain(language.hypaV3Modal.reSummarizeResult);
        expect([...target.querySelectorAll("textarea")].map((textarea) => textarea.value)).not.toContain(
            "late summary",
        );
    });

    it("clears the bulk-edit selection when another writer replaces the memory data", () => {
        const modal = open(withData);
        [...modal.target.querySelectorAll("button")]
            .find((button) => button.querySelector(".lucide-square-pen") !== null)!
            .click();
        flushSync();
        const boxes = () => [...modal.target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
        expect(boxes()).toHaveLength(2);
        boxes()[0].click();
        flushSync();
        expect(boxes().map((box) => box.checked)).toEqual([true, false]);

        setChatMeta(withData, {
            hypaV3Data: {
                summaries: [{ text: "zero", chatMemos: ["m9"], isImportant: false }, ...summaries()],
                categories: [],
            },
        });
        flushSync();

        expect([...modal.target.querySelectorAll("textarea")].map((textarea) => textarea.value)).toEqual([
            "zero",
            "one",
            "two",
        ]);
        expect(boxes().map((box) => box.checked)).toEqual([false, false, false]);
    });

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

// The modal's half of the memory task fence (`memoryTasks.svelte.ts`): over the real chat module, an
// edit is refused with `editFenced` while the chat's task runs and until the mirror holds the
// terminal's revision, and accepted after; lore is not fenced by a task; "Summarize now" fences the
// chat from before its flush, shows the answer's notice, and offers Cancel while a start waits.
describe("HypaV3Modal's memory task fence", () => {
    const E = "0f3d4b9a-0000-4000-8000-000000000001";
    const rev = (n: number) => `${E}:1:${n}`;
    const frame = (status: MemoryTaskStatus) => noteMemoryTaskFrame({ characterId: "c", chatId: "k", status });
    /** The chat as the server holds it after a task wrote these summaries. */
    const serverCopy = (texts: string[]) => ({
        ...JSON.parse(JSON.stringify(findChat(withData))),
        hypaV3Data: {
            summaries: texts.map((text, index) => ({ text, chatMemos: [`m${index}`], isImportant: false })),
            categories: [],
        },
    });
    const json = (status: number, body: unknown) => Response.json(body, { status });
    const taskBlock = (target: HTMLElement) => target.querySelector<HTMLElement>("[data-risu-memory-task]")!;
    const startButton = (target: HTMLElement) =>
        target.querySelector<HTMLButtonElement>("[data-risu-memory-task-start]")!;
    const cancelButton = (target: HTMLElement) =>
        target.querySelector<HTMLButtonElement>("[data-risu-memory-task-cancel]");
    const syncLine = (target: HTMLElement) => target.querySelector("[data-risu-memory-task-sync]");
    /** The microtasks of a click's action (the flush, the request, its JSON, the notice), no timer. */
    const settleMicrotasks = async () => {
        for (let i = 0; i < 50; i++) {
            await Promise.resolve();
        }
    };

    beforeEach(() => {
        // The fixture's chats hold no revision; the fence compares real tokens.
        seedChats(
            [
                { characterId: "c", id: "k", revision: rev(2) },
                { characterId: "c", id: "n", revision: rev(2) },
            ],
            [{ characterId: "c", revision: rev(1), ids: ["k", "n"] }],
        );
        // Earlier cases left their edits queued (their work listener takes nothing); a read applies
        // only to a chat without local work, so settle them as the save loop would.
        const work = takeChatWork(new Set());
        ackChatWork(
            work,
            work.groups.map((group) => ({ characterId: group.characterId, id: group.chatId, revision: rev(2) })),
            work.orders.map((order) => ({ characterId: order.characterId, revision: rev(1), ids: [...order.ids] })),
        );
        resetMemoryTasks();
        mocks.alertNormal.mockClear();
        mocks.flushResources.mockReset().mockResolvedValue({ discarded: [] });
        mocks.authFetch.mockReset();
    });

    afterEach(() => resetMemoryTasks());

    it("refuses an edit while the task runs and until the terminal's revision is in the mirror, and accepts after", () => {
        const modal = open(withData);
        expect(taskBlock(modal.target).dataset.risuMemoryTask).toBe("none");
        expect(startButton(modal.target).disabled).toBe(false);
        expect(cancelButton(modal.target)).toBeNull();

        frame({ taskId: "A", state: "running", done: 0, total: 1 });
        flushSync();
        expect(taskBlock(modal.target).dataset.risuMemoryTask).toBe("running");
        expect(taskBlock(modal.target).textContent).toContain(language.memoryTasks.running(0, 1));
        expect(startButton(modal.target).disabled).toBe(true);
        expect(cancelButton(modal.target)).not.toBeNull();
        modal.type("one, edited");
        expect(mocks.alertError).toHaveBeenCalledWith(language.memoryTasks.editFenced);
        expect(modal.textarea().value).toBe("one");
        expect(storedSummaries(withData)).toEqual(["one", "two"]);
        expect(chatWork).not.toHaveBeenCalled();
        // Lore writes are not fenced by a task: the generation fence does not know the chat.
        expect(generatingChatKeys().has(chatStatusKey(withData))).toBe(false);

        // The task ends at a revision the mirror lacks: still refused, waiting for the read.
        frame({
            taskId: "A",
            state: "done",
            done: 1,
            total: 1,
            terminalRevision: rev(3),
            lastCommittedRevision: rev(3),
        });
        flushSync();
        expect(taskBlock(modal.target).dataset.risuMemoryTask).toBe("done");
        expect(syncLine(modal.target)).not.toBeNull();
        expect(startButton(modal.target).disabled).toBe(false);
        expect(cancelButton(modal.target)).toBeNull();
        modal.type("one, again");
        expect(mocks.alertError).toHaveBeenCalledTimes(2);
        expect(mocks.alertError).toHaveBeenLastCalledWith(language.memoryTasks.editFenced);
        expect(modal.textarea().value).toBe("one");
        expect(storedSummaries(withData)).toEqual(["one", "two"]);

        // The read lands (the chat is replaced, which the fence reads reactively): the copy follows
        // the task's summaries, the line goes, and the next edit is written.
        expect(
            hydrateChat({ characterId: "c", id: "k", revision: rev(3), data: serverCopy(["one", "two", "three"]) }),
        ).toBe(true);
        flushSync();
        expect(modal.target.querySelectorAll("textarea")).toHaveLength(3);
        expect(syncLine(modal.target)).toBeNull();
        modal.type("one, later");
        expect(storedSummaries(withData)).toEqual(["one, later", "two", "three"]);
        expect(mocks.alertError).toHaveBeenCalledTimes(2);
        expect(chatWork).toHaveBeenCalled();
    });

    it("fences the chat during Summarize now's flush, shows the refusal, and offers Cancel for a waiting start", async () => {
        const modal = open(withData);
        let finishFlush!: (value: { discarded: string[] }) => void;
        mocks.flushResources.mockReturnValueOnce(new Promise((resolve) => (finishFlush = resolve)));
        mocks.authFetch.mockResolvedValueOnce(
            json(503, { error: "Memory tasks are not enabled", reason: "notEnabled" }),
        );
        startButton(modal.target).click();
        flushSync();
        expect(startButton(modal.target).disabled).toBe(true);
        // An edit while the flush runs would escape it: refused and undone.
        modal.type("one, edited");
        expect(mocks.alertError).toHaveBeenCalledWith(language.memoryTasks.editFenced);
        expect(modal.textarea().value).toBe("one");
        expect(storedSummaries(withData)).toEqual(["one", "two"]);
        expect(mocks.authFetch).not.toHaveBeenCalled();

        finishFlush({ discarded: [] });
        await settleMicrotasks();
        flushSync();
        expect(mocks.authFetch).toHaveBeenCalledTimes(1);
        expect(mocks.authFetch.mock.calls[0][0]).toBe(MEMORY_TASKS_PATH);
        expect(mocks.authFetch.mock.calls[0][1]).toMatchObject({ method: "POST" });
        expect(JSON.parse(mocks.authFetch.mock.calls[0][1]!.body as string)).toEqual({ characterId: "c", chatId: "k" });
        expect(mocks.alertError).toHaveBeenLastCalledWith(language.memoryTasks.notEnabled);
        expect(startButton(modal.target).disabled).toBe(false);
        // Released: the next edit is written.
        modal.type("one, edited");
        expect(storedSummaries(withData)).toEqual(["one, edited", "two"]);

        // A `pendingManual` answer: its notice and line, and Cancel ends the waiting start.
        mocks.authFetch.mockResolvedValueOnce(json(200, { outcome: "pendingManual" }));
        startButton(modal.target).click();
        await settleMicrotasks();
        flushSync();
        expect(mocks.alertNormal).toHaveBeenCalledWith(language.memoryTasks.pendingManual);
        expect(taskBlock(modal.target).textContent).toContain(language.memoryTasks.pendingManual);
        expect(cancelButton(modal.target)).not.toBeNull();
        mocks.authFetch.mockResolvedValueOnce(json(200, { cancelled: true }));
        cancelButton(modal.target)!.click();
        await settleMicrotasks();
        flushSync();
        expect(mocks.authFetch).toHaveBeenLastCalledWith(
            `${MEMORY_TASKS_PATH}/c/k`,
            expect.objectContaining({ method: "DELETE" }),
        );
        expect(cancelButton(modal.target)).toBeNull();
        expect(taskBlock(modal.target).textContent).not.toContain(language.memoryTasks.pendingManual);
    });
});
