<script lang="ts">
    import { CheckIcon, CopyIcon, XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import type { RequestHistoryFieldCut } from "../../../../shared/requestHistory.ts";
    import { copyText, formatBytes, highlightJson } from "./requestLogView";

    /**
     * A labeled request-log field with a copy action for the supplied text and, when cut, its stored
     * and original byte counts. JSON highlighting uses `src/lib/Others/RequestLogs/requestLogView.ts`'s
     * escaped-text fallback for large or unhighlightable fields; plain fields use Svelte text escaping.
     */

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

    let copyState = $state<"copied" | "failed" | null>(null);
    let copyTimer: ReturnType<typeof setTimeout> | undefined;
    let copyAttempt = 0;

    async function copy(event: MouseEvent) {
        event.stopPropagation();
        const attempt = ++copyAttempt;
        clearTimeout(copyTimer);
        copyState = null;
        const copied = await copyText(text);
        if (attempt !== copyAttempt) {
            return;
        }
        copyState = copied ? "copied" : "failed";
        copyTimer = setTimeout(() => (copyState = null), 1500);
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
        <div class="flex items-center gap-2">
            <button
                class="p-1 rounded hover:bg-bgcolor transition-colors {copyState === 'copied'
                    ? 'text-success-500'
                    : copyState === 'failed'
                      ? 'text-danger-500'
                      : 'text-textcolor2 hover:text-textcolor'}"
                onclick={copy}
                title={copyState === "failed" ? language.requestLogCopyFailed : language.copy}
            >
                {#if copyState === "copied"}
                    <CheckIcon size={14} />
                {:else if copyState === "failed"}
                    <XIcon size={14} />
                {:else}
                    <CopyIcon size={14} />
                {/if}
            </button>
            {#if copyState === "failed"}
                <span class="text-danger-500 text-xs" role="status">{language.requestLogCopyFailed}</span>
            {/if}
        </div>
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
