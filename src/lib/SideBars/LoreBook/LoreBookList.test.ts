// @vitest-environment happy-dom
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactiveProps } from "src/lib/UI/tests/reactiveProps.svelte";

// `LoreBookList` mounted over the real records, selection, chat module, local-lore draft,
// `LoreBookData`, and the real inputs: rows are keyed by entry and bind to the entry captured at
// mount, so an edit that lands while the row is torn down (Chrome fires `change` on a focused,
// edited control as it is removed; `TextAreaInput`'s `onchange` writes the value) goes nowhere once
// the shown list no longer holds the entry, and a binding read after the row's list is gone never
// reaches a removed record element. happy-dom removes nodes silently, so the removal-time `change`
// is dispatched here from a patched `Element.prototype.remove`. SortableJS, the tokenizer, and the
// alert dialogs are doubled.

/** The SortableJS instances the lists created (happy-dom cannot drag): their options and lifecycle. */
const sortables = vi.hoisted(
    () =>
        [] as {
            el: HTMLElement;
            options: Record<string, unknown>;
            /** The `disabled` option the instance was created with. */
            createdDisabled: boolean;
            destroyed: boolean;
        }[],
);
vi.mock("sortablejs/modular/sortable.core.esm.js", () => {
    class Sortable {
        el: HTMLElement;
        options: Record<string, unknown>;
        createdDisabled: boolean;
        destroyed = false;
        constructor(el: HTMLElement, options: Record<string, unknown>) {
            this.el = el;
            this.options = options;
            this.createdDisabled = !!options.disabled;
            sortables.push(this);
        }
        option(name: string, value?: unknown) {
            if (value === undefined) return this.options[name];
            this.options[name] = value;
        }
        destroy() {
            this.destroyed = true;
        }
        static create(el: HTMLElement, options: Record<string, unknown>) {
            return new Sortable(el, options);
        }
    }
    return { default: Sortable };
});
vi.mock("src/ts/tokenizer", () => ({ tokenizeAccurate: vi.fn(async () => 0) }));
const mocks = vi.hoisted(() => ({ alertConfirm: vi.fn(async () => true) }));
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({
        alertConfirm: mocks.alertConfirm,
    }),
);

import LoreBookList from "./LoreBookList.svelte";
import { language } from "src/lang";
import { tokenizeAccurate } from "src/ts/tokenizer";
import { characterList } from "src/ts/storage/characterStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { findChat, selectChat } from "src/ts/storage/chatStore.svelte";
import { replaceRecordList, setCharacterWriteListener, setRecordWriteListener } from "src/ts/storage/records.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";
import type { loreBook } from "src/ts/storage/database.svelte";

const entry = (name: string, extra: Partial<loreBook> = {}): loreBook => ({
    key: name,
    comment: name,
    content: `${name} content`,
    mode: "normal",
    insertorder: 100,
    alwaysActive: false,
    secondkey: "",
    selective: false,
    ...extra,
});
const folder = (name: string, key: string) => entry(name, { mode: "folder", key });
const plain = (books: readonly loreBook[]) => books.map((book) => ({ comment: book.comment, content: book.content }));

let target: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;
const originalRemove = Element.prototype.remove;
/** Controls edited since they were focused: Chrome fires `change` on these when they are removed. */
const edited = new WeakSet<Element>();
let unhandled: unknown[] = [];
const onRejection = (reason: unknown) => unhandled.push(reason);

