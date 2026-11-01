<script lang="ts">
    import { ChevronDownIcon, ChevronRightIcon } from "@lucide/svelte";
    import { untrack } from "svelte";
    import { language } from "src/lang";
    import { alertError } from "src/ts/alert";
    import {
        editStructuredMemory,
        memoryItemsUsed,
        memoryMessageIndexes,
        memoryPageHistoryView,
        memoryPageTree,
        memoryTextDiff,
        readStructuredMemoryContents,
        readStructuredMemoryRecord,
        type MemoryDiffPart,
        type MemoryPageHistoryRow,
        type MemoryPanelTabProps,
    } from "src/ts/process/structuredMemory.svelte";
    import { findChat, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import {
        MEMORY_CONTEXT_MODES,
        STRUCTURED_MEMORY_LIMITS,
        type MemoryContextMode,
        type MemoryPage,
        type MemorySection,
        type StructuredMemoryContentsAnswer,
        type StructuredMemoryEdit,
        type StructuredMemoryRecordAnswer,
    } from "../../../../shared/structuredMemory.ts";
    import MemoryLinkButton from "./MemoryLinkButton.svelte";
    import { codeText, memoryReadFailureText } from "./memoryText";

    // The Pages tab: the chat's pages as a tree, and one page to read and correct. An edit is applied to
    // the tab's copy, sent, and a refusal puts the copy back with the notice and reads again; a success
    // keeps the answer, whose revision the next edit names. The tab sends what changed and never a
    // record (`StructuredMemoryEdit`), so the server's own record decides everything else.
    //
    // An open section editor keeps the body it opened on. A read that brings another body for it closes
    // the editor with the `changed` notice: a draft written against old text must not clobber the
    // writer's new text. Read-only keeps the draft and only turns Save off, and the read that comes when
    // it falls applies the same rule. Everything shown is plain text.

    let { chatRef, readOnly, refresh, focus, open, jump }: MemoryPanelTabProps = $props();

    /** The rows a list renders at once; a long chat stays cheap behind "show more". */
    const ROWS_AT_ONCE = 200;
    const FLAGS = ["disputed", "unsupported", "userCorrected"] as const;
    const { sectionBodyChars, gradeMax } = STRUCTURED_MEMORY_LIMITS;
    const GRADES = Array.from({ length: gradeMax + 1 }, (_, grade) => grade);

    const text = language.structuredMemory.pages;
    const panelText = language.structuredMemory.panel;

    let contents = $state.raw<StructuredMemoryContentsAnswer | null>(null);
    let failure = $state<string | null>(null);
    let contentsNumber = 0;

    let selectedId = $state<string | null>(null);
    /** The tab's copy of the selected page, with the revision the next edit names. */
    let copy = $state.raw<StructuredMemoryRecordAnswer<"pages"> | null>(null);
    let recordFailure = $state<string | null>(null);
    let recordNumber = 0;
    /** One edit at a time: while one is out the controls are off and no read replaces the copy. */
    let sending = $state(false);

    /** The open section editor, with the body it opened on. */
    let editor = $state.raw<{ heading: string; base: string } | null>(null);
    let draft = $state("");

    let shownRows = $state(ROWS_AT_ONCE);
    /** The open history entry and its diff, one at a time. */
    let openEntry = $state<string | null>(null);
    let diff = $state.raw<MemoryDiffPart[] | "failed" | null>(null);
    let diffNumber = 0;

    const messages = $derived(findChat(chatRef)?.message ?? []);
    const usedPages = $derived(memoryItemsUsed(messages, "page"));
    const messageIndexes = $derived(memoryMessageIndexes(messages));
    const eventTitles = $derived(new Map<string, string>(contents?.events.map(({ id, title }) => [id, title])));
    /** The tree in order, a group's first row carrying its type, so "show more" counts rows. */
    const treeRows = $derived(
        memoryPageTree(contents?.pages ?? []).flatMap(({ type, rows }) =>
            rows.map((row, index) => ({ row, group: index === 0 ? type : null })),
        ),
    );
    const history = $derived(copy ? memoryPageHistoryView(copy.data) : []);
    const controlsOff = $derived(readOnly || sending);
    const draftFits = $derived(draft.trim() !== "" && draft.length <= sectionBodyChars);

    const sameChat = (ref: ChatRef) => ref.chaId === chatRef.chaId && ref.chatId === chatRef.chatId;

    /** Reads the contents. An answer for another chat, or one a newer read replaced, changes nothing. */
    async function readContents() {
        const ref = chatRef;
        const number = ++contentsNumber;
        const result = await readStructuredMemoryContents(ref);
        if (number !== contentsNumber || !sameChat(ref)) {
            return;
        }
        if (result.outcome === "ok") {
            contents = result.value;
            failure = null;
        } else {
            failure = memoryReadFailureText(result);
        }
    }

    /** Whether `page` no longer holds the body the open editor opened on. */
    function editorOverrun(page: MemoryPage) {
        const opened = editor;
        return opened !== null && page.sections.find(({ heading }) => heading === opened.heading)?.body !== opened.base;
    }

    /** Reads page `id` into the copy. `noticed`: a refused edit has just said the memory changed. */
    async function readRecord(id: string, noticed = false) {
        const ref = chatRef;
        const number = ++recordNumber;
        const result = await readStructuredMemoryRecord(ref, "pages", id);
        if (number !== recordNumber || !sameChat(ref)) {
            return;
        }
        if (result.outcome !== "ok") {
            recordFailure = memoryReadFailureText(result);
            if (result.outcome === "refused" && (result.reason === "recordGone" || result.reason === "chatGone")) {
                copy = null;
                editor = null;
            }
            return;
        }
        copy = result.value;
        recordFailure = null;
        if (editorOverrun(result.value.data)) {
            editor = null;
            if (!noticed) {
                alertError(memoryReadFailureText({ outcome: "refused", reason: "changed" }));
            }
        }
    }

    /** Reads what the tab shows. While an edit is out the copy waits for its answer, which is newer. */
    function read(noticed = false) {
        void readContents();
        if (selectedId !== null && !sending) {
            void readRecord(selectedId, noticed);
        }
    }

    $effect(() => {
        refresh;
        untrack(() => read());
    });

    function select(id: string) {
        if (id === selectedId) {
            return;
        }
        selectedId = id;
        copy = null;
        recordFailure = null;
        editor = null;
        openEntry = null;
        void readRecord(id);
    }

    // The page a jump from another tab asked for.
    $effect(() => {
        const target = focus;
        if (target) {
            untrack(() => select(target.id));
        }
    });

    // A row selected from another tab stays reachable past "show more".
    $effect(() => {
        const index = treeRows.findIndex(({ row }) => row.id === selectedId);
        untrack(() => {
            if (index >= shownRows) {
                shownRows = index + 1;
            }
        });
    });

    /**
     * Sends `edit` with `applied` as the copy meanwhile. A refusal restores the copy, shows the notice
     * (none for `epoch`, which halts on its own), and reads again, and that read decides whether an open
     * editor survives. A section's own success closes its editor.
     */
    async function send(edit: StructuredMemoryEdit, applied: MemoryPage) {
        if (sending || readOnly || !copy) {
            return;
        }
        const ref = chatRef;
        const before = copy;
        sending = true;
        // A read on its way may have been answered from before this edit.
        recordNumber += 1;
        copy = { ...before, data: applied };
        const result = await editStructuredMemory(ref, before.revision, edit);
        sending = false;
        if (result.outcome === "failed" || (result.outcome === "refused" && result.reason !== "epoch")) {
            alertError(memoryReadFailureText(result));
        }
        if (!sameChat(ref)) {
            return;
        }
        if (result.outcome === "ok" && result.value.kind === "pages") {
            copy = { revision: result.value.revision, data: result.value.data };
            if (edit.kind === "section") {
                editor = null;
            }
        } else {
            copy = before;
            read(result.outcome === "refused" && result.reason === "changed");
        }
    }

    /** `page` with `change` on the section under `heading`. */
    const withSection = (page: MemoryPage, heading: string, change: Partial<MemorySection>): MemoryPage => ({
        ...page,
        sections: page.sections.map((section) => (section.heading === heading ? { ...section, ...change } : section)),
    });

    function setContextMode(contextMode: MemoryContextMode) {
        if (copy) {
            void send({ kind: "page", pageId: copy.data.id, contextMode }, { ...copy.data, contextMode });
        }
    }

    function setGrade(value: string) {
        if (!copy) {
            return;
        }
        const { grade: _grade, gradeByUser: _gradeByUser, ...ungraded } = copy.data;
        const grade = value === "" ? null : Number(value);
        void send(
            { kind: "page", pageId: copy.data.id, grade },
            grade === null ? ungraded : { ...ungraded, grade, gradeByUser: true },
        );
    }

    function setLock(heading: string, locked: boolean) {
        if (copy) {
            void send(
                { kind: "sectionLock", pageId: copy.data.id, heading, locked },
                withSection(copy.data, heading, { locked }),
            );
        }
    }

    function startEdit({ heading, body }: MemorySection) {
        editor = { heading, base: body };
        draft = body;
    }

    function saveSection() {
        if (copy && editor && draftFits) {
            const { heading } = editor;
            void send(
                { kind: "section", pageId: copy.data.id, heading, body: draft },
                withSection(copy.data, heading, { body: draft }),
            );
        }
    }

    async function toggleEntry({ id, before, after }: MemoryPageHistoryRow) {
        const number = ++diffNumber;
        diff = null;
        openEntry = openEntry === id ? null : id;
        if (openEntry === null) {
            return;
        }
        let parts: MemoryDiffPart[] | "failed";
        try {
            parts = await memoryTextDiff(before ?? "", after ?? "");
        } catch (error) {
            console.error("[Memory]", error);
            parts = "failed";
        }
        if (number === diffNumber) {
            diff = parts;
        }
    }

    function diffClass(change: MemoryDiffPart["change"]): string {
        return change === "added"
            ? "bg-success-500/20"
            : change === "removed"
              ? "bg-danger-500/20 line-through"
              : "text-textcolor2";
    }
</script>

{#snippet sectionBlock(section: MemorySection)}
    <section
        class="flex flex-col min-w-0 gap-1 p-2 border rounded-md border-darkborderc break-words"
        data-memory-section={section.heading}
    >
        <div class="flex flex-wrap items-center gap-2">
            <h3 class="flex-1 min-w-0 font-semibold">{codeText(text.headings, section.heading)}</h3>
            {#each FLAGS as flag (flag)}
                {#if section[flag]}
                    <span class="px-1.5 rounded-sm bg-darkbutton text-textcolor2" data-memory-flag={flag}>
                        {text.flags[flag]}
                    </span>
                {/if}
            {/each}
            <CheckInput
                check={section.locked}
                disabled={controlsOff}
                margin={false}
                name={text.locked}
                onChange={(locked) => setLock(section.heading, locked)}
            />
            <Button
                size="sm"
                styled="outlined"
                disabled={controlsOff || editor !== null}
                onclick={() => startEdit(section)}
            >
                <span data-memory-section-edit>{text.edit}</span>
            </Button>
        </div>
        {#if editor?.heading === section.heading}
            <TextAreaInput
                bind:value={draft}
                height="36"
                optimaizedInput={false}
                popupEditor={false}
                ariaLabel={text.sectionText}
            />
            <div class="flex items-center justify-between gap-2">
                <span
                    class={draft.length > sectionBodyChars ? "text-draculared" : "text-textcolor2"}
                    data-memory-section-count
                >
                    {text.characters(draft.length, sectionBodyChars)}
                </span>
                <div class="flex items-center gap-2">
                    <Button size="sm" styled="outlined" disabled={sending} onclick={() => (editor = null)}>
                        <span data-memory-section-cancel>{text.cancel}</span>
                    </Button>
                    <Button size="sm" disabled={controlsOff || !draftFits} onclick={saveSection}>
                        <span data-memory-section-save>{text.save}</span>
                    </Button>
                </div>
            </div>
        {:else}
            <p class="whitespace-pre-wrap" data-memory-section-body>{section.body}</p>
        {/if}
        {#if section.provenance.length > 0}
            <div class="flex flex-wrap items-center gap-1">
                <span class="text-textcolor2">{text.provenance}</span>
                {#each section.provenance as id}
                    <MemoryLinkButton
                        label={eventTitles.get(id) ?? id}
                        disabled={!eventTitles.has(id)}
                        onclick={() => open({ tab: "timeline", id })}
                        data-memory-provenance={id}
                    />
                {/each}
            </div>
        {/if}
        {#if section.sources.length > 0}
            <div class="flex flex-wrap items-center gap-1">
                <span class="text-textcolor2">{text.sources}</span>
                {#each section.sources as { messageId }}
                    {@const index = messageIndexes.get(messageId)}
                    <MemoryLinkButton
                        label={index === undefined ? text.messageGone : `#${index}`}
                        disabled={index === undefined}
                        onclick={() => jump(messageId)}
                        data-memory-source={messageId}
                    />
                {/each}
            </div>
        {/if}
    </section>
{/snippet}

{#snippet historyRow(entry: MemoryPageHistoryRow)}
    {@const summary = `${codeText(text.historyKinds, entry.kind)}, ${new Date(entry.at).toLocaleString()}`}
    <li class="flex flex-col min-w-0 py-1 break-words" data-memory-history={entry.kind}>
        {#if entry.heading === null}
            <span class="flex flex-wrap gap-x-2 text-textcolor2">
                <span>{summary}</span>
                <span>{text.wholePage}</span>
            </span>
        {:else}
            {@const expanded = openEntry === entry.id}
            <button
                type="button"
                class="flex items-center min-w-0 gap-2 text-left transition-colors hover:text-textcolor"
                aria-expanded={expanded}
                onclick={() => toggleEntry(entry)}
            >
                {#if expanded}
                    <ChevronDownIcon size={16} class="shrink-0" />
                {:else}
                    <ChevronRightIcon size={16} class="shrink-0" />
                {/if}
                <span class="flex flex-wrap min-w-0 gap-x-2 text-textcolor2">
                    <span>{summary}</span>
                    <span>{codeText(text.headings, entry.heading)}</span>
                </span>
            </button>
            {#if expanded}
                {#if diff === "failed"}
                    <p role="alert" class="pl-6 text-draculared">{text.diffFailed}</p>
                {:else if diff === null}
                    <p class="pl-6 text-textcolor2">{panelText.loading}</p>
                {:else}
                    <p class="pl-6 whitespace-pre-wrap" data-memory-history-diff>
                        {#each diff as part}
                            <span class={diffClass(part.change)} data-memory-diff={part.change}>{part.text}</span>
                        {/each}
                    </p>
                {/if}
            {/if}
        {/if}
    </li>
{/snippet}

{#snippet pageDetail(page: MemoryPage)}
    <h2 class="text-base font-semibold break-words">{page.title}</h2>
    <p class="text-textcolor2">{codeText(text.types, page.type)}</p>
    {#if page.aliases.length > 0}
        <p class="break-words">{text.aliases}: {page.aliases.join(", ")}</p>
    {/if}
    <div class="flex flex-wrap gap-3">
        {#if page.type !== "scene"}
            <label class="flex flex-col gap-1">
                <span class="text-textcolor2">{text.contextMode}</span>
                <SelectInput
                    size="sm"
                    value={page.contextMode}
                    disabled={controlsOff}
                    onchange={(event) => setContextMode(event.currentTarget.value as MemoryContextMode)}
                    data-memory-page-mode
                >
                    {#each MEMORY_CONTEXT_MODES as mode (mode)}
                        <OptionInput value={mode}>{text.contextModes[mode]}</OptionInput>
                    {/each}
                </SelectInput>
            </label>
        {/if}
        <label class="flex flex-col gap-1">
            <span class="text-textcolor2">{text.grade}</span>
            <SelectInput
                size="sm"
                value={page.grade ?? ""}
                disabled={controlsOff}
                onchange={(event) => setGrade(event.currentTarget.value)}
                data-memory-page-grade
            >
                <OptionInput value="">{text.noGrade}</OptionInput>
                {#each GRADES as grade (grade)}
                    <OptionInput value={grade}>{grade}</OptionInput>
                {/each}
            </SelectInput>
        </label>
    </div>
    {#if page.sections.length === 0}
        <p class="text-textcolor2">{text.noSections}</p>
    {:else}
        {#each page.sections as section}
            {@render sectionBlock(section)}
        {/each}
    {/if}
    <h3 class="font-semibold">{text.history}</h3>
    {#if history.length === 0}
        <p class="text-textcolor2">{text.noHistory}</p>
    {:else}
        <ul class="flex flex-col min-w-0 border-t divide-y divide-darkborderc border-darkborderc">
            {#each history as entry}
                {@render historyRow(entry)}
            {/each}
        </ul>
    {/if}
{/snippet}

<div class="flex flex-col min-w-0 gap-2 text-sm" data-memory-pages data-read-only={readOnly}>
    {#if failure !== null}
        <p role="alert" class="text-draculared" data-memory-panel-failure>{failure}</p>
    {:else if !contents}
        <p class="text-textcolor2">{panelText.loading}</p>
    {:else if contents.pages.length === 0}
        <p class="text-textcolor2">{text.empty}</p>
    {:else}
        <div class="flex flex-col min-w-0 gap-3 sm:flex-row">
            <ul class="flex flex-col min-w-0 gap-0.5 sm:w-52 sm:shrink-0">
                {#each treeRows.slice(0, shownRows) as { row, group } (row.id)}
                    {#if group !== null}
                        <li class="mt-1 text-textcolor2" data-memory-page-group={group}>
                            {codeText(text.types, group)}
                        </li>
                    {/if}
                    <li class="min-w-0">
                        <button
                            type="button"
                            class={"flex flex-wrap items-center w-full min-w-0 px-2 py-1 text-left transition-colors rounded-md gap-x-2 hover:bg-selected disabled:cursor-not-allowed" +
                                (row.id === selectedId ? " bg-selected" : "")}
                            aria-current={row.id === selectedId}
                            disabled={sending}
                            onclick={() => select(row.id)}
                            data-memory-page={row.id}
                        >
                            <span class="min-w-0 break-words">{row.title}</span>
                            {#if usedPages.has(row.id)}
                                <span class="px-1.5 rounded-sm bg-darkbutton text-secondary-500" data-memory-used
                                    >{panelText.usedInLastSend}</span
                                >
                            {/if}
                        </button>
                    </li>
                {/each}
                {#if treeRows.length > shownRows}
                    <li>
                        <button
                            type="button"
                            class="px-2 py-1 my-1 transition-colors border rounded-md border-darkborderc text-textcolor2 hover:text-textcolor"
                            onclick={() => (shownRows += ROWS_AT_ONCE)}
                        >
                            {panelText.showMore(treeRows.length - shownRows)}
                        </button>
                    </li>
                {/if}
            </ul>
            <div class="flex flex-col flex-1 min-w-0 gap-2" data-memory-page-detail>
                {#if recordFailure !== null}
                    <p role="alert" class="text-draculared" data-memory-page-failure>{recordFailure}</p>
                {/if}
                {#if selectedId === null}
                    <p class="text-textcolor2">{text.select}</p>
                {:else if copy}
                    {@render pageDetail(copy.data)}
                {:else if recordFailure === null}
                    <p class="text-textcolor2">{panelText.loading}</p>
                {/if}
            </div>
        </div>
    {/if}
</div>
