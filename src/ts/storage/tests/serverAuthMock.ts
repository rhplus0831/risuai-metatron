import { vi } from "vitest";

type ServerAuthModule = typeof import("../serverAuth");

/**
 * Every export of `src/ts/storage/serverAuth.ts` as a mock, for `vi.mock`: the authentication is
 * treated as done, the proxy token is a constant, and `authFetch` answers 404 unless a file passes
 * its own (a fake server's `fetch`, or a handler for the routes under test). The defaults `satisfies`
 * the module's type, so a new or reshaped export fails `pnpm check` here instead of a test at run time.
 *
 * ```ts
 * vi.mock("src/ts/storage/serverAuth", async () =>
 *     (await import("src/ts/storage/tests/serverAuthMock")).createServerAuthMock({ authFetch: mocks.authFetch }),
 * );
 * ```
 */
export function createServerAuthMock(overrides: Partial<ServerAuthModule> = {}): ServerAuthModule {
    const defaults = {
        ensureAuth: vi.fn(async () => {}),
        getNodeServerProxyAuth: vi.fn(async () => "signed-token"),
        authFetch: vi.fn(async (_input: string, _init?: RequestInit, _options?: { beforeDispatch?: () => void }) =>
            Response.json({ error: "Not found" }, { status: 404 }),
        ),
    } satisfies ServerAuthModule;
    return { ...defaults, ...overrides };
}
