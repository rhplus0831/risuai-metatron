// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The archive feature of the prompt preset list (the port of risuai-fastify `ee5382a9a`): `archived`
// is list metadata only. The header's view toggle switches between the active presets (the default,
// numbered as Ctrl+1..9 counts them) and the archived ones; a row's archive or restore control writes
// only `archived` by id, picks nothing, keeps the list open, and moves the focus to the toggle; an
// archived preset can still be picked from its view, and archiving leaves the tab's selection and the
// chats bound to it alone. The rows are the shown ones: drop slots and numbers count them, a drag
// carries the preset's id, a visibly unchanged drop moves nothing, and the diff picks go by id. The
// model list has none of it.

const mocks = vi.hoisted(() => ({
    confirm: vi.fn(),
    error: vi.fn(),
}));

vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: mocks.confirm,
        alertError: mocks.error,
    }),
);
// Reached through `stores.svelte.ts` and the preset functions' import path; nothing under test needs them.
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn(), globalFetch: vi.fn() }));

import { normalizeModelPreset, normalizeModelProfile, plainClone } from "../../../shared/presets.ts";
import { settings, activePreset } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase, installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import { selectCharacter, selection, selectModelPreset, selectPreset } from "src/ts/storage/selection.svelte";
import { setRecordWriteListener } from "src/ts/storage/records.svelte";
import { chatEntry, selectChat } from "src/ts/storage/chatStore.svelte";
import { RISU_PRESET_DRAG_TYPE } from "src/ts/dragTypes";
import { language } from "src/lang";
import Botpreset from "./botpreset.svelte";

const mounted: ReturnType<typeof mount>[] = [];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const template = [{ type: "plain", type2: "main", text: "main", role: "system" }];

/** `p1` and `p3` active, `p2` and `p4` archived, in that list order. */
function fixturePresets() {
    return [
        { id: "p1", name: "Prompt One", temperature: 80, promptTemplate: template },
        { id: "p2", name: "Prompt Two", temperature: 50, promptTemplate: template, archived: true },
        { id: "p3", name: "Prompt Three", temperature: 30, promptTemplate: template },
        { id: "p4", name: "Prompt Four", temperature: 20, promptTemplate: template, archived: true },
    ];
}

function render(kind: "prompt" | "model", chatRef?: { chaId: string; chatId: string }) {
    const close = vi.fn();
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(Botpreset, { target, props: { kind, close, chatRef } }));
    flushSync();
    const rows = () => [...target.querySelectorAll<HTMLButtonElement>("button[draggable]")];
    const rowTexts = () => rows().map((row) => row.textContent?.replace(/\s+/g, " ").trim());
    const rowNamed = (name: string) => {
        const row = rows().find((entry) => entry.textContent?.includes(name));
        expect(row, `Expected a row named ${name}`).toBeDefined();
        return row!;
    };
    const selectedNames = () =>
        rows()
            .filter((row) => row.classList.contains("bg-selected"))
            .map((row) => row.textContent?.replace(/\s+/g, " ").trim());
    const icon = (root: Element, name: string) =>
        root.querySelector<HTMLElement>(`.lucide-${name}`)?.parentElement ?? null;
    const toggle = () => target.querySelector<HTMLButtonElement>("[data-preset-archive-view]");
    const archiveControl = (name: string) => rowNamed(name).querySelector<HTMLElement>("[data-preset-archive-action]")!;
    const emptyState = () => target.querySelector("[data-preset-empty-state]")?.textContent?.trim() ?? null;
    /** The drop slots between the rows and after the last one, in order. */
    const slots = () => [...target.querySelectorAll<HTMLElement>("[role=listitem]")];
    return { target, close, rows, rowTexts, rowNamed, selectedNames, icon, toggle, archiveControl, emptyState, slots };
}

/** A preset drag's drop event, as the list reads it: the dragged preset's id under the preset type. */
function dropOf(id: string): Event {
    const event = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
    event.dataTransfer = {
        types: [RISU_PRESET_DRAG_TYPE],
        getData: (type: string) => (type === RISU_PRESET_DRAG_TYPE ? id : ""),
        setData: () => {},
        dropEffect: "none",
        effectAllowed: "all",
    };
    return event;
}

const ids = () => settings.presets.map((preset) => preset.id);

