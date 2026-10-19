// @vitest-environment happy-dom
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactiveProps } from "src/lib/UI/tests/reactiveProps.svelte";

// `LoreBookList` mounted over the real records, selection, chat module, local-lore draft,
// `LoreBookData`, and the real inputs (open-bug-fixes slice C7, D1): rows are keyed by entry and
// bind to the entry captured at mount, so an edit that lands while the row is torn down (Chrome
// fires `change` on a focused, edited control as it is removed; `TextAreaInput`'s `onchange` writes
// the value) goes nowhere once the shown list no longer holds the entry, and a binding read after
// the row's list is gone never reaches a removed record element. happy-dom removes nodes silently,
// so the removal-time `change` is dispatched here from a patched `Element.prototype.remove`.
// SortableJS, the tokenizer, and the alert dialogs are doubled.

vi.mock("sortablejs/modular/sortable.core.esm.js", () => ({
    default: { create: () => ({ destroy() {} }) },
}));
vi.mock("src/ts/tokenizer", () => ({ tokenizeAccurate: vi.fn(async () => 0) }));
const mocks = vi.hoisted(() => ({ alertConfirm: vi.fn(async () => true) }));
vi.mock("src/ts/alert", () => ({
    alertConfirm: mocks.alertConfirm,
    alertError: vi.fn(),
    alertMd: vi.fn(),
    alertNormal: vi.fn(),
    alertToast: vi.fn(),
}));

import LoreBookList from "./LoreBookList.svelte";
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

    it("ignores a delete confirmed after the character switched", async () => {
        install({ alpha: [entry("a0"), entry("a1")], beta: [entry("b0"), entry("b1")] });
        selectCharacter("alpha");
        render({ submenu: 0 });
        let confirm!: (answer: boolean) => void;
        mocks.alertConfirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => (confirm = resolve)));

        removeButton(rows()[1]).click();
        await Promise.resolve();
        selectCharacter("beta");
        flushSync();
        confirm(true);
        await settle();

        expect(plain(globalLore("alpha"))).toEqual(plain([entry("a0"), entry("a1")]));
        expect(plain(globalLore("beta"))).toEqual(plain([entry("b0"), entry("b1")]));
        expect(labels()).toEqual(["b0", "b1"]);
        expect(unhandled).toEqual([]);
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
