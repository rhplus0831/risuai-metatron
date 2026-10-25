// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { historyDigest, type ContextReport } from "../../../shared/contextReport.ts";
import { normalizeModelPreset, normalizeModelProfile, normalizePreset } from "../../../shared/presets.ts";
import type { TabTokenScope } from "../../../shared/tokenizerChoice.ts";

// `ContextMeter.svelte` over the real chat module and settings views: the chip reads the open chat's
// newest valid `generationInfo.context`, else the newest legacy token counts; the popover is
// portaled to the body, positioned from the chip's rectangle (stubbed here: happy-dom has no
// layout), and closed by Escape, an outside pointer, focus leaving, its source disappearing, or
// the chip leaving the viewport. The settings link records a real settings jump. The displacement
// estimate counts the draft and the last reply through the real `countTokensInScope` against a
// stubbed count route (each signal-bearing count is one request, answered by the test when it
// chooses, so the debounce and the in-flight races are driven by fake timers and deferred answers).

const mocks = vi.hoisted(() => ({
    authFetch: vi.fn<typeof import("src/ts/storage/serverAuth").authFetch>(),
}));

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: mocks.authFetch }),
);

import { language } from "src/lang";
import { doingAlert } from "src/ts/alert";
import { currentJump, finishJump, jumpVersion } from "src/ts/setting/settingJump.svelte";
import { INTERACTION_SETTINGS_MENU } from "src/ts/settingsMenu";
import { chatBindingPatch } from "src/ts/storage/chatBinding.svelte";
import { findChat, patchMessage, removeMessages, type ChatRef } from "src/ts/storage/chatStore.svelte";
import { activeMainProfile, activePreset, readSettingsRoot, settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { SettingsMenuIndex, settingsOpen } from "src/ts/stores.svelte";
import { jobTokenScope, tokenScopeKey } from "src/ts/tokenizer";
import ContextMeter from "./ContextMeter.svelte";

const ref: ChatRef = { chaId: "c", chatId: "k" };
const mounted: ReturnType<typeof mount>[] = [];
let target: HTMLElement;

type Info = { inputTokens?: number; maxContext?: number; context?: unknown };
type FixtureMessage = { chatId: string; role: "user" | "char"; data: string; generationInfo?: Info };

/** A valid report: 800 tokens of prompt budget, 600 used, every eligible message kept. */
function report(overrides: Partial<ContextReport> = {}): ContextReport {
    return {
        v: 1,
        maxContext: 1000,
        maxResponse: 200,
        input: 600,
        sections: [
            { kind: "main", tokens: 100 },
            { kind: "history", tokens: 450 },
            { kind: "description", tokens: 30 },
        ],
        adjustment: 20,
        attributionExact: true,
        history: { total: 6, kept: 6, totalUser: 3, keptUser: 3, droppedTokens: 0 },
        lore: { budgetUsed: 0, budget: 0, rejectedCount: 0, rejectedTokens: 0, active: 0 },
        tokenScope: "scope",
        historyDigest: "digest",
        ...overrides,
    };
}
/** A report whose history was trimmed: 4 of 6 messages and 2 of 3 user turns kept. */
const trimmed = (overrides: Partial<ContextReport> = {}) =>
    report({ history: { total: 6, kept: 4, totalUser: 3, keptUser: 2, droppedTokens: 300 }, ...overrides });

const reply = (chatId: string, info?: Info): FixtureMessage => ({
    chatId,
    role: "char",
    data: "reply",
    generationInfo: info,
});

function install(messages: FixtureMessage[]) {
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "C",
                chatPage: 0,
                chats: [{ id: "k", name: "K", note: "", localLore: [], message: messages }],
            },
        ],
    } as any);
    // The fixture installs no defaults: the three meter settings are set as the server's normalization would.
    settings.ui.contextMeter = true;
    settings.ui.contextMeterTurnUnit = "user";
    settings.ui.contextMeterFixedWarn = 60;
}

const CHIP = { x: 500, y: 700, left: 500, right: 600, top: 700, bottom: 744, width: 100, height: 44 };

/** Mounts the meter; the returned props are reactive, so a test changes the draft or the generating flag. */
function render(props: { group?: boolean; draft?: string; generating?: boolean } = {}) {
    const state = $state({
        chatRef: ref,
        group: props.group ?? false,
        height: "44px",
        draft: props.draft ?? "",
        generating: props.generating ?? false,
    });
    mounted.push(mount(ContextMeter, { target, props: state }));
    flushSync();
    return state;
}
const chip = () => target.querySelector<HTMLButtonElement>("button.context-meter-chip");
const panel = () => document.body.querySelector<HTMLElement>('[role="dialog"].context-meter-panel');
const chipText = () => chip()?.textContent?.replace(/\s+/g, " ").trim();
const outside = () => {
    const other = document.createElement("button");
    document.body.appendChild(other);
    return other;
};

