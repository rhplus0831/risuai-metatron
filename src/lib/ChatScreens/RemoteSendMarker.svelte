<script lang="ts">
    import { MonitorOffIcon, MonitorUpIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { generationClientId } from "src/ts/network/generationJobs";
    import { connectedClients, hostTargets } from "src/ts/network/handoff";
    import { hostMode } from "src/ts/network/remoteHost";
    import { remoteSend, remoteSendHost } from "src/ts/network/remoteSend";
    import type { SettingHit } from "src/ts/setting/searchIndex";
    import { openSetting } from "src/ts/setting/settingJump.svelte";
    import { DEVICE_LINK_SETTINGS_MENU } from "src/ts/settingsMenu";

    /**
     * The remote send marker, on the left of the line above the composer row it shares with the
     * health badge and the context meter's chip. It shows the chosen host's name, and names the
     * state in words only while that host is away; the whole sentence is the button's name and
     * tooltip. Pressing it opens the remote host section of Settings → Device Link, where the host
     * is chosen.
     */

    const selfId = generationClientId();
    const connected = $derived(hostTargets($connectedClients, selfId).some((host) => host.name === $remoteSendHost));
    const host = $derived($remoteSendHost || language.serverJob.remoteSend.unnamed);
    const sentence = $derived(
        (connected
            ? language.serverJob.remoteSend.marker.connected
            : language.serverJob.remoteSend.marker.disconnected
        ).replace("{host}", () => host),
    );

    function openSettings() {
        openSetting({
            kind: "section",
            id: "deviceLink.remoteHost",
            label: language.deviceLink.remoteHostSection,
            breadcrumb: [language.deviceLink.title],
            target: { menu: DEVICE_LINK_SETTINGS_MENU, sectionId: "deviceLink.remoteHost" },
            // The section's first item (the remote send switch) has no condition.
            available: true,
            score: 0,
        } satisfies SettingHit);
    }
</script>

{#if $remoteSend && !$hostMode}
    <!-- The small basis keeps the marker on the meter's line while a truncated name still fits. It takes the line's
         free space first (the large grow factor) but only up to its content, so the meter keeps the rest. Only this
         element is the live region: the meter beside it changes with every keystroke. -->
    <div
        class="mb-1 ml-3 flex max-w-max min-w-0 grow-[999] {connected ? 'basis-16' : 'basis-36'}"
        role="status"
        data-remote-send-marker={connected ? "connected" : "disconnected"}
    >
        <button
            type="button"
            class="flex max-w-full min-w-0 items-center gap-1 rounded-sm px-1 text-xs leading-5 whitespace-nowrap hover:underline"
            class:text-textcolor2={connected}
            class:text-danger-500={!connected}
            title={sentence}
            onclick={openSettings}
        >
            <span class="sr-only">{sentence}</span>
            <span class="shrink-0" aria-hidden="true">
                {#if connected}
                    <MonitorUpIcon size={13} />
                {:else}
                    <MonitorOffIcon size={13} />
                {/if}
            </span>
            <span class="min-w-0 truncate" aria-hidden="true" data-remote-send-marker-host>{host}</span>
            {#if !connected}
                <span class="shrink-0" aria-hidden="true" data-remote-send-marker-state
                    >· {language.serverJob.remoteSend.marker.offline}</span
                >
            {/if}
        </button>
    </div>
{/if}
