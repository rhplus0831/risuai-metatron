// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactiveProps } from "src/lib/UI/tests/reactiveProps.svelte";

// Keep the real inputs, paging constant, asset helpers and records. Only unrelated editor
// panels, dialogs and file loading are doubled; no asset filtering behavior is mocked.
vi.mock("src/lib/SideBars/LoreBook/LoreBookList.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/SideBars/Scripts/RegexList.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/SideBars/Scripts/TriggerList.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/UI/PopupList.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/UI/GUI/TextAreaInput.svelte", () => ({ default: () => {} }));
vi.mock("src/ts/process/lorebook.svelte", () => ({ convertExternalLorebook: vi.fn() }));
vi.mock("src/ts/process/regexFiles", () => ({ exportRegex: vi.fn(), importRegex: vi.fn() }));
vi.mock("src/ts/characters", () => ({ createBlankChar: vi.fn(), getCharImage: vi.fn() }));
vi.mock("src/ts/storage/characterStore.svelte", () => ({ characterList: vi.fn(), selectedCharacter: vi.fn() }));
vi.mock("src/ts/storage/chatStore.svelte", () => ({ chatEntry: vi.fn(), currentChatRef: vi.fn() }));
vi.mock("src/ts/storage/settingsViews.svelte", () => ({
    settings: { ui: { useAdditionalAssetsPreview: false } },
    activePreset: {},
    tabPersonaRecord: vi.fn(),
}));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/globalApi.svelte", () => ({
    saveAsset: vi.fn(),
    downloadFile: vi.fn(),
    holdFileSrc: (path: string) => ({ src: Promise.resolve(path), release: () => {} }),
}));

import ModuleMenu from "./ModuleMenu.svelte";
import AssetInput from "src/lib/ChatScreens/AssetInput.svelte";
import { language } from "src/lang";
import type { RisuModule } from "src/ts/process/modules";
import type { ClientCharacter } from "src/ts/storage/characterStore.svelte";
import {
    initializeRecords,
    isRecordWrapper,
    recordData,
    resetRecords,
    setCharacterWriteListener,
    setRecordWriteListener,
    trackedCharacters,
    trackedRecord,
} from "src/ts/storage/records.svelte";

type Asset = [string, string, string];
type ListKind = "module" | "sticker";
let target: HTMLDivElement;
let instance: ReturnType<typeof mount>;

beforeEach(() => {
    resetRecords();
    setRecordWriteListener(() => {});
    setCharacterWriteListener({ character: () => {}, membership: () => {} });
    target = document.createElement("div");
    document.body.append(target);
});
afterEach(async () => {
    if (instance) await unmount(instance);
    target.remove();
    resetRecords();
});

