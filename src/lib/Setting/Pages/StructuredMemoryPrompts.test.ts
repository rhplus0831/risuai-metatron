// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { alertConfirm, alertToast } from "src/ts/alert";
import { authFetch } from "src/ts/storage/serverAuth";
import { runServerJob } from "src/ts/process/serverCommands";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { selectChat } from "src/ts/storage/chatStore.svelte";
import { normalizeStructuredMemorySettings } from "../../../../shared/structuredMemory.ts";
import StructuredMemoryPrompts from "./StructuredMemoryPrompts.svelte";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock(),
);
vi.mock("src/ts/process/serverCommands", async () =>
    (await import("src/ts/process/tests/serverCommandsMock")).createServerCommandsMock(),
);

const defaults = {
    analysis: {
        frame: "<|im_start|>user<|im_sep|>{{slot::messages}} {{slot::scene}}<|im_end|>",
        format: "Analysis JSON",
        rules: "Analysis rules",
    },
    patch: {
        frame: "<|im_start|>user<|im_sep|>{{slot::cast}} {{slot::previous}}<|im_end|>",
        format: "Patch JSON",
        rules: "Patch rules",
    },
};
let target: HTMLDivElement;
let instance: ReturnType<typeof mount>;
const text = language.structuredMemory.settings;
async function settle() {
    for (let i = 0; i < 80; i++) {
        await Promise.resolve();
        flushSync();
    }
    await vi.advanceTimersByTimeAsync(0);
}
const checkbox = () => target.querySelector<HTMLInputElement>("input[type=checkbox]")!;
const button = (selector: string) => target.querySelector(selector)!.closest("button")!;
function open(overrides = {}) {
    const state = writable(normalizeStructuredMemorySettings(overrides));
    const reactive = fromStore(state);
    const props = {
        get structured() {
            return reactive.current;
        },
        presetId: "memory",
        setStructured(change: (value: ReturnType<typeof normalizeStructuredMemorySettings>) => void) {
            state.update((value) => {
                const next = { ...value };
                change(next);
                return next;
            });
        },
    };
    instance = mount(StructuredMemoryPrompts, { target, props });
    flushSync();
    return props;
}
beforeEach(() => {
    vi.useFakeTimers();
    installFlatDatabaseWithChats({
        characters: [{ chaId: "c", name: "C", type: "character", chats: [{ id: "k", message: [] }] }],
    });
    selectCharacter(null);
    vi.mocked(alertConfirm).mockReset().mockResolvedValue(false);
    vi.mocked(alertToast).mockClear();
    vi.mocked(runServerJob).mockReset();
    vi.mocked(authFetch)
        .mockReset()
        .mockImplementation(async (url) => {
            expect(url).toBe("/api/memory/structured/default-prompts");
            return Response.json(defaults);
        });
    target = document.createElement("div");
    document.body.append(target);
});
afterEach(async () => {
    if (instance) await unmount(instance);
    target.remove();
    vi.useRealTimers();
});

it("warns before enabling, seeds only blank prompts, and keeps edited text when disabled", async () => {
    const props = open({ analysisPrompt: " ", patchPrompt: "Keep my patch" });
    checkbox().click();
    await settle();
    expect(alertConfirm).toHaveBeenCalledWith(text.fineTuningConfirm);
    expect(props.structured.fineTuning).toBe(false);
    expect(checkbox().checked).toBe(false);
    expect(authFetch).not.toHaveBeenCalled();
    expect(target.querySelectorAll("textarea")).toHaveLength(0);
    vi.mocked(alertConfirm).mockResolvedValue(true);
    checkbox().click();
    await settle();
    expect(props.structured).toMatchObject({
        fineTuning: true,
        analysisPrompt: defaults.analysis.frame,
        patchPrompt: "Keep my patch",
    });
    const areas = [...target.querySelectorAll("textarea")];
    expect(areas.map((area) => area.value)).toEqual([defaults.analysis.frame, "Keep my patch"]);
    areas[0].value = "Edited analysis";
    areas[0].dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    checkbox().click();
    await settle();
    expect(props.structured).toMatchObject({
        fineTuning: false,
        analysisPrompt: "Edited analysis",
        patchPrompt: "Keep my patch",
    });
    expect(target.querySelectorAll("textarea")).toHaveLength(0);
    // The other blank field is seeded too, while non-blank analysis survives re-enabling.
    props.setStructured((next) => {
        next.patchPrompt = " ";
    });
    checkbox().click();
    await settle();
    expect(props.structured).toMatchObject({
        fineTuning: true,
        analysisPrompt: "Edited analysis",
        patchPrompt: defaults.patch.frame,
    });
});

