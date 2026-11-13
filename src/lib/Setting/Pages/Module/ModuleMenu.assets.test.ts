// @vitest-environment happy-dom
import { flushSync, mount, tick, unmount } from "svelte";
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
const io = vi.hoisted(() => ({
    selectSingleFile: vi.fn<typeof import("src/ts/util").selectSingleFile>(),
    selectMultipleFile: vi.fn<typeof import("src/ts/util").selectMultipleFile>(),
    selectMultipleFileHandles: vi.fn<typeof import("src/ts/util").selectMultipleFileHandles>(),
    savePickedFiles: vi.fn<typeof import("src/ts/storage/assetQueue").savePickedFiles>(),
}));
vi.mock("src/ts/util", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/util")>()),
    selectSingleFile: io.selectSingleFile,
    selectMultipleFile: io.selectMultipleFile,
    selectMultipleFileHandles: io.selectMultipleFileHandles,
}));
vi.mock("src/ts/storage/assetQueue", async (importOriginal) => ({
    ...(await importOriginal<typeof import("src/ts/storage/assetQueue")>()),
    savePickedFiles: io.savePickedFiles,
}));
vi.mock("src/ts/characters", () => ({ createBlankChar: vi.fn(), getCharImage: vi.fn() }));
vi.mock("src/ts/storage/characterStore.svelte", () => ({ characterList: vi.fn(), selectedCharacter: vi.fn() }));
vi.mock("src/ts/storage/chatStore.svelte", async () =>
    (await import("src/ts/storage/tests/chatStoreMock")).createChatStoreMock(),
);
vi.mock("src/ts/storage/settingsViews.svelte", () => ({
    settings: { ui: { useAdditionalAssetsPreview: false } },
    activePreset: {},
    tabPersonaRecord: vi.fn(),
}));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/globalApi.svelte", async () =>
    (await import("src/ts/tests/globalApiMock")).createGlobalApiMock({
        holdFileSrc: (path: string) => ({ src: Promise.resolve(path), release: () => {} }),
    }),
);

