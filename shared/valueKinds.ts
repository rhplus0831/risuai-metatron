/**
 * The JSON kind of a stored value, for the shape checks of the Phase 3 normalizers
 * (`normalizePreset` and the server section normalizers). A field declares one kind; a value of
 * another kind is replaced by the field's default.
 */
export type ValueKind = "boolean" | "number" | "string" | "object" | "array";

/** The kind of `value`, or null for `null`, `undefined`, and anything JSON cannot hold. */
export function valueKindOf(value: unknown): ValueKind | null {
    if (Array.isArray(value)) {
        return "array";
    }
    switch (typeof value) {
        case "boolean":
        case "string":
            return typeof value as "boolean" | "string";
        case "number":
            return Number.isFinite(value) ? "number" : null;
        case "object":
            return value === null ? null : "object";
        default:
            return null;
    }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
