// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The HypaV3 progress overlay as `App` mounts it (the real `App` markup over the real stores, chat
// module, and selection; every other child of `App` is a stub): the selected chat's memory run from
// `memoryProgressStore` (a chat switch hides and restores it without a new notice), else the legacy
// `hypaV3ProgressStore` (hidden only for a value a job's `progress` notice wrote while that job
// reports a memory run for another chat); the phase, reason, counts, bar, and queue text of a run;
// "Stop here and continue" on an initial run calling `stopMemoryRun` once with the job and run
// captured at the click, and disabled by the entry's stop state across a remount. The request itself
// is `jobChannel.test.ts`'s.

const mocks = vi.hoisted(() => ({
    stopMemoryRun: vi.fn<(jobId: string, runId: string) => Promise<void>>(async () => {}),
}));

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/network/jobChannel", () => ({ stopMemoryRun: mocks.stopMemoryRun }));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
    addImportedModule: vi.fn(),
    importModuleFile: vi.fn(),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({}));
vi.mock("src/ts/parser/transformClient", () => ({
    resetTransformEffects: vi.fn(),
    captureTransform: vi.fn(),
    serverProcessScript: vi.fn(),
}));
vi.mock("src/ts/characterCards", async () => ({
    showRealmInfoStore: (await import("svelte/store")).writable(null),
    importCharacterProcess: vi.fn(),
}));
vi.mock("src/ts/storage/presets.svelte", () => ({ importPreset: vi.fn() }));
vi.mock("src/ts/globalApi.svelte", () => ({ checkCharOrder: vi.fn(), downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("src/etc/send.mp3", () => ({ default: "" }));
// `App`'s other children render nothing here.
for (const child of [
    "src/lib/SideBars/Sidebar.svelte",
    "src/lib/ChatScreens/ChatScreen.svelte",
    "src/lib/Others/AlertComp.svelte",
    "src/lib/Others/ReloadNotice.svelte",
    "src/lib/Others/TerminalNotice.svelte",
    "src/lib/Others/PushPrompt.svelte",
    "src/lib/UI/Realm/RealmPopUp.svelte",
    "src/lib/Others/GridCatalog.svelte",
    "src/lib/Others/BookmarkList.svelte",
    "src/lib/Others/MessageSearch.svelte",
    "src/lib/Setting/Settings.svelte",
    "src/lib/Others/SavePopupIcon.svelte",
    "src/lib/Setting/botpreset.svelte",
    "src/lib/Setting/listedPersona.svelte",
    "src/lib/Others/ChatBindingDialog.svelte",
    "src/lib/Others/HypaV3Modal.svelte",
    "src/lib/UI/PopupList.svelte",
    "src/lib/Others/PopupEditor.svelte",
    "src/lib/Others/IrisModal.svelte",
]) {
    vi.doMock(child, () => ({ default: () => {} }));
}

import { language } from "src/lang";
import { selectChat, type ChatRef } from "src/ts/storage/chatStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { hypaV3ProgressStore, memoryProgressStore, type MemoryProgressEntry } from "src/ts/stores.svelte";

type App = typeof import("src/App.svelte").default;

const chatK: ChatRef = { chaId: "c", chatId: "k" };
const chatN: ChatRef = { chaId: "c", chatId: "n" };
const closedLegacy = { open: false, miniMsg: "", msg: "", subMsg: "" };
const mounted: ReturnType<typeof mount>[] = [];
let App: App;
let target: HTMLElement;

/** An open run of `jobId` in `chatRef`, as `jobChannel.ts` records it. */
function run(
    jobId: string,
    runId: string,
    chatRef: ChatRef,
    fields: Partial<Omit<MemoryProgressEntry, "jobId" | "runId" | "chatRef" | "open">> = {},
): MemoryProgressEntry {
    return { chatRef, runId, open: true, phase: "blocking", reason: null, stop: "idle", ...fields, jobId };
}
/** Puts `runs` into the store, in order, as the job's chats. */
function setRuns(...runs: MemoryProgressEntry[]) {
    memoryProgressStore.set({
        runs: Object.fromEntries(runs.map((entry) => [entry.jobId, entry])),
        chats: Object.fromEntries(runs.map((entry) => [entry.jobId, entry.chatRef])),
        legacy: null,
    });
    flushSync();
}
function select(ref: ChatRef | null) {
    selectCharacter(ref?.chaId ?? null);
    if (ref) {
        selectChat(ref.chaId, ref.chatId);
    }
    flushSync();
}

/** The collapsed overlay's button, or null while nothing shows. */
const collapsed = () => target.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
const expanded = () => target.querySelector<HTMLElement>('button[aria-expanded="true"]');
const shown = () => collapsed() !== null || expanded() !== null;
const mini = () => collapsed()?.textContent?.trim() ?? null;
const expand = () => {
    collapsed()!.click();
    flushSync();
};
/** The expanded panel (the collapse button's parent). */
const panel = () => expanded()!.parentElement!;
const title = () => expanded()!.querySelector("span")!.textContent;
const reason = () => panel().querySelector("[data-memory-reason]")?.textContent ?? null;
const bar = () => panel().querySelector<HTMLElement>("[role=progressbar]");
const detail = () => [...panel().querySelectorAll(":scope > span")].at(-1)!.textContent;
const stopButton = () => panel().querySelector<HTMLButtonElement>("[data-memory-stop]");

beforeAll(async () => {
    App = (await import("src/App.svelte")).default;
}, 60_000);

beforeEach(() => {
    mocks.stopMemoryRun.mockReset().mockImplementation(async () => {});
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "C",
                firstMessage: "Hello",
                chatPage: 0,
                chats: [
                    { id: "k", name: "K", note: "", localLore: [], message: [] },
                    { id: "n", name: "N", note: "", localLore: [], message: [] },
                ],
            },
        ],
    } as any);
    hypaV3ProgressStore.set({ ...closedLegacy });
    memoryProgressStore.set({ runs: {}, chats: {}, legacy: null });
    select(chatK);
    target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(App, { target }));
    flushSync();
});

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
});

