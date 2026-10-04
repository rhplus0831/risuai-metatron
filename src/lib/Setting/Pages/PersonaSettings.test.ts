// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6 slice 6 (`docs/plan/phases/slices/phase-6-thin-client-and-closeout/readers-settings-pages.md`,
// "After the challenge"): the persona page binds the selected persona through `activePersona`. The
// large-portrait checkbox is the one control that keeps its old index binding's rule: it writes the
// persona the selection resolves to (the first one when the selection names none), where
// `activePersona`'s setter would drop the write. The name and description inputs write the selected
// persona through the view, and follow a selection change.

vi.mock("src/ts/alert", () => ({
    alertConfirm: vi.fn(),
    alertSelect: vi.fn(),
    alertError: vi.fn(),
    alertNormal: vi.fn(),
}));
vi.mock("src/ts/characters", () => ({ getCharImage: vi.fn(async () => "") }));
vi.mock("src/ts/persona", () => ({
    changeUserPersona: vi.fn(),
    exportUserPersona: vi.fn(),
    importUserPersona: vi.fn(),
    selectUserImg: vi.fn(),
}));
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));

import { DBState } from "src/ts/stores.svelte";
import { setDatabaseLite, type Database } from "src/ts/storage/database.svelte";
import { selection, selectPersona, selectPreset } from "src/ts/storage/selection.svelte";
import PersonaSettings from "./PersonaSettings.svelte";

const mounted: ReturnType<typeof mount>[] = [];
const persona = (id: string) =>
    (DBState.db.personas as unknown as Record<string, unknown>[]).find((entry) => entry.id === id)!;

function render() {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(PersonaSettings, { target }));
    flushSync();
    const largePortrait = () => target.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    const nameInput = () => target.querySelector<HTMLInputElement>('input[placeholder="User"]')!;
    return { target, largePortrait, nameInput };
}

function toggle(box: HTMLInputElement, checked: boolean) {
    box.checked = checked;
    box.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    selectPreset("");
    selectPersona("");
    setDatabaseLite({
        characters: [],
        personas: [
            { id: "p1", name: "Ann", icon: "", note: "", personaPrompt: "", largePortrait: false },
            { id: "p2", name: "Bob", icon: "", note: "", personaPrompt: "", largePortrait: false },
        ],
    } as unknown as Database);
    selectPersona("p2");
});

afterEach(async () => {
    await Promise.all(mounted.splice(0).map((instance) => unmount(instance)));
    document.body.replaceChildren();
    DBState.db = {} as Database;
});

describe("PersonaSettings", () => {
    it("the name input and the large-portrait checkbox write the selected persona and follow a selection change", () => {
        const { largePortrait, nameInput } = render();
        expect(nameInput().value).toBe("Bob");
        expect(largePortrait()).not.toBeNull();

        toggle(largePortrait(), true);
        expect(persona("p2").largePortrait).toBe(true);
        expect(persona("p1").largePortrait).toBe(false);
        nameInput().value = "Bobby";
        nameInput().dispatchEvent(new Event("input", { bubbles: true }));
        expect(persona("p2").name).toBe("Bobby");

        selectPersona("p1");
        flushSync();
        expect(nameInput().value).toBe("Ann");
        expect(largePortrait().checked).toBe(false);
    });

    it("the large-portrait checkbox writes the persona the selection resolves to when the selected one is gone (challenge point 1)", () => {
        const { largePortrait } = render();
        // The selected persona disappears and the checkbox changes before anything reads the selection again.
        selectPersona("gone");
        toggle(largePortrait(), true);
        expect(persona("p1").largePortrait).toBe(true);
        expect(persona("p2").largePortrait).toBe(false);
        expect(selection.personaId).toBe("p1");
    });
});
