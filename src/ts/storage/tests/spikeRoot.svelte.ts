// Test-only: the `$state` holder the two binding spikes (`forwardingSpike.test.ts`,
// `projectionSpike.test.ts`) mount their prototype root on. It stands where the removed
// removed aggregate (`stores.svelte.ts`, deleted in Phase 6 slice 10) stood for them: an object assigned
// to `db` is proxied by Svelte, so a prototype installed on a raw object before the assignment is
// reached through the proxy, as the pre-slice-10 facade was. Nothing in production reads it.
export const spikeRoot = $state({ db: {} as any });
