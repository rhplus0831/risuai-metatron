import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The client runs only when served by the self-host server, so AutoStorage always wraps
// NodeStorage: the browser-only localforage and OPFS backends were removed. These tests pin
// that contract: no leftover browser flag and no missing `__NODE__` selects another backend,
// the backend is created lazily and only once, and every call delegates to it (`setItem`
// resolves to void, with no replacement key).

// Hoisted so the mock factories can use them when the static import below evaluates.
const { createInstance, FakeNodeStorage } = vi.hoisted(() => {
    class FakeNodeStorage {
        static instances: FakeNodeStorage[] = [];
        setItem = vi.fn(async () => undefined);
        getItem = vi.fn(async () => Buffer.from([1, 2, 3]));
        keys = vi.fn(async () => ["database/database.bin", "assets/abc.png"]);
        removeItem = vi.fn(async () => undefined);

        constructor() {
            FakeNodeStorage.instances.push(this);
        }
    }
    return { createInstance: vi.fn(), FakeNodeStorage };
});

vi.mock("localforage", () => ({
    default: { createInstance },
}));

vi.mock("./nodeStorage", () => ({ NodeStorage: FakeNodeStorage }));

import { AutoStorage } from "./autoStorage";

describe("AutoStorage on the self-host server", () => {
    beforeEach(() => {
        FakeNodeStorage.instances.length = 0;
        createInstance.mockClear();
        localStorage.clear();
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("selects NodeStorage regardless of leftover browser flags or a missing __NODE__", async () => {
        // Flags that used to steer the removed browser backends (account sync, OPFS).
        localStorage.setItem("accountst", "able");
        localStorage.setItem("dosync", "sync");
        localStorage.setItem("opfs_flag!", "able");
        expect((globalThis as { __NODE__?: boolean }).__NODE__).toBeUndefined();

        const storage = new AutoStorage();
        await storage.Init();

        expect(storage.realStorage).toBeInstanceOf(FakeNodeStorage);
        expect(FakeNodeStorage.instances).toHaveLength(1);
        expect(createInstance).not.toHaveBeenCalled();
        expect((storage as unknown as { isAccount?: unknown }).isAccount).toBeUndefined();
    });

    it("creates the backend lazily and only once", async () => {
        const storage = new AutoStorage();
        expect(storage.realStorage).toBeUndefined();
        expect(FakeNodeStorage.instances).toHaveLength(0);

        await storage.keys();
        await storage.getItem("database/database.bin");
        await storage.Init();

        expect(FakeNodeStorage.instances).toHaveLength(1);
        expect(storage.realStorage).toBe(FakeNodeStorage.instances[0]);
    });

    it("delegates every call to NodeStorage and setItem resolves to void", async () => {
        const storage = new AutoStorage();
        const payload = new Uint8Array([1, 2, 3]);

        expect(await storage.setItem("assets/abc.png", payload)).toBeUndefined();
        expect(await storage.getItem("assets/abc.png")).toEqual(Buffer.from([1, 2, 3]));
        expect(await storage.keys()).toEqual(["database/database.bin", "assets/abc.png"]);
        expect(await storage.listItem()).toEqual(["database/database.bin", "assets/abc.png"]);
        expect(await storage.removeItem("assets/abc.png")).toBeUndefined();

        const backend = FakeNodeStorage.instances[0];
        expect(backend.setItem).toHaveBeenCalledWith("assets/abc.png", payload);
        expect(backend.getItem).toHaveBeenCalledWith("assets/abc.png");
        expect(backend.keys).toHaveBeenCalledTimes(2);
        expect(backend.removeItem).toHaveBeenCalledWith("assets/abc.png");
    });
});
