// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BUILD_ID_PATTERN, formatBuildId, projectBuildInfo, UNKNOWN_BUILD } from "../buildInfo.ts";

const COMMIT = "a9fa6f8c5d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a";

describe("projectBuildInfo", () => {
    it("keeps a full or abbreviated lowercase commit, its YYYY-MM-DD date, and dirty only when true", () => {
        expect(projectBuildInfo({ commit: COMMIT, date: "2026-10-26", dirty: true })).toEqual({
            commit: COMMIT,
            date: "2026-10-26",
            dirty: true,
        });
        expect(projectBuildInfo({ commit: "a9fa6f8c5", date: "2026-10-26", dirty: "yes" })).toEqual({
            commit: "a9fa6f8c5",
            date: "2026-10-26",
            dirty: false,
        });
    });

    it("is unknown without a commit of the hash shape, whatever the date or dirty flag say", () => {
        for (const commit of [undefined, "", "a9fa6f8", COMMIT.toUpperCase(), `${COMMIT}0`, "a9fa6f8c5 dirty"]) {
            expect(projectBuildInfo({ commit, date: "2026-10-26", dirty: true })).toEqual(UNKNOWN_BUILD);
        }
        expect(projectBuildInfo(null)).toEqual(UNKNOWN_BUILD);
        expect(projectBuildInfo("a9fa6f8c5")).toEqual(UNKNOWN_BUILD);
    });

    it("drops a date of another shape and keeps the commit", () => {
        for (const date of ["2026-10-26T00:00:00Z", "26.10.2026", "2026.10.26", 20261026]) {
            expect(projectBuildInfo({ commit: COMMIT, date })).toEqual({ commit: COMMIT, date: null, dirty: false });
        }
    });
});

describe("formatBuildId", () => {
    it("writes the date with dots, nine hex digits of the commit, and -dirty", () => {
        expect(formatBuildId({ commit: COMMIT, date: "2026-10-26", dirty: false })).toBe("2026.10.26 · a9fa6f8c5");
        expect(formatBuildId({ commit: COMMIT, date: "2026-10-26", dirty: true })).toBe("2026.10.26 · a9fa6f8c5-dirty");
        expect(formatBuildId({ commit: COMMIT, date: null, dirty: false })).toBe("a9fa6f8c5");
        expect(formatBuildId(UNKNOWN_BUILD)).toBeNull();
    });

    it("always writes an id BUILD_ID_PATTERN accepts, and the pattern refuses other text", () => {
        for (const info of [
            { commit: COMMIT, date: "2026-10-26", dirty: true },
            { commit: COMMIT, date: null, dirty: false },
        ]) {
            expect(formatBuildId(info)).toMatch(BUILD_ID_PATTERN);
        }
        for (const text of ["unknown", "2026.10.26 a9fa6f8c5", "2026.10.26 · a9fa6f8c", `a9fa6f8c5 ${COMMIT}`, ""]) {
            expect(text).not.toMatch(BUILD_ID_PATTERN);
        }
    });
});
