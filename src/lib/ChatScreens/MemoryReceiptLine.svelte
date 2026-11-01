<script lang="ts">
    import { ChevronDownIcon, ChevronRightIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { alertToast } from "src/ts/alert";
    import { memoryTaskStatus } from "src/ts/process/memoryTasks.svelte";
    import { runServerJob } from "src/ts/process/serverCommands";
    import { memoryReceiptView, newestAssistantMessageId } from "src/ts/process/structuredMemory.svelte";
    import type { AnyClientCharacter } from "src/ts/storage/characterStore.svelte";
    import { findChat, type ChatRef } from "src/ts/storage/chatStore.svelte";

    // One assistant message's line about Structured Memory's writer: what it recorded, why it did not,
    // or why it will not on its own, collapsed to one row, with the button that starts it. The row list
    // mounts `Chat` once per text, so `messageGenerationInfo` keeps the receipt the row was mounted
    // with; a receipt arrives without a text change, so the line reads the held chat, which is deep
    // state, and the feed's patch moves it.

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

    const chat = $derived(findChat(chatRef));
    const stored = $derived.by(() => {
        const message = chat?.message[idx];
        return message?.chatId === messageId ? message.generationInfo?.memory : undefined;
    });
    const newest = $derived(newestAssistantMessageId(chat?.message ?? []) === messageId);
    const status = $derived(memoryTaskStatus(chatRef));
    const taskLive = $derived(status?.state === "queued" || status?.state === "running");
    const view = $derived(memoryReceiptView(stored, { newest, taskLive }));
    /** The button is off: a press is in flight, the writer is working, or a job owns the message. */
    const busy = $derived(pressing || taskLive || locked);

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
        view.warnings.length > 0 ||
            view.unverified.length > 0 ||
            view.refused.length > 0 ||
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
            const { outcome, terminal } = await runServerJob(owner, chatRef, {
                kind: "command",
                command: { type: "memoryRecord", ...(view.action === "resume" ? {} : { messageId }) },
                label: "memoryRecord",
                context: { mode: "manual" },
            });
            if (outcome === "followed") {
                alertToast(language.structuredMemory.receipt.busy);
            } else if (terminal !== null && terminal !== "lost" && terminal.type === "done") {
                alertToast(language.structuredMemory.receipt.requested);
            }
        } finally {
            pressing = false;
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
