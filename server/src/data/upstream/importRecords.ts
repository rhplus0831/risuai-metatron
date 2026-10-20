import { plainClone } from "../../../../shared/presets.ts";
import { type ResourceKindName, SINGLETON_RESOURCE_ID } from "../../../../shared/resources.ts";
import {
    addUpstreamReportEntry,
    type UpstreamConvertedCode,
    type UpstreamExcludedCode,
    type UpstreamImportReport,
} from "../../../../shared/upstreamBackup.ts";
import { DEFAULT_RESOURCE_KINDS, type ResourceKind } from "../kinds.ts";
import { ResourceValidationError, serialize } from "../resourceStore.ts";

/**
 * The record helpers the upstream converter's steps share (`importDatabase.ts`, `importCharacters.ts`,
 * `importCollections.ts`): each kind's own normalizer on the stored form of a value, checked with the
 * store's `serialize`, so what the converter emits is what a staged store keeps.
 */

export const kinds = new Map<string, ResourceKind>(DEFAULT_RESOURCE_KINDS.map((kind) => [kind.name, kind]));

export function kindOf(name: ResourceKindName): ResourceKind {
    return kinds.get(name)!;
}

/** What the store keeps for `input` written to `kind` as record `id`: its normalizer on the stored form, checked. */
export function storeNormalize(kind: ResourceKind, input: unknown, id: string = SINGLETON_RESOURCE_ID): unknown {
    const data = kind.normalize(input === undefined ? undefined : serialize(input).stored, { id });
    serialize(data);
    return data;
}

/**
 * `kind`'s record for `input`; failing that, for its JSON copy (a non-finite number becomes `null`,
 * which the normalizers replace with the field default; `copied` says so). A `ResourceValidationError`
 * is a refusal; any other error is rethrown.
 */
export function tryNormalize(
    kind: ResourceKind,
    input: unknown,
    id: string = SINGLETON_RESOURCE_ID,
): { ok: true; data: unknown; copied: boolean } | { ok: false } {
    try {
        return { ok: true, data: storeNormalize(kind, input, id), copied: false };
    } catch (error) {
        if (!(error instanceof ResourceValidationError)) {
            throw error;
        }
    }
    let copy: unknown;
    try {
        copy = plainClone(input);
    } catch {
        return { ok: false };
    }
    try {
        return { ok: true, data: storeNormalize(kind, copy, id), copied: true };
    } catch (error) {
        if (!(error instanceof ResourceValidationError)) {
            throw error;
        }
        return { ok: false };
    }
}

/**
 * `kind`'s record for `input`, as `tryNormalize` makes it; failing that, the kind's fresh-boot value,
 * reported under `label` (default: the kind name). Only for kinds that materialize (`normalize(undefined)`).
 */
export function normalizeRecord(
    kindName: ResourceKindName,
    input: unknown,
    invalid: (path: string) => void,
    label: string = kindName,
): unknown {
    const kind = kindOf(kindName);
    const repaired = tryNormalize(kind, input);
    if (repaired.ok) {
        return repaired.data;
    }
    invalid(label);
    return storeNormalize(kind, undefined);
}

/** The stored (JSON round trip) form of a small source object, a non-finite number becoming `null`. */
export function storedForm(value: Record<string, unknown>): Record<string, unknown> {
    try {
        return serialize(value).stored as Record<string, unknown>;
    } catch (error) {
        if (!(error instanceof ResourceValidationError)) {
            throw error;
        }
        return serialize(plainClone(value)).stored as Record<string, unknown>;
    }
}

/**
 * The stored form of `value` (`serialize`), else of its JSON copy (`copied`), else nothing: a value
 * the store cannot hold at all (a cycle, nesting past its depth limit, a bigint).
 */
export function storedValue(value: unknown): { ok: true; value: unknown; copied: boolean } | { ok: false } {
    try {
        return { ok: true, value: serialize(value).stored, copied: false };
    } catch (error) {
        if (!(error instanceof ResourceValidationError)) {
            throw error;
        }
    }
    let copy: unknown;
    try {
        copy = plainClone(value);
    } catch {
        return { ok: false };
    }
    try {
        return { ok: true, value: serialize(copy).stored, copied: true };
    } catch (error) {
        if (!(error instanceof ResourceValidationError)) {
            throw error;
        }
        return { ok: false };
    }
}

/** A shallow copy that keeps every own enumerable key (an own `__proto__` stays a key). */
export function ownCopy(value: Record<string, unknown>): Record<string, unknown> {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
        setOwn(copy, key, value[key]);
    }
    return copy;
}

/** Sets an own key, also one that assignment would not store (`__proto__`). */
export function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Report entries held back until the record they describe is known to be kept: a restored cold
 * character whose conversion then fails must not be reported restored.
 */
export class PendingReport {
    private readonly entries: (
        | { list: "converted"; code: UpstreamConvertedCode; example?: string }
        | { list: "excluded"; code: UpstreamExcludedCode; example?: string }
    )[] = [];

    converted(code: UpstreamConvertedCode, example?: string): void {
        this.entries.push({ list: "converted", code, example });
    }

    excluded(code: UpstreamExcludedCode, example?: string): void {
        this.entries.push({ list: "excluded", code, example });
    }

    /** Moves `other`'s entries behind this one's. */
    take(other: PendingReport): void {
        for (const entry of other.entries) {
            this.entries.push(entry);
        }
        other.entries.length = 0;
    }

    flush(report: UpstreamImportReport): void {
        for (const entry of this.entries) {
            if (entry.list === "converted") {
                addUpstreamReportEntry(report.converted, entry.code, entry.example);
            } else {
                addUpstreamReportEntry(report.excluded, entry.code, entry.example);
            }
        }
        this.entries.length = 0;
    }
}
