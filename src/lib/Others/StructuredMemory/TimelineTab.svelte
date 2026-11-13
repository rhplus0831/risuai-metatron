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
        readStructuredMemoryStory,
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
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import {
        ADOPTED_WRITER_RUN,
        memoryAnchorState,
        memoryRerecordTarget,
        STRUCTURED_MEMORY_LIMITS,
        type StructuredMemoryCoverageEvent,
        type StructuredMemoryEdit,
        type StructuredMemoryStoryEvent,
    } from "../../../../shared/structuredMemory.ts";
    import MemoryEventFacts from "./MemoryEventFacts.svelte";
    import MemoryLinkButton from "./MemoryLinkButton.svelte";
    import { pressMemoryRecord } from "./memoryRecordPress";
    import { memoryReadFailureText, memoryReasonText } from "./memoryText";

    /**
     * Timeline reads server/src/routes/structuredMemory.ts's coverage answer, which already has each
     * event's message ids, status, and title at one revision; the initial titles view reads no individual
     * record. The view choice lasts while mounted. Story reads summaries once per refresh when chosen,
     * joining them by id with the coverage rows and leaving out retracted events. Missing summaries or
     * a failed story read leave the titles visible; coverage and story can come from different revisions.
     * Rows use `reconcileMemoryCoverage` and `memoryTimelineRows` in src/ts/process/structuredMemory.svelte.ts
     * over held messages, with a per-mount hash memo. An unloaded chat leaves the facts unreconciled.
     * Storage sequence is not message order, especially after backfill. Opening an event reads its record
     * and reads page and thread titles once per refresh. All model and message text stays plain;
     * `ADOPTED_WRITER_RUN` identifies HypaV3 adoption without a model call.
     *
     * Repairs name the coverage revision and reread whether accepted or refused: a record answer alone
     * cannot replace a status derived from held messages. Keep sends the held anchor state; an unsaved
     * local edit can therefore be refused `changed`. Retract asks first because no control reverses it.
     * Re-record marks before pressing through `memoryRerecordTarget`; an existing mark goes straight to
     * the press, so a failed press remains retryable.
     * Text edits and mark releases also reread the open record and the chosen story view; a hidden
     * story is invalidated for the next switch. The mark is held beside the display view. A draft keeps
     * its base title and summary: a read that changes either closes it with `changed`, and selecting
     * another event or closing the event discards it. All writes share the repair's send guard.
     */

    let { chatRef, readOnly, refresh, focus, open, jump }: MemoryPanelTabProps = $props();

    /** The rows a list renders at once; a long chat stays cheap behind "show more". */
    const ROWS_AT_ONCE = 200;
    const { eventTitleChars, eventSummaryChars } = STRUCTURED_MEMORY_LIMITS;

    const text = language.structuredMemory.timeline;
    const logText = language.structuredMemory.log;
    const pagesText = language.structuredMemory.pages;
    const panelText = language.structuredMemory.panel;
    const repairText = text.repairs;

    /** The route's answer, whose `revision` the next edit or repair names. */
    let facts = $state.raw<StructuredMemoryCoverage | null>(null);
    let failure = $state<string | null>(null);
    let readNumber = 0;
    let view = $state<"titles" | "story">("titles");
    let stories = $state.raw<ReadonlyMap<string, StructuredMemoryStoryEvent>>(new Map());
    let storyFailure = $state<string | null>(null);
    /** The `refresh` the story was last read at, including a failed read. */
    let storyRead: number | null = null;
    let storyNumber = 0;
    /** One edit or repair at a time: while one is out the buttons are off. */
    let sending = $state(false);

    let shown = $state(ROWS_AT_ONCE);
    /** The expanded event, one at a time, and its record once read. */
    let openId = $state<string | null>(null);
    let openEvent = $state.raw<MemoryRunEventView | null>(null);
    let openCorrected = $state(false);
    let openRetracted = $state(false);
    let openFailure = $state<string | null>(null);
    let openNumber = 0;
    /** The stored text the draft opened on, kept apart from its editable values. */
    let editor = $state.raw<{ id: string; title: string; summary: string } | null>(null);
    let draftTitle = $state("");
    let draftSummary = $state("");
    /** Page and thread titles by id; null until read, and a failed read leaves the ids. */
    let pageTitles = $state.raw<ReadonlyMap<string, string> | null>(null);
    let threadTitles = $state.raw<ReadonlyMap<string, string> | null>(null);
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
    const visibleRows = $derived(view === "story" ? rows.filter(({ event }) => event.status !== "retracted") : rows);
    const usedEvents = $derived(memoryItemsUsed(messages, "event"));
    const messageIndexes = $derived(memoryMessageIndexes(messages));
    const controlsOff = $derived(readOnly || sending);
    const titleLength = $derived(draftTitle.trim().length);
    const draftFits = $derived(
        titleLength > 0 &&
            titleLength <= eventTitleChars &&
            draftSummary.trim() !== "" &&
            draftSummary.length <= eventSummaryChars,
    );

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
            threadTitles = new Map(result.value.threads.map(({ id, title }) => [id, title]));
        }
    }

    /** A story failure keeps the coverage rows readable as titles. Only the newest read can fill them. */
    async function readStory() {
        const ref = chatRef;
        const number = ++storyNumber;
        const result = await readStructuredMemoryStory(ref);
        if (number !== storyNumber || !sameChat(ref)) {
            return;
        }
        if (result.outcome === "ok") {
            stories = new Map(result.value.events.map((event) => [event.id, event]));
            storyFailure = null;
        } else {
            stories = new Map();
            storyFailure = memoryReadFailureText(result);
        }
    }

    async function readOpen(id: string, noticed = false) {
        if (titlesRead !== refresh) {
            titlesRead = refresh;
            void readTitles();
        }
        const ref = chatRef;
        const number = ++openNumber;
        const result = await readStructuredMemoryRecord(ref, "events", id);
        if (number !== openNumber || !sameChat(ref) || openId !== id) {
            return;
        }
        if (result.outcome === "ok") {
            const event = result.value.data;
            openEvent = memoryEventView(event);
            openCorrected = event.userCorrected === true;
            openRetracted = event.status === "retracted";
            openFailure = null;
            if (editor && (editor.title !== event.title || editor.summary !== event.summary || openRetracted)) {
                editor = null;
                if (!noticed) {
                    alertError(memoryReadFailureText({ outcome: "refused", reason: "changed" }));
                }
            }
        } else {
            openEvent = null;
            openCorrected = false;
            openRetracted = false;
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

    $effect(() => {
        const atRefresh = refresh;
        if (view !== "story") {
            return;
        }
        untrack(() => {
            if (storyRead !== atRefresh) {
                storyRead = atRefresh;
                void readStory();
            }
        });
    });

    function storyTimeText({ text, ordinal }: StructuredMemoryStoryEvent["storyTime"]): string {
        return text + (ordinal === undefined ? "" : ` (${ordinal})`);
    }

    function openRow(id: string) {
        editor = null;
        openId = id;
        openEvent = null;
        openCorrected = false;
        openRetracted = false;
        openFailure = null;
        void readOpen(id);
    }

    function toggle(id: string) {
        if (openId === id) {
            editor = null;
            openNumber += 1;
            openId = null;
        } else {
            openRow(id);
        }
    }

    /** Runs one edit's or repair's steps, none while the panel is read-only or another is out. */
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
    async function sendRepair(edit: Extract<StructuredMemoryEdit, { kind: "event" }>, ref = chatRef): Promise<boolean> {
        if (!facts) {
            return false;
        }
        const result = await editStructuredMemory(ref, facts.revision, edit);
        if (result.outcome === "failed" || (result.outcome === "refused" && result.reason !== "epoch")) {
            alertError(memoryReadFailureText(result));
        }
        if (sameChat(ref)) {
            await read();
        }
        return result.outcome === "ok";
    }

    /** Refreshes every text-bearing read after either outcome; only the currently open id is reread. */
    async function sendTextEdit(edit: Extract<StructuredMemoryEdit, { kind: "eventText" | "eventRelease" }>) {
        if (!facts) {
            return;
        }
        const ref = chatRef;
        // A record read already in flight may have been answered before this edit.
        openNumber += 1;
        const result = await editStructuredMemory(ref, facts.revision, edit);
        if (result.outcome === "failed" || (result.outcome === "refused" && result.reason !== "epoch")) {
            alertError(memoryReadFailureText(result));
        }
        if (!sameChat(ref)) {
            return;
        }
        if (result.outcome === "ok" && edit.kind === "eventText" && editor?.id === edit.eventId) {
            editor = null;
        }
        const reads = [read()];
        if (openId !== null) {
            reads.push(readOpen(openId, result.outcome === "refused" && result.reason === "changed"));
        }
        if (view === "story") {
            storyRead = refresh;
            reads.push(readStory());
        } else {
            storyRead = null;
            storyNumber += 1;
            stories = new Map();
            storyFailure = null;
        }
        await Promise.all(reads);
    }

    function startEdit() {
        if (!openEvent || openId === null || openRetracted || controlsOff || editor) {
            return;
        }
        const { title, summary } = openEvent;
        editor = { id: openId, title, summary };
        draftTitle = title;
        draftSummary = summary;
    }

    function saveText() {
        if (!editor || !draftFits || openRetracted) {
            return;
        }
        const edit = { kind: "eventText", eventId: editor.id, title: draftTitle, summary: draftSummary } as const;
        return repairing(() => sendTextEdit(edit));
    }

    function releaseText() {
        if (openId === null || !openEvent || !openCorrected) {
            return;
        }
        const ref = chatRef;
        const id = openId;
        const title = openEvent.title;
        return repairing(async () => {
            if ((await alertConfirm(text.releaseConfirm(title))) && sameChat(ref) && openId === id && !readOnly) {
                await sendTextEdit({ kind: "eventRelease", eventId: id });
            }
        });
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
        const ref = chatRef;
        return repairing(async () => {
            if (await alertConfirm(repairText.retractConfirm)) {
                await sendRepair({ kind: "event", eventId: id, repair: "retract" }, ref);
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
        const index = visibleRows.findIndex(({ event }) => event.id === target.id);
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
            <div class="flex flex-wrap items-center gap-2">
                {#if openCorrected}
                    <button
                        type="button"
                        class="px-1.5 rounded-sm bg-darkbutton text-textcolor2 enabled:hover:text-textcolor enabled:cursor-pointer"
                        disabled={controlsOff}
                        title={text.release}
                        data-memory-event-corrected
                        onclick={releaseText}
                    >
                        {text.userCorrected}
                    </button>
                {/if}
                {#if event.status !== "retracted" && !openRetracted}
                    <Button size="sm" styled="outlined" disabled={controlsOff || editor !== null} onclick={startEdit}>
                        <span data-memory-event-edit>{text.edit}</span>
                    </Button>
                {/if}
            </div>
            {#if editor?.id === event.id}
                <fieldset class="flex flex-col min-w-0 gap-2" disabled={controlsOff} data-memory-event-editor>
                    <label class="flex flex-col min-w-0 gap-1" data-memory-event-title>
                        <span class="text-textcolor2">{text.title}</span>
                        <TextInput size="sm" bind:value={draftTitle} disabled={controlsOff} fullwidth />
                    </label>
                    <span
                        class={titleLength > eventTitleChars ? "text-draculared" : "text-textcolor2"}
                        data-memory-event-title-count
                    >
                        {text.characters(titleLength, eventTitleChars)}
                    </span>
                    <label class="flex flex-col min-w-0 gap-1" data-memory-event-summary-input>
                        <span class="text-textcolor2">{text.summary}</span>
                        <TextAreaInput
                            bind:value={draftSummary}
                            height="36"
                            optimaizedInput={false}
                            popupEditor={false}
                            ariaLabel={text.summary}
                        />
                    </label>
                    <span
                        class={draftSummary.length > eventSummaryChars ? "text-draculared" : "text-textcolor2"}
                        data-memory-event-summary-count
                    >
                        {text.characters(draftSummary.length, eventSummaryChars)}
                    </span>
                    <div class="flex flex-wrap justify-end gap-2">
                        <Button size="sm" styled="outlined" disabled={controlsOff} onclick={() => (editor = null)}>
                            <span data-memory-event-cancel>{text.cancel}</span>
                        </Button>
                        <Button size="sm" disabled={controlsOff || !draftFits} onclick={saveText}>
                            <span data-memory-event-save>{text.save}</span>
                        </Button>
                    </div>
                </fieldset>
            {:else}
                <p class="whitespace-pre-wrap">{openEvent.summary}</p>
            {/if}
            {#if openEvent.writerRun === ADOPTED_WRITER_RUN}
                <p class="text-textcolor2" data-memory-event-adopted>{language.structuredMemory.adopt.adoptedEvent}</p>
            {/if}
            {#if openEvent.storyTime.text !== ""}
                <p>
                    {logText.storyTime}: {storyTimeText(openEvent.storyTime)}
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
            <MemoryEventFacts event={openEvent} {pageTitles} {threadTitles} />
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
    <SegmentedControl
        bind:value={view}
        options={[
            { value: "titles", label: text.views.titles },
            { value: "story", label: text.views.story },
        ]}
        margin={false}
        size="sm"
        label={text.view}
    />
    {#if view === "story" && storyFailure !== null && failure === null}
        <p role="alert" class="text-draculared" data-memory-panel-failure>{storyFailure}</p>
    {/if}
    {#if failure !== null}
        <p role="alert" class="text-draculared" data-memory-panel-failure>{failure}</p>
    {:else if !facts}
        <p class="text-textcolor2">{panelText.loading}</p>
    {:else if visibleRows.length === 0}
        <p class="text-textcolor2">{text.empty}</p>
    {:else}
        <ul class="flex flex-col min-w-0 gap-2" bind:this={list}>
            {#each visibleRows.slice(0, shown) as row (row.event.id)}
                {@const { event, turnsAgo } = row}
                {@const expanded = openId === event.id}
                {@const story = view === "story" ? stories.get(event.id) : undefined}
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
                            {#if story && story.storyTime.text !== ""}
                                <span class="text-textcolor2">
                                    {logText.storyTime}: {storyTimeText(story.storyTime)}
                                </span>
                            {/if}
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
                            {#if story?.summary}
                                <span class="whitespace-pre-wrap break-words" data-memory-event-summary>
                                    {story.summary}
                                </span>
                            {/if}
                        </span>
                    </button>
                    {#if expanded}
                        {@render details(row)}
                    {/if}
                </li>
            {/each}
        </ul>
        {#if visibleRows.length > shown}
            <button
                type="button"
                class="self-start px-2 py-1 my-1 transition-colors border rounded-md border-darkborderc text-textcolor2 hover:text-textcolor"
                onclick={() => (shown += ROWS_AT_ONCE)}
            >
                {panelText.showMore(visibleRows.length - shown)}
            </button>
        {/if}
    {/if}
</div>
