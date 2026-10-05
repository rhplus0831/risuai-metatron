<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { onMount } from "svelte";

    import { longpress } from "src/ts/gui/longtouch";

    let textarea: HTMLElement = $state();
    let previousScrollHeight = 0;
    interface Props {
        value?: string;
        handleLongPress?: any;
    }

    let { value = $bindable(""), handleLongPress = (e: MouseEvent) => {} }: Props = $props();

    function resize() {
        textarea.style.height = "0px"; // Reset the textarea height
        textarea.style.height = `calc(${textarea.scrollHeight}px + 1rem)`; // Set the new height
    }

    function handleInput() {
        if (textarea.scrollHeight !== previousScrollHeight) {
            previousScrollHeight = textarea.scrollHeight;
            resize();
        }
    }

    onMount(() => {
        resize();
    });
</script>

<textarea
    bind:this={textarea}
    oninput={handleInput}
    use:longpress={handleLongPress}
    bind:value
    class="rounded-md p-2 text-textcolor bg-transparent resize-none overflow-y-hidden border border-darkborderc w-full message-edit-area"
    style:font-size="{0.875 * (settings.ui.zoomsize / 100)}rem"
    style:line-height="{(settings.ui.lineHeight ?? 1.25) * (settings.ui.zoomsize / 100)}rem"></textarea>
