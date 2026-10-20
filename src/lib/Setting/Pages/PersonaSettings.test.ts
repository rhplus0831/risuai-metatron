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
// `persona.ts` pulls the PNG and inlay code in; its `changeUserPersona` is one line over `pickBinding`,
// which the slice 5 tests below reach through the page.
vi.mock("src/ts/persona", async () => {
    const { pickBinding } = await import("src/ts/storage/chatBindingPick");
    return {
        changeUserPersona: vi.fn((id: string, target?: { chaId: string; chatId: string } | null) =>
            pickBinding("personaId", id, target),
        ),
        exportUserPersona: vi.fn(),
        importUserPersona: vi.fn(),
        selectUserImg: vi.fn(),
    };
});
vi.mock("src/ts/globalApi.svelte", () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }));
vi.mock("src/ts/process/modules", () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleAssets: vi.fn(() => []),
}));
vi.mock("src/ts/parser/parser.svelte", () => ({ risuChatParser: vi.fn((text: string) => text) }));

import { language } from "src/lang";
import { alertConfirm, alertSelect } from "src/ts/alert";
import { chatBindingPatch } from "src/ts/storage/chatBinding.svelte";
import { chatEntry, selectChat } from "src/ts/storage/chatStore.svelte";
import type { Database } from "src/ts/storage/database.svelte";
import { selectCharacter, selection, selectPersona, selectPreset } from "src/ts/storage/selection.svelte";
import { activePersona, settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase, installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import PersonaSettings from "./PersonaSettings.svelte";

const mounted: ReturnType<typeof mount>[] = [];
const persona = (id: string) =>
    (settings.personas as unknown as Record<string, unknown>[]).find((entry) => entry.id === id)!;

function render() {
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(mount(PersonaSettings, { target }));
    flushSync();
    // The checkbox in the large-portrait label (the persona note toggle above it is one too, slice 4).
    const largePortrait = () =>
        [...target.querySelectorAll("label")]
            .find((label) => label.textContent?.includes(language.largePortrait))!
            .querySelector<HTMLInputElement>("input[type=checkbox]")!;
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
    installFlatDatabase({
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

// `docs/plan/chat-binding.md`, slice 5: with a chat open the icon grid's ring marks the chat's bound
// persona that exists (none when unset or gone; at home the tab's), a grid click binds the open chat
// through `changeUserPersona` (the tab's selection stays), "create persona" picks the new persona for
// the chat captured before its dialog (or the tab's selection captured at home), a deletion names how
// many chats bind the persona, leaves them bound, and moves only a tab selection that named it, and
// the header note says whose persona the editor shows. The editor itself stays on `activePersona`.
describe("PersonaSettings with a chat open (slice 5)", () => {
    const refK = { chaId: "c", chatId: "k" };
    const refJ = { chaId: "c", chatId: "j" };
    const chat = (id: string, fields: Record<string, unknown> = {}) => ({
        id,
        name: id.toUpperCase(),
        note: "",
        localLore: [],
        message: [{ role: "char", data: "hi", chatId: `m-${id}` }],
        ...fields,
    });
    const strings = language.chatBinding;

    function renderPage() {
        const page = render();
        const grid = () => [...page.target.querySelectorAll<HTMLButtonElement>("button[data-risu-idx]")];
        const ringed = () =>
            grid()
                .filter((button) => button.querySelector(".ring-3"))
                .map((button) => settings.personas[Number(button.dataset.risuIdx)].id);
        const addButton = () => page.target.querySelector<HTMLButtonElement>("button.rounded-full")!;
        const removeButton = () =>
            [...page.target.querySelectorAll("button")].find(
                (button) => button.textContent?.trim() === language.remove,
            )!;
        const header = () => page.target.querySelector("h2")!.parentElement!.textContent ?? "";
        return { ...page, grid, ringed, addButton, removeButton, header };
    }

    /** The tab selects `Ann`; chat `k` binds `Bob`, chat `j` binds nothing; `k` is open. */
    beforeEach(() => {
        installFlatDatabaseWithChats({
            characters: [
                {
                    chaId: "c",
                    type: "character",
                    name: "C",
                    chatPage: 0,
                    chats: [chat("k", { bindedPersona: "p2" }), chat("j")],
                },
            ],
            personas: [
                { id: "p1", name: "Ann", icon: "", note: "", personaPrompt: "", largePortrait: false },
                { id: "p2", name: "Bob", icon: "", note: "", personaPrompt: "", largePortrait: false },
                { id: "p3", name: "Cid", icon: "", note: "", personaPrompt: "", largePortrait: false },
            ],
        } as unknown as Database);
        selectPersona("p1");
        selectCharacter("c");
        selectChat("c", "k");
        vi.mocked(alertSelect).mockReset();
        vi.mocked(alertConfirm).mockReset();
    });

    afterEach(() => {
        selectCharacter(null);
    });

    it("rings the chat's bound persona, none when unset or gone, the tab's at home; the editor shows the bound one", () => {
        const page = renderPage();
        expect(page.ringed()).toEqual(["p2"]);
        expect(page.nameInput().value).toBe("Bob");
        expect(page.header()).toContain(strings.thisChat);

        chatBindingPatch(refK, { personaId: null });
        flushSync();
        expect(page.ringed()).toEqual([]);
        // The editor falls back to the tab's persona, and the header says the chat has none.
        expect(page.nameInput().value).toBe("Ann");
        expect(page.header()).toContain(strings.notSetForChat);

        chatBindingPatch(refK, { personaId: "gone" });
        flushSync();
        expect(page.ringed()).toEqual([]);
        expect(page.header()).toContain(strings.notSetForChat);

        selectCharacter(null);
        flushSync();
        expect(page.ringed()).toEqual(["p1"]);
        expect(page.header()).not.toContain(strings.thisChat);
        expect(page.header()).not.toContain(strings.notSetForChat);
    });

    it("a grid click binds the open chat and leaves the tab's selection; at home it selects for the tab", () => {
        const page = renderPage();
        page.grid()[2].click();
        flushSync();
        expect(chatEntry(refK)).toMatchObject({ bindedPersona: "p3" });
        expect(chatEntry(refJ)).not.toHaveProperty("bindedPersona");
        expect(selection.personaId).toBe("p1");
        expect(page.ringed()).toEqual(["p3"]);
        expect(page.nameInput().value).toBe("Cid");

        selectCharacter(null);
        flushSync();
        page.grid()[1].click();
        flushSync();
        expect(selection.personaId).toBe("p2");
        expect(chatEntry(refK)).toMatchObject({ bindedPersona: "p3" });
    });

    it("create persona picks the new persona for the chat captured before the dialog, not the chat shown after it", async () => {
        const page = renderPage();
        let choose!: (value: string) => void;
        vi.mocked(alertSelect).mockImplementationOnce(() => new Promise<string>((resolve) => (choose = resolve)));
        page.addButton().click();
        await Promise.resolve();
        // The screen moves to chat `j` while the dialog is open.
        selectChat("c", "j");
        choose("0");
        await Promise.resolve();
        await Promise.resolve();
        flushSync();
        const created = settings.personas.find((persona) => !["p1", "p2", "p3"].includes(persona.id))!;
        expect(created.name).toBe("New Persona");
        expect(chatEntry(refK)).toMatchObject({ bindedPersona: created.id });
        expect(chatEntry(refJ)).not.toHaveProperty("bindedPersona");
        expect(selection.personaId).toBe("p1");
    });

    it("create persona at home selects the new persona for the tab, even when a chat is opened during the dialog", async () => {
        selectCharacter(null);
        const page = renderPage();
        let choose!: (value: string) => void;
        vi.mocked(alertSelect).mockImplementationOnce(() => new Promise<string>((resolve) => (choose = resolve)));
        page.addButton().click();
        await Promise.resolve();
        selectCharacter("c");
        selectChat("c", "j");
        choose("0");
        await Promise.resolve();
        await Promise.resolve();
        flushSync();
        const created = settings.personas.find((persona) => !["p1", "p2", "p3"].includes(persona.id))!;
        expect(selection.personaId).toBe(created.id);
        expect(chatEntry(refJ)).not.toHaveProperty("bindedPersona");
        expect(chatEntry(refK)).toMatchObject({ bindedPersona: "p2" });
    });

    it("deleting the shown persona names the chats bound to it, leaves them bound, and moves only a tab selection that named it", async () => {
        const page = renderPage();
        expect(activePersona.id).toBe("p2");
        vi.mocked(alertConfirm).mockResolvedValueOnce(true);
        page.removeButton().click();
        await Promise.resolve();
        await Promise.resolve();
        flushSync();
        expect(alertConfirm).toHaveBeenLastCalledWith(`${language.removeConfirm}Bob\n\n${strings.usedByChats(1)}`);
        expect(settings.personas.map((persona) => persona.id)).toEqual(["p1", "p3"]);
        // The chat keeps the id (shown as deleted); the tab's `Ann` stays; the editor falls back to it.
        expect(chatEntry(refK)).toMatchObject({ bindedPersona: "p2" });
        expect(selection.personaId).toBe("p1");
        expect(page.nameInput().value).toBe("Ann");
        expect(page.ringed()).toEqual([]);

        // The tab's own persona deleted (now shown, as the chat's is gone): the selection moves to the
        // first remaining one; the chat is untouched.
        vi.mocked(alertConfirm).mockResolvedValueOnce(true);
        page.removeButton().click();
        await Promise.resolve();
        await Promise.resolve();
        flushSync();
        expect(alertConfirm).toHaveBeenLastCalledWith(`${language.removeConfirm}Ann`);
        expect(settings.personas.map((persona) => persona.id)).toEqual(["p3"]);
        expect(selection.personaId).toBe("p3");
        expect(chatEntry(refK)).toMatchObject({ bindedPersona: "p2" });
    });
});

// The Module Link section: the linkable list is the catalog's non-MCP modules with a non-blank id,
// each id once (the first, as the resolvers pick), named by `name` or by the id when the name is
// blank, sorted by that name and filtered by the search; a duplicate id or a nameless module does not
// break the render (Astra's challenge points 1 and 2). A row toggles the id on the persona the editor
// shows (the open chat's bound persona, else the tab's), written in canonical form so the mirror
// equals what the server stores (D2; point 3): unknown ids stay, blank ones go. An unmatched search
// says so; a catalog without a linkable module says that instead (point 4).
describe("PersonaSettings module links", () => {
    const chat = (id: string, fields: Record<string, unknown> = {}) => ({
        id,
        name: id.toUpperCase(),
        note: "",
        localLore: [],
        message: [{ role: "char", data: "hi", chatId: `m-${id}` }],
        ...fields,
    });
    const refK = { chaId: "c", chatId: "k" };
    const catalog = [
        { id: "zeta", name: "Zeta", description: "" },
        { id: "dup", name: "Dup A", description: "" },
        { id: "dup", name: "Dup B", description: "" },
        { id: "unnamed", description: "" },
        { id: "   ", name: "Blank id", description: "" },
        { id: "mcpmod", name: "Mcp", description: "", mcp: { url: "http://mcp" } },
    ];

    function renderLinks() {
        const page = render();
        const rows = () => [
            ...page.target.querySelectorAll<HTMLButtonElement>(`button[aria-label^="${language.personaModuleLink}: "]`),
        ];
        const names = () => rows().map((row) => row.textContent?.trim());
        const pressed = () =>
            rows()
                .filter((row) => row.getAttribute("aria-pressed") === "true")
                .map((row) => row.textContent?.trim());
        const rowNamed = (name: string) => rows().find((row) => row.textContent?.trim() === name)!;
        const search = (query: string) => {
            const input = page.target.querySelector<HTMLInputElement>(`input[placeholder="${language.search}"]`)!;
            input.value = query;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            flushSync();
        };
        return { ...page, rows, names, pressed, rowNamed, search };
    }

    function install(modules: Record<string, unknown>[], personaFields: Record<string, unknown> = {}) {
        installFlatDatabaseWithChats({
            characters: [
                { chaId: "c", type: "character", name: "C", chatPage: 0, chats: [chat("k", { bindedPersona: "p2" })] },
            ],
            personas: [
                { id: "p1", name: "Ann", icon: "", note: "", personaPrompt: "", largePortrait: false },
                {
                    id: "p2",
                    name: "Bob",
                    icon: "",
                    note: "",
                    personaPrompt: "",
                    largePortrait: false,
                    ...personaFields,
                },
            ],
            modules,
        } as unknown as Database);
        selectPersona("p1");
        selectCharacter("c");
        selectChat("c", "k");
    }

    afterEach(() => {
        selectCharacter(null);
    });

    it("renders a catalog with a duplicate id, a nameless module, a blank id, and an MCP module: first of an id, named by id when nameless, the others left out", () => {
        install(catalog);
        const page = renderLinks();
        expect(page.names()).toEqual(["Dup A", "unnamed", "Zeta"]);
        expect(page.rowNamed("unnamed").getAttribute("aria-label")).toBe(`${language.personaModuleLink}: unnamed`);
        expect(page.pressed()).toEqual([]);
        // The search matches the display name, the id for a nameless module included.
        page.search("UNNAMED");
        expect(page.names()).toEqual(["unnamed"]);
        page.search("dup");
        expect(page.names()).toEqual(["Dup A"]);
        page.search("");
        expect(page.names()).toEqual(["Dup A", "unnamed", "Zeta"]);
    });

    it("the search matches Korean names by initial consonants and by a half-composed last syllable, keeping the list's order", () => {
        install([
            { id: "zeta", name: "Zeta", description: "" },
            { id: "captain", name: "해적 선장", description: "" },
            { id: "beach", name: "해변", description: "" },
            { id: "ship", name: "해적선", description: "" },
        ]);
        const page = renderLinks();
        const pirates = page.names().filter((name) => name?.startsWith("해적"));
        expect(pirates).toHaveLength(2);
        page.search("ㅎㅈ");
        expect(page.names()).toEqual(pirates);
        page.search("해저");
        expect(page.names()).toEqual(pirates);
        page.search("ㅎㅂ");
        expect(page.names()).toEqual(["해변"]);
    });

    it("a row toggles the id on the open chat's bound persona in canonical form, keeping unknown ids and dropping blank ones; the tab's persona is untouched", () => {
        install(catalog, { modules: ["missing", "  ", "zeta", "zeta"] });
        const page = renderLinks();
        expect(activePersona.id).toBe("p2");
        expect(page.pressed()).toEqual(["Zeta"]);

        page.rowNamed("Dup A").click();
        flushSync();
        expect(persona("p2").modules).toEqual(["missing", "zeta", "dup"]);
        expect(page.pressed()).toEqual(["Dup A", "Zeta"]);
        expect(persona("p1")).not.toHaveProperty("modules");

        page.rowNamed("Zeta").click();
        flushSync();
        expect(persona("p2").modules).toEqual(["missing", "dup"]);
        expect(page.pressed()).toEqual(["Dup A"]);

        // With the chat unbound the editor shows the tab's persona, and a toggle writes that one.
        chatBindingPatch(refK, { personaId: null });
        flushSync();
        expect(activePersona.id).toBe("p1");
        expect(page.pressed()).toEqual([]);
        page.rowNamed("Zeta").click();
        flushSync();
        expect(persona("p1").modules).toEqual(["zeta"]);
        expect(persona("p2").modules).toEqual(["missing", "dup"]);
    });

    it("says that no module matches an unmatched search, and that none is linkable when only MCP modules exist", () => {
        install(catalog);
        const page = renderLinks();
        page.search("nothing here");
        expect(page.names()).toEqual([]);
        expect(page.target.textContent).toContain(language.noMatchingModules);
        expect(page.target.textContent).not.toContain(language.noLinkableModules);
        page.search("");
        expect(page.names()).toHaveLength(3);
        expect(page.target.textContent).not.toContain(language.noMatchingModules);
    });

    it("says that no linkable module is installed for an MCP-only catalog, and for an empty one", () => {
        install([catalog[5]]);
        const page = renderLinks();
        expect(page.names()).toEqual([]);
        expect(page.target.textContent).toContain(language.noLinkableModules);
        expect(page.target.textContent).not.toContain(language.noMatchingModules);
        page.search("mcp");
        expect(page.target.textContent).toContain(language.noLinkableModules);
    });
});
