// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat as ChatRecord } from "../../../shared/database.ts";

// Real Chat and its editors, with parsing/transport dependencies isolated.
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
    authFetch: (path: string, init: RequestInit) => hoisted.auth.fetch!(path, init),
    getNodeServerProxyAuth: async () => "signed-token",
}));
vi.mock("src/ts/storage/resourceSync.svelte", async () =>
    (await import("src/ts/tests/bootMocks")).createBootMock("resourceSync", {
        flushResources: async () => ({ discarded: [], refused: [] }),
    }),
);

vi.mock("src/ts/storage/chatStore.svelte", async (importOriginal) => {
    const actual = await importOriginal<typeof import("src/ts/storage/chatStore.svelte")>();
    return { ...actual, setMessageText: vi.fn(actual.setMessageText) };
});
// Drive the longpress action without a wall-clock wait; Chat supplies the real cancel callback.
vi.mock("src/ts/gui/longtouch", () => ({
    longpress: (node: HTMLElement, callback: (event: Event) => void) => {
        node.addEventListener("test-longpress", callback);
        return { destroy: () => node.removeEventListener("test-longpress", callback) };
    },
}));

import { ParseMarkdown, risuChatParserForDisplay } from "src/ts/parser/parser.svelte";
import * as popupEditorMode from "src/ts/gui/popupEditorMode";
import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
import {
    acceptRemoteChat,
    applyServerGeneration,
    assembleChats,
    createChat,
    endServerJob,
    findChat,
    noteRemoteStreaming,
    patchMessage,
    removeMessages,
    seedChats,
    selectCandidate,
    selectChat,
    setMessageText,
} from "src/ts/storage/chatStore.svelte";
import {
    findMessageEditorDraft,
    messageEditorReplyKey,
    openCachedTranslationDraft,
    openPartialEditorDraft,
} from "src/ts/storage/messageEditorDrafts.svelte";
import { selectCharacter, selectModelPreset, selectPersona, selectPreset } from "src/ts/storage/selection.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { language } from "src/lang";
import { settings } from "src/ts/storage/settingsViews.svelte";
import {
    closePopupEditorSession,
    createSimpleCharacter,
    popUpEditorStore,
    ReloadChatPointer,
} from "src/ts/stores.svelte";
import PopupEditor from "../Others/PopupEditor.svelte";
import Chat from "./Chat.svelte";

const ref = { chaId: "c", chatId: "draft-chat" };
const editorDraftsPath = "src/ts/storage/messageEditorDrafts.svelte";
const firstReply = { id: "first-reply", data: "Original", generationInfo: { generationId: "first-generation" } };
const secondReply = { id: "second-reply", data: "Other", generationInfo: { generationId: "second-generation" } };
const mounted: ReturnType<typeof mount>[] = [];
function bootDraftChat(theme = "") {
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
        translator: "",
        zoomsize: 100,
        lineHeight: 1.25,
        iconsize: 100,
        theme,
        enableBlockPartialEdit: false,
        enableDragPartialEdit: false,
    });
    selectPreset("p1");
    selectModelPreset("m1");
    selectPersona("u1");
    const data = {
        id: ref.chatId,
        name: "Draft",
        note: "",
        localLore: [],
        message: [{ role: "char", data: "Original", chatId: "a" }],
    } as ChatRecord;
    const revision = "00000000-0000-0000-0000-000000000000:1:1";
    const listed = [{ characterId: "c", id: ref.chatId, revision, trashedAt: null, data }];
    const orders = [{ characterId: "c", revision, ids: [ref.chatId] }];
    seedChats(listed, orders);
    assembleChats([{ chaId: "c" }] as never, listed, orders);
    selectCharacter("c");
    selectChat("c", ref.chatId);
}

function render(theme = "", overrides: { message?: string; idx?: number; isComment?: boolean } = {}) {
    bootDraftChat(theme);
    return mountRow(overrides);
}

