// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Chat } from "../../../shared/database";
import type { OocExchange } from "../../../shared/ooc";
import type { OocSegmentView, OocSessionState } from "src/ts/ooc/oocSession.svelte";
import { openOocPanel, closeOocPanel } from "src/ts/ooc/oocPanel.svelte";
import { beginLocalSend } from "src/ts/process/localSends";
import { readPresetFieldOf, writePresetField } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { reactiveProps } from "../UI/tests/reactiveProps.svelte";
import OocPanel from "./OocPanel.svelte";

type Fixture = {
    chat: Partial<Chat>;
    segments: OocSegmentView[];
    session: OocSessionState;
    anchorExists: boolean;
    generatingKeys: string[];
    definitionsText: string;
    characterType: "character" | "group";
};

const mocks = vi.hoisted(() => ({
    fixture: null as Fixture | null,
    askOoc: vi.fn<typeof import("src/ts/ooc/oocSession.svelte").askOoc>(),
    retryOoc: vi.fn<typeof import("src/ts/ooc/oocSession.svelte").retryOoc>(),
    refreshOoc: vi.fn<typeof import("src/ts/ooc/oocSession.svelte").refreshOoc>(),
    toggleOocAttachment: vi.fn<typeof import("src/ts/ooc/oocSession.svelte").toggleOocAttachment>(),
    setChatMeta: vi.fn<typeof import("src/ts/storage/chatStore.svelte").setChatMeta>(),
}));

vi.mock(
    "src/ts/ooc/oocSession.svelte",
    () =>
        ({
            askOoc: mocks.askOoc,
            retryOoc: mocks.retryOoc,
            refreshOoc: mocks.refreshOoc,
            toggleOocAttachment: mocks.toggleOocAttachment,
            stopOoc: vi.fn(),
            deleteOocExchange: vi.fn(),
            clearOocLog: vi.fn(),
            readOocState: () => mocks.fixture!.session,
            readOocSegments: () => mocks.fixture!.segments,
            oocAnchorExists: () => mocks.fixture!.anchorExists,
            oocMessagesAfterAnchor: () => 12,
        }) satisfies typeof import("src/ts/ooc/oocSession.svelte"),
);
vi.mock("src/ts/storage/chatStore.svelte", async () =>
    (await import("src/ts/storage/tests/chatStoreMock")).createChatStoreMock({
        currentChatRef: () => ({ chaId: "character", chatId: "chat" }),
        findChat: () => mocks.fixture!.chat,
        chatEntry: () => ({ id: "chat", promptPresetId: mocks.fixture!.chat.promptPresetId }),
        setChatMeta: mocks.setChatMeta,
    }),
);
vi.mock("src/ts/storage/characterStore.svelte", () => ({
    characterList: () => [{ chaId: "character", type: mocks.fixture!.characterType, name: "Mira" }],
    selectedCharacter: () => undefined,
}));
vi.mock("src/ts/toggles/chatToggles.svelte", () => ({
    chatToggleDefinitions: () => mocks.fixture!.definitionsText,
}));
vi.mock("src/ts/process/chatStatus.svelte", () => ({
    chatStatusKey: (ref: { chaId: string; chatId: string }) => `${ref.chaId}\u0000${ref.chatId}`,
    generatingChatKeys: () => new Set(mocks.fixture!.generatingKeys),
}));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/stores.svelte", async () => (await import("src/ts/tests/storesMock")).createStoresMock());
vi.mock("src/ts/gui/colorscheme", async () => ({
    ColorSchemeTypeStore: (await import("svelte/store")).writable("dark"),
}));
vi.mock("src/ts/gui/dialogLayers", () => ({ topBindingLayer: () => null }));
vi.mock("src/ts/messageSearch.svelte", () => ({ messageSearchPanel: { open: false } }));
vi.mock("../ChatScreens/ChatBody.svelte", async () => ({
    default: (await import("./tests/OocChatBodyStub.svelte")).default,
}));