import ModuleMenu from "./ModuleMenu.svelte";
import AssetInput from "src/lib/ChatScreens/AssetInput.svelte";
import { language } from "src/lang";
import type { RisuModule } from "src/ts/process/modules";
import type { ClientCharacter } from "src/ts/storage/characterStore.svelte";
import {
    applyRaw,
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
    for (const mock of Object.values(io)) mock.mockReset();
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
    it("module names keep focus and the caret on local renames, and blur on outside row replacement", () => {
        const { module } = render("module", [
            ["apple", "p0", "png"],
            ["banana", "p1", "png"],
        ]);
        const name = nameInputs()[0];
        name.focus();
        name.setSelectionRange(2, 2);
        for (const [expected, caret] of [
            ["apXple", 3],
            ["apXYple", 4],
        ] as const) {
            name.value = expected;
            name.setSelectionRange(caret, caret);
            name.dispatchEvent(new Event("input", { bubbles: true }));
            flushSync();
            expect(nameInputs()[0]).toBe(name);
            expect(document.activeElement).toBe(name);
            expect([name.selectionStart, name.selectionEnd]).toEqual([caret, caret]);
            expect(module.assets![0][0]).toBe(expected);
        }

        const modules = JSON.parse(JSON.stringify(recordData("modules"))) as RisuModule[];
        const renamed = modules[0].assets!;
        for (const replacement of [[...renamed].reverse(), [renamed[0]]]) {
            nameInputs()[0].focus();
            applyRaw("modules", [{ ...modules[0], assets: structuredClone(replacement) }, modules[1]]);
            flushSync();
            expect(nameInputs()[0]).toBe(name);
            expect(document.activeElement).not.toBe(name);
            expect(rowNames("module")).toEqual(replacement.map((row) => row[0]));
            expect(JSON.parse(JSON.stringify(module.assets))).toEqual(replacement);
        }
    });

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
        // A character's asset list is immutable: a frozen leaf, never a wrapper.
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

    describe("the immutable module list", () => {
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

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const regex = (name: string) => ({ comment: name, in: name, out: name, type: "editoutput" as const });
const lore = (name: string) => ({
    key: name,
    comment: name,
    content: name,
    mode: "normal" as const,
    insertorder: 100,
    alwaysActive: false,
    secondkey: "",
    selective: false,
});

it.each(["regex", "lorebook", "assets"] as const)(
    "%s picker imports succeed for the original module and cancel after a switch, replacement or removal",
    async (kind) => {
        const view = render("module", [["original", "old", "png"]], [["other", "other", "png"]]);
        const modules = trackedRecord<RisuModule[]>("modules")!;
        for (const module of modules) {
            module.regex = [regex(module.id)];
            module.lorebook = [lore(module.id)];
        }
        click(
            button(
                kind === "regex"
                    ? language.regexScript
                    : kind === "lorebook"
                      ? language.loreBook
                      : language.additionalAssets,
            )!,
        );
        const file = {
            name: "import.json",
            data: new TextEncoder().encode(
                JSON.stringify(
                    kind === "regex"
                        ? { type: "regex", data: [regex("imported")] }
                        : { type: "risu", data: [lore("imported")] },
                ),
            ),
        };
        io.savePickedFiles.mockResolvedValue(["saved"]);
        for (const change of ["unchanged", "switch", "replace", "remove"] as const) {
            const picked = deferred<void>();
            io.selectSingleFile.mockImplementationOnce(async () => {
                await picked.promise;
                return file;
            });
            io.selectMultipleFile.mockImplementationOnce(async () => {
                await picked.promise;
                return [file];
            });
            io.selectMultipleFileHandles.mockImplementationOnce(async () => {
                await picked.promise;
                return [new File(["asset"], "new.png")];
            });
            click(
                target.querySelector<HTMLButtonElement>(
                    kind === "assets" ? "th button:has(.lucide-plus)" : "button:has(.lucide-hard-drive-upload)",
                )!,
            );
            const catalog = plain(recordData("modules")) as RisuModule[];
            if (change === "switch") view.switchOwner();
            if (change === "replace")
                applyRaw("modules", [
                    {
                        ...catalog[0],
                        name: "Replacement",
                        regex: [regex("replacement")],
                        lorebook: [lore("replacement")],
                    },
                    catalog[1],
                ]);
            if (change === "remove") applyRaw("modules", [catalog[1]]);
            flushSync();
            const before = plain(recordData("modules")) as RisuModule[];
            picked.resolve();
            // Picker, real parser/upload boundary, then the component's continuation.
            for (let i = 0; i < 6; i++) await tick();
            flushSync();
            if (change === "unchanged") {
                const expected = structuredClone(before);
                if (kind === "regex") expected[0].regex!.push(regex("imported"));
                if (kind === "lorebook") expected[0].lorebook!.push(lore("imported"));
                if (kind === "assets") expected[0].assets = [...expected[0].assets!, ["new.png", "saved", "png"]];
                expect(plain(recordData("modules"))).toEqual(expected);
            } else expect(plain(recordData("modules"))).toEqual(before);
            if (change === "switch") view.switchOwner(0);
        }
    },
);

it("cancels an asset import after selection changes during upload", async () => {
    const view = render("module", [["original", "old", "png"]], [["other", "other", "png"]]);
    io.selectMultipleFileHandles.mockResolvedValueOnce([new File(["asset"], "new.png")]);
    const uploaded = deferred<string[]>();
    io.savePickedFiles.mockReturnValueOnce(uploaded.promise);
    const before = plain(recordData("modules"));
    click(target.querySelector<HTMLButtonElement>("th button:has(.lucide-plus)")!);
    await tick();
    expect(io.savePickedFiles).toHaveBeenCalled();
    view.switchOwner();
    uploaded.resolve(["saved"]);
    await tick();
    flushSync();
    expect(plain(recordData("modules"))).toEqual(before);
});
