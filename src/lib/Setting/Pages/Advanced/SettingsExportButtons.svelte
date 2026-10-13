<script lang="ts">
    import { settings } from "src/ts/storage/settingsViews.svelte";
    import { buildSettingsReport } from "src/ts/storage/snapshots.svelte";
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { alertMd, alertNormal, alertRequestLogs } from "src/ts/alert";
    import { downloadFile } from "src/ts/globalApi.svelte";
</script>

<Button
    className="mt-4"
    onclick={() => {
        alertRequestLogs();
    }}
>
    {language.ShowLog}
</Button>

<Button
    className="mt-4"
    onclick={async () => {
        let mdTable = "| Type | Value |\n| --- | --- |\n";
        const s = settings.statics;
        for (const key in s) {
            mdTable += `| ${key} | ${s[key]} |\n`;
        }
        mdTable += `\n\n<small>${language.staticsDisclaimer}</small>`;
        alertMd(mdTable);
    }}
>
    Show Statistics
</Button>

<Button
    className="mt-4"
    onclick={async () => {
        const json = JSON.stringify(buildSettingsReport(), null, 2);
        await downloadFile("risuai-settings-report.json", new TextEncoder().encode(json));
        await navigator.clipboard.writeText(json);
        alertNormal(language.settingsExported);
    }}
>
    Export Settings for Bug Report
</Button>
