<script lang="ts">
    import { ChevronDownIcon, ChevronRightIcon } from "@lucide/svelte";
    import { untrack } from "svelte";
    import { language } from "src/lang";
    import { alertError } from "src/ts/alert";
    import {
        editStructuredMemory,
        readStructuredMemoryContents,
        readStructuredMemoryRecord,
        type MemoryPanelTabProps,
    } from "src/ts/process/structuredMemory.svelte";
    import type { ChatRef } from "src/ts/storage/chatStore.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import {
        MEMORY_THREAD_STATES,
        memoryThreadEnded,
        type MemoryThread,
        type MemoryThreadState,
        type StructuredMemoryContentsAnswer,
    } from "../../../../shared/structuredMemory.ts";
    import MemoryLinkButton from "./MemoryLinkButton.svelte";
    import { codeText, memoryReadFailureText } from "./memoryText";

    /**
     * The contents answer supplies each thread's state; opening a row reads its `who`, `openedBy`, and
     * `closedBy`. Links use panel targets rather than retaining another tab's component. All text is plain.
     *
     * State edits through src/ts/process/structuredMemory.svelte.ts name the contents revision and apply
     * to this tab's copy first. Only one edit is in flight and no read replaces its copy meanwhile. A
     * refusal restores it and rereads; success keeps the server's state and next revision. Read-only
     * disables the controls before server/src/routes/structuredMemory.ts's write fence decides.
     */

    let { chatRef, readOnly, refresh, open }: MemoryPanelTabProps = $props();

    /** The rows a list renders at once; a long chat stays cheap behind "show more". */
    const ROWS_AT_ONCE = 200;

    const text = language.structuredMemory.threads;
    const panelText = language.structuredMemory.panel;

    /** The tab's copy of the contents, whose `revision` the next edit names. */
    let contents = $state.raw<StructuredMemoryContentsAnswer | null>(null);
    let failure = $state<string | null>(null);
    let readNumber = 0;
    /** One edit at a time: while one is out the selects are off and no read replaces the copy. */
    let sending = $state(false);

    let shown = $state(ROWS_AT_ONCE);
    /** The expanded thread, one at a time, and its record once read. */
    let openId = $state<string | null>(null);
    let openThread = $state.raw<MemoryThread | null>(null);
    let openFailure = $state<string | null>(null);
    let openNumber = 0;

    const titles = (rows: readonly { id: string; title: string }[] = []) =>
        new Map<string, string>(rows.map(({ id, title }) => [id, title]));
    const pageTitles = $derived(titles(contents?.pages));
    const eventTitles = $derived(titles(contents?.events));

    const sameChat = (ref: ChatRef) => ref.chaId === chatRef.chaId && ref.chatId === chatRef.chatId;

    /** Reads the contents. An answer for another chat, or one a newer read replaced, changes nothing. */
    async function readContents() {
        const ref = chatRef;
        const number = ++readNumber;
        const result = await readStructuredMemoryContents(ref);
        if (number !== readNumber || !sameChat(ref)) {
            return;
        }
        if (result.outcome === "ok") {
            contents = result.value;
            failure = null;
        } else {
            failure = memoryReadFailureText(result);
        }
    }

    async function readOpen(id: string) {
        const ref = chatRef;
        const number = ++openNumber;
        const result = await readStructuredMemoryRecord(ref, "threads", id);
        if (number !== openNumber || !sameChat(ref)) {
            return;
        }
        if (result.outcome === "ok") {
            openThread = result.value.data;
            openFailure = null;
        } else {
            openThread = null;
            openFailure = memoryReadFailureText(result);
        }
    }

    /** Reads what the tab shows, unless an edit is out: its answer is newer than any read. */
    function read() {
        if (sending) {
            return;
        }
        void readContents();
        if (openId !== null) {
            void readOpen(openId);
        }
    }

    $effect(() => {
        refresh;
        untrack(read);
    });

    function toggle(id: string) {
        openNumber += 1;
        openThread = null;
        openFailure = null;
        openId = openId === id ? null : id;
        if (openId !== null) {
            void readOpen(openId);
        }
    }

    /**
     * Moves a thread: applied to the copy, sent, and on a refusal undone with the notice and read again.
     * A success keeps the answer's revision, which the next edit names.
     */
    async function setState(id: string, state: MemoryThreadState) {
        if (sending || readOnly || !contents) {
            return;
        }
        const ref = chatRef;
        const before = contents;
        sending = true;
        // A read on its way may have been answered from before this edit.
        readNumber += 1;
        contents = { ...before, threads: before.threads.map((row) => (row.id === id ? { ...row, state } : row)) };
        const result = await editStructuredMemory(ref, before.revision, { kind: "thread", threadId: id, state });
        sending = false;
        if (result.outcome === "failed" || (result.outcome === "refused" && result.reason !== "epoch")) {
            alertError(memoryReadFailureText(result));
        }
        if (!sameChat(ref)) {
            return;
        }
        if (result.outcome === "ok" && result.value.kind === "threads") {
            const { revision, data } = result.value;
            contents = {
                ...before,
                revision,
                threads: before.threads.map((row) => (row.id === id ? { ...row, state: data.state } : row)),
            };
            if (openId === id) {
                openNumber += 1;
                openThread = data;
            }
        } else {
            contents = before;
            read();
        }
    }
