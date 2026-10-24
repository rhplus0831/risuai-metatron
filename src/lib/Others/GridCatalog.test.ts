// @vitest-environment happy-dom

import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import { language } from "src/lang";

vi.mock("src/ts/characters", () => ({
    getCharImage: vi.fn(async () => ""),
    changeChar: vi.fn(),
    addCharacter: vi.fn(),
    removeChar: vi.fn(),
    restoreChar: vi.fn(),
}));
vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());
vi.mock("src/ts/stores.svelte", async () =>
    (await import("src/ts/tests/storesMock")).createStoresMock({
        popupStore: { children: null, mouseX: 0, mouseY: 0, openId: 0 },
    }),
);

import { getCharImage } from "src/ts/characters";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import GridCatalog from "./GridCatalog.svelte";

const originalObserver = globalThis.IntersectionObserver;
let instance: ReturnType<typeof mount> | undefined;
let target: HTMLElement;

afterEach(async () => {
    if (instance) await unmount(instance);
    target?.remove();
    globalThis.IntersectionObserver = originalObserver;
});

it("requests the 256 thumbnail class for a catalog grid icon", () => {
    const character = { chaId: "alice", type: "character", name: "Alice", image: "assets/alice.png" };
    installFlatDatabase({ characters: [character] });
    globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
    target = document.createElement("div");
    document.body.appendChild(target);
    instance = mount(GridCatalog, { target });
    flushSync();

    const grid = [...target.querySelectorAll("button")].find((button) => button.textContent?.trim() === language.grid)!;
    vi.mocked(getCharImage).mockClear();
    grid.click();
    flushSync();

    expect(getCharImage).toHaveBeenCalledWith(character.image, "css", 256);
});