describe("the memory progress overlay in App", () => {
    it("shows the selected chat's run; a chat switch hides and restores it without a new notice", () => {
        expect(shown()).toBe(false);
        setRuns(run("A", "r1", chatK, { done: 1, total: 4 }));
        expect(mini()).toBe("1/4");
        select(chatN);
        expect(shown()).toBe(false);
        select(chatK);
        expect(mini()).toBe("1/4");
        select(null);
        expect(shown()).toBe(false);
        // Each chat shows its own job's run; the same chat's newest run wins.
        setRuns(run("A", "r1", chatK, { done: 1, total: 4 }), run("B", "r2", chatN, { done: 2, total: 2 }));
        select(chatN);
        expect(mini()).toBe("2/2");
        select(chatK);
        expect(mini()).toBe("1/4");
        setRuns(run("A", "r1", chatK, { done: 1, total: 4 }), run("B", "r3", chatK, { done: 3, total: 4 }));
        expect(mini()).toBe("3/4");
    });

    it("shows the legacy store when the selected chat has no run, except a job's value for another chat", () => {
        hypaV3ProgressStore.set({ open: true, miniMsg: "m", msg: "legacy title", subMsg: "legacy detail" });
        flushSync();
        expect(mini()).toBe("m");
        expand();
        expect(title()).toBe("legacy title");
        expect(detail()).toBe("legacy detail");
        expect(reason()).toBeNull();
        expect(bar()).toBeNull();
        expect(stopButton()).toBeNull();
        // A run in the selected chat takes the overlay over the legacy value; another chat's run does not.
        setRuns(run("A", "r1", chatN));
        expect(title()).toBe("legacy title");
        setRuns(run("A", "r1", chatK));
        expect(title()).toBe(language.hypaV3Progress.phaseBlocking);
        memoryProgressStore.set({ runs: {}, chats: {}, legacy: null });
        flushSync();
        expect(title()).toBe("legacy title");

        // The value a job's `progress` notice wrote shows only in that job's memory chat; a chat switch
        // alone hides and shows it. A structurally equal value written by the client copy shows anywhere.
        const value = { open: true, miniMsg: "m", msg: "job value", subMsg: "" };
        hypaV3ProgressStore.set(value);
        memoryProgressStore.set({ runs: {}, chats: { A: chatN }, legacy: { value, jobId: "A" } });
        flushSync();
        expect(shown()).toBe(false);
        select(chatN);
        expect(mini()).toBe("m");
        select(null);
        expect(shown()).toBe(false);
        select(chatK);
        expect(shown()).toBe(false);
        hypaV3ProgressStore.set({ ...value });
        flushSync();
        expect(mini()).toBe("m");
        // Without a known chat for the job, the value shows.
        hypaV3ProgressStore.set(value);
        memoryProgressStore.set({ runs: {}, chats: {}, legacy: { value, jobId: "A" } });
        flushSync();
        expect(mini()).toBe("m");
        hypaV3ProgressStore.set({ ...closedLegacy });
        flushSync();
        expect(shown()).toBe(false);
    });

    it("renders a selection's embedding queue, a reason-less blocking run with counts, and an initial run's reason and clamped bar", () => {
        setRuns(run("A", "r1", chatK, { phase: "selection", text: "Embedding 3 of 12" }));
        expect(mini()).toBe("");
        expect(collapsed()!.getAttribute("aria-label")).toBe(language.hypaV3Progress.expand);
        expand();
        expect(title()).toBe(language.hypaV3Progress.phaseSelection);
        expect(reason()).toBeNull();
        expect(bar()).toBeNull();
        expect(detail()).toBe("Embedding 3 of 12");
        expect(stopButton()).toBeNull();

        setRuns(run("A", "r1", chatK, { done: 0, total: 4 }));
        expect(title()).toBe(language.hypaV3Progress.phaseBlocking);
        expect(reason()).toBeNull();
        expect(bar()!.getAttribute("aria-label")).toBe(language.hypaV3Progress.phaseBlocking);
        expect(bar()!.getAttribute("aria-valuenow")).toBe("0");
        expect(bar()!.getAttribute("aria-valuemax")).toBe("100");
        expect(bar()!.getAttribute("aria-valuetext")).toBe("0/4");
        expect(bar()!.firstElementChild!.getAttribute("style")).toContain("width: 0%");
        expect(detail()).toBe("0/4");
        expect(stopButton()).toBeNull();
        // The bar is not inside the collapse button.
        expect(expanded()!.contains(bar())).toBe(false);

        setRuns(run("A", "r1", chatK, { phase: "initial", reason: "gap", done: 5, total: 4 }));
        expect(title()).toBe(language.hypaV3Progress.phaseInitial);
        expect(reason()).toBe(language.hypaV3Progress.reasonGap);
        expect(bar()!.getAttribute("aria-valuenow")).toBe("100");
        expect(bar()!.firstElementChild!.getAttribute("style")).toContain("width: 100%");
        expect(detail()).toBe("5/4");
        expect(stopButton()!.textContent?.trim()).toBe(language.hypaV3Progress.stopButton);
        expect(stopButton()!.disabled).toBe(false);
        // Counts without a total show the indeterminate bar.
        setRuns(run("A", "r1", chatK, { phase: "initial", reason: "pluginModel", done: 0, total: 0 }));
        expect(reason()).toBe(language.hypaV3Progress.reasonPluginModel);
        expect(bar()).toBeNull();
        expect(detail()).toBe("0/0");
    });

    it("the stop button calls the action once with the job and run captured at the click, and follows the entry's stop state across a remount", async () => {
        setRuns(run("A", "r1", chatK, { phase: "initial", reason: "gap", done: 1, total: 4 }));
        expand();
        // The action's first step, as `stopMemoryRun` does it: the run goes pending.
        mocks.stopMemoryRun.mockImplementation(async (jobId, runId) => {
            memoryProgressStore.update((state) => {
                const held = state.runs[jobId];
                return held?.runId === runId
                    ? { ...state, runs: { ...state.runs, [jobId]: { ...held, stop: "pending" } } }
                    : state;
            });
        });
        stopButton()!.click();
        // The run is replaced before the action module loads: the click's ids are the ones used.
        setRuns(run("A", "r2", chatK, { phase: "initial", reason: "gap", done: 2, total: 4 }));
        await vi.waitFor(() => expect(mocks.stopMemoryRun).toHaveBeenCalledTimes(1));
        expect(mocks.stopMemoryRun).toHaveBeenCalledWith("A", "r1");
        flushSync();
        expect(stopButton()!.disabled).toBe(false);

        stopButton()!.click();
        await vi.waitFor(() => expect(mocks.stopMemoryRun).toHaveBeenCalledTimes(2));
        expect(mocks.stopMemoryRun).toHaveBeenLastCalledWith("A", "r2");
        flushSync();
        expect(stopButton()!.disabled).toBe(true);
        expect(stopButton()!.textContent?.trim()).toBe(language.hypaV3Progress.stopButton);
        stopButton()!.click();
        await Promise.resolve();
        await Promise.resolve();
        expect(mocks.stopMemoryRun).toHaveBeenCalledTimes(2);

        // The state lives in the store: a chat switch and back remounts the overlay still disabled.
        select(chatN);
        expect(shown()).toBe(false);
        select(chatK);
        expand();
        expect(stopButton()!.disabled).toBe(true);
        memoryProgressStore.update((state) => ({
            ...state,
            runs: { A: { ...state.runs.A, stop: "requested" } },
        }));
        flushSync();
        expect(stopButton()!.disabled).toBe(true);
        expect(stopButton()!.textContent?.trim()).toBe(language.hypaV3Progress.stopping);
        memoryProgressStore.update((state) => ({
            ...state,
            runs: { A: { ...state.runs.A, stop: "unavailable" } },
        }));
        flushSync();
        expect(stopButton()!.disabled).toBe(true);
        expect(stopButton()!.textContent?.trim()).toBe(language.hypaV3Progress.stopButton);
        // A blocking run of the same job has no stop control.
        setRuns(run("A", "r3", chatK, { done: 1, total: 4 }));
        expect(stopButton()).toBeNull();
    });
});
