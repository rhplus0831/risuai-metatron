import { afterEach, beforeEach, expect, it, vi } from "vitest";

const key = "risu-module-folders-folded";
const deviceStorage = localStorage;
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
});

afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    vi.restoreAllMocks();
    localStorage.clear();
});

it("opens a folder by default without writing device storage", async () => {
    const { isFolderFolded } = await import("./itemFolderFold.svelte");

    expect(isFolderFolded("moduleFolders", "folder")).toBe(false);
    expect(localStorage.getItem(key)).toBeNull();
});

it("keeps fold and unfold changes in memory when the device refuses a storage write", async () => {
    const { isFolderFolded, setFolderFolded } = await import("./itemFolderFold.svelte");
    Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => deviceStorage.getItem(key),
            setItem: () => {
                throw new Error("Device storage unavailable");
            },
        },
    });

    setFolderFolded("moduleFolders", "folder", true, ["folder"]);
    expect(isFolderFolded("moduleFolders", "folder")).toBe(true);
    expect(localStorage.getItem(key)).toBeNull();

    setFolderFolded("moduleFolders", "folder", false, ["folder"]);
    expect(isFolderFolded("moduleFolders", "folder")).toBe(false);
});

it("prunes deleted folder ids on a write while preserving existing folded folders", async () => {
    localStorage.setItem(key, JSON.stringify(["deleted", "kept"]));
    const { isFolderFolded, setFolderFolded } = await import("./itemFolderFold.svelte");

    setFolderFolded("moduleFolders", "added", true, ["kept", "added"]);

    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(["kept", "added"]);
    expect(isFolderFolded("moduleFolders", "deleted")).toBe(false);
    expect(isFolderFolded("moduleFolders", "kept")).toBe(true);
    expect(isFolderFolded("moduleFolders", "added")).toBe(true);
});
