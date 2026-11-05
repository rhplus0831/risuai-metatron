// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { historyDigest, type ContextReport } from "../../../shared/contextReport.ts";
import type { MemoryTaskStatus } from "../../../shared/jobs.ts";
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
import { noteMemoryTaskFrame, resetMemoryTasks } from "src/ts/process/memoryTasks.svelte";
import { currentJump, finishJump, jumpVersion } from "src/ts/setting/settingJump.svelte";
import { INTERACTION_SETTINGS_MENU } from "src/ts/settingsMenu";
import { chatBindingPatch } from "src/ts/storage/chatBinding.svelte";
import {
    appendMessage,
    findChat,
    patchMessage,
    removeMessages,
    setChatMeta,
    type ChatRef,
} from "src/ts/storage/chatStore.svelte";
import { activeMainProfile, activePreset, readSettingsRoot, settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { MEMORY_SETTINGS_MENU, SettingsMenuIndex, settingsOpen } from "src/ts/stores.svelte";
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
    // The fixture installs no defaults: the meter settings are set as the server's normalization would.
    settings.ui.contextMeter = true;
    settings.ui.contextMeterTurnUnit = "user";
    settings.ui.contextMeterFixedWarn = 60;
    settings.ui.contextMeterLookahead = true;
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
/** A HypaV3 label/value row's label and value, e.g. `rowText(opened, "next")`. */
const rowText = (opened: Element, name: string) =>
    [...opened.querySelector(`[data-context-meter-${name}]`)!.children].map((cell) => cell.textContent?.trim());
/** A live-update `memoryTask` frame for `chat` (the meter's chat by default); a terminal holds no revision fence. */
function taskFrame(status: MemoryTaskStatus, chat: ChatRef = ref) {
    noteMemoryTaskFrame({ type: "memoryTask", epoch: "e", characterId: chat.chaId, chatId: chat.chatId, status });
    flushSync();
}
const live = (state: "queued" | "running", done = 0, total = 0): MemoryTaskStatus => ({
    taskId: "t1",
    state,
    done,
    total,
});
const ended = (
    state: "done" | "failed" | "cancelled" | "skipped",
    extra: Partial<Extract<MemoryTaskStatus, { terminalRevision: string | null }>> = {},
): MemoryTaskStatus => ({ taskId: "t1", state, done: 8, total: 8, terminalRevision: null, ...extra });
const taskBlock = () => panel()?.querySelector<HTMLElement>("[data-context-meter-task]") ?? null;

beforeEach(() => {
    vi.useFakeTimers();
    resetMemoryTasks();
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

describe("Structured Memory in the context meter", () => {
    it("shows memory tokens and gives uncovered history priority over writer state, falling back to memory-on without a writer", () => {
        install([reply("m1", { context: report() })]);
        render();
        for (const coverage of ["gap", "unknown", "covered"] as const) {
            for (const state of ["recorded", "pending", "failed", "paused", "notAutomatic", undefined] as const) {
                patchMessage(ref, "m1", {
                    generationInfo: {
                        context: report({
                            memory: {
                                kind: "structuredMemory",
                                tokens: 137,
                                coverage,
                                ...(state ? { writer: { state } } : {}),
                            },
                        }),
                    },
                });
                flushSync();
                const word =
                    coverage === "gap"
                        ? language.contextUsage.gap
                        : coverage === "unknown"
                          ? language.structuredMemory.meter.status.unknown
                          : state
                            ? language.structuredMemory.meter.status[state]
                            : language.contextUsage.memoryOn;
                expect(chipText(), `${coverage}/${state}`).toBe(
                    `3 turns · ${language.contextUsage.tokens("137")} · ${word} · 75%`,
                );
            }
        }
    });

    it("reads titles once per structured popover opening and lists included, unverified and left-out items with lane spend and budget", async () => {
        const memory: NonNullable<ContextReport["memory"]> = {
            kind: "structuredMemory",
            coverage: "covered",
            tokens: 137,
            budget: 500,
            items: [
                { id: "same", kind: "event", lane: "flow", tokens: 100, reason: "recent", verified: true },
                { id: "same", kind: "thread", lane: "threads", tokens: 37, reason: "open", verified: false },
            ],
            excluded: [{ id: "omitted", kind: "event", lane: "events", reason: "budget" }],
            excludedTotal: 1,
            lanes: [
                { lane: "flow", spent: 100, target: Number.MAX_SAFE_INTEGER },
                { lane: "threads", spent: 37, target: 80 },
            ],
        };
        mocks.authFetch
            .mockReset()
            .mockResolvedValueOnce(
                Response.json({
                    revision: "r1",
                    pages: [],
                    events: [
                        { id: "same", title: "A promise" },
                        { id: "omitted", title: "Left behind" },
                    ],
                    threads: [{ id: "same", title: "Find the key" }],
                    runs: [],
                }),
            )
            .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
        install([reply("m1", { context: report({ memory }) })]);
        render();
        await settle();
        expect(mocks.authFetch).not.toHaveBeenCalled();
        const opened = await openPanel();
        expect(mocks.authFetch.mock.calls.map(([url]) => url)).toEqual(["/api/memory/structured/c/k"]);
        const rows = () => [...panel()!.querySelectorAll<HTMLElement>("[data-memory-manifest-item]")];
        expect(
            rows().map((row) => [
                row.dataset.memoryManifestItem,
                row.querySelector("[title]")?.getAttribute("title"),
                row.querySelector("[data-memory-manifest-verified]")?.getAttribute("data-memory-manifest-verified"),
            ]),
        ).toEqual([
            ["flow", "A promise", "true"],
            ["threads", "Find the key", "false"],
        ]);
        expect(opened.querySelector('[data-memory-manifest-excluded="budget"]')?.textContent).toContain("Left behind");
        expect(opened.querySelector('[data-memory-manifest-lane="flow"]')?.textContent).toContain("100");
        expect(opened.querySelector('[data-memory-manifest-lane="threads"]')?.textContent).toContain("37 / 80");
        expect(opened.querySelector("[data-context-meter-memory]")?.textContent).toContain("137 / 500");
        patchMessage(ref, "m1", { generationInfo: { context: report({ memory: { ...memory, tokens: 138 } }) } });
        await settle();
        expect(mocks.authFetch).toHaveBeenCalledTimes(1);
        keydown(opened, "Escape");
        patchMessage(ref, "m1", { generationInfo: { context: report({ memory }) } });
        await settle();
        expect(mocks.authFetch).toHaveBeenCalledTimes(1);
        await openPanel();
        expect(mocks.authFetch).toHaveBeenCalledTimes(2);
        expect(rows()).toHaveLength(2);
        expect(rows().every((row) => row.querySelector("span")?.textContent === "")).toBe(true);
        expect(panel()!.textContent).not.toContain("A promise");
        keydown(panel()!, "Escape");
        patchMessage(ref, "m1", {
            generationInfo: { context: report({ memory: { kind: "hypaV3", tokens: 137, coverage: "covered" } }) },
        });
        await openPanel();
        expect(mocks.authFetch).toHaveBeenCalledTimes(2);
        expect(panel()!.querySelector("[data-memory-manifest]")).toBeNull();
    });
});

describe("the chip", () => {
    it("shows the kept count and the share of the prompt budget while all eligible history was kept", () => {
        install([reply("m1", { inputTokens: 600, maxContext: 1000, context: report() })]);
        render();
        expect(chipText()).toBe("3 turns · 75%");
        expect(chip()!.classList.contains("text-danger-500")).toBe(false);
        expect(chip()!.getAttribute("aria-label")).toBe(
            language.contextUsage.chipLabel(language.contextUsage.fullSummary(75)),
        );
    });

    it("shows the kept count in the turn unit once history was trimmed, and follows the unit setting", () => {
        install([reply("m1", { context: trimmed() })]);
        render();
        expect(chipText()).toBe("2 turns · 75%");
        settings.ui.contextMeterTurnUnit = "message";
        flushSync();
        expect(chipText()).toBe("4 messages · 75%");
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
            expect(chipText(), coverage).toBe(`2 turns · ${note} · 75%`);
            expect(chip()!.getAttribute("aria-label"), coverage).toContain(`2 turns, HypaV3 ${note}`);
        }
    });

    it("with memory and no history left out, does not call the history summarized", () => {
        // HypaV3 reports "covered" when no history was trimmed, before any summary exists.
        install([reply("m1", { context: report({ memory: { kind: "hypaV3", tokens: 0, coverage: "covered" } }) })]);
        render();
        expect(chipText()).toBe(`3 turns · ${language.contextUsage.memoryOn} · 75%`);
        expect(chip()!.getAttribute("aria-label")).not.toContain(language.contextUsage.summarized);
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
        expect(chipText()).toBe("3 turns · 73%");
        settings.ui.contextMeterFixedWarn = 59;
        flushSync();
        expect(chipText()).toBe("3 turns · 73% · fixed 60%");
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
        expect(chipText()).toBe("2 turns · 75%");
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
    it("uses the prompt budget in the headline and falls back when the reply consumes it", async () => {
        const s = language.contextUsage;
        install([reply("m1", { context: report() })]);
        render();
        const opened = await openPanel();
        const input = opened.querySelector("span.text-lg.font-semibold")!;
        expect(input.textContent).toBe("600");
        expect(input.nextElementSibling!.textContent?.trim()).toBe(s.inputOfBudget("800", 75));
        const terms = input.parentElement!.nextElementSibling!;
        expect(terms.textContent).toBe(s.budgetFrom("1,000", "200"));
        expect(terms.classList.contains("text-textcolor2")).toBe(true);
        expect(opened.textContent).not.toContain(s.input("600", "1,000"));

        for (const maxResponse of [1000, 1200]) {
            patchMessage(ref, "m1", { generationInfo: { context: report({ maxResponse }) } });
            flushSync();
            expect(opened.querySelector("span.text-lg.font-semibold")).toBeNull();
            expect(opened.textContent).toContain(s.input("600", "1,000"));
            expect(opened.textContent).toContain(s.noBudget);
            expect(opened.textContent).not.toContain(s.budgetFrom("1,000", maxResponse.toLocaleString()));
        }
    });

    it("groups the composition and legend as fixed, memory, history and warns on the fixed share", async () => {
        const s = language.contextUsage;
        const sections: ContextReport["sections"] = [
            { kind: "history", tokens: 400 },
            { kind: "main", tokens: 240 },
            { kind: "memory", tokens: 100 },
            { kind: "description", tokens: 60 },
        ];
        install([reply("m1", { context: report({ sections, input: 820 }) })]);
        render();
        const opened = await openPanel();
        const bar = opened.querySelector("[data-context-meter-bar]")!;
        const segments = () => [...bar.querySelector<HTMLElement>(".h-3")!.children] as HTMLElement[];
        const legend = () =>
            [...bar.nextElementSibling!.children].map((entry) => entry.textContent?.replace(/\s+/g, " ").trim());
        expect(segments().map((segment) => segment.style.width)).toEqual(["37.5%", "12.5%", "50%"]);
        for (const [index, color] of ["bg-neutral-400", "bg-secondary-500", "bg-primary-500"].entries()) {
            expect(segments()[index].classList.contains(color)).toBe(true);
            expect(bar.nextElementSibling!.children[index].firstElementChild!.classList.contains(color)).toBe(true);
        }
        expect(legend()).toEqual([`${s.groups.fixed} 300`, `${s.groups.memory} 100`, `${s.groups.history} 400`]);
        expect(bar.querySelector<HTMLElement>("[data-context-meter-fixed-warn]")!.style.left).toBe("60%");
        expect(opened.querySelector("[data-context-meter-reserve]")).toBeNull();
        const fixed = opened.querySelector("[data-context-meter-fixed]")!;
        expect(fixed.textContent?.trim()).toBe(s.fixedShare(38));
        expect(fixed.classList.contains("text-danger-500")).toBe(false);
        expect(fixed.querySelector('[aria-hidden="true"]')).toBeNull();
        for (const row of opened.querySelectorAll<HTMLElement>("[data-context-meter-sections] li")) {
            const color =
                row.dataset.section === "memory"
                    ? "bg-secondary-500"
                    : row.dataset.section === "history"
                      ? "bg-primary-500"
                      : "bg-neutral-400";
            expect(row.firstElementChild!.classList.contains(color), row.dataset.section).toBe(true);
        }

        settings.ui.contextMeterFixedWarn = 37;
        flushSync();
        expect(segments()[0].classList.contains("bg-danger-500")).toBe(true);
        expect(bar.nextElementSibling!.firstElementChild!.firstElementChild!.classList.contains("bg-danger-500")).toBe(
            true,
        );
        expect(fixed.classList.contains("text-danger-500")).toBe(true);
        expect(fixed.textContent?.replace(/\s+/g, " ").trim()).toBe(`${s.fixedShare(38)} ${s.fixedShareOver(37)}`);
        expect(bar.querySelector<HTMLElement>("[data-context-meter-fixed-warn]")!.style.left).toBe("37%");
        for (const kind of ["main", "description"]) {
            const dot = opened.querySelector(
                `[data-context-meter-sections] [data-section="${kind}"]`,
            )!.firstElementChild!;
            expect(dot.classList.contains("bg-neutral-400"), `${kind} keeps the fixed group's neutral color`).toBe(
                true,
            );
        }

        // Empty groups contribute neither a segment nor a legend entry.
        patchMessage(ref, "m1", {
            generationInfo: {
                context: report({
                    sections: [sections[1], sections[3], { kind: "memory", tokens: 0 }, { kind: "history", tokens: 0 }],
                    input: 300,
                    adjustment: 0,
                }),
            },
        });
        flushSync();
        expect(segments().map((segment) => segment.style.width)).toEqual(["37.5%"]);
        expect(legend()).toEqual([`${s.groups.fixed} 300`]);
    });

    it("ends the composition with unused HypaV3 reserve and scales its warning tick to fit it", async () => {
        const s = language.contextUsage;
        const sections: ContextReport["sections"] = [
            { kind: "history", tokens: 400 },
            { kind: "main", tokens: 300 },
            { kind: "memory", tokens: 100 },
        ];
        const memory = { kind: "hypaV3", tokens: 100, reserved: 500, summarizeIn: 100, coverage: "covered" } as const;
        install([reply("m1", { context: report({ sections, input: 800, adjustment: 0, memory }) })]);
        render();
        const opened = await openPanel();
        const bar = opened.querySelector("[data-context-meter-bar]")!;
        const track = bar.querySelector<HTMLElement>(".h-3")!;
        const reserve = bar.querySelector<HTMLElement>("[data-context-meter-reserve]")!;
        // Scale = max(800, 700 + max(500, 100)) = 1,200; unused reserve = 400.
        expect(
            [...track.children].slice(0, 3).map((segment) => parseFloat((segment as HTMLElement).style.width)),
        ).toEqual([25, (100 / 1200) * 100, (400 / 1200) * 100]);
        expect(track.children).toHaveLength(5);
        expect(parseFloat(reserve.style.width)).toBeCloseTo((400 / 1200) * 100);
        expect(track.lastElementChild).toBe(reserve);
        expect(reserve.previousElementSibling!.classList.contains("grow")).toBe(true);
        expect(bar.nextElementSibling!.lastElementChild!.textContent?.replace(/\s+/g, " ").trim()).toBe(
            `${s.legendReserveEmpty} 400`,
        );
        expect(bar.querySelector<HTMLElement>("[data-context-meter-fixed-warn]")!.style.left).toBe("40%");
        expect(bar.querySelector("[data-context-meter-summarize], [data-context-meter-lookahead]")).toBeNull();

        // Memory already larger than its reservation leaves no empty reserve and uses the sent amount in the scale.
        patchMessage(ref, "m1", {
            generationInfo: {
                context: report({ sections, input: 800, adjustment: 0, memory: { ...memory, reserved: 50 } }),
            },
        });
        flushSync();
        expect(reserve.style.width).toBe("0%");
        expect((track.firstElementChild as HTMLElement).style.width).toBe("37.5%");
        expect(bar.querySelector<HTMLElement>("[data-context-meter-fixed-warn]")!.style.left).toBe("60%");
        expect(bar.nextElementSibling!.textContent).not.toContain(s.legendReserveEmpty);

        patchMessage(ref, "m1", {
            generationInfo: {
                context: report({
                    sections,
                    input: 800,
                    adjustment: 0,
                    memory: { kind: "hypaV2", tokens: 100, coverage: "covered" },
                }),
            },
        });
        flushSync();
        expect(bar.querySelector("[data-context-meter-reserve]")).toBeNull();
        expect(track.children).toHaveLength(3);
    });

    it("explains the signed counting difference below the sections and omits it at zero", async () => {
        const s = language.contextUsage;
        install([reply("m1", { context: report() })]);
        render();
        const opened = await openPanel();
        for (const [adjustment, signed] of [
            [20, "+20"],
            [-70, "−70"],
        ] as const) {
            patchMessage(ref, "m1", { generationInfo: { context: report({ adjustment, input: 580 + adjustment }) } });
            flushSync();
            const line = opened.querySelector("[data-context-meter-other]")!;
            expect(line.textContent?.trim()).toBe(s.otherLine(signed));
            expect(line.getAttribute("title")).toBe(s.otherHelp);
            expect(line.classList.contains("text-textcolor2")).toBe(true);
            expect(opened.querySelector("[data-context-meter-sections]")!.nextElementSibling).toBe(line);
            expect(opened.querySelector('[data-context-meter-sections] [data-section="other"]')).toBeNull();
        }
        patchMessage(ref, "m1", { generationInfo: { context: report({ adjustment: 0, input: 580 }) } });
        flushSync();
        expect(opened.querySelector("[data-context-meter-other]")).toBeNull();
    });

    it("orders the history explanation before its runway and removes hidden lookahead from the scale", async () => {
        const s = language.contextUsage;
        const sections: ContextReport["sections"] = [
            { kind: "main", tokens: 100 },
            { kind: "history", tokens: 400 },
            { kind: "memory", tokens: 50 },
        ];
        const memory = {
            kind: "hypaV3",
            tokens: 50,
            budget: 200,
            reserved: 200,
            summarizeIn: 100,
            lookaheadIn: 400,
            summarized: 1,
            coverage: "gap",
        } as const;
        install([reply("m1", { context: trimmed({ sections, input: 550, adjustment: 0, memory }) })]);
        render();
        const opened = await openPanel();
        const history = opened.querySelector("[data-context-meter-history]")!;
        const order = ["kept", "total", "omitted", "omitted-tags", "runway", "next-lookahead", "next", "memory"];
        for (let i = 1; i < order.length; i++) {
            const before = history.querySelector(`[data-context-meter-${order[i - 1]}]`)!;
            const after = history.querySelector(`[data-context-meter-${order[i]}]`)!;
            expect(
                before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
                `${order[i - 1]} before ${order[i]}`,
            ).toBeTruthy();
        }
        const runway = history.querySelector<HTMLElement>("[data-context-meter-runway]")!;
        expect(runway.previousElementSibling!.textContent).toContain(s.runwayCaption);
        expect(runway.previousElementSibling!.textContent).toContain(s.runwayUsage("400", "100"));
        expect((runway.firstElementChild as HTMLElement).style.width).toBe("50%");
        const summarize = runway.querySelector<HTMLElement>("[data-context-meter-summarize]")!;
        expect(summarize.style.left).toBe("62.5%");
        expect(summarize.classList.contains("border-dashed")).toBe(false);
        const lookahead = runway.querySelector<HTMLElement>("[data-context-meter-lookahead]")!;
        expect(lookahead.style.left).toBe("100%");
        expect(lookahead.classList.contains("border-dashed")).toBe(true);
        expect(rowText(history, "next-lookahead")).toEqual([s.lookaheadLabel, s.tokensAway("400")]);
        expect(rowText(history, "next")).toEqual([s.summarizeInLabel, s.tokensAway("100")]);
        expect(history.querySelector("[data-context-meter-memory] .h-2")).toBeNull();

        settings.ui.contextMeterLookahead = false;
        flushSync();
        expect(runway.querySelector("[data-context-meter-lookahead]")).toBeNull();
        expect(history.querySelector("[data-context-meter-next-lookahead]")).toBeNull();
        expect((runway.firstElementChild as HTMLElement).style.width).toBe("80%");
        expect(summarize.style.left).toBe("100%");

        // Both thresholds at zero describe the current boundary, rather than the prompt composition.
        settings.ui.contextMeterLookahead = true;
        patchMessage(ref, "m1", {
            generationInfo: {
                context: trimmed({
                    sections,
                    input: 550,
                    adjustment: 0,
                    memory: { ...memory, summarizeIn: 0, lookaheadIn: 0 },
                }),
            },
        });
        flushSync();
        expect((runway.firstElementChild as HTMLElement).style.width).toBe("100%");
        expect(summarize.style.left).toBe("100%");
        expect(runway.querySelector<HTMLElement>("[data-context-meter-lookahead]")!.style.left).toBe("100%");
        expect(rowText(history, "next-lookahead")).toEqual([s.lookaheadLabel, s.lookaheadPassed]);
        expect(rowText(history, "next")).toEqual([s.summarizeInLabel, s.nextSend]);
        settings.ui.contextMeterLookahead = false;
        flushSync();
        expect(summarize.style.left).toBe("100%");
    });

    it("puts ready summaries in the next label and links the unused reserve note to memory settings", async () => {
        const s = language.contextUsage;
        const memory = {
            kind: "hypaV3",
            tokens: 50,
            budget: 200,
            reserved: 200,
            summarizeIn: 70,
            prepared: 3,
            coverage: "covered",
        } as const;
        const sections: ContextReport["sections"] = [
            { kind: "main", tokens: 130 },
            { kind: "history", tokens: 400 },
            { kind: "memory", tokens: 50 },
        ];
        install([reply("m1", { context: trimmed({ sections, memory }) })]);
        render();
        const opened = await openPanel();
        const next = opened.querySelector("[data-context-meter-next]")!;
        const prepared = next.querySelector("[data-context-meter-prepared]")!;
        expect(rowText(opened, "next")).toEqual([s.preparedInLabel(3), s.tokensAway("70")]);
        expect(prepared.getAttribute("title")).toBe(s.preparedHelp);
        expect(opened.querySelector("dl, [data-context-meter-prepared-help]")).toBeNull();
        expect(opened.querySelector("[data-context-meter-lookahead], [data-context-meter-next-lookahead]")).toBeNull();
        const link = () => opened.querySelector<HTMLButtonElement>("[data-context-meter-memory-settings]");
        expect(link()!.parentElement!.textContent).toContain(s.memoryReserveNote("200"));
        expect(next.compareDocumentPosition(link()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(
            link()!.compareDocumentPosition(opened.querySelector("[data-context-meter-memory]")!) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();

        patchMessage(ref, "m1", {
            generationInfo: { context: trimmed({ sections, memory: { ...memory, prepared: 0, reserved: 50 } }) },
        });
        flushSync();
        expect(next.querySelector("[data-context-meter-prepared]")).toBeNull();
        expect(rowText(opened, "next")).toEqual([s.summarizeInLabel, s.tokensAway("70")]);
        expect(link()).toBeNull();
        expect(opened.textContent).not.toContain(s.memoryReserveNote("50"));

        patchMessage(ref, "m1", { generationInfo: { context: trimmed({ sections, memory }) } });
        flushSync();
        link()!.click();
        flushSync();
        expect(panel()).toBeNull();
        expect(get(settingsOpen)).toBe(true);
        expect(get(SettingsMenuIndex)).toBe(MEMORY_SETTINGS_MENU);
    });

    it("keeps lore to its budget row until rejections need a danger bar and details", async () => {
        const s = language.contextUsage;
        const lore = { budgetUsed: 75, budget: 100, rejectedCount: 0, rejectedTokens: 0, active: 2 };
        install([reply("m1", { context: report({ lore }) })]);
        render();
        const opened = await openPanel();
        const block = opened.querySelector("[data-context-meter-lore]")!;
        expect(block.children).toHaveLength(1);
        expect(block.textContent?.replace(/\s+/g, " ").trim()).toBe(`${s.loreBudget} 75 / 100`);
        expect(block.querySelector('[aria-hidden="true"]')).toBeNull();
        expect(block.querySelector("[data-context-meter-lore-toggle]")).toBeNull();

        setChatMeta(ref, { loreBudgetWarnOff: true });
        flushSync();
        expect(block.querySelector('[aria-hidden="true"]')).toBeNull();
        expect(block.textContent).toContain(s.loreWarnOffNote);
        expect(block.querySelector("[data-context-meter-lore-toggle]")!.textContent?.trim()).toBe(s.loreWarnOn);

        patchMessage(ref, "m1", {
            generationInfo: {
                context: report({
                    lore: {
                        ...lore,
                        rejectedCount: 3,
                        rejectedTokens: 80,
                        rejected: [{ name: "Old war", tokens: 30 }],
                    },
                }),
            },
        });
        flushSync();
        const fill = block.querySelector<HTMLElement>('[aria-hidden="true"] > div')!;
        expect(fill.classList.contains("bg-danger-300")).toBe(true);
        expect(fill.style.width).toBe("75%");
        expect(block.textContent).toContain(s.loreRejected(3, "80"));
        expect(block.querySelector("[data-context-meter-lore-rejected]")).not.toBeNull();
        expect(block.textContent).toContain(s.loreRejectedMore(2));

        patchMessage(ref, "m1", { generationInfo: { context: report({ lore }) } });
        flushSync();
        expect(block.querySelector('[aria-hidden="true"], [data-context-meter-lore-rejected]')).toBeNull();
        expect(block.textContent).not.toContain(s.loreRejected(3, "80"));
    });

    it("opens the meter settings from the header button whose accessible label explains the basis", async () => {
        const s = language.contextUsage;
        install([reply("m1", { context: report() })]);
        render();
        const opened = await openPanel();
        const button = opened.querySelector<HTMLButtonElement>("[data-context-meter-settings]")!;
        expect(button.getAttribute("aria-label")).toBe(s.basis(s.basisTurns, 60));
        expect(button.getAttribute("title")).toBe(s.basis(s.basisTurns, 60));
        expect(button.nextElementSibling!.textContent?.trim()).toBe(s.close);
        expect(button.parentElement!.parentElement!.querySelector("h2")).not.toBeNull();
        expect(opened.textContent).not.toContain(s.basis(s.basisTurns, 60));

        settings.ui.contextMeterTurnUnit = "message";
        settings.ui.contextMeterFixedWarn = 45;
        flushSync();
        expect(button.getAttribute("aria-label")).toBe(s.basis(s.basisMessages, 45));
        expect(button.getAttribute("title")).toBe(s.basis(s.basisMessages, 45));
        button.click();
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

    it("opens focused and lists the sections largest first, with the counting difference outside the list", async () => {
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
        ]);
        expect(opened.querySelector("[data-context-meter-other]")!.textContent?.trim()).toBe(
            language.contextUsage.otherLine("+20"),
        );
        // The bar has one segment per group with tokens: the fixed sections and the history, no memory.
        expect(opened.querySelector('[aria-hidden="true"].h-3')!.children.length).toBe(2);
        expect(opened.querySelector("[data-context-meter-reserve]")).toBeNull();
        expect(opened.textContent).not.toContain(language.contextUsage.approximate);
        expect(opened.querySelector("[data-context-meter-omitted]")).toBeNull();
        expect(opened.querySelector("[data-context-meter-lore]")).toBeNull();
    });

    it("shows a negative adjustment with its sign, the approximate note, and the omitted history", async () => {
        install([reply("m1", { context: trimmed({ adjustment: -15, attributionExact: false }) })]);
        render();
        const opened = await openPanel();
        expect(sectionRows().at(-1)).toEqual([
            "description",
            `${language.contextUsage.sections.description} 30 tokens 4%`,
        ]);
        expect(opened.querySelector("[data-context-meter-other]")!.textContent?.trim()).toBe(
            language.contextUsage.otherLine("−15"),
        );
        expect(opened.textContent).toContain(language.contextUsage.approximate);
        expect(opened.querySelector("[data-context-meter-omitted]")!.textContent).toBe(
            language.contextUsage.historyOmitted(2, "300"),
        );
        // Without memory the report gives no reason for what it left out: no tag.
        expect(opened.querySelector("[data-context-meter-omitted-tags]")).toBeNull();
        // The setting's unit leads, the other in parentheses; the totals sit under them.
        expect(opened.querySelector("[data-context-meter-kept]")!.textContent).toBe(
            language.contextUsage.historySent(2, 4, "user"),
        );
        expect(opened.querySelector("[data-context-meter-total]")!.textContent).toBe(
            language.contextUsage.historyTotal(3, 6, "user"),
        );
    });

    it("reads a zero prompt budget as 100% and says so", async () => {
        install([reply("m1", { context: report({ maxContext: 1000, maxResponse: 1000, input: 600 }) })]);
        render();
        expect(chipText()).toBe("3 turns · 100% · fixed 100%");
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
        // A report written before entries were named lists none.
        expect(lore.querySelector("[data-context-meter-lore-rejected]")).toBeNull();
    });

    it("warns on the chip of left-out lore, names the entries, and turns the warning off in this chat", async () => {
        install([
            reply("m1", {
                context: report({
                    lore: {
                        budgetUsed: 90,
                        budget: 100,
                        rejectedCount: 10,
                        rejectedTokens: 500,
                        rejected: [
                            { name: "Far kingdom", tokens: 60 },
                            { name: "Old war", tokens: 40 },
                        ],
                        active: 3,
                    },
                }),
            }),
        ]);
        render();
        const warned = () => chip()!.querySelector("[data-context-meter-lore-warn]") !== null;
        expect(warned()).toBe(true);
        expect(chip()!.getAttribute("aria-label")).toContain(language.contextUsage.loreWarnSummary(10));
        const opened = await openPanel();
        const lore = opened.querySelector("[data-context-meter-lore]")!;
        const named = () =>
            [...lore.querySelectorAll("[data-context-meter-lore-rejected] li")].map((row) =>
                row.textContent!.replace(/\s+/g, " ").trim(),
            );
        expect(named()).toEqual([
            "Far kingdom 60 tokens",
            "Old war 40 tokens",
            language.contextUsage.loreRejectedMore(8),
        ]);
        const toggle = () => lore.querySelector<HTMLButtonElement>("[data-context-meter-lore-toggle]")!;
        expect(toggle().textContent!.trim()).toBe(language.contextUsage.loreWarnOff);

        toggle().click();
        flushSync();
        expect(findChat(ref)!.loreBudgetWarnOff).toBe(true);
        expect(warned()).toBe(false);
        expect(chip()!.getAttribute("aria-label")).not.toContain(language.contextUsage.loreWarnSummary(10));
        // The popover still lists the entries and offers the warning back.
        expect(named()).toHaveLength(3);
        expect(lore.textContent).toContain(language.contextUsage.loreWarnOffNote);
        expect(toggle().textContent!.trim()).toBe(language.contextUsage.loreWarnOn);

        toggle().click();
        flushSync();
        expect(Object.hasOwn(findChat(ref)!, "loreBudgetWarnOff")).toBe(false);
        expect(warned()).toBe(true);
    });

    it("keeps the way back while the warning is off, even when the last request used no lore", async () => {
        install([reply("m1", { context: report() })]);
        render();
        const lore = async () => (await openPanel()).querySelector("[data-context-meter-lore]");
        expect(await lore()).toBeNull();
        chip()!.click();
        flushSync();

        setChatMeta(ref, { loreBudgetWarnOff: true });
        flushSync();
        const block = (await lore())!;
        expect(block.textContent).toContain(language.contextUsage.loreWarnOffNote);
        block.querySelector<HTMLButtonElement>("[data-context-meter-lore-toggle]")!.click();
        flushSync();
        expect(Object.hasOwn(findChat(ref)!, "loreBudgetWarnOff")).toBe(false);
    });

    it("shows the HypaV3 budget row only with a budget, else the memory line, with the coverage text", async () => {
        install([reply("m1", { context: trimmed({ memory: { kind: "hypaV3", tokens: 300, coverage: "gap" } }) })]);
        render();
        let opened = await openPanel();
        let memory = opened.querySelector("[data-context-meter-memory]")!;
        expect(memory.textContent).toContain(language.contextUsage.memoryLine("HypaV3", "300"));
        expect(opened.querySelector("[data-context-meter-coverage]")!.textContent).toBe(
            language.contextUsage.coverageGap,
        );
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
        expect(opened.querySelector("[data-context-meter-coverage]")!.textContent).toBe(
            language.contextUsage.coverageCovered,
        );
        // What was left out is a fact about the past: it sits under the totals, before the memory.
        const omittedLine = opened.querySelector("[data-context-meter-omitted]")!;
        expect(omittedLine.compareDocumentPosition(memory) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("leaves out the coverage text when no history was left out", async () => {
        install([reply("m1", { context: report({ memory: { kind: "hypaV3", tokens: 0, coverage: "covered" } }) })]);
        render();
        const opened = await openPanel();
        expect(opened.querySelector("[data-context-meter-memory]")).not.toBeNull();
        expect(opened.querySelector("[data-context-meter-coverage]")).toBeNull();
        expect(opened.textContent).not.toContain(language.contextUsage.coverageCovered);
    });

    it("shows the reported budget reductions in the chip, summary and memory breakdown only while present", async () => {
        const s = language.contextUsage;
        const memory = { kind: "hypaV3", tokens: 50, budget: 400, coverage: "covered" } as const;
        const budgetReduced = [
            { field: "memory", configured: 6000, applied: 400 },
            { field: "headroom", configured: 2000, applied: 0 },
            { field: "extra", configured: 1000, applied: 400 },
        ] satisfies NonNullable<ContextReport["memory"]>["budgetReduced"];
        const lines = budgetReduced.map(({ field, configured, applied }) =>
            s.budgetReducedValue(s.budgetReducedFields[field], configured.toLocaleString(), applied.toLocaleString()),
        );
        install([reply("m1", { context: trimmed({ memory }) })]);
        render();
        const opened = await openPanel();
        const absent = () => {
            expect(chip()!.querySelector("[data-context-meter-memory-reduced]")).toBeNull();
            expect(chipText()).not.toContain(s.memoryReduced);
            for (const attribute of ["aria-label", "title"]) {
                expect(chip()!.getAttribute(attribute)).not.toContain(s.memoryReducedSummary);
            }
            expect(opened.querySelector("[data-context-meter-budget-reduced]")).toBeNull();
            expect(opened.textContent).not.toContain(s.budgetReducedNote);
            for (const line of lines) {
                expect(opened.textContent).not.toContain(line);
            }
        };
        absent();

        patchMessage(ref, "m1", {
            generationInfo: { context: trimmed({ memory: { ...memory, budgetReduced } }) },
        });
        flushSync();
        const mark = chip()!.querySelector("[data-context-meter-memory-reduced]")!;
        expect(mark).not.toBeNull();
        expect(mark.textContent?.trim()).toBe(s.memoryReduced);
        expect(mark.classList.contains("text-danger-500")).toBe(true);
        for (const attribute of ["aria-label", "title"]) {
            expect(chip()!.getAttribute(attribute)).toContain(s.memoryReducedSummary);
        }
        const block = opened.querySelector("[data-context-meter-memory] [data-context-meter-budget-reduced]")!;
        expect(block).not.toBeNull();
        expect(block.classList.contains("text-danger-500")).toBe(true);
        expect([...block.children].map((line) => line.textContent?.trim())).toEqual([s.budgetReducedNote, ...lines]);

        patchMessage(ref, "m1", { generationInfo: { context: trimmed({ memory }) } });
        flushSync();
        absent();
    });

    it("splits the history left out into summarized and unsummarized tags, replacing the coverage sentence", async () => {
        const memory = {
            kind: "hypaV3" as const,
            tokens: 50,
            budget: 200,
            coverage: "gap" as const,
            summarized: 1,
            reserved: 200,
            summarizeIn: 70,
            lookaheadIn: 20,
        };
        const sections: ContextReport["sections"] = [
            { kind: "main", tokens: 100 },
            { kind: "history", tokens: 400 },
            { kind: "description", tokens: 30 },
            { kind: "memory", tokens: 50 },
        ];
        install([reply("m1", { context: trimmed({ sections, memory }) })]);
        render();
        let opened = await openPanel();
        const tags = () =>
            [...opened.querySelectorAll("[data-context-meter-omitted-tags] [data-tone]")].map((tag) => [
                tag.getAttribute("data-tone"),
                tag.textContent,
            ]);
        // One of the two messages left out is summarized, the other is not.
        expect(opened.querySelector("[data-context-meter-omitted]")!.textContent).toBe(
            language.contextUsage.historyOmitted(2, "300"),
        );
        expect(tags()).toEqual([
            ["memory", language.contextUsage.omittedSummarized(1)],
            ["warn", language.contextUsage.omittedUnsummarized(1)],
        ]);
        // The split replaces the coverage sentence.
        expect(opened.querySelector("[data-context-meter-coverage]")).toBeNull();
        expect(opened.textContent).not.toContain(language.contextUsage.coverageGap);
        chip()!.click();
        flushSync();

        // Every message left out is summarized: one tag.
        patchMessage(ref, "m1", {
            generationInfo: { context: trimmed({ sections, memory: { ...memory, summarized: 2 } }) },
        });
        flushSync();
        opened = await openPanel();
        expect(tags()).toEqual([["memory", language.contextUsage.omittedSummarized(2)]]);
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
        expect(chipText()).toBe("3 turns · 75%");
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

/** The chip's text with a live task's mark after the memory word, just before the percentage that ends `plain`. */
const withTask = (plain: string, word: string) => {
    const at = plain.lastIndexOf(" · ");
    return at < 0 ? `${word} · ${plain}` : `${plain.slice(0, at)} · ${word}${plain.slice(at)}`;
};

describe("the background summary task", () => {
    const hypaReport = () => trimmed({ memory: { kind: "hypaV3", tokens: 300, coverage: "gap" } });

    it("puts a running writer in place of a pending or recorded memory word, and after any other word", () => {
        install([reply("m1", { context: report() })]);
        render();
        const s = language.contextUsage;
        const tokens = s.tokens("137");
        const running = s.writerTask.running(4, 23);
        taskFrame({ ...live("running", 4, 23), kind: "structuredMemory" });
        for (const state of ["recorded", "pending", "failed", "paused", "notAutomatic"] as const) {
            patchMessage(ref, "m1", {
                generationInfo: {
                    context: report({
                        memory: { kind: "structuredMemory", tokens: 137, coverage: "covered", writer: { state } },
                    }),
                },
            });
            flushSync();
            const word = language.structuredMemory.meter.status[state];
            expect(chipText(), state).toBe(
                state === "recorded" || state === "pending"
                    ? `3 turns · ${tokens} · ${running} · 75%`
                    : `3 turns · ${tokens} · ${word} · ${running} · 75%`,
            );
            expect(chip()!.getAttribute("aria-label"), state).toContain(word);
        }
    });

    it("words a writer task's chip, label, and popover as recording", async () => {
        install([reply("m1", { context: hypaReport() })]);
        render();
        const plain = chipText();
        const s = language.contextUsage;
        const writer = s.writerTask;
        const expectWriterBlock = (tone: string, ...notes: string[]) => {
            const block = taskBlock()!;
            expect(block.dataset.tone).toBe(tone);
            for (const text of [writer.title, ...notes]) {
                expect(block.textContent).toContain(text);
            }
            for (const text of [
                s.taskTitle,
                s.taskQueued,
                s.taskRunning(3, 8),
                s.taskRunningUnknown,
                s.taskLiveNote,
                s.taskDone,
                s.taskFailed,
            ]) {
                expect(block.textContent).not.toContain(text);
            }
        };

        for (const [status, word, summaryWord] of [
            [live("queued"), writer.queued, s.taskQueued],
            [live("running"), writer.runningUnknown, s.taskRunningUnknown],
            [live("running", 3, 8), writer.running(3, 8), s.taskRunning(3, 8)],
        ] as const) {
            taskFrame({ ...status, kind: "structuredMemory" });
            expect(chipText()).toBe(withTask(plain!, word));
            expect(chip()!.getAttribute("aria-label")).toContain(s.taskSummary(word));
            expect(chip()!.getAttribute("aria-label")).not.toContain(s.taskSummary(summaryWord));
            if (!panel()) await openPanel();
            expectWriterBlock("live", word, writer.liveNote);
        }

        taskFrame(ended("done", { kind: "structuredMemory", lastCommittedRevision: "r2" }));
        expect(chipText()).toBe(plain);
        expectWriterBlock("done", writer.done);

        taskFrame({ ...live("running", 3, 8), kind: "structuredMemory", taskId: "t2" });
        taskFrame({ ...ended("failed", { kind: "structuredMemory", error: "upstream 429" }), taskId: "t2" });
        expect(chipText()).toBe(plain);
        expectWriterBlock("failed", writer.failed);
    });

    it("marks the line while the chat's task is queued or runs, with its count once the total is known", () => {
        install([reply("m1", { context: hypaReport() })]);
        render();
        const plain = chipText();
        expect(target.querySelector("[data-context-meter-task-mark]")).toBeNull();

        taskFrame(live("queued"));
        expect(chipText()).toBe(withTask(plain!, language.contextUsage.taskQueued));
        expect(chip()!.getAttribute("aria-label")).toContain(
            `; ${language.contextUsage.taskSummary(language.contextUsage.taskQueued)}`,
        );
        taskFrame(live("running"));
        expect(chipText()).toBe(withTask(plain!, language.contextUsage.taskRunningUnknown));
        taskFrame(live("running", 3, 8));
        expect(chipText()).toBe(withTask(plain!, language.contextUsage.taskRunning(3, 8)));
        expect(chip()!.getAttribute("aria-label")).toContain(
            language.contextUsage.taskSummary(language.contextUsage.taskRunning(3, 8)),
        );

        taskFrame(ended("cancelled"));
        expect(chipText()).toBe(plain);
        expect(chip()!.getAttribute("aria-label")).not.toContain(language.contextUsage.taskSummary(""));
    });

    it("ignores another chat's task", () => {
        install([reply("m1", { context: hypaReport() })]);
        render();
        const plain = chipText();
        taskFrame(live("running", 1, 4), { chaId: "c", chatId: "other" });
        expect(chipText()).toBe(plain);
    });

    it("shows the running task in the popover, above the last reply's breakdown", async () => {
        install([reply("m1", { context: hypaReport() })]);
        render();
        taskFrame(live("running", 3, 8));
        const opened = await openPanel();
        const block = taskBlock()!;
        expect(block.dataset.tone).toBe("live");
        expect(block.textContent).toContain(language.contextUsage.taskRunning(3, 8));
        expect(block.textContent).toContain(language.contextUsage.taskLiveNote);
        // Before the headline, so it does not read as part of the report.
        expect(
            block.compareDocumentPosition(opened.querySelector("[data-context-meter-headline]")!) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        taskFrame(live("running", 4, 8));
        expect(taskBlock()!.textContent).toContain(language.contextUsage.taskRunning(4, 8));
    });

    it("after a task it saw run commits, says the summaries are stored until the report changes", async () => {
        install([reply("m1", { context: hypaReport() })]);
        render();
        taskFrame(live("running", 3, 8));
        taskFrame(ended("done", { terminalRevision: null, lastCommittedRevision: "r2" }));
        expect(target.querySelector("[data-context-meter-task-mark]")).toBeNull();
        await openPanel();
        expect(taskBlock()!.dataset.tone).toBe("done");
        expect(taskBlock()!.textContent).toContain(language.contextUsage.taskDone);

        appendMessage(ref, reply("m2", { context: hypaReport() }) as any);
        flushSync();
        expect(taskBlock()).toBeNull();
        // The newer reply ended the notice: removing it does not bring the notice back.
        removeMessages(ref, ["m2"]);
        flushSync();
        expect(taskBlock()).toBeNull();
    });

    it("ends the notice when a continue rewrites the same reply's report", async () => {
        install([reply("m1", { context: hypaReport() })]);
        render();
        taskFrame(live("running", 3, 8));
        taskFrame(ended("done", { lastCommittedRevision: "r2" }));
        await openPanel();
        expect(taskBlock()!.dataset.tone).toBe("done");
        patchMessage(ref, "m1", { generationInfo: { context: hypaReport() } });
        flushSync();
        expect(taskBlock()!.dataset.tone).toBe("done");
        patchMessage(ref, "m1", {
            generationInfo: {
                context: trimmed({ input: 700, memory: { kind: "hypaV3", tokens: 300, coverage: "gap" } }),
            },
        });
        flushSync();
        expect(taskBlock()).toBeNull();
    });

    it("says nothing of a finished task it did not see run, or one that committed nothing", async () => {
        install([reply("m1", { context: hypaReport() })]);
        render();
        taskFrame(ended("done", { lastCommittedRevision: "r2" }));
        await openPanel();
        expect(taskBlock()).toBeNull();

        taskFrame({ ...live("running", 0, 2), taskId: "t2" });
        taskFrame({ ...ended("done"), taskId: "t2" });
        expect(taskBlock()).toBeNull();
    });

    it("reports a failed task with its error and a way to the memory settings", async () => {
        install([reply("m1", { context: hypaReport() })]);
        render();
        taskFrame(ended("failed", { error: "upstream 429" }));
        expect(target.querySelector("[data-context-meter-task-mark]")).toBeNull();
        await openPanel();
        const block = taskBlock()!;
        expect(block.dataset.tone).toBe("failed");
        expect(block.textContent).toContain(language.contextUsage.taskFailed);
        expect(block.querySelector("[data-context-meter-task-error]")!.textContent).toBe("upstream 429");
        block.querySelector<HTMLButtonElement>("[data-context-meter-task-settings]")!.click();
        flushSync();
        expect(get(settingsOpen)).toBe(true);
        expect(get(SettingsMenuIndex)).toBe(MEMORY_SETTINGS_MENU);
        expect(panel()).toBeNull();
    });

    it("shows on a legacy fallback too", async () => {
        install([reply("m1", { inputTokens: 600, maxContext: 1000 })]);
        render();
        taskFrame(live("queued"));
        expect(chipText()).toBe(`${language.contextUsage.taskQueued} · 60%`);
        await openPanel();
        expect(taskBlock()!.dataset.tone).toBe("live");
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
        const close = [...opened.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === language.contextUsage.close,
        )!;
        close.click();
        flushSync();
        expect(panel()).toBeNull();
        expect(document.activeElement).toBe(chip());
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

    it("stands down the displacement estimate when Structured Memory is selected even with every legacy flag off", async () => {
        autoCount = byLength;
        installEstimate(QUEUE);
        settings.ui.memoryAlgorithmType = "structuredMemory";
        const props = render({ draft: "d".repeat(10) });
        await vi.advanceTimersByTimeAsync(400);
        await settle();
        expect(texts()).toEqual([]);
        expect(suffix()).toBeNull();
        await openPanel();
        expect(block()).toBeNull();
        props.draft = "changed draft";
        await vi.advanceTimersByTimeAsync(400);
        expect(texts()).toEqual([]);
        // The same report is otherwise eligible; changing the algorithm releases the estimate.
        settings.ui.memoryAlgorithmType = "none";
        await settle();
        expect(texts()).toEqual([REPLY, "changed draft"]);
        expect(suffix()).not.toBeNull();
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
