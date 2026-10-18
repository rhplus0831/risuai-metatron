<script lang="ts">
    import type { Snippet } from "svelte";
    import { getCharImage } from "src/ts/characters";

    interface Props {
        /** The stored image path, passed to `getCharImage` once the wrapper nears the viewport. */
        path: string;
        /** `getCharImage`'s output form. */
        type: "plain" | "css" | "contain" | "lgcss";
        /** The icon, given `getCharImage`'s result; before the wrapper is seen, a promise that never settles. */
        children: Snippet<[ReturnType<typeof getCharImage>]>;
        /** The wrapper's class: give it the icon's size, so an unseen icon takes its place. */
        class?: string;
    }

    const { path, type, children, class: className = "" }: Props = $props();

    // The image of an icon not yet seen: its `{#await}` stays on the loading placeholder. One per
    // instance, never shared: a promise that never settles keeps every callback attached to it, so a
    // shared one would retain each unmounted row's `{#await}` block.
    const notSeen: Promise<never> = new Promise(() => {});

    let anchor: HTMLElement | undefined = $state();
    // The path the wrapper was seen near the viewport with: an unkeyed row reused for another
    // character waits to be seen again.
    let seenPath: string | null = $state(null);

    $effect(() => {
        const wanted = path;
        if (!anchor || seenPath === wanted) {
            return;
        }
        if (typeof IntersectionObserver === "undefined") {
            seenPath = wanted;
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    seenPath = wanted;
                }
            },
            { rootMargin: "200px" },
        );
        observer.observe(anchor);
        return () => observer.disconnect();
    });

    const image = $derived(seenPath === path ? getCharImage(path, type) : notSeen);
</script>

<div bind:this={anchor} class={className}>
    {@render children(image)}
</div>
