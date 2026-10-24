<script lang="ts">
    import type { Snippet } from "svelte";
    import { ChevronDown, ChevronRight, FolderIcon, LinkIcon, SunIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import type { ChatLoreOverride, loreBook } from "../../../../shared/database.ts";
    import Check from "../../UI/GUI/CheckInput.svelte";
    import LoreEntryFields from "./LoreEntryFields.svelte";

    interface Props {
        original: () => loreBook;
        override?: ChatLoreOverride;
        liveOverride: (target: ChatLoreOverride) => ChatLoreOverride;
        replaceEntry: (target: ChatLoreOverride, entry: loreBook) => void;
        toggle: (checked: boolean) => void;
        all?: boolean;
        some?: boolean;
        offNotice?: boolean;
        children?: Snippet;
    }
    let {
        original,
        override,
        liveOverride,
        replaceEntry,
        toggle,
        all = false,
        some = false,
        offNotice = false,
        children,
    }: Props = $props();
    let open = $state(false);
    const folder = $derived(original().mode === "folder");
    const effective = $derived(override ? liveOverride(override).entry : original());
</script>

<div class="border border-selected rounded-md p-2">
    <div class="flex flex-wrap items-center gap-2">
        <button
            class="flex flex-1 items-center gap-1 text-left min-w-0"
            class:text-textcolor2={!override && !all}
            aria-expanded={open}
            onclick={() => (open = !open)}
        >
            {#if open}<ChevronDown size={16} />{:else}<ChevronRight size={16} />{/if}
            {#if folder}<FolderIcon size={20} />{/if}
            <span class="break-words"
                >{effective.comment ||
                    effective.key ||
                    (folder ? language.chatLoreOverrides.unnamedFolder : language.chatLoreOverrides.unnamedEntry)}</span
            >
        </button>
        <span
            class="text-textcolor2"
            aria-label={effective.alwaysActive ? language.alwaysActive : language.activationKeys}
        >
            {#if effective.alwaysActive}<SunIcon size={20} />{:else}<LinkIcon size={20} />{/if}
        </span>
        <Check
            bind:check={() => (folder ? all : !!override), (checked) => toggle(checked)}
            indeterminate={folder && some && !all}
            name={language.chatLoreOverrides.pin}
        />
    </div>
    {#if offNotice}
        <p class="text-xs text-textcolor2 mt-2">{language.chatLoreOverrides.offNotice}</p>
    {/if}
    {#if open}
        {#if folder}
            <div class="flex flex-col gap-2 mt-2 ml-2 border-l border-selected pl-2">{@render children?.()}</div>
        {:else}
            <!-- Capture the object in a keyed row: a late input/popup write keeps that target. -->
            {#each override ? [override] : [] as target (target)}
                {@render editable(target)}
            {:else}
                <div class="opacity-60 text-textcolor2">
                    <LoreEntryFields value={original()} disabled />
                </div>
            {/each}
        {/if}
    {/if}
</div>

{#snippet editable(target: ChatLoreOverride)}
    <div class="mt-2">
        <Check
            bind:check={() => liveOverride(target).off, (next) => (liveOverride(target).off = next)}
            name={language.chatLoreOverrides.off}
        />
    </div>
    <LoreEntryFields bind:value={() => liveOverride(target).entry, (next) => replaceEntry(target, next)} />
{/snippet}
