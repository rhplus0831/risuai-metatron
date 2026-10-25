<script lang="ts" module>
    export type EntryState = "original" | "overridden" | "off";
    export type FolderState = "on" | "off";
</script>

<script lang="ts">
    import type { Snippet } from "svelte";
    import { ChevronDown, ChevronRight, FolderIcon, LinkIcon, SunIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import type { ChatLoreOverride, loreBook } from "../../../../shared/database.ts";
    import SegmentedControl from "../../UI/GUI/SegmentedControl.svelte";
    import LoreEntryFields from "./LoreEntryFields.svelte";

    interface Props {
        original: () => loreBook;
        override?: ChatLoreOverride;
        liveOverride: (target: ChatLoreOverride) => ChatLoreOverride;
        replaceEntry: (target: ChatLoreOverride, entry: loreBook) => void;
        /** The entry's or folder's state in this chat; the control rederives it after every write. */
        rowState: EntryState | FolderState;
        setRowState: (next: EntryState | FolderState) => void;
        /** Folder only: the overrides inside it (entries, and nested folders that are off). */
        changed?: number;
        /** Folder only: it or an enclosing folder is off, so the overrides inside it do not apply. */
        notApplied?: boolean;
        /** The row sits inside an off folder. */
        inOffFolder?: boolean;
        offNotice?: boolean;
        releaseAll?: () => void;
        children?: Snippet;
    }
    let {
        original,
        override,
        liveOverride,
        replaceEntry,
        rowState,
        setRowState,
        changed = 0,
        notApplied = false,
        inOffFolder = false,
        offNotice = false,
        releaseAll,
        children,
    }: Props = $props();
    const indicatorId = $props.id();
    let open = $state(false);
    const folder = $derived(original().mode === "folder");
    const effective = $derived(override ? liveOverride(override).entry : original());
    const name = $derived(
        effective.comment ||
            effective.key ||
            (folder ? language.chatLoreOverrides.unnamedFolder : language.chatLoreOverrides.unnamedEntry),
    );
    const strings = language.chatLoreOverrides;
    const options = $derived(
        folder
            ? [
                  { value: "on", label: strings.on },
                  { value: "off", label: strings.off },
              ]
            : [
                  { value: "original", label: strings.original },
                  { value: "overridden", label: strings.overridden },
                  { value: "off", label: strings.off },
              ],
    );
    const dimmed = $derived(inOffFolder || rowState === (folder ? "off" : "original"));
</script>

<div class="border border-selected rounded-md p-2">
    <div class="flex flex-wrap items-center gap-2">
        <button
            class="flex basis-32 grow items-center gap-1 text-left min-w-0"
            class:text-textcolor2={dimmed}
            aria-expanded={open}
            onclick={() => (open = !open)}
        >
            <span class="shrink-0"
                >{#if open}<ChevronDown size={16} />{:else}<ChevronRight size={16} />{/if}</span
            >
            {#if folder}<span class="shrink-0"><FolderIcon size={20} /></span>{/if}
            <span class="break-words min-w-0">{name}</span>
        </button>
        <div class="flex flex-wrap items-center gap-2">
            <span
                class="text-textcolor2"
                role="img"
                aria-label={effective.alwaysActive ? language.alwaysActive : language.activationKeys}
            >
                {#if effective.alwaysActive}<SunIcon size={20} />{:else}<LinkIcon size={20} />{/if}
            </span>
            <SegmentedControl
                bind:value={() => rowState, (next) => setRowState(next as EntryState | FolderState)}
                {options}
                size="sm"
                margin={false}
                label={strings.stateFor(name)}
                describedBy={folder && changed > 0 ? indicatorId : undefined}
            />
            {#if folder && changed > 0}
                <span id={indicatorId} class="text-xs text-textcolor2"
                    >{strings.changed(changed)}{#if notApplied}{" · "}{strings.notApplied}{/if}</span
                >
            {/if}
        </div>
    </div>
    {#if inOffFolder}
        <p class="text-xs text-textcolor2 mt-2">{strings.folderOffNotice}</p>
    {/if}
    {#if offNotice}
        <p class="text-xs text-textcolor2 mt-2">{strings.offNotice}</p>
    {/if}
    {#if open}
        {#if folder}
            <div class="flex flex-col gap-2 mt-2 ml-2 border-l border-selected pl-2">
                {#if changed > 0 && releaseAll}
                    <button
                        class="self-start rounded-md bg-darkbutton text-textcolor px-2 py-1 hover:bg-selected"
                        onclick={releaseAll}>{strings.releaseAll}</button
                    >
                {/if}
                {@render children?.()}
            </div>
        {:else}
            <!-- Capture the object in a keyed row: a late input/popup write keeps that target. -->
            {#each override ? [override] : [] as target (target)}
                <div class="mt-2">
                    <LoreEntryFields
                        bind:value={() => liveOverride(target).entry, (next) => replaceEntry(target, next)}
                    />
                </div>
            {:else}
                <div class="opacity-60 text-textcolor2">
                    <LoreEntryFields value={original()} disabled />
                </div>
            {/each}
        {/if}
    {/if}
</div>
