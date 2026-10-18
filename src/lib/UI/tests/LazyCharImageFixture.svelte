<!-- Test-only: a `LazyCharImage` icon that awaits its image like the real consumers' `{#await}` blocks. -->
<script lang="ts">
    import LazyCharImage from "../GUI/LazyCharImage.svelte";

    interface Props {
        path: string;
        type: "plain" | "css" | "contain" | "lgcss";
        class?: string;
    }

    const { path, type, class: className = "" }: Props = $props();
</script>

<LazyCharImage {path} {type} class={className}>
    {#snippet children(image)}
        {#await image}
            <span class="icon">pending</span>
        {:then value}
            <span class="icon">{value ?? ""}</span>
        {/await}
    {/snippet}
</LazyCharImage>