function install(lists: Record<string, loreBook[]>) {
    installFlatDatabaseWithChats({
        characters: Object.entries(lists).map(([chaId, globalLore]) => ({
            chaId,
            type: "character",
            name: chaId,
            globalLore,
            chatPage: 0,
            chats: [{ id: `k-${chaId}`, name: "K", note: "", localLore: [], message: [] }],
        })),
    } as any);
}
function globalLore(chaId: string): loreBook[] {
    return (characterList().find((character) => character?.chaId === chaId) as any).globalLore;
}
function render(props: Record<string, unknown>) {
    instance = mount(LoreBookList, { target, props: reactiveProps(props) });
    flushSync();
}
/** The rendered entry rows under `root` (nested folder lists included), without the hidden sort markers. */
function rows(root: ParentNode = target) {
    return [...root.querySelectorAll<HTMLElement>("[data-risu-idgroup]")].filter((row) => row.querySelector("button"));
}
const labels = (root: ParentNode = target) => rows(root).map((row) => row.querySelector("button")!.textContent!.trim());
/** The detail block of a row (the entry's fields, or a folder's name and nested list). */
const detail = (row: HTMLElement) => row.querySelector<HTMLElement>(":scope > div.mt-2, :scope > div > div.mt-2");
function open(row: HTMLElement) {
    if (!detail(row)) {
        row.querySelector("button")!.click();
        flushSync();
    }
    return detail(row)!;
}
const nestedRows = (folderRow: HTMLElement) => rows(detail(folderRow)!.querySelector("div.mt-4")!);
const removeButton = (row: HTMLElement) => [...row.querySelector(":scope > div")!.querySelectorAll("button")].at(-1)!;
const liveSortables = (list: HTMLElement | null) =>
    sortables.filter((sortable) => !sortable.destroyed && sortable.el === list);
/** Focuses the control, sets its text, and dispatches `input` (what typing does; `bind:value` writes through). */
function type(control: HTMLInputElement | HTMLTextAreaElement, text: string) {
    control.focus();
    control.value = text;
    control.dispatchEvent(new Event("input", { bubbles: true }));
    edited.add(control);
}
async function settle() {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
}

beforeEach(() => {
    sortables.length = 0;
    unhandled = [];
    process.on("unhandledRejection", onRejection);
    mocks.alertConfirm.mockReset();
    mocks.alertConfirm.mockImplementation(async () => true);
    setRecordWriteListener(() => {});
    setCharacterWriteListener({ character: () => {}, membership: () => {} });
    target = document.createElement("div");
    document.body.append(target);
    Element.prototype.remove = function (this: Element) {
        const active = document.activeElement;
        if (active && this.contains(active) && edited.has(active)) {
            edited.delete(active);
            active.dispatchEvent(new Event("change", { bubbles: true }));
            active.dispatchEvent(new Event("blur"));
        }
        return originalRemove.call(this);
    };
});
afterEach(async () => {
    Element.prototype.remove = originalRemove;
    process.off("unhandledRejection", onRejection);
    if (instance) await unmount(instance);
    instance = null;
    target.remove();
});

describe("LoreBookList token counts", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.mocked(tokenizeAccurate).mockReset().mockResolvedValue(29);
    });
    afterEach(() => {
        vi.mocked(tokenizeAccurate).mockReset().mockResolvedValue(0);
        vi.useRealTimers();
    });

    it("counts an entry immediately on opening and cancels a pending count on closing", async () => {
        install({ alpha: [entry("Lore")] });
        selectCharacter("alpha");
        render({ submenu: 0 });
        const row = rows()[0];
        expect(detail(row)).toBeNull();
        await vi.advanceTimersByTimeAsync(400);
        expect(tokenizeAccurate).not.toHaveBeenCalled();

        const fields = open(row);
        expect(tokenizeAccurate).toHaveBeenCalledExactlyOnceWith("Lore content", undefined, expect.any(AbortSignal));
        await tick();
        flushSync();
        expect(fields.textContent).toContain(`29 ${language.tokens}`);
        vi.mocked(tokenizeAccurate).mockClear();

        type(fields.querySelector("textarea")!, "edited lore content");
        flushSync();
        expect(globalLore("alpha")[0].content).toBe("edited lore content");
        await vi.advanceTimersByTimeAsync(399);
        expect(tokenizeAccurate).not.toHaveBeenCalled();
        row.querySelector("button")!.click();
        flushSync();
        expect(detail(row)).toBeNull();
        await vi.advanceTimersByTimeAsync(400);

        expect(tokenizeAccurate).not.toHaveBeenCalled();
    });
});

