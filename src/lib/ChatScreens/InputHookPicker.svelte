<script lang="ts">
    import { XIcon } from "@lucide/svelte";
    import { onMount } from "svelte";
    import { get } from "svelte/store";
    import { language } from "src/lang";
    import { doingAlert, terminalNotice } from "src/ts/alert";
    import { topBindingLayer } from "src/ts/gui/dialogLayers";
    import type { InputHook } from "../../../shared/inputHooks.ts";
    import Portal from "../UI/GUI/Portal.svelte";

    interface Props {
        hooks: readonly InputHook[];
        onchoose: (hook: InputHook) => void;
        onclose: () => void;
    }

    let { hooks, onchoose, onclose }: Props = $props();
    const id = $props.id();
    const titleId = `${id}-title`;
    let dialog: HTMLDivElement | undefined = $state();
    let closeButton: HTMLButtonElement | undefined = $state();

    onMount(() => {
        const previous = document.activeElement;
        return () => {
            if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
        };
    });

    $effect(() => {
        closeButton?.focus();
    });

    function onKeyDown(event: KeyboardEvent) {
        if (event.isComposing || event.keyCode === 229) return;
        if (doingAlert() || get(terminalNotice) !== null || topBindingLayer() !== null) return;
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onclose();
        } else if (event.key === "Tab") {
            const buttons = dialog?.querySelectorAll<HTMLButtonElement>("button");
            const first = buttons?.[0];
            const last = buttons?.[buttons.length - 1];
            if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
                event.preventDefault();
                (event.shiftKey ? last : first)?.focus();
            }
        }
    }
</script>

<svelte:window onkeydowncapture={onKeyDown} />

<Portal>
    <div class="fixed inset-0 z-40 bg-bgcolor/70 flex justify-center items-center p-2">
        <button type="button" class="absolute inset-0" tabindex="-1" aria-label={language.cancel} onclick={onclose}
        ></button>
        <div
            bind:this={dialog}
            class="relative bg-darkbg text-textcolor p-4 rounded-md flex flex-col gap-3 max-w-full w-96 max-h-full overflow-y-auto border border-darkborderc"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabindex="-1"
        >
            <div class="flex items-center gap-4">
                <h2 id={titleId} class="m-0 text-lg">{language.inputHooks.btwPickerTitle}</h2>
                <button
                    bind:this={closeButton}
                    type="button"
                    class="ml-auto text-textcolor2 hover:text-textcolor transition-colors"
                    aria-label={language.cancel}
                    onclick={onclose}
                >
                    <XIcon size={22} />
                </button>
            </div>
            {#each hooks as hook (hook.id)}
                <button
                    type="button"
                    class="w-full border-t border-darkborderc p-2 text-left break-words hover:bg-selected transition-colors"
                    onclick={() => onchoose(hook)}
                >
                    {hook.name}
                </button>
            {/each}
        </div>
    </div>
</Portal>
