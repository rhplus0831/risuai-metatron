// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Slice 4 of `docs/plan/split-preset.md`: `botpreset.svelte` lists either preset kind. The model
// list selects, adds, copies, and removes model presets (a copy keeps its profile references; the
// model preset holds no key since `docs/plan/model-profiles.md` O2) and never touches the prompt
// presets; the prompt-only actions (export, import, comparison, the Ctrl+1..9 numbers) stay on the
// prompt list.

const mocks = vi.hoisted(() => ({
    confirm: vi.fn(),
    error: vi.fn(),
}));

vi.mock("src/ts/alert", () => ({
    alertConfirm: mocks.confirm,
    alertError: mocks.error,
    alertNormal: vi.fn(),
    alertInput: vi.fn(),
    alertMd: vi.fn(),
}));
// Reached through `stores.svelte.ts` and the preset functions' import path; nothing under test needs them.
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn(), globalFetch: vi.fn() }));

import { MODEL_PRESET_DEFAULT_NAME, normalizeModelPreset, normalizeModelProfile } from "../../../shared/presets.ts";
import { settings, activePreset, activeModelPreset, activeMainProfile } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { selectModelPreset, selectPreset } from "src/ts/storage/selection.svelte";
import Botpreset from "./botpreset.svelte";

const mounted: ReturnType<typeof mount>[] = [];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function render(kind: "prompt" | "model") {
    const close = vi.fn();
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(Botpreset, { target, props: { kind, close } }));
    flushSync();
    const rows = () => [...target.querySelectorAll<HTMLButtonElement>("button[draggable]")];
    const rowNamed = (name: string) => {
        const row = rows().find((entry) => entry.textContent?.includes(name));
        expect(row, `Expected a row named ${name}`).toBeDefined();
        return row!;
    };
    const icon = (root: Element, name: string) => root.querySelector<HTMLElement>(`.lucide-${name}`)?.parentElement;
    return { target, close, rows, rowNamed, icon };
}

beforeEach(() => {
    installFlatDatabase({
        characters: [],
        useLegacyGUI: false,
        showPromptComparison: true,
        botPresets: [
            { id: "p1", name: "Prompt One", temperature: 80 },
            { id: "p2", name: "Prompt Two", temperature: 50 },
        ],
        modelPresets: [
            normalizeModelPreset({ name: "Model One", mainSlot: { profileId: "gpt" } }, { id: "m1" }),
            normalizeModelPreset({ name: "Model Two", mainSlot: { profileId: "claude" } }, { id: "m2" }),
        ],
        modelProfiles: [
            normalizeModelProfile({ id: "gpt", name: "GPT", modelId: "gpt4o" }),
            normalizeModelProfile({ id: "claude", name: "Claude", modelId: "claude" }),
        ],
    } as any);
    selectPreset("p1");
    selectModelPreset("m1");
});

afterEach(() => {
    for (const instance of mounted.splice(0)) {
        unmount(instance);
    }
    document.body.innerHTML = "";
    vi.clearAllMocks();
});

describe("the model preset list", () => {
    it("lists the model presets with the selected one marked, without the prompt-only actions", () => {
        const list = render("model");
        expect(list.rows().map((row) => row.textContent?.trim())).toEqual(["Model One", "Model Two"]);
        expect(list.rowNamed("Model One").classList.contains("bg-selected")).toBe(true);
        expect(list.target.querySelector("h2")?.textContent).toBe("Model Presets");
        for (const prompt of ["share-2", "hard-drive-upload", "git-compare"]) {
            expect(list.target.querySelector(`.lucide-${prompt}`), prompt).toBeNull();
        }
    });

    it("selects a model preset on click and leaves the prompt preset selected", () => {
        const list = render("model");
        list.rowNamed("Model Two").click();
        flushSync();
        expect(activeModelPreset.id).toBe("m2");
        expect(activeMainProfile.modelId).toBe("claude");
        expect(activePreset.id).toBe("p1");
        expect(list.close).toHaveBeenCalledTimes(1);
    });

    it("adds a default model preset, and copies one with its profile references", () => {
        const list = render("model");
        list.icon(list.target, "plus")!.click();
        flushSync();
        expect(settings.modelPresets.map((preset) => preset.name)).toEqual([
            "Model One",
            "Model Two",
            MODEL_PRESET_DEFAULT_NAME,
        ]);

        list.icon(list.rowNamed("Model Two"), "copy")!.click();
        flushSync();
        const copy = settings.modelPresets[3];
        expect(copy.name).toBe("Model Two Copy");
        expect(copy.mainSlot).toEqual({ profileId: "claude" });
        expect(settings.modelProfiles).toHaveLength(2);
        expect(settings.presets).toHaveLength(2);
        expect(list.close).not.toHaveBeenCalled();
    });

    it("removes a model preset after the dialog, reselecting, but never the last one", async () => {
        const list = render("model");
        mocks.confirm.mockResolvedValueOnce(true);
        list.icon(list.rowNamed("Model One"), "trash")!.click();
        await settle();
        flushSync();
        expect(settings.modelPresets.map((preset) => preset.id)).toEqual(["m2"]);
        expect(activeModelPreset.id).toBe("m2");
        expect(settings.presets).toHaveLength(2);

        list.icon(list.rowNamed("Model Two"), "trash")!.click();
        await settle();
        expect(mocks.error).toHaveBeenCalledTimes(1);
        expect(mocks.confirm).toHaveBeenCalledTimes(1);
        expect(settings.modelPresets.map((preset) => preset.id)).toEqual(["m2"]);
    });

    it("renames a model preset in edit mode", () => {
        const list = render("model");
        list.icon(list.target, "pencil")!.click();
        flushSync();
        const input = list.target.querySelector<HTMLInputElement>("input")!;
        input.value = "Renamed";
        input.dispatchEvent(new Event("input"));
        flushSync();
        expect(settings.modelPresets[0].name).toBe("Renamed");
        expect(settings.presets[0].name).toBe("Prompt One");
    });
});

describe("the prompt preset list", () => {
    it("keeps the prompt actions and selects only the prompt preset", () => {
        const list = render("prompt");
        expect(list.target.querySelector("h2")?.textContent).toBe("Prompt Presets");
        expect(list.rows().map((row) => row.textContent?.replace(/\s+/g, " ").trim())).toEqual([
            "1 Prompt One",
            "2 Prompt Two",
        ]);
        for (const prompt of ["share-2", "hard-drive-upload", "git-compare"]) {
            expect(list.target.querySelector(`.lucide-${prompt}`), prompt).not.toBeNull();
        }
        list.rowNamed("Prompt Two").click();
        flushSync();
        expect(activePreset.id).toBe("p2");
        expect(activeModelPreset.id).toBe("m1");
    });
});
