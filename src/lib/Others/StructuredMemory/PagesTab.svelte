<script lang="ts">
    import { ChevronDownIcon, ChevronRightIcon } from "@lucide/svelte";
    import { tick, untrack } from "svelte";
    import { language } from "src/lang";
    import { alertConfirm, alertError, alertToast } from "src/ts/alert";
    import {
        editStructuredMemory,
        importStructuredMemoryPackage,
        memoryItemsUsed,
        memoryMessageIndexes,
        memoryPageHistoryView,
        memoryPageTree,
        memoryTextDiff,
        readStructuredMemoryContents,
        readStructuredMemoryRecord,
        revertStructuredMemoryChange,
        structuredMemoryPageTool,
        type MemoryDiffPart,
        type MemoryPageHistoryRow,
        type MemoryPanelTabProps,
        type StructuredMemoryResult,
    } from "src/ts/process/structuredMemory.svelte";
    import { findChat, setChatMeta, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { selectSingleFileHandle } from "src/ts/util";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import type { loreBook } from "../../../../shared/database.ts";
    import {
        MEMORY_CONTEXT_MODES,
        STRUCTURED_MEMORY_LIMITS,
        type MemoryContextMode,
        type MemoryPage,
        type MemorySection,
        type StructuredMemoryContentsAnswer,
        type StructuredMemoryEdit,
        type StructuredMemoryImportAnswer,
        type StructuredMemoryPageTool,
        type StructuredMemoryRecordAnswer,
    } from "../../../../shared/structuredMemory.ts";
    import MemoryLinkButton from "./MemoryLinkButton.svelte";
    import { codeText, memoryReadFailureText } from "./memoryText";

    /**
     * Pages keeps a revision-bound copy of one page. Edits through
     * src/ts/process/structuredMemory.svelte.ts send only `StructuredMemoryEdit`, never a whole record;
     * the server decides all other fields. A refusal restores the copy and rereads; a success supplies the
     * next revision. A revert waits for the server's answer because only it knows the restored content.
     *
     * An open section editor keeps its base body. A read or revert that changes that body closes the editor
     * with `changed`, so an old draft cannot replace new writer text. Read-only keeps the draft and disables
     * Save; the read when it falls checks the same base. Titles, aliases, types, and links have no editor.
     * Section headings use `pages.headings`, with unknown keys shown literally. All record text stays plain.
     *
     * History's after-state comes from `memoryPageHistoryView` in src/ts/process/structuredMemory.svelte.ts;
     * no after-state is stored. One diff opens at a time and renders as spans. A target with `historyId`
     * opens that diff only after its page is held, then scrolls after render.
     */

    // A tool over a page as a whole (`StructuredMemoryPageTool`) goes that way too: the server answers
    // the page to show next, the contents are read again, and that page is selected. The trash is listed
    // under the tree; a page in it shows read-only with Restore and Delete forever. Merging, splitting,
    // deleting forever, and importing a package are confirmed first. Exporting a page to the chat's
    // lorebook is a chat write, not a memory write: it needs the chat loaded and nothing else.
    //

    let { chatRef, readOnly, refresh, focus, open, jump }: MemoryPanelTabProps = $props();

    /** The rows a list renders at once; a long chat stays cheap behind "show more". */
    const ROWS_AT_ONCE = 200;
    const FLAGS = ["disputed", "unsupported", "userCorrected"] as const;
    const { sectionBodyChars, gradeMax, labelChars } = STRUCTURED_MEMORY_LIMITS;
    const GRADES = Array.from({ length: gradeMax + 1 }, (_, grade) => grade);
    /** What makes a lore entry inactive, read by the lore activation as a decorator. */
    const LORE_INACTIVE = "@@dont_activate";

    const text = language.structuredMemory.pages;
    const toolText = text.tools;
    const panelText = language.structuredMemory.panel;
    const revertText = language.structuredMemory.revert;

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

    /** The merge target a person chose, among the live pages of the copy's type. */
    let mergeTargetId = $state("");
    /** The split form: the headings and aliases to move, and the new page's title. */
    let splitOpen = $state(false);
    let splitHeadings = $state<string[]>([]);
    let splitAliases = $state<string[]>([]);
    let splitTitle = $state("");
    /** What the last import answered, until the next one or another chat. */
    let importReport = $state.raw<StructuredMemoryImportAnswer | null>(null);

    let shownRows = $state(ROWS_AT_ONCE);
    /** The open history entry and its diff, one at a time. */
    let openEntry = $state<string | null>(null);
    let diff = $state.raw<MemoryDiffPart[] | "failed" | null>(null);
    let diffNumber = 0;
    /** The history entry a jump asked for, until its page is the copy. */
    let askedEntry: { pageId: string; historyId: string } | null = null;
    let historyList = $state<HTMLElement>();

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
    /** The copy is a page in the trash: read-only, with Restore and Delete forever alone. */
    const inTrash = $derived(copy?.data.trashedAt !== undefined);
    /** The live pages the copy can merge into: its type, not itself. */
    const mergeTargets = $derived(
        copy && contents ? contents.pages.filter(({ type, id }) => type === copy.data.type && id !== copy.data.id) : [],
    );
    const splitFits = $derived(
        copy !== null &&
            splitHeadings.length > 0 &&
            splitHeadings.length < copy.data.sections.length &&
            splitTitle.trim() !== "" &&
            splitTitle.length <= labelChars,
    );
    /** The chat holds nothing the tab knows of and waits for no choice, which is what an import takes. */
    const canImport = $derived(
        contents !== null &&
            [contents.pages, contents.trash, contents.events, contents.threads, contents.runs].every(
                ({ length }) => length === 0,
            ) &&
            contents.adoption.adoptable === 0,
    );

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

    /** Keeps `record` as the copy; an open editor it overruns closes with the notice, unless `noticed`. */
    function keepRecord(record: StructuredMemoryRecordAnswer<"pages">, noticed = false) {
        copy = record;
        if (editorOverrun(record.data)) {
            editor = null;
            if (!noticed) {
                alertError(memoryReadFailureText({ outcome: "refused", reason: "changed" }));
            }
        }
    }

    /**
     * Opens the entry a jump asked for once its page is the copy, even one that stands open, and brings it
     * into view when its diff has rendered, or failed to, unless a person moved on meanwhile. A lost entry
     * opens nothing. A person's own click on a row never scrolls.
     */
    async function openAskedEntry() {
        const asked = askedEntry;
        if (!asked || asked.pageId !== copy?.data.id) {
            return;
        }
        askedEntry = null;
        const entry = history.find(({ id, heading }) => id === asked.historyId && heading !== null);
        if (!entry) {
            return;
        }
        openEntry = null;
        await toggleEntry(entry);
        await tick();
        if (openEntry === entry.id && diff !== null) {
            const row = [...(historyList?.querySelectorAll<HTMLElement>("[data-memory-history-id]") ?? [])].find(
                ({ dataset }) => dataset.memoryHistoryId === entry.id,
            );
            row?.scrollIntoView?.({ block: "nearest" });
        }
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
        keepRecord(result.value, noticed);
        recordFailure = null;
        void openAskedEntry();
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

    // An import's report belongs to the chat it was made in.
    $effect(() => {
        chatRef.chaId;
        chatRef.chatId;
        untrack(() => (importReport = null));
    });

    /** Forgets what the tools held of the page shown before. */
    function resetTools() {
        mergeTargetId = "";
        splitOpen = false;
        splitHeadings = [];
        splitAliases = [];
        splitTitle = "";
    }

    function select(id: string) {
        if (id === selectedId) {
            return;
        }
        if (askedEntry?.pageId !== id) {
            askedEntry = null;
        }
        selectedId = id;
        copy = null;
        recordFailure = null;
        editor = null;
        openEntry = null;
        resetTools();
        void readRecord(id);
    }

    // The page a jump from another tab asked for.
    $effect(() => {
        const target = focus;
        if (target) {
            untrack(() => {
                const { id, historyId } = target;
                askedEntry = historyId === undefined ? null : { pageId: id, historyId };
                select(id);
                void openAskedEntry();
            });
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
     * Sends one change of the copy through `request`, with `applied` as the copy meanwhile. `keep` takes
     * the answer, and says whether it holds the page. Anything else restores the copy, shows the notice
     * (none for `epoch`, which halts on its own; `refusedText` words a failure's text, which for a tool is
     * what the pages refused), and reads again, and that read decides whether an open editor survives.
     */
    async function sendChange<T>(
        request: (ref: ChatRef, revision: string) => Promise<StructuredMemoryResult<T>>,
        applied: MemoryPage,
        keep: (answer: T) => boolean,
        refusedText?: (error: string) => string,
    ) {
        if (sending || readOnly || !copy) {
            return;
        }
        const ref = chatRef;
        const before = copy;
        sending = true;
        // A read on its way may have been answered from before this edit.
        recordNumber += 1;
        copy = { ...before, data: applied };
        const result = await request(ref, before.revision);
        sending = false;
        if (result.outcome === "failed" && refusedText) {
            alertError(refusedText(result.error));
        } else if (result.outcome === "failed" || (result.outcome === "refused" && result.reason !== "epoch")) {
            alertError(memoryReadFailureText(result));
        }
        if (!sameChat(ref)) {
            return;
        }
        if (result.outcome !== "ok" || !keep(result.value)) {
            copy = before;
            read(result.outcome === "refused" && result.reason === "changed");
        }
    }

    /** Sends `edit` with `applied` as the copy meanwhile. A section's own success closes its editor. */
    function send(edit: StructuredMemoryEdit, applied: MemoryPage) {
        return sendChange(
            (ref, revision) => editStructuredMemory(ref, revision, edit),
            applied,
            (answer) => {
                if (answer.kind !== "pages") {
                    return false;
                }
                copy = { revision: answer.revision, data: answer.data };
                if (edit.kind === "section") {
                    editor = null;
                }
                return true;
            },
        );
    }

    /** Undoes the writer's change `entry` names. The notice counts the later events that stay. */
    function revert({ id }: MemoryPageHistoryRow) {
        if (!copy) {
            return;
        }
        const { data } = copy;
        void sendChange(
            (ref) => revertStructuredMemoryChange(ref, data.id, id),
            data,
            ({ revision, data: page, reverted, laterEvents }) => {
                keepRecord({ revision, data: page });
                alertToast(reverted ? revertText.done(laterEvents) : revertText.nothing);
                return true;
            },
        );
    }

    /**
     * Sends `tool` over the copy. The answer names the page to show next, which is selected, or none after
     * a purge; the contents are read again either way, since a tool moves pages between the lists.
     */
    function runTool(tool: StructuredMemoryPageTool) {
        if (!copy) {
            return;
        }
        const { data } = copy;
        return sendChange(
            (ref, revision) => structuredMemoryPageTool(ref, revision, tool),
            data,
            ({ revision, data: page }) => {
                editor = null;
                openEntry = null;
                resetTools();
                if (page === null) {
                    selectedId = null;
                    copy = null;
                } else {
                    selectedId = page.id;
                    keepRecord({ revision, data: page }, true);
                }
                void readContents();
                return true;
            },
            toolText.refused,
        );
    }

    function trashPage() {
        if (copy) {
            void runTool({ kind: "trash", pageId: copy.data.id });
        }
    }

    function untrashPage() {
        if (copy) {
            void runTool({ kind: "untrash", pageId: copy.data.id });
        }
    }

    async function purgePage() {
        if (!copy || controlsOff) {
            return;
        }
        const { id, title } = copy.data;
        if (await alertConfirm(toolText.purgeConfirm(title))) {
            void runTool({ kind: "purge", pageId: id });
        }
    }

    async function mergePage() {
        const target = mergeTargets.find(({ id }) => id === mergeTargetId);
        if (!copy || !target || controlsOff) {
            return;
        }
        const { id, title } = copy.data;
        if (await alertConfirm(toolText.mergeConfirm(title, target.title))) {
            void runTool({ kind: "merge", sourceId: id, targetId: target.id });
        }
    }

    function toggleSplitHeading(heading: string, moved: boolean) {
        splitHeadings = moved ? [...splitHeadings, heading] : splitHeadings.filter((entry) => entry !== heading);
    }

    function toggleSplitAlias(alias: string, moved: boolean) {
        splitAliases = moved ? [...splitAliases, alias] : splitAliases.filter((entry) => entry !== alias);
    }

    async function splitPage() {
        if (!copy || !splitFits || controlsOff) {
            return;
        }
        const tool: StructuredMemoryPageTool = {
            kind: "split",
            pageId: copy.data.id,
            headings: splitHeadings,
            title: splitTitle.trim(),
            aliases: splitAliases,
        };
        if (await alertConfirm(toolText.splitConfirm(tool.title, tool.headings.length))) {
            void runTool(tool);
        }
    }

    /**
     * Appends `page` to the chat's own lorebook as an inactive entry: the title and aliases as its keys, so
     * `aliasSeeds` in `server/src/prompt/memory/structured/pages.ts` reads them for the next recording. `setChatMeta`
     * in `src/ts/storage/chatStore.svelte.ts` writes `localLore`, never `globalLore`. The blank line after
     * `@@dont_activate` ends the decorator lines `CCardLib.decorator.parse` reads (called from
     * `shared/lore/activation.ts`): an adjacent `@@activate` would override it, while a rendered `## @@activate`
     * heading is plain text. This needs the chat loaded and uses its chat revision, outside the memory revision and
     * fence; `readOnly` only disables the button.
     */
    function exportToLore(page: MemoryPage) {
        const chat = findChat(chatRef);
        if (!chat) {
            alertError(toolText.exportNotLoaded);
            return;
        }
        const body = page.sections.map(({ heading, body }) => `## ${codeText(text.headings, heading)}\n${body}`);
        const entry: loreBook = {
            key: [page.title, ...page.aliases].join(","),
            secondkey: "",
            insertorder: 100,
            comment: page.title,
            content: `${LORE_INACTIVE}\n\n${body.join("\n\n")}`,
            mode: "normal",
            alwaysActive: false,
            selective: false,
        };
        try {
            setChatMeta(chatRef, { localLore: [...(chat.localLore ?? []), entry] });
            alertToast(toolText.exported(page.title));
        } catch (error) {
            alertError(error instanceof Error ? error : String(error));
        }
    }

    /**
     * Imports a package zip into the chat, which must hold no records: the file is unzipped here and its
     * Markdown sent. The answer is kept as the report, and the contents are read again after a write.
     */
    async function importPackage() {
        if (controlsOff || !contents) {
            return;
        }
        const file = await selectSingleFileHandle(["zip"]);
        if (!file || sending) {
            return;
        }
        const ref = chatRef;
        const { revision } = contents;
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!(await alertConfirm(toolText.importConfirm))) {
            return;
        }
        sending = true;
        const result = await importStructuredMemoryPackage(ref, revision, bytes);
        sending = false;
        if (!sameChat(ref)) {
            return;
        }
        if (result.outcome !== "ok") {
            if (result.outcome === "failed" || result.reason !== "epoch") {
                alertError(memoryReadFailureText(result));
                read();
            }
            return;
        }
        importReport = result.value;
        alertToast(result.value.imported ? toolText.importDone(result.value.imported) : toolText.importNothing);
        read();
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
            {#if inTrash}
                {#if section.locked}
                    <span class="px-1.5 rounded-sm bg-darkbutton text-textcolor2">{text.locked}</span>
                {/if}
            {:else}
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
            {/if}
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

{#snippet historyMarks(entry: MemoryPageHistoryRow)}
    {#if entry.highlighted}
        <span class="px-1.5 rounded-sm bg-darkbutton text-secondary-500" data-memory-history-highlighted>
            {text.highlighted}
        </span>
    {/if}
    {#if entry.reverted}
        <span class="px-1.5 rounded-sm bg-darkbutton text-textcolor2" data-memory-history-reverted>
            {revertText.reverted}
        </span>
    {/if}
{/snippet}

{#snippet historyRow(entry: MemoryPageHistoryRow)}
    {@const summary = `${codeText(text.historyKinds, entry.kind)}, ${new Date(entry.at).toLocaleString()}`}
    <li
        class="flex flex-col min-w-0 py-1 break-words"
        data-memory-history={entry.kind}
        data-memory-history-id={entry.id}
    >
        {#if entry.heading === null}
            <span class="flex flex-wrap gap-x-2 text-textcolor2">
                <span>{summary}</span>
                <span>{text.wholePage}</span>
                {@render historyMarks(entry)}
            </span>
        {:else}
            {@const expanded = openEntry === entry.id}
            <div class="flex flex-wrap items-center justify-between min-w-0 gap-2">
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
                        {@render historyMarks(entry)}
                    </span>
                </button>
                {#if entry.revertable && !inTrash}
                    <Button size="sm" styled="outlined" disabled={controlsOff} onclick={() => revert(entry)}>
                        <span data-memory-history-revert>{revertText.button}</span>
                    </Button>
                {/if}
            </div>
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

{#snippet pageTools(page: MemoryPage)}
    <div class="flex flex-wrap items-center gap-2" data-memory-page-tools>
        <Button size="sm" styled="outlined" disabled={readOnly} onclick={() => exportToLore(page)}>
            <span data-memory-export-lore>{toolText.export}</span>
        </Button>
        {#if page.type !== "scene"}
            <Button
                size="sm"
                styled="outlined"
                disabled={controlsOff || page.sections.length < 2}
                onclick={() => (splitOpen = !splitOpen)}
            >
                <span data-memory-split-open>{toolText.split}</span>
            </Button>
            <Button size="sm" styled="outlined" disabled={controlsOff} onclick={trashPage}>
                <span data-memory-trash>{toolText.delete}</span>
            </Button>
            {#if mergeTargets.length > 0}
                <label class="flex items-center gap-1">
                    <span class="text-textcolor2">{toolText.mergeInto}</span>
                    <SelectInput size="sm" bind:value={mergeTargetId} disabled={controlsOff} data-memory-merge-target>
                        <OptionInput value="">{toolText.mergeTarget}</OptionInput>
                        {#each mergeTargets as target (target.id)}
                            <OptionInput value={target.id}>{target.title}</OptionInput>
                        {/each}
                    </SelectInput>
                </label>
                <Button size="sm" styled="outlined" disabled={controlsOff || mergeTargetId === ""} onclick={mergePage}>
                    <span data-memory-merge>{toolText.merge}</span>
                </Button>
            {/if}
        {/if}
    </div>
    {#if splitOpen && page.type !== "scene"}
        <div class="flex flex-col gap-2 p-2 border rounded-md border-darkborderc" data-memory-split-form>
            <span class="text-textcolor2">{toolText.splitHeadings}</span>
            <div class="flex flex-wrap gap-3">
                {#each page.sections as { heading } (heading)}
                    <span data-memory-split-heading={heading}>
                        <CheckInput
                            check={splitHeadings.includes(heading)}
                            disabled={controlsOff}
                            margin={false}
                            name={codeText(text.headings, heading)}
                            onChange={(moved) => toggleSplitHeading(heading, moved)}
                        />
                    </span>
                {/each}
            </div>
            {#if page.aliases.length > 0}
                <span class="text-textcolor2">{toolText.splitAliases}</span>
                <div class="flex flex-wrap gap-3">
                    {#each page.aliases as alias (alias)}
                        <span data-memory-split-alias={alias}>
                            <CheckInput
                                check={splitAliases.includes(alias)}
                                disabled={controlsOff}
                                margin={false}
                                name={alias}
                                onChange={(moved) => toggleSplitAlias(alias, moved)}
                            />
                        </span>
                    {/each}
                </div>
            {/if}
            <label class="flex flex-col gap-1" data-memory-split-title>
                <span class="text-textcolor2">{toolText.splitTitle}</span>
                <TextInput size="sm" bind:value={splitTitle} disabled={controlsOff} />
            </label>
            <div class="flex items-center justify-end gap-2">
                <Button size="sm" styled="outlined" disabled={sending} onclick={() => (splitOpen = false)}>
                    <span data-memory-split-cancel>{text.cancel}</span>
                </Button>
                <Button size="sm" disabled={controlsOff || !splitFits} onclick={splitPage}>
                    <span data-memory-split>{toolText.split}</span>
                </Button>
            </div>
        </div>
    {/if}
{/snippet}

{#snippet pageDetail(page: MemoryPage)}
    <h2 class="text-base font-semibold break-words">{page.title}</h2>
    <p class="text-textcolor2">{codeText(text.types, page.type)}</p>
    {#if page.aliases.length > 0}
        <p class="break-words">{text.aliases}: {page.aliases.join(", ")}</p>
    {/if}
    {#if page.trashedAt !== undefined}
        <p class="text-textcolor2" data-memory-trashed>{toolText.trashed}</p>
        <div class="flex flex-wrap items-center gap-2" data-memory-page-tools>
            <Button size="sm" disabled={controlsOff} onclick={untrashPage}>
                <span data-memory-untrash>{toolText.restore}</span>
            </Button>
            <Button size="sm" styled="outlined" disabled={controlsOff} onclick={purgePage}>
                <span data-memory-purge>{toolText.purge}</span>
            </Button>
        </div>
    {:else}
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
        {@render pageTools(page)}
    {/if}
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
        <ul
            class="flex flex-col min-w-0 border-t divide-y divide-darkborderc border-darkborderc"
            bind:this={historyList}
        >
            {#each history as entry}
                {@render historyRow(entry)}
            {/each}
        </ul>
    {/if}
{/snippet}

{#snippet importControls()}
    {#if canImport}
        <Button size="sm" styled="outlined" disabled={controlsOff} onclick={importPackage}>
            <span data-memory-import>{toolText.import}</span>
        </Button>
    {/if}
{/snippet}

<div class="flex flex-col min-w-0 gap-2 text-sm" data-memory-pages data-read-only={readOnly}>
    {#if importReport}
        <div class="flex flex-col min-w-0 gap-1 break-words" data-memory-import-report>
            <p>{importReport.imported ? toolText.importDone(importReport.imported) : toolText.importNothing}</p>
            {#if importReport.refusals.length > 0}
                <p class="text-textcolor2">{toolText.importRefusals}</p>
                <ul class="flex flex-col min-w-0 pl-4 list-disc">
                    {#each importReport.refusals as refusal}
                        <li data-memory-import-refusal={refusal.file}>
                            {refusal.file}: {codeText(toolText.importReasons, refusal.reason)}{refusal.detail
                                ? ` (${refusal.detail})`
                                : ""}
                        </li>
                    {/each}
                </ul>
            {/if}
        </div>
    {/if}
    {#if failure !== null}
        <p role="alert" class="text-draculared" data-memory-panel-failure>{failure}</p>
    {:else if !contents}
        <p class="text-textcolor2">{panelText.loading}</p>
    {:else if contents.pages.length === 0 && contents.trash.length === 0}
        <p class="text-textcolor2">{text.empty}</p>
        {@render importControls()}
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
                {#if contents.trash.length > 0}
                    <li class="mt-2 text-textcolor2" data-memory-trash-group>{toolText.trash}</li>
                    {#each contents.trash as row (row.id)}
                        <li class="min-w-0">
                            <button
                                type="button"
                                class={"flex flex-wrap items-center w-full min-w-0 px-2 py-1 text-left transition-colors rounded-md gap-x-2 text-textcolor2 hover:bg-selected disabled:cursor-not-allowed" +
                                    (row.id === selectedId ? " bg-selected" : "")}
                                aria-current={row.id === selectedId}
                                disabled={sending}
                                onclick={() => select(row.id)}
                                data-memory-trash-page={row.id}
                            >
                                <span class="min-w-0 break-words">{row.title}</span>
                            </button>
                        </li>
                    {/each}
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
