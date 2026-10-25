// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextReport } from "../../../shared/contextReport.ts";

// `ContextMeter.svelte` over the real chat module and settings views: the chip reads the open chat's
// newest valid `generationInfo.context`, else the newest legacy token counts; the popover is
// portaled to the body, positioned from the chip's rectangle (stubbed here: happy-dom has no
// layout), and closed by Escape, an outside pointer, focus leaving, its source disappearing, or
// the chip leaving the viewport. The settings link records a real settings jump.

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import { language } from "src/lang";
import { doingAlert } from "src/ts/alert";
import { currentJump, finishJump, jumpVersion } from "src/ts/setting/settingJump.svelte";
import { INTERACTION_SETTINGS_MENU } from "src/ts/settingsMenu";
import { patchMessage, removeMessages, type ChatRef } from "src/ts/storage/chatStore.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { SettingsMenuIndex, settingsOpen } from "src/ts/stores.svelte";
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

function render(props: { group?: boolean } = {}) {
    mounted.push(mount(ContextMeter, { target, props: { chatRef: ref, group: props.group ?? false, height: "44px" } }));
    flushSync();
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
