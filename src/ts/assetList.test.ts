import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { characterAssetNames, matchingAssetIndices, moduleAssetNames } from "./assetList";
import type { RisuModule } from "./process/modules";
import {
    applyRaw,
    applyRawCharacter,
    characterFieldPlain,
    characterFieldStamp,
    initializeRecords,
    isFrozenAssetList,
    isRecordWrapper,
    moduleFieldPlain,
    patchRawCharacter,
    resetRecords,
    setCharacterWriteListener,
    setRecordWriteListener,
    trackedCharacters,
    trackedRecord,
} from "./storage/records.svelte";

type Asset = [string, string, string];
type Character = {
    chaId: string;
    name: string;
    additionalAssets: readonly (readonly [string, string, string])[];
    note?: unknown;
};
/** The live tuple of a mutable fallback list (a list of another shape), written in place. */
const writable = (asset: readonly string[]) => asset as string[];
const character = () => trackedCharacters<Character[]>()![0];
const module = () => trackedRecord<RisuModule[]>("modules")![0];

beforeEach(() => {
    resetRecords();
    setCharacterWriteListener({ character: () => {}, membership: () => {} });
    setRecordWriteListener(() => {});
});
afterEach(() => resetRecords());

describe("asset list name caches", () => {
    it("keeps a character's names by its frozen list's identity until a replacement", () => {
        const original: Asset[] = [["SunSET pose", "assets/dawn.png", "png"]];
        initializeRecords({ characters: [{ chaId: "c", name: "C", additionalAssets: original }] });
        const live = character();
        const assets = live.additionalAssets;
        const copy = characterFieldPlain<Asset[]>("c", "additionalAssets")!;
        const names = characterAssetNames("c", assets);
        const stamp = characterFieldStamp("c", "additionalAssets");
        // The installed list is the handed-over input, frozen in place; a read is the frozen list itself.
        expect(copy).toEqual(original);
        expect(Object.isFrozen(original)).toBe(true);
        expect(Object.isFrozen(assets)).toBe(true);
        expect(isRecordWrapper(assets)).toBe(false);
        expect(isFrozenAssetList(assets)).toBe(true);
        expect(isRecordWrapper(copy)).toBe(false);
        expect(isRecordWrapper(copy[0])).toBe(false);
        expect(names).toEqual(["sunset pose"]);
        expect(matchingAssetIndices(names, "set p")).toEqual([0]);
        expect(matchingAssetIndices(names, "dawn")).toEqual([]);
        expect(matchingAssetIndices(names, "png")).toEqual([]);

        live.name = "Unrelated edit";
        expect(characterFieldStamp("c", "additionalAssets")).toBe(stamp);
        expect(characterFieldPlain("c", "additionalAssets")).toBe(copy);
        expect(live.additionalAssets).toBe(assets);
        expect(characterAssetNames("c", live.additionalAssets)).toBe(names);

        // An in-place write is refused; a rename replaces the list (copying only its tuple).
        expect(() => (writable(assets[0])[0] = "MoonRISE")).toThrow(TypeError);
        expect(characterAssetNames("c", assets)).toBe(names);
        live.additionalAssets = assets.map((asset, i) => (i === 0 ? ["MoonRISE", asset[1], asset[2]] : asset));
        expect(characterFieldStamp("c", "additionalAssets")).not.toBe(stamp);
        const renamedList = live.additionalAssets;
        const renamed = characterFieldPlain<Asset[]>("c", "additionalAssets")!;
        const renamedNames = characterAssetNames("c", renamedList);
        expect(renamedList).not.toBe(assets);
        expect(renamed).not.toBe(copy);
        expect(renamed).toEqual([["MoonRISE", "assets/dawn.png", "png"]]);
        expect(renamedNames).not.toBe(names);
        expect(renamedNames).toEqual(["moonrise"]);
        expect(characterFieldPlain("c", "additionalAssets")).toBe(renamed);
        expect(characterAssetNames("c", live.additionalAssets)).toBe(renamedNames);
        // Readers must never lowercase or mutate either the live tuples or an older list.
        expect(copy).toEqual([["SunSET pose", "assets/dawn.png", "png"]]);
        expect(assets[0][0]).toBe("SunSET pose");
        expect(characterAssetNames("c", assets)).toBe(names);

        live.additionalAssets = [["MoonRISE", "assets/new.webp", "webp"]];
        expect(characterFieldPlain("c", "additionalAssets")).toEqual([["MoonRISE", "assets/new.webp", "webp"]]);
        live.additionalAssets = [...live.additionalAssets, ["Another", "assets/another.png", "png"]];
        expect(characterAssetNames("c", live.additionalAssets)).toEqual(["moonrise", "another"]);
        live.additionalAssets = live.additionalAssets.filter((_, index) => index !== 0);
        expect(characterAssetNames("c", live.additionalAssets)).toEqual(["another"]);

        patchRawCharacter("c", [["additionalAssets", [["Remote", "remote.png", "png"]]]]);
        expect(characterAssetNames("c", live.additionalAssets)).toEqual(["remote"]);
        expect(characterFieldPlain("c", "additionalAssets")).toEqual([["Remote", "remote.png", "png"]]);
        applyRawCharacter("c", { chaId: "c", name: "Replacement", additionalAssets: [["Fresh", "fresh.png", "png"]] });
        expect(characterAssetNames("c", character().additionalAssets)).toEqual(["fresh"]);
        expect(characterFieldPlain("c", "additionalAssets")).toEqual([["Fresh", "fresh.png", "png"]]);
        expect(characterFieldPlain("missing", "additionalAssets")).toBeUndefined();
        expect(characterFieldPlain("c", "absent")).toBeUndefined();
    });

    it("a retained wrapper of a list that later resolves to frozen lists is never a cache key", () => {
        // A list of another shape (a fourth element that is an object) is a mutable wrapper; the
        // wrapper's identity is stable across the replacements that follow, so it must stay on the
        // stamp path.
        initializeRecords({
            characters: [{ chaId: "c", name: "C", additionalAssets: [["Seed", "p", "png", { odd: true }]] }],
        });
        const live = character();
        const held = live.additionalAssets;
        expect(isRecordWrapper(held)).toBe(true);
        expect(isFrozenAssetList(held)).toBe(false);
        expect(characterAssetNames("c", held)).toEqual(["seed"]);
        for (const name of ["Old", "New"]) {
            live.additionalAssets = [[name, "p", "png"]];
            expect(isFrozenAssetList(live.additionalAssets)).toBe(true);
            expect(isFrozenAssetList(held)).toBe(false);
            expect(characterAssetNames("c", held)).toEqual([name.toLowerCase()]);
            expect(characterAssetNames("c", live.additionalAssets)).toEqual([name.toLowerCase()]);
        }
        // The wrapper's names are still reused while its stamp is unchanged.
        const names = characterAssetNames("c", held);
        live.name = "unrelated";
        expect(characterAssetNames("c", held)).toBe(names);
    });

    it("refreshes uncacheable character names of a mutable list and plain create-mode module names", () => {
        // A tuple holding an object is a list of another shape: mutable, wrapped, edited in place.
        initializeRecords({
            characters: [{ chaId: "c", name: "C", additionalAssets: [["Before", "p", "png", { odd: true }]] }],
        });
        const live = character();
        expect(isRecordWrapper(live.additionalAssets)).toBe(true);
        const before = characterAssetNames("c", live.additionalAssets);
        // Non-JSON data makes this record uncacheable through the public write boundary.
        live.note = new Date(0);
        expect(characterFieldStamp("c", "additionalAssets")).toBeNull();
        writable(live.additionalAssets[0])[0] = "AFTER";
        expect(characterAssetNames("c", live.additionalAssets)).toEqual(["after"]);
        expect(before).toEqual(["before"]);

        const draft: Pick<RisuModule, "assets"> = { assets: [["Draft pose", "assets/hidden.png", "png"]] };
        const names = moduleAssetNames(draft);
        expect(names).toEqual(["draft pose"]);
        // A module's asset list is immutable: an edit replaces it whole.
        draft.assets = [["Renamed", "assets/hidden.png", "png"]];
        expect(moduleAssetNames(draft)).toEqual(["renamed"]);
        expect(names).toEqual(["draft pose"]);
        draft.assets = [...draft.assets, ["Added", "assets/added.png", "png"]];
        expect(moduleAssetNames(draft)).toEqual(["renamed", "added"]);
        draft.assets = [["Replacement", "p", "png"]];
        expect(moduleAssetNames(draft)).toEqual(["replacement"]);
        expect(moduleAssetNames({})).toEqual([]);
    });

    it("reuses record module names across unrelated writes and rebuilds after asset writes and replacements", () => {
        initializeRecords({
            modules: [{ id: "m", name: "M", assets: [["Mixed CASE", "assets/path-only.png", "png"]] }],
        });
        const live = module();
        const copy = moduleFieldPlain(live, "assets");
        const names = moduleAssetNames(live);
        expect(names).toEqual(["mixed case"]);
        expect(matchingAssetIndices(names, "xed ca")).toEqual([0]);
        expect(matchingAssetIndices(names, "path-only")).toEqual([]);
        expect(matchingAssetIndices(names, "png")).toEqual([]);
        live.description = "Unrelated edit";
        expect(moduleFieldPlain(live, "assets")).toBe(copy);
        expect(moduleAssetNames(live)).toBe(names);

        // The record's list is frozen and shared as itself; an edit replaces it whole.
        expect(Object.isFrozen(copy)).toBe(true);
        expect(() => ((live.assets as any)[0][0] = "Changed")).toThrow(TypeError);
        expect(moduleAssetNames(live)).toBe(names);
        live.assets = [["Changed", "assets/path-only.png", "png"]];
        const changedNames = moduleAssetNames(live);
        expect(changedNames).not.toBe(names);
        expect(changedNames).toEqual(["changed"]);
        expect(moduleAssetNames(live)).toBe(changedNames);
        expect(moduleFieldPlain(live, "assets")).toEqual([["Changed", "assets/path-only.png", "png"]]);
        expect(copy).toEqual([["Mixed CASE", "assets/path-only.png", "png"]]);
        live.assets = [...live.assets, ["Added", "a", "webp"]];
        expect(moduleAssetNames(live)).toEqual(["changed", "added"]);
        live.assets = live.assets.filter((_, index) => index !== 0);
        expect(moduleAssetNames(live)).toEqual(["added"]);
        live.assets = [["Local", "l", "png"]];
        expect(moduleAssetNames(live)).toEqual(["local"]);
        applyRaw("modules", [{ id: "m", name: "M", assets: [["Remote", "r", "png"]] }]);
        expect(moduleAssetNames(module())).toEqual(["remote"]);
        expect(moduleFieldPlain(module(), "assets")).toEqual([["Remote", "r", "png"]]);
    });

    it("reuses 100k cached names across successive queries for both record owners", () => {
        const assets = (): Asset[] =>
            Array.from({ length: 100_000 }, (_, i) => [`Asset ${i}`, `assets/${i}.png`, "png"]);
        initializeRecords({
            characters: [{ chaId: "c", name: "C", additionalAssets: assets() }],
            modules: [{ id: "m", name: "M", assets: assets() }],
        });
        const liveCharacter = character();
        const liveModule = module();
        const characterNames = characterAssetNames("c", liveCharacter.additionalAssets);
        const moduleNames = moduleAssetNames(liveModule);
        expect(characterNames).toHaveLength(100_000);
        expect(moduleNames).toHaveLength(100_000);

        // Identity, not time, guards against walking 8 million record tuples per keystroke: a
        // wall-clock bound here failed under CPU load without any regression.
        for (let i = 0; i < 40; i++) {
            const query = `asset ${99_960 + i}`;
            const nextCharacterNames = characterAssetNames("c", liveCharacter.additionalAssets);
            const nextModuleNames = moduleAssetNames(liveModule);
            // Identity is a deterministic guard against rebuilding on every keystroke.
            expect(nextCharacterNames).toBe(characterNames);
            expect(nextModuleNames).toBe(moduleNames);
            expect(matchingAssetIndices(nextCharacterNames, query)).toEqual([99_960 + i]);
            expect(matchingAssetIndices(nextModuleNames, query)).toEqual([99_960 + i]);
        }
        expect(characterAssetNames("c", liveCharacter.additionalAssets)).toBe(characterNames);
        expect(moduleAssetNames(liveModule)).toBe(moduleNames);
    });
});
