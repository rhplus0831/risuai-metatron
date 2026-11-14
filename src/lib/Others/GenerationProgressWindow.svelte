<script lang="ts">
    import { onMount } from "svelte";
    import { ChevronDownIcon, ChevronUpIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { openPinnedChat } from "src/ts/globalApi.svelte";
    import { connectedClients } from "src/ts/network/handoff";
    import { generationClientId } from "src/ts/network/generationJobs";
    import {
        generationElapsedMs,
        generationSamples,
        generationServerNow,
        generationTokensPerSecond,
        runningGenerations,
    } from "src/ts/process/generationProgress.svelte";
    import { findCharacter } from "src/ts/storage/characterStore.svelte";
    import { chatEntry, currentChatRef } from "src/ts/storage/chatStore.svelte";
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import type { GenerationProgressEntry } from "../../../shared/events.ts";

    /**
     * Shows while `generationProgressWindow` is on and at least one non-preview job is running.
     * Rows put the selected chat first, then sort by `startedAt` ascending. Each shows locally known
     * character and chat names (or generic labels), stage, elapsed time, and any retry, sequence,
     * other-device name, output token count, and speed. A row opens its chat through `openPinnedChat`;
     * there is no Stop button here.
     *
     * `memoryProgressShown` moves this window below the memory pill so the two never overlap.
     * Collapsed state lives only in component memory and starts collapsed below 768 px at mount.
     */
    let { memoryProgressShown = false }: { memoryProgressShown?: boolean } = $props();
    let collapsed = $state(false);
    let now = $state(Date.now());
    const clientId = generationClientId();

    onMount(() => {
        collapsed = window.innerWidth < 768;
    });

    const listed = $derived.by(() => {
        const selected = currentChatRef();
        const isSelected = (entry: GenerationProgressEntry) =>
            entry.characterId === selected?.chaId && entry.chatId === selected?.chatId;
        return runningGenerations()
            .filter((entry) => entry.kind !== "preview" && entry.kind !== "previewPrompt")
            .sort((a, b) => Number(isSelected(b)) - Number(isSelected(a)) || a.startedAt - b.startedAt);
    });
    const shown = $derived(settings.ui.generationProgressWindow && listed.length > 0);
    const serverNow = $derived(generationServerNow(now));

    $effect(() => {
        if (!shown) return;
        now = Date.now();
        const timer = setInterval(() => (now = Date.now()), 1000);
        return () => clearInterval(timer);
    });

    function elapsed(entry: GenerationProgressEntry): string {
        const seconds = Math.floor(generationElapsedMs(entry, serverNow) / 1000);
        const minutes = Math.floor(seconds / 60);
        const tail = String(seconds % 60).padStart(2, "0");
        return minutes < 60
            ? `${minutes}:${tail}`
            : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${tail}`;
    }
</script>

{#if shown}
    <aside
        aria-label={language.generationProgress.windowLabel}
        class="fixed right-4 z-40 max-w-[calc(100vw-2rem)] border border-darkborderc bg-darkbg text-textcolor shadow-lg {collapsed
            ? 'rounded-full'
            : 'rounded-lg'} {memoryProgressShown ? 'top-[4.5rem]' : 'top-4'}"
    >
        {#if collapsed}
            <button
                type="button"
                class="flex items-center gap-2 rounded-full px-3 py-2 text-sm hover:bg-darkbutton"
                aria-label={language.generationProgress.expand}
                aria-expanded="false"
                onclick={() => (collapsed = false)}
            >
                <span>{language.generationProgress.jobs.replace("{count}", () => String(listed.length))}</span>
                <span class="tabular-nums text-textcolor2">{elapsed(listed[0])}</span>
                <ChevronDownIcon size={16} />
            </button>
        {:else}
            <div class="w-72 max-w-full">
                <div class="flex items-center justify-between gap-2 border-b border-darkborderc px-3 py-2">
                    <span class="text-sm"
                        >{language.generationProgress.jobs.replace("{count}", () => String(listed.length))}</span
                    >
                    <button
                        type="button"
                        class="rounded p-1 text-textcolor2 hover:bg-darkbutton hover:text-textcolor"
                        aria-label={language.generationProgress.collapse}
                        aria-expanded="true"
                        onclick={() => (collapsed = true)}
                    >
                        <ChevronUpIcon size={16} />
                    </button>
                </div>
                <div class="max-h-[min(24rem,calc(100dvh-8rem))] overflow-y-auto">
                    {#each listed as entry (entry.jobId)}
                        {@const ref = { chaId: entry.characterId, chatId: entry.chatId }}
                        {@const speed = generationTokensPerSecond(generationSamples(entry.jobId))}
                        <button
                            type="button"
                            class="flex w-full flex-col gap-1 border-b border-darkborderc px-3 py-2 text-left last:border-b-0 hover:bg-darkbutton"
                            onclick={() => openPinnedChat(ref)}
                        >
                            <span class="w-full truncate text-sm"
                                >{findCharacter(entry.characterId)?.name || language.generationProgress.character}</span
                            >
                            <span class="w-full truncate text-xs text-textcolor2"
                                >{chatEntry(ref)?.name || language.generationProgress.chat}</span
                            >
                            <span class="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-textcolor2">
                                {#if entry.stage}
                                    <span>{language.serverJob.stopOther.stages[entry.stage]}</span>
                                {/if}
                                <span class="tabular-nums">{elapsed(entry)}</span>
                                {#if entry.retry !== undefined}
                                    <span
                                        >{language.serverJob.retried.replace("{count}", () =>
                                            String(entry.retry),
                                        )}</span
                                    >
                                {/if}
                                {#if entry.sequence}
                                    <span class="tabular-nums">{entry.sequence.sent}/{entry.sequence.total}</span>
                                {/if}
                            </span>
                            {#if entry.clientId !== clientId}
                                <span class="w-full truncate text-xs text-textcolor2"
                                    >{$connectedClients.find((client) => client.clientId === entry.clientId)?.name ||
                                        language.generationProgress.anotherDevice}</span
                                >
                            {/if}
                            {#if entry.output}
                                <span class="flex flex-wrap gap-x-2 text-xs tabular-nums text-textcolor2">
                                    <span
                                        >{language.generationProgress.tokens.replace("{tokens}", () =>
                                            String(entry.output.tokens),
                                        )}</span
                                    >
                                    {#if speed !== null}
                                        <span>{speed.toFixed(1)} {language.generationProgress.tokensPerSecond}</span>
                                    {/if}
                                </span>
                            {/if}
                        </button>
                    {/each}
                </div>
            </div>
        {/if}
    </aside>
{/if}
