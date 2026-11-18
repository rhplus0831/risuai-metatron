// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authFetch: vi.fn<typeof import("src/ts/storage/serverAuth").authFetch>() }));
vi.mock("src/ts/storage/serverAuth", async () =>
    (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: mocks.authFetch }),
);
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/globalApi.svelte", async () => (await import("src/ts/tests/globalApiMock")).createGlobalApiMock());
vi.mock("src/ts/process/modules", async (original) => ({
    ...(await original<typeof import("src/ts/process/modules")>()),
    moduleUpdate: vi.fn(),
}));

import { language } from "src/lang";
import PopupEditor from "src/lib/Others/PopupEditor.svelte";
import PromptDataItem from "src/lib/UI/PromptDataItem.svelte";
import { writePopupEditorMonaco } from "src/ts/gui/popupEditorMode";
import { recordData } from "src/ts/storage/records.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { disableHighlight } from "src/ts/stores.svelte";
import type { RequestInterception } from "../../../../shared/llm/interception.ts";
import type { ModelModeExtended } from "../../../../shared/llm/request.ts";
import RequestInterceptionSettings from "./RequestInterceptionSettings.svelte";

const first = (): RequestInterception => ({
    id: "first",
    enabled: true,
    modes: ["model"],
    position: "start",
    prompt: { type: "plain", type2: "normal", name: "First rule", text: "First prompt", role: "system" },
});
const second = (): RequestInterception => ({
    id: "second",
    enabled: false,
    modes: ["translate"],
    position: "end",
    prompt: { type: "plain", type2: "normal", name: "Second rule", text: "Second prompt", role: "user" },
});
const modes: ModelModeExtended[] = ["model", "submodel", "memory", "emotion", "otherAx", "translate"];

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | undefined;
let previousHighlight: boolean;

beforeEach(() => {
    vi.useFakeTimers();
    installFlatDatabase({ characters: [], requestInterceptions: [first(), second()] });
    previousHighlight = get(disableHighlight);
    disableHighlight.set(false);
    target = document.createElement("div");
    document.body.append(target);
});

afterEach(async () => {
    if (component) await unmount(component);
    component = undefined;
    target.remove();
    disableHighlight.set(previousHighlight);
    vi.useRealTimers();
});

function render() {
    component = mount(RequestInterceptionSettings, { target });
    flushSync();
}

function row(id: string) {
    const found = target.querySelector<HTMLElement>(`[data-request-interception="${id}"]`);
    expect(found, `rule ${id}`).not.toBeNull();
    return found!;
}

function open(id: string) {
    const found = row(id);
    found.querySelector<HTMLElement>('[draggable="true"]:not([role="doc-pagebreak"])')!.click();
    flushSync();
    return found;
}

function addButton() {
    const found = [...target.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === language.requestInterception.add,
    );
    expect(found).toBeDefined();
    return found!;
}

