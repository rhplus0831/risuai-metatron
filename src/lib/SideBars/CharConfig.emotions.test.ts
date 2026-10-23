// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The emotion image table on `CharConfig`'s view screen tab, mounted over the real records,
// selection, paging constant, `LazyFileSrc`, and `rmCharEmotion`. It pages like the additional-asset
// list, reads each preview only once its row nears the viewport, and renames and deletes by source
// index, replacing the frozen list whole; a pending input never writes another row or character.
// Unrelated panels, dialogs and file loading are doubled.

const holdFileSrc = vi.fn((path: string) => ({ src: Promise.resolve(`/file/${path}`), release: () => {} }));
vi.mock("src/ts/globalApi.svelte", () => ({
    holdFileSrc: (path: string) => holdFileSrc(path),
    getFileSrc: vi.fn(async () => ""),
    saveAsset: vi.fn(),
    downloadFile: vi.fn(),
}));
vi.mock("src/ts/characters", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/characters")>()),
    getCharImage: vi.fn(async () => ""),
}));
vi.mock("src/ts/tokenizer", () => ({ tokenizeAccurate: vi.fn(async () => 0) }));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/lib/SideBars/LoreBook/LoreBookSetting.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/SideBars/Scripts/RegexList.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/SideBars/Scripts/TriggerList.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/SideBars/Toggles.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/UI/GUI/TextAreaInput.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/UI/GUI/MultiLangInput.svelte", () => ({ default: () => {} }));
// The additional-asset picker and the save queue are doubled: `picker` resolves the files the add
// button "picks", `savePickedFiles` names a key per file.
const { picker } = vi.hoisted(() => ({ picker: { current: async (): Promise<File[]> => [] } }));
vi.mock("src/ts/util", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/util")>()),
    selectMultipleFileHandles: () => picker.current(),
}));
vi.mock("src/ts/storage/assetQueue", () => ({
    savePickedFiles: async (files: File[]) => files.map((file) => `key-${file.name}`),
}));

import CharConfig from "./CharConfig.svelte";
import { language } from "src/lang";
import { alertError } from "src/ts/alert";
import { tokenizeAccurate } from "src/ts/tokenizer";
import { assembleChats, currentChatRef, selectedChat } from "src/ts/storage/chatStore.svelte";
import { ASSET_LIST_PAGE } from "src/ts/util";
import { CharConfigSubMenu } from "src/ts/stores.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { characterList } from "src/ts/storage/characterStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { isRecordWrapper, setCharacterWriteListener, setRecordWriteListener } from "src/ts/storage/records.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";

type Emotion = [string, string];
type Asset = [string, string, string];

/** A stand-in observer the test drives: `intersect(n)` reports the first `n` observed rows as visible. */
class FakeObserver {
    static live: FakeObserver[] = [];
    observed: Element[] = [];
    constructor(private callback: IntersectionObserverCallback) {
        FakeObserver.live.push(this);
    }
    observe(element: Element) {
        this.observed.push(element);
    }
    disconnect() {
        FakeObserver.live = FakeObserver.live.filter((observer) => observer !== this);
    }
}

let target: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;
const originalObserver = globalThis.IntersectionObserver;

const emotions = (prefix: string, count: number): Emotion[] =>
    Array.from({ length: count }, (_, i) => [`${prefix} ${i}`, `${prefix}/${i}.png`]);

function installCharacters(first: Emotion[], second: Emotion[], additionalAssets: Asset[] = []) {
    installFlatDatabaseWithChats({
        characters: [first, second].map((emotionImages, index) => ({
            chaId: `c${index + 1}`,
            type: "character",
            name: `C${index + 1}`,
            viewScreen: "emotion",
            emotionImages,
            additionalAssets: structuredClone(additionalAssets),
            chatPage: 0,
            chats: [{ id: `k${index + 1}`, name: "K", note: "", localLore: [], message: [] }],
        })),
    });
}

function record(chaId: string) {
    return characterList().find((entry) => entry?.chaId === chaId)! as unknown as {
        emotionImages: Emotion[];
        additionalAssets: Asset[];
    };
}

