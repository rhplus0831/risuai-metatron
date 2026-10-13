<script lang="ts">
    import { ChevronDownIcon, ChevronUpIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { getFetchLogs } from "src/ts/globalApi.svelte";
    import Button from "../../UI/GUI/Button.svelte";
    import LogField from "./LogField.svelte";

    /**
     * This tab's own request log (`fetchLog`, in memory until the tab closes, newest first): the
     * fetches this browser made itself (a plugin provider, WebLLM, the auxiliary fetches) and the
     * `log` events of the tab's server requests.
     */
    const logs = getFetchLogs();

    let expanded: Set<number> = $state(new Set());
    const allExpanded = $derived(logs.length > 0 && expanded.size === logs.length);

    function toggle(index: number) {
        const next = new Set(expanded);
        if (next.has(index)) {
            next.delete(index);
        } else {
            next.add(index);
        }
        expanded = next;
    }
</script>

<div class="flex justify-end mb-3">
    <Button
        size="sm"
        onclick={() => {
            expanded = allExpanded ? new Set() : new Set(logs.map((_, i) => i));
        }}
    >
        {allExpanded ? language.collapseAll : language.expandAll}
    </Button>
</div>
{#if logs.length === 0}
    <div class="text-textcolor2 text-center py-8">{language.noRequestLogs}</div>
{:else}
    <div class="flex flex-col gap-2">
        {#each logs as log, i}
            {@const isExpanded = expanded.has(i)}
            <div class="border border-darkborderc rounded-lg overflow-hidden">
                <button
                    class="w-full flex items-center justify-between p-3 hover:bg-bgcolor/50 transition-colors"
                    onclick={() => toggle(i)}
                >
                    <div class="flex items-center gap-3 min-w-0 flex-1">
                        <span
                            class="px-2 py-1 rounded text-xs font-bold font-mono {log.success
                                ? 'bg-success-600 text-neutral-50'
                                : 'bg-danger-600 text-neutral-50'}"
                        >
                            {log.status ??
                                (log.success ? language.requestHistoryLabels.ok : language.requestHistoryLabels.failed)}
                        </span>
                        <span class="text-textcolor text-sm truncate flex-1 text-left font-mono" title={log.url}>
                            {log.url}
                        </span>
                        <span class="text-textcolor text-xs whitespace-nowrap opacity-70">{log.date}</span>
                    </div>
                    <div class="ml-2 text-textcolor">
                        {#if isExpanded}
                            <ChevronUpIcon size={20} />
                        {:else}
                            <ChevronDownIcon size={20} />
                        {/if}
                    </div>
                </button>
                {#if isExpanded}
                    <div class="border-t border-darkborderc p-4 bg-bgcolor/30">
                        <div class="space-y-4">
                            <LogField label={language.requestHistoryLabels.url} text={log.url} highlight={false} />
                            <LogField label={language.requestHistoryLabels.requestBody} text={log.body} />
                            <LogField
                                label={language.requestHistoryLabels.requestHeader}
                                text={log.header}
                                sizeClass="max-h-32"
                            />
                            <LogField
                                label={language.requestHistoryLabels.response}
                                text={log.response}
                                sizeClass="max-h-64"
                            />
                        </div>
                    </div>
                {/if}
            </div>
        {/each}
    </div>
{/if}
