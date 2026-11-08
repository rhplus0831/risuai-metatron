<script lang="ts">
    import { acknowledgeTerminalNotice, terminalNotice } from "../../ts/alert";
    import Button from "../UI/GUI/Button.svelte";

    /**
     * Shows src/ts/alert.ts's terminal notice, opened by src/ts/storage/resourceSync.svelte.ts when
     * restored server data requires a reload. showModal places it in the browser's top layer above
     * every z-index, focuses OK and makes the page behind it inert. Only OK acknowledges the notice;
     * the save adapter resumes its reload sequence after that promise settles.
     * Escape is cancelled and a browser close reopens the dialog while the notice remains. Key
     * events stop here before bubbling to page handlers, and repeated/composing Enter cannot activate
     * OK; capture listeners may already have observed the event.
     */

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
            // No key reaches the page's own listeners behind the notice (a panel's Escape or Enter).
            event.stopPropagation();
            // A held or composing Enter (the composer had focus) does not acknowledge it.
            if (event.key === "Enter" && (event.repeat || event.isComposing)) {
                event.preventDefault();
            }
        }}
        onkeyup={(event) => event.stopPropagation()}
        onkeypress={(event) => event.stopPropagation()}
    >
        <div class="flex flex-col">
            <span id="terminal-notice-message" class="text-textcolor whitespace-pre-wrap">{$terminalNotice}</span>
            <Button className="mt-4" onclick={acknowledgeTerminalNotice}>OK</Button>
        </div>
    </dialog>
{/if}
