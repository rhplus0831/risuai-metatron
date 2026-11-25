import { flushSync, mount, unmount } from "svelte";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GenerationProgressEntry } from "../../../shared/events.ts";
import { createFakeLockManager } from "src/ts/storage/tests/fakeLockManager";
import type { ChatsControl } from "./tests/ChatsStub.svelte";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock(),
);
vi.mock("src/ts/network/generationJobs", async () =>
    (await import("src/ts/network/tests/generationJobsMock")).createGenerationJobsMock({
        generationClientId: () => "this-tab",
    }),
);
vi.mock("./Chats.svelte", async () => {
    const stub = await import("./tests/ChatsStub.svelte");
    stub.setChatsControl({
        followsLatest: () => false,
        scrollToLatestMessage: () => {},
        readProps: null,
        setHolding: null,
    } satisfies ChatsControl);
    return { default: stub.default };
});
for (const child of [
    "./Chat.svelte",
    "./Suggestion.svelte",
    "./CreatorQuote.svelte",
    "./ContextMeter.svelte",
    "../UI/MainMenu.svelte",
    "../UI/RefusedDataBanner.svelte",
])
    vi.doMock(child, () => ({ default: () => {} }));

import { language } from "src/lang";
import { resetChatStatusForTests } from "src/ts/process/chatStatus.svelte";
import { noteGenerationFrame, resetGenerationProgress } from "src/ts/process/generationProgress.svelte";
import { dropJobStage, resetJobStagesForTests, setJobStage } from "src/ts/process/jobStages";
import { followedJobs } from "src/ts/process/serverCommands";
import { selectChat } from "src/ts/storage/chatStore.svelte";
import { pageDraftJournal } from "src/ts/storage/draftJournal";
import { seedResources } from "src/ts/storage/resourceSync.svelte";
import { selectCharacter, selection } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";

const entry: GenerationProgressEntry = {
    jobId: "foreign-job",
    characterId: "c",
    chatId: "k",
    clientId: "other-device",
    kind: "send",
    startedAt: 1000,
    at: 2000,
    stage: "preparing",
};
const locks = Object.getOwnPropertyDescriptor(navigator, "locks");
let target: HTMLElement;
let component: ReturnType<typeof mount>;

async function settle<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    const result = promise.finally(() => (done = true));
    for (let step = 0; !done && step < 2000; step++) await vi.advanceTimersByTimeAsync(1);
    expect(done, "IndexedDB work completed under the controlled clock").toBe(true);
    return result;
}

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(2000);
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    Object.defineProperty(navigator, "locks", { value: createFakeLockManager(), configurable: true });
    resetGenerationProgress();
    resetJobStagesForTests();
    resetChatStatusForTests();
    followedJobs.set(new Map());
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "Character",
                image: "",
                firstMessage: "",
                creatorNotes: "",
                alternateGreetings: [],
                globalLore: [],
                customscript: [],
                chats: [
                    {
                        id: "k",
                        name: "Chat",
                        message: [{ role: "char", data: "Hello", chatId: "reply" }],
                        note: "",
                        localLore: [],
                    },
                ],
            },
        ],
        modules: [],
        plugins: [],
        theme: "classic",
    });
    seedResources({ epoch: "11111111-2222-4333-8444-555555555555", kinds: {} });
    selectCharacter("c");
    selectChat("c", "k");
    selection.chatOpen = true;
    await settle(pageDraftJournal().start());
    const { default: DefaultChatScreen } = await import("./DefaultChatScreen.svelte");
    target = document.createElement("div");
    document.body.append(target);
    component = mount(DefaultChatScreen, { target });
    flushSync();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
});

afterEach(async () => {
    if (component) await unmount(component);
    // The journal owns an IndexedDB connection beyond the component's lifetime.
    await settle(pageDraftJournal().close());
    target?.remove();
    resetGenerationProgress();
    resetJobStagesForTests();
    resetChatStatusForTests();
    followedJobs.set(new Map());
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (locks) Object.defineProperty(navigator, "locks", locks);
    else Reflect.deleteProperty(navigator, "locks");
});

it("shows Stop-other with the foreign job's stage and hides it for this tab, another chat, removal, or an own Stop", () => {
    const stopOther = () =>
        target.querySelector<HTMLButtonElement>(`[aria-label="${language.serverJob.stopOther.label}"]`);
    expect(stopOther()).toBeNull();
    noteGenerationFrame({ ...entry, state: "running", clientId: "this-tab" });
    flushSync();
    expect(stopOther()).toBeNull();
    noteGenerationFrame({ ...entry, state: "running", chatId: "other-chat" });
    flushSync();
    expect(stopOther()).toBeNull();
    for (const [stage, ring] of [
        ["preparing", 1],
        ["memory", 2],
        ["generating", 3],
        ["finishing", 4],
    ] as const) {
        noteGenerationFrame({ ...entry, state: "running", stage });
        flushSync();
        expect(stopOther()).not.toBeNull();
        expect(stopOther()!.querySelector(`.chat-process-stage-${ring}`)).not.toBeNull();
    }
    followedJobs.set(new Map([["own-job", "c\u0000k"]]));
    flushSync();
    expect(stopOther()).toBeNull();
    followedJobs.set(new Map());
    flushSync();
    expect(stopOther()).not.toBeNull();
    noteGenerationFrame({ state: "ended", jobId: entry.jobId, characterId: "c", chatId: "k" });
    flushSync();
    expect(stopOther()).toBeNull();
});

it("uses the chat's foreign stage for Stop until this screen has its own staged job", () => {
    const stop = () => target.querySelector<HTMLButtonElement>('button[aria-labelledby="cancel"]');
    followedJobs.set(new Map([["own-job", "c\u0000k"]]));
    setJobStage("other-chat-job", { chaId: "c", chatId: "other-chat" }, "finishing");
    flushSync();
    expect(stop()).not.toBeNull();
    expect(stop()!.querySelector(".chat-process-stage-0")).not.toBeNull();

    for (const [stage, ring] of [
        ["preparing", 1],
        ["memory", 2],
        ["generating", 3],
        ["finishing", 4],
    ] as const) {
        noteGenerationFrame({ ...entry, state: "running", stage });
        flushSync();
        expect(stop()!.querySelector(`.chat-process-stage-${ring}`)).not.toBeNull();
    }

    setJobStage("own-job", { chaId: "c", chatId: "k" }, "memory");
    flushSync();
    expect(stop()!.querySelector(".chat-process-stage-2")).not.toBeNull();
    dropJobStage("own-job");
    flushSync();
    expect(stop()!.querySelector(".chat-process-stage-4")).not.toBeNull();

    noteGenerationFrame({ state: "ended", jobId: entry.jobId, characterId: "c", chatId: "k" });
    flushSync();
    expect(stop()!.querySelector(".chat-process-stage-0")).not.toBeNull();
});
