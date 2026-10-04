<script lang="ts">
    import { acknowledgeTerminalNotice, terminalNotice } from "../../ts/alert";
    import Button from "../UI/GUI/Button.svelte";

    let dialog = $state<HTMLDialogElement | null>(null);

    // A modal dialog sits in the top layer (above every z-index), keeps focus inside, and makes the
    // page behind it inert; opening it focuses OK.
    $effect(() => {
        if ($terminalNotice !== null && dialog && !dialog.open) {
            dialog.showModal();
        }
    });
</script>

<!-- The terminal notice (a restore): only its own OK acknowledges it. -->
{#if $terminalNotice !== null}
    <dialog
        bind:this={dialog}
        class="m-auto bg-darkbg p-4 break-any rounded-md max-w-3xl backdrop:bg-black/50"
        aria-labelledby="terminal-notice-message"
        oncancel={(event) => {
            // Escape does not acknowledge it.
            event.preventDefault();
        }}
        onclose={() => {
            // A browser may still close it (a repeated Escape): it stays until acknowledged.
            if ($terminalNotice !== null) {
                dialog?.showModal();
            }
        }}
        onkeydown={(event) => {
            // A held or composing Enter (the composer had focus) does not acknowledge it.
            if (event.key === "Enter" && (event.repeat || event.isComposing)) {
                event.preventDefault();
            }
        }}
    >
        <div class="flex flex-col">
            <span id="terminal-notice-message" class="text-textcolor whitespace-pre-wrap">{$terminalNotice}</span>
            <Button className="mt-4" onclick={acknowledgeTerminalNotice}>OK</Button>
        </div>
    </dialog>
{/if}
