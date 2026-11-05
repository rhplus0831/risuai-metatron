import { ASSET_LEASE_MS } from "../../../shared/assetLifecycle.ts";

/**
 * Process-wide asset leases, keyed by resolveStorageKey's absolute path, and separate inlay-id claims.
 * Every multi-key holder acquires sorted paths; holders must never acquire another key or wait for
 * snapshots.exclusive.
 * Waiters are FIFO and abortable. Empty locks disappear as soon as their last holder leaves.
 * Inlay claims are synchronous: claim before reading or writing reused metadata; sweep checks the claim
 * in the same synchronous turn as deletion, without needing a key lock for the inlay id.
 *
 * Leases use performance.now() for BOTH insertion and expiry (fake timers can control performance).
 * Lifecycle wall/development clocks never expire this singleton's leases. A constant development
 * offset would cancel on both sides; restart loss is covered by the sweep's uptime gate.
 * Both maps expire after one hour. Eviction of an unexpired entry retains ALL files or inlay ids in
 * that map through its expiry, so saturation fails closed independently for assets and inlays.
 */
const locks = new Map<string, { waiters: { grant(): void }[] }>();
const leases = new Map<string, number>();
const inlayClaims = new Map<string, number>();
const MAX_LEASES = 100_000;
let saturatedUntil = 0;
let inlaySaturatedUntil = 0;

function acquire(fullPath: string, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    let lock = locks.get(fullPath);
    const occupied = lock !== undefined;
    if (!lock) {
        lock = { waiters: [] };
        locks.set(fullPath, lock);
    }
    const entry = lock;
    return new Promise((resolve, reject) => {
        const abort = () => {
            const index = entry.waiters.indexOf(waiter);
            if (index >= 0) entry.waiters.splice(index, 1);
            reject(signal!.reason);
        };
        const waiter = {
            grant() {
                signal?.removeEventListener("abort", abort);
                let released = false;
                resolve(() => {
                    if (released) return;
                    released = true;
                    const next = entry.waiters.shift();
                    if (next) next.grant();
                    else locks.delete(fullPath);
                });
            },
        };
        if (occupied) {
            entry.waiters.push(waiter);
            signal?.addEventListener("abort", abort, { once: true });
        } else {
            waiter.grant();
        }
    });
}

export async function withAssetLocks<T>(
    paths: readonly string[],
    body: () => T | Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    const releases: (() => void)[] = [];
    try {
        for (const fullPath of [...new Set(paths)].sort()) releases.push(await acquire(fullPath, signal));
        signal?.throwIfAborted();
        return await body();
    } finally {
        for (const release of releases.reverse()) release();
    }
}

/** Called under the key lock for claims; asset GET also records an advisory recent-use signal. */
export function bumpAssetLease(fullPath: string): void {
    const now = performance.now();
    for (const [key, expires] of leases) {
        if (expires > now) break;
        leases.delete(key);
    }
    leases.delete(fullPath);
    leases.set(fullPath, now + ASSET_LEASE_MS);
    if (leases.size > MAX_LEASES) {
        const [key, expires] = leases.entries().next().value!;
        saturatedUntil = Math.max(saturatedUntil, expires);
        leases.delete(key);
    }
}

export function assetLeased(fullPath: string): boolean {
    const now = performance.now();
    return now < saturatedUntil || now < (leases.get(fullPath) ?? 0);
}

/** Protect an inlay id before reading or writing metadata that will be handed out as a marker. */
export function claimInlayId(id: string): void {
    const now = performance.now();
    for (const [key, expires] of inlayClaims) {
        if (expires > now) break;
        inlayClaims.delete(key);
    }
    inlayClaims.delete(id);
    inlayClaims.set(id, now + ASSET_LEASE_MS);
    if (inlayClaims.size > MAX_LEASES) {
        const [key, expires] = inlayClaims.entries().next().value!;
        inlaySaturatedUntil = Math.max(inlaySaturatedUntil, expires);
        inlayClaims.delete(key);
    }
}

export function inlayClaimed(id: string): boolean {
    const now = performance.now();
    return now < inlaySaturatedUntil || now < (inlayClaims.get(id) ?? 0);
}
