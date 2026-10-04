import { flushSync } from "svelte";

// Test-only helper for `characterRecords.test.ts` (Phase 6 slice 5a): runs a function as the body of a
// `$derived` read once by an `$effect`, so a test can check what a state change made inside a derived
// computation does (Svelte refuses an unguarded `$state` write there with `state_unsafe_mutation`).

/** Evaluates `fn` inside a `$derived` (once) and returns its value, or throws what it threw. */
export function evaluateInDerived<T>(fn: () => T): T {
    let result: { value: T } | { error: unknown } | null = null;
    const dispose = $effect.root(() => {
        const value = $derived.by(fn);
        $effect(() => {
            try {
                result = { value };
            } catch (error) {
                result = { error };
            }
        });
    });
    try {
        flushSync();
    } finally {
        dispose();
    }
    const outcome = result as { value: T } | { error: unknown } | null;
    if (outcome === null) {
        throw new Error("the derived was never read");
    }
    if ("error" in outcome) {
        throw outcome.error;
    }
    return outcome.value;
}
