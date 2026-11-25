<script lang="ts">
    import { ArrowRightLeft } from "@lucide/svelte";
    import { language } from "src/lang";
    import { generationClientId } from "src/ts/network/generationJobs";
    import { connectedClients, handoffTargets, handOffJob } from "src/ts/network/handoff";
    import { viewingJobs } from "src/ts/process/serverCommands";

    let { jobIds, height }: { jobIds: readonly string[]; height: string } = $props();
    const selfId = generationClientId();
    const menuId = $props.id();
    let open = $state(false);
    let container = $state<HTMLDivElement>();
    let button = $state<HTMLButtonElement>();
    const targets = $derived(handoffTargets($connectedClients, selfId));
    const viewerIds = $derived(jobIds.filter((id) => $viewingJobs.has(id)));

    function handOff(target: string, ids: readonly string[]) {
        open = false;
        button?.focus();
        for (const id of ids) void handOffJob(id, target);
    }

    function dismissOutside(event: Event) {
        if (event.target instanceof Node && !container?.contains(event.target)) open = false;
    }
</script>

<svelte:window
    onclick={dismissOutside}
    onfocusin={dismissOutside}
    onkeydown={(event) => {
        if (open && event.key === "Escape") {
            open = false;
            button?.focus();
        }
    }}
/>

{#if jobIds.length > 0 && (targets.length > 0 || viewerIds.length > 0)}
    <div class="relative flex" bind:this={container}>
        <button
            bind:this={button}
            type="button"
            aria-label={language.serverJob.handoff.controls}
            title={language.serverJob.handoff.controls}
            aria-expanded={open}
            aria-controls={menuId}
            class="flex justify-center border-y border-darkborderc items-center text-textcolor p-3 hover:bg-darkbutton transition-colors"
            style:height
            onclick={() => (open = !open)}
        >
            <ArrowRightLeft size={20} />
        </button>
        {#if open}
            <div
                id={menuId}
                class="absolute right-0 bottom-full mb-2 z-40 flex flex-col w-max max-w-[min(20rem,calc(100vw-2rem))] max-h-64 overflow-y-auto p-1 bg-darkbg text-textcolor border border-darkborderc rounded-md shadow-lg"
            >
                {#if viewerIds.length > 0}
                    <button
                        type="button"
                        class="px-3 py-2 text-left rounded hover:bg-darkbutton"
                        onclick={() => handOff(selfId, viewerIds)}
                    >
                        {language.serverJob.handoff.takeBack}
                    </button>
                {/if}
                {#each targets as target (target.name)}
                    <button
                        type="button"
                        class="px-3 py-2 text-left break-words rounded hover:bg-darkbutton"
                        onclick={() => handOff(target.clientId, jobIds)}
                    >
                        {(target.count > 1
                            ? language.serverJob.handoff.handOffToTabs
                            : language.serverJob.handoff.handOffTo
                        ).replace(/\{(name|count)\}/g, (_, field) =>
                            field === "name" ? target.name || language.serverJob.handoff.unnamed : String(target.count),
                        )}
                    </button>
                {/each}
            </div>
        {/if}
    </div>
{/if}
