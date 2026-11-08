import { vi } from "vitest";
import type { ModuleMockOverrides } from "./mockOverrides";

type GlobalApiModule = typeof import("../globalApi.svelte");

/** A writer whose steps succeed and go nowhere, for the exports that write a file. */
class MockWriter {
    writer = { abort: vi.fn(async () => {}) };
    init = vi.fn(async () => true);
    write = vi.fn(async () => {});
    close = vi.fn(async () => {});
    abort = vi.fn(async () => {});
}

/**
 * Every export of `src/ts/globalApi.svelte.ts` as a mock, for `vi.mock`. The callable exports are
 * `vi.fn()`s that touch nothing: an asset path is its own source, a fetch gets no answer, an asset
 * reads empty, and no law applies. The classes are stand-ins: the real module cannot be loaded
 * beside a mock of it without its effects, so a test that reads a writer's output or a buffer passes
 * its own. The defaults `satisfies` the module's type, so a new or reshaped export of
 * `globalApi.svelte.ts` fails `pnpm check` here instead of failing a test that reaches it under load.
 *
 * Load it inside the hoisted factory, and pass a file's own handles as `overrides`:
 *
 * ```ts
 * vi.mock("src/ts/globalApi.svelte", async () =>
 *     (await import("src/ts/tests/globalApiMock")).createGlobalApiMock({ downloadFile: mocks.downloadFile }),
 * );
 * ```
 */
export function createGlobalApiMock(overrides: ModuleMockOverrides<GlobalApiModule> = {}): GlobalApiModule {
    const defaults = {
        downloadFile: vi.fn(async () => {}),
        getFileSrc: vi.fn(async (loc: string) => loc),
        holdFileSrc: vi.fn((loc: string) => ({ src: Promise.resolve(loc), release: vi.fn() })),
        getThumbSrc: vi.fn(async (loc: string) => loc),
        getDirectAssetSrc: vi.fn(() => null),
        fetchFileSrc: vi.fn(async () => new Response()),
        // A `Mock` drops the call's type parameter, hence the casts.
        withFileSrcFetch: vi.fn(async (run: () => unknown) => run()) as unknown as GlobalApiModule["withFileSrcFetch"],
        readImage: vi.fn(async () => new Uint8Array()),
        saveAsset: vi.fn(async () => ""),
        assetKey: vi.fn(async () => ""),
        saveAssetBatch: vi.fn(async () => {}),
        loadAsset: vi.fn(async () => new Uint8Array()),
        loadAssets: vi.fn(async () => []),
        saving: { state: false },
        setUsingSw: vi.fn(),
        setDirectAssets: vi.fn(),
        getFetchData: vi.fn(() => undefined),
        addFetchLog: vi.fn(() => 0),
        appendFetchLog: vi.fn(),
        globalFetch: vi.fn(async () => ({ ok: false, data: null, headers: {}, status: 0 })),
        getBasename: vi.fn((data: string) => data),
        checkCharOrder: vi.fn(),
        getFetchLogs: vi.fn(() => []),
        openURL: vi.fn(),
        fetchNative: vi.fn(async () => new Response()),
        toggleFullscreen: vi.fn(),
        trimNonLatin: vi.fn((data: string) => data),
        getLanguageCodes: vi.fn(() => []),
        getVersionString: vi.fn(() => ""),
        aiLawApplies: vi.fn(() => false),
        changeChatTo: vi.fn(),
        openPinnedChat: vi.fn(),
        createChatCopyName: vi.fn((name: string, type: string) => `${name} (${type})`),
        chatFoldedState: { data: null },
        chatFoldedStateMessageIndex: { index: -1 },
        foldChatToMessage: vi.fn(),
        LocalWriter: MockWriter as unknown as GlobalApiModule["LocalWriter"],
        VirtualWriter: MockWriter as unknown as GlobalApiModule["VirtualWriter"],
        BlankWriter: MockWriter as unknown as GlobalApiModule["BlankWriter"],
        AppendableBuffer: class {} as unknown as GlobalApiModule["AppendableBuffer"],
        PerformanceDebugger: class {} as unknown as GlobalApiModule["PerformanceDebugger"],
    } satisfies GlobalApiModule;
    return { ...defaults, ...overrides } as GlobalApiModule;
}
