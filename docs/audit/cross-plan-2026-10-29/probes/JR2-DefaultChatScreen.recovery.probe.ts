// @vitest-environment happy-dom

import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { createFakeLockManager } from "src/ts/storage/tests/fakeLockManager";
import { FakeResourceServer } from "src/ts/storage/tests/fakeResourceServer";
import { language } from "src/lang";

const io = vi.hoisted(() => ({
    server: null as FakeResourceServer | null,
    inlayWritten: null as (() => void) | null,
    createJob: vi.fn<typeof import("src/ts/network/generationJobs").createGenerationJob>(),
    generationFetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
    selectFiles: vi.fn<typeof import("src/ts/util").selectMultipleFile>(),
    confirm: vi.fn<typeof import("src/ts/alert").alertConfirm>(),
    alertError: vi.fn<typeof import("src/ts/alert").alertError>(),
}));
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: io.confirm,
        alertError: io.alertError,
    }),
);
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({
        authFetch: async (path, init, options) => {
            options?.beforeDispatch?.();
            if (path.startsWith("/api/generations")) return io.generationFetch(path, init);
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
let flushSync: typeof import("svelte").flushSync;
let mount: typeof import("svelte").mount;
let tick: typeof import("svelte").tick;
let unmount: typeof import("svelte").unmount;
let selectChat: typeof import("src/ts/storage/chatStore.svelte").selectChat;
let pageDraftJournal: typeof import("src/ts/storage/draftJournal").pageDraftJournal;
let createHttpJob: typeof import("src/ts/network/generationJobs").createGenerationJob;
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
    screen = undefined;
    await drive(pageDraftJournal().close());
    document.body.innerHTML = "";
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
    else Reflect.deleteProperty(navigator, "locks");
});

async function mountComposer({ reload = false } = {}) {
    // Clearing the old page's timers also resets the fake clock; retain its time across reload.
    const pageTime = reload ? Date.now() : 1_700_000_000_000;
    if (reload) {
        await unmount(screen!);
        screen = undefined;
        await drive(pageDraftJournal().close());
        document.body.innerHTML = "";
        vi.clearAllTimers();
    }
    // On reload, keep IndexedDB and the server but discard every client module, including the composer.
    vi.resetModules();
    io.createJob.mockReset();
    io.generationFetch.mockReset();
    io.confirm.mockReset().mockResolvedValue(false);
    io.alertError.mockReset();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(pageTime);
    if (!reload) {
        vi.stubGlobal("indexedDB", new IDBFactory());
        vi.stubGlobal("IDBKeyRange", IDBKeyRange);
        Object.defineProperty(navigator, "locks", { value: createFakeLockManager(), configurable: true });
        sessionStorage.clear();
        io.server = new FakeResourceServer();
    }
    // The fixture, UI and Svelte runtime must all belong to the newly imported module graph.
    ({ flushSync, mount, tick, unmount } = await import("svelte"));
    ({ pageDraftJournal } = await import("src/ts/storage/draftJournal"));
    const { installFlatDatabaseWithChats } = await import("src/ts/storage/tests/installFlatDatabase");
    const chatStore = await import("src/ts/storage/chatStore.svelte");
    const { seedChats } = chatStore;
    selectChat = chatStore.selectChat;
    const { seedResources } = await import("src/ts/storage/resourceSync.svelte");
    const { selectCharacter, selection } = await import("src/ts/storage/selection.svelte");
    const transport = await import("src/ts/network/generationJobs");
    createHttpJob = transport.createGenerationJob;
    vi.spyOn(transport, "createGenerationJob").mockImplementation(io.createJob);
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
    seedResources({ epoch: io.server!.epoch, kinds: { characters: [{ id: "c", revision: "r1", data: character }] } });
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

    return { target, input, type, click, menuItem, menu, hide, journal };
}

it("keeps the unlanded send durable while a user types and clears the next composer", async () => {
    const { target, input, type, click, journal } = await mountComposer();
    type("Long original message that has not reached the server");
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
    expect(await drive(journal.readComposer(a))).toMatchObject({ state: "sending", requestId: request.requestId });
    expect(input().disabled).toBe(false);
    type("A possible follow-up");
    await vi.advanceTimersByTimeAsync(600);
    console.log("journal while original send is pending:", JSON.stringify(await drive(journal.readComposer(a))));
    // Changing one's mind about the next message must not discard the in-flight original.
    type("");
    await vi.advanceTimersByTimeAsync(600);
    const durable = await drive(journal.readComposer(a));
    console.log("journal after clearing follow-up:", JSON.stringify(durable));
    const reloaded = await mountComposer({ reload: true });
    await drive(reloaded.journal.readComposer(a));
    refuse(new Error("old request did not reach admission"));
    await vi.advanceTimersByTimeAsync(1);
    console.log(
        "input after reload:",
        JSON.stringify(reloaded.input().value),
        "journal:",
        JSON.stringify(await drive(reloaded.journal.readComposer(a))),
    );
    expect(reloaded.input().value).toBe(request.context.input);
});
