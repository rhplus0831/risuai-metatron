import { describe, expect, it } from "vitest";
import { folderOfItem, groupByFolder, normalizeItemFolders, withItemInFolder, withoutItem } from "./itemFolders.ts";

describe("item folders", () => {
    it("normalizes folder fields and unique identities without repairing cross-folder membership, then stays fixed", () => {
        expect(normalizeItemFolders(undefined)).toEqual([]);
        const input = [
            { id: "kept", name: "First", data: ["b", " a ", "b", "", " \t", 4, null, "a", " a "], extra: true },
            { id: "kept", name: 7, data: ["b"] },
            { id: "", name: "Empty id", data: "b" },
            { id: 4, name: "Invalid id", data: null },
            { name: "Missing id" },
        ];
        const before = JSON.stringify(input);
        const normalized = normalizeItemFolders(input);
        const ids = normalized.map((folder) => folder.id);
        expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
        expect(new Set(ids).size).toBe(5);
        expect(normalized).toEqual([
            { id: "kept", name: "First", data: ["b", " a ", "a"] },
            { id: ids[1], name: "", data: ["b"] },
            { id: ids[2], name: "Empty id", data: [] },
            { id: ids[3], name: "Invalid id", data: [] },
            { id: ids[4], name: "Missing id", data: [] },
        ]);
        expect(JSON.stringify(normalizeItemFolders(normalized))).toBe(JSON.stringify(normalized));
        expect(JSON.stringify(input)).toBe(before);
    });

    it("groups each item in input order under its first folder or the root, retaining empty and stale folders", () => {
        const items = [
            { id: "root-b", name: "Root B" },
            { id: "b", name: "B" },
            { id: "a", name: "A" },
            { id: "root-a", name: "Root A" },
            { id: "c", name: "C" },
        ];
        const folders = [
            { id: "first", name: "First", data: ["a", "missing", "b"] },
            { id: "second", name: "Second", data: ["b", "c"] },
            { id: "empty", name: "Empty", data: [] },
            { id: "stale", name: "Stale", data: ["missing"] },
        ];
        const before = JSON.stringify({ items, folders });
        expect(groupByFolder(items, folders)).toEqual({
            folders: [
                { folder: folders[0], items: [items[1], items[2]] },
                { folder: folders[1], items: [items[4]] },
                { folder: folders[2], items: [] },
                { folder: folders[3], items: [] },
            ],
            root: [items[0], items[3]],
        });
        expect(folderOfItem(folders, "b")).toBe(folders[0]);
        expect(folderOfItem(folders, "root-b")).toBeNull();
        expect(JSON.stringify({ items, folders })).toBe(before);
    });

    it("moves or removes membership in new lists while reusing untouched folders and preserving the input", () => {
        const folders = [
            { id: "first", name: "First", data: ["item", "keep"] },
            { id: "second", name: "Second", data: ["item"] },
            { id: "target", name: "Target", data: ["other"] },
            { id: "untouched", name: "Untouched", data: ["stale"] },
        ];
        const before = JSON.stringify(folders);
        const moved = withItemInFolder(folders, "item", "target");
        expect(moved).not.toBe(folders);
        expect(moved).toEqual([
            { id: "first", name: "First", data: ["keep"] },
            { id: "second", name: "Second", data: [] },
            { id: "target", name: "Target", data: ["other", "item"] },
            { id: "untouched", name: "Untouched", data: ["stale"] },
        ]);
        expect(moved[3]).toBe(folders[3]);
        const repeated = withItemInFolder(moved, "item", "target");
        expect(repeated).not.toBe(moved);
        repeated.forEach((folder, index) => expect(folder).toBe(moved[index]));
        for (const removed of [
            withItemInFolder(folders, "item", null),
            withItemInFolder(folders, "item", "gone"),
            withoutItem(folders, "item"),
        ]) {
            expect(removed).not.toBe(folders);
            expect(removed).toEqual([
                { id: "first", name: "First", data: ["keep"] },
                { id: "second", name: "Second", data: [] },
                { id: "target", name: "Target", data: ["other"] },
                { id: "untouched", name: "Untouched", data: ["stale"] },
            ]);
            expect(removed[2]).toBe(folders[2]);
            expect(removed[3]).toBe(folders[3]);
        }
        expect(JSON.stringify(folders)).toBe(before);
    });
});