describe("LoreBookList rows keyed by entry", () => {
    it.each([
        ["a matching entry", "beta", [entry("b0"), entry("b1")]],
        ["a shorter list", "gamma", [entry("g0")]],
        ["an empty list", "delta", []],
    ])(
        "keeps every entry but the edited one when the character switches under a focused prompt (%s)",
        async (_, next, nextLore) => {
            install({ alpha: [entry("a0"), entry("a1")], [next]: nextLore });
            selectCharacter("alpha");
            render({ submenu: 0 });
            const prompt = open(rows()[1]).querySelector("textarea")!;
            type(prompt, "a1 EDITED");
            expect(document.activeElement).toBe(prompt);

            // The keyboard switch (Ctrl+]) removes alpha's rows while the prompt is focused.
            selectCharacter(next);
            expect(() => flushSync()).not.toThrow();
            await settle();

            expect(plain(globalLore("alpha"))).toEqual([
                { comment: "a0", content: "a0 content" },
                { comment: "a1", content: "a1 EDITED" },
            ]);
            expect(plain(globalLore(next))).toEqual(plain(nextLore));
            expect(labels()).toEqual(nextLore.map((book) => book.comment));
            expect(unhandled).toEqual([]);
        },
    );

    it("drops a nested row's binding read after its folder's list is torn down in the same task", async () => {
        // The nested list (a folder's `LoreBookList`) is destroyed with the folder row; the child's
        // name input still has a pending post-tick binding read (Svelte's `bind_value`).
        install({ alpha: [folder("F", "fkey"), entry("child", { folder: "fkey" }), entry("a2")] });
        selectCharacter("alpha");
        render({ submenu: 0 });
        const folderRow = rows()[0];
        open(folderRow);
        const childRow = nestedRows(folderRow)[0];
        const name = open(childRow).querySelector("input")!;
        type(name, "child renamed");

        const list = globalLore("alpha");
        replaceRecordList(
            list,
            list.filter((book) => book !== list[0] && book.folder !== "fkey"),
        );
        expect(() => flushSync()).not.toThrow();
        await settle();

        expect(unhandled).toEqual([]);
        expect(plain(globalLore("alpha"))).toEqual([{ comment: "a2", content: "a2 content" }]);
        expect(labels()).toEqual(["a2"]);
    });

    it("drops a nested prompt's removal-time change when its folder leaves the list, and the rows follow the record", () => {
        // A removal that does not blur first (a remote, plugin, or job write): the nested list is
        // inert while Chrome fires `change` on the focused prompt inside the row's DOM removal.
        install({ alpha: [folder("F", "fkey"), entry("child", { folder: "fkey" }), entry("a2")] });
        selectCharacter("alpha");
        render({ submenu: 0 });
        const folderRow = rows()[0];
        open(folderRow);
        const prompt = open(nestedRows(folderRow)[0]).querySelector("textarea")!;
        type(prompt, "child EDITED");

        const list = globalLore("alpha");
        replaceRecordList(
            list,
            list.filter((book) => book !== list[0] && book.folder !== "fkey"),
        );
        expect(() => flushSync()).not.toThrow();

        expect(plain(globalLore("alpha"))).toEqual([{ comment: "a2", content: "a2 content" }]);
        expect(labels()).toEqual(["a2"]);
    });

    it("keeps a nested prompt's edit on its own entry when the character switches", async () => {
        install({
            alpha: [folder("F", "fkey"), entry("child", { folder: "fkey" }), entry("a2")],
            beta: [entry("b0"), entry("b1"), entry("b2")],
        });
        selectCharacter("alpha");
        render({ submenu: 0 });
        const folderRow = rows()[0];
        open(folderRow);
        const prompt = open(nestedRows(folderRow)[0]).querySelector("textarea")!;
        type(prompt, "child EDITED");

        selectCharacter("beta");
        expect(() => flushSync()).not.toThrow();
        await settle();

        expect(plain(globalLore("alpha"))).toEqual([
            { comment: "F", content: "F content" },
            { comment: "child", content: "child EDITED" },
            { comment: "a2", content: "a2 content" },
        ]);
        expect(plain(globalLore("beta"))).toEqual(plain([entry("b0"), entry("b1"), entry("b2")]));
        expect(labels()).toEqual(["b0", "b1", "b2"]);
        expect(unhandled).toEqual([]);
    });

    it("removes the entry, or a folder with its entries, the row was mounted for", async () => {
        install({
            alpha: [entry("a0"), folder("F", "fkey"), entry("child", { folder: "fkey" }), entry("a3")],
        });
        selectCharacter("alpha");
        render({ submenu: 0 });
        const kept = globalLore("alpha")[3];

        removeButton(rows()[0]).click();
        await settle();
        expect(mocks.alertConfirm).toHaveBeenCalledTimes(1);
        expect(labels()).toEqual(["F", "a3"]);

        // A folder holding entries asks twice, then goes with its entries in one list replacement.
        removeButton(rows()[0]).click();
        await settle();
        expect(mocks.alertConfirm).toHaveBeenCalledTimes(3);
        expect(plain(globalLore("alpha"))).toEqual([{ comment: "a3", content: "a3 content" }]);
        expect(globalLore("alpha")[0]).toBe(kept);
        expect(labels()).toEqual(["a3"]);
        expect(unhandled).toEqual([]);
    });

    it("removes nothing and deactivates no chat links when deletion is confirmed after a character switch", async () => {
        const link = entry("", { id: "linked", mode: "child", alwaysActive: true });
        installFlatDatabaseWithChats({
            characters: ["alpha", "beta"].map((chaId) => ({
                chaId,
                type: "character",
                name: chaId,
                globalLore: [entry(`${chaId} kept`), entry(`${chaId} linked`, { id: "linked" })],
                chatPage: 0,
                chats: [{ id: `k-${chaId}`, name: "K", note: "", localLore: [{ ...link }], message: [] }],
            })),
        });
        selectCharacter("alpha");
        selectChat("alpha", "k-alpha");
        render({ submenu: 0 });
        let confirm!: (answer: boolean) => void;
        mocks.alertConfirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => (confirm = resolve)));

        removeButton(rows()[1]).click();
        await Promise.resolve();
        selectCharacter("beta");
        selectChat("beta", "k-beta");
        flushSync();
        confirm(true);
        await settle();

        for (const chaId of ["alpha", "beta"]) {
            expect(globalLore(chaId)).toEqual([entry(`${chaId} kept`), entry(`${chaId} linked`, { id: "linked" })]);
            expect(findChat({ chaId, chatId: `k-${chaId}` })!.localLore).toEqual([link]);
        }
        expect(labels()).toEqual(["beta kept", "beta linked"]);
        expect(unhandled).toEqual([]);
    });

    it("deactivates a deleted character entry only in the chat selected before confirmation", async () => {
        const link = entry("", { id: "linked", mode: "child", alwaysActive: true });
        installFlatDatabaseWithChats({
            characters: [
                {
                    chaId: "alpha",
                    type: "character",
                    name: "alpha",
                    globalLore: [entry("kept"), entry("linked", { id: "linked" })],
                    chatPage: 0,
                    chats: ["k1", "k2"].map((id) => ({
                        id,
                        name: id,
                        note: "",
                        localLore: [{ ...link }],
                        message: [],
                    })),
                },
            ],
        });
        selectCharacter("alpha");
        selectChat("alpha", "k1");
        render({ submenu: 0 });
        let confirm!: (answer: boolean) => void;
        mocks.alertConfirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => (confirm = resolve)));

        removeButton(rows()[1]).click();
        expect(mocks.alertConfirm).toHaveBeenCalledTimes(1);
        selectChat("alpha", "k2");
        flushSync();
        confirm(true);
        await settle();

        expect(globalLore("alpha")).toEqual([entry("kept")]);
        expect(labels()).toEqual(["kept"]);
        expect(findChat({ chaId: "alpha", chatId: "k1" })!.localLore).toEqual([]);
        expect(findChat({ chaId: "alpha", chatId: "k2" })!.localLore).toEqual([link]);
        expect(unhandled).toEqual([]);
    });

    it("keeps drag enabled after deleting a closed row and after opening and closing another detail", async () => {
        install({ alpha: [entry("deleted"), entry("kept")] });
        selectCharacter("alpha");
        render({ submenu: 0 });
        const list = rows()[0].parentElement;
        expect(detail(rows()[0])).toBeNull();

        removeButton(rows()[0]).click();
        await settle();

        expect(labels()).toEqual(["kept"]);
        expect(liveSortables(list).map((sortable) => sortable.options.disabled)).toEqual([false]);
        const kept = rows()[0];
        expect(open(kept)).not.toBeNull();
        kept.querySelector("button")!.click();
        await settle();

        expect(detail(kept)).toBeNull();
        expect(liveSortables(list).map((sortable) => sortable.options.disabled)).toEqual([false]);
    });

    it.each(["character", "chat"] as const)(
        "enables drag for the new list after a %s switch with an open detail",
        async (owner) => {
            installFlatDatabaseWithChats({
                characters: ["alpha", "beta"].map((chaId) => ({
                    chaId,
                    type: "character",
                    name: chaId,
                    globalLore: [entry(chaId)],
                    chatPage: 0,
                    chats: ["first", "second"].map((name) => ({
                        id: `${chaId}-${name}`,
                        name,
                        note: "",
                        localLore: [entry(name)],
                        message: [],
                    })),
                })),
            });
            selectCharacter("alpha");
            selectChat("alpha", "alpha-first");
            render({ submenu: owner === "chat" ? 1 : 0 });
            expect(liveSortables(rows()[0].parentElement).map((sortable) => sortable.options.disabled)).toEqual([
                false,
            ]);
            open(rows()[0]);
            expect(liveSortables(rows()[0].parentElement)).toEqual([]);

            if (owner === "character") selectCharacter("beta");
            else selectChat("alpha", "alpha-second");
            await settle();

            expect(labels()).toEqual([owner === "character" ? "beta" : "second"]);
            expect(detail(rows()[0])).toBeNull();
            expect(liveSortables(rows()[0].parentElement).map((sortable) => sortable.options.disabled)).toEqual([
                false,
            ]);
        },
    );

    it("mounts a folder's one-way external list and toggles its sub-folder's members without ownership warnings", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            install({
                alpha: [
                    folder("Outer", "outer"),
                    { ...folder("Inner", "inner"), folder: "outer" },
                    entry("first", { folder: "inner" }),
                    entry("second", { folder: "inner" }),
                ],
            });
            selectCharacter("alpha");
            render({ submenu: 0 });
            const outer = rows()[0];
            open(outer);
            const inner = nestedRows(outer)[0];
            expect(labels(detail(outer)!)).toEqual(["Inner"]);

            // The second header button is the sun/link toggle; the nested list receives its
            // external array one-way, just like ModuleMenu's list.
            inner.querySelectorAll<HTMLButtonElement>(":scope > div > button")[1].click();
            await settle();

            expect(globalLore("alpha").map((book) => [book.comment, book.alwaysActive])).toEqual([
                ["Outer", false],
                ["Inner", true],
                ["first", true],
                ["second", true],
            ]);
            expect(
                warn.mock.calls
                    .flat()
                    .map(String)
                    .filter((message) => message.includes("ownership_invalid")),
            ).toEqual([]);
        } finally {
            warn.mockRestore();
        }
    });

    it("saves a local-lore edit to its chat and leaves the next chat's entries alone across a chat switch", async () => {
        installFlatDatabaseWithChats({
            characters: [
                {
                    chaId: "c",
                    type: "character",
                    name: "c",
                    globalLore: [],
                    chatPage: 0,
                    chats: [
                        { id: "k1", name: "K1", note: "", localLore: [entry("l0"), entry("l1")], message: [] },
                        { id: "k2", name: "K2", note: "", localLore: [entry("m0"), entry("m1")], message: [] },
                    ],
                },
            ],
        } as any);
        selectCharacter("c");
        selectChat("c", "k1");
        flushSync();
        render({ submenu: 1 });
        const prompt = open(rows()[1]).querySelector("textarea")!;
        type(prompt, "l1 EDITED");
        flushSync();

        selectChat("c", "k2");
        expect(() => flushSync()).not.toThrow();
        await settle();

        expect(findChat({ chaId: "c", chatId: "k1" })!.localLore.map((book) => book.content)).toEqual([
            "l0 content",
            "l1 EDITED",
        ]);
        expect(findChat({ chaId: "c", chatId: "k2" })!.localLore.map((book) => book.content)).toEqual([
            "m0 content",
            "m1 content",
        ]);
        expect(labels()).toEqual(["m0", "m1"]);
        expect(unhandled).toEqual([]);
    });

    it("removes an entry of an external list in place and re-renders", async () => {
        // A module's lorebook is passed without a binding (`ModuleMenu`): the delete must change
        // the owner's list, not a local copy of the prop.
        install({ alpha: [] });
        selectCharacter("alpha");
        const props = reactiveProps({ externalLoreBooks: [entry("x0"), entry("x1"), entry("x2")] as loreBook[] });
        instance = mount(LoreBookList, { target, props });
        flushSync();

        removeButton(rows()[1]).click();
        await settle();

        expect(props.externalLoreBooks.map((book) => book.comment)).toEqual(["x0", "x2"]);
        expect(labels()).toEqual(["x0", "x2"]);
    });
});

