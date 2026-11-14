// @vitest-environment happy-dom

import { get } from "svelte/store";
import { loreBudgetStopFixture, loreBudgetTerminal } from "src/ts/process/tests/loreBudgetStopFixture";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { createFakeLockManager } from "src/ts/storage/tests/fakeLockManager";
import { FakeResourceServer } from "src/ts/storage/tests/fakeResourceServer";
import { language } from "src/lang";
import type { ChatGroup } from "../../../shared/chats";
import type { Chat } from "../../../shared/database";
import type { ResourceBatchResult } from "../../../shared/resources";
import type { ChatsControl } from "./tests/ChatsStub.svelte";

const transcript = vi.hoisted(() => ({
    followsLatest: vi.fn<ChatsControl["followsLatest"]>(),
    scrollToLatestMessage: vi.fn<ChatsControl["scrollToLatestMessage"]>(),
    readProps: null as ChatsControl["readProps"],
    setHolding: null as ChatsControl["setHolding"],
}));

const io = vi.hoisted(() => ({
    server: null as FakeResourceServer | null,
    inlayWritten: null as (() => void) | null,
    runInputHook: vi.fn<typeof import("src/ts/process/inputHooks").runInputHook>(),
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
const originalComposerGlobals = new Map(
    ["indexedDB", "IDBKeyRange", "WebSocket"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);

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
    const { loreBudgetStopDialog } = await import("src/ts/stores.svelte");
    while (get(loreBudgetStopDialog)) get(loreBudgetStopDialog)!.resolve("close");
    if (screen) await unmount(screen);
    screen = undefined;
    await drive(pageDraftJournal().close());
    document.body.innerHTML = "";
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const [name, descriptor] of originalComposerGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
    if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
    else Reflect.deleteProperty(navigator, "locks");
});

async function mountComposer({
    reload = false,
    configureChat,
    configureCharacter,
    chatLoadInitialPages,
    characterId = "c",
}: {
    characterId?: string;
    reload?: boolean;
    configureChat?: (chat: Chat) => void;
    configureCharacter?: (character: Record<string, unknown>) => void;
    chatLoadInitialPages?: number;
} = {}) {
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
    vi.doMock("./Chats.svelte", async () => {
        const stub = await import("./tests/ChatsStub.svelte");
        stub.setChatsControl(transcript);
        return { default: stub.default };
    });
    io.createJob.mockReset();
    io.runInputHook.mockReset();
    io.generationFetch.mockReset();
    io.confirm.mockReset().mockResolvedValue(false);
    io.alertError.mockReset();
    transcript.followsLatest.mockReset().mockReturnValue(false);
    transcript.scrollToLatestMessage.mockReset();
    transcript.readProps = null;
    transcript.setHolding = null;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.setSystemTime(pageTime);
    if (!reload) {
        vi.stubGlobal("indexedDB", new IDBFactory());
        vi.stubGlobal("IDBKeyRange", IDBKeyRange);
        Object.defineProperty(navigator, "locks", { value: createFakeLockManager(), configurable: true });
        sessionStorage.clear();
        io.server = new FakeResourceServer();
        io.server.epoch = "11111111-2222-4333-8444-555555555555";
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
    const hooks = await import("src/ts/process/inputHooks");
    vi.spyOn(hooks, "runInputHook").mockImplementation(io.runInputHook);
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
        chaId: characterId,
        type: "character",
        name: "C",
        image: "",
        firstMessage: "",
        alternateGreetings: [],
        creatorNotes: "",
        globalLore: [],
        customscript: [],
    };
    configureChat?.(chats[0]);
    configureCharacter?.(character);
    installFlatDatabaseWithChats({
        characters: [{ ...character, chats }],
        botPresets: [{ id: "preset", name: "Preset" }],
        personas: [{ id: "persona", name: "User", icon: "" }],
        modules: [],
        plugins: [],
        theme: "classic",
        autoScrollToNewMessage: false,
        ...(chatLoadInitialPages === undefined ? {} : { chatLoadInitialPages }),
        useAutoTranslateInput: false,
    });
    seedChats(
        chats.map((data) => ({ characterId, id: data.id, revision: "r1", data })),
        [{ characterId, revision: "o1", ids: ["a", "b"] }],
    );
    seedResources({
        epoch: io.server!.epoch,
        kinds: { characters: [{ id: characterId, revision: "r1", data: character }] },
    });
    selectCharacter(characterId);
    selectChat(characterId, "a");
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

it("reveals the latest message once after a notification request and clears the request before the tick", async () => {
    await mountComposer();
    const { ShowLatestMessageStore } = await import("src/ts/stores.svelte");
    expect(transcript.readProps!().messages.at(-1)?.chatId).toBe("a-answer");
    expect(transcript.scrollToLatestMessage).not.toHaveBeenCalled();

    ShowLatestMessageStore.value = true;
    flushSync();
    expect(ShowLatestMessageStore.value).toBe(false);
    expect(transcript.scrollToLatestMessage).not.toHaveBeenCalled();

    await tick();
    expect(transcript.scrollToLatestMessage).toHaveBeenCalledTimes(1);
    expect(transcript.scrollToLatestMessage.mock.calls[0][0].messages.at(-1)?.chatId).toBe("a-answer");
    await drive(Promise.resolve());
    expect(ShowLatestMessageStore.value).toBe(false);
    expect(transcript.scrollToLatestMessage).toHaveBeenCalledTimes(1);
});

it("aligns swapped replies from the reader's follow state before the swap and only in the same chat", async () => {
    const { target, click, menu, menuItem } = await mountComposer({
        configureChat: (chat) => {
            Object.assign(chat.message[1], {
                candidates: [
                    { id: "first", data: "earlier answer" },
                    { id: "second", data: "another answer" },
                ],
                selected: 0,
            });
        },
    });
    const { settings } = await import("src/ts/storage/settingsViews.svelte");
    const { flushResources } = await import("src/ts/storage/resourceSync.svelte");
    // This screen harness's resource fake handles records; acknowledge its candidate writes too.
    const fetch = io.server!.fetch;
    let revision = 1;
    vi.spyOn(io.server!, "fetch").mockImplementation(async (path, init) => {
        const response = await fetch(path, init);
        if (path !== "/api/resources/batch" || !response.ok) return response;
        const body = JSON.parse(String(init?.body)) as { chats?: ChatGroup[] };
        const result = (await response.json()) as ResourceBatchResult;
        return Response.json({
            ...result,
            chats: (body.chats ?? []).map(({ characterId, chatId }) => ({
                characterId,
                id: chatId,
                revision: `r${++revision}`,
                selections: ["applied"],
            })),
        });
    });
    settings.ui.autoScrollToNewMessage = true;
    settings.ui.alwaysScrollToNewMessage = false;
    settings.ui.sideMenuRerollButton = true;
    // Swapping replies changes the transcript's follow answer. Both directions must
    // use the old answer, even though the new reply has rendered before the save settles.
    transcript.followsLatest.mockImplementation((props) => props.messages.at(-1)?.selected === 0);
    flushSync();
    menu();
    click(menuItem(language.reroll));
    expect(transcript.readProps!().messages.at(-1)?.data).toBe("another answer");
    expect(transcript.scrollToLatestMessage).not.toHaveBeenCalled();
    await drive(flushResources());
    await tick();
    expect(transcript.scrollToLatestMessage).toHaveBeenCalledTimes(1);
    expect(transcript.scrollToLatestMessage.mock.calls[0][0].messages.at(-1)?.data).toBe("another answer");

    transcript.scrollToLatestMessage.mockClear();
    click(target.querySelector(".button-icon-unreroll"));
    expect(transcript.readProps!().messages.at(-1)?.data).toBe("earlier answer");
    await drive(flushResources());
    await tick();
    expect(transcript.scrollToLatestMessage).not.toHaveBeenCalled();

    // A follow that was requested in A must not align B when A's candidate save finishes.
    click(target.querySelector(".button-icon-reroll"));
    selectChat("c", "b");
    flushSync();
    await drive(flushResources());
    await tick();
    expect(transcript.readProps!().messages.at(-1)?.chatId).toBe("b-answer");
    expect(transcript.scrollToLatestMessage).not.toHaveBeenCalled();
    expect(io.alertError).not.toHaveBeenCalled();
    expect(io.createJob).not.toHaveBeenCalled();
});

it("skips loading older messages while transcript rows are held and resumes within 100px after release", async () => {
    const { target } = await mountComposer({
        chatLoadInitialPages: 2,
        configureChat: (chat) => {
            for (let index = 2; index < 8; index++) {
                chat.message.push({ role: "char", data: `reply ${index}`, chatId: `a-answer-${index}` });
            }
        },
    });
    const { settings } = await import("src/ts/storage/settingsViews.svelte");
    settings.ui.chatLoadAdditionalPages = 3;
    const scroller = target.querySelector<HTMLElement>(".default-chat-screen")!;
    Object.defineProperties(scroller, {
        scrollHeight: { value: 1000, configurable: true },
        clientHeight: { value: 400, configurable: true },
    });
    const scroll = (distanceFromOldest: number) => {
        scroller.scrollTop = distanceFromOldest - 600;
        scroller.dispatchEvent(new Event("scroll"));
        flushSync();
    };
    expect(transcript.readProps!().loadPages).toBe(2);
    expect(transcript.readProps!().messages).toHaveLength(8);

    transcript.setHolding!(true);
    flushSync();
    scroll(99);
    expect(transcript.readProps!().loadPages).toBe(2);

    transcript.setHolding!(false);
    flushSync();
    scroll(100);
    expect(transcript.readProps!().loadPages).toBe(2);
    scroll(99);
    expect(transcript.readProps!().loadPages).toBe(5);
});

it("names the shown persona and character in the placeholder and asks for the setup of an incomplete chat", async () => {
    const { input } = await mountComposer();
    const { chatBindingPatch } = await import("src/ts/storage/chatBinding.svelte");
    expect(input().placeholder).toBe("User → C");

    chatBindingPatch({ chaId: "c", chatId: "b" }, { personaId: null });
    selectChat("c", "b");
    flushSync();
    expect(input().placeholder).toBe(language.chatBinding.setupNeeded);

    selectChat("c", "a");
    flushSync();
    expect(input().placeholder).toBe("User → C");
});

it("locks both composers of an incomplete chat, keeps their text, and still opens the setup with Enter", async () => {
    const { input, target, type } = await mountComposer();
    const { chatBindingPatch } = await import("src/ts/storage/chatBinding.svelte");
    const { settings } = await import("src/ts/storage/settingsViews.svelte");
    const { chatBindingDialog } = await import("src/ts/stores.svelte");
    const { get } = await import("svelte/store");
    const ref = { chaId: "c", chatId: "a" };
    type("kept draft");
    settings.ui.sendWithEnter = true;
    settings.memoryTranslateMedia.useAutoTranslateInput = true;
    flushSync();
    const translation = () => target.querySelector<HTMLTextAreaElement>("#messageInputTranslate")!;
    expect(input().readOnly).toBe(false);
    expect(translation().readOnly).toBe(false);

    chatBindingPatch(ref, { personaId: null });
    flushSync();
    expect(input().readOnly).toBe(true);
    expect(translation().readOnly).toBe(true);
    expect(input().disabled).toBe(false);
    expect(input().value).toBe("kept draft");

    const getAsFile = vi.fn(() => null);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
        value: { items: [{ kind: "file", type: "image/png", getAsFile }] },
    });
    input().dispatchEvent(paste);
    expect(getAsFile).not.toHaveBeenCalled();

    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await until(() => get(chatBindingDialog) !== null);
    expect(get(chatBindingDialog)).toEqual(ref);
    expect(input().value).toBe("kept draft");
    expect(io.createJob).not.toHaveBeenCalled();

    chatBindingPatch(ref, { personaId: "persona" });
    flushSync();
    expect(input().readOnly).toBe(false);
    expect(translation().readOnly).toBe(false);
});

for (const type of ["done", "error"] as const) {
    it(`removes the mounted Stop after ${type} while the WebSocket close handshake stays open`, async () => {
        const { target, type: enter, click } = await mountComposer();
        const sockets: HeldSocket[] = [];
        class HeldSocket {
            static OPEN = 1;
            readyState = 0;
            onopen: (() => void) | null = null;
            onmessage: ((event: { data: string }) => void) | null = null;
            onclose: ((event: { code: number }) => void) | null = null;
            close = vi.fn<() => void>(() => {
                this.readyState = 2;
            });
            send = vi.fn<(data: string) => void>();
            constructor() {
                sockets.push(this);
            }
        }
        vi.stubGlobal("WebSocket", HeldSocket);
        io.createJob.mockResolvedValue({ outcome: "created", jobId: "held-close" });
        enter("send through the real follow");
        click(target.querySelector(".button-icon-send"));
        await until(() => sockets.length === 1);
        const socket = sockets[0];
        socket.readyState = 1;
        socket.onopen!();
        flushSync();
        expect(target.querySelector('[aria-labelledby="cancel"]')).not.toBeNull();
        const terminal =
            type === "done"
                ? { type, epoch: io.server!.epoch, revision: null }
                : {
                      type,
                      epoch: io.server!.epoch,
                      reason: "failed",
                      stage: "generate",
                      status: 500,
                      message: "provider failed",
                  };
        socket.onmessage!({ data: JSON.stringify(terminal) });
        await until(() => target.querySelector('[aria-labelledby="cancel"]') === null);
        expect(target.querySelector(".button-icon-send")).not.toBeNull();
        expect(socket.close).toHaveBeenCalled();
        const { followedJobs } = await import("src/ts/process/serverCommands");
        const { get } = await import("svelte/store");
        expect(get(followedJobs).size).toBe(0);
        socket.onclose!({ code: 1000 });
        await tick();
        flushSync();
        expect(target.querySelector('[aria-labelledby="cancel"]')).toBeNull();
        expect(target.querySelector(".button-icon-send")).not.toBeNull();
    });
}

it.each([
    { locale: "en", role: "participant", label: "Loading chat…" },
    { locale: "ko", role: "foreign", label: "채팅 불러오는 중…" },
    { locale: "de", role: "participant", label: "Loading chat…" },
])(
    "shows $locale loading text on the selected chat's $role Stop and keeps cancellation usable",
    async ({ locale, role, label }) => {
        const { target, click } = await mountComposer();
        const { changeLanguage } = await import("src/lang");
        changeLanguage(locale);
        const { language: strings } = await import("src/lang");
        const chat = await import("src/ts/storage/chatStore.svelte");
        const commands = await import("src/ts/process/serverCommands");
        const transport = await import("src/ts/network/generationJobs");
        const sync = await import("src/ts/storage/resourceSync.svelte");
        vi.spyOn(sync, "refreshStaleChat").mockResolvedValue(true);
        const abort = vi.spyOn(transport, "abortGenerationJob").mockResolvedValue();
        let finish!: (value: undefined) => void;
        const answer = new Promise<undefined>((resolve) => {
            finish = resolve;
        });
        vi.spyOn(chat, "ensureChatLoaded").mockReturnValueOnce(answer);
        const ref = { chaId: "c", chatId: "a" };
        const following = commands.followJobToEnd(
            "loading",
            ref,
            undefined,
            role === "foreign" ? { ticket: "takeover" } : {},
        );
        flushSync();
        const stop = () =>
            target.querySelector<HTMLButtonElement>(
                role === "participant"
                    ? '[aria-labelledby="cancel"]'
                    : `button[aria-label="${strings.serverJob.stopOther.label}"]`,
            );
        expect(stop()?.querySelector('[role="status"]')?.textContent).toBe(label);
        expect(stop()?.disabled).toBe(false);
        selectChat("c", "b");
        flushSync();
        expect(target.querySelector('[role="status"]')).toBeNull();
        selectChat("c", "a");
        flushSync();
        expect(stop()?.querySelector('[role="status"]')?.textContent).toBe(label);
        if (role === "participant") {
            click(stop());
            expect(abort).toHaveBeenCalledExactlyOnceWith("loading");
            expect(io.confirm).not.toHaveBeenCalled();
        } else {
            io.confirm.mockResolvedValueOnce(true);
            io.generationFetch
                .mockResolvedValueOnce(
                    Response.json({ jobId: "loading", kind: "send", owned: false, stage: "generating" }),
                )
                .mockResolvedValueOnce(Response.json({ aborted: true }));
            click(stop());
            await until(() => io.generationFetch.mock.calls.length === 2);
            expect(io.confirm).toHaveBeenCalledTimes(1);
            expect(io.generationFetch.mock.calls[1][0]).toBe("/api/generations/stop");
            expect(JSON.parse(String(io.generationFetch.mock.calls[1][1]?.body)).jobId).toBe("loading");
            expect(abort).not.toHaveBeenCalled();
        }
        finish(undefined);
        await drive(following);
        expect(target.querySelector('[role="status"]')).toBeNull();
    },
);

it("shows the selected participant job's retry label beside the Stop spinner in English and Korean", async () => {
    const { target } = await mountComposer();
    const { changeLanguage } = await import("src/lang");
    const { followedJobs } = await import("src/ts/process/serverCommands");
    const { applyGenerationEvent } = await import("src/ts/network/generationJobs");
    const ref = { chaId: "c", chatId: "a" };
    const epoch = io.server!.epoch;
    const stop = () => target.querySelector('[aria-labelledby="cancel"]');
    try {
        changeLanguage("en");
        followedJobs.set(
            new Map([
                ["retry-job", a],
                ["other-job", b],
            ]),
        );
        applyGenerationEvent("other-job", { chaId: "c", chatId: "b" }, { type: "retry", epoch, retry: 9 });
        applyGenerationEvent("retry-job", ref, { type: "stage", epoch, stage: "generating" });
        flushSync();
        expect(stop()?.querySelector(".loadmove")).not.toBeNull();
        expect(stop()?.querySelector('[role="status"]')).toBeNull();

        applyGenerationEvent("retry-job", ref, { type: "retry", epoch, retry: 1 });
        flushSync();
        expect(stop()?.querySelector(".loadmove")?.nextElementSibling?.textContent).toBe("Retry 1");
        changeLanguage("ko");
        applyGenerationEvent("retry-job", ref, { type: "retry", epoch, retry: 2 });
        flushSync();
        expect(stop()?.querySelector(".loadmove")?.nextElementSibling?.textContent).toBe("재시도 2회");
        applyGenerationEvent("retry-job", ref, { type: "stage", epoch, stage: "finishing" });
        applyGenerationEvent("retry-job", ref, { type: "retry", epoch, retry: null });
        flushSync();
        expect(stop()?.querySelector(".loadmove")).not.toBeNull();
        expect(stop()?.querySelector('[role="status"]')).toBeNull();
    } finally {
        followedJobs.set(new Map());
        changeLanguage("en");
    }
});

it("offers Stop beside Send for an unfollowed lock, busy refusal, or replay, and confirms the looked-up job", async () => {
    const { target, click } = await mountComposer();
    const chat = await import("src/ts/storage/chatStore.svelte");
    const status = await import("src/ts/process/chatStatus.svelte");
    const commands = await import("src/ts/process/serverCommands");
    const transport = await import("src/ts/network/generationJobs");
    const { selectedCharacter } = await import("src/ts/storage/characterStore.svelte");
    const { get } = await import("svelte/store");
    const ref = { chaId: "c", chatId: "a" };
    const stopButton = () => target.querySelector(`[aria-label="${language.serverJob.stopOther.label}"]`);
    const dispose = status.watchChatVisibility();
    try {
        expect(stopButton()).toBeNull();
        for (const source of ["lock", "chatBusy", "replay"] as const) {
            const advisoryId = `${source}-advisory`;
            const currentId = `${source}-current`;
            io.generationFetch
                .mockReset()
                .mockResolvedValue(Response.json({ error: "Generation not found" }, { status: 404 }));
            if (source === "lock") {
                chat.noteRemoteStreaming([
                    {
                        characterId: "c",
                        id: "a",
                        streaming: [{ messageId: "a-answer", generationId: advisoryId, seq: 0 }],
                    },
                ]);
            } else {
                if (source === "chatBusy")
                    io.createJob.mockRejectedValueOnce(new transport.GenerationBusyError(advisoryId));
                else
                    io.createJob.mockResolvedValueOnce({
                        outcome: "replayed",
                        jobId: advisoryId,
                        owned: false,
                        status: {
                            jobId: advisoryId,
                            kind: "command",
                            characterId: "c",
                            chatId: "a",
                            epoch: io.server!.epoch,
                            state: "running",
                        },
                    });
                await drive(commands.runServerButton(selectedCharacter()!, "go", ref));
                expect(get(status.foreignJobs).get(a)).toBe(advisoryId);
            }
            flushSync();
            expect(stopButton()).not.toBeNull();
            expect(target.querySelector(".button-icon-send")).not.toBeNull();
            expect(get(commands.followedJobs).size).toBe(0);
            let confirm!: (yes: boolean) => void;
            io.confirm.mockReset().mockImplementation(
                () =>
                    new Promise((resolve) => {
                        confirm = resolve;
                    }),
            );
            io.generationFetch
                .mockReset()
                .mockResolvedValueOnce(
                    Response.json({ jobId: currentId, kind: "command", owned: false, stage: "memory" }),
                )
                .mockResolvedValueOnce(Response.json({ aborted: true }));
            click(stopButton());
            await until(() => io.confirm.mock.calls.length === 1);
            expect(io.generationFetch).toHaveBeenCalledTimes(1);
            const lookup = new URL(io.generationFetch.mock.calls[0][0], "https://test.invalid");
            expect(lookup.pathname).toBe("/api/generations/current");
            expect(Object.fromEntries(lookup.searchParams)).toEqual({
                characterId: "c",
                chatId: "a",
                clientId: transport.generationClientId(),
            });
            expect(io.confirm.mock.calls[0][0]).toContain(language.serverJob.stopOther.kinds.command);
            expect(io.confirm.mock.calls[0][0]).toContain(language.serverJob.stopOther.stages.memory);
            expect(transport.savedGenerationJobIds()).toEqual([]);
            expect(transport.generationPluginWorkActive()).toBe(false);
            confirm(true);
            await until(() => io.generationFetch.mock.calls.length === 2);
            const [path, request] = io.generationFetch.mock.calls[1];
            expect(path).toBe("/api/generations/stop");
            expect(request?.method).toBe("POST");
            expect(new Headers(request?.headers).get("x-resource-epoch")).toBe(io.server!.epoch);
            expect(JSON.parse(String(request?.body))).toEqual({
                characterId: "c",
                chatId: "a",
                jobId: currentId,
                clientId: transport.generationClientId(),
            });
            // A followed chat uses its ordinary owner Stop, even if an advisory mark remains.
            commands.followedJobs.set(new Map([[currentId, a]]));
            flushSync();
            expect(stopButton()).toBeNull();
            commands.followedJobs.set(new Map());
            chat.releaseFeedLocks();
            status.clearForeignJob(ref);
            flushSync();
            expect(stopButton()).toBeNull();
        }
    } finally {
        dispose();
    }
});

it("confirms a replacement after jobChanged and clears Stop when that job ends during confirmation", async () => {
    const { target, click } = await mountComposer();
    const status = await import("src/ts/process/chatStatus.svelte");
    const { get } = await import("svelte/store");
    const ref = { chaId: "c", chatId: "a" };
    status.noteForeignJob(ref, "advisory");
    flushSync();
    const confirms: ((yes: boolean) => void)[] = [];
    io.confirm.mockImplementation(() => new Promise((resolve) => confirms.push(resolve)));
    io.generationFetch
        .mockResolvedValueOnce(Response.json({ jobId: "first", kind: "send", owned: false, stage: "generating" }))
        .mockResolvedValueOnce(Response.json({ error: "jobChanged" }, { status: 409 }))
        .mockResolvedValueOnce(
            Response.json({ jobId: "replacement", kind: "command", owned: false, stage: "finishing" }),
        )
        .mockResolvedValueOnce(Response.json({ error: "idle" }, { status: 404 }));
    const stopButton = () => target.querySelector(`[aria-label="${language.serverJob.stopOther.label}"]`);
    click(stopButton());
    await until(() => confirms.length === 1);
    expect(io.generationFetch).toHaveBeenCalledTimes(1);
    confirms[0](true);
    await until(() => confirms.length === 2);
    expect(io.generationFetch).toHaveBeenCalledTimes(3);
    expect(io.confirm.mock.calls[1][0]).toContain(language.serverJob.stopOther.kinds.command);
    expect(io.confirm.mock.calls[1][0]).toContain(language.serverJob.stopOther.stages.finishing);
    expect(new URL(io.generationFetch.mock.calls[2][0], "https://test.invalid").pathname).toBe(
        "/api/generations/current",
    );
    // The server now answers idle: confirming must not issue a wider stop or retry a different id.
    confirms[1](true);
    await until(() => !get(status.foreignJobs).has(a));
    expect(io.generationFetch).toHaveBeenCalledTimes(4);
    expect([1, 3].map((i) => JSON.parse(String(io.generationFetch.mock.calls[i][1]?.body)).jobId)).toEqual([
        "first",
        "replacement",
    ]);
    expect(stopButton()).toBeNull();
    expect(target.querySelector(".button-icon-send")).not.toBeNull();
    expect(io.alertError).not.toHaveBeenCalled();
});

it.each(["picker", "paste"] as const)(
    "forwards the composer's captured chat to a file send from %s",
    async (source) => {
        const { input, click, menuItem, menu } = await mountComposer();
        const multisend = await import("src/ts/process/files/multisend");
        const postFile = vi.spyOn(multisend, "postChatFile").mockResolvedValue([]);
        const ref = { chaId: "c", chatId: "a" };
        if (source === "picker") {
            menu();
            click(menuItem(language.postFile));
            expect(postFile).toHaveBeenCalledExactlyOnceWith("", ref);
        } else {
            let reader!: FileReader;
            vi.spyOn(FileReader.prototype, "readAsArrayBuffer").mockImplementation(function (this: FileReader) {
                reader = this;
            });
            const bytes = new Uint8Array([1, 2, 3]);
            const paste = new Event("paste", { bubbles: true, cancelable: true });
            Object.defineProperty(paste, "clipboardData", {
                value: {
                    items: [{ kind: "file", type: "image/png", getAsFile: () => new File([bytes], "pasted.png") }],
                },
            });
            input().dispatchEvent(paste);
            expect(reader).toBeDefined();
            expect(postFile).not.toHaveBeenCalled();
            selectChat("c", "b");
            flushSync();
            Object.defineProperty(reader, "result", { value: bytes.buffer });
            reader.dispatchEvent(new ProgressEvent("load"));
            expect(postFile).toHaveBeenCalledExactlyOnceWith({ name: "pasted.png", data: bytes }, ref);
        }
        await tick();
        expect(io.createJob).not.toHaveBeenCalled();
    },
);

it("journals screen sends, restores on switch, flushes on hide, and tracks attachments", async () => {
    const { target, input, type, click, menuItem, menu, hide, journal } = await mountComposer();

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
    expect(request.requestId).toEqual(expect.any(String));
    expect(request.context.input).toBe(`A to send{{inlayed::${sendFiles[0]}}}`);
    expect(input().value).toBe("");
    expect(await drive(journal.readComposer(a))).toBeNull();
    expect(await drive(journal.readComposerSend(a))).toEqual({
        state: "sending",
        input: "A to send",
        translate: "",
        files: sendFiles,
        userMessageId: request.context.userMessageId,
        requestId: request.requestId,
        requestEpoch: io.server!.epoch,
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
    // The create had no answer: the recovered row keeps the attempt's request id for its retry.
    expect(await drive(journal.readComposerSend(a))).toBeNull();
    expect(await drive(journal.readComposer(a))).toEqual({
        input: `A to send{{inlayed::${sendFiles[0]}}}`,
        translate: "",
        files: [],
        userMessageId: request.context.userMessageId,
        requestId: request.requestId,
        requestEpoch: io.server!.epoch,
    });
});

it("keeps an unanswered send's text and request id across a reload after a follow-up is typed and cleared", async () => {
    const { target, input, type, click, journal } = await mountComposer();
    const text = "Long original message that has not reached the server";
    type(text);
    io.createJob.mockImplementationOnce(() => new Promise(() => {}));
    click(target.querySelector(".button-icon-send"));
    await until(() => io.createJob.mock.calls.length === 1);
    const request = io.createJob.mock.calls[0][0];
    expect(input().disabled).toBe(false);
    type("A possible follow-up");
    await vi.advanceTimersByTimeAsync(600);
    expect(await drive(journal.readComposer(a))).toMatchObject({ input: "A possible follow-up" });
    type("");
    await vi.advanceTimersByTimeAsync(600);
    expect(await drive(journal.readComposer(a))).toBeNull();
    expect(await drive(journal.readComposerSend(a))).toMatchObject({
        input: text,
        userMessageId: request.context.userMessageId,
        requestId: request.requestId,
    });

    const reloaded = await mountComposer({ reload: true });
    await until(() => reloaded.input().value === text);
    expect(await drive(reloaded.journal.readComposer(a))).toMatchObject({
        input: text,
        userMessageId: request.context.userMessageId,
        requestId: request.requestId,
    });
});

async function useHttpCreation() {
    const { NO_GENERATION_HOOKS } = await import("../../../shared/jobs.ts");
    io.createJob.mockImplementation((body, options) => createHttpJob({ ...body, hooks: NO_GENERATION_HOOKS }, options));
}

const createPosts = () =>
    io.generationFetch.mock.calls
        .filter(([path]) => path === "/api/generations")
        .map(
            ([, init]) =>
                JSON.parse(String(init!.body)) as {
                    requestId: string;
                    context: { userMessageId: string; input: string };
                },
        );

function endedReplay(terminal: Record<string, unknown>) {
    return Response.json({
        jobId: `job-${createPosts().length}`,
        replayed: true,
        owned: true,
        status: {
            jobId: `job-${createPosts().length}`,
            kind: "send",
            characterId: "c",
            chatId: "a",
            epoch: io.server!.epoch,
            state: "ended",
            terminal: { epoch: io.server!.epoch, ...terminal },
        },
    });
}

/** Real send/follow pipeline with controllable job transport and acknowledgements for chat writes. */
async function loreJobs() {
    await useHttpCreation();
    const chat = await import("src/ts/storage/chatStore.svelte");
    const transport = await import("src/ts/network/generationJobs");
    const { createFollowStub } = await import("src/ts/network/tests/generationJobsMock");
    const { settings } = await import("src/ts/storage/settingsViews.svelte");
    const { loreBudgetStopDialog } = await import("src/ts/stores.svelte");
    settings.ui.loreBudgetStop = true;
    // Job hydration compares parsed revision tuples; the older composer cases only need opaque ids.
    chat.seedChats(
        ["a", "b"].map((id) => ({
            characterId: "c",
            id,
            revision: `${io.server!.epoch}:1:1`,
            data: JSON.parse(JSON.stringify(chat.findChat({ chaId: "c", chatId: id }))),
        })),
        [{ characterId: "c", revision: `${io.server!.epoch}:1:1`, ids: ["a", "b"] }],
    );
    let revision = 1;
    const fetch = io.server!.fetch;
    vi.spyOn(io.server!, "fetch").mockImplementation(async (path, init) => {
        const response = await fetch(path, init);
        if (path !== "/api/resources/batch" || !response.ok) return response;
        const body = JSON.parse(String(init?.body)) as { chats?: ChatGroup[] };
        return Response.json({
            ...(await response.json()),
            chats: (body.chats ?? []).map(({ characterId, chatId }) => ({
                characterId,
                id: chatId,
                revision: `${io.server!.epoch}:1:${++revision}`,
            })),
        });
    });
    const follows: {
        stub: ReturnType<typeof createFollowStub>;
        event: Parameters<typeof transport.followGenerationJob>[1];
    }[] = [];
    vi.spyOn(transport, "followGenerationJob").mockImplementation((id, event) => {
        const stub = createFollowStub(id);
        follows.push({ stub, event });
        return stub.follow;
    });
    io.generationFetch.mockImplementation(async () => Response.json({ jobId: `job-${createPosts().length}` }));
    const post = (index: number) =>
        createPosts()[index] as {
            requestId: string;
            kind: string;
            context: {
                characterId: string;
                chatId: string;
                input: string;
                userMessageId?: string;
                rerollMessageId?: string;
                speakerChaId?: string;
                stopOverLoreBudget?: boolean;
            };
        };
    async function finish(index: number, { stop = true, landInput = true } = {}) {
        await until(() => follows.length > index);
        const { context } = post(index);
        const ref = { chaId: context.characterId, chatId: context.chatId };
        const data = JSON.parse(JSON.stringify(chat.findChat(ref))) as Chat;
        if (landInput && context.input && !data.message.some((message) => message.chatId === context.userMessageId)) {
            data.message.push({ role: "user", data: context.input, chatId: context.userMessageId });
        }
        const follow = follows[index];
        follow.event({
            type: "resource",
            kind: "chats",
            epoch: io.server!.epoch,
            characterId: ref.chaId,
            id: ref.chatId,
            revision: `${io.server!.epoch}:1:${++revision}`,
            data,
        });
        const terminal = stop
            ? loreBudgetTerminal(io.server!.epoch)
            : { type: "done" as const, epoch: io.server!.epoch, revision: null };
        follow.event(terminal);
        follow.stub.end(terminal);
        const { isChatBusy } = await import("src/ts/process/chatStatus.svelte");
        await until(() => !isChatBusy(ref));
        await vi.advanceTimersByTimeAsync(0);
        flushSync();
    }
    async function dialog() {
        await until(() => get(loreBudgetStopDialog) !== null);
        return get(loreBudgetStopDialog)!;
    }
    return { chat, settings, post, finish, dialog, shown: () => get(loreBudgetStopDialog) };
}

it.each(["send", "continue", "empty continue"])(
    "repeats a stopped %s with its original input and message id under a new request id",
    async (action) => {
        const { target, input, type, click, menu, menuItem } = await mountComposer();
        const jobs = await loreJobs();
        const text = action === "empty continue" ? "" : "Keep this exact input";
        type(text);
        if (action === "send") click(target.querySelector(".button-icon-send"));
        else {
            menu();
            click(menuItem(language.continueResponse));
        }
        await jobs.finish(0);
        const first = jobs.post(0);
        expect(first.context.stopOverLoreBudget).toBe(true);
        expect(first.kind).toBe(action === "send" ? "send" : "continue");
        const dialog = await jobs.dialog();
        expect(dialog.ref).toEqual({ chaId: "c", chatId: "a" });
        expect(dialog.stop).toEqual(loreBudgetStopFixture);
        expect(dialog.messageKept).toBe(text !== "");
        expect(input().value).toBe("");
        expect(io.alertError).not.toHaveBeenCalled();
        // Text entered while the dialog is open must not replace the stopped request's input.
        type("Next message");
        dialog.resolve("warnOffAndSend");
        await until(() => createPosts().length === 2);
        const repeated = jobs.post(1);
        expect(jobs.chat.findChat({ chaId: "c", chatId: "a" })?.loreBudgetWarnOff).toBe(true);
        expect(repeated.kind).toBe(first.kind);
        expect(repeated.context.input).toBe(text);
        if (text) {
            expect(first.context.userMessageId).toEqual(expect.any(String));
            expect(repeated.context.userMessageId).toBe(first.context.userMessageId);
        } else expect(repeated.context).not.toHaveProperty("userMessageId");
        expect(repeated.requestId).toEqual(expect.any(String));
        expect(repeated.requestId).not.toBe(first.requestId);
        expect(repeated.context).not.toHaveProperty("stopOverLoreBudget");
        await jobs.finish(1, { stop: false });
        expect(input().value).toBe("Next message");
    },
);

it("closes a stopped send without another request or a chat opt-out", async () => {
    const { target, type, click } = await mountComposer();
    const jobs = await loreJobs();
    type("Keep the message, close the warning");
    click(target.querySelector(".button-icon-send"));
    await jobs.finish(0);
    (await jobs.dialog()).resolve("close");
    await vi.advanceTimersByTimeAsync(0);
    expect(createPosts()).toHaveLength(1);
    expect(jobs.chat.findChat({ chaId: "c", chatId: "a" })?.loreBudgetWarnOff).not.toBe(true);
    expect(jobs.shown()).toBeNull();
    expect(io.alertError).not.toHaveBeenCalled();
});

it("alerts instead of opening a lore dialog when the unlanded input returns to the composer", async () => {
    const { target, input, type, click } = await mountComposer();
    const jobs = await loreJobs();
    type("This input did not land");
    click(target.querySelector(".button-icon-send"));
    await jobs.finish(0, { landInput: false });
    expect(input().value).toBe("This input did not land");
    expect(jobs.shown()).toBeNull();
    expect(io.alertError).toHaveBeenCalledExactlyOnceWith("Activated lorebook entries exceeded the token limit.");
    expect(createPosts()).toHaveLength(1);
});

it("repeats a stopped in-place reroll with the same reply and speaker", async () => {
    const { target, click } = await mountComposer({
        configureChat: (chat) => {
            chat.message[1].saying = "speaker";
        },
    });
    const jobs = await loreJobs();
    vi.spyOn(await import("src/ts/network/eventFeed"), "serverRerollsInPlace").mockReturnValue(true);
    click(target.querySelector(".button-icon-reroll"));
    await jobs.finish(0);
    expect(jobs.post(0)).toMatchObject({
        kind: "reroll",
        context: { stopOverLoreBudget: true, rerollMessageId: "a-answer", speakerChaId: "speaker" },
    });
    (await jobs.dialog()).resolve("warnOffAndSend");
    await until(() => createPosts().length === 2);
    expect(jobs.post(1)).toMatchObject({
        kind: "reroll",
        context: { rerollMessageId: "a-answer", speakerChaId: "speaker" },
    });
    expect(jobs.post(1).context).not.toHaveProperty("stopOverLoreBudget");
    expect(jobs.post(1).requestId).not.toBe(jobs.post(0).requestId);
    expect(jobs.chat.findChat({ chaId: "c", chatId: "a" })?.loreBudgetWarnOff).toBe(true);
    await jobs.finish(1, { stop: false });
});

it.each(["user", "reply"])(
    "offers a removal reroll ending in a %s and repeats only on the stopped chat after switching",
    async (tail) => {
        const { target, click } = await mountComposer({
            configureChat: (chat) => {
                if (tail === "user") chat.message.pop();
            },
        });
        const jobs = await loreJobs();
        const stopped = { chaId: "c", chatId: "a" };
        const other = { chaId: "c", chatId: "b" };
        const otherBefore = JSON.parse(JSON.stringify(jobs.chat.findChat(other)));
        click(target.querySelector(".button-icon-reroll"));
        await jobs.finish(0);
        expect(jobs.post(0)).toMatchObject({ kind: "send", context: { stopOverLoreBudget: true } });
        const dialog = await jobs.dialog();
        expect(jobs.chat.findChat(stopped)?.message.map((message) => message.chatId)).toEqual(
            tail === "user" ? ["a-user"] : ["a-user", "a-answer"],
        );
        if (tail === "user")
            jobs.chat.appendMessage(stopped, {
                role: "char",
                data: "Reply arrived while deciding",
                chatId: "late-answer",
            });
        selectChat("c", "b");
        flushSync();
        dialog.resolve("warnOffAndSend");
        await until(() => createPosts().length === 2);
        expect(jobs.post(1).context).toMatchObject({ characterId: "c", chatId: "a", input: "" });
        expect(jobs.post(1).context).not.toHaveProperty("stopOverLoreBudget");
        expect(jobs.post(1).requestId).not.toBe(jobs.post(0).requestId);
        expect(jobs.chat.findChat(stopped)?.message.map((message) => message.chatId)).toEqual(["a-user"]);
        expect(jobs.chat.findChat(stopped)?.loreBudgetWarnOff).toBe(true);
        expect(jobs.chat.findChat(other)).toEqual(otherBefore);
        await jobs.finish(1, { stop: false });
    },
);

it("never requests a lore budget stop in auto mode", async () => {
    const { menu, menuItem, click } = await mountComposer({
        configureCharacter: (character) => {
            Object.assign(character, { type: "group", characters: [], characterTalks: [], characterActive: [] });
        },
    });
    const jobs = await loreJobs();
    menu();
    click(menuItem(language.autoMode));
    await until(() => createPosts().length === 1);
    expect(jobs.post(0).context).not.toHaveProperty("stopOverLoreBudget");
    selectChat("c", "b");
    flushSync();
    await jobs.finish(0, { stop: false });
    expect(jobs.shown()).toBeNull();
    expect(createPosts()).toHaveLength(1);
});

it.each(["setting off", "chat opted out"])("omits the lore budget request field (%s)", async (reason) => {
    const { target, click } = await mountComposer({
        configureChat: (chat) => {
            if (reason === "chat opted out") chat.loreBudgetWarnOff = true;
        },
    });
    const jobs = await loreJobs();
    if (reason === "setting off") jobs.settings.ui.loreBudgetStop = false;
    click(target.querySelector(".button-icon-send"));
    await until(() => createPosts().length === 1);
    expect(jobs.post(0).context).not.toHaveProperty("stopOverLoreBudget");
    await jobs.finish(0, { stop: false });
    expect(jobs.shown()).toBeNull();
});

it("posts the same request id after an unknown send and fresh ids after error, stopped, abort and refusal without losing the message id", async () => {
    const { target, input, type, click } = await mountComposer();
    await useHttpCreation();
    type("keep this text");
    io.generationFetch.mockRejectedValue(new TypeError("create answer lost"));
    click(target.querySelector(".button-icon-send"));
    await until(() => createPosts().length === 1);
    await vi.advanceTimersByTimeAsync(7000);
    await until(() => input().value === "keep this text" && target.querySelector(".button-icon-send") !== null);
    const original = createPosts()[0];
    expect(original.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(createPosts()).toHaveLength(4);
    expect(createPosts().every((post) => post.requestId === original.requestId)).toBe(true);

    async function retry(terminal: Record<string, unknown>) {
        const before = createPosts().length;
        io.generationFetch.mockImplementation(async () => endedReplay(terminal));
        click(target.querySelector(".button-icon-send"));
        await until(
            () =>
                createPosts().length === before + 1 &&
                input().value === "keep this text" &&
                target.querySelector(".button-icon-send") !== null,
        );
        const post = createPosts().at(-1)!;
        expect(post.context.userMessageId).toBe(original.context.userMessageId);
        expect(post.context.input).toBe(original.context.input);
        return post;
    }
    const error = { type: "error", reason: "failed", stage: "setup", status: 500, message: "before input" };
    const replayedError = await retry(error);
    expect(replayedError.requestId).toBe(original.requestId);
    const stopped = await retry({ type: "done", stopped: true, revision: null });
    expect(stopped.requestId).not.toBe(replayedError.requestId);

    io.generationFetch.mockImplementation(async (path) => {
        if (path === "/api/generations/cancel") return Response.json({ state: "cancelled" });
        throw new TypeError("create answer lost");
    });
    click(target.querySelector(".button-icon-send"));
    await until(() => createPosts().length === 7);
    const aborted = createPosts().at(-1)!;
    expect(aborted.requestId).not.toBe(stopped.requestId);
    click(target.querySelector('button[aria-labelledby="cancel"]'));
    await until(() => input().value === "keep this text" && target.querySelector(".button-icon-send") !== null);
    const cancel = io.generationFetch.mock.calls.find(([path]) => path === "/api/generations/cancel")!;
    expect(JSON.parse(String(cancel[1]!.body)).requestId).toBe(aborted.requestId);

    io.generationFetch.mockResolvedValue(Response.json({ error: "stale" }, { status: 409 }));
    click(target.querySelector(".button-icon-send"));
    await until(
        () =>
            createPosts().length === 8 &&
            input().value === "keep this text" &&
            target.querySelector(".button-icon-send") !== null,
    );
    const refused = createPosts().at(-1)!;
    expect(refused.requestId).not.toBe(aborted.requestId);
    expect(refused.context.userMessageId).toBe(original.context.userMessageId);
    const fresh = await retry(error);
    expect(fresh.requestId).not.toBe(refused.requestId);
});

it("keeps an unanswered create unknown after a rate limit answer and reuses its request id on the next Send", async () => {
    const { target, input, type, click } = await mountComposer();
    await useHttpCreation();
    const sends = vi.spyOn(await import("src/ts/process/serverGeneration"), "sendChatOnServer");
    io.generationFetch
        .mockRejectedValueOnce(new TypeError("answer lost"))
        .mockResolvedValueOnce(Response.json({ error: "Too many requests" }, { status: 429 }));
    type("retry after limiter");
    click(target.querySelector(".button-icon-send"));
    await until(() => createPosts().length === 1);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => input().value === "retry after limiter" && target.querySelector(".button-icon-send") !== null);
    expect(createPosts()).toHaveLength(2);
    expect(createPosts()[1]).toEqual(createPosts()[0]);
    expect(await sends.mock.results[0].value).toMatchObject({
        outcome: "unknown",
        settled: false,
        requestUncertain: true,
    });
    io.generationFetch.mockImplementation(async () =>
        endedReplay({ type: "error", reason: "failed", status: 500, message: "before input", stage: "setup" }),
    );
    click(target.querySelector(".button-icon-send"));
    await until(() => createPosts().length === 3 && input().value === "retry after limiter");
    expect(createPosts()[2].requestId).toBe(createPosts()[0].requestId);
    expect(createPosts()[2].context.userMessageId).toBe(createPosts()[0].context.userMessageId);
});

it.each(["same", "different"])(
    "restores an uncertain send after reload and posts its message id with the correct request id for the %s epoch",
    async (epoch) => {
        const first = await mountComposer();
        await useHttpCreation();
        const text = "recover this unanswered send";
        first.type(text);
        io.generationFetch.mockRejectedValue(new TypeError("create answer lost"));
        first.click(first.target.querySelector(".button-icon-send"));
        await until(() => createPosts().length === 1);
        const original = createPosts()[0];
        expect(original.requestId).toEqual(expect.any(String));
        expect(original.context.userMessageId).toEqual(expect.any(String));
        expect(await drive(first.journal.readComposerSend(a))).toEqual({
            state: "sending",
            input: text,
            translate: "",
            files: [],
            userMessageId: original.context.userMessageId,
            requestId: original.requestId,
            requestEpoch: io.server!.epoch,
        });
        // Leave A before the unanswered create settles, so its hand-off stays in the journal.
        selectChat("c", "b");
        flushSync();
        const { isChatBusy } = await import("src/ts/process/chatStatus.svelte");
        await vi.advanceTimersByTimeAsync(7000);
        await until(() => !isChatBusy({ chaId: "c", chatId: "a" }));
        expect(await drive(first.journal.readComposerSend(a))).toMatchObject({
            input: text,
            userMessageId: original.context.userMessageId,
            requestId: original.requestId,
            requestEpoch: io.server!.epoch,
        });

        if (epoch === "different") io.server!.restore("epoch-after-import");
        const reloaded = await mountComposer({ reload: true });
        await useHttpCreation();
        await until(() => reloaded.input().value === text);
        expect(createPosts()).toHaveLength(0);
        io.generationFetch.mockResolvedValue(Response.json({ error: "stale" }, { status: 409 }));
        reloaded.click(reloaded.target.querySelector(".button-icon-send"));
        await until(() => createPosts().length === 1 && reloaded.input().value === text);
        const retry = createPosts()[0];
        expect(retry.context.input).toBe(text);
        expect(retry.context.userMessageId).toBe(original.context.userMessageId);
        if (epoch === "same") expect(retry.requestId).toBe(original.requestId);
        else {
            expect(retry.requestId).toEqual(expect.any(String));
            expect(retry.requestId).not.toBe(original.requestId);
        }
    },
);

it("clears a refused attempt's stored request id while keeping its text and message id, even in an unselected chat", async () => {
    const { target, input, type, click, journal } = await mountComposer();
    await useHttpCreation();
    const { isChatBusy } = await import("src/ts/process/chatStatus.svelte");
    const text = "keep this refused draft";
    type(text);
    for (const selected of [false, true]) {
        let refuse!: (response: Response) => void;
        io.generationFetch.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    refuse = resolve;
                }),
        );
        const before = createPosts().length;
        click(target.querySelector(".button-icon-send"));
        await until(() => createPosts().length === before + 1);
        const post = createPosts().at(-1)!;
        expect(await drive(journal.readComposerSend(a))).toMatchObject({ requestId: post.requestId });
        if (!selected) {
            selectChat("c", "b");
            flushSync();
            await until(() => input().value === "B from a previous page");
        }
        refuse(Response.json({ error: "stale" }, { status: 409 }));
        await until(() => !isChatBusy({ chaId: "c", chatId: "a" }));
        // A hidden chat keeps the hand-off until its text is placed; a shown one takes it over at once.
        const saved = await drive(selected ? journal.readComposer(a) : journal.readComposerSend(a));
        expect(saved).toMatchObject({ input: text, userMessageId: post.context.userMessageId });
        expect(saved).not.toHaveProperty("requestId");
        expect(saved).not.toHaveProperty("requestEpoch");
        if (!selected) {
            expect(input().value).toBe("B from a previous page");
            selectChat("c", "a");
            flushSync();
        }
        await until(() => input().value === text);
        expect(await drive(journal.readComposerSend(a))).toBeNull();
        expect(await drive(journal.readComposer(a))).toMatchObject({ input: text });
    }
});

