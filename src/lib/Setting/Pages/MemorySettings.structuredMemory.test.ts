// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
import { language } from "src/lang";
import { findChat } from "src/ts/storage/chatStore.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import MemorySettings from "./MemorySettings.svelte";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({
        authFetch: vi.fn(async (url, init) => {
            if (url !== "/api/tokens/count") throw new Error(`Unexpected request: ${url}`);
            return Response.json({ counts: JSON.parse(String(init?.body)).texts.map(() => 1) });
        }),
    }),
);

let instance: ReturnType<typeof mount>;
let target: HTMLDivElement;
const savedMemory = { summaries: [{ text: "Keep this", chatMemos: ["old"], isImportant: true }] };
const fields = "input:not(:disabled), select, textarea, [role=slider]";
const text = language.structuredMemory.settings;
const hypa = language.hypaV3Settings;
function selectWith(value: string) {
    const select = [...target.querySelectorAll("select")].find((entry) =>
        [...entry.options].some((option) => option.value === value),
    );
    expect(select, `Selector offering ${value}`).toBeDefined();
    return select!;
}
const change = (control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) => {
    control.value = value;
    if (control instanceof HTMLSelectElement) {
        // happy-dom does not match :checked options, which Svelte's select binding reads.
        const query = control.querySelector.bind(control);
        control.querySelector = ((selector: string) =>
            selector === ":checked"
                ? (control.options[control.selectedIndex] ?? null)
                : query(selector)) as typeof control.querySelector;
    }
    control.dispatchEvent(new Event(control.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    flushSync();
};
function control(label: string): HTMLElement {
    const span = [...target.querySelectorAll("span")].find((s) => s.textContent?.trim() === label);
    expect(span, `Control for ${label}`).toBeDefined();
    const next = span!.nextElementSibling!;
    return (next.matches(fields) ? next : next.querySelector(fields)) as HTMLElement;
}
function mode(value: string) {
    const group = target.querySelector(`[aria-label="${hypa.budgetModeLabel}"]`)!;
    [...group.querySelectorAll("button")].find((b) => b.textContent?.trim() === value)!.click();
    flushSync();
}
function open() {
    instance = mount(MemorySettings, { target });
    flushSync();
}
beforeEach(() => {
    vi.useFakeTimers();
    const preset = createHypaV3Preset("First", { budgetMode: "tokens", structured: { cadence: "everyK" } }, "first");
    const second = createHypaV3Preset("Second", { budgetMode: "tokens", memoryBudgetTokens: 4321 }, "second");
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "c",
                type: "character",
                name: "C",
                chats: ["k", "other"].map((id) => ({ id, message: [], hypaV3Data: structuredClone(savedMemory) })),
            },
        ],
        memoryAlgorithmType: "none",
        supaModelType: "subModel",
        hanuraiEnable: true,
        hypav2: true,
        hypaV3: true,
        hypaV3Presets: [preset, second],
        hypaV3PresetId: "first",
        aiModel: "gpt4o",
        maxContext: 20000,
        maxResponse: 1000,
    });
    target = document.createElement("div");
    document.body.append(target);
});
afterEach(async () => {
    if (instance) await unmount(instance);
    target.remove();
    vi.useRealTimers();
});

it("selects Structured Memory ahead of legacy flags, clears those flags on choice and preserves every chat's HypaV3 data", () => {
    settings.ui.memoryAlgorithmType = "structuredMemory";
    open();
    const algorithm = selectWith("structuredMemory");
    expect(algorithm.value).toBe("structuredMemory");
    // Re-select with old flags still present, as can happen in an imported configuration.
    change(algorithm, "structuredMemory");
    expect(settings.ui.memoryAlgorithmType).toBe("structuredMemory");
    expect(settings.memoryTranslateMedia).toMatchObject({
        supaModelType: "none",
        hanuraiEnable: false,
        hypav2: false,
        hypaV3: false,
    });
    for (const chatId of ["k", "other"]) expect(findChat({ chaId: "c", chatId })!.hypaV3Data).toEqual(savedMemory);
});

