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

function openEditMode() {
    installFlatDatabase({
        enabledModules: [],
        modules: [
            { id: "before", name: "Before", description: "keep before" },
            { id: "edited", name: "Edited", description: "original" },
            { id: "after", name: "After", description: "keep after" },
        ],
    });
    target = document.createElement("div");
    document.body.append(target);
    instance = mount(ModuleSettings, { target });
    flushSync();
    const row = [...target.querySelectorAll("span.text-lg")].find(
        (span) => span.textContent === "Edited",
    )!.parentElement!;
    row.querySelector<HTMLButtonElement>("button:has(.lucide-square-pen)")!.click();
    flushSync();
    expect(target.querySelector("h2")?.textContent).toBe(language.editModule);
}

const moduleNames = () => settings.modules.map(({ id, name }) => ({ id, name }));

it("saves live to the module id across removal, insertion, and a replacement copy without overwriting or duplicating modules", async () => {
    openEditMode();
    typeName("Live edit");
    expect(settings.modules.find((module) => module.id === "edited")?.name).toBe("Live edit");

    settings.modules.splice(0, 1);
    flushSync();
    typeName("After removal");
    expect(moduleNames()).toEqual([
        { id: "edited", name: "After removal" },
        { id: "after", name: "After" },
    ]);

    settings.modules.unshift({ id: "inserted", name: "Inserted", description: "keep inserted" });
    flushSync();
    typeName("After insertion");
    expect(moduleNames()).toEqual([
        { id: "inserted", name: "Inserted" },
        { id: "edited", name: "After insertion" },
        { id: "after", name: "After" },
    ]);

    // A whole-list refresh carries new objects and moves the edited module to another position.
    settings.modules = [
        { id: "after", name: "After", description: "keep after" },
        { id: "inserted", name: "Inserted", description: "keep inserted" },
        { id: "edited", name: "Remote name", description: "remote description" },
    ];
    flushSync();
    expect(target.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("Remote name");
    typeName("After refresh");
    const expected = [
        { id: "after", name: "After" },
        { id: "inserted", name: "Inserted" },
        { id: "edited", name: "After refresh" },
    ];
    expect(moduleNames()).toEqual(expected);
    expect(settings.modules.map((module) => module.description)).toEqual([
        "keep after",
        "keep inserted",
        "remote description",
    ]);
    finalButton().click();
    flushSync();
    expect(moduleNames()).toEqual(expected);

    // Leaving the settings page also keeps the live edit, without a final button click.
    [...target.querySelectorAll("span.text-lg")]
        .find((span) => span.textContent === "After refresh")!
        .parentElement!.querySelector<HTMLButtonElement>("button:has(.lucide-square-pen)")!
        .click();
    flushSync();
    typeName("Kept on leave");
    await unmount(instance!);
    instance = null;
    expect(settings.modules.find((module) => module.id === "edited")?.name).toBe("Kept on leave");
});

it("returns to the catalog without writing when the edited module is deleted", () => {
    openEditMode();
    settings.modules.splice(1, 1);
    flushSync();

    expect(target.querySelector("h2")?.textContent).toBe(language.modules);
    expect(finalButton()).toBeNull();
    expect(moduleNames()).toEqual([
        { id: "before", name: "Before" },
        { id: "after", name: "After" },
    ]);
    expect(settings.modules.map((module) => module.description)).toEqual(["keep before", "keep after"]);
});
