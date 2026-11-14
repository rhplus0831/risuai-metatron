// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());

import { language } from "src/lang";
import { alertConfirm } from "src/ts/alert";
import { recordData } from "src/ts/storage/records.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { MAX_INPUT_HOOKS, type InputHook } from "../../../../shared/inputHooks.ts";
import { normalizeModelProfile } from "../../../../shared/presets.ts";
import InputHookSettings from "./InputHookSettings.svelte";

const draft = (): InputHook => ({
    id: "draft-one",
    name: "Translate draft",
    type: "draft",
    prompt: "Translate {{slot::content}}",
    translation: true,
    model: { mode: "profile", profileId: "gone" },
});
const other = (): InputHook => ({
    id: "aside",
    name: "Explain aside",
    type: "btw",
    prompt: "Explain {{slot::content}}",
    model: { mode: "profile", profileId: "echo" },
});

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;

beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(alertConfirm).mockReset().mockResolvedValue(false);
    installFlatDatabase({
        characters: [],
        inputHooks: [draft(), other()],
        modelProfiles: [normalizeModelProfile({ id: "echo", name: "Echo", modelId: "echo_model" })],
    });
    target = document.createElement("div");
    document.body.append(target);
});

afterEach(async () => {
    if (component) await unmount(component);
    component = undefined;
    target.remove();
    vi.useRealTimers();
});

function render() {
    component = mount(InputHookSettings, { target });
    flushSync();
}

function button(name: string) {
    const found = [...target.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === name);
    expect(found, `button named ${name}`).toBeDefined();
    return found!;
}

function field<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    scope: ParentNode,
    name: string,
): T {
    const label = [...scope.querySelectorAll("label")].find((entry) => entry.textContent?.trim() === name);
    expect(label, `field labelled ${name}`).toBeDefined();
    return document.getElementById(label!.htmlFor) as T;
}