const ref = { chaId: "character", chatId: "chat" };
let fixture: Fixture;
let instance: ReturnType<typeof mount> | undefined;
const releases: (() => void)[] = [];

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    installFlatDatabase({
        botPresets: [
            { id: "tab-preset", name: "Tab preset", oocToggles: { wrong: "1" } },
            { id: "display-preset", name: "Display preset" },
            { id: "other-preset", name: "Other preset" },
        ],
        characters: [],
    });
    mocks.setChatMeta.mockImplementation((_ref, set, unset = []) => {
        Object.assign(fixture.chat, set);
        for (const key of unset) delete fixture.chat[key as keyof Chat];
    });
    mocks.askOoc.mockResolvedValue({ status: "done" });
    mocks.retryOoc.mockResolvedValue({ status: "done" });
    mocks.refreshOoc.mockResolvedValue({ status: "done" });
    mocks.toggleOocAttachment.mockReturnValue({ status: "done" });
    const exchanges: OocExchange[] = [
        {
            id: "earlier-answered",
            segment: "earlier",
            anchorMessageId: "message-1",
            time: 1,
            question: "Why did Mira leave the city?",
            answer: "She was looking for her sister.",
        },
        {
            id: "earlier-unanswered",
            segment: "earlier",
            anchorMessageId: "message-1",
            time: 2,
            question: "Who gave her the map?",
        },
        {
            id: "current-answered",
            segment: "current",
            anchorMessageId: "message-8",
            time: 3,
            question: "Does she trust the guide?",
            answer: "She is still uncertain.",
        },
        {
            id: "current-unanswered",
            segment: "current",
            anchorMessageId: "message-8",
            time: 4,
            question: "What is she hiding?",
        },
    ];
    fixture = reactiveProps<Fixture>({
        chat: {
            id: "chat",
            promptPresetId: "display-preset",
            oocSegment: { id: "current", anchorMessageId: "message-8" },
            oocLog: Object.fromEntries(exchanges.map((exchange) => [exchange.id, exchange])),
        },
        segments: [
            { id: "earlier", anchorMessageId: "message-1", current: false, exchanges: exchanges.slice(0, 2) },
            { id: "current", anchorMessageId: "message-8", current: true, exchanges: exchanges.slice(2) },
        ],
        session: {
            busy: false,
            streamingExchangeId: null,
            streamingText: "",
            error: {
                kind: "requestFailed",
                exchangeId: "current-unanswered",
                message: "The model connection closed. Try this question again.",
            },
            picks: [],
        },
        anchorExists: true,
        generatingKeys: [],
        definitionsText: "",
        characterType: "character",
    });
    mocks.fixture = fixture;
    closeOocPanel();
});

afterEach(async () => {
    for (const release of releases.splice(0)) release();
    closeOocPanel();
    if (instance) await unmount(instance);
    instance = undefined;
    document.body.replaceChildren();
    localStorage.clear();
});

function render() {
    const target = document.createElement("div");
    document.body.appendChild(target);
    instance = mount(OocPanel, { target });
    openOocPanel();
    flushSync();
}

function element<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
    const found = root.querySelector<T>(selector);
    expect(found, selector).not.toBeNull();
    return found!;
}

const segment = (id: string) => element(`[data-ooc-segment="${id}"]`);
const exchange = (id: string) => element(`[data-ooc-exchange="${id}"]`);

function expandEarlier() {
    element<HTMLButtonElement>("h3 button", segment("earlier")).click();
    flushSync();
}

function typeQuestion(text: string) {
    const input = element<HTMLTextAreaElement>("textarea");
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
}

function expectBody(row: Element, text: string, role: "user" | "char") {
    const body = element("[data-chat-body]", row);
    expect(body.textContent).toBe(text);
    expect(body.getAttribute("data-msg-display")).toBe(text);
    expect(body.getAttribute("data-role")).toBe(role);
    expect(body.getAttribute("data-idx")).toBe("-1");
}

