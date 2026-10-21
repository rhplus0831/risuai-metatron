import type { Database } from "../../../../shared/database.ts";
import { plainClone } from "../../../../shared/presets.ts";
import { SECTION_FIELDS, type SectionKind } from "../../../../shared/sections.ts";
import { isPlainObject, type ValueKind, valueKindOf } from "../../../../shared/valueKinds.ts";
import { ResourceValidationError } from "../resourceStore.ts";

export { isPlainObject, plainClone };

export function requireObject(value: unknown, what: string): Record<string, unknown> {
    if (!isPlainObject(value)) {
        throw new ResourceValidationError(`${what} must be an object`);
    }
    return value;
}

export function requireArrayOfObjects(value: unknown, what: string): Record<string, unknown>[] {
    if (!Array.isArray(value) || !value.every(isPlainObject)) {
        throw new ResourceValidationError(`${what} must be an array of objects`);
    }
    return value;
}

type SectionField<K extends SectionKind> = (typeof SECTION_FIELDS)[K][number];

/**
 * One field of a section: the JSON kind its value must have and its fresh-boot default, recorded in
 * `src/ts/storage/tests/fixtures/boot/boot-snapshot.json`. A deliberate default change updates
 * the spec and that maintained fixture together. A field a fresh boot leaves unset has no default
 * and stays absent.
 */
export type FieldSpec<T> = readonly [kind: ValueKind, fallback?: T];

/** The spec of every field of a section; the type makes a missing or an extra field an error. */
export type SectionSpec<K extends SectionKind> = { readonly [F in SectionField<K>]: FieldSpec<Database[F]> };

/**
 * A new section record from `input`: every field of `SECTION_FIELDS[section]` in that order, with
 * its value when the value has the field's kind and its default otherwise (a missing, `null`, or
 * wrong-kind value), and no other key. `undefined` (a record being materialized) yields the
 * defaults; any other non-object is rejected. The input is not mutated.
 */
export function normalizeSection<K extends SectionKind>(
    section: K,
    spec: SectionSpec<K>,
    input: unknown,
): Record<string, unknown> {
    const source = input === undefined ? {} : requireObject(input, section);
    const record: Record<string, unknown> = {};
    for (const field of SECTION_FIELDS[section] as readonly SectionField<K>[]) {
        const [kind, fallback] = spec[field];
        const value = source[field];
        if (valueKindOf(value) === kind) {
            record[field] = plainClone(value);
        } else if (fallback !== undefined) {
            record[field] = plainClone(fallback);
        }
    }
    return record;
}