it("journals Continue's text and message id without a request id, including after an uncertain outcome", async () => {
    const { target, input, type, click, menu, menuItem, journal } = await mountComposer();
    await useHttpCreation();
    const text = "continue with this input";
    type(text);
    io.generationFetch.mockRejectedValue(new TypeError("create answer lost"));
    menu();
    click(menuItem(language.continueResponse));
    await until(() => createPosts().length === 1);
    const post = createPosts()[0];
    expect(post.requestId).toEqual(expect.any(String));
    expect(post.context.userMessageId).toEqual(expect.any(String));
    expect(await drive(journal.readComposerSend(a))).toEqual({
        state: "sending",
        input: text,
        translate: "",
        files: [],
        userMessageId: post.context.userMessageId,
    });
    expect(await drive(journal.readComposer(a))).toBeNull();
    await vi.advanceTimersByTimeAsync(7000);
    await until(() => input().value === text && target.querySelector(".button-icon-send") !== null);
    window.dispatchEvent(new Event("pagehide"));
    expect(await drive(journal.readComposer(a))).toEqual({
        input: text,
        translate: "",
        files: [],
        userMessageId: post.context.userMessageId,
    });
});

it("opens structured memory from the menu ahead of older flags and preserves the other algorithms", async () => {
    const { target, menu, click } = await mountComposer();
    const { settings } = await import("src/ts/storage/settingsViews.svelte");
    const { hypaV3ModalOpen } = await import("src/ts/stores.svelte");
    const { get } = await import("svelte/store");
    settings.ui.showMenuHypaMemoryModal = true;
    for (const [algorithm, v2, v3, label] of [
        ["structuredMemory", true, true, language.structuredMemory.panel.title],
        ["structuredMemory", false, false, language.structuredMemory.panel.title],
        ["hypaV2", true, true, language.hypaMemoryV2Modal],
        ["hypaV3", false, true, language.hypaMemoryV3Modal],
    ] as const) {
        settings.ui.memoryAlgorithmType = algorithm;
        settings.memoryTranslateMedia.supaModelType = "subModel";
        settings.memoryTranslateMedia.hypav2 = v2;
        settings.memoryTranslateMedia.hypaV3 = v3;
        hypaV3ModalOpen.set(false);
        flushSync();
        menu();
        expect(target.textContent).toContain(label);
        if (algorithm === "structuredMemory") {
            expect(target.textContent).not.toContain(language.hypaMemoryV2Modal);
            expect(target.textContent).not.toContain(language.hypaMemoryV3Modal);
        } else expect(target.textContent).not.toContain(language.structuredMemory.panel.title);
        click([...target.querySelectorAll("span")].find((node) => node.textContent.trim() === label)!.parentElement);
        expect(get(hypaV3ModalOpen)).toBe(algorithm !== "hypaV2");
    }
    hypaV3ModalOpen.set(false);
});

