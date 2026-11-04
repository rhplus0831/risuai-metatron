<script lang="ts">
    import { ChevronDownIcon, ChevronRightIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { alertError, alertToast } from "src/ts/alert";
    import { memoryTaskStatus } from "src/ts/process/memoryTasks.svelte";
    import {
        memoryReceiptView,
        newestAssistantMessageId,
        requestMemoryPanelTarget,
        revertStructuredMemoryChange,
        type MemoryReceiptChange,
    } from "src/ts/process/structuredMemory.svelte";
    import type { AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
    import { findChat, type ChatRef } from "src/ts/storage/chatStore.svelte";
    import { hypaV3ModalOpen } from "src/ts/stores.svelte";
    import MemoryLinkButton from "../Others/StructuredMemory/MemoryLinkButton.svelte";
    import { pressMemoryRecord } from "../Others/StructuredMemory/memoryRecordPress";
    import { codeText, memoryReadFailureText } from "../Others/StructuredMemory/memoryText";

    /**
     * One assistant message's writer receipt, read from the held chat in
     * src/ts/storage/chatStore.svelte.ts: src/lib/ChatScreens/Chat.svelte's `messageGenerationInfo` keeps
     * what the text row mounted with, so only the held chat follows a receipt-only feed patch. Live task
     * status concerns the chat, not proof this row is being recorded. Stored data is read through
     * src/ts/process/structuredMemory.svelte.ts's `memoryReceiptView`; all model text stays plain.
     *
     * Changes open page history through `requestMemoryPanelTarget` before the panel mounts. Highlighted
     * changes also revert through `revertStructuredMemoryChange`, which obtains a current revision first.
     * A revert never rewrites the stored receipt: reverted markers belong to this mount alone, and a later
     * press can report that nothing remains to undo. Record and resume share `pressMemoryRecord` with
     * src/lib/Others/StructuredMemory/StructuredMemoryPanel.svelte.
     */

    interface Props {
        chatRef: ChatRef;
        messageId: string;
        /** The message's place in the chat, which the row list keeps current. */
        idx: number;
        /** A generation job owns the message. */
        locked: boolean;
        /** The chat's owner, a character or a group. */
        owner: AnyClientCharacter;
    }

    let { chatRef, messageId, idx, locked, owner }: Props = $props();

    let expanded = $state(false);
    let pressing = $state(false);
    let reverting = $state(false);
    /** The history entries reverted from this line: the receipt is a stored copy, which no revert changes. */
    let revertedHere = $state.raw<ReadonlySet<string>>(new Set());

    const chat = $derived(findChat(chatRef));
    const stored = $derived.by(() => {
        const message = chat?.message[idx];
        return message?.chatId === messageId ? message.generationInfo?.memory : undefined;
    });
    const newest = $derived(newestAssistantMessageId(chat?.message ?? []) === messageId);
    const status = $derived(memoryTaskStatus(chatRef));
    const taskLive = $derived(status?.state === "queued" || status?.state === "running");
    const view = $derived(memoryReceiptView(stored, { newest, taskLive }));
    /** The buttons are off: a press is in flight, the writer is working, or a job owns the message. */
    const busy = $derived(pressing || reverting || taskLive || locked);

    /** A stored code's text from `reasons`; the code itself for one this tab does not know. */
    function reasonText(reasons: Record<string, string>, code: string | undefined): string {
        return code !== undefined && Object.hasOwn(reasons, code) ? reasons[code] : (code ?? "");
    }

    const summary = $derived.by(() => {
        const { receipt, failureReasons, notAutomaticReasons } = language.structuredMemory;
        switch (view.kind) {
            case "recorded":
                return receipt.recorded(view.counts);
            case "failed":
                return receipt.notRecorded(reasonText(failureReasons, view.reason));
            case "notAutomatic":
                return receipt.notAutomatic(reasonText(notAutomaticReasons, view.reason));
            case "paused":
                return receipt.paused;
            case "skipped":
                return receipt.notRecorded(reasonText(language.memoryTasks.reasons, view.reason));
            case "working":
                return receipt.working;
            default:
                return receipt.none;
        }
    });
    const hasTokens = $derived(view.inputTokens !== undefined || view.outputTokens !== undefined);
    const hasDetails = $derived(
        view.changes.length > 0 ||
            view.warnings.length > 0 ||
            view.unverified.length > 0 ||
            view.refused.length > 0 ||
            view.error !== undefined ||
            view.model !== undefined ||
            hasTokens,
    );

    /** Starts the writer through this message, or, resuming, on everything open. */
    async function press() {
        if (busy) {
            return;
        }
        pressing = true;
        try {
            await pressMemoryRecord(owner, chatRef, view.action === "resume" ? undefined : messageId);
        } finally {
            pressing = false;
        }
    }

    /** A change's link: its page and section, as far as the receipt holds them. */
    function changeLabel({ title, heading }: MemoryReceiptChange): string {
        const section = heading === undefined ? "" : codeText(language.structuredMemory.pages.headings, heading);
        return [title, section].filter((part) => part !== "").join(": ") || language.structuredMemory.receipt.newPage;
    }

    /** Opens the panel at `change`. It is closed while this line shows: open, it covers the whole screen. */
    function openChange({ pageId, historyId }: MemoryReceiptChange) {
        requestMemoryPanelTarget(chatRef, {
            tab: "pages",
            id: pageId,
            ...(historyId !== undefined ? { historyId } : {}),
        });
        hypaV3ModalOpen.set(true);
    }

    /** Undoes `change`. An `epoch` refusal already raised its own notice. */
    async function revert({ pageId, historyId }: MemoryReceiptChange) {
        if (busy || historyId === undefined) {
            return;
        }
        reverting = true;
        try {
            const result = await revertStructuredMemoryChange(chatRef, pageId, historyId);
            if (result.outcome === "ok") {
                const { done, nothing } = language.structuredMemory.revert;
                const { reverted, laterEvents } = result.value;
                revertedHere = new Set([...revertedHere, historyId]);
                alertToast(reverted ? done(laterEvents) : nothing);
            } else if (result.outcome === "failed" || result.reason !== "epoch") {
                alertError(memoryReadFailureText(result));
            }
        } finally {
            reverting = false;
        }
    }
</script>

{#if view.kind !== "hidden"}
    {@const text = language.structuredMemory.receipt}
    <div class="mr-2 my-1 flex max-w-full flex-col items-end text-sm text-textcolor2" data-memory-receipt={view.kind}>
        <div class="flex max-w-full items-center gap-2">
            {#if hasDetails}
                <button
                    class="flex min-w-0 items-center rounded-md p-1 transition-all hover:text-textcolor hover:ring-3 hover:ring-darkbutton"
                    aria-expanded={expanded}
                    onclick={() => {
                        expanded = !expanded;
                    }}
                >
                    {#if expanded}
                        <ChevronDownIcon size={16} class="shrink-0" />
                    {:else}
                        <ChevronRightIcon size={16} class="shrink-0" />
                    {/if}
                    <span class="ml-1 min-w-0 break-words text-left">{summary}</span>
                </button>
            {:else}
                <span class="min-w-0 break-words p-1">{summary}</span>
            {/if}
            {#if view.customPrompt}
                <span class="shrink-0 rounded-sm bg-darkbutton px-1.5 text-xs" data-memory-receipt-custom-prompt>
                    {text.customPrompt}
                </span>
            {/if}
            {#if view.action}
                <button
                    class={"shrink-0 rounded-md border border-darkborderc px-2 py-0.5 transition-all " +
                        (busy ? "opacity-50 cursor-not-allowed" : "hover:text-textcolor")}
                    disabled={busy}
                    onclick={press}
                >
                    {view.action === "resume" ? text.resume : text.recordNow}
                </button>
            {/if}
        </div>
        {#if expanded && hasDetails}
            <div class="mt-1 flex w-full flex-col gap-1 rounded-md border border-darkborderc p-2 text-xs break-words">
                {#if view.error !== undefined}
                    <span class="text-draculared" data-memory-receipt-error>{view.error}</span>
                {/if}
                {#if view.changes.length > 0}
                    {@const revertText = language.structuredMemory.revert}
                    <span class="font-semibold">{text.changes}</span>
                    {#each view.changes as change}
                        <span class="flex flex-wrap items-center gap-1" data-memory-receipt-change={change.pageId}>
                            <MemoryLinkButton label={changeLabel(change)} onclick={() => openChange(change)} />
                            {#if change.heading === undefined && change.title !== ""}
                                <span>{text.newPage}</span>
                            {/if}
                            {#if change.kind !== undefined}
                                <span data-memory-receipt-kind={change.kind}>
                                    {codeText(language.structuredMemory.pages.historyKinds, change.kind)}
                                </span>
                                {#if change.historyId !== undefined && revertedHere.has(change.historyId)}
                                    <span data-memory-receipt-reverted>{revertText.reverted}</span>
                                {:else}
                                    <button
                                        class={"shrink-0 rounded-md border border-darkborderc px-2 py-0.5 transition-all " +
                                            (busy ? "opacity-50 cursor-not-allowed" : "hover:text-textcolor")}
                                        disabled={busy}
                                        onclick={() => revert(change)}
                                        data-memory-receipt-revert
                                    >
                                        {revertText.button}
                                    </button>
                                {/if}
                            {/if}
                        </span>
                    {/each}
                {/if}
                {#if view.warnings.length > 0}
                    <span class="font-semibold">{text.warnings}</span>
                    {#each view.warnings as warning}
                        <span>
                            {reasonText(language.structuredMemory.warningKinds, warning.kind)}{warning.detail
                                ? `: ${warning.detail}`
                                : ""}
                        </span>
                    {/each}
                {/if}
                {#if view.unverified.length > 0}
                    <span class="font-semibold">{text.unverified}</span>
                    {#each view.unverified as item}
                        <span>
                            {item.text}{item.reason
                                ? ` (${reasonText(language.structuredMemory.unverifiedReasons, item.reason)})`
                                : ""}
                        </span>
                    {/each}
                {/if}
                {#if view.refused.length > 0}
                    <span class="font-semibold">{text.refused}</span>
                    {#each view.refused as item}
                        <span>
                            {item.candidate}{item.refusal
                                ? `: ${reasonText(language.structuredMemory.refusalKinds, item.refusal)}`
                                : ""}
                        </span>
                    {/each}
                {/if}
                {#if view.model !== undefined}
                    <span>{text.model}: {view.model}</span>
                {/if}
                {#if hasTokens}
                    <span>{text.tokens(view.inputTokens ?? 0, view.outputTokens ?? 0)}</span>
                {/if}
            </div>
        {/if}
    </div>
{/if}
