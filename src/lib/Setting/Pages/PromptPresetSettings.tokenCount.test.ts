// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import { language } from "src/lang";
import { activePreset } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import PromptPresetSettings from "./PromptPresetSettings.svelte";

const mocks = vi.hoisted(() => ({ authFetch: vi.fn<typeof import("src/ts/storage/serverAuth").authFetch>() }));
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: mocks.authFetch }),
);

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement | undefined;
afterEach(async () => {
    if (component) await unmount(component);
    target?.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
});

it("counts the three legacy prompt fields when shown and debounces their edited counts", async () => {
    vi.useFakeTimers();
    installFlatDatabase({
        aiModel: "gpt-3.5-turbo",
        useTokenizerCaching: false,
        useLegacyGUI: false,
        promptTemplate: null,
        mainPrompt: "Describe the scene.",
        jailbreak: "Stay in character.",
        globalNote: "Remember the moon.",
        formatingOrder: [],
        characters: [],
    });

    const counts: Record<string, number> = {
        "Describe the scene.": 11,
        "Stay in character.": 23,
        "Remember the moon.": 37,
        "Describe the forest.": 41,
        "Stay in the forest.": 43,
        "Remember the stars.": 47,
    };
    mocks.authFetch.mockImplementation(async (path, init) => {
        expect(path).toBe("/api/tokens/count");
        const { texts } = JSON.parse(String(init?.body)) as { texts: string[] };
        return Response.json({ counts: texts.map((text) => counts[text]) });
    });

    target = document.createElement("div");
    document.body.append(target);
    component = mount(PromptPresetSettings, { target });
    flushSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.authFetch).not.toHaveBeenCalled();

    [...target.querySelectorAll("button")].find((button) => button.textContent.trim() === language.prompt)!.click();
    flushSync();
    await vi.advanceTimersByTimeAsync(0);
    flushSync();
    const inputs = [...target.querySelectorAll("textarea")];
    expect(inputs.map((input) => input.value)).toEqual([
        "Describe the scene.",
        "Stay in character.",
        "Remember the moon.",
    ]);
    const shownCounts = () => inputs.map((input) => input.parentElement!.nextElementSibling!.textContent.trim());
    expect(shownCounts()).toEqual([11, 23, 37].map((count) => `${count} ${language.tokens}`));
    mocks.authFetch.mockClear();

    const edit = (texts: string[]) => {
        inputs.forEach((input, index) => {
            input.value = texts[index];
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        flushSync();
    };
    edit(["Intermediate main", "Intermediate jailbreak", "Intermediate note"]);
    await vi.advanceTimersByTimeAsync(200);
    edit(["Describe the forest.", "Stay in the forest.", "Remember the stars."]);
    await vi.advanceTimersByTimeAsync(399);
    expect(mocks.authFetch).not.toHaveBeenCalled();
    expect(shownCounts()).toEqual([11, 23, 37].map((count) => `${count} ${language.tokens}`));

    await vi.advanceTimersByTimeAsync(1);
    await vi.runOnlyPendingTimersAsync();
    flushSync();
    expect(shownCounts()).toEqual([41, 43, 47].map((count) => `${count} ${language.tokens}`));
    expect([activePreset.mainPrompt, activePreset.jailbreak, activePreset.globalNote]).toEqual([
        "Describe the forest.",
        "Stay in the forest.",
        "Remember the stars.",
    ]);
});
