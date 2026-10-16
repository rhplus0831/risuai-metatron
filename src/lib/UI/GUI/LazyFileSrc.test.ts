// @vitest-environment happy-dom
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactiveProps } from "../tests/reactiveProps.svelte";

// The lazy preview the asset lists use: the file is held (`holdFileSrc`, its read behind the
// `readFileSrc` double) only once the wrapper nears the viewport, for the path it was seen with; a
// row reused for another path waits to be seen again and never shows the previous file; a late
// result for an old path is dropped. The hold's release and revocation: `LazyFileSrcHold.test.ts`.

const readFileSrc = vi.fn<(path: string) => Promise<string>>();
vi.mock("src/ts/globalApi.svelte", () => ({
    holdFileSrc: (path: string) => ({ src: readFileSrc(path), release: () => {} }),
}));

import LazyFileSrc from "./LazyFileSrc.svelte";

/** A stand-in observer the test drives: `intersect()` reports every observed element as visible. */
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
    static intersect() {
        for (const observer of [...FakeObserver.live]) {
            const entries = observer.observed.map((target) => ({ target, isIntersecting: true }));
            observer.callback(entries as unknown as IntersectionObserverEntry[], observer as never);
        }
        flushSync();
    }
}

const preview = createRawSnippet((src: () => string) => ({ render: () => `<img src="${src()}">` }));

let target: HTMLElement;
let instance: ReturnType<typeof mount> | null = null;
const originalObserver = globalThis.IntersectionObserver;

function render(path: string) {
    const props = reactiveProps({ path, children: preview, class: "w-16 h-16" });
    instance = mount(LazyFileSrc, { target, props });
    flushSync();
    return props;
}

const shown = () => target.querySelector("img")?.getAttribute("src") ?? null;
const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
};

beforeEach(() => {
    readFileSrc.mockReset();
    readFileSrc.mockImplementation(async (path) => `/sw/img/${path}`);
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

describe("LazyFileSrc", () => {
    it("reads the file only once the wrapper is seen, then renders the preview with its source", async () => {
        render("a.png");
        await settle();
        expect(readFileSrc).not.toHaveBeenCalled();
        expect(shown()).toBeNull();
        expect(target.firstElementChild?.className).toBe("w-16 h-16");

        FakeObserver.intersect();
        await settle();
        expect(readFileSrc.mock.calls).toEqual([["a.png"]]);
        expect(shown()).toBe("/sw/img/a.png");
        expect(FakeObserver.live).toHaveLength(0);
    });

    it("renders nothing when the read fails", async () => {
        readFileSrc.mockResolvedValue("");
        render("missing.png");
        FakeObserver.intersect();
        await settle();
        expect(readFileSrc).toHaveBeenCalledOnce();
        expect(shown()).toBeNull();
    });

    it("waits to be seen again after its path changes, without showing the previous file", async () => {
        const props = render("a.png");
        FakeObserver.intersect();
        await settle();
        expect(shown()).toBe("/sw/img/a.png");

        props.path = "b.png";
        flushSync();
        await settle();
        expect(shown()).toBeNull();
        expect(readFileSrc.mock.calls).toEqual([["a.png"]]);

        FakeObserver.intersect();
        await settle();
        expect(readFileSrc.mock.calls).toEqual([["a.png"], ["b.png"]]);
        expect(shown()).toBe("/sw/img/b.png");
    });

    it("drops a result that arrives after the path changed", async () => {
        let resolveOld: (src: string) => void = () => {};
        readFileSrc.mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)));
        const props = render("old.png");
        FakeObserver.intersect();
        await settle();

        props.path = "new.png";
        flushSync();
        FakeObserver.intersect();
        await settle();
        expect(shown()).toBe("/sw/img/new.png");

        resolveOld("/sw/img/old.png");
        await settle();
        expect(shown()).toBe("/sw/img/new.png");
    });

    it("loads at once where there is no IntersectionObserver", async () => {
        globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;
        render("a.png");
        await settle();
        expect(readFileSrc.mock.calls).toEqual([["a.png"]]);
        expect(shown()).toBe("/sw/img/a.png");
    });

    it("stops observing when unmounted before it is seen", () => {
        render("a.png");
        expect(FakeObserver.live).toHaveLength(1);
        unmount(instance!);
        instance = null;
        expect(FakeObserver.live).toHaveLength(0);
        expect(readFileSrc).not.toHaveBeenCalled();
    });
});
