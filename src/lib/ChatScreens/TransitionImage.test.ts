// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import { expect, it } from "vitest";
import TransitionImage from "./TransitionImage.svelte";

it("keeps the newest portrait when an older source resolves later and preserves the supplied arrays", async () => {
    let resolveOld!: (images: string[]) => void;
    let resolveNew!: (images: string[]) => void;
    const oldSource = new Promise<string[]>((resolve) => (resolveOld = resolve));
    const newSource = new Promise<string[]>((resolve) => (resolveNew = resolve));
    const source = writable(oldSource);
    const reactiveSource = fromStore(source);
    const target = document.createElement("div");
    document.body.append(target);
    const component = mount(TransitionImage, {
        target,
        props: {
            classType: "risu",
            get src() {
                return reactiveSource.current;
            },
        },
    });
    try {
        flushSync();
        source.set(newSource);
        flushSync();
        const newest = ["normal", "data:,new-left", "data:,new-right"];
        resolveNew(newest);
        await tick();
        flushSync();
        const images = () => [...target.querySelectorAll("img")].map((image) => image.getAttribute("src"));
        expect(images()).toEqual(["data:,new-left", "data:,new-right"]);
        expect(newest).toEqual(["normal", "data:,new-left", "data:,new-right"]);

        const older = ["emp", "data:,old-portrait"];
        resolveOld(older);
        await tick();
        flushSync();
        expect(images()).toEqual(["data:,new-left", "data:,new-right"]);
        expect(older).toEqual(["emp", "data:,old-portrait"]);
    } finally {
        await unmount(component);
        target.remove();
    }
});
