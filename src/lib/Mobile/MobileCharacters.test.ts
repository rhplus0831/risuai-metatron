// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The character catalog's default list view: with many characters, only the rows near the viewport call
// `getCharImage`; an off-screen row keeps its placeholder icon and makes no request. The wrapper itself:
// `src/lib/UI/GUI/LazyCharImage.test.ts`.

const getCharImage = vi.fn(
    async (path: string, _type: string, _thumb?: 256 | 512) => `background: url("/img/${path}");`,
);
const changeChar = vi.fn();
const characters = Array.from({ length: 50 }, (_, i) => ({
    name: `Char ${String(i).padStart(2, "0")}`,
    chaId: `cha-${i}`,
    image: `assets/${i}.png`,
    lastInteraction: 1000 - i,
}));
vi.mock("src/ts/characters", () => ({
    getCharImage: (path: string, type: string, thumb?: 256 | 512) => getCharImage(path, type, thumb),
    changeChar: (chaId: string) => changeChar(chaId),
    addCharacter: vi.fn(),
}));
vi.mock("src/ts/storage/characterStore.svelte", () => ({ characterList: () => characters }));
const activity = new Map<string, number>();
vi.mock("src/ts/storage/chatStore.svelte", async () =>
    (await import("src/ts/storage/tests/chatStoreMock")).createChatStoreMock({
        characterLastChattedAt: (chaId: string, fallback: number) => activity.get(chaId) ?? fallback,
    }),
);

import MobileCharacters from "./MobileCharacters.svelte";

/** A stand-in observer: `reportVisible(set)` reports the observed elements in `set` as intersecting. */
class FakeObserver {
    static live: FakeObserver[] = [];
    observed: Element[] = [];
    constructor(private callback: IntersectionObserverCallback) {
        FakeObserver.live.push(this);
    }
    observe(element: Element) {
        this.observed.push(element);
    }
    disconnect() {
        FakeObserver.live = FakeObserver.live.filter((observer) => observer !== this);
    }
    static reportVisible(visible: Set<Element>) {
        for (const observer of [...FakeObserver.live]) {
            const entries = observer.observed.map((target) => ({ target, isIntersecting: visible.has(target) }));
            observer.callback(entries as unknown as IntersectionObserverEntry[], observer as never);
        }
        flushSync();
    }
}

let target: HTMLElement;
let instance: ReturnType<typeof mount> | null = null;
const originalObserver = globalThis.IntersectionObserver;

const settle = async () => {
    for (let i = 0; i < 3; i++) {
        await Promise.resolve();
        flushSync();
    }
};
/** The icon wrapper of each row, in list order. */
const wrappers = () => [...target.querySelectorAll(".shrink-0")];

beforeEach(() => {
    activity.clear();
    getCharImage.mockClear();
    changeChar.mockClear();
    FakeObserver.live = [];
    globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
    target = document.createElement("div");
    document.body.appendChild(target);
    instance = mount(MobileCharacters, { target, props: {} });
    flushSync();
});

afterEach(() => {
    if (instance) {
        unmount(instance);
        instance = null;
    }
    target.remove();
    globalThis.IntersectionObserver = originalObserver;
});

describe("MobileCharacters icons", () => {
    it("calls getCharImage for no row before any is seen", async () => {
        await settle();
        expect(wrappers()).toHaveLength(50);
        expect(FakeObserver.live).toHaveLength(50);
        expect(getCharImage).not.toHaveBeenCalled();
        expect(target.querySelectorAll(".ico[style]")).toHaveLength(0);
    });

    it("loads only the rows near the viewport; off-screen rows stay unrequested", async () => {
        const rows = wrappers();
        FakeObserver.reportVisible(new Set(rows.slice(0, 3)));
        await settle();
        expect(getCharImage.mock.calls).toEqual([
            ["assets/0.png", "css", 256],
            ["assets/1.png", "css", 256],
            ["assets/2.png", "css", 256],
        ]);
        expect(rows[0].querySelector(".ico")?.getAttribute("style")).toBe('background: url("/img/assets/0.png");');
        expect(rows[3].querySelector(".ico")?.hasAttribute("style")).toBe(false);
        expect(FakeObserver.live).toHaveLength(47);

        // Scrolling further reaches more rows; rows already loaded are not requested again.
        FakeObserver.reportVisible(new Set(rows.slice(0, 5)));
        await settle();
        expect(getCharImage.mock.calls.map(([path]) => path)).toEqual([
            "assets/0.png",
            "assets/1.png",
            "assets/2.png",
            "assets/3.png",
            "assets/4.png",
        ]);
    });

    it("keeps the row's click opening its character through the wrapper", async () => {
        FakeObserver.reportVisible(new Set(wrappers().slice(0, 1)));
        await settle();
        (target.querySelector("button") as HTMLButtonElement).click();
        expect(changeChar).toHaveBeenCalledWith("cha-0");
    });
});

it("omits the first visible row's top border under search and separates every later visible row", async () => {
    await unmount(instance!);
    instance = null;
    instance = mount(MobileCharacters, { target, props: { search: "Char 1" } });
    flushSync();

    const rows = [...target.querySelectorAll<HTMLButtonElement>("button.flex")];
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0].querySelector(".text-start > span")?.textContent).toBe("Char 10");
    expect(rows[0].classList.contains("border-t")).toBe(false);
    for (const row of rows.slice(1)) {
        expect(row.classList.contains("border-t")).toBe(true);
    }
});

it("orders mobile rows by derived chat activity instead of the stored legacy values", async () => {
    await unmount(instance!);
    instance = null;
    activity.set("cha-49", 3000);
    activity.set("cha-20", 2000);
    activity.set("cha-0", 0);
    instance = mount(MobileCharacters, { target, props: {} });
    flushSync();
    const rows = [...target.querySelectorAll<HTMLButtonElement>("button.flex")];
    expect(rows.slice(0, 3).map((row) => row.querySelector(".text-start > span")?.textContent)).toEqual([
        "Char 49",
        "Char 20",
        "Char 01",
    ]);
    expect(rows.at(-1)?.querySelector(".text-start > span")?.textContent).toBe("Char 00");
    rows[0].click();
    expect(changeChar).toHaveBeenCalledWith("cha-49");
});
