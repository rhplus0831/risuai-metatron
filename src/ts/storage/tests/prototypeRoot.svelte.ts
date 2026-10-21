// Test-only: the `$state` holder the two prototype binding suites (`forwardingBindings.test.ts`,
// `projectionBindings.test.ts`) mount their prototype root on. It stands where the removed
// whole-database aggregate (`stores.svelte.ts`) stood for them: an object assigned to `db` is
// proxied by Svelte, so a prototype installed on a raw object before the assignment is reached
// through the proxy, as the aggregate's facade was. Nothing in production reads it.
export const prototypeRoot = $state({ db: {} as any });
