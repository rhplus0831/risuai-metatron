// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslatorPreset } from "../../../../../shared/translatorPresets.ts";

// Phase 3, slice 4 (Astra challenge point 4): the rename and delete buttons await a dialog, and a
// conflict reload can replace `translatorPresets` (and the selection) meanwhile. The handlers
// capture only the target's id and name before the await and resolve it again afterwards, so they
// edit the live list, never a detached copy. The page selects by id (`translatorPresetId`).

const alerts = vi.hoisted(() => ({
    input: vi.fn(),
    confirm: vi.fn(),
    error: vi.fn(),
    normal: vi.fn(),
}));

vi.mock("src/ts/alert", () => ({
    alertInput: alerts.input,
    alertConfirm: alerts.confirm,
    alertError: alerts.error,
    alertNormal: alerts.normal,
    alertMd: vi.fn(),
}));

// `stores.svelte.ts` wires module updates into a module-level effect, `database.svelte.ts` (reached
// through `process/scripts`) re-exports asset helpers, and the page's file helpers and codec reach
// `util.ts`; nothing under test needs them.
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("src/ts/util", () => ({
    selectSingleFile: vi.fn(),
    decryptBuffer: vi.fn(),
    encryptBuffer: vi.fn(),
    sleep: vi.fn(async () => undefined),
}));

import { language } from "src/lang";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { DEFAULT_MODEL_PROFILE_ID, normalizeModelProfile } from "../../../../../shared/presets.ts";
import { isTranslatorPreset } from "../../../../../shared/translatorPresets.ts";
import TranslatorPresetSettings from "./TranslatorPresetSettings.svelte";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const preset = (id: string, name: string) =>
    createTranslatorPreset(name, { id, prompt: `prompt ${id}`, maxResponse: 10 });

const mounted: ReturnType<typeof mount>[] = [];

function render() {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(TranslatorPresetSettings, { target }));
    flushSync();
    const button = (icon: string) => {
        const element = [...target.querySelectorAll("button")].find((entry) => entry.innerHTML.includes(icon));
        expect(element, `Expected the ${icon} button to be rendered`).toBeDefined();
        return element!;
    };
    return {
        target,
        select: () => target.querySelector("select")!,
        rename: () => button("lucide-pencil"),
        remove: () => button("lucide-trash"),
    };
}

const names = () => settings.translatorPresets.items.map((entry) => entry.name);
const ids = () => settings.translatorPresets.items.map((entry) => entry.id);
const selectedId = () => settings.translatorPresets.selectedId;

/** What a conflict reload does: the list and the selection replaced by the server's copy. */
function reloadFromServer(items: ReturnType<typeof preset>[], selectedId: string) {
    settings.translatorPresets.items = items;
    settings.translatorPresets.selectedId = selectedId;
    flushSync();
}

beforeEach(() => {
    // Installed into the records the way the app installs a boot (its fields moved into the
    // records), since the page reads the records through the settings views (Phase 6 slice 6).
    installFlatDatabase({
        characters: [],
        translatorPresets: [preset("a", "A"), preset("b", "B")],
        translatorPresetId: "a",
        // The connections a step can pick (translation slice 3.1), beside the default one.
        modelProfiles: [
            normalizeModelProfile({}, { id: DEFAULT_MODEL_PROFILE_ID }),
            normalizeModelProfile({ id: "echo", name: "Echo", modelId: "echo_model" }),
            normalizeModelProfile({ id: "spare", name: "Spare", modelId: "gpt-5.5" }),
        ],
    } as any);
});

afterEach(() => {
    for (const instance of mounted.splice(0)) {
        unmount(instance);
    }
    document.body.innerHTML = "";
    vi.clearAllMocks();
});

describe("selection by id", () => {
    it("shows the preset whose id is selected and falls back to the first one when that id is gone", () => {
        const page = render();
        expect(page.select().value).toBe("a");
        settings.translatorPresets.selectedId = "b";
        flushSync();
        expect(page.select().value).toBe("b");
        settings.translatorPresets.selectedId = "deleted elsewhere";
        flushSync();
        expect(page.select().value).toBe("a");
    });
});