it("opens the current segment and expands earlier exchanges in their supplied order", () => {
    render();
    expect(
        [...document.querySelectorAll("[data-ooc-segment]")].map((node) => node.getAttribute("data-ooc-segment")),
    ).toEqual(["earlier", "current"]);
    const heading = element<HTMLButtonElement>("h3 button", segment("earlier"));
    expect(heading.textContent).toMatch(/2 exchanges/);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(segment("earlier").querySelectorAll("[data-ooc-exchange]")).toHaveLength(0);
    expect(segment("current").querySelectorAll("[data-ooc-exchange]")).toHaveLength(2);
    expectBody(element("[data-ooc-question]", exchange("current-answered")), "Does she trust the guide?", "user");
    expectBody(element("[data-ooc-answer]", exchange("current-answered")), "She is still uncertain.", "char");

    expandEarlier();
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    expect(
        [...segment("earlier").querySelectorAll("[data-ooc-exchange]")].map((node) =>
            node.getAttribute("data-ooc-exchange"),
        ),
    ).toEqual(["earlier-answered", "earlier-unanswered"]);
    expectBody(element("[data-ooc-question]", exchange("earlier-answered")), "Why did Mira leave the city?", "user");
    expectBody(element("[data-ooc-answer]", exchange("earlier-answered")), "She was looking for her sister.", "char");
});

it("renders live text through ChatBody in the newest answer row", () => {
    render();
    fixture.session.busy = true;
    fixture.session.streamingExchangeId = "current-unanswered";
    fixture.session.streamingText = "She is protecting **her sister**";
    flushSync();
    const answer = element("[data-ooc-answer]", exchange("current-unanswered"));
    expectBody(answer, "She is protecting **her sister**", "char");
    expectBody(element("[data-ooc-answer]", exchange("current-answered")), "She is still uncertain.", "char");
    expect(exchange("current-unanswered").querySelector("[data-ooc-retry]")).toBeNull();

    fixture.session.streamingText = "She is protecting **her sister** from the guide.";
    flushSync();
    expectBody(answer, "She is protecting **her sister** from the guide.", "char");
});

