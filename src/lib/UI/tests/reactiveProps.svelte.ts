// Test-only helper: reactive props for a component mounted from a `.test.ts` file (runes may appear
// only in `.svelte` and `.svelte.ts` files). `mount(Component, { props })` reads a `$state` object's
// properties reactively, so a test can change a prop after mounting.

export function reactiveProps<T extends Record<string, unknown>>(initial: T): T {
    const props = $state(initial);
    return props;
}