/** Places the chip at `rect` (the stub the next `position()` reads) and opens the popover. */
async function openPanel(rect: Partial<typeof CHIP> = {}) {
    const button = chip();
    expect(button).not.toBeNull();
    Object.defineProperty(button!, "getBoundingClientRect", {
        value: () => ({ ...CHIP, ...rect }),
        configurable: true,
    });
    button!.click();
    await settle();
    return panel()!;
}
async function settle() {
    flushSync();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
}
function keydown(element: Element, key: string) {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    flushSync();
}
function pointerdown(element: Element) {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    flushSync();
}
function focusout(element: Element, relatedTarget: Element | null) {
    element.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget }));
    flushSync();
}
const sectionRows = () =>
    [...(panel()?.querySelectorAll<HTMLElement>("[data-context-meter-sections] li") ?? [])].map((row) => [
        row.dataset.section,
        row.textContent?.replace(/\s+/g, " ").trim(),
    ]);

beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(doingAlert).mockReturnValue(false);
    settingsOpen.set(false);
    SettingsMenuIndex.set(-1);
    target = document.createElement("div");
    document.body.appendChild(target);
});

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    finishJump(jumpVersion());
    document.body.replaceChildren();
    vi.useRealTimers();
});

describe("the chip", () => {
    it("shows the share of the prompt budget while all eligible history was kept", () => {
        install([reply("m1", { inputTokens: 600, maxContext: 1000, context: report() })]);
        render();
        expect(chipText()).toBe("75%");
        expect(chip()!.classList.contains("text-danger-500")).toBe(false);
        expect(chip()!.getAttribute("aria-label")).toBe(
            language.contextUsage.chipLabel(language.contextUsage.fullSummary(75)),
        );
    });

    it("shows the kept count in the turn unit once history was trimmed, and follows the unit setting", () => {
        install([reply("m1", { context: trimmed() })]);
        render();
        expect(chipText()).toBe("2 turns");
        settings.ui.contextMeterTurnUnit = "message";
        flushSync();
        expect(chipText()).toBe("4 messages");
    });

    it("with memory, shows the kept count and the coverage, and names the memory kind in its label", () => {
        const cases = [
            ["covered", language.contextUsage.summarized],
            ["gap", language.contextUsage.gap],
            ["unknown", language.contextUsage.memoryOn],
        ] as const;
        install([reply("m1", { context: trimmed({ memory: { kind: "hypaV3", tokens: 300, coverage: "covered" } }) })]);
        render();
        for (const [coverage, note] of cases) {
            patchMessage(ref, "m1", {
                generationInfo: { context: trimmed({ memory: { kind: "hypaV3", tokens: 300, coverage } }) },
            });
            flushSync();
            expect(chipText(), coverage).toBe(`2 turns · ${note}`);
            expect(chip()!.getAttribute("aria-label"), coverage).toContain(`2 turns, HypaV3 ${note}`);
        }
    });

    it("takes the danger tone only when the fixed share exceeds the warning level", () => {
        // Fixed sections 480 of the 800 budget: exactly 60%.
        const sections = [
            { kind: "main", tokens: 480 },
            { kind: "history", tokens: 100 },
        ] as const;
        install([reply("m1", { context: report({ sections: [...sections], input: 580 }) })]);
        render();
        expect(chip()!.classList.contains("text-danger-500")).toBe(false);
        expect(chip()!.getAttribute("aria-label")).not.toContain(language.contextUsage.fixedWarnSummary);
        settings.ui.contextMeterFixedWarn = 59;
        flushSync();
        expect(chip()!.classList.contains("text-danger-500")).toBe(true);
        expect(chip()!.classList.contains("text-textcolor2")).toBe(false);
        expect(chip()!.getAttribute("aria-label")).toContain(language.contextUsage.fixedWarnSummary);
    });

    it("falls back to the legacy token counts when no message has a readable report", async () => {
        // The newest reply's report is unreadable (`v: 2`), so its own legacy numbers are used.
        install([
            reply("m1", { inputTokens: 900, maxContext: 1000 }),
            reply("m2", { inputTokens: 300, maxContext: 1000, context: { v: 2 } }),
        ]);
        render();
        expect(chipText()).toBe("30%");
        const opened = await openPanel();
        expect(opened.textContent).toContain(language.contextUsage.legacyNote);
        expect(opened.textContent).toContain(language.contextUsage.input("300", "1,000"));
    });

    it("prefers an older valid report over a newer reply with only legacy counts", () => {
        install([
            reply("m1", { inputTokens: 600, maxContext: 1000, context: trimmed() }),
            reply("m2", { inputTokens: 300, maxContext: 1000 }),
        ]);
        render();
        expect(chipText()).toBe("2 turns");
    });

    it("rejects negative legacy input and needs a positive context size", () => {
        install([reply("m1", { inputTokens: -5, maxContext: 1000 }), reply("m2", { inputTokens: 10, maxContext: 0 })]);
        render();
        expect(chip()).toBeNull();
    });

    it("is absent without any token information, in a group chat, or while the meter is off", () => {
        install([reply("m1")]);
        render();
        expect(chip()).toBeNull();
        patchMessage(ref, "m1", { generationInfo: { context: report() } });
        flushSync();
        expect(chip()).not.toBeNull();
        settings.ui.contextMeter = false;
        flushSync();
        expect(chip()).toBeNull();
        settings.ui.contextMeter = true;
        flushSync();
        expect(chip()).not.toBeNull();

        // A second instance for a group adds no chip.
        render({ group: true });
        expect(target.querySelectorAll("button.context-meter-chip").length).toBe(1);
    });
});

