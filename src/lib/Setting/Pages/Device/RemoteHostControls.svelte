<script lang="ts">
    import { language } from "src/lang";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import { generationClientId } from "src/ts/network/generationJobs";
    import { connectedClients, hostTargets } from "src/ts/network/handoff";
    import { hostMode, hostReloadPending, requestHostReload } from "src/ts/network/remoteHost";
    import { remoteSend, remoteSendHost, remoteSendFallback } from "src/ts/network/remoteSend";

    const selfId = generationClientId();
    const hosts = $derived(hostTargets($connectedClients, selfId));
</script>

<div class="flex flex-col gap-2 mt-4 text-textcolor">
    <CheckInput bind:check={$hostMode} name={language.serverJob.remoteHost.label} />
    <p class="text-sm text-textcolor2">{language.serverJob.remoteHost.help}</p>
</div>

<section class="flex flex-col gap-2 mt-4 text-textcolor">
    <h3 class="m-0 text-base font-medium">{language.serverJob.remoteSend.settings.title}</h3>
    <p class="text-sm text-textcolor2">{language.serverJob.remoteSend.settings.connectedHosts}</p>
    {#if hosts.length > 0}
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
                        class="shrink-0 rounded-md border border-darkborderc px-2 py-1 hover:bg-darkbutton"
                        aria-pressed={$remoteSendHost === host.name}
                        onclick={() => ($remoteSendHost = host.name)}
                    >
                        {language.serverJob.remoteSend.settings.useHost}
                    </button>
                    <button
                        type="button"
                        class="shrink-0 rounded-md border border-darkborderc px-2 py-1 hover:bg-darkbutton disabled:opacity-50"
                        disabled={$hostReloadPending.has(host.clientId)}
                        onclick={() => requestHostReload(host)}
                    >
                        {$hostReloadPending.has(host.clientId)
                            ? language.serverJob.remoteHost.reloadPending
                            : language.serverJob.remoteHost.reload}
                    </button>
                </li>
            {/each}
        </ul>
        <p class="text-sm text-textcolor2">{language.serverJob.remoteHost.reloadHelp}</p>
    {:else}
        <p class="text-sm text-textcolor2">{language.serverJob.remoteSend.settings.noHosts}</p>
    {/if}
    <CheckInput bind:check={$remoteSend} name={language.serverJob.remoteSend.settings.enabled} />
    <p class="text-sm text-textcolor2">{language.serverJob.remoteSend.settings.help}</p>
    <label class="flex flex-col gap-1">
        <span>{language.serverJob.remoteSend.settings.hostName}</span>
        <input
            type="text"
            maxlength="64"
            bind:value={$remoteSendHost}
            class="bg-darkbg text-textcolor border border-darkborderc rounded-md px-3 py-2"
        />
        <span class="text-sm text-textcolor2">{language.serverJob.remoteSend.settings.hostHelp}</span>
    </label>
    <CheckInput bind:check={$remoteSendFallback} name={language.serverJob.remoteSend.settings.fallback} />
    <p class="text-sm text-textcolor2">{language.serverJob.remoteSend.settings.fallbackHelp}</p>
</section>
