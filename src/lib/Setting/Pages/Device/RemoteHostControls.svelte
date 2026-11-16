<script lang="ts">
    import { language } from "src/lang";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import { generationClientId } from "src/ts/network/generationJobs";
    import { connectedClients, hostTargets } from "src/ts/network/handoff";
    import { hostReloadPending, requestHostReload } from "src/ts/network/remoteHost";
    import { remoteSend, remoteSendHost, remoteSendFallback } from "src/ts/network/remoteSend";

    /**
     * The sending side of remote host: the switch, the host this browser sends through, and the
     * fallback. The host is chosen from the connected ones and remembered by name
     * (`remoteSendHost`). A remembered name that no connected host carries keeps its own row, so the
     * choice stays visible and can be cleared while that host is away. The empty name is both "none
     * chosen" and an unnamed host's name, so it gets no such row.
     */

    const selfId = generationClientId();
    const hosts = $derived(hostTargets($connectedClients, selfId));
    const awayHost = $derived(
        $remoteSendHost !== "" && !hosts.some((host) => host.name === $remoteSendHost) ? $remoteSendHost : null,
    );
    const rowButton = "shrink-0 rounded-md border border-darkborderc px-2 py-1 hover:bg-darkbutton";
</script>

<div class="flex flex-col gap-2 mt-4 text-textcolor">
    <CheckInput bind:check={$remoteSend} name={language.serverJob.remoteSend.settings.enabled} />
    <p class="text-sm text-textcolor2">{language.serverJob.remoteSend.settings.help}</p>
    <p class="mt-2">{language.serverJob.remoteSend.settings.hosts}</p>
    {#if hosts.length > 0 || awayHost !== null}
        <ul class="flex flex-col gap-2">
            {#each hosts as host (host.name)}
                <li
                    class="flex flex-wrap items-center gap-2 border border-darkborderc rounded-md px-3 py-2"
                    class:bg-darkbutton={$remoteSendHost === host.name}
                >
                    <span class="min-w-0 grow break-words">
                        {(host.count > 1
                            ? language.serverJob.remoteSend.settings.hostTabs
                            : language.serverJob.remoteSend.settings.host
                        ).replace(/\{(name|count)\}/g, (_, field) =>
                            field === "name" ? host.name || language.serverJob.remoteSend.unnamed : String(host.count),
                        )}
                    </span>
                    <button
                        type="button"
                        class={rowButton}
                        aria-pressed={$remoteSendHost === host.name}
                        onclick={() => ($remoteSendHost = host.name)}
                    >
                        {language.serverJob.remoteSend.settings.useHost}
                    </button>
                    <button
                        type="button"
                        class="{rowButton} disabled:opacity-50"
                        disabled={$hostReloadPending.has(host.clientId)}
                        onclick={() => requestHostReload(host)}
                    >
                        {$hostReloadPending.has(host.clientId)
                            ? language.serverJob.remoteHost.reloadPending
                            : language.serverJob.remoteHost.reload}
                    </button>
                </li>
            {/each}
            {#if awayHost !== null}
                <li
                    class="flex flex-wrap items-center gap-2 border border-darkborderc rounded-md px-3 py-2 bg-darkbutton"
                    data-away-host
                >
                    <span class="min-w-0 grow break-words">
                        {language.serverJob.remoteSend.settings.offlineHost.replace("{name}", () => awayHost)}
                    </span>
                    <button type="button" class={rowButton} onclick={() => ($remoteSendHost = "")}>
                        {language.serverJob.remoteSend.settings.clearHost}
                    </button>
                </li>
            {/if}
        </ul>
    {:else}
        <p class="text-sm text-textcolor2">{language.serverJob.remoteSend.settings.noHosts}</p>
    {/if}
    <p class="text-sm text-textcolor2">{language.serverJob.remoteSend.settings.hostHelp}</p>
    {#if hosts.length > 0}
        <p class="text-sm text-textcolor2">{language.serverJob.remoteHost.reloadHelp}</p>
    {/if}
    <CheckInput bind:check={$remoteSendFallback} name={language.serverJob.remoteSend.settings.fallback} />
    <p class="text-sm text-textcolor2">{language.serverJob.remoteSend.settings.fallbackHelp}</p>
</div>
