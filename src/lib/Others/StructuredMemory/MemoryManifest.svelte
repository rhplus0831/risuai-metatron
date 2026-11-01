<script lang="ts">
    import { CheckIcon, CircleAlertIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { memoryItemKey } from "src/ts/process/structuredMemory.svelte";
    import type { ContextReport } from "../../../../shared/contextReport.ts";
    import { memoryReasonText } from "./memoryText";

    // What a send's report says of its memory: the writer, the included records, the candidates left
    // out, and each lane's spend. The context meter's popover and the Preview tab both show it. A report
    // names records by id, so the caller reads their titles; a row without one still shows. A report
    // can repeat an id, since an event can be in two lanes, so no list here is keyed by id.

    interface Props {
        memory: NonNullable<ContextReport["memory"]>;
        /** Titles by `memoryItemKey`. */
        titles: ReadonlyMap<string, string>;
    }

    let { memory, titles }: Props = $props();

    const text = language.structuredMemory.manifest;

    const items = $derived(memory.items ?? []);
    const excluded = $derived(memory.excluded ?? []);
    const lanes = $derived(memory.lanes ?? []);
    const excludedMore = $derived(Math.max(0, (memory.excludedTotal ?? 0) - excluded.length));

    const fmt = (value: number) => value.toLocaleString();
</script>

<div class="flex flex-col gap-2 text-xs" data-memory-manifest>
    {#if memory.writer}
        <div class="flex flex-wrap justify-between gap-x-2" data-memory-manifest-writer={memory.writer.state}>
            <span class="text-textcolor2">{text.writer}</span>
            <span class="min-w-0 text-right break-words">
                {text.writerStates[memory.writer.state]}{memory.writer.reason === undefined
                    ? ""
                    : `: ${memoryReasonText(memory.writer.reason)}`}
            </span>
        </div>
    {/if}

    <div class="flex flex-col gap-0.5">
        <span class="font-semibold">{text.included}</span>
        {#if items.length === 0}
            <span class="text-textcolor2">{text.noneIncluded}</span>
        {:else}
            <ul class="flex flex-col gap-0.5">
                {#each items as item, index (index)}
                    {@const title = titles.get(memoryItemKey(item))}
                    <li class="flex min-w-0 items-center gap-2" data-memory-manifest-item={item.lane}>
                        <span class="min-w-0 grow truncate" {title}>{title ?? ""}</span>
                        <span class="shrink-0 text-textcolor2">{text.lanes[item.lane]}</span>
                        <span class="shrink-0 tabular-nums text-textcolor2"
                            >{language.contextUsage.tokens(fmt(item.tokens))}</span
                        >
                        {#if item.verified}
                            <span
                                class="shrink-0 text-secondary-500"
                                title={text.verified}
                                data-memory-manifest-verified="true"
                            >
                                <CheckIcon size={12} aria-label={text.verified} />
                            </span>
                        {:else}
                            <span
                                class="shrink-0 text-danger-500"
                                title={text.notVerified}
                                data-memory-manifest-verified="false"
                            >
                                <CircleAlertIcon size={12} aria-label={text.notVerified} />
                            </span>
                        {/if}
                    </li>
                {/each}
            </ul>
        {/if}
    </div>

    {#if excluded.length > 0}
        <div class="flex flex-col gap-0.5">
            <span class="font-semibold">{text.leftOut}</span>
            <ul class="flex flex-col gap-0.5">
                {#each excluded as entry, index (index)}
                    {@const title = titles.get(memoryItemKey(entry))}
                    <li class="flex min-w-0 items-center gap-2" data-memory-manifest-excluded={entry.reason}>
                        <span class="min-w-0 grow truncate" {title}>{title ?? ""}</span>
                        <span class="shrink-0 text-textcolor2">{text.lanes[entry.lane]}</span>
                        <span class="shrink-0 text-textcolor2">{text.exclusions[entry.reason]}</span>
                        {#if entry.staleReason !== undefined}
                            {@const reason = memoryReasonText(entry.staleReason)}
                            <span
                                class="min-w-0 truncate text-textcolor2"
                                title={reason}
                                data-memory-manifest-stale-reason={entry.staleReason}>{reason}</span
                            >
                        {/if}
                    </li>
                {/each}
                {#if excludedMore > 0}
                    <li class="text-textcolor2" data-memory-manifest-excluded-more>{text.leftOutMore(excludedMore)}</li>
                {/if}
            </ul>
        </div>
    {/if}

    {#if lanes.length > 0}
        <div class="flex flex-col gap-0.5">
            <span class="font-semibold">{text.lanesTitle}</span>
            <ul class="flex flex-col gap-0.5">
                {#each lanes as lane, index (index)}
                    <li class="flex justify-between gap-2" data-memory-manifest-lane={lane.lane}>
                        <span class="text-textcolor2">{text.lanes[lane.lane]}</span>
                        <!-- The flow lane has no token target: its own is the largest safe integer. -->
                        <span class="tabular-nums"
                            >{lane.target === Number.MAX_SAFE_INTEGER
                                ? fmt(lane.spent)
                                : `${fmt(lane.spent)} / ${fmt(lane.target)}`}</span
                        >
                    </li>
                {/each}
            </ul>
        </div>
    {/if}
</div>
