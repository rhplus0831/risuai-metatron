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
vi.mock("src/ts/network/generationJobs", async (original) =>
    (await import("src/ts/network/tests/generationJobsMock")).createGenerationJobsMock({
        ...(await original<typeof import("src/ts/network/generationJobs")>()),
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

async function mountComposer() {
    io.createJob.mockReset();
    io.generationFetch.mockReset();
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

async function useHttpCreation() {
    const transport = await vi.importActual<typeof import("src/ts/network/generationJobs")>(
        "src/ts/network/generationJobs",
    );
    const { NO_GENERATION_HOOKS } = await import("../../../shared/jobs.ts");
    io.createJob.mockImplementation((body, options) =>
        transport.createGenerationJob({ ...body, hooks: NO_GENERATION_HOOKS }, options),
    );
    return transport;
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