it("shows the structured memory and HypaV3 menu rows without the menu toggle, and HypaV2 only with it", async () => {
    const { target, menu, click } = await mountComposer();
    const { settings } = await import("src/ts/storage/settingsViews.svelte");
    const { hypaV3ModalOpen } = await import("src/ts/stores.svelte");
    const { get } = await import("svelte/store");
    settings.ui.showMenuHypaMemoryModal = false;
    settings.memoryTranslateMedia.supaModelType = "subModel";
    for (const [algorithm, v2, v3, label] of [
        ["structuredMemory", false, false, language.structuredMemory.panel.title],
        ["hypaV3", false, true, language.hypaMemoryV3Modal],
    ] as const) {
        settings.ui.memoryAlgorithmType = algorithm;
        settings.memoryTranslateMedia.hypav2 = v2;
        settings.memoryTranslateMedia.hypaV3 = v3;
        hypaV3ModalOpen.set(false);
        flushSync();
        menu();
        click([...target.querySelectorAll("span")].find((node) => node.textContent.trim() === label)!.parentElement);
        expect(get(hypaV3ModalOpen)).toBe(true);
    }
    settings.ui.memoryAlgorithmType = "hypaV2";
    settings.memoryTranslateMedia.hypav2 = true;
    settings.memoryTranslateMedia.hypaV3 = false;
    flushSync();
    menu();
    expect(target.textContent).not.toContain(language.hypaMemoryV2Modal);
    hypaV3ModalOpen.set(false);
});

