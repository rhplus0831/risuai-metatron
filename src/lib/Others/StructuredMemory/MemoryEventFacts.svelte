<script lang="ts">
    import { language } from "src/lang";
    import type { MemoryRunEventView } from "src/ts/process/structuredMemory.svelte";
    import { codeText } from "./memoryText";

    /** Event changes stay plain text, with optional titles falling back to ids and unverified quotes marked. */
    interface Props {
        event: MemoryRunEventView;
        pageTitles?: ReadonlyMap<string, string> | null;
        threadTitles?: ReadonlyMap<string, string> | null;
    }

    let { event, pageTitles, threadTitles }: Props = $props();

    const text = language.structuredMemory.log;
    const receiptText = language.structuredMemory.receipt;
    const pageTitle = (id: string) => pageTitles?.get(id) ?? id;
    const threadTitle = (id: string) => threadTitles?.get(id) ?? id;
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

{#if event.stateChanges.length > 0}
    <h3 class="font-semibold">{text.stateChanges}</h3>
    {#each event.stateChanges as change}
        <p>{pageTitle(change.pageId)} / {change.section}: {change.before} → {change.after}</p>
        {@render quote(change.quote, change.unverified)}
    {/each}
{/if}
{#if event.knowledge.length > 0}
    <h3 class="font-semibold">{text.knowledge}</h3>
    {#each event.knowledge as item}
        <p>{pageTitle(item.pageId)} ({codeText(text.stances, item.stance)}): {item.fact}</p>
        {#if item.knowers.length > 0}
            <p>{text.knowers}: {item.knowers.map(pageTitle).join(", ")}</p>
        {/if}
        {@render quote(item.quote, item.unverified)}
    {/each}
{/if}
{#if event.relationshipShifts.length > 0}
    <h3 class="font-semibold">{text.relationshipShifts}</h3>
    {#each event.relationshipShifts as shift}
        <p>{pageTitle(shift.from)} → {pageTitle(shift.to)}: {shift.direction}{shift.note ? ` (${shift.note})` : ""}</p>
    {/each}
{/if}
{#if event.threads.added.length + event.threads.closed.length + event.threads.moved.length > 0}
    <h3 class="font-semibold">{text.threads}</h3>
    {#each event.threads.added as thread}
        <p>
            {text.threadAdded}: {thread.title}{thread.who.length > 0
                ? ` (${thread.who.map(pageTitle).join(", ")})`
                : ""}
        </p>
    {/each}
    {#each event.threads.closed as thread}
        <p>{text.threadClosed}: {threadTitle(thread)}</p>
    {/each}
    {#each event.threads.moved as move}
        <p>{threadTitle(move.threadId)} → {move.to}</p>
    {/each}
{/if}
