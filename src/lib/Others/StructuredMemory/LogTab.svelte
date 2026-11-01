<script lang="ts">
    import { ChevronDownIcon, ChevronRightIcon, DownloadIcon } from "@lucide/svelte";
    import { untrack } from "svelte";
    import { language } from "src/lang";
    import { alertError } from "src/ts/alert";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import {
        buildStructuredMemoryLog,
        memoryRunView,
        readStructuredMemoryRuns,
        type MemoryRunView,
    } from "src/ts/process/structuredMemory.svelte";
    import type { ChatRef } from "src/ts/storage/chatStore.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import type { StructuredMemoryLogRun } from "../../../../shared/structuredMemory.ts";
    import { codeText, memoryReadFailureText, memoryReasonText } from "./memoryText";

    // The Log tab: one row per writer run, newest first, a round at a time. A row expands to what the
    // run extracted, each item next to its quote, which is the point of the log: what the model said,
    // even where the records kept something else. A stored run is data of any shape, which
    // `memoryRunView` reads, and all of it is plain text.

    interface Props {
        chatRef: ChatRef;
        readOnly: boolean;
        refresh: number;
    }

    let { chatRef, readOnly, refresh }: Props = $props();

    const text = language.structuredMemory.log;
    const receiptText = language.structuredMemory.receipt;
    const warningKinds = language.structuredMemory.warningKinds;
    const unverifiedReasons = language.structuredMemory.unverifiedReasons;
    const panelText = language.structuredMemory.panel;

    let runs = $state.raw<StructuredMemoryLogRun[]>([]);
    let total = $state(0);
    let next = $state<number | null>(null);
    /** The revision of the list's first round, which every later round names. */
    let revision: string | undefined;
    let loaded = $state(false);
    let reading = $state(false);
    let failure = $state<string | null>(null);
    let exporting = $state(false);
    let expanded = $state.raw(new Set<string>());
    let readNumber = 0;

    const views = $derived(runs.map((run) => memoryRunView(run)));

    /**
     * Reads the round at `cursor`, after the runs in `held`. An answer for another chat, or one a newer
     * read replaced, changes nothing. A round that finds the memory moved on restarts the list.
     */
    async function readRound(cursor: number, held: readonly StructuredMemoryLogRun[], tiedTo: string | undefined) {
        const ref = chatRef;
        const number = ++readNumber;
        reading = true;
        const result = await readStructuredMemoryRuns(ref, cursor, tiedTo);
        if (number !== readNumber || ref.chaId !== chatRef.chaId || ref.chatId !== chatRef.chatId) {
            return;
        }
        if (result.outcome === "refused" && result.reason === "changed" && tiedTo !== undefined) {
            void readRound(0, [], undefined);
            return;
        }
        reading = false;
        loaded = true;
        if (result.outcome === "ok") {
            runs = [...held, ...result.value.runs];
            total = result.value.total;
            next = result.value.next;
            revision = result.value.revision;
            failure = null;
        } else {
            failure = memoryReadFailureText(result);
        }
    }

    $effect(() => {
        refresh;
        untrack(() => void readRound(0, [], undefined));
    });

    function toggle(id: string) {
        const open = new Set(expanded);
        if (!open.delete(id)) {
            open.add(id);
        }
        expanded = open;
    }

    async function exportLog() {
        exporting = true;
        try {
            const result = await buildStructuredMemoryLog(chatRef);
            if (result.outcome === "ok") {
                await downloadFile(result.value.name, result.value.bytes);
            } else if (result.outcome === "failed" || result.reason !== "epoch") {
                alertError(memoryReadFailureText(result));
            }
        } catch (error) {
            alertError(panelText.readFailed(error instanceof Error ? error.message : String(error)));
        } finally {
            exporting = false;
        }
    }

    function rangeText({ range }: MemoryRunView): string {
        return range ? text.range(range.first, range.last, range.count) : text.noMessages;
    }
</script>

