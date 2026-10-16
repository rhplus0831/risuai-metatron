// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat as ChatRecord, MessageTranslation } from "../../../shared/database.ts";
import { translationSourceHash } from "../../../shared/translation/hash.ts";

// A chat row on the stored-translation path (`docs/plan/translation.md` slice 1.4, `media-aux.md`):
// the LLM translator on `llmTranslationTarget: "message"` shows the held message's fresh stored
// translation through the normal display path, re-deriving it when the chat's refresh brings one (no
// remount), keeps the row's show/hide choice across a remount, requests a translation only when none
// is fresh, and edits through a captured session. The rendered path (`"rendered"`, or a row without a
// message id) is unchanged: `translateHTML` runs and the stored translation is never shown. Auto-show
// is the chat's own `autoTranslate` (`docs/plan/translation.md` slice 2.1), counted only while a target
// language is set; on the rendered path a change of it on a mounted row starts or stops the translation.

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

import { language } from "src/lang";
import { selectedCharacter } from "src/ts/storage/characterStore.svelte";
import {
    assembleChats,
    findChat,
    hydrateChat,
    removeMessages,
    seedChats,
    selectChat,
    setChatMeta,
    setMessageText,
    setMessageTranslation,
} from "src/ts/storage/chatStore.svelte";
import { setResourceEpoch } from "src/ts/storage/resourceClient";
import { selectCharacter, selectModelPreset, selectPersona, selectPreset } from "src/ts/storage/selection.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { createSimpleCharacter } from "src/ts/stores.svelte";
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
 * `autoTranslate` is the chat's own field (slice 2.1); `translator` the target language (`ko`).
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
    const listed = [{ characterId: "c", id: chatId, revision: rev(revision), data }];
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

function render(props: { message?: string; messageId?: string | undefined; idx?: number } = {}) {
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

beforeEach(() => {
    fetchCalls.length = 0;
    hoisted.alerts.error.mockReset();
    hoisted.alerts.confirm.mockReset();
    hoisted.alerts.confirm.mockResolvedValue(true);
    hoisted.translateHTML.mockClear();
    hoisted.edittrans.mockClear();
    hoisted.auth.fetch = async () => {
        throw new Error("no transport scripted");
    };
});

afterEach(() => {
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
        boot("k3c", { autoTranslate: true, translator: "", translation: tr("ㄱ", "A") });
        const ui = render();
        await ui.expectText("A");
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(ui.text()).toBe("A");
        expect(fetchCalls).toEqual([]);
        expect(hoisted.translateHTML).not.toHaveBeenCalled();
    });
});

describe("the stored path: requests", () => {
    it("the toggle requests a translation when none is fresh: pending until the refresh lands, spinner, disabled controls, and the stored translation shown after", async () => {
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
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(ui.spinner()).toBe(true);
        expect(ui.toggle().classList.contains("translating")).toBe(true);

        expect(hydrate("a", T)).toBe(true);
        await ui.expectText("ㄱ");
        await vi.waitFor(() => expect(ui.toggle().classList.contains("translating")).toBe(false));
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
        const { ref } = boot("k9b", { target: "rendered" });
        const ui = render();
        await ui.expectText("A");
        await new Promise((resolve) => setTimeout(resolve, 50));
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
        await new Promise((resolve) => setTimeout(resolve, 50));
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