function mountRow(overrides: { message?: string; idx?: number; isComment?: boolean } = {}) {
    const target = document.createElement("div");
    document.body.append(target);
    const instance = mount(Chat, {
        target,
        props: {
            message: findChat(ref)!.message[0].data,
            messageId: "a",
            idx: 0,
            isLastMemory: false,
            character: createSimpleCharacter(selectedCharacter()),
            name: "C",
            role: findChat(ref)!.message[0].role,
            img: "",
            ...overrides,
        },
    });
    mounted.push(instance);
    flushSync();
    const toggle = () => {
        target.querySelector<HTMLButtonElement>(".button-icon-edit")!.click();
        flushSync();
    };
    const textarea = () => target.querySelector<HTMLTextAreaElement>(".message-edit-area")!;
    const save = () => target.querySelector<HTMLButtonElement>(".button-icon-edit")!;
    const type = (value: string) => {
        textarea().value = value;
        textarea().dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
    };
    const text = () => target.querySelector(".chattext")?.textContent?.trim();
    const stored = () => findChat(ref)!.message[0].data;
    return {
        target,
        instance,
        toggle,
        save,
        textarea,
        type,
        text,
        stored,
        remount: async () => {
            await unmount(instance);
            mounted.splice(mounted.indexOf(instance), 1);
            target.remove();
            return mountRow(overrides);
        },
        destroy: async () => {
            await unmount(instance);
            mounted.splice(mounted.indexOf(instance), 1);
            target.remove();
        },
    };
}

function outsideEdit(text: string) {
    const data = safeStructuredClone(findChat(ref)) as ChatRecord;
    data.message[0].data = text;
    acceptRemoteChat({ characterId: ref.chaId, id: ref.chatId, revision: "remote:2", data });
    flushSync();
}

beforeEach(() => {
    ReloadChatPointer.set({});
    vi.mocked(setMessageText).mockClear();
    vi.mocked(risuChatParserForDisplay).mockClear();
});
afterEach(async () => {
    for (const instance of mounted.splice(0)) await unmount(instance);
    document.body.replaceChildren();
    vi.mocked(ParseMarkdown)
        .mockReset()
        .mockImplementation(async (text) => `<p>${text}</p>`);
    vi.useRealTimers();
});

describe("Chat render completion", () => {
    it("whenRendered resolves immediately for comment and empty greeting rows without a body", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        vi.mocked(ParseMarkdown)
            .mockClear()
            .mockImplementation(() => new Promise(() => {}));
        for (const overrides of [{ isComment: true }, { message: "", idx: -1 }]) {
            const ui = render("", overrides);
            const rendered = vi.fn();
            const waiting = ui.instance.whenRendered().then(rendered);
            await vi.advanceTimersByTimeAsync(0);
            flushSync();
            expect(ParseMarkdown).not.toHaveBeenCalled();
            expect(rendered).toHaveBeenCalledOnce();
            await waiting;
        }
    });

    it("whenRendered waits for a body replaced by ReloadChatPointer mid-parse", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const parses: ((html: string) => void)[] = [];
        vi.mocked(ParseMarkdown)
            .mockClear()
            .mockImplementation(() => new Promise<string>((resolve) => parses.push(resolve)));
        const ui = render();
        const rendered = vi.fn();
        const waiting = ui.instance.whenRendered().then(() => rendered(ui.text()));
        await vi.advanceTimersByTimeAsync(0);
        expect(ParseMarkdown).toHaveBeenCalledTimes(1);
        expect(rendered).not.toHaveBeenCalled();
        ReloadChatPointer.set({ "m:a": 1 });
        flushSync();
        expect(ParseMarkdown).toHaveBeenCalledTimes(2);
        parses[0]("<p>Obsolete body</p>");
        await vi.advanceTimersByTimeAsync(0);
        flushSync();
        expect(rendered).not.toHaveBeenCalled();
        expect(ui.text()).not.toBe("Obsolete body");
        parses[1]("<p>Replacement body</p>");
        await vi.advanceTimersByTimeAsync(0);
        flushSync();
        expect(rendered).toHaveBeenCalledExactlyOnceWith("Replacement body");
        await waiting;
    });
});

