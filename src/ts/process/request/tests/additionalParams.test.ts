import { describe, expect, it, vi } from "vitest";

import { parseAdditionalParamJsonValue } from "../additionalParams";
import { applyAdditionalParameters } from "../shared";

describe("parseAdditionalParamJsonValue", () => {
    it("parses standard JSON additional parameter values", () => {
        expect(parseAdditionalParamJsonValue('{"enable_thinking":true,"budget_tokens":0}')).toEqual({
            enable_thinking: true,
            budget_tokens: 0,
        });
    });

    it("accepts Python-style booleans and null in json:: values", () => {
        expect(
            parseAdditionalParamJsonValue('{"enable_thinking": True, "nested": {"flag": False, "value": None}}'),
        ).toEqual({
            enable_thinking: true,
            nested: {
                flag: false,
                value: null,
            },
        });
    });

    it("does not rewrite quoted keyword strings", () => {
        expect(
            parseAdditionalParamJsonValue('{"string_true": "True", "string_false": "False", "string_none": "None"}'),
        ).toEqual({
            string_true: "True",
            string_false: "False",
            string_none: "None",
        });
    });

    it("returns undefined for invalid json:: payloads", () => {
        expect(parseAdditionalParamJsonValue('{"enable_thinking": Truthy}')).toBeUndefined();
    });
});

describe("applyAdditionalParameters prototype safety", () => {
    it("skips forbidden paths with warnings and preserves ordinary nested fields", () => {
        const pollutionKeys = ["__risuTabAdditionalProto", "__risuTabAdditionalCtor"];
        const originalDescriptors = pollutionKeys.map((key) => Object.getOwnPropertyDescriptor(Object.prototype, key));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        try {
            const body = { options: { keep: "sibling", nested: { keep: "nested sibling" } } };
            applyAdditionalParameters(body, {}, [
                [`__proto__.${pollutionKeys[0]}`, "1"],
                [`constructor.prototype.${pollutionKeys[1]}`, "1"],
                ["blocked.constructor", "1"],
                ["blocked.prototype.value", "1"],
                ["a.b.c", "1"],
                ["options.nested.value", "2"],
            ]);

            expect(pollutionKeys.map((key) => Object.getOwnPropertyDescriptor(Object.prototype, key))).toEqual(
                originalDescriptors,
            );
            expect(warn).toHaveBeenCalledTimes(4);
            expect(body).toEqual({
                a: { b: { c: 1 } },
                options: { keep: "sibling", nested: { keep: "nested sibling", value: 2 } },
            });
        } finally {
            pollutionKeys.forEach((key, index) => {
                const descriptor = originalDescriptors[index];
                if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
                else Reflect.deleteProperty(Object.prototype, key);
            });
            warn.mockRestore();
        }
    });

    it("creates own intermediate objects instead of mutating inherited ones", () => {
        const prototype = { branch: { keep: "prototype sibling" } };
        const body = { existing: Object.create(prototype) as Record<string, unknown> };

        applyAdditionalParameters(body, {}, [["existing.branch.a.b", "1"]]);

        expect(prototype).toEqual({ branch: { keep: "prototype sibling" } });
        expect(Object.hasOwn(body.existing, "branch")).toBe(true);
        expect(body).toMatchObject({ existing: { branch: { a: { b: 1 } } } });
    });
});