it("offers attachments only for answered earlier exchanges and renders removable chips from picks", () => {
    render();
    expandEarlier();
    const attach = element<HTMLButtonElement>("[data-ooc-attach]", exchange("earlier-answered"));
    expect(document.querySelectorAll("[data-ooc-attach]")).toHaveLength(1);
    expect(exchange("earlier-unanswered").querySelector("[data-ooc-attach]")).toBeNull();
    expect(segment("current").querySelector("[data-ooc-attach]")).toBeNull();
    expect(attach.getAttribute("aria-pressed")).toBe("false");
    attach.click();
    flushSync();
    expect(mocks.toggleOocAttachment).toHaveBeenCalledExactlyOnceWith(ref, "earlier-answered");
    expect(document.querySelector("[data-ooc-chips]")).toBeNull();

    // The session owns picks; clicking alone must not fabricate a local attachment.
    fixture.session.picks = ["earlier-answered"];
    flushSync();
    const chip = element('[data-ooc-chip="earlier-answered"]');
    expect(document.querySelectorAll("[data-ooc-chip]")).toHaveLength(1);
    expect(chip.textContent?.trim()).toBe("Why did Mira leave the city?");
    expect(chip.compareDocumentPosition(element("textarea")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(attach.getAttribute("aria-pressed")).toBe("true");
    element<HTMLButtonElement>("button", chip).click();
    expect(mocks.toggleOocAttachment).toHaveBeenCalledTimes(2);
    expect(mocks.toggleOocAttachment).toHaveBeenLastCalledWith(ref, "earlier-answered");

    fixture.session.picks = [];
    flushSync();
    expect(document.querySelector("[data-ooc-chips]")).toBeNull();
    expect(attach.getAttribute("aria-pressed")).toBe("false");
});

it("disables send with a visible reason during a local send or followed job and enables it afterward", () => {
    render();
    const send = element<HTMLButtonElement>("[data-ooc-send]");
    expect(send.disabled).toBe(true);
    typeQuestion("What will Mira do next?");
    expect(send.disabled).toBe(false);

    const release = beginLocalSend(ref)!;
    releases.push(release);
    flushSync();
    expect(send.disabled).toBe(true);
    expect(element("[data-ooc-busy-reason]").textContent).toMatch(/chat.*generat/i);
    send.click();
    expect(mocks.askOoc).not.toHaveBeenCalled();
    release();
    flushSync();
    expect(send.disabled).toBe(false);

    fixture.generatingKeys = ["character\u0000chat"];
    flushSync();
    expect(send.disabled).toBe(true);
    expect(element("[data-ooc-busy-reason]").textContent).toMatch(/chat.*generat/i);
    send.click();
    expect(mocks.askOoc).not.toHaveBeenCalled();

    fixture.generatingKeys = [];
    flushSync();
    expect(send.disabled).toBe(false);
    expect(document.querySelector("[data-ooc-busy-reason]")).toBeNull();
    send.click();
    expect(mocks.askOoc).toHaveBeenCalledExactlyOnceWith(ref, "What will Mira do next?");
});

it("shows the refresh count and replaces it with an anchor notice when the anchor is gone", () => {
    render();
    expect(element("[data-ooc-refresh-count]").textContent?.trim()).toBe("12 new messages since this segment began");
    expect(document.querySelector("[data-ooc-notice]")).toBeNull();
    element<HTMLButtonElement>("[data-ooc-refresh]").click();
    expect(mocks.refreshOoc).toHaveBeenCalledExactlyOnceWith(ref);

    fixture.anchorExists = false;
    flushSync();
    expect(document.querySelector("[data-ooc-refresh-count]")).toBeNull();
    const notice = element("[data-ooc-notice]");
    expect(notice.textContent).toMatch(/anchor.*gone/i);
    expect(notice.textContent).toMatch(/refresh/i);
});

it("shows an error and retry only for an unanswered exchange in the current segment", () => {
    render();
    expandEarlier();
    const earlier = exchange("earlier-unanswered");
    expect(element("[data-ooc-answer]", earlier).textContent).toMatch(/no answer/i);
    expect(earlier.textContent).not.toContain("The model connection closed.");
    expect(earlier.querySelector("[data-ooc-retry]")).toBeNull();
    expect(exchange("earlier-answered").querySelector("[data-ooc-retry]")).toBeNull();
    expect(exchange("current-answered").querySelector("[data-ooc-retry]")).toBeNull();
    const current = exchange("current-unanswered");
    expect(element("[data-ooc-answer]", current).textContent).toContain(
        "The model connection closed. Try this question again.",
    );
    expect(document.querySelectorAll("[data-ooc-retry]")).toHaveLength(1);
    element<HTMLButtonElement>("[data-ooc-retry]", current).click();
    expect(mocks.retryOoc).toHaveBeenCalledExactlyOnceWith(ref, "current-unanswered");
});

const displayScope = { presetId: "display-preset", modelPresetId: "tab-preset" };
const presetMap = () => readPresetFieldOf(displayScope, "oocToggles");
const settingsButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="OOC session settings"]');
const suggestion = () => document.querySelector("[data-ooc-toggle-suggestion]");

it.each([
    {
        description: "string entries only",
        source: { ooc: "0", keep: "saved", invalid: 1 },
        expected: { ooc: "0", keep: "saved" },
    },
    { description: "an empty map when absent", source: undefined, expected: {} },
])(
    "copies $description from the display preset, edits the chat map, and unsets it when switched off",
    ({ source, expected }) => {
        writePresetField(displayScope, "oocToggles", source);
        fixture.definitionsText = "ooc=OOC mode";
        render();
        expect(document.querySelector("#ooc-toggle-settings")).toBeNull();
        settingsButton()!.click();
        flushSync();
        const popover = element("#ooc-toggle-settings");
        const own = element<HTMLInputElement>('input[type="checkbox"]', popover);
        expect(own.closest("label")!.textContent).toContain("Use this chat's own OOC toggles");
        expect(own.checked).toBe(false);
        expect(popover.querySelector("[data-ooc-toggle-editor]")).toBeNull();
        expect(mocks.setChatMeta).not.toHaveBeenCalled();

        own.click();
        flushSync();
        expect(mocks.setChatMeta).toHaveBeenCalledExactlyOnceWith(ref, { oocToggles: expected });
        expect(fixture.chat.oocToggles).toEqual(expected);
        expect(fixture.chat.oocToggles).not.toBe(presetMap());
        expect(own.checked).toBe(true);
        const row = element('[data-ooc-toggle="ooc"]', popover);
        if (source) {
            element<HTMLInputElement>('input[type="checkbox"]', row).click();
        } else {
            const mode = element<HTMLSelectElement>("select", row);
            mode.value = "forced";
            mode.dispatchEvent(new Event("change", { bubbles: true }));
        }
        flushSync();
        expect(mocks.setChatMeta).toHaveBeenLastCalledWith(ref, { oocToggles: { ...expected, ooc: "1" } });
        if (source) expect(presetMap()).toEqual(source);

        own.click();
        flushSync();
        expect(mocks.setChatMeta).toHaveBeenLastCalledWith(ref, {}, ["oocToggles"]);
        expect(Object.hasOwn(fixture.chat, "oocToggles")).toBe(false);
        expect(own.checked).toBe(false);
        expect(popover.querySelector("[data-ooc-toggle-editor]")).toBeNull();
    },
);

it("hides toggle settings and suggestions for group chats", () => {
    fixture.characterType = "group";
    fixture.definitionsText = "ooc=OOC mode";
    render();
    expect(settingsButton()).toBeNull();
    expect(suggestion()).toBeNull();
});

it("offers only a matching checkbox when the effective forced map is empty", () => {
    fixture.definitionsText = "mood=Mood";
    render();
    expect(suggestion()).toBeNull();

    fixture.definitionsText = "ooc=OOC text=text\nmeta=OOC notes=textarea\nmode=OOC mode=select=Off,On\n=OOC=caption";
    flushSync();
    expect(suggestion()).toBeNull();

    fixture.definitionsText = "OoC_mode=Session mode";
    flushSync();
    expect(suggestion()?.textContent).toContain("Session mode");
    fixture.definitionsText = "meta=Talk OoC";
    flushSync();
    expect(suggestion()?.textContent).toContain("Talk OoC");
    for (const map of [{ other: "0" }, { other: "" }]) {
        writePresetField(displayScope, "oocToggles", map);
        flushSync();
        expect(suggestion()).toBeNull();
    }
    writePresetField(displayScope, "oocToggles", {});
    fixture.chat.oocToggles = { meta: "0" };
    flushSync();
    expect(suggestion()).toBeNull();

    // An own empty map replaces the preset map, as oocToggleValues specifies.
    writePresetField(displayScope, "oocToggles", { other: "1" });
    fixture.chat.oocToggles = {};
    flushSync();
    expect(suggestion()?.textContent).toContain("Talk OoC");
    expect(presetMap()).toEqual({ other: "1" });
    expect(mocks.setChatMeta).not.toHaveBeenCalled();
});

it.each(["Force it on", "Not now"] as const)(
    "%s remembers the answer locally for that preset and only acceptance writes its map",
    async (answer) => {
        writePresetField(displayScope, "oocToggles", { keep: "saved" });
        fixture.chat.oocToggles = {};
        fixture.definitionsText = "meta=OOC mode";
        render();
        expect(suggestion()).not.toBeNull();
        expect(presetMap()).toEqual({ keep: "saved" });
        expect(localStorage.length).toBe(0);
        expect(mocks.setChatMeta).not.toHaveBeenCalled();
        const button = [...suggestion()!.querySelectorAll("button")].find(
            (node) => node.textContent?.trim() === answer,
        )!;
        button.click();
        flushSync();
        expect(presetMap()).toEqual(answer === "Force it on" ? { keep: "saved", meta: "1" } : { keep: "saved" });
        expect(fixture.chat.oocToggles).toEqual({});
        expect(suggestion()).toBeNull();

        // Reopening with no forced values must still remember this preset's answer.
        writePresetField(displayScope, "oocToggles", {});
        await unmount(instance!);
        instance = undefined;
        document.body.replaceChildren();
        render();
        expect(suggestion()).toBeNull();
        fixture.chat.promptPresetId = "other-preset";
        flushSync();
        expect(suggestion()).not.toBeNull();
        fixture.chat.promptPresetId = "display-preset";
        flushSync();
        expect(suggestion()).toBeNull();

        // A fresh module has no in-memory decision state; storage must carry the answer.
        vi.resetModules();
        const fresh = await import("src/ts/ooc/oocToggleSettings.svelte");
        expect(fresh.oocToggleOfferHandled("display-preset")).toBe(true);
        expect(fresh.oocToggleOfferHandled("other-preset")).toBe(false);
    },
);
