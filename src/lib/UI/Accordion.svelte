<script lang="ts">
    import type { language } from "src/lang";
    import Help from "../Others/Help.svelte";

    interface Props {
        name?: string;
        styled?: boolean;
        help?: keyof typeof language.help | "";
        disabled?: boolean;
        children?: import("svelte").Snippet;
        className?: string;
        /** A small pill beside the name (styled only), such as "Experimental" */
        badge?: string;
        /** Starts open (read once, at mount). */
        startOpen?: boolean;
        /** Controlled when bound; otherwise starts at startOpen. */
        open?: boolean;
    }

    let {
        name = "",
        styled = false,
        help = "",
        disabled = false,
        children,
        className = "",
        badge = "",
        startOpen = false,
        open = $bindable(startOpen),
    }: Props = $props();
</script>

{#if disabled}
    {@render children?.()}
{:else if styled}
    <div class="flex flex-col mt-2">
        <button
            class="hover:bg-selected px-6 py-2 text-lg rounded-t-md border-selected border"
            class:bg-selected={open}
            class:rounded-b-md={!open}
            aria-expanded={open}
            onclick={() => {
                open = !open;
            }}
        >
            <span class="mr-2">{name}</span>
            {#if badge}
                <span
                    class="mr-2 rounded-full border border-darkborderc px-2 py-0.5 align-middle text-xs text-textcolor2"
                    >{badge}</span
                >
            {/if}
            {#if help}
                <Help key={help} />
            {/if}</button
        >
        {#if open}
            <div class={"flex flex-col border border-selected p-2 rounded-b-md " + className}>
                {@render children?.()}
            </div>
        {/if}
    </div>
{:else}
    <div class="flex flex-col">
        <button
            class="hover:bg-selected px-6 py-2 text-lg"
            class:bg-selected={open}
            aria-expanded={open}
            onclick={() => {
                open = !open;
            }}>{name}</button
        >
        {#if open}
            <div class="flex flex-col bg-darkbg">
                {@render children?.()}
            </div>
        {/if}
    </div>
{/if}