afterEach(() => {
    for (const instance of mounted.splice(0)) {
        unmount(instance);
    }
    document.body.innerHTML = "";
    vi.clearAllMocks();
    setRecordWriteListener(null);
});

describe("the prompt preset list's views", () => {
    beforeEach(() => {
        installFlatDatabase({
            characters: [],
            useLegacyGUI: false,
            showPromptComparison: true,
            botPresets: fixturePresets(),
            modelPresets: [normalizeModelPreset({ name: "Model One", mainSlot: { profileId: "gpt" } }, { id: "m1" })],
            modelProfiles: [normalizeModelProfile({ id: "gpt", name: "GPT", modelId: "gpt4o" })],
        } as any);
        selectPreset("p1");
        selectModelPreset("m1");
    });

    it("lists the active presets numbered by default, the archived ones unnumbered behind the toggle, and hides add, import, and the hint there", () => {
        const list = render("prompt");
        expect(list.rowTexts()).toEqual(["1 Prompt One", "2 Prompt Three"]);
        expect(list.toggle()?.getAttribute("aria-label")).toBe(language.showArchivedPromptPresets);
        expect(list.toggle()?.textContent?.trim()).toBe(language.archivedPromptPresets);
        expect(list.icon(list.target, "plus")).not.toBeNull();
        expect(list.icon(list.target, "hard-drive-upload")).not.toBeNull();
        expect(list.target.textContent).toContain(language.quickPreset);
        expect(list.emptyState()).toBeNull();
        // Each active row offers to archive, named after the preset.
        expect(list.archiveControl("Prompt One").getAttribute("aria-label")).toBe(
            `${language.archivePromptPreset}: Prompt One`,
        );
        expect(list.archiveControl("Prompt One").querySelector(".lucide-archive")).not.toBeNull();

        list.toggle()!.click();
        flushSync();
        expect(list.rowTexts()).toEqual(["Prompt Two", "Prompt Four"]);
        expect(list.toggle()?.getAttribute("aria-label")).toBe(language.showActivePromptPresets);
        expect(list.toggle()?.textContent?.trim()).toBe(language.activePromptPresets);
        expect(list.icon(list.target, "plus")).toBeNull();
        expect(list.icon(list.target, "hard-drive-upload")).toBeNull();
        // Rename (the pencil), export, copy, compare, and delete stay on the archived rows.
        expect(list.icon(list.target, "pencil")).not.toBeNull();
        for (const name of ["share-2", "copy", "git-compare", "trash"]) {
            expect(list.rowNamed("Prompt Two").querySelector(`.lucide-${name}`), name).not.toBeNull();
        }
        expect(list.target.textContent).not.toContain(language.quickPreset);
        expect(list.archiveControl("Prompt Two").getAttribute("aria-label")).toBe(
            `${language.restorePromptPreset}: Prompt Two`,
        );
        expect(list.archiveControl("Prompt Two").querySelector(".lucide-archive-restore")).not.toBeNull();

        list.toggle()!.click();
        flushSync();
        expect(list.rowTexts()).toEqual(["1 Prompt One", "2 Prompt Three"]);
    });

    it("shows an empty state per view once a view has no preset", () => {
        const list = render("prompt");
        list.archiveControl("Prompt One").click();
        flushSync();
        list.archiveControl("Prompt Three").click();
        flushSync();
        expect(list.rows()).toEqual([]);
        expect(list.emptyState()).toBe(language.noActivePromptPresets);
        expect(settings.presets.every((preset) => preset.archived === true)).toBe(true);

        list.toggle()!.click();
        flushSync();
        expect(list.rowTexts()).toEqual(["Prompt One", "Prompt Two", "Prompt Three", "Prompt Four"]);
        expect(list.emptyState()).toBeNull();
        for (const name of ["Prompt One", "Prompt Two", "Prompt Three", "Prompt Four"]) {
            list.archiveControl(name).click();
            flushSync();
        }
        expect(list.rows()).toEqual([]);
        expect(list.emptyState()).toBe(language.noArchivedPromptPresets);
        expect(settings.presets.map((preset) => preset.archived)).toEqual([false, false, false, false]);
    });

    it("the model list has no view toggle, no archive control, and lists every model preset", () => {
        const list = render("model");
        expect(list.toggle()).toBeNull();
        expect(list.target.querySelector("[data-preset-archive-action]")).toBeNull();
        expect(list.emptyState()).toBeNull();
        expect(list.rowTexts()).toEqual(["Model One"]);
    });
});

