<script lang="ts">
    import { onMount } from "svelte";
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { copyText } from "src/lib/Others/RequestLogs/requestLogView";
    import { createDiagnosticReport, saveDiagnosticReport, type SaveReportResult } from "src/ts/diagnostics/report";
    import { downloadFile } from "src/ts/globalApi.svelte";

    // Settings → Advanced → Diagnostics: the report as text, built on open and by Refresh. Copy,
    // Download, and Save act on the report shown.

    let report: string | null = $state(null);
    let building = $state(false);
    let saving = $state(false);
    let copied = $state(false);
    let notice: { text: string; error: boolean } | null = $state(null);
    let copiedTimer: ReturnType<typeof setTimeout> | undefined;

    const serverUnavailable = $derived(report !== null && report.includes("\nServer: unavailable\n"));

    async function refresh() {
        if (building || saving) {
            return;
        }
        building = true;
        notice = null;
        try {
            report = await createDiagnosticReport();
        } finally {
            building = false;
        }
    }

    async function copy() {
        if (report === null) {
            return;
        }
        if (!(await copyText(report))) {
            notice = { text: language.diagnosticsCopyFailed, error: true };
            return;
        }
        copied = true;
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => (copied = false), 1500);
    }

    async function download() {
        if (report === null) {
            return;
        }
        const stamp = new Date().toISOString().replace(/[-:.]/g, "");
        await downloadFile(`metatron-diagnostics-${stamp}.txt`, report);
    }

    function saveNotice(result: SaveReportResult): { text: string; error: boolean } {
        // `in`, not `ok`: the client's tsconfig is not strict, so a boolean tag does not narrow.
        if (!("failure" in result)) {
            return result.name === null
                ? { text: language.diagnosticsSavedNoName, error: false }
                : { text: language.diagnosticsSaved.replace("{{name}}", result.name), error: false };
        }
        switch (result.failure) {
            case "refused":
                return { text: language.diagnosticsSaveRefused, error: true };
            case "tooLarge":
                return { text: language.diagnosticsSaveTooLarge, error: true };
            case "unavailable":
                return { text: language.diagnosticsSaveUnavailable, error: true };
            case "network":
                return { text: language.diagnosticsSaveNetwork, error: true };
            case "timeout":
                return { text: language.diagnosticsSaveUnconfirmed, error: true };
            default:
                return {
                    text: language.diagnosticsSaveFailed.replace("{{status}}", String(result.status ?? "?")),
                    error: true,
                };
        }
    }

    async function save() {
        if (report === null || saving || building) {
            return;
        }
        const text = report;
        saving = true;
        notice = null;
        try {
            notice = saveNotice(await saveDiagnosticReport(text));
        } finally {
            saving = false;
        }
    }

    onMount(() => {
        void refresh();
        return () => clearTimeout(copiedTimer);
    });
</script>

<div class="mt-2 flex flex-col gap-2">
    <span class="text-textcolor2 text-sm">{language.diagnosticsDesc}</span>
    <div class="flex flex-wrap gap-2">
        <Button size="sm" disabled={building || saving} onclick={refresh}>{language.diagnosticsRefresh}</Button>
        <Button size="sm" disabled={report === null} onclick={copy}>
            {copied ? language.diagnosticsCopied : language.diagnosticsCopy}
        </Button>
        <Button size="sm" disabled={report === null} onclick={download}>{language.diagnosticsDownload}</Button>
        <Button size="sm" disabled={report === null || building || saving} onclick={save}>
            {saving ? language.diagnosticsSaving : language.diagnosticsSave}
        </Button>
    </div>
    {#if building}
        <span class="text-textcolor2 text-sm">{language.diagnosticsBuilding}</span>
    {:else if serverUnavailable}
        <span class="text-textcolor2 text-sm">{language.diagnosticsServerUnavailable}</span>
    {/if}
    {#if notice}
        <span class="text-sm {notice.error ? 'text-draculared' : 'text-textcolor'}">{notice.text}</span>
    {/if}
    {#if report !== null}
        <pre
            class="bg-darkbg border border-darkborderc rounded-md p-2 text-xs text-textcolor whitespace-pre-wrap break-all max-h-96 overflow-auto">{report}</pre>
    {/if}
</div>
