// @vitest-environment happy-dom

import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import { createFakeLockManager } from "src/ts/storage/tests/fakeLockManager";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { FakeResourceServer } from "src/ts/storage/tests/fakeResourceServer";
import { pageDraftJournal } from "src/ts/storage/draftJournal";
import { seedChats, selectChat } from "src/ts/storage/chatStore.svelte";
import { seedResources } from "src/ts/storage/resourceSync.svelte";
import { selectCharacter, selection } from "src/ts/storage/selection.svelte";
import { language } from "src/lang";

const io = vi.hoisted(() => ({
    server: null as FakeResourceServer | null,
    inlayWritten: null as (() => void) | null,
    createJob: vi.fn<typeof import("src/ts/network/generationJobs").createGenerationJob>(),
    selectFiles: vi.fn<typeof import("src/ts/util").selectMultipleFile>(),
}));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({
        authFetch: async (path, init) => {
            const response = path === "/api/write" ? Response.json({ ok: true }) : await io.server!.fetch(path, init);
            if (path.startsWith("/api/resources/inlays/") && init?.method === "PUT") io.inlayWritten?.();
            return response;
        },
    }),
);
vi.mock("src/ts/util", async (original) => ({
    ...(await original<typeof import("src/ts/util")>()),
    selectMultipleFile: io.selectFiles,
}));
vi.mock("src/ts/network/generationJobs", async () =>
    (await import("src/ts/network/tests/generationJobsMock")).createGenerationJobsMock({
        createGenerationJob: io.createJob,
    }),
);
for (const child of [
    "./Chat.svelte",
    "./Chats.svelte",
    "./Suggestion.svelte",
    "./CreatorQuote.svelte",
    "./ContextMeter.svelte",
    "../UI/MainMenu.svelte",
    "../UI/RefusedDataBanner.svelte",
])
    vi.doMock(child, () => ({ default: () => {} }));

const a = "c\u0000a";
const b = "c\u0000b";
let screen: ReturnType<typeof mount> | undefined;
const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

async function drive<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    const result = promise.finally(() => {
        done = true;
    });
    for (let step = 0; !done && step < 2000; step++) await vi.advanceTimersByTimeAsync(1);
    expect(done, "I/O completed under the controlled clock").toBe(true);
    flushSync();
    return result;
}

async function until(check: () => boolean) {
    for (let step = 0; !check() && step < 2000; step++) {
        await vi.advanceTimersByTimeAsync(1);
        flushSync();
    }
    expect(check()).toBe(true);
}

afterEach(async () => {
    if (screen) await unmount(screen);
    await drive(pageDraftJournal().close());
    document.body.innerHTML = "";
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
    else Reflect.deleteProperty(navigator, "locks");
});