// The list filter: the outermost list owns the one query field; an entry matches on `comment`,
// `key` and `secondkey` (a chat's `child` link also on the entry it links), never on `content`; a
// folder on its own name. A match inside a folder shows the folder expanded (its stored expansion
// untouched) with only the matching entries, a folder-name match all of them. Hidden rows stay
// mounted with the `hidden` class, so visibility is read through the row and its ancestors. Every
// Sortable instance is disabled while filtered, including those created meanwhile, and enabled
// again after clearing. The query resets when the list's owner changes.
describe("LoreBookList filter", () => {
    const library = (): loreBook[] => [
        entry("Sword", { key: "excalibur" }),
        entry("Shield", { key: "shield", content: "forged beside excalibur" }),
        entry("Helm", { key: "helm", secondkey: "zeta" }),
        entry("해적선", { key: "ship" }),
        folder("Folder", "fkey"),
        entry("Beta", { key: "beta", folder: "fkey" }),
        entry("Gamma", { key: "gamma", folder: "fkey" }),
    ];
    const filterField = () => target.querySelector<HTMLInputElement>(":scope > input")!;
    /** Every filter field rendered anywhere under the root (the nested lists must render none). */
    const filterFields = () =>
        [...target.querySelectorAll<HTMLInputElement>("input")].filter(
            (input) => input.placeholder === filterField().placeholder,
        );
    function search(text: string) {
        const field = filterField();
        field.value = text;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        flushSync();
    }
    /** Whether the filter shows the row: neither it nor a row above it carries `hidden`. */
    const shown = (row: HTMLElement) => {
        for (let node: HTMLElement | null = row; node && node !== target; node = node.parentElement) {
            if (node.classList.contains("hidden")) return false;
        }
        return true;
    };
    const label = (row: HTMLElement) => row.querySelector("button")!.textContent!.trim();
    const visibleLabels = (root: ParentNode = target) => rows(root).filter(shown).map(label);
    const folderRow = () => rows().find((row) => label(row) === "Folder")!;
    const live = () => sortables.filter((sortable) => !sortable.destroyed);
    function renderExternal() {
        install({ alpha: [] });
        selectCharacter("alpha");
        const props = reactiveProps({ externalLoreBooks: library() });
        instance = mount(LoreBookList, { target, props });
        flushSync();
        return props;
    }

    it("shows only the entries a key, a second key, or a choseong comment query matches, never a content match", () => {
        renderExternal();
        expect(filterFields()).toHaveLength(1);
        expect(visibleLabels()).toEqual(["Sword", "Shield", "Helm", "해적선", "Folder"]);

        search("excal");
        // Shield holds "excalibur" in its content only.
        expect(visibleLabels()).toEqual(["Sword"]);
        expect(labels()).toEqual(["Sword", "Shield", "Helm", "해적선", "Folder"]);

        search("zeta");
        expect(visibleLabels()).toEqual(["Helm"]);

        search("ㅎㅈ");
        expect(visibleLabels()).toEqual(["해적선"]);

        search("");
        expect(visibleLabels()).toEqual(["Sword", "Shield", "Helm", "해적선", "Folder"]);
        expect(filterField().value).toBe("");
    });

    it("expands a folder to the matching entry only, with no second field, and collapses it back on clearing", () => {
        renderExternal();
        expect(detail(folderRow())).toBeNull();

        search("beta");
        expect(visibleLabels()).toEqual(["Folder", "Beta"]);
        expect(detail(folderRow())).not.toBeNull();
        expect(nestedRows(folderRow()).map((row) => [label(row), shown(row)])).toEqual([
            ["Beta", true],
            ["Gamma", false],
        ]);
        expect(filterFields()).toHaveLength(1);

        // The forced folder's toggle does nothing: no stored expansion is written.
        folderRow().querySelector("button")!.click();
        flushSync();
        expect(detail(folderRow())).not.toBeNull();
        expect(visibleLabels()).toEqual(["Folder", "Beta"]);

        search("");
        expect(visibleLabels()).toEqual(["Sword", "Shield", "Helm", "해적선", "Folder"]);
        expect(detail(folderRow())).toBeNull();
    });

    it("shows every entry of a folder whose name matches", () => {
        renderExternal();

        search("fold");
        expect(visibleLabels()).toEqual(["Folder", "Beta", "Gamma"]);
        expect(nestedRows(folderRow()).map(shown)).toEqual([true, true]);
    });

    it("shows the no-match message at the root while keeping unmatched rows mounted and hidden", () => {
        renderExternal();
        open(folderRow());
        const mountedRows = rows();
        const message = "No lorebook entries match the search.";
        expect(target.textContent).not.toContain(message);

        search("no such lorebook");

        const notices = [...target.querySelectorAll("span")].filter((span) => span.textContent === message);
        expect(notices).toHaveLength(1);
        expect(notices[0].parentElement).toBe(mountedRows[0].parentElement);
        expect(visibleLabels()).toEqual([]);
        expect(rows()).toHaveLength(mountedRows.length);
        mountedRows.forEach((row, index) => {
            expect(rows()[index]).toBe(row);
            expect(row.isConnected).toBe(true);
            expect(shown(row)).toBe(false);
        });

        search("");
        expect(target.textContent).not.toContain(message);
        expect(rows().every(shown)).toBe(true);
    });

    it("disables drag while filtered, on every list created meanwhile, and enables it again after clearing", () => {
        renderExternal();
        expect(live().map((sortable) => sortable.options.disabled)).toEqual([false]);
        const root = live()[0];

        search("beta");
        expect(root.options.disabled).toBe(true);
        // The forced folder's nested list starts its instance disabled.
        expect(
            live().map((sortable) => [sortable === root, sortable.createdDisabled, sortable.options.disabled]),
        ).toEqual([
            [true, false, true],
            [false, true, true],
        ]);

        // An instance created while filtered by closing a detail (nested and root) is disabled too.
        const beta = nestedRows(folderRow())[0];
        open(beta);
        beta.querySelector("button")!.click();
        flushSync();
        search("excal");
        const sword = rows()[0];
        open(sword);
        expect(live()).toEqual([]);
        sword.querySelector("button")!.click();
        flushSync();
        expect(live().map((sortable) => [sortable.createdDisabled, sortable.options.disabled])).toEqual([[true, true]]);
        expect(sortables.filter((sortable) => sortable.createdDisabled)).toHaveLength(3);

        search("");
        expect(live().map((sortable) => [sortable.createdDisabled, sortable.options.disabled])).toEqual([
            [true, false],
        ]);
        expect(visibleLabels()).toEqual(["Sword", "Shield", "Helm", "해적선", "Folder"]);
    });

    it("keeps hidden rows mounted with their open details, and an entry renamed under the filter stays shown", () => {
        renderExternal();
        const nested = open(folderRow());
        const beta = nestedRows(folderRow())[0];
        open(beta);

        search("excal");
        expect(shown(folderRow())).toBe(false);
        expect(detail(folderRow())).toBe(nested);
        expect(detail(beta)).not.toBeNull();

        const sword = rows()[0];
        type(open(sword).querySelector("input")!, "Other");
        flushSync();
        expect(visibleLabels()).toEqual(["Other"]);

        search("");
        expect(visibleLabels()).toEqual(["Other", "Shield", "Helm", "해적선", "Folder", "Beta", "Gamma"]);
        expect(detail(folderRow())).toBe(nested);
        expect(detail(beta)).not.toBeNull();
    });

    it("matches a chat's child link on the linked entry, and resets the query when the character, the tab, or the chat changes", () => {
        installFlatDatabaseWithChats({
            characters: [
                {
                    chaId: "alpha",
                    type: "character",
                    name: "alpha",
                    globalLore: [entry("Sword", { key: "excalibur" }), entry("Dragon", { id: "g1" })],
                    chatPage: 0,
                    chats: [
                        {
                            id: "k1",
                            name: "K1",
                            note: "",
                            localLore: [
                                entry("Lantern"),
                                { ...entry(""), mode: "child", id: "g1", alwaysActive: true } as loreBook,
                            ],
                            message: [],
                        },
                        { id: "k2", name: "K2", note: "", localLore: [entry("Mirror")], message: [] },
                    ],
                },
                {
                    chaId: "beta",
                    type: "character",
                    name: "beta",
                    globalLore: [entry("Sword", { key: "excalibur" }), entry("Shield")],
                    chatPage: 0,
                    chats: [{ id: "k3", name: "K3", note: "", localLore: [], message: [] }],
                },
            ],
        } as any);
        selectCharacter("alpha");
        selectChat("alpha", "k1");
        flushSync();
        const props = reactiveProps({ submenu: 0 });
        instance = mount(LoreBookList, { target, props });
        flushSync();

        search("excal");
        expect(visibleLabels()).toEqual(["Sword"]);
        selectCharacter("beta");
        flushSync();
        expect(filterField().value).toBe("");
        expect(visibleLabels()).toEqual(["Sword", "Shield"]);

        search("shie");
        expect(visibleLabels()).toEqual(["Shield"]);
        selectCharacter("alpha");
        flushSync();
        search("excal");
        expect(visibleLabels()).toEqual(["Sword"]);
        props.submenu = 1;
        flushSync();
        expect(filterField().value).toBe("");
        expect(visibleLabels()).toEqual(["Lantern", "Dragon"]);

        // The child link has empty fields of its own: it matches on the entry it links.
        search("drag");
        expect(visibleLabels()).toEqual(["Dragon"]);
        selectChat("alpha", "k2");
        flushSync();
        expect(filterField().value).toBe("");
        expect(visibleLabels()).toEqual(["Mirror"]);
        expect(unhandled).toEqual([]);
    });
});
