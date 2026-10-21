<script lang="ts">
    // A chat row's uses of its chat screen's shared stylesheets (`chatStyles.ts`).
    // Renders nothing; `ChatBody` mounts it only under a registry.
    import { untrack } from "svelte";
    import { type ChatStyle, getChatStyleRegistry } from "../../ts/parser/chatStyles";

    interface Props {
        /** The CSS and sanitized attributes of the row's shared styles, in document order. */
        styles: readonly ChatStyle[];
        /** The row's message index (-1: the greeting). */
        messageIndex: number;
    }

    let { styles, messageIndex }: Props = $props();

    const registry = getChatStyleRegistry();
    // By value: a body rendered again with the same CSS and attributes keeps its uses.
    const wanted = $derived(JSON.stringify([messageIndex, styles]));

    $effect(() => {
        wanted;
        if (!registry) return;
        const releases = untrack(() => styles.map((style, slot) => registry.acquire(style, messageIndex, slot)));
        return () => {
            for (const release of releases) release();
        };
    });
</script>
