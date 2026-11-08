<script lang="ts">
    import { language } from "src/lang";
    import { dismissReloadNotice, reloadNotice } from "../../ts/alert";
    import { recoveryDrafts } from "../../ts/storage/recoveryDrafts.svelte";
    import RecoveryDrafts from "./RecoveryDrafts.svelte";
    import Button from "../UI/GUI/Button.svelte";

    /**
     * Shows the save-conflict notice opened by src/ts/storage/resourceSync.svelte.ts through
     * src/ts/alert.ts, plus a recovery-draft reminder from src/ts/storage/recoveryDrafts.svelte.ts.
     * Dismiss clears the conflict store; the draft reminder's own dismissal lasts for this component
     * lifetime and leaves drafts intact. Review opens RecoveryDrafts and hides its reminder while open.
     * The z-60 status panel sits above the z-50 alert overlay without making the page inert or
     * trapping focus. Its controls stop keydown, keyup and keypress propagation so they cannot answer
     * an underlying alert through src/ts/hotkey.ts; earlier capture listeners still see those keys.
     */

    let draftsDismissed = $state(false);
    const showDrafts = $derived(!draftsDismissed && !recoveryDrafts.isOpen && recoveryDrafts.entries.length > 0);
</script>

<!-- Conflict and draft notices stay above the alert overlay and dismiss independently. Not modal. -->
{#if $reloadNotice !== null || showDrafts}
    <div
        class="fixed top-2 left-1/2 -translate-x-1/2 z-[60] w-max max-w-[calc(100%-1rem)] bg-darkbg border border-darkborderc p-4 break-any rounded-md flex flex-col shadow-lg"
        role="status"
        aria-live="polite"
    >
        <!-- A key on these buttons stays here: Enter would otherwise reach `hotkey.ts`, which answers the
             alert underneath (an `alertConfirm` would resolve as yes). -->
        <div
            class="flex flex-col"
            role="presentation"
            onkeydown={(event) => event.stopPropagation()}
            onkeyup={(event) => event.stopPropagation()}
            onkeypress={(event) => event.stopPropagation()}
        >
            {#if $reloadNotice !== null}
                <span class="text-textcolor whitespace-pre-wrap">{$reloadNotice}</span>
                <Button className="mt-4" onclick={dismissReloadNotice}>{language.resourceNoticeDismiss}</Button>
            {/if}
            {#if showDrafts}
                <span class="text-textcolor whitespace-pre-wrap">{language.resourceRecoveryDrafts}</span>
                <Button className="mt-4" onclick={() => recoveryDrafts.open()}>{language.recoveryDrafts.review}</Button>
                <Button className="mt-4" onclick={() => (draftsDismissed = true)}
                    >{language.resourceNoticeDismiss}</Button
                >
            {/if}
        </div>
    </div>
{/if}

{#if recoveryDrafts.isOpen}
    <RecoveryDrafts />
{/if}
