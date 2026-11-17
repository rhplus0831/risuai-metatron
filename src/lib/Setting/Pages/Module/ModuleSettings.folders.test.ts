// @vitest-environment happy-dom
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
import { alertConfirm, alertSelect } from "src/ts/alert";
import { language } from "src/lang";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { settings } from "src/ts/storage/settingsViews.svelte";
import ModuleSettings from "./ModuleSettings.svelte";

let instance: ReturnType<typeof mount> | null = null;
let target: HTMLDivElement;

afterEach(async () => {
    if (instance) await unmount(instance);
    instance = null;
    target?.remove();
    localStorage.removeItem("risu-module-folders-folded");
    vi.restoreAllMocks();
});

it("files a module through its move button and returns its surviving modules to the root when the folder is deleted", async () => {
    const modules = [
        { id: "alpha", name: "Alpha", description: "Keep Alpha content" },
        { id: "beta", name: "Beta", description: "Keep Beta content" },
    ];
    installFlatDatabase({
        modules,
        moduleFolders: [{ id: "tools", name: "Tools", data: [] }],
        enabledModules: ["beta"],
    });
    localStorage.removeItem("risu-module-folders-folded");
    target = document.createElement("div");
    document.body.append(target);
    instance = mount(ModuleSettings, { target });
    flushSync();

    const names = () => [...target.querySelectorAll("span.text-lg")].map((row) => row.textContent);
    const folderToggle = () => target.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    const alphaRow = [...target.querySelectorAll("span.text-lg")].find(
        (row) => row.textContent === "Alpha",
    )!.parentElement!;
    vi.mocked(alertSelect).mockResolvedValueOnce("0");
    alphaRow.querySelector<HTMLButtonElement>("button:has(.lucide-folder-input)")!.click();
    await tick();
    flushSync();

    expect(alertSelect).toHaveBeenCalledWith(
        ["Tools", language.itemFolders.noFolder],
        language.itemFolders.moveToWhich,
    );
    expect(settings.moduleFolders).toEqual([{ id: "tools", name: "Tools", data: ["alpha"] }]);
    expect(names()).toEqual(["Alpha", "Beta"]);
    expect(folderToggle().textContent).toContain("Tools");
    expect(folderToggle().textContent).toContain("1");

    // Folding the destination hides only the filed module, proving it renders under that folder.
    folderToggle().click();
    flushSync();
    expect(names()).toEqual(["Beta"]);
    folderToggle().click();
    flushSync();
    expect(names()).toEqual(["Alpha", "Beta"]);

    vi.mocked(alertConfirm).mockResolvedValueOnce(true);
    folderToggle().parentElement!.querySelector<HTMLButtonElement>("button:has(.lucide-trash)")!.click();
    await tick();
    flushSync();

    expect(alertConfirm).toHaveBeenCalledWith(language.itemFolders.removeModuleFolderConfirm);
    expect(settings.moduleFolders).toEqual([]);
    expect(folderToggle()).toBeNull();
    expect(names()).toEqual(["Alpha", "Beta"]);
    expect(settings.modules).toEqual(modules);
    expect(settings.enabledModules).toEqual(["beta"]);
});