it("renders a memory health badge with the context meter off and opens the panel on press", async () => {
    const { target, click } = await mountComposer();
    const { settings } = await import("src/ts/storage/settingsViews.svelte");
    const { findCharacter } = await import("src/ts/storage/characterStore.svelte");
    const { createHypaV3Preset } = await import("../../../shared/hypaV3Presets.ts");
    const { hypaV3ModalOpen } = await import("src/ts/screenVisibility");
    const { currentChatRef } = await import("src/ts/storage/chatStore.svelte");
    const { noteJobDone } = await import("src/ts/process/chatStatus.svelte");
    const { get } = await import("svelte/store");
    settings.ui.memoryAlgorithmType = "structuredMemory";
    settings.ui.contextMeter = false;
    settings.hypaV3Presets.items = [createHypaV3Preset("Memory", { structured: { fineTuning: true } }, "memory")];
    settings.hypaV3Presets.selectedId = "memory";
    Object.assign(findCharacter("c")!, { supaMemory: true });
    hypaV3ModalOpen.set(false);
    flushSync();
    // A custom writer prompt alone is not a health state.
    expect(target.querySelector("[data-memory-health-badge]")).toBeNull();
    noteJobDone(currentChatRef()!, {
        type: "error",
        epoch: "e",
        message: "over",
        status: 500,
        reason: "failed",
        code: "memoryRequiredOverCap",
    });
    flushSync();
    const badge = target.querySelector('[data-memory-health-badge="requiredOverCap"]');
    expect(badge).not.toBeNull();
    click(badge);
    expect(get(hypaV3ModalOpen)).toBe(true);
    settings.ui.memoryAlgorithmType = "none";
    flushSync();
    expect(target.querySelector("[data-memory-health-badge]")).toBeNull();
    hypaV3ModalOpen.set(false);
});