function checkbox(scope: ParentNode, name: string) {
    const label = [...scope.querySelectorAll("label")].find((label) => label.textContent?.trim() === name);
    expect(label, `checkbox ${name}`).toBeDefined();
    return label!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

function selectWith(scope: ParentNode, option: string) {
    const found = [...scope.querySelectorAll("select")].find((select) =>
        [...select.options].some((entry) => entry.value === option),
    );
    expect(found, `select offering ${option}`).toBeDefined();
    return found!;
}

function edit(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
    element.value = value;
    if (element instanceof HTMLSelectElement) {
        // Svelte reads :checked; happy-dom can retain the old option after select.value changes.
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
        element.dispatchEvent(new Event("change", { bubbles: true }));
    }
    flushSync();
}

function assertStored(expected: RequestInterception[]) {
    expect(recordData<{ requestInterceptions: RequestInterception[] }>("providers")!.requestInterceptions).toEqual(
        expected,
    );
    expect(settings.providers.requestInterceptions).toEqual(expected);
}

function rowAction(id: string, icon: "arrow-up" | "arrow-down" | "x") {
    const button = row(id).querySelector(`svg.lucide-${icon}`)?.closest("button");
    expect(button, `${icon} action on ${id}`).not.toBeNull();
    button!.click();
    flushSync();
}

describe("expanded prompt editor", () => {
    const literal = "Show {{upper::green}}";
    const monacoPreference = "risu-popup-editor-monaco";
    let previousMonaco: string | null;
    let popup: ReturnType<typeof mount> | undefined;

    beforeEach(() => {
        previousMonaco = localStorage.getItem(monacoPreference);
        writePopupEditorMonaco(false);
    });

    afterEach(async () => {
        if (popup) await unmount(popup);
        popup = undefined;
        if (previousMonaco === null) localStorage.removeItem(monacoPreference);
        else localStorage.setItem(monacoPreference, previousMonaco);
        mocks.authFetch.mockReset();
    });

    function expandPrompt(editor: ParentNode) {
        editor.querySelector<HTMLButtonElement>(`button[aria-label="${language.hotkeyDesc.popupEditor}"]`)!.click();
        flushSync();
        const popupTarget = document.createElement("div");
        target.append(popupTarget);
        popup = mount(PopupEditor, { target: popupTarget });
        flushSync();
        return popupTarget;
    }

    const previewButton = (editor: ParentNode) =>
        [...editor.querySelectorAll("button")].find((button) => button.textContent?.trim() === language.preview);

    it("counts the literal rule text in the popup without offering Preview", async () => {
        settings.providers.requestInterceptions[0].prompt.text = literal;
        settings.providers.useTokenizerCaching = false;
        const requests: string[][] = [];
        mocks.authFetch.mockImplementation(async (path, init) => {
            expect(path).toBe("/api/tokens/count");
            const { texts } = JSON.parse(String(init?.body)) as { texts: string[] };
            requests.push(texts);
            return Response.json({ counts: texts.map((text) => (text === literal ? 6 : 2)) });
        });
        render();
        const editor = expandPrompt(open("first"));
        expect(editor.querySelector("textarea")?.value).toBe(literal);
        expect.soft(editor.textContent).toContain("plaintext");
        expect.soft(previewButton(editor)).toBeUndefined();
        await vi.advanceTimersByTimeAsync(0);
        flushSync();
        expect.soft(requests).toEqual([[literal]]);
        expect(editor.textContent).toContain(`${language.tokens}: 6`);
    });

    it("offers Preview for a CBS-enabled template prompt", () => {
        component = mount(PromptDataItem, {
            target,
            props: { promptItem: { ...first().prompt, text: literal }, isOpened: true },
        });
        flushSync();
        expect(previewButton(expandPrompt(target))).toBeDefined();
    });
});

describe("RequestInterceptionSettings", () => {
    it("appends an enabled model/start plain system rule and disables Add at 32 rules", () => {
        const existing = Array.from({ length: 31 }, (_, index) => ({ ...first(), id: `rule-${index}` }));
        settings.providers.requestInterceptions = existing;
        render();
        expect(target.querySelector("h2")?.textContent).toBe("Request Interception");
        expect(addButton().disabled).toBe(false);

        addButton().click();
        flushSync();
        const added = settings.providers.requestInterceptions.at(-1)!;
        expect(added.id.trim()).not.toBe("");
        expect(existing.map((rule) => rule.id)).not.toContain(added.id);
        const expected = [
            ...existing,
            {
                id: added.id,
                enabled: true,
                modes: ["model"] as ModelModeExtended[],
                position: "start" as const,
                prompt: { type: "plain" as const, type2: "normal" as const, text: "", role: "system" as const },
            },
        ];
        assertStored(expected);
        expect(addButton().disabled).toBe(true);
        addButton().click();
        flushSync();
        assertStored(expected);
    });

    it("persists label, text, role, enabled, position and all six modes in canonical order", () => {
        render();
        const editor = open("first");
        let expected = first();
        const assertEdit = () => assertStored([expected, second()]);

        edit(editor.querySelector<HTMLInputElement>("input:not([type=checkbox])")!, "Renamed rule");
        expected.prompt.name = "Renamed rule";
        assertEdit();
        expect(editor.querySelector("textarea")).not.toBeNull();
        expect(editor.querySelector("[contenteditable=true]")).toBeNull();
        expect(editor.querySelectorAll("select")).toHaveLength(2); // Position and role only.
        edit(editor.querySelector("textarea")!, "Keep {{literal}}\nSecond line");
        expected.prompt.text = "Keep {{literal}}\nSecond line";
        assertEdit();
        for (const role of ["user", "bot", "system"] as const) {
            edit(selectWith(editor, "user"), role);
            expected.prompt.role = role;
            assertEdit();
        }

        for (const enabled of [false, true]) {
            checkbox(editor, language.requestInterception.enabled).click();
            flushSync();
            expected.enabled = enabled;
            assertEdit();
        }
        for (const position of ["end", "start"] as const) {
            edit(selectWith(editor, "start"), position);
            expected.position = position;
            assertEdit();
        }

        const labels = [
            language.model,
            language.submodel,
            language.modelProfiles.auxModes.memory,
            language.modelProfiles.auxModes.emotion,
            language.modelProfiles.auxModes.otherAx,
            language.modelProfiles.auxModes.translate,
        ];
        expect(
            [...editor.querySelectorAll('input[type="checkbox"]')].map((input) => (input as HTMLInputElement).checked),
        ).toEqual([true, true, false, false, false, false, false]);
        // Add in reverse order, then remove one: click order must not become stored order.
        const changes: [number, ModelModeExtended[]][] = [
            [5, ["model", "translate"]],
            [4, ["model", "otherAx", "translate"]],
            [3, ["model", "emotion", "otherAx", "translate"]],
            [2, ["model", "memory", "emotion", "otherAx", "translate"]],
            [1, ["model", "submodel", "memory", "emotion", "otherAx", "translate"]],
            [0, ["submodel", "memory", "emotion", "otherAx", "translate"]],
        ];
        for (const [index, selected] of changes) {
            const checked = selected.includes(modes[index]);
            checkbox(editor, labels[index]).click();
            flushSync();
            expected.modes = selected;
            assertEdit();
            expect(checkbox(editor, labels[index]).checked).toBe(checked);
        }
    });

    it("writes reordered and removed rules without losing their prompts", () => {
        render();
        const ids = () =>
            [...target.querySelectorAll("[data-request-interception]")].map((row) =>
                row.getAttribute("data-request-interception"),
            );
        rowAction("first", "arrow-down");
        assertStored([second(), first()]);
        expect(ids()).toEqual(["second", "first"]);
        rowAction("first", "arrow-up");
        assertStored([first(), second()]);
        expect(ids()).toEqual(["first", "second"]);
        rowAction("second", "x");
        assertStored([first()]);
        expect(ids()).toEqual(["first"]);
    });
});