function render() {
    instance = mount(CharConfig, { target });
    flushSync();
    CharConfigSubMenu.set(1);
    flushSync();
    button(language.viewScreen)!.click();
    flushSync();
}

function button(text: string) {
    return [...target.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
}
function input(node: HTMLInputElement, value: string) {
    node.value = value;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
}
/** The emotion table's rows (its header row excluded), each with its name input, preview, and delete button. */
function rows() {
    const table = [...target.querySelectorAll("table")].find((node) =>
        node.querySelector("th")?.textContent.includes(language.image),
    )!;
    return [...table.querySelectorAll("tr")]
        .filter((row) => row.querySelector("input"))
        .map((row) => ({
            name: row.querySelector("input")!,
            src: row.querySelector("img")?.getAttribute("src") ?? null,
            remove: row.querySelector("button")!,
        }));
}
const names = () => rows().map((row) => row.name.value);
const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
};
function intersect(count: number) {
    for (const observer of FakeObserver.live.slice(0, count)) {
        const entries = observer.observed.map((node) => ({ target: node, isIntersecting: true }));
        observer["callback"](entries as unknown as IntersectionObserverEntry[], observer as never);
    }
    flushSync();
}

beforeEach(() => {
    holdFileSrc.mockClear();
    FakeObserver.live = [];
    globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
    setRecordWriteListener(() => {});
    setCharacterWriteListener({ character: () => {}, membership: () => {} });
    settings.ui.hideAllImages = false;
    target = document.createElement("div");
    document.body.append(target);
});
afterEach(async () => {
    if (instance) await unmount(instance);
    instance = null;
    target.remove();
    CharConfigSubMenu.set(0);
    globalThis.IntersectionObserver = originalObserver;
});

it("mounts without an error when the selected character's chat is not loaded", async () => {
    installFlatDatabaseWithChats({
        characters: [
            {
                chaId: "waiting",
                type: "character",
                name: "Waiting character",
                desc: "",
                firstMessage: "",
                chats: [{ id: "waiting-chat", name: "Waiting chat", note: "", message: [], localLore: [] }],
            },
        ],
    });
    selectCharacter("waiting");
    assembleChats(
        [{ chaId: "waiting" }],
        [{ characterId: "waiting", id: "waiting-chat", revision: "r1", name: "Waiting chat", fmIndex: -1 }],
        [{ characterId: "waiting", revision: "o1", ids: ["waiting-chat"] }],
    );
    expect(currentChatRef()).toEqual({ chaId: "waiting", chatId: "waiting-chat" });
    expect(selectedChat()).toBeNull();
    vi.mocked(alertError).mockClear();
    vi.mocked(tokenizeAccurate).mockClear();

    instance = mount(CharConfig, { target });
    flushSync();
    await settle();

    expect([...target.querySelectorAll("input")].some((input) => input.value === "Waiting character")).toBe(true);
    expect(alertError).not.toHaveBeenCalled();
    // The real tokenizer rejects non-strings before it can load a tokenizer or count tokens.
    for (const [text] of vi.mocked(tokenizeAccurate).mock.calls) {
        expect(text).toEqual(expect.any(String));
    }
});

