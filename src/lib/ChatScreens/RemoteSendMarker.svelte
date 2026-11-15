<script lang="ts">
    import { language } from "src/lang";
    import { generationClientId } from "src/ts/network/generationJobs";
    import { connectedClients, hostTargets } from "src/ts/network/handoff";
    import { hostMode } from "src/ts/network/remoteHost";
    import { remoteSend, remoteSendHost } from "src/ts/network/remoteSend";

    const selfId = generationClientId();
    const connected = $derived(hostTargets($connectedClients, selfId).some((host) => host.name === $remoteSendHost));
</script>

{#if $remoteSend && !$hostMode}
    <div class="chat-screen-content-width px-4 mb-2 text-xs text-textcolor2 break-words" role="status">
        {(connected
            ? language.serverJob.remoteSend.marker.connected
            : language.serverJob.remoteSend.marker.disconnected
        ).replace("{host}", () => $remoteSendHost || language.serverJob.remoteSend.unnamed)}
    </div>
{/if}