it("edits only consumed Structured Memory settings and shares the selected preset's memory budget with HypaV3", async () => {
    settings.ui.memoryAlgorithmType = "structuredMemory";
    open();
    const preset = () => settings.hypaV3Presets.items.find((p) => p.id === settings.hypaV3Presets.selectedId)!.settings;
    const checkbox = () => target.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    const assertControls = (conditional: string | null) => {
        const allowed = [
            selectWith("structuredMemory"),
            selectWith("first"),
            control(text.language),
            control(text.cadence),
            control(preset().budgetMode === "tokens" ? hypa.memoryBudgetTokensLabel : hypa.memoryTokensRatioLabel),
            control(text.windowTurns),
            control(text.flowEvents),
            control(text.requiredCap),
            control(text.pagesTarget),
            control(text.eventsTarget),
            control(text.evidenceTarget),
            control(text.threadsTarget),
            control(text.instructions),
            checkbox(),
            ...(conditional ? [control(conditional)] : []),
        ];
        // Exhaustive editable controls: an unconsumed setting must not acquire an editor here.
        const embedding = [...target.querySelectorAll("span")].find(
            (span) => span.textContent?.trim() === language.embedding,
        )!;
        // Embedding and lore controls below the algorithm section are shared by the whole page.
        const algorithmControls = [...target.querySelectorAll(fields)].filter(
            (node) => !!(node.compareDocumentPosition(embedding) & Node.DOCUMENT_POSITION_FOLLOWING),
        );
        expect(new Set(algorithmControls)).toEqual(new Set(allowed));
    };
    assertControls(text.cadenceTurns);
    change(control(text.language) as HTMLInputElement, "Korean");
    change(control(text.instructions) as HTMLTextAreaElement, "Remember promises.");
    for (const [label, value] of [
        [text.cadenceTurns, 4],
        [text.windowTurns, 3],
        [text.flowEvents, 2],
        [text.requiredCap, 900],
        [text.pagesTarget, 444],
        [text.eventsTarget, 111],
        [text.evidenceTarget, 222],
        [text.threadsTarget, 333],
    ] as const)
        change(control(label) as HTMLInputElement, String(value));
    const wasChecked = checkbox().checked;
    checkbox().click();
    flushSync();
    expect(preset().structured).toMatchObject({
        language: "Korean",
        instructions: "Remember promises.",
        cadence: "everyK",
        cadenceTurns: 4,
        windowTurns: 3,
        flowEvents: 2,
        requiredCap: 900,
        laneTargets: { pages: 444, events: 111, evidence: 222, threads: 333 },
        volatileBeforeLastUser: !wasChecked,
    });
    change(control(hypa.memoryBudgetTokensLabel) as HTMLInputElement, "3456");
    change(control(text.cadence) as HTMLSelectElement, "tokens");
    assertControls(text.cadenceTokens);
    change(control(text.cadenceTokens) as HTMLInputElement, "789");
    expect(preset().structured.cadenceTokens).toBe(789);
    mode(hypa.budgetModeRatio);
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    assertControls(text.cadenceRatio);
    control(hypa.memoryTokensRatioLabel).dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    flushSync();
    control(hypa.memoryTokensRatioLabel).dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    flushSync();
    expect(preset().memoryTokensRatio).toBe(0.01);
    control(text.cadenceRatio).dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    flushSync();
    const ratio = control(text.cadenceRatio);
    ratio.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    flushSync();
    expect(preset().structured.cadenceRatio).toBe(0.02);
    for (const cadence of ["everyTurn", "manual"]) {
        change(control(text.cadence) as HTMLSelectElement, cadence);
        assertControls(null);
        expect(preset().structured.cadence).toBe(cadence);
    }
    mode(hypa.budgetModeTokens);
    expect(preset().memoryBudgetTokens).toBe(3456);
    change(selectWith("structuredMemory"), "hypaV3");
    expect((control(hypa.memoryBudgetTokensLabel) as HTMLInputElement).value).toBe("3456");
    change(selectWith("structuredMemory"), "structuredMemory");
    change(selectWith("first"), "second");
    expect(settings.hypaV3Presets.selectedId).toBe("second");
    expect((control(hypa.memoryBudgetTokensLabel) as HTMLInputElement).value).toBe("4321");
});
