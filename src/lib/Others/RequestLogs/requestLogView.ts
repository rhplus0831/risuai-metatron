import hljs from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";

if (!hljs.getLanguage("json")) {
    hljs.registerLanguage("json", json);
}

/** Text longer than this is shown plain: highlighting a multi-megabyte body stalls the tab. */
const HIGHLIGHT_LIMIT = 256 * 1024;

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** HTML for a request log field: JSON-highlighted when it is short enough, else escaped text. */
export function highlightJson(code: string): string {
    if (code.length > HIGHLIGHT_LIMIT) {
        return escapeHtml(code);
    }
    try {
        return hljs.highlight(code, { language: "json" }).value;
    } catch {
        return escapeHtml(code);
    }
}

/** Copies text, with the `execCommand` fallback for a context without the clipboard API. */
export async function copyText(text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
    } catch {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
    }
}

/** A byte count as `1.2 KiB`. */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