describe("original message draft", () => {
    it("updates a real row's name and image without resetting or reparsing its body", async () => {
        const ui = render();
        await ui.instance.whenRendered();
        expect(ui.text()).toBe("Original");
        const body = ui.target.querySelector(".chattext");
        vi.mocked(ParseMarkdown).mockClear();
        vi.mocked(risuChatParserForDisplay).mockClear();
        ui.instance.updateRow({ name: "Renamed", img: 'background-image:url("new.png");' });
        await tick();
        flushSync();
        expect(ui.target.textContent).toContain("Renamed");
        expect(ui.target.innerHTML).toContain("new.png");
        expect(ui.target.querySelector(".chattext")).toBe(body);
        expect(ui.text()).toBe("Original");
        expect(ParseMarkdown).not.toHaveBeenCalled();
        expect(risuChatParserForDisplay).not.toHaveBeenCalled();
    });

    it.each(["", "cardboard"])(
        "keeps typing out of display and storage, then saves the draft (theme %j)",
        async (theme) => {
            const ui = render(theme);
            await ui.instance.whenRendered();
            expect(ui.text()).toBe("Original");
            ui.toggle();
            expect(ui.instance.isEditing()).toBe(true);
            expect(ui.textarea().value).toBe("Original");
            vi.mocked(risuChatParserForDisplay).mockClear();
            ui.type("Saved draft");
            await tick();
            flushSync();
            expect(ui.stored()).toBe("Original");
            expect(setMessageText).not.toHaveBeenCalled();
            // Even the display pre-pass must keep the original: typing is only a draft input.
            expect(risuChatParserForDisplay).not.toHaveBeenCalled();
            ui.toggle();
            await tick();
            flushSync();
            expect(setMessageText).toHaveBeenCalledExactlyOnceWith(ref, "a", "Saved draft");
            expect(ui.stored()).toBe("Saved draft");
            expect(ui.instance.isEditing()).toBe(false);
            await ui.instance.whenRendered();
            expect(ui.text()).toBe("Saved draft");
            ui.toggle();
            expect(ui.textarea().value).toBe("Saved draft");
        },
    );

    it("keeps a cardboard message draft selectable and saves it only after the reply unlocks", async () => {
        const ui = render("cardboard");
        settings.ui.disableAutoPopupMessageEditor = true;
        ui.toggle();
        ui.type("My cardboard draft");
        const stream = { characterId: ref.chaId, id: ref.chatId };
        noteRemoteStreaming([{ ...stream, streaming: [{ messageId: "a", generationId: "cardboard", seq: 0 }] }]);
        flushSync();
        try {
            expect(ui.save().disabled).toBe(true);
            ui.toggle();
            expect(setMessageText).not.toHaveBeenCalled();
            expect(ui.textarea().readOnly).toBe(true);
            ui.textarea().select();
            const { value, selectionStart, selectionEnd } = ui.textarea();
            expect(value.slice(selectionStart, selectionEnd)).toBe("My cardboard draft");
        } finally {
            noteRemoteStreaming([{ ...stream, streaming: [] }]);
            flushSync();
        }
        expect(ui.textarea().readOnly).toBe(false);
        expect(ui.save().disabled).toBe(false);
        ui.toggle();
        expect(ui.stored()).toBe("My cardboard draft");
    });

    it("retains an open draft and its overwrite notice across an outside edit and row remount, then saves it", async () => {
        let ui = render();
        settings.ui.disableAutoPopupMessageEditor = true;
        ui.toggle();
        ui.type("My revision");
        outsideEdit("Revision from another tab");
        expect(ui.textarea().value).toBe("My revision");
        ui = await ui.remount();
        expect(ui.textarea()?.value).toBe("My revision");
        expect(ui.target.textContent).toContain(language.messageEditorChangedElsewhere);
        ui.toggle();
        await tick();
        flushSync();
        expect(ui.stored()).toBe("My revision");
        expect(ui.textarea()).toBeNull();
        expect(ui.target.textContent).not.toContain(language.messageEditorChangedElsewhere);
        const { findMessageEditorDraft } = await import(editorDraftsPath);
        expect(findMessageEditorDraft(ref, "a", "message")).toBeUndefined();
    });

    it("keeps each candidate's draft through selection changes and row remounts", async () => {
        bootDraftChat();
        settings.ui.disableAutoPopupMessageEditor = true;
        patchMessage(ref, "a", {
            candidates: [firstReply, { ...secondReply, generationInfo: firstReply.generationInfo }],
            selected: 0,
            generationInfo: firstReply.generationInfo,
        });
        let ui = mountRow();
        ui.toggle();
        ui.type("First candidate draft");

        selectCandidate(ref, "a", secondReply.id);
        ui.instance.updateRow({ message: secondReply.data });
        flushSync();
        expect.soft(ui.textarea()).toBeNull();
        ui = await ui.remount();
        expect(ui.textarea()).toBeNull();
        ui.toggle();
        expect(ui.textarea().value).toBe(secondReply.data);
        ui.type("Second candidate draft");

        selectCandidate(ref, "a", firstReply.id);
        ui.instance.updateRow({ message: firstReply.data });
        flushSync();
        expect(ui.textarea()?.value).toBe("First candidate draft");

        const saveFirst = ui.save();
        selectCandidate(ref, "a", secondReply.id);
        saveFirst.click();
        expect(ui.stored()).toBe(secondReply.data);
        ui = await ui.remount();
        expect(ui.textarea()?.value).toBe("Second candidate draft");
    });

    it.each([
        { reply: "a generated reply", generationInfo: firstReply.generationInfo },
        { reply: "a legacy reply", generationInfo: undefined },
    ])("reopens a draft typed before $reply gained its first candidate id", async ({ generationInfo }) => {
        bootDraftChat();
        settings.ui.disableAutoPopupMessageEditor = true;
        if (generationInfo) patchMessage(ref, "a", { generationInfo });
        let ui = mountRow();
        ui.toggle();
        ui.type("Standalone reply draft");

        patchMessage(ref, "a", {
            candidates: [{ id: firstReply.id, data: firstReply.data, generationInfo }, secondReply],
            selected: 1,
            data: secondReply.data,
            generationInfo: secondReply.generationInfo,
        });
        ui.instance.updateRow({ message: secondReply.data });
        flushSync();
        expect.soft(ui.textarea()).toBeNull();

        selectCandidate(ref, "a", firstReply.id);
        ui = await ui.remount();
        expect(ui.textarea()?.value).toBe("Standalone reply draft");
    });

    it("keeps drafts separate by generation when a reply has no candidate slots", () => {
        bootDraftChat();
        settings.ui.disableAutoPopupMessageEditor = true;
        patchMessage(ref, "a", { generationInfo: firstReply.generationInfo });
        const ui = mountRow();
        ui.toggle();
        ui.type("First generation draft");

        patchMessage(ref, "a", { generationInfo: secondReply.generationInfo });
        flushSync();
        expect(ui.textarea()).toBeNull();

        patchMessage(ref, "a", { generationInfo: firstReply.generationInfo });
        flushSync();
        expect(ui.textarea()?.value).toBe("First generation draft");
    });

    it("keeps a user message draft across a generation id change and row remount", async () => {
        bootDraftChat();
        settings.ui.disableAutoPopupMessageEditor = true;
        patchMessage(ref, "a", { role: "user" });
        let ui = mountRow();
        ui.toggle();
        ui.type("User message draft");

        patchMessage(ref, "a", { generationInfo: firstReply.generationInfo });
        ui = await ui.remount();

        expect(ui.textarea()?.value).toBe("User message draft");
    });

    it("drops retained drafts when their message is deleted or their chat is deleted for good without a mounted row", async () => {
        for (const removal of ["message", "chat"]) {
            let ui = render();
            settings.ui.disableAutoPopupMessageEditor = true;
            ui.toggle();
            ui.type("Kept until deletion");
            ui = await ui.remount();
            expect(ui.textarea()?.value).toBe("Kept until deletion");
            await ui.destroy();
            const { findMessageEditorDraft } = await import(editorDraftsPath);
            expect(findMessageEditorDraft(ref, "a", "message")?.text).toBe("Kept until deletion");
            if (removal === "message") removeMessages(ref, ["a"]);
            else {
                createChat(ref.chaId, { ...safeStructuredClone(findChat(ref))!, id: "spare", message: [] });
                // Another tab's permanent deletion, found by a whole read.
                acceptRemoteChat({ characterId: ref.chaId, id: ref.chatId, revision: null, data: null });
                expect(findChat(ref)).toBeUndefined();
            }
            flushSync();
            expect(findMessageEditorDraft(ref, "a", "message")).toBeUndefined();
        }
    });

    it("long-press cancel preserves the draft for reopening without storing or displaying it", async () => {
        let ui = render();
        await ui.instance.whenRendered();
        expect(ui.text()).toBe("Original");
        ui.toggle();
        ui.type("Unsent draft");
        ui.textarea().dispatchEvent(new Event("test-longpress"));
        flushSync();
        expect(ui.instance.isEditing()).toBe(false);
        expect(ui.textarea()).toBeNull();
        expect(setMessageText).not.toHaveBeenCalled();
        expect(ui.stored()).toBe("Original");
        await ui.instance.whenRendered();
        expect(ui.text()).toBe("Original");
        ui = await ui.remount();
        await ui.instance.whenRendered();
        expect(ui.textarea()).toBeNull();
        expect(ui.text()).toBe("Original");
        outsideEdit("Changed elsewhere after cancel");
        ui = await ui.remount();
        await ui.instance.whenRendered();
        expect(ui.textarea()).toBeNull();
        expect(ui.text()).toBe("Changed elsewhere after cancel");
        ui.toggle();
        expect(ui.textarea().value).toBe("Unsent draft");
        expect(ui.target.textContent).toContain(language.messageEditorChangedElsewhere);
        expect(setMessageText).not.toHaveBeenCalled();
        ui.toggle();
        await tick();
        flushSync();
        expect(setMessageText).toHaveBeenCalledExactlyOnceWith(ref, "a", "Unsent draft");
        expect(ui.stored()).toBe("Unsent draft");
    });
});

