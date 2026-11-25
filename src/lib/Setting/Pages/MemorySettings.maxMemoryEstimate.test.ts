// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHypaV3Preset } from "../../../../shared/hypaV3Presets.ts";

// The ratio-mode estimate of the room the max context leaves for the memory. The settings open from
// the home screen too, where no character is selected: the estimate then counts no character tokens
// and the global lore budget, instead of failing (`getCharToken` without a character throws, which
// showed the error line on every visit from home).

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/process/prompt", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/process/prompt")>()),
    tokenizePreset: vi.fn(async () => 100),
}));
vi.mock("src/ts/tokenizer", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/tokenizer")>()),
    getCharToken: vi.fn(async () => ({ persistant: 40, dynamic: 10 })),
}));

import { language } from "src/lang";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { getCharToken } from "src/ts/tokenizer";
import MemorySettings from "./MemorySettings.svelte";

const mounted: ReturnType<typeof mount>[] = [];
const strings = () => language.hypaV3Settings;
const text = (target: HTMLElement) => target.textContent ?? "";

function render(characters: object[]) {
    const preset = createHypaV3Preset("Selected", { budgetMode: "ratio" });
    installFlatDatabaseWithChats({
        characters,
        hypaV3: true,
        hypav2: false,
        hanuraiEnable: false,
        supaModelType: "none",
        useLegacyGUI: false,
        hypaV3Presets: [preset],
        hypaV3PresetId: preset.id,
        aiModel: "gpt-4o",
        subModel: "gpt-4o-mini",
        maxContext: 1000,
        maxResponse: 100,
        loreBookToken: 800,
    } as any);
    const target = document.createElement("div");
    document.body.appendChild(target);
    return target;
}

function open(target: HTMLElement) {
    mounted.push(mount(MemorySettings, { target }));
    flushSync();
}

/** The estimate once its `{#await}` settled: the disabled number input right after its label. */
async function estimate(target: HTMLElement) {
    await vi.waitFor(() => expect(text(target)).toContain(strings().maxMemoryTokensRatioLabel), { timeout: 3000 });
    flushSync();
    const label = [...target.querySelectorAll("span")].find(
        (span) => span.textContent === strings().maxMemoryTokensRatioLabel,
    )!;
    return (label.nextElementSibling as HTMLInputElement).value;
}

beforeEach(() => {
    vi.mocked(getCharToken).mockClear();
});

afterEach(() => {
    for (const instance of mounted.splice(0)) {
        unmount(instance);
    }
    document.body.innerHTML = "";
});

describe("the HypaV3 max memory estimate", () => {
    it("counts no character tokens when no character is selected, instead of showing the error", async () => {
        const target = render([]);
        open(target);
        // (1000 − (100 template + 0 character + 0 lore + 3 × 100 replies)) / 1000.
        expect(await estimate(target)).toBe("0.6");
        expect(text(target)).not.toContain(strings().maxMemoryTokensRatioError);
        expect(getCharToken).not.toHaveBeenCalled();
    });

    it("counts the selected character's tokens within its lore budget", async () => {
        const target = render([
            {
                chaId: "c",
                type: "character",
                name: "C",
                chatPage: 0,
                loreSettings: { tokenBudget: 500 },
                chats: [{ id: "k", name: "K", note: "", localLore: [], message: [] }],
            },
        ]);
        selectCharacter("c");
        flushSync();
        open(target);
        // (1000 − (100 + 40 persistent + min(10 dynamic, 500 lore) + 300)) / 1000.
        expect(await estimate(target)).toBe("0.55");
        expect(getCharToken).toHaveBeenCalledTimes(1);
        expect(vi.mocked(getCharToken).mock.calls[0][0]).toMatchObject({ chaId: "c" });
    });
});
