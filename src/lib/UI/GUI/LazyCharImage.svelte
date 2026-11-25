<script lang="ts">
    // Defer the asset facade until a load error needs its services.
    async function recover(event: Event) {
        const element = event.target;
        if (!(element instanceof Element)) return;
        const failedSrc = element.getAttribute("src");
        const { recoverDirectAssetElement } = await import("src/ts/globalApi.svelte");
        if (element.getAttribute("src") === failedSrc) await recoverDirectAssetElement(element);
    }

    import type { Snippet } from "svelte";
    import { getCharImage } from "src/ts/characters";

    /**
     * A character or persona icon whose `getCharImage` read (`src/ts/characters.ts`) waits until the wrapper first
     * comes within 200px of the viewport (at once without `IntersectionObserver`), so a long list reads only the
     * icons near the screen.
     */

    interface Props {
        /** The stored image path, passed to `getCharImage` once the wrapper nears the viewport. */
        path: string;
        /** `getCharImage`'s output form. */
        type: "plain" | "css" | "contain" | "lgcss";
        /** The thumbnail size for direct assets; omitted or fallback loads use the original. */
        thumb?: 256 | 512;
        /** The icon, given `getCharImage`'s result; before the wrapper is seen, a promise that never settles. */
        children: Snippet<[ReturnType<typeof getCharImage>]>;
        /** The wrapper's class: give it the icon's size, so an unseen icon takes its place. */
        class?: string;
    }

    const { path, type, thumb, children, class: className = "" }: Props = $props();

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

    const image = $derived(seenPath === path ? getCharImage(path, type, thumb) : notSeen);
</script>

<div bind:this={anchor} class={className} onerrorcapture={recover}>
    {@render children(image)}
</div>
