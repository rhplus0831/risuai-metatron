// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { reactiveProps } from "../UI/tests/reactiveProps.svelte";
import OocToggleEditor from "./OocToggleEditor.svelte";

vi.mock("src/ts/stores.svelte", async () => (await import("src/ts/tests/storesMock")).createStoresMock());

const definitionsText = [
    "=Session=group",
    "ooc=OOC mode",
    "style=Answer style=select=Brief,Detailed,Dialogue",
    "name=Speaker name=text",
    "notes=Session notes=textarea",
    "=Explanation=caption",
    "==divider",
    "==groupEnd",
].join("\n");

let instance: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;

beforeEach(() => {
    installFlatDatabase({ characters: [] });
    target = document.createElement("div");
    document.body.append(target);
});

afterEach(async () => {
    if (instance) await unmount(instance);
    instance = undefined;
    target.remove();
});

function render(value: Record<string, string>) {
    const onchange = vi.fn<(next: Record<string, string>) => void>();
    const props = reactiveProps({ definitionsText, value, onchange });
    instance = mount(OocToggleEditor, { target, props });
    flushSync();
    return { props, onchange };
}

function control<T extends Element>(key: string, selector: string): T {
    const found = target.querySelector<T>(`[data-ooc-toggle="${key}"] ${selector}`);
    expect(found, `${key}: ${selector}`).not.toBeNull();
    return found!;
}

function change(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
}

const choice = (key: string) => control<HTMLSelectElement>(key, "select");
const optionLabels = (key: string) => [...choice(key).options].map((option) => option.textContent);

it("reads and edits each toggle kind as bare-key strings without mutating the supplied map", () => {
    const value = Object.freeze({ ooc: "1", style: "2", name: "Mira", notes: "First line\nSecond line" });
    const { onchange } = render(value);
    expect([...target.querySelectorAll("[data-ooc-toggle-name]")].map((node) => node.textContent)).toEqual([
        "OOC mode",
        "Answer style",
        "Speaker name",
        "Session notes",
    ]);
    // One select per row holds both "as in the chat" and the forced value.
    expect(target.querySelectorAll("select")).toHaveLength(4);
    expect(target.querySelector('input[type="checkbox"]')).toBeNull();
    expect(optionLabels("ooc")).toEqual(["As in the chat", "On", "Off"]);
    expect(choice("ooc").selectedOptions[0].textContent).toBe("On");
    expect(optionLabels("style")).toEqual(["As in the chat", "Brief", "Detailed", "Dialogue"]);
    expect(choice("style").selectedOptions[0].textContent).toBe("Dialogue");
    for (const key of ["name", "notes"]) {
        expect(optionLabels(key)).toEqual(["As in the chat", "Forced value"]);
        expect(choice(key).selectedOptions[0].textContent).toBe("Forced value");
    }
    expect(control<HTMLInputElement>("name", 'input[type="text"]').value).toBe("Mira");
    expect(control<HTMLTextAreaElement>("notes", "textarea").value).toBe("First line\nSecond line");
    expect(onchange).not.toHaveBeenCalled();

    change(choice("ooc"), choice("ooc").options[2].value);
    change(choice("style"), choice("style").options[2].value);
    change(control<HTMLInputElement>("name", 'input[type="text"]'), "Guide");
    change(control<HTMLTextAreaElement>("notes", "textarea"), "New line\nMore context");
    const emitted = onchange.mock.calls.map(([next]) => next);
    expect(emitted).toEqual([
        { ...value, ooc: "0" },
        { ...value, style: "1" },
        { ...value, name: "Guide" },
        { ...value, notes: "New line\nMore context" },
    ]);
    for (const next of emitted) expect(next).not.toBe(value);
    expect(value).toEqual({ ooc: "1", style: "2", name: "Mira", notes: "First line\nSecond line" });
});