it("journals screen sends, restores on switch, flushes on hide, and tracks attachments", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(1_700_000_000_000);
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    Object.defineProperty(navigator, "locks", { value: createFakeLockManager(), configurable: true });
    sessionStorage.clear();
    io.server = new FakeResourceServer();
    const chats = ["a", "b"].map((id) => ({
        id,
        name: id,
        message: [
            { role: "user" as const, data: "earlier question", chatId: `${id}-user` },
            { role: "char" as const, data: "earlier answer", chatId: `${id}-answer` },
        ],
        note: "",
        localLore: [],
        modelPresetId: "preset",
        promptPresetId: "preset",
        bindedPersona: "persona",
    }));
    const character = {
        chaId: "c",
        type: "character",
        name: "C",
        image: "",
        firstMessage: "",
        alternateGreetings: [],
        creatorNotes: "",
        globalLore: [],
        customscript: [],
    };
    installFlatDatabaseWithChats({
        characters: [{ ...character, chats }],
        botPresets: [{ id: "preset", name: "Preset" }],
        personas: [{ id: "persona", name: "User", icon: "" }],
        modules: [],
        plugins: [],
        theme: "classic",
        autoScrollToNewMessage: false,
        useAutoTranslateInput: false,
    });
    seedChats(
        chats.map((data) => ({ characterId: "c", id: data.id, revision: "r1", data })),
        [{ characterId: "c", revision: "o1", ids: ["a", "b"] }],
    );
    seedResources({ epoch: io.server.epoch, kinds: { characters: [{ id: "c", revision: "r1", data: character }] } });
    selectCharacter("c");
    selectChat("c", "a");
    selection.chatOpen = true;
    const journal = pageDraftJournal();
    await drive(journal.putComposer(b, { input: "B from a previous page", translate: "", files: [] }));
    const { default: DefaultChatScreen } = await import("./DefaultChatScreen.svelte");
    const target = document.createElement("div");
    document.body.append(target);
    screen = mount(DefaultChatScreen, { target });
    flushSync();
    const input = () => target.querySelector<HTMLTextAreaElement>("textarea.text-input-area")!;
    const type = (text: string) => {
        input().value = text;
        input().dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
    };
    const click = (element: Element | null) => {
        expect(element).not.toBeNull();
        (element as HTMLElement).click();
        flushSync();
    };
    const menuItem = (text: string) =>
        [...target.querySelectorAll("span")].find((node) => node.textContent === text)!.parentElement;
    const menu = () => click(target.querySelector("svg.lucide-menu")?.closest("button") ?? null);
    const hide = () => {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
    };

    async function attach() {
        // Await the upload itself before driving UI timers; hashing the media has no time budget.
        const written = new Promise<void>((resolve) => {
            io.inlayWritten = resolve;
        });
        click(menuItem(language.postFile));
        await written;
        await until(() => target.querySelector("audio") !== null);
        io.inlayWritten = null;
    }

    type("A to send");
    menu();
    io.selectFiles.mockResolvedValue([{ name: "voice.mp3", data: new Uint8Array([1, 2, 3]) }]);
    await attach();
    hide();
    const attached = await drive(journal.readComposer(a));
    expect(attached).toMatchObject({ input: "A to send", files: [expect.any(String)] });
    click(target.querySelector("audio")!.parentElement!.querySelector("button"));
    hide();
    expect(await drive(journal.readComposer(a))).toEqual({ input: "A to send", translate: "", files: [] });
    // Add again so the send must hand off both text and its queued attachment.
    menu();
    await attach();
    hide();
    const sendFiles = (await drive(journal.readComposer(a)))!.files;
    expect(sendFiles).toHaveLength(1);
    let refuse!: (error: Error) => void;
    io.createJob.mockImplementationOnce(
        () =>
            new Promise((_, reject) => {
                refuse = reject;
            }),
    );
    click(target.querySelector(".button-icon-send"));
    await until(() => io.createJob.mock.calls.length === 1);
    const request = io.createJob.mock.calls[0][0];
    expect(request.context.userMessageId).toEqual(expect.any(String));
    expect(request.context.input).toBe(`A to send{{inlayed::${sendFiles[0]}}}`);
    expect(input().value).toBe("");
    expect(await drive(journal.readComposer(a))).toEqual({
        state: "sending",
        input: "A to send",
        translate: "",
        files: sendFiles,
        userMessageId: request.context.userMessageId,
    });

    selectChat("c", "b");
    flushSync();
    await until(() => input().value === "B from a previous page");
    type("B edited before hide");
    hide();
    expect(await drive(journal.readComposer(b))).toEqual({ input: "B edited before hide", translate: "", files: [] });
    refuse(new Error("response lost"));
    await tick();
    await vi.advanceTimersByTimeAsync(1);
    selectChat("c", "a");
    flushSync();
    // In-page recovery takes precedence over the journal's pre-consumption fields.
    await until(() => input().value === `A to send{{inlayed::${sendFiles[0]}}}`);
    expect(target.querySelector("audio")).toBeNull();
    expect(io.createJob).toHaveBeenCalledTimes(1);
    hide();
    expect(await drive(journal.readComposer(a))).toEqual({
        input: `A to send{{inlayed::${sendFiles[0]}}}`,
        translate: "",
        files: [],
        userMessageId: request.context.userMessageId,
    });
});
