/**
 * The checks and errors the mutation modules (`characterStore`, `collectionStore`,
 * `pluginStorageStore`) share. A mutation validates its whole input before the mirror changes; a
 * refusal throws and leaves everything as it was.
 */

/** A mutation's input was refused (a malformed value, a forbidden key); nothing was changed. */
export class MutationValidationError extends Error {
    readonly key: string;

    constructor(key: string, message: string) {
        super(`${key}: ${message}`);
        this.name = "MutationValidationError";
        this.key = key;
    }
}

/** The record a mutation addresses by id does not exist (deleted meanwhile); nothing was changed. */
export class MutationTargetGoneError extends Error {
    readonly target: string;

    constructor(target: string) {
        super(`${target} no longer exists`);
        this.name = "MutationTargetGoneError";
        this.target = target;
    }
}

const MAX_JSON_DEPTH = 256;

/**
 * Whether `value` is data the resources can hold: `null`, a boolean, a finite number, a string, or
 * plain arrays and objects of those (no class instances, functions, symbols, `BigInt`, or cycles).
 * `undefined` is accepted inside objects and arrays, where JSON drops it (or writes `null`), as the
 * save adapter's projection always did; `allowUndefined` decides it at the top level.
 */
export function isJsonData(value: unknown, allowUndefined = false, depth = 0, seen = new Set<object>()): boolean {
    if (value === undefined) {
        return allowUndefined;
    }
    if (value === null || typeof value === "boolean" || typeof value === "string") {
        return true;
    }
    if (typeof value === "number") {
        return Number.isFinite(value);
    }
    if (typeof value !== "object" || depth >= MAX_JSON_DEPTH || seen.has(value)) {
        return false;
    }
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return value.every((item) => isJsonData(item, true, depth + 1, seen));
        }
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) {
            return false;
        }
        return Object.values(value).every((item) => isJsonData(item, true, depth + 1, seen));
    } finally {
        seen.delete(value);
    }
}

/** Throws unless `value` is `isJsonData`. */
export function requireJsonData(key: string, value: unknown, allowUndefined = false) {
    if (!isJsonData(value, allowUndefined)) {
        throw new MutationValidationError(
            key,
            `the value is not JSON data (a function, BigInt, non-finite number, cycle, class instance, or nesting deeper than ${MAX_JSON_DEPTH} levels)`,
        );
    }
}

/** Throws unless `value` is a plain object. */
export function requireObject(key: string, value: unknown): asserts value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new MutationValidationError(key, "expected an object");
    }
}

/** Throws unless `value` is an array. */
export function requireArray(key: string, value: unknown): asserts value is unknown[] {
    if (!Array.isArray(value)) {
        throw new MutationValidationError(key, "expected a list");
    }
}

/**
 * A detached plain copy of validated JSON data (the caller keeps no alias into the mirror, and the
 * mirror none into the caller's object). An own `__proto__` key survives: `JSON.parse` defines it.
 */
export function detach<T>(value: T): T {
    return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Checks and detaches every entry of a field patch before anything is written, so the commit loop
 * that follows cannot fail halfway. `checkField` may refuse a field name; each value must be JSON
 * data or `undefined` (which removes the field). `__proto__` is refused: assigning it would change
 * the record's prototype.
 */
export function detachPatch(
    patch: unknown,
    checkField: (field: string, value: unknown) => void = () => {},
): [string, unknown][] {
    requireObject("patch", patch);
    const entries = Object.entries(patch);
    for (const [field, value] of entries) {
        if (field === "__proto__") {
            throw new MutationValidationError(field, "not a valid field name");
        }
        checkField(field, value);
        requireJsonData(field, value, true);
    }
    return entries.map(([field, value]) => [field, detach(value)]);
}

/**
 * Whether assigning `key` on `target` would not create an own property: `__proto__` (it changes the
 * prototype) and any key `target` only inherits (`constructor`, `toString`, `hasOwnProperty`, ...),
 * which Svelte's `$state` proxy accepts without storing.
 */
function assignsInherited(target: object, key: string): boolean {
    return key === "__proto__" || (!Object.hasOwn(target, key) && key in target);
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown) {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Writes `entries` onto a mirror object (`undefined` removes a key). When every key can be assigned
 * in place, it is, and `null` is returned. When one cannot (`assignsInherited`), nothing is assigned
 * in place: the returned object holds `target`'s own entries with `entries` applied, as own
 * properties, and the caller installs it where `target` was (a Svelte proxy stores an own
 * inherited-name key only on an object it is given whole).
 */
export function writeEntries(
    target: Record<string, unknown>,
    entries: readonly (readonly [string, unknown])[],
): Record<string, unknown> | null {
    if (!entries.some(([key]) => assignsInherited(target, key))) {
        for (const [key, value] of entries) {
            if (value === undefined) {
                delete target[key];
            } else {
                target[key] = value;
            }
        }
        return null;
    }
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(target)) {
        defineOwn(next, key, value);
    }
    for (const [key, value] of entries) {
        if (value === undefined) {
            delete next[key];
        } else {
            defineOwn(next, key, value);
        }
    }
    return next;
}