describe("the popover", () => {
    it("opens focused, lists the sections largest first with the signed Other row outside the bar", async () => {
        install([reply("m1", { context: report() })]);
        render();
        expect(panel()).toBeNull();
        const opened = await openPanel();
        expect(document.activeElement).toBe(opened);
        expect(chip()!.getAttribute("aria-expanded")).toBe("true");
        expect(chip()!.getAttribute("aria-controls")).toBe(opened.id);
        expect(opened.getAttribute("aria-labelledby")).toBe(`${opened.id}-title`);
        expect(sectionRows()).toEqual([
            ["history", `${language.contextUsage.sections.history} 450 tokens 56%`],
            ["main", `${language.contextUsage.sections.main} 100 tokens 13%`],
            ["description", `${language.contextUsage.sections.description} 30 tokens 4%`],
            ["other", `${language.contextUsage.other} +20 tokens`],
        ]);
        // The bar has one segment per section, none for Other.
        expect(opened.querySelector('[aria-hidden="true"].h-3')!.children.length).toBe(3);
        expect(opened.textContent).toContain(language.contextUsage.replyBudget("200"));
        expect(opened.textContent).not.toContain(language.contextUsage.approximate);
        expect(opened.querySelector("[data-context-meter-omitted]")).toBeNull();
        expect(opened.querySelector("[data-context-meter-lore]")).toBeNull();
    });

    it("shows a negative adjustment with its sign, the approximate note, and the omitted history", async () => {
        install([reply("m1", { context: trimmed({ adjustment: -15, attributionExact: false }) })]);
        render();
        const opened = await openPanel();
        expect(sectionRows().at(-1)).toEqual(["other", `${language.contextUsage.other} −15 tokens`]);
        expect(opened.textContent).toContain(language.contextUsage.approximate);
        expect(opened.querySelector("[data-context-meter-omitted]")!.textContent).toBe(
            language.contextUsage.historyOmitted(2, "300"),
        );
        expect(opened.textContent).toContain(language.contextUsage.historyIncluded(4, 6, 2, 3));
    });

    it("reads a zero prompt budget as 100% and says so", async () => {
        install([reply("m1", { context: report({ maxContext: 1000, maxResponse: 1000, input: 600 }) })]);
        render();
        expect(chipText()).toBe("100%");
        const opened = await openPanel();
        expect(opened.textContent).toContain(language.contextUsage.noBudget);
        // No percent column without a budget.
        expect(sectionRows()[0]).toEqual(["history", `${language.contextUsage.sections.history} 450 tokens`]);
    });

    it("shows the lorebook block for a rejection under a zero budget", async () => {
        install([
            reply("m1", {
                context: report({
                    lore: { budgetUsed: 0, budget: 0, rejectedCount: 2, rejectedTokens: 80, active: 0 },
                }),
            }),
        ]);
        render();
        const opened = await openPanel();
        const lore = opened.querySelector("[data-context-meter-lore]")!;
        expect(lore.textContent).toContain(language.contextUsage.loreRejected(2, "80"));
        expect(lore.textContent).toContain("0 / 0");
    });

    it("shows the HypaV3 budget meter only with a budget, else the memory line, with the coverage text", async () => {
        install([reply("m1", { context: trimmed({ memory: { kind: "hypaV3", tokens: 300, coverage: "gap" } }) })]);
        render();
        let opened = await openPanel();
        let memory = opened.querySelector("[data-context-meter-memory]")!;
        expect(memory.textContent).toContain(language.contextUsage.memoryLine("HypaV3", "300"));
        expect(memory.textContent).toContain(language.contextUsage.coverageGap);
        chip()!.click();
        flushSync();
        expect(panel()).toBeNull();

        patchMessage(ref, "m1", {
            generationInfo: {
                context: trimmed({ memory: { kind: "hypaV3", tokens: 300, budget: 500, coverage: "covered" } }),
            },
        });
        flushSync();
        opened = await openPanel();
        memory = opened.querySelector("[data-context-meter-memory]")!;
        expect(memory.textContent).toContain(language.contextUsage.memoryBudget("HypaV3"));
        expect(memory.textContent).toContain("300 / 500");
        expect(memory.textContent).not.toContain(language.contextUsage.memoryLine("HypaV3", "300"));
        expect(memory.textContent).toContain(language.contextUsage.coverageCovered);
    });

    it("sits above the chip when there is room, below it otherwise, and stays below alerts", async () => {
        install([reply("m1", { context: report() })]);
        render();
        const height = window.innerHeight;
        let opened = await openPanel({ top: 700, bottom: 744 });
        expect(opened.classList.contains("z-30")).toBe(true);
        expect(opened.style.bottom).toBe(`${height - 700 + 8}px`);
        expect(opened.style.top).toBe("auto");
        expect(opened.style.maxHeight).toBe(`${700 - 16}px`);
        keydown(opened, "Escape");

        opened = await openPanel({ top: 20, bottom: 64 });
        expect(opened.style.top).toBe(`${64 + 8}px`);
        expect(opened.style.bottom).toBe("auto");
        expect(opened.style.maxHeight).toBe(`${height - 64 - 16}px`);
    });

    it("closes when the chip scrolls out of view, not on a scroll while it is visible", async () => {
        install([reply("m1", { context: report() })]);
        render();
        const button = chip()!;
        await openPanel();
        document.dispatchEvent(new Event("scroll", { bubbles: true }));
        flushSync();
        expect(panel()).not.toBeNull();

        Object.defineProperty(button, "getBoundingClientRect", { value: () => ({ ...CHIP, top: -50, bottom: -6 }) });
        document.dispatchEvent(new Event("scroll", { bubbles: true }));
        flushSync();
        expect(panel()).toBeNull();
    });

    it("closes when its source disappears and does not reopen when the meter is turned back on", async () => {
        install([reply("m0"), reply("m1", { context: report() }), reply("m2", { context: trimmed() })]);
        render();
        let opened = await openPanel();
        expect(opened.querySelector("[data-context-meter-omitted]")).not.toBeNull();
        removeMessages(ref, ["m2"]);
        await settle();
        // The older report is the source now: the chip and the open popover follow it.
        expect(chipText()).toBe("75%");
        opened = panel()!;
        expect(opened).not.toBeNull();
        expect(opened.querySelector("[data-context-meter-omitted]")).toBeNull();
        removeMessages(ref, ["m1"]);
        await settle();
        expect(chip()).toBeNull();
        expect(panel()).toBeNull();

        patchMessage(ref, "m0", { generationInfo: { context: report() } });
        flushSync();
        await openPanel();
        settings.ui.contextMeter = false;
        flushSync();
        expect(chip()).toBeNull();
        expect(panel()).toBeNull();
        settings.ui.contextMeter = true;
        flushSync();
        expect(chip()).not.toBeNull();
        expect(panel()).toBeNull();
    });
});

