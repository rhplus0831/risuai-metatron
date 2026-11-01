<script lang="ts">
    import { ChevronDownIcon, ChevronRightIcon } from "@lucide/svelte";
    import { tick, untrack } from "svelte";
    import { language } from "src/lang";
    import {
        memoryEventView,
        memoryItemsUsed,
        memoryMessageIndexes,
        memoryTimelineRows,
        readStructuredMemoryContents,
        readStructuredMemoryCoverage,
        readStructuredMemoryRecord,
        type MemoryPanelTabProps,
        type MemoryPanelTarget,
        type MemoryRunEventView,
        type MemoryTimelineRow,
        type StructuredMemoryCoverage,
    } from "src/ts/process/structuredMemory.svelte";
    import { findChat, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import MemoryLinkButton from "./MemoryLinkButton.svelte";
    import { memoryReadFailureText, memoryReasonText } from "./memoryText";

    // The Timeline tab: the chat's events in the order of its messages as they stand. The coverage route
    // already answers each event's messages, status, and title at one revision, so the list reads no
    // record, and the rows follow the held messages with no request. Opening one reads its record, and
    // the page titles the first time a row opens after a refresh. Everything shown is plain text.

    let { chatRef, readOnly, refresh, focus, open, jump }: MemoryPanelTabProps = $props();

    /** The rows a list renders at once; a long chat stays cheap behind "show more". */
    const ROWS_AT_ONCE = 200;

    const text = language.structuredMemory.timeline;
    const logText = language.structuredMemory.log;
    const pagesText = language.structuredMemory.pages;
    const panelText = language.structuredMemory.panel;

    let facts = $state.raw<StructuredMemoryCoverage | null>(null);
    let failure = $state<string | null>(null);
    let readNumber = 0;

    let shown = $state(ROWS_AT_ONCE);
    /** The expanded event, one at a time, and its record once read. */
    let openId = $state<string | null>(null);
    let openEvent = $state.raw<MemoryRunEventView | null>(null);
    let openFailure = $state<string | null>(null);
    let openNumber = 0;
    /** Page titles by id; null until read, and a failed read leaves the ids. */
    let pageTitles = $state.raw<ReadonlyMap<string, string> | null>(null);
    /** The `refresh` the titles were last read at. */
    let titlesRead: number | null = null;
    let titlesNumber = 0;
    let list = $state<HTMLElement>();

    const messages = $derived(findChat(chatRef)?.message ?? []);
    const rows = $derived(facts ? memoryTimelineRows(facts.events, messages) : []);
    const usedEvents = $derived(memoryItemsUsed(messages, "event"));
    const messageIndexes = $derived(memoryMessageIndexes(messages));

    const sameChat = (ref: ChatRef) => ref.chaId === chatRef.chaId && ref.chatId === chatRef.chatId;

    /** Reads the facts. An answer for another chat, or one a newer read replaced, changes nothing. */
    async function read() {
        const ref = chatRef;
        const number = ++readNumber;
        const result = await readStructuredMemoryCoverage(ref);
        if (number !== readNumber || !sameChat(ref)) {
            return;
        }
        if (result.outcome === "ok") {
            facts = result.value;
            failure = null;
        } else {
            failure = memoryReadFailureText(result);
        }
    }

    async function readTitles() {
        const ref = chatRef;
        const number = ++titlesNumber;
        const result = await readStructuredMemoryContents(ref);
        if (number === titlesNumber && result.outcome === "ok" && sameChat(ref)) {
            pageTitles = new Map(result.value.pages.map(({ id, title }) => [id, title]));
        }
    }

    async function readOpen(id: string) {
        if (titlesRead !== refresh) {
            titlesRead = refresh;
            void readTitles();
        }
        const ref = chatRef;
        const number = ++openNumber;
        const result = await readStructuredMemoryRecord(ref, "events", id);
        if (number !== openNumber || !sameChat(ref)) {
            return;
        }
        if (result.outcome === "ok") {
            openEvent = memoryEventView(result.value.data);
            openFailure = null;
        } else {
            openEvent = null;
            openFailure = memoryReadFailureText(result);
        }
    }

    $effect(() => {
        refresh;
        untrack(() => {
            void read();
            if (openId !== null) {
                void readOpen(openId);
            }
        });
    });

    function openRow(id: string) {
        openId = id;
        openEvent = null;
        openFailure = null;
        void readOpen(id);
    }

    function toggle(id: string) {
        if (openId === id) {
            openNumber += 1;
            openId = null;
        } else {
            openRow(id);
        }
    }

    // The event a jump from another tab asked for: open, past "show more", and in view. The rows come
    // after the mount, so this waits for them, and once it has shown its event no later rows run it.
    let focused: MemoryPanelTarget | null = null;
    $effect(() => {
        const target = focus;
        if (!target || target === focused) {
            return;
        }
        const index = rows.findIndex(({ event }) => event.id === target.id);
        if (index < 0) {
            return;
        }
        focused = target;
        untrack(() => {
            shown = Math.max(shown, index + 1);
            openRow(target.id);
            void tick().then(() => {
                const row = [...(list?.querySelectorAll<HTMLElement>("[data-memory-event]") ?? [])].find(
                    ({ dataset }) => dataset.memoryEvent === target.id,
                );
                row?.scrollIntoView?.({ block: "nearest" });
            });
        });
    });
</script>

{#snippet details({ event }: MemoryTimelineRow)}
    <div class="flex flex-col gap-1 p-2 border-t border-darkborderc">
        {#if openFailure !== null}
            <p role="alert" class="text-draculared">{openFailure}</p>
        {:else if !openEvent}
            <p class="text-textcolor2">{panelText.loading}</p>
        {:else}
            <p class="whitespace-pre-wrap">{openEvent.summary}</p>
            {#if openEvent.storyTime.text !== ""}
                <p>
                    {logText.storyTime}: {openEvent.storyTime.text}{openEvent.storyTime.ordinal === undefined
                        ? ""
                        : ` (${openEvent.storyTime.ordinal})`}
                </p>
            {/if}
            {#if openEvent.participants.length > 0}
                <div class="flex flex-wrap items-center gap-1">
                    <span class="text-textcolor2">{logText.participants}</span>
                    {#each openEvent.participants as id}
                        <MemoryLinkButton
                            label={pageTitles?.get(id) ?? id}
                            disabled={pageTitles !== null && !pageTitles.has(id)}
                            onclick={() => open({ tab: "pages", id })}
                            data-memory-participant={id}
                        />
                    {/each}
                </div>
            {/if}
            {#if openEvent.keyLines.length > 0}
                <h3 class="font-semibold">{logText.keyLines}</h3>
                {#each openEvent.keyLines as line}
                    {#if line.speaker !== ""}
                        <p>{line.speaker}</p>
                    {/if}
                    <blockquote
                        class="pl-2 border-l-2 whitespace-pre-wrap break-words border-darkborderc text-textcolor2"
                    >
                        {line.text}
                    </blockquote>
                {/each}
            {/if}
        {/if}
        {#if event.messageIds.length > 0}
            <div class="flex flex-wrap items-center gap-1">
                <span class="text-textcolor2">{text.sources}</span>
                {#each event.messageIds as id}
                    {@const index = messageIndexes.get(id)}
                    <MemoryLinkButton
                        label={index === undefined ? pagesText.messageGone : `#${index}`}
                        disabled={index === undefined}
                        onclick={() => jump(id)}
                        data-memory-source={id}
                    />
                {/each}
            </div>
        {/if}
    </div>
{/snippet}

<div class="flex flex-col min-w-0 gap-2 text-sm" data-memory-timeline data-read-only={readOnly}>
    {#if failure !== null}
        <p role="alert" class="text-draculared" data-memory-panel-failure>{failure}</p>
    {:else if !facts}
        <p class="text-textcolor2">{panelText.loading}</p>
    {:else if rows.length === 0}
        <p class="text-textcolor2">{text.empty}</p>
    {:else}
        <ul class="flex flex-col min-w-0 gap-2" bind:this={list}>
            {#each rows.slice(0, shown) as row (row.event.id)}
                {@const { event, turnsAgo } = row}
                {@const expanded = openId === event.id}
                <li
                    class="flex flex-col min-w-0 border rounded-md border-darkborderc break-words"
                    data-memory-event={event.id}
                    data-memory-event-status={event.status}
                >
                    <button
                        type="button"
                        class="flex items-start min-w-0 gap-2 p-2 text-left transition-colors hover:bg-selected"
                        aria-expanded={expanded}
                        onclick={() => toggle(event.id)}
                    >
                        {#if expanded}
                            <ChevronDownIcon size={16} class="shrink-0 mt-0.5" />
                        {:else}
                            <ChevronRightIcon size={16} class="shrink-0 mt-0.5" />
                        {/if}
                        <span class="flex flex-col flex-1 min-w-0">
                            <span class={event.status === "retracted" ? "line-through text-textcolor2" : ""}>
                                {event.title}
                            </span>
                            <span class="flex flex-wrap gap-x-2 text-textcolor2">
                                {#if turnsAgo !== null}
                                    <span>{text.turnsAgo(turnsAgo)}</span>
                                {/if}
                                {#if event.status === "stale"}
                                    <span class="text-draculared" data-memory-event-badge="stale">
                                        {text.stale(memoryReasonText(event.staleReason))}
                                    </span>
                                {/if}
                                {#if event.suppressed}
                                    <span data-memory-event-badge="suppressed">{text.suppressed}</span>
                                {/if}
                                {#if usedEvents.has(event.id)}
                                    <span class="px-1.5 rounded-sm bg-darkbutton text-secondary-500" data-memory-used
                                        >{panelText.usedInLastSend}</span
                                    >
                                {/if}
                            </span>
                        </span>
                    </button>
                    {#if expanded}
                        {@render details(row)}
                    {/if}
                </li>
            {/each}
        </ul>
        {#if rows.length > shown}
            <button
                type="button"
                class="self-start px-2 py-1 my-1 transition-colors border rounded-md border-darkborderc text-textcolor2 hover:text-textcolor"
                onclick={() => (shown += ROWS_AT_ONCE)}
            >
                {panelText.showMore(rows.length - shown)}
            </button>
        {/if}
    {/if}
</div>