describe("the archive and restore control", () => {
    beforeEach(() => {
        installFlatDatabase({
            characters: [],
            useLegacyGUI: false,
            showPromptComparison: true,
            botPresets: fixturePresets(),
        } as any);
        selectPreset("p1");
    });

    it("writes only `archived` by id, queues the record's write, picks nothing, keeps the list open, and moves the focus to the toggle", () => {
        const list = render("prompt");
        const before = plainClone(settings.presets[0]);
        const written: string[] = [];
        setRecordWriteListener((kind) => written.push(kind));
        list.archiveControl("Prompt One").click();
        flushSync();
        expect(settings.presets[0].archived).toBe(true);
        expect(plainClone(settings.presets[0])).toEqual({ ...before, archived: true });
        expect(ids()).toEqual(["p1", "p2", "p3", "p4"]);
        expect(written).toEqual(["presets"]);
        // No pick: the selection and the view's preset stay, the list stays open.
        expect(selection.presetId).toBe("p1");
        expect(activePreset.id).toBe("p1");
        expect(list.close).not.toHaveBeenCalled();
        // The row left the view (renumbered), and the focus is on the toggle, not a reused control.
        expect(list.rowTexts()).toEqual(["1 Prompt Three"]);
        expect(document.activeElement).toBe(list.toggle());

        list.toggle()!.click();
        flushSync();
        expect(list.rowTexts()).toEqual(["Prompt One", "Prompt Two", "Prompt Four"]);
        // The archived selected preset is marked as such in its view.
        expect(list.selectedNames()).toEqual(["Prompt One"]);
        list.archiveControl("Prompt One").click();
        flushSync();
        expect(settings.presets[0].archived).toBe(false);
        expect(written).toEqual(["presets", "presets"]);
        expect(list.rowTexts()).toEqual(["Prompt Two", "Prompt Four"]);
        expect(document.activeElement).toBe(list.toggle());
        list.toggle()!.click();
        flushSync();
        expect(list.rowTexts()).toEqual(["1 Prompt One", "2 Prompt Three"]);
        expect(selection.presetId).toBe("p1");
    });

    it("works from the keyboard with Enter and Space without activating the row", () => {
        const list = render("prompt");
        for (const [name, key] of [
            ["Prompt One", "Enter"],
            ["Prompt Three", " "],
        ] as const) {
            const control = list.archiveControl(name);
            control.focus();
            const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
            control.dispatchEvent(event);
            flushSync();
            expect(event.defaultPrevented, key).toBe(true);
        }
        expect(settings.presets.map((preset) => preset.archived)).toEqual([true, true, true, true]);
        expect(selection.presetId).toBe("p1");
        expect(list.close).not.toHaveBeenCalled();
        expect(list.emptyState()).toBe(language.noActivePromptPresets);
    });

    it("an archived preset can still be picked from the archived view", () => {
        const list = render("prompt");
        list.toggle()!.click();
        flushSync();
        list.rowNamed("Prompt Two").click();
        flushSync();
        expect(selection.presetId).toBe("p2");
        expect(activePreset.temperature).toBe(50);
        expect(settings.presets[1].archived).toBe(true);
        expect(list.close).toHaveBeenCalledTimes(1);
    });

    it("deleting the selected preset moves the selection to an active one, else to any other", async () => {
        const list = render("prompt");
        mocks.confirm.mockResolvedValue(true);
        list.icon(list.rowNamed("Prompt One"), "trash")!.click();
        await settle();
        flushSync();
        expect(ids()).toEqual(["p2", "p3", "p4"]);
        // `p2`, first in the list, is archived: the active `p3` is the next selection.
        expect(selection.presetId).toBe("p3");
        expect(list.rowTexts()).toEqual(["1 Prompt Three"]);

        list.icon(list.rowNamed("Prompt Three"), "trash")!.click();
        await settle();
        flushSync();
        expect(ids()).toEqual(["p2", "p4"]);
        // Only archived presets remain: the first other one is selected.
        expect(selection.presetId).toBe("p2");
        expect(list.emptyState()).toBe(language.noActivePromptPresets);
    });
});