describe("dismissal and focus", () => {
    beforeEach(() => {
        install([reply("m1", { context: report() })]);
        render();
    });

    it("closes on Escape with focus back on the chip, but not under an alert", async () => {
        const opened = await openPanel();
        vi.mocked(doingAlert).mockReturnValue(true);
        keydown(opened, "Escape");
        expect(panel()).not.toBeNull();

        vi.mocked(doingAlert).mockReturnValue(false);
        keydown(opened, "Escape");
        expect(panel()).toBeNull();
        expect(document.activeElement).toBe(chip());
        expect(chip()!.getAttribute("aria-expanded")).toBe("false");
    });

    it("closes on a pointer down outside, not on one inside or on the chip", async () => {
        const opened = await openPanel();
        pointerdown(opened.querySelector("h2")!);
        expect(panel()).not.toBeNull();
        pointerdown(chip()!);
        expect(panel()).not.toBeNull();
        pointerdown(outside());
        expect(panel()).toBeNull();
    });

    it("closes when focus leaves both the panel and the chip, also to a null destination once focus settles", async () => {
        let opened = await openPanel();
        focusout(opened, chip()!);
        expect(panel()).not.toBeNull();
        focusout(opened, opened.querySelector("button")!);
        expect(panel()).not.toBeNull();
        focusout(opened, outside());
        expect(panel()).toBeNull();

        // A null destination is decided once focus settles: still inside, it stays open; focus gone
        // from the document (browser chrome, another window), it closes.
        opened = await openPanel();
        focusout(opened, null);
        await settle();
        expect(panel()).not.toBeNull();
        const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
        focusout(opened, null);
        expect(panel()).not.toBeNull();
        await settle();
        expect(panel()).toBeNull();
        hasFocus.mockRestore();
    });

    it("the close button closes and returns focus to the chip", async () => {
        const opened = await openPanel();
        opened.querySelector<HTMLButtonElement>("button")!.click();
        flushSync();
        expect(panel()).toBeNull();
        expect(document.activeElement).toBe(chip());
    });

    it("the basis line names the unit and level, and its link records a jump to the meter's settings section", async () => {
        settings.ui.contextMeterTurnUnit = "message";
        settings.ui.contextMeterFixedWarn = 45;
        flushSync();
        const opened = await openPanel();
        expect(opened.textContent).toContain(language.contextUsage.basis(language.contextUsage.basisMessages, 45));
        const link = [...opened.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === language.contextUsage.changeSettings,
        )!;
        link.click();
        flushSync();
        expect(panel()).toBeNull();
        expect(get(settingsOpen)).toBe(true);
        expect(get(SettingsMenuIndex)).toBe(INTERACTION_SETTINGS_MENU);
        expect(currentJump()).toMatchObject({
            kind: "section",
            id: "interaction.contextMeter",
            sectionId: "interaction.contextMeter",
            menu: INTERACTION_SETTINGS_MENU,
            available: true,
        });
    });
});

