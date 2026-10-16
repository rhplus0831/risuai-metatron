// @vitest-environment happy-dom
import { createRawSnippet, flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reactiveProps } from "../tests/reactiveProps.svelte";

const holds = vi.hoisted(() => vi.fn());
vi.mock("src/ts/globalApi.svelte", () => ({ holdFileSrc: holds }));
import LazyFileSrc from "./LazyFileSrc.svelte";

class Observer {
    static live = new Set<Observer>();
    target!: Element;
    constructor(private callback: IntersectionObserverCallback) {
        Observer.live.add(this);
    }
    observe(target: Element) {
        this.target = target;
    }
    disconnect() {
        Observer.live.delete(this);
    }
    static see() {
        for (const observer of [...Observer.live])
            observer.callback(
                [{ target: observer.target, isIntersecting: true }] as IntersectionObserverEntry[],
                observer as unknown as IntersectionObserver,
            );
        flushSync();
    }
}
const preview = createRawSnippet((src: () => string) => ({ render: () => `<img src="${src()}">` }));
let target: HTMLElement;
let instance: ReturnType<typeof mount> | null;
const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
};
const shown = () => target.querySelector("img")?.getAttribute("src") ?? null;
function render(path: string) {
    const props = reactiveProps({ path, children: preview });
    instance = mount(LazyFileSrc, { target, props });
    flushSync();
    return props;
}
async function remove() {
    if (instance) await unmount(instance);
    instance = null;
}
beforeEach(() => {
    holds.mockReset();
    Observer.live.clear();
    vi.stubGlobal("IntersectionObserver", Observer);
    target = document.createElement("div");
    document.body.appendChild(target);
});
afterEach(async () => {
    await remove();
    target.remove();
    vi.unstubAllGlobals();
});

describe("LazyFileSrc hold ownership", () => {
    it("holds only visible paths and releases each loaded path on replacement or unmount", async () => {
        const releaseA = vi.fn(),
            releaseB = vi.fn();
        holds
            .mockReturnValueOnce({ src: Promise.resolve("blob:a"), release: releaseA })
            .mockReturnValueOnce({ src: Promise.resolve("blob:b"), release: releaseB });
        const props = render("assets/a.png");
        await settle();
        expect(holds).not.toHaveBeenCalled();
        Observer.see();
        await settle();
        expect(shown()).toBe("blob:a");
        expect(releaseA).not.toHaveBeenCalled();
        props.path = "assets/b.png";
        flushSync();
        await settle();
        expect(releaseA).toHaveBeenCalledTimes(1);
        expect(shown()).toBeNull();
        expect(holds.mock.calls).toEqual([["assets/a.png"]]);
        Observer.see();
        await settle();
        expect(shown()).toBe("blob:b");
        expect(holds.mock.calls).toEqual([["assets/a.png"], ["assets/b.png"]]);
        await remove();
        expect(releaseA).toHaveBeenCalledTimes(1);
        expect(releaseB).toHaveBeenCalledTimes(1);
    });

    it("releases unresolved loads on replacement and unmount and never renders their late results", async () => {
        let resolveA!: (src: string) => void, resolveB!: (src: string) => void;
        const releaseA = vi.fn(),
            releaseB = vi.fn();
        holds
            .mockReturnValueOnce({
                src: new Promise<string>((done) => {
                    resolveA = done;
                }),
                release: releaseA,
            })
            .mockReturnValueOnce({
                src: new Promise<string>((done) => {
                    resolveB = done;
                }),
                release: releaseB,
            });
        const props = render("assets/a.png");
        Observer.see();
        await settle();
        props.path = "assets/b.png";
        flushSync();
        expect(releaseA).toHaveBeenCalledTimes(1);
        Observer.see();
        await settle();
        resolveA("blob:a");
        await settle();
        expect(shown()).toBeNull();
        await remove();
        expect(releaseB).toHaveBeenCalledTimes(1);
        resolveB("blob:b");
        await settle();
        expect(shown()).toBeNull();
        expect(releaseA).toHaveBeenCalledTimes(1);
        expect(releaseB).toHaveBeenCalledTimes(1);
    });
});
