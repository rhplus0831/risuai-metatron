// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { InlayResource } from "../../../shared/resources.ts";

type Inlays = typeof import("src/ts/process/files/inlays");
type Preview = Awaited<ReturnType<Inlays["getInlayAssetBlob"]>>;

const deps = vi.hoisted(() => ({
    listInlayAssets: vi.fn<Inlays["listInlayAssets"]>(),
    getInlayAssetBlob: vi.fn<Inlays["getInlayAssetBlob"]>(),
    removeInlayAsset: vi.fn<Inlays["removeInlayAsset"]>(),
    alertConfirm: vi.fn<typeof import("src/ts/alert").alertConfirm>(),
}));

vi.mock("src/ts/process/files/inlays", async () =>
    (await import("src/ts/tests/bootMocks")).createBootMock("inlays", {
        listInlayAssets: deps.listInlayAssets,
        getInlayAssetBlob: deps.getInlayAssetBlob,
        removeInlayAsset: deps.removeInlayAsset,
    }),
);
vi.mock("src/ts/alert", async () =>
    (await import("src/ts/tests/alertMock")).createAlertMock({ alertConfirm: deps.alertConfirm }),
);

import PlaygroundInlayExplorer from "./PlaygroundInlayExplorer.svelte";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

const id = "preview-inlay";
const metadata: InlayResource = { name: "Preview.png", type: "image", ext: "png" };
const loadedPreview: Preview = { ...metadata, data: new Blob(["image"], { type: "image/png" }) };
let target: HTMLElement;
let instance: ReturnType<typeof mount> | undefined;
let preview: ReturnType<typeof deferred<Preview>>;
let createObjectURL: MockInstance<typeof URL.createObjectURL>;
let revokeObjectURL: MockInstance<typeof URL.revokeObjectURL>;

beforeEach(() => {
    for (const dep of Object.values(deps)) dep.mockReset();
    preview = deferred<Preview>();
    deps.listInlayAssets.mockResolvedValue([[id, metadata]]);
    deps.getInlayAssetBlob.mockReturnValue(preview.promise);
    deps.alertConfirm.mockResolvedValue(true);
    deps.removeInlayAsset.mockResolvedValue(undefined);
    let nextURL = 0;
    createObjectURL = vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:preview-${++nextURL}`);
    revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    target = document.createElement("div");
    document.body.appendChild(target);
});

afterEach(async () => {
    if (instance) await destroyExplorer();
    target.remove();
    vi.restoreAllMocks();
});

async function openExplorer() {
    instance = mount(PlaygroundInlayExplorer, { target });
    await deps.listInlayAssets.mock.results[0].value;
    await tick();
    flushSync();
    expect(deps.getInlayAssetBlob).toHaveBeenCalledWith(id);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(target.querySelector("img")).toBeNull();
}

async function destroyExplorer() {
    await unmount(instance!);
    instance = undefined;
}

async function resolvePreview() {
    preview.resolve(loadedPreview);
    await preview.promise;
    await tick();
    flushSync();
}

function expectNoLeakedURLs() {
    expect(revokeObjectURL.mock.calls.map(([url]) => url)).toEqual(
        createObjectURL.mock.results.map(({ value }) => value),
    );
}

describe("inlay preview object URLs", () => {
    it("leaves no object URL when a pending preview resolves after destruction", async () => {
        await openExplorer();

        await destroyExplorer();
        await resolvePreview();

        expectNoLeakedURLs();
    });

    it("leaves no object URL when a pending preview resolves after confirmed deletion", async () => {
        const deletion = deferred<void>();
        deps.removeInlayAsset.mockReturnValue(deletion.promise);
        await openExplorer();

        const deleteButton = [...target.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "Delete",
        );
        expect(deleteButton).toBeDefined();
        deleteButton!.click();
        await deps.alertConfirm.mock.results[0].value;
        await tick();
        expect(deps.removeInlayAsset).toHaveBeenCalledExactlyOnceWith(id);
        deletion.resolve();
        await deletion.promise;
        await tick();
        flushSync();
        expect(target.textContent).not.toContain(metadata.name);

        await resolvePreview();

        expect(target.querySelector("img")).toBeNull();
        expectNoLeakedURLs();
    });

    it("shows a loaded preview and revokes its object URL on destruction", async () => {
        await openExplorer();
        await resolvePreview();

        const image = target.querySelector("img");
        expect(image?.alt).toBe(metadata.name);
        expect(image?.getAttribute("src")).toBe("blob:preview-1");
        expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(loadedPreview.data);
        expect(revokeObjectURL).not.toHaveBeenCalled();

        await destroyExplorer();

        expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:preview-1");
    });
});
