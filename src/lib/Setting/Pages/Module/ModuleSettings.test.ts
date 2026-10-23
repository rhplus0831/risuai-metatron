// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it } from "vitest";
import { language } from "src/lang";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { settings } from "src/ts/storage/settingsViews.svelte";
import ModuleSettings from "./ModuleSettings.svelte";

let instance: ReturnType<typeof mount> | null = null;
let target: HTMLDivElement;

afterEach(async () => {
    if (instance) await unmount(instance);
    instance = null;
    target.remove();
});

it("renders modules with a missing name and sorts that name as an empty string", () => {
    installFlatDatabase({
        enabledModules: [],
        modules: [
            { id: "z", name: "Zulu", description: "" },
            { id: "unnamed", description: "" },
            { id: "a", name: "alpha", description: "" },
        ],
    });
    target = document.createElement("div");
    document.body.append(target);

    expect(() => {
        instance = mount(ModuleSettings, { target });
        flushSync();
    }).not.toThrow();
    const rows = [...target.querySelectorAll("span.text-lg")];
    expect(rows).toHaveLength(3);
    expect(rows.slice(1).map((row) => row.textContent)).toEqual(["alpha", "Zulu"]);
});

function openCreateMode() {
    installFlatDatabase({ enabledModules: [], modules: [] });
    target = document.createElement("div");
    document.body.append(target);
    instance = mount(ModuleSettings, { target });
    flushSync();

    // The empty catalog's first button is the bottom bar's + control.
    target.querySelector<HTMLButtonElement>("button")!.click();
    flushSync();
    expect(target.querySelector("h2")?.textContent).toBe(language.createModule);
}

function typeName(name: string) {
    const input = target.querySelector<HTMLInputElement>('input[type="text"]')!;
    input.value = name;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
}

const finalButton = () => target.querySelector<HTMLButtonElement>("button.mt-6")!;

it("adds exactly one module with the edited name only after confirmation", () => {
    openCreateMode();
    expect(settings.modules).toHaveLength(0);

    const name = "My new module";
    typeName(name);
    expect(settings.modules).toHaveLength(0);
    expect(finalButton().textContent?.trim()).toBe(language.createModule);

    finalButton().click();
    flushSync();

    expect(settings.modules).toHaveLength(1);
    expect(settings.modules[0].name).toBe(name);
    expect(target.querySelector("h2")?.textContent).toBe(language.modules);
    expect([...target.querySelectorAll("span.text-lg")].map((row) => row.textContent)).toEqual([name]);
});

it("labels an untouched draft Cancel and returns to the list without adding it", () => {
    openCreateMode();

    // Keep the real ModuleMenu: its checkbox binding writes hideIcon: false on mount.
    expect(settings.modules).toHaveLength(0);
    expect(finalButton().textContent?.trim()).toBe(language.cancel);
    finalButton().click();
    flushSync();

    expect(settings.modules).toHaveLength(0);
    expect(target.querySelector("h2")?.textContent).toBe(language.modules);
    expect(target.textContent).toContain(language.noModules);
});

it("discards an edited draft when the page unmounts without confirmation", async () => {
    openCreateMode();
    typeName("Unconfirmed module");

    await unmount(instance!);
    instance = null;

    expect(settings.modules).toHaveLength(0);
});