it("forces an inherited toggle to the chosen option and removes the key when returning to the chat", () => {
    const value = Object.freeze({ unrelated: "keep" });
    const { props, onchange } = render(value);
    for (const [key, option, stored] of [
        ["ooc", 1, "1"],
        ["ooc", 2, "0"],
        ["style", 1, "0"],
        ["style", 3, "2"],
        ["name", 1, ""],
        ["notes", 1, ""],
    ] as const) {
        props.value = value;
        flushSync();
        expect(choice(key).selectedOptions[0].textContent).toBe("As in the chat");
        const row = choice(key).closest("[data-ooc-toggle]")!;
        expect(row.querySelector("input, textarea")).toBeNull();
        expect(row.querySelectorAll("select")).toHaveLength(1);
        change(choice(key), choice(key).options[option].value);
        const forced = onchange.mock.lastCall![0];
        expect(forced).toEqual({ unrelated: "keep", [key]: stored });
        expect(forced).not.toBe(value);
        props.value = forced;
        flushSync();
        expect(choice(key).selectedIndex).toBe(option);
        change(choice(key), choice(key).options[0].value);
        expect(onchange.mock.lastCall![0]).toEqual({ unrelated: "keep" });
        expect(onchange.mock.lastCall![0]).not.toBe(forced);
        expect(forced).toEqual({ unrelated: "keep", [key]: stored });
    }
    expect(onchange).toHaveBeenCalledTimes(12);
    expect(value).toEqual({ unrelated: "keep" });
});

it("keeps a forced value its toggle kind cannot show selected and distinct from the chat's value", () => {
    // A text value left on a toggle that became a checkbox, option indices the select no longer has, and a stored
    // value equal to the select's own "as in the chat" option value.
    const value = Object.freeze({ ooc: "chat", style: "7" });
    const { props, onchange } = render(value);
    expect(choice("ooc").selectedOptions[0].textContent).toBe("Off");
    expect(optionLabels("style")).toEqual(["As in the chat", "Brief", "Detailed", "Dialogue", "7"]);
    expect(choice("style").selectedOptions[0].textContent).toBe("7");
    props.value = { ...value, style: "chat" };
    flushSync();
    expect(choice("style").selectedOptions[0].textContent).toBe("chat");
    expect(choice("style").selectedIndex).toBe(4);
    props.value = { ...value, style: "length" };
    flushSync();
    expect(choice("style").selectedOptions[0].textContent).toBe("length");
    expect(onchange).not.toHaveBeenCalled();

    change(choice("style"), choice("style").options[1].value);
    expect(onchange.mock.lastCall![0]).toEqual({ ooc: "chat", style: "0" });
    props.value = onchange.mock.lastCall![0];
    flushSync();
    expect(optionLabels("style")).toEqual(["As in the chat", "Brief", "Detailed", "Dialogue"]);
    expect(choice("style").selectedOptions[0].textContent).toBe("Brief");
});

it("lists removed definitions as stale and removes each key without changing the other values", () => {
    const value = Object.freeze({ ooc: "0", retired: "1", oldNotes: "saved" });
    const { props, onchange } = render(value);
    props.definitionsText = "notes=Session notes=textarea";
    flushSync();
    const stale = target.querySelector("[data-ooc-stale-toggles]")!;
    expect([...stale.querySelectorAll("span")].map((node) => node.textContent)).toEqual(["ooc", "retired", "oldNotes"]);
    expect(onchange).not.toHaveBeenCalled();
    for (const key of ["ooc", "retired", "oldNotes"]) {
        stale.querySelector<HTMLButtonElement>(`button[aria-label="Remove stale OOC toggle: ${key}"]`)!.click();
        const expected: Record<string, string> = { ...value };
        delete expected[key];
        expect(onchange.mock.lastCall![0]).toEqual(expected);
        expect(onchange.mock.lastCall![0]).not.toBe(value);
    }
    expect(value).toEqual({ ooc: "0", retired: "1", oldNotes: "saved" });
    props.value = {};
    flushSync();
    expect(target.querySelector("[data-ooc-stale-toggles]")).toBeNull();
});
