import { describe, expect, it } from "vitest";
import { supaMemoryOnCount } from "../characters.ts";

// The one reader of the owner's memory-toggle count (`docs/structure/memory.md`): the tab's toggles
// and the server's trim question compare a chat's `memoryTrimAck` to it, so both must read a stored
// value the same way, and a malformed one as 0.

describe("supaMemoryOnCount", () => {
    it("reads a stored nonnegative safe integer", () => {
        expect(supaMemoryOnCount({ supaMemoryOnCount: 0 })).toBe(0);
        expect(supaMemoryOnCount({ supaMemoryOnCount: 3 })).toBe(3);
        expect(supaMemoryOnCount({ supaMemoryOnCount: Number.MAX_SAFE_INTEGER })).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("is 0 for a missing owner, a missing field, and every malformed value", () => {
        expect(supaMemoryOnCount(undefined)).toBe(0);
        expect(supaMemoryOnCount({})).toBe(0);
        for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null, true, {}]) {
            expect(supaMemoryOnCount({ supaMemoryOnCount: value }), String(value)).toBe(0);
        }
    });
});
