<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { language } from "src/lang";
    import { alertError } from "src/ts/alert";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import {
        disablePushOnThisBrowser,
        enablePushOnThisBrowser,
        pushBrowserState,
        type PushBrowserState,
    } from "src/ts/network/pushNotifications";

    // `settings.ui.notification` is the synced switch (the server sends while it is on); the line
    // under it is this browser's own state.
    function statusText(state: PushBrowserState): string {
        const text = language.pushNotifications;
        switch (state.availability) {
            case "checking":
                return text.statusChecking;
            case "insecure":
                return text.statusInsecure;
            case "ios-home-screen":
                return text.statusIosHomeScreen;
            case "unsupported":
                return text.statusUnsupported;
            case "server-off":
                return text.statusServerOff;
        }
        if (state.permission === "denied") {
            return text.statusDenied;
        }
        if (state.subscribed) {
            return text.statusSubscribed;
        }
        return state.optedOut ? text.statusOptedOut : text.statusNotSubscribed;
    }

    /** Runs inside the click: the permission request is the first thing `enablePushOnThisBrowser` does. */
    function enableHere() {
        void enablePushOnThisBrowser().then((subscribed) => {
            const error = $pushBrowserState.error;
            if (!subscribed && error) {
                alertError(language.pushNotifications.failed(error));
            }
        });
    }

    function onSwitch(check: boolean) {
        if (!check) {
            return;
        }
        if ($pushBrowserState.availability === "ok") {
            if ($pushBrowserState.permission === "default" || !$pushBrowserState.subscribed) {
                enableHere();
            }
            return;
        }
        // No push here: the tab's own notifications still need the permission, asked inside this click.
        if (typeof Notification !== "undefined" && Notification.permission === "default") {
            void Notification.requestPermission()
                .then((permission) => {
                    pushBrowserState.update((state) => ({ ...state, permission }));
                    if (permission === "denied") {
                        alertError(language.permissionDenied);
                    }
                })
                .catch(() => {});
        }
    }
</script>

<div class="flex flex-col mt-2 gap-1">
    <Check bind:check={settings.ui.notification} name={language.notification} onChange={onSwitch} />
    <span class="text-textcolor2 text-sm">
        {language.pushNotifications.thisBrowser}: {statusText($pushBrowserState)}
    </span>
    {#if $pushBrowserState.error}
        <span class="text-draculared text-sm">{$pushBrowserState.error}</span>
    {/if}
    {#if $pushBrowserState.availability === "ok" && $pushBrowserState.permission !== "denied"}
        <div>
            {#if $pushBrowserState.subscribed}
                <Button
                    size="sm"
                    disabled={$pushBrowserState.busy}
                    onclick={() => {
                        void disablePushOnThisBrowser().then(() => {
                            const error = $pushBrowserState.error;
                            if (error) {
                                alertError(language.pushNotifications.disableFailed(error));
                            }
                        });
                    }}
                >
                    {language.pushNotifications.disableHere}
                </Button>
            {:else}
                <Button size="sm" disabled={$pushBrowserState.busy} onclick={enableHere}>
                    {language.pushNotifications.enableHere}
                </Button>
            {/if}
        </div>
    {/if}
</div>
