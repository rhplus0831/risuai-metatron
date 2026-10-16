import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { characterAssetNames, matchingAssetIndices, moduleAssetNames } from "./assetList";
import type { RisuModule } from "./process/modules";
import {
    applyRaw,
    applyRawCharacter,
    characterFieldPlain,
    characterFieldStamp,
    initializeRecords,
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
type Character = { chaId: string; name: string; additionalAssets: Asset[]; note?: unknown };
const character = () => trackedCharacters<Character[]>()![0];
const module = () => trackedRecord<RisuModule[]>("modules")![0];

beforeEach(() => {
    resetRecords();
    setCharacterWriteListener({ character: () => {}, membership: () => {} });
    setRecordWriteListener(() => {});
});
afterEach(() => resetRecords());

describe("asset list name caches", () => {
    it("shares detached character field copies and names until an asset write or replacement", () => {
        const original: Asset[] = [["SunSET pose", "assets/dawn.png", "png"]];
        initializeRecords({ characters: [{ chaId: "c", name: "C", additionalAssets: original }] });
        const live = character();
        const assets = live.additionalAssets;
        const copy = characterFieldPlain<Asset[]>("c", "additionalAssets")!;
        const names = characterAssetNames("c", assets);
        const stamp = characterFieldStamp("c", "additionalAssets");
        expect(copy).toEqual(original);
        expect(copy).not.toBe(original);
        expect(copy[0]).not.toBe(original[0]);
        expect(isRecordWrapper(copy)).toBe(false);
        expect(isRecordWrapper(copy[0])).toBe(false);
        expect(names).toEqual(["sunset pose"]);
        expect(matchingAssetIndices(names, "set p")).toEqual([0]);
        expect(matchingAssetIndices(names, "dawn")).toEqual([]);
        expect(matchingAssetIndices(names, "png")).toEqual([]);

        live.name = "Unrelated edit";
        expect(characterFieldStamp("c", "additionalAssets")).toBe(stamp);
        expect(characterFieldPlain("c", "additionalAssets")).toBe(copy);
        expect(characterAssetNames("c", live.additionalAssets)).toBe(names);

        assets[0][0] = "MoonRISE";
        expect(characterFieldStamp("c", "additionalAssets")).not.toBe(stamp);
        const renamed = characterFieldPlain<Asset[]>("c", "additionalAssets")!;
        const renamedNames = characterAssetNames("c", assets);
        expect(renamed).not.toBe(copy);
        expect(renamed).toEqual([["MoonRISE", "assets/dawn.png", "png"]]);
        expect(renamedNames).not.toBe(names);
        expect(renamedNames).toEqual(["moonrise"]);
        expect(characterFieldPlain("c", "additionalAssets")).toBe(renamed);
        expect(characterAssetNames("c", assets)).toBe(renamedNames);
        // Readers must never lowercase or mutate either the live tuples or an older copy.
        expect(copy).toEqual([["SunSET pose", "assets/dawn.png", "png"]]);
        expect(assets[0][0]).toBe("MoonRISE");

        assets[0][1] = "assets/new.webp";
        assets[0][2] = "webp";
        expect(characterFieldPlain("c", "additionalAssets")).toEqual([["MoonRISE", "assets/new.webp", "webp"]]);
        assets.push(["Another", "assets/another.png", "png"]);
        expect(characterAssetNames("c", assets)).toEqual(["moonrise", "another"]);
        assets.splice(0, 1);
        expect(characterAssetNames("c", assets)).toEqual(["another"]);

        patchRawCharacter("c", [["additionalAssets", [["Remote", "remote.png", "png"]]]]);
        expect(characterAssetNames("c", live.additionalAssets)).toEqual(["remote"]);
        expect(characterFieldPlain("c", "additionalAssets")).toEqual([["Remote", "remote.png", "png"]]);
        applyRawCharacter("c", { chaId: "c", name: "Replacement", additionalAssets: [["Fresh", "fresh.png", "png"]] });
        expect(characterAssetNames("c", character().additionalAssets)).toEqual(["fresh"]);
        expect(characterFieldPlain("c", "additionalAssets")).toEqual([["Fresh", "fresh.png", "png"]]);
        expect(characterFieldPlain("missing", "additionalAssets")).toBeUndefined();
        expect(characterFieldPlain("c", "absent")).toBeUndefined();
    });

    it("refreshes uncacheable character names and plain create-mode module names", () => {
        initializeRecords({ characters: [{ chaId: "c", name: "C", additionalAssets: [["Before", "p", "png"]] }] });
        const live = character();
        const before = characterAssetNames("c", live.additionalAssets);
        // Non-JSON data makes this record uncacheable through the public write boundary.
        live.note = new Date(0);
        expect(characterFieldStamp("c", "additionalAssets")).toBeNull();
        live.additionalAssets[0][0] = "AFTER";
        expect(characterAssetNames("c", live.additionalAssets)).toEqual(["after"]);
        expect(before).toEqual(["before"]);

        const draft: Pick<RisuModule, "assets"> = { assets: [["Draft pose", "assets/hidden.png", "png"]] };
        const names = moduleAssetNames(draft);
        expect(names).toEqual(["draft pose"]);
        draft.assets[0][0] = "Renamed";
        expect(moduleAssetNames(draft)).toEqual(["renamed"]);
        expect(names).toEqual(["draft pose"]);
        draft.assets.push(["Added", "assets/added.png", "png"]);
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

        live.assets[0][0] = "Changed";
        const changedNames = moduleAssetNames(live);
        expect(changedNames).not.toBe(names);
        expect(changedNames).toEqual(["changed"]);
        expect(moduleAssetNames(live)).toBe(changedNames);
        expect(moduleFieldPlain(live, "assets")).toEqual([["Changed", "assets/path-only.png", "png"]]);
        expect(copy).toEqual([["Mixed CASE", "assets/path-only.png", "png"]]);
        live.assets.push(["Added", "a", "webp"]);
        expect(moduleAssetNames(live)).toEqual(["changed", "added"]);
        live.assets.splice(0, 1);
        expect(moduleAssetNames(live)).toEqual(["added"]);
        live.assets = [["Local", "l", "png"]];
        expect(moduleAssetNames(live)).toEqual(["local"]);
        applyRaw("modules", [{ id: "m", name: "M", assets: [["Remote", "r", "png"]] }]);
        expect(moduleAssetNames(module())).toEqual(["remote"]);
        expect(moduleFieldPlain(module(), "assets")).toEqual([["Remote", "r", "png"]]);
    });

    it("scans 100k cached names cheaply across successive queries for both record owners", () => {
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

        // Exclude the initial copy and DOM work. A generous 3s for 80 scans guards against
        // walking 8 million record tuples per keystroke, not differences in machine speed.
        const start = performance.now();
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
        expect(performance.now() - start).toBeLessThan(3_000);
        expect(characterAssetNames("c", liveCharacter.additionalAssets)).toBe(characterNames);
        expect(moduleAssetNames(liveModule)).toBe(moduleNames);
    });
});