describe("the list with a chat bound to an archived preset", () => {
    const chat = (id: string, fields: Record<string, unknown> = {}) => ({
        id,
        name: id.toUpperCase(),
        note: "",
        localLore: [],
        message: [{ role: "char", data: "hi", chatId: `m-${id}` }],
        ...fields,
    });
    const refK = { chaId: "c", chatId: "k" };

    beforeEach(() => {
        installFlatDatabaseWithChats({
            characters: [
                {
                    chaId: "c",
                    type: "character",
                    name: "C",
                    chatPage: 0,
                    chats: [chat("k", { promptPresetId: "p3" })],
                },
            ],
            useLegacyGUI: false,
            showPromptComparison: true,
            botPresets: fixturePresets(),
        } as any);
        selectPreset("p1");
        selectCharacter("c");
        selectChat("c", "k");
    });

    afterEach(() => {
        selectCharacter(null);
    });

    it("archiving the chat's preset leaves the binding and the tab's selection; the mark follows the preset into the archived view", () => {
        const list = render("prompt");
        expect(list.selectedNames()).toEqual(["2 Prompt Three"]);
        list.archiveControl("Prompt Three").click();
        flushSync();
        expect(chatEntry(refK)).toMatchObject({ promptPresetId: "p3" });
        expect(selection.presetId).toBe("p1");
        expect(activePreset.id).toBe("p3");
        expect(list.selectedNames()).toEqual([]);
        expect(list.rowTexts()).toEqual(["1 Prompt One"]);

        list.toggle()!.click();
        flushSync();
        expect(list.selectedNames()).toEqual(["Prompt Three"]);
        // A pick from the archived view binds the chat, as from the active one.
        list.rowNamed("Prompt Two").click();
        flushSync();
        expect(chatEntry(refK)).toMatchObject({ promptPresetId: "p2" });
        expect(selection.presetId).toBe("p1");
        expect(list.close).toHaveBeenCalledTimes(1);
    });
});