async function mountHookComposer(options: Parameters<typeof mountComposer>[0] = {}) {
    const ui = await mountComposer({
        configureChat: (chat) => {
            chat.draftHookId = "draft-hook";
        },
        ...options,
    });
    const { settings } = await import("src/ts/storage/settingsViews.svelte");
    settings.inputHooks = [
        { id: "draft-hook", name: "Rewrite", type: "draft", prompt: "Rewrite {{content}}", model: { mode: "inherit" } },
    ];
    settings.ui.sendWithEnter = true;
    flushSync();
    const draft = () => ui.target.querySelector<HTMLTextAreaElement>("#messageInputDraft");
    const translation = () => ui.target.querySelector<HTMLTextAreaElement>("#messageInputTranslate");
    const enter = (node: HTMLTextAreaElement, value: string) => {
        // Exercise the binding without starting an unrelated translator request.
        const enabled = settings.memoryTranslateMedia.useAutoTranslateInput;
        settings.memoryTranslateMedia.useAutoTranslateInput = false;
        node.value = value;
        node.dispatchEvent(new Event("input", { bubbles: true }));
        settings.memoryTranslateMedia.useAutoTranslateInput = enabled;
        flushSync();
    };
    const sendDraft = () =>
        [...ui.target.querySelectorAll<HTMLButtonElement>("button")].find(
            (button) => button.textContent.trim() === language.inputHooks.sendDraft,
        )!;
    const sendKey = (node = ui.input()) => {
        node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        flushSync();
    };
    const boxes = () => [ui.input().value, draft()?.value ?? "", translation()?.value ?? ""];
    return { ...ui, settings, draft, translation, enter, sendDraft, sendKey, boxes };
}