function button(text: string) {
    return [...target.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
}
function click(node: HTMLButtonElement) {
    node.click();
    flushSync();
}
function input(node: HTMLInputElement, value: string) {
    node.value = value;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
}
const search = () => target.querySelector<HTMLInputElement>(`input[placeholder="${language.search}"]`)!;
const nameInputs = () => [...target.querySelectorAll<HTMLInputElement>('input[placeholder="..."]')];
const stickerButtons = () => [...target.querySelectorAll("button")].filter((node) => node.querySelector("div"));
const rowNames = (kind: ListKind) =>
    kind === "module"
        ? nameInputs().map((node) => node.value)
        : stickerButtons().map((node) => node.textContent.trim());

function render(kind: ListKind, assets: Asset[], otherAssets: Asset[] = assets) {
    initializeRecords({
        characters: [
            { chaId: "c1", type: "character", name: "C1", additionalAssets: assets },
            { chaId: "c2", type: "character", name: "C2", additionalAssets: structuredClone(otherAssets) },
        ],
        modules: [
            { id: "m1", name: "M1", description: "", assets: structuredClone(assets) },
            { id: "m2", name: "M2", description: "", assets: structuredClone(otherAssets) },
        ],
    });
    const characters = trackedCharacters<ClientCharacter[]>()!;
    const modules = trackedRecord<RisuModule[]>("modules")!;
    const onSelect = vi.fn<(asset: Asset) => void>();
    const props = reactiveProps({ currentCharacter: characters[0], currentModule: modules[0], onSelect });
    instance = kind === "module" ? mount(ModuleMenu, { target, props }) : mount(AssetInput, { target, props });
    flushSync();
    if (kind === "module") click(button(language.additionalAssets)!);
    return {
        onSelect,
        character: characters[0],
        module: modules[0],
        switchOwner(index = 1) {
            props.currentCharacter = characters[index];
            props.currentModule = modules[index];
            flushSync();
        },
    };
}

describe("paged asset lists", () => {
    it.each<ListKind>(["module", "sticker"])(
        "%s pages matching names, resets query/page, and reports no matches",
        (kind) => {
            const unrelated: Asset[] = Array.from({ length: 103 }, (_, i) => [
                `Other ${i}`,
                `assets/needle-${i}.mp3`,
                "mp3",
            ]);
            const matches: Asset[] = Array.from({ length: 205 }, (_, i) => [
                `Pose NeEdLe ${i}`,
                `assets/match-${i}.mp3`,
                "mp3",
            ]);
            const all = [...unrelated, ...matches];
            const other: Asset[] = Array.from({ length: 120 }, (_, i) => [`New owner ${i}`, `new/${i}.mp3`, "mp3"]);
            const view = render(kind, all, other);
            expect(rowNames(kind)).toEqual(unrelated.slice(0, 100).map((asset) => asset[0]));
            expect(button(language.loadMore)).toBeDefined();
            for (const count of [200, 300, 308]) {
                click(button(language.loadMore)!);
                expect(rowNames(kind)).toEqual(all.slice(0, count).map((asset) => asset[0]));
            }
            expect(button(language.loadMore)).toBeUndefined();

            input(search(), "  nEeDlE  ");
            expect(rowNames(kind)).toEqual(matches.slice(0, 100).map((asset) => asset[0]));
            click(button(language.loadMore)!);
            expect(rowNames(kind)).toEqual(matches.slice(0, 200).map((asset) => asset[0]));
            click(button(language.loadMore)!);
            expect(rowNames(kind)).toEqual(matches.map((asset) => asset[0]));
            expect(button(language.loadMore)).toBeUndefined();

            input(search(), "POSE");
            expect(rowNames(kind)).toEqual(matches.slice(0, 100).map((asset) => asset[0]));
            for (const query of ["mp3", "missing-name"]) {
                input(search(), query);
                expect(rowNames(kind)).toEqual([]);
                expect(target.textContent).toContain(language.noMatchingAssets);
                expect(button(language.loadMore)).toBeUndefined();
            }
            input(search(), "   ");
            expect(rowNames(kind)).toEqual(unrelated.slice(0, 100).map((asset) => asset[0]));
            expect(target.textContent).not.toContain(language.noMatchingAssets);

            input(search(), "needle");
            click(button(language.loadMore)!);
            view.switchOwner();
            expect(search().value).toBe("");
            expect(rowNames(kind)).toEqual(other.slice(0, 100).map((asset) => asset[0]));
            click(button(language.loadMore)!);
            expect(rowNames(kind)).toEqual(other.map((asset) => asset[0]));
            expect(button(language.loadMore)).toBeUndefined();
            // With an empty query on both owners, the owner change must reset paging itself.
            view.switchOwner(0);
            expect(search().value).toBe("");
            expect(rowNames(kind)).toEqual(unrelated.slice(0, 100).map((asset) => asset[0]));
        },
    );

    it("module edits and deletes the matched source row, retaining it during rename and refreshing on membership changes", () => {
        const prefix: Asset[] = Array.from({ length: 103 }, (_, i) => [`Other ${i}`, `p${i}`, "png"]);
        const original: Asset[] = [...prefix, ["Target A", "path-a", "png"], ["Target B", "path-b", "png"]];
        const { module } = render("module", original);
        input(search(), "target");
        expect(rowNames("module")).toEqual(["Target A", "Target B"]);
        input(nameInputs()[0], "R");
        expect(rowNames("module")).toEqual(["R", "Target B"]);
        input(nameInputs()[0], "Renamed");
        expect(rowNames("module")).toEqual(["Renamed", "Target B"]);
        expect([...module.assets].map((asset) => [...asset])).toEqual([
            ...prefix,
            ["Renamed", "path-a", "png"],
            original[104],
        ]);

        input(search(), "renamed");
        expect(rowNames("module")).toEqual(["Renamed"]);
        input(search(), "target");
        expect(rowNames("module")).toEqual(["Target B"]);
        input(nameInputs()[0], "Also renamed");
        expect(rowNames("module")).toEqual(["Also renamed"]);
        // The list is immutable: an addition replaces it whole (`ModuleMenu`'s add button).
        module.assets = [...module.assets!, ["Target C", "path-c", "png"]];
        flushSync();
        expect(rowNames("module")).toEqual(["Target C"]);

        input(search(), "renamed");
        input(nameInputs()[0], "Final name");
        expect(rowNames("module")).toEqual(["Final name", "Also renamed"]);
        // The only button in this name input's table row is its delete action.
        click(nameInputs()[1].closest("tr")!.querySelector("button")!);
        expect([...module.assets].map((asset) => [...asset])).toEqual([
            ...prefix,
            ["Final name", "path-a", "png"],
            ["Target C", "path-c", "png"],
        ]);
        expect(rowNames("module")).toEqual([]);
        expect(target.textContent).toContain(language.noMatchingAssets);

        input(search(), "target");
        // Same-length replacement must refresh membership too.
        module.assets = [...prefix, ["Target remote", "remote", "png"], ["Other tail", "tail", "png"]];
        flushSync();
        expect(rowNames("module")).toEqual(["Target remote"]);
    });

    it("sticker selection receives the live source tuple after a rename and a list replacement", () => {
        const prefix: Asset[] = Array.from({ length: 103 }, (_, i) => [`Other ${i}`, `p${i}`, "mp3"]);
        const view = render("sticker", [...prefix, ["Target", "old-path", "mp3"]]);
        // A character's asset list is immutable (heap plan B2): a frozen leaf, never a wrapper.
        expect(isRecordWrapper(view.character.additionalAssets)).toBe(false);
        expect(Object.isFrozen(view.character.additionalAssets)).toBe(true);
        input(search(), "target");
        expect(rowNames("sticker")).toEqual(["Target"]);
        expect(() => ((view.character.additionalAssets![103] as unknown as string[])[0] = "x")).toThrow(TypeError);
        const kept = view.character.additionalAssets![0];
        // A rename replaces the list whole: the matches are computed again under the current query.
        view.character.additionalAssets = [...prefix, ["Renamed", "live-path", "mp3"]];
        flushSync();
        expect(rowNames("sticker")).toEqual([]);
        expect(target.textContent).toContain(language.noMatchingAssets);
        input(search(), "renamed");
        expect(rowNames("sticker")).toEqual(["Renamed"]);
        click(stickerButtons()[0]);
        expect(view.onSelect).toHaveBeenLastCalledWith(["Renamed", "live-path", "mp3"]);
        expect(view.onSelect.mock.calls[0][0]).toBe(view.character.additionalAssets![103]);
        expect(Object.isFrozen(view.onSelect.mock.calls[0][0])).toBe(true);
        input(search(), "target");
        expect(rowNames("sticker")).toEqual([]);
        view.character.additionalAssets = [...prefix, ["Target replacement", "new-path", "mp3"]];
        flushSync();
        expect(rowNames("sticker")).toEqual(["Target replacement"]);
        click(stickerButtons()[0]);
        expect(view.onSelect).toHaveBeenLastCalledWith(["Target replacement", "new-path", "mp3"]);
        expect(view.onSelect.mock.calls[1][0]).toBe(view.character.additionalAssets![103]);
        // The unchanged tuples are shared between the old and the new lists.
        expect(view.character.additionalAssets![0]).toBe(kept);
    });

    describe("the immutable module list (heap plan B1)", () => {
        const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
        const rawAssets = () => recordData<RisuModule[]>("modules")![0].assets as unknown as string[][];
        const names = () => rowNames("module");

        it("a rename keeps a legacy pair's and an extended tuple's shape, the list frozen, the other tuples shared", () => {
            const original = [
                ["Legacy", "assets/legacy.png"],
                ["Four", "assets/four.png", "png", "extra"],
                ["Target", "p", "png"],
            ] as unknown as Asset[];
            const { module } = render("module", original);
            expect(Object.isFrozen(rawAssets())).toBe(true);
            expect(isRecordWrapper(module.assets)).toBe(false);
            const kept = module.assets![2];
            input(nameInputs()[0], "Legacy pair");
            expect(names()).toEqual(["Legacy pair", "Four", "Target"]);
            expect(Object.isFrozen(rawAssets())).toBe(true);
            expect(rawAssets().every((tuple) => Object.isFrozen(tuple))).toBe(true);
            expect(plain(rawAssets())).toEqual([
                ["Legacy pair", "assets/legacy.png"],
                ["Four", "assets/four.png", "png", "extra"],
                ["Target", "p", "png"],
            ]);
            expect(module.assets![2]).toBe(kept);
            input(nameInputs()[1], "Four fields");
            expect(plain(rawAssets())[1]).toEqual(["Four fields", "assets/four.png", "png", "extra"]);
            expect(Object.isFrozen(rawAssets())).toBe(true);
            expect(module.assets![2]).toBe(kept);
            // A delete replaces the list too; the remaining tuples keep their shape.
            click(nameInputs()[0].closest("tr")!.querySelector("button")!);
            expect(names()).toEqual(["Four fields", "Target"]);
            expect(plain(rawAssets())).toEqual([
                ["Four fields", "assets/four.png", "png", "extra"],
                ["Target", "p", "png"],
            ]);
            expect(Object.isFrozen(rawAssets())).toBe(true);
            expect(module.assets![1]).toBe(kept);
        });

        it("a cleared or changed query, a whitespace query, and an owner round trip drop the rename hold and match again", () => {
            const view = render(
                "module",
                [
                    ["Other", "p0", "png"],
                    ["Target", "p1", "png"],
                ],
                [["Second owner", "q", "png"]],
            );
            input(search(), "target");
            expect(names()).toEqual(["Target"]);
            input(nameInputs()[0], "Renamed");
            expect(names()).toEqual(["Renamed"]);
            input(search(), "");
            expect(names()).toEqual(["Other", "Renamed"]);
            input(search(), "target");
            expect(names()).toEqual([]);
            expect(target.textContent).toContain(language.noMatchingAssets);
            input(search(), "renamed");
            expect(names()).toEqual(["Renamed"]);
            input(nameInputs()[0], "Target again");
            expect(names()).toEqual(["Target again"]);
            input(search(), "   ");
            expect(names()).toEqual(["Other", "Target again"]);
            input(search(), "renamed");
            expect(names()).toEqual([]);
            input(search(), "target");
            expect(names()).toEqual(["Target again"]);
            input(nameInputs()[0], "Moved on");
            expect(names()).toEqual(["Moved on"]);
            view.switchOwner(1);
            expect(search().value).toBe("");
            expect(names()).toEqual(["Second owner"]);
            view.switchOwner(0);
            expect(names()).toEqual(["Other", "Moved on"]);
            input(search(), "target");
            expect(names()).toEqual([]);
            input(search(), "moved");
            expect(names()).toEqual(["Moved on"]);
            expect(plain(rawAssets())).toEqual([
                ["Other", "p0", "png"],
                ["Moved on", "p1", "png"],
            ]);
        });

        it("a list the rename did not make (a names-only reorder with duplicate paths) matches again and edits the right row", () => {
            const { module } = render("module", [
                ["Target", "shared", "png"],
                ["Other", "shared", "png"],
            ]);
            input(search(), "target");
            expect(names()).toEqual(["Target"]);
            input(nameInputs()[0], "Target x");
            expect(names()).toEqual(["Target x"]);
            // Another writer's copy: same length, same paths and extensions, the names reordered. The
            // row follows the name to its new index; typing in it edits that entry, not index 0.
            module.assets = [
                ["Other", "shared", "png"],
                ["Target x", "shared", "png"],
            ];
            flushSync();
            expect(names()).toEqual(["Target x"]);
            input(nameInputs()[0], "Target xy");
            expect(names()).toEqual(["Target xy"]);
            expect(plain(module.assets)).toEqual([
                ["Other", "shared", "png"],
                ["Target xy", "shared", "png"],
            ]);
            // A names-only replacement while a rename is held: matched again, not held.
            module.assets = [
                ["Other", "shared", "png"],
                ["Gone", "shared", "png"],
            ];
            flushSync();
            expect(names()).toEqual([]);
            expect(target.textContent).toContain(language.noMatchingAssets);
        });
    });
});
