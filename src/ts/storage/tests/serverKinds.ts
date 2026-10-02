import type { FakeResourceServer } from "./fakeResourceServer";

/**
 * The server's resource kinds (`server/src/data/kinds.ts`) for client tests, loaded at run time
 * through a computed specifier: the client `tsconfig.json` is not strict and must not type-check the
 * strict server sources, so a static import from a client test would fail `pnpm check` (see
 * `storeBackedServer.ts`). Typed here as far as the tests use them.
 */
export type ServerKind = {
    name: string;
    singleton?: boolean;
    materialize?: true;
    normalize(input: unknown, context: { id: string }): unknown;
    /** The write-only kinds' hooks (Phase 5 slice 7b): the masked read, the plain-write rule. */
    project?(data: unknown): unknown;
    prepareWrite?(incoming: unknown, stored: unknown | null): unknown;
};

const SERVER_DATA = "../../../../server/src/data/";

export async function loadServerKinds(): Promise<readonly ServerKind[]> {
    const { DEFAULT_RESOURCE_KINDS } = (await import(/* @vite-ignore */ `${SERVER_DATA}kinds.ts`)) as {
        DEFAULT_RESOURCE_KINDS: readonly ServerKind[];
    };
    return DEFAULT_RESOURCE_KINDS;
}

/** The server normalizer of one kind, for a test that checks what the server would store. */
export async function serverNormalizer(name: string): Promise<(input: unknown) => unknown> {
    const kind = (await loadServerKinds()).find((entry) => entry.name === name);
    if (!kind) {
        throw new Error(`No server resource kind ${name}`);
    }
    return (input) => kind.normalize(input, { id: "main" });
}

/**
 * Gives the fake the records the real server materializes when its store opens: every `materialize`
 * kind the fixture did not set, as `normalize(undefined)` builds it.
 */
export async function materialize(fake: FakeResourceServer) {
    for (const kind of await loadServerKinds()) {
        if (kind.materialize && !fake.get(kind.name, "main")) {
            fake.set(kind.name, "main", kind.normalize(undefined, { id: "main" }));
        }
    }
}
