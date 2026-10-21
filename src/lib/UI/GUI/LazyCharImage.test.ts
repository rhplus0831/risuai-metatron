// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactiveProps } from "../tests/reactiveProps.svelte";

// The lazy character icon the long lists use: `getCharImage` runs only once the wrapper nears the
// viewport, for the path it was seen with; until then the icon is given a promise that never
// settles, so its `{#await}` (`LazyCharImageFixture.svelte`) stays on the loading placeholder. The
// list-level check over a real list: `src/lib/Mobile/MobileCharacters.test.ts`.

const getCharImage = vi.fn(async (path: string, type: string) => `${type}:${path}`);
vi.mock("src/ts/characters", () => ({ getCharImage: (path: string, type: string) => getCharImage(path, type) }));

import LazyCharImageFixture from "../tests/LazyCharImageFixture.svelte";

/** A stand-in observer the test drives: `report(visible)` reports each observed element's intersection. */
class FakeObserver {
    static live: FakeObserver[] = [];
    observed: Element[] = [];
    options: IntersectionObserverInit | undefined;
    constructor(
        private callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
    ) {
        this.options = options;
        FakeObserver.live.push(this);
    }
    observe(element: Element) {
        this.observed.push(element);
    }
    disconnect() {
        FakeObserver.live = FakeObserver.live.filter((observer) => observer !== this);
    }
    static report(isIntersecting: boolean) {
        for (const observer of [...FakeObserver.live]) {
            const entries = observer.observed.map((target) => ({ target, isIntersecting }));
            observer.callback(entries as unknown as IntersectionObserverEntry[], observer as never);
        }
        flushSync();
    }
}

let target: HTMLElement;
let instance: ReturnType<typeof mount> | null = null;
const originalObserver = globalThis.IntersectionObserver;

function render(path: string) {
    const props = reactiveProps({ path, type: "css" as const, class: "shrink-0" });
    instance = mount(LazyCharImageFixture, { target, props });
    flushSync();
    return props;
}

const shown = () => target.querySelector(".icon")?.textContent ?? null;
const settle = async () => {
    for (let i = 0; i < 3; i++) {
        await Promise.resolve();
        flushSync();
    }
};

beforeEach(() => {
    getCharImage.mockClear();
    FakeObserver.live = [];
    globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
    target = document.createElement("div");
    document.body.appendChild(target);
});

afterEach(() => {
    if (instance) {
        unmount(instance);
        instance = null;
    }
    target.remove();
    globalThis.IntersectionObserver = originalObserver;
});

describe("LazyCharImage", () => {
    it("keeps an off-screen icon on its placeholder without calling getCharImage", async () => {
        render("assets/a.png");
        FakeObserver.report(false);
        await settle();
        expect(getCharImage).not.toHaveBeenCalled();
        expect(shown()).toBe("pending");
        expect(target.firstElementChild?.className).toBe("shrink-0");
        expect(FakeObserver.live).toHaveLength(1);
        expect(FakeObserver.live[0].options).toEqual({ rootMargin: "200px" });
    });

    it("calls getCharImage once the wrapper nears the viewport and renders its result", async () => {
        render("assets/a.png");
        FakeObserver.report(true);
        await settle();
        expect(getCharImage.mock.calls).toEqual([["assets/a.png", "css"]]);
        expect(shown()).toBe("css:assets/a.png");
        expect(FakeObserver.live).toHaveLength(0);
    });

    it("waits to be seen again after its path changes, back on the placeholder", async () => {
        const props = render("assets/a.png");
        FakeObserver.report(true);
        await settle();

        props.path = "assets/b.png";
        flushSync();
        await settle();
        expect(shown()).toBe("pending");
        expect(getCharImage.mock.calls).toEqual([["assets/a.png", "css"]]);

        FakeObserver.report(true);
        await settle();
        expect(getCharImage.mock.calls).toEqual([
            ["assets/a.png", "css"],
            ["assets/b.png", "css"],
        ]);
        expect(shown()).toBe("css:assets/b.png");
    });

    it("loads at once where there is no IntersectionObserver", async () => {
        globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
        render("assets/a.png");
        await settle();
        expect(getCharImage.mock.calls).toEqual([["assets/a.png", "css"]]);
        expect(shown()).toBe("css:assets/a.png");
    });

    it("stops observing when unmounted before it is seen", () => {
        render("assets/a.png");
        expect(FakeObserver.live).toHaveLength(1);
        unmount(instance!);
        instance = null;
        expect(FakeObserver.live).toHaveLength(0);
        expect(getCharImage).not.toHaveBeenCalled();
    });
});
