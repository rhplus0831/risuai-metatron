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

vi.mock("src/ts/alert", () => ({
    alertError: hoisted.alerts.error,
    alertConfirm: hoisted.alerts.confirm,
    alertNormal: hoisted.alerts.normal,
    alertInput: vi.fn(),
    alertClear: vi.fn(),
    alertRequestData: vi.fn(),
    alertWait: vi.fn(),
    alertNormalWait: vi.fn(async () => undefined),
}));
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
    addMetadataToElement: vi.fn((html: string) => html),
    postTranslationParse: vi.fn(async (html: string) => html),
    getDistance: vi.fn(() => 0),
    parseMarkdownSafe: vi.fn((text: string) => text),
}));
vi.mock("src/ts/parser/transformClient", () => ({
    captureTransform: vi.fn(() => null),
    rerenderMessage: vi.fn(),
    resetTransformEffects: vi.fn(),
}));
vi.mock("src/ts/globalApi.svelte", () => ({
    aiLawApplies: vi.fn(() => false),
    changeChatTo: vi.fn(),
    foldChatToMessage: vi.fn(),
    getFileSrc: vi.fn(async (path: string) => path),
    createChatCopyName: vi.fn(() => "copy"),
    downloadFile: vi.fn(),
    saveAsset: vi.fn(),
}));
vi.mock("src/ts/model/modellist", () => ({ getModelInfo: vi.fn(() => ({ shortName: "model" })) }));
vi.mock("src/ts/process/serverCommands", () => ({ runServerButton: vi.fn(), runServerManualTrigger: vi.fn() }));
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
vi.mock("src/ts/storage/resourceSync.svelte", () => {
    class GenerationBlockedError extends Error {}
    return { flushResources: async () => ({ discarded: [] }), GenerationBlockedError };
});

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
import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
import { assembleChats, findChat, seedChats, selectChat, setMessageText } from "src/ts/storage/chatStore.svelte";
import { selectCharacter, selectModelPreset, selectPersona, selectPreset } from "src/ts/storage/selection.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { createSimpleCharacter, ReloadChatPointer } from "src/ts/stores.svelte";
import Chat from "./Chat.svelte";

const ref = { chaId: "c", chatId: "draft-chat" };
const mounted: ReturnType<typeof mount>[] = [];
function render(theme = "", overrides: { message?: string; idx?: number; isComment?: boolean } = {}) {
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
    const listed = [{ characterId: "c", id: ref.chatId, revision, data }];
    const orders = [{ characterId: "c", revision, ids: [ref.chatId] }];
    seedChats(listed, orders);
    assembleChats([{ chaId: "c" }] as never, listed, orders);
    selectCharacter("c");
    selectChat("c", ref.chatId);
    const target = document.createElement("div");
    document.body.append(target);
    const instance = mount(Chat, {
        target,
        props: {
            message: "Original",
            messageId: "a",
            idx: 0,
            isLastMemory: false,
            character: createSimpleCharacter(selectedCharacter()),
            name: "C",
            role: "char",
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
    const type = (value: string) => {
        textarea().value = value;
        textarea().dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
    };
    const text = () => target.querySelector(".chattext")?.textContent?.trim();
    const stored = () => findChat(ref)!.message[0].data;
    return { target, instance, toggle, textarea, type, text, stored };
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
        await vi.waitFor(() => expect(ui.text()).toBe("Original"));
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
            await vi.waitFor(() => expect(ui.text()).toBe("Original"));
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
            await vi.waitFor(() => expect(ui.text()).toBe("Saved draft"));
            ui.toggle();
            expect(ui.textarea().value).toBe("Saved draft");
        },
    );

    it("long-press cancel preserves the draft for reopening without storing or displaying it", async () => {
        const ui = render();
        await vi.waitFor(() => expect(ui.text()).toBe("Original"));
        ui.toggle();
        ui.type("Unsent draft");
        ui.textarea().dispatchEvent(new Event("test-longpress"));
        flushSync();
        expect(ui.instance.isEditing()).toBe(false);
        expect(ui.textarea()).toBeNull();
        expect(setMessageText).not.toHaveBeenCalled();
        expect(ui.stored()).toBe("Original");
        await vi.waitFor(() => expect(ui.text()).toBe("Original"));
        ui.toggle();
        expect(ui.textarea().value).toBe("Unsent draft");
        expect(setMessageText).not.toHaveBeenCalled();
        ui.toggle();
        await tick();
        flushSync();
        expect(setMessageText).toHaveBeenCalledExactlyOnceWith(ref, "a", "Unsent draft");
        expect(ui.stored()).toBe("Unsent draft");
    });
});
