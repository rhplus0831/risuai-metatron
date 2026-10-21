// Counts the byte work of code that searches and copies typed arrays (not a test file itself).

import { onTestFinished } from "vitest";

/**
 * What `run` did to typed arrays while it ran: `scanned` counts the bytes `Uint8Array.prototype.indexOf`
 * inspected (from the start index through the match, or to the end on a miss), `copied` the bytes
 * `Uint8Array.prototype.slice` and `.set` copied and the bytes `Buffer.concat` joined. A framer that
 * rescans or recopies what it already holds shows up as work far beyond its input. Buffer's own
 * `indexOf` and `slice` (a view) are not counted, so the input should be plain `Uint8Array`s. The
 * counters see every dynamic call to these methods in the realm during `run`, including inherited
 * `Buffer.set`, so `run` must be self-contained. The counters shadow the inherited methods on
 * `Uint8Array.prototype` and are removed when `run` settles or the test finishes. Synchronous
 * callbacks are restored without yielding to a microtask.
 */
export async function countByteWork<T>(
    run: () => T | Promise<T>,
): Promise<{ result: T; scanned: number; copied: number }> {
    const proto = Uint8Array.prototype;
    const { indexOf, slice, set } = proto;
    const shadowed = ["indexOf", "slice", "set"] as const;
    if (shadowed.some((name) => Object.hasOwn(proto, name))) {
        throw new Error("countByteWork: Uint8Array.prototype is already instrumented");
    }
    const concat = Buffer.concat;
    let scanned = 0;
    let copied = 0;
    proto.indexOf = function (this: Uint8Array, value: number, fromIndex?: number) {
        const found = indexOf.call(this, value, fromIndex);
        const from = fromIndex === undefined ? 0 : fromIndex < 0 ? Math.max(0, this.length + fromIndex) : fromIndex;
        scanned += Math.max(0, (found === -1 ? this.length : found + 1) - from);
        return found;
    };
    proto.slice = function (this: Uint8Array, start?: number, end?: number) {
        const result = slice.call(this, start, end);
        copied += result.length;
        return result;
    } as typeof proto.slice;
    proto.set = function (this: Uint8Array, source: ArrayLike<number>, offset?: number) {
        copied += source.length;
        return set.call(this, source, offset);
    };
    Buffer.concat = function (list: readonly Uint8Array[], totalLength?: number) {
        const result = concat.call(Buffer, list, totalLength);
        copied += result.length;
        return result;
    } as typeof Buffer.concat;
    const shadows = { indexOf: proto.indexOf, slice: proto.slice, set: proto.set };
    const concatWrapper = Buffer.concat;
    function restore() {
        for (const name of shadowed) {
            if (Object.getOwnPropertyDescriptor(proto, name)?.value === shadows[name]) {
                delete (proto as unknown as Record<string, unknown>)[name];
            }
        }
        if (Buffer.concat === concatWrapper) {
            Buffer.concat = concat;
        }
    }
    try {
        onTestFinished(restore);
        const outcome = run();
        const result = outcome instanceof Promise ? await outcome : outcome;
        return { result, scanned, copied };
    } finally {
        restore();
    }
}