function holdHook() {
    let resolve!: (text: string) => void;
    let reject!: (error: Error) => void;
    io.runInputHook.mockImplementationOnce(
        () =>
            new Promise<string>((yes, no) => {
                resolve = yes;
                reject = no;
            }),
    );
    return { resolve: (text: string) => resolve(text), reject: (error: Error) => reject(error) };
}

async function mountBtwComposer(options: Parameters<typeof mountComposer>[0] = {}) {
    const ui = await mountHookComposer(options);
    ui.settings.inputHooks.push({
        id: "btw-hook",
        name: "Ask aside",
        type: "btw",
        prompt: "Consider {{content}} and {{draft}}",
        model: { mode: "inherit" },
    });
    flushSync();
    const runBtw = () => {
        if (![...ui.target.querySelectorAll("span")].some((node) => node.textContent === language.inputHooks.btw))
            ui.menu();
        ui.click(ui.menuItem(language.inputHooks.btw));
    };
    const result = () => ui.target.querySelector<HTMLElement>(`[aria-label="${language.inputHooks.btwResult}"]`);
    const stop = () => ui.target.querySelector('[aria-labelledby="cancel"]');
    return { ...ui, runBtw, result, stop };
}

it("shows BTW only while BTW hooks exist and never in the playground", async () => {
    const ui = await mountHookComposer();
    const btwEntry = (target: Element) =>
        [...target.querySelectorAll("span")].find((node) => node.textContent === language.inputHooks.btw);
    const draftHook = JSON.parse(JSON.stringify(ui.settings.inputHooks[0])) as (typeof ui.settings.inputHooks)[number];
    const btwHook = { ...draftHook, id: "btw-hook", name: "Ask aside", type: "btw" as const };
    ui.menu();
    expect(btwEntry(ui.target)).toBeUndefined();
    for (const [hooks, visible] of [
        [[], false],
        [[draftHook, btwHook], true],
        [[draftHook], false],
        [[btwHook], true],
    ] as const) {
        ui.settings.inputHooks = [...hooks];
        flushSync();
        expect(Boolean(btwEntry(ui.target))).toBe(visible);
    }
    const playground = await mountBtwComposer({ reload: true, characterId: "§playground" });
    const menuButton = playground.target.querySelector("svg.lucide-menu")?.closest("button");
    if (menuButton) playground.click(menuButton);
    expect(btwEntry(playground.target)).toBeUndefined();
    expect(io.runInputHook).not.toHaveBeenCalled();
});

it("lists only BTW hooks by name, cancels the picker, and closes it when a hook is chosen", async () => {
    const ui = await mountBtwComposer();
    const chosen = { ...ui.settings.inputHooks[1], id: "second-btw", name: "Check an alternative" };
    ui.settings.inputHooks.push(chosen);
    ui.type("main for picker");
    ui.enter(ui.draft()!, "draft for picker");
    const dialog = () => document.querySelector('[role="dialog"]');
    for (const cancel of ["Escape", "backdrop"]) {
        ui.runBtw();
        expect(dialog()).not.toBeNull();
        expect(
            [...dialog()!.querySelectorAll("button")].map((button) => button.textContent.trim()).filter(Boolean),
        ).toEqual(["Ask aside", "Check an alternative"]);
        expect(io.runInputHook).not.toHaveBeenCalled();
        if (cancel === "Escape") {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
            flushSync();
        } else ui.click(dialog()!.parentElement!.querySelector(`button[aria-label="${language.cancel}"]`));
        expect(dialog()).toBeNull();
        expect(io.runInputHook).not.toHaveBeenCalled();
    }
    const pending = holdHook();
    ui.runBtw();
    ui.click([...dialog()!.querySelectorAll("button")].find((button) => button.textContent.trim() === chosen.name)!);
    expect(dialog()).toBeNull();
    expect(io.runInputHook).toHaveBeenCalledExactlyOnceWith(chosen, {
        ref: { chaId: "c", chatId: "a" },
        content: "main for picker",
        draft: "draft for picker",
        signal: expect.any(AbortSignal),
    });
    pending.resolve("Chosen hook answer");
    await until(() => ui.stop() === null);
    expect(ui.result()?.textContent).toContain("Chosen hook answer");
});