describe("CharConfig emotion images", () => {
    it("pages rows by ASSET_LIST_PAGE with Load More and resets the page per character", () => {
        const first = emotions("joy", 2 * ASSET_LIST_PAGE + 5);
        const second = emotions("calm", ASSET_LIST_PAGE + 1);
        installCharacters(first, second);
        selectCharacter("c1");
        render();

        expect(names()).toEqual(first.slice(0, ASSET_LIST_PAGE).map((emotion) => emotion[0]));
        for (const count of [2 * ASSET_LIST_PAGE, first.length]) {
            button(language.loadMore)!.click();
            flushSync();
            expect(names()).toEqual(first.slice(0, count).map((emotion) => emotion[0]));
        }
        expect(button(language.loadMore)).toBeUndefined();

        selectCharacter("c2");
        flushSync();
        expect(names()).toEqual(second.slice(0, ASSET_LIST_PAGE).map((emotion) => emotion[0]));
        button(language.loadMore)!.click();
        flushSync();
        expect(names()).toEqual(second.map((emotion) => emotion[0]));
        expect(button(language.loadMore)).toBeUndefined();

        selectCharacter("c1");
        flushSync();
        expect(names()).toHaveLength(ASSET_LIST_PAGE);
        expect(button(language.loadMore)).toBeDefined();
    });

    it("reads a preview only once its row is seen, and shows the placeholder when images are hidden", async () => {
        installCharacters(emotions("joy", 2 * ASSET_LIST_PAGE), []);
        selectCharacter("c1");
        render();
        await settle();
        expect(holdFileSrc).not.toHaveBeenCalled();
        expect(rows().every((row) => row.src === null)).toBe(true);

        intersect(3);
        await settle();
        expect(holdFileSrc.mock.calls.map((call) => call[0])).toEqual(["joy/0.png", "joy/1.png", "joy/2.png"]);
        expect(
            rows()
                .map((row) => row.src)
                .slice(0, 4),
        ).toEqual(["/file/joy/0.png", "/file/joy/1.png", "/file/joy/2.png", null]);

        settings.ui.hideAllImages = true;
        flushSync();
        expect(rows().every((row) => row.src === "/none.webp")).toBe(true);
        expect(holdFileSrc).toHaveBeenCalledTimes(3);
    });

    it("renames and deletes the source entry by index on a later page", () => {
        const first = emotions("joy", ASSET_LIST_PAGE + 3);
        installCharacters(first, []);
        selectCharacter("c1");
        render();
        button(language.loadMore)!.click();
        flushSync();

        input(rows()[ASSET_LIST_PAGE].name, "renamed");
        const expected = first.map((emotion) => [...emotion]);
        expected[ASSET_LIST_PAGE][0] = "renamed";
        expect(record("c1").emotionImages.map((emotion) => [...emotion])).toEqual(expected);
        expect(names()[ASSET_LIST_PAGE]).toBe("renamed");

        rows()[ASSET_LIST_PAGE + 1].remove.click();
        flushSync();
        expected.splice(ASSET_LIST_PAGE + 1, 1);
        expect(record("c1").emotionImages.map((emotion) => [...emotion])).toEqual(expected);
        expect(names()).toEqual(expected.map((emotion) => emotion[0]));

        rows()[0].remove.click();
        flushSync();
        expected.splice(0, 1);
        expect(record("c1").emotionImages.map((emotion) => [...emotion])).toEqual(expected);
        expect(names()).toEqual(expected.map((emotion) => emotion[0]));
        expect(names()[ASSET_LIST_PAGE - 1]).toBe("renamed");
    });

    it("deletes while another row's input is pending, or the typed-into row itself, without a throw", async () => {
        // A row's input must not be read again past the shrunken list's end, or write another row,
        // once a delete in the same task moved or unmounted it.
        const first = emotions("joy", 5);
        installCharacters(first, []);
        selectCharacter("c1");
        render();
        const unhandled: unknown[] = [];
        const onRejection = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", onRejection);
        try {
            // Typing into the last row, then deleting the first in the same task: the last row's
            // index is past the shrunken list's end.
            const last = rows()[4];
            last.name.focus();
            last.name.value = "last renamed";
            last.name.dispatchEvent(new Event("input", { bubbles: true }));
            rows()[0].remove.click();
            flushSync();
            await settle();
            await new Promise((resolve) => setTimeout(resolve, 0));
            const expected = first.map((emotion) => [...emotion]);
            expected[4][0] = "last renamed";
            expected.splice(0, 1);
            expect(record("c1").emotionImages.map((emotion) => [...emotion])).toEqual(expected);
            expect(names()).toEqual(expected.map((emotion) => emotion[0]));

            // Typing into a row and deleting that row in the same task unmounts the row typed into.
            const zero = rows()[0];
            zero.name.focus();
            zero.name.value = "gone";
            zero.name.dispatchEvent(new Event("input", { bubbles: true }));
            zero.remove.click();
            flushSync();
            await settle();
            await new Promise((resolve) => setTimeout(resolve, 0));
            expected.splice(0, 1);
            expect(record("c1").emotionImages.map((emotion) => [...emotion])).toEqual(expected);
            expect(names()).toEqual(expected.map((emotion) => emotion[0]));
        } finally {
            process.off("unhandledRejection", onRejection);
        }
        expect(unhandled).toEqual([]);
    });

    it("renames the entry a row was mounted for, not the next character's, across a character switch", async () => {
        const first = emotions("joy", 3);
        const second = emotions("calm", 3);
        installCharacters(first, second);
        selectCharacter("c1");
        render();

        const row = rows()[1];
        row.name.focus();
        row.name.value = "joy renamed";
        row.name.dispatchEvent(new Event("input", { bubbles: true }));
        selectCharacter("c2");
        flushSync();
        await settle();

        const expected = first.map((emotion) => [...emotion]);
        expected[1][0] = "joy renamed";
        expect(record("c1").emotionImages.map((emotion) => [...emotion])).toEqual(expected);
        expect(record("c2").emotionImages.map((emotion) => [...emotion])).toEqual(second);
        expect(names()).toEqual(second.map((emotion) => emotion[0]));
    });

    it("renames per keystroke by replacing the frozen list, and deletes the final edited row, then the rest", () => {
        const first = emotions("joy", 3);
        installCharacters(first, []);
        selectCharacter("c1");
        render();
        // The list is immutable: a rename replaces it, copying only its pair; the
        // other pairs are shared.
        const list = record("c1").emotionImages;
        expect(Object.isFrozen(list)).toBe(true);
        expect(isRecordWrapper(list)).toBe(false);
        const kept = list[0];
        input(rows()[2].name, "e");
        input(rows()[2].name, "ed");
        expect(record("c1").emotionImages).not.toBe(list);
        expect(record("c1").emotionImages[0]).toBe(kept);
        expect(Object.isFrozen(record("c1").emotionImages)).toBe(true);
        expect(record("c1").emotionImages.map((emotion) => [...emotion])).toEqual([
            first[0],
            first[1],
            ["ed", "joy/2.png"],
        ]);
        expect(names()).toEqual(["joy 0", "joy 1", "ed"]);
        // The row just typed into is the one the delete unmounts.
        rows()[2].remove.click();
        flushSync();
        expect(record("c1").emotionImages.map((emotion) => [...emotion])).toEqual([first[0], first[1]]);
        expect(names()).toEqual(["joy 0", "joy 1"]);
        input(rows()[1].name, "last");
        rows()[1].remove.click();
        flushSync();
        rows()[0].remove.click();
        flushSync();
        expect(record("c1").emotionImages).toEqual([]);
        expect(names()).toEqual([]);
        expect(Object.isFrozen(record("c1").emotionImages)).toBe(true);
    });
});

