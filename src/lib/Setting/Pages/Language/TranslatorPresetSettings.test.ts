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

import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
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
