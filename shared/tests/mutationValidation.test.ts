// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MutationValidationError, requireObject } from "../mutationValidation.ts";
import { isPlainObject } from "../valueKinds.ts";

class Payload {
    value = 1;
}

const nonPlainObjects = [
    ["Map", new Map()],
    ["Date", new Date(0)],
    ["class instance", new Payload()],
    ["array", []],
] as const;

describe("isPlainObject", () => {
    it("accepts object literals and null-prototype objects, refusing non-plain objects", () => {
        expect(isPlainObject({ value: 1 })).toBe(true);
        expect(isPlainObject(Object.create(null))).toBe(true);
        for (const [name, value] of nonPlainObjects) {
            expect(isPlainObject(value), name).toBe(false);
        }
    });
});

describe("requireObject", () => {
    it("rejects Maps, Dates, class instances, and arrays with an object validation error", () => {
        for (const [name, value] of nonPlainObjects) {
            expect(() => requireObject(name, value)).toThrowError(MutationValidationError);
            expect(() => requireObject(name, value)).toThrowError("expected an object");
        }
    });

    it("accepts object literals and null-prototype objects", () => {
        expect(() => requireObject("payload", { value: 1 })).not.toThrow();
        expect(() => requireObject("payload", Object.create(null))).not.toThrow();
    });
});
