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
vi.mock("src/ts/alert", () => ({ alertNormal: vi.fn(), alertError: vi.fn(), alertMd: vi.fn() }));
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
        module.assets.push(["Target C", "path-c", "png"]);
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

    it("sticker selection receives the live source tuple after edits and list replacement", () => {
        const prefix: Asset[] = Array.from({ length: 103 }, (_, i) => [`Other ${i}`, `p${i}`, "mp3"]);
        const view = render("sticker", [...prefix, ["Target", "old-path", "mp3"]]);
        input(search(), "target");
        expect(rowNames("sticker")).toEqual(["Target"]);
        const tuple = view.character.additionalAssets[103];
        tuple[0] = "Renamed";
        tuple[1] = "live-path";
        flushSync();
        expect(rowNames("sticker")).toEqual(["Renamed"]);
        click(stickerButtons()[0]);
        expect(view.onSelect).toHaveBeenLastCalledWith(["Renamed", "live-path", "mp3"]);
        expect(view.onSelect.mock.calls[0][0]).toBe(tuple);
        input(search(), "renamed");
        expect(rowNames("sticker")).toEqual(["Renamed"]);
        input(search(), "target");
        expect(rowNames("sticker")).toEqual([]);
        view.character.additionalAssets = [...prefix, ["Target replacement", "new-path", "mp3"]];
        flushSync();
        expect(rowNames("sticker")).toEqual(["Target replacement"]);
        click(stickerButtons()[0]);
        expect(view.onSelect).toHaveBeenLastCalledWith(["Target replacement", "new-path", "mp3"]);
        expect(view.onSelect.mock.calls[1][0]).toBe(view.character.additionalAssets[103]);
    });
});
