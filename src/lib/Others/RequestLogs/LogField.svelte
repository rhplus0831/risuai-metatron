<script lang="ts">
    import { CheckIcon, CopyIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import type { RequestHistoryFieldCut } from "../../../../shared/requestHistory.ts";
    import { copyText, formatBytes, highlightJson } from "./requestLogView";

    interface Props {
        label: string;
        text: string;
        /** JSON highlighting (off for a URL or plain text). */
        highlight?: boolean;
        /** The `pre`'s height class. */
        sizeClass?: string;
        /** The field's cut, when the history stored only its start. */
        cut?: RequestHistoryFieldCut | null;
    }

    let { label, text, highlight = true, sizeClass = "", cut = null }: Props = $props();

    let copied = $state(false);
    let copiedTimer: ReturnType<typeof setTimeout> | undefined;

    async function copy(event: MouseEvent) {
        event.stopPropagation();
        await copyText(text);
        copied = true;
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => (copied = false), 1500);
    }
</script>

<div>
    <div class="flex items-center justify-between mb-2 gap-2">
        <span class="text-textcolor text-sm font-semibold">
            {label}
            {#if cut}
                <span class="ml-2 px-1.5 py-0.5 rounded text-xs font-normal bg-secondary-700 text-neutral-50">
                    {language.requestHistoryTruncated
                        .replace("{{stored}}", formatBytes(cut.storedBytes))
                        .replace("{{original}}", formatBytes(cut.originalBytes))}
                </span>
            {/if}
        </span>
        <button
            class="p-1 rounded hover:bg-bgcolor transition-colors {copied
                ? 'text-success-500'
                : 'text-textcolor2 hover:text-textcolor'}"
            onclick={copy}
            title={language.copy}
        >
            {#if copied}
                <CheckIcon size={14} />
            {:else}
                <CopyIcon size={14} />
            {/if}
        </button>
    </div>
    {#if highlight}
        <pre class="request-log-code hljs {sizeClass}">{@html highlightJson(text)}</pre>
    {:else}
        <pre class="request-log-code hljs text-sm {sizeClass}">{text}</pre>
    {/if}
</div>

<style>
    .request-log-code {
        background-color: var(--risu-theme-darkbg);
        color: var(--risu-theme-textcolor);
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 0.375rem;
        padding: 0.75rem;
        font-family: "Consolas", "Monaco", "Courier New", monospace;
        font-size: 0.75rem;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-all;
        max-height: 12rem;
        overflow: auto;
    }
</style>
