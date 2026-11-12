// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";
import { language } from "src/lang";
import { chatEntry, findChat, selectChat, setChatMeta } from "src/ts/storage/chatStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import MemorySettings from "./MemorySettings.svelte";

const picker = vi.hoisted(() => vi.fn<typeof import("src/ts/util").selectSingleFile>());
vi.mock("src/ts/util", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/util")>()),
    selectSingleFile: picker,
}));

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
    selectCharacter(null);
    picker.mockReset();
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

it("edits only consumed settings in the Structured Memory section and shares the preset's memory budget with HypaV3", async () => {
    settings.ui.memoryAlgorithmType = "structuredMemory";
    open();
    const preset = () => settings.hypaV3Presets.items.find((p) => p.id === settings.hypaV3Presets.selectedId)!.settings;
    const kindBox = (label: string) =>
        [...target.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].find((input) =>
            input.closest("label")?.textContent?.includes(label),
        )!;
    const checkbox = () => kindBox(text.volatileBeforeLastUser);
    const assertControls = (conditional: string | null) => {
        const allowed = [
            selectWith("structuredMemory"),
            selectWith("first"),
            control(text.language),
            control(text.cadence),
            control(preset().budgetMode === "tokens" ? hypa.memoryBudgetTokensLabel : hypa.memoryTokensRatioLabel),
            control(text.windowTurns),
            control(text.flowEvents),
            control(text.flowKeyLineEvents),
            control(text.requiredCap),
            control(text.laneSplit),
            ...(preset().structured.laneSplit === "manual"
                ? [
                      control(text.flowTarget),
                      control(text.pagesTarget),
                      control(text.eventsTarget),
                      control(text.evidenceTarget),
                      control(text.threadsTarget),
                  ]
                : [
                      control(text.flowShare),
                      control(text.pagesShare),
                      control(text.eventsShare),
                      control(text.evidenceShare),
                      control(text.threadsShare),
                  ]),
            control(text.instructions),
            kindBox(text.keyLineGuidance),
            control(text.screeningRefusal),
            control(text.screeningFormat),
            kindBox(text.fineTuning),
            ...(preset().structured.fineTuning ? [control(text.analysisPrompt), control(text.patchPrompt)] : []),
            checkbox(),
            control(text.highlightMode),
            ...Object.values(text.highlightKinds).map(kindBox),
            ...(conditional ? [control(conditional)] : []),
        ];
        // Exhaustive editable controls: an unconsumed setting must not acquire an editor here.
        const hypaV3Section = [...target.querySelectorAll("h3")].find(
            (heading) => heading.textContent?.trim() === language.chatMemory.hypaV3,
        )!;
        // The HypaV3 section, then the embedding and lore controls, follow the Structured Memory section.
        const algorithmControls = [...target.querySelectorAll(fields)].filter(
            (node) => !!(node.compareDocumentPosition(hypaV3Section) & Node.DOCUMENT_POSITION_FOLLOWING),
        );
        expect(new Set(algorithmControls)).toEqual(new Set(allowed));
    };
    assertControls(text.cadenceTurns);
    change(control(text.laneSplit) as HTMLSelectElement, "manual");
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
    preset().structured.fineTuning = true;
    flushSync();
    assertControls(null);
    change(control(text.analysisPrompt) as HTMLTextAreaElement, "<|im_start|>user<|im_sep|>Mine<|im_end|>");
    change(control(text.patchPrompt) as HTMLTextAreaElement, "<|im_start|>user<|im_sep|>Theirs<|im_end|>");
    expect(preset().structured).toMatchObject({
        analysisPrompt: "<|im_start|>user<|im_sep|>Mine<|im_end|>",
        patchPrompt: "<|im_start|>user<|im_sep|>Theirs<|im_end|>",
    });
    preset().structured.fineTuning = false;
    flushSync();
    assertControls(null);
    mode(hypa.budgetModeTokens);
    expect(preset().memoryBudgetTokens).toBe(3456);
    change(selectWith("structuredMemory"), "hypaV3");
    expect((control(hypa.memoryBudgetTokensLabel) as HTMLInputElement).value).toBe("3456");
    change(selectWith("structuredMemory"), "structuredMemory");
    change(selectWith("first"), "second");
    expect(settings.hypaV3Presets.selectedId).toBe("second");
    expect((control(hypa.memoryBudgetTokensLabel) as HTMLInputElement).value).toBe("4321");
});

