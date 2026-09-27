import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Risu Account sync was removed. These tests pin the backend selection that
// remains: a leftover `accountst` flag from a former sync user must be ignored
// (local storage wins), Node still picks NodeStorage, and `setItem` no longer
// yields a replacement key.

type FakeForage = {
    name: string;
    setItem: ReturnType<typeof vi.fn>;
    getItem: ReturnType<typeof vi.fn>;
    keys: ReturnType<typeof vi.fn>;
    removeItem: ReturnType<typeof vi.fn>;
};

const createdInstances: FakeForage[] = [];

vi.mock("localforage", () => ({
    default: {
        createInstance: vi.fn((opts: { name: string }) => {
            const instance: FakeForage = {
                name: opts.name,
                setItem: vi.fn(async () => "replacement-key-that-must-be-ignored"),
                getItem: vi.fn(async () => null),
                keys: vi.fn(async () => []),
                removeItem: vi.fn(async () => undefined),
            };
            createdInstances.push(instance);
            return instance;
        }),
    },
}));

vi.mock("../alert", () => ({
    alertStore: { set: vi.fn() },
}));

class FakeNodeStorage {
    setItem = vi.fn(async () => undefined);
    getItem = vi.fn(async () => null);
    keys = vi.fn(async () => []);
    removeItem = vi.fn(async () => undefined);
}

class FakeOpfsStorage {
    setItem = vi.fn(async () => undefined);
    getItem = vi.fn(async () => null);
    keys = vi.fn(async () => []);
    removeItem = vi.fn(async () => undefined);
}

vi.mock("./nodeStorage", () => ({ NodeStorage: FakeNodeStorage }));
vi.mock("./opfsStorage", () => ({ OpfsStorage: FakeOpfsStorage }));

async function loadAutoStorage(nodeServer: boolean) {
    vi.resetModules();
    vi.doMock("src/ts/platform", () => ({ isNodeServer: nodeServer }));
    const mod = await import("./autoStorage");
    return new mod.AutoStorage();
}

describe("AutoStorage backend selection after account sync removal", () => {
    beforeEach(() => {
        createdInstances.length = 0;
        localStorage.clear();
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.doUnmock("src/ts/platform");
    });

    it('ignores a leftover accountst flag and falls through to localforage "risuai"', async () => {
        localStorage.setItem("accountst", "able");
        localStorage.setItem("dosync", "sync");

        const storage = await loadAutoStorage(false);
        await storage.Init();

        expect(createdInstances).toHaveLength(1);
        expect(createdInstances[0].name).toBe("risuai");
        expect(storage.realStorage).toBe(createdInstances[0]);
        expect(storage.realStorage).not.toBeInstanceOf(FakeNodeStorage);
        expect(storage.realStorage).not.toBeInstanceOf(FakeOpfsStorage);
        expect((storage as unknown as { isAccount?: unknown }).isAccount).toBeUndefined();
    });

    it("setItem delegates to the backend and resolves to void (no replacement key)", async () => {
        const storage = await loadAutoStorage(false);
        const payload = new Uint8Array([1, 2, 3]);

        const result = await storage.setItem("assets/abc.png", payload);

        expect(result).toBeUndefined();
        expect(createdInstances[0].setItem).toHaveBeenCalledWith("assets/abc.png", payload);
    });

    it("still selects NodeStorage on the Node server even with a leftover accountst flag", async () => {
        localStorage.setItem("accountst", "able");

        const storage = await loadAutoStorage(true);
        await storage.Init();

        expect(storage.realStorage).toBeInstanceOf(FakeNodeStorage);
        expect(createdInstances).toHaveLength(0);
    });
});
