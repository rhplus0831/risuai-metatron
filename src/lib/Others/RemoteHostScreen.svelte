<script lang="ts">
    import { language } from "src/lang";
    import { feedConnected } from "src/ts/network/eventFeed";
    import { generationClientId } from "src/ts/network/generationJobs";
    import { clientName } from "src/ts/network/handoff";
    import { hostCommandLog, hostMode } from "src/ts/network/remoteHost";
    import { runningGenerations } from "src/ts/process/generationProgress.svelte";
    import { safeBootOff } from "src/ts/safeBoot";
    import { characterList } from "src/ts/storage/characterStore.svelte";
    import { alertStore } from "src/ts/stores.svelte";

    const clientId = generationClientId();
    const pluginsOff = safeBootOff("plugins");
    const hasDialogs = $derived($alertStore && alertStore.hasDialogs());
    const jobs = $derived.by(() => {
        const characters = characterList();
        return runningGenerations()
            .filter((entry) => entry.clientId === clientId)
            .map((entry) => ({
                ...entry,
                name: characters.find((character) => character.chaId === entry.characterId)?.name || entry.characterId,
            }));
    });
</script>

<!-- Covers plugin full-screen containers (1000), while alerts (1100) remain answerable.
     The data attributes are read by util/headlessHost.mjs. -->
<section
    class="fixed inset-0 z-1050 overflow-y-auto bg-bgcolor text-textcolor"
    aria-labelledby="remote-host-title"
    data-remote-host-screen
    data-feed-connected={$feedConnected ? "true" : "false"}
    data-dialogs={hasDialogs ? "true" : "false"}
    data-plugins-off={pluginsOff ? "true" : "false"}
>
    <div class="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center gap-6 p-6">
        <h1 id="remote-host-title" class="text-2xl font-bold">{language.serverJob.remoteHost.title}</h1>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border border-darkborderc bg-darkbg p-4">
            <dt class="text-textcolor2">{language.deviceLink.name}</dt>
            <dd class="break-any">{$clientName}</dd>
            <dt class="text-textcolor2">{language.serverJob.remoteHost.connection}</dt>
            <dd aria-live="polite">
                {$feedConnected ? language.serverJob.remoteHost.connected : language.serverJob.remoteHost.disconnected}
            </dd>
        </dl>
        <section aria-labelledby="remote-host-jobs">
            <h2 id="remote-host-jobs" class="mb-2 font-semibold">{language.serverJob.remoteHost.runningJobs}</h2>
            {#if jobs.length === 0}
                <p class="text-sm text-textcolor2">{language.serverJob.remoteHost.noJobs}</p>
            {:else}
                <ul class="max-h-60 overflow-y-auto rounded-md border border-darkborderc bg-darkbg">
                    {#each jobs as job (job.jobId)}
                        <li class="border-b border-darkborderc p-3 last:border-b-0">
                            <span class="break-any">{job.name}</span>
                            {#if job.stage}
                                <span class="ml-2 text-sm text-textcolor2"
                                    >{language.serverJob.stopOther.stages[job.stage]}</span
                                >
                            {/if}
                        </li>
                    {/each}
                </ul>
            {/if}
        </section>
        <section aria-labelledby="remote-host-commands">
            <h2 id="remote-host-commands" class="mb-2 font-semibold">{language.serverJob.remoteHost.recentCommands}</h2>
            {#if $hostCommandLog.length === 0}
                <p class="text-sm text-textcolor2">{language.serverJob.remoteHost.noCommands}</p>
            {:else}
                <ul class="max-h-60 overflow-y-auto rounded-md border border-darkborderc bg-darkbg">
                    {#each $hostCommandLog as command (command.commandId)}
                        <li
                            class="flex flex-wrap gap-x-3 gap-y-1 border-b border-darkborderc p-3 last:border-b-0"
                            data-command-id={command.commandId}
                            data-command-type={command.type}
                            data-command-state={command.state}
                            data-command-code={command.code || undefined}
                        >
                            <span class="break-any">{command.type}</span>
                            <span class="break-any text-sm text-textcolor2">{command.commandId}</span>
                            <span class="text-sm">{command.state}</span>
                            {#if command.code}
                                <span class="text-sm text-textcolor2">{command.code}</span>
                            {/if}
                        </li>
                    {/each}
                </ul>
            {/if}
        </section>
        {#if hasDialogs}
            <p role="status" class="rounded-md border border-darkborderc bg-darkbg p-3">
                {language.serverJob.remoteHost.waitingDialogs}
            </p>
        {/if}
        <p class="text-sm text-textcolor2">{language.serverJob.remoteHost.lockHelp}</p>
        <button
            type="button"
            class="self-start rounded-md border border-darkborderc bg-darkbg px-4 py-2 text-textcolor hover:bg-bgcolor"
            onclick={() => hostMode.set(false)}
        >
            {language.serverJob.remoteHost.leave}
        </button>
    </div>
</section>
{#if $alertStore.type !== "none" && $alertStore.type !== "toast"}
    <!-- An alert or a status overlay (1100) covers the control above, and a `wait` or `progress` one has no
         button of its own: this copy stays above that layer, so the mode is one click from leaving. -->
    <button
        type="button"
        data-remote-host-leave-over-alert
        class="fixed right-3 top-3 z-1110 rounded-md border border-darkborderc bg-darkbg px-4 py-2 text-textcolor hover:bg-bgcolor"
        onclick={() => hostMode.set(false)}
    >
        {language.serverJob.remoteHost.leave}
    </button>
{/if}
