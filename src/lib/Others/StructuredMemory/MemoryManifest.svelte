<script lang="ts">
    import { CheckIcon, CircleAlertIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { memoryItemKey } from "src/ts/process/structuredMemory.svelte";
    import type { ContextMemoryWriter, ContextReport } from "../../../../shared/contextReport.ts";
    import { memoryReasonText } from "./memoryText";

    /**
     * The Preview tab and src/lib/ChatScreens/ContextMeter.svelte share this view of a
     * send's report: writer, included items, exclusions, and lane spend. The caller resolves titles by
     * `memoryItemKey` in src/ts/process/structuredMemory.svelte.ts; missing titles never hide rows.
     * An event can occur in two lanes, so a list must not be keyed by id. Flow has no token target:
     * `Number.MAX_SAFE_INTEGER` is shown as spend alone.
     */

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

    /** The writer's reason: one of the writer's own codes, else a stored code of another kind. */
    function writerReasonText({ reason }: ContextMemoryWriter): string {
        if (reason === undefined) {
            return "";
        }
        return Object.hasOwn(text.writerReasons, reason) ? text.writerReasons[reason] : memoryReasonText(reason);
    }
</script>

<div class="flex flex-col gap-2 text-xs" data-memory-manifest>
    {#if memory.writer}
        <div class="flex flex-wrap justify-between gap-x-2" data-memory-manifest-writer={memory.writer.state}>
            <span class="text-textcolor2">{text.writer}</span>
            <span class="min-w-0 text-right break-words">
                {text.writerStates[memory.writer.state]}{memory.writer.reason === undefined
                    ? ""
                    : `: ${writerReasonText(memory.writer)}`}
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