// Opening a stored message's editor also opens the shared popup editor on the draft; closing the
// popup saves. Typing inline meanwhile keeps the inline edit and drops the popup, and the setting
// turns the auto popup off. Timeout functions are faked before mounting; render completion is
// signalled by the component, and the popup loop advances only under the test's control.
describe("retaining cached and paragraph drafts", () => {
    const paragraph = (target: string | null = null) =>
        openPartialEditorDraft(ref, "a", target, "Original", { start: 0, end: "Original".length });

    it("evicts inactive drafts by last write and protects a paragraph until its final editor closes", () => {
        bootDraftChat();
        const first = paragraph(null);
        first.setText("Draft in the transcript");
        const second = paragraph(null);
        expect(second.draft).toBe(first.draft);
        const old = paragraph("an old translation");
        old.setText("Old paragraph draft");
        old.release();

        const cache = (index: number) => openCachedTranslationDraft(ref, "a", `key-${index}`, null, null);
        const retained = (index: number) => findMessageEditorDraft(ref, "a", `cache:key-${index}`)?.text;
        const write = (index: number, text = `Draft ${index}`) => {
            const session = cache(index);
            session.setText(text);
            session.release();
        };
        for (let index = 0; index < 8; index++) write(index);
        expect(old.draft.open).toBe(false);
        write(0, "Rewritten draft 0");
        cache(1).release();
        write(8);
        expect(retained(1)).toBeUndefined();
        expect(retained(0)).toBe("Rewritten draft 0");

        first.release();
        write(9);
        expect(retained(2)).toBeUndefined();
        expect(second.draft).toMatchObject({ open: true, text: "Draft in the transcript" });
        second.release();
        expect(second.draft.open).toBe(false);
        expect([0, 3, 4, 5, 6, 7, 8, 9].map(retained)).toEqual([
            "Rewritten draft 0",
            "Draft 3",
            "Draft 4",
            "Draft 5",
            "Draft 6",
            "Draft 7",
            "Draft 8",
            "Draft 9",
        ]);
    });

    it.each(["gains", "loses"])("recovers the same paragraph draft after the reply %s a candidate ID", (change) => {
        bootDraftChat();
        const generationInfo = { generationId: "first-generation" };
        const withCandidate = () =>
            patchMessage(ref, "a", {
                generationInfo,
                candidates: [
                    { id: "first", data: "Original", generationInfo },
                    { id: "second", data: "Another reply" },
                ],
                selected: 0,
            });
        const standalone = () => patchMessage(ref, "a", { generationInfo }, ["candidates", "selected"]);
        const gainsId = change === "gains";
        if (gainsId) standalone();
        else withCandidate();
        const original = paragraph();
        original.setText("My paragraph draft");

        if (gainsId) withCandidate();
        else standalone();
        const reopened = paragraph();
        expect(reopened.draft.text).toBe("My paragraph draft");
        expect(reopened.draft).toBe(original.draft);
        original.close();
        expect(reopened.draft.open).toBe(false);
        expect(paragraph().draft.text).toBe("Original");
    });

    it("keeps exact drafts separate when several candidate IDs share a generation", () => {
        bootDraftChat();
        const generationInfo = { generationId: "shared-generation" };
        const candidates = ["first", "second", "third"].map((id) => ({ id, data: "Original", generationInfo }));
        const select = (selected: number) => patchMessage(ref, "a", { generationInfo, candidates, selected });
        const cache = () =>
            openCachedTranslationDraft(ref, "a", "same-key", messageEditorReplyKey(ref, "a"), "Cached reply");

        select(0);
        const first = cache();
        first.setText("First candidate's translation draft");
        first.release();
        select(1);
        const second = paragraph();
        second.setText("Second candidate's paragraph draft");
        second.release();

        patchMessage(ref, "a", { generationInfo }, ["candidates", "selected"]);
        const standaloneCache = cache();
        const standaloneParagraph = paragraph();
        expect([standaloneCache.draft.text, standaloneParagraph.draft.text]).toEqual(["Cached reply", "Original"]);
        standaloneCache.setText("Standalone translation draft");
        standaloneParagraph.setText("Standalone paragraph draft");
        standaloneCache.release();
        standaloneParagraph.release();

        select(2);
        expect([cache().draft.text, paragraph().draft.text]).toEqual(["Cached reply", "Original"]);
        select(0);
        expect(cache().draft.text).toBe("First candidate's translation draft");
        select(1);
        expect(paragraph().draft.text).toBe("Second candidate's paragraph draft");
        patchMessage(ref, "a", { generationInfo }, ["candidates", "selected"]);
        expect([cache().draft.text, paragraph().draft.text]).toEqual([
            "Standalone translation draft",
            "Standalone paragraph draft",
        ]);
    });
});