function edit(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
    element.value = value;
    if (element instanceof HTMLSelectElement) {
        // happy-dom's :checked can retain the old option after assigning select.value.
        // Svelte's binding reads :checked; selectedIndex reflects the browser selection.
        const querySelector = element.querySelector.bind(element);
        (element as { querySelector: unknown }).querySelector = (selector: string) =>
            selector === ":checked" ? (element.options[element.selectedIndex] ?? null) : querySelector(selector);
        try {
            element.dispatchEvent(new Event("change", { bubbles: true }));
        } finally {
            delete (element as { querySelector?: unknown }).querySelector;
        }
    } else {
        element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    flushSync();
}

function expand(name: string) {
    const header = [...target.querySelectorAll("button[aria-expanded]")].find((entry) =>
        entry.textContent?.includes(name),
    );
    expect(header, `hook named ${name}`).toBeDefined();
    (header as HTMLButtonElement).click();
    flushSync();
    return document.getElementById(header!.getAttribute("aria-controls")!)!;
}

// The settings view keeps a stable forwarding proxy; inspect the stored array for identity.
const storedHooks = () => recordData<InputHook[]>("inputHooks")!;

/** Assert both replacement and preservation of the old list, including all its records. */
function beforeEdit() {
    const before = storedHooks();
    const snapshot = JSON.parse(JSON.stringify(before));
    return (expected: InputHook[]) => {
        expect(storedHooks()).not.toBe(before);
        expect(before).toEqual(snapshot);
        expect(settings.inputHooks).toEqual(expected);
    };
}

describe("InputHookSettings", () => {
    it("adds each chosen type with a unique id, inherit model and focused name", async () => {
        render();
        expect(target.querySelector("h2")?.textContent).toBe("Input Hooks");
        const expected = [draft(), other()];
        for (const [type, name] of [
            ["draft", language.inputHooks.draft],
            ["btw", language.inputHooks.btw],
        ] as const) {
            edit(target.querySelector("select")!, type);
            const assertEdit = beforeEdit();
            button(language.inputHooks.add).click();
            flushSync();
            await tick();
            await tick();
            flushSync();

            const added = settings.inputHooks.at(-1)!;
            expect(added.id.trim()).not.toBe("");
            expect(expected.map((hook) => hook.id)).not.toContain(added.id);
            expected.push({ id: added.id, name, type, prompt: "", model: { mode: "inherit" } });
            assertEdit(expected);
            expect(document.activeElement).toBeInstanceOf(HTMLInputElement);
            expect((document.activeElement as HTMLInputElement).value).toBe(name);
            expect(
                [...target.querySelectorAll("label")].some(
                    (label) =>
                        label.htmlFor === document.activeElement?.id && label.textContent === language.inputHooks.name,
                ),
            ).toBe(true);
        }
    });

    it("edits only the chosen hook with new arrays and shows missing profiles", () => {
        render();
        const editor = expand("Translate draft");
        const model = () => field<HTMLSelectElement>(editor, language.inputHooks.model);
        expect(model().selectedOptions[0].textContent?.trim()).toBe(language.modelProfiles.missingProfile("gone"));
        expect(model().selectedOptions[0].value).not.toBe("");
        expect([...model().options].some((option) => option.textContent?.includes("Echo"))).toBe(true);

        let expected = [draft(), other()];
        const change = (element: Parameters<typeof edit>[0], value: string, hook: InputHook) => {
            const assertEdit = beforeEdit();
            edit(element, value);
            expected = [hook, other()];
            assertEdit(expected);
        };
        change(field(editor, language.inputHooks.name), "My helper", { ...expected[0], name: "My helper" });
        const { translation: _translation, ...withoutTranslation } = expected[0];
        change(field(editor, language.inputHooks.type), "btw", { ...withoutTranslation, type: "btw" });
        expect(settings.inputHooks[0]).not.toHaveProperty("translation");

        const profileValue = [...model().options].find((option) => option.textContent?.includes("Echo"))!.value;
        change(model(), profileValue, { ...expected[0], model: { mode: "profile", profileId: "echo" } });
        const inheritValue = [...model().options].find(
            (option) => option.textContent?.trim() === language.modelProfiles.auxModes.otherAx,
        )!.value;
        change(model(), inheritValue, { ...expected[0], model: { mode: "inherit" } });
        change(field(editor, language.inputHooks.prompt), "Explain {{slot::draft}}\nKeep names.", {
            ...expected[0],
            prompt: "Explain {{slot::draft}}\nKeep names.",
        });
    });

    it("deletes into a new array only after confirmation", async () => {
        render();
        expand("Translate draft");
        const before = storedHooks();
        button(language.inputHooks.remove).click();
        await tick();
        expect(alertConfirm).toHaveBeenCalledWith(language.inputHooks.removeConfirm("Translate draft"));
        expect(storedHooks()).toBe(before);
        expect(settings.inputHooks).toEqual([draft(), other()]);

        let confirm!: (value: boolean) => void;
        vi.mocked(alertConfirm).mockReturnValueOnce(
            new Promise((resolve) => {
                confirm = resolve;
            }),
        );
        const assertEdit = beforeEdit();
        button(language.inputHooks.remove).click();
        expect(alertConfirm).toHaveBeenCalledTimes(2);
        expect(storedHooks()).toBe(before);
        confirm(true);
        await tick();
        flushSync();
        assertEdit([other()]);
        expect(target.textContent).not.toContain("Translate draft");
        expect(target.textContent).toContain("Explain aside");
    });

    it("disables Add at MAX_INPUT_HOOKS", () => {
        settings.inputHooks = Array.from({ length: MAX_INPUT_HOOKS }, (_, index) => ({
            ...other(),
            id: `hook-${index}`,
        }));
        render();
        const before = storedHooks();
        const snapshot = JSON.parse(JSON.stringify(before));
        expect(button(language.inputHooks.add).disabled).toBe(true);
        button(language.inputHooks.add).click();
        flushSync();
        expect(storedHooks()).toBe(before);
        expect(settings.inputHooks).toEqual(snapshot);
    });
});
