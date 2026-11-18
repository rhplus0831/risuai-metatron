// @vitest-environment happy-dom
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
import { alertConfirm, alertSelect } from "src/ts/alert";
import { language } from "src/lang";
import { setModules } from "src/ts/storage/collectionStore.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { settings } from "src/ts/storage/settingsViews.svelte";
import ModuleSettings from "./ModuleSettings.svelte";

let instance: ReturnType<typeof mount> | null = null;
let target: HTMLDivElement;

function renderCatalog() {
    localStorage.removeItem("risu-module-folders-folded");
    target = document.createElement("div");
    document.body.append(target);
    instance = mount(ModuleSettings, { target });
    flushSync();
}

const moduleNames = () => [...target.querySelectorAll("span.text-lg")].map((row) => row.textContent);
const moduleRow = (name: string) =>
    [...target.querySelectorAll("span.text-lg")].find((row) => row.textContent === name)!.parentElement!;
const folderToggle = () => target.querySelector<HTMLButtonElement>("button[aria-expanded]")!;

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
    renderCatalog();

    vi.mocked(alertSelect).mockResolvedValueOnce("0");
    moduleRow("Alpha").querySelector<HTMLButtonElement>("button:has(.lucide-folder-input)")!.click();
    await tick();
    flushSync();

    expect(alertSelect).toHaveBeenCalledWith(
        ["Tools", language.itemFolders.noFolder],
        language.itemFolders.moveToWhich,
    );
    expect(settings.moduleFolders).toEqual([{ id: "tools", name: "Tools", data: ["alpha"] }]);
    expect(moduleNames()).toEqual(["Alpha", "Beta"]);
    expect(folderToggle().textContent).toContain("Tools");
    expect(folderToggle().textContent).toContain("1");

    // Folding the destination hides only the filed module, proving it renders under that folder.
    folderToggle().click();
    flushSync();
    expect(moduleNames()).toEqual(["Beta"]);
    folderToggle().click();
    flushSync();
    expect(moduleNames()).toEqual(["Alpha", "Beta"]);

    vi.mocked(alertConfirm).mockResolvedValueOnce(true);
    folderToggle().parentElement!.querySelector<HTMLButtonElement>("button:has(.lucide-trash)")!.click();
    await tick();
    flushSync();

    expect(alertConfirm).toHaveBeenCalledWith(language.itemFolders.removeModuleFolderConfirm);
    expect(settings.moduleFolders).toEqual([]);
    expect(folderToggle()).toBeNull();
    expect(moduleNames()).toEqual(["Alpha", "Beta"]);
    expect(settings.modules).toEqual(modules);
    expect(settings.enabledModules).toEqual(["beta"]);
});

it("deletes the confirmed module row and keeps the other row with the same ID filed and enabled", async () => {
    installFlatDatabase({
        moduleFolders: [{ id: "filed", name: "Filed", data: [] }],
        enabledModules: ["same"],
    });
    setModules([
        { id: "same", name: "First edition" },
        { id: "same", name: "Second edition" },
    ]);
    renderCatalog();

    vi.mocked(alertSelect).mockResolvedValueOnce("0");
    moduleRow("Second edition").querySelector<HTMLButtonElement>("button:has(.lucide-folder-input)")!.click();
    await tick();
    flushSync();

    expect(moduleNames()).toEqual(["First edition", "Second edition"]);
    folderToggle().click();
    flushSync();
    expect(moduleNames()).toEqual([]);
    folderToggle().click();
    flushSync();

    vi.mocked(alertConfirm).mockResolvedValueOnce(true);
    moduleRow("Second edition").querySelector<HTMLButtonElement>("button:has(.lucide-trash)")!.click();
    await tick();
    flushSync();

    expect(alertConfirm).toHaveBeenLastCalledWith(`${language.removeConfirm}Second edition`);
    expect(moduleNames()).toEqual(["First edition"]);
    expect(settings.moduleFolders[0].data).toEqual(["same"]);
    expect(settings.enabledModules).toEqual(["same"]);
});
