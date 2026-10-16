/** Scratch rows are shared by synchronous asset scans, growing only when a longer name needs them. */
let previous = new Int32Array(0);
let current = new Int32Array(0);
let legacyPrevious = new Int16Array(0);
let legacyCurrent = new Int16Array(0);

/**
 * The old full Int16 table can wrap negative above 32767 UTF-16 units. Preserve that recurrence
 * with two rows for those exceptional inputs: length pruning and row cutoffs are unsound there.
 */
function legacyDistance(a: string, b: string): number {
    const width = b.length + 1;
    if (legacyPrevious.length < width) {
        legacyPrevious = new Int16Array(width);
        legacyCurrent = new Int16Array(width);
    }
    let prev = legacyPrevious;
    let row = legacyCurrent;
    for (let j = 0; j < width; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        row[0] = i;
        for (let j = 1; j < width; j++) {
            row[j] = Math.min(prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1), prev[j] + 1, row[j - 1] + 1);
        }
        [prev, row] = [row, prev];
    }
    return prev[b.length];
}

/** Exact UTF-16 distance when <= cutoff, otherwise Infinity (including legacy overflow values). */
export function boundedDistance(a: string, b: string, cutoff: number): number {
    if (a.length > 32767 || b.length > 32767) {
        const distance = legacyDistance(a, b);
        return distance <= Math.floor(cutoff) ? distance : Infinity;
    }
    cutoff = Math.min(Math.floor(cutoff), Math.max(a.length, b.length));
    if (cutoff < 0 || Math.abs(a.length - b.length) > cutoff) return Infinity;
    if (a.length < b.length) [a, b] = [b, a];
    const width = b.length + 1;
    if (width === 1) return a.length;
    if (previous.length < width) {
        previous = new Int32Array(width);
        current = new Int32Array(width);
    }
    let prev = previous;
    let row = current;
    const outside = cutoff + 1;
    prev.fill(outside, 0, width);
    for (let j = 0; j <= Math.min(b.length, cutoff); j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        const start = Math.max(1, i - cutoff);
        const end = Math.min(b.length, i + cutoff);
        row[0] = i <= cutoff ? i : outside;
        if (start > 1) row[start - 1] = outside;
        let minimum = row[0];
        for (let j = start; j <= end; j++) {
            row[j] = Math.min(prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1), prev[j] + 1, row[j - 1] + 1);
            minimum = Math.min(minimum, row[j]);
        }
        if (minimum > cutoff) return Infinity;
        if (end < b.length) row[end + 1] = outside;
        [prev, row] = [row, prev];
    }
    return prev[b.length] <= cutoff ? prev[b.length] : Infinity;
}

/** checkImg's prefix scan: first strict improvement below 1000, including an empty-path winner. */
export function findAssetPrefix(name: string, assets: readonly { name: string; path: string }[]): string {
    const prefixLoc = name.lastIndexOf(".");
    const prefix = prefixLoc > 0 ? name.substring(0, prefixLoc) : "";
    let currentDistance = 1000;
    let currentFound = "";
    for (const asset of assets) {
        if (!asset.name.startsWith(prefix)) continue;
        const distance = boundedDistance(name, asset.name, currentDistance - 1);
        if (distance < currentDistance) {
            currentDistance = distance;
            currentFound = asset.path;
        }
    }
    return currentFound;
}
