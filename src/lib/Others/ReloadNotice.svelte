<script lang="ts">
    import { language } from "src/lang";
    import { dismissReloadNotice, reloadNotice } from "../../ts/alert";
    import { exportDrafts, recoveryDrafts } from "../../ts/storage/recoveryDrafts.svelte";
    import Button from "../UI/GUI/Button.svelte";
    let draftsDismissed = $state(false);
    const showDrafts = $derived(!draftsDismissed && recoveryDrafts.entries.length > 0);
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
                <Button className="mt-4" onclick={exportDrafts}>{language.export}</Button>
                <Button className="mt-4" onclick={() => (draftsDismissed = true)}
                    >{language.resourceNoticeDismiss}</Button
                >
            {/if}
        </div>
    </div>
{/if}
