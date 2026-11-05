import { vi } from "vitest";
import { BOOT_RESOURCE_FORMAT } from "../../../../shared/resources.ts";
import type { ModuleMockOverrides } from "../../tests/mockOverrides";

type ResourceClientModule = typeof import("../resourceClient");

/**
 * Every export of `src/ts/storage/resourceClient.ts` as a mock, for `vi.mock`. The error classes and
 * `UNLOAD_BODY_LIMIT` are the real ones, so a test imports the classes it throws from the module
 * and `instanceof` holds. The callable exports are `vi.fn()`s that answer as an empty server does: a
 * read finds nothing, a write succeeds, and no epoch is loaded. `epochMismatch` builds the real
 * error. The defaults `satisfies` the module's type, so a new or reshaped export of `resourceClient.ts`
 * fails `pnpm check` here instead of failing a test that reaches it under load. Loading the real
 * classes reaches `serverAuth` and what it imports, so a test whose narrow mocks cannot carry that
 * graph mocks `serverAuth` too.
 *
 * Load it inside the hoisted factory, and pass a file's own handles as `overrides`:
 *
 * ```ts
 * vi.mock("src/ts/storage/resourceClient", async () =>
 *     (await import("src/ts/storage/tests/resourceClientMock")).createResourceClientMock({
 *         readRefs: mocks.readRefs,
 *     }),
 * );
 * ```
 */
export async function createResourceClientMock(
    overrides: ModuleMockOverrides<ResourceClientModule> = {},
): Promise<ResourceClientModule> {
    const { ResourceConflictError, ResourceEpochMismatchError, ResourceRequestError, UNLOAD_BODY_LIMIT } =
        await vi.importActual<ResourceClientModule>("src/ts/storage/resourceClient");
    const defaults = {
        ResourceConflictError,
        ResourceEpochMismatchError,
        ResourceRequestError,
        UNLOAD_BODY_LIMIT,
        setMutationAdmission: vi.fn<ResourceClientModule["setMutationAdmission"]>(),
        setResourceEpoch: vi.fn<ResourceClientModule["setResourceEpoch"]>(),
        getResourceEpoch: vi.fn(() => ""),
        setEpochMismatchListener: vi.fn<ResourceClientModule["setEpochMismatchListener"]>(),
        epochMismatch: vi.fn((epoch: string) => new ResourceEpochMismatchError(epoch)),
        readKinds: vi.fn(async () => ({ epoch: "", kinds: {} })),
        readBoot: vi.fn<ResourceClientModule["readBoot"]>(async () => ({
            format: BOOT_RESOURCE_FORMAT,
            epoch: "",
            kinds: {},
        })),
        readRefs: vi.fn(async () => ({ epoch: "", items: [] })),
        listRevisions: vi.fn(async () => ({ epoch: "", resources: [], chats: [], chatOrders: [] })),
        listChanges: vi.fn<ResourceClientModule["listChanges"]>(async () => ({ epoch: "", cursor: 0, expired: true })),
        getResource: vi.fn(async () => null),
        // A `Mock` drops the call's type parameter, hence the cast.
        putResource: vi.fn(async (_kind: string, _id: string, data: unknown) => ({
            revision: "",
            data,
        })) as unknown as ResourceClientModule["putResource"],
        deleteResource: vi.fn(async () => {}),
        sendSecretRequest: vi.fn(async () => ({ revision: "", data: null })),
        applyBatchText: vi.fn(async () => ({ epoch: "", results: [] })),
        prepareUnloadAuth: vi.fn(),
        sendBatchOnUnload: vi.fn(() => false),
        listBackups: vi.fn(async () => []),
        takeSnapshot: vi.fn<ResourceClientModule["takeSnapshot"]>(async (label) => ({
            id: "",
            createdAt: "",
            size: 0,
            pinned: false,
            label: label ?? null,
        })),
        updateSnapshot: vi.fn<ResourceClientModule["updateSnapshot"]>(async (id, update) => ({
            id,
            createdAt: "",
            size: 0,
            pinned: update.pinned ?? false,
            label: update.label ?? null,
        })),
        deleteSnapshot: vi.fn<ResourceClientModule["deleteSnapshot"]>(async () => ({ deleted: true })),
        restoreBackup: vi.fn(async () => ""),
        exportBackup: vi.fn(async () => new Response()),
        importBackup: vi.fn(async () => ({ epoch: "", assetsWritten: 0, assetsSkipped: 0 })),
    } satisfies ResourceClientModule;
    return { ...defaults, ...overrides } as ResourceClientModule;
}
