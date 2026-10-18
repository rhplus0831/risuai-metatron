<script lang="ts">
    import { dismissReloadNotice, reloadNotice } from "../../ts/alert";
    import Button from "../UI/GUI/Button.svelte";
</script>

<!-- The reload notice (a save conflict replaced a local change): above the alert overlay, so a
     later alert does not hide it, and shown until its own OK dismisses it. Not modal. -->
{#if $reloadNotice !== null}
    <div
        class="fixed top-2 left-1/2 -translate-x-1/2 z-[60] w-max max-w-[calc(100%-1rem)] bg-darkbg border border-darkborderc p-4 break-any rounded-md flex flex-col shadow-lg"
        role="status"
        aria-live="polite"
    >
        <span class="text-textcolor whitespace-pre-wrap">{$reloadNotice}</span>
        <!-- A key on its OK stays here: Enter would otherwise reach `hotkey.ts`, which answers the
             alert underneath (an `alertConfirm` would resolve as yes). -->
        <div
            class="flex flex-col"
            role="presentation"
            onkeydown={(event) => event.stopPropagation()}
            onkeyup={(event) => event.stopPropagation()}
            onkeypress={(event) => event.stopPropagation()}
        >
            <Button className="mt-4" onclick={dismissReloadNotice}>OK</Button>
        </div>
    </div>
{/if}
