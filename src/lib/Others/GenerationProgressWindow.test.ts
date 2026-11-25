import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GenerationProgressEntry } from "../../../shared/events.ts";

const mocks = vi.hoisted(() => ({
    openPinnedChat: vi.fn<typeof import("src/ts/globalApi.svelte").openPinnedChat>(),
}));

vi.mock("src/ts/globalApi.svelte", async () =>
    (await import("src/ts/tests/globalApiMock")).createGlobalApiMock({ openPinnedChat: mocks.openPinnedChat }),
);
vi.mock("src/ts/network/generationJobs", async () =>
    (await import("src/ts/network/tests/generationJobsMock")).createGenerationJobsMock({
        generationClientId: () => "this-tab",
    }),
);
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock(),
);
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import { language } from "src/lang";
import { replaceConnectedClients } from "src/ts/network/handoff";
import { replaceGenerations, resetGenerationProgress } from "src/ts/process/generationProgress.svelte";
import { selectChat } from "src/ts/storage/chatStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import GenerationProgressWindow from "./GenerationProgressWindow.svelte";

const selected: GenerationProgressEntry = {
    jobId: "selected-job",
    characterId: "alice",
    chatId: "selected",
    clientId: "this-tab",
    kind: "send",
    startedAt: 8000,
    at: 10000,
    stage: "memory",
    retry: 2,
};
let target: HTMLElement;
let component: ReturnType<typeof mount>;
const aside = () => target.querySelector("aside");
const rows = () => [...target.querySelectorAll<HTMLButtonElement>("aside button:not([aria-label])")];

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(1000);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1200);
    resetGenerationProgress();
    replaceConnectedClients([]);
    mocks.openPinnedChat.mockReset();
    installFlatDatabaseWithChats({
        generationProgressWindow: true,
        characters: [
            {
                chaId: "alice",
                type: "character",
                name: "Alice",
                chats: [{ id: "selected", name: "Current chat", message: [] }],
            },
            {
                chaId: "bob",
                type: "character",
                name: "Bob",
                chats: [{ id: "remote", name: "Other chat", message: [] }],
            },
        ],
    });
    selectCharacter("alice");
    selectChat("alice", "selected");
    target = document.createElement("div");
    document.body.append(target);
    component = mount(GenerationProgressWindow, { target });
    flushSync();
});

afterEach(async () => {
    await unmount(component);
    target.remove();
    resetGenerationProgress();
    replaceConnectedClients([]);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

it("stays hidden without listed jobs, for either preview kind, and while the setting is off", () => {
    expect(aside()).toBeNull();
    replaceGenerations([
        { ...selected, kind: "preview" },
        { ...selected, jobId: "prompt-preview", kind: "previewPrompt" },
    ]);
    flushSync();
    expect(aside()).toBeNull();
    replaceGenerations([selected]);
    flushSync();
    expect(aside()).not.toBeNull();
    settings.ui.generationProgressWindow = false;
    flushSync();
    expect(aside()).toBeNull();
});

it("shows selected-chat progress first, names and output when known, and a ticking collapsed pill", async () => {
    const remote: GenerationProgressEntry = {
        ...selected,
        jobId: "remote-job",
        characterId: "bob",
        chatId: "remote",
        clientId: "laptop",
        startedAt: 0,
        output: { tokens: 42, since: 4000, at: 10000 },
    };
    const unknown = {
        ...selected,
        jobId: "unknown-job",
        characterId: "missing",
        chatId: "missing",
        clientId: "unlisted-device",
        startedAt: 4000,
    };
    replaceConnectedClients([{ clientId: "laptop", name: "Work laptop", worker: false }]);
    replaceGenerations([unknown, remote, selected, { ...selected, jobId: "preview", kind: "preview" }]);
    flushSync();
    const [currentRow, remoteRow, unknownRow] = rows();
    expect(rows()).toHaveLength(3);
    expect(currentRow.textContent).toContain("Alice");
    expect(currentRow.textContent).toContain("Current chat");
    expect(currentRow.textContent).toContain(language.serverJob.stopOther.stages.memory);
    expect(currentRow.textContent).toContain(language.serverJob.retried.replace("{count}", "2"));
    expect(currentRow.textContent).toContain("0:02");
    expect(currentRow.textContent).not.toMatch(/≈|tokens/);
    expect(currentRow.textContent).not.toContain(language.generationProgress.anotherDevice);
    expect(remoteRow.textContent).toContain("Bob");
    expect(remoteRow.textContent).toContain("Other chat");
    expect(remoteRow.textContent).toContain("Work laptop");
    expect(remoteRow.textContent).toContain("≈42 tokens");
    expect(remoteRow.textContent).toMatch(/\b7(?:\.0+)? tokens\/s/);
    expect(unknownRow.textContent).toContain(language.generationProgress.character);
    expect(unknownRow.textContent).toContain(language.generationProgress.chat);
    expect(unknownRow.textContent).toContain(language.generationProgress.anotherDevice);
    expect(aside()?.querySelector(`[aria-label="${language.serverJob.stopOther.label}"]`)).toBeNull();

    remoteRow.click();
    expect(mocks.openPinnedChat).toHaveBeenCalledExactlyOnceWith({ chaId: "bob", chatId: "remote" });
    await vi.advanceTimersByTimeAsync(1000);
    flushSync();
    expect(currentRow.textContent).toContain("0:03");
    target.querySelector<HTMLButtonElement>(`[aria-label="${language.generationProgress.collapse}"]`)!.click();
    flushSync();
    const pill = target.querySelector<HTMLButtonElement>(`[aria-label="${language.generationProgress.expand}"]`)!;
    expect(pill.textContent).toContain(language.generationProgress.jobs.replace("{count}", "3"));
    expect(pill.textContent).toContain("0:03");
    expect(rows()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    flushSync();
    expect(pill.textContent).toContain("0:04");
    pill.click();
    flushSync();
    expect(rows()).toHaveLength(3);
});
