// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The emotion image table on `CharConfig`'s view screen tab (large-asset-import slice 4a), mounted
// over the real records, selection, paging constant, `LazyFileSrc`, and `rmCharEmotion`. It pages
// like the additional-asset list, reads each preview only once its row nears the viewport, and keys
// its rows by tuple, so a rename binds the tuple the row was mounted for and a delete addresses the
// row's source index (open-bug-fixes slice C7). Unrelated panels, dialogs and file loading are doubled.

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
vi.mock("src/lib/SideBars/LoreBook/LoreBookSetting.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/SideBars/Scripts/RegexList.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/SideBars/Scripts/TriggerList.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/SideBars/Toggles.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/UI/GUI/TextAreaInput.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/UI/GUI/MultiLangInput.svelte", () => ({ default: () => {} }));

import CharConfig from "./CharConfig.svelte";
import { language } from "src/lang";
import { ASSET_LIST_PAGE } from "src/ts/util";
import { CharConfigSubMenu } from "src/ts/stores.svelte";
import { settings } from "src/ts/storage/settingsViews.svelte";
import { characterList } from "src/ts/storage/characterStore.svelte";
import { selectCharacter } from "src/ts/storage/selection.svelte";
import { setCharacterWriteListener, setRecordWriteListener } from "src/ts/storage/records.svelte";
import { installFlatDatabaseWithChats } from "src/ts/storage/tests/installFlatDatabase";

type Emotion = [string, string];

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

function installCharacters(first: Emotion[], second: Emotion[]) {
    installFlatDatabaseWithChats({
        characters: [first, second].map((emotionImages, index) => ({
            chaId: `c${index + 1}`,
            type: "character",
            name: `C${index + 1}`,
            viewScreen: "emotion",
            emotionImages,
            chatPage: 0,
            chats: [{ id: `k${index + 1}`, name: "K", note: "", localLore: [], message: [] }],
        })),
    });
}

function record(chaId: string) {
    return characterList().find((entry) => entry?.chaId === chaId)! as unknown as { emotionImages: Emotion[] };
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
        // Rows are keyed by their tuple (open-bug-fixes slice C7): the typed-into row's binding is
        // read again after a tick (Svelte's `bind_value`), by then unmounted or moved by the shrink.
        const first = emotions("joy", 5);
        installCharacters(first, []);
        selectCharacter("c1");
        render();
        const unhandled: unknown[] = [];
        const onRejection = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", onRejection);
        try {
            // Typing into the last row, then deleting the first in the same task: an index binding
            // of the last row would read past the shrunken list's end; the keyed row stays mounted.
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
});