// The additional-asset table of the same tab: the list is immutable, so a rename replaces it per
// keystroke, a delete filters it, and an add appends to the latest list of the character the picker
// was opened for, found again by `chaId` after the awaits. The search hold keeps a renamed row
// visible under its query only for the list the rename made.
describe("CharConfig additional assets", () => {
    const assets = (count: number): Asset[] =>
        Array.from({ length: count }, (_, i) => [`Asset ${i}`, `assets/${i}.png`, "png"]);
    function renderAssets() {
        instance = mount(CharConfig, { target });
        flushSync();
        CharConfigSubMenu.set(1);
        flushSync();
        button(language.additionalAssets)!.click();
        flushSync();
    }
    const table = () =>
        [...target.querySelectorAll("table")].find((node) =>
            node.querySelector(`input[placeholder="${language.search}"]`),
        )!;
    const search = () => table().querySelector<HTMLInputElement>(`input[placeholder="${language.search}"]`)!;
    const nameInputs = () => [...table().querySelectorAll<HTMLInputElement>('input[placeholder="..."]')];
    const rowNames = () => nameInputs().map((node) => node.value);
    const addButton = () => table().querySelector<HTMLButtonElement>("th button")!;
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
    const settleAdd = async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
        flushSync();
    };

    it("renames per keystroke under a query (the row stays visible), matches again for any other list, and deletes by source index", () => {
        installCharacters(
            [],
            [],
            [...assets(2), ["Target", "assets/t.png", "png"], ["Other target", "assets/o.png", "png"]],
        );
        selectCharacter("c1");
        renderAssets();
        const original = record("c1").additionalAssets;
        expect(Object.isFrozen(original)).toBe(true);
        expect(isRecordWrapper(original)).toBe(false);
        expect(rowNames()).toEqual(["Asset 0", "Asset 1", "Target", "Other target"]);

        input(search(), "target");
        expect(rowNames()).toEqual(["Target", "Other target"]);
        input(nameInputs()[0], "R");
        expect(rowNames()).toEqual(["R", "Other target"]);
        input(nameInputs()[0], "Renamed");
        expect(rowNames()).toEqual(["Renamed", "Other target"]);
        const renamed = record("c1").additionalAssets;
        expect(renamed).not.toBe(original);
        expect(Object.isFrozen(renamed)).toBe(true);
        expect(renamed[0]).toBe(original[0]);
        expect(renamed[3]).toBe(original[3]);
        expect(plain(renamed)).toEqual([
            ...assets(2),
            ["Renamed", "assets/t.png", "png"],
            ["Other target", "assets/o.png", "png"],
        ]);
        expect(plain(original)[2]).toEqual(["Target", "assets/t.png", "png"]);

        // A list the component's own rename did not make matches again under the same query.
        record("c1").additionalAssets = [...renamed, ["Target C", "assets/c.png", "png"]];
        flushSync();
        expect(rowNames()).toEqual(["Other target", "Target C"]);
        // A changed query drops the hold.
        input(nameInputs()[0], "Also renamed");
        expect(rowNames()).toEqual(["Also renamed", "Target C"]);
        input(search(), "renamed");
        expect(rowNames()).toEqual(["Renamed", "Also renamed"]);
        input(search(), "");
        expect(rowNames()).toEqual(["Asset 0", "Asset 1", "Renamed", "Also renamed", "Target C"]);

        // Delete by the row's source index: the only button in its row.
        input(search(), "target");
        expect(rowNames()).toEqual(["Target C"]);
        nameInputs()[0].closest("tr")!.querySelector("button")!.click();
        flushSync();
        expect(rowNames()).toEqual([]);
        expect(target.textContent).toContain(language.noMatchingAssets);
        expect(plain(record("c1").additionalAssets)).toEqual([
            ...assets(2),
            ["Renamed", "assets/t.png", "png"],
            ["Also renamed", "assets/o.png", "png"],
        ]);
        expect(Object.isFrozen(record("c1").additionalAssets)).toBe(true);
        // An in-place write into the live list is refused.
        expect(() => (record("c1").additionalAssets[0][0] = "x")).toThrow(TypeError);
    });

    it("adds to the latest list of the character the picker was opened for, after a switch and an edit meanwhile", async () => {
        installCharacters([], [], assets(1));
        selectCharacter("c1");
        renderAssets();
        let release: (files: File[]) => void = () => {};
        picker.current = () => new Promise((resolve) => (release = resolve));
        addButton().click();
        await Promise.resolve();
        // Meanwhile: the list is replaced (an edit elsewhere) and another character is selected.
        record("c1").additionalAssets = [...record("c1").additionalAssets, ["Meanwhile", "assets/m.png", "png"]];
        selectCharacter("c2");
        flushSync();
        expect(rowNames()).toEqual(["Asset 0"]);
        release([new File(["x"], "picked.png"), new File(["y"], "clip.mp4")]);
        await settleAdd();
        expect(plain(record("c1").additionalAssets)).toEqual([
            ...assets(1),
            ["Meanwhile", "assets/m.png", "png"],
            ["picked.png", "key-picked.png", "png"],
            ["clip.mp4", "key-clip.mp4", "mp4"],
        ]);
        expect(Object.isFrozen(record("c1").additionalAssets)).toBe(true);
        expect(plain(record("c2").additionalAssets)).toEqual(assets(1));
        // Back on c1, the rows show the appended list.
        selectCharacter("c1");
        flushSync();
        expect(rowNames()).toEqual(["Asset 0", "Meanwhile", "picked.png", "clip.mp4"]);
    });
});
