<script module lang="ts">
    /** How long a toast stays once nothing holds it: counted from its appearance, and again each time the pointer
     * and focus have both left it. */
    export const TOAST_DURATION_MS = 10_000;
    /** The fade before a timed-out toast closes; the pointer or focus coming back during it keeps the toast. */
    export const TOAST_FADE_MS = 300;
</script>

<script lang="ts">
    import { onDestroy } from "svelte";

    interface Props {
        msg: string;
        /** Ends this toast; called once, on a click or when the timer runs out. */
        onclose: () => void;
    }

    let { msg, onclose }: Props = $props();

    let element: HTMLDivElement | undefined = $state();
    let hovered = false;
    let focused = false;
    let leaving = $state(false);
    let timer: ReturnType<typeof setTimeout> | null = null;

    function hold() {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        leaving = false;
    }

    /** Starts a full count unless the pointer or focus still holds the toast. */
    function release() {
        hold();
        if (hovered || focused) return;
        timer = setTimeout(() => {
            leaving = true;
            timer = setTimeout(close, TOAST_FADE_MS);
        }, TOAST_DURATION_MS);
    }

    function close() {
        hold();
        onclose();
    }

    function click() {
        // A drag that selected some of the message (to copy an error) is not a dismissal.
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && element?.contains(selection.anchorNode)) return;
        close();
    }

    release();
    onDestroy(hold);
</script>

<div
    bind:this={element}
    role="button"
    tabindex="0"
    class="toast absolute right-0 bottom-0 bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl max-h-11/12 overflow-y-auto z-1100 text-textcolor cursor-pointer"
    class:leaving
    onclick={click}
    onkeydown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            close();
        }
    }}
    onmouseenter={() => {
        hovered = true;
        hold();
    }}
    onmouseleave={() => {
        hovered = false;
        release();
    }}
    onfocus={() => {
        focused = true;
        hold();
    }}
    onblur={() => {
        focused = false;
        release();
    }}
>
    {msg}
</div>

<style>
    @keyframes toastIn {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }

    .toast {
        animation: toastIn 300ms ease-out;
        transition: opacity 300ms ease-in;
    }

    .toast.leaving {
        opacity: 0;
    }
</style>