describe("rename while the dialog is open", () => {
    it("renames the preset it was opened for after a reload replaced the list and moved the selection", async () => {
        const page = render();
        const dialog = deferred<string>();
        alerts.input.mockReturnValueOnce(dialog.promise);
        page.rename().click();
        expect(alerts.input).toHaveBeenCalledWith("Enter new name for A", [], "A");
        // Another client added C, selected it, and the reload replaced every object.
        reloadFromServer([preset("c", "C"), preset("a", "A")], "c");
        dialog.resolve("A renamed");
        await dialog.promise;
        await tick();
        expect(names()).toEqual(["C", "A renamed"]);
        expect(selectedId()).toBe("c");
        expect(page.select().value).toBe("c");
    });

    it("drops the rename when the preset was deleted meanwhile", async () => {
        const page = render();
        const dialog = deferred<string>();
        alerts.input.mockReturnValueOnce(dialog.promise);
        page.rename().click();
        reloadFromServer([preset("c", "C"), preset("d", "D")], "c");
        dialog.resolve("A renamed");
        await dialog.promise;
        await tick();
        expect(names()).toEqual(["C", "D"]);
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("keeps an empty name out", async () => {
        const page = render();
        alerts.input.mockResolvedValueOnce("   ");
        page.rename().click();
        await tick();
        await tick();
        expect(names()).toEqual(["A", "B"]);
    });
});

describe("delete while the dialog is open", () => {
    it("refuses to delete the last preset before asking", () => {
        settings.translatorPresets.items = [preset("a", "A")];
        const page = render();
        page.remove().click();
        expect(alerts.error).toHaveBeenCalledTimes(1);
        expect(alerts.confirm).not.toHaveBeenCalled();
    });

    it("deletes the preset it was opened for and moves the selection only when it pointed at it", async () => {
        const page = render();
        const dialog = deferred<boolean>();
        alerts.confirm.mockReturnValueOnce(dialog.promise);
        page.remove().click();
        expect(alerts.confirm).toHaveBeenCalledTimes(1);
        expect(alerts.confirm.mock.calls[0][0]).toContain("A");
        // The reload replaced the objects, dropped B, and added C; the selection still names A.
        reloadFromServer([preset("a", "A"), preset("c", "C")], "a");
        dialog.resolve(true);
        await dialog.promise;
        await tick();
        expect(ids()).toEqual(["c"]);
        expect(selectedId()).toBe("c");
        expect(page.select().value).toBe("c");
    });

    it("leaves a selection that moved elsewhere meanwhile alone", async () => {
        const page = render();
        const dialog = deferred<boolean>();
        alerts.confirm.mockReturnValueOnce(dialog.promise);
        page.remove().click();
        reloadFromServer([preset("a", "A"), preset("b", "B"), preset("c", "C")], "c");
        dialog.resolve(true);
        await dialog.promise;
        await tick();
        expect(ids()).toEqual(["b", "c"]);
        expect(selectedId()).toBe("c");
    });

    it("does nothing when the list shrank to one preset meanwhile", async () => {
        const page = render();
        const dialog = deferred<boolean>();
        alerts.confirm.mockReturnValueOnce(dialog.promise);
        page.remove().click();
        reloadFromServer([preset("a", "A")], "a");
        dialog.resolve(true);
        await dialog.promise;
        await tick();
        expect(ids()).toEqual(["a"]);
        expect(selectedId()).toBe("a");
    });

    it("does nothing when the target vanished meanwhile", async () => {
        const page = render();
        const dialog = deferred<boolean>();
        alerts.confirm.mockReturnValueOnce(dialog.promise);
        page.remove().click();
        reloadFromServer([preset("c", "C"), preset("d", "D")], "d");
        dialog.resolve(true);
        await dialog.promise;
        await tick();
        expect(ids()).toEqual(["c", "d"]);
        expect(selectedId()).toBe("d");
    });

    it("keeps everything when the dialog is declined", async () => {
        const page = render();
        alerts.confirm.mockResolvedValueOnce(false);
        page.remove().click();
        await tick();
        await tick();
        expect(ids()).toEqual(["a", "b"]);
        expect(selectedId()).toBe("a");
    });
});

describe("the first step's editor", () => {
    const textarea = (page: ReturnType<typeof render>) => page.target.querySelector("textarea")!;
    const size = (page: ReturnType<typeof render>) =>
        page.target.querySelector<HTMLInputElement>("input[type=number]")!;
    const firstStep = (id: string) => settings.translatorPresets.items.find((entry) => entry.id === id)!.steps[0];

    it("shows and edits the selected preset's first step through the preset (translation slice 1.2)", async () => {
        const page = render();
        expect(textarea(page).value).toBe("prompt a");
        expect(size(page).value).toBe("10");

        textarea(page).value = "edited prompt {{slot::content}}";
        textarea(page).dispatchEvent(new Event("change", { bubbles: true }));
        size(page).value = "640";
        size(page).dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
        expect(firstStep("a")).toMatchObject({ prompt: "edited prompt {{slot::content}}", maxResponse: 640 });
        expect(firstStep("b")).toMatchObject({ prompt: "prompt b", maxResponse: 10 });

        // Another selection edits that preset's first step.
        settings.translatorPresets.selectedId = "b";
        flushSync();
        expect(textarea(page).value).toBe("prompt b");
        textarea(page).value = "edited b";
        textarea(page).dispatchEvent(new Event("change", { bubbles: true }));
        flushSync();
        expect(firstStep("b").prompt).toBe("edited b");
        expect(firstStep("a").prompt).toBe("edited prompt {{slot::content}}");
    });

    it("follows a reload that replaced the steps, and edits the first of several steps", async () => {
        const page = render();
        const twoSteps = createTranslatorPreset("A", {
            id: "a",
            steps: [
                { id: "s1", name: "Draft", prompt: "reloaded a", maxResponse: 300 },
                { id: "s2", name: "Polish", prompt: "second", maxResponse: 400 },
            ],
        });
        reloadFromServer([twoSteps, preset("b", "B")], "a");
        expect(textarea(page).value).toBe("reloaded a");
        expect(size(page).value).toBe("300");

        textarea(page).value = "edited after reload";
        textarea(page).dispatchEvent(new Event("change", { bubbles: true }));
        flushSync();
        expect(settings.translatorPresets.items[0].steps.map((step) => step.prompt)).toEqual([
            "edited after reload",
            "second",
        ]);
        expect(settings.translatorPresets.items[0].steps[1]).toMatchObject({ id: "s2", maxResponse: 400 });
    });
});

// Translation slice 3.1: the step editor (`TranslatorStepEditor.svelte`, one per step) finds its step
// by the preset's and the step's ids at every access, writes only what the server's normalizer keeps
// as it is (a blank name, an invalid or taken output key, and a cleared response size are not written;
// a draft is shown with a hint and dropped once what it was typed over changes), and adds, moves,
// and removes steps on the live list.
describe("the step editor", () => {
    type Page = ReturnType<typeof render>;
    const box = (page: Page, id: string) => page.target.querySelector<HTMLElement>(`[data-translator-step="${id}"]`)!;
    const boxes = (page: Page) =>
        [...page.target.querySelectorAll<HTMLElement>("[data-translator-step]")].map(
            (element) => element.dataset.translatorStep,
        );
    const texts = (element: HTMLElement) => [...element.querySelectorAll<HTMLInputElement>("input[type=text]")];
    const nameInput = (element: HTMLElement) => texts(element)[0];
    const keyInput = (element: HTMLElement) => texts(element)[1];
    const sizeInput = (element: HTMLElement) => element.querySelector<HTMLInputElement>("input[type=number]")!;
    const modelSelect = (element: HTMLElement) => element.querySelector("select")!;
    const enabledBox = (element: HTMLElement) => element.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    const button = (element: HTMLElement, label: string) =>
        element.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    const hints = (element: HTMLElement) => [...element.querySelectorAll("p")].map((entry) => entry.textContent);
    const addButton = (page: Page) =>
        [...page.target.querySelectorAll("button")].find((entry) =>
            entry.textContent?.includes(language.translatorSteps.add),
        );
    const type = (input: HTMLInputElement, value: string) => {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
    };
    /** Selects an option as a user would; happy-dom has no `:checked` for options, which Svelte's select binding reads. */
    function chooseOption(element: HTMLSelectElement, value: string) {
        element.value = value;
        const querySelector = element.querySelector.bind(element);
        (element as { querySelector: unknown }).querySelector = (selector: string) =>
            selector === ":checked" ? (element.options[element.selectedIndex] ?? null) : querySelector(selector);
        element.dispatchEvent(new Event("change"));
        flushSync();
    }
    const stepsOf = (id = "a") => settings.translatorPresets.items.find((entry) => entry.id === id)!.steps;
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
    const STEPS = language.translatorSteps;

    /** Preset `a` with three steps, as a reload would install them (`s1` owns the output key `result`). */
    function threeSteps() {
        reloadFromServer(
            [
                createTranslatorPreset("A", {
                    id: "a",
                    steps: [
                        { id: "s1", name: "Draft", prompt: "p1", maxResponse: 10, outputKey: "result" },
                        { id: "s2", name: "Polish", prompt: "p2", maxResponse: 20 },
                        { id: "s3", name: "Final", prompt: "p3", maxResponse: 30 },
                    ],
                }),
                preset("b", "B"),
            ],
            "a",
        );
    }

    it("adds steps in their normalized form, each under a fresh id, up to five, and then hides the button", () => {
        const page = render();
        expect(boxes(page)).toHaveLength(1);
        addButton(page)!.click();
        flushSync();
        const steps = stepsOf();
        expect(steps).toHaveLength(2);
        expect(plain(steps[1])).toEqual({
            id: expect.any(String),
            name: "Step 2",
            enabled: true,
            prompt: "",
            maxResponse: 1000,
            model: { mode: "inherit" },
        });
        expect(steps[1].id).not.toBe(steps[0].id);
        expect(boxes(page)).toEqual(steps.map((step) => step.id));
        // The new step's editor is live: its prompt lands on it alone.
        const prompt = box(page, steps[1].id).querySelector("textarea")!;
        prompt.value = "second {{slot::prev}}";
        prompt.dispatchEvent(new Event("change", { bubbles: true }));
        flushSync();
        expect(stepsOf().map((step) => step.prompt)).toEqual(["prompt a", "second {{slot::prev}}"]);
        for (let count = 3; count <= 5; count++) {
            addButton(page)!.click();
            flushSync();
            expect(stepsOf()).toHaveLength(count);
        }
        expect(addButton(page)).toBeUndefined();
        expect(stepsOf().map((step) => step.name)).toEqual(["Step 1", "Step 2", "Step 3", "Step 4", "Step 5"]);
        expect(isTranslatorPreset(plain(settings.translatorPresets.items[0]))).toBe(true);
        // The other preset is untouched.
        expect(stepsOf("b")).toHaveLength(1);
    });

    it("moves a step by its id, with the ends' buttons disabled, and removes one after the dialog on the list as it is then; never the last step", async () => {
        const page = render();
        threeSteps();
        expect(boxes(page)).toEqual(["s1", "s2", "s3"]);
        expect(button(box(page, "s1"), STEPS.moveUp)!.disabled).toBe(true);
        expect(button(box(page, "s3"), STEPS.moveDown)!.disabled).toBe(true);
        button(box(page, "s1"), STEPS.moveDown)!.click();
        flushSync();
        expect(stepsOf().map((step) => step.id)).toEqual(["s2", "s1", "s3"]);
        button(box(page, "s3"), STEPS.moveUp)!.click();
        flushSync();
        expect(stepsOf().map((step) => step.id)).toEqual(["s2", "s3", "s1"]);
        expect(boxes(page)).toEqual(["s2", "s3", "s1"]);
        expect(stepsOf().map((step) => step.name)).toEqual(["Polish", "Final", "Draft"]);

        // Remove s2 while a reload replaces every object (and drops s1): the live s2 goes.
        const dialog = deferred<boolean>();
        alerts.confirm.mockReturnValueOnce(dialog.promise);
        button(box(page, "s2"), STEPS.remove)!.click();
        expect(alerts.confirm).toHaveBeenCalledWith(STEPS.removeConfirm("Polish"));
        reloadFromServer(
            [
                createTranslatorPreset("A", {
                    id: "a",
                    steps: [
                        { id: "s2", name: "Polish", prompt: "p2", maxResponse: 20 },
                        { id: "s3", name: "Final", prompt: "p3", maxResponse: 30 },
                    ],
                }),
            ],
            "a",
        );
        dialog.resolve(true);
        await dialog.promise;
        await tick();
        expect(stepsOf().map((step) => step.id)).toEqual(["s3"]);
        expect(boxes(page)).toEqual(["s3"]);
        // One step left: no remove button.
        expect(button(box(page, "s3"), STEPS.remove)).toBeNull();

        // A declined dialog, a target gone meanwhile, and a list shrunk to one step remove nothing.
        threeSteps();
        alerts.confirm.mockResolvedValueOnce(false);
        button(box(page, "s2"), STEPS.remove)!.click();
        await tick();
        await tick();
        expect(stepsOf().map((step) => step.id)).toEqual(["s1", "s2", "s3"]);
        const gone = deferred<boolean>();
        alerts.confirm.mockReturnValueOnce(gone.promise);
        button(box(page, "s2"), STEPS.remove)!.click();
        reloadFromServer(
            [
                createTranslatorPreset("A", {
                    id: "a",
                    steps: [
                        { id: "s1", name: "Draft", prompt: "p1", maxResponse: 10 },
                        { id: "s3", name: "Final", prompt: "p3", maxResponse: 30 },
                    ],
                }),
            ],
            "a",
        );
        gone.resolve(true);
        await gone.promise;
        await tick();
        expect(stepsOf().map((step) => step.id)).toEqual(["s1", "s3"]);
        const last = deferred<boolean>();
        alerts.confirm.mockReturnValueOnce(last.promise);
        button(box(page, "s1"), STEPS.remove)!.click();
        reloadFromServer(
            [createTranslatorPreset("A", { id: "a", steps: [{ id: "s1", name: "Draft", prompt: "p1" }] })],
            "a",
        );
        last.resolve(true);
        await last.promise;
        await tick();
        expect(stepsOf().map((step) => step.id)).toEqual(["s1"]);
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("writes a name only when it is not blank, keeps a blank one as a draft with a hint, and drops the draft when the stored name changes, also back to the original", async () => {
        const page = render();
        threeSteps();
        const s1 = () => box(page, "s1");
        type(nameInput(s1()), "Renamed");
        expect(stepsOf()[0].name).toBe("Renamed");
        expect(hints(s1())).toEqual([]);

        type(nameInput(s1()), "   ");
        await tick();
        expect(stepsOf()[0].name).toBe("Renamed");
        expect(nameInput(s1()).value).toBe("   ");
        expect(hints(s1())).toEqual([STEPS.nameBlank]);
        // The other steps' editors show nothing of it.
        expect(hints(box(page, "s2"))).toEqual([]);

        // A reload that changes the stored name discards the draft for good (Astra's challenge, point 3).
        const named = (name: string) =>
            reloadFromServer(
                [
                    createTranslatorPreset("A", {
                        id: "a",
                        steps: [
                            { id: "s1", name, prompt: "p1", maxResponse: 10, outputKey: "result" },
                            { id: "s2", name: "Polish", prompt: "p2", maxResponse: 20 },
                            { id: "s3", name: "Final", prompt: "p3", maxResponse: 30 },
                        ],
                    }),
                ],
                "a",
            );
        named("Updated");
        expect(nameInput(s1()).value).toBe("Updated");
        expect(hints(s1())).toEqual([]);
        named("Renamed");
        expect(nameInput(s1()).value).toBe("Renamed");
        expect(hints(s1())).toEqual([]);
        // A reload that keeps the name keeps a live draft.
        type(nameInput(s1()), "");
        named("Renamed");
        expect(nameInput(s1()).value).toBe("");
        expect(hints(s1())).toEqual([STEPS.nameBlank]);
        type(nameInput(s1()), "Final name");
        expect(stepsOf()[0].name).toBe("Final name");
        expect(hints(s1())).toEqual([]);
    });

    it("writes a valid output key, deletes a cleared one, and keeps an invalid or taken key as a draft that is never written", async () => {
        const page = render();
        threeSteps();
        const s2 = () => box(page, "s2");
        expect(keyInput(s2()).value).toBe("");
        type(keyInput(s2()), "polished_1");
        expect(stepsOf()[1].outputKey).toBe("polished_1");
        expect(hints(s2())).toEqual([]);

        type(keyInput(s2()), "1bad");
        await tick();
        expect(stepsOf()[1].outputKey).toBe("polished_1");
        expect(keyInput(s2()).value).toBe("1bad");
        expect(hints(s2())).toEqual([STEPS.outputKeyInvalid]);
        type(keyInput(s2()), "result");
        await tick();
        expect(stepsOf()[1].outputKey).toBe("polished_1");
        expect(keyInput(s2()).value).toBe("result");
        expect(hints(s2())).toEqual([STEPS.outputKeyTaken]);
        // A disabled step's key is taken too.
        reloadFromServer(
            [
                createTranslatorPreset("A", {
                    id: "a",
                    steps: [
                        { id: "s1", name: "Draft", prompt: "p1", maxResponse: 10, outputKey: "result", enabled: false },
                        { id: "s2", name: "Polish", prompt: "p2", maxResponse: 20, outputKey: "polished_1" },
                        { id: "s3", name: "Final", prompt: "p3", maxResponse: 30 },
                    ],
                }),
            ],
            "a",
        );
        type(keyInput(s2()), "result");
        await tick();
        expect(stepsOf()[1].outputKey).toBe("polished_1");
        expect(hints(s2())).toEqual([STEPS.outputKeyTaken]);

        type(keyInput(s2()), "fine");
        expect(stepsOf()[1].outputKey).toBe("fine");
        expect(hints(s2())).toEqual([]);
        type(keyInput(s2()), "");
        expect(Object.hasOwn(plain(stepsOf()[1]), "outputKey")).toBe(false);
        expect(hints(s2())).toEqual([]);
        expect(stepsOf()[0].outputKey).toBe("result");
        expect(isTranslatorPreset(plain(settings.translatorPresets.items[0]))).toBe(true);
    });

    it("discards a taken output key draft once the other steps' keys change, so the field never shows a key that is not stored", async () => {
        const page = render();
        threeSteps();
        const s1 = () => box(page, "s1");
        const s2 = () => box(page, "s2");
        type(keyInput(s2()), "result");
        await tick();
        expect(keyInput(s2()).value).toBe("result");
        expect(hints(s2())).toEqual([STEPS.outputKeyTaken]);
        expect(plain(stepsOf()[1])).not.toHaveProperty("outputKey");

        // The owner clears its key: the draft is not committed (Astra's challenge, point 2).
        type(keyInput(s1()), "");
        await tick();
        expect(plain(stepsOf()[0])).not.toHaveProperty("outputKey");
        expect(plain(stepsOf()[1])).not.toHaveProperty("outputKey");
        expect(keyInput(s2()).value).toBe("");
        expect(hints(s2())).toEqual([]);
        // The key is free now: typing it again stores it.
        type(keyInput(s2()), "result");
        expect(stepsOf()[1].outputKey).toBe("result");
        expect(keyInput(s2()).value).toBe("result");
        expect(hints(s2())).toEqual([]);

        // The owner vanishing in a reload drops a taken draft on another step the same way.
        type(keyInput(s2()), "");
        type(keyInput(box(page, "s3")), "result");
        type(keyInput(s2()), "result");
        await tick();
        expect(hints(s2())).toEqual([STEPS.outputKeyTaken]);
        reloadFromServer(
            [
                createTranslatorPreset("A", {
                    id: "a",
                    steps: [
                        { id: "s1", name: "Draft", prompt: "p1", maxResponse: 10 },
                        { id: "s2", name: "Polish", prompt: "p2", maxResponse: 20 },
                    ],
                }),
            ],
            "a",
        );
        expect(keyInput(s2()).value).toBe("");
        expect(hints(s2())).toEqual([]);
        expect(plain(stepsOf()[1])).not.toHaveProperty("outputKey");
        // What the field shows is what the preset stores, so an export carries no unsaved key.
        expect(stepsOf().map((step) => step.outputKey ?? "")).toEqual([keyInput(s1()).value, keyInput(s2()).value]);
    });

    it("writes only a finite response size: a cleared field is not written and shows the stored size again", async () => {
        const page = render();
        threeSteps();
        const s2 = () => box(page, "s2");
        type(sizeInput(s2()), "640");
        expect(stepsOf()[1].maxResponse).toBe(640);
        type(sizeInput(s2()), "");
        expect(stepsOf()[1].maxResponse).toBe(640);
        // The binding respects the setter's refusal after a tick, and the change event restores it too.
        await tick();
        expect(sizeInput(s2()).value).toBe("640");
        sizeInput(s2()).value = "";
        sizeInput(s2()).dispatchEvent(new Event("change", { bubbles: true }));
        flushSync();
        expect(sizeInput(s2()).value).toBe("640");
        expect(stepsOf()[1].maxResponse).toBe(640);
        expect(stepsOf().map((step) => step.maxResponse)).toEqual([10, 640, 30]);
        expect(isTranslatorPreset(plain(settings.translatorPresets.items[0]))).toBe(true);
    });

    it("picks a step's model: the translate slot, a profile, or a deleted profile shown as missing", () => {
        const page = render();
        threeSteps();
        const s2 = () => box(page, "s2");
        expect(modelSelect(s2()).value).toBe("inherit");
        expect([...modelSelect(s2()).options].map((option) => option.value)).toEqual([
            "inherit",
            `profile:${DEFAULT_MODEL_PROFILE_ID}`,
            "profile:echo",
            "profile:spare",
        ]);
        expect([...modelSelect(s2()).options].map((option) => option.textContent)).toEqual([
            STEPS.inheritModel,
            expect.any(String),
            expect.stringContaining("Echo"),
            expect.stringContaining("Spare"),
        ]);
        chooseOption(modelSelect(s2()), "profile:spare");
        expect(plain(stepsOf()[1].model)).toEqual({ mode: "profile", profileId: "spare" });
        expect(plain(stepsOf()[0].model)).toEqual({ mode: "inherit" });
        expect(hints(s2())).toEqual([]);
        chooseOption(modelSelect(s2()), "inherit");
        expect(plain(stepsOf()[1].model)).toEqual({ mode: "inherit" });
        expect(Object.keys(plain(stepsOf()[1].model))).toEqual(["mode"]);

        // A step whose profile was deleted (another client, or the Connections tab).
        reloadFromServer(
            [
                createTranslatorPreset("A", {
                    id: "a",
                    steps: [
                        { id: "s1", name: "Draft", prompt: "p1", maxResponse: 10 },
                        { id: "s2", name: "Polish", prompt: "p2", model: { mode: "profile", profileId: "gone" } },
                    ],
                }),
            ],
            "a",
        );
        expect(modelSelect(s2()).value).toBe("profile:gone");
        const missing = [...modelSelect(s2()).options].find((option) => option.value === "profile:gone")!;
        expect(missing.disabled).toBe(true);
        expect(missing.textContent).toBe(language.modelProfiles.missingProfile("gone"));
        expect(hints(s2())).toEqual([STEPS.missingProfile]);
        chooseOption(modelSelect(s2()), "profile:echo");
        expect(plain(stepsOf()[1].model)).toEqual({ mode: "profile", profileId: "echo" });
        expect(hints(s2())).toEqual([]);
        expect([...modelSelect(s2()).options].map((option) => option.value)).not.toContain("profile:gone");
    });

    it("toggles a step and notes that the first step runs when none is enabled", () => {
        const page = render();
        threeSteps();
        const note = () => page.target.textContent?.includes(STEPS.noneEnabled) ?? false;
        expect(note()).toBe(false);
        for (const id of ["s1", "s2", "s3"]) {
            const check = enabledBox(box(page, id));
            expect(check.checked).toBe(true);
            check.checked = false;
            check.dispatchEvent(new Event("change", { bubbles: true }));
            flushSync();
        }
        expect(stepsOf().map((step) => step.enabled)).toEqual([false, false, false]);
        expect(note()).toBe(true);
        const check = enabledBox(box(page, "s3"));
        check.checked = true;
        check.dispatchEvent(new Event("change", { bubbles: true }));
        flushSync();
        expect(stepsOf().map((step) => step.enabled)).toEqual([false, false, true]);
        expect(note()).toBe(false);
    });

    it("follows a reload that drops steps: their editors go, the kept step's stays live", () => {
        const page = render();
        threeSteps();
        reloadFromServer(
            [createTranslatorPreset("A", { id: "a", steps: [{ id: "s1", name: "Draft", prompt: "p1" }] })],
            "a",
        );
        expect(boxes(page)).toEqual(["s1"]);
        type(nameInput(box(page, "s1")), "Kept");
        expect(plain(stepsOf())).toEqual([
            { id: "s1", name: "Kept", enabled: true, prompt: "p1", maxResponse: 1000, model: { mode: "inherit" } },
        ]);
        expect(alerts.error).not.toHaveBeenCalled();
    });
});

// Translation slice 3.2: the Send Text As-Is check writes `true` to the selected preset, found by id
// at each write, or deletes the field (never `false`), so the tab's text stays the server's; it
// follows the selection and a reload that replaced the objects.
describe("Send Text As-Is", () => {
    type Page = ReturnType<typeof render>;
    const checkbox = (page: Page) => {
        const label = [...page.target.querySelectorAll("label")].find((entry) =>
            entry.textContent?.includes(language.translatorSendTextAsIs),
        );
        expect(label, "the Send Text As-Is check").toBeDefined();
        return label!.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    };
    const toggle = (input: HTMLInputElement, checked: boolean) => {
        input.checked = checked;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        flushSync();
    };
    const presetById = (id: string) => settings.translatorPresets.items.find((entry) => entry.id === id)!;
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

    it("is off for a preset without the field, writes true on check, and deletes the field on uncheck, on the selected preset alone", () => {
        const page = render();
        expect(checkbox(page).checked).toBe(false);
        toggle(checkbox(page), true);
        expect(presetById("a").sendTextAsIs).toBe(true);
        expect(Object.keys(plain(presetById("a")))).toEqual(["id", "name", "steps", "sendTextAsIs"]);
        expect(Object.hasOwn(plain(presetById("b")), "sendTextAsIs")).toBe(false);
        expect(checkbox(page).checked).toBe(true);
        // The other preset shows its own state; back on `a`, the check is still on.
        settings.translatorPresets.selectedId = "b";
        flushSync();
        expect(checkbox(page).checked).toBe(false);
        settings.translatorPresets.selectedId = "a";
        flushSync();
        expect(checkbox(page).checked).toBe(true);
        toggle(checkbox(page), false);
        expect(Object.hasOwn(plain(presetById("a")), "sendTextAsIs")).toBe(false);
        expect(Object.keys(plain(presetById("a")))).toEqual(["id", "name", "steps"]);
        expect(checkbox(page).checked).toBe(false);
        expect(isTranslatorPreset(plain(presetById("a")))).toBe(true);
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("follows a reload that replaced the objects and the selection, and writes to the live preset found by id", () => {
        const page = render();
        reloadFromServer([{ ...preset("a", "A"), sendTextAsIs: true }, preset("c", "C")], "c");
        expect(checkbox(page).checked).toBe(false);
        settings.translatorPresets.selectedId = "a";
        flushSync();
        expect(checkbox(page).checked).toBe(true);
        toggle(checkbox(page), false);
        expect(Object.hasOwn(plain(presetById("a")), "sendTextAsIs")).toBe(false);
        expect(Object.hasOwn(plain(presetById("c")), "sendTextAsIs")).toBe(false);
        reloadFromServer([{ ...preset("a", "A"), sendTextAsIs: true }], "a");
        expect(checkbox(page).checked).toBe(true);
        toggle(checkbox(page), true);
        expect(plain(presetById("a")).sendTextAsIs).toBe(true);
        expect(alerts.error).not.toHaveBeenCalled();
    });
});

// Translation slice 3.4: the Exclude Chain-of-Thought check writes `true` to the selected preset,
// found by id at each write, or deletes the field (never `false`), independent of Send Text As-Is;
// it follows the selection and a reload that replaced the objects.
describe("Exclude Chain-of-Thought", () => {
    type Page = ReturnType<typeof render>;
    const checkbox = (page: Page, name: string) => {
        const label = [...page.target.querySelectorAll("label")].find((entry) => entry.textContent?.includes(name));
        expect(label, `the ${name} check`).toBeDefined();
        return label!.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    };
    const exclude = (page: Page) => checkbox(page, language.translatorExcludeThoughts);
    const asIs = (page: Page) => checkbox(page, language.translatorSendTextAsIs);
    const toggle = (input: HTMLInputElement, checked: boolean) => {
        input.checked = checked;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        flushSync();
    };
    const presetById = (id: string) => settings.translatorPresets.items.find((entry) => entry.id === id)!;
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

    it("is off without the field, writes true on check and deletes the field on uncheck, on the selected preset alone, with Send Text As-Is its own field", () => {
        const page = render();
        expect(exclude(page).checked).toBe(false);
        toggle(exclude(page), true);
        expect(presetById("a").excludeThoughts).toBe(true);
        expect(Object.keys(plain(presetById("a")))).toEqual(["id", "name", "steps", "excludeThoughts"]);
        expect(Object.hasOwn(plain(presetById("b")), "excludeThoughts")).toBe(false);
        expect(exclude(page).checked).toBe(true);
        expect(asIs(page).checked).toBe(false);
        // Send Text As-Is on and off again leaves the other check as it is.
        toggle(asIs(page), true);
        expect(plain(presetById("a"))).toMatchObject({ sendTextAsIs: true, excludeThoughts: true });
        expect(exclude(page).checked).toBe(true);
        toggle(asIs(page), false);
        expect(Object.keys(plain(presetById("a")))).toEqual(["id", "name", "steps", "excludeThoughts"]);
        expect(exclude(page).checked).toBe(true);
        // The other preset shows its own state; back on `a`, the check is still on.
        settings.translatorPresets.selectedId = "b";
        flushSync();
        expect(exclude(page).checked).toBe(false);
        settings.translatorPresets.selectedId = "a";
        flushSync();
        expect(exclude(page).checked).toBe(true);
        toggle(exclude(page), false);
        expect(Object.hasOwn(plain(presetById("a")), "excludeThoughts")).toBe(false);
        expect(Object.keys(plain(presetById("a")))).toEqual(["id", "name", "steps"]);
        expect(exclude(page).checked).toBe(false);
        expect(isTranslatorPreset(plain(presetById("a")))).toBe(true);
        expect(alerts.error).not.toHaveBeenCalled();
    });

    it("follows a reload that replaced the objects and the selection, and writes to the live preset found by id", () => {
        const page = render();
        reloadFromServer([{ ...preset("a", "A"), excludeThoughts: true }, preset("c", "C")], "c");
        expect(exclude(page).checked).toBe(false);
        settings.translatorPresets.selectedId = "a";
        flushSync();
        expect(exclude(page).checked).toBe(true);
        toggle(exclude(page), false);
        expect(Object.hasOwn(plain(presetById("a")), "excludeThoughts")).toBe(false);
        expect(Object.hasOwn(plain(presetById("c")), "excludeThoughts")).toBe(false);
        reloadFromServer([{ ...preset("a", "A"), sendTextAsIs: true, excludeThoughts: true }], "a");
        expect(exclude(page).checked).toBe(true);
        expect(asIs(page).checked).toBe(true);
        toggle(exclude(page), true);
        expect(Object.keys(plain(presetById("a")))).toEqual(["id", "name", "steps", "sendTextAsIs", "excludeThoughts"]);
        expect(alerts.error).not.toHaveBeenCalled();
    });
});