it("runs a lone BTW hook even with empty main text without changing the composer, journal or chat", async () => {
    const ui = await mountBtwComposer();
    const { findChat } = await import("src/ts/storage/chatStore.svelte");
    const { flushResources } = await import("src/ts/storage/resourceSync.svelte");
    const chatBefore = JSON.parse(JSON.stringify(findChat({ chaId: "c", chatId: "a" })));
    ui.enter(ui.draft()!, "existing draft");
    ui.settings.memoryTranslateMedia.useAutoTranslateInput = true;
    flushSync();
    ui.enter(ui.translation()!, "existing translation");
    const files = await attachHookAudio(ui);
    for (const content of ["main question", ""]) {
        ui.enter(ui.input(), content);
        ui.hide();
        const saved = { input: content, draft: "existing draft", translate: "existing translation", files };
        expect(await drive(ui.journal.readComposer(a))).toEqual(saved);
        await drive(flushResources());
        const requestStart = io.server!.requests.length;
        const pending = holdHook();
        ui.runBtw();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(io.runInputHook).toHaveBeenLastCalledWith(expect.objectContaining({ id: "btw-hook", type: "btw" }), {
            ref: { chaId: "c", chatId: "a" },
            content,
            draft: "existing draft",
            signal: expect.any(AbortSignal),
        });
        expect(ui.boxes()).toEqual([content, "existing draft", "existing translation"]);
        const answer = content
            ? "First answer\n<b>literal markup</b>"
            : "Replacement answer\n<script>literal text</script>";
        pending.resolve(answer);
        await until(() => ui.stop() === null);
        expect(ui.result()?.querySelector("h2")?.textContent).toBe(language.inputHooks.btwResult);
        expect(ui.result()?.textContent).toContain(answer);
        expect(ui.result()?.querySelector("b, script")).toBeNull();
        expect(ui.result()!.compareDocumentPosition(ui.input()) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
        if (!content) expect(ui.result()?.textContent).not.toContain("First answer");
        expect(ui.boxes()).toEqual([content, "existing draft", "existing translation"]);
        expect(ui.target.querySelector("audio")).not.toBeNull();
        ui.hide();
        await drive(flushResources());
        expect(await drive(ui.journal.readComposer(a))).toEqual(saved);
        expect(await drive(ui.journal.readComposerSend(a))).toBeNull();
        expect(await drive(ui.journal.listDrafts())).toEqual([]);
        expect((await drive(ui.journal.readOwn())).filter((row) => row.scope === "chat")).toEqual([]);
        expect(findChat({ chaId: "c", chatId: "a" })).toEqual(chatBefore);
        expect(
            io.server!.requests.slice(requestStart).filter((request) => {
                const body = request.body as { chats?: unknown[] } | null;
                return (
                    (request.path === "/api/resources/batch" && !!body?.chats?.length) ||
                    (request.method !== "GET" && request.path.startsWith("/api/resources/chats/"))
                );
            }),
        ).toEqual([]);
    }
    expect(io.runInputHook).toHaveBeenCalledTimes(2);
    expect(io.createJob).not.toHaveBeenCalled();
    expect(io.alertError).not.toHaveBeenCalled();
    ui.click(ui.result()!.querySelector(`[aria-label="${language.inputHooks.btwDismiss}"]`));
    expect(ui.result()).toBeNull();
});

it("refuses Send, Send Draft and another hook while BTW runs, and Stop aborts it", async () => {
    const ui = await mountBtwComposer();
    ui.type("main question");
    ui.enter(ui.draft()!, "existing draft");
    const pending = holdHook();
    ui.runBtw();
    expect(ui.stop()).not.toBeNull();
    const signal = io.runInputHook.mock.calls[0][1].signal!;
    expect(signal.aborted).toBe(false);
    expect(ui.sendDraft().disabled).toBe(true);
    for (const action of [() => ui.sendKey(), () => ui.sendKey(ui.draft()!), () => ui.runBtw()]) {
        io.alertError.mockClear();
        action();
        expect(io.alertError).toHaveBeenCalledExactlyOnceWith(language.chatGenerating);
        expect(io.runInputHook).toHaveBeenCalledTimes(1);
        expect(io.createJob).not.toHaveBeenCalled();
        expect(ui.boxes()).toEqual(["main question", "existing draft", ""]);
    }
    io.alertError.mockClear();
    ui.click(ui.stop());
    expect(signal.aborted).toBe(true);
    pending.resolve("Late answer after Stop");
    await until(() => ui.stop() === null);
    expect(ui.result()).toBeNull();
    expect(io.alertError).not.toHaveBeenCalled();
    expect(ui.boxes()).toEqual(["main question", "existing draft", ""]);
});

it("keeps BTW results through composer edits and shows each answer only in its originating chat", async () => {
    const ui = await mountBtwComposer();
    ui.type("original main");
    ui.enter(ui.draft()!, "original draft");
    let pending = holdHook();
    ui.runBtw();
    ui.type("edited main");
    ui.enter(ui.draft()!, "edited draft");
    pending.resolve("A after editing");
    await until(() => ui.stop() === null);
    expect(ui.result()?.textContent).toContain("A after editing");
    expect(ui.boxes()).toEqual(["edited main", "edited draft", ""]);
    pending = holdHook();
    ui.runBtw();
    selectChat("c", "b");
    flushSync();
    expect(ui.result()).toBeNull();
    expect(ui.stop()).toBeNull();
    pending.resolve("A completed while viewing B");
    await drive(Promise.resolve());
    expect(ui.result()).toBeNull();
    pending = holdHook();
    ui.runBtw();
    expect(io.runInputHook.mock.lastCall![1].ref).toEqual({ chaId: "c", chatId: "b" });
    pending.resolve("B answer");
    await until(() => ui.stop() === null);
    expect(ui.result()?.textContent).toContain("B answer");
    selectChat("c", "a");
    flushSync();
    expect(ui.result()?.textContent).toContain("A completed while viewing B");
    expect(ui.result()?.textContent).not.toContain("A after editing");
    expect(ui.result()?.textContent).not.toContain("B answer");
    ui.click(ui.result()!.querySelector(`[aria-label="${language.inputHooks.btwDismiss}"]`));
    expect(ui.result()).toBeNull();
    selectChat("c", "b");
    flushSync();
    expect(ui.result()?.textContent).toContain("B answer");
    expect(io.alertError).not.toHaveBeenCalled();
});

it("preserves the previous BTW result on empty, failed and aborted runs with only the required alerts", async () => {
    const ui = await mountBtwComposer();
    ui.type("main question");
    ui.enter(ui.draft()!, "existing draft");
    const initial = holdHook();
    ui.runBtw();
    initial.resolve("Previous BTW answer");
    await until(() => ui.stop() === null);
    for (const outcome of ["empty", "failure", "abort"]) {
        const pending = holdHook();
        io.alertError.mockClear();
        ui.runBtw();
        expect(ui.result()?.textContent ?? "").toContain("Previous BTW answer");
        if (outcome === "empty") pending.resolve(" \n\t ");
        if (outcome === "failure") pending.reject(new Error("BTW provider failed"));
        if (outcome === "abort") {
            const signal = io.runInputHook.mock.lastCall![1].signal!;
            ui.click(ui.stop());
            expect(signal.aborted).toBe(true);
            pending.reject(new DOMException("cancelled", "AbortError"));
        }
        await until(() => ui.stop() === null);
        expect(ui.result()?.textContent ?? "").toContain("Previous BTW answer");
        expect(ui.boxes()).toEqual(["main question", "existing draft", ""]);
        if (outcome === "abort") expect(io.alertError).not.toHaveBeenCalled();
        else
            expect(io.alertError).toHaveBeenCalledExactlyOnceWith(
                outcome === "empty" ? language.errors.emptyText : "BTW provider failed",
            );
    }
    expect(io.createJob).not.toHaveBeenCalled();
});

it("runs the currently chosen hook without sending, preserves main text, and reloads the resulting draft", async () => {
    const ui = await mountHookComposer();
    const { findChat } = await import("src/ts/storage/chatStore.svelte");
    const before = JSON.parse(JSON.stringify(findChat({ chaId: "c", chatId: "a" })));
    expect(ui.draft()).not.toBeNull();
    expect(ui.sendDraft().disabled).toBe(true);
    ui.type("original main");
    ui.enter(ui.draft()!, "previous draft");
    // Lookup happens at Send, so edits to the selected hook after mount take effect.
    ui.settings.inputHooks[0].prompt = "Updated prompt";
    const pending = holdHook();
    ui.click(ui.target.querySelector(".button-icon-send"));
    expect(io.runInputHook).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: "draft-hook", prompt: "Updated prompt" }),
        expect.objectContaining({
            ref: { chaId: "c", chatId: "a" },
            content: "original main",
            draft: "previous draft",
            signal: expect.any(AbortSignal),
        }),
    );
    expect(ui.boxes()).toEqual(["original main", "previous draft", ""]);
    expect(ui.input().readOnly).toBe(false);
    expect(ui.draft()!.readOnly).toBe(false);
    expect(ui.target.querySelector('[role="status"]')?.textContent).toBe(language.inputHooks.runningDraft);
    pending.resolve("converted draft");
    await until(() => ui.target.querySelector('[aria-labelledby="cancel"]') === null);
    expect(ui.boxes()).toEqual(["original main", "converted draft", ""]);
    expect(io.createJob).not.toHaveBeenCalled();
    expect(findChat({ chaId: "c", chatId: "a" })).toEqual(before);
    ui.hide();
    expect(await drive(ui.journal.readComposer(a))).toEqual({
        input: "original main",
        draft: "converted draft",
        translate: "",
        files: [],
    });
    const reloaded = await mountHookComposer({ reload: true, configureChat: () => {} });
    await until(() => reloaded.input().value === "original main");
    expect(reloaded.draft()!.value).toBe("converted draft");
    expect(io.alertError).not.toHaveBeenCalled();
});

it.each(["empty", "failure", "abort"] as const)(
    "keeps both boxes on a hook %s and reports only the required alert",
    async (outcome) => {
        const ui = await mountHookComposer();
        ui.type("original main");
        ui.enter(ui.draft()!, "existing draft");
        ui.settings.memoryTranslateMedia.useAutoTranslateInput = true;
        flushSync();
        ui.enter(ui.translation()!, "existing translation");
        const files = await attachHookAudio(ui);
        const pending = holdHook();
        ui.sendKey();
        if (outcome === "empty") pending.resolve(" \n ");
        if (outcome === "failure") pending.reject(new Error("hook provider failed"));
        if (outcome === "abort") {
            const signal = io.runInputHook.mock.calls[0][1].signal;
            ui.click(ui.target.querySelector('[aria-labelledby="cancel"]'));
            expect(signal.aborted).toBe(true);
            pending.reject(new DOMException("aborted", "AbortError"));
        }
        await until(() => ui.target.querySelector('[aria-labelledby="cancel"]') === null);
        expect(ui.boxes()).toEqual(["original main", "existing draft", "existing translation"]);
        ui.hide();
        expect(await drive(ui.journal.readComposer(a))).toEqual({
            input: "original main",
            draft: "existing draft",
            translate: "existing translation",
            files,
        });
        expect(ui.target.querySelector("audio")).not.toBeNull();
        expect(io.createJob).not.toHaveBeenCalled();
        if (outcome === "abort") expect(io.alertError).not.toHaveBeenCalled();
        else
            expect(io.alertError).toHaveBeenCalledExactlyOnceWith(
                outcome === "empty" ? language.errors.emptyText : "hook provider failed",
            );
    },
);

