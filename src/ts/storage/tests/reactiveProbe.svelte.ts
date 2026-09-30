import { flushSync } from "svelte";

// Test-only helpers for the forwarding-layer tests (Phase 3, slice 5): a `$derived` and an `$effect`
// over a read, and an `$effect` around a write, so the tests can tell a tracked read from an
// untracked write without a component.

export interface Probe<T> {
    /** Every value the effect saw, in order. */
    seen: T[];
    /** The same read as a `$derived` (a tracked read inside a derived computation). */
    derived: () => T;
    dispose: () => void;
}

export function createProbe<T>(read: () => T): Probe<T> {
    const seen: T[] = [];
    let derivedValue: () => T = read;
    const dispose = $effect.root(() => {
        const value = $derived.by(read);
        derivedValue = () => value;
        $effect(() => {
            seen.push(read());
        });
    });
    flushSync();
    return { seen, derived: () => derivedValue(), dispose };
}

export interface WriterEffect {
    /** How many times the effect has run. */
    runs: () => number;
    dispose: () => void;
}

/** Runs `write` inside an `$effect`; a write that tracks nothing runs once and never again. */
export function createWriterEffect(write: () => void): WriterEffect {
    let runs = 0;
    const dispose = $effect.root(() => {
        $effect(() => {
            runs += 1;
            write();
        });
    });
    flushSync();
    return { runs: () => runs, dispose };
}