</script>

{#snippet links(label: string, ids: readonly string[], known: ReadonlyMap<string, string>, tab: "pages" | "timeline")}
    {#if ids.length > 0}
        <div class="flex flex-wrap items-center gap-1">
            <span class="text-textcolor2">{label}</span>
            {#each ids as id}
                <MemoryLinkButton
                    label={known.get(id) ?? id}
                    disabled={!known.has(id)}
                    onclick={() => open({ tab, id })}
                    data-memory-link={id}
                />
            {/each}
        </div>
    {/if}
{/snippet}

<div class="flex flex-col min-w-0 gap-2 text-sm" data-memory-threads data-read-only={readOnly}>
    {#if failure !== null}
        <p role="alert" class="text-draculared" data-memory-panel-failure>{failure}</p>
    {:else if !contents}
        <p class="text-textcolor2">{panelText.loading}</p>
    {:else if contents.threads.length === 0}
        <p class="text-textcolor2">{text.empty}</p>
    {:else}
        <ul class="flex flex-col min-w-0 gap-2">
            {#each contents.threads.slice(0, shown) as thread (thread.id)}
                {@const expanded = openId === thread.id}
                <li
                    class={"flex flex-col min-w-0 border rounded-md border-darkborderc break-words" +
                        (memoryThreadEnded(thread.state) ? " text-textcolor2 opacity-70" : "")}
                    data-memory-thread={thread.state}
                >
                    <div class="flex items-center min-w-0 gap-2 p-2">
                        <button
                            type="button"
                            class="flex items-start flex-1 min-w-0 gap-2 text-left transition-colors hover:text-textcolor"
                            aria-expanded={expanded}
                            onclick={() => toggle(thread.id)}
                        >
                            {#if expanded}
                                <ChevronDownIcon size={16} class="shrink-0 mt-0.5" />
                            {:else}
                                <ChevronRightIcon size={16} class="shrink-0 mt-0.5" />
                            {/if}
                            <span class="min-w-0">{thread.title}</span>
                        </button>
                        <SelectInput
                            size="sm"
                            value={thread.state}
                            disabled={readOnly || sending}
                            aria-label={text.state}
                            onchange={(event) => setState(thread.id, event.currentTarget.value as MemoryThreadState)}
                            data-memory-thread-state={thread.id}
                        >
                            {#each MEMORY_THREAD_STATES as state (state)}
                                <OptionInput value={state}>{codeText(text.states, state)}</OptionInput>
                            {/each}
                        </SelectInput>
                    </div>
                    {#if expanded}
                        <div class="flex flex-col gap-1 p-2 border-t border-darkborderc">
                            {#if openFailure !== null}
                                <p role="alert" class="text-draculared">{openFailure}</p>
                            {:else if !openThread}
                                <p class="text-textcolor2">{panelText.loading}</p>
                            {:else}
                                {@render links(text.who, openThread.who, pageTitles, "pages")}
                                {@render links(
                                    text.openedBy,
                                    openThread.openedBy ? [openThread.openedBy] : [],
                                    eventTitles,
                                    "timeline",
                                )}
                                {@render links(
                                    text.closedBy,
                                    openThread.closedBy ? [openThread.closedBy] : [],
                                    eventTitles,
                                    "timeline",
                                )}
                            {/if}
                        </div>
                    {/if}
                </li>
            {/each}
        </ul>
        {#if contents.threads.length > shown}
            <button
                type="button"
                class="self-start px-2 py-1 my-1 transition-colors border rounded-md border-darkborderc text-textcolor2 hover:text-textcolor"
                onclick={() => (shown += ROWS_AT_ONCE)}
            >
                {panelText.showMore(contents.threads.length - shown)}
            </button>
        {/if}
    {/if}
</div>
