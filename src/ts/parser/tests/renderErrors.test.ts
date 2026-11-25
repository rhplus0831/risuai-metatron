import { describe, expect, it } from "vitest";
import { isTransient, markTransient } from "../renderErrors";

describe("render error retry classification", () => {
    it.each([400, 401, 403, 404])("keeps HTTP %i errors unchanged and unmarked", (status) => {
        const failure = Object.assign(new Error("Asset refused"), { status });
        expect(markTransient(failure)).toBe(failure);
        expect(isTransient(failure)).toBe(false);
    });

    it.each([408, 429, 500, 503])("marks HTTP %i errors for retry without replacing them", (status) => {
        const failure = Object.assign(new Error("Asset unavailable"), { status });
        expect(markTransient(failure)).toBe(failure);
        expect(isTransient(failure)).toBe(true);
    });

    it.each([Error, TypeError])("marks a status-less %s for retry", (ErrorClass) => {
        const failure = new ErrorClass("Network unavailable");
        expect(markTransient(failure)).toBe(failure);
        expect(isTransient(failure)).toBe(true);
    });

    it("keeps AbortError unchanged and unmarked", () => {
        const failure = new DOMException("Render cancelled", "AbortError");
        expect(markTransient(failure)).toBe(failure);
        expect(isTransient(failure)).toBe(false);
    });
});
