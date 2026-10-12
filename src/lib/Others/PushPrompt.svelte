<script lang="ts">
    import { untrack } from "svelte";
    import { language } from "src/lang";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import {
        declinePushPrompt,
        enablePushOnThisBrowser,
        pushBrowserState,
        reconcilePush,
    } from "src/ts/network/pushNotifications";

    // The one-time question per browser (`docs/plan/web-push.md`): while the synced switch is on and
    // this browser was never asked. Either button answers it for good.
    const open = $derived(
        settings.ui.notification &&
            $pushBrowserState.availability === "ok" &&
            $pushBrowserState.permission === "default" &&
            !$pushBrowserState.optedOut &&
            !$pushBrowserState.promptDismissed,
    );

    // The switch turned on (here or on another device): register an already permitted browser.
    $effect(() => {
        if (settings.ui.notification) {
            untrack(() => void reconcilePush());
        }
    });
</script>

{#if open}
    <div
        class="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-md bg-darkbg border border-darkborderc rounded-md p-4 flex flex-col gap-3 shadow-lg"
        role="dialog"
        aria-labelledby="push-prompt-text"
    >
        <span id="push-prompt-text" class="text-textcolor text-sm">{language.pushNotifications.promptText}</span>
        <div class="flex gap-2 justify-end flex-wrap">
            <Button styled="outlined" size="sm" onclick={declinePushPrompt}>
                {language.pushNotifications.promptLater}
            </Button>
            <Button
                size="sm"
                onclick={() => {
                    // Inside the click: the permission request is its first step.
                    void enablePushOnThisBrowser();
                }}
            >
                {language.pushNotifications.promptAccept}
            </Button>
        </div>
    </div>
{/if}