it("leaves fine-tuning off with an explanation when defaults cannot be read and displays defaults as text", async () => {
    const props = open();
    vi.mocked(alertConfirm).mockResolvedValue(true);
    vi.mocked(authFetch).mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status: 503 }));
    checkbox().click();
    await settle();
    expect(props.structured.fineTuning).toBe(false);
    expect(checkbox().checked).toBe(false);
    expect(target.querySelector("[data-structured-memory-defaults-failure]")?.textContent).toContain(
        text.fineTuningDefaultsUnavailable,
    );
    button("[data-structured-memory-view-default]").click();
    await settle();
    const shown = [...target.querySelectorAll("pre")].map((node) => node.textContent);
    expect(shown).toEqual([
        defaults.analysis.frame,
        defaults.analysis.format,
        defaults.analysis.rules,
        defaults.patch.frame,
        defaults.patch.format,
        defaults.patch.rules,
    ]);
});

it("tests only an open chat, reports followed and lost results, and renders the test outcome and model data as text", async () => {
    open();
    const run = () => button("[data-structured-memory-test-run]");
    expect(run().disabled).toBe(true);
    selectCharacter("c");
    selectChat("c", "k");
    flushSync();
    expect(run().disabled).toBe(false);
    vi.mocked(runServerJob).mockResolvedValue({ outcome: "followed", terminal: null });
    run().click();
    await settle();
    expect(runServerJob).toHaveBeenLastCalledWith(
        expect.objectContaining({ chaId: "c" }),
        { chaId: "c", chatId: "k" },
        { kind: "command", command: { type: "memoryTest" }, label: "memoryTest", context: { mode: "manual" } },
    );
    expect(alertToast).toHaveBeenLastCalledWith(language.structuredMemory.receipt.busy);
    vi.mocked(runServerJob).mockResolvedValue({
        outcome: "started",
        terminal: { type: "done", epoch: "e", revision: "r" },
    });
    run().click();
    await settle();
    expect(alertToast).toHaveBeenLastCalledWith(text.testLost);
    const analysis = { event: { title: "<img src=x onerror=alert(1)>" } };
    const patches = [{ body: "<script>alert(1)</script>" }];
    vi.mocked(runServerJob).mockResolvedValue({
        outcome: "started",
        terminal: {
            type: "done",
            epoch: "e",
            revision: "r",
            result: {
                kind: "memoryTest",
                outcome: "recorded",
                customPrompt: true,
                analysis,
                patches,
                patchCalled: true,
                slots: { analysis: { unquoted: ["rules"], unknown: ["typo"] } },
            },
        },
    });
    run().click();
    await settle();
    const result = target.querySelector('[data-structured-memory-test-result="recorded"]')!;
    const resultLines = [...result.querySelectorAll("span")].map((node) => node.textContent);
    expect(resultLines).toContain(`${text.testResult.outcome}: ${text.testResult.outcomes.recorded}`);
    expect(resultLines).not.toContain(`${text.testResult.outcome}: ${language.structuredMemory.log.results.recorded}`);
    expect(target.querySelector("[data-memory-test-analysis]")?.textContent).toBe(JSON.stringify(analysis, null, 2));
    expect(target.querySelector("[data-memory-test-patches]")?.textContent).toBe(JSON.stringify(patches, null, 2));
    expect(target.querySelector("[data-memory-test-unquoted]")?.textContent).toContain("{{slot::rules}}");
    expect(target.querySelector("[data-memory-test-unknown]")?.textContent).toContain("{{slot::typo}}");
    expect(target.querySelector("img, script")).toBeNull();
});