describe("reorder, comparison, and rename over the shown rows", () => {
    beforeEach(() => {
        installFlatDatabase({
            characters: [],
            useLegacyGUI: false,
            showPromptComparison: true,
            botPresets: fixturePresets(),
        } as any);
        selectPreset("p1");
    });

    it("a drop lands before the shown row under it, or after the last shown one, keeping the hidden rows' relative places", () => {
        const list = render("prompt");
        // The slots: before `Prompt One`, before `Prompt Three`, and after the last shown row.
        expect(list.slots()).toHaveLength(3);
        list.slots()[2].dispatchEvent(dropOf("p1"));
        flushSync();
        expect(ids()).toEqual(["p2", "p3", "p1", "p4"]);
        expect(list.rowTexts()).toEqual(["1 Prompt Three", "2 Prompt One"]);

        // Back before `Prompt Three` (real index 1): the hidden `p2` keeps its place at the front.
        list.slots()[0].dispatchEvent(dropOf("p1"));
        flushSync();
        expect(ids()).toEqual(["p2", "p1", "p3", "p4"]);
        expect(list.rowTexts()).toEqual(["1 Prompt One", "2 Prompt Three"]);

        // The archived view reorders the archived rows the same way.
        list.toggle()!.click();
        flushSync();
        expect(list.rowTexts()).toEqual(["Prompt Two", "Prompt Four"]);
        list.slots()[2].dispatchEvent(dropOf("p2"));
        flushSync();
        expect(ids()).toEqual(["p1", "p3", "p4", "p2"]);
        expect(list.rowTexts()).toEqual(["Prompt Four", "Prompt Two"]);
        list.toggle()!.click();
        flushSync();
        expect(list.rowTexts()).toEqual(["1 Prompt One", "2 Prompt Three"]);
    });

    it("a drop that leaves the shown order as it is, or whose preset left the view, moves nothing and queues no write", () => {
        const list = render("prompt");
        const written: string[] = [];
        setRecordWriteListener((kind) => written.push(kind));
        // Onto its own slot, and onto the slot right after it: the shown order would not change, so
        // the hidden `p2` must not move either (it would, by the real indexes).
        for (const slot of [0, 1]) {
            list.slots()[slot].dispatchEvent(dropOf("p1"));
            flushSync();
            expect(ids(), `slot ${slot}`).toEqual(["p1", "p2", "p3", "p4"]);
        }
        for (const slot of [1, 2]) {
            list.slots()[slot].dispatchEvent(dropOf("p3"));
            flushSync();
            expect(ids(), `slot ${slot}`).toEqual(["p1", "p2", "p3", "p4"]);
        }
        // A dragged preset that is no longer shown (archived meanwhile), or unknown, is not moved.
        list.slots()[0].dispatchEvent(dropOf("p4"));
        list.slots()[0].dispatchEvent(dropOf("gone"));
        flushSync();
        expect(ids()).toEqual(["p1", "p2", "p3", "p4"]);
        expect(written).toEqual([]);
    });

    it("the comparison picks by id across the views, resolved when the modal opens, and a gone pick cancels", () => {
        const list = render("prompt");
        list.icon(list.rowNamed("Prompt One"), "git-compare")!.click();
        flushSync();
        expect(list.target.querySelector(".z-50")).toBeNull();
        // The first pick stays marked through a view change and a reorder.
        list.toggle()!.click();
        flushSync();
        settings.presets.reverse();
        flushSync();
        expect(list.rowTexts()).toEqual(["Prompt Four", "Prompt Two"]);
        list.icon(list.rowNamed("Prompt Two"), "git-compare")!.click();
        flushSync();
        expect(list.target.querySelector(".z-50")).not.toBeNull();
        expect(list.close).not.toHaveBeenCalled();
        list.icon(list.target.querySelector(".z-50")!, "x")!.click();
        flushSync();
        expect(list.target.querySelector(".z-50")).toBeNull();

        // A first pick deleted before the second: nothing opens, and the picks are cleared.
        list.toggle()!.click();
        flushSync();
        list.icon(list.rowNamed("Prompt Three"), "git-compare")!.click();
        flushSync();
        settings.presets.splice(
            settings.presets.findIndex((preset) => preset.id === "p3"),
            1,
        );
        flushSync();
        list.icon(list.rowNamed("Prompt One"), "git-compare")!.click();
        flushSync();
        expect(list.target.querySelector(".z-50")).toBeNull();
    });

    it("a remote archive of the preset being renamed moves the focus to the toggle instead of retargeting the input", () => {
        const list = render("prompt");
        list.icon(list.target, "pencil")!.click();
        flushSync();
        const inputs = () => [...list.target.querySelectorAll<HTMLInputElement>("input")];
        expect(inputs().map((input) => input.value)).toEqual(["Prompt One", "Prompt Three"]);
        const renamed = inputs()[0];
        renamed.focus();
        expect(document.activeElement).toBe(renamed);

        // Another tab archives `p1` while this one renames it: in the same update the editor the
        // user was typing in is gone (not re-bound to `Prompt Three`) and the focus is on the toggle,
        // so the next keystroke cannot land on another preset.
        settings.presets[0].archived = true;
        flushSync();
        expect(document.activeElement).toBe(list.toggle());
        expect(renamed.isConnected).toBe(false);
        const remaining = inputs();
        expect(remaining.map((input) => input.value)).toEqual(["Prompt Three"]);
        expect(remaining[0]).not.toBe(renamed);
        expect(settings.presets.map((preset) => preset.name)).toEqual([
            "Prompt One",
            "Prompt Two",
            "Prompt Three",
            "Prompt Four",
        ]);

        // A local rename still lands on its own preset, and keeps its focus.
        const next = remaining[0];
        next.focus();
        next.value = "Three renamed";
        next.dispatchEvent(new Event("input"));
        flushSync();
        expect(settings.presets[2].name).toBe("Three renamed");
        expect(document.activeElement).toBe(next);
        // A restore elsewhere (`p1` shown again, before the row in use) gives the rows new editors
        // (the list is unkeyed; the editor is keyed by the preset): the focus is dropped, never moved
        // onto the other preset's editor.
        settings.presets[0].archived = false;
        flushSync();
        expect(inputs().map((input) => input.value)).toEqual(["Prompt One", "Three renamed"]);
        expect(next.isConnected).toBe(false);
        expect(document.activeElement).not.toBe(inputs()[0]);
    });
});