{#snippet quote(quoted: string, unverified: boolean)}
    {#if quoted !== ""}
        <blockquote
            class="pl-2 border-l-2 whitespace-pre-wrap break-words border-darkborderc text-textcolor2"
            data-memory-quote={unverified ? "unverified" : undefined}
        >
            {quoted}
            {#if unverified}
                <span class="text-draculared">({receiptText.unverified})</span>
            {/if}
        </blockquote>
    {/if}
{/snippet}

{#snippet extraction(view: MemoryRunView)}
    {#if view.event}
        {@const event = view.event}
        <p class="font-semibold">{event.title}</p>
        <p class="whitespace-pre-wrap">{event.summary}</p>
        {#if event.storyTime.text !== ""}
            <p>
                {text.storyTime}: {event.storyTime.text}{event.storyTime.ordinal === undefined
                    ? ""
                    : ` (${event.storyTime.ordinal})`}
            </p>
        {/if}
        {#if event.participants.length > 0}
            <p>{text.participants}: {event.participants.join(", ")}</p>
        {/if}
        {#if event.keyLines.length > 0}
            <h3 class="font-semibold">{text.keyLines}</h3>
            {#each event.keyLines as line}
                {#if line.speaker !== ""}
                    <p>{line.speaker}</p>
                {/if}
                {@render quote(line.text, line.unverified)}
            {/each}
        {/if}
        {#if event.stateChanges.length > 0}
            <h3 class="font-semibold">{text.stateChanges}</h3>
            {#each event.stateChanges as change}
                <p>{change.pageId} / {change.section}: {change.before} → {change.after}</p>
                {@render quote(change.quote, change.unverified)}
            {/each}
        {/if}
        {#if event.knowledge.length > 0}
            <h3 class="font-semibold">{text.knowledge}</h3>
            {#each event.knowledge as item}
                <p>{item.pageId} ({codeText(text.stances, item.stance)}): {item.fact}</p>
                {#if item.knowers.length > 0}
                    <p>{text.knowers}: {item.knowers.join(", ")}</p>
                {/if}
                {@render quote(item.quote, item.unverified)}
            {/each}
        {/if}
        {#if event.relationshipShifts.length > 0}
            <h3 class="font-semibold">{text.relationshipShifts}</h3>
            {#each event.relationshipShifts as shift}
                <p>{shift.from} → {shift.to}: {shift.direction}{shift.note ? ` (${shift.note})` : ""}</p>
            {/each}
        {/if}
        {#if event.threads.added.length + event.threads.closed.length + event.threads.moved.length > 0}
            <h3 class="font-semibold">{text.threads}</h3>
            {#each event.threads.added as thread}
                <p>
                    {text.threadAdded}: {thread.title}{thread.who.length > 0 ? ` (${thread.who.join(", ")})` : ""}
                </p>
            {/each}
            {#each event.threads.closed as thread}
                <p>{text.threadClosed}: {thread}</p>
            {/each}
            {#each event.threads.moved as move}
                <p>{move.threadId} → {move.to}</p>
            {/each}
        {/if}
    {:else}
        <p class="text-textcolor2">{text.noExtraction}</p>
    {/if}
    {#if view.candidates.length > 0}
        <h3 class="font-semibold">{text.candidates}</h3>
        {#each view.candidates as candidate}
            <p>
                {candidate.created ? `${text.newPage}: ` : ""}{candidate.title}{candidate.pageType
                    ? ` (${candidate.pageType})`
                    : ""}{candidate.confidence === undefined ? "" : `, ${text.confidence}: ${candidate.confidence}`}
            </p>
            {#if candidate.reason !== ""}
                <p class="text-textcolor2">{candidate.reason}</p>
            {/if}
        {/each}
    {/if}
    {#if view.unverified.length > 0}
        <h3 class="font-semibold">{receiptText.unverified}</h3>
        {#each view.unverified as item}
            <p>
                {item.text}{item.reason ? ` (${codeText(unverifiedReasons, item.reason)})` : ""}
            </p>
        {/each}
    {/if}
    {#if view.warnings.length > 0}
        <h3 class="font-semibold">{receiptText.warnings}</h3>
        {#each view.warnings as warning}
            <p>{codeText(warningKinds, warning.kind)}{warning.detail ? `: ${warning.detail}` : ""}</p>
        {/each}
    {/if}
{/snippet}

<div class="flex flex-col min-w-0 gap-2 text-sm" data-memory-log data-read-only={readOnly}>
    {#if failure !== null}
        <p role="alert" class="text-draculared" data-memory-panel-failure>{failure}</p>
    {:else if !loaded}
        <p class="text-textcolor2">{panelText.loading}</p>
    {:else if views.length === 0}
        <p class="text-textcolor2">{text.empty}</p>
    {:else}
        <div class="flex items-center justify-between gap-2">
            <span class="text-textcolor2">{text.total(views.length, total)}</span>
            <Button size="sm" styled="outlined" disabled={exporting} onclick={exportLog}>
                <span class="flex items-center gap-1">
                    <DownloadIcon size={16} />
                    {text.export}
                </span>
            </Button>
        </div>
        <ul class="flex flex-col min-w-0 gap-2">
            {#each views as view (view.id)}
                {@const open = expanded.has(view.id)}
                <li
                    class="flex flex-col min-w-0 border rounded-md border-darkborderc break-words"
                    data-memory-run={view.result}
                >
                    <button
                        type="button"
                        class="flex items-start min-w-0 gap-2 p-2 text-left transition-colors hover:bg-selected"
                        aria-expanded={open}
                        onclick={() => toggle(view.id)}
                    >
                        {#if open}
                            <ChevronDownIcon size={16} class="shrink-0 mt-0.5" />
                        {:else}
                            <ChevronRightIcon size={16} class="shrink-0 mt-0.5" />
                        {/if}
                        <span class="flex flex-col flex-1 min-w-0">
                            <span class="flex flex-wrap gap-x-2">
                                <span class={view.result === "failed" ? "text-draculared" : ""}>
                                    {codeText(text.results, view.result)}
                                </span>
                                <span>{rangeText(view)}</span>
                            </span>
                            <span class="flex flex-wrap gap-x-2 text-textcolor2">
                                <span>{view.model ?? text.noModel}</span>
                                <span>{receiptText.tokens(view.inputTokens ?? 0, view.outputTokens ?? 0)}</span>
                                {#if view.durationMs !== undefined}
                                    <span>{text.seconds(view.durationMs)}</span>
                                {/if}
                            </span>
                            {#if view.reason !== undefined}
                                <span class="text-textcolor2">{memoryReasonText(view.reason)}</span>
                            {/if}
                            {#if view.error !== undefined}
                                <span class="text-draculared">{view.error}</span>
                            {/if}
                        </span>
                    </button>
                    {#if open}
                        <div class="flex flex-col gap-1 p-2 border-t border-darkborderc">
                            {@render extraction(view)}
                        </div>
                    {/if}
                </li>
            {/each}
        </ul>
        {#if next !== null}
            <div class="self-start">
                <Button size="sm" styled="outlined" disabled={reading} onclick={() => readRound(next, runs, revision)}>
                    {text.loadMore}
                </Button>
            </div>
        {/if}
    {/if}
</div>
