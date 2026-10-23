<!-- Test-only: a `LazyCharImage` icon that awaits its image like the real consumers' `{#await}` blocks. -->
<script lang="ts">
    import LazyCharImage from "../GUI/LazyCharImage.svelte";

    interface Props {
        path: string;
        type: "plain" | "css" | "contain" | "lgcss";
        thumb?: 256 | 512;
        class?: string;
    }

    const { path, type, thumb, class: className = "" }: Props = $props();
</script>

<LazyCharImage {path} {type} {thumb} class={className}>
    {#snippet children(image)}
        {#await image}
            <span class="icon">pending</span>
        {:then value}
            <span class="icon">{value ?? ""}</span>
        {/await}
    {/snippet}
</LazyCharImage>
