import { describe, expect, it } from "vitest";
import { reorderShown } from "./personaGrid";

const list = ["root-a", "folder-a", "root-b", "folder-b", "root-c"].map((id) => ({ id, name: id }));

describe("reorderShown", () => {
    it("reorders a folder's members in their existing slots among interleaved root personas", () => {
        const reordered = reorderShown(list, ["folder-b", "folder-a"]);

        expect(reordered).toEqual([list[0], list[3], list[2], list[1], list[4]]);
        expect(list.map((persona) => persona.id)).toEqual(["root-a", "folder-a", "root-b", "folder-b", "root-c"]);
    });

    it("ignores a shown id whose persona is gone while reordering the remaining shown personas", () => {
        expect(reorderShown(list, ["folder-b", "gone", "folder-a"])).toEqual([
            list[0],
            list[3],
            list[2],
            list[1],
            list[4],
        ]);
    });

    it("leaves the order unchanged for an empty shown list", () => {
        expect(reorderShown(list, [])).toEqual(list);
    });
});
