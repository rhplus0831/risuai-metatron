<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { onDestroy, onMount, tick } from "svelte";
    import { Maximize2Icon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { hotkeyMatches } from "src/ts/hotkey";
    import {
        closePopupEditorSession,
        isPopupEditorSessionCurrent,
        openPopupEditorSession,
        popUpEditorStore,
    } from "src/ts/stores.svelte";
    import { sleep } from "src/ts/util";

    import { longpress } from "src/ts/gui/longtouch";

    let textarea: HTMLTextAreaElement = $state();
    let previousScrollHeight = 0;
    let resizeRequest = 0;
    let popupEditorRun = 0;
    let activePopupEditorSessionId: number | null = null;
    interface Props {
        value?: string;
        handleLongPress?: any;
        popupEditor?: boolean;
        popupLanguage?: string;
        onchange?: () => void;
        stableHeight?: boolean;
        ariaLabel?: string;
    }

    let {
        value = $bindable(""),
        handleLongPress = (e: MouseEvent) => {},
        popupEditor = false,
        popupLanguage = "markdown",
        onchange = () => {},
        stableHeight = false,
        ariaLabel = language.input,
    }: Props = $props();

    function resize() {
        if (!textarea || stableHeight) return;
        textarea.style.height = "0px"; // Reset the textarea height
        textarea.style.height = `calc(${textarea.scrollHeight}px + 1rem)`; // Set the new height
    }

    function handleInput() {
        if (!textarea || stableHeight) return;
        if (textarea.scrollHeight !== previousScrollHeight) {
            previousScrollHeight = textarea.scrollHeight;
            resize();
        }
    }

    async function openPopupEditor() {
        if (!popupEditor) return;
        const run = ++popupEditorRun;
        const initialValue = value;
        const sessionId = openPopupEditorSession(value, popupLanguage);
        activePopupEditorSessionId = sessionId;

        try {
            while (
                run === popupEditorRun &&
                value === initialValue &&
                isPopupEditorSessionCurrent(sessionId) &&
                popUpEditorStore.open
            ) {
                await sleep(100);
            }

            if (run !== popupEditorRun || value !== initialValue) {
                closePopupEditorSession(sessionId);
                return;
            }
            if (!isPopupEditorSessionCurrent(sessionId)) return;
            value = popUpEditorStore.value;
            onchange();
            await tick();
            if (run === popupEditorRun) resize();
        } finally {
            if (activePopupEditorSessionId === sessionId) activePopupEditorSessionId = null;
        }
    }

    onMount(() => {
        resize();
    });

    onDestroy(() => {
        popupEditorRun += 1;
        resizeRequest += 1;
        if (activePopupEditorSessionId !== null) {
            closePopupEditorSession(activePopupEditorSessionId);
            activePopupEditorSessionId = null;
        }
    });

    $effect(() => {
        void value;
        void stableHeight;
        const request = ++resizeRequest;
        void tick().then(() => {
            if (request !== resizeRequest || !textarea) return;
            previousScrollHeight = textarea.scrollHeight;
            resize();
        });
    });
</script>

<div class="relative w-full">
    <textarea
        aria-label={ariaLabel}
        bind:this={textarea}
        oninput={handleInput}
        onkeydown={(e) => {
            if (
                popupEditor &&
                (e.ctrlKey || e.shiftKey || e.altKey) &&
                hotkeyMatches(
                    settings.hotkeys.find((hk) => hk.action === "popupEditor"),
                    e,
                )
            ) {
                e.preventDefault();
                void openPopupEditor();
            }
        }}
        use:longpress={handleLongPress}
        bind:value
        class="rounded-md p-2 text-textcolor bg-transparent resize-none border border-darkborderc w-full message-edit-area"
        class:pr-10={popupEditor}
        class:overflow-y-auto={stableHeight}
        class:overflow-y-hidden={!stableHeight}
        style:height={stableHeight ? "16rem" : undefined}
        style:min-height={stableHeight ? "12rem" : undefined}
        style:max-height={stableHeight ? "60vh" : undefined}
        style:font-size="{0.875 * (settings.ui.zoomsize / 100)}rem"
        style:line-height="{(settings.ui.lineHeight ?? 1.25) * (settings.ui.zoomsize / 100)}rem"></textarea>

    {#if popupEditor}
        <button
            type="button"
            class="absolute right-1 top-1 z-60 flex h-7 w-7 items-center justify-center rounded-md text-textcolor2 transition-colors hover:bg-darkbutton hover:text-textcolor focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-borderc"
            aria-label={language.hotkeyDesc.popupEditor}
            title={language.hotkeyDesc.popupEditor}
            onclick={() => void openPopupEditor()}
        >
            <Maximize2Icon size={16} />
        </button>
    {/if}
</div>
