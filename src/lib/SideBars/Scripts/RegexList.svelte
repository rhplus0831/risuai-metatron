<script lang="ts">
    import type { customscript } from "src/ts/storage/database.svelte";
    import RegexData from "./RegexData.svelte";
    import Sortable from "sortablejs";
    import { sleep, sortableOptions } from "src/ts/util";
    import { onDestroy, onMount } from "svelte";
    import { DownloadIcon, HardDriveUploadIcon, PlusIcon } from "@lucide/svelte";
    import { exportRegex, importRegex } from "src/ts/process/regexFiles";
    import { recordValueIdentity } from "src/ts/storage/records.svelte";

    /**
     * Sortable regex list with file import and export through `src/ts/process/regexFiles.ts`.
     * Drag order sets the script array's execution order unless an enabled `<order n>` overrides
     * it in `shared/scripts/regex.ts`.
     */

    interface Props {
        value?: customscript[];
        buttons?: boolean;
        /** The record the scripts belong to; a popup opened on another record is discarded. */
        popupEditorContext?: unknown;
    }

    let { value = $bindable([]), buttons = false, popupEditorContext = undefined }: Props = $props();
    let stb: Sortable = null;
    let ele: HTMLDivElement = $state();
    let sorted = $state(0);
    let opened = 0;
    let destroyed = false;
    const createStb = () => {
        stb = Sortable.create(ele, {
            onEnd: async () => {
                let idx: number[] = [];
                ele.querySelectorAll("[data-risu-idx]").forEach((e, i) => {
                    idx.push(parseInt(e.getAttribute("data-risu-idx")));
                });
                let newValue: customscript[] = [];
                idx.forEach((i) => {
                    newValue.push(value[i]);
                });
                value = newValue;
                try {
                    stb.destroy();
                } catch (error) {}
                sorted += 1;
                await sleep(1);
                createStb();
            },
            ...sortableOptions,
        });
    };

    const onOpen = () => {
        opened += 1;
        if (stb) {
            try {
                stb.destroy();
            } catch (error) {}
        }
    };
    const onClose = () => {
        opened -= 1;
        if (opened === 0) {
            createStb();
        }
    };

    onMount(createStb);

    onDestroy(() => {
        destroyed = true;
        if (stb) {
            try {
                stb.destroy();
            } catch (error) {}
        }
    });
</script>

{#key sorted}
    <div
        class="contain w-full max-w-full mt-2 flex flex-col p-3 border-selected border-1 bg-darkbg rounded-md"
        bind:this={ele}
    >
        {#if value.length === 0}
            <div class="text-textcolor2">No Scripts</div>
        {/if}
        {#each value as customscript, i}
            <RegexData
                idx={i}
                bind:value={value[i]}
                {popupEditorContext}
                {onOpen}
                {onClose}
                onRemove={(row) => {
                    if (destroyed) return;
                    const index = value.findIndex((script) => recordValueIdentity(script) === row);
                    if (index < 0) return;
                    value.splice(index, 1);
                    value = value;
                }}
            />
        {/each}
    </div>
{/key}
{#if buttons}
    <div class="flex gap-2 mt-2">
        <button
            class="rounded-md text-textcolor2 hover:text-textcolor focus-within:text-textcolor"
            onclick={() => {
                value.push({
                    comment: "",
                    in: "",
                    out: "",
                    type: "editinput",
                });
            }}
        >
            <PlusIcon />
        </button>
        <button
            class="rounded-md text-textcolor2 hover:text-textcolor focus-within:text-textcolor"
            onclick={() => {
                exportRegex(value);
            }}><DownloadIcon /></button
        >
        <button
            class="rounded-md text-textcolor2 hover:text-textcolor focus-within:text-textcolor"
            onclick={async () => {
                const owner = popupEditorContext;
                const list = recordValueIdentity(value);
                const scripts = await importRegex($state.snapshot(value));
                if (destroyed || !Object.is(owner, popupEditorContext) || list !== recordValueIdentity(value)) return;
                value = scripts;
            }}><HardDriveUploadIcon /></button
        >
    </div>
{/if}