describe("Chat message editor auto popup", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    const initialPopup = { ...popUpEditorStore };
    async function closePopupWith(text: string) {
        popUpEditorStore.value = text;
        closePopupEditorSession(popUpEditorStore.sessionId);
        await vi.advanceTimersByTimeAsync(100);
        flushSync();
        await vi.advanceTimersByTimeAsync(0);
        flushSync();
    }
    afterEach(() => {
        Object.assign(popUpEditorStore, initialPopup);
        settings.ui.disableAutoPopupMessageEditor = false;
    });

    it("opens the popup on the draft when editing starts and saves the popup's text on close", async () => {
        const ui = render();
        await ui.instance.whenRendered();
        expect(ui.text()).toBe("Original");
        ui.toggle();
        expect(ui.instance.isEditing()).toBe(true);
        expect(popUpEditorStore).toMatchObject({ open: true, value: "Original", language: "markdown" });
        expect(ui.textarea().value).toBe("Original");

        await closePopupWith("Edited in the popup");
        expect(setMessageText).toHaveBeenCalledExactlyOnceWith(ref, "a", "Edited in the popup");
        expect(ui.stored()).toBe("Edited in the popup");
        expect(ui.textarea()).toBeNull();
        expect(ui.instance.isEditing()).toBe(false);
    });

    it("keeps the inline edit and drops the popup when the draft is typed into while the popup is open", async () => {
        const ui = render();
        await ui.instance.whenRendered();
        expect(ui.text()).toBe("Original");
        ui.toggle();
        expect(popUpEditorStore.open).toBe(true);
        popUpEditorStore.value = "Typed in the popup";
        ui.type("Typed inline");
        await vi.advanceTimersByTimeAsync(100);
        flushSync();
        expect(popUpEditorStore.open).toBe(false);
        expect(setMessageText).not.toHaveBeenCalled();
        expect(ui.textarea().value).toBe("Typed inline");
        expect(ui.stored()).toBe("Original");

        // The inline editor still saves as before, and leaving edit mode does not reopen the popup.
        ui.toggle();
        await vi.advanceTimersByTimeAsync(0);
        flushSync();
        expect(setMessageText).toHaveBeenCalledExactlyOnceWith(ref, "a", "Typed inline");
        expect(popUpEditorStore.open).toBe(false);
    });

    it("keeps a draft inline when the automatic popup closes during a reply and saves it after release", async () => {
        const ui = render();
        ui.toggle();
        popUpEditorStore.value = "Typed before the lock";
        const stream = { characterId: ref.chaId, id: ref.chatId };
        noteRemoteStreaming([{ ...stream, streaming: [{ messageId: "a", generationId: "auto-popup", seq: 0 }] }]);
        flushSync();
        try {
            await closePopupWith("Typed before the lock");
            expect(setMessageText).not.toHaveBeenCalled();
            expect(ui.textarea().value).toBe("Typed before the lock");
            expect(ui.textarea().readOnly).toBe(true);
            expect(ui.save().disabled).toBe(true);
        } finally {
            noteRemoteStreaming([{ ...stream, streaming: [] }]);
            flushSync();
        }
        expect(ui.textarea().readOnly).toBe(false);
        ui.toggle();
        expect(ui.stored()).toBe("Typed before the lock");
    });

    it("makes an expanded popup selectable during streaming and retains its draft across the row remount", async () => {
        const plainEditor = vi.spyOn(popupEditorMode, "readPopupEditorMonaco").mockReturnValue(false);
        let ui = render();
        settings.ui.disableAutoPopupMessageEditor = true;
        ui.toggle();
        ui.target.querySelector<HTMLButtonElement>(`button[aria-label="${language.hotkeyDesc.popupEditor}"]`)!.click();
        flushSync();
        const popup = document.createElement("div");
        document.body.append(popup);
        mounted.push(mount(PopupEditor, { target: popup }));
        flushSync();
        const field = popup.querySelector<HTMLTextAreaElement>("textarea")!;
        expect(field.readOnly).toBe(false);
        field.value = "Typed in the expanded popup";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();

        const jobId = "popup-stream";
        try {
            expect(
                applyServerGeneration(ref, { jobId, messageId: "a", generationId: jobId, text: "Original", seq: 1 }),
            ).toBe(true);
            flushSync();
            expect.soft(field.readOnly).toBe(true);
            field.select();
            expect(field.value.slice(field.selectionStart, field.selectionEnd)).toBe("Typed in the expanded popup");

            ui = await ui.remount();
            expect(popUpEditorStore.open).toBe(false);
            expect(setMessageText).not.toHaveBeenCalled();
            expect.soft(ui.textarea().value).toBe("Typed in the expanded popup");
            expect.soft(ui.textarea().readOnly).toBe(true);
            expect(ui.save().disabled).toBe(true);
        } finally {
            endServerJob(jobId);
            flushSync();
            plainEditor.mockRestore();
        }
        expect(ui.textarea().readOnly).toBe(false);
        ui.toggle();
        expect(ui.stored()).toBe("Typed in the expanded popup");
    });

    it("keeps expanded popup text on the candidate it was typed on when both replies have the same text", () => {
        bootDraftChat();
        settings.ui.disableAutoPopupMessageEditor = true;
        patchMessage(ref, "a", {
            candidates: [firstReply, { ...secondReply, data: firstReply.data }],
            selected: 0,
            generationInfo: firstReply.generationInfo,
        });
        const ui = mountRow();
        ui.toggle();
        ui.target.querySelector<HTMLButtonElement>(`button[aria-label="${language.hotkeyDesc.popupEditor}"]`)!.click();
        flushSync();
        expect(popUpEditorStore.open).toBe(true);
        popUpEditorStore.value = "Expanded first candidate draft";
        flushSync();

        selectCandidate(ref, "a", secondReply.id);
        flushSync();
        expect(popUpEditorStore.open).toBe(false);
        expect(ui.textarea()).toBeNull();
        expect(ui.stored()).toBe(firstReply.data);

        selectCandidate(ref, "a", firstReply.id);
        flushSync();
        expect(ui.textarea()?.value).toBe("Expanded first candidate draft");
    });

    it("opens no popup while the setting turns the auto popup off, and the inline editor still works", async () => {
        const ui = render();
        await ui.instance.whenRendered();
        expect(ui.text()).toBe("Original");
        settings.ui.disableAutoPopupMessageEditor = true;
        ui.toggle();
        expect(popUpEditorStore.open).toBe(false);
        expect(ui.textarea().value).toBe("Original");
        // The expand button stays, so the popup is one click away.
        expect(ui.target.querySelector(`button[aria-label="${language.hotkeyDesc.popupEditor}"]`)).not.toBeNull();
    });

    it("closes its popup when the row unmounts before the popup is closed", async () => {
        const ui = render();
        await ui.instance.whenRendered();
        expect(ui.text()).toBe("Original");
        ui.toggle();
        expect(popUpEditorStore.open).toBe(true);
        await unmount(mounted.pop()!);
        expect(popUpEditorStore.open).toBe(false);
        expect(setMessageText).not.toHaveBeenCalled();
    });

    it("edits a multi-line message in a fixed-height inline area and a short one in a growing area", async () => {
        const long = render("", { message: "First line\nSecond line" });
        await long.instance.whenRendered();
        expect(long.text()).toBe("First line\nSecond line");
        long.toggle();
        expect(long.textarea().style.height).toBe("16rem");
        closePopupEditorSession(popUpEditorStore.sessionId);
        await vi.advanceTimersByTimeAsync(100);
        flushSync();
        await unmount(mounted.pop()!);

        const short = render();
        short.toggle();
        expect(short.textarea().style.height).not.toBe("16rem");
    });
});