it.each(["main", "draft", "chat"] as const)(
    "silently drops hook results and failures after the %s changes, even when restored",
    async (changed) => {
        const ui = await mountHookComposer();
        ui.type("original main");
        ui.enter(ui.draft()!, "existing draft");
        for (const outcome of ["success", "failure"] as const) {
            const pending = holdHook();
            ui.sendKey();
            if (changed === "chat") {
                selectChat("c", "b");
                flushSync();
                selectChat("c", "a");
                flushSync();
            } else {
                const node = changed === "main" ? ui.input() : ui.draft()!;
                const original = node.value;
                ui.enter(node, "edited meanwhile");
                ui.enter(node, original);
            }
            if (outcome === "success") pending.resolve("outdated result");
            else pending.reject(new Error("outdated error"));
            await until(() => ui.target.querySelector('[aria-labelledby="cancel"]') === null);
            expect(ui.boxes()).toEqual(["original main", "existing draft", ""]);
            expect(io.alertError).not.toHaveBeenCalled();
        }
        expect(io.createJob).not.toHaveBeenCalled();
    },
);

it("accepts a hook result after only the translation box changes", async () => {
    const ui = await mountHookComposer();
    ui.type("original main");
    ui.settings.memoryTranslateMedia.useAutoTranslateInput = true;
    flushSync();
    const pending = holdHook();
    ui.sendKey();
    ui.enter(ui.translation()!, "translation edited meanwhile");
    pending.resolve("converted draft");
    await until(() => ui.target.querySelector('[aria-labelledby="cancel"]') === null);
    expect(ui.boxes()).toEqual(["original main", "converted draft", "translation edited meanwhile"]);
    expect(io.alertError).not.toHaveBeenCalled();
    expect(io.createJob).not.toHaveBeenCalled();
});

it("refuses another Send, auto mode, reroll and Send Draft while a hook runs", async () => {
    const ui = await mountHookComposer({
        configureChat: (chat) => {
            chat.draftHookId = "draft-hook";
        },
        configureCharacter: (character) => {
            Object.assign(character, { type: "group", characters: [], characterTalks: [], characterActive: [] });
        },
    });
    ui.type("original main");
    ui.enter(ui.draft()!, "existing draft");
    const pending = holdHook();
    ui.sendKey();
    ui.sendKey();
    expect(ui.sendDraft().disabled).toBe(true);
    ui.sendKey(ui.draft()!);
    ui.input().dispatchEvent(
        new KeyboardEvent("keydown", { key: "m", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    ui.menu();
    ui.click(ui.menuItem(language.autoMode));
    await drive(Promise.resolve());
    expect(io.runInputHook).toHaveBeenCalledTimes(1);
    expect(io.createJob).not.toHaveBeenCalled();
    expect(ui.boxes()).toEqual(["original main", "existing draft", ""]);
    ui.click(ui.target.querySelector('[aria-labelledby="cancel"]'));
    pending.resolve("ignored after Stop");
    await until(() => ui.target.querySelector('[aria-labelledby="cancel"]') === null);
});

it.each(["Continue", "slash command", "empty main", "playground", "missing hook"] as const)(
    "keeps the existing send path for %s",
    async (kind) => {
        const ui = await mountHookComposer({
            characterId: kind === "playground" ? "§playground" : "c",
            configureChat: (chat) => {
                chat.draftHookId = kind === "missing hook" ? "deleted-hook" : "draft-hook";
            },
        });
        const input = kind === "empty main" ? "" : kind === "slash command" ? "/comment command text" : "ordinary main";
        ui.type(input);
        io.createJob.mockImplementationOnce(() => new Promise(() => {}));
        if (kind === "Continue") {
            ui.menu();
            ui.click(ui.menuItem(language.continueResponse));
        } else ui.sendKey();
        if (kind === "slash command") {
            await until(() => ui.input().value === "");
            const { findChat } = await import("src/ts/storage/chatStore.svelte");
            expect(findChat({ chaId: "c", chatId: "a" })!.message.at(-1)!.data).toBe(
                "earlier answer<Comment>\ncommand text\n</Comment>",
            );
            expect(io.createJob).not.toHaveBeenCalled();
        } else {
            await until(() => io.createJob.mock.calls.length === 1);
            expect(io.createJob.mock.calls[0][0].context.input ?? "").toBe(input);
            expect(ui.input().value).toBe("");
        }
        expect(io.runInputHook).not.toHaveBeenCalled();
        if (kind === "playground" || kind === "missing hook") expect(ui.draft()).toBeNull();
    },
);

async function attachHookAudio(ui: Awaited<ReturnType<typeof mountHookComposer>>) {
    const written = new Promise<void>((resolve) => {
        io.inlayWritten = resolve;
    });
    io.selectFiles.mockResolvedValue([{ name: "voice.mp3", data: new Uint8Array([1, 2, 3]) }]);
    ui.menu();
    ui.click(ui.menuItem(language.postFile));
    await written;
    await until(() => ui.target.querySelector("audio") !== null);
    io.inlayWritten = null;
    ui.hide();
    return (await drive(ui.journal.readComposer(a)))!.files;
}

it("sends the draft with attachments, clears all four parts, and restores a failed send for an unchanged retry", async () => {
    const ui = await mountHookComposer();
    ui.type("original main");
    ui.enter(ui.draft()!, "/draft text is not a command");
    ui.settings.memoryTranslateMedia.useAutoTranslateInput = true;
    flushSync();
    ui.enter(ui.translation()!, "translation");
    const files = await attachHookAudio(ui);
    const saved = { input: "original main", draft: "/draft text is not a command", translate: "translation", files };
    let refuse!: (error: Error) => void;
    io.createJob.mockImplementationOnce(
        () =>
            new Promise((_, reject) => {
                refuse = reject;
            }),
    );
    ui.click(ui.sendDraft());
    expect(ui.boxes()).toEqual(["", "", ""]);
    expect(ui.target.querySelector("audio")).toBeNull();
    await until(() => io.createJob.mock.calls.length === 1);
    const request = io.createJob.mock.calls[0][0];
    expect(request.context.input).toBe(`/draft text is not a command{{inlayed::${files[0]}}}`);
    expect(await drive(ui.journal.readComposerSend(a))).toEqual({
        ...saved,
        state: "sending",
        sent: "draft",
        userMessageId: request.context.userMessageId,
        requestId: request.requestId,
        requestEpoch: io.server!.epoch,
    });
    refuse(new Error("create answer lost"));
    await until(() => ui.input().value === "original main");
    expect(ui.boxes()).toEqual(["original main", "/draft text is not a command", "translation"]);
    await until(() => ui.target.querySelector("audio") !== null);
    expect(await drive(ui.journal.readComposer(a))).toMatchObject({
        ...saved,
        sent: "draft",
        userMessageId: request.context.userMessageId,
    });
    expect(await drive(ui.journal.readComposerSend(a))).toBeNull();
    io.createJob.mockImplementationOnce(() => new Promise(() => {}));
    ui.click(ui.sendDraft());
    await until(() => io.createJob.mock.calls.length === 2);
    expect(io.createJob.mock.calls[1][0].context).toMatchObject({
        input: request.context.input,
        userMessageId: request.context.userMessageId,
    });
    expect(io.createJob.mock.calls[1][0].requestId).toBe(request.requestId);
    expect(io.runInputHook).not.toHaveBeenCalled();
});

it.each(["draft", "translation", "attachments"] as const)(
    "keeps a failed draft send unplaced while newer %s occupy the composer, including after switching back",
    async (part) => {
        const ui = await mountHookComposer();
        ui.type("original main");
        ui.enter(ui.draft()!, "converted draft");
        ui.settings.memoryTranslateMedia.useAutoTranslateInput = true;
        flushSync();
        ui.enter(ui.translation()!, "original translation");
        const files = await attachHookAudio(ui);
        const saved = { input: "original main", draft: "converted draft", translate: "original translation", files };
        let refuse!: (error: Error) => void;
        io.createJob.mockImplementationOnce(
            () =>
                new Promise((_, reject) => {
                    refuse = reject;
                }),
        );
        ui.click(ui.sendDraft());
        await until(() => io.createJob.mock.calls.length === 1);
        if (part === "attachments") await attachHookAudio(ui);
        else ui.enter(part === "draft" ? ui.draft()! : ui.translation()!, "newer text");
        const newer = ui.boxes();
        refuse(new Error("send failed"));
        const { isChatBusy } = await import("src/ts/process/chatStatus.svelte");
        await until(() => !isChatBusy({ chaId: "c", chatId: "a" }));
        expect(ui.boxes()).toEqual(newer);
        expect(await drive(ui.journal.readComposerSend(a))).toMatchObject(saved);
        selectChat("c", "b");
        flushSync();
        selectChat("c", "a");
        flushSync();
        await drive(Promise.resolve());
        expect(ui.boxes()).toEqual(newer);
        expect(await drive(ui.journal.readComposerSend(a))).toMatchObject(saved);
        if (part === "attachments") {
            await until(() => ui.target.querySelector("audio") !== null);
            ui.click(ui.target.querySelector("audio")!.parentElement!.querySelector("button"));
        } else ui.enter(part === "draft" ? ui.draft()! : ui.translation()!, "");
        ui.hide();
        await drive(ui.journal.readComposer(a));
        selectChat("c", "b");
        flushSync();
        selectChat("c", "a");
        flushSync();
        await until(() => ui.input().value === "original main");
        expect(ui.boxes()).toEqual(["original main", "converted draft", "original translation"]);
        await until(() => ui.target.querySelector("audio") !== null);
        expect(await drive(ui.journal.readComposerSend(a))).toBeNull();
    },
);
