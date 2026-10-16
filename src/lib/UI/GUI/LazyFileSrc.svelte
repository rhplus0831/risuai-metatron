<script lang="ts">
    import type { Snippet } from "svelte";
    import { holdFileSrc } from "src/ts/globalApi.svelte";

    interface Props {
        /** Held once the wrapper nears the viewport, released when the path changes or it unmounts. */
        path: string;
        /** The preview, given the file's source URL; nothing renders before it loads or when it fails. */
        children: Snippet<[string]>;
        /** The wrapper's class: give it the preview's size, so an unloaded preview takes its place. */
        class?: string;
    }

    const { path, children, class: className = "" }: Props = $props();

    let anchor: HTMLElement | undefined = $state();
    // The path the wrapper was seen near the viewport with: a row reused for another file (a removal
    // shifts the list) waits to be seen again.
    let seenPath: string | null = $state(null);
    let loaded: { path: string; src: string } | null = $state(null);

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

    $effect(() => {
        const wanted = path;
        if (seenPath !== wanted) {
            return;
        }
        let current = true;
        const source = holdFileSrc(wanted);
        source.src.then((src) => {
            if (current) {
                loaded = { path: wanted, src };
            }
        });
        return () => {
            current = false;
            source.release();
        };
    });
</script>

<div bind:this={anchor} class={className}>
    {#if loaded && loaded.path === path && loaded.src}
        {@render children(loaded.src)}
    {/if}
</div>
