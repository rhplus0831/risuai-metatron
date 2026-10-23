import { describe, expect, it } from "vitest";
import { addBlockedRealmCreator, isRealmCreatorBlocked, removeBlockedRealmCreator } from "./realmBlocking";

describe("Realm creator blocking", () => {
    it("adds and matches creators by id without duplicating an existing block", () => {
        const first = { id: "creator-a", name: "Shared name" };
        const second = { id: "creator-b", name: "Shared name" };
        const added = addBlockedRealmCreator([first], second);

        expect(added).toEqual([first, second]);
        expect(addBlockedRealmCreator(added, { id: "creator-b", name: "Renamed" })).toEqual([first, second]);
        expect(isRealmCreatorBlocked(added, "creator-b")).toBe(true);
        expect(isRealmCreatorBlocked(added, "Shared name")).toBe(false);
        expect(isRealmCreatorBlocked(added)).toBe(false);
    });

    it("unblocks only the selected creator by id", () => {
        const remaining = removeBlockedRealmCreator(
            [
                { id: "creator-a", name: "Shared name" },
                { id: "creator-b", name: "Shared name" },
            ],
            "creator-a",
        );

        expect(remaining).toEqual([{ id: "creator-b", name: "Shared name" }]);
        expect(isRealmCreatorBlocked(remaining, "creator-a")).toBe(false);
        expect(isRealmCreatorBlocked(remaining, "creator-b")).toBe(true);
    });
});