it("enables key-line guidance in the selected preset when its checkbox is ticked", () => {
    settings.ui.memoryAlgorithmType = "structuredMemory";
    open();
    change(selectWith("first"), "second");
    expect(settings.hypaV3Presets.selectedId).toBe("second");
    const wrapper = target.querySelector("[data-structured-memory-key-line-guidance]");
    expect(wrapper?.textContent).toContain(text.keyLineGuidance);
    expect(target.querySelector("[data-structured-memory-key-line-guidance-help]")?.textContent).toContain(
        text.keyLineGuidanceHelp,
    );
    const checkbox = wrapper!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(false);
    checkbox.click();
    flushSync();
    expect(settings.hypaV3Presets.items.find(({ id }) => id === "second")!.settings.structured.keyLineGuidance).toBe(
        true,
    );
    expect(settings.hypaV3Presets.items.find(({ id }) => id === "first")!.settings.structured.keyLineGuidance).toBe(
        false,
    );
});

it("edits highlight modes, kinds and change grade and drops a stored retract kind on the first tick", () => {
    settings.ui.memoryAlgorithmType = "structuredMemory";
    const preset = () => settings.hypaV3Presets.items.find((p) => p.id === "first")!.settings.structured;
    Object.assign(preset(), { highlightMode: "none", highlightKinds: ["retract"], highlightChangeGrade: 4 });
    open();
    const boxes = () =>
        [...target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter((input) =>
            Object.values(text.highlightKinds).some((label) => input.closest("label")?.textContent?.includes(label)),
        );
    expect(boxes()).toHaveLength(0);
    const otherCheckboxes = target.querySelectorAll('input[type="checkbox"]').length;
    change(control(text.highlightMode) as HTMLSelectElement, "important");
    // Only the four offered kinds gain controls; a persisted retract has no checkbox.
    expect(target.querySelectorAll('input[type="checkbox"]')).toHaveLength(otherCheckboxes + 4);
    expect(preset().highlightMode).toBe("important");
    expect(boxes()).toHaveLength(4);
    expect(
        boxes()
            .map((input) => input.closest("label")!.textContent!.trim())
            .sort(),
    ).toEqual(Object.values(text.highlightKinds).sort());
    for (const kind of ["create", "contradiction", "delete", "change"] as const) {
        const input = boxes().find((input) =>
            input.closest("label")!.textContent!.includes(text.highlightKinds[kind]),
        )!;
        input.click();
        flushSync();
        expect(preset().highlightKinds).toContain(kind);
        expect(preset().highlightKinds).not.toContain("retract");
    }
    change(control(text.highlightChangeGrade) as HTMLInputElement, "5");
    expect(preset().highlightChangeGrade).toBe(5);
    boxes()
        .find((input) => input.closest("label")!.textContent!.includes(text.highlightKinds.change))!
        .click();
    flushSync();
    expect(preset().highlightKinds).toEqual(["create", "contradiction", "delete"]);
    expect(preset().highlightKinds).not.toContain("change");
    expect(target.textContent).not.toContain(text.highlightChangeGrade);
    change(control(text.highlightMode) as HTMLSelectElement, "all");
    expect(preset().highlightMode).toBe("all");
    expect(boxes()).toHaveLength(0);
    expect(preset().highlightKinds).toEqual(["create", "contradiction", "delete"]);
});

it("edits both screening lists by line while preserving a typed newline", () => {
    settings.ui.memoryAlgorithmType = "structuredMemory";
    open();
    const screening = () => settings.hypaV3Presets.items[0].settings.structured.screening;
    for (const [label, key] of [
        [text.screeningRefusal, "refusal"],
        [text.screeningFormat, "format"],
    ] as const) {
        const input = control(label) as HTMLTextAreaElement;
        change(input, "First entry");
        change(input, input.value + "\n");
        expect(input.value).toBe("First entry\n");
        change(input, input.value + "Second entry\n\n   \nThird entry");
        input.dispatchEvent(new Event("change", { bubbles: true }));
        flushSync();
        expect(screening()[key]).toEqual(["First entry", "Second entry", "Third entry"]);
    }
    expect(screening()).toEqual({
        refusal: ["First entry", "Second entry", "Third entry"],
        format: ["First entry", "Second entry", "Third entry"],
    });
    change(control(text.screeningRefusal) as HTMLTextAreaElement, "\n  \n");
    control(text.screeningRefusal).dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(screening().refusal).toEqual([]);
    expect(screening().format).toHaveLength(3);
});

it("edits shares in auto and counts in manual, preserving both across switches", () => {
    settings.ui.memoryAlgorithmType = "structuredMemory";
    open();
    const read = () => settings.hypaV3Presets.items.find(({ id }) => id === "first")!.settings.structured;
    const split = control(text.laneSplit) as HTMLSelectElement;
    const laneInputs = [
        [text.flowTarget, 2401],
        [text.pagesTarget, 0],
        [text.eventsTarget, 111],
        [text.evidenceTarget, 222],
        [text.threadsTarget, 333],
    ] as const;
    const shareInputs = [
        [text.flowShare, 25, 30],
        [text.pagesShare, 45, 100],
        [text.eventsShare, 15, 0],
        [text.evidenceShare, 10, 20],
        [text.threadsShare, 5, 7],
    ] as const;
    const visible = (label: string) =>
        [...target.querySelectorAll("span")].some((s) => s.textContent?.trim() === label);
    const assertAuto = (column: 1 | 2, total: number) => {
        expect(split.value).toBe("auto");
        for (const [label] of laneInputs) expect(visible(label)).toBe(false);
        for (const row of shareInputs) {
            const input = control(row[0]) as HTMLInputElement;
            expect(split.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            expect([input.type, input.min, input.max, input.value]).toEqual([
                "number",
                "0",
                "100",
                String(row[column]),
            ]);
        }
        expect(target.textContent).toContain(text.laneSharesHelp(total));
        for (const label of [text.flowEvents, text.flowKeyLineEvents, text.requiredCap]) {
            expect(control(label).isConnected).toBe(true);
        }
    };
    assertAuto(1, 100);
    for (const [label, , value] of shareInputs) change(control(label) as HTMLInputElement, String(value));
    // Out of range or fractional percents leave the stored share as it was.
    const laneShares = { flow: 30, pages: 100, events: 0, evidence: 20, threads: 7 };
    for (const value of ["101", "-1", "2.5"]) {
        change(control(text.threadsShare) as HTMLInputElement, value);
        expect(read()).toMatchObject({ laneSplit: "auto", laneShares });
    }
    change(control(text.threadsShare) as HTMLInputElement, "7");
    assertAuto(2, 157);
    change(split, "manual");
    for (const [label] of shareInputs) expect(visible(label)).toBe(false);
    expect(target.querySelector("[data-structured-memory-lane-shares]")).toBeNull();
    for (const [label, value] of laneInputs) {
        const input = control(label) as HTMLInputElement;
        expect(split.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        change(input, String(value));
    }
    for (const [label, value] of [
        [text.flowEvents, 6],
        [text.flowKeyLineEvents, 2],
        [text.requiredCap, 731],
    ] as const)
        change(control(label) as HTMLInputElement, String(value));
    const expected = {
        laneTargets: { flow: 2401, pages: 0, events: 111, evidence: 222, threads: 333 },
        laneShares,
        flowEvents: 6,
        flowKeyLineEvents: 2,
        requiredCap: 731,
    };
    expect(read()).toMatchObject({ laneSplit: "manual", ...expected });
    change(split, "auto");
    assertAuto(2, 157);
    expect(read()).toMatchObject({ laneSplit: "auto", ...expected });
    change(split, "manual");
    expect(read()).toMatchObject({ laneSplit: "manual", ...expected });
    for (const [label, value] of laneInputs) expect((control(label) as HTMLInputElement).value).toBe(String(value));
});

it("writes the flow token target and key-line event count through their count inputs", () => {
    settings.ui.memoryAlgorithmType = "structuredMemory";
    open();
    const read = () => settings.hypaV3Presets.items.find(({ id }) => id === "first")!.settings.structured;
    change(control(text.laneSplit) as HTMLSelectElement, "manual");
    const flow = control(text.flowTarget) as HTMLInputElement;
    const keyLines = control(text.flowKeyLineEvents) as HTMLInputElement;
    expect(flow.value).toBe("1500");
    expect(keyLines.value).toBe("3");
    for (const input of [flow, keyLines]) {
        expect(input.type).toBe("number");
        expect(input.min).toBe("0");
    }
    change(flow, "2400");
    change(keyLines, "5");
    expect(read()).toMatchObject({ laneTargets: { flow: 2400 }, flowKeyLineEvents: 5 });
    change(flow, "0");
    change(keyLines, "0");
    expect(read()).toMatchObject({ laneTargets: { flow: 0 }, flowKeyLineEvents: 0 });
});

it("shows each lane's target against the maximum a send applies, following the shares, the split and a reduced budget", () => {
    settings.ui.memoryAlgorithmType = "structuredMemory";
    open();
    const fmt = (value: number) => value.toLocaleString();
    const amount = (lane: string) =>
        target.querySelector(`[data-structured-memory-lane="${lane}"] [data-structured-memory-lane-amount]`)!
            .textContent;
    const width = (lane: string) =>
        parseFloat(target.querySelector<HTMLElement>(`[data-structured-memory-lane-part="${lane}"]`)!.style.width);
    const maximum = () => target.querySelector("[data-structured-memory-lane-maximum]")!.textContent;
    // The preset's 6000 tokens fit half of the prompt budget (20000 - 1000), so they apply whole.
    expect(maximum()).toBe(text.laneMaximum(fmt(6000)));
    expect(["flow", "pages", "events", "evidence", "threads"].map(amount)).toEqual(
        [1500, 2700, 900, 600, 300].map((tokens) => text.laneTokens(fmt(tokens))),
    );
    expect(["flow", "pages", "events", "evidence", "threads"].map(width)).toEqual([25, 45, 15, 10, 5]);
    // Over 100% the bar holds the sum, so every part stays in proportion.
    change(control(text.flowShare) as HTMLInputElement, "50");
    expect(amount("flow")).toBe(text.laneTokens(fmt(3000)));
    expect(width("flow")).toBeCloseTo(40);
    expect(width("pages")).toBeCloseTo(36);
    // A budget over half of the prompt budget is reduced, and the lanes divide what is applied.
    change(control(hypa.memoryBudgetTokensLabel) as HTMLInputElement, "50000");
    expect(maximum()).toBe(text.laneMaximum(fmt(9500)));
    expect(amount("flow")).toBe(text.laneTokens(fmt(4750)));
    change(control(text.laneSplit) as HTMLSelectElement, "manual");
    expect(amount("flow")).toBe(text.laneOfMaximum(16));
    change(control(text.flowTarget) as HTMLInputElement, "4750");
    expect(amount("flow")).toBe(text.laneOfMaximum(50));
    // Counts under the maximum are drawn against it, leaving the rest of the bar empty.
    expect(width("flow")).toBeCloseTo(50);
});

it("draws the recent timeline from the window, the flow target and both event counts, and marks an empty part off", () => {
    settings.ui.memoryAlgorithmType = "structuredMemory";
    open();
    const part = (name: string) =>
        [...target.querySelector(`[data-structured-memory-timeline-part="${name}"]`)!.children].map((line) =>
            line.textContent!.trim(),
        );
    const strip = text.timeline;
    const tokens = (value: number) => text.laneTokens(value.toLocaleString());
    expect(part("window")).toEqual([strip.window, strip.windowValue(3)]);
    expect(part("full")).toEqual([strip.full, strip.fullValue(tokens(1500)), strip.keyLines(3)]);
    expect(part("titles")).toEqual([strip.titles, strip.titlesValue(8)]);
    change(control(text.windowTurns) as HTMLInputElement, "5");
    change(control(text.flowKeyLineEvents) as HTMLInputElement, "0");
    change(control(text.flowEvents) as HTMLInputElement, "0");
    change(control(text.flowShare) as HTMLInputElement, "40");
    expect(part("window")).toEqual([strip.window, strip.windowValue(5)]);
    expect(part("full")).toEqual([strip.full, strip.fullValue(tokens(2400))]);
    expect(part("titles")).toEqual([strip.titles, strip.off]);
    // A share of 0 leaves the title-only lane, whatever the key-line count says.
    change(control(text.flowKeyLineEvents) as HTMLInputElement, "4");
    change(control(text.flowShare) as HTMLInputElement, "0");
    expect(part("full")).toEqual([strip.full, strip.fullOff]);
    change(control(text.laneSplit) as HTMLSelectElement, "manual");
    expect(part("full")).toEqual([strip.full, strip.fullValue(tokens(1500)), strip.keyLines(4)]);
});

it.each(["supaMemory", "structuredMemory"])(
    "edits HypaV3 preset and Structured Memory controls under global %s",
    (algorithm) => {
        open();
        change(selectWith("structuredMemory"), algorithm);
        const preset = () => settings.hypaV3Presets.items.find(({ id }) => id === "first")!.settings;
        expect(selectWith("first").value).toBe("first");
        change(control(hypa.memoryBudgetTokensLabel) as HTMLInputElement, "2345");
        expect(preset().memoryBudgetTokens).toBe(2345);
        change(control(hypa.maxChatsPerSummaryLabel) as HTMLInputElement, "8");
        expect(preset().maxChatsPerSummary).toBe(8);
        change(control(text.windowTurns) as HTMLInputElement, "7");
        expect(preset().structured.windowTurns).toBe(7);
        expect(selectWith("structuredMemory").value).toBe(algorithm);
        expect(settings.ui.memoryAlgorithmType).toBe(algorithm);
    },
);

it("shows and edits the open chat's stored preset while preserving the Settings preset", () => {
    const ref = { chaId: "c", chatId: "k" };
    setChatMeta(ref, { memoryPresetId: "second" });
    selectCharacter("c");
    selectChat("c", "k");
    open();
    expect(selectWith("first").value).toBe("second");
    expect(target.querySelector("[data-chat-memory-preset-note]")?.textContent).toBe(
        language.chatMemory.editingChatPreset,
    );
    expect((control(hypa.memoryBudgetTokensLabel) as HTMLInputElement).value).toBe("4321");
    change(control(hypa.memoryBudgetTokensLabel) as HTMLInputElement, "2345");
    change(control(text.windowTurns) as HTMLInputElement, "7");
    expect(settings.hypaV3Presets.items.find(({ id }) => id === "second")!.settings).toMatchObject({
        memoryBudgetTokens: 2345,
        structured: { windowTurns: 7 },
    });
    expect(settings.hypaV3Presets.items.find(({ id }) => id === "first")!.settings).toMatchObject({
        memoryBudgetTokens: 6000,
        structured: { windowTurns: 3 },
    });
    expect(settings.hypaV3Presets.selectedId).toBe("first");
    expect(chatEntry(ref)).toHaveProperty("memoryPresetId", "second");
});

it.each(["existing", "absent", "deleted", "home"] as const)(
    "routes preset selection, Create and Import for an %s chat preset to the proper owner",
    async (state) => {
        const ref = { chaId: "c", chatId: "k" };
        const other = { chaId: "c", chatId: "other" };
        if (state === "existing" || state === "deleted")
            setChatMeta(ref, { memoryPresetId: state === "existing" ? "second" : "gone" });
        if (state !== "home") {
            selectCharacter("c");
            selectChat("c", "k");
        }
        open();
        const owns = state === "existing";
        expect(selectWith("first").value).toBe(owns ? "second" : "first");
        expect(!!target.querySelector("[data-chat-memory-preset-note]")).toBe(owns);
        const assertSelection = (id: string) => {
            expect(settings.hypaV3Presets.selectedId).toBe(owns ? "first" : id);
            if (owns) expect(chatEntry(ref)).toHaveProperty("memoryPresetId", id);
            else if (state === "deleted") expect(chatEntry(ref)).toHaveProperty("memoryPresetId", "gone");
            else expect(chatEntry(ref)).not.toHaveProperty("memoryPresetId");
        };
        change(selectWith("first"), owns ? "first" : "second");
        assertSelection(owns ? "first" : "second");
        const button = (icon: string) => {
            const result = [...target.querySelectorAll("button")].find((entry) => entry.querySelector(`.${icon}`));
            expect(result).toBeDefined();
            return result!;
        };
        button("lucide-plus").click();
        flushSync();
        const created = settings.hypaV3Presets.items.at(-1)!;
        expect(created.name).toBe("New Preset");
        expect(created.id).not.toBe("first");
        expect(created.id).not.toBe("second");
        assertSelection(created.id);
        let answer!: (file: { name: string; data: Uint8Array }) => void;
        picker.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    answer = resolve;
                }),
        );
        button("lucide-hard-drive-upload").click();
        expect(picker).toHaveBeenCalledOnce();
        // Selection can move while the chooser is open; Import keeps the target that opened it.
        setChatMeta(other, { memoryPresetId: "second" });
        selectCharacter("c");
        selectChat("c", "other");
        flushSync();
        answer({
            name: "memory.json",
            data: new TextEncoder().encode(
                JSON.stringify({
                    type: "risu",
                    ver: 1,
                    data: { name: "Imported memory", settings: { memoryBudgetTokens: 1234 } },
                }),
            ),
        });
        for (let i = 0; i < 10; i++) {
            await Promise.resolve();
            flushSync();
        }
        const imported = settings.hypaV3Presets.items.at(-1)!;
        expect(imported.name).toBe("Imported memory");
        expect(imported.id).not.toBe(created.id);
        assertSelection(imported.id);
        expect(chatEntry(other)).toHaveProperty("memoryPresetId", "second");
    },
);
