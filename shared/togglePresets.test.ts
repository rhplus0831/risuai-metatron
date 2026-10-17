import { afterEach, describe, expect, it, vi } from "vitest";
import { createTogglePreset, normalizeTogglePresets } from "./togglePresets.ts";

afterEach(() => vi.restoreAllMocks());

describe("normalizeTogglePresets", () => {
    it("keeps valid ids and names, re-keys every duplicate or invalid id, and supplies exactly the six preset fields", () => {
        const input = [
            { id: "saved", name: " Saved name ", extra: "drop" },
            { id: "saved", name: "Duplicate" },
            { id: "", name: "" },
            { id: 7, name: 7 },
            { id: null },
            {},
        ];
        const original = structuredClone(input);
        const result = normalizeTogglePresets(input);
        expect(result).toEqual(
            [
                ["saved", " Saved name "],
                [expect.any(String), "Duplicate"],
                [expect.any(String), "Toggle Preset 3"],
                [expect.any(String), "Toggle Preset 4"],
                [expect.any(String), "Toggle Preset 5"],
                [expect.any(String), "Toggle Preset 6"],
            ].map(([id, name]) => ({ id, name, values: {}, kinds: {}, createdAt: 0, updatedAt: 0 })),
        );
        expect(new Set(result.map((preset) => preset.id)).size).toBe(input.length);
        expect(result.every((preset) => preset.id.length > 0)).toBe(true);
        expect(input).toEqual(original);
    });

    it("keeps only string values and the four value kinds, with empty maps for non-object inputs", () => {
        const result = normalizeTogglePresets([
            {
                id: "p",
                values: {
                    flag: "0",
                    mode: "2",
                    title: "",
                    notes: "a\nb",
                    nil: null,
                    number: 1,
                    bool: false,
                    nested: {},
                },
                kinds: {
                    flag: "checkbox",
                    mode: "select",
                    title: "text",
                    notes: "textarea",
                    group: "group",
                    end: "groupEnd",
                    rule: "divider",
                    help: "caption",
                    unknown: "custom",
                    nil: null,
                    number: 1,
                },
            },
            ...[undefined, null, [], ["text"], "text", 1, true].map((map) => ({ values: map, kinds: map })),
        ]);
        expect(result[0]).toEqual({
            id: "p",
            name: "Toggle Preset 1",
            values: { flag: "0", mode: "2", title: "", notes: "a\nb" },
            kinds: { flag: "checkbox", mode: "select", title: "text", notes: "textarea" },
            createdAt: 0,
            updatedAt: 0,
        });
        for (const preset of result.slice(1)) {
            expect(preset.values).toEqual({});
            expect(preset.kinds).toEqual({});
        }
    });

    it("preserves __proto__ as an own data key in both maps, including after JSON round trips", () => {
        const values = JSON.parse('{"__proto__":"private text","constructor":"value"}');
        const kinds = JSON.parse('{"__proto__":"textarea","constructor":"text"}');
        const [preset] = normalizeTogglePresets([{ id: "p", values, kinds }]);
        expect(preset.values).toEqual(values);
        expect(preset.kinds).toEqual(kinds);
        expect(Object.getOwnPropertyDescriptor(preset.values, "__proto__")).toMatchObject({
            value: "private text",
            enumerable: true,
        });
        expect(Object.getOwnPropertyDescriptor(preset.kinds, "__proto__")).toMatchObject({
            value: "textarea",
            enumerable: true,
        });
        expect(normalizeTogglePresets(JSON.parse(JSON.stringify([preset])))).toEqual([preset]);
    });

    it("uses finite timestamps or deterministic fallbacks and reaches a fixed point without reading the clock", () => {
        const clock = vi.spyOn(Date, "now").mockImplementation(() => {
            throw new Error("normalization read the clock");
        });
        const input = [
            {},
            { createdAt: 12.5, updatedAt: -3 },
            { createdAt: -4, updatedAt: Infinity },
            { createdAt: NaN, updatedAt: 8 },
            { createdAt: Infinity, updatedAt: NaN },
            { createdAt: -Infinity, updatedAt: -Infinity },
            { createdAt: "12", updatedAt: "15" },
            { createdAt: null, updatedAt: null },
            { createdAt: 9, updatedAt: 0 },
        ];
        const result = normalizeTogglePresets(input);
        expect(result.map(({ createdAt, updatedAt }) => [createdAt, updatedAt])).toEqual([
            [0, 0],
            [12.5, -3],
            [-4, -4],
            [0, 8],
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 0],
            [9, 0],
        ]);
        expect(normalizeTogglePresets(result)).toEqual(result);
        expect(JSON.stringify(normalizeTogglePresets(JSON.parse(JSON.stringify(result))))).toBe(JSON.stringify(result));
        expect(normalizeTogglePresets(undefined)).toEqual([]);
        expect(clock).not.toHaveBeenCalled();
    });
});

describe("createTogglePreset", () => {
    it("keeps a valid supplied id or assigns a fresh one, copies maps, and stamps both times with now", () => {
        vi.spyOn(Date, "now").mockReturnValue(123456);
        const values = JSON.parse('{"title":"text","__proto__":"own text"}');
        const kinds = JSON.parse('{"title":"text","__proto__":"textarea"}');
        for (const id of ["p", "__proto__", " "]) {
            const preset = createTogglePreset("Named", values, kinds, id);
            expect(preset).toEqual({ id, name: "Named", values, kinds, createdAt: 123456, updatedAt: 123456 });
            expect(preset.values).not.toBe(values);
            expect(preset.kinds).not.toBe(kinds);
            expect(Object.hasOwn(preset.values, "__proto__")).toBe(true);
            expect(Object.hasOwn(preset.kinds, "__proto__")).toBe(true);
            preset.values.title = "changed";
            preset.kinds.title = "textarea";
            expect(values.title).toBe("text");
            expect(kinds.title).toBe("text");
        }
        const fresh = [undefined, "", null, 7, {}].map((id) => createTogglePreset("New", {}, {}, id));
        expect(new Set(fresh.map((preset) => preset.id)).size).toBe(fresh.length);
        for (const preset of fresh) {
            expect(typeof preset.id).toBe("string");
            expect(preset.id.length).toBeGreaterThan(0);
            expect(preset).toEqual({
                id: preset.id,
                name: "New",
                values: {},
                kinds: {},
                createdAt: 123456,
                updatedAt: 123456,
            });
        }
    });
});
