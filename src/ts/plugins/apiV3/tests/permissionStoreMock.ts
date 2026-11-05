import { vi } from "vitest";

type PermissionStoreModule = typeof import("../permissionStore");

/**
 * Every export of `src/ts/plugins/apiV3/permissionStore.ts` as a mock, for `vi.mock`. By default no
 * grant is held, writes and reads resolve, and a removal listener is never called. The defaults
 * `satisfies` the module's type, so a new or reshaped export fails `pnpm check` here instead of
 * failing every suite that mocks the module.
 *
 * Load it inside the hoisted factory, and pass a file's own handles as `overrides`:
 *
 * ```ts
 * vi.mock("./permissionStore", async () =>
 *     (await import("./tests/permissionStoreMock")).createPermissionStoreMock({ hasPermissionGrant: () => true }),
 * );
 * ```
 */
export function createPermissionStoreMock(overrides: Partial<PermissionStoreModule> = {}): PermissionStoreModule {
    const defaults = {
        seedPluginPermissions: vi.fn<PermissionStoreModule["seedPluginPermissions"]>(),
        loadPluginPermissions: vi.fn<PermissionStoreModule["loadPluginPermissions"]>(async () => undefined),
        hasPermissionGrant: vi.fn<PermissionStoreModule["hasPermissionGrant"]>(() => false),
        getLastGrantTime: vi.fn<PermissionStoreModule["getLastGrantTime"]>(() => undefined),
        recordPermissionGrants: vi.fn<PermissionStoreModule["recordPermissionGrants"]>(async () => undefined),
        revokePermissionGrants: vi.fn<PermissionStoreModule["revokePermissionGrants"]>(async () => undefined),
        refreshPluginPermissions: vi.fn<PermissionStoreModule["refreshPluginPermissions"]>(async () => undefined),
        onPermissionGrantsRemoved: vi.fn<PermissionStoreModule["onPermissionGrantsRemoved"]>(() => () => {}),
    } satisfies PermissionStoreModule;
    return { ...defaults, ...overrides };
}