describe("the displacement estimate", () => {
    type CountRequest = {
        text: string;
        scope: TabTokenScope;
        aborted: () => boolean;
        answer: (count: number) => void;
        fail: () => void;
    };
    /** Every count request the meter made, in order; each carries one text (a signal owns its request). */
    const requests: CountRequest[] = [];
    /** When set, answers each request as it arrives; otherwise the test answers `requests[i]` itself. */
    let autoCount: ((text: string) => number) | null = null;
    const byLength = (text: string) => text.length;

    const REPLY = "x".repeat(20);
    const PER_MESSAGE = 3;
    const bound: ChatRef = { chaId: "c", chatId: "k" };
    const user = (chatId: string, data: string): FixtureMessage => ({ chatId, role: "user", data });
    const char = (chatId: string, data: string, info?: Info): FixtureMessage => ({
        chatId,
        role: "char",
        data,
        generationInfo: info,
    });

    /**
     * A bound chat (model preset `m1` → profile `gpt` with `maxContext` 1000, prompt preset `p1` with
     * `maxResponse` 200, persona `u1`), no memory, no preset chain. The messages' last reply carries
     * the report `trim` describes, computed over the tab's own scope key, sizes, and history digest.
     */
    function installEstimate(trim: NonNullable<ContextReport["trim"]>, options: { continued?: boolean } = {}) {
        const before = [user("m1", "hello")];
        const context = (): ContextReport =>
            trimmed({
                tokenScope: tokenScopeKey(jobTokenScope()),
                maxContext: readSettingsRoot("maxContext") as number,
                maxResponse: readSettingsRoot("maxResponse") as number,
                historyDigest: historyDigest(before),
                trim: options.continued ? { ...trim, replyPrefix: { messageId: "m2", tokens: 15 } } : trim,
            });
        installFlatDatabaseWithChats({
            characters: [
                {
                    chaId: "c",
                    type: "character",
                    name: "C",
                    chatPage: 0,
                    chats: [
                        {
                            id: "k",
                            name: "K",
                            note: "",
                            localLore: [],
                            message: [...before, char("m2", REPLY)],
                            modelPresetId: "m1",
                            promptPresetId: "p1",
                            bindedPersona: "u1",
                        },
                    ],
                },
            ],
            botPresets: [normalizePreset({ name: "Prompt One", maxResponse: 200 }, { id: "p1" })],
            modelPresets: [normalizeModelPreset({ name: "Model One", mainSlot: { profileId: "gpt" } }, { id: "m1" })],
            modelProfiles: [normalizeModelProfile({ id: "gpt", name: "GPT", modelId: "gpt4o", maxContext: 1000 })],
            personas: [{ id: "u1", name: "Ann", icon: "", note: "", personaPrompt: "" }],
            supaModelType: "none",
            hypaV3: false,
            hypav2: false,
            hanuraiEnable: false,
            presetChain: "",
            useTokenizerCaching: false,
            googleClaudeTokenizing: false,
        } as any);
        settings.ui.contextMeter = true;
        settings.ui.contextMeterTurnUnit = "user";
        settings.ui.contextMeterFixedWarn = 60;
        // The report is written once the views answer (the scope key reads the installed profile).
        patchMessage(bound, "m2", { generationInfo: { context: context() } });
        flushSync();
    }

    /** Overflow 26 for `REPLY` + a 10-character draft: the example, then two messages (one the user's). */
    const QUEUE = {
        headroom: 10,
        perMessage: PER_MESSAGE,
        queue: [
            { tokens: 12, kind: "example", user: false },
            { tokens: 10, kind: "message", user: true },
            { tokens: 8, kind: "message", user: false },
            { tokens: 9, kind: "message", user: true },
            { tokens: 30, kind: "message", user: false },
        ],
    } satisfies NonNullable<ContextReport["trim"]>;

    const suffix = () => chip()?.querySelector("[data-context-meter-estimate]")?.textContent ?? null;
    const block = () => panel()?.querySelector("[data-context-meter-estimate-block]") ?? null;
    const texts = () => requests.map((request) => request.text);
    /** The report on the chat's last reply, as the chat module holds it. */
    const lastReport = () => findChat(bound)!.message.at(-1)!.generationInfo!.context as ContextReport;
    const s = language.contextUsage;

    beforeEach(() => {
        requests.length = 0;
        autoCount = null;
        mocks.authFetch.mockReset();
        mocks.authFetch.mockImplementation(
            (path, init) =>
                new Promise<Response>((resolve, reject) => {
                    expect(path).toBe("/api/tokens/count");
                    const body = JSON.parse(String(init?.body)) as { scope: TabTokenScope; texts: string[] };
                    expect(body.texts).toHaveLength(1);
                    const signal = init?.signal ?? null;
                    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
                    const request: CountRequest = {
                        text: body.texts[0],
                        scope: body.scope,
                        aborted: () => signal?.aborted === true,
                        answer: (count) => resolve(Response.json({ counts: [count] })),
                        fail: () => resolve(new Response("count failed", { status: 500 })),
                    };
                    requests.push(request);
                    if (autoCount) {
                        request.answer(autoCount(request.text));
                    }
                }),
        );
    });

    it("counts the reply and the draft at once in the job scope, then only the draft after 400 ms of quiet", async () => {
        installEstimate(QUEUE);
        const props = render({ draft: "d".repeat(10) });
        // Both counts leave immediately, each alone, in the job scope (no plugin tokenizer).
        expect(texts()).toEqual([REPLY, "d".repeat(10)]);
        expect(requests[0].scope).toEqual(jobTokenScope());
        expect(requests[0].scope.pluginTokenizer).toBe("none");
        expect(suffix()).toBeNull();
        requests[0].answer(20);
        requests[1].answer(10);
        await settle();
        // added = 20 + 3 + 10 + 3 = 36; over 26 drops the example, a user turn, and a reply.
        expect(suffix()).toBe(s.estimateSuffix(1));
        expect(chip()!.getAttribute("title")).toBe(
            `${s.chipLabel(s.trimmedSummary("2 turns"))} ${s.estimateTitle}: ${s.estimateDrops("1 turn", "2 turns", 1)}`,
        );

        // A later edit waits 400 ms; the earlier estimate stays shown meanwhile; the reply is not recounted.
        props.draft = "d".repeat(30);
        await vi.advanceTimersByTimeAsync(399);
        expect(requests).toHaveLength(2);
        expect(suffix()).toBe(s.estimateSuffix(1));
        await vi.advanceTimersByTimeAsync(1);
        expect(texts()).toEqual([REPLY, "d".repeat(10), "d".repeat(30)]);
        requests[2].answer(30);
        await settle();
        // added = 56; over 46 also drops the next user turn (over 46 − 12 − 10 − 8 − 9 = 7 → the 30).
        expect(suffix()).toBe(s.estimateSuffix(2));
        settings.ui.contextMeterTurnUnit = "message";
        flushSync();
        expect(suffix()).toBe(s.estimateSuffix(4));
        expect(chip()!.getAttribute("title")).toContain(s.estimateDrops("4 messages", "4 messages", 0));

        // An emptied draft shows nothing and sends nothing; the next text counts at once (the draft only).
        props.draft = "";
        flushSync();
        expect(suffix()).toBeNull();
        expect(requests).toHaveLength(3);
        props.draft = "d".repeat(10);
        flushSync();
        expect(texts().at(-1)).toBe("d".repeat(10));
        expect(requests).toHaveLength(4);
    });

    it("strips the Thoughts block from the reply and the draft before counting", () => {
        installEstimate(QUEUE);
        patchMessage(bound, "m2", { data: `<Thoughts>hidden</Thoughts>${REPLY}` });
        flushSync();
        render({ draft: "<Thoughts>plan</Thoughts>visible" });
        expect(texts()).toEqual([REPLY, "visible"]);
    });

    it("shows the three outcomes: within the queue, fitting (in both units), and past the saved queue", async () => {
        autoCount = byLength;
        // Fits: a headroom above the 36 added tokens.
        installEstimate({ ...QUEUE, headroom: 100 });
        render({ draft: "d".repeat(10) });
        await settle();
        expect(suffix()).toBeNull();
        let opened = await openPanel();
        expect(block()!.textContent).toContain(s.estimateFits);
        expect(block()!.textContent).toContain(s.estimateNote);
        keydown(opened, "Escape");

        // Over 20 drops the example and one of the character's messages: no user turn, one message.
        patchMessage(bound, "m2", {
            generationInfo: {
                context: trimmed({
                    tokenScope: tokenScopeKey(jobTokenScope()),
                    maxContext: 1000,
                    maxResponse: 200,
                    historyDigest: historyDigest([user("m1", "hello")]),
                    trim: {
                        headroom: 16,
                        perMessage: PER_MESSAGE,
                        queue: [
                            { tokens: 12, kind: "example", user: false },
                            { tokens: 8, kind: "message", user: false },
                            { tokens: 10, kind: "message", user: true },
                        ],
                    },
                }),
            },
        });
        await settle();
        expect(suffix()).toBeNull();
        opened = await openPanel();
        expect(block()!.textContent).toContain(s.estimateNoTurns("1 message"));
        settings.ui.contextMeterTurnUnit = "message";
        flushSync();
        expect(suffix()).toBe(s.estimateSuffix(1));
        expect(block()!.textContent).toContain(s.estimateDrops("1 message", "4 messages", 3));
        keydown(opened, "Escape");
        settings.ui.contextMeterTurnUnit = "user";

        // Past the queue: the saved entries sum to 15 against an overflow of 36.
        patchMessage(bound, "m2", {
            generationInfo: {
                context: trimmed({
                    tokenScope: tokenScopeKey(jobTokenScope()),
                    maxContext: 1000,
                    maxResponse: 200,
                    historyDigest: historyDigest([user("m1", "hello")]),
                    trim: {
                        headroom: 0,
                        perMessage: PER_MESSAGE,
                        queue: [
                            { tokens: 5, kind: "example", user: false },
                            { tokens: 0, kind: "marker", user: false },
                            { tokens: 5, kind: "message", user: true },
                            { tokens: 5, kind: "message", user: false },
                        ],
                    },
                }),
            },
        });
        await settle();
        expect(suffix()).toBe(s.estimateBeyondSuffix(1));
        opened = await openPanel();
        expect(block()!.textContent).toContain(s.estimateBeyond("1 turn"));
        settings.ui.contextMeterTurnUnit = "message";
        flushSync();
        expect(suffix()).toBe(s.estimateBeyondSuffix(2));
        expect(block()!.textContent).toContain(s.estimateBeyond("2 messages"));
        keydown(opened, "Escape");

        // A queue without a message entry gives no count at all.
        patchMessage(bound, "m2", {
            generationInfo: {
                context: trimmed({
                    tokenScope: tokenScopeKey(jobTokenScope()),
                    maxContext: 1000,
                    maxResponse: 200,
                    historyDigest: historyDigest([user("m1", "hello")]),
                    trim: {
                        headroom: 0,
                        perMessage: PER_MESSAGE,
                        queue: [{ tokens: 5, kind: "example", user: false }],
                    },
                }),
            },
        });
        await settle();
        expect(suffix()).toBe("≈ −?");
        opened = await openPanel();
        expect(block()!.textContent).toContain(s.estimateBeyondUnknown);
    });

    it("subtracts a continue's prefix once and shows nothing when the overflow reaches the queue's last entry", async () => {
        autoCount = byLength;
        // The continued reply was in the ledger at 15 tokens (overhead included): added = 20 + 3 − 15 + 10 + 3 = 21.
        installEstimate(
            {
                headroom: 10,
                perMessage: PER_MESSAGE,
                queue: [
                    { tokens: 6, kind: "message", user: true },
                    { tokens: 6, kind: "message", user: false },
                    { tokens: 50, kind: "message", user: true },
                ],
            },
            { continued: true },
        );
        const props = render({ draft: "d".repeat(10) });
        await settle();
        // Over 11 drops two messages, one the user's; without the prefix (over 26) it would reach the third.
        expect(suffix()).toBe(s.estimateSuffix(1));
        settings.ui.contextMeterTurnUnit = "message";
        flushSync();
        expect(suffix()).toBe(s.estimateSuffix(2));
        settings.ui.contextMeterTurnUnit = "user";

        // Over 31 passes the first two entries (12): the last entry may be the continued reply itself.
        props.draft = "d".repeat(30);
        await vi.advanceTimersByTimeAsync(400);
        await settle();
        expect(suffix()).toBeNull();
        await openPanel();
        expect(block()).toBeNull();
    });

    it("needs the report on the chat's last, enabled message, with a matching prefix and digest", async () => {
        autoCount = byLength;
        installEstimate(QUEUE);
        render({ draft: "d".repeat(10) });
        await settle();
        expect(suffix()).toBe(s.estimateSuffix(1));

        // An edit before the reply changes the digest; undoing it brings the estimate back at once.
        patchMessage(bound, "m1", { data: "hello?" });
        await settle();
        expect(suffix()).toBeNull();
        patchMessage(bound, "m1", { data: "hello" });
        await settle();
        expect(suffix()).toBe(s.estimateSuffix(1));

        // The reply disabled, either way, or no longer the last message.
        patchMessage(bound, "m2", { disabled: true });
        await settle();
        expect(suffix()).toBeNull();
        patchMessage(bound, "m2", { disabled: "allBefore" });
        await settle();
        expect(suffix()).toBeNull();
        patchMessage(bound, "m2", {}, ["disabled"]);
        await settle();
        expect(suffix()).toBe(s.estimateSuffix(1));
        patchMessage(bound, "m2", { data: `${REPLY}!` });
        await settle();
        // A changed reply is a new basis: recounted at once (the memoized count is for the old text).
        expect(texts().slice(-2)).toEqual([`${REPLY}!`, "d".repeat(10)]);
        expect(suffix()).toBe(s.estimateSuffix(1));

        // A continue report whose prefix names another message.
        const report = lastReport();
        patchMessage(bound, "m2", {
            generationInfo: {
                context: { ...report, trim: { ...report.trim!, replyPrefix: { messageId: "m1", tokens: 15 } } },
            },
        });
        await settle();
        expect(suffix()).toBeNull();
    });

    it("needs no generation, no memory, no preset chain, a complete binding, and the same scope and sizes", async () => {
        autoCount = byLength;
        installEstimate(QUEUE);
        const props = render({ draft: "d".repeat(10) });
        await settle();
        expect(suffix()).toBe(s.estimateSuffix(1));
        const shownAgain = async () => {
            await settle();
            expect(suffix()).toBe(s.estimateSuffix(1));
        };
        const hidden = async () => {
            await settle();
            expect(suffix()).toBeNull();
            await openPanel();
            expect(block()).toBeNull();
            keydown(panel()!, "Escape");
        };

        props.generating = true;
        await hidden();
        props.generating = false;
        await shownAgain();

        settings.memoryTranslateMedia.hypaV3 = true;
        await hidden();
        settings.memoryTranslateMedia.hypaV3 = false;
        settings.memoryTranslateMedia.supaModelType = "subModel";
        await hidden();
        settings.memoryTranslateMedia.supaModelType = "none";
        await shownAgain();

        settings.providers.presetChain = "Prompt One, Other";
        await hidden();
        settings.providers.presetChain = "";
        await shownAgain();

        chatBindingPatch(bound, { personaId: null });
        await hidden();
        chatBindingPatch(bound, { personaId: "u1" });
        await shownAgain();

        // Another model is another token scope.
        activeMainProfile.modelId = "hf:::Xenova/opt-350m";
        await hidden();
        activeMainProfile.modelId = "gpt4o";
        await shownAgain();

        // The effective context size is the prompt preset's override when it is on.
        activeMainProfile.maxContext = 2000;
        await hidden();
        activePreset.maxContextOverride = true;
        activePreset.maxContextOverrideSize = 1000;
        await shownAgain();
        activePreset.maxResponse = 300;
        await hidden();
        activePreset.maxResponse = 200;
        await shownAgain();
    });

    it("recounts the draft after a failed count, including the draft that counted before the failure", async () => {
        installEstimate(QUEUE);
        const props = render({ draft: "d".repeat(10) });
        requests[0].answer(20);
        requests[1].answer(10);
        await settle();
        expect(suffix()).toBe(s.estimateSuffix(1));

        // The failing draft hides the estimate.
        props.draft = "bad";
        await vi.advanceTimersByTimeAsync(400);
        expect(texts().at(-1)).toBe("bad");
        requests[2].fail();
        await settle();
        expect(suffix()).toBeNull();

        // Back to the earlier draft: counted at once (not skipped as already applied) and shown again.
        props.draft = "d".repeat(10);
        flushSync();
        expect(texts()).toEqual([REPLY, "d".repeat(10), "bad", "d".repeat(10)]);
        requests[3].answer(10);
        await settle();
        expect(suffix()).toBe(s.estimateSuffix(1));
    });

    it("aborts the sibling count when one count fails, and both when the basis changes or the meter unmounts", async () => {
        installEstimate(QUEUE);
        const props = render({ draft: "d".repeat(10) });
        expect(requests).toHaveLength(2);
        requests[1].fail();
        await settle();
        expect(requests[0].aborted()).toBe(true);
        expect(suffix()).toBeNull();

        // The next draft counts the reply again (its count never landed) and the draft.
        props.draft = "d".repeat(11);
        flushSync();
        expect(texts().slice(2)).toEqual([REPLY, "d".repeat(11)]);
        // A basis change while they are in flight aborts both; their late answers show nothing.
        patchMessage(bound, "m1", { data: "edited" });
        await settle();
        expect(requests[2].aborted()).toBe(true);
        expect(requests[3].aborted()).toBe(true);
        requests[2].answer(20);
        requests[3].answer(11);
        await settle();
        expect(suffix()).toBeNull();
        patchMessage(bound, "m1", { data: "hello" });
        flushSync();
        expect(requests).toHaveLength(6);

        // Unmounting aborts the pending counts and ignores their answers.
        await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
        expect(requests[4].aborted()).toBe(true);
        expect(requests[5].aborted()).toBe(true);
        requests[4].answer(20);
        requests[5].answer(11);
        await settle();
        expect(chip()).toBeNull();
    });
});
