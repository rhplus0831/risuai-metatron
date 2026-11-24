// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat as ChatRecord, MessageTranslation } from "../../../shared/database.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";

// A chat row on the stored-translation path (`translation.md`): the LLM translator on
// `llmTranslationTarget: "message"` shows the held message's fresh stored translation through the
// normal display path, re-deriving it when the chat's refresh brings one (no remount), keeps the
// row's show/hide choice across a remount, requests a translation only when none is fresh, and edits
// through a captured session. The rendered path (`"rendered"`, or a row without a message id) is
// unchanged: `translateHTML` runs and the stored translation is never shown. Auto-show is the chat's
// own `autoTranslate`, counted only while a target language is set; on the rendered path a change of
// it on a mounted row starts or stops the translation.

const hoisted = vi.hoisted(() => ({
    alerts: { error: vi.fn(), confirm: vi.fn(), normal: vi.fn() },
    auth: { fetch: null as null | ((path: string, init: RequestInit) => Promise<Response>) },
    translateHTML: vi.fn(async (html: string) => `[T]${html}`),
    edittrans: vi.fn((text: string) => text),
}));

vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertError: hoisted.alerts.error,
        alertConfirm: hoisted.alerts.confirm,
        alertNormal: hoisted.alerts.normal,
    }),
);
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({
    risuChatParser: vi.fn((text: string) => text),
    risuChatParserForDisplay: vi.fn((text: string) => text),
    ParseMarkdown: vi.fn(async (text: string) => `<p>${text}</p>`),
    trimMarkdown: vi.fn((html: string) => html),
    postTranslationParse: vi.fn(async (html: string) => html),
    getDistance: vi.fn(() => 0),
    parseMarkdownSafe: vi.fn((text: string) => text),
}));
vi.mock("src/ts/parser/transformClient", () => ({
    captureTransform: vi.fn(() => null),
    rerenderMessage: vi.fn(),
    resetTransformEffects: vi.fn(),
}));
vi.mock("src/ts/globalApi.svelte", async () =>
    (await import("src/ts/tests/globalApiMock")).createGlobalApiMock({ createChatCopyName: vi.fn(() => "copy") }),
);
vi.mock("src/ts/model/modellist", () => ({ getModelInfo: vi.fn(() => ({ shortName: "model" })) }));
vi.mock("src/ts/process/serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock(),
);
vi.mock("src/ts/process/tts", () => ({ sayTTS: vi.fn() }));
vi.mock("src/ts/util", () => ({
    capitalize: (text: string) => text,
    getUserIcon: () => "",
    getUserName: () => "User",
    sleep: async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    selectSingleFile: vi.fn(),
    selectFileByDom: vi.fn(),
    decryptBuffer: vi.fn(),
    encryptBuffer: vi.fn(),
    BufferToText: vi.fn(),
}));
vi.mock("src/ts/translator/translator", () => ({
    translateHTML: hoisted.translateHTML,
    getLLMCache: vi.fn(async () => null),
    llmTranslationCacheKey: (source: string) => `llm:k:${source}`,
    readLLMCacheEntry: vi.fn(async () => null),
    writeLLMCacheEntry: vi.fn(async () => undefined),
    applyEdittransToStoredTranslation: hoisted.edittrans,
    exportLLMCacheAsJSON: vi.fn(),
    importLLMCacheFromJSON: vi.fn(),
    clearLLMCache: vi.fn(),
}));
vi.mock("src/ts/storage/serverAuth", () => ({
    ensureAuth: async () => {},
    authFetch: (path: string, init: RequestInit) => hoisted.auth.fetch!(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("src/ts/storage/resourceSync.svelte", async () =>
    (await import("src/ts/tests/bootMocks")).createBootMock("resourceSync", {
        beginMutationScope: () => ({ resource: 0, chat: 0 }),
        flushResources: async () => ({ discarded: [], refused: [] }),
    }),
);

import { language } from "src/lang";
import * as popupEditorMode from "src/ts/gui/popupEditorMode";
import { runServerJob } from "src/ts/process/serverCommands";
import { characterList, selectedCharacter } from "src/ts/storage/characterStore.svelte";
import {
    ackChatWork,
    assembleChats,
    chatList,
    createChat,
    findChat,
    hydrateChat,
    noteRemoteStreaming,
    patchMessage,
    removeMessages,
    seedChats,
    selectCandidate,
    selectChat,
    setChatMeta,
    setMessageText,
    setMessageTranslation,
    takeChatWork,
} from "src/ts/storage/chatStore.svelte";
import { setResourceEpoch } from "src/ts/storage/resourceClient";
import { messageEditorReplyKey, openCachedTranslationDraft } from "src/ts/storage/messageEditorDrafts.svelte";
import { selectCharacter, selectModelPreset, selectPersona, selectPreset } from "src/ts/storage/selection.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { createSimpleCharacter, popupStore, ReloadChatPointer, reloadChatKey } from "src/ts/stores.svelte";
import { readLLMCacheEntry, writeLLMCacheEntry } from "src/ts/translator/translator";
import PopupEditor from "../Others/PopupEditor.svelte";
import PopupList from "../UI/PopupList.svelte";
import Chat from "./Chat.svelte";

const EPOCH = "00000000-0000-0000-0000-000000000000";
const rev = (n: number) => `${EPOCH}:1:${n}`;
const tr = (text: string, source: string, extra: Partial<MessageTranslation> = {}): MessageTranslation => ({
    text,
    sourceHash: translationSourceHash(source),
    targetLanguage: "ko",
    translatedAt: 1,
    ...extra,
});
const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

const fetchCalls: { path: string; body: Record<string, unknown> }[] = [];
let revision = 1;

/**
 * Installs the records and holds chat `chatId` of character `c` (messages a "A", b "B"), selected.
 * `autoTranslate` is the chat's own field; `translator` the target language (`ko`).
 */
function boot(
    chatId: string,
    options: {
        translation?: MessageTranslation;
        autoTranslate?: boolean;
        target?: "message" | "rendered";
        translator?: string;
    } = {},
) {
    installFlatDatabase({
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "C",
                firstMessage: "Hello",
                chatPage: 0,
                customscript: [],
                emotionImages: [],
                additionalAssets: [],
                triggerscript: [],
            },
        ],
        botPresets: [{ id: "p1", name: "P1" }],
        modelPresets: [{ id: "m1", name: "M1" }],
        personas: [{ id: "u1", name: "U1" }],
        translatorType: "llm",
        translator: options.translator ?? "ko",
        llmTranslationTarget: options.target ?? "message",
        translateBeforeHTMLFormatting: false,
        legacyTranslation: false,
        autoTranslateCachedOnly: false,
        showTranslationLoading: true,
        zoomsize: 100,
        lineHeight: 1.25,
        iconsize: 100,
        theme: "",
        enableBlockPartialEdit: false,
        enableDragPartialEdit: false,
    });
    selectPreset("p1");
    selectModelPreset("m1");
    selectPersona("u1");
    const data = {
        id: chatId,
        name: "K",
        note: "",
        localLore: [],
        ...(options.autoTranslate ? { autoTranslate: true } : {}),
        message: [
            {
                role: "char",
                data: "A",
                chatId: "a",
                ...(options.translation ? { translation: options.translation } : {}),
            },
            { role: "user", data: "B", chatId: "b" },
        ],
    } as unknown as ChatRecord;
    revision = 1;
    const listed = [{ characterId: "c", id: chatId, revision: rev(revision), trashedAt: null, data }];
    const orders = [{ characterId: "c", revision: rev(1), ids: [chatId] }];
    seedChats(listed, orders);
    assembleChats([selectedCharacter() ?? { chaId: "c" }] as never, listed, orders);
    selectCharacter("c");
    selectChat("c", chatId);
    setResourceEpoch("e1");
    const ref = { chaId: "c", chatId };
    const held = (id = "a") => findChat(ref)!.message.find((message) => message.chatId === id);
    /** The server's copy after the runner stored `translation` on message `id` (the chat's refresh). */
    const hydrate = (id: string, translation: MessageTranslation | undefined) => {
        revision += 1;
        return hydrateChat({
            characterId: "c",
            id: chatId,
            revision: rev(revision),
            data: JSON.parse(
                JSON.stringify({
                    ...findChat(ref)!,
                    message: findChat(ref)!.message.map((message) =>
                        message.chatId === id ? { ...message, translation } : { ...message },
                    ),
                }),
            ) as ChatRecord,
        });
    };
    return { ref, held, hydrate };
}

const mounted: ReturnType<typeof mount>[] = [];

function render(
    props: Partial<
        Pick<
            Parameters<typeof Chat>[1],
            "message" | "messageId" | "idx" | "rerollIcon" | "altGreeting" | "onReroll" | "unReroll"
        >
    > = {},
) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const instance = mount(Chat, {
        target,
        props: {
            message: props.message ?? "A",
            isLastMemory: false,
            idx: props.idx ?? 0,
            messageId: "messageId" in props ? props.messageId : "a",
            character: createSimpleCharacter(selectedCharacter()),
            name: "C",
            role: "char",
            img: "",
            ...props,
        },
    });
    mounted.push(instance);
    flushSync();
    const body = () => target.querySelector(".chattext")!;
    const text = () => body().textContent?.replace(/\s+/g, " ").trim() ?? "";
    const toggle = () => target.querySelector<HTMLButtonElement>(".button-icon-translate")!;
    const button = (label: string) =>
        [...target.querySelectorAll("button")].find((entry) => entry.textContent?.includes(label)) ?? null;
    const textarea = () => target.querySelector<HTMLTextAreaElement>("textarea");
    const spinner = () => body().innerHTML.includes("animation: spin");
    const click = (element: HTMLElement | null) => {
        expect(element).not.toBeNull();
        element!.click();
        flushSync();
    };
    const expectText = (expected: string) => vi.waitFor(() => expect(text()).toBe(expected));
    return {
        target,
        instance,
        body,
        text,
        toggle,
        button,
        textarea,
        spinner,
        click,
        expectText,
        remount: () => {
            unmount(instance);
            mounted.splice(mounted.indexOf(instance), 1);
            return render(props);
        },
    };
}

function setReplyLock(ref: { chaId: string; chatId: string }, messageId?: string) {
    noteRemoteStreaming([
        {
            characterId: ref.chaId,
            id: ref.chatId,
            streaming: messageId ? [{ messageId, generationId: "reply", seq: 0 }] : [],
        },
    ]);
    flushSync();
}

beforeEach(() => {
    fetchCalls.length = 0;
    hoisted.alerts.error.mockReset();
    hoisted.alerts.confirm.mockReset();
    hoisted.alerts.confirm.mockResolvedValue(true);
    hoisted.translateHTML.mockClear();
    hoisted.edittrans.mockClear();
    vi.mocked(runServerJob).mockReset();
    vi.mocked(runServerJob).mockResolvedValue({ outcome: "refused", terminal: null });
    ReloadChatPointer.set({});
    hoisted.auth.fetch = async () => {
        throw new Error("no transport scripted");
    };
});

describe("chat row form submissions", () => {
    let previousClickToEdit: boolean;

    beforeEach(() => {
        previousClickToEdit = settings.ui.clickToEdit;
    });

    afterEach(() => {
        settings.ui.clickToEdit = previousClickToEdit;
    });

    const markup = `<form risu-form="survey">
        <input name="answer" value="initial">
        <input name="choices" value=""><input name="choices" value="second">
        <input name="choices" value="third"><input name="__proto__" value="data">
        <input type="file" name="attachment"><button type="submit">Submit</button>
    </form>`;

    async function renderForm(message = markup, messageId = "a") {
        const ui = render({ message, messageId });
        await ui.instance.whenRendered();
        flushSync();
        const form = ui.body().querySelector("form")!;
        expect(form).not.toBeNull();
        return { ui, form };
    }

    function submit(form: HTMLFormElement) {
        const event = new SubmitEvent("submit", { bubbles: true, cancelable: true });
        form.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    }

    it("keeps form controls usable when click-to-edit is enabled", async () => {
        boot("form-click-to-edit");
        settings.ui.clickToEdit = true;
        const { ui, form } = await renderForm(
            markup.replace(
                "</form>",
                `<input type="checkbox" name="confirmed" value="yes">
                <select name="topic">
                    <option value="general">General</option>
                    <option value="details">Details</option>
                </select></form>`,
            ),
        );
        ui.click(form.querySelector<HTMLInputElement>('[name="answer"]'));
        await tick();
        flushSync();
        expect(ui.target.querySelector('form[risu-form="survey"]')).toBe(form);
        expect(ui.textarea()).toBeNull();

        const answer = form.querySelector<HTMLInputElement>('[name="answer"]')!;
        const confirmed = form.querySelector<HTMLInputElement>('[name="confirmed"]')!;
        const topic = form.querySelector<HTMLSelectElement>('[name="topic"]')!;
        expect(confirmed).not.toBeNull();
        expect(topic).not.toBeNull();
        expect(topic.options).toHaveLength(2);
        answer.value = "my Lua form answer";
        answer.dispatchEvent(new Event("input", { bubbles: true }));
        ui.click(confirmed);
        ui.click(topic);
        topic.value = "details";
        topic.dispatchEvent(new Event("change", { bubbles: true }));

        ui.click(form.querySelector<HTMLButtonElement>('button[type="submit"]'));
        await tick();
        flushSync();
        expect(runServerJob).toHaveBeenCalledTimes(1);
        expect(vi.mocked(runServerJob).mock.calls[0][2]).toMatchObject({
            kind: "command",
            command: {
                type: "form",
                key: "survey",
                values: { answer: "my Lua form answer", confirmed: "yes", topic: "details" },
            },
        });
        expect(ui.body().querySelector('form[risu-form="survey"]')).toBe(form);
        expect(ui.textarea()).toBeNull();
        expect(form.querySelector<HTMLInputElement>('[name="answer"]')!.value).toBe("my Lua form answer");
        expect(form.querySelector<HTMLInputElement>('[name="confirmed"]')!.checked).toBe(true);
        expect(form.querySelector<HTMLSelectElement>('[name="topic"]')!.value).toBe("details");
    });

    it("keeps the form mounted after an input click when click-to-edit is disabled", async () => {
        boot("form-without-click-to-edit");
        settings.ui.clickToEdit = false;
        const { ui, form } = await renderForm();
        ui.click(form.querySelector<HTMLInputElement>('[name="answer"]'));
        await tick();
        flushSync();
        expect(ui.target.querySelector('form[risu-form="survey"]')).toBe(form);
        expect(ui.textarea()).toBeNull();
    });

    it("opens the message editor when plain message text is clicked with click-to-edit enabled", async () => {
        boot("plain-text-click-to-edit");
        settings.ui.clickToEdit = true;
        const ui = render({ message: "Plain message text" });
        await ui.instance.whenRendered();
        flushSync();
        expect(ui.textarea()).toBeNull();
        ui.click(ui.body().querySelector("p"));
        await tick();
        flushSync();
        expect(ui.textarea()).not.toBeNull();
    });

    it("submits string values once to the chat captured before a pending job and a chat switch", async () => {
        const { ref } = boot("form-source");
        const character = selectedCharacter();
        const second = createChat("c", {
            ...findChat(ref)!,
            id: "form-other",
            message: [{ role: "char", data: "Other chat", chatId: "other-message" }],
        });
        const pending = deferred<Awaited<ReturnType<typeof runServerJob>>>();
        vi.mocked(runServerJob).mockReturnValueOnce(pending.promise);
        const { form } = await renderForm();
        form.querySelector<HTMLInputElement>('[name="answer"]')!.value = "typed";
        const transfer = new DataTransfer();
        transfer.items.add(new File(["file contents"], "answer.txt", { type: "text/plain" }));
        form.querySelector<HTMLInputElement>('[type="file"]')!.files = transfer.files;

        submit(form);
        // The call must already exist before the selection changes or an awaited task runs.
        expect(runServerJob).toHaveBeenCalledTimes(1);
        const [target, capturedRef, request] = vi.mocked(runServerJob).mock.calls[0];
        expect(target).toBe(character);
        expect(capturedRef).toEqual(ref);
        expect(request).toMatchObject({
            kind: "command",
            context: { mode: "form" },
        });
        expect(request.command).toEqual({
            type: "form",
            key: "survey",
            values: { answer: "typed", choices: ["", "second", "third"], ["__proto__"]: "data" },
        });

        selectChat("c", second.id);
        flushSync();
        pending.resolve({ outcome: "started", terminal: null });
        await tick();
        flushSync();
        expect(runServerJob).toHaveBeenCalledTimes(1);
    });

    it("prevents navigation without sending unmarked forms or stale rows", async () => {
        boot("form-refusals");
        const unmarked = await renderForm('<form><input name="answer" value="typed"></form>');
        submit(unmarked.form);
        expect(runServerJob).not.toHaveBeenCalled();

        const stale = await renderForm(markup, "message-in-another-chat");
        submit(stale.form);
        await tick();
        expect(runServerJob).not.toHaveBeenCalled();
        expect(get(ReloadChatPointer)).toEqual({});
    });

    it("keeps typed values and the row reload counter on refusal and increments it for a started form", async () => {
        boot("form-reload");
        const key = reloadChatKey("a", 0);
        ReloadChatPointer.set({ [key]: 4, [reloadChatKey("b", 1)]: 9 });
        const { ui, form } = await renderForm();
        const answer = form.querySelector<HTMLInputElement>('[name="answer"]')!;
        answer.value = "keep my draft";
        submit(form);
        await tick();
        flushSync();
        expect(runServerJob).toHaveBeenCalledTimes(1);
        expect(get(ReloadChatPointer)).toEqual({ [key]: 4, [reloadChatKey("b", 1)]: 9 });
        expect(ui.body().querySelector("form")).toBe(form);
        expect(answer.value).toBe("keep my draft");

        vi.mocked(runServerJob).mockResolvedValueOnce({ outcome: "started", terminal: null });
        submit(form);
        await tick();
        flushSync();
        expect(runServerJob).toHaveBeenCalledTimes(2);
        expect(get(ReloadChatPointer)).toEqual({ [key]: 5, [reloadChatKey("b", 1)]: 9 });
    });
});

afterEach(() => {
    vi.useRealTimers();
    popupStore.children = null;
    popupStore.openId = 0;
    for (const instance of mounted.splice(0)) {
        unmount(instance);
    }
    document.body.innerHTML = "";
});

/** Scripts the transport: records each body and answers with `answer`. */
function answerWith(answer: (body: Record<string, unknown>) => Promise<Response>) {
    hoisted.auth.fetch = (path, init) => {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        fetchCalls.push({ path, body });
        return answer(body);
    };
}

describe("branching a pinned chat", () => {
    it("drops the OOC log and segment from a branch while keeping its OOC toggles", async () => {
        vi.useFakeTimers();
        const { ref } = boot("ooc-source");
        answerWith(async () => json(200, { revision: "memory-r1", inherited: true }));
        const ooc = {
            oocLog: {
                q: { id: "q", segment: "s", anchorMessageId: "a", question: "Why?", answer: "Because.", time: 1 },
            },
            oocSegment: { id: "s", anchorMessageId: "a" },
            oocToggles: { mode: "ooc", detail: "0" },
        };
        setChatMeta(ref, ooc);
        const ui = render();
        ui.click(ui.target.querySelector(".button-icon-menu"));
        await vi.advanceTimersByTimeAsync(0);
        expect(popupStore.children).not.toBeNull();
        const popupTarget = document.createElement("div");
        ui.target.appendChild(popupTarget);
        mounted.push(mount(PopupList, { target: popupTarget }));
        flushSync();
        ui.click(ui.button(language.branch));
        await vi.advanceTimersByTimeAsync(1);

        expect(chatList("c")).toHaveLength(2);
        const branch = chatList("c").find((entry) => entry.id !== ref.chatId)!;
        const branchedChat = findChat({ chaId: "c", chatId: branch.id })!;
        expect(branchedChat).not.toHaveProperty("oocLog");
        expect(branchedChat).not.toHaveProperty("oocSegment");
        expect(branchedChat.oocToggles).toEqual(ooc.oocToggles);
        expect(findChat(ref)).toMatchObject(ooc);
    });

    it("creates an unpinned branch of the surviving messages and requests memory from its source", async () => {
        vi.useFakeTimers();
        try {
            const { ref } = boot("pinned-source");
            answerWith(async () => json(200, { revision: "memory-r1", inherited: true }));
            setChatMeta(ref, { pinned: true });
            const ui = render();
            ui.click(ui.target.querySelector(".button-icon-menu"));
            await vi.advanceTimersByTimeAsync(0);
            expect(popupStore.children).not.toBeNull();
            const popupTarget = document.createElement("div");
            ui.target.appendChild(popupTarget);
            mounted.push(mount(PopupList, { target: popupTarget }));
            flushSync();
            ui.click(ui.button(language.branch));
            await vi.advanceTimersByTimeAsync(1);
            expect(chatList("c")).toHaveLength(2);
            const branch = chatList("c").find((entry) => entry.id !== ref.chatId)!;
            const branchedChat = findChat({ chaId: "c", chatId: branch.id })!;
            expect(branch).not.toHaveProperty("pinned");
            expect(branchedChat).not.toHaveProperty("pinned");
            expect(findChat(ref)).toHaveProperty("pinned", true);
            expect(branchedChat.message.filter(({ isComment }) => !isComment)).toEqual([
                { chatId: "a", role: "char", data: "A" },
            ]);
            expect(findChat(ref)?.message.map(({ chatId }) => chatId)).toEqual(["a", "b"]);
            expect(fetchCalls).toEqual([
                {
                    path: `/api/memory/structured/c/${encodeURIComponent(branch.id)}/inherit`,
                    body: { sourceChatId: ref.chatId },
                },
            ]);
        } finally {
            vi.useRealTimers();
        }
    });
});

// "Create Folder on Branch" reads the source chat's folder through `chatFolderOf`, so a `folderId`
// naming no folder of the character counts as no folder.
describe("branching with Create Folder on Branch", () => {
    async function branch() {
        const ui = render();
        ui.click(ui.target.querySelector(".button-icon-menu"));
        await vi.waitFor(() => expect(popupStore.children).not.toBeNull());
        const popupTarget = document.createElement("div");
        ui.target.appendChild(popupTarget);
        mounted.push(mount(PopupList, { target: popupTarget }));
        flushSync();
        ui.click(ui.button(language.branch));
        await vi.waitFor(() => expect(chatList("c")).toHaveLength(2));
    }
    const owner = () => characterList().find((entry) => entry?.chaId === "c")!;

    it("creates the branch folder for a chat whose folder id names no folder", async () => {
        const { ref } = boot("dangling-source");
        settings.ui.createFolderOnBranch = true;
        owner().chatFolders = [{ id: "other", name: "Other", folded: false }];
        setChatMeta(ref, { folderId: "gone" });
        await branch();
        const folders = owner().chatFolders;
        expect(folders.map((folder) => folder.name)).toEqual(["Branches of K", "Other"]);
        const branchFolder = folders[0].id;
        const copy = chatList("c").find((entry) => entry.id !== ref.chatId)!;
        expect(findChat(ref)?.folderId).toBe(branchFolder);
        expect(copy.folderId).toBe(branchFolder);
    });

    it("keeps a chat that is in an existing folder there, with no new folder", async () => {
        const { ref } = boot("filed-source");
        settings.ui.createFolderOnBranch = true;
        owner().chatFolders = [{ id: "f", name: "Folder", folded: false }];
        setChatMeta(ref, { folderId: "f" });
        await branch();
        expect(owner().chatFolders.map((folder) => folder.id)).toEqual(["f"]);
        const copy = chatList("c").find((entry) => entry.id !== ref.chatId)!;
        expect(findChat(ref)?.folderId).toBe("f");
        expect(copy.folderId).toBe("f");
    });
});

describe("branching while a reply generates", () => {
    async function branchButton(row: ReturnType<typeof render>) {
        row.click(row.target.querySelector(".button-icon-menu"));
        await vi.advanceTimersByTimeAsync(0);
        const popupTarget = document.createElement("div");
        row.target.appendChild(popupTarget);
        mounted.push(mount(PopupList, { target: popupTarget }));
        flushSync();
        return row.button(language.branch)!;
    }

    it.each(["before the menu opens", "after the click"])(
        "leaves the chat and its folders alone when the reply locks %s",
        async (when) => {
            vi.useFakeTimers();
            const lockedBeforeClick = when === "before the menu opens";
            const { ref } = boot(lockedBeforeClick ? "locked-branch" : "branch-lock-race");
            settings.ui.createFolderOnBranch = true;
            answerWith(async () => json(200, { revision: "memory-r1", inherited: true }));
            if (lockedBeforeClick) setReplyLock(ref, "b");
            const branch = await branchButton(render({ message: "B", messageId: "b", idx: 1 }));
            expect(branch.disabled).toBe(lockedBeforeClick);
            branch.click();
            if (!lockedBeforeClick) setReplyLock(ref, "b");
            await vi.advanceTimersByTimeAsync(1);

            expect(chatList("c").map(({ id }) => id)).toEqual([ref.chatId]);
            expect(selectedCharacter()?.chatFolders ?? []).toEqual([]);
            expect(findChat(ref)?.folderId).toBeUndefined();
        },
    );

    it("copies through the preceding finished reply while the later reply generates", async () => {
        vi.useFakeTimers();
        const { ref } = boot("earlier-branch");
        settings.ui.createFolderOnBranch = true;
        answerWith(async () => json(200, { revision: "memory-r1", inherited: true }));
        setReplyLock(ref, "b");
        const branch = await branchButton(render());
        expect(branch.disabled).toBe(false);
        branch.click();
        await vi.advanceTimersByTimeAsync(1);

        const copy = chatList("c").find(({ id }) => id !== ref.chatId)!;
        expect(findChat({ ...ref, chatId: copy.id })?.message.filter(({ isComment }) => !isComment)).toEqual([
            { chatId: "a", role: "char", data: "A" },
        ]);
        expect((selectedCharacter()?.chatFolders ?? []).map(({ id }) => id)).toEqual([copy.folderId]);
    });
});

describe("the Disable toggles", () => {
    it("Disable Message and Cut Messages for AI queue a patch of the one `disabled` field, never the row", async () => {
        const { ref, held } = boot("toggles");
        const ui = render();
        /** Opens the row's menu (the minor buttons with their names) and clicks the button `label`. */
        const clickInMenu = async (label: string) => {
            ui.click(ui.target.querySelector(".button-icon-menu"));
            await vi.waitFor(() => expect(popupStore.children).not.toBeNull());
            const popupTarget = document.createElement("div");
            ui.target.appendChild(popupTarget);
            const popup = mount(PopupList, { target: popupTarget });
            flushSync();
            ui.click(ui.button(label));
            unmount(popup);
            popupTarget.remove();
            popupStore.children = null;
            popupStore.openId = 0;
        };
        /** The ops queued for the chat since the last call, acknowledged. */
        const queued = () => {
            const work = takeChatWork(new Set());
            revision += 1;
            ackChatWork(work, [{ characterId: "c", id: ref.chatId, revision: rev(revision) }], []);
            return work.groups[0]?.ops ?? [];
        };

        await clickInMenu(language.disableMessage);
        await vi.waitFor(() => expect(held()!.disabled).toBe(true));
        expect(queued()).toEqual([{ op: "patchMessage", id: "a", set: { disabled: true } }]);
        await clickInMenu(language.disableMessage);
        await vi.waitFor(() => expect(held()!.disabled).toBe(false));
        expect(queued()).toEqual([{ op: "patchMessage", id: "a", set: { disabled: false } }]);

        await clickInMenu(language.disableAbove);
        await vi.waitFor(() => expect(held()!.disabled).toBe("allBefore"));
        expect(queued()).toEqual([{ op: "patchMessage", id: "a", set: { disabled: "allBefore" } }]);
        await clickInMenu(language.disableAbove);
        await vi.waitFor(() => expect(held()!.disabled).toBe(false));
        expect(queued()).toEqual([{ op: "patchMessage", id: "a", set: { disabled: false } }]);
        expect(held()).toEqual({ role: "char", data: "A", chatId: "a", disabled: false });
    });
});

it.each([
    { row: "older reply", props: { rerollIcon: true } },
    { row: "alternate greeting", props: { altGreeting: true, idx: -1, messageId: undefined } },
])("disables both reroll arrows on an $row while another reply generates", ({ row, props }) => {
    const { ref } = boot(`reroll-${row}`);
    settings.ui.swipe = true;
    const onReroll = vi.fn();
    const unReroll = vi.fn();
    const ui = render({ ...props, onReroll, unReroll });
    const arrows = [
        {
            direction: "previous",
            button: ui.target.querySelector<HTMLButtonElement>(".button-icon-unreroll")!,
            action: unReroll,
        },
        {
            direction: "next",
            button: ui.target.querySelector<HTMLButtonElement>(".button-icon-reroll")!,
            action: onReroll,
        },
    ];
    for (const { button } of arrows) expect(button.disabled).toBe(false);
    setReplyLock(ref, "b");
    try {
        for (const { direction, button, action } of arrows) {
            expect.soft(button.disabled, direction).toBe(true);
            ui.click(button);
            expect.soft(action, direction).not.toHaveBeenCalled();
            action.mockClear();
        }
    } finally {
        setReplyLock(ref);
    }
    for (const { button, action } of arrows) {
        expect(button.disabled).toBe(false);
        ui.click(button);
        expect(action).toHaveBeenCalledTimes(1);
    }
});

describe("the stored path: display", () => {
    it("with the chat's autoTranslate on, shows the stored translation the refresh brings without a remount, the original again when it is cleared, and a replacement in its turn", async () => {
        const { ref, hydrate } = boot("k1", { autoTranslate: true });
        const ui = render();
        await ui.expectText("A");
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(false);
        expect(fetchCalls).toEqual([]);

        const T = tr("ㄱ", "A");
        expect(hydrate("a", T)).toBe(true);
        await ui.expectText("ㄱ");
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(true);
        // The edittrans scripts ran on the shown translation; the rendered translation never did.
        expect(hoisted.edittrans).toHaveBeenCalledWith("ㄱ", expect.anything(), 0, null);
        expect(hoisted.translateHTML).not.toHaveBeenCalled();
        // The Retranslate and Edit controls are there, and the editor is enabled on a fresh translation.
        expect(ui.button(language.retranslate)).not.toBeNull();
        expect(ui.button(language.editTranslation)!.disabled).toBe(false);

        expect(setMessageTranslation(ref, "a", null)).toBe(true);
        await ui.expectText("A");
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(false);
        expect(ui.button(language.editTranslation)!.disabled).toBe(true);

        // A replacement (a local write here: the queued clear defers a hydration) shows in its turn.
        expect(setMessageTranslation(ref, "a", tr("ㄴ", "A"))).toBe(true);
        await ui.expectText("ㄴ");
        // A translation of another text (stale) is not shown.
        setMessageText(ref, "a", "A edited");
        await ui.expectText("A");
        expect(fetchCalls).toEqual([]);
    });

    it("shows an empty stored translation as empty, not as the original", async () => {
        boot("k2", { autoTranslate: true, translation: tr("", "A") });
        const ui = render();
        await vi.waitFor(() => expect(ui.body().innerHTML).toContain("<p></p>"));
        expect(ui.text()).toBe("");
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(true);
    });

    it("the toggle shows a fresh translation without a request and hides it again; the choice survives a remount and wins over the chat's autoTranslate", async () => {
        const { ref } = boot("k3", { translation: tr("ㄱ", "A") });
        let ui = render();
        await ui.expectText("A");
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(false);
        expect(ui.button(language.retranslate)).toBeNull();

        ui.click(ui.toggle());
        await ui.expectText("ㄱ");
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(true);
        expect(ui.button(language.retranslate)).not.toBeNull();
        expect(fetchCalls).toEqual([]);

        ui.click(ui.toggle());
        await ui.expectText("A");
        ui.click(ui.toggle());
        await ui.expectText("ㄱ");

        // The row remounts (the chat list rebuilds rows): the choice holds.
        ui = ui.remount();
        await ui.expectText("ㄱ");
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(true);

        // An explicit hide also holds, over the chat's autoTranslate turned on meanwhile.
        ui.click(ui.toggle());
        await ui.expectText("A");
        setChatMeta(ref, { autoTranslate: true });
        flushSync();
        ui = ui.remount();
        await ui.expectText("A");
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(false);
    });

    it("auto-show follows the chat's flag, not another chat's or a global one: turning it on shows the fresh translation without a click, and off hides it; nothing shows without a target language", async () => {
        const { ref } = boot("k3b", { translation: tr("ㄱ", "A") });
        const ui = render();
        await ui.expectText("A");
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(false);

        setChatMeta(ref, { autoTranslate: true });
        flushSync();
        await ui.expectText("ㄱ");
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(true);
        expect(fetchCalls).toEqual([]);
        expect(hoisted.translateHTML).not.toHaveBeenCalled();

        // No target language: the flag counts for nothing (the stored translation is not shown).
        settings.memoryTranslateMedia.translator = "";
        flushSync();
        await ui.expectText("A");
        settings.memoryTranslateMedia.translator = "ko";
        flushSync();
        await ui.expectText("ㄱ");

        setChatMeta(ref, {}, ["autoTranslate"]);
        flushSync();
        await ui.expectText("A");
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(false);
        expect(fetchCalls).toEqual([]);
    });

    it("with the flag on but no target language, a mounted row shows the original and requests nothing", async () => {
        // Fake timers: the window below runs every timer the row could start (the rendered path's
        // 10 ms start included) and the work they chain, at once.
        vi.useFakeTimers();
        boot("k3c", { autoTranslate: true, translator: "", translation: tr("ㄱ", "A") });
        const ui = render();
        await ui.expectText("A");
        await vi.advanceTimersByTimeAsync(1000);
        expect(ui.text()).toBe("A");
        expect(fetchCalls).toEqual([]);
        expect(hoisted.translateHTML).not.toHaveBeenCalled();
    });
});

describe("the stored path: requests", () => {
    it("the toggle requests a translation when none is fresh: pending until the refresh lands, spinner, disabled controls, and the stored translation shown after", async () => {
        // The request's wait for the refresh polls every 100 ms against a 15 s Date.now deadline: both
        // run on fake time (the render polls advance it as they check).
        vi.useFakeTimers();
        const { hydrate, held } = boot("k4");
        const answer = deferred<Response>();
        answerWith(() => answer.promise);
        const ui = render();
        await ui.expectText("A");

        ui.click(ui.toggle());
        await vi.waitFor(() => expect(fetchCalls).toHaveLength(1));
        expect(fetchCalls[0].path).toBe("/api/translate/message");
        expect(fetchCalls[0].body).toMatchObject({ characterId: "c", chatId: "k4", messageId: "a", force: false });
        await vi.waitFor(() => expect(ui.toggle().classList.contains("translating")).toBe(true));
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(true);
        expect(ui.spinner()).toBe(true);
        expect(ui.button(language.retranslate)!.disabled).toBe(true);
        expect(ui.button(language.editTranslation)!.disabled).toBe(true);
        // A second click while pending joins nothing new.
        ui.click(ui.toggle());
        ui.click(ui.toggle());
        expect(fetchCalls).toHaveLength(1);

        // The answer alone shows nothing: the row waits for the held message.
        const T = tr("ㄱ", "A");
        answer.resolve(json(200, { outcome: "applied", translation: T }));
        await vi.advanceTimersByTimeAsync(150);
        expect(ui.spinner()).toBe(true);
        expect(ui.toggle().classList.contains("translating")).toBe(true);

        // The refresh lands: the row shows it, and the next poll ends the request.
        expect(hydrate("a", T)).toBe(true);
        await vi.advanceTimersByTimeAsync(100);
        flushSync();
        expect(ui.toggle().classList.contains("translating")).toBe(false);
        await ui.expectText("ㄱ");
        expect(ui.spinner()).toBe(false);
        expect(ui.button(language.retranslate)!.disabled).toBe(false);
        expect(ui.button(language.editTranslation)!.disabled).toBe(false);
        expect(held()!.translation).toEqual(T);
        expect(hoisted.alerts.error).not.toHaveBeenCalled();
        expect(hoisted.translateHTML).not.toHaveBeenCalled();
    });

    it("a failed request alerts, leaves nothing shown and the toggle off, and the next click retries; hiding while pending shows the original and keeps the request", async () => {
        boot("k5");
        let fail = true;
        const second = deferred<Response>();
        answerWith(async () => {
            if (fail) {
                return json(502, { error: "The provider refused" });
            }
            return second.promise;
        });
        const ui = render();
        await ui.expectText("A");

        ui.click(ui.toggle());
        await vi.waitFor(() => expect(hoisted.alerts.error).toHaveBeenCalledTimes(1));
        expect(hoisted.alerts.error).toHaveBeenCalledWith(`${language.translationFailed}: The provider refused`);
        await vi.waitFor(() => expect(ui.toggle().classList.contains("translating")).toBe(false));
        expect(ui.text()).toBe("A");
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(false);
        expect(ui.spinner()).toBe(false);

        fail = false;
        ui.click(ui.toggle());
        await vi.waitFor(() => expect(fetchCalls).toHaveLength(2));
        await vi.waitFor(() => expect(ui.spinner()).toBe(true));
        // Hide while pending: the original shows, no spinner, the request goes on.
        ui.click(ui.toggle());
        await vi.waitFor(() => expect(ui.spinner()).toBe(false));
        expect(ui.text()).toBe("A");
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(false);
        expect(ui.toggle().classList.contains("translating")).toBe(true);
        // Show again: nothing new is requested while pending.
        ui.click(ui.toggle());
        expect(fetchCalls).toHaveLength(2);
        await vi.waitFor(() => expect(ui.spinner()).toBe(true));
        second.resolve(json(200, { outcome: "ignored", translation: null }));
        await vi.waitFor(() => expect(hoisted.alerts.error).toHaveBeenCalledTimes(2));
        expect(hoisted.alerts.error).toHaveBeenLastCalledWith(language.translationSourceChanged);
        await vi.waitFor(() => expect(ui.toggle().classList.contains("translating")).toBe(false));
        expect(ui.text()).toBe("A");
    });

    it("Retranslate confirms with the message captured before the dialog, requests with force after a yes, and does nothing after a no or for a message gone meanwhile", async () => {
        const { ref } = boot("k6", { autoTranslate: true, translation: tr("ㄱ", "A") });
        answerWith(async () => json(200, { outcome: "fresh", translation: tr("ㄱ", "A") }));
        const ui = render();
        await ui.expectText("ㄱ");

        const no = deferred<boolean>();
        hoisted.alerts.confirm.mockImplementationOnce(() => no.promise);
        ui.click(ui.button(language.retranslate));
        expect(hoisted.alerts.confirm).toHaveBeenCalledWith(language.retranslateConfirm);
        no.resolve(false);
        await tick();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(fetchCalls).toEqual([]);

        const yes = deferred<boolean>();
        hoisted.alerts.confirm.mockImplementationOnce(() => yes.promise);
        ui.click(ui.button(language.retranslate));
        yes.resolve(true);
        await vi.waitFor(() => expect(fetchCalls).toHaveLength(1));
        expect(fetchCalls[0].body).toMatchObject({ messageId: "a", chatId: "k6", force: true });
        await vi.waitFor(() => expect(ui.button(language.retranslate)!.disabled).toBe(false));

        // The message leaves during the dialog: nothing is requested.
        const late = deferred<boolean>();
        hoisted.alerts.confirm.mockImplementationOnce(() => late.promise);
        ui.click(ui.button(language.retranslate));
        removeMessages(ref, ["a"]);
        flushSync();
        late.resolve(true);
        await tick();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(fetchCalls).toHaveLength(1);
        expect(hoisted.alerts.error).not.toHaveBeenCalled();
    });
});

describe("the stored path: the full editor", () => {
    it("keeps a stored translation draft selectable and disables Save and Retranslate until the reply unlocks", async () => {
        const { ref, held } = boot("locked-translation", { autoTranslate: true, translation: tr("Stored", "A") });
        settings.ui.disableAutoPopupMessageEditor = true;
        const ui = render();
        await ui.instance.whenRendered();
        const retranslate = ui.button(language.retranslate)!;
        expect(retranslate.disabled).toBe(false);
        hoisted.alerts.confirm.mockResolvedValue(false);
        setReplyLock(ref, "a");
        try {
            expect.soft(retranslate.disabled).toBe(true);
            ui.click(retranslate);
            expect.soft(hoisted.alerts.confirm).not.toHaveBeenCalled();
            expect(fetchCalls).toEqual([]);
        } finally {
            setReplyLock(ref);
        }
        expect(retranslate.disabled).toBe(false);

        ui.click(ui.button(language.editTranslation));
        const draft = ui.textarea()!;
        draft.value = "My translation";
        draft.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();

        const save = ui.button(language.editTranslationSave)!;
        expect(save.disabled).toBe(false);
        expect(draft.readOnly).toBe(false);
        setReplyLock(ref, "a");
        try {
            expect.soft(save.disabled).toBe(true);
            ui.click(save);
            expect(held()!.translation?.text).toBe("Stored");
            expect.soft(draft.readOnly).toBe(true);
            draft.select();
            expect(draft.value.slice(draft.selectionStart, draft.selectionEnd)).toBe("My translation");
        } finally {
            setReplyLock(ref);
        }
        expect(draft.readOnly).toBe(false);
        expect(save.disabled).toBe(false);
        ui.click(save);
        await tick();
        expect(held()!.translation).toMatchObject({ text: "My translation", edited: true });
    });

    it("opens on the fresh translation, keeps the draft when the text changed since, cancels without writing, and writes `edited: true` on save", async () => {
        const { ref, held } = boot("k7", { autoTranslate: true, translation: tr("ㄱ", "A", { presetId: "tp" }) });
        const ui = render();
        await ui.expectText("ㄱ");

        ui.click(ui.button(language.editTranslation));
        expect(ui.textarea()).not.toBeNull();
        expect(ui.textarea()!.value).toBe("ㄱ");
        expect(ui.button(language.editTranslationSave)).not.toBeNull();
        expect(ui.button(language.cancel)).not.toBeNull();
        // The toggle is off while the editor is open.
        expect(ui.toggle().disabled).toBe(true);

        ui.textarea()!.value = "ㄴ";
        ui.textarea()!.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
        setMessageText(ref, "a", "A edited");
        flushSync();
        ui.click(ui.button(language.editTranslationSave));
        await tick();
        expect(hoisted.alerts.error).toHaveBeenCalledWith(language.translationEditStale);
        expect(ui.textarea()).not.toBeNull();
        expect(ui.textarea()!.value).toBe("ㄴ");
        expect((held()!.translation as MessageTranslation).text).toBe("ㄱ");

        ui.click(ui.button(language.cancel));
        expect(ui.textarea()).toBeNull();
        expect((held()!.translation as MessageTranslation).text).toBe("ㄱ");

        setMessageText(ref, "a", "A");
        flushSync();
        await ui.expectText("ㄱ");
        ui.click(ui.button(language.editTranslation));
        ui.textarea()!.value = "ㄷ";
        ui.textarea()!.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
        ui.click(ui.button(language.editTranslationSave));
        await tick();
        flushSync();
        expect(ui.textarea()).toBeNull();
        expect(held()!.translation).toMatchObject({
            text: "ㄷ",
            sourceHash: translationSourceHash("A"),
            presetId: "tp",
            targetLanguage: "ko",
            edited: true,
        });
        await ui.expectText("ㄷ");
        expect(hoisted.alerts.error).toHaveBeenCalledTimes(1);
    });

    it("retains a stored translation draft across remounts and warns before overwriting an outside change", async () => {
        const { held, hydrate } = boot("translation-draft", { autoTranslate: true, translation: tr("Stored", "A") });
        settings.ui.disableAutoPopupMessageEditor = true;
        let ui = render();
        await ui.expectText("Stored");
        ui.click(ui.button(language.editTranslation));
        ui.textarea()!.value = "My translation";
        ui.textarea()!.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
        ui = ui.remount();
        expect(ui.textarea()?.value).toBe("My translation");
        hydrate("a", tr("Changed elsewhere", "A"));
        flushSync();
        expect(ui.textarea()!.value).toBe("My translation");
        expect(ui.target.textContent).toContain(language.translationEditorChangedElsewhere);
        ui = ui.remount();
        expect(ui.textarea()?.value).toBe("My translation");
        expect(ui.target.textContent).toContain(language.translationEditorChangedElsewhere);
        ui.click(ui.button(language.editTranslationSave));
        await tick();
        flushSync();
        expect(held()!.translation).toMatchObject({ text: "My translation", edited: true });
        expect(ui.textarea()).toBeNull();
        expect(ui.target.textContent).not.toContain(language.translationEditorChangedElsewhere);
        await ui.expectText("My translation");
        ui.click(ui.button(language.editTranslation));
        ui.textarea()!.value = "Discard this";
        ui.textarea()!.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
        ui.click(ui.button(language.cancel));
        ui = ui.remount();
        await ui.expectText("My translation");
        expect(ui.textarea()).toBeNull();
        ui.click(ui.button(language.editTranslation));
        expect(ui.textarea()!.value).toBe("My translation");
    });

    it("an open editor keeps its Save and Cancel when the settings switch to the rendered path meanwhile, and saves to the target it opened on", async () => {
        const { held } = boot("k8", { autoTranslate: true, translation: tr("ㄱ", "A") });
        const ui = render();
        await ui.expectText("ㄱ");
        ui.click(ui.button(language.editTranslation));
        ui.textarea()!.value = "ㄹ";
        ui.textarea()!.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();

        settings.memoryTranslateMedia.llmTranslationTarget = "rendered";
        flushSync();
        expect(ui.textarea()).not.toBeNull();
        expect(ui.button(language.editTranslationSave)).not.toBeNull();
        expect(ui.button(language.cancel)).not.toBeNull();
        expect(ui.button(language.editTranslationSave)!.disabled).toBe(false);

        ui.click(ui.button(language.editTranslationSave));
        await tick();
        flushSync();
        expect(ui.textarea()).toBeNull();
        expect(held()!.translation).toMatchObject({ text: "ㄹ", edited: true });
        expect(hoisted.alerts.error).not.toHaveBeenCalled();
    });
});

describe("the rendered path is unchanged", () => {
    it("on `rendered` the row translates the rendered output through translateHTML and never shows or requests the stored translation", async () => {
        boot("k9", { autoTranslate: true, target: "rendered", translation: tr("ㄱ", "A") });
        const ui = render();
        await vi.waitFor(() => expect(hoisted.translateHTML).toHaveBeenCalled());
        await ui.expectText("[T]A");
        expect(ui.text()).not.toContain("ㄱ");
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(true);
        expect(fetchCalls).toEqual([]);
        expect(hoisted.edittrans).not.toHaveBeenCalled();

        ui.click(ui.toggle());
        await ui.expectText("A");
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(false);
        expect(fetchCalls).toEqual([]);
    });

    it("on `rendered`, toggling the chat's flag on a mounted row starts the auto translation and stops it again", async () => {
        // Fake timers: each "nothing more" window runs the row's 10 ms start and every timer after it.
        vi.useFakeTimers();
        const { ref } = boot("k9b", { target: "rendered" });
        const ui = render();
        await ui.expectText("A");
        await vi.advanceTimersByTimeAsync(1000);
        expect(hoisted.translateHTML).not.toHaveBeenCalled();
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(false);

        setChatMeta(ref, { autoTranslate: true });
        flushSync();
        await vi.waitFor(() => expect(hoisted.translateHTML).toHaveBeenCalled());
        await ui.expectText("[T]A");
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(true);
        const calls = hoisted.translateHTML.mock.calls.length;

        setChatMeta(ref, {}, ["autoTranslate"]);
        flushSync();
        await ui.expectText("A");
        expect(ui.toggle().classList.contains("text-blue-400")).toBe(false);
        await vi.advanceTimersByTimeAsync(1000);
        expect(hoisted.translateHTML.mock.calls.length).toBe(calls);
        expect(fetchCalls).toEqual([]);
    });

    it("a row without a message id (the greeting) keeps the rendered path under `message`", async () => {
        boot("k10", { autoTranslate: true, translation: tr("ㄱ", "A") });
        const ui = render({ message: "Hello", messageId: undefined, idx: -1 });
        await vi.waitFor(() => expect(hoisted.translateHTML).toHaveBeenCalled());
        await ui.expectText("[T]Hello");
        ui.click(ui.toggle());
        await ui.expectText("Hello");
        expect(fetchCalls).toEqual([]);
    });
});

describe("cached translation drafts", () => {
    async function renderTranslatedRow() {
        const row = render();
        await vi.advanceTimersByTimeAsync(20);
        await row.instance.whenRendered();
        expect(row.text()).toBe("[T]A");
        return row;
    }

    async function openTranslation(row: ReturnType<typeof render>) {
        row.click(row.button(language.editTranslation));
        await vi.advanceTimersByTimeAsync(0);
        expect(row.textarea()).not.toBeNull();
        return row.textarea()!;
    }

    const type = (field: HTMLTextAreaElement, value: string) => {
        field.value = value;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
    };

    beforeEach(() => {
        vi.useFakeTimers();
        vi.mocked(readLLMCacheEntry).mockReset().mockResolvedValue("Cached reply");
    });
    afterEach(() => {
        vi.mocked(readLLMCacheEntry).mockReset().mockResolvedValue(null);
        vi.mocked(writeLLMCacheEntry).mockReset().mockResolvedValue(undefined);
        vi.restoreAllMocks();
    });

    it.each(["inline", "expanded"])("recovers the %s draft after the row remounts", async (mode) => {
        boot(`cache-remount-${mode}`, { autoTranslate: true, target: "rendered" });
        settings.ui.disableAutoPopupMessageEditor = true;
        const row = await renderTranslatedRow();
        let field = await openTranslation(row);
        expect(field.value).toBe("Cached reply");
        if (mode === "expanded") {
            vi.spyOn(popupEditorMode, "readPopupEditorMonaco").mockReturnValue(false);
            row.click(row.target.querySelector(`button[aria-label="${language.hotkeyDesc.popupEditor}"]`));
            const popupTarget = document.createElement("div");
            document.body.append(popupTarget);
            mounted.push(mount(PopupEditor, { target: popupTarget }));
            flushSync();
            field = popupTarget.querySelector("textarea")!;
        }
        type(field, "My translation draft");

        const replacement = row.remount();
        await vi.advanceTimersByTimeAsync(20);
        await replacement.instance.whenRendered();
        expect((await openTranslation(replacement)).value).toBe("My translation draft");
    });

    it.each(["candidate", "generation"])(
        "keeps drafts separate for each %s with the same rendered text",
        async (kind) => {
            const { ref } = boot(`same-rendered-text-${kind}`, { autoTranslate: true, target: "rendered" });
            settings.ui.disableAutoPopupMessageEditor = true;
            if (kind === "candidate") {
                patchMessage(ref, "a", {
                    candidates: [
                        { id: "first", data: "A" },
                        { id: "second", data: "A" },
                    ],
                    selected: 0,
                });
            }
            const select = async (id: string) => {
                if (kind === "candidate") selectCandidate(ref, "a", id);
                else patchMessage(ref, "a", { generationInfo: { generationId: id } });
                flushSync();
                await vi.advanceTimersByTimeAsync(0);
            };
            await select("first");
            const row = await renderTranslatedRow();
            type(await openTranslation(row), "First reply draft");

            await select("second");
            expect(row.textarea()).toBeNull();
            const second = await openTranslation(row);
            expect(second.value).toBe("Cached reply");
            type(second, "Second reply draft");
            await select("first");
            expect((await openTranslation(row)).value).toBe("First reply draft");
        },
    );

    it("requires a fresh Save after a pending cache read discovers an outside edit", async () => {
        boot("cache-save-conflict", { autoTranslate: true, target: "rendered" });
        settings.ui.disableAutoPopupMessageEditor = true;
        const row = await renderTranslatedRow();
        type(await openTranslation(row), "My translation draft");
        let cached = "A newer translation from another tab";
        const read = deferred<string>();
        vi.mocked(readLLMCacheEntry).mockReturnValue(read.promise);
        vi.mocked(writeLLMCacheEntry).mockImplementation(async (_key, text) => {
            cached = text;
        });

        const save = row.button(language.editTranslationSave)!;
        row.click(save);
        const disabledWhileReading = save.disabled;
        row.click(save);
        read.resolve(cached);
        await vi.advanceTimersByTimeAsync(0);

        expect(cached).toBe("A newer translation from another tab");
        expect(disabledWhileReading).toBe(true);
        expect(row.target.querySelector('[role="status"]')?.textContent).toBe(
            language.translationEditorChangedElsewhere,
        );
        expect(row.textarea()?.value).toBe("My translation draft");
        row.click(row.button(language.editTranslationSave));
        await vi.advanceTimersByTimeAsync(0);
        expect(cached).toBe("My translation draft");
        expect(row.textarea()).toBeNull();
    });

    it("keeps Save disabled through a pending cache write", async () => {
        boot("cache-write-pending", { autoTranslate: true, target: "rendered" });
        settings.ui.disableAutoPopupMessageEditor = true;
        const row = await renderTranslatedRow();
        type(await openTranslation(row), "My translation draft");
        const write = deferred<void>();
        vi.mocked(writeLLMCacheEntry).mockReturnValue(write.promise);

        const save = row.button(language.editTranslationSave)!;
        row.click(save);
        await vi.advanceTimersByTimeAsync(0);
        expect(writeLLMCacheEntry).toHaveBeenCalledOnce();
        expect(save.disabled).toBe(true);
        row.click(save);
        await vi.advanceTimersByTimeAsync(0);
        expect(writeLLMCacheEntry).toHaveBeenCalledOnce();

        write.resolve(undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(row.textarea()).toBeNull();
    });

    it.each(["gains", "loses"])("reopens the same cache draft after the reply %s a candidate ID", async (change) => {
        const { ref } = boot(`cache-candidate-id-${change}`, { autoTranslate: true, target: "rendered" });
        settings.ui.disableAutoPopupMessageEditor = true;
        const generationInfo = { generationId: "reply-generation" };
        const withCandidate = () =>
            patchMessage(ref, "a", {
                generationInfo,
                candidates: [
                    { id: "first", data: "A", generationInfo },
                    { id: "second", data: "B" },
                ],
                selected: 0,
            });
        const standalone = () => patchMessage(ref, "a", { generationInfo }, ["candidates", "selected"]);
        const gainsId = change === "gains";
        if (gainsId) standalone();
        else withCandidate();
        const row = await renderTranslatedRow();
        type(await openTranslation(row), "My translation draft");
        const [key] = vi.mocked(readLLMCacheEntry).mock.lastCall!;
        const hold = () => openCachedTranslationDraft(ref, "a", key, messageEditorReplyKey(ref, "a"), "Cached reply");
        const original = hold();
        original.release();

        if (gainsId) withCandidate();
        else standalone();
        flushSync();
        expect((await openTranslation(row)).value).toBe("My translation draft");
        const reopened = hold();
        expect(reopened.draft).toBe(original.draft);
        reopened.release();
    });
});
