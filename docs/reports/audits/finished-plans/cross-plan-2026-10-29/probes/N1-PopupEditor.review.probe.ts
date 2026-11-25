// @vitest-environment happy-dom
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { openPopupEditorSession, popUpEditorStore } from "src/ts/stores.svelte";
import { language } from "src/lang";
import PopupEditor from "./PopupEditor.svelte";
let instance: ReturnType<typeof mount> | undefined;
afterEach(async () => {
    if (instance) await unmount(instance);
    document.body.replaceChildren();
});
it("observes text and selection after a textarea to Monaco to textarea round trip", async () => {
    installFlatDatabase({ characters: [] });
    localStorage.setItem("risu-popup-editor-monaco", "false");
    openPopupEditorSession("alpha beta gamma", "plaintext");
    const target = document.createElement("div");
    document.body.append(target);
    instance = mount(PopupEditor, { target });
    flushSync();
    let area = target.querySelector("textarea")!;
    area.setSelectionRange(6, 10);
    console.log("BEFORE", area.value, area.selectionStart, area.selectionEnd);
    const checkbox = target.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    // Load the same real Monaco component the popup imports; no browser editor mock.
    await import("./MonacoEditor.svelte");
    await tick();
    flushSync();
    console.log("MONACO", !!target.querySelector(".monaco-editor"), target.textContent?.includes(language.loading));
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    area = target.querySelector("textarea")!;
    console.log("AFTER", area.value, area.selectionStart, area.selectionEnd);
    expect(area.value).toBe(popUpEditorStore.value);
    expect([area.selectionStart, area.selectionEnd]).toEqual([6, 10]);
});
it("observes whether Monaco undo survives a mode round trip", async () => {
    installFlatDatabase({ characters: [] });
    localStorage.setItem("risu-popup-editor-monaco", "false");
    openPopupEditorSession("original", "plaintext");
    const target = document.createElement("div");
    document.body.append(target);
    instance = mount(PopupEditor, { target });
    flushSync();
    const checkbox = target.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    const toggle = async (checked: boolean) => {
        checkbox.checked = checked;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
        flushSync();
        if (checked) await import("./MonacoEditor.svelte");
        await tick();
        flushSync();
    };
    await toggle(true);
    const monaco = await import("monaco-editor");
    const old = monaco.editor.getModels().find((model) => model.getValue() === "original")!;
    old.pushStackElement();
    old.pushEditOperations([], [{ range: old.getFullModelRange(), text: "replacement" }], () => null);
    old.pushStackElement();
    flushSync();
    console.log("EDIT", popUpEditorStore.value, "undo before", (old as any).canUndo());
    await toggle(false);
    expect(target.querySelector("textarea")!.value).toBe("replacement");
    await toggle(true);
    const fresh = monaco.editor.getModels().find((model) => model.getValue() === "replacement")!;
    console.log(
        "REMOUNT",
        "same model",
        fresh === old,
        "old disposed",
        old.isDisposed(),
        "undo after",
        (fresh as any).canUndo(),
    );
    await (fresh as any).undo();
    flushSync();
    console.log("AFTER UNDO", popUpEditorStore.value);
    expect(popUpEditorStore.value).toBe("original");
});
