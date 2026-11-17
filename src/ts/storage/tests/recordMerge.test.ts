import { describe, expect, it } from "vitest";
import { mergeItemCollection } from "../recordMerge";

describe("collection membership after merging", () => {
    it("refuses disjoint deletions that empty a required collection but permits an optional collection to become empty", () => {
        const a = { id: "a", name: "A" };
        const b = { id: "b", name: "B" };
        // Each side kept one item, but together their deletions remove both.
        expect(mergeItemCollection("presets", [a, b], [a], [b])).toBeNull();
        expect(mergeItemCollection("togglePresets", [a, b], [a], [b])).toEqual([]);
    });
});

describe("folder collection merging", () => {
    const base = [
        { id: "filing", name: "Filing", data: ["item"] },
        { id: "other", name: "Other", data: ["kept"] },
    ];

    it("merges a move to the root with another folder's rename", () => {
        const moved = [{ id: "filing", name: "Filing", data: [] }, base[1]];
        const renamed = [base[0], { id: "other", name: "Renamed", data: ["kept"] }];
        for (const kind of ["moduleFolders", "personaFolders"] as const) {
            expect(mergeItemCollection(kind, base, moved, renamed)).toEqual([
                { id: "filing", name: "Filing", data: [] },
                { id: "other", name: "Renamed", data: ["kept"] },
            ]);
        }
    });

    it("converges on equal changes of the same folder", () => {
        const changed = [{ id: "filing", name: "Filed", data: ["item", "new"] }, base[1]];
        for (const kind of ["moduleFolders", "personaFolders"] as const) {
            expect(mergeItemCollection(kind, base, changed, structuredClone(changed))).toEqual([
                { id: "filing", name: "Filed", data: ["item", "new"] },
                { id: "other", name: "Other", data: ["kept"] },
            ]);
        }
    });

    it("conflicts on differing changes of one folder even when they edit different fields", () => {
        const moved = [{ id: "filing", name: "Filing", data: [] }, base[1]];
        const renamed = [{ id: "filing", name: "Renamed", data: ["item"] }, base[1]];
        for (const kind of ["moduleFolders", "personaFolders"] as const) {
            expect(mergeItemCollection(kind, base, moved, renamed)).toBeNull();
        }
    });
});
