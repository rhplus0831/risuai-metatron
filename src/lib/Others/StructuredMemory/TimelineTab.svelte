<script lang="ts">
    import { ChevronDownIcon, ChevronRightIcon } from "@lucide/svelte";
    import { tick, untrack } from "svelte";
    import { language } from "src/lang";
    import { alertConfirm, alertError } from "src/ts/alert";
    import {
        editStructuredMemory,
        memoryEventView,
        memoryItemsUsed,
        memoryMessageHasher,
        memoryMessageIndexes,
        memoryTimelineRows,
        readStructuredMemoryContents,
        readStructuredMemoryCoverage,
        readStructuredMemoryRecord,
        reconcileMemoryCoverage,
        type MemoryPanelTabProps,
        type MemoryPanelTarget,
        type MemoryRunEventView,
        type MemoryTimelineRow,
        type StructuredMemoryCoverage,
    } from "src/ts/process/structuredMemory.svelte";
    import { characterList } from "src/ts/storage/characterStore.svelte";
    import { findChat, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import {
        ADOPTED_WRITER_RUN,
        memoryAnchorState,
        memoryRerecordTarget,
        type StructuredMemoryCoverageEvent,
        type StructuredMemoryEdit,
    } from "../../../../shared/structuredMemory.ts";
    import MemoryLinkButton from "./MemoryLinkButton.svelte";
    import { pressMemoryRecord } from "./memoryRecordPress";
    import { memoryReadFailureText, memoryReasonText } from "./memoryText";

    // The Timeline tab: the chat's events in the order of its messages as they stand. The coverage route
    // already answers each event's messages, status, and title at one revision, so the list reads no
    // record, and the rows follow the held messages with no request: a source that changes turns its
    // event stale here at once. Opening one reads its record, and the page titles the first time a row
    // opens after a refresh, and a stale row opened offers its repairs. Everything shown is plain text.

    let { chatRef, readOnly, refresh, focus, open, jump }: MemoryPanelTabProps = $props();

    /** The rows a list renders at once; a long chat stays cheap behind "show more". */
    const ROWS_AT_ONCE = 200;

    const text = language.structuredMemory.timeline;
    const logText = language.structuredMemory.log;
    const pagesText = language.structuredMemory.pages;
    const panelText = language.structuredMemory.panel;
    const repairText = text.repairs;

    /** The route's answer, whose `revision` the next repair names. */
    let facts = $state.raw<StructuredMemoryCoverage | null>(null);
    let failure = $state<string | null>(null);
    let readNumber = 0;
    /** One repair at a time: while one is out the buttons are off. */
    let sending = $state(false);

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

    const heldChat = $derived(findChat(chatRef));
    const messages = $derived(heldChat?.message ?? []);
    const hashOf = memoryMessageHasher();
    // With no chat held there is nothing to compare, which says nothing of its events.
    const reconciled = $derived(facts && heldChat ? reconcileMemoryCoverage(facts, messages, hashOf) : facts);
    const rows = $derived(reconciled ? memoryTimelineRows(reconciled.events, messages) : []);
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

    /** Runs one repair's steps, none while the panel is read-only or another is out. */
    async function repairing(steps: () => Promise<void>) {
        if (sending || readOnly) {
            return;
        }
        sending = true;
        try {
            await steps();
        } finally {
            sending = false;
        }
    }

    /**
     * Sends a repair, made on the copy read at `facts.revision`, and shows the notice for a refusal. Either
     * way the facts are read again: the status a row shows comes from the held messages joined with
     * them, so the answer's record alone says nothing, and the next repair needs their revision.
     */
    async function sendRepair(edit: Extract<StructuredMemoryEdit, { kind: "event" }>): Promise<boolean> {
        if (!facts) {
            return false;
        }
        const ref = chatRef;
        const result = await editStructuredMemory(ref, facts.revision, edit);
        if (result.outcome === "failed" || (result.outcome === "refused" && result.reason !== "epoch")) {
            alertError(memoryReadFailureText(result));
        }
        if (sameChat(ref)) {
            await read();
        }
        return result.outcome === "ok";
    }

    /** The old event stays until the new one commits, so a press that failed can simply be pressed again. */
    function rerecord(event: StructuredMemoryCoverageEvent) {
        return repairing(async () => {
            const ref = chatRef;
            const target = memoryRerecordTarget(event.sources, messages);
            const owner = characterList().find((entry) => entry?.chaId === ref.chaId);
            if (target === null || !owner) {
                return;
            }
            if (event.rerecord || (await sendRepair({ kind: "event", eventId: event.id, repair: "rerecord" }))) {
                await pressMemoryRecord(owner, ref, target);
            }
        });
    }

    /** Asks first, because no control takes it back. */
    function retract({ id }: StructuredMemoryCoverageEvent) {
        return repairing(async () => {
            if (await alertConfirm(repairText.retractConfirm)) {
                await sendRepair({ kind: "event", eventId: id, repair: "retract" });
            }
        });
    }

    /** Names the state the person is looking at, so the server keeps only that. */
    function keep({ id, sources }: StructuredMemoryCoverageEvent) {
        return repairing(async () => {
            const state = memoryAnchorState(sources, messages, hashOf);
            await sendRepair({ kind: "event", eventId: id, repair: "keep", state });
        });
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
            {#if openEvent.writerRun === ADOPTED_WRITER_RUN}
                <p class="text-textcolor2" data-memory-event-adopted>{language.structuredMemory.adopt.adoptedEvent}</p>
            {/if}
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
        {#if event.status === "stale"}
            {@const off = readOnly || sending}
            <div class="flex flex-wrap gap-2 pt-1" data-memory-event-repairs>
                <Button
                    size="sm"
                    styled="outlined"
                    disabled={off || memoryRerecordTarget(event.sources, messages) === null}
                    onclick={() => rerecord(event)}
                >
                    <span data-memory-repair="rerecord">{repairText.rerecord}</span>
                </Button>
                <Button size="sm" styled="outlined" disabled={off} onclick={() => retract(event)}>
                    <span data-memory-repair="retract">{repairText.retract}</span>
                </Button>
                <Button size="sm" styled="outlined" disabled={off} onclick={() => keep(event)}>
                    <span data-memory-repair="keep">{repairText.keep}</span>
                </Button>
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
                                {#if event.rerecord}
                                    <span data-memory-event-badge="rerecord">{repairText.waiting}</span>
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
