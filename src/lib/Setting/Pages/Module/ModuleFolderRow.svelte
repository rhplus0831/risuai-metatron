<script lang="ts">
    import type { Snippet } from "svelte";
    import { ChevronDown, ChevronRight, FolderIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { folderDisplayName } from "./moduleCatalog";

    /**
     * A module folder's row in the catalog and the chat's module menu: a chevron, a folder icon, the name (a blank one
     * as the localized "Unnamed folder"), and the count the caller passes. A click on the row calls `ontoggle`; the
     * caller's `buttons` sit beside the toggle, not inside it, and the caller indents the member rows.
     */
    interface Props {
        name: string;
        /** The member count, or the chat menu's "on / total". */
        count: string | number;
        open: boolean;
        ontoggle: () => void;
        buttons?: Snippet;
    }

    let { name, count, open, ontoggle, buttons }: Props = $props();
    const unnamed = $derived(name.trim() === "");
</script>

<div class="pl-3 py-3 text-left flex items-center">
    <button
        type="button"
        class="flex grow min-w-0 items-center gap-2 text-left cursor-pointer"
        aria-expanded={open}
        onclick={() => ontoggle()}
    >
        <span class="shrink-0 text-textcolor2"
            >{#if open}<ChevronDown size={16} />{:else}<ChevronRight size={16} />{/if}</span
        >
        <FolderIcon size={18} class="shrink-0" />
        <span class="font-semibold min-w-0 break-words" class:text-textcolor2={unnamed}
            >{folderDisplayName(name, language.itemFolders.unnamed)}</span
        >
        <span class="shrink-0 text-sm text-textcolor2">{count}</span>
    </button>
    {#if buttons}
        <div class="shrink-0 flex justify-end items-center">
            {@render buttons()}
        </div>
    {/if}
</div>
