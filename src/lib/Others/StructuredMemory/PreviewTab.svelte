<script lang="ts">
    import { language } from "src/lang";
    import { previewChatReport, type OpenAIChat } from "src/ts/process/index.svelte";
    import {
        memoryBlockEntries,
        memoryItemTitles,
        readStructuredMemoryContents,
    } from "src/ts/process/structuredMemory.svelte";
    import type { ChatRef } from "src/ts/storage/chatStore.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import type { ContextReport } from "../../../../shared/contextReport.ts";
    import MemoryManifest from "./MemoryManifest.svelte";

    /**
     * Only the button starts a preview through src/ts/process/index.svelte.ts's `previewChatReport`.
     * It marks no memory record; its local send makes the panel read-only and moves `refresh`, so neither
     * running nor clearing on refresh is safe. The answer has no next message and can differ from a send.
     *
     * `memoryBlockEntries` in src/ts/process/structuredMemory.svelte.ts finds item tags after prompt edits;
     * entry memos cannot identify the block reliably, and a tagless rule header is not a block. A failed
     * titles read leaves the manifest visible without titles. Model and message text stays plain.
     */

    interface Props {
        chatRef: ChatRef;
        readOnly: boolean;
        refresh: number;
    }

    let { chatRef, readOnly }: Props = $props();

    const text = language.structuredMemory.preview;

    type Shown = {
        /** The final messages that hold an item's tag. */
        block: OpenAIChat[];
        /** What the report says of a Structured Memory step; none when the step did not run. */
        memory: NonNullable<ContextReport["memory"]> | null;
    };

    let shown = $state.raw<Shown | null>(null);
    let titles = $state.raw<ReadonlyMap<string, string>>(new Map());
    let failed = $state(false);
    let running = $state(false);
    let runNumber = 0;

    /** Runs a preview. An answer for another chat changes nothing, and neither does a failed read of the titles. */
    async function run() {
        const ref = chatRef;
        const number = ++runNumber;
        const current = () => number === runNumber && ref.chaId === chatRef.chaId && ref.chatId === chatRef.chatId;
        running = true;
        failed = false;
        shown = null;
        titles = new Map();
        let answer: Awaited<ReturnType<typeof previewChatReport>> = null;
        try {
            answer = await previewChatReport(ref);
        } catch (error) {
            console.error("[Memory]", error);
        }
        running = false;
        if (!current()) {
            return;
        }
        if (!answer?.report) {
            failed = true;
            return;
        }
        const memory = answer.report.memory?.kind === "structuredMemory" ? answer.report.memory : null;
        shown = { block: memoryBlockEntries(answer.messages, memory?.items ?? []), memory };
        if (memory) {
            const contents = await readStructuredMemoryContents(ref);
            if (current() && contents.outcome === "ok") {
                titles = memoryItemTitles(contents.value);
            }
        }
    }
</script>

<div class="flex flex-col min-w-0 gap-2 text-sm" data-memory-preview data-read-only={readOnly}>
    <p class="text-textcolor2" data-memory-preview-note>{text.note}</p>
    <div class="self-start">
        <Button size="sm" styled="outlined" disabled={readOnly || running} onclick={run}>
            <span data-memory-preview-run>{running ? text.running : text.run}</span>
        </Button>
    </div>
    {#if failed}
        <p role="alert" class="text-draculared" data-memory-panel-failure>{text.failed}</p>
    {:else if shown}
        {#if shown.block.length === 0}
            <p data-memory-preview-no-block>{text.noBlock}</p>
        {:else}
            <div class="flex flex-col min-w-0 gap-2" data-memory-preview-block>
                {#each shown.block as entry, index (index)}
                    <p
                        class="p-2 border rounded-md whitespace-pre-wrap break-words border-darkborderc"
                        data-memory-preview-entry
                    >
                        {entry.content}
                    </p>
                {/each}
            </div>
        {/if}
        {#if shown.memory}
            <MemoryManifest memory={shown.memory} {titles} />
        {/if}
    {/if}
</div>
