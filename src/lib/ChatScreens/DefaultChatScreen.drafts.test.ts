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
