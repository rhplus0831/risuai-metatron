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
}));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
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
    expect(await drive(journal.readComposer(a))).toEqual({
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
    expect(await drive(journal.readComposer(a))).toEqual({
        input: `A to send{{inlayed::${sendFiles[0]}}}`,
        translate: "",
        files: [],
        userMessageId: request.context.userMessageId,
        requestId: request.requestId,
        requestEpoch: io.server!.epoch,
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
        expect(await drive(first.journal.readComposer(a))).toEqual({
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
        expect(await drive(first.journal.readComposer(a))).toMatchObject({
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
        expect(await drive(journal.readComposer(a))).toMatchObject({ requestId: post.requestId });
        if (!selected) {
            selectChat("c", "b");
            flushSync();
            await until(() => input().value === "B from a previous page");
        }
        refuse(Response.json({ error: "stale" }, { status: 409 }));
        await until(() => !isChatBusy({ chaId: "c", chatId: "a" }));
        const saved = await drive(journal.readComposer(a));
        expect(saved).toMatchObject({ input: text, userMessageId: post.context.userMessageId });
        expect(saved).not.toHaveProperty("requestId");
        expect(saved).not.toHaveProperty("requestEpoch");
        if (!selected) {
            expect(input().value).toBe("B from a previous page");
            selectChat("c", "a");
            flushSync();
        }
        await until(() => input().value === text);
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
    expect(await drive(journal.readComposer(a))).toEqual({
        state: "sending",
        input: text,
        translate: "",
        files: [],
        userMessageId: post.context.userMessageId,
    });
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
