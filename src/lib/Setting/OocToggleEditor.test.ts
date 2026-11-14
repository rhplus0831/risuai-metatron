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
    const found = target.querySelector<T>(`fieldset[data-ooc-toggle="${key}"] ${selector}`);
    expect(found, `${key}: ${selector}`).not.toBeNull();
    return found!;
}

function change(input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
}

it("reads and edits each toggle kind as bare-key strings without mutating the supplied map", () => {
    const value = Object.freeze({ ooc: "1", style: "2", name: "Mira", notes: "First line\nSecond line" });
    const { onchange } = render(value);
    expect([...target.querySelectorAll("legend")].map((node) => node.textContent)).toEqual([
        "OOC mode",
        "Answer style",
        "Speaker name",
        "Session notes",
    ]);
    for (const key of Object.keys(value)) expect(control<HTMLSelectElement>(key, "select").value).toBe("forced");
    expect(control<HTMLInputElement>("ooc", 'input[type="checkbox"]').checked).toBe(true);
    const select = control<HTMLSelectElement>("style", "select:last-child");
    expect(select.value).toBe("2");
    expect(select.selectedOptions[0].textContent).toBe("Dialogue");
    expect(control<HTMLInputElement>("name", 'input[type="text"]').value).toBe("Mira");
    expect(control<HTMLTextAreaElement>("notes", "textarea").value).toBe("First line\nSecond line");
    expect(onchange).not.toHaveBeenCalled();

    control<HTMLInputElement>("ooc", 'input[type="checkbox"]').click();
    flushSync();
    change(select, "1");
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

it("starts inherited toggles at their forced defaults and removes keys when returning to the chat", () => {
    const value = Object.freeze({ unrelated: "keep" });
    const { props, onchange } = render(value);
    for (const [key, initial] of [
        ["ooc", "1"],
        ["style", "0"],
        ["name", ""],
        ["notes", ""],
    ]) {
        props.value = value;
        flushSync();
        const mode = control<HTMLSelectElement>(key, "select");
        expect(mode.selectedOptions[0].textContent).toBe("As in the chat");
        const row = mode.closest("fieldset")!;
        expect(row.querySelector("input, textarea")).toBeNull();
        expect(row.querySelectorAll("select")).toHaveLength(1);
        change(mode, "forced");
        const forced = onchange.mock.lastCall![0];
        expect(forced).toEqual({ unrelated: "keep", [key]: initial });
        expect(forced).not.toBe(value);
        props.value = forced;
        flushSync();
        expect(control<HTMLSelectElement>(key, "select").value).toBe("forced");
        change(control<HTMLSelectElement>(key, "select"), "chat");
        expect(onchange.mock.lastCall![0]).toEqual({ unrelated: "keep" });
        expect(onchange.mock.lastCall![0]).not.toBe(forced);
        expect(forced).toEqual({ unrelated: "keep", [key]: initial });
    }
    expect(onchange).toHaveBeenCalledTimes(8);
    expect(value).toEqual({ unrelated: "keep" });
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
